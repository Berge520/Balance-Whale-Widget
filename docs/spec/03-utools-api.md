## 三、uTools 关键 API 约定（踩坑结论，先看）

1. **`createBrowserWindow(url, options)` 的 `url` 必须是插件包内 html 的相对路径**（如 `'floating.html'`）。传 dev-server 的 `http://localhost:...` 会被判「html 文件不存在」。`plugin.json` 不含 `development` 字段，uTools 一律按插件根解析（开发与打包都是 `dist/`）。
2. **`webPreferences.preload` 也必须是相对路径**（如 `'preload/floating.js'`），传绝对路径会导致子窗 preload 不加载（`window.whale` 缺失）。
3. **主窗 → 悬浮窗只能 `win.webContents.send(channel, ...)`**；**悬浮窗 → 主窗只能 `utools.sendToParent(channel, ...)`**；接收统一 `ipcRenderer.on(channel, ...)`。不要用 `ipcRenderer.sendTo`（uTools 定制窗口上无效）。
4. 返回的窗口**不支持 BrowserWindow/webContents 实例事件**（`win.on('closed')`、`webContents.on('did-finish-load')` 等不触发）；页面加载完成用 `createBrowserWindow` 的第三参 `callback`。
   - **`webContents` 与实例方法不是一回事**：`win.reload()` / `win.isLoading()` / `win.stop()` 等按官方文档挂在窗口实例上；但 `loadURL` / `loadFile` **在本项目实测不可用**（见下一条），别照着 window.md 直接写。
   - **「在 uTools 里打开任意网页」不要用 `createBrowserWindow`，用 `utools.ubrowser`**（2026-11-11 实测结论）：定制窗口第一参只收包内相对路径，想塞进在线页面就得建壳页再导航；而导航这条路两次实测都走不通（`win.webContents.loadURL` / `win.loadURL` 均报 `is not a function`，窗口永远停在壳页「正在打开 dsh…」）。官方给「用内置浏览器打开网页」的入口是 uBrowser 链式 API：
     ```js
     utools.ubrowser.goto(url).run({ show: true, title: 'dsh · Web UI', width: 1200, height: 800 })
     ```
     `run(窗口选项)` 直接开一个**可视化浏览器窗口**并加载目标页，不需要壳页、不需要手动导航；返回 Promise，resolve 后没后续操作时若窗口隐藏会被 uTools 自动销毁 —— 所以**显式 `show: true`**。会话按插件应用隔离（Cookie 可持久化）。`lib/dsh-web.js` 的内置模式即走这条，失败才回退 `shellOpenExternal`。以后接同类需求照这个写。
5. 透明窗关键选项：`transparent:true`、`backgroundColor:'#00000000'`、`frame:false`、`thickFrame:false`、`hasShadow:false`、`roundedCorners:false`、`skipTaskbar:true`、`enableLargerThanScreen:true`；置顶 `alwaysOnTop`（类型里也有拼写 `alwayOnTop`，两个都给）+ `win.setAlwaysOnTop(true,'screen-saver')`。
6. **Windows 下渲染进程直接 setBounds/移动透明窗会异常**：窗口移动/尺寸统一由主窗 preload 用 `win.setPosition/setSize` 完成，悬浮窗只上报目标坐标。
7. 透明区点击穿透：`win.setIgnoreMouseEvents(ignore, { forward:true })`，配合页面侧 `document.elementFromPoint` + 鲸鱼像素 alpha 命中测试，动态开关。**去重要点**：`forward:true` 下页面会收到高频 mousemove，每次移动都发一次 `whale:ignore-mouse` 纯属浪费：页面侧 `sendIgnoreMouse()` 与宿主侧 `ipc.js` 各自缓存「上次下发的值」，值不变直接 return；宿主侧缓存必须**按窗口实例失效**（`getWindow()` 引用变化即清空），窗口重建后的新窗口默认不穿透，必须重新下发。页面侧 pointermove 的命中测试用 rAF 合并（每帧最多一次）。另见第 16 条（穿透总开关与悬停接管）。
8. preload 改动不热更，需在 uTools 开发者工具里**重新加载插件**；子窗 devtools：焦点在挂件窗口上按 `Ctrl+Shift+I`。
9. 动态插件无法开机自启；改为「呼出指令即创建」，创建后独立窗口常驻。
10. **自定义快捷键**：uTools 没有「插件内注册任意快捷键」的 API。做法是在 `plugin.json` 的 `features` 新增一条功能（配 `mainHide:true` 使其触发时不弹出搜索框），用户在「设置 → 全局功能」为该指令绑定全局快捷键。现有两条：
    - `code:"whale-toggle"`（指令「显示/隐藏挂件」「切换挂件」）：`onPluginEnter` 收到后调 `toggleWidget()` 显隐挂件；
    - `code:"whale-passthrough"`（指令「切换鼠标穿透」「鼠标穿透」）：取反配置 `passThrough` → `patchConfig` + `pushConfig()` + `emitConfigChange()` + `utools.showNotification` 反馈。**这是穿透开启后最可靠的关闭入口**（穿透时挂件菜单点不到）。
    因 `utools.redirectHotKeySetting` 每次调用都会新增一条待绑定项、无「只跳转不新增」的接口，设置页每条指令给两条路径：①「复制指令名」（`utools.copyText(<指令名>)`）+ 文字步骤（`Ctrl+,` → 全局功能 → 新增 → 填指令名），用于首次手动绑定、不新增多余项；②「新增快捷键」调用 `redirectHotKeySetting(<指令名>)` 直接跳转并新增待绑定项，用于绑定被删后重加（`App.vue` 的 `copyHotkeyCmd(label)` / `addHotkey(label)` 已参数化，默认「显示/隐藏挂件」）。
