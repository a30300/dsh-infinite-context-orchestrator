/**
 * 交接简报渲染。
 *
 * 简报有两条硬约束：
 *   1. 必须能被新会话**从第一个 token** 看到（由 index.ts 的 systemPrompt.section 注入）；
 *   2. 必须**不超预算**：它和 dsh-project-progress 的项目级摘要共用同一个上下文窗口，
 *      所以要按 handoffBriefMaxChars 分配，并给项目摘要留 `projectProgressReserveChars`。
 *
 * 因此这里统一走「分档降级」：先按最详细档渲染，超预算就逐档裁剪列表与字段，
 * 最后一档仍超就硬截断并写明「完整内容见检查点」——绝不静默丢内容。
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { CheckpointFacts } from './extract.js'

const FACTS_HEADER = '## 项目档案'
const TIMELINE_HEADER = '## 进展时间线'

interface RenderLevel {
  items: number
  field: number
  request: number
}

const LEVELS: RenderLevel[] = [
  { items: 10, field: 200, request: 600 },
  { items: 7, field: 160, request: 400 },
  { items: 5, field: 120, request: 300 },
  { items: 3, field: 90, request: 200 },
  { items: 1, field: 70, request: 120 },
]

function clip(text: string, max: number): string {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  return `${flat.slice(0, Math.max(0, max - 1))}…`
}

function bullet(items: string[], level: RenderLevel, emptyText: string): string {
  if (items.length === 0) return `- ${emptyText}`
  const shown = items.slice(0, level.items).map((item) => `- ${clip(item, level.field)}`)
  if (items.length > level.items) shown.push(`- …（另有 ${items.length - level.items} 项，见检查点文件）`)
  return shown.join('\n')
}

/**
 * 读 dsh-project-progress 的 PROGRESS.md，取「项目档案 + 时间线尾部」。
 * 该文件由 dsh-project-progress 维护；这里只读，不写（避免两个插件争同一份文件）。
 */
export function readProjectProgressSummary(cwd: string | undefined, maxChars: number): string {
  if (typeof cwd !== 'string' || cwd.length === 0 || maxChars <= 0) return ''
  const file = path.join(cwd, 'PROGRESS.md')
  if (!existsSync(file)) return ''
  let text: string
  try {
    text = readFileSync(file, 'utf-8')
  } catch {
    return ''
  }
  const factsIndex = text.indexOf(FACTS_HEADER)
  const timelineIndex = text.indexOf(TIMELINE_HEADER)
  const facts = factsIndex >= 0
    ? text.slice(factsIndex + FACTS_HEADER.length, timelineIndex > factsIndex ? timelineIndex : undefined).trim()
    : text.trim()
  const timeline = timelineIndex >= 0 ? text.slice(timelineIndex + TIMELINE_HEADER.length).trim() : ''

  // 项目档案优先（稳定事实），时间线只取尾部（最近进展）。
  const factsPart = facts.length > 0 ? `${FACTS_HEADER}\n${clip(facts, Math.floor(maxChars * 0.45))}` : ''
  const remaining = Math.max(0, maxChars - factsPart.length - TIMELINE_HEADER.length - 4)
  const timelinePart = timeline.length > 0 && remaining > 40
    ? `${TIMELINE_HEADER}（最近）\n…${clip(timeline.slice(Math.max(0, timeline.length - remaining)), remaining)}`
    : ''
  return [factsPart, timelinePart].filter((part) => part.length > 0).join('\n\n')
}

export interface BriefResult {
  text: string
  chars: number
  hasProjectSummary: boolean
  truncated: boolean
}

export interface BriefOptions {
  maxChars: number
  projectProgressReserveChars: number
  cwd?: string
  /** 可选的占用说明行（放在标题下方，便于新会话知道为什么换窗）。 */
  occupancyLine?: string
}

/** 「不限制」时用的档位：条数与单字段长度都不裁剪。 */
const UNLIMITED_LEVEL: RenderLevel = { items: Number.POSITIVE_INFINITY, field: Number.POSITIVE_INFINITY, request: Number.POSITIVE_INFINITY }

/** 「不限制」时项目摘要的安全上限：不裁剪，但也不至于把整份 PROGRESS.md 塞进窗口。 */
const UNLIMITED_PROJECT_CHARS = 20000

