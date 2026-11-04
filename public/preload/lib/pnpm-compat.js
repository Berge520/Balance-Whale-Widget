/*
 * pnpm 失败分类（纯函数，无副作用、不读磁盘、不联网）。
 *
 * 为什么要有这个文件：
 *   本项目装 / 卸插件全走 pnpm，而 pnpm 的失败**几乎总是退出码非 0 + 一大段输出**。
 *   在此之前，界面只会甩一句「安装失败（退出码 1）：详见「日志」卡」—— 用户得自己去翻
 *   日志、还得自己认得出 `ERR_PNPM_...` 是什么意思。上游 dsh-market 用 25 种错误码把这件事
 *   做透了（src/pnpm-compat.ts 的 classifyPnpmFailure）；但那边有相当一部分是它自己的
 *   workspace / hoist 场景，本项目**不整包照搬**。
 *
 * ⚠️ 本项目相对上游砍掉了大量码，只留与「装 / 卸本插件」真正相关的那些 —— 理由逐条写在
 *    RECOGNIZERS 的注释里。
 *    核心原则：**归类只用于「说清原因 + 说清下一步」，绝不用于自动改用户的配置**。
 *    尤其 release-age：上游在 install.ts 里**明确拒绝**自动放行（`releaseAgeBypass === false`
 *    时直接放弃重试），本项目沿用同一立场 —— 看到「太新」只告诉用户等，绝不代写白名单、
 *    绝不注入 `--config.minimum-release-age=0`（那是绕过供应链安全策略）。
 *
 * ⚠️ 依赖方向：本模块是**叶子**，只 require 其它叶子能力（util 的纯字符串工具）。
 *    不得 require log / utools / constants / dsh —— 那些会把本模块拖进需要宿主桩的路径，
 *    而它的全部价值恰恰是「无桩可单测」。测试见 test/pnpm-compat.test.mjs。
 */

// 分类结果对象。`code` 为 null 表示「认不出」，调用方应回落到通用的「详见日志」文案。
//
// `retryable`：
//   · true  → 原样重试**有可能**成功（网络抖动、锁释放、镜像同步），界面可给「重试」按钮；
//   · false → 原样重试必然再失败（引导未照做、配置没放行），重试按钮只会浪费用户时间。
// ⚠️ 与上游的关键差异：上游的 `recoverable` 字段**没有任何代码读它**（写了等于没写）。
//    本项目的 retryable 有真实消费点（见 settings.js 的 retryable / 前端 P3 重试按钮），
//    所以这个字段必须是**能被依赖**的结论，不能是摆设。
function result(code, opts) {
  const o = opts && typeof opts === 'object' ? opts : {}
  return {
    code: code,
    retryable: o.retryable === true,
    // 面向用户的一句话原因（界面直接显示，不要再让用户去读 pnpm 原文）
    reason: String(o.reason || ''),
    // 面向用户的下一步（可空。空表示「没有比『重试』更具体的建议」）
    hint: String(o.hint || ''),
  }
}

// 从 pnpm 的 stalled 输出里倒查「是哪个包」的安装脚本卡住了。
//
// pnpm 的原文形如：
//   ...\node_modules\.pnpm\better-sqlite3@9.0.0\node_modules\better-sqlite3 install$ node-gyp rebuild
//   Progress: resolved 1, reused 0, downloaded 0, added 0
// 我们要的是 `node_modules/<包名> install$ ...` 里**最后一条**：一条安装流程可能先后跑好几个包的
// 安装脚本，卡住的是最后那个还没跑完的（前面的都已经打印过后续输出了）。
// 取 `.at(-1)` 是上游 #817 的结论，本项目沿用；Windows 上路径是反斜杠，统一折成正斜杠再截。
// 认不出就返回空串 —— 调用方据此省略「卡住的是 X」半句，绝不编一个包名出来。
function culpritOf(s) {
  try {
    const re = /node_modules[\\/]((?:@[^\\/\s]+[\\/])?[^\\/\s]+) (?:pre|post)?install[:$]/g
    const all = []
    let m
    while ((m = re.exec(s)) !== null) all.push(m[1])
    const last = all.length ? String(all[all.length - 1]).replace(/\\/g, '/') : ''
    // 兜底形态：`node_modules/<包名>` 前面没有 `install:` 标记时不在这里猜，交给调用方省略
    return last
  } catch (err) {
    return ''
  }
}

