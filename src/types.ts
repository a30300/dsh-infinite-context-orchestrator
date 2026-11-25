/**
 * 本插件只依赖 DSH 运行时，不 import 任何 `@deepseek-ai/*` 类型包
 * （profile 里解析不到它们；见 scripts/build.mjs 的说明）。
 * 因此这里用最小结构化类型描述我们真正用到的运行时形状，
 * 全部字段可缺省，运行期一律配合可选链与 try/catch 使用。
 */

/** 消息里的文本块（其余块类型我们不读：推理文本必须被排除）。 */
export interface TextBlock {
  type: 'text'
  text: string
}

export interface MessageLike {
  role?: string
  id?: string
  content?: Array<TextBlock | { type: string; [key: string]: unknown }>
  source?: { kind?: string; form?: string; summary?: string; [key: string]: unknown }
}

export interface SessionEventLike {
  type?: string
  seq?: number
  time?: number
  data?: unknown
}

export interface RequestHeaderLike {
  config?: { provider?: string; model?: string; reasoningEffort?: string }
  adapterDefaults?: Record<string, unknown>
}

export interface SessionLike {
  id: string
  seq?: number
  header?: {
    id?: string
    cwd?: string
    agentPreset?: string
    parentSession?: string
    origin?: string
    delegationDepth?: number
    /** DSH 的 SessionHeader 版本号；只做存在性检查，不解析。 */
    version?: unknown
  }
  snapshotEvents?: () => SessionEventLike[]
  requestHeader?: () => RequestHeaderLike | undefined
}

export interface AgentLike {
  session?: SessionLike
  options?: Record<string, unknown>
  /** 把消息塞进 inbox（relay 的 notice 就是这么发的）。 */
  inject?: (message: unknown) => unknown
  /** 触发一轮新请求（relay_handoff 用它把首条消息发给新会话）。 */
  followup?: (message: unknown) => unknown
  dispose?: () => unknown
}

export interface ProjectionsLike {
  stateOf?: (session: SessionLike, key: string) => unknown
  snapshot?: (session: SessionLike, keys?: readonly string[]) => unknown
}

export interface TokenMeterLike {
  measure?: (session: SessionLike, requestHeader?: unknown) => { totalTokens?: number } | undefined
}

export interface LlmLike {
  resolveModelInfo?: (provider: string, model: string) => Promise<{ context?: { contextWindow?: number } } | undefined>
}

export interface SessionControllerLike {
  create?: (request: { cwd?: string; sessionId?: string; workspaceId?: string; agentPreset?: string })
    => Promise<{ sessionId?: string; agentPreset?: string }>
  cancel?: (request: { sessionId: string }) => unknown
}

export interface AgentsLike {
  list?: () => AgentLike[]
  get?: (id: string) => AgentLike | undefined
}

export interface PromptSectionContext {
  agent?: AgentLike
  session?: SessionLike
  [key: string]: unknown
}

export interface SystemPromptLike {
  section: (section: {
    name: string
    order?: number
    text: (context: PromptSectionContext) => string
  }) => () => void
}

export interface ToolsLike {
  register: (definition: unknown) => () => void
  get?: (name: string) => unknown
}

/** 我们真正使用的 Cordis Context 子集。 */
export interface CtxLike {
  get: (name: string) => unknown
  /** Cordis 事件：普通事件 handler(payload)，waterfall 事件 handler(payload, next)。 */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on: (name: string, handler: (...args: any[]) => unknown) => unknown
  effect?: (factory: () => unknown, label?: string) => unknown
  /** Cordis 的服务等待：服务就绪（或重载）时调用回调，回调收到同一个 ctx。 */
  inject?: (deps: string[], callback: (injected: CtxLike) => unknown) => unknown
  tools?: ToolsLike
  systemPrompt?: SystemPromptLike
}

/** 工具执行时 DSH 传进来的第二个参数。 */
export interface ToolExecLike {
  agent?: AgentLike
  session?: SessionLike
  [key: string]: unknown
}

export interface ToolTextOutput {
  type: 'text'
  text: string
}

/** `defineTool` 的入参形状（与 @deepseek-ai/dsh-tools 的 ToolDefinition 对齐）。 */
export interface ToolDefinitionShape<A = unknown, R = unknown> {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: {
    schema: Record<string, unknown>
    render: (args: A, value: R) => ToolTextOutput[]
  }
  execute: (args: A, exec: ToolExecLike) => Promise<R>
}
