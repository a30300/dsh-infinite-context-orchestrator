// 扫描并修复 corrupt 会话：删除「不在 open turn 内」的 developer/message。
// 用法：node scripts/repair-sessions.mjs [--apply]
// 不加 --apply 只报告；加 --apply 会改写文件（先备份 .corrupt-bak）。
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const APPLY = process.argv.includes('--apply')
import os from 'node:os'

/** DSH 主目录：优先 DSH_HOME，否则 ~/.dsh。 */
const DSH_HOME = process.env.DSH_HOME && process.env.DSH_HOME.trim().length > 0
  ? process.env.DSH_HOME.trim()
  : path.join(os.homedir(), '.dsh')
const ROOT = path.join(DSH_HOME, 'sessions')
// 扫**所有**工作区（之前写死了几个目录，漏掉了 1116，导致它的坏日志没被修）。
const WORKSPACES = fs.readdirSync(ROOT).filter((name) => fs.statSync(path.join(ROOT, name)).isDirectory())

/** 找出要删除的行号（0-based）：不在 open turn 内的 developer/message。 */
/** 会话目录名（形如 --C-Users-x-...-workspace-1116--）→ 可读标签。 */
function workspaceLabel(name) {
  const parts = name.split('-').filter(Boolean)
  const index = parts.lastIndexOf('workspace')
  if (index >= 0 && index + 1 < parts.length) return parts.slice(index + 1).join('-')
  return parts.slice(-1)[0] ?? name
}

function badIndexes(events) {
  let openTurn
  const bad = []
  events.forEach((ev, index) => {
    if (ev?.type === 'turn/start') { openTurn = ev.data?.turn; return }
    if (ev?.type === 'turn/end') { openTurn = undefined; return }
    if (ev?.type === 'developer/message' && openTurn === undefined) bad.push(index)
  })
  return bad
}

let scanned = 0
let corrupt = 0
let repaired = 0
for (const workspace of WORKSPACES) {
  const dir = path.join(ROOT, workspace)
  let names = []
  try { names = fs.readdirSync(dir) } catch { continue }
  for (const name of names) {
    const file = path.join(dir, name, 'session.v4.jsonl.zstd')
    if (!fs.existsSync(file)) continue
    scanned += 1
    let text
    try { text = zlib.zstdDecompressSync(fs.readFileSync(file)).toString('utf8') } catch { continue }
    const lines = text.split('\n').filter((line) => line.trim())
    const events = lines.map((line) => { try { return JSON.parse(line) } catch { return null } })
    const bad = badIndexes(events)
    if (bad.length === 0) continue
    corrupt += 1
    console.log(`[corrupt] ${workspaceLabel(workspace)} / ${name.slice(8, 16)}  待删 ${bad.length} 条 developer/message`)
    if (!APPLY) continue
    const kept = lines.filter((_, index) => !bad.includes(index))
    const next = `${kept.join('\n')}\n`
    const backup = `${file}.corrupt-bak`
    if (!fs.existsSync(backup)) fs.copyFileSync(file, backup)
    fs.writeFileSync(file, zlib.zstdCompressSync(Buffer.from(next, 'utf8')))
    repaired += 1
  }
}

console.log('')
console.log(`扫描 ${scanned} 个会话，发现 ${corrupt} 个含无效 developer/message${APPLY ? `，已修复 ${repaired} 个（备份：*.corrupt-bak）` : '（加 --apply 才会改写）'}`)