// 抽出 `No matching version found for <pkg>@<version>` 里的包名与请求版本。
// pkg 可能是 scoped（`@scope/name`），所以作用域段要单独匹配；认不出返 null。
// 供 exact-version-missing 的「是不是精确版本」判据与文案共用，避免两处正则漂移。
function noMatchingAsked(s) {
  const m = /No matching version found for\s+((?:@[^/\s]+\/)?[^@\s]+)@([^\s]+)/.exec(String(s == null ? '' : s))
  return m ? { pkg: m[1], version: m[2] } : null
}

// ── 识别器表 ──
//
// ⚠️ **顺序即设计**：多个规则可能同时命中同一段输出（pnpm 的报错常常层层套娃），
//    先命中的胜出。因此「更具体 / 更致命」的规则必须排在「更宽泛」的前面。
//    改动顺序前先想清楚：上移一条规则 = 抢占它下面所有规则。
//
// ⚠️ 只吃**输出文本**（stdout + stderr 已合并）与退出码；不读磁盘、不看 argv。
//    凡是需要「读磁盘才知道」的判断（如 pnpm-workspace.yaml 是否存在）都不属于本模块，
//    留给 settings.js 在真有需要时自己做（P2c）。
const RECOGNIZERS = [
  // ── 1. 缺 pnpm / Node（-1 哨兵来自 dsh.js 的 runPnpm 早退分支）──
  // ⚠️ 必须是第一条：下面的正则全部假设「pnpm 真的跑起来了」，而这些早退分支连进程都没有。
  {
    code: 'pnpm-missing',
    test: (s, code) => code === -1 && /未找到 (pnpm|Node\.js)|请先安装（npm i -g pnpm）/.test(s),
    make: () => result('pnpm-missing', {
      retryable: false,
      reason: '没找到 pnpm 可执行文件。',
      hint: 'profile 的依赖树由 pnpm 维护，装插件必须用它。请先在设置页「DeepSeek Harness」里指定 Node.js 目录，或执行 npm i -g pnpm。',
    }),
  },

  // ── 1.5 安装脚本长时间无输出被杀（pnpm 的 stalled 看门狗）──
  // ⚠️ 必须紧跟 pnpm-missing 之后、排在锁类与网络类**之前**：pnpm 的 stalled 报错会把超时前
  //    打印过的全部输出一起带出来，里面常混着 EBUSY / EPERM / network 之类的字样 ——
  //    排在后面就会被那些规则抢走，把「某个包的安装脚本卡死」误报成「文件被占用」或「网络抖动」，
  //    用户照着关杀软 / 换镜像折腾一圈，真正该处理的那个包却始终没被点名。
  // ⚠️ retryable=false：安装脚本卡死是确定性的（同类脚本同一台机器会再次卡在同一处），
  //    原样重试只会再等一轮（而 pnpm 的超时往往是分钟级）。
  {
    code: 'pnpm-stalled',
    test: (s) => /printed nothing for (\d+)ms and was terminated/.test(s),
    make: (s) => {
      const hit = /printed nothing for (\d+)ms and was terminated/.exec(s)
      const ms = hit ? Number(hit[1]) : 0
      const sec = ms > 0 ? Math.round(ms / 1000) : 0
      const culprit = culpritOf(s)
      return result('pnpm-stalled', {
        retryable: false,
        reason: '有安装脚本长时间没有任何输出，被 pnpm 判定为卡死并终止了'
          + (sec > 0 ? '（约 ' + sec + ' 秒无响应）。' : '。')
          + (culprit ? '卡住的脚本来自 ' + culprit + '。' : ''),
        hint: '多半是该插件的安装 / 构建脚本在等交互输入或访问被墙的网络。'
          + (culprit ? '可先单独确认 ' + culprit + ' 能否正常装好（必要时换镜像源），再重试。' : '可检查该插件是否依赖联网脚本，必要时换镜像源后再试。'),
      })
    },
  },

  // ── 2. 依赖目录的写锁被占用 ──
  // ⚠️ 必须先于「包目录文件锁」判：两者的原文都属于「文件被占用」一类，但成因与出路不同 ——
  //    这条说的是 pnpm / dsh 自己那套目录级写锁（.pnpm/lock.yaml.<pid> 这类内层锁文件），
  //    正解是**等那条装 / 卸操作结束**；下面那条说的是 Windows 上 node_modules 被别的进程占着。
  //    顺序写反会把「另一条装 / 卸还在跑」误报成「被杀软锁了」，用户照着一个改不好的方向折腾（上游同款序）。
  // ⚠️ retryable=false（上游 #786 的结论）：锁没释放时原样重试必然再撞，界面不该给一个点了还是错的按钮。
  {
    code: 'profile-file-locked',
    // 内层锁形态 `[\\/]\.pnpm[\\/]lock\.yaml\.\d+` 必须显式列出：这类报错常见的形式是
    // `Cannot lock ... .pnpm/lock.yaml.12345`，单个文件名里既没有 package.json.lock 也没有 "profile"
    // 字样，只靠原有几个关键词会漏判，回落成认不出的通用文案。
    test: (s) => /ERR_PNPM_EPERM|package\.json\.lock|Cannot lock|profile .* is locked|EBUSY.*profiles|another dsh|[\\/]\.pnpm[\\/]lock\.yaml\.\d+/i.test(s)
      && /profile|package\.json\.lock|lock/i.test(s),
    make: () => result('profile-file-locked', {
      retryable: false,
      reason: '插件依赖目录正被另一个进程占用（多半是另一条安装 / 卸载还没结束）。',
      hint: '等那条操作结束后再点一次重试；若确实没有别的操作在跑，先关掉 dsh 本体再重试。',
    }),
  },

  // ── 3. Windows 包目录文件锁 ──
  {
    code: 'windows-file-locked',
    test: (s) => /EBUSY|EPERM|operation not permitted|resource busy or locked|is being used by another process/i.test(s),
    make: () => result('windows-file-locked', {
      retryable: true,
      reason: '有文件正被别的程序占用（Windows 上常见：编辑器、杀毒软件、文件索引器正在扫 node_modules）。',
      hint: '关掉可能占用该目录的程序后重试；若反复失败，先关掉 dsh 再重试。',
    }),
  },

  // ── 4. 网络抖动（可重试）──
  // 抄上游 isTransientPnpmFailure 的判据集：5xx / ERR_PNPM_META_FETCH_FAIL / FetchError /
  // ECONNRESET / ETIMEDOUT / EAI_AGAIN / ENETUNREACH / socket hang up / network timeout。
  {
    code: 'transient-network',
    test: (s) => /ERR_PNPM_META_FETCH_FAIL|FetchError|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|socket hang up|network timeout|50[0-4]\b/i.test(s),
    make: () => result('transient-network', {
      retryable: true,
      reason: '拉取 registry 元数据时网络中断（抖动或镜像暂时不可用）。',
      hint: '稍等片刻直接重试；若反复如此，可在上方换一个镜像源。',
    }),
  },

  // ── 5. 拉取超时（可重试，且值得自动延长超时）──
  // ⚠️ 与上一条分开：这条的正解不只是「重试」，而是「重试时把 registry 的耗时上限放宽」
  //    （上游 FETCH_TIMEOUT_OVERRIDE = --config.fetchTimeout=600000）。不过本项目 P2c 的
  //    自动重试只做「同 argv 重试」，**不注入 fetchTimeout** —— 理由见 P2c：改 registry 超时
  //    会影响本次进程之外的行为（写进 profile 的 pnpm 配置就可能被持久化），风险大于收益。
  //    这里仍单列一码，是为了给用户「这次是超时、可以放心重试」这个准确结论。
  {
    code: 'fetch-timeout',
    test: (s) => /operation was aborted due to timeout|TimeoutError|error \(23\)|request timed out|ERR_PNPM_FETCH_TIMEOUT/i.test(s),
    make: () => result('fetch-timeout', {
      retryable: true,
      reason: '拉取依赖时超过了 pnpm 的等待上限。',
      hint: '网络慢或镜像不稳时会这样，直接重试；连续超时可换镜像源。',
    }),
  },

  // ── 6. 装到根项目（root）而不是 workspace ──
  // ⚠️ 上游对这条的补救是「补 `-w` 重试」。本项目**不无条件补**：
  //    profile 目录下未必有 pnpm-workspace.yaml，没有时加 `-w` 反而报 ERR_PNPM_NOT_A_WORKSPACE。
  //    所以这里只归因、只提示，是否补 `-w` 由 settings.js 读盘后再定（P2c，读盘逻辑不在本模块）。
  {
    code: 'root-add',
    test: (s) => /ERR_PNPM_ADDING_TO_ROOT|--workspace-root|added to the root project|is not a workspace/i.test(s),
    make: () => result('root-add', {
      retryable: true,
      reason: 'pnpm 把包装进了 workspace 根，而不是目标 profile。',
      hint: '稍后会自动带上 workspace 参数重试一次；若仍失败，请把该插件装到正确的 profile。',
    }),
  },

  // ── 7. lockfile 与清单对不上：分「过期」与「损坏」两档 ──
  // ⚠️ 只归因，**不做**「install --no-frozen-lockfile 再重试」的自动补救：
  //    那是一条全量 install，在 30 分钟硬超时下会把界面钉死（上游是命令行工具，代价小得多）。
  // ⚠️ 为什么拆两码：两档的出路不同 ——
  //    · outdated：清单改了、lockfile 没跟上，正解是重新解析依赖生成 lockfile；
  //    · broken  ：lockfile 本身缺条目 / 解析不了（手工改坏、上次中断写了一半），
  //                得先把它里面那一段记录清掉再重建。
  //    挤在一句话里说不清，用户照着做的动作也就无从下手。
  {
    code: 'lockfile-outdated',
    test: (s) => /ERR_PNPM_OUTDATED_LOCKFILE|frozen-lockfile.*outdated|lockfile.*(?:mismatch|not up to date|different)/i.test(s),
    make: () => result('lockfile-outdated', {
      retryable: false,
      reason: '插件依赖目录里的清单与 lockfile 对不上，pnpm 拒绝按冻结模式安装。',
      hint: '多半是这个目录被手工改过、或上次安装中断留下的残局。先到「DeepSeek Harness」卡做一次体检 / 修复，让 pnpm 重新生成 lockfile，再重试。',
    }),
  },
  {
    code: 'lockfile-broken',
    // ⚠️ 必须排在 outdated 之后但**独立成一码**：`ERR_PNPM_OUTDATED_LOCKFILE` 与
    //    `ERR_PNPM_LOCKFILE_MISSING_DEPENDENCY` 会同时出现在一段输出里（后者常是前者的子原因），
    //    这一档认的是「lockfile 结构本身坏了」，出路比「过期」更重一步。
    test: (s) => /ERR_PNPM_LOCKFILE_MISSING_DEPENDENCY|Broken lockfile|lockfile.*(?:missing|corrupt|invalid|parse)/i.test(s),
    make: () => result('lockfile-broken', {
      retryable: false,
      reason: '插件依赖目录里的 lockfile 缺条目或已损坏，pnpm 无法据此安装。',
      hint: '可在这个目录的 pnpm-lock.yaml 里只删掉对应 importer 的那段记录，再执行一次 pnpm install --no-frozen-lockfile --lockfile-only 重建；不要删整个 pnpm-lock.yaml，那会让所有已装插件的版本一起漂移。',
    }),
  },

  // ── 8. release-age 供应链策略拦截（**只归因，不放行**）──
  // ⚠️ 顺序必须靠后但**必须存在**：这类失败常常**退出码为 0**（pnpm 认为已满足就没动），
  //    真正被发现是靠本体回读版本没变（见 settings.js 的 blockedByPolicy）。本识别器是为
  //    「非 0 退出码但输出里点名了 minimumReleaseAge」这一档兜底，让 retryable=false 有意义。
  // ⚠️ 与 blockedByPolicy 判据分工：那边看的是**版本没变**、且区分 release-age / allowlist；
  //    这边只看**输出文本**，两者不重复计算（blockedByPolicy 在成功分支跑，本模块在失败分支跑）。
  {
    code: 'release-age-violation',
    // ⚠️ `ERR_PNPM_RESOLUTION_POLICY_VIOLATIONS_UNHANDLED` 是同一道门的**第三张脸**
    //    （上游 ca7fd10）：lockfile 校验通过后，解析器重新应用策略，仍落在窗口内的依赖
    //    变成 policyViolation，而这条 CLI 路径没接 handler，只能抛这个码。成因与出路
    //    和上面两码完全相同（等它满期），不归到这里就只剩一句用户看不懂的内部错误。
    test: (s) => /ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION|ERR_PNPM_NO_MATURE_MATCHING_VERSION|ERR_PNPM_RESOLUTION_POLICY_VIOLATIONS_UNHANDLED|minimum[\s-]?release[\s-]?age(?!Exclude)/i.test(s),
    make: () => result('release-age-violation', {
      retryable: false,
      reason: '目标版本发布得太新，还没过 pnpm 的发布观察期（release-age 供应链策略）。',
      hint: '等它满期后原样重试即可，不必改任何配置。确实要立刻装，才需要把该版本加进 profile 的 minimumReleaseAgeExclude 白名单。',
    }),
  },

  // ── 9. 宿主 peer 依赖拉不到（404 / 无匹配版本）──
  // ⚠️ 这是上游 AUTO_INSTALL_PEERS_OFF 的场景：某些插件把 dsh 宿主自身的包声明成 peer，
  //    而这些包不一定能从公共 registry 拉到。上游的补救是**重试时才加** --config.auto-install-peers=false。
  //    本项目同理：只提示，不默认改（auto-install-peers 是 profile 的行为开关，默认关掉会影响别的插件）。
  {
    code: 'host-peer',
    // ⚠️ `@deepseek-ai/` 的分隔符要吃 `%2f`（大小写皆可）：npm registry 的 GET URL 里 scoped
    //    包名是 **URL 编码过的**，真实报错形如 `GET https://registry.npmjs.org/@deepseek-ai%2fdsh-settings`。
    //    只写裸斜杠会漏掉最常见的这一档（实测：404 + 编码斜杠时判不出 host-peer，回落成认不出）。
    test: (s) => /(?:404|Not Found|No matching version found|ETARGET)/i.test(s) && /@deepseek-ai(?:%2f|\/)/i.test(s),
    make: () => result('host-peer', {
      retryable: true,
      reason: '该插件把 DSH 宿主的包声明成了 peer 依赖，而它在 registry 上拉不到（404 / 无匹配版本）。',
      hint: '稍后会自动重试一次（这次不自动装 peer 依赖）。若仍失败，说明该插件要求的宿主版本与当前宿主不符，换个版本或等作者修正。',
    }),
  },

  // ── 9.5 精确版本在当前线路还没同步（**不等于版本不存在**）──
  // ⚠️ 必须排在 host-peer 之后：宿主包（@deepseek-ai/*）的同类报错要归到上面那档，
  //    那里的出路是「放行 peer」，而这里只是「等线路同步」—— 归错会让用户去改配置。
  // ⚠️ 与 no-matching-version（认不出/未单列）的分工：只有请求是**精确版本**（name@x.y.z）
  //    才成立；范围请求（`^1.2.3`）匹配不上时是真没有可满足版本，文案不同（上游 #927）。
  // ⚠️ retryable=false：手动原样重试没有新信息；但宿主会自动**同 argv 重试一次**
  //    重新拉 packument（见 shouldAutoRetryOnce），所以 hint 写「已自动重试一次」。
  {
    code: 'exact-version-missing',
    test: (s) => {
      if (!/ERR_PNPM_NO_MATCHING_VERSION/.test(s)) return false
      const asked = noMatchingAsked(s)
      if (!asked) return false
      // 宿主包留给 host-peer（哪怕上一条因措辞差异没命中，也不能在这里认领）
      if (/@deepseek-ai(?:%2f|\/)/i.test(asked.pkg)) return false
      // 只有完整 x.y.z（可带 prerelease / build）才算「精确版本」；`1.2` 之类是范围，不放这档
      return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(asked.version)
    },
    make: (s) => {
      const asked = noMatchingAsked(s)
      const pin = asked ? asked.pkg + '@' + asked.version : '该版本'
      return result('exact-version-missing', {
        retryable: false,
        reason: '当前下载线路暂时找不到精确版本 ' + pin + '；常见原因是线路还没同步到刚发布的版本，不等于这个版本不存在。',
        hint: '已自动重试一次（重新拉取索引）。仍失败可稍后再试，或把 registry 切换为 npmjs.org 后再试。',
      })
    },
  },

  // ── 10. allowBuilds 未放行（构建脚本被拦）──
  // ⚠️ 与 settings.js 的 parseAllowBuilds 分工：那边负责**抠出要写进 yaml 的 key** 并交给界面
  //    照抄；这里负责**认领这一档失败**（retryable=false），避免界面对「需构建」误给重试按钮。
  //    两者的触发条件刻意错开：parseAllowBuilds 要 `allowBuilds` 字样，这里认的是 pnpm 的错误码。
  {
    code: 'unparseable-build-key',
    test: (s) => /ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED|ERR_PNPM_PREPARE_NOT_ALLOWED|Ignored build scripts|allowBuilds/i.test(s),
    make: () => result('unparseable-build-key', {
      retryable: false,
      reason: '该插件靠 prepare 构建脚本安装，被 pnpm 的构建白名单拦下了。',
      hint: '按日志里给出的 allowBuilds key 写进 profile 的 pnpm-workspace.yaml，再重试一次即可（同一把 key 只需放行一次）。',
    }),
  },
]

