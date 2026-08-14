import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface RoomBinding {
  readonly sessionId: string
}

interface StateFile {
  version: 1
  roomSessions: Record<string, RoomBinding>
  processedEventIds: string[]
  syncToken?: string
}

/** 去重环最多保留的事件 id 数。Matrix 事件 id 全局唯一，重启后重放窗口有限。 */
const DEDUP_CAP = 2000
const SAVE_DEBOUNCE_MS = 300

/**
 * 桥接持久状态：房间↔会话映射、已处理事件去重环、Matrix sync token。
 * 原子写入（tmp + rename），写入去抖；`dispose()` 强制落盘。
 */
export class BridgeState {
  private data: StateFile = { version: 1, roomSessions: {}, processedEventIds: [] }
  private saveTimer: NodeJS.Timeout | undefined
  private saving: Promise<void> | undefined

  constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, 'utf8')
      const parsed = JSON.parse(raw) as Partial<StateFile>
      if (parsed?.version === 1 && typeof parsed.roomSessions === 'object' && parsed.roomSessions !== null) {
        this.data = {
          version: 1,
          roomSessions: parsed.roomSessions as Record<string, RoomBinding>,
          processedEventIds: Array.isArray(parsed.processedEventIds) ? parsed.processedEventIds.slice(-DEDUP_CAP) : [],
          ...(typeof parsed.syncToken === 'string' ? { syncToken: parsed.syncToken } : {}),
        }
      }
    } catch (error) {
      // 首次运行没有状态文件是正常情况；其它错误照常抛出。
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  roomSession(roomId: string): string | undefined {
    return this.data.roomSessions[roomId]?.sessionId
  }

  setRoomSession(roomId: string, sessionId: string): void {
    this.data.roomSessions[roomId] = { sessionId }
    this.scheduleSave()
  }

  deleteRoom(roomId: string): void {
    if (roomId in this.data.roomSessions) {
      delete this.data.roomSessions[roomId]
      this.scheduleSave()
    }
  }

  sessionRoom(sessionId: string): string | undefined {
    for (const [roomId, binding] of Object.entries(this.data.roomSessions)) {
      if (binding.sessionId === sessionId) return roomId
    }
    return undefined
  }

  hasSeen(eventId: string): boolean {
    return this.data.processedEventIds.includes(eventId)
  }

  markSeen(eventId: string): void {
    if (this.hasSeen(eventId)) return
    this.data.processedEventIds.push(eventId)
    if (this.data.processedEventIds.length > DEDUP_CAP) {
      this.data.processedEventIds.splice(0, this.data.processedEventIds.length - DEDUP_CAP)
    }
    this.scheduleSave()
  }

  get syncToken(): string | undefined {
    return this.data.syncToken
  }

  set syncToken(token: string | undefined) {
    if (token === this.data.syncToken) return
    this.data.syncToken = token
    this.scheduleSave()
  }

  private scheduleSave(): void {
    clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      void this.saveNow()
    }, SAVE_DEBOUNCE_MS)
  }

  async saveNow(): Promise<void> {
    clearTimeout(this.saveTimer)
    if (this.saving !== undefined) {
      await this.saving
      return
    }
    this.saving = (async () => {
      await mkdir(dirname(this.filePath), { recursive: true })
      const tmp = `${this.filePath}.tmp`
      await writeFile(tmp, JSON.stringify(this.data, null, 2), 'utf8')
      await rename(tmp, this.filePath)
    })().finally(() => {
      this.saving = undefined
    })
    await this.saving
  }

  async dispose(): Promise<void> {
    clearTimeout(this.saveTimer)
    await this.saving
    await this.saveNow()
  }
}
