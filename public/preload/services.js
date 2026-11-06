/*
 * 小鲸鱼余额挂件 · 主窗宿主 preload 入口（CommonJS，不可压缩混淆）
 *
 * 本文件只负责装配，具体实现按职责拆分在 ./lib/*.js：
 *  constants.js  常量（含构建期写入的 PLUGIN_VERSION）
 *  log.js        dev 日志门控
 *  pricing.js    DeepSeek 峰谷定价
 *  store.js      配置/密钥/账本/锚点持久化
 *  api.js        余额与平台用量拉取、更新检查
 *  widget.js     悬浮窗创建、几何、置顶、消息推送
 *  ipc.js        悬浮窗 ↔ 宿主 IPC 路由
 *  settings.js   对外 window.services（设置页 API）
 */
const { log, logErr, LOG_FILE } = require('./lib/log')
const { readConfig, patchConfig, alertFor, alertOneLine } = require('./lib/store')
const { notify } = require('./lib/notify')
const { checkUpdate } = require('./lib/api')
const { ensureWidget, toggleWidget, pushConfig, dispose: disposeWidget } = require('./lib/widget')
const { registerIpc, sendWidgetCmd } = require('./lib/ipc')
const { runRemindTick } = require('./lib/remind-tick')

// dsh 一族（dsh / dsh-market / dsh-export / dsh-backup / dsh-usage / ...）合计 300KB+，
// 而启动路径上只在「插件进程真正退出」时才用得到 stopOnQuit()。顶层 require 会把这整片
// 模块的求值都压进 preload 加载阶段，直接拖慢首帧。改成用到时再加载：退出清理是异步时机，
// 那时再付解析成本完全来得及。
function dshModule() { return require('./lib/dsh') }

// 当前 preload 所处窗口类型：main=主窗 / detach=分离窗 / browser=createBrowserWindow 窗口
function winType() {
  try { return utools.getWindowType() } catch (err) { return 'unknown' }
}

// ──────────────────────────────────────────────
// 对外 API（设置页）
// ──────────────────────────────────────────────
// settings.js(153KB) 连带 hosts.js(88KB) 一片，只在设置页所在的窗口里才用得到；
// 悬浮窗走的是 floating.js（另一份 preload），根本不需要 window.services。
// 顶层无条件 require 会让这两片在**每次** preload 加载时都求值，包括创建挂件窗口时 ——
// 那是高频路径（每次「显示挂件」都走）。这里按窗口类型惰性挂载，非设置页窗口不付这份解析成本。
//
// 惰性 getter：保持 window.services 的「属性访问即取用」语义不变（设置页里 `window.services.xxx`
// 与解构写法都照常工作），只是把 require 推迟到真正被读取的那一刻。
function isSettingsWindow() {
  const t = winType()
  return t === 'main' || t === 'detach'
}
let settingsMod = null
function getSettings() {
  if (!settingsMod) settingsMod = require('./lib/settings')
  return settingsMod
}
if (isSettingsWindow()) {
  try {
    Object.defineProperty(window, 'services', {
      configurable: true,
      enumerable: true,
      get: getSettings,
    })
  } catch (err) { logErr('[whale][boot] 挂载 window.services 失败', err && err.message) }
}
// 供 passthrough 分支等内部使用：主窗才有意义，其它窗口返回 null
function settingsApiOrNull() { return isSettingsWindow() ? getSettings() : null }

// ──────────────────────────────────────────────
// 待办到点提醒：30s 轮询（主窗兜底表）
// ──────────────────────────────────────────────
// 判定全部在 lib/reminders.js（纯函数），装配与双驱动去抖在 lib/remind-tick.js。
// 这里只负责「主窗的兜底表」：进插件时启动 + 立刻补扫一次（插件不在期间错过的也补一次），
// 真退出时停表。为什么还要这层：挂件窗没建 / 已销毁 / 被隐藏时挂件驱动就没有了，只能靠它。
// 主窗被隐藏后这张表会被 Chromium 后台节流成 60s（真机日志实测），这正是挂件驱动要补的洞。
// 到点只提醒（通知 + 挂件气泡），不自动开始计时。
let remindTimer = null
function startReminders() {
  stopReminders()
  const tick = () => runRemindTick(sendWidgetCmd, 'main')
  tick() // 启动补扫：插件不在期间错过的也补一次
  remindTimer = setInterval(tick, 30000)
}
function stopReminders() {
  if (remindTimer) { clearInterval(remindTimer); remindTimer = null }
}

// 启动横幅：dev 下写入 %TEMP%\whale-debug.log（进程被杀不丢，用于事后排查生命周期问题）
log('[whale][boot] preload 已加载', { windowType: winType(), logFile: LOG_FILE || '(仅控制台)' })

// ──────────────────────────────────────────────
// IPC 路由
// ──────────────────────────────────────────────
try {
  registerIpc()
} catch (err) { logErr('[whale][ipc] 注册失败', err && err.message) }

