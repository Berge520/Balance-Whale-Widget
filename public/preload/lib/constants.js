/*
 * 常量集中定义（CommonJS）。
 *
 * 注意：PLUGIN_VERSION 由 scripts/sync-version.mjs 在构建前从 package.json 的
 * version 自动写入本文件，请勿手动维护。
 */
const BALANCE_URL = 'https://api.deepseek.com/user/balance'
const USAGE_URL = 'https://platform.deepseek.com/api/v0/usage/by_api_key/amount'
const BALANCE_TTL_MS = 25000
const FETCH_TIMEOUT_MS = 20000

// 检查更新：拉取远端 package.json（经 ghfast 加速），只取 version 字段做比对
const UPDATE_CHECK_URL = 'https://ghfast.top/https://raw.githubusercontent.com/Berge520/Balance-Whale-Widget/refs/heads/main/package.json'
// 当前插件版本。uTools 未提供读取插件自身版本的 API，此处由 scripts/sync-version.mjs
// 在构建前从 package.json 的 version 自动写入，无需手动维护
const PLUGIN_VERSION = '1.7.0'
const UPDATE_TTL_MS = 12 * 3600 * 1000

const MIN_SCALE = 0.6
const MAX_SCALE = 2.5

// dsh 版本配置的哨兵值：dshVersion 存它表示「装版本列表里最高的那个（含 alpha/rc 等测试版）」，
// 而不是 npm 的 latest 标签（latest 只指向稳定发布）。宿主 store/dsh 与设置页都要认它，
// 设置页持有一份字面量副本（见 App.vue 的 NEWEST_VERSION），改这里要同步，check-shared 会校验。
const NEWEST_VERSION = 'newest'

const BASE_MIN = 122   // 挂件基准尺寸下限 px
const BASE_CAP = 250   // 视口相关基准上限 px
const BASE_MAX = 625   // 挂件基准尺寸硬上限 px
// 窗口在挂件本体「四周各」多出的透明留白 px（窗口边长 = 挂件本体 + 2×WIN_PAD）：
// 汉堡菜单要在按钮上/下方展开，窗口必须比挂件本体大，否则菜单会被窗口边缘裁掉；
// 四周都给留白，挂件贴屏幕上边时菜单才能改向下方展开（见 floating-page.js 的 positionMenu）。
// 留白区全透明，靠 setIgnoreMouseEvents 点击穿透。
// 必须与 floating.css 里的 --whale-pad 保持一致。
const WIN_PAD = 200

// DeepSeek CNY 价格（每百万 token）：[空闲时段价, 高峰时段价]
// 高峰：工作日 9:00–12:00、14:00–18:00（北京时间）；2026-08-23 起周末全天谷价
// 官方调价只改这里；「实时·令牌」模式的今日已用按本表换算（见 lib/pricing.js 的 priceFor）。
// 模型名按子串匹配，键的顺序即优先级，新名要写在同前缀的旧名之前。
const PEAK_HOURS = [[9, 12], [14, 18]]
const BASE_PRICE = { hit: [0.02, 0.04], miss: [1, 2], out: [4, 8] }
const PRO_PRICE = { hit: [0.15, 0.3], miss: [4.5, 9.0], out: [13.5, 27.0] }
const PRICING = {
  'deepseek-flash': BASE_PRICE,               // 当前模型名（DeepSeek-V4.1-Flash）
  'deepseek-v4-flash': BASE_PRICE,            // 旧名，请求已由 V4.1-Flash 提供，仍按 Flash 价计费
  'deepseek-v4-flash-vision-exp': BASE_PRICE, // 同上
  'deepseek-v4-pro': PRO_PRICE,
  'deepseek-chat': BASE_PRICE,
  'deepseek-reasoner': BASE_PRICE,
  _default: BASE_PRICE,
}
// = 北京时间 2026-08-23 00:00
const WEEKEND_VALLEY_FROM_SEC = Math.floor(Date.UTC(2026, 7, 22, 16, 0, 0) / 1000)

