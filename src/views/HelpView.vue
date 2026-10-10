<script lang="ts" setup>
import { reactive } from 'vue'
import { msgCls, useFlash, type Flash } from '../composables/useFlash'
import type { WhaleServices } from '../types/services'

// 「使用帮助」整卡：全局快捷键说明 / 新手引导重开入口 / 使用说明折叠 / 挂件故障排查
// （复制诊断日志、打开日志文件） / 挂件窗口创建错误详情。从设置页 App.vue 抽出。
// 仍留在父级、不能跟着搬的：
//   - widgetFlash：本卡的「复制指令名 / 新增快捷键」与「挂件窗口」卡共用同一消息槽，
//     状态由父级持有，这里用 emit 触发父级函数，保证抽出前后行为一致。
//   - onGuideReopen / 引导层：引导浮层渲染在父级模板末尾（依赖 guideFlash / showGuide 等），
//     本卡只负责给入口，emit('guide-reopen') 交父级执行。
//   - errDetail / errFlash / checkWidgetError：父级 onMounted 与 showWidget 里都会自动调
//     checkWidgetError(true)（不随本卡可见性而跑），故状态与函数留在父级，这里按 props 收、
//     用 emit 触发，避免来回改写两份状态。
const props = defineProps<{
  // 主窗 preload 注入的宿主 API：按依赖注入传入，避免子组件去读全局
  services: Partial<WhaleServices>
  // 宿主记录的最后一条挂件创建/加载错误（空串＝无错误），由父级 checkWidgetError 写入
  errDetail: string
  // 挂件错误查看的反馈槽（父级写入，本卡只显示）
  errFlash: Flash
}>()
const emit = defineEmits<{
  (e: 'copy-cmd'): void
  (e: 'add-hotkey'): void
  (e: 'guide-reopen'): void
  (e: 'check-widget-error'): void
  (e: 'copy-widget-error'): void
}>()

// 统一的消息态（Flash）：定义收口在 composables/useFlash.ts，各卡不再各持一份。

// 使用说明 / 故障排查的折叠态（默认收起，点标题才展开）
const widgetFolds = reactive({ help: false, trouble: false })
// 诊断日志：两版都同步落盘（%TEMP%\whale-debug.log），插件进程被 uTools 结束也不丢。
// 入口恒显示：打包版同样落盘，不再按开发者模式隐藏
const diagReady = true
const diagFlash: Flash = useFlash()

// 复制诊断日志：uTools 结束插件进程会连带清空控制台，日志已同步落盘，可从文件取回
function copyDebugLog() {
  try {
    const r = props.services.getDebugLog?.()
    const text = (r && r.text) || ''
    if (!text) {
      diagFlash.err = true
      diagFlash.msg = '暂无可复制的日志：日志文件尚未产生（插件重启后才会写入）。'
      return
    }
    const ok = props.services.copyText?.(text)
    diagFlash.err = !ok
    diagFlash.msg = ok
      ? `已复制诊断日志末尾 ${text.split('\n').length} 行。文件：${(r && r.path) || ''}`
      : '复制失败，可点「打开日志文件」手动查看。'
  } catch (err: any) {
    diagFlash.err = true
    diagFlash.msg = '读取失败：' + String(err?.message || err)
  }
}
// 用系统默认程序打开日志文件，便于人工查看或另存
function openLogFile() {
  try {
    const r = props.services.openLogFile?.()
    diagFlash.err = !(r && r.ok)
    diagFlash.msg = r && r.ok
      ? '已用系统默认程序打开日志文件：' + (r.path || '')
      : '打开失败：' + ((r && r.path) ? r.path : '日志文件尚未产生（插件重启后才会写入）。')
  } catch (err: any) {
    diagFlash.err = true
    diagFlash.msg = '打开失败：' + String(err?.message || err)
  }
}
</script>

