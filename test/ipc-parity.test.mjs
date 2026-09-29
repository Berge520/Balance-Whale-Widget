/*
 * IPC / services 对等门禁测试（node --test，零依赖）。
 *
 * 盯的是一类**静默失效**：前端调了宿主没提供的方法（或往宿主没监听的通道发消息），
 * 运行时只表现为 undefined 调用报错 / 消息石沉大海，构建三关（lint / typecheck / test）
 * 照样全绿。这里把两侧的「名字集合」抽出来做契约断言，让不一致在 CI 上直接红。
 *
 * 只认**结构事实**，不认行号、不认注释里的示例（先剥注释与字符串再匹配）：
 *   1. 设置页 window.services.<name>：引用 ⊆ settings.js 的 module.exports
 *   2. 悬浮窗 preload api.<name>：引用 ⊆ floating.js 暴露的 api 成员
 *   3. 悬浮窗上报通道 whale:<x>：发送 ⊆ ipc.js 的 ipcRenderer.on
 *   4. 悬浮窗接收通道 whale:<x>：host 推送 ⊆ floating.js 的 ipcRenderer.on
 * 另有一份显式 ALLOW 清单（三处不同实现、但都确实是「动态、无静态引用」的成员），
 * 且断言清单里**不得有已不存在的条目** —— 否则清单会随代码漂移、慢慢失去意义。
 *
 * ⚠️ 只读源码文本，不 require 任何业务模块。所以不需要 utools / electron 桩，
 *    也不会因模块顶层副作用（写日志、建目录）而污染环境。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const read = (rel) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')

// ── 先剥注释，再做任何匹配 ──
// 注释里的 `services.foo?.()` 是**示例/说明**，不是真实调用；把注释算进引用集合会造出
// 假阳性（要求宿主提供不存在的方法），故匹配前先剥掉注释。
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '') // 块注释
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1') // 行注释（`://` 是 URL，不是注释，用前缀排除）
}

// 收集 `obj.member` 形式的引用（如 services.xxx / whaleApi.xxx）
function refsOf(src, objName) {
  const src2 = stripComments(src)
  const re = new RegExp(`\\b${objName}\\.([A-Za-z_$][\\w$]*)`, 'g')
  const set = new Set()
  let m
  while ((m = re.exec(src2)) !== null) set.add(m[1])
  return set
}

// 收集 `ipcRenderer.<kind>('whale:x'` 里的 channel 名（kind = on / send）
function channelsOf(src, kind) {
  const src2 = stripComments(src)
  const re = new RegExp(`ipcRenderer\\.${kind}\\(\\s*['"]whale:([\\w-]+)['"]`, 'g')
  const set = new Set()
  let m
  while ((m = re.exec(src2)) !== null) set.add(m[1])
  return set
}

// 收集 `sendToWidget('whale:x'` 里的 channel 名（宿主 → 悬浮窗推送）
function sentToWidgetChannels(src) {
  const src2 = stripComments(src)
  const re = /sendToWidget\(\s*['"]whale:([\w-]+)['"]/g
  const set = new Set()
  let m
  while ((m = re.exec(src2)) !== null) set.add(m[1])
  return set
}

// settings.js 的 module.exports 对象键集：与顶层 require 无关，只需其导出契约
function settingsExports() {
  const src = stripComments(read('public/preload/lib/settings.js'))
  const m = src.match(/module\.exports\s*=\s*\{([\s\S]*)\}\s*$/)
  assert.ok(m, 'settings.js 里找不到 module.exports = { ... }，解析契约失败')
  return new Set([...m[1].matchAll(/(?:^|[\s,{])([A-Za-z_$][\w$]*)\s*(?:,|:|\(|$)/gm)].map((x) => x[1]))
}

// floating.js 的 `const api = { name(...) {...}, ... }` 成员集
function floatingApiMembers() {
  const src = stripComments(read('public/preload/floating.js'))
  const m = src.match(/const api\s*=\s*\{([\s\S]*?)\n\}/)
  assert.ok(m, 'floating.js 里找不到 `const api = { ... }`，解析契约失败')
  return new Set([...m[1].matchAll(/(?:^|[\s,{])([A-Za-z_$][\w$]*)\s*(?:\(|:|,)/gm)].map((x) => x[1]))
}

// 悬浮窗外发通道的**子集**：忽略 `__bridge` / `dev` 这两个非通道数据成员
function floatingSendChannels() {
  const src = stripComments(read('public/preload/floating.js'))
  return new Set([...src.matchAll(/send\(\s*['"]whale:([\w-]+)['"]/g)].map((m) => m[1]))
}

const SERVICES_SRC = read('src/App.vue')
const HOST_IPC = read('public/preload/lib/ipc.js')
const SETTINGS_EXPORTS = settingsExports()
const FLOAT_API = floatingApiMembers()

/*
 * 允许清单：前端有引用、但宿主确实不提供的预期例外（当前为空 —— 两侧已完全对等）。
 * 留这两个空集是为了日后出现「运行时按需拼出、静态扫描看不到实现」的成员时有地方登记，
 * 而不是被迫放宽整条断言。清单里不得出现已不存在的条目 —— 见最后一条用例。
 */
