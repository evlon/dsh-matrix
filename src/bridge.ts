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
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle, AgentOptions } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { TextBlock } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import type { Config, DigitalTwinAccount } from './config.js'
import { chunkText, markdownToHtml, formatToolCall, describeMedia, wantsProcess, formatToolResult, formatTurnEnd, formatRetry } from './format.js'
import type { Verbosity } from './format.js'
import { MatrixChannel } from './matrix.js'
import type { Channel, InboundMessage } from './matrix.js'
import { BridgeState } from './store.js'
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

    this.userId = account.userId
    this.isMain = account.userId === config.userId
    this.owner = account.owner !== '' ? account.owner : undefined
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
   * 1. 若消息 @提及 了任一已知账号（主账号或分身），则只有被 @提及 的账号响应；
   * 2. 无任何 @提及 时：主账号响应全部（旧行为）；分身仅响应 respondToAll 或私聊（≤2 人房间）。
   * 命令同样遵循该规则；审批应答不受此门控限制（在 handleMessage 中先行处理）。
   */
  private async shouldRespond(message: InboundMessage): Promise<boolean> {
    const lower = message.text.toLowerCase()
    const mentioned = this.allAccountIds.filter((id) =>
      lower.includes(`@${localpartOf(id).toLowerCase()}`) || lower.includes(id.toLowerCase()),
    )
    if (mentioned.length > 0) {
      return mentioned.includes(this.userId)
    }
    if (this.respondToAll) return true
    if (this.channel.isDirectRoom && await this.channel.isDirectRoom(message.roomId)) return true
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
    // 优先 resume 历史绑定（旧随机 id 会话的迁移路径）。
    const binding = this.state.roomSession(roomId)
    if (binding !== undefined) {
      try {
        const handle = await this.ctx.agents.resume({
          resumeSessionId: SessionId(binding),
          agentOptions: this.agentOptions,
        })
        this.roomAgents.set(roomId, handle)
        return handle.agent
      } catch (error) {
        this.ctx.logger.warn('[dsh-matrix] resume %s failed (%s); falling back to deterministic id', binding, messageOf(error))
      }
    }

    // 确定性会话 id：同一房间永远同一 id。agents.create 语义为首次创建；
    // 若该 id 在当前 harness 进程/持久化里已存在，create 会抛错：
    //   - "already exists"：store 中已有该会话；
    //   - "while it is live"：并发或残留导致同一 id 已成 live 会话。
    // 两种都改为 resume 复用既有会话（历史、GUI 会话都在），而不是报错退出，
    // 也不是新建第二个。这样重启后同一房间回到同一会话，GUI 不再堆积多个"会话"。
    const sessionId = SessionId(`matrix-${localpartOf(this.userId)}-${stableHash(roomId)}`)
    let handle: AgentHandle
    try {
      handle = await this.ctx.agents.create({
        sessionId,
        meta: { cwd: process.cwd(), agentPreset: this.config.agentPreset ?? 'standard' },
        agentOptions: this.agentOptions,
      })
    } catch (error) {
      const reason = messageOf(error)
      if (!reason.includes('already exists') && !reason.includes('while it is live')) throw error
      this.ctx.logger.warn('[dsh-matrix] session %s already live/exist (%s); resuming instead of recreating', sessionId, reason)
      handle = await this.ctx.agents.resume({
        resumeSessionId: sessionId,
        agentOptions: this.agentOptions,
      })
    }
    this.roomAgents.set(roomId, handle)
    this.state.setRoomSession(roomId, handle.agent.id)
    // 会话标题 = Matrix 房间名（pin 住，自动标题不再覆盖）。
    void this.nameSessionFromRoom(roomId, handle.agent)
    return handle.agent
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
  }

  /** ---------- 入站消息 ---------- */

  private async handleMessage(message: InboundMessage): Promise<void> {
    try {
      // 入站归一化：把文本与媒体占位合并成一条 message.text。
      // 媒体本轮仅占位（如「[图片: xxx.png]」），内容解析为后续扩展点；
      // 不静默丢弃，避免用户发图后 agent 无响应造成的困惑。
      const text = (message.text + describeMedia(message.media)).trim()
      if (text === '') return

      // 剥离 @提及 前缀后再判定命令/审批词（如 '@ai-dev /auth list'）。
      const stripped = text.replace(/@[a-z0-9._-]+(?::[a-z0-9._-]+)?/gi, '').trim()

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

      if (!(await this.shouldRespond(message))) return

      if (stripped.startsWith('/')) {
        this.flushMerge(message.roomId)
        await this.handleCommand(message.roomId, message.sender, stripped)
        return
      }

      // 合并窗口：'..' 继续、'!!' 立即提交、裸文本等待 mergeTimeoutSecs。
      let rest = text
      let flush = false
      if (text.endsWith('!!')) {
        rest = text.slice(0, -2).trim()
        flush = true
      } else if (text.endsWith('..')) {
        rest = text.slice(0, -2).trim()
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
  private async deliver(roomId: string, text: string, sender?: string): Promise<void> {
    const agent = await this.getRoomAgent(roomId)
    agent.followup(createUserMessage({
      content: [{ type: 'text', text }],
      source: {
        kind: 'user',
        ...(sender !== undefined ? { sender } : {}),
      },
    }))
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
        if (verbosity !== 'process') break
        const retry = formatRetry({
          retry: data.retry ?? 1,
          maxRetries: data.maxRetries,
          delayMs: data.delayMs ?? 0,
          failure: data.failure,
        })
        void this.safeSend(roomId, retry, undefined)
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
