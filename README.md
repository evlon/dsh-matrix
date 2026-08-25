# dsh-matrix

DeepSeek Harness（dsh）的 Matrix 通信插件：把 Matrix 房间桥接到 harness agent 会话，每个房间一个会话，支持在聊天里远程监控、审批和追加指令。

```
src/
├── index.ts      # 插件入口（name/inject/apply/Config），无 default export
├── bridge.ts     # 桥接层：多账号编排（AccountBridge）、入站路由（@提及/私聊）、审批、授权
├── matrix.ts     # 通道层：零依赖 Matrix client-server API 客户端（fetch + /sync 长轮询）
├── config.ts     # Schemastery 配置 schema（含数字分身 digitalTwins）
├── store.ts      # 文件落盘状态：房间↔会话映射、事件去重环、sync token
├── auth-store.ts # 记忆授权库：分身↔Owner、工具授权、红线判定
└── format.ts     # 保守 markdown 子集 → Matrix HTML，收敛前缀长回复分段
```

## 架构

### 整体拓扑：每个分身一个 harness 进程

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                        Matrix 房间（每个平台/模块一个房间）                        │
│                                                                              │
│   真人同事 @tianjintao   真人（Owner）@niukunliang     其他分身 @ai-liuliye      │
│     （Matrix 客户端）      （Matrix 客户端，仅客户端登录）   （跑在自己的 harness）    │
└──────────┬──────────────────────┬─────────────────────────┬──────────────────┘
           │                      │                         │
           │       房间内对话 / @提及 / 审批「批准/拒绝」        │
           ▼                      ▼                         ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                         Matrix Homeserver（im-ipm.ict.cmcc）                    │
└──────┬───────────────────────┬──────────────────────────┬───────────────────┘
       │                       │                          │
       ▼                       ▼                          ▼
┌──────────────┐      ┌──────────────┐           ┌──────────────┐
│ Harness 进程 A │      │ Harness 进程 B │           │ Harness 进程 C │
│              │      │              │           │              │
│ userId:      │      │ userId:      │           │  （每个分身    │
│ @ai-niukun-  │      │ @ai-niukun-  │           │   一个独立     │
│ liang        │      │ liang-dev    │           │   进程）       │
│ owner:       │      │ owner:       │           │              │
│ @niukunliang │      │ @niukunliang │           │              │
└──────┬───────┘      └──────┬───────┘           └──────────────┘
       │                     │
       ▼                     ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                          dsh-matrix 插件（每个进程各跑一份）                      │
│                                                                              │
│  ┌────────────────┐  ┌────────────────┐  ┌────────────────────────────────┐  │
│  │ 通道层 matrix.ts │  │ 桥接层 bridge.ts │  │ 授权库 auth-store.ts            │  │
│  │ · /sync 长轮询   │  │ · 消息路由        │  │ · 记忆授权（L1 静默放行）         │  │
│  │ · send/typing  │  │   @提及/私聊/兜底 │  │ · Owner 房间确认（L2）            │  │
│  │ · 邀请自动加入    │  │ · 合并窗口 .. !!  │  │ · 红线强制确认（L3，每次）        │  │
│  │                │  │ · per-room agent │  │ · auth-store.json 落盘          │  │
│  └────────────────┘  └────────────────┘  └────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 身份模型

| 角色 | Matrix 账号 | 登录位置 | 职责 |
|---|---|---|---|
| **真人（Owner）** | `@niukunliang:im-ipm.ict.cmcc` | **仅 Matrix 客户端** | 在房间与分身对话、应答「批准/拒绝」审批、吊销授权 |
| **数字分身** | `@ai-niukunliang:im-ipm.ict.cmcc` | **自己的 harness 进程** | 与真人同事、其他分身协作，执行研发/测试等工作 |
| **真人同事** | `@tianjintao:im-ipm.ict.cmcc` 等 | Matrix 客户端 | 在房间与分身协作（能否驱动分身由白名单控制） |

> 每个分身 = 一个独立 Matrix 账号 + 一个独立 harness 进程。分身账号的 `owner` 指向其工作责任负责人（真人），审批/吊销授权仅 Owner 可应答。

### 三级授权

```
分身请求执行工具
      │
      ▼
┌──────────────┐  命中红线（bash/write/edit…）  ┌──────────────────┐
│ 红线检查?      │ ───────────────────────────▶│ L3 强制房间确认     │
└──────┬───────┘                              │ （每次都要，不入库） │
       │ 未命中                              └──────────────────┘
       ▼
┌──────────────┐  有记忆授权                    ┌──────────────────┐
│ 记忆授权库?    │ ───────────────────────────▶│ L1 静默放行        │
└──────┬───────┘                              └──────────────────┘
       │ 无记录
       ▼
┌─────────────────────────────────────────────────────────────┐
│ L2 房间确认：推送审批 → 仅 Owner 回复「批准」有效                  │
│   → 批准后写入记忆授权（auth-store.json），下次同类工具 L1 放行     │
└─────────────────────────────────────────────────────────────┘
```

## 能力

