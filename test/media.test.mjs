/*
 * media.js 单测（node --test，零依赖）。
 *
 * 背景/片头媒体库：导入、列表、读取、删除、配额与配置文件回退。
 * 这条链路出错不会抛错，而是「文件没了 / 配置还指向已删的 id」这类静默问题，
 * 所以用临时 userData 把主分支钉住。
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'node:module'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-media-test-'))
after(() => { fs.rmSync(TMP, { recursive: true, force: true }) })

const db = new Map()
let pickResult = null
globalThis.utools = {
  getPath: () => TMP,
  showOpenDialog: () => pickResult,
  dbStorage: {
    getItem: (k) => (db.has(k) ? db.get(k) : null),
    setItem: (k, v) => { db.set(k, v) },
    removeItem: (k) => { db.delete(k) },
  },
}

const require = createRequire(import.meta.url)
const media = require('../public/preload/lib/media.js')
const store = require('../public/preload/lib/store.js')

const PNG_1PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

function makeFile(name, bytes) {
  const p = path.join(TMP, name)
  fs.writeFileSync(p, Buffer.alloc(bytes, 7))
  return p
}

test('normItem：只认安全 id 与允许的扩展名', () => {
  assert.equal(media._normItem({ id: '../x', ext: 'png', size: 1 }), null)
  assert.equal(media._normItem({ id: 'm1', ext: 'exe', size: 1 }), null)
  assert.equal(media._normItem({ id: 'm1', ext: 'png', size: 0 }), null)
  const one = media._normItem({ id: 'm1', name: 'a.png', ext: 'png', size: 12, at: 5 })
  assert.equal(one.type, 'image')
  assert.equal(one.name, 'a.png')
})

test('pick：图片回 dataUrl 供缩略图，视频只回路径', () => {
  const img = makeFile('pick.png', 128)
  pickResult = [img]
  const r = media.pick('image')
  assert.equal(r.ok, true)
  assert.equal(r.type, 'image')
  assert.match(r.dataUrl, /^data:image\/png;base64,/)
  const vid = makeFile('pick.mp4', 128)
  pickResult = [vid]
  const v = media.pick('video')
  assert.equal(v.ok, true)
  assert.equal(v.type, 'video')
  assert.equal(v.dataUrl, undefined)
})

test('importFile：复制文件 + 落缩略图，list/data 能读回', () => {
  const img = makeFile('bg.png', 1024)
  const r = media.importFile({ filePath: img, name: 'bg.png', thumb: PNG_1PX })
  assert.equal(r.ok, true, r.error)
  assert.equal(r.item.type, 'image')
  const list = media.list()
  assert.ok(list.items.some((x) => x.id === r.item.id))
  const one = list.items.find((x) => x.id === r.item.id)
  assert.match(one.thumb, /^data:image\/png;base64,/)
  const d = media.data(r.item.id)
  assert.equal(d.ok, true)
  assert.match(d.dataUrl, /^data:image\/png;base64,/)
})

test('配额与体积：超过 20 项 / 视频 10MB 拒绝', () => {
  while (media.list().items.length < 20) {
    const p = makeFile('q' + media.list().items.length + '.png', 16)
    assert.equal(media.importFile({ filePath: p }).ok, true)
  }
  const p = makeFile('over.png', 16)
  const r = media.importFile({ filePath: p })
  assert.equal(r.ok, false)
  assert.match(r.error, /最多保留 20/)
  media.clearAll()
  const big = makeFile('big.mp4', 10 * 1024 * 1024 + 1)
  const v = media.importFile({ filePath: big })
  assert.equal(v.ok, false)
  assert.match(v.error, /文件过大/)
})

test('删除当前背景/片头媒体时配置回退，并删掉磁盘文件', () => {
  const img = makeFile('use.png', 64)
  const imported = media.importFile({ filePath: img, name: 'use.png' })
  assert.equal(imported.ok, true)
  const id = imported.item.id
  store.patchConfig({ bgMode: 'custom', bgMediaId: id, bootIntroSource: 'media', bootIntroMediaId: id })
  const r = media.remove(id)
  assert.equal(r.ok, true)
  assert.equal(r.configChanged, true)
  const cfg = store.readConfig()
  assert.equal(cfg.bgMode, 'off')
  assert.equal(cfg.bgMediaId, '')
  assert.equal(cfg.bootIntroSource, 'auto')
  assert.equal(cfg.bootIntroMediaId, '')
  assert.equal(media.data(id).ok, false)
})

test('删除媒体：背景不是 custom 时只删文件，不回退正在用的背景模式', () => {
  const img = makeFile('aurora.png', 64)
  const imported = media.importFile({ filePath: img, name: 'aurora.png' })
  assert.equal(imported.ok, true)
  const id = imported.item.id
  // bgMediaId 是历史引用（切到极光后旧的自定义媒体还留在配置里），不能因为删图就把极光关掉
  store.patchConfig({ bgMode: 'aurora', bgMediaId: id })
  const r = media.remove(id)
  assert.equal(r.ok, true)
  const cfg = store.readConfig()
  assert.equal(cfg.bgMode, 'aurora')
  assert.equal(cfg.bgMediaId, id)
  assert.equal(r.configChanged, false)
  assert.equal(media.data(id).ok, false, '文件确实删掉了')
})

test('幽灵项：元数据在、文件缺失时列表不显示、不占配额，导入时顺手清理', () => {
  // 模拟用户手动清空 whale-media 目录后剩下的元数据：界面显示 0 项，
  // 旧实现却按元数据条数判配额，会报「已满 20 项」却看不到任何一项
  const items = []
  for (let i = 0; i < 20; i++) {
    items.push({ id: 'g' + i, name: 'g' + i + '.png', ext: 'png', type: 'image', size: 8, at: i })
  }
  db.set('whale:media', { items })
  assert.equal(media.list().items.length, 0)
  const p = makeFile('ghost.png', 16)
  const r = media.importFile({ filePath: p })
  assert.equal(r.ok, true, r.error)
  assert.equal(media.list().items.length, 1)
  assert.equal(db.get('whale:media').items.length, 1, '幽灵元数据在导入时被清掉')
  media.clearAll()
})

test('data：不存在的 id 返回失败而不是抛错', () => {
  const d = media.data('nope')
  assert.equal(d.ok, false)
  assert.match(d.error, /不存在/)
})
