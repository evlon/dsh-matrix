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
import { getDiag } from './diag.js'

/**
 * Matrix 媒体附件的归一化结构（入站扩展点）。
 * 当前本轮只识别并保留结构 + 生成占位文本，不做 OCR/多模态解析；
 * 后续图片处理应在此结构之上扩展（见 docs/matrix-bridge-message-flow.md）。
 */
export interface MediaBlock {
  readonly msgtype: string
  readonly mimetype?: string
  readonly url?: string
  readonly mxc?: string
  readonly filename?: string
  readonly size?: number
  readonly body: string
}

export interface InboundMessage {
  readonly roomId: string
  readonly sender: string
  /** 文本正文（m.text / m.notice 等）；纯媒体消息时为空串。 */
  readonly text: string
  /** 非文字附件（图片/文件/音视频/位置）；本轮仅占位，不解析内容。 */
  readonly media: MediaBlock[]
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

/** 群成员信息（joined_members 投影）。 */
export interface MatrixMember {
  readonly userId: string
  readonly displayName?: string
  readonly avatarUrl?: string
}

/** 用户资料（profile API 投影）。 */
export interface MatrixUserInfo {
  readonly userId: string
  readonly displayName?: string
  readonly avatarUrl?: string
}

/** 房间消息投影（/messages API 精简投影）。 */
export interface MatrixRoomMessage {
  readonly eventId: string
  readonly sender: string
  readonly body: string
  readonly timestamp: number
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
  /** 房间当前成员数（joined_members）。仅用于群聊上下文标签，绝不全量注入消息。 */
  getRoomMemberCount?(roomId: string): Promise<number | undefined>
  /** 房间当前成员列表（joined_members）。供 agent 工具按需调用。 */
  getRoomMembers?(roomId: string): Promise<MatrixMember[] | undefined>
  /** 用户资料（displayname/avatar_url）。供 agent 工具按需调用。 */
  getUserInfo?(userId: string): Promise<MatrixUserInfo | undefined>
  /** 房间最近消息（/messages API，正序）。供 agent 工具按需调用。 */
  getRecentMessages?(roomId: string, limit?: number): Promise<MatrixRoomMessage[]>
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
  content?: {
    msgtype?: string
    body?: string
    url?: string
    mimetype?: string
    /** m.image/m.file/m.audio/m.video 等携带的元信息。 */
    info?: { mimetype?: string; size?: number }
    /** m.location 的地理坐标。 */
    geo_uri?: string
  }
}

const SYNC_TIMEOUT_MS = 30_000
const SYNC_FILTER = JSON.stringify({ room: { timeline: { limit: 10 } } })
const BASE_BACKOFF_MS = 1000
const DM_CACHE_TTL_MS = 60_000
const NAME_CACHE_TTL_MS = 5 * 60_000
const COUNT_CACHE_TTL_MS = 5 * 60_000
const MEMBERS_CACHE_TTL_MS = 5 * 60_000
const USER_INFO_CACHE_TTL_MS = 10 * 60_000

export class MatrixChannel implements Channel {
  private readonly baseUrl: string
  private readonly fetchFn: typeof fetch
  private readonly sleepFn: (ms: number) => Promise<void>
  private readonly diag = getDiag('dsh-matrix')
  private readonly warnedEncrypted = new Set<string>()
  private readonly dmCache = new Map<string, { isDm: boolean; at: number }>()
  private readonly nameCache = new Map<string, { name?: string; at: number }>()
  private readonly countCache = new Map<string, { count: number | undefined; at: number }>()
  private readonly membersCache = new Map<string, { value: MatrixMember[]; at: number }>()
  private readonly userInfoCache = new Map<string, { value: MatrixUserInfo; at: number }>()
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
    if (content === undefined || typeof content.body !== 'string') return
    const msgtype = content.msgtype ?? 'm.text'
    const eventId = event.event_id
    if (eventId === undefined || this.options.state.hasSeen(eventId)) return
    // 去重先于分发：无论是否授权都记录已处理，避免每次 sync 重放。
    this.options.state.markSeen(eventId)
    if (!(this.options.isAllowed?.(sender) ?? true)) return

