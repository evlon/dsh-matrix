/**
 * Matrix 专属工具：通过 ctx.tools.register(defineTool(...)) 注册到 ToolRuntime，
 * 一次性获得「模型可见 schema + 可执行体」。
 * 之前使用 systemPrompt.tools() 只提供 schema，导致模型调用时执行失败
 * （unknown tool），现改为原生工具注册方式。
 * @module dsh-matrix/tools
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { MatrixChannel } from './matrix.js'
import type { MatrixMember, MatrixUserInfo, MatrixRoomMessage } from './matrix.js'

/** 轻量级工具诊断日志：写入 stateDir/diagnostics.log，不依赖 ctx.logger（工具层无 ctx 注入）。 */
let _logfn: ((message: string, ...args: unknown[]) => void) | undefined
export function setToolLogger(fn: (message: string, ...args: unknown[]) => void): void {
  _logfn = fn
}
function toolLog(message: string, ...args: unknown[]): void {
  _logfn?.(`[dsh-matrix:tools] ${message}`, ...args)
}

/** 4 个 Matrix 专属工具的名称常量 */
export const MATRIX_TOOL_NAMES = {
  GET_ROOM_MEMBERS: 'matrix_get_room_members',
  GET_RECENT_MESSAGES: 'matrix_get_recent_messages',
  GET_ROOM_INFO: 'matrix_get_room_info',
  GET_USER_INFO: 'matrix_get_user_info',
  SEND_ROOM_MESSAGE: 'matrix_send_room_message',
  SEND_DM: 'matrix_send_dm',
  MENTION_MEMBER: 'matrix_mention_member',
  LIST_ROOMS: 'matrix_list_rooms',
  GET_MEDIA: 'matrix_get_media',
} as const

export type MatrixToolName = typeof MATRIX_TOOL_NAMES[keyof typeof MATRIX_TOOL_NAMES]

/** 通过 ctx.tools.register(definition) 注册矩阵工具的依赖。 */
export interface MatrixToolDeps {
  /** Matrix 通道层，用于执行真实的 API 调用。 */
  channel: MatrixChannel
  /** sessionId → roomId 反查（来自 BridgeState 的 roomSessions 映射）。 */
  roomForSession: (sessionId: string) => string | undefined
  /**
   * 主动消息（send_dm/send_room_message/mention_member）执行前的授权检查。
   * 返回 true 表示允许发送；false 表示拒绝（桥接层将抛出含原因的错）。
   * 未提供时回退为「允许」（即不强制授权，由配置关闭）。
   */
  approveProactiveSend?: (toolName: string, args: Record<string, unknown>, exec: ToolRunContext) => Promise<boolean> | boolean
  /**
   * 媒体保存目录：matrix_get_media 把下载的媒体字节写入该目录并返回本地路径。
   * 未提供时工具只返回 base64 与元信息（不落盘）。
   */
  mediaDirForSession?: (sessionId: string) => string | undefined
}

/** 根据显式 roomId 或当前 agent 绑定的房间，解析实际的 roomId。 */
function resolveRoomId(
  args: Record<string, unknown>,
  exec: ToolRunContext,
  deps: MatrixToolDeps,
): string {
  const explicit = args.roomId as string | undefined
  if (typeof explicit === 'string' && explicit.length > 0) return explicit
  const sessionId = exec.agent?.id
  if (sessionId !== undefined) {
    const bound = deps.roomForSession(sessionId)
    if (bound !== undefined) return bound
  }
  throw new Error(
    '缺少 roomId 参数，且当前会话未绑定 Matrix 房间，无法确定目标房间',
  )
}

