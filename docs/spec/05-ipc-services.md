| 设置页→宿主 | `services.setSkinRandomBatch(map)` | — | **批量改「参与随机」**（`skins.setRandomBatch` 直通）。`map = {id: boolean}`，未知 id / 非布尔静默跳过，返回 `{ok, changed}`；`on === false` 写 `random:false`，否则**删掉该字段**（缺省即参与）。**整张清单只读改写盘一次**：逐张改会做 N 次读写。单张 `setSkinRandom` 已移除，入口收敛到卡片「随机设置」。**宿主直返，不新增 `whale:` IPC 通道**（与 `setSkinCurrent` / `moveSkin` 同构）。挂件与设置页「随机一张」共用这一池 |
| 设置页→宿主 | `services.moveSkin(id, to, index?)` | — | **调整画廊顺序（单张）**（`skins.moveSkin` 直通）。`to` = `'top'` / `'up'` / `'down'`（挪一格）/ `'to'`（拖拽落点，需 `index`）；数组顺序即展示顺序，不影响 `current`。**边界返回 `{ok:true, moved:false}`，不报错**。非法 `to`、或 `'to'` 的 `index` 等于当前下标（`want === idx`）时不动；`index` 先 `Math.max(0, Math.min(index, len-1))` 夹取。`'up'` / `'down'` 前端已不产生（排序走拖拽 → `moveSkins`），仅为 `lib` 接口完整与既有单测保留。**宿主直返，不新增 IPC 通道** |
| 设置页→宿主 | `services.moveSkins(ids, index)` | — | **批量搬动画廊顺序**（`skins.moveSkins` 直通）。把 `ids` **按原列表相对顺序整体搬到 `index`**（非逐个搬），`index` 夹到 `[0, 剩余项数]`，返回 `{ok, moved, index}`（`moved:false` = 落点即原位或全被选中，非错误）；`current` 不受影响。**一趟读改写盘**：逐张调 `moveSkin` 会写盘 N 次，且先搬走的项会让后面落点偏移一格。卡头「置顶到最前」与拖拽落点都走它。**宿主直返，不新增 IPC 通道** |
| 设置页→宿主 | `services.removeSkins(ids)` | — | **批量删除形象**（`skins.removeSkins` 直通）。**一趟 `readRaw` / `writeRaw` 删完**，未知 id 计入 `failed`（不报错），返回 `{ok, removed, failed, current, left}`。删的是当前形象时：它已不在列表才把 `current` 交给剩下的第一张，一张不剩则置空。**逐张调 `removeSkin` 会 N 次全量读写、每趟重算 `current`、中间态可能落到马上要删的图上**；必须批量。成功且确有删除时推 `whale:skin`。**宿主直返，不新增 IPC 通道** |
| 设置页→宿主 | `services.downloadProgress()` | — | **素材包下载进度只读快照**（`download-progress.js` 的 `snapshot()` 直通）。返回 `{pack:'skins'\|'shared-skins'\|'shared-sounds', phase:'connect'\|'download'\|'verify'\|'install'\|'done'\|'failed', received, total, totalKnown, url, label, bytes, at}` 或 `null`（从未下载）。**宿主直返，不新增 IPC 通道**（与 `dshUsageSummary` / `codexSummary` 同构）。无推送通道，设置页下载期间 250ms `setInterval` 轮询（对齐 `dshProgress`），结束 + 终态保留 8s 后停表。**`snapshot()` 必须零副作用**；`pack` 让三张资源卡各显自己那份，`url` 是本次命中源完整地址（供复制），`label` 是阶段文案 |
| 设置页→宿主 | `services.removeSharedSound(file)` | — | **从共享音效库删一段**（`assets-packs.removeSharedSound` → `sounds.removeSound('shared', file)`）。入参是**落盘文件名**（非 name），取自 `listSharedSounds` 返回项的 `file`（`sharedSoundFiles()` 按 name 索引，仅已装项非空）。**`installed` 仍按 name 判定**（上游同名即同一段，`installBuiltin` 同名覆盖），`file` 只用于精确删除。**不再有任何「连带清理」**：共享段与实播槽位靠 `roles` 关联（同段落盘一份、挂件按 `roles` 随机播），删段即连同 `roles` 消失，返回 `{ok, error?}`。**宿主直返，不新增 IPC 通道** |
| 设置页→宿主 | `services.downloadSkinPackItem(id, prefix?, thumb?)` | — | **单张下载随包内置形象**（`skin-packs.downloadSkinPackItem` 直通）。「形象」卡下段点缩略图走它：只取这一张原图（`SKIN_PACK_RAW_ITEM_BASE` + `<id>.png`），源图在 `public/whale-pack/src/`（不进插件包 / Release 整包），逐张 sha256 过关后 `skins.installBuiltin(...)` 落盘并推 `whale:skin`。`id` 必须命中 `SKIN_PACK_SKINS`（决定 sha256），未知 id 直接 `{ok:false,error}`；`prefix` 同整批下载（设置页传 `cfg.skinPackSrc`，宿主不读）；`thumb` 是缩略图 data URL。**与整批下载的关键差异**：本方法**不是 async**（返回内部 `.then` 链、不 `await` 整批），不会与卡头「下载剩余 N 张」的 `busy` 守卫互等死锁。返回 `{ok, installed?, error?}`。**宿主直返，不新增 IPC 通道** |
| 子→父 | `whale:open-external` | `{url}` | 悬浮页**链接段**点击：`window.whale.openExternal(url)`（floating.js 透传）→ 宿主 `ipc.js` 校验 **`/^https?:\/\//` 只认 http(s)** —— `shellOpenExternal` 可执行任意协议，`file:` / `javascript:` 一律拒掉并 `logErr`，再走 `utools.shellOpenExternal(url)`。链接点击优先于其它点击分支，不受「点气泡推进」影响 |
| 设置页→宿主 | `services.dataDirs()` | — | **素材落盘目录**，返回 `{skins, sounds, bubbles}` 三个绝对路径（`skins.dir` / `sounds.dir` / `bubbles.dir`）。设置页「资源 → 资源概览 → 数据目录」展示，配合 `openDir` 打开；路径由宿主拼，设置页只展示。**宿主直返，不新增 IPC 通道** |
| 设置页→宿主 | `services.openDir(dir)` | — | 用系统文件管理器打开（`utools.shellOpenPath`）；空路径返回 `ok:false`。|
| 设置页→宿主 | `services.holidayStatus()` | — | **节假日表覆盖层状态**（`holidays.status()` 直通），返回 `{updated, fetchedAt, total, years, builtinYears, sources}`；设置页据此显示「已联网更新（N 天 / 年份…）」或「使用内置表」。**宿主直返，不新增 IPC 通道** |
| 设置页→宿主 | `services.holidayUpdate()` | — | **联网更新节假日表**（`holidays.update()` 直通）。拉当年 + 次年放假日子（多源回退、总预算 8s），与内置表并集后落 `whale:cnHolidays`，返回 `{ok, added, total, years, sources, failed, error?}`，**失败不抛**。**默认零网络**：只有点「更新节假日表」才发请求。**宿主直返，不新增 IPC 通道** |
| 设置页→宿主 | `services.holidayClear()` | — | **清除联网覆盖层、回到纯内置表**（`holidays.clear()` 直通），删 `whale:cnHolidays`。返回 `{ok:true}` |
| 设置页→宿主 | `services.todoGet()` | — | 待办快照只读（`store.readTodo()` 直通），返回 `{items,focusId}`；设置页打开 / 切回该卡时重拉 |
| 设置页→宿主 | `services.todoLimits()` | — | 返回 `{textMax:TODO_TEXT_MAX(60), max:TODO_MAX(200)}`。**避免设置页复制常量副本**：拿不到（老宿主）时 `limits` 为 `null`、不加 `maxlength`，不写死数字 |
| 设置页→宿主 | `services.todoAdd(text)` | — | 新增（`normTodoText` 折叠空白 + trim + 截断到 `TODO_TEXT_MAX`，空则 `{ok:false,error:'内容为空'}`），插入**最前**、`done:false`；成功后推快照 + 广播，返回 `{ok,todo?,error?}` |
| 设置页→宿主 | `services.todoRename(id, text)` | — | 行内改名（同口径归一化），`id` 不存在时不动，返回 `{ok,todo?,error?}` |
| 设置页→宿主 | `services.todoSetDone(id, done)` | — | 勾选 / 取消（`done` 只认 `=== true`）；标记完成时若正是 `focusId` 一并清空专注标记，返回 `{ok,todo?,error?}` |
| 设置页→宿主 | `services.todoRemove(id)` | — | 删除一条（同时清掉指向它的 `focusId`），返回 `{ok,todo?,error?}` |
| 设置页→宿主 | `services.todoClearDone()` | — | 清掉所有已完成项，返回 `{ok,todo?,error?}` |
| 设置页→宿主 | `services.todoFocus(id)` | — | 设置页点「专注」（**再点同一条即取消**，与挂件侧同语义），返回 `{ok,todo?,error?}` |
| 设置页→宿主 | `services.focusStats(days)` | — | **专注统计**（`focus.summarize(readFocus(), todayKey(), days)` 直通），返回 `{series:[{date,r,m}], today:{r,m}, total:{r,m}, streak, days}`：`series` 覆盖最近 `days` 天（含今天、升序、没记录补 0，便于直接画柱）、`total` 只算窗口内、`streak` = 从今天（今天没记录则从昨天）往前连续有记录的天数。`days` 缺省 / 非法回 7，夹 1–366；统计在宿主算，设置页只画 |
| 设置页→宿主 | `services.onTodoChange(cb)` | — | 订阅待办变更，回调收到最新 `readTodo()` 快照，返回退订函数；设置页改完不用自己重拉：挂件里勾选 / 切专注同样广播过来 |
| 设置页→宿主 | `services.onFocusChange(cb)` | — | 订阅专注记录变更（回调无参），返回退订函数；挂件上报一轮后设置页统计条刷新 |

