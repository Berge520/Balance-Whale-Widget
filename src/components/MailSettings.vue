<script lang="ts" setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { msgCls, useFlashShow } from '../composables/useFlash'
import { useFold } from '../composables/useFold'
import type { WhaleMailSecrets, WhaleServices } from '../types/services'

// 「提醒与通知」卡里的 SMTP 配置子块（服务器 / 端口 / 账号 / 凭据 + 发件人 / 收件人 / 主题 + 测试邮件）。
// 从 NotifyView.vue 抽出：那卡正文已超出行数棘轮上限，而这一块自成一节（表单 + 两个按钮 + 独立回执），
// 抽出来只带走 SMTP 自己的状态，不牵动提醒开关与文案。
//
// 与父级的唯一耦合是「测试通过 / 保存成功就收起配置区」：折叠态归本组件（useFold('mail')），
// 测试通知走的另一条路（NotifyView 的「测试通知」）也会带上邮件渠道，因此由父级经 defineExpose
// 拿到 collapse() 主动收起。父级原有的 loadMailSecrets / syncAlertsBaseline 两个外部入口不变，
// 前者下沉到本组件（本卡挂载即读回），后者仍在 NotifyView。
//
// SMTP 凭据与 cfg 分开：它在宿主侧进的是加密存储（不进备份）。mailPass 回填的是占位掩码而不是
// 真实授权码 —— 只在用户没重新输入时保留原值，避免明文回显
const props = defineProps<{
  // 挂件配置整体传入：本块只读写邮件相关字段（mailFrom / mailTo / mailFromName / mailSubjectPrefix）
  cfg: any
  services: Partial<WhaleServices>
}>()
const emit = defineEmits<{
  (e: 'patch', p: Record<string, any>): void
}>()

const mail = reactive({
  mailHost: '',
  mailPort: 465,
  mailSecure: true,
  mailUser: '',
  mailPass: '',
})
// 已保存过授权码时为 true：用于把密码框的 placeholder 提示成「留空 = 不修改」
const mailPassSaved = ref(false)
const mailTesting = ref(false)
// SMTP 配置区的展开态。默认收起，点了按钮才展开（见 mailOpen）
const mailFold = useFold('mail', false)
// 配置是否已齐全：服务器 / 发件人 / 收件人。只看「有没有填过」这个持久事实，
// 不看本次测试成没成 —— 折叠态要能跨会话稳定重现，不依赖一次性的运行时结果。
// **刻意不要求账号与授权码**：账号留空是合法用法（多数服务器直接拿发件人地址当账号，
// 宿主 SmtpClient.send 也是 `if (user)` 才发 AUTH），授权码同理 —— 本机可匿名中继的
// 内网 SMTP 根本不需要。早先要求这两项非空，用户账号留空时永远判「未配置」，
// 于是每次重载都弹回整张空表格，看着就像「保存丢了」
const mailConfigured = computed(() => !!(
  mail.mailHost.trim() && props.cfg.mailFrom.trim() && props.cfg.mailTo.trim()
))
const mailOpen = computed(() => mailFold.open)
// 端口缺省值的**唯一**推导口径，与宿主 notify.js 的 resolvePort() 保持一致：
// 勾了 SSL/TLS 直连默认 465，否则 587。早先这里两处都写死 `|| 465`，
// 用户选了「587 + 取消勾选」却留空端口时会落成 465，与 mailSecure=false 直接矛盾，
// 连上后报 TLS 层原始错误（wrong version number），用户完全看不懂
function mailPortOf(): number {
  const n = Number(mail.mailPort)
  return isFinite(n) && n > 0 ? n : (mail.mailSecure ? 465 : 587)
}
const { flash: mailFlash, show: mailFlashShow, clear: mailFlashClear, stop: mailFlashStop } = useFlashShow(4000)

