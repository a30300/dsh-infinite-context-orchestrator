# dsh-infinite-context-orchestrator

DSH（DeepSeek Harness）插件：把「上下文快满了」这件事变成一条自动闭环 ——
**监测占用 → 临界提醒 → 写交接检查点 → 开新窗口 → 首轮强制注入交接简报**。

它自己不实现压缩、不实现检查点存储、不实现项目档案，这些能力全部**复用**本地已有的 4 个插件。

---

## 1. 与四个上游项目的关系（设计参考，**不是**运行时依赖）

这四个插件是判据、契约与边界的老师，但**一个都不用安装**。实测：本机 profile 里只装了本插件与
`dsh-sandbox-allowlist`，上述四个都没有，换窗照常工作。运行时只用 DSH 内置服务：
`tools` / `systemPrompt` / `agents` / `sessionController` / `agentPresets` / `sessionTitle` /
`sessionProjections` / `tokenMeter` / `llm` / `connection`（contextPressure 投影由基础插件 dsh-token-meter 提供）。

| 上游项目 | 关系 | 实际复用了什么 |
|---|---|---|
| `dsh-context-relay` | 设计参考（不调用） | ① 占用判档的**口径**（先看投影压力，再退回 token 计量）；② 换窗走**同一条 Session API 路径**（`sessionController.create` 优先，`agents.create + agentPresets.mount` 兜底）；③ notice 的消息形状沿用 `source:{kind, form:'notice', summary}` 约定（会话格式 v4 的行准入要求）。**不**调用它的 `relay_handoff`：relay 的交接正文是首条 **user** 消息，本插件要求简报进 **system prompt**。 |
| `dsh-task-checkpoint-guard` | 契约对齐（不 import） | 磁盘布局与持久化算法：同根 `${DSH_HOME}/task-checkpoints`、临时文件 → fsync → rename 的原子替换、`<target>.previous` 保留上一版、目录 fsync 容错、进程内按目标串行化。本插件只占 `task-checkpoints/orchestrator/`，不碰它的 `tasks/` `sessions/`。 |
| `dsh-project-progress` | 可选读取（文件级） | 只有工作区里**存在** `PROGRESS.md` 时才读它（`## 项目档案` + `## 进展时间线`），把项目级上下文压进简报末尾；两条注入共享 `handoffBriefMaxChars` 预算，任务级优先（`projectProgressReserveChars` 控制预留）。没装、没这个文件时静默跳过。 |
| `dsh-context-window` / CooperZhuang 的设计笔记 | 边界对齐（不调用） | 硬约束：**换窗必须是新会话**，不在同一会话里切 preset。它的 `src/config.ts` 也是 schemastery 用法与「加载期 fail-loud」的参考实现。 |

> 结论：**四个都不用装**。本插件自身**零第三方依赖** —— `lib/index.js` 只 import Node 内建模块
> （schemastery 在构建时打进产物）。

## 2. 闭环流程

```
agent/pre-step（每个 step 一次；占用有 4s 缓存，step/end、tool/result、assistant/message、turn/start 会让缓存失效）
        │  测占用：contextPressure → tokenMeter 估算 → 用「设置里填的窗口」算百分比（没填才退回 DSH/服务器值）
        ▼
该模型既没配窗口也没配阈值 ──▶ 完全不介入（不提醒、不换窗）
该会话已有检查点（已交接过）──▶ 不再自动换窗（持久判据，重启后依然有效）
占用 < 该模型阈值          ──▶ 什么都不做（跌回 阈值-5 才重新武装，防抖）
        │是
        ▼
① 给当前会话注入插件 notice（非用户消息，不打断工作）
        │
        ├─ autoHandoff=false ──▶ 只提醒，等用户调用 infinite_context_handoff
        └─ autoHandoff=true
                ▼
② 写检查点（fail-closed：写不进去就**不**换窗）
   handoffs/<sessionId>.json（原子替换 + .previous）
   handoffs/history/<时间戳>-<sessionId>.json（不可变历史，留 50 份）
   requirements/<工作区>.md（原始需求原文，内容不变就不重写）
                ▼
③ 建**全新顶层会话**（继承旧会话的 cwd / agentPreset / workspaceId；不在旧会话里切 preset）
                ▼
④ 简报落到 pending-briefs/<新 sessionId>.json；「交接锚点」拼在简报最前面
                ▼
⑤ 新会话第一次组装请求时，systemPrompt.section 注入「## 任务交接简报」
   （含原样保留的「原始需求」、待办、已完成、关键决策）
                ▼
⑥ 叫停旧会话当前轮（sessionController.cancel），并在旧窗口写一条「任务已转移」的 user 消息
   —— 用 append 写入（不唤醒旧窗口）；**不写 developer/message**：那要求 open turn，会把日志写成 corrupt
                ▼
⑦ 记账；自动换窗次数受 maxAutoHandoffs 限制（默认 10，0 = 不限制）
```

