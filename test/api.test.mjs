/*
 * api.js 取余额相关纯函数的单测（node --test，零依赖）。
 *
 * 只测「取错值不抛错、只会把钱显示错」的两处：
 *   pickBalanceInfo —— 接口同时给多种币种时的挑选优先级
 *   pickPath / pathNum —— 字段路径解析（a.b[0].c 与 a[currency=CNY].b）
 * balance_infos 会同时给多种币种且顺序不固定（上游明确踩过的坑）：按下标取可能拿到
 * 美元余额，金额不报错、只是显示错，所以这里必须把行为锁住。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import api from '../public/preload/lib/api.js'
import constants from '../public/preload/lib/constants.js'

const { pickBalanceInfo, pickPath, pathNum } = api
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