// 从宿主读回 SMTP 凭据：授权码不返明文，只回「有没有存过」的标记，
// 所以密码框留空提交时后端会沿用旧值（见 saveMailSecrets）。
// 入参是「SMTP 凭据本体」（**两种来源形状必须一致**）：
//   - getSecrets() 返回整个 WhaleSecrets，SMTP 挂在 `notifyMail` 子对象下，要下沉一层
//   - saveMailSecrets() 直接返回该子对象（WhaleMailSecrets），不能下沉
// 早先这里写成 `s.mailHost` 取顶层、而 saveMailSecrets 又直接返回子对象，
// 两条路径形状对不上，回填恒为空 → 每次重启都判「未配置」
function applyMailSecrets(m: WhaleMailSecrets | undefined) {
  if (!m || typeof m !== 'object') return
  mail.mailHost = String(m.mailHost || '')
  mail.mailSecure = m.mailSecure !== false
  // 端口缺省也随 mailSecure 走：host 与 secure 都读回后再定端口默认值，
  // 不能写死 465 —— 未配过端口的 587 用户回填会被强行改成 465
  mail.mailPort = Number(m.mailPort) > 0 ? Number(m.mailPort) : (mail.mailSecure ? 465 : 587)
  mail.mailUser = String(m.mailUser || '')
  mailPassSaved.value = !!m.mailPass
  mail.mailPass = ''
}
// 读回凭据：读失败是预期分支（存储未就绪 / 老宿主无此 API），静默保持空表单，用户重填即可
function loadMailSecrets() {
  try { applyMailSecrets(props.services.getSecrets?.()?.notifyMail) } catch (err) {}
}
// 「SMTP 配置（必填） / 重新配置 / 收起」按钮：纯手动开关，展开态不再被「配置齐没齐」左右
function toggleMailFold() {
  mailFold.open = !mailFold.open
}
// 本块自己挂载时就读一次 SMTP 凭据，**不再依赖父级 onMounted 里调 loadMailSecrets()**：
// 本块被父卡的 v-if="cardOn('usage','notify')" 控制、默认 Tab 是「外观」，父级 onMounted 跑时
// notifyViewRef 还是 null，那次调用是空转 —— 于是服务器/端口/账号全部回填不出来，
// 用户看到的就是「已保存配置没正确显示」。改成本块自持后，无论从哪个 Tab 进入都能读回
onMounted(loadMailSecrets)

function saveMailSettings() {
  mailFlashClear()
  try {
    // 非敏感字段（发件人 / 收件人 / 显示名 / 主题前缀）已改为输入即 emit('patch') 实时落盘，
    // 这里不再重复 emit —— 早先靠 @change（失焦）才落盘，用户敲完直接点「保存」时
    // change 可能尚未派发，看着「保存了却没生效」。只有服务器与凭据这一路需要显式写
    const saved = props.services.saveMailSecrets?.({
      mailHost: mail.mailHost.trim(),
      mailPort: mailPortOf(),
      mailSecure: mail.mailSecure,
      mailUser: mail.mailUser.trim(),
      mailPass: mail.mailPass,
    })
    applyMailSecrets(saved)
    mailFlashShow('已保存')
  } catch (err: any) {
    mailFlashShow('保存失败：' + String(err?.message || err), true)
  }
}
async function testMail() {
  if (mailTesting.value) return
  mailTesting.value = true
  mailFlashClear()
  try {
    const r = await props.services.sendTestMail?.({
      mailHost: mail.mailHost.trim(),
      mailPort: mailPortOf(),
      mailSecure: mail.mailSecure,
      mailUser: mail.mailUser.trim(),
      mailPass: mail.mailPass,
      // 发件人 / 收件人在「当前表单」里（cfg），不在凭据区 —— 漏传就会被宿主判成空串，
      // 报「发件邮箱格式不正确」，用户看表单里明明填了
      mailFrom: props.cfg.mailFrom.trim(),
      mailTo: props.cfg.mailTo.trim(),
      mailFromName: props.cfg.mailFromName.trim(),
    })
    if (r && r.ok) {
      mailFlashShow('测试邮件已发出，请查收（含垃圾箱）')
      // 发信成功 = 这组参数确实能送达，此时自动收起配置区，卡片回到「一行摘要」的清爽态。
      // 之后仍可点「重新配置」再展开
      mailFold.open = false
    } else {
      // 失败时反而要展开，否则错误提示会跟着配置区一起藏在折叠里，用户只看到一片空白
      mailFold.open = true
      mailFlashShow('发送失败：' + ((r && r.error) || '未知错误'), true)
    }
  } catch (err: any) {
    mailFold.open = true
    mailFlashShow('发送失败：' + String(err?.message || err), true)
  } finally {
    mailTesting.value = false
  }
}

// 收起配置区：父级「测试通知」带上邮件渠道并发送成功时调（那边验证通过也该收起，同「发送测试邮件」）
function collapse() {
  mailFold.open = false
}
// 暴露给父级：collapse（测试通知成功后收起）、stop（离开时清掉回执定时器）
defineExpose({ collapse, stop: mailFlashStop })
</script>

