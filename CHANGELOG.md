# 更新日志 · Changelog

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。
This project follows [Semantic Versioning](https://semver.org/).

**目录 · Contents**: [中文](#中文) · [English](#english)

---

## 中文

### 0.1.0 — 首个公开版本

#### 功能

- **自动换窗闭环**：上下文逼近阈值时，写一份交接检查点 → 建全新顶层会话（同分组）→
  把简报注入新会话首轮 system prompt → 叫停旧会话当前轮。
- **按模型配置窗口与阈值**：设置页点「读取模型列表」，逐模型填「真实窗口 + 阈值」；
  没配窗口的模型退回 DSH/服务器读到的值；**不在列表里的模型插件完全不介入**。
- **交接简报**：插件模板或模型撰写（`briefAuthor`）；固定附带「原始需求」原文，
  后续窗口据此核对是否偏离目标；`carryOriginalRequest` 可关。
- **检查点**：每会话稳定路径 `handoffs/<sessionId>.json`（原子替换 + `.previous`），
  不可变历史留 50 份；写入前整份脱敏。
- **旧窗口提示**：交接后在旧窗口 **append** 一条「任务已转移」的 user 消息（不唤醒旧窗口）。
- **设置页**：单文件 `client.js`、单 `settings.section` 座位；主区（启用 / 按模型窗口与阈值 /
  自动换窗）+ 高级（次数上限、待办收尾、简报作者、体积/字数上限、检查点目录）。
- **界面语言**：设置页主区文案跟随 DSH 的 locale（内置 zh / en，其余语言回落 en；切换语言即时生效）；
  插件发给模型的提示与长说明仍为中文。
- **工具**：`infinite_context_status`（状态与距离阈值）、`infinite_context_handoff`（手动换窗）。

#### 关键设计取舍

- **窗口不按模型声明值算**：本地推理常把实际上下文压得比声明小（实测声明 204,800、实际 64K），
  按声明值算百分比永远不会触发，所以要求逐模型填真实提示预算。
- **已交接的会话不再自动换窗**：旧窗口的上下文不会变小，没有这道闸，重启后会反复开新窗口。
- **交接锚点与旧窗口提示都不写 `developer/message`**：会话格式要求它落在「已开启的 turn/step」内，
  否则会把日志写成 corrupt（`SessionFormatError`）。锚点拼在简报里，提示用 `user/message` append。
- **占用测不到时宁可不动**：`usage` 缺失又拿不到 `contextPressure` 时，不做猜测式触发。

#### 兼容性

- 需要 DSH `>= 0.2.1-rc.2`，Node `>= 20`。
- 运行时零依赖（`schemastery` 在构建时打进 `lib/index.js`）。

---

## English

### 0.1.0 — first public release

#### Features

- **Automatic handoff loop**: when the context approaches the threshold, write a handoff checkpoint →
  create a brand-new top-level session (same group) → inject the brief into the new session's first
  system prompt → cancel the old session's current turn.
- **Per-model window and threshold**: click "Load model list" in the settings page and fill in
  "real window + threshold" for each model; models without a window configured fall back to the value
  reported by DSH/the server; **models not in the list are left completely alone**.
- **Handoff brief**: written by the plugin template or by the model (`briefAuthor`); always carries the
  original requirement verbatim so later windows can check for drift; `carryOriginalRequest` can turn it off.
- **Checkpoints**: stable per-session path `handoffs/<sessionId>.json` (atomic replace + `.previous`),
  50 immutable history files kept; the whole document is redacted before writing.
- **Old-window notice**: after the handoff, **append** a "task has moved" user message into the old window
  (without waking it).
- **Settings page**: one file `client.js`, one `settings.section` seat; main area (enabled / per-model
  window and threshold / auto-handoff) plus advanced (handoff cap, todo wrap-up, brief author, size and
  length caps, checkpoint directory).
- **UI language**: the main area follows DSH's locale (zh and en built in, other locales fall back to en; switching takes effect immediately);
  prompts sent to the model and the long explanatory text are still Chinese.
- **Tools**: `infinite_context_status` (state and distance to threshold), `infinite_context_handoff`
  (manual handoff).

#### Key design decisions

- **Windows are not computed from the declared value**: local inference often gives less context than the
  declaration claims (measured: declared 204,800, actual 64K), so a percentage based on the declaration
  never fires; hence the requirement to enter a real prompt budget per model.
- **A session that has already handed off is never handed off again automatically**: the old window's
  context does not shrink, so without that gate a restart would keep opening new windows.
- **Neither the handoff anchor nor the old-window notice writes `developer/message`**: the session format
  requires it inside an open turn/step, otherwise the log becomes corrupt (`SessionFormatError`). The
  anchor is prefixed to the brief; the notice is appended as a `user/message`.
- **When occupancy cannot be measured, do nothing**: if `usage` is missing and `contextPressure` is
  unavailable, the plugin refuses to guess.

#### Compatibility

- Requires DSH `>= 0.2.1-rc.2`, Node `>= 20`.
- Zero runtime dependencies (`schemastery` is inlined into `lib/index.js` at build time).
