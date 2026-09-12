# 小鲸鱼余额挂件 · 开发与维护规格（uTools 版）

> 用途：汇总本 uTools 插件的完整架构、行为规格、视觉/几何参数、IPC 契约、存储结构与踩坑结论，供复现、维护与二次开发。
> 用户向文档见根目录 [README.md](../README.md)。视觉原型来自 DSH 版 [`whale-widget-prompt.md`](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget)，本文件只描述 **uTools 版的差异与落地实现**。

---

## 一、需求总览

uTools 插件：呼出后在桌面创建一个**透明、无边框、置顶**的独立小窗，常驻显示「小鲸鱼 + DeepSeek 余额 + 今日已用」。

- 鲸鱼 cut-out 本体（`public/whale/DSniang1.png`）+ 代码绘制的白色对话气泡（SVG），气泡内三行文字。
- 余额：`GET https://api.deepseek.com/user/balance`，`Authorization: Bearer <apiKey>`；从 `balance_infos` 智能选币种（优先 CNY 且 >0 → 任意 >0 → CNY → 第一项）。
- 今日已用双模式：
  - **小鲸鱼记账（默认，免令牌）**：余额差值本地记账（uTools `dbStorage`），跨天归档保留 30 天，切换币种只重置基准。
  - **实时·令牌**：用平台网页令牌调 `usage/by_api_key/amount`，按峰谷定价表换算；失败自动回落记账。
- 交互：拖拽 + 四边四分之一吸附（四角可组合）+ 自由位、贴左镜像、按压 Q 弹 + 双段音效、汉堡菜单（大小/音效开关/音色/音量/用量/峰谷文案/气泡/峰谷提醒/报时/计时/锁定/置顶）、数字滚动、60s 自动刷新 + 点击手动刷新、随机台词 + rua.gif、透明区点击穿透。
- 计时 / 定时 / 倒计时：结果在思考气泡内显示并每秒刷新；到点响提示音（沿用音效开关与音量）并在气泡里显示「时间到！」。
- 任务栏避让（默认开，可关）：实时识别任务栏隐藏/显示 —— 自动隐藏且收起时挂件贴满边，任务栏一弹出就自动按锚点上移让位、收起后贴回；另有「贴边间距」（上/右/下/左，px，0＝紧贴）可自定义（详见第四节）。
- 开发者附带：**DeepSeek Harness（dsh）** 启停/重启/更新/版本来源/日志与缓存清理（挂件菜单折叠组 + 设置页卡片）；**备份与恢复**（挂件设置/账本/窗口位置/计时，凭据可选加密导出、导入按项同名覆盖）。
- **不含**「每轮对话消耗统计」（该功能依赖 DSH 本机会话事件，uTools 无对应数据源）。

---

## 二、架构（务必先读）

与 DSH 版（注入宿主网页 + webServer 路由）完全不同：uTools 没有宿主页面可注入，改为**双窗口 + 双 preload**。

```
┌──────────────────────────────┐        ┌────────────────────────────────┐
│ 主窗口  index.html (Vue 3)    │        │ 悬浮窗  floating.html（原生JS） │
│ 设置页                        │        │ 挂件本体（展示 + 指针交互）      │
│   window.services ◄───────────┤        │       window.whale ◄────────────┤ preload
└───────────┬──────────────────┘        └───────────────┬────────────────┘
            │ preload/services.js（装配入口）             │ preload/floating.js
            │  └ preload/lib/*.js（按职责拆分）           │  · ipcRenderer.on
            │  · createBrowserWindow                    │  · utools.sendToParent
            │  · 余额/账本/定价/窗口几何                  │
            │  · ipcRenderer.on 收子窗                    │
            └─────────────────── 主窗 ↔ 悬浮窗 IPC ──────┘
```

- **主窗 preload 入口**：`public/preload/services.js`，CommonJS，只做装配（注入 `window.services`、`registerIpc()`、注册生命周期），实现按职责拆分在 `public/preload/lib/`：

  | 文件 | 职责 |
  |---|---|
  | `lib/constants.js` | 常量、定价表、存储键；`PLUGIN_VERSION` 由 `scripts/sync-version.mjs` 构建前写入 |
  | `lib/log.js` | `DEV = utools.isDev()` 门控的 `log/logErr` |
  | `lib/pricing.js` | 峰谷判定与价格换算 |
  | `lib/store.js` | 配置/密钥/账本/窗口锚点持久化 |
  | `lib/api.js` | 余额、平台用量、更新检查与缓存 |
  | `lib/dsh.js` | DeepSeek Harness（dsh）：启停/重启/更新、版本探测与来源（**全局优先**，其次插件目录）、安装提权、日志与 npx 缓存清理 |
  | `lib/backup.js` | 备份导出（凭据可选 scrypt + AES-256-GCM 加密）、导入预览、按项同名覆盖恢复 |
  | `lib/widget.js` | 悬浮窗创建/销毁/几何/缩放/**任务栏显隐跟随**/推送 |
  | `lib/ipc.js` | 悬浮窗 ↔ 宿主 IPC 路由 |
  | `lib/settings.js` | 对外 `window.services` |

  依赖单向：`constants → log → pricing → store → api → widget → ipc → settings`；`dsh` / `backup` 为叶子模块（各自只依赖 constants/log/store），仅被 `ipc` / `settings` 引用，无循环。
