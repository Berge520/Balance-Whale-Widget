**第五批（柱状图不出柱 + 加纵轴参考线）**

> **⚠️ 本批「选择器全部命中 `data-v-458f7017`（UsageChart）」已被第 ㉑ 段推翻**：柱状图整套（`.chart-*` / `.bar-*` / `.grid-line` / `.axis-label` / `.chart-wrap` / `.chart-dense` / `.chart-ultra`）已上提 `src/main.css` 作唯一来源，产物不带 `data-v-` 哈希。正文保留作历史。

- **柱状图整段不出柱**：`.chart` / `.bar-col` / `.bar-track` / `.bar` / `.bar-day` / `.chart-dense` / `.chart-ultra` 全错写在 App.vue 的 scoped 块里，`.bar-track` 的 `height: 90px` 不生效 → 有数值、有日期、有横轴，柱高为 0。整段移进 `UsageChart.vue` scoped 块。**不报错、不警告，读代码看不出**：必须去 `dist/assets/*.css` 对哈希。
- **数据切片方向写反（`slice(-N)` → `slice(0, N)`）**：`days31` 是**新→旧**（`days31[0]` 是今天，宿主按 `dayAdd(today, -i)` 递减生成），取最近 N 天必须 `slice(0, N)`。原 `dshUsageDays` / `codexDays` 都写 `slice(-N)`，「7 天档」实际画 30~24 天前。**同一错误两处**（源头是 `dsh-usage.js` 注释「按 7/14/30 档位取尾部渲染」）。
- **新增纵轴参考线 + Y 轴刻度（`.chart-axis` / `.axis-label` / `.grid-line`）**：三条线取满格 / 半格 / 1/4，**只给前两条写刻度**；量级由组件内 `dayMax` computed 从 `props.days` 算，**不新增 prop**。
- **参考线与柱子的 0 刻度对齐**：「0 刻度」下面还有 `.bar-day` 行，`bottom: 0` 会压到日期行。修法 `bottom: calc(百分比 + var(--day-row))`，行高抽成 `--day-row`（14/30 天档 `.chart-dense` 日期压到 9px）。
  - **`--day-row` 必须挂在 `.chart-wrap`**（刻度列与绘图区共同父级），不能挂 `.chart-plot`：`.chart-axis` 在 plot 之外，取不到。
  - **不用 `margin-bottom` 顶替**：绝对定位元素上 `margin` 与百分比 `bottom` 叠加易踩坑，改 `padding-top: 18px` + `box-sizing: content-box` 对齐轨道上沿（跳掉 `.bar-val` 的 14px + gap 4px）。
- **`.chart-axis` 的 `height` 必须等于 `.bar-track` 的 90px**：刻度按「相对轨道的百分比」定位，取整列高会错位。
- **核查方式**：从 `dist/assets/*.js` 抽 `__scopeId` 与组件对应关系，再 grep `dist/assets/*.css` 看方括号哈希。**动 scoped 样式都该跑**。

**第六批（档位切换器 + 折叠按钮对齐 dsh Tab 的统一按钮）**

> **⚠️ 本批「折叠按钮覆写成按钮外观 + 压特异性补丁」已被第 ⑱ 段推翻**：`button.link-btn` 补丁已删，回归全局 `.link-btn` 下划线文字链。正文保留作历史记录。

用户要求「7 天 / 14 天 / 30 天」与「各模型用量 / 收起各模型用量」套用 dsh Tab 的统一按钮样式。

- **不能直接复用 `.dsh-card`**：规则在 App.vue scoped 块，控件由 `UsageChart.vue` 渲染（拿不到父组件 scope 哈希），与 `.m-*` / `.chart-*` 同一条坑。在 `UsageChart.vue` scoped 块**按同一套参数再写一份**，注释标明「必须与 App.vue 的 `.dsh-card .patch-btn` 逐字一致，改一处要改两处」。
- **档位按钮（`.range-tab`）**：去掉外层 `.range-tabs` 的胶囊边框与内边距，三个按钮各用 `.secondary` 档：`padding: 4px 12px` / `border-radius: 8px` / `font-size: 12px` / `font-weight: 500` / `line-height: 1.6` / 蓝底蓝字描边，`flex: 1 1 0` 等分；选中档 `.range-tab-on` 亮实心 + 白字。
- **折叠按钮（`各模型用量` / `收起各模型用量`）**：markup 仍是全局 `.link-btn`（下划线 + 透明底 + 12px 灰字），在组件块里覆写成同一套按钮外观。
  - **踩坑：覆盖全局类必须压特异性，不能赌源序**。两者同为 (0,1,0)，scoped 编译后为 `.link-btn[data-v-xxx]` 与 `.link-btn[data-v-yyy]`，互不匹配对方 DOM，**谁在后取决于构建注入顺序**，故本组件写 **`button.link-btn`（0,1,1）**。
  - 副作用：App.vue 的 `.field + .link-btn { margin-top: -4px }` 同为 (0,1,1) 且在**之后**，该规则胜出。

