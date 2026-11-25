/**
 * 交接检查点持久化。
 *
 * 与 dsh-task-checkpoint-guard 的持久化契约保持一致（它就是这套做法的参考实现）：
 *   - 同目录唯一临时文件 → write → fsync → rename 就位（原子替换）；
 *   - 保留上一版 `<target>.previous`，读取失败时可回退；
 *   - 进程内按目标路径串行化写入，避免自我竞争；
 *   - 目录根默认与 guard 同根（`${DSH_HOME}/task-checkpoints`），
 *     本插件只占用其下的 `orchestrator/` 子目录，互不覆盖。
 *
 * 与 guard 的差异：guard 按 taskId 组织 `tasks/*.json` + `sessions/*.json` 指针；
 * 本插件一次交接就是一份自包含文档，所以用 `handoffs/<时间戳>-<会话>.json`
 * 加一份 `latest.json` 指针，语义更直接，也不会和 guard 的文件名打架。
 *
 * 为什么不 import guard：它的 package.json 只导出 `.`，不导出 storage 子路径；
 * 而 profile 里也解析不到 `@deepseek-ai/*`。所以这里复刻同一份算法契约，
 * 而不是硬链接它的内部模块（README「依赖关系」一节有说明）。
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

/** 检查点文档（字段名与需求一致：goal/done/pending_todos/key_decisions/last_human_request/checkpoint_path）。 */
export interface HandoffCheckpoint {
  version: number
  plugin: string
  createdAt: string
  sessionId: string
  parentSession?: string
  agentPreset?: string
  cwd?: string
  goal: string
  done: string[]
  pending_todos: string[]
  key_decisions: string[]
  last_human_request: string
  checkpoint_path: string
  occupancy?: {
    usedTokens?: number
    windowTokens?: number
    percent?: number
    thresholdPercent: number
    source: string
  }
  nextSessionId?: string
  notes?: string[]
}

export interface LatestPointer {
  checkpointPath: string
  sessionId: string
  nextSessionId?: string
  createdAt: string
  briefChars?: number
}

const KEEP_CHECKPOINTS = 50
const locks = new Map<string, Promise<unknown>>()

/** 串行化同一目标的写入（多进程场景不在支持范围，见 README「边界」）。 */
async function withLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const prior = locks.get(key) ?? Promise.resolve()
  const run = prior.catch(() => undefined).then(task)
  locks.set(key, run)
  try {
    return await run
  } finally {
    if (locks.get(key) === run) locks.delete(key)
  }
}

/** `${DSH_HOME:-~/.dsh}/task-checkpoints/orchestrator`（或配置里的绝对路径）。 */
export function resolveCheckpointRoot(configured: string | undefined): string {
  if (typeof configured === 'string' && configured.trim().length > 0) {
    const raw = configured.trim()
    const expanded = raw.startsWith('~/') || raw.startsWith('~\\')
      ? path.join(homedir(), raw.slice(2))
      : raw
    return path.resolve(expanded)
  }
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim().length > 0
    ? path.resolve(process.env.DSH_HOME.trim())
    : path.join(homedir(), '.dsh')
  return path.join(home, 'task-checkpoints', 'orchestrator')
}

function sanitizeFilePart(value: string): string {
  return String(value).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80)
}

