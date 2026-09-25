import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const dsh = require('../public/preload/lib/dsh.js')
const { verifyInstalledPkg, snapshotManifests, restoreManifests } = dsh

// 每个用例一个独立的临时包目录，用完即删
function withPkgDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-verify-'))
  try { return fn(dir) } finally { fs.rmSync(dir, { recursive: true, force: true }) }
}
function writeManifest(dir, obj) {
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(obj))
}

// ──────────────────────────────────────────────
// verifyInstalledPkg：退出码 0 之外的第二道判据
//
// 这组用例钉的是 dsh-market #676 / #694 那两个教训在本项目的落地：
// 「命令成功退出」不等于「磁盘上装好了能用的东西」。
// ──────────────────────────────────────────────

test('verifyInstalledPkg：正常装好（name 与依赖键一致、有 version）→ ok', () => {
  withPkgDir((dir) => {
    writeManifest(dir, { name: '@deepseek-ai/dsh', version: '0.1.7' })
    const v = verifyInstalledPkg(dir, '@deepseek-ai/dsh')
    assert.equal(v.ok, true)
    assert.equal(v.version, '0.1.7')
    assert.equal(v.name, '@deepseek-ai/dsh')
    assert.equal(v.why, '')
  })
})

test('verifyInstalledPkg：package.json 读不到（安装没跑完）→ 失败，且给可照抄的原因', () => {
  withPkgDir((dir) => {
    const v = verifyInstalledPkg(dir, '@deepseek-ai/dsh')
    assert.equal(v.ok, false)
    assert.match(v.why, /package\.json/)
  })
})

test('verifyInstalledPkg：package.json 不是合法 JSON → 失败（不能当成装好了）', () => {
  withPkgDir((dir) => {
    fs.writeFileSync(path.join(dir, 'package.json'), '{ 半截')
    const v = verifyInstalledPkg(dir, '@deepseek-ai/dsh')
    assert.equal(v.ok, false)
  })
})

test('verifyInstalledPkg：没有 version 字段 → 失败（安装不完整）', () => {
  withPkgDir((dir) => {
    writeManifest(dir, { name: '@deepseek-ai/dsh' })
    const v = verifyInstalledPkg(dir, '@deepseek-ai/dsh')
    assert.equal(v.ok, false)
    assert.equal(v.name, '@deepseek-ai/dsh')
    assert.match(v.why, /version/)
  })
})

// ⚠️ 本组最重要的一条：上游改名的假成功。
// npm install <旧名> 可以退出码 0、目录也在、甚至版本号看着也对 —— 但里面是别的包，
// 下次启动按依赖名 import 就炸。只看退出码/看目录存在都发现不了。
test('verifyInstalledPkg：目录里是别的包（上游改名）→ 失败，并报出实际装成了谁', () => {
  withPkgDir((dir) => {
    writeManifest(dir, { name: '@nagi-ovo/dsh-visualize', version: '0.3.0' })
    const v = verifyInstalledPkg(dir, '@dsh-external/dsh-visualize')
    assert.equal(v.ok, false)
    assert.equal(v.name, '@nagi-ovo/dsh-visualize')
    // 文案必须同时给出「装到了哪个名下」和「实际是谁」，否则用户无从下手
    assert.match(v.why, /@dsh-external\/dsh-visualize/)
    assert.match(v.why, /@nagi-ovo\/dsh-visualize/)
  })
})

test('verifyInstalledPkg：不传 expectedName 时只校验「读得到且完整」', () => {
  withPkgDir((dir) => {
    writeManifest(dir, { name: 'anyone/whatever', version: '9.9.9' })
    const v = verifyInstalledPkg(dir, '')
    assert.equal(v.ok, true)
  })
})

test('verifyInstalledPkg：manifest 里没有 name 时不拿它判改名（拿不到证据 ≠ 有问题）', () => {
  withPkgDir((dir) => {
    // 只有 version：能确认「装好了」，但拿不到 name 就不能断言「装错了」
    writeManifest(dir, { version: '0.1.7' })
    const v = verifyInstalledPkg(dir, '@deepseek-ai/dsh')
    assert.equal(v.ok, true)
    assert.equal(v.name, '')
  })
})

// ──────────────────────────────────────────────
// snapshotManifests / restoreManifests：失败后的回滚
//
// 对应 dsh-market #663 的 ghost dependency：清单里写着、磁盘上没有，
// 下次启动组装 profile 就失败。所以安装前先快照、失败时写回。
// ──────────────────────────────────────────────

test('snapshotManifests：只收实际存在的清单，缺的不编造空条目', () => {
  withPkgDir((dir) => {
    fs.writeFileSync(path.join(dir, 'package.json'), '{"a":1}')
    const snaps = snapshotManifests(dir)
    assert.deepEqual(snaps.map((s) => s.name), ['package.json'])
  })
})

