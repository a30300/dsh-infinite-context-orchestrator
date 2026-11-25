/**
 * Host 侧的设置 HTTP 面（给本插件的设置页读写配置）。
 *
 * 为什么不用 `ctx.configForms`：本机这版 DSH 的客户端服务目录里**没有** configForms
 * （只有 layout/locale/sessions/slots/theme/timer/uiWorkspace/workspaces），沙箱插件的
 * 设置页也因此没注册上。用自建 exact 路由 + 同源 fetch 是这套环境里**已验证**的路径
 * （dsh-context-relay 的客户端就是这么读写的）。
 *
 * 认证走连接层 `connection.requestRejection`：未认证一律 401（fail-closed）。
 * 写回走 `configEditor`：宿主自己的「校验 → 持久化 → reconcile」路径，原子且会触发
 * 插件重载；绝不自己改 YAML。
 */
import type { OrchestratorConfig } from './config.js'
import { CONFIG_DEFAULTS, resolveConfig } from './config.js'
import { readLatestPointer } from './checkpoint.js'
import { measureOccupancy } from './budget.js'
import { safeCall, withTimeout } from './timeout.js'
import type { OrchestratorState } from './handoff.js'
import type { CtxLike } from './types.js'

export const SETTINGS_ROUTE = '/infinite-context/settings'

/** 路由是否已挂载（状态工具会报告，排查「设置页打不开」的第一现场）。 */
let mounted = false

export function isSettingsRouteMounted(): boolean {
  return mounted
}

/** 设置页能改的字段白名单。 */
const EDITABLE_KEYS = [
  'enabled',
  'maxAutoHandoffs',
  'contextWindowByModel',
  'thresholdByModel',
  'autoHandoff',
  'markTodosHandedOff',
  'notifyTransferredSession',
  'checkpointMaxBytes',
  'handoffBriefMaxChars',
  'checkpointRoot',
  'projectProgressReserveChars',
  'briefAuthor',
  'carryOriginalRequest',
] as const

const MAX_BODY_BYTES = 8192

export interface RouteDeps {
  ctx: CtxLike
  config: OrchestratorConfig
  state: OrchestratorState
  root: string
}

interface MinimalRequest {
  /** 完整 URL（含 query），用于 ?models=1 之类的分支。 */
  url?: string
  method?: string
  headers?: unknown
  on: (event: string, handler: (chunk?: Buffer) => void) => void
}

interface MinimalResponse {
  statusCode: number
  headersSent?: boolean
  setHeader: (name: string, value: string) => void
  end: (body?: string) => void
}

function sendJson(res: MinimalResponse, status: number, value: unknown): void {
  try {
    if (res.headersSent !== true) {
      res.statusCode = status
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.setHeader('cache-control', 'no-store')
    }
    res.end(JSON.stringify(value))
  } catch {
    /* 连接已断：忽略 */
  }
}

function sendError(res: MinimalResponse, status: number, code: string, message: string): void {
  sendJson(res, status, { ok: false, code, message: String(message) })
}

