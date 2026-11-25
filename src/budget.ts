/**
 * 上下文占用测量。
 *
 * 三条证据路径，按可信度排序（与 dsh-context-relay 的 readPressure 同口径）：
 *   1. `sessionProjections.stateOf(session,'contextPressure')` —— 线上可见的
 *      `{ contextWindow, pressureTokens, projectedTokens }`，是 relay 判档的同一份数据；
 *   2. `ctx.tokenMeter.measure(session).totalTokens` —— 本地重放计量（启发式）；
 *   3. 窗口未知时用 `ctx.llm.resolveModelInfo(provider, model)` 补窗口大小。
 *
 * 为什么一定要拿到窗口：百分比阈值只有在「窗口已知」时才有意义；
 * 拿不到窗口就退回 token 绝对值判断（并在状态里注明 basis:'tokens'）。
 */
import type { AgentLike, CtxLike, SessionLike } from './types.js'

export interface Occupancy {
  usedTokens?: number
  windowTokens?: number
  /** used / window × 100，保留一位小数。 */
  percent?: number
  source: 'pressure' | 'meter' | 'unavailable'
  basis: 'ratio' | 'tokens' | 'unavailable'
  /** 窗口大小从哪来：DSH 投影 / 模型声明 / 用户自定值。 */
  windowSource?: 'pressure' | 'model' | 'config' | 'unknown'
  /** DSH 自己读到的窗口（自定值生效时用来对照展示）。 */
  dshWindowTokens?: number
  /** 自定窗口从哪命中：逐模型 / 全局 / 未命中。 */
  windowOverrideBy?: WindowOverrideSource
  /** 拿不到占用/窗口时的具体原因（排查用；不参与判档）。 */
  note?: string
}

const CACHE_TTL_MS = 4000
const cache = new Map<string, { at: number; value: Occupancy }>()

function positive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

function readPressureProjection(ctx: CtxLike, session: SessionLike): { used?: number; window?: number } {
  try {
    const projections = ctx.get('sessionProjections') as { stateOf?: (s: SessionLike, key: string) => unknown } | undefined
    const raw = projections?.stateOf?.(session, 'contextPressure') as
      | { contextWindow?: unknown; pressureTokens?: unknown; projectedTokens?: unknown }
      | undefined
    if (raw === undefined || raw === null) return {}
    return {
      window: positive(raw.contextWindow),
      // projectedTokens 优先：它是「这一轮请求将占用」的预估值，比上一轮实测更贴近临界判断。
      used: positive(raw.projectedTokens) ?? positive(raw.pressureTokens),
    }
  } catch {
    return {}
  }
}

function readMeter(ctx: CtxLike, session: SessionLike): { tokens?: number; note?: string } {
  try {
    const meter = ctx.get('tokenMeter') as
      | { measure?: (s: SessionLike) => { totalTokens?: unknown; surfaceTokens?: unknown } | undefined }
      | undefined
    if (meter === undefined || typeof meter.measure !== 'function') return { note: 'tokenMeter 服务不可用' }
    const measurement = meter.measure(session)
    if (measurement === undefined || measurement === null) return { note: 'tokenMeter.measure 返回了空值' }
    const tokens = measurement.totalTokens
    if (typeof tokens !== 'number' || !Number.isFinite(tokens)) {
      return { note: `tokenMeter.measure 没有返回数字，实际是 ${typeof tokens}` }
    }
    // 0 是合法测量（新会话/刚清空），不要当成「测不到」。
    return { tokens: Math.max(0, tokens) }
  } catch (error) {
    return { note: `tokenMeter.measure 抛错：${String((error as Error)?.message ?? error).slice(0, 120)}` }
  }
}

async function readWindowFromModel(ctx: CtxLike, session: SessionLike): Promise<number | undefined> {
  try {
    const header = typeof session?.requestHeader === 'function' ? session.requestHeader() : undefined
    const provider = header?.config?.provider
    const model = header?.config?.model
    if (typeof provider !== 'string' || typeof model !== 'string') return undefined
    const llm = ctx.get('llm') as
      | { resolveModelInfo?: (p: string, m: string) => Promise<{ context?: { contextWindow?: unknown } } | undefined> }
      | undefined
    const info = await llm?.resolveModelInfo?.(provider, model)
    return positive(info?.context?.contextWindow)
  } catch {
    return undefined
  }
}

/** 取会话当前模型 id（用于「自定窗口只对某些模型生效」）。 */
function modelOf(session: SessionLike): string | undefined {
  try {
    const header = typeof session?.requestHeader === 'function' ? session.requestHeader() : undefined
    const model = header?.config?.model
    return typeof model === 'string' && model.length > 0 ? model : undefined
  } catch {
    return undefined
  }
}

