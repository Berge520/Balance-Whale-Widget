(function () {
  'use strict';
  if (window.__dshWhaleWidget) return;
  window.__dshWhaleWidget = true;

  // —— 常量 ——
  var MIN_SCALE = 0.6, MAX_SCALE = 2.5, CLICK_SQ = 9;
  var REFRESH_MS = 60000, CHANGE_MS = 900, ANIM_MS = 700, BUBBLE_MS = 5000, BUBBLE_REMIND_MS = 8000;
  var TIMER_PEEK_MS = 2000; // 「只显计时」关闭时，点小鲸鱼先显示计时的时长（随后切回常规内容）
  var IMG_URL = './whale/DSniang1.png';
  var GIF_URL = './whale/rua.gif';
  var SOUND_FILES = {
    duck: { press: './whale/Ya1.mp3', release: './whale/Ya2.mp3' },
    fx1:  { press: './whale/D1.mp3',  release: './whale/D2.mp3' },
  };

  // 宿主桥接（preload/floating.js 注入）；缺省空实现，单独打开页面也不报错
  var whaleApi = window.whale || {
    onInit: function () {}, onBalance: function () {}, onConfig: function () {}, onSnapped: function () {},
    ready: function () {}, refresh: function () {}, saveConfig: function () {},
    saveTimer: function () {}, notifyTimerDone: function () {},
    dragMove: function () {}, dragEnd: function () {}, setIgnoreMouse: function () {},
    openSettings: function () {}, dsh: function () {}, onDsh: function () {},
  };
  // 是否有真实宿主桥接（没有时 dsh 等需要宿主的操作要给提示，而不是一直转圈）
  var HAS_BRIDGE = !!(window.whale && window.whale.__bridge);
  // 调试日志门控：宿主 preload 把 uTools 开发者模式标志透传为 window.whale.dev
  var DEV = !!(window.whale && window.whale.dev);
  function log() { if (DEV) console.log.apply(console, arguments); }
  function logErr() { if (DEV) console.error.apply(console, arguments); }
  if (window.whale && window.whale.__bridge) log('[whale][page] 已连接宿主桥接 window.whale');
  // 桥接缺失是严重异常，保留常显警告：生产环境也要留下用户侧线索
  else console.warn('[whale][page] 未检测到宿主桥接（preload 未加载？），余额/拖拽将不可用');

  // —— DOM ——
  var root = document.createElement('div');
  root.className = 'dshwv-root';

  var img = document.createElement('img');
  img.className = 'dshwv-img';
  img.src = IMG_URL;
  img.alt = 'DeepSeek 余额';
  img.draggable = false;

  var menuBtn = document.createElement('button');
  menuBtn.type = 'button';
  menuBtn.className = 'dshwv-menu-btn';
  menuBtn.title = '菜单';
  menuBtn.innerHTML = '<span></span><span></span><span></span>';
  menuBtn.addEventListener('click', function (e) { e.stopPropagation(); toggleMenu(); });

  var menuBox = document.createElement('div');
  menuBox.className = 'dshwv-menu';
  function menuLabel(text) { var s = document.createElement('span'); s.className = 'dshwv-menu-label'; s.textContent = text; return s; }
  function menuRow() { var r = document.createElement('div'); r.className = 'dshwv-menu-row'; return r; }

  // 菜单分组：点标题折叠/展开。只默认展开常用组，避免菜单过长
  function menuGroup(title, defaultOpen) {
    var box = document.createElement('div');
    box.className = 'dshwv-group';
    var head = document.createElement('button');
    head.type = 'button';
    head.className = 'dshwv-group-head';
    var arrow = document.createElement('span');
    arrow.className = 'dshwv-group-arrow';
    var name = document.createElement('span');
    name.textContent = title;
    head.appendChild(arrow); head.appendChild(name);
    var bodyEl = document.createElement('div');
    bodyEl.className = 'dshwv-group-body';
    box.appendChild(head); box.appendChild(bodyEl);
    var open = !!defaultOpen;
    function apply() {
      box.classList.toggle('dshwv-group-open', open);
      bodyEl.style.display = open ? '' : 'none';
      arrow.textContent = open ? '▾' : '▸';
    }
    head.addEventListener('click', function (e) {
      e.stopPropagation();
      open = !open;
      apply();
      positionMenu(); // 高度变化后重新夹取，保证菜单始终在按钮上方
    });
    apply();
    return { el: box, body: bodyEl };
  }

  var scaleInput = document.createElement('input');
  scaleInput.type = 'range';
  scaleInput.min = String(MIN_SCALE); scaleInput.max = String(MAX_SCALE); scaleInput.step = '0.1';
  scaleInput.className = 'dshwv-range'; scaleInput.value = '1.5';
  var scaleNumber = document.createElement('input');
  scaleNumber.type = 'number';
  scaleNumber.min = '1'; scaleNumber.max = '20'; scaleNumber.step = '1';
  scaleNumber.className = 'dshwv-number'; scaleNumber.value = '10';
  scaleInput.addEventListener('input', function () { setScale(scaleInput.value, false); });
  scaleInput.addEventListener('change', function () { setScale(scaleInput.value, true); });
  function numberToScale() {
    var v = Math.round(Number(scaleNumber.value));
    return MIN_SCALE + Math.max(0, Math.min(20, v) - 1) * (MAX_SCALE - MIN_SCALE) / 19;
  }
  scaleNumber.addEventListener('input', function () { setScale(numberToScale(), false); });
  scaleNumber.addEventListener('change', function () { setScale(numberToScale(), true); });

  function soundOpt(value, label) { var o = document.createElement('option'); o.value = value; o.textContent = label; return o; }
  var soundSelect = document.createElement('select');
  soundSelect.className = 'dshwv-sound';
  soundSelect.appendChild(soundOpt('duck', '小黄鸭'));
  soundSelect.appendChild(soundOpt('fx1', '音效1'));
  soundSelect.addEventListener('change', function () { setSoundSet(soundSelect.value); });

  var soundToggle = document.createElement('input');
  soundToggle.type = 'checkbox';
  soundToggle.className = 'dshwv-check';
  soundToggle.checked = true;
  soundToggle.title = '开启/关闭音效';
  soundToggle.addEventListener('change', function () { setSoundOn(soundToggle.checked); });

  var usageSelect = document.createElement('select');
  usageSelect.className = 'dshwv-sound';
  usageSelect.appendChild(soundOpt('ledger', '小鲸鱼记账 (推荐)'));
  usageSelect.appendChild(soundOpt('token', '实时·令牌 (需平台Token)'));
  usageSelect.addEventListener('change', function () { setUsageMode(usageSelect.value); });

  var peakSelect = document.createElement('select');
  peakSelect.className = 'dshwv-sound';
  peakSelect.appendChild(soundOpt('default', '默认'));
  peakSelect.appendChild(soundOpt('liangwen', '梁文峰谷'));
  peakSelect.appendChild(soundOpt('qiangqiang', '!?强强?!'));
  peakSelect.addEventListener('change', function () { setPeakMode(peakSelect.value); });

  var bubbleToggle = document.createElement('input');
  bubbleToggle.type = 'checkbox';
  bubbleToggle.className = 'dshwv-check';
  bubbleToggle.checked = true;
  bubbleToggle.title = '开启/关闭思考气泡';
  bubbleToggle.addEventListener('change', function () { setBubbleOn(bubbleToggle.checked); });

  var timeToggle = document.createElement('input');
  timeToggle.type = 'checkbox';
  timeToggle.className = 'dshwv-check';
  timeToggle.checked = true;
  timeToggle.title = '开启/关闭气泡报时';
  timeToggle.addEventListener('change', function () { setTimeBubbleOn(timeToggle.checked); });

  var remindToggle = document.createElement('input');
  remindToggle.type = 'checkbox';
  remindToggle.className = 'dshwv-check';
  remindToggle.checked = true;
  remindToggle.title = '峰/谷时段切换时用气泡提醒（需开启思考气泡）';
  remindToggle.addEventListener('change', function () { setPeakRemindOn(remindToggle.checked); });

  var lockToggle = document.createElement('input');
  lockToggle.type = 'checkbox';
  lockToggle.className = 'dshwv-check';
  lockToggle.checked = false;
  lockToggle.title = '锁定位置：禁止拖拽与滚轮缩放（点击刷新仍可用）';
  lockToggle.addEventListener('change', function () { setDragLock(lockToggle.checked); });

  // 计时 / 定时 / 倒计时：结果显示在思考气泡里（见 timerLines）
  var timerSelect = document.createElement('select');
  timerSelect.className = 'dshwv-sound';
  timerSelect.appendChild(soundOpt('off', '关闭'));
  timerSelect.appendChild(soundOpt('up', '正计时'));
  timerSelect.appendChild(soundOpt('down', '倒计时'));
  timerSelect.appendChild(soundOpt('at', '定时'));
  timerSelect.addEventListener('change', function () { setTimerMode(timerSelect.value); });

  var timerBtn = document.createElement('button');
  timerBtn.type = 'button';
  timerBtn.className = 'dshwv-menu-link dshwv-timer-btn';
  timerBtn.textContent = '开始';
  timerBtn.addEventListener('click', function (e) { e.stopPropagation(); timerBtnClick(); });

  // 重置：仅在计时中/暂停时出现（占满「目标」行），清掉进度回到未开始
  var timerResetBtn = document.createElement('button');
  timerResetBtn.type = 'button';
  timerResetBtn.className = 'dshwv-menu-link dshwv-timer-reset';
  timerResetBtn.textContent = '重置';
  timerResetBtn.title = '清掉本次计时进度（模式保留）';
  timerResetBtn.addEventListener('click', function (e) { e.stopPropagation(); resetTimer(); });

  var timerNum = document.createElement('input');
  timerNum.type = 'number';
  timerNum.min = '1'; timerNum.max = '1440'; timerNum.step = '1';
  timerNum.className = 'dshwv-number';
  timerNum.value = '25';
  timerNum.title = '倒计时分钟数（1–1440）';
  timerNum.addEventListener('change', function () { saveCfg(); });

  var timerTime = document.createElement('input');
  timerTime.type = 'time';
  timerTime.className = 'dshwv-number dshwv-timer-time';
  timerTime.value = '07:30';
  timerTime.title = '定时刻（HH:MM，已过点则顺延到明天）';
  timerTime.addEventListener('change', function () { saveCfg(); });

  var notifyToggle = document.createElement('input');
  notifyToggle.type = 'checkbox';
  notifyToggle.className = 'dshwv-check';
  notifyToggle.checked = true;
  notifyToggle.title = '计时到点时弹系统通知';
  notifyToggle.addEventListener('change', function () { setTimerNotifyOn(notifyToggle.checked); });

  var persistToggle = document.createElement('input');
  persistToggle.type = 'checkbox';
  persistToggle.className = 'dshwv-check';
  persistToggle.checked = true;
  persistToggle.title = '记住计时状态：重载插件/重建挂件后继续计时';
  persistToggle.addEventListener('change', function () { setTimerPersistOn(persistToggle.checked); });

  // 到点提醒气泡停留时长：0 = 常驻（手动点气泡关闭）
  var remindSelect = document.createElement('select');
  remindSelect.className = 'dshwv-sound';
  remindSelect.appendChild(soundOpt('5', '5 秒'));
  remindSelect.appendChild(soundOpt('8', '8 秒'));
  remindSelect.appendChild(soundOpt('15', '15 秒'));
  remindSelect.appendChild(soundOpt('0', '常驻'));
  remindSelect.title = '到点提醒气泡的停留时长（常驻 = 需手动点气泡关闭）';
  remindSelect.addEventListener('change', function () { setTimerRemindSec(remindSelect.value); });

  // 计时气泡是否常驻：关闭后计时中气泡只短暂显示，点小鲸鱼可随时再看
  var pinToggle = document.createElement('input');
  pinToggle.type = 'checkbox';
  pinToggle.className = 'dshwv-check';
  pinToggle.checked = true;
  pinToggle.title = '计时气泡常驻显示（关闭后只在开始时短暂显示，点小鲸鱼可随时查看）';
  pinToggle.addEventListener('change', function () { setTimerBubblePin(pinToggle.checked); });

  // 气泡内容：开 → 计时中气泡只显示计时；关 → 气泡照常显示余额/用量等全部内容
  var onlyToggle = document.createElement('input');
  onlyToggle.type = 'checkbox';
  onlyToggle.className = 'dshwv-check';
  onlyToggle.checked = true;
  onlyToggle.title = '开启：计时中气泡只显示计时；关闭：气泡照常显示余额、今日用量等全部内容';
  onlyToggle.addEventListener('change', function () { setTimerBubbleOnly(onlyToggle.checked); });

  var volInput = document.createElement('input');
  volInput.type = 'range';
  volInput.min = '0'; volInput.max = '1'; volInput.step = '0.05';
  volInput.className = 'dshwv-range'; volInput.value = '0.9';
  var volPct = document.createElement('span');
  volPct.className = 'dshwv-volpct';
  volPct.textContent = '90%';
  volInput.addEventListener('input', function () { setVol(volInput.value, false); });
  volInput.addEventListener('change', function () { setVol(volInput.value, true); });

  var row1 = menuRow();
  row1.appendChild(menuLabel('大小')); row1.appendChild(scaleInput); row1.appendChild(scaleNumber);
  var row2 = menuRow();
  row2.appendChild(menuLabel('音效')); row2.appendChild(soundToggle); row2.appendChild(soundSelect);
  var row3 = menuRow();
  row3.appendChild(menuLabel('音量')); row3.appendChild(volInput); row3.appendChild(volPct);
  var row4 = menuRow();
  row4.appendChild(menuLabel('用量')); row4.appendChild(usageSelect);
  var row5 = menuRow();
  row5.appendChild(menuLabel('峰谷')); row5.appendChild(peakSelect);
  var row6 = menuRow();
  row6.appendChild(menuLabel('气泡')); row6.appendChild(bubbleToggle);
  var rowRemind = menuRow();
  rowRemind.appendChild(menuLabel('峰谷提醒')); rowRemind.appendChild(remindToggle);
  var row7 = menuRow();
  row7.appendChild(menuLabel('报时')); row7.appendChild(timeToggle);
  var rowTimer = menuRow();
  rowTimer.appendChild(menuLabel('计时')); rowTimer.appendChild(timerSelect); rowTimer.appendChild(timerBtn);
  var rowTimerArg = menuRow();
  rowTimerArg.appendChild(menuLabel('目标')); rowTimerArg.appendChild(timerNum); rowTimerArg.appendChild(timerTime);
  rowTimerArg.appendChild(timerResetBtn);
  var rowNotify = menuRow();
  rowNotify.appendChild(menuLabel('到点通知')); rowNotify.appendChild(notifyToggle); rowNotify.appendChild(remindSelect);
  var rowOnly = menuRow();
  rowOnly.appendChild(menuLabel('只显计时')); rowOnly.appendChild(onlyToggle);
  var rowPin = menuRow();
  rowPin.appendChild(menuLabel('气泡常驻')); rowPin.appendChild(pinToggle);
  var rowPersist = menuRow();
  rowPersist.appendChild(menuLabel('计时保存')); rowPersist.appendChild(persistToggle);
  var row8 = menuRow();
  row8.appendChild(menuLabel('锁定')); row8.appendChild(lockToggle);
  var row9 = menuRow();
  var settingsBtn = document.createElement('button');
  settingsBtn.type = 'button';
  settingsBtn.className = 'dshwv-menu-link';
  settingsBtn.textContent = '打开设置';
  settingsBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    closeMenu();
    openSettings();
  });
  row9.appendChild(settingsBtn);
  row9.classList.add('dshwv-menu-foot');

  // —— dsh（DeepSeek Harness，开发者）：启动 / 重启 / 结束 / 更新 + 打开页面 + 状态 ——
  var dshStateEl = document.createElement('span');
  dshStateEl.className = 'dshwv-dsh-state';
  dshStateEl.textContent = '未获取';
  function dshBtn(text, action, title) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'dshwv-menu-link dshwv-dsh-btn';
    b.textContent = text;
    b.title = title;
    b.addEventListener('click', function (e) { e.stopPropagation(); dshSend(action); });
    return b;
  }
  var dshStartBtn = dshBtn('启动', 'start', '启动 dsh Web UI（npx 模式首次会先下载 @deepseek-ai/dsh）');
  var dshRestartBtn = dshBtn('重启', 'restart', '先结束再启动 dsh');
  var dshStopBtn = dshBtn('结束', 'stop', '结束 dsh 进程');
  var dshUpdateBtn = dshBtn('更新', 'update', '拉取最新版 dsh：npx 模式下载最新包；全局模式执行 npm i -g @deepseek-ai/dsh@latest');
  var dshOpenBtn = dshBtn('打开页面', 'open', '在系统浏览器打开 dsh 页面（自动使用 dsh 打印的带 token 地址，避免提示需要认证）');
  var rowDsh = menuRow();
  rowDsh.appendChild(menuLabel('dsh'));
  rowDsh.appendChild(dshStartBtn); rowDsh.appendChild(dshRestartBtn);
  rowDsh.appendChild(dshStopBtn); rowDsh.appendChild(dshUpdateBtn);
  var rowDshPage = menuRow();
  rowDshPage.appendChild(menuLabel('页面')); rowDshPage.appendChild(dshOpenBtn);
  var rowDshState = menuRow();
  rowDshState.appendChild(menuLabel('状态')); rowDshState.appendChild(dshStateEl);
  // 最近执行过的命令（太长就省略，悬停看完整内容；完整日志在设置页）
  var dshCmdEl = document.createElement('span');
  dshCmdEl.className = 'dshwv-dsh-cmd';
  dshCmdEl.textContent = '—';
  var rowDshCmd = menuRow();
  rowDshCmd.appendChild(menuLabel('命令')); rowDshCmd.appendChild(dshCmdEl);

  // 分组：常用组默认展开，其余折叠，菜单整体高度约减半
  var groupLook = menuGroup('外观与音效', true);
  groupLook.body.appendChild(row1); groupLook.body.appendChild(row2); groupLook.body.appendChild(row3);
  groupLook.body.appendChild(row6); groupLook.body.appendChild(row7); groupLook.body.appendChild(row8);
  var groupUsage = menuGroup('用量与峰谷', false);
  groupUsage.body.appendChild(row4); groupUsage.body.appendChild(row5);
  groupUsage.body.appendChild(rowRemind);
  var groupTimer = menuGroup('计时', false);
  groupTimer.body.appendChild(rowTimer); groupTimer.body.appendChild(rowTimerArg);
  groupTimer.body.appendChild(rowNotify); groupTimer.body.appendChild(rowOnly);
  groupTimer.body.appendChild(rowPin); groupTimer.body.appendChild(rowPersist);
  var groupDsh = menuGroup('dsh（开发者）', false);
  groupDsh.body.appendChild(rowDsh); groupDsh.body.appendChild(rowDshPage);
  groupDsh.body.appendChild(rowDshState); groupDsh.body.appendChild(rowDshCmd);
  menuBox.appendChild(groupLook.el);
  menuBox.appendChild(groupUsage.el);
  menuBox.appendChild(groupTimer.el);
  menuBox.appendChild(groupDsh.el);
  menuBox.appendChild(row9);

  // dsh 状态渲染（宿主回推快照；菜单打开与启动时也会主动问一次）
  function dshRender(s) {
    if (!s) return;
    var err = s.error ? String(s.error) : '';
    // 3080 上的进程：running=本插件启动；external=别的终端启动的 dsh；portOther=非 dsh 占用
    var ext = !!(s.external && s.externalPid);
    var other = s.portOther || '';
    var text = '未获取';
    if (s.busy === 'update') text = '更新中…';
    else if (s.busy === 'versions') text = '查询版本中…';
    else if (err) text = err;
    else if (s.running) text = s.stopping ? '正在结束…' : (s.ready ? '运行中 · pid ' + s.pid : '启动中…（3080 未就绪）');
    else if (ext) text = '外部 dsh · pid ' + s.externalPid;
    else if (other) text = '端口 3080 被 ' + other + ' 占用';
    else text = '未运行';
    var cls = 'dshwv-dsh-state';
    if (err) cls += ' dshwv-dsh-err';
    else if (s.running || ext) cls += ' dshwv-dsh-on';
    dshStateEl.className = cls;
    dshStateEl.textContent = text;
    dshStateEl.title = text +
      '\ndsh：' + (s.url || '') +
      (s.running ? '\n状态：' + (s.ready ? '3080 已就绪' : '启动中，npx 首次需下载，稍等') : '') +
      '\nNode：' + (s.nodeDir || '未找到') + (s.nodeVersion ? '（' + s.nodeVersion + '）' : '') +
      '\n方式：' + (s.mode === 'global' ? '全局安装（dsh 命令）' : 'npx ' + (s.version ? '@' + s.version : '@latest')) +
      (ext ? '\n外部进程：由别的终端启动，「结束」会结束它，「重启」会用当前配置重新启动' : '') +
      '\n页面：' + (s.webUrl ? '已捕获带 token 地址' : (s.url || '')) +
      '\n详细日志见设置页「DeepSeek Harness」';
    dshCmdEl.textContent = s.lastCmd || '—';
    dshCmdEl.title = s.lastCmd
      ? '最近执行的命令：\n' + s.lastCmd + '\n（完整日志见设置页「DeepSeek Harness」）'
      : '还没有执行过命令';
    var busy = s.busy === 'update' || s.busy === 'versions';
    dshStartBtn.disabled = !!s.running || ext || !!other || busy;
    dshRestartBtn.disabled = (!s.running && !ext) || busy;
    dshStopBtn.disabled = (!s.running && !ext) || !!s.stopping;
    dshUpdateBtn.disabled = busy;
  }
  function dshSend(action) {
    if (!HAS_BRIDGE) { dshRender({ error: '未连接宿主，无法控制 dsh' }); return; }
    if (action !== 'status') {
      dshStateEl.className = 'dshwv-dsh-state';
      dshStateEl.textContent = action === 'update' ? '更新中…' : '处理中…';
    }
    try { whaleApi.dsh(action); } catch (err) { dshRender({ error: '发送失败：' + (err && err.message) }); }
  }
  whaleApi.onDsh(function (s) { dshRender(s); });

  var textBox = document.createElement('div');
  textBox.className = 'dshwv-text';
  var labelEl = document.createElement('div');
  labelEl.className = 'dshwv-label';
  labelEl.textContent = 'DeepSeek 余额';
  var amountEl = document.createElement('div');
  amountEl.className = 'dshwv-amount';
  var hintEl = document.createElement('div');
  hintEl.className = 'dshwv-hint';
  textBox.appendChild(labelEl); textBox.appendChild(amountEl); textBox.appendChild(hintEl);

  var bubbleBox = document.createElement('div');
  bubbleBox.className = 'dshwv-bubble';
  bubbleBox.innerHTML =
    '<svg viewBox="0 0 1026 700" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg">' +
    '<path class="dshwv-bshape" fill="#FFFFFF" stroke="#203170" stroke-width="18" stroke-linejoin="round" stroke-linecap="round" d="M 827 248 A 373 232 0 1 0 81 246 A 373 232 0 0 0 301 465 A 57 32 10 0 0 413 484 A 373 232 0 0 0 827 248 Z"/>' +
    '<ellipse class="dshwv-b1" cx="352" cy="561" rx="37.5" ry="26" fill="#FFFFFF" stroke="#203170" stroke-width="18"/>' +
    '<ellipse class="dshwv-b2" cx="442" cy="646" rx="24.5" ry="18" fill="#FFFFFF" stroke="#203170" stroke-width="18"/>' +
    '</svg>';
  var gifEl = document.createElement('img');
  gifEl.className = 'dshwv-gif';
  gifEl.src = GIF_URL;
  gifEl.alt = '';
  gifEl.draggable = false;
  var gifFailed = false;
  gifEl.onerror = function () { gifFailed = true; };
  bubbleBox.appendChild(gifEl);
  bubbleBox.appendChild(textBox);
  bubbleBox.addEventListener('click', function (e) {
    e.stopPropagation();
    if (!bubbleShown) return;
    if (bubbleRandomActive || bubbleTimerActive) {
      // 「只显计时」关闭时计时只是先弹一下：点掉它要接着显示常规内容，而不是直接把气泡收起
      if (bubbleTimerActive && !timerTakesBubble()) { timerPeekDone(); return; }
      hideBubble(); // 再次点击：关闭（计时气泡收起后计时继续）
    } else {
      // 首次点击：切随机台词，并重置自动关闭计时（保证第二段有完整停留时间）
      bubbleRemindActive = false; // 用户点击后让随机台词接管，避免被峰谷提醒覆盖
      bubbleRemindLines = null;
      bubbleRandomActive = true;
      bubbleRandomLines = pickRandomLines();
      swapBubbleContent(function () { applyBubbleLines(bubbleRandomLines); });
      if (bubbleTimer) { clearTimeout(bubbleTimer); bubbleTimer = null; }
      bubbleTimer = setTimeout(hideBubble, BUBBLE_MS);
    }
  });

  var body = document.createElement('div');
  body.className = 'dshwv-body';
  body.appendChild(img);
  body.appendChild(bubbleBox);
  root.appendChild(body);
  root.appendChild(menuBtn);
  document.body.appendChild(root);
  document.body.appendChild(menuBox);

  // —— 状态 ——
  var state = { balance: null, currency: null, todayUsage: null, isPeak: false, status: 'loading', message: '' };
  var curScale = 1.5;
  var flipped = false;
  var animDelayTimer = null, drag = null, shown = null, animId = null;
  var bubbleShown = false, bubbleTimer = null, bubbleRandomActive = false, bubbleRandomLines = null;
  var bubbleRemindActive = false, bubbleRemindLines = null; // 峰谷提醒气泡（优先级高于随机台词）
  var bubbleTimerActive = false; // 计时气泡（正计时/倒计时/定时/时间到），优先级最高
  var BUBBLE_STYLE_CLASS = { A: 'dshwv-label', B: 'dshwv-amount', P: 'dshwv-period', C: 'dshwv-hint' };

  var soundOn = true, soundVol = 0.9, soundSet = 'duck';
  var timerNotifyOn = true, timerPersistOn = true; // 计时到点系统通知 / 计时状态持久化
  var usageMode = 'ledger', peakMode = 'default', bubbleOn = true;
  var peakRemindOn = true; // 峰/谷时段切换时用气泡提醒（需开启思考气泡）
  var menuBtnEnabled = true; // 挂件右上角菜单按钮开关（设置页可关）
  var lowAlertOn = true, lowAlertAmount = 10; // 低余额预警（余额低于阈值时数字变红）
  var timeBubbleOn = true; // 报时：气泡首行显示当前时间
  var dragLock = false; // 锁定位置：禁止拖拽与滚轮缩放（点击刷新仍可用）
  var menuOpen = false;
  var hideBtnTimer = null; // 菜单按钮延迟隐藏（鲸鱼→按钮之间的透明间隙里保持可点）
  var firstBalance = true, pendingManual = false;
  var lastIsPeak = null; // 上一次的峰谷状态，用于检测「进入峰时/谷时」的切换

  // —— 随机台词 ——
  function pickOne(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
  // 报时文案（鲸鱼娘语气，按时段变化）
  function timeLabel() {
    var d = new Date();
    var p2 = function (n) { return String(n).padStart(2, '0'); };
    var t = p2(d.getHours()) + ':' + p2(d.getMinutes());
    var h = d.getHours();
    if (h < 6) return '都 ' + t + ' 了，还不睡吗…';
    if (h >= 23) return '都 ' + t + ' 了，早点休息…';
    if (h < 11) return '早安~ 现在是 ' + t;
    return pickOne([
      '现在是 ' + t,
      '已经 ' + t + ' 啦',
      '都 ' + t + ' 了哦',
      '小鲸鱼报时：' + t,
    ]);
  }
  function singleCenter(style, text, color, wrap) { return [null, { t: text, s: style, c: color || '', w: !!wrap }, null]; }
  function fmt(balance, currency) {
    var num = Number(balance);
    var fixed = isFinite(num) ? num.toFixed(2) : '--';
    return currency === 'CNY' ? '¥ ' + fixed : fixed + ' ' + currency;
  }
  function buildGroup1() {
    var peak = !!state.isPeak;
    var offText = '空闲时段', peakText = '高峰时段';
    if (peakMode === 'liangwen') { offText = '梁文谷'; peakText = '梁文峰'; }
    else if (peakMode === 'qiangqiang') { offText = '!?谷谷?!'; peakText = '!?峰峰?!'; }
    return [
      { t: '当前时间段为:', s: 'A', c: '' },
      { t: peak ? peakText : offText, s: 'P', c: peak ? '#e0433f' : '#2fa24c' },
      { t: '今日已用 ' + fmt(state.todayUsage, state.currency), s: 'C', c: '' },
    ];
  }
  var RANDOM_GROUPS = [
    { w: 45, lines: buildGroup1 },
    { w: 7, lines: function () { return singleCenter('B', pickOne(['好模型... ↓', '好女孩...↓'])); } },
    { w: 7, lines: function () { return singleCenter('A', pickOne(['不知道用户有什么用，先赶走吧~', '我...我...我也要挣钱吗？', '我去吃饭啦，测完叫我', '压力一只蓝色大肥鱼？！', 'DeepSleep...', '坏了...用户彻底怒了！']), '', true); } },
    { w: 10, lines: function () { return { gif: true }; } },
    { w: 3, lines: function () { return singleCenter('A', pickOne(['你目录里的dsh是什么...大烧货吗...?', '恭喜你实现token自由！token全跑了！', '真当我是便宜货啊...']), '', true); } },
    { w: 1, lines: function () { return singleCenter('B', '哦鲸鲸... '); } },
  ];
  function pickRandomLines() {
    var total = 0, i;
    for (i = 0; i < RANDOM_GROUPS.length; i++) total += RANDOM_GROUPS[i].w;
    var r = Math.random() * total;
    for (i = 0; i < RANDOM_GROUPS.length; i++) {
      r -= RANDOM_GROUPS[i].w;
      if (r < 0) return RANDOM_GROUPS[i].lines();
    }
    return RANDOM_GROUPS[RANDOM_GROUPS.length - 1].lines();
  }

  // —— 峰谷时段提醒 ——
  // 时段表在页面内按内置规则拼出（浮动页没有 require，读不到宿主 constants）
  var PEAK_HOURS = [[9, 12], [14, 18]]; // 工作日峰时（北京时间）
  function scheduleText() {
    var ranges = PEAK_HOURS.map(function (h) { return h[0] + '-' + h[1]; }).join('/');
    return '峰时' + ranges + '点，其余谷时';
  }
  // 气泡只有三行，把「标题 / 正文 / 时段表」压缩映射为 A=标题、P=时段、C=正文+时段表
  function peakRemindLines(isPeak) {
    var body = isPeak
      ? '叮咚～进入峰时段啦（北京时间）！' + scheduleText()
      : '好消息～进入谷时段啦（北京时间）！峰时' + PEAK_HOURS.map(function (h) { return h[0] + '-' + h[1]; }).join('/') + '点外为谷时';
    return [
      { t: isPeak ? '【峰时提醒】' : '【谷时提醒】', s: 'A', c: '' },
      { t: isPeak ? '峰时' : '谷时', s: 'P', c: isPeak ? '#e0433f' : '#2fa24c' },
      { t: body, s: 'C', c: '', w: true },
    ];
  }

  // —— 计时 / 定时 / 倒计时（结果显示在思考气泡内，每秒刷新） ——
  var TIMER_MIN_DEFAULT = 25, TIMER_MAX_MIN = 1440;
  var timerMode = 'off';     // off | up(正计时) | down(倒计时) | at(定时)
  var timerRunning = false;  // 正在走秒
  var timerPaused = false;   // 已暂停：进度保留，点「继续」接着走
  var timerFinished = false; // 刚结束，气泡里显示「时间到」
  var timerStartAt = 0;      // 正计时本段起点（暂停时为 0）
  var timerEndAt = 0;        // 倒计时/定时终点（暂停时为 0）
  var timerElapsed = 0;      // 正计时累计已计毫秒
  var timerRemain = 0;       // 倒计时/定时暂停时的剩余毫秒
  var timerArg = '';         // 倒计时分钟数 / 定时 HH:MM
  var timerRemindSec = 8;    // 到点提醒气泡停留秒数（0 = 常驻，手动点气泡关闭）
  var timerBubblePin = true; // 计时中气泡是否常驻显示（关闭则只短暂显示，点小鲸鱼可再看）
  var timerBubbleOnly = true; // 气泡是否只显示计时：关掉后气泡照常显示余额/用量等全部内容
  var timerTick = null;
  var timerClockText = '';   // 气泡里已渲染的时钟文本：每秒只改这一处，避免整块重排
  function pad2(n) { return n < 10 ? '0' + n : String(n); }
  function fmtClock(ms) {
    var s = Math.max(0, Math.round(ms / 1000));
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return h > 0 ? h + ':' + pad2(m) + ':' + pad2(sec) : pad2(m) + ':' + pad2(sec);
  }
  function fmtHm(ts) {
    var d = new Date(ts);
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }
  function timerActive() { return timerRunning || timerPaused || timerFinished; }
  function timerBusy() { return timerRunning || timerPaused; }
  function timerModeLabel() { return timerMode === 'up' ? '正计时' : (timerMode === 'at' ? '定时' : '倒计时'); }
  function timerLabelText() { return timerPaused ? timerModeLabel() + '（已暂停）' : timerModeLabel(); }
  function timerRemainMs() {
    if (timerMode === 'up') return timerRunning ? timerElapsed + (Date.now() - timerStartAt) : timerElapsed;
    if (timerRunning) return Math.max(0, timerEndAt - Date.now());
    return Math.max(0, timerRemain);
  }
  function timerTailText() {
    if (timerFinished) return '点气泡关闭提醒';
    if (timerPaused) return '点继续接着走';
    if (timerMode === 'up') return '点气泡可收起';
    if (timerMode === 'at') {
      // 跨到明天时标明「明天」，避免误读成今天到点
      var d = new Date(timerEndAt);
      var now = new Date();
      var crossDay = d.getFullYear() !== now.getFullYear() || d.getMonth() !== now.getMonth() || d.getDate() !== now.getDate();
      return '到点 ' + (crossDay ? '明天 ' : '') + fmtHm(timerEndAt);
    }
    return '共 ' + timerArg + ' 分钟';
  }
  function timerLines() {
    if (timerFinished) {
      return [
        { t: timerModeLabel() + '结束', s: 'A', c: '' },
        { t: '时间到！', s: 'P', c: '#e0433f' },
        { t: timerTailText(), s: 'C', c: '', w: true },
      ];
    }
    return [
      { t: timerLabelText(), s: 'A', c: '' },
      { t: fmtClock(timerRemainMs()), s: 'P', c: '' },
      { t: timerTailText(), s: 'C', c: '', w: true },
    ];
  }
  // 每秒只改时钟那一行：文案结构没变就不重新测量/缩放字号（只有位数变化时才补一次适配）
  function updateTimerClock() {
    if (!bubbleTimerActive) return;
    var txt = fmtClock(timerRemainMs());
    if (txt === timerClockText) return;
    var lenChanged = txt.length !== timerClockText.length;
    timerClockText = txt;
    amountEl.textContent = txt;
    if (lenChanged) fitBubbleText();
  }
  // 单次推进：刷新气泡显示 + 判断是否到点（窗口被后台节流时，恢复可见时会立即补一次）
  function timerStep() {
    if (!timerRunning) return;
    if (timerMode !== 'up' && Date.now() >= timerEndAt) { finishTimer(); return; }
    updateTimerClock();
  }
  function startTimerTick() {
    if (timerTick) return;
    timerTick = setInterval(timerStep, 1000);
  }
  function stopTimerTick() {
    if (!timerTick) return;
    clearInterval(timerTick);
    timerTick = null;
  }
  function timerRemindMs() { return Math.max(0, timerRemindSec) * 1000; }
  // 计时气泡的自动收起时长：0 = 常驻。到点提醒用「提醒时长」；计时中：
  // 「只显计时」开 → 按「气泡常驻」；关 → 只先弹出来提示一下，随后回到余额/用量的常规气泡
  function timerBubbleAutoMs() {
    if (timerFinished) return timerRemindMs();
    return (timerBubbleOnly && timerBubblePin) ? 0 : BUBBLE_MS;
  }
  // 计时气泡是否占用思考气泡：到点提醒始终显示；计时中/暂停时由「只显计时」开关决定
  function timerTakesBubble() { return timerFinished || timerBubbleOnly; }
  // 到点系统通知（走宿主 utools.showNotification）
  function notifyTimerDone() {
    if (!timerNotifyOn) return;
    var text = timerMode === 'at'
      ? '小鲸鱼提醒：定时到点（' + timerArg + '）'
      : '小鲸鱼提醒：倒计时结束（' + timerArg + ' 分钟）';
    try { whaleApi.notifyTimerDone(text); } catch (err) { logErr('[whale][page] 计时通知失败', err && err.message); }
  }
  // —— 计时状态持久化（开关关闭时不落库；宿主在关闭时会清掉旧值） ——
  function currentTimerState() {
    return {
      mode: timerMode,
      running: timerRunning,
      paused: timerPaused,
      startAt: (timerRunning && timerMode === 'up') ? timerStartAt : 0,
      endAt: (timerRunning && timerMode !== 'up') ? timerEndAt : 0,
      elapsed: timerMode === 'up' ? timerElapsed : 0,
      remain: (timerPaused && timerMode !== 'up') ? timerRemain : 0,
      arg: timerArg,
    };
  }
  function saveTimerState() {
    if (!timerPersistOn) return;
    try { whaleApi.saveTimer(currentTimerState()); } catch (err) {}
  }
  // 重建挂件后恢复计时（仅在「计时保存」开启时宿主才会回推 timer）
  function restoreTimer(t) {
    if (!t || !timerPersistOn) return;
    if (t.mode !== 'up' && t.mode !== 'down' && t.mode !== 'at') return;
    timerMode = t.mode;
    timerArg = typeof t.arg === 'string' ? t.arg : '';
    timerFinished = false;
    if (t.running) {
      if (timerMode === 'up') {
        timerStartAt = Number(t.startAt) || Date.now();
      } else {
        timerEndAt = Number(t.endAt) || 0;
        // 挂件不在期间已到点：补一次提示音 + 通知 + 气泡
        if (!timerEndAt || Date.now() >= timerEndAt) { finishTimer(); return; }
      }
      timerRunning = true;
      timerPaused = false;
      startTimerTick();
      syncTimerMenu();
      showTimerBubble(timerBubbleAutoMs());
      return;
    }
    // 未在运行：可能只是选了模式、或停在暂停中 —— 都不补「到点」，避免误报
    timerElapsed = Math.max(0, Number(t.elapsed) || 0);
    timerRemain = Math.max(0, Number(t.remain) || 0);
    timerPaused = !!t.paused;
    syncTimerMenu();
    if (timerPaused) showTimerBubble(timerBubbleAutoMs());
  }
  // 到点：提示音（沿用音效开关与音量）+ 系统通知 + 气泡显示「时间到！」，默认 8s 后自动收起
  function finishTimer() {
    timerRunning = false;
    timerPaused = false;
    stopTimerTick();
    timerFinished = true;
    timerClockText = '';
    playPress();
    notifyTimerDone();
    saveTimerState();
    syncTimerMenu();
    showTimerBubble(timerRemindMs());
  }
  function startTimer() {
    var now = Date.now();
    if (timerMode === 'down') {
      var mins = Math.round(Number(timerNum.value));
      if (!isFinite(mins) || mins <= 0) mins = TIMER_MIN_DEFAULT;
      mins = Math.min(TIMER_MAX_MIN, Math.max(1, mins));
      timerNum.value = String(mins);
      timerArg = String(mins);
      timerEndAt = now + mins * 60000;
      timerRemain = 0;
    } else if (timerMode === 'at') {
      var m = /^(\d{1,2}):(\d{2})$/.exec(String(timerTime.value || ''));
      var hh = m ? Math.min(23, Number(m[1])) : 7;
      var mm = m ? Math.min(59, Number(m[2])) : 30;
      timerArg = pad2(hh) + ':' + pad2(mm);
      timerTime.value = timerArg;
      var d = new Date();
      d.setHours(hh, mm, 0, 0);
      // 该时刻今天已过 → 顺延到明天
      if (d.getTime() <= now) d.setDate(d.getDate() + 1);
      timerEndAt = d.getTime();
      timerRemain = 0;
    } else {
      timerMode = 'up';
      timerStartAt = now;
      timerElapsed = 0;
      timerRemain = 0;
    }
    timerRunning = true;
    timerPaused = false;
    timerFinished = false;
    startTimerTick();
    saveCfg();       // 记住这次用的模式与参数
    saveTimerState();
    syncTimerMenu();
    showTimerBubble(timerBubbleAutoMs()); // 开始/暂停/继续都先弹计时：常驻时不收起，否则短暂提示
  }
  // 暂停：保留进度（正计时记住已计时间，倒计时/定时记住剩余时间），继续时接着走
  function pauseTimer() {
    var now = Date.now();
    if (timerMode === 'up') {
      timerElapsed += now - timerStartAt;
      timerStartAt = 0;
    } else {
      timerRemain = Math.max(0, timerEndAt - now);
      timerEndAt = 0;
    }
    timerRunning = false;
    timerPaused = true;
    stopTimerTick();
    saveTimerState();
    syncTimerMenu();
    showTimerBubble(timerBubbleAutoMs());
  }
  function resumeTimer() {
    var now = Date.now();
    if (timerMode === 'up') timerStartAt = now;
    else timerEndAt = now + Math.max(0, timerRemain);
    timerRemain = 0;
    timerRunning = true;
    timerPaused = false;
    startTimerTick();
    saveTimerState();
    syncTimerMenu();
    showTimerBubble(timerBubbleAutoMs());
  }
  // 完全复位（切模式 / 点「重置」）：清掉进度回到未开始；不传 nextMode 则保留当前模式
  function resetTimer(nextMode) {
    timerRunning = false;
    timerPaused = false;
    timerFinished = false;
    timerStartAt = 0;
    timerEndAt = 0;
    timerElapsed = 0;
    timerRemain = 0;
    timerClockText = '';
    stopTimerTick();
    if (nextMode !== undefined) timerMode = nextMode;
    if (bubbleTimerActive) hideBubble();
    saveTimerState();
    syncTimerMenu();
  }
  function setTimerMode(v) {
    var next = (v === 'up' || v === 'down' || v === 'at') ? v : 'off';
    resetTimer(next);
    saveCfg(); // 记住所选模式，重载后不用重新选
  }
  function setTimerNotifyOn(v) {
    timerNotifyOn = !!v;
    notifyToggle.checked = timerNotifyOn;
    saveCfg();
  }
  function setTimerPersistOn(v) {
    timerPersistOn = !!v;
    persistToggle.checked = timerPersistOn;
    saveCfg();
    // 关闭：宿主收到配置后会清掉已落库的计时；开启：立即把当前状态存一次
    saveTimerState();
  }
  function setTimerRemindSec(v) {
    var n = Math.round(Number(v));
    timerRemindSec = (n === 0 || n === 5 || n === 8 || n === 15) ? n : 8;
    remindSelect.value = String(timerRemindSec);
    saveCfg();
  }
  function setTimerBubblePin(v) {
    timerBubblePin = !!v;
    pinToggle.checked = timerBubblePin;
    saveCfg();
    // 立即套用：开启 → 一直显示；关闭 → 重新按「短暂停留」计时收起
    if (timerActive() && timerTakesBubble()) showTimerBubble(timerBubbleAutoMs());
  }
  // 「只显计时」开关：开 → 计时中气泡只显示计时；关 → 气泡照常显示余额/用量等全部内容
  function setTimerBubbleOnly(v) {
    timerBubbleOnly = !!v;
    onlyToggle.checked = timerBubbleOnly;
    saveCfg();
    if (!timerActive()) return;
    if (timerBubbleOnly) {
      showTimerBubble(timerBubbleAutoMs());
    } else if (bubbleTimerActive && !timerFinished) {
      // 关掉后立刻把气泡切回余额/用量，方便直接看到效果
      hideBubble();
      showBubble(true);
    }
  }
  // 主按钮：开始 → 暂停 → 继续 →（到点后）开始
  function timerBtnClick() {
    if (timerRunning) { pauseTimer(); return; }
    if (timerPaused) { resumeTimer(); return; }
    if (timerMode === 'off') timerMode = 'up';
    startTimer();
  }
  function syncTimerMenu() {
    timerSelect.value = timerMode;
    timerBtn.textContent = timerRunning ? '暂停' : (timerPaused ? '继续' : '开始');
    var busy = timerBusy();
    // 「目标」行：计时中/暂停时让位给「重置」；未开始时才显示分钟数/时刻输入
    rowTimerArg.style.display = (busy || (!timerFinished && (timerMode === 'down' || timerMode === 'at'))) ? '' : 'none';
    timerResetBtn.style.display = busy ? '' : 'none';
    timerNum.style.display = (!busy && timerMode === 'down') ? '' : 'none';
    timerTime.style.display = (!busy && timerMode === 'at') ? '' : 'none';
  }

  // —— 气泡内容 ——
  var bubbleSwapTimer = null, hintFadeTimer = null, gifFadeTimer = null, lastHintText = null;
  // 气泡自适应：三行字号固定，长文案换行后可能撑出气泡，这里按可用区域测量后等比缩小字号
  // （只缩不放，正常内容保持原字号）；单位 u = 挂件基准 / 1026，与 CSS 的 --dshw-u 一致
  var BUBBLE_FONT = { 'dshwv-label': 66, 'dshwv-amount': 128, 'dshwv-period': 104, 'dshwv-hint': 56 };
  // 气泡内文字可用区域（单位 u = 挂件基准/1026）。与 CSS 里 .dshwv-bubble 的放大倍数(1.18)保持一致：
  // 圆圈放大多少，这里就放大多少，字号才会跟着变大而不是被压小
  var FIT_W = 660, FIT_H = 390, FIT_MIN = 0.5;
  function resetBubbleFont() {
    labelEl.style.fontSize = '';
    amountEl.style.fontSize = '';
    hintEl.style.fontSize = '';
  }
  // 量出文本块的真实占位：宽取各行「内容宽度」的最大值（scrollWidth 能反映 nowrap 溢出的宽度，
  // 而 offsetWidth 会被绝对定位的 shrink-to-fit 上限截断），高为可见各行 offsetHeight 之和。
  // 均用布局尺寸而非 getBoundingClientRect：后者会带上 Q 弹的 scaleY(.88)/scaleX(1.05)
  // 与贴左镜像的 scaleX(-1)，导致测量失真。
  function measureBubbleText(els) {
    var w = 0, h = 0, i;
    for (i = 0; i < 3; i++) {
      var el = els[i];
      if (el.style.display === 'none') continue;
      if (el.scrollWidth > w) w = el.scrollWidth;
      h += el.offsetHeight;
    }
    return { w: w, h: h };
  }
  function fitBubbleText() {
    if (gifEl.style.display === 'block') return;
    var u = (root.clientWidth || 0) / 1026;
    if (!u) return;
    var els = [labelEl, amountEl, hintEl];
    var availW = FIT_W * u, availH = FIT_H * u;
    var i, k = 1, pass, m;
    for (pass = 0; pass < 3; pass++) {
      m = measureBubbleText(els);
      if (!m.w || !m.h) return;
      var f = Math.min(1, availW / m.w, availH / m.h);
      if (f > 0.995) return;
      k = Math.max(FIT_MIN, k * f);
      for (i = 0; i < 3; i++) {
        var base = BUBBLE_FONT[String(els[i].className).split(' ')[0]];
        if (base) els[i].style.fontSize = 'calc(var(--dshw-u) * ' + (base * k).toFixed(1) + ')';
      }
      if (k <= FIT_MIN + 0.001) return;
    }
  }
  function applyBubbleLines(lines) {
    if (lines && lines.gif) {
      if (gifFailed) {
        lines = singleCenter('A', pickOne(['gif 加载失败了...', '今天没有动图给你看~', '呜呜 动图不见了...']), '', true);
      } else {
        if (gifFadeTimer) { clearTimeout(gifFadeTimer); gifFadeTimer = null; }
        gifEl.style.display = 'block';
        gifEl.style.opacity = '';
        labelEl.style.display = 'none';
        amountEl.style.display = 'none';
        hintEl.style.display = 'none';
        return;
      }
    }
    if (gifFadeTimer) { clearTimeout(gifFadeTimer); gifFadeTimer = null; }
    gifEl.style.display = 'none';
    gifEl.style.opacity = '';
    resetBubbleFont();
    var els = [labelEl, amountEl, hintEl];
    for (var i = 0; i < 3; i++) {
      var el = els[i];
      var ln = lines && lines[i];
      if (ln) {
        el.style.display = '';
        el.className = (BUBBLE_STYLE_CLASS[ln.s] || 'dshwv-label') + (ln.w ? ' dshwv-wrap' : '');
        el.textContent = ln.t;
        el.style.color = ln.c || '';
      } else {
        el.style.display = 'none';
        el.textContent = '';
        el.style.color = '';
      }
    }
    fitBubbleText();
  }
  function setHint(text) {
    if (text === lastHintText) return;
    var first = lastHintText === null;
    lastHintText = text;
    if (first || !bubbleShown) { hintEl.textContent = text; return; }
    hintEl.style.transition = 'opacity .18s ease';
    hintEl.style.opacity = '0';
    hintFadeTimer = setTimeout(function () {
      hintFadeTimer = null;
      hintEl.textContent = text;
      hintEl.style.opacity = '1';
      setTimeout(function () { hintEl.style.transition = ''; hintEl.style.opacity = ''; }, 220);
    }, 190);
  }
  function swapBubbleContent(applyFn) {
    if (bubbleSwapTimer) { clearTimeout(bubbleSwapTimer); bubbleSwapTimer = null; }
    textBox.style.transition = 'opacity .18s ease';
    textBox.style.opacity = '0';
    bubbleSwapTimer = setTimeout(function () {
      bubbleSwapTimer = null;
      applyFn();
      textBox.style.opacity = '1';
      setTimeout(function () { textBox.style.transition = ''; textBox.style.opacity = ''; }, 220);
    }, 190);
  }
  function restoreBubbleLines() {
    if (bubbleSwapTimer) { clearTimeout(bubbleSwapTimer); bubbleSwapTimer = null; }
    if (hintFadeTimer) { clearTimeout(hintFadeTimer); hintFadeTimer = null; }
    if (gifFadeTimer) { clearTimeout(gifFadeTimer); gifFadeTimer = null; }
    lastHintText = null;
    textBox.style.transition = '';
    textBox.style.opacity = '';
    resetBubbleFont();
    gifEl.style.display = 'none';
    gifEl.style.opacity = '';
    labelEl.style.display = '';
    labelEl.className = 'dshwv-label';
    labelEl.textContent = timeBubbleOn ? timeLabel() : 'DeepSeek 余额';
    labelEl.style.color = '';
    amountEl.style.display = '';
    amountEl.className = 'dshwv-amount';
    amountEl.style.color = '';
    hintEl.style.display = '';
    hintEl.className = 'dshwv-hint';
    hintEl.style.color = '';
    render();
  }
  function showBubble(fromUser) {
    if (!bubbleOn) return;
    // 计时中/刚结束：气泡优先显示计时（「只显计时」关掉后交给下面的常规内容），
    // 不会被余额或随机台词顶掉
    if (timerActive() && timerTakesBubble()) {
      // 「气泡常驻」关闭时：只有用户点小鲸鱼才弹出计时，避免余额刷新时反复弹
      if (!timerBubblePin && !fromUser && !timerFinished) return;
      showTimerBubble(timerBubbleAutoMs());
      return;
    }
    // 「只显计时」关闭：点小鲸鱼先显示一眼计时，随后继续常规内容（余额/用量/报时）
    if (fromUser && timerActive() && !timerFinished) {
      showTimerBubble(TIMER_PEEK_MS, true);
      return;
    }
    if (bubbleTimer) { clearTimeout(bubbleTimer); bubbleTimer = null; }
    if (gifFadeTimer) { clearTimeout(gifFadeTimer); gifFadeTimer = null; }
    bubbleShown = true;
    bubbleRandomActive = false;
    bubbleRemindActive = false;
    bubbleRemindLines = null;
    restoreBubbleLines();
    bubbleBox.classList.add('dshwv-bubble-open');
    bubbleTimer = setTimeout(hideBubble, BUBBLE_MS);
  }
  // 「只显计时」关闭时，计时先显示一段后原地切回常规内容（气泡不收起，继续按常规时长停留）
  function timerPeekDone() {
    bubbleTimerActive = false;
    timerClockText = '';
    if (!bubbleShown) return; // 期间已被用户/其他开关收起：不再把它弹回来
    showBubble(false);
  }
  // 计时气泡：autoHideMs=0 表示常驻（点气泡可收起，计时继续）；thenNormal=true 表示到时切回常规内容
  function showTimerBubble(autoHideMs, thenNormal) {
    if (!bubbleOn) return;
    if (bubbleTimer) { clearTimeout(bubbleTimer); bubbleTimer = null; }
    if (gifFadeTimer) { clearTimeout(gifFadeTimer); gifFadeTimer = null; }
    bubbleShown = true;
    bubbleRandomActive = false;
    bubbleRandomLines = null;
    bubbleRemindActive = false;
    bubbleRemindLines = null;
    bubbleTimerActive = true;
    restoreBubbleLines();
    applyBubbleLines(timerLines());
    timerClockText = timerFinished ? '' : fmtClock(timerRemainMs());
    bubbleBox.classList.add('dshwv-bubble-open');
    if (autoHideMs) bubbleTimer = setTimeout(thenNormal ? timerPeekDone : hideBubble, autoHideMs);
  }
  // 峰/谷时段切换提醒：独立于随机台词，停留更久（内容多一行时段表）
  function showPeakRemind(isPeak) {
    if (!bubbleOn || timerActive()) return; // 计时进行中不打断
    if (bubbleTimer) { clearTimeout(bubbleTimer); bubbleTimer = null; }
    if (gifFadeTimer) { clearTimeout(gifFadeTimer); gifFadeTimer = null; }
    bubbleShown = true;
    bubbleRandomActive = false;
    bubbleRandomLines = null;
    bubbleRemindActive = true;
    bubbleRemindLines = peakRemindLines(isPeak);
    restoreBubbleLines();
    applyBubbleLines(bubbleRemindLines);
    bubbleBox.classList.add('dshwv-bubble-open');
    bubbleTimer = setTimeout(hideBubble, BUBBLE_REMIND_MS);
  }
  function hideBubble() {
    if (bubbleTimer) { clearTimeout(bubbleTimer); bubbleTimer = null; }
    if (bubbleSwapTimer) { clearTimeout(bubbleSwapTimer); bubbleSwapTimer = null; }
    if (hintFadeTimer) { clearTimeout(hintFadeTimer); hintFadeTimer = null; }
    textBox.style.transition = '';
    textBox.style.opacity = '';
    hintEl.style.transition = '';
    hintEl.style.opacity = '';
    bubbleRandomActive = false;
    bubbleRandomLines = null;
    bubbleRemindActive = false;
    bubbleRemindLines = null;
    bubbleTimerActive = false;
    timerClockText = '';
    // 「时间到」提示收起后回到普通状态（计时已结束，模式保留便于重新开始）
    if (timerFinished) { timerFinished = false; syncTimerMenu(); }
    bubbleShown = false;
    bubbleBox.classList.remove('dshwv-bubble-open');
    // gif 靠 CSS opacity 淡出；display:none 会跳过过渡，等淡出完成再隐藏
    gifFadeTimer = setTimeout(function () { gifFadeTimer = null; gifEl.style.display = 'none'; }, 240);
  }

  // —— 数字渲染 / 滚动动画 ——
  function animateAmount(from, to, currency, duration) {
    if (animId) cancelAnimationFrame(animId);
    if (from === null || !isFinite(from)) from = to;
    if (from === to) { shown = to; amountEl.textContent = fmt(to, currency); return; }
    var startTime = null;
    function step(ts) {
      if (startTime === null) startTime = ts;
      var t = Math.min(1, (ts - startTime) / duration);
      var eased = 1 - Math.pow(1 - t, 3);
      var val = from + (to - from) * eased;
      amountEl.textContent = fmt(val, currency);
      if (t < 1) { animId = requestAnimationFrame(step); }
      else { animId = null; shown = to; amountEl.textContent = fmt(to, currency); }
    }
    animId = requestAnimationFrame(step);
  }
  function applyLowAlert() {
    var low = lowAlertOn && state.balance !== null && isFinite(Number(state.balance)) && Number(state.balance) < lowAlertAmount;
    amountEl.classList.toggle('dshwv-low', low);
    hintEl.classList.toggle('dshwv-low', low);
  }
  function render() {
    var amount, hint;
    if (state.status === 'error') {
      amount = shown !== null ? fmt(shown, state.currency) : '--';
      hint = state.message ? state.message.slice(0, 14) : '获取失败 · 点击重试';
    } else if (state.balance === null) {
      amount = shown !== null ? fmt(shown, state.currency) : '…';
      hint = '加载中…';
    } else {
      amount = shown !== null ? fmt(shown, state.currency) : fmt(state.balance, state.currency);
      hint = '今日已用 ' + (state.todayUsage !== null && state.todayUsage !== undefined ? fmt(state.todayUsage, state.currency) : '--');
    }
    amountEl.textContent = amount;
    if (bubbleTimerActive && timerActive()) {
      applyBubbleLines(timerLines());
      timerClockText = timerFinished ? '' : fmtClock(timerRemainMs());
    } else if (bubbleRemindActive && bubbleRemindLines) {
      applyBubbleLines(bubbleRemindLines);
    } else if (bubbleRandomActive && bubbleRandomLines) {
      applyBubbleLines(bubbleRandomLines);
    } else {
      resetBubbleFont(); // 退出气泡文案后恢复默认字号
      setHint(hint);
      applyLowAlert();
      // 报时/余额文案过长时同样等比缩小，避免超出气泡（与计时/随机台词走同一套适配）
      fitBubbleText();
    }
  }

  // —— 余额 ——
  function refresh(manual) {
    pendingManual = !!manual;
    if (manual || state.balance === null) { state.status = 'loading'; render(); }
    whaleApi.refresh(manual);
  }
  function handleBalance(data, manual) {
    if (data && data.ok) {
      var nb = Number(data.totalBalance);
      var nc = String(data.currency || 'CNY');
      var changed = state.balance !== null && (nb !== state.balance || nc !== state.currency);
      var currencyChanged = state.currency !== null && nc !== state.currency;
      state.balance = nb;
      state.currency = nc;
      state.message = '';
      state.todayUsage = data.todayUsage !== undefined ? data.todayUsage : null;
      state.isPeak = !!data.isPeak;
      // 峰/谷时段切换：仅在上一次已有状态且发生变化时提醒（首次拉取不弹）
      var peakChanged = lastIsPeak !== null && lastIsPeak !== state.isPeak;
      lastIsPeak = state.isPeak;
      if (peakChanged && peakRemindOn) showPeakRemind(state.isPeak);
      if (changed && !currencyChanged) {
        if (!manual && !firstBalance) {
          // 自动刷新发现余额变动：气泡弹出，0.3s 后数字滚动
          if (!bubbleRemindActive) showBubble(); // 峰谷提醒优先，避免被余额气泡覆盖
          state.status = 'changing';
          if (animDelayTimer) clearTimeout(animDelayTimer);
          animDelayTimer = setTimeout(function () {
            animDelayTimer = null;
            animateAmount(shown, nb, nc, ANIM_MS);
          }, 300);
          setTimeout(function () {
            if (state.status === 'changing') { state.status = 'ok'; render(); }
          }, CHANGE_MS + 300);
        } else {
          animateAmount(shown, nb, nc, ANIM_MS);
          state.status = 'ok';
          render();
        }
      } else {
        if (animId === null) shown = nb;
        state.status = 'ok';
        render();
      }
      firstBalance = false;
    } else {
      state.status = 'error';
      // 气泡空间小，错误提示用短句；完整原因在设置页「测试连接」里查看
      var code = data && data.code;
      state.message = code === 'AUTH' ? 'API Key 无效 · 请到设置页检查'
        : code === 'BAD_KEY' ? 'Key 格式错误 · 应为 sk- 开头'
        : code === 'NO_KEY' ? '未配置 API Key · 请到设置页填写'
        : (data && data.error) ? String(data.error).slice(0, 14) : '获取失败 · 点击重试';
      render();
    }
  }

  // —— 配置（菜单改动 → 上报宿主；宿主回推 config 统一 apply） ——
  function saveCfg() {
    whaleApi.saveConfig({
      scale: curScale, vol: soundVol, soundOn: soundOn, soundSet: soundSet,
      usageMode: usageMode, peakMode: peakMode, bubbleOn: bubbleOn,
      timeBubbleOn: timeBubbleOn, peakRemindOn: peakRemindOn, dragLock: dragLock,
      timerNotifyOn: timerNotifyOn, timerPersistOn: timerPersistOn,
      timerMode: timerMode,
      timerMin: Math.min(TIMER_MAX_MIN, Math.max(1, Math.round(Number(timerNum.value) || TIMER_MIN_DEFAULT))),
      timerAt: String(timerTime.value || ''),
      timerRemindSec: timerRemindSec,
      timerBubblePin: timerBubblePin,
      timerBubbleOnly: timerBubbleOnly,
    });
  }
  function scaleToDisplay(s) {
    return Math.round((s - MIN_SCALE) / ((MAX_SCALE - MIN_SCALE) / 19)) + 1;
  }
  // 拖动中的实时预览：rAF 合并，只通知宿主改窗口几何，不写存储、不回推
  var liveRaf = 0;
  function sendLiveScale() {
    if (liveRaf) return;
    liveRaf = requestAnimationFrame(function () {
      liveRaf = 0;
      whaleApi.saveConfig({ scale: curScale, __live: true });
    });
  }
  function setScale(v, commit) {
    // 窗口尺寸由宿主调整（以鲸鱼角为不动点）；拖动中仅实时预览，松手(change)才持久化
    curScale = Math.round(Math.min(MAX_SCALE, Math.max(MIN_SCALE, Number(v))) * 10) / 10;
    scaleInput.value = String(curScale);
    scaleNumber.value = String(scaleToDisplay(curScale));
    if (commit) { if (liveRaf) { cancelAnimationFrame(liveRaf); liveRaf = 0; } saveCfg(); }
    else sendLiveScale();
  }
  function setVol(v, commit) {
    var next = Math.round(Math.min(1, Math.max(0, Number(v))) * 100) / 100;
    soundVol = next;
    volInput.value = String(next);
    volPct.textContent = Math.round(next * 100) + '%';
    try { if (pressAudio) pressAudio.volume = next; if (releaseAudio) releaseAudio.volume = next; } catch (err) {}
    if (commit) saveCfg(); // 拖动中只改本地音量，松手才持久化（避免高频存储写入）
  }
  function setSoundSet(v) {
    soundSet = v === 'fx1' ? 'fx1' : 'duck';
    soundSelect.value = soundSet;
    applySoundSet();
    saveCfg();
  }
  function setSoundOn(v) {
    soundOn = !!v;
    soundToggle.checked = soundOn;
    saveCfg();
  }
  function setUsageMode(v) {
    usageMode = v === 'token' ? 'token' : 'ledger';
    usageSelect.value = usageMode;
    saveCfg();
    refresh(false); // 宿主在 usageMode 变化时已清缓存，会重算今日已用
  }
  function setPeakMode(v) {
    peakMode = (v === 'liangwen' || v === 'qiangqiang') ? v : 'default';
    peakSelect.value = peakMode;
    saveCfg();
  }
  function setBubbleOn(v) {
    bubbleOn = !!v;
    bubbleToggle.checked = bubbleOn;
    saveCfg();
    if (!bubbleOn) hideBubble();
  }
  function setTimeBubbleOn(v) {
    timeBubbleOn = !!v;
    timeToggle.checked = timeBubbleOn;
    saveCfg();
    if (bubbleShown && !bubbleRandomActive) labelEl.textContent = timeBubbleOn ? timeLabel() : 'DeepSeek 余额';
  }
  function setPeakRemindOn(v) {
    peakRemindOn = !!v;
    remindToggle.checked = peakRemindOn;
    saveCfg();
    if (!peakRemindOn && bubbleRemindActive) hideBubble();
  }
  function setDragLock(v) {
    dragLock = !!v;
    lockToggle.checked = dragLock;
    saveCfg();
  }
  // 请求宿主唤出 uTools 主窗（设置页）
  function openSettings() {
    try { whaleApi.openSettings(); } catch (err) { logErr('[whale][page] 打开设置失败', err && err.message); }
  }
  function applyConfig(cfg) {
    if (!cfg || typeof cfg !== 'object') return;
    if (typeof cfg.scale === 'number' && isFinite(cfg.scale)) {
      curScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, cfg.scale));
      scaleInput.value = String(curScale);
      scaleNumber.value = String(scaleToDisplay(curScale));
    }
    if (typeof cfg.vol === 'number' && isFinite(cfg.vol)) {
      soundVol = Math.min(1, Math.max(0, cfg.vol));
      volInput.value = String(soundVol);
      volPct.textContent = Math.round(soundVol * 100) + '%';
    }
    if (typeof cfg.soundOn === 'boolean') {
      soundOn = cfg.soundOn;
      soundToggle.checked = soundOn;
    }
    if (typeof cfg.soundSet === 'string') {
      var nextSet = cfg.soundSet === 'fx1' ? 'fx1' : 'duck';
      if (nextSet !== soundSet) { soundSet = nextSet; applySoundSet(); }
      soundSelect.value = soundSet;
    }
    if (typeof cfg.usageMode === 'string') {
      usageMode = cfg.usageMode === 'token' ? 'token' : 'ledger';
      usageSelect.value = usageMode;
    }
    if (typeof cfg.peakMode === 'string') {
      peakMode = (cfg.peakMode === 'liangwen' || cfg.peakMode === 'qiangqiang') ? cfg.peakMode : 'default';
      peakSelect.value = peakMode;
    }
    if (typeof cfg.bubbleOn === 'boolean') {
      bubbleOn = cfg.bubbleOn;
      bubbleToggle.checked = bubbleOn;
      if (!bubbleOn) hideBubble();
    }
    if (typeof cfg.menuBtn === 'boolean') {
      menuBtnEnabled = cfg.menuBtn;
      menuBtn.classList.toggle('dshwv-menu-btn-off', !menuBtnEnabled);
      if (!menuBtnEnabled) {
        if (hideBtnTimer) { clearTimeout(hideBtnTimer); hideBtnTimer = null; }
        menuBtn.classList.remove('dshwv-menu-btn-visible');
        if (menuOpen) closeMenu();
      }
    }
    if (typeof cfg.lowAlertOn === 'boolean') lowAlertOn = cfg.lowAlertOn;
    if (typeof cfg.lowAlertAmount === 'number' && isFinite(cfg.lowAlertAmount)) lowAlertAmount = Math.max(0, cfg.lowAlertAmount);
    applyLowAlert();
    if (typeof cfg.timeBubbleOn === 'boolean') {
      timeBubbleOn = cfg.timeBubbleOn;
      timeToggle.checked = timeBubbleOn;
      // 气泡正显示且未切随机台词时，即时更新首行报时文案
      if (bubbleShown && !bubbleRandomActive) labelEl.textContent = timeBubbleOn ? timeLabel() : 'DeepSeek 余额';
    }
    if (typeof cfg.peakRemindOn === 'boolean') {
      peakRemindOn = cfg.peakRemindOn;
      remindToggle.checked = peakRemindOn;
      if (!peakRemindOn && bubbleRemindActive) hideBubble();
    }
    if (typeof cfg.dragLock === 'boolean') {
      dragLock = cfg.dragLock;
      lockToggle.checked = dragLock;
    }
    if (typeof cfg.timerNotifyOn === 'boolean') {
      timerNotifyOn = cfg.timerNotifyOn;
      notifyToggle.checked = timerNotifyOn;
    }
    if (typeof cfg.timerPersistOn === 'boolean') {
      timerPersistOn = cfg.timerPersistOn;
      persistToggle.checked = timerPersistOn;
    }
    // 计时偏好：运行中的状态以 timer 状态为准，这里只在空闲时套用
    if (typeof cfg.timerMin === 'number' && isFinite(cfg.timerMin)) {
      timerNum.value = String(Math.min(TIMER_MAX_MIN, Math.max(1, Math.round(cfg.timerMin))));
    }
    if (typeof cfg.timerAt === 'string' && /^\d{1,2}:\d{2}$/.test(cfg.timerAt)) timerTime.value = cfg.timerAt;
    if (typeof cfg.timerRemindSec === 'number' && isFinite(cfg.timerRemindSec)) {
      var sec = Math.round(cfg.timerRemindSec);
      timerRemindSec = (sec === 0 || sec === 5 || sec === 8 || sec === 15) ? sec : 8;
      remindSelect.value = String(timerRemindSec);
    }
    if (typeof cfg.timerBubblePin === 'boolean') {
      timerBubblePin = cfg.timerBubblePin;
      pinToggle.checked = timerBubblePin;
    }
    if (typeof cfg.timerBubbleOnly === 'boolean') {
      timerBubbleOnly = cfg.timerBubbleOnly;
      onlyToggle.checked = timerBubbleOnly;
    }
    if (!timerActive() && (cfg.timerMode === 'off' || cfg.timerMode === 'up' || cfg.timerMode === 'down' || cfg.timerMode === 'at')) {
      timerMode = cfg.timerMode;
    }
    syncTimerMenu();
    try { if (pressAudio) pressAudio.volume = soundVol; if (releaseAudio) releaseAudio.volume = soundVol; } catch (err) {}
  }

  // —— 音效 ——
  var SQUISH = 'scaleY(0.88) scaleX(1.05)';
  var pressAudio = null, releaseAudio = null;
  var pressing = false, pressEnded = false, releasePlayed = false, releaseTimer = null;
  function applySoundSet() {
    try {
      var f = SOUND_FILES[soundSet] || SOUND_FILES.duck;
      pressAudio = new Audio(f.press);
      pressAudio.preload = 'auto';
      pressAudio.volume = soundVol;
      releaseAudio = new Audio(f.release);
      releaseAudio.preload = 'auto';
      releaseAudio.volume = soundVol;
    } catch (err) { logErr('[whale][page] 初始化音效失败', err && err.message); }
  }
  function playPress() {
    if (!pressAudio || !soundOn) return;
    try {
      if (releaseTimer) { clearTimeout(releaseTimer); releaseTimer = null; }
      if (releaseAudio) { releaseAudio.pause(); releaseAudio.currentTime = 0; }
      pressEnded = false;
      releasePlayed = false;
      pressAudio.onended = function () {
        pressEnded = true;
        if (!pressing && !releasePlayed) playRelease(); // click fallback：Ya1 播完接 Ya2
      };
      pressAudio.currentTime = 0;
      var p = pressAudio.play();
      if (p && typeof p.catch === 'function') p.catch(function () {});
    } catch (err) {}
  }
  function playRelease() {
    if (releasePlayed || !releaseAudio || !soundOn) return;
    releasePlayed = true;
    try {
      releaseAudio.currentTime = 0;
      var p = releaseAudio.play();
      if (p && typeof p.catch === 'function') p.catch(function () {});
    } catch (err) {}
  }
  function pressDown() {
    body.style.transform = SQUISH;
    pressing = true;
    playPress();
  }
  function pressUp() {
    body.style.transform = 'scaleY(1) scaleX(1)';
    pressing = false;
    if (pressEnded) { playRelease(); return; }
    var durKnown = false, remainMs = 0;
    try {
      var dur = pressAudio ? pressAudio.duration : 0;
      if (isFinite(dur) && dur > 0) {
        durKnown = true;
        remainMs = (dur - pressAudio.currentTime) * 1000;
      }
    } catch (err) {}
    if (durKnown) {
      // click：Ya1 最后 100ms 提前接 Ya2
      releaseTimer = setTimeout(function () { releaseTimer = null; playRelease(); }, Math.max(0, remainMs - 100));
    }
  }

  // —— 菜单 ——
  function toggleMenu() {
    menuOpen = !menuOpen;
    if (menuOpen) { positionMenu(); dshSend('status'); }
    menuBox.classList.toggle('dshwv-menu-open', menuOpen);
    if (menuOpen) menuBtn.classList.add('dshwv-menu-btn-visible');
  }
  function closeMenu() {
    menuOpen = false;
    menuBox.classList.remove('dshwv-menu-open');
  }
  function positionMenu() {
    try {
      var b = menuBtn.getBoundingClientRect();
      var vw = window.innerWidth || document.documentElement.clientWidth || 300;
      var vh = window.innerHeight || document.documentElement.clientHeight || 300;
      // 菜单按钮被隐藏（display:none）时，rect 全 0；改用鲸鱼图片位置定位
      if (!menuBtnEnabled || b.width <= 0) {
        var wb = img.getBoundingClientRect();
        b = { left: wb.right - 30, top: wb.top + 4, right: wb.right, bottom: wb.top + 30, width: 26, height: 26 };
      }
      // 用按钮的「视觉」中心判断左右（根元素左吸附时整体 scaleX(-1) 镜像，
      // getBoundingClientRect 已反映镜像后的实际位置，不能再用根布局中心判断）
      var btnCx = b.left + b.width / 2;
      var onLeft = btnCx < vw / 2;
      // 菜单在按钮上方展开，锚定按钮同侧下角
      if (onLeft) {
        menuBox.style.left = Math.max(4, b.left) + 'px';
        menuBox.style.right = 'auto';
        menuBox.style.transformOrigin = 'bottom left';
      } else {
        menuBox.style.right = Math.max(4, (vw - b.right)) + 'px';
        menuBox.style.left = 'auto';
        menuBox.style.transformOrigin = 'bottom right';
      }
      // 菜单始终在按钮上方展开：底边贴按钮上沿，可用高度不足时压缩高度并在菜单内滚动，
      // 避免（原逻辑）把菜单向下压到挂件上遮住小鲸鱼
      menuBox.style.bottom = Math.max(0, vh - b.top) + 'px';
      menuBox.style.top = 'auto';
      menuBox.style.maxHeight = Math.max(120, b.top - 8) + 'px';
    } catch (err) {}
  }

  // —— 像素命中测试（透明区域不响应/可穿透） ——
  var hitCanvas = null, hitReady = false;
  function setupHitTest() {
    try {
      hitCanvas = document.createElement('canvas');
      hitCanvas.width = 610;
      hitCanvas.height = 610;
      var probe = new Image();
      probe.onload = function () {
        try {
          hitCanvas.getContext('2d').drawImage(probe, 0, 0, 610, 610);
          hitReady = true;
        } catch (err) { logErr('[whale][page] 命中测试画布绘制失败', err && err.message); }
      };
      probe.onerror = function () { logErr('[whale][page] 命中测试图片加载失败', IMG_URL); };
      probe.src = IMG_URL;
    } catch (err) {}
  }
  function isWhaleHit(e) {
    if (!hitCanvas || !hitReady) return true;
    try {
      var r = img.getBoundingClientRect();
      if (!r || r.width <= 0 || r.height <= 0) return false;
      var lx = (e.clientX - r.left) / r.width * 610;
      var ly = (e.clientY - r.top) / r.height * 610;
      if (lx < 0 || ly < 0 || lx >= 610 || ly >= 610) return false;
      if (flipped) lx = 610 - lx;
      var data = hitCanvas.getContext('2d').getImageData(Math.floor(lx), Math.floor(ly), 1, 1).data;
      return data[3] > 10;
    } catch (err) {
      return true;
    }
  }

  // —— 点击穿透 / 光标 ——
  var widgetCursor = '';
  function setWidgetCursor(v) {
    if (v !== widgetCursor) {
      widgetCursor = v;
      try { document.body.style.cursor = v; } catch (err) {}
    }
  }
  // 菜单按钮命中：用屏幕坐标几何判定，按钮四周留过桥边距，
  // 保证从鲸鱼移向按钮经过透明间隙时按钮不消失、窗口不穿透
  function isOverMenuBtn(e) {
    if (!menuBtnEnabled) return false;
    try {
      var r = menuBtn.getBoundingClientRect();
      if (!r || r.width <= 0) return false;
      var m = 26; // 过桥边距
      return e.clientX >= r.left - m && e.clientX <= r.right + m &&
             e.clientY >= r.top - m && e.clientY <= r.bottom + m;
    } catch (err) { return false; }
  }

  // 根据指针位置决定窗口是否穿透：鲸鱼/打开的气泡/菜单/菜单按钮 → 不穿透；其余透明区 → 穿透
  function updateHover(e) {
    if (!e) return;
    var overUI = false;
    var el = null;
    try { el = document.elementFromPoint(e.clientX, e.clientY); } catch (err) {}
    if (el && el.closest) {
      if (el.closest('.dshwv-menu.dshwv-menu-open')) overUI = true;
      else if (el.closest('.dshwv-bubble.dshwv-bubble-open')) overUI = true;
    }
    var overBtn = isOverMenuBtn(e);
    var overWhale = isWhaleHit(e);
    if (!overUI) overUI = overBtn || overWhale || menuOpen;
    whaleApi.setIgnoreMouse(!overUI);
    setWidgetCursor((drag && drag.active) ? 'grabbing' : (overUI && !dragLock ? 'grab' : ''));
    // 按钮可见性：在鲸鱼/按钮区/菜单打开时常显；离开后延迟一小段再隐藏（越过透明间隙）
    var wantBtn = menuBtnEnabled && (overWhale || overBtn || menuOpen);
    if (wantBtn) {
      if (hideBtnTimer) { clearTimeout(hideBtnTimer); hideBtnTimer = null; }
      menuBtn.classList.add('dshwv-menu-btn-visible');
    } else if (!hideBtnTimer) {
      hideBtnTimer = setTimeout(function () {
        hideBtnTimer = null;
        menuBtn.classList.remove('dshwv-menu-btn-visible');
      }, 350);
    }
  }

  // —— 拖拽 / 按压 / 点击 ——
  function onDocPointerDown(e) {
    if (e.target && e.target.closest) {
      if (e.target.closest('.dshwv-bubble') || e.target.closest('.dshwv-menu') || e.target.closest('.dshwv-menu-btn')) return;
    }
    if (menuOpen) { closeMenu(); return; }
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    if (!isWhaleHit(e)) return;
    try { e.preventDefault(); e.stopPropagation(); } catch (err) {}
    // 目标窗口左上角 = 屏幕指针坐标 - 指针在窗内的客户区坐标（拖拽过程恒定）
    drag = { active: true, sSX: e.screenX, sSY: e.screenY, cx0: e.clientX, cy0: e.clientY, moved: false, raf: 0, tx: 0, ty: 0 };
    whaleApi.setIgnoreMouse(false);
    pressDown();
    // pointermove 为常驻监听（同一处理器浏览器自动去重），这里只补 up/cancel
    document.addEventListener('pointerup', onDocPointerUp, true);
    document.addEventListener('pointercancel', onDocPointerCancel, true);
  }
  function onDocPointerMove(e) {
    // 锁定位置时不移动窗口，也不累计位移：松手仍按「点击」处理（刷新气泡）
    if (drag && drag.active && !dragLock) {
      var dx = e.screenX - drag.sSX;
      var dy = e.screenY - drag.sSY;
      if (dx * dx + dy * dy >= CLICK_SQ) drag.moved = true;
      if (drag.moved) {
        drag.tx = e.screenX - drag.cx0;
        drag.ty = e.screenY - drag.cy0;
        if (!drag.raf) {
          drag.raf = requestAnimationFrame(function () {
            drag.raf = 0;
            if (drag && drag.active) whaleApi.dragMove(drag.tx, drag.ty);
          });
        }
      }
    }
    updateHover(e);
  }
  function onDocPointerUp(e) {
    try { if (isWhaleHit(e)) { e.preventDefault(); e.stopPropagation(); } } catch (err) {}
    endDrag(e, true);
  }
  function onDocPointerCancel(e) { endDrag(e, false); }
  function endDrag(e, clickAllowed) {
    if (!drag || !drag.active) return;
    drag.active = false;
    if (drag.raf) { cancelAnimationFrame(drag.raf); drag.raf = 0; }
    document.removeEventListener('pointerup', onDocPointerUp, true);
    document.removeEventListener('pointercancel', onDocPointerCancel, true);
    pressUp();
    var wasClick = clickAllowed && !drag.moved;
    drag = null;
    if (wasClick) {
      showBubble(true); // 用户点击：计时气泡即使不常驻也要弹出来
      refresh(true);
    } else {
      // 宿主吸附后回推 whale:snapped → 镜像翻转
      whaleApi.dragEnd();
    }
    updateHover(e);
  }
  function onDocClickStopper(e) {
    if (!isWhaleHit(e)) return;
    try { e.preventDefault(); e.stopPropagation(); } catch (err) {}
  }
  document.addEventListener('pointerdown', onDocPointerDown, true);
  document.addEventListener('pointermove', onDocPointerMove, true);
  document.addEventListener('click', onDocClickStopper, true);
  // 右键鲸鱼打开菜单：即使隐藏了右上角菜单按钮，也能通过右键唤出设置菜单
  document.addEventListener('contextmenu', function (e) {
    if (e.target && e.target.closest) {
      if (e.target.closest('.dshwv-menu') || e.target.closest('.dshwv-menu-btn')) return;
    }
    if (!isWhaleHit(e)) return;
    try { e.preventDefault(); e.stopPropagation(); } catch (err) {}
    toggleMenu();
  }, true);

  // 滚轮缩放：指针在鲸鱼上时滚动调整大小（滚动中实时预览，停手 260ms 后持久化）
  // 锁定位置时禁用缩放（锁定 = 位置与大小都固定），仅保留点击刷新
  var wheelCommitTimer = null;
  document.addEventListener('wheel', function (e) {
    if (dragLock) return;
    if (e.target && e.target.closest && e.target.closest('.dshwv-menu')) return; // 菜单内滚动不缩放
    if (!isWhaleHit(e)) return;
    try { e.preventDefault(); } catch (err) {}
    var target = Math.min(MAX_SCALE, Math.max(MIN_SCALE, curScale + (e.deltaY < 0 ? 0.1 : -0.1)));
    target = Math.round(target * 10) / 10;
    if (target === curScale) return;
    setScale(target, false);
    if (wheelCommitTimer) clearTimeout(wheelCommitTimer);
    wheelCommitTimer = setTimeout(function () {
      wheelCommitTimer = null;
      setScale(curScale, true);
    }, 260);
  }, { passive: false });

  // —— 宿主消息 ——
  // 60s 轮询：窗口隐藏（win.hide / 最小化 / 切走虚拟桌面）时暂停，重新可见时立即刷新再恢复，
  // 避免挂件在后台空跑网络请求。
  var pollTimer = null;
  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(function () { refresh(false); }, REFRESH_MS);
  }
  function stopPolling() {
    if (!pollTimer) return;
    clearInterval(pollTimer);
    pollTimer = null;
  }
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { stopPolling(); return; }
    timerStep(); // 后台被节流时可能错过到点，恢复可见立即补一次
    refresh(false);
    startPolling();
  });

  whaleApi.onInit(function (data) {
    if (!data) return;
    applyConfig(data.config);
    if (data.anchor) {
      flipped = !!data.anchor.flipped;
      root.classList.toggle('dshwv-left', flipped);
    }
    if (data.balance) handleBalance(data.balance, false);
    restoreTimer(data.timer); // 「计时保存」开启时恢复上次的计时状态
    if (!document.hidden) startPolling();
  });
  whaleApi.onBalance(function (data) {
    handleBalance(data, pendingManual);
    pendingManual = false;
  });
  whaleApi.onConfig(function (cfg) { applyConfig(cfg); });
  whaleApi.onSnapped(function (data) {
    flipped = !!(data && data.flipped);
    root.classList.toggle('dshwv-left', flipped);
  });

  // —— 启动 ——
  render();
  applySoundSet();
  syncTimerMenu();
  setupHitTest();
  whaleApi.setIgnoreMouse(true); // 初始全穿透，悬停鲸鱼时自动取消
  dshSend('status');             // 先取一次 dsh 状态，菜单里的状态行/按钮一开始就是对的
  whaleApi.ready();
})();