- **Matrix → DSH**：白名单用户文本经合并窗口（`..` 继续 / `!!` 立即提交 / 裸文本进合并窗口）后，通过 `agent.followup` 注入对应房间的 agent 会话；`/bind <session-id>` 可切换到已有会话
- **DSH → Matrix**：监听 `session/event`，把 `assistant/message` 的可见文本分段（前缀 `（i/n）` 参与长度收敛）后以 `org.matrix.custom.html` 发回；`turn/start` 显示 typing
- **数字分身架构**：**每个分身一个 harness 进程**——`userId` 即分身账号（bot 自己登录），`owner` 是真实人账号（仅在 Matrix 客户端登录）。分身与真人同事、其他分身在同一房间协作；@提及路由、私聊判定、多账号协调（可选 `digitalTwins` 同进程跑多分身）均已支持
- **三级授权**：
  - **L1 记忆授权**：非红线工具此前被批准过 → 静默放行（`auth-store.json` 持久化）
  - **L2 即时确认**：房间推送审批，配置了 `owner` 的账号**仅 Owner** 可应答，批准后写入记忆授权库
  - **L3 红线强制**：命中 `redlineTools`（默认 `bash`/`pwsh`/`write`/`edit`）→ **每次都必须确认**，批准永不入库
- **命令**：`/help` `/status` `/new` `/clear` `/bind <session-id>` `/auth list` `/auth revoke <tool>` `/auth revoke-all`
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
| `accessToken` | `''` | 分身 access token；为空回退环境变量 `DSH_MATRIX_TOKEN`，两者都缺则插件加载失败 |
| `userId` | 必填 | 本进程登录的数字分身账号，如 `@ai-niukunliang:example.org` |
| `owner` | `''` | 工作责任负责人（真人账号，仅客户端登录）；设置后审批/吊销仅其可应答 |
| `respondToAll` | `true` | 响应房间所有消息；设为 `false` 则仅 @提及/私聊 响应 |
| `allowedUserIds` | `[]` | 白名单；为空且 `allowAllUsers=false` 时拒绝所有人（fail closed） |
| `allowAllUsers` | `false` | 允许任意用户（仅开发用） |
| `provider` | `deepseek-official` | 每个房间 agent 的 LLM provider |
| `model` | `deepseek-v4-flash` | 每个房间 agent 的模型 |
| `chunkMaxChars` | `4000` | 出站单条消息字符上限（含分段前缀） |
| `mergeTimeoutSecs` | `5` | 裸文本合并窗口（秒） |
| `approvalTimeoutSecs` | `300` | 审批推送后等待聊天答复的秒数 |
| `stateDir` | `.dsh-matrix` | 状态目录（`state.json` 房间映射 + 去重 + sync token） |
| `digitalTwinMode` | `false` | 可选：同一进程挂载多个分身（见下方示例） |
| `digitalTwins` | `[]` | 额外分身账号列表（通常每个分身一个进程，无需配置此项） |
| `authStoreFile` | `auth-store.json` | 记忆授权库文件名（相对 `stateDir`） |
| `redlineTools` | `['bash','pwsh','write','edit']` | 红线工具：即使有记忆授权也每次强制房间确认 |

### 配置示例

**推荐：每个分身一个 harness 进程（单账号模式）**

```yaml
# 分身 @ai-niukunliang 的 profile 配置
userId: '@ai-niukunliang:example.org'        # 本进程登录的分身
accessToken: '...'                            # 分身的 token（或 tokenEnv 环境变量）
owner: '@niukunliang:example.org'             # 真人账号（仅客户端登录）：审批仅其可应答
respondToAll: true                            # 参与房间协作，响应所有消息
allowAllUsers: false                          # 生产建议用白名单 fail closed
allowedUserIds: ['@niukunliang:example.org', '@tianjintao:example.org']
```

**可选：同一进程挂载多个分身（`digitalTwinMode`）**

```yaml
digitalTwinMode: true
digitalTwins:
  - userId: '@ai-niukunliang-pm:example.org'        # 分身账号（需预先注册并取得 access token）
    tokenEnv: 'DSH_MATRIX_AI_NIUKUNLIANG_PM_TOKEN'  # 从环境变量读 token（推荐）；或直接 accessToken
    owner: '@niukunliang:example.org'               # 工作责任负责人：仅其可在房间应答审批
    role: 'pm'                                      # 角色标签（展示用）
    respondToAll: false                             # 默认仅 @提及/私聊 响应；true 则响应所有消息
    provider: ''                                    # 留空回退顶层 provider/model
    model: ''
```

每个分身独立 sync 循环、独立状态文件（`<stateDir>/twins/<localpart>.json`）、独立 per-room agent 会话；审批按「分身×房间」维度记录记忆授权，Owner 变更不影响其他分身。

## 使用

1. 真实人在 Matrix 客户端登录自己的账号（如 `@niukunliang`），把它加进目标房间
2. 每个分身账号各启动一个 harness：`dsh --profile <分身profile>`，插件自动加入房间（邀请自动接受）
3. 房间里 @提及 分身即可让它干活；分身要执行红线工具时会推送审批，**Owner 在客户端回复「批准/拒绝」**（超时按 unavailable 处理）
4. 常用命令：`/status`（看会话）、`/auth list`（看记忆授权）、`/auth revoke <tool>`（吊销，仅 Owner）
5. `dsh plugin --profile web remove dsh-matrix` 卸载；组合层变更需重启 dsh 进程（不参与 HMR）

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
