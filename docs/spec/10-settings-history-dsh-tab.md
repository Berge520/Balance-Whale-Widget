**⑫ dsh Tab 结构整合：合并卡片 5+6 / 顺序 / 可读性打磨（已随 v1.7.0 发版）**

三态与分组轴落地后的结构排查，按危害分批。

**第一批（合并 + 卡片顺序）**

- **合并「dsh 插件开关」与「dsh 一键隔离」为一张卡**：同一 `cordis.patch.yml`、同一 profile、同一份快照，仅入口不同（单条改 vs 批量勾选）。分列时候选范围不一致：单条只来自 patch，批量是「patch ∪ 组装树」。
  - 卡名 `dsh 插件开关`，提示「两种改法」：**行尾即时**（`source === 'patch'` 且 `disabled !== undefined` 时给按钮）+ **勾选批量**（预览 → 确认两阶段）。不给 `source === 'plugin'` ：宿主 `dshPatchToggle` 要求 id 已在 patch 中，单条做不到「新加」；也不给状态未知条目。
  - **两个 flash 不复用**：逐条开关归 `dshPatchFlash`，批量隔离归 `dshIsolateFlash`；与 `secretsFlash` / `guideFlash` 同口径。
  - **摘要陈述本卡状态**：新增 `dshIsolateSummary`（`N 个插件 · 已勾 M 个`），删 `dshPatchSummary`：早先收起摘要读 `dshPatchFlash.msg`，导致「插件开关」卡禁用一条后报隔离结果。
  - `dshPatch` 只保留 `exists` / `file`；`dshPatchToggle` 的 `finally` 改调 `dshIsolateRefresh()`，让徽章与行尾按钮按新 `disabled` 重画。
- **卡片顺序 `主控 → 环境诊断 → 配置转储 → 用量统计 → 插件开关/隔离 → Codex`**：诊断上移（出问题先看哪），用量统计下移（纯查看），Codex 移末位（不属 dsh）。
- **说明文案合并为 11 条**：覆盖「清单为何 200 多条」「单条改与批量改区别」「三个分组轴怎么选」「状态未知是什么」。

**第二批（合并后再排查）**

- **两份候选行模板逐字重复**：`both` 轴内层（`g.children`）与单轴（`g.items`）各抄一份（含徽章与行尾开关），改一处漏一处。抽 `dshIsolateSubLevels(g)`：外层组之下统一成一层带/不带组头的行层（单轴 `head:false`，双轴每子组 `head:true`），模板只用一层 `v-for` + 一段行模板。
- **快照折叠块移位**：移到「候选与待确认计划之后」。快照是事后回滚用的，不是写入流程一环。
- **主控卡补折叠（默认展开）**：`dshMainFold` 独立于 `devFolds`，收起摘要报 `dshStateText`（启动后自动查，不额外读盘）。启动/重启/结束是最高频动作。
- **加卡片组纯分界线**：Codex 卡前加 `.group-sep`（`<hr>`，**不写字**）。初版「以下与 dsh 无关」与紧邻标题重复。
- **验证**：四关全绿。**preload 本轮有改动**（`dsh-isolate.js` 三态 `disabled`），需重载插件。

**第三批（诊断信息 / 故障排查的重复与位置）**

结论：**两者不合并**。诊断信息全是只读 + 复制类动作，故障排查有两个**破坏性按钮**（删插件目录的 dsh / 清 npx 缓存），同框会抬高误点代价。

- **故障排查位置上移**：从卡尾移到**紧挨运行详情之后**，新顺序 `运行详情 → dsh 故障排查 → 高级选项 → 使用说明`。
- **两块重名消除**：dsh 卡改「**dsh 故障排查**」，帮助 Tab 改「**挂件故障排查**」：两处是两份不同日志（dsh 子进程日志 vs 插件自身 `whale-debug.log`）。
- **诊断信息改名运行详情**：「诊断信息（版本 / 命令 / 地址 / 日志）」→「**运行详情（版本 / 命令 / 地址 / 日志）**」：与「dsh 环境诊断」都带「诊断」二字时用户分不清点哪个。
- **故障排查二段确认随折叠重置**：`dshConfirm` 单值、原不随折叠复位，收起再展开仍停在确认态易误点。改为收起时清空（`dshToggleTrouble`）。
- **日志按钮加限定词**：dsh 卡 `查看日志 / 清空日志 / 复制日志` → `查看 dsh 日志 / 清空 dsh 日志 / 复制 dsh 日志`；帮助 Tab `复制诊断日志 / 打开日志文件` → `复制挂件日志 / 打开挂件日志文件`，正文补「这只含挂件与插件自身日志；dsh 日志见「开发者 → dsh」卡」。
- **不做**：不抽公共折叠组件（`fold` / `link-btn` 已够用）；不动 `复制诊断信息`（复制全量检查报告，与 dsh 进程日志不是一回事）。

**第四批（折叠块重复与位置一致性）**

结论：**只统一「长相逐字相同」的两块**，不合并整卡。