检查点字段：`goal`、`done`、`pending_todos`、`key_decisions`、`last_human_request`、
`original_request`（+`original_request_source` / `original_request_chars`）、`checkpoint_path`，
另加 `occupancy`、`cwd`、`sessionId`、`notes`。写入前整份脱敏
（`sk-*`、GitHub/AWS token、JWT、`Bearer`、`password=`、PEM 私钥、`$USERPROFILE` 路径）。

---

## 3. 配置

```yaml
- id: infinite-context-orchestrator
  name: dsh-infinite-context-orchestrator
  config:
    enabled: true                        # 总开关（默认 false）
    contextWindowByModel: {}             # 逐模型真实窗口（键 provider/model 或 model）
    thresholdByModel: {}                 # 逐模型阈值（0 = 该模型不启用）；不在列表 = 不介入
    autoHandoff: false                   # 是否全自动换窗（默认 false = 只提醒）
    maxAutoHandoffs: 10                  # 单次加载内自动换窗次数上限（0 = 不限制）
    notifyTransferredSession: true       # 换窗后在旧窗口 append 一条「任务已转移」（不唤醒）
    markTodosHandedOff: true             # 交接后把旧窗口的待办标成已完成（默认开）
    briefAuthor: plugin                  # 简报由谁写：plugin 模板 / model 撰写（失败回退模板）
    carryOriginalRequest: true           # 交接时带上原始需求原文（默认开）
    checkpointMaxBytes: 65536            # 检查点体积上限；0 = 不限制
    handoffBriefMaxChars: 4000           # 简报字符上限；0 = 不限制
    checkpointRoot: ''                   # 可选；空 = ${DSH_HOME}/task-checkpoints/orchestrator
    projectProgressReserveChars: 1200     # 给 PROGRESS.md 的预留；0 = 不带；-1 = 不限制
```

**窗口与阈值怎么算**

- 设置页「按模型设窗口与阈值」逐模型填：**窗口 = 真实提示预算**（`n_ctx − max_tokens`，例如
  `n_ctx=64000`、`max_tokens=16384` → 填 47616）；**阈值 = 该模型的百分比**；
- 该模型没单独填阈值时，用内置默认 80%；
- 该模型**没填窗口**时，退回 DSH/服务器读到的窗口值；
- 只管理列表里出现的模型；既没配窗口也没配阈值的模型，插件完全不介入。

为什么必须自己填窗口：本地推理常把实际上下文压得比模型声明的小。实测 llama.cpp 限 64K，
而 DSH 从模型配置读到 `contextWindow: 204800` → 按声明值算的 80% 需要 163,840 tokens，
实际 64K 就爆了，**百分比永远不会触发**。

与 relay 的关系：relay 的 `relayRatio` 默认是「阈值 + 10」，所以本插件在阈值处先写检查点/换窗，
relay 在再高 10 个百分点才硬性接力 —— 中间这段就是留给写盘的时间。

**新会话落在哪个分组**

GUI 的分组就是 **Workspace**。sessionController.create 的两个参数互斥：

- workspaceId：Session 加入这个 Workspace（→ 和原会话同一分组）
- cwd：Session 自己拥有这个目录，**不属于任何 Workspace**（→ UI 里自成一个分组）

所以交接时先从宿主 ctx.workspaceRegistry.list() 里按 sessionIds 找到原会话所属 Workspace，
传它的 workspaceId；找不到再退回 cwd（保证老环境下也能建出会话）。

**安装形态**

