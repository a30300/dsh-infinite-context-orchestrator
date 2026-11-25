/**
 * 凭据脱敏。
 *
 * 检查点会被新会话（可能还有另一个模型）读到，所以写入前必须假定字符串里
 * 可能夹着 token / cookie / 私钥。这里只做「保守但明显」的替换：
 * 宁可多遮一点，也不要把凭据带进新窗口。
 *
 * 原则：不改变正常的自然语言与代码标识符；只动「长得像凭据」的片段。
 */

const MASK = '[REDACTED]'

interface Rule {
  pattern: RegExp
  replacement: string
}

const RULES: Rule[] = [
  // PEM 私钥整块
  {
    pattern: /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]{0,40}PRIVATE KEY-----/g,
    replacement: '[REDACTED_PRIVATE_KEY]',
  },
  // OpenAI / DeepSeek 风格 sk-*
  { pattern: /\bsk-[A-Za-z0-9_-]{8,}/g, replacement: `${MASK}_API_KEY` },
  // GitHub token 家族
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{16,}/g, replacement: `${MASK}_GITHUB_TOKEN` },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, replacement: `${MASK}_GITHUB_TOKEN` },
  // AWS access key id
  { pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{12,}/g, replacement: `${MASK}_AWS_KEY` },
  // JWT（三段点分）
  { pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, replacement: `${MASK}_JWT` },
  // Authorization: Bearer xxx
  { pattern: /\b(Bearer\s+)[A-Za-z0-9._~+/-]{8,}=*/gi, replacement: `$1${MASK}` },
  // key: value / key=value 形式的敏感字段
  {
    pattern: /\b((?:api[_-]?key|apikey|access[_-]?key|secret[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|auth[_-]?token|id[_-]?token|password|passwd|pwd|token|secret|cookie|authorization)\s*[:=]\s*)("[^"\n]{1,4096}"|'[^'\n]{1,4096}'|[^\s,;"'\n]{4,})/gi,
    replacement: `$1${MASK}`,
  },
  // ENV 风格：SOME_TOKEN=abcdef...
  {
    pattern: /\b([A-Z][A-Z0-9_]{2,}(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL))\s*=\s*([^\s"'`]{6,})/g,
    replacement: `$1=${MASK}`,
  },
]

/** 把用户主目录替换成 ~，避免检查点泄漏本机用户名。 */
function redactHomePath(text: string, home: string): string {
  if (typeof home !== 'string' || home.length < 4) return text
  const escaped = home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return text.replace(new RegExp(escaped, 'gi'), '~')
}

export interface RedactOptions {
  /** 当前用户主目录；缺省用 $USERPROFILE / $HOME。 */
  home?: string
  /** 单字段扫描上限，防止对超大文本做正则回溯。 */
  maxChars?: number
}

/** 脱敏任意文本；幂等（重复调用不会破坏 [REDACTED] 标记）。 */
export function redactText(input: string, options: RedactOptions = {}): string {
  if (typeof input !== 'string' || input.length === 0) return ''
  const limit = options.maxChars ?? 200_000
  let text = input.length > limit ? `${input.slice(0, limit)}\n…（本字段超过 ${limit} 字符，已截断）` : input
  for (const rule of RULES) text = text.replace(rule.pattern, rule.replacement)
  const home = options.home ?? process.env.USERPROFILE ?? process.env.HOME
  if (typeof home === 'string' && home.length > 0) text = redactHomePath(text, home)
  return text
}

/** 递归脱敏任意 JSON 兼容值（对象键名不动，只洗字符串值）。 */
export function redactValue(value: unknown, options: RedactOptions = {}, depth = 0): unknown {
  if (depth > 8) return '[DEPTH_LIMIT]'
  if (typeof value === 'string') return redactText(value, options)
  if (Array.isArray(value)) return value.map((item) => redactValue(item, options, depth + 1))
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = redactValue(item, options, depth + 1)
    return out
  }
  return value
}
