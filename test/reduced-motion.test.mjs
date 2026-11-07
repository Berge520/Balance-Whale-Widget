/*
 * 「减少动态效果」降级的回归钉（node --test，零依赖）。
 *
 * 三处样式表各自服务不同文档，任何一处漏掉都会让该界面无视系统设置：
 *   - src/main.css：设置页全局过渡 + 装饰性卡片 / 引导动画；
 *   - public/floating.css：挂件菜单、按钮、面板位移的过渡；
 *   - public/floating-bubble.css：气泡展开与余额变动抖动 / 弹跳。
 * 同时钉住「功能动效保留」：倒计时脉冲的既有降级块不得被删或重复改写，
 * 否则要么状态提示消失，要么同一规则出现两份、后续维护改一处忘一处。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const read = (rel) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')

test('设置页：全局过渡压到 1ms，装饰性卡片 / 引导动画关闭', () => {
  const css = read('src/main.css')
  const block = css.match(
    /@media \(prefers-reduced-motion: reduce\) \{\n {2}\*,\n {2}\*::before[\s\S]*?transition-duration: 1ms !important;[\s\S]*?\n\}/,
  )
  assert.ok(block, 'main.css 缺少全局「减少动态效果」降级块')
  assert.match(block[0], /transition-delay: 0s !important/)
  assert.match(block[0], /scroll-behavior: auto !important/)
  assert.match(block[0], /\.card\.search-flash[\s\S]*?animation: none !important;/)
})

test('挂件：菜单 / 按钮 / 面板过渡压到 1ms，且不碰鲸鱼呼吸与专注脉冲', () => {
  const css = read('public/floating.css')
  const block = css.match(
    /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.dshwv-root \*[\s\S]*?transition-duration: 1ms !important;[\s\S]*?\n {2}\}/,
  )
  assert.ok(block, 'floating.css 缺少全局「减少动态效果」降级块')
  assert.doesNotMatch(block[0], /whale-breathe|focus-pulse/, '功能动效不应被这条降级块关闭')
})

test('气泡：余额变动抖动 / 弹跳不播，倒计时脉冲的既有降级只有一份', () => {
  const css = read('public/floating-bubble.css')
  assert.match(
    css,
    /\.dshwv-amount\.dshwv-flash-down,\s*\.dshwv-amount\.dshwv-flash-up \{ animation: none; \}/,
  )
  // 功能动效仍在（保留状态提示），且既有降级块没有被重复写第二份
  assert.match(css, /animation: dshwv-offwork-pulse 1\.8s ease-in-out infinite;/)
  const pulse = css.match(/\.dshwv-root\.dshwv-offwork-imminent \.dshwv-amount \{ animation: none; \}/g) || []
  assert.equal(pulse.length, 1, '倒计时脉冲的降级块出现多份或已消失')
})
