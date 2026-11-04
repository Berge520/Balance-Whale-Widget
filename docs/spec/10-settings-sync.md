**配置双向同步**：设置页改开关 → `saveConfig` → `pushConfig()` 推给挂件；挂件三点菜单改设置 → `whale:config` → `patchConfig` + `pushConfig()`（挂件）+ `emitConfigChange()`（广播给已打开的设置页，`App.vue` 在 `onMounted` 订阅、`onUnmounted` 退订），避免「挂件菜单勾选与设置窗口开关不同步」。

包含：

- 凭据与连接测试：API Key / 平台 Token 录入（加密保存 + 测试连接，分项验证余额与用量接口）。
- 外观与音效：大小 / 音效开关 / 音色（含**自定义**，选「自定义」时展开按压音 / 释放音两行导入 / 删除，显示当前文件名）/ 音量 / **透明度** / 用量 / 峰谷文案 / 气泡 / 峰谷切换提醒 / 报时 / 菜单按钮 / 置顶 / **鼠标穿透**（附「复制指令名 / 新增快捷键」引导）。
- **计时（设置页「计时」卡，v1.14.0 从「提醒与通知」迁出）**：默认倒计时时长（`timerSec`，时分秒三段）/ 快捷时长四档（`timerPresets`）/ 到点留言与系统通知 / 到点气泡停留（`timerRemindSec`）/ 到点邮件 / 休息挡位与番茄循环 / 计时气泡常驻、只显计时、记住计时状态。**这些是默认值**，挂件菜单只管「这一轮」，不回写上述键。
- 低余额预警：开关与阈值（文案注明「数字变红 + 弹一次提醒气泡 + 每天一次系统通知」；阈值单位**跟随账本币种**显示「元 / 美元」，初值与兜底取设置页本地副本 `LOW_ALERT_DEFAULT`，与宿主 `constants.LOW_ALERT_BY_CURRENCY` 同值 —— preload 不参与打包，设置页拿不到宿主常量）。
- **提醒停留时长**下拉（`remindSec`，0/5/8/15 秒，0 = 常驻）、**免打扰时段**开关 + 条件显示的起止 `type="time"` 输入（`quietOn/quietFrom/quietTo`）。
- **用量趋势**卡片柱状图（7 / 14 / 30 天档位 `usageRange`，宿主一次拉 31 天、前端截尾部渲染，切档不重新请求；标签抽稀 30 天每 5 天一个）+ **本月汇总**（本月累计 / 日均（按已过天数摊，含今天）/ 最高单日）。
- **导出 CSV**（`exportUsageCsv(days)`：`utools.showSaveDialog` 弹系统保存框，写 UTF-8 BOM 的 `日期,用量,币种` 三列，Excel 可直接打开；取消返回 `{ok:false,canceled:true}`）。
- **导入 CSV**（`importUsageCsv()`：`utools.showOpenDialog` 选 `日期,用量[,币种]` 文件，兼容 BOM/CRLF/表头/`-`、`/`、`.` 分隔符；`store.mergeLedgerHistory` 合并进账本 `history`，同日以导入值覆盖、只留最近 `historyKeepDays()` 天（趋势图可选到 30 天、本月汇总在 31 号要回溯到 1 号，31 天窗口不够）；当天行同步写入 `todayUsage`（否则当天柱会被实时累计值遮蔽），`lastBalance/lastCurrency` 基准不动；返回 `{ok,imported,invalid,kept,from,to}`，成功后刷新趋势图）。
- 显示/隐藏挂件、复制指令名（`copyText('显示/隐藏挂件')`）、新增快捷键（`redirectHotKeySetting('显示/隐藏挂件')`，跳转「全局功能」并新增待绑定项）、**当前绑定展示**（`services.getCmdHotKey('显示/隐藏挂件')` → `utools.getCmdHotKey`，uTools 8.0 起可用；空值文案「未检测到」而非「未绑定」—— 7.x 无此 API 时恒为空，不能据此断言用户没绑。`src/composables/useHotkey.ts` 在挂载与 `window` 获焦时各读一次，绑完切回来即更新；「挂件窗口」卡的「切换鼠标穿透」同构）。
- 挂件错误查看（进设置页自动 `getWidgetError()` 静默检查：有错时展开红色标题 + 等宽错误详情 + `copyText` 复制按钮与「重新检查」；无错误时只显示一行浅色「挂件异常？查看错误详情」链接，点击才提示「当前没有记录到挂件错误」）。
- 数据与隐私（卡名「**清除数据**」，**按项清除**：七个复选框「凭据 / 挂件设置 / 账本用量记录 / 窗口位置与更新缓存 / 按压气泡 / 导入的素材 / 待办与专注记录」→ 前四项走 `clearAllData({secrets,config,ledger,window})` 只清 `true` 的项，第五项走 `clearAllData({bubble:true})`，第六项走素材删除路径，第七项走 `clearAllData({todo:true})` —— **一个开关同时清 `whale:todo` 与 `whale:focus`**，与「按压气泡 + 导入的素材」同理合成一项，免得为「清个待办」勾两遍），按钮二次确认，已清除项在提示里回显；清到配置或窗口项时宿主按默认配置重建挂件；清凭据后本页输入框同步置空。

**素材（形象 / 气泡图 / 音效）的逐张管理仍在「资源」页**，本卡只有一个「导入的素材」复选框（整批清除，等同「资源」页的「清除全部素材」）。**「按压气泡」独立于「导入的素材」**（前者 = 自定义泡泡的**文案与配图**、后者 = 形象 / 气泡图 / 音效三类素材文件）：勾它时宿主 `clearAllData({bubble:true})` 把 `config.bubble/bubbleOn` 复位回默认、清空 `whale:bubbles` 整组配图、把空气泡推给挂件（文案回内置、配图回内置 `rua.webp`）；**可与「导入的素材」同时勾**（都清 `whale:bubbles`，重复清无副作用），也可只勾它 —— 只重置按压气泡、不动形象与音效。宿主 `clearAllData` 保留 `sounds/skins/bubbles` 三个素材选项 + 独立 `bubble` 选项（`sounds` 走 `sounds.clearAll()` 删音频文件 + `whale:sounds` 并推空音效、`skins` 同构删图片 + `whale:skins` 推空形象、`bubbles` 推空 `whale:bubbles`；宿主内建「自定义 → 内置」回退）；「资源」页的 `doClearAssets()` 经 `removeSkin/removeBubble/removeSound` 逐项删；两处口径等价，宿主那条额外内建回退、更稳。

**用量趋势**的刷新时机（`refreshHistory()`：`onMounted`、导入 CSV 后、切换用量模式时、窗口 `focus`/`visibilitychange` 重新可见时 —— 令牌模式的今日总量由挂件刷新时写入账本，不重拉看不到变化）与错误回显。「挂件常驻说明」、使用说明 / 快捷键绑定、故障排查（「复制诊断日志」`getDebugLog()` → `copyText` 日志末尾 20000 字符 与「打开日志文件」`openLogFile()` → `utools.shellOpenPath`，用于 uTools 结束进程后仍能取回控制台线索，见第三节第 11、13 条）与挂件错误查看，统一归入**「使用帮助」卡片**（「帮助」Tab）。
