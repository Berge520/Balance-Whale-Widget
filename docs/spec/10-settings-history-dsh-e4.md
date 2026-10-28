**第 ⑨ 段（阶段三 E4 实现：known-good 标记 / 命名 / 可配保留份数）**

`lib/dsh-backup.js`（扩展 E1）+ `store.js`（新增一个配置项）+ `settings.js` 宿主层 + 设置页快照列表 + `test/dsh-backup.test.mjs`。E4 不改写入路径，只补「备份怎么留、怎么认」：**E1 建的快照本身就是回滚单位**，E4 只让用户能给某份钉钉子。

- **`meta.json` 与 `manifest.json` 分开存**（E4 唯一的结构性决定）：`manifest.json` 是**快照内容指纹**（`files[].sha256` / `bytes`），建快照时写定、之后只读；`meta.json`（`{name, knownGood}`）是**用户对这份快照的意图**，随时可改。合并则「改名」要重写 manifest，而还原的 sha256 自校验读的正是 manifest：**改标记与改内容就有同一条写路径**；分开后 `setMeta` **从不碰快照内容**（单测钉住：改标记后还原仍成功）。
- **`setMeta` 是部分更新语义**：`name` 为 `undefined` 时保持原值，只有显式传 `''` 才清空；「标 known-good」只传 `knownGood`、「改名」只传 `name`，互不覆盖（否则标记会抹掉用户起的名字）。
- **两项都空则删掉 `meta.json`**，不留 `{"name":"","knownGood":false}` 空壳（免得误以为「有 meta = 有标记」）。
- **名字规范化**：`normName` 折叠空白（`\s+` → 单空格）+ `trim` + 截断到 `NAME_MAX = 40` 字符。**换行必须折叠掉**（名字要渲染进设置页 `title` 与文本节点，换行会破坏卡片布局）。
- **`isPinned` = known-good ∪ 「有名字且 `reason` 不是 `before-*`」**：
  - known-good 是显式钉住，不受影响。
  - **手动命名的快照受保护**：只可能是用户主动 `createSnapshot({name})` 建的，已表达「这份要留着」。
  - **`before-*` 改名不免死**（`reason` 形如 `before-isolate` / `before-toggle`）：这类是**写前自动备份**，起名多半只是「留个备注」，不排除则「改名免死」成了**悄悄停掉轮转的路**。
- **`pruneSnapshots` 的 `keep` 只统计未固定快照**，固定的**不占配额**。E4 修掉的真 bug：最初把固定快照推进 `kept` 再用 `kept.length < keep` 判断，让「被保护的」吃掉「要保留的」名额（`keep=2` 且其中一份 known-good 时实际只剩 1 份普通快照），改为独立计数器（`let keptNormal = 0`，固定项 `continue`）：**「保留 N 份」= N 份普通快照 + 任意多份固定快照**。
  - 界面文案据此明写「『已知良好』与手动命名的备份不受这个数限制」，避免用户按 N 算磁盘占用时对不上。
  - `protectPinned: false` 保留为内部开关（退回**纯列表顺序计数、与标记无关**）；单测里这条期望删的是列表第二项而非最旧项（`listSnapshots` 把 known-good 排最前，钉住「退回语义不看标记」）。
