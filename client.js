/**
 * dsh-infinite-context-orchestrator — 浏览器端半件（手写 __ModuleLoader__ bundle）。
 *
 * ## 硬约束（每条都踩过坑）
 *
 * 1. 只注册 `settings.section` 一个座位（`plugins.row.config` 会串到别的插件配置页）。
 * 2. 注册必须包在 `ctx.slots.inject(slot, () => slots.register({name,id,order,label}, C))` 里。
 * 3. 配置读写用同源 `fetch('/infinite-context/settings')`（本机客户端服务目录里没有
 *    `configForms`），未认证 401 属正常 fail-closed；空 body 说明宿主没挂上路由。
 * 4. 保存后必须用响应里的 `applied`（路由闭包里的 `config` 是插件实例创建时的旧值，
 *    回读它会让 UI 弹回旧值，表现为「要点好几次」）。
 * 5. React 只用 16.8 起就有的 `createElement / useState / useEffect`
 *    （`useSyncExternalStore` 是 18 才有，用了整页白屏）。
 * 6. 配色只用宿主 `Theme` 服务里真实存在的 `--dsw-alias-*` 令牌；选中态用半透明底 +
 *    品牌色文字（品牌色填充 + 白字在暗色主题下会变成白底白字）。
 *
 * ## 交互
 *
 * 主区三件即时生效：启用开关、阈值（快捷档 + 滑块 + 自定义数值）、自动换窗。
 * 高级项也是即时生效（失焦/回车提交），每个数值带「不限制」：写 0（或 -1）作为哨兵。
 */