// 中国法定节假日（含调休放假日）全天谷价：这些日子虽是周一至周五，官方也按谷价计费。
// 键为北京时间 YYYY-MM-DD。只列「实际放假」的日子 —— 调休上班的周末（补班日）本来就在周末分支里
// 被判成谷价，不影响；而放假当天落在工作日时才需要这张表来纠正。
// 注意：与 WEEKEND_VALLEY_FROM_SEC（周末谷价的生效点）无关，节假日表不分生效点、一直生效。
// 依据国务院办公厅 2026 年部分节假日安排（元旦 / 春节 / 清明 / 劳动 / 端午 / 中秋 + 国庆）。
// 官方次年安排通常在头一年 11 月前后公布，届时在此追加即可（跨年查不到就按普通工作日算，
// 只会把少数的放假工作日按峰价高估，不会少计）。
const CN_HOLIDAYS = new Set([
  // 元旦
  '2026-01-01', '2026-01-02', '2026-01-03',
  // 春节（除夕 02-16 起）
  '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20',
  '2026-02-21', '2026-02-22', '2026-02-23', '2026-02-24',
  // 清明
  '2026-04-04', '2026-04-05', '2026-04-06',
  // 劳动
  '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
  // 端午
  '2026-06-19', '2026-06-20', '2026-06-21',
  // 中秋
  '2026-09-25', '2026-09-26', '2026-09-27',
  // 国庆
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05',
  '2026-10-06', '2026-10-07', '2026-10-08',
])

// 「实时·令牌」模式的自定义单价（可选，见设置页「用量与账本」）：按百万 token 填价，覆盖上面的内置价目表。
// 填的按谷价处理，峰价沿用官方规则（恰为谷价 2 倍）自动翻倍；币种选 USD 时按 rate（元/USD）换算成
// 人民币后再记账 —— 账本与挂件显示统一按人民币，不受填的是哪种币影响。
// models 是「按模型覆盖」的条目（{ name, hit, miss, out }，name 按子串匹配，与内置表同规则）：
// 命中的模型用它，没列出的仍走内置价目表；两种覆盖可分别使用，同时存在时按模型优先（见 lib/pricing.js）。
const TOKEN_PRICE_DEFAULT = { on: false, cur: 'CNY', rate: 7.2, hit: 0.02, miss: 1, out: 4, models: [] }
// 单价与汇率上限：防手滑多打几个 0 算出荒谬金额（正常单价都在个位/十位数）
const TOKEN_PRICE_MAX = 1000000
const TOKEN_RATE_MAX = 1000
// 「按模型覆盖」的条目数上限：够覆盖常见几档模型，也挡住整段粘贴
const TOKEN_PRICE_MODELS_MAX = 20

// ──────────────────────────────────────────────
// GitHub 加速（hosts 方案，见 lib/hosts.js）
// ──────────────────────────────────────────────
// 只挑日常访问 GitHub 的高频域名；域名表同时被 store.js（normIps 归一化）与
// hosts.js（写块 / 冲突扫描 / 刷新）引用，放常量避免两份清单漂移。
// 各域名都要单独做 DoH 解析 + 可达性探测（每域名多候选），列表越长开启越慢。
// 因此只保留「实际下载 / 拉取代码必经」的域名；下面这几个已移除，理由是访问频率极低：
//   education.github.com / resources.github.com / archiveprogram.github.com / githubapp.com
// / uploads.github.com —— 上传 release 资产才会用到，日常 clone / pull 不经过
// 移除后这些域名不再加速（退回系统 DNS），但也不会比不开启更糟。
const GH_DOMAINS = [
  'github.com',
  'api.github.com',
  'raw.githubusercontent.com',
  'objects.githubusercontent.com',
  'codeload.github.com',
  'github.githubassets.com',
  'avatars.githubusercontent.com',
  'user-images.githubusercontent.com',
  'camo.githubusercontent.com',
  'github.global.ssl.fastly.net',
  'github.dev',
  'githubusercontent.com',
  'github.io',
  // gist 单独补上：之前遗漏。gist.github.com 是页面入口，
  // gist.githubusercontent.com 是 gist 内容（代码片段 / raw 文件）的实际落点，
  // 少了后者照样打不开 gist 内容；两个都要。源表（GitHub520）覆盖这两个域名。
  'gist.github.com',
  'gist.githubusercontent.com',
  // 非 GitHub 域名：GitHub520 源不覆盖，只能靠写入前探测（可达才写），可用设置页 IP 表手动加
  'huggingface.co',
  'hub.docker.com',
  'greasyfork.org',
]
// 一键刷新用的社区源（GitHub520 每日更新 hosts）；仅解析上面关心的域名
const GH520_HOSTS_URL = 'https://raw.hellogithub.com/hosts'


