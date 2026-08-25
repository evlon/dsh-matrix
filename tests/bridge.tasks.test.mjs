/**
 * dsh-matrix Matrix 任务队列冒烟测试：数字分身模式下
 * 入队 / 黑白名单 / 工作目录引导 / 逐条批准串行 / 拒绝。
 *
 * 跑法：npm run build 后 `node --test tests/bridge.tasks.test.mjs`
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MatrixBridge } from '../lib/bridge.js'

const ROOM_ID = '!room:hs.example'
const USER_ID = '@bot:hs.example'
const SENDER = '@alice:hs.example'
const OWNER = '@owner:hs.example'

function fakeHomeserver() {
  const sends = []
  const queues = new Map()
  const waiters = new Map()
  const started = new Set()
  const broadcast = []
  let pendingReleases = 0
  let token = 0
  return {
    sends,
    async fetch(url, init) {
      const path = new URL(url).pathname
      const acct = String(init?.headers?.Authorization ?? '').replace('Bearer ', '') || '?'
      if (path.endsWith('/sync')) {
        if (!queues.has(acct)) queues.set(acct, [...broadcast])
        const events = await new Promise((resolve, reject) => {
          const q = queues.get(acct)
          if (q.length > 0) { resolve(q.splice(0)); return }
          if (!started.has(acct) && pendingReleases > 0) {
            started.add(acct)
            pendingReleases -= 1
            resolve([])
            return
          }
          waiters.set(acct, () => resolve(queues.get(acct).splice(0)))
          init.signal?.addEventListener('abort', () => {
            waiters.delete(acct)
            reject(new DOMException('aborted', 'AbortError'))
          }, { once: true })
        })
        token += 1
        return { ok: true, status: 200, async json() { return { next_batch: `s${token}`, rooms: { join: { [ROOM_ID]: { timeline: { events } } } } } } }
      }
      if (path.includes('/send/m.room.message/')) {
        sends.push({ kind: 'send', body: JSON.parse(init.body) })
        return { ok: true, status: 200, async json() { return { event_id: '$out' } } }
      }
      if (path.includes('/typing/')) return { ok: true, status: 200, async json() { return {} } }
      if (path.endsWith('/join')) return { ok: true, status: 200, async json() { return { room_id: ROOM_ID } } }
      return { ok: true, status: 200, async json() { return {} } }
    },
    deliver(events) {
      broadcast.push(...events)
      if (events.length === 0) pendingReleases += 1
      for (const [, q] of queues) q.push(...events)
      const wakes = []
      for (const [acct, wake] of waiters) { waiters.delete(acct); wakes.push(wake) }
      for (const wake of wakes) wake()
    },
  }
}

function makeCtx() {
  const captured = { messages: [], sessionHandler: undefined, approvalHandler: undefined, agents: [] }
  return {
    captured,
    ctx: {
      logger: { warn() {}, error() {}, info() {} },
      on(event, handler) {
        if (event === 'session/event') captured.sessionHandler = handler
        return () => {}
      },
      inject(_deps, cb) {
        cb({
          on(event, handler) {
            if (event === 'approval/request') captured.approvalHandler = handler
            return () => {}
          },
        })
      },
      get() { return undefined },
      agents: {
        get() { return undefined },
        async create({ sessionId }) {
          const agent = { id: sessionId, status: 'idle', session: { id: sessionId }, followup(message) { captured.messages.push(message) } }
          const handle = { agent, async dispose() {} }
          captured.agents.push(handle)
          return handle
        },
        async resume({ sessionId }) {
          const agent = { id: sessionId, status: 'idle', session: { id: sessionId }, followup(message) { captured.messages.push(message) } }
          const handle = { agent, async dispose() {} }
          captured.agents.push(handle)
          return handle
        },
      },
    },
  }
}

function textEvent(eventId, sender, body) {
  return { type: 'm.room.message', sender, event_id: eventId, content: { msgtype: 'm.text', body } }
}

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('waitFor timed out')
}

function lastTaskPanel(sends) {
  const panels = sends.filter((s) => s.kind === 'send' && s.body.body !== undefined && s.body.body.includes('任务面板'))
  return panels.length ? panels[panels.length - 1].body.body : undefined
}

test('matrix tasks: enqueue, cwd guide, approve, serial, reject, allow/deny', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-matrix-tasks-'))
  try {
    const hs = fakeHomeserver()
    const { ctx, captured } = makeCtx()
    const bridge = new MatrixBridge(ctx, {
      homeserverUrl: 'https://hs.example',
      accessToken: 'token',
      userId: USER_ID,
      allowedUserIds: [SENDER, OWNER],
      allowAllUsers: false,
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      chunkMaxChars: 4000,
      mergeTimeoutSecs: 5,
      approvalTimeoutSecs: 60,
      // 关键：打开数字分身模式，入站消息进任务队列
      digitalTwinMode: true,
      cwdCandidates: ['/work/a', '/work/b'],
      taskQueueMax: 10,
      stateDir: dir,
      fetchFn: hs.fetch,
      sleep: async () => {},
    })

    const startPromise = bridge.start()
    hs.deliver([])
    await startPromise

    // 1) 同事消息进队列（不直接执行）
    hs.deliver([textEvent('$m1', SENDER, '帮我画一张图')])
    await waitFor(() => hs.sends.some((s) => s.body.body !== undefined && s.body.body.includes('📥 新任务已入队')))
    assert.equal(captured.messages.length, 0, '数字分身模式下消息不应直接注入会话')

    // 2) /tasks 应显示 1 条待审
    hs.sends.length = 0
    hs.deliver([textEvent('$c1', OWNER, '/tasks')])
    await waitFor(() => lastTaskPanel(hs.sends) !== undefined)
    assert.ok(lastTaskPanel(hs.sends).includes('待审 1'))

    // 3) /approve 无 cwd -> 弹工作目录引导
    hs.sends.length = 0
    hs.deliver([textEvent('$c2', OWNER, '/approve 1')])
    await waitFor(() => hs.sends.some((s) => s.body.body !== undefined && s.body.body.includes('请为这个会话选择工作目录')))
    assert.ok(hs.sends.some((s) => s.body.body.includes('1. /work/a')))

    // 4) 回复编号选目录 -> cwd 设定并任务执行
    hs.sends.length = 0
    hs.deliver([textEvent('$c3', OWNER, '1')])
    await waitFor(() => captured.messages.length === 1)
    assert.match(captured.messages[0].content[0].text, /^\[群聊，你是@bot\]\n帮我画一张图$/)
    assert.equal(captured.messages[0].source.sender, SENDER)
    // 任务一执行完（模拟 turn/end）释放 runningTask
    captured.sessionHandler({ id: captured.agents[0].agent.id }, { type: 'turn/end', data: { reason: { kind: 'done' } }, agent: captured.agents[0].agent })

    // 5) 串行：再入两条，逐条批准（每次 approve 第 1 条待审），前一条 turn/end 后下一条才执行
    hs.deliver([textEvent('$m2', SENDER, '任务二'), textEvent('$m3', SENDER, '任务三')])
    await waitFor(() => hs.sends.some((s) => s.body.body !== undefined && s.body.body.includes('📥 新任务已入队')))
    hs.sends.length = 0
    hs.deliver([textEvent('$c4', OWNER, '/approve 1')]) // 第1条待审=任务二
    await waitFor(() => captured.messages.length === 2)
    assert.match(captured.messages[1].content[0].text, /^\[群聊，你是@bot\]\n任务二$/)
    // 任务二 turn 结束 -> 释放，任务三变为第1条待审
    captured.sessionHandler({ id: captured.agents[0].agent.id }, { type: 'turn/end', data: { reason: { kind: 'done' } }, agent: captured.agents[0].agent })
    hs.sends.length = 0
    hs.deliver([textEvent('$c5', OWNER, '/approve 1')]) // 现在第1条=任务三
    await waitFor(() => captured.messages.length === 3)
    assert.match(captured.messages[2].content[0].text, /^\[群聊，你是@bot\]\n任务三$/)
    captured.sessionHandler({ id: captured.agents[0].agent.id }, { type: 'turn/end', data: { reason: { kind: 'done' } }, agent: captured.agents[0].agent })

    // 6) 串行约束：running 时 approve 的新任务应排队等待 turn/end
    hs.deliver([textEvent('$m7', SENDER, '任务四')])
    await waitFor(() => hs.sends.some((s) => s.body.body.includes('📥 新任务已入队')))
    hs.sends.length = 0
    hs.deliver([textEvent('$c9', OWNER, '/approve 1')]) // 任务四立即执行（当前无 running）
    await waitFor(() => captured.messages.length === 4)
    assert.match(captured.messages[3].content[0].text, /^\[群聊，你是@bot\]\n任务四$/)
    // 此时任务四 running，再入任务五并 approve，应排队（不立即执行）
    hs.deliver([textEvent('$m8', SENDER, '任务五')])
    await waitFor(() => hs.sends.some((s) => s.body.body.includes('📥 新任务已入队')))
    hs.sends.length = 0
    hs.deliver([textEvent('$c10', OWNER, '/approve 1')])
    await waitFor(() => lastTaskPanel(hs.sends) !== undefined && lastTaskPanel(hs.sends).includes('已批准'))
    assert.equal(captured.messages.length, 4, '任务五应在任务四 turn/end 后才执行（串行）')
    captured.sessionHandler({ id: captured.agents[0].agent.id }, { type: 'turn/end', data: { reason: { kind: 'done' } }, agent: captured.agents[0].agent })
    await waitFor(() => captured.messages.length === 5)
    assert.match(captured.messages[4].content[0].text, /^\[群聊，你是@bot\]\n任务五$/)
    // 任务五自身 turn 结束 -> 释放 runningTask
    captured.sessionHandler({ id: captured.agents[0].agent.id }, { type: 'turn/end', data: { reason: { kind: 'done' } }, agent: captured.agents[0].agent })

    // 7) 黑名单：加 deny 规则后新消息自动拒绝
    hs.sends.length = 0
    hs.deliver([textEvent('$c6', OWNER, '/deny ' + SENDER + ' 机密')])
    await waitFor(() => hs.sends.some((s) => s.body.body.includes('已添加黑')))
    hs.deliver([textEvent('$m4', SENDER, '机密：xxxx')])
    await waitFor(() => hs.sends.some((s) => s.body.body !== undefined && s.body.body.includes('🚫 任务已被拒绝')))
    assert.ok(hs.sends.some((s) => s.body.body.includes('命中黑名单')))

    // 8) 白名单：加 allow 后命中自动批准执行
    hs.sends.length = 0
    hs.deliver([textEvent('$c7', OWNER, '/allow ' + SENDER + ' 日报')])
    await waitFor(() => hs.sends.some((s) => s.body.body.includes('已添加白')))
    hs.deliver([textEvent('$m5', SENDER, '日报：今日进展')])
    await waitFor(() => captured.messages.length === 6)
    assert.match(captured.messages[5].content[0].text, /^\[群聊，你是@bot\]\n日报：今日进展$/)

    // 9) /reject 拒绝待审（新任务即第 1 条待审）
    hs.deliver([textEvent('$m6', SENDER, '另一个任务')])
    await waitFor(() => hs.sends.some((s) => s.body.body.includes('📥 新任务已入队')))
    hs.sends.length = 0
    hs.deliver([textEvent('$c8', OWNER, '/reject 1')])
    await waitFor(() => hs.sends.some((s) => s.body.body.includes('🚫 已拒绝第')))
    assert.ok(hs.sends.some((s) => s.body.body.includes('已拒绝第 1')))

    await bridge.stop()
    const saved = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'))
    assert.equal(saved.roomCwds[ROOM_ID], '/work/a')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
