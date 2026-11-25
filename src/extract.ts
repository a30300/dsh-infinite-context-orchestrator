/**
 * 从**当前会话日志**里抽取交接所需的事实。
 *
 * 数据源优先级：
 *   goal / todos  → DSH 投影（`dsh-goal`、`dsh-tool-todo` 注册的 state key 才是真源）；
 *   最后一条人类请求 → 会话事件流里 `source.kind === 'user'` 的最后一条 user/message；
 *   关键决策/约束 → 用户消息里「像约束」的语句（**只读 text 块**）；
 *   done         → 已完成 todo；没有 todo 时退回最近几条助手结论（明确标注「自动摘录」）。
 *
 * 为什么只读 text 块：需求要求「排除推理文本」。assistant/message 的 `stream` 里
 * 混着 reasoning-chunks，一律不读，只读 message.content 中 type==='text' 的块。
 */
import { existsSync } from 'node:fs'
import path from 'node:path'
import type { AgentLike, CtxLike, MessageLike, SessionEventLike, SessionLike, TextBlock } from './types.js'

export interface CheckpointFacts {
  goal: string
  done: string[]
  pending_todos: string[]
  key_decisions: string[]
  last_human_request: string
  /** 项目的**原始需求原文**（链上继承；空 = 没采集到）。 */
  original_request: string
  /** 原始需求来自哪个会话（便于追溯）。 */
  original_request_source: string
  notes: string[]
  /**
   * 原始待办列表（含状态，供"交接后把旧窗口的待办标成已完成"用）。
   * 不进检查点文档、不进简报；只在本进程内使用。
   */
  allTodos: TodoItem[]
}

const SCAN_LIMIT = 800
const MAX_ITEM = 200
const MAX_LAST_REQUEST = 600

