/*
 * 对外 API（CommonJS）：注入到主窗 window.services，供设置页调用。
 */
const fs = require('fs')
const path = require('path')
const { PLUGIN_VERSION, K, MODEL_TEMPLATES, MODEL_MAX, DEFAULT_MAIN_MODEL } = require('./constants')
const { log, logErr, LOG_FILE } = require('./log')
const {
  clampNum, readConfig, patchConfig, readSecrets, writeSecrets, readLedger, historyKeepDays,
  resetAnchorCache, mergeLedgerHistory, clearTimer, calibrateTodayUsage,
  defaultAnchor, writeAnchor, normModelId, normModel, sanitizeKey, dropModelState,
} = require('./store')
const {
  fetchBalanceWith, fetchPlatformUsage, checkUpdate, resetBalanceCache,
  fetchModelBalance, refreshModels: refreshModelsApi, getModelsPayload,
} = require('./api')
const {
  ensureWidget, destroyWidget, winAlive, getWidgetError, getWindow,
  applyScaleToWindow, applyOnTop, pushConfig, queueLiveScale, repositionFromAnchor,
  taskbarState, syncTaskbarWatch, sendToWidget,
} = require('./widget')
const dsh = require('./dsh')
const hosts = require('./hosts')
const { sendMail, mailSubject, notifySystem, sendMailAsync } = require('./notify')
const backup = require('./backup')
const assets = require('./assets')
const sounds = require('./sounds')
const skins = require('./skins')
const bubbles = require('./bubbles')
const codex = require('./codex')
const dshUsage = require('./dsh-usage')
const diagnostics = require('./diagnostics')
const dshDump = require('./dsh-dump')
const dshBackup = require('./dsh-backup')
const dshExport = require('./dsh-export')
const { parsePatch, applyToggle, applyBatchDisable } = require('./dsh-patch')
const dshIsolate = require('./dsh-isolate')
const dshMarket = require('./dsh-market')
const dshHostCompat = require('./dsh-host-compat')
const { readTextSafe } = require('./util')

// 镜像测速超时：只打元数据（几百字节），8s 足够；等不到就说明该源当下不可用
const PING_TIMEOUT_MS = 8000

// ── dsh 插件开关（计划书 §6.2 E2）──
// 目标文件固定是**用户层** profile patch（$DSH_HOME/profiles/<p>/cordis.patch.yml）。
//
// ⚠️ 为什么不解析 dump 树来列条目：dump 树是「组装后的结果」，里面既有官方 bundle 也有
// 各层 patch，而这里能改的**只有用户层这一个文件**。拿一份「能看不能改」的清单去当操作对象，
// 会让用户对着一个开关点半天没反应（V1：带 client 入口的插件禁不掉）。
// 所以清单 = 这个文件里已经写了什么，界面再明确说清「写入位置」。
function dshPatchPath(profile) {
  const home = dshBackup.dshHome()
  if (!home) return ''
  return path.join(home, 'profiles', String(profile || 'web'), 'cordis.patch.yml')
}

// 列出用户层 patch 里的条目（含「文件不存在」这一正常空态）
function listDshPatchItems(opts) {
  const o = opts && typeof opts === 'object' ? opts : {}
  const profile = String(o.profile || 'web')
  const file = dshPatchPath(profile)
  if (!file) return { ok: false, error: '找不到 dsh 配置目录（$DSH_HOME 与 ~/.dsh 都不存在）', profile: profile }
  const r = readTextSafe(file, '')
  // ENOENT 是预期分支（这份 profile 还没写过 patch），不是错误 —— 界面给「还没有条目」的空态
  if (!r.ok && r.reason) {
    logErr('[whale][dsh-patch] 读 patch 文件失败', r.reason)
    return { ok: false, error: '读不到 patch 文件：' + r.reason, file: file, profile: profile }
  }
  const parsed = parsePatch(r.ok ? r.text : '')
  return {
    ok: true,
    file: file,
    profile: profile,
    exists: r.ok,
    items: parsed.items.map((it) => ({
      id: it.id,
      disabled: it.disabled,
      line: it.lineIndex + 1,
      hasConfig: it.hasConfig,
    })),
  }
}

// 切换单个条目的 disabled（E2 的核心动作）。
// opts = { profile?, id, disabled?, dryRun? }
//
// ⚠️ 写前必须先建快照 —— 本函数**不做**这件事，由调用方（设置页 → 宿主）编排：
// 备份是 E1 的职责，本模块与 dsh-patch.js 都只碰文件内容，不碰快照目录。
// 这里只保证**写入可核验**（V2：dsh 对写坏的 patch 不报错，只能自己回读确认）。
function toggleDshPatchItem(opts) {
  const o = opts && typeof opts === 'object' ? opts : {}
  const profile = String(o.profile || 'web')
  const id = String(o.id || '').trim()
  const disabled = o.disabled !== false
  if (!id) return { ok: false, error: '未指定插件 id' }
  const file = dshPatchPath(profile)
  if (!file) return { ok: false, error: '找不到 dsh 配置目录（$DSH_HOME 与 ~/.dsh 都不存在）' }

  const cur = readTextSafe(file, '')
  const text = cur.ok ? cur.text : ''
  const res = applyToggle(text, id, disabled)
  if (!res.ok) return { ok: false, error: res.error || '无法生成新的 patch 内容' }

  // dryRun：只算不写，界面可以先让用户看清「会写出什么」
  if (o.dryRun === true) {
    return { ok: true, dryRun: true, action: res.action, changed: res.changed, file: file, profile: profile, id: id, disabled: disabled }
  }
  if (!res.changed) {
    return { ok: true, action: res.action, changed: false, file: file, profile: profile, id: id, disabled: disabled }
  }

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, res.text, 'utf8')
  } catch (err) {
    logErr('[whale][dsh-patch] 写 patch 文件失败', id + ': ' + ((err && err.message) || err))
    return { ok: false, error: '写入失败：' + ((err && err.message) || err) }
  }

  // V2 的教训落地：写完**回读磁盘**确认那条 id 真的以期望形态出现了。
  // 不信任「writeFileSync 没抛错 = 写对了」—— 这里挡的是「内容确实写进文件、但形态不是 patch 能识别的」
  const back = readTextSafe(file, '')
  const check = back.ok ? parsePatch(back.text).items.find((it) => it.id === id) : null
  if (!check || check.disabled !== disabled) {
    logErr('[whale][dsh-patch] 写入后回读校验不符', id + ' 期望 disabled=' + disabled)
    return { ok: false, error: '写入后校验未通过，配置可能未生效（已保留快照，可回滚）', file: file }
  }

  log('[whale][dsh-patch] 已切换条目', { id: id, disabled: disabled, action: res.action })
  return {
    ok: true,
    action: res.action,
    changed: true,
    file: file,
    profile: profile,
    id: id,
    disabled: disabled,
    // V4：patchReload 是单向的 —— 加 disabled 即时生效，**取消禁用不恢复**。
    // 所以界面必须提示「启用后需要重启 dsh」，不能谎称已即时生效
    needsRestart: !disabled,
  }
}

// ── dsh 一键隔离（计划书 §6.2 E3）──
// 与 E2 的关系：E2 一次改一条，E3 一次改一批 —— 但**仍然只动用户勾选的条目**。
// 计划书 §5.2 明确否掉了原方案的「安全模式」（给所有用户插件条目追加 disabled: true）：
// 本机 profiles/web 有 13 个 bundle + 9 个依赖，全禁等于把用户整个 profile 干掉。
//
// 隔离 = 「只留我想要的那几个，其余全禁」。所以候选必须来自**真实存在的条目**，
// 否则用户勾了一个拼错的 id，V2 的静默失效会让界面报「已隔离」而实际什么都没发生。
// 候选清单 = 用户层 patch 里的条目 ∪ dump 组装树里的插件条目：
// 前者是「已经被改过的」，后者是「能被改的」。
function listDshIsolateCandidates(opts) {
  const o = opts && typeof opts === 'object' ? opts : {}
  const profile = String(o.profile || 'web')
  const file = dshPatchPath(profile)
  if (!file) return { ok: false, error: '找不到 dsh 配置目录（$DSH_HOME 与 ~/.dsh 都不存在）', profile: profile }

  const r = readTextSafe(file, '')
  if (!r.ok && r.reason) {
    logErr('[whale][dsh-isolate] 读 patch 文件失败', r.reason)
    return { ok: false, error: '读不到 patch 文件：' + r.reason, file: file, profile: profile }
  }
  const parsed = parsePatch(r.ok ? r.text : '')
  const patchItems = parsed.items.map((it) => ({
    id: it.id,
    disabled: it.disabled,
    line: it.lineIndex + 1,
    hasConfig: it.hasConfig,
  }))

  // dump 树里的条目 id；与 patch 里已有的取并集，作为候选项。
  // ⚠️ 这里**只做并集，不做「可改性」判断**：判据（有没有 client 入口）要看包元数据，
  // 属另一个模块的事，猜错的代价（列出改不动的条目）由界面文案承担（V1 明示「可能无效」）。
  //
  // 回传 id 的同时带上**归属 bundle / 当前 disabled / 有无 config**：
  //   · bundle  —— 供 dsh-isolate 分档（官方框架 vs 第三方插件），实测 204 个条目里 199 个是官方节点
  //   · disabled —— 早先候选层对 plugin 条目硬编码 `disabled: false`，于是「已禁用」标记只对
  //     patch 里的条目准；dump 的条目本来就带这个字段，白丢可惜
  // ⚠️ 同一 id 可能在多个分节重复出现（分层是正常的），按「最后见到的为准」——
  // 与 parseDump 的 entries 覆盖口径一致（后写的分节更靠近生效层）
  function fromDump(payload) {
    if (!payload || !payload.ok) return { ids: [], bundleOf: {}, disabledOf: {}, configOf: {} }
    const entries = Array.isArray(payload.entries) ? payload.entries : []
    const ids = []
    const bundleOf = {}
    const disabledOf = {}
    const configOf = {}
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i] && typeof entries[i] === 'object' ? entries[i] : {}
      const id = String(e.id || '').trim()
      if (!id) continue
      ids.push(id)
      if (e.bundle) bundleOf[id] = String(e.bundle)
      disabledOf[id] = !!e.disabled
      configOf[id] = !!e.hasConfig
    }
    // 已存在 patch 里的条目由 patchItems 覆盖，这里只补「dump 有、patch 没有」的
    const out = []
    const known = {}
    for (let i = 0; i < patchItems.length; i++) known[patchItems[i].id] = true
    for (let i = 0; i < ids.length; i++) {
      if (!known[ids[i]]) {
        known[ids[i]] = true
        out.push(ids[i])
      }
    }
    return { ids: out, bundleOf: bundleOf, disabledOf: disabledOf, configOf: configOf }
  }

  return new Promise((resolve) => {
    let settled = false
    const done = (payload) => {
      if (settled) return
      settled = true
      clearTimeout(guard)
      resolve(payload)
    }
    // 与 dumpDshConfig 同一道兜底闸门（内部两次 spawn 最坏 8s + 8s，这里再多给 4s）
    const guard = setTimeout(() => {
      logErr('[whale][dsh-isolate] 候选清单超时兜底（子进程回调未回来）', '')
      done({
        ok: true,
        file: file,
        profile: profile,
        exists: r.ok,
        treeError: '读取组装树超时，候选只包含 patch 文件里已有的条目',
        items: dshIsolate.candidatesOf({ patchItems: patchItems, pluginIds: [] }),
      })
    }, 20000)
    dshDump.collectDshDump({ profile: profile }, (err, payload) => {
      // dump 失败**不算整体失败**：patch 里的条目照样能隔离，只是候选少一截。
      // 这与 D26 的降级思路一致 —— 探测不出来就如实说，不把整件事判死
      const treeError = err ? ((err && err.message) || String(err)) : ''
      if (treeError) logErr('[whale][dsh-isolate] 组装树读取失败（候选降级）', treeError)
      const tree = treeError ? { ids: [], bundleOf: {}, disabledOf: {}, configOf: {} } : fromDump(payload)
      const items = dshIsolate.candidatesOf({
        patchItems: patchItems,
        pluginIds: tree.ids,
        bundleOf: tree.bundleOf,
        disabledOf: tree.disabledOf,
        configOf: tree.configOf,
      })
      done({
        ok: true,
        file: file,
        profile: profile,
        exists: r.ok,
        treeError: treeError,
        items: items,
      })
    })
  })
}

// 批量禁用（E3 的执行动作）。
// opts = { profile?, ids: string[], dryRun? }
//
// 与 E2 一样：**只算不写**（dryRun）时先把「会动哪几行」交出去，界面据此让用户过目再确认。
// 返回 plans 里的 line 是**改动前**的行号（1 基），append 的 line 为 0（表示是新加的行）。
function isolateDshPlugins(opts) {
  const o = opts && typeof opts === 'object' ? opts : {}
  const profile = String(o.profile || 'web')
  const ids = Array.isArray(o.ids) ? o.ids.map((v) => String(v == null ? '' : v).trim()).filter(Boolean) : []
  if (!ids.length) return { ok: false, error: '没有勾选任何插件' }
  if (ids.length > dshIsolate.MAX_BATCH) {
    return { ok: false, error: '一次最多隔离 ' + dshIsolate.MAX_BATCH + ' 条（当前 ' + ids.length + ' 条）' }
  }
  const file = dshPatchPath(profile)
  if (!file) return { ok: false, error: '找不到 dsh 配置目录（$DSH_HOME 与 ~/.dsh 都不存在）' }

  const cur = readTextSafe(file, '')
  const res = applyBatchDisable(cur.ok ? cur.text : '', ids)
  if (!res.ok) return { ok: false, error: res.error || '无法生成新的 patch 内容' }

  // 明确报出「一条都没动」：全选成已禁用时 plans 全是 noop，界面要说清而不是假装写成功了
  const changed = res.plans.filter((p) => p.action !== 'noop')
  if (o.dryRun === true) {
    return {
      ok: true,
      dryRun: true,
      changed: res.changed,
      file: file,
      profile: profile,
      plans: res.plans,
      changedCount: changed.length,
    }
  }
  if (!res.changed) {
    return { ok: true, changed: false, file: file, profile: profile, plans: res.plans, changedCount: 0 }
  }

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, res.text, 'utf8')
  } catch (err) {
    logErr('[whale][dsh-isolate] 写 patch 文件失败', (err && err.message) || '')
    return { ok: false, error: '写入失败：' + ((err && err.message) || err) }
  }

  // V2 的教训：写完回读磁盘，逐条确认真的成了 disabled —— 批量写更不能只信「没抛错」
  const back = readTextSafe(file, '')
  const after = back.ok ? parsePatch(back.text).items : []
  const mismatch = []
  for (let i = 0; i < ids.length; i++) {
    const hit = after.find((it) => it.id === ids[i])
    if (!hit || !hit.disabled) mismatch.push(ids[i])
  }
  if (mismatch.length) {
    logErr('[whale][dsh-isolate] 写入后回读校验不符', mismatch.join(', '))
    return {
      ok: false,
      error: '写入后校验未通过（' + mismatch.length + ' 条未生效），已保留快照可回滚',
      file: file,
      mismatch: mismatch,
    }
  }

  log('[whale][dsh-isolate] 已批量禁用', { count: ids.length, changed: changed.length })
  return {
    ok: true,
    changed: true,
    file: file,
    profile: profile,
    plans: res.plans,
    changedCount: changed.length,
    // V2：批量禁用**即时生效**（加 disabled 是单向热重载中会生效的那一半）。
    // 所以隔离完之后 dsh 会立刻少掉这些插件，界面必须提示「隔离后 dsh 可能重启/重连」
    needsRestart: false,
  }
}

// 快照列表（E1 的 dsh-backup 透传到设置页）
function listDshBackups() {
  try {
    return {
      ok: true,
      root: dshBackup.backupRoot(),
      // max = **当前生效**的保留份数（读用户配置，E4 起可调），不是常量上限
      max: dshBackup.retentionKeep(),
      keepMin: dshBackup.KEEP_MIN,
      keepMax: dshBackup.KEEP_MAX,
      snapshots: dshBackup.listSnapshots(),
    }
  } catch (err) {
    logErr('[whale][dsh-backup] 列快照失败', (err && err.message) || '')
    return { ok: false, error: '读取快照列表失败：' + ((err && err.message) || err), snapshots: [] }
  }
}

// ── dsh 插件市场（lib/dsh-market.js 的宿主入口）──
//
// 本卡是 dev tab 里**唯一会联网**的卡，所以每一步都要能被用户叫停与回看：
//   · 目录只读、可缓存（内存 60s + dbStorage 离线兜底），抓失败也把上次的目录交出去
//   · 安装/卸载是「三段式」：dryRun 预览 → 用户确认 → 写前建快照 → 跑 pnpm → 回读核验
//
// ⚠️ 不自动重启 dsh：装完插件要 dsh 重新加载才生效，但重启会掐掉用户正在跑的会话。
//    界面提示 + 「重启 dsh」按钮（复用 dshRestart）交给用户自己决定时机。

// 上次成功抓到的目录落库，供官方与镜像都挂时兜底（实测官方站是个人站，可用性有限）
function readMarketCache() {
  try {
    const c = utools.dbStorage.getItem(K.dshMarket)
    if (c && typeof c === 'object' && Array.isArray(c.plugins) && c.plugins.length) return c
  } catch (err) {}
  return null
}
function writeMarketCache(payload) {
  try {
    // plugins 只留界面要用的字段，原始 screenshots 之类不进库 —— dbStorage 是 uluru 文档库，
    // 塞几兆 JSON 会让每次 getItem 都变慢
    utools.dbStorage.setItem(K.dshMarket, {
      at: Date.now(),
      updated: payload.updated || '',
      source: payload.source || '',
      categories: payload.categories || {},
      plugins: payload.plugins,
    })
  } catch (err) { logErr('[whale][dsh-market] 写目录缓存失败', (err && err.message) || '') }
}

// 抓目录：成功就更新离线兜底；失败时**降级返回上次的目录**（from:'cache'）而不是 ok:false
function marketCatalog(opts) {
  const o = opts && typeof opts === 'object' ? opts : {}
  const cfg = readConfig()
  const customUrl = String(o.url !== undefined ? o.url : cfg.dshMarketUrl || '').trim()
  const mirror = o.mirror !== undefined ? o.mirror !== false : cfg.dshMarketMirror !== false
  // 竞速参数：镜像用哪个 registry、官方源是否参赛（见 dsh-market.js 的 buildSources）
  const registry = String(o.registry !== undefined ? o.registry : cfg.dshMarketRegistry || '').trim()
  const official = o.official !== undefined ? o.official === true : cfg.dshMarketOfficial === true
  return Promise.resolve()
    .then(() => dshMarket.loadCatalog({ force: o.force === true, customUrl: customUrl, mirror: mirror, registry: registry, official: official }))
    .then((res) => {
      if (res && res.ok) {
        writeMarketCache(res)
        return res
      }
      const cached = readMarketCache()
      if (!cached) return res
      logErr('[whale][dsh-market] 目录抓取失败，改用离线副本', (res && res.error) || '')
      return {
        ok: true,
        from: 'cache',
        cached: true,
        at: cached.at,
        updated: cached.updated,
        categories: cached.categories,
        plugins: cached.plugins,
        count: cached.plugins.length,
        // 原始失败原因照样交出去：界面要显示「这是上次的目录（抓取失败：…）」
        stale: true,
        staleReason: (res && res.error) || '未知原因',
      }
    })
    .catch((err) => {
      logErr('[whale][dsh-market] 目录加载异常', (err && err.message) || '')
      return { ok: false, error: '目录加载异常：' + ((err && err.message) || err), plugins: [], categories: {} }
    })
}