11. **调试日志统一走门控函数**：主窗统一用 `lib/log.js` 的 `log()/logErr()`，**`DEV` 恒为 true**（v1.6.1 起不再取 `utools.isDev()`）—— 打包版与开发版行为一致，两版都落盘，便于用户取证；悬浮窗 `floating-page.js` 通过 `window.whale.dev`（preload 透传）判断。不要再直接写 `console.log/error`。挂件子窗 `devTools` 亦恒为 true。
    - **同步落盘**：`lib/log.js` 除控制台外，用 `appendFileSync` 同步追加到 `%TEMP%\whale-debug.log`（`utools.getPath('temp')`，进程随时被 uTools 结束也不丢）。主窗 `services.js`、悬浮窗 `floating.js` 均接入同一份日志，并各自打印 `utools.getWindowType()`，用于复盘「挂件消失」类生命周期问题。设置页提供「复制诊断日志」(`getDebugLog()`) 与「打开日志文件」(`openLogFile()`)。
    - **时间戳用本地挂钟 + 显式偏移**（`log.stamp()`，形如 `2026-10-31T02:16:21.123+08:00`）：**不要改回 `toISOString()`**。原先落的是 UTC 钟面，而这份日志是用户自己也会打开对时间的材料 —— 东八区凌晨 02:16 的重启记成「前一天 18:16」，读的人会把刚刚发生的当成昨晚发生的，进而误判某条路径压根没跑过（本轮排查置顶时真的被它带偏过一次）。尾巴上带偏移，瞬间仍可精确还原（`Date.parse` 可逆），同一时区内字典序仍等于时间序；`test/log.test.mjs` §14 钉住钟面与可逆性。
    - **定期清理（两重，防 `%TEMP%` 无限增长）**：清理必须做在写入路径上 —— 日志是同步写的，进程随时可能被结束，独立定时器不可靠（未触发进程就没了）。①**体积**：写入时按内存计数 `bytesWritten` 判断，超过 `MAX_BYTES`(1MB) 才真去 `statSync` 复核并**轮转**：`renameSync` 成 `whale-debug.log.1`（先 `unlinkSync` 旧 `.1`，Windows 下 rename 到已存在目标会失败）后主文件重建，只保留一份历史。**为什么轮转而非截断**：超限常由密集报错触发，截断会把第一现场冲掉；轮转保住「上一次会话的完整尾巴」。主文件若只剩轮转头（`split('\n').length <= 2`），`getDebugLog()` 改读 `.1`，免得用户报问题时只拿到一份空日志。②**日期**：模块加载（插件启动）时若文件 `mtimeMs` 超过 `KEEP_DAYS`(7 天)，视为陈旧日志直接清空重建。
    - **重复抑制（P2）**：同一处代码（`level` + 归一化消息）在 `SUPPRESS_WINDOW`(5s) 内反复失败只写首条，窗口过期后放行一条并在其前补一行「（上次同键又重复 N 次，已折叠）」。归一化抹掉 ISO 时间戳与裸数字（`duration_ms` / 行号 / 计时值每次都变，不归一化则抑制必然失效）。**只抑制落盘，控制台照样每条都打**（调试时需完整序列）。抑制表 `suppressed` 上限 `SUPPRESS_MAX_KEYS`(500)，超限整表清空（抑制只是省日志的优化，失忆无碍）。让「业务失败必须留痕」与「高频轮询不刷爆日志」不再冲突（如 `watchTick` 的 250ms 轮询）。
   - **⚠️ 落盘前必须脱敏（`sanitize`，v1.10.x）**：日志是**用户会主动贴出来取证**的，混进 API Key / token 就是真泄露。故 `write()` 顺序固定为 `stringify → sanitize → 建抑制键 → 落盘` —— **sanitize 必须在建抑制键之前**（否则抑制键按明文算，两条只差 token 的日志会被合并，脱敏后反而看不出是两次不同错误）。`sanitize` 链：① 家目录路径折叠成 `~`（`HOME_DIR`，不带用户名）；② **控制字符逐个按码点替换成空格**（`no-control-regex` 是 ESLint error 级，不能写 `[\u0000-\u001f]` 字符类；残留控制序列在别人机器上会显示成乱码）；③ 凭据掩码 —— `sk-` / `gh[pousr]_` / `npm_` / `Bearer` / 通用键值对五类。**掩码以更宽的规则为准**：`token=sk-abc…` 落成 `token=***` 而非 `token=sk-***`（键值对规则整段吃掉值），可接受且更安全，**不要为「好看」收窄规则**。短串有长度下限（`sk-` 后不足 8 位、`npm_` 后不足 16 位不掩），避免误伤普通词与版本号。

