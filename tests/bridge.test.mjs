/**
 * dsh-matrix 端到端冒烟：用一个假 homeserver（fetch 接缝）验证
 * 入站合并注入、出站 assistant 投递、审批推送与聊天应答、命令、去重、状态落盘。
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

/** 迷你假 homeserver：/sync 长轮询挂起；deliver() 先把事件入队，
 *  再唤醒当前挂起的 sync；若 sync 尚未挂起，事件留待下一次 sync 读取。
 *  队列化设计让测试步骤与 sync 循环之间不存在时序竞态。 */
function fakeHomeserver() {
  const sends = []
  let waiter = null
  let pending = []
  let releaseCount = 0
  let token = 0
  return {
    sends,
    async fetch(url, init) {
      const path = new URL(url).pathname
      if (path.endsWith('/sync')) {
        const events = await new Promise((resolve, reject) => {
          if (pending.length > 0) {
            resolve(pending.splice(0))
            return
          }
          if (releaseCount > 0) {
            releaseCount -= 1
            resolve([])
            return
          }
          waiter = { resolve }
          init.signal?.addEventListener('abort', () => {
            waiter = null
            reject(new DOMException('aborted', 'AbortError'))
          }, { once: true })
        })
        token += 1
        return {
          ok: true,
          status: 200,
          async json() {
            return { next_batch: `s${token}`, rooms: { join: { [ROOM_ID]: { timeline: { events } } } } }
          },
        }
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
      pending.push(...events)
      if (events.length === 0) releaseCount += 1
      const w = waiter
      waiter = null
      if (w !== null) w.resolve(pending.splice(0))
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
        async create({ sessionId }) {
          const agent = {
            id: sessionId,
            status: 'idle',
            session: { id: sessionId },
            followup(message) {
              captured.messages.push(message)
            },
          }
          const handle = { agent, async dispose() {} }
          captured.agents.push(handle)
          return handle
        },
        async resume() {
          throw new Error('session persistence is not configured')
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

    // 首次 sync 由 deliver([]) 释放；此后进入长轮询循环。
    const startPromise = bridge.start()
    hs.deliver([])
    await startPromise

    // 1) 合并窗口：'你好..' + '世界!!' → 立即提交合并文本
    hs.deliver([textEvent('$e1', '你好..'), textEvent('$e2', '世界!!')])
    await waitFor(() => captured.messages.length === 1)
    const merged = captured.messages[0]
    assert.equal(merged.content[0].text, '你好\n世界')
    assert.equal(merged.source.kind, 'plugin')
    assert.equal(merged.source.plugin, 'dsh-matrix')
    const agentId = captured.agents[0].agent.id

    // 2) 出站：assistant/message → markdown 子集 HTML 投递
    captured.sessionHandler({ id: agentId }, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: '**hi** `x`' }] } },
    })
    await waitFor(() => hs.sends.some((s) => s.kind === 'send' && s.body.formatted_body === '<b>hi</b> <code>x</code>'))
    const assistant = hs.sends.find((s) => s.kind === 'send' && s.body.formatted_body !== undefined)
    assert.equal(assistant.body.msgtype, 'm.text')
    assert.equal(assistant.body.format, 'org.matrix.custom.html')
    assert.equal(assistant.body.formatted_body, '<b>hi</b> <code>x</code>')

    // 3) 去重：同 event_id 重放不产生第二条注入
    hs.deliver([textEvent('$e1', '你好..')])
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(captured.messages.length, 1)

    // 4) 审批：推送 → 聊天回复「批准」→ allowed-once
    const req = { agent: { id: agentId }, toolName: 'bash', reason: '跑命令', signal: undefined }
    const outcomePromise = captured.approvalHandler(req, async () => 'unavailable')
    await waitFor(() => hs.sends.some((s) => s.body.body !== undefined && s.body.body.includes('审批请求')))
    hs.deliver([textEvent('$r1', '批准')])
    assert.equal(await outcomePromise, 'allowed-once')

    // 5) 命令：/status 回显会话
    hs.deliver([textEvent('$c1', '/status')])
    await waitFor(() => hs.sends.some((s) => s.body.body !== undefined && s.body.body.includes('当前会话')))

    // 6) 停止：状态落盘（房间↔会话映射 + sync token）
    await bridge.stop()
    const saved = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'))
    assert.equal(saved.version, 1)
    assert.equal(saved.roomSessions[ROOM_ID].sessionId, agentId)
    assert.ok(typeof saved.syncToken === 'string' && saved.syncToken.startsWith('s'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
