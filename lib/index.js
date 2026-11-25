// src/budget.ts
var CACHE_TTL_MS = 4e3;
var cache = /* @__PURE__ */ new Map();
function positive(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : void 0;
}
function readPressureProjection(ctx, session) {
  try {
    const projections = ctx.get("sessionProjections");
    const raw = projections?.stateOf?.(session, "contextPressure");
    if (raw === void 0 || raw === null) return {};
    return {
      window: positive(raw.contextWindow),
      // projectedTokens 优先：它是「这一轮请求将占用」的预估值，比上一轮实测更贴近临界判断。
      used: positive(raw.projectedTokens) ?? positive(raw.pressureTokens)
    };
  } catch {
    return {};
  }
}
function readMeter(ctx, session) {
  try {
    const meter = ctx.get("tokenMeter");
    if (meter === void 0 || typeof meter.measure !== "function") return { note: "tokenMeter \u670D\u52A1\u4E0D\u53EF\u7528" };
    const measurement = meter.measure(session);
    if (measurement === void 0 || measurement === null) return { note: "tokenMeter.measure \u8FD4\u56DE\u4E86\u7A7A\u503C" };
    const tokens = measurement.totalTokens;
    if (typeof tokens !== "number" || !Number.isFinite(tokens)) {
      return { note: `tokenMeter.measure \u6CA1\u6709\u8FD4\u56DE\u6570\u5B57\uFF0C\u5B9E\u9645\u662F ${typeof tokens}` };
    }
    return { tokens: Math.max(0, tokens) };
  } catch (error) {
    return { note: `tokenMeter.measure \u629B\u9519\uFF1A${String(error?.message ?? error).slice(0, 120)}` };
  }
}
async function readWindowFromModel(ctx, session) {
  try {
    const header = typeof session?.requestHeader === "function" ? session.requestHeader() : void 0;
    const provider = header?.config?.provider;
    const model = header?.config?.model;
    if (typeof provider !== "string" || typeof model !== "string") return void 0;
    const llm = ctx.get("llm");
    const info = await llm?.resolveModelInfo?.(provider, model);
    return positive(info?.context?.contextWindow);
  } catch {
    return void 0;
  }
}
function modelOf(session) {
  try {
    const header = typeof session?.requestHeader === "function" ? session.requestHeader() : void 0;
    const model = header?.config?.model;
    return typeof model === "string" && model.length > 0 ? model : void 0;
  } catch {
    return void 0;
  }
}
function providerOf(session) {
  try {
    const header = typeof session?.requestHeader === "function" ? session.requestHeader() : void 0;
    const provider = header?.config?.provider;
    return typeof provider === "string" && provider.length > 0 ? provider : void 0;
  } catch {
    return void 0;
  }
}
function windowConfigOf(config) {
  return { byModel: config.contextWindowByModel ?? {} };
}
function sessionModelOf(session) {
  if (session === void 0) return {};
  const provider = providerOf(session);
  const model = modelOf(session);
  return {
    ...provider === void 0 ? {} : { provider },
    ...model === void 0 ? {} : { model }
  };
}
function decideWindow(config, provider, model) {
  const byModel = config.byModel ?? {};
  const candidates = [];
  if (provider !== void 0 && model !== void 0) candidates.push(`${provider}/${model}`);
  if (model !== void 0) candidates.push(model);
  for (const key of candidates) {
    const hit = byModel[key];
    if (typeof hit === "number" && hit > 0) return { value: hit, source: "model-map" };
  }
  const global = config.override ?? 0;
  if (global > 0) {
    const matcher = (config.overrideFor ?? "").trim();
    if (matcher === "" || (model ?? "").toLowerCase().includes(matcher.toLowerCase())) {
      return { value: global, source: "global" };
    }
  }
  return { value: 0, source: "none" };
}
async function measureOccupancy(ctx, agent, windowConfig = {}) {
  const session = agent?.session;
  if (session === void 0 || typeof session.id !== "string") {
    return { source: "unavailable", basis: "unavailable" };
  }
  const model = modelOf(session);
  const provider = providerOf(session);
  const decided = decideWindow(windowConfig, provider, model);
  const overrideApplies = decided.value > 0;
  const cacheKey = `${session.id}:${decided.value}:${decided.source}:${Object.keys(windowConfig.byModel ?? {}).length}`;
  const cached = cache.get(cacheKey);
  if (cached !== void 0 && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;
  const projection = readPressureProjection(ctx, session);
  const meter = projection.used === void 0 ? readMeter(ctx, session) : { tokens: void 0, note: void 0 };
  const used = projection.used ?? meter.tokens;
  const dshWindow = projection.window ?? await readWindowFromModel(ctx, session);
  const window = overrideApplies ? decided.value : dshWindow;
  const windowSource = overrideApplies ? "config" : dshWindow !== void 0 ? projection.window !== void 0 ? "pressure" : "model" : "unknown";
  const source = projection.used !== void 0 ? "pressure" : meter.tokens !== void 0 ? "meter" : "unavailable";
  const basis = used !== void 0 && window !== void 0 ? "ratio" : used !== void 0 ? "tokens" : "unavailable";
  const value = {
    source,
    basis,
    windowSource,
    ...overrideApplies ? { windowOverrideBy: decided.source } : {},
    ...used === void 0 ? {} : { usedTokens: used },
    ...window === void 0 ? {} : { windowTokens: window },
    // 自定窗口生效时，把 DSH 读到的值也带上，方便对照（例如 DSH 读 204800、自定 64000）
    ...overrideApplies && dshWindow !== void 0 ? { dshWindowTokens: dshWindow } : {},
    ...used !== void 0 && window !== void 0 ? { percent: Math.round(used / window * 1e3) / 10 } : {},
    ...basis === "ratio" ? {} : { note: meter.note ?? (window === void 0 ? "\u62FF\u4E0D\u5230\u4E0A\u4E0B\u6587\u7A97\u53E3\u5927\u5C0F\uFF08\u6A21\u578B\u672A\u58F0\u660E contextWindow\uFF09" : "\u62FF\u4E0D\u5230\u5DF2\u7528 token \u6570") }
  };
  cache.set(cacheKey, { at: Date.now(), value });
  if (cache.size > 64) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest !== void 0) cache.delete(oldest[0]);
  }
  return value;
}
function crossedThreshold(occupancy, thresholdPercent, thresholdTokens = 0) {
  if (occupancy.basis === "unavailable") return { crossed: false, reason: "occupancy-unavailable", by: "none" };
  const used = occupancy.usedTokens;
  const tokensArmed = thresholdTokens > 0;
  const byTokens = tokensArmed && used !== void 0 && used >= thresholdTokens;
  const percentArmed = thresholdPercent > 0;
  const byPercent = percentArmed && occupancy.basis === "ratio" && occupancy.percent !== void 0 && occupancy.percent >= thresholdPercent;
  if (byTokens) return { crossed: true, reason: "token-threshold-crossed", by: "tokens" };
  if (byPercent) return { crossed: true, reason: "threshold-crossed", by: "percent" };
  if (!percentArmed && !tokensArmed) return { crossed: false, reason: "threshold-disabled", by: "none" };
  if (occupancy.basis === "tokens" && !tokensArmed) return { crossed: false, reason: "context-window-unknown", by: "none" };
  return { crossed: false, reason: "below-threshold", by: "none" };
}
function thresholdGap(occupancy, thresholdPercent, thresholdTokens = 0) {
  const parts = [];
  if (occupancy.percent !== void 0) {
    const gap = Math.round((thresholdPercent - occupancy.percent) * 10) / 10;
    parts.push(gap > 0 ? `\u8FD8\u5DEE ${gap}% \u5230\u767E\u5206\u6BD4\u9608\u503C` : `\u5DF2\u8D85\u8FC7\u767E\u5206\u6BD4\u9608\u503C`);
  }
  if (thresholdTokens > 0 && occupancy.usedTokens !== void 0) {
    const gapTokens = Math.round(thresholdTokens - occupancy.usedTokens);
    parts.push(gapTokens > 0 ? `\u8FD8\u5DEE ${gapTokens.toLocaleString("en-US")} tokens \u5230 token \u9608\u503C` : "\u5DF2\u8D85\u8FC7 token \u9608\u503C");
  }
  return { text: parts.length === 0 ? "\u65E0\u6CD5\u4F30\u7B97\uFF08\u7F3A\u5C11\u5360\u7528\u6570\u636E\uFF09" : parts.join(" \xB7 ") };
}
var DEFAULT_THRESHOLD_PERCENT = 80;
function resolvePolicy(config, session) {
  const provider = session === void 0 ? void 0 : providerOf(session);
  const model = session === void 0 ? void 0 : modelOf(session);
  const decided = decideWindow(windowConfigOf(config), provider, model);
  const windowMap = config.contextWindowByModel ?? {};
  const thresholdMap = config.thresholdByModel ?? {};
  const keys = [];
  if (provider !== void 0 && model !== void 0) keys.push(`${provider}/${model}`);
  if (model !== void 0) keys.push(model);
  let matched = decided.value > 0;
  let thresholdPercent = DEFAULT_THRESHOLD_PERCENT;
  for (const key of keys) {
    const windowValue = windowMap[key];
    if (typeof windowValue === "number" && windowValue > 0) matched = true;
    const thresholdValue = thresholdMap[key];
    if (typeof thresholdValue === "number") {
      matched = true;
      thresholdPercent = thresholdValue;
    }
  }
  const anyConfigured = Object.keys(windowMap).length > 0 || Object.keys(thresholdMap).length > 0;
  const managed = anyConfigured ? matched : true;
  return { window: decided.value, windowSource: decided.source, thresholdPercent, managed };
}
function clearOccupancyCache() {
  cache.clear();
}
function invalidateOccupancy(sessionId) {
  if (typeof sessionId !== "string" || sessionId.length === 0) return;
  const prefix = `${sessionId}:`;
  for (const key of [...cache.keys()]) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}
function formatOccupancy(occupancy) {
  if (occupancy.basis === "unavailable") {
    return `\u5360\u7528\u672A\u77E5\uFF08${occupancy.note ?? "contextPressure \u4E0E tokenMeter \u90FD\u6CA1\u7ED9\u51FA\u53EF\u7528\u6570\u503C"}\uFF09`;
  }
  const used = occupancy.usedTokens === void 0 ? "?" : Math.round(occupancy.usedTokens).toLocaleString("en-US");
  const window = occupancy.windowTokens === void 0 ? "?" : Math.round(occupancy.windowTokens).toLocaleString("en-US");
  const windowTag = occupancy.windowSource === "config" ? `\uFF0C\u7A97\u53E3\u4E3A\u81EA\u5B9A\u503C${occupancy.dshWindowTokens === void 0 ? "" : `\uFF1BDSH \u8BFB\u5230 ${Math.round(occupancy.dshWindowTokens).toLocaleString("en-US")}`}` : "";
  if (occupancy.percent === void 0) {
    return `${used} tokens\uFF08\u7A97\u53E3\u672A\u77E5\uFF0C\u65E0\u6CD5\u7B97\u767E\u5206\u6BD4\uFF1B\u6765\u6E90 ${occupancy.source}${occupancy.note === void 0 ? "" : `\uFF1B${occupancy.note}`}\uFF09`;
  }
  return `${occupancy.percent}%\uFF08${used} / ${window} tokens\uFF0C\u6765\u6E90 ${occupancy.source}${windowTag}\uFF09`;
}