/** 渲染器：把工具返回值格式化为模型可见的 ContentBlock[]。 */
function renderResult(_args: Record<string, unknown>, value: unknown): ContentBlock[] {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

/** ---------- 4 个 Matrix 工具的 defineTool 定义 ---------- */

function makeGetRoomMembersTool(deps: MatrixToolDeps) {
  return defineTool({
    name: MATRIX_TOOL_NAMES.GET_ROOM_MEMBERS,
    description: '获取当前会话所在房间的成员列表（joined_members 投影）。不传 roomId 时自动使用当前会话绑定的房间，也可显式指定 roomId 查询其他房间。',
    parameters: {
      roomId: {
        type: 'string',
        description: 'Matrix 房间 ID（如 !roomid:server.com），可选，不传则使用当前会话所在房间',
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          roomId: { type: 'string', required: true },
          members: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              properties: {
                userId: { type: 'string' },
                displayName: { type: 'string' },
                avatarUrl: { type: 'string' },
              },
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      } as const,
      render: renderResult,
    },
    timeoutMs: 30_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const roomId = resolveRoomId(args, exec, deps)
      toolLog(`execute getRoomMembers roomId=${roomId}`)
      const members = await deps.channel.getRoomMembers(roomId)
      if (members === undefined) {
        throw new Error('获取成员失败或房间不存在')
      }
      return { roomId, members }
    },
  })
}

function makeGetRecentMessagesTool(deps: MatrixToolDeps) {
  return defineTool({
    name: MATRIX_TOOL_NAMES.GET_RECENT_MESSAGES,
    description: '获取当前会话所在房间的最近 N 条消息（默认 20 条，最多 100 条）。不传 roomId 时自动使用当前会话绑定的房间，也可显式指定 roomId 查询其他房间。',
    parameters: {
      roomId: {
        type: 'string',
        description: 'Matrix 房间 ID（如 !roomid:server.com），可选，不传则使用当前会话所在房间',
      },
      limit: {
        type: 'integer',
        description: '要获取的消息条数，默认 20，最大 100',
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          roomId: { type: 'string', required: true },
          messages: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              properties: {
                eventId: { type: 'string' },
                sender: { type: 'string' },
                body: { type: 'string' },
                timestamp: { type: 'integer' },
              },
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      } as const,
      render: renderResult,
    },
    timeoutMs: 30_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const roomId = resolveRoomId(args, exec, deps)
      const limit = typeof args.limit === 'number' ? Math.max(1, Math.min(100, args.limit)) : 20
      toolLog(`execute getRecentMessages roomId=${roomId} limit=${limit}`)
      const messages = await deps.channel.getRecentMessages(roomId, limit)
      return { roomId, messages }
    },
  })
}

function makeGetRoomInfoTool(deps: MatrixToolDeps) {
  return defineTool({
    name: MATRIX_TOOL_NAMES.GET_ROOM_INFO,
    description: '获取当前会话所在房间的基本信息（房间名、人数等）。不传 roomId 时自动使用当前会话绑定的房间，也可显式指定 roomId 查询其他房间。',
    parameters: {
      roomId: {
        type: 'string',
        description: 'Matrix 房间 ID（如 !roomid:server.com），可选，不传则使用当前会话所在房间',
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          roomId: { type: 'string', required: true },
          roomName: { type: 'string' },
          memberCount: { type: 'integer' },
        },
        additionalProperties: false,
      } as const,
      render: renderResult,
    },
    timeoutMs: 30_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const roomId = resolveRoomId(args, exec, deps)
      toolLog(`execute getRoomInfo roomId=${roomId}`)
      const [roomName, memberCount] = await Promise.all([
        deps.channel.getRoomName(roomId),
        deps.channel.getRoomMemberCount(roomId),
      ])
      return {
        roomId,
        ...(roomName !== undefined ? { roomName } : {}),
        ...(memberCount !== undefined ? { memberCount } : {}),
      }
    },
  })
}

function makeGetUserInfoTool(deps: MatrixToolDeps) {
  return defineTool({
    name: MATRIX_TOOL_NAMES.GET_USER_INFO,
    description: '获取指定用户的显示名称和头像 URL。可先调用 matrix_get_room_members 获取房间成员列表，从中拿到 userId 后再调用此工具查询具体用户信息。',
    parameters: {
      userId: {
        type: 'string',
        required: true,
        description: 'Matrix user ID（如 @user:server.com）',
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          userId: { type: 'string', required: true },
          info: {
            type: 'object',
            required: true,
            properties: {
              userId: { type: 'string' },
              displayName: { type: 'string' },
              avatarUrl: { type: 'string' },
            },
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      } as const,
      render: renderResult,
    },
    timeoutMs: 30_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const userId = args.userId
      if (!userId || typeof userId !== 'string') {
        throw new Error('缺少 userId 参数')
      }
      toolLog(`execute getUserInfo userId=${userId}`)
      const info = await deps.channel.getUserInfo(userId)
      if (info === undefined) {
        throw new Error('获取用户信息失败或用户不存在')
      }
      return { userId, info }
    },
  })
}

