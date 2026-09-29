/*
 * download-progress.js 单测（node --test，零依赖）。
 *
 * 这个模块是设置页三张资源卡共用的进度单例：两条下载链路（skin-packs / assets-packs）
 * 都往里写，设置页按 250ms 轮询读。它出错的方式都很隐蔽：
 *   - snapshot() 回了引用 → 轮询读渲染时恰好撞上 progress() 正在改字段，
 *     界面上会出现「50% 却显示 0 字节」这类自相矛盾的组合；
 *   - 换源没归零 received → 进度条从上一个源的字节数接着涨，看上去像越下越多；
 *   - 终态没记时间戳 → 设置页判不出「这份进度是上一次下载留下的」，下次进页面还杵在那里。
 * 所以这里逐条钉住这些语义。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import dlp from '../public/preload/lib/download-progress.js'

test('begin：起一次下载，初始为 connect 且总量已知与否由 total 决定', () => {
  dlp.begin('skins', 1000)
  const s = dlp.snapshot()
  assert.equal(s.pack, 'skins')
  assert.equal(s.phase, 'connect')
  assert.equal(s.received, 0)
  assert.equal(s.total, 1000)
  assert.equal(s.totalKnown, true)
  assert.equal(s.url, '')
  assert.equal(typeof s.at, 'number')
})

test('begin：total 为 0 时 totalKnown 为 false（拿不到 Content-Length 的场景）', () => {
  dlp.begin('skins', 0)
  const s = dlp.snapshot()
  assert.equal(s.total, 0)
  assert.equal(s.totalKnown, false)
})

test('snapshot：回副本，改快照不影响内部状态（防止轮询读到半更新的字段组合）', () => {
  dlp.begin('skins', 100)
  const a = dlp.snapshot()
  a.received = 999
  a.pack = '改了也不该生效'
  const b = dlp.snapshot()
  assert.equal(b.received, 0)
  assert.equal(b.pack, 'skins')
  assert.notEqual(a, b)
})

test('snapshot：从未 begin 过时回 null', () => {
  dlp.clear()
  assert.equal(dlp.snapshot(), null)
})

test('source：换源时把 received 归零（否则进度条接着上个源的数字涨）', () => {
  dlp.begin('skins', 1000)
  dlp.progress(400, 1000)
  assert.equal(dlp.snapshot().received, 400)
  dlp.source('https://ghfast.top/x', '默认加速 ghfast.top')
  const s = dlp.snapshot()
  assert.equal(s.received, 0)
  assert.equal(s.phase, 'connect')
  assert.equal(s.url, 'https://ghfast.top/x')
  assert.equal(s.label, '默认加速 ghfast.top')
})

test('progress：写入字节数并切到 download 阶段，服务端给的 total 覆盖调用方预期', () => {
  dlp.begin('skins', 1000)
  dlp.progress(250, 800)
  const s = dlp.snapshot()
  assert.equal(s.phase, 'download')
  assert.equal(s.received, 250)
  assert.equal(s.total, 800)
  assert.equal(s.totalKnown, true)
})

test('progress：不传 total 时保留 begin 时的总量', () => {
  dlp.begin('skins', 1000)
  dlp.progress(250)
  assert.equal(dlp.snapshot().total, 1000)
  assert.equal(dlp.snapshot().totalKnown, true)
})

test('phase：切到自定义文案（install 覆盖 label）', () => {
  dlp.begin('skins', 1000)
  dlp.phase('install', { label: '正在写入形象…', total: 512 })
  const s = dlp.snapshot()
  assert.equal(s.phase, 'install')
  assert.equal(s.label, '正在写入形象…')
  assert.equal(s.total, 512)
  assert.equal(s.totalKnown, true)
})

test('end：成功时 received 对齐 total，避免进度条停在 99%', () => {
  dlp.begin('skins', 1000)
  dlp.progress(999, 1000)
  dlp.end(true, 1000)
  const s = dlp.snapshot()
  assert.equal(s.phase, 'done')
  assert.equal(s.label, '下载完成')
  assert.equal(s.received, 1000)
  assert.equal(s.bytes, 1000)
})

test('end：成功但总量未知时不动 received', () => {
  dlp.begin('skins', 0)
  dlp.progress(777)
  dlp.end(true, 777)
  const s = dlp.snapshot()
  assert.equal(s.phase, 'done')
  assert.equal(s.received, 777)
  assert.equal(s.bytes, 777)
})

test('end：失败记成 failed，bytes 落 0', () => {
  dlp.begin('skins', 1000)
  dlp.progress(100, 1000)
  dlp.end(false, 0)
  const s = dlp.snapshot()
  assert.equal(s.phase, 'failed')
  assert.equal(s.label, '下载失败')
  assert.equal(s.bytes, 0)
})

test('end：终态保留快照（让设置页还能显示「经哪个源、下了多大」），由读侧按时间窗口忽略', () => {
  dlp.begin('skins', 1000)
  dlp.source('https://github.com/a', '直连 github.com')
  dlp.end(true, 1000)
  const s = dlp.snapshot()
  assert.equal(s.phase, 'done')
  assert.equal(s.url, 'https://github.com/a')
})

test('clear：清空后 snapshot 回 null', () => {
  dlp.begin('skins', 1000)
  dlp.clear()
  assert.equal(dlp.snapshot(), null)
})

test('未 begin 就写：所有写操作静默无副作用（不抛错、不凭空造状态）', () => {
  dlp.clear()
  dlp.progress(100, 200)
  dlp.phase('download')
  dlp.source('https://x', 'x')
  dlp.end(true, 200)
  assert.equal(dlp.snapshot(), null)
})
