/**
 * 两个模型可调用工具。
 *
 * `infinite_context_status` 是纯读操作：任何服务缺失都降级成文字说明，绝不抛。
 * `infinite_context_handoff` 是手动闭环入口：enabled=false 时明确拒绝，而不是静默无效
 * （静默无效最难排查）。
 *
 * 工具定义用本地的 `defineTool` 形状直接给 `ctx.tools.register`：DSH 的
 * `@deepseek-ai/dsh-tools` 在 profile 里解析不到（见 scripts/build.mjs），
 * 而 ToolDefinition 本身就是纯数据，自建一个等价 helper 比引入第二个 dsh-tools
 * 实例更安全（两份实例会让工具注册表出现身份问题）。
 */
import { formatOccupancy, measureOccupancy, resolvePolicy, sessionModelOf, thresholdGap, windowConfigOf } from './budget.js'
import { loadPendingBrief, readLatestPointer } from './checkpoint.js'
import { isSettingsRouteMounted } from './routes.js'
import { performHandoff, type HandoffDeps, type OrchestratorState } from './handoff.js'
import type { OrchestratorConfig } from './config.js'
import type { AgentLike, CtxLike, ToolDefinitionShape, ToolExecLike, ToolTextOutput } from './types.js'

export interface ToolDeps {
  ctx: CtxLike
  config: OrchestratorConfig
  state: OrchestratorState
  root: string
}

const NO_ARGS = { type: 'object', additionalProperties: false, properties: {} } as const

const HANDOFF_ARGS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    reason: {
      type: 'string',
      description: '可选：为什么要现在换窗（会写进检查点的 notes，便于新会话理解上下文）。',
    },
  },
} as const

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: {
    ok: { type: 'boolean' },
    message: { type: 'string' },
  },
  required: ['ok', 'message'],
} as const

/**
 * 工具结果渲染：失败时**把 code 显示给模型**。
 * 否则成功与失败在模型眼里都只是一句话，它没法按 code 分支（实测模型会专门指出这点）。
 */
const renderText = (_args: unknown, value: unknown): ToolTextOutput[] => {
  const result = value as { ok?: unknown; code?: unknown; message?: unknown } | undefined
  const text = String(result?.message ?? '')
  if (result?.ok === false && typeof result.code === 'string') {
    return [{ type: 'text', text: `[${result.code}] ${text}` }]
  }
  return [{ type: 'text', text }]
}

/**
 * 丢掉 `undefined` 字段（以及函数），只留下 JSON 能无损表达的值。
 *
 * 为什么必须做：DSH 校验工具结果是 **lossless JSON**，对象里只要有一个
 * `undefined` 字段，整条工具调用就会被判 `value is not lossless JSON` —— 表现为
 * 「动作做了，但模型收到一个错误」。实测踩过：占用不可用时 `occupancy` 里带着
 * `usedTokens: undefined`，换窗其实成功了，工具却报错。
 */
function lossless<T>(value: T): T {
  if (value === null || value === undefined) return value
  if (typeof value !== 'object') return typeof value === 'function' ? (undefined as unknown as T) : value
  if (Array.isArray(value)) {
    return value
      .filter((item) => item !== undefined && typeof item !== 'function')
      .map((item) => lossless(item)) as unknown as T
  }
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (item === undefined || typeof item === 'function') continue
    out[key] = lossless(item)
  }
  return out as T
}

interface StatusValue {
  ok: boolean
  message: string
  enabled: boolean
  autoHandoff: boolean
  thresholdPercent: number
  /** 距离阈值还差多少（人读）。 */
  thresholdGap: string
  occupancy: {
    percent?: number
    usedTokens?: number
    windowTokens?: number
    source: string
    basis: string
  } | null
  lastCheckpointPath: string | null
  checkpointRoot: string
  handoffInFlight: boolean
  armed: boolean
  pendingBrief: boolean
  lastHandoff: OrchestratorState['lastHandoff'] | null
  lastNoticeAt: number | null
  /** 换窗依赖服务在现场的可用性（排查用）。 */
  services: Array<{ name: string; available: boolean; critical: boolean }>
  notes: string[]
}

function toolAgent(exec: ToolExecLike): AgentLike | undefined {
  return exec?.agent ?? (exec?.session === undefined ? undefined : { session: exec.session })
}

/**
 * 现场探测换窗所需的服务是否真的在这个宿主上挂着。
 * 只在 status 里报告、不缓存：它同时是「换窗为什么会失败」的排查入口。
 */
