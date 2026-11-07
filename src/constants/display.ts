// 自定义显示相关常量：Tab/卡片白名单、依赖关系等
// 从 App.vue 抽出，供 DisplayManager.vue 等组件共享

export type TabKey = 'look' | 'window' | 'usage' | 'assets' | 'data' | 'help' | 'dev'

export const TABS: readonly { key: TabKey; label: string; desc: string; devOnly?: boolean }[] = [
  { key: 'look', label: '外观', desc: '挂件外观 · 设置页视觉 · 按压气泡' },
  { key: 'usage', label: '用量', desc: '用量与账本 · 模型与余额 · 提醒与通知 · 专注与待办（含计时设置） · 下班倒计时' },
  { key: 'assets', label: '资源', desc: '我的素材：资源概览 · 背景与片头 · 气泡图 ｜ 下载素材：形象 · 音效' },
  { key: 'data', label: '数据', desc: 'DeepSeek 凭据 · 备份与恢复 · 清除数据' },
  { key: 'window', label: '窗口', desc: '挂件窗口：显隐 · 位置 · 透明度 · 穿透' },
  { key: 'help', label: '帮助', desc: '使用帮助 · 关于与更新 · GitHub 加速' },
  { key: 'dev', label: '开发者', desc: 'DeepSeek Harness（dsh） · dsh 环境诊断 · dsh 配置转储 · dsh 全量导出 · dsh 用量统计 · dsh 插件开关 · dsh 插件市场 ｜ Codex 会话统计', devOnly: true },
]

