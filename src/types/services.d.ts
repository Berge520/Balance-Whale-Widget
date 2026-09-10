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
  // 进入插件时显示哪些窗口：both=设置窗+挂件；widget=只显示挂件；settings=只显示设置窗
  enterMode: 'both' | 'widget' | 'settings'
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
  keepSecrets?: boolean
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
  clearAllData(opts?: { keepSecrets?: boolean }): ClearDataResult
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
}

declare global {
  interface Window {
    services: WhaleServices
  }
}