// 给各镜像源测延迟，让界面能「自动选最快的」。
//
// 只打 registry 的**元数据**（几百字节），不下载 tarball —— 测速不该把 1MB 拉两遍。
// 各源并发，互不影响；单个源失败记 ok:false 而不是把整次测速搞崩。
// 返回 { ok, list: [{ id, url, label, ms, ok, error? }] }，list 按延迟升序（失败的排最后）。
function marketPing(opts) {
  const o = opts && typeof opts === 'object' ? opts : {}
  const fetchImpl = typeof o.fetchImpl === 'function' ? o.fetchImpl : fetch
  const list = Array.isArray(o.registries) && o.registries.length ? o.registries : dshMarket.MIRROR_REGISTRIES
  return Promise.all(list.map((r) => {
    const t0 = Date.now()
    return Promise.resolve()
      .then(() => fetchImpl(r.url.replace(/\/+$/, '') + '/' + dshMarket.MIRROR_PKG + '/latest', { signal: AbortSignal.timeout(PING_TIMEOUT_MS) }))
      .then((res) => {
        if (!res.ok) throw new Error('HTTP ' + res.status)
        return res.json()
      })
      .then((meta) => {
        const tb = meta && meta.dist && meta.dist.tarball
        if (!tb) throw new Error('元数据里没有 dist.tarball')
        return { id: r.id, url: r.url, label: r.label, ms: Date.now() - t0, ok: true, version: String(meta.version || '') }
      })
      .catch((err) => ({
        id: r.id, url: r.url, label: r.label, ms: Date.now() - t0, ok: false,
        error: (err && err.message) || '未知错误',
      }))
  })).then((arr) => {
    const sorted = arr.slice().sort((a, b) => (a.ok === b.ok ? a.ms - b.ms : (a.ok ? -1 : 1)))
    log('[whale][dsh-market] 镜像测速完成', sorted.map((x) => x.id + (x.ok ? '=' + x.ms + 'ms' : '=fail')).join(' '))
    return { ok: true, list: sorted }
  })
}

// 已装状态：把 patch 里的条目映射到目录条目的 npm 包名上（完整名优先、短名兜底）
function marketStatus(opts) {
  const o = opts && typeof opts === 'object' ? opts : {}
  const profile = String(o.profile || 'web')
  const patch = listDshPatchItems({ profile: profile })
  const items = patch && patch.ok ? patch.items : []
  const map = dshMarket.installedMap(dsh.installedDeps(profile), items)
  return {
    ok: true,
    profile: profile,
    file: dsh.profilePkgFile(profile),
    patchFile: patch && patch.file ? patch.file : '',
    // 键是**用户在 patch / package.json 里写的那个名字**，界面靠 matchInstalled 去对目录条目
    installed: map,
    count: Object.keys(map).length,
  }
}

// 检查已装插件有没有新版。opts = { profile?, catalog? }
//
// ⚠️ 为什么不放在 marketStatus 里一起算：marketStatus 是**纯本地**的（只读 package.json +
//    patch），展开卡片就会跑；而「有没有新版」需要**目录数据**，目录属于联网侧。
//    两者生命周期不同（目录可以不加载，已装状态照样读），所以这里单独一个入口 ——
//    界面在「已加载目录」之后才调它，没加载目录就不调，保持「默认零网络请求」。
//
// 口径（2026-09-24 调整）：拿目录条目的 version 去比 node_modules 里的**实装版本**
// （见 dsh-market.updateState）。拿不到实装版本时退回比 package.json 的声明范围。
//   · 有更新    —— 实装版本 < 目录版本（退回时：目录版本超出声明范围）
//   · 已是最新  —— 实装版本 >= 目录版本（退回时：目录版本落在声明范围内）
//   · 无法比对  —— 目录没给 version（github / tarball 来源），或已装侧两边都拿不到
//
// ⚠️ 实装版本表为什么在这里读一次而不是每条读一次：installedVersions 内部按 dependencies
//    的键一次性读全（本机通常个位数到几十个），逐条调会反复读同一批文件。
function marketCheckUpdates(opts) {
  const o = opts && typeof opts === 'object' ? opts : {}
  const profile = String(o.profile || 'web')
  const catalog = o.catalog && typeof o.catalog === 'object' ? o.catalog : {}
  const plugins = Array.isArray(catalog.plugins) ? catalog.plugins : []
  const deps = dsh.installedDeps(profile)
  const versions = dsh.installedVersions(profile)
  const out = []
  let updates = 0
  let unknown = 0
  for (let i = 0; i < plugins.length; i++) {
    const p = plugins[i] && typeof plugins[i] === 'object' ? plugins[i] : {}
    // 先按 npm 名对，再按 install spec 反查 —— 与界面 dshMarketHitAt 同一套口径，
    // 否则会出现「卡片说已装、这里说找不到」的自相矛盾
    const hit = (p.npm ? dshMarket.matchDepByNpm(deps, p.npm) : null)
      || (p.spec ? dshMarket.matchInstalledBySpec(deps, p.spec) : null)
    if (!hit) continue
    // 实装版本：先按 npm 名查表（表键与 deps 键同源，命中判定的 hit.key 直接可用），
    // 再用 spec 兜一层 —— github / tarball 来源的目录名与 npm 字段对不上时靠这个
    let realized = versions[hit.key] || ''
    if (!realized && p.spec) realized = dshMarket.realizedVersionBySpec(versions, p.spec)
    const st = dshMarket.updateState(hit.depVersion, p.version, realized)
    if (st.state === 'update') updates++
    else if (st.state === 'unknown') unknown++
    // 只回「已装」的那些，没装的条目界面自己用 dshMarketHitAt 判，不必重复传
    out.push({
      spec: String(p.spec || ''),
      npm: String(p.npm || ''),
      name: String(p.name || ''),
      // installed = 实装版本（可能为空，界面据此决定显不显示）；range = 声明范围（退回展示用）
      installed: st.installed,
      range: st.range,
      latest: st.latest,
      state: st.state,
      basis: st.basis,
    })
  }
  return { ok: true, profile: profile, entries: out, updates: updates, unknown: unknown, checked: out.length }
}

// ⚠️ 回源 registry 查「官方最新版」——**会联网**，且只该在用户明确点击时调。
//
// 为什么要单独一个 API 而不是并进 marketCheckUpdates：目录是**每日快照**，里面那份 version
// 只是快照值，不能代表「当前最新」。实测 2026-09-25：目录停在 2026.924.4355（9/24），
// dshmarket 目录里写 1.61.0，而 registry 上已经是 1.65.1。所以「目录说已最新」这件事本身
// 可能已经过时 —— 想确证就得问 registry。
//
// ⚠️ 但 marketCheckUpdates 是**同步 + 零网络**的（目录由界面传回，宿主不自己联网），
//    把它改成联网会一举推翻「刷新目录不打上百个请求」的设计。所以另开一条**纯手动**的路。
//
// opts = { items: [{ pkg, key }], registry? } —— key 是关联键（界面用目录条目的 spec）。
// 返回 { ok, results: { <key>: { pkg, version, error, cached } }, registry }
function marketRegistryLatest(opts) {
  const o = opts && typeof opts === 'object' ? opts : {}
  const items = Array.isArray(o.items) ? o.items : []
  const registry = String(o.registry || cfgRegistry() || dshMarket.MIRROR_REGISTRY)
  return dshMarket.registryLatest(items, { registry: registry, concurrency: o.concurrency, fetchImpl: o.fetchImpl })
    .then((r) => ({ ok: true, registry: registry, results: r.results }))
}

// ⚠️ pnpm 报「成功」不等于「真的升级了」—— 判据必须是**回读到的实装版本变了**。
//
// 2026-09-24 实测的真实假成功：profile 的 `pnpm-workspace.yaml` 里有 `minimumReleaseAgeExclude`
// 供应链白名单，`dshmarket` 那条被写死成 `dshmarket@1.45.1 || 1.48.0`。于是 pnpm 在解析时
// **把目录里的 1.57.0 直接排除掉**，回退到「当前锁定的 1.48.0」这个唯一合法解 —— 它认为
// 已经满足、无需改动，报 `Done` + 退出码 0（日志里那句 `✓ Lockfile passes supply-chain policies`
// 就是它），磁盘上却一个字没变。界面于是显示「已更新 v1.48.0 → v1.48.0」这种荒谬结论。
//
// 这类拦截**只体现在输出里，不体现在退出码里**，所以只能靠回读版本发现。返回被挡住的详情
// 供调用方拼文案；`blocked:false` 表示这次变化不是策略拦截造成的（真的升/降级，或读不到版本）。
//
// ⚠️ 判据只能是「回读版本没变」这一件事 —— 不能拿输出里的 `supply-chain` 字样当证据。
//    `✓ Lockfile passes supply-chain policies` 是 pnpm **每次都会打的常规信息行**（2026-09-24 实测：
//    连本来就在白名单里的包也照打），把它当拦截信号会给出「让用户去改白名单」这种**改不动也
//    没用**的错误指引（用户报的 `@linxin666/dsh-web-all` 白名单里明明有，但只放行到 0.3.23）。
//    所以 `sawPolicyHint` 降级为纯文案微调，true/false 都不影响 blocked 的判定。
function blockedByPolicy(profile, from, to, out) {
  if (!to || to === from) {
    // 措辞里出现 minimumReleaseAge / supply-chain 时说明 pnpm 确实提到了这道策略，文案可以更笃定
    const s = String(out || '')
    const home = dshBackup.dshHome()
    const policyFile = home ? path.join(home, 'profiles', profile, 'pnpm-workspace.yaml') : '<$DSH_HOME>/profiles/' + profile + '/pnpm-workspace.yaml'
    // 白名单键的**直接证据**：pnpm 真的点名了 minimumReleaseAgeExclude，或打了 release-age 专用的错误码。
    // 比 sawPolicyHint（连常规信息行都算）严得多：那行 `✓ Lockfile passes supply-chain policies` 里
    // 有 supply-chain，会把「太新」误判成「白名单没放行」，给出让用户白改一次 yaml 的错误指引。
    const keyHint = /minimumReleaseAgeExclude|ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION|ERR_PNPM_NO_MATURE_MATCHING_VERSION/i.test(s)
    // 「太新」的直接证据：pnpm 明说了它认为版本太新、要等多少天（原生 CLI 与 pnpm 10/11 两种拼写都认）。
    const ageHint = /minimum[\s-]?release[\s-]?age(?!Exclude)|\btoo new\b|newer than .{0,20}(?:minutes|hours|days)/i.test(s)
    // ⚠️ 两个判定必须**先看太新**：太新时 pnpm 会顺带把白名单键名也打出来（「如要放行可改 X」），
    //    若先判 keyHint 就会永远归到「白名单没放行」，派发到错误的引导。
    const reason = ageHint ? 'release-age' : (keyHint ? 'allowlist' : 'unknown')
    return {
      blocked: true,
      staleReason: reason,
      policyFile: policyFile,
      policyKey: reason === 'release-age' ? 'minimumReleaseAge' : 'minimumReleaseAgeExclude',
      sawPolicyHint: /minimumReleaseAgeExclude|supply-chain|minimumReleaseAge/i.test(s),
    }
  }
  return { blocked: false }
}

// 判断「回读到的实装版本比更新前**低**」—— 即静默降级。
//
// ⚠️ 为什么要单独判方向：`blockedByPolicy` 只能发现「版本没变」，但还有另一种更坏的失败 ——
//    pnpm 报成功、版本确实**变了**，却变**低**了。触发条件与 dsh-market 官方文档警告的一致
//    （UPDATE-API-V1.md 的 DOWNGRADE_DETECTED）：镜像滞后 / registry 把 `@latest` 解析成了
//    旧版本 / 目录给的 spec 指向了回退的 tag。此时若按「版本变了」判成功，用户会看到
//    「已更新 v1.48.0 → v1.40.0」这种荒谬结论，且旧版已经在磁盘上了。
//    旧版比新版更容易有安全问题，所以必须当失败处理、引导回滚，而不是提示成功。
//
// 只在两边都能解析成版本号时才判 —— 拿不到实装版本时无从比较，不能猜（保守优先，同 updateState 口径）。
function downgradedBy(from, to) {
  const a = dshMarket.parseVer(from)
  const b = dshMarket.parseVer(to)
  if (!a || !b) return { downgraded: false }
  // ⚠️ cmpVer(a, b) 的返回是「a 相对 b」：a>b 返 1。这里要判的是「to 比 from 低」，
  //    故把 from 放第一个 —— 写成 cmpVer(to, from) 会把方向整个反过来，
  //    结果是**真升级**被判成降级、真降级反而放行（单测当场抓到这个反向错误）。
  if (dshMarket.cmpVer(from, to) <= 0) return { downgraded: false }
  return { downgraded: true }
}

// 判断「装出来的版本与目录要的那个**不是同一个**」—— 即 RESOLVED_VERSION_MISMATCH。
//
// ⚠️ 为什么不并进 downgradedBy：那条管的方向是「相对**更新前**变低了」，这条管的是「相对**目录目标**
//    不是它」。二者不等价，最典型的是「原地不动却以为升了」——`pnpm add` 时 registry 给了个比目录
//    记录的更新的版本，pnpm 报成功、磁盘真的变成了 1.9.0，但它其实想要 1.8.0。
//
// ⚠️ **方向不对称，这是关键**：只有「实际 < 目标」才算失败。
//    「实际 > 目标」是好的结果 —— 目录里的版本号是快照，registry 早已往前走，
//    `pnpm add spec` 按 spec 解析出更高版本本来就正常。把它判成失败等于拦掉正常的安装。
//    与 dsh-market 的 targetMismatch 判定同口径（它的注释原文：only BELOW the target counts）。
//
// 拿不到实际版本、或目标不是可解析的版本号（目录给的可能是 `latest` / 空 / range）时一律不判
// —— 无从比较就不能猜，宁可漏报（同 updateState / downgradedBy 的保守优先口径）。
function mismatchResolved(target, actual) {
  const t = dshMarket.parseVer(target)
  const a = dshMarket.parseVer(actual)
  if (!t || !a) return { mismatch: false }
  // cmpVer(actual, target) < 0 → 实际比目标低，才是不匹配
  return { mismatch: dshMarket.cmpVer(actual, target) < 0 }
}

// ── DSH 宿主兼容性（见 lib/dsh-host-compat.js）──

// 当前宿主的 DSH 版本。拿不到就返 ''，调用方必须**跳过联网**（无版本无从判定）。
//
// ⚠️ 复用 diagnostics.readEnv() 而不是自己读快照：那边已经把「resolved / installed /
//    globalVersion」三级回退写好了，而且诊断卡显示的版本就是它 —— 两处各读一份必然
//    出现「诊断说 0.1.6、兼容性按 0.1.7 判」这种自相矛盾。
function hostDshVersion() {
  try {
    return String(diagnostics.readEnv().dshVersion || '').trim()
  } catch (err) {
    logErr('[whale][dsh-market] 读宿主 dsh 版本失败', (err && err.message) || '')
    return ''
  }
}

// 目录条目 → 可拉 manifest 的包名。
//
// ⚠️ 为什么不能用 entry.npm 兜底：github / tarball 来源的安装 spec（占目录 48.6%）
//    npm 字段是 null，拿这些去 registry 查会 404 → 被判 unavailable → 满屏 unknown。
//    只认能从 spec 里剥出**裸包名**的那些（`name@1.2.3` / `@scope/name@^1.0.0`），
//    其余的明确返回 ''（= 这条判不了），不做无谓的联网。
function marketPkgNameOf(entry) {
  const e = entry && typeof entry === 'object' ? entry : {}
  const spec = dshMarket.parseInstallSpec(e.spec)
  if (dshMarket.specKindOf(spec) !== 'npm') return ''
  // 剥掉 spec 里可能带的 `@版本`。⚠️ 必须按**最后一个 `@`** 切：scope 包本身带一个 @
  //（`@scope/name@1.2.3`），按第一个切会切出空串
  const at = spec.lastIndexOf('@')
  const name = at > 0 ? spec.slice(0, at) : spec
  return dsh.validPkgName(name) || ''
}

// A 层拦截：dryRun 阶段判定了 incompatible 就**别让用户点下去**。
//
// ⚠️ 只拦「确证不兼容」（status === 'incompatible'）：
//    · unknown（没声明 / 拉不到）**照常放行** —— 目录里近一半条目没有 DSH 声明，
//      拦掉它们等于把插件市场废掉；而且「我们没查到」不是「不兼容」的证据。
//    · 联网失败也照常放行 —— 网络抖一下不能变成拦路虎。
async function enforceHostCompat(entry, opts) {
  // ⚠️ 两个形参是**历史残留**（2026-09-25 记录）：函数早先只收一个「目录条目」，加 force 时
  //    又并进来一个 opts，但全部 4 个调用点都只传一个对象（把 spec/npm/version/force 一起塞在
  //    第一个参数里）。于是 `o` 长期恒为 `{}`，force 永远读不到 —— 现象正是「点了强制安装、
  //    看了警告、按了确认，依旧被拦在写入前」。所以下面统一从 `entry` 取值，
  //    第二个形参只在显式传了对象时才作为补充（保持向后兼容，不再依赖它）。
  const e = entry && typeof entry === 'object' ? entry : {}
  const o = opts && typeof opts === 'object' ? Object.assign({}, e, opts) : e
  const pkg = marketPkgNameOf(entry)
  const host = hostDshVersion()
  // 无宿主版本 / 非 npm 来源：判不了，直接放行（也不发请求）
  if (!host || !pkg) return { blocked: false, status: 'unknown', reason: host ? 'undeclared' : 'no-host-version', requirement: '', package: pkg }
  // ⚠️ force：用户在界面上看过后果、明确选择「强制安装」时的放行开关（2026-09-25 加）。
  //    语义是「别拦了，但把结论照样算出来带回去」—— 判还是要判，界面要拿 requirement 显示
  //    「你正在强行装一个要求 ^0.1.7-rc.1 的插件」。所以这里只把 blocked 压成 false，
  //    不短路返回：后面照常联网取 facts，结论与不 force 时完全一致，只是不作为拦路依据。
  const force = o.force === true
  const registry = String(o.registry || cfgRegistry() || dshMarket.MIRROR_REGISTRY)
  const res = await dshHostCompat.lookup([pkg], { registry: registry })
  const facts = res && res.facts ? res.facts[pkg] : null
  const verdict = dshHostCompat.deriveHostCompatibility(facts, host, dshMarket.rangeAllows)
  if (verdict.status === 'incompatible') {
    return { blocked: !force, forced: force, status: verdict.status, reason: verdict.reason, requirement: verdict.requirement, package: pkg, host: host }
  }
  return { blocked: false, forced: false, status: verdict.status, reason: verdict.reason, requirement: verdict.requirement, package: pkg, host: host }
}

// 用户在设置里选的 registry（与目录抓取同一来源）。空则回落到内置默认源
function cfgRegistry() {
  try {
    return String(readConfig().dshMarketRegistry || '').trim()
  } catch (err) {
    return ''
  }
}

// 把 enforceHostCompat 的判定压成界面要的三个字段（未知就不下发，省得前端判两遍）
function hostCompatView(hc) {
  const h = hc && typeof hc === 'object' ? hc : {}
  return {
    status: String(h.status || 'unknown'),
    reason: String(h.reason || ''),
    requirement: String(h.requirement || ''),
    host: String(h.host || ''),
  }
}

