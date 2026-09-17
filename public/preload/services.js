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
const { checkUpdate } = require('./lib/api')
const { ensureWidget, toggleWidget, pushConfig } = require('./lib/widget')
const { registerIpc } = require('./lib/ipc')
const dsh = require('./lib/dsh')

// 当前 preload 所处窗口类型：main=主窗 / detach=分离窗 / browser=createBrowserWindow 窗口
function winType() {
  try { return utools.getWindowType() } catch (err) { return 'unknown' }
}

// ──────────────────────────────────────────────
// 对外 API（设置页）
// ──────────────────────────────────────────────
window.services = require('./lib/settings')
const settingsApi = window.services

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
      try { settingsApi.emitConfigChange() } catch (err) {}
      // 系统通知：穿透态下气泡可能被计时/峰谷占用，这条保证用户一定得到反馈。
      // 文案取设置页的「提醒文案」模板（与气泡同一份），换行合并成一行
      try {
        utools.showNotification(alertOneLine(alertFor(cfg, next ? 'passOn' : 'passOff')), 'whale')
      } catch (err) { logErr('[whale][lifecycle] 穿透切换通知失败', err && err.message) }
      return
    }
    // 「打开设置」兜底入口：挂件菜单在「显示挂件」模式下用 utools.redirect('余额挂件') 重定向进入。
    // 本插件仅剩 whale / whale-toggle 两个 feature 且都设了 mainHide:true（防挂件抢焦前主窗闪烁），
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
    // 合并后「小鲸鱼设置」这类别名已移除（uTools 建议每个 feature 的 cmds ≤ 5，故 whale 保留原 5 个），
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
    // 自动检查更新：开关关闭时跳过；仅新拉取到的结果触发一次系统通知
    try {
      if (readConfig().updateCheckOn) {
        checkUpdate(false).then((r) => {
          if (r && r.ok && r.fresh && r.hasUpdate) {
            try {
              utools.showNotification('小鲸鱼余额挂件有新版本 v' + r.latest + '（当前 v' + r.current + '）', 'whale')
            } catch (err) { logErr('[whale][update] 发送更新通知失败', err && err.message) }
          }
        })
      }
    } catch (err) { logErr('[whale][update] 自动检查更新失败', err && err.message) }
  })
} catch (err) { logErr('[whale][lifecycle] 注册 onPluginEnter 失败', err && err.message) }

// 插件退出：挂件是常驻桌面的独立窗口，任何时候都不在这里 destroyWidget()。
// 否则「关闭（已分离的）设置窗口」触发 onPluginOut 时会把挂件一起关掉 —— 这正是此前的 bug。
// 进程真正结束（isKill=true）时 uTools 会自行关闭本插件 createBrowserWindow 创建的窗口，
// 无需我们销毁；若窗口已被 uTools 关闭/隐藏，winAlive() 会判为失效或不可见，
// 下一次 ensureWidget() 会自动重建，不依赖这里的销毁来「清理失效引用」。
try {
  utools.onPluginOut((isKill) => {
    log('[whale][lifecycle] onPluginOut', { isKill, windowType: winType() })
    // 插件进程真正结束（isKill=true）时按「保留 dsh」开关决定是否结束 dsh，避免留下孤进程占着 3080。
    // 关闭已分离的设置窗口也会触发 onPluginOut，但那种情况 isKill=false，不能动 dsh。
    if (isKill) {
      try { dsh.stopOnQuit() } catch (err) { logErr('[whale][dsh] 退出清理失败', err && err.message) }
    }
  })
} catch (err) { logErr('[whale][lifecycle] 注册 onPluginOut 失败', err && err.message) }

// 用户把插件从搜索框分离为独立窗口（Ctrl+D）时触发，仅用于日志
try {
  utools.onPluginDetach(() => {
    log('[whale][lifecycle] onPluginDetach 已分离为独立窗口', { windowType: winType() })
  })
} catch (err) { logErr('[whale][lifecycle] 注册 onPluginDetach 失败', err && err.message) }
