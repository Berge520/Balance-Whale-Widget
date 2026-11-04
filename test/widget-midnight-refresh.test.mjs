/*
 * 跨零点刷新的源码契约单测（node --test，零依赖）。
 *
 * 挂件「今日 N 轮 / 分钟」是宿主按 todayKey() 算好的快照；零点后页面不会自己跨日重算，
 * 宿主不重推就会一直显示昨天的数字。这里钉住三件事：
 *   1. 窗口创建后要排上刷新；
 *   2. 销毁 / 插件退出都要清掉句柄（否则进程里留一个近 24h 的定时器）；
 *   3. 触发后必须重排，且按本地零点算 —— 不能用固定 24h 轮询。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '../public/preload/lib/widget.js'),
  'utf8',
)
const scheduleFn = /function scheduleMidnightRefresh\(\)[\s\S]*?\n\}/.exec(SRC)
const destroyFn = /function destroyWidget\(\)[\s\S]*?\n\}/.exec(SRC)
const disposeFn = /function dispose\(\)[\s\S]*?\n\}/.exec(SRC)

test('挂件创建后安排跨零点刷新', () => {
  assert.ok(scheduleFn, 'scheduleMidnightRefresh 必须存在')
  assert.match(SRC, /syncTaskbarWatch\(\)[^\n]*\n\s*scheduleMidnightRefresh\(\)/,
    'createWidget 的窗口就位路径要排上刷新')
})

test('窗口销毁与插件退出都清掉跨零点定时器', () => {
  assert.match(destroyFn[0], /clearMidnightRefresh\(\)/, 'destroyWidget 要撤销定时器')
  assert.match(disposeFn[0], /clearMidnightRefresh\(\)/, 'dispose 要撤销定时器')
})

test('按本地零点算，触发后重排', () => {
  assert.match(scheduleFn[0], /setHours\(24, 0, 1, 0\)/, '下一个本地零点（+1s 防止边界刚好落在 00:00:00）')
  assert.match(scheduleFn[0], /pushFocusStats\(\)[\s\S]*scheduleMidnightRefresh\(\)/,
    '推完新一天的统计后要排下一次')
})
