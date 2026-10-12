/*
 * 出网请求的最小统一封装（CommonJS，零依赖叶子模块）。
 *
 * 只做三件事：① 统一超时（AbortSignal.timeout，真 abort，不像 Promise.race 只放弃等待）
 * ② 可选重试（只对「网络异常 / 5xx / 429」重试，4xx 立即放弃——用户填错 key 重试无意义）
 * ③ 结构化结果（ok / status / data / text / code / transient / error），错误归一化到 errMsg。
 *
 * ⚠️ 硬禁令（与 util.js 同口径）：本模块不得 require `log` / `utools` / `constants`，
 * 必须能在无 utools 桩下加载并可被单测直接 require。超时值由调用方传入（或用本文件
 * 的 DEFAULT_TIMEOUT_MS 兜底），本模块不引 constants，避免与地基产生依赖。
 *
 * ⚠️ 刻意不做的：in-flight 去重、TTL 缓存、多源竞速、总预算均摊。这四类语义与「超时+重试」
 * 正交（上游与本地均为分散手写），硬塞进来会让调用方被迫接受不合适的默认值；
 * 需要它们时在调用方按各自形态实现（如 api.js 的 balanceInFlight/balanceCache、
 * holidays.js 的总预算均摊）。本模块只统一「一次带超时和重试的 fetch」这一最原子的事。
 */
const { errMsg } = require('./util')

// 默认单次超时：仅当调用方没传 timeout 时兜底。各业务接口的实际超时值仍由调用方显式指定
// （余额 20s、模型 15s、探针 8s……差异真实存在，统一压成一个值反而会误伤慢接口）。
const DEFAULT_TIMEOUT_MS = 15000
// 重试间隔：固定退避（与本地既有 6 处 `setTimeout(500)` 口径一致）。
// 不用指数退避：本地重试最多 1 次，固定间隔已足够，引入退避反而增加用户等待的不确定性。
const RETRY_DELAY_MS = 500

// 是否「值得重试」：网络异常（fetch 抛错，含超时）一律重试；
// 5xx / 429 重试；其余 4xx（key 错、参数错）重试也是白重试，直接放弃。
function isRetriable(res) {
  if (!res || res.ok) return false
  return res.status >= 500 || res.status === 429
}

// 单次带超时的 fetch，返回统一结构。
// 注意：这里**不**读 body —— body 由调用方按需解析（json/text），因为失败路径的 body
// 读取语义各接口不同（有的要读 error.message、有的只读前 160 字符），封装层替调用方读会丢信息。
async function once(url, init, timeout) {
  try {
    const res = await fetch(url, Object.assign({}, init, { signal: AbortSignal.timeout(timeout) }))
    return { ok: true, res: res }
  } catch (err) {
    return { ok: false, error: errMsg(err) }
  }
}

// 统一出网入口。
//   url     请求地址
//   init    fetch 的第二个参数（headers / method / body …），会被本模块叠加 signal
//   opts.timeout   单次超时（ms），默认 DEFAULT_TIMEOUT_MS
//   opts.retries   额外重试次数（默认 0 = 只发一次）；总尝试次数 = retries + 1
//   opts.retryDelay 重试间隔（ms），默认 RETRY_DELAY_MS
//
// 返回：
//   2xx      → { ok:true, status, res }              （res 原样透出，由调用方 .json()/.text()）
//   非 2xx   → { ok:false, status, retriable, error:'HTTP <code>' }
//   网络/超时 → { ok:false, status:0, retriable:true, error:<errMsg> }
// 调用方据此决定 `err.error` 是否中文化后再展示。
async function request(url, init, opts) {
  const o = opts || {}
  const timeout = o.timeout || DEFAULT_TIMEOUT_MS
  const retries = Math.max(0, Math.round(o.retries) || 0)
  const delay = o.retryDelay === undefined ? RETRY_DELAY_MS : o.retryDelay
  let last = { ok: false, status: 0, retriable: true, error: '未知错误' }
  for (let attempt = 0; attempt <= retries; attempt++) {
    const r = await once(url, init, timeout)
    if (r.res) {
      if (r.res.ok) return { ok: true, status: r.res.status, res: r.res }
      last = { ok: false, status: r.res.status, retriable: isRetriable(r.res), error: 'HTTP ' + r.res.status }
    } else {
      last = { ok: false, status: 0, retriable: true, error: r.error }
    }
    // 不重试的情况：4xx（retriable=false）或已用尽次数
    if (!last.retriable || attempt === retries) break
    await new Promise((resolve) => setTimeout(resolve, delay))
  }
  return last
}

module.exports = {
  request,
  DEFAULT_TIMEOUT_MS,
  RETRY_DELAY_MS,
}