// src/checkpoint.ts
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
var KEEP_CHECKPOINTS = 50;
var locks = /* @__PURE__ */ new Map();
async function withLock(key, task) {
  const prior = locks.get(key) ?? Promise.resolve();
  const run = prior.catch(() => void 0).then(task);
  locks.set(key, run);
  try {
    return await run;
  } finally {
    if (locks.get(key) === run) locks.delete(key);
  }
}
function resolveCheckpointRoot(configured) {
  if (typeof configured === "string" && configured.trim().length > 0) {
    const raw = configured.trim();
    const expanded = raw.startsWith("~/") || raw.startsWith("~\\") ? path.join(homedir(), raw.slice(2)) : raw;
    return path.resolve(expanded);
  }
  const home = typeof process.env.DSH_HOME === "string" && process.env.DSH_HOME.trim().length > 0 ? path.resolve(process.env.DSH_HOME.trim()) : path.join(homedir(), ".dsh");
  return path.join(home, "task-checkpoints", "orchestrator");
}
function sanitizeFilePart(value) {
  return String(value).replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80);
}
async function writeTempFile(directory, text) {
  const temporary = path.join(directory, `.tmp-${process.pid}-${randomUUID()}`);
  let handle;
  try {
    handle = await open(temporary, "wx", 384);
    await handle.writeFile(text, "utf8");
    await handle.sync();
    return temporary;
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => void 0);
    throw error;
  } finally {
    await handle?.close().catch(() => void 0);
  }
}
async function fsyncDirectory(directory) {
  let handle;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch (error) {
    const code = error?.code;
    if (code !== void 0 && !["EINVAL", "EISDIR", "EPERM", "EACCES", "EBADF", "ENOENT"].includes(code)) throw error;
  } finally {
    await handle?.close().catch(() => void 0);
  }
}
async function replaceFile(source, destination) {
  try {
    await rename(source, destination);
    return;
  } catch (error) {
    const code = error?.code;
    if (code === void 0 || !["EEXIST", "EPERM", "EACCES", "ENOTEMPTY"].includes(code)) {
      await rm(source, { force: true }).catch(() => void 0);
      throw error;
    }
  }
  const parked = `${destination}.parked-${process.pid}-${randomUUID()}`;
  let parkedExisting = false;
  try {
    try {
      await rename(destination, parked);
      parkedExisting = true;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await rename(source, destination);
    if (parkedExisting) await rm(parked, { force: true }).catch(() => void 0);
  } catch (error) {
    if (parkedExisting) await rename(parked, destination).catch(() => void 0);
    await rm(source, { force: true }).catch(() => void 0);
    throw error;
  }
}
async function atomicWriteText(target, text) {
  const directory = path.dirname(target);
  mkdirSync(directory, { recursive: true });
  await withLock(target, async () => {
    const current = await readFile(target, "utf8").catch(() => void 0);
    if (current !== void 0) {
      const previousTemp = await writeTempFile(directory, current);
      await replaceFile(previousTemp, `${target}.previous`);
    }
    const temp = await writeTempFile(directory, text);
    await replaceFile(temp, target);
    await fsyncDirectory(directory);
  });
}
function fitDocument(doc, maxBytes) {
  const full = `${JSON.stringify(doc, null, 2)}
`;
  if (maxBytes <= 0) return full;
  const passes = [
    (input) => input,
    (input) => trimDoc(input, { lists: 8, field: 600 }),
    (input) => trimDoc(input, { lists: 5, field: 400 }),
    (input) => trimDoc(input, { lists: 3, field: 240 }),
    (input) => trimDoc(input, { lists: 2, field: 160 }),
    (input) => trimDoc(input, { lists: 1, field: 120 })
  ];
  for (const pass of passes) {
    const text = `${JSON.stringify(pass(doc), null, 2)}
`;
    if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  }
  return void 0;
}
function clip(text, max) {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}\u2026`;
}
function trimDoc(doc, limit) {
  const lists = (items) => items.slice(0, limit.lists).map((item) => clip(item, limit.field));
  return {
    ...doc,
    goal: clip(doc.goal, limit.field),
    done: lists(doc.done),
    pending_todos: lists(doc.pending_todos),
    key_decisions: lists(doc.key_decisions),
    last_human_request: clip(doc.last_human_request, limit.field),
    notes: doc.notes === void 0 ? void 0 : doc.notes.slice(0, limit.lists).map((item) => clip(item, limit.field))
  };
}
var CheckpointWriteError = class extends Error {
  constructor(message, cause) {
    super(message);
    this.cause = cause;
    this.name = "CheckpointWriteError";
  }
};
async function writeCheckpoint(root, doc, maxBytes) {
  const directory = path.join(root, "handoffs");
  const sessionPart = sanitizeFilePart(doc.sessionId);
  const stamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
  const target = path.join(directory, `${sessionPart}.json`);
  const withPath = { ...doc, checkpoint_path: target };
  const text = fitDocument(withPath, maxBytes);
  if (text === void 0) {
    throw new CheckpointWriteError(
      `checkpoint exceeds checkpointMaxBytes (${maxBytes}B) even after trimming; refusing to hand off`
    );
  }
  const trimmed = text !== `${JSON.stringify(withPath, null, 2)}
`;
  try {
    await atomicWriteText(target, text);
  } catch (error) {
    throw new CheckpointWriteError(`checkpoint write failed: ${String(error?.message ?? error)}`, error);
  }
  const historyDirectory = path.join(directory, "history");
  await atomicWriteText(path.join(historyDirectory, `${stamp}-${sessionPart}.json`), text).catch(() => void 0);
  await atomicWriteText(
    path.join(root, "latest.json"),
    `${JSON.stringify({ checkpointPath: target, sessionId: doc.sessionId, createdAt: doc.createdAt }, null, 2)}
`
  ).catch(() => void 0);
  pruneOldCheckpoints(historyDirectory);
  return { checkpointPath: target, bytes: Buffer.byteLength(text, "utf8"), trimmed };
}
function pruneOldCheckpoints(directory) {
  try {
    const entries = readdirSync(directory).filter((name2) => name2.endsWith(".json")).map((name2) => {
      const full = path.join(directory, name2);
      return { full, mtime: statSync(full).mtimeMs };
    }).sort((a, b) => b.mtime - a.mtime);
    for (const stale of entries.slice(KEEP_CHECKPOINTS)) {
      try {
        unlinkSync(stale.full);
      } catch {
      }
    }
  } catch {
  }
}
function requirementSlug(cwd) {
  const base = cwd.replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean).pop() ?? "workspace";
  return base.replace(/[^\w\u4e00-\u9fa5.-]+/g, "_").slice(0, 60);
}
function writeRequirementFile(root, cwd, text, source) {
  const body = String(text ?? "").trim();
  if (body.length === 0) return void 0;
  try {
    const directory = path.join(root, "requirements");
    mkdirSync(directory, { recursive: true });
    const file = path.join(directory, `${requirementSlug(cwd)}.md`);
    const content = `# \u539F\u59CB\u9700\u6C42\uFF08\u9010\u5B57\uFF09

> \u6765\u6E90\u4F1A\u8BDD\uFF1A${source || "\u672A\u77E5"}
> \u91C7\u96C6\u65F6\u95F4\uFF1A${(/* @__PURE__ */ new Date()).toISOString()}

${body}
`;
    let previous = "";
    try {
      previous = readFileSync(file, "utf8");
    } catch {
      previous = "";
    }
    const sameBody = previous.includes(body);
    if (!sameBody) writeFileSync(file, content, "utf8");
    return file;
  } catch {
    return void 0;
  }
}
function findOriginalRequest(root, cwd) {
  try {
    const directory = path.join(root, "handoffs");
    const names = readdirSync(directory).filter((name2) => name2.endsWith(".json") && !name2.endsWith(".previous"));
    const candidates = [];
    for (const name2 of names) {
      try {
        const doc = JSON.parse(readFileSync(path.join(directory, name2), "utf8"));
        if (typeof doc.original_request !== "string" || doc.original_request.trim().length === 0) continue;
        if (typeof doc.cwd === "string" && doc.cwd.length > 0 && cwd.length > 0 && doc.cwd !== cwd) continue;
        const at = typeof doc.createdAt === "string" ? Date.parse(doc.createdAt) : 0;
        candidates.push({
          text: doc.original_request,
          source: typeof doc.original_request_source === "string" ? doc.original_request_source : "",
          at: Number.isFinite(at) ? at : 0
        });
      } catch {
      }
    }
    candidates.sort((a, b) => b.at - a.at);
    return candidates[0];
  } catch {
    return void 0;
  }
}
function sessionCheckpointPath(root, sessionId) {
  return path.join(root, "handoffs", `${sessionId}.json`);
}
function hasSessionCheckpoint(root, sessionId) {
  try {
    return existsSync(sessionCheckpointPath(root, sessionId));
  } catch {
    return false;
  }
}
function readLatestPointer(root) {
  try {
    const parsed = JSON.parse(readFileSync(path.join(root, "latest.json"), "utf8"));
    if (typeof parsed?.checkpointPath !== "string") return void 0;
    if (!existsSync(parsed.checkpointPath)) return void 0;
    return {
      checkpointPath: parsed.checkpointPath,
      sessionId: String(parsed.sessionId ?? ""),
      createdAt: String(parsed.createdAt ?? "")
    };
  } catch {
    return void 0;
  }
}
var PENDING_TTL_MS = 6 * 60 * 60 * 1e3;
function pendingBriefPath(root, sessionId) {
  return path.join(root, "pending-briefs", `${sanitizeFilePart(sessionId)}.json`);
}
async function savePendingBrief(root, brief) {
  const target = pendingBriefPath(root, brief.sessionId);
  await atomicWriteText(target, `${JSON.stringify(brief, null, 2)}
`);
  return target;
}
function loadPendingBrief(root, sessionId) {
  const file = pendingBriefPath(root, sessionId);
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (typeof parsed?.text !== "string" || parsed.text.length === 0) return void 0;
    const createdAt = Number(parsed.createdAt) || 0;
    if (createdAt > 0 && Date.now() - createdAt > PENDING_TTL_MS) {
      try {
        unlinkSync(file);
      } catch {
      }
      return void 0;
    }
    return {
      sessionId,
      createdAt,
      text: parsed.text,
      checkpointPath: String(parsed.checkpointPath ?? ""),
      sourceSessionId: typeof parsed.sourceSessionId === "string" ? parsed.sourceSessionId : void 0
    };
  } catch {
    return void 0;
  }
}
function clearPendingBrief(root, sessionId) {
  try {
    unlinkSync(pendingBriefPath(root, sessionId));
  } catch {
  }
}

// node_modules/.pnpm/@deepseek-ai+cosmokit@1.9.0/node_modules/@deepseek-ai/cosmokit/lib/index.js
function isNullable(value) {
  return value === null || value === void 0;
}
function isPlainObject(data) {
  return data && typeof data === "object" && !Array.isArray(data);
}
function filterKeys(object, filter) {
  return Object.fromEntries(Object.entries(object).filter(([key, value]) => filter(key, value)));
}
function mapValues(object, transform) {
  return Object.fromEntries(Object.entries(object).map(([key, value]) => [key, transform(value, key)]));
}
function pick(source, keys, forced) {
  if (!keys) return { ...source };
  const result = {};
  for (const key of keys) if (forced || source[key] !== void 0) result[key] = source[key];
  return result;
}
var write = Symbol.for("cosmokit.volatile.write");
function snapshot(value, ancestors = /* @__PURE__ */ new Set()) {
  if (typeof value === "function") throw new TypeError("volatile config cannot contain functions");
  if (value === null || typeof value !== "object") return value;
  if (ancestors.has(value)) throw new TypeError("volatile config cannot contain cycles");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return Object.freeze(value.map((item) => snapshot(item, ancestors)));
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new TypeError("volatile config objects must be plain objects or arrays");
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, snapshot(item, ancestors)])));
  } finally {
    ancestors.delete(value);
  }
}
function createVolatile(value) {
  let current = snapshot(value);
  return Object.freeze({
    get: () => current,
    [write]: (value2) => {
      current = value2;
    }
  });
}
function isVolatile(value) {
  return typeof value === "object" && value !== null && write in value;
}
function is(type, value) {
  if (arguments.length === 1) return (value2) => is(type, value2);
  return type in globalThis && value instanceof globalThis[type] || Object.prototype.toString.call(value).slice(8, -1) === type;
}
function isArrayBufferLike(value) {
  return is("ArrayBuffer", value) || is("SharedArrayBuffer", value);
}
function isArrayBufferSource(value) {
  return isArrayBufferLike(value) || ArrayBuffer.isView(value);
}
var Binary;
(function(Binary2) {
  Binary2.is = isArrayBufferLike;
  Binary2.isSource = isArrayBufferSource;
  function fromSource(source) {
    if (ArrayBuffer.isView(source)) return source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
    else return source;
  }
  Binary2.fromSource = fromSource;
  function toBase64(source) {
    source = fromSource(source);
    if (typeof Buffer !== "undefined") return Buffer.from(source).toString("base64");
    let binary = "";
    const bytes = new Uint8Array(source);
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }
  Binary2.toBase64 = toBase64;
  function fromBase64(source) {
    if (typeof Buffer !== "undefined") return fromSource(Buffer.from(source, "base64"));
    return Uint8Array.from(atob(source), (c) => c.charCodeAt(0));
  }
  Binary2.fromBase64 = fromBase64;
  function toHex(source) {
    source = fromSource(source);
    if (typeof Buffer !== "undefined") return Buffer.from(source).toString("hex");
    return Array.from(new Uint8Array(source), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  Binary2.toHex = toHex;
  function fromHex(source) {
    if (typeof Buffer !== "undefined") return fromSource(Buffer.from(source, "hex"));
    const hex = source.length % 2 === 0 ? source : source.slice(0, source.length - 1);
    const buffer = [];
    for (let i = 0; i < hex.length; i += 2) buffer.push(parseInt(`${hex[i]}${hex[i + 1]}`, 16));
    return Uint8Array.from(buffer).buffer;
  }
  Binary2.fromHex = fromHex;
})(Binary || (Binary = {}));
var base64ToArrayBuffer = Binary.fromBase64;
var arrayBufferToBase64 = Binary.toBase64;
var hexToArrayBuffer = Binary.fromHex;
var arrayBufferToHex = Binary.toHex;
function clone(source, refs = /* @__PURE__ */ new Map()) {
  if (!source || typeof source !== "object") return source;
  if (is("Date", source)) return new Date(source.valueOf());
  if (is("RegExp", source)) return new RegExp(source.source, source.flags);
  if (isArrayBufferLike(source)) return source.slice(0);
  if (ArrayBuffer.isView(source)) return source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
  const cached = refs.get(source);
  if (cached) return cached;
  if (Array.isArray(source)) {
    const result2 = [];
    refs.set(source, result2);
    source.forEach((value, index) => {
      result2[index] = Reflect.apply(clone, null, [value, refs]);
    });
    return result2;
  }
  const result = Object.create(Object.getPrototypeOf(source));
  refs.set(source, result);
  for (const key of Reflect.ownKeys(source)) {
    const descriptor = { ...Reflect.getOwnPropertyDescriptor(source, key) };
    if ("value" in descriptor) descriptor.value = Reflect.apply(clone, null, [descriptor.value, refs]);
    Reflect.defineProperty(result, key, descriptor);
  }
  return result;
}
function deepEqual(a, b, strict) {
  const ancestors = /* @__PURE__ */ new Set();
  function compare(a2, b2) {
    if (a2 === b2) return true;
    if (isVolatile(a2) || isVolatile(b2)) return isVolatile(a2) && isVolatile(b2);
    if (!strict && isNullable(a2) && isNullable(b2)) return true;
    if (typeof a2 !== typeof b2 || typeof a2 !== "object" || !a2 || !b2) return false;
    if (ancestors.has(a2)) return false;
    function check(test, then) {
      return test(a2) ? test(b2) ? then(a2, b2) : false : test(b2) ? false : void 0;
    }
    ancestors.add(a2);
    try {
      return check(Array.isArray, (a3, b3) => {
        if (a3.length !== b3.length) return false;
        for (let index = 0; index < a3.length; index++) if (!compare(a3[index], b3[index])) return false;
        return true;
      }) ?? check(is("Date"), (a3, b3) => a3.valueOf() === b3.valueOf()) ?? check(is("URL"), (a3, b3) => a3.href === b3.href) ?? check(is("RegExp"), (a3, b3) => a3.source === b3.source && a3.flags === b3.flags) ?? check(isArrayBufferLike, (a3, b3) => {
        if (a3.byteLength !== b3.byteLength) return false;
        const viewA = new Uint8Array(a3);
        const viewB = new Uint8Array(b3);
        for (let i = 0; i < viewA.length; i++) if (viewA[i] !== viewB[i]) return false;
        return true;
      }) ?? ((!strict || [a2, b2].every((value) => Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) && Object.keys({
        ...a2,
        ...b2
      }).every((key) => compare(a2[key], b2[key])));
    } finally {
      ancestors.delete(a2);
    }
  }
  return compare(a, b);
}
var Time;
(function(Time2) {
  Time2.millisecond = 1;
  Time2.second = 1e3;
  Time2.minute = Time2.second * 60;
  Time2.hour = Time2.minute * 60;
  Time2.day = Time2.hour * 24;
  Time2.week = Time2.day * 7;
  let timezoneOffset = (/* @__PURE__ */ new Date()).getTimezoneOffset();
  function setTimezoneOffset(offset) {
    timezoneOffset = offset;
  }
  Time2.setTimezoneOffset = setTimezoneOffset;
  function getTimezoneOffset() {
    return timezoneOffset;
  }
  Time2.getTimezoneOffset = getTimezoneOffset;
  function getDateNumber(date2 = /* @__PURE__ */ new Date(), offset) {
    if (typeof date2 === "number") date2 = new Date(date2);
    if (offset === void 0) offset = timezoneOffset;
    return Math.floor((date2.valueOf() / Time2.minute - offset) / 1440);
  }
  Time2.getDateNumber = getDateNumber;
  function fromDateNumber(value, offset) {
    const date2 = new Date(value * Time2.day);
    if (offset === void 0) offset = timezoneOffset;
    return new Date(+date2 + offset * Time2.minute);
  }
  Time2.fromDateNumber = fromDateNumber;
  const numeric = /\d+(?:\.\d+)?/.source;
  const timeRegExp = new RegExp(`^${[
    "w(?:eek(?:s)?)?",
    "d(?:ay(?:s)?)?",
    "h(?:our(?:s)?)?",
    "m(?:in(?:ute)?(?:s)?)?",
    "s(?:ec(?:ond)?(?:s)?)?"
  ].map((unit) => `(${numeric}${unit})?`).join("")}$`);
  function parseTime(source) {
    const capture = timeRegExp.exec(source);
    if (!capture) return 0;
    return (parseFloat(capture[1]) * Time2.week || 0) + (parseFloat(capture[2]) * Time2.day || 0) + (parseFloat(capture[3]) * Time2.hour || 0) + (parseFloat(capture[4]) * Time2.minute || 0) + (parseFloat(capture[5]) * Time2.second || 0);
  }
  Time2.parseTime = parseTime;
  function parseDate(date2) {
    const parsed = parseTime(date2);
    if (parsed) date2 = Date.now() + parsed;
    else if (/^\d{1,2}(:\d{1,2}){1,2}$/.test(date2)) date2 = `${(/* @__PURE__ */ new Date()).toLocaleDateString()}-${date2}`;
    else if (/^\d{1,2}-\d{1,2}-\d{1,2}(:\d{1,2}){1,2}$/.test(date2)) date2 = `${(/* @__PURE__ */ new Date()).getFullYear()}-${date2}`;
    return date2 ? new Date(date2) : /* @__PURE__ */ new Date();
  }
  Time2.parseDate = parseDate;
  function format(ms) {
    const abs = Math.abs(ms);
    if (abs >= Time2.day - Time2.hour / 2) return Math.round(ms / Time2.day) + "d";
    else if (abs >= Time2.hour - Time2.minute / 2) return Math.round(ms / Time2.hour) + "h";
    else if (abs >= Time2.minute - Time2.second / 2) return Math.round(ms / Time2.minute) + "m";
    else if (abs >= Time2.second) return Math.round(ms / Time2.second) + "s";
    return ms + "ms";
  }
  Time2.format = format;
  function toDigits(source, length = 2) {
    return source.toString().padStart(length, "0");
  }
  Time2.toDigits = toDigits;
  function template(template2, time = /* @__PURE__ */ new Date()) {
    return template2.replace("yyyy", time.getFullYear().toString()).replace("yy", time.getFullYear().toString().slice(2)).replace("MM", toDigits(time.getMonth() + 1)).replace("dd", toDigits(time.getDate())).replace("hh", toDigits(time.getHours())).replace("mm", toDigits(time.getMinutes())).replace("ss", toDigits(time.getSeconds())).replace("SSS", toDigits(time.getMilliseconds(), 3));
  }
  Time2.template = template;
})(Time || (Time = {}));

// node_modules/.pnpm/@deepseek-ai+schemastery@3.19.0/node_modules/@deepseek-ai/schemastery/lib/index.mjs
var kSchema = Symbol.for("schemastery");
var kValidationError = Symbol.for("ValidationError");
globalThis.__schemastery_index__ ??= 0;
globalThis.__schemastery_refs__ = void 0;
var ValidationError = class extends TypeError {
  options;
  name = "ValidationError";
  constructor(message, options) {
    let prefix = "$";
    for (const segment of options.path || []) if (typeof segment === "string") prefix += "." + segment;
    else if (typeof segment === "number") prefix += "[" + segment + "]";
    else if (typeof segment === "symbol") prefix += `[Symbol(${segment.toString()})]`;
    if (prefix.startsWith(".")) prefix = prefix.slice(1);
    super((prefix === "$" ? "" : `${prefix} `) + message);
    this.options = options;
  }
  static is(error) {
    return !!error?.[kValidationError];
  }
};
Object.defineProperty(ValidationError.prototype, kValidationError, { value: true });
var Schema = function(options) {
  const schema = function(data, options2 = {}) {
    return Schema.resolve(data, schema, options2)[0];
  };
  if (options.refs) {
    const refs = mapValues(options.refs, (options2) => new Schema(options2));
    const getRef = (uid) => refs[uid];
    for (const key in refs) {
      const options2 = refs[key];
      options2.sKey = getRef(options2.sKey);
      options2.inner = getRef(options2.inner);
      options2.list = options2.list && options2.list.map(getRef);
      options2.dict = options2.dict && mapValues(options2.dict, getRef);
    }
    return refs[options.uid];
  }
  Object.assign(schema, options);
  if (typeof schema.callback === "string") try {
    schema.callback = new Function("return " + schema.callback)();
  } catch {
  }
  Object.defineProperty(schema, "uid", { value: globalThis.__schemastery_index__++ });
  Object.setPrototypeOf(schema, Schema.prototype);
  schema.meta ||= {};
  schema.toString = schema.toString.bind(schema);
  return schema;
};
Schema.prototype = Object.create(Function.prototype);
Schema.prototype[kSchema] = true;
Object.defineProperty(Schema.prototype, "~standard", { get() {
  return {
    version: 1,
    vendor: "schemastery",
    validate: (value) => {
      try {
        return { value: Schema.resolve(value, this, {})[0] };
      } catch (error) {
        if (ValidationError.is(error)) return { issues: [{
          message: error.message,
          path: error.options.path
        }] };
        throw error;
      }
    }
  };
} });
Schema.ValidationError = ValidationError;
Schema.prototype.toJSON = function toJSON() {
  if (globalThis.__schemastery_refs__) {
    globalThis.__schemastery_refs__[this.uid] ??= JSON.parse(JSON.stringify({ ...this }));
    return this.uid;
  }
  globalThis.__schemastery_refs__ = { [this.uid]: { ...this } };
  globalThis.__schemastery_refs__[this.uid] = JSON.parse(JSON.stringify({ ...this }));
  const result = {
    uid: this.uid,
    refs: globalThis.__schemastery_refs__
  };
  globalThis.__schemastery_refs__ = void 0;
  return result;
};
Schema.prototype.set = function set(key, value) {
  this.dict[key] = value;
  return this;
};
Schema.prototype.push = function push(value) {
  this.list.push(value);
  return this;
};
function mergeDesc(original, messages) {
  const result = typeof original === "string" ? { "": original } : { ...original };
  for (const locale in messages) {
    const value = messages[locale];
    if (value?.$description || value?.$desc) result[locale] = value.$description || value.$desc;
    else if (typeof value === "string") result[locale] = value;
  }
  return result;
}
function getInner(value) {
  return value?.$value ?? value?.$inner;
}
function extractKeys(data) {
  return filterKeys(data ?? {}, (key) => !key.startsWith("$"));
}
Schema.prototype.i18n = function i18n(messages) {
  const schema = Schema(this);
  const desc = mergeDesc(schema.meta.description, messages);
  if (Object.keys(desc).length) schema.meta.description = desc;
  if (schema.dict) schema.dict = mapValues(schema.dict, (inner, key) => {
    return inner.i18n(mapValues(messages, (data) => getInner(data)?.[key] ?? data?.[key]));
  });
  if (schema.list) schema.list = schema.list.map((inner, index) => {
    return inner.i18n(mapValues(messages, (data = {}) => {
      if (Array.isArray(getInner(data))) return getInner(data)[index];
      if (Array.isArray(data)) return data[index];
      return extractKeys(data);
    }));
  });
  if (schema.inner) schema.inner = schema.inner.i18n(mapValues(messages, (data) => {
    if (getInner(data)) return getInner(data);
    return extractKeys(data);
  }));
  if (schema.sKey) schema.sKey = schema.sKey.i18n(mapValues(messages, (data) => data?.$key));
  return schema;
};
Schema.prototype.extra = function extra(key, value) {
  const schema = Schema(this);
  schema.meta = {
    ...schema.meta,
    [key]: value
  };
  return schema;
};
for (const key of [
  "required",
  "disabled",
  "collapse",
  "hidden",
  "loose"
]) Object.assign(Schema.prototype, { [key](value = true) {
  const schema = Schema(this);
  schema.meta = {
    ...schema.meta,
    [key]: value
  };
  return schema;
} });
Schema.prototype.deprecated = function deprecated() {
  const schema = Schema(this);
  schema.meta.badges ||= [];
  schema.meta.badges.push({
    text: "deprecated",
    type: "danger"
  });
  return schema;
};
Schema.prototype.experimental = function experimental() {
  const schema = Schema(this);
  schema.meta.badges ||= [];
  schema.meta.badges.push({
    text: "experimental",
    type: "warning"
  });
  return schema;
};
Schema.prototype.pattern = function pattern(regexp) {
  const schema = Schema(this);
  const pattern2 = pick(regexp, ["source", "flags"]);
  schema.meta = {
    ...schema.meta,
    pattern: pattern2
  };
  return schema;
};
Schema.prototype.simplify = function simplify(value) {
  if (isVolatile(value)) value = value.get();
  if (deepEqual(value, this.meta.default, this.type === "dict")) return null;
  if (isNullable(value)) return value;
  if (this.type === "object" || this.type === "dict") {
    const result = {};
    for (const key in value) {
      const item = (this.type === "object" ? this.dict[key] : this.inner)?.simplify(value[key]);
      if (this.type === "dict" || !isNullable(item)) result[key] = item;
    }
    if (deepEqual(result, this.meta.default, this.type === "dict")) return null;
    return result;
  } else if (this.type === "array" || this.type === "tuple") {
    const result = [];
    value.forEach((value2, index) => {
      const schema = this.type === "array" ? this.inner : this.list[index];
      const item = schema ? schema.simplify(value2) : value2;
      result.push(item);
    });
    return result;
  } else if (this.type === "intersect") {
    const result = {};
    for (const item of this.list) Object.assign(result, item.simplify(value));
    return result;
  } else if (this.type === "union") for (const schema of this.list) try {
    Schema.resolve(value, schema, {});
    return schema.simplify(value);
  } catch {
  }
  return value;
};
Schema.prototype.toString = function toString(inline) {
  return formatters[this.type]?.(this, inline) ?? `Schema<${this.type}>`;
};
Schema.prototype.role = function role(role, extra2) {
  const schema = Schema(this);
  schema.meta = {
    ...schema.meta,
    role,
    extra: extra2
  };
  return schema;
};
for (const key of [
  "default",
  "link",
  "comment",
  "description",
  "max",
  "min",
  "step"
]) Object.assign(Schema.prototype, { [key](value) {
  const schema = Schema(this);
  schema.meta = {
    ...schema.meta,
    [key]: value
  };
  return schema;
} });
Schema.prototype.volatile = function volatile() {
  if (this.meta.volatile) throw new TypeError("volatile schema is already wrapped");
  return this.extra("volatile", true);
};
var resolvers = {};
var checkedVolatile = Symbol("checked-volatile-schema");
function validateVolatileSchema(schema, path4 = [], blocked = false, seen = /* @__PURE__ */ new Map()) {
  const states = seen.get(schema) ?? /* @__PURE__ */ new Set();
  if (states.has(blocked)) return;
  states.add(blocked);
  seen.set(schema, states);
  if (schema.meta?.volatile && blocked) throw new ValidationError("volatile fields require a fixed object path without an enclosing volatile field", { path: path4 });
  const nested = blocked || !!schema.meta?.volatile;
  if (schema.dict) for (const [key, child] of Object.entries(schema.dict)) validateVolatileSchema(child, [...path4, key], nested, seen);
  if (schema.sKey) validateVolatileSchema(schema.sKey, [...path4, "<key>"], true, seen);
  if (schema.inner && (schema.type !== "lazy" || schema.inner[kSchema])) validateVolatileSchema(schema.inner, [...path4, "*"], true, seen);
  if (schema.list) for (let index = 0; index < schema.list.length; index++) validateVolatileSchema(schema.list[index], [...path4, String(index)], true, seen);
}
Schema.extend = function extend(type, resolve2) {
  resolvers[type] = resolve2;
};
Schema.resolve = function resolve(data, schema, options = {}, strict = false) {
  if (!schema) return [data];
  if (!options[checkedVolatile]) {
    validateVolatileSchema(schema, options.path);
    options = {
      ...options,
      [checkedVolatile]: true
    };
  }
  if (schema.meta?.volatile) {
    const inner = Schema(schema);
    inner.meta = {
      ...schema.meta,
      volatile: false
    };
    const [value, adapted] = Schema.resolve(data, inner, options, strict);
    try {
      return [createVolatile(value), adapted];
    } catch (error) {
      throw new ValidationError(error instanceof Error ? error.message : String(error), options);
    }
  }
  if (options.ignore?.(data, schema)) return [data];
  if (isNullable(data) && schema.type !== "lazy") {
    if (schema.meta.required) throw new ValidationError(`missing required value`, options);
    let current = schema;
    let fallback = schema.meta.default;
    while (current?.type === "intersect" && isNullable(fallback)) {
      current = current.list[0];
      fallback = current?.meta.default;
    }
    if (isNullable(fallback)) return [data];
    data = clone(fallback);
  }
  const callback = resolvers[schema.type];
  if (!callback) throw new ValidationError(`unsupported type "${schema.type}"`, options);
  try {
    return callback(data, schema, options, strict);
  } catch (error) {
    if (!schema.meta.loose) throw error;
    return [schema.meta.default];
  }
};
Schema.from = function from(source) {
  if (isNullable(source)) return Schema.any();
  else if ([
    "string",
    "number",
    "boolean"
  ].includes(typeof source)) return Schema.const(source).required();
  else if (source[kSchema]) return source;
  else if (typeof source === "function") switch (source) {
    case String:
      return Schema.string().required();
    case Number:
      return Schema.number().required();
    case Boolean:
      return Schema.boolean().required();
    case Function:
      return Schema.function().required();
    default:
      return Schema.is(source).required();
  }
  else throw new TypeError(`cannot infer schema from ${source}`);
};
Schema.lazy = function lazy(builder) {
  const toJSON2 = () => {
    if (!schema.inner[kSchema]) {
      schema.inner = schema.builder();
      schema.inner.meta = {
        ...schema.meta,
        ...schema.inner.meta
      };
    }
    return schema.inner.toJSON();
  };
  const schema = new Schema({
    type: "lazy",
    builder,
    inner: { toJSON: toJSON2 }
  });
  return schema;
};
Schema.natural = function natural() {
  return Schema.number().step(1).min(0);
};
Schema.percent = function percent() {
  return Schema.number().step(0.01).min(0).max(1).role("slider");
};
Schema.date = function date() {
  return Schema.union([Schema.is(Date), Schema.transform(Schema.string().role("datetime"), (value, options) => {
    const date2 = new Date(value);
    if (isNaN(+date2)) throw new ValidationError(`invalid date "${value}"`, options);
    return date2;
  }, true)]);
};
Schema.regExp = function regExp(flag = "") {
  return Schema.union([Schema.is(RegExp), Schema.transform(Schema.string().role("regexp", { flag }), (value, options) => {
    try {
      return new RegExp(value, flag);
    } catch (e) {
      throw new ValidationError(e.message, options);
    }
  }, true)]);
};
Schema.arrayBuffer = function arrayBuffer(encoding) {
  return Schema.union([
    Schema.is(ArrayBuffer),
    Schema.is(SharedArrayBuffer),
    Schema.transform(Schema.any(), (value, options) => {
      if (Binary.isSource(value)) return Binary.fromSource(value);
      throw new ValidationError(`expected ArrayBufferSource but got ${value}`, options);
    }, true),
    ...encoding ? [Schema.transform(Schema.string(), (value, options) => {
      try {
        return encoding === "base64" ? Binary.fromBase64(value) : Binary.fromHex(value);
      } catch (e) {
        throw new ValidationError(e.message, options);
      }
    }, true)] : []
  ]);
};
Schema.extend("lazy", (data, schema, options, strict) => {
  if (!schema.inner[kSchema]) {
    schema.inner = schema.builder();
    schema.inner.meta = {
      ...schema.meta,
      ...schema.inner.meta
    };
    validateVolatileSchema(schema.inner, options.path, true);
  }
  return Schema.resolve(data, schema.inner, options, strict);
});
Schema.extend("any", (data) => {
  return [data];
});
Schema.extend("never", (data, _, options) => {
  throw new ValidationError(`expected nullable but got ${data}`, options);
});
Schema.extend("const", (data, { value }, options) => {
  if (deepEqual(data, value)) return [value];
  throw new ValidationError(`expected ${value} but got ${data}`, options);
});
function checkWithinRange(data, meta, description, options, skipMin = false) {
  const { max = Infinity, min = -Infinity } = meta;
  if (data > max) throw new ValidationError(`expected ${description} <= ${max} but got ${data}`, options);
  if (data < min && !skipMin) throw new ValidationError(`expected ${description} >= ${min} but got ${data}`, options);
}
Schema.extend("string", (data, { meta }, options) => {
  if (typeof data !== "string") throw new ValidationError(`expected string but got ${data}`, options);
  if (meta.pattern) {
    const regexp = new RegExp(meta.pattern.source, meta.pattern.flags);
    if (!regexp.test(data)) throw new ValidationError(`expect string to match regexp ${regexp}`, options);
  }
  checkWithinRange(data.length, meta, "string length", options);
  return [data];
});
function decimalShift(data, digits) {
  const str = data.toString();
  if (str.includes("e")) return data * Math.pow(10, digits);
  const index = str.indexOf(".");
  if (index === -1) return data * Math.pow(10, digits);
  const frac = str.slice(index + 1);
  const integer = str.slice(0, index);
  if (frac.length <= digits) return +(integer + frac.padEnd(digits, "0"));
  return +(integer + frac.slice(0, digits) + "." + frac.slice(digits));
}
function isMultipleOf(data, min, step) {
  step = Math.abs(step);
  if (!/^\d+\.\d+$/.test(step.toString())) return (data - min) % step === 0;
  const index = step.toString().indexOf(".");
  const digits = step.toString().slice(index + 1).length;
  return Math.abs(decimalShift(data, digits) - decimalShift(min, digits)) % decimalShift(step, digits) === 0;
}
Schema.extend("number", (data, { meta }, options) => {
  if (typeof data !== "number") throw new ValidationError(`expected number but got ${data}`, options);
  checkWithinRange(data, meta, "number", options);
  const { step } = meta;
  if (step && !isMultipleOf(data, meta.min ?? 0, step)) throw new ValidationError(`expected number multiple of ${step} but got ${data}`, options);
  return [data];
});
Schema.extend("boolean", (data, _, options) => {
  if (typeof data === "boolean") return [data];
  throw new ValidationError(`expected boolean but got ${data}`, options);
});
Schema.extend("bitset", (data, { bits, meta }, options) => {
  let value = 0, keys = [];
  if (typeof data === "number") {
    value = data;
    for (const key in bits) if (data & bits[key]) keys.push(key);
  } else if (Array.isArray(data)) {
    keys = data;
    for (const key of keys) {
      if (typeof key !== "string") throw new ValidationError(`expected string but got ${key}`, options);
      if (key in bits) value |= bits[key];
    }
  } else throw new ValidationError(`expected number or array but got ${data}`, options);
  if (value === meta.default) return [value];
  return [value, keys];
});
Schema.extend("function", (data, _, options) => {
  if (typeof data === "function") return [data];
  throw new ValidationError(`expected function but got ${data}`, options);
});
Schema.extend("is", (data, { constructor }, options) => {
  if (typeof constructor === "function") {
    if (data instanceof constructor) return [data];
    throw new ValidationError(`expected ${constructor.name} but got ${data}`, options);
  } else {
    if (isNullable(data)) throw new ValidationError(`expected ${constructor} but got ${data}`, options);
    let prototype = Object.getPrototypeOf(data);
    while (prototype) {
      if (prototype.constructor?.name === constructor) return [data];
      prototype = Object.getPrototypeOf(prototype);
    }
    throw new ValidationError(`expected ${constructor} but got ${data}`, options);
  }
});
function property(data, key, schema, options) {
  try {
    const [value, adapted] = Schema.resolve(data[key], schema, {
      ...options,
      path: [...options.path || [], key]
    });
    if (adapted !== void 0) data[key] = adapted;
    return value;
  } catch (e) {
    if (!options?.autofix) throw e;
    delete data[key];
    return schema.meta.volatile ? createVolatile(schema.meta.default) : schema.meta.default;
  }
}
Schema.extend("array", (data, { inner, meta }, options) => {
  if (!Array.isArray(data)) throw new ValidationError(`expected array but got ${data}`, options);
  checkWithinRange(data.length, meta, "array length", options, !isNullable(inner.meta.default));
  return [data.map((_, index) => property(data, index, inner, options))];
});
Schema.extend("dict", (data, { inner, sKey }, options, strict) => {
  if (!isPlainObject(data)) throw new ValidationError(`expected object but got ${data}`, options);
  const result = {};
  for (const key in data) {
    let rKey;
    try {
      rKey = Schema.resolve(key, sKey, options)[0];
    } catch (error) {
      if (strict) continue;
      throw error;
    }
    result[rKey] = property(data, key, inner, options);
    data[rKey] = data[key];
    if (key !== rKey) delete data[key];
  }
  return [result];
});
Schema.extend("tuple", (data, { list }, options, strict) => {
  if (!Array.isArray(data)) throw new ValidationError(`expected array but got ${data}`, options);
  const result = list.map((inner, index) => property(data, index, inner, options));
  if (strict) return [result];
  result.push(...data.slice(list.length));
  return [result];
});
function merge(result, data) {
  for (const key in data) {
    if (key in result) continue;
    result[key] = data[key];
  }
}
Schema.extend("object", (data, { dict }, options, strict) => {
  if (!isPlainObject(data)) throw new ValidationError(`expected object but got ${data}`, options);
  const result = {};
  for (const key in dict) {
    const value = property(data, key, dict[key], options);
    if (!isNullable(value) || key in data) result[key] = value;
  }
  if (!strict) merge(result, data);
  return [result];
});
Schema.extend("union", (data, { list, toString: toString2 }, options, strict) => {
  const messages = [];
  for (const inner of list) try {
    return Schema.resolve(data, inner, options, strict);
  } catch (error) {
    messages.push(error);
  }
  throw new ValidationError(`expected ${toString2()} but got ${JSON.stringify(data)}`, options);
});
Schema.extend("intersect", (data, { list, toString: toString2 }, options, strict) => {
  if (!list.length) return [data];
  let result;
  for (const inner of list) {
    const value = Schema.resolve(data, inner, options, true)[0];
    if (isNullable(value)) continue;
    if (isNullable(result)) result = value;
    else if (typeof result !== typeof value) throw new ValidationError(`expected ${toString2()} but got ${JSON.stringify(data)}`, options);
    else if (typeof value === "object") merge(result ??= {}, value);
    else if (result !== value) throw new ValidationError(`expected ${toString2()} but got ${JSON.stringify(data)}`, options);
  }
  if (!strict && isPlainObject(data)) merge(result, data);
  return [result];
});
Schema.extend("transform", (data, { inner, callback, preserve }, options) => {
  const [result, adapted = data] = Schema.resolve(data, inner, options, true);
  if (preserve) return [callback(result)];
  else return [callback(result), callback(adapted)];
});
var formatters = {};
function defineMethod(name2, keys, format) {
  formatters[name2] = format;
  Object.assign(Schema, { [name2](...args) {
    const schema = new Schema({ type: name2 });
    keys.forEach((key, index) => {
      switch (key) {
        case "sKey":
          schema.sKey = args[index] ?? Schema.string();
          break;
        case "inner":
          schema.inner = Schema.from(args[index]);
          break;
        case "list":
          schema.list = args[index].map(Schema.from);
          break;
        case "dict":
          schema.dict = mapValues(args[index], Schema.from);
          break;
        case "bits":
          schema.bits = {};
          for (const key2 in args[index]) {
            if (typeof args[index][key2] !== "number") continue;
            schema.bits[key2] = args[index][key2];
          }
          break;
        case "callback": {
          const callback = schema.callback = args[index];
          callback["toJSON"] ||= () => callback.toString();
          break;
        }
        case "constructor": {
          const constructor = schema.constructor = args[index];
          if (typeof constructor === "function") constructor["toJSON"] ||= () => constructor["name"];
          break;
        }
        default:
          schema[key] = args[index];
      }
    });
    if (name2 === "object" || name2 === "dict") schema.meta.default = {};
    else if (name2 === "array" || name2 === "tuple") schema.meta.default = [];
    else if (name2 === "bitset") schema.meta.default = 0;
    return schema;
  } });
}
defineMethod("is", ["constructor"], ({ constructor }) => {
  if (typeof constructor === "function") return constructor.name;
  else return constructor;
});
defineMethod("any", [], () => "any");
defineMethod("never", [], () => "never");
defineMethod("const", ["value"], ({ value }) => typeof value === "string" ? JSON.stringify(value) : value);
defineMethod("string", [], () => "string");
defineMethod("number", [], () => "number");
defineMethod("boolean", [], () => "boolean");
defineMethod("bitset", ["bits"], () => "bitset");
defineMethod("function", [], () => "function");
defineMethod("array", ["inner"], ({ inner }) => `${inner.toString(true)}[]`);
defineMethod("dict", ["inner", "sKey"], ({ inner, sKey }) => `{ [key: ${sKey.toString()}]: ${inner.toString()} }`);
defineMethod("tuple", ["list"], ({ list }) => `[${list.map((inner) => inner.toString()).join(", ")}]`);
defineMethod("object", ["dict"], ({ dict }) => {
  if (Object.keys(dict).length === 0) return "{}";
  return `{ ${Object.entries(dict).map(([key, inner]) => {
    return `${key}${inner.meta.required ? "" : "?"}: ${inner.toString()}`;
  }).join(", ")} }`;
});
defineMethod("union", ["list"], ({ list }, inline) => {
  const result = list.map(({ toString: format }) => format()).join(" | ");
  return inline ? `(${result})` : result;
});
defineMethod("intersect", ["list"], ({ list }) => {
  return `${list.map((inner) => inner.toString(true)).join(" & ")}`;
});
defineMethod("transform", [
  "inner",
  "callback",
  "preserve"
], ({ inner }, isInner) => inner.toString(isInner));

// src/config.ts
var CONFIG_DEFAULTS = Object.freeze({
  enabled: false,
  maxAutoHandoffs: 10,
  contextWindowByModel: {},
  thresholdByModel: {},
  autoHandoff: false,
  checkpointMaxBytes: 65536,
  handoffBriefMaxChars: 4e3,
  checkpointRoot: "",
  projectProgressReserveChars: 1200,
  notifyTransferredSession: true,
  markTodosHandedOff: true,
  briefAuthor: "plugin",
  carryOriginalRequest: true
});
var CHECKPOINT_MIN = 4096;
var CHECKPOINT_MAX = 4 * 1024 * 1024;
var BRIEF_MIN = 1e3;
var BRIEF_MAX = 2e4;
var RESERVE_MAX = 8e3;
var TOKEN_THRESHOLD_MAX = 4e6;
var UNLIMITED = Object.freeze({
  checkpointMaxBytes: 0,
  handoffBriefMaxChars: 0,
  projectProgressReserveChars: -1
});
var Config = Schema.object({
  enabled: Schema.boolean().default(CONFIG_DEFAULTS.enabled).description("\u603B\u5F00\u5173\u3002false \u65F6\u4E0D\u76D1\u542C\u9884\u7B97\u3001\u4E0D\u81EA\u52A8\u6362\u7A97\uFF1B\u5DE5\u5177\u4ECD\u6CE8\u518C\uFF0C\u4F46 handoff \u4F1A\u62D2\u7EDD\u6267\u884C\u3002"),
  maxAutoHandoffs: Schema.number().min(0).max(100).default(CONFIG_DEFAULTS.maxAutoHandoffs).description("\u5355\u6B21\u63D2\u4EF6\u52A0\u8F7D\u5185\u5141\u8BB8\u7684\u81EA\u52A8\u6362\u7A97\u6B21\u6570\u4E0A\u9650\uFF080 = \u4E0D\u9650\u5236\uFF09\u3002\u9ED8\u8BA4 10\uFF1A\u672C\u5730\u5C0F\u7A97\u53E3\u6A21\u578B\u6BCF\u4E2A\u7A97\u53E3\u53EA\u80FD\u5E72 2-3 \u4E07 tokens\uFF0C\u9700\u8981\u53CD\u590D\u6362\u7A97\uFF1B\u65E9\u671F\u7248\u672C\u5199\u6B7B 1 \u6B21\uFF0C\u5BFC\u81F4\u7B2C\u4E8C\u4E2A\u7A97\u53E3\u5C31\u4E0D\u518D\u6362\u7A97\u3002"),
  // 用 z.any 而不用 z.dict：后者的推断类型会引用 cosmokit 的 Dict，导致 .d.ts 无法命名（TS2742）。
  // 真正的校验在 resolveConfig 里做（逐键检查是数字且在范围内）。
  // 按模型的百分比阈值：键为 `provider/model` 或 `model`，值 0-99（0 = 不启用该模型）。
  // 用 z.any 的原因同 contextWindowByModel（避免 cosmokit 类型进入 .d.ts）。
  thresholdByModel: Schema.any().default(CONFIG_DEFAULTS.thresholdByModel).description("\u6309\u6A21\u578B\u7684\u767E\u5206\u6BD4\u9608\u503C\uFF1A\u952E\u4E3A `provider/model` \u6216 `model`\uFF0C\u503C 0-99\uFF080 = \u8BE5\u6A21\u578B\u4E0D\u542F\u7528\uFF09\u3002\u53EA\u7BA1\u7406\u8FD9\u91CC\u5217\u51FA\u7684\u6A21\u578B\uFF1B\u6CA1\u5217\u51FA\u7684\u6A21\u578B\u63D2\u4EF6\u5B8C\u5168\u4E0D\u4ECB\u5165\u3002"),
  contextWindowByModel: Schema.any().default(CONFIG_DEFAULTS.contextWindowByModel).description("\u9010\u6A21\u578B\u8BBE\u5B9A\u771F\u5B9E\u4E0A\u4E0B\u6587\u7A97\u53E3\uFF1A\u952E\u4E3A provider/model \u6216 model\uFF0C\u503C\u4E3A\u7A97\u53E3\u5927\u5C0F\uFF080 = \u5FFD\u7565\u8BE5\u952E\uFF09\u3002\u4F18\u5148\u7EA7\u9AD8\u4E8E\u5168\u5C40\u81EA\u5B9A\u503C\u4E0E\u5173\u952E\u5B57\u5339\u914D\u3002"),
  autoHandoff: Schema.boolean().default(CONFIG_DEFAULTS.autoHandoff).description("true = \u4E34\u754C\u65F6\u81EA\u52A8\u6267\u884C \u5199\u68C0\u67E5\u70B9\u2192\u5F00\u65B0\u7A97\u2192\u6CE8\u5165\u7B80\u62A5 \u7684\u5B8C\u6574\u95ED\u73AF\uFF1Bfalse = \u53EA\u53D1 notice \u7B49\u7528\u6237\u624B\u52A8\u8C03\u7528\u5DE5\u5177\u3002"),
  notifyTransferredSession: Schema.boolean().default(CONFIG_DEFAULTS.notifyTransferredSession).description("\u6362\u7A97\u540E\u662F\u5426\u5728\u65E7\u7A97\u53E3\u4E3B\u52A8\u5F00\u4E00\u6B21\u6781\u77ED\u56DE\u590D\uFF0C\u7ACB\u523B\u663E\u793A\u300C\u4EFB\u52A1\u5DF2\u8F6C\u79FB\u300D\uFF08\u5173\u6389\u5219\u4E0D\u5524\u9192\u65E7\u4F1A\u8BDD\uFF0C\u4F46\u90A3\u6761\u63D0\u9192\u53EF\u80FD\u8981\u7B49\u5B83\u4E0B\u6B21\u5E72\u6D3B\u624D\u770B\u5F97\u5230\uFF09\u3002"),
  markTodosHandedOff: Schema.boolean().default(CONFIG_DEFAULTS.markTodosHandedOff).description('\u4EA4\u63A5\u6210\u529F\u540E\uFF0C\u628A\u65E7\u4F1A\u8BDD\u91CC\u672A\u5B8C\u6210\u7684\u5F85\u529E\u6807\u8BB0\u4E3A\u5DF2\u5B8C\u6210\uFF08\u907F\u514D\u65E7\u7A97\u53E3\u4E00\u76F4\u6302\u7740"\u8FDB\u884C\u4E2D"\u7684\u5047\u4EFB\u52A1\uFF09\u3002'),
  checkpointMaxBytes: Schema.number().min(0).max(CHECKPOINT_MAX).default(CONFIG_DEFAULTS.checkpointMaxBytes).description("\u68C0\u67E5\u70B9 JSON \u7684 UTF-8 \u5B57\u8282\u4E0A\u9650\uFF1B0 = \u4E0D\u9650\u5236\u3002\u8D85\u9650\u5148\u88C1\u526A\u5185\u5BB9\uFF0C\u4ECD\u8D85\u9650\u5219\u5199\u5165\u5931\u8D25\u4E14\u4E0D\u6362\u7A97\uFF08fail-closed\uFF09\u3002"),
  handoffBriefMaxChars: Schema.number().min(0).max(BRIEF_MAX).default(CONFIG_DEFAULTS.handoffBriefMaxChars).description("\u6CE8\u5165\u65B0\u4F1A\u8BDD\u9996\u8F6E\u7684\u4EA4\u63A5\u7B80\u62A5\u5B57\u7B26\u4E0A\u9650\uFF1B0 = \u4E0D\u9650\u5236\uFF08\u6309\u6700\u8BE6\u7EC6\u6863\u6E32\u67D3\uFF0C\u4E0D\u88C1\u526A\uFF09\u3002"),
  checkpointRoot: Schema.string().default(CONFIG_DEFAULTS.checkpointRoot).description("\u53EF\u9009\u3002\u68C0\u67E5\u70B9\u6839\u76EE\u5F55\uFF1B\u7559\u7A7A\u8868\u793A ${DSH_HOME}/task-checkpoints/orchestrator\uFF08\u4E0E dsh-task-checkpoint-guard \u540C\u6839\uFF09\u3002"),
  projectProgressReserveChars: Schema.number().min(UNLIMITED.projectProgressReserveChars).max(RESERVE_MAX).default(CONFIG_DEFAULTS.projectProgressReserveChars).description("\u53EF\u9009\u3002\u4ECE handoffBriefMaxChars \u4E2D\u9884\u7559\u7ED9 PROGRESS.md \u9879\u76EE\u7EA7\u6458\u8981\u7684\u5B57\u7B26\u6570\uFF1B0 = \u4E0D\u6CE8\u5165\uFF1B-1 = \u4E0D\u9650\u5236\uFF08\u4E0D\u88C1\u526A\u3001\u4E5F\u4E0D\u5360\u7B80\u62A5\u9884\u7B97\uFF09\u3002"),
  carryOriginalRequest: Schema.boolean().default(CONFIG_DEFAULTS.carryOriginalRequest).description("\u4EA4\u63A5\u65F6\u628A\u300C\u539F\u59CB\u9700\u6C42\u300D\u539F\u6587\u4E00\u8DEF\u5E26\u8FDB\u68C0\u67E5\u70B9\u4E0E\u7B80\u62A5\uFF08\u9ED8\u8BA4\u5F00\uFF09\u3002\u5173\u6389\u540E\u540E\u7EED\u7A97\u53E3\u53EA\u80FD\u770B\u5230\u8FDB\u5EA6\uFF0C\u5BB9\u6613\u504F\u79BB\u539F\u59CB\u76EE\u6807\u3002"),
  briefAuthor: Schema.string().default(CONFIG_DEFAULTS.briefAuthor).description("\u7B80\u62A5\u7531\u8C01\u5199\uFF1A'plugin' = \u63D2\u4EF6\u6309\u6A21\u677F\u4ECE\u7ED3\u6784\u5316\u4E8B\u5B9E\u751F\u6210\uFF08\u9ED8\u8BA4\uFF0C\u786E\u5B9A\u6027\u3001\u96F6\u989D\u5916\u8C03\u7528\uFF09\uFF1B'model' = \u6362\u7A97\u524D\u8BA9\u6A21\u578B\u5199\u4E00\u4EFD\u53D9\u8FF0\u6027\u7B80\u62A5\uFF08\u591A\u4E00\u6B21\u6A21\u578B\u8C03\u7528\uFF0C\u5931\u8D25\u81EA\u52A8\u56DE\u9000\u6A21\u677F\uFF09\u3002")
});
var isFiniteNumber = (value) => typeof value === "number" && Number.isFinite(value);
function resolveConfig(raw) {
  const input = raw === void 0 || raw === null ? {} : raw;
  if (typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("dsh-infinite-context-orchestrator: config must be an object");
  }
  let parsed;
  try {
    parsed = Config(input);
  } catch (error) {
    throw new TypeError(`dsh-infinite-context-orchestrator: invalid config \u2014 ${String(error?.message ?? error)}`);
  }
  const merged = { ...CONFIG_DEFAULTS, ...parsed ?? {} };
  const issues = [];
  const allowedOrSentinel = (value, sentinel, min, max) => {
    if (!isFiniteNumber(value)) return false;
    if (value === sentinel) return true;
    return value >= min && value <= max;
  };
  if (typeof merged.notifyTransferredSession !== "boolean") issues.push("notifyTransferredSession must be a boolean");
  if (!isFiniteNumber(merged.maxAutoHandoffs) || merged.maxAutoHandoffs < 0 || merged.maxAutoHandoffs > 100) {
    issues.push("maxAutoHandoffs must be 0 (unlimited) or an integer in [0, 100]");
  } else {
    merged.maxAutoHandoffs = Math.round(merged.maxAutoHandoffs);
  }
  const byModelRaw = merged.contextWindowByModel;
  const byModel = {};
  if (byModelRaw !== void 0 && byModelRaw !== null) {
    if (typeof byModelRaw !== "object" || Array.isArray(byModelRaw)) {
      issues.push("contextWindowByModel must be an object mapping model keys to numbers");
    } else {
      for (const [key, value] of Object.entries(byModelRaw)) {
        if (!isFiniteNumber(value) || value < 0 || value > TOKEN_THRESHOLD_MAX) {
          issues.push("contextWindowByModel[] must be 0 or a number in [0, ]");
        } else {
          byModel[key] = value;
        }
      }
    }
  }
  merged.contextWindowByModel = byModel;
  const thresholdRaw = merged.thresholdByModel;
  const thresholdMap = {};
  if (thresholdRaw !== void 0 && thresholdRaw !== null) {
    if (typeof thresholdRaw !== "object" || Array.isArray(thresholdRaw)) {
      issues.push("thresholdByModel must be an object mapping model keys to percentages");
    } else {
      for (const [key, value] of Object.entries(thresholdRaw)) {
        if (!isFiniteNumber(value) || value < 0 || value > 99) {
          issues.push(`thresholdByModel[${key}] must be 0 (disabled) or a number in [0, 99]`);
        } else {
          thresholdMap[key] = value;
        }
      }
    }
  }
  merged.thresholdByModel = thresholdMap;
  if (typeof merged.enabled !== "boolean") issues.push("enabled must be a boolean");
  if (typeof merged.autoHandoff !== "boolean") issues.push("autoHandoff must be a boolean");
  if (typeof merged.markTodosHandedOff !== "boolean") issues.push("markTodosHandedOff must be a boolean");
  if (typeof merged.checkpointRoot !== "string") issues.push("checkpointRoot must be a string");
  if (typeof merged.carryOriginalRequest !== "boolean") issues.push("carryOriginalRequest must be a boolean");
  if (typeof merged.briefAuthor !== "string" || !["plugin", "model"].includes(merged.briefAuthor)) {
    issues.push("briefAuthor must be 'plugin' or 'model'");
  }
  if (!allowedOrSentinel(merged.checkpointMaxBytes, 0, CHECKPOINT_MIN, CHECKPOINT_MAX)) {
    issues.push(`checkpointMaxBytes must be 0 (unlimited) or a number in [${CHECKPOINT_MIN}, ${CHECKPOINT_MAX}]`);
  } else if (merged.checkpointMaxBytes > 0) {
    merged.checkpointMaxBytes = Math.round(merged.checkpointMaxBytes);
  }
  if (!allowedOrSentinel(merged.handoffBriefMaxChars, 0, BRIEF_MIN, BRIEF_MAX)) {
    issues.push(`handoffBriefMaxChars must be 0 (unlimited) or a number in [${BRIEF_MIN}, ${BRIEF_MAX}]`);
  } else if (merged.handoffBriefMaxChars > 0) {
    merged.handoffBriefMaxChars = Math.round(merged.handoffBriefMaxChars);
  }
  if (!allowedOrSentinel(merged.projectProgressReserveChars, -1, 0, RESERVE_MAX)) {
    issues.push(`projectProgressReserveChars must be -1 (default) or a number in [0, ${RESERVE_MAX}]`);
  } else if (merged.projectProgressReserveChars >= 0) {
    merged.projectProgressReserveChars = Math.round(merged.projectProgressReserveChars);
  }
  if (issues.length > 0) {
    throw new TypeError(`dsh-infinite-context-orchestrator: invalid config \u2014 ${issues.join("; ")}`);
  }
  return {
    ...merged,
    checkpointMaxBytes: Math.round(merged.checkpointMaxBytes),
    handoffBriefMaxChars: Math.round(merged.handoffBriefMaxChars),
    projectProgressReserveChars: Math.round(merged.projectProgressReserveChars)
  };
}

// src/extract.ts
import { existsSync as existsSync2 } from "node:fs";
import path2 from "node:path";
var SCAN_LIMIT = 800;
var MAX_ITEM = 200;
var MAX_LAST_REQUEST = 600;
var CONSTRAINT_PATTERN = /(必须|不要|禁止|务必|一律|只能|不能|不得|至少|最多|记住|约定|约束|must\b|never\b|always\b|do not\b|don't\b|avoid\b|require)/i;
function clip2(text, max) {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, Math.max(0, max - 1))}\u2026`;
}
function messageText(message) {
  const blocks = message?.content;
  if (!Array.isArray(blocks)) return "";
  return blocks.filter((block) => block?.type === "text" && typeof block.text === "string").map((block) => block.text).join("\n").trim();
}
function readEvents(session) {
  try {
    const events = typeof session?.snapshotEvents === "function" ? session.snapshotEvents() : [];
    if (!Array.isArray(events)) return [];
    return events.length > SCAN_LIMIT ? events.slice(events.length - SCAN_LIMIT) : events;
  } catch {
    return [];
  }
}
function stateOf(ctx, session, key) {
  try {
    const projections = ctx.get("sessionProjections");
    if (session === void 0) return void 0;
    return projections?.stateOf?.(session, key);
  } catch {
    return void 0;
  }
}
function normalizeGoal(value) {
  if (typeof value === "string") return value.trim();
  if (value === null || typeof value !== "object") return "";
  const record = value;
  const nested = record.goal;
  for (const candidate of [
    record.objective,
    nested?.objective,
    record.title,
    nested?.title,
    record.text,
    nested?.text
  ]) {
    if (typeof candidate === "string" && candidate.trim().length > 0) return candidate.trim();
  }
  return "";
}
function normalizeTodos(value) {
  const list = Array.isArray(value) ? value : Array.isArray(value?.todos) ? value.todos : Array.isArray(value?.items) ? value.items : [];
  const out = [];
  for (const raw of list) {
    if (raw === null || typeof raw !== "object") continue;
    const record = raw;
    const text = [record.content, record.title, record.text, record.subject].find((candidate) => typeof candidate === "string" && candidate.trim().length > 0);
    if (text === void 0) continue;
    const status = typeof record.status === "string" ? record.status.toLowerCase() : "pending";
    out.push({ text: text.trim(), status });
  }
  return out;
}
function isCompleted(status) {
  return ["completed", "complete", "done", "finished", "cancelled", "canceled"].includes(status);
}
function isActive(status) {
  return ["pending", "in_progress", "active", "todo", "open", "blocked"].includes(status);
}
function originalRequest(events) {
  const candidates = [];
  for (const event of events) {
    if (event?.type !== "user/message") continue;
    const message = event.data;
    if (message?.source?.kind !== "user") continue;
    const text = messageText(message).trim();
    if (text.length === 0) continue;
    candidates.push({ text, source: String(event.sessionId ?? "") });
  }
  const long = candidates.find((item) => item.text.length >= 200);
  return long ?? candidates[0] ?? { text: "", source: "" };
}
function lastHumanRequest(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== "user/message") continue;
    const message = event.data;
    if (message?.source?.kind !== "user") continue;
    const text = messageText(message);
    if (text.length > 0) return clip2(text, MAX_LAST_REQUEST);
  }
  return "";
}
function constraintStatements(events) {
  const found = [];
  const seen = /* @__PURE__ */ new Set();
  for (let index = events.length - 1; index >= 0 && found.length < 4; index -= 1) {
    const event = events[index];
    if (event?.type !== "user/message") continue;
    const message = event.data;
    if (message?.source?.kind !== "user") continue;
    const text = messageText(message);
    if (text.length === 0 || !CONSTRAINT_PATTERN.test(text)) continue;
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.replace(/^[-*\d.\s]+/, "").trim();
      if (trimmed.length < 6 || !CONSTRAINT_PATTERN.test(trimmed)) continue;
      const item = clip2(trimmed, MAX_ITEM);
      if (seen.has(item)) continue;
      seen.add(item);
      found.unshift(`\uFF08\u7528\u6237\u7EA6\u675F\uFF09${item}`);
      if (found.length >= 4) break;
    }
  }
  return found;
}
function recentAssistantConclusions(events, limit = 3) {
  const out = [];
  for (let index = events.length - 1; index >= 0 && out.length < limit; index -= 1) {
    const event = events[index];
    if (event?.type !== "assistant/message") continue;
    const payload = event.data;
    const text = messageText(payload?.message);
    if (text.length === 0) continue;
    out.unshift(`\uFF08\u81EA\u52A8\u6458\u5F55\uFF0C\u672A\u7ECF\u786E\u8BA4\uFF09${clip2(text.split(/\r?\n/)[0] ?? text, MAX_ITEM)}`);
  }
  return out;
}
function workspacePointers(cwd) {
  if (typeof cwd !== "string" || cwd.length === 0) return [];
  const notes = [];
  const candidates = [
    ["PROGRESS.md\uFF08dsh-project-progress \u9879\u76EE\u8FDB\u5C55\uFF09", path2.join(cwd, "PROGRESS.md")],
    ["context-relay \u6EDA\u52A8\u8FDB\u5EA6", path2.join(cwd, ".scratch", "context-relay", "progress.md")],
    ["context-relay \u53EC\u56DE\u7D22\u5F15", path2.join(cwd, ".scratch", "context-relay", "chain.ndjson")]
  ];
  for (const [label, file] of candidates) {
    try {
      if (existsSync2(file)) notes.push(`${label}\uFF1A${file}`);
    } catch {
    }
  }
  return notes;
}
function cwdOf(agent) {
  const cwd = agent?.session?.header?.cwd;
  return typeof cwd === "string" && cwd.length > 0 ? cwd : void 0;
}
function collectFacts(ctx, agent) {
  const session = agent?.session;
  const events = readEvents(session);
  const goalFromProjection = normalizeGoal(stateOf(ctx, session, "goal"));
  const goal = goalFromProjection.length > 0 ? clip2(goalFromProjection, MAX_ITEM * 2) : clip2(lastHumanRequest(events), MAX_ITEM * 2);
  const todos = normalizeTodos(stateOf(ctx, session, "todos"));
  const done = todos.filter((item) => isCompleted(item.status)).map((item) => clip2(item.text, MAX_ITEM));
  const pending = todos.filter((item) => isActive(item.status)).map((item) => clip2(item.text, MAX_ITEM));
  const keyDecisions = constraintStatements(events);
  return {
    goal,
    done: done.length > 0 ? done : recentAssistantConclusions(events),
    pending_todos: pending,
    key_decisions: keyDecisions,
    last_human_request: lastHumanRequest(events),
    original_request: originalRequest(events).text,
    original_request_source: originalRequest(events).source,
    notes: workspacePointers(cwdOf(agent)),
    allTodos: todos
  };
}

