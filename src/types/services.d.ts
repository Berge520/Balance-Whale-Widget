// 主窗 preload（public/preload/services.js）注入到 window.services 的宿主 API 类型声明。
// 仅用于设置页（src/App.vue）的类型提示与校验，运行时实现见 public/preload/services.js。

export interface WhaleConfig {
  scale: number
  vol: number
  soundOn: boolean
  soundSet: 'duck' | 'fx1'
  usageMode: 'ledger' | 'token'
  peakMode: 'default' | 'liangwen' | 'qiangqiang'
  // 峰/谷时段切换时，用气泡提醒当前价格时段
  peakRemindOn: boolean
  bubbleOn: boolean
  menuBtn: boolean
  onTop: boolean
  lowAlertOn: boolean
  lowAlertAmount: number
  timeBubbleOn: boolean
  updateCheckOn: boolean
  dragLock: boolean
  // 计时到点时弹系统通知
  timerNotifyOn: boolean
  // 记住计时状态：重载插件/重建挂件后继续计时
  timerPersistOn: boolean
  // 计时偏好（重载后不用重新选）：模式 / 倒计时分钟数 / 定时时刻 / 到点气泡停留秒数（0=常驻）
  timerMode: 'off' | 'up' | 'down' | 'at'
  timerMin: number
  timerAt: string
  timerRemindSec: 0 | 5 | 8 | 15
  // 计时气泡是否常驻显示（false = 计时中只短暂显示，点小鲸鱼可随时查看）
  timerBubblePin: boolean
  // 气泡是否只显示计时（false = 计时中气泡照常显示余额/用量等全部内容）
  timerBubbleOnly: boolean
  // 进入插件时显示哪些窗口：both=设置窗+挂件；widget=只显示挂件；settings=只显示设置窗
  enterMode: 'both' | 'widget' | 'settings'
  // DeepSeek Harness（dsh，开发者）：运行方式 / 自定义 Node.js 目录（''=自动探测）/ 退出后是否保留进程
  dshMode: 'npx' | 'global'
  dshNodeDir: string
  dshKeepAlive: boolean
  // npm 注册源（'' = 官方源）/ 固定版本（'' = latest）/ 更新前是否清理 npx 缓存
  dshRegistry: string
  dshVersion: string
  dshCleanNpx: boolean
}

export interface WhaleSecrets {
  apiKey: string
  platformToken: string
}

export interface BalanceTestResult {
  ok: boolean
  totalBalance?: number
  currency?: string
  error?: string
  code?: string
  transient?: boolean
}

export interface PlatformUsageTestResult {
  amount?: number
  tokens?: number
  empty?: boolean
  error?: string
}

export interface UpdateCheckResult {
  ok: boolean
  fresh?: boolean
  at?: number
  current?: string
  latest?: string
  hasUpdate?: boolean
  error?: string
}

export interface WidgetResult {
  ok: boolean
  error?: string | null
}

export interface ClearDataResult {
  ok: boolean
  // 各项是否被清除（按项清除的结果回显）
  cleared?: {
    // 凭据（API Key / 平台 Token）
    secrets: boolean
    // 挂件设置
    config: boolean
    // 账本用量记录
    ledger: boolean
    // 窗口位置与更新缓存
    window: boolean
  }
  error?: string
}

export interface UsageHistoryResult {
  currency: string
  days: Array<{ date: string; usage: number }>
}

export interface UsageCsvResult {
  ok: boolean
  // 用户取消保存对话框
  canceled?: boolean
  // 保存成功后的绝对路径
  path?: string
  error?: string
}

export interface UsageCsvImportResult {
  ok: boolean
  // 用户取消文件选择对话框
  canceled?: boolean
  // 导入文件路径
  path?: string
  error?: string
  // 成功合并的行数
  imported?: number
  // 忽略的非法行数（表头不计）
  invalid?: number
  // 合并后账本保留的天数
  kept?: number
  // 合并后账本覆盖的日期范围
  from?: string
  to?: string
}

export interface DebugLogResult {
  // 日志文件绝对路径（非 dev 为空串）
  path: string
  // 日志末尾内容（非 dev 为空串）
  text: string
}