window.__ModuleLoader__.load({
  id: 'dsh-infinite-context-orchestrator',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const react = require('react')
    const el = react.createElement

/**
 * 主区文案（zh / en）。DSH 的 locale 服务用 8 个语言 id；
 * 这里只提供 zh 与 en，其余语言统一回落到 en（保证不出现空白标签）。
 */
const MESSAGES = {
  zh: {
    sectionTitle: '任务自动换窗',
    lead1: '对话越长，上下文越容易满。开启后，接近临界时它会先把进度写成检查点，再开一个新窗口，',
    lead2: '并把任务摘要放到新窗口最前面，这样长任务可以一直做下去。',
    loading: '正在读取设置…',
    configError: '读不到插件配置：',
    configErrorHint: '页面会显示 HTTP 状态：401 是连接认证，404 是宿主没挂上设置接口（重启 DSH）。',
    renderFailed: '这个设置页渲染失败：',
    enableTitle: '启用',
    enableOn: '已开启：接近临界时会提醒，并在允许时换窗。',
    enableOff: '已关闭：插件完全不动作。',
    modelsTitle: '按模型设窗口与阈值',
    modelsHint: '从 DSH 读取模型列表，逐个填「窗口 + 阈值」。只管理这里列出的模型；没列出的模型插件不介入。',
    modelsLoad: '读取模型列表',
    modelsCollapse: '收起模型列表',
    readFailed: '读取失败：',
    autoTitle: '自动换新窗口',
    autoOn: '已开启：到阈值就自动换窗，你什么都不用点。',
    autoOff: '已关闭：只提醒你，确认后再手动换（更安全）。',
    advancedTitle: '高级',
    advancedHint: '一般不用改，改完即时生效；每个数值都可以选「不限制」。',
    expand: '展开',
    collapse: '收起',
    declared: 'DSH 声明',
    window: '窗口',
    threshold: '阈值',
    notSet: '不设置',
    manualTitle: '手动添加模型',
    manualHint: '自动读取没列出来的模型，也可以在这里加。',
    manualKeyPlaceholder: 'provider/模型名',
    add: '添加',
    remove: '删除',
  },
  en: {
    sectionTitle: 'Auto Handoff',
    lead1: 'The longer the conversation, the fuller the context gets. When enabled, near the limit it first writes a checkpoint, then opens a new window',
    lead2: 'and puts the task summary at the top of the new window, so long tasks can keep going.',
    loading: 'Loading settings…',
    configError: 'Cannot read plugin config: ',
    configErrorHint: 'The page shows HTTP status: 401 means connection auth, 404 means the host did not mount the settings route (restart DSH).',
    renderFailed: 'This settings page failed to render: ',
    enableTitle: 'Enabled',
    enableOn: 'On: it warns near the limit and hands off when allowed.',
    enableOff: 'Off: the plugin does nothing.',
    modelsTitle: 'Per-model window & threshold',
    modelsHint: 'Load the model list from DSH, then fill "window + threshold" for each. Only listed models are managed.',
    modelsLoad: 'Load model list',
    modelsCollapse: 'Hide model list',
    readFailed: 'load failed: ',
    autoTitle: 'Auto-handoff',
    autoOn: 'On: hands off automatically at the threshold, no clicks needed.',
    autoOff: 'Off: only warns you; you confirm before handing off (safer).',
    advancedTitle: 'Advanced',
    advancedHint: 'Usually not needed; changes apply immediately. Every numeric field can be set to "unlimited".',
    expand: 'Expand',
    collapse: 'Collapse',
    declared: 'DSH declares',
    window: 'window',
    threshold: 'threshold',
    notSet: 'not set',
    manualTitle: 'Add a model manually',
    manualHint: 'Models missing from the auto list can be added here.',
    manualKeyPlaceholder: 'provider/model',
    add: 'Add',
    remove: 'Remove',
  },
}

/** 兜底翻译：没有 locale 服务时一律用中文，key 原样返回保证不白屏。 */
function fallbackT(key) {
  return Object.prototype.hasOwnProperty.call(MESSAGES.zh, key) ? MESSAGES.zh[key] : key
}

    const API = '/infinite-context/settings'
/**
 * 模型目录：走同一个设置路由的 `?models=1` 分支。
 * 为什么不单开一条路由 —— 实测注册第二条 exact 路由会被宿主以 `400 空响应` 拒绝。
 */
const MODELS_API = '/infinite-context/settings?models=1'

    function diag(label, detail) {
      try {
        console.info('[dsh-infinite-context] ' + label + (detail === undefined ? '' : ' :: ' + detail))
      } catch {
        /* 控制台不可用：忽略 */
      }
    }

    // ── 主题令牌（名字来自宿主 Theme 服务，全部真实存在）───────────────────
    const T = {
      border: 'var(--dsw-alias-border-l1, rgba(128, 128, 128, 0.35))',
      borderStrong: 'var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.5))',
      brand: 'var(--dsw-alias-brand-primary, #2f6fed)',
      muted: 'var(--dsw-alias-label-secondary, inherit)',
      success: 'var(--dsw-alias-state-success-primary, inherit)',
      error: 'var(--dsw-alias-state-error-primary, inherit)',
    }

    const fieldBase = {
      borderRadius: 8,
      border: `1px solid ${T.borderStrong}`,
      background: 'rgba(127, 127, 127, 0.10)',
      color: 'inherit',
      fontFamily: 'inherit',
    }

    const S = {
      wrap: { display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 660, color: 'inherit' },
      card: { border: `1px solid ${T.border}`, borderRadius: 12, padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 4 },
      title: { fontSize: 15, fontWeight: 600, lineHeight: 1.5 },
      lead: { fontSize: 13, lineHeight: 1.75, color: T.muted, marginBottom: 6 },
      item: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 18, padding: '13px 0', borderTop: `1px solid ${T.border}` },
      itemColumn: { display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: 0, padding: '13px 0', borderTop: `1px solid ${T.border}` },
      itemText: { display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 },
      itemTitle: { fontSize: 13.5, fontWeight: 500, lineHeight: 1.6 },
      itemHint: { fontSize: 12, lineHeight: 1.6, color: T.muted },
      /**
       * 主区说明文字固定占两行高度：
       * 开关切换时文案长短不同，换行数变了会让整页上下跳。
       */
      hintReserved: { fontSize: 12, lineHeight: 1.6, color: T.muted, minHeight: 40 },
      /**
       * 状态提示行的**固定占位**：提示不出现时也保留这块高度，
       * 否则「已保存」一出现/消失，下面整块内容就会跳。
       */
      noticeSlot: { minHeight: 40, display: 'flex', alignItems: 'flex-start', paddingTop: 2 },
      seg: { display: 'flex', gap: 6, flexWrap: 'wrap' },
      segBtn: { padding: '6px 11px', fontSize: 12.5, lineHeight: 1.3, borderRadius: 8, border: `1px solid ${T.borderStrong}`, background: 'transparent', color: 'inherit', cursor: 'pointer' },
      segBtnOn: { padding: '6px 11px', fontSize: 12.5, lineHeight: 1.3, borderRadius: 8, border: `1px solid ${T.brand}`, background: 'rgba(127, 127, 127, 0.22)', color: T.brand, cursor: 'pointer', fontWeight: 600 },
      controls: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginTop: 8 },
      range: { width: 140, accentColor: T.brand, cursor: 'pointer' },
      num: { ...fieldBase, width: 70, padding: '5px 6px', fontSize: 13, textAlign: 'center' },
      input: { ...fieldBase, width: 150, padding: '5px 8px', fontSize: 13 },
      link: { padding: 0, fontSize: 12.5, border: 'none', background: 'transparent', color: T.brand, cursor: 'pointer' },
      good: { fontSize: 12, lineHeight: 1.6, color: T.success },
      bad: { fontSize: 12, lineHeight: 1.6, color: T.error, whiteSpace: 'pre-wrap' },
      note: { fontSize: 12, lineHeight: 1.7, color: T.muted },
      mono: { fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 11, lineHeight: 1.6, whiteSpace: 'pre-wrap', color: T.muted },
      advancedHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
      check: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: T.muted, cursor: 'pointer', whiteSpace: 'nowrap' },
    }

    /** 阈值快捷档：给结论，不让用户猜数字。 */
    const PRESETS = [
      { value: 70, label: '保守 70%' },
      { value: 80, label: '标准 80%' },
      { value: 90, label: '宽松 90%' },
    ]

    const THRESHOLD_MIN = 5
    const THRESHOLD_MAX = 99

    /**
     * 高级项。数值项带 `unlimited` 哨兵：勾选「不限制」时写这个值。
     * 与 src/config.ts 的 UNLIMITED 必须保持一致。
     */
    const ADVANCED = [
      {
        key: 'maxAutoHandoffs',
        type: 'number',
        label: '自动换窗次数上限',
        hint: '单次启动内最多自动换窗几次（0 = 不限制）。本地小窗口模型每个窗口只能干 2-3 万 tokens，需要反复换窗；太小会在第二个窗口就停止自动交接。',
        unlimited: 0,
        min: 0,
        max: 100,
      },
      {
        key: 'notifyTransferredSession',
        type: 'boolean',
        label: '换窗后提醒旧窗口',
        hint: '换完窗口后，在旧窗口主动开一次很短的回复，明确告诉你「任务已转移到新会话」。关掉则不唤醒旧会话，但那条提醒可能要等它下次干活才看得到。',
      },
      {
        key: 'markTodosHandedOff',
        type: 'boolean',
        label: '交接后收尾旧待办',
        hint: '交接成功后，把旧窗口里未完成的待办标成「已完成」，避免它一直挂着"进行中"的假任务。关掉则保持原样。',
      },
      {
        key: 'carryOriginalRequest',
        type: 'boolean',
        label: '交接时带上原始需求',
        hint: '把项目的原始需求原文一路带进检查点与简报，后续窗口据它核对是否偏离目标。关掉后只有进度，容易跑偏。',
      },
      {
        key: 'briefAuthor',
        type: 'choice',
        options: [
          { value: 'plugin', label: '插件模板' },
          { value: 'model', label: '模型撰写' },
        ],
        label: '简报由谁写',
        hint: '插件模板：从结构化事实生成，确定性、零额外调用（默认）。模型撰写：换窗前多一次模型调用，写出的交接更完整；失败会自动回退模板。',
      },
      {
        key: 'handoffBriefMaxChars',
        type: 'number',
        min: 1000,
        max: 20000,
        unlimited: 0,
        label: '交接简报字数上限',
        hint: '新窗口开头那段任务摘要最多多少字（默认 4000）。勾「不限制」则按最详细档全部带上。',
      },
      {
        key: 'checkpointMaxBytes',
        type: 'number',
        min: 4096,
        max: 4194304,
        unlimited: 0,
        label: '检查点文件大小上限（字节）',
        hint: '超了先压缩内容；再超就放弃换窗（默认 65536）。勾「不限制」则不做体积裁剪。',
      },
      {
        key: 'projectProgressReserveChars',
        type: 'number',
        min: 0,
        max: 8000,
        unlimited: -1,
        label: '留给项目进展的字符数',
        hint: '从简报上限里预留多少给 PROGRESS.md 摘要（默认 1200，0 = 不带）。勾「不限制」则不裁剪且不占简报预算。',
      },
      {
        key: 'checkpointRoot',
        type: 'text',
        label: '检查点存放目录',
        hint: '留空即默认位置，一般不要改。',
      },
    ]

    const SUMMARY = '上下文快满时，自动帮你换一个新窗口接着干，并把进度带过去。'

    /** 先读文本再尝试 JSON：空 body 时 `res.json()` 只会抛错并把状态码吞掉。 */
    function readResponse(res) {
      return res
        .text()
        .catch(() => '')
        .then((text) => {
          let data = null
          try {
            data = text ? JSON.parse(text) : null
          } catch {
            data = null
          }
          return { res, data, text }
        })
    }

    function failureText(res, data, text) {
      const detail = data && (data.message || data.code)
        ? String(data.message || data.code)
        : text
          ? String(text).slice(0, 120)
          : '空响应'
      if (res.status === 401 || res.status === 403) return `HTTP ${res.status}（未通过连接层认证）· ${detail}`
      if (res.status === 404) return `HTTP 404（宿主没挂上设置接口，重启 DSH 即可）· ${detail}`
      return `HTTP ${res.status} · ${detail}`
    }

    function makePanel(t) {
        const tr = typeof t === 'function' ? t : fallbackT
      return function InfiniteContextSettings(props) {
        if (props && props.view === 'summary') return SUMMARY

        const [state, setState] = react.useState({ status: 'loading', config: null, probe: null, error: null })
        const [notice, setNotice] = react.useState(null)
        const [busy, setBusy] = react.useState(null)
        const [advancedOpen, setAdvancedOpen] = react.useState(false)
        /** 阈值草稿：拖动/输入时只改它，松手/回车/失焦才提交。 */
        const [thresholdDraft, setThresholdDraft] = react.useState(null)
        /** token 阈值草稿（0 / 空 = 只看百分比）。 */
        const [tokenDraft, setTokenDraft] = react.useState(null)
        /** 上下文窗口自定值草稿（0 / 空 = 用 DSH 读取值）。 */
        const [windowDraft, setWindowDraft] = react.useState(null)
        /** 自定窗口的模型匹配关键字草稿。 */
        const [matchDraft, setMatchDraft] = react.useState(null)
        /** DSH 模型目录（null = 还没读）。 */
        const [models, setModels] = react.useState(null)
        const [modelsError, setModelsError] = react.useState(null)
        const [modelsOpen, setModelsOpen] = react.useState(false)
        /** 逐模型窗口草稿：`provider/model` → 输入框字符串。 */
        const [modelDraft, setModelDraft] = react.useState({})
        /** 逐模型阈值草稿（键同上，值是百分比字符串）。 */
        const [modelThresholdDraft, setModelThresholdDraft] = react.useState({})
        /** 手动添加行的阈值（百分比）。 */
        const [manualThreshold, setManualThreshold] = react.useState('')
        /** 手动新增一行的输入（自动读取失败时的兜底）。 */
        const [manualKey, setManualKey] = react.useState('')
        const [manualValue, setManualValue] = react.useState('')
        /** 高级项草稿：按字段 key 存字符串，提交后清掉。 */
        const [advancedDraft, setAdvancedDraft] = react.useState({})

        const load = () => {
          fetch(API, { headers: { accept: 'application/json' }, cache: 'no-store' })
            .then(readResponse)
            .then(({ res, data, text }) => {
              if (!res.ok || !data || data.ok !== true) {
                setState({ status: 'error', config: null, probe: null, error: failureText(res, data, text) })
                return
              }
              setState({ status: 'ready', config: data.config || {}, probe: data.probe || null, error: null })
            })
            .catch((error) => setState({ status: 'error', config: null, error: String((error && error.message) || error) }))
        }

        react.useEffect(() => {
          load()
        }, [])

        const config = state.config || {}
        const ready = state.status === 'ready'
        const enabled = config.enabled === true
        const auto = config.autoHandoff === true
        const threshold = typeof config.thresholdPercent === 'number' ? config.thresholdPercent : 80
        const shownThreshold = thresholdDraft === null ? threshold : thresholdDraft

        const save = (patch) => {
          const firstKey = Object.keys(patch)[0] || 'patch'
          setBusy(firstKey)
          setNotice(null)
          fetch(API, {
            method: 'PUT',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify(patch),
          })
            .then(readResponse)
            .then(({ res, data, text }) => {
              if (!res.ok || !data || data.ok !== true) {
                setNotice({ kind: 'bad', text: `没能保存：${failureText(res, data, text)}` })
                return null
              }
              // 用 applied：config 是插件实例创建时的旧值
              const nextConfig = data.applied || data.config || config
              // 保留 probe（DSH 读到的窗口），否则保存一次后「DSH 读取」会变未知
              setState((prev) => ({ ...prev, status: 'ready', config: nextConfig, error: null }))
              setNotice({ kind: 'good', text: '已保存，立即生效。' })
              return nextConfig
            })
            .catch((error) => setNotice({ kind: 'bad', text: String((error && error.message) || error) }))
            .then(() => setBusy(null))
        }

        const clampThreshold = (value) => Math.max(THRESHOLD_MIN, Math.min(THRESHOLD_MAX, Math.round(Number(value) || 80)))

        /** 绝对 token 阈值：0 = 只看百分比。 */
        const tokenThreshold = typeof config.thresholdTokens === 'number' ? config.thresholdTokens : 0

        const commitThreshold = () => {
          if (thresholdDraft === null) return
          const value = clampThreshold(thresholdDraft)
          setThresholdDraft(null)
          if (value !== threshold) save({ thresholdPercent: value })
        }

        const commitThresholdTokens = () => {
          if (tokenDraft === null) return
          const value = Math.max(0, Math.round(Number(tokenDraft) || 0))
          setTokenDraft(null)
          if (value !== tokenThreshold) save({ thresholdTokens: value })
        }

        /** 自定的上下文窗口（0 = 用 DSH 读取值）。 */
        const windowOverride = typeof config.contextWindowOverride === 'number' ? config.contextWindowOverride : 0
        const probe = state.probe || null
        const dshWindow = probe && typeof probe.windowTokens === 'number' ? probe.windowTokens : null
        const effectiveWindow = windowOverride > 0 ? windowOverride : dshWindow
        const fmt = (value) => (value === null ? '未知' : value.toLocaleString('en-US'))
        const windowFor = typeof config.contextWindowOverrideFor === 'string' ? config.contextWindowOverrideFor : ''
        const windowHint = `DSH 读取：${dshWindow === null ? '未探测到（那个窗口发一句话后再回来看）' : fmt(dshWindow)} · 当前生效：${fmt(effectiveWindow)}${windowOverride > 0 ? '（自定）' : ''}。本地推理软件的实际上限可能小于模型声明值，填成真实值百分比才准。${windowFor === '' ? '' : `仅对含「${windowFor}」的模型生效。`}`

        const committedMatch = matchDraft === null ? windowFor : matchDraft
        const commitWindowFor = () => {
          if (matchDraft === null) return
          const value = String(matchDraft).trim()
          setMatchDraft(null)
          if (value !== windowFor) save({ contextWindowOverrideFor: value })
        }

        const commitWindowOverride = () => {
          if (windowDraft === null) return
          const value = Math.max(0, Math.round(Number(windowDraft) || 0))
          setWindowDraft(null)
          if (value !== windowOverride) save({ contextWindowOverride: value })
        }

        /** 读取 DSH 的模型目录（用户点「读取模型列表」时才请求，避免每次开设置页都触网）。 */
        const loadModels = () => {
          setModelsError(null)
          if (models === null) setModels(null)
          fetch(MODELS_API, { headers: { accept: 'application/json' }, cache: 'no-store' })
            .then(readResponse)
            .then(({ res, data, text }) => {
              if (!res.ok || !data || data.ok !== true) {
                setModels([])
                setModelsError(failureText(res, data, text))
                return
              }
              setModels(Array.isArray(data.providers) ? data.providers : [])
              if (typeof data.error === 'string' && data.error.length > 0) setModelsError(data.error)
            })
            .catch((error) => {
              setModels([])
              setModelsError(String((error && error.message) || error))
            })
        }

        /** 逐模型窗口：改哪个提交哪个，键保存为 `provider/model`。 */
        const commitModelWindow = (key) => {
          if (modelDraft[key] === undefined) return
          const value = Math.max(0, Math.round(Number(modelDraft[key]) || 0))
          const next = { ...(config.contextWindowByModel || {}) }
          if (value > 0) next[key] = value
          else delete next[key]
          setModelDraft((prev) => {
            const copy = { ...prev }
            delete copy[key]
            return copy
          })
          save({ contextWindowByModel: next })
        }

        /** 逐模型阈值：同样改哪个提交哪个。0 = 该模型不启用百分比线。 */
        const commitModelThreshold = (key) => {
          if (modelThresholdDraft[key] === undefined) return
          const value = Math.min(99, Math.max(0, Math.round(Number(modelThresholdDraft[key]) || 0)))
          const next = { ...(config.thresholdByModel || {}) }
          if (value > 0) next[key] = value
          else delete next[key]
          setModelThresholdDraft((prev) => {
            const copy = { ...prev }
            delete copy[key]
            return copy
          })
          save({ thresholdByModel: next })
        }

        /**
         * 逐模型窗口列表。
         * 关键：**即使自动读取失败也要能填** —— 所以渲染「已保存的键 ∪ DSH 发现的键」，
         * 再加一行「手动添加」。读取失败只影响能否自动列出，不影响生效。
         */
        const renderModelRows = () => {
          const saved = config.contextWindowByModel || {}
          const savedThreshold = config.thresholdByModel || {}
          const discovered = new Map()
          for (const provider of models || []) {
            const providerModels = Array.isArray(provider && provider.models) ? provider.models : []
            for (const model of providerModels) discovered.set(`${provider.id}/${model.id}`, model)
          }
          const keys = []
          for (const key of Object.keys(saved)) keys.push(key)
          for (const key of Object.keys(savedThreshold)) if (!keys.includes(key)) keys.push(key)
          for (const key of discovered.keys()) if (!keys.includes(key)) keys.push(key)

          const rows = keys.map((key) => {
            const model = discovered.get(key)
            const savedValue = typeof saved[key] === 'number' ? saved[key] : 0
            const draft = modelDraft[key]
            const shown = draft !== undefined ? draft : (savedValue > 0 ? String(savedValue) : '')
            const savedPercent = typeof savedThreshold[key] === 'number' ? savedThreshold[key] : 0
            const percentDraft = modelThresholdDraft[key]
            const percentShown = percentDraft !== undefined ? percentDraft : (savedPercent > 0 ? String(savedPercent) : '')
            const declared = model !== undefined && typeof model.contextWindow === 'number'
              ? model.contextWindow.toLocaleString('en-US')
              : null
            return el('div', { style: S.item, key },
              el('div', { style: S.itemText },
                el('div', { style: S.itemTitle }, model === undefined ? key : String(model.name || model.id)),
                el('div', { style: S.itemHint }, [key, declared !== null ? `${tr('declared')} ${declared}` : null, `${tr('window')} ${savedValue > 0 ? savedValue.toLocaleString('en-US') : tr('notSet')}`, `${tr('threshold')} ${savedPercent > 0 ? `${savedPercent}%` : tr('notSet')}`].join(' · ')),
              ),
              el('div', { style: { display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 } },
                el('input', {
                  type: 'number',
                  min: 0,
                  step: 1000,
                  style: S.num,
                  value: shown,
                  placeholder: tr('notSet'),
                  disabled: !ready || busy === 'contextWindowByModel',
                  onChange: (event) => setModelDraft((prev) => ({
                    ...prev,
                    [key]: event.target.value === '' ? 0 : Number(event.target.value),
                  })),
                  onBlur: () => commitModelWindow(key),
                  onKeyDown: (event) => {
                    if (event.key === 'Enter') commitModelWindow(key)
                  },
                }),
                el('span', { style: S.itemHint }, 'tokens'),
                el('input', {
                  type: 'number',
                  min: 0,
                  max: 99,
                  step: 1,
                  style: S.num,
                  value: percentShown,
                  placeholder: '不设置',
                  disabled: !ready || busy === 'thresholdByModel',
                  onChange: (event) => setModelThresholdDraft((prev) => ({
                    ...prev,
                    [key]: event.target.value === '' ? 0 : Number(event.target.value),
                  })),
                  onBlur: () => commitModelThreshold(key),
                  onKeyDown: (event) => {
                    if (event.key === 'Enter') commitModelThreshold(key)
                  },
                }),
                el('span', { style: S.itemHint }, '%'),
                el('button', {
                  type: 'button',
                  style: S.link,
                  disabled: !ready,
                  onClick: () => {
                    const next = { ...saved }
                    delete next[key]
                    const nextThreshold = { ...savedThreshold }
                    delete nextThreshold[key]
                    save({ contextWindowByModel: next, thresholdByModel: nextThreshold })
                  },
                }, tr('remove')),
              ),
            )
          })

          // 手动添加：自动读取失败时的兜底（键就是 provider/model，大小写不敏感匹配）
          rows.push(el('div', { style: S.item, key: 'manual-model-row' },
            el('div', { style: S.itemText },
              el('div', { style: S.itemTitle }, tr('manualTitle')),
              el('div', { style: S.itemHint }, (modelsError === null ? tr('manualHint') : `${tr('readFailed')}${modelsError}`)),
            ),
            el('div', { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', flexShrink: 0 } },
              el('input', {
                type: 'text',
                style: S.input,
                value: manualKey,
                placeholder: tr('manualKeyPlaceholder'),
                disabled: !ready,
                onChange: (event) => setManualKey(event.target.value),
              }),
              el('input', {
                type: 'number',
                min: 0,
                step: 1000,
                style: S.num,
                value: manualValue,
                placeholder: '64000',
                disabled: !ready,
                onChange: (event) => setManualValue(event.target.value),
              }),
              el('input', {
                type: 'number',
                min: 0,
                max: 99,
                step: 1,
                style: S.num,
                value: manualThreshold,
                placeholder: '阈值%',
                disabled: !ready,
                onChange: (event) => setManualThreshold(event.target.value),
              }),
              el('button', {
                type: 'button',
                style: S.segBtn,
                disabled: !ready || manualKey.trim() === '' || Math.round(Number(manualValue) || 0) <= 0,
                onClick: () => {
                  const key = manualKey.trim()
                  const value = Math.max(0, Math.round(Number(manualValue) || 0))
                  if (key === '' || value <= 0) return
                  const percent = Math.min(99, Math.max(0, Math.round(Number(manualThreshold) || 0)))
                  const nextThreshold = { ...(config.thresholdByModel || {}) }
                  if (percent > 0) nextThreshold[key] = percent
                  save({ contextWindowByModel: { ...saved, [key]: value }, thresholdByModel: nextThreshold })
                  setManualKey('')
                  setManualValue('')
                  setManualThreshold('')
                },
              }, tr('add')),
            ),
          ))

          if (models === null && keys.length === 0) return el('div', { style: S.note }, '正在读取模型目录…')
          return el('div', null, ...rows)
        }
        /** 高级数值/文本：失焦或回车提交；空字符串视为放弃编辑。 */
        const commitAdvanced = (field) => {
          const raw = advancedDraft[field.key]
          if (raw === undefined) return
          setAdvancedDraft((prev) => {
            const next = { ...prev }
            delete next[field.key]
            return next
          })
          const text = String(raw).trim()
          if (text.length === 0) return
          if (field.type === 'number') {
            const value = Number(text)
            if (!Number.isFinite(value)) {
              setNotice({ kind: 'bad', text: '请输入数字。' })
              return
            }
            if (value === config[field.key]) return
            save({ [field.key]: value })
            return
          }
          if (text === config[field.key]) return
          save({ [field.key]: text })
        }

        try {
          return renderBody()
        } catch (error) {
          return el('div', { style: S.bad }, tr('renderFailed') + String((error && error.message) || error))
        }

        function renderBody() {
          /** 固定占位的状态行：没有提示时也保留同样的高度，避免出现/消失时整页跳动。 */
          const noticeSlot = () => el('div', { style: S.noticeSlot },
            notice === null ? null : el('div', { style: notice.kind === 'good' ? S.good : S.bad }, notice.text))

          const statusLine = state.status === 'loading'
            ? el('div', { style: S.note }, tr('loading'))
            : state.status === 'error'
              ? el('div', { style: S.bad }, tr('configError') + String(state.error || '未知原因'),
                el('div', { style: S.note }, tr('configErrorHint')))
              : null

          return el(
            'div',
            { style: S.wrap },
            el(
              'div',
              { style: S.card },
              el('div', { style: S.title }, tr('sectionTitle')),
              el('div', { style: S.lead },
                tr('lead1'),
                tr('lead2')),
              statusLine,

              // ① 启用
              el('div', { style: S.item },
                el('div', { style: S.itemText },
                  el('div', { style: S.itemTitle }, tr('enableTitle')),
                  el('div', { style: S.hintReserved }, enabled ? tr('enableOn') : tr('enableOff')),
                ),
                el('input', {
                  type: 'checkbox',
                  checked: enabled,
                  disabled: !ready || busy === 'enabled',
                  onChange: (event) => save({ enabled: event.target.checked }),
                }),
              ),

              // ③b 按模型设窗口与阈值（主区，跟全局阈值放一起更好找）
              el('div', { style: S.itemColumn },
                el('div', { style: S.itemText },
                  el('div', { style: S.itemTitle }, tr('modelsTitle')),
                  el('div', { style: S.itemHint }, tr('modelsHint') + (modelsError === null ? '' : ` ${tr('readFailed')}${modelsError}`)),
                ),
                el('div', { style: S.controls },
                  el('button', {
                    type: 'button',
                    style: S.segBtn,
                    disabled: !ready,
                    onClick: () => {
                      if (!modelsOpen) loadModels()
                      setModelsOpen(!modelsOpen)
                    },
                  }, modelsOpen ? tr('modelsCollapse') : tr('modelsLoad')),
                ),
              ),
              modelsOpen ? renderModelRows() : null,

              // ④ 自动换窗
              el('div', { style: S.item },
                el('div', { style: S.itemText },
                  el('div', { style: S.itemTitle }, tr('autoTitle')),
                  el('div', { style: S.hintReserved }, auto ? tr('autoOn') : tr('autoOff')),
                ),
                el('input', {
                  type: 'checkbox',
                  checked: auto,
                  disabled: !ready || busy === 'autoHandoff',
                  onChange: (event) => save({ autoHandoff: event.target.checked }),
                }),
              ),

              noticeSlot(),
            ),

            // ── 高级（默认折叠）───────────────────────────────────────────
            el('div', { style: S.card },
              el('div', { style: S.advancedHead },
                el('div', { style: S.itemText },
                  el('div', { style: S.itemTitle }, tr('advancedTitle')),
                  el('div', { style: S.itemHint }, tr('advancedHint')),
                ),
                el('button', { type: 'button', style: S.link, onClick: () => setAdvancedOpen(!advancedOpen) },
                  advancedOpen ? tr('collapse') : tr('expand')),
              ),
              advancedOpen
                ? el('div', null,
                  ...ADVANCED.map((field) => {
                    const value = config[field.key]
                    const isUnlimited = field.unlimited !== undefined && value === field.unlimited
                    const draftValue = advancedDraft[field.key]
                    const shown = draftValue !== undefined
                      ? draftValue
                      : isUnlimited
                        ? ''
                        : value === undefined || value === null ? '' : String(value)
                    return el('div', { style: S.item, key: field.key },
                      el('div', { style: S.itemText },
                        el('div', { style: S.itemTitle }, field.label),
                        el('div', { style: S.itemHint }, field.hint),
                      ),
                      el('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0, flexWrap: 'wrap', justifyContent: 'flex-end' } },
                        // 开关型（如「交接后收尾旧待办」）：勾了立即保存
                        field.type === 'boolean'
                          ? el('label', { style: S.check },
                            el('input', {
                              type: 'checkbox',
                              checked: value === true,
                              disabled: !ready || busy === field.key,
                              onChange: (event) => save({ [field.key]: event.target.checked }),
                            }),
                            '开启')
                          // 选择题（如「简报由谁写」）：分段按钮，点了立即保存
                          : field.type === 'choice'
                          ? el('div', { style: S.seg },
                            ...(field.options || []).map((option) => el('button', {
                              key: option.value,
                              type: 'button',
                              style: value === option.value ? S.segBtnOn : S.segBtn,
                              disabled: !ready || busy === field.key,
                              onClick: () => save({ [field.key]: option.value }),
                            }, option.label)),
                          )
                          : el('input', {
                            type: field.type === 'number' ? 'number' : 'text',
                            style: S.input,
                            value: shown,
                            placeholder: isUnlimited ? '不限制' : '',
                            disabled: !ready || busy === field.key,
                            min: field.min,
                            max: field.max,
                            onChange: (event) => setAdvancedDraft((prev) => ({ ...prev, [field.key]: event.target.value })),
                            onBlur: () => commitAdvanced(field),
                            onKeyDown: (event) => {
                              if (event.key === 'Enter') commitAdvanced(field)
                            },
                          }),
                        field.unlimited === undefined
                          ? null
                          : el('label', { style: S.check },
                            el('input', {
                              type: 'checkbox',
                              checked: isUnlimited,
                              disabled: !ready || busy === field.key,
                              onChange: (event) => {
                                setAdvancedDraft((prev) => {
                                  const next = { ...prev }
                                  delete next[field.key]
                                  return next
                                })
                                save(event.target.checked
                                  ? { [field.key]: field.unlimited }
                                  : { reset: [field.key] })
                              },
                            }),
                            '不限制'),
                        el('button', {
                          type: 'button',
                          style: S.link,
                          disabled: !ready,
                          onClick: () => {
                            setAdvancedDraft((prev) => {
                              const next = { ...prev }
                              delete next[field.key]
                              return next
                            })
                            save({ reset: [field.key] })
                          },
                        }, '恢复默认'),
                      ),
                    )
                  }),
                  el('div', { style: S.note }, '数值项失焦或回车即保存；「不限制」勾上后写入哨兵值（0 或 -1）。'),
                )
                : null,
            ),

            el('div', { style: S.note },
              '更多细节（原理、检查点格式、排障）看插件目录下的 README.md；实时占用率可以让助手调用 infinite_context_status 查。'),
            ready
              ? el('div', { style: { ...S.mono, minHeight: 38 } },
                [
                  `阈值 ${threshold}% · 自动换窗 ${auto ? '开' : '关'} · ${enabled ? '已启用' : '已关闭'}`,
                  `简报上限 ${config.handoffBriefMaxChars === 0 ? '不限制' : `${config.handoffBriefMaxChars} 字`}`
                  + ` · 检查点上限 ${config.checkpointMaxBytes === 0 ? '不限制' : `${config.checkpointMaxBytes} 字节`}`
                  + ` · 项目摘要 ${config.projectProgressReserveChars === -1 ? '不限制' : `${config.projectProgressReserveChars} 字`}`,
                ].join('\n'))
              : null,
          )
        }
      }
    }

    function apply(ctx) {
      const slots = ctx.slots
      if (slots === undefined || slots === null || typeof slots.register !== 'function') {
        diag('apply:abort', 'slots service unavailable')
        return
      }
      // 主区文案接入宿主 locale（zh + en；其余语言回落到 en）。
      let t = fallbackT
      try {
        // 用 ctx.get 取，而不是写进 inject：没有该服务的宿主仍能加载本插件（只是不翻译）。
        const locale = typeof ctx.get === 'function' ? ctx.get('locale') : ctx.locale
        if (locale !== undefined && typeof locale.register === 'function' && typeof locale.bind === 'function') {
          ctx.effect(() => locale.register('infiniteContext', {
            zh: MESSAGES.zh,
            en: MESSAGES.en,
            ja: MESSAGES.en,
            es: MESSAGES.en,
            fr: MESSAGES.en,
            de: MESSAGES.en,
            ru: MESSAGES.en,
            pt: MESSAGES.en,
          }), 'infinite-context: locale dictionaries')
          t = locale.bind('infiniteContext')
        }
      } catch (error) {
        diag('apply:locale-unavailable', String((error && error.message) || error))
      }
      const Panel = makePanel(t)
      try {
        slots.inject('settings.section', () => slots.register({
          name: 'settings.section',
          id: 'infinite-context',
          order: 55,
          label: () => t('sectionTitle'),
        }, Panel))
        diag('slot:inject', 'settings.section')
      } catch (error) {
        diag('slot:FAILED settings.section', String((error && error.message) || error))
      }
    }

    exports.inject = ['slots']
    exports.apply = apply
    return module.exports
  },
})