const K = {
  secrets: 'whale:secrets', // dbCryptoStorage：{ apiKey, platformToken, models }
  config: 'whale:config',   // dbStorage：挂件配置
  ledger: 'whale:ledger',   // dbStorage：本地账本
  win: 'whale:window',      // dbStorage：窗口锚点
  update: 'whale:update',   // dbStorage：上次检查更新结果缓存
  timer: 'whale:timer',     // dbStorage：计时状态（重建挂件后恢复）
  dshVersions: 'whale:dshVersions', // dbStorage：dsh 可用版本列表缓存（查询结果，重载后仍可选用）
  sounds: 'whale:sounds',   // dbStorage：自定义音效元信息，六槽位 press/release/low/budget/peak/pass 各 {name,ext,at}|null
  skins: 'whale:skins',     // dbStorage：自定义挂件形象画廊 { items: [{ id, name, ext, at }], current: id }
  bubbles: 'whale:bubbles', // dbStorage：自定义气泡图片（点鲸鱼时随机显示一张）[{ id, name, ext, at }]
  models: 'whale:models',   // dbStorage：多厂商模型的运行时状态（余额/今日已用/额度，不进备份）
  codex: 'whale:codex',     // dbStorage：Codex 会话统计缓存（各文件 size/mtime + 聚合，不含凭据）
  dshUsage: 'whale:dshUsage', // dbStorage：dsh 用量统计缓存（会话缓存的 size/mtime + 解析结果，不含凭据）
  dshDiagnose: 'whale:dshDiagnose', // dbStorage：dsh 只读诊断结果缓存（60s TTL，纯派生数据，不进备份）
  dshDump: 'whale:dshDump',     // dbStorage：dsh 配置转储（五层分层 + 树 diff）缓存（60s TTL，纯派生数据，不进备份）
  dshMarket: 'whale:dshMarket', // dbStorage：插件市场目录的**离线兜底**副本（官方/镜像都挂时仍能看上次的目录）
}

// ──────────────────────────────────────────────
// 多厂商模型（余额 / 额度）
// ──────────────────────────────────────────────
// 最多可添加的模型数（含内置 DeepSeek）
const MODEL_MAX = 10
// 主显示模型默认值 = 内置 DeepSeek
const DEFAULT_MAIN_MODEL = 'deepseek'
// 币种显示前缀。余额一律按原币种展示，不做汇率换算。
// CNY 带一个空格、USD 不带，是为了和挂件原有的 DeepSeek 显示（¥ 12.34）保持一致；
// 挂件页面里有一份同内容的兜底副本（浮动页没有 require，读不到这里）。
const MODEL_MONEY_PREFIX = { CNY: '¥ ', USD: '$' }
// 新建模型时按币种给的预警阈值初值（元 / 美元）
const LOW_ALERT_BY_CURRENCY = { CNY: 10, USD: 2 }
// 认证方式：'bearer' → Authorization: Bearer {key}；'raw' → Authorization: {key}（智谱那类不带 Bearer）
const MODEL_AUTHS = ['bearer', 'raw']
// 单次查询超时与「打开菜单后多久算过期」的懒加载间隔
const MODEL_FETCH_TIMEOUT_MS = 15000
const MODEL_STALE_MS = 5 * 60 * 1000
// 计时到点留言的长度上限。宿主清洗、菜单输入框 maxLength（floating-page.js 的 TIMER_NOTE_MAX）
// 与设置页输入框三处同值，改要一起改
const TIMER_NOTE_MAX = 60