<template>
  <!-- [帮助] 使用帮助：使用说明 / 快捷键绑定 / 挂件故障排查。
       这些原先都堆在「挂件窗口」卡尾（一次性配置 + 排查 + 说明），日常要调的窗口项被埋在一堆说明下面。
       这里叫「挂件故障排查」以区别 dsh 卡里的「dsh 故障排查」—— 前者是插件自身日志，后者是 dsh 子进程日志 -->
  <section class="card" data-search="help">
    <h2>使用帮助</h2>
    <p class="hint">给「显示/隐藏挂件」绑定一个全局快捷键（想给「鼠标穿透」也绑一个，见「外观」组的「挂件窗口」卡）。</p>
    <div class="btn-row">
      <button class="secondary utils-btn utils-secondary" @click="emit('copy-cmd')">复制指令名</button>
      <button class="secondary utils-btn utils-secondary" @click="emit('add-hotkey')">新增快捷键</button>
    </div>
    <!-- 新手引导入口：首次引导只弹一次（guideDone），之后从帮助 Tab 重开。
         与「使用说明」「故障排查」同为折叠块、同一视觉语言，不额外占版面 -->
    <div class="fold">
      <button class="link-btn utils-btn utils-secondary" @click="emit('guide-reopen')">新手引导（填 DeepSeek 凭据）</button>
    </div>
    <div class="fold">
      <button class="link-btn utils-btn utils-secondary" @click="widgetFolds.help = !widgetFolds.help">{{ widgetFolds.help ? '收起使用说明' : '使用说明' }}</button>
      <div v-if="widgetFolds.help" class="guide">
        <p class="guide-use"><strong>进入插件时：</strong>选含挂件的模式后，挂件出现时会抢走焦点、本设置窗口自动收起；改设置请点挂件右上角菜单（或右键）→「打开设置」唤回本窗口。</p>
        <p class="guide-use"><strong>挂件操作：</strong>可拖拽到屏幕四边吸附（吸附区宽度与开关见「挂件窗口」卡片），鲸鱼始终朝屏幕内侧；点击鲸鱼刷新余额，悬停后点右上角菜单调整设置。</p>
        <p class="guide-use"><strong>快捷键：</strong>按 Ctrl+, 打开 uTools 设置 → 全局功能 → 新增 → 指令填「显示/隐藏挂件」→ 按下组合键。可点上方「复制指令名」快速复制。想给「鼠标穿透」也绑一个，指令名填「切换鼠标穿透」。</p>
        <p class="guide-use"><strong>常驻：</strong>退出到后台挂件保留；关闭 Ctrl+D 分离窗口会直接结束插件运行、挂件消失，分离后请用「最小化」；重进插件会自动重建，配置不丢。</p>
      </div>
    </div>
    <div v-if="diagReady" class="fold">
      <button class="link-btn utils-btn utils-secondary" @click="widgetFolds.trouble = !widgetFolds.trouble">{{ widgetFolds.trouble ? '收起挂件故障排查' : '挂件故障排查' }}</button>
      <div v-if="widgetFolds.trouble" class="guide">
        <!-- 标题与日志按钮都带「挂件」前缀：dsh 卡里另有一块「dsh 故障排查」讲 dsh 子进程日志，
             两块都叫「故障排查」时用户会把两处的日志当成同一份 -->
        <p class="guide-use">挂件消失或显示异常时，可复制插件自身的诊断日志（%TEMP%\whale-debug.log）或用系统程序打开日志文件。<strong>这只含挂件与插件自身的日志</strong>；dsh 的日志见「开发者 → dsh」卡里的「查看 dsh 日志」。</p>
        <div class="btn-row">
          <button class="secondary utils-btn utils-secondary" @click="copyDebugLog">复制挂件日志</button>
          <button class="secondary utils-btn utils-secondary" @click="openLogFile">打开挂件日志文件</button>
        </div>
        <p v-if="diagFlash.msg" class="msg" :class="msgCls(diagFlash)">{{ diagFlash.msg }}</p>
      </div>
    </div>
    <div v-if="errDetail" class="err-block">
      <p class="err-title">挂件窗口创建失败</p>
      <pre class="err-box">{{ errDetail }}</pre>
      <div class="btn-row">
        <button class="secondary utils-btn utils-secondary" @click="emit('copy-widget-error')">复制错误信息</button>
        <button class="secondary utils-btn utils-secondary" @click="emit('check-widget-error')">重新检查</button>
      </div>
    </div>
    <button v-else class="link-btn utils-btn utils-secondary" @click="emit('check-widget-error')">挂件异常？查看错误详情</button>
    <p v-if="errFlash.msg" class="msg" :class="msgCls(errFlash)">{{ errFlash.msg }}</p>
  </section>
</template>

<style scoped>
/* 设计令牌（--fg / --accent / --line / --ok / --err 等）全部来自 main.css 的 :root。
   通用控件样式已由 main.css 统一提供（全局唯一来源），本组件只留自身特有的控件样式。
   .btn-row 骨架、.link-btn 与 utils 档位配色也已在 main.css，此处不再留副本。
   .guide / .guide-use / .guide > .link-btn:first-child 一并上提 main.css（全局唯一来源）。 */

.err-block {
  margin-top: 10px;
}
.err-title {
  margin: 0;
  color: var(--err);
  font-size: 12px;
}
.err-box {
  margin: 6px 0 0;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid var(--err);
  background: rgba(224, 67, 63, 0.08);
  color: var(--fg);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 160px;
  overflow: auto;
  user-select: text;
}

</style>