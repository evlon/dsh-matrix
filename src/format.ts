/**
 * 保守的 Markdown 子集 → Matrix HTML 转换，以及带收敛前缀的长回复分段。
 *
 * Matrix 消息以 `format: org.matrix.custom.html` 同时携带纯文本 body 与
 * HTML formatted_body，因此每个分段都保留一份纯文本副本；HTML 只用于展示。
 */

export interface Chunk {
  readonly plain: string
  readonly html: string
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** 围栏代码块、行内代码、粗体；其余内容一律 HTML 转义。 */
export function markdownToHtml(text: string): string {
  const out: string[] = []
  let fence: string[] | null = null
  for (const line of text.split('\n')) {
    if (line.trimStart().startsWith('```')) {
      if (fence === null) {
        fence = []
      } else {
        out.push(`<pre><code>${escapeHtml(fence.join('\n'))}</code></pre>`)
        fence = null
      }
      continue
    }
    if (fence !== null) {
      fence.push(line)
      continue
    }
    out.push(inlineToHtml(line))
  }
  if (fence !== null) out.push(`<pre><code>${escapeHtml(fence.join('\n'))}</code></pre>`)
  return out.join('<br/>')
}

/** 先转义再应用行内标记，保证标记字符不会与转义结果互相干扰。 */
function inlineToHtml(line: string): string {
  let out = escapeHtml(line)
  out = out.replace(/`([^`\n]+)`/g, (_match, code: string) => `<code>${code}</code>`)
  out = out.replace(/\*\*([^*\n]+)\*\*/g, (_match, bold: string) => `<b>${bold}</b>`)
  return out
}

/**
 * 按字符数分段长回复，每段前缀 `（i/n）`，且前缀长度参与容量计算并迭代收敛，
 * 不会出现「第 3/2 段」这类前缀与总数不符的情况。
 */
export function chunkText(text: string, maxChars: number): Chunk[] {
  if (text.length === 0) return []
  if (text.length <= maxChars) return [{ plain: text, html: markdownToHtml(text) }]

  let total = 1
  let parts: string[] = []
  for (;;) {
    // 以最宽可能前缀（i=1,total）测量容量；parts.length 与 total 一致时收敛。
    const probe = `（1/${total}）`
    const capacity = maxChars - probe.length
    parts = splitContent(text, capacity)
    if (parts.length <= total) {
      total = parts.length
      break
    }
    total = parts.length
  }
  return parts.map((part, index) => {
    const plain = `（${index + 1}/${total}）${part}`
    return { plain, html: markdownToHtml(plain) }
  })
}

/** 贪心切分，优先在换行、句号等自然断点断开。 */
function splitContent(text: string, capacity: number): string[] {
  const parts: string[] = []
  let rest = text
  while (rest.length > capacity) {
    let cut = -1
    for (const sep of ['\n', '。', '！', '？', '. ', '; ', '；', ' ']) {
      const at = rest.lastIndexOf(sep, capacity)
      if (at > capacity / 2) {
        cut = at + sep.length
        break
      }
    }
    if (cut <= 0) cut = capacity
    parts.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  parts.push(rest)
  return parts
}

/** harness tool-call 块的最小形状（与 @deepseek-ai/dsh-llm 的 ToolCallBlock 对齐）。 */
export interface ToolCallLike {
  name: string
  arguments: string
}

/** harness MediaBlock 的最小形状（与 src/matrix.ts 的 MediaBlock 对齐）。 */
export interface MediaLike {
  msgtype: string
  body: string
  mimetype?: string
  filename?: string
}

/**
 * 把结构化 tool-call 块投影为 Matrix 可读文本（与 GUI tool-call 折叠块语义对应）。
 * arguments 为 JSON 字符串，解析失败时回退原始字符串，避免坏参数导致整条消息失败。
 */
export function formatToolCall(block: ToolCallLike): string {
  let args: unknown
  try {
    args = JSON.parse(block.arguments)
  } catch {
    args = block.arguments
  }
  const header = `🔧 调用工具 \`${block.name}\``
  if (typeof args !== 'object' || args === null) {
    return args === '' || args === undefined ? header : `${header}\n${String(args)}`
  }
  const lines = Object.entries(args as Record<string, unknown>).map(([key, value]) => {
    const pretty = typeof value === 'string' ? value : JSON.stringify(value)
    const clipped = pretty.length > 800 ? `${pretty.slice(0, 800)}…(已截断)` : pretty
    return `  - ${key}: ${clipped}`
  })
  return lines.length === 0 ? header : `${header}\n${lines.join('\n')}`
}

