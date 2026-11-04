// test/offwork-render.test.mjs
// 下班倒计时接管「常规三行」时，余额错误的说明后缀必须持续可见。
//
// 真机问题：render() 会把 hint 拼成 `offworkView.hint + ' · 余额获取失败'`，但
// 每秒的 applyOffworkView 判等键只含 label/main/hint/near，不含错误后缀；
// 下一秒 main 变化 → 重绘 → setHint(ov.hint) 把后缀覆盖掉，错误提示只活 1 秒。
// 修法：让后缀进入 offworkKeyOf，并让两条写说明行的路径共用同一个后缀函数。
// 本文件钉住这三处，防止以后有人「简化」判等键又把错误提示弄丢。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const page = fs.readFileSync(new URL('../public/floating-page.js', import.meta.url), 'utf8')

test('倒计时：余额错误后缀只在 error 态出现，且只有一处定义', () => {
  assert.match(
    page,
    /function offworkErrorSuffix\(\) \{\s*return state\.status === 'error' \? ' · 余额获取失败' : '';/,
  )
  // 后缀文案只允许在 offworkErrorSuffix 里拼一次：两处各拼一份迟早会漂移
  assert.equal(page.match(/state\.status === 'error' \? ' · 余额获取失败'/g).length, 1)
})

test('倒计时：错误后缀参与判等键，error 期间不会被每秒 tick 覆盖', () => {
  // offworkKeyOf 必须带上后缀（否则 applyOffworkView 重绘时会用裸 ov.hint 覆盖）
  assert.match(
    page,
    /function offworkKeyOf\(ov\) \{\s*return ov\.label \+ '\|' \+ ov\.main \+ '\|' \+ ov\.hint \+ '\|' \+ \(ov\.near \|\| ''\) \+ offworkErrorSuffix\(\);/,
  )
  // render() 的 key 仍走 offworkKeyOf，开秒（main 每秒变）与关秒（main 每分钟变）都因此带上后缀
  assert.match(page, /offworkLastKey = offworkKeyOf\(offworkView\)/)
  // 两条写说明行的路径共用同一个后缀：render 首绘 + 每秒 tick 的重绘
  assert.match(page, /hint = offworkView\.hint \+ offworkErrorSuffix\(\)/)
  assert.match(page, /setHint\(ov\.hint \+ offworkErrorSuffix\(\)\)/)
})

test('倒计时：error 恢复后后缀消失，下一帧自动清掉', () => {
  // 后缀是 key 的一部分 → 状态从 error 变正常时 key 变化，下一次 apply 就会重写说明行；
  // 这里只钉「key 含有随状态变化的量」，不重复实现一套判断逻辑
  assert.match(page, /function offworkKeyOf\(ov\) \{[^}]*offworkErrorSuffix\(\)/)
})