dsh plugin add 建 Junction（加载的是工作区文件）；scripts/install-copy.ps1 复制成独立副本，
依赖声明写 ile:，工作区只作镜像。改完代码需 build → 同步 → 重启。

**工具**

- `infinite_context_status`：当前占用率、阈值、autoHandoff、最近检查点路径、是否正在换窗、待注入简报状态、换窗依赖服务的现场可用性。
- `infinite_context_handoff`（可选参数 `reason`）：手动触发完整闭环。

**设置界面（Client 半件）**

`client.js` 是手写的 `__ModuleLoader__` bundle，**只注册一个座位**：

| 座位 | 在哪打开 |
|---|---|
| `settings.section`（id `infinite-context`，order 55） | **设置 → 任务自动换窗** |

> 曾经也注册 `plugins.row.config`（插件页那一行的配置页），**已移除**：实测它会串到别的插件
> 的配置页上（注册表里一旦只剩本插件这一条，别人的行页也渲染它），而给插件行加一个「配置」
> 入口对本插件没有额外价值 —— 一个独立设置页就够了。少一个座位就少一条串页路径。

界面按「用户真正会调的东西」来分：

- **主区三件**：`启用`（开关）、`按模型设窗口与阈值`（每个模型行两格：窗口 + 阈值；改哪个提交哪个）、
  `自动换新窗口`（开关，默认关闭 = 只提醒）。每项一句大白话说明。
- **高级（默认折叠）**：`handoffBriefMaxChars`、`checkpointMaxBytes`、
  `projectProgressReserveChars`、`checkpointRoot`，失焦/回车即时保存，逐项「恢复默认」。
  三个数值项各有「不限制」勾选框，写入哨兵值：`0`（简报字数/检查点体积）、`-1`（项目摘要预留）。
  语义：简报不限制 ⇒ 所有条目与字段全带、不做长度检查；检查点不限制 ⇒ 不做体积裁剪；
  项目摘要不限制 ⇒ 不裁剪且**不占**简报字数预算（安全上限 20000 字）。
- 原理、检查点格式、排障，全部写在 README 与 `docs/`，不塞进界面。

三条**实现约束**（每一条都是踩过坑才定下来的）：

1. **注册必须包在 `ctx.slots.inject(<slot>, () => ctx.slots.register({name, id, order, label?}, Component))` 里。**
   槽位由页面按需声明，加载时直接 `slots.register` 会被静默丢掉 —— 表现就是「设置里什么都没有」。
2. **配置读写走同源 `fetch('/infinite-context/settings')`，不要用 `ctx.configForms`。**
   本机这版 DSH 的客户端服务目录只有 `layout / locale / sessions / slots / theme / timer /
   uiWorkspace / workspaces`，**没有 configForms**（沙箱插件的设置页也因此没注册上）。
   同源 fetch + 宿主 `webServer` exact 路由是这套环境里已验证可行的路径
   （`dsh-context-relay` 的客户端就是这么读写的）；主机侧写回走 `configEditor`
   （校验 → 持久化 → reconcile），未认证请求由连接层返回 401（fail-closed）。
3. **保存后必须用响应里的 `applied`，不要用 `config`。** 路由闭包里的 `config` 是插件实例创建时的旧值，回读它会让 UI 在保存后「弹回旧值」，用户看到的就是「要点好几次才生效」。\n   选中态按钮也不要用「品牌色填充 + 白字」（暗色主题下品牌色可能很浅，会变成白底白字）；用半透明底 + 品牌色文字/描边。\n4. **新窗口"开跑"与"督工"是两个独立机制**：`followup` 把首条消息入队并唤醒 agent（DSH agent-loop 里 `send(input,"next-turn",true)`，不看消息 source），负责开轮；`developer/message`（`session.append`）承载"第一件事做什么"的锚点；首条 assistant 消息若只说话不动手（无 tool-call 且回复很短/以问句结尾），插件补发一次纠正。\n5. **React API 只用 16.8 起就有的 `createElement / useState / useEffect`。**
   第一版用了 `useSyncExternalStore`（React 18 才有），本机宿主版本没有 →
   组件渲染即抛 → 设置页有导航项但内容区**空白**。渲染体外面套了 try/catch，
   再出错也会把原因显示成红字，不再白屏。