12. **uTools 8.0 的取舍**（8.0.0 于 2026-10-13 发布，底层 Electron 23→34 / Chromium 108→132 / Node 16→20；`utools-api-types` 随之升到 `8.0.0`）：
    - **素材目录不搬家，只修兜底**：8.0 官方建议「应用数据」（缓存 / 模型 / 外部命令行工具）放 `utools.getPluginLocalDataPath()`。本项目素材（`whale-skins` / `whale-sounds` / `whale-bubbles` / `whale-media` / `whale-bg`）自早期版本一直落 `utools.getPath('userData')`，**刻意不迁**：搬家等于让老用户已下载的几十 MB 素材凭空消失，换不来可见收益（实测 8.0.2 下 `getPath('userData')` 仍是 `%APPDATA%\uTools`，素材完好）。真正该修的是旧兜底「取不到 userData 就静默落 `os.tmpdir()`」—— 重启即丢且用户毫无感知。现统一走 `lib/data-dir.js`：`userData` → `getPluginLocalDataPath()` → `os.tmpdir()`（最后一级必 `logErr` 留痕）。**不要**把日志改到 `getPluginTempPath()`：它会被自动清理，排障证据随之消失。
    - **`getCmdHotKey(cmdLabel)`（8.0 新增）**：读指令当前绑定的全局快捷键，`cmdLabel` 与 `redirectHotKeySetting` 同一口径 —— **传 `plugin.json` 里 `features[].cmds` 的指令词（如「显示/隐藏挂件」），不是 feature 的 `code`**。设置页「使用帮助」与「挂件窗口」两卡用它显示「当前绑定：Ctrl+Shift+A / 未检测到」（`src/composables/useHotkey.ts`，`window` 获焦时重读一次）。7.x 没有该 API，宿主 `settings.getCmdHotKey` 一律回空串 —— 所以空值文案写「未检测到」而不是「未绑定」：**不能因为读到空就断言用户没绑**（旧版本上恒为空）。
    - **未接入**：`captureDisplay` / `utools.sharp` / `runFFmpeg`（本项目无截图、图像处理、转码需求，视频壁纸原样播放）；`requestSchedule` + `onScheduleTrigger`（可用于「插件未运行时也提醒待办」，但创建需用户逐条授权、频率未验证，暂缓）；`plugin.json` 的 `tools` + `registerTool`、`feature.mainPush` + `onMainPush`（可选新形态，未拍板）。

