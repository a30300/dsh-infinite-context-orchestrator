/**
 * dsh-infinite-context-orchestrator — Host 平面入口。
 *
 * 它做四件事（自身不实现压缩、不实现检查点存储引擎，全部复用底层插件的能力）：
 *   1. 监听预算：在 `agent/pre-step` 上读占用（`tokenMeter` / `contextPressure` 投影），
 *      越过 thresholdPercent 时给当前会话发**插件 notice**（非用户消息，不打断工作）；
 *   2. 写检查点：复用 dsh-task-checkpoint-guard 的持久化契约（同根目录、原子写、
 *      `.previous` 副本），内容来自会话投影与事件流，写前脱敏；
 *   3. 开新窗：走 DSH Session API（与 relay_handoff 同一条路径）创建全新顶层会话，
 *      **绝不在同一会话内切 preset**；
 *   4. 强制注入：把简报按新 sessionId 落盘，由 `systemPrompt.section` 在**第一次组装
 *      请求**时注入，让新窗口从第一个 token 就知道任务进度。
 *
 * 边界（需求 D）：检查点写失败 ⇒ 不换窗（fail-closed）；新会话创建失败 ⇒ 保留检查点；
 * 单次 apply 内最多一次自动 handoff；每次换窗后重新武装新会话的哨兵。
 *
 * @module dsh-infinite-context-orchestrator
 */
import { crossedThreshold, clearOccupancyCache, formatOccupancy, invalidateOccupancy, measureOccupancy, resolvePolicy, windowConfigOf } from './budget.js'
import { hasSessionCheckpoint, loadPendingBrief, clearPendingBrief } from './checkpoint.js'
import { resolveConfig } from './config.js'
import { messageText } from './extract.js'
import { checkpointRootOf, createState, isSubagentSession, noticeMessage, notifyCaller, performHandoff, setWorkspaceRegistryAccessor } from './handoff.js'
import type { OrchestratorState } from './handoff.js'
import { registerSettingsRoutes } from './routes.js'
import { createTools } from './tools.js'
import type { ToolDeps } from './tools.js'
import type { AgentLike, CtxLike, MessageLike, PromptSectionContext, SessionLike } from './types.js'

/** 稳定插件名（与 package.json 的 name 一致；cordis.patch.yml 的 name 也必须一致）。 */
export const name = 'dsh-infinite-context-orchestrator'

/** 必需的宿主服务：注册工具与提示词段。其余服务（sessionController/tokenMeter/…）走可选获取。 */
export const inject = ['tools', 'systemPrompt']

export { Config } from './config.js'
/** 仅给离线冒烟测试用（不是插件 API）。 */
export { withTimeout as __testingWithTimeout } from './timeout.js'

/** 回滞带宽：占用跌回 threshold-5 以下才重新武装提醒，避免临界处反复刷 notice。 */
const HYSTERESIS_PERCENT = 5
/** 提示词段序号：小于 dsh-project-progress 的 60，让任务简报排在项目摘要之前。 */
/**
 * 「交付物落盘」纪律段：常驻 system prompt。
 * 与项目级 AGENTS.md 的区别：不依赖模型主动读文件，且优先级最高。
 */
const DISCIPLINE_SECTION_ORDER = 12
const DISCIPLINE_TEXT = [
  '## 工具使用纪律（插件注入，优先级最高）',
  '- **除非用户明确要求直接在回复里看代码**，要交付的代码 / 文档一律用 write / edit 写进工作区文件，不要贴进回复正文。',
  '- 回复正文只写：改了哪个文件、当前行数/字节数、验证结果、下一步。',
  '- 单次输出有上限：把整份代码写进正文会被截断，整轮作废、什么都没保存。',
  '- 改动超过一个文件时，逐个 write/edit，写完立刻用命令验证。',
].join('\n')

