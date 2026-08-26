/**
 * MatrixChannel 主动消息与房间事件投影测试。
 * 直接构造 MatrixChannel（mock fetch），验证：
 *   - sendDm：复用既有 1:1 房 vs create-room 两条路径
 *   - sendMentionText：构造含 m.mention 的 HTML 并调用 send
 *   - listJoinedRooms：/joined_rooms + 名称/成员数
 *   - 房间事件投影：/sync state 块的 join/leave/profile/room-name 触发 onRoomEvent，
 *     并主动失效成员/资料缓存。
 *
 * 跑法：npm run build 后 `node --test tests/matrix-channel.test.mjs`
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync } from 'node:fs'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MatrixChannel } from '../lib/matrix.js'
import { BridgeState } from '../lib/store.js'

const HS = 'https://hs.example'
const TOKEN = 'token'
const BOT = '@bot:hs.example'
const ROOM = '!room:hs.example'

/** 构造一个可断言的 mock fetch：记录所有调用，并按需返回。 */
function mockFetch(handler) {
  const calls = []
  const fetchFn = async (url, init = {}) => {
    const u = new URL(url)
    const path = u.pathname
    calls.push({ path, url: String(url), init })
    const result = handler({ path, u, init })
    if (result === undefined) {
      return { ok: true, status: 200, async json() { return {} } }
    }
    if (typeof result === 'object' && ('json' in result || 'arrayBuffer' in result)) return result
    return { ok: true, status: 200, async json() { return result } }
  }
  return { fetchFn, calls }
}

/** 用临时目录建 BridgeState（不落盘，仅满足构造签名）。 */
function makeState() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-matrix-channel-test-'))
  const state = new BridgeState(join(dir, 'state.json'))
  process.once('exit', () => rmSync(dir, { recursive: true, force: true }))
  return state
}

test('sendDm: 复用既有 1:1 房', async () => {
  const { fetchFn, calls } = mockFetch(({ path }) => {
    if (path.endsWith('/joined_rooms')) return { joined_rooms: ['!dm:hs.example'] }
    if (path.includes('/joined_members')) {
      // !dm 房含目标用户，2 人（1:1）
      return { joined: { '@target:hs.example': {}, '@bot:hs.example': {} } }
    }
    if (path.includes('/send/m.room.message/')) return { event_id: '$out' }
    return undefined
  })
  const ch = new MatrixChannel({
    homeserverUrl: HS, accessToken: TOKEN, userId: BOT, state: makeState(), fetchFn,
  })
  const res = await ch.sendDm('@target:hs.example', 'hello')
  assert.equal(res.roomId, '!dm:hs.example', '应复用既有私聊房')
  assert.ok(calls.some(c => c.path.includes('/joined_rooms')), '应先查已加入房间')
  assert.ok(calls.some(c => c.path.includes('/send/m.room.message/')), '应发送消息')
  const sendCall = calls.find(c => c.path.includes('/send/m.room.message/'))
  assert.equal(JSON.parse(sendCall.init.body).body, 'hello')
})

test('sendDm: 无既有私聊房则 create-room + invite', async () => {
  const { fetchFn, calls } = mockFetch(({ path }) => {
    if (path.endsWith('/joined_rooms')) return { joined_rooms: ['!group:hs.example'] }
    if (path.includes('/joined_members')) {
      // 群房不含目标用户（群聊）
      return { joined: { '@a:hs.example': {}, '@b:hs.example': {}, '@bot:hs.example': {} } }
    }
    if (path.endsWith('/createRoom')) return { room_id: '!newdm:hs.example' }
    if (path.includes('/send/m.room.message/')) return { event_id: '$out' }
    return undefined
  })
  const ch = new MatrixChannel({
    homeserverUrl: HS, accessToken: TOKEN, userId: BOT, state: makeState(), fetchFn,
  })
  const res = await ch.sendDm('@target:hs.example', 'hi')
  assert.equal(res.roomId, '!newdm:hs.example', '应创建新私聊房')
  assert.ok(calls.some(c => c.path.endsWith('/createRoom')), '应调用 createRoom')
  const createCall = calls.find(c => c.path.endsWith('/createRoom'))
  const body = JSON.parse(createCall.init.body)
  assert.ok(body.invite.includes('@target:hs.example'), 'createRoom 应 invite 目标用户')
  assert.equal(body.preset, 'private_chat')
})

