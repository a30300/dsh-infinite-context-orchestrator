/**
 * 让**模型**来写交接简报（`briefAuthor: 'model'` 时才走这条路）。
 *
 * 设计要点：
 * 1. **只调用一次** `llm.stream()`，不是子智能体、不建会话、不进对话历史。
 *    失败/超时/内容过短一律返回 `ok:false`，由上层回退到确定性模板（绝不阻断换窗）。
 * 2. **素材由插件给**：结构化事实（目标/待办/已完成/用户约束/最后一条人类请求）
 *    + 最近对话的文本摘要（只收 text 块与工具名，不收工具结果、不收推理）。
 * 3. **输出过一遍脱敏**：模型可能复述素材里的密钥；这份文本要进新窗口的系统提示。
 * 4. 模型只写"叙述性小节"，`待办 / 检查点路径 / 收尾指令` 仍由插件拼（见 brief.ts），
 *    保证新窗口永远拿得到可执行的下一步，不会因为模型跑题而失去锚点。
 */
import { redactText } from './redact.js'
import type { CheckpointFacts } from './extract.js'
import type { AgentLike, CtxLike, MessageLike, SessionEventLike } from './types.js'

/** 模型返回内容的最低可接受长度（更短就认为没写成功，回退模板）。 */
const MIN_ACCEPT_CHARS = 40
/** 送给模型的对话素材上限（字符）。 */
const MAX_MATERIAL_CHARS = 24000
/** 单次调用允许生成的最大 token（按简报预算推，夹在 800–4000）。 */
const MIN_MAX_TOKENS = 800
const MAX_MAX_TOKENS = 4000

const SYSTEM_PROMPT = [
  '你正在为"上下文换窗"写一份交接简报，读者是接手这个任务的另一个模型。',
  '它看不到当前对话，只有你写的这份简报，以及一份结构化检查点文件。',
  '',
  '请按下面的小节输出，不要输出其它内容，不要写寒暄：',
  '**需求**：简要概括这个项目要做什么（可参考素材里的原始需求；若后续对话修改或新增了需求，以较新的为准，并注明与原始需求的差异）。',
  '**当前目标**：说明当前这一轮要达成的目标。',
  '**已完成**：逐条列出已完成的工作与结论，写清做了什么、结果是什么。',
  '**关键决策/约束**：逐条列出为什么这样做、哪些不能动。',
  '**接下来该做什么**：按顺序列出下一步的具体动作。',
  '',
  '规则：',
  '- 只写素材里出现过的事实；没有依据的内容不要编造，宁可写"未记录"。',
  '- 不要复述密钥、口令、完整文件内容；路径和命令名可以写。',
  '- 用中文，祈使句/陈述句，不要用"我们""我想"这类主观口吻。',
].join('\n')

export interface ModelBriefRequest {
  facts: CheckpointFacts
  checkpointPath: string
  occupancyLine?: string
  /** 简报字符上限（0 = 不限制）；用来推导 maxTokens 与素材长度。 */
  maxChars: number
  signal?: AbortSignal
}

export interface ModelBriefResult {
  ok: boolean
  text?: string
  reason?: string
}

function clip(text: string, max: number): string {
  const flat = String(text ?? '')
  return flat.length <= max ? flat : `${flat.slice(0, Math.max(0, max - 1))}…`
}

function messageText(message: MessageLike | undefined): string {
  const blocks = message?.content
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter((block) => (block as { type?: string })?.type === 'text' && typeof (block as { text?: string }).text === 'string')
    .map((block) => String((block as { text: string }).text))
    .join('\n')
    .trim()
}

/** 会话的 provider/model：请求头优先，回退部署默认模型。 */
function resolveRoute(ctx: CtxLike, agent: AgentLike): { provider: string; model: string } | undefined {
  try {
    const header = typeof agent?.session?.requestHeader === 'function' ? agent.session.requestHeader() : undefined
    const provider = header?.config?.provider
    const model = header?.config?.model
    if (typeof provider === 'string' && typeof model === 'string' && provider.length > 0 && model.length > 0) {
      return { provider, model }
    }
  } catch {
    /* 落回默认模型 */
  }
  try {
    const selection = (ctx.get('agentDefaultModel') as { currentSelection?: () => { provider?: string; model?: string } } | undefined)
      ?.currentSelection?.()
    if (typeof selection?.provider === 'string' && typeof selection?.model === 'string') {
      return { provider: selection.provider, model: selection.model }
    }
  } catch {
    /* ignore */
  }
  return undefined
}