async function readJsonBody(req: MinimalRequest): Promise<unknown> {
  const chunks: Buffer[] = []
  let bytes = 0
  return await new Promise((resolve, reject) => {
    if (typeof req?.on !== 'function') {
      reject(new Error('request body is not readable'))
      return
    }
    req.on('data', (chunk?: Buffer) => {
      if (chunk === undefined) return
      bytes += chunk.length
      if (bytes > MAX_BODY_BYTES) {
        reject(new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8').trim()
        resolve(text.length === 0 ? {} : JSON.parse(text))
      } catch (error) {
        reject(new Error(`invalid JSON body: ${String((error as Error)?.message ?? error)}`))
      }
    })
    req.on('error', (error?: Buffer) => reject(error instanceof Error ? error : new Error('request stream failed')))
  })
}

/** 从 configEditor 的行清单里认出本插件的行。 */
function findOwnEntry(entries: Array<{ entry?: Record<string, unknown> } | undefined>): Record<string, unknown> | undefined {
  for (const item of entries ?? []) {
    const entry = item?.entry
    if (entry === undefined || entry === null) continue
    for (const field of ['id', 'patchId', 'name']) {
      const value = entry[field]
      if (typeof value === 'string' && value.includes('infinite-context-orchestrator')) return entry
    }
  }
  return undefined
}

function pickEditable(input: unknown): Record<string, unknown> {
  const body = input !== null && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const out: Record<string, unknown> = {}
  for (const key of EDITABLE_KEYS) {
    if (body[key] !== undefined) out[key] = body[key]
  }
  return out
}

/**
 * 「恢复默认」= 把字段回填成出厂值，而不是发送空字符串/null。
 * 空字符串对数值字段必然校验失败（400），所以由宿主侧用 CONFIG_DEFAULTS 回填。
 */
function pickResettable(input: unknown): string[] {
  const body = input !== null && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const raw = body.reset
  if (!Array.isArray(raw)) return []
  return raw.filter((key): key is (typeof EDITABLE_KEYS)[number] =>
    typeof key === 'string' && (EDITABLE_KEYS as readonly string[]).includes(key))
}

/** 模型目录缓存：设置页每次打开都会问，不能每次都触网发现。 */
let catalogCache: { at: number; value: unknown } | undefined
const MODEL_CACHE_TTL_MS = 5 * 60 * 1000
const MODEL_DISCOVER_TIMEOUT_MS = 4000

/**
 * 给可能触网的发现调用加超时，避免设置页卡住。
 *
 * 关键：有的宿主实现里 `llm.listProviders()` 返回的**不是 Promise**（同步值或自定义 thenable），
 * 直接调 `.then` 会抛 `task.then is not a function` → 整个请求 500。
 * 所以统一先 `Promise.resolve` 包一层（实测踩过这个 500）。
 */
interface LlmCatalogLike {
  listProviders?: () => Promise<Array<{ id?: unknown; name?: unknown }>>
  listModels?: (provider: string) => Promise<Array<Record<string, unknown>>>
}

/**
 * 读取 DSH 的 provider / 模型目录（含声明窗口）。
 * 一次失败不影响其它 provider：每个 provider 独立 try/catch，失败记 error 字段。
 */
async function discoverModelCatalog(ctx: CtxLike): Promise<{ ok: boolean; providers: unknown[]; error?: string }> {
  const llm = ctx.get('llm') as LlmCatalogLike | undefined
  if (llm === undefined || typeof llm.listProviders !== 'function') {
    return { ok: false, providers: [], error: 'llm 服务不可用（拿不到模型目录）' }
  }
  const providers = (await withTimeout(safeCall(() => llm.listProviders?.()), MODEL_DISCOVER_TIMEOUT_MS)) ?? []
  const out: unknown[] = []
  for (const provider of providers) {
    const id = typeof provider?.id === 'string' ? provider.id : undefined
    if (id === undefined) continue
    const name = typeof provider?.name === 'string' ? provider.name : id
    let models: Array<Record<string, unknown>> = []
    if (typeof llm.listModels === 'function') {
      models = (await withTimeout(safeCall(() => llm.listModels?.(id)), MODEL_DISCOVER_TIMEOUT_MS)) ?? []
    }
    out.push({
      id,
      name,
      models: models
        .filter((model) => typeof model?.id === 'string')
        .map((model) => ({
          id: String(model.id),
          name: typeof model.name === 'string' ? model.name : String(model.id),
          // 不同适配器有的给 context.contextWindow，有的直接给 contextWindow
          contextWindow: typeof (model.context as { contextWindow?: unknown } | undefined)?.contextWindow === 'number'
            ? (model.context as { contextWindow: number }).contextWindow
            : typeof model.contextWindow === 'number' ? model.contextWindow : null,
        })),
    })
  }
  return { ok: true, providers: out }
}
/** 请求是否要模型目录（`?models=1`）。 */
function wantsModels(req: MinimalRequest): boolean {
  const url = typeof req?.url === 'string' ? req.url : ''
  const query = url.includes('?') ? url.slice(url.indexOf('?') + 1) : ''
  return /(^|&)models=1(&|$)/.test(query)
}
export function registerSettingsRoutes(deps: RouteDeps): void {
  const { ctx, config, state, root } = deps

  const snapshot = () => ({
    ok: true,
    config,
    checkpointRoot: root,
    lastCheckpointPath: state.lastHandoff?.checkpointPath ?? readLatestPointer(root)?.checkpointPath ?? null,
    lastHandoff: state.lastHandoff ?? null,
    inFlight: state.inFlight,
  })
  /**
   * 列出 DSH 认得的所有 provider / 模型及其声明窗口，供设置页「按模型设上下文长度」用。
   * 走宿主 llm 服务（listProviders → listModels），带超时与 5 分钟缓存：
   * 某些 provider 的模型发现可能触网，不能让它拖慢设置页。
   */
  const listModelCatalog = async (): Promise<unknown> => {
    const now = Date.now()
    if (catalogCache !== undefined && now - catalogCache.at < MODEL_CACHE_TTL_MS) return catalogCache.value
    const value = await discoverModelCatalog(ctx)
    catalogCache = { at: now, value }
    return value
  }
  /**
   * 探测「DSH 自己读到的窗口大小」，给设置页展示用（用户据此决定要不要填自定值）。
   * 用最近活跃的会话 + `windowOverride = 0` 测一次，拿到的就是 DSH 的原生值。
   */
  const probeWindow = async (): Promise<Record<string, unknown> | null> => {
    try {
      const agents = ctx.get('agents') as
        | { list?: () => Array<Parameters<typeof measureOccupancy>[1]> }
        | undefined
      const list = agents?.list?.()
      const last = Array.isArray(list) ? list[list.length - 1] : undefined
      if (last === undefined) return null
      const occupancy = await measureOccupancy(ctx, last, {})
      return {
        windowTokens: occupancy.windowTokens ?? null,
        windowSource: occupancy.windowSource ?? 'unknown',
        usedTokens: occupancy.usedTokens ?? null,
        percent: occupancy.percent ?? null,
      }
    } catch {
      return null
    }
  }
  const handler = async (req: MinimalRequest, res: MinimalResponse): Promise<void> => {
    // 认证：与 relay 同一套连接层判断；异常一律 fail-closed。
    try {
      const connection = ctx.get('connection') as { requestRejection?: (request: { headers?: unknown }) => unknown } | undefined
      const rejection = connection?.requestRejection?.({ headers: req?.headers })
      if (typeof rejection === 'number') {
        res.statusCode = rejection
        res.setHeader('content-type', 'text/plain; charset=utf-8')
        res.setHeader('cache-control', 'no-store')
        res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
        return
      }
    } catch {
      sendError(res, 503, 'auth-unavailable', 'authentication layer unavailable')
      return
    }

    try {
      const method = String(req?.method ?? 'GET').toUpperCase()

      if (method === 'GET') {
        // probe 让设置页能同时显示「DSH 读取到的窗口」与「用户自定值」。
        // ?models=1 时附带模型目录（按模型设上下文长度用）——放在同一个路由里，
        // 避免再注册一条 exact 路由（实测第二条路由会被宿主以 400 空响应拒绝）。
        const payload: Record<string, unknown> = { ...snapshot(), probe: await probeWindow() }
        if (wantsModels(req)) {
          const catalog = await listModelCatalog() as { providers?: unknown[]; error?: string }
          payload.providers = catalog.providers ?? []
          if (catalog.error !== undefined) payload.error = catalog.error
        }
        sendJson(res, 200, payload)
        return
      }

      if (method !== 'PUT' && method !== 'POST') {
        sendError(res, 405, 'method-not-allowed', 'only GET and PUT are supported')
        return
      }

      let body: unknown
      try {
        body = await readJsonBody(req)
      } catch (error) {
        // 读 body 失败是「请求有问题」（400），不是服务端 500。
        sendError(res, 400, 'bad-body', String((error as Error)?.message ?? error))
        return
      }
      const patch = pickEditable(body)
      const reset = pickResettable(body)
      if (Object.keys(patch).length === 0 && reset.length === 0) {
        sendError(res, 400, 'empty-patch', `body must contain at least one of: ${EDITABLE_KEYS.join(', ')} (or a "reset" array)`)
        return
      }

      let next: OrchestratorConfig
      try {
        const candidate: Record<string, unknown> = { ...config }
        const defaults = CONFIG_DEFAULTS as unknown as Record<string, unknown>
        for (const key of reset) candidate[key] = defaults[key]
        next = resolveConfig({ ...candidate, ...patch })
      } catch (error) {
        sendError(res, 400, 'invalid-config', String((error as Error)?.message ?? error))
        return
      }

      const editor = ctx.get('configEditor') as
        | {
          configuration?: () => Array<{ entry?: Record<string, unknown> }>
          edit?: (entry: Record<string, unknown>, change: (current: Record<string, unknown>, inherited: Record<string, unknown>) => Record<string, unknown>) => Promise<void>
        }
        | undefined
      if (editor === undefined || typeof editor.edit !== 'function' || typeof editor.configuration !== 'function') {
        sendError(res, 501, 'config-editor-unavailable', 'configEditor 服务不可用；请改 profile 的 cordis.patch.yml')
        return
      }

      const entry = findOwnEntry(editor.configuration())
      if (entry === undefined) {
        sendError(res, 409, 'entry-not-found', '在 profile 配置里找不到本插件的行；请改 cordis.patch.yml')
        return
      }

      await editor.edit(entry, () => ({ ...next }))
      sendJson(res, 200, { ...snapshot(), saved: true, applied: next })
    } catch (error) {
      if (res.headersSent !== true) sendError(res, 500, 'handler-failed', String((error as Error)?.message ?? error))
      else res.end()
    }
  }

  /**
   * 挂载路由。
   *
   * 关键：**必须用 `ctx.inject(['webServer'], …)` 等这个服务就绪**，不能只在 apply 那一刻
   * `ctx.get('webServer')` 取一次 —— 取不到时 apply 不报错，只是一直没有路由，表现是
   * 设置页拿到空响应（`Unexpected end of JSON input`）。dsh-context-relay 用的就是这个写法。
   */
  const attach = (target: CtxLike): void => {
    if (mounted) return
    const webServer = (target.get('webServer') ?? (target as { webServer?: unknown }).webServer) as
      | { register?: (route: unknown) => () => void }
      | undefined
    if (webServer === undefined || typeof webServer.register !== 'function') return
    try {
      const registerRoute = (): (() => void) => {
        const dispose = webServer.register?.({ kind: 'exact', path: SETTINGS_ROUTE, handler })
        mounted = true
        return () => {
          mounted = false
          try {
            dispose?.()
          } catch {
            /* ignore */
          }
        }
      }
      if (typeof target.effect === 'function') target.effect(registerRoute, 'dsh-infinite-context-orchestrator: settings route')
      else registerRoute()
    } catch {
      mounted = false
      /* 注册失败：状态工具会显示「未挂载」，插件其它功能不受影响 */
    }
  }

  const injectable = ctx as { inject?: (deps: string[], callback: (injected: CtxLike) => unknown) => unknown }
  if (typeof injectable.inject === 'function') {
    try {
      injectable.inject(['webServer'], attach)
      return
    } catch {
      /* 退回到直接取服务 */
    }
  }
  attach(ctx)
}