**配色只用宿主真实令牌**（`cordis_inspect_query` 的 `Theme.listTokens` 是权威清单）：
`--dsw-alias-label-primary` / `-label-secondary` / `-border-l1` / `-border-l2` /
`-bg-layer-1` / `-bg-base` / `-brand-primary` / `-state-success-primary` / `-state-error-primary`。
文字用 `inherit`、次要文字用 `opacity`、边框兜底用中灰 rgba —— **不给深色硬编码兜底**
（第一版用了 `#1f1f1f` 这类浅色主题色，暗色面板上直接变「深底深字」）。

GET 失败（401/404/网络错误）时页面显示状态码与原因，并把控件禁用，绝不假装可用。
实时占用率不在这页，用 `infinite_context_status` 工具看。

> 改动生效条件：只改 `client.js` → **硬刷新页面**（`Ctrl+Shift+R`）即可；
> 改了宿主半件（`lib/index.js`，例如新增设置路由）→ **必须重启 DSH**，
> 运行中的进程不会热加载插件模块。

---

## 4. 安装

```powershell
dsh plugin --profile <profile> add "<插件所在文件夹>"
```

`package.json` 声明了 `dsh.bundle.patch`，安装时 `cordis.patch.yml` 会作为 bundle 层落到 profile，
行 id 为 `infinite-context-orchestrator`。

> **改配置后必须让宿主重新 reconcile**（实测坑）：本机 desktop 宿主**不会**热重载
> `~/.dsh/profiles/<profile>/cordis.patch.yml`。改完 patch 后要么重启 DSH，要么重跑一次
> `dsh plugin --profile <profile> add "<这个目录>"`（幂等，会触发 profile 重建）。
> 插件**安装**本身是热生效的（工具会立刻出现在会话里），不需要重启。
>
> 想强制重新加载 `lib/index.js` 的新构建，同理：重启 DSH，或重跑一次上面的 `add`。
> 装了设置页之后最省事的办法是直接在设置页里改——它走 `configEditor`，本来就会 reconcile。

> ⚠️ **不要用 `dsh plugin remove` 管理这个插件**（实测踩到的事故，并且它导致了 DSH 崩溃）：
> 本机 DSH 的 `remove` 会把 profile 的 `cordis.patch.yml` 截回到一份旧备份、把 `dsh.profile.bundles`
> 削成 `base + web-app`，**不相关条目一起丢掉**（本次被削掉的是 `sandbox-allowlist-policy` 的授权目录/
> 命令规则、`agent-default-model`、`llm-pi-ai` 的 provider 配置、4 个基础插件与本插件的 bundle 行）。
> 运行中的宿主随即卸载这些插件，随后 DSH 崩溃。
> 因此：**只用 `dsh plugin add <目录>`**（幂等、实测不丢条目），卸载前先备份 patch。
> 恢复：把 `docs/profile-patch-desktop.good.yml` 复制回 profile 的 `cordis.patch.yml`，
> 并按需要把 bundle 列表补齐（`package.json` 的 `dsh.profile.bundles`）。

> 沙箱内构建提示：esbuild 的 JS API 会用管道 spawn 子进程（受限令牌下 `EPERM`），
> 本仓库已在 `package.json` 里改成直接调用 CLI。沙箱里请用
> `node_modules\@esbuild\win32-x64\esbuild.exe src/index.ts --bundle ...` + `node node_modules\typescript\bin\tsc -p tsconfig.json` 两条命令构建。

### 本机实测记录（2026-11-14）