/** 主动消息工具执行前的授权门：走 deps.approveProactiveSend；拒绝则抛错阻止发送。 */
async function guardProactiveSend(
  toolName: string,
  args: Record<string, unknown>,
  exec: ToolRunContext,
  deps: MatrixToolDeps,
): Promise<void> {
  if (deps.approveProactiveSend === undefined) return
  const ok = await deps.approveProactiveSend(toolName, args, exec)
  if (!ok) {
    throw new Error(
      `主动发送被拒绝：${toolName} 未获授权。请让房间 Owner 批准后重试，或调整配置允许主动发送。`,
    )
  }
}

function makeSendRoomMessageTool(deps: MatrixToolDeps) {
  return defineTool({
    name: MATRIX_TOOL_NAMES.SEND_ROOM_MESSAGE,
    description: '向当前会话所在房间发送一条文本消息。不传 roomId 时自动使用当前会话绑定的房间，也可显式指定 roomId。用于主动向群里/私聊发言。',
    parameters: {
      roomId: {
        type: 'string',
        description: 'Matrix 房间 ID（如 !roomid:server.com），可选，不传则使用当前会话所在房间',
      },
      text: {
        type: 'string',
        required: true,
        description: '要发送的纯文本正文',
      },
      html: {
        type: 'string',
        description: '可选的 HTML 富文本正文（org.matrix.custom.html）；不传则用 text 作为纯文本',
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          roomId: { type: 'string', required: true },
          ok: { type: 'boolean', required: true },
        },
        additionalProperties: false,
      } as const,
      render: renderResult,
    },
    timeoutMs: 60_000,
    // 主动发消息有副作用，禁止并行调用，避免重复发送。
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const roomId = resolveRoomId(args, exec, deps)
      const text = args.text
      if (typeof text !== 'string' || text.trim() === '') throw new Error('缺少 text 参数')
      await guardProactiveSend(MATRIX_TOOL_NAMES.SEND_ROOM_MESSAGE, args, exec, deps)
      toolLog(`execute sendRoomMessage roomId=${roomId} text=${text.slice(0, 40)}`)
      const html = typeof args.html === 'string' ? args.html : undefined
      await deps.channel.sendText(roomId, text, html)
      return { roomId, ok: true }
    },
  })
}

function makeSendDmTool(deps: MatrixToolDeps) {
  return defineTool({
    name: MATRIX_TOOL_NAMES.SEND_DM,
    description: '主动给指定 Matrix 用户发送私聊消息。若已存在与该用户的私聊房则复用，否则自动创建私聊房并发送。用于私聊某人。',
    parameters: {
      userId: {
        type: 'string',
        required: true,
        description: '目标 Matrix user ID（如 @user:server.com）',
      },
      text: {
        type: 'string',
        required: true,
        description: '要发送的纯文本正文',
      },
      html: {
        type: 'string',
        description: '可选的 HTML 富文本正文',
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          roomId: { type: 'string', required: true },
          ok: { type: 'boolean', required: true },
        },
        additionalProperties: false,
      } as const,
      render: renderResult,
    },
    timeoutMs: 60_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const userId = args.userId
      if (typeof userId !== 'string' || userId === '') throw new Error('缺少 userId 参数')
      const text = args.text
      if (typeof text !== 'string' || text.trim() === '') throw new Error('缺少 text 参数')
      await guardProactiveSend(MATRIX_TOOL_NAMES.SEND_DM, args, exec, deps)
      toolLog(`execute sendDm to=${userId} text=${text.slice(0, 40)}`)
      const html = typeof args.html === 'string' ? args.html : undefined
      const { roomId } = await deps.channel.sendDm!(userId, text, html)
      return { roomId, ok: true }
    },
  })
}

