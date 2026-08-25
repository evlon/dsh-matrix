---
name: Matrix 端任务面板与工作目录引导（复用 harness 内核接口）
overview: 在 dsh-matrix 插件内实现对标 harness GUI 任务面板与工作目录设置的 Matrix 远程入口：通过 ctx.jobs 读写任务（待办/已办/状态），通过 session.header.cwd + ctx.workspaceRegistry + ctx.directoryPicker 设置工作目录，新房间首次无绑定时文本编号引导选目录，房间内 /queue /up /down 排序并逐条批准串行执行。全部复用内核状态，与 GUI 实时同步。
todos:
  - id: store-cwd
    content: store.ts 增加 roomCwd 持久化字段与读写方法
    status: completed
  - id: config-jobs
    content: config.ts 增加 cwdCandidates 与 jobQueueMax 配置项
    status: completed
  - id: format-jobs
    content: format.ts 新增任务面板与工作区状态渲染函数
    status: completed
  - id: cwd-guide
    content: bridge.ts 实现首次无绑定 cwd 文本编号引导与设定
    status: completed
    dependencies:
      - store-cwd
      - config-jobs
  - id: job-queue
    content: bridge.ts 普通消息入队、/queue /up /down 排序命令
    status: completed
    dependencies:
      - format-jobs
  - id: job-approve
    content: bridge.ts 实现 /approve 串行执行与 /reject 取消、turn/end 消费下一条
    status: completed
    dependencies:
      - job-queue
  - id: jobs-event
    content: bridge.ts 新增 session/jobs 事件推送房间面板，releaseRoom 清理新状态
    status: completed
    dependencies:
      - format-jobs
  - id: tests-jobs
    content: 新增 bridge.jobs.test.mjs 覆盖引导/队列/串行/拒绝/推送
    status: completed
    dependencies:
      - cwd-guide
      - job-approve
      - jobs-event
---

## 用户需求
在 dsh-matrix 插件内实现对标 harness 电脑端 GUI「任务面板」与「工作目录设置」的 Matrix 远程入口，复用 harness 内核状态（与 GUI 实时同步），不改动内核与 GUI 本身。

## 产品概述
用户通过 Matrix 聊天窗口远程管理每个会话的工作目录与任务队列：新房间首次进入时以文本编号引导选择工作目录；房间内多人派发的消息进入任务队列，用户用聊天命令查看、排序、逐条批准并按序串行执行；任务面板状态（待办/已办、各任务状态、工作区有无）实时同步给房间。

## 核心功能
- 新房间首次无绑定时，发一条文本编号消息列出候选工作目录（来自 ctx.workspaceRegistry + 默认候选），用户回复编号即设定该会话工作目录（写回 session.header.cwd）；老房间不弹。
- 房间内入站消息不直接执行，而是进入内核任务队列（ctx.jobs），以「待办」呈现；用 /queue 查看当前队列与顺序，/up N /down N 调整顺序。
- 逐条批准：/approve N 将任务标为运行中并注入 agent 执行，前一条 turn 结束后才消费下一条（串行）；/reject N 标为已取消。
- 任务状态变更（session/jobs 事件）实时推送房间精简任务面板：待办/已办计数、每条标签与状态、工作区状态（已有工作区 / 还没工作区 / 新来的）。


## 技术栈
- 沿用 dsh-matrix 现有技术栈：TypeScript + NodeNext + cordis 插件框架，复用 `@deepseek-ai/dsh-jobs`、`@deepseek-ai/dsh-workspace`、`@deepseek-ai/dsh-session` 等内核包已导出接口。
- 不引入新依赖；不改 harness 内核/GUI。

## 实现方案
采用「内核状态复用 + dsh-matrix 轻量编排层」策略：
1. **工作目录引导**：`getRoomAgent` 前判定 `state.roomCwd(roomId)` 与 `state.roomSession(roomId)` 均为空即视为「首次无绑定」，向房间发文本编号引导（候选来自 `ctx.workspaceRegistry.list()` 的 path + 默认候选目录），置 `cwdPending` 标记；用户回复编号 → `setRoomCwd` 持久化 + `createRoomAgent(meta.cwd=选定值)` + 回执。老房间（已有绑定/cwd）直接走 `getRoomAgent`。
2. **任务队列**：普通入站消息改为 `ctx.jobs.create({ sessionId, kind:'message', label:text, payload:text })` 入队（替代原 `deliver` 直接执行）；房间级维护 `jobOrder: Map<roomId, JobId[]>` 保存用户排序。`/queue` 渲染 `ctx.jobs.list({ sessionId, withStatus:true })` 按 `jobOrder` 带序号展示；`/up N` `/down N` 调 `jobOrder`；`/approve N` 将对应 job `update(id,{status:'Running'})` 并 `deliver` 其 payload，置 `runningJob`；`turn/end` 时若 `runningJob` 完成则消费 `jobOrder` 中下一个已 approve 的 job；`/reject N` → `update(id,{status:'Cancelled'})`。
3. **状态同步**：`handleSessionEvent` 新增 `session/jobs` case，向房间推送精简面板（`formatJobs` 在 format.ts 新增）；工作区状态由 `state.roomCwd` 与 `ctx.workspaceRegistry.resolveByPath(session.header.cwd)` 联合判定。

