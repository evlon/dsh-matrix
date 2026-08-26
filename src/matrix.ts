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
  /** 图片宽高（m.image 的 info.w/h）。 */
  readonly width?: number
  readonly height?: number
  /** 已下载到本地的绝对路径（桥接层下载后回填；未下载时为 undefined）。 */
  readonly localPath?: string
  /** m.location 的 geo_uri（地理坐标）。 */
  readonly geoUri?: string
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

/** 群/房间成员变化与资料变更事件（入群/离群/邀请/改名换头像/房间信息）。
 * 由通道层在 /sync 的 state 或 timeline 中识别并投影，经 ChannelOptions.onRoomEvent 抛出。
 * 与消息事件（InboundMessage）分离：成员/资料事件不经过消息去重环（用独立 eventId 去重），
 * 且由桥接层按 notifyRoomEvents 配置决定是否注入 agent。
 */
export type RoomEventKind = 'join' | 'leave' | 'invite' | 'profile' | 'room-name' | 'room-topic'

export interface RoomEvent {
  readonly kind: RoomEventKind
  readonly roomId: string
  /** 发生变化的成员 userId；房间信息事件（room-name/room-topic）为 undefined。 */
  readonly userId?: string
  readonly eventId: string
  /** 事件时间戳（origin_server_ts，ms）。 */
  readonly at: number
  /** 各 kind 的附加信息。 */
  readonly detail?: Record<string, unknown>
}

export interface ChannelOptions {
  readonly homeserverUrl: string
  readonly accessToken: string
  readonly userId: string
  readonly state: BridgeState
  readonly onMessage?: (message: InboundMessage) => void
  /** 成员变化 / 资料变更 / 房间信息事件。桥接层按配置决定是否注入 agent。 */
  readonly onRoomEvent?: (event: RoomEvent) => void
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
  /** 主动给指定用户发私聊：查既有 1:1 房，无则 create-room+invite，再发送。 */
  sendDm?(userId: string, plain: string, html?: string): Promise<{ roomId: string; eventId?: string }>
  /** 向房间发送消息并 @ 一个或多个成员（HTML m.mention + 文本 @名字 兜底）。 */
  sendMentionText?(roomId: string, plain: string, mentions: string[], html?: string): Promise<void>
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
  /** 列出本账号已加入的房间（/joined_rooms），附名称/成员数。供 agent 工具按需调用。 */
  listJoinedRooms?(): Promise<Array<{ roomId: string; name?: string; memberCount?: number }>>
  /** 把 mxc:// URL 解析为可下载的 HTTP URL。 */
  resolveMediaUrl?(mxc: string): string | undefined
  /** 下载 Matrix 媒体（mxc:// URL）为字节。供 agent 工具/桥接层按需调用。 */
  downloadMedia?(mxc: string, signal?: AbortSignal): Promise<{ buffer: Uint8Array; mimetype?: string; size: number }>
}

/** /sync 响应中我们关心的最小结构。 */
interface SyncResponse {
  next_batch?: string
  rooms?: {
    join?: Record<string, {
      timeline?: { events?: MatrixEventJson[] }
      /** 房间当前状态快照（m.room.name/m.room.topic/m.room.member 等），首次同步或状态变更时投递。 */
      state?: { events?: MatrixEventJson[] }
    }>
    invite?: Record<string, unknown>
  }
}

