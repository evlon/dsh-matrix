import Schema from '@deepseek-ai/schemastery'

/** dsh-matrix 插件配置。所有字段都可在 cordis.patch.yml 的行 config 中覆盖。 */
export interface Config {
  /** Matrix homeserver 的 client-server API base URL。 */
  homeserverUrl: string
  /** Bot 的 access token；为空时回退到环境变量 DSH_MATRIX_TOKEN。 */
  accessToken: string
  /** Bot 的 Matrix 用户 id，如 '@dsh-bot:example.org'。 */
  userId: string
  /** 允许与 bot 对话的 Matrix 用户 id 白名单；为空且 allowAllUsers=false 时拒绝所有人。 */
  allowedUserIds: string[]
  /** 允许任意用户（仅开发用）。 */
  allowAllUsers: boolean
  /** 每个房间 agent 使用的 LLM provider 路由。 */
  provider: string
  /** 每个房间 agent 使用的模型 id。 */
  model: string
  /** 出站单条消息的最大字符数（含分段前缀）。 */
  chunkMaxChars: number
  /** 裸文本消息的合并窗口（秒）；'..' 后缀继续、'!!' 后缀立即提交。 */
  mergeTimeoutSecs: number
  /** 审批请求推送到聊天后等待回复的秒数，超时按 unavailable 处理。 */
  approvalTimeoutSecs: number
  /** 桥接状态文件目录（房间↔会话映射、去重环、sync token）。 */
  stateDir: string
}

export const Config: Schema<Config> = Schema.object({
  homeserverUrl: Schema.string().required(),
  accessToken: Schema.string().default(''),
  userId: Schema.string().required(),
  allowedUserIds: Schema.array(Schema.string()).default([]),
  allowAllUsers: Schema.boolean().default(false),
  provider: Schema.string().default('deepseek-official'),
  model: Schema.string().default('deepseek-v4-flash'),
  chunkMaxChars: Schema.number().default(4000),
  mergeTimeoutSecs: Schema.number().default(5),
  approvalTimeoutSecs: Schema.number().default(300),
  stateDir: Schema.string().default('.dsh-matrix'),
})
