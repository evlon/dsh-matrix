/**
 * dsh-matrix 端到端冒烟：用一个假 homeserver（fetch 接缝）验证
 * 入站合并注入、出站 assistant 投递、审批推送与聊天应答、命令、去重、状态落盘。
 *
 * 假 homeserver 按每个 Bearer token 维护独立事件队列 + waiter：
 * 真实 Matrix 房间中所有成员收到同样事件；多账号桥接场景互不覆盖。
 *
 * 跑法：npm run build 后 `node --test tests/bridge.test.mjs`
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

function fakeHomeserver() {
  const sends = []
  const queues = new Map()     // acct -> events[]
  const waiters = new Map()    // acct -> wake()
  const started = new Set()    // 已完成首次启动 sync 的账号
  const broadcast = []         // 注册前的历史广播（新账号注册时拿副本）
  let pendingReleases = 0      // 全局释放配额：deliver([]) 一次 = 一个账号的启动 sync
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
          // 每个账号仅首次启动 sync 消耗一个 release 配额（补偿 start() 异步竞态）
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

function textEvent(eventId, body) {
  return { type: 'm.room.message', sender: SENDER, event_id: eventId, content: { msgtype: 'm.text', body } }
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

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('waitFor timed out')
}

test('bridge end-to-end: merge, assistant delivery, approval, commands, dedup, state', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-matrix-test-'))
  try {
    const hs = fakeHomeserver()
    const { ctx, captured } = makeCtx()
    const bridge = new MatrixBridge(ctx, {
      homeserverUrl: 'https://hs.example',
      accessToken: 'token',
      userId: USER_ID,
      allowedUserIds: [SENDER],
      allowAllUsers: false,
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      chunkMaxChars: 4000,
      mergeTimeoutSecs: 5,
      approvalTimeoutSecs: 60,
      stateDir: dir,
      fetchFn: hs.fetch,
      sleep: async () => {},
    })

    const startPromise = bridge.start()
    hs.deliver([])
    await startPromise

    // 1) 合并窗口
    hs.deliver([textEvent('$e1', '你好..'), textEvent('$e2', '世界!!')])
    await waitFor(() => captured.messages.length === 1)
    const merged = captured.messages[0]
    assert.equal(merged.content[0].text, '你好\n世界')
    assert.equal(merged.source.kind, 'user')
    assert.equal(merged.source.sender, SENDER)
    const agentId = captured.agents[0].agent.id

    // 2) 出站：markdown 子集 HTML
    captured.sessionHandler({ id: agentId }, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: '**hi** `x`' }] } },
    })
    await waitFor(() => hs.sends.some((s) => s.kind === 'send' && s.body.formatted_body === '<b>hi</b> <code>x</code>'))
    const assistant = hs.sends.find((s) => s.kind === 'send' && s.body.formatted_body !== undefined)
    assert.equal(assistant.body.msgtype, 'm.text')
    assert.equal(assistant.body.format, 'org.matrix.custom.html')
    assert.equal(assistant.body.formatted_body, '<b>hi</b> <code>x</code>')

    // 3) 去重
    hs.deliver([textEvent('$e1', '你好..')])
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(captured.messages.length, 1)

    // 4) 审批
    const req = { agent: { id: agentId }, toolName: 'bash', reason: '跑命令', signal: undefined }
    const outcomePromise = captured.approvalHandler(req, async () => 'unavailable')
    await waitFor(() => hs.sends.some((s) => s.body.body !== undefined && s.body.body.includes('审批请求')))
    hs.deliver([textEvent('$r1', '批准')])
    assert.equal(await outcomePromise, 'allowed-once')

    // 5) /status
    hs.deliver([textEvent('$c1', '/status')])
    await waitFor(() => hs.sends.some((s) => s.body.body !== undefined && s.body.body.includes('当前会话')))

    await bridge.stop()
    const saved = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'))
    assert.equal(saved.version, 1)
    assert.equal(saved.roomSessions[ROOM_ID].sessionId, agentId)
    assert.ok(typeof saved.syncToken === 'string' && saved.syncToken.startsWith('s'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
