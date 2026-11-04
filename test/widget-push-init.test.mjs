/*
 * widget.js 的 pushInit 推送契约单测（node --test，零依赖）。
 *
 * 为什么钉这条：真机日志显示一次「打开挂件」里 pushInit 会被触发两遍（子窗 whale:ready
 * 与创建回调后的 300ms 兜底），而它同步读的素材里光共享角色池就有 39MB 原图 / 52MB base64。
 * 两遍 × 52MB 的同步读盘 + base64 + 跨进程克隆，正好压在挂件出现的那一下。
 *
 * 于是把口径固定成三条，改坏了测试就会红：
 *  1. whale:init 里不带共享角色池 —— 首帧不需要它（randimg 台词晚几百毫秒无感），
 *     池子改走独立的 whale:shared-skins 通道，且排在 init 之后异步补推；那条通道现在
 *     只带清单（id/ext/size，几百字节），图片本体由页面抽到哪张再按 id 单张来要；
 *  2. 页面就绪（ready 触发 pushInit）后，那个「怕 ready 丢了」的兜底定时器必须被撤销，
 *     同一个窗口不再出现第二次 init；
 *  3. 兜底不能整个删掉 —— ready 真丢时它是挂件唯一的初始化来源；窗口销毁时它也不能再补刀。
 *
 * 为什么是「撤销兜底」而不是「pushInit 内部记一个已推标志」：页面自己重新加载后会再发一次
 * ready 来要配置，标志式去重会把那次也吞掉，挂件就永远停在空白。
 *
 * 环境：utools 全桩（createBrowserWindow 返回假窗口，webContents.send 记账，
 * 加载完成回调由测试手动触发），落盘走内存 dbStorage，不碰真实用户数据。
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { K } = require('../public/preload/lib/constants.js')

// 素材目录的根：skins.js 的 skinsDir() = <TMP>/whale-skins。
// 这里必须给一座**本次专用**的临时目录 —— 早先直接回 os.tmpdir()，测试造的假形象
// 就落在了 %TEMP%\whale-skins\ 里（固定名、无随机后缀），既留不下来回看，也可能和
// 真机数据同名互踩。
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-widget-init-'))

const db = new Map()
let sends = []
let createCb = null

function makeFakeWin() {
  const handler = {
    get(t, key) {
      if (key === 'isDestroyed') return () => false
      if (key === 'isVisible') return () => true
      if (key === 'getPosition') return () => [100, 100]
      if (key === 'getSize') return () => [652, 652]
      if (key === 'getBounds') return () => ({ x: 100, y: 100, width: 652, height: 652 })
      if (key === 'isMaximized' || key === 'isFullScreen' || key === 'isSimpleFullScreen') return () => false
      if (key === 'webContents') return { send: (ch, ...args) => { sends.push({ ch, args }) } }
      if (typeof key === 'symbol') return undefined
      return () => undefined
    },
    set: () => true,
  }
  return new Proxy({}, handler)
}

globalThis.utools = {
  getPath: () => TMP,
  dbStorage: {
    getItem: (k) => (db.has(k) ? db.get(k) : null),
    setItem: (k, v) => { db.set(k, v) },
    removeItem: (k) => { db.delete(k) },
  },
  getPrimaryDisplay: () => ({ id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1040 }, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 }),
  getDisplayNearestPoint: () => ({ id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1040 }, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 }),
  // 真实 uTools 在页面加载完成后才调这个回调；测试里握住句柄，由每条用例决定何时触发
  createBrowserWindow: (url, opts, cb) => { createCb = cb; return makeFakeWin() },
  getWindowType: () => 'main',
  isDarkColors: () => false,
  showMainWindow: () => {},
  sendToParent: () => {},
}

const widget = require('../public/preload/lib/widget.js')
const skins = require('../public/preload/lib/skins.js')

const PNG = Buffer.from('89504e470a', 'hex')
// 兜底定时器是 300ms，等到 400ms 就是「它有机会触发但没触发」
const FALLBACK_WAIT_MS = 400

after(() => { fs.rmSync(TMP, { recursive: true, force: true }) })

function openWidget() {
  sends = []
  createCb = null
  // 先销毁上一个窗口：ensureWidget 复用活着的窗口时不会走 createWidget，
  // 那条「加载完成」回调根本不会被排出来，测的就不是本用例想测的窗口了
  widget.destroyWidget()
  widget.ensureWidget({ focus: false })
  assert.ok(createCb, '应该是新建窗口（否则没有加载完成回调可测）')
}
// 模拟「页面加载完成」回调（正常路径下随后页面会发 whale:ready）
function fireLoaded() { if (createCb) createCb() }
function sentOf(channel) { return sends.filter((s) => s.ch === channel) }
// 让宿主排队的异步补推落地（setImmediate / setTimeout(0) 都在这一下里跑完）
const flush = () => new Promise((r) => setTimeout(r, 0))
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

test('init 载荷不带共享角色池，池子改由 whale:shared-skins 异步补推', async () => {
  openWidget()
  // 池子里放一张官方形象：init 不该带上它，异步通道该带上
  skins.importBuffer('DSniang2.webp', 'webp', PNG, null, 0, 'DSniang2', true)
  widget.pushInit()

  const init = sentOf('whale:init')
  assert.equal(init.length, 1, 'init 应恰好推一次')
  assert.ok(!('sharedSkins' in init[0].args[0]), 'whale:init 不该再携带共享角色池（52MB 级同步搬运压在首帧）')

  await flush()
  const pool = sentOf('whale:shared-skins')
  assert.equal(pool.length, 1, 'init 之后要把共享角色池补推一次')
  assert.deepEqual(pool[0].args[0], [{ id: 'DSniang2', ext: 'webp', size: PNG.length }],
    '补推的是清单（id/ext/size），本体由页面抽到那张时单独来要')
  assert.ok(!JSON.stringify(pool[0].args[0]).includes('base64'),
    '载荷里不许混进图片本体：整池 52MB base64 的克隆要 270ms，正压在挂件刚显示之后')
})

test('页面就绪后兜底定时器被撤销：同一窗口只出现一次 init', async () => {
  openWidget()
  fireLoaded() // 排上 300ms 兜底
  widget.pushInit() // 页面发来的 ready —— 真机就是这一步没把兜底撤掉，于是推了两遍
  await wait(FALLBACK_WAIT_MS)
  assert.equal(sentOf('whale:init').length, 1, 'ready 已送达时兜底必须静默（真机日志显示这里曾推了两遍）')
})

test('真机时序：ready 早于创建回调时，回调不得再排兜底（否则又是双推）', async () => {
  openWidget()
  // 2026-10-30 真机日志 14:09 那次：ready 在 +138ms、uTools 的加载完成回调在 +549ms
  // —— 回调比 ready 还晚，此时「撤销兜底」撤销的是个空句柄，随后回调又把 300ms 兜底排上，
  // 于是同一个窗口仍然推了两遍 init、搬了两遍 52MB 池子
  widget.pushInit()
  fireLoaded()
  await wait(FALLBACK_WAIT_MS)
  assert.equal(sentOf('whale:init').length, 1, '页面已经就绪过一次的窗口，晚到的创建回调不该再排兜底')
  assert.equal(sentOf('whale:shared-skins').length, 1, '同一个窗口的补推也只一次（曾经过推第二遍整池）')
})

test('ready 从未到达时兜底仍要推：窗口不能永远空白', async () => {
  openWidget()
  fireLoaded()
  await wait(FALLBACK_WAIT_MS)
  const init = sentOf('whale:init')
  assert.equal(init.length, 1, '没收到过 ready 时兜底要顶上')
  assert.equal(sentOf('whale:shared-skins').length, 1, '兜底这条也要照样把池子补推出去')
})

test('窗口销毁后上一个窗口的兜底不得再补刀', async () => {
  openWidget()
  fireLoaded()
  widget.destroyWidget()
  await wait(FALLBACK_WAIT_MS)
  assert.equal(sentOf('whale:init').length, 0, '窗口都销毁了，兜底再推只是白搬素材')

  // 重建后新窗口自己排兜底、自己收 init，与上一个窗口互不干扰
  openWidget()
  widget.pushInit()
  await wait(FALLBACK_WAIT_MS)
  assert.equal(sentOf('whale:init').length, 1, '重建后的窗口要能正常收到一次 init')
})

test.after(() => {
  widget.dispose()
  db.delete(K.config)
})