test('sendMentionText: 构造 m.mention HTML 并发送', async () => {
  const { fetchFn, calls } = mockFetch(({ path }) => {
    if (path.includes('/profile/')) return { displayname: '小王' }
    if (path.includes('/send/m.room.message/')) return { event_id: '$out' }
    return undefined
  })
  const ch = new MatrixChannel({
    homeserverUrl: HS, accessToken: TOKEN, userId: BOT, state: makeState(), fetchFn,
  })
  await ch.sendMentionText(ROOM, '任务完成', ['@target:hs.example'])
  const sendCall = calls.find(c => c.path.includes('/send/m.room.message/'))
  const content = JSON.parse(sendCall.init.body)
  assert.equal(content.format, 'org.matrix.custom.html', '应使用 HTML 格式')
  assert.ok(content.formatted_body.includes('matrix.to/#/%40target%3Ahs.example'), 'HTML 应含 mention 锚点（URL 编码）')
  assert.ok(content.body.includes('@小王'), '纯文本兜底应含 @displayname')
})

test('listJoinedRooms: 返回名称与成员数', async () => {
  const { fetchFn, calls } = mockFetch(({ path }) => {
    if (path.endsWith('/joined_rooms')) return { joined_rooms: [ROOM] }
    if (path.includes('/state/m.room.name')) return { name: '测试群' }
    if (path.includes('/joined_members')) {
      return { joined: { '@a:hs': {}, '@b:hs': {}, '@bot:hs': {} } }
    }
    return undefined
  })
  const ch = new MatrixChannel({
    homeserverUrl: HS, accessToken: TOKEN, userId: BOT, state: makeState(), fetchFn,
  })
  const rooms = await ch.listJoinedRooms()
  assert.equal(rooms.length, 1)
  assert.equal(rooms[0].roomId, ROOM)
  assert.equal(rooms[0].name, '测试群')
  assert.equal(rooms[0].memberCount, 3)
})

test('room event: sync state join/leave/profile/room-name 触发 onRoomEvent 且去重', async () => {
  const events = []
  const { fetchFn } = mockFetch(({ path }) => {
    if (path.endsWith('/sync')) {
      return {
        next_batch: 's1',
        rooms: { join: { [ROOM]: { state: { events: [
          { type: 'm.room.member', state_key: '@alice:hs.example', sender: '@alice:hs.example', event_id: '$join1', origin_server_ts: 1000, content: { membership: 'join' } },
          { type: 'm.room.member', state_key: '@bob:hs.example', sender: '@bob:hs.example', event_id: '$leave1', origin_server_ts: 2000, content: { membership: 'leave' } },
          { type: 'm.room.member', state_key: '@carol:hs.example', sender: '@carol:hs.example', event_id: '$profile1', origin_server_ts: 3000, content: { displayname: '新名字', avatar_url: 'mxc://x' } },
          { type: 'm.room.name', event_id: '$name1', origin_server_ts: 4000, content: { name: '新群名' } },
          // 重复事件（同 event_id）不应再次触发
          { type: 'm.room.member', state_key: '@alice:hs.example', sender: '@alice:hs.example', event_id: '$join1', origin_server_ts: 1000, content: { membership: 'join' } },
        ] } } } },
      }
    }
    return undefined
  })
  const ch = new MatrixChannel({
    homeserverUrl: HS, accessToken: TOKEN, userId: BOT, state: makeState(), fetchFn,
    onRoomEvent: (e) => events.push(e),
  })
  await ch.start()
  await ch.stop()

  const kinds = events.map(e => e.kind)
  assert.ok(kinds.includes('join'), '应有 join 事件')
  assert.ok(kinds.includes('leave'), '应有 leave 事件')
  assert.ok(kinds.includes('profile'), '应有 profile 事件')
  assert.ok(kinds.includes('room-name'), '应有 room-name 事件')
  // 去重：$join1 出现两次但只触发一次
  assert.equal(events.filter(e => e.kind === 'join').length, 1, '重复事件应去重')
  const joinEvent = events.find(e => e.kind === 'join')
  assert.equal(joinEvent.userId, '@alice:hs.example')
})