test('snapshotManifests + restoreManifests：能把改坏的清单恢复原样', () => {
  withPkgDir((dir) => {
    const original = '{"dependencies":{"@deepseek-ai/dsh":"0.1.6"}}'
    fs.writeFileSync(path.join(dir, 'package.json'), original)
    fs.writeFileSync(path.join(dir, 'package-lock.json'), '{"lockfileVersion":3}')
    const snaps = snapshotManifests(dir)

    // 模拟「npm 跑了一半」：package.json 被改写、lock 被删
    fs.writeFileSync(path.join(dir, 'package.json'), '{"dependencies":{"@ghost/pkg":"1.0.0"}}')
    fs.rmSync(path.join(dir, 'package-lock.json'))

    const restored = restoreManifests(snaps)
    assert.deepEqual(restored.sort(), ['package-lock.json', 'package.json'])
    assert.equal(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'), original)
    assert.equal(fs.readFileSync(path.join(dir, 'package-lock.json'), 'utf8'), '{"lockfileVersion":3}')
  })
})

test('restoreManifests：快照为空数组时不报错（本来就没有可恢复的）', () => {
  assert.deepEqual(restoreManifests([]), [])
  assert.deepEqual(restoreManifests(null), [])
})

test('restoreManifests：单个文件写不进去也不抛错，且其余文件仍被恢复', () => {
  withPkgDir((dir) => {
    fs.writeFileSync(path.join(dir, 'package.json'), '{"ok":1}')
    const snaps = snapshotManifests(dir)
    // 塞一条指向不存在目录的条目：写它必然失败（这是「补偿动作自己出错」的场景）
    snaps.push({ path: path.join(dir, 'nope', 'package.json'), name: 'booby-trap', data: '{}' })
    // 关键：不抛错 —— 清理/回滚失败不该把主流程也带崩（dsh-market #662 的教训）
    const restored = restoreManifests(snaps)
    assert.deepEqual(restored, ['package.json'])
  })
})

// ──────────────────────────────────────────────
// checkGhostDeps：启动前的幽灵依赖自检
//
// 安装期的回滚（上面那组）只管**本次**安装；历史上装了一半的目录不会自己好，
// 会一路躺到下次启动、dsh 组装时才炸。这组用例钉住「启动前就发现并说清怎么修」。
// ──────────────────────────────────────────────

const { checkGhostDeps } = dsh

// 在包目录里造出「依赖已落地」的假象（只建目录即可，自检只看存不存在）
function mkDep(dir, name) {
  fs.mkdirSync(path.join(dir, 'node_modules', name), { recursive: true })
}

test('checkGhostDeps：依赖都在磁盘上 → ok', () => {
  withPkgDir((dir) => {
    writeManifest(dir, { name: '@deepseek-ai/dsh', version: '0.1.7', dependencies: { a: '1.0.0', b: '2.0.0' } })
    mkDep(dir, 'a')
    mkDep(dir, 'b')
    const g = checkGhostDeps(dir)
    assert.equal(g.ok, true)
    assert.deepEqual(g.missing, [])
    assert.equal(g.why, '')
  })
})

test('checkGhostDeps：清单里有、磁盘上没有 → 失败，并列出缺的名字', () => {
  withPkgDir((dir) => {
    writeManifest(dir, { name: '@deepseek-ai/dsh', version: '0.1.7', dependencies: { a: '1.0.0', ghost: '2.0.0' } })
    mkDep(dir, 'a')
    const g = checkGhostDeps(dir)
    assert.equal(g.ok, false)
    assert.deepEqual(g.missing, ['ghost'])
    // 文案要能让用户直接照做：缺几个 + 举例缺了什么
    assert.match(g.why, /1 个依赖/)
    assert.match(g.why, /ghost/)
  })
})

test('checkGhostDeps：optionalDependencies 缺失不算幽灵依赖（允许装不上）', () => {
  withPkgDir((dir) => {
    writeManifest(dir, { name: '@deepseek-ai/dsh', version: '0.1.7', optionalDependencies: { maybe: '1.0.0' } })
    const g = checkGhostDeps(dir)
    assert.equal(g.ok, true)
  })
})

test('checkGhostDeps：同一名字同时出现在 dependencies 和 optional 里时按 dependencies 算（缺了要报）', () => {
  withPkgDir((dir) => {
    // npm 语义：dependencies 优先，optionalDependencies 只是「允许失败」的补充，
    // 但被 dependencies 明确要求的包缺了就是坏 —— 不能被 optional 那遍跳过
    writeManifest(dir, { name: '@deepseek-ai/dsh', version: '0.1.7', dependencies: { both: '1.0.0' }, optionalDependencies: { both: '1.0.0' } })
    const g = checkGhostDeps(dir)
    assert.equal(g.ok, false)
    assert.deepEqual(g.missing, ['both'])
  })
})

test('checkGhostDeps：没有依赖声明 → ok（空清单不是异常）', () => {
  withPkgDir((dir) => {
    writeManifest(dir, { name: '@deepseek-ai/dsh', version: '0.1.7' })
    const g = checkGhostDeps(dir)
    assert.equal(g.ok, true)
  })
})

test('checkGhostDeps：package.json 读不到 → 失败（目录不完整）', () => {
  withPkgDir((dir) => {
    const g = checkGhostDeps(dir)
    assert.equal(g.ok, false)
    assert.match(g.why, /package\.json/)
  })
})

test('checkGhostDeps：缺得再多也只枚举 8 个（报错不该无限长）', () => {
  withPkgDir((dir) => {
    const deps = {}
    for (let i = 0; i < 20; i++) deps['dep' + i] = '1.0.0'
    writeManifest(dir, { name: '@deepseek-ai/dsh', version: '0.1.7', dependencies: deps })
    const g = checkGhostDeps(dir)
    assert.equal(g.ok, false)
    assert.equal(g.missing.length, 8)
  })
})
