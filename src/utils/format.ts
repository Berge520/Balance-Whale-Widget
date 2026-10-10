// 设置页跨卡片共用的纯函数（无响应式依赖，直接吃参数）。
// 原先这些同名同体的实现散在 App.vue / AssetsView.vue / CodexView.vue / useDsh.ts / UsageView.vue，
// 一处改了另一处不改就会漂移（历史上柱状图的 min 就分叉成 2/2/3），统一收在这里。

// 体积展示：元信息里的 size 由宿主读取时派生，文件缺失为 0。<=0 一律 '0 KB'，
// 大于 0 但不足 1KB 也至少显示 '1 KB'（不让「有文件却显示 0 KB」出现）。
export function fmtBytes(n: number): string {
  const v = Number(n) || 0
  if (v <= 0) return '0 KB'
  return v < 1024 * 1024 ? Math.max(1, Math.round(v / 1024)) + ' KB' : (v / 1024 / 1024).toFixed(1) + ' MB'
}

// 素材体积文案：拿不到 size（文件缺失 / 元信息没带）时说「体积未知」，而不是显示 0 KB 误导成空文件。
export function assetSize(m: { size?: number } | null | undefined): string {
  const n = Number(m && m.size) || 0
  return n > 0 ? fmtBytes(n) : '体积未知'
}

// 随包内置的共享角色缩略图路径（几 KB 的 webp）。
export function sharedSkinThumb(id: string): string {
  return './resources/thumbs/' + encodeURIComponent(id) + '.webp'
}

// 把相对路径的资源读成 data URL（webp）交给宿主落盘。
// 为什么必须由渲染进程给：宿主（preload）定位不到插件目录 —— 它只有 utools.getPath('userData')，
// 而 './resources/...' 这类相对路径只有渲染进程能解析。读失败一律回 ''：
// 宁可这张暂时没缩略图（画廊可回落读原图），也不能因为读图失败把整张素材的下载带崩。
export async function fetchAsDataUrl(url: string): Promise<string> {
  try {
    const res = await fetch(url)
    if (!res.ok) return ''
    const buf = await res.arrayBuffer()
    if (!buf.byteLength) return ''
    let bin = ''
    const bytes = new Uint8Array(buf)
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
    return 'data:image/webp;base64,' + btoa(bin)
  } catch (err) {
    return ''
  }
}

// 柱高百分比：最大值为满格（100%），最小留 min% 让「有量但极少」也看得见。
// 最大值就地算：各卡传进来的 days 已按档位切好（最多 31 个元素），不值得为它单开 computed，
// 且共用组件（UsageChart.vue）拿不到各卡的 computed，只能靠这个函数（见 hasBars）。
// min 之所以参数化：会话统计卡/dsh 用量卡是 token 口径（2%），余额用量卡是金额口径（3%，金额更小更易被压没）。
export function barHeightOf(
  days: Array<{ tokens?: number }>,
  tokens?: number,
  min = 2,
): string {
  let max = 0
  for (const d of days) max = Math.max(max, Number(d.tokens) || 0)
  if (!max) return '0%'
  return Math.max(min, Math.round(((Number(tokens) || 0) / max) * 100)) + '%'
}
