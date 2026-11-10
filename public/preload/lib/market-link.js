// 市场条目的外链判定（纯函数叶子：零依赖、不读配置、不做 IO，可无桩单测）。
//
// 为什么单独成文件：dsh-market.js 已进文件体积白名单（只缩不涨），而这两件事
// 与「目录抓取 / 归一 / 筛选」正交 —— 一个判「能不能打开」，一个推「源码在哪」。

// 外链白名单的唯一判定：只放行 http(s)，返回归一后的 href，否则 ''。
// 宿主 settings.openExternal 与设置页共用这一处 —— 目录的 page/url 是第三方内容，
// 而 shellOpenExternal 对 `file:` 是「把路径交给系统壳」而非「打不开」；
// 相对串也拒绝（没有 base，本就不是一个完整外链）。
function safeWebUrl(u) {
  const s = String(u == null ? '' : u).trim()
  if (!s) return ''
  let url = null
  try { url = new URL(s) } catch { return '' }
  return /^https?:$/i.test(url.protocol) ? url.href : ''
}

// 从安装 spec 反推「仓库的网页地址」：目录没写 page/url 的条目（尤其 github: 来源）靠它给出源码入口。
// 四种写法统一成 https 仓库页：`github:o/r#子包` / `git+https://h/o/r.git` / `git@h:o/r` / `ssh://git@h:o/r`；
// 裸包名、tarball、本地路径、认不出的形态返回 ''（界面不渲染入口）。大小写保留：只有 GitHub 忽略大小写。
// ⚠️ `..` 必须在 new URL() 之前拦：解析器会把 `/o/../etc` 归一成 `/etc`，事后再查路径段永远查不到。
function sourceWebUrl(spec) {
  const s = String(spec == null ? '' : spec).trim()
  if (!s) return ''
  const gh = /^github:([^#\s]+)/i.exec(s)
  if (gh) {
    const path = gh[1].replace(/\/+$/, '').replace(/\.git$/i, '')
    return repoPathOk(path) ? `https://github.com/${path}` : ''
  }
  let remote = s.replace(/^git\+/i, '')
  const scp = /^git@([^/\s:]+):(.+)$/.exec(remote)
  if (scp) remote = `https://${scp[1]}/${scp[2].replace(/^\/+/, '')}`
  // ssh URL 里的 scp 冒号（`ssh://git@h:o/r`）会被 URL 当成非法端口，先转掉；真端口交给 parser
  const sshScp = /^ssh:\/\/(?:[^@/\s]+@)?([^/\s:]+):(?!\d+(?:\/|$))(.+)$/i.exec(remote)
  if (sshScp) remote = `https://${sshScp[1]}/${sshScp[2].replace(/^\/+/, '')}`
  const target = remote.split('#')[0] // `#` 后是分支/子包，不进网页路径
  if (!target || /(?:^|\/)\.\.(?:\/|$)/.test(target)) return ''
  let url = null
  try { url = new URL(target) } catch { return '' }
  const path = url.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '')
  if (!repoPathOk(path)) return ''
  if (/^https?:$/i.test(url.protocol)) return `${url.protocol}//${url.host}/${path}`
  return /^(?:ssh|git):$/i.test(url.protocol) ? `https://${url.hostname}/${path}` : ''
}

// 仓库路径至少两段（owner/repo），每段只允许常见字符且不许 `.`/`..`；首段允许 `~`（sourcehut 的用户命名空间）
function repoPathOk(path) {
  const segs = path.split('/')
  return segs.length >= 2 && segs.every((seg, i) => {
    const s = i === 0 ? seg.replace(/^~/, '') : seg
    return /^[A-Za-z0-9_.-]+$/.test(s) && s !== '.' && s !== '..'
  })
}

module.exports = { safeWebUrl, sourceWebUrl }
