(function () {
  'use strict';
  if (window.__dshWhaleWidget) return;
  window.__dshWhaleWidget = true;

  // —— 常量 ——
  var MIN_SCALE = 0.6, MAX_SCALE = 2.5, CLICK_SQ = 9;
  var REFRESH_MS = 60000, CHANGE_MS = 900, ANIM_MS = 700, BUBBLE_MS = 5000, BUBBLE_REMIND_MS = 8000;
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
    dragMove: function () {}, dragEnd: function () {}, setIgnoreMouse: function () {},
    openSettings: function () {},
  };
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
  function menuLabel(text) { var s = document.createElement('span'); s.textContent = text; return s; }
  function menuRow() { var r = document.createElement('div'); r.className = 'dshwv-menu-row'; return r; }

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
  menuBox.appendChild(row1); menuBox.appendChild(row2); menuBox.appendChild(row3);
  menuBox.appendChild(row4); menuBox.appendChild(row5); menuBox.appendChild(row6);
  menuBox.appendChild(rowRemind);
  menuBox.appendChild(row7); menuBox.appendChild(row8); menuBox.appendChild(row9);

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
    if (bubbleRandomActive) {
      hideBubble(); // 再次点击：关闭
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
  var BUBBLE_STYLE_CLASS = { A: 'dshwv-label', B: 'dshwv-amount', P: 'dshwv-period', C: 'dshwv-hint' };

  var soundOn = true, soundVol = 0.9, soundSet = 'duck';
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

  // —— 气泡内容 ——
  var bubbleSwapTimer = null, hintFadeTimer = null, gifFadeTimer = null, lastHintText = null;
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
  function showBubble() {
    if (!bubbleOn) return;
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
  // 峰/谷时段切换提醒：独立于随机台词，停留更久（内容多一行时段表）
  function showPeakRemind(isPeak) {
    if (!bubbleOn) return;
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
    if (bubbleRemindActive && bubbleRemindLines) {
      applyBubbleLines(bubbleRemindLines);
    } else if (bubbleRandomActive && bubbleRandomLines) {
      applyBubbleLines(bubbleRandomLines);
    } else {
      setHint(hint);
      applyLowAlert();
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
    if (menuOpen) positionMenu();
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
      // 菜单在按钮上方展开；行数增多后可能顶出视口，夹住底部值保证不溢出
      var mh = menuBox.offsetHeight || 0;
      var bottom = vh - b.top;
      if (mh > 0 && bottom + mh > vh - 4) bottom = Math.max(4, vh - 4 - mh);
      menuBox.style.bottom = bottom + 'px';
      menuBox.style.top = 'auto';
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
      showBubble();
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
  setupHitTest();
  whaleApi.setIgnoreMouse(true); // 初始全穿透，悬停鲸鱼时自动取消
  whaleApi.ready();
})();
