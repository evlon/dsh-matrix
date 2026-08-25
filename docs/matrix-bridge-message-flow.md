# Matrix 桥接消息流与扩展设计

本文件描述 `dsh-matrix` 插件在 **Matrix（传输层）↔ Harness（编排内核）** 之间的消息流、
出站投影规范、入站归一化结构，以及非文字信息（图片/文件/音视频/位置）的后续扩展点。

---

## 1. 架构定位

`dsh-matrix` 是 DeepSeek Harness 的 **Matrix transport 适配器**。它严格走 Harness 公开契约，
**不修改 harness 源码**，职责边界为：

- 入站：把 Matrix 房间消息归一化后注入 harness 会话（`agent.followup(createUserMessage(...))`）。
- 出站：订阅 `ctx.on('session/event')`，把 harness 事件投影成 Matrix 可见文本并投递。
- 审批：拦截 `approval/request`，用 standing-auth 或房间内「批准/拒绝」回灌。

```
Matrix 客户端
   │ m.room.message (CS API /sync)
   ▼
onTimelineEvent (src/matrix.ts)  ──归一化──▶  InboundMessage { text, media[] }
   ▼
handleMessage (src/bridge.ts)  ──合并/指令/审批判定──▶  deliver
   ▼
agent.followup(createUserMessage({ content:[{type:'text',text}], source:{kind:'user'} }))
   ▼
Harness agent-loop (ReAct) ──调 LLM / 解析 tool-call / 跑工具──▶ session/event
   ▼
handleSessionEvent (src/bridge.ts)  ──assistantVisibleText 投影──▶  deliverText
   ▼
chunkText + sanitize 兜底 ──▶ channel.sendText ──▶ Matrix 房间
```

---

## 2. Harness 事件契约对照

出站投影依据 `@deepseek-ai/dsh-llm` 的 `ContentBlock` 定义（`packages/llm/llm/src/types.ts`）：

| `content` 块 type | 字段 | 出站处理 | 对应 GUI 行为 |
|---|---|---|---|
| `text` | `text: string` | 原样保留 | 可见正文 |
| `tool-call` | `id`, `name: string`, `arguments: string(JSON)` | **主动投影**为「🔧 调用工具 `name` + 参数摘要」 | `tool-call` 折叠块（`hasVisibleContent` 返回 false，不在正文展开） |
| `reasoning` | `text` | 不投递（默认不可见） | 折叠/隐藏 |
| `tool-result` | `id`, `content` | 不投递 | 折叠呈现 |
| `image` | 二进制引用 | 不投递（GUI 折叠呈现） | 折叠呈现 |

**关键结论**：Harness 与 GUI 都不会把工具协议渲染成 `<invoke>` 文本。`<invoke>` 是模型在
`text` 块里**自行裸写**的回显行为。因此根治方案是「主动投影 `tool-call` 块」，而非正则删 text。

---

## 3. 出站投影规范（主力 + 防线分层）

### 3.1 主力：`assistantVisibleText(event)`（src/bridge.ts）
按 `content` 顺序遍历：
- `text` 块 → 原样拼接；
- `tool-call` 块 → 经 `formatToolCall`（src/format.ts）投影为：

  ```
  🔧 调用工具 `name`
    - key: value
    - key: value
  ```

  - `arguments` 为 JSON 字符串：`JSON.parse` 失败则回退原始字符串（坏参数不拖垮整条消息）。
  - 单参数值超过 800 字符截断并标注「已截断」，防止长输出撑爆单条 Matrix 消息。

模型因 `tool-call` 已被显式呈现，**无需在 text 里裸写工具协议**，从根上消除 `<invoke>` 泄漏，
且 Matrix 与 GUI 的工具调用历史保持一致。

