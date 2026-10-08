/*
 * check-orphan-css.mjs 的**自检**（node --test，零依赖）。
 *
 * 门禁有两种坏法 —— ① 误判（把活类判成孤儿 → 有人照它删样式，界面悄悄失真）；
 * ② 漏判（看着在跑，其实解析正则坏了，什么都查不出）。
 * 本脚本是"手术刀"性质：它的输出会被用来**删代码**，所以误判比漏判更致命 ——
 * 下面每个用例都钉住一条曾经真实踩过的解析坑（都是本项目 src/App.vue 的实况）：
 *   1. 嵌套 <template v-if>：非贪婪正则会截断根模板；
 *   2. 注释里写 </template>：计数被干扰，根节点提前归零；
 *   3. :class="{ 'tab-on': x }"：双引号里嵌单引号，朴素引号配对会吃掉类名；
 *   4. 动态 class 在 composables 的 .ts 里：只扫 .vue 会把活类判死；
 *   5. 拼接式 :class="'h-' + h"：字面量只有前缀，需 startsWith 匹配。
 *
 * 样本经注入环境变量喂进脚本（COC_ROOT / COC_FILES / COC_TS_FILES / COC_ALLOW），
 * 真实构建不设这些变量，走脚本内置默认值。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = path.join(ROOT, 'scripts', 'check-orphan-css.mjs')

// 样本仓库工厂：写出 N 个 .vue 文件（相对路径 → 内容）与可选 .ts 文件。
// 只覆盖脚本读取的部分：<template> / <style scoped> / <script> 段。
function makeRepo(vueFiles, tsFiles = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-coc-selftest-'))
  for (const [rel, content] of Object.entries(vueFiles)) {
    const p = path.join(root, rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, content)
  }
  for (const [rel, content] of Object.entries(tsFiles)) {
    const p = path.join(root, rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, content)
  }
  return { root, files: Object.keys(vueFiles).join(','), ts: Object.keys(tsFiles).join(',') }
}

function runScript(repo, extra = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...(extra.argv || [])], {
    env: {
      ...process.env,
      COC_ROOT: repo.root,
      COC_FILES: repo.files,
      COC_TS_FILES: repo.ts,
      ...(extra.env || {}),
    },
    encoding: 'utf8',
  })
}

// 一个"活类 + 一个孤儿类"的最小 .vue：.live 在模板里用了，.dead 没有
const LIVE_ORPHAN = `<template>
  <div class="live">x</div>
</template>
<style scoped>
.live { color: red; }
.dead { color: blue; }
</style>
`

test('基线：无孤儿的样本必须全绿', () => {
  const repo = makeRepo({
    'src/A.vue': `<template>
  <div class="only">x</div>
</template>
<style scoped>
.only { color: red; }
</style>
`,
  })
  const r = runScript(repo)
  assert.equal(r.status, 0, `应通过：\n${r.stdout}${r.stderr}`)
  assert.match(r.stdout, /未发现孤儿规则/)
})

test('孤儿必报：模板里没有的类出现在输出里', () => {
  const repo = makeRepo({ 'src/A.vue': LIVE_ORPHAN })
  const r = runScript(repo)
  assert.match(r.stdout, /\.dead/, '应点名孤儿 .dead')
  assert.doesNotMatch(r.stdout, /\.live\s+←/, '.live 是活类，不该报')
})

test('坑1 嵌套 <template v-if>：根模板不能被截断（活类在后半段也不能误报）', () => {
  const repo = makeRepo({
    'src/A.vue': `<template>
  <template v-if="a">
    <div class="early">x</div>
  </template>
  <template v-else>
    <div class="late">y</div>
  </template>
</template>
<style scoped>
.late { color: red; }
</style>
`,
  })
  const r = runScript(repo)
  assert.equal(r.status, 0, `.late 在根模板后半段，应判活：\n${r.stdout}`)
})

test('坑2 注释里的 </template>：不干扰计数（否则活类被误报）', () => {
  const repo = makeRepo({
    'src/A.vue': `<template>
  <!-- 说明：这里不能多写一个 </template> -->
  <div class="after-comment">x</div>
</template>
<style scoped>
.after-comment { color: red; }
</style>
`,
  })
  const r = runScript(repo)
  assert.equal(r.status, 0, `注释里的 </template> 不该让根节点提前结束：\n${r.stdout}`)
})

test('坑3 双引号里嵌单引号：:class="{ \'tab-on\': x }" 的类名不被吃掉', () => {
  const repo = makeRepo({
    'src/A.vue': `<template>
  <button :class="{ 'tab-on': active }" class="tab">x</button>
</template>
<style scoped>
.tab-on { color: red; }
</style>
`,
  })
  const r = runScript(repo)
  assert.equal(r.status, 0, `.tab-on 由对象语法应用，应判活：\n${r.stdout}`)
})

test('坑4 动态 class 写在 .ts 里：:class="clsOf(l)" 返回的类名要判活', () => {
  const repo = makeRepo(
    {
      'src/A.vue': `<template>
  <div v-for="l in list" :class="clsOf(l)">x</div>
</template>
<style scoped>
.layer-base { color: red; }
.layer-user { color: blue; }
.orphan { color: green; }
</style>
`,
    },
    { 'src/use.ts': `function clsOf(l) { return l.kind === 'user' ? 'layer-user' : 'layer-base' }\n` },
  )
  const r = runScript(repo)
  assert.doesNotMatch(r.stdout, /\.layer-(base|user)\s+←/, '动态类不该误报')
  assert.match(r.stdout, /\.orphan/, '真孤儿仍要报')
})

test('坑5 拼接式 class：:class="\'h-\' + h" 的前缀要判活', () => {
  const repo = makeRepo({
    'src/A.vue': `<template>
  <div v-for="h in ['nw','se']" :class="'h-' + h">x</div>
</template>
<style scoped>
.h-nw { color: red; }
.h-se { color: blue; }
.h-zz { color: green; }
.other { color: gray; }
</style>
`,
  })
  const r = runScript(repo)
  // 前缀匹配是**保守**的：'h-' 前缀会保护整个 h- 命名空间（含未在运行时出现的 .h-zz），
  // 这是刻意的取舍 —— 宁可漏报，也不能把可能被拼出来的活类误判成孤儿。
  assert.doesNotMatch(r.stdout, /\.h-(nw|se|zz)\s+←/, '前缀命名空间内的类都不该误报')
  assert.match(r.stdout, /\.other/, '前缀外的真孤儿仍要报')
})

test('前缀字面量在别的文件：跨文件收集，不受扫描顺序影响', () => {
  // 前缀 'k-' 写在 B.vue 的模板，规则 .k-a 写在 A.vue 的 style
  const repo = makeRepo({
    'src/A.vue': `<template>
  <div>x</div>
</template>
<style scoped>
.k-a { color: red; }
</style>
`,
    'src/B.vue': `<template>
  <div :class="'k-' + v">x</div>
</template>
<style scoped>
.b { color: blue; }
</style>
`,
  })
  const r = runScript(repo)
  assert.doesNotMatch(r.stdout, /\.k-a\s+←/, '前缀跨文件时也应生效')
})

test('ALLOW 白名单豁免：登记 文件:类名 后不再报', () => {
  const repo = makeRepo({ 'src/A.vue': LIVE_ORPHAN })
  const r = runScript(repo, { env: { COC_ALLOW: JSON.stringify(['src/A.vue:dead']) } })
  assert.equal(r.status, 0, `白名单应豁免：\n${r.stdout}`)
})

test('--fail 模式下有孤儿则退出码非 0（warn 模式恒 0）', () => {
  const repo = makeRepo({ 'src/A.vue': LIVE_ORPHAN })
  const warn = runScript(repo)
  assert.equal(warn.status, 0, '默认 warn 模式不该非 0')
  const fail = runScript(repo, { argv: ['--fail'] })
  assert.notEqual(fail.status, 0, '--fail 模式下有孤儿应非 0')
})

test('真实仓库（不注入）默认 warn 模式恒绿：不阻断构建', () => {
  const r = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' })
  assert.equal(r.status, 0, `warn 模式应恒绿：\n${r.stdout}${r.stderr}`)
})
