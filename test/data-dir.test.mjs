/*
 * data-dir.js 的目录推导单测（node --test，零依赖）。
 *
 * 为什么单独测：这条口径决定用户素材（自定义形象 / 音效 / 气泡图 / 背景 / 视频壁纸）
 * 落在哪个磁盘位置。旧写法在取不到 userData 时静默落系统临时目录 —— 重启即丢，
 * 用户毫无感知；现在改成「userData → 插件本地数据目录 → 临时目录（留痕）」，
 * 顺序错了就等于让用户素材搬家或丢失，所以把三级顺序钉死。
 *
 * 环境：只桩 globalThis.utools，不落任何真实目录（本模块只算路径，不做 IO）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { baseDir, dataDir } = require('../public/preload/lib/data-dir.js')

test('userData 可用时优先用它（老素材的位置不能变）', () => {
  globalThis.utools = {
    getPath: () => 'C:\\Users\\x\\AppData\\Roaming\\uTools',
    getPluginLocalDataPath: () => 'C:\\Users\\x\\AppData\\Roaming\\uTools\\local-data\\whale',
  }
  assert.equal(baseDir(), 'C:\\Users\\x\\AppData\\Roaming\\uTools')
})

test('userData 返回空串时退插件本地数据目录', () => {
  globalThis.utools = {
    getPath: () => '',
    getPluginLocalDataPath: () => 'D:\\plugin-data',
  }
  assert.equal(baseDir(), 'D:\\plugin-data')
})

test('userData 抛错时退插件本地数据目录', () => {
  globalThis.utools = {
    getPath: () => { throw new Error('boom') },
    getPluginLocalDataPath: () => 'D:\\plugin-data',
  }
  assert.equal(baseDir(), 'D:\\plugin-data')
})

test('两个目录都取不到时退系统临时目录（不抛）', () => {
  globalThis.utools = {
    getPath: () => { throw new Error('boom') },
    // 7.x 上不存在这个函数：调用即 TypeError，必须被接住
    getPluginLocalDataPath: undefined,
  }
  assert.equal(baseDir(), os.tmpdir())
})

test('dataDir 拼上素材子目录名', () => {
  globalThis.utools = { getPath: () => path.join('base') }
  assert.equal(dataDir('whale-skins'), path.join('base', 'whale-skins'))
})
