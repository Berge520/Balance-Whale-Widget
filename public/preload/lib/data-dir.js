// public/preload/lib/data-dir.js
/*
 * 用户素材目录的统一推导（CommonJS）。
 *
 * 为什么单独抽出来：skins / sounds / bubbles / media / bg-video 五处原本各抄一份
 * 「取 userData → 拼子目录 → 取不到就落临时目录」。这条口径决定的是**用户素材落在哪**
 * （丢一次就是几十 MB 自定义形象 / 音效 / 背景），五份副本迟早漂移，所以收成一处。
 *
 * 落盘位置的取舍（uTools 8.0 起官方建议「应用数据」放 getPluginLocalDataPath()）：
 * 素材自 v1.13 及更早一直落在 userData/<子目录>，**刻意不迁**——搬家等于让老用户
 * 已下载的几十 MB 素材凭空消失，换不来任何可见收益。真正该修的是兜底：
 * 取不到 userData 时先退官方插件本地数据目录（长期保留、不参与同步），最后才退
 * 系统临时目录，且必须 logErr 留痕（旧写法静默落 tmp，重启即丢，用户毫无感知）。
 */
const path = require('path')
const os = require('os')
const { logErr } = require('./log')

// 插件数据根目录。调用方只拼子目录名，不关心最终落在哪。
function baseDir() {
  try {
    const p = utools.getPath('userData')
    if (p) return p
  } catch (err) {}
  // 8.0 新增；7.x 上该函数不存在（TypeError）或返回空串，都顺延到最后的兜底
  try {
    const p = utools.getPluginLocalDataPath()
    if (p) return p
  } catch (err) {}
  const tmp = os.tmpdir()
  logErr('[whale][data-dir] 取不到插件数据目录，素材改落系统临时目录（重启后可能丢失）', tmp)
  return tmp
}

// 素材子目录绝对路径（目录不存在时由调用方在写入前自行 mkdir）
function dataDir(sub) {
  return path.join(baseDir(), sub)
}

module.exports = { baseDir, dataDir }
