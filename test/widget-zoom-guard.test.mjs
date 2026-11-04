/*
 * 挂件「拖动变大」的放大通道守卫（node --test，零依赖）。
 *
 * 窗口尺寸层面的放大已被两道锁覆盖（页面 wheel 判据 + 宿主 applyScaleToWindow 的 dragFrozen），
 * 但「整页视觉放大」还留了两条缝，症状同样是「拖着拖着变大了」，且 scale 读数与窗口尺寸都不变：
 *  1. 页面 wheel 在 dragLock / drag.active 分支直接 return，没有 preventDefault ——
 *     拖拽中按住 Ctrl 滚轮（或触控板捏合被派发成 ctrlKey+wheel），默认动作落到 Chromium
 *     的整页缩放上；
 *  2. preload 没关掉 Chromium 自带的视觉缩放通道（触控板捏合），页面可被整体放大并一直保持。
 *
 * 这里钉住加固后的形态：
 *  - 两个早退分支必须吃掉默认动作；
 *  - 菜单的判定要排在早退之前 —— 否则锁定位置时菜单里的滚轮滚动会被一并吞掉；
 *  - preload 锁定视觉缩放与布局缩放级别。
 *
 * ⚠️ 只读源码做契约断言（与 build-gates.test.mjs 同口径），不启动浏览器。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const read = (rel) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')

const page = read('public/floating-page.js')
const preload = read('public/preload/floating.js')

// 取 wheel 监听器本体（从注册到 { passive: false } 收尾），缩小断言范围，
// 免得别处的 preventDefault 被误当成这里的
function wheelHandlerSource() {
  const start = page.indexOf("document.addEventListener('wheel'")
  assert.ok(start >= 0, '找不到 wheel 监听器，解析规则可能已失效')
  const end = page.indexOf('}, { passive: false })', start)
  assert.ok(end > start, '找不到 wheel 监听器的收尾，解析规则可能已失效')
  return page.slice(start, end)
}

test('锁定位置时：滚轮早退前必须 preventDefault（否则 Ctrl+滚轮会整页缩放）', () => {
  const wheel = wheelHandlerSource()
  const at = wheel.search(/if \(dragLock\)/)
  assert.ok(at >= 0, '找不到 dragLock 早退分支')
  const block = wheel.slice(at, wheel.indexOf('if (drag && drag.active)', at))
  assert.match(block, /preventDefault/, 'dragLock 分支直接 return：Ctrl+滚轮会落到 Chromium 整页缩放')
})

test('拖拽中：滚轮早退前必须 preventDefault（触控板捏合最常落在这条）', () => {
  const wheel = wheelHandlerSource()
  const at = wheel.search(/if \(drag && drag\.active\)/)
  assert.ok(at >= 0, '找不到 drag.active 早退分支')
  const block = wheel.slice(at, wheel.indexOf('if (!isWhaleHit(e))', at))
  assert.match(block, /preventDefault/, 'drag.active 分支直接 return：拖拽时滚轮/捏合会整页缩放')
})

test('菜单判定排在早退之前：锁定位置时菜单内滚动不能被吞', () => {
  const wheel = wheelHandlerSource()
  const menuAt = wheel.indexOf('.dshwv-menu')
  const lockAt = wheel.search(/if \(dragLock\)/)
  assert.ok(menuAt >= 0, '找不到菜单判定')
  assert.ok(lockAt >= 0, '找不到 dragLock 早退分支')
  assert.ok(menuAt < lockAt, '菜单判定必须排在 dragLock 之前，否则锁定位置时菜单滚不动')
})

test('preload 锁定视觉缩放与布局缩放级别（触控板捏合 / Ctrl+滚轮）', () => {
  assert.match(preload, /setVisualZoomLevelLimits\(\s*1\s*,\s*1\s*\)/,
    '没锁视觉缩放：触控板捏合可以把挂件整页放大，且不会自己恢复')
  assert.match(preload, /setLayoutZoomLevelLimits\(\s*0\s*,\s*0\s*\)/,
    '没锁布局缩放级别：Ctrl+滚轮仍可能改变整页 zoomFactor')
})