// 确证不兼容时的 dryRun 返回体。
//
// ⚠️ 形状刻意与 ENV_NOT_READY / 快照失败那类**前置失败**一致：`ok:false` + 明确错误文案，
//    且 **不带 `changed:true`** —— 前端就是靠「changed 才给确认按钮」这条规则自动挡住，
//    不必让前端再认一个专门的字段（少一处前后端口径不一致的机会）。
// ⚠️ 附 `retryable: false`：原样重试必然再失败，唯一出路是换版本 / 换插件 / 升 DSH。
function hostBlockedResult(hc, extra) {
  const e = extra && typeof extra === 'object' ? extra : {}
  const req = String(hc.requirement || '')
  const host = String(hc.host || '')
  logErr('[whale][dsh-market] 宿主不兼容，已拦在写入前', { spec: e.spec, host: host, requirement: req })
  return Object.assign({
    ok: false,
    profile: e.profile,
    spec: e.spec,
    name: e.name,
    action: e.action,
    hostIncompatible: true,
    retryable: false,
    hostCompat: hostCompatView(hc),
    error: '确证与当前 DSH 不兼容：该插件要求 DSH ' + (req || '（范围读不到）')
      + '，而当前宿主是 ' + (host || '未知')
      + '。装上也无法加载，已拦在写入前。',
  }, e.version ? { to: String(e.version) } : {})
}

// 更新一个已装插件。opts = { profile?, spec, npm?, name?, dryRun? }
//
// ⚠️ 更新 = **按目录的 install spec 重装一次**，而不是 `pnpm update`：
//    · `pnpm update` 只会在**声明范围内**升（`^0.5.11` 升不到 0.6.0），而「有更新」的定义
//      正是「超出声明范围」—— 用它更新会永远更新不到，等于没实现。
//    · 用目录 spec 重装，pnpm 会把 package.json 里的范围**改写**成新版本的写法，
//      这恰好是用户期望的「升到市场里那个版本」。
//    代价：github / tarball 来源装的就是最新 commit，本来也没什么可升的（它们 state 多为 unknown）。
//
// ⚠️ 与安装走同一条链路（快照 → pnpm add → 回读核验），只是快照 reason 与文案不同 ——
//    更新失败同样能回滚，不应为省一个分支而让更新走没有快照的路。
function marketUpdate(opts) {
  const o = opts && typeof opts === 'object' ? opts : {}
  const profile = String(o.profile || 'web')
  const spec = dsh.validPkgSpec(o.spec !== undefined ? o.spec : o.npm)
  if (!spec) return { ok: false, error: '不是可更新的 spec：' + String(o.spec || o.npm || '（空）') }
  const label = String(o.name || o.npm || spec)
  const npm = dsh.validPkgName(o.npm) || ''

  if (o.dryRun === true) {
    return enforceHostCompat(o).then((hc) => {
      if (hc.blocked) return hostBlockedResult(hc, { profile: profile, spec: spec, name: label, action: 'update' })
      const deps = dsh.installedDeps(profile)
      const hit = dshMarket.matchInstalledBySpec(deps, spec) || (npm ? dshMarket.matchDepByNpm(deps, npm) : null)
      if (!hit) {
        return { ok: true, dryRun: true, profile: profile, spec: spec, name: label, action: 'not-installed', changed: false, message: label + ' 不在 profile 依赖里，无需更新', hostCompat: hostCompatView(hc) }
      }
      // from 用**实装版本**：用户要看的是「我现在装的是哪个版本」，不是声明范围。
      // ⚠️ 不退回 hit.depVersion（那是 `^0.5.11` 这类范围），拿不到就明确说未知
      const from = realizedOf(profile, hit, spec)
      return {
        ok: true,
        dryRun: true,
        profile: profile,
        spec: spec,
        name: label,
        action: 'update',
        changed: true,
        from: from,
        // ⚠️ 把目录给的版本原样回传：真写时前端会再带回来，被策略挡下时才能拼出
        //    「例如 `xxx@0.3.24`」这句可照抄的指引。不带回去就只能显示字面量「目标版本」（真实 bug）
        to: String(o.version == null ? '' : o.version).trim(),
        hostCompat: hostCompatView(hc),
        // ⚠️ 与 marketInstall 的 dryRun 同一口径（2026-09-25 加）：force 只把 hc.blocked 压成 false，
        //    「不兼容」这个结论本身还在。界面要靠它画警示条 —— 不然用户点了「强制安装」之后
        //    看到的是一张普通确认单，完全看不出自己正在做一件「装上大概率加载不了」的事。
        hostIncompatible: hc.status === 'incompatible',
        hostForced: hc.forced === true,
        message: '将执行 pnpm add --dir <profiles/' + profile + '> ' + spec
          + '\n当前版本：' + (from || '读不到实装版本（声明范围是 ' + (hit.depVersion || '无') + '）')
          + ' —— 重装会把声明改写成目录给的版本'
          + (hc.status === 'incompatible'
            ? '\n⚠️ 已忽略宿主兼容性检查（强制安装）：该插件要求 DSH ' + (hc.requirement || '（范围读不到）')
              + '，当前宿主是 ' + (hc.host || '未知') + ' —— 装上很可能无法加载。'
            : ''),
      }
    })
  }

  // mirror of marketInstall: dryRun 过了不代表真写能过 —— 那是两次独立调用
  return enforceHostCompat(o).then((hc) => {
    if (hc.blocked) return hostBlockedResult(hc, { profile: profile, spec: spec, name: label, action: 'update', version: o.version })
    return updateAfterCompat(o, {
      profile: profile, spec: spec, label: label, npm: npm,
      hostIncompatible: hc.status === 'incompatible', hostForced: hc.forced === true,
    })
  })
}

// marketUpdate 真写在过了兼容闸之后的全部动作。抽出来只为让上面那个 enforceHostCompat
// 的 then 保持扁平 —— 逻辑本身与早先完全一致（快照 → installPluginPkg → 三道回读校验）。
function updateAfterCompat(o, ctx) {
  const profile = ctx.profile
  const spec = ctx.spec
  const label = ctx.label
  const npm = ctx.npm
  const before = dshMarket.matchInstalledBySpec(dsh.installedDeps(profile), spec) || (npm ? dshMarket.matchDepByNpm(dsh.installedDeps(profile), npm) : null)
  // ⚠️ 只取**实装版本**，拿不到就留空 —— 绝不退回 `hit.depVersion`：那是声明范围（`^0.5.11`），
  //    界面会拼成 `v^0.5.11` 这种不成立的写法。空字符串时界面走不含 from 的那条文案分支。
  const fromBefore = before ? realizedOf(profile, before, spec) : ''
  const snap = dshBackup.createSnapshot({ profile: profile, reason: 'before-market-update' })
  if (!snap.ok) {
    logErr('[whale][dsh-market] 快照失败，已中止更新', snap.error || '')
    return Promise.resolve({ ok: false, error: '建快照失败，已中止更新：' + (snap.error || '未知错误') })
  }
  return dsh.installPluginPkg(profile, spec).then((r) => {
    if (!r.ok) {
      logErr('[whale][dsh-market] 更新失败', spec + ' 退出码 ' + r.code + ' ' + (r.err || ''))
      const build = o.needsBuild === true ? parseAllowBuilds(r.out || '') : null
      // 需构建被拦时重试前必须先改 allowBuilds，原样重试必然再失败；其余 pnpm 失败多为网络/锁文件，可重试
      return { ok: false, spec: spec, name: label, error: '更新失败（退出码 ' + r.code + '）：详见「日志」卡', tail: tailLines(r.out || r.err || ''), retryable: !build, snapshot: snap.dirName, allowBuilds: build }
    }
    const after = dsh.installedDeps(profile)
    const hit = dshMarket.matchInstalledBySpec(after, spec) || (npm ? dshMarket.matchDepByNpm(after, npm) : null)
    if (!hit) {
      logErr('[whale][dsh-market] 更新后回读校验不符', spec)
      return { ok: false, spec: spec, name: label, error: 'pnpm 报告成功，但 ' + spec + ' 没出现在 profile/package.json 里（已保留快照，可回滚）', snapshot: snap.dirName }
    }
    // ⚠️ 这里必须**重新读** node_modules：不重读会拿更新前的旧版本当新版本显示
    const to = realizedOf(profile, hit, spec) || hit.depVersion
    // 目录要的那个版本（dryRun 回传 → 前端真写时带回）。拿不到就是空 —— 后面几处判定都靠它
    const aim = String(o.version == null ? '' : o.version).trim()
    const aimTxt = aim || '目标版本'
    // ⚠️ 退出码 0 还不够：pnpm 可能被 profile 的供应链策略挡下、原样没动却报成功。
    //    判据是「回读到的实装版本真的变了」，没变就不能说「已更新」—— 否则界面会显示
    //    「已更新 v1.48.0 → v1.48.0」这种荒谬结论，用户以为成功、其实一个字没改。
    const blk = blockedByPolicy(profile, fromBefore, to, r.out)
    if (blk.blocked) {
      logErr('[whale][dsh-market] 更新被供应链策略拦截，版本未变', { spec: spec, version: to, aim: aim, staleReason: blk.staleReason })
      // ⚠️ 两种「版本没动」的成因与引导**完全不同**，必须分开派发，不能都让用户去改白名单：
      //    · release-age：pnpm 认为版本太新、还在观察期 —— 正解是**等**，改白名单是绕过安全策略；
      //    · allowlist  ：白名单只放行到旧版本 —— 正解才是把目标版本加进白名单。
      //    合并成一档会让「太新」的用户照着改 yaml，改完发现没用（真实用户报过这类困惑）。
      const isAge = blk.staleReason === 'release-age'
      const heal = isAge
        ? '\n这个版本发布还太新，pnpm 的 ' + blk.policyKey + ' 观察期还没过 —— 等它满期后重试即可，不必改配置。'
          + '\n（确实要立刻装，可把 ' + aimTxt + ' 加进 ' + blk.policyFile + ' 的 minimumReleaseAgeExclude 强行放行。）'
        : '\n如需放行，请把 ' + aimTxt + ' 加进 ' + blk.policyFile + ' 的 ' + blk.policyKey
          + '（照抄这一行即可：`- ' + spec + '@' + aimTxt + '`），再重试。'
      return {
        ok: false,
        spec: spec,
        name: label,
        blocked: true,
        staleReason: blk.staleReason,
        // release-age 只需等，重试才有意义；白名单要用户先改配置，原样重试必然再失败
        retryable: isAge,
        from: fromBefore,
        version: to,
        policyFile: blk.policyFile,
        policyKey: blk.policyKey,
        snapshot: snap.dirName,
        error: 'pnpm 报成功但版本没变（仍是 v' + (to || '未知') + '）：' + (aim ? '目录给的 v' + aim + ' ' : '')
          + (isAge ? '因为发布太新，被 pnpm 的发布观察期挡下了。' : '没能装上，被 profile 的供应链策略挡下了。')
          + heal
          + '\n（profile 已建快照，可回滚）',
      }
    }
    // ⚠️ 与 `blockedByPolicy` 是**两个方向**的失败：那条管「没变」，这条管「变了但变低了」。
    //    必须在报成功**之前**判 —— 降级后旧版已经在磁盘上，说「已更新」是错的。
    //    与 dsh-market 官方 DOWNGRADE_DETECTED 同语义：不可原样重试（重试还是同一个低版本）。
    const dg = downgradedBy(fromBefore, to)
    if (dg.downgraded) {
      logErr('[whale][dsh-market] 更新后版本反而变低（疑似镜像滞后）', { spec: spec, from: fromBefore, to: to })
      return {
        ok: false,
        spec: spec,
        name: label,
        downgraded: true,
        // 原样重试还是同一个低版本，重试无用 —— 要等镜像同步
        retryable: false,
        from: fromBefore,
        version: to,
        profile: profile,
        snapshot: snap.dirName,
        error: '装上的版本比原来更低了（v' + fromBefore + ' → v' + to + '）：'
          + 'pnpm 报成功，但 registry / 镜像把它解析成了旧版本。'
          + '\n旧版本可能缺少安全修复，建议先回滚；等镜像同步后再重试。'
          + '\n（profile 已建快照，可回滚到 v' + fromBefore + '）',
      }
    }
    // ⚠️ 与上面两条都不同：这条管的是「相对**目录目标**不是它」，而不是「没变」或「相对更新前变低」。
    //    典型场景是「原地不动却以为升了」（registry 给了比目录记录的更高的版本）——
    //    此时 fromBefore < to 成立（不算降级），只靠上面两条会漏判、直接报「已更新」。
    //    口径见 mismatchResolved 注释：**只有低于目标才算失败**，高于目标是正常的好结果。
    const mm = mismatchResolved(aim, to)
    if (mm.mismatch) {
      logErr('[whale][dsh-market] 装出来的版本低于目录目标', { spec: spec, aim: aim, got: to })
      return {
        ok: false,
        spec: spec,
        name: label,
        mismatch: true,
        // 可能是镜像滞后（等同步后重试有用），也可能是目录太旧 —— 交由用户判断，故标可重试
        retryable: true,
        from: fromBefore,
        version: to,
        expected: aim,
        profile: profile,
        snapshot: snap.dirName,
        error: '装出来的不是目录要的那个版本（目录要 v' + aim + '，实际 v' + to + '）：'
          + 'pnpm 报成功，但 registry 解析出的版本低于目录记录的版本。'
          + '\n可能是镜像还没同步到这个版本 —— 稍后重试通常能拿到；'
          + '若一直如此，说明目录里的版本号已经过时（以 registry 实际发布的为准）。'
          + '\n（profile 已建快照，可回滚）',
      }
    }
    log('[whale][dsh-market] 已更新插件', { spec: spec, from: fromBefore, to: to })
    return {
      ok: true,
      spec: spec,
      npm: npm,
      name: label,
      from: fromBefore,
      version: to,
      profile: profile,
      snapshot: snap.dirName,
      // ⚠️ 与 installWrite 同一口径（2026-09-25 加）：force 不拦，但结论要如实回传，
      //    界面据此在结果卡上补一句「这是强行装的，加载失败先回滚快照」
      hostIncompatible: ctx.hostIncompatible === true,
      hostForced: ctx.hostForced === true,
      needsRestart: true,
    }
  })
}

// 取一个已装命中项的**实装版本**（node_modules 里的真实 version），拿不到返 ''。
// ⚠️ 每次调用都重新读表：更新完成后版本会变，不能缓存旧值。
function realizedOf(profile, hit, spec) {
  const versions = dsh.installedVersions(profile)
  if (hit && hit.key && versions[hit.key]) return String(versions[hit.key])
  return spec ? dshMarket.realizedVersionBySpec(versions, spec) : ''
}

// 把长输出**只留尾部**再回传给界面（与 dsh-market 的 message.slice(-1200) 同口径）。
//
// ⚠️ 为什么砍头不砍尾：pnpm 的关键诊断（错误码、`For example:` 段、到底是哪个包被判违规）
//    一律在**末尾**，前面全是 `Progress: resolved … reused …` 这类进度噪声。整段回传会把
//    真正有用的那几行淹掉，用户还得自己滚到底；而这里的用途正是「让用户一眼看到要照抄什么」。
//    长度按**行**保留比按字符切更稳：按字符切可能把最后一行（往往就是错误码那行）切半。
const OUT_TAIL_LINES = 40

function tailLines(text, maxLines) {
  const s = String(text == null ? '' : text)
  if (!s) return ''
  const max = Number.isFinite(maxLines) && maxLines > 0 ? Math.floor(maxLines) : OUT_TAIL_LINES
  const lines = s.split(/\r?\n/)
  if (lines.length <= max) return s
  return '（省略前面 ' + (lines.length - max) + ' 行）\n' + lines.slice(-max).join('\n')
}

// 从 dsh / pnpm 的失败输出里把 allowBuilds 引导信息抠出来。
//
// ⚠️ 为什么需要这个解析：github / tarball 来源的插件靠 `prepare` 脚本在安装时构建，
//    **pnpm 默认拦截构建脚本**，报 `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`，并给出要写进
//    pnpm-workspace.yaml 的 key。**那把 key 带 commit hash，安装前拿不到**，
//    所以「需构建」的条目注定要先失败一次 —— 这不是 bug，而是 pnpm 的安全机制。
//    既然注定要失败一次，就该把 pnpm 给的原文照搬给用户，省掉「去日志里自己找」这一步。
//
// ⚠️ 实测原文（2026-09-23，`dsh plugin --profile web add github:omdsh-dev/DSH-better-sidebar`）：
//      Add the package to "allowBuilds" in your project's pnpm-workspace.yaml ... For example:
//      allowBuilds:
//        dsh-better-sidebar@git+https://github.com/omdsh-dev/DSH-better-sidebar.git#1fcf43cc...: true
//    → key **不是**反引号包起来的，是缩进两格的裸 yaml 行；形态是 `名字@git+https://….git#<hash>`。
//    （早先按「反引号 + codeload tar.gz」写的那版在真实输出上只会抠到空 key —— 这条注释就是防回退）
//
// 只在输出里出现 allowBuilds 字样时才启用，避免把普通的报错误读成构建拦截。
function parseAllowBuilds(text) {
  const s = String(text == null ? '' : text)
  if (!/allowBuilds/i.test(s)) return null
  // key = `名字@<来源 URL>`，「: true」之前、缩进之后的那一串。
  // 来源可以是 `git+https://…`、`https://…/x.tgz` 或 codeload 归档地址，统一按「@ 后面跟协议」识别。
  const km = s.match(/^\s*([^\s:][^\s]*@(?:git\+)?https?:\/\/[^\s:]+?)\s*:\s*(?:true|false)?\s*$/m)
  const key = km ? km[1].trim() : ''
  // pnpm-workspace.yaml 的路径：dsh 的结尾提示里给的是绝对路径（Windows 盘符或 POSIX）。
  // ⚠️ 必须**先**匹配「带路径的」再退回裸文件名：报错正文里先出现的是裸名
  //    （`project's pnpm-workspace.yaml`），先匹配裸名就会把绝对路径漏掉。
  const pm = s.match(/([A-Za-z]:\\[^\s]*pnpm-workspace\.yaml|\/[^\s]*pnpm-workspace\.yaml|(?:[\w.\\/-]*pnpm-workspace\.yaml))/g)
  let file = 'pnpm-workspace.yaml'
  if (pm) {
    for (let i = pm.length - 1; i >= 0; i--) {
      const t = pm[i].trim()
      if (t !== 'pnpm-workspace.yaml') { file = t; break }
    }
  }
  return { key: key, file: file }
}