- **`retentionKeep()` 读配置并 clamp 到 `KEEP_MIN = 1` – `KEEP_MAX = 200`**，读不到回落 `MAX_SNAPSHOTS = 20`（E1 旧常量降为**默认值**）。`createSnapshot` 结尾自动调一次 `pruneSnapshots`，**失败只 `logErr`、不影响建快照的成功返回**（D26：降级不判死）。
- **`store.js` 新增 `config.dshBackupKeep`**（`DSB_KEEP_DEFAULT = 20` / `MIN = 1` / `MAX = 200`），`readConfig` / `writeConfig` / `patchConfig` 三处都 clamp 归一化。**这是唯一新增的存储键**：快照索引仍靠扫磁盘（承接第 ⑥ 段「不新增存储键」），marker 与名字落在快照目录的 `meta.json` 里。
- **`listSnapshots` 增 `name` / `knownGood` / `fromDisk`，排序「known-good 优先，其余按时间倒序」**（宿主层读盘时定，界面不再二次排）。
- **`safeDirName` 复用 E1 的目录名白名单**（`^[0-9]{8}-[0-9]{6}(-\d+)?$`），`setMeta` / `restoreSnapshot` / `removeSnapshot` 全部先过一遍：`meta.json` 的名字用户可手改，**目录名不是**，防「改 meta 被带着穿越目录」。
- **复查修掉的真问题：`listSnapshots` 曾无条件采信 manifest 的 `m.dirName`**。`dirName` 传到 `pruneSnapshots` 被 `path.join` 拼路径再 `rmSync`，而 manifest 是**用户可手改的普通文件**：「改一个字段」等于「删任意目录」——填 `../evil` 越过快照根；**更阴的是填一个真实存在的同级目录名**，清理会「成功」删掉那份**完好快照**，真正目标原封不动（`removed` 还报一个看似正常的时间戳名）。改为**以磁盘目录名为准**（`readdir` 的名字才是事实），并把「不信任 manifest」钉进单测。
  - **纯用磁盘名会丢掉一个真实场景**：快照目录被手工改名后，manifest 里的旧名字仍指向一个确实存在的目录，那份快照再也删不掉（`removeSnapshot(旧名)` 命中另一个目录）。故保留**有门槛的** fallback：`resolveDirName` 仅在 manifest 名字满足「纯目录名 + 该目录在快照根下存在 + 里面有 manifest」三条时才采信，排除「穿越」与「误删邻居」。
  - `pruneSnapshots` 另加一道 `safeDirName` **纵深防御**（本函数是唯一拿用户可改数据去 `rmSync` 的地方）。
- **设置页快照列表**（`src/App.vue`）：每份快照一行 `.bak-line`（时间 / `已知良好` 标签 / 名字 / 原因 / `present/total` 文件数）+ `.bak-actions`（还原 / 标记 / 改名 / 删除）；改名是**行内表单**（`.bak-rename`），删除与还原**两步确认**（`.bak-del.bak-confirm`）；上方是保留份数输入行（`.bak-keep`）+「立即清理」。
- **`dshBackupSetKeep(n)` 只写配置、不删文件**，「立即清理」是 `dshBackupPrune()` 单独一步：把 20 改成 5 时不该**立刻**静默删掉 15 份备份——这就是「配置」与「动作」分开的意义。
  - **⚠️ 「配置」与「动作」分开，不等于「动作」要读配置**（修掉的真 bug，用户报「立即清理功能存在问题」）。早先 `dshBackupPrune()` 恒用 `retentionKeep()`（**已保存**配置值，默认 20），「输入框改 2 → 不保存 → 点立即清理」会拿旧的 20 去清：7 份都不超 20，**什么都不删**，还回「当前没有超出保留份数（20 份）」，用户眼里就是「按钮不工作」。修法：`dshBackupPrune(opts)` 接受可选 `o.keep` 作**本次临时份数**，只影响这一次、**不写配置**，`clamp` 边界与 `setKeep` 同套（`KEEP_MIN`–`KEEP_MAX`）；`dshPruneNow()` 只要输入框有草稿值就传 `{ keep }`，结果文案尾部加「（用的是输入框里的 N，尚未保存为默认值）」。**语义：清理按眼前数字执行，配置是「下次建快照的默认值」。**
  - **连带修掉空输入框被当成 0**：`@input` 原先直接 `Number(value)`，而 `Number('') === 0`（能过 `Number.isFinite`）：清空输入框想重打时草稿瞬间变 `0`，点「保存」会把 20 写成 `1`（`clamp` 到 `KEEP_MIN`）。改为 `.trim() === '' ? null : Number(...)`，清空即「无草稿」；「保存」按钮 `:disabled="dshKeepDraft === null"` 天然对齐。
  - **单测** `test/settings-allowbuilds.test.mjs` 追加用例，钉住这个**静默失效**：① **传了 `{ keep: 1 }` 就真删**（3 份 → 1 份，返回体的 `keep` 必须是调用方传的那个）；② **省略 `keep` 时回落配置值**（旧调用方行为不变）；③ **`keep` 越界被夹到合法区间**（`-5` → `1`、`999999` → `KEEP_MAX`，与 `dshBackupSetKeep` 同边界）。
