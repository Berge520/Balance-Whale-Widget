**⑬ dsh 全量导出（「开发者」Tab 新卡）**

`public/preload/lib/dsh-export.js`（纯 CommonJS、只依赖 `fs`）+ `settings.js` 宿主层三个方法 + 设置页卡 + `test/dsh-export.test.mjs`。

结论：**不做全量备份，做全量导出**，与 `lib/dsh-backup.js`（E1 快照）**并存互不干扰**：

- **`dsh-backup.js` = 快照**：白名单只备 3 个文件（`cordis.patch.yml` / `package.json` / `settings.yaml`），用于**撤销**某轮改动，刻意窄。
- **`dsh-export.js` = 导出**：遍历整个 `$DSH_HOME`，用于**打包带走**（换机器 / 重装 / 存档）；**挂件不负责还原**：标准 `.zip`，解压即原目录结构。

**能力边界（不追）**：社区同类（`dsh-backup` / `dsh-config-manager` / `dsh-backup-migrator`）能订阅宿主事件保运行时一致、恢复后自动重启 dsh；本插件跑在 **uTools 进程**而非 dsh 进程内，两件都做不到。

- **格式选 zip，手写打包器（store 不压缩）**：`.tar.gz` 在 Windows 踩过坑，且零依赖不能引 `archiver` / `jszip`。手写 zip：local file header (`0x04034b50`) / central directory (`0x02014b50`) / EOCD (`0x06054b50`)、CRC-32 查表、DOS 时间格式、UTF-8 文件名 flag（bit 11 = `0x0800`）；**`method=0`（store）**：大头是 `node_modules` 与已压缩资源，deflate 收益低、自写压缩流出错面大。Windows 资源管理器可直接解压。
- **⚠️ 打完包必须回读校验（`verifyZip`）**：`exportAll` 落盘后重读，校验 EOCD 魔数 + 条目数与 central directory 一致 + **每条目 CRC-32 与写前记账一致**，不过就删产物报错。单测钉住**截断包**与**过小产物**。
- **⚠️ `node_modules` 排除必须是开关、不能并进恒排除表（真 bug）**：初版写进 `EXCLUDE_DIRS`，`skipModules:false` 时**仍被恒排除**且无提示。**修法**：拆成 `EXCLUDE_DIRS = ['.git','whale-dsh-backup']`（恒排除）与独立 `MODULES_DIR = 'node_modules'`（受 `skipModules` 控制），遍历先判开关再判恒排除表；`excludedDirs` 按本次开关计算。
  - `.git` 恒排除：本机仓库状态，换机器无意义且常比配置大。
  - `whale-dsh-backup` 恒排除：**防自包含**（快照目录随备份次数越滚越大）。
