import assert from 'node:assert/strict'
import test from 'node:test'
import { chunkText, markdownToHtml, escapeHtml } from '../lib/format.js'

test('markdownToHtml escapes HTML and converts the conservative subset', () => {
  const html = markdownToHtml('**粗体** 与 `code` 和 <script>alert(1)</script>')
  assert.equal(html, '<b>粗体</b> 与 <code>code</code> 和 &lt;script&gt;alert(1)&lt;/script&gt;')
})

test('markdownToHtml renders fenced code blocks', () => {
  const html = markdownToHtml('前\n```\nconst x = 1 < 2\n```\n后')
  assert.equal(html, '前<br/><pre><code>const x = 1 &lt; 2</code></pre><br/>后')
})

test('chunkText returns a single unprefixed chunk under the limit', () => {
  const chunks = chunkText('短消息', 4000)
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].plain, '短消息')
  assert.equal(chunks[0].html, '短消息')
})

test('chunkText splits with convergent prefixes that never outgrow capacity', () => {
  const text = '甲'.repeat(500) + '\n' + '乙'.repeat(500)
  const maxChars = 120
  const chunks = chunkText(text, maxChars)
  assert.ok(chunks.length > 1)
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]
    assert.equal(chunk.plain.startsWith(`（${i + 1}/${chunks.length}）`), true, `prefix of chunk ${i}`)
    assert.ok(chunk.plain.length <= maxChars, `chunk ${i} length ${chunk.plain.length} <= ${maxChars}`)
  }
  assert.equal(chunks.map((c) => c.plain).join('').replaceAll(/（\d+\/\d+）/g, ''), text)
})

test('chunkText handles empty input', () => {
  assert.deepEqual(chunkText('', 4000), [])
})

test('escapeHtml escapes the three HTML metacharacters', () => {
  assert.equal(escapeHtml('<>&'), '&lt;&gt;&amp;')
})