function probeServices(ctx: CtxLike): Array<{ name: string; available: boolean; critical: boolean }> {
  const check = (name: string, critical: boolean, predicate: (service: unknown) => boolean) => {
    let available = false
    try {
      const service = ctx.get(name)
      available = service !== undefined && service !== null && predicate(service)
    } catch {
      available = false
    }
    return { name, available, critical }
  }
  return [
    check('sessionController', false, (s) => typeof (s as { create?: unknown })?.create === 'function'),
    check('agents', false, (s) => {
      const service = s as { list?: unknown; create?: unknown }
      return typeof service?.list === 'function' || typeof service?.create === 'function'
    }),
    check('tokenMeter', true, (s) => typeof (s as { measure?: unknown })?.measure === 'function'),
    check('sessionProjections', true, (s) => typeof (s as { stateOf?: unknown })?.stateOf === 'function'),
    check('llm', false, (s) => typeof (s as { resolveModelInfo?: unknown })?.resolveModelInfo === 'function'),
  ]
}

async function statusValue(deps: ToolDeps, exec: ToolExecLike): Promise<StatusValue> {
  const { ctx, config, state, root } = deps
  const agent = toolAgent(exec)
  const sessionId = agent?.session?.id
  const notes: string[] = []
  const services = probeServices(ctx)

  const occupancy = agent === undefined ? undefined : await measureOccupancy(ctx, agent, windowConfigOf(config))
  const latest = readLatestPointer(root)
  const lastCheckpointPath = state.lastHandoff?.checkpointPath ?? latest?.checkpointPath ?? null

  if (!config.enabled) {
    notes.push('总开关 enabled=false：哨兵不监听预算，也不会自动换窗；infinite_context_handoff 会拒绝执行。')
  }
  if (occupancy !== undefined && occupancy.basis === 'unavailable') {
    notes.push(`拿不到上下文占用：${occupancy.note ?? 'contextPressure 投影与 tokenMeter 都没给出可用数值'}。`)
  }
  if (occupancy !== undefined && occupancy.basis === 'tokens') {
    notes.push(`窗口大小未知：${occupancy.note ?? '模型没声明 contextWindow'}；只能看 token 绝对值，百分比阈值不会触发。可在模型配置里补 contextWindow。`)
  }
  if (config.autoHandoff && !config.enabled) notes.push('autoHandoff=true 但 enabled=false：自动换窗不会发生。')
  const missing = services.filter((service) => service.critical && !service.available).map((service) => service.name)
  if (missing.length > 0) notes.push(`缺少关键服务：${missing.join('、')}（占用测量会降级）。`)
  if (!services.some((service) => service.name === 'sessionController' && service.available)
    && !services.some((service) => service.name === 'agents' && service.available)) {
    notes.push('sessionController 与 agents 都不可用：换窗一定失败（只能写检查点）。')
  }

  const pendingBrief = typeof sessionId === 'string'
    ? state.pendingBriefs.has(sessionId) || loadPendingBrief(root, sessionId) !== undefined
    : false

  const policy = resolvePolicy(config, agent?.session)
  const gapText = occupancy === undefined ? '无法估算（没有会话）' : thresholdGap(occupancy, policy.thresholdPercent).text

  // 同时展示「生效窗口」与「DSH 读到的窗口」，用户据此判断要不要填自定值。
  const windowText = (() => {
    if (occupancy === undefined) return '未知（没有会话）'
    if (occupancy.windowTokens === undefined) return '未知（DSH 与模型都没给出）'
    const effective = Math.round(occupancy.windowTokens).toLocaleString('en-US')
    if (occupancy.windowSource === 'config') {
      const dsh = occupancy.dshWindowTokens === undefined
        ? 'DSH 未读到'
        : `DSH 读取 ${Math.round(occupancy.dshWindowTokens).toLocaleString('en-US')}`
      return `${effective}（按模型自定，生效）· ${dsh}`
    }
    return `${effective}（${occupancy.windowSource === 'pressure' ? 'DSH 投影' : '模型声明'}）`
  })()

  const currentModel = agent === undefined ? {} : sessionModelOf(agent.session)
  const policyLine = policy.managed
    ? `按模型策略：已纳入管理 · 本模型窗口 ${policy.window > 0 ? policy.window.toLocaleString('en-US') : '用 DSH 值'} · 本模型阈值 ${policy.thresholdPercent > 0 ? `${policy.thresholdPercent}%` : '未启用百分比线'}`
    : '按模型策略：本模型未纳入管理（既没配窗口也没配阈值），插件不会提醒或换窗'
  const lines = [
    `当前模型：${currentModel.provider ?? '未知'}/${currentModel.model ?? '未知'}`,
    `总开关：${config.enabled ? '已开启' : '已关闭（enabled=false）'} · 自动换窗：${config.autoHandoff ? '开' : '关'}`,
    `触发条件：${policy.thresholdPercent}%（按模型阈值）`,
    policyLine,
    `当前占用：${occupancy === undefined ? '未知（没有会话）' : formatOccupancy(occupancy)}`,
    `上下文窗口：${windowText}`,
    `距离阈值：${gapText}`,
    `最近检查点：${lastCheckpointPath ?? '（还没有）'}`,
    `检查点根目录：${root}`,
    `设置页接口：${isSettingsRouteMounted() ? '已挂载（/infinite-context/settings）' : '未挂载（设置页会读不到配置；检查 webServer 服务）'}`,
    `正在换窗：${state.inFlight ? '是' : '否'} · 本次加载已自动换窗：${state.autoHandoffs} 次 · 已武装会话：${state.armed.size} 个`,
  ]
  if (state.lastHandoff !== undefined) {
    lines.push(
      `上一次交接：${new Date(state.lastHandoff.at).toLocaleString('zh-CN')}（${state.lastHandoff.origin === 'auto' ? '自动' : '手动'}）`
      + ` → 新会话 ${state.lastHandoff.newSessionId ?? '（未创建）'}，简报 ${state.lastHandoff.briefChars} 字符`,
    )
  }
  if (notes.length > 0) lines.push('', ...notes.map((note) => `- ${note}`))
  lines.push('', `服务：${services.map((service) => `${service.name}=${service.available ? '✓' : '✗'}`).join(' · ')}`)

  return {
    ok: config.enabled,
    message: lines.join('\n'),
    enabled: config.enabled,
    autoHandoff: config.autoHandoff,
    thresholdPercent: policy.thresholdPercent,
    thresholdGap: gapText,
    occupancy: occupancy === undefined
      ? null
      : {
        ...(occupancy.percent === undefined ? {} : { percent: occupancy.percent }),
        ...(occupancy.usedTokens === undefined ? {} : { usedTokens: occupancy.usedTokens }),
        ...(occupancy.windowTokens === undefined ? {} : { windowTokens: occupancy.windowTokens }),
        source: occupancy.source,
        basis: occupancy.basis,
      },
    lastCheckpointPath,
    checkpointRoot: root,
    handoffInFlight: state.inFlight,
    armed: typeof sessionId === 'string' && state.armed.has(sessionId),
    pendingBrief,
    lastHandoff: state.lastHandoff ?? null,
    lastNoticeAt: state.lastNotice?.at ?? null,
    services,
    notes,
  }
}