// dsh（DeepSeek Harness）运行状态快照
export interface DshStatus {
  running: boolean
  stopping: boolean
  // '' | 'update'
  busy: string
  pid: number
  startedAt: number
  exitCode: number | null
  exitAt: number
  mode: 'npx' | 'global'
  keepAlive: boolean
  url: string
  port: number
  // 实际生效的 Node.js 目录与版本
  nodeDir: string
  nodeVersion: string
  // 目录是否来自自动探测
  nodeAuto: boolean
  found: boolean
  dshFound: boolean
  error: string
  // 最近执行过的命令（启动/更新/结束），界面直接展示
  lastCmd: string
  log: string
  // 运行方式相关配置回显
  registry: string
  version: string
  cleanNpx: boolean
  // 「查询可用版本」结果（list 按版本号升序，latest 为最后一个）
  versions: { at: number; latest: string; list: string[] }
  // 3080 上的进程探测：external=别的终端启动的 dsh；portOther=非 dsh 进程名
  external: boolean
  externalPid: number
  externalName: string
  extBusy: boolean
  portOther: string
  // 本插件启动的进程是否已就绪（3080 开始监听）；npx 首次启动要下载，会有「启动中」阶段
  ready: boolean
  readyAt: number
  // dsh 打印的带 token 的页面地址（浏览器首次访问需要它，否则提示 authentication required）
  webUrl: string
}

export interface DshDirPickResult {
  ok: boolean
  canceled?: boolean
  dir?: string
  error?: string
}

export interface WhaleServices {
  getConfig(): WhaleConfig
  // 订阅配置变更（挂件菜单改设置时宿主广播过来），返回退订函数
  onConfigChange(cb: (cfg: WhaleConfig) => void): () => void
  getVersion(): string
  checkUpdate(force?: boolean): Promise<UpdateCheckResult>
  openExternal(url: string): boolean
  // __live: 拖动滑块中的实时预览，只改窗口几何，不写存储
  saveConfig(patch: Partial<WhaleConfig> & { __live?: boolean }): WhaleConfig
  getSecrets(): WhaleSecrets
  saveSecrets(secrets: Partial<WhaleSecrets>): { hasApiKey: boolean; hasPlatformToken: boolean }
  testApiKey(apiKey: string): Promise<BalanceTestResult>
  testPlatformToken(platformToken: string): Promise<PlatformUsageTestResult>
  getUsageHistory(days?: number): UsageHistoryResult
  exportUsageCsv(days?: number): UsageCsvResult
  importUsageCsv(): UsageCsvImportResult
  // 按项清除本地数据：true 的项才会被清除
  clearAllData(opts?: { secrets?: boolean; config?: boolean; ledger?: boolean; window?: boolean }): ClearDataResult
  ensureWidget(): WidgetResult
  showWidget(): WidgetResult
  getWidgetError(): string | null
  hideWidget(): boolean
  copyText(text: string): boolean
  redirectHotKeySetting(cmdLabel?: string): boolean
  isWidgetVisible(): boolean
  // dev 诊断日志（落盘于 %TEMP%\whale-debug.log，进程被 uTools 结束也不丢）
  isDev(): boolean
  getDebugLog(): DebugLogResult
  openLogFile(): { ok: boolean; path: string }
  // DeepSeek Harness（dsh）：状态与 启动/重启/结束/更新/打开页面
  dshStatus(): DshStatus
  dshStart(): DshStatus
  dshStop(): DshStatus
  dshRestart(): DshStatus
  dshUpdate(): DshStatus
  // 打开 Web UI（用捕获到的带 token 地址），返回实际打开的地址，失败返回 ''
  dshOpenWeb(): string
  // 查询可用版本（结果在状态的 versions 字段里，稍后刷新状态可见）
  dshListVersions(): DshStatus
  // 选择 Node.js 安装目录（文件夹选择器，校验目录里有 node）
  dshPickNodeDir(): DshDirPickResult
}

declare global {
  interface Window {
    services: WhaleServices
  }
}
