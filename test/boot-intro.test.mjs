/*
 * 设置页启动片头的源码契约（node --test，零依赖）。
 *
 * 片头是纯设置页装饰：默认关闭、每次插件进程启动只自动播一次、可跳过、
 * 系统减少动态效果时自动跳过；挂件页不得引用。这里做静态断言，防止后续重构
 * 把触发条件或「只播一次」的宿主标记删掉。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const read = (rel) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')

test('启动片头：设置页有开关与预览入口', () => {
  const look = read('src/views/LookView.vue')
  assert.match(look, /cfg\.bootIntroOn/)
  assert.match(look, /cfg\.bootIntroClean/)
  assert.match(look, /启动片头/)
  assert.match(look, /纯净播放/)
  assert.match(look, /预览片头/)
  assert.match(look, /preview-boot-intro/)
  assert.match(look, /boot-intro-clean-change/)
  assert.match(look, /open-system-animation-settings/)
  assert.match(look, /系统动画设置/)
})

test('纯净播放：首帧预涂、播放时隐藏 #app、退场先放回设置页', () => {
  const index = read('index.html')
  assert.match(index, /boot-intro-pending/)
  const app = read('src/App.vue')
  assert.match(app, /boot-intro-clean/)
  assert.match(app, /bootIntroCleanPage/)
  assert.match(app, /bootIntroRevealPage/)
  assert.match(app, /@closing="onBootIntroClosing"/)
  assert.match(app, /onBootIntroCleanChange/)
  const intro = read('src/components/BootIntro.vue')
  assert.match(intro, /emit\('closing'\)/)
  const css = read('src/main.css')
  assert.match(css, /html\.boot-intro-clean #app[\s\S]*?visibility: hidden !important;/)
})

test('启动片头：只在设置页挂载，且由宿主做「每次进程启动一次」消费', () => {
  const app = read('src/App.vue')
  assert.match(app, /import BootIntro from '\.\/components\/BootIntro\.vue'/)
  assert.match(app, /<BootIntro[^>]*:video-url="bootIntroVideoUrl"/)
  assert.match(app, /bootIntroConsume/)
  assert.match(app, /function maybePlayBootIntro\(\)/)
  assert.match(app, /firstRun[\s\S]*?maybePlayBootIntro\(\)/)
  const floating = read('public/preload/floating.js')
  assert.ok(!floating.includes('bootIntro'), '挂件 preload 不应加载启动片头')
  const settings = read('public/preload/lib/settings.js')
  assert.match(settings, /let bootIntroPlayed = false/)
  assert.match(settings, /bootIntroConsume\(\)/)
  assert.match(settings, /openSystemAnimationSettings\(\)/)
  assert.match(settings, /bootIntroHasPlayed\(\)/)
  assert.match(settings, /ms-settings:easeofaccess-display/)
  assert.match(settings, /ms-settings:easeofaccess-visualeffects/)
})

test('启动片头：可跳过，减少动态效果只关 CSS 动画', () => {
  const intro = read('src/components/BootIntro.vue')
  assert.ok(!/if \(props\.reduce\) \{\s*try \{ v\.pause\(\) \}/.test(intro), '减少动态效果不应暂停片头视频')
  assert.match(intro, /boot-intro-play/)
  assert.match(intro, /@click="finish\(true\)"/)
  assert.match(intro, /window\.addEventListener\('keydown'/)
  assert.match(intro, /boot-intro-skip/)
  assert.match(intro, /prefers-reduced-motion: reduce/)
})

test('启动片头配置默认关闭并进入 patch 分支', () => {
  const store = read('public/preload/lib/store.js')
  assert.match(store, /bgMode: 'off'[^}]*bootIntroOn: false[^}]*bootIntroClean: false/)
  assert.match(store, /bootIntroOn: p\.bootIntroOn === true/)
  assert.match(store, /bootIntroOn: cfg\.bootIntroOn === true/)
  assert.match(store, /p\.bootIntroOn !== undefined/)
})