/** 模型可能自作主张重写这些「锚点」小节；它们由插件拼，避免与机器生成的内容打架。 */
const ANCHOR_HEADING = /^\s*\*\*(待办|检查点文件|相关工作区文件)\*\*/

/** 去掉模型输出里与锚点重复的小节（从该标题到下一个标题之前）。 */
function stripAnchorSections(text: string): string {
  const out: string[] = []
  let skipping = false
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const isHeading = /^\s*\*\*[^*]+\*\*/.test(line)
    if (isHeading && ANCHOR_HEADING.test(line)) {
      skipping = true
      continue
    }
    if (isHeading && skipping) skipping = false
    if (!skipping) out.push(line)
  }
  return out.join('\n').trim()
}

/**
 * 把**模型撰写**的小节拼成最终简报（`briefAuthor: 'model'`）。
 *
 * 分工：模型写叙述（目标/已完成/关键决策/接下来该做什么），插件保留
 * `待办 / 检查点文件 / 收尾指令` 三个锚点 —— 新窗口依赖它们才能「从第一项继续」，
 * 不能因为模型跑题就丢掉。预算不够时只压缩模型的叙述部分。
 */
/**
 * 「原始需求」固定段落。
 * 为什么由插件生成：模型撰写简报时很容易只写"进度"，把需求漏掉；
 * 原样贴出来才能让第 N 个窗口知道**原始目标**是什么。
 */
function originalRequestSection(facts: CheckpointFacts, limit: number): string[] {
  const text = String(facts.original_request ?? '').trim()
  if (text.length === 0) return []
  const clipped = limit > 0 && text.length > limit
    ? `${text.slice(0, limit)}\n…（原文共 ${text.length} 字符，已按预算截断）`
    : text
  return [
    '## 原始需求',
    '（以下为最初的需求原文，供核对；后续对话可能修改或新增需求，以较新的为准。）',
    clipped,
    '',
  ]
}

export function renderModelAuthoredBrief(
  modelText: string,
  facts: CheckpointFacts,
  checkpointPath: string,
  options: BriefOptions,
): BriefResult {
  const unlimited = options.maxChars <= 0
  const budget = Math.max(1, options.maxChars)
  const header: string[] = [
    '## 任务交接简报',
    '你正在接手一个因上下文接近临界点而换窗的任务。',
  ]
  if (typeof options.occupancyLine === 'string' && options.occupancyLine.length > 0) {
    header.push(`（换窗时上下文占用：${options.occupancyLine}）`)
  }
  const level: RenderLevel = { items: 12, field: 200, request: 600 }
  const anchors: string[] = [
    '**待办**：',
    bullet(facts.pending_todos, level, '（本窗口没有留下待办：按「已完成」的进度与「原始需求」推断下一项，直接继续做；不要因为待办为空就停下来问用户）'),
    '**检查点文件**：' + checkpointPath,
    '',
    '请从“待办”的第一项继续；待办为空时按「已完成」与「原始需求」继续推进，不要停下来等用户确认。不要重新开始已完成的工作。',
  ]
  const fixed = [...header, ...anchors].join('\n')
  const body = stripAnchorSections(modelText)

  if (body.length === 0) {
    return { text: fixed, chars: fixed.length, hasProjectSummary: false, truncated: true }
  }
  if (unlimited) {
    const appendix = originalRequestSection(facts, 0)
    const text = [...header, body, '', ...anchors, ...(appendix.length > 0 ? ['', ...appendix] : [])].join('\n')
    return { text, chars: text.length, hasProjectSummary: false, truncated: false }
  }
  const room = budget - fixed.length - 8
  if (room <= 40) {
    return { text: fixed, chars: fixed.length, hasProjectSummary: false, truncated: true }
  }
  const clippedBody = body.length <= room
    ? body
    : `${body.slice(0, Math.max(0, room - 24))}\n…（模型小节已按预算截断，完整内容见检查点）`
  const text = [...header, clippedBody, '', ...anchors].join('\n')
  return { text, chars: text.length, hasProjectSummary: false, truncated: clippedBody !== body }
}

/**
 * 渲染交接简报（格式与需求一致，逐档降级到预算内）。
 *
 * 两种「不限制」（设置页的勾选框写入的哨兵值）：
 *   - `maxChars <= 0`         → 简报**不裁剪**：按最详细档渲染，不做长度检查。
 *   - `reserveChars < 0`      → 项目摘要**不裁剪**，且**不占用**简报的字数预算
 *                               （此时只量简报正文，项目摘要额外挂上）。
 */
