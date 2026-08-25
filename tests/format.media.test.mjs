import assert from 'node:assert/strict'
import test from 'node:test'
import { formatToolCall, describeMedia, formatToolResult, formatTurnEnd, formatRetry, wantsProcess } from '../lib/format.js'

test('formatToolCall projects name with no args', () => {
  assert.equal(formatToolCall({ name: 'bash', arguments: '{}' }), '🔧 调用工具 `bash`')
})

test('formatToolCall projects name and each arg as a bullet', () => {
  const out = formatToolCall({ name: 'bash', arguments: JSON.stringify({ code: 'ls -l', cwd: '/tmp' }) })
  assert.equal(out, '🔧 调用工具 `bash`\n  - code: ls -l\n  - cwd: /tmp')
})

test('formatToolCall truncates over-long arg values', () => {
  const big = 'x'.repeat(2000)
  const out = formatToolCall({ name: 'bash', arguments: JSON.stringify({ code: big }) })
  assert.match(out, /…\(已截断\)$/)
  assert.ok(!out.includes('x'.repeat(2000)))
})

test('formatToolCall falls back to raw string when arguments is not JSON', () => {
  assert.equal(formatToolCall({ name: 'bash', arguments: 'not-json' }), '🔧 调用工具 `bash`\nnot-json')
})

test('describeMedia returns empty string for no media', () => {
  assert.equal(describeMedia([]), '')
})

test('describeMedia renders an image placeholder with mimetype', () => {
  assert.equal(
    describeMedia([{ msgtype: 'm.image', body: 'photo.png', mimetype: 'image/png' }]),
    '\n[图片: photo.png (image/png)]',
  )
})

test('describeMedia renders multiple media joined', () => {
  const out = describeMedia([
    { msgtype: 'm.image', body: 'a.png' },
    { msgtype: 'm.file', body: 'b.pdf' },
  ])
  assert.equal(out, '\n[图片: a.png] [文件: b.pdf]')
})

// ---------- formatToolResult ----------

test('formatToolResult success with name', () => {
  const out = formatToolResult(
    { callId: 'c1', isError: false, content: [{ type: 'text', text: 'ok' }] },
    'bash',
  )
  assert.equal(out, '✅ 工具 `bash` 执行成功\nok')
})

test('formatToolResult failure falls back to callId when name missing', () => {
  const out = formatToolResult(
    { callId: 'c9', isError: true, content: [{ type: 'text', text: 'denied' }] },
    '',
  )
  assert.match(out, /⚠️ 工具 `工具（c9）` 执行失败/)
  assert.match(out, /denied/)
})

test('formatToolResult truncates long content at 800 chars', () => {
  const long = 'x'.repeat(1000)
  const out = formatToolResult({ callId: 'c1', isError: false, content: [{ type: 'text', text: long }] }, 'b')
  assert.ok(out.includes('…(已截断)'))
  assert.ok(out.length < 1000)
})

// ---------- formatTurnEnd ----------

test('formatTurnEnd returns undefined for completed', () => {
  assert.equal(formatTurnEnd({ kind: 'completed' }), undefined)
})

test('formatTurnEnd renders error with message and code', () => {
  const out = formatTurnEnd({ kind: 'error', error: { message: 'boom', code: 'E1' } })
  assert.match(out, /boom/)
  assert.match(out, /E1/)
})

test('formatTurnEnd renders aborted/max-tokens/interrupted', () => {
  assert.match(formatTurnEnd({ kind: 'aborted' }), /aborted/)
  assert.match(formatTurnEnd({ kind: 'max-tokens' }), /max-tokens/)
  assert.match(formatTurnEnd({ kind: 'interrupted' }), /interrupted/)
  assert.match(formatTurnEnd({ kind: 'unknown-kind' }), /unknown-kind/)
})

// ---------- formatRetry ----------

test('formatRetry renders normal mode with cap', () => {
  const out = formatRetry({ retry: 2, maxRetries: 5, delayMs: 1500, failure: { message: 'rate limited' } })
  assert.match(out, /第 2 次/)
  assert.match(out, /最多 5 次/)
  assert.match(out, /1.5s/)
  assert.match(out, /rate limited/)
})

test('formatRetry renders always mode (no maxRetries)', () => {
  const out = formatRetry({ retry: 3, delayMs: 0 })
  assert.match(out, /无上限退避/)
})

// ---------- wantsProcess (verbosity trigger) ----------

test('wantsProcess matches Chinese triggers case-insensitively', () => {
  assert.equal(wantsProcess('请给我过程信息'), true)
  assert.equal(wantsProcess('我需要看到详细过程'), true)
  assert.equal(wantsProcess('SHOW PROCESS'), true)
})

test('wantsProcess returns false for normal messages', () => {
  assert.equal(wantsProcess('今天天气怎么样'), false)
  assert.equal(wantsProcess('/auth list'), false)
})