function makeMentionMemberTool(deps: MatrixToolDeps) {
  return defineTool({
    name: MATRIX_TOOL_NAMES.MENTION_MEMBER,
    description: '向当前会话所在房间发送消息并 @ 一个或多个成员（HTML mention 锚点）。用于任务完成时 @ 某人、点名同事等。',
    parameters: {
      roomId: {
        type: 'string',
        description: 'Matrix 房间 ID，可选，不传则使用当前会话所在房间',
      },
      text: {
        type: 'string',
        required: true,
        description: '要发送的纯文本正文（可附带对被 @ 成员的说明）',
      },
      userIds: {
        type: 'array',
        required: true,
        items: { type: 'string', description: '要 @ 的 Matrix user ID' },
        description: '要 @ 的一个或多个成员 userId',
      },
      html: {
        type: 'string',
        description: '可选的 HTML 富文本正文（将自动追加 @ 锚点）',
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          roomId: { type: 'string', required: true },
          mentioned: {
            type: 'array',
            required: true,
            items: { type: 'string' },
          },
          ok: { type: 'boolean', required: true },
        },
        additionalProperties: false,
      } as const,
      render: renderResult,
    },
    timeoutMs: 60_000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const roomId = resolveRoomId(args, exec, deps)
      const text = args.text
      if (typeof text !== 'string' || text.trim() === '') throw new Error('缺少 text 参数')
      const userIds = Array.isArray(args.userIds) ? args.userIds.filter((u): u is string => typeof u === 'string' && u !== '') : []
      if (userIds.length === 0) throw new Error('缺少 userIds 参数（至少 @ 一个成员）')
      await guardProactiveSend(MATRIX_TOOL_NAMES.MENTION_MEMBER, args, exec, deps)
      // 校验目标都是房间成员，避免 @ 非成员。
      const members = await deps.channel.getRoomMembers(roomId)
      if (members !== undefined) {
        const valid = new Set(members.map((m) => m.userId))
        const invalid = userIds.filter((u) => !valid.has(u))
        if (invalid.length > 0) {
          throw new Error(`以下 userId 不是房间成员，无法 @：${invalid.join(', ')}`)
        }
      }
      toolLog(`execute mentionMember roomId=${roomId} users=${userIds.join(',')} text=${text.slice(0, 40)}`)
      const html = typeof args.html === 'string' ? args.html : undefined
      await deps.channel.sendMentionText!(roomId, text, userIds, html)
      return { roomId, mentioned: userIds, ok: true }
    },
  })
}

function makeGetMediaTool(deps: MatrixToolDeps) {
  return defineTool({
    name: MATRIX_TOOL_NAMES.GET_MEDIA,
    description: '下载 Matrix 媒体（图片/文件/音视频）内容。传 mxc:// URL，返回本地保存路径与元信息；配置了媒体目录时落盘，否则返回 base64 与大小。用于处理群里发的图片、文件等。',
    parameters: {
      mxc: {
        type: 'string',
        required: true,
        description: 'Matrix 媒体 URL（mxc://server/mediaid），可从 matrix_get_recent_messages 或入站消息里取得',
      },
      filename: {
        type: 'string',
        description: '可选的保存文件名（含扩展名）；不传则根据 mimetype/内容推断',
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          savedPath: { type: 'string' },
          filename: { type: 'string' },
          mimetype: { type: 'string' },
          size: { type: 'integer', required: true },
          base64: { type: 'string' },
        },
        additionalProperties: false,
      } as const,
      render: renderResult,
    },
    timeoutMs: 120_000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const mxc = args.mxc
      if (typeof mxc !== 'string' || mxc === '') throw new Error('缺少 mxc 参数')
      toolLog(`execute getMedia mxc=${mxc}`)
      const { buffer, mimetype, size } = await deps.channel.downloadMedia!(mxc)
      const ext = extensionForMimetype(mimetype)
      const filename = (typeof args.filename === 'string' && args.filename.trim() !== '')
        ? args.filename.trim()
        : `matrix-media-${Date.now()}${ext}`
      const sessionId = exec.agent?.id
      const mediaDir = sessionId !== undefined ? deps.mediaDirForSession?.(sessionId) : undefined
      if (mediaDir !== undefined) {
        const savedPath = await writeMediaFile(mediaDir, filename, buffer)
        toolLog(`execute getMedia saved=${savedPath} size=${size}`)
        return {
          savedPath,
          filename,
          ...(mimetype !== undefined ? { mimetype } : {}),
          size,
        }
      }
      // 无媒体目录：返回 base64（调用方自行处理）。
      const base64 = Buffer.from(buffer).toString('base64')
      toolLog(`execute getMedia no-dir size=${size}`)
      return {
        filename,
        ...(mimetype !== undefined ? { mimetype } : {}),
        size,
        base64,
      }
    },
  })
}

