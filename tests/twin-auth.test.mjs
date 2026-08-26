/**
 * dsh-matrix 多账号 + Owner 授权端到端测试
 * - 主账号 + 一个分身账号（Owner 为 @owner:hs）
 * - 审批：分身工具请求 → 房间推送 → Owner 回复「批准」→ 记忆授权写库
 * - 命令：/auth list、/auth revoke <tool>（仅 Owner）；非 Owner 被拒
 * - 路由：分身仅响应 @提及
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { MatrixBridge } from '../lib/bridge.js'

const ROOM_ID = '!room:hs.example'
const MAIN_USER_ID = '@bot-main:hs.example'
const TWIN_USER_ID = '@bot-twin:hs.example'
const OWNER_ID = '@owner:hs.example'
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
      if (path.includes('/state/m.room.name')) return { ok: true, status: 200, async json() { return { name: '数智化部全员群' } } }
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

function textEvent(eventId, body, sender = SENDER) {
  return { type: 'm.room.message', sender, event_id: eventId, content: { msgtype: 'm.text', body } }
}

function makeCtx() {
  const captured = { messages: [], sessionHandler: undefined, approvalHandler: undefined, agents: [], titles: [] }
  return {
    captured,
    ctx: {
      logger: { warn() {}, error() {}, info() {} },
      on(event, handler) {
        if (event === 'session/event') captured.sessionHandler = handler
        return () => {}
      },
      get(service) {
        if (service === 'sessionTitle') {
          return {
            rename(session, title) { captured.titles.push({ id: session.id, title }) },
          }
        }
        return undefined
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
          const agent = { id: sessionId, status: 'idle', ctx: { systemPrompt: { tools() {} } }, session: { id: sessionId }, followup(message) { captured.messages.push(message) } }
          const handle = { agent, async dispose() {} }
          captured.agents.push(handle)
          return handle
        },
        async resume({ resumeSessionId }) {
          const agent = { id: resumeSessionId, status: 'idle', ctx: { systemPrompt: { tools() {} } }, session: { id: resumeSessionId }, followup(message) { captured.messages.push(message) } }
          const handle = { agent, async dispose() {} }
          captured.agents.push(handle)
          return handle
        },
      },
    },
  }
}

async function waitFor(predicate, label, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) { console.log('✓', label); return }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  console.log('✗ TIMEOUT:', label)
  throw new Error('waitFor timed out: ' + label)
}

test('multi-account + owner auth: twin approval, auth commands, routing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-matrix-test-twin-'))
  try {
    const hs = fakeHomeserver()
    const { ctx, captured } = makeCtx()

    const bridge = new MatrixBridge(ctx, {
      homeserverUrl: 'https://hs.example',
      accessToken: 'main-token',
      userId: MAIN_USER_ID,
      allowedUserIds: [SENDER, OWNER_ID],
      allowAllUsers: false,
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      chunkMaxChars: 4000,
      mergeTimeoutSecs: 5,
      approvalTimeoutSecs: 60,
      stateDir: dir,
      fetchFn: hs.fetch,
      sleep: async () => {},
      digitalTwins: [
        {
          userId: TWIN_USER_ID,
          accessToken: 'twin-token',
          tokenEnv: '',
          owner: OWNER_ID,
          role: 'twin',
          respondToAll: false,
          provider: 'deepseek-official',
          model: 'deepseek-v4-flash',
        },
      ],
      owner: OWNER_ID,
    })

    // 双账号同步启动；deliver([]) 按账号数调用（每个账号各释放一次启动 sync）。
    const startPromise = bridge.start()
    hs.deliver([])
    hs.deliver([])
    await startPromise

    // 1) 群聊必须 @提及 才响应：主账号被 @ 后响应；用 !! 立即提交，避免 5s 合并窗口拖慢测试
    hs.deliver([textEvent('$m1', '@bot-main 你好!!')])
    await waitFor(() => captured.messages.length === 1, 'main responds')
    // 注入格式：群聊标签 + 当前消息（已剥 @提及）；群聊历史已改由工具按需获取
    assert.match(captured.messages[0].content[0].text, /^\[群聊「数智化部全员群」，你是@bot-main\]\n你好$/)
    captured.messages.length = 0

    // 1.5) 会话标题 = Matrix 房间名（rename 被调用且标题正确）
    await waitFor(() => captured.titles.length >= 1, 'session titled from room name')
    const titled = captured.titles.find((t) => t.title === '数智化部全员群')
    assert.ok(titled, 'title should equal matrix room name')

    // 2) 分身收到 @提及 → 响应（主账号应让位，只有 twin 注入）
    hs.deliver([textEvent('$t1', `@bot-twin:hs.example 你好!!`)])
    await waitFor(() => captured.messages.length === 1, 'twin responds')
    const twinMsg = captured.messages.find((m) => m.content[0].text.includes('你好'))
    assert.ok(twinMsg, 'twin should have been the only responder')
    captured.messages.length = 0

    // 3) 分身工具请求 → 房间推送审批
    const twinAgentId = captured.agents[1].agent.id
    const req = { agent: { id: twinAgentId }, toolName: 'bash', reason: 'run cmd', signal: undefined }
    const outcomePromise = captured.approvalHandler(req, async () => 'unavailable')
    await waitFor(() => hs.sends.some((s) => s.body.body?.includes('审批请求')), 'approval push')
    const approval = hs.sends.find((s) => s.body.body?.includes('仅 Owner @owner 可以应答。'))
    assert.ok(approval, 'approval push should contain owner note')
    assert.ok(approval.body.body.includes('仅 Owner @owner 可以应答。'))

    // 4) Owner 批准 → 记忆授权写库
    hs.deliver([textEvent('$a1', '批准', OWNER_ID)])
    assert.equal(await outcomePromise, 'allowed-once')

    // 5) /auth list 显示记忆授权（必须 @提及 分身，主账号不截胡）
    hs.deliver([textEvent('$l1', '@bot-twin:hs.example /auth list', OWNER_ID)])
    await waitFor(() => hs.sends.some((s) => s.body.body?.includes('记忆授权')), 'auth list')
    // 找到分身的回复（含 @bot-twin）
    const list = hs.sends.find((s) => s.body.body?.includes('记忆授权') && s.body.body.includes('@bot-twin'))
    assert.ok(list, 'should find twin auth list reply')
    assert.ok(list.body.body.includes('`bash`'), 'bash should be in allowed tools list')

    // 6) 非 Owner（SENDER）@提及分身尝试吊销 → 拒绝
    hs.deliver([textEvent('$r1', '@bot-twin:hs.example /auth revoke bash', SENDER)])
    await waitFor(() => hs.sends.some((s) => s.body.body?.includes('只有 Owner')), 'non-owner denied')

    // 7) Owner 吊销
    hs.deliver([textEvent('$r2', '@bot-twin:hs.example /auth revoke-all', OWNER_ID)])
    await waitFor(() => hs.sends.some((s) => s.body.body?.includes('已吊销')), 'owner revoke-all')

    await bridge.stop()

    // 8) 记忆授权库落盘后已清空
    const auth = JSON.parse(await readFile(join(dir, 'auth-store.json'), 'utf8'))
    assert.equal(auth.records.length, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
