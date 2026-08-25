import { appendFileSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 一条聊天记录（仅文本消息；媒体消息文本为空时不记录）。 */
export interface ChatEntry {
  readonly ts: number
  readonly sender: string
  readonly text: string
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000
/** 单房间内存保留上限，防止极端情况下无限增长（超出丢弃最旧）。 */
const ROOM_CAP = 2000

/**
 * 按房间分组的近期聊天记录（最近一周）。与响应门控解耦：无论是否 @分身都记录，
 * 目的是让分身在被人 @ 时能引用/回溯此前的群聊上下文。
 * 持久化：stateDir/chatlog/<roomId>.jsonl（每行一条 JSON）；内存维护每房间数组加速读取。
 */
export class ChatLog {
  private readonly dir: string
  private readonly mem = new Map<string, ChatEntry[]>()
  private loaded = false

  constructor(stateDir?: string) {
    this.dir = stateDir ? join(stateDir, 'chatlog') : join('.dsh-matrix', 'chatlog')
  }

  /** 懒加载：首次访问时把 jsonl 读入内存（仅一次）。 */
  private ensureLoaded(): void {
    if (this.loaded) return
    this.loaded = true
    try {
      mkdirSync(this.dir, { recursive: true })
      for (const name of readdirSync(this.dir)) {
        if (!name.endsWith('.jsonl')) continue
        const roomId = decodeURIComponent(name.slice(0, -'.jsonl'.length))
        const raw = readFileSync(join(this.dir, name), 'utf8')
        const arr: ChatEntry[] = []
        for (const line of raw.split('\n')) {
          const t = line.trim()
          if (!t) continue
          try {
            const e = JSON.parse(t) as ChatEntry
            if (typeof e.ts === 'number' && typeof e.text === 'string') arr.push(e)
          } catch { /* 跳过坏行 */ }
        }
        this.mem.set(roomId, arr)
      }
    } catch { /* 无目录/首跑，正常 */ }
  }

  /** 追加一条记录并裁剪（>一周 或 >房间上限）。 */
  append(roomId: string, entry: ChatEntry): void {
    this.ensureLoaded()
    let arr = this.mem.get(roomId)
    if (!arr) {
      arr = []
      this.mem.set(roomId, arr)
    }
    arr.push(entry)
    const cutoff = Date.now() - WEEK_MS
    // 保留最近一周 + 上限内的最旧部分（裁剪从头部删除）。
    while (arr.length > 0) {
      const head = arr[0]!
      if (head.ts >= cutoff && arr.length <= ROOM_CAP) break
      arr.shift()
    }
    this.flushRoom(roomId, arr)
  }

  /** 取最近一周内的记录（按时间升序），最多 max 条。 */
  recent(roomId: string, max = 40): ChatEntry[] {
    this.ensureLoaded()
    const arr = this.mem.get(roomId)
    if (!arr || arr.length === 0) return []
    const cutoff = Date.now() - WEEK_MS
    const within = arr.filter((e) => e.ts >= cutoff)
    return within.slice(-max)
  }

  /** 把房间内存数组原子写回 jsonl（tmp + rename）。 */
  private flushRoom(roomId: string, arr: ChatEntry[]): void {
    try {
      mkdirSync(this.dir, { recursive: true })
      const file = join(this.dir, `${encodeURIComponent(roomId)}.jsonl`)
      const tmp = `${file}.tmp`
      const lines = arr.map((e) => JSON.stringify(e)).join('\n') + '\n'
      writeFileSync(tmp, lines, 'utf8')
      renameSync(tmp, file)
    } catch { /* 写失败不影响主流程 */ }
  }

  /** 进程退出时强制落盘（已实时 flush，这里兜底）。 */
  dispose(): void {
    if (!this.loaded) return
    for (const [roomId, arr] of this.mem) this.flushRoom(roomId, arr)
  }
}