- **⚠️ 凭据默认不带**：`.credentials.yaml` / `.credentials.yml` / `credentials.yaml` / `credentials.yml` / `.env*`（`isCredFile`）**默认排除**：包内是**明文**（zip 不加密），导出物常经网盘 / 聊天传递；但换机器接着用需凭据，故给勾选框（`dshExportCred`），勾了才带，并**列出会带哪几个文件**（`previewExport` 回 `credFiles`）。
- **⚠️ symlink 不跟随**：遍历用 `isFile()` 过滤而非事后判 `isSymbolicLink()`，遇符号链接目录**直接跳过**（跟随会跳出 `$DSH_HOME` 或成环爆栈）；**栈式迭代**同理。
- **两级上限**：`MAX_FILE_BYTES` 100MB（单文件）、`MAX_ENTRIES` 200000（条目数）。超限不静默丢：回体带 `truncated:true` 与原因，卡片红字明示，**禁用导出按钮**。
- **写盘原子性**：先写 `<outPath>.part` 再 `fs.renameSync`；中途失败（磁盘满 / 权限）不留半截 zip，单测断言不残留 `.part`。
- **manifest 落在包内**（`whale-dsh-export.json`，`SCHEMA = 1`）：记**导出来源**（`$DSH_HOME` 绝对路径）、**导出时间**、条目清单、`excludedDirs`、凭据处理结果、`truncated`。
- **`previewExport` 与 `exportAll` 分开**：进卡与改勾选只调 `previewExport`（**只统计、不写盘、不产包**），先摆出「来源目录 / 预计条目数 / 大小 / 会带的凭据文件」；不跳过 `node_modules` 时全量遍历 + 逐文件 CRC 代价极高。
- **`dshExportCreate` 走 `utools.showSaveDialog`**：`outPath` 为空弹系统保存框（`defaultPath` = 下载目录 `dsh-backup-<stamp>.zip`），取消回 `{ok:false, canceled:true}`：**`canceled` 必须与 `error` 分开**，否则取消被当成失败；缺 `.zip` 自动补。
- **卡内三个按钮 / 两个勾选**：`导出为 zip…`（`dshExportBusy || !entries || truncated` 时禁用）、`重新统计`、成功后「打开所在文件夹」（`.fold` + `.link-btn`，走 `dshExportReveal`）；两个勾选**改完立即写配置并重算预检**（`dshExportSetCred` / `dshExportSetNoMod` → `patchCfg` → `dshExportRefresh`）。
- **收起态摘要**（`dshExportSummary`）：未读预检不写死数字（写「展开查看预计内容」），读过才报条目数与体积。
- **不新增 IPC 通道**（D14 合规）：设置页直走 `window.services.*`，`services.d.ts` 补三个方法签名（`dshExportPreview` / `dshExportCreate` / `dshExportReveal`）与三个类型（`DshExportSkipped` / `DshExportPreviewResult` / `DshExportCreateResult`），`lib/ipc.js` 的 `whale:dsh` 通道**未改动**。
- **单测** `test/dsh-export.test.mjs`（含 Windows skip 用例）：`utools` 桩 + `createRequire` 造临时 `$DSH_HOME`，自写 `entryNames` / `readEntry` 扫 local file header。钉五类**静默失效**：① 凭据默认不带 ② 勾选才带 ③ `skipModules:false` 才收 `node_modules` ④ `.git` / `whale-dsh-backup` 恒排除 ⑤ `verifyZip` 认截断包与空壳；另含 symlink、CRC、不残留 `.part`、无文件不产包、`previewExport` 只统计。
- **⚠️ 导出前提示「dsh 正在运行」**：`dshExportPreview` **返回前异步探一次 dsh 端口**（`dshPort`，默认 3080），结论挂 `running` 字段（`settings.js` 侧实现，复用 `dsh.probePort` + `dsh.snapshot`，**未新增 IPC 通道**）。理由：会话记录（JSONL）**追加写**，运行中读可能取到半条；导出前后文件集在变，包内容不自洽；dsh 正在写 patch 时导出的是修改中间态。
  - **复用 `probePort` 不自己起 `netstat`**：它已有全局单例 + `busy` 排队 + 6s 超时 + **父链归属判定**（Windows 下 `spawn` 有 `cmd` 中间层，监听的是子进程 `node.exe`，单比 pid 认不出自己人）；自写必与状态卡 / 诊断口径漂移，「是不是 dsh」的判据（`looksLikeDsh`）只在 `dsh.js` 有一份。
  - **`running` 是三态，不是布尔**：`{running:true}` = 有 dsh 在跑（本插件启的 / 别的终端都算，`running \|\| external \|\| ready`）；`false` = 没在跑；**`null` = 探测失败**。界面分三档：在跑给黄色警告（`.hint-warn` / `--warn`，**不做红色错误框**：是「建议」不是「失败」）、端口被**非 dsh** 程序占用时一句灰字（`other` 字段）、`null` 时明说「未能确认」而**不谎报「没在跑」**。
  - **⚠️ 该 API 变异步（`Promise`）**：`previewExport` 是同步纯文件统计，**先算同步结果、探测完再 `Object.assign` 回填**；前端 `dshExportRefresh` 随之必须 `Promise.resolve(p).then(...)`（早先同步赋值只拿到 Promise），并加 `dshExportToken` **只认最后一次**；探测侧另有 **8s 超时兜底**（`probePort` 6s 再兜一层）
  - **提示不拦截操作**：只是文案，**导出按钮不禁用**：边跑边导也能出可用包，只是不保证某一时刻的完整快照。
- **`preload/` 有改动**（新增 `dsh-export.js`、`settings.js` 接三方法、`store.js` 加两键），需重载插件。

**⑭ 市场卡筛选与排序三处优化**

本轮做 ①排序方向可切换 ②关键词分词与排除 ⑤排序硬编码与陈旧文档（**兼容性筛选、复合排序键、分类 chip 分组不做**）。