<template>
  <!-- SMTP 配置：只在「邮件通知」开着时出现（显隐由父级 v-if 控制，本块不再判一次）。
       **默认收起**（未配置时也只留一行「SMTP 配置（必填）」按钮），点开才铺开表格；
       配置齐全收起时显示一行「已配置」摘要 -->
  <div class="fold">
    <p v-if="mailConfigured && !mailOpen" class="mail-summary">
      <span class="ok-tag">已配置</span>
      {{ mail.mailHost }}:{{ mail.mailPort }} → {{ cfg.mailTo || '（未填收件人）' }}
      <button class="link-btn inline utils-btn utils-secondary" type="button" @click="toggleMailFold()">重新配置</button>
    </p>
    <button v-else class="link-btn utils-btn utils-secondary fold-toggle" type="button" :aria-expanded="mailOpen" @click="toggleMailFold()">
      {{ mailConfigured ? '收起 SMTP 配置' : 'SMTP 配置（必填）' }}
    </button>

    <div v-if="mailOpen" class="guide">
      <label class="field row">
        <span class="label">SMTP 服务器</span>
        <input v-model="mail.mailHost" type="text" placeholder="smtp.qq.com" autocomplete="off" />
      </label>
      <label class="field row">
        <span class="label">端口</span>
        <input class="num" type="number" min="1" max="65535" v-model.number="mail.mailPort" />
      </label>
      <label class="field row check">
        <span class="label">SSL/TLS 直连 <em>（465 端口勾上；587 / 25 取消勾选，连上后自动 STARTTLS 升级）</em></span>
        <input type="checkbox" v-model="mail.mailSecure" />
      </label>

      <label class="field row">
        <span class="label">账号</span>
        <input v-model="mail.mailUser" type="text" placeholder="you@qq.com" autocomplete="off" />
      </label>
      <label class="field row">
        <span class="label">授权码</span>
        <input v-model="mail.mailPass" type="password" :placeholder="mailPassSaved ? '已保存，留空则不修改' : '邮箱授权码（非登录密码）'" autocomplete="off" />
      </label>
      <p class="hint">
        授权码存于 uTools 加密存储，<b>不进备份文件</b>；填过一次后留空即表示沿用已保存的值。
        多数邮箱（QQ / 163 / Gmail）需要在邮箱设置里单独开启 SMTP 并生成授权码，不能直接填登录密码。
      </p>

      <label class="field row">
        <span class="label">发件人</span>
        <input :value="cfg.mailFrom" type="text" placeholder="与上方账号一致" autocomplete="off"
               @input="emit('patch', { mailFrom: ($event.target as HTMLInputElement).value })" />
      </label>
      <label class="field row">
        <span class="label">收件人</span>
        <input :value="cfg.mailTo" type="text" placeholder="收提醒的邮箱（可与发件人相同）" autocomplete="off"
               @input="emit('patch', { mailTo: ($event.target as HTMLInputElement).value })" />
      </label>
      <label class="field row">
        <span class="label">发件人显示名</span>
        <input :value="cfg.mailFromName" type="text" placeholder="小鲸鱼余额挂件" autocomplete="off"
               @input="emit('patch', { mailFromName: ($event.target as HTMLInputElement).value })" />
      </label>
      <label class="field row">
        <span class="label">主题前缀</span>
        <input :value="cfg.mailSubjectPrefix" type="text" placeholder="[小鲸鱼余额挂件]" autocomplete="off"
               @input="emit('patch', { mailSubjectPrefix: ($event.target as HTMLInputElement).value })" />
      </label>

      <div class="btn-row">
        <button class="export-btn utils-btn utils-outline" type="button" @click="saveMailSettings()">保存邮件设置</button>
        <button class="export-btn utils-btn utils-outline" type="button" :disabled="mailTesting" @click="testMail()">
          {{ mailTesting ? '发送中…' : '发送测试邮件' }}
        </button>
      </div>
      <p v-if="mailFlash.msg" class="msg" :class="msgCls(mailFlash)">{{ mailFlash.msg }}</p>
      <p class="hint">
        测试邮件用的是上方「当前填的内容」（未保存也会用），方便先验证再保存；<b>发送成功会自动收起本区</b>。
        上方「测试通知」读的是已保存的配置，两者分工不同；SMTP 服务器与授权码需点「保存邮件设置」落盘。
        免打扰时段内邮件与系统通知一并静默（计时到点不受免打扰影响）。
      </p>
    </div>
  </div>
</template>

<style scoped>
/* 设计令牌来自 main.css 的 :root。通用控件样式已由 main.css 统一提供（全局唯一来源），
   本组件只留自身特有的控件样式。 */
.export-btn {
  cursor: pointer;
}
.export-btn:hover:not(:disabled) {
  color: var(--fg);
  border-color: var(--accent);
}

.mail-summary {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  margin: 10px 0 0;
  font-size: 12px;
  color: var(--fg-dim);
}
.link-btn.inline {
  margin-top: 0;
  font-size: 12px;
}
.ok-tag {
  padding: 1px 6px;
  border-radius: 4px;
  border: 1px solid var(--ok);
  color: var(--ok);
  font-size: 11px;
  line-height: 1.5;
}
</style>
