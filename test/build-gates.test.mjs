/*
 * 构建门禁的**自身**守卫测试（node --test，零依赖）。
 *
 * 这里不测产品逻辑，测的是「门禁还在链路上」这件事。
 * sync-version.mjs 与 check-shared.mjs 由 prebuild 钩子触发，而 prebuild 只在
 * `npm run build` 时跑；如果有人重写 package.json 的 scripts、把其中一环悄悄删掉，
 * 三关（lint / typecheck / test）依然全绿，构建也照样成功 —— 门禁消失却没有任何信号。
 * 这类「守卫静默退役」是最难发现的失效方式，因此这里对 scripts 与 CI 工作流做契约断言：
 *   - prebuild 必须同时包含 sync-version.mjs（版本号单一来源）与 check-shared.mjs（跨文件副本）
 *   - ci.yml / release.yml 必须真的执行 npm run build（否则 prebuild 永远不会被触发）
 *   - Release 必须校验 tag 与 package.json 版本一致（否则产物与版本号可能各说各话）
 *
 * ⚠️ 只读文件、不写任何东西；断言的是「脚本被接上」这一事实，不校验脚本内部逻辑 ——
 *    内部逻辑由脚本自身的运行结果（构建失败）来兜。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const read = (rel) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')

const pkg = JSON.parse(read('package.json'))
const ci = read('.github/workflows/ci.yml')
const release = read('.github/workflows/release.yml')

test('prebuild 同时挂上 sync-version 与 check-shared', () => {
  const prebuild = pkg.scripts?.prebuild
  assert.ok(prebuild, 'package.json 缺少 prebuild 脚本，两个门禁都不会被触发')
  assert.match(prebuild, /scripts\/sync-version\.mjs/, 'prebuild 少了 sync-version.mjs：版本号不再从 package.json 传播')
  assert.match(prebuild, /scripts\/check-shared\.mjs/, 'prebuild 少了 check-shared.mjs：跨文件副本不再校验')
})

test('prebuild 仍由 build 触发', () => {
  // npm 会在 `npm run build` 前自动跑 prebuild，前提是 build 脚本存在且未被改名
  assert.ok(pkg.scripts?.build, 'package.json 缺少 build 脚本，prebuild 钩子不会被执行')
})

test('CI 与 Release 都真的执行 npm run build', () => {
  // 只看脚本存在还不够：门禁要靠 build 触发，工作流必须调用它
  for (const [name, yml] of [['ci.yml', ci], ['release.yml', release]]) {
    assert.match(yml, /npm run build/, `${name} 没有执行 npm run build，prebuild 里的门禁形同虚设`)
  }
})

test('CI 真的执行 lint / typecheck / test 三关', () => {
  // 与上一条同理，但针对另外三关：它们不挂在任何钩子上，只能靠工作流显式调用。
  // 若有人精简 ci.yml 时删掉其中一条，本地三关照绿、PR 也不再拦截，
  // 「四关」静默退化成「三关」而没有任何信号 —— 所以在这里钉住。
  //
  // ⚠️ 允许 `npm run test` 与 `npm test` 两种写法：ci.yml 当前用的是后者（别的关用前者），
  //    只认一种会把「换个等价写法」误判成「门禁被删」。行尾锚定，避免前缀相同的脚本
  //    （如 npm run lint-old）被当成通过。
  for (const [script, what] of [['lint', '静态检查'], ['typecheck', '类型检查'], ['test', '单元测试']]) {
    const re = new RegExp(`npm (?:run )?${script}\\s*$`, 'm')
    assert.match(ci, re, `ci.yml 没有执行 npm ${script}，${what}这一关已失效`)
  }
})

test('Release 校验 tag 与 package.json 版本一致', () => {
  // 版本号单一来源是 package.json，tag 只是「这一版要发」的显式动作；
  // 两者对不上会让 Release 的产物与版本号各说各话
  assert.match(release, /GITHUB_REF_NAME/, 'release.yml 没有读取 tag 名，无法校验版本')
  assert.match(release, /package\.json/, 'release.yml 没有读取 package.json 版本，无法校验版本')
})
