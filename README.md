# dsh-matrix

DeepSeek Harness（dsh）的 Matrix 通信插件：把 Matrix 房间桥接到 harness agent 会话，每个房间一个会话，支持在聊天里远程监控、审批和追加指令。

```
src/
├── index.ts     # 插件入口（name/inject/apply/Config），无 default export
├── bridge.ts    # 桥接层：入站注入 / 出站投递 / 审批应答 / 命令 / 合并窗口，与具体 IM 无关
├── matrix.ts    # 通道层：零依赖 Matrix client-server API 客户端（fetch + /sync 长轮询）
├── config.ts    # Schemastery 配置 schema
├── store.ts     # 文件落盘状态：房间↔会话映射、事件去重环、sync token
└── format.ts    # 保守 markdown 子集 → Matrix HTML，收敛前缀长回复分段
```

## 能力

- **Matrix → DSH**：白名单用户文本经合并窗口（`..` 继续 / `!!` 立即提交 / 裸文本进合并窗口）后，通过 `agent.followup` 注入对应房间的 agent 会话；`/bind <session-id>` 可切换到已有会话
- **DSH → Matrix**：监听 `session/event`，把 `assistant/message` 的可见文本分段（前缀 `（i/n）` 参与长度收敛）后以 `org.matrix.custom.html` 发回；`turn/start` 显示 typing
- **审批**：注册 `approval/request` answerer，把审批请求（工具名 + 原因）推送到房间，等白名单用户回复「批准 / 拒绝」（超时按 unavailable 处理）
- **命令**：`/help` `/status` `/new` `/clear` `/bind <session-id>`
- **可靠性**：事件 id 持久去重环、sync token 落盘重启续传、长回复 HTML 失败回退纯文本、sync 循环指数退避

## 为什么通道层不用现成 SDK

matrix-js-sdk 的 Node ESM 导入在 v42 是坏的（`oauth` 模块的目录导入，官方建议用户自己上 bundler）；matrix-bot-sdk 的 E2EE 原生二进制依赖被 pnpm 默认拦截的 postinstall 下载。而 dsh 插件运行在 dsh 自己的 Node 进程里，两者都不合适。因此通道层参照 telegram 插件自写客户端的做法，用 `fetch` 直连 client-server API（sync / send / typing / join 四个端点），**零运行时协议依赖**，`dsh plugin add` 安装无需任何构建授权。

## 安装

```bash
# 从本仓库 checkout 安装到 profile（dsh.bundle 声明自动加入组合层）
dsh plugin --profile web add .
# 或 git 安装（需要 pnpm 允许该包的 prepare 构建脚本，见 dsh 官方 publish 教程）
dsh plugin --profile web add github:you/dsh-matrix
# 验证
dsh --profile web --dump-config | grep matrix
```

git 安装拉的是源码：本包 `prepare` 脚本用 tsc 从 `src/` 构建出 `lib/`，pnpm ≥10 首次 `add` 会因未授权构建脚本失败，把提示的包键加进该 profile 的 `pnpm-workspace.yaml` 后重试：

```yaml
allowBuilds:
  dsh-matrix: true
```

也支持 npm 发布 / `pnpm pack` tarball，两种都不需要构建授权。

## 配置

在 profile 的 `cordis.patch.yml` 行上覆盖（整个 `config` 值替换，不深合并）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `homeserverUrl` | 必填 | homeserver 的 client-server API base URL |
| `accessToken` | `''` | bot access token；为空回退环境变量 `DSH_MATRIX_TOKEN`，两者都缺则插件加载失败 |
| `userId` | 必填 | bot 的 Matrix 用户 id，如 `@dsh-bot:example.org` |
| `allowedUserIds` | `[]` | 白名单；为空且 `allowAllUsers=false` 时拒绝所有人（fail closed） |
| `allowAllUsers` | `false` | 允许任意用户（仅开发用） |
| `provider` | `deepseek-official` | 每个房间 agent 的 LLM provider |
| `model` | `deepseek-v4-flash` | 每个房间 agent 的模型 |
| `chunkMaxChars` | `4000` | 出站单条消息字符上限（含分段前缀） |
| `mergeTimeoutSecs` | `5` | 裸文本合并窗口（秒） |
| `approvalTimeoutSecs` | `300` | 审批推送后等待聊天答复的秒数 |
| `stateDir` | `.dsh-matrix` | 状态目录（`state.json` 房间映射 + 去重 + sync token） |

## 使用

1. 用 `dsh --profile web` 启动后，把 bot 邀请进房间（自动加入），或直接给 bot 发私聊
2. 房间里的文本消息即注入该房间会话；回复 `批准` / `拒绝` 应答审批
3. `dsh plugin --profile web remove dsh-matrix` 卸载；组合层变更需重启 dsh 进程（不参与 HMR）

## 安全红线

- Matrix 通道等于绕过本机批准体系：approval 应答必须来自白名单 sender 且对应本房间真实 pending 的审批
- 聊天内容只能进会话流（`source.kind = 'plugin'`），绝不允许直接执行 shell
- access token 不进日志、不落盘；`state.json` 不包含任何聊天内容

## 开发

```bash
corepack pnpm install
corepack pnpm test        # tsc + node --test（format 单测 + 假 homeserver 端到端）
corepack pnpm build       # tsc，产物 lib/（提交入库，git 安装不跑构建时可直接加载）
```

改完代码必须重新 build 并重启 dsh 进程（ESM 缓存）。

## 已知限制与路线图

- **仅非加密房间**：`m.room.encrypted` 事件只提示不支持（E2EE 二期：Rust crypto + 设备验证）
- **仅文本消息**：图片/文件/贴纸忽略；仅处理主时间线，不处理 threads
- **不流式推送工具进度**：每条 `assistant/message` 一条（或多条分段）消息
- **仅长轮询**：无 appservice/webhook 模式，主机需可出站访问 homeserver
