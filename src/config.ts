/**
 * 插件配置：schemastery schema（Cordis 原生 Config 约定）+ 运行期归一化。
 *
 * 注意两点（都是踩过的坑）：
 * 1. profile 的 cordis.patch.yml 对同一 entry 是「整体替换 config」语义，所以
 *    任何字段缺省都必须有 default —— 你只写 `enabled: true` 时，其余字段由
 *    schemastery 的 default 兜底，不会被读成 undefined。
 * 2. 加载期 fail-loud：非法值直接抛 TypeError 并指明字段，不要静默改成默认值，
 *    否则「阈值写错 → 永远不触发」这种问题只能靠猜。
 */
import z from '@deepseek-ai/schemastery'

export interface OrchestratorConfig {
  enabled: boolean
  /** 单次插件加载内允许的自动换窗次数上限（0 = 不限制）。本地小窗口模型需要反复换窗。 */
  maxAutoHandoffs: number
  /** 逐模型窗口覆盖：键是 ${provider}/ 或 ${model}，值是真实窗口（0 = 忽略）。 */
  contextWindowByModel: Record<string, number>
  /** 按模型的百分比阈值（键同上）；未列出的模型用 thresholdPercent。 */
  thresholdByModel: Record<string, number>
  autoHandoff: boolean
  checkpointMaxBytes: number
  handoffBriefMaxChars: number
  checkpointRoot: string
  projectProgressReserveChars: number
  /** 换窗后是否在旧窗口主动开一次极短回复，立刻显示「任务已转移」。 */
  notifyTransferredSession: boolean
  /** 交接成功后是否把旧会话的待办标成已完成（避免旧窗口挂着假任务）。 */
  markTodosHandedOff: boolean
  /** 简报由谁写：插件模板（确定性）或模型（多一次调用）。 */
  briefAuthor: 'plugin' | 'model'
  /** 交接时是否把「原始需求」一路带着（默认 true）。 */
  carryOriginalRequest: boolean
}

export const CONFIG_DEFAULTS = Object.freeze<OrchestratorConfig>({
  enabled: false,
  maxAutoHandoffs: 10,
  contextWindowByModel: {},
  thresholdByModel: {},
  autoHandoff: false,
  checkpointMaxBytes: 65536,
  handoffBriefMaxChars: 4000,
  checkpointRoot: '',
  projectProgressReserveChars: 1200,
  notifyTransferredSession: true,
  markTodosHandedOff: true,
  briefAuthor: 'plugin',
  carryOriginalRequest: true,
})

const THRESHOLD_MIN = 5
const THRESHOLD_MAX = 99
const CHECKPOINT_MIN = 4096
const CHECKPOINT_MAX = 4 * 1024 * 1024
const BRIEF_MIN = 1000
const BRIEF_MAX = 20000
const RESERVE_MAX = 8000
const TOKEN_THRESHOLD_MAX = 4_000_000
const TOKEN_THRESHOLD_MIN = 1000

/**
 * 三个数值上限支持「不限制」哨兵值（设置页的「不限制」勾选框写的就是它）：
 *   - checkpointMaxBytes: 0          → 不裁剪检查点体积
 *   - handoffBriefMaxChars: 0        → 不裁剪交接简报正文
 *   - projectProgressReserveChars: -1 → 项目摘要不设上限（也不占简报预算）
 * 之所以不用 null/undefined：schema 里 null 表示「没写」，无法与「显式不限制」区分。
 */
export const UNLIMITED = Object.freeze({
  checkpointMaxBytes: 0,
  handoffBriefMaxChars: 0,
  projectProgressReserveChars: -1,
})