// 安装一个插件（三段式写法的第二阶段）。
// opts = { profile?, spec: string, npm?: string, name?: string, needsBuild?, dryRun? }
//
// ⚠️ 装的是 **spec**（目录给的 install 字段剥出来的原话），不是 npm 字段：
//    实测 4183 条目录里 2033 条（48.6%）npm 为 null，spec 是 `github:owner/repo`
//    或远端 tgz 地址 —— npm / pnpm 都原生支持这两种形态，不给按钮等于砍掉近一半目录。
function marketInstall(opts) {
  const o = opts && typeof opts === 'object' ? opts : {}
  const profile = String(o.profile || 'web')
  const spec = dsh.validPkgSpec(o.spec !== undefined ? o.spec : o.npm)
  if (!spec) return { ok: false, error: '不是可安装的 spec（只认包名 / github:owner/repo / https 地址）：' + String(o.spec || o.npm || '（空）') }
  // 展示名优先用目录 entry 名（带 `#子包` 后缀的那个），没有才退化到 spec
  const label = String(o.name || o.npm || spec)
  // 归一出的 npm 名（有则用于回读核验；github/tarball 没有，靠 installSpec 反查）
  const npm = dsh.validPkgName(o.npm) || ''
  const needsBuild = o.needsBuild === true
  // 目录条目带的版本号（github / tarball 条目常为 null，那就不参与判定）
  const catalogVersion = String(o.version == null ? '' : o.version).trim()
  // ⚠️ exact=true：「装到指定的这一版」而非「按原 spec 重装」（2026-09-25 新增）。
  //
  // 为什么必须单开一条路：按原 spec 重装对「升到最新」**根本无效** —— profile 的
  // pnpm-lock.yaml 里锁着 `specifier: ^1.62.0 / version: 1.62.0`，`pnpm add dshmarket`
  // 会命中锁文件、原样复用 1.62.0。而目录是每日快照，它记的版本还可能更旧。
  // 所以只能把**确切版本**拼进 spec：`dshmarket@1.65.1`。pnpm 见到精确版本会改写
  // lock（这正是「更新」做不到的事）。
  //
  // ⚠️ 只对 npm 来源开放：要用到「裸包名 + 版本」。github / tarball 的 spec 形态里
  //    塞版本号没有意义（`github:a/b@1.0.0` 不是 pnpm 认的写法），所以这里直接拒绝，
  //    而不是拼出一个必然失败的字符串。
  const exact = o.exact === true
  const targetVersion = String(o.targetVersion == null ? '' : o.targetVersion).trim()
  let runSpec = spec
  if (exact) {
    // 裸包名从 npm 字段取（spec 可能是别名 / 子包路径，不能当包名用）
    const pinName = dsh.validPkgName(o.npm) || dsh.validPkgName(spec)
    const pinVer = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(targetVersion) ? targetVersion : ''
    if (!pinName || !pinVer) {
      return {
        ok: false,
        error: '安装指定版本需要「裸 npm 包名 + 确切版本号」（只在 npm 来源上可用）：'
          + '包名 ' + (pinName || String(o.npm || spec) || '（空）') + '，版本 ' + (targetVersion || '（空）'),
      }
    }
    runSpec = pinName + '@' + pinVer
  }

  // dryRun：只说清「准备执行什么」，不跑 npm 也不建快照
  if (o.dryRun === true) {
    return enforceHostCompat(Object.assign({}, o, { spec: spec })).then((hc) => {
      if (hc.blocked) {
        return hostBlockedResult(hc, { profile: profile, spec: spec, name: label, action: 'install', version: catalogVersion })
      }
      const deps = dsh.installedDeps(profile)
      const hit = dshMarket.matchInstalledBySpec(deps, spec) || (npm ? dshMarket.matchDepByNpm(deps, npm) : null)
      // ⚠️ 光判「装没装」不够 —— 这正是本函数早先的一个真实 bug：声明范围 `^1.48.0` 是**容得下**
      //    `1.49.0` 的，用户看着目录里有新版去点「安装」，却被告知「已装 …无需重复安装」。
      //    所以这里还要比**实装版本**（读自 node_modules 的裸 x.y.z）：实装 < 目录版本 → 该走更新。
      //    口径与 marketCheckUpdates 的 updateState 完全一致（那边也是「优先比实装，拿不到退回范围」），
      //    两边不一致会出现「列表标着可更新、点进去却说已装」这种自相矛盾。
      const realized = realizedOf(profile, hit, spec)
      // ⚠️ **exact 的「要不要装」不能问目录，要问用户指定的那一版**（2026-09-25 修，真实 bug）：
      //    用户点「装这一版」要的是 registry 的 v1.65.1，而目录快照记的可能是 v1.61.0。
      //    若照旧拿 catalogVersion 去比，`1.62.0(实装) vs 1.61.0(目录)` 判成「已是最新」→
      //    changed=false → 界面回「已装 dsh-market（1.62.0），无需重复安装」，按钮点了没反应。
      //    这是把「目录这一维度」的结论错用到了「registry 那一维度」的问题上。
      //    故这里单算：拿 realized / depVersion 与 **targetVersion** 比，相等才叫不必装。
      let changed = false
      if (!hit) {
        changed = true
      } else if (exact) {
        const mine = String(realized || hit.depVersion || '')
        // 版本读不出来 → 宁可真装一次（pnpm 装同一版本是幂等的，白等一次好过按钮点了没反应）
        changed = !mine || dshMarket.cmpVer(mine, targetVersion) !== 0
      } else {
        const st = dshMarket.updateState(hit.depVersion, catalogVersion, realized)
        changed = st.state === 'update'
      }
      return {
        ok: true,
        dryRun: true,
        profile: profile,
        spec: spec,
        npm: npm,
        name: label,
        needsBuild: needsBuild,
        changed: changed,
        action: changed ? 'install' : 'already',
        hostCompat: hostCompatView(hc),
        // ⚠️ 强制安装时把「不兼容」这个结论**照样带出去**（2026-09-25 加）：
        //    force 只让 hc.blocked 变 false，结论本身没变。界面要拿它画警示条与徽标 ——
        //    否则用户点了「强制安装」后看到的是一张普普通通的确认单，
        //    完全看不出自己正在做一件「装上大概率加载不了」的事。
        hostIncompatible: hc.status === 'incompatible',
        hostForced: hc.forced === true,
        // 已装且不比目录旧 → 才是真的不必重跑 pnpm（同一包重装是幂等的，但会白等一次网络）
        message: changed
          ? (!hit
            ? '将执行 pnpm add --dir <profiles/' + profile + '> ' + runSpec
            : '已装 ' + (realized || hit.depVersion || '') + '，'
              + (exact
                // exact 分支的「目标」是用户查到的 registry 版本，不是目录版本 —— 说错会让人以为要看目录
                ? '将精确重装到 v' + targetVersion + '（`' + runSpec + '`）'
                : '目录提供 v' + catalogVersion + ' —— 将重装覆盖到 v' + catalogVersion)
              + '（会改写 profile/package.json 里的版本范围）')
          + (needsBuild ? '\n⚠️ 该来源靠 prepare 脚本构建，pnpm 默认拦截构建 —— 第一次大概率会失败并要求写入 allowBuilds，按提示再装一次即可' : '')
          + (hc.status === 'incompatible'
            ? '\n⚠️ 已忽略宿主兼容性检查（强制安装）：该插件要求 DSH ' + (hc.requirement || '（范围读不到）')
              + '，当前宿主是 ' + (hc.host || '未知') + ' —— 装上很可能无法加载。'
            : '')
          // 走到这里必是命中已装：exact 说清「已经是这一版」，常规说清「已经是目录最新」
          : '已装 ' + label + '（' + (realized || hit.depVersion || '') + '），'
            + (exact
              ? '已经是 v' + targetVersion + '，无需重复安装'
              // 实装版本与目录版本都拿得到才说得清「已是最新」；拿不到就别下这个结论
              : (realized && catalogVersion ? '已是目录里的最新版 v' + catalogVersion : '无需重复安装')),
      }
    })
  }
  // ⚠️ dsh.globalDsh() 是**同步调用**，且发生在返回 Promise 之前。若宿主函数缺失
  //    （实测 2026-09-25：界面报 `dsh.globalDsh is not a function`，因为 uTools 里还挂着
  //    改动前的旧 preload），异常会直接冒到调用方，`.then` 链根本挂不上 ——
  //    按钮永久卡在「正在安装…」、计时器永不停。这里只是一句告警日志，包起来即可。
  try {
    if (dsh.globalDsh()) {
      // 与主安装链路同一取舍：有全局 dsh 时 pnpm 装插件的目标目录取决于 dsh 从哪加载，
      // 这里只警告不阻断 —— 用户确实可能故意两个都装
      log('[whale][dsh-market] 检测到全局 dsh，插件将装进 profile 目录', profile)
    }
  } catch (err) {
    logErr('[whale][dsh-market] 检测全局 dsh 失败（不影响安装）', (err && err.message) || String(err))
  }

  // ⚠️ 建快照期间 pnpm 还没起（`state.lastCmd` 要等 runPnpm 里的 setCmd 才写），
  //    用户 2026-09-25 实测反馈「等了好久，不知道什么情况，也不知道有没有在安装」——
  //    进度区那时只能显示一句静态提示，日志卡更是空白，看起来像卡死。所以每一步动手前
  //    先往 dsh 的日志流里播一条阶段说明，让「运行详情」有东西可看。
  //
  // ⚠️ 用 safeNote 而不是直接 dsh.note：本函数是**同步返回 Promise** 的，若 note 抛异常
  //    （最典型是 uTools 里还挂着旧 preload、dsh.note 尚不存在），异常会在返回 Promise
  //    之前冒出来 —— 调用方 `.then` 链挂不上，界面永久卡在「正在安装…」。
  //    阶段旁白只是观感增强，绝不能因为它把整条安装链路拽塌。
  const safeNote = (t) => { try { return dsh.note(t) } catch (err) { logErr('[whale][dsh-market] 播阶段旁白失败（不影响安装）', (err && err.message) || String(err)) } }

  // ⚠️ 真写**必须自己再过一遍兼容闸**（2026-09-25 加）：dryRun 与真写是宿主上的两次独立调用
  //    （界面先 dryRun 拿单据、用户点头后再调一次真写），dryRun 放行过不代表这次也放行。
  //    更要紧的是反向情形：用户点了「仍要强制安装」，界面把 force 带回来了 —— 若真写不读 force，
  //    他看完成功单据点确认，却照样被拦在写入前，比一开始就不给这个按钮更糟。
  //    放行之后的所有动作抽进 installWrite，与 updateAfterCompat 同一手法，只为让这条 then 保持扁平。
  return enforceHostCompat(Object.assign({}, o, { spec: spec })).then((hc) => {
    if (hc.blocked) {
      return hostBlockedResult(hc, { profile: profile, spec: spec, name: label, action: 'install', version: catalogVersion })
    }
    return installWrite(o, {
      profile: profile, spec: spec, label: label, npm: npm, needsBuild: needsBuild,
      runSpec: runSpec, exact: exact, targetVersion: targetVersion,
      safeNote: safeNote,
      hostIncompatible: hc.status === 'incompatible', hostForced: hc.forced === true,
    })
  })
}

// marketInstall 真写在过了兼容闸之后的全部动作：快照 → installPluginPkg → 三道回读校验。
// 逻辑本身与早先完全一致，只是从 marketInstall 里搬出来（兼容闸需要它成为被调用者）。
function installWrite(o, ctx) {
  const profile = ctx.profile
  const spec = ctx.spec
  const label = ctx.label
  const npm = ctx.npm
  const needsBuild = ctx.needsBuild
  const runSpec = ctx.runSpec
  const exact = ctx.exact
  const targetVersion = ctx.targetVersion
  const safeNote = ctx.safeNote
  safeNote('开始安装 ' + runSpec + '：先建 profile 快照（备份 package.json 等，随后才起 pnpm）')
  const snap = dshBackup.createSnapshot({ profile: profile, reason: 'before-market-install' })
  if (!snap.ok) {
    logErr('[whale][dsh-market] 快照失败，已中止安装', snap.error || '')
    safeNote('建快照失败，已中止安装：' + (snap.error || '未知错误'))
    return Promise.resolve({ ok: false, error: '建快照失败，已中止安装：' + (snap.error || '未知错误') })
  }
  safeNote('快照已建（' + snap.dirName + '），开始起 pnpm 进程')
  // 装之前的实装版本，供结果卡画 `旧 → 新`。必须在跑 pnpm **之前**读，
  // 跑完再读就是新的了（见 return 里 from 的注释）
  const fromBefore = (function () {
    const before = dsh.installedDeps(profile)
    const h = dshMarket.matchInstalledBySpec(before, spec) || (npm ? dshMarket.matchDepByNpm(before, npm) : null)
    return realizedOf(profile, h, spec) || (h && h.depVersion) || ''
  })()
  return dsh.installPluginPkg(profile, runSpec).then((r) => {
    if (!r.ok) {
      logErr('[whale][dsh-market] 安装失败', runSpec + ' 退出码 ' + r.code + ' ' + (r.err || ''))
      // 「需构建」这一档把 dsh / pnpm 的 allowBuilds 原文交给界面 —— 用户照着写一遍
      // 再点一次即可，不必自己翻日志找那把带 commit hash 的 key
      const build = needsBuild ? parseAllowBuilds(r.out || '') : null
      return {
        ok: false,
        spec: spec,
        name: label,
        error: '安装失败（退出码 ' + r.code + '）：详见「日志」卡',
        tail: tailLines(r.out || r.err || ''),
        // 需构建被拦时先改 allowBuilds 才能重试成功，原样重试必然再失败
        retryable: !build,
        snapshot: snap.dirName,
        allowBuilds: build,
      }
    }
    // ⚠️ 不信任「pnpm 退出码 0 = 装好了」：回读 profile/package.json 确认依赖真的出现了。
    // 与 dsh-patch 写后回读同一个理由 —— V2 已证明写坏的东西不会报错。
    // ⚠️ 回读仍用**原 spec**（不是 runSpec）：`pkg@1.2.3` 这个带版本的串在 package.json 里
    //    存的是**键名**，拿带版本的串去匹配键必然对不上（会误报「没装进去」）。
    //    用 spec 反查，github/tarball 的键名也由它归一（npm 字段对不上那类来源）。
    const after = dsh.installedDeps(profile)
    const hit = dshMarket.matchInstalledBySpec(after, spec) || (npm ? dshMarket.matchDepByNpm(after, npm) : null)
    if (!hit) {
      logErr('[whale][dsh-market] 安装后回读校验不符', spec)
      return {
        ok: false,
        spec: spec,
        name: label,
        error: 'pnpm 报告成功，但 ' + spec + ' 没出现在 profile/package.json 里（已保留快照，可回滚）',
        snapshot: snap.dirName,
      }
    }
    // ⚠️ exact 模式多一道校验：**实装版本必须等于要的那个版本**。
    //    只凭上面「键名出现」不够 —— 键早就在了（本来已装），真正要确认的是「版本真的换了」。
    //    而 pnpm 完全可能报成功却仍留着旧版本（供应链策略 / registry 解析），
    //    不校验就会显示「已安装 @1.65.1」而磁盘上还是 1.62.0。
    const got = realizedOf(profile, hit, spec)
    if (exact && got !== targetVersion) {
      logErr('[whale][dsh-market] 精确安装后版本不符', { spec: spec, want: targetVersion, got: got })
      return {
        ok: false,
        spec: spec,
        name: label,
        version: got,
        expected: targetVersion,
        snapshot: snap.dirName,
        error: '没装到指定的那个版本（要 v' + targetVersion + '，实装 ' + (got || '读不到') + '）：'
          + 'pnpm 报成功但磁盘上的版本不是它 —— 可能是供应链策略挡下、或该版本已从 registry 撤下。'
          + '\n（profile 已建快照，可回滚）',
      }
    }
    // ⚠️ 回传的 version 必须是**实装版本**（`got`，读自 node_modules 的真实 version），
    //    不能用 `hit.depVersion` —— 后者是 package.json 里的**声明范围**（`^1.65.1`），
    //    界面拼出来就成了 `v^1.65.1`（2026-09-25 实测踩到：结果卡显示
    //    「已安装 dsh-market（v1.62.0 → v^1.65.1）」，精确安装的卡上冒出 caret 自相矛盾）。
    //    pnpm 把 `dshmarket@1.65.1` 写进 package.json 时会**保留成 `^1.65.1`**，所以这两个值
    //    在这个场景下必然不等 —— 实测 `got=1.65.1`、`hit.depVersion=^1.65.1`。
    //    `got` 读不到（node_modules 缺该包）才退回范围，至少给用户一个能看的串。
    const shownVersion = got || hit.depVersion || ''
    log('[whale][dsh-market] 已安装插件', { spec: spec, runSpec: runSpec, version: shownVersion, declared: hit.depVersion })
    return {
      ok: true,
      spec: spec,
      npm: npm,
      name: label,
      version: shownVersion,
      // ⚠️ 带上「装之前是什么版本」（2026-09-25 加）：界面要在结果卡上画 `1.62.0 → 1.65.1`。
      //    不给它前端只能自己猜 —— 而前端手上只有目录版本（正是滞后的那个），画出来必然是错的。
      //    这里的 from 是**回读出来的实装版本**（`realizedOf`），不是 package.json 里的 range
      from: fromBefore,
      profile: profile,
      snapshot: snap.dirName,
      // ⚠️ github / tarball 来源即使装成功也**不保证 dsh 能加载**：pnpm 仍会拦 prepare 构建。
      //    界面据此提示「若加载失败，按 allowBuilds 引导再试」
      needsBuild: needsBuild,
      // ⚠️ 真写也照样把兼容结论带回去（2026-09-25 加）：force 只是不拦，结论没变。
      //    界面用它把成功卡切成「强行装上了，若加载失败先回滚快照」的措辞
      hostIncompatible: ctx.hostIncompatible === true,
      hostForced: ctx.hostForced === true,
      // 装完必须让 dsh 重新加载才生效，但重启会掐掉正在跑的会话 —— 交给用户点按钮
      needsRestart: true,
    }
  })
}

// 卸载一个插件。opts = { profile?, npm?, spec?, name?, remove?, dryRun? }
//   remove !== true  → 只禁用（往 patch 写 disabled: true），包留在磁盘
//   remove === true  → pnpm remove 删磁盘包（**只删这一个包名**，不做依赖反查）
//
// ⚠️ npm 与 spec 的分工：卸载 / 禁用最终都要一个**已在 package.json 里的键名**
//    （pnpm remove 只认键；patch 条目 id 也只认键），而这个键对 github / tarball
//    来源是由包管理器归一出来的，目录里没有。所以这里若只拿到 spec，就先用 spec 反查
//    已装映射拿到真实键 —— 反查不到说明根本没装，直接按「无需卸载」处理。
function marketUninstall(opts) {
  const o = opts && typeof opts === 'object' ? opts : {}
  const profile = String(o.profile || 'web')
  const spec = dsh.validPkgSpec(o.spec)
  let npm = dsh.validPkgName(o.npm)
  if (!npm && spec) {
    // 反查要在「键名列表」上做，而不是拿 hit 的 depVersion 猜键 ——
    // hit 只告诉我们「有这么一条」，键名还得自己从 dependencies 里取回来
    npm = realDepKey(profile, spec)
  }
  if (!npm) return { ok: false, error: '不是合法的 npm 包名：' + String(o.npm || spec || '（空）') }
  const label = String(o.name || npm)
  const remove = o.remove === true

  if (remove) {
    if (o.dryRun === true) {
      const deps = dsh.installedDeps(profile)
      const has = !!deps[npm]
      return {
        ok: true,
        dryRun: true,
        remove: true,
        profile: profile,
        npm: npm,
        name: label,
        changed: has,
        action: has ? 'uninstall' : 'missing',
        message: has
          ? '将从 <profiles/' + profile + '> 里删掉 ' + npm + '（pnpm remove）'
          : npm + ' 不在 profile 依赖里，无需卸载',
      }
    }
    const snap = dshBackup.createSnapshot({ profile: profile, reason: 'before-market-uninstall' })
    if (!snap.ok) {
      logErr('[whale][dsh-market] 快照失败，已中止卸载', snap.error || '')
      return Promise.resolve({ ok: false, error: '建快照失败，已中止卸载：' + (snap.error || '未知错误') })
    }
    return dsh.uninstallPluginPkg(profile, npm).then((r) => {
      if (!r.ok) {
        logErr('[whale][dsh-market] 卸载失败', npm + ' 退出码 ' + r.code + ' ' + (r.err || ''))
        return {
          ok: false,
          error: '卸载失败（退出码 ' + r.code + '）：详见「日志」卡',
          tail: tailLines(r.out || r.err || ''),
          retryable: true,
          snapshot: snap.dirName,
        }
      }
      const after = dsh.installedDeps(profile)
      if (after[npm]) {
        logErr('[whale][dsh-market] 卸载后回读校验不符', npm)
        return {
          ok: false,
          error: 'pnpm 报告成功，但 ' + npm + ' 仍在 profile/package.json 里（已保留快照，可回滚）',
          retryable: true,
          snapshot: snap.dirName,
        }
      }
      log('[whale][dsh-market] 已卸载插件', npm)
      return { ok: true, removed: true, npm: npm, name: label, profile: profile, snapshot: snap.dirName, needsRestart: true }
    })
  }

  // 只禁用：复用 E2 的 toggle（dryRun / 快照 / 回读核验都在那一条链路上，不重写一遍）
  // ⚠️ patch 的条目 id 用**用户当前写的那个名字**（可能是短名），而不是目录给的完整包名，
  // 否则会 append 出一个新 id，等于往 dsh 里塞了一条指向不存在插件的 patch（V2：静默失效）
  const status = marketStatus({ profile: profile })
  const hit = dshMarket.matchInstalled(status.installed, npm)
  const id = hit && hit.inPatch ? shortName(npm, status.installed) : npm
  const probe = toggleDshPatchItem({ profile: profile, id: id, disabled: true, dryRun: true })
  if (o.dryRun === true) {
    if (!probe.ok) return probe
    return {
      ok: true,
      dryRun: true,
      remove: false,
      profile: profile,
      npm: npm,
      id: id,
      name: label,
      changed: probe.changed,
      action: probe.action,
      message: probe.changed
        ? '将在 patch 里把 ' + id + ' 标为 disabled: true（包保留在磁盘上）'
        : id + ' 已经是禁用状态',
    }
  }
  if (!probe.ok) return probe
  if (!probe.changed) return { ok: true, changed: false, remove: false, npm: npm, id: id, name: label, profile: profile }
  const snap = dshBackup.createSnapshot({ profile: profile, reason: 'before-market-disable' })
  if (!snap.ok) {
    logErr('[whale][dsh-market] 快照失败，已中止禁用', snap.error || '')
    return { ok: false, error: '建快照失败，已中止禁用：' + (snap.error || '未知错误') }
  }
  const res = toggleDshPatchItem({ profile: profile, id: id, disabled: true })
  log('[whale][dsh-market] 已禁用插件', { id: id })
  return Object.assign({ remove: false, npm: npm, name: label, snapshot: snap.dirName }, res)
}

