## 七、网络与计费

**余额**（`fetchBalanceWith`）：超时 20s（`AbortSignal.timeout`）；网络错/超时/5xx 间隔 500ms 重试 1 次，4xx 不重试；401 读 `error.message` 给中文指引；`transient` 失败且有缓存时回退 stale。25s 缓存 + in-flight 去重；手动刷新（`whale:refresh {manual:true}`）跳缓存（进行中仍复用同一 Promise）。除 `total_balance`/`currency` 外**透传 `granted_balance`、`topped_up_balance`**（可能缺失 → `null`），供记账判「赠送额度整块消失」。

**记账**（`recordLedgerUsage(currentBalance, currency, extra)`）：每次成功观测后执行；同日余额下降累加差值，上升（充值）不扣；**换币种或换 Key 只重置基准**（Key 用 `keyFingerprint` = sha1 前 8 位）；跨天归档归零。`extra = {granted, toppedUp, keyId}`。三条例外（**不计入 todayUsage**，改累加 `todayAdjust` + 记 `adjustLog`，由 `getBalancePayload` 下发 `adjust` 气泡）：

1. **赠送额度整块到期/被收回**：上次有 `lastGranted`，本次 `granted` 近 0（`granted <= max(0.05, pg*0.02)`），且 `gone = pg - granted >= delta - 0.05` → 平台收回，不是消费。
2. **短时间异常跳变**：`limit = max(20, 5 * gapSec/3600)`（`USAGE_JUMP_LIMIT=20`、`USAGE_JUMP_RATE=5`；`gapSec` = `lastSampleAt` 到本次间隔，旧账本无该字段按 60s），`delta > limit` → 只重置基准。
3. （`currencyChanged || keyChanged` 走基准重置，不进累加。）

分项余额 / Key 指纹 / 采样时间始终更新为下一轮基准。`calibrateTodayUsage(amount)`：**手动校准今日已用**，只改 `todayUsage` 并追加 `calibrateLog`，**不动余额基准**；负数/非数字拒绝；令牌模式下平台返回值会覆盖，故设置页只在记账模式显示。

**实时令牌**（`fetchPlatformUsage` + `computeTodayUsage`）：
- URL `https://platform.deepseek.com/api/v0/usage/by_api_key/amount?start=<本地零点unix>&end=<+86400>&tz=<偏移秒>`，`Bearer <token>`（自动去前缀），15s 超时。
- 解析 `data.biz_data.series[]`（兼容 `data.series`），每 series `{model,buckets:[{time,usage:{RESPONSE_TOKEN,PROMPT_CACHE_HIT_TOKEN,PROMPT_CACHE_MISS_TOKEN}}]}`；只给 token 不给金额。
- `computeTodayUsage` **按 `model` 聚合金额**（`byModel`：`{model,amount,tokens}` 按金额降序），与总额共用 `priceFor(model)` + `isPeakTime(b.time)`（`sum(byModel.amount) === amount`）；`model` 缺失归空名。`fetchPlatformUsage` 透传 `{amount,tokens,byModel}`。
- **今日模型占比**：只在 `usageMode==='token'` 时渲染（记账模式拿不到明细）。`settings.getTodayModels()` 复用 `fetchPlatformUsage`，返回 `{ok,models,amount,tokens}`；无 Token 返回 `{ok:false,error:'未配置平台 Token'}`。页面在 `onMounted` / 切模式 / 窗口重新可见时各拉一次，不进轮询。
- **三态契约**（`getTodayModels` / `testPlatformToken` 都只认）：① 成功 → 有 `amount`（+`tokens`/`byModel`）；② **空态** → `error === 'no usage'`（**硬契约字面量，不许改**），调用方返回空列表 / `empty:true`，**不得当失败透传**；③ 失败 → 其余 `error`，**一律中文**：`NO_TOKEN`→「未配置平台 Token」、401→「平台 Token 无效或已过期」、`<500`→「用量接口返回 HTTP <码>」、5xx/网络失败重试后→「暂时不可用 / 网络请求失败」、非 JSON→「不是合法 JSON」；**不得把 `http 401` / `fetch failed` 甩给用户**。返回体另带 `code`/`transient`。空态与中文化有单测（`test/models-today-empty.test.mjs`）。
- 峰谷：北京时间**周一至周五（不含法定节假日）9–12、14–18** 为峰，其余（含周末）全谷；`CN_HOLIDAYS`（`constants.js` 内置 `YYYY-MM-DD` 表）里的节假日全天谷价。表只列「实际放假」的日子（调休补班的周末已按周末判谷）；跨年未收录时按普通工作日算（只会高估，不会少计），此时 `pricing.warnIfHolidayCalendarStale` 记日志；结构与「均判谷价」由 `test/pricing.test.mjs` 静态校验。
- 成功后 `setTodayUsage(amount)` 写入账本 `todayUsage`：趋势图 / 导出 / 今日已用都取账本，不写会与挂件不一致。返回值即账本本身（写成功时不带 `ok`），**存储写失败时补 `ok:false`**；`recordLedgerUsage` 同口径。二者任一失败都会在余额 payload 上打 `ledgerSaveFailed: true`——数字照常显示，但重启后会退回旧值，界面据此提示，不把「没存上」说成成功。