/** 时间线事件的最小结构。 */
interface MatrixEventJson {
  type?: string
  sender?: string
  event_id?: string
  origin_server_ts?: number
  state_key?: string
  content?: {
    msgtype?: string
    body?: string
    url?: string
    mimetype?: string
    /** m.file 的原始文件名。 */
    filename?: string
    /** m.image/m.file/m.audio/m.video 等携带的元信息。 */
    info?: { mimetype?: string; size?: number; w?: number; h?: number; filename?: string }
    /** m.location 的地理坐标。 */
    geo_uri?: string
    /** m.room.member 的成员状态（join/invite/leave/ban）。 */
    membership?: string
    /** m.room.member 携带的显示名/头像（资料变更）。 */
    displayname?: string
    avatar_url?: string
    /** m.room.name / m.room.topic 的正文。 */
    name?: string
    topic?: string
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
  private readonly seenRoomEvents = new Set<string>()
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
      // 状态块：房间名/主题/成员变更。首次同步或状态变化时由 homeserver 投递 state 快照。
      const stateEvents = room.state?.events
      if (stateEvents !== undefined) {
        for (const event of stateEvents) this.onStateEvent(roomId, event)
      }
      const events = room.timeline?.events
      if (events === undefined) continue
      for (const event of events) this.onTimelineEvent(roomId, event)
    }
  }

  /** 处理房间状态事件（入群/离群/改名换头像/房间信息），投影为 RoomEvent 抛出。 */
  private onStateEvent(roomId: string, event: MatrixEventJson): void {
    if (this.stopped) return
    const eventId = event.event_id
    if (eventId === undefined) return
    // 成员/资料事件用独立 eventId 去重（不走消息 markSeen 环，防 sync 状态快照重放重复触发）。
    if (this.seenRoomEvents.has(eventId)) return
    this.seenRoomEvents.add(eventId)
    if (this.seenRoomEvents.size > 5000) {
      // 防内存无限增长：清掉最旧的一半。
      const iter = this.seenRoomEvents.values()
      for (let i = 0; i < 2500 && iter.next().done !== true; i++) iter.next()
      const toDelete = Array.from(this.seenRoomEvents).slice(0, 2500)
      for (const id of toDelete) this.seenRoomEvents.delete(id)
    }

    const sender = event.sender
    const at = event.origin_server_ts ?? Date.now()
    if (event.type === 'm.room.member') {
      const userId = event.state_key ?? event.sender
      if (userId === undefined) return
      const content = event.content
      const membership = content?.membership
      // 自己发起的动作（自己入群/自己改名）不投影，避免自触发。
      if (userId === this.options.userId) {
        this.invalidateMemberCaches(roomId)
        return
      }
      // 入群/离群/邀请：成员名单变化，失效成员/人数缓存。
      if (membership === 'invite' || membership === 'leave') {
        this.invalidateMemberCaches(roomId)
        const kind: RoomEventKind = membership === 'invite' ? 'invite' : 'leave'
        this.options.onRoomEvent?.({ kind, roomId, userId, eventId, at })
        return
      }
      // join 事件：若该成员已在房间成员缓存里（是资料更新而非新入群），则投 profile；
      // 否则投 join。join 与改名都带 displayname，用「是否已在名单」区分。
      if (membership === 'join') {
        this.invalidateMemberCaches(roomId)
        const alreadyMember = this.isKnownMember(roomId, userId)
        const hasProfile = content?.displayname !== undefined || content?.avatar_url !== undefined
        if (alreadyMember && hasProfile) {
          this.userInfoCache.delete(userId)
          this.options.onRoomEvent?.({
            kind: 'profile',
            roomId,
            userId,
            eventId,
            at,
            detail: {
              ...(content?.displayname !== undefined ? { displayName: content.displayname } : {}),
              ...(content?.avatar_url !== undefined ? { avatarUrl: content.avatar_url } : {}),
            },
          })
          return
        }
        this.options.onRoomEvent?.({ kind: 'join', roomId, userId, eventId, at })
        return
      }
      // 资料变更：非 join/invite/leave 的 member 事件（如 displayname/avatar 更新），
      // 尽力而为，失效资料缓存。
      if (content?.displayname !== undefined || content?.avatar_url !== undefined) {
        this.userInfoCache.delete(userId)
        this.options.onRoomEvent?.({
          kind: 'profile',
          roomId,
          userId,
          eventId,
          at,
          detail: {
            ...(content?.displayname !== undefined ? { displayName: content.displayname } : {}),
            ...(content?.avatar_url !== undefined ? { avatarUrl: content.avatar_url } : {}),
          },
        })
      }
      return
    }
    if (event.type === 'm.room.name') {
      this.nameCache.delete(roomId)
      this.options.onRoomEvent?.({
        kind: 'room-name',
        roomId,
        eventId,
        at,
        detail: { name: event.content?.name },
      })
      return
    }
    if (event.type === 'm.room.topic') {
      this.options.onRoomEvent?.({ kind: 'room-topic', roomId, eventId, at, detail: { topic: event.content?.topic } })
    }
  }

  /** 成员名单或资料变化后主动失效缓存，避免工具读到陈旧名单。 */
  private invalidateMemberCaches(roomId: string): void {
    this.membersCache.delete(roomId)
    this.countCache.delete(roomId)
    this.dmCache.delete(roomId)
  }

  /** 判断某用户是否已在房间成员缓存中（用于区分「新入群」与「资料更新」）。 */
  private isKnownMember(roomId: string, userId: string): boolean {
    const cached = this.membersCache.get(roomId)
    if (cached === undefined) return false
    return cached.value.some((m) => m.userId === userId)
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
    // 成员/房间状态事件也会出现在 timeline（如 join/leave/改名），转发到状态处理。
    if (event.type === 'm.room.member' || event.type === 'm.room.name' || event.type === 'm.room.topic') {
      this.onStateEvent(roomId, event)
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
    // 本轮只识别结构、生成占位文本；内容下载/解析（OCR/多模态）由桥接层/工具完成。
    const MEDIA_MSGTYPES = new Set(['m.image', 'm.file', 'm.audio', 'm.video', 'm.location'])
    let text = content.body
    let media: MediaBlock[] = []
    if (MEDIA_MSGTYPES.has(msgtype)) {
      const isLocation = msgtype === 'm.location'
      // Matrix 中 m.image/m.file 等的 content.url 即 mxc:// URI，url 与 mxc 同源。
      const mxc = isLocation ? undefined : (content.url?.startsWith('mxc://') ? content.url : undefined)
      media = [{
        msgtype,
        body: content.body,
        mimetype: content.mimetype ?? content.info?.mimetype,
        url: content.url,
        mxc,
        size: content.info?.size,
        filename: content.filename ?? content.info?.filename,
        width: content.info?.w,
        height: content.info?.h,
        geoUri: content.geo_uri,
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

  /** 把 mxc:// URL 解析为可下载的 HTTP URL（经本 homeserver 媒体端点代理）。
   * 非 mxc:// 返回 undefined。 */
  resolveMediaUrl(mxc: string): string | undefined {
    const m = /^mxc:\/\/([^/]+)\/([^/]+)$/.exec(mxc)
    if (!m || m[1] === undefined || m[2] === undefined) return undefined
    const server = m[1]
    const mediaId = m[2]
    return `${this.baseUrl}/_matrix/media/v3/download/${encodeURIComponent(server)}/${encodeURIComponent(mediaId)}`
  }

  /** 下载 Matrix 媒体（mxc:// URL）为字节。供 agent 工具/桥接层按需调用。 */
  async downloadMedia(mxc: string, signal?: AbortSignal): Promise<{ buffer: Uint8Array; mimetype?: string; size: number }> {
    const httpUrl = this.resolveMediaUrl(mxc)
    if (httpUrl === undefined) throw new Error(`无效的 mxc URL: ${mxc}`)
    this.diag.log(`[dsh-matrix:matrix] GET media ${mxc}`)
    const response = await this.fetchFn(httpUrl, {
      headers: { Authorization: `Bearer ${this.options.accessToken}` },
      ...(signal !== undefined ? { signal } : {}),
    })
    if (!response.ok) {
      this.diag.log(`[dsh-matrix:matrix]   <- media HTTP ${response.status}`)
      throw new Error(`media download HTTP ${response.status}`)
    }
    const arrayBuffer = await response.arrayBuffer()
    const buffer = new Uint8Array(arrayBuffer)
    const mimetype = response.headers?.get?.('content-type') ?? undefined
    this.diag.log(`[dsh-matrix:matrix]   <- ${buffer.length} bytes${mimetype !== undefined ? ` (${mimetype})` : ''}`)
    return { buffer, mimetype, size: buffer.length }
  }

  /** 列出本账号已加入的房间（/joined_rooms），附名称/成员数。供 agent 工具按需调用。 */
  async listJoinedRooms(): Promise<Array<{ roomId: string; name?: string; memberCount?: number }>> {
    try {
      const url = `${this.baseUrl}/_matrix/client/v3/joined_rooms`
      this.diag.log('[dsh-matrix:matrix] GET .../joined_rooms')
      const response = await this.fetchFn(url, {
        headers: { Authorization: `Bearer ${this.options.accessToken}` },
      })
      if (!response.ok) {
        this.diag.log(`[dsh-matrix:matrix]   <- HTTP ${response.status}`)
        return []
      }
      const data = (await response.json()) as { joined_rooms?: string[] }
      const rooms = data.joined_rooms ?? []
      // 并发取名称/成员数（带缓存），逐项失败不致命。
      const result = await Promise.all(rooms.map(async (roomId) => {
        const [name, memberCount] = await Promise.all([
          this.getRoomName(roomId),
          this.getRoomMemberCount(roomId),
        ])
        return {
          roomId,
          ...(name !== undefined ? { name } : {}),
          ...(memberCount !== undefined ? { memberCount } : {}),
        }
      }))
      this.diag.log(`[dsh-matrix:matrix]   <- ${result.length} rooms`)
      return result
    } catch (err) {
      this.diag.log(`[dsh-matrix:matrix]   !! listJoinedRooms err=${err instanceof Error ? err.message : String(err)}`)
      return []
    }
  }

  /** 发送事件；txnId 让 homeserver 幂等去重，重试安全。公开供工具/桥接复用。 */
  async sendEvent(roomId: string, type: string, content: Record<string, unknown>): Promise<void> {
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

  /**
   * 主动给指定用户发私聊。
   * 1) 从已加入房间中找与该用户共有的 1:1 房（≤2 人且含该用户）；
   * 2) 找不到则 create-room（preset private_chat）+ invite；
   * 3) 在目标房间 sendText。
   * 返回目标 roomId（create 后可能因并发延迟，invite 已发出即可发送）。
   */
  async sendDm(userId: string, plain: string, html?: string): Promise<{ roomId: string; eventId?: string }> {
    const existing = await this.findDirectRoomWith(userId)
    if (existing !== undefined) {
      await this.sendText(existing, plain, html)
      return { roomId: existing }
    }
    const roomId = await this.createDirectRoom(userId)
    await this.sendText(roomId, plain, html)
    return { roomId }
  }

  /** 在已加入房间中找与目标用户共有的私聊房（≤2 人且含目标用户）。 */
  private async findDirectRoomWith(userId: string): Promise<string | undefined> {
    try {
      const url = `${this.baseUrl}/_matrix/client/v3/joined_rooms`
      const response = await this.fetchFn(url, {
        headers: { Authorization: `Bearer ${this.options.accessToken}` },
      })
      if (!response.ok) throw new Error(`joined_rooms HTTP ${response.status}`)
      const data = (await response.json()) as { joined_rooms?: string[] }
      const rooms = data.joined_rooms ?? []
      for (const roomId of rooms) {
        const members = await this.getRoomMembers(roomId)
        if (members === undefined) continue
        // 1:1 房：恰好含目标用户，且总人数 ≤2。
        if (members.length <= 2 && members.some((m) => m.userId === userId)) {
          return roomId
        }
      }
      return undefined
    } catch {
      return undefined
    }
  }

  /** create-room（private_chat）+ invite 目标用户，返回新房间 id。 */
  private async createDirectRoom(userId: string): Promise<string> {
    const url = `${this.baseUrl}/_matrix/client/v3/createRoom`
    const body = {
      preset: 'private_chat',
      invite: [userId],
      is_direct: true,
    }
    const response = await this.fetchFn(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.options.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })
    if (!response.ok) throw new Error(`createRoom HTTP ${response.status}`)
    const data = (await response.json()) as { room_id?: string }
    const roomId = data.room_id
    if (roomId === undefined) throw new Error('createRoom returned no room_id')
    // 失效该房间相关的缓存（新房间）。
    this.dmCache.delete(roomId)
    return roomId
  }

  /** 向房间发送消息并 @ 一个或多个成员：HTML 用 m.mention 锚点，文本用 @名字 兜底。 */
  async sendMentionText(roomId: string, plain: string, mentions: string[], html?: string): Promise<void> {
    // HTML：用 @user:server 的 displayname 链接。目标用户 displayname 尽力获取。
    const links = await Promise.all(mentions.map(async (userId) => {
      let name = localpartOf(userId)
      try {
        const info = await this.getUserInfo(userId)
        if (info?.displayName !== undefined && info.displayName !== '') name = info.displayName
      } catch {
        // 保持 localpart 兜底
      }
      return { userId, name }
    }))
    const htmlBody = links.map((l) => `<a href="https://matrix.to/#/${encodeURIComponent(l.userId)}">${escapeHtml(l.name)}</a>`).join(' ')
    const fallback = links.map((l) => `@${l.name}`).join(' ')
    const content: Record<string, unknown> = {
      msgtype: 'm.text',
      body: html !== undefined ? `${html}\n\n${fallback}` : `${plain}\n\n${fallback}`,
      format: 'org.matrix.custom.html',
      formatted_body: html !== undefined ? `${html}<br/>${htmlBody}` : `${escapeHtml(plain)}<br/>${htmlBody}`,
    }
    await this.sendEvent(roomId, 'm.room.message', content)
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 从完整 Matrix user id（@user:server）中取本地部分（user）。 */
function localpartOf(userId: string): string {
  const at = userId.indexOf(':')
  return userId.startsWith('@') && at > 0 ? userId.slice(1, at) : userId
}

/** HTML 转义（用于 mention 锚点与正文）。 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
