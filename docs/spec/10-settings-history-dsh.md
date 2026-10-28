**第 ⑥ 段（阶段三 E1：dsh 配置备份 / 可撤销）**

`public/preload/lib/dsh-backup.js`（**纯模块，无 IPC、无 UI**，IPC 与卡片在 E2）。E2–E4 都先调它建快照。

- **四个能力**：`createSnapshot({profile, reason})` / `listSnapshots()` / `restoreSnapshot({dirName, dryRun})` / `pruneSnapshots({keep})`；另 `removeSnapshot(dirName)`、`targetFiles(profile)`、`backupRoot()`。
- **落盘位置**：`$DSH_HOME/whale-dsh-backup/<YYYYMMDD-HHMMSS>/`，每份一个 `manifest.json`（`{kind:'whale-dsh-backup', schema:1, at, profile, reason, note, files:[{rel, name, sha256, bytes, ok, reason}]}`）+ **扁平文件名**（`profiles/web/cordis.patch.yml` → `profiles__web__cordis.patch.yml`）。**放 `$DSH_HOME` 而非挂件 `userData/`**：用户清理 dsh 配置时一并删。
- **`note` 记「对哪个对象做的」，形如 `安装 dshmarket@1.65.1`**。与 `reason` 正交：`reason` 是哪类动作（`manual` / `before-disable` / `before-enable` / `before-isolate` / `before-market-install` / `before-market-update` / `before-market-uninstall` / `before-market-disable`），`note` 是哪个包哪一版；`snapNote(action, name, version)` 拼成「动作 + 包名 + @版本」。
  - **包名优先 npm 名、退化到 spec**：`github:` / tarball 的 spec 是长 URL，只有 npm 名能认包；都没有才用 spec（空 `note` 不渲染）。**版本拿不到只写包名**。**上限 120 字符**。
  - **`note` 只进 `manifest.json` 的字符串字段，从不当目录名**：`@` / `:` / `/` / `#` **必须逐字往返、不清洗**，有单测钉住。
  - **`note` 与 `name` 是两回事**：`name` 是**用户**起的名（进 `meta.json`、受 knownGood 清理规则保护），`note` 是**系统**记的事实，**只进 `manifest.json`**。
  - **⚠️ 界面呈现：`note` 独立一行、前置「记录」标签**：早先混在「已知良好」「3/3 个文件」里像状态标签，改为 `.bak-note-row` 独立一行（前置 `.bak-note-tag`「记录」，区别于 `.bak-name`）。`.bak-note` **去掉 `text-overflow: ellipsis`**：窄区块会截掉版本号与包名，用 `overflow-wrap: anywhere` + `word-break: break-word` 折行。
  - **读侧容缺**：老快照的 manifest 无此键，`listSnapshots` 必须给空串而非丢条目。
- **界面侧 reason 必须穷举映射**：`src/App.vue` 的 `DSH_BACKUP_REASONS` 是「宿主 reason → 中文」唯一映射表；漏配显示英文，兜底 `未知来源（原值）`。**新增 reason 两处都加**（宿主 `createSnapshot` 调用点 + 本表）。
- **白名单而非黑名单（E4 同款硬约束）**：只备 `profiles/<p>/cordis.patch.yml`、`profiles/<p>/package.json`、`settings.yaml` 三个（同 ⑤ 段 V-gate 口径）。**快照绝不含 `.credentials.yaml`**：黑名单会随 dsh 新增敏感文件失守。
- **不备整个 `profiles/<p>/`**：`node_modules` 上万文件，留 N 份迅速吃盘；E2/E3 只改 `cordis.patch.yml`。
- **三条与 V1–V4 对应的实现决定**：
  - **还原 = 整文件覆盖**（V4 热重载单向：删行不恢复，只有文件回到改动前完整内容才有效），**不做行级撤销**。
  - **还原前逐文件校验 sha256**（V2：`patch: entry "X" not found` 只打 stderr、退出码 0），不符报「快照已损坏」；**列表页同一套校验**（`listSnapshots` 的 `intact` / `damaged`）。
  - **还原失败必须逆序回滚**（夹缝态更糟）：`restoreSnapshot` 每文件落笔前先读成 prev，任一写失败就**逆序**还原已写的（`prev === null` = 原本不存在，回滚时删掉）。`package.json` 与 `cordis.patch.yml` 必须**同时**回到同一时刻：只回一半不报错、行为怪异。失败态是「目录回到动手前」（`written: []` + `rolledBack: [...]`），**不存在「部分成功」**；回滚自身再失败只留痕。
  - **白名单文件缺失是预期分支，记 `ok:false`**。建快照**不因缺文件失败**：否则 E2「写入前先备份」会在最需要时挡路；还原时**跳过**缺失项而非创建空文件。