export function renderHandoffBrief(
  facts: CheckpointFacts,
  checkpointPath: string,
  options: BriefOptions,
): BriefResult {
  const unlimitedBrief = options.maxChars <= 0
  const unlimitedProject = options.projectProgressReserveChars < 0
  const budget = Math.max(1, options.maxChars)
  const cap25 = Math.floor(budget * 0.25)
  // 项目摘要的字符上限：不限制时用安全上限；否则按 reserve 且不超过总预算的 1/4。
  const projectLimit = unlimitedProject
    ? UNLIMITED_PROJECT_CHARS
    : Math.max(0, Math.min(options.projectProgressReserveChars, cap25))

  const build = (level: RenderLevel, projectText: string): string => {
    const lines: string[] = [
      '## 任务交接简报',
      '你正在接手一个因上下文接近临界点而换窗的任务。',
    ]
    if (typeof options.occupancyLine === 'string' && options.occupancyLine.length > 0) {
      lines.push(`（换窗时上下文占用：${options.occupancyLine}）`)
    }
    // 原始需求：固定段落，逐字保留（后续窗口据此核对是否偏离目标）。
    lines.push(...originalRequestSection(facts, unlimitedBrief ? 0 : Math.floor(budget * 0.5)))
    lines.push(
      '**当前目标**：' + (facts.goal.length > 0 ? clip(facts.goal, level.field * 2) : '（未记录，请先向用户确认目标）'),
      '**已完成**：',
      bullet(facts.done, level, '（无记录）'),
      '**待办**：',
      bullet(facts.pending_todos, level, '（本窗口没有留下待办：按「已完成」的进度与「原始需求」推断下一项，直接继续做；不要因为待办为空就停下来问用户）'),
      '**关键决策/约束**：',
      bullet(facts.key_decisions, level, '（无记录）'),
      '**最后一条人类请求**：' + (facts.last_human_request.length > 0 ? clip(facts.last_human_request, level.request) : '（未记录）'),
      '**检查点文件**：' + checkpointPath,
    )
    if (facts.notes.length > 0) {
      lines.push('**相关工作区文件**：', bullet(facts.notes, level, ''))
    }
    if (projectText.length > 0) {
      lines.push('', '## 项目级摘要（来自 dsh-project-progress 的 PROGRESS.md）', projectText)
    }
    lines.push('', '请从“待办”的第一项继续。不要重新开始已完成的工作。')
    return lines.join('\n')
  }

  // 简报不限制：所有条目、所有字段都完整带上（不做条数裁剪，也不做长度检查）。
  if (unlimitedBrief) {
    const projectText = readProjectProgressSummary(options.cwd, projectLimit)
    const text = build(UNLIMITED_LEVEL, projectText)
    return { text, chars: text.length, hasProjectSummary: projectText.length > 0, truncated: false }
  }

  for (const level of LEVELS) {
    const isCoarsest = level === LEVELS[LEVELS.length - 1]
    // 最粗一档不要项目摘要，保证任务级简报优先。
    const projectText = isCoarsest ? '' : readProjectProgressSummary(options.cwd, projectLimit)
    const bodyText = build(level, '')
    const text = projectText.length > 0 ? build(level, projectText) : bodyText
    // 项目摘要「不限制」时不占预算：只量正文字数；否则量整份（含摘要，保持原有严格语义）。
    const measured = unlimitedProject ? bodyText.length : text.length
    if (measured <= options.maxChars) {
      return {
        text,
        chars: text.length,
        hasProjectSummary: projectText.length > 0,
        truncated: level !== LEVELS[0],
      }
    }
  }

  // 兜底：硬截断，但保留「完整内容在检查点」这一句，避免新会话以为简报就是全部。
  const tail = `\n\n…（简报已按 handoffBriefMaxChars=${options.maxChars} 截断；完整内容请读检查点文件：${checkpointPath}）\n请从“待办”的第一项继续。不要重新开始已完成的工作。`
  const head = build(LEVELS[LEVELS.length - 1], '').slice(0, Math.max(0, options.maxChars - tail.length))
  const text = `${head}${tail}`
  return { text, chars: text.length, hasProjectSummary: false, truncated: true }
}
