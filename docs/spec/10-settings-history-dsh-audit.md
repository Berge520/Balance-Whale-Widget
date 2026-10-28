**§十二 全量审计 + 三处静默失效修复**

E4 落地后对 C/D 基础模块与 E1–E4 全链路做了一次横向审计（并行审计 + 逐条复核，26 条发现），只修「违反『拒绝静默失效』核心原则」的三处，其余按危害留档在 **§十二**（新增章节），未修。**这三条修复与其余两轮改动均已随 v1.7.0 发布**。

- **`patchConfig` 写失败改为抛错**（[store.js](file:///e:/Github/Balance-Whale-Widget/public/preload/lib/store.js)）：`writeConfig` 的设计是**返回 `false` 而不抛错**，而 `patchConfig` 直接忽略了这个返回值 —— 于是全项目 13 个调用点（设置页保存 / hosts 表龄 / 保留份数…）都拿不到「没落盘」，用户看到「保存成功」、重载插件后又变回去。这是审计里**辐射面最广**的一条：`writeConfig` 的 `logErr` 只进了日志，没有任何用户可见的反馈。改为抛错后，各调用点既有的 `try/catch` 立刻生效，**连带覆盖原先漏判返回值的调用点**（不必逐处补 `if (!cfg)`）。
- **`whale:config` handler 兜住新抛出的异常**（[ipc.js](file:///e:/Github/Balance-Whale-Widget/public/preload/lib/ipc.js)）：上条是本轮唯一**改变既有函数契约**的改动，必须同步排查调用方。该 handler 里 `patchConfig` 原本在 `try/catch` 之外，改成抛错后会变成 Electron 事件回调里的未捕获异常 —— 挂件侧连「失败」都看不到。只把 `patchConfig` 包进 `try/catch` + `logErr`，**不包**后面的副作用（改窗口尺寸 / 置顶 / 清计时 / 广播）：配置没落盘不该连带跳过窗口调整，两件事。
- **`homeDir` / `expandHome` 兜住 `os.homedir()` 的异常**（[util.js](file:///e:/Github/Balance-Whale-Widget/public/preload/lib/util.js)）：`homedir()` 在 Windows 上读 `USERPROFILE` / `HOMEDRIVE`+`HOMEPATH`，三者都被清掉时**会抛错**。早先 `path.join(os.homedir(), fallback)` 裸调，异常被候选探测的 `catch (_) {}` 吞成「这个候选目录不存在」→ 候选表断掉、函数返回 `''`，而 `''` 在**全部**调用方眼里等于「用户没配 `DSH_HOME`」：快照列表空、备份报「没有可备份的文件」、诊断假通过、日志零留痕 —— 正是 E1 全链路最怕的那种失效。修法与 D23 同款口径：**只有「目录确实不存在」能静默，其余是真故障**。这里受 D21 依赖边界限制（`util.js` 禁止 `require('./log')`），没法留痕，改为「取不到就跳过该候选」：行为与原来一致（那个候选本来也命中不了），但候选表不再中途报废。`expandHome` 同理：取不到家目录就**不展开**，把 `~` 原样留着交给后续 `existsSync` 判否。
- **单测** `test/util.test.mjs` 新增 `homeDir / expandHome：os.homedir() 抛错时不掀掉整张候选表`：把 `os.homedir` 打成必抛，钉住三件事：① 不往外抛异常；② **env 命中的候选照常返回**（候选表不因 homedir 失败而整张报废，这是「先 env 后家目录」顺序的实际意义）；③ `expand:true` 且需要家目录时退回「不展开」而不抛。改完四关全绿。
- **留档**：24 条未修发现全部记入 **§十二**（B1–B14 中等 / C1–C7 低优），每条带文件位置与危害描述。判据是「会不会静默失效 / 静默丢数据」：显示错、慢一点、丑一点的一律不进表，避免这张表被稀释成「待办大全」。

**E3 候选清单分档 + 取消截断**

E3 落地后用户反馈：「共 204 个候选（已截断，只列出前 100 个）—— ① 太多了还能优化吗 ② 能否区分插件来源」。本机 `--dump-config` 正好 **204 条**，其中 **199 条是 dsh 框架节点**（`tool-bash` / `session` / `llm` / `subagent` / `sandbox` / `timer`…），第三方插件只有 5 个：平铺等于让用户在 204 条里找那 5 条。

- **诊断出两个独立问题**（不是同一个）：(A) 候选**平铺无分档**，用户分不清「哪些禁了没事、哪些禁了 dsh 会坏」；(B) **`truncated` 语义错误** —— 后 104 条根本没渲染出来，连勾都勾不到，而刷新默认全选又会让用户以为「全选 = 全禁（204 条）」，实际只禁了 100 条。两者都违反「拒绝静默失效」。
- **取消截断**：`candidatesOf` 不再按 `MAX_BATCH` 裁候选，204 条全给。`MAX_BATCH = 100` 的语义收窄为**「只约束一次写入多少条」**（它原本的正当用途是「挡住误把整棵组装树传进来的调用」）。界面渲染 204 条 checkbox 无压力，真正的风险在**一次性写 204 条 patch 条目**，闸门应当卡在那里。
- **修 B9（`selectBatch` 静默丢勾选）**：返回形状由数组改为 `{ items, dropped }`。**先保勾选、再截断** —— 早先的实现把 `MAX_BATCH` 截断放在「排除勾选之后」且按输入顺序，用户在界面上明确勾选的项可能被静默丢掉（越靠后的越先丢）。现改为：命中项全收 → 超上限才 `slice(0, MAX_BATCH)` → 把 `hit.length - out.length` 如实报成 `dropped`，界面据此显示分批警告（`dshIsolatePicked.size > 100` 时提示「本次只写前 100 条」），**不再有「勾了但没生效」的黑洞**。
- **来源分档的唯一权威依据是 dump 的分节头**（`# == <bundle>, patched by <patchedBy>`）：只有分节头知道每个条目归属哪个 bundle，**id 本身看不出来**。`dsh-dump.js` 的 `indexEntries` 改为浅拷贝条目并挂上 `bundle: p.sections[i].bundle`（原先 `out[id] = en` 直接引用、且不带来源），`entriesOf` 输出加 `bundle`。
- **`tierOfBundle` 判据**：
  - `@deepseek-ai/` 作用域前缀 → `core`；
  - `OFFICIAL_BUNDLES` 白名单（`dsh-base` / `dsh-web-app` / `dsh-market` / `dsh-help`）→ `core`；
  - **不按 `dsh-` 前缀判官方**：第三方大量占用这个前缀（实测 `dsh-cost-meter` / `dsh-mnemon` / `dshmarket` / `dsh-better-sidebar` 全是用户装的），按前缀判会把 5 个第三方插件误折叠进「官方框架」；
  - **判不出来一律算 `third`** —— 宁可不折叠，也不把插件藏起来（默认展开的错误代价只是「多看一眼」，默认折叠的错误代价是「用户找不到自己的插件」）。
- **档位顺序 `patched → third → core`**（`TIER_ORDER`），`candidatesOf` 末尾按此稳定排序。patch 分支**无条件归 `patched`**（与它属于哪个 bundle 无关）：改动就是改它自己那一行，是最稳的一类。
- **顺手修掉一个硬编码**：`candidatesOf` 的 plugin 分支原先把 `disabled` / `hasConfig` 写死成 `false`，而 dump 里明明有这两个字段 —— 于是「已经是 disabled 的插件」在界面上被显示成「启用中」、`selectBatch` 冻结的状态也跟着错。改为读 host 传入的 `disabledOf` / `configOf`。
- **宿主层**：`settings.js` 的 `pluginIdsFromDump` 重命名为 `fromDump`，返回 `{ ids, bundleOf, disabledOf, configOf }`，把 dump 的分节来源与条目状态一并交给 `candidatesOf`；两处 `truncated` 字段删除（超时兜底分支的、dump 成功分支的）。
- **设置页**（`src/App.vue`）：候选列表改为按档分组渲染（`dshIsolateGroups`），组头 `.iso-tier` 可点击折叠，**`core` 档 `foldByDefault: true`**：用户先看到的就是「我改过的 + 第三方插件」。折叠状态存在 `dshIsolateTierFolds`，`watch(dshIsolate)` **只在首次数据到达时套默认值**，之后尊重用户手动展开/折叠（否则每次刷新都会把用户展开的官方框架重新折叠回去）。
- **不新增 IPC 通道**（D14 合规）：`services.d.ts` 的 `DshIsolateCandidate` 加 `tier` / `bundle`，`DshIsolateCandidatesResult` 删 `truncated`（加注释说明候选不再截断），`DshDumpEntry` 加 `bundle`，`lib/ipc.js` 的 `whale:dsh` 通道**未改动**。
- **单测** `test/dsh-isolate.test.mjs`：⑥ 组既有用例改判 `batch.items` / `assert.equal(batch.dropped, N)`，新增 `selectBatch：勾选项不被截断静默丢弃（回归 B9）`；新增 ⑦ 组：`tierOfBundle` × 3（官方作用域与白名单 / `dsh-` 前缀不判官方 / 判不出来算 `third`）、`candidatesOf` patch 无条件 `patched`、分档排序、**disabled / hasConfig 不再被硬编码成 false**、**候选不再截断（204 条全给）**。改完四关全绿。