## 实现注意事项
- 复用现有 `roomVerbosity/toolNames/retryCounts` 同款 `Map` 模式新增 `cwdPending/jobOrder/runningJob`，并在 `releaseRoom` 一并清理，避免内存增长。
- `createRoomAgent` 当前写死 `meta:{ cwd: process.cwd() }`（bridge.ts:386），改为优先 `state.roomCwd(roomId) ?? 默认候选[0] ?? process.cwd()`。
- 串行消费严格依赖 `turn/end` 事件（已存在 case）触发下一条，避免并发执行；`deliver` 保持原 `agent.followup` 注入逻辑不变。
- 复用 `BridgeState` 原子写入（tmp+rename+去抖）模式持久化 `roomCwd`，不新增存储机制。
- 仅首次无绑定弹引导，老房间零打扰；所有交互纯文本，全 Matrix 客户端兼容。

## 架构设计
```mermaid
flowchart TD
  A[Matrix 入站消息] --> B{首次无绑定?}
  B -- 是 --> C[发编号引导选 cwd]
  C --> D[用户回编号]
  D --> E[setRoomCwd + createRoomAgent meta.cwd]
  B -- 否 --> F[ctx.jobs.create 入队]
  F --> G[/queue /up /down 排序]
  G --> H[/approve N 串行执行]
  H --> I[turn/end 消费下一条]
  J[session/jobs 事件] --> K[推送房间任务面板]
  L[ctx.workspaceRegistry] --> C
  L --> M[工作区状态展示]
```

## 目录结构
```
src/
├── bridge.ts     # [MODIFY] AccountBridge：新增 cwdPending/jobOrder/runningJob 房间级 Map；getRoomAgent 前插入 cwd 引导判定与发引导；createRoomAgent 用 state.roomCwd 填 meta.cwd；handleMessage 普通消息改入队（不再直接 deliver）；handleCommand 新增 /queue /up /down /approve /reject；handleSessionEvent 新增 session/jobs case 推面板；releaseRoom 清理新 Map。
├── store.ts      # [MODIFY] BridgeState：StateFile 增加 roomCwds 字段；新增 roomCwd(roomId)/setRoomCwd(roomId,cwd)/deleteRoomCwd(roomId)；load 反序列化 roomCwds；保持原子写入不变。
├── config.ts     # [MODIFY] Config 新增 cwdCandidates:string[]（默认 [process.cwd()]）、jobQueueMax:number（默认 20）；Schema 对应声明。
├── format.ts     # [MODIFY] 新增 formatJobs(jobs, order, workspaceState) 渲染任务面板文本；新增工作区状态文案常量。
└── index.ts      # [无需改] 插件入口已 export 各模块，apply 注入 ['agents']，ctx.jobs/workspaceRegistry 在运行时由外围组合提供。
tests/
└── bridge.jobs.test.mjs  # [NEW] 覆盖 cwd 引导首次触发、/queue 排序、/approve 串行、/reject 取消、session/jobs 推送；用 fetchFn/sleep 接缝与 mock ctx.jobs。
```

## 关键代码结构
```ts
// src/store.ts 新增（持久化房间→工作目录绑定）
interface StateFile {
  version: 1
  roomSessions: Record<string, RoomBinding>
  roomCwds?: Record<string, string>   // 房间已选定的工作目录
  processedEventIds: string[]
  syncToken?: string
}

// src/bridge.ts 房间级编排状态（与 roomVerbosity 同模式）
private readonly cwdPending = new Map<string, true>()
private readonly jobOrder = new Map<string, string[]>()   // roomId -> jobId 顺序
private readonly runningJob = new Map<string, string>()   // roomId -> 当前执行中 jobId

// ctx.jobs 调用形态（来自 harness 内核，仅引用不重定义）
// ctx.jobs.create({ sessionId, kind: 'message', label: text, payload: text }) -> Job
// ctx.jobs.list({ sessionId, withStatus: true }) -> Job[]
// ctx.jobs.update(id, { status: 'Running' | 'Cancelled' }) -> Job
```