function providerOf(session: SessionLike): string | undefined {
  try {
    const header = typeof session?.requestHeader === 'function' ? session.requestHeader() : undefined
    const provider = header?.config?.provider
    return typeof provider === 'string' && provider.length > 0 ? provider : undefined
  } catch {
    return undefined
  }
}

/** 把插件 Config 映射成窗口覆盖配置（调用方共用，避免各处重复拼对象）。 */
export function windowConfigOf(config: {
  contextWindowByModel?: Record<string, number>
}): WindowOverrideConfig {
  return { byModel: config.contextWindowByModel ?? {} }
}

/**
 * 读出「这个会话当前用哪个 provider / 模型」。
 *
 * 唯一可信来源是 `session.requestHeader()` —— 它就是 DSH 下一次请求要用的头，
 * 由 DSH 自己维护（用户在 UI 里换模型后，下一次 pre-step 读到的就是新值）。
 * 新会话还没发过请求时可能为空，此时返回空对象，调用方按「无覆盖」处理。
 */
export function sessionModelOf(session: SessionLike | undefined): { provider?: string; model?: string } {
  if (session === undefined) return {}
  const provider = providerOf(session)
  const model = modelOf(session)
  return {
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
  }
}
/** 窗口覆盖配置（来自插件 Config）。 */
export interface WindowOverrideConfig {
  /** 全局自定窗口（0 = 用 DSH 值）。 */
  override?: number
  /** 全局自定窗口的模型关键字（空 = 所有模型）。 */
  overrideFor?: string
  /** 逐模型覆盖：键 `provider/model` 或 `model`。 */
  byModel?: Record<string, number>
}

export type WindowOverrideSource = 'model-map' | 'global' | 'none'

/**
 * 决定「用哪个窗口大小」。
 *
 * 优先级（从高到低）：
 * 1. `contextWindowByModel['provider/model']` —— 最精确，用户在设置页按模型填的；
 * 2. `contextWindowByModel['model']` —— 同一模型跨 provider 的兜底；
 * 3. 全局 `contextWindowOverride`（配合 `contextWindowOverrideFor` 关键字）；
 * 4. 不覆盖，用 DSH 读到的值。
 *
 * @returns value=0 表示不覆盖；source 说明命中哪一档（状态工具据此解释）。
 */
export function decideWindow(
  config: WindowOverrideConfig,
  provider: string | undefined,
  model: string | undefined,
): { value: number; source: WindowOverrideSource } {
  const byModel = config.byModel ?? {}
  const candidates: string[] = []
  if (provider !== undefined && model !== undefined) candidates.push(`${provider}/${model}`)
  if (model !== undefined) candidates.push(model)
  for (const key of candidates) {
    const hit = byModel[key]
    if (typeof hit === 'number' && hit > 0) return { value: hit, source: 'model-map' }
  }
  const global = config.override ?? 0
  if (global > 0) {
    const matcher = (config.overrideFor ?? '').trim()
    if (matcher === '' || (model ?? '').toLowerCase().includes(matcher.toLowerCase())) {
      return { value: global, source: 'global' }
    }
  }
  return { value: 0, source: 'none' }
}