- **悬浮窗 preload**：`public/preload/floating.js`，CommonJS，薄桥接层。经 `createBrowserWindow` 的 `webPreferences.preload` 指定（相对路径），对页面暴露 `window.whale`。
- **悬浮窗页面**：`public/floating.html`（12 行薄壳，只挂载 `floating.css` 与 `floating-page.js`）+ `public/floating.css` + `public/floating-page.js`（IIFE 原生 JS，不参与 Vite 打包，直接读磁盘），只负责展示与指针交互，**不持有密钥、不发网络请求**。
- 设置页 `src/App.vue` 走 Vite 打包；`public/` 下文件（含子目录）原样复制到 `dist/`。
- `public/preload/package.json` = `{"type":"commonjs"}`：项目根为 ESM，此文件保证 `preload/` 及 `preload/lib/` 下的 `.js` 一律按 CommonJS 解析。

> preload 遵循 uTools 规范：CommonJS、可 `require('electron')`、**不得压缩/混淆/打包**；因此拆分的 `lib/*.js` 必须以 `require('./xxx')` 方式在包内相对引用。

---

## 三、uTools 关键 API 约定（踩坑结论，先看）

1. **`createBrowserWindow(url, options)` 的 `url` 必须是插件包内 html 的相对路径**（如 `'floating.html'`）。传 dev-server 的 `http://localhost:...` 会被判「html 文件不存在」。dev 模式插件根目录 = `public/`，打包 = `dist/`。
2. **`webPreferences.preload` 也必须是相对路径**（如 `'preload/floating.js'`），传绝对路径会导致子窗 preload 不加载（`window.whale` 缺失）。
3. **主窗 → 悬浮窗只能 `win.webContents.send(channel, ...)`**；**悬浮窗 → 主窗只能 `utools.sendToParent(channel, ...)`**；接收统一 `ipcRenderer.on(channel, ...)`。不要用 `ipcRenderer.sendTo`（uTools 定制窗口上无效）。
4. 返回的窗口**不支持 BrowserWindow/webContents 实例事件**（`win.on('closed')`、`webContents.on('did-finish-load')` 等不触发）；页面加载完成用 `createBrowserWindow` 的第三参 `callback`。
5. 透明窗关键选项：`transparent:true`、`backgroundColor:'#00000000'`、`frame:false`、`thickFrame:false`、`hasShadow:false`、`roundedCorners:false`、`skipTaskbar:true`、`enableLargerThanScreen:true`；置顶 `alwaysOnTop`（类型里也有拼写 `alwayOnTop`，两个都给）+ `win.setAlwaysOnTop(true,'screen-saver')`。
6. **Windows 下渲染进程直接 setBounds/移动透明窗会异常**：窗口移动/尺寸统一由主窗 preload 用 `win.setPosition/setSize` 完成，悬浮窗只上报目标坐标。
7. 透明区点击穿透：`win.setIgnoreMouseEvents(ignore, { forward:true })`，配合页面侧 `document.elementFromPoint` + 鲸鱼像素 alpha 命中测试，动态开关。
8. preload 改动不热更，需在 uTools 开发者工具里**重新加载插件**；子窗 devtools：焦点在挂件窗口上按 `Ctrl+Shift+I`。
9. 动态插件无法开机自启；改为「呼出指令即创建」，创建后独立窗口常驻。
10. **自定义快捷键**：uTools 没有「插件内注册任意快捷键」的 API。做法是在 `plugin.json` 的 `features` 新增一条功能（`code:"whale-toggle"`，配 `mainHide:true` 使其触发时不弹出搜索框），用户在「设置 → 全局功能」为该指令绑定全局快捷键；触发时 `onPluginEnter` 收到 `action.code === 'whale-toggle'`（新版另有 `action.from === 'hotkey'`），据此调用 `toggleWidget()` 显隐挂件。因 `utools.redirectHotKeySetting` 每次调用都会新增一条待绑定项、无「只跳转不新增」的接口，设置页提供两条路径：①「复制指令名」（`utools.copyText('显示/隐藏挂件')`）+ 文字步骤（`Ctrl+,` → 全局功能 → 新增 → 指令填「显示/隐藏挂件」），用于首次手动绑定、不会新增多余项；②「新增快捷键」调用 `redirectHotKeySetting('显示/隐藏挂件')` 直接跳转并新增待绑定项，用于绑定被删除后重新添加。
11. **调试日志统一走门控函数**：主窗统一用 `lib/log.js` 的 `DEV = utools.isDev()` 与 `log()/logErr()`，仅开发者模式输出；悬浮窗 `floating-page.js` 通过 `window.whale.dev`（preload 透传）判断。不要再直接写 `console.log/error`。
    - **dev 下同步落盘**：`lib/log.js` 除控制台外，用 `appendFileSync` 同步追加到 `%TEMP%\whale-debug.log`（`utools.getPath('temp')`，进程随时被 uTools 结束也不丢）。主窗 `services.js`、悬浮窗 `floating.js` 均接入同一份日志，并各自打印 `utools.getWindowType()`，用于事后复盘「挂件消失」这类生命周期问题（控制台随进程一起丢失，无法取证）。设置页提供「复制诊断日志」(`getDebugLog()`) 与「打开日志文件」(`openLogFile()`)。
