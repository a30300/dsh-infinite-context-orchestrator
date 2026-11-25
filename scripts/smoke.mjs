/**
 * 离线冒烟测试：用一个假的 Cordis Context 跑通整条闭环，不需要启动 DSH。
 *
 * 覆盖：
 *   1. 越过阈值 → 当前会话收到插件 notice（非用户消息）；
 *   2. autoHandoff=true → 自动写检查点 + 建新会话 + 首条 followup；
 *   3. 检查点字段齐全（goal/done/pending_todos/key_decisions/last_human_request/checkpoint_path）；
 *   4. 新会话首轮 systemPrompt 段里能读到完整交接简报；
 *   5. 第二次写入留下 .previous 副本；
 *   6. fail-closed：检查点写不进去时**不**建新会话；
 *   7. 防失控：同一次 apply 内第二次自动 handoff 被拒绝；
 *   8. 手动工具：enabled=false 时明确拒绝。
 *
 * 跑法：node scripts/smoke.mjs
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { apply } from '../lib/index.js'
import * as mod from '../lib/index.js'

const workdir = mkdtempSync(path.join(tmpdir(), 'ico-work-'))
const checkpointRoot = mkdtempSync(path.join(tmpdir(), 'ico-cp-'))

const results = []
function ok(name, detail = '') {
  results.push(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`)
}

// ── 假会话 / 假服务 ────────────────────────────────────────────────────────
const events = [
  {
    type: 'user/message',
    seq: 1,
    data: {
      role: 'user',
      id: 'm1',
      content: [{ type: 'text', text: '给我做无限上下文编排插件，必须保留 .previous 副本，禁止在同一个会话里切 preset。' }],
      source: { kind: 'user' },
    },
  },
  {
    type: 'assistant/message',
    seq: 2,
    data: { turn: 1, step: 1, message: { role: 'assistant', id: 'a1', content: [{ type: 'text', text: '已完成脚手架与安装步骤。' }] } },
  },
  {
    type: 'user/message',
    seq: 3,
    data: {
      role: 'user',
      id: 'm2',
      content: [{ type: 'text', text: '继续写检查点部分，记得脱敏 api_key=sk-abcdefgh12345678' }],
      source: { kind: 'user' },
    },
  },
]

const session = {
  id: 'session-old-0001',
  header: { id: 'session-old-0001', cwd: workdir, agentPreset: 'cordis' },
  snapshotEvents: () => events,
  requestHeader: () => ({ config: { provider: 'fake-provider', model: 'fake-model' } }),
}

const injected = []
const followups = []
const oldAgent = { session, inject: (message) => injected.push(message) }

const createdSessions = []
let newSessionIdCounter = 0
const liveAgents = new Map()
/** 记录 sessionController.cancel 的调用（B：交接后叫停旧会话）。 */
const cancelCalls = []

const services = {
  // GUI 的分组 = Workspace；sessionIds 里含当前会话即视为同组
  workspaceRegistry: {
    list: () => [
      { id: 'ws-default', path: 'C:\\\\Users\\\\fake\\\\default-workspace', sessionIds: ['session-old-0001'] },
      { id: 'ws-other', path: 'C:\\\\Users\\\\fake\\\\other', sessionIds: [] },
    ],
  },
  sessionProjections: {
    stateOf: (target, key) => {
      if (key === 'goal') return { objective: '实现 dsh-infinite-context-orchestrator 无限上下文闭环' }
      if (key === 'todos') {
        return {
          todos: [
            { content: '安装 4 个基础插件', status: 'completed' },
            { content: '写 TS 源码与 schemastery Config', status: 'in_progress' },
            { content: '写 README 与验证步骤', status: 'pending' },
          ],
        }
      }
      if (key === 'contextPressure') return { contextWindow: 100_000, pressureTokens: 12_000 }
      return undefined
    },
  },
  tokenMeter: { measure: () => ({ totalTokens: 12_000 }) },
  llm: {
    resolveModelInfo: async () => ({ context: { contextWindow: 100_000 } }),
    listProviders: async () => [{ id: 'fake-provider', name: 'Fake' }],
    listModels: async (provider) => (provider === 'fake-provider'
      ? [{ provider: 'fake-provider', id: 'fake-model', name: 'Fake Model', context: { contextWindow: 200_000 } }]
      : []),
  },
  sessionController: {
    create: async (request) => {
      newSessionIdCounter += 1
      const sessionId = `session-new-${newSessionIdCounter}`
      createdSessions.push({ sessionId, request })
      const agent = {
        session: { id: sessionId, header: { id: sessionId, cwd: request.cwd, agentPreset: request.agentPreset }, snapshotEvents: () => [], requestHeader: () => ({}) },
        followup: (message) => followups.push({ sessionId, message }),
        dispose: () => liveAgents.delete(sessionId),
      }
      liveAgents.set(sessionId, agent)
      return { sessionId, agentPreset: request.agentPreset }
    },
    cancel: (request) => { cancelCalls.push(request) },
  },
  agents: {
    get: (id) => liveAgents.get(id),
    list: () => [...liveAgents.values()],
  },
  sessionTitle: { rename: () => undefined },
}

/** 每次 apply 都用一套全新的假 Context：工具/事件/提示词段互不串味。 */
function makeCtx() {
  const handlers = new Map()
  const tools = []
  let briefSection
  const sections = new Map()
  const ctx = {
    get: (name) => services[name],
    // 模拟 Cordis 的注入代理：未在 inject 里声明就取属性会抛
    inject: (deps, callback) => {
      const wantsRegistry = Array.isArray(deps) && deps.includes('workspaceRegistry')
      if (wantsRegistry && services.workspaceRegistry === undefined) {
        throw new Error('cannot get property "workspaceRegistry" without inject')
      }
      const injected = {
        get: (name) => services[name],
        effect: ctx.effect,
        ...(wantsRegistry ? { workspaceRegistry: services.workspaceRegistry } : {}),
      }
      return callback(injected)
    },
    on: (name, handler) => {
      handlers.set(name, handler)
    },
    effect: (factory) => factory(),
    tools: { register: (definition) => { tools.push(definition); return () => undefined } },
    systemPrompt: {
      // 现在注册了两个段：交接简报 + 常驻纪律。按名字分开存，避免后者覆盖前者。
      section: (section) => {
        sections.set(section.name, section)
        if (section.name === 'infinite-context-handoff-brief') briefSection = section
        return () => undefined
      },
    },
  }
  return {
    ctx,
    tools,
    handlers,
    brief: () => briefSection,
    sections: () => sections,
    runPreStep: async (agent) => {
      const handler = handlers.get('agent/pre-step')
      assert.ok(handler !== undefined, 'pre-step handler 未注册')
      await handler({ agent }, async () => ({ messages: [] }))
    },
  }
}

const first = makeCtx()
const ctx = first.ctx
const tools = first.tools
const briefSection = { text: (context) => first.brief()?.text(context) ?? '' }

const runPreStep = (agent) => first.runPreStep(agent)


