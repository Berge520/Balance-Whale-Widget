/*
 * 「未至之境」HUD 装饰的源码契约（node --test，零依赖）。
 *
 * HUD 是纯装饰：气泡外圈/文字角标、菜单角标、设置页卡片角标。
 * 这些规则都靠 dshwv-theme-fantasy / html.fantasy 开关，且必须不参与命中。
 * 这里只做静态断言，防止后续重构把开关或装饰删掉。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const read = (rel) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')

test('fantasy 主题在挂件页与设置预览都挂 HUD 类', () => {
  assert.match(read('public/floating-page.js'), /classList\.toggle\('dshwv-theme-fantasy'/)
  assert.match(read('src/components/BubblePreview.vue'), /classList\.toggle\('dshwv-theme-fantasy'/)
})

test('气泡 HUD 只在 fantasy 主题显示，且装饰不参与命中', () => {
  const css = read('public/floating-bubble.css')
  assert.match(css, /\.dshwv-bubble \.dshwv-bshape-hud \{ display: none; \}/)
  assert.match(css, /\.dshwv-theme-fantasy \.dshwv-bubble \.dshwv-bshape-hud \{[\s\S]*?pointer-events: none;/)
  assert.match(css, /\.dshwv-theme-fantasy \.dshwv-bubble-open \.dshwv-text::before/)
  assert.match(css, /\.dshwv-theme-fantasy \.dshwv-bubble-open \.dshwv-text::after/)
  // 外圈/角标不得成为可点区域
  assert.match(css, /\.dshwv-theme-fantasy \.dshwv-bubble-open \.dshwv-text::before,[\s\S]*?pointer-events: none;/)
})

test('背景氛围跟随界面深浅色（深色 / 浅色 / 媒体）', () => {
  const look = read('src/views/LookView.vue')
  // 气泡配色不再用设置页内的预览图（改配色直接在真实挂件上弹泡演示），故这里钉 theme-preview
  assert.match(look, /<select :value="cfg\.theme"/)
  assert.match(look, /window\.services\?\.themePreview\?\.\(\{ theme, ms: 3200 \}\)/)
  assert.match(look, /bg-gallery/)
  assert.match(look, /value: 'deep'/)
  assert.match(look, /value: 'aurora'/)
  assert.match(look, /value: 'video'/)
  assert.match(look, /下载视频壁纸/)
  const app = read('src/App.vue')
  assert.match(app, /document\.documentElement\.classList\.toggle\('bg-' \+ m/)
  // 媒体背景不再限定 fantasy（浅色 / 深色都要生效）
  assert.match(app, /function bgVideoWanted\(\) \{\s*return cfg\.bgMode === 'video'/)
  assert.match(app, /function bgCustomWanted\(\) \{\s*return cfg\.bgMode === 'custom' && !!cfg\.bgMediaId/)
  const css = read('src/main.css')
  // 深色（含未至之境）与浅色各有一套配色；浅色不能只靠 fantasy 前缀
  assert.match(css, /html\.dark\.bg-deep body::before/)
  assert.match(css, /html\.dark\.bg-aurora body::before/)
  assert.match(css, /html\.dark\.bg-stars body::before/)
  assert.match(css, /html:not\(\.dark\)\.bg-deep body::before/)
  assert.match(css, /html:not\(\.dark\)\.bg-stars body::before/)
  assert.match(css, /html:not\(\.dark\)\.bg-warm body::before/)
  assert.match(css, /html\.bg-video \.bg-video-layer/)
  assert.match(css, /html:not\(\.dark\)\.bg-video \.bg-video-veil/)
  // 动画必须由低特异性的共享规则声明、各氛围只写自定义属性：
  // 否则 reduce-motion 的 animation:none 压不过 html.dark.bg-* 的高特异性规则，位移停不下来
  assert.match(css, /animation: whale-bg-drift var\(--bg-drift-dur, 18s\) ease-in-out infinite var\(--bg-drift-dir, alternate\);/)
  assert.match(css, /--bg-drift-dur: 18s;/)
  assert.ok(!/html\.dark\.bg-[a-z]+ body::before \{[^}]*animation: whale-bg-drift/.test(css), '动画不能写进高特异性的氛围规则')
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?html\.bg-deep body::before,[\s\S]*?animation: none;/)
})

test('视频壁纸：只读本地缓存、设置页播放、下载前不碰挂件', () => {
  const app = read('src/App.vue')
  const look = read('src/views/LookView.vue')
  assert.match(app, /services\.bgVideoData\?\.\(\)/)
  assert.match(app, /<video[^>]*:src="bgVideoUrl"/)
  assert.match(app, /preload="auto"/)
  // 浏览器默认策略会拦截静音自动播放：必须有一次显式播放入口 + 首次交互兜底
  assert.match(app, /function playBgVideo\(\)/)
  assert.match(app, /onBgMediaGesture/)
  assert.match(look, /播放视频/)
  assert.match(look, /bg-media-play/)
  // 播放层是装饰：必须禁用命中，且不参与无障碍树
  assert.match(app, /class="bg-video-layer"[^>]*aria-hidden="true"/)
  const css = read('src/main.css')
  assert.match(css, /html\.bg-video \.bg-video-layer,[\s\S]*?pointer-events: none;/)
  // 下载链路只在设置页服务里，挂件 preload 不得引用
  const floating = read('public/preload/floating.js')
  assert.ok(!floating.includes('bg-video'), '挂件 preload 不应加载视频壁纸模块')
})

test('菜单与设置页的 HUD 角标存在', () => {
  const menu = read('public/floating.css')
  assert.match(menu, /html\.fantasy \.dshwv-menu \{[\s\S]*?background-image:/)
  assert.match(menu, /html\.fantasy \.dshwv-group-head \{[\s\S]*?box-shadow: inset 2px 0 0 rgba\(57, 255, 209/)
  const main = read('src/main.css')
  assert.match(main, /html\.dark\.fantasy \.card \{[\s\S]*?background-image:/)
})
