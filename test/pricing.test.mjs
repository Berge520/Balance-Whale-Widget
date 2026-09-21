/*
 * pricing.js 单测（node --test，零依赖）
 *
 * 只测纯函数：峰谷判定 / 下一个切换时刻 / 模型定价。
 * 这三处最容易错的是边界（整点前后、周末全天谷价、跨周末的切换时刻），
 * 而且它们被 api.js 用来算今日用量 —— 算错了不报错，只会把钱算错。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import pricing from '../public/preload/lib/pricing.js'
import constants from '../public/preload/lib/constants.js'

const { isPeakTime, nextPeakChangeAt, priceFor, customPriceTable, customModelPrice } = pricing
const { PRICING } = constants

// 北京时间某天某点 → epoch 秒（isPeakTime 内部按 UTC+8 还原回北京时间）
function bj(y, m, d, h, min = 0) {
  return Math.floor(Date.UTC(y, m - 1, d, h, min) / 1000) - 8 * 3600
}

// 2026-09-15 周二（已过 2026-08-23 周末谷价生效点）
test('工作日峰谷边界卡在整点', () => {
  assert.equal(isPeakTime(bj(2026, 9, 15, 0)), false)
  assert.equal(isPeakTime(bj(2026, 9, 15, 8, 59)), false)
  assert.equal(isPeakTime(bj(2026, 9, 15, 9)), true)
  assert.equal(isPeakTime(bj(2026, 9, 15, 11, 59)), true)
  assert.equal(isPeakTime(bj(2026, 9, 15, 12)), false)
  assert.equal(isPeakTime(bj(2026, 9, 15, 13, 59)), false)
  assert.equal(isPeakTime(bj(2026, 9, 15, 14)), true)
  assert.equal(isPeakTime(bj(2026, 9, 15, 17, 59)), true)
  assert.equal(isPeakTime(bj(2026, 9, 15, 18)), false)
  assert.equal(isPeakTime(bj(2026, 9, 15, 23, 59)), false)
})

test('2026-08-23 起周末全天谷价', () => {
  assert.equal(isPeakTime(bj(2026, 8, 23, 10)), false) // 周日
  assert.equal(isPeakTime(bj(2026, 8, 29, 15)), false) // 周六
  assert.equal(isPeakTime(bj(2026, 8, 30, 9)), false)  // 周日
  // 规则生效前一天（2026-08-22 周六）仍按工作日的峰谷算：常量卡在 08-23 00:00
  assert.equal(isPeakTime(bj(2026, 8, 22, 10)), true)
  assert.equal(isPeakTime(bj(2026, 8, 22, 10) - 1), true) // 08-22 09:59:59
  assert.equal(isPeakTime(bj(2026, 8, 23, 0)), false)     // 08-23 00:00 起
})

test('无效入参一律按谷时处理，不抛异常', () => {
  for (const v of [NaN, undefined, null, '', 'abc', Infinity]) {
    assert.equal(isPeakTime(v), false, String(v))
  }
})

// 法定节假日全天谷价：这些日子多为工作日，只按星期几判会把它们算成峰时、按双倍价记账。
test('法定节假日全天谷价（均为工作日）', () => {
  assert.equal(isPeakTime(bj(2026, 1, 1, 10)), false)  // 元旦（周四）
  assert.equal(isPeakTime(bj(2026, 5, 1, 10)), false)  // 劳动（周五）
  assert.equal(isPeakTime(bj(2026, 5, 4, 10)), false)  // 劳动调休（周一）
  assert.equal(isPeakTime(bj(2026, 10, 1, 10)), false) // 国庆（周四）
  assert.equal(isPeakTime(bj(2026, 10, 8, 15)), false) // 国庆末日（周四）
  assert.equal(isPeakTime(bj(2026, 2, 16, 9)), false)  // 春节除夕（周一）
  assert.equal(isPeakTime(bj(2026, 4, 6, 10)), false)  // 清明调休（周一）
  assert.equal(isPeakTime(bj(2026, 6, 19, 10)), false) // 端午（周五）
  assert.equal(isPeakTime(bj(2026, 9, 25, 10)), false) // 中秋（周五）
})

test('节假日表不误伤相邻工作日（边界前后仍是正常峰谷）', () => {
  // 元旦表末 01-03 周六（本就谷价）→ 之后 01-05 周一 10 点恢复正常峰时
  assert.equal(isPeakTime(bj(2026, 1, 5, 10)), true)
  // 劳动结束后的 05-06 周三 10 点 → 恢复峰时
  assert.equal(isPeakTime(bj(2026, 5, 6, 10)), true)
  // 国庆结束后的 10-09 周五 10 点 → 恢复峰时
  assert.equal(isPeakTime(bj(2026, 10, 9, 10)), true)
  // 节前一天仍是普通工作日：04-30 周四 10 点 → 峰时
  assert.equal(isPeakTime(bj(2026, 4, 30, 10)), true)
  // 节假日表的谷价是「全天」，非峰段时刻本来就是谷价
  assert.equal(isPeakTime(bj(2026, 5, 1, 3)), false)
})

test('节假日顺带把「下一个切换点」也算对（21:00 起跨完整个假期）', () => {
  // 劳动 05-05 周二 20 点 → 假期全天谷价，次日 05-06 周三 9:00 才转峰
  assert.equal(nextPeakChangeAt(bj(2026, 5, 5, 20)), bj(2026, 5, 6, 9))
  // 国庆 10-08 周四 20 点 → 次日 10-09 周五 9:00
  assert.equal(nextPeakChangeAt(bj(2026, 10, 8, 20)), bj(2026, 10, 9, 9))
})

test('nextPeakChangeAt 给出下一个整点边界', () => {
  // 峰时中 → 本段结束
  assert.equal(nextPeakChangeAt(bj(2026, 9, 15, 9, 30)), bj(2026, 9, 15, 12))
  assert.equal(nextPeakChangeAt(bj(2026, 9, 15, 11, 1)), bj(2026, 9, 15, 12))
  // 午休谷时 → 下午开工
  assert.equal(nextPeakChangeAt(bj(2026, 9, 15, 12, 30)), bj(2026, 9, 15, 14))
  // 晚间谷时 → 次日 9:00
  assert.equal(nextPeakChangeAt(bj(2026, 9, 15, 20)), bj(2026, 9, 16, 9))
  // 正好落在边界上 → 给的是下一个边界
  assert.equal(nextPeakChangeAt(bj(2026, 9, 15, 9)), bj(2026, 9, 15, 12))
  assert.equal(nextPeakChangeAt(bj(2026, 9, 15, 12)), bj(2026, 9, 15, 14))
  // 周五收盘后 → 下周一 9:00（周六周日全天谷价，要跨过去）
  assert.equal(nextPeakChangeAt(bj(2026, 9, 18, 18, 30)), bj(2026, 9, 21, 9))
  // 周日全天谷价 → 仍是下周一 9:00
  assert.equal(nextPeakChangeAt(bj(2026, 9, 20, 10)), bj(2026, 9, 21, 9))
  // 无效入参 → 0
  assert.equal(nextPeakChangeAt(NaN), 0)
  assert.equal(nextPeakChangeAt('x'), 0)
})

test('priceFor 按子串命中定价，未知回落默认价', () => {
  assert.equal(priceFor('deepseek-v4-pro'), PRICING['deepseek-v4-pro'])
  assert.equal(priceFor('deepseek-v4-flash'), PRICING['deepseek-v4-flash'])
  assert.equal(priceFor('deepseek-chat'), PRICING['deepseek-chat'])
  assert.equal(priceFor('deepseek-reasoner'), PRICING['deepseek-reasoner'])
  assert.equal(priceFor('DeepSeek-V4-Pro'), PRICING['deepseek-v4-pro']) // 大小写不敏感
  assert.equal(priceFor('some-proxy/deepseek-v4-pro-0711'), PRICING['deepseek-v4-pro']) // 子串匹配
  assert.equal(priceFor('gpt-4o'), PRICING._default)
  assert.equal(priceFor(''), PRICING._default)
  assert.equal(priceFor(undefined), PRICING._default)
})

test('每个定价键都能被自身命中（防键名写错永远回落默认价）', () => {
  for (const key of Object.keys(PRICING)) {
    if (key === '_default') continue
    assert.equal(priceFor(key), PRICING[key], key)
  }
})

test('自定义单价：谷价翻倍成峰价，美元按汇率折成人民币', () => {
  const base = { on: true, cur: 'CNY', rate: 7.2, hit: 0.5, miss: 2, out: 8 }
  // 开关关着 / 没填 → 返回 null，调用方回落内置价目表
  assert.equal(customPriceTable(null), null)
  assert.equal(customPriceTable(undefined), null)
  assert.equal(customPriceTable({ ...base, on: false }), null)
  // 人民币：填的是谷价，峰价 = 谷价 × 2
  assert.deepEqual(customPriceTable(base), { hit: [0.5, 1], miss: [2, 4], out: [8, 16] })
  // 美元：单价 × 汇率（账本统一按人民币记账）
  assert.deepEqual(customPriceTable({ on: true, cur: 'USD', rate: 7, hit: 1, miss: 2, out: 3 }),
    { hit: [7, 14], miss: [14, 28], out: [21, 42] })
  // 美元却没给可用汇率 → null：宁可回落内置价目表，也不能把美元数额当人民币记进账本
  assert.equal(customPriceTable({ on: true, cur: 'USD', rate: 0, hit: 1, miss: 1, out: 1 }), null)
  assert.equal(customPriceTable({ on: true, cur: 'USD', rate: NaN, hit: 1, miss: 1, out: 1 }), null)
  // 0 是合法单价（该项不收费）；负数/非数字按 0 处理
  assert.deepEqual(customPriceTable({ on: true, cur: 'CNY', hit: 0, miss: -1, out: 'abc' }),
    { hit: [0, 0], miss: [0, 0], out: [0, 0] })
})

test('按模型覆盖的单价：子串命中即用，未命中回落 null（调用方继续看全局覆盖与内置表）', () => {
  const cfg = {
    on: false, cur: 'CNY', rate: 7.2, hit: 0.02, miss: 1, out: 4,
    models: [
      { name: 'deepseek-v4-pro', hit: 0.15, miss: 4.5, out: 13.5 },
      { name: 'deepseek-v4-flash-vision-exp', hit: 0.02, miss: 1, out: 4 },
    ],
  }
  // 全局开关关着也生效：只想改某几档模型的价时不必整表覆盖
  assert.deepEqual(customModelPrice(cfg, 'deepseek-v4-pro'), { hit: [0.15, 0.3], miss: [4.5, 9], out: [13.5, 27] })
  // 子串匹配，与内置价目表同规则；顺序即优先级（先命中的先用）
  assert.deepEqual(customModelPrice(cfg, 'deepseek-v4-pro-2026'), { hit: [0.15, 0.3], miss: [4.5, 9], out: [13.5, 27] })
  assert.deepEqual(customModelPrice(cfg, 'DEEPSEEK-V4-FLASH-VISION-EXP'), { hit: [0.02, 0.04], miss: [1, 2], out: [4, 8] })
  // 没列出的模型 / 空模型名 / 没配条目 → null，调用方回落内置价目表
  assert.equal(customModelPrice(cfg, 'deepseek-chat'), null)
  assert.equal(customModelPrice(cfg, ''), null)
  assert.equal(customModelPrice(cfg, null), null)
  assert.equal(customModelPrice({ ...cfg, models: [] }, 'deepseek-v4-pro'), null)
  assert.equal(customModelPrice(null, 'deepseek-v4-pro'), null)
  // 空名条目不该命中所有模型（宿主归一化时也会丢掉它，这里再兜一层）
  assert.equal(customModelPrice({ ...cfg, models: [{ name: '', hit: 9, miss: 9, out: 9 }] }, 'deepseek-chat'), null)
  // 美元按汇率折算；汇率不可用 → null（宁可回落内置表，也不能把美元数额当人民币记账）
  assert.deepEqual(customModelPrice({ ...cfg, cur: 'USD', rate: 7 }, 'deepseek-v4-pro'),
    { hit: [1.05, 2.1], miss: [31.5, 63], out: [94.5, 189] })
  assert.equal(customModelPrice({ ...cfg, cur: 'USD', rate: 0 }, 'deepseek-v4-pro'), null)
})
