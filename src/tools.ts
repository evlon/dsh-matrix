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
} as const

export type MatrixToolName = typeof MATRIX_TOOL_NAMES[keyof typeof MATRIX_TOOL_NAMES]

/** 通过 ctx.tools.register(definition) 注册矩阵工具的依赖。 */
export interface MatrixToolDeps {
  /** Matrix 通道层，用于执行真实的 API 调用。 */
  channel: MatrixChannel
  /** sessionId → roomId 反查（来自 BridgeState 的 roomSessions 映射）。 */
  roomForSession: (sessionId: string) => string | undefined
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

/** 将 4 个 Matrix 工具通过 ctx.tools.register() 注册到 ToolRuntime（全局 layer）。
 * 必须在 agent factory 的 `setup` 或 host apply 中由 plugin ctx 调用。
 * 注册后即对所有 agent 可见，模型既能看见 schema 也能直接调用执行体。
 * @param ctx 当前 plugin/context
 * @param deps MatrixToolDeps（channel + roomForSession）
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