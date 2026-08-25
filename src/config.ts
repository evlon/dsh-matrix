import Schema from '@deepseek-ai/schemastery'

/** 数字分身 Matrix 账号：一个真实员工名下的一个分身，独立 access token 与 agent 会话空间。 */
export interface DigitalTwinAccount {
  /** 分身的 Matrix 用户 id，如 '@ai-zhang-dev:im-ipm.ict.cmcc'。 */
  userId: string
  /** 直接内联的 access token（优先于 tokenEnv；生产建议用 tokenEnv）。 */
  accessToken: string
  /** 从环境变量读取 token 的变量名，如 DSH_MATRIX_AI_ZHANG_DEV_TOKEN。 */
  tokenEnv: string
  /** 工作责任负责人（主人）的 Matrix 用户 id。 */
  owner: string
  /** 角色标签（leader/pm/dev/qa/custom），仅作展示与路由提示。 */
  role: string
  /**
   * 是否响应房间里所有消息。
   * 省略时：主账号默认 true（个人助手模式），分身账号默认 false（@提及才响应）。
   */
  respondToAll: boolean
  /** 覆盖顶层 provider/model；留空回退顶层值。 */
  provider: string
  model: string
}

/** dsh-matrix 插件配置。所有字段都可在 cordis.patch.yml 的行 config 中覆盖。 */
export interface Config {
  /** Matrix homeserver 的 client-server API base URL。 */
  homeserverUrl: string
  /** 主账号 access token；为空时回退到环境变量 DSH_MATRIX_TOKEN。 */
  accessToken: string
  /** 主账号 Matrix 用户 id（数字分身自己；真实人账号不在 harness 登录）。 */
  userId: string
  /** 允许与 bot 对话的 Matrix 用户 id 白名单；为空且 allowAllUsers=false 时拒绝所有人。 */
  allowedUserIds: string[]
  /** 允许任意用户（仅开发用）。 */
  allowAllUsers: boolean
  /** 工作责任负责人（真实人账号，仅在 Matrix 客户端登录）：设置后本账号审批仅其可应答。 */
  owner: string
  /** 是否响应房间里所有消息；默认 true（分身也可设为 false 仅 @提及响应）。 */
  respondToAll: boolean
  /** 默认 LLM provider 路由（分身未指定时使用）。 */
  provider: string
  /** 默认模型 id（分身未指定时使用）。 */
  model: string
  /**
   * room agent 挂载的 agent preset（决定其工具集与角色提示）。
   * 缺省 standard 提供完整工具（bash/pwsh/fs/…）；留空则 agent 无任何工具。
   */
  agentPreset: string
  /** 出站单条消息的最大字符数（含分段前缀）。 */
  chunkMaxChars: number
  /** 裸文本消息的合并窗口（秒）；'..' 后缀继续、'!!' 后缀立即提交。 */
  mergeTimeoutSecs: number
  /** 审批请求推送到聊天后等待回复的秒数，超时按 unavailable 处理。 */
  approvalTimeoutSecs: number
  /** 桥接状态文件目录（房间↔会话映射、去重环、sync token、授权记录）。 */
  stateDir: string
  /**
   * 重试熔断阈值：同一房间 turn 内 LLM 受限自动重试达到该次数时，插件主动
   * agent.cancel() 终止当前 turn 以止损（harness 的 always 模式无上限重试会持续烧 token）。
   * 设为 0 或配合 retryCircuitBreakerEnabled=false 可关闭熔断。默认 5（给模型恢复机会）。
   */
  maxRetriesBeforeAbort: number
  /** 是否启用重试熔断兜底（默认 true）。关闭后仅保留诊断日志，不做主动 cancel。 */
  retryCircuitBreakerEnabled: boolean

  // ========== 数字分身支持 ==========
  /** 启用数字分身模式：@提及路由、Owner 授权记忆、红线强制确认。 */
  digitalTwinMode: boolean
  /** 额外的数字分身账号列表（主账号之外，每个分身一个独立 Matrix 账号）。 */
  digitalTwins: DigitalTwinAccount[]
  /** 授权记录文件名（相对 stateDir）。 */
  authStoreFile: string
  /** 红线工具列表：即使有长期授权也必须每次房间确认。 */
  redlineTools: string[]

  // ========== Matrix 任务队列 ==========
  /** 新房间工作目录引导的候选目录列表；首项作为缺省。 */
  cwdCandidates: string[]
  /** 单个房间 matrix 任务队列上限，超出后最早 pending 任务被自动拒绝。 */
  taskQueueMax: number
}

export const Config: Schema<Config> = Schema.object({
  homeserverUrl: Schema.string().required(),
  accessToken: Schema.string().default(''),
  userId: Schema.string().required(),
  allowedUserIds: Schema.array(Schema.string()).default([]),
  allowAllUsers: Schema.boolean().default(false),
  owner: Schema.string().default(''),
  respondToAll: Schema.boolean().default(true),
  provider: Schema.string().default('deepseek-official'),
  model: Schema.string().default('deepseek-v4-flash'),
  agentPreset: Schema.string().default('standard'),
  chunkMaxChars: Schema.number().default(4000),
  mergeTimeoutSecs: Schema.number().default(5),
  approvalTimeoutSecs: Schema.number().default(300),
  stateDir: Schema.string().default('.dsh-matrix'),
  maxRetriesBeforeAbort: Schema.number().default(5),
  retryCircuitBreakerEnabled: Schema.boolean().default(true),

  digitalTwinMode: Schema.boolean().default(false),
  digitalTwins: Schema.array(Schema.object({
    userId: Schema.string().required(),
    accessToken: Schema.string().default(''),
    tokenEnv: Schema.string().default(''),
    owner: Schema.string().default(''),
    role: Schema.string().default(''),
    respondToAll: Schema.boolean().default(false),
    provider: Schema.string().default(''),
    model: Schema.string().default(''),
  })).default([]),
  authStoreFile: Schema.string().default('auth-store.json'),
  redlineTools: Schema.array(Schema.string()).default(['bash', 'pwsh', 'write', 'edit']),

  cwdCandidates: Schema.array(Schema.string()).default([process.cwd()]),
  taskQueueMax: Schema.number().default(20),
})