async function writeTempFile(directory: string, text: string): Promise<string> {
  const temporary = path.join(directory, `.tmp-${process.pid}-${randomUUID()}`)
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(temporary, 'wx', 0o600)
    await handle.writeFile(text, 'utf8')
    await handle.sync()
    return temporary
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function fsyncDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(directory, 'r')
    await handle.sync()
  } catch (error) {
    // Windows 不允许对目录句柄 fsync：这些 errno 属于预期，不视为失败。
    const code = (error as { code?: string })?.code
    if (code !== undefined && !['EINVAL', 'EISDIR', 'EPERM', 'EACCES', 'EBADF', 'ENOENT'].includes(code)) throw error
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

/** Windows 不允许 rename 覆盖已存在文件时的兜底：先挪走旧的，再就位。 */
async function replaceFile(source: string, destination: string): Promise<void> {
  try {
    await rename(source, destination)
    return
  } catch (error) {
    const code = (error as { code?: string })?.code
    if (code === undefined || !['EEXIST', 'EPERM', 'EACCES', 'ENOTEMPTY'].includes(code)) {
      await rm(source, { force: true }).catch(() => undefined)
      throw error
    }
  }

  const parked = `${destination}.parked-${process.pid}-${randomUUID()}`
  let parkedExisting = false
  try {
    try {
      await rename(destination, parked)
      parkedExisting = true
    } catch (error) {
      if ((error as { code?: string })?.code !== 'ENOENT') throw error
    }
    await rename(source, destination)
    if (parkedExisting) await rm(parked, { force: true }).catch(() => undefined)
  } catch (error) {
    if (parkedExisting) await rename(parked, destination).catch(() => undefined)
    await rm(source, { force: true }).catch(() => undefined)
    throw error
  }
}

/** 原子替换一个文本文件，并把上一版保留为 `<target>.previous`。 */
export async function atomicWriteText(target: string, text: string): Promise<void> {
  const directory = path.dirname(target)
  mkdirSync(directory, { recursive: true })
  await withLock(target, async () => {
    // 先保住上一版（读不到就是没有上一版，不算错）。
    const current = await readFile(target, 'utf8').catch(() => undefined)
    if (current !== undefined) {
      const previousTemp = await writeTempFile(directory, current)
      await replaceFile(previousTemp, `${target}.previous`)
    }
    const temp = await writeTempFile(directory, text)
    await replaceFile(temp, target)
    await fsyncDirectory(directory)
  })
}

/**
 * 按字节预算压缩文档。
 * 逐轮收紧（列表条数 + 单字段长度），任何一轮能塞进预算就返回；
 * 全部轮次都不行返回 undefined —— 调用方据此 fail-closed（不换窗）。
 * `maxBytes <= 0` 表示「不限制」：原样返回完整文档，不做任何裁剪。
 */
function fitDocument(doc: HandoffCheckpoint, maxBytes: number): string | undefined {
  const full = `${JSON.stringify(doc, null, 2)}\n`
  if (maxBytes <= 0) return full
  const passes: Array<(input: HandoffCheckpoint) => HandoffCheckpoint> = [
    (input) => input,
    (input) => trimDoc(input, { lists: 8, field: 600 }),
    (input) => trimDoc(input, { lists: 5, field: 400 }),
    (input) => trimDoc(input, { lists: 3, field: 240 }),
    (input) => trimDoc(input, { lists: 2, field: 160 }),
    (input) => trimDoc(input, { lists: 1, field: 120 }),
  ]
  for (const pass of passes) {
    const text = `${JSON.stringify(pass(doc), null, 2)}\n`
    if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  }
  return undefined
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 1))}…`
}

function trimDoc(
  doc: HandoffCheckpoint,
  limit: { lists: number; field: number },
): HandoffCheckpoint {
  const lists = (items: string[]): string[] => items.slice(0, limit.lists).map((item) => clip(item, limit.field))
  return {
    ...doc,
    goal: clip(doc.goal, limit.field),
    done: lists(doc.done),
    pending_todos: lists(doc.pending_todos),
    key_decisions: lists(doc.key_decisions),
    last_human_request: clip(doc.last_human_request, limit.field),
    notes: doc.notes === undefined ? undefined : doc.notes.slice(0, limit.lists).map((item) => clip(item, limit.field)),
  }
}

export class CheckpointWriteError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message)
    this.name = 'CheckpointWriteError'
  }
}

export interface WriteCheckpointResult {
  checkpointPath: string
  bytes: number
  trimmed: boolean
}

/**
 * 写一份交接检查点（三层落盘）：
 *   1. `handoffs/<sessionId>.json` —— **每会话稳定路径**，原子替换并保留 `.previous`
 *      （同一会话再次交接时旧版就留在 `.previous`，可回滚）；`checkpoint_path` 指向它。
 *   2. `handoffs/history/<时间戳>-<sessionId>.json` —— 不可变历史副本（保留最近 50 份），
 *      防止「稳定路径被覆盖后想找回更早的版本」。
 *   3. `latest.json` —— 指针，状态工具与人工排查都读它。
 *
 * 任何失败都抛 CheckpointWriteError —— 上层必须据此**拒绝换窗**（fail-closed）。
 * 第 2/3 层是附加保障，写失败只记日志、不阻断交接；第 1 层才是硬门。
 */
export async function writeCheckpoint(
  root: string,
  doc: HandoffCheckpoint,
  maxBytes: number,
): Promise<WriteCheckpointResult> {
  const directory = path.join(root, 'handoffs')
  const sessionPart = sanitizeFilePart(doc.sessionId)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const target = path.join(directory, `${sessionPart}.json`)

  // checkpoint_path 是自指字段：先写进文档再序列化。
  const withPath: HandoffCheckpoint = { ...doc, checkpoint_path: target }
  const text = fitDocument(withPath, maxBytes)
  if (text === undefined) {
    throw new CheckpointWriteError(
      `checkpoint exceeds checkpointMaxBytes (${maxBytes}B) even after trimming; refusing to hand off`,
    )
  }
  const trimmed = text !== `${JSON.stringify(withPath, null, 2)}\n`

  try {
    await atomicWriteText(target, text)
  } catch (error) {
    throw new CheckpointWriteError(`checkpoint write failed: ${String((error as Error)?.message ?? error)}`, error)
  }

  // 附加层：历史副本（不可变）+ 最新指针。失败不影响主流程。
  const historyDirectory = path.join(directory, 'history')
  await atomicWriteText(path.join(historyDirectory, `${stamp}-${sessionPart}.json`), text).catch(() => undefined)
  await atomicWriteText(
    path.join(root, 'latest.json'),
    `${JSON.stringify({ checkpointPath: target, sessionId: doc.sessionId, createdAt: doc.createdAt }, null, 2)}\n`,
  ).catch(() => undefined)

  pruneOldCheckpoints(historyDirectory)
  return { checkpointPath: target, bytes: Buffer.byteLength(text, 'utf8'), trimmed }
}

/** 只保留最近 N 份，避免无限增长（best-effort，失败不影响交接）。 */
function pruneOldCheckpoints(directory: string): void {
  try {
    const entries = readdirSync(directory)
      .filter((name) => name.endsWith('.json'))
      .map((name) => {
        const full = path.join(directory, name)
        return { full, mtime: statSync(full).mtimeMs }
      })
      .sort((a, b) => b.mtime - a.mtime)
    for (const stale of entries.slice(KEEP_CHECKPOINTS)) {
      try {
        unlinkSync(stale.full)
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
}

/** 读 latest 指针；失败返回 undefined（调用方降级）。 */
/** 每会话稳定检查点路径（换窗时写这里，见 writeCheckpoint）。 */
/** 工作区 → 需求文件名（用目录名，非法字符替换掉）。 */
function requirementSlug(cwd: string): string {
  const base = cwd.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean).pop() ?? 'workspace'
  return base.replace(/[^\w\u4e00-\u9fa5.-]+/g, '_').slice(0, 60)
}

/** 把原始需求落盘成 `requirements/<工作区>.md`（内容不变就不重写）。 */
export function writeRequirementFile(root: string, cwd: string, text: string, source: string): string | undefined {
  const body = String(text ?? '').trim()
  if (body.length === 0) return undefined
  try {
    const directory = path.join(root, 'requirements')
    mkdirSync(directory, { recursive: true })
    const file = path.join(directory, `${requirementSlug(cwd)}.md`)
    const content = `# 原始需求（逐字）\n\n> 来源会话：${source || '未知'}\n> 采集时间：${new Date().toISOString()}\n\n${body}\n`
    let previous = ''
    try { previous = readFileSync(file, 'utf8') } catch { previous = '' }
    const sameBody = previous.includes(body)
    if (!sameBody) writeFileSync(file, content, 'utf8')
    return file
  } catch {
    return undefined
  }
}