余额 payload：成功 `{ok:true,totalBalance,grantedBalance,toppedUpBalance,currency,updatedAt,todayUsage,todayAdjust,isPeak,peakNextAt,usageMode:'ledger'|'token',adjust}`：
- `grantedBalance/toppedUpBalance` 取自 `balance_infos[]` 的 `granted_balance`/`topped_up_balance`（未返回为 `null`），用于赠送额度到期判定；`todayAdjust` = 今日「未计入用量」的余额下降合计。
- `adjust` **仅在本次采样判定出非消费下降时非空**（`{amount,why}`），供挂件气泡解释；写 `balanceCache` 前剥掉，避免 TTL 内复用 / 重建挂件时重复弹泡。
- `peakNextAt` = **下次峰谷切换的 epoch 秒**（`pricing.nextPeakChangeAt` 按 `constants.PEAK_HOURS` + 周末谷价 + 法定节假日，从下一整点起逐小时探测；取不到为 `0`）。挂件只按它换算「距峰时/谷时 1h20m」，页面不实现第二套时段规则。
- 每次成功采样后 `getBalancePayload` 调 `maybeNotifyAlerts` 判**三类**自动通知（预算、低余额、大幅波动）：
  - **预算 / 低余额**走 `notifyDaily(text, cfg, kind)`：**免打扰内跳过且不占当天名额**（`inQuietHours`，出时段后补发一次），否则按 `kind` 认领名额（`claimDailyNotice(kind)` → 账本 `budgetNotifiedOn` / `lowNotifiedOn`）后 `utools.showNotification`。
  - **大幅波动**走 `notifyNow(text, cfg)`：只受免打扰约束、**不认领名额**。判定用 `recordLedgerUsage` 返回的 `drop`（本轮余额下降总额，计不计入用量都算；跨天 / 换币种 / 换 Key 恒为 0，天然不误报），`drop ≥ dropAlertAmount` 才通知。不做每日去重：下降后基准随即更新，同一次下降只被采样一次。文案：正常消费报「今日已用」，被拦下的下降附 `adjust.why` 并注明「未计入今日用量」。
  挂件侧另有气泡提醒与常驻文案，与系统通知互不依赖。

失败 `{ok:false,code:'NO_KEY'|'BAD_KEY'|'AUTH'|'HTTP'|'PARSE'|'SHAPE'|'ERROR',error,transient?}`。

---
