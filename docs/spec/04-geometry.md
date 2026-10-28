## 四、窗口几何模型（重点）

- 窗口是正方形，边长 = **挂件本体基准尺寸 + 2 × `WIN_PAD`(=200px) 透明留白**。四周都留白（而非只在上/左），是为了让汉堡菜单在挂件**贴上边**时能改向按钮**下方**展开（否则上半截落在屏外）。
- 挂件本体在窗口内**居中**：挂件左上角 = 窗口左上角 + (WIN_PAD, WIN_PAD)。
- 页面 CSS：`.dshwv-root` 为 `100vw - var(--whale-pad) * 2` 见方、`left/top: var(--whale-pad)`；`--whale-pad` 必须与 `lib/constants.js` 的 `WIN_PAD` 一致。
- **菜单展开方向**（`positionMenu`）：窗口留白只有 `WIN_PAD`，超出工作区的部分落在屏外，菜单摆过去看不见。宿主把「挂件本体到工作区上/下边缘的空白」随 `whale:init` / `whale:snapped` 下发（`space:{up,down}`，见 `widget.js` 的 `spaceAround()`），页面按 `min(space, WIN_PAD) + 按钮到挂件本体边缘的距离` 算出上/下**真正可见**高度：上方装得下就向上（不遮小鲸鱼），装不下且下方更宽才改向下方展开（加 `.dshwv-menu-down` 反转动画），高度不足时压 `max-height` 在菜单内滚动。
- **所有定位/吸附/缩放/钳制都以「挂件本体矩形」为准**，透明留白允许越出屏幕（`enableLargerThanScreen`）。换算辅助：`widgetOrigin(winX,winY)` / `winOrigin(wx,wy)`、`clampWidget(wa,wx,wy,s)`。
- **可用区 `usableArea(x,y)`**：所有定位/吸附/缩放统一用它代替裸 workArea —— ① 取系统 workArea（任务栏**常显**时已被系统排除）；② 若「自动避让任务栏」开着，且主屏任务栏**自动隐藏 + 此刻正弹出**，就把它那条边内缩注册表厚度；③ 再按配置 `edgeTop/edgeRight/edgeBottom/edgeLeft`（「贴边间距」，0–400px，0＝紧贴该边）四边各自内缩。收起时不让位，挂件可以贴满边。
- **任务栏状态识别 + 动态让位**：**不能**用 workArea 判显隐 —— Windows 上 Electron/uTools 的 workArea 不随任务栏显隐刷新，只反映进程启动时状态（`display-metrics-changed` 也不响应，见 electron#6312），所以只在**启动时**用它区分「常显（有内缩 → 已排除）」与「自动隐藏 / 无任务栏（内缩为 0）」；后者读注册表 `HKCU\...\StuckRects3\Settings`（`byte[8] & 0x03` → 0 左 / 1 上 / 2 右 / 3 下，`[24..39]` 是任务栏矩形，厚度 ÷ `scaleFactor` 换算 DIP）拿方向与厚度。**「此刻是否弹出」看光标**（`utools.getCursorScreenPoint()`）：Windows 只在光标压到屏幕那条边时把任务栏拉出，拉出后光标落在它的矩形里、离开即缩回：压边 → 弹出；条带内 → 维持；离开条带超 `TB_HIDE_DELAY`(500ms) → 收起。`syncTaskbarWatch()`（挂件存在且 `avoidTaskbar` 开启）每 250ms 采样「显示器 id + bounds + workArea + 任务栏边 + popped」指纹，变化就 `clearLiveScaleCtx()` + `repositionFromAnchor()` 按锚点重摆（覆盖分辨率 / 缩放 / 换屏）；拖拽 / 缩放中的那帧不抢位置。设置页每 2s 经 `getTaskbarState()` 显示识别结果。注册表结果缓存 60s。改开关或任一间距都调 `repositionFromAnchor()` 立即重摆。
- 基准尺寸：`base = clamp(122, min(250, min(workW,workH)*0.28) * scale, 625)`，scale∈[0.6,2.5]（设置页菜单 1–15 线性映射，默认 1.3=6）。档位数常量 `SCALE_STEPS = 15` 定义在 `lib/constants.js`（`store.js` 的 `normScale()` 与 `App.vue` 共用，含 number 输入 `max` 与 `scaleToNum` / `numToScale` 换算）；浮动页 `floating-page.js` 用同一套整数档（滑块 1–`SCALE_STEPS`、`numToScale` / `scaleToNum` / `snapNum`），三处 `SCALE_STEPS` 同值由 `scripts/check-shared.mjs` 校验。**落盘 / 读盘时 scale 一律经 `store.js` 的 `normScale(v, dft)` 吸附到最近的整数档位**（把连续值量化成 `min + round((v-min)/step)*step`，非法值退回默认 `SCALE_DFT`），保证各来源（设置页、浮动页、旧配置）读写同口径。窗口边长 = base + 400。
- **吸附**（松手，`snapRect`）：挂件中心点在所在显示器 `usableArea` 的横/纵**吸附区**（默认 1/4，配置项 `snapRatio`%，1–45）→ 贴左/右、上/下（净距离 0）；中间区为自由位，记录离最近边净距离。横纵独立 → 四角可组合。`snapMode='off'`（设置页「吸附与翻转 → 关闭」）时两轴都走自由分支 —— 位置照样以「最近边 + 净距离」记锚点、能原样还原，只是不再自动贴边。多显示器按挂件中心 `getDisplayNearestPoint` 选屏。
- **缩放**（`applyScaleToWindow`）：以鲸鱼角为不动点 —— `flippedOf` 为真保持左缘、否则右缘；贴上保持上缘、否则下缘 —— 重算 `setSize+setPosition` 并更新锚点净距离。
- **朝向**（`flippedOf(anchor)` = `anchor.hAnchor === 'left'`）：锚在左 → `flipped=true`，子窗根元素加 `.dshwv-left`（`scaleX(-1)`），文字/gif 单独反向镜像保持可读；锚在右 → 不翻。**贴边与自由摆放共用这一条判定**：自由分支记的是「离最近的那条边」，`hAnchor` 编码了「挂件中心在中线的哪一侧」，所以关掉吸附也跟着翻转，鲸鱼始终面向屏幕内侧。

---
