/**
 * 授权存储：数字分身的「记忆授权」库。
 *
 * 三级授权模型：
 * - L1 记忆授权：主人此前批准过同类工具（非红线），静默通过；
 * - L2 即时确认：房间内请求，仅 Owner 回复「批准/拒绝」有效；非红线工具批准后写入本库；
 * - L3 红线：命中 redlineTools 的工具永不入库，每次都必须即时确认。
 *
 * @module dsh-matrix/auth-store
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** 单个数字分身在某个房间的授权记录。 */
export interface AuthRecord {
  /** 数字分身 Matrix 用户 id。 */
  digitalTwinId: string
  /** 工作责任负责人（主人）Matrix 用户 id。 */
  ownerId: string
  /** 房间 id。 */
  roomId: string
  /** 已获记忆授权的工具名列表。 */
  allowedTools: string[]
  /** 最后确认时间戳（毫秒）。 */
  lastConfirmedAt: number
}

export interface AuthStoreData {
  version: 1
  records: AuthRecord[]
}

/**
 * 授权存储：JSON 落盘（原子写 tmp+rename），进程内同步读写。
 * 授权记录不包含聊天内容，只有 id 与工具名。
 */
export class AuthStore {
  private readonly filePath: string
  private data: AuthStoreData = { version: 1, records: [] }

  constructor(stateDir: string, fileName: string) {
    this.filePath = join(stateDir, fileName)
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, 'utf8')
      const parsed = JSON.parse(raw) as Partial<AuthStoreData>
      if (parsed?.version === 1 && Array.isArray(parsed.records)) {
        this.data = { version: 1, records: parsed.records }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  async save(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    const tmp = `${this.filePath}.tmp`
    await writeFile(tmp, JSON.stringify(this.data, null, 2), 'utf8')
    await rename(tmp, this.filePath)
  }

  /** 查询某记录。 */
  getRecord(digitalTwinId: string, roomId: string): AuthRecord | undefined {
    return this.data.records.find((r) => r.digitalTwinId === digitalTwinId && r.roomId === roomId)
  }

  /**
   * L1 判定：该工具在该房间是否已有记忆授权。
   * 红线工具永远返回 false（L3 强制走即时确认）。
   */
  isStandingAuthorized(digitalTwinId: string, roomId: string, toolName: string, redlineTools: readonly string[]): boolean {
    if (redlineTools.includes(toolName)) return false
    return this.getRecord(digitalTwinId, roomId)?.allowedTools.includes(toolName) ?? false
  }

  /**
   * 记录一次主人批准：把工具写入该 (分身, 房间) 的记忆授权列表。
   * 红线工具调用本方法为 no-op（调用方应先过滤）。
   */
  grant(digitalTwinId: string, ownerId: string, roomId: string, toolName: string): boolean {
    if (toolName === '') return false
    let record = this.getRecord(digitalTwinId, roomId)
    if (record === undefined) {
      record = { digitalTwinId, ownerId, roomId, allowedTools: [], lastConfirmedAt: Date.now() }
      this.data.records.push(record)
    }
    record.ownerId = ownerId
    record.lastConfirmedAt = Date.now()
    if (!record.allowedTools.includes(toolName)) {
      record.allowedTools.push(toolName)
      return true // 新授权产生
    }
    return false // 已存在
  }

  /** 吊销某 (分身, 房间) 的一个或全部工具授权。返回是否删除了内容。 */
  revoke(digitalTwinId: string, roomId: string, toolName?: string): boolean {
    const record = this.getRecord(digitalTwinId, roomId)
    if (record === undefined) return false
    if (toolName === undefined) {
      this.data.records = this.data.records.filter((r) => r !== record)
      return true
    }
    const before = record.allowedTools.length
    record.allowedTools = record.allowedTools.filter((t) => t !== toolName)
    return record.allowedTools.length < before
  }

  allRecords(): readonly AuthRecord[] {
    return this.data.records
  }
}
