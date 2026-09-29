/*
 * skin-packs.js 单测（node --test，零依赖）。
 *
 * 这个模块是「按需下载内置形象」的专职链路：拿远程素材包 → 解析容器 → 双重 sha256
 * 校验 → 落进自定义画廊。它出错的后果都不显眼：校验写漏 = 代理返回的半截包被当正常
 * 安装；边界写漏 = 越界切片读到别人的字节；已装判断写漏 = 重复写覆盖用户形象。
 *
 * 测试直接读 public/whale-pack/skins-pack.whaleassets 这份真实产物（随 Release 发布的本体），
 * 因此也顺带把「Python 构建脚本的产物」与「JS 解析器」钉在一起 —— 两边格式漂移会立刻暴露。
 * 不读该文件时用构造的字节覆盖各失败分支。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import skinPacks from '../public/preload/lib/skin-packs.js'
import constants from '../public/preload/lib/constants.js'

const { _parsePack: parsePack, listSkinPacks, downloadSkinPacks } = skinPacks
const { SKIN_PACK_SKINS, SKIN_PACK_SHA256 } = constants

const PACK_PATH = fileURLToPath(new URL('../public/whale-pack/skins-pack.whaleassets', import.meta.url))
const PACK_MANIFEST_PATH = fileURLToPath(new URL('../public/whale-pack/manifest.json', import.meta.url))

const MAGIC = 'WHALEASSET1'
const KIND = 'balance-whale-widget-assets'
// 与 skin-packs.js 内部一致：魔数(11) + 清单长度 uint32(4)
const HEAD_BYTES = MAGIC.length + 4

// 造一个最小合法容器：[魔数][长度][清单][数据]
function makePack(manifest, data) {
  const json = Buffer.from(JSON.stringify(manifest), 'utf8')
  const head = Buffer.alloc(HEAD_BYTES)
  head.write(MAGIC, 0, 'latin1')
  head.writeUInt32LE(json.length, MAGIC.length)
  return Buffer.concat([head, json, data])
}

function packManifest(skins) {
  return { kind: KIND, schema: 1, skins: skins || [], sounds: [], bubbles: [] }
}

// ── 解析：正常路径（吃真实产物） ──────────────────────────────────────────

test('解析真实素材包：清单项与 constants 的单张校验值逐一对得上', () => {
  const buf = readFileSync(PACK_PATH)
  const parsed = parsePack(buf)
  assert.equal(parsed.error, undefined)
  assert.ok(Array.isArray(parsed.manifest.skins))
  assert.equal(parsed.manifest.skins.length, SKIN_PACK_SKINS.length)
  // 清单里每一项都要能在 constants 里按文件名匹配到，且 id 集合完全一致
  const ids = parsed.manifest.skins.map((it) => {
    const meta = SKIN_PACK_SKINS.find((s) => s.file === it.name)
    assert.ok(meta, '素材包里有 constants 未收录的文件：' + it.name)
    // off/len 必须落在数据区内，且长度与 constants 记的 size 一致
    assert.equal(Number(it.len), meta.size)
    assert.ok(Number(it.off) >= 0 && parsed.dataStart + Number(it.off) + Number(it.len) <= buf.length)
    return meta.id
  })
  assert.deepEqual([...ids].sort(), SKIN_PACK_SKINS.map((s) => s.id).sort())
})

// 素材包必须自报「这是内置图」（id + builtin）：skins.importBuffer 靠这两个字段把导入项
// 还原成内置态（固定 id、不占用户自建配额）。少了 builtin，用户导入素材包后这些图会被
// 算成自建图——配额一满就装不下，且「已下载」标记（builtinIds）也认不出来、可被重复下载。
test('真实素材包：清单项自带 id 与 builtin，且 id 与 constants 一致', () => {
  const parsed = parsePack(readFileSync(PACK_PATH))
  for (const it of parsed.manifest.skins) {
    const meta = SKIN_PACK_SKINS.find((s) => s.file === it.name)
    assert.equal(it.id, meta.id, it.name)
    assert.equal(it.builtin, true, it.name)
  }
})

test('真实素材包：逐张 sha256 与 constants 记录一致（防构建脚本与清单脱钩）', async () => {
  const { createHash } = await import('node:crypto')
  const buf = readFileSync(PACK_PATH)
  const parsed = parsePack(buf)
  for (const it of parsed.manifest.skins) {
    const meta = SKIN_PACK_SKINS.find((s) => s.file === it.name)
    const data = buf.slice(parsed.dataStart + Number(it.off), parsed.dataStart + Number(it.off) + Number(it.len))
    assert.equal(createHash('sha256').update(data).digest('hex'), meta.sha256, meta.id)
  }
})

test('真实素材包：整体 sha256 与 constants 的 SKIN_PACK_SHA256 一致', async () => {
  const { createHash } = await import('node:crypto')
  const digest = createHash('sha256').update(readFileSync(PACK_PATH)).digest('hex')
  assert.equal(digest, SKIN_PACK_SHA256)
})

test('真实素材包：manifest.json 的 sha256 / size 与 constants 同步', () => {
  const m = JSON.parse(readFileSync(PACK_MANIFEST_PATH, 'utf8'))
  for (const s of SKIN_PACK_SKINS) {
    assert.ok(m[s.id], '构建清单缺 ' + s.id)
    assert.equal(m[s.id].file, s.file)
    assert.equal(m[s.id].sha256, s.sha256, s.id)
    assert.equal(m[s.id].size, s.size, s.id)
  }
})

// 落盘 id 会拼进文件名（skins.js 的 readFileUrl / fs.writeFileSync），且必须过 normItem 的
// `/^[A-Za-z0-9_-]{1,40}$/` 白名单。含中文等字符的 id 能写进磁盘、却会在 readRaw 归一化时被
// 静默丢弃 —— 表现为「下载成功但画廊少一张，且每次都判成未装、反复重下」。这类错不报任何
// 异常，只能在清单层拦住，故对整个清单做一次白名单校验（历史踩坑：「无稽之谈改」）。
test('清单 id 全部落在 skins.js 的安全字符白名单内（含中文的会被静默丢弃）', () => {
  const SAFE_ID = /^[A-Za-z0-9_-]{1,40}$/
  for (const s of SKIN_PACK_SKINS) {
    assert.ok(SAFE_ID.test(s.id), '不安全的 id：' + s.id)
  }
  // file 可以是任意原文名（打包时的素材文件名），但 id 必须可安全落盘 ——
  // 两者本就分开：skin-packs.js 按 file 匹配清单、按 id 落盘。
  // 历史踩坑「无稽之谈改.webp」在 v1.9.0 精简内置包时已随该张一起移除（改由共享角色包提供），
  // 故这里不再断言它的落盘 id；白名单校验对当前清单仍然成立。
})

// 素材包容器里钦定的 id 必须与 constants 一致：用户「手动导入素材包」这条链路
// （assets.js → skins.importBuffer）直接透传容器里的 id，与下载链路（按清单重建 id）不同，
// 两处若漂移，同一次下载/导入会得到不同 id，画廊里就会出现两张同图不同 id 的项。
test('真实素材包容器内的 id 与 constants 逐项一致（手动导入链路直接透传它）', () => {
  const parsed = parsePack(readFileSync(PACK_PATH))
  const ids = parsed.manifest.skins.map((it) => it.id).sort()
  assert.deepEqual(ids, SKIN_PACK_SKINS.map((s) => s.id).sort())
})

// ── 解析：失败分支 ───────────────────────────────────────────────────────

test('parsePack 拒绝过小 / 空 / 非 Buffer', () => {
  assert.ok(parsePack(null).error)
  assert.ok(parsePack(Buffer.alloc(0)).error)
  assert.ok(parsePack(Buffer.from('short')).error)
  // 恰好等于头长度（无清单无数据）也要拒
  assert.ok(parsePack(Buffer.alloc(HEAD_BYTES)).error)
})

test('parsePack 拒绝魔数不符（代理错误页 / 别的文件）', () => {
  const html = Buffer.concat([Buffer.from('<html>404</html>'.padEnd(20)), Buffer.alloc(20)])
  assert.ok(parsePack(html).error)
})

test('parsePack 拒绝清单长度越界与非法 JSON', () => {
  // 长度写成远超实际
  const head = Buffer.alloc(HEAD_BYTES)
  head.write(MAGIC, 0, 'latin1')
  head.writeUInt32LE(99999, MAGIC.length)
  assert.ok(parsePack(Buffer.concat([head, Buffer.alloc(8)])).error)

  // 长度 0 也要拒
  const zero = Buffer.alloc(HEAD_BYTES)
  zero.write(MAGIC, 0, 'latin1')
  zero.writeUInt32LE(0, MAGIC.length)
  assert.ok(parsePack(Buffer.concat([zero, Buffer.alloc(4)])).error)

  // 清单不是合法 JSON
  const jsonLen0 = Buffer.alloc(HEAD_BYTES)
  jsonLen0.write(MAGIC, 0, 'latin1')
  const bad = Buffer.from('{not json', 'utf8')
  jsonLen0.writeUInt32LE(bad.length, MAGIC.length)
  assert.ok(parsePack(Buffer.concat([jsonLen0, bad, Buffer.alloc(4)])).error)
})

test('parsePack 拒绝 kind 不符（不是小鲸鱼素材包）', () => {
  const buf = makePack({ kind: 'something-else', skins: [] }, Buffer.from('xx'))
  assert.ok(parsePack(buf).error)
})

test('parsePack 拒绝清单项越界（off/len 超数据区、负数、零长）', () => {
  const data = Buffer.from('0123456789') // dataLen = 10
  const cases = [
    { off: 0, len: 11 },   // 超出数据区
    { off: 5, len: 6 },    // 起点合法但末尾越界
    { off: -1, len: 2 },   // 负偏移
    { off: 0, len: 0 },    // 零长度
    { off: 0 },            // 缺 len
    null,                  // 空项
  ]
  for (const c of cases) {
    const buf = makePack(packManifest([c]), data)
    assert.ok(parsePack(buf).error, '应拒绝清单项：' + JSON.stringify(c))
  }
  // 合法项（off 0 len 10 正好铺满数据区）不报错
  const ok = parsePack(makePack(packManifest([{ name: 'a.webp', ext: 'webp', off: 0, len: 10 }]), data))
  assert.equal(ok.error, undefined)
  assert.equal(ok.dataStart, HEAD_BYTES + Buffer.from(JSON.stringify(packManifest([{ name: 'a.webp', ext: 'webp', off: 0, len: 10 }]))).length)
})

// ── 清单（listSkinPacks）────────────────────────────────────────────────

test('listSkinPacks 覆盖全部可下载形象，且已装标记为布尔', () => {
  const r = listSkinPacks()
  assert.equal(r.ok, true)
  assert.equal(r.items.length, SKIN_PACK_SKINS.length)
  assert.equal(r.totalSize, SKIN_PACK_SKINS.reduce((n, s) => n + s.size, 0))
  for (const it of r.items) {
    assert.equal(typeof it.installed, 'boolean')
    assert.equal(typeof it.id, 'string')
    assert.equal(typeof it.size, 'number')
  }
  assert.equal(r.installedCount, r.items.filter((x) => x.installed).length)
})

// ── 下载（注入 fetchImpl，只覆盖失败分支，不落真实磁盘）──────────────────

test('downloadSkinPacks：HTTP 非 2xx 直接失败', async () => {
  const r = await downloadSkinPacks({
    fetchImpl: async () => ({ ok: false, status: 502, statusText: 'Bad Gateway' }),
  })
  assert.equal(r.ok, false)
  assert.match(r.error, /502/)
})

test('downloadSkinPacks：空内容失败', async () => {
  const r = await downloadSkinPacks({
    fetchImpl: async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0) }),
  })
  assert.equal(r.ok, false)
  assert.match(r.error, /空内容/)
})

test('downloadSkinPacks：整体 sha256 不符被挡下（代理返回他物）', async () => {
  const junk = Buffer.from('this is not the pack, definitely wrong bytes')
  const r = await downloadSkinPacks({
    fetchImpl: async () => ({
      ok: true, status: 200,
      arrayBuffer: async () => junk.buffer.slice(junk.byteOffset, junk.byteOffset + junk.length),
    }),
  })
  assert.equal(r.ok, false)
  assert.match(r.error, /校验失败/)
})

test('downloadSkinPacks：整包校验通过但容器损坏 → 报损坏', async () => {
  // 造一个魔数不符的包，并把 SKIN_PACK_SHA256 之外的分支走通不可能（真实的哈希常量不可改），
  // 因此这里用「长度超上限」这条更靠前的守卫来验证「下到的东西不对」会被拦。
  const big = Buffer.alloc(constants.SKIN_PACK_MAX_BYTES + 1)
  const r = await downloadSkinPacks({
    fetchImpl: async () => ({
      ok: true, status: 200,
      arrayBuffer: async () => big.buffer.slice(big.byteOffset, big.byteOffset + big.length),
    }),
  })
  assert.equal(r.ok, false)
  assert.match(r.error, /异常大/)
})

test('downloadSkinPacks：网络异常（fetch 抛错）被兜住，返回 ok:false 而非抛出', async () => {
  const r = await downloadSkinPacks({
    fetchImpl: async () => { throw new Error('ETIMEDOUT') },
  })
  assert.equal(r.ok, false)
  assert.match(r.error, /ETIMEDOUT/)
})

// ── 下载源候选链（sourceChain）────────────────────────────────────────────
// 顺序约定：用户自填（可选） → 内置默认前缀（ghfast.top） → 真源直连（github.com）
//   → raw 直连 → raw 走默认前缀 → raw 走用户自填。
// 「都要」的诉求：可换源 + 代理挂了能直连 + 连 Release 都不通时还有 raw（且 raw 本身也能走代理）。

const { _sourceChain: sourceChain } = skinPacks
const { SKIN_PACK_ORIGIN, SKIN_PACK_DEFAULT_PREFIX, SKIN_PACK_URL, SKIN_PACK_RAW_MAIN } = constants

test('sourceChain：无自填时是「默认前缀 → 真源 → raw 直连 → raw 走默认前缀」四条，末尾必是 raw 相关', () => {
  const chain = sourceChain('')
  assert.deepEqual(chain, [
    SKIN_PACK_URL,
    SKIN_PACK_ORIGIN,
    SKIN_PACK_RAW_MAIN,
    SKIN_PACK_DEFAULT_PREFIX + SKIN_PACK_RAW_MAIN,
  ])
  assert.equal(chain[chain.length - 1], SKIN_PACK_DEFAULT_PREFIX + SKIN_PACK_RAW_MAIN, '末位应是 raw 走默认加速，保证 raw 也被代理覆盖')
})

test('sourceChain：自填前缀排在最前，真源与 raw 各有一条被它包装的候选', () => {
  const chain = sourceChain('https://my-proxy.example/')
  assert.equal(chain[0], 'https://my-proxy.example/' + SKIN_PACK_ORIGIN)
  // 后面仍是「默认 → 直连 → raw 直连 → raw 默认 → raw 自填」的兜底，不能因为用户填了就把兜底挤掉
  assert.deepEqual(chain.slice(1), [
    SKIN_PACK_URL,
    SKIN_PACK_ORIGIN,
    SKIN_PACK_RAW_MAIN,
    SKIN_PACK_DEFAULT_PREFIX + SKIN_PACK_RAW_MAIN,
    'https://my-proxy.example/' + SKIN_PACK_RAW_MAIN,
  ])
})

test('sourceChain：自填与内置前缀相同时去重（不重复打同一个源）', () => {
  const chain = sourceChain(SKIN_PACK_DEFAULT_PREFIX)
  assert.deepEqual(chain, [
    SKIN_PACK_URL,
    SKIN_PACK_ORIGIN,
    SKIN_PACK_RAW_MAIN,
    SKIN_PACK_DEFAULT_PREFIX + SKIN_PACK_RAW_MAIN,
  ])
})

test('sourceChain：空白 / 非字符串的自填被忽略，仍回落到内置链', () => {
  const expect = [
    SKIN_PACK_URL,
    SKIN_PACK_ORIGIN,
    SKIN_PACK_RAW_MAIN,
    SKIN_PACK_DEFAULT_PREFIX + SKIN_PACK_RAW_MAIN,
  ]
  assert.deepEqual(sourceChain('   '), expect)
  assert.deepEqual(sourceChain(undefined), expect)
  assert.deepEqual(sourceChain(null), expect)
})

test('downloadSkinPacks：首源失败自动顺延下一个（代理挂了走直连兜底）', async () => {
  const seen = []
  const r = await downloadSkinPacks({
    prefix: 'https://dead-proxy.example/',
    fetchImpl: async (url) => {
      seen.push(url)
      // 第一个源（用户自填）失败，第二个源（默认前缀）成功给出真包
      if (seen.length === 1) throw new Error('ECONNREFUSED')
      const buf = readFileSync(PACK_PATH)
      return { ok: true, status: 200, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length) }
    },
  })
  assert.equal(seen.length, 2, '应正好尝试两个源后停止')
  assert.equal(seen[0], 'https://dead-proxy.example/' + SKIN_PACK_ORIGIN)
  assert.equal(seen[1], SKIN_PACK_URL)
  // 后续安装会真的碰磁盘，这里允许失败；关键是「取到了合法包」这一步被走通
  assert.doesNotMatch(String(r.error || ''), /所有下载源都失败/)
})

test('downloadSkinPacks：全部源失败时报错串起各源标签，便于用户自查', async () => {
  const r = await downloadSkinPacks({
    prefix: 'https://dead-proxy.example/',
    fetchImpl: async () => { throw new Error('ENOTFOUND') },
  })
  assert.equal(r.ok, false)
  assert.match(r.error, /所有下载源都失败/)
  assert.match(r.error, /自定义加速源/)
  assert.match(r.error, /默认加速 ghfast\.top/)
  assert.match(r.error, /直连 github\.com/)
})
