/*
 * 平台用量接口（fetchPlatformUsage）三态语义回归（node --test，零依赖）。
 *
 * 契约：调用方（getTodayModels / testPlatformToken）只认三态 ——
 *   ① 成功：有 amount（+ tokens / byModel）
 *   ② 空态：error === 'no usage'（接口连通、当天没消耗）—— 这个字面量是硬契约，不许改
 *   ③ 失败：其余 error，且**必须是中文人话**，不得把 'http 401' 这种英文码甩给用户
 *
 * 背景（为什么钉这么细）：
 *   · 曾把 ② 当失败透传 → 设置页「今日模型占比」显示「读取失败：no usage」，用户以为坏了；
 *   · 曾把 ③ 原样返回 → 显示「读取失败：http 401」，同样是英文码，用户看不懂。
 *   两条都是静默误报/难懂型，靠单测钉住最省心。
 *
 * settings.js 顶层 require 了 log.js（→ utools.getPath），先挂桩再 require。
 * 数据链：readSecrets 读 dbCryptoStorage.getItem(K.secrets) 取 platformToken；
 * 因此这里让该桩对任意键都返回带 platformToken 的对象。fetch 桩由 setFetch 按用例切换。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import { createRequire } from 'node:module'

// ── utools 桩：cryptoStorage 回带 platformToken 的对象，让调用走到联网分支 ──
globalThis.utools = {
  getPath: () => os.tmpdir(),
  dbStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  dbCryptoStorage: {
    getItem: () => ({ platformToken: 'pt-test-token' }),
    setItem: () => {},
    removeItem: () => {},
  },
}

// ── fetch 桩：可切换。默认 200 + 空 series（当天无用量）──
let lastUrl = ''
const fetchStub = { impl: null }
globalThis.fetch = async (url, opts) => {
  lastUrl = String(url)
  return fetchStub.impl(url, opts)
}
const okEmpty = () => ({
  ok: true, status: 200,
  json: async () => ({ data: { biz_data: { series: [] } } }),
  text: async () => '',
})
const okWithUsage = () => ({
  ok: true, status: 200,
  json: async () => ({ data: { biz_data: { series: [
    { model: 'deepseek-chat', buckets: [{ time: 12, usage: { RESPONSE_TOKEN: 1000000, PROMPT_CACHE_HIT_TOKEN: 0, PROMPT_CACHE_MISS_TOKEN: 0 } }] },
  ] } } }),
  text: async () => '',
})
const httpErr = (status, body = '') => ({
  ok: false, status,
  json: async () => ({}),
  text: async () => body,
})
const badJson = () => ({
  ok: true, status: 200,
  json: async () => { throw new SyntaxError('bad json') },
  text: async () => '',
})
const netErr = () => { throw new TypeError('fetch failed') }

const require = createRequire(import.meta.url)
const settings = require('../public/preload/lib/settings.js')

function setFetch(impl) { fetchStub.impl = impl }

// ────────────────────────── ② 空态 ──────────────────────────
test('空态：接口连通但当天无用量 → getTodayModels 返回 ok:true 空列表（非「读取失败」）', async () => {
  setFetch(okEmpty)
  const r = await settings.getTodayModels()
  assert.equal(r.ok, true, 'no usage 应判为空态，不得当作失败')
  assert.deepEqual(r.models, [])
  assert.equal(r.amount, 0)
  assert.equal(r.tokens, 0)
  assert.equal(r.error, undefined, '空态不应带 error，前端才会显示「今日暂无用量记录」')
  assert.ok(lastUrl.includes('start='), '应请求平台用量接口，实际 URL：' + lastUrl)
})

test('空态：testPlatformToken 同样把 no usage 归为空态（empty:true）', async () => {
  setFetch(okEmpty)
  const r = await settings.testPlatformToken('pt-test-token')
  assert.equal(r.empty, true)
  assert.equal(r.amount, 0)
  assert.equal(r.error, undefined)
})

// ────────────────────────── ① 成功 ──────────────────────────
test('成功：有数据时 getTodayModels 回 models 且无 error', async () => {
  setFetch(okWithUsage)
  const r = await settings.getTodayModels()
  assert.equal(r.ok, true)
  assert.ok(Array.isArray(r.models) && r.models.length === 1)
  assert.equal(r.models[0].model, 'deepseek-chat')
  assert.ok(r.amount > 0, '深聊 miss 100 万 token 应算出正金额')
  assert.equal(r.error, undefined)
})

// ────────────────────────── ③ 失败：必须中文人话 ──────────────────────────
test('失败：401 → 中文提示且点名「平台 Token 无效」，不得出现英文码 http 401', async () => {
  setFetch(() => httpErr(401, '{"error":"unauthorized"}'))
  const r = await settings.getTodayModels()
  assert.equal(r.ok, false)
  assert.match(r.error, /平台 Token/)
  assert.ok(!/^http \d/i.test(r.error), '错误文本不应是英文码开头，实际：' + r.error)
  assert.ok(!/no platform token/.test(r.error))
})

test('失败：500 → 中文「暂时不可用 / 稍后重试」', async () => {
  setFetch(() => httpErr(500))
  const r = await settings.getTodayModels()
  assert.equal(r.ok, false)
  assert.match(r.error, /不可用|稍后重试/)
  assert.ok(!/^http \d/i.test(r.error), '实际：' + r.error)
})

test('失败：网络异常超时 → 中文网络提示', async () => {
  setFetch(netErr)
  const r = await settings.getTodayModels()
  assert.equal(r.ok, false)
  assert.match(r.error, /网络|连接/)
  assert.ok(!/fetch failed/.test(r.error), '不得透出原始异常文本，实际：' + r.error)
})

test('失败：响应非合法 JSON → 中文解析提示', async () => {
  setFetch(badJson)
  const r = await settings.getTodayModels()
  assert.equal(r.ok, false)
  assert.match(r.error, /JSON/)
})

test('失败：未配置平台 Token → 明确中文提示，不与空态混淆', async () => {
  const orig = globalThis.utools.dbCryptoStorage.getItem
  globalThis.utools.dbCryptoStorage.getItem = () => ({ platformToken: '' })
  try {
    const r = await settings.getTodayModels()
    assert.equal(r.ok, false)
    assert.equal(r.error, '未配置平台 Token')
  } finally {
    globalThis.utools.dbCryptoStorage.getItem = orig
  }
})

test('契约：失败态一律不含英文码 no platform token', async () => {
  for (const impl of [() => httpErr(401), () => httpErr(500), netErr, badJson]) {
    setFetch(impl)
    const r = await settings.getTodayModels()
    assert.equal(r.ok, false)
    assert.ok(!/no platform token/.test(String(r.error)), '实际：' + r.error)
  }
})
