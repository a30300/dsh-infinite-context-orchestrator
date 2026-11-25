# 发布前检查清单

面向"把本插件上传共享"的场景。按顺序过一遍即可；标 **[你来做]** 的是只有作者能提供的信息。

## 1. package.json 里需要你补的字段

```json
{
  "author": "a30300 (https://github.com/a30300)",
  "repository": { "type": "git", "url": "git+https://github.com/a30300/dsh-infinite-context-orchestrator.git" },
  "homepage": "https://github.com/a30300/dsh-infinite-context-orchestrator#readme",
  "bugs": { "url": "https://github.com/a30300/dsh-infinite-context-orchestrator/issues" }
}
```

- [x] `author` / `repository` / `homepage` / `bugs` 已填写（a30300）。
- [ ] 确认 `version`（当前 `0.1.0`）与 `CHANGELOG.md` 顶部条目一致。
- [ ] 确认 `license` 为 `MIT`，且仓库里存在 [LICENSE](LICENSE)。

## 2. 包内容与依赖

- [ ] **零运行时依赖**：`dependencies` 必须为空/不存在（`lib/index.js` 只 import `node:*`，schemastery 已在构建时内联）。
- [ ] `files` 覆盖：`lib/index.js`、`lib/types/**`、`client.js`、`cordis.patch.yml`、`README.md`、
      `USERGUIDE.md`、`LICENSE`、`CREDITS.md`、`CHANGELOG.md`、`docs/`、`scripts/repair-sessions.mjs`。
- [ ] **`lib/` 产物入库**（DSH 直接从包目录加载，不走构建；社区规则要求产物在仓库里）。
- [ ] 仓库里不要带 `node_modules/`、本机 profile 备份、以及任何机器相关路径（见 `.gitignore`）。
- [ ] 用 `npm pack --dry-run` 检查最终会发出去的文件清单（见第 5 步）。

## 3. DSH 清单（社区规则）

- [ ] `package.json` 里有 `dsh.bundle.patch` 指向 `cordis.patch.yml`。
- [ ] `cordis.patch.yml` 的 `name` 与包名一致（`dsh-infinite-context-orchestrator`），`id` 为部署本地值。
- [ ] 有客户端半件时：`dsh.client.platform = 'web'`，且 `exports['./client']` 指向 `client.js`。
- [ ] `keywords` 含 `dsh-plugin`。
- [ ] `dsh.engines.dsh` 声明最低 DSH 版本（当前 `>=0.2.1-rc.2`）。

## 4. 门禁

- [ ] `pnpm install --ignore-scripts`
- [ ] `pnpm run typecheck` → 0 错误
- [ ] `pnpm run build` → 产出 `lib/index.js` + `lib/types/*.d.ts`
- [ ] `pnpm run smoke` → Host 全绿（当前 60 项）
- [ ] `pnpm run smoke:client` → Client 全绿（当前 9 项）
- [ ] 有 DSH 环境时做一次真机冒烟：设置页能读写、`infinite_context_status` 显示「设置页接口：已挂载」。

## 5. 打包自检

```powershell
cd "<插件所在文件夹>"
npm pack --dry-run
```

期望看到：`lib/index.js`、`lib/types/*.d.ts`、`client.js`、`cordis.patch.yml`、`README.md`、
`USERGUIDE.md`、`LICENSE`、`CREDITS.md`、`CHANGELOG.md`、`docs/*`、`scripts/repair-sessions.mjs`。
**不应**出现 `node_modules/`、`src/`、测试脚本 `scripts/smoke*.mjs`
（源码与测试脚本留在 git 仓库即可，不必进 npm 包 —— 如果要一起发，把它们加进 `files`）。

## 6. 发布

- [ ] **[你来做]** 建公开仓库（建议加 `dsh-plugin` topic，便于社区发现）。
- [ ] `npm publish --access public`（或先 `npm pack` 上传 tarball）。
- [ ] 在 README 顶部补安装命令与截图（设置页那张）。
- [ ] 若提交到 DSH 插件社区：按社区模板填 `dsh.bundle` / 描述 / 图标等信息。

## 7. 致谢随包走

- [ ] `CREDITS.md` 必须随仓库/包一起发布：里面写明四个上游插件的作者、仓库、许可与**具体借用点**
      （dsh-context-relay / dsh-task-checkpoint-guard / dsh-project-progress / dsh-context-window）。
- [ ] 若上游版本升级后你更新了借鉴的契约，同步改 `CREDITS.md` 的"版本（开发时）"列。

## 8. 一个必须写进说明的坑

本机实测：`dsh plugin remove <本插件>` 会把 profile 的 `cordis.patch.yml` 截回旧备份、并把
`dsh.profile.bundles` 削成 `base + web-app`，**连不相关的条目一起丢**，运行中的宿主会卸载这些插件并可能崩溃。
README 已就此写了警告；发布时保留这条，能替用户省一次事故。
## 9. 推送排障（Windows / 受限环境）

- `schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS`：schannel 拿不到证书存储，
  改用 OpenSSL 后端即可：`git config http.sslBackend openssl`（仓库内设置，只影响本仓库）。
- `failed to execute prompt script` / `could not read Username`：凭据助手在受限环境里起不来，
  在普通终端（非沙箱）里执行一次 `git push`，让 Git Credential Manager 完成一次授权即可。