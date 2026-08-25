/**
 * Matrix 通道层：零依赖的 client-server API 客户端（global fetch + /sync 长轮询）。
 * 桥接层（bridge.ts）只依赖 `Channel`，换其它 IM 时替换本文件即可。
 *
 * 参照 telegram 插件自写 TelegramClient 的做法：协议面很小（sync / send /
 * typing / join），不值得为一个 bot 引入带原生 crypto 依赖的 SDK——
 * matrix-js-sdk 的 Node ESM 导入本身是坏的（oauth 目录导入），
 * matrix-bot-sdk 的 E2EE 原生二进制靠被 pnpm 默认拦截的 postinstall 下载。
 *
 * 第一版只支持非加密房间：`m.room.encrypted` 事件会提示改用非加密房间。
 * E2EE（Rust crypto + 设备验证）是二期工作。
 */

import { randomUUID } from 'node:crypto'
import type { BridgeState } from './store.js'

export interface InboundMessage {
  readonly roomId: string
  readonly sender: string
  readonly text: string
  readonly eventId: string
}

export interface ChannelOptions {
  readonly homeserverUrl: string
  readonly accessToken: string
  readonly userId: string
  readonly state: BridgeState
  readonly onMessage?: (message: InboundMessage) => void
  readonly isAllowed?: (sender: string) => boolean
  readonly logger?: {
    warn: (format: string, ...args: unknown[]) => void
    error: (format: string, ...args: unknown[]) => void
    info: (format: string, ...args: unknown[]) => void
  }
  /** 测试接缝。 */
  readonly fetchFn?: typeof fetch
  readonly sleep?: (ms: number) => Promise<void>
}

export interface Channel {
  start(): Promise<void>
  stop(): Promise<void>
  sendText(roomId: string, plain: string, html?: string): Promise<void>
  sendTyping(roomId: string, active: boolean): Promise<void>
  /** 判断是否为私聊房间（2 人房间）。 */
  isDirectRoom?(roomId: string): Promise<boolean>
  /** 读取房间名（m.room.name state）。 */
  getRoomName?(roomId: string): Promise<string | undefined>
}

/** /sync 响应中我们关心的最小结构。 */
interface SyncResponse {
  next_batch?: string
  rooms?: {
    join?: Record<string, { timeline?: { events?: MatrixEventJson[] } }>
    invite?: Record<string, unknown>
  }
}

/** 时间线事件的最小结构。 */
interface MatrixEventJson {
  type?: string
  sender?: string
  event_id?: string
  content?: { msgtype?: string; body?: string }
}

const SYNC_TIMEOUT_MS = 30_000
const SYNC_FILTER = JSON.stringify({ room: { timeline: { limit: 10 } } })
const BASE_BACKOFF_MS = 1000
const DM_CACHE_TTL_MS = 60_000
const NAME_CACHE_TTL_MS = 5 * 60_000

export class MatrixChannel implements Channel {
  private readonly baseUrl: string
  private readonly fetchFn: typeof fetch
  private readonly sleepFn: (ms: number) => Promise<void>
  private readonly warnedEncrypted = new Set<string>()
  private readonly dmCache = new Map<string, { isDm: boolean; at: number }>()
  private readonly nameCache = new Map<string, { name?: string; at: number }>()
  private stopped = false
  private loop: Promise<void> | undefined
  private lifecycleAbort: AbortController | undefined

  constructor(private readonly options: ChannelOptions) {
    this.baseUrl = options.homeserverUrl.replace(/\/+$/, '')
    this.fetchFn = options.fetchFn ?? fetch
    this.sleepFn = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  }

  /** 完成首次成功同步后进入后台长轮询循环；首次失败则抛出。 */
  async start(): Promise<void> {
    if (this.loop !== undefined) return
    this.stopped = false
    // 生命周期级 controller：abort 是粘性的，stop() 与后续 sync 之间不存在竞态窗口。
    this.lifecycleAbort = new AbortController()
    await this.syncOnce()
    this.loop = this.syncLoop()
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.lifecycleAbort?.abort()
    await this.loop
    this.loop = undefined
  }

  private async syncLoop(): Promise<void> {
    let backoff = BASE_BACKOFF_MS
    while (!this.stopped) {
      try {
        await this.syncOnce()
        backoff = BASE_BACKOFF_MS
      } catch (error) {
        if (this.stopped) return
        this.options.logger?.warn('[dsh-matrix] sync failed: %s', messageOf(error))
        await this.sleepFn(backoff)
        backoff = Math.min(backoff * 2, 15_000)
      }
    }
  }

  private async syncOnce(): Promise<void> {
    if (this.stopped) return
    const signal = AbortSignal.any([this.lifecycleAbort!.signal, AbortSignal.timeout(SYNC_TIMEOUT_MS + 20_000)])
    const url = new URL(`${this.baseUrl}/_matrix/client/v3/sync`)
    url.searchParams.set('timeout', String(SYNC_TIMEOUT_MS))
    url.searchParams.set('filter', SYNC_FILTER)
    const since = this.options.state.syncToken
    if (since !== undefined) url.searchParams.set('since', since)
    const response = await this.fetchFn(url, {
      headers: { Authorization: `Bearer ${this.options.accessToken}` },
      signal,
    })
    if (!response.ok) throw new Error(`sync HTTP ${response.status}`)
    const data = (await response.json()) as SyncResponse
    if (typeof data.next_batch === 'string') this.options.state.syncToken = data.next_batch
    this.processRooms(data.rooms)
  }

