/*
 * 常量集中定义（CommonJS）。
 *
 * 注意：PLUGIN_VERSION 由 scripts/sync-version.mjs 在构建前从 package.json 的
 * version 自动写入本文件，请勿手动维护。
 */
const BALANCE_URL = 'https://api.deepseek.com/user/balance'
const USAGE_URL = 'https://platform.deepseek.com/api/v0/usage/by_api_key/amount'
const BALANCE_TTL_MS = 25000
const FETCH_TIMEOUT_MS = 20000

// 检查更新：拉取远端 package.json（经 ghfast 加速），只取 version 字段做比对
const UPDATE_CHECK_URL = 'https://ghfast.top/https://raw.githubusercontent.com/Berge520/Balance-Whale-Widget/refs/heads/main/package.json'
// 当前插件版本。uTools 未提供读取插件自身版本的 API，此处由 scripts/sync-version.mjs
// 在构建前从 package.json 的 version 自动写入，无需手动维护
const PLUGIN_VERSION = '1.2.0'
const UPDATE_TTL_MS = 12 * 3600 * 1000

const MIN_SCALE = 0.6
const MAX_SCALE = 2.5
const BASE_MIN = 122   // 挂件基准尺寸下限 px
const BASE_CAP = 250   // 视口相关基准上限 px
const BASE_MAX = 625   // 挂件基准尺寸硬上限 px
// 窗口比挂件本体多出的透明留白 px：汉堡菜单在按钮上方展开，窗口必须大于挂件本体，
// 否则菜单会被窗口边缘裁掉。留白区全透明，靠 setIgnoreMouseEvents 点击穿透。
// 必须与 floating.css 里的 --whale-pad 保持一致。
const WIN_PAD = 200

// DeepSeek CNY 价格（每百万 token）：[空闲时段价, 高峰时段价]
// 高峰：工作日 9:00–12:00、14:00–18:00（北京时间）；2026-08-23 起周末全天谷价
const PEAK_HOURS = [[9, 12], [14, 18]]
const BASE_PRICE = { hit: [0.05, 0.1], miss: [1.5, 3.0], out: [4.5, 9.0] }
const PRO_PRICE = { hit: [0.15, 0.3], miss: [4.5, 9.0], out: [13.5, 27.0] }
const PRICING = {
  'deepseek-v4-flash-vision-exp': BASE_PRICE,
  'deepseek-v4-flash': BASE_PRICE,
  'deepseek-v4-pro': PRO_PRICE,
  'deepseek-chat': BASE_PRICE,
  'deepseek-reasoner': BASE_PRICE,
  _default: BASE_PRICE,
}
// = 北京时间 2026-08-23 00:00
const WEEKEND_VALLEY_FROM_SEC = Math.floor(Date.UTC(2026, 7, 22, 16, 0, 0) / 1000)

const K = {
  secrets: 'whale:secrets', // dbCryptoStorage：{ apiKey, platformToken }
  config: 'whale:config',   // dbStorage：挂件配置
  ledger: 'whale:ledger',   // dbStorage：本地账本
  win: 'whale:window',      // dbStorage：窗口锚点
  update: 'whale:update',   // dbStorage：上次检查更新结果缓存
  timer: 'whale:timer',     // dbStorage：计时状态（重建挂件后恢复）
}

module.exports = {
  BALANCE_URL,
  USAGE_URL,
  BALANCE_TTL_MS,
  FETCH_TIMEOUT_MS,
  UPDATE_CHECK_URL,
  PLUGIN_VERSION,
  UPDATE_TTL_MS,
  MIN_SCALE,
  MAX_SCALE,
  BASE_MIN,
  BASE_CAP,
  BASE_MAX,
  WIN_PAD,
  PEAK_HOURS,
  PRICING,
  WEEKEND_VALLEY_FROM_SEC,
  K,
}