// src/handoff.ts
import { randomUUID as randomUUID2 } from "node:crypto";

// src/brief.ts
import { existsSync as existsSync3, readFileSync as readFileSync2 } from "node:fs";
import path3 from "node:path";
var FACTS_HEADER = "## \u9879\u76EE\u6863\u6848";
var TIMELINE_HEADER = "## \u8FDB\u5C55\u65F6\u95F4\u7EBF";
var LEVELS = [
  { items: 10, field: 200, request: 600 },
  { items: 7, field: 160, request: 400 },
  { items: 5, field: 120, request: 300 },
  { items: 3, field: 90, request: 200 },
  { items: 1, field: 70, request: 120 }
];
function clip3(text, max) {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, Math.max(0, max - 1))}\u2026`;
}
function bullet(items, level, emptyText) {
  if (items.length === 0) return `- ${emptyText}`;
  const shown = items.slice(0, level.items).map((item) => `- ${clip3(item, level.field)}`);
  if (items.length > level.items) shown.push(`- \u2026\uFF08\u53E6\u6709 ${items.length - level.items} \u9879\uFF0C\u89C1\u68C0\u67E5\u70B9\u6587\u4EF6\uFF09`);
  return shown.join("\n");
}
function readProjectProgressSummary(cwd, maxChars) {
  if (typeof cwd !== "string" || cwd.length === 0 || maxChars <= 0) return "";
  const file = path3.join(cwd, "PROGRESS.md");
  if (!existsSync3(file)) return "";
  let text;
  try {
    text = readFileSync2(file, "utf-8");
  } catch {
    return "";
  }
  const factsIndex = text.indexOf(FACTS_HEADER);
  const timelineIndex = text.indexOf(TIMELINE_HEADER);
  const facts = factsIndex >= 0 ? text.slice(factsIndex + FACTS_HEADER.length, timelineIndex > factsIndex ? timelineIndex : void 0).trim() : text.trim();
  const timeline = timelineIndex >= 0 ? text.slice(timelineIndex + TIMELINE_HEADER.length).trim() : "";
  const factsPart = facts.length > 0 ? `${FACTS_HEADER}
