import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface RoomBinding {
  readonly sessionId: string
}

/** matrix 任务：房间内同事发来的待审工作（按人+事维度审核）。 */
export interface MatrixTask {
  readonly id: string
  readonly roomId: string
  readonly sender: string
  text: string
  status: 'pending' | 'approved' | 'rejected' | 'done'
  /** 命中白名单时记 "记忆授权"，命中黑名单时记拒绝原因；否则空。 */
  note?: string
  createdAt: number
  cwd?: string
  contextPrompt?: string
}

/** 人+事维度黑白名单规则。 */
export interface AllowDenyRule {
  /** 人：Matrix 用户 id（'*' 表示任意人）。 */
  readonly person: string
  /** 事：任务关键词/分类（'*' 表示任意事）。 */
  readonly matter: string
  readonly kind: 'allow' | 'deny'
  readonly addedAt: number
}

interface AllowDenyFile {
  version: 1
  rules: AllowDenyRule[]
}

interface StateFile {
  version: 1
  roomSessions: Record<string, RoomBinding>
  processedEventIds: string[]
  syncToken?: string
  /** 房间已选定的工作目录（新房间授权后写入）。 */
  roomCwds?: Record<string, string>
  /** 房间级 matrix 任务队列（重启不丢）。 */
  matrixTasks?: Record<string, MatrixTask[]>
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
  private allowDeny: AllowDenyFile = { version: 1, rules: [] }
  private allowDenyPath: string | undefined
  private saveTimer: NodeJS.Timeout | undefined
  private saving: Promise<void> | undefined
  private allowDenySaving = false

  constructor(private readonly filePath: string) {
    this.allowDenyPath = `${dirname(filePath)}/allow-deny.json`
  }

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
          ...(typeof parsed.roomCwds === 'object' && parsed.roomCwds !== null ? { roomCwds: parsed.roomCwds as Record<string, string> } : {}),
          ...(typeof parsed.matrixTasks === 'object' && parsed.matrixTasks !== null ? { matrixTasks: parsed.matrixTasks as Record<string, MatrixTask[]> } : {}),
        }
      }
    } catch (error) {
      // 首次运行没有状态文件是正常情况；其它错误照常抛出。
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await this.loadAllowDeny()
  }

  private async loadAllowDeny(): Promise<void> {
    if (!this.allowDenyPath) return
    try {
      const raw = await readFile(this.allowDenyPath, 'utf8')
      const parsed = JSON.parse(raw) as Partial<AllowDenyFile>
      if (parsed?.version === 1 && Array.isArray(parsed.rules)) {
        this.allowDeny = { version: 1, rules: parsed.rules }
      }
    } catch (error) {
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
    if (this.data.roomCwds) delete this.data.roomCwds[roomId]
    if (this.data.matrixTasks) delete this.data.matrixTasks[roomId]
    this.scheduleSave()
  }

  // ---- 房间工作目录绑定 ----

  roomCwd(roomId: string): string | undefined {
    return this.data.roomCwds?.[roomId]
  }

  setRoomCwd(roomId: string, cwd: string): void {
    if (!this.data.roomCwds) this.data.roomCwds = {}
    this.data.roomCwds[roomId] = cwd
    this.scheduleSave()
  }

  // ---- 房间 matrix 任务队列 ----

  loadTasks(roomId: string): MatrixTask[] {
    return this.data.matrixTasks?.[roomId] ?? []
  }

  /** 返回全部房间的任务映射（用于启动时恢复内存镜像）。 */
  matrixTasksSnapshot(): Record<string, MatrixTask[]> {
    return this.data.matrixTasks ?? {}
  }

  saveTasks(roomId: string, tasks: MatrixTask[]): void {
    if (!this.data.matrixTasks) this.data.matrixTasks = {}
    this.data.matrixTasks[roomId] = tasks
    this.scheduleSave()
  }

  // ---- 人+事黑白名单 ----

  listRules(): AllowDenyRule[] {
    return this.allowDeny.rules
  }

  addRule(rule: AllowDenyRule): void {
    this.allowDeny.rules = this.allowDeny.rules.filter(
      (r) => !(r.person === rule.person && r.matter === rule.matter),
    )
    this.allowDeny.rules.push(rule)
    void this.scheduleAllowDenySave()
  }

  removeRule(person: string, matter: string): void {
    this.allowDeny.rules = this.allowDeny.rules.filter(
      (r) => !(r.person === person && r.matter === matter),
    )
    void this.scheduleAllowDenySave()
  }

  /** 人+事命中判定：allow 优先于 deny；精确匹配优先于通配；事支持子串包含。 */
  matchRule(person: string, matter: string): AllowDenyRule | undefined {
    const rules = this.allowDeny.rules
    const matterHit = (m: string): boolean => m === '*' || m === matter || matter.includes(m) || m.includes(matter)
    const candidates = [
      rules.find((r) => r.person === person && matterHit(r.matter)),
      rules.find((r) => r.person === '*' && matterHit(r.matter)),
    ]
    return candidates.find((r): r is AllowDenyRule => r !== undefined)
  }

  private async scheduleAllowDenySave(): Promise<void> {
    if (!this.allowDenyPath || this.allowDenySaving) return
    this.allowDenySaving = true
    try {
      await mkdir(dirname(this.allowDenyPath), { recursive: true })
      const tmp = `${this.allowDenyPath}.tmp`
      await writeFile(tmp, JSON.stringify(this.allowDeny, null, 2), 'utf8')
      await rename(tmp, this.allowDenyPath)
    } catch (error) {
      // 写入失败仅记录，不阻断主流程。
      console.warn(`[matrix] failed to save allow/deny: ${String(error)}`)
    } finally {
      this.allowDenySaving = false
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
