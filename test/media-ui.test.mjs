/*
 * 背景/片头媒体库的源码契约（node --test，零依赖）。
 * 宿主模块 media.test.mjs 已有行为测试；这里只钉 UI / 服务 / 配置的接线，
 * 防止后续重命名或重构把「导入 → 选用 → 背景层」这条链路拆断。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const read = (rel) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')

test('资源页有背景与片头媒体卡，导入 / 选用 / 删除齐全', () => {
  const view = read('src/views/AssetsView.vue')
  assert.match(view, /data-search="assetsMedia"/)
  assert.match(view, /id="assetsMedia"|data-search="assetsMedia"/)
  assert.match(view, /背景与片头/)
  assert.match(view, /mediaPick\?\.\(kind\)/)
  assert.match(view, /mediaImport\?\.\(/)
  assert.match(view, /mediaRemove\?\.\(/)
  assert.match(view, /useMediaAsBackground/)
  assert.match(view, /useMediaAsIntro/)
  assert.match(view, /hasAnyAssets/)
  assert.match(view, /mediaConfirmId/)
  assert.match(view, /previewMedia/)
  assert.match(view, /media-preview-mask/)
  assert.match(view, /unusedMediaIds/)
  assert.match(view, /不随素材包导出/)
  assert.match(view, /已用 \{\{ mediaItems\.length \}\} \/ 20/)
})

test('外观页能选自定义媒体、调遮罩/模糊/亮度、指定片头来源', () => {
  const look = read('src/views/LookView.vue')
  assert.match(look, /value: 'custom'/)
  assert.match(look, /mediaList\?\.\(\)/)
  assert.match(look, /bgScrim/)
  assert.match(look, /bgBlur/)
  assert.match(look, /bgBrightness/)
  assert.match(look, /bg-tune/)
  assert.match(look, /bootIntroSource/)
  assert.match(look, /bootIntroMediaId/)
  assert.match(look, /bgMediaIsVideo/)
  assert.match(look, /selectedBgMedia/)
  assert.match(look, /bg-gallery/)
  assert.match(look, /BG_OPTIONS/)
  assert.match(look, /bg-auto-tune/)
  assert.match(look, /bgVignette/)
  assert.match(look, /bgFocusX/)
  assert.match(look, /bg-presets/)
  assert.match(look, /设置页视觉/)
  assert.match(look, /pageVisualSummary/)
  assert.match(look, /go-assets/)
  assert.match(look, /bootIntroAutoPlayed/)
  assert.match(look, /bg-media-pause/)
  assert.match(look, /未下载|媒体丢失|未选视频/)
})

test('App 有自定义媒体层与片头媒体来源，挂件不引用', () => {
  const app = read('src/App.vue')
  assert.match(app, /class="bg-custom-layer"/)
  assert.match(app, /services\.mediaData\?\.\(cfg\.bgMediaId\)/)
  assert.match(app, /loadBootIntroMedia/)
  assert.match(app, /bgMediaIsVideo/)
  assert.match(app, /pauseCurrentBgMedia/)
  assert.match(app, /unusedMedia/)
  // 换「用作背景」时 url 还在：必须比 id，不能只看 url 是否为空
  assert.match(app, /let bgCustomId = ''/)
  assert.match(app, /bgCustomId !== cfg\.bgMediaId/)
  // 卸载媒体时把类型复位，否则清空 bgMediaId 后残留「播放 / 暂停视频」
  assert.match(app, /function releaseBgCustom\(\) \{[\s\S]*?bgCustomId = ''[\s\S]*?bgCustomKind\.value = 'image'/)
  const floating = read('public/preload/floating.js')
  assert.ok(!floating.includes('mediaData'), '挂件 preload 不应读取背景媒体')
})

test('宿主服务与配置键接线', () => {
  const settings = read('public/preload/lib/settings.js')
  for (const name of ['mediaList', 'mediaPick', 'mediaImport', 'mediaRemove', 'mediaData', 'mediaClearAll']) {
    assert.match(settings, new RegExp(name + '\\('), 'settings.js 缺 ' + name)
  }
  const store = read('public/preload/lib/store.js')
  for (const key of ['bgMediaId', 'bgScrim', 'bgBlur', 'bgBrightness', 'bootIntroSource', 'bootIntroMediaId']) {
    assert.match(store, new RegExp(key + ':'), 'store.js 缺 ' + key)
  }
  const media = read('public/preload/lib/media.js')
  assert.match(media, /MAX_ITEMS = 20/)
  assert.match(media, /MAX_IMAGE_BYTES/)
  assert.match(media, /MAX_VIDEO_BYTES = 10 \* 1024 \* 1024/)
})
