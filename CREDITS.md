# 致谢与来源标注

`dsh-infinite-context-orchestrator` 不是凭空写出来的：它的**判据、契约、边界**几乎全部来自四个优秀的 DSH 插件。
本文件按开发礼仪把作者、仓库、许可、以及「具体借用了什么」写清楚。四个上游项目均为 **MIT**，各自版权归其作者所有。

---

## 一、上游插件

| 插件 | 作者 | 仓库 | 版本（开发时） | 许可 | 与本项目的关系 |
|---|---|---|---|---|---|
| **dsh-context-relay** | rezon-aki `<rezon-aki@users.noreply.github.com>` | [rezon-aki/dsh-context-relay](https://github.com/rezon-aki/dsh-context-relay) | 0.5.0 | MIT | **依赖（预算判据）** |
| **dsh-task-checkpoint-guard** | jlnkx5200-beep | [jlnkx5200-beep/dsh-task-checkpoint-guard](https://github.com/jlnkx5200-beep/dsh-task-checkpoint-guard) | 0.2.1 | MIT | **依赖（持久化契约）** |
| **dsh-project-progress** | Jolly-J | [Jolly-J/dsh-project-progress](https://github.com/Jolly-J/dsh-project-progress) | 0.1.0-rc.5 | MIT | **依赖（项目级摘要）** |
| **dsh-context-window** | qq-24 | [qq-24/dsh-context-window](https://github.com/qq-24/dsh-context-window) | 1.0.0 | MIT | **边界对齐（不调用）** |
| dsh-context-window（设计/交接文档版） | CooperZhuang | [CooperZhuang/dsh-context-window](https://github.com/CooperZhuang/dsh-context-window) | 0.0.1 | MIT | **文档参考**（DSH API 地图与交接笔记） |

---

## 二、具体借用了什么（不夸大、也不含糊）

### 1. dsh-context-relay —— 上下文预算的"真源"与换窗路径

- **`contextPressure` 投影**：`{ contextWindow, pressureTokens, projectedTokens }` 是占用率的**第一证据**。
  本项目 `src/budget.ts` 的读取顺序（projectedTokens → pressureTokens → tokenMeter.totalTokens）与 relay 的
  `readPressure` 同口径；这套字段名与语义完全由 relay 定义。
- **分档口径**：本插件按模型配置的阈值必须低于 relay 的硬线（`relayRatio ≈ 阈值 + 10`），
  这个"留 10% 给写盘"的约定来自 relay 的设计，也写在本项目的文档与 `cordis.patch.yml` 注释里。
- **插件 notice 的消息形状**：`source: { kind: <生产者自有>, form: 'notice', summary }`。
  DSH v4 的行准入要求生产者自有 kind，这条经验与形状直接沿用 relay 的 `noticeMessage()`。
- **换窗的 Session API 路径**：`sessionController.create({cwd, agentPreset})` 优先、
  `agents.create + agentPresets.mount` 兜底、建完轮询 `agents.list()` 等 live ——
  与 relay 的 `relay_handoff` 是同一条路线（relay 的注释明确说裸 `agents.create` 会在首轮触发
  provider INVALID_REQUEST，这条坑是它替我们趟出来的）。

> 本项目**不调用** relay 的 `relay_handoff` 工具：relay 把交接正文作为首条 **user** 消息发送，
> 而本项目要求简报进入 **system prompt**（第一个 token 可见），因此只复用它的判据与路径，换窗由本项目自己执行。

### 2. dsh-task-checkpoint-guard —— 检查点的持久化契约

- **原子写**：同目录唯一临时文件 → `fsync` → `rename` 就位；`<target>.previous` 保留上一版；
  目录 fsync 失败按 `EINVAL/EISDIR/EPERM/EACCES/EBADF` 容忍；Windows 不允许覆盖 rename 时
  用"先挪走再就位"兜底 —— 这套算法与容错清单以 guard 的 `src/storage.js` 为参考实现。
- **目录根**：默认 `${DSH_HOME}/task-checkpoints`。本项目写在自己的子目录 `orchestrator/` 下，
  与 guard 的 `tasks/` `sessions/` 并存不冲突，便于用户集中查看。
- **脱敏**：写入前清洗凭据的思路（以及"检查点会被另一个窗口读到，所以必须假定字符串里有密钥"）来自 guard 的 `redact.js`。

> 本项目**不 import** guard 的任何模块：它的 `package.json` 只导出 `.`，且 DSH profile 里解析不到
> `@deepseek-ai/*`，因此复刻同一份契约而不是硬链内部文件。

### 3. dsh-project-progress —— 项目级上下文的来源

- **`PROGRESS.md` 的区域结构**：`## 项目档案`（稳定事实）+ `## 进展时间线`（追加式记录）由它维护。
  本项目只读这份文件，把「档案 + 时间线尾部」压缩后作为简报末尾的**项目级摘要**，
  并与任务级简报共享 `handoffBriefMaxChars` 预算。
- **注入顺序**：它的 `systemPrompt.section(order: 60)` 保持不变，本项目的简报用 `order: 55` 排在它之前。

### 4. dsh-context-window —— 边界与写法上的参考

- **硬约束**：换窗必须是**新会话**，不在同一会话内切换 preset。这条边界与它的设计一致，本项目严格遵守。
- **Config 写法**：schemastery schema + 加载期 fail-loud（非法值直接抛、不静默改默认）的写法参考了它的 `src/config.ts`。
- **文档参考**：CooperZhuang 那份仓库的 `docs/handoff.md` 整理的 DSH API 地图
  （`tokenMeter.measure`、`llm.resolveModelInfo`、`agent/pre-step` 注入、`session.append` 等）为本项目省掉了大量试错。

---

## 三、版权声明

- 本项目的**源码为独立实现**，没有复制上述项目的代码；运行时**不 import** 它们的任何模块（本插件零运行时依赖，`lib/index.js` 只 import Node 内建）。
- 上述四个插件与 DSH 本体各自保留其原始版权与许可（均 MIT）。
- 本项目同样以 [MIT](LICENSE) 发布。

如果你认为这里的标注有遗漏或不准确，欢迎开 issue 纠正 —— 标注错误本身就是需要修的 bug。