| 验证项 | 证据 |
|---|---|
| 插件装载 | `infinite_context_status` / `infinite_context_handoff` 出现在宿主工具表，session 内可直接调用 |
| 配置生效 | 把 profile patch 设成 `enabled: true` 并给该模型配窗口+阈值后，状态工具返回「触发条件：<阈值>%」「按模型策略：已纳入管理」 |
| 占用测量 | 返回「23.4%（234,065 / 1,000,000 tokens，来源 pressure）」，与 relay 的 `contextPressure` 投影一致 |
| 临界 notice | 真实会话里收到插件 notice：`【任务自动换窗】上下文占用 23.4%（...），已达阈值 10%。将写入检查点并换窗；autoHandoff=false，等你确认后调用 infinite_context_handoff 执行。`（`source.form='notice'`，非用户发言） |
| 设置页座位 | 用 `cordis_inspect_query(client, Slots)` 读**页面真实注册表**：`settings.section` 的 occupants 里应有 `id: 'infinite-context'`，且 `plugins.row.config` 里**不应**有本插件的条目（那是串页的来源） |
| 设置页读写 | 同源 `fetch` ↔ 宿主 exact 路由 ↔ `configEditor`；主区只有「启用 / 阈值 / 自动换窗」三件，高级项默认折叠；GET 失败时显示状态码并禁用控件 |
| 检查点/新窗/注入/fail-closed/防失控 | `npm run smoke` 的 **60 项**离线断言（真实 fs、真实原子写、真实 `.previous`、假 ctx） |
| Client 半件 | `npm run smoke:client` 的 **9 项**离线断言（bundle 加载、单座位、三件主区、按模型双输入、`applied` 不回弹、不限制哨兵、三种降级、主题令牌） |
| profile 恢复副本 | 完整 profile patch 另存一份在 `docs/profile-patch-desktop.good.yml`（重装/事故后直接复制回 `~/.dsh/profiles/<profile>/cordis.patch.yml`） |

> 本机当前窗口显示 **1,000,000 tokens**：模型配置里没声明 `contextWindow`，落到 adapter 默认值。
> 想让百分比更贴近真实可用窗口，在设置页「按模型设窗口与阈值」里填真实窗口（本地模型务必填）
> （这和它记的是同一个坑）。占比相对变大后，阈值判断才有实际意义。

---

## 5. 快速验证（10% 阈值，五分钟）

**第 1 步：把阈值调到 10%，只开提醒**

编辑 `%USERPROFILE%\.dsh\profiles\<profile>\cordis.patch.yml`，在**末尾**追加（注意是数组元素）：

```yaml
- id: infinite-context-orchestrator
  name: dsh-infinite-context-orchestrator
  config:
    enabled: true
    contextWindowByModel: { 'fake-provider/fake-model': 100000 }
    thresholdByModel: { 'fake-provider/fake-model': 10 }
    autoHandoff: false
    checkpointMaxBytes: 65536
    handoffBriefMaxChars: 4000
    checkpointRoot: ''
    projectProgressReserveChars: 1200
```

保存后 DSH 会热重载 profile（也可以重启 GUI）。

**第 2 步：确认插件读到配置**

在会话里问一句「调用 infinite_context_status」，或直接让它自己调。期望看到：

```
总开关：已开启 · 阈值：10% · 自动换窗：关
当前占用：63.4%（xxx / xxx tokens，来源 pressure）
```

如果显示「窗口大小未知」，说明模型没声明 `contextWindow`，百分比阈值不会触发 ——
去设置页「按模型设窗口与阈值」里给这个模型填真实窗口（= n_ctx 减去 max_tokens）。

**第 3 步：等一条插件 notice**

占用 ≥10% 时，下一个 step 就会注入一条 notice（`source.form='notice'`，不是你的发言）：

```
【任务自动换窗】上下文占用 63.4%（...），已达阈值 10%。
将写入检查点并换窗；autoHandoff=false，等你确认后调用 infinite_context_handoff 执行。
```

**第 4 步：验证检查点生成**

```powershell
# 手动闭环（autoHandoff=false 时的入口）
#   在会话里说：调用 infinite_context_handoff，reason 填「验证 10% 阈值」
# 然后看检查点：
Get-ChildItem "$env:USERPROFILE\.dsh\task-checkpoints\orchestrator" -Recurse
Get-Content  "$env:USERPROFILE\.dsh\task-checkpoints\orchestrator\latest.json"
```

期望：`handoffs\<旧sessionId>.json`、`handoffs\history\<时间戳>-<旧sessionId>.json`、`latest.json`。
再触发一次同会话的手动交接，会看到 `<旧sessionId>.json.previous`。

**第 5 步：验证「自动闭环 + 新窗口注入」**

把配置改成 `autoHandoff: true`（阈值保持 10%），然后随便发一句话。期望：