export const SEARCH_INDEX: Record<string, { label: string; tab: TabKey; keys: string }> = {
  credentials: { label: 'DeepSeek 凭据（API Key / 平台 Token）', tab: 'data', keys: 'apikey api key 密钥 token 令牌 凭据 授权 余额 认证' },
  look: { label: '挂件外观', tab: 'look', keys: '形象 皮肤 音色 音效 音量 大小 缩放 气泡 主题 报时 点按 播放 界面 深浅色 深色 浅色 暗色 亮色 跟随 uTools 未至之境 深海 深蓝 幻想 fantasy 预览 峰谷 文案 随机 节假日 法定节假日表 更新' },
  pageVisual: { label: '设置页视觉', tab: 'look', keys: '设置页 背景 氛围 光晕 极光 星海 薄雾 极夜 暖光 画廊 视频 壁纸 鲸鱼娘 下载 片头 启动 开机 动画 纯净播放 纯净 遮罩 模糊 亮度 暗角 适配 焦点 缩放 智能 预览 自定义 媒体 纯 CSS 系统动画' },
  bubbleCustom: { label: '按压气泡（自定义泡泡）', tab: 'look', keys: '按压气泡 自定义泡泡 泡泡 气泡 编辑 撤销 重做 队列 排序 步骤 模块 行 文本 报时 余额 赠金 充值 今日 峰谷 对话名 随机 超链接 图片 动图 额度 订阅 试播 预览 开关 思考 点我 点击 停留' },
  assetsOverview: { label: '资源概览', tab: 'assets', keys: '素材 形象 音效 气泡图 背景 片头 媒体 占用 体积 清除 未使用 素材包 导出 导入' },
  assetsMedia: { label: '背景与片头', tab: 'assets', keys: '背景 片头 媒体 图片 视频 壁纸 导入 删除 遮罩 模糊 亮度 自定义' },
  assetsSkins: { label: '形象', tab: 'assets', keys: '形象 皮肤 图片 缩略图 置顶 删除 导入 内置 下载源 共享 角色 下载 选用 预览 随机' },
  assetsBubbles: { label: '导入的气泡图', tab: 'assets', keys: '气泡 图 动图 gif 图片 导入 删除' },
  assetsSounds: { label: '音效', tab: 'assets', keys: '音效 声音 按压 释放 提醒音 试听 导入 删除 共享音效库 共享 下载 段 筛选 过滤 搜索 候选 已参加播放 一段都没挂 下载源' },
  usage: { label: '用量与账本', tab: 'usage', keys: '用量 趋势 账本 历史 区间 导出 csv 导入 校准 额度 单价 模型占比 明细 币种 汇率 保留' },
  models: { label: '模型与余额', tab: 'usage', keys: '模型 余额 提供商 厂商 刷新 api key 额度 主显示 密钥 凭据 token 名称 类型 币种 接口 地址 base url scale 认证 字段 路径 取值 倍数 重置 提醒 阈值' },
  notify: { label: '提醒与通知', tab: 'usage', keys: '提醒 通知 系统通知 邮件 smtp 预算 低余额 波动 免打扰 预警 阈值 端口 ssl tls 直连 账号 授权码 发件人 收件人 主题 前缀 停留 峰谷 切换' },
  focus: { label: '专注与待办', tab: 'usage', keys: '专注 专注与计时 专注与待办 番茄 计时 倒计时 统计 连续 待办 清单 任务 勾选 完成 轮次 分钟 目标 专注中 改名 删除' },
  timer: { label: '计时设置', tab: 'usage', keys: '计时 计时器 番茄 番茄钟 番茄循环 倒计时 正计时 定时 默认时长 快捷时长 档位 休息 短休 长休 每几轮进长休 自动衔接 到点 到点提醒 留言 气泡 常驻 只显计时 记住 邮件 系统通知 计时设置' },
  offwork: { label: '下班倒计时', tab: 'usage', keys: '下班 倒计时 上班 工时 打卡 工作日 周末 发薪日 发薪 工资 时薪 今日已赚 估算 秒 显示 距离下班 距离上班 已下班 休息日' },
  window: { label: '挂件窗口', tab: 'window', keys: '窗口 显隐 位置 复位 透明度 穿透 吸附 翻转 避让 任务栏 间距 插件 滚动条 置顶 锁定 贴边 宽度' },
  help: { label: '使用帮助', tab: 'help', keys: '帮助 快捷键 使用说明 故障排查 日志 新手引导 异常 详情' },
  backup: { label: '备份与恢复', tab: 'data', keys: '备份 恢复 导出 导入 json 迁移 密码 加密 凭据 气泡 泡泡 素材 待办 专注 记录' },
  privacy: { label: '清除数据', tab: 'data', keys: '清除 数据 隐私 重置 卸载 凭据 挂件 账本 窗口 素材 按压 气泡 泡泡 待办 专注 记录' },
  dshMain: { label: 'DeepSeek Harness（dsh）', tab: 'dev', keys: 'dsh harness 启动 重启 结束 更新 版本 端口 注册源 node 日志 状态 安装 目录 命令 地址 使用' },
  dshDiagnose: { label: 'dsh 环境诊断', tab: 'dev', keys: 'dsh 诊断 环境 检查 排障 patch 冲突 端口占用' },
  dshDump: { label: 'dsh 配置转储', tab: 'dev', keys: 'dsh 配置 转储 dump 分层 默认树 差异 概览' },
  dshExport: { label: 'dsh 全量导出', tab: 'dev', keys: 'dsh 导出 zip 打包 全量 备份 来源 目录 凭据 跳过 依赖 文件夹' },
  dshUsage: { label: 'dsh 用量统计', tab: 'dev', keys: 'dsh 用量 统计 token 趋势 数据 目录 来源 会话' },
  dshIsolate: { label: 'dsh 插件开关', tab: 'dev', keys: 'dsh 插件 开关 隔离 patch 启用 禁用 写入 位置 保留' },
  dshMarket: { label: 'dsh 插件市场', tab: 'dev', keys: 'dsh 市场 插件 安装 卸载 更新 目录 数据 来源 写入 位置 关键词' },
  codex: { label: 'Codex 会话统计', tab: 'dev', keys: 'codex 会话 统计 token 用量 日志 订阅 窗口' },
  about: { label: '关于与更新', tab: 'help', keys: '关于 更新 版本 反馈 好评 市场' },
  ghAccel: { label: 'GitHub 加速', tab: 'help', keys: 'github 加速 hosts 直连 ip 刷新 源 冲突 证书 状态' },
}

// 核心卡片不可隐藏：隐藏会导致核心功能不可用
export const CORE_CARDS: readonly string[] = ['credentials', 'window', 'look']

// 含核心卡片的 Tab 同样不可整体隐藏：Tab 级隐藏会连带藏掉里面的核心卡片，
// 与「核心卡片不可隐藏」的承诺冲突（凭据 / 挂件窗口 / 挂件外观 分别落在 data / window / look）。
// 由 SEARCH_INDEX 反查得出，不另抄一份 Tab 名单。
export const CORE_TABS: readonly string[] = [
  ...new Set(CORE_CARDS.map((k) => SEARCH_INDEX[k]?.tab).filter((t): t is TabKey => !!t)),
]

