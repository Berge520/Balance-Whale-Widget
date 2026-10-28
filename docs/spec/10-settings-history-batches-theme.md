**⑱ 按钮深色可读性修复 + 全页按钮样式二次收敛**

深色下次级按钮文字几乎隐形，根源两条，属第七批方案缺陷：

- **根源一：utils 档位写死浅色配色** —— `.utils-secondary` 写死 `#536ba9`、`.utils-danger` 写死 `#e0433f`，深底上与背景同亮度。**修复**：改走主题变量，`utils-secondary` 用 `var(--accent-weak)` 底 + `var(--accent)` 字 + `var(--line)` 描边；`utils-danger` 用新增令牌 `--err-weak` / `--err-line` + `var(--err)` 字；深浅两套各在 `:root` 与深色媒体查询给值。**例外 `utils-primary` 仍写死 `#536ba9`**：深色 `--accent`(#8aa4e6) 偏浅，白字对比不足（main.css 有 ⚠️ 注释）。
- **根源二：`.link-btn` 基类只在 App.vue scoped 块** —— AccelView / UsageChart / FirstRunGuide 同名类是死类，补丁跟不存在的全局规则打架，UsageChart 还抄了一份写死深蓝。**修复**：`.link-btn` 上提 main.css 作唯一来源，**置于 utils 档位之后**靠源序（同特异性后来者胜）压过 `utils-secondary`，`class="link-btn utils-btn utils-secondary"` 统一渲染为**下划线文字链**；四文件补丁全删，只留强耦合覆写（`.field + .link-btn` 的 -4px、`.fold > .link-btn` 的 margin 归零、`.link-btn.inline`、FirstRunGuide 紧跟 `.field` 的 margin 归零）。
- **连带修正的既有 bug**：App.vue 的 `.btn-row button.secondary/.danger { background: none }` hack 特异性错（全局 `button` (0,0,1) 压不过档位类 (0,1,0)，从未生效），随 `.btn-row` 骨架上提 main.css 一并删；`.dsh-card .btn-row button.danger` 三色复写与 `.utils-danger` 逐字相同，删。
- **样式统一落点**：`.btn-row`（flex + gap 10px + margin-top 12px + flex-wrap + `> button { flex: 1 }`）与 `.link-btn` 基类同节收进 main.css；六个文件（App.vue / AccelView / UsageChart / FirstRunGuide / SkinCropper / SoundTrimmer）的逐字副本与 18px 变体全删。
- **顺带清理**：过期 CSS 变量 fallback（如 `var(--accent, #536ba9)`）清自 App.vue（含 `.dirty-tag` / `.diag-*` / `.bak-confirm` / `.dsh-web-hint` / `.iso-axis-on` 写死色换令牌）、AccelView、SkinCropper / SoundTrimmer；`.head-actions button.danger` 死代码删除。
- **`.rnd-menu-panel` 不受影响**：`position:fixed` 挂 body 层的自成体系菜单，内部 `class="danger"` 与 utils 无关；`.mkt-*` 卡的 `mkt-src-ms` 等过期 fallback 同轮清掉。
- 纯 `src/` 改动，`npm run dev` 热更新。

**⑲ 设置页与挂件面板深浅色双端跟随 uTools + `uiMode` 三态偏好**

「设置页面只有暗色、挂件菜单只有亮色」：设置页被 `prefers-color-scheme` 接管，挂件菜单 `floating.css` 有 `html.dark` 规则、`dark` 类却从未挂上。口径收敛成 `uiMode` 三态（`auto|light|dark`，默认 `auto` = 修复后行为，老配置零迁移）：

- **设置页**：删 `prefers-color-scheme` 媒体查询，深色令牌全搬进 `main.css` 的 `html.dark`（跟 `utools.isDarkColors()`，不跟系统：「系统暗 + uTools 亮」会恒暗）；App.vue 启动即应用 + 1s 轮询（无主题变更事件），`onUnmounted` 清定时器。
- **挂件面板**：`floating.js`（preload）1s 轮询 `isDarkColors()` 后 `emit('dark', …)` 本地推给页面（不经主窗、非 `whale:` IPC）；页面 `onDark` 回调 + 启动 `whale.isDark()` 补初值（preload 首条推送早于回调注册），挂 `<html>` 的 `dark` 类，消费端是 `floating.css` 既有的 `html.dark` 区块。
- **`uiMode` 三态落地**：`store.js` 新增 `normUiMode`（非法值回 `auto`，不就近猜测，导出给单测），`defaultConfig` / `readConfig` / `writeConfig` / `patchConfig` 四处接入；`floating-page.js` 持 `uiMode` 副本 + `utoolsDark` 缓存，`applyDark()` 合成生效值，`applyConfig` 收到变更立即重合成，`saveCfg()` 原样带回 `uiMode`（整份白名单铁律，漏带 = 用 `undefined` 抹掉选择，`notifyMailOn` 同款坑）；「外观」卡新增「界面深浅色」下拉，`onUiModeChange` 先本地应用再落库；`services.d.ts` 补类型。
- **刻意不做**：挂件菜单不加切换行（7 行已满、极低频，负收益）；不加 CSS transition（全局过渡会让部分元素过渡、部分瞬变）；`uiMode` 与气泡配色 `theme` 是两条线，气泡四色不得在 `html.dark` 覆写（check-shared 钉住）。
- **同轮顺带**：dsh 插件市场宿主兼容性拦截（`dsh-market.js` / `store.js` / `constants.js`），见 §十。
- **踩坑（真机白屏）**：`applyUtoolsDark()` 最初在 `cfg` 声明前调用，函数体读 `cfg.uiMode` → TDZ `ReferenceError`，整个 `<script setup>` 崩、设置页白屏（宿主无日志）。修复：启动调用与轮询定时器挪到 `cfg` 声明之后；悬浮页无此险：`uiMode` 是 `var`（声明提升）。
- 涉及 preload / floating-*，需重载插件后生效。

**⑳ 首帧深浅色预涂：消灭「打开插件隔一会才变」**

「打开插件后深浅色要隔一会才变」，两处叠加：

- **设置页裸开闪浅**：`index.html` 无深浅处理，dark 类要等 bundle 解析、`applyUtoolsDark()` 跑完才挂。
- **手动模式拖到轮询**：启动首次 `applyUtoolsDark()` 读 App.vue 本地默认 `uiMode: 'auto'`（真实值要等 `applyConfig` 回填），且回填后不重应用——手动 light/dark 要拖到下一轮轮询才变对。

修复：

- **`index.html` 内联首帧预涂脚本**（`<head>` 内、同步跑在 bundle 之前）：读 `utools.dbStorage.getItem('whale:config')` 取 `uiMode`，合成口径与 `normUiMode` / `applyUtoolsDark` 一致（非法回 auto；auto 再看 `isDarkColors()`），深色即挂 `<html>` 的 dark 类。挂件页无此问题：`floating-page.js` 启动即调 `whale.isDark()` + `applyDark()`，preload 的 `pushDark()` 也在页面脚本前发过首条。
- **`applyConfig` 回填 `uiMode` 后立即 `applyUtoolsDark()`**：补「存储真实值到达」与「挂件菜单改 uiMode 经配置推送」两条路径。
- **check-shared 新钉「配置存储键 K.config」**：预涂脚本拿不到 constants，键名只能裸字面量；`K.config` 改名会让预涂静默读空（不报错但首帧主题错），故进门禁。constants 侧就地抠 `config: '...'`（K 是冒号形态，`jsString` 的 `= '...'` 口径用不上）；index.html 侧抠 `dbStorage.getItem('...')`。
- **刻意不做**：预涂只做 uiMode 三态合成（body 级背景闪烁靠 main.css 的 html.dark 即时生效）；悬浮窗不加同款预涂（无延迟问题）。
- `src/` 与 `index.html` 走 Vite 重建，无 preload 改动。

**㉑ 代码复用收敛：util 扩容 / useFlash 抽取 / 柱状图与用量卡共用 UsageChart**

只记影响归属与对外口径的结论：

- **柱状图 CSS 上提 `main.css` 作唯一来源（推翻第五批的组件内 scoped 方案）**：`.chart-wrap`（含 `--day-row` 定义）/ `.chart-axis` / `.axis-label` / `.chart-plot` / `.grid-line` / `.chart` / `.bar-col` / `.bar-val` / `.bar-track` / `.bar` / `.bar-day` / `.chart-dense` / `.chart-ultra` 整段移入 `src/main.css` 的「柱状趋势图」节。原方案在 `UsageChart.vue` / `UsageView.vue` 各留一份逐字副本，更早在 `App.vue` scoped 里因哈希不匹配整段静默失效（柱子不出图的根因）。`main.css` 无 `data-v-`，不受 scoped 限制。
  - **`.m-*`（模型用量排行榜）与 `.range-tab*` 仍留在 `UsageChart.vue` 的 scoped 块**：纯布局（grid 列宽 / `flex: 1 1 0` 等分），非跨卡共用的「长什么样」。**判据同第七批豁免白名单：只上提「跨组件逐字重复的尺寸/配色」，布局随渲染它的组件走。**
- **`.chart-axis` 宽度自适应**：原 `flex: 0 0 34px` 对 token 缩写（`3.2K`）够用，用量卡纵轴刻度是金额（`¥ 1234.00`），写死会让 `nowrap` 刻度自右向左溢出压柱。改为 `flex: 0 0 auto; min-width: 34px`。
- **纵轴刻度与柱顶统一走 `valText`**：`gridLines` 的 `label` 原写死 `fmtTokens`，柱顶走可覆写的 `valText`（父卡经 `valFmt` 传金额格式化），否则会出现「纵轴 token 缩写、柱顶金额」；现改走 `valText(dayMax * f)`。
- **`UsageChart` 新增 props 承接用量卡**：`ultraThreshold`（「超密」档阈值，卡片默认 30、用量卡传 90——原「两份样式」的唯一实质理由）/ `valFmt`（柱值与纵轴刻度格式化，缺省 `fmtTokens`）/ `emptyText` / `showModels` / `showRangeTabs`（用量卡自带账本明细与档位，传 `false`）。**dsh 用量统计卡与 Codex 会话统计卡均不传，走默认值 = 原行为**。
- **`util.js` 扩容四个纯函数**：`errMsg(err, fallback)` / `sha256(buf)`（字节版）/ `stamp(ts, precision)`（`'min'` 默认 / `'sec'` / `'day'`）/ `hhmm(ts)`，全仓替换内联副本并补单测。**`dsh-backup.js` 的 `sha256` 保留文本版语义**（内部 `Buffer.from(String(text))` 后调字节版）。`pricing.js` 的 `p2` 与 `store.js` 的 `todayKey` **刻意不改**：语义与 `stamp` 不同。
- **`src/composables/useFlash.ts` 抽取**：统一各 view 的「瞬时提示」状态（`useFlash` / `msgCls` / `useFlashShow`），替换各处内联副本。
- 涉及 `public/preload/lib/util.js` 及全仓引用，需重载插件。

**㉑·P1 设置页跨卡片工具函数收编 `src/utils/format.ts`**

P0（上段）收敛宿主侧 `util.js` 与渲染侧样式；P1 收敛**设置页各卡片之间**逐字重复的纯函数：原先散在 `App.vue` / `AssetsView.vue` / `CodexView.vue` / `UsageView.vue` / `useDsh.ts`，改一处漏一处就漂移（柱状图 min 已分叉成 2/2/3）。**新建 `src/utils/format.ts`**，收入五个无响应式依赖的纯函数：`fmtBytes(n)` / `assetSize(m)` / `sharedSkinThumb(id)` / `fetchAsDataUrl(url)` / `barHeightOf(days, tokens, min = 2)`。

- **A1 `fmtBytes` + `assetSize`**：App.vue 与 AssetsView.vue 各删本地实现改引用。`assetSize` 签名取 **`{ size?: number } | null | undefined` 超集**（App 原 `| null`、AssetsView 原 `| null | undefined`）。
- **A2 `sharedSkinThumb`**：App / AssetsView 两处本地副本收编。**`skinPackThumb`（`./whale-pack/thumbs/<id>.webp`）路径不同，保留在 AssetsView 本地**，二者不可混并。
- **A4 `fetchAsDataUrl(url)`**：把「fetch → arrayBuffer → base64 data URL」（App 的 `sharedSkinThumbDataUrl`、AssetsView 的 `skinPackThumbDataUrl` 逐字相同的 try/catch 体）收成一处。两调用方各留 `return fetchAsDataUrl(<自己的缩略图路径>)`，路径仍归各自卡片（`resources/thumbs/` vs `whale-pack/thumbs/`）。
- **A3 `barHeightOf(days, tokens, min)`**：**四处**「柱高 / 占比条百分比」收编：CodexView 的 `codexBarHeight`、useDsh 的 `dshUsageBarHeight` 传 `min = 2`，UsageView 的 `barHeight` 与 **UsageChart 的 `modelBarWidth`（模型占比条）** 传 `min = 3`。**差异参数化**：金额与占比更小更易被压没，多留 1%。UsageChart 原先独占的 `modelMax` computed 收编后删除。**注意**：A3 曾漏掉 `UsageChart.vue` 组件内这处。
- **B2 `pad2` 收编**：原先三份「两位补零」——`AssetsView.vue` 的 `pad2`（`n < 10 ? '0'+n : ''+n`）与 `App.vue` / `ModelsView.vue` 的 `p2`（`String(n).padStart(2,'0')`）——**同物异名**，非负整数下等价，统一收进 `utils/format.ts` 作 `pad2`，三处定义删除、六处调用改引用；`App.vue` 内 `lastTestText` 与 `hhmm` 各自的 `const p2` 一并消除。**未收编**：各 view 的日期格式函数（`assetAt` / `resetSuffix` / `hhmm`）格式串各异，合并需传 format 参数，收益低。
- 仅 `src/` 改动，无需重载插件。

---