- **安全与健壮性**：`dirName` 走 `^[0-9]{8}-[0-9]{6}(-\d+)?$` 白名单校验（manifest 可手改，防目录穿越）；`listSnapshots` 对「非本插件目录」「manifest 读不出」**跳过而非整表失败**；同秒连建加毫秒后缀；`MAX_SNAPSHOTS = 20` 防无限增长。
- **不新增存储键**：快照索引**直接扫磁盘**（`listSnapshots` 读各 `manifest.json`），`constants.js` 的 `K` 无需新增。
- **不复用 `lib/backup.js`**：它备**挂件自身数据**（`apiKey` / `platformToken` / 账本 / 窗口位置），面向手选路径；这里备 `~/.dsh` 下固定配置文件 + 多份轮转，受众与影响面不同。
- **单测** `test/dsh-backup.test.mjs`：`$DSH_HOME` 指向临时目录 + 挂 `utools` 桩。钉四个**静默失效型**约定（白名单不含 `.credentials.yaml`、篡改后还原必须失败、还原后逐字等于建快照、缺文件还原不得建空文件）；另含目录穿越、列表容错、prune 保留最新、同秒不撞名、逆序回滚、外部篡改、`note` 往返（含 `@ : / #`）。

**第 ⑦ 段（阶段三 E2：单个插件禁用 / 启用）**

`public/preload/lib/dsh-patch.js`（**纯模块，只认格式不认业务**）+ `settings.js` 宿主层 + 设置页「dsh 插件开关」卡片 + `test/dsh-patch.test.mjs`；写入前复用 E1 的 `dsh-backup.js`。

- **行级读写，不 parse / 不重排 YAML**（V3：只在条目下加一行 `disabled: true`）：`parsePatch(text)` 按 `- id: X` 建条目栈，`disabled:` 归属**上方最近的 `- id:`**，记 `lineIndex` / `disabledLineIndex` / `disabledRaw` / 缩进 / 有无 `config:` 子块；`applyToggle(text, id, disabled)` 只改或插**一行**，返回 `action: 'append' | 'update' | 'insert' | 'noop'`。**不引入 YAML 解析器**：序列化会重排缩进 / 注释 / `!!js` 标签，写坏**用户配置**；「只动一行」diff 最小、可手还原
  - 已有 `disabled:` 行 → **沿用原缩进**改值；有条目无该行 → 插在 `lineIndex + 1`；无条目 → 末尾追加（文件不以 `\n` 结尾时**先补换行**）。
  - **CRLF 保持**：按原文件 `eol` 回写，不整体改 LF。
  - `disabledValue` **保守**：只有 `false` / `no` / `0` / `null` / `~` 算「未禁用」，其余（含 `!!js '...'`）一律**已禁用**。
  - `validId` 拒换行 / Tab / `:\s` / `#` / 以 `-` 开头 / 超 200 字符，放行 `@` / `/` / `.`。
- **写完回读校验**（V2「写坏了 dsh 也不报错」）：`toggleDshPatchItem` 写盘后重新 `readTextSafe` + `parsePatch`，`disabled` 不符预期即返回「写入后校验未通过」。
- **`needsRestart: !disabled`**（V4 **单向**热重载）：加 `disabled` 即时生效、**删行不恢复**，「启用」须提示重启 dsh。
- **写前强制建快照**（复用 E1）：`dshPatchToggle` 先 `dryRun` 探 `changed`，真要改才 `createSnapshot({profile, reason:'manual'})`；**快照失败即中止写入**（`backedUp:false`），返回体带 `snapshot` 目录名
- **`dshBackup*` 方法**（`dshBackupList` / `dshBackupRestore` / `dshBackupRemove` / `dshBackupCreate`）把 E1 接到设置页：还原是**两步确认**（整文件覆盖，影响大于单条开关）
- **⚠️ 展开快照必须顺手拉一次列表**：`dshBackups` 初值 `null`、唯一自动刷新在 `dshPatchRefresh` 的 `finally`，直接展开读到 `null` → 显示「展开快照（0 份）」+「还没有快照。」，磁盘上完好。
  - 修法：新增 `dshBackupToggleList()`：展开时**必定**调一次 `dshBackupRefresh()`；进卡（`toggleDevCard('dshIsolate')`）时也顺带刷一次。
  - **⚠️ 第一版修法的坑**：守卫 `if (next && !dshBackups.value)` 被「立即备份」的 `finally` 写脏，标题停在 0 份、列表却是 1 份。**根因：用缓存存在性代表数据鲜度**；改无条件补读（`listSnapshots` 只是本地 `readdir`）。
  - 与宿主无关：`listDshBackups()` → `dshBackup.listSnapshots()` 链路正常，**纯前端没去要**；排查先看磁盘（`Get-ChildItem $env:USERPROFILE\.dsh\whale-dsh-backup`）再看 manifest。
