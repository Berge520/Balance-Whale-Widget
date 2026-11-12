/*
 * 设置页视图读的 cfg 键必须有「默认值 + 宿主广播回填」两处兜底。
 *
 * 背景：视图拿到的 cfg 是 App.vue 本地副本，不是宿主配置本体。缺默认值顶多首帧空白；
 * 缺 applyConfig 回填则更糟 —— 控件绑定读到的永远是 undefined，表单显示为空，
 * 用户改完重开又像没保存。timerRemindSec 就这么漏过一次（到点气泡停留下拉框恒空）。
 *
 * 这里对 TimerView / LookView 做契约断言：它们读的每个平铺键都要在 App.vue 里同时出现
 * ① 默认 cfg 对象中的 `key:` 定义；② `cfg.key =` 形式的回填赋值。
 * 其它视图的 alerts / tokenPrice 等是「对象内字段逐个回填」，不在本测试的平铺键口径内。
 *
 * LookView 是 v1.9.x 外圈样式补进来的第二例：`cfg.ringWidth` 只写了视图、没写默认值与回填，
 * 「外圈粗细」下拉框三个 option 全匹配不上，用户看到的是一个空白框。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const read = (rel) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')
const app = read('src/App.vue')

// 平铺键口径：`cfg.foo` 之后不能紧跟 `.` / `?.` / `[`（那些是对象内字段，逐个回填另算）
const flatKeys = (file) => [...new Set(
  [...read(file).matchAll(/\bcfg\.([A-Za-z0-9_]+)(?![\w?.[])/g)].map((m) => m[1]),
)]

for (const file of ['src/views/TimerView.vue', 'src/views/LookView.vue']) {
  const keys = flatKeys(file)

  test(`${file} 用到的 cfg 键在 App.vue 里有默认值`, () => {
    const missing = keys.filter((k) => !new RegExp(`^\\s*${k}\\s*:`, 'm').test(app))
    assert.deepEqual(missing, [], `默认 cfg 对象缺少：${missing.join(', ')}`)
  })

  test(`${file} 用到的 cfg 键在 applyConfig 里有回填`, () => {
    const missing = keys.filter((k) => !new RegExp(`cfg\\.${k}\\s*=`).test(app))
    assert.deepEqual(missing, [], `applyConfig 缺少回填：${missing.join(', ')}`)
  })
}

// NotifyView 的提醒文案直接读 cfg.alerts 渲染 textarea；不回填的话保存并重开设置页会整体显示为空。
test('applyConfig 有提醒文案 alerts 的回填', () => {
  assert.match(app, /cfg\.alerts\[[^\]]+\]\s*=|Object\.assign\(cfg\.alerts/, 'applyConfig 缺少 cfg.alerts 回填')
})