const BRIEF_SECTION_ORDER = 55
/** 换窗后「开工校验」的有效期：超过这么久才发第一条消息就不再纠正。 */
const FIRST_STEP_WATCH_TTL_MS = 10 * 60 * 1000
/** 首条 assistant 消息短于这个长度、或以问句结尾，就认为它没开工。 */
const FIRST_STEP_MIN_CHARS = 80

function logWarn(message: string): void {
  try {
    console.warn(`[dsh-infinite-context-orchestrator] ${message}`)
  } catch {
    /* ignore */
  }
}

function register(ctx: CtxLike, factory: () => unknown, label: string): void {
  if (typeof ctx.effect === 'function') ctx.effect(factory, label)
  else factory()
}

export function apply(ctx: CtxLike, rawConfig?: unknown): void {
  const config = resolveConfig(rawConfig)
  const state = createState()
  const root = checkpointRootOf(config)
  const deps: ToolDeps = { ctx, config, state, root }

  // ── 工具 ────────────────────────────────────────────────────────────────
  for (const tool of createTools(deps)) {
    register(ctx, () => ctx.tools?.register(tool), `${name}: tool ${tool.name}`)
  }

  // ── 强制注入：新会话首轮的交接简报（system prompt 段）───────────────────
  register(
    ctx,
    () => ctx.systemPrompt?.section({
      name: 'infinite-context-handoff-brief',
      order: BRIEF_SECTION_ORDER,
      text: (context: PromptSectionContext): string => {
        const sessionId = context?.agent?.session?.id ?? context?.session?.id
        if (typeof sessionId !== 'string' || sessionId.length === 0) return ''
        const pending = state.pendingBriefs.get(sessionId) ?? loadPendingBrief(root, sessionId)
        if (pending === undefined) return ''
        // 注意：**不要把磁盘上读到的简报缓存进内存**。一旦缓存，而消费路径没走这条
        // 内存（例如插件热重载后状态丢失、或文件被外部清掉），这段简报会被无限次注入。
        // 每次组装只做一次小 JSON 读取，代价可忽略（且只在有待注入简报时发生）。
        return pending.text
      },
    }),
    `${name}: handoff brief prompt section`,
  )

  // ── 常驻纪律段：交付物一律落盘，正文不贴代码 ──────────────────────────────
  // 为什么放在 system prompt：本地 27B 模型会**随机**把整份代码写进回复正文，
  // 撞上单次输出上限后整轮截断、一个文件都没写出来（实测 32,767 字符）。
  // 项目级 AGENTS.md 只能降低概率；系统提示是最高优先级、且不需要模型去读文件。
  register(
    ctx,
    () => ctx.systemPrompt?.section({
      name: 'infinite-context-discipline',
      order: DISCIPLINE_SECTION_ORDER,
      text: (): string => (config.enabled ? DISCIPLINE_TEXT : ''),
    }),
    `${name}: discipline prompt section`,
  )

  // ── 哨兵：每个 step 前读一次占用（带 4s 缓存，不会真的每个 step 全量 measure）──
  // 这是 waterfall 事件：必须调用 next() 并把它的 decision 原样返回，否则会把
  // agent loop 的 pre-step 决策弄丢。观测/提醒全程包在 try/catch 里，
  // 任何异常都不允许影响这一 step。
  ctx.on('agent/pre-step', async (payload: { agent?: AgentLike }, next: () => Promise<unknown>) => {
    const decision = typeof next === 'function' ? await next() : undefined
    if (!config.enabled) return decision
    try {
      await observe(ctx, deps, payload?.agent)
    } catch {
      /* 观测/提醒失败绝不能影响 agent loop */
    }
    return decision
  })

  // ── 新会话首条 assistant 消息：撤简报 + 校验它是否真的开工 ────────────────
  // 1) 简报消费：systemPrompt 段是在请求组装时读的，撤得太早首轮就拿不到。
  // 2) 开工校验：换窗后新会话如果只说话不动手（没有工具调用、且回复很短或只是问句），
  //    补发一次纠正消息 —— 这是提示级约束之外的兜底。
  ctx.on('session/event', (session: SessionLike, event: { type?: string; data?: { turn?: number; message?: MessageLike } }) => {
    try {
      const eventSessionId = session?.id
      // 占用缓存失效：一步之内上下文可能暴涨（实测一步读 3 个文件 ≈ +3.5 万 tokens）。
      // 这几种事件之后必须让下一次 pre-step 重新测量，否则会拿旧值误判"还很空"。
      if (typeof eventSessionId === 'string' && eventSessionId.length > 0
        && (event?.type === 'step/end' || event?.type === 'tool/result'
          || event?.type === 'assistant/message' || event?.type === 'turn/start')) {
        invalidateOccupancy(eventSessionId)
      }

      if (event?.type !== 'assistant/message') return
      const sessionId = session?.id
      if (typeof sessionId !== 'string' || sessionId.length === 0) return

      // 性能：**不能每条 assistant 消息都去读磁盘**。内存里有就直接清；
      // 没有的话只在首轮（turn === 1）查一次磁盘兜底 —— 简报只服务首轮。
      const hadInMemory = state.pendingBriefs.delete(sessionId)
      if (hadInMemory) clearPendingBrief(root, sessionId)
      else if (event?.data?.turn === 1 && loadPendingBrief(root, sessionId) !== undefined) clearPendingBrief(root, sessionId)

      // 开工校验（只看一次）
      const watch = state.firstStepWatch.get(sessionId)
      if (watch === undefined) return
      state.firstStepWatch.delete(sessionId)
      if (Date.now() - watch.at > FIRST_STEP_WATCH_TTL_MS) return

      const blocks = Array.isArray(event?.data?.message?.content) ? event.data.message.content : []
      const acted = blocks.some((block) => (block as { type?: string })?.type === 'tool-call')
      if (acted) return
      const text = messageText(event?.data?.message)
      // 短回复 / 以问句收尾 → 认为它没开工（在等指令或只是汇报）
      if (text.length >= FIRST_STEP_MIN_CHARS && !/[？?]\s*$/.test(text)) return

      const agents = ctx.get('agents') as { get?: (id: string) => AgentLike | undefined } | undefined
      const successor = agents?.get?.(sessionId)
      if (successor !== undefined && typeof successor.followup === 'function') {
        successor.followup(noticeMessage(
          `继续执行待办第一项：「${watch.todo}」。不要只汇报状态——先把能做的部分做掉；`
          + '确实需要用户决定时，把问题压缩成一句并给出你的默认选择。',
          '[infinite-context] 交接后未开工，已补发纠正',
        ))
        logWarn(`新会话 ${sessionId} 首条消息未开工，已补发纠正（待办：${watch.todo}）`)
      }
    } catch {
      /* ignore */
    }
  })

  // ── 会话结束：清掉按会话的状态，避免长跑进程里无界增长 ───────────────────
  ctx.on('agent/disposed', (payload: { agent?: AgentLike }) => {
    try {
      const sessionId = payload?.agent?.session?.id
      if (typeof sessionId !== 'string') return
      state.fired.delete(sessionId)
      state.armed.delete(sessionId)
      state.pendingBriefs.delete(sessionId)
    } catch {
      /* ignore */
    }
  })

  register(ctx, () => () => clearOccupancyCache(), `${name}: occupancy cache`)

  // ── Workspace 注册表（决定新会话落在哪个分组）───────────────────────────
  // 必须用 ctx.inject：Cordis 的上下文是注入代理，未声明的服务属性直接取会抛
  // `cannot get property "workspaceRegistry" without inject`（实测把整次交接打断）。
  // 拿不到就不注册 → 交接退回 cwd（旧行为），绝不因此失败。
  try {
    const injectable = ctx as unknown as {
      inject?: (deps: string[], callback: (injected: unknown) => unknown) => unknown
    }
    if (typeof injectable.inject === 'function') {
      injectable.inject(['workspaceRegistry'], (injected) => {
        const registry = (injected as { workspaceRegistry?: unknown } | undefined)?.workspaceRegistry
        setWorkspaceRegistryAccessor(() => registry)
      })
    }
  } catch {
    logWarn('拿不到 workspaceRegistry：新会话将退回按 cwd 创建（此时不会自动加入原分组）')
  }

  // ── 设置页的读写面（client 半件用同源 fetch 访问）────────────────────────
  // 放最后：即使没有 webServer，工具与哨兵也已经接好了。
  registerSettingsRoutes(deps)
}

