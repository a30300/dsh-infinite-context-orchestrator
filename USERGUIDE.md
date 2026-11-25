# 给第一次用的人 · A guide for first-time users

**目录 · Contents**: [中文](#中文) · [English](#english)

---

## 中文

> 这份说明用大白话写，不需要懂技术。想深入的技术细节在 [README.md](README.md) 和 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

---

### 它帮你解决什么问题

和 AI 聊天，聊得越久，它"记着的东西"就越多：你前面提的要求、改过的文件、定下来的规矩……

到某个点，它会开始出问题：忘了你三天前说的"这个不能改"、重复问已经回答过的事、或者干脆因为"装不下"而把前面一半对话丢掉。

就像一张桌子，堆满了纸，你就找不到正在看的那份文件了。

**这个插件的做法是：在你还没被逼到墙角之前，先帮你换一张干净的桌子，并把最重要的几页摆到新桌子最上面。**

它不会"把旧对话压缩成一段摘要"（那样每次压缩都会损失一点细节），而是**另开一个新对话**，然后告诉新对话里的 AI：任务是什么、做到哪了、接下来做什么、哪些不能动。

---

### 它会替你做的三件事

1. **快到临界时提醒你**。只弹一条提示，不打断你正在做的事。
2. **写一张"便条"**。记下：目标是什么、已经做完什么、还有什么没做、你明确说过的规矩、你最后一句要求是什么。
3. **开一个新对话，把便条摆到最前面**。新对话里的 AI 一开口就知道该接着干什么，不用你重新讲一遍。

第 3 步有两种模式，你可以自己选：

- **只提醒**（默认）：它提醒你"快满了"，什么时候换、换不换，你说了算。
- **自动换**：达到你设的百分比，它自己写便条、自己开新对话、自己把便条贴过去，你什么都不用点。

---

### 怎么装

#### 它需要别的插件吗

不需要。0.1.0 起本插件是独立实现：占用测量走 DSH 自带的投影/计量服务，检查点写自己的子目录，
不依赖任何第三方插件。README 的「致谢与来源」里列的那四个上游插件是"设计上的老师"（判据与契约参考过它们），
**不用安装**。

#### 再装本插件

如果你拿到的是一个文件夹（本插件），在命令行里执行：

```powershell
dsh plugin --profile <你的配置名> add "<插件所在文件夹>"
```

举两个例子（把尖括号里的内容换成你自己的）：

```powershell
# 例 1：配置名叫 desktop，插件放在 D 盘的某个文件夹里
dsh plugin --profile desktop add "D:\我的插件\dsh-infinite-context-orchestrator"

# 例 2：插件就放在下载目录里（解压出来的文件夹）
dsh plugin --profile desktop add "C:\Users\你的用户名\Downloads\dsh-infinite-context-orchestrator"
```

几点要注意：

- `<插件所在文件夹>` 指的是**本插件解压后的那个文件夹**（里面能看到 `package.json`），不是上一层目录。
- 路径里有**中文或空格**时，一定要用英文双引号 `"` 把整条路径包起来。
- `--profile` 后面写**你正在用的那个配置名**（常见是 `desktop`；不确定就看 DSH 设置里显示的配置名）。

**如果你不会用命令行**：把上面那行整段复制给 DSH 里的助手，说"帮我执行"，它就能替你跑（作者就是这么装的）。

> ⚠️ **卸载的时候别用 `dsh plugin remove`**。实测这条命令会把你的配置文件改坏（把不相关的设置一起删掉，甚至让 DSH 起不来）。真要卸载，先让助手备份配置文件，或者干脆只在设置里把开关关掉。

---

### 第一次使用：先找到设置页

装好后，打开：**设置 → 任务自动换窗**（页面主区跟随 DSH 界面语言，中英双语）。

看不到的话：

1. 按 `Ctrl + Shift + R` 硬刷新页面；
2. 还是没有？重启一次 DSH（有些改动要重启才生效）。

---

### 怎么设置（三个开关）

设置页里主要就三样东西（主区没有别的开关了）：

| 选项 | 它是什么意思 | 建议 |
|---|---|---|
| **启用** | 总开关。关掉它，插件就完全不动作 | 打开 |
| **按模型设窗口与阈值** | 先点「读取模型列表」，再逐个模型填两格：**窗口**（真实提示预算 = n_ctx − max_tokens）和**阈值**（百分比）。不填 = 不设置，插件不会管这个模型。 |
| **自动换新窗口** | 打开 = 到了就自动换；关闭 = 只提醒你，你确认了才换 | 先**关闭**，用几次有感觉了再打开 |

下面还有一个折起来的「**高级**」，里面的东西**不懂就别动**。一句话解释：

- **自动换窗次数上限**（默认 10，可设「不限制」）：一次启动内最多自动换几次窗口。
  本地小模型（64K 那种）一个窗口只能干两三万字的活，长任务要连着换好几次窗；这个值太小，
  第二次就该换的时候它只会提醒你、不再自己动手。
- **换窗后提醒旧窗口**（默认打开）：换完窗口，会在**这个旧窗口的对话末尾**追加一条「任务已转移到新会话 xxx」，
  写进会话日志但**不唤醒**旧窗口，所以不会多跑一轮、也不会和新窗口抢模型。
- **交接后收尾旧待办**（默认打开）：换完窗口后，把旧窗口里那些没做完的任务标成「已完成」。
  不这么做的话，旧窗口会一直挂着一条「进行中」，看起来像出错了。不想让它动你的任务列表就关掉。
- **简报由谁写**：`插件模板` = 插件照着便条内容填（稳、不用额外花钱）；`模型撰写` = 让 AI 自己写一段更完整的交接说明（多一次调用，写失败了会自动退回模板）。
- **简报字数上限**：便条最多写多少字。可以选「不限制」。
- **检查点文件大小上限**：便条文件最大多少。可以选「不限制」。
- **留给项目进展的字符数**：留多少位置给项目进展摘要（0 = 不带）。
- **检查点存放目录**：便条文件存哪。留空就是默认位置。

改完**立刻生效**，不用重启，也不用重新安装。

---

### 到了临界点，你会看到什么

#### 只提醒模式（`autoHandoff` 关闭）

你会收到一条**灰色提示**（不是你自己说的话）：

```
【任务自动换窗】上下文占用 82.3%（…），已达触发条件：<你在设置里填的阈值>%。
将写入检查点并换窗；autoHandoff=false，等你确认后调用 infinite_context_handoff 执行。
```

这时候你只要说一句"**换窗**"（或者"调用 infinite_context_handoff"），它就去办。

#### 自动模式（`autoHandoff` 打开）

它直接办完，然后告诉你：

```
换窗完成。新会话：session-xxxx
检查点：C:\Users\<你的用户名>\.dsh\task-checkpoints\orchestrator\handoffs\session-xxxx.json
简报：3674 字符
交接锚点：已拼在简报最前面（随系统提示一起注入），第一件事：……
```

> 「交接锚点」就是便条最前面的那一句：告诉新窗口**第一件事先做什么**，不用它自己猜。

#### 新对话里长什么样

新对话的第一屏会有一段「**任务交接简报**」，写着目标、已完成、待办、你的规矩。这是正常的，它就是那张"便条"，只在这个新对话里看得到。

接着新对话里的 AI 会从"待办"第一项开始干，不会再问你"我们要做什么"。

---

### 常见问题

**问：它会不会打断我正在做的事？**
不会。它只在"这一步做完了、下一步还没开始"的时候动手，正在写的文件会写完。换窗最多让下一步慢一秒左右。

**问：它会不会自己乱开对话？**
不会。一次加载里最多自动换「自动换窗次数上限」那么多次（高级里可改，默认 10，也能设为不限制）；
而且"只提醒"模式（默认）下，换不换完全由你决定。

**问：明明感觉快满了，它却一直不提醒？**

最常见的原因是**没有给这个模型填窗口/阈值**，或者填的窗口比真实可用的大。本插件只按你在设置页里
填的「窗口 + 阈值」算百分比；没填窗口时会用 DSH/服务器读到的值，而本地推理软件（llama.cpp 之类）
常把实际可用的上下文压得比声明的小：比如启动时限制 64000，模型配置里却写着 204800 —— 按声明算 80%
要等到 163840 才会触发，实际早就装不下了。

**解决办法（推荐）**：设置 → 任务自动换窗 →「按模型设窗口与阈值」→ 点「**读取模型列表**」，
在**本地模型那一行**填两个数：

- **窗口** = 你启动时设的上下文减去输出预留。例如 `n_ctx=64000`、`max_tokens=16384`，就填 **47616**；
- **阈值** = 你想要在百分之多少时换窗，例如 **60**（约 28,570 tokens 时触发）。

其它模型不受影响；没配窗口也没配阈值的模型，插件完全不介入（不会因为配了本地模型就把 1M 窗口的云端会话也换掉）。
万一「读取模型列表」失败（红字会说明原因），下方有「手动添加模型」：填 `provider/模型名` + 窗口 + 阈值，
效果一样。

想知道现在离触发还差多少：让助手调用 `infinite_context_status`，它会写出「距离阈值：还差 X% · 还差 Y tokens」
以及「按模型策略：已纳入管理 / 未纳入管理」。

**问：开了自动换，新对话万一不动手怎么办？**
插件会看一眼新对话的第一句回复：如果只是"好的，我看看"这种没动手的，它会催一次，并点名"第一件事是……"。只催一次，不会一直唠叨。

**问：我的密钥、密码会不会被写进便条？**
写之前会自动打码（`sk-...`、各种 token、密码、私钥、你的电脑用户名路径都会替换掉）。不过**最稳妥的做法**是别把密钥直接贴在对话里。

**问：便条存在哪？占地方吗？**
默认在 `C:\Users\<你的用户名>\.dsh\task-checkpoints\orchestrator\`。一份便条一般几 KB，每个对话保留最新一份，历史最多留 50 份，不会无限长大。

**问：不想要这些文件了怎么清？**
删 `task-checkpoints\orchestrator\` 这个文件夹就行，下次换窗会自动重建。
本插件不往 `tasks\`、`sessions\` 里写东西；如果你另外装了用这两个目录的插件，别动它们。

**问：那个新开的对话我想删掉，会不会影响什么？**
不会。便条只在那一个新对话里，删了它就跟着没了。

**问：设置页显示 1,000,000 tokens 是什么意思？**
意思是"AI 一次能记住一百万字"。如果你用的模型没写清楚自己有多大，系统会按默认值算，所以百分比会偏小、不容易触发提醒。更省事的做法是在本插件的「按模型设窗口与阈值」里直接填真实窗口 + 阈值。

**问：它和"自动压缩"是冲突的吗？**
不冲突，是两种不同思路。压缩 = 把旧对话挤成摘要接着用；这个插件 = 干脆换个新对话。可以只用一个，也可以并存。

**问：会不会很贵？**
"只提醒"和"插件模板写便条"都不额外调用 AI，只是多写几个小文件。只有你把"简报由谁写"改成"模型撰写"时，才会多一次模型调用。

---

### 换窗后新窗口在哪个分组

新窗口会**和你原来的窗口在同一个分组里**（分组就是"工作区"）。插件会先查你当前窗口属于哪个工作区，
再让新窗口加入同一个；查不到才会单独建一个。

如果你以后整理文件、想更新已安装的插件：先在工作区里 pnpm run build，再执行
powershell -ExecutionPolicy Bypass -File scripts\install-copy.ps1，然后重启 DSH。插件目录里放的是独立副本，删改工作区不会影响它。

### 想了解更多

- 功能全貌与安装细节：[README.md](README.md)
- 它到底怎么实现的、踩过哪些坑：[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- 它借用了谁的成果（四个上游项目的作者）：见 [README.md](README.md) 的「致谢与来源」
- 改了什么：[CHANGELOG.md](CHANGELOG.md)

---

## English

> This guide is written in plain language; no technical background needed. The deep details are in [README.md](README.md) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

### The problem it solves

The longer you chat with an AI, the more it has to "remember": requirements you stated earlier, files you changed, rules you settled on…

At some point it starts to break down: it forgets the "don't touch this" you said three days ago, asks again about something already answered, or simply drops the first half of the conversation because it no longer fits.

It is like a desk covered in paper: you can no longer find the document you were reading.

**What this plugin does is swap in a clean desk before you hit the wall, and put the most important few pages on top of the new desk.**

It does not "compress the old conversation into a summary" (every compression loses detail). Instead it **opens a new conversation** and tells the AI in it: what the task is, how far you got, what comes next, and what must not be touched.

---

### The three things it does for you

1. **Warns you near the limit.** Just one notice, and it does not interrupt what you are doing.
2. **Writes a "sticky note".** It records: the goal, what is done, what is left, the rules you stated explicitly, and your last request.
3. **Opens a new conversation and puts the note at the top.** The AI there knows what to continue from its first word, so you do not have to explain again.

Step 3 has two modes, your choice:

- **Warn only** (default): it tells you "getting full"; when and whether to hand off is up to you.
- **Auto-handoff**: at the percentage you configured, it writes the note, opens the new conversation and puts the note there itself — you click nothing.

---

### How to install

#### Does it need other plugins?

No. Since 0.1.0 this plugin is self-contained: occupancy measurement uses DSH's built-in projection/meter services, and the checkpoint goes into its own subdirectory. It depends on no third-party plugin. The four upstream projects listed under "致谢与来源" in the README are "design teachers" (their criteria and contracts were referenced) and **do not need to be installed**.

#### Then install this plugin

If what you have is a folder (this plugin), run:

```powershell
dsh plugin --profile <your-profile-name> add "<plugin-folder>"
```

Two examples (replace what is inside the angle brackets):

```powershell
# Example 1: profile is called desktop, the plugin sits somewhere on drive D
dsh plugin --profile desktop add "D:\my-plugins\dsh-infinite-context-orchestrator"

# Example 2: the plugin is in your Downloads folder (the extracted folder)
dsh plugin --profile desktop add "C:\Users\your-name\Downloads\dsh-infinite-context-orchestrator"
```

A few things to watch:

- `<plugin-folder>` means **the extracted folder of this plugin** (the one containing `package.json`), not its parent.
- If the path contains **Chinese characters or spaces**, wrap the whole path in double quotes `"`.
- After `--profile`, write **the profile you are actually using** (commonly `desktop`; if unsure, check the profile name shown in DSH's settings).

**If you are not comfortable with the command line**: paste that line into the DSH assistant and say "please run this" — it can do it for you (that is how the author installed it).

> ⚠️ **Do not use `dsh plugin remove` to uninstall.** Measured: that command mangles your profile config (it deletes unrelated settings and can even keep DSH from starting). If you really need to uninstall, ask the assistant to back up the profile first, or simply turn the plugin off in the settings page.

---

### First use: find the settings page

After installing, open: **Settings → Task Auto-Handoff** (the main controls of the page follow the DSH interface language, Chinese and English).

If you cannot see it:

1. Hard-refresh the page with `Ctrl + Shift + R`;
2. Still nothing? Restart DSH once (some changes only take effect after a restart).

---

### How to configure it (three switches)

The settings page has three main things:

| Option | What it means | Suggestion |
|---|---|---|
| **Enabled** | Master switch. Turn it off and the plugin does nothing at all. | On |
| **Per-model window & threshold** | Click "Load model list", then fill two fields per model: **window** (the real prompt budget = `n_ctx` − `max_tokens`) and **threshold** (a percentage). Leaving them empty means "not configured": the plugin ignores that model. | Fill in for your local model |
| **Auto-handoff** | On = hand off automatically at the threshold; off = only warn you, and hand off after you confirm. | Start **off**; turn it on once you are comfortable |

Below that there is a collapsed **"Advanced"** section. **Do not touch it unless you understand it.** In one sentence each:

- **Max auto-handoffs** (default 10, can be set to unlimited): how many automatic handoffs are allowed in one run. A small local model (64K, say) can only do 20-30k tokens of work per window, so a long task needs several handoffs in a row; if this number is too small, the second time it should hand off it will only warn you instead of acting.
- **Notify the old window after handoff** (on by default): after handing off, one line "the task has moved to new session xxx" is appended at the end of the old window, so you can see what happened. It is appended without waking the old window.
- **Close out old todos after handoff** (on by default): marks the unfinished todos in the old window as done. Otherwise the old window keeps showing an "in progress" task that looks like a failure. Turn it off if you do not want your todo list touched.
- **Who writes the brief**: `plugin template` = the plugin fills it from the note (stable, no extra cost); `model-authored` = let the AI write a fuller handoff narrative (one extra model call; falls back to the template on failure).
- **Brief length cap**: the maximum number of characters in the note. Can be set to unlimited.
- **Checkpoint file size cap**: the maximum size of the checkpoint file. Can be set to unlimited.
- **Characters reserved for project progress**: how much room to leave for the project-progress summary (0 = none).
- **Checkpoint directory**: where the note files live. Leave empty for the default location.

Changes take effect **immediately** — no restart, no reinstall.

---

### What you see at the threshold

#### Warn-only mode (`autoHandoff` off)

You get one **gray notice** (not something you said):

```
【任务自动换窗】上下文占用 82.3%（…），已达触发条件：<the threshold you configured>%。
将写入检查点并换窗；autoHandoff=false，等你确认后调用 infinite_context_handoff 执行。
```

At that point just say "**hand off**" (or "call infinite_context_handoff") and it does the work.

#### Auto mode (`autoHandoff` on)

It does everything and then tells you:

```
换窗完成。新会话：session-xxxx
检查点：C:\Users\<your-name>\.dsh\task-checkpoints\orchestrator\handoffs\session-xxxx.json
简报：3674 字符
交接锚点：已拼在简报最前面（随系统提示一起注入），第一件事：……
```

> The "handoff anchor" is the first line of the note: it tells the new window **what to do first**, so it does not have to guess.

#### What the new conversation looks like

Its first screen contains a "**任务交接简报**" (task handoff brief): the goal, what is done, pending todos, your rules. That is expected — it is the note, visible only in that new conversation.

The AI there then starts from the first pending todo and does not ask you "what are we doing?" again.

---

### FAQ

**Will it interrupt what I am doing?**
No. It acts between steps ("this step finished, the next has not started"), so files being written are finished first. A handoff delays the next step by about a second at most.

**Will it open conversations on its own?**
No. Within one run it hands off at most "max auto-handoffs" times (configurable in Advanced, default 10, unlimited possible); and in warn-only mode (the default) whether to hand off is entirely your call.

**I feel the context is nearly full, but it never warns me?**

The most common reason is that **you did not configure a window/threshold for this model**, or the window you entered is larger than what is really available. This plugin computes the percentage from the "window + threshold" you enter; when no window is configured it falls back to the value DSH/the server reports, and local inference software (llama.cpp and friends) often gives you less context than declared: for example you start it with 64000, but the model config claims 204800 — 80% of the declaration would only trigger at 163840, long after it actually overflowed.

**The fix (recommended)**: Settings → Task Auto-Handoff → "Per-model window & threshold" → click **Load model list**, then fill two numbers **in the local model's row**:

- **Window** = the context you started with minus the output reserve. For example `n_ctx=64000` and `max_tokens=16384` means **47616**;
- **Threshold** = the percentage at which you want the handoff, for example **60** (triggers at about 28,570 tokens).

Other models are unaffected; models with neither a window nor a threshold are left completely alone (configuring a local model will never hand off a 1M-window cloud session). If "Load model list" fails (the red text explains why), use "Add a model manually" below it: fill `provider/model` + window + threshold and it works the same.

To see how far you are from triggering, ask the assistant to call `infinite_context_status`; it reports "distance to threshold: X% left · Y tokens left" and "per-model policy: managed / not managed".

**I turned auto-handoff on, but what if the new conversation does not start working?**
The plugin looks at the first reply in the new conversation: if it only says "okay, let me look" without acting, the plugin sends one nudge naming the first task. Once only, never nagging.

**Will my keys and passwords end up in the note?**
They are masked before writing (`sk-...`, various tokens, passwords, private keys, your home-directory path are all replaced). Still, **the safest habit** is not to paste keys into the chat at all.

**Where is the note stored, and does it take much space?**
By default `C:\Users\<your-name>\.dsh\task-checkpoints\orchestrator\`. A note is usually a few KB; each conversation keeps its latest one and history is capped at 50 files, so it does not grow forever.

**How do I clean these files up?**
Delete the `task-checkpoints\orchestrator\` folder; it is recreated on the next handoff. This plugin writes nothing into `tasks\` or `sessions\`; if you installed other plugins that use those directories, leave them alone.

**If I delete the newly opened conversation, does it break anything?**
No. The note lives only in that one conversation, so it disappears with it.

**What does "1,000,000 tokens" in the settings page mean?**
It means "the AI can remember a million characters at once". If your model does not declare its real size, the system uses a default, so the percentage is understated and the warning is hard to trigger. The easier fix is to fill the real window + threshold directly in this plugin's "Per-model window & threshold".

**Does it conflict with "auto-compaction"?**
No; they are two different approaches. Compaction squeezes the old conversation into a summary and continues; this plugin simply opens a new conversation. Use one, or both.

**Is it expensive?**
"Warn only" and "plugin-template brief" make no extra model calls; they only write a few small files. An extra model call happens only if you switch "who writes the brief" to "model-authored".

---

### Which group the new window lands in

The new window is **in the same group as your original window** (groups are "workspaces"). The plugin first finds which workspace the current window belongs to and joins the new window to it; only when that lookup fails does it create a standalone one.

If you later reorganise files and want to update the installed plugin: run `pnpm run build` in the workspace, then
`powershell -ExecutionPolicy Bypass -File scripts\install-copy.ps1`, then restart DSH. The plugin directory holds an independent copy, so moving files around in the workspace does not affect it.

### Learn more

- Full feature list and installation details: [README.md](README.md)
- How it is implemented and which pitfalls were hit: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Who it borrowed from (the four upstream projects): see "致谢与来源" in [README.md](README.md)
- What changed: [CHANGELOG.md](CHANGELOG.md)
