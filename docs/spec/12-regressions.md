## 十二、已知待修问题（v1.6.2 全量审计留档）

> C/D 基础模块 + E1–E4 全链路横向审计（并行 agent + 人工复核），按危害留档，避免被「重新发现」。
> 判据：**会不会静默失效 / 静默丢数据**；显示错、慢一点、丑一点不进表。
> 已修三条见 [10-settings-history-dsh.md](10-settings-history-dsh.md) §10.3 第 ⑩ 段；B9 在 §10.3 第 ⑪ 段顺手修掉，记入本文 §12.1。

### 12.1 已修（本轮）

| # | 位置 | 问题 | 修法 |
|---|---|---|---|
| A1 | [store.js](file:///e:/Github/Balance-Whale-Widget/public/preload/lib/store.js) `patchConfig` | `writeConfig` **返回 `false` 而不抛错**，`patchConfig` 又忽略返回值 → 各调用点拿不到「没落盘」，用户看到「保存成功」、重启变回去 | 改 `if (!writeConfig(cfg)) throw new Error(...)`，交各调用点 `try/catch`，**连带覆盖其余漏判返回值的点** |
| A2 | [ipc.js](file:///e:/Github/Balance-Whale-Widget/public/preload/lib/ipc.js) `whale:config` | 改抛错后 `patchConfig` 在 `try/catch` **之外**，异常成未捕获事件，挂件侧无反馈 | 单独 `try { cfg = patchConfig(patch) } catch` + `logErr`；副作用（窗口尺寸 / 置顶 / 清计时 / 广播）不能因写失败跳过，只包这一句 |
| A3 | [util.js](file:///e:/Github/Balance-Whale-Widget/public/preload/lib/util.js) `homeDir` / `expandHome` | `os.homedir()` 裸调，Windows 上 `USERPROFILE` / `HOMEDRIVE`+`HOMEPATH` 全被清掉时**抛错**，被候选探测 `catch (_) {}` 吞成「目录不存在」、返回 `''` → **快照空、备份报「没有可备份的文件」、诊断假通过、零日志** | 两处单独 `try { home = os.homedir() } catch { home = '' }`，取不到就**跳过该候选项**（或退回不展开）；`util.js` 有依赖硬禁令（D21）不能 require `log`，只能靠兜底 + 单测 |
| B9 | [dsh-isolate.js](file:///e:/Github/Balance-Whale-Widget/public/preload/lib/dsh-isolate.js) `selectBatch` | `MAX_BATCH` 截断在**排除勾选之后**且按输入顺序 → 用户勾选的项可能被静默丢掉 | 返回 `{ items, dropped }`：**先保勾选、再截断**，丢掉条数如实报 `dropped`，界面据此显示分批警告。见 [10-settings-history-dsh.md](10-settings-history-dsh.md) §10.3 第 ⑪ 段 |
| ~~B15~~ | [store.js](file:///e:/Github/Balance-Whale-Widget/public/preload/lib/store.js) `normHm` / `readConfig` / `writeConfig` / `patchConfig` | ~~`timerAt` 四处只判格式 `/^\d{1,2}:\d{2}$/`、**不判范围** → `'99:99'` / `'25:00'` 能写进 `whale:config`；塞进 `<input type="time">` 会让 `.value` 清成空串 → 定时提醒静默失效~~ **已修**：复用 `normHm`（校验 h 0–23 / m 0–59 并补零），三处调用点全替换；`test/config.test.mjs` 钉住（`'99:99'` 必须回落默认值） |

### 12.2 中等（已修，按危害排序）

| # | 位置 | 问题 |
|---|---|---|
| ~~B1~~ | [dsh-backup.js](file:///e:/Github/Balance-Whale-Widget/public/preload/lib/dsh-backup.js) `createSnapshot` | ~~撞名只试**一次**毫秒后缀 + `mkdirSync({recursive:true})` → 同毫秒两次建快照会**静默覆盖**前一份（`recursive:true` 让「目录已存在」不报错）~~ **已修**：改 `mkdirSync(dir)`（**不带 `recursive`**），`EEXIST` 换下一候选名重试（`-1`…`-9`），试满仍撞则报错 |
| ~~B2~~ | [dsh-backup.js](file:///e:/Github/Balance-Whale-Widget/public/preload/lib/dsh-backup.js) `listSnapshots` | ~~硬编码 `intact: true`~~ **已修**：`intact` 改为与 `restoreSnapshot` **同口径**的真 sha256 校验（只读不写），新增 `damaged` 供界面 `v-if`；建快照时就缺失的文件（`ok:false`）不参与校验。设置页据此把「还原」置灰标「已损坏」。见 [10-settings-history.md](10-settings-history.md) §10.3 第 ⑤ 段 |
| ~~B3~~ | [dsh-backup.js](file:///e:/Github/Balance-Whale-Widget/public/preload/lib/dsh-backup.js) `createSnapshot` | ~~失败路径残留半成品快照目录（已 `mkdir` 但文件没写完），下次 `listSnapshots` 会当正常快照列出~~ **已修**：写 manifest 与各受管文件任一步失败即 `rmSync(dir, {recursive:true, force:true})` 回收整份目录 |
| ~~B4~~ | [dsh-patch.js](file:///e:/Github/Balance-Whale-Widget/public/preload/lib/dsh-patch.js) `parsePatch` | ~~`eol: src.includes('\r\n')` 恒为 `false`：开头已把 `\r\n` 归一化成 `\n`；CRLF 用例能过只因落笔另有判断~~ **已修**：改从归一化**之前**的 `raw` 检测；`test/dsh-patch.test.mjs`「parsePatch：eol 按原始文本报告」钉住 |
| ~~B5~~ | [dsh-patch.js](file:///e:/Github/Balance-Whale-Widget/public/preload/lib/dsh-patch.js) `validId` | ~~不挡 `{` `}` `,` `[` `]` 等 YAML 指示符；`appendItem` 拼行后用**同一套宽松 `ITEM_RE`** 回读 → V2「写完必须回读校验」在非法 id 下形同虚设~~ **已修**：`validId` 增加 `/[{}[\],]/` 拦截；`test/dsh-patch.test.mjs`「YAML 流式指示符一律拒绝」钉住 |
| ~~B6~~ | [dsh-patch.js](file:///e:/Github/Balance-Whale-Widget/public/preload/lib/dsh-patch.js) `applyToggle` | ~~`if (hit.disabled === want && hit.disabledLineIndex >= 0)` 缺「值已达标即 noop」语义：已禁用、要设的也是禁用、但没有 `disabled:` 行时会白插一行~~ **已修**：去掉 `&& hit.disabledLineIndex >= 0`，值已达标返回 `noop`，不产生无作用 diff |
| ~~B7~~ | [dsh-dump.js](file:///e:/Github/Balance-Whale-Widget/public/preload/lib/dsh-dump.js) | ~~stdout 与 stderr 混进**同一个 `out`**，成功路径 `finish(null, out)` → dsh 的 stderr 警告被当正常输出整包缓存 60s~~ **已修**：`run(args, cb, timeoutMs)` 回调改 `(err, stdout, stderr)`，两路分开累积（stderr 单独限量），成功只回传 stdout；`collectDshDump` 用两者合并抽 `parseDshWarnings`（`patch: entry X not found` 走 stderr、在正文之前） |
| ~~B8~~ | [dsh-dump.js](file:///e:/Github/Balance-Whale-Widget/public/preload/lib/dsh-dump.js) | ~~子进程 `catch` 只 `logErr`，既不 `finish(...)` 也不 `child.kill()` → 违反「永不 cb 两次」、监听器泄漏、真实错误被超时器归因成「超时」~~ **已修**：`onErr` 补 `child.kill()` + `finish(new Error('dump 进程错误：…'), '')`；`finish` 的 `done` 闸门挡掉晚到的 close / error / 超时 |
| ~~B10~~ | [dsh-isolate.js](file:///e:/Github/Balance-Whale-Widget/public/preload/lib/dsh-isolate.js) | ~~`line: Number.isFinite(it.line) ? it.line : 0` 不兼容 `it.lineIndex` → 上游给 `lineIndex` 时行号静默变 `0`（界面显示「没有行号」）~~ **已修**：新增 `lineNoOf(it)`，`lineIndex`（0 基）**+1** 透传、`line`（1 基）原样，两者都缺才回 0；`test/dsh-isolate.test.mjs` 钉住 |
| ~~B11~~ | [backup.js](file:///e:/Github/Balance-Whale-Widget/public/preload/lib/backup.js) | ~~只 `const { log } = require('./log')`，**整个文件没有 `logErr`**；config / timer 分支的 `writeConfig` / `writeTimer` 返回 `false` 时不抛 → 无条件 `applied.push(...)`，把**写失败上报成成功**~~ **已修**：补 `logErr`；`applyBackup` 新增 `fail(label, detail)`（`logErr` + `errors.push`），config / ledger / window / timer 四个吞错点全改判返回值：失败进 `errors` 而非 `applied`，`ok` 随之 `false`；`test/backup.test.mjs`「写失败进 errors 而不是 applied」钉住 |
| ~~B12~~ | [backup.js](file:///e:/Github/Balance-Whale-Widget/public/preload/lib/backup.js) `decryptSecrets` | ~~失败路径无留痕，而该文件测试头写明这是**「全项目唯一会丢数据的路径」**~~ **已修**：凭据恢复的 `catch` 补 `logErr('[whale][backup] 恢复凭据失败（密码错或备份损坏）', errMsg(err))`；`test/backup.test.mjs`「凭据密码错时报错且不写任何东西」钉住 |
| ~~B13~~ | [check-shared.mjs](file:///e:/Github/Balance-Whale-Widget/scripts/check-shared.mjs) | ~~`catch` 把异常 `String()` 混进 `vals`，再用 `new Set(vals).size === 1` 判一致 → **两侧都读失败时字符串相同被判一致，门禁被绕过**~~ **已修**：读失败单独计数并直接 `bad++`，全部读取成功后才比一致性；改 `.dshwv-amount` 字号即被 `BUBBLE_FONT` 拦下，marker 写错报「读取失败」 |
| ~~B14~~ | [check-shared.mjs](file:///e:/Github/Balance-Whale-Widget/scripts/check-shared.mjs) | ~~覆盖缺口：`TIMER_NOTE_MAX`、`QUOTE_GROUP_MAX`、`SCALE_STEPS` 都没进 `CHECKS`~~ **已补两项**：`TIMER_NOTE_MAX`（三处：`constants.js` / `floating-page.js` / `App.vue`）、`QUOTE_GROUP_MAX`（两处：`store.js` / `App.vue`）已进 `CHECKS`；`SCALE_STEPS`（**一处**：`App.vue`，挂件页已改连续滑块）**无可比对象，不校验**。另加三项气泡校验：`BUBBLE_FONT`（挂件页 vs `floating.css`）、`THEMES.default`、`--dshw-u` |

### 12.3 低优（已修）

| # | 位置 | 问题 |
|---|---|---|
| ~~C1~~ | [assets.js](file:///e:/Github/Balance-Whale-Widget/public/preload/lib/assets.js) | ~~三处选择框 / 读文件的 `catch` 无 `logErr`~~ **已修**：导出保存框 / 导入文件框 / `readFileSync` 三处 `catch` 补 `logErr`（含失败路径） |
| ~~C2~~ | [settings.js](file:///e:/Github/Balance-Whale-Widget/public/preload/lib/settings.js) `dshPickNodeDir` | ~~全文件唯一漏 `logErr` 的选择框 `catch`~~ **已修**：补 `logErr`，全文件选择框 `catch` 一致 |
| ~~C3~~ | [hosts.js](file:///e:/Github/Balance-Whale-Widget/public/preload/lib/hosts.js) | ~~`patchConfig({ ghAccelRefreshedAt: Date.now() })` 不判返回值~~ **已修**：单独 `try/catch` 包住：A1 让写失败抛错，不接会把整个 `refreshIps` 掀掉；现写失败只 `logErr`，已探到的 IP 照样返回 |
| ~~C4~~ | [release.mjs](file:///e:/Github/Balance-Whale-Widget/scripts/release.mjs) | ~~`--dry-run` 仍**真实改写**三处版本号~~ **已修**：先把四处版本文件（`package.json` / `package-lock.json` / `public/plugin.json` / `constants.js`）原文存 `versionBackup`，`finally` 无条件还原 |
| ~~C5~~ | [release.mjs](file:///e:/Github/Balance-Whale-Widget/scripts/release.mjs) | ~~tag 回读校验只比 `body.split('\n')[0]`~~ **已修**：改比**整段正文**（`cat-file` 取头部空行之后内容，行尾归一后全等比较）（脚本自述的事故正是「第一行在、多行正文丢」） |
| ~~C6~~ | [verify-release-zip.mjs](file:///e:/Github/Balance-Whale-Widget/scripts/verify-release-zip.mjs) | ~~`require(plugin.json)` 无 `try/catch`；`-p '*.zip'` 通配未校验文件名~~ **已修**：先 `existsSync` 判在、再 `try/catch` 判可解析，缺文件报可操作诊断而非 `Cannot find module`；下载后 `readdirSync` 列所有 zip，除期望名外还有别的 zip 即失败（防遗留包被静默放过） |
| ~~C7~~ | [store.test.mjs](file:///e:/Github/Balance-Whale-Widget/test/store.test.mjs) | ~~把 `QUOTE_GROUP_MAX` 写成魔法数字 `12`~~ **已修**：`QUOTE_GROUP_MAX` 由 `store.js` 导出（注释标注「仅导出给单测」），测试改用它；补「恰好等于上限不截断」边界（off-by-one 会让配满的一组凭空消失） |