**定价表**（每百万 token，CNY，谷/峰）：

| 模型 | 缓存命中 | 缓存未命中 | 输出 |
|---|---|---|---|
| `deepseek-flash`（DeepSeek-V4.1-Flash，当前模型名） | 0.02 / 0.04 | 1 / 2 | 4 / 8 |
| `deepseek-v4-flash` / `deepseek-v4-flash-vision-exp`（旧名） | 0.02 / 0.04 | 1 / 2 | 4 / 8 |
| `deepseek-chat` / `deepseek-reasoner` | 0.02 / 0.04 | 1 / 2 | 4 / 8 |
| `deepseek-v4-pro` | 0.15 / 0.3 | 4.5 / 9.0 | 13.5 / 27.0 |

子串匹配（`lib/pricing.js` 的 `priceFor`，**键顺序即优先级**，新名写在同前缀旧名之前）；未知走 `_default` 并 `logErr`（同模型名只记一次）：官方改名会静默按 Flash 价少算，留痕便于发现。调价改 `lib/constants.js` 的 `PEAK_HOURS/PRICING`。

**自定义单价**（`TOKEN_PRICE_DEFAULT`，仅令牌模式生效）：覆盖内置价目表，用于官方调价没跟上或中转站按自己价目结算。

- `cfg.tokenPrice = { on, cur, rate, hit, miss, out, models }`，存 `whale:config`（随备份走）。`on=false` 时字段照样存。`models` = 按模型覆盖表 `[{name,hit,miss,out}]`（≤ `TOKEN_PRICE_MODELS_MAX = 20` 条），`name` 子串匹配，空名被 `normPriceModels` 丢掉。
- 填**谷价**，峰价按官方规则（谷价 × 2）补齐；`cur='USD'` 时按 `rate`（元/USD）折人民币：**账本与挂件统一人民币**，与「余额按原币种展示」是两回事。币种与汇率全局共用（`tokenPrice.cur/rate`）。
- 取价**三级顺序**：`customModelPrice(custom, model) || customPriceTable(custom) || priceFor(model)`：前者没命中继续往下。全局 `on=false` 或 `cur='USD'` 拿不到正汇率时都返回 `null` 回落内置表（不能把美元当人民币记账）。
- 归一化：`lib/store.js` 的 `normTokenPrice`（单价 0–`TOKEN_PRICE_MAX`，汇率 0–`TOKEN_RATE_MAX`，单价 0 = 不收费属合法值）、`normPriceModels`（截断、丢空名）。**`models` 是数组，`defaultConfig()` / `normTokenPrice(null)` 都要单独给新数组实例**（`{...DEFAULT}` 浅拷贝共用同一数组、就地改坏默认值）。
- 改动后设置页立即重拉「今日模型占比」；挂件侧要等下次余额刷新（`BALANCE_TTL_MS` 内不重拉）。

**多厂商模型查询**（`fetchModelBalance` / `refreshModels`）：与 DeepSeek 完全独立：**不记账、不写账本、不影响峰谷/预算/额度**，只「查一次、展示、可选低余额通知」。