/**
 * 在最近的检查点里找「原始需求」。
 * 用于链式继承：新窗口自己没有任何用户消息时，沿用上一份检查点里的原文。
 */
export function findOriginalRequest(root: string, cwd: string): { text: string; source: string } | undefined {
  try {
    const directory = path.join(root, 'handoffs')
    const names = readdirSync(directory).filter((name) => name.endsWith('.json') && !name.endsWith('.previous'))
    const candidates: Array<{ text: string; source: string; at: number }> = []
    for (const name of names) {
      try {
        const doc = JSON.parse(readFileSync(path.join(directory, name), 'utf8')) as {
          original_request?: unknown
          original_request_source?: unknown
          cwd?: unknown
          createdAt?: unknown
        }
        if (typeof doc.original_request !== 'string' || doc.original_request.trim().length === 0) continue
        if (typeof doc.cwd === 'string' && doc.cwd.length > 0 && cwd.length > 0 && doc.cwd !== cwd) continue
        const at = typeof doc.createdAt === 'string' ? Date.parse(doc.createdAt) : 0
        candidates.push({
          text: doc.original_request,
          source: typeof doc.original_request_source === 'string' ? doc.original_request_source : '',
          at: Number.isFinite(at) ? at : 0,
        })
      } catch {
        /* 单份坏文件不影响整体 */
      }
    }
    candidates.sort((a, b) => b.at - a.at)
    return candidates[0]
  } catch {
    return undefined
  }
}

