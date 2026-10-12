/*
 * hosts.js 单测（node --test，零依赖）。分两块：
 *
 * ① 归一化函数（normSources / srcChainLabel / normCustomSources / normSrcOrder）
 *    normSources：设置页「获取方式」里社区源表的自定义顺序都过这里。它读的是设置页落盘的
 *    'community:<url>' 编码，而 allow 里是裸 URL —— 曾漏剥前缀，导致 filter 把用户排的项
 *    全部滤掉、再按默认序补回，用户排序 100% 失效且不抛任何错（表现为「UI 显示 gitcdn.top
 *    在前，来源列却大面积是 raw.hellogithub.com」）。这个坑只能靠单测钉住。
 *
 * ② 纯计算 / 内存态助手（mapLimit / 证书匹配 / DoH 拼名 / 按字节读写 hosts / 操作日志）
 *    这些都不发网络、不碰真实文件系统，但取错值 / 写错字节都**不抛错**，只会静默毁数据：
 *    · certMatchesDomain 判错 → 把别家域名的 IP 写进 hosts，浏览器因证书不匹配直接拦死；
 *    · stripBlock / prependBlock 范围算错 → 删掉或污染用户的系统 hosts；
 *    · mapLimit 并发/同序算错 → 设置页卡死、或结果错位（按下标取到别人的 IP）。
 *    故全部用机器钉死。
 *
 * 注：本测试不挂 utools 桩。hosts.js 顶层经 log.js 取日志路径失败时回落 ''，log() 只打控制台、
 * 不落盘 —— 与既有用例一致，也不会污染真实 %TEMP%。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import hosts from '../public/preload/lib/hosts.js'
import constants from '../public/preload/lib/constants.js'

const {
  normSources, srcChainLabel, normCustomSources, normSrcOrder,
  mapLimit, srcHost, guessWriter, certMatchesDomain, dohName, dohUrl,
  lineStart, lineEnd, stripBlock, prependBlock, blockActive,
  opStart, opStep, opProgress, opEnd, ghAccelOpLogs, clearGhAccelOpLogs,
} = hosts
const { GH520_HOSTS_URL, GH_DOMAINS } = constants
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

// ──────────────────────────────────────────────
// normSrcOrder：候选链来源顺序（doh / community / manual）
// ──────────────────────────────────────────────
test('normSrcOrder 保序去重，缺失键按默认序补末尾', () => {
  assert.deepEqual(normSrcOrder(['doh', 'community', 'manual']), ['doh', 'community', 'manual'])
  assert.deepEqual(normSrcOrder(['manual', 'doh']), ['manual', 'doh', 'community'])
  assert.deepEqual(normSrcOrder(['doh', 'doh', 'manual']), ['doh', 'manual', 'community'])
  // 未知键直接剔除；非数组 / 缺省回落默认序（老配置行为不变）
  assert.deepEqual(normSrcOrder(['doh', 'bogus', 'community']), ['doh', 'community', 'manual'])
  assert.deepEqual(normSrcOrder([]), ['doh', 'community', 'manual'])
  assert.deepEqual(normSrcOrder(null), ['doh', 'community', 'manual'])
  assert.deepEqual(normSrcOrder(undefined), ['doh', 'community', 'manual'])
})

// ──────────────────────────────────────────────
// mapLimit：带并发上限的 map（结果同序 + 并发不超限）
// ──────────────────────────────────────────────
test('mapLimit 结果数组与入参同序（调用方按下标取值的硬依赖）', async () => {
  const items = [5, 1, 4, 2, 3]
  // task 故意乱序完成（睡眠时间与值成反比）—— 结果仍须按入参顺序落位
  const out = await mapLimit(items, 3, async (n) => {
    await new Promise((r) => setTimeout(r, (6 - n) * 5))
    return n * 10
  })
  assert.deepEqual(out, [50, 10, 40, 20, 30])
})

test('mapLimit 任一时刻在飞的 task 数不超过 limit', async () => {
  let live = 0
  let peak = 0
  const items = Array.from({ length: 12 }, (_, i) => i)
  await mapLimit(items, 4, async () => {
    live++
    peak = Math.max(peak, live)
    await new Promise((r) => setTimeout(r, 3))
    live--
    return 'ok'
  })
  assert.equal(peak, 4, '并发上限必须真的生效（否则会把渲染主线程压住）')
})

test('mapLimit 空入参立即返回空数组；limit 的 0 / 负数 / 小数被归一', async () => {
  assert.deepEqual(await mapLimit([], 3, async () => 1), [])
  assert.deepEqual(await mapLimit(null, 3, async () => 1), [])
  // limit=0 若不加保护会一个都不跑、Promise 永不 settle —— 这里必须仍跑完
  assert.deepEqual(await mapLimit([1, 2], 0, async (n) => n + 1), [2, 3])
  assert.deepEqual(await mapLimit([1, 2], -5, async (n) => n + 1), [2, 3])
  assert.deepEqual(await mapLimit([1, 2], 1.6, async (n) => n + 1), [2, 3])
  // limit 超过元素数时退化为不限并发
  assert.deepEqual(await mapLimit([1, 2], 99, async (n) => n + 1), [2, 3])
})

test('mapLimit 把下标一并传给 task；task 拒绝时整体拒绝', async () => {
  const seen = []
  const out = await mapLimit(['a', 'b'], 2, async (v, i) => { seen.push([i, v]); return i })
  assert.deepEqual(out, [0, 1])
  assert.deepEqual(seen.sort((x, y) => x[0] - y[0]), [[0, 'a'], [1, 'b']])
  await assert.rejects(() => mapLimit([1, 2, 3], 2, async (n) => { if (n === 2) throw new Error('boom') }), /boom/)
})

// ──────────────────────────────────────────────
// srcHost / guessWriter / dohName / dohUrl
// ──────────────────────────────────────────────
test('srcHost 取主机名，非法 URL 回落到去协议后的首段', () => {
  assert.equal(srcHost('https://raw.hellogithub.com/hosts'), 'raw.hellogithub.com')
  assert.equal(srcHost('http://hosts.gitcdn.top/hosts.txt'), 'hosts.gitcdn.top')
  assert.equal(srcHost('not a url/x'), 'not a url')
  assert.equal(srcHost(''), '')
})

test('guessWriter 只认高置信特征：回环地址 → 本地反代类工具，其余留空', () => {
  assert.equal(guessWriter('127.0.0.1'), '本地反代类工具')
  assert.equal(guessWriter('0.0.0.0'), '本地反代类工具')
  // 猜不准就返回空串，由调用方退回中性说法「第三方条目」（猜错比不猜更糟）
  assert.equal(guessWriter('185.199.108.133'), '')
  assert.equal(guessWriter(''), '')
})

test('dohName 把入口归到厂商简称，未知入口回落到主机名', () => {
  assert.equal(dohName('https://223.5.5.5/resolve'), '阿里 DNS')
  assert.equal(dohName('https://1.1.1.1/dns-query'), 'Cloudflare')
  assert.equal(dohName('1.0.0.1'), 'Cloudflare')
  assert.equal(dohName('https://dns.google/resolve'), 'Google')
  assert.equal(dohName('https://8.8.8.8/resolve'), 'Google')
  assert.equal(dohName('https://my.doh.example/resolve'), 'my.doh.example')
})

test('dohUrl 拼接标准 DoH 查询（name + type=A）', () => {
  assert.equal(dohUrl('https://223.5.5.5/resolve', 'github.com'), 'https://223.5.5.5/resolve?name=github.com&type=A')
})

// ──────────────────────────────────────────────
// certMatchesDomain：证书 SAN 匹配（判错会把别家域名的 IP 写进 hosts）
// ──────────────────────────────────────────────
test('certMatchesDomain 认 CN 精确与 *.通配', () => {
  assert.equal(certMatchesDomain({ subject: { CN: 'github.com' } }, 'github.com'), true)
  assert.equal(certMatchesDomain({ subject: { CN: '*.github.com' } }, 'api.github.com'), true)
  // 实现用 endsWith('.github.com')，多级子域同样命中（真实证书校验允许多级）
  assert.equal(certMatchesDomain({ subject: { CN: '*.github.com' } }, 'a.b.github.com'), true)
  // 但无点分隔的同后缀域名不能命中（evilgithub.com 不以 .github.com 结尾）
  assert.equal(certMatchesDomain({ subject: { CN: '*.github.com' } }, 'evilgithub.com'), false)
  assert.equal(certMatchesDomain({ subject: { CN: 'evil.com' } }, 'github.com'), false)
})

test('certMatchesDomain 解析 SAN 列表（DNS: 前缀 + 通配）', () => {
  const cert = { subject: { CN: 'ignored' }, subjectaltname: 'DNS:github.com, DNS:*.github.com, IP Address:1.2.3.4' }
  assert.equal(certMatchesDomain(cert, 'github.com'), true)
  assert.equal(certMatchesDomain(cert, 'raw.githubusercontent.com'), false)
  assert.equal(certMatchesDomain(cert, 'api.github.com'), true)
  // IP Address 段不是 DNS，不该被当成域名匹配
  assert.equal(certMatchesDomain(cert, '1.2.3.4'), false)
})

test('certMatchesDomain 缺证书 / 缺域名一律 false（宁可不写也不写错）', () => {
  assert.equal(certMatchesDomain(null, 'github.com'), false)
  assert.equal(certMatchesDomain(undefined, 'github.com'), false)
  assert.equal(certMatchesDomain({ subject: { CN: 'github.com' } }, ''), false)
})

// ──────────────────────────────────────────────
// 按字节读写 hosts：lineStart / lineEnd / stripBlock / prependBlock / blockActive
// ──────────────────────────────────────────────
const B = (s) => Buffer.from(s, 'utf8')

test('lineStart / lineEnd 定位所在行的边界（不含换行符）', () => {
  const buf = B('aa\nbbb\ncc')
  assert.equal(lineStart(buf, 0), 0)      // 第一行行首
  assert.equal(lineStart(buf, 1), 0)
  assert.equal(lineStart(buf, 4), 3)      // 'bbb' 内部 → 行首 3
  assert.equal(lineEnd(buf, 3), 6)        // 'bbb' 行 → 行尾 6（指向 \n）
  assert.equal(lineEnd(buf, 0), 2)        // 'aa'
  assert.equal(lineStart(buf, 9), 7)      // 最后一行无换行
  assert.equal(lineEnd(buf, 9), buf.length)
})

test('stripBlock 删掉整段标记块（含块尾换行），保留块外内容', () => {
  const buf = B('before\r\n' + '# >>> whale-ghaccel start >>>\r\n1.2.3.4 github.com\r\n# <<< whale-ghaccel end <<<\r\nafter\r\n')
  assert.equal(stripBlock(buf).toString('utf8'), 'before\r\nafter\r\n')
})

test('stripBlock 循环删多段块（其它工具复制粘贴 / 上次写坏残留）', () => {
  const one = '# >>> whale-ghaccel start >>>\n1.2.3.4 github.com\n# <<< whale-ghaccel end <<<\n'
  const buf = B('x\n' + one + 'middle\n' + one + 'y\n')
  assert.equal(stripBlock(buf).toString('utf8'), 'x\nmiddle\ny\n')
})

test('stripBlock 头在而尾缺（异常残留）从行首删到文件尾', () => {
  const buf = B('keep\n# >>> whale-ghaccel start >>>\n1.2.3.4 github.com\n')
  assert.equal(stripBlock(buf).toString('utf8'), 'keep\n')
})

test('stripBlock 无块时原样返回', () => {
  const buf = B('127.0.0.1 localhost\n')
  assert.equal(stripBlock(buf).toString('utf8'), '127.0.0.1 localhost\n')
})

test('prependBlock 把块写到最前，且非空原文不被粘连', () => {
  const out = prependBlock(B('127.0.0.1 localhost'), [{ ip: '1.2.3.4', domain: 'github.com' }]).toString('utf8')
  assert.ok(out.startsWith('# >>> whale-ghaccel start >>>'), '块必须在最前（Windows 首次匹配解析）')
  assert.ok(out.includes('1.2.3.4 github.com'))
  assert.ok(out.includes('# <<< whale-ghaccel end <<<'))
  // 原文完整保留；原文不以换行结尾时实现会在原文末尾补 \r\n，避免下次再写块时粘连
  assert.ok(out.includes('127.0.0.1 localhost'))
  assert.ok(out.endsWith('127.0.0.1 localhost\r\n'), '原文末尾补换行，不再与后续内容粘连')
  // 块尾与原文之间由块自身的 \r\n 隔开，不会粘成一行
  assert.ok(out.includes('end <<<\r\n127.0.0.1'))
})

test('prependBlock(stripBlock(x)) 往返不破坏块外内容', () => {
  const original = B('127.0.0.1 localhost\n::1 localhost\n')
  const stripped = stripBlock(prependBlock(original, [{ ip: '1.2.3.4', domain: 'github.com' }]))
  assert.equal(stripped.toString('utf8'), original.toString('utf8'))
})

test('blockActive 解析块内生效域名：按域名去重，只认合法 IPv4 + GH_DOMAINS', () => {
  const ips = [
    { ip: '1.2.3.4', domain: 'github.com' },
    { ip: '5.6.7.8', domain: 'github.com' },          // 同域名多候选 → 只算一次
    { ip: '9.9.9.9', domain: 'api.github.com' },
  ]
  const buf = prependBlock(B(''), ips)
  assert.deepEqual(blockActive(buf).sort(), ['api.github.com', 'github.com'])
  // 无块 → 空
  assert.deepEqual(blockActive(B('127.0.0.1 localhost\n')), [])
})

test('blockActive 过滤块内被手工塞入的非法条目（非 IP / 非目标域名）', () => {
  const buf = B('# >>> whale-ghaccel start >>>\nnot-an-ip github.com\n1.2.3.4 evil.example\n1.2.3.4 github.com # 注释\n# <<< whale-ghaccel end <<<\n')
  assert.deepEqual(blockActive(buf), ['github.com'])
  // GH_DOMAINS 与块内容同源，确认 github.com 确实在清单里（防清单被改名后本用例假绿）
  assert.ok(GH_DOMAINS.includes('github.com'))
})

// ──────────────────────────────────────────────
// 操作日志族（内存态环形缓冲，含快照复用）
// ──────────────────────────────────────────────
test('opStart/opStep/opProgress/opEnd 串起一条完整操作记录', () => {
  clearGhAccelOpLogs()
  const op = opStart('开启加速')
  assert.equal(op.state, 'running')
  opStep(op, '写 hosts', 'done', '3 条')
  const step = opStep(op, '校验中', 'running')
  opProgress(step, 2, 5, 'github.com')
  assert.match(step.detail, /已测 2\/5 条/)
  opEnd(op, 'ok', '完成啦')
  const logs = ghAccelOpLogs()
  assert.equal(logs.length, 1)
  assert.equal(logs[0].title, '开启加速')
  assert.equal(logs[0].state, 'ok')
  assert.equal(logs[0].summary, '完成啦')
  assert.equal(typeof logs[0].ms, 'number')
  assert.equal(logs[0].steps.length, 2)
  clearGhAccelOpLogs()
})

test('opStart 环形缓冲上限 50，超出丢最旧；id 递增', () => {
  clearGhAccelOpLogs()
  const ids = []
  for (let i = 0; i < 55; i++) ids.push(opStart('op' + i).id)
  const logs = ghAccelOpLogs()
  assert.equal(logs.length, 50)
  assert.equal(logs[0].id, ids[ids.length - 1], '最新在最前')
  assert.equal(new Set(ids).size, 55, 'id 单调递增不重复')
  clearGhAccelOpLogs()
})

test('ghAccelOpLogs 返回深拷贝：改快照不污染内部历史', () => {
  clearGhAccelOpLogs()
  const op = opStart('t')
  opStep(op, 's', 'done', 'd')
  const snap = ghAccelOpLogs()
  // 快照是内部 opLogs 的深拷贝：改它不影响宿主内部历史
  assert.notEqual(snap[0], op, '快照元素不能是内部 entry 的同一引用')
  assert.notEqual(snap[0].steps[0], op.steps[0], '嵌套 steps 也须深拷贝')
  snap[0].title = '改坏了'
  snap[0].steps[0].text = '改坏了'
  // 递增版本号（触发重新深拷贝）后取到的是未被污染的原始值
  opProgress(op, 1, 2)
  const again = ghAccelOpLogs()
  assert.equal(again[0].title, 't')
  assert.equal(again[0].steps[0].text, 's')
  clearGhAccelOpLogs()
})

test('内容未变时 ghAccelOpLogs 复用同一份快照（省轮询深拷贝）', () => {
  clearGhAccelOpLogs()
  opStart('t')
  const a = ghAccelOpLogs()
  const b = ghAccelOpLogs()
  assert.equal(a, b, '版本号未变应返回同一引用')
  clearGhAccelOpLogs()
  const c = ghAccelOpLogs()
  assert.notEqual(b, c, '清空后版本号变化，须给新快照')
})

test('clearGhAccelOpLogs 返回清空条数并把日志归零', () => {
  clearGhAccelOpLogs()
  opStart('a')
  opStart('b')
  assert.equal(clearGhAccelOpLogs(), 2)
  assert.equal(ghAccelOpLogs().length, 0)
  // 清空后 id 从 1 重来
  assert.equal(opStart('c').id, 1)
  clearGhAccelOpLogs()
})

test('opStep/opEnd/opProgress 传入空 entry 不抛错（防御调用方漏判）', () => {
  assert.equal(opStep(null, 'x'), undefined)
  assert.doesNotThrow(() => opEnd(null, 'ok'))
  assert.doesNotThrow(() => opProgress(null, 1, 2))
})