async function main() {
  // ── A. 自动路径 ─────────────────────────────────────────────────────────
  apply(ctx, {
    enabled: true,
    contextWindowByModel: { 'fake-provider/fake-model': 100_000 }, thresholdByModel: { 'fake-provider/fake-model': 10 },
    autoHandoff: true,
    // 主 harness 用「上限 1」来测防失控（默认值是 10，见 §Q 用例）
    maxAutoHandoffs: 1,
    checkpointMaxBytes: 65536,
    handoffBriefMaxChars: 2000,
    checkpointRoot,
  })

  assert.equal(tools.length, 2, '应注册两个工具')
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ['infinite_context_handoff', 'infinite_context_status'])
  ok('工具注册', tools.map((tool) => tool.name).join(' / '))
  assert.ok(briefSection !== undefined, 'systemPrompt 段未注册')
  ok('systemPrompt 段注册', `order=${first.brief()?.order} name=${first.brief()?.name}`)

  await runPreStep(oldAgent)

  assert.equal(injected.length >= 1, true, '应给当前会话注入 notice')
  const notice = injected[0]
  assert.equal(notice.source.kind, 'dsh-infinite-context-orchestrator')
  assert.equal(notice.source.form, 'notice', 'notice 必须是插件 notice，不是用户消息')
  assert.match(notice.content[0].text, /已达触发条件：10%/)
  ok('临界 notice', notice.source.summary)

  assert.equal(createdSessions.length, 1, '应创建恰好一个新会话')
  const newSessionId = createdSessions[0].sessionId
  // 归属到原 Workspace 时传 workspaceId（与 cwd 互斥）；没有归属才退回 cwd。
  const firstCreate = createdSessions[0].request
  assert.ok(
    firstCreate.workspaceId === 'ws-default' || firstCreate.cwd === workdir,
    `新会话应加入原分组或继承 cwd（实际：${JSON.stringify(firstCreate)}）`,
  )
  assert.equal(createdSessions[0].request.agentPreset, 'cordis', '新会话应沿用旧会话的 preset')
  ok('新会话创建', `${newSessionId}（preset=${createdSessions[0].request.agentPreset}）`)

  assert.equal(followups.length, 1, '应给新会话发一条 followup')
  assert.equal(followups[0].sessionId, newSessionId)
  ok('新会话首条 followup')

  // 检查点字段
  const handoffDir = path.join(checkpointRoot, 'handoffs')
  const files = readdirSync(handoffDir).filter((name) => name.endsWith('.json'))
  assert.equal(files.length, 1, '应有一份检查点')
  const doc = JSON.parse(readFileSync(path.join(handoffDir, files[0]), 'utf8'))
  for (const field of ['goal', 'done', 'pending_todos', 'key_decisions', 'last_human_request', 'checkpoint_path']) {
    assert.ok(doc[field] !== undefined, `检查点缺少字段 ${field}`)
  }
  assert.equal(doc.checkpoint_path, path.join(handoffDir, files[0]), 'checkpoint_path 应指向自身')
  assert.match(doc.goal, /无限上下文/)
  assert.ok(doc.done.some((item) => item.includes('安装 4 个基础插件')), 'done 应含已完成 todo')
  assert.ok(doc.pending_todos.some((item) => item.includes('README')), 'pending_todos 应含未完成 todo')
  assert.ok(doc.key_decisions.length >= 1, 'key_decisions 应至少有一条用户约束')
  assert.match(doc.last_human_request, /继续写检查点部分/)
  ok('检查点字段', `${files[0]} (${Object.keys(doc).length} 字段)`)

  // 脱敏：user 消息里塞了 sk- 前缀的假 token
  const raw = readFileSync(path.join(handoffDir, files[0]), 'utf8')
  assert.equal(raw.includes('sk-abcdefgh12345678'), false, '凭据必须被脱敏')
  ok('凭据脱敏', 'sk-… 已被替换')

  // 常驻纪律段（system prompt）：交付物必须落盘
  const discipline = first.sections().get('infinite-context-discipline')
  assert.ok(discipline !== undefined, '应注册常驻纪律段')
  assert.match(String(discipline.text({})), /一律用 write \/ edit 写进工作区文件/, '纪律段应要求落盘')
  ok('常驻纪律段（交付物落盘）')

  // 简报注入
  const brief = briefSection.text({ agent: { session: { id: newSessionId } } })
  assert.match(brief, /## 任务交接简报/)
  assert.match(brief, /当前目标/)
  assert.match(brief, /待办/)
  assert.match(brief, /请从“待办”的第一项继续/)
  assert.ok(brief.length <= 2000, `简报应在预算内（实际 ${brief.length}）`)
  ok('简报注入', `${brief.length} 字符`)

  // 旧会话拿不到简报
  assert.equal(briefSection.text({ agent: { session: { id: 'session-old-0001' } } }), '', '旧会话不应注入简报')
  ok('简报只注入新会话')

  // ── B. 防失控：同一次 apply 内第二次自动 handoff 被拒 ────────────────────
  // 用第二个会话（另一个顶层会话也到线）来触发第二道闸门：单次 apply 的自动换窗上限。
  // 同一个旧会话不会重复换窗，因为它已在 fired 里（升线只提醒一次）。
  services.sessionProjections.stateOf = ((original) => (target, key) => (key === 'contextPressure'
    ? { contextWindow: 100_000, pressureTokens: 90_000 }
    : original(target, key)))(services.sessionProjections.stateOf)
  const secondSession = { ...session, id: 'session-old-0002', header: { ...session.header, id: 'session-old-0002' } }
  const secondInjected = []
  const secondAgent = { session: secondSession, inject: (message) => secondInjected.push(message) }
  await runPreStep(secondAgent)
  assert.equal(createdSessions.length, 1, '第二次自动 handoff 必须被拒绝')
  const skipNotice = secondInjected.map((message) => message.content[0].text).join('\n')
  assert.match(skipNotice, /上限/)
  ok('防失控（maxAutoHandoffs=1 时只换一次）')

  // ── C. 手动工具 ─────────────────────────────────────────────────────────
  const handoffTool = tools.find((tool) => tool.name === 'infinite_context_handoff')
  const manual = await handoffTool.execute({ reason: '手动验证' }, { agent: oldAgent })
  assert.equal(manual.ok, true, `手动 handoff 应成功：${manual.message}`)
  assert.equal(createdSessions.length, 2)
  ok('手动 infinite_context_handoff', manual.newSessionId)
  // 分组：新会话必须带上原会话所在的 workspaceId（否则 UI 里会自成一个新分组）
  const manualCreate = createdSessions.find((item) => item.sessionId === manual.newSessionId)
  assert.ok(manualCreate !== undefined, '应记录到 create 请求')
  assert.equal(manualCreate.request.workspaceId, 'ws-default', 'create 应带上原会话的 workspaceId')
  assert.equal(manualCreate.request.cwd, undefined, 'workspaceId 与 cwd 互斥，不能同时传')
  ok('新会话加入原分组', `workspaceId=${manualCreate.request.workspaceId}`)

  // 成功通知里要说明「旧窗口的待办已转走」——否则旧窗口会一直挂着"进行中"的任务
  assert.ok(String(manual.message).includes('待办已随交接写入新会话'), '成功通知应说明待办已转到新会话')
  ok('通知说明待办已转走')

  // 工具渲染：失败时带 code，成功时不带（模型才能按 code 分支）
  const failedRender = handoffTool.output.render({}, { ok: false, code: 'disabled', message: '被拒绝' })
  assert.equal(failedRender[0].text, '[disabled] 被拒绝')
  const okRender = handoffTool.output.render({}, { ok: true, code: 'ok', message: '成功文本' })
  assert.equal(okRender[0].text, '成功文本')
  ok('失败渲染带 code', failedRender[0].text)

  // .previous 副本：同一会话第二次交接写同一个稳定路径 → 旧版留在 <sessionId>.json.previous
  const previousFiles = readdirSync(handoffDir).filter((name) => name.endsWith('.previous'))
  assert.ok(previousFiles.length >= 1, '.previous 副本缺失')
  const previousDoc = JSON.parse(readFileSync(path.join(handoffDir, previousFiles[0]), 'utf8'))
  assert.ok(typeof previousDoc.goal === 'string' && previousDoc.goal.length > 0, '.previous 应是可解析的完整检查点')
  ok('.previous 副本', previousFiles.join(', '))

  // 历史副本：每次交接都留一份不可变记录
  const historyFiles = readdirSync(path.join(handoffDir, 'history')).filter((name) => name.endsWith('.json'))
  assert.equal(historyFiles.length, 2, '历史副本应有两份')
  ok('历史副本', `${historyFiles.length} 份`)

  // ── D. fail-closed：检查点写不进去时不换窗 ──────────────────────────────
  const second = makeCtx()
  const failRoot = path.join(checkpointRoot, 'nested-as-file')
  // 用「一个已存在的文件」当检查点根：mkdir 必然失败 → 写检查点失败
  const { writeFileSync } = await import('node:fs')
  writeFileSync(failRoot, 'not a directory')

  const createdBeforeFail = createdSessions.length
  const injectedBeforeFail = injected.length
  apply(second.ctx, {
    enabled: true,
    contextWindowByModel: { 'fake-provider/fake-model': 100_000 }, thresholdByModel: { 'fake-provider/fake-model': 10 },
    autoHandoff: true,
    checkpointMaxBytes: 65536,
    handoffBriefMaxChars: 1200,
    checkpointRoot: failRoot,
  })
  await second.runPreStep(oldAgent)
  assert.equal(createdSessions.length, createdBeforeFail, 'fail-closed：写检查点失败时绝不能建新会话')
  const failNotice = injected.slice(injectedBeforeFail).map((message) => message.content[0].text).join('\n')
  assert.match(failNotice, /取消换窗|fail-closed/i)
  ok('fail-closed（检查点写失败 → 不换窗）')

  // ── E. enabled=false 时手动工具拒绝 ────────────────────────────────────
  const third = makeCtx()
  apply(third.ctx, { enabled: false, contextWindowByModel: { 'fake-provider/fake-model': 100_000 }, thresholdByModel: { 'fake-provider/fake-model': 10 }, checkpointRoot: checkpointRoot })
  await third.runPreStep(oldAgent) // 哨兵关闭：不应有新的 notice/建会话
  const createdAfterDisabled = createdSessions.length
  const statusTool = third.tools.find((tool) => tool.name === 'infinite_context_status')
  const disabledStatus = await statusTool.execute({}, { agent: oldAgent })
  assert.equal(disabledStatus.enabled, false)
  assert.equal(createdAfterDisabled, createdBeforeFail, 'enabled=false 时哨兵不应换窗')
  ok('enabled=false 闸门')

  // 状态工具能读出内容
  const status = await statusTool.execute({}, { agent: oldAgent })
  assert.ok(status.message.includes('阈值'))
  ok('infinite_context_status', `occupancy=${status.occupancy?.percent ?? '?'}%`)

  // ── F. 设置页的 HTTP 面（client 半件用它读写配置）──────────────────────
  const routes = {}
  let capturedRoute
  let rejectAs
  const editCalls = []
  services.webServer = {
    register: (route) => { routes[route.path] = route; capturedRoute = route; return () => undefined },
  }
  services.connection = { requestRejection: () => rejectAs }
  services.configEditor = {
    configuration: () => [{ entry: { id: 'include:infinite-context-orchestrator', name: 'dsh-infinite-context-orchestrator' }, inherited: {}, override: {} }],
    edit: async (entry, change) => { editCalls.push({ entry, next: change({}, {}) }) },
  }

  const routeCtx = makeCtx()
  apply(routeCtx.ctx, { enabled: true, contextWindowByModel: { 'fake-provider/fake-model': 100_000 }, thresholdByModel: { 'fake-provider/fake-model': 80 }, checkpointRoot })
  capturedRoute = routes['/infinite-context/settings']
  assert.ok(capturedRoute !== undefined, '设置路由未注册')
  assert.equal(capturedRoute.path, '/infinite-context/settings')
  assert.equal(capturedRoute.kind, 'exact')

  const makeReq = (method, body, url = '/infinite-context/settings') => ({
    method,
    url,
    headers: { accept: 'application/json' },
    on: (event, handler) => {
      if (event === 'data' && body !== undefined) handler(Buffer.from(body, 'utf8'))
      if (event === 'end') handler()
    },
  })
  const makeRes = () => {
    const res = {
      statusCode: 200,
      headersSent: false,
      body: '',
      setHeader() { res.headersSent = true },
      end(payload) { res.body = payload === undefined ? '' : String(payload); res.headersSent = true },
    }
    return res
  }

  // 401：连接层拒绝时原地返回，不碰配置
  rejectAs = 401
  const denied = makeRes()
  await capturedRoute.handler(makeReq('GET'), denied)
  assert.equal(denied.statusCode, 401, '认证拒绝应返回 401')
  rejectAs = undefined
  ok('设置路由认证（401 拒绝）')
  // ?models=1 时附带模型目录（宿主 llm.listProviders/listModels）
  const withModels = makeRes()
  await capturedRoute.handler(makeReq('GET', undefined, '/infinite-context/settings?models=1'), withModels)
  const modelsPayload = JSON.parse(withModels.body ?? '{}')
  assert.equal(withModels.statusCode, 200)
  assert.ok(Array.isArray(modelsPayload.providers), '?models=1 应返回 providers 数组')
  assert.ok(modelsPayload.providers.some((p) => p.id === 'fake-provider'), '应包含 llm 服务报的 provider')
  assert.ok(modelsPayload.providers[0].models.some((m) => m.id === 'fake-model' && m.contextWindow === 200000), '应带上模型声明窗口')
  ok('?models=1 返回模型目录', 'fake-provider/fake-model · 200000')

  const noModels = makeRes()
  await capturedRoute.handler(makeReq('GET'), noModels)
  assert.equal(JSON.parse(noModels.body ?? '{}').providers, undefined, '不带 ?models=1 时不应触发模型发现')
  ok('不带参数不触发模型发现')
  // 回归：withTimeout 必须容忍「返回同步值」的发现接口（实测 500：task.then is not a function）
  assert.deepEqual(await mod.__testingWithTimeout(['a', 'b'], 1000), ['a', 'b'], '同步值应原样返回')
  assert.equal(await mod.__testingWithTimeout(undefined, 1000), undefined, 'undefined 不应抛')
  assert.equal(await mod.__testingWithTimeout(Promise.resolve(42), 1000), 42, 'Promise 应正常')
  assert.equal(await mod.__testingWithTimeout(new Promise(() => {}), 10), undefined, '超时应返回 undefined')
  ok('withTimeout 容忍非 Promise 返回值')

  // GET：返回配置与检查点根
  const got = makeRes()
  await capturedRoute.handler(makeReq('GET'), got)
  const gotValue = JSON.parse(got.body)
  assert.equal(got.statusCode, 200)
  assert.equal(gotValue.ok, true)
  assert.equal(gotValue.config.thresholdPercent, undefined, '全局阈值已删除，不应再出现')
  assert.deepEqual(gotValue.config.thresholdByModel, { 'fake-provider/fake-model': 80 }, '按模型阈值应原样返回')
  assert.equal(gotValue.checkpointRoot, checkpointRoot)
  ok('GET /infinite-context/settings', `thresholdByModel=${JSON.stringify(gotValue.config.thresholdByModel)}`)

  // 405 / 400：不支持的方法与非法 patch 都不能写
  const wrongMethod = makeRes()
  await capturedRoute.handler(makeReq('DELETE'), wrongMethod)
  assert.equal(wrongMethod.statusCode, 405)

  const emptyPatch = makeRes()
  await capturedRoute.handler(makeReq('PUT', '{}'), emptyPatch)
  assert.equal(emptyPatch.statusCode, 400)
  assert.equal(JSON.parse(emptyPatch.body).code, 'empty-patch')

  const invalid = makeRes()
  await capturedRoute.handler(makeReq('PUT', JSON.stringify({ contextWindowByModel: { 'fake-provider/fake-model': 100_000 }, thresholdByModel: { 'fake-provider/fake-model': 999 } })), invalid)
  assert.equal(invalid.statusCode, 400)
  assert.equal(JSON.parse(invalid.body).code, 'invalid-config')
  assert.equal(editCalls.length, 0, '非法值绝不能触发写回')

  // reset：由宿主回填出厂默认（而不是发空串，数值字段会校验失败）
  const resetRes = makeRes()
  await capturedRoute.handler(makeReq('PUT', JSON.stringify({ reset: ['autoHandoff'] })), resetRes)
  assert.equal(resetRes.statusCode, 200, resetRes.body)
  assert.equal(editCalls[editCalls.length - 1].next.autoHandoff, false, 'reset 应回填出厂默认 false')
  ok('PUT reset（回填出厂默认）')
  ok('405 / 400（空与非法 patch 不写回）')

  // 200：合法保存 → configEditor.edit 收到完整 raw config
  const editsBeforeSave = editCalls.length
  const saved = makeRes()
  await capturedRoute.handler(makeReq('PUT', JSON.stringify({ autoHandoff: true, contextWindowByModel: { 'fake-provider/fake-model': 100_000 }, thresholdByModel: { 'fake-provider/fake-model': 75 } })), saved)
  assert.equal(saved.statusCode, 200, saved.body)
  assert.equal(JSON.parse(saved.body).ok, true)
  assert.equal(editCalls.length, editsBeforeSave + 1, '合法保存应写回一次')
  const written = editCalls[editCalls.length - 1].next
  for (const key of ['enabled', 'thresholdByModel', 'autoHandoff', 'checkpointMaxBytes', 'handoffBriefMaxChars', 'checkpointRoot', 'projectProgressReserveChars']) {
    assert.ok(written[key] !== undefined, `写回的 raw config 缺少字段 ${key}`)
  }
  assert.deepEqual(written.thresholdByModel, { 'fake-provider/fake-model': 75 })
  assert.equal(written.autoHandoff, true)
  assert.equal(editCalls[0].entry.id, 'include:infinite-context-orchestrator', '应命中本插件的行')
  ok('PUT 保存（configEditor 写完整 raw config）', 'thresholdByModel=75 autoHandoff=true')

  // ── G. 「不限制」哨兵：同一份大事实，小上限 vs 不限制，结果必须不同 ─────
  const manyTodos = Array.from({ length: 30 }, (_, index) => ({ content: `任务 ${index} ` + 'x'.repeat(180), status: 'pending' }))
  const originalStateOf = services.sessionProjections.stateOf
  services.sessionProjections.stateOf = (target, key) => {
    if (key === 'todos') return { todos: manyTodos }
    if (key === 'goal') return { objective: '不限制语义验证' }
    if (key === 'contextPressure') return { contextWindow: 100_000, pressureTokens: 50_000 }
    return originalStateOf(target, key)
  }

  const runHandoff = async (rootDir, config) => {
    const appends = []
    const banners = []
    const agent = {
      session: {
        ...session,
        id: `session-cap-${Math.random().toString(16).slice(2, 8)}`,
        header: { ...session.header, id: 'session-cap' },
        snapshotEvents: () => [],
        // 记录旧会话收到的事件（待办收尾会写一条 todo/write）
        append: (type, data) => { appends.push({ type, data }) },
      },
      inject: (message) => { banners.push({ kind: 'inject', message }) },
      followup: (message) => { banners.push({ kind: 'followup', message }) },
    }
    const harness = makeCtx()
    apply(harness.ctx, { enabled: true, contextWindowByModel: { 'fake-provider/fake-model': 100_000 }, thresholdByModel: { 'fake-provider/fake-model': 10 }, autoHandoff: true, checkpointRoot: rootDir, ...config })
    await harness.runPreStep(agent)
    const handoffDir = path.join(rootDir, 'handoffs')
    const file = readdirSync(handoffDir).filter((name) => name.endsWith('.json'))[0]
    const doc = JSON.parse(readFileSync(path.join(handoffDir, file), 'utf8'))
    const briefDir = path.join(rootDir, 'pending-briefs')
    const briefFile = readdirSync(briefDir)[0]
    const brief = JSON.parse(readFileSync(path.join(briefDir, briefFile), 'utf8'))
    return { doc, brief, appends, banners }
  }

  const cappedRoot = mkdtempSync(path.join(tmpdir(), 'ico-capped-'))
  const capped = await runHandoff(cappedRoot, { checkpointMaxBytes: 4096, handoffBriefMaxChars: 1000 })
  assert.ok(capped.doc.pending_todos.length < 30, `有上限时应裁剪 todo（实际 ${capped.doc.pending_todos.length}/30）`)
  assert.ok(capped.brief.text.length <= 1000, `有上限时简报不应超过 1000 字（实际 ${capped.brief.text.length}）`)
  ok('有上限时确实裁剪', `todo ${capped.doc.pending_todos.length}/30 · brief ${capped.brief.text.length} 字`)

  const unlimitedRoot = mkdtempSync(path.join(tmpdir(), 'ico-unlimited-'))
  const unlimited = await runHandoff(unlimitedRoot, {
    checkpointMaxBytes: 0,
    handoffBriefMaxChars: 0,
    projectProgressReserveChars: -1,
  })
  assert.equal(unlimited.doc.pending_todos.length, 30, '不限制时 30 条待办必须全部保留')
  assert.ok(unlimited.brief.text.includes('任务 29'), '不限制时简报必须带到最后一条待办')
  assert.ok(unlimited.brief.text.length > 1000, `不限制时简报不应受字数限制（实际 ${unlimited.brief.text.length}）`)
  ok('不限制时不裁剪', `todo 30/30 · brief ${unlimited.brief.text.length} 字`)

  services.sessionProjections.stateOf = originalStateOf

  // ── H. briefAuthor：模型撰写 + 失败回退 ────────────────────────────────
  let llmCalls = 0
  const MODEL_BRIEF = ['**当前目标**：用模型写一份交接。', '**已完成**：', '- 已经完成 A 与 B，结论是 C。', '**关键决策/约束**：', '- 不要改动 X 模块。'].join('\n')
  services.llm = {
    resolveModelInfo: async () => ({ context: { contextWindow: 100_000 } }),
    stream: (options) => {
      llmCalls += 1
      assert.ok(String(options?.system ?? '').includes('交接简报'), '模型调用的 system 应说明交接简报任务')
      assert.ok(String(options?.model ?? '').length > 0, '模型调用必须带 model')
      return (async function* generate() {
        yield { type: 'text-delta', text: MODEL_BRIEF }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }

  const modelRun = await runHandoff(mkdtempSync(path.join(tmpdir(), 'ico-model-')), { briefAuthor: 'model' })
  assert.ok(llmCalls >= 1, 'briefAuthor=model 时应调用一次模型')
  assert.ok(modelRun.brief.text.includes('已经完成 A 与 B'), '简报正文应来自模型撰写')
  assert.ok(modelRun.brief.text.includes('**待办**'), '仍要保留插件生成的待办锚点')
  assert.ok(modelRun.brief.text.includes('请从“待办”的第一项继续'), '仍要保留收尾指令')
  ok('模型撰写简报', `模型输出 ${MODEL_BRIEF.length} 字符，简报 ${modelRun.brief.text.length} 字符`)

  services.llm = {
    resolveModelInfo: async () => ({ context: { contextWindow: 100_000 } }),
    stream: () => {
      throw new Error('model down')
    },
  }
  const fallbackRun = await runHandoff(mkdtempSync(path.join(tmpdir(), 'ico-fallback-')), { briefAuthor: 'model' })
  assert.ok(fallbackRun.brief.text.includes('## 任务交接简报'), '模型失败时应回退到模板简报')
  assert.ok(!fallbackRun.brief.text.includes('已经完成 A 与 B'), '回退时不应包含模型内容')
  ok('模型失败回退模板', '换窗没有被阻断')

  llmCalls = 0
  services.llm = {
    resolveModelInfo: async () => ({ context: { contextWindow: 100_000 } }),
    stream: () => {
      llmCalls += 1
      throw new Error('should not be called')
    },
  }
  await runHandoff(mkdtempSync(path.join(tmpdir(), 'ico-plugin-')), {})
  assert.equal(llmCalls, 0, 'briefAuthor=plugin（默认）时不应调用模型')
  ok('默认不调用模型', 'briefAuthor=plugin')

  // ── I. 交接锚点（developer 消息）+ 开工校验 ───────────────────────────
  const appendCalls = []
  const anchorRoot = mkdtempSync(path.join(tmpdir(), 'ico-anchor-'))
  const realCreate = services.sessionController.create
  services.sessionController.create = async (request) => {
    const created = await realCreate(request)
    const agent = liveAgents.get(created.sessionId)
    // 真实宿主里是 session.append(type, data, opts)
    agent.session.append = (type, data) => {
      appendCalls.push({ sessionId: created.sessionId, type, data })
    }
    return created
  }

  const anchorRun = await runHandoff(anchorRoot, {})
  // 回归：**绝不能**在 turn 之外 append developer/message —— 那会把会话日志写成
  // SessionFormatError: developer/message does not match an open turn and step
  const developerWrite = appendCalls.find((call) => call.type === 'developer/message')
  assert.equal(developerWrite, undefined, '不应再写 developer/message（会破坏会话日志格式）')
  assert.ok(anchorRun.brief.text.startsWith('## 交接锚点'), '锚点应拼在简报最前面（随 system prompt 注入）')
  const anchorBriefText = anchorRun.brief.text
  assert.ok(anchorBriefText.includes('写 TS 源码'), '锚点应点名第一件待办')
  ok('交接锚点走简报前缀（不再写 developer 消息）', anchorBriefText.split('\n')[0].slice(0, 24) + '…')

  services.sessionController.create = realCreate

  // 开工校验：新会话首条 assistant 消息只说话不动手 → 补一次纠正
  const watchHarness = makeCtx()
  apply(watchHarness.ctx, { enabled: true, contextWindowByModel: { 'fake-provider/fake-model': 100_000 }, thresholdByModel: { 'fake-provider/fake-model': 10 }, autoHandoff: true, checkpointRoot: anchorRoot })
  await watchHarness.runPreStep(oldAgent)
  const monitored = createdSessions[createdSessions.length - 1].sessionId
  const followupCountBefore = followups.length
  const sessionEventHandler = watchHarness.handlers.get('session/event')
  assert.ok(sessionEventHandler !== undefined, 'session/event 处理器未注册')
  sessionEventHandler(
    { id: monitored },
    { type: 'assistant/message', data: { turn: 1, message: { role: 'assistant', content: [{ type: 'text', text: '好的，我先看一下。' }] } } },
  )
  const corrective = followups.slice(followupCountBefore).find((item) => item.sessionId === monitored)
  assert.ok(corrective !== undefined, '首条消息没开工时应补发纠正消息')
  assert.ok(String(corrective.message?.content?.[0]?.text ?? '').includes('继续执行待办第一项'), '纠正内容应点名待办')
  ok('开工校验（没动手 → 补纠正）')

  // 已经动手（带 tool-call）就不纠正
  const actedHarness = makeCtx()
  apply(actedHarness.ctx, { enabled: true, contextWindowByModel: { 'fake-provider/fake-model': 100_000 }, thresholdByModel: { 'fake-provider/fake-model': 10 }, autoHandoff: true, checkpointRoot: anchorRoot })
  await actedHarness.runPreStep(oldAgent)
  const monitored2 = createdSessions[createdSessions.length - 1].sessionId
  const before2 = followups.length
  actedHarness.handlers.get('session/event')(
    { id: monitored2 },
    { type: 'assistant/message', data: { turn: 1, message: { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'read', arguments: '{}' }] } } },
  )
  assert.equal(followups.length, before2, '已经调用工具时不应补纠正')
  ok('开工校验（已动手 → 不打扰）')

  // ── J. 清理后不再报「已不存在的检查点路径」 ──────────────────────────
  const cleanRoot = mkdtempSync(path.join(tmpdir(), 'ico-clean-'))
  await runHandoff(cleanRoot, {})
  rmSync(path.join(cleanRoot, 'handoffs'), { recursive: true, force: true })
  const cleanHarness = makeCtx()
  apply(cleanHarness.ctx, { enabled: true, contextWindowByModel: { 'fake-provider/fake-model': 100_000 }, thresholdByModel: { 'fake-provider/fake-model': 10 }, checkpointRoot: cleanRoot })
  const cleanStatus = await cleanHarness.tools.find((tool) => tool.name === 'infinite_context_status').execute({}, { agent: oldAgent })
  assert.equal(cleanStatus.lastCheckpointPath, null, '删掉 handoffs 后不应再报已不存在的检查点路径')
  ok('清理后状态不撒谎', 'lastCheckpointPath=null')

  // ── K. 回归：占用不可用时，工具结果仍必须是 lossless JSON ─────────────
  // 真实故障：occupancy 里带 `usedTokens: undefined` → 宿主判 "value is not lossless JSON"，
  // 换窗明明成功，模型却收到一个错误。
  const assertLossless = (value, where = '$') => {
    if (value === undefined) throw new Error(`undefined at ${where}`)
    if (typeof value === 'function') throw new Error(`function at ${where}`)
    if (value === null || typeof value !== 'object') return
    for (const [key, item] of Object.entries(value)) assertLossless(item, `${where}.${key}`)
  }

  const originalMeasure = services.tokenMeter.measure
  const originalStateOf2 = services.sessionProjections.stateOf
  const losslessHarness = makeCtx()
  services.tokenMeter.measure = () => {
    throw new Error('meter exploded')
  }
  services.sessionProjections.stateOf = (target, key) => (key === 'contextPressure' ? undefined : originalStateOf2(target, key))
  try {
    apply(losslessHarness.ctx, { enabled: true, contextWindowByModel: { 'fake-provider/fake-model': 100_000 }, thresholdByModel: { 'fake-provider/fake-model': 10 }, checkpointRoot: mkdtempSync(path.join(tmpdir(), 'ico-lossless-')) })

    // 用**新会话 id**：occupancy 有 4s 缓存，复用 oldAgent 会读到之前测到的正常值。
    const losslessAgent = { session: { ...session, id: 'session-lossless-0001', header: { ...session.header, id: 'session-lossless-0001' } }, inject: () => undefined }
    const statusTool2 = losslessHarness.tools.find((tool) => tool.name === 'infinite_context_status')
    const statusResult = await statusTool2.execute({}, { agent: losslessAgent })
    assertLossless(statusResult)
    assert.equal(statusResult.occupancy.basis, 'unavailable')
    assert.ok(
      String(statusResult.notes.join(' ')).includes('meter exploded'),
      '状态里应带上 tokenMeter 的真实错误，而不是笼统的「拿不到」',
    )
    ok('占用不可用：状态结果 lossless 且带诊断', String(statusResult.notes[0] ?? '').slice(0, 44))

    const handoffTool2 = losslessHarness.tools.find((tool) => tool.name === 'infinite_context_handoff')
    const handoffResult = await handoffTool2.execute({ reason: 'lossless 回归' }, { agent: losslessAgent })
    assertLossless(handoffResult)
    assert.equal(handoffResult.ok, true, `占用未知时手动换窗也应成功（实际 code=${handoffResult.code}）`)
    ok('占用不可用：换窗结果 lossless', handoffResult.newSessionId)
  } finally {
    services.tokenMeter.measure = originalMeasure
    services.sessionProjections.stateOf = originalStateOf2
  }

  // ── L. markTodosHandedOff：交接后给旧会话的待办收尾 ─────────────────
  const marked = await runHandoff(mkdtempSync(path.join(tmpdir(), 'ico-marked-')), {})
  const todoWrites = (marked.appends ?? []).filter((item) => item.type === 'todo/write')
  assert.equal(todoWrites.length, 1, '默认应给旧会话写一条 todo/write 快照')
  assert.ok(
    todoWrites[0].data.todos.every((todo) => todo.status === 'completed'),
    '收尾后所有待办都应是 completed',
  )
  assert.ok(
    todoWrites[0].data.todos.some((todo) => todo.content.includes('写 TS 源码')),
    '收尾不应改写待办文本',
  )
  ok('交接后收尾旧待办', `${todoWrites[0].data.todos.length} 项 → completed`)

  const notMarked = await runHandoff(mkdtempSync(path.join(tmpdir(), 'ico-notmarked-')), { markTodosHandedOff: false })
  assert.equal(
    (notMarked.appends ?? []).filter((item) => item.type === 'todo/write').length,
    0,
    '关掉开关后不应改旧会话的待办',
  )
  ok('开关可关闭（保持原样）')

  // ── M. notifyTransferredSession：换窗后在旧窗口提醒「任务已转移」──────
  const textOf = (banner) => String(banner?.message?.content?.[0]?.text ?? '')
  const transferOn = await runHandoff(mkdtempSync(path.join(tmpdir(), 'ico-transfer-on-')), {})
  // 现在把提示 **append 成 user/message**（立刻可见），而不是 inject（只进收件箱、空闲窗口看不到）。
  const appendedNotice = transferOn.appends.find((item) => item.type === 'user/message'
    && String(item.data?.content?.[0]?.text ?? '').includes('本窗口的任务已转移到新会话'))
  assert.ok(appendedNotice !== undefined, '默认应把「任务已转移」写进旧会话日志')
  assert.equal(appendedNotice.data?.role, 'user', '转移提示应是 user 消息（格式允许 turn 外写入）')
  const bannerText = String(appendedNotice.data?.content?.[0]?.text ?? '')
  assert.equal(
    transferOn.appends.filter((item) => item.type === 'developer/message').length,
    0,
    '不应写 developer/message（要求 open turn，会写坏日志）',
  )
  assert.ok(bannerText.includes('新会话：'), '提醒应带上新会话 id')
  assert.ok(bannerText.includes('不要在这里继续执行工作'), '提醒应禁止旧窗口继续干活')
  assert.ok(!transferOn.banners.some((banner) => banner.kind === 'followup'), '不应再唤醒旧窗口（无 followup）')
  ok('换窗后提醒旧窗口（inject，不唤醒）', bannerText.split('\n')[0].slice(0, 26) + '…')

  // 回归：developer/message 要求 open turn（写坏过日志），所以只能用 user/message。
  const developerAppend = transferOn.appends.find((item) => item.type === 'developer/message')
  assert.equal(developerAppend, undefined, '旧窗口不应再收到 developer/message（会破坏会话日志）')
  ok('旧窗口提示走 user/message（不写 developer、不唤醒）')

  const transferOff = await runHandoff(mkdtempSync(path.join(tmpdir(), 'ico-transfer-off-')), { notifyTransferredSession: false })
  assert.ok(!transferOff.banners.some((banner) => textOf(banner).includes('本窗口的任务已转移到新会话')), '关掉后不应再发转移提示')
  ok('关掉后不打扰旧窗口')

  // ── M2. A：已交接过的会话不再自动换窗；B：交接后叫停旧会话 ─────────────
  {
    cancelCalls.length = 0
    const alreadyRoot = mkdtempSync(path.join(tmpdir(), 'ico-already-'))
    const alreadyAgent = {
      session: {
        ...session,
        id: 'session-already-0001',
        header: { ...session.header, id: 'session-already-0001' },
        snapshotEvents: () => [],
        append: () => undefined,
      },
      inject: () => undefined,
      followup: () => undefined,
    }
    const alreadyHarness = makeCtx()
    apply(alreadyHarness.ctx, {
      enabled: true,
      contextWindowByModel: { 'fake-provider/fake-model': 100_000 }, thresholdByModel: { 'fake-provider/fake-model': 10 },
      autoHandoff: true,
      checkpointRoot: alreadyRoot,
    })

    // 第一次：正常交接，并叫停旧会话
    await alreadyHarness.runPreStep(alreadyAgent)
    assert.equal(cancelCalls.length, 1, '交接成功后应叫停旧会话当前轮')
    assert.equal(cancelCalls[0].sessionId, 'session-already-0001', '叫停的应是旧会话')
    ok('B：交接后叫停旧会话当前轮')

    // 第二次：该会话已有检查点 → 不再自动换窗（也不会再叫停）
    const beforeSecond = cancelCalls.length
    const injectedBefore = injected.length
    await alreadyHarness.runPreStep(alreadyAgent)
    assert.equal(cancelCalls.length, beforeSecond, '已交接的会话不应再次换窗')
    assert.equal(injected.length, injectedBefore, '已交接的会话也不应再发临界提醒')
    ok('A：已交接的会话不再自动换窗（重启后依然有效）')
  }

  // ── O. 按模型窗口 + 按模型阈值 ────────────────────────────────────────
  // 固定 fixture：used=12,000 / DSH window=100,000（12%）；按模型 64,000 → 18.8%。
  const originalStateOf4 = services.sessionProjections.stateOf
  services.sessionProjections.stateOf = (target, key) => (
    key === 'contextPressure' ? { contextWindow: 100_000, pressureTokens: 12_000 } : originalStateOf4(target, key)
  )
  try {
    const winHarness = makeCtx()
    apply(winHarness.ctx, {
      enabled: true,
      contextWindowByModel: { 'fake-provider/fake-model': 64_000 },
      thresholdByModel: { 'fake-provider/fake-model': 15 },
      checkpointRoot: mkdtempSync(path.join(tmpdir(), 'ico-window-')),
    })
    const beforeWin = injected.length
    await winHarness.runPreStep(oldAgent)
    assert.equal(injected.length, beforeWin + 1, '12,000 / 64,000 = 18.8% ≥ 15% 应触发（按 DSH 值只有 12%）')
    const winNotice = String(injected[injected.length - 1]?.content?.[0]?.text ?? '')
    assert.ok(winNotice.includes('18.8%'), `占用应按按模型窗口算（实际：${winNotice.slice(0, 70)}）`)
    ok('按模型窗口参与百分比', '18.8% = 12,000 / 64,000')

    const winStatus = await winHarness.tools.find((tool) => tool.name === 'infinite_context_status')
      .execute({}, { agent: oldAgent })
    assert.ok(String(winStatus.message).includes('64,000（按模型自定，生效）'), '状态应显示按模型窗口生效')
    assert.ok(String(winStatus.message).includes('DSH 读取 100,000'), '状态应同时显示 DSH 读到的值')
    assert.ok(String(winStatus.message).includes('当前模型：fake-provider/fake-model'), '状态应显示当前模型')
    assert.ok(String(winStatus.message).includes('按模型策略：已纳入管理'), '状态应说明已纳入管理')
    ok('状态同时给出 DSH 读取与按模型值')
  } finally {
    services.sessionProjections.stateOf = originalStateOf4
  }


  // ── P. 找不到 Workspace 归属时退回 cwd（旧行为，不能崩）────────────────
  const savedRegistry = services.workspaceRegistry
  services.workspaceRegistry = { list: () => [] }
  try {
    const noWsHarness = makeCtx()
    apply(noWsHarness.ctx, { enabled: true, contextWindowByModel: { 'fake-provider/fake-model': 100_000 }, thresholdByModel: { 'fake-provider/fake-model': 10 }, checkpointRoot: mkdtempSync(path.join(tmpdir(), 'ico-nows-')) })
    const noWsTool = noWsHarness.tools.find((tool) => tool.name === 'infinite_context_handoff')
    const noWs = await noWsTool.execute({ reason: '无分组场景' }, { agent: oldAgent })
    assert.equal(noWs.ok, true, '无分组时也应能换窗（' + noWs.code + '）')
    const noWsCreate = createdSessions.find((item) => item.sessionId === noWs.newSessionId)
    assert.ok(noWsCreate !== undefined, '应记录 create 请求')
    assert.equal(noWsCreate.request.workspaceId, undefined, '没有归属时不应传 workspaceId')
    assert.equal(typeof noWsCreate.request.cwd, 'string', '没有归属时应退回 cwd')
    ok('无分组时退回 cwd', noWsCreate.request.cwd)

    // 真机故障回归：拿不到 workspaceRegistry 时（属性访问会抛）交接不能失败
    services.workspaceRegistry = undefined
    const noRegHarness = makeCtx()
    apply(noRegHarness.ctx, { enabled: true, contextWindowByModel: { 'fake-provider/fake-model': 100_000 }, thresholdByModel: { 'fake-provider/fake-model': 10 }, checkpointRoot: mkdtempSync(path.join(tmpdir(), 'ico-noreg-')) })
    const noRegTool = noRegHarness.tools.find((tool) => tool.name === 'infinite_context_handoff')
    const noReg = await noRegTool.execute({ reason: '无注册表场景' }, { agent: oldAgent })
    assert.equal(noReg.ok, true, '拿不到 workspaceRegistry 时交接也必须成功（' + (noReg.code ?? '') + '）')
    const noRegCreate = createdSessions.find((item) => item.sessionId === noReg.newSessionId)
    assert.equal(typeof noRegCreate.request.cwd, 'string', '此时应退回 cwd')
    ok('服务不可用不打断交接（退回 cwd）', noRegCreate.request.cwd)
  } finally {
    services.workspaceRegistry = savedRegistry
  }

  // ── Q. maxAutoHandoffs 默认 10：连续两个窗口都能自动换窗 ────────────────
  // 真机故障：本地 64K 模型每个窗口只能干 2-3 万 tokens，旧版写死「每进程 1 次」，
  // 第二个窗口到线时只会发一句「已到上限」，随后被服务端 400 打断。
  const stateOfQ = services.sessionProjections.stateOf
  services.sessionProjections.stateOf = (target, key) => (
    key === 'contextPressure' ? { contextWindow: 100_000, pressureTokens: 90_000 } : stateOfQ(target, key)
  )
  try {
    const qHarness = makeCtx()
    apply(qHarness.ctx, {
      enabled: true,
      contextWindowByModel: { 'fake-provider/fake-model': 100_000 }, thresholdByModel: { 'fake-provider/fake-model': 80 },
      autoHandoff: true,
      checkpointRoot: mkdtempSync(path.join(tmpdir(), 'ico-multi-')),
    })
    const beforeQ = createdSessions.length
    const agentQ1 = { session: { ...session, id: 'session-q-1', header: { ...session.header, id: 'session-q-1' } }, inject: () => undefined }
    const agentQ2 = { session: { ...session, id: 'session-q-2', header: { ...session.header, id: 'session-q-2' } }, inject: () => undefined }
    await qHarness.runPreStep(agentQ1)
    await qHarness.runPreStep(agentQ2)
    assert.equal(createdSessions.length - beforeQ, 2, `两个窗口都应自动换窗（实际 ${createdSessions.length - beforeQ} 次）`)
    ok('maxAutoHandoffs 默认 10（连续两次都换窗）')
  } finally {
    services.sessionProjections.stateOf = stateOfQ
  }

  // ── R. 步内暴涨：step/end 之后占用缓存必须失效 ────────────────────────
  // 真机故障：一个 step 里连读三个文件（≈3.5 万 tokens），上下文 1.4 万 → 约 5 万；
  // 若下一个 pre-step 仍吃到 4 秒缓存里的旧值，插件就以为只有 22%，不会换窗，
  // 紧接着的请求直接被服务端 400 打断。
  const stateOfR = services.sessionProjections.stateOf
  let pressureR = 12_000
  services.sessionProjections.stateOf = (target, key) => (
    key === 'contextPressure' ? { contextWindow: 100_000, pressureTokens: pressureR } : stateOfR(target, key)
  )
  try {
    const rHarness = makeCtx()
    apply(rHarness.ctx, {
      enabled: true,
      contextWindowByModel: { 'fake-provider/fake-model': 100_000 }, thresholdByModel: { 'fake-provider/fake-model': 80 },
      autoHandoff: true,
      checkpointRoot: mkdtempSync(path.join(tmpdir(), 'ico-jump-')),
    })
    const agentR = {
      session: { ...session, id: 'session-r-1', header: { ...session.header, id: 'session-r-1' } },
      inject: () => undefined,
    }
    const beforeR = createdSessions.length
    await rHarness.runPreStep(agentR)
    assert.equal(createdSessions.length, beforeR, '12% 时不应换窗')

    pressureR = 90_000
    rHarness.handlers.get('session/event')({ id: 'session-r-1' }, { type: 'step/end', data: {} })
    await rHarness.runPreStep(agentR)
    assert.equal(createdSessions.length, beforeR + 1, 'step/end 后应看到真实占用并换窗')
    ok('step/end 后占用缓存失效（看到步内暴涨）')
  } finally {
    services.sessionProjections.stateOf = stateOfR
  }

  // ── T. 按模型阈值 + 未纳入管理的模型 ────────────────────────────────
  const originalStateOfT = services.sessionProjections.stateOf
  services.sessionProjections.stateOf = (target, key) => (
    key === 'contextPressure' ? { contextWindow: 100_000, pressureTokens: 60_000 } : originalStateOfT(target, key)
  )
  try {
    const mkAgent = (id) => ({
      session: { ...session, id, header: { ...session.header, id } },
      inject: (message) => injected.push(message),
    })

    // 1) 只配了别的模型 → 本模型未纳入管理 → 不提醒（1M 云端会话不被误触发的关键）
    const t1 = makeCtx()
    apply(t1.ctx, {
      enabled: true,
      thresholdByModel: { 'other/model': 10 },
      contextWindowByModel: { 'other/model': 64_000 },
      checkpointRoot: mkdtempSync(path.join(tmpdir(), 'ico-policy1-')),
    })
    const beforeT1 = injected.length
    await t1.runPreStep(mkAgent('session-policy-0001'))
    assert.equal(injected.length, beforeT1, '未纳入管理的模型不应被提醒')
    ok('未纳入管理的模型不提醒')

    // 2) 该模型自己的阈值高于全局 → 60% 不到 70%，不触发
    const t2 = makeCtx()
    apply(t2.ctx, {
      enabled: true,
      contextWindowByModel: { 'fake-provider/fake-model': 100_000 }, thresholdByModel: { 'fake-provider/fake-model': 70 },
      checkpointRoot: mkdtempSync(path.join(tmpdir(), 'ico-policy2-')),
    })
    const beforeT2 = injected.length
    await t2.runPreStep(mkAgent('session-policy-0002'))
    assert.equal(injected.length, beforeT2, '按模型阈值 70% > 当前 60%，不应触发')
    ok('按模型阈值生效（70% 不触发）')

    // 3) 该模型阈值 50% → 触发，且提示里写的是 50%
    const t3 = makeCtx()
    apply(t3.ctx, {
      enabled: true,
      contextWindowByModel: { 'fake-provider/fake-model': 100_000 },
      thresholdByModel: { 'fake-provider/fake-model': 50 },
      checkpointRoot: mkdtempSync(path.join(tmpdir(), 'ico-policy3-')),
    })
    const beforeT3 = injected.length
    await t3.runPreStep(mkAgent('session-policy-0003'))
    assert.equal(injected.length, beforeT3 + 1, '按模型阈值 50% < 当前 60%，应触发')
    assert.ok(String(injected[injected.length - 1]?.content?.[0]?.text ?? '').includes('50%'), '提示里的阈值应来自按模型配置')
    ok('按模型阈值触发并显示在提示里')

    // 4) 阈值 0 = 该模型不启用百分比线
    const t4 = makeCtx()
    apply(t4.ctx, {
      enabled: true,
      contextWindowByModel: { 'fake-provider/fake-model': 100_000 },
      thresholdByModel: { 'fake-provider/fake-model': 0 },
      checkpointRoot: mkdtempSync(path.join(tmpdir(), 'ico-policy4-')),
    })
    const beforeT4 = injected.length
    await t4.runPreStep(mkAgent('session-policy-0004'))
    assert.equal(injected.length, beforeT4, '阈值 0 = 不启用百分比线，不应触发')
    ok('按模型阈值 0 = 不启用')
  } finally {
    services.sessionProjections.stateOf = originalStateOfT
  }

  // ── M3. 原始需求：链上继承 + 简报固定段落 + 落盘 ──────────────────────
  {
    const originalText = '—— ## 任务 请用单个 HTML 文件实现一个名为 Cyber Dino Run 的浏览器游戏，' + '细节要求'.repeat(60)
    const chainRoot = mkdtempSync(path.join(tmpdir(), 'ico-original-'))
    const longEvents = [
      {
        type: 'user/message',
        seq: 1,
        data: { role: 'user', id: 'u1', content: [{ type: 'text', text: originalText }], source: { kind: 'user' } },
      },
    ]
    const chainSession = {
      ...session,
      id: 'session-original-0001',
      header: { ...session.header, id: 'session-original-0001' },
      snapshotEvents: () => longEvents,
      append: () => undefined,
    }
    const chainAgent = { session: chainSession, inject: () => undefined, followup: () => undefined }
    const chainHarness = makeCtx()
    apply(chainHarness.ctx, {
      enabled: true,
      contextWindowByModel: { 'fake-provider/fake-model': 100_000 }, thresholdByModel: { 'fake-provider/fake-model': 10 },
      autoHandoff: true,
      checkpointRoot: chainRoot,
    })
    await chainHarness.runPreStep(chainAgent)

    const doc = JSON.parse(readFileSync(path.join(chainRoot, 'handoffs', 'session-original-0001.json'), 'utf8'))
    assert.equal(doc.original_request, originalText, '检查点应原样带上原始需求')
    assert.equal(doc.original_request_chars, originalText.length, '应记录原始需求长度')
    ok('检查点写入原始需求', originalText.length + ' 字符')

    const briefDir = path.join(chainRoot, 'pending-briefs')
    const briefFile = readdirSync(briefDir).find((name) => name.endsWith('.json'))
    const briefJson = JSON.parse(readFileSync(path.join(briefDir, briefFile), 'utf8'))
    const briefText = String(briefJson.text ?? briefJson.brief ?? '')
    assert.ok(briefText.includes('## 原始需求'), '简报必须含「## 原始需求」固定段落')
    assert.ok(briefText.includes('Cyber Dino Run'), '简报应带上需求原文')
    ok('简报含原始需求原文')

    const inheritedSession = {
      ...session,
      id: 'session-original-0002',
      header: { ...session.header, id: 'session-original-0002' },
      snapshotEvents: () => [],
      append: () => undefined,
    }
    const inheritedAgent = { session: inheritedSession, inject: () => undefined, followup: () => undefined }
    const inheritedHarness = makeCtx()
    apply(inheritedHarness.ctx, {
      enabled: true,
      contextWindowByModel: { 'fake-provider/fake-model': 100_000 }, thresholdByModel: { 'fake-provider/fake-model': 10 },
      autoHandoff: true,
      checkpointRoot: chainRoot,
    })
    await inheritedHarness.runPreStep(inheritedAgent)
    const doc2 = JSON.parse(readFileSync(path.join(chainRoot, 'handoffs', 'session-original-0002.json'), 'utf8'))
    assert.equal(doc2.original_request, originalText, '新窗口应继承上一份检查点的原始需求')
    ok('链上继承原始需求')

    const requirementDir = path.join(chainRoot, 'requirements')
    const requirementFiles = existsSync(requirementDir) ? readdirSync(requirementDir) : []
    assert.ok(requirementFiles.length >= 1, '应把原始需求落盘到 requirements/')
    assert.ok(readFileSync(path.join(requirementDir, requirementFiles[0]), 'utf8').includes('Cyber Dino Run'), '落盘文件应含需求原文')
    ok('原始需求落盘（requirements/）')
  }

  console.log(`\n冒烟测试通过（${results.length} 项）：\n${results.join('\n')}\n`)
  console.log(`工作区: ${workdir}`)
  console.log(`检查点: ${checkpointRoot}`)
}

main().catch((error) => {
  console.error('\n冒烟测试失败：')
  console.error(error)
  process.exitCode = 1
})