export const Config = z.object({
  enabled: z.boolean()
    .default(CONFIG_DEFAULTS.enabled)
    .description('总开关。false 时不监听预算、不自动换窗；工具仍注册，但 handoff 会拒绝执行。'),
  maxAutoHandoffs: z.number()
    .min(0)
    .max(100)
    .default(CONFIG_DEFAULTS.maxAutoHandoffs)
    .description('单次插件加载内允许的自动换窗次数上限（0 = 不限制）。默认 10：本地小窗口模型每个窗口只能干 2-3 万 tokens，需要反复换窗；早期版本写死 1 次，导致第二个窗口就不再换窗。'),
  // 用 z.any 而不用 z.dict：后者的推断类型会引用 cosmokit 的 Dict，导致 .d.ts 无法命名（TS2742）。
  // 真正的校验在 resolveConfig 里做（逐键检查是数字且在范围内）。
  // 按模型的百分比阈值：键为 `provider/model` 或 `model`，值 0-99（0 = 不启用该模型）。
  // 用 z.any 的原因同 contextWindowByModel（避免 cosmokit 类型进入 .d.ts）。
  thresholdByModel: z.any()
    .default(CONFIG_DEFAULTS.thresholdByModel)
    .description('按模型的百分比阈值：键为 `provider/model` 或 `model`，值 0-99（0 = 该模型不启用）。只管理这里列出的模型；没列出的模型插件完全不介入。'),
  contextWindowByModel: z.any()
    .default(CONFIG_DEFAULTS.contextWindowByModel)
    .description('逐模型设定真实上下文窗口：键为 provider/model 或 model，值为窗口大小（0 = 忽略该键）。优先级高于全局自定值与关键字匹配。'),
  autoHandoff: z.boolean()
    .default(CONFIG_DEFAULTS.autoHandoff)
    .description('true = 临界时自动执行 写检查点→开新窗→注入简报 的完整闭环；false = 只发 notice 等用户手动调用工具。'),
  notifyTransferredSession: z.boolean()
    .default(CONFIG_DEFAULTS.notifyTransferredSession)
    .description('换窗后是否在旧窗口主动开一次极短回复，立刻显示「任务已转移」（关掉则不唤醒旧会话，但那条提醒可能要等它下次干活才看得到）。'),
  markTodosHandedOff: z.boolean()
    .default(CONFIG_DEFAULTS.markTodosHandedOff)
    .description('交接成功后，把旧会话里未完成的待办标记为已完成（避免旧窗口一直挂着"进行中"的假任务）。'),
  checkpointMaxBytes: z.number()
    .min(0)
    .max(CHECKPOINT_MAX)
    .default(CONFIG_DEFAULTS.checkpointMaxBytes)
    .description('检查点 JSON 的 UTF-8 字节上限；0 = 不限制。超限先裁剪内容，仍超限则写入失败且不换窗（fail-closed）。'),
  handoffBriefMaxChars: z.number()
    .min(0)
    .max(BRIEF_MAX)
    .default(CONFIG_DEFAULTS.handoffBriefMaxChars)
    .description('注入新会话首轮的交接简报字符上限；0 = 不限制（按最详细档渲染，不裁剪）。'),
  checkpointRoot: z.string()
    .default(CONFIG_DEFAULTS.checkpointRoot)
    .description('可选。检查点根目录；留空表示 ${DSH_HOME}/task-checkpoints/orchestrator（与 dsh-task-checkpoint-guard 同根）。'),
  projectProgressReserveChars: z.number()
    .min(UNLIMITED.projectProgressReserveChars)
    .max(RESERVE_MAX)
    .default(CONFIG_DEFAULTS.projectProgressReserveChars)
    .description('可选。从 handoffBriefMaxChars 中预留给 PROGRESS.md 项目级摘要的字符数；0 = 不注入；-1 = 不限制（不裁剪、也不占简报预算）。'),
  carryOriginalRequest: z.boolean()
    .default(CONFIG_DEFAULTS.carryOriginalRequest)
    .description('交接时把「原始需求」原文一路带进检查点与简报（默认开）。关掉后后续窗口只能看到进度，容易偏离原始目标。'),
  briefAuthor: z.string()
    .default(CONFIG_DEFAULTS.briefAuthor)
    .description("简报由谁写：'plugin' = 插件按模板从结构化事实生成（默认，确定性、零额外调用）；'model' = 换窗前让模型写一份叙述性简报（多一次模型调用，失败自动回退模板）。"),
})

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