12. **空 `catch` 分两类**：预期分支（Electron 可选 API 不存在、窗口已销毁、读存储失败回默认值）保留空 catch 静默降级；业务失败（网络、写存储、IPC、窗口创建、音效与命中测试初始化）一律 `logErr(...)` 留痕。唯一例外：页面检测不到宿主桥接的 `console.warn` 常显，保证生产环境也有线索。
13. **`onPluginOut(isKill)` 语义**：挂件是常驻桌面的独立窗口，**任何时候都不在 `onPluginOut` 里 `destroyWidget()`**。曾按「`isKill===true` 才销毁」实现，结果**关闭已分离的设置窗口**（同样触发 `onPluginOut`）会把挂件一起关掉。进程真正结束时 uTools 会自行关闭本插件 `createBrowserWindow` 创建的窗口，无需我们销毁；窗口若被 uTools 关闭/隐藏，`winAlive()` 会判为失效或不可见，下一次 `ensureWidget()` 自动重建。`onPluginOut` 只保留一条 dev 日志（打印 `isKill`）。见 `services.js` 底部。
14. **`enterMode`（进入插件时显示哪些窗口）**：`both`（默认，设置窗 + 挂件）/ `widget`（显示挂件，设置窗自动收起）/ `settings`（只显示设置窗口）。显隐分两层，改由 `onPluginEnter` 的 whale 分支按需编排：
    - **主窗自不自动弹出**：`whale` feature 在 `plugin.json` 设 `mainHide:true`；它只阻止 uTools「自动弹出主搜索框」，对已显示 / 已分离的主窗无效。
    - **挂件是否夺焦**：`createWidget(focusable)` 按模式决定（`focusable` 只能在创建时指定）；`ensureWidget({ focus })` 检测到与现有窗口不一致时销毁重建。
    - `settings`：显式 `utools.showMainWindow()`，全程不创建挂件；
    - `widget`：`ensureWidget({ focus: true })` —— 挂件窗口 `focusable:true`，一显示就抢走前台焦点，uTools 主窗随即失焦并按**原生行为自动隐藏**；不使用任何隐藏窗口的 API；
    - `both`：`ensureWidget({ focus: false })`（挂件不夺焦，主窗焦点不被抢走）后 250ms `utools.showMainWindow()`，使挂件与设置窗同时可见。
    - **踩坑（已废弃的两种抑制主窗方案）**：① `utools.outPlugin()` 会把插件「退出到后台」，之后挂件菜单的「打开设置」(`showMainWindow`) 唤不回主窗，而 `enterMode` 仍是 `widget`，导致「再也进不去设置界面」；② `utools.hideMainWindow()` 会连带隐藏 `createBrowserWindow` 的窗口，且在 `onPluginEnter` 中先调会让随后的窗口创建与 `setTimeout` 回调不再执行（表现为点插件后挂件完全不出现）。抑制主窗只能靠 `feature.mainHide` + 「夺焦 → 失焦自动隐藏」。
    - `ensureWidget(opts)` 幂等：无存活窗口则创建；已有窗口且 `focusable` 与期望一致则 focus 模式 `show()` 夺焦、否则仅 `applyOnTop`/`moveTop`；`focusable` 与期望不一致则销毁重建。不传 `opts.focus` 时沿用当前窗口的 `focusable`（供 `toggleWidget` 等内部调用）。
    - `widget` 模式下主窗唯一入口：挂件菜单底部的「打开设置」→ `whale:open-settings` → 先 `utools.showMainWindow()`；返回 `false`（主窗已被 uTools 收起，如挂件夺焦后插件退到后台）时再 `utools.redirect('余额挂件', '')` 重新「进入插件」——`onPluginEnter` 检测到 `action.from === 'redirect'`（官方类型定义写作 `reirect`，疑为文档笔误，两种拼写都兼容）后显式 `utools.showMainWindow()` 唤回主窗并直接 `return`，不触碰挂件。
    - **feature 合并（v1.0.0 起）**：原 `whale-settings` feature 已删除，搜索面板只剩 `whale` / `whale-toggle` 两条。为满足 uTools「每个功能的 cmds 建议 ≤ 5 个」，**未**把「小鲸鱼设置 / 余额挂件设置」并入 `whale.cmds`（沿用原 5 个：余额挂件 / 小鲸鱼 / 小鲸鱼余额 / DeepSeek余额 / whale）。因此设置页入口只剩：`enterMode = settings/both`，或挂件菜单的 redirect 兜底（`widget` 模式下）。`whale`、`whale-toggle` 均设 `mainHide:true`；redirect 分支是本插件唯一的「无 mainHide 自动弹主窗」替代，故必须实测其在 `widget` 模式下的唤回效果。