- **抽出 `src/components/UsageChart.vue`**：dsh 用量统计卡与 Codex 会话统计卡的「柱状趋势图 + 各模型用量折叠」原本**逐字相同**，只差字段前缀（`dshUsage*` / `codex*`）。现统一为组件，props 传 `days / labelEvery / barHeight / dayLabel / models / turnsLabel / showCost`。
  - **刻意不纳入组件**：两张卡的字段区与口径说明差异大，不拉平。**但字段区排版形态要一致**（见第六批）。
  - 组件内 `hasBars` 用 `barHeight(1) !== '0%'` 判断，**不自己再遍历 tokens**：柱高由父组件算。
  - 父组件原 `dshUsageDayMax` / `codexDayMax` 两个 computed 删除，最大值改为在各自 `barHeight` 内就地算。
  - **花费格式化必须靠 prop 传入**：曾抄了一份 `¥` + `toFixed`，但 dsh 花费**带币种**（`costCurrency` 非 CNY 时不加 `¥`）。现 `fmtCost` 由父组件传（Codex 侧 `showCost: false`）。
  - **`hasBars` 顺带修 bug**：原判据 `dayMax > 0`，「有 30 天数据但全为 0」会画一排空柱；现「有天数且 `barHeight(1) !== '0%'」→ 正确显示「近 N 天没有用量记录」。`barHeight` 内有 `Math.max(2, ...)` 兜底。
- **「说明」折叠块位置统一为「全部后置」**：原先插件开关卡的说明在最前，其余 5 张卡在末尾。说明不该插在「候选 → 预览 → 确认」动作链中间。
  - **候选行尾按钮与状态徽章贴死**：`.patch-state` 的 `margin-left: auto` 只推**第一个** auto 元素，加按钮后 auto 仍落徽章、按钮无左边距。修法：`.iso-item .patch-btn { margin-left: 8px }`，**不动 auto 归属**，「无按钮」行（`source=plugin` / 状态未知）依赖它贴右。
  - **「全选 / 只选启用中的」改小胶囊**：原在 `.btn-row` 里被 `flex: 1` 撑成两个等宽大按钮。改为复用 `.iso-axis-btn` + `.iso-pick-row` 覆写 `margin-bottom`（`.iso-axis` 的 8px 是给「分组轴 → 列表」的）。
  - **dsh 分组 6 张卡的按钮统一（`.dsh-card` 作用域）**：此前主控卡用 `.btn-row`、外围四张卡清一色 `.secondary`、候选行 `.patch-btn` 是 `2px/10px` 迷你尺寸、分组轴 `.iso-axis-btn` 自带胶囊边框。现给 6 张卡加 `.dsh-card`，用后代选择器把 `.btn-row button` / `.patch-btn` / `.iso-axis-btn` 的**内边距、圆角、字号、行高、字重**拉平，配色**保留「主 · 次 · 危险」三档**。`.iso-axis-btn.iso-axis-on` 的选中态规则必须排在其后覆盖背景色。
  - **用量统计卡口径字段改指标格（`.stat-grid` / `.stat-break`）**：原「今日 / 本月 / 累计」各写一行 `.field`，`值 + tokens + ¥ 金额` 挤在同一段文字。现改指标格：`.stat-num` 大号数字在顶层、单位降为 `.stat-label` 标签行、金额作 `.stat-sub` 次级说明；`.stat-num` 与 `.stat-label` 均加 `nowrap + ellipsis`（完整含义移入 `title`）。累计 token 四个分项拆出独立成 `.stat-break` 一行小胶囊。
  - **余额并成第 5 个指标格**：原「dsh-usage 抓到的余额」单独占一行 `.field`，标签长（9 个字）而 `.label` 有 `min-width: 72px`，窄卡里会挤成两行。现并进 `.stat-grid`，`fmtDshBalance()` 拆成 `fmtDshBalanceAmount()`（`¥59.54`）与 `fmtDshBalanceAt()`（`9/23 10:21`）。**列数用 `repeat(auto-fit, minmax(88px, 1fr))` 而非写死**：余额格是 `v-if` 的，写死会让 4 格时右侧空一列。
  - **各模型用量行改排行榜（`.m-row`，在 UsageChart.vue 自己的 scoped 块里）**：原 `.field.row` + 一整串 `.ver`（`4.2M tokens · 73 次调用 · 输出 26K · ¥ 0.00`），右缘随内容浮动。改 grid 四列（名字 / 总量 / 次·输出 / 花费），名字过长截断（`title` 存完整名）、列右对齐；每行下方压一条 `.m-bar` 占比细条，按**相对最大模型**取宽。`showCost: false`（Codex 侧）时用 `:not(:has(.m-cost))` 收掉末列。**条数上限 `MODELS_MAX = 8`**，末尾提示「另有 N 个模型用量过少，未列出」而非静默丢弃。
  - **踩坑：`<style scoped>` 救不了子组件渲染的元素**：`.m-*` 最初写在 App.vue 的 scoped 块里，产物中规则**存在且语法正确**（编译成 `.m-row[data-v-xxx]`），界面却没生效：scoped 的 `data-v-xxx` 只加在「模板里直接写的元素」上，模型行由 `UsageChart.vue` 渲染、只带 **UsageChart 的** `data-v-yyy`。规则查得到、类名没拼错，就是没反应。**结论：样式必须与渲染它的组件放在同一个 scoped 块里**；跨组件必须用 `:deep()` 或全局块。核查方式：在 `dist/assets/*.css` 里 grep 类名看方括号哈希，再在 JS 里 grep 该哈希确认归属。
  - **跨组件共用样式优先落全局块**：**判据：跨组件逐字重复的尺寸/配色 → 上提 `src/main.css`；单一组件布局 → 留该组件 scoped**（第七批 utils 基类、㉑ 柱状图整段都是落点）。
  - **档位切换器（`.range-tab`）改等分宽度**：`7 天 / 14 天 / 30 天` 内容宽不同，贴内容排会让三个按钮宽窄不一。加 `flex: 1 1 0` 等分。