// 把完整包名对回到「用户实际写在 patch 里的那个 id」（可能是去掉 scope 的短名）
function shortName(fullName, installed) {
  const full = String(fullName || '')
  const map = installed && typeof installed === 'object' ? installed : {}
  if (map[full]) return full
  const slash = full.indexOf('/')
  const short = slash >= 0 ? full.slice(slash + 1) : full
  return map[short] ? short : full
}

// 按 spec 反查 profile/package.json 里那个**真实的键名**。
// matchInstalledBySpec 只回答「装了没有」，卸载 / 禁用要的是键本身（见 marketUninstall 注释）。
// 找不到返回 ''。
function realDepKey(profile, spec) {
  const deps = dsh.installedDeps(profile)
  const keys = Object.keys(deps)
  for (let i = 0; i < keys.length; i++) {
    // 逐个键拿去问 matchInstalledBySpec：命中就说明这个键就是我们要找的那个
    // （用单键对象包一层，复用同一套归一逻辑，避免这里再抄一遍候选规则）
    const one = {}
    one[keys[i]] = 'x'
    if (dshMarket.matchInstalledBySpec(one, spec)) return dsh.validPkgName(keys[i]) || keys[i]
  }
  return ''
}

// 近 N 天用量（含今日，缺失日期补 0），按日期升序。
// 上限 = 配置的账本保留天数（默认 365，最低 35）：设置页要算「本月汇总」，31 号那天窗口必须能回溯到 1 号。
function usageDays(days) {
  const n = clampNum(days, 1, historyKeepDays(), 7)
  const led = readLedger()
  const out = []
  const now = new Date()
  const p2 = (x) => String(x).padStart(2, '0')
  for (let i = n - 1; i >= 0; i--) {
    const dt = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)
    const key = dt.getFullYear() + '-' + p2(dt.getMonth() + 1) + '-' + p2(dt.getDate())
    let usage = 0
    if (key === led.date) usage = typeof led.todayUsage === 'number' ? led.todayUsage : 0
    else if (typeof led.history[key] === 'number') usage = led.history[key]
    out.push({ date: key, usage: usage })
  }
  // 今日被防误判拦下、未计入用量的余额变动（赠送额到期等），供设置页说明展示
  return {
    currency: led.lastCurrency || 'CNY',
    days: out,
    todayAdjust: typeof led.todayAdjust === 'number' ? led.todayAdjust : 0,
    lastAdjustWhy: led.lastAdjustWhy || '',
    lastAdjustAt: led.lastAdjustAt || '',
    // 额度「不重置」口径的累计已用（归档累计 + 今天）
    cumUsed: (typeof led.quotaUsed === 'number' ? led.quotaUsed : 0)
      + (typeof led.todayUsage === 'number' ? led.todayUsage : 0),
  }
}

// 账本明细：区间内每日用量 + 当天「未计入用量的余额变动」与「手动校准」记录，供设置页按日展开。
// 明细日志（adjustLog / calibrateLog）由宿主跨天保留配置的保留天数，区间外查不到。
// 检索交给设置页本地做（数据一次拿全，输入即过滤，不用每次按键都过一次 IPC）。
function usageDetail(days) {
  const n = clampNum(days, 1, historyKeepDays(), 7)
  const led = readLedger()
  const p2 = (x) => String(x).padStart(2, '0')
  // 两条日志都带 ISO 时间戳，取前 10 位即日期
  const byDate = {}
  const collect = (list, build) => {
    for (const e of Array.isArray(list) ? list : []) {
      const at = e && typeof e.at === 'string' ? e.at : ''
      if (!at) continue
      const d = at.slice(0, 10)
      if (!byDate[d]) byDate[d] = []
      byDate[d].push(build(e, at))
    }
  }
  collect(led.adjustLog, (e, at) => ({
    at: at, kind: 'adjust', amount: Number(e.amount) || 0, why: String(e.why || ''),
  }))
  collect(led.calibrateLog, (e, at) => ({
    at: at, kind: 'calibrate', from: Number(e.from) || 0, to: Number(e.to) || 0,
  }))
  const now = new Date()
  const out = []
  let total = 0
  for (let i = n - 1; i >= 0; i--) {
    const dt = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)
    const key = dt.getFullYear() + '-' + p2(dt.getMonth() + 1) + '-' + p2(dt.getDate())
    let usage = 0
    if (key === led.date) usage = typeof led.todayUsage === 'number' ? led.todayUsage : 0
    else if (typeof led.history[key] === 'number') usage = led.history[key]
    out.push({
      date: key,
      usage: usage,
      entries: (byDate[key] || []).sort((a, b) => (a.at < b.at ? -1 : 1)),
    })
    total += usage
  }
  return {
    currency: led.lastCurrency || 'CNY',
    days: out,
    total: Math.round(total * 10000) / 10000,
  }
}

// 解析用量 CSV → { rows: [{ date, usage }], invalid }。
// 兼容导出格式「日期,用量[,币种]」：UTF-8 BOM、CRLF/LF、表头行、日期分隔符 - / . 均可。
function parseUsageCsv(text) {
  const rows = []
  let invalid = 0
  const p2 = (x) => String(x).padStart(2, '0')
  const lines = String(text == null ? '' : text).replace(/^\ufeff/, '').split(/\r?\n/)
  for (const line of lines) {
    const s = line.trim()
    if (!s) continue
    const cells = s.split(',').map((c) => c.trim().replace(/^"(.*)"$/, '$1'))
    const m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(cells[0] || '')
    if (!m) {
      // 表头（日期/date 开头）或注释行不计入非法行
      if (!/^(日期|date|时间)/i.test(cells[0] || '')) invalid++
      continue
    }
    const usage = Number(cells[1])
    if (!isFinite(usage) || usage < 0) { invalid++; continue }
    rows.push({ date: m[1] + '-' + p2(m[2]) + '-' + p2(m[3]), usage: usage })
  }
  return { rows, invalid }
}

// 配置变更订阅（设置页 ← 宿主）。挂件菜单改配置时，宿主 patchConfig 后调用 emitConfigChange，
// 让已打开的设置窗口同步刷新开关；否则设置页只在 onMounted 读一次，会与挂件菜单不一致。
const configListeners = []
function emitConfigChange() {
  if (!configListeners.length) return
  const cfg = readConfig()
  for (const cb of configListeners) {
    try { cb(cfg) } catch (err) { logErr('[whale][config] 订阅回调异常', err && err.message) }
  }
}

// 模型列表/主显示变化后推给挂件（挂件菜单里的「模型」分组要立即跟着变）
function pushModels() {
  sendToWidget('whale:models', getModelsPayload())
}

// GitHub 加速操作的统一包装：开 op 日志 → 跑任务 → 按「结论函数」定终态与摘要。
// 五个操作（开启/关闭/刷新/校验/检测）原本各写一遍 then/catch 样板，既要重复 opEnd，
// 又要手写「什么算成功/取消」—— 抽成一处，新增操作只需给 run + verdict 两个函数。
// verdict(res) 返回 [state, summary]，state 取 ok / fail / cancel；抛错一律记 fail。
function runGhAccelOp(title, run, verdict) {
  const op = hosts.opStart(title)
  return Promise.resolve()
    .then(() => run(op))
    .then((res) => {
      const v = verdict(res) || ['ok', '']
      if (v[0] === 'fail') logErr('[whale][ghaccel] ' + title + '失败', v[1] || '')
      else log('[whale][ghaccel] ' + title + (v[0] === 'cancel' ? '已取消' : '成功'), v[1] || '')
      hosts.opEnd(op, v[0], v[1])
      return res
    })
    .catch((err) => {
      logErr('[whale][ghaccel] ' + title + '异常', err && err.message)
      hosts.opEnd(op, 'fail', String((err && err.message) || err))
      throw err
    })
}

// ── dsh 只读诊断编排（lib/diagnostics.js 的宿主入口）──
// 顺序：命中缓存直接回 → 读环境 → 串行探测端口 → 跑五项检查 → 写缓存。
// 探测端口必须串行（probePort 内部是全局单例 + busy 标志，与状态卡共用，D15）；
// 探测失败不阻断其余项 —— detectPort 永不 reject，只会给 { failed, reason }。
//
// ⚠️ 本函数必须返回 Promise，且必须保证「一定会 settle」：
// 它由主窗 preload 的 window.services 暴露给设置页，调用发生在设置页所在的渲染进程里。
// 只要这里同步把结果算完，渲染进程就会被冻住（设置页整个卡死、按钮一直转圈）。
// 所以绝不能再安一个「同步等探测结果」的分支 —— 回调万一不回来，Promise 就永久 pending，
// 前端 finally 不会执行，「诊断中…」再也退不出来（以前就踩过这个坑）。
function diagnoseDsh(opts) {
  const o = opts && typeof opts === 'object' ? opts : {}
  const force = o.force === true
  const hit = diagnostics.readCache()
  // 判定走纯函数（diagnostics.cacheHit）：这里以前把条件手写在两处，
  // 结果设置页按钮把 force 写死成 true 就绕过了缓存，谁也没察觉
  if (diagnostics.cacheHit(hit, diagnostics.DIAGNOSE_TTL_MS, Date.now(), { force })) {
    // cached:true 让设置页知道「这是旧结果，需要重跑可点强制重跑」
    return Promise.resolve(Object.assign({}, hit, { cached: true }))
  }
  return new Promise((resolve) => {
    // 兜底闸门：detectPort 自带 8s 超时，这里再加一道，确保任何异常路径下 Promise 都会 settle，
    // 不让设置页卡在「诊断中…」。正常路径会先 resolve，settled 后兜底变成空操作
    let settled = false
    const done = (payload) => {
      if (settled) return
      settled = true
      clearTimeout(guard)
      resolve(payload)
    }
    const guard = setTimeout(() => {
      logErr('[whale][diagnostics] 诊断超时兜底（探测回调未回来）', '')
      done({ ok: false, at: Date.now(), cached: false, pass: 0, bad: 0, results: [], env: null, error: '诊断超时，请重试' })
    }, 15000)
    // readEnv 是本轮唯一的同步重活（走 dsh.snapshot()），留在探测回调之外，
    // 免得探测慢的时候把这段同步耗时叠加到用户感知的卡顿上
    diagnostics.detectPort(3080, (portState) => {
      let env
      try {
        env = diagnostics.readEnv()
      } catch (err) {
        logErr('[whale][diagnostics] 读环境失败', (err && err.message) || '')
        done({ ok: false, at: Date.now(), cached: false, pass: 0, bad: 0, results: [], env: null, error: (err && err.message) || '读环境失败' })
        return
      }
      const ctx = diagnostics.buildContext({
        home: env.home,
        nodeVersion: env.nodeVersion,
        dshVersion: env.dshVersion,
        dshSource: env.dshSource,
        profile: env.profile,
        port: 3080,
        portState: portState,
      })
      let results
      try {
        results = diagnostics.runChecks(ctx)
      } catch (err) {
        // runChecks 内部已逐项 catch，走到这里说明是遍历本身出了问题（例如 CHECKS 被改坏）。
        // 不能让设置页永远转圈，也要留痕
        logErr('[whale][diagnostics] 诊断整体失败', (err && err.message) || '')
        done({ ok: false, at: Date.now(), cached: false, pass: 0, bad: 0, results: [], env: env, error: (err && err.message) || '诊断失败' })
        return
      }
      const ordered = diagnostics.orderResults(results)
      const sum = diagnostics.summarize(ordered)
      const payload = {
        ok: diagnostics.overallOk(ordered),
        at: Date.now(),
        cached: false,
        pass: sum.pass,
        bad: sum.bad,
        results: ordered,
        env: env,
      }
      diagnostics.writeCache(payload)
      done(payload)
    })
  })
}

// ── dsh 配置转储（lib/dsh-dump.js 的宿主入口）──
// 顺序：命中缓存直接回 → 跑一次 --dump-config → 再跑 --dump-default-config → 解析归层 + diff → 写缓存。
//
// ⚠️ 与 diagnoseDsh 同一个坑：本函数由设置页渲染进程调用，**必须返回 Promise 且必须 settle**。
// 这里比诊断更危险 —— 它要 spawn 子进程，最坏 8s + 8s = 16s，所以兜底闸门给到 20s
// （比内部两道超时之和再多 4s 余量）。少了这道闸门，子进程 hang 住时设置页会永远转圈。
function dumpDshConfig(opts) {
  const o = opts && typeof opts === 'object' ? opts : {}
  const force = o.force === true
  const profile = String(o.profile || 'web')
  const hit = dshDump.readCache()
  // 与诊断同一个坑：profile 变了也必须作废缓存（否则切 profile 后读到上一个 profile 的树）
  if (diagnostics.cacheHit(hit, dshDump.DUMP_TTL_MS, Date.now(), { force, profile })) {
    return Promise.resolve(Object.assign({}, hit, { cached: true }))
  }
  return new Promise((resolve) => {
    let settled = false
    const done = (payload) => {
      if (settled) return
      settled = true
      clearTimeout(guard)
      resolve(payload)
    }
    const guard = setTimeout(() => {
      logErr('[whale][dsh-dump] 转储超时兜底（子进程回调未回来）', '')
      done({ ok: false, at: Date.now(), cached: false, profile: profile, error: '转储超时，请重试' })
    }, 20000)
    dshDump.collectDshDump({ profile: profile }, (err, payload) => {
      if (err) {
        logErr('[whale][dsh-dump] 转储失败', (err && err.message) || '')
        done({ ok: false, at: Date.now(), cached: false, profile: profile, error: (err && err.message) || String(err) })
        return
      }
      // 失败结果不写缓存：缓存了会让用户点「重新转储」也拿不到新结果
      if (payload && payload.ok) dshDump.writeCache(payload)
      done(Object.assign({}, payload, { cached: false }))
    })
  })
}