// 内置厂商模板：选中后自动带好 URL / 认证 / 字段路径 / 币种，用户可再改。
// 只收录「能用 API key 直接查到余额或订阅额度」的厂商 —— 其余厂商官方没有这类接口，
// 而本插件拦不到对话事件、无法像 DSH 版那样按会话估算用量，搬过来只会是个空壳。
// kind='quota' 表示订阅额度（接口给的是窗口用量%，不是钱）；'balance' 表示余额（钱）；
// 'codex' 是本机 Codex 会话统计（读 ~/.codex 的会话日志，单位是 token，不查接口也不要密钥）。
// 字段路径支持 a.b[0].c 形式（数组段也可按字段挑条目：a[currency=CNY].b）；scale 是取到值之后的乘数（接口单位与展示单位不一致时用）。
const MODEL_TEMPLATES = {
  deepseek: {
    name: 'DeepSeek', kind: 'balance', currency: 'CNY', builtin: true,
    url: 'https://api.deepseek.com/user/balance', auth: 'bearer',
    // balance_infos 会同时给多种币种且顺序不固定，按 currency 挑，别写下标（取到美元余额不会报错）
    path: 'balance_infos[currency=CNY].total_balance',
  },
  openrouter: {
    name: 'OpenRouter', kind: 'balance', currency: 'USD',
    url: 'https://openrouter.ai/api/v1/credits', auth: 'bearer',
    // 该接口只给「总额度」和「已用」，余额得两者相减
    path: 'data.total_credits', usedPath: 'data.total_usage',
  },
  moonshot: {
    name: 'Kimi / Moonshot（CN）', kind: 'balance', currency: 'CNY',
    url: 'https://api.moonshot.cn/v1/users/me/balance', auth: 'bearer',
    path: 'data.available_balance',
  },
  moonshot_intl: {
    // 国际站是独立账号体系（key 与大陆站不通用），余额按美元计
    name: 'Kimi / Moonshot（国际）', kind: 'balance', currency: 'USD',
    url: 'https://api.moonshot.ai/v1/users/me/balance', auth: 'bearer',
    path: 'data.available_balance',
  },
  stepfun: {
    name: '阶跃星辰 StepFun', kind: 'balance', currency: 'CNY',
    url: 'https://api.stepfun.com/v1/accounts', auth: 'bearer',
    path: 'balance',
  },
  novita: {
    name: 'Novita AI', kind: 'balance', currency: 'USD',
    url: 'https://api.novita.ai/v3/user/balance', auth: 'bearer',
    // 接口返回的金额单位是 0.0001 美元
    path: 'availableBalance', scale: 0.0001,
  },
  zhipu_glm_coding: {
    name: '智谱 GLM Coding（订阅）', kind: 'quota', currency: 'CNY',
    url: 'https://open.bigmodel.cn/api/monitor/usage/quota/limit',
    auth: 'raw', // 智谱此接口不带 Bearer
    usedPctPath: 'data.limits[0].TOKENS_LIMIT.percentage',
    resetPath: 'data.limits[0].nextResetTime',
  },
  kimi_coding: {
    name: 'Kimi Coding（订阅）', kind: 'quota', currency: 'CNY',
    url: 'https://api.kimi.com/coding/v1/usages', auth: 'bearer',
    // 接口给的是「剩余量 + 总量」，已用百分比由两者算出
    remainPath: 'usage.remaining', totalPath: 'usage.limit', resetPath: 'usage.resetTime',
  },
  minimax_coding: {
    name: 'MiniMax Coding（订阅）', kind: 'quota', currency: 'CNY',
    url: 'https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains', auth: 'bearer',
    // 接口一次给 5h 与周两个窗口，走多窗口路径（见 api.js parseModelQuota）
    windows: [
      { key: 'interval', label: '5h', remainPctPath: 'model_remains[0].current_interval_remaining_percent', resetPath: 'model_remains[0].end_time' },
      { key: 'weekly', label: '周', remainPctPath: 'model_remains[0].current_weekly_remaining_percent' },
    ],
  },
  minimax_coding_intl: {
    // 国际站是独立账号体系（key 与大陆站不通用），余额按美元计
    name: 'MiniMax Coding（国际）', kind: 'quota', currency: 'USD',
    url: 'https://api.minimax.io/v1/api/openplatform/coding_plan/remains', auth: 'bearer',
    windows: [
      { key: 'interval', label: '5h', remainPctPath: 'model_remains[0].current_interval_remaining_percent', resetPath: 'model_remains[0].end_time' },
      { key: 'weekly', label: '周', remainPctPath: 'model_remains[0].current_weekly_remaining_percent' },
    ],
  },
  opencode_go: {
    name: 'OpenCode Go（订阅）', kind: 'quota', currency: 'USD',
    // 鉴权只需 Authorization: Bearer <key>（2026-09 实测：x-api-key 单独使用返回 401）
    url: 'https://opencode.ai/zen/go/v1/usage', auth: 'bearer',
    // 一次返回 rolling / weekly / monthly 三个窗口，值都是「已用百分比 + 重置时刻」
    windows: [
      { key: 'rolling', label: '5h', usedPctPath: 'usage.rolling.percent', resetPath: 'usage.rolling.resetsAt' },
      { key: 'weekly', label: '周', usedPctPath: 'usage.weekly.percent', resetPath: 'usage.weekly.resetsAt' },
      { key: 'monthly', label: '月', usedPctPath: 'usage.monthly.percent', resetPath: 'usage.monthly.resetsAt' },
    ],
  },
  zhipu_glm_coding_intl: {
    // 与国内站同构，只是域名不同、按美元计；鉴权同样不带 Bearer
    name: '智谱 GLM Coding（国际 z.ai）', kind: 'quota', currency: 'USD',
    url: 'https://api.z.ai/api/monitor/usage/quota/limit', auth: 'raw',
    usedPctPath: 'data.limits[0].TOKENS_LIMIT.percentage',
    resetPath: 'data.limits[0].nextResetTime',
  },
  codex: {
    // 本机 Codex 会话统计：不查接口、也不要密钥，读 ~/.codex 下的会话日志（见 lib/codex.js）。
    // 挂件把它当「余额」那一栏用，只是单位换成 token
    name: 'Codex（本地会话）', kind: 'codex', currency: 'USD',
  },
  openai_compat: {
    name: 'OpenAI 兼容中转站', kind: 'balance', currency: 'USD', needsBaseUrl: true,
    // OneAPI / New API 一类网关的经典账单接口：额度（美元）+ 已用（美分）
    url: '{base}/v1/dashboard/billing/subscription', auth: 'bearer',
    path: 'hard_limit_usd',
    usedUrl: '{base}/v1/dashboard/billing/usage', usedPath: 'total_usage', usedScale: 0.01,
  },
  custom: {
    // 兜底项：URL 与字段路径全部手填
    name: '自定义 HTTP', kind: 'balance', currency: 'CNY',
    url: '', auth: 'bearer', path: '',
  },
}

module.exports = {
  BALANCE_URL,
  USAGE_URL,
  BALANCE_TTL_MS,
  FETCH_TIMEOUT_MS,
  UPDATE_CHECK_URL,
  PLUGIN_VERSION,
  UPDATE_TTL_MS,
  MIN_SCALE,
  MAX_SCALE,
  NEWEST_VERSION,
  BASE_MIN,
  BASE_CAP,
  BASE_MAX,
  WIN_PAD,
  PEAK_HOURS,
  PRICING,
  WEEKEND_VALLEY_FROM_SEC,
  CN_HOLIDAYS,
  TOKEN_PRICE_DEFAULT,
  TOKEN_PRICE_MAX,
  TOKEN_RATE_MAX,
  TOKEN_PRICE_MODELS_MAX,
  GH_DOMAINS,
  GH520_HOSTS_URL,
  K,
  MODEL_MAX,
  DEFAULT_MAIN_MODEL,
  MODEL_MONEY_PREFIX,
  LOW_ALERT_BY_CURRENCY,
  MODEL_AUTHS,
  MODEL_FETCH_TIMEOUT_MS,
  MODEL_STALE_MS,
  TIMER_NOTE_MAX,
  MODEL_TEMPLATES,
}
