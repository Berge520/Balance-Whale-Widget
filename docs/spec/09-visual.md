## 九、视觉与几何参数（精确值）

| 项 | 值 |
|---|---|
| 鲸鱼本体 | 默认 `whale/DSniang1.webp` 610×610 cut-out，`.dshwv-img` 右下 `right:0;bottom:0;width:59.45%`；可切内置形象（下载后入画廊）/ 共享角色 / 导入图（`config.skin`，换图必须重建命中测试画布） |
| 气泡画布 | SVG viewBox `0 0 1026 700`；大椭圆中心(454,247) rx373 ry232；尾巴(301,465)-(413,484)；小气泡1(352,561) rx37.5 ry26；小气泡2(442,646) rx24.5 ry18；描边宽 18，颜色走 `--dshwv-stroke`（默认 `#203170`） |
| 文字块 | `left:44.25%;top:38%;translate(-50%,-50%)`，颜色走 `--dshwv-text`（默认 `#536ba9`） |
| 字号 | `--dshw-u = base/1026`；A=72/600、B=140/800、P=114/800、C=72（颜色走 `--dshwv-hint`，默认 `#9fb0d9`）。这四组数值在 `floating-bubble.css`（默认值）与 `src/bubble/bubble-render.js` 的 `BUBBLE_FONT`（超框缩放基准）各一份，**必须一致**（`check-shared.mjs` 钉住） |
| 气泡文字自适应 | 三级，见 [bubble-render.js](file:///e:/Github/Balance-Whale-Widget/src/bubble/bubble-render.js) 的 `fitText` / `fitBlock` / `fitRowOverflow`。可用区 `FIT_W=660u × FIT_H=430u`，**只缩不放**。<br>① **逐块独立**：每块（三行每行 / v2 每行 / 按压气泡每模块行）各算系数，谁超框缩谁（旧实现整体一个系数，余额被一起压小）。<br>② **下限** `FIT_HARD_MIN=0.34`，再缩等于糊字。<br>③ **兜底不溢出**：`fitRowOverflow` 先换行（放开模块 nowrap），仍超高才截断省略号（单模块独占行靠 `.dshwv-trowline > .dshwv-trow:only-child` 的 `inline-block + max-width` 才能截断）。**任何内容都不溢出气泡**。<br>说明行（第 3 行）两条路径都允许换行：台词由调用方标 `w: true`（→ `.dshwv-wrap`），`hintEl` 初始化与 `restoreBubbleLines()` 默认带 `dshwv-wrap`。<br>三行基准字号在 `BUBBLE_FONT`（类名首段为键），v2 段与模块行基准在 `dataset.fz`，图片段基准宽 `dataset.mw`；累积系数记 `dataset.k`，`resetFont()` 每次渲染前连同基准复位，避免系数叠加 |
| 气泡配色主题 | `config.theme`：`default`（蓝白，上列默认值）/ `dark` / `sakura` / `fantasy`（未至之境：`#E8F1FF` / `#8FA8CC` / `#0A1020` / `#3A7BFF`）。四色全走 CSS 变量（`--dshwv-text/hint/fill/stroke`，样式表内兜底），JS 只 `root.style.setProperty` 重写、不重建 DOM；「低余额」红色是状态色，不随主题变。`fantasy` 另加纯装饰 HUD：与主描边同路径的青色外圈 + 文字区四角括号，均 `pointer-events:none`，不改几何、不参与命中 |
| 气泡主题预览 | 外观页「气泡与文案」折叠区用 `BubblePreview` 渲染 0.5 倍舞台，`:theme="cfg.theme"`；与挂件共用同一渲染器，`fantasy` 的 HUD 也一并显示 |
| 背景氛围 | `config.bgMode`：`off`（默认）/ `deep` / `aurora` / `stars` / `mist` / `polar` / `warm` / `video` / `custom`。类挂在 `<html>`（`bg-deep` / `bg-aurora` / `bg-video` / `bg-custom`），深色（含未至之境）用 `html.dark.bg-*` 深海配色，浅色用 `html:not(.dark).bg-*` 淡彩配色（深色文字可读优先，亮底保持 `#f4f4f4`），两套都跟随界面深浅色切换；六档纯 CSS 氛围零素材，`video` 按需下载内置素材，`custom` 读用户导入的本地图片/视频。媒体层 `pointer-events:none`、`aria-hidden`，挂件不读；`bgScrim` / `bgBlur` / `bgBrightness` / `bgVignette` 控制遮罩/模糊/亮度/暗角；自定义媒体另支持 `bgFit` / `bgFocusX` / `bgFocusY` / `bgZoom` 与「智能适配」，视频选中即尝试播放（减少动态效果只影响启动片头）；自动播放被拦/解码失败时框内常驻「播放 / 重新播放」按钮并显示原因 |
| 启动片头 | `config.bootIntroOn`（默认 `false`）。设置页首次打开时由宿主 `bootIntroConsume()` 消费一次；来源 `bootIntroSource`：`auto` 跟随当前背景视频 / `media` 指定片头视频 / `css` 纯 HUD。视频全屏播放 4.2s（重遮罩 + HUD），无视频播 1.6s CSS/HUD；点击 / 任意键跳过，减少动态效果时只关闭转场 / 扫描动画（视频仍播放）；`bootIntroClean` 开启时用 `boot-intro-clean` 隐藏 `#app`，退场时先恢复，另提供「预览片头」入口。挂件不参与；片头层挂 body、`z-index: 10001` |
| 金额格式 | CNY → `¥ ` + toFixed(2)；其他 → `金额 币种` |
| 基准尺寸 | base=clamp(122, min(250, min(w,h)*0.28)*scale, 625)；窗口=base+2×200（`WIN_PAD`）；scale 0.6–2.5，落盘/读盘均经 `store.js` 的 `normScale` 吸附到整数档（`SCALE_STEPS`=15） |
| 模型余额格式 | 余额型 `MODEL_MONEY_PREFIX`（`CNY`→`¥ `、`USD`→`$`）+ toFixed(2)，**不折汇率**（各厂商余额独立）；额度型 `已用 x%`（浮点取整），未取到显示 `--`。挂件页读不到宿主常量，`floating-page.js` 有同内容兜底副本 |
| 吸附阈值 | 挂件中心在 `usableArea` 各轴 `snapRatio`% 区（1–45，默认 25）；`snapMode='off'` 时不吸附 |
| 朝向（镜像） | `flippedOf` = `hAnchor === 'left'`（贴边与自由摆放同一判定，始终朝屏幕内侧） |
| 点击阈值 | 位移平方 < 9（<3px） |
| 翻转动画 | 根 `transform .3s ease`；文字按属性拆分 `opacity .16s .36s, transform .3s` |
| Q 弹 | scaleY(.88) scaleX(1.05)，origin 50% 100%，.22s 回弹 |
| 数字动画 | 700ms ease-out 三次方（rAF）；自动刷新变动延迟 300ms 起滚，900ms 落定 |
| 时长 | 自动刷新 60s（页面隐藏时暂停）；气泡 5s；余额缓存 25s；悬浮窗兜底显示 `WIDGET_AUTOSHOW_MS`（`show:false` 创建，页面就绪前不露空白首帧） |
| 计时功能 | 1s 刷新（按终点时间戳推进）；倒计时按 `HH:MM:SS` 显示；计时气泡常驻；到点提示音 + 气泡显示「时间到！」或预设留言，停留 `timerRemindSec`（默认 8s，设置页「计时」卡可改）；菜单读数行（剩余 / 已用 / 休息·暂停 + 重置）**仅在菜单开着时**按秒刷新，打开菜单补一次 |
| 下班倒计时 | 沿用现有三行层级：`label` 一行（「距离下班」等）+ `main` 大号倒计时 + `hint` 第三行，不另做字号；`main` 用 `pad2` 拼 `hh:mm:ss`（小时不折「天」，跨日班可出现 `63:00:00`），`offworkShowSec` 关时为 `hh:mm`。临近下班：`.dshwv-offwork-soon` 把 `main` 转暖色 `#d9821a`；`.dshwv-offwork-imminent` 同色并叠 `dshwv-offwork-pulse 1.8s ease-in-out infinite`（`opacity 1 ↔ .62`）；`prefers-reduced-motion: reduce` 时只保留变色、不呼吸。触发档位 `NEAR_SOON_MS` = 30 分钟、`NEAR_IMMINENT_MS` = 10 分钟（只在工作中生效），不弹窗、不响铃 |
| 计时到点动作条 | `position:fixed`，`z-index` 10001；贴气泡下缘居中（空间不足翻上方）；按钮「休息 N 分钟 / 再来一轮 / 完成这条 / 知道了」—— 后两者按需出现：「完成这条」仅 `focusOn && !timerIsBreak` 且有专注项；休息轮到点只留「继续专注 / 知道了」（不显示休息与完成这条）；番茄自动衔接等待期（3 秒）另加「取消衔接」 |
| 峰谷倒计时 | 文案随余额 payload 更新（60s 轮询 / 手动刷新），不单独起定时器；`<1h` 显示「45m」，`≥1h` 显示「1h20m」 |
| 预算 / 低余额提醒 | 越线气泡停留 `remindSec`（默认 8s，0 = 常驻）；「超预算 ¥y」常驻第三行；系统通知每天一次（免打扰时段内跳过且不占名额） |
| 余额波动提醒 | 单次采样下降 ≥ `dropAlertAmount` 即弹系统通知（`notifyNow`，**不做每天一次去重**——基准随采样更新，同一次下降不会被采到两次），文案按是否计入用量区分；仅受免打扰约束 |
| z-index | 挂件 9999，菜单 10000 |
| 透明度 | `--dshw-opacity` 0.2–1（`opacity` 20–100）；`.dshwv-root` 与菜单打开态各自相乘；菜单关闭态固定 `opacity:0` |
| 穿透接管时序 | 悬停 `PASS_DWELL_MS`=1200ms 接管；离开 `PASS_RELEASE_MS`=700ms 交回；穿透角标 `opacity:.45` + 1px 虚线环 |

---
