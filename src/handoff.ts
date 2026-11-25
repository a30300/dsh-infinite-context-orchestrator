/**
 * 换窗闭环：写检查点 → 建新顶层会话 → 首轮注入简报。
 *
 * 关键设计（都是有意为之，别「优化」掉）：
 *   - **Fail-closed**：检查点写失败 ⇒ 直接返回失败，绝不建新会话。
 *     宁可留在旧窗口被 relay 的硬线兜住，也不要换到一个没有交接状态的新窗口。
 *   - **建会话走 DSH Session API**：与 dsh-context-relay 的 relay_handoff 同一条路径
 *     （`sessionController.create` 优先，`agents.create + agentPresets.mount` 兜底），
 *     但**不在同一个会话里切 preset** —— 换窗就是新会话。
 *   - **强制注入走 systemPrompt.section**：简报按新 sessionId 落在
 *     `pending-briefs/<sessionId>.json`，由 index.ts 注册的 prompt 段在**第一次组装请求时**
 *     就带进 system prompt，因此是「从第一个 token 就知道进度」，而不是靠一条用户消息。
 *     首条 followup 只做「触发这一轮 + 指个路」。
 *   - **防失控**：单次 apply 内的自动 handoff 次数受 maxAutoHandoffs 限制（默认 10，0 = 不限制），
 *     并有单飞锁 inFlight；成功后把新会话重新武装（armed）。
 */
import { randomUUID } from 'node:crypto'
import { formatOccupancy, measureOccupancy, windowConfigOf, type Occupancy, resolvePolicy } from './budget.js'
import { renderHandoffBrief, renderModelAuthoredBrief } from './brief.js'
import { requestModelBrief } from './brief-model.js'
import { CheckpointWriteError, clearPendingBrief, resolveCheckpointRoot, savePendingBrief, writeCheckpoint, findOriginalRequest, writeRequirementFile } from './checkpoint.js'
import type { HandoffCheckpoint, PendingBrief } from './checkpoint.js'
import { collectFacts, cwdOf } from './extract.js'
import { redactValue } from './redact.js'
import type { OrchestratorConfig } from './config.js'
import type { AgentLike, CtxLike, SessionLike } from './types.js'

/** 插件自有消息 kind：DSH v4 行准入要求「生产者自有 kind」，不能再用已退役的 kind:'plugin'。 */
export const PLUGIN_KIND = 'dsh-infinite-context-orchestrator'

/** 单次 apply 内允许的自动 handoff 次数（需求：禁止多次自动换窗）。 */
/** config.maxAutoHandoffs 缺省时的上限（本地小窗口模型需要反复换窗，1 次太狠）。 */
const DEFAULT_MAX_AUTO_HANDOFFS = 10

export interface OrchestratorState {
  /** 单飞锁：一次只允许一个 handoff 在跑。 */
  inFlight: boolean
  /** 本次 apply 已完成的自动 handoff 次数。 */
  autoHandoffs: number
  /** 已发过 notice 的会话（升线只提醒一次，避免每 step 刷屏）。 */
  fired: Map<string, { at: number; percent?: number }>
  /** 已武装（正在被哨兵监视）的会话。 */
  armed: Set<string>
  /** 内存里的待注入简报（与磁盘双写：磁盘是为了跨进程/热重载后仍然生效）。 */
  pendingBriefs: Map<string, PendingBrief>
  /**
   * 换窗后盯新会话的第一条 assistant 消息：
   * 如果它只说话不动手（没有工具调用、且回复很短或只是个问句），补发一次纠正消息。
   * 每个会话只纠正一次。
   */
  firstStepWatch: Map<string, { todo: string; at: number; corrected: boolean }>
  lastHandoff?: {
    at: number
    origin: 'auto' | 'manual'
    sessionId: string
    newSessionId?: string
    checkpointPath: string
    briefChars: number
    /** 交接锚点通过哪种方式送达（developer 消息 / 简报前缀兜底）。 */
    anchorVia?: 'developer' | 'brief-prefix' | 'none'
  }
  lastNotice?: { at: number; text: string }
}

export function createState(): OrchestratorState {
  return {
    inFlight: false,
    autoHandoffs: 0,
    fired: new Map(),
    armed: new Set(),
    pendingBriefs: new Map(),
    firstStepWatch: new Map(),
  }
}

function errorText(error: unknown): string {
  return String((error as Error)?.message ?? error).slice(0, 400)
}

/** 轻量日志（插件不强制依赖 logger 服务，统一走 console 便于排查）。 */
function logWarn(message: string): void {
  try {
    console.warn(`[dsh-infinite-context-orchestrator] ${message}`)
  } catch {    /* ignore */
  }
}

/** 插件 notice（非用户发言）。summary ≤120 字符，UI 单行展示。 */
export function noticeMessage(text: string, summary: string): unknown {
  return {
    role: 'user',
    id: randomUUID(),
    content: [{ type: 'text', text: String(text) }],
    source: { kind: PLUGIN_KIND, form: 'notice', summary: String(summary).slice(0, 120) },
  }
}