**第七批（全页按钮统一到 main.css 全局块）**

> **⚠️ 本批三条记载已被第 ⑱ 段推翻，以 ⑱ 为准**：①「值写死、不走 CSS 变量」→ 档位配色已改走主题变量（深色模式不再隐形）；②「压特异性补丁」→ 已改为全局 `.link-btn` 置于 utils 档位**之后**靠源序统一为文字链，各组件补丁全删；③「dsh 分组内危险档自写全三色」→ 该复写已删，危险档配色全由 `.utils-danger` 提供。第七批正文保留作历史记录。

用户要求设置页所有 Tab 的按钮样式统一：**提到 `main.css` 全局块** + **尺寸与配色全统一** + **按调研白名单豁免**。

- **必须放全局块**：「`<style scoped>` 的 `data-v-xxx` 只加在本模板直接写的元素上」已踩三次（`.m-*` / `.chart-*` / App 的 `.range-tab`）。故在 `src/main.css`（唯一非 scoped 全局块）建**四档语义基类**。
  - `utils-btn`：基础尺寸/形状（`padding: 4px 12px` / `border-radius: 8px` / `border: 1px solid transparent` / `font-size: 12px` / `font-weight: 500` / `line-height: 1.6`）。
  - `utils-primary` 实心蓝（`#536ba9` + 白字）· `utils-secondary` 半透明蓝底蓝字 · `utils-danger` 半透明红底红字（`#e0433f`）· `utils-outline` 透明底 + `--line` 描边 + `--fg-dim` 字色。
  - **只放尺寸与配色，绝不写 `margin` / `flex` / 定位**：同一颗按钮在 `.btn-row` 要 `flex: 1`、候选行尾要 `flex: none`、`.gh-src-add` 里又不同，布局留给各 scoped 块。
  - **命名用 `utils-` 前缀而非 `btn-` / `whale-`**：`btn-` 与既有 `.btn-row` / `.btn-busy` 易撞名；`utils-` 明确表示「工具基类，非某组件部件」。
  - **值写死、不走 CSS 变量**：`--line` / `--fg-dim` 只在 `utils-outline` 里作**兜底**（`var(--line, …)`），主色直接用字面量 `#536ba9`。
- **发现并修掉三个既有 bug**：
  1. **`.export-btn.danger` 从来没有样式定义**：「清除数据」与「重置预警」确认态本该变红，实际仍是灰蓝，挂上 `utils-danger` 后才显红。
  2. **`.danger` 比 `.secondary` 矮 2px**：`.danger` 只写背景与字色、没写 `border`，基类的 `border: 1px solid transparent` 一并解决。
  3. **`App.vue` 模板里卡片头部的区间快捷切换（`.range-tab`）此前完全没有样式**：样式只写在 `UsageChart.vue` scoped 块里，而这组 `<button>` 是 App 模板直接写的元素、只带 App 哈希。现补 `App.vue` 内的 `.range-tabs` / `.range-tab` 布局规则（`display: flex; gap: 4px` + `flex: 1 1 0`），尺寸配色走基类。
- **层叠顺序的意外发现：`main.css` 先注入，全局 `.link-btn` 反而会抢新加的基类**。同特异性时 scoped 规则排在后面因而胜出，`.link-btn` 的下划线 / 透明底会盖掉挂上去的 `utils-secondary`。修法曾是各处压一级特异性（⑱ 改为全局源序统一）。**不要赌源序**。
- **特异性记账（改这类全局基类前必须先算）**：
  - `.dsh-card .btn-row button`（0,2,1）> `.utils-danger`（0,1,0）→ dsh 分组内危险档曾因此在 scoped 块里**自写全三色**。
  - `button.utils-btn:disabled`（0,2,1）压过各组件 scoped 里的 `:disabled { opacity: .45 }`；`AccelView.vue` 的 `.btn-busy:disabled`（0,3,1）用 `opacity: 1` 抢回，否则「更新中」按钮看起来像被关掉。
  - `.dsh-card .iso-axis-btn.iso-axis-on` 的选中态规则必须排在其后覆盖背景色（第六批已记）。