// classifyPnpmFailure(output, exitCode) → { code, retryable, reason, hint }
//
// output：pnpm 的 stdout + stderr 合并文本（dsh.js 的 runPnpm 已合并，直接喂进来即可）。
// exitCode：进程退出码；dsh.js 用 -1 表示「pnpm 根本没跑起来」。
//
// 认不出时返回 { code: null, retryable: false, reason: '', hint: '' }。
// ⚠️ retryable 默认 false 而不是 true：认不出的失败，我们**没有证据**说重试有用；
//    给用户一个「重试」按钮、点了还是同样报错，比自己翻日志更让人火大。
//    （这与上游把 recoverable 默认 false 的口径一致。）
function classifyPnpmFailure(output, exitCode) {
  const s = String(output == null ? '' : output)
  const code = Number.isFinite(exitCode) ? exitCode : -1
  for (let i = 0; i < RECOGNIZERS.length; i++) {
    const r = RECOGNIZERS[i]
    try {
      if (r.test(s, code)) return r.make(s)
    } catch (err) {
      // 识别器必须永不抛出：这里是「失败路径上的失败路径」，
      // 抛出去会把原始报错顶掉、用户连「安装失败」都看不到（#662 的教训）
    }
  }
  return result(null, { retryable: false })
}

// 「这次失败值得自动重试一次吗」——P2c 的闸门。
//
// ⚠️ 白名单式，而不是「any retryable」：
//    自动重试会**再跑一次 pnpm**（可能又是几分钟），花的是用户的时间。
//    所以只放行那些「重试本身大概率改变结果、且不需要用户先做任何事」的几类：
//      · transient-network：网络抖动，重试即可能成功；
//      · fetch-timeout   ：超时，重试即可能赶上；
//      · exact-version-missing：镜像的 packument 还没同步，同 argv 再拉一次有机会拿到（上游 #927）；
//      · root-add        ：补 `-w` 后重试（**前提**：profile 下确实有 pnpm-workspace.yaml，
//                          该判断由 settings.js 读盘后给出，本函数只做纯判定）。
//    其余码即便 retryable=true 也不自动重试：
//      · profile-file-locked / windows-file-locked：要等外部进程让出锁，立刻重试多半还锁着，
//        频繁重试反而让界面长时间「正在安装」，体验更差（交给用户手动点）。
//      · pnpm-stalled：安装脚本卡死是确定性的，重试只会再等一轮分钟级的超时。
//      · host-peer：要重试的话得改 argv（加 auto-install-peers=false），属于「带参数重试」，
//        由 settings.js 显式决定，不在这个纯函数的口径内。
function shouldAutoRetryOnce(info, opts) {
  const i = info && typeof info === 'object' ? info : {}
  const o = opts && typeof opts === 'object' ? opts : {}
  if (i.code === 'transient-network' || i.code === 'fetch-timeout') return true
  // 精确版本缺失：镜像 packument 还没同步，同 argv 再拉一次有机会命中（上游 #927 / install.ts 同款）
  if (i.code === 'exact-version-missing') return true
  // root-add 仅在「目标目录确实是一个 workspace」时才自动补 -w 重试
  if (i.code === 'root-add' && o.hasWorkspaceFile === true) return true
  return false
}

module.exports = {
  classifyPnpmFailure,
  shouldAutoRetryOnce,
}