test('room event: 自己（bot）的 join 不投影，避免自触发', async () => {
  const events = []
  const { fetchFn } = mockFetch(({ path }) => {
    if (path.endsWith('/sync')) {
      return { next_batch: 's1', rooms: { join: { [ROOM]: { state: { events: [
        { type: 'm.room.member', state_key: BOT, sender: BOT, event_id: '$selfjoin', content: { membership: 'join' } },
      ] } } } } }
    }
    return undefined
  })
  const ch = new MatrixChannel({
    homeserverUrl: HS, accessToken: TOKEN, userId: BOT, state: makeState(), fetchFn, onRoomEvent: (e) => events.push(e),
  })
  await ch.start()
  await ch.stop()
  assert.equal(events.length, 0, '自己入群不应投影为 join 事件')
})

test('resolveMediaUrl: mxc:// 解析为可下载 HTTP URL', () => {
  const ch = new MatrixChannel({
    homeserverUrl: HS, accessToken: TOKEN, userId: BOT, state: makeState(),
  })
  assert.equal(
    ch.resolveMediaUrl('mxc://hs.example/abc123'),
    'https://hs.example/_matrix/media/v3/download/hs.example/abc123',
    '应解析 mxc 为下载端点',
  )
  assert.equal(ch.resolveMediaUrl('not-a-mxc'), undefined, '非 mxc 返回 undefined')
})

test('downloadMedia: 下载字节并返回 mimetype/size', async () => {
  const { fetchFn, calls } = mockFetch(({ path }) => {
    if (path.includes('/_matrix/media/v3/download/')) {
      return {
        ok: true, status: 200,
        headers: new Headers({ 'content-type': 'image/png' }),
        async arrayBuffer() { return new TextEncoder().encode('PNGDATA').buffer },
      }
    }
    return undefined
  })
  const ch = new MatrixChannel({
    homeserverUrl: HS, accessToken: TOKEN, userId: BOT, state: makeState(), fetchFn,
  })
  const media = await ch.downloadMedia('mxc://hs.example/img1')
  assert.equal(media.size, 7, '字节长度')
  assert.equal(media.mimetype, 'image/png')
  assert.equal(new TextDecoder().decode(media.buffer), 'PNGDATA')
  assert.ok(calls.some(c => c.path.includes('/_matrix/media/v3/download/')), '应调用下载端点')
})

test('downloadMedia: 无效 mxc 抛错', async () => {
  const { fetchFn } = mockFetch(({ path }) => {
    if (path.includes('/_matrix/media/v3/download/')) return { ok: true, status: 200, async arrayBuffer() { return new ArrayBuffer(0) } }
    return undefined
  })
  const ch = new MatrixChannel({
    homeserverUrl: HS, accessToken: TOKEN, userId: BOT, state: makeState(), fetchFn,
  })
  await assert.rejects(() => ch.downloadMedia('not-a-mxc'), /无效的 mxc/, '应抛无效 mxc 错误')
})

test('inbound media: m.image 消息归一为 MediaBlock（含 filename/w/h/mxc）', async () => {
  const messages = []
  const { fetchFn } = mockFetch(({ path }) => {
    if (path.endsWith('/sync')) {
      return { next_batch: 's1', rooms: { join: { [ROOM]: { timeline: { events: [
        { type: 'm.room.message', sender: '@alice:hs.example', event_id: '$img1', origin_server_ts: 100, content: { msgtype: 'm.image', body: 'photo.png', url: 'mxc://hs.example/img1', info: { mimetype: 'image/png', size: 123, w: 800, h: 600 } } },
      ] } } } } }
    }
    return undefined
  })
  const ch = new MatrixChannel({
    homeserverUrl: HS, accessToken: TOKEN, userId: BOT, state: makeState(), fetchFn, onMessage: (m) => messages.push(m),
  })
  await ch.start()
  await ch.stop()
  assert.equal(messages.length, 1)
  const msg = messages[0]
  assert.equal(msg.media.length, 1)
  const m = msg.media[0]
  assert.equal(m.msgtype, 'm.image')
  assert.equal(m.mxc, 'mxc://hs.example/img1')
  assert.equal(m.width, 800)
  assert.equal(m.height, 600)
  assert.equal(m.mimetype, 'image/png')
  assert.equal(msg.text, '', '纯媒体消息 text 应为空')
})