// ──────────────────────────────────────────────
// 插件生命周期
// ──────────────────────────────────────────────
try {
  utools.onPluginEnter((action) => {
    const code = action && action.code
    log('[whale][lifecycle] onPluginEnter', { code, from: (action && action.from) || '', windowType: winType() })
    // 待办到点扫描对所有入口都适用：热键只切挂件 / 穿透 / 刷新等会提前 return，
    // 不能只在默认分支起表。延后一帧起，别抢启动那几帧。
    setTimeout(function () {
      try { startReminders() } catch (err) { logErr('[whale][remind] 启动扫描失败', err && err.message) }
    }, 0)
    // 「切换挂件」指令：通常由全局快捷键触发（feature.mainHide 使搜索框不弹出）
    if (code === 'whale-toggle') {
      toggleWidget()
      return
    }
    // 「切换鼠标穿透」指令：为穿透态留一条不依赖设置页的逃生通道 ——
    // 穿透后挂件连自己的菜单都点不到，若进入方式是「只显示挂件」，用户只能靠这条指令
    // （或重新搜索进入设置页）关掉它。同样 mainHide，可绑全局快捷键一键进出一秒切换。
    if (code === 'whale-passthrough') {
      const cfg = readConfig()
      const next = !cfg.passThrough
      patchConfig({ passThrough: next })
      pushConfig()
      // 设置页开着时同步开关状态（emitConfigChange 只在本窗口有订阅者时生效）
      try { settingsApiOrNull()?.emitConfigChange() } catch (err) {}
      // 系统通知：穿透态下气泡可能被计时/峰谷占用，这条保证用户一定得到反馈。
      // 文案取设置页的「提醒文案」模板（与气泡同一份），换行合并成一行
      notify(alertOneLine(alertFor(cfg, next ? 'passOn' : 'passOff')), cfg)
      return
    }
    // 「刷新余额」指令：强制重新拉取余额并推送到挂件（跳过缓存）。
    // 走快捷指令队列而不是这里直接推：窗口可能刚建、页面还没 ready，直接 sendToWidget 会丢；
    // 页面收到指令后自己发 whale:refresh（manual=true），与菜单按钮同一条路径
    if (code === 'whale-refresh') {
      ensureWidget({ focus: true })
      sendWidgetCmd('refresh-balance')
      return
    }
    // 「计时器」指令：切换计时器的运行/暂停/启动状态
    if (code === 'whale-timer') {
      ensureWidget({ focus: true })
      sendWidgetCmd('timer-toggle')
      return
    }
    // 「专注统计」指令：在挂件气泡区显示今日专注摘要
    if (code === 'whale-focus') {
      ensureWidget({ focus: true })
      sendWidgetCmd('show-focus')
      return
    }
    // 「打开设置」兜底入口：挂件菜单在「显示挂件」模式下用 utools.redirect('余额挂件') 重定向进入。
    // 本插件所有 feature 都设了 mainHide:true（防挂件抢焦前主窗闪烁），
    // uTools 不会自动弹主窗，所以这里在重定向入口显式 showMainWindow
    // （重定向已让插件重新激活，此时主窗可被唤回）；不触碰挂件。
    // 官方类型定义里该值写作 "reirect"（疑为文档笔误），两种拼写都兼容。
    const from = (action && action.from) || ''
    if (from === 'redirect' || from === 'reirect') {
      try { utools.showMainWindow() } catch (err) { logErr('[whale][lifecycle] showMainWindow 失败', err && err.message) }
      return
    }
    // 默认功能（whale）：按「进入方式」决定主窗与挂件的显隐。
    // 注意：whale 这个 feature 已设 mainHide:true —— 进入插件时 uTools 不再自动弹出主窗
    // （避免「主窗闪一下被挂件抢焦点自动隐藏」的闪烁），改由这里按需显式唤出。
    // 合并后「小鲸鱼设置」这类别名已移除（官方建议每个 feature 的 cmds 不超过 5 个，
    // 故 whale 用 5 个词覆盖「余额挂件 / 小鲸鱼 / DeepSeek / Harness」几类搜法），
    // 设置页入口只剩：enterMode = settings/both，或挂件菜单的 redirect 兜底（见上方 redirect 分支）。
    const mode = readConfig().enterMode
    if (mode === 'settings') {
      // 只显示设置窗口：显式唤出主窗，全程不创建挂件
      try { utools.showMainWindow() } catch (err) { logErr('[whale][lifecycle] showMainWindow 失败', err && err.message) }
    } else if (mode === 'widget') {
      // 显示挂件：挂件窗口以 focusable:true 创建/显示，一显示就抢走前台焦点，
      // uTools 主窗（设置窗）随即失焦并按原生行为自动隐藏 —— 不需要任何隐藏窗口的 API。
      // feature.mainHide 只阻止 uTools「自动弹出主搜索框」，对已经显示 / 已分离的主窗无效，
      // 所以这里靠「夺焦 → 失焦自动隐藏」，而不是 outPlugin()/hideMainWindow()：
      //   - outPlugin() 会把插件退出到后台，之后挂件菜单的「打开设置」(showMainWindow)
      //     唤不回主窗，且 enterMode 仍是 widget，会陷入再也进不去设置界面的死循环；
      //   - hideMainWindow() 会连带隐藏 createBrowserWindow 的窗口（见 widget.js 注释）。
      ensureWidget({ focus: true })
    } else {
      // both：挂件不夺焦（focusable:false），保持主窗焦点不被抢走，再把主窗唤回，两者同时可见
      ensureWidget({ focus: false })
      setTimeout(function () { try { utools.showMainWindow() } catch (err) {} }, 250)
    }
    // 自动检查更新：开关关闭时跳过；仅新拉取到的结果触发一次通知
    try {
      if (readConfig().updateCheckOn) {
        checkUpdate(false).then((r) => {
          if (r && r.ok && r.fresh && r.hasUpdate) {
            // 文案与设置页「立即检查更新」的结果行保持一致，都指向插件市场更新
            notify('发现新版本 v' + r.latest + '（当前 v' + r.current + '），可在插件市场更新', readConfig())
          }
        })
      }
    } catch (err) { logErr('[whale][update] 自动检查更新失败', err && err.message) }
  })
} catch (err) { logErr('[whale][lifecycle] 注册 onPluginEnter 失败', err && err.message) }

