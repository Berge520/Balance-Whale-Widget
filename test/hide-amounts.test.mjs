/*
 * 金额遮蔽（hideAmounts）的接线单测（node --test，零依赖）。
 *
 * 挂件页是原生 IIFE、不好整套跑起来，这里按本项目既有做法钉住「关键接线」：
 *   · 遮蔽在格式化层统一出口（fmt / fmtModelMoney），不散落在各调用点
 *   · 复制剪贴板仍取真实数字（withRealAmounts），不把 *** 复制出去
 *   · 切换即时重绘 + 走既有 saveConfig 持久化（不另开存储键）
 *   · 设置页的气泡预览读同一个配置键，与挂件本体一致
 *   · 「今日已赚」：未配置时薪时整项隐藏，配置后才显示，且与余额共用同一个遮蔽开关
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const page = fs.readFileSync(new URL('../public/floating-page.js', import.meta.url), 'utf8')
const storeSrc = fs.readFileSync(new URL('../public/preload/lib/store.js', import.meta.url), 'utf8')
const lookView = fs.readFileSync(new URL('../src/views/LookView.vue', import.meta.url), 'utf8')

test('遮蔽状态：默认关闭，只有显式 true 才开启', () => {
  assert.match(storeSrc, /hideAmounts: false/)
  assert.match(storeSrc, /hideAmounts: p\.hideAmounts === true/)
  assert.match(storeSrc, /if \(p\.hideAmounts !== undefined\) cfg\.hideAmounts = !!p\.hideAmounts/)
})

test('遮蔽出口：两种金额格式化都统一返回 ***，覆盖挂件所有金额显示', () => {
  assert.match(page, /function fmt\(balance, currency\) \{\s*\/\/[^\n]*\n\s*if \(hideAmounts\) return '\*\*\*';/)
  assert.match(page, /function fmtModelMoney\(v, currency\) \{\s*if \(hideAmounts\) return '\*\*\*';/)
  // 大数字点击只拦常规三行；倒计时 / 计时 / 提醒等场景不抢气泡本身的点击语义
  assert.match(page, /if \(!canToggleMaskByAmount\(\)\) return;/)
  assert.match(page, /function canToggleMaskByAmount\(\)/)
})

test('遮蔽交互：本地即时翻转后立即重绘，并复用既有 saveConfig 持久化', () => {
  assert.match(page, /function toggleHideAmounts\(\) \{[\s\S]*?hideAmounts = !hideAmounts;[\s\S]*?updateMaskBtnUi\(\);[\s\S]*?render\(\);[\s\S]*?whaleApi\.saveConfig\(\{ hideAmounts: hideAmounts \}\)/)
  // 配置从别处改回来时同步本地（值没变不重复重绘）
  assert.match(page, /if \(typeof cfg\.hideAmounts === 'boolean' && cfg\.hideAmounts !== hideAmounts\)/)
})

test('遮蔽不影响真实值：复制到剪贴板走 withRealAmounts', () => {
  assert.match(page, /var text = withRealAmounts\(mainAmountText\);/)
  assert.match(page, /function withRealAmounts\(fn\) \{[\s\S]*?hideAmounts = false;[\s\S]*?finally \{ hideAmounts = prev; \}/)
})

test('设置页预览与挂件一致：预览样本读同一个 hideAmounts', () => {
  assert.match(lookView, /props\.cfg\.hideAmounts === true \? '\*\*\*'/)
  assert.match(lookView, /props\.cfg\.hideAmounts === true \? '今日已用 \*\*\*'/)
})

test('今日已赚：未配置时薪时整项不显示，配置后才显示', () => {
  // 默认 0 = 未配置；todayEarned 对 0 / 非法时薪返回 null，页面据此 display:none（不占位、不显示 0）
  assert.match(storeSrc, /offworkHourlyWage: 0/)
  assert.match(page, /var offworkHourlyWage = 0;/)
  assert.match(page, /var earned = typeof OFFWORK_CORE\.todayEarned === 'function'[\s\S]*?offworkHourlyWage/)
  assert.match(page, /if \(earned === null\) \{[\s\S]*?offworkEarnedEl\.style\.display = 'none';/)
  // 有配置才写文案，并带「≈」提示不是精确工资
  assert.match(page, /'今日已赚 ≈ ' \+ fmt\(earned, 'CNY'\)/)
  // 宿主写入时非法值保持现值，只有空 / 0（normWage 返回 0）才取消配置
  assert.match(storeSrc, /if \(p\.offworkHourlyWage !== undefined\) \{[\s\S]*?const w = offwork\.normWage\(p\.offworkHourlyWage\)[\s\S]*?if \(w !== null\) cfg\.offworkHourlyWage = w/)
})

test('今日已赚与余额共用同一个遮蔽开关：不开第二个独立开关', () => {
  assert.match(page, /var text = hideAmounts \? '今日已赚 \*\*\*' : '今日已赚 ≈ ' \+ fmt\(earned, 'CNY'\)/)
  assert.doesNotMatch(page, /wageHide|hideEarned|earnedMask|showEarned/)
})

test('时薪输入：正数 / 最多两位小数 / ≤100000；非法不落盘并复用 Flash 回执', () => {
  const offworkView = fs.readFileSync(new URL('../src/views/OffworkView.vue', import.meta.url), 'utf8')
  assert.match(offworkView, /const WAGE_MAX = 100000/)
  // 明确校验：数字 + 最多两位小数；负数 / 非数字 / 三位小数都会被拦
  assert.match(offworkView, /\/\^\\d\+\(\\\.\\d\{1,2\}\)\?\$/)
  assert.match(offworkView, /本次未保存/)
  // 复用设置页统一的 Flash 回执，不新造 toast
  assert.match(offworkView, /useFlashShow\(/)
  assert.match(offworkView, /wageFlashShow\(/)
  // 空输入 = 清除配置
  assert.match(offworkView, /emit\('patch', \{ offworkHourlyWage: 0 \}\)/)
})
