/**
 * Matrix→harness 桥接层：多账号支持（主账号 + N 个数字分身）、per-room & per-account
 * agent 会话、入站消息注入（@提及路由 / 合并窗口）、出站投递、审批推送与聊天应答、
 * Owner 授权记忆（L1 静默 / L2 房间确认 / L3 红线强制）。
 *
 * 每个矩阵账号一个 AccountBridge：独立 sync 循环、独立状态文件、独立会话绑定。
 *
 * @module dsh-matrix/bridge
 */

import { join } from 'node:path'
import { existsSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle, AgentOptions } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { TextBlock } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import type { Config, DigitalTwinAccount } from './config.js'
import { chunkText, markdownToHtml, formatToolCall, describeMedia, wantsProcess, formatToolResult, formatTurnEnd, formatRetry, formatRetryCircuitTripped, formatTasks, formatCwdGuide, formatRules, formatWorkspaceState } from './format.js'
import type { Verbosity, WorkspaceState } from './format.js'
import { MatrixChannel } from './matrix.js'
import type { Channel, InboundMessage } from './matrix.js'
import { getDiag } from './diag.js'
import { ChatLog } from './chatlog.js'
import { BridgeState } from './store.js'
import type { MatrixTask, AllowDenyRule } from './store.js'
import { AuthStore } from './auth-store.js'

const APPROVE_RE = /^(批准|同意|approve|yes|ok)$/i
const DENY_RE = /^(拒绝|驳回|deny|no|reject)$/i

const HELP_TEXT = [
  '/help — 显示本帮助',
  '/status — 查看本房间绑定会话与状态',
  '/new — 开始一个全新会话',
  '/clear — 重置当前会话（同 /new）',
  '/bind <session-id> — 把本房间绑定到已有会话（需要 session persistence）',
  '/auth list — 列出本分身在本房间的记忆授权',
  '/auth revoke <tool> — 吊销某工具的记忆授权（仅 Owner）',
  '/auth revoke-all — 吊销本房间全部记忆授权（仅 Owner）',
  '',
  '— Matrix 任务队列（数字分身收件箱）—',
  '/tasks — 查看本房间任务面板（待审/已办、工作目录状态）',
  '/queue — 同 /tasks，刷新任务列表',
  '/approve <N> — 执行第 N 条待审任务（新房间需先选工作目录）',
  '/reject <N> — 拒绝第 N 条待审任务',
  '/allow <人> <事> — 加白名单（人/事可填 * 通配）',
  '/deny <人> <事> — 加黑名单（人/事可填 * 通配）',
  '/rules — 查看黑白名单',
  '',
  '消息合并：以 `..` 结尾表示还有后续，以 `!!` 结尾表示立即提交，裸文本进入合并窗口。',
].join('\n')

interface MergeBuffer {
  parts: string[]
  sender?: string
  timer?: NodeJS.Timeout
}

interface PendingApproval {
  readonly request: ApprovalRequest
  /** 批准后是否写入记忆授权（红线工具为 false）。 */
  readonly grantOnApprove: boolean
  readonly settle: (outcome: ApprovalOutcome) => void
}

/**
 * 出站主力投影：把 harness 结构化 `assistant/message` 渲染成 Matrix 可见文本。
 *
 * 之前只取 `text` 块，导致模型调用工具的 `tool-call` 块在 Matrix 端不可见，
 * 模型被迫在 text 里裸写 `<invoke>` 协议而泄漏。这里按 content 顺序遍历：
 *  - `text` 块：原样保留（与 GUI `toAssistantBlocks` 的 text 块一致）。
 *  - `tool-call` 块：主动投影为可读的"调用工具 name + 参数摘要"。这样模型
 *    无需在文本中裸写工具协议，从根上消除 `<invoke>` 泄漏，并保证 Matrix
 *    与 GUI 的工具调用历史一致。
 *  - `reasoning`/`tool-result`/`image` 等：按契约不在用户可见文本中展开
 *    （reasoning 默认不可见，tool-result/image 由 GUI 折叠呈现，保持现状）。
 */
/** 类型谓词：把 harness 的 tool-call 块从 ContentBlock 联合中收窄出来。 */
function isToolCallBlock(block: { type: string }): block is { type: 'tool-call'; name: string; arguments: string } {
  return block.type === 'tool-call'
}

function assistantVisibleText(
  event: Extract<SessionEvent, { type: 'assistant/message' }>,
  verbosity: Verbosity,
): string | undefined {
  const showToolCalls = verbosity === 'process'
  const parts: string[] = []
  for (const block of event.data.message.content) {
    if (block.type === 'text') {
      parts.push((block as TextBlock).text)
    } else if (isToolCallBlock(block) && showToolCalls) {
      parts.push(formatToolCall(block))
    }
  }
  const joined = parts.join('\n\n').trim()
  return joined.length === 0 ? undefined : joined
}

/**
 * 出站兜底防线（非主力）：仅当模型仍偶发把工具协议以 XML 文本写进 text 块时
 * （典型 `<invoke name="bash">...</invoke>`），把泄漏文本折叠成一行提示，
 * 避免污染 Matrix 房间/截图。主力是上面的 `tool-call` 主动投影，本函数仅作
 * 最后防线，正常情况下不会命中。
 *
 * 保留：```围栏代码块```、行内 `code`、转义形式 `&lt;invoke ...&gt;` 原文不动。
 */
function sanitizeAssistantText(text: string): string {
  if (!text.includes('<invoke')) return text
  const lines = text.split('\n')
  const out: string[] = []
  let fence: string | null = null
  const replaced: string[] = []
  for (const line of lines) {
    const trimmed = line.trimStart()
    if (fence !== null) {
      out.push(line)
      if (trimmed.startsWith('```')) fence = null
      continue
    }
    if (trimmed.startsWith('```')) {
      fence = '```'
      out.push(line)
      continue
    }
    out.push(replaceInvokeOutsideInlineCode(line, replaced))
  }
  if (replaced.length > 0) {
    out.push(`（已折叠 ${replaced.length} 处偶发裸写的工具协议，避免污染输出）`)
  }
  return out.join('\n')
}

function replaceInvokeOutsideInlineCode(line: string, replaced: string[]): string {
  // 简易状态机：行内 `` 配对区间内保留原文；区间外执行剥除。
  let result = ''
  let i = 0
  let buffer = ''
  while (i < line.length) {
    if (line[i] === '`') {
      const close = line.indexOf('`', i + 1)
      if (close === -1) {
        buffer += line.slice(i)
        break
      }
      // 把刚刚累积的 buffer 提交/剥除，再原样吐出行内代码段。
      result += stripInvokeTags(buffer, replaced)
      buffer = ''
      result += line.slice(i, close + 1)
      i = close + 1
      continue
    }
    buffer += line[i]
    i += 1
  }
  result += stripInvokeTags(buffer, replaced)
  return result
}

function stripInvokeTags(segment: string, replaced: string[]): string {
  if (!segment.includes('<invoke')) return segment
  // 把模型裸回显的工具协议 XML 转成可读的"调用工具"提示，保留工具名与参数，
  // 而不是直接删除导致信息丢失，也避免裸 <invoke> 文本污染 Matrix 房间/截图。
  return segment.replace(/<invoke\b([^>]*)>([\s\S]*?)<\/invoke>/g, (_whole, attrs: string, body: string) => {
    const nameMatch = attrs.match(/\bname\s*=\s*"([^"]*)"/)
    const name = nameMatch?.[1] ?? 'unknown'
    const params = [...body.matchAll(/<parameter\b[^>]*\bname\s*=\s*"([^"]*)"[^>]*>([\s\S]*?)<\/parameter>/g)]
      .map((m) => `  - ${m[1] ?? ''}: ${(m[2] ?? '').trim()}`)
      .join('\n')
    replaced.push(_whole)
    const header = `🔧 调用工具 \`${name}\``
    return params.length > 0 ? `${header}\n${params}` : header
  })
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function localpartOf(mxid: string): string {
  const at = mxid.indexOf(':')
  return at > 0 ? mxid.slice(1, at) : mxid.slice(1)
}

