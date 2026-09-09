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
- 交互：拖拽 + 四边四分之一吸附（四角可组合）+ 自由位、贴左镜像、按压 Q 弹 + 双段音效、汉堡菜单（大小/音效开关/音色/音量/用量/峰谷文案/气泡/报时/置顶）、数字滚动、60s 自动刷新 + 点击手动刷新、随机台词 + rua.gif、透明区点击穿透。
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
            │ preload/services.js (CommonJS)            │ preload/floating.js
            │  · createBrowserWindow                    │  · ipcRenderer.on
            │  · 余额/账本/定价/窗口几何                  │  · utools.sendToParent
            │  · ipcRenderer.on 收子窗                    │
            └─────────────────── 主窗 ↔ 悬浮窗 IPC ──────┘
```

- **主窗 preload**：`public/preload/services.js`，CommonJS，全部业务逻辑（窗口、网络、账本、定价、几何）。经 `plugin.json` 的 `preload` 字段加载，对页面暴露 `window.services`。
- **悬浮窗 preload**：`public/preload/floating.js`，CommonJS，薄桥接层。经 `createBrowserWindow` 的 `webPreferences.preload` 指定（相对路径），对页面暴露 `window.whale`。
- **悬浮窗页面**：`public/floating.html`，自包含原生 JS（不参与 Vite 打包，直接读磁盘），只负责展示与指针交互，**不持有密钥、不发网络请求**。
- 设置页 `src/App.vue` 走 Vite 打包；`public/` 下文件原样复制到 `dist/`。

> preload 遵循 uTools 规范：CommonJS、可 `require('electron')`、**不得压缩/混淆/打包**。

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

---

## 四、窗口几何模型（重点）

- 窗口是正方形，边长 = **挂件本体基准尺寸 + `WIN_PAD`(=200px) 透明留白**。留白用于让汉堡菜单在按钮**上方**展开时不被窗口边缘裁切。
- 挂件本体在窗口内**右下对齐**：挂件左上角 = 窗口左上角 + (WIN_PAD, WIN_PAD)。
- 页面 CSS：`.dshwv-root` 为 `100vw - var(--whale-pad)`（200px）见方、`right:0;bottom:0`；`--whale-pad` 必须与 services.js 的 `WIN_PAD` 一致。
- **所有定位/吸附/缩放/钳制都以「挂件本体矩形」为准**，透明留白允许越出屏幕（`enableLargerThanScreen`）。换算辅助：`widgetOrigin(winX,winY)` / `winOrigin(wx,wy)`、`clampWidget(wa,wx,wy,s)`。
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
| 子→父 | `whale:config` | config patch | 改大小/音效开关/音色/音量/用量/峰谷/气泡/报时/置顶 |
| 子→父 | `whale:drag-move` | `{x,y}`（目标窗口左上角，屏幕 DIP） | 拖拽中，主窗 clamp 后 setPosition |
| 子→父 | `whale:drag-end` | — | 松手，主窗吸附 + 回推 snapped |
| 子→父 | `whale:ignore-mouse` | `{ignore:boolean}` | 点击穿透开关 |
| 父→子 | `whale:init` | `{config, anchor:{hAnchor,vAnchor,flipped}, balance}` | 初始化 |
| 父→子 | `whale:balance` | 余额 payload（见下） | 余额/今日已用结果 |
| 父→子 | `whale:config` | 完整 config | 设置页/菜单改动广播 |
| 父→子 | `whale:snapped` | `{hAnchor,vAnchor,flipped}` | 吸附结果（驱动镜像） |

余额 payload：成功 `{ok:true,totalBalance,currency,updatedAt,todayUsage,isPeak,usageMode:'ledger'|'token'}`；失败 `{ok:false,code:'NO_KEY'|'BAD_KEY'|'AUTH'|'HTTP'|'PARSE'|'SHAPE'|'ERROR',error,transient?}`。

---

## 六、存储结构（uTools）

| 介质 | 键 | 内容 |
|---|---|---|
| `dbCryptoStorage`（加密） | `whale:secrets` | `{apiKey, platformToken}`，写入前 `sanitizeKey` 剔除空白 |
| `dbStorage` | `whale:config` | `{scale,vol,soundOn,soundSet,usageMode,peakMode,bubbleOn,menuBtn,onTop,lowAlertOn,lowAlertAmount,timeBubbleOn,updatedAt}` |
| `dbStorage` | `whale:ledger` | `{date,lastBalance,lastCurrency,todayUsage,history:{YYYY-MM-DD:金额}}`（history 留 30 天） |
| `dbStorage` | `whale:window` | `{hAnchor,hDist,vAnchor,vDist}` 净距离锚点 |

默认 config：`{scale:1.5, vol:0.9, soundOn:true, soundSet:'duck', usageMode:'ledger', peakMode:'default', bubbleOn:true, menuBtn:true, onTop:true, lowAlertOn:true, lowAlertAmount:10, timeBubbleOn:true}`。

---

## 七、网络与计费

**余额**（`fetchBalanceWith`）：超时 20s（`AbortSignal.timeout`）；网络错/超时/5xx 间隔 500ms 重试 1 次，4xx 不重试；401 读取 DeepSeek 返回的 `error.message` 给出中文指引；`transient` 失败且有缓存时回退 stale。25s 缓存 + in-flight 去重；手动刷新（`whale:refresh {manual:true}`）跳过缓存（请求进行中仍复用同一 Promise）。

**记账**（`recordLedgerUsage`）：每次成功余额观测后执行；同日余额下降累加差值，上升（充值）不扣；币种变化只重置基准；跨天归档并归零。

**实时令牌**（`fetchPlatformUsage` + `computeTodayUsage`）：
- URL `https://platform.deepseek.com/api/v0/usage/by_api_key/amount?start=<本地零点unix>&end=<+86400>&tz=<偏移秒>`，`Bearer <token>`（自动去 `Bearer ` 前缀），15s 超时。
- 解析 `data.biz_data.series[]`（兼容 `data.series`），每 series `{model,buckets:[{time,usage:{RESPONSE_TOKEN,PROMPT_CACHE_HIT_TOKEN,PROMPT_CACHE_MISS_TOKEN}}]}`；接口只给 token 不给金额。
- 峰谷：北京时间工作日 9–12、14–18 为峰；`WEEKEND_VALLEY_FROM_SEC`（=北京 2026-08-23 00:00）起周末全天谷价。

