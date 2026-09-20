/*
 * hosts.js 归一化函数的单测（node --test，零依赖）。
 *
 * normSources：设置页「获取方式」里社区源表的自定义顺序都过这里。它读的是设置页落盘的
 * 'community:<url>' 编码，而 allow 里是裸 URL —— 曾漏剥前缀，导致 filter 把用户排的项
 * 全部滤掉、再按默认序补回，用户排序 100% 失效且不抛任何错（表现为「UI 显示 gitcdn.top
 * 在前，来源列却大面积是 raw.hellogithub.com」）。这个坑只能靠单测钉住。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import hosts from '../public/preload/lib/hosts.js'
import constants from '../public/preload/lib/constants.js'

const { normSources, srcChainLabel, normCustomSources } = hosts
const { GH520_HOSTS_URL } = constants
const GITCDN = 'https://hosts.gitcdn.top/hosts.txt'

test('normSources 剥掉 community: 前缀后保序，用户排的源表顺序原样生效', () => {
  // 用户把 gitcdn.top 排在 raw.hellogithub.com 前面
  const out = normSources(['community:' + GITCDN, 'community:' + GH520_HOSTS_URL])
  assert.deepEqual(out, [GITCDN, GH520_HOSTS_URL])
})

test('normSources 反向排序同样生效（不是永远恰好的默认序）', () => {
  const out = normSources(['community:' + GH520_HOSTS_URL, 'community:' + GITCDN])
  assert.deepEqual(out, [GH520_HOSTS_URL, GITCDN])
})

test('normSources 只留已知源，未知 URL（含带前缀的）一律剔除', () => {
  const out = normSources(['community:https://evil.example/hosts', 'community:' + GITCDN])
  assert.deepEqual(out, [GITCDN, GH520_HOSTS_URL])
})

test('normSources 缺失的源按默认序补到末尾，老配置不漏源', () => {
  assert.deepEqual(normSources([]), [GH520_HOSTS_URL, GITCDN])
  assert.deepEqual(normSources(null), [GH520_HOSTS_URL, GITCDN])
  assert.deepEqual(normSources(['community:' + GITCDN]), [GITCDN, GH520_HOSTS_URL])
})

test('normSources 去重：同一源写两遍只留一次', () => {
  const out = normSources(['community:' + GITCDN, 'community:' + GITCDN])
  assert.deepEqual(out, [GITCDN, GH520_HOSTS_URL])
})

/*
 * srcChainLabel：操作日志标题里的来源链文案。它必须跟着用户设置走 ——
 * 原来标题写死「DoH 实时解析 + 社区源」，用户关掉 DoH 或调换顺序后标题仍照旧，
 * 日志等于在骗人。这里钉住「顺序照用户排的、关掉的不出现」两条。
 */
test('srcChainLabel 按用户排的顺序渲染，不是默认序', () => {
  const all = { doh: true, community: true, manual: true }
  assert.equal(srcChainLabel([], all), 'DoH 实时解析 > 社区源表 > 当前 IP 表（手填） > 内部兜底')
  assert.equal(
    srcChainLabel(['community', 'doh', 'manual'], all),
    '社区源表 > DoH 实时解析 > 当前 IP 表（手填） > 内部兜底'
  )
})

test('srcChainLabel 不列出被关掉的来源', () => {
  assert.equal(
    srcChainLabel([], { doh: false, community: true, manual: true }),
    '社区源表 > 当前 IP 表（手填） > 内部兜底'
  )
  assert.equal(srcChainLabel([], { doh: false, community: false, manual: true }), '当前 IP 表（手填） > 内部兜底')
})

test('srcChainLabel 全关时给出无法开启的提示，且不拼「内部兜底」', () => {
  assert.equal(srcChainLabel([], { doh: false, community: false, manual: false }), '（来源全关，无法开启）')
})

test('srcChainLabel src 缺省（老配置）时视为全开', () => {
  assert.equal(srcChainLabel([], undefined), 'DoH 实时解析 > 社区源表 > 当前 IP 表（手填） > 内部兜底')
  assert.equal(srcChainLabel([], {}), 'DoH 实时解析 > 社区源表 > 当前 IP 表（手填） > 内部兜底')
})

/*
 * normCustomSources：用户自加的社区源（粘贴 URL）的唯一一道校验。
 * 这些 URL 会被直接 fetch，配置又可被手改 / 从备份恢复，所以**必须**在这里挡掉
 * 非 http(s) 与非法串 —— 否则一个随便的字符串就会变成一次莫名其妙的网络请求。
 */
test('normCustomSources 只留 http(s) 的合法绝对 URL', () => {
  const out = normCustomSources([
    'https://my.example.com/hosts.txt',
    'http://ok.cn/h',
    'ftp://evil.example/h',
    'javascript:alert(1)',
    'not a url',
    '',
  ])
  assert.deepEqual(out, ['https://my.example.com/hosts.txt', 'http://ok.cn/h'])
})

test('normCustomSources 去重并 trim，非字符串项直接丢弃', () => {
  const out = normCustomSources([
    'https://a.example/h',
    '  https://a.example/h  ',
    null,
    123,
    { url: 'https://b.example/h' },
    'https://c.example/h',
  ])
  assert.deepEqual(out, ['https://a.example/h', 'https://c.example/h'])
})

test('normCustomSources 非数组入参（老配置 / 手改）返回空数组', () => {
  assert.deepEqual(normCustomSources(undefined), [])
  assert.deepEqual(normCustomSources(null), [])
  assert.deepEqual(normCustomSources('https://a.example/h'), [])
})

test('normCustomSources 截断到上限 10 个', () => {
  const many = []
  for (let i = 0; i < 30; i++) many.push('https://s' + i + '.example/hosts')
  const out = normCustomSources(many)
  assert.equal(out.length, 10)
  assert.equal(out[0], 'https://s0.example/hosts')
})

/*
 * 自定义源并入候选链：**追加在内置源之后**（内置源是人工验证过的高可靠快照），
 * 且只有在 sources 里显式写了才参与 —— 这就是「默认不参与，需手动启用」。
 */
test('normSources 未启用的自定义源不进候选链（「默认不参与」靠这条钉住）', () => {
  const custom = ['https://a.example/h']
  // 只声明了自定义源、但 sources 里没写它 → 候选链只该有内置源
  assert.deepEqual(normSources([], custom), [GH520_HOSTS_URL, GITCDN])
  assert.ok(!normSources(['community:' + GITCDN], custom).includes('https://a.example/h'))
})

test('normSources 自定义源排在 sources 里显式写下时才参与（默认不参与）', () => {
  const custom = ['https://a.example/h']
  // 用户把它勾上（sources 里出现）→ 按用户排的位置参与
  assert.deepEqual(
    normSources(['community:https://a.example/h', 'community:' + GITCDN], custom),
    ['https://a.example/h', GITCDN, GH520_HOSTS_URL]
  )
})

test('normSources 未启用的自定义源不因「补末尾」而混进候选链', () => {
  // 只声明了自定义源、但 sources 里一个都没写 → 候选链只该有内置源
  const out = normSources(['community:' + GITCDN], ['https://a.example/h'])
  assert.ok(!out.includes('https://a.example/h'))
})

test('normSources 剔除非法的自定义源（未过 normCustomSources 的 URL 不算已知源）', () => {
  const custom = ['https://a.example/h']
  const out = normSources(['community:https://evil.example/h'], custom)
  assert.ok(!out.includes('https://evil.example/h'))
  assert.deepEqual(out, [GH520_HOSTS_URL, GITCDN])
})