/** 组装送给模型的素材：结构化事实 + 最近对话的文本摘要。 */
function buildMaterial(agent: AgentLike, request: ModelBriefRequest): string {
  const facts = request.facts
  const list = (items: string[], empty: string): string => (items.length === 0 ? empty : items.map((item) => `- ${item}`).join('\n'))
  const lines: string[] = [
    '# 结构化事实（来自程序，可信）',
    `目标：${facts.goal.length > 0 ? facts.goal : '（未记录）'}`,
    '未完成的待办（若为空：请按已完成进度与原始需求推断下一步，不要建议停下来问用户）：',
    list(facts.pending_todos, '（无记录）'),
    '已完成：',
    list(facts.done, '（无记录）'),
    '用户明确提出的约束：',
    list(facts.key_decisions, '（无记录）'),
    `最后一条人类请求：${facts.last_human_request.length > 0 ? facts.last_human_request : '（未记录）'}`,
    ...(request.occupancyLine === undefined ? [] : [`换窗时上下文占用：${request.occupancyLine}`]),
    `检查点文件：${request.checkpointPath}`,
    '',
    ...(facts.original_request.trim().length === 0
      ? []
      : ['', '# 原始需求（素材：最初的需求原文，供你总结；后续可能已变更）', facts.original_request]),
    '',
    '# 最近的对话（只含文本消息与工具名）',
  ]

  let events: SessionEventLike[] = []
  try {
    const raw = typeof agent?.session?.snapshotEvents === 'function' ? agent.session.snapshotEvents() : []
    events = Array.isArray(raw) ? raw : []
  } catch {
    events = []
  }

  const transcript: string[] = []
  // 从后往前取，保证「最近的」优先，最后再反转回时间顺序。
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'user/message') {
      const message = event.data as MessageLike | undefined
      const text = messageText(message)
      if (text.length === 0) continue
      const tag = message?.source?.kind === 'user' ? 'user' : 'plugin-notice'
      transcript.unshift(`[${tag}] ${clip(text, 600)}`)
    } else if (event?.type === 'assistant/message') {
      const payload = event.data as { message?: MessageLike } | undefined
      const text = messageText(payload?.message)
      if (text.length === 0) continue
      transcript.unshift(`[assistant] ${clip(text, 800)}`)
    } else if (event?.type === 'tool/call') {
      const payload = event.data as { name?: string } | undefined
      const name = typeof payload?.name === 'string' ? payload.name : 'tool'
      transcript.unshift(`[tool] ${name}`)
    }
    if (transcript.join('\n').length > MAX_MATERIAL_CHARS) break
  }

  const budget = MAX_MATERIAL_CHARS - lines.join('\n').length
  const tail = transcript.join('\n')
  lines.push(tail.length === 0 ? '（无）' : clip(tail.slice(Math.max(0, tail.length - Math.max(0, budget))), Math.max(0, budget)))
  return clip(lines.join('\n'), MAX_MATERIAL_CHARS)
}

/**
 * 请求模型写一份简报。任何失败都返回 `{ ok: false, reason }`，
 * 调用方必须回退到模板渲染（fail-open 到确定性内容，而不是阻断换窗）。
 */
export async function requestModelBrief(
  ctx: CtxLike,
  agent: AgentLike,
  request: ModelBriefRequest,
): Promise<ModelBriefResult> {
  const llm = ctx.get('llm') as
    | { stream?: (options: unknown) => AsyncIterable<{ type?: string; text?: string; reason?: { kind?: string; failure?: { code?: string } } }> }
    | undefined
  if (llm === undefined || typeof llm.stream !== 'function') return { ok: false, reason: 'llm 服务不可用' }

  const route = resolveRoute(ctx, agent)
  if (route === undefined) return { ok: false, reason: '拿不到会话的 provider/model' }

  const budgetChars = request.maxChars > 0 ? request.maxChars : MAX_MAX_TOKENS * 2
  const maxTokens = Math.max(MIN_MAX_TOKENS, Math.min(MAX_MAX_TOKENS, Math.ceil(budgetChars / 2)))

  try {
    const stream = llm.stream({
      provider: route.provider,
      model: route.model,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: [{ type: 'text', text: buildMaterial(agent, request) }] }],
      maxTokens,
      temperature: 0.2,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    })

    let text = ''
    const hardCap = Math.max(budgetChars * 2, 2000)
    for await (const chunk of stream) {
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') {
        text += chunk.text
        if (text.length > hardCap) break
      }
      if (chunk?.type === 'finish') {
        const kind = chunk.reason?.kind
        if (kind === 'error' || kind === 'aborted') {
          return { ok: false, reason: `模型调用失败（${chunk.reason?.failure?.code ?? kind}）` }
        }
      }
    }

    const cleaned = redactText(text.trim()).trim()
    if (cleaned.length < MIN_ACCEPT_CHARS) return { ok: false, reason: '模型返回内容过短' }
    return { ok: true, text: clip(cleaned, hardCap) }
  } catch (error) {
    return { ok: false, reason: String((error as Error)?.message ?? error).slice(0, 200) }
  }
}