// 插件退出：挂件是常驻桌面的独立窗口，任何时候都不在这里 destroyWidget()。
// 真机实测：关闭已分离的设置窗口会触发 onPluginOut(isKill=true) —— 分离窗承载主界面，
// 关掉即插件结束，uTools 会自行关闭本插件 createBrowserWindow 创建的窗口，无需我们销毁。
// 否则「关窗顺手销毁挂件」会把挂件一起关掉 —— 这正是此前的 bug。
// isKill=false 只对应隐藏 / 退出到后台，那时挂件仍在桌面，更不能动它。
// 窗口若被关闭/隐藏，winAlive() 会判为失效或不可见，下一次 ensureWidget() 自动重建。
try {
  utools.onPluginOut((isKill) => {
    log('[whale][lifecycle] onPluginOut', { isKill, windowType: winType() })
    // 到点扫描只在本插件进程真正退出（isKill=true）时停表：此时挂件会被 uTools 一起关掉，
    // 停表不会有副作用。isKill=false 只对应隐藏 / 后台驻留，那时挂件仍在桌面，
    // 停掉扫描会让到点提醒再也不响（此前「关一次设置窗提醒就没了」就是这个原因）。
    // 真正退出后下次 onPluginEnter 会重起并补扫一次。若发现表已停（旧版本遗留状态），补起即可。
    if (isKill) {
      stopReminders()
    } else if (!remindTimer) {
      try { startReminders() } catch (err) { logErr('[whale][remind] 恢复扫描失败', err && err.message) }
    }
    // 插件进程真正结束（isKill=true，含关闭已分离的设置窗口）时按「保留 dsh」开关决定是否结束 dsh，
    // 避免留下孤进程占着 3080。isKill=false 只对应隐藏 / 后台驻留，插件还活着，不能动 dsh。
    if (isKill) {
      // 只 require 一次再取两项：dsh 一族 300KB+，两次 dshModule() 虽命中 Node 缓存但读起来像两条路径
      let dsh = null
      try { dsh = dshModule() } catch (err) { logErr('[whale][dsh] 加载退出清理失败', err && err.message) }
      try { if (dsh) dsh.stopOnQuit() } catch (err) { logErr('[whale][dsh] 退出清理失败', err && err.message) }
      // 端口探测闸门：在飞的一轮若不复位，probe.busy 会永久为 true（见 dsh.js 的 resetProbe）
      try { if (dsh) dsh.resetProbe() } catch (err) { logErr('[whale][dsh] 复位端口探测失败', err && err.message) }
      // 挂件侧的宿主定时器（任务栏轮询 / 兜底显示 / 实时缩放帧槽位）。不销毁窗口 —— uTools 自己会收
      try { disposeWidget() } catch (err) { logErr('[whale][widget] 退出清理失败', err && err.message) }
      // codex 的补扫定时器：5s 后才触发，退出时若还挂着会白扫一轮全量
      try { require('./lib/codex').dispose() } catch (err) { logErr('[whale][codex] 退出清理失败', err && err.message) }
    }
  })
} catch (err) { logErr('[whale][lifecycle] 注册 onPluginOut 失败', err && err.message) }

// 插件被分离为独立窗口时触发，仅用于日志（真机实测：Ctrl+D 注入不会触发本事件；实际分离走顶部 ⋮ 菜单的「分离为独立窗口」）
try {
  utools.onPluginDetach(() => {
    log('[whale][lifecycle] onPluginDetach 已分离为独立窗口', { windowType: winType() })
  })
} catch (err) { logErr('[whale][lifecycle] 注册 onPluginDetach 失败', err && err.message) }
