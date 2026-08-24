/**
 * Matrix→harness 桥接层：多账号支持（主账号 + N 个数字分身）、per-room & per-account
 * agent 会话、入站消息注入（@提及路由 / 合并窗口）、出站投递、审批推送与聊天应答、
 * Owner 授权记忆（L1 静默 / L2 房间确认 / L3 红线强制）。
 *
 * 每个矩阵账号一个 AccountBridge：独立 sync 循环、独立状态文件、独立会话绑定。
 *
 * @module dsh-matrix/bridge
 */

import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle, AgentOptions } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { TextBlock } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import type { Config, DigitalTwinAccount } from './config.js'
import { chunkText, markdownToHtml } from './format.js'
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
  timer?: NodeJS.Timeout
}

interface PendingApproval {
  readonly request: ApprovalRequest
  /** 批准后是否写入记忆授权（红线工具为 false）。 */
  readonly grantOnApprove: boolean
  readonly settle: (outcome: ApprovalOutcome) => void
}

/** 从 assistant 消息中提取可见文本块（跳过 reasoning）。 */
function assistantText(event: Extract<SessionEvent, { type: 'assistant/message' }>): string | undefined {
  const blocks = event.data.message.content.filter((block): block is TextBlock => block.type === 'text')
  return blocks.length === 0 ? undefined : blocks.map((block) => block.text).join('')
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function localpartOf(mxid: string): string {
  const at = mxid.indexOf(':')
  return at > 0 ? mxid.slice(1, at) : mxid.slice(1)
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
  private readonly mergeBuffers = new Map<string, MergeBuffer>()
  private readonly pendingApprovals = new Map<string, PendingApproval[]>()

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
    // 主账号默认响应全部消息（个人助手模式）；分身默认仅 @提及 或私聊。
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
    if (!this.isMain && sender === this.owner) return true
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

  private async getRoomAgent(roomId: string): Promise<Agent> {
    const existing = this.roomAgents.get(roomId)
    if (existing !== undefined) return existing.agent

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
        this.ctx.logger.warn('[dsh-matrix] resume %s failed (%s); starting fresh', binding, messageOf(error))
      }
    }

    const sessionId = SessionId(`matrix-${localpartOf(this.userId)}-${randomUUID()}`)
    const handle = await this.ctx.agents.create({
      sessionId,
      meta: { cwd: process.cwd() },
      agentOptions: this.agentOptions,
    })
    this.roomAgents.set(roomId, handle)
    this.state.setRoomSession(roomId, handle.agent.id)
    return handle.agent
  }

  private async releaseRoom(roomId: string): Promise<void> {
    const handle = this.roomAgents.get(roomId)
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
  }

  /** ---------- 入站消息 ---------- */

  private async handleMessage(message: InboundMessage): Promise<void> {
    try {
      const text = message.text.trim()
      if (text === '') return

      // 剥离 @提及 前缀后再判定命令/审批词（如 '@ai-dev /auth list'）。
      const stripped = text.replace(/@[a-z0-9._-]+(?::[a-z0-9._-]+)?/gi, '').trim()

      // 审批应答最优先（不受 @提及/私聊 路由门控限制）：
      // 非主账号时仅 Owner 可应答；非 Owner 的应答直接忽略。
      const queue = this.pendingApprovals.get(message.roomId)
      const first = queue?.[0]
      const isApprovalWord = APPROVE_RE.test(stripped) || DENY_RE.test(stripped)
      if (first !== undefined && isApprovalWord) {
        if (!this.isMain && message.sender !== this.owner) {
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
      const buffer = this.mergeBuffers.get(message.roomId) ?? { parts: [] }
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
    void this.deliver(roomId, text)
  }

  private async deliver(roomId: string, text: string): Promise<void> {
    const agent = await this.getRoomAgent(roomId)
    agent.followup(createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', plugin: 'dsh-matrix' },
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
            if (!this.isMain && sender !== this.owner) {
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
            if (!this.isMain && sender !== this.owner) {
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
    switch (event.type) {
      case 'turn/start':
        void this.channel.sendTyping(roomId, true).catch((error: unknown) => {
          this.ctx.logger.warn('[dsh-matrix] typing failed: %s', messageOf(error))
        })
        break
      case 'turn/end':
        void this.channel.sendTyping(roomId, false).catch(() => {})
        break
      case 'assistant/message': {
        const text = assistantText(event)
        if (text !== undefined) void this.deliverText(roomId, text)
        break
      }
      default:
        break
    }
  }

  private async deliverText(roomId: string, text: string): Promise<void> {
    for (const chunk of chunkText(text, this.config.chunkMaxChars)) {
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

    // 1. 挂载主账号（保持 state.json 名字，向后兼容）
    const mainAccount: DigitalTwinAccount = {
      userId: config.userId,
      accessToken: config.accessToken,
      tokenEnv: '',
      owner: '',
      role: 'main',
      respondToAll: true,
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