/** 测一次占用（带 4s 缓存：pre-step 每个 step 都会问，不能每次都全量 measure）。 */
export async function measureOccupancy(
  ctx: CtxLike,
  agent: AgentLike,
  windowConfig: WindowOverrideConfig = {},
): Promise<Occupancy> {
  const session = agent?.session
  if (session === undefined || typeof session.id !== 'string') {
    return { source: 'unavailable', basis: 'unavailable' }
  }

  // 自定窗口可以只对部分模型生效：同时用「本地 llama.cpp（64K）」和「云端（1M）」时，
  // 全局覆盖会把大窗口的会话也算成爆表，导致无谓换窗。
  const model = modelOf(session)
  const provider = providerOf(session)
  const decided = decideWindow(windowConfig, provider, model)
  const overrideApplies = decided.value > 0

  const cacheKey = `${session.id}:${decided.value}:${decided.source}:${Object.keys(windowConfig.byModel ?? {}).length}`
  const cached = cache.get(cacheKey)
  if (cached !== undefined && Date.now() - cached.at < CACHE_TTL_MS) return cached.value

  const projection = readPressureProjection(ctx, session)
  const meter = projection.used === undefined ? readMeter(ctx, session) : { tokens: undefined as number | undefined, note: undefined as string | undefined }
  const used = projection.used ?? meter.tokens
  const dshWindow = projection.window ?? await readWindowFromModel(ctx, session)
  // 填了窗口就用填的（服务器/模型声明可能远大于真实可用量，实测 64K vs 204,800）；
  // **没填则按服务器/DSH 读到的值算**。
  const window = overrideApplies ? decided.value : dshWindow
  const windowSource: Occupancy['windowSource'] = overrideApplies
    ? 'config'
    : dshWindow !== undefined ? (projection.window !== undefined ? 'pressure' : 'model') : 'unknown'

  const source: Occupancy['source'] = projection.used !== undefined
    ? 'pressure'
    : meter.tokens !== undefined ? 'meter' : 'unavailable'
  const basis: Occupancy['basis'] = used !== undefined && window !== undefined
    ? 'ratio'
    : used !== undefined ? 'tokens' : 'unavailable'

  // 关键：**不要把 undefined 写进对象**。DSH 的工具结果必须是 lossless JSON，
  // 带 undefined 字段会被判「value is not lossless JSON」并整条工具调用失败。
  const value: Occupancy = {
    source,
    basis,
    windowSource,
    ...(overrideApplies ? { windowOverrideBy: decided.source } : {}),
    ...(used === undefined ? {} : { usedTokens: used }),
    ...(window === undefined ? {} : { windowTokens: window }),
    // 自定窗口生效时，把 DSH 读到的值也带上，方便对照（例如 DSH 读 204800、自定 64000）
    ...(overrideApplies && dshWindow !== undefined ? { dshWindowTokens: dshWindow } : {}),
    ...(used !== undefined && window !== undefined
      ? { percent: Math.round((used / window) * 1000) / 10 }
      : {}),
    ...(basis === 'ratio' ? {} : { note: meter.note ?? (window === undefined ? '拿不到上下文窗口大小（模型未声明 contextWindow）' : '拿不到已用 token 数') }),
  }

  cache.set(cacheKey, { at: Date.now(), value })
  if (cache.size > 64) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0]
    if (oldest !== undefined) cache.delete(oldest[0])
  }
  return value
}

/**
 * 判定是否越过阈值。两条线**取先到**：
 * - 百分比线：`thresholdPercent`，只有窗口已知时才有意义；
 * - 绝对 token 线：`thresholdTokens`（0 = 不启用），不依赖窗口大小。
 *
 * 为什么要有 token 线：本地推理服务（llama.cpp 等）常把实际上下文压得比模型声明的窗口小
 * （例如实际 64K、模型声明 200K），此时百分比永远失准；按 token 数判才靠谱。
 */
export function crossedThreshold(
  occupancy: Occupancy,
  thresholdPercent: number,
  thresholdTokens = 0,
): { crossed: boolean; reason: string; by: 'tokens' | 'percent' | 'none' } {
  if (occupancy.basis === 'unavailable') return { crossed: false, reason: 'occupancy-unavailable', by: 'none' }

  const used = occupancy.usedTokens
  const tokensArmed = thresholdTokens > 0
  const byTokens = tokensArmed && used !== undefined && used >= thresholdTokens
  // thresholdPercent <= 0 表示「该模型不启用百分比阈值」，只走 token 线。
  const percentArmed = thresholdPercent > 0
  const byPercent = percentArmed && occupancy.basis === 'ratio' && occupancy.percent !== undefined && occupancy.percent >= thresholdPercent

  if (byTokens) return { crossed: true, reason: 'token-threshold-crossed', by: 'tokens' }
  if (byPercent) return { crossed: true, reason: 'threshold-crossed', by: 'percent' }
  // 窗口未知且没配 token 线：百分比无法判定
  if (!percentArmed && !tokensArmed) return { crossed: false, reason: 'threshold-disabled', by: 'none' }
  if (occupancy.basis === 'tokens' && !tokensArmed) return { crossed: false, reason: 'context-window-unknown', by: 'none' }
  return { crossed: false, reason: 'below-threshold', by: 'none' }
}

/** 距离阈值还差多少（给状态工具用，便于判断"还要聊多久才会触发"）。 */
export function thresholdGap(
  occupancy: Occupancy,
  thresholdPercent: number,
  thresholdTokens = 0,
): { text: string } {
  const parts: string[] = []
  if (occupancy.percent !== undefined) {
    const gap = Math.round((thresholdPercent - occupancy.percent) * 10) / 10
    parts.push(gap > 0 ? `还差 ${gap}% 到百分比阈值` : `已超过百分比阈值`)
  }
  if (thresholdTokens > 0 && occupancy.usedTokens !== undefined) {
    const gapTokens = Math.round(thresholdTokens - occupancy.usedTokens)
    parts.push(gapTokens > 0 ? `还差 ${gapTokens.toLocaleString('en-US')} tokens 到 token 阈值` : '已超过 token 阈值')
  }
  return { text: parts.length === 0 ? '无法估算（缺少占用数据）' : parts.join(' · ') }
}

/** 模型纳入管理但没单独配阈值时的内置默认（百分比）。 */
const DEFAULT_THRESHOLD_PERCENT = 80

/** 某个模型是否被"纳入管理"以及它自己的窗口/阈值。 */
export interface ModelPolicy {
  /** 生效窗口（0 = 用 DSH 读到的值）。 */
  window: number
  windowSource: WindowOverrideSource
  /** 生效的百分比阈值（0 = 该模型不启用百分比线）。 */
  thresholdPercent: number
  /**
   * 是否纳入管理：
   * 在 `contextWindowByModel` / `thresholdByModel` 里出现过，或命中了全局 override 关键字。
   * **未纳入管理的模型，插件完全不介入**（不提醒、不换窗）——避免 1M 云端会话被误触发。
   */
  managed: boolean
}

/**
 * 解析「这个会话当前模型」的窗口与阈值。
 *
 * 优先级：逐模型（provider/model → model）> 全局 override / thresholdPercent。
 * 只出现在全局配置里的模型也算"未按模型配置"，但窗口 override 命中的仍视为纳入管理。
 */
export function resolvePolicy(
  config: {
    contextWindowOverride?: number
    contextWindowOverrideFor?: string
    contextWindowByModel?: Record<string, number>
    thresholdByModel?: Record<string, number>
    thresholdPercent?: number
  },
  session: SessionLike | undefined,
): ModelPolicy {
  const provider = session === undefined ? undefined : providerOf(session)
  const model = session === undefined ? undefined : modelOf(session)
  const decided = decideWindow(windowConfigOf(config), provider, model)
  const windowMap = config.contextWindowByModel ?? {}
  const thresholdMap = config.thresholdByModel ?? {}
  const keys: string[] = []
  if (provider !== undefined && model !== undefined) keys.push(`${provider}/${model}`)
  if (model !== undefined) keys.push(model)

  let matched = decided.value > 0
  let thresholdPercent = DEFAULT_THRESHOLD_PERCENT
  for (const key of keys) {
    const windowValue = windowMap[key]
    if (typeof windowValue === 'number' && windowValue > 0) matched = true
    const thresholdValue = thresholdMap[key]
    if (typeof thresholdValue === 'number') {
      matched = true
      thresholdPercent = thresholdValue
    }
  }
  // 兼容规则：**完全没有按模型配置时**沿用全局阈值（老行为、也便于测试）；
  // 一旦配置了任意模型，就只管理这些模型，其余模型完全不介入。
  const anyConfigured = Object.keys(windowMap).length > 0 || Object.keys(thresholdMap).length > 0
  const managed = anyConfigured ? matched : true
  return { window: decided.value, windowSource: decided.source, thresholdPercent, managed }
}

export function clearOccupancyCache(): void {
  cache.clear()
}

/**
 * 让某个会话的占用缓存立刻失效。
 *
 * 为什么必须做：4 秒缓存是为了「每个 step 都测一次」不浪费，但**一步之内也能暴涨**——
 * 实测一个 step 里连读三个文件（合计约 82KB 代码 ≈ 3.5 万 tokens），上下文从 1.4 万跳到约 5 万。
 * 如果下一个 pre-step 仍读到缓存里的 1.4 万，插件就以为只有 22%，不会换窗，
 * 紧接着的请求直接 `400 prompt + max_tokens exceeds n_ctx`。
 * 所以在 step 结束 / 工具结果写入后主动失效，让下一次测量看到真实值。
 */
export function invalidateOccupancy(sessionId: string): void {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return
  const prefix = `${sessionId}:`
  for (const key of [...cache.keys()]) {
    if (key.startsWith(prefix)) cache.delete(key)
  }
}

/** 人读的占用描述（拿不到时带上具体原因）。 */
export function formatOccupancy(occupancy: Occupancy): string {
  if (occupancy.basis === 'unavailable') {
    return `占用未知（${occupancy.note ?? 'contextPressure 与 tokenMeter 都没给出可用数值'}）`
  }
  const used = occupancy.usedTokens === undefined ? '?' : Math.round(occupancy.usedTokens).toLocaleString('en-US')
  const window = occupancy.windowTokens === undefined ? '?' : Math.round(occupancy.windowTokens).toLocaleString('en-US')
  const windowTag = occupancy.windowSource === 'config'
    ? `，窗口为自定值${occupancy.dshWindowTokens === undefined ? '' : `；DSH 读到 ${Math.round(occupancy.dshWindowTokens).toLocaleString('en-US')}`}`
    : ''
  if (occupancy.percent === undefined) {
    return `${used} tokens（窗口未知，无法算百分比；来源 ${occupancy.source}${occupancy.note === undefined ? '' : `；${occupancy.note}`}）`
  }
  return `${occupancy.percent}%（${used} / ${window} tokens，来源 ${occupancy.source}${windowTag}）`
}
