/**
 * Matrix→harness 桥接层：per-room agent 会话、入站消息注入、出站投递、
 * 审批推送与聊天应答、命令与合并窗口。只依赖 Channel 接口，与具体协议无关。
 *
 * 在原版基础上新增：Owner 授权记忆（L1 记忆授权 / L2 房间确认 / L3 红线强制）。
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
import type { Config } from './config.js'
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
  '/auth list — 列出本房间的记忆授权',
  '/auth revoke <tool> — 吊销某工具的记忆授权',
  '/auth revoke-all — 吊销本房间全部记忆授权',
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

export interface MatrixBridgeOptions extends Config {
  readonly accessToken: string
  /** 测试接缝：替换通道层的 fetch 与 sleep。 */
  readonly fetchFn?: typeof fetch
  readonly sleep?: (ms: number) => Promise<void>
}

export class MatrixBridge {
  private readonly ctx: Context
  private readonly config: MatrixBridgeOptions
  private readonly state: BridgeState
  private readonly authStore: AuthStore
  private readonly channel: Channel
  private readonly roomAgents = new Map<string, AgentHandle>()
  private readonly mergeBuffers = new Map<string, MergeBuffer>()
  private readonly pendingApprovals = new Map<string, PendingApproval[]>()
  private disposeEvents: (() => void) | undefined
  private disposeApproval: (() => void) | undefined
  private stopped = false

  constructor(ctx: Context, config: MatrixBridgeOptions) {
    this.ctx = ctx
    this.config = config
    this.state = new BridgeState(join(config.stateDir, 'state.json'))
    this.authStore = new AuthStore(config.stateDir, config.authStoreFile ?? 'auth-store.json')
    this.channel = new MatrixChannel({
      homeserverUrl: config.homeserverUrl,
      accessToken: config.accessToken,
      userId: config.userId,
      state: this.state,
      onMessage: (message) => {
        void this.handleMessage(message)
      },
      isAllowed: (sender) => this.authorized(sender),
      logger: ctx.logger,
      ...(config.fetchFn === undefined ? {} : { fetchFn: config.fetchFn }),
      ...(config.sleep === undefined ? {} : { sleep: config.sleep }),
    })
  }