${clip3(facts, Math.floor(maxChars * 0.45))}` : "";
  const remaining = Math.max(0, maxChars - factsPart.length - TIMELINE_HEADER.length - 4);
  const timelinePart = timeline.length > 0 && remaining > 40 ? `${TIMELINE_HEADER}\uFF08\u6700\u8FD1\uFF09
\u2026${clip3(timeline.slice(Math.max(0, timeline.length - remaining)), remaining)}` : "";
  return [factsPart, timelinePart].filter((part) => part.length > 0).join("\n\n");
}
var UNLIMITED_LEVEL = { items: Number.POSITIVE_INFINITY, field: Number.POSITIVE_INFINITY, request: Number.POSITIVE_INFINITY };
var UNLIMITED_PROJECT_CHARS = 2e4;
var ANCHOR_HEADING = /^\s*\*\*(待办|检查点文件|相关工作区文件)\*\*/;
function stripAnchorSections(text) {
  const out = [];
  let skipping = false;
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const isHeading = /^\s*\*\*[^*]+\*\*/.test(line);
    if (isHeading && ANCHOR_HEADING.test(line)) {
      skipping = true;
      continue;
    }
    if (isHeading && skipping) skipping = false;
    if (!skipping) out.push(line);
  }
  return out.join("\n").trim();
}
function originalRequestSection(facts, limit) {
  const text = String(facts.original_request ?? "").trim();
  if (text.length === 0) return [];
  const clipped = limit > 0 && text.length > limit ? `${text.slice(0, limit)}
\u2026\uFF08\u539F\u6587\u5171 ${text.length} \u5B57\u7B26\uFF0C\u5DF2\u6309\u9884\u7B97\u622A\u65AD\uFF09` : text;
  return [
    "## \u539F\u59CB\u9700\u6C42",
    "\uFF08\u4EE5\u4E0B\u4E3A\u6700\u521D\u7684\u9700\u6C42\u539F\u6587\uFF0C\u4F9B\u6838\u5BF9\uFF1B\u540E\u7EED\u5BF9\u8BDD\u53EF\u80FD\u4FEE\u6539\u6216\u65B0\u589E\u9700\u6C42\uFF0C\u4EE5\u8F83\u65B0\u7684\u4E3A\u51C6\u3002\uFF09",
    clipped,
    ""
  ];
}
function renderModelAuthoredBrief(modelText, facts, checkpointPath, options) {
  const unlimited = options.maxChars <= 0;
  const budget = Math.max(1, options.maxChars);
  const header = [
    "## \u4EFB\u52A1\u4EA4\u63A5\u7B80\u62A5",
    "\u4F60\u6B63\u5728\u63A5\u624B\u4E00\u4E2A\u56E0\u4E0A\u4E0B\u6587\u63A5\u8FD1\u4E34\u754C\u70B9\u800C\u6362\u7A97\u7684\u4EFB\u52A1\u3002"
  ];
  if (typeof options.occupancyLine === "string" && options.occupancyLine.length > 0) {
    header.push(`\uFF08\u6362\u7A97\u65F6\u4E0A\u4E0B\u6587\u5360\u7528\uFF1A${options.occupancyLine}\uFF09`);
  }
  const level = { items: 12, field: 200, request: 600 };
  const anchors = [
    "**\u5F85\u529E**\uFF1A",
    bullet(facts.pending_todos, level, "\uFF08\u672C\u7A97\u53E3\u6CA1\u6709\u7559\u4E0B\u5F85\u529E\uFF1A\u6309\u300C\u5DF2\u5B8C\u6210\u300D\u7684\u8FDB\u5EA6\u4E0E\u300C\u539F\u59CB\u9700\u6C42\u300D\u63A8\u65AD\u4E0B\u4E00\u9879\uFF0C\u76F4\u63A5\u7EE7\u7EED\u505A\uFF1B\u4E0D\u8981\u56E0\u4E3A\u5F85\u529E\u4E3A\u7A7A\u5C31\u505C\u4E0B\u6765\u95EE\u7528\u6237\uFF09"),
    "**\u68C0\u67E5\u70B9\u6587\u4EF6**\uFF1A" + checkpointPath,
    "",
    "\u8BF7\u4ECE\u201C\u5F85\u529E\u201D\u7684\u7B2C\u4E00\u9879\u7EE7\u7EED\uFF1B\u5F85\u529E\u4E3A\u7A7A\u65F6\u6309\u300C\u5DF2\u5B8C\u6210\u300D\u4E0E\u300C\u539F\u59CB\u9700\u6C42\u300D\u7EE7\u7EED\u63A8\u8FDB\uFF0C\u4E0D\u8981\u505C\u4E0B\u6765\u7B49\u7528\u6237\u786E\u8BA4\u3002\u4E0D\u8981\u91CD\u65B0\u5F00\u59CB\u5DF2\u5B8C\u6210\u7684\u5DE5\u4F5C\u3002"
  ];
  const fixed = [...header, ...anchors].join("\n");
  const body = stripAnchorSections(modelText);
  if (body.length === 0) {
    return { text: fixed, chars: fixed.length, hasProjectSummary: false, truncated: true };
  }
  if (unlimited) {
    const appendix = originalRequestSection(facts, 0);
    const text2 = [...header, body, "", ...anchors, ...appendix.length > 0 ? ["", ...appendix] : []].join("\n");
    return { text: text2, chars: text2.length, hasProjectSummary: false, truncated: false };
  }
  const room = budget - fixed.length - 8;
  if (room <= 40) {
    return { text: fixed, chars: fixed.length, hasProjectSummary: false, truncated: true };
  }
  const clippedBody = body.length <= room ? body : `${body.slice(0, Math.max(0, room - 24))}