- **① 排序方向可切换，默认方向跟着轴走**（`SORTS` / `SORTS_DESC` / `desc` + 前端 `dshMarketPickSort` / `dshMarketSortDesc`）：四轴一律**升序原语**，方向由 `filterPlugins` 的 `desc` 外层取反。**⚠️ `desc` 默认值不能用 `||`**：`o.desc || SORTS_DESC[key]` 在显式传 `false` 时算成 `true`，「升序」**永远选不中**，必须 `typeof o.desc === 'boolean'`。
- **① 交互：再点当前轴 = 反向，换轴 = 按新轴默认方向复位**（`dshMarketPickSort`）。复位不能省，否则「名称升序」切「下载量」会得「下载量升序」。方向做成**读出来的事实**（`方向：降序`、底部「排序：下载量 降序。」）而非独立开关（否则出现一轴都没选中的空档态）。`dshMarketSortDesc` 加进「条件变就回第 1 页」的 watch 依赖。
- **② 关键词支持空格分词（与关系）与 `-词` 排除**（宿主 `matchKeyword` + 前端 `dshMarketList` 同口径复刻）：原整串比子串，「翻译 离线」必零结果。按空格拆段、**每段都要命中**（可跨字段，`dsh usage` 能出 `dsh-usage`）；`-词` 表示不得命中，**只有排除词也成立**（`-plugin` = 全目录减去命中的）。**⚠️ 光一个 `-` 不算排除词**（可能只是连字符），跳过：按「排除空串」处理会把整份目录清空。比对前四字段拼成 haystack，跨字段假命中**接受**。占位文案「空格分词，如「翻译 离线」；-词 排除，如「翻译 -离线」」。
- **⑤ 陈旧表述与硬编码收尾**：spec 第十节原写「加载更多」，实现已是**页码分页**（`DSH_MARKET_PAGE = 80` + `dshMarketPageNo` / `dshMarketPageCount` / `dshMarketPageItems`），按文档改正；排序轴中文名抽成 `dshMarketSortLabel` computed。
- **单测** `test/dsh-market.test.mjs`（分词与排除、`desc` 显式 `false` 与各轴默认方向、`SORTS_DESC` 轴齐全）。**`public/preload/lib/dsh-market.js` 有改动**，需重载插件。

**⑮ 市场卡分类 chip 常用优先 + 折叠（接 ⑭）**

分类平铺在 `.iso-axis`（`flex-wrap`）里占三行，把「范围 / 排序」挤出首屏。

- **排布 = 择优 + 每行凑齐**（`dshMarketCategorySplit`）：分「选中的（必留）→ 有计数的（择优）→ 空的（必折）」三档，再按条数降序取常显名额。**⚠️ 三条约束**：① **选中的分类必须留常显段**：否则折叠一收，高亮 chip 连同「怎么取消」一起消失（筛选仍生效，界面无出口）；② 择优依据是**条数**而非位置：目录 `categories` 键序与常用度无关，直接 `slice` 会把没人用的留前排；③ 条数只是代理，故加**占比闸**（`DSH_MARKET_CAT_MIN_RATIO = 1%`，下限 `DSH_MARKET_CAT_MIN_COUNT = 3` 兜住薄目录；`floor = max(3, ceil(总数 × 1%))`）；全够不上门槛时**不得**把首屏清成只剩「全部」，退回按条数取前 N。
- **首屏名额 `DSH_MARKET_CAT_TOP = 5`，是「每行凑齐」而非齐头截断**：按每行放得下几个（`DSH_MARKET_CATS_PER_ROW = 6`，按「两字中文名（数字）」估宽，折叠开关占一位先扣）**向上补满**；齐头截断会在末尾留孤立 chip、多占一行。`room = max(0, TOP - 选中数)`。
- **折叠开关只在真有折起来的分类时出现**（`v-if="rest.length"`），文案「▾ N 个」/「▴ 收起」，**⚠️ N 用 `restCount`（折叠前算好的数）而非 `rest.length`**：`rest` 含「选中项之外的有计数类」，展开后选中项归常显段不再属于 `rest`，用 `rest.length` 会让「N 个」在展开瞬间变样。虚线边框（`.iso-cat-toggle`）与实心 chip 区分；`aria-expanded` 同步，▴/▾ 用 `.iso-cat-caret` 固定宽度（两字形宽度不同，切换时整行抖）。
- **⚠️ 展开态「其余」行必须按条数重排**（「展开后位置没变」的根因）：`rest = usable.slice(补进来的名额).concat(empty)`，开头被常显段截走一段，原样渲染会**跳前面**；常显段是条数降序，`rest` 同口径重排。折叠段单起一行（`v-if` 而非 `v-show`：收起时不该留在 DOM 被 Tab 走到），前置「其余」标签。
- **计数为 0 的分类置灰且不可点**（`:disabled`，选中项除外）：点进去只有空列表。`:disabled` 要连 `:hover` 一起掐掉（否则灰按钮仍变亮，像能点），`title` 补「目录里没有此类插件」。与「空分类必折」同一口径的两处落点，改一处要连另一处看。
- 改动全在 `src/App.vue`（**纯前端**，无宿主改动）→ `npm run dev` 热更新，**不需要**重载插件。