- 超时 `MODEL_FETCH_TIMEOUT_MS`(15s)；网络错/超时/5xx 间隔 500ms 重试 1 次，401/403 给「API Key 无效或无权限」，4xx 不重试。
- 认证：`auth='bearer'` → `Authorization: Bearer {key}`；`auth='raw'` → `Authorization: {key}`（智谱那类不带 Bearer）。
- **字段路径** `pickPath(obj, 'a.b[0].c')` 支持点号 + 数组下标，数组段可按字段挑条目（`a[currency=CNY].b` 取第一个 `a[i].currency === 'CNY'`），可混用（`a[x=1][0].b`）。任一段缺失返回 `undefined`（与「取到 `null`」区分）。`pathNum` 把 `null/undefined/空串` 当「没取到」：**`Number('')` 是 0**，直接用会把空值误判成 0。按字段挑条目用于多币种数组：DeepSeek 的 `balance_infos` 同时给 CNY / USD 且**顺序不固定**，写死 `[0]` 可能取到美元；条件不匹配返回 `undefined`，页面提示「字段取不到数值」。
- **余额型**（`kind='balance'`）：`path` × `scale`；配 `usedPath`（可另配 `usedUrl` 走第二接口）则相减：OpenRouter 只给「总额度 + 已用」；OpenAI 兼容中转站的「已用」单位是美分（`usedScale: 0.01`）。
- **额度型**（`kind='quota'`）：三种形态归一成「已用 % + 重置时刻」：`usedPctPath` 直接给已用%、`remainPctPath` 给剩余%（`100 - v`）、`remainPath + totalPath` 算 `100 - r/t*100`。`normResetAt` 把秒/毫秒/微秒时间戳与 ISO 串归一到毫秒。**多窗口接口**（OpenCode Go 5h/周/月、MiniMax 5h/周）配 `windows[]`（字段同顶层，另加 `key`/`label`），`parseModelQuota` 逐窗口归一，**首个窗口同时写顶层 `usedPct`/`resetAt`**：既有单窗口链路（挂件主显示）不用改。
- **Codex 本地会话型**（`kind='codex'`）：**不查接口、不要密钥**，走 `parseModelCodex()` → `lib/codex.js` 的 `codexSummaryEnsured(2500)`（有界等待一次真实扫描；**不能用 `codexSummaryCached`**，那会把过期快照里的旧 token 当成新结果落库），把「今日/本月 token」写进运行时状态（`tokens`/`monthTokens`，复用余额栏，单位不是钱）。**等不到（首次扫描超 2.5s 预算）时 `parseModelCodex` 返回 `{ok:false, transient:true}`，`refreshModels` 见此 `continue` —— 不写 `st[m.id]`、不写 `at`**，否则挂件会在扫描期间闪一下「统计失败」，且 `at` 一写又会让 `force=false` 的懒加载在 `MODEL_STALE_MS` 内跳过重试。设置页隐藏 Key / 地址 / 字段路径 / 币种 / 低余额提醒；挂件大字显示今日 token、说明行给本月累计，菜单行同按 token。不参与余额、记账与预警。`codexSummary()` 另返回**订阅窗口** `windows`（`rate_limits` 归一化，无订阅为 `null`），只由「Codex 会话统计」卡消费（`App.vue` 的 `codexWindowsText`），不进运行时状态与挂件。
- **Codex 扫描已是全异步**（`lib/codex.js`）：`fs.promises` 读 + 逐文件 `await yieldLoop()` 切片（`CODEX_YIELD_MS`），单文件 32MB / 单轮 400 文件 / 96MB 预算（超了标 `deferred` 并 5 秒后自动补扫）。对外三个入口的语义：`codexSummary()` 返回 Promise（设置页「刷新」按钮 await 它）、`codexSummaryCached()` 同步返回快照（可能 `null` / 过期，过期时顺手在后台补一次，**永不阻塞**）、`codexSummaryEnsured(ms)` 有界等待。**因为所有 IPC handler 与 `sendToWidget` 都是同步的，任何同步调用方只能用 `Cached` 变体；直接把 `codexSummary()` 的返回值当结果对象用会得到 `r.ok === undefined`。** 前端的 `codexRefreshRun` 因此是 `async` 并 `await` 它，`deferred` 时在提示后补一句「其余下轮补扫」。退出清理走 `codex.dispose()`（只停 `resumeTimer` 与退订，**不删缓存**，与 `clearCodexCache` 区分），由 `services.js` 的 `onPluginOut(isKill)` 统一调度。
- `{base}` 用 `baseUrl` 替换；未替换直接报「请先填写 Base URL」，不发请求。
- `refreshModels(ids, force)`：`ids` 省略 = 全部；`force=false` 且距上次拉取不足 `MODEL_STALE_MS`(5min) 跳过（挂件菜单懒加载靠它节流）。内置 DeepSeek 不走此循环。结果写 `whale:models`，成功后 `getModelsPayload()` 推给挂件。**单条查询失败不会让整批失败**（错误只记进该模型的 `error`），故宿主回 `{ok, errors:[{id,name,error}]}` —— 设置页按这份清单提示「哪几个没查到」，而不是笼统报「已刷新」。
- **低余额通知**（`notifyModelLow`）：每模型独立阈值（`lowAlertOn/lowAlertAmount`，新建按 `LOW_ALERT_BY_CURRENCY` = CNY 10 / USD 2）。与 `maybeNotifyLow` 同口径：`inQuietHours` 内不占当天名额（不写 `lowNotifiedOn`，出时段补发），否则认领名额后 `utools.showNotification`。

---
