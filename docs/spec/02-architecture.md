## 二、架构（务必先读）

uTools 无宿主页面可注入，改为**双窗口+双 preload**（DSH 版注入宿主网页+webServer 路由）。

```
┌──────────────────────────────┐        ┌────────────────────────────────┐
│ 主窗口  index.html (Vue 3)    │        │ 悬浮窗  floating.html（原生JS） │
│ 设置页                        │        │ 挂件本体（展示 + 指针交互）      │
│   window.services ◄───────────┤        │       window.whale ◄────────────┤ preload
└───────────┬──────────────────┘        └───────────────┬────────────────┘
            │ preload/services.js（装配入口）             │ preload/floating.js
            │  └ preload/lib/*.js（按职责拆分）           │  · ipcRenderer.on
            │  · createBrowserWindow                    │  · utools.sendToParent
            │  · 余额/账本/定价/窗口几何                  │
            │  · ipcRenderer.on 收子窗                    │
            └─────────────────── 主窗 ↔ 悬浮窗 IPC ──────┘
```

- **主窗 preload 入口**：`public/preload/services.js`，CommonJS，只装配（注入 `window.services`、`registerIpc()`、注册生命周期），拆分在 `public/preload/lib/`：

  | 文件 | 职责 |
  |---|---|
  | `lib/constants.js` | 常量、定价表、存储键、**多厂商模板表 `MODEL_TEMPLATES`**；`PLUGIN_VERSION` 由 `scripts/sync-version.mjs` 构建前写入 |
  | `lib/log.js` | `log/logErr`（`DEV` 恒为 true，打包版/开发版均落盘 `%TEMP%\whale-debug.log`） |
  | `lib/holidays.js` | **法定节假日表运行时覆盖层**：`isHoliday(dayKey)` = 内置表 `CN_HOLIDAYS` ∪ 联网更新层（**只补不删**）；`coveredYears()` 报「内置∪已拉取」年份；`update(timeSec)` 拉当年+次年（`SPAN = 2`）按年 JSON，`SOURCES` 三源（jsDelivr CDN → fastly jsDelivr → gh-proxy GitHub Raw）均摊 `TIMEOUT_MS = 8000`，**并集落盘 `whale:cnHolidays`，失败一律 `ok:false` 不抛**（返回 `{ok,added,total,years,sources,failed,error}`）；`clear()` 回内置表，`status()` 报覆盖层现状。**默认零网络**，仅设置页「更新」联网。依赖 `constants`/`log`，**刻意不 require `pricing`**（成环），仅被 `pricing` 引用 |
  | `lib/pricing.js` | 峰谷判定与价格换算，判据 `holidays.isHoliday(bjDayKey(n))`（**内置表∪覆盖层**），周末无条件全天谷 |
  | `lib/store.js` | 配置/密钥/账本/窗口锚点持久化；模型条目归一化（`normModel/normModels/normMainModelId`）与模型运行时状态（`whale:models`）；**待办清单 `readTodo`/`writeTodo`/`clearTodo`（`whale:todo`）与专注轮次 `readFocus`/`writeFocus`/`clearFocus`（`whale:focus`）的形状归一**（重复 id 只留首条、`done` 只认 `=== true`、`doneAt` 仅完成时保留、`focusId` 悬空即清空、全零的空壳天不落盘、会话明细复用 `focus.normSessions` 清洗） |
  | `lib/focus.js` | **专注会话账本（纯函数叶子，零依赖 / 无 IO）**：`appendSession`（把挂件报来的「这一段」归一成一条会话，`d` 取**结束那一刻**的本地日期键 —— 跨零点的轮次归结束那天，**返回新对象不改入参**，写失败时内存不能与存储不一致）/ `isRound`（**什么算一轮的唯一口径**：`k==='down' && !b && !a`，正计时 / 定时 / 中途放弃 / 休息都不算）/ `deriveDays`（天表 `{r,m}` 只由会话派生，休息行轮数与分钟都不进；v1 老数据凭 `legacy` 并入，不丢历史）/ `withDerived`（读到的状态一律先派生再返回，天表不是第二份账）/ `pruneFocus`（保留「含今天」的 `FOCUS_KEEP_DAYS`=90 天窗口，按会话自己的 `d` 裁；未来日期、越界、非对象、空壳键一律裁掉，`keepDays` 非法按 90）/ `summarize`（近 N 天补零成 `series`、`today`、**窗口内** `total`（与图上柱对得上，不会出现「图上 7 根柱、总数算 90 天」）、`streak` 连续天数 —— **今天还没记录时从昨天数起**，早上打开不该显示「连续 0 天」）/ `roundsByTodo`（待办的「今日 N 轮」由此派生，不再自己 `+1`）/ `listSessions`（设置页明细，带 `round: 0\|1` 投影 —— 页面只读它渲染徽标，不复制口径）/ `keyToMs`+`msToKey`+`localKey`（严格 `YYYY-MM-DD` 往返校验，**用 UTC 零点算天数差**，不受时区 / 夏令时影响）/ `normSession`+`normSessions`（会话清洗，`store.readFocus` 复用同一份）。刻意不引 `constants`（保留天数由调用方传），故 ipc 与设置页两侧都能复用；状态形状归 `store.readFocus` 管 |
  | `lib/api.js` | 余额、平台用量、更新检查与缓存；**多厂商模型余额/订阅额度查询**（JSON 路径解析+批量刷新+低余额通知） |
  | `lib/dsh.js` | DeepSeek Harness（dsh）：启停/重启/更新、版本探测与来源（**全局优先**，其次插件目录）、**跨平台安装提权**（`elevateTool()`：Windows powershell+UAC，macOS/Linux `pkexec` 优先或 `sudo`；进程/端口探测、杀进程、起子进程、PATH/node 目录候选均有 `WIN` 分支）、**安装回读校验与失败回滚**（见下）、日志与 npx 缓存清理；变更广播 `onChange(cb)`（第五节） |
  | ↳ **安装成败判据 = 回读磁盘，非退出码** | `verifyInstalledPkg(pkgDir, expectedName)`。退出码 0 只说明这一步没报错：后续阶段（写 manifest/enable/组装 profile）失败时它仍是 0；上游包**改名**时「退出码 0、目录在、版本对，但里面是别的包」，下次按依赖名 import 就炸。判据三条：① `package.json` 可读且合法 JSON；② 有 `version`；③ 有 `name` 时必须等于依赖键（不等即报出实际装成了谁）。**⚠️ 拿不到 `name` 不能判改名**（与 `unresolvedInbox` 同原则）。`installDsh` 三条出口（退出码 0/提权回调成功/spawn error）全走 `succeedIfVerified`，校验不过不报「安装完成」 |
  | ↳ **失败后回滚清单，防幽灵依赖** | `snapshotManifests(pkgDir)` 安装前快照 `package.json`/`package-lock.json`/`npm-shrinkwrap.json`（**只收实际存在的**），非 0 退出、spawn error、「退出码 0 但校验不过」三路径都调 `restoreManifests()` 写回。**为什么**：安装会改写清单与 lock，中途失败留下「清单有、磁盘无」的幽灵依赖，下次组装 profile 才炸。**⚠️ `restoreManifests` 声明不抛错**（补偿失败不该带崩主流程），单文件写不进只 `logErr`、其余继续；装到**全局**时不做快照（用户 npm 前缀不归插件回滚） |
  | ↳ **启动前的幽灵依赖自检** | `checkGhostDeps(pkgDir)`，在 [start()](file:///e:/Github/Balance-Whale-Widget/public/preload/lib/dsh.js) 只对**插件目录那一份**（`act.source === 'plugin'`）跑。回滚只管**本次**安装，历史半途失败/被外力改过的目录不会自愈，等到组装 profile 才炸，报错混在 dsh 输出看不出缺依赖。判据：读 dsh 自身 `package.json`，`dependencies` 每名探 `node_modules/<name>`，缺即失败；`optionalDependencies` **单独缺不算**，同名两处都声明按 `dependencies` 算；**缺到 8 个停止枚举**。失败时 `state.error` 给出「缺几个+举例+点『更新』重装即可修复」。**⚠️ 只读自检、不改磁盘**：修不修由用户点「更新」决定（自动重装会在无预期时下几百 MB）。全局那一份不查 |
  | `lib/hosts.js` | **GitHub 加速（hosts 方案）**：按字节读写系统 hosts，标记块**写在文件最前**（Windows first-match，压过其它工具的 `127.0.0.1` 条目；关闭整段删除、不改编码）；UAC 提权覆盖写（`dsh.psExe`+`Start-Process -Verb RunAs`，写完紧接 `ipconfig /flushdns`，否则缓存旧 IP 表现为「已开启却打不开」）；`scanConflicts` 仅认高置信特征（`127.0.0.1`/`0.0.0.0` 指向 GitHub 域名 = 本地反代类工具），判不准返回空串、界面退回「可能是其它加速工具写的」；含连通性自检；多源刷新与开启共用候选链 `refreshIps(current, op, srcOrder, order)`（经 `normSrcOrder(order)` 依次跑 doh/community/manual，每段**真探通**才计入已覆盖：按「源给了 IP」短路会把全不可达当已覆盖；`GH_DOMAINS` 全覆盖即 `opStep('候选链提前收工')`；community 段内部仍全拉取：A 排前但只覆盖 3 个域名不能停手）。社区源 raw.hellogithub.com → hosts.gitcdn.top（默认序、可拖拽）；`normSources` **必须先剥 `community:` 前缀再比对**，否则 `allow.includes(u)` 恒 false、用户排序静默失效（`test/hosts.test.mjs` 钉住），同时保序去重。用户自建源 `ghAccelSrc.customSources`（上限 `CUSTOM_SRC_MAX = 10`），`normCustomSources(v)` 唯一校验（只收过 `new URL()` 的 http(s) 绝对 URL，去重/trim/截断），`allSources(custom)` = 内置源+自定义源（末尾）；**自定义源默认不参与候选链**，看 `sources` 是否写了它，`normSources` 的「缺失源补末尾」**只补 `GH_IPS_SOURCES`**；拉自建源时域名仍只取 `GH_DOMAINS`；全失败保留旧表只报错。同一 (域名,IP) 跨段只探一次（`probedKey`）；按「候选链命中>当前表」合并，当前表旧值也过 `probeIp`，不通就不写（回落系统 DNS）；成功写 `ghAccelRefreshedAt`。开启时自动刷新，写入前逐 IP 探测（HTTPS GET，SNI+Host 带域名；github.com 只认 2xx/3xx，其它收 2xx/3xx/4xx 但拒 400；证书 SAN 必须匹配目标域名 `certMatchesDomain`，支持 `*.example.com`；单 IP 4.5s 超时，`mapLimit` 并发 `PROBE_CONCURRENCY = 6`，进度经 `opStep` 回写 `detail`「已测 n/m 条」）。每个域名保留全部可达候选而非首个（同域名多行写入，Windows 取第一条；首选失效自动回退，静态 hosts 唯一运行期回退）；逐域名按「DoH 实时解析>源表 IP>内部兜底候选」取首个可达，同域名多候选按「来源优先级→实测延迟→链内位置」排序（hosts 只认第一条，慢的写前面＝每次白等）；内部兜底只写「内部兜底」不写地区（跨 140.82.x/20.x 多网段）；域名只留高频；无内置 IP 快照兜底，全不可达时该域名落选（宁可不写，也不长期写可能过时的地址）；github.com 整链全失败时并行重测一轮抗抖动；备份原 hosts 到 `<userData>/whale-hosts-backup` |
  | `lib/sounds.js` | 自定义音效：导入（复制进 `userData/whale-sounds/`）、删除、整组清除（`clearAll`）、读成 base64 data URL |
  | `lib/skins.js` | 自定义挂件形象：导入（复制进 `userData/whale-skins/`）、删除、整组清除（`clearAll`）、读成 base64 data URL（与 `sounds.js` 同构） |
  | `lib/bubbles.js` | 自定义**气泡图片**（点小鲸鱼抽到「动图组」时随机显示一张）：导入（**原图不裁剪不重编码**，复制进 `userData/whale-bubbles/`）、删除、整组清除、读成 base64 data URL 数组。**没有「当前用哪张」**（有图随机抽，删光回退内置 `rua.webp`），最多 8 张、推送总量上限 20MB。另供「备份与恢复」取/写：`exportItems()` 给原图与缩略图的 Buffer（备份 base64 内嵌进 JSON）、`importBuffer(...)` 按字节写回（恢复用「先清后写」，见 `lib/backup.js`） |
  | `lib/assets.js` | 素材包：把导入的形象、气泡图与音效打包成 `.whaleassets` 单文件（魔数+JSON 清单+平铺字节，见第六节），导入预览与按项写入 |
  | `lib/backup.js` | 备份导出（凭据可选 scrypt+AES-256-GCM 加密）、导入预览、按项同名覆盖恢复。**`bubbles` 独立可选**：默认不导出（二进制大件胀大文件），`opts.bubbles === true` 才把原图 base64 内嵌；导入该分支走**「先清后写」**（`bubbles.clearAll()` 再逐项 `importBuffer`）：与素材包「补充」语义不同，避免新旧混在一起或撞满 `MAX_ITEMS=8` 丢图；`pickBackup` 的 `has.bubbles` 供设置页预勾选。**`todo`/`focus` 非空才写入**（「备份里没有」≠「备份里是空的」，空壳会让误点恢复后清空现有清单），`has.todo`/`has.focus` 与导出侧对称；恢复走 `writeTodo`/`writeFocus`，写盘失败报 error 不假报成功。按压气泡的文案/开关随 `whale:config` 的 `bubble` 键进出 |
  | `lib/codex.js` | Codex 本地会话统计：扫 `$CODEX_HOME`（或 `~/.codex`）下 `sessions/`、`archived_sessions/` 的 `rollout-*.jsonl`，按累计量差值聚合今日/本月/累计 token 与各模型用量，并从 `token_count` 事件的 `payload.rate_limits` 取**订阅窗口**（5h/周）快照；返回 `days31`（近 31 天逐日，索引 0 是今天）供设置页按档位切片；增量解析缓存落 `whale:codex`。**纯本地读取、不联网、不持有凭据** |
  | `lib/dsh-usage.js` | dsh 本地用量统计：读 `$DSH_HOME`（或 `~/.dsh`）下用量数据，优先 `dsh-usage/usage-ledger.json`（按天×provider×model 的 token/cost），账本空时回落 `storages/session_projcache/sessions/*.json`（按会话创建日聚合），另附 `dsh-usage/provider-snapshots.json` 的余额快照；返回 `days31`（近 31 天逐日，索引 0 是今天）供设置页按档位切片；增量解析缓存落 `whale:dshUsage`。**纯本地读取、不联网、不持有凭据** |