export function createTools(deps: ToolDeps): Array<ToolDefinitionShape<any, any>> {
  const status: ToolDefinitionShape = {
    name: 'infinite_context_status',
    description:
      '查看任务自动换窗状态：当前上下文占用率、触发阈值、autoHandoff 开关、最近检查点路径、'
      + '以及是否正在换窗。排查「为什么没有提醒/为什么没有换窗」先调它。',
    parameters: NO_ARGS,
    output: { schema: OUTPUT_SCHEMA, render: renderText },
    async execute(_args: unknown, exec: ToolExecLike) {
      return lossless(await statusValue(deps as ToolDeps, exec))
    },
  }

  const handoff: ToolDefinitionShape = {
    name: 'infinite_context_handoff',
    description:
      '手动执行完整换窗闭环：写交接检查点 → 创建全新顶层会话 → 在新会话首轮强制注入交接简报。'
      + '检查点写失败会 fail-closed（不换窗）；新会话创建失败会保留检查点并返回路径。'
      + '需要 enabled=true；autoHandoff=false 时靠它手动触发。',
    parameters: HANDOFF_ARGS,
    output: { schema: OUTPUT_SCHEMA, render: renderText },
    async execute(args: unknown, exec: ToolExecLike) {
      const { config } = deps
      const agent = toolAgent(exec)
      if (agent === undefined) {
        return { ok: false, code: 'disabled', message: '没有可用的当前会话（exec.agent 缺失），无法换窗。', summary: 'refused: no agent' }
      }
      if (!config.enabled) {
        return {
          ok: false,
          code: 'disabled',
          message: '总开关 enabled=false，refused。请在 profile 的 cordis.patch.yml 里把 infinite-context-orchestrator 的 enabled 设为 true 后重试。',
          summary: 'refused: plugin disabled',
        }
      }
      const reason = typeof (args as { reason?: unknown })?.reason === 'string' ? String((args as { reason: string }).reason) : ''
      const outcome = await performHandoff(deps as HandoffDeps, agent, 'manual', reason)
      // 工具结果必须是 lossless JSON：任何 undefined 字段都会被宿主整条判失败。
      return lossless(outcome)
    },
  }

  return [status, handoff]
}

