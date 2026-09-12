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
  // 自动避让任务栏：实时识别任务栏隐藏/显示，任务栏弹出占位时挂件自动让位
  avoidTaskbar: boolean
  // 贴边间距（px，0 = 紧贴该边）：上/右/下/左，以系统当前可用区为准
  edgeTop: number
  edgeRight: number
  edgeBottom: number
  edgeLeft: number
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
  // DeepSeek Harness（dsh，开发者）：自定义 Node.js 目录（''=自动探测）/ 退出后是否保留进程
  dshNodeDir: string
  dshKeepAlive: boolean
  // npm 注册源（'' = 官方源）/ 固定版本（'' = 自动：安装/更新时取 latest）/ 更新前是否先删掉插件目录里的 dsh / 启动是否带 --no-open
  dshRegistry: string
  dshVersion: string
  dshReinstall: boolean
  dshNoOpen: boolean
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
  keepAlive: boolean
  url: string
  port: number
  // 实际生效的 Node.js 目录与版本
  nodeDir: string
  nodeVersion: string
  // 目录是否来自自动探测
  nodeAuto: boolean
  found: boolean
  error: string
  // 最近执行过的命令（启动/更新/结束），界面直接展示
  lastCmd: string
  log: string
  // dsh 相关配置回显
  registry: string
  version: string
  // 「实际会跑」的版本（全局优先，其次插件目录）
  resolved: string
  // 已查询到 latest 且比当前用的新（界面提示「有新版本」）
  hasUpdate: boolean
  // 用哪一份：global=全局安装（优先）；plugin=插件目录；''=都没有
  source: 'global' | 'plugin' | ''
  // 全局安装的那份（没有则为空）
  globalVersion: string
  globalDir: string
  // 全局安装目录当前用户可写？（false 时「更新」会弹一次 UAC 提权）
  globalWritable: boolean
  // 更新前是否先删掉插件目录里的 dsh
  reinstall: boolean
  // 插件自己那份 dsh 的安装目录
  prefix: string
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
  // 实际已安装的 dsh 版本（npx 缓存，探测不到为空）
  installed: string
  // 本次启动实际用的版本；缓存里已换成别的版本时 needsRestart=true（需点「重启」才生效）
  runVersion: string
  needsRestart: boolean
}

export interface DshDirPickResult {
  ok: boolean
  canceled?: boolean
  dir?: string
  error?: string
}

// 备份导出结果
export interface BackupExportResult {
  ok: boolean
  canceled?: boolean
  path?: string
  withSecrets?: boolean
  exportedAt?: string
  error?: string
}

// 备份预览（选择文件后解析出来，尚未写入）
export interface BackupPreviewResult {
  ok: boolean
  canceled?: boolean
  path?: string
  exportedAt?: string
  appVersion?: string
  has?: { config: boolean; ledger: boolean; window: boolean; timer: boolean; secrets: boolean }
  error?: string
}

// 备份恢复结果
export interface BackupApplyResult {
  ok: boolean
  applied?: string[]
  skipped?: string[]
  errors?: string[]
  widgetRebuilt?: boolean
  error?: string
}

export interface TaskbarState {
  state: 'visible' | 'hidden' | 'none'
  // 'left' | 'top' | 'right' | 'bottom'，未识别到时为空串
  edge: string
  // 任务栏厚度（DIP，px）；未识别到时为 0
  thickness: number
}

export interface WhaleServices {
  getConfig(): WhaleConfig
  // 订阅配置变更（挂件菜单改设置时宿主广播过来），返回退订函数
  onConfigChange(cb: (cfg: WhaleConfig) => void): () => void
  // 任务栏当前状态：visible = 正在占位（常显/自动隐藏已弹出）/ hidden = 已自动收起 / none = 未识别到
  getTaskbarState(): TaskbarState
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
  // 清空内存日志
  dshClearLog(): DshStatus
  // 删除插件目录里的那份 dsh
  dshRemovePlugin(): DshStatus
  // 清理 npx 缓存里含 dsh 的历史副本
  dshCleanNpxCache(): DshStatus
  // 选择 Node.js 安装目录（文件夹选择器，校验目录里有 node）
  dshPickNodeDir(): DshDirPickResult
  // —— 备份 / 恢复 ——
  // 导出备份（secrets=true 时用 password 加密后才写入凭据）
  backupExport(opts: { secrets?: boolean; password?: string }): BackupExportResult
  // 选择备份文件并解析预览（不写任何数据）
  backupPick(): BackupPreviewResult
  // 按勾选项恢复（同名覆盖）
  backupApply(opts: { config?: boolean; ledger?: boolean; window?: boolean; timer?: boolean; secrets?: boolean; password?: string }): BackupApplyResult
  // 放弃本次选择
  backupCancel(): { ok: boolean }
}

declare global {
  interface Window {
    services: WhaleServices
  }
}