module.exports = {
  getConfig() {
    return readConfig()
  },
  // 订阅配置变更，返回退订函数（设置页 onMounted 订阅、onUnmounted 退订）
  onConfigChange(cb) {
    if (typeof cb !== 'function') return function () {}
    configListeners.push(cb)
    return function () {
      const i = configListeners.indexOf(cb)
      if (i >= 0) configListeners.splice(i, 1)
    }
  },
  emitConfigChange,
  // 任务栏「当前」状态（设置页显示）：visible = 正在占位 / hidden = 已自动收起 / none = 未识别到
  getTaskbarState() {
    try { return taskbarState() } catch (err) { return { state: 'none', edge: '', thickness: 0 } }
  },
  getVersion() {
    return PLUGIN_VERSION
  },
  // force=false 命中缓存；force=true 立即联网检查
  checkUpdate(force) {
    return checkUpdate(!!force)
  },
  // 系统默认浏览器打开外链（用于跳转下载页）
  openExternal(url) {
    try {
      utools.shellOpenExternal(String(url || ''))
      return true
    } catch (err) {
      logErr('[whale][shell] 打开外链失败', url, err && err.message)
      return false
    }
  },
  // 让 uTools 底座跳到「插件应用市场」并搜索指定关键词：
  // redirect(label) 传入非本插件指令的名称时，底座查不到已装插件会降级为「跳市场并搜索该名称」。
  // 之所以不直接用「小鲸鱼余额挂件」：用户很可能已装本插件，为避免命中自己的指令而直接打开自身，
  // 用「不可作为指令命中」的词去触发市场搜索分支。失败返回 false，由设置页兜底走浏览器详情页。
  redirectToMarket(keyword) {
    try {
      return !!utools.redirect(String(keyword || ''))
    } catch (err) {
      logErr('[whale][market] 跳转插件市场失败', keyword, err && err.message)
      return false
    }
  },
  // ──────────────────────────────────────────────
  // DeepSeek Harness（dsh，面向开发者用户）
  // ──────────────────────────────────────────────
  // 状态快照：运行中/pid/地址/模式/Node 目录与版本/错误/日志
  // 顺手触发一次端口探测（异步），这样「打开设置页/刷新状态」就能看到外部 dsh 的真实状态
  dshStatus() {
    try { dsh.probePort(() => {}) } catch (err) {}
    return dsh.snapshot()
  },
  // 轻量进度：只回 { lastCmd, log }，**不探端口**。
  // ⚠️ 安装/更新期间前端要 1Hz 刷新进度，若复用 dshStatus() 会每秒起一个 netstat 子进程 ——
  //    几分钟下来白起几百次，与进度显示毫无关系。所以单开这条零副作用的通道。
  dshProgress() {
    return dsh.progress()
  },
  dshStart() {
    return dsh.start()
  },
  dshStop() {
    return dsh.stop()
  },
  // 重启要等旧进程退出，结果通过回调异步更新（返回当前快照）
  dshRestart() {
    const cur = dsh.snapshot()
    dsh.restart(() => {})
    return cur
  },
  dshUpdate() {
    return dsh.update()
  },
  dshOpenWeb() {
    return dsh.openWeb()
  },
  // 查询可用版本列表（结果通过状态快照的 versions 字段回传，稍后刷新状态即可看到）
  dshListVersions() {
    return dsh.listVersions()
  },
  dshClearLog() {
    return dsh.clearLog()
  },
  // 删除插件目录里的那份 dsh（有全局安装时用不到它）
  dshRemovePlugin() {
    return dsh.removePluginDsh()
  },
  // 清理 npx 缓存里含 dsh 的历史副本（旧版本留下的）
  dshCleanNpxCache() {
    return dsh.cleanNpxCaches()
  },
  // ── dsh profile 写锁：孤儿锁检测（只读）与清理（用户确认后调用）──
  // 背景：dsh 的 <profile>/package.json.lock 在进程被强杀后会永久残留（上游不做回收），
  // 之后该 profile 的装/卸/更新/market 全部死锁。检测侧只读，不清算；
  // 清理侧会**重新校验**（详见 dsh.js 的 dshLockClear），不信任这里传来的旧结论。
  dshLockStale(opts) {
    return dsh.dshLockStale(opts && opts.profile)
  },
  dshLockClear(opts) {
    return dsh.dshLockClear(opts && opts.profile)
  },
  // ── dsh 插件开关（E2）：改的是用户层 profile patch（$DSH_HOME/profiles/<p>/cordis.patch.yml）──
  dshPatchList(opts) {
    return listDshPatchItems(opts)
  },
  // 切换单个条目的 disabled。**写前自动建快照**（E1），建失败就不写 ——
  // 「宁可不让用户改，也不能让改动不可撤销」：V2 已证明 dsh 对写坏的 patch 不报错
  dshPatchToggle(opts) {
    const o = opts && typeof opts === 'object' ? opts : {}
    const profile = String(o.profile || 'web')
    const id = String(o.id || '').trim()
    const disabled = o.disabled !== false
    if (!id) return { ok: false, error: '未指定插件 id' }
    // 已是目标状态时不必浪费一份快照：先 dryRun 探一下会不会真的改
    const probe = toggleDshPatchItem({ profile: profile, id: id, disabled: disabled, dryRun: true })
    if (!probe.ok) return probe
    if (!probe.changed) {
      return { ok: true, changed: false, action: probe.action, id: id, disabled: disabled, backedUp: false }
    }
    const snap = dshBackup.createSnapshot({ profile: profile, reason: disabled ? 'before-disable' : 'before-enable' })
    if (!snap.ok) {
      logErr('[whale][dsh-patch] 快照失败，已中止写入', snap.error || '')
      return { ok: false, error: '建快照失败，已中止改动：' + (snap.error || '未知错误') }
    }
    const res = toggleDshPatchItem({ profile: profile, id: id, disabled: disabled })
    return Object.assign({ backedUp: true, snapshot: snap.dirName }, res)
  },
  // ── dsh 一键隔离（E3）：列候选 + 批量禁用，**写前自动建一份快照** ──
  // 候选清单是 Promise：要 spawn 一次 dump 才知道组装树里有哪些真实存在的插件条目
  dshIsolateCandidates(opts) {
    return listDshIsolateCandidates(opts)
  },
  // 批量禁用。opts.dryRun=true 时**只算不写**：界面据此把「会动哪几行」交给用户过目再确认
  dshIsolateApply(opts) {
    const o = opts && typeof opts === 'object' ? opts : {}
    const profile = String(o.profile || 'web')
    const dryRun = o.dryRun === true
    const probe = isolateDshPlugins({ profile: profile, ids: o.ids, dryRun: true })
    if (!probe.ok) return probe
    // 一条都不会变时不必浪费一份快照（与 dshPatchToggle 同一取舍）
    if (dryRun || !probe.changed) return probe
    const snap = dshBackup.createSnapshot({ profile: profile, reason: 'before-isolate' })
    if (!snap.ok) {
      logErr('[whale][dsh-isolate] 快照失败，已中止写入', snap.error || '')
      return { ok: false, error: '建快照失败，已中止隔离：' + (snap.error || '未知错误') }
    }
    const res = isolateDshPlugins({ profile: profile, ids: o.ids })
    return Object.assign({ backedUp: true, snapshot: snap.dirName }, res)
  },
  // ── dsh 插件市场（见 lib/dsh-market.js）──
  // 目录数据是**派生缓存**：dbStorage 那份只当离线兜底，抓失败也照样返回内容 + from:'cache'，
  // 让界面能显示「这是上次的目录（抓取失败：…）」，而不是一片空白
  dshMarketCatalog(opts) {
    return marketCatalog(opts)
  },
  // 已装状态 + 哪些是本卡装的。opts = { profile? }
  dshMarketStatus(opts) {
    return marketStatus(opts)
  },
  // 给各镜像源测延迟（界面用来「自动选最快的」）。opts = { registries? }
  dshMarketPing(opts) {
    return marketPing(opts)
  },
  // 内置镜像源清单：界面据此渲染选项，避免前后端各写一份常量对不上（同步返回）
  dshMarketRegistries() {
    return dshMarket.MIRROR_REGISTRIES.slice()
  },
  // 装一个插件：dryRun 只算不写（界面拿到「准备执行什么」给用户过目）；
  // 真写时**先建快照**，pnpm 跑完**回读 package.json** 核验依赖真的出现了（V2 的教训）
  dshMarketInstall(opts) {
    return marketInstall(opts)
  },
  // 卸一个插件。opts.remove=true = 连带删磁盘文件（pnpm remove）；
  // false/缺省 = **只加一行 disabled: true 禁用**，包留在磁盘上（可随时启用回来）
  dshMarketUninstall(opts) {
    return marketUninstall(opts)
  },
  // 检查已装插件有没有新版（**要目录数据**，所以只在目录已加载后才调）。
  // opts = { profile?, catalog? } —— catalog 由界面把已拿到的目录原样传回来，这里不自己联网
  dshMarketCheckUpdates(opts) {
    return marketCheckUpdates(opts)
  },
  // ⚠️ 回源 registry 查**官方最新版**（**会联网**，纯手动，目录数据不作数）。
  // 目录是每日快照，里面那份 version 可能已落后于 registry —— 界面每行给一个按钮，
  // 用户点了才发请求。opts = { items: [{ pkg, key }], registry? }
  dshMarketRegistryLatest(opts) {
    return marketRegistryLatest(opts)
  },
  // 更新一个已装插件：按目录 spec 重装（不是 pnpm update，见 marketUpdate 注释）。
  // dryRun 只算不写；真写与安装同链路：快照 → pnpm add → 回读核验
  dshMarketUpdate(opts) {
    return marketUpdate(opts)
  },
  // 查一批目录条目与**当前宿主 DSH** 的兼容性（见 lib/dsh-host-compat.js）。
  // opts = { entries?: {name, spec}[], packages?: string[], registry? }
  //
  // ⚠️ 只查能把 spec 剥出**裸 npm 包名**的条目（github / tarball 来源判不了，直接返 unknown 不发请求）：
  //    目录里 48.6% 的条目 npm 字段是 null，硬查只会拿到 404 → 满屏错误的「不兼容」。
  // ⚠️ 拿不到宿主版本时**整体短路**、不联网：没有宿主版本，任何兼容性结论都是编的。
  // 返回 { ok, host, results: { <目录条目名>: {status, reason, requirement, package} } }
  dshHostCompatCheck(opts) {
    const o = opts && typeof opts === 'object' ? opts : {}
    const host = hostDshVersion()
    const entries = Array.isArray(o.entries) ? o.entries : []
    const results = Object.create(null)
    // 显式给了包名数组就照单全收（第四层「翻页自动拉」用这条路径）
    const asked = Array.isArray(o.packages) ? o.packages.map((x) => String(x || '').trim()).filter(Boolean) : []
    if (asked.length) {
      if (!host) {
        for (const p of asked) results[p] = { status: 'unknown', reason: 'no-host-version', requirement: '', package: p }
        return { ok: true, host: '', results: results }
      }
      const registry = String(o.registry || cfgRegistry() || dshMarket.MIRROR_REGISTRY)
      return dshHostCompat.lookup(asked, { registry: registry }).then((res) => {
        for (const p of asked) {
          // ⚠️ 缺键（理论上 lookup 每个包都给值，但防御一下）按「没拉到」记，
          //    不能落成 null —— null 在判定层是「拉到了但没声明」，会把网络问题说成插件没要求
          const facts = res && res.facts && p in res.facts ? res.facts[p] : dshHostCompat.UNAVAILABLE
          const v = dshHostCompat.deriveHostCompatibility(facts, host, dshMarket.rangeAllows)
          results[p] = { status: v.status, reason: v.reason, requirement: v.requirement, package: p }
        }
        return { ok: true, host: host, results: results }
      })
    }
    // 没给包名：从目录条目里现算（能判的才发请求，判不了的当场给 unknown）
    const byPkg = Object.create(null)
    const todo = []
    for (const e of entries) {
      const entry = e && typeof e === 'object' ? e : {}
      const key = String(entry.name || entry.spec || entry.npm || '')
      if (!key) continue
      const pkg = marketPkgNameOf(entry)
      if (!pkg) { results[key] = { status: 'unknown', reason: host ? 'undeclared' : 'no-host-version', requirement: '', package: '' }; continue }
      byPkg[pkg] = byPkg[pkg] || []
      byPkg[pkg].push(key)
      todo.push(pkg)
    }
    if (!host || !todo.length) {
      for (const key of Object.keys(results)) results[key] = Object.assign({}, results[key], { status: 'unknown', reason: host ? results[key].reason : 'no-host-version' })
      return Promise.resolve({ ok: true, host: host, results: results })
    }
    const registry = String(o.registry || cfgRegistry() || dshMarket.MIRROR_REGISTRY)
    return dshHostCompat.lookup(todo, { registry: registry }).then((res) => {
      for (const pkg of Object.keys(byPkg)) {
        // 同上：缺键按「没拉到」记，别落成 null（null = 拉到了但没声明）
        const facts = res && res.facts && pkg in res.facts ? res.facts[pkg] : dshHostCompat.UNAVAILABLE
        const v = dshHostCompat.deriveHostCompatibility(facts, host, dshMarket.rangeAllows)
        for (const key of byPkg[pkg]) results[key] = { status: v.status, reason: v.reason, requirement: v.requirement, package: pkg }
      }
      return { ok: true, host: host, results: results }
    })
  },
  // 当前宿主的 DSH 版本（界面用来显示「按 vX 判定」以及决定要不要发请求）
  dshHostVersion() {
    return hostDshVersion()
  },
  // allowBuilds 引导信息的解析（纯函数，单测直接喂 dsh 真实报错原文）：
  // 那把 key 带 commit hash、安装前拿不到，只能从失败输出里抠 —— 抠错会引导用户写错 key
  parseAllowBuilds(text) {
    return parseAllowBuilds(text)
  },
  // 版本降级判定（纯函数，单测直接喂 from/to 版本号）：
  // 与 blockedByPolicy 是相反方向的两个静默失败，判错方向会让用户看到「已更新 v1.48.0 → v1.40.0」
  downgradedBy(from, to) {
    return downgradedBy(from, to).downgraded
  },
  // 装完的版本是否**低于**目录目标（纯函数）：
  // 高于目标不算错（镜像源抢先发版是好事），只有低于才算「没装到位」
  mismatchResolved(target, actual) {
    return mismatchResolved(target, actual).mismatch
  },
  // 原生命令输出截尾（纯函数，单测直接喂长文本）：
  // 按**行**保留而不是按字符，因为最后一行往往就是错误码那行，按字符切会把它切半
  tailLines(text, maxLines) {
    return tailLines(text, maxLines)
  },
  // 快照列表 / 还原（E1 的 dsh-backup 透传）
  dshBackupList() {
    return listDshBackups()
  },
  dshBackupRestore(opts) {
    const o = opts && typeof opts === 'object' ? opts : {}
    try {
      return dshBackup.restoreSnapshot(o)
    } catch (err) {
      logErr('[whale][dsh-backup] 还原失败', (err && err.message) || '')
      return { ok: false, error: '还原失败：' + ((err && err.message) || err) }
    }
  },
  dshBackupRemove(dirName) {
    try {
      return dshBackup.removeSnapshot(dirName)
    } catch (err) {
      logErr('[whale][dsh-backup] 删除快照失败', (err && err.message) || '')
      return { ok: false, error: '删除失败：' + ((err && err.message) || err) }
    }
  },
  // 手动建快照（界面上的「立即备份」）。o.name 可给个名字（E4），给了就是「手动命名的备份」→ 不受轮转
  dshBackupCreate(opts) {
    const o = opts && typeof opts === 'object' ? opts : {}
    try {
      return dshBackup.createSnapshot({ profile: String(o.profile || 'web'), reason: 'manual', name: o.name })
    } catch (err) {
      logErr('[whale][dsh-backup] 建快照失败', (err && err.message) || '')
      return { ok: false, error: '备份失败：' + ((err && err.message) || err) }
    }
  },
  // 标记 / 命名（E4）：只改 meta.json，不碰快照内容
  dshBackupSetMeta(opts) {
    const o = opts && typeof opts === 'object' ? opts : {}
    try {
      return dshBackup.setMeta(o)
    } catch (err) {
      logErr('[whale][dsh-backup] 更新快照标记失败', (err && err.message) || '')
      return { ok: false, error: '更新标记失败：' + ((err && err.message) || err) }
    }
  },
  // 按保留份数清理一次（E4：调小保留份数后手动触发，不必等下次建快照）
  //
  // ⚠️ o.keep 是**本次清理的临时份数**，只影响这一次、**不写配置**（写配置是 dshBackupSetKeep 的事）。
  //    修的真实 bug（2026-09-24 用户报「立即清理功能存在问题」）：早先这里恒用 retentionKeep()
  //    （= 已保存的配置值），于是「把输入框改成 2 → 不点保存 → 直接点立即清理」会拿**旧的 20** 去清，
  //    什么都不删还提示「没有超出保留份数」，用户看到的现象就是「立即清理不工作」。
  //    清理是用户的即时意图，按眼前那个数字执行才符合直觉；clamp 与 setKeep 同一套边界。
  dshBackupPrune(opts) {
    const o = opts && typeof opts === 'object' ? opts : {}
    try {
      const keep = o.keep === undefined
        ? dshBackup.retentionKeep()
        : Math.round(clampNum(o.keep, dshBackup.KEEP_MIN, dshBackup.KEEP_MAX, dshBackup.MAX_SNAPSHOTS))
      return { ok: true, keep: keep, removed: dshBackup.pruneSnapshots({ keep: keep }) }
    } catch (err) {
      logErr('[whale][dsh-backup] 清理快照失败', (err && err.message) || '')
      return { ok: false, error: '清理失败：' + ((err && err.message) || err) }
    }
  },
  // 改保留份数（E4）：写进配置，**不立即删**（删除等用户点「清理」或下次建快照）。
  // why 不顺手 prune：用户可能只是想把数字调小看看，立刻删掉快照太粗暴；
  // 而且「调小 → 确认要清」之间给一次后悔的机会。
  dshBackupSetKeep(n) {
    const v = Math.round(clampNum(n, dshBackup.KEEP_MIN, dshBackup.KEEP_MAX, dshBackup.MAX_SNAPSHOTS))
    try {
      const cfg = patchConfig({ dshBackupKeep: v })
      if (!cfg) return { ok: false, error: '保存设置失败' }
      // 配置返回体里没有 dshBackupKeep 字段时以我们算出的 v 为准（前后端同一套 clamp）
      return { ok: true, keep: typeof cfg.dshBackupKeep === 'number' ? cfg.dshBackupKeep : v }
    } catch (err) {
      logErr('[whale][dsh-backup] 保存保留份数失败', (err && err.message) || '')
      return { ok: false, error: '保存失败：' + ((err && err.message) || err) }
    }
  },
  // ──────────────────────────────────────────────
  // dsh 全量导出（lib/dsh-export.js）
  //
  // ⚠️ 与上面 dshBackup* 的分工：那组是**快照**（白名单 3 文件 / 为了回滚 patch）；
  // 这组是**导出**（全量 / 为了打包带走）。两者并存，别互相替代。
  // ──────────────────────────────────────────────
  // 导出前预检：不写盘，只回报「会备多少 / 会排除什么」，尤其要让用户先看到凭据被排除
  //
  // running 字段：探测 3080 上有没有 dsh，供界面提示「先退出 dsh 再导出」。
  // why 要提示：会话文件（JSONL）是**追加写**的，边跑边读可能读到半条记录；且导出前后
  // 文件集在变，包内容不自洽。另外 dsh 若正在写 patch，导出的配置也可能是中间态。
  //
  // ⚠️ 为什么不新增 IPC 通道：本项目 3080 探测已有现成的 dsh.probePort + dsh.snapshot
  //     （诊断 / 状态卡都在用），这里只是把结论顺带塞进预览结果 —— 符合 D14「不重复造能力」。
  // ⚠️ 为什么不自己起 netstat：probePort 内部有全局单例 + busy 排队 + 6s 超时 + 父链归属
  //     判定（Windows 下 spawn 有 cmd 中间层），自己再写一份必然与状态卡口径漂移。
  // ⚠️ 探测是异步的（netstat 要 100–300ms），但 previewExport 是同步的纯文件统计 ——
  //     所以**先给同步结果，探测完再回填**，不让用户为一句提示多等一次。返回 Promise，
  //     调用方（设置页）本来就走 await/可选链，同步返回的结构照常可用。
  dshExportPreview(opts) {
    const o = opts && typeof opts === 'object' ? opts : {}
    let base
    try {
      base = dshExport.previewExport({ includeCred: o.includeCred === true, skipModules: o.skipModules !== false })
    } catch (err) {
      logErr('[whale][dsh-export] 预检失败', (err && err.message) || '')
      return { ok: false, error: '预检失败：' + ((err && err.message) || err) }
    }
    // 探测失败（拿不到端口信息）时不写 running 字段 —— 界面据此显示「无法确认」而不是
    // 谎报「没在跑」。宁可少一句提示，也不能让用户以为可以放心导
    return new Promise((resolve) => {
      let settled = false
      const finish = (info) => {
        if (settled) return
        settled = true
        resolve(Object.assign({}, base, { running: info }))
      }
      // 探测自身的超时兜底：probePort 是 6s，这里再兜一层防它回调不回来（诊断模块同款做法）
      const timer = setTimeout(() => finish(null), 8000)
      try {
        dsh.probePort(() => {
          clearTimeout(timer)
          try {
            const snap = dsh.snapshot()
            // 三种「在跑」都算：
            //   · snap.running   —— 本插件启的那份在跑
            //   · snap.external  —— 别的终端里跑的 dsh（externalPid 内部已做命令行判定）
            //   · snap.ready     —— 本插件这份已开始监听（running 为真时一般也成立，兜底）
            const running = !!(snap.running || snap.external || snap.ready)
            finish({
              running: running,
              // pid / 名字只在「确定有」时才给：真 dsh 的判据由 dsh.js 统一持有，
              // 这里不自己判一遍，避免两处口径漂移（诊断模块的教训）
              pid: running ? (Number(snap.portPid) || Number(snap.externalPid) || Number(snap.pid) || 0) : 0,
              name: String(snap.portName || snap.externalName || ''),
              // 端口被**非 dsh** 程序占用：也有写文件风险，但性质不同（不是 dsh 在写），
              // 所以单独给字段让界面用不同措辞，不与「dsh 在跑」混为一谈
              other: String(snap.portOther || ''),
              self: !!snap.running,
            })
          } catch (err) {
            logErr('[whale][dsh-export] 读取 dsh 运行状态失败', (err && err.message) || '')
            finish(null)
          }
        })
      } catch (err) {
        clearTimeout(timer)
        logErr('[whale][dsh-export] dsh 运行探测调用失败', (err && err.message) || '')
        finish(null)
      }
    })
  },
  // 导出全量包。outPath 为空时弹保存对话框（与 assets.exportAssets 同一套路）。
  // includeCred 由界面勾选决定 —— 宿主不做「默认包含」这种隐式行为
  dshExportCreate(opts) {
    const o = opts && typeof opts === 'object' ? opts : {}
    const includeCred = o.includeCred === true
    let outPath = String(o.outPath || '').trim()
    if (!outPath) {
      const home = dshExport.dshHome()
      if (!home) return { ok: false, error: '找不到 dsh 配置目录（$DSH_HOME 与 ~/.dsh 都不存在）' }
      try {
        outPath = utools.showSaveDialog({
          title: '导出 dsh 全量备份',
          defaultPath: path.join(String(utools.getPath('downloads') || ''), 'dsh-backup-' + dshExport.stampOf() + '.zip'),
          filters: [{ name: 'Zip 压缩包', extensions: ['zip'] }],
        })
      } catch (err) {
        return { ok: false, error: '无法打开保存对话框：' + ((err && err.message) || err) }
      }
      if (!outPath) return { ok: false, canceled: true, error: '' }
    }
    // 用户手输的名字可能没有 .zip 后缀，补上（保存对话框的 filters 只做过滤、不强制后缀）
    if (!/\.zip$/i.test(outPath)) outPath += '.zip'
    try {
      return dshExport.exportAll({ outPath: outPath, includeCred: includeCred, skipModules: o.skipModules !== false })
    } catch (err) {
      logErr('[whale][dsh-export] 导出失败', (err && err.message) || '')
      return { ok: false, error: '导出失败：' + ((err && err.message) || err) }
    }
  },
  // 在文件管理器里定位导出包（导出成功后让用户一眼找到它）
  dshExportReveal(outPath) {
    const p = String(outPath || '').trim()
    if (!p) return { ok: false, error: '未指定文件' }
    try {
      utools.shellShowItemInFolder(p)
      return { ok: true }
    } catch (err) {
      logErr('[whale][dsh-export] 打开所在文件夹失败', (err && err.message) || '')
      return { ok: false, error: '打开失败：' + ((err && err.message) || err) }
    }
  },
  // 选择 Node.js 安装目录并校验（目录里必须有 node 可执行文件）
  dshPickNodeDir() {
    let picked
    try {
      picked = utools.showOpenDialog({
        title: '选择 Node.js 安装目录',
        buttonLabel: '选择',
        properties: ['openDirectory'],
      })
    } catch (err) {
      logErr('[whale][dsh] 打开 Node 目录选择框失败', (err && err.message) || '')
      return { ok: false, error: '无法打开目录选择框：' + ((err && err.message) || err) }
    }
    const dir = Array.isArray(picked) ? picked[0] : picked
    if (!dir) return { ok: false, canceled: true }
    if (!dsh.nodeInDir(dir)) {
      return { ok: false, error: '该目录下没有 node 可执行文件，请选择 Node.js 的安装目录（如 D:\\nodejs）' }
    }
    return { ok: true, dir: dir }
  },
  // ──────────────────────────────────────────────
  // GitHub 加速（hosts 方案，见 lib/hosts.js；纯设置页功能，不做新 IPC）
  // ──────────────────────────────────────────────
  // 实际状态：读 hosts 文件现算（块存在 = 生效），不依赖配置里的开关意图
  ghAccelStatus() {
    return hosts.ghAccelStatus()
  },
  // 可选的社区源表清单（含默认顺序）：设置页要按这份清单渲染「自定义源表优先级」，
  // 不能在前端再抄一份 URL —— 源清单是 hosts 模块的领域知识，抄一份必然随版本漂移
  ghAccelSources() {
    return hosts.ghAccelSources()
  },
  // 最近一次 IP 获取的来源追踪（内存态）：每个域名最终 IP 从哪来（DoH/社区源表/当前表/兜底）
  ghAccelTrace() {
    return hosts.ghAccelTrace()
  },
  // 操作日志（内存态，最多 50 条）：一次操作 = 一条，含步骤与结果，供设置页「GitHub 加速日志」回看
  ghAccelOpLogs() {
    return hosts.ghAccelOpLogs()
  },
  // 清空操作日志（返回清掉的条数）。不写成一次 op：清日志本身记进日志会立刻又冒出一条，自相矛盾
  ghAccelClearOpLogs() {
    return { cleared: hosts.clearGhAccelOpLogs() }
  },
  // 块外已存在的目标域名条目（其它工具也写 hosts 时会覆盖本插件）
  ghAccelScanConflicts() {
    return hosts.scanConflicts()
  },
  // 开启/关闭：写标记块要 UAC 提权，返回 Promise；refresh=true 时开启前先静默刷新 GitHub520 并探测只写可达 IP
  ghAccelEnable(ips, refresh) {
    // 来源开关与优先级顺序随开启一起下发：用户在「获取方式」里改过设置后就该本次生效，不必重新勾选。
    // 读的是当前配置（cfg.ghAccelSrc），而非前端传参 —— 前端只负责改配置，hosts 写块时以配置为准，
    // 避免前端漏传导致「开关关了但没生效」
    const src = (readConfig().ghAccelSrc) || {}
    return runGhAccelOp(
      // 标题不再写「先刷新 IP 表」：刷新现在与探测**并行**跑，源只作补测，不再是前置串行步骤
      refresh ? '开启 GitHub 加速（并行刷新 IP 表）' : '开启 GitHub 加速 / 重新写入 hosts',
      (op) => hosts.enable(ips, { refresh: refresh, src: src }, op),
      (res) => {
        if (!res.ok) return res.canceled ? ['cancel', 'UAC 弹窗被取消，hosts 未改动'] : ['fail', res.error]
        // r.ips 是回写入配置的「用户表内」IP 条数，与真正写进 hosts 的行数不同
        // （hosts 里有同域名多行的备用 IP 与兜底候选），文案按域名数说更贴近用户认知
        const n = res.ips ? new Set(res.ips.map((it) => it.domain)).size : 0
        const rows = res.ips ? res.ips.length : 0
        return ['ok', n + ' 个域名已写入 hosts（共 ' + rows + ' 条，含备用 IP 回退），浏览器 / git / 下载立即生效']
      }
    )
  },
  ghAccelDisable() {
    return runGhAccelOp('关闭 GitHub 加速（移除 hosts 标记块）', (op) => hosts.disable(op), (res) => {
      if (!res.ok) return res.canceled ? ['cancel', 'UAC 弹窗被取消，标记块仍在'] : ['fail', res.error]
      return ['ok', res.already ? 'hosts 里本就没有本插件的块，无需改动' : '标记块已移除，hosts 还原为开启前的内容']
    })
  },
  // 一键刷新 IP 表（走与开启同一套候选链：DoH 实时解析 + 社区源）；current 传当前表。
  // 候选链给的 IP 探测不通时，**当前表的旧值也要复验一遍**：旧值同样可能是失效死地址，
  // 复验通过才沿用，不通过就**不写这个域名**（宁可让系统回落到 DNS 真实解析，也不写一条死映射）。
  // src.sources 与 src.order 都必须从配置读后传入：不传则 hosts 内部退回内置默认顺序，
  // 用户在「来源优先级 / 社区源表优先级」里排的序就白设了 —— 而「开启加速」走 hosts.enable
  // 是传了的，两条路径行为不一致会让用户以为「优先级时灵时不灵」
  // （旧版的坑更隐蔽：这里从不传 order，refreshIps 也从不解析 DoH，用户把 DoH 排第一
  // 却看到日志只报「拉取社区源 … 成功」，设置完全没生效）
  ghAccelRefreshIps(current) {
    const src = (readConfig().ghAccelSrc) || {}
    // 标题里的来源链**按用户实际设置动态生成**：原来写死「DoH 实时解析 + 社区源」，
    // 用户关掉 DoH 或调换顺序后标题仍照旧，等于在日志里误导「这一步做了什么」
    return runGhAccelOp('刷新 IP 表（按来源优先级取 ' + hosts.srcChainLabel(src.order, src) + '）',
      (op) => hosts.refreshIps(current, op, src.sources, src.order, src.customSources), (res) => {
      if (!res.ok) return ['fail', res.error]
      return ['ok', 'IP 表已更新为 ' + res.updated.length + ' 条'
        + (res.unreachable ? '，其中 ' + res.unreachable + ' 个候选 IP 探测不通' : '')
        + (res.dropped ? '、' + res.dropped + ' 个旧值复验也不通已放弃写入' : '')
        + '；需点「重新写入 hosts」才会对系统生效']
    })
  },
  // 校验当前 IP 表：逐条探测，返回 { results, bad, stale }。只给结论不删表，删除由设置页确认后走 saveConfig
  ghAccelVerifyIps(ips) {
    return runGhAccelOp('校验 IP 表可用性', (op) => hosts.verifyIps(ips, op), (res) => {
      const good = res.results.length - res.bad.length - res.stale.length
      return ['ok', '共 ' + res.results.length + ' 条：可用 ' + good + ' 条，不可用 ' + res.bad.length
        + ' 条' + (res.stale.length ? '，待复查 ' + res.stale.length + ' 条（探测失败但仍是当前 DNS 解析结果）' : '')]
    })
  },
  // 连通性自检（HEAD https://github.com），开启前后各测一次做对比
  ghAccelProbe() {
    return runGhAccelOp('检测 GitHub 连接', (op) => hosts.probeConnectivity(op), (res) =>
      res.ok
        ? ['ok', 'github.com 可达，HTTP ' + res.status + '，耗时 ' + res.ms + 'ms']
        : ['fail', '无法访问 github.com：' + (res.error || '未知错误')])
  },
  saveConfig(patch) {
    // 设置页拖动滑块中的实时预览：只改窗口几何（rAF 合帧），不写存储、不广播
    if (patch && patch.__live) {
      queueLiveScale(patch.scale)
      return readConfig()
    }
    const prev = readConfig()
    const cfg = patchConfig(patch)
    // 关掉「计时保存」时顺手清掉已落库的计时状态，避免下次重建挂件又恢复
    if (cfg.timerPersistOn === false && prev.timerPersistOn !== false) clearTimer()
    if (cfg.scale !== prev.scale) applyScaleToWindow(cfg.scale, true)
    // 「自动避让任务栏」或四边间距变了：按当前锚点重摆一次，立刻能看到效果
    if (cfg.avoidTaskbar !== prev.avoidTaskbar
      || cfg.edgeTop !== prev.edgeTop || cfg.edgeRight !== prev.edgeRight
      || cfg.edgeBottom !== prev.edgeBottom || cfg.edgeLeft !== prev.edgeLeft
      || cfg.scrollGapOn !== prev.scrollGapOn || cfg.scrollGapPx !== prev.scrollGapPx) {
      repositionFromAnchor()
    }
    if (cfg.avoidTaskbar !== prev.avoidTaskbar) syncTaskbarWatch()
    if (cfg.onTop !== prev.onTop) applyOnTop(cfg.onTop)
    if (cfg.usageMode !== prev.usageMode) resetBalanceCache()
    pushConfig()
    // 反向回推给设置页：saveConfig 是设置页自己调的，但设置页的 cfg 不一定等于落库结果 ——
    // 宿主 patchConfig 会做归一化（补齐 / 钳范围 / 清洗），不回推的话设置页手里的还是它自己拼的
    // 那份「未归一化」的值。取消订阅后再回推会打断「配置 → 订阅 → 回推」的闭环
    emitConfigChange()
    return cfg
  },
  getSecrets() {
    return readSecrets()
  },
  // 是否需要弹「首次运行引导」：配置里的 guideDone 没置位，且凭据里还没填 API Key。
  // 之所以两个条件都要判：老用户升级上来 guideDone 虽为 false（配置里本就没这个键），
  // 但 API Key 早已填好，不该被再引导一次；而新装用户两者都满足。
  needFirstRunGuide() {
    return readConfig().guideDone !== true && !readSecrets().apiKey
  },
  // 结束首次运行引导：无论用户是「保存凭据」还是「跳过」，都置位 guideDone，之后不再弹
  finishFirstRunGuide() {
    patchConfig({ guideDone: true })
    return readConfig().guideDone
  },
  saveSecrets(secrets) {
    const next = Object.assign(readSecrets(), secrets || {})
    writeSecrets(next)
    resetBalanceCache() // 密钥变更后强制重新拉取
    return { hasApiKey: !!next.apiKey, hasPlatformToken: !!next.platformToken }
  },
  // 邮件通知的凭据（SMTP 服务器/端口/账号/授权码）：单独一个入口，因为它进的是加密存储，
  // 而 saveSecrets 的调用方（备份恢复/DeepSeek 密钥卡）只会传 apiKey/platformToken。
  // 另外 notifyMail 传 undefined 会被 writeSecrets 判为「沿用现值」—— 设置页每次提交的是完整对象，不受影响。
  saveMailSecrets(mail) {
    const cur = readSecrets()
    const m = mail && typeof mail === 'object' ? mail : {}
    // 授权码留空 = 沿用已保存的（设置页回填的是掩码，用户没重新输入时不能当成「清空」）
    if (m.mailPass === undefined || m.mailPass === '') m.mailPass = cur.notifyMail.mailPass
    writeSecrets(Object.assign({}, cur, { notifyMail: m }))
    return readSecrets().notifyMail
  },
  // 发一封测试邮件：直接使用传入的 SMTP 配置（设置页「保存前先测一下」的场景），
  // 不落库、不动余额缓存。返回 { ok } 或 { ok:false, error }，错误原样给用户看
  async sendTestMail(mail) {
    const cur = readSecrets()
    const m = Object.assign({}, mail || {})
    if (m.mailPass === undefined || m.mailPass === '') m.mailPass = cur.notifyMail.mailPass
    // 发件人/收件人来自配置（非明文凭据区）。设置页会随参数带过来；这里退回读配置，
    // 免得「表单填了但漏传」时只得到一句「发件邮箱格式不正确」，看不出该去哪儿补
    if (!m.mailFrom) m.mailFrom = readConfig().mailFrom
    if (!m.mailTo) m.mailTo = readConfig().mailTo
    if (!String(m.mailFrom || '').trim()) return { ok: false, error: '还没填「发件人」，请在下方配置区补上（一般与账号一致）' }
    if (!String(m.mailTo || '').trim()) return { ok: false, error: '还没填「收件人」，请在下方配置区补上' }
    const body = '这是一封来自小鲸鱼余额挂件的测试邮件。\n\n收到它说明邮件通知已配置成功，' +
      '之后低余额、今日预算、余额大幅波动、计时到点等提醒都会发到这里。'
    return sendMail(m, mailSubject(body), body)
  },
  // 通知渠道自测：按当前开着的渠道各送一条，让用户确认「开关 + 配置」真的能送达。
  // 系统通知走同一条 notifySystem（同步），邮件走 sendMailAsync（异步、要等服务器回包），
  // 因此两者分开回执。刻意不做 notify 那套「每天一次」去重 —— 点一下就该有一条
  async testNotify() {
    const cfg = readConfig()
    const body = '这是一条来自小鲸鱼余额挂件的测试通知。\n\n看到它说明通知渠道配置成功，' +
      '之后低余额、今日预算、余额大幅波动、计时到点等提醒都会从这里送达。'
    if (cfg.notifyMailOn === true && (!String(cfg.mailFrom || '').trim() || !String(cfg.mailTo || '').trim())) {
      return { ok: false, on: [], error: '邮件通知已开，但「发件人 / 收件人」还没填，请先在下方补上' }
    }
    // 邮件走 sendMailAsync —— 与自动提醒**同一条**路径，这样测通了就一定能收到真实提醒。
    // 早先这里另拼一份参数，结果漏了收件人，测出来「失败」而实际配置是好的
    let mail = null
    if (cfg.notifyMailOn === true) {
      mail = sendMailAsync(cfg, body)
    }
    const on = []
    let sysOk = false
    if (cfg.notifySystemOn !== false) {
      try { sysOk = notifySystem('测试通知：通知渠道正常') === true } catch (err) { sysOk = false }
      on.push('系统通知')
    }
    if (mail) on.push('邮件')
    if (!on.length) return { ok: false, on, error: '系统通知与邮件通知都关着，没有可测试的渠道' }
    if (mail) {
      const r = await mail
      if (!r.ok) return { ok: false, on, system: sysOk, error: r.error }
    }
    return { ok: true, on, system: sysOk }
  },
  // 用给定 API Key 直接验证（不落库）
  testApiKey(apiKey) {
    return fetchBalanceWith(String(apiKey || '').trim())
  },
  // 用给定平台 Token 直接验证用量接口（不落库）：成功返回 { amount, tokens }，失败返回 { error }
  testPlatformToken(platformToken) {
    return fetchPlatformUsage(String(platformToken || '').trim(), readConfig().tokenPrice).then((r) => {
      // 「今日无用量」说明接口已连通，不算失败
      if (r && r.error === 'no usage') return { amount: 0, tokens: 0, empty: true }
      return r
    })
  },
  // 近 N 天用量（含今日，缺失日期补 0），供设置页趋势图
  getUsageHistory(days) {
    return usageDays(days)
  },
  // 账本明细（近 N 天每日用量 + 当天的异常变动/校准记录），供设置页「账本明细」展开查看
  getUsageDetail(days) {
    return usageDetail(days)
  },
  // 今日各模型金额占比（按金额降序），供设置页「今日模型占比」。只走令牌模式：
  // 记账模式只有总额没有模型明细（余额接口不给），返回 error 由页面提示。
  getTodayModels() {
    const token = readSecrets().platformToken
    if (!token) return Promise.resolve({ ok: false, error: '未配置平台 Token' })
    return fetchPlatformUsage(token, readConfig().tokenPrice).then((r) => {
      if (r && r.error) return { ok: false, error: r.error }
      return {
        ok: true,
        models: (r && r.byModel) || [],
        amount: (r && r.amount) || 0,
        tokens: (r && r.tokens) || 0,
      }
    })
  },
  // 手动校准今日已用（记账模式）：只改当天累计、留校准记录，不动余额基准
  calibrateTodayUsage(amount) {
    return calibrateTodayUsage(amount)
  },
  // —— 多厂商模型（余额 / 额度）——
  // 列表（含内置 DeepSeek 那条）+ 当前主显示模型，供设置页与挂件菜单渲染
  getModels() {
    return getModelsPayload()
  },
  // 厂商模板表：设置页「添加模型」时按模板预填字段路径与接口地址
  getModelTemplates() {
    return { templates: MODEL_TEMPLATES, max: MODEL_MAX, mainModelId: DEFAULT_MAIN_MODEL }
  },
  // 完整模型配置（含接口地址与字段路径）：设置页行内编辑要原样回填。
  // getModels() 的载荷是给挂件显示用的，只有余额/额度几个字段，回填会丢配置。
  getModelsConfig() {
    return readConfig().models
  },
  // 新增 / 编辑一个模型。key 传 undefined 表示「不动密钥」（编辑时用户可能不改）；
  // 传空串表示清空该模型的密钥。
  saveModel(model, key) {
    const m = normModel(model)
    if (!m) return { ok: false, error: '模型 ID 无效' }
    const cfg = readConfig()
    const list = cfg.models.slice()
    const i = list.map((x) => x.id).indexOf(m.id)
    if (i < 0 && list.length >= MODEL_MAX) {
      return { ok: false, error: '最多添加 ' + MODEL_MAX + ' 个模型' }
    }
    if (i < 0) list.push(m)
    else list[i] = m
    patchConfig({ models: list })
    if (key !== undefined) {
      // writeSecrets 是「整体重建」，这里必须带上原有 apiKey/platformToken，
      // 否则只改一个模型密钥会把 DeepSeek 的密钥一起清掉
      const cur = readSecrets()
      const models = Object.assign({}, cur.models)
      const k = sanitizeKey(key)
      if (k) models[m.id] = k
      else delete models[m.id]
      writeSecrets({ apiKey: cur.apiKey, platformToken: cur.platformToken, models: models })
    }
    pushModels()
    return { ok: true, id: m.id, hasKey: !!readSecrets().models[m.id] }
  },
  // 删除模型：同时清掉运行时状态与密钥槽位；被删的是主显示时回退 DeepSeek
  removeModel(id) {
    const mid = normModelId(id)
    if (!mid) return { ok: false, error: '模型 ID 无效' }
    const cfg = readConfig()
    // models 先于 mainModelId 处理：列表里已没有这个 id，主显示会自动回退
    patchConfig({ models: cfg.models.filter((m) => m.id !== mid), mainModelId: cfg.mainModelId })
    dropModelState(mid)
    const cur = readSecrets()
    const models = Object.assign({}, cur.models)
    delete models[mid]
    writeSecrets({ apiKey: cur.apiKey, platformToken: cur.platformToken, models: models })
    pushModels()
    return { ok: true }
  },
  // 切换挂件主显示的模型（'deepseek' 为内置）
  setMainModel(id) {
    const cfg = readConfig()
    const mid = normModelId(id) || DEFAULT_MAIN_MODEL
    if (mid !== DEFAULT_MAIN_MODEL && !cfg.models.some((m) => m.id === mid)) {
      return { ok: false, error: '模型不存在' }
    }
    patchConfig({ mainModelId: mid })
    pushModels()
    return { ok: true, mainModelId: readConfig().mainModelId }
  },
  // 用给定条目直接验证（不落库）：key 省略时取该模型已保存的密钥
  testModel(model, key) {
    const m = normModel(model)
    if (!m) return Promise.resolve({ ok: false, error: '模型 ID 无效' })
    const k = sanitizeKey(key) || readSecrets().models[m.id] || ''
    return fetchModelBalance(m, k)
  },
  // 刷新模型余额/额度（ids 省略 = 全部），结果落运行时状态并推给挂件
  refreshModels(ids, force) {
    return refreshModelsApi(ids, force).then(() => {
      pushModels()
      return { ok: true }
    })
  },
  // —— 自定义音效 ——
  // 自定义音效元信息（每槽位一个数组），供设置页展示已导入的段落
  getSounds() {
    return sounds.readMeta()
  },
  // 音效本体（base64 data URL），供设置页试听（元信息只有文件名，播不了）
  getSoundData() {
    return sounds.getSoundData()
  },
  // 导入（复制进 userData/whale-sounds）后推新音频数据给挂件
  importSound(role) {
    const r = sounds.importSound(role)
    if (r && r.ok) sendToWidget('whale:sounds', sounds.getSoundData())
    return r
  },
  // 选音频但先不落盘：设置页拿到 data URL 后弹波形裁剪，确认了才走 importSoundFromData
  pickSoundFile() {
    return sounds.pickSoundFile()
  },
  // 写入裁剪后的 WAV（前端已转成 16-bit PCM）并推给挂件
  importSoundFromData(role, name, dataUrl) {
    const r = sounds.importSoundFromData(role, name, dataUrl)
    if (r && r.ok) sendToWidget('whale:sounds', sounds.getSoundData())
    return r
  },
  // 删一段（给 file）或清空整个槽位（不给 file，设置页的批量清除走这条）
  removeSound(role, file) {
    const r = sounds.removeSound(role, file)
    if (r && r.ok) sendToWidget('whale:sounds', sounds.getSoundData())
    return r
  },
  // —— 自定义挂件形象（画廊） ——
  // 画廊列表：每项的元信息 + 缩略图 data URL（current = 挂件当前用的那张的 id）
  listSkins() {
    return skins.listSkins()
  },
  // 当前形象元信息（画廊为空时返回 null），供设置页展示当前文件名
  getSkin() {
    return skins.readMeta()
  },
  // 当前形象本体（base64 data URL，挂件 img.src 直接用）；空串表示无自定义形象
  getSkinData() {
    return skins.getSkinData()
  },
  // 导入/删除/切换后推新形象数据给挂件（空串表示无自定义形象，页面回退内置形象）
  importSkin() {
    const r = skins.importSkin()
    if (r && r.ok) sendToWidget('whale:skin', skins.getSkinData())
    return r
  },
  // 选图片但先不落盘：设置页拿到 data URL 后弹裁剪框，确认了才走 importSkinFromData
  pickImageFile() {
    return skins.pickImageFile()
  },
  // 已选好的文件直接复制（不裁剪）：动图走这条路径保留动画。thumb 是设置页 canvas 生成的缩略图
  importSkinFromPath(filePath, name, thumb) {
    const r = skins.importSkinFromPath(filePath, name, thumb)
    if (r && r.ok) sendToWidget('whale:skin', skins.getSkinData())
    return r
  },
  // 写入裁剪后的 PNG（保留透明通道）并推给挂件
  importSkinFromData(name, dataUrl, thumb) {
    const r = skins.importSkinFromData(name, dataUrl, thumb)
    if (r && r.ok) sendToWidget('whale:skin', skins.getSkinData())
    return r
  },
  // 换用画廊里的某一张
  setSkinCurrent(id) {
    const r = skins.setCurrent(id)
    if (r && r.ok) sendToWidget('whale:skin', skins.getSkinData())
    return r
  },
  // 把某一张移到画廊最前（不改变当前使用的那张）
  pinSkin(id) {
    return skins.pinSkin(id)
  },
  removeSkin(id) {
    const r = skins.removeSkin(id)
    if (r && r.ok) sendToWidget('whale:skin', skins.getSkinData())
    return r
  },
  // —— 自定义气泡图片（点鲸鱼时随机显示一张，无「当前用哪张」概念） ——
  // 列表：元信息 + 缩略图 data URL，供设置页网格展示
  listBubbles() {
    return bubbles.listBubbles()
  },
  // 选图片但先不落盘：设置页拿到 data URL 后生成缩略图，确认了才走 importBubbleFromData
  pickBubbleFile() {
    return bubbles.pickBubbleFile()
  },
  // 原图原样落盘（不裁剪不重编码，保住动图帧）并推给挂件
  importBubbleFromData(name, dataUrl, thumb) {
    const r = bubbles.importBubbleFromData(name, dataUrl, thumb)
    if (r && r.ok) sendToWidget('whale:bubbles', bubbles.getBubbleData())
    return r
  },
  removeBubble(id) {
    const r = bubbles.removeBubble(id)
    if (r && r.ok) sendToWidget('whale:bubbles', bubbles.getBubbleData())
    return r
  },
  // —— 素材包（形象 + 音效 + 气泡图打包带走） ——
  // 导出成一个 .whaleassets 单文件
  assetsExport() {
    return assets.exportAssets()
  },
  // 选择素材包并解析出预览（不写任何数据）
  assetsPick() {
    return assets.pickAssets()
  },
  // 按勾选项写入（形象/气泡图补充、音效同槽位覆盖），写完把新素材推给挂件
  assetsApply(opts) {
    const r = assets.applyAssets(opts)
    if (r && r.ok) {
      if (r.skins && r.skins.added > 0) sendToWidget('whale:skin', skins.getSkinData())
      if (r.sounds && r.sounds.applied > 0) sendToWidget('whale:sounds', sounds.getSoundData())
      if (r.bubbles && r.bubbles.added > 0) sendToWidget('whale:bubbles', bubbles.getBubbleData())
    }
    return r
  },
  // 放弃本次选择
  assetsCancel() {
    return assets.clearPending()
  },
  // Codex 本地会话统计：读 ~/.codex/sessions 下的 rollout JSONL，按天/模型聚合
  codexSummary() {
    return codex.codexSummary()
  },
  clearCodexCache() {
    return codex.clearCodexCache()
  },
  // dsh 本地用量统计：读 $DSH_HOME（默认 ~/.dsh）下 dsh-usage 的账本与会话投影缓存，按天/模型聚合
  dshUsageSummary() {
    return dshUsage.dshUsageSummary()
  },
  clearDshUsageCache() {
    return dshUsage.clearDshUsageCache()
  },
  // dsh 只读诊断（见 lib/diagnostics.js）：
  // 用一次 Promise 收口 —— C5 的端口探测本身是异步的（probePort 回调），
  // 其余项同步跑完。返回 { ok, at, cached, pass, bad, results, env }
  diagnoseDsh(opts) {
    return diagnoseDsh(opts)
  },
  clearDshDiagnoseCache() {
    diagnostics.clearDshDiagnoseCache()
    return { ok: true }
  },
  // dsh 配置转储（见 lib/dsh-dump.js）：读 --dump-config / --dump-default-config，
  // 解析成「五层分层 + 生效树/默认树 diff」。返回 { ok, at, cached, profile, layers, entries, diff }
  dumpDshConfig(opts) {
    return dumpDshConfig(opts)
  },
  clearDshDumpCache() {
    dshDump.clearDshDumpCache()
    return { ok: true }
  },
  // 导出近 N 天用量为 CSV（UTF-8 BOM，Excel 可直接打开）
  exportUsageCsv(days) {
    const { currency, days: rows } = usageDays(days)
    const lines = ['日期,用量,币种']
    for (const r of rows) lines.push(r.date + ',' + Number(r.usage || 0).toFixed(4) + ',' + currency)
    const csv = '\ufeff' + lines.join('\r\n') + '\r\n'
    let filePath
    try {
      filePath = utools.showSaveDialog({
        title: '导出账本用量',
        defaultPath: 'whale-usage-' + rows[rows.length - 1].date + '.csv',
        buttonLabel: '保存',
        filters: [{ name: 'CSV 文件', extensions: ['csv'] }],
      })
    } catch (err) {
      logErr('[whale][csv] 打开保存框失败', err && err.message)
      return { ok: false, error: '无法打开保存对话框：' + ((err && err.message) || err) }
    }
    if (!filePath) return { ok: false, canceled: true }
    try {
      fs.writeFileSync(filePath, csv, 'utf8')
      return { ok: true, path: filePath }
    } catch (err) {
      logErr('[whale][csv] 写入失败', filePath, err && err.message)
      return { ok: false, error: '写入文件失败：' + ((err && err.message) || err) }
    }
  },
  // 导入用量 CSV（与导出格式一致：日期,用量[,币种]）：弹系统打开框 → 解析 → 合并进账本历史。
  // 同日以导入值覆盖；只保留最近 30 天；不影响当天实时记账基准。
  importUsageCsv() {
    let picked
    try {
      picked = utools.showOpenDialog({
        title: '导入账本用量',
        buttonLabel: '导入',
        filters: [{ name: 'CSV 文件', extensions: ['csv'] }],
        properties: ['openFile'],
      })
    } catch (err) {
      logErr('[whale][csv] 打开选择框失败', err && err.message)
      return { ok: false, error: '无法打开文件选择框：' + ((err && err.message) || err) }
    }
    const filePath = Array.isArray(picked) ? picked[0] : picked
    if (!filePath) return { ok: false, canceled: true }
    let text
    try {
      text = fs.readFileSync(filePath, 'utf8')
    } catch (err) {
      logErr('[whale][csv] 读取失败', filePath, err && err.message)
      return { ok: false, error: '读取文件失败：' + ((err && err.message) || err) }
    }
    const { rows, invalid } = parseUsageCsv(text)
    if (!rows.length) {
      return { ok: false, error: '未解析到有效数据：需要「日期,用量」两列，日期形如 2026-09-10' }
    }
    const r = mergeLedgerHistory(rows)
    return { ok: true, path: filePath, imported: r.imported, invalid: invalid, kept: r.kept, from: r.from, to: r.to }
  },
  // 按项清除本地数据：opts = { secrets, config, ledger, window, sounds, skins, bubbles }，为 true 的项才会被清除。
  // 「窗口」项同时含窗口锚点与更新缓存。卸载 uTools 插件不会删除这些数据，需要彻底清除时由设置页调用。
  clearAllData(opts) {
    const o = opts && typeof opts === 'object' ? opts : {}
    const wasVisible = winAlive()
    if (o.secrets) { try { utools.dbCryptoStorage.removeItem(K.secrets) } catch (err) {} }
    if (o.config) {
      try { utools.dbStorage.removeItem(K.config) } catch (err) {}
      // 模型列表随配置一起没了，运行时快照（余额/额度）留着只会在下次同名重建时冒充新数据
      try { utools.dbStorage.removeItem(K.models) } catch (err) {}
      clearTimer() // 设置被重置，一并清掉已落库的计时状态
    }
    if (o.ledger) { try { utools.dbStorage.removeItem(K.ledger) } catch (err) {} }
    // 自定义音效：音频文件（userData/whale-sounds）+ 元信息，独立于「挂件设置」
    if (o.sounds) {
      try { sounds.clearAll() } catch (err) { logErr('[whale][settings] 清除自定义音效失败', err && err.message) }
      // 音效没了，音色还停在「自定义」就没有音源：顺带回退到内置「小黄鸭」
      // （连同 config 一起清除时不必处理 —— 整份配置已重置，soundSet 本就是默认值）
      if (!o.config) {
        try {
          if (readConfig().soundSet === 'custom') {
            patchConfig({ soundSet: 'duck' })
            pushConfig()
          }
        } catch (err) { logErr('[whale][settings] 回退音色失败', err && err.message) }
      }
    }
    if (o.skins) {
      try { skins.clearAll() } catch (err) { logErr('[whale][settings] 清除自定义形象失败', err && err.message) }
      // 同音效：自定义形象没了，形象还停在「自定义」就无图可显示，回退到默认内置形象
      if (!o.config) {
        try {
          if (readConfig().skin === 'custom') {
            patchConfig({ skin: 'DSniang1' })
            pushConfig()
          }
        } catch (err) { logErr('[whale][settings] 回退形象失败', err && err.message) }
      }
    }
    if (o.bubbles) {
      // 气泡图没有「当前用哪张」的概念，删光即自动回退内置 rua.gif，不必改配置
      try { bubbles.clearAll() } catch (err) { logErr('[whale][settings] 清除自定义气泡图失败', err && err.message) }
    }
    if (o.window) {
      try { utools.dbStorage.removeItem(K.win) } catch (err) {}
      try { utools.dbStorage.removeItem(K.update) } catch (err) {}
      try { utools.dbStorage.removeItem(K.dshVersions) } catch (err) {}
      resetAnchorCache()
    }
    resetBalanceCache()
    // 配置或窗口锚点被清除后按默认值重建挂件（原本隐藏则保持隐藏）
    if (o.config || o.window) {
      destroyWidget()
      if (wasVisible) ensureWidget()
    }
    // 音效被清除后把「无自定义音效」推给挂件，正在用「自定义」的音色会立刻回退内置音
    if (o.sounds) {
      try { sendToWidget('whale:sounds', sounds.getSoundData()) } catch (err) { logErr('[whale][settings] 重置后推送音效失败', err && err.message) }
    }
    // 同理：自定义形象被清除后推空串，挂件立刻回退内置形象
    if (o.skins) {
      try { sendToWidget('whale:skin', skins.getSkinData()) } catch (err) { logErr('[whale][settings] 重置后推送形象失败', err && err.message) }
    }
    // 同理：气泡图被清除后推空数组，挂件立刻回退内置 rua.gif
    if (o.bubbles) {
      try { sendToWidget('whale:bubbles', bubbles.getBubbleData()) } catch (err) { logErr('[whale][settings] 重置后推送气泡失败', err && err.message) }
    }
    return {
      ok: true,
      cleared: {
        secrets: !!o.secrets, config: !!o.config, ledger: !!o.ledger, window: !!o.window,
        sounds: !!o.sounds, skins: !!o.skins, bubbles: !!o.bubbles,
      },
    }
  },
  ensureWidget() {
    ensureWidget()
    return { ok: winAlive(), error: getWidgetError() }
  },
  // ── 备份 / 恢复 ──
  // 导出：设置 / 账本 / 窗口位置 / 计时；opts.secrets=true 时用 opts.password 加密后才写入凭据
  backupExport(opts) {
    return backup.exportBackup(opts)
  },
  // 选择备份文件并解析出预览（不写任何数据）
  backupPick() {
    return backup.pickBackup()
  },
  // 按勾选项恢复（同名覆盖）；设置或窗口位置被恢复后重建挂件，让它立刻生效
  backupApply(opts) {
    const r = backup.applyBackup(opts)
    const hit = r && r.applied && (r.applied.indexOf('config') >= 0 || r.applied.indexOf('window') >= 0)
    if (hit) {
      resetBalanceCache()
      const wasVisible = winAlive()
      destroyWidget()
      if (wasVisible) ensureWidget()
      return Object.assign({}, r, { widgetRebuilt: true })
    }
    return r
  },
  // 放弃本次选择
  backupCancel() {
    return backup.clearPending()
  },
  showWidget() {
    ensureWidget()
    return { ok: winAlive(), error: getWidgetError() }
  },
  // 把挂件位置复位到默认锚点（右下角、紧贴边缘）并立即重摆。
  // 换显示器 / 改分辨率 / 误拖到角落之后，靠它一键找回，不必手动拖拽。
  resetWidgetPosition() {
    writeAnchor(defaultAnchor())
    const ok = repositionFromAnchor()
    return { ok: ok, error: ok ? '' : '挂件窗口未显示，请先唤出挂件' }
  },
  getWidgetError() {
    return getWidgetError()
  },
  hideWidget() {
    destroyWidget()
    return true
  },
  // 复制文本到剪贴板（用于引导用户把指令名粘贴到 uTools「全局功能」）
  copyText(text) {
    try {
      utools.copyText(String(text || ''))
      return true
    } catch (err) {
      return false
    }
  },
  // 跳转 uTools「全局功能」并为指令新增一条待绑定项（快捷键被删除后可用它重新添加）
  // 注意：每次调用都会新增一条待绑定项，uTools 无「只跳转不新增」的接口
  redirectHotKeySetting(cmdLabel) {
    try {
      utools.redirectHotKeySetting(String(cmdLabel || '显示/隐藏挂件'))
      return true
    } catch (err) {
      return false
    }
  },
  isWidgetVisible() {
    if (!winAlive()) return false
    try { return !!getWindow().isVisible() } catch (err) { return false }
  },
  // 诊断日志（同步落盘 %TEMP%\whale-debug.log，进程被 uTools 结束也不丢）。
  // 返回末尾部分即可，避免整份日志撑爆剪贴板/界面。
  // 日志超 1MB 会轮转：主文件被清空重建、真内容进了 .1。此时若只读主文件，
  // 用户报问题时拿到的是一份几乎空的日志 —— 故主文件若只剩轮转头，改读 .1
  getDebugLog() {
    if (!LOG_FILE) return { path: '', text: '' }
    let text = ''
    try {
      text = fs.readFileSync(LOG_FILE, 'utf8')
      // 轮转刚发生时主文件只有『已轮转』头一行；把上一份取回来更有诊断价值
      if (text.split('\n').length <= 2) {
        try {
          const prev = fs.readFileSync(LOG_FILE + '.1', 'utf8')
          if (prev) return { path: LOG_FILE + '.1', text: prev.slice(-20000) }
        } catch (err) {}
      }
    } catch (err) { text = '' }
    return { path: LOG_FILE, text: text.slice(-20000) }
  },
  // 用系统默认程序打开日志文件（便于人工查看/另存）
  openLogFile() {
    if (!LOG_FILE) return { ok: false, path: '' }
    try {
      utools.shellOpenPath(LOG_FILE)
      return { ok: true, path: LOG_FILE }
    } catch (err) {
      logErr('[whale][log] 打开日志文件失败', err && err.message)
      return { ok: false, path: LOG_FILE }
    }
  },
  // 在文件管理器里定位插件目录里的 dsh（菜单「定位 dsh 目录」用）。
  // 与 openLogFile 的取舍一致：shellOpenPath 是「用默认程序打开」，目录会被资源管理器接手；
  // 传空路径要先拦掉 —— shellOpenPath('') 会打开「我的电脑」之类的默认位置，看着像成功实则没定位到。
  openDir(dir) {
    const p = String(dir || '')
    if (!p) return { ok: false, path: '' }
    try {
      utools.shellOpenPath(p)
      return { ok: true, path: p }
    } catch (err) {
      logErr('[whale][shell] 打开目录失败', p, err && err.message)
      return { ok: false, path: p }
    }
  },
}
