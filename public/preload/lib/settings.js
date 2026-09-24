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
const { parsePatch, applyToggle, applyBatchDisable } = require('./dsh-patch')
const dshIsolate = require('./dsh-isolate')
const dshMarket = require('./dsh-market')
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
    const hit = /minimumReleaseAgeExclude|supply-chain|minimumReleaseAge/i.test(s)
    const home = dshBackup.dshHome()
    return {
      blocked: true,
      policyFile: home ? path.join(home, 'profiles', profile, 'pnpm-workspace.yaml') : '<$DSH_HOME>/profiles/' + profile + '/pnpm-workspace.yaml',
      policyKey: 'minimumReleaseAgeExclude',
      sawPolicyHint: hit,
    }
  }
  return { blocked: false }
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
    const deps = dsh.installedDeps(profile)
    const hit = dshMarket.matchInstalledBySpec(deps, spec) || (npm ? dshMarket.matchDepByNpm(deps, npm) : null)
    if (!hit) {
      return { ok: true, dryRun: true, profile: profile, spec: spec, name: label, action: 'not-installed', changed: false, message: label + ' 不在 profile 依赖里，无需更新' }
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
      message: '将执行 pnpm add --dir <profiles/' + profile + '> ' + spec
        + '\n当前版本：' + (from || '读不到实装版本（声明范围是 ' + (hit.depVersion || '无') + '）')
        + ' —— 重装会把声明改写成目录给的版本',
    }
  }

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
      return { ok: false, spec: spec, name: label, error: '更新失败（退出码 ' + r.code + '）：详见「日志」卡', snapshot: snap.dirName, allowBuilds: build }
    }
    const after = dsh.installedDeps(profile)
    const hit = dshMarket.matchInstalledBySpec(after, spec) || (npm ? dshMarket.matchDepByNpm(after, npm) : null)
    if (!hit) {
      logErr('[whale][dsh-market] 更新后回读校验不符', spec)
      return { ok: false, spec: spec, name: label, error: 'pnpm 报告成功，但 ' + spec + ' 没出现在 profile/package.json 里（已保留快照，可回滚）', snapshot: snap.dirName }
    }
    // ⚠️ 这里必须**重新读** node_modules：不重读会拿更新前的旧版本当新版本显示
    const to = realizedOf(profile, hit, spec) || hit.depVersion
    // ⚠️ 退出码 0 还不够：pnpm 可能被 profile 的供应链策略挡下、原样没动却报成功。
    //    判据是「回读到的实装版本真的变了」，没变就不能说「已更新」—— 否则界面会显示
    //    「已更新 v1.48.0 → v1.48.0」这种荒谬结论，用户以为成功、其实一个字没改。
    const blk = blockedByPolicy(profile, fromBefore, to, r.out)
    if (blk.blocked) {
      // 目录给的版本（dryRun 回传 → 前端真写时带回）。拿不到就退回「目标版本」这种含糊说法
      const aim = String(o.version == null ? '' : o.version).trim()
      const aimTxt = aim || '目标版本'
      logErr('[whale][dsh-market] 更新被供应链策略拦截，版本未变', { spec: spec, version: to, aim: aim, sawPolicyHint: blk.sawPolicyHint })
      return {
        ok: false,
        spec: spec,
        name: label,
        blocked: true,
        from: fromBefore,
        version: to,
        policyFile: blk.policyFile,
        policyKey: blk.policyKey,
        snapshot: snap.dirName,
        error: 'pnpm 报成功但版本没变（仍是 v' + (to || '未知') + '）：' + (aim ? '目录给的 v' + aim + ' ' : '')
          + '没能装上，被 profile 的供应链策略挡下了。'
          + (blk.sawPolicyHint ? '' : '（pnpm 没报错，只是认为当前版本已满足要求。）')
          + '\n如需放行，请把 ' + aimTxt + ' 加进 ' + blk.policyFile + ' 的 ' + blk.policyKey
          + '（照抄这一行即可：`- ' + spec + '@' + aimTxt + '`），再重试。'
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

  // dryRun：只说清「准备执行什么」，不跑 npm 也不建快照
  if (o.dryRun === true) {
    const deps = dsh.installedDeps(profile)
    const hit = dshMarket.matchInstalledBySpec(deps, spec) || (npm ? dshMarket.matchDepByNpm(deps, npm) : null)
    // ⚠️ 光判「装没装」不够 —— 这正是本函数早先的一个真实 bug：声明范围 `^1.48.0` 是**容得下**
    //    `1.49.0` 的，用户看着目录里有新版去点「安装」，却被告知「已装 …无需重复安装」。
    //    所以这里还要比**实装版本**（读自 node_modules 的裸 x.y.z）：实装 < 目录版本 → 该走更新。
    //    口径与 marketCheckUpdates 的 updateState 完全一致（那边也是「优先比实装，拿不到退回范围」），
    //    两边不一致会出现「列表标着可更新、点进去却说已装」这种自相矛盾。
    const realized = realizedOf(profile, hit, spec)
    const st = hit ? dshMarket.updateState(hit.depVersion, catalogVersion, realized) : null
    // changed 的语义是「这次点下去磁盘真的会变」：没装 → 变；装了但落后 → 也变
    const changed = !hit || (st.state === 'update')
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
      // 已装且不比目录旧 → 才是真的不必重跑 pnpm（同一包重装是幂等的，但会白等一次网络）
      message: changed
        ? (!hit
          ? '将执行 pnpm add --dir <profiles/' + profile + '> ' + spec
          : '已装 ' + (realized || hit.depVersion || '') + '，目录提供 v' + catalogVersion
            + ' —— 将重装覆盖到 v' + catalogVersion
            + '（会改写 profile/package.json 里的版本范围）')
        + (needsBuild ? '\n⚠️ 该来源靠 prepare 脚本构建，pnpm 默认拦截构建 —— 第一次大概率会失败并要求写入 allowBuilds，按提示再装一次即可' : '')
        : '已装 ' + label + '（' + (realized || hit.depVersion || '') + '），'
          // 实装版本与目录版本都拿得到才说得清「已是最新」；拿不到就别下这个结论
          + (realized && catalogVersion ? '已是目录里的最新版 v' + catalogVersion : '无需重复安装'),
    }
  }
  if (dsh.globalDsh()) {
    // 与主安装链路同一取舍：有全局 dsh 时 pnpm 装插件的目标目录取决于 dsh 从哪加载，
    // 这里只警告不阻断 —— 用户确实可能故意两个都装
    log('[whale][dsh-market] 检测到全局 dsh，插件将装进 profile 目录', profile)
  }

  const snap = dshBackup.createSnapshot({ profile: profile, reason: 'before-market-install' })
  if (!snap.ok) {
    logErr('[whale][dsh-market] 快照失败，已中止安装', snap.error || '')
    return Promise.resolve({ ok: false, error: '建快照失败，已中止安装：' + (snap.error || '未知错误') })
  }
  return dsh.installPluginPkg(profile, spec).then((r) => {
    if (!r.ok) {
      logErr('[whale][dsh-market] 安装失败', spec + ' 退出码 ' + r.code + ' ' + (r.err || ''))
      // 「需构建」这一档把 dsh / pnpm 的 allowBuilds 原文交给界面 —— 用户照着写一遍
      // 再点一次即可，不必自己翻日志找那把带 commit hash 的 key
      const build = needsBuild ? parseAllowBuilds(r.out || '') : null
      return {
        ok: false,
        spec: spec,
        name: label,
        error: '安装失败（退出码 ' + r.code + '）：详见「日志」卡',
        snapshot: snap.dirName,
        allowBuilds: build,
      }
    }
    // ⚠️ 不信任「pnpm 退出码 0 = 装好了」：回读 profile/package.json 确认依赖真的出现了。
    // 与 dsh-patch 写后回读同一个理由 —— V2 已证明写坏的东西不会报错。
    // 判定用 spec 反查（github/tarball 的键名由包管理器归一，对不上 npm 字段）
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
    log('[whale][dsh-market] 已安装插件', { spec: spec, version: hit.depVersion })
    return {
      ok: true,
      spec: spec,
      npm: npm,
      name: label,
      version: hit.depVersion,
      profile: profile,
      snapshot: snap.dirName,
      // ⚠️ github / tarball 来源即使装成功也**不保证 dsh 能加载**：pnpm 仍会拦 prepare 构建。
      //    界面据此提示「若加载失败，按 allowBuilds 引导再试」
      needsBuild: needsBuild,
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
        return { ok: false, error: '卸载失败（退出码 ' + r.code + '）：详见「日志」卡', snapshot: snap.dirName }
      }
      const after = dsh.installedDeps(profile)
      if (after[npm]) {
        logErr('[whale][dsh-market] 卸载后回读校验不符', npm)
        return {
          ok: false,
          error: 'pnpm 报告成功，但 ' + npm + ' 仍在 profile/package.json 里（已保留快照，可回滚）',
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
  // 更新一个已装插件：按目录 spec 重装（不是 pnpm update，见 marketUpdate 注释）。
  // dryRun 只算不写；真写与安装同链路：快照 → pnpm add → 回读核验
  dshMarketUpdate(opts) {
    return marketUpdate(opts)
  },
  // allowBuilds 引导信息的解析（纯函数，单测直接喂 dsh 真实报错原文）：
  // 那把 key 带 commit hash、安装前拿不到，只能从失败输出里抠 —— 抠错会引导用户写错 key
  parseAllowBuilds(text) {
    return parseAllowBuilds(text)
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
      try { sendToWidget('whale:sounds', sounds.getSoundData()) } catch (err) {}
    }
    // 同理：自定义形象被清除后推空串，挂件立刻回退内置形象
    if (o.skins) {
      try { sendToWidget('whale:skin', skins.getSkinData()) } catch (err) {}
    }
    // 同理：气泡图被清除后推空数组，挂件立刻回退内置 rua.gif
    if (o.bubbles) {
      try { sendToWidget('whale:bubbles', bubbles.getBubbleData()) } catch (err) {}
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
  getDebugLog() {
    if (!LOG_FILE) return { path: '', text: '' }
    let text = ''
    try { text = fs.readFileSync(LOG_FILE, 'utf8') } catch (err) { text = '' }
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
