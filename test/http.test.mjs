/*
 * http.js 出网封装单测（node --test，零依赖）。
 *
 * 本模块是零依赖叶子（不 require log / utools / constants），可直接 import 并用
 * globalThis.fetch 打桩，无需任何宿主桩。锁住四类行为：
 *   ① 2xx  → { ok:true, status, res }（res 原样透出，body 由调用方读）
 *   ② 4xx  → 不重试，只发一次（key 填错重试无意义，白等 500ms 是坑）
 *   ③ 5xx / 429 / 网络异常 / 超时 → 重试，重试用尽后返回最后一次的错误
 *   ④ 参数透传：自定义 timeout / retries / retryDelay 生效
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import http from '../public/preload/lib/http.js'

const { request, DEFAULT_TIMEOUT_MS, RETRY_DELAY_MS } = http

// 用瞬时完成的桩替换 fetch。handler 收到 (url, init)，返回一个 fetch 风格响应
// 或抛错（模拟网络异常）。retryDelay 传 0 让重试不必真等，测试跑得快。
function stubFetch(handler) {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init })
    return handler(url, init)
  }
  return {
    calls,
    restore() { globalThis.fetch = original },
  }
}

const okRes = (status = 200, body = '{}') => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => JSON.parse(body),
  text: async () => body,
})

test('2xx 透出 res，调用方可自行读 body', async () => {
  const s = stubFetch(() => okRes(200, '{"balance":"1"}'))
  try {
    const r = await request('https://example.com', {}, { retries: 0 })
    assert.equal(r.ok, true)
    assert.equal(r.status, 200)
    // res 必须原样透出（封装层不替调用方读 body）
    assert.equal(typeof r.res.json, 'function')
    assert.deepEqual(await r.res.json(), { balance: '1' })
    assert.equal(s.calls.length, 1)
  } finally {
    s.restore()
  }
})

test('4xx 不重试：只发一次即返回', async () => {
  const s = stubFetch(() => okRes(401))
  try {
    const r = await request('https://example.com', {}, { retries: 3, retryDelay: 0 })
    assert.equal(r.ok, false)
    assert.equal(r.status, 401)
    assert.equal(r.retriable, false)
    assert.equal(r.error, 'HTTP 401')
    assert.equal(s.calls.length, 1, '401 不该重试')
  } finally {
    s.restore()
  }
})

test('5xx 重试，用尽后返回最后一次状态', async () => {
  const s = stubFetch(() => okRes(503))
  try {
    const r = await request('https://example.com', {}, { retries: 2, retryDelay: 0 })
    assert.equal(r.ok, false)
    assert.equal(r.status, 503)
    assert.equal(r.retriable, true)
    assert.equal(s.calls.length, 3, 'retries=2 → 共 3 次尝试')
  } finally {
    s.restore()
  }
})

test('429 视为可重试（与 5xx 同档）', async () => {
  const s = stubFetch(() => okRes(429))
  try {
    const r = await request('https://example.com', {}, { retries: 1, retryDelay: 0 })
    assert.equal(r.status, 429)
    assert.equal(r.retriable, true)
    assert.equal(s.calls.length, 2)
  } finally {
    s.restore()
  }
})

test('网络异常重试，用尽后返回 status:0 的结构化错误', async () => {
  const s = stubFetch(() => { throw new Error('连接超时') })
  try {
    const r = await request('https://example.com', {}, { retries: 1, retryDelay: 0 })
    assert.equal(r.ok, false)
    assert.equal(r.status, 0)
    assert.equal(r.retriable, true)
    // 错误经 errMsg 归一化，必须是非空字符串（调用方可直接展示/判空）
    assert.equal(typeof r.error, 'string')
    assert.ok(r.error.length > 0)
    assert.equal(s.calls.length, 2)
  } finally {
    s.restore()
  }
})

test('5xx 后转成功：重试拿到 2xx 即返回成功', async () => {
  let n = 0
  const s = stubFetch(() => { n += 1; return n === 1 ? okRes(500) : okRes(200) })
  try {
    const r = await request('https://example.com', {}, { retries: 1, retryDelay: 0 })
    assert.equal(r.ok, true)
    assert.equal(r.status, 200)
    assert.equal(s.calls.length, 2)
  } finally {
    s.restore()
  }
})

test('超时走 AbortSignal.timeout：信号经 init 透传给 fetch', async () => {
  const s = stubFetch(() => okRes(200))
  try {
    await request('https://example.com', { method: 'POST' }, { timeout: 1234, retries: 0 })
    const init = s.calls[0].init
    assert.equal(init.method, 'POST', '调用方的 init 必须透传')
    assert.ok(init.signal, '必须叠加超时 signal')
    assert.equal(typeof init.signal.aborted, 'boolean')
  } finally {
    s.restore()
  }
})

test('retries 未传时默认不重试；负值/小数被归一', async () => {
  const s = stubFetch(() => okRes(500))
  try {
    await request('https://example.com', {})
    assert.equal(s.calls.length, 1, '默认 retries=0 → 只发一次')
    s.calls.length = 0
    await request('https://example.com', {}, { retries: -1 })
    assert.equal(s.calls.length, 1, '负 retries 归一为 0')
    s.calls.length = 0
    await request('https://example.com', {}, { retries: 1.4, retryDelay: 0 })
    assert.equal(s.calls.length, 2, '小数 retries 四舍五入为 1')
  } finally {
    s.restore()
  }
})

test('默认常量导出：timeout 与重试间隔为正数', () => {
  assert.equal(typeof DEFAULT_TIMEOUT_MS, 'number')
  assert.ok(DEFAULT_TIMEOUT_MS > 0)
  assert.equal(typeof RETRY_DELAY_MS, 'number')
  assert.ok(RETRY_DELAY_MS >= 0)
})