    // 非文字消息（图片/文件/音视频/位置）：归一成 media，text 留空。
    // 本轮只识别结构、生成占位文本；内容解析（OCR/多模态）为后续扩展点。
    const MEDIA_MSGTYPES = new Set(['m.image', 'm.file', 'm.audio', 'm.video', 'm.location'])
    let text = content.body
    let media: MediaBlock[] = []
    if (MEDIA_MSGTYPES.has(msgtype)) {
      media = [{
        msgtype,
        body: content.body,
        mimetype: content.mimetype ?? content.info?.mimetype,
        url: content.url,
        size: content.info?.size,
        ...(msgtype === 'm.location' ? { mxc: undefined } : {}),
      }]
      // 文字型 msgtype（m.text/m.notice）仍作为 text 透传；媒体消息 text 置空。
      if (msgtype === 'm.text' || msgtype === 'm.notice') {
        // 保持 text
      } else {
        text = ''
      }
    }
    this.options.onMessage?.({ roomId, sender, text, media, eventId })
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
      this.diag.log(`[dsh-matrix:matrix] GET ${url.replace(this.baseUrl, '')} room=${roomId}`)
      const response = await this.fetchFn(url, {
        headers: { Authorization: `Bearer ${this.options.accessToken}` },
      })
      if (!response.ok) {
        this.diag.log(`[dsh-matrix:matrix]   <- HTTP ${response.status} ${response.statusText}`)
        return undefined
      }
      const data = (await response.json()) as { name?: string }
      const name = typeof data.name === 'string' && data.name.trim() !== '' ? data.name.trim() : undefined
      this.nameCache.set(roomId, { name, at: Date.now() })
      return name
    } catch (err) {
      this.diag.log(`[dsh-matrix:matrix]   !! getRoomName room=${roomId} err=${err instanceof Error ? err.message : String(err)}`)
      return undefined
    }
  }

  /** 房间当前成员数（joined_members）。带 TTL 缓存；仅用于群聊上下文标签，失败返回 undefined。 */
  async getRoomMemberCount(roomId: string): Promise<number | undefined> {
    const cached = this.countCache.get(roomId)
    if (cached !== undefined && Date.now() - cached.at < COUNT_CACHE_TTL_MS) return cached.count
    try {
      const url = `${this.baseUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/joined_members`
      this.diag.log(`[dsh-matrix:matrix] GET .../joined_members room=${roomId} (count)`)
      const response = await this.fetchFn(url, {
        headers: { Authorization: `Bearer ${this.options.accessToken}` },
      })
      if (!response.ok) {
        this.diag.log(`[dsh-matrix:matrix]   <- HTTP ${response.status}`)
        return undefined
      }
      const data = (await response.json()) as { joined?: Record<string, unknown> }
      const count = data.joined === undefined ? undefined : Object.keys(data.joined).length
      this.countCache.set(roomId, { count, at: Date.now() })
      return count
    } catch (err) {
      this.diag.log(`[dsh-matrix:matrix]   !! getRoomMemberCount room=${roomId} err=${err instanceof Error ? err.message : String(err)}`)
      return undefined
    }
  }

  /** 房间当前成员列表（joined_members）。带 TTL 缓存，供 agent 工具按需调用。 */
  async getRoomMembers(roomId: string): Promise<MatrixMember[] | undefined> {
    const cached = this.membersCache.get(roomId)
    if (cached !== undefined && Date.now() - cached.at < MEMBERS_CACHE_TTL_MS) return cached.value
    try {
      const url = `${this.baseUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/joined_members`
      this.diag.log(`[dsh-matrix:matrix] GET .../joined_members room=${roomId} (members)`)
      const response = await this.fetchFn(url, {
        headers: { Authorization: `Bearer ${this.options.accessToken}` },
      })
      if (!response.ok) {
        this.diag.log(`[dsh-matrix:matrix]   <- HTTP ${response.status}`)
        return undefined
      }
      // joined 的键就是完整 user id（@user:server），值含 display_name/avatar_url。
      const data = (await response.json()) as {
        joined?: Record<string, { display_name?: string; avatar_url?: string }>
      }
      const joined = data.joined ?? {}
      const members: MatrixMember[] = Object.entries(joined).map(([userId, info]) => ({
        userId,
        ...(typeof info?.display_name === 'string' && info.display_name !== '' ? { displayName: info.display_name } : {}),
        ...(typeof info?.avatar_url === 'string' && info.avatar_url !== '' ? { avatarUrl: info.avatar_url } : {}),
      }))
      this.membersCache.set(roomId, { value: members, at: Date.now() })
      this.diag.log(`[dsh-matrix:matrix]   <- ${members.length} members`)
      return members
    } catch (err) {
      this.diag.log(`[dsh-matrix:matrix]   !! getRoomMembers room=${roomId} err=${err instanceof Error ? err.message : String(err)}`)
      return undefined
    }
  }

  /** 用户资料（profile API）。带 TTL 缓存，供 agent 工具按需调用；失败返回 undefined。 */
  async getUserInfo(userId: string): Promise<MatrixUserInfo | undefined> {
    const cached = this.userInfoCache.get(userId)
    if (cached !== undefined && Date.now() - cached.at < USER_INFO_CACHE_TTL_MS) return cached.value
    try {
      const url = `${this.baseUrl}/_matrix/client/v3/profile/${encodeURIComponent(userId)}`
      this.diag.log(`[dsh-matrix:matrix] GET .../profile/${userId}`)
      const response = await this.fetchFn(url, {
        headers: { Authorization: `Bearer ${this.options.accessToken}` },
      })
      if (!response.ok) {
        this.diag.log(`[dsh-matrix:matrix]   <- HTTP ${response.status}`)
        return undefined
      }
      const data = (await response.json()) as { displayname?: string; avatar_url?: string }
      const info: MatrixUserInfo = {
        userId,
        ...(typeof data.displayname === 'string' && data.displayname !== '' ? { displayName: data.displayname } : {}),
        ...(typeof data.avatar_url === 'string' && data.avatar_url !== '' ? { avatarUrl: data.avatar_url } : {}),
      }
      this.userInfoCache.set(userId, { value: info, at: Date.now() })
      return info
    } catch (err) {
      this.diag.log(`[dsh-matrix:matrix]   !! getUserInfo user=${userId} err=${err instanceof Error ? err.message : String(err)}`)
      return undefined
    }
  }

  /** 房间最近消息（/messages API，按时间正序返回）。默认 20 条，最多 100 条。 */
  async getRecentMessages(roomId: string, limit = 20): Promise<MatrixRoomMessage[]> {
    try {
      const url = new URL(`${this.baseUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages`)
      url.searchParams.set('dir', 'b')
      url.searchParams.set('limit', String(Math.max(1, Math.min(limit, 100))))
      this.diag.log(`[dsh-matrix:matrix] GET .../messages room=${roomId} limit=${limit}`)
      const response = await this.fetchFn(url, {
        headers: { Authorization: `Bearer ${this.options.accessToken}` },
      })
      if (!response.ok) {
        this.diag.log(`[dsh-matrix:matrix]   <- HTTP ${response.status}`)
        return []
      }
      const data = (await response.json()) as {
        chunk?: Array<{
          event_id?: string
          sender?: string
          origin_server_ts?: number
          type?: string
          content?: { body?: string; msgtype?: string }
        }>
      }
      const chunk = data.chunk ?? []
      const messages: MatrixRoomMessage[] = []
      // /messages?dir=b 返回反序（新→旧），reverse 后为正序（旧→新）。
      for (const event of chunk.reverse()) {
        if (event.type !== 'm.room.message') continue
        if (event.sender === this.options.userId) continue
        const body = event.content?.body
        if (typeof body !== 'string' || body.trim() === '') continue
        messages.push({
          eventId: event.event_id ?? '',
          sender: event.sender ?? '',
          body: body.trim(),
          timestamp: event.origin_server_ts ?? 0,
        })
      }
      this.diag.log(`[dsh-matrix:matrix]   <- chunk=${chunk.length} filtered=${messages.length}`)
      return messages
    } catch (err) {
      this.diag.log(`[dsh-matrix:matrix]   !! getRecentMessages room=${roomId} err=${err instanceof Error ? err.message : String(err)}`)
      return []
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
