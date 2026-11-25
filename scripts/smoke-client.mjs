// 客户端冒烟测试：在最小 React 渲染器里**真正渲染设置面板**，模拟点击/输入并检查提交内容。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const source = readFileSync(path.join(here, '..', 'client.js'), 'utf8')

// ── 最小 React（带 deps 的 useEffect，避免无限重渲染）─────────────────────
function createElement(type, props, ...children) {
  const flat = children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false)
  return { type, props: props ?? {}, children: flat }
}

let currentInstance = null
const reactApi = {
  createElement,
  useState(initial) {
    const instance = currentInstance
    const index = instance.index++
    if (instance.hooks[index] === undefined) instance.hooks[index] = initial
    const set = (value) => {
      instance.hooks[index] = typeof value === 'function' ? value(instance.hooks[index]) : value
      instance.dirty = true
    }
    return [instance.hooks[index], set]
  },
  useEffect(effect, deps) {
    const instance = currentInstance
    const index = instance.index++
    const previous = instance.effectDeps[index]
    const changed = previous === undefined
      || deps === undefined
      || deps.length !== previous.deps.length
      || deps.some((value, i) => !Object.is(value, previous.deps[i]))
    if (changed) {
      instance.pendingEffects.push(effect)
      instance.effectDeps[index] = { deps }
    }
  },
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

class Instance {
  constructor(component) {
    this.component = component
    this.hooks = []
    this.effectDeps = []
    this.pendingEffects = []
    this.index = 0
    this.dirty = false
    this.tree = null
    this.renders = 0
  }

  /** 渲染 + 跑本轮新注册的 effect；如果 effect 里 setState，就再渲染，最多 50 轮。 */
  render() {
    let guard = 0
    do {
      this.dirty = false
      this.index = 0
      this.pendingEffects = []
      this.renders += 1
      const previous = currentInstance
      currentInstance = this
      try {
        this.tree = this.component({})
      } finally {
        currentInstance = previous
      }
      const effects = this.pendingEffects
      this.pendingEffects = []
      for (const effect of effects) {
        try { effect() } catch { /* 副作用失败不影响断言 */ }
      }
      guard += 1
      if (guard > 50) throw new Error('渲染次数过多（疑似无限重渲染）')
    } while (this.dirty)
    return this.tree
  }
}

// ── 假宿主 ────────────────────────────────────────────────────────────────
const config = {
  enabled: true,
  autoHandoff: true,
  maxAutoHandoffs: 10,
  thresholdByModel: {},
  contextWindowByModel: {},
  markTodosHandedOff: true,
  notifyTransferredSession: true,
  checkpointMaxBytes: 65536,
  handoffBriefMaxChars: 4000,
  checkpointRoot: 'C:/checkpoints',
  projectProgressReserveChars: 1200,
  briefAuthor: 'plugin',
}
const modelsPayload = {
  ok: true,
  providers: [{ id: 'ninfer1', models: [{ id: 'swift-1.5', name: 'Swift 1.5', contextWindow: 204_800 }] }],
}
const calls = []
const fetchImpl = async (url, init) => {
  calls.push({ url, method: init?.method ?? 'GET', body: init?.body === undefined ? undefined : JSON.parse(init.body) })
  if (init?.method === 'PUT') {
    const patch = JSON.parse(init.body)
    Object.assign(config, patch)
    const body = JSON.stringify({ ok: true, applied: { ...config } })
    return { ok: true, status: 200, text: async () => body, json: async () => JSON.parse(body) }
  }
  const payload = String(url).includes('models=1')
    ? modelsPayload
    : { ok: true, config: { ...config }, checkpointRoot: config.checkpointRoot, probe: null }
  const body = JSON.stringify(payload)
  return { ok: true, status: 200, text: async () => body, json: async () => JSON.parse(body) }
}

let loaded = null
globalThis.window = { __ModuleLoader__: { load: (definition) => { loaded = definition } } }
const run = new Function('window', 'fetch', source)
run(globalThis.window, fetchImpl)
assert.ok(loaded !== null && loaded.id === 'dsh-infinite-context-orchestrator', '应通过 __ModuleLoader__ 注册')

const exported = loaded.factory((name) => (name === 'react' ? reactApi : {}))
let registered = null
exported.apply({
  slots: {
    inject: (_slot, callback) => callback(),
    register: (definition, component) => { registered = { definition, component } },
  },
})
assert.ok(registered !== null, '应注册 settings.section')
assert.equal(registered.definition.id, 'infinite-context')
console.log('  ✓ 注册 settings.section')

// ── 渲染工具 ──────────────────────────────────────────────────────────────
const collectText = (node) => {
  if (node === null || typeof node !== 'object') return []
  const own = node.children ?? []
  const text = own.filter((child) => typeof child === 'string' || typeof child === 'number').map(String)
  const nested = own.filter((child) => typeof child === 'object').flatMap((child) => collectText(child))
  return [...text, ...nested]
}
const findAll = (node, predicate) => {
  if (node === null || typeof node !== 'object') return []
  const hits = predicate(node) ? [node] : []
  for (const child of node.children ?? []) {
    if (typeof child === 'object') hits.push(...findAll(child, predicate))
  }
  return hits
}
const findNode = (node, predicate) => findAll(node, predicate)[0]

const instance = new Instance(registered.component)
let page = instance.render()
assert.ok(collectText(page).join('|').includes('正在读取设置'), '首屏应显示读取中')
console.log('  ✓ 首屏 loading')

await tick()
page = instance.render()
const text = collectText(page).join('|')
for (const label of ['任务自动换窗', '启用', '按模型设窗口与阈值', '自动换新窗口']) {
  assert.ok(text.includes(label), `缺少主区文案「${label}」`)
}
assert.ok(!text.includes('多满算'), '全局阈值设置应已删除')
console.log('  ✓ 主区：启用 / 按模型窗口与阈值 / 自动换窗')

// ── 模型列表 ──────────────────────────────────────────────────────────────
const loadBtn = findNode(page, (node) => node.type === 'button' && collectText(node).join('') === '读取模型列表')
assert.ok(loadBtn !== undefined, '应有「读取模型列表」按钮')
loadBtn.props.onClick()
await tick()
await tick()
page = instance.render()
const modelsText = collectText(page).join('|')
assert.ok(modelsText.includes('ninfer1/swift-1.5'), '应渲染出读取到的模型')
assert.ok(!modelsText.includes('未知'), 'DSH 声明未知时不应显示「未知」')
assert.ok(modelsText.includes('不设置'), '未填时应显示「不设置」')
console.log('  ✓ 读取模型列表 → 窗口 / 阈值 未填即「不设置」')

const rowInputs = () => findAll(page, (node) => node.type === 'input' && node.props?.placeholder === '不设置')
let boxes = rowInputs()
assert.ok(boxes.length >= 2, `模型行应有窗口与阈值两个输入（实际 ${boxes.length}）`)
console.log('  ✓ 每行两个数值输入（窗口 / 阈值）')

// 窗口：填值 → 失焦提交
boxes[0].props.onChange({ target: { value: '47616' } })
await tick()
page = instance.render()
boxes = rowInputs()
boxes[0].props.onBlur()
await tick()
const windowPut = [...calls].reverse().find((call) => call.method === 'PUT')
assert.deepEqual(windowPut.body, { contextWindowByModel: { 'ninfer1/swift-1.5': 47616 } }, '窗口应提交到 contextWindowByModel')
console.log('  ✓ 提交窗口', JSON.stringify(windowPut.body))

// 阈值：填值 → 失焦提交
page = instance.render()
boxes = rowInputs()
boxes[1].props.onChange({ target: { value: '60' } })
await tick()
page = instance.render()
boxes = rowInputs()
boxes[1].props.onBlur()
await tick()
const thresholdPut = [...calls].reverse().find((call) => call.method === 'PUT')
assert.deepEqual(thresholdPut.body, { thresholdByModel: { 'ninfer1/swift-1.5': 60 } }, '阈值应提交到 thresholdByModel')
console.log('  ✓ 提交阈值', JSON.stringify(thresholdPut.body))

// ── 高级项 ────────────────────────────────────────────────────────────────
const expandBtn = findNode(page, (node) => node.type === 'button' && collectText(node).join('') === '展开')
assert.ok(expandBtn !== undefined, '应有「展开」按钮')
expandBtn.props.onClick()
page = instance.render()
const advancedText = collectText(page).join('|')
assert.ok(advancedText.includes('交接简报字数上限'), '展开后应出现高级项')
assert.ok(advancedText.includes('不限制'), '数值项应带「不限制」')
console.log('  ✓ 高级项展开')

// ── i18n：接上宿主 locale 服务后，主区应跟着变英文 ────────────────────────
{
  let dictionaries = null
  let localeRegistered = false
  let englishRegistered = null
  const localeCtx = {
    slots: {
      inject: (_slot, callback) => callback(),
      register: (definition, component) => { englishRegistered = { definition, component } },
    },
    effect: (fn) => fn(),
    locale: {
      register: (namespace, dicts) => { dictionaries = dicts; localeRegistered = namespace },
      bind: () => (key) => dictionaries?.en?.[key] ?? dictionaries?.zh?.[key] ?? key,
    },
  }
  exported.apply(localeCtx)
  assert.equal(localeRegistered, 'infiniteContext', '应注册 infiniteContext 命名空间')
  assert.ok(dictionaries?.zh?.sectionTitle === '任务自动换窗', '应有中文词典')
  assert.ok(dictionaries?.en?.sectionTitle === 'Auto Handoff', '应有英文词典')
  assert.equal(englishRegistered.definition.label(), 'Auto Handoff', '分区标题应跟随语言')

  const englishInstance = new Instance(englishRegistered.component)
  englishInstance.render()
  await tick()
  const englishPage = englishInstance.render()
  const englishText = collectText(englishPage).join('|')
  for (const label of ['Auto Handoff', 'Enabled', 'Per-model window & threshold', 'Auto-handoff']) {
    assert.ok(englishText.includes(label), '英文界面缺少「' + label + '」')
  }
  assert.ok(!englishText.includes('任务自动换窗'), '英文界面不应出现中文分区名')
  console.log('  ✓ 主区文案跟随宿主语言（zh / en）')
}

console.log('\n客户端冒烟测试通过（9 项）：真实渲染 + 交互提交 + i18n')