- **不新增 IPC 通道**（D14 合规）：`services.d.ts` 补 `DshBackupMetaResult` / `DshBackupPruneResult` 两个类型与四个方法签名，`lib/ipc.js` 的 `whale:dsh` 通道**未改动**。
- **单测** `test/dsh-backup.test.mjs` 新增（`// ── ④·E4 标记 / 命名 / 轮转保护 ──` 组），钉住五类**静默失效**：① `keep` 配额不被固定项侵占（`keep=2` 时仍留 2 份普通 + 1 份固定）；② 改标记不动内容（`setMeta` 后还原仍成功）；③ 部分更新语义；④ `before-*` 改名不免死；⑤ `dirName` 不采信 manifest（手改 manifest 指向含 `marker.txt` 的无关目录，清理**不碰**它；旧名字撞真实同名目录时按旧名删要命中 manifest 指的那个）。

**同轮追加：`disabled` 改三态 + 分组轴可切换**

用户又提「禁用和启用区分明显点」「启用的放一起，禁用的放一起」，做第二件时**挖出一个真静默失效**。

- **缺陷**：上一段把 `disabled` 从写死的 `false` 改成读 `o.disabledOf[id]`，但**没管 `disabledOf` 没传时的默认值**：三元另一侧落在 `false`，漏传时已禁用插件被显示成「启用中」。真实 dump 两次对照可复现：只传 `bundleOf` 时已禁用条目全显示「启用中」，补全 `disabledOf` / `configOf` 后才分出 `off` 组。
- **修法**：`disabled` 改**三态** `true`（已禁用）/ `false`（启用中）/ **`undefined`（状态未知）**：
  ```js
  disabled: o.disabledOf && typeof o.disabledOf === 'object' ? !!o.disabledOf[id] : undefined,
  ```
  即「拒绝静默失效」：**缺数据时宁可留空**，二态布尔会撒谎，「不知道」必须能表达。
- **三态向上传染到界面，不许在任何一层压回二态**：
  - `DshIsolateCandidate.disabled` 改可选（`disabled?: boolean`），注释写明「`undefined` 不是「启用」」；
  - `dshIsolateStateOf()` 把 `undefined` 单独判成 `'unknown'` 组，**绝不并进 `'on'`**；
  - 新增 `DSH_ISOLATE_STATES` 第三档「状态未知」（`foldByDefault: false`，提示「可能是 dsh 组装树没读出来，刷新候选再看」）；
  - 状态徽章按三态渲染：`已禁用`（灰实心）/ `启用中`（蓝实心）/ **`状态未知`（警示黄 + 虚线边框）**。**未知档刻意不用蓝**：那等于替它背书；
  - `dshIsolateNoneDisabled()` 只勾 `it.disabled === false` —— 一键隔离意图是「只留我要的」，已 `disabled` 的勾了是 noop，**状态未知的不该替用户决定**。
- **两个分组轴并存，不合并成第三个**：`DSH_ISOLATE_TIERS`（按来源：已在你 patch 里 / 第三方插件 / dsh 官方框架）与 `DSH_ISOLATE_STATES`（按启用状态：启用中 / 已禁用 / 状态未知）各答一个问题：来源答「这条是谁的」，状态答「这条现在开没开」，故做 `dshIsolateGroupBy: 'tier' | 'state'` 可切换，而非二维矩阵（3 × 3 组名比两个轴都难扫）。两轴共用 `dshIsolateTierFolds` 但各自记忆。
- **分组轴切换按钮的位置与样式踩坑**：① 原放 `.btn-row` 里，而 `.btn-row button { flex: 1 }` **命中所有后代 button**，被撑成 1/3 宽实心方块；② `.link-btn` 自带 `margin-top: 10px`，横向 flex 行里垂直错位。改为 `.iso-axis-btn`（胶囊形、透明底、`padding: 2px 10px`），生效轴加 `.iso-axis-on`（实心底 + 亮字 + 加粗）。
- **分组轴只在展开候选后出现**：`div.iso-axis` 从 `.btn-row` 之后**挪进 `patch-list` 内部**：没展开候选时列表不存在，摆外面只会先看到两个不知管什么的按钮。另把「超过 100 条」警告**移到列表外**：它是勾选量提醒，不该随列表收起而消失。
- **单测**：新增 `candidatesOf：没给 disabledOf 时 disabled 是 undefined（未知），不得谎报为启用中`；另改写一条既有用例：原先断言「没给状态就按未禁用处理」**正是本轮在修的错误行为**，改断言 `undefined`。
- **文档同步**：§十二 **B9 标记为已修**（移入 §12.1），§11.4 单测分组说明更新，§6.2 备注本轮改动。
