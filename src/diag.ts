import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 诊断日志：同时输出到 dsh logger 与本地文件，便于事后由 AI/人工直接读取文件排查，
 * 不必依赖 dsh web 运行终端。写入 stateDir/diagnostics.log，按行追加，进程级单例。
 */
export class DiagLogger {
  private readonly file: string | undefined
  private readonly mem: string[] = []
  private readonly maxMem = 500

  constructor(private readonly name: string, stateDir?: string) {
    if (stateDir) {
      try {
        mkdirSync(stateDir, { recursive: true })
        this.file = join(stateDir, 'diagnostics.log')
      } catch {
        this.file = undefined
      }
    }
  }

  log(line: string): void {
    const ts = new Date().toISOString()
    const full = `${ts} ${line}`
    // 内存环缓冲，供 tests / 调试查看最近 N 条
    this.mem.push(full)
    if (this.mem.length > this.maxMem) this.mem.shift()
    if (this.file) {
      try {
        appendFileSync(this.file, full + '\n')
      } catch {
        /* 写文件失败不影响主流程 */
      }
    }
  }

  /** 取最近若干条内存日志（不读文件）。 */
  recent(n = 50): string[] {
    return this.mem.slice(-n)
  }
}

let shared: DiagLogger | undefined

export function getDiag(name: string, stateDir?: string): DiagLogger {
  if (!shared) shared = new DiagLogger(name, stateDir)
  return shared
}