const ALLOW_SERVICES = new Set([])
const ALLOW_FLOAT_API = new Set([])

test('设置页引用的每个 services.<name>，宿主 module.exports 都要提供', () => {
  const used = refsOf(SERVICES_SRC, 'services')
  const missing = [...used].filter((n) => !SETTINGS_EXPORTS.has(n) && !ALLOW_SERVICES.has(n))
  assert.deepEqual(
    missing.sort(),
    [],
    '前端调了宿主没提供的方法，运行时会 undefined 调用报错；缺口：\n' + missing.join('\n'),
  )
})

test('悬浮窗引用的每个 whaleApi.<name>，floating.js 暴露的 api 都要有', () => {
  const PAGE = read('public/floating-page.js')
  const used = refsOf(PAGE, 'whaleApi')
  const missing = [...used].filter((n) => !FLOAT_API.has(n) && !ALLOW_FLOAT_API.has(n))
  assert.deepEqual(
    missing.sort(),
    [],
    '悬浮窗调了 preload 没暴露的成员；缺口：\n' + missing.join('\n'),
  )
})

test('悬浮窗上报的每个 whale:<x> 通道，主窗 ipc.js 都要监听', () => {
  const sent = floatingSendChannels()
  const listened = channelsOf(HOST_IPC, 'on')
  const missing = [...sent].filter((c) => !listened.has(c))
  assert.deepEqual(
    missing.sort(),
    [],
    '悬浮窗发了宿主没监听的通道，消息会石沉大海；缺口：\n' + missing.join('\n'),
  )
})

test('宿主推给悬浮窗的每个 whale:<x> 通道，floating.js 都要接收', () => {
  // 宿主侧推送散落多处（ipc.js / widget.js / settings.js），全部扫一遍
  const hosts = ['public/preload/lib/ipc.js', 'public/preload/lib/widget.js', 'public/preload/lib/settings.js']
  const pushed = new Set(hosts.flatMap((f) => [...sentToWidgetChannels(read(f))]))
  const received = channelsOf(read('public/preload/floating.js'), 'on')
  const missing = [...pushed].filter((c) => !received.has(c))
  assert.deepEqual(
    missing.sort(),
    [],
    '宿主往悬浮窗推了它没接收的通道，推送会被静默丢弃；缺口：\n' + missing.join('\n'),
  )
})

test('允许清单里不得有已不存在于两侧的条目（清单不能随代码漂移）', () => {
  // ALLOW_SERVICES 里的名字必须真的被前端引用过（否则是删掉的旧引用，清单成了垃圾）
  const usedSvc = refsOf(SERVICES_SRC, 'services')
  for (const n of ALLOW_SERVICES) {
    assert.ok(usedSvc.has(n), `ALLOW_SERVICES 里的 ${n} 前端已不再引用，应从清单删除`)
  }
  // ALLOW_FLOAT_API 同理：既要在页面被引用，又要真的不在 floating.js 的 api 里
  const usedFloat = refsOf(read('public/floating-page.js'), 'whaleApi')
  for (const n of ALLOW_FLOAT_API) {
    assert.ok(usedFloat.has(n), `ALLOW_FLOAT_API 里的 ${n} 页面已不再引用，应从清单删除`)
    assert.ok(!FLOAT_API.has(n), `ALLOW_FLOAT_API 里的 ${n} 已在 floating.js 暴露，应从清单删除`)
  }
})
