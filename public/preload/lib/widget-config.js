/*
 * 下发给挂件页的配置视图（CommonJS）。
 *
 * 在 readConfig() 的归一化结果上额外挂 bubble.dft = 出厂默认队列（normBubble(null).items）：
 * 挂件在「自定义气泡未开启 / 未设置 / 初始默认」时按它渲染，显示与「未被用户改过的默认配置」
 * 完全一致；用户编辑过的 items 不能拿来顶替（否则关掉开关还在放改过的内容）。
 *
 * dft 只随 IPC 下发，不落存储：保存路径走 store 的 normBubble，未知键 dft 会被丢掉。
 *
 * v1.16 起额外删掉 focusGoal：它是「每日专注目标」，设置页的入口已下线，
 * 挂件页也不再画进度条。这里不下发，挂件侧就不会再有一份 `cfg.focusGoal` 的读取分支
 * （存储键仍保留在 store 里，数据不丢、日后要恢复只需去掉这行）。
 *
 * 单独成文件是因为 widget.js 卡在 1354 行棘轮上（scripts/check-file-size.mjs），
 * 新增能力不再往里加行。
 */
const { readConfig, normBubble } = require('./store')

module.exports = function configForWidget() {
  const cfg = readConfig()
  if (cfg.bubble && typeof cfg.bubble === 'object') {
    cfg.bubble = Object.assign({}, cfg.bubble, { dft: normBubble(null).items })
  }
  delete cfg.focusGoal
  return cfg
}