// 卡片依赖关系：隐藏时显示警告文案。
// 只存 warning，不再带 label —— 卡片名统一取 SEARCH_INDEX[key].label 那一份，
// 两份 label 迟早写歪（历史上就是 22 条逐字重复的副本，没人读）。
export const CARD_DEPENDENCIES: Record<string, { warning: string }> = {
  bubbleCustom: { warning: '隐藏后无法编辑按压气泡，但已配置的气泡仍正常显示' },
  models: { warning: '隐藏后无法管理多厂商模型，但挂件仍显示内置 DeepSeek 余额' },
  usage: { warning: '隐藏后用量趋势不可见，但挂件记账不受影响' },
  notify: { warning: '隐藏后提醒设置不可改，但已配置的提醒仍正常触发' },
  timer: { warning: '隐藏后计时默认值与到点提醒不可改，但挂件菜单的计时仍可用' },
  focus: { warning: '隐藏后待办编辑不可用，但挂件菜单仍可勾选完成' },
  offwork: { warning: '隐藏后无法设置上下班时间与工作日，但已开启的挂件倒计时仍会显示' },
  look: { warning: '隐藏后无法调整挂件本体外观' },
  pageVisual: { warning: '隐藏后无法设置设置页背景与启动片头' },
  assetsOverview: { warning: '隐藏后无法查看素材占用与清理' },
  assetsMedia: { warning: '隐藏后无法导入/删除背景与片头媒体' },
  assetsSkins: { warning: '隐藏后无法更换挂件形象' },
  assetsBubbles: { warning: '隐藏后无法管理自定义气泡图' },
  assetsSounds: { warning: '隐藏后无法管理自定义音效' },
  privacy: { warning: '隐藏后无法清除数据，建议保留' },
  backup: { warning: '隐藏后无法备份/恢复配置' },
  help: { warning: '隐藏后无法查看帮助文档' },
  about: { warning: '隐藏后无法检查更新' },
  ghAccel: { warning: '隐藏后无法编辑 hosts 方案' },
  dshMain: { warning: '隐藏后无法启动/停止 dsh' },
  dshDiagnose: { warning: '隐藏后无法诊断 dsh 环境' },
  dshDump: { warning: '隐藏后无法查看 dsh 配置差异' },
  dshExport: { warning: '隐藏后无法导出 dsh 配置' },
  dshUsage: { warning: '隐藏后无法查看 dsh 用量' },
  dshIsolate: { warning: '隐藏后无法管理 dsh 插件隔离' },
  dshMarket: { warning: '隐藏后无法浏览/安装 dsh 插件' },
  codex: { warning: '隐藏后无法查看 Codex 用量' },
}

// 按用户自定义顺序排列：order 里出现的项按 order 先后排，其余按传入原序补在后面。
// 补尾规则是刻意的：新版本加了 Tab / 卡片、老配置的 order 里没有它，它必须仍然排得上、
// 不能因为「不在 order 里」就消失或排到最前。空 order = 原样返回（默认顺序）。
export function sortByOrder<T>(
  items: readonly T[],
  order: readonly string[] | undefined,
  keyOf: (it: T) => string,
): T[] {
  if (!order || !order.length) return [...items]
  const rank = new Map<string, number>()
  order.forEach((k, i) => { if (!rank.has(k)) rank.set(k, i) })
  return [...items].sort((a, b) => {
    const ra = rank.get(keyOf(a))
    const rb = rank.get(keyOf(b))
    if (ra === undefined && rb === undefined) return 0
    if (ra === undefined) return 1
    if (rb === undefined) return -1
    return ra - rb
  })
}

// —— 卡片折叠 ——
// 卡片 key → useFold 的存储键。绝大多数一一对应，只有合并卡例外：
// 「专注与待办」与「计时」共用同一个卡根（focus-timer-card），折叠也必须是同一个状态。
// 这张表是「管理显示内容」里逐卡设置「默认展开 / 默认收起」的桥：
// 组件拿 card key，useFold 拿 fold key，中间靠这里转一次。
export const CARD_FOLDS: Record<string, string> = {
  credentials: 'credentials',
  look: 'look',
  pageVisual: 'pageVisual',
  bubbleCustom: 'bubble',
  assetsOverview: 'assetsOverview',
  assetsMedia: 'assetsMedia',
  assetsSkins: 'assetsSkins',
  assetsBubbles: 'assetsBubbles',
  assetsSounds: 'assetsSounds',
  usage: 'usage',
  models: 'models',
  notify: 'notify',
  focus: 'focusTimer',
  timer: 'focusTimer',
  offwork: 'offwork',
  window: 'window',
  help: 'help',
  backup: 'backup',
  privacy: 'privacy',
  dshMain: 'dshMain',
  dshDiagnose: 'dshDiagnose',
  dshDump: 'dshDump',
  dshExport: 'dshExport',
  dshUsage: 'dshUsage',
  dshIsolate: 'dshIsolate',
  dshMarket: 'dshMarket',
  codex: 'codex',
  about: 'about',
  ghAccel: 'ghAccel',
}