- **卡片文案对 V1 明示**：带 client 入口的插件（加载入口在 `profiles/<p>/package.json` 的 `dependencies`）**禁用组装树条目无效**，卡片写明「这类插件可能禁不掉」
- **不新增 IPC 通道**（D14 合规）：设置页直走 `window.services.*`，`services.d.ts` 补类型，`lib/ipc.js` 的 `whale:dsh` 通道**未改动**。
- **单测** `test/dsh-patch.test.mjs`：夹具为本机 `cordis.patch.yml` 形态（注释、空行、`config:` 子块、`!!js '...'`、多条目含 disabled）。钉**「只动一行」**（行数不变 + 唯一 diff 行）、`disabled:` 归属、末尾追加与补换行、非法 id 全拒、CRLF 保持、幂等（`noop` 且逐字不变）。

**第 ⑧ 段（阶段三 E3：我的一键隔离）**

`public/preload/lib/dsh-isolate.js`（**纯模块，只认格式不认业务**，不建快照、不调子进程，零桩可测）+ `dsh-patch.js#applyBatchDisable` + `settings.js` 宿主层 + 设置页「dsh 插件开关」卡片（**E2 + E3 合并单卡**，见第 ⑫ 段）+ `test/dsh-isolate.test.mjs`。

- **E3 是「批量」的 E2，红线同 §5.2**：**只操作用户勾选的候选项**，不做「安全模式（全禁）」。
- **`applyBatchDisable(text, ids)` 用「两趟法」（核心坑）**：逐个 id 顺序 `insert` 会撑大 `lines`，再按**原始行号**（`hit.disabledLineIndex`）索引就指错。**第一趟只判断、产出带 `at`（原始行号）的计划；第二趟按 `at` 从大到小落笔**。
  - 不能靠「记插入点反向补偿行号」：`plans[k].line` 已被顺延，与 `hit.lineIndex` 不同坐标系。
  - `plans.line` 一律报**条目头**（`- id:`）行（1 基），`insert` 同；`at` / `indent` 是内部临时字段，落笔后 `delete`，不泄漏到返回值。
  - **任一 id 非法 → 整批拒绝**（`ok:false`，一字不写）：写一半再失败更难收拾。
- **候选清单 = patch 条目 ∪ 组装树插件 id**（`candidatesOf`）：`normalizeCandidates` **同时认 `patchItems` 与 `patchIds`**（只认一个会让部分 id 静默消失），`idListOf(v)` 归一化（容忍字符串 / `null` / 非数组）。顺序恒为 **patch 先、plugin 后**，**不二次排序**。
- **`selectBatch` 与 `MAX_BATCH = 100`**：缺省全选（带 `ids` 则只选这些），**冻结 `disabled` / `inPatch` 由候选层给定**，超上限截断并在 `truncated` 标记。
- **宿主层两条**：`listDshIsolateCandidates(opts)` 是 **Promise**（spawn `dsh --profile <p> --dump-config`），带 **20s 兜底闸门**；**组装树读不到降级**：填 `treeError`、`items` 只含 patch 条目，**不算整体失败**（D26）。`isolateDshPlugins(opts)` 同步：`ids` 空 / 超 `MAX_BATCH` 直接拒；`dryRun` 只算不写、返回 `plans` + `changedCount`；写入后**回读逐条校验**，不符返回 `mismatch`。
- **`dshIsolateApply` 两步确认**（复用 E1 快照）：先 `dryRun` 探 `changed`，**真要改才** `createSnapshot({profile, reason:'before-isolate'})`；**快照失败即中止写入**。卡片先摆「会动哪几行」（`id` + `dshIsolateActionText(action)` + `第 N 行` / `追加到末尾`），点「确认隔离（先建快照）」才落笔；勾选变化即清空旧计划（`dshIsolatePlan = null`）。
- **卡片文案对 V1 明示**（同 E2）：带 client 入口的插件禁用组装树条目**无效**，E3 一次禁多条**更易撞上**。
- **`needsRestart: false`**：加 `disabled` 属 V4 **即时生效**那一半。
- **不新增 IPC 通道**（D14 合规）：`services.d.ts` 补四个类型（`DshIsolateCandidate` / `DshIsolateCandidatesResult` / `DshIsolatePlan` / `DshIsolateApplyResult`），`whale:dsh` 通道**未改动**。
- **单测** `test/dsh-isolate.test.mjs`：①只动该动的行 ②新增条目 ③**行号不错位**（整份文本逐字相等）④非法 id / CRLF / 幂等 / 注释保留 ⑤候选清单（`candidatesOf` 并集与顺序）⑥勾选与上限（`selectBatch`）。钉三类**静默失效**：**行号错位**、**一次改完再落盘**、**候选必须真实存在**（`patchItems` 与 `patchIds` 两种写法都要进候选）。