  private processRooms(rooms: SyncResponse['rooms']): void {
    if (rooms === undefined) return
    // 邀请自动加入。
    if (rooms.invite !== undefined) {
      for (const roomId of Object.keys(rooms.invite)) {
        void this.joinRoom(roomId).catch((error: unknown) => {
          this.options.logger?.warn('[dsh-matrix] joinRoom %s failed: %s', roomId, messageOf(error))
        })
      }
    }
    if (rooms.join === undefined) return
    for (const [roomId, room] of Object.entries(rooms.join)) {
      const events = room.timeline?.events
      if (events === undefined) continue
      for (const event of events) this.onTimelineEvent(roomId, event)
    }
  }

  private onTimelineEvent(roomId: string, event: MatrixEventJson): void {
    if (this.stopped) return
    if (event.type === 'm.room.encrypted') {
      if (!this.warnedEncrypted.has(roomId)) {
        this.warnedEncrypted.add(roomId)
        this.options.logger?.warn(
          '[dsh-matrix] room %s is encrypted; this bridge cannot decrypt yet — use an unencrypted room or DM',
          roomId,
        )
      }
      return
    }
    if (event.type !== 'm.room.message') return
    const sender = event.sender
    if (sender === undefined || sender === this.options.userId) return
    const content = event.content
    if (content === undefined || content.msgtype !== 'm.text' || typeof content.body !== 'string') return
    const eventId = event.event_id
    if (eventId === undefined || this.options.state.hasSeen(eventId)) return
    // 去重先于分发：无论是否授权都记录已处理，避免每次 sync 重放。
    this.options.state.markSeen(eventId)
    if (!(this.options.isAllowed?.(sender) ?? true)) return
    this.options.onMessage?.({ roomId, sender, text: content.body, eventId })
  }

  async sendText(roomId: string, plain: string, html?: string): Promise<void> {
    const content: Record<string, unknown> = { msgtype: 'm.text', body: plain }
    if (html !== undefined) {
      content.format = 'org.matrix.custom.html'
      content.formatted_body = html
    }
    await this.sendEvent(roomId, 'm.room.message', content)
  }

  async sendTyping(roomId: string, active: boolean): Promise<void> {
    const body: Record<string, unknown> = { typing: active }
    if (active) body.timeout = 15_000
    const url = `${this.baseUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/typing/${encodeURIComponent(this.options.userId)}`
    const response = await this.fetchFn(url, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${this.options.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })
    if (!response.ok) throw new Error(`typing HTTP ${response.status}`)
  }

  /** 判断房间是否为私聊（≤2 人）。带 TTL 缓存，失败时保守返回 false（按群聊处理）。 */
  async isDirectRoom(roomId: string): Promise<boolean> {
    const cached = this.dmCache.get(roomId)
    if (cached !== undefined && Date.now() - cached.at < DM_CACHE_TTL_MS) return cached.isDm
    try {
      const url = `${this.baseUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/joined_members`
      const response = await this.fetchFn(url, {
        headers: { Authorization: `Bearer ${this.options.accessToken}` },
      })
      if (!response.ok) throw new Error(`joined_members HTTP ${response.status}`)
      const data = (await response.json()) as { joined?: Record<string, unknown> }
      const count = data.joined === undefined ? 0 : Object.keys(data.joined).length
      const isDm = count > 0 && count <= 2
      this.dmCache.set(roomId, { isDm, at: Date.now() })
      return isDm
    } catch {
      return false
    }
  }

  /** 读取房间名（m.room.name state）。带 TTL 缓存；无名字或失败返回 undefined。 */
  async getRoomName(roomId: string): Promise<string | undefined> {
    const cached = this.nameCache.get(roomId)
    if (cached !== undefined && Date.now() - cached.at < NAME_CACHE_TTL_MS) return cached.name
    try {
      const url = `${this.baseUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.name`
      const response = await this.fetchFn(url, {
        headers: { Authorization: `Bearer ${this.options.accessToken}` },
      })
      if (!response.ok) return undefined
      const data = (await response.json()) as { name?: string }
      const name = typeof data.name === 'string' && data.name.trim() !== '' ? data.name.trim() : undefined
      this.nameCache.set(roomId, { name, at: Date.now() })
      return name
    } catch {
      return undefined
    }
  }

  private async joinRoom(roomId: string): Promise<void> {
    const url = `${this.baseUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/join`
    const response = await this.fetchFn(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.options.accessToken}` },
      body: '{}',
    })
    if (!response.ok) throw new Error(`join HTTP ${response.status}`)
  }

  /** 发送事件；txnId 让 homeserver 幂等去重，重试安全。 */
  private async sendEvent(roomId: string, type: string, content: Record<string, unknown>): Promise<void> {
    const txnId = `${Date.now()}-${randomUUID()}`
    const url = `${this.baseUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/${type}/${txnId}`
    const response = await this.fetchFn(url, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${this.options.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(content),
    })
    if (!response.ok) throw new Error(`send HTTP ${response.status}`)
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
