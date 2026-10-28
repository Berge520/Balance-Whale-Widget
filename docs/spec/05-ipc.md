## 五、IPC 通道契约

| 方向 | 通道 | payload | 说明 |
|---|---|---|---|
| 子→父 | `whale:ready` | — | 悬浮窗 DOM/preload 就绪，请求初始数据 |
| 子→父 | `whale:refresh` | `{manual?:boolean}` | 请求余额（25s 缓存 + in-flight 去重） |
| 子→父 | `whale:config` | config patch | 改大小/音效开关/音色/音量/**透明度**/用量/峰谷/气泡/报时/置顶/避让任务栏与贴边间距/吸附开关与吸附区宽度；`{__live:true}` = 拖动中实时预览（只改窗口几何 / 透明度，不写存储、不回推设置页） |
| 子→父 | `whale:drag-begin` | — | 开始拖拽：宿主进入「拖拽冻结」态（期间缩放请求只记最后一个目标值，不改尺寸）并作废几何缓存。页面在 pointerdown 命中鲸鱼时立即上报，不能等首次 `drag-move`：按下到首次移动之间若来一次滚轮 / 实时缩放，尺寸会先被改 |
| 子→父 | `whale:drag-move` | `{x,y}`（目标窗口左上角，屏幕 DIP） | 拖拽中页面按 rAF 节流上报（每帧最多一发）。宿主**只记最新目标**，`setPosition` 由自驱循环（`startDragLoop`，~120Hz）执行：页面不等回执、同帧多次上报天然合并。**别退回「发一帧等 ack」的串行背压**：吞吐被单个 IPC 往返锁死，画圈时每帧都不同、无可合并帧 |
| 子→父 | `whale:drag-end` | — | 松手，主窗解冻（冻结的缩放目标在此补做并持久化）+ 吸附 + 回推 snapped。**点击路径与 pointercancel 也必须上报**：只点击不拖动也走这里解冻，否则宿主停在冻结态，之后滚轮缩放全失效 |
| 子→父 | `whale:ignore-mouse` | `{ignore:boolean}` | 点击穿透开关 |
| 子→父 | `whale:input-focus` | `{focus:boolean}` | 菜单输入焦点：`true` = 挂件窗口 `focus()` 借焦点（窗口 `focusable:false`，键盘事件进不来，倒计时时/分/秒、定时刻输入框打不了字）；`false` = 关菜单时交还，宿主 `utools.showMainWindow()` 唤回主窗，避免设置窗失焦自动隐藏 |
| 子→父 | `whale:open-settings` | `{ target?: string }` | 挂件菜单唤出主窗（`utools.showMainWindow()`），「只显示挂件」模式的设置入口。**可带 `target`**：宿主唤窗后调 `settings.emitNavigate(target)`，设置页 `applyNavigate(target)` 切 Tab 并展开相关卡（`services.onNavigate` 订阅）。无载荷 = 默认 Tab；redirect 分支（主窗不存在、需 `utools.redirect`）页面全新加载，target 投递不到 |
| 子→父 | `whale:hide-widget` | — | 挂件菜单「隐藏挂件」：宿主 `destroyWidget()` 销毁悬浮窗（与设置页同一路径），下次「显示挂件」重建并加载最新页面 |
| 子→父 | `whale:timer` | 计时状态对象，或 `null`（清除） | 计时开始 / 停止 / 到点时落库，宿主重建挂件后回推恢复 |
| 子→父 | `whale:timer-done` | `{text}` | 计时到点：发不发由页面按 `timerNotifyOn \|\| (timerMailOn && notifyMailOn)` 判断（只开邮件也发）；收到即走统一出口 `notify(text, readConfig())`，按配置发系统通知 / 邮件 |
| 子→父 | `whale:focus` | `{minutes}` | 挂件倒计时**正常走完**时上报一轮专注：`finishTimer()` 按 `focusOn && !timerIsBreak && timerMode === 'down'` 门控（手动停止 / 暂停不算；**休息轮不算专注**，否则休息 5 分钟会被记成专注 5 分钟）。宿主 `recordRound` 累加到当天 `{r,m}` → `pruneFocus(FOCUS_KEEP_DAYS)` → `writeFocus` → `emitFocusChange()`。**刻意不搭 `whale:timer-done` 顺风车**：那条被通知开关门控，专注统计不该受通知偏好影响 |
| 子→父 | `whale:todo` | `{op:'toggle'\|'focus', id}` | 挂件待办行的勾选 / 专注切换（**与父→子同名通道方向相反**，两窗口各注册 `ipcRenderer.on`，互不干扰）。`op` 只认这两个值，其余丢弃；`toggle` 取反 `done`（完成时若 `focusId === id` 一并清空专注标记）；`focus` 做 `focusId = focusId === id ? '' : id`（再点即取消）。写 `whale:todo` 成功后重推 `pushTodo()` + 广播 `emitTodoChange()` |
| 子→父 | `whale:page-log` | `{msg, detail}` | 页面侧 `logErr` 只能打 console，打包版无 DevTools 取不到，转交宿主写进 `%TEMP%\whale-debug.log`（`msg`/`detail` 各截断 500 字符） |
| 子→父 | `whale:dsh` | `{action:'status'\|'start'\|'stop'\|'restart'\|'update'\|'versions'\|'open'}` | dsh 控制：宿主先探测端口（`config.dshPort`，默认 3080；识别外部终端跑的 dsh）再执行，结果同通道回推 |
| 子→父 | `whale:models-refresh` | `{ids?:string[]\|null, force?:boolean}` | 多厂商模型余额/额度刷新：`ids` 省略 = 全部；`force=false` 时距上次不足 `MODEL_STALE_MS`(5min) 跳过（菜单懒加载，反复开不一直打网络）。宿主先推一次现有快照（菜单立刻显示上次结果），收尾（成功或失败）再推一次并带 `refreshDone:true`：「刷新全部」据此解锁，不靠定时器猜耗时 |
| 子→父 | `whale:set-main-model` | `{id}` | 挂件菜单点某行 = 设为挂件主显示。宿主 `patchConfig({mainModelId})` → 推 `whale:models` → `emitConfigChange()` 反向同步设置页单选（否则两处不一致） |
| 父→子 | `whale:init` | `{config, anchor:{hAnchor,vAnchor,flipped}, space:{up,down}, balance, timer, sounds, skin, bubbles, models, todo}` | 初始化；`todo` = 待办快照 `{items,focusId}`（**仅 `todoOn` 开启时有值，关闭为 `null`**，挂件据此整组隐藏）；`space` = 挂件本体到工作区上/下边缘的空白 px（窗口不存在为 `null`），页面据此决定菜单展开方向（见第四节）；`timer` 仅在 `timerPersistOn` 开启时有值；`sounds` = 六槽位 base64 data URL 数组（每槽位至多一段；未导入为空数组）；`skin` = 自定义形象 base64 data URL（未导入为空串）；`bubbles` = 气泡图 base64 数组（未导入为空数组，回退内置 `rua.webp`） |
| 父→子 | `whale:show` | — | **首帧就绪后显示悬浮窗**。窗口以 `show:false` 创建（见第八节），`whale:ready` 后宿主推初始数据、待首帧绘制完成再 `show()`，避免加载瞬间露出内置形象/空白首帧。另有 `WIDGET_AUTOSHOW_MS` 兜底：页面迟迟不就绪（异常/被脚本阻塞）时强制显示。`resetWidgetShown()`（随 `destroyWidget` 调）清掉会话内「已显示」去重标志，重建后可再触发 |
| 父→子 | `whale:balance` | 余额 payload（见下） | 余额/今日已用结果 |
| 父→子 | `whale:config` | 完整 config，或 `{opacity}`（实时预览） | 设置页/菜单改动广播 |
| 父→子 | `whale:todo` | 待办快照 `{items:[{id,text,done,at,doneAt}], focusId}` | **整份覆盖**（页面直接替换 `todoState`，不增量合并）。触发点：设置页增删改后（`todoMutate` → `pushTodo()`）、挂件勾选 / 切专注后（写盘成功回推）、`todoOn` 翻转时（`patchConfig` 补推，否则后开待办的用户没快照可画）、恢复备份 / 清除数据后 |
| 父→子 | `whale:sounds` | `{press, release, low, budget, peak, pass}`（六槽位各自的 base64 data URL **数组**，空数组 = 未导入） | 导入/删除自定义音效后宿主重推音频本体。**每槽位只保留一段**（再导入即替换），数组长度恒为 0 或 1：保留数组形态为不动通道契约。页面侧提醒音**每次都重建**（不受 `soundSet` 影响）：导入即生效、删除即回落到内置提醒音 |
| 父→子 | `whale:skin` | base64 data URL（空串 = 无自定义形象） | 导入/删除/切换自定义形象后宿主重推**当前那张**图片本体 |
| 父→子 | `whale:bubbles` | base64 data URL 数组（空数组 = 无自定义气泡图） | 导入/删除自定义气泡图、或素材包写入后宿主重推全部气泡图本体。页面**没有「当前用哪张」**：抽到「动图组」时从数组随机取一张，空数组回退内置 `rua.webp` |
| 父→子 | `whale:dsh` | dsh 状态快照 | 运行中/pid/就绪/版本与来源（`source: global\|plugin`）/日志/错误。**两条触发路径**：① 挂件发 `whale:dsh` 操作后的结果回推；② `lib/dsh.js` 的 `onChange` 广播（`ipc.js` 在 `registerIpc()` 订阅，一次 broadcast 只生成一份快照复用）：3080 就绪、进程退出、安装/版本查询完成等异步变化靠它推送，否则菜单停在「启动中…」「正在结束…」 |
| 父→子 | `whale:snapped` | `{hAnchor,vAnchor,flipped,space}` | 吸附结果（驱动镜像；`space` 同 `whale:init`，位置变了菜单展开方向要重算）。**三条触发路径**：① `ipc.js` 的 `whale:drag-end`；② `widget.js` 的 `repositionFromAnchor()`：宿主**主动**挪窗口的唯一出口（任务栏显隐 / 改分辨率 / 换屏 / 改四边间距 / 复位位置），挪完必须重推，否则页面拿旧 `flipped` 贴错边、拿旧 `space` 朝屏外展开；③ `applyScaleToWindow()` 的**持久化分支**（松手提交）：缩放以角为不动点会改上下空白，进而影响展开方向；实时拖动不推（每帧 IPC 太贵，菜单多已关闭） |
| 父→子 | `whale:models` | `{list:WhaleModelRow[], mainModelId, refreshDone?:true}` | 多厂商模型列表（**含内置 DeepSeek 那条**，`list[0]` 固定为它，余额/今日已用取自全局余额缓存）+ 当前主显示 id。触发点：`whale:models-refresh` 前后（收尾带 `refreshDone:true` 供「刷新全部」解锁）、`whale:set-main-model` 后、设置页增删改模型后（`pushModels()`）。载荷由 `api.getModelsPayload()` 统一装配：内置那条与其余条目的差异只在这一个函数里 |
| 父→子 | `whale:bubble-preview` | `{items:[步骤…]}` | 设置页「按压气泡」卡试播：把新模型的**步骤队列**整队发到悬浮页挂成试播会话。`services.bubblePreview({items})`（`settings.js` 直通）→ 宿主 `sendToWidget('whale:bubble-preview', {items})`，`winAlive()` 为假返回 `{ok:false,error}` 提示先显示挂件。悬浮页 `onBubblePreview(cb)`（floating.js 透传）按新模型渲染：每步含单泡或 A/B 并列泡，模块取值（余额 / 占位符）在悬浮页现算。**仅在 `config.bubble.on` 开启时接管渲染** |
