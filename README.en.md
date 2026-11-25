# Task Auto-Handoff (dsh-infinite-context-orchestrator)

[screenshot](docs/screenshot.png)

[简体中文](README.zh.md) · **English**

> 📖 First time here, or not in the mood for jargon? Read [USERGUIDE.md](USERGUIDE.md) (plain-language walkthrough, currently Chinese).

**The problem it solves**: long tasks eventually fill the context, and then you have to summarise the progress, open a new session and explain everything again.

**What it does**: when the context approaches its limit, it first writes the current progress into a **handoff checkpoint**, then opens a **new session**, and puts the *original requirement / current goal / completed work / pending todos / constraints* at the very top of that new session. The new window therefore knows what to continue from its first sentence, and you do not have to repeat yourself.

---

## Installation: copy install vs link install

`dsh plugin add <dir>` creates a **junction (link)**: DSH actually loads the files in your workspace, so reorganising the workspace can break the installed plugin.

This plugin ships a copy-install script, which keeps an independent copy inside the plugin directory and leaves the workspace as a mirror source:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-copy.ps1              # default profile=desktop
powershell -ExecutionPolicy Bypass -File scripts\install-copy.ps1 -WhatIf      # dry run
```

After that, the workflow for code changes is: `pnpm run build` → run the script again → restart DSH.

## How to use

Open **Settings → Task Auto-Handoff**. There are three switches:

| Option | Description |
|---|---|
| **Enabled** | Master switch. When off, the plugin does nothing at all. |
| **Per-model window & threshold** | After clicking "Load model list", each model gets a row: the left field is the **real prompt budget** (= `n_ctx` − reserved output tokens), the right field is **that model's threshold**. Leaving both empty means "not set for this model" (the plugin stays out of it). Only the models listed here are managed. |
| **Auto-handoff** | **Off by default.** When off you are only warned and hand off after you confirm; when on it hands off automatically at the threshold. |

**"Notify the old window after handoff"** (on by default): after handing off, a "task has moved" message is appended to the **end of the old window's conversation** (written into the session log, **without waking** that window — so it does not run an extra turn and compete with the new window for the model). It states the new session id, the checkpoint path, and that the old window is for review only. Turn it off to leave the old window completely alone.

**"Max auto-handoffs"** (default 10, 0 = unlimited): how many automatic handoffs are allowed within one plugin load. A small local model can only do 20-30k tokens of work per window, so a long task needs several; setting this too low stops the chain at the second window.

**"Close out old todos after handoff"** (on by default): after a successful handoff, unfinished todos in the old window are marked completed. Otherwise the old window keeps showing an "in progress" task that will never finish, which looks like a failed handoff.

**"Who writes the brief"** is an advanced option:

- **Plugin template** (default): generated from structured facts (goal / todos / done / user constraints); deterministic, no extra model call.
- **Model-authored**: one extra model call before the handoff, letting the model write a narrative handoff (what was done, why, what is next). Failure falls back to the template and **never blocks the handoff**. The model only writes the narrative part; todos / checkpoint path / closing instructions are still assembled by the plugin, so the new window always gets an actionable next step.

The remaining advanced items usually need no changes (brief length cap, checkpoint size cap, project-summary reserve, checkpoint directory); each has "restore default" and applies immediately. The three numeric items have an **"unlimited"** option: ticking it disables trimming (brief items and length, checkpoint size, project summary length). **If you use model-authored briefs, set the brief cap to "unlimited"** — a few thousand characters is a rounding error for a 128K window.

## Language

The main controls of the settings page follow the DSH interface language: **Chinese and English** are built in, and the other locales (ja / es / fr / de / ru / pt) fall back to English. Long explanatory text and the prompts the plugin sends to the model are currently Chinese.

## What you see at the threshold

A **plugin notice** (not your message, and it does not interrupt the current work):

```
【任务自动换窗】上下文占用 82.3%（…），已达阈值 80%。
将写入检查点并换窗；autoHandoff=false，等你确认后调用 infinite_context_handoff 执行。
```

- **Auto-handoff off**: say "hand off" or call `infinite_context_handoff`, and only then does it run the full loop.
- **Auto-handoff on**: it hands off directly, and the current session also receives a "done, new session is xxx" note.
- To check the state at any time (usage, threshold, latest checkpoint), ask the assistant to call `infinite_context_status`.

## How the new window is started and supervised

- The handoff is done by the **plugin** (write checkpoint → create session → inject brief → send first message); the model does not switch sessions by itself.
- The **first step** of the new window is triggered by the plugin sending one message with `followup` (that message wakes the agent and starts the first turn).
- "What to do first" is additionally written at the start of the new session's history as a **developer message** (higher priority than an ordinary user message); if the host rejects that shape, it degrades to prefixing the anchor to the brief.
- **Nudging**: if the new window's first reply only talks and does not act (no tool call, and the reply is short or ends with a question), the plugin sends one corrective message naming the first todo — only once, never repeatedly.

## FAQ

**Why does it show 1,000,000 tokens?**
When the model config does not declare `contextWindow`, the host falls back to the adapter default. Add `contextWindow` to the model to make it match the real window (otherwise the percentage is understated and the threshold is hard to reach).

**There is no "Task Auto-Handoff" page in Settings / the page is empty?**
Hard-refresh the page (`Ctrl+Shift+R`) first. If it persists, open `F12` and look for console logs starting with `[dsh-infinite-context]`.

**How do configuration changes take effect?**
Saving in the settings page is enough (it reconciles itself). If you edit the profile's `cordis.patch.yml` by hand, restart DSH or re-run `dsh plugin add <this directory>`.

**After upgrading or changing plugin code?**
UI only (`client.js`) → hard-refresh the page (`Ctrl+Shift+R`). Host side (`lib/index.js`, e.g. a new endpoint needed by the settings page) → **DSH must be restarted**; a running process does not hot-load plugin modules.

**Where is the checkpoint after a handoff?**
Default `~/.dsh/task-checkpoints/orchestrator/`: `handoffs/<session-id>.json` is the latest one (the previous version is kept as `<same-name>.previous`), `handoffs/history/` is immutable history, and `latest.json` is a pointer.

**Will secrets end up in the checkpoint?**
No. Everything is redacted before writing (`sk-*`, GitHub/AWS tokens, JWTs, `Bearer`, `password=`, PEM private keys, home-directory paths).

**Can a handoff lose work?**
If the checkpoint cannot be written, the handoff is **abandoned** (fail-closed) and you stay in the original session; if session creation fails, the checkpoint is kept and its path is reported.

## Credits

The criteria, contracts and boundaries of this plugin come from four DSH plugins (all MIT, copyright belongs to their authors):

| Plugin | Author | Repository | What was borrowed |
|---|---|---|---|
| `dsh-context-relay` | rezon-aki | [rezon-aki/dsh-context-relay](https://github.com/rezon-aki/dsh-context-relay) | the `contextPressure` projection and threshold semantics, notice message shape, the Session API path used for handoff |
| `dsh-task-checkpoint-guard` | jlnkx5200-beep | [jlnkx5200-beep/dsh-task-checkpoint-guard](https://github.com/jlnkx5200-beep/dsh-task-checkpoint-guard) | atomic checkpoint writes, the `.previous` retention contract, the redaction approach |
| `dsh-project-progress` | Jolly-J | [Jolly-J/dsh-project-progress](https://github.com/Jolly-J/dsh-project-progress) | the `PROGRESS.md` section structure (source of the project-level summary) |
| `dsh-context-window` | qq-24 | [qq-24/dsh-context-window](https://github.com/qq-24/dsh-context-window) | the "handoff must be a new session" boundary, schemastery Config and fail-loud style |
| `dsh-context-window` (design notes) | CooperZhuang | [CooperZhuang/dsh-context-window](https://github.com/CooperZhuang/dsh-context-window) | the DSH API map collected in its `docs/handoff.md` |

Which line borrowed which contract, and where this plugin's boundary lies, is documented in **[CREDITS.md](CREDITS.md)** (Chinese). This project is an independent implementation with **zero runtime dependencies** (it imports none of the modules above).

## Related advice: cap how much a single `read` pulls in

On small-window models (say local 64K), **one `read` of a large file can eat half the window**, and **whatever was read stays in the context** (it is re-sent on every later request; it is not cleaned up after reading). Measured: reading three files in one step (about 82 KB in total) moved the context from 14k to about 50k tokens, and the next request was rejected by the server with `400 prompt + max_tokens exceeds n_ctx`.

Two ways to prevent it:

1. **Throttle on the DSH side** (global): add caps to the built-in `tool-fs` in the profile's `cordis.patch.yml` — `readLimit` (lines), `readMaxBytes` (bytes), `readMaxLineLength` (characters per line); defaults are 2000 / 50 KB / 2000.
2. **Constrain by instruction** (what we currently use locally): the global `~/.dsh/AGENTS.md` requires "read only 1 file at a time, ≤ 400 lines / ≤ 12 KB, continue with `offset`/`limit`; never read several large files in one step".

The plugin also has a safety net: after `step/end` and `tool/result` the occupancy cache is invalidated, so **a jump within one step is visible at the next pre-step**, and as long as the threshold sits below the server's error line, the handoff happens before the request is sent.

## For maintainers

The internals, the closed-loop implementation, the three hard constraints of the settings page, the offline tests and the on-machine test log are all in **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** (Chinese). The pre-release checklist is in **[PUBLISHING.md](PUBLISHING.md)**, version history in **[CHANGELOG.md](CHANGELOG.md)**, and the license in **[LICENSE](LICENSE)** (MIT).

```powershell
pnpm install --ignore-scripts
pnpm run build          # esbuild → lib/index.js; tsc → lib/types
pnpm run smoke          # Host: 60 offline assertions
pnpm run smoke:client   # Client: 9 offline assertions
pnpm run check          # all of the above plus typecheck (release gate)
```