15. **Windows 下显示器 `workArea` 不随任务栏显隐刷新**：`getPrimaryDisplay()/getDisplayNearestPoint()` 的 `workArea` 只反映**进程启动时**的状态（Electron 已知行为，`display-metrics-changed` 也不响应任务栏显隐，见 [electron#6312](https://github.com/electron/electron/issues/6312)）。所以「自动隐藏的任务栏此刻是弹出还是收起」不能用 workArea 判断，只能看**光标**：`utools.getCursorScreenPoint()`（实时接口）—— 光标压到它那条边 3px 内 → 弹出；落在该边「厚度」条带内 → 维持；离开条带超过 400ms → 收起。方向/厚度仍读注册表 `StuckRects3`（缓存 60s）。workArea 只用于**启动时**区分「常显任务栏（有内缩 → 系统已排除）」与「自动隐藏 / 无任务栏」。详见第四节。

---

## 四、窗口几何模型（重点）

- 窗口是正方形，边长 = **挂件本体基准尺寸 + `WIN_PAD`(=200px) 透明留白**。留白用于让汉堡菜单在按钮**上方**展开时不被窗口边缘裁切。
- 挂件本体在窗口内**右下对齐**：挂件左上角 = 窗口左上角 + (WIN_PAD, WIN_PAD)。
- 页面 CSS：`.dshwv-root` 为 `100vw - var(--whale-pad)`（200px）见方、`right:0;bottom:0`；`--whale-pad` 必须与 `lib/constants.js` 的 `WIN_PAD` 一致。
- **所有定位/吸附/缩放/钳制都以「挂件本体矩形」为准**，透明留白允许越出屏幕（`enableLargerThanScreen`）。换算辅助：`widgetOrigin(winX,winY)` / `winOrigin(wx,wy)`、`clampWidget(wa,wx,wy,s)`。
- **可用区 `usableArea(x,y)`**：所有定位/吸附/缩放统一用它代替裸 workArea —— ① 取系统 workArea（任务栏**常显**时已被系统排除）；② 若「自动避让任务栏」开着，且主屏任务栏是**自动隐藏 + 此刻正弹出**（见下条），就把它那条边内缩注册表厚度；③ 再按配置 `edgeTop/edgeRight/edgeBottom/edgeLeft`（「贴边间距」，0–400px，0＝紧贴该边）四边各自内缩。收起时不让位，挂件可以贴满边。
- **任务栏状态识别 + 动态让位**：**不能**用 workArea 判显隐 —— Windows 上 Electron/uTools 的 workArea 不随任务栏显隐刷新，只反映进程启动时的状态（`display-metrics-changed` 也不响应任务栏变化，见 electron#6312），所以只在**启动时**用它区分「常显（有内缩 → 已由系统排除）」与「自动隐藏 / 无任务栏（内缩为 0）」；后者读注册表 `HKCU\...\StuckRects3\Settings`（`byte[8] & 0x03` → 0 左 / 1 上 / 2 右 / 3 下，`[24..39]` 是任务栏矩形，厚度 ÷ `scaleFactor` 换算成 DIP）拿到方向与厚度。**「此刻是否弹出」看光标**（`utools.getCursorScreenPoint()`，实时）：Windows 只在光标压到屏幕那条边（触发区取边上 3px）时把任务栏拉出来，拉出后光标落在它的矩形里（条带 = 该边 thickness 内）、光标一离开就缩回去 —— 于是：压边 → 弹出；在条带内 → 维持；离开条带超过 `TB_HOLD`(400ms) → 收起。`syncTaskbarWatch()`（挂件存在且 `avoidTaskbar` 开启）每 250ms 采样「显示器 id + bounds + workArea + 任务栏边 + popped」指纹，变化就 `clearLiveScaleCtx()` + `repositionFromAnchor()` 按锚点重摆（顺带覆盖分辨率/缩放/换屏）；窗口位置刚变过（用户正在拖拽/缩放）的那一帧不抢位置。设置页每 2s 通过 `getTaskbarState()` 显示识别结果。注册表结果缓存 60s。改开关或任一间距都会调 `repositionFromAnchor()` 立即重摆。
- 基准尺寸：`base = clamp(122, min(250, min(workW,workH)*0.28) * scale, 625)`，scale∈[0.6,2.5]（菜单 1–20 线性映射，默认 1.5=10）。窗口边长 = base + 200。
- **吸附**（松手，`snapRect`）：挂件中心点在所在显示器 workArea 的横/纵 1/4 区 → 贴左/右、上/下（净距离 0）；中间区为自由位，记录离最近边净距离。横纵独立 → 四角可组合。多显示器按挂件中心 `getDisplayNearestPoint` 选屏。
- **缩放**（`applyScaleToWindow`）：以鲸鱼角为不动点——贴左保持挂件左缘、否则右缘；贴上保持上缘、否则下缘——重算 `setSize+setPosition`，并更新锚点净距离。
- 贴左吸附（`hAnchor==='left' && hDist===0`）→ `flipped=true`，子窗根元素加 `.dshwv-left`（`scaleX(-1)`），文字/gif 单独反向镜像保持可读。

---

## 五、IPC 通道契约

| 方向 | 通道 | payload | 说明 |
|---|---|---|---|
| 子→父 | `whale:ready` | — | 悬浮窗 DOM/preload 就绪，请求初始数据 |
| 子→父 | `whale:refresh` | `{manual?:boolean}` | 请求余额（25s 缓存 + in-flight 去重） |
| 子→父 | `whale:config` | config patch | 改大小/音效开关/音色/音量/用量/峰谷/气泡/报时/置顶/避让任务栏与贴边间距 |
| 子→父 | `whale:drag-move` | `{x,y}`（目标窗口左上角，屏幕 DIP） | 拖拽中，主窗 clamp 后 setPosition |
| 子→父 | `whale:drag-end` | — | 松手，主窗吸附 + 回推 snapped |
| 子→父 | `whale:ignore-mouse` | `{ignore:boolean}` | 点击穿透开关 |
| 子→父 | `whale:open-settings` | — | 挂件菜单请求唤出 uTools 主窗（`utools.showMainWindow()`），「只显示挂件」模式下的设置入口 |
| 子→父 | `whale:timer` | 计时状态对象，或 `null`（清除） | 计时开始 / 停止 / 到点时落库，宿主重建挂件后回推恢复 |
| 子→父 | `whale:timer-done` | `{text}` | 计时到点：宿主 `utools.showNotification(text, 'whale')`；是否通知由页面按 `timerNotifyOn` 判断 |
| 子→父 | `whale:dsh` | `{action:'status'\|'start'\|'stop'\|'restart'\|'update'\|'versions'\|'open'}` | dsh 控制：宿主先探测 3080（识别外部终端里跑的 dsh）再执行，结果用同通道回推 |
| 父→子 | `whale:init` | `{config, anchor:{hAnchor,vAnchor,flipped}, balance, timer}` | 初始化；`timer` 仅在 `timerPersistOn` 开启时有值 |
| 父→子 | `whale:balance` | 余额 payload（见下） | 余额/今日已用结果 |
| 父→子 | `whale:config` | 完整 config | 设置页/菜单改动广播 |
| 父→子 | `whale:snapped` | `{hAnchor,vAnchor,flipped}` | 吸附结果（驱动镜像） |
| 父→子 | `whale:dsh` | dsh 状态快照 | 运行中/pid/就绪/版本与来源（`source: global\|plugin`）/日志/错误 |

余额 payload：成功 `{ok:true,totalBalance,currency,updatedAt,todayUsage,isPeak,usageMode:'ledger'|'token'}`；失败 `{ok:false,code:'NO_KEY'|'BAD_KEY'|'AUTH'|'HTTP'|'PARSE'|'SHAPE'|'ERROR',error,transient?}`。

---

## 六、存储结构（uTools）

| 介质 | 键 | 内容 |
|---|---|---|
| `dbCryptoStorage`（加密） | `whale:secrets` | `{apiKey, platformToken}`，写入前 `sanitizeKey` 剔除空白 |
| `dbStorage` | `whale:config` | `{scale,vol,soundOn,soundSet,usageMode,peakMode,peakRemindOn,bubbleOn,menuBtn,onTop,lowAlertOn,lowAlertAmount,timeBubbleOn,updateCheckOn,dragLock,enterMode,timerNotifyOn,timerPersistOn,timerMode,timerMin,timerAt,timerRemindSec,timerBubblePin,timerBubbleOnly,dshNodeDir,dshKeepAlive,dshRegistry,dshVersion,dshReinstall,dshNoOpen,avoidTaskbar,edgeTop,edgeRight,edgeBottom,edgeLeft,updatedAt}` |
| `dbStorage` | `whale:ledger` | `{date,lastBalance,lastCurrency,todayUsage,history:{YYYY-MM-DD:金额}}`（history 留 30 天） |
| `dbStorage` | `whale:timer` | `{mode,running,paused,startAt,endAt,elapsed,remain,arg}` 计时状态（`timerPersistOn` 开启时才有；关掉开关或清除「挂件设置」时删除） |
| `dbStorage` | `whale:window` | `{hAnchor,hDist,vAnchor,vDist}` 净距离锚点 |
| `dbStorage` | `whale:update` | 上次检查更新结果缓存 `{at,latest,hasUpdate,...}`（TTL 12h） |
| `dbStorage` | `whale:dshVersions` | dsh 可用版本列表缓存（`npm view` 结果，重载插件后仍可选；清除「窗口位置与更新缓存」时一并删除） |

默认 config：`{scale:1.5, vol:0.9, soundOn:true, soundSet:'duck', usageMode:'ledger', peakMode:'default', peakRemindOn:true, bubbleOn:true, menuBtn:true, onTop:true, lowAlertOn:true, lowAlertAmount:10, timeBubbleOn:true, updateCheckOn:true, dragLock:false, enterMode:'both', timerNotifyOn:true, timerPersistOn:true, timerMode:'off', timerMin:25, timerAt:'07:30', timerRemindSec:8, timerBubblePin:true, timerBubbleOnly:true, dshNodeDir:'', dshKeepAlive:false, dshRegistry:'', dshVersion:'', dshReinstall:false, dshNoOpen:true, avoidTaskbar:true, edgeTop:0, edgeRight:0, edgeBottom:0, edgeLeft:0}`（`dshVersion:''` = 自动取 latest；`edge*` 单位 px，0＝紧贴）。

---

## 七、网络与计费

**余额**（`fetchBalanceWith`）：超时 20s（`AbortSignal.timeout`）；网络错/超时/5xx 间隔 500ms 重试 1 次，4xx 不重试；401 读取 DeepSeek 返回的 `error.message` 给出中文指引；`transient` 失败且有缓存时回退 stale。25s 缓存 + in-flight 去重；手动刷新（`whale:refresh {manual:true}`）跳过缓存（请求进行中仍复用同一 Promise）。

**记账**（`recordLedgerUsage`）：每次成功余额观测后执行；同日余额下降累加差值，上升（充值）不扣；币种变化只重置基准；跨天归档并归零。

**实时令牌**（`fetchPlatformUsage` + `computeTodayUsage`）：
- URL `https://platform.deepseek.com/api/v0/usage/by_api_key/amount?start=<本地零点unix>&end=<+86400>&tz=<偏移秒>`，`Bearer <token>`（自动去 `Bearer ` 前缀），15s 超时。
- 解析 `data.biz_data.series[]`（兼容 `data.series`），每 series `{model,buckets:[{time,usage:{RESPONSE_TOKEN,PROMPT_CACHE_HIT_TOKEN,PROMPT_CACHE_MISS_TOKEN}}]}`；接口只给 token 不给金额。
- 峰谷：北京时间工作日 9–12、14–18 为峰；`WEEKEND_VALLEY_FROM_SEC`（=北京 2026-08-23 00:00）起周末全天谷价。
- 成功后 `setTodayUsage(amount)` 把平台今日总量写入账本 `todayUsage`：趋势图 / 导出 / 今日已用都取账本，不写会导致设置页与挂件显示不一致（记账累计值 ≠ 平台今日总量）。

**定价表**（每百万 token，CNY，谷/峰）：

| 模型 | 缓存命中 | 缓存未命中 | 输出 |
|---|---|---|---|
| deepseek-chat / reasoner / v4-flash（含 flash-vision） | 0.05 / 0.1 | 1.5 / 3.0 | 4.5 / 9.0 |
| deepseek-v4-pro | 0.15 / 0.3 | 4.5 / 9.0 | 13.5 / 27.0 |

模型名按子串匹配（`lib/pricing.js` 的 `priceFor`），未知走 `_default`（基础价）。DeepSeek 调价改 `lib/constants.js` 的 `PEAK_HOURS/PRICING`。

---

## 八、悬浮窗页面（floating.css + floating-page.js）

`floating.html` 只是 12 行薄壳（`<link>` 引 `floating.css`、`<script src>` 引 `floating-page.js`）。脚本为 IIFE + 幂等守卫 `window.__dshWhaleWidget`。资源相对路径 `./whale/...`。

DOM：`.dshwv-root`（定位/翻转）> `.dshwv-body`（Q 弹缩放）> `img.dshwv-img` + `.dshwv-bubble`（SVG + `.dshwv-gif` + `.dshwv-text` 三行）；`.dshwv-menu-btn` 三点按钮；`.dshwv-menu` 挂 body。

- 命中测试：鲸鱼图画到 610×610 canvas，`getImageData` 读 alpha>10（左镜像时 x 翻转）；据此决定拖拽/穿透/光标。
- 拖拽：pointerdown 在鲸鱼上 → 记录 `screenX/Y` 与 `clientX/Y`；移动按 `目标窗口左上角 = screenX − clientX0`（拖拽中恒定）rAF 节流上报 `drag-move`；位移平方 <9 判点击（=开气泡+刷新），否则松手上报 `drag-end`。**`dragLock` 开启时不累计位移、不上报 `drag-move`、并禁用滚轮缩放**（位置与大小都固定），松手仍按点击处理（刷新气泡），窗口不动。
- 滚轮缩放：指针命中鲸鱼且非菜单内时 `wheel`（`passive:false` + `preventDefault`）按 `deltaY` 符号 ±0.1 改 `curScale`，`setScale(v,false)` 实时预览、停手 260ms 后 `setScale(curScale,true)` 持久化；到达 0.6/2.5 边界不再变更；`dragLock` 开启时直接 return 不缩放。
- Q 弹：body `scaleY(.88) scaleX(1.05)`，origin `50% 100%`，`transform .22s cubic-bezier(.34,1.56,.64,1)`。
- 音效：press=Ya1/D1、release=Ya2/D2；按住松手与短按（press 末尾提前 100ms 接 release）两节奏；vol=0 静音；`new Audio` 失败静默。
- 随机台词六组权重 45/7/7/10/3/1（峰谷三行 / B 卖萌 / A 吐槽换行 / rua.gif / A 大烧货 / B 哦鲸鲸）；点气泡首次切随机、再点关闭；气泡 5s 自动收起；gif 加载失败兜底文字。气泡首行默认**报时**（`timeBubbleOn`，鲸鱼娘语气按时段变化，如「都 02:30 了，还不睡吗…」），关闭后显示「DeepSeek 余额」。
- **气泡自适应**（`fitBubbleText`）：气泡三行字号本为固定值（A/B/P/C），长文案换行后会撑出气泡；`applyBubbleLines` 末尾按 `FIT_W×FIT_H`（560×330u）可用区域测量文本块，超出时把三行字号**等比缩小**（最多到 50%，最多迭代 3 次），正常内容保持原字号（只缩不放）。字号写成行内 `calc(var(--dshw-u) * N)`，因此挂件缩放后无需重新测量；`resetBubbleFont()` 在退出气泡文案（`render` 默认分支、`restoreBubbleLines`）时清掉行内字号。
- 汉堡菜单行：大小 / 音效 / 音量 / 用量 / 峰谷 / 气泡 / **峰谷提醒** / 报时 / **计时**（模式下拉 + 开始/停止）/ **目标**（倒计时分钟数或定时刻，按模式二选一显示）/ **到点通知** / **计时保存** / 锁定 / **dsh（开发者）**（默认收起的折叠组：启动 / 重启 / 结束 / 更新 + 页面 + 状态 + 命令）/ **打开设置**（末行整宽按钮，`whaleApi.openSettings()` → 宿主 `utools.showMainWindow()`）。菜单行数较多时靠 `.dshwv-menu` 的 `max-height:100vh-8px + overflow-y:auto` 在窗口内滚动，不会被窗口边缘裁掉。
- **计时 / 定时 / 倒计时**（`timerMode` = `off|up|down|at`）：
  - 正计时从 0 累加；倒计时取「分钟数」（1–1440，默认 25）换算终点；定时取 `HH:MM`，该时刻今天已过则顺延到明天。
  - 倒计时/定时用「终点时间戳」计时（`timerEndAt`），1s `setInterval` 只负责刷新显示与判断到点，因此窗口被后台节流也不会走时不准。
  - 计时气泡**常驻不自动收起**（`showTimerBubble(0)`），点气泡可收起、计时继续；再点鲸鱼重新显示（`showBubble()` 在 `timerActive()` 时转 `showTimerBubble`）。
  - 到点：`finishTimer()` 响提示音（`playPress()`，走音效开关与音量）→ 按 `timerNotifyOn` 决定是否 `whale:timer-done` 弹系统通知 → 气泡显示「时间到！」→ `BUBBLE_REMIND_MS`（8s）后收起，并在 `hideBubble` 里清掉结束态。
  - 持久化（`timerPersistOn`，默认开）：开始/停止/到点/切模式时 `whale:timer` 上报落库（`whale:timer` 键）；重建挂件时宿主在 `whale:init` 里回推 `timer`，页面 `restoreTimer()` 恢复 —— 正计时按 `startAt` 继续，倒计时/定时按 `endAt` 继续，若挂件不在期间已到点则直接补一次到点流程（提示音 + 通知 + 气泡）。关闭开关后不再落库，宿主同时删除已有记录（`saveConfig`/`whale:config` 两条路径都会 `clearTimer()`）。
  - 优先级：计时气泡 > 峰谷提醒 > 随机台词 > 余额提示；计时进行中 `showPeakRemind` 直接跳过，不打断计时。
- 刷新节奏：`whale:init` 后启动 60s 轮询；`visibilitychange` 隐藏（`win.hide` / 最小化 / 切走虚拟桌面）时 `clearInterval` 暂停，重新可见时先 `timerStep()`（补判计时到点）与 `refresh(false)` 立即拉一次再恢复轮询，避免后台空跑网络请求。

---

## 九、视觉与几何参数（精确值）

| 项 | 值 |
|---|---|
| 鲸鱼本体 | `whale/DSniang1.png` 610×610 cut-out，`.dshwv-img` 右下 `right:0;bottom:0;width:59.45%` |
| 气泡画布 | SVG viewBox `0 0 1026 700`；大椭圆中心(454,247) rx373 ry232；尾巴(301,465)-(413,484)；小气泡1(352,561) rx37.5 ry26；小气泡2(442,646) rx24.5 ry18；描边 `#203170` 宽 18 |
| 文字块 | `left:44.25%;top:38%;translate(-50%,-50%)`，`color:#536ba9` |
| 字号 | `--dshw-u = base/1026`；A=66/600、B=128/800、P=104/800、C=56/`#9fb0d9` |
| 金额格式 | CNY → `¥ ` + toFixed(2)；其他 → `金额 币种` |
| 基准尺寸 | base=clamp(122, min(250, min(w,h)*0.28)*scale, 625)；窗口=base+200；scale 0.6–2.5 |
| 吸附阈值 | 挂件中心在 `usableArea` 各轴 1/4 区 |
| 点击阈值 | 位移平方 < 9（<3px） |
| 翻转动画 | 根 `transform .3s ease`；文字按属性拆分 `opacity .16s .36s, transform .3s` |
| Q 弹 | scaleY(.88) scaleX(1.05)，origin 50% 100%，.22s 回弹 |
| 数字动画 | 700ms ease-out 三次方（rAF）；自动刷新变动延迟 300ms 起滚，900ms 落定 |
| 时长 | 自动刷新 60s（页面隐藏时暂停）；气泡 5s；余额缓存 25s |
| 计时功能 | 1s 刷新（按终点时间戳推进）；计时气泡常驻；到点提示音 + 「时间到！」停留 8s（`BUBBLE_REMIND_MS`） |
| z-index | 挂件 9999，菜单 10000 |

---

## 十、设置页（src/App.vue）

通过 `window.services` 调用：`getConfig/onConfigChange/saveConfig/getSecrets/saveSecrets/testApiKey/testPlatformToken/getUsageHistory/exportUsageCsv/importUsageCsv/showWidget/hideWidget/isWidgetVisible/ensureWidget/getWidgetError/copyText/redirectHotKeySetting`，以及 dsh 系列（`dshStatus/dshStart/dshStop/dshRestart/dshUpdate/dshListVersions/dshOpenWeb/dshClearLog/dshRemovePlugin/dshCleanNpxCache/dshPickNodeDir`）、备份恢复系列（`backupExport/backupPick/backupApply/backupCancel`）与 `getTaskbarState/getDebugLog/openLogFile/clearAllData`。**配置双向同步**：设置页改开关 → `saveConfig` → `pushConfig()` 推给挂件；挂件三点菜单改设置 → `whale:config` → `patchConfig` + `pushConfig()`（挂件）+ `emitConfigChange()`（广播给已打开的设置页，`App.vue` 在 `onMounted` 订阅、`onUnmounted` 退订），避免「挂件菜单勾选与设置窗口开关不同步」。包含 API Key / 平台 Token 录入（加密保存 + 测试连接，分项验证余额接口与用量接口）、大小/音效开关/音色/音量/用量/峰谷文案/气泡/峰谷切换提醒/**计时到点通知**/**记住计时状态**/报时/菜单按钮/置顶/低余额预警开关与阈值、近 7 天用量柱状图 + **导出 CSV**（`exportUsageCsv(days)`：`utools.showSaveDialog` 弹系统保存框，写 UTF-8 BOM 的 `日期,用量,币种` 三列，Excel 可直接打开；用户取消返回 `{ok:false,canceled:true}`）、**导入 CSV**（`importUsageCsv()`：`utools.showOpenDialog` 选 `日期,用量[,币种]` 文件，兼容 BOM/CRLF/表头/`-`、`/`、`.` 日期分隔符；`store.mergeLedgerHistory` 合并进账本 `history`，同日以导入值覆盖、只留最近 30 天；当天行同步写入 `todayUsage`（否则趋势图当天柱会被实时累计值遮蔽），`lastBalance/lastCurrency` 基准不动；返回 `{ok,imported,invalid,kept,from,to}`，成功后设置页刷新趋势图）、显示/隐藏挂件、复制指令名（`copyText('显示/隐藏挂件')`）、新增快捷键（`redirectHotKeySetting('显示/隐藏挂件')`，跳转「全局功能」并新增待绑定项）、挂件错误查看（进入设置页自动 `getWidgetError()` 静默检查：有错误时展开红色标题 + 等宽错误详情 + `copyText` 复制按钮与「重新检查」；无错误时仅显示一行浅色「挂件异常？查看错误详情」链接，点击才提示「当前没有记录到挂件错误」）、数据与隐私（**按项清除**：四个复选框「凭据 / 挂件设置 / 账本用量记录 / 窗口位置与更新缓存」→ `clearAllData({secrets,config,ledger,window})` 只清 `true` 的项，按钮二次确认，已清除项在提示里回显；清到配置或窗口项时宿主按默认配置重建挂件；清凭据后本页输入框同步置空）、近 7 天趋势的刷新时机（`refreshHistory()`：`onMounted`、导入 CSV 后、切换用量模式时、窗口 `focus`/`visibilitychange` 重新可见时——令牌模式的今日总量由挂件刷新时写入账本，不重拉会看不到变化）与错误回显。另在「挂件窗口」卡片末尾有「挂件常驻说明」引导提示，以及「复制诊断日志」(`getDebugLog()` → `copyText` 日志末尾 20000 字符) 与「打开日志文件」(`openLogFile()` → `utools.shellOpenPath`)，用于 uTools 结束进程后仍能取回控制台线索（见第三节第 11、13 条）。

- **「挂件窗口」新增**：「自动避让任务栏」开关 + 「贴边间距」上/右/下/左四个数值（0–400px，0＝紧贴）+ 一行**任务栏实时状态**（每 2s 由 `getTaskbarState()` 同步，显示「正在显示：占底部 30px，挂件已让位」/「已自动收起（底部，厚 30px）：挂件贴满边，弹出时自动让位」/「未识别到任务栏…」）。改开关或任一间距 → `saveConfig` 立即 `repositionFromAnchor()` 重摆。
- **「DeepSeek Harness（dsh）」卡片**（开发者）：注册源 / 版本（默认「自动」＝安装、更新时取 latest，可固定具体版本；先「查询可用版本」再选，下拉里标出**已安装**项）/ Node.js 目录（「选择目录」或「改为自动探测」）/ 启动带 `--no-open` / 更新前重新下载 / uTools 退出后是否保留 dsh；展示插件目录 / 全局安装（只读时标注「更新会弹一次 UAC」）/ 实际使用（含 `source`）/ 最新 / 状态与最近命令 / 页面地址，支持复制地址、查看/复制日志、刷新状态，以及「删除插件目录里的 dsh」「清理 npx 旧缓存」两个维护按钮。
- **「数据与隐私」→「备份与恢复」**：`backupExport`（默认不含凭据；勾选后必须设密码，scrypt + AES-256-GCM 加密后才写入）/ `backupPick`（只解析预览、不写盘）/ `backupApply`（按勾选项**同名覆盖**，账本走 `mergeLedgerHistory`；恢复「设置」或「窗口位置」会重建挂件立即生效）/ `backupCancel`。「清除选中数据」的二次确认会列出**将清除哪些项**，并提示先导出备份。

类型声明见 `src/types/services.d.ts`（`WhaleServices` 挂到 `Window.services`），`npm run typecheck`（`vue-tsc --noEmit`）校验。

---

## 十一、构建与自测

1. `npm install`；`npm run dev`（Vite，5173）配合 uTools 开发者工具入口选 `public/`；或 `npm run build` 后入口选 `dist/`。
2. 改 preload 后必须在 uTools 里重新加载插件（preload 不热更；`lib/*.js` 同理）。
3. 类型检查：`npm run typecheck`（`vue-tsc --noEmit`）；提交前建议跑一次。
4. 版本号单一来源：改 `package.json` 的 `version` 即可。`npm run build` 的 `prebuild` 钩子执行 `scripts/sync-version.mjs`，写入 `public/plugin.json` 的 `version` 与 `public/preload/lib/constants.js` 的 `PLUGIN_VERSION`。
5. 自测：透明区穿透、拖到四边/四角吸附与贴左镜像、自由位、菜单改大小（鲸鱼角不动）、音效、点击刷新与 60s 自动刷新（隐藏窗口后确认不再轮询）、余额变动数字滚动、记账跨天、令牌模式回落、**令牌模式刷新后设置页趋势图当天柱与挂件「今日已用」一致**、**气泡长文案自适应（峰谷提醒 / 长台词不出框）**、**计时/定时/倒计时（正计时累加、倒计时分钟数归零响提示音、定时顺延到明天、计时气泡点开后收起与再打开；开启「计时到点通知」后到点弹系统通知；开启「计时保存」后重载插件/重建挂件仍继续计时，关闭后不恢复）**、置顶开关、导出 CSV、导入 CSV（合并进账本并刷新趋势）、查看/复制挂件错误、**按项清除数据（分别勾选凭据 / 设置 / 账本 / 窗口位置验证只清选中项）**、**`widget` 模式下挂件菜单「打开设置」能唤回主窗**（合并 feature 后的 redirect 兜底，重点验证）、**挂件三点菜单勾选 ↔ 设置窗口开关双向同步**（设置窗开着时改挂件菜单，本页开关即时跟随）、**复制/打开诊断日志**（`%TEMP%\whale-debug.log` 能看到 `onPluginDetach` / `onPluginOut {isKill}` 序列）、**关闭分离窗口后重进插件挂件自动重建**、**任务栏避让（自动隐藏任务栏：收起时挂件贴满边 → 鼠标压到屏幕底边，挂件 ~0.3s 内上移让位、设置页「任务栏：…」同步变「正在显示」→ 鼠标移开约 0.4s 后贴回）**、**贴边间距（上/右/下/左分别设值，贴该边时距离生效，改完立即重摆）**、**备份与恢复（导出→改设置/删数据→导入勾选项→同名覆盖生效；凭据加密导出后文件无明文、错密码被拒）**、**dsh 启停/重启/更新/版本来源（全局优先）/查看与复制日志/删除插件目录副本/清理 npx 旧缓存**。