const CONSTRAINT_PATTERN = /(必须|不要|禁止|务必|一律|只能|不能|不得|至少|最多|记住|约定|约束|must\b|never\b|always\b|do not\b|don't\b|avoid\b|require)/i

function clip(text: string, max: number): string {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, Math.max(0, max - 1))}…`
}

/** 取消息里的文本块；推理块/工具块一律忽略。 */
export function messageText(message: MessageLike | undefined): string {
  const blocks = message?.content
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter((block): block is TextBlock => (block as TextBlock)?.type === 'text' && typeof (block as TextBlock).text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

function readEvents(session: SessionLike | undefined): SessionEventLike[] {
  try {
    const events = typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : []
    if (!Array.isArray(events)) return []
    return events.length > SCAN_LIMIT ? events.slice(events.length - SCAN_LIMIT) : events
  } catch {
    return []
  }
}

function stateOf(ctx: CtxLike, session: SessionLike | undefined, key: string): unknown {
  try {
    const projections = ctx.get('sessionProjections') as { stateOf?: (s: SessionLike, k: string) => unknown } | undefined
    if (session === undefined) return undefined
    return projections?.stateOf?.(session, key)
  } catch {
    return undefined
  }
}

/** goal 投影的可能形状：`{goal:{objective}}` / `{objective}` / `{title}` / 字符串。 */
function normalizeGoal(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (value === null || typeof value !== 'object') return ''
  const record = value as Record<string, unknown>
  const nested = record.goal as Record<string, unknown> | undefined
  for (const candidate of [
    record.objective,
    nested?.objective,
    record.title,
    nested?.title,
    record.text,
    nested?.text,
  ]) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) return candidate.trim()
  }
  return ''
}

export interface TodoItem {
  text: string
  status: string
}

/** todos 投影的可能形状：`{todos:[...]}` / `{items:[...]}` / 数组本身。 */
function normalizeTodos(value: unknown): TodoItem[] {
  const list: unknown[] = Array.isArray(value)
    ? value
    : Array.isArray((value as { todos?: unknown[] } | undefined)?.todos)
      ? (value as { todos: unknown[] }).todos
      : Array.isArray((value as { items?: unknown[] } | undefined)?.items)
        ? (value as { items: unknown[] }).items
        : []
  const out: TodoItem[] = []
  for (const raw of list) {
    if (raw === null || typeof raw !== 'object') continue
    const record = raw as Record<string, unknown>
    const text = [record.content, record.title, record.text, record.subject]
      .find((candidate): candidate is string => typeof candidate === 'string' && candidate.trim().length > 0)
    if (text === undefined) continue
    const status = typeof record.status === 'string' ? record.status.toLowerCase() : 'pending'
    out.push({ text: text.trim(), status })
  }
  return out
}

function isCompleted(status: string): boolean {
  return ['completed', 'complete', 'done', 'finished', 'cancelled', 'canceled'].includes(status)
}

function isActive(status: string): boolean {
  return ['pending', 'in_progress', 'active', 'todo', 'open', 'blocked'].includes(status)
}

/** 最后一条「人类」发言（跳过插件 notice / 工具回执）。 */
/**
 * 原始需求 = 会话里**第一条足够长的用户消息**。
 *
 * 为什么不是"最后一条"：交接出来的窗口里最后一条人类消息常常是「继续」「接着做」，
 * 拿它当需求会让后续窗口完全失去方向（实测过）。
 * 阈值 200 字符：跳过「继续」「好的」这类短指令，但保留真实需求的开头。
 */
function originalRequest(events: SessionEventLike[]): { text: string; source: string } {
  const candidates: Array<{ text: string; source: string }> = []
  for (const event of events) {
    if (event?.type !== 'user/message') continue
    // 注意：user/message 的 data 本身就是 MessageLike（content/source 直接挂在 data 上），
    // 不是 { message: ... } 包一层。
    const message = event.data as MessageLike | undefined
    if (message?.source?.kind !== 'user') continue
    const text = messageText(message).trim()
    if (text.length === 0) continue
    candidates.push({ text, source: String((event as { sessionId?: string }).sessionId ?? '') })
  }
  const long = candidates.find((item) => item.text.length >= 200)
  return long ?? candidates[0] ?? { text: '', source: '' }
}

function lastHumanRequest(events: SessionEventLike[]): string {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'user/message') continue
    const message = event.data as MessageLike | undefined
    if (message?.source?.kind !== 'user') continue
    const text = messageText(message)
    if (text.length > 0) return clip(text, MAX_LAST_REQUEST)
  }
  return ''
}

/** 用户消息里带约束意味的语句（按时间顺序、去重、最多 4 条）。 */
function constraintStatements(events: SessionEventLike[]): string[] {
  const found: string[] = []
  const seen = new Set<string>()
  for (let index = events.length - 1; index >= 0 && found.length < 4; index -= 1) {
    const event = events[index]
    if (event?.type !== 'user/message') continue
    const message = event.data as MessageLike | undefined
    if (message?.source?.kind !== 'user') continue
    const text = messageText(message)
    if (text.length === 0 || !CONSTRAINT_PATTERN.test(text)) continue
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.replace(/^[-*\d.\s]+/, '').trim()
      if (trimmed.length < 6 || !CONSTRAINT_PATTERN.test(trimmed)) continue
      const item = clip(trimmed, MAX_ITEM)
      if (seen.has(item)) continue
      seen.add(item)
      found.unshift(`（用户约束）${item}`)
      if (found.length >= 4) break
    }
  }
  return found
}

/** 最近几条助手结论（无 todo 时的 done 兜底）。 */
function recentAssistantConclusions(events: SessionEventLike[], limit = 3): string[] {
  const out: string[] = []
  for (let index = events.length - 1; index >= 0 && out.length < limit; index -= 1) {
    const event = events[index]
    if (event?.type !== 'assistant/message') continue
    const payload = event.data as { message?: MessageLike } | undefined
    const text = messageText(payload?.message)
    if (text.length === 0) continue
    out.unshift(`（自动摘录，未经确认）${clip(text.split(/\r?\n/)[0] ?? text, MAX_ITEM)}`)
  }
  return out
}

function workspacePointers(cwd: string | undefined): string[] {
  if (typeof cwd !== 'string' || cwd.length === 0) return []
  const notes: string[] = []
  const candidates: Array<[string, string]> = [
    ['PROGRESS.md（dsh-project-progress 项目进展）', path.join(cwd, 'PROGRESS.md')],
    ['context-relay 滚动进度', path.join(cwd, '.scratch', 'context-relay', 'progress.md')],
    ['context-relay 召回索引', path.join(cwd, '.scratch', 'context-relay', 'chain.ndjson')],
  ]
  for (const [label, file] of candidates) {
    try {
      if (existsSync(file)) notes.push(`${label}：${file}`)
    } catch {
      /* ignore */
    }
  }
  return notes
}

export function cwdOf(agent: AgentLike | undefined): string | undefined {
  const cwd = agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined
}

/** 采集交接事实。任何一步失败都降级为「该字段为空」，不抛（写入检查点时才有硬失败）。 */
export function collectFacts(ctx: CtxLike, agent: AgentLike): CheckpointFacts {
  const session = agent?.session
  const events = readEvents(session)

  const goalFromProjection = normalizeGoal(stateOf(ctx, session, 'goal'))
  const goal = goalFromProjection.length > 0
    ? clip(goalFromProjection, MAX_ITEM * 2)
    : clip(lastHumanRequest(events), MAX_ITEM * 2)

  const todos = normalizeTodos(stateOf(ctx, session, 'todos'))
  const done = todos.filter((item) => isCompleted(item.status)).map((item) => clip(item.text, MAX_ITEM))
  const pending = todos.filter((item) => isActive(item.status)).map((item) => clip(item.text, MAX_ITEM))

  const keyDecisions = constraintStatements(events)

  return {
    goal,
    done: done.length > 0 ? done : recentAssistantConclusions(events),
    pending_todos: pending,
    key_decisions: keyDecisions,
    last_human_request: lastHumanRequest(events),
    original_request: originalRequest(events).text,
    original_request_source: originalRequest(events).source,
    notes: workspacePointers(cwdOf(agent)),
    allTodos: todos,
  }
}