**定价表**（每百万 token，CNY，谷/峰）：

| 模型 | 缓存命中 | 缓存未命中 | 输出 |
|---|---|---|---|
| deepseek-chat / reasoner / v4-flash（含 flash-vision） | 0.05 / 0.1 | 1.5 / 3.0 | 4.5 / 9.0 |
| deepseek-v4-pro | 0.15 / 0.3 | 4.5 / 9.0 | 13.5 / 27.0 |

模型名按子串匹配（`priceFor`），未知走 `_default`（基础价）。DeepSeek 调价改 services.js 顶部 `PEAK_HOURS/BASE_PRICE/PRO_PRICE/PRICING`。

---

## 八、悬浮窗页面（floating.html）

IIFE + 幂等守卫 `window.__dshWhaleWidget`。资源相对路径 `./whale/...`。

DOM：`.dshwv-root`（定位/翻转）> `.dshwv-body`（Q 弹缩放）> `img.dshwv-img` + `.dshwv-bubble`（SVG + `.dshwv-gif` + `.dshwv-text` 三行）；`.dshwv-menu-btn` 三点按钮；`.dshwv-menu` 挂 body。

- 命中测试：鲸鱼图画到 610×610 canvas，`getImageData` 读 alpha>10（左镜像时 x 翻转）；据此决定拖拽/穿透/光标。
- 拖拽：pointerdown 在鲸鱼上 → 记录 `screenX/Y` 与 `clientX/Y`；移动按 `目标窗口左上角 = screenX − clientX0`（拖拽中恒定）rAF 节流上报 `drag-move`；位移平方 <9 判点击（=开气泡+刷新），否则松手上报 `drag-end`。
- Q 弹：body `scaleY(.88) scaleX(1.05)`，origin `50% 100%`，`transform .22s cubic-bezier(.34,1.56,.64,1)`。
- 音效：press=Ya1/D1、release=Ya2/D2；按住松手与短按（press 末尾提前 100ms 接 release）两节奏；vol=0 静音；`new Audio` 失败静默。
- 随机台词六组权重 45/7/7/10/3/1（峰谷三行 / B 卖萌 / A 吐槽换行 / rua.gif / A 大烧货 / B 哦鲸鲸）；点气泡首次切随机、再点关闭；气泡 5s 自动收起；gif 加载失败兜底文字。气泡首行默认**报时**（`timeBubbleOn`，鲸鱼娘语气按时段变化，如「都 02:30 了，还不睡吗…」），关闭后显示「DeepSeek 余额」。

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
| 吸附阈值 | 挂件中心在 workArea 各轴 1/4 区 |
| 点击阈值 | 位移平方 < 9（<3px） |
| 翻转动画 | 根 `transform .3s ease`；文字按属性拆分 `opacity .16s .36s, transform .3s` |
| Q 弹 | scaleY(.88) scaleX(1.05)，origin 50% 100%，.22s 回弹 |
| 数字动画 | 700ms ease-out 三次方（rAF）；自动刷新变动延迟 300ms 起滚，900ms 落定 |
| 计时 | 自动刷新 60s；气泡 5s；余额缓存 25s |
| z-index | 挂件 9999，菜单 10000 |

---

## 十、设置页（src/App.vue）

通过 `window.services` 调用：`getConfig/saveConfig/getSecrets/saveSecrets/testApiKey/testPlatformToken/getUsageHistory/showWidget/hideWidget/isWidgetVisible/ensureWidget/getWidgetError/copyText/redirectHotKeySetting`。包含 API Key / 平台 Token 录入（加密保存 + 测试连接，分项验证余额接口与用量接口）、大小/音效开关/音色/音量/用量/峰谷文案/气泡/报时/菜单按钮/置顶/低余额预警开关与阈值、近 7 天用量柱状图、显示/隐藏挂件、复制指令名（`copyText('显示/隐藏挂件')`）、新增快捷键（`redirectHotKeySetting('显示/隐藏挂件')`，跳转「全局功能」并新增待绑定项）与错误回显。

---

## 十一、构建与自测

1. `npm install`；`npm run dev`（Vite，5173）配合 uTools 开发者工具入口选 `public/`；或 `npm run build` 后入口选 `dist/`。
2. 改 preload 后必须在 uTools 里重新加载插件。
3. 自测：透明区穿透、拖到四边/四角吸附与贴左镜像、自由位、菜单改大小（鲸鱼角不动）、音效、点击刷新与 60s 自动刷新、余额变动数字滚动、记账跨天、令牌模式回落、置顶开关。