/**
 * 出站 verbosity 模式：决定把哪些 harness 事件投影给用户。
 * - `result`：结果党，只关心最终答案；工具调用/中间结果默认折叠。
 * - `process`：过程党，想要看到工具调用、工具结果、重试等中间细节。
 * 默认 `result`（用户在入站消息里说"给我过程信息/我需要看到详细过程"时切到 process）。
 */
export type Verbosity = 'result' | 'process'

/** 用户切换偏好的触发词（大小写不敏感、子串匹配）。命中即切到 process。 */
export const PROCESS_TRIGGERS = [
  '给我过程信息',
  '我需要看到详细过程',
  '显示过程',
  '看过程',
  '详细过程',
  'show process',
  'verbose',
]

/** 判定一条入站文本是否要求切换到过程模式。 */
export function wantsProcess(text: string): boolean {
  const lower = text.toLowerCase()
  return PROCESS_TRIGGERS.some((trigger) => lower.includes(trigger.toLowerCase()))
}

/**
 * 把 harness `tool/result` 事件投影为 Matrix 可读文本。
 * `event` 仅含 callId，工具名经 `toolName` 外部配对传入；查不到时回退「工具（callId）」。
 * - 失败（isError）：用 ⚠️ 标注，便于过程模式下用户看见工具为何失败；
 * - 成功：默认折叠（结果党），仅过程模式下展开摘要。
 * 内容摘要截断策略与 formatToolCall 一致（800 字）。
 */
export interface ToolResultLike {
  callId: string
  isError?: boolean
  content: { type: string; text?: string }[]
}

export function formatToolResult(event: ToolResultLike, toolName: string): string {
  const label = toolName !== '' ? toolName : `工具（${event.callId}）`
  const summary = event.content
    .filter((block) => block.type === 'text' && block.text !== undefined)
    .map((block) => block.text as string)
    .join('\n')
    .trim()
  const clipped = summary.length > 800 ? `${summary.slice(0, 800)}…(已截断)` : summary
  const header = event.isError === true ? `⚠️ 工具 \`${label}\` 执行失败` : `✅ 工具 \`${label}\` 执行成功`
  return clipped.length === 0 ? header : `${header}\n${clipped}`
}

/**
 * 把 harness `turn/end` 的结束原因投影为落幕提示文本。
 * 仅当 reason.kind 非 `completed` 时由调用方投递；`completed` 返回 undefined（无需提示）。
 * - error：展示结构化 LlmFailure.message（及 code）；
 * - aborted/blocked/max-tokens/interrupted：展示 kind 中文说明。
 */
export function formatTurnEnd(reason: { kind: string; error?: { message: string; code: string } }): string | undefined {
  switch (reason.kind) {
    case 'completed':
      return undefined
    case 'error': {
      const msg = reason.error?.message ?? '未知错误'
      const code = reason.error?.code
      return `⚠️ 本次会话因错误结束：${msg}${code !== undefined ? `（${code}）` : ''}`
    }
    case 'aborted':
      return '⚠️ 本次会话被中断（aborted）。'
    case 'blocked':
      return '⚠️ 本次会话被阻塞（blocked），可能需要额外授权或输入。'
    case 'max-tokens':
      return '⚠️ 本次会话因达到 token 上限而结束（max-tokens）。'
    case 'interrupted':
      return '⚠️ 本次会话被外部打断（interrupted）。'
    default:
      return `⚠️ 本次会话异常结束（${reason.kind}）。`
  }
}

/**
 * 把 harness `llm/retry` 事件投影为轻提示。供过程模式提示用户模型受限自动重试，
 * 避免误以为卡死。normal 模式含 maxRetries，always 模式无上限。
 */
export interface RetryLike {
  retry: number
  maxRetries?: number
  delayMs: number
  failure?: { message: string }
}

export function formatRetry(event: RetryLike): string {
  const delay = (event.delayMs / 1000).toFixed(1)
  // always 模式（无 maxRetries）为无上限退避——这是 token 黑洞的来源，加 ⚠️ 警示。
  const isUnbounded = event.maxRetries === undefined
  const cap = isUnbounded ? '（⚠️ 无上限退避，将持续消耗 token）' : `（最多 ${event.maxRetries} 次）`
  const reason = event.failure?.message
  return `🔄 模型受限，正在第 ${event.retry} 次自动重试${cap}，延迟 ${delay}s${reason ? `：${reason}` : ''}`
}

