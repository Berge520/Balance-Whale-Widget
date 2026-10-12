/*
 * api.js 取余额相关纯函数的单测（node --test，零依赖）。
 *
 * 只测「取错值不抛错、只会把钱显示错」的两处：
 *   pickBalanceInfo —— 接口同时给多种币种时的挑选优先级
 *   pickPath / pathNum —— 字段路径解析（a.b[0].c 与 a[currency=CNY].b）
 * balance_infos 会同时给多种币种且顺序不固定（上游明确踩过的坑）：按下标取可能拿到
 * 美元余额，金额不报错、只是显示错，所以这里必须把行为锁住。
 *
 * 另含 modelMoney（金额文案）与三条网络链路的错误映射（用 globalThis.fetch 打桩）：
 *   fetchBalanceWith / fetchPlatformUsage / fetchModelBalance —— 这些把上游的 HTTP 状态
 *   归一成用户可读的中文 error 与 code，映射错会让用户看到「字段路径取不到数值」这类
 *   误导提示（或把 401 当成网络抖动反复重试），故用机器钉住。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import api from '../public/preload/lib/api.js'
import constants from '../public/preload/lib/constants.js'

const { pickBalanceInfo, pickPath, pathNum } = api
const { modelMoney, fetchBalanceWith, fetchPlatformUsage, fetchModelBalance } = api
const { MODEL_TEMPLATES } = constants

// DeepSeek /user/balance 的真实形状：两条币种，顺序不保证
const usdFirst = [
  { currency: 'USD', total_balance: '12.34' },
  { currency: 'CNY', total_balance: '88.60' },
]
const cnyFirst = [...usdFirst].reverse()

test('pickBalanceInfo 优先人民币，不被数组顺序带偏', () => {
  assert.equal(pickBalanceInfo(usdFirst).currency, 'CNY')
  assert.equal(pickBalanceInfo(cnyFirst).currency, 'CNY')
  assert.equal(pickBalanceInfo(usdFirst).total_balance, '88.60')
})

test('pickBalanceInfo 逐级回落：有余额的 → 人民币 → 第一项', () => {
  // 人民币为 0、美元有余额 → 取美元（显示一条 0 元没有意义）
  assert.equal(pickBalanceInfo([
    { currency: 'CNY', total_balance: '0.00' },
    { currency: 'USD', total_balance: '5.00' },
  ]).currency, 'USD')
  // 两条都取不到正数 → 退到人民币那一条
  assert.equal(pickBalanceInfo([
    { currency: 'USD', total_balance: '0.00' },
    { currency: 'CNY', total_balance: '0.00' },
  ]).currency, 'CNY')
  // 没有人民币条目 → 退到第一项
  assert.equal(pickBalanceInfo([{ currency: 'USD', total_balance: '0.00' }]).currency, 'USD')
  // 非数组 / 空数组 → null（调用方据此报「结构异常」）
  assert.equal(pickBalanceInfo(null), null)
  assert.equal(pickBalanceInfo(undefined), null)
  assert.equal(pickBalanceInfo([]), null)
  assert.equal(pickBalanceInfo({}), null)
})

test('pickPath 解析 a.b[0].c，也能按字段挑条目', () => {
  const body = {
    balance_infos: usdFirst,
    data: { limits: [{ TOKENS_LIMIT: { percentage: 42 } }] },
  }
  assert.equal(pickPath(body, 'data.limits[0].TOKENS_LIMIT.percentage'), 42)
  assert.equal(pickPath(body, 'balance_infos[currency=CNY].total_balance'), '88.60')
  assert.equal(pickPath(body, 'balance_infos[currency=USD].total_balance'), '12.34')
  // 条件没有匹配项 → undefined（调用方会提示「字段取不到数值」，比静默取错币种好）
  assert.equal(pickPath(body, 'balance_infos[currency=JPY].total_balance'), undefined)
  // 多重下标
  assert.equal(pickPath({ a: [[1, 2]] }, 'a[0][1]'), 2)
})

test('pickPath 遇缺失段 / 空路径 / 类型不符一律返回 undefined', () => {
  assert.equal(pickPath({ a: 1 }, 'a.b'), undefined)      // 中间段不是对象
  assert.equal(pickPath({}, 'a.b.c'), undefined)          // 首段就不存在
  assert.equal(pickPath({ a: { b: 1 } }, ''), undefined)
  assert.equal(pickPath({ a: { b: 1 } }, null), undefined)
  assert.equal(pickPath(null, 'a'), undefined)
  assert.equal(pickPath({ a: 1 }, 'a[0]'), undefined)     // 非数组却写下标
  assert.equal(pickPath({ a: [1] }, 'a[x]'), undefined)   // 下标既不是数字也不是条件
})

test('pathNum 把「取到空值」与「取到 0」区分开', () => {
  assert.equal(pathNum({ a: '12.34' }, 'a'), 12.34)
  assert.equal(pathNum({ a: 0 }, 'a'), 0)
  assert.equal(pathNum({ a: '0' }, 'a'), 0)
  // 空串 / null / 缺字段都当「没取到」：Number('') 是 0，直接用会把空值误判成 0
  assert.ok(Number.isNaN(pathNum({ a: '' }, 'a')))
  assert.ok(Number.isNaN(pathNum({ a: null }, 'a')))
  assert.ok(Number.isNaN(pathNum({ a: undefined }, 'a')))
  assert.ok(Number.isNaN(pathNum({}, 'a')))
  assert.ok(Number.isNaN(pathNum({ a: 'abc' }, 'a')))
})

test('内置 DeepSeek 模板的字段路径取到人民币余额（防写回下标）', () => {
  const body = { balance_infos: usdFirst }
  assert.equal(pathNum(body, MODEL_TEMPLATES.deepseek.path), 88.6)
  // 反过来排也要一样
  assert.equal(pathNum({ balance_infos: cnyFirst }, MODEL_TEMPLATES.deepseek.path), 88.6)
})

test('pickPath 条件段支持 & 多条件与 | 多值', () => {
  const limits = [
    { type: 'TIME_LIMIT', unit: 3, percentage: 10 },
    { type: 'TOKENS_LIMIT', unit: 3, percentage: 42 },
    { type: 'TOKENS_LIMIT', unit: 6, percentage: 7 },
    { type: 'CREDIT_LIMIT', unit: 3, percentage: 55 },
  ]
  const body = { data: { limits } }
  // & 与 | 组合：type 二选一 + unit 精确匹配；多条匹配时取数组里第一条（find 语义）
  const firstMatch = (arr, unit) => arr.find((it) =>
    (it.type === 'TOKENS_LIMIT' || it.type === 'CREDIT_LIMIT') && it.unit === unit)
  for (const rotated of [limits, [...limits].reverse(), [limits[2], limits[0], limits[3], limits[1]]]) {
    assert.equal(pathNum({ data: { limits: rotated } }, 'data.limits[type=TOKENS_LIMIT|CREDIT_LIMIT&unit=3].percentage'), firstMatch(rotated, 3).percentage)
    assert.equal(pathNum({ data: { limits: rotated } }, 'data.limits[type=TOKENS_LIMIT|CREDIT_LIMIT&unit=6].percentage'), firstMatch(rotated, 6).percentage)
  }
  // 多条件取不到时仍是 undefined；值列表全不匹配也一样
  assert.equal(pickPath(body, 'data.limits[type=TOKENS_LIMIT&unit=9].percentage'), undefined)
  assert.equal(pickPath(body, 'data.limits[type=NOPE|NAH].percentage'), undefined)
  // 只有 & 没有值的空段（如 a[&]）当条件非法处理
  assert.equal(pickPath(body, 'data.limits[&].percentage'), undefined)
})

test('智谱模板按 type+unit 挑条目解析双窗口（防写回下标）', () => {
  // 实测形状：pro 账号 limits[0] 是 TIME_LIMIT —— 旧路径 data.limits[0].TOKENS_LIMIT.* 必然取空
  const body = {
    data: {
      level: 'pro',
      limits: [
        { type: 'TIME_LIMIT', unit: 3, percentage: 10, nextResetTime: '2026-10-03T18:00:00+08:00' },
        { type: 'TOKENS_LIMIT', unit: 3, percentage: 42.5, nextResetTime: '2026-10-03T18:00:00+08:00' },
        { type: 'TOKENS_LIMIT', unit: 6, percentage: 7.5, nextResetTime: '2026-10-05T00:00:00+08:00' },
      ],
    },
  }
  for (const tplName of ['zhipu_glm_coding', 'zhipu_glm_coding_intl']) {
    const tpl = MODEL_TEMPLATES[tplName]
    assert.ok(Array.isArray(tpl.windows) && tpl.windows.length === 2, tplName + ' 应是双窗口模板')
    // start plan 账号查这个接口必然业务报错，提示语必须跟着模板走（api.js fetchModelJson 拼 errorHint）
    assert.ok(tpl.errorHint && tpl.errorHint.includes('Coding Plan'), tplName + ' 应带 start plan 定向提示')
    const fiveHour = tpl.windows.find((w) => w.key === 'rolling')
    const weekly = tpl.windows.find((w) => w.key === 'weekly')
    assert.equal(pathNum(body, fiveHour.usedPctPath), 42.5)
    // 重置时刻是 ISO 字符串，由 quotaWindow 里 normResetAt 归一成毫秒，这里只验证路径能取到原文
    assert.equal(pickPath(body, fiveHour.resetPath), '2026-10-03T18:00:00+08:00')
    assert.equal(pickPath(body, weekly.resetPath), '2026-10-05T00:00:00+08:00')
    assert.equal(pathNum(body, weekly.usedPctPath), 7.5)
    // 新注册/credit 制账号：type 换成 CREDIT_LIMIT 也能取到
    const creditBody = { data: { limits: [{ type: 'CREDIT_LIMIT', unit: 3, percentage: 55 }] } }
    assert.equal(pathNum(creditBody, fiveHour.usedPctPath), 55)
  }
})

test('modelBusinessError 提炼业务层错误（HTTP 200 但 body 报错）', () => {
  const { modelBusinessError } = api
  assert.equal(modelBusinessError({ success: false, msg: '当前用户不存在coding plan' }), '当前用户不存在coding plan')
  assert.equal(modelBusinessError({ ok: false, message: 'forbidden' }), 'forbidden')
  assert.equal(modelBusinessError({ code: 1002, msg: '令牌无效' }), '令牌无效')
  assert.equal(modelBusinessError({ error: { message: 'no plan' } }), 'no plan')
  assert.equal(modelBusinessError({ error: 'quota exceeded' }), 'quota exceeded')
  // success=false 且 error 是 {message}：不许吐 '[object Object]'
  assert.equal(modelBusinessError({ success: false, error: { message: 'no plan' } }), 'no plan')
  assert.equal(modelBusinessError({ success: false }), 'success=false')
  // 正常响应 / code=0 / code=200 / 纯数据体都不能误报
  assert.equal(modelBusinessError({ code: 0, msg: 'ok', data: {} }), '')
  assert.equal(modelBusinessError({ code: 200, msg: 'ok', data: {} }), '')
  assert.equal(modelBusinessError({ data: { limits: [] } }), '')
  assert.equal(modelBusinessError(null), '')
  assert.equal(modelBusinessError('str'), '')
  // 超长错误截到 120 字符
  assert.equal(modelBusinessError({ success: false, msg: 'x'.repeat(300) }).length, 120)
})

// ──────────────────────────────────────────────
// modelMoney：金额文案（前缀取错会让 ¥ 变成 $）
// ──────────────────────────────────────────────
test('modelMoney 按币种加前缀，未知币种退回数值 + 代码', () => {
  assert.equal(modelMoney(12.34, 'CNY'), '¥ 12.34')
  assert.equal(modelMoney(12.34, 'USD'), '$12.34')
  // 其它币种：数值 + 空格 + 币种代码（不做符号映射）
  assert.equal(modelMoney(12.34, 'EUR'), '12.34 EUR')
  // 缺币种：数字后跟空币种，不抛错（调用方保证 currency 一定有值，这里只做兜底）
  assert.equal(modelMoney(12.34, ''), '12.34 ')
  // 非数值 / 空 → 0.00（不抛错，旧实现直接用 Number 可能吐 NaN）
  assert.equal(modelMoney('abc', 'CNY'), '¥ 0.00')
  assert.equal(modelMoney(null, 'CNY'), '¥ 0.00')
  assert.equal(modelMoney(undefined, 'USD'), '$0.00')
  // 负数（欠费）保留符号
  assert.equal(modelMoney(-3.5, 'CNY'), '¥ -3.50')
})

// ──────────────────────────────────────────────
// 网络链路：用 globalThis.fetch 打桩，锁住错误映射
// ──────────────────────────────────────────────
function stubFetch(handler) {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    return handler(url, init)
  }
  return { calls, restore() { globalThis.fetch = original } }
}
const okRes = (status = 200, body = '{}') => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => JSON.parse(body),
  text: async () => body,
})
// 网络异常：fetch 抛错（http.request 归为 status:0）
const netErr = () => { throw new Error('fetch failed') }

test('fetchBalanceWith 无 key / 格式错：不发请求直接返回', async () => {
  const s = stubFetch(() => okRes(200))
  try {
    const noKey = await fetchBalanceWith('')
    assert.equal(noKey.ok, false)
    assert.equal(noKey.code, 'NO_KEY')
    const bad = await fetchBalanceWith('sk-中文 空格')
    assert.equal(bad.ok, false)
    assert.equal(bad.code, 'BAD_KEY')
    assert.equal(bad.transient, false)
    // 两种前缀校验都在发请求前拦截
    assert.equal(s.calls.length, 0)
  } finally { s.restore() }
})

test('fetchBalanceWith 2xx：选人民币、归一字段', async () => {
  const body = JSON.stringify({
    balance_infos: [
      { currency: 'USD', total_balance: '12.34', granted_balance: '0', topped_up_balance: '12.34' },
      { currency: 'CNY', total_balance: '88.60', granted_balance: '8.60', topped_up_balance: '80.00' },
    ],
  })
  const s = stubFetch(() => okRes(200, body))
  try {
    const r = await fetchBalanceWith('sk-abc')
    assert.equal(r.ok, true)
    assert.equal(r.totalBalance, 88.6)
    assert.equal(r.grantedBalance, 8.6)
    assert.equal(r.toppedUpBalance, 80)
    assert.equal(r.currency, 'CNY')
    assert.ok(typeof r.updatedAt === 'string')
    // Bearer 头带上 key
    assert.equal(s.calls[0].init.headers.Authorization, 'Bearer sk-abc')
  } finally { s.restore() }
})

test('fetchBalanceWith 401：AUTH 且不重试，标准中文提示', async () => {
  let n = 0
  const s = stubFetch(() => { n++; return okRes(401, JSON.stringify({ error: { message: 'invalid key' } })) })
  try {
    const r = await fetchBalanceWith('sk-abc')
    assert.equal(r.ok, false)
    assert.equal(r.code, 'AUTH')
    assert.equal(r.transient, false)
    assert.ok(r.error.includes('401'))
    // 401 属 4xx：绝不该重试（重试也是白等）
    assert.equal(n, 1)
  } finally { s.restore() }
})

test('fetchBalanceWith 其它 4xx：HTTP 且不重试', async () => {
  let n = 0
  const s = stubFetch(() => { n++; return okRes(400, JSON.stringify({ error: { message: 'bad req' } })) })
  try {
    const r = await fetchBalanceWith('sk-abc')
    assert.equal(r.code, 'HTTP')
    assert.equal(r.transient, false)
    assert.ok(r.error.includes('400'))
    assert.equal(n, 1)
  } finally { s.restore() }
})

test('fetchBalanceWith 5xx：重试一次后仍失败 → HTTP/transient', async () => {
  let n = 0
  const s = stubFetch(() => { n++; return okRes(503, JSON.stringify({ error: { message: 'maintenance' } })) })
  try {
    const r = await fetchBalanceWith('sk-abc')
    assert.equal(r.code, 'HTTP')
    assert.equal(r.transient, true)
    assert.ok(r.error.includes('503'))
    // retries:1 → 共 2 次
    assert.equal(n, 2)
  } finally { s.restore() }
})

test('fetchBalanceWith 网络异常：status 0 → 网络口径、transient、重试一次', async () => {
  let n = 0
  const s = stubFetch(() => { n++; return netErr() })
  try {
    const r = await fetchBalanceWith('sk-abc')
    assert.equal(r.ok, false)
    assert.equal(r.code, 'HTTP')
    assert.equal(r.transient, true)
    assert.ok(r.error.includes('网络'))
    assert.equal(n, 2)
  } finally { s.restore() }
})

test('fetchBalanceWith body 非 JSON → PARSE；结构异常 → SHAPE', async () => {
  const s1 = stubFetch(() => okRes(200, 'not json'))
  try {
    const r = await fetchBalanceWith('sk-abc')
    assert.equal(r.code, 'PARSE')
    assert.equal(r.transient, false)
  } finally { s1.restore() }
  const s2 = stubFetch(() => okRes(200, JSON.stringify({ balance_infos: [{ currency: 'CNY' }] })))
  try {
    const r = await fetchBalanceWith('sk-abc')
    assert.equal(r.code, 'SHAPE')
  } finally { s2.restore() }
})

test('fetchPlatformUsage 无 token / 空态硬契约', async () => {
  const s = stubFetch(() => okRes(200, JSON.stringify({ data: { series: [] } })))
  try {
    const no = await fetchPlatformUsage('', null)
    assert.equal(no.ok, false)
    assert.equal(no.code, 'NO_TOKEN')
    assert.equal(s.calls.length, 0)
    // 连通但当天无消耗 → 硬契约 { error: 'no usage' }（调用方按它判空列表）
    const empty = await fetchPlatformUsage('sk-abc', null)
    assert.deepEqual(empty, { error: 'no usage' })
    // Bearer 前缀应被剥掉，Authorization 里只有裸 token
    assert.equal(s.calls[0].init.headers.Authorization, 'Bearer sk-abc')
  } finally { s.restore() }
})

test('fetchPlatformUsage 401 → AUTH；网络异常 → NET', async () => {
  const s1 = stubFetch(() => okRes(401, JSON.stringify({ error: { message: 'expired' } })))
  try {
    const r = await fetchPlatformUsage('sk-abc', null)
    assert.equal(r.code, 'AUTH')
    assert.equal(r.transient, false)
    assert.ok(r.error.includes('401'))
  } finally { s1.restore() }
  const s2 = stubFetch(() => netErr())
  try {
    const r = await fetchPlatformUsage('sk-abc', null)
    assert.equal(r.code, 'NET')
    assert.equal(r.transient, true)
  } finally { s2.restore() }
})

test('fetchModelBalance 未配 key / 地址异常：发请求前拦截', async () => {
  const s = stubFetch(() => okRes(200))
  try {
    const noKey = await fetchModelBalance({ kind: 'balance', url: 'https://x.com' }, '')
    assert.equal(noKey.ok, false)
    assert.ok(noKey.error.includes('未配置'))
    // url 含 {base} 但未配 baseUrl：resolveModelUrl 把 {base} 替成空串 → 地址不以 http(s) 开头
    const noBase = await fetchModelBalance({ kind: 'balance', url: '{base}/balance' }, 'k')
    assert.equal(noBase.ok, false)
    assert.ok(noBase.error.includes('http(s)'))
    // 非 http(s)
    const badUrl = await fetchModelBalance({ kind: 'balance', url: 'ftp://x.com' }, 'k')
    assert.equal(badUrl.ok, false)
    assert.ok(badUrl.error.includes('http(s)'))
    assert.equal(s.calls.length, 0)
  } finally { s.restore() }
})

test('fetchModelBalance 401/403 → 无效或无权限；其它 4xx → HTTP', async () => {
  const s1 = stubFetch(() => okRes(401))
  try {
    const r = await fetchModelBalance({ kind: 'balance', url: 'https://x.com/b' }, 'k')
    assert.equal(r.ok, false)
    assert.ok(r.error.includes('401'))
  } finally { s1.restore() }
  const s2 = stubFetch(() => okRes(403))
  try {
    const r = await fetchModelBalance({ kind: 'balance', url: 'https://x.com/b' }, 'k')
    assert.ok(r.error.includes('403'))
  } finally { s2.restore() }
  const s3 = stubFetch(() => okRes(404))
  try {
    const r = await fetchModelBalance({ kind: 'balance', url: 'https://x.com/b' }, 'k')
    assert.ok(r.error.includes('404'))
  } finally { s3.restore() }
})

test('fetchModelBalance balance 型：路径取值 + scale，取不到报路径', async () => {
  const s = stubFetch(() => okRes(200, JSON.stringify({ data: { balance: '12.5' } })))
  try {
    const r = await fetchModelBalance({ kind: 'balance', url: 'https://x.com/b', path: 'data.balance', scale: 1 }, 'k')
    assert.equal(r.ok, true)
    assert.equal(r.balance, 12.5)
  } finally { s.restore() }
  // 路径取不到 → 明确报路径，不静默算成 0
  const s2 = stubFetch(() => okRes(200, JSON.stringify({ data: {} })))
  try {
    const r = await fetchModelBalance({ kind: 'balance', url: 'https://x.com/b', path: 'data.balance', scale: 1 }, 'k')
    assert.equal(r.ok, false)
    assert.ok(r.error.includes('data.balance'))
  } finally { s2.restore() }
})

test('fetchModelBalance quota 型：窗口归一为 usedPct/resetAt', async () => {
  const body = JSON.stringify({ data: { limits: [{ type: 'TOKENS_LIMIT', unit: 3, percentage: 42.5 }] } })
  const s = stubFetch(() => okRes(200, body))
  try {
    const r = await fetchModelBalance({ kind: 'quota', url: 'https://x.com/q', usedPctPath: 'data.limits[0].percentage' }, 'k')
    assert.equal(r.ok, true)
    assert.equal(r.usedPct, 42.5)
    assert.ok(Array.isArray(r.windows) && r.windows.length === 1)
  } finally { s.restore() }
})

test('fetchModelBalance 业务报错：200 但 body 报错 → 提炼原文，模板带定向提示', async () => {
  const s = stubFetch(() => okRes(200, JSON.stringify({ success: false, msg: '当前用户不存在coding plan' })))
  try {
    const tpl = MODEL_TEMPLATES.zhipu_glm_coding
    const r = await fetchModelBalance({ kind: 'quota', url: 'https://x.com/q', tpl: 'zhipu_glm_coding', usedPctPath: 'data.limits[0].percentage' }, 'k')
    assert.equal(r.ok, false)
    assert.ok(r.error.includes('当前用户不存在coding plan'))
    // 模板的 errorHint 必须拼进去（告诉用户是套餐形态不匹配，不是他填错）
    assert.ok(r.error.includes(tpl.errorHint))
  } finally { s.restore() }
})

test('fetchModelBalance codex 型：不发请求，走本地统计', async () => {
  const s = stubFetch(() => { throw new Error('不应发请求') })
  try {
    // 无 utools 桩时 codexSummary 会失败 —— 只要它是 ok:false 而非抛错即可
    const r = await fetchModelBalance({ kind: 'codex' }, '')
    assert.equal(r.ok, false)
    assert.equal(s.calls.length, 0)
  } finally { s.restore() }
})
