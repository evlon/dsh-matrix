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
      if (path.includes('/joined_members')) {
        // 3 人房间（>2 即群聊），用于验证上下文标签的人数渲染。
        return { ok: true, status: 200, async json() { return { joined: { '@a:hs': {}, '@b:hs': {}, '@bot:hs': {} } } } }
      }
      if (path.includes('/state/m.room.name')) {
        return { ok: true, status: 200, async json() { return { name: '测试群' } } }
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
  const captured = { messages: [], sessionHandler: undefined, approvalHandler: undefined, agents: [], appends: [], tools: [] }
  const agentById = new Map()
  const toolsService = {
    register(tool) { captured.tools.push(tool) },
    get(name) { return captured.tools.find((t) => t.name === name) },
  }
  const makeAgent = (id) => ({
    id,
    status: 'idle',
    ctx: {
      systemPrompt: {
        tools() {},
      },
    },
    session: {
      id,
      append(type, data, opts) { captured.appends.push({ type, data, opts }) },
      deriveMessages() { return [] },
    },
    followup(message) { captured.messages.push(message) },
  })
  const makeAgentCtx = () => ({
    systemPrompt: {
      tools() {},
    },
  })
  return {
    captured,
    ctx: {
      tools: toolsService,
      logger: { warn() {}, error() {}, info() {} },
      get(service) {
        if (service === 'agentPresets') return { async mount() {} }
        if (service === 'tools') return toolsService
        return undefined
      },
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
        get(id) { return agentById.get(String(id)) },
        async create({ sessionId, setup }) {
          const agent = makeAgent(sessionId)
          if (setup !== undefined) await setup({ ...makeAgentCtx(), agent })
          const handle = { agent, async dispose() {} }
          agentById.set(sessionId, agent)
          captured.agents.push(handle)
          return handle
        },
        async resume({ resumeSessionId, setup }) {
          const agent = makeAgent(resumeSessionId)
          if (setup !== undefined) await setup(makeAgentCtx())
          const handle = { agent, async dispose() {} }
          agentById.set(resumeSessionId, agent)
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
  let bridge
  try {
    const hs = fakeHomeserver()
    const { ctx, captured } = makeCtx()
    bridge = new MatrixBridge(ctx, {
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

    // 1) 合并窗口（群聊必须 @提及 bot 才响应；stripped 去掉 @bot 前缀后合并）
    hs.deliver([textEvent('$e1', '@bot 你好..'), textEvent('$e2', '@bot 世界!!')])
    await waitFor(() => captured.messages.length === 1)
    const merged = captured.messages[0]
    // 群聊上下文标签 + 当前消息（合并后已剥离 @bot 前缀）；群聊历史已改由工具按需获取。
    assert.match(merged.content[0].text, /^\[群聊「测试群」，约3人，你是@bot\]\n你好\n世界$/)
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

    // 3.5) 提及渲染格式 '名字:'（无 @ 无域名，部分客户端/桥接的 @提及 正文形态）也应触发响应
    hs.deliver([textEvent('$e3', 'bot: 你好!!')])
    await waitFor(() => captured.messages.length === 2)
    const mentioned = captured.messages[1]
    assert.match(mentioned.content[0].text, /\n你好$/)

    // 4) 审批
    const req = { agent: { id: agentId }, toolName: 'bash', reason: '跑命令', signal: undefined }
    const outcomePromise = captured.approvalHandler(req, async () => 'unavailable')
    await waitFor(() => hs.sends.some((s) => s.body.body !== undefined && s.body.body.includes('审批请求')))
    hs.deliver([textEvent('$r1', '批准')])
    assert.equal(await outcomePromise, 'allowed-once')

    // 5) /status（群聊必须 @提及 bot 才响应）
    hs.deliver([textEvent('$c1', '@bot /status')])
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

test('respondToAll 门控：true 响应群聊所有消息，false 只响应 @ 自己的', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-matrix-test-'))
  let bridge
  try {
    const hs = fakeHomeserver()
    const { ctx, captured } = makeCtx()
    bridge = new MatrixBridge(ctx, {
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
      respondToAll: false, // 只响应 @ 自己的消息
    })

    const startPromise = bridge.start()
    hs.deliver([])
    await startPromise

    // 1) 群聊未 @ 的消息：respondToAll=false → 静默
    hs.deliver([textEvent('$r1', '大家好，今天天气不错')])
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.equal(captured.messages.length, 0, 'respondToAll=false 时未 @ 的群消息不应响应')

    // 2) 群聊 @ 自己的消息：响应
    hs.deliver([textEvent('$r2', '@bot 你好!!')])
    await new Promise((resolve) => setTimeout(resolve, 400))
    assert.equal(captured.messages.length, 1, '@ 自己的消息应被投递到 agent')
    assert.match(captured.messages[0].content[0].text, /\n你好$/)
  } finally {
    if (bridge) await bridge.stop()
    await rm(dir, { recursive: true, force: true })
  }
})

test('bridge: matrix tools registration and execution', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-matrix-tools-test-'))
  let bridge
  try {
    const hs = fakeHomeserver()
    const { ctx, captured } = makeCtx()
    bridge = new MatrixBridge(ctx, {
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
      respondToAll: true, // 确保响应 @bot 消息
      matrixTools: true, // 启用工具注册
    })

    const startPromise = bridge.start()
    hs.deliver([])
    await startPromise

    // 触发 agent 创建（会触发 agentSetup 注册工具）
    // 发送完整消息（非合并）以立即触发 deliver
    hs.deliver([textEvent('$t1', '@bot 你好!!')])
    // 等待 followup 消息（表示 agent 已创建并开始处理）
    await waitFor(() => captured.messages.length >= 1)
    // 再等待 agent 创建完成（setup 与 agentSetup 需要异步完成）
    await waitFor(() => captured.agents.length >= 1)
    assert.ok(captured.agents.length >= 1, '应创建 agent')

    // 验证工具已注册：start() 时主账号一次性注册到全局 ToolRuntime（ctx.tools.register），
    // 与 agent 创建无关；4 个 matrix 工具都应出现。
    await waitFor(() => captured.tools.length >= 4)
    const schemaNames = captured.tools.map(t => t.name)
    assert.ok(schemaNames.includes('matrix_get_room_members'), '应包含 matrix_get_room_members')
    assert.ok(schemaNames.includes('matrix_get_user_info'), '应包含 matrix_get_user_info')
    const roomMembersTool = captured.tools.find(t => t.name === 'matrix_get_room_members')
    assert.ok(roomMembersTool && typeof roomMembersTool.execute === 'function', '注册的工具应带 execute 执行体')

    // 工具执行由 harness 负责：harness 调用 execute() 并把结果追加为 tool/result。
    // plugin 的 tool/call handler 只观察（记录 chatlog + 日志），不再自行 append。
    const agent = captured.agents[0].agent
    const callId = 'call-123'

    // 验证 execute 是真实执行入口，且 getRoomMembers 在「模型不传 roomId」时
    // 能回退到当前 agent 绑定房间（这是修复「执行工具报错/缺 roomId」的关键）。
    const execResult = await roomMembersTool.execute({}, { agent })
    assert.ok(execResult && Array.isArray(execResult.members), 'execute 应返回成员数组')
    assert.equal(execResult.roomId, '!room:hs.example', '未传 roomId 时应回退到绑定房间')

    // 验证 tool/call handler 仅观察：触发后应写 chatlog，但不应自行 append tool/result
    if (typeof captured.sessionHandler === 'function') {
      captured.sessionHandler(agent.session, {
        type: 'tool/call',
        data: {
          turn: 0,
          step: 0,
          callId,
          name: 'matrix_get_room_members',
          arguments: JSON.stringify({}),
        },
      })
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
    const toolResultAppends = captured.appends.filter(a => a.type === 'tool/result')
    assert.equal(toolResultAppends.length, 0, 'tool/call handler 不应自行 append tool/result（避免与 harness 重复追加冲突）')

    // 验证 deliver 不再注入 groupChatContext
    assert.ok(captured.messages.length >= 1, '应有 deliver 消息')
    const delivered = captured.messages[0]
    assert.ok(!delivered.content[0].text.includes('【本群最近对话'), 'deliver 不应包含群聊历史上下文')

  } finally {
    if (bridge) await bridge.stop()
    await rm(dir, { recursive: true, force: true })
  }
})

// 关键回归：tool/call handler 只观察，不自行 append tool/result（执行由 harness 通过
// provider.execute 完成并追加）。若 plugin 也 append，会导致与 harness 的 tool/result 重复，
// 触发会话校验报错（即线上「执行工具报错」）。同时验证 provider.execute 在 ctx.agents.get
// 被覆盖（模拟内核 live 衍生 id）时仍能独立执行——因为执行不再依赖 agent 查找。
test('bridge: tool/call handler observes only; execution via provider.execute', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-matrix-toolobserve-test-'))
  let bridge
  try {
    const hs = fakeHomeserver()
    const { ctx, captured } = makeCtx()
    bridge = new MatrixBridge(ctx, {
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
      respondToAll: true,
      matrixTools: true,
    })

    const startPromise = bridge.start()
    hs.deliver([])
    await startPromise

    hs.deliver([textEvent('$t1', '@bot 你好!!')])
    await waitFor(() => captured.tools.length >= 4)
    assert.ok(captured.tools.length >= 4, '应注册 4 个 matrix 工具')
    await waitFor(() => captured.agents.length >= 1)
    assert.ok(captured.agents.length >= 1, '应创建 agent')

    const agent = captured.agents[0].agent
    const callId = 'call-xyz'

    // 触发 tool/call：handler 应只观察（写 chatlog），不 append tool/result。
    if (typeof captured.sessionHandler === 'function') {
      captured.sessionHandler(agent.session, {
        type: 'tool/call',
        data: {
          turn: 0,
          step: 0,
          callId,
          name: 'matrix_get_room_members',
          arguments: JSON.stringify({}),
        },
      })
    }
    await new Promise((resolve) => setTimeout(resolve, 50))

    const appends = captured.appends.filter(a => a.type === 'tool/result')
    assert.equal(appends.length, 0, 'tool/call handler 不应自行 append tool/result')

    // 真实执行路径：harness 调用 execute()，且不传 roomId 也能回退到绑定房间。
    const tool = captured.tools.find(t => t.name === 'matrix_get_room_members')
    const execResult = await tool.execute({}, { agent })
    assert.ok(execResult && Array.isArray(execResult.members), 'execute 应返回成员数组')
    assert.equal(execResult.roomId, '!room:hs.example', '未传 roomId 应回退到绑定房间')
  } finally {
    if (bridge) await bridge.stop()
    await rm(dir, { recursive: true, force: true })
  }
})

// 补充：matrixTools=false 时不注册工具
test('bridge: matrix tools disabled', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-matrix-tools-disabled-test-'))
  let bridge
  try {
    const hs = fakeHomeserver()
    const { ctx, captured } = makeCtx()
    bridge = new MatrixBridge(ctx, {
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
      matrixTools: false, // 关闭工具注册
    })

    const startPromise = bridge.start()
    hs.deliver([])
    await startPromise

    assert.equal(captured.tools.length, 0, 'matrixTools=false 时不应注册工具')

  } finally {
    if (bridge) await bridge.stop()
    await rm(dir, { recursive: true, force: true })
  }
})

// 自愈：resume 到含「孤立 tool-result」历史（tool/result 前面没有对应 tool_calls）
// 的会话时，createRoomAgent 应丢弃它、代数 +1、用新的确定性 id 重建，
// 否则每次请求都会被 LLM API 以 INVALID_REQUEST 拒绝。
test('bridge: orphan tool-result history triggers session rebuild with new epoch', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-matrix-orphan-rebuild-test-'))
  let bridge
  try {
    const hs = fakeHomeserver()
    const { ctx, captured } = makeCtx()
    // 预置一个「损坏」的绑定：state 已绑定 session id，且该 session 的
    // deriveMessages 返回带孤立 tool-result 的历史（assistant 无 tool_calls）。
    const brokenId = 'matrix-ai-niukunliang-deadbeef'
    const brokenSession = {
      id: brokenId,
      append() {},
      deriveMessages() {
        return [
          { role: 'assistant', content: [{ type: 'text', text: 'hi' }], tool_calls: [] },
          { role: 'user', content: [{ type: 'tool-result', toolCallId: 'orphan-1' }] },
        ]
      },
    }
    const brokenAgent = { id: brokenId, status: 'idle', session: brokenSession, followup() {} }
    // resume 时返回损坏 agent；create 时正常建新 agent
    const originalCreate = ctx.agents.create.bind(ctx.agents)
    ctx.agents.resume = async ({ resumeSessionId }) => {
      if (String(resumeSessionId) === brokenId) {
        const handle = { agent: brokenAgent, async dispose() {} }
        captured.agents.push(handle)
        return handle
      }
      throw new Error('has no persisted log')
    }
    ctx.agents.get = () => undefined

    bridge = new MatrixBridge(ctx, {
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
      matrixTools: true,
    })

    // 手动建立「坏绑定」：state.roomSession 返回 brokenId
    const account = bridge['accounts'][0]
    account['state'].setRoomSession('!room:hs.example', brokenId)

    const startPromise = bridge.start()
    hs.deliver([])
    await startPromise

    hs.deliver([textEvent('$t1', '@bot 你好!!')])
    // 自愈后应创建新 agent（captured.agents 中除损坏 agent 外的新建项），
    // 且其 session id 带 -e1 后缀（epoch 1）。
    await waitFor(() => captured.agents.some(h => h.agent.id.includes('-e1')))
    const rebuilt = captured.agents.find(h => h.agent.id.includes('-e1'))
    assert.ok(rebuilt, '损坏历史应触发带新 epoch 的会话重建')
    // 房间绑定应指向新 session
    assert.equal(account['state'].roomSession('!room:hs.example'), rebuilt.agent.id)
  } finally {
    if (bridge) await bridge.stop()
    await rm(dir, { recursive: true, force: true })
  }
})