/**
 * 重试熔断落幕提示：插件在房间重试累计达阈值时主动 agent.cancel() 终止 turn，
 * 以事件驱动方式停止 harness 的无限重试，避免 token 持续浪费。
 */
export function formatRetryCircuitTripped(retry: number, threshold: number): string {
  return (
    `🛑 已达 ${retry} 次重试（阈值 ${threshold}），已终止本次会话以止损。` +
    `如需继续，请调整后重新发起。`
  )
}

/**
 * 入站媒体占位：把非文字附件描述成可读文本，并入 message.text。
 * 本轮不解析媒体内容（OCR/多模态），仅保留结构 + 占位，作为后续扩展点。
 * 返回的占位文本保证非空，使纯媒体消息也能进入处理流程而不被静默丢弃。
 */
export function describeMedia(media: readonly MediaLike[]): string {
  if (media.length === 0) return ''
  const LABELS: Record<string, string> = {
    'm.image': '图片',
    'm.file': '文件',
    'm.audio': '音频',
    'm.video': '视频',
    'm.location': '位置',
  }
  const parts = media.map((m) => {
    const label = LABELS[m.msgtype] ?? '附件'
    const name = m.filename ?? m.body ?? label
    return `[${label}: ${name}${m.mimetype !== undefined ? ` (${m.mimetype})` : ''}]`
  })
  return '\n' + parts.join(' ')
}

// ===================== Matrix 任务面板渲染 =====================

import type { MatrixTask, AllowDenyRule } from './store.js'

const TASK_STATUS_LABEL: Record<MatrixTask['status'], string> = {
  pending: '⏳ 待审',
  approved: '✅ 已批准',
  rejected: '🚫 已拒绝',
  done: '🏁 已完成',
}

/** 工作目录状态文案。 */
export type WorkspaceState = 'none' | 'bound' | 'missing'

export function formatWorkspaceState(state: WorkspaceState, cwd?: string): string {
  switch (state) {
    case 'none':
      return '🆕 新来的（尚未设定工作目录）'
    case 'bound':
      return `📁 已有工作区：${cwd ?? ''}`
    case 'missing':
      return `⚠️ 工作目录不存在：${cwd ?? ''}`
  }
}

/**
 * 渲染房间 matrix 任务面板（纯文本，全 Matrix 客户端兼容）。
 * 列出待办/已办计数、每条序号+状态+发起人+摘要，以及工作目录状态。
 */
export function formatTasks(
  tasks: readonly MatrixTask[],
  workspace: { state: WorkspaceState; cwd?: string },
): string {
  const lines: string[] = []
  const pending = tasks.filter((t) => t.status === 'pending').length
  const doneCount = tasks.filter((t) => t.status === 'done' || t.status === 'rejected').length
  lines.push(`📋 任务面板（待审 ${pending} / 已办 ${doneCount} / 共 ${tasks.length}）`)
  lines.push(formatWorkspaceState(workspace.state, workspace.cwd))
  if (tasks.length === 0) {
    lines.push('（暂无任务）')
    return lines.join('\n')
  }
  tasks.forEach((t, i) => {
    const who = t.sender
    const snippet = t.text.length > 60 ? `${t.text.slice(0, 60)}…` : t.text
    const note = t.note ? ` · ${t.note}` : ''
    lines.push(`${i + 1}. ${TASK_STATUS_LABEL[t.status]} ${who}：${snippet}${note}`)
  })
  lines.push('')
  lines.push('命令：/queue 刷新 · /approve N 执行 · /reject N 拒绝 · /allow 人 事 / /deny 人 事')
  return lines.join('\n')
}

/** 渲染工作目录候选引导（文本编号）。 */
export function formatCwdGuide(candidates: readonly string[]): string {
  const lines: string[] = ['📁 请为这个会话选择工作目录（回复编号）：']
  candidates.forEach((c, i) => lines.push(`  ${i + 1}. ${c}`))
  lines.push('')
  lines.push('回复编号即选定；选定后该房间的任务才能执行。')
  return lines.join('\n')
}

/** 渲染黑白名单列表。 */
export function formatRules(rules: readonly AllowDenyRule[]): string {
  if (rules.length === 0) return '（暂无黑白名单规则）'
  const lines = ['📑 人+事 黑白名单：']
  rules.forEach((r, i) => {
    const kind = r.kind === 'allow' ? '✅白' : '🚫黑'
    lines.push(`${i + 1}. [${kind}] 人=${r.person} 事=${r.matter}`)
  })
  return lines.join('\n')
}
