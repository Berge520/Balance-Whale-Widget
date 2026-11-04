/*
 * 过期计时恢复策略的源码契约单测（node --test，零依赖）。
 *
 * 旧行为：重载后只要 endAt 已过就一律 finishTimer() —— 哪怕隔了三天。
 * 于是会补响一次铃、补弹一条「时间到」、把早已放弃的轮次记进专注统计，
 * 还会自动衔接休息。这里钉住新策略：
 *   1. 到点 5 分钟内（重载 / 系统休眠后马上回来）照旧补一次；
 *   2. 超过宽限静默放弃，不响铃、不通知、不记轮；
 *   3. endAt 缺失属于脏数据，同样不能当成「刚完成」。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '../public/floating-page.js'),
  'utf8',
)
const restoreFn = /function restoreTimer\(t\)[\s\S]*?\n {2}\}/.exec(SRC)

test('restoreTimer 存在且定义了 5 分钟宽限', () => {
  assert.ok(restoreFn, 'restoreTimer 必须存在')
  assert.match(SRC, /RESTORE_GRACE_MS\s*=\s*5\s*\*\s*60\s*\*\s*1000/,
    '宽限必须是 5 分钟，且只有一处定义')
})

test('宽限内补 finishTimer，超出宽限静默 resetTimer', () => {
  const fn = restoreFn[0]
  assert.match(fn, /late\s*<=\s*RESTORE_GRACE_MS[\s\S]{0,120}finishTimer\(\)/,
    '刚回来（宽限内）要补一次到点')
  assert.match(fn, /RESTORE_GRACE_MS[\s\S]{0,240}resetTimer\(\)/,
    '超出宽限不能补通知/补记轮，只能复位')
})

test('endAt 缺失的脏状态不当成刚完成', () => {
  assert.match(restoreFn[0], /if\s*\(!timerEndAt\)\s*\{\s*resetTimer\(\);\s*return;\s*\}/,
    '没有 endAt 就没有「到点」可言，不能走 finishTimer')
})

test('暂停态恢复要重画进度环', () => {
  assert.match(restoreFn[0], /timerPaused = !!t\.paused;[\s\S]{0,160}updateTimerRing\(\)/,
    '只恢复剩余时间不重画，环会停在重载前的旧比例')
})