/** 转义正则特殊字符，用于把 localpart 安全嵌入正则。 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 稳定短哈希（FNV-1a 32bit → 8 位 hex），用于确定性会话 id。 */
function stableHash(input: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

/**
 * 单个 Matrix 账号的桥接单元：独立 sync 循环、独立状态文件、独立会话绑定。
 */
export class AccountBridge {
  readonly userId: string
  readonly isMain: boolean
  readonly owner?: string
  private readonly respondToAll: boolean
  private readonly agentOptions: AgentOptions

  private readonly ctx: Context
  private readonly config: Config
  private readonly state: BridgeState
  private readonly authStore: AuthStore
  private readonly channel: Channel
  private readonly allAccountIds: readonly string[]
  /** 诊断日志：写入 stateDir/diagnostics.log，供事后文件排查（无需运行终端）。 */
  private readonly diag: ReturnType<typeof getDiag>
  /** 近期聊天记录（按房间，最近一周）：与响应门控解耦，无论是否 @都记录，供 @时被引用。 */
  private readonly chatlog: ChatLog
  /** 共享的「房间内有 pending 审批」集合（MatrixBridge 传入，多账号协调审批应答）。 */
  private readonly pendingRooms: Set<string>

  private readonly roomAgents = new Map<string, AgentHandle>()
  /** 并发单飞锁：避免同一 roomId 的消息同时进入 getRoomAgent 时重复创建会话。 */
  private readonly roomAgentInflight = new Map<string, Promise<Agent>>()
  private readonly mergeBuffers = new Map<string, MergeBuffer>()
  private readonly pendingApprovals = new Map<string, PendingApproval[]>()
  /**
   * 工具名配对缓存：tool/result 事件只带 callId 不带 name，需经 tool/call 的
   * callId↔name 配对。turn 结束时随房间清理，避免内存增长。
   */
  private readonly toolNames = new Map<string, string>()
  /**
   * 房间级 verbosity 偏好：默认 'result'（结果党）；用户说"给我过程信息"等触发词
   * 时切到 'process'（过程党）。per-room 独立，不在房间间共享。
   */
  private readonly roomVerbosity = new Map<string, Verbosity>()
  /**
   * 重试熔断计数：按房间累计当前 turn 内 LLM 受限重试次数（取 llm/retry.retry 序号）。
   * 达 config.maxRetriesBeforeAbort 时主动 agent.cancel() 终止 turn 止损。
   * turn/end 时随 toolNames 一并清理，避免内存增长。
   */
  private readonly retryCounts = new Map<string, number>()
  /**
   * 房间级 matrix 任务队列（数字分身收件箱）：别的同事发来的待审工作。
   * 内存镜像，与 state.matrixTasks 同步；数字分身模式下入站消息进此队列，
   * 由 Owner 用 /approve 逐条授权后串行执行。
   */
  private readonly matrixTasks = new Map<string, MatrixTask[]>()
  /**
   * 等待选工作目录的房间：值为候选目录列表 + 暂存的待执行任务 id。
   * 新房间首次 /approve 时若尚未绑定工作目录则进入此态。
   */
  private readonly cwdPending = new Map<string, { candidates: string[]; taskId: string }>()
  /** 房间当前正在执行（已 approve、turn 进行中）的任务 id。 */
  private readonly runningTask = new Map<string, string>()

  constructor(
    ctx: Context,
    config: Config,
    state: BridgeState,
    authStore: AuthStore,
    account: DigitalTwinAccount,
    allAccountIds: readonly string[],
    pendingRooms: Set<string>,
    fetchFn?: typeof fetch,
    sleep?: (ms: number) => Promise<void>,
  ) {
    this.ctx = ctx
    this.config = config
    this.state = state
    this.authStore = authStore
    this.allAccountIds = allAccountIds
    this.pendingRooms = pendingRooms
    this.diag = getDiag('dsh-matrix', config.stateDir)
    this.chatlog = new ChatLog(config.stateDir)

    this.userId = account.userId
    this.isMain = account.userId === config.userId
    this.owner = account.owner !== '' ? account.owner : (this.isMain ? config.owner : undefined)
    // 响应策略：显式 respondToAll 优先；主账号兜底 true（旧行为）。
    this.respondToAll = account.respondToAll || this.isMain
    this.agentOptions = {
      provider: account.provider !== '' ? account.provider : config.provider,
      model: account.model !== '' ? account.model : config.model,
    }

    this.channel = new MatrixChannel({
      homeserverUrl: config.homeserverUrl,
      accessToken: account.accessToken,
      userId: this.userId,
      state: this.state,
      onMessage: (message) => {
        void this.handleMessage(message)
      },
      isAllowed: (sender) => this.authorized(sender),
      logger: ctx.logger,
      ...(fetchFn === undefined ? {} : { fetchFn }),
      ...(sleep === undefined ? {} : { sleep }),
    })
  }

  /** ---------- 生命周期 ---------- */

  async start(): Promise<void> {
    await this.state.load()
    // 恢复各房间任务队列到内存镜像（重启不丢审核进度）。
    for (const [roomId, tasks] of Object.entries(this.state.matrixTasksSnapshot())) {
      this.matrixTasks.set(roomId, tasks)
    }
    await this.connectWithRetry()
  }

  async stop(): Promise<void> {
    const handles = [...this.roomAgents.values()]
    this.roomAgents.clear()
    this.roomAgentInflight.clear()
    await Promise.allSettled(handles.map((handle) => handle.dispose()))
    await this.channel.stop()
    await this.state.dispose()
  }

  private async connectWithRetry(): Promise<void> {
    let attempt = 0
    for (;;) {
      try {
        await this.channel.start()
        this.ctx.logger.info(
          '[dsh-matrix] %s connected as %s%s',
          this.isMain ? 'main' : 'twin',
          this.userId,
          this.owner !== undefined ? ` (owner: ${this.owner})` : '',
        )
        return
      } catch (error) {
        attempt += 1
        this.ctx.logger.warn('[dsh-matrix] sync failed for %s (attempt %d): %s', this.userId, attempt, messageOf(error))
        await new Promise((resolve) => setTimeout(resolve, Math.min(1000 * attempt, 10000)))
      }
    }
  }

  /** ---------- 身份与权限 ---------- */

  private authorized(sender: string): boolean {
    if (this.config.allowAllUsers) return true
    if (this.owner !== undefined && sender === this.owner) return true
    return this.config.allowedUserIds.includes(sender)
  }

  /**
   * 消息路由（多账号协作语义）：
   * 1. 若消息 @提及 了任一已知账号（主账号或分身），则只有被 @提及 的账号响应，
   *    其余账号（含主账号）一律静默，避免抢答别人/别的数字人的对话；
   * 2. 无任何 @提及 时：私聊（≤2 人房间）始终响应；群聊里一律静默——无论 isMain 还是
   *    respondToAll，都不响应未指名给自己的群消息（避免浪费 token、避免抢答别人的对话）。
   *    分身在群里必须被显式 @提及 才响应。命令同样遵循该规则；审批应答不受此门控限制。
   */
  private async shouldRespond(message: InboundMessage): Promise<boolean> {
    const lower = message.text.toLowerCase()
    // 提及识别兼容三种 Matrix 渲染格式：
    //  1) '@名字'（Element 常见）
    //  2) '@名字:域名' 完整 ID
    //  3) '名字:' / '名字：'（部分客户端/桥接把 @提及 渲染为 "名字: 内容"，无 @ 无域名）
    const mentioned = this.allAccountIds.filter((id) => {
      const lp = localpartOf(id).toLowerCase()
      return (
        lower.includes(`@${lp}`) ||
        lower.includes(id.toLowerCase()) ||
        new RegExp(`(^|\\s)${escapeRegExp(lp)}[:：]`).test(lower)
      )
    })
    const isDm = this.channel.isDirectRoom ? await this.channel.isDirectRoom(message.roomId) : false
    // 诊断日志：每次门控决策都打印关键因子，便于事后从 diagnostics.log 排查"为何响应/静默"。
    this.diag.log(`shouldRespond room=${message.roomId} account=${this.userId} isMain=${this.isMain} respondToAll=${this.respondToAll} isDm=${isDm} mentioned=${mentioned.length > 0 ? mentioned.join(',') : '(none)'} text=${message.text.slice(0, 60).replace(/\n/g, ' ')}`)
    // 消息 @提及了某个已知账号：只有被 @的账号响应，其余全部静默（含主账号）。
    if (mentioned.length > 0) {
      const ok = mentioned.includes(this.userId)
      this.diag.log(`  -> mentioned-branch: respond=${ok} (${ok ? 'self' : 'other'} mentioned)`)
      return ok
    }
    // 无人被 @提及：私聊始终响应。
    if (isDm) {
      this.diag.log('  -> dm-branch: respond=true')
      return true
    }
    // 群聊：一律静默。分身/主账号都必须被显式 @提及 才响应，避免浪费 token 与抢答。
    this.diag.log('  -> group-silent-branch: respond=false')
    return false
  }

  private isRedline(toolName: string): boolean {
    return (this.config.redlineTools ?? []).includes(toolName)
  }

  /** ---------- 会话绑定 ---------- */

  roomForSession(sessionId: string): string | undefined {
    return this.state.sessionRoom(sessionId)
  }

  private getRoomAgent(roomId: string): Promise<Agent> {
    // 已建立：直接返回缓存的 agent。
    const existing = this.roomAgents.get(roomId)
    if (existing !== undefined) return Promise.resolve(existing.agent)

    // 并发单飞：同一 roomId 同时到达的多条消息复用同一个建连 promise，
    // 杜绝对同一个确定性 sessionId 并发 create 导致 "while it is live"。
    const inflight = this.roomAgentInflight.get(roomId)
    if (inflight !== undefined) return inflight

    const promise = this.createRoomAgent(roomId).finally(() => {
      this.roomAgentInflight.delete(roomId)
    })
    this.roomAgentInflight.set(roomId, promise)
    return promise
  }

  private async createRoomAgent(roomId: string): Promise<Agent> {
    // 内核已把某 session 恢复为 live 时，ctx.agents.get 返回 Agent（无 dispose 包装）。
    // 这里包成 AgentHandle，与本函数其余路径（create/resume 返回的 AgentHandle）一致，
    // 使 roomAgents 缓存与末尾 return handle.agent 逻辑统一。
    const asHandle = (agent: Agent): AgentHandle => ({ agent, dispose: async () => {} })

    // 优先 resume 历史绑定（旧随机 id 会话的迁移路径）。
    const binding = this.state.roomSession(roomId)
    if (binding !== undefined) {
      const bindingId = SessionId(binding)
      // 内核启动可能已将该 session 恢复为 live，直接取用，避免重复 prepare。
      const liveBinding = this.ctx.agents.get(bindingId)
      if (liveBinding !== undefined) {
        const handle = asHandle(liveBinding)
        this.roomAgents.set(roomId, handle)
        return handle.agent
      }
      try {
        const handle = await this.ctx.agents.resume({
          resumeSessionId: bindingId,
          agentOptions: this.agentOptions,
          setup: this.agentSetup(),
        })
        this.roomAgents.set(roomId, handle)
        return handle.agent
      } catch (error) {
        const reason = messageOf(error)
        // 内核并发恢复导致已 live：取用内核已有会话，而非报错退出。
        if (reason.includes('while it is live')) {
          const live = this.ctx.agents.get(bindingId)
          if (live !== undefined) {
            const handle = asHandle(live)
            this.roomAgents.set(roomId, handle)
            return handle.agent
          }
        }
        this.ctx.logger.warn('[dsh-matrix] resume %s failed (%s); falling back to deterministic id', binding, reason)
      }
    }

    // 确定性会话 id：同一房间永远同一 id。
    // dsh web / GUI 启动时会主动恢复所有持久化会话使其成为 live，因此该 id 可能
    // 已被内核加载并注册到 agents 表。先用既有 live agent：避免重复 create/resume
    // 撞 "already exists" / "while it is live" / "id collision"。
    const sessionId = SessionId(`matrix-${localpartOf(this.userId)}-${stableHash(roomId)}`)
    const handle = await this.acquireAgent(sessionId, {
      cwd: this.state.roomCwd(roomId) ?? (this.config.cwdCandidates ?? [])[0] ?? process.cwd(),
    })
    this.roomAgents.set(roomId, handle)
    this.state.setRoomSession(roomId, handle.agent.id)
    // 会话标题 = Matrix 房间名（pin 住，自动标题不再覆盖）。
    void this.nameSessionFromRoom(roomId, handle.agent)
    return handle.agent
  }

  /**
   * 构建 agent 的 setup 回调：在 agent scope 上 compose 配置指定的 preset，使
   * shell/file/检索/skills 等工具挂载到该 agent。harness 的 GUI 会话由 host 自动注入
   * 此 setup；dsh-matrix 直接走 ctx.agents.create/resume（底层 factory），必须自己传
   * setup，否则 agent 不 compose 任何 preset → 工具不可见（agent 侧报 "unknown tool"）。
   */
  private agentSetup(): (agentCtx: Context) => Promise<void> {
    const preset = this.config.agentPreset ?? 'standard'
    return async (agentCtx: Context) => {
      // agentPresets 是 host 平面服务（host-plane），不在 dsh-matrix 插件 ctx 的类型声明里，
      // 不能用 this.ctx.agentPresets（会触发 cordis "without inject"）。用 this.ctx.get() 动态
      // 取 host 服务实例，再把 preset 挂载到 setup 回调传入的 agent scope（agentCtx）上。
      const presets = this.ctx.get('agentPresets') as
        | { mount(c: Context, id: string): Promise<unknown> }
        | undefined
      if (!presets) {
        throw new Error('agentPresets service is not available on the host context')
      }
      await presets.mount(agentCtx, preset)
    }
  }

  /**
   * 取得（或恢复）某会话对应的 live agent，规避与内核自动加载的并发碰撞、以及
   * create 时 cwd 与磁盘持久化值不一致导致的 "id collision"。
   *
   * 顺序：
   *   1. 内核已加载并注册为 live agent —— 直接取用，绝不重复 prepare；
   *   2. 先 resume 续接历史（不传 cwd，复用磁盘持久化的 cwd，避免 cwd 不匹配的 id collision）；
   *   3. resume 因「无持久化 log」失败（全新会话）—— 用 create 新建（带 cwd）；
   *   4. resume 撞 "while it is live"（内核并发 prepare 刚好完成）—— 轮询等待内核把
   *      会话注册到 agents 表后取用，避免二次 prepare 撞车；
   *   5. 其它 resume 失败（如 live turn 未关闭）也先轮询一次内核是否已就绪，仍失败再抛出。
   */
  private async acquireAgent(sessionId: SessionId, meta: { cwd: string }): Promise<AgentHandle> {
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
    const wrap = (agent: Agent): AgentHandle => ({ agent, dispose: async () => {} })
    const waitForLive = async (label: string): Promise<AgentHandle | undefined> => {
      for (let attempt = 0; attempt < 12; attempt++) {
        const live = this.ctx.agents.get(sessionId)
        if (live !== undefined) {
          if (attempt > 0) this.ctx.logger.info('[dsh-matrix] session %s live after %dms (%s)', sessionId, (attempt + 1) * 150, label)
          return wrap(live)
        }
        await sleep(150)
      }
      return undefined
    }

    // 1) 内核已加载并注册为 live agent：直接取用，绝不重复 prepare。
    const liveNow = this.ctx.agents.get(sessionId)
    if (liveNow !== undefined) return wrap(liveNow)

    // 2) resume 续接历史（不传 cwd，复用磁盘持久化 cwd，避免 cwd 不匹配的 id collision）。
    try {
      return await this.ctx.agents.resume({
        resumeSessionId: sessionId,
        agentOptions: this.agentOptions,
        setup: this.agentSetup(),
      })
    } catch (resumeError) {
      const reason = messageOf(resumeError)
      // 3) 无持久化 log（全新会话）：create 新建（带 cwd）。
      if (reason.includes('not found') || reason.includes('no such') || reason.includes('has no persisted')) {
        this.ctx.logger.warn('[dsh-matrix] session %s has no persisted log; creating fresh', sessionId)
        return this.ctx.agents.create({
          sessionId,
          meta: {
            cwd: meta.cwd,
            agentPreset: this.config.agentPreset ?? 'standard',
          },
          agentOptions: this.agentOptions,
          setup: this.agentSetup(),
        })
      }
      // 4) 内核并发 prepare 撞车：轮询等待内核把会话注册到 agents 表后取用。
      const waited = await waitForLive('resume-collision')
      if (waited !== undefined) return waited
      // 5) 其它 resume 失败：再轮询一次内核是否已就绪，仍失败抛出原始错误。
      if (reason.includes('while it is live')) {
        const waited2 = await waitForLive('resume-live')
        if (waited2 !== undefined) return waited2
      }
      throw resumeError
    }
  }


  /** 若 Matrix 房间有名字，把 agent 会话标题固定为房间名。 */
  private async nameSessionFromRoom(roomId: string, agent: Agent): Promise<void> {
    try {
      const roomName = await this.channel.getRoomName?.(roomId)
      if (roomName === undefined || roomName === '') return
      const title = this.ctx.get('sessionTitle')
      if (title === undefined) return
      title.rename(agent.session, roomName)
      this.ctx.logger.info('[dsh-matrix] session %s titled "%s"', agent.id, roomName)
    } catch (error) {
      this.ctx.logger.warn('[dsh-matrix] title rename failed: %s', messageOf(error))
    }
  }

  private async releaseRoom(roomId: string): Promise<void> {
    const handle = this.roomAgents.get(roomId)
    this.roomAgentInflight.delete(roomId)
    if (handle !== undefined) {
      this.roomAgents.delete(roomId)
      await handle.dispose()
    }
    this.state.deleteRoom(roomId)
    this.settleAll(roomId, 'unavailable')
    const buffer = this.mergeBuffers.get(roomId)
    if (buffer !== undefined) {
      if (buffer.timer !== undefined) clearTimeout(buffer.timer)
      this.mergeBuffers.delete(roomId)
    }
    this.toolNames.delete(roomId)
    this.roomVerbosity.delete(roomId)
    this.retryCounts.delete(roomId)
    this.matrixTasks.delete(roomId)
    this.cwdPending.delete(roomId)
    this.runningTask.delete(roomId)
  }

  /** ---------- 入站消息 ---------- */

  private async handleMessage(message: InboundMessage): Promise<void> {
    try {
      // 入站归一化：把文本与媒体占位合并成一条 message.text。
      // 媒体本轮仅占位（如「[图片: xxx.png]」），内容解析为后续扩展点；
      // 不静默丢弃，避免用户发图后 agent 无响应造成的困惑。
      const text = (message.text + describeMedia(message.media)).trim()
      if (text === '') return

      // 剥离「已知账号」的 @提及 前缀后再判定命令/审批词（如 '@ai-dev /auth list'）。
      // 仅去除本插件已知账号的提及，避免误删命令参数里的人名（如 /deny @alice:hs.example 机密）。
      let stripped = text
      for (const id of this.allAccountIds) {
        const lp = localpartOf(id)
        stripped = stripped
          .replace(id, '')
          .replace(`@${lp}`, '')
          .replace(new RegExp(`(^|\\s)${escapeRegExp(lp)}[:：]`), '')
      }
      stripped = stripped.replace(/\s+/g, ' ').trim()

      // 偏好切换：检测过程模式触发词（"给我过程信息/我需要看到详细过程"等）。
      // 命中即把本房间切到 process；默认 result；命令不触发（命令以 '/' 开头）。
      if (!stripped.startsWith('/') && wantsProcess(stripped)) {
        const prev = this.roomVerbosity.get(message.roomId) ?? 'result'
        if (prev !== 'process') {
          this.roomVerbosity.set(message.roomId, 'process')
          this.ctx.logger.info('[dsh-matrix] room %s verbosity → process', message.roomId)
          void this.safeSend(message.roomId, '🔍 已切换到「过程模式」：后续将展示工具调用、工具结果与重试等中间细节。', undefined)
        }
      }

      // 审批应答最优先（不受 @提及/私聊 路由门控限制）：
      // 配置了 owner 时仅 Owner 可应答；未配置 owner 时任意白名单用户可应答（旧行为）。
      const queue = this.pendingApprovals.get(message.roomId)
      const first = queue?.[0]
      const isApprovalWord = APPROVE_RE.test(stripped) || DENY_RE.test(stripped)
      if (first !== undefined && isApprovalWord) {
        if (this.owner !== undefined && message.sender !== this.owner) {
          this.ctx.logger.warn('[dsh-matrix] approval reply from %s ignored (only %s may answer)', message.sender, this.owner)
          return
        }
        if (APPROVE_RE.test(stripped)) {
          if (first.grantOnApprove) {
            this.authStore.grant(this.userId, this.owner ?? this.userId, message.roomId, first.request.toolName)
            void this.authStore.save().catch((error: unknown) => {
              this.ctx.logger.error('[dsh-matrix] auth save failed: %s', messageOf(error))
            })
          }
          first.settle('allowed-once')
          return
        }
        first.settle('rejected')
        return
      }
      // 多账号协调：房间里有别的账号的 pending 审批时，纯审批词归那个账号，
      // 本账号不把它当普通消息注入会话。
      if (isApprovalWord && this.pendingRooms.has(message.roomId)) {
        return
      }

      // 工作目录选择回复：房间处于 cwdPending 时，编号即选定目录（Owner 操作）。
      const pending = this.cwdPending.get(message.roomId)
      if (pending !== undefined) {
        const idx = Number.parseInt(stripped, 10)
        if (Number.isInteger(idx) && idx >= 1 && idx <= pending.candidates.length) {
          const cwd = pending.candidates[idx - 1]
          if (cwd === undefined) return
          this.state.setRoomCwd(message.roomId, cwd)
          this.cwdPending.delete(message.roomId)
          this.ctx.logger.info('[dsh-matrix] room %s cwd set to %s', message.roomId, cwd)
          // 选定后创建会话并执行暂存的任务。
          const task = this.findTask(message.roomId, pending.taskId)
          void this.safeSend(message.roomId, `✅ 已设定工作目录：\n${cwd}\n正在创建会话并执行任务…`, undefined)
          if (task !== undefined) {
            await this.executeTask(message.roomId, task)
          }
          return
        }
        // 非编号回复：提示重选。
        void this.safeSend(message.roomId, '请回复编号选择工作目录，或发送 /reject 取消该任务。', undefined)
        return
      }

      this.diag.log(`handleMessage room=${message.roomId} from=${message.sender} digitalTwinMode=${this.config.digitalTwinMode} text=${text.slice(0, 60).replace(/\n/g, ' ')}`)
      // 记录近期聊天（与响应门控解耦：无论是否 @都存，供被人 @ 时回溯上下文）。
      if (text.trim().length > 0) {
        this.chatlog.append(message.roomId, { ts: Date.now(), sender: message.sender, text })
      }
      if (!(await this.shouldRespond(message))) return

      if (stripped.startsWith('/')) {
        this.flushMerge(message.roomId)
        await this.handleCommand(message.roomId, message.sender, stripped)
        return
      }

      // 数字分身模式：同事/主管发来的工作进 matrix 任务队列待审，不直接执行。
      // 机器人自己账号发出的消息（如有）不进队列；命令已在上方处理。
      // 入队用 stripped（已剥 @提及 前缀）：任务面板与注入 agent 的文本不带原始提及标记。
      if (this.config.digitalTwinMode && message.sender !== this.userId) {
        await this.enqueueTask(message.roomId, message.sender, stripped)
        return
      }

      // 合并窗口：'..' 继续、'!!' 立即提交、裸文本等待 mergeTimeoutSecs。
      // 用 stripped（已剥 @提及 前缀）：注入 agent 的提示词不带原始提及标记。
      let rest = stripped
      let flush = false
      if (stripped.endsWith('!!')) {
        rest = stripped.slice(0, -2).trim()
        flush = true
      } else if (stripped.endsWith('..')) {
        rest = stripped.slice(0, -2).trim()
      }
      if (rest === '') return
      const buffer = this.mergeBuffers.get(message.roomId) ?? { parts: [], sender: message.sender }
      if (buffer.timer !== undefined) clearTimeout(buffer.timer)
      buffer.parts.push(rest)
      buffer.timer = setTimeout(() => {
        this.flushMerge(message.roomId)
      }, this.config.mergeTimeoutSecs * 1000)
      this.mergeBuffers.set(message.roomId, buffer)
      if (flush) this.flushMerge(message.roomId)
    } catch (error) {
      this.ctx.logger.error('[dsh-matrix] message %s failed: %s', message.eventId, messageOf(error))
    }
  }

  private flushMerge(roomId: string): void {
    const buffer = this.mergeBuffers.get(roomId)
    if (buffer === undefined) return
    this.mergeBuffers.delete(roomId)
    if (buffer.timer !== undefined) clearTimeout(buffer.timer)
    const text = buffer.parts.join('\n').trim()
    if (text === '') return
    void this.deliver(roomId, text, buffer.sender)
  }

  /**
   * 把房间消息注入 agent 会话。
   * source.kind 用 'user'（而非 'plugin'）：Harness GUI 对 user/message 事件按
   * source.kind 分类——'plugin' 会被渲染成"上下文"而非用户输入气泡，导致
   * Matrix 里看到的输入在 GUI 历史中不可见。'user' 让输入在两边一致可见。
   * sender 一并带上，多人群聊时 GUI 历史可区分说话人。
   */
  /**
   * 构造一条极小的房间上下文标签（约 1 行，token 与群人数无关）。
   * 仅用于让 agent 知道自己身处的会话类型（群聊/私聊）与身份，消除"把群聊当 1v1"的误判。
   * 绝不注入成员名单——大群也不会放大 token。群名/人数均走带缓存的接口。
   */
  private async roomContextLabel(roomId: string): Promise<string> {
    const isDm = this.channel.isDirectRoom ? await this.channel.isDirectRoom(roomId) : false
    const me = `@${localpartOf(this.userId)}`
    if (isDm) {
      const name = this.channel.getRoomName ? await this.channel.getRoomName(roomId) : undefined
      const peer = name !== undefined ? `（${name}）` : ''
      return `[私聊${peer}，你是${me}]`
    }
    const roomName = this.channel.getRoomName ? await this.channel.getRoomName(roomId) : undefined
    const count = this.channel.getRoomMemberCount ? await this.channel.getRoomMemberCount(roomId) : undefined
    const head = roomName !== undefined ? `群聊「${roomName}」` : '群聊'
    const size = count !== undefined ? `，约${count}人` : ''
    const label = `[${head}${size}，你是${me}]`
    this.diag.log(`roomContextLabel room=${roomId} isDm=${isDm} name=${roomName ?? '(none)'} count=${count ?? '(unknown)'} label=${label}`)
    return label
  }

  /**
   * 群聊最近一周的对话上下文（供分身被人 @ 时回溯/引用）。纯文本，按时间升序，
   * 最多取最近 40 条，单条过长截断。返回空字符串表示无上下文。token 与群人数无关。
   */
  private groupChatContext(roomId: string, max = 40, maxLine = 200): string {
    const recent = this.chatlog.recent(roomId, max)
    if (recent.length === 0) return ''
    const lines = recent.map((e) => {
      const t = e.text.length > maxLine ? e.text.slice(0, maxLine) + '…' : e.text
      return `- ${e.sender}: ${t}`
    })
    return `【本群最近对话（未 @你 的你也可能需要的上下文）】\n${lines.join('\n')}`
  }

  private async deliver(roomId: string, text: string, sender?: string): Promise<void> {
    const agent = await this.getRoomAgent(roomId)
    // 群聊上下文：群名+人数+身份一行前缀，避免 agent 误把群消息当私聊对话。
    const label = await this.roomContextLabel(roomId)
    let body = `${label}\n${text}`
    // 群聊里：当本条是触发分身的消息时，附上最近一周对话上下文，便于引用前置消息。
    const isDm = this.channel.isDirectRoom ? await this.channel.isDirectRoom(roomId) : false
    if (!isDm) {
      const ctx = this.groupChatContext(roomId)
      if (ctx) body = `${label}\n${ctx}\n\n【当前消息】\n${text}`
    }
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: body }],
      source: {
        kind: 'user',
        ...(sender !== undefined ? { sender } : {}),
      },
    }))
  }

  /** ---------- Matrix 任务队列 ---------- */

  private tasksOf(roomId: string): MatrixTask[] {
    let tasks = this.matrixTasks.get(roomId)
    if (tasks === undefined) {
      tasks = this.state.loadTasks(roomId)
      this.matrixTasks.set(roomId, tasks)
    }
    return tasks
  }

  private persistTasks(roomId: string): void {
    this.state.saveTasks(roomId, this.tasksOf(roomId))
  }

  private findTask(roomId: string, taskId: string): MatrixTask | undefined {
    return this.tasksOf(roomId).find((t) => t.id === taskId)
  }

  /** 工作目录状态（供任务面板渲染）。 */
  private workspaceStateOf(roomId: string): { state: WorkspaceState; cwd?: string } {
    const cwd = this.state.roomCwd(roomId)
    if (cwd === undefined) return { state: 'none' }
    // 选了目录但路径不存在，提示（仅做轻量判定，不强制）。
    if (!existsSync(cwd)) return { state: 'missing', cwd }
    return { state: 'bound', cwd }
  }

  /** 把一条待审任务推给房间（精简面板）。 */
  private async pushTasks(roomId: string): Promise<void> {
    const text = formatTasks(this.tasksOf(roomId), this.workspaceStateOf(roomId))
    await this.safeSend(roomId, text, markdownToHtml(text))
  }

  /**
   * 入站消息进 matrix 任务队列：先查人+事黑白名单。
   * - 命中黑名单 → 自动拒绝（记原因）；命中白名单 → 自动批准（记"记忆授权"）；
   * - 否则 pending 等 Owner 用 /approve 审核。
   * 队列超 taskQueueMax 时最早 pending 任务被自动拒绝（防堆积）。
   */
  private async enqueueTask(roomId: string, sender: string, text: string): Promise<void> {
    const matter = this.classifyMatter(text)
    const rule = this.state.matchRule(sender, matter) ?? this.state.matchRule(sender, '*')
    const task: MatrixTask = {
      id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      roomId,
      sender,
      text,
      status: 'pending',
      createdAt: Date.now(),
    }
    if (rule !== undefined && rule.kind === 'deny') {
      task.status = 'rejected'
      task.note = `命中黑名单（人=${rule.person} 事=${rule.matter}）自动拒绝`
    } else if (rule !== undefined && rule.kind === 'allow') {
      task.status = 'approved'
      task.note = `命中白名单（人=${rule.person} 事=${rule.matter}）记忆授权`
    }
    const tasks = this.tasksOf(roomId)
    tasks.push(task)
    // 超限保护：拒绝最早的 pending。
    const max = this.config.taskQueueMax
    const pending = tasks.filter((t) => t.status === 'pending')
    if (pending.length > max) {
      const drop = pending[0]
      if (drop !== undefined) {
        drop.status = 'rejected'
        drop.note = `队列超限（>${max}）自动拒绝`
      }
    }
    this.persistTasks(roomId)

    if (task.status === 'rejected') {
      await this.safeSend(roomId, `🚫 任务已被拒绝：${task.note}\n${task.text}`, undefined)
      return
    }
    if (task.status === 'approved') {
      // 白名单命中：直接执行（仍受串行约束）。
      await this.executeTask(roomId, task)
      return
    }
    await this.safeSend(
      roomId,
      `📥 新任务已入队（待审）：\n来自 ${sender}：${text}\n发送 /tasks 查看，/approve N 执行。`,
      undefined,
    )
  }

  /** 粗粒度"事"分类：取消息首个有意义关键词（后续可接 LLM 分类）。 */
  private classifyMatter(text: string): string {
    const trimmed = text.trim()
    if (trimmed === '') return '*'
    // 取前 16 字作为事类别占位（人+事维度下"事"用关键词指代）。
    return trimmed.slice(0, 16)
  }

  /**
   * 执行一条已批准任务：先确保工作目录已设定（新房间引导），再创建会话注入。
   * 同一房间串行：runningTask 占用时排队等待 turn/end 释放。
   */
  private async executeTask(roomId: string, task: MatrixTask): Promise<void> {
    // 新房间（未绑定 cwd）先引导选目录。
    if (this.state.roomCwd(roomId) === undefined) {
      const candidates = await this.cwdCandidatesFor(roomId)
      this.cwdPending.set(roomId, { candidates, taskId: task.id })
      task.status = 'pending'
      task.note = '等待设定工作目录'
      this.persistTasks(roomId)
      await this.safeSend(roomId, formatCwdGuide(candidates), markdownToHtml(formatCwdGuide(candidates)))
      return
    }
    // 串行：若已有 running 任务，标记 approved 等 turn/end 消费。
    if (this.runningTask.get(roomId) !== undefined) {
      task.status = 'approved'
      task.note = '已批准，等待前序任务完成'
      this.persistTasks(roomId)
      await this.pushTasks(roomId)
      return
    }
    task.status = 'approved'
    this.runningTask.set(roomId, task.id)
    this.persistTasks(roomId)
    const ctxPrompt = task.contextPrompt !== undefined ? `${task.contextPrompt}\n\n${task.text}` : task.text
    await this.deliver(roomId, ctxPrompt, task.sender)
    await this.pushTasks(roomId)
  }

  /** 候选工作目录：内核 workspaceRegistry 已登记的工作区 + 配置候选。 */
  private async cwdCandidatesFor(roomId: string): Promise<string[]> {
    const fromConfig = this.config.cwdCandidates.filter((c) => c !== undefined && c !== '')
    const fromRegistry: string[] = []
    try {
      const registry = this.ctx.get('workspaceRegistry') as
        | { list?: () => { path: string }[] }
        | undefined
      if (registry?.list !== undefined) {
        for (const ws of registry.list()) fromRegistry.push(ws.path)
      }
    } catch {
      /* 内核未提供 workspaceRegistry 时仅用配置候选 */
    }
    const set = new Set<string>([...fromRegistry, ...fromConfig, process.cwd()])
    return [...set]
  }

  /** turn/end 后把当前 running 任务标完成，并消费下一条 approved 任务（严格串行）。 */
  private async consumeNextTask(roomId: string): Promise<void> {
    const runningId = this.runningTask.get(roomId)
    if (runningId !== undefined) {
      const t = this.findTask(roomId, runningId)
      if (t !== undefined) {
        t.status = 'done'
        this.persistTasks(roomId)
      }
    }
    this.runningTask.delete(roomId)
    const next = this.tasksOf(roomId).find((t) => t.status === 'approved')
    if (next !== undefined) await this.executeTask(roomId, next)
  }

  /** ---------- 命令 ---------- */

  private async handleCommand(roomId: string, sender: string, raw: string): Promise<void> {
    const [command, ...rest] = raw.split(/\s+/)
    const arg = rest.join(' ').trim()
    const reply = (text: string) => this.safeSend(roomId, text, markdownToHtml(text))

    switch (command) {
      case '/start':
      case '/help':
        await reply(HELP_TEXT)
        break
      case '/new':
      case '/clear':
        await this.releaseRoom(roomId)
        await reply('已开始全新会话。')
        break
      case '/status': {
        const handle = this.roomAgents.get(roomId)
        const identity = this.isMain ? '主账号' : `数字分身（Owner: ${this.owner ?? '未配置'}）`
        if (handle === undefined) await reply(`本房间还没有绑定会话。\n身份：${identity}\n账号：${this.userId}`)
        else await reply(`当前会话：\`${handle.agent.id}\`（状态 ${handle.agent.status}）\n身份：${identity}\n账号：${this.userId}`)
        break
      }
      case '/bind': {
        if (arg === '') {
          await reply('用法：`/bind <session-id>`')
          break
        }
        await this.releaseRoom(roomId)
        try {
          const handle = await this.ctx.agents.resume({
            resumeSessionId: SessionId(arg),
            agentOptions: this.agentOptions,
          })
          this.roomAgents.set(roomId, handle)
          this.state.setRoomSession(roomId, handle.agent.id)
          await reply(`已绑定会话 \`${handle.agent.id}\`。`)
        } catch (error) {
          await reply(`绑定失败：${messageOf(error)}（需要在组合中配置 session persistence）`)
        }
        break
      }
      case '/auth': {
        const [subCmd, ...toolParts] = arg.split(/\s+/)
        const toolName = toolParts.join(' ').trim()
        switch (subCmd) {
          case 'list': {
            const record = this.authStore.getRecord(this.userId, roomId)
            if (record === undefined) {
              await reply(`📋 ${this.userId} 在本房间暂无记忆授权。`)
              break
            }
            await reply(
              `📋 ${this.userId} 在本房间的记忆授权\n` +
              `Owner：${record.ownerId}\n` +
              `工具：${record.allowedTools.length > 0 ? record.allowedTools.map((t) => `\`${t}\``).join('、') : '无'}\n` +
              `最后确认：${new Date(record.lastConfirmedAt).toLocaleString('zh-CN')}`,
            )
            break
          }
          case 'revoke': {
            if (this.owner !== undefined && sender !== this.owner) {
              await reply('❌ 只有 Owner 可以吊销授权。')
              break
            }
            if (toolName === '') {
              await reply('用法：`/auth revoke <tool>`')
              break
            }
            const ok = this.authStore.revoke(this.userId, roomId, toolName)
            await this.authStore.save().catch(() => {})
            await reply(ok ? `✅ 已吊销 \`${toolName}\` 的记忆授权。` : `⚠️ \`${toolName}\` 本来就没有授权。`)
            break
          }
          case 'revoke-all': {
            if (this.owner !== undefined && sender !== this.owner) {
              await reply('❌ 只有 Owner 可以吊销授权。')
              break
            }
            const ok = this.authStore.revoke(this.userId, roomId)
            await this.authStore.save().catch(() => {})
            await reply(ok ? '✅ 已吊销本房间全部记忆授权。' : '⚠️ 本房间本来就没有授权。')
            break
          }
          default:
            await reply('用法：`/auth list` | `/auth revoke <tool>` | `/auth revoke-all`')
        }
        break
      }
      case '/tasks':
      case '/queue':
        await this.pushTasks(roomId)
        break
      case '/approve': {
        if (arg === '') {
          await reply('用法：`/approve <N>`（N 为 /tasks 列表中的序号）')
          break
        }
        const n = Number.parseInt(arg, 10)
        const tasks = this.tasksOf(roomId)
        const pending = tasks.filter((t) => t.status === 'pending')
        if (!Number.isInteger(n) || n < 1 || n > pending.length) {
          await reply(`❌ 序号无效，当前待审 ${pending.length} 条（/tasks 查看）。`)
          break
        }
        const task = pending[n - 1]
        if (task === undefined) break
        await this.executeTask(roomId, task)
        break
      }
      case '/reject': {
        if (arg === '') {
          await reply('用法：`/reject <N>`')
          break
        }
        const n = Number.parseInt(arg, 10)
        const pending = this.tasksOf(roomId).filter((t) => t.status === 'pending')
        if (!Number.isInteger(n) || n < 1 || n > pending.length) {
          await reply(`❌ 序号无效，当前待审 ${pending.length} 条。`)
          break
        }
        const task = pending[n - 1]
        if (task === undefined) break
        task.status = 'rejected'
        task.note = `Owner 拒绝（${sender}）`
        this.persistTasks(roomId)
        await reply(`🚫 已拒绝第 ${n} 条任务。`)
        await this.pushTasks(roomId)
        break
      }
      case '/allow':
      case '/deny': {
        const [person, ...matterParts] = arg.split(/\s+/)
        const matter = matterParts.join(' ').trim() || '*'
        if (person === undefined || person === '') {
          await reply('用法：`/allow <人> <事>` 或 `/deny <人> <事>`（人/事可填 * 通配）')
          break
        }
        this.state.addRule({
          person,
          matter,
          kind: command === '/allow' ? 'allow' : 'deny',
          addedAt: Date.now(),
        })
        await reply(`✅ 已添加${command === '/allow' ? '白' : '黑'}名单：人=${person} 事=${matter}`)
        break
      }
      case '/rules':
        await reply(formatRules(this.state.listRules()))
        break
      default:
        await reply(`未知命令 \`${command ?? ''}\`，发送 /help 查看帮助。`)
    }
  }

  /** ---------- 出站投递 ---------- */

  handleSessionEvent(session: Session, event: SessionEvent): void {
    const roomId = this.roomForSession(session.id)
    if (roomId === undefined) return
    const verbosity = this.roomVerbosity.get(roomId) ?? 'result'
    const data = event.data as any
    // 用 string 比较放宽收窄，兼容宿主未导出的 'llm/retry' 等事件类型。
    switch (event.type as string) {
      case 'turn/start':
        void this.channel.sendTyping(roomId, true).catch((error: unknown) => {
          this.ctx.logger.warn('[dsh-matrix] typing failed: %s', messageOf(error))
        })
        break
      case 'turn/end': {
        void this.channel.sendTyping(roomId, false).catch(() => {})
        const reason = data.reason ?? {}
        const msg = formatTurnEnd(reason)
        if (msg !== undefined) {
          this.ctx.logger.warn('[dsh-matrix] turn/end not completed: %s', reason.kind)
          void this.safeSend(roomId, msg, undefined)
        }
        for (const key of this.toolNames.keys()) {
          if (key.startsWith(`${roomId}:`)) this.toolNames.delete(key)
        }
        this.retryCounts.delete(roomId)
        // 串行消费：前序任务结束后，执行下一条已批准任务（若有）。
        void this.consumeNextTask(roomId)
        break
      }
      case 'tool/call': {
        // 记录 callId↔name 配对，供 tool/result 投影时显示工具名。
        const callId = (data.message?.source?.callId as string) ?? ''
        const name = (data.message?.content?.find?.((b: any) => b.type === 'tool-call')?.name as string) ?? ''
        if (callId !== '') this.toolNames.set(`${roomId}:${callId}`, name)
        break
      }
      case 'tool/result': {
        if (verbosity !== 'process') {
          // 结果党：仅错误时可见（否则折叠，避免噪声）。
          const isError = data.message?.content?.[0]?.isError === true
          if (!isError) break
        }
        const callId = (data.message?.source?.callId as string) ?? ''
        const name = callId !== '' ? (this.toolNames.get(`${roomId}:${callId}`) ?? '') : ''
        const result = formatToolResult(
          {
            callId,
            isError: data.message?.content?.[0]?.isError === true,
            content: data.message?.content?.[0]?.content ?? [],
          },
          name,
        )
        void this.safeSend(roomId, result, undefined)
        break
      }
      case 'llm/retry': {
        const retry = data.retry ?? 1
        const isUnbounded = data.maxRetries === undefined
        const failureMsg = data.failure?.message
        // 诊断：始终记录 retry 来源（mode/次数/原因），便于事后复盘 token 消耗。
        this.ctx.logger.info(
          '[dsh-matrix] llm/retry room=%s retry=%d mode=%s%s',
          roomId,
          retry,
          isUnbounded ? 'always(无上限)' : `normal(上限${data.maxRetries})`,
          failureMsg ? ` reason=${failureMsg}` : '',
        )
        // 过程模式：展示完整重试提示（含 always 无上限警示）。
        if (verbosity === 'process') {
          void this.safeSend(
            roomId,
            formatRetry({ retry, maxRetries: data.maxRetries, delayMs: data.delayMs ?? 0, failure: data.failure }),
            undefined,
          )
        }
        // 熔断：累计重试次数达阈值即主动终止 turn 止损（harness always 模式会无限烧 token）。
        const threshold = this.config.maxRetriesBeforeAbort
        if (this.config.retryCircuitBreakerEnabled && threshold > 0 && retry >= threshold) {
          const handle = this.roomAgents.get(roomId)
          if (handle !== undefined && handle.agent.status === 'running') {
            this.ctx.logger.warn('[dsh-matrix] retry circuit breaker tripped room=%s retry=%d>=%d', roomId, retry, threshold)
            handle.agent.cancel({ kind: 'hook', reason: `dsh-matrix: retry circuit breaker at ${retry}/${threshold}` })
            void this.safeSend(roomId, formatRetryCircuitTripped(retry, threshold), undefined)
          }
          // cancel 后 turn/end 会触发并清理 retryCounts；此处不再累加避免重复触发。
          break
        }
        this.retryCounts.set(roomId, retry)
        break
      }
      case 'assistant/message': {
        const text = assistantVisibleText(event as Extract<SessionEvent, { type: 'assistant/message' }>, verbosity)
        if (text !== undefined) void this.deliverText(roomId, text)
        break
      }
      default:
        // 按设计忽略（与 GUI 可视化语义对齐，不 1:1 复刻 token 级细节）：
        // - step/start / step/end：编排内部步骤标记，已由 assistant/message 吸收
        // - assistant/chunk：流式增量，由 assistant/message 聚合后统一投
        // - user/message：入站事件，由 handleMessage 处理，不在出站重投
        // - tool/call：配对记录已在上方处理，无需单独投文本
        // - request/header / compaction/* / attachment/* / run/* / agent/*：
        //   内部/低层协议事件，对终端用户无独立意义
        break
    }
  }

  private async deliverText(roomId: string, text: string): Promise<void> {
    const cleaned = sanitizeAssistantText(text)
    for (const chunk of chunkText(cleaned, this.config.chunkMaxChars)) {
      await this.safeSend(roomId, chunk.plain, chunk.html)
    }
  }

  private async safeSend(roomId: string, plain: string, html?: string): Promise<void> {
    try {
      await this.channel.sendText(roomId, plain, html)
    } catch (error) {
      if (html !== undefined) {
        try {
          await this.channel.sendText(roomId, plain)
        } catch (fallbackError) {
          this.ctx.logger.error('[dsh-matrix] delivery failed: %s', messageOf(fallbackError))
        }
      } else {
        this.ctx.logger.error('[dsh-matrix] delivery failed: %s', messageOf(error))
      }
    }
  }

  /** ---------- 审批（三级授权） ---------- */

  handleApproval(roomId: string, request: ApprovalRequest): Promise<ApprovalOutcome> {
    const grantable = !this.isRedline(request.toolName)
    if (grantable && this.authStore.isStandingAuthorized(this.userId, roomId, request.toolName, this.config.redlineTools ?? [])) {
      this.ctx.logger.info('[dsh-matrix] %s uses standing auth for `%s` in %s', this.userId, request.toolName, roomId)
      return Promise.resolve('allowed-once')
    }
    return this.askRoom(roomId, request, grantable)
  }

  private askRoom(
    roomId: string,
    request: ApprovalRequest,
    grantOnApprove: boolean,
  ): Promise<ApprovalOutcome> {
    return new Promise<ApprovalOutcome>((resolve) => {
      const timer = setTimeout(() => settle('unavailable'), this.config.approvalTimeoutSecs * 1000)
      let done = false
      const settle = (outcome: ApprovalOutcome): void => {
        if (done) return
        done = true
        clearTimeout(timer)
        const queue = this.pendingApprovals.get(roomId)
        if (queue !== undefined) {
          const index = queue.findIndex((entry) => entry.settle === settle)
          if (index >= 0) queue.splice(index, 1)
          if (queue.length === 0) {
            this.pendingApprovals.delete(roomId)
            this.pendingRooms.delete(roomId)
          }
        }
        resolve(outcome)
      }
      const queue = this.pendingApprovals.get(roomId) ?? []
      queue.push({ request, grantOnApprove, settle })
      this.pendingApprovals.set(roomId, queue)
      this.pendingRooms.add(roomId)
      request.signal?.addEventListener('abort', () => settle('cancelled'), { once: true })

      const who = this.owner !== undefined ? `@${localpartOf(this.owner)}` : ''
      const redlineNote = this.isRedline(request.toolName) ? ' ⛔️红线工具，每次都需确认' : ''
      const scopeNote = this.owner !== undefined ? `\n👉 仅 Owner ${who} 可以应答。` : ''
      const text =
        `⚠️ [审批请求${redlineNote}] 账号 \`${this.userId}\` 的工具 \`${request.toolName}\` 需要批准` +
        `${request.reason ? `，原因：${request.reason}` : ''}。请在 ${this.config.approvalTimeoutSecs} 秒内回复「批准」或「拒绝」。${scopeNote}`
      void this.safeSend(roomId, text, markdownToHtml(text))
    })
  }

  private settleAll(roomId: string, outcome: ApprovalOutcome): void {
    const queue = this.pendingApprovals.get(roomId)
    if (queue === undefined) return
    this.pendingApprovals.delete(roomId)
    this.pendingRooms.delete(roomId)
    for (const entry of queue) entry.settle(outcome)
  }
}