- **两个 `:class="{ danger }"` 变体改写**：`.export-btn` 确认态由「加 `danger` 类」改为 `:class="xxxConfirm ? 'utils-danger' : 'utils-outline'"` —— 原先的 `danger` 是裸类名（无定义）。
- **豁免白名单（均有独立 scoped 样式，本轮不动）**：`.tab`、`.fold-title`、`.card-toggle`、`.iso-axis-btn`、`.patch-btn` 的位置/间距、`.skin-cell*`、`.skin-op` / `.skin-op.danger`、`.close`、`.gh-move-btn`、`.gh-op-head`、`.opt`（`<label>` 单选卡，不是按钮）。**判据：「它不是普通动作按钮」**。
- **完全无类名的按钮补 `utils-btn utils-primary`**：原先靠全局 `button { … }` 拿实心蓝（保存凭据 / 保存模型 / 显示挂件 / dsh 启动 / 三类刷新等），逐个确认语义是主操作后挂 primary。
- **模板批量挂类（脚本三轮）**：`secondary` / `link-btn` 系 / `danger` / `export-btn` 分别追加 `utils-btn` + 对应档位。**注意多行开标签**（属性跨行时向后拼最多 6 行再判断是否已挂类）。
- **产物裸选择器核查**：`dist/assets/*.css` 中 `utils-btn` / `utils-primary` / `utils-secondary` / `utils-danger` / `utils-outline` **全部 0 条带 `[data-v-]`**；`.range-tab` 分别带 App 与 UsageChart 哈希。

**第八批（「开发者」Tab 全量审查后的五处修补）**

审查结论：同构重复合理，**不构成重构理由**；本轮只做「真缺陷 + 纯收益小项」。

- **① 市场卡按钮判据放宽（真缺陷：装了却卸不掉）**：原判据 `dshMarketHitAt(pi)?.inDeps`，卸载 / 禁用 / 彻底删除只在 `inDeps` 为真时渲染。但 `installedMap` 三字段：`inDeps`（`node_modules` 里有）/ `inPatch`（`cordis.patch.yml` 有条目）/ `disabled`（patch 里是否禁用）；`inDeps=false && inPatch=true` **真实存在**（github / tarball 来源，目录名与 `package.json` 键名不同形），徽章亮着但无卸载按钮。**修法**：判据放宽为 `inDeps || inPatch`（宿主 `marketUninstall` 能按短名反查），**彻底删除仍只在 `inDeps` 为真时给**。
- **② 诊断卡补 `env === null` 分支（真缺陷：失败时空白卡）**：`env` 可为 `null`（读环境失败 / 15s 超时兜底），五项检查一项没跑，「未安装」「已安装」两道分支都不命中 → 卡片空白。**修法**：三道分支前补 `v-if="diagnose && !diagnose.env"` 收尾，三道用 `v-if` / `v-else-if` / `v-else-if` 串起（早先误写成两个并列 `v-if`，会多出无主的 `</template>`）。
- **③ 诊断卡复制按钮判据对齐（真缺陷：复制出空报告）**：「复制诊断信息」原判据 `v-if="diagnose"` 只判存在：整轮失败时 `diagnose` 也有值（`results` 空、`env` 为 `null`），会复制出「0 项通过 · 0 项异常」空报告。**修法**：改 `v-if="diagnose && !diagnose.error"`，与转储卡 `!r.ok` 对齐。
- **④ 市场卡分类名预建 Map（纯收益小项）**：模板原写 `dshMarketCategories.find((c) => c.key === p.category)?.zh || p.category || '未分类'`。**修法**：紧接 `dshMarketCategoryCount` 建 `dshMarketCategoryZh` computed（`Record<key, 中文名>`，一次建成、模板 O(1)）+ `dshMarketCategoryText(key)`（空分类回落「未分类」），同 `dshMarketHitMap`。
- **⑤ Codex 卡字段区跟进 `.stat-grid`（观感统一）**：dsh 用量卡已改等宽指标格（第四批），Codex 卡仍逐行 `.field row`。**修法**：`.field row` 只留「会话目录 / 会话文件」，其余进 `.stat-grid`（今日 / 本月 / 累计 / 会话四格），三个分项（输出 / 推理 / 缓存命中）挪进 `.stat-break` 的 `.stat-chip`。**Codex 无金额口径**（`showCost=false`），`.stat-sub` 不放成本：今日格放「N 轮」，其余格**留空不渲染**（空 `span` 多占一行、与他格错位），「订阅窗口」仍留 `.field row`。CSS 复用 `.stat-*`。
- **`public/preload/lib/dsh.js` 有改动**（`checkGhostDeps` 幽灵依赖自检），需重载插件；`App.vue` 热更新。