/**
 * 哨兵主体：测占用 → 判阈值 → notice（→ 可选自动 handoff）。
 * 只对顶层会话生效（子代理/队友不换窗，避免打断派出去的工作）。
 */
async function observe(ctx: CtxLike, deps: ToolDeps, agent: AgentLike | undefined): Promise<void> {
  const { config, state } = deps
  if (agent === undefined) return
  const session = agent.session
  const sessionId = session?.id
  if (typeof sessionId !== 'string' || sessionId.length === 0) return
  if (isSubagentSession(session)) return

  const occupancy = await measureOccupancy(ctx, agent, windowConfigOf(config))
  // 按模型策略：既没配窗口、也没配阈值的模型**完全不介入**（不提醒、不换窗）。
  // 这样 1M 的云端会话不会因为全局阈值被误触发。
  const policy = resolvePolicy(config, session)
  if (!policy.managed) return
  // A：这个会话已经交接过（handoffs/<sessionId>.json 存在）→ 不再自动换窗。
  // 旧窗口的上下文不会变小，不设这道闸，重启或状态重置后会反复开新窗口。
  if (config.autoHandoff && hasSessionCheckpoint(checkpointRootOf(config), sessionId)) return
  const { crossed, by } = crossedThreshold(occupancy, policy.thresholdPercent)

  if (!crossed) {
    // 回滞：只有明显跌回线下才重新武装，避免临界抖动刷屏。
    // 两条线各算各的跌幅：百分比跌 5 个点，或 token 跌 5%（至少 1000）。
    const previous = state.fired.get(sessionId)
    const percentDrop = occupancy.percent !== undefined
      && occupancy.percent < policy.thresholdPercent - HYSTERESIS_PERCENT
    if (previous !== undefined && percentDrop) {
      state.fired.delete(sessionId)
    }
    return
  }

  state.armed.add(sessionId)
  if (state.fired.has(sessionId)) return
  state.fired.set(sessionId, { at: Date.now(), percent: occupancy.percent })

  const mode = config.autoHandoff
    ? '将自动执行：写检查点 → 开新窗 → 注入交接简报。'
    : '将写入检查点并换窗；autoHandoff=false，等你确认后调用 infinite_context_handoff 执行。'
  const notice = [
    `【任务自动换窗】上下文占用 ${formatOccupancy(occupancy)}，已达触发条件：${policy.thresholdPercent}%。`,
    mode,
  ].join('\n')
  notifyCaller(ctx, agent, notice, `[infinite-context] triggered by ${by} · ${occupancy.percent ?? '?'}% / ${occupancy.usedTokens ?? '?'} tokens`)
  state.lastNotice = { at: Date.now(), text: notice }

  if (!config.autoHandoff) return

  const outcome = await performHandoff(deps, agent, 'auto')
  if (!outcome.ok && (outcome.code === 'busy' || outcome.code === 'rate-limited')) {
    notifyCaller(ctx, agent, `【任务自动换窗】${outcome.message}`, `[infinite-context] auto handoff skipped: ${outcome.code}`)
  }
}

/** 供测试/诊断：把当前状态快照成纯 JSON。 */
export function snapshotState(state: OrchestratorState): Record<string, unknown> {
  return {
    inFlight: state.inFlight,
    autoHandoffs: state.autoHandoffs,
    fired: [...state.fired.keys()],
    armed: [...state.armed],
    pendingBriefs: [...state.pendingBriefs.keys()],
    lastHandoff: state.lastHandoff ?? null,
    lastNotice: state.lastNotice ?? null,
  }
}