export interface MatrixBridgeOptions extends Config {
  readonly accessToken: string
  /** 测试接缝：替换通道层的 fetch 与 sleep。 */
  readonly fetchFn?: typeof fetch
  readonly sleep?: (ms: number) => Promise<void>
}

/**
 * 多账号桥接编排器：
 * - 主账号 + config.digitalTwins 里的每个分身各对应一个 AccountBridge 实例；
 * - 共享同一个记忆授权库（AuthStore）；
 * - session/event 与 approval/request 统一分发到所属账号的 bridge 处理。
 */
export class MatrixBridge {
  private readonly ctx: Context
  private readonly config: MatrixBridgeOptions
  private readonly authStore: AuthStore
  private readonly accounts: AccountBridge[] = []
  private disposeEvents: (() => void) | undefined
  private disposeApproval: (() => void) | undefined

  constructor(ctx: Context, config: MatrixBridgeOptions) {
    this.ctx = ctx
    this.config = config
    this.authStore = new AuthStore(config.stateDir, config.authStoreFile ?? 'auth-store.json')

    // 所有账号 id（主账号 + 分身），用于 @提及 路由裁决。
    const allAccountIds = [
      config.userId,
      ...(config.digitalTwins ?? []).map((t) => t.userId),
    ]
    // 共享「房间有 pending 审批」集合：多账号协调审批应答归属。
    const pendingRooms = new Set<string>()

    // 1. 挂载主账号（保持 state.json 名字，向后兼容）。
    //    按用户架构：userId 即数字分身自己，owner 是真实人账号（仅在 Matrix 客户端登录）。
    const mainAccount: DigitalTwinAccount = {
      userId: config.userId,
      accessToken: config.accessToken,
      tokenEnv: '',
      owner: config.owner ?? '',
      role: 'main',
      respondToAll: config.respondToAll,
      provider: config.provider,
      model: config.model,
    }
    this.accounts.push(
      new AccountBridge(
        ctx,
        config,
        new BridgeState(join(config.stateDir, 'state.json')),
        this.authStore,
        mainAccount,
        allAccountIds,
        pendingRooms,
        config.fetchFn,
        config.sleep,
      ),
    )

    // 2. 挂载额外的数字分身（每个拥有独立的 state 子文件，避免房间绑定键冲突）
    for (const twin of config.digitalTwins ?? []) {
      if (twin.userId === config.userId) continue
      const token = twin.accessToken !== '' ? twin.accessToken : (twin.tokenEnv !== '' ? process.env[twin.tokenEnv] : undefined)
      if (token === undefined || token === '') {
        ctx.logger.warn('[dsh-matrix] twin %s skipped: no access token (set accessToken or tokenEnv)', twin.userId)
        continue
      }
      const twinState = new BridgeState(join(config.stateDir, 'twins', `${localpartOf(twin.userId)}.json`))
      this.accounts.push(
        new AccountBridge(
          ctx,
          config,
          twinState,
          this.authStore,
          { ...twin, accessToken: token },
          allAccountIds,
          pendingRooms,
          config.fetchFn,
          config.sleep,
        ),
      )
    }
  }

  async start(): Promise<void> {
    if (this.disposeEvents !== undefined) return
    await this.authStore.load()

    this.disposeEvents = this.ctx.on('session/event', (session, event) => {
      for (const account of this.accounts) {
        account.handleSessionEvent(session, event)
      }
    })

    this.ctx.inject(['approval'], (approvalCtx) => {
      this.disposeApproval = approvalCtx.on('approval/request', async (req, next) => {
        for (const account of this.accounts) {
          const roomId = account.roomForSession(req.agent.id)
          if (roomId !== undefined) return account.handleApproval(roomId, req)
        }
        return next()
      })
    })

    await Promise.all(this.accounts.map((account) => account.start()))
  }

  async stop(): Promise<void> {
    if (this.disposeEvents !== undefined) {
      this.disposeEvents()
      this.disposeEvents = undefined
    }
    this.disposeApproval?.()
    this.disposeApproval = undefined
    await Promise.allSettled(this.accounts.map((account) => account.stop()))
    this.accounts.length = 0
    await this.authStore.save().catch(() => {})
  }
}