\u2026\uFF08\u6A21\u578B\u5C0F\u8282\u5DF2\u6309\u9884\u7B97\u622A\u65AD\uFF0C\u5B8C\u6574\u5185\u5BB9\u89C1\u68C0\u67E5\u70B9\uFF09`;
  const text = [...header, clippedBody, "", ...anchors].join("\n");
  return { text, chars: text.length, hasProjectSummary: false, truncated: clippedBody !== body };
}
function renderHandoffBrief(facts, checkpointPath, options) {
  const unlimitedBrief = options.maxChars <= 0;
  const unlimitedProject = options.projectProgressReserveChars < 0;
  const budget = Math.max(1, options.maxChars);
  const cap25 = Math.floor(budget * 0.25);
  const projectLimit = unlimitedProject ? UNLIMITED_PROJECT_CHARS : Math.max(0, Math.min(options.projectProgressReserveChars, cap25));
  const build = (level, projectText) => {
    const lines = [
      "## \u4EFB\u52A1\u4EA4\u63A5\u7B80\u62A5",
      "\u4F60\u6B63\u5728\u63A5\u624B\u4E00\u4E2A\u56E0\u4E0A\u4E0B\u6587\u63A5\u8FD1\u4E34\u754C\u70B9\u800C\u6362\u7A97\u7684\u4EFB\u52A1\u3002"
    ];
    if (typeof options.occupancyLine === "string" && options.occupancyLine.length > 0) {
      lines.push(`\uFF08\u6362\u7A97\u65F6\u4E0A\u4E0B\u6587\u5360\u7528\uFF1A${options.occupancyLine}\uFF09`);
    }
    lines.push(...originalRequestSection(facts, unlimitedBrief ? 0 : Math.floor(budget * 0.5)));
    lines.push(
      "**\u5F53\u524D\u76EE\u6807**\uFF1A" + (facts.goal.length > 0 ? clip3(facts.goal, level.field * 2) : "\uFF08\u672A\u8BB0\u5F55\uFF0C\u8BF7\u5148\u5411\u7528\u6237\u786E\u8BA4\u76EE\u6807\uFF09"),
      "**\u5DF2\u5B8C\u6210**\uFF1A",
      bullet(facts.done, level, "\uFF08\u65E0\u8BB0\u5F55\uFF09"),
      "**\u5F85\u529E**\uFF1A",
      bullet(facts.pending_todos, level, "\uFF08\u672C\u7A97\u53E3\u6CA1\u6709\u7559\u4E0B\u5F85\u529E\uFF1A\u6309\u300C\u5DF2\u5B8C\u6210\u300D\u7684\u8FDB\u5EA6\u4E0E\u300C\u539F\u59CB\u9700\u6C42\u300D\u63A8\u65AD\u4E0B\u4E00\u9879\uFF0C\u76F4\u63A5\u7EE7\u7EED\u505A\uFF1B\u4E0D\u8981\u56E0\u4E3A\u5F85\u529E\u4E3A\u7A7A\u5C31\u505C\u4E0B\u6765\u95EE\u7528\u6237\uFF09"),
      "**\u5173\u952E\u51B3\u7B56/\u7EA6\u675F**\uFF1A",
      bullet(facts.key_decisions, level, "\uFF08\u65E0\u8BB0\u5F55\uFF09"),
      "**\u6700\u540E\u4E00\u6761\u4EBA\u7C7B\u8BF7\u6C42**\uFF1A" + (facts.last_human_request.length > 0 ? clip3(facts.last_human_request, level.request) : "\uFF08\u672A\u8BB0\u5F55\uFF09"),
      "**\u68C0\u67E5\u70B9\u6587\u4EF6**\uFF1A" + checkpointPath
    );
    if (facts.notes.length > 0) {
      lines.push("**\u76F8\u5173\u5DE5\u4F5C\u533A\u6587\u4EF6**\uFF1A", bullet(facts.notes, level, ""));
    }
    if (projectText.length > 0) {
      lines.push("", "## \u9879\u76EE\u7EA7\u6458\u8981\uFF08\u6765\u81EA dsh-project-progress \u7684 PROGRESS.md\uFF09", projectText);
    }
    lines.push("", "\u8BF7\u4ECE\u201C\u5F85\u529E\u201D\u7684\u7B2C\u4E00\u9879\u7EE7\u7EED\u3002\u4E0D\u8981\u91CD\u65B0\u5F00\u59CB\u5DF2\u5B8C\u6210\u7684\u5DE5\u4F5C\u3002");
    return lines.join("\n");
  };
  if (unlimitedBrief) {
    const projectText = readProjectProgressSummary(options.cwd, projectLimit);
    const text2 = build(UNLIMITED_LEVEL, projectText);
    return { text: text2, chars: text2.length, hasProjectSummary: projectText.length > 0, truncated: false };
  }
  for (const level of LEVELS) {
    const isCoarsest = level === LEVELS[LEVELS.length - 1];
    const projectText = isCoarsest ? "" : readProjectProgressSummary(options.cwd, projectLimit);
    const bodyText = build(level, "");
    const text2 = projectText.length > 0 ? build(level, projectText) : bodyText;
    const measured = unlimitedProject ? bodyText.length : text2.length;
    if (measured <= options.maxChars) {
      return {
        text: text2,
        chars: text2.length,
        hasProjectSummary: projectText.length > 0,
        truncated: level !== LEVELS[0]
      };
    }
  }
  const tail = `

\u2026\uFF08\u7B80\u62A5\u5DF2\u6309 handoffBriefMaxChars=${options.maxChars} \u622A\u65AD\uFF1B\u5B8C\u6574\u5185\u5BB9\u8BF7\u8BFB\u68C0\u67E5\u70B9\u6587\u4EF6\uFF1A${checkpointPath}\uFF09
\u8BF7\u4ECE\u201C\u5F85\u529E\u201D\u7684\u7B2C\u4E00\u9879\u7EE7\u7EED\u3002\u4E0D\u8981\u91CD\u65B0\u5F00\u59CB\u5DF2\u5B8C\u6210\u7684\u5DE5\u4F5C\u3002`;
  const head = build(LEVELS[LEVELS.length - 1], "").slice(0, Math.max(0, options.maxChars - tail.length));
  const text = `${head}${tail}`;
  return { text, chars: text.length, hasProjectSummary: false, truncated: true };
}

// src/redact.ts
var MASK = "[REDACTED]";
var RULES = [
  // PEM 私钥整块
  {
    pattern: /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]{0,40}PRIVATE KEY-----/g,
    replacement: "[REDACTED_PRIVATE_KEY]"
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
    replacement: `$1${MASK}`
  },
  // ENV 风格：SOME_TOKEN=abcdef...
  {
    pattern: /\b([A-Z][A-Z0-9_]{2,}(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL))\s*=\s*([^\s"'`]{6,})/g,
    replacement: `$1=${MASK}`
  }
];
function redactHomePath(text, home) {
  if (typeof home !== "string" || home.length < 4) return text;
  const escaped = home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(escaped, "gi"), "~");
}
function redactText(input, options = {}) {
  if (typeof input !== "string" || input.length === 0) return "";
  const limit = options.maxChars ?? 2e5;
  let text = input.length > limit ? `${input.slice(0, limit)}
\u2026\uFF08\u672C\u5B57\u6BB5\u8D85\u8FC7 ${limit} \u5B57\u7B26\uFF0C\u5DF2\u622A\u65AD\uFF09` : input;
  for (const rule of RULES) text = text.replace(rule.pattern, rule.replacement);
  const home = options.home ?? process.env.USERPROFILE ?? process.env.HOME;
  if (typeof home === "string" && home.length > 0) text = redactHomePath(text, home);
  return text;
}
function redactValue(value, options = {}, depth = 0) {
  if (depth > 8) return "[DEPTH_LIMIT]";
  if (typeof value === "string") return redactText(value, options);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, options, depth + 1));
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = redactValue(item, options, depth + 1);
    return out;
  }
  return value;
}

// src/brief-model.ts
var MIN_ACCEPT_CHARS = 40;
var MAX_MATERIAL_CHARS = 24e3;
var MIN_MAX_TOKENS = 800;
var MAX_MAX_TOKENS = 4e3;
var SYSTEM_PROMPT = [
  '\u4F60\u6B63\u5728\u4E3A"\u4E0A\u4E0B\u6587\u6362\u7A97"\u5199\u4E00\u4EFD\u4EA4\u63A5\u7B80\u62A5\uFF0C\u8BFB\u8005\u662F\u63A5\u624B\u8FD9\u4E2A\u4EFB\u52A1\u7684\u53E6\u4E00\u4E2A\u6A21\u578B\u3002',
  "\u5B83\u770B\u4E0D\u5230\u5F53\u524D\u5BF9\u8BDD\uFF0C\u53EA\u6709\u4F60\u5199\u7684\u8FD9\u4EFD\u7B80\u62A5\uFF0C\u4EE5\u53CA\u4E00\u4EFD\u7ED3\u6784\u5316\u68C0\u67E5\u70B9\u6587\u4EF6\u3002",
  "",
  "\u8BF7\u6309\u4E0B\u9762\u7684\u5C0F\u8282\u8F93\u51FA\uFF0C\u4E0D\u8981\u8F93\u51FA\u5176\u5B83\u5185\u5BB9\uFF0C\u4E0D\u8981\u5199\u5BD2\u6684\uFF1A",
  "**\u9700\u6C42**\uFF1A\u7B80\u8981\u6982\u62EC\u8FD9\u4E2A\u9879\u76EE\u8981\u505A\u4EC0\u4E48\uFF08\u53EF\u53C2\u8003\u7D20\u6750\u91CC\u7684\u539F\u59CB\u9700\u6C42\uFF1B\u82E5\u540E\u7EED\u5BF9\u8BDD\u4FEE\u6539\u6216\u65B0\u589E\u4E86\u9700\u6C42\uFF0C\u4EE5\u8F83\u65B0\u7684\u4E3A\u51C6\uFF0C\u5E76\u6CE8\u660E\u4E0E\u539F\u59CB\u9700\u6C42\u7684\u5DEE\u5F02\uFF09\u3002",
  "**\u5F53\u524D\u76EE\u6807**\uFF1A\u8BF4\u660E\u5F53\u524D\u8FD9\u4E00\u8F6E\u8981\u8FBE\u6210\u7684\u76EE\u6807\u3002",
  "**\u5DF2\u5B8C\u6210**\uFF1A\u9010\u6761\u5217\u51FA\u5DF2\u5B8C\u6210\u7684\u5DE5\u4F5C\u4E0E\u7ED3\u8BBA\uFF0C\u5199\u6E05\u505A\u4E86\u4EC0\u4E48\u3001\u7ED3\u679C\u662F\u4EC0\u4E48\u3002",
  "**\u5173\u952E\u51B3\u7B56/\u7EA6\u675F**\uFF1A\u9010\u6761\u5217\u51FA\u4E3A\u4EC0\u4E48\u8FD9\u6837\u505A\u3001\u54EA\u4E9B\u4E0D\u80FD\u52A8\u3002",
  "**\u63A5\u4E0B\u6765\u8BE5\u505A\u4EC0\u4E48**\uFF1A\u6309\u987A\u5E8F\u5217\u51FA\u4E0B\u4E00\u6B65\u7684\u5177\u4F53\u52A8\u4F5C\u3002",
  "",
  "\u89C4\u5219\uFF1A",
  '- \u53EA\u5199\u7D20\u6750\u91CC\u51FA\u73B0\u8FC7\u7684\u4E8B\u5B9E\uFF1B\u6CA1\u6709\u4F9D\u636E\u7684\u5185\u5BB9\u4E0D\u8981\u7F16\u9020\uFF0C\u5B81\u53EF\u5199"\u672A\u8BB0\u5F55"\u3002',
  "- \u4E0D\u8981\u590D\u8FF0\u5BC6\u94A5\u3001\u53E3\u4EE4\u3001\u5B8C\u6574\u6587\u4EF6\u5185\u5BB9\uFF1B\u8DEF\u5F84\u548C\u547D\u4EE4\u540D\u53EF\u4EE5\u5199\u3002",
  '- \u7528\u4E2D\u6587\uFF0C\u7948\u4F7F\u53E5/\u9648\u8FF0\u53E5\uFF0C\u4E0D\u8981\u7528"\u6211\u4EEC""\u6211\u60F3"\u8FD9\u7C7B\u4E3B\u89C2\u53E3\u543B\u3002'
].join("\n");
function clip4(text, max) {
  const flat = String(text ?? "");
  return flat.length <= max ? flat : `${flat.slice(0, Math.max(0, max - 1))}\u2026`;
}
function messageText2(message) {
  const blocks = message?.content;
  if (!Array.isArray(blocks)) return "";
  return blocks.filter((block) => block?.type === "text" && typeof block.text === "string").map((block) => String(block.text)).join("\n").trim();
}
function resolveRoute(ctx, agent) {
  try {
    const header = typeof agent?.session?.requestHeader === "function" ? agent.session.requestHeader() : void 0;
    const provider = header?.config?.provider;
    const model = header?.config?.model;
    if (typeof provider === "string" && typeof model === "string" && provider.length > 0 && model.length > 0) {
      return { provider, model };
    }
  } catch {
  }
  try {
    const selection = ctx.get("agentDefaultModel")?.currentSelection?.();
    if (typeof selection?.provider === "string" && typeof selection?.model === "string") {
      return { provider: selection.provider, model: selection.model };
    }
  } catch {
  }
  return void 0;
}
function buildMaterial(agent, request) {
  const facts = request.facts;
  const list = (items, empty) => items.length === 0 ? empty : items.map((item) => `- ${item}`).join("\n");
  const lines = [
    "# \u7ED3\u6784\u5316\u4E8B\u5B9E\uFF08\u6765\u81EA\u7A0B\u5E8F\uFF0C\u53EF\u4FE1\uFF09",
    `\u76EE\u6807\uFF1A${facts.goal.length > 0 ? facts.goal : "\uFF08\u672A\u8BB0\u5F55\uFF09"}`,
    "\u672A\u5B8C\u6210\u7684\u5F85\u529E\uFF08\u82E5\u4E3A\u7A7A\uFF1A\u8BF7\u6309\u5DF2\u5B8C\u6210\u8FDB\u5EA6\u4E0E\u539F\u59CB\u9700\u6C42\u63A8\u65AD\u4E0B\u4E00\u6B65\uFF0C\u4E0D\u8981\u5EFA\u8BAE\u505C\u4E0B\u6765\u95EE\u7528\u6237\uFF09\uFF1A",
    list(facts.pending_todos, "\uFF08\u65E0\u8BB0\u5F55\uFF09"),
    "\u5DF2\u5B8C\u6210\uFF1A",
    list(facts.done, "\uFF08\u65E0\u8BB0\u5F55\uFF09"),
    "\u7528\u6237\u660E\u786E\u63D0\u51FA\u7684\u7EA6\u675F\uFF1A",
    list(facts.key_decisions, "\uFF08\u65E0\u8BB0\u5F55\uFF09"),
    `\u6700\u540E\u4E00\u6761\u4EBA\u7C7B\u8BF7\u6C42\uFF1A${facts.last_human_request.length > 0 ? facts.last_human_request : "\uFF08\u672A\u8BB0\u5F55\uFF09"}`,
    ...request.occupancyLine === void 0 ? [] : [`\u6362\u7A97\u65F6\u4E0A\u4E0B\u6587\u5360\u7528\uFF1A${request.occupancyLine}`],
    `\u68C0\u67E5\u70B9\u6587\u4EF6\uFF1A${request.checkpointPath}`,
    "",
    ...facts.original_request.trim().length === 0 ? [] : ["", "# \u539F\u59CB\u9700\u6C42\uFF08\u7D20\u6750\uFF1A\u6700\u521D\u7684\u9700\u6C42\u539F\u6587\uFF0C\u4F9B\u4F60\u603B\u7ED3\uFF1B\u540E\u7EED\u53EF\u80FD\u5DF2\u53D8\u66F4\uFF09", facts.original_request],
    "",
    "# \u6700\u8FD1\u7684\u5BF9\u8BDD\uFF08\u53EA\u542B\u6587\u672C\u6D88\u606F\u4E0E\u5DE5\u5177\u540D\uFF09"
  ];
  let events = [];
  try {
    const raw = typeof agent?.session?.snapshotEvents === "function" ? agent.session.snapshotEvents() : [];
    events = Array.isArray(raw) ? raw : [];
  } catch {
    events = [];
  }
  const transcript = [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === "user/message") {
      const message = event.data;
      const text = messageText2(message);
      if (text.length === 0) continue;
      const tag = message?.source?.kind === "user" ? "user" : "plugin-notice";
      transcript.unshift(`[${tag}] ${clip4(text, 600)}`);
    } else if (event?.type === "assistant/message") {
      const payload = event.data;
      const text = messageText2(payload?.message);
      if (text.length === 0) continue;
      transcript.unshift(`[assistant] ${clip4(text, 800)}`);
    } else if (event?.type === "tool/call") {
      const payload = event.data;
      const name2 = typeof payload?.name === "string" ? payload.name : "tool";
      transcript.unshift(`[tool] ${name2}`);
    }
    if (transcript.join("\n").length > MAX_MATERIAL_CHARS) break;
  }
  const budget = MAX_MATERIAL_CHARS - lines.join("\n").length;
  const tail = transcript.join("\n");
  lines.push(tail.length === 0 ? "\uFF08\u65E0\uFF09" : clip4(tail.slice(Math.max(0, tail.length - Math.max(0, budget))), Math.max(0, budget)));
  return clip4(lines.join("\n"), MAX_MATERIAL_CHARS);
}
async function requestModelBrief(ctx, agent, request) {
  const llm = ctx.get("llm");
  if (llm === void 0 || typeof llm.stream !== "function") return { ok: false, reason: "llm \u670D\u52A1\u4E0D\u53EF\u7528" };
  const route = resolveRoute(ctx, agent);
  if (route === void 0) return { ok: false, reason: "\u62FF\u4E0D\u5230\u4F1A\u8BDD\u7684 provider/model" };
  const budgetChars = request.maxChars > 0 ? request.maxChars : MAX_MAX_TOKENS * 2;
  const maxTokens = Math.max(MIN_MAX_TOKENS, Math.min(MAX_MAX_TOKENS, Math.ceil(budgetChars / 2)));
  try {
    const stream = llm.stream({
      provider: route.provider,
      model: route.model,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: [{ type: "text", text: buildMaterial(agent, request) }] }],
      maxTokens,
      temperature: 0.2,
      ...request.signal === void 0 ? {} : { signal: request.signal }
    });
    let text = "";
    const hardCap = Math.max(budgetChars * 2, 2e3);
    for await (const chunk of stream) {
      if (chunk?.type === "text-delta" && typeof chunk.text === "string") {
        text += chunk.text;
        if (text.length > hardCap) break;
      }
      if (chunk?.type === "finish") {
        const kind = chunk.reason?.kind;
        if (kind === "error" || kind === "aborted") {
          return { ok: false, reason: `\u6A21\u578B\u8C03\u7528\u5931\u8D25\uFF08${chunk.reason?.failure?.code ?? kind}\uFF09` };
        }
      }
    }
    const cleaned = redactText(text.trim()).trim();
    if (cleaned.length < MIN_ACCEPT_CHARS) return { ok: false, reason: "\u6A21\u578B\u8FD4\u56DE\u5185\u5BB9\u8FC7\u77ED" };
    return { ok: true, text: clip4(cleaned, hardCap) };
  } catch (error) {
    return { ok: false, reason: String(error?.message ?? error).slice(0, 200) };
  }
}

