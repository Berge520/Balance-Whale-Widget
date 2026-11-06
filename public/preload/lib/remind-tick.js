/*
 * 待办到点扫描的共用装配 + 双驱动去抖（CommonJS）。
 *
 * 为什么单独一层：
 *  - 扫描本体在 reminders.js（纯函数），原本的 IO 装配写在 services.js 里；
 *  - 现在挂件窗（可见、不被 Chromium 后台节流）也要按 30s 补一拍，两路驱动需要同一套装配；
 *  - 若让 ipc.js 直接 require services.js 就会成环（services → ipc 已在引），故抽到这里。
 * 依赖方向：只 require store / notify / api / reminders / log（全在 ipc 之下），
 * **刻意不引 ipc**；谁驱动谁把 sendWidgetCmd 当参数传进来。
 *
 * 为什么去抖状态放模块实例：
 * 主窗的 30s 表（services.js）与挂件窗上报的处理（ipc.js）跑在**同一个渲染进程**里，
 * 天然共享这一份状态 —— 两路同一瞬间到点只跑一次。
 *
 * 为什么真实依赖用函数内惰性 require：
 * 本模块顶层保持零 IO 依赖，单测可直接 require 并只测 createRemindTicker 的纯逻辑；
 * 同时 services.js 在启动路径上必加载本模块，惰性化也不会多付解析成本。
 */
const { log, logErr } = require('./log')

// 去抖阈值：2/3 个周期（20s）。
// 取它的依据：两路驱动的相位是任意的。若只取 10s，两路相位恰好差 10s 左右时会跑出
// ~10s 一拍（接近 3 倍节奏）；取 20s 后，两路同时健康也最多 20s 一拍（≤1.5 倍），
// 且任何单路正常的一拍（30s）都必然 ≥20s、不会被误吞。多出来的只是廉价的内存扫描
// （readTodo 同步读，不发网络），而提醒本身靠两套幂等位去重，不会因此重复通知。
const REMIND_TICK_DEBOUNCE_MS = 20000

// 工厂：依赖全部注入，时钟也注入（第三个参数），保证可无桩单测、不依赖真实定时器。
function createRemindTicker(deps) {
  const d = deps || {}
  let lastAt = 0
  return function tick(sendToWidget, source, now) {
    const at = typeof now === 'number' && Number.isFinite(now) ? now : Date.now()
    // 同进程内两路去抖：距上次不足 20s 直接跳过。
    // 时钟回拨（at < lastAt）时不吞拍，否则系统改时间后扫描会一直停摆到原时刻。
    if (lastAt && at >= lastAt && at - lastAt < REMIND_TICK_DEBOUNCE_MS) {
      return { skipped: true, fired: [] }
    }
    lastAt = at
    try {
      const cfg = d.readConfig()
      // 免打扰时段只弹挂件气泡，不弹系统通知 —— 与设置页「免打扰」的文案一致
      // （计时到点是用户主动设定的一次性提醒，不走这条，照常通知）
      const fired = d.runDueTick({
        now: at,
        readTodo: d.readTodo,
        writeTodo: d.writeTodo,
        notify: d.notify,
        sendToWidget: sendToWidget,
        cfg: cfg,
        silent: d.inQuietHours(cfg),
      })
      // 留痕：到点提醒是静默副作用，真机排查时只能靠日志确认扫到了、发了几条、哪路驱动扫的
      if (fired && fired.length) {
        d.log('[whale][remind] 到点提醒', {
          count: fired.length,
          ids: fired.map((x) => x.id),
          src: String(source || ''),
        })
      }
      return { skipped: false, fired: fired || [] }
    } catch (err) {
      d.logErr('[whale][remind] 到点扫描失败', err && err.message)
      return { skipped: false, fired: [] }
    }
  }
}

let realTicker = null
// 真实单例：首次调用时才装配 IO 依赖（见文件头「为什么惰性 require」）。
function runRemindTick(sendToWidget, source) {
  if (!realTicker) {
    const { readConfig, readTodo, writeTodo } = require('./store')
    const { notify } = require('./notify')
    const { inQuietHours } = require('./api')
    const { runDueTick } = require('./reminders')
    realTicker = createRemindTicker({ readConfig, readTodo, writeTodo, notify, inQuietHours, runDueTick, log, logErr })
  }
  return realTicker(sendToWidget, source)
}

module.exports = { REMIND_TICK_DEBOUNCE_MS, createRemindTicker, runRemindTick }
