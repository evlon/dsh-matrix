/**
 * dsh-matrix：把 Matrix 聊天桥接到 DeepSeek Harness agent 会话。
 *
 * 入站：白名单用户的文本消息经合并窗口后，通过 `agent.followup` 注入
 * 对应房间的 agent 会话（source.kind = 'plugin'，绝不直接执行 shell）。
 * 出站：监听 `session/event`，把 `assistant/message` 文本分段并以
 * markdown 子集 HTML 发回房间；`turn/start` 显示 typing。
 * 审批：注册 `approval/request` answerer，把请求推送到房间，等白名单
 * 用户在聊天里回复「批准 / 拒绝」。
 *
 * 通道层（matrix.ts）与桥接层（bridge.ts）分离，后续可按同样模式接
 * 其它 IM。export 形状：函数/命名空间插件（name/inject/apply/Config），
 * 无 default export（见官方 postmortem/0001）。
 *
 * @module dsh-matrix
 */

import type { Context } from '@deepseek-ai/cordis'
import { MatrixBridge } from './bridge.js'
import type { Config as MatrixConfig, DigitalTwinAccount } from './config.js'

export * from './auth-store.js'
export * from './bridge.js'
export * from './config.js'
export * from './format.js'
export * from './matrix.js'
export * from './store.js'

export const name = 'matrix'
/** 只需要 agent 工厂；LLM 适配器、会话与工具由外围 cordis.yml 组合提供。 */
export const inject = ['agents']

export function apply(ctx: Context, config: MatrixConfig): void {
  const token = config.accessToken === '' ? process.env.DSH_MATRIX_TOKEN : config.accessToken
  if (token === undefined || token === '') {
    throw new Error('[dsh-matrix] missing bot access token (set config.accessToken or DSH_MATRIX_TOKEN)')
  }
  if (config.allowedUserIds.length === 0 && !config.allowAllUsers) {
    ctx.logger.warn('[dsh-matrix] no allowlist configured: all inbound messages will be rejected (fail closed)')
  }
  const twins: DigitalTwinAccount[] = config.digitalTwinMode ? (config.digitalTwins ?? []) : []
  const bridge = new MatrixBridge(ctx, { ...config, accessToken: token, digitalTwins: twins })
  ctx.effect(() => {
    void bridge.start()
    return () => {
      void bridge.stop()
    }
  }, 'matrix.serve')
}