// src/handoff.ts
var PLUGIN_KIND = "dsh-infinite-context-orchestrator";
var DEFAULT_MAX_AUTO_HANDOFFS = 10;
function createState() {
  return {
    inFlight: false,
    autoHandoffs: 0,
    fired: /* @__PURE__ */ new Map(),
    armed: /* @__PURE__ */ new Set(),
    pendingBriefs: /* @__PURE__ */ new Map(),
    firstStepWatch: /* @__PURE__ */ new Map()
  };
}
function errorText(error) {
  return String(error?.message ?? error).slice(0, 400);
}
function logWarn(message) {
  try {
    console.warn(`[dsh-infinite-context-orchestrator] ${message}`);
  } catch {
  }
}
function noticeMessage(text, summary) {
  return {
    role: "user",
    id: randomUUID2(),
    content: [{ type: "text", text: String(text) }],
    source: { kind: PLUGIN_KIND, form: "notice", summary: String(summary).slice(0, 120) }
  };
}
function isSubagentSession(session) {
  const header = session?.header;
  if (header === void 0 || header === null) return false;
  if (header.origin === "subagent") return true;
  return typeof header.delegationDepth === "number" && header.delegationDepth > 0;
}
function wait(ms) {
  return new Promise((resolve2) => setTimeout(resolve2, ms));
}
async function waitForLive(ctx, sessionId) {
  const agents = ctx.get("agents");
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const direct = agents?.get?.(sessionId);
      if (direct !== void 0) return direct;
      const found = agents?.list?.().find((candidate) => candidate?.session?.id === sessionId);
      if (found !== void 0) return found;
    } catch {
    }
    await wait(50);
  }
  return void 0;
}
var workspaceRegistryAccessor;
function setWorkspaceRegistryAccessor(accessor) {
  workspaceRegistryAccessor = accessor;
}
function readWorkspaceList() {
  try {
    const registry = workspaceRegistryAccessor?.();
    const list = typeof registry?.list === "function" ? registry.list() : void 0;
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}
function callerWorkspaceId(_ctx, sessionId, cwd) {
  const list = readWorkspaceList();
  const idOf = (workspace) => {
    const raw = workspace.workspaceId ?? workspace.id;
    return typeof raw === "string" && raw.length > 0 ? raw : void 0;
  };
  for (const workspace of list) {
    const ids = Array.isArray(workspace.sessionIds) ? workspace.sessionIds.map(String) : [];
    if (ids.includes(sessionId)) return idOf(workspace);
  }
  if (cwd !== void 0) {
    const normalize = (value) => value.replace(/[\\/]+$/, "").toLowerCase();
    const target = normalize(cwd);
    for (const workspace of list) {
      if (typeof workspace.path === "string" && normalize(workspace.path) === target) return idOf(workspace);
    }
  }
  return void 0;
}
async function createNewSession(ctx, caller, cwd) {
  const preset = caller?.session?.header?.agentPreset;
  const callerSessionId = typeof caller?.session?.id === "string" ? caller.session.id : "";
  const workspaceId = callerSessionId === "" ? void 0 : callerWorkspaceId(ctx, callerSessionId, cwd);
  const agentPreset = typeof preset === "string" && preset.length > 0 ? preset : void 0;
  const controller = ctx.get("sessionController");
  try {
    if (controller !== void 0 && typeof controller.create === "function") {
      const created = await controller.create({
        // workspaceId 与 cwd 互斥：优先加入原分组，拿不到才用 cwd 自建。
        ...workspaceId === void 0 ? cwd === void 0 ? {} : { cwd } : { workspaceId },
        ...agentPreset === void 0 ? {} : { agentPreset }
      });
      const sessionId2 = typeof created?.sessionId === "string" ? created.sessionId : "";
      if (sessionId2.length === 0) {
        return { ok: false, message: "sessionController.create \u6CA1\u6709\u8FD4\u56DE sessionId" };
      }
      return { ok: true, session: { sessionId: sessionId2, via: "sessionController.create", live: await waitForLive(ctx, sessionId2) } };
    }
    const agents = ctx.get("agents");
    const presets = ctx.get("agentPresets");
    if (agents === void 0 || typeof agents.create !== "function" || presets === void 0 || typeof presets.mount !== "function") {
      return { ok: false, message: "sessionController \u4E0E agents/agentPresets \u90FD\u4E0D\u53EF\u7528\uFF0C\u65E0\u6CD5\u521B\u5EFA\u65B0\u4F1A\u8BDD" };
    }
    const sessionId = `session-${randomUUID2()}`;
    const handle = await agents.create({
      sessionId,
      meta: { ...cwd === void 0 ? {} : { cwd }, ...agentPreset === void 0 ? {} : { agentPreset } },
      setup: async (agentCtx) => presets.mount?.(agentCtx, agentPreset)
    });
    const live = handle?.agent ?? await waitForLive(ctx, sessionId);
    return { ok: true, session: { sessionId, via: "agents.create", live } };
  } catch (error) {
    return { ok: false, message: `\u521B\u5EFA\u65B0\u4F1A\u8BDD\u5931\u8D25\uFF1A${errorText(error)}` };
  }
}
function disposeHalfCreated(ctx, sessionId) {
  try {
    const agents = ctx.get("agents");
    agents?.get?.(sessionId)?.dispose?.();
  } catch {
  }
}
function markHandedOffTodos(session, todos) {
  const target = session;
  if (target === void 0 || typeof target.append !== "function") return false;
  if (todos.length === 0) return false;
  try {
    target.append("todo/write", {
      todos: todos.map((item) => ({ content: item.text, status: "completed" }))
    });
    return true;
  } catch (error) {
    logWarn(`\u65E7\u4F1A\u8BDD\u5F85\u529E\u6536\u5C3E\u5931\u8D25\uFF08\u4E0D\u5F71\u54CD\u4EA4\u63A5\uFF09\uFF1A${errorText(error)}`);
    return false;
  }
}
function factsCwd(caller) {
  const header = caller?.session?.header;
  if (typeof header?.cwd === "string" && header.cwd.length > 0) return header.cwd;
  return cwdOf(caller) ?? "";
}
function buildCheckpoint(caller, facts, occupancy, thresholdPercent, extraNote) {
  const redacted = redactValue(facts);
  const header = caller?.session?.header;
  const notes = [
    ...redacted.notes,
    ...typeof extraNote === "string" && extraNote.trim().length > 0 ? [`\u4EA4\u63A5\u539F\u56E0\uFF1A${extraNote.trim()}`] : []
  ];
  return {
    version: 1,
    plugin: PLUGIN_KIND,
    createdAt: (/* @__PURE__ */ new Date()).toISOString(),
    sessionId: String(caller?.session?.id ?? ""),
    ...typeof header?.parentSession === "string" ? { parentSession: header.parentSession } : {},
    ...typeof header?.agentPreset === "string" ? { agentPreset: header.agentPreset } : {},
    ...typeof header?.cwd === "string" ? { cwd: header.cwd } : {},
    goal: redacted.goal,
    done: redacted.done,
    pending_todos: redacted.pending_todos,
    key_decisions: redacted.key_decisions,
    last_human_request: redacted.last_human_request,
    ...redacted.original_request.trim().length === 0 ? {} : {
      original_request: redacted.original_request,
      original_request_source: redacted.original_request_source,
      original_request_chars: redacted.original_request.length
    },
    checkpoint_path: "",
    occupancy: {
      ...occupancy.usedTokens === void 0 ? {} : { usedTokens: Math.round(occupancy.usedTokens) },
      ...occupancy.windowTokens === void 0 ? {} : { windowTokens: Math.round(occupancy.windowTokens) },
      ...occupancy.percent === void 0 ? {} : { percent: occupancy.percent },
      thresholdPercent,
      source: occupancy.source
    },
    ...notes.length === 0 ? {} : { notes }
  };
}
async function performHandoff(deps, caller, origin, extraNote) {
  const { ctx, config, state, root } = deps;
  if (state.inFlight) {
    return { ok: false, code: "busy", message: "\u5DF2\u6709\u4E00\u4E2A handoff \u6B63\u5728\u6267\u884C\uFF0C\u672C\u6B21\u8DF3\u8FC7\u3002", summary: "refused: handoff already in flight" };
  }
  const maxAuto = config.maxAutoHandoffs ?? DEFAULT_MAX_AUTO_HANDOFFS;
  if (origin === "auto" && maxAuto > 0 && state.autoHandoffs >= maxAuto) {
    return {
      ok: false,
      code: "rate-limited",
      message: `\u672C\u6B21\u63D2\u4EF6\u52A0\u8F7D\u5185\u5DF2\u81EA\u52A8\u6362\u7A97 ${state.autoHandoffs} \u6B21\uFF08\u4E0A\u9650 ${maxAuto}\uFF09\uFF0C\u4E0D\u518D\u81EA\u52A8\u6362\u7A97\uFF1B\u9700\u8981\u65F6\u8BF7\u624B\u52A8\u8C03\u7528 infinite_context_handoff\uFF0C\u6216\u91CD\u542F DSH \u91CD\u7F6E\u8BA1\u6570\uFF08\u4E5F\u53EF\u5728\u8BBE\u7F6E\u91CC\u8C03\u5927\u300C\u81EA\u52A8\u6362\u7A97\u6B21\u6570\u4E0A\u9650\u300D\uFF09\u3002`,
      summary: "refused: auto handoff rate limit"
    };
  }
  state.inFlight = true;
  try {
    const sessionId = String(caller?.session?.id ?? "");
    const cwd = cwdOf(caller);
    const occupancy = await measureOccupancy(ctx, caller, windowConfigOf(config));
    const facts = collectFacts(ctx, caller);
    if (facts.original_request.trim().length === 0 && config.carryOriginalRequest) {
      const inherited = findOriginalRequest(root, factsCwd(caller));
      if (inherited !== void 0) {
        facts.original_request = inherited.text;
        facts.original_request_source = inherited.source;
      }
    }
    if (config.carryOriginalRequest && facts.original_request.trim().length > 0) {
      writeRequirementFile(root, factsCwd(caller), facts.original_request, facts.original_request_source);
    }
    const doc = buildCheckpoint(caller, facts, occupancy, resolvePolicy(config, caller.session).thresholdPercent, extraNote);
    let written;
    try {
      written = await writeCheckpoint(root, doc, config.checkpointMaxBytes);
    } catch (error) {
      const reason = error instanceof CheckpointWriteError ? error.message : errorText(error);
      const message2 = `\u68C0\u67E5\u70B9\u5199\u5165\u5931\u8D25\uFF0C\u5DF2\u53D6\u6D88\u6362\u7A97\uFF08fail-closed\uFF0C\u5F53\u524D\u4F1A\u8BDD\u4E0D\u53D7\u5F71\u54CD\uFF09\uFF1A${reason}`;
      notifyCaller(ctx, caller, `\u3010\u4EFB\u52A1\u81EA\u52A8\u6362\u7A97\u3011${message2}
\u68C0\u67E5\u70B9\u6839\u76EE\u5F55\uFF1A${root}`, "[infinite-context] checkpoint write failed, handoff aborted");
      return { ok: false, code: "checkpoint-write-failed", message: message2, summary: `fail-closed: checkpoint write failed (${reason})`, occupancy };
    }
    const briefOptions = {
      maxChars: config.handoffBriefMaxChars,
      projectProgressReserveChars: config.projectProgressReserveChars,
      ...cwd === void 0 ? {} : { cwd },
      occupancyLine: formatOccupancy(occupancy)
    };
    let brief = renderHandoffBrief(facts, written.checkpointPath, briefOptions);
    let briefAuthoredBy = "plugin";
    let briefFallbackReason;
    let modelBriefText;
    if (config.briefAuthor === "model") {
      const attempt = await requestModelBrief(ctx, caller, {
        facts,
        checkpointPath: written.checkpointPath,
        occupancyLine: briefOptions.occupancyLine,
        maxChars: config.handoffBriefMaxChars
      });
      if (attempt.ok && typeof attempt.text === "string") {
        modelBriefText = attempt.text;
        brief = renderModelAuthoredBrief(attempt.text, facts, written.checkpointPath, briefOptions);
        briefAuthoredBy = "model";
      } else {
        briefFallbackReason = attempt.reason;
        logWarn(`\u3010\u4EFB\u52A1\u81EA\u52A8\u6362\u7A97\u3011\u6A21\u578B\u64B0\u5199\u7B80\u62A5\u5931\u8D25\uFF0C\u5DF2\u56DE\u9000\u5230\u6A21\u677F\uFF1A${attempt.reason ?? "\u672A\u77E5\u539F\u56E0"}`);
      }
    }
    const created = await createNewSession(ctx, caller, cwd);
    if (created.ok === false) {
      const message2 = `${created.message}
\u68C0\u67E5\u70B9\u5DF2\u4FDD\u7559\uFF0C\u9700\u8981\u65F6\u624B\u52A8\u5F15\u7528\uFF1A${written.checkpointPath}`;
      notifyCaller(ctx, caller, `\u3010\u4EFB\u52A1\u81EA\u52A8\u6362\u7A97\u3011\u65B0\u4F1A\u8BDD\u521B\u5EFA\u5931\u8D25\uFF0C\u4FDD\u6301\u5728\u5F53\u524D\u4F1A\u8BDD\u3002
${message2}`, "[infinite-context] session create failed, checkpoint kept");
      return {
        ok: false,
        code: "session-create-failed",
        message: message2,
        checkpointPath: written.checkpointPath,
        briefChars: brief.chars,
        summary: "session creation failed; checkpoint kept for manual reference",
        occupancy
      };
    }
    const { sessionId: newSessionId, via, live } = created.session;
    const pending = {
      sessionId: newSessionId,
      createdAt: Date.now(),
      text: brief.text,
      checkpointPath: written.checkpointPath,
      sourceSessionId: sessionId
    };
    const firstTodo = facts.pending_todos[0];
    const anchorText = firstTodo === void 0 ? "\u4EA4\u63A5\u951A\u70B9\uFF1A\u672C\u7A97\u53E3\u6CA1\u6709\u7559\u4E0B\u5F85\u529E\u3002\u6309\u5DF2\u5B8C\u6210\u8FDB\u5EA6\u4E0E\u539F\u59CB\u9700\u6C42\u7EE7\u7EED\u63A8\u8FDB\uFF0C\u4E0D\u8981\u505C\u4E0B\u6765\u95EE\u7528\u6237\uFF1B\u4E0D\u8981\u91CD\u505A\u5DF2\u5B8C\u6210\u7684\u90E8\u5206\u3001\u4E0D\u8981\u81EA\u884C\u6269\u5927\u8303\u56F4\u3002" : `\u4EA4\u63A5\u951A\u70B9\uFF1A\u672C\u6B21\u4EA4\u63A5\u7684\u7B2C\u4E00\u6B65\u662F\u300C${firstTodo}\u300D\u3002\u5148\u628A\u5B83\u505A\u5B8C\uFF0C\u518D\u505A\u5176\u5B83\uFF1B\u4E0D\u8981\u91CD\u590D\u5DF2\u5B8C\u6210\u7684\u5DE5\u4F5C\u3002`;
    const anchorVia = "brief-prefix";
    if (anchorVia === "brief-prefix") {
      const prefix = `## \u4EA4\u63A5\u951A\u70B9
${anchorText}

`;
      if (config.handoffBriefMaxChars > 0) {
        const reduced = Math.max(200, config.handoffBriefMaxChars - prefix.length);
        const reducedOptions = { ...briefOptions, maxChars: reduced };
        brief = modelBriefText === void 0 ? renderHandoffBrief(facts, written.checkpointPath, reducedOptions) : renderModelAuthoredBrief(modelBriefText, facts, written.checkpointPath, reducedOptions);
      }
      pending.text = prefix + brief.text;
    }
    let briefPersisted = true;
    try {
      await savePendingBrief(root, pending);
    } catch (error) {
      briefPersisted = false;
      void error;
    }
    state.pendingBriefs.set(newSessionId, pending);
    if (firstTodo !== void 0) {
      state.firstStepWatch.set(newSessionId, { todo: firstTodo, at: Date.now(), corrected: false });
    }
    const pointer = [
      `\u5DF2\u6309\u4EA4\u63A5\u68C0\u67E5\u70B9\u5B8C\u6210\u6362\u7A97\uFF08\u68C0\u67E5\u70B9\uFF1A${written.checkpointPath}\uFF09\u3002`,
      "\u4EA4\u63A5\u7B80\u62A5\u5DF2\u6CE8\u5165\u672C\u8F6E\u7CFB\u7EDF\u63D0\u793A\u7684\u524D\u90E8\uFF1B\u8BF7\u5148\u8BFB\u201C\u5F85\u529E\u201D\uFF0C\u4ECE\u7B2C\u4E00\u9879\u7EE7\u7EED\uFF0C\u4E0D\u8981\u91CD\u65B0\u5F00\u59CB\u5DF2\u5B8C\u6210\u7684\u5DE5\u4F5C\u3002",
      "\u5982\u679C\u7B80\u62A5\u7F3A\u5C11\u5173\u952E\u4FE1\u606F\uFF0C\u76F4\u63A5\u8BFB\u4E0A\u9762\u7684\u68C0\u67E5\u70B9\u6587\u4EF6\u8865\u9F50\u3002"
    ].join("\n");
    const followup = live?.followup;
    if (typeof followup !== "function") {
      disposeHalfCreated(ctx, newSessionId);
      state.pendingBriefs.delete(newSessionId);
      clearPendingBrief(root, newSessionId);
      const message2 = [
        `\u65B0\u4F1A\u8BDD ${newSessionId} \u5DF2\u521B\u5EFA\uFF0C\u4F46\u5B83\u7684 agent \u6CA1\u6709\u5728 ~1s \u5185\u53D8\u4E3A live\uFF0C\u9996\u6761\u6D88\u606F\u6CA1\u6709\u53D1\u51FA\u53BB\u3002`,
        `\u68C0\u67E5\u70B9\u5DF2\u4FDD\u7559\uFF1A${written.checkpointPath}`,
        "\u4F60\u53EF\u4EE5\u624B\u52A8\u6253\u5F00\u8BE5\u4F1A\u8BDD\uFF0C\u6216\u91CD\u65B0\u8C03\u7528 infinite_context_handoff\u3002"
      ].join("\n");
      notifyCaller(ctx, caller, `\u3010\u4EFB\u52A1\u81EA\u52A8\u6362\u7A97\u3011${message2}`, "[infinite-context] new session not live, checkpoint kept");
      return {
        ok: false,
        code: "session-not-live",
        message: message2,
        checkpointPath: written.checkpointPath,
        newSessionId,
        summary: "session created but never became live; checkpoint kept",
        occupancy
      };
    }
    try {
      followup.call(live, noticeMessage(pointer, "[infinite-context] \u4EA4\u63A5\u5B8C\u6210\uFF0C\u65B0\u4F1A\u8BDD\u5DF2\u6CE8\u5165\u4EA4\u63A5\u7B80\u62A5"));
    } catch (error) {
      disposeHalfCreated(ctx, newSessionId);
      state.pendingBriefs.delete(newSessionId);
      clearPendingBrief(root, newSessionId);
      const message2 = `\u65B0\u4F1A\u8BDD\u5DF2\u521B\u5EFA\u4F46\u9996\u6761\u6D88\u606F\u53D1\u9001\u5931\u8D25\uFF08${errorText(error)}\uFF09\u3002\u68C0\u67E5\u70B9\u5DF2\u4FDD\u7559\uFF1A${written.checkpointPath}`;
      notifyCaller(ctx, caller, `\u3010\u4EFB\u52A1\u81EA\u52A8\u6362\u7A97\u3011${message2}`, "[infinite-context] followup failed, checkpoint kept");
      return {
        ok: false,
        code: "followup-failed",
        message: message2,
        checkpointPath: written.checkpointPath,
        newSessionId,
        summary: "first prompt failed to dispatch; checkpoint kept",
        occupancy
      };
    }
    const todosMarked = config.markTodosHandedOff ? markHandedOffTodos(caller?.session, facts.allTodos) : false;
    try {
      const titles = ctx.get("sessionTitle");
      const goal = facts.goal.replace(/\s+/g, " ").trim();
      titles?.rename?.(live?.session, `\u4EA4\u63A5 \xB7 ${goal.length > 30 ? `${goal.slice(0, 30)}\u2026` : goal || newSessionId.slice(0, 12)}`);
    } catch {
    }
    if (origin === "auto") state.autoHandoffs += 1;
    state.armed.add(newSessionId);
    state.fired.delete(newSessionId);
    state.lastHandoff = {
      at: Date.now(),
      origin,
      sessionId,
      newSessionId,
      checkpointPath: written.checkpointPath,
      briefChars: brief.chars
    };
    const message = [
      `\u6362\u7A97\u5B8C\u6210\uFF08${via}\uFF09\u3002`,
      `\u65B0\u4F1A\u8BDD\uFF1A${newSessionId}`,
      `\u68C0\u67E5\u70B9\uFF1A${written.checkpointPath}\uFF08${written.bytes}B${written.trimmed ? "\uFF0C\u5DF2\u6309\u4F53\u79EF\u4E0A\u9650\u88C1\u526A" : ""}\uFF09`,
      `\u7B80\u62A5\uFF1A${brief.chars} \u5B57\u7B26${brief.hasProjectSummary ? "\uFF08\u542B\u9879\u76EE\u7EA7\u6458\u8981\uFF09" : ""}${briefPersisted ? "" : "\uFF1B\u6CE8\u610F\uFF1A\u7B80\u62A5\u6587\u4EF6\u843D\u76D8\u5931\u8D25\uFF0C\u672C\u6B21\u4EC5\u5185\u5B58\u6CE8\u5165"}`,
      `\u7B80\u62A5\u6765\u6E90\uFF1A${briefAuthoredBy === "model" ? "\u6A21\u578B\u64B0\u5199" : "\u63D2\u4EF6\u6A21\u677F"}${briefFallbackReason === void 0 ? "" : `\uFF08\u6A21\u578B\u64B0\u5199\u5931\u8D25\u5DF2\u56DE\u9000\uFF1A${briefFallbackReason}\uFF09`}`,
      `\u4EA4\u63A5\u951A\u70B9\uFF1A\u5DF2\u62FC\u5728\u7B80\u62A5\u6700\u524D\u9762\uFF08\u968F system prompt \u4E00\u8D77\u6CE8\u5165\uFF09${firstTodo === void 0 ? "" : `\uFF0C\u7B2C\u4E00\u4EF6\u4E8B\uFF1A${firstTodo}`}`,
      `\u5360\u7528\uFF1A${formatOccupancy(occupancy)}`,
      // 旧窗口的待办默认会被收尾（标成已完成），否则它会一直挂着"进行中"的假任务，
      // 让人以为交接没成功。关掉开关时如实说明"仍显示为未完成"。
      facts.pending_todos.length === 0 ? "\u672C\u7A97\u53E3\u7684\u5F85\u529E\u5217\u8868\uFF1A\u7A7A\uFF08\u6CA1\u6709\u9700\u8981\u8F6C\u79FB\u7684\u4EFB\u52A1\uFF09\u3002" : todosMarked ? `\u672C\u7A97\u53E3\u7684 ${facts.pending_todos.length} \u9879\u5F85\u529E\u5DF2\u6807\u8BB0\u4E3A\u5DF2\u5B8C\u6210\uFF08\u5185\u5BB9\u5DF2\u968F\u4EA4\u63A5\u5199\u5165\u65B0\u4F1A\u8BDD\uFF09\uFF1B\u672C\u7A97\u53E3\u53EF\u4EE5\u5173\u95ED\u3002` : `\u672C\u7A97\u53E3\u7684 ${facts.pending_todos.length} \u9879\u5F85\u529E\u5DF2\u968F\u4EA4\u63A5\u5199\u5165\u65B0\u4F1A\u8BDD\uFF0C\u4F46\u4ECD\u663E\u793A\u4E3A\u672A\u5B8C\u6210\uFF08\u53EF\u5728\u8BBE\u7F6E \u2192 \u9AD8\u7EA7\u91CC\u5F00\u542F\u300C\u4EA4\u63A5\u540E\u6536\u5C3E\u65E7\u5F85\u529E\u300D\uFF09\uFF1B\u672C\u7A97\u53E3\u53EF\u4EE5\u76F4\u63A5\u5173\u95ED\u3002`
    ].join("\n");
    const transferVia = notifyTransferred(ctx, caller, config, message, newSessionId, written.checkpointPath);
    cancelCallerTurn(ctx, String(caller?.session?.id ?? ""));
    return {
      ok: true,
      code: "ok",
      message,
      checkpointPath: written.checkpointPath,
      newSessionId,
      briefChars: brief.chars,
      briefAuthoredBy,
      ...briefFallbackReason === void 0 ? {} : { briefFallbackReason },
      anchorVia,
      todosMarked,
      transferVia,
      occupancy,
      summary: `handoff ok \u2192 ${newSessionId}`
    };
  } finally {
    state.inFlight = false;
  }
}
function cancelCallerTurn(ctx, sessionId) {
  try {
    const controller = ctx.get("sessionController");
    if (controller === void 0 || typeof controller.cancel !== "function") return;
    void Promise.resolve(controller.cancel({ sessionId })).catch(() => void 0);
  } catch (error) {
    logWarn(`\u53EB\u505C\u65E7\u4F1A\u8BDD\u5931\u8D25\uFF08\u4E0D\u5F71\u54CD\u4EA4\u63A5\uFF09\uFF1A${errorText(error)}`);
  }
}
function notifyTransferred(ctx, caller, config, detail, newSessionId, checkpointPath) {
  const banner = [
    "\u3010\u4EFB\u52A1\u81EA\u52A8\u6362\u7A97\u3011\u672C\u7A97\u53E3\u7684\u4EFB\u52A1\u5DF2\u8F6C\u79FB\u5230\u65B0\u4F1A\u8BDD\u3002",
    `\u65B0\u4F1A\u8BDD\uFF1A${newSessionId}`,
    `\u68C0\u67E5\u70B9\uFF1A${checkpointPath}`,
    "\u8BF7\u5230\u65B0\u4F1A\u8BDD\u7EE7\u7EED\uFF1B\u672C\u7A97\u53E3\u53EA\u7528\u4E8E\u56DE\u987E\u3002\u4E0D\u8981\u5728\u8FD9\u91CC\u7EE7\u7EED\u6267\u884C\u5DE5\u4F5C\u3001\u4E0D\u8981\u8C03\u7528\u5DE5\u5177\uFF0C\u56DE\u4E00\u53E5\u300C\u5DF2\u4EA4\u63A5\u300D\u5373\u53EF\u3002",
    "",
    "\u2014 \u672C\u6B21\u6362\u7A97\u660E\u7EC6 \u2014",
    detail
  ].join("\n");
  const summary = "[infinite-context] \u4EFB\u52A1\u5DF2\u8F6C\u79FB\u5230\u65B0\u4F1A\u8BDD\uFF0C\u672C\u7A97\u53E3\u53EA\u7528\u4E8E\u56DE\u987E";
  if (!config.notifyTransferredSession) return "inject";
  if (appendUserNotice(caller, banner, summary)) return "inject";
  notifyCaller(ctx, caller, banner, summary);
  return "inject";
}
function appendUserNotice(caller, text, summary) {
  const session = caller?.session;
  if (session === void 0 || typeof session.append !== "function") return false;
  try {
    session.append("user/message", noticeMessage(text, summary), { surfaceOp: "append" });
    return true;
  } catch (error) {
    logWarn(`\u65E7\u7A97\u53E3\u63D0\u793A\u5199\u5165\u4F1A\u8BDD\u65E5\u5FD7\u5931\u8D25\uFF1A${errorText(error)}`);
    return false;
  }
}
function notifyCaller(ctx, caller, text, summary) {
  void ctx;
  try {
    if (typeof caller?.inject === "function") caller.inject(noticeMessage(text, summary));
  } catch {
  }
}
function checkpointRootOf(config) {
  return resolveCheckpointRoot(config.checkpointRoot);
}

// src/timeout.ts
async function withTimeout(task, timeoutMs) {
  const promise = Promise.resolve(task);
  return await new Promise((resolve2) => {
    const timer = setTimeout(() => resolve2(void 0), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve2(value);
      },
      () => {
        clearTimeout(timer);
        resolve2(void 0);
      }
    );
  });
}
function safeCall(thunk) {
  try {
    return thunk();
  } catch {
    return void 0;
  }
}