1. 当前会话出现 notice「将自动执行：写检查点 → 开新窗 → 注入交接简报」；
2. 会话列表里多出一个新会话，标题类似 `交接 · <目标>…`；
3. 打开那个新会话，它的**第一条**消息是插件指针，而**新窗口的 system prompt 里**已经有：

```text
## 任务交接简报
你正在接手一个因上下文接近临界点而换窗的任务。
**当前目标**：…
**已完成**：…
**待办**：…
**关键决策/约束**：…
**最后一条人类请求**：…
**检查点文件**：C:\Users\...\handoffs\session-xxx.json
请从“待办”的第一项继续。不要重新开始已完成的工作。
```

怎么证明「从第一个 token 就有」而不是「回读文件才有」：看新会话的
`~/.dsh/sessions/<新sessionId>/` 日志里第一条 `system/message` 事件就含这段文本；
另外 `task-checkpoints\orchestrator\pending-briefs\<新sessionId>.json` 会在新会话产出第一条
assistant 消息后被自动删除（说明它被消费过一次）。

**第 6 步：回归默认**

把 `enabled` 改回 `false`（或把整段 patch 删掉），或改回 `thresholdByModel80` + `autoHandoff: false`。

---

## 6. 边界与已知限制

| 情况 | 行为 |
|---|---|
| 检查点写入失败（权限/磁盘/超 `checkpointMaxBytes`） | **fail-closed**：绝不换窗，发 notice 说明原因与检查点根目录 |
| 新会话创建失败 | 检查点保留，notice 里给出可手动引用的路径 |
| 新会话建了但 agent 1s 内没 live / 首条消息发不出去 | best-effort 销毁半创建会话，保留检查点 |
| 同一 profile 内多个会话同时到线 | 单次 apply 内最多 1 次自动换窗，其余会话收到「已达上限」notice |
| 占用在阈值附近抖动 | 跌回 `threshold-5` 才重新武装，避免刷屏 |
| 子代理 / 队友会话 | 不换窗（避免打断派出去的工作），只对顶层会话生效 |
| 旧会话是否被强制停 | **不强制**。notice 只提醒模型在 phase 边界停手；真正的刹车是 relay 的硬线。要硬停可以配合 relay 的 `relay_handoff` |
| 多进程并发写检查点 | 不支持（与 guard 的 SECURITY 声明一致）；幂等靠原子替换与 `.previous` |
| token 计量精度 | `tokenMeter` 是启发式（约 4 字符/token），中文与 JSON 结构会被低估；只用于判档，不作计费 |

---

## 7. 目录结构

```
src/
  index.ts       插件入口：name / inject / Config / apply（哨兵、prompt 段、事件接线）
  config.ts      schemastery Config + 加载期 fail-loud
  budget.ts      占用测量（contextPressure → tokenMeter → resolveModelInfo）
  extract.ts     从会话投影/事件流抽取 goal/done/pending_todos/关键决策/最后人类请求
  checkpoint.ts  原子写 + .previous + 历史副本 + 脱敏后的检查点文档；待注入简报存储
  brief.ts       交接简报渲染（分档降级到字符预算；项目级摘要预留；模型撰写版的拼接与锚点保留）
  brief-model.ts 模型撰写简报：单次 llm.stream 调用、素材构造、脱敏、失败回退
  handoff.ts     闭环实现：写检查点 → 建新会话 → 注入 → 记账 → 重新武装
  tools.ts       两个工具的定义
  redact.ts      凭据/主目录脱敏
  types.ts       只用到的那部分 DSH 运行时形状
client.js         Client 半件：设置页（只挂 settings.section；同源 fetch 读写 + 宿主主题令牌）
scripts/smoke.mjs         Host 离线冒烟（假 ctx，60 项断言，含设置路由、「不限制」差分与模型撰写简报）
scripts/smoke-client.mjs  Client 离线冒烟（假 loader/React/fetch，9 项断言）
docs/profile-patch-desktop.good.yml  profile patch 的完整备份（事故恢复用）
cordis.patch.yml  装配行 + 全部默认值
```

```powershell
pnpm install --ignore-scripts
pnpm run build          # esbuild bundle → lib/index.js；tsc → lib/types
pnpm run smoke          # Host：60 项离线断言
pnpm run smoke:client   # Client：9 项离线断言
```

