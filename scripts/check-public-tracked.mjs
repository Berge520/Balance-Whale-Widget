/*
 * public/ 入库体检：public/ 下不允许存在 git 不认识的文件（未跟踪 `??` / 被忽略 `!!`）。
 *
 * 为什么需要：打包是 `cd dist && zip -qr ... .`（release.yml），**dist 里有什么就打什么**；
 * 而 dist 的内容由 vite.config.js 的 copyPublicExceptSkip 从 public/ 递归原样拷贝，
 * 排除清单里只有 2 个文件 + 1 个目录，没有任何「排除垃圾文件」的规则。于是路径是：
 * 改 preload 前存一份 `api.js.bak` → 原样进 dist/ → 打进 zip → 用户包里带着它。
 * 上游 DeepSeek-Balance-Whale-Widget 正是这么翻车的（lib/index.js.bak-devpaths 被打进包）。
 *
 * 为什么连 `!!`（被 .gitignore 忽略）也算：`.gitignore` 里恰好写了 `*.bak` / `*副本*` /
 * `*.log` / `*.tmp`，这些文件**不会**出现在默认的 `git status` 里 —— 只看 `??` 等于没查。
 * 判据统一成「git 不跟踪 = 构建会带进包里」，一条规则覆盖两种来源。
 *
 * 反向约束（有意为之）：public/ 下新加的文件必须 `git add`。它能进发行包，就该进仓库；
 * 只想本地试一下的东西别往 public/ 放。release zip 那边还有后缀黑名单兜底
 * （verify-release-zip.mjs 的 scanJunk），两者互补：这里挡「发布前就存在」，那里挡「已经发出去」。
 *
 * 用法：node scripts/check-public-tracked.mjs   # 有未入库文件则 exit 1（已挂 prebuild，见 package.json）
 * 自检：test/check-public-tracked.test.mjs 经 CPT_STATUS / CPT_ROOT 注入，不需要真 git 仓库。
 * 非 git 环境（下载的源码包 / 机器没装 git）fail-open：告警后 exit 0，不拦构建。
 */
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(
  process.env.CPT_ROOT || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'),
)

// porcelain v1 每行形如 `?? public/a.js` / `!! public/b.bak`；含空格或非 ASCII 的路径会被
// git 加双引号并转义，这里只剥外层引号 —— 路径只用来给人看，不必还原到能 open 的程度。
function offenders(status) {
  const out = []
  for (const raw of status.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '')
    if (line.length < 4) continue
    const code = line.slice(0, 2)
    if (code !== '??' && code !== '!!') continue
    out.push({ rel: line.slice(3).replace(/^"(.*)"$/, '$1'), ignored: code === '!!' })
  }
  return out
}

function gitStatus() {
  // `git` 在 Windows 上是 exe（不像 gh 是 .cmd），传参数数组即可，不必走 shell。
  // `--ignored` 必须带上：否则 .gitignore 命中的 .bak / 副本根本不会出现在输出里。
  const r = spawnSync('git', ['status', '--porcelain', '-uall', '--ignored', '--', 'public'], {
    cwd: root,
    encoding: 'utf8',
  })
  if (r.error || r.status !== 0) return null
  return r.stdout
}

const status = process.env.CPT_STATUS !== undefined ? process.env.CPT_STATUS : gitStatus()

if (status === null) {
  console.warn('[public-tracked] ⚠ 拿不到 git status（不是 git 仓库 / 没装 git），本关跳过')
  process.exit(0)
}

const bad = offenders(status)
if (!bad.length) {
  console.log('[public-tracked] public/ 下没有未入库文件')
  process.exit(0)
}

console.error('[public-tracked] ✗ public/ 下有 git 不认识的文件，它们会被原样拷进 dist/ 与发行包：')
for (const b of bad) {
  console.error(`  - ${b.rel}${b.ignored ? '（被 .gitignore 忽略，默认 git status 看不到）' : '（未跟踪）'}`)
}
console.error('  该进包的就 git add；只是本地试一下的（.bak / 副本 / 日志）请删掉或挪出 public/。')
process.exit(1)