// 合并卡：一个卡根挂多张卡。排序与折叠都按「卡根代表键」算，
// 否则拖一次会得到两个互相矛盾的顺序（focus / timer 各占一行）。
export const MERGED_CARD_ROOT: Record<string, string> = { timer: 'focus' }
export function cardRootKey(key: string): string {
  return MERGED_CARD_ROOT[key] || key
}

// 各卡「默认展开」的出厂值 —— 必须与各 useFold(key, defaultOpen) 调用点的第二参逐条一致。
// 表在这里而不是运行时从 useFold 收集：非当前 Tab 的卡是 v-if 的，弹窗打开时它们根本没挂载，
// 收集不到；而弹窗又必须能列出全部卡片。test/display.test.mjs 会扫源码比对，防止两边漂移。
export const FOLD_DEFAULTS: Record<string, boolean> = {
  look: true,
  usage: true,
  focusTimer: true,
  offwork: true,
  window: true,
  dshMain: true,
}

// 按用户拖拽出的顺序排列卡片：order 里出现的按 order 先后排，其余按传入原序补在后面
// （与 Tab 的 sortByOrder 同一套补尾规则）。合并卡用 cardRootKey 归一，timer 跟着 focus 走。
export function sortCardsByOrder<T extends { key: string }>(
  items: readonly T[],
  order: readonly string[] | undefined,
): T[] {
  if (!order || !order.length) return [...items]
  return sortByOrder(items, order, (it) => cardRootKey(it.key))
}

// —— 卡片置顶 ——
// 「置顶」不重排模板：卡片仍用 v-if 归在各自 Tab 里；置顶只影响**本组内部**的顺序
// （App.vue 渲染完成后由 syncPinned() 把置顶卡按 pinnedCards 顺序搬到组首）。
// 因此不存在「卡片跨组乱串、分组意义消失」的问题 —— 置顶卡不会跑到别的组里。
// 本函数只负责算出「某个 Tab 里当前可见的置顶卡」（保持用户定的先后），供置顶区标题与
// DisplayManager 的置顶计数共用；顺序即 pinnedCards 顺序 —— 用户连点几张就是点击顺序。
export function pinnedInTab(
  pinned: readonly string[] | undefined,
  tab: TabKey,
  hiddenTabs: readonly string[] | undefined,
  hiddenCards: readonly string[] | undefined,
): string[] {
  if (!pinned || !pinned.length) return []
  // 按**卡根**去重：合并卡（focus / timer）在 pinnedCards 里可能存了两个键，是同一张卡；
  // 返回的也统一成卡根代表键，下游（置顶名次 / 排序）只认一套键
  const seen = new Set<string>()
  const out: string[] = []
  for (const k of pinned) {
    if (!SEARCH_INDEX[k] || SEARCH_INDEX[k].tab !== tab) continue
    const root = cardRootKey(k)
    if (seen.has(root)) continue
    // 合并卡的显隐按卡根判：隐藏 focus 时 timer 也是同一张卡，不能只藏一半
    if (Object.keys(SEARCH_INDEX).some((x) => cardRootKey(x) === root && isCardHidden(hiddenTabs, hiddenCards, x))) continue
    seen.add(root)
    out.push(root)
  }
  return out
}

// 某张卡片当前是否不可见：自身被隐藏，或所属 Tab 被整体隐藏。
// 判定收在这一处：App.vue（渲染 / 搜索标签）与 DisplayManager（勾选态）共用，
// 历史上三处各写一套，改一处漏两处的风险太高。
export function isCardHidden(
  hiddenTabs: readonly string[] | undefined,
  hiddenCards: readonly string[] | undefined,
  key: string,
): boolean {
  if (hiddenCards && hiddenCards.includes(key)) return true
  const tab = SEARCH_INDEX[key]?.tab
  return !!tab && !!hiddenTabs && hiddenTabs.includes(tab)
}
