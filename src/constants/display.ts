// 自定义显示相关常量：Tab/卡片白名单、依赖关系等
// 从 App.vue 抽出，供 DisplayManager.vue 等组件共享

export type TabKey = 'look' | 'window' | 'usage' | 'remind' | 'assets' | 'data' | 'help' | 'dev'

export const TABS: readonly { key: TabKey; label: string; desc: string; devOnly?: boolean }[] = [
  { key: 'look', label: '外观', desc: '挂件外观 · 按压气泡' },
  { key: 'assets', label: '资源', desc: '我的素材：资源概览 · 气泡图 ｜ 下载素材：形象 · 音效' },
  { key: 'usage', label: '用量', desc: '用量与账本 · 提醒与通知 · 模型与余额 · 专注与待办' },
  { key: 'window', label: '窗口', desc: '挂件窗口：显隐 · 位置 · 透明度 · 穿透' },
  { key: 'data', label: '数据', desc: 'DeepSeek 凭据 · 清除数据 · 备份与恢复' },
  { key: 'help', label: '帮助', desc: '使用帮助 · 关于与更新 · GitHub 加速' },
  { key: 'dev', label: '开发者', desc: 'DeepSeek Harness（dsh） · dsh 环境诊断 · dsh 配置转储 · dsh 全量导出 · dsh 用量统计 · dsh 插件开关 · dsh 插件市场 ｜ Codex 会话统计', devOnly: true },
]

export const SEARCH_INDEX: Record<string, { label: string; tab: TabKey; keys: string }> = {
  credentials: { label: 'DeepSeek 凭据（API Key / 平台 Token）', tab: 'data', keys: 'apikey api key 密钥 token 令牌 凭据 授权 余额 认证' },
  look: { label: '挂件外观', tab: 'look', keys: '形象 皮肤 音色 音效 音量 大小 缩放 气泡 主题 报时 点按 播放 界面 深浅色 深色 浅色 暗色 亮色 跟随 uTools 峰谷 文案 随机 节假日 法定节假日表 更新' },
  bubbleCustom: { label: '按压气泡（自定义泡泡）', tab: 'look', keys: '按压气泡 自定义泡泡 泡泡 气泡 编辑 撤销 重做 队列 排序 步骤 模块 行 文本 报时 余额 赠金 充值 今日 峰谷 对话名 随机 超链接 图片 动图 额度 订阅 试播 预览 开关 思考 点我 点击 停留' },
  assetsOverview: { label: '资源概览', tab: 'assets', keys: '素材 形象 音效 气泡图 占用 体积 清除 未使用 素材包 导出 导入' },
  assetsSkins: { label: '形象', tab: 'assets', keys: '形象 皮肤 图片 缩略图 置顶 删除 导入 内置 下载源 共享 角色 下载 选用 预览 随机' },
  assetsBubbles: { label: '导入的气泡图', tab: 'assets', keys: '气泡 图 动图 gif 图片 导入 删除' },
  assetsSounds: { label: '音效', tab: 'assets', keys: '音效 声音 按压 释放 提醒音 试听 导入 删除 共享音效库 共享 下载 段 筛选 过滤 搜索 候选 已参加播放 一段都没挂 下载源' },
  usage: { label: '用量与账本', tab: 'usage', keys: '用量 趋势 账本 历史 区间 导出 csv 导入 校准 额度 单价 模型占比 明细 币种 汇率 保留' },
  notify: { label: '提醒与通知', tab: 'usage', keys: '提醒 通知 系统通知 邮件 smtp 预算 低余额 波动 免打扰 计时 倒计时 休息 预警 阈值 端口 ssl tls 直连 账号 授权码 发件人 收件人 主题 前缀 停留 切换 短休时长 番茄循环 长休时长 每几轮进长休 自动衔接下一轮' },
  models: { label: '模型与余额', tab: 'usage', keys: '模型 余额 提供商 厂商 刷新 api key 额度 主显示 密钥 凭据 token 名称 类型 币种 接口 地址 base url scale 认证 字段 路径 取值 倍数 重置 提醒 阈值' },
  focus: { label: '专注与待办', tab: 'usage', keys: '专注 番茄 计时 倒计时 统计 连续 待办 清单 任务 勾选 完成 轮次 分钟 目标 专注中 改名 删除' },
  window: { label: '挂件窗口', tab: 'window', keys: '窗口 显隐 位置 复位 透明度 穿透 吸附 翻转 避让 任务栏 间距 插件 滚动条 置顶 锁定 贴边 宽度' },
  help: { label: '使用帮助', tab: 'help', keys: '帮助 快捷键 使用说明 故障排查 日志 新手引导 异常 详情' },
  privacy: { label: '清除数据', tab: 'data', keys: '清除 数据 隐私 重置 卸载 凭据 挂件 账本 窗口 素材 按压 气泡 泡泡 待办 专注 记录' },
  backup: { label: '备份与恢复', tab: 'data', keys: '备份 恢复 导出 导入 json 迁移 密码 加密 凭据 气泡 泡泡 素材 待办 专注 记录' },
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

// 卡片依赖关系：隐藏时显示警告文案
export const CARD_DEPENDENCIES: Record<string, { label: string; warning: string }> = {
  bubbleCustom: { label: '按压气泡（自定义泡泡）', warning: '隐藏后无法编辑按压气泡，但已配置的气泡仍正常显示' },
  models: { label: '模型与余额', warning: '隐藏后无法管理多厂商模型，但挂件仍显示内置 DeepSeek 余额' },
  usage: { label: '用量与账本', warning: '隐藏后用量趋势不可见，但挂件记账不受影响' },
  notify: { label: '提醒与通知', warning: '隐藏后提醒设置不可改，但已配置的提醒仍正常触发' },
  focus: { label: '专注与待办', warning: '隐藏后待办编辑不可用，但挂件菜单仍可勾选完成' },
  assetsOverview: { label: '资源概览', warning: '隐藏后无法查看素材占用与清理' },
  assetsSkins: { label: '形象', warning: '隐藏后无法更换挂件形象' },
  assetsBubbles: { label: '导入的气泡图', warning: '隐藏后无法管理自定义气泡图' },
  assetsSounds: { label: '音效', warning: '隐藏后无法管理自定义音效' },
  privacy: { label: '清除数据', warning: '隐藏后无法清除数据，建议保留' },
  backup: { label: '备份与恢复', warning: '隐藏后无法备份/恢复配置' },
  help: { label: '使用帮助', warning: '隐藏后无法查看帮助文档' },
  about: { label: '关于与更新', warning: '隐藏后无法检查更新' },
  ghAccel: { label: 'GitHub 加速', warning: '隐藏后无法编辑 hosts 方案' },
  dshMain: { label: 'DeepSeek Harness（dsh）', warning: '隐藏后无法启动/停止 dsh' },
  dshDiagnose: { label: 'dsh 环境诊断', warning: '隐藏后无法诊断 dsh 环境' },
  dshDump: { label: 'dsh 配置转储', warning: '隐藏后无法查看 dsh 配置差异' },
  dshExport: { label: 'dsh 全量导出', warning: '隐藏后无法导出 dsh 配置' },
  dshUsage: { label: 'dsh 用量统计', warning: '隐藏后无法查看 dsh 用量' },
  dshIsolate: { label: 'dsh 插件开关', warning: '隐藏后无法管理 dsh 插件隔离' },
  dshMarket: { label: 'dsh 插件市场', warning: '隐藏后无法浏览/安装 dsh 插件' },
  codex: { label: 'Codex 会话统计', warning: '隐藏后无法查看 Codex 用量' },
}