// src/routes.ts
var SETTINGS_ROUTE = "/infinite-context/settings";
var mounted = false;
function isSettingsRouteMounted() {
  return mounted;
}
var EDITABLE_KEYS = [
  "enabled",
  "maxAutoHandoffs",
  "contextWindowByModel",
  "thresholdByModel",
  "autoHandoff",
  "markTodosHandedOff",
  "notifyTransferredSession",
  "checkpointMaxBytes",
  "handoffBriefMaxChars",
  "checkpointRoot",
  "projectProgressReserveChars",
  "briefAuthor",
  "carryOriginalRequest"
];
var MAX_BODY_BYTES = 8192;
function sendJson(res, status, value) {
  try {
    if (res.headersSent !== true) {
      res.statusCode = status;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.setHeader("cache-control", "no-store");
    }
    res.end(JSON.stringify(value));
  } catch {
  }
}
function sendError(res, status, code, message) {
  sendJson(res, status, { ok: false, code, message: String(message) });
}
async function readJsonBody(req) {
  const chunks = [];
  let bytes = 0;
  return await new Promise((resolve2, reject) => {
    if (typeof req?.on !== "function") {
      reject(new Error("request body is not readable"));
      return;
    }
    req.on("data", (chunk) => {
      if (chunk === void 0) return;
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        reject(new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8").trim();
        resolve2(text.length === 0 ? {} : JSON.parse(text));
      } catch (error) {
        reject(new Error(`invalid JSON body: ${String(error?.message ?? error)}`));
      }
    });
    req.on("error", (error) => reject(error instanceof Error ? error : new Error("request stream failed")));
  });
}
function findOwnEntry(entries) {
  for (const item of entries ?? []) {
    const entry = item?.entry;
    if (entry === void 0 || entry === null) continue;
    for (const field of ["id", "patchId", "name"]) {
      const value = entry[field];
      if (typeof value === "string" && value.includes("infinite-context-orchestrator")) return entry;
    }
  }
  return void 0;
}
function pickEditable(input) {
  const body = input !== null && typeof input === "object" ? input : {};
  const out = {};
  for (const key of EDITABLE_KEYS) {
    if (body[key] !== void 0) out[key] = body[key];
  }
  return out;
}
function pickResettable(input) {
  const body = input !== null && typeof input === "object" ? input : {};
  const raw = body.reset;
  if (!Array.isArray(raw)) return [];
  return raw.filter((key) => typeof key === "string" && EDITABLE_KEYS.includes(key));
}
var catalogCache;
var MODEL_CACHE_TTL_MS = 5 * 60 * 1e3;
var MODEL_DISCOVER_TIMEOUT_MS = 4e3;
async function discoverModelCatalog(ctx) {
  const llm = ctx.get("llm");
  if (llm === void 0 || typeof llm.listProviders !== "function") {
    return { ok: false, providers: [], error: "llm \u670D\u52A1\u4E0D\u53EF\u7528\uFF08\u62FF\u4E0D\u5230\u6A21\u578B\u76EE\u5F55\uFF09" };
  }
  const providers = await withTimeout(safeCall(() => llm.listProviders?.()), MODEL_DISCOVER_TIMEOUT_MS) ?? [];
  const out = [];
  for (const provider of providers) {
    const id = typeof provider?.id === "string" ? provider.id : void 0;
    if (id === void 0) continue;
    const name2 = typeof provider?.name === "string" ? provider.name : id;
    let models = [];
    if (typeof llm.listModels === "function") {
      models = await withTimeout(safeCall(() => llm.listModels?.(id)), MODEL_DISCOVER_TIMEOUT_MS) ?? [];
    }
    out.push({
      id,
      name: name2,
      models: models.filter((model) => typeof model?.id === "string").map((model) => ({
        id: String(model.id),
        name: typeof model.name === "string" ? model.name : String(model.id),
        // 不同适配器有的给 context.contextWindow，有的直接给 contextWindow
        contextWindow: typeof model.context?.contextWindow === "number" ? model.context.contextWindow : typeof model.contextWindow === "number" ? model.contextWindow : null
      }))
    });
  }
  return { ok: true, providers: out };
}
function wantsModels(req) {
  const url = typeof req?.url === "string" ? req.url : "";
  const query = url.includes("?") ? url.slice(url.indexOf("?") + 1) : "";
  return /(^|&)models=1(&|$)/.test(query);
}
function registerSettingsRoutes(deps) {
  const { ctx, config, state, root } = deps;
  const snapshot2 = () => ({
    ok: true,
    config,
    checkpointRoot: root,
    lastCheckpointPath: state.lastHandoff?.checkpointPath ?? readLatestPointer(root)?.checkpointPath ?? null,
    lastHandoff: state.lastHandoff ?? null,
    inFlight: state.inFlight
  });
  const listModelCatalog = async () => {
    const now = Date.now();
    if (catalogCache !== void 0 && now - catalogCache.at < MODEL_CACHE_TTL_MS) return catalogCache.value;
    const value = await discoverModelCatalog(ctx);
    catalogCache = { at: now, value };
    return value;
  };
  const probeWindow = async () => {
    try {
      const agents = ctx.get("agents");
      const list = agents?.list?.();
      const last = Array.isArray(list) ? list[list.length - 1] : void 0;
      if (last === void 0) return null;
      const occupancy = await measureOccupancy(ctx, last, {});
      return {
        windowTokens: occupancy.windowTokens ?? null,
        windowSource: occupancy.windowSource ?? "unknown",
        usedTokens: occupancy.usedTokens ?? null,
        percent: occupancy.percent ?? null
      };
    } catch {
      return null;
    }
  };
  const handler = async (req, res) => {
    try {
      const connection = ctx.get("connection");
      const rejection = connection?.requestRejection?.({ headers: req?.headers });
      if (typeof rejection === "number") {
        res.statusCode = rejection;
        res.setHeader("content-type", "text/plain; charset=utf-8");
        res.setHeader("cache-control", "no-store");
        res.end(rejection === 401 ? "unauthorized" : "forbidden");
        return;
      }
    } catch {
      sendError(res, 503, "auth-unavailable", "authentication layer unavailable");
      return;
    }
    try {
      const method = String(req?.method ?? "GET").toUpperCase();
      if (method === "GET") {
        const payload = { ...snapshot2(), probe: await probeWindow() };
        if (wantsModels(req)) {
          const catalog = await listModelCatalog();
          payload.providers = catalog.providers ?? [];
          if (catalog.error !== void 0) payload.error = catalog.error;
        }
        sendJson(res, 200, payload);
        return;
      }
      if (method !== "PUT" && method !== "POST") {
        sendError(res, 405, "method-not-allowed", "only GET and PUT are supported");
        return;
      }
      let body;
      try {
        body = await readJsonBody(req);
      } catch (error) {
        sendError(res, 400, "bad-body", String(error?.message ?? error));
        return;
      }
      const patch = pickEditable(body);
      const reset = pickResettable(body);
      if (Object.keys(patch).length === 0 && reset.length === 0) {
        sendError(res, 400, "empty-patch", `body must contain at least one of: ${EDITABLE_KEYS.join(", ")} (or a "reset" array)`);
        return;
      }
      let next;
      try {
        const candidate = { ...config };
        const defaults = CONFIG_DEFAULTS;
        for (const key of reset) candidate[key] = defaults[key];
        next = resolveConfig({ ...candidate, ...patch });
      } catch (error) {
        sendError(res, 400, "invalid-config", String(error?.message ?? error));
        return;
      }
      const editor = ctx.get("configEditor");
      if (editor === void 0 || typeof editor.edit !== "function" || typeof editor.configuration !== "function") {
        sendError(res, 501, "config-editor-unavailable", "configEditor \u670D\u52A1\u4E0D\u53EF\u7528\uFF1B\u8BF7\u6539 profile \u7684 cordis.patch.yml");
        return;
      }
      const entry = findOwnEntry(editor.configuration());
      if (entry === void 0) {
        sendError(res, 409, "entry-not-found", "\u5728 profile \u914D\u7F6E\u91CC\u627E\u4E0D\u5230\u672C\u63D2\u4EF6\u7684\u884C\uFF1B\u8BF7\u6539 cordis.patch.yml");
        return;
      }
      await editor.edit(entry, () => ({ ...next }));
      sendJson(res, 200, { ...snapshot2(), saved: true, applied: next });
    } catch (error) {
      if (res.headersSent !== true) sendError(res, 500, "handler-failed", String(error?.message ?? error));
      else res.end();
    }
  };
  const attach = (target) => {
    if (mounted) return;
    const webServer = target.get("webServer") ?? target.webServer;
    if (webServer === void 0 || typeof webServer.register !== "function") return;
    try {
      const registerRoute = () => {
        const dispose = webServer.register?.({ kind: "exact", path: SETTINGS_ROUTE, handler });
        mounted = true;
        return () => {
          mounted = false;
          try {
            dispose?.();
          } catch {
          }
        };
      };
      if (typeof target.effect === "function") target.effect(registerRoute, "dsh-infinite-context-orchestrator: settings route");
      else registerRoute();
    } catch {
      mounted = false;
    }
  };
  const injectable = ctx;
  if (typeof injectable.inject === "function") {
    try {
      injectable.inject(["webServer"], attach);
      return;
    } catch {
    }
  }
  attach(ctx);
}

