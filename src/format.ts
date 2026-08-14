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