export function isSubagentSession(session: SessionLike | undefined): boolean {
  const header = session?.header
  if (header === undefined || header === null) return false
  if (header.origin === 'subagent') return true
  return typeof header.delegationDepth === 'number' && header.delegationDepth > 0
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 等新会话的 agent 变成 live（relay 用的是同一个 ~1s 窗口）。 */
async function waitForLive(ctx: CtxLike, sessionId: string): Promise<AgentLike | undefined> {
  const agents = ctx.get('agents') as { list?: () => AgentLike[]; get?: (id: string) => AgentLike | undefined } | undefined
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const direct = agents?.get?.(sessionId)
      if (direct !== undefined) return direct
      const found = agents?.list?.().find((candidate) => candidate?.session?.id === sessionId)
      if (found !== undefined) return found
    } catch {
      /* 服务暂时不可用：继续等 */
    }
    await wait(50)
  }
  return undefined
}

interface CreatedSession {
  sessionId: string
  via: 'sessionController.create' | 'agents.create'
  live?: AgentLike
}

/**
 * 找出「当前会话属于哪个 Workspace」——也就是 GUI 里的分组。
 *
 * 为什么需要：`sessionController.create` 的参数里 `workspaceId` 与 `cwd` 互斥；
 * **只传 cwd 时新会话不属于任何 Workspace**，UI 就会把它显示成一个新分组（实测现象）。
 * 想留在原分组里，必须把原会话所在 Workspace 的 id 传过去。
 *
 * 数据源是宿主上下文上的 `workspaceRegistry.list()`：每个 workspace 带
 * `id` / `path` / `sessionIds`（`sessionIds` 是该 Workspace 名下的会话，按手工顺序）。
 * 先按「sessionIds 是否包含当前会话」匹配，再退一步按 cwd 路径匹配；
 * 都没有就返回 undefined（保持旧行为，不影响建会话）。
 */
type WorkspaceLike = { id?: unknown; workspaceId?: unknown; path?: unknown; sessionIds?: unknown }

/**
 * 宿主 Workspace 注册表的访问器。
 *
 * 为什么不在函数里直接 `ctx.workspaceRegistry`：Cordis 的上下文是注入代理，
 * **未在 `inject` 里声明的服务属性一取就抛**
 * （实测 `cannot get property "workspaceRegistry" without inject`，而且会把整次交接打断）。
 * 所以由 index.ts 用 `ctx.inject(['workspaceRegistry'], …)` 拿到后写进这里；
 * 拿不到就保持 undefined，交接退回 `cwd`，绝不抛。
 */
let workspaceRegistryAccessor: (() => unknown) | undefined

export function setWorkspaceRegistryAccessor(accessor: (() => unknown) | undefined): void {
  workspaceRegistryAccessor = accessor
}