// src/tools.ts
var NO_ARGS = { type: "object", additionalProperties: false, properties: {} };
var HANDOFF_ARGS = {
  type: "object",
  additionalProperties: false,
  properties: {
    reason: {
      type: "string",
      description: "\u53EF\u9009\uFF1A\u4E3A\u4EC0\u4E48\u8981\u73B0\u5728\u6362\u7A97\uFF08\u4F1A\u5199\u8FDB\u68C0\u67E5\u70B9\u7684 notes\uFF0C\u4FBF\u4E8E\u65B0\u4F1A\u8BDD\u7406\u89E3\u4E0A\u4E0B\u6587\uFF09\u3002"
    }
  }
};
var OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: true,
  properties: {
    ok: { type: "boolean" },
    message: { type: "string" }
  },
  required: ["ok", "message"]
};
var renderText = (_args, value) => {
  const result = value;
  const text = String(result?.message ?? "");
  if (result?.ok === false && typeof result.code === "string") {
    return [{ type: "text", text: `[${result.code}] ${text}` }];
  }
  return [{ type: "text", text }];
};
function lossless(value) {
  if (value === null || value === void 0) return value;
  if (typeof value !== "object") return typeof value === "function" ? void 0 : value;
  if (Array.isArray(value)) {
    return value.filter((item) => item !== void 0 && typeof item !== "function").map((item) => lossless(item));
  }
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === void 0 || typeof item === "function") continue;
    out[key] = lossless(item);
  }
  return out;
}
function toolAgent(exec) {
  return exec?.agent ?? (exec?.session === void 0 ? void 0 : { session: exec.session });
}
function probeServices(ctx) {
  const check = (name2, critical, predicate) => {
    let available = false;
    try {
      const service = ctx.get(name2);
      available = service !== void 0 && service !== null && predicate(service);
    } catch {
      available = false;
    }
    return { name: name2, available, critical };
  };
  return [
    check("sessionController", false, (s) => typeof s?.create === "function"),
    check("agents", false, (s) => {
      const service = s;
      return typeof service?.list === "function" || typeof service?.create === "function";
    }),
    check("tokenMeter", true, (s) => typeof s?.measure === "function"),
    check("sessionProjections", true, (s) => typeof s?.stateOf === "function"),
    check("llm", false, (s) => typeof s?.resolveModelInfo === "function")
  ];
}
async function statusValue(deps, exec) {
  const { ctx, config, state, root } = deps;
  const agent = toolAgent(exec);
  const sessionId = agent?.session?.id;
  const notes = [];
  const services = probeServices(ctx);
  const occupancy = agent === void 0 ? void 0 : await measureOccupancy(ctx, agent, windowConfigOf(config));
  const latest = readLatestPointer(root);
  const lastCheckpointPath = state.lastHandoff?.checkpointPath ?? latest?.checkpointPath ?? null;
  if (!config.enabled) {
    notes.push("\u603B\u5F00\u5173 enabled=false\uFF1A\u54E8\u5175\u4E0D\u76D1\u542C\u9884\u7B97\uFF0C\u4E5F\u4E0D\u4F1A\u81EA\u52A8\u6362\u7A97\uFF1Binfinite_context_handoff \u4F1A\u62D2\u7EDD\u6267\u884C\u3002");
  }
  if (occupancy !== void 0 && occupancy.basis === "unavailable") {
    notes.push(`\u62FF\u4E0D\u5230\u4E0A\u4E0B\u6587\u5360\u7528\uFF1A${occupancy.note ?? "contextPressure \u6295\u5F71\u4E0E tokenMeter \u90FD\u6CA1\u7ED9\u51FA\u53EF\u7528\u6570\u503C"}\u3002`);
  }
  if (occupancy !== void 0 && occupancy.basis === "tokens") {
    notes.push(`\u7A97\u53E3\u5927\u5C0F\u672A\u77E5\uFF1A${occupancy.note ?? "\u6A21\u578B\u6CA1\u58F0\u660E contextWindow"}\uFF1B\u53EA\u80FD\u770B token \u7EDD\u5BF9\u503C\uFF0C\u767E\u5206\u6BD4\u9608\u503C\u4E0D\u4F1A\u89E6\u53D1\u3002\u53EF\u5728\u6A21\u578B\u914D\u7F6E\u91CC\u8865 contextWindow\u3002`);
  }
  if (config.autoHandoff && !config.enabled) notes.push("autoHandoff=true \u4F46 enabled=false\uFF1A\u81EA\u52A8\u6362\u7A97\u4E0D\u4F1A\u53D1\u751F\u3002");
  const missing = services.filter((service) => service.critical && !service.available).map((service) => service.name);
  if (missing.length > 0) notes.push(`\u7F3A\u5C11\u5173\u952E\u670D\u52A1\uFF1A${missing.join("\u3001")}\uFF08\u5360\u7528\u6D4B\u91CF\u4F1A\u964D\u7EA7\uFF09\u3002`);
  if (!services.some((service) => service.name === "sessionController" && service.available) && !services.some((service) => service.name === "agents" && service.available)) {
    notes.push("sessionController \u4E0E agents \u90FD\u4E0D\u53EF\u7528\uFF1A\u6362\u7A97\u4E00\u5B9A\u5931\u8D25\uFF08\u53EA\u80FD\u5199\u68C0\u67E5\u70B9\uFF09\u3002");
  }
  const pendingBrief = typeof sessionId === "string" ? state.pendingBriefs.has(sessionId) || loadPendingBrief(root, sessionId) !== void 0 : false;
  const policy = resolvePolicy(config, agent?.session);
  const gapText = occupancy === void 0 ? "\u65E0\u6CD5\u4F30\u7B97\uFF08\u6CA1\u6709\u4F1A\u8BDD\uFF09" : thresholdGap(occupancy, policy.thresholdPercent).text;
  const windowText = (() => {
    if (occupancy === void 0) return "\u672A\u77E5\uFF08\u6CA1\u6709\u4F1A\u8BDD\uFF09";
    if (occupancy.windowTokens === void 0) return "\u672A\u77E5\uFF08DSH \u4E0E\u6A21\u578B\u90FD\u6CA1\u7ED9\u51FA\uFF09";
    const effective = Math.round(occupancy.windowTokens).toLocaleString("en-US");
    if (occupancy.windowSource === "config") {
      const dsh = occupancy.dshWindowTokens === void 0 ? "DSH \u672A\u8BFB\u5230" : `DSH \u8BFB\u53D6 ${Math.round(occupancy.dshWindowTokens).toLocaleString("en-US")}`;
      return `${effective}\uFF08\u6309\u6A21\u578B\u81EA\u5B9A\uFF0C\u751F\u6548\uFF09\xB7 ${dsh}`;
    }
    return `${effective}\uFF08${occupancy.windowSource === "pressure" ? "DSH \u6295\u5F71" : "\u6A21\u578B\u58F0\u660E"}\uFF09`;
  })();
  const currentModel = agent === void 0 ? {} : sessionModelOf(agent.session);
  const policyLine = policy.managed ? `\u6309\u6A21\u578B\u7B56\u7565\uFF1A\u5DF2\u7EB3\u5165\u7BA1\u7406 \xB7 \u672C\u6A21\u578B\u7A97\u53E3 ${policy.window > 0 ? policy.window.toLocaleString("en-US") : "\u7528 DSH \u503C"} \xB7 \u672C\u6A21\u578B\u9608\u503C ${policy.thresholdPercent > 0 ? `${policy.thresholdPercent}%` : "\u672A\u542F\u7528\u767E\u5206\u6BD4\u7EBF"}` : "\u6309\u6A21\u578B\u7B56\u7565\uFF1A\u672C\u6A21\u578B\u672A\u7EB3\u5165\u7BA1\u7406\uFF08\u65E2\u6CA1\u914D\u7A97\u53E3\u4E5F\u6CA1\u914D\u9608\u503C\uFF09\uFF0C\u63D2\u4EF6\u4E0D\u4F1A\u63D0\u9192\u6216\u6362\u7A97";
  const lines = [
    `\u5F53\u524D\u6A21\u578B\uFF1A${currentModel.provider ?? "\u672A\u77E5"}/${currentModel.model ?? "\u672A\u77E5"}`,
    `\u603B\u5F00\u5173\uFF1A${config.enabled ? "\u5DF2\u5F00\u542F" : "\u5DF2\u5173\u95ED\uFF08enabled=false\uFF09"} \xB7 \u81EA\u52A8\u6362\u7A97\uFF1A${config.autoHandoff ? "\u5F00" : "\u5173"}`,
    `\u89E6\u53D1\u6761\u4EF6\uFF1A${policy.thresholdPercent}%\uFF08\u6309\u6A21\u578B\u9608\u503C\uFF09`,
    policyLine,
    `\u5F53\u524D\u5360\u7528\uFF1A${occupancy === void 0 ? "\u672A\u77E5\uFF08\u6CA1\u6709\u4F1A\u8BDD\uFF09" : formatOccupancy(occupancy)}`,
    `\u4E0A\u4E0B\u6587\u7A97\u53E3\uFF1A${windowText}`,
    `\u8DDD\u79BB\u9608\u503C\uFF1A${gapText}`,
    `\u6700\u8FD1\u68C0\u67E5\u70B9\uFF1A${lastCheckpointPath ?? "\uFF08\u8FD8\u6CA1\u6709\uFF09"}`,
    `\u68C0\u67E5\u70B9\u6839\u76EE\u5F55\uFF1A${root}`,
    `\u8BBE\u7F6E\u9875\u63A5\u53E3\uFF1A${isSettingsRouteMounted() ? "\u5DF2\u6302\u8F7D\uFF08/infinite-context/settings\uFF09" : "\u672A\u6302\u8F7D\uFF08\u8BBE\u7F6E\u9875\u4F1A\u8BFB\u4E0D\u5230\u914D\u7F6E\uFF1B\u68C0\u67E5 webServer \u670D\u52A1\uFF09"}`,
    `\u6B63\u5728\u6362\u7A97\uFF1A${state.inFlight ? "\u662F" : "\u5426"} \xB7 \u672C\u6B21\u52A0\u8F7D\u5DF2\u81EA\u52A8\u6362\u7A97\uFF1A${state.autoHandoffs} \u6B21 \xB7 \u5DF2\u6B66\u88C5\u4F1A\u8BDD\uFF1A${state.armed.size} \u4E2A`
  ];
  if (state.lastHandoff !== void 0) {
    lines.push(
      `\u4E0A\u4E00\u6B21\u4EA4\u63A5\uFF1A${new Date(state.lastHandoff.at).toLocaleString("zh-CN")}\uFF08${state.lastHandoff.origin === "auto" ? "\u81EA\u52A8" : "\u624B\u52A8"}\uFF09 \u2192 \u65B0\u4F1A\u8BDD ${state.lastHandoff.newSessionId ?? "\uFF08\u672A\u521B\u5EFA\uFF09"}\uFF0C\u7B80\u62A5 ${state.lastHandoff.briefChars} \u5B57\u7B26`
    );
  }
  if (notes.length > 0) lines.push("", ...notes.map((note) => `- ${note}`));
  lines.push("", `\u670D\u52A1\uFF1A${services.map((service) => `${service.name}=${service.available ? "\u2713" : "\u2717"}`).join(" \xB7 ")}`);
  return {
    ok: config.enabled,
    message: lines.join("\n"),
    enabled: config.enabled,
    autoHandoff: config.autoHandoff,
    thresholdPercent: policy.thresholdPercent,
    thresholdGap: gapText,
    occupancy: occupancy === void 0 ? null : {
      ...occupancy.percent === void 0 ? {} : { percent: occupancy.percent },
      ...occupancy.usedTokens === void 0 ? {} : { usedTokens: occupancy.usedTokens },
      ...occupancy.windowTokens === void 0 ? {} : { windowTokens: occupancy.windowTokens },
      source: occupancy.source,
      basis: occupancy.basis
    },
    lastCheckpointPath,
    checkpointRoot: root,
    handoffInFlight: state.inFlight,
    armed: typeof sessionId === "string" && state.armed.has(sessionId),
    pendingBrief,
    lastHandoff: state.lastHandoff ?? null,
    lastNoticeAt: state.lastNotice?.at ?? null,
    services,
    notes
  };
}
function createTools(deps) {
  const status = {
    name: "infinite_context_status",
    description: "\u67E5\u770B\u4EFB\u52A1\u81EA\u52A8\u6362\u7A97\u72B6\u6001\uFF1A\u5F53\u524D\u4E0A\u4E0B\u6587\u5360\u7528\u7387\u3001\u89E6\u53D1\u9608\u503C\u3001autoHandoff \u5F00\u5173\u3001\u6700\u8FD1\u68C0\u67E5\u70B9\u8DEF\u5F84\u3001\u4EE5\u53CA\u662F\u5426\u6B63\u5728\u6362\u7A97\u3002\u6392\u67E5\u300C\u4E3A\u4EC0\u4E48\u6CA1\u6709\u63D0\u9192/\u4E3A\u4EC0\u4E48\u6CA1\u6709\u6362\u7A97\u300D\u5148\u8C03\u5B83\u3002",
    parameters: NO_ARGS,
    output: { schema: OUTPUT_SCHEMA, render: renderText },
    async execute(_args, exec) {
      return lossless(await statusValue(deps, exec));
    }
  };
  const handoff = {
    name: "infinite_context_handoff",
    description: "\u624B\u52A8\u6267\u884C\u5B8C\u6574\u6362\u7A97\u95ED\u73AF\uFF1A\u5199\u4EA4\u63A5\u68C0\u67E5\u70B9 \u2192 \u521B\u5EFA\u5168\u65B0\u9876\u5C42\u4F1A\u8BDD \u2192 \u5728\u65B0\u4F1A\u8BDD\u9996\u8F6E\u5F3A\u5236\u6CE8\u5165\u4EA4\u63A5\u7B80\u62A5\u3002\u68C0\u67E5\u70B9\u5199\u5931\u8D25\u4F1A fail-closed\uFF08\u4E0D\u6362\u7A97\uFF09\uFF1B\u65B0\u4F1A\u8BDD\u521B\u5EFA\u5931\u8D25\u4F1A\u4FDD\u7559\u68C0\u67E5\u70B9\u5E76\u8FD4\u56DE\u8DEF\u5F84\u3002\u9700\u8981 enabled=true\uFF1BautoHandoff=false \u65F6\u9760\u5B83\u624B\u52A8\u89E6\u53D1\u3002",
    parameters: HANDOFF_ARGS,
    output: { schema: OUTPUT_SCHEMA, render: renderText },
    async execute(args, exec) {
      const { config } = deps;
      const agent = toolAgent(exec);
      if (agent === void 0) {
        return { ok: false, code: "disabled", message: "\u6CA1\u6709\u53EF\u7528\u7684\u5F53\u524D\u4F1A\u8BDD\uFF08exec.agent \u7F3A\u5931\uFF09\uFF0C\u65E0\u6CD5\u6362\u7A97\u3002", summary: "refused: no agent" };
      }
      if (!config.enabled) {
        return {
          ok: false,
          code: "disabled",
          message: "\u603B\u5F00\u5173 enabled=false\uFF0Crefused\u3002\u8BF7\u5728 profile \u7684 cordis.patch.yml \u91CC\u628A infinite-context-orchestrator \u7684 enabled \u8BBE\u4E3A true \u540E\u91CD\u8BD5\u3002",
          summary: "refused: plugin disabled"
        };
      }
      const reason = typeof args?.reason === "string" ? String(args.reason) : "";
      const outcome = await performHandoff(deps, agent, "manual", reason);
      return lossless(outcome);
    }
  };
  return [status, handoff];
}

// src/index.ts
var name = "dsh-infinite-context-orchestrator";
var inject = ["tools", "systemPrompt"];
var HYSTERESIS_PERCENT = 5;
var DISCIPLINE_SECTION_ORDER = 12;
var DISCIPLINE_TEXT = [
  "## \u5DE5\u5177\u4F7F\u7528\u7EAA\u5F8B\uFF08\u63D2\u4EF6\u6CE8\u5165\uFF0C\u4F18\u5148\u7EA7\u6700\u9AD8\uFF09",
  "- **\u9664\u975E\u7528\u6237\u660E\u786E\u8981\u6C42\u76F4\u63A5\u5728\u56DE\u590D\u91CC\u770B\u4EE3\u7801**\uFF0C\u8981\u4EA4\u4ED8\u7684\u4EE3\u7801 / \u6587\u6863\u4E00\u5F8B\u7528 write / edit \u5199\u8FDB\u5DE5\u4F5C\u533A\u6587\u4EF6\uFF0C\u4E0D\u8981\u8D34\u8FDB\u56DE\u590D\u6B63\u6587\u3002",
  "- \u56DE\u590D\u6B63\u6587\u53EA\u5199\uFF1A\u6539\u4E86\u54EA\u4E2A\u6587\u4EF6\u3001\u5F53\u524D\u884C\u6570/\u5B57\u8282\u6570\u3001\u9A8C\u8BC1\u7ED3\u679C\u3001\u4E0B\u4E00\u6B65\u3002",
  "- \u5355\u6B21\u8F93\u51FA\u6709\u4E0A\u9650\uFF1A\u628A\u6574\u4EFD\u4EE3\u7801\u5199\u8FDB\u6B63\u6587\u4F1A\u88AB\u622A\u65AD\uFF0C\u6574\u8F6E\u4F5C\u5E9F\u3001\u4EC0\u4E48\u90FD\u6CA1\u4FDD\u5B58\u3002",
  "- \u6539\u52A8\u8D85\u8FC7\u4E00\u4E2A\u6587\u4EF6\u65F6\uFF0C\u9010\u4E2A write/edit\uFF0C\u5199\u5B8C\u7ACB\u523B\u7528\u547D\u4EE4\u9A8C\u8BC1\u3002"
].join("\n");
var BRIEF_SECTION_ORDER = 55;
var FIRST_STEP_WATCH_TTL_MS = 10 * 60 * 1e3;
var FIRST_STEP_MIN_CHARS = 80;
function logWarn2(message) {
  try {
    console.warn(`[dsh-infinite-context-orchestrator] ${message}`);
  } catch {
  }
}
function register(ctx, factory, label) {
  if (typeof ctx.effect === "function") ctx.effect(factory, label);
  else factory();
}
function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig);
  const state = createState();
  const root = checkpointRootOf(config);
  const deps = { ctx, config, state, root };
  for (const tool of createTools(deps)) {
    register(ctx, () => ctx.tools?.register(tool), `${name}: tool ${tool.name}`);
  }
  register(
    ctx,
    () => ctx.systemPrompt?.section({
      name: "infinite-context-handoff-brief",
      order: BRIEF_SECTION_ORDER,
      text: (context) => {
        const sessionId = context?.agent?.session?.id ?? context?.session?.id;
        if (typeof sessionId !== "string" || sessionId.length === 0) return "";
        const pending = state.pendingBriefs.get(sessionId) ?? loadPendingBrief(root, sessionId);
        if (pending === void 0) return "";
        return pending.text;
      }
    }),
    `${name}: handoff brief prompt section`
  );
  register(
    ctx,
    () => ctx.systemPrompt?.section({
      name: "infinite-context-discipline",
      order: DISCIPLINE_SECTION_ORDER,
      text: () => config.enabled ? DISCIPLINE_TEXT : ""
    }),
    `${name}: discipline prompt section`
  );
  ctx.on("agent/pre-step", async (payload, next) => {
    const decision = typeof next === "function" ? await next() : void 0;
    if (!config.enabled) return decision;
    try {
      await observe(ctx, deps, payload?.agent);
    } catch {
    }
    return decision;
  });
  ctx.on("session/event", (session, event) => {
    try {
      const eventSessionId = session?.id;
      if (typeof eventSessionId === "string" && eventSessionId.length > 0 && (event?.type === "step/end" || event?.type === "tool/result" || event?.type === "assistant/message" || event?.type === "turn/start")) {
        invalidateOccupancy(eventSessionId);
      }
      if (event?.type !== "assistant/message") return;
      const sessionId = session?.id;
      if (typeof sessionId !== "string" || sessionId.length === 0) return;
      const hadInMemory = state.pendingBriefs.delete(sessionId);
      if (hadInMemory) clearPendingBrief(root, sessionId);
      else if (event?.data?.turn === 1 && loadPendingBrief(root, sessionId) !== void 0) clearPendingBrief(root, sessionId);
      const watch = state.firstStepWatch.get(sessionId);
      if (watch === void 0) return;
      state.firstStepWatch.delete(sessionId);
      if (Date.now() - watch.at > FIRST_STEP_WATCH_TTL_MS) return;
      const blocks = Array.isArray(event?.data?.message?.content) ? event.data.message.content : [];
      const acted = blocks.some((block) => block?.type === "tool-call");
      if (acted) return;
      const text = messageText(event?.data?.message);
      if (text.length >= FIRST_STEP_MIN_CHARS && !/[？?]\s*$/.test(text)) return;
      const agents = ctx.get("agents");
      const successor = agents?.get?.(sessionId);
      if (successor !== void 0 && typeof successor.followup === "function") {
        successor.followup(noticeMessage(
          `\u7EE7\u7EED\u6267\u884C\u5F85\u529E\u7B2C\u4E00\u9879\uFF1A\u300C${watch.todo}\u300D\u3002\u4E0D\u8981\u53EA\u6C47\u62A5\u72B6\u6001\u2014\u2014\u5148\u628A\u80FD\u505A\u7684\u90E8\u5206\u505A\u6389\uFF1B\u786E\u5B9E\u9700\u8981\u7528\u6237\u51B3\u5B9A\u65F6\uFF0C\u628A\u95EE\u9898\u538B\u7F29\u6210\u4E00\u53E5\u5E76\u7ED9\u51FA\u4F60\u7684\u9ED8\u8BA4\u9009\u62E9\u3002`,
          "[infinite-context] \u4EA4\u63A5\u540E\u672A\u5F00\u5DE5\uFF0C\u5DF2\u8865\u53D1\u7EA0\u6B63"
        ));
        logWarn2(`\u65B0\u4F1A\u8BDD ${sessionId} \u9996\u6761\u6D88\u606F\u672A\u5F00\u5DE5\uFF0C\u5DF2\u8865\u53D1\u7EA0\u6B63\uFF08\u5F85\u529E\uFF1A${watch.todo}\uFF09`);
      }
    } catch {
    }
  });
  ctx.on("agent/disposed", (payload) => {
    try {
      const sessionId = payload?.agent?.session?.id;
      if (typeof sessionId !== "string") return;
      state.fired.delete(sessionId);
      state.armed.delete(sessionId);
      state.pendingBriefs.delete(sessionId);
    } catch {
    }
  });
  register(ctx, () => () => clearOccupancyCache(), `${name}: occupancy cache`);
  try {
    const injectable = ctx;
    if (typeof injectable.inject === "function") {
      injectable.inject(["workspaceRegistry"], (injected) => {
        const registry = injected?.workspaceRegistry;
        setWorkspaceRegistryAccessor(() => registry);
      });
    }
  } catch {
    logWarn2("\u62FF\u4E0D\u5230 workspaceRegistry\uFF1A\u65B0\u4F1A\u8BDD\u5C06\u9000\u56DE\u6309 cwd \u521B\u5EFA\uFF08\u6B64\u65F6\u4E0D\u4F1A\u81EA\u52A8\u52A0\u5165\u539F\u5206\u7EC4\uFF09");
  }
  registerSettingsRoutes(deps);
}
async function observe(ctx, deps, agent) {
  const { config, state } = deps;
  if (agent === void 0) return;
  const session = agent.session;
  const sessionId = session?.id;
  if (typeof sessionId !== "string" || sessionId.length === 0) return;
  if (isSubagentSession(session)) return;
  const occupancy = await measureOccupancy(ctx, agent, windowConfigOf(config));
  const policy = resolvePolicy(config, session);
  if (!policy.managed) return;
  if (config.autoHandoff && hasSessionCheckpoint(checkpointRootOf(config), sessionId)) return;
  const { crossed, by } = crossedThreshold(occupancy, policy.thresholdPercent);
  if (!crossed) {
    const previous = state.fired.get(sessionId);
    const percentDrop = occupancy.percent !== void 0 && occupancy.percent < policy.thresholdPercent - HYSTERESIS_PERCENT;
    if (previous !== void 0 && percentDrop) {
      state.fired.delete(sessionId);
    }
    return;
  }
  state.armed.add(sessionId);
  if (state.fired.has(sessionId)) return;
  state.fired.set(sessionId, { at: Date.now(), percent: occupancy.percent });
  const mode = config.autoHandoff ? "\u5C06\u81EA\u52A8\u6267\u884C\uFF1A\u5199\u68C0\u67E5\u70B9 \u2192 \u5F00\u65B0\u7A97 \u2192 \u6CE8\u5165\u4EA4\u63A5\u7B80\u62A5\u3002" : "\u5C06\u5199\u5165\u68C0\u67E5\u70B9\u5E76\u6362\u7A97\uFF1BautoHandoff=false\uFF0C\u7B49\u4F60\u786E\u8BA4\u540E\u8C03\u7528 infinite_context_handoff \u6267\u884C\u3002";
  const notice = [
    `\u3010\u4EFB\u52A1\u81EA\u52A8\u6362\u7A97\u3011\u4E0A\u4E0B\u6587\u5360\u7528 ${formatOccupancy(occupancy)}\uFF0C\u5DF2\u8FBE\u89E6\u53D1\u6761\u4EF6\uFF1A${policy.thresholdPercent}%\u3002`,
    mode
  ].join("\n");
  notifyCaller(ctx, agent, notice, `[infinite-context] triggered by ${by} \xB7 ${occupancy.percent ?? "?"}% / ${occupancy.usedTokens ?? "?"} tokens`);
  state.lastNotice = { at: Date.now(), text: notice };
  if (!config.autoHandoff) return;
  const outcome = await performHandoff(deps, agent, "auto");
  if (!outcome.ok && (outcome.code === "busy" || outcome.code === "rate-limited")) {
    notifyCaller(ctx, agent, `\u3010\u4EFB\u52A1\u81EA\u52A8\u6362\u7A97\u3011${outcome.message}`, `[infinite-context] auto handoff skipped: ${outcome.code}`);
  }
}
function snapshotState(state) {
  return {
    inFlight: state.inFlight,
    autoHandoffs: state.autoHandoffs,
    fired: [...state.fired.keys()],
    armed: [...state.armed],
    pendingBriefs: [...state.pendingBriefs.keys()],
    lastHandoff: state.lastHandoff ?? null,
    lastNotice: state.lastNotice ?? null
  };
}
export {
  Config,
  withTimeout as __testingWithTimeout,
  apply,
  inject,
  name,
  snapshotState
};