export function sessionCheckpointPath(root: string, sessionId: string): string {
  return path.join(root, 'handoffs', `${sessionId}.json`)
}

/** 该会话是否已经交接过（存在检查点即视为已交接；重启后依然有效）。 */
export function hasSessionCheckpoint(root: string, sessionId: string): boolean {
  try {
    return existsSync(sessionCheckpointPath(root, sessionId))
  } catch {
    return false
  }
}

export function readLatestPointer(root: string): LatestPointer | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path.join(root, 'latest.json'), 'utf8')) as Partial<LatestPointer>
    if (typeof parsed?.checkpointPath !== 'string') return undefined
    // 用户清理过 handoffs/ 之后，指针会指向不存在的文件：别再报一个假路径。
    if (!existsSync(parsed.checkpointPath)) return undefined
    return {
      checkpointPath: parsed.checkpointPath,
      sessionId: String(parsed.sessionId ?? ''),
      createdAt: String(parsed.createdAt ?? ''),
    }
  } catch {
    return undefined
  }
}

/** 读一份检查点正文（给「新会话被要求回读」时用，也便于排查）。 */
export function readCheckpointText(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
}

// ── 待注入简报（新会话首轮）──────────────────────────────────────────────

export interface PendingBrief {
  sessionId: string
  createdAt: number
  text: string
  checkpointPath: string
  sourceSessionId?: string
}

export const PENDING_TTL_MS = 6 * 60 * 60 * 1000

export function pendingBriefPath(root: string, sessionId: string): string {
  return path.join(root, 'pending-briefs', `${sanitizeFilePart(sessionId)}.json`)
}

export async function savePendingBrief(root: string, brief: PendingBrief): Promise<string> {
  const target = pendingBriefPath(root, brief.sessionId)
  await atomicWriteText(target, `${JSON.stringify(brief, null, 2)}\n`)
  return target
}

export function loadPendingBrief(root: string, sessionId: string): PendingBrief | undefined {
  const file = pendingBriefPath(root, sessionId)
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<PendingBrief>
    if (typeof parsed?.text !== 'string' || parsed.text.length === 0) return undefined
    const createdAt = Number(parsed.createdAt) || 0
    if (createdAt > 0 && Date.now() - createdAt > PENDING_TTL_MS) {
      try { unlinkSync(file) } catch { /* ignore */ }
      return undefined
    }
    return {
      sessionId,
      createdAt,
      text: parsed.text,
      checkpointPath: String(parsed.checkpointPath ?? ''),
      sourceSessionId: typeof parsed.sourceSessionId === 'string' ? parsed.sourceSessionId : undefined,
    }
  } catch {
    return undefined
  }
}

export function clearPendingBrief(root: string, sessionId: string): void {
  try {
    unlinkSync(pendingBriefPath(root, sessionId))
  } catch {
    /* ignore */
  }
}

export { mkdir as ensureDirectory }