function makeListRoomsTool(deps: MatrixToolDeps) {
  return defineTool({
    name: MATRIX_TOOL_NAMES.LIST_ROOMS,
    description: '列出当前 Matrix 账号已加入的房间及其名称/成员数。用于了解可发言的目标房间。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        properties: {
          rooms: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              properties: {
                roomId: { type: 'string' },
                name: { type: 'string' },
                memberCount: { type: 'integer' },
              },
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      } as const,
      render: renderResult,
    },
    timeoutMs: 60_000,
    isConcurrencySafe: () => true,
    async execute() {
      const rooms = await deps.channel.listJoinedRooms!()
      toolLog(`execute listRooms count=${rooms.length}`)
      return { rooms }
    },
  })
}


/** 根据 mimetype 推断文件扩展名（含点前缀；未知返回空串）。 */
function extensionForMimetype(mimetype?: string): string {
  if (mimetype === undefined) return ''
  const table: Record<string, string> = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/webp': '.webp',
    'image/gif': '.gif',
    'image/svg+xml': '.svg',
    'application/pdf': '.pdf',
    'text/plain': '.txt',
    'application/json': '.json',
    'application/zip': '.zip',
    'audio/mpeg': '.mp3',
    'audio/ogg': '.ogg',
    'video/mp4': '.mp4',
    'application/msword': '.doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
    'application/vnd.ms-excel': '.xls',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  }
  return table[mimetype] ?? ''
}

/** 把下载的媒体字节写入 mediaDir 并返回绝对路径（自动建目录，文件名安全化）。 */
async function writeMediaFile(mediaDir: string, filename: string, buffer: Uint8Array): Promise<string> {
  await mkdir(mediaDir, { recursive: true })
  // 文件名安全化：去掉路径分隔符与非法字符，避免路径穿越。
  const safe = filename.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
  const target = join(mediaDir, safe)
  await writeFile(target, buffer)
  return target
}

/** 将 Matrix 工具通过 ctx.tools.register() 注册到 ToolRuntime（全局 layer）。
 * 必须在 agent factory 的 `setup` 或 host apply 中由 plugin ctx 调用。
 * 注册后即对所有 agent 可见，模型既能看见 schema 也能直接调用执行体。
 * @param ctx 当前 plugin/context
 * @param deps MatrixToolDeps（channel + roomForSession + 可选主动发送授权）
 */
export function applyMatrixTools(ctx: Context, deps: MatrixToolDeps): void {
  if (ctx.get('tools') === undefined) {
    ctx.logger.warn('[dsh-matrix] tools service unavailable; matrix tools not registered')
    return
  }
  toolLog('applying matrix tools via ctx.tools.register')

  const tools = [
    makeGetRoomMembersTool(deps),
    makeGetRecentMessagesTool(deps),
    makeGetRoomInfoTool(deps),
    makeGetUserInfoTool(deps),
    makeSendRoomMessageTool(deps),
    makeSendDmTool(deps),
    makeMentionMemberTool(deps),
    makeListRoomsTool(deps),
    makeGetMediaTool(deps),
  ]

  for (const tool of tools) {
    try {
      ctx.tools.register(tool)
      toolLog(`registered tool: ${tool.name}`)
    } catch (e) {
      toolLog(`failed to register tool ${tool.name}: ${e instanceof Error ? e.message : e}`)
    }
  }
}