/** 把加载器传进来的原始配置解析成完整、可用的配置对象；非法值 fail-loud。 */
export function resolveConfig(raw: unknown): OrchestratorConfig {
  const input = raw === undefined || raw === null ? {} : raw
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('dsh-infinite-context-orchestrator: config must be an object')
  }

  let parsed: Record<string, unknown>
  try {
    parsed = (Config as unknown as (value: unknown) => Record<string, unknown>)(input)
  } catch (error) {
    throw new TypeError(`dsh-infinite-context-orchestrator: invalid config — ${String((error as Error)?.message ?? error)}`)
  }

  const merged = { ...CONFIG_DEFAULTS, ...(parsed ?? {}) } as OrchestratorConfig
  const issues: string[] = []

  // 「可用值」判定：要么是哨兵（不限制），要么落在正常区间 —— 中间的空档一律拒绝。
  const allowedOrSentinel = (value: unknown, sentinel: number, min: number, max: number): boolean => {
    if (!isFiniteNumber(value)) return false
    if (value === sentinel) return true
    return value >= min && value <= max
  }

  if (typeof merged.notifyTransferredSession !== 'boolean') issues.push('notifyTransferredSession must be a boolean')
  if (!isFiniteNumber(merged.maxAutoHandoffs) || merged.maxAutoHandoffs < 0 || merged.maxAutoHandoffs > 100) {
    issues.push('maxAutoHandoffs must be 0 (unlimited) or an integer in [0, 100]')
  } else {
    merged.maxAutoHandoffs = Math.round(merged.maxAutoHandoffs)
  }
  // 逐模型窗口覆盖：归一化成 Record<string, number>，非法项逐个报错（不静默丢弃）。
  const byModelRaw = merged.contextWindowByModel
  const byModel: Record<string, number> = {}
  if (byModelRaw !== undefined && byModelRaw !== null) {
    if (typeof byModelRaw !== 'object' || Array.isArray(byModelRaw)) {
      issues.push('contextWindowByModel must be an object mapping model keys to numbers')
    } else {
      for (const [key, value] of Object.entries(byModelRaw as Record<string, unknown>)) {
        if (!isFiniteNumber(value) || value < 0 || value > TOKEN_THRESHOLD_MAX) {
          issues.push("contextWindowByModel[] must be 0 or a number in [0, ]")
        } else {
          byModel[key] = value
        }
      }
    }
  }
  merged.contextWindowByModel = byModel

  // 按模型阈值：同样逐键校验（0-99，0 = 不启用该模型）
  const thresholdRaw = merged.thresholdByModel
  const thresholdMap: Record<string, number> = {}
  if (thresholdRaw !== undefined && thresholdRaw !== null) {
    if (typeof thresholdRaw !== 'object' || Array.isArray(thresholdRaw)) {
      issues.push('thresholdByModel must be an object mapping model keys to percentages')
    } else {
      for (const [key, value] of Object.entries(thresholdRaw as Record<string, unknown>)) {
        if (!isFiniteNumber(value) || value < 0 || value > 99) {
          issues.push(`thresholdByModel[${key}] must be 0 (disabled) or a number in [0, 99]`)
        } else {
          thresholdMap[key] = value
        }
      }
    }
  }
  merged.thresholdByModel = thresholdMap

  // 其余标量字段：范围/类型都在这里一次性校验，避免「写错 → 静默用默认值」。
  if (typeof merged.enabled !== 'boolean') issues.push('enabled must be a boolean')
  if (typeof merged.autoHandoff !== 'boolean') issues.push('autoHandoff must be a boolean')
  if (typeof merged.markTodosHandedOff !== 'boolean') issues.push('markTodosHandedOff must be a boolean')
  if (typeof merged.checkpointRoot !== 'string') issues.push('checkpointRoot must be a string')
  if (typeof merged.carryOriginalRequest !== 'boolean') issues.push('carryOriginalRequest must be a boolean')
  if (typeof merged.briefAuthor !== 'string' || !['plugin', 'model'].includes(merged.briefAuthor)) {
    issues.push("briefAuthor must be 'plugin' or 'model'")
  }
  if (!allowedOrSentinel(merged.checkpointMaxBytes, 0, CHECKPOINT_MIN, CHECKPOINT_MAX)) {
    issues.push(`checkpointMaxBytes must be 0 (unlimited) or a number in [${CHECKPOINT_MIN}, ${CHECKPOINT_MAX}]`)
  } else if (merged.checkpointMaxBytes > 0) {
    merged.checkpointMaxBytes = Math.round(merged.checkpointMaxBytes)
  }
  if (!allowedOrSentinel(merged.handoffBriefMaxChars, 0, BRIEF_MIN, BRIEF_MAX)) {
    issues.push(`handoffBriefMaxChars must be 0 (unlimited) or a number in [${BRIEF_MIN}, ${BRIEF_MAX}]`)
  } else if (merged.handoffBriefMaxChars > 0) {
    merged.handoffBriefMaxChars = Math.round(merged.handoffBriefMaxChars)
  }
  if (!allowedOrSentinel(merged.projectProgressReserveChars, -1, 0, RESERVE_MAX)) {
    issues.push(`projectProgressReserveChars must be -1 (default) or a number in [0, ${RESERVE_MAX}]`)
  } else if (merged.projectProgressReserveChars >= 0) {
    merged.projectProgressReserveChars = Math.round(merged.projectProgressReserveChars)
  }

  if (issues.length > 0) {
    throw new TypeError(`dsh-infinite-context-orchestrator: invalid config — ${issues.join('; ')}`)
  }

  return {
    ...merged,
    checkpointMaxBytes: Math.round(merged.checkpointMaxBytes),
    handoffBriefMaxChars: Math.round(merged.handoffBriefMaxChars),
    projectProgressReserveChars: Math.round(merged.projectProgressReserveChars),
  }
}