  async start(): Promise<void> {
    if (this.disposeEvents !== undefined) return
    await this.state.load()
    await this.authStore.load()
    this.disposeEvents = this.ctx.on('session/event', (session, event) => {
      this.handleSessionEvent(session, event)
    })
    this.ctx.inject(['approval'], (approvalCtx) => {
      this.disposeApproval = approvalCtx.on('approval/request', async (req, next) => {
        const roomId = this.roomForSession(req.agent.id)
        if (roomId === undefined) return next()
        return this.handleApproval(roomId, req)
      })
    })
    await this.connectWithRetry()
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.disposeEvents !== undefined) {
      this.disposeEvents()
      this.disposeEvents = undefined
    }
    this.disposeApproval?.()
    this.disposeApproval = undefined
    for (const roomId of this.roomAgents.keys()) {
      const buffer = this.mergeBuffers.get(roomId)
      if (buffer !== undefined) {
        if (buffer.timer !== undefined) clearTimeout(buffer.timer)
        this.mergeBuffers.delete(roomId)
      }
    }
    const handles = [...this.roomAgents.values()]
    this.roomAgents.clear()
    await Promise.allSettled(handles.map((handle) => handle.dispose()))
    await this.channel.stop()
    await this.state.dispose()
    await this.authStore.save().catch(() => {})
  }

  private async connectWithRetry(): Promise<void> {
    let attempt = 0
    for (;;) {
      if (this.stopped) return
      try {
        await this.channel.start()
        this.ctx.logger.info('[dsh-matrix] connected as %s', this.config.userId)
        return
      } catch (error) {
        attempt += 1
        this.ctx.logger.warn('[dsh-matrix] sync failed (attempt %d): %s', attempt, messageOf(error))
        await new Promise((resolve) => setTimeout(resolve, Math.min(1000 * attempt, 10000)))
      }
    }
  }

  private authorized(sender: string): boolean {
    if (this.config.allowAllUsers) return true
    return this.config.allowedUserIds.includes(sender)
  }

  private agentOptions(): AgentOptions {
    return { provider: this.config.provider, model: this.config.model }
  }

  private roomForSession(sessionId: string): string | undefined {
    return this.state.sessionRoom(sessionId)
  }

  /** 红线工具判定：即使有记忆授权也必须每次房间确认。 */
  private isRedline(toolName: string): boolean {
    return (this.config.redlineTools ?? []).includes(toolName)
  }

  /**
   * 审批决策入口：
   * - L3 红线：永远进房间确认，批准不入库；
   * - L1 记忆授权：静默放行；
   * - L2 其余：进房间确认；批准后写入记忆授权。
   */
  private handleApproval(roomId: string, request: ApprovalRequest): Promise<ApprovalOutcome> {
    const grantable = !this.isRedline(request.toolName)
    if (grantable && this.authStore.isStandingAuthorized(this.config.userId, roomId, request.toolName, this.config.redlineTools ?? [])) {
      this.ctx.logger.info('[dsh-matrix] standing auth for `%s` in %s', request.toolName, roomId)
      return Promise.resolve('allowed-once')
    }
    return this.askRoom(roomId, request, grantable)
  }

  /**
   * 房间的当前 agent：内存缓存 → 持久绑定 resume → 新建。
   */
  private async getRoomAgent(roomId: string): Promise<Agent> {
    const existing = this.roomAgents.get(roomId)
    if (existing !== undefined) return existing.agent
    const binding = this.state.roomSession(roomId)
    if (binding !== undefined) {
      try {
        const handle = await this.ctx.agents.resume({
          resumeSessionId: SessionId(binding),
          agentOptions: this.agentOptions(),
        })
        this.roomAgents.set(roomId, handle)
        return handle.agent
      } catch (error) {
        this.ctx.logger.warn('[dsh-matrix] resume %s failed (%s); starting a fresh session', binding, messageOf(error))
      }
    }
    const sessionId = SessionId(`matrix-${randomUUID()}`)
    const handle = await this.ctx.agents.create({
      sessionId,
      meta: { cwd: process.cwd() },
      agentOptions: this.agentOptions(),
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

  private async handleMessage(message: InboundMessage): Promise<void> {
    try {
      const text = message.text.trim()
      if (text === '') return
      // 优先应答审批：白名单校验已在通道层完成。
      const first = this.pendingApprovals.get(message.roomId)?.[0]
      if (first !== undefined) {
        if (APPROVE_RE.test(text)) {
          if (first.grantOnApprove) {
            this.authStore.grant(this.config.userId, this.config.userId, message.roomId, first.request.toolName)
            void this.authStore.save().catch((error: unknown) => {
              this.ctx.logger.error('[dsh-matrix] auth save failed: %s', messageOf(error))
            })
          }
          first.settle('allowed-once')
          return
        }
        if (DENY_RE.test(text)) {
          first.settle('rejected')
          return
        }
      }
      if (text.startsWith('/')) {
        this.flushMerge(message.roomId)
        await this.handleCommand(message.roomId, text)
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

  private async handleCommand(roomId: string, raw: string): Promise<void> {
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
        if (handle === undefined) await reply('本房间还没有绑定会话。')
        else await reply(`当前会话：\`${handle.agent.id}\`（状态 ${handle.agent.status}）`)
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
            agentOptions: this.agentOptions(),
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
        const spaceIdx = arg.indexOf(' ')
        const subCmd = spaceIdx < 0 ? arg : arg.slice(0, spaceIdx)
        const toolName = spaceIdx < 0 ? '' : arg.slice(spaceIdx + 1).trim()
        switch (subCmd) {
          case 'list': {
            const record = this.authStore.getRecord(this.config.userId, roomId)
            if (record === undefined) {
              await reply('📋 本房间暂无记忆授权记录。')
              break
            }
            await reply(
              `📋 本房间记忆授权\n` +
              `工具：${record.allowedTools.length > 0 ? record.allowedTools.map((t) => `\`${t}\``).join('、') : '无'}\n` +
              `最后确认：${new Date(record.lastConfirmedAt).toLocaleString('zh-CN')}`,
            )
            break
          }
          case 'revoke': {
            if (toolName === '') {
              await reply('用法：`/auth revoke <tool>`')
              break
            }
            const ok = this.authStore.revoke(this.config.userId, roomId, toolName)
            await this.authStore.save().catch(() => {})
            await reply(ok ? `✅ 已吊销 \`${toolName}\` 的记忆授权。` : `⚠️ \`${toolName}\` 本来就没有授权。`)
            break
          }
          case 'revoke-all': {
            const ok = this.authStore.revoke(this.config.userId, roomId)
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

  private handleSessionEvent(session: Session, event: SessionEvent): void {
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

  /** 发送；HTML 失败时回退纯文本（与 telegram 桥同款策略）。 */
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

  private askRoom(roomId: string, request: ApprovalRequest, grantOnApprove: boolean): Promise<ApprovalOutcome> {
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
          if (queue.length === 0) this.pendingApprovals.delete(roomId)
        }
        resolve(outcome)
      }
      const queue = this.pendingApprovals.get(roomId) ?? []
      queue.push({ request, grantOnApprove, settle })
      this.pendingApprovals.set(roomId, queue)
      request.signal?.addEventListener('abort', () => settle('cancelled'), { once: true })

      const redlineNote = this.isRedline(request.toolName) ? ' ⛔️红线工具，每次都需确认' : ''
      const text =
        `⚠️ [审批请求${redlineNote}] 工具 \`${request.toolName}\` 需要批准` +
        `${request.reason ? `，原因：${request.reason}` : ''}。请在 ${this.config.approvalTimeoutSecs} 秒内回复「批准」或「拒绝」。`
      void this.safeSend(roomId, text, markdownToHtml(text))
    })
  }

  private settleAll(roomId: string, outcome: ApprovalOutcome): void {
    const queue = this.pendingApprovals.get(roomId)
    if (queue === undefined) return
    this.pendingApprovals.delete(roomId)
    for (const entry of queue) entry.settle(outcome)
  }
}