### 3.2 防线：`sanitizeAssistantText(text)`（src/bridge.ts，仅兜底）
仅当模型仍偶发把 `<invoke ...>...</invoke>` 写进 text 时触发，折叠成一行提示。
保护规则：``` 围栏代码块、行内 `` `code` ``、转义形式 `&lt;invoke&gt;` 一律不动。
**正常情况下不应命中**——它是最后防线，不是主力。

---

## 4. 入站归一化结构（扩展点）

### 4.1 `InboundMessage`（src/matrix.ts）
```ts
interface InboundMessage {
  readonly roomId: string
  readonly sender: string
  readonly text: string          // m.text / m.notice；纯媒体消息时为空串
  readonly media: MediaBlock[]   // 图片/文件/音视频/位置；本轮仅占位
  readonly eventId: string
}
```

### 4.2 `MediaBlock`（src/matrix.ts）
```ts
interface MediaBlock {
  readonly msgtype: string      // m.image / m.file / m.audio / m.video / m.location
  readonly mimetype?: string
  readonly url?: string         // Matrix content URI（mxc:）或 http(s)（视同步来源）
  readonly mxc?: string
  readonly filename?: string
  readonly size?: number
  readonly body: string
}
```

### 4.3 当前行为
- `onTimelineEvent`（src/matrix.ts）识别 `m.image`/`m.file`/`m.audio`/`m.video`/`m.location`，
  归一成 `media[]`，**不再静默丢弃**（旧实现只对 `m.text` 放行）。
- `describeMedia`（src/format.ts）把媒体渲染为可读占位，例如 `[图片: photo.png (image/png)]`，
  并入 `message.text`，保证纯媒体消息也能进入处理流程、agent 有响应。
- 文本型 `m.text`/`m.notice` 仍按原逻辑透传为 `text`。

---

## 5. 后续扩展：图片等非文字信息处理

本轮**只建立结构与占位**，未实现内容解析。后续媒体处理应在以下钩子上扩展，
**不要**破坏现有 `InboundMessage`/`MediaBlock` 契约：

1. **下载/解析**：在 `onTimelineEvent` 拿到 `mxc:` 后，用矩阵媒体仓库 API
   （`/_matrix/media/v3/download`）拉取字节，填充 `MediaBlock` 的本地路径/Buffer 字段
   （建议在 `MediaBlock` 上新增 `localPath?` / `buffer`，保持向后兼容）。
2. **多模态注入**：把媒体作为 `ImageBlock`（harness `ContentBlockMap` 已含 `'image'` 类型）
   注入 harness，而非仅占位文本。需要：
   - 在 `deliver` 处把 `media` 转成 harness 的 `image` content 块（而非 `text`）；
   - 确认所用 LLM provider 的 `inputModalities` 支持 `image`。
3. **OCR/转写**：对图片/音频，在注入前做 OCR/语音转写，结果补充进 `text`，适配不支持
   多模态的模型。
4. **出站回显**：若 agent 生成 `image` 块，出站投影应渲染为 Matrix 图片消息
   （`m.image` + `mxc:`），而非纯文本。

> 约定：**任何媒体扩展都必须保留 `MediaBlock` 结构并走归一化层（`src/matrix.ts`），
> 桥接层（`src/bridge.ts`）只消费归一化结果，不直连矩阵协议细节。**

---

## 6. 测试约定

- 纯函数 `formatToolCall` / `describeMedia` 位于 `src/format.ts`，由
  `tests/format.media.test.mjs` 单测覆盖（投影、截断、JSON 回退、媒体占位、多媒体拼接）。
- 端到端行为（合并、审批、指令、去重、会话绑定）由 `tests/bridge.test.mjs` 覆盖。
- 运行：`npm test`（含 `tsc` 编译 + `node --test`）。

---

## 7. 出站事件覆盖矩阵（harness → Matrix）

> 背景：早期 `handleSessionEvent` 仅处理 `turn/start`/`turn/end`/`assistant/message` 三种事件，
> 导致「调用了工具却看不到结果」「turn 异常结束静默空转」等问题。本矩阵为整治后基线，
> 防止回归。

### 7.1 处理决策表

| 事件 | 结果党（默认） | 过程党 | 说明 |
|------|--------------|--------|------|
| `turn/start` | typing on | typing on | 进入输入态 |
| `turn/end` (completed) | typing off | typing off | 正常落幕，无提示 |
| `turn/end` (error/aborted/blocked/max-tokens/interrupted) | 落幕提示 + typing off | 落幕提示 + typing off | 始终提示异常原因，消除静默空转 |
| `assistant/message` | 仅 text | text + tool-call 投影 | 结果党只关心答案；过程党看工具调用 |
| `tool/call` | 配对记录 callId↔name，不投文本 | 同上 | 仅供 `tool/result` 投影显示工具名 |
| `tool/result` (失败) | 投失败提示 | 投失败提示 | 错误必见 |
| `tool/result` (成功) | 折叠（不投） | 投成功摘要 | 结果党折叠中间结果 |
| `llm/retry` | 始终日志诊断；达阈值熔断（结果党不展示提示，但记录到日志） | 投重试提示 + always 警示 | 过程党可见模型受限重试；两种模式都计数熔断止损 |
| `step/start`/`step/end` | 忽略 | 忽略 | 编排内部步骤，已被 `assistant/message` 吸收 |
| `assistant/chunk` | 忽略 | 忽略 | 流式增量，由 `assistant/message` 聚合 |
| `user/message` | 忽略 | 忽略 | 入站事件，由 `handleMessage` 处理 |
| `request/header`/`compaction/*`/`attachment/*`/`run/*`/`agent/*` | 忽略 | 忽略 | 内部/低层协议事件，对终端用户无独立意义 |

### 7.2 工具名配对

harness 的 `tool/result` 事件**仅含 `callId` 不含工具名**。实现维护
`AccountBridge.toolNames: Map<string,string>`（key=`${roomId}:${callId}`）：

- `tool/call` 到达时记录 `callId↔name`；
- `tool/result` 到达时查表配对显示工具名，查不到回退为「工具（callId）」；
- `turn/end` 时清理本房间全部前缀条目，避免内存增长。

### 7.3 投影纯函数（src/format.ts）

- `formatToolResult(event, toolName)` → 成功/失败可读文本，内容截断 800 字（与 `formatToolCall` 一致）。
- `formatTurnEnd(reason)` → 非 `completed` 返回落幕提示；`completed` 返回 `undefined`。
- `formatRetry(event)` → 重试轻提示（含次数/上限/延迟/原因；`always` 无上限模式额外加 ⚠️ 警示）。
- `formatRetryCircuitTripped(retry, threshold)` → 熔断落幕提示（已达 N 次/阈值 M，已终止止损）。

---

## 8. 用户偏好分流：结果党 vs 过程党

> 真实用户对模型的信任不同：有人只关心最终答案（结果党），有人想看工具调用与中间细节（过程党）。

### 8.1 设计

- **默认 `result`（结果党）**：只看最终答案；工具调用/中间结果折叠。
- **切换 `process`（过程党）**：用户在入站消息中说触发词即切换，per-room 独立。
- 触发词见 `PROCESS_TRIGGERS`（`src/format.ts`）：`给我过程信息`、`我需要看到详细过程`、
  `显示过程`、`看过程`、`详细过程`、`show process`、`verbose`（大小写不敏感、子串匹配）。
- 命中后桥接层回送「🔍 已切换到「过程模式」…」确认，并写日志 `verbosity → process`。
- 切换是**单向（结果→过程）**且**房间级持久**（直到会话释放 `releaseRoom` 才清空）。
- 命令（`/xxx`）不触发偏好切换，避免与指令混淆。

### 8.2 实现位置

- `wantsProcess(text)`：`src/format.ts` 纯函数，单测覆盖。
- `roomVerbosity: Map<string, Verbosity>`：`AccountBridge` 实例字段。
- 检测：`handleMessage` 在剥离 `@提及` 后、命令/审批判定前调用 `wantsProcess(stripped)`。
- 读取：`handleSessionEvent` 顶部 `const verbosity = this.roomVerbosity.get(roomId) ?? 'result'`，
  影响 `assistant/message`/`tool/result`/`llm/retry` 三处投影。
- 清理：`releaseRoom` 同时 `delete` `roomVerbosity` 与 `toolNames`。

### 8.3 后续可扩展

- 增加「切回结果模式」触发词（如 `只看结果`）。
- 把偏好持久化到 `AuthStore`/配置，跨会话保留。
- 支持账号级默认（config `defaultVerbosity`），房间级覆盖。

---

## 9. retry 诊断与熔断（token 止损）

> 背景：用户反馈「轮询太耗钱」。调研确认 dsh-matrix 出站本就事件驱动（Matrix `/sync`
> 为服务端挂起长轮询，不耗 token），**真正烧 token 的是 harness 内核 `llm-retry` 的
> `always` 无上限重试**——每次重试把整段上下文重发给 LLM。retry 策略属于 provider 配置，
> 插件无法直接覆盖，但可观察 `llm/retry` 事件并在超限时主动 `agent.cancel()` 终止 turn。

### 9.1 根因与边界

- `retryPolicy` 在 harness `packages/llm/llm-retry` 中属于 **provider 配置**，dsh-matrix
  只传 `provider`/`model` 路由名，不能直接改。本次**只在插件层做观察 + 熔断兜底**，不碰 harness。
- `llm/retry` 事件含 `retry`（同 `(turn,step,provider,policyKey)` 链内严格单调递增，由框架
  不变量保证）、`maxRetries?`（`undefined`=always 无上限）、`delayMs`、`failure?`。
- `Agent.cancel({ kind: 'hook', reason })` 会中止活跃 turn，触发 `turn/end`（reason.kind=`aborted`），
  复用既有落幕链路。

### 9.2 诊断增强

- **始终日志诊断**：`llm/retry` 到达时写 `logger.info`，含 roomId、retry 序号、mode
  （`always(无上限)` / `normal(上限N)`）、失败原因。结果党即便不在聊天展示，也能事后复盘 token 消耗。
- **过程模式展示**：`verbosity==='process'` 时 `safeSend` 完整重试提示；`always` 模式额外
  标注 ⚠️「无上限退避，将持续消耗 token」，直接暴露 token 黑洞。

### 9.3 熔断兜底

- 按房间累计 `retryCounts: Map<roomId, number>`，每次取 `data.retry` 序号。
- 当 `retry >= config.maxRetriesBeforeAbort`（**默认 5**）且 `retryCircuitBreakerEnabled`（默认 true）时：
  - 校验 `handle.agent.status === 'running'`（避免对已完成 turn 无效 cancel）；
  - 调 `handle.agent.cancel({ kind: 'hook', reason: 'dsh-matrix: retry circuit breaker at N/M' })`；
  - `safeSend` 落幕提示 `formatRetryCircuitTripped(retry, threshold)`：「🛑 已达 N 次重试（阈值 M），已终止本次会话以止损」；
  - 不再累加计数，避免 cancel 后重复触发。
- `turn/end` 时清理 `retryCounts`（与 `toolNames` 并列）；`releaseRoom` 同样清理。无内存增长。

### 9.4 配置项（src/config.ts）

| 字段 | 默认 | 说明 |
|------|------|------|
| `maxRetriesBeforeAbort` | `5` | 同房间 turn 内重试达此次数即熔断；设为 `0` 配合开关可关闭 |
| `retryCircuitBreakerEnabled` | `true` | 熔断总开关；关闭后仅保留诊断日志，不做主动 cancel |

> 阈值取 5 是给用户指定值（给模型更多恢复机会），同时避免偶发限流被误杀。可在
> `cordis.patch.yml` 的 `config` 中覆盖。

### 9.5 数据流

```
llm/retry ──▶ 计数(按 roomId) + 始终日志诊断
                ├─ verbosity=process ─▶ 展示 formatRetry（always 加 ⚠️）
                └─ retry >= 阈值 ─▶ agent.cancel({kind:'hook'}) ─▶ turn/end(aborted) ─▶ 清理计数 + 落幕提示
```