function readWorkspaceList(): WorkspaceLike[] {
  try {
    const registry = workspaceRegistryAccessor?.() as { list?: () => WorkspaceLike[] } | undefined
    const list = typeof registry?.list === 'function' ? registry.list() : undefined
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

function callerWorkspaceId(_ctx: CtxLike, sessionId: string, cwd: string | undefined): string | undefined {
  const list = readWorkspaceList()
  const idOf = (workspace: WorkspaceLike): string | undefined => {
    const raw = workspace.workspaceId ?? workspace.id
    return typeof raw === 'string' && raw.length > 0 ? raw : undefined
  }

  // ① 归属匹配：这个 Workspace 的 sessionIds 里有当前会话
  for (const workspace of list) {
    const ids = Array.isArray(workspace.sessionIds) ? workspace.sessionIds.map(String) : []
    if (ids.includes(sessionId)) return idOf(workspace)
  }
  // ② 路径匹配（忽略大小写与尾部斜杠）
  if (cwd !== undefined) {
    const normalize = (value: string): string => value.replace(/[\\/]+$/, '').toLowerCase()
    const target = normalize(cwd)
    for (const workspace of list) {
      if (typeof workspace.path === 'string' && normalize(workspace.path) === target) return idOf(workspace)
    }
  }
  return undefined
}
type CreateResult = { ok: true; session: CreatedSession } | { ok: false; message: string }

/**
 * 建一个全新的**顶层**会话（不做 fork，不继承旧会话的 preset 切换）。
 * preset 沿用旧会话的 header.agentPreset；拿不到就让部署默认值决定。
 */
async function createNewSession(ctx: CtxLike, caller: AgentLike, cwd: string | undefined): Promise<CreateResult> {
  const preset = caller?.session?.header?.agentPreset
  // 分组：有 Workspace 就传 workspaceId（与 cwd 互斥），否则退回 cwd。
  const callerSessionId = typeof caller?.session?.id === 'string' ? caller.session.id : ''
  const workspaceId = callerSessionId === '' ? undefined : callerWorkspaceId(ctx, callerSessionId, cwd)
  const agentPreset = typeof preset === 'string' && preset.length > 0 ? preset : undefined
  const controller = ctx.get('sessionController') as
    | { create?: (request: { cwd?: string; workspaceId?: string; agentPreset?: string }) => Promise<{ sessionId?: string }> }
    | undefined

  try {
    if (controller !== undefined && typeof controller.create === 'function') {
      const created = await controller.create({
        // workspaceId 与 cwd 互斥：优先加入原分组，拿不到才用 cwd 自建。
        ...(workspaceId === undefined ? (cwd === undefined ? {} : { cwd }) : { workspaceId }),
        ...(agentPreset === undefined ? {} : { agentPreset }),
      })
      const sessionId = typeof created?.sessionId === 'string' ? created.sessionId : ''
      if (sessionId.length === 0) {
        return { ok: false, message: 'sessionController.create 没有返回 sessionId' }
      }
      return { ok: true, session: { sessionId, via: 'sessionController.create', live: await waitForLive(ctx, sessionId) } }
    }

    // 兜底路径：与 relay_handoff 的 agents.create 分支保持一致。
    const agents = ctx.get('agents') as
      | {
        create?: (options: {
          sessionId: string
          meta: { cwd?: string; agentPreset?: string }
          setup: (agentCtx: unknown) => Promise<unknown>
        }) => Promise<{ agent?: AgentLike }>
      }
      | undefined
    const presets = ctx.get('agentPresets') as { mount?: (agentCtx: unknown, id?: string) => Promise<unknown> } | undefined
    if (agents === undefined || typeof agents.create !== 'function' || presets === undefined || typeof presets.mount !== 'function') {
      return { ok: false, message: 'sessionController 与 agents/agentPresets 都不可用，无法创建新会话' }
    }

    const sessionId = `session-${randomUUID()}`
    const handle = await agents.create({
      sessionId,
      meta: { ...(cwd === undefined ? {} : { cwd }), ...(agentPreset === undefined ? {} : { agentPreset }) },
      setup: async (agentCtx: unknown) => presets.mount?.(agentCtx, agentPreset),
    })
    const live = handle?.agent ?? await waitForLive(ctx, sessionId)
    return { ok: true, session: { sessionId, via: 'agents.create', live } }
  } catch (error) {
    return { ok: false, message: `创建新会话失败：${errorText(error)}` }
  }
}

/** 半创建会话的 best-effort 清理（建了但首条消息没发出去）。 */
function disposeHalfCreated(ctx: CtxLike, sessionId: string): void {  try {
    const agents = ctx.get('agents') as { get?: (id: string) => AgentLike | undefined } | undefined
    agents?.get?.(sessionId)?.dispose?.()
  } catch {
    /* best-effort */
  }
}

/** 只需要 append 的会话面（开发者消息注入用）。 */
interface AppendableSession {
  append?: (type: string, data: unknown, options?: unknown) => unknown
}

/**
 * 把交接锚点作为 **developer 消息**追加到新会话历史开头。
 *
 * 为什么 turn/step 是 1 而不是 0：DSH 的会话格式 v4 要求
 * `developer/message` 的 turn/step **必须是正整数**（校验器报
 * "format v4 developer/message turn must be positive"），
 * 写 0 会让新会话的第一轮直接失败 —— 这是实测踩到的。
 *
 * 为什么用 developer 而不是再加一条 user 消息：developer 的优先级高于用户发言，
 * 且这条落在 history 的最前面 → 新会话的第一个请求就能读到「第一件事做什么」。
 * 追加失败返回 false，调用方会把锚点拼进简报兜底。
 */
function appendDeveloperAnchor(session: unknown, text: string): boolean {
  const target = session as AppendableSession | undefined
  if (target === undefined || typeof target.append !== 'function') return false
  try {
    target.append(
      'developer/message',
      {
        turn: 1,
        step: 1,
        message: {
          role: 'developer',
          id: randomUUID(),
          content: [{ type: 'text', text }],
          source: { kind: PLUGIN_KIND, form: 'handoff' },
        },
      },
      { surfaceOp: 'append' },
    )
    return true
  } catch (error) {
    logWarn(`developer 交接锚点追加失败，改用简报前缀兜底：${errorText(error)}`)
    return false
  }
}

/**
 * 交接成功后给**旧会话**的待办收尾：追加一条 `todo/write` 快照，把整张列表标成已完成。
 *
 * 为什么要做（`markTodosHandedOff`，默认开）：待办是每个会话各自的状态，且投影只在
 * `turn/start` 时清空。旧窗口交接完就停手，那条"进行中"会一直挂着，看起来像交接失败。
 * 收尾只改状态、不改文本；关掉开关就保持原样（通知里会如实说明）。
 */
function markHandedOffTodos(session: unknown, todos: Array<{ text: string; status: string }>): boolean {
  const target = session as AppendableSession | undefined
  if (target === undefined || typeof target.append !== 'function') return false
  if (todos.length === 0) return false
  try {
    target.append('todo/write', {
      todos: todos.map((item) => ({ content: item.text, status: 'completed' })),
    })
    return true
  } catch (error) {
    logWarn(`旧会话待办收尾失败（不影响交接）：${errorText(error)}`)
    return false
  }
}

export type HandoffCode =
  | 'ok'
  | 'disabled'
  | 'busy'
  | 'rate-limited'
  | 'checkpoint-write-failed'
  | 'session-create-failed'
  | 'session-not-live'
  | 'followup-failed'

export interface HandoffOutcome {
  ok: boolean
  code: HandoffCode
  message: string
  checkpointPath?: string
  newSessionId?: string
  briefChars?: number
  /** 简报实际由谁写：模板或模型（模型失败时是 plugin + briefFallbackReason）。 */
  briefAuthoredBy?: 'plugin' | 'model'
  /** 选了模型撰写但失败时的原因（已回退模板）。 */
  briefFallbackReason?: string
  /** 交接锚点的送达方式：developer 消息（首选）或简报前缀（兜底）。 */
  anchorVia?: 'developer' | 'brief-prefix' | 'none'
  /** 旧窗口那句「任务已转移」是用 followup（立刻可见）还是 inject（不唤醒）发的。 */
  transferVia?: 'followup' | 'inject'
  /** 是否把旧会话里未完成的待办标成了已完成。 */
  todosMarked?: boolean
  occupancy?: Occupancy
  summary: string
}

export interface HandoffDeps {
  ctx: CtxLike
  config: OrchestratorConfig
  state: OrchestratorState
  root: string
}

/** 组装检查点文档（全部字段过一遍脱敏，除路径与时间）。 */
function factsCwd(caller: AgentLike | undefined): string {
  const header = caller?.session?.header
  if (typeof header?.cwd === 'string' && header.cwd.length > 0) return header.cwd
  return cwdOf(caller) ?? ''
}

function buildCheckpoint(
  caller: AgentLike,
  facts: ReturnType<typeof collectFacts>,
  occupancy: Occupancy,
  thresholdPercent: number,
  extraNote?: string,
): HandoffCheckpoint {
  const redacted = redactValue(facts) as typeof facts
  const header = caller?.session?.header
  const notes = [
    ...redacted.notes,
    ...(typeof extraNote === 'string' && extraNote.trim().length > 0 ? [`交接原因：${extraNote.trim()}`] : []),
  ]
  return {
    version: 1,
    plugin: PLUGIN_KIND,
    createdAt: new Date().toISOString(),
    sessionId: String(caller?.session?.id ?? ''),
    ...(typeof header?.parentSession === 'string' ? { parentSession: header.parentSession } : {}),
    ...(typeof header?.agentPreset === 'string' ? { agentPreset: header.agentPreset } : {}),
    ...(typeof header?.cwd === 'string' ? { cwd: header.cwd } : {}),
    goal: redacted.goal,
    done: redacted.done,
    pending_todos: redacted.pending_todos,
    key_decisions: redacted.key_decisions,
    last_human_request: redacted.last_human_request,
    ...(redacted.original_request.trim().length === 0
      ? {}
      : {
        original_request: redacted.original_request,
        original_request_source: redacted.original_request_source,
        original_request_chars: redacted.original_request.length,
      }),
    checkpoint_path: '',
    occupancy: {
      ...(occupancy.usedTokens === undefined ? {} : { usedTokens: Math.round(occupancy.usedTokens) }),
      ...(occupancy.windowTokens === undefined ? {} : { windowTokens: Math.round(occupancy.windowTokens) }),
      ...(occupancy.percent === undefined ? {} : { percent: occupancy.percent }),
      thresholdPercent,
      source: occupancy.source,
    },
    ...(notes.length === 0 ? {} : { notes }),
  }
}

/**
 * 执行完整闭环。调用方负责：origin='auto' 时先确认 enabled / autoHandoff。
 * 任何一步失败都保持当前会话，并把可操作的路径/原因写进返回值与 notice。
 */
export async function performHandoff(
  deps: HandoffDeps,
  caller: AgentLike,
  origin: 'auto' | 'manual',
  /** 手动触发时可附一句「为什么现在换窗」，会写进检查点 notes。 */
  extraNote?: string,
): Promise<HandoffOutcome> {
  const { ctx, config, state, root } = deps

  if (state.inFlight) {
    return { ok: false, code: 'busy', message: '已有一个 handoff 正在执行，本次跳过。', summary: 'refused: handoff already in flight' }
  }
  // 自动换窗次数上限：**按配置**（0 = 不限制）。早期版本写死 1 次，
  // 结果本地小窗口模型（64K）在第二个窗口就不再换窗，直接被服务端 400 打断。
  const maxAuto = config.maxAutoHandoffs ?? DEFAULT_MAX_AUTO_HANDOFFS
  if (origin === 'auto' && maxAuto > 0 && state.autoHandoffs >= maxAuto) {
    return {
      ok: false,
      code: 'rate-limited',
      message: `本次插件加载内已自动换窗 ${state.autoHandoffs} 次（上限 ${maxAuto}），不再自动换窗；`
        + '需要时请手动调用 infinite_context_handoff，或重启 DSH 重置计数（也可在设置里调大「自动换窗次数上限」）。',
      summary: 'refused: auto handoff rate limit',
    }
  }

  state.inFlight = true
  try {
    const sessionId = String(caller?.session?.id ?? '')
    const cwd = cwdOf(caller)
    const occupancy = await measureOccupancy(ctx, caller, windowConfigOf(config))

    // ── 1. 暂停 + 写检查点（fail-closed：写不进去就不换窗）───────────────
    const facts = collectFacts(ctx, caller)
  // 原始需求：本窗口没有（交接出来的窗口只有插件通知）就从最近的检查点继承，
  // 否则第 N 个窗口只知道"做到哪了"，不知道"要做什么"（实测会彻底跑偏）。
  if (facts.original_request.trim().length === 0 && config.carryOriginalRequest) {
    const inherited = findOriginalRequest(root, factsCwd(caller))
    if (inherited !== undefined) {
      facts.original_request = inherited.text
      facts.original_request_source = inherited.source
    }
  }
  if (config.carryOriginalRequest && facts.original_request.trim().length > 0) {
    // 人可读的落盘：requirements/<工作区>.md（内容不变就不重写）
    writeRequirementFile(root, factsCwd(caller), facts.original_request, facts.original_request_source)
  }
    const doc = buildCheckpoint(caller, facts, occupancy, resolvePolicy(config, caller.session).thresholdPercent, extraNote)
    let written: { checkpointPath: string; bytes: number; trimmed: boolean }
    try {
      written = await writeCheckpoint(root, doc, config.checkpointMaxBytes)
    } catch (error) {
      const reason = error instanceof CheckpointWriteError ? error.message : errorText(error)
      const message = `检查点写入失败，已取消换窗（fail-closed，当前会话不受影响）：${reason}`
      notifyCaller(ctx, caller, `【任务自动换窗】${message}\n检查点根目录：${root}`, '[infinite-context] checkpoint write failed, handoff aborted')
      return { ok: false, code: 'checkpoint-write-failed', message, summary: `fail-closed: checkpoint write failed (${reason})`, occupancy }
    }

    // ── 2. 渲染简报（受 handoffBriefMaxChars + 项目摘要预留约束）─────────
    // briefAuthor = 'model' 时多一次模型调用让模型写叙述小节；任何失败都回退模板，
    // 绝不因为"写不出简报"而阻断换窗。
    const briefOptions = {
      maxChars: config.handoffBriefMaxChars,
      projectProgressReserveChars: config.projectProgressReserveChars,
      ...(cwd === undefined ? {} : { cwd }),
      occupancyLine: formatOccupancy(occupancy),
    }
    let brief = renderHandoffBrief(facts, written.checkpointPath, briefOptions)
    let briefAuthoredBy: 'plugin' | 'model' = 'plugin'
    let briefFallbackReason: string | undefined
    /** 模型撰写的原始文本（兜底重渲染时要保留作者，不能退回模板）。 */
    let modelBriefText: string | undefined
    if (config.briefAuthor === 'model') {
      const attempt = await requestModelBrief(ctx, caller, {
        facts,
        checkpointPath: written.checkpointPath,
        occupancyLine: briefOptions.occupancyLine,
        maxChars: config.handoffBriefMaxChars,
      })
      if (attempt.ok && typeof attempt.text === 'string') {
        modelBriefText = attempt.text
        brief = renderModelAuthoredBrief(attempt.text, facts, written.checkpointPath, briefOptions)
        briefAuthoredBy = 'model'
      } else {
        briefFallbackReason = attempt.reason
        logWarn(`【任务自动换窗】模型撰写简报失败，已回退到模板：${attempt.reason ?? '未知原因'}`)
      }
    }

    // ── 3. 建新顶层会话 ──────────────────────────────────────────────────
    const created = await createNewSession(ctx, caller, cwd)
    if (created.ok === false) {
      const message = `${created.message}\n检查点已保留，需要时手动引用：${written.checkpointPath}`
      notifyCaller(ctx, caller, `【任务自动换窗】新会话创建失败，保持在当前会话。\n${message}`, '[infinite-context] session create failed, checkpoint kept')
      return {
        ok: false,
        code: 'session-create-failed',
        message,
        checkpointPath: written.checkpointPath,
        briefChars: brief.chars,
        summary: 'session creation failed; checkpoint kept for manual reference',
        occupancy,
      }
    }

    const { sessionId: newSessionId, via, live } = created.session

    // ── 4. 先落「待注入简报」，再触发首轮 ────────────────────────────────
    // 顺序不能反：systemPrompt.section 在首次组装请求时读这份文件，
    // 如果先 followup 后写文件，新会话的第一次请求可能还没看到简报。
    const pending: PendingBrief = {
      sessionId: newSessionId,
      createdAt: Date.now(),
      text: brief.text,
      checkpointPath: written.checkpointPath,
      sourceSessionId: sessionId,
    }

    // ── 4.5 交接锚点：拼到简报最前面（系统提示里）─────────────────────────
    // **不要**再 append developer 消息：会话格式要求 developer/message 必须落在
    // 「已开启的 turn/step」内，而锚点是在新会话首轮开始**之前**写的，
    // 实测会把会话日志写成 corrupt：
    //   SessionFormatError: developer/message does not match an open turn and step
    // 拼进简报同样能在首个请求前进入 system prompt，且不会破坏日志格式。
    const firstTodo = facts.pending_todos[0]
    const anchorText = firstTodo === undefined
      ? '交接锚点：本窗口没有留下待办。按已完成进度与原始需求继续推进，不要停下来问用户；不要重做已完成的部分、不要自行扩大范围。'
      : `交接锚点：本次交接的第一步是「${firstTodo}」。先把它做完，再做其它；不要重复已完成的工作。`
    const anchorVia = 'brief-prefix' as const
    if (anchorVia === 'brief-prefix') {
      const prefix = `## 交接锚点\n${anchorText}\n\n`
      // 兜底时锚点会占掉预算：按剩余额度重渲染一次，保证整份简报仍在上限内。
      if (config.handoffBriefMaxChars > 0) {
        const reduced = Math.max(200, config.handoffBriefMaxChars - prefix.length)
        const reducedOptions = { ...briefOptions, maxChars: reduced }
        brief = modelBriefText === undefined
          ? renderHandoffBrief(facts, written.checkpointPath, reducedOptions)
          : renderModelAuthoredBrief(modelBriefText, facts, written.checkpointPath, reducedOptions)
      }
      pending.text = prefix + brief.text
    }

    let briefPersisted = true
    try {
      await savePendingBrief(root, pending)
    } catch (error) {
      briefPersisted = false
      void error
    }
    state.pendingBriefs.set(newSessionId, pending)

    // 盯住新会话的第一条 assistant 消息：只说话不动手就补一次纠正。
    if (firstTodo !== undefined) {
      state.firstStepWatch.set(newSessionId, { todo: firstTodo, at: Date.now(), corrected: false })
    }

    // ── 5. 触发新会话首轮（只发指针；正文在 system prompt 里）────────────
    const pointer = [
      `已按交接检查点完成换窗（检查点：${written.checkpointPath}）。`,
      '交接简报已注入本轮系统提示的前部；请先读“待办”，从第一项继续，不要重新开始已完成的工作。',
      '如果简报缺少关键信息，直接读上面的检查点文件补齐。',
    ].join('\n')
    const followup = live?.followup
    if (typeof followup !== 'function') {
      disposeHalfCreated(ctx, newSessionId)
      state.pendingBriefs.delete(newSessionId)
      // 文件也要撤掉：否则这个已被丢弃的会话若日后被打开，会读到一份无主的简报。
      clearPendingBrief(root, newSessionId)
      const message = [
        `新会话 ${newSessionId} 已创建，但它的 agent 没有在 ~1s 内变为 live，首条消息没有发出去。`,
        `检查点已保留：${written.checkpointPath}`,
        '你可以手动打开该会话，或重新调用 infinite_context_handoff。',
      ].join('\n')
      notifyCaller(ctx, caller, `【任务自动换窗】${message}`, '[infinite-context] new session not live, checkpoint kept')
      return {
        ok: false,
        code: 'session-not-live',
        message,
        checkpointPath: written.checkpointPath,
        newSessionId,
        summary: 'session created but never became live; checkpoint kept',
        occupancy,
      }
    }

    try {
      followup.call(live, noticeMessage(pointer, '[infinite-context] 交接完成，新会话已注入交接简报'))
    } catch (error) {
      disposeHalfCreated(ctx, newSessionId)
      state.pendingBriefs.delete(newSessionId)
      clearPendingBrief(root, newSessionId)
      const message = `新会话已创建但首条消息发送失败（${errorText(error)}）。检查点已保留：${written.checkpointPath}`
      notifyCaller(ctx, caller, `【任务自动换窗】${message}`, '[infinite-context] followup failed, checkpoint kept')
      return {
        ok: false,
        code: 'followup-failed',
        message,
        checkpointPath: written.checkpointPath,
        newSessionId,
        summary: 'first prompt failed to dispatch; checkpoint kept',
        occupancy,
      }
    }

    // 交接已成立：按开关给旧会话的待办收尾（不阻塞，失败只记日志）。
    const todosMarked = config.markTodosHandedOff
      ? markHandedOffTodos(caller?.session, facts.allTodos)
      : false

    // ── 6. 记账 + 重新武装新会话 ─────────────────────────────────────────
    try {
      const titles = ctx.get('sessionTitle') as { rename?: (session: unknown, title: string) => unknown } | undefined
      const goal = facts.goal.replace(/\s+/g, ' ').trim()
      titles?.rename?.(live?.session, `交接 · ${goal.length > 30 ? `${goal.slice(0, 30)}…` : goal || newSessionId.slice(0, 12)}`)
    } catch {
      /* 标题失败不阻断 */
    }

    if (origin === 'auto') state.autoHandoffs += 1
    state.armed.add(newSessionId)
    state.fired.delete(newSessionId)
    state.lastHandoff = {
      at: Date.now(),
      origin,
      sessionId,
      newSessionId,
      checkpointPath: written.checkpointPath,
      briefChars: brief.chars,
    }

    const message = [
      `换窗完成（${via}）。`,
      `新会话：${newSessionId}`,
      `检查点：${written.checkpointPath}（${written.bytes}B${written.trimmed ? '，已按体积上限裁剪' : ''}）`,
      `简报：${brief.chars} 字符${brief.hasProjectSummary ? '（含项目级摘要）' : ''}${briefPersisted ? '' : '；注意：简报文件落盘失败，本次仅内存注入'}`,
      `简报来源：${briefAuthoredBy === 'model' ? '模型撰写' : '插件模板'}${briefFallbackReason === undefined ? '' : `（模型撰写失败已回退：${briefFallbackReason}）`}`,
      `交接锚点：已拼在简报最前面（随 system prompt 一起注入）${firstTodo === undefined ? '' : `，第一件事：${firstTodo}`}`,
      `占用：${formatOccupancy(occupancy)}`,
      // 旧窗口的待办默认会被收尾（标成已完成），否则它会一直挂着"进行中"的假任务，
      // 让人以为交接没成功。关掉开关时如实说明"仍显示为未完成"。
      facts.pending_todos.length === 0
        ? '本窗口的待办列表：空（没有需要转移的任务）。'
        : todosMarked
          ? `本窗口的 ${facts.pending_todos.length} 项待办已标记为已完成（内容已随交接写入新会话）；本窗口可以关闭。`
          : `本窗口的 ${facts.pending_todos.length} 项待办已随交接写入新会话，但仍显示为未完成（可在设置 → 高级里开启「交接后收尾旧待办」）；本窗口可以直接关闭。`,
    ].join('\n')

    // 通知旧窗口。
    // 关键差别：`inject` 只是"放进收件箱、等下一步"，**旧窗口空闲时不会被渲染成卡片**
    // （要等它下次开始一轮才领取）。想让人立刻看到"任务已转移"，必须用 `followup`
    // 主动开一次很短的回复 —— 所以这里按开关切换，并在文本里明确禁止继续干活。
    const transferVia = notifyTransferred(ctx, caller, config, message, newSessionId, written.checkpointPath)
  // B：叫停旧会话当前轮——它的工作已经交接完，继续跑只会和新窗口抢模型。
  cancelCallerTurn(ctx, String(caller?.session?.id ?? ''))

    return {
      ok: true,
      code: 'ok',
      message,
      checkpointPath: written.checkpointPath,
      newSessionId,
      briefChars: brief.chars,
      briefAuthoredBy,
      ...(briefFallbackReason === undefined ? {} : { briefFallbackReason }),
      anchorVia,
      todosMarked,
      transferVia,
      occupancy,
      summary: `handoff ok → ${newSessionId}`,
    }
  } finally {
    state.inFlight = false
  }
}

/**
 * 换窗后通知**旧窗口**（由 `notifyTransferredSession` 控制，默认开）：使用 inject，**不唤醒**。
 *
 * - **followup**：主动开一次极短的回复，保证旧窗口立刻出现一张「任务已转移」的卡片。
 *   为什么不能只用 inject：`inject` 只是放进收件箱等下一步，**旧窗口空闲时不会渲染**
 *   （要等它下次开始一轮才被领取），体验上等于什么都没发生。
 *   代价是旧窗口多一轮很短的回答，所以文本里明确禁止继续干活、禁止调用工具。
 * - **inject**（关掉开关时）：不唤醒、省一个 turn，但可能一直看不见。
 */
/**
 * 叫停旧会话当前轮（best-effort）。
 * 为什么：换窗后旧窗口若继续生成，会和新窗口同时请求同一个模型服务；
 * 本地 llama.cpp 常是 n_parallel=1，两边会互相排队甚至触发超时。
 */
function cancelCallerTurn(ctx: CtxLike, sessionId: string): void {
  try {
    const controller = ctx.get('sessionController') as
      | { cancel?: (request: { sessionId: string }) => unknown }
      | undefined
    if (controller === undefined || typeof controller.cancel !== 'function') return
    void Promise.resolve(controller.cancel({ sessionId })).catch(() => undefined)
  } catch (error) {
    logWarn(`叫停旧会话失败（不影响交接）：${errorText(error)}`)
  }
}

/**
 * 在旧会话里追加一条 **developer 消息**（系统级提示），说明任务已转移。
 *
 * 为什么用 append 而不是 followup/inject：
 * - followup 会**唤醒**旧窗口开一轮回答 → 和新窗口抢模型（本项目实测过）；
 * - inject 只是放进收件箱，旧窗口空闲时要等下次被使用才看得到；
 * - append 直接写进会话日志，**不触发任何 turn**，界面里立刻能看到一条「系统提示」。
 */
function appendTransferNotice(caller: AgentLike, text: string): boolean {
  const session = caller?.session as
    | { append?: (type: string, data: unknown, opts?: unknown) => unknown; snapshotEvents?: () => Array<{ type?: string; data?: { turn?: number } }> }
    | undefined
  if (session === undefined || typeof session.append !== 'function') return false
  try {
    let turn = 1
    try {
      const events = session.snapshotEvents?.() ?? []
      for (let index = events.length - 1; index >= 0; index -= 1) {
        const candidate = events[index]?.data?.turn
        if (typeof candidate === 'number' && candidate > 0) { turn = candidate; break }
      }
    } catch {
      /* 拿不到就用 1 */
    }
    session.append(
      'developer/message',
      {
        turn,
        step: 1,
        message: {
          role: 'developer',
          id: randomUUID(),
          content: [{ type: 'text', text }],
          source: { kind: PLUGIN_KIND, form: 'transfer' },
        },
      },
      { surfaceOp: 'append' },
    )
    return true
  } catch (error) {
    logWarn(`旧窗口系统提示追加失败（不影响交接）：${errorText(error)}`)
    return false
  }
}

function notifyTransferred(
  ctx: CtxLike,
  caller: AgentLike,
  config: OrchestratorConfig,
  detail: string,
  newSessionId: string,
  checkpointPath: string,
): 'followup' | 'inject' {
  const banner = [
    '【任务自动换窗】本窗口的任务已转移到新会话。',
    `新会话：${newSessionId}`,
    `检查点：${checkpointPath}`,
    '请到新会话继续；本窗口只用于回顾。不要在这里继续执行工作、不要调用工具，回一句「已交接」即可。',
    '',
    '— 本次换窗明细 —',
    detail,
  ].join('\n')
  const summary = '[infinite-context] 任务已转移到新会话，本窗口只用于回顾'

  // 默认用 inject：不唤醒旧窗口，避免它为了回一句「已交接」再开一轮，
  // 和新窗口抢同一个模型（实测两个窗口并行时 server n_parallel=1 会互相排队）。
  if (!config.notifyTransferredSession) return 'inject'
  // 先写进会话日志（立刻出现在对话末尾、不唤醒）；写不进再退回 inject（进收件箱）。
  if (appendUserNotice(caller, banner, summary)) return 'inject'
  notifyCaller(ctx, caller, banner, summary)
  return 'inject'
}

/**
 * 在旧会话末尾追加一条 **user 消息**（插件署名），立即出现在对话里。
 *
 * 为什么用 append + user/message：
 * - 会话格式 v4 里只有 `developer/message` 要求「已开启的 turn/step」，`user/message` 没有这个限制；
 * - `inject` 只是塞进收件箱（next-step），旧窗口空闲时**永远不会渲染**——用户实测看不到；
 * - `followup` 会唤醒旧窗口多跑一轮（会和接手的窗口抢模型）。
 */
function appendUserNotice(caller: AgentLike, text: string, summary: string): boolean {
  const session = caller?.session as { append?: (type: string, data: unknown, opts?: unknown) => unknown } | undefined
  if (session === undefined || typeof session.append !== 'function') return false
  try {
    session.append('user/message', noticeMessage(text, summary), { surfaceOp: 'append' })
    return true
  } catch (error) {
    logWarn(`旧窗口提示写入会话日志失败：${errorText(error)}`)
    return false
  }
}
/** 向当前会话注入插件 notice；失败不抛（notice 不是关键路径）。 */
export function notifyCaller(ctx: CtxLike, caller: AgentLike, text: string, summary: string): void {
  void ctx
  try {
    if (typeof caller?.inject === 'function') caller.inject(noticeMessage(text, summary))
  } catch {
    /* notice 失败不影响主流程 */
  }
}

/** 解析本次生效的检查点根目录（工具与 notice 共用一个真源）。 */
export function checkpointRootOf(config: OrchestratorConfig): string {
  return resolveCheckpointRoot(config.checkpointRoot)}
