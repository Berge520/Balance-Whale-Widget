(function () {
  'use strict';
  if (window.__dshWhaleWidget) return;
  window.__dshWhaleWidget = true;

  // —— 常量 ——
  var MIN_SCALE = 0.6, MAX_SCALE = 2.5, CLICK_SQ = 9;
  var REFRESH_MS = 60000, CHANGE_MS = 900, ANIM_MS = 700, BUBBLE_MS = 5000;
  // 提醒气泡（峰谷/预算/低余额/穿透说明）停留秒数，由设置页下发；0 = 常驻，手动点掉
  var remindSec = 8;
  var TIMER_PEEK_MS = 2000; // 「只显计时」关闭时，点小鲸鱼先显示计时的时长（随后切回常规内容）
  var TIMER_MAX_SEC = 86399; // 倒计时上限 23:59:59
  var TIMER_MIN_DEFAULT = 25; // 三段全填 0 时的兜底分钟数（避免「填了 0 就开不了」）
  var TIMER_AT_DEFAULT = '07:30'; // 定时刻默认值（与宿主 store.js 的 defaultConfig 同值）
  var TIMER_BREAK_DEFAULT = 5;    // 到点后「休息 N 分钟」的默认档位
  var TIMER_NOTE_MAX = 60;        // 到点留言长度上限（与菜单输入框 maxLength、宿主清洗同值）
  // 内置挂件形象（相对插件根目录；用哪张由设置页的 skin 值决定）。
  // 键 = public/whale/ 下的图片文件名，加形象时这里加一行、设置页「形象」下拉加一个 option；
  // 宿主 store.js 的 normSkin 另有一份同值的合法值清单，三处要一起改。
  // 统一用 WebP（有损 q90，带 alpha）：这 13 张原为 PNG 共 10.8MB，占插件包体积的 94%，
  // 转 WebP 后约 1.0MB（形象 id 不含扩展名，故三处副本不受影响）。
  // 用户导入的自定义形象仍是 PNG（见 lib/skins.js），走 data URL，与本表无关。
  var BUILTIN_SKINS = {
    liuy: './whale/liuy.webp',
    black: './whale/black.webp',
    ciya: './whale/ciya.webp',
    DSniang1: './whale/DSniang1.webp',
    DSniang02: './whale/DSniang02.webp',
    DSniang3: './whale/DSniang3.webp',
    DSniang4: './whale/DSniang4.webp',
    DSniang5: './whale/DSniang5.webp',
    DSniang6: './whale/DSniang6.webp',
    DSniang7: './whale/DSniang7.webp',
    glby: './whale/glby.webp',
    Jian: './whale/Jian.webp',
    '无稽之谈改': './whale/无稽之谈改.webp',
  };
  var DEFAULT_SKIN = 'DSniang1'; // 默认形象，也是配置里非法值 / v1.5.0 老值 'whale' 的落点
  var BUILTIN_SKIN_IDS = Object.keys(BUILTIN_SKINS);
  var IMG_URL = BUILTIN_SKINS[DEFAULT_SKIN];
  var GIF_URL = './whale/rua.gif';
  // 气泡配色预设：floating.css 里气泡颜色全部走 CSS 变量，换主题只重写变量、不重建 DOM。
  // 「低余额」的红色是状态色，不随主题变（见 .dshwv-low）
  var THEMES = {
    default: { text: '#536ba9', hint: '#9fb0d9', fill: '#FFFFFF', stroke: '#203170' },
    dark:    { text: '#dbe4ff', hint: '#94a3c8', fill: '#1f2437', stroke: '#8fa3e0' },
    sakura:  { text: '#a3486f', hint: '#c98aa8', fill: '#FFF3F8', stroke: '#d9789f' },
  };
  var SOUND_FILES = {
    duck: { press: './whale/Ya1.mp3', release: './whale/Ya2.mp3' },
    fx1:  { press: './whale/D1.mp3',  release: './whale/D2.mp3' },
  };

  // 宿主桥接（preload/floating.js 注入）；缺省空实现，单独打开页面也不报错
  var whaleApi = window.whale || {
    onInit: function () {}, onBalance: function () {}, onConfig: function () {}, onSnapped: function () {},
    onSounds: function () {}, onSkin: function () {}, onBubbles: function () {}, onModels: function () {},
    ready: function () {}, refresh: function () {}, saveConfig: function () {},
    saveTimer: function () {}, notifyTimerDone: function () {},
    dragMove: function () {}, dragEnd: function () {}, setIgnoreMouse: function () {}, setInputFocus: function () {},
    openSettings: function () {}, dsh: function () {}, onDsh: function () {},
    refreshModels: function () {}, setMainModel: function () {}, hideWidget: function () {},
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
  menuBtn.setAttribute('aria-haspopup', 'true');
  menuBtn.setAttribute('aria-expanded', 'false');
  menuBtn.setAttribute('aria-label', '菜单');
  menuBtn.innerHTML = '<span></span><span></span><span></span>';
  menuBtn.addEventListener('click', function (e) { e.stopPropagation(); toggleMenu(); });

  var menuBox = document.createElement('div');
  menuBox.className = 'dshwv-menu';
  // 面板是「对话框」而不是 menu/menuitem：里面是开关、下拉、滑块，套 menuitem 语义反而读不出来
  menuBox.setAttribute('role', 'dialog');
  menuBox.setAttribute('aria-label', '挂件菜单');
  function menuLabel(text) { var s = document.createElement('span'); s.className = 'dshwv-menu-label'; s.textContent = text; return s; }
  function menuRow() { var r = document.createElement('div'); r.className = 'dshwv-menu-row'; return r; }

  // 菜单分组的展开状态（key → 布尔）：随 config.menuGroups 落盘，重开挂件后保持上次的组合。
  // 默认只展开 models（切模型最高频）；其余组收起，菜单一打开就是一屏以内
  var menuGroups = { look: false, models: true, usage: false, timer: false, timerAdv: false, dsh: false };
  // 展开组合的「版本」：改了某组默认展开态就 +1，用来把老配置里存过的旧默认值迁移掉（见 onInit）
  var MENU_GROUPS_REV = 2;
  var menuGroupEls = {};

  // 菜单分组：点标题折叠/展开。只默认展开常用组，避免菜单过长
  // key：落盘标识；onExpand：展开时的回调（dsh 组用它按需拉状态：收着时状态行看不见，不必白探一次 3080）
  function menuGroup(key, title, defaultOpen, onExpand) {
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
    var open = typeof menuGroups[key] === 'boolean' ? menuGroups[key] : !!defaultOpen;
    function apply() {
      box.classList.toggle('dshwv-group-open', open);
      bodyEl.style.display = open ? '' : 'none';
      arrow.textContent = open ? '▾' : '▸';
      head.setAttribute('aria-expanded', open ? 'true' : 'false');
    }
    head.addEventListener('click', function (e) {
      e.stopPropagation();
      open = !open;
      menuGroups[key] = open;
      apply();
      saveCfg(); // 记住展开组合：下次开菜单不用重新点开常用组
      if (open && typeof onExpand === 'function') { try { onExpand() } catch (err) {} }
      positionMenu(); // 高度变化后重新夹取，保证菜单始终在按钮上方
    });
    apply();
    var api = {
      el: box,
      body: bodyEl,
      // 配置回推（设置页 / 别的窗口改过）时同步展开态；不走 saveCfg，否则自己回写自己
      setOpen: function (v) { open = !!v; apply(); },
    };
    menuGroupEls[key] = api;
    return api;
  }

  // 大小档位 1–15 线性映射到 MIN_SCALE–MAX_SCALE（原为 1–20，档位 20 即 2.5 倍太大，
  // 收到 15 后最大约 2.1 倍）。档位数改动必须同步三处：scaleNumber.max、
  // numberToScale 的钳制值、scaleToDisplay 的分母，以及设置页 App.vue 的同名三处。
  var SCALE_STEPS = 15;

  var scaleInput = document.createElement('input');
  scaleInput.type = 'range';
  scaleInput.min = String(MIN_SCALE); scaleInput.max = String(MAX_SCALE); scaleInput.step = '0.1';
  scaleInput.className = 'dshwv-range'; scaleInput.value = '1.3';
  var scaleNumber = document.createElement('input');
  scaleNumber.type = 'number';
  scaleNumber.min = '1'; scaleNumber.max = String(SCALE_STEPS); scaleNumber.step = '1';
  scaleNumber.className = 'dshwv-number'; scaleNumber.value = '6';
  scaleInput.addEventListener('input', function () { setScale(scaleInput.value, false); });
  scaleInput.addEventListener('change', function () { setScale(scaleInput.value, true); });
  function numberToScale() {
    var v = Math.round(Number(scaleNumber.value));
    return MIN_SCALE + Math.max(0, Math.min(SCALE_STEPS, v) - 1) * (MAX_SCALE - MIN_SCALE) / (SCALE_STEPS - 1);
  }
  scaleNumber.addEventListener('input', function () { setScale(numberToScale(), false); });
  scaleNumber.addEventListener('change', function () { setScale(numberToScale(), true); });

  function soundOpt(value, label) { var o = document.createElement('option'); o.value = value; o.textContent = label; return o; }
  var soundSelect = document.createElement('select');
  soundSelect.className = 'dshwv-sound';
  soundSelect.appendChild(soundOpt('duck', '小黄鸭'));
  soundSelect.appendChild(soundOpt('fx1', '音效1'));
  soundSelect.appendChild(soundOpt('custom', '自定义'));
  soundSelect.addEventListener('change', function () { setSoundSet(soundSelect.value); });

  var OPACITY_PRESETS = [100, 80, 60, 40, 20];
  var opacitySelect = document.createElement('select');
  opacitySelect.className = 'dshwv-sound';
  OPACITY_PRESETS.forEach(function (p) {
    var o = document.createElement('option');
    o.value = String(p);
    o.textContent = p + '%';
    opacitySelect.appendChild(o);
  });
  opacitySelect.addEventListener('change', function () { setOpacityPreset(opacitySelect.value); });

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

  // 倒计时目标：时 / 分 / 秒 三段（上限 23:59:59）。
  // 三段互不钳制 —— 50 分、80 秒都允许输入，startTimer 里统一折算成秒数，避免「填 90 分要自己换成 1 时 30 分」
  // 菜单输入统一「回车才生效」：change 事件是随输入/失焦触发的，边打字边存配置
  // 会让数字框打一半（如「2」→「25」）就被钳制回填，光标位置也跟着跳。
  // 改为显式提交：回车提交并失焦回显，blur 也提交一次（点到菜单别处不该丢掉这次编辑）。
  function commitOnEnter(el, commit) {
    el.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      commit();
      try { el.blur(); } catch (err) {}
    });
    el.addEventListener('blur', function () { commit(); });
  }

  function timerSegInput(max, title) {
    var el = document.createElement('input');
    el.type = 'number';
    el.min = '0'; el.max = String(max); el.step = '1';
    el.className = 'dshwv-number dshwv-timer-seg';
    el.title = title;
    commitOnEnter(el, function () { saveCfg(); });
    return el;
  }
  var timerHour = timerSegInput(23, '倒计时小时数（0–23，与分、秒合计后生效，回车生效）');
  var timerMin = timerSegInput(59, '倒计时分钟数（0–59，与时、秒合计后生效，回车生效）');
  var timerSec = timerSegInput(59, '倒计时秒数（0–59，与时、分合计后生效，回车生效）');
  timerHour.value = '0'; timerMin.value = '25'; timerSec.value = '0';
  // 时分秒之间的单位提示（原生 number 输入框没有可见 label，靠它标明哪一格是什么）
  function timerUnit(text) {
    var s = document.createElement('span');
    s.className = 'dshwv-timer-unit';
    s.textContent = text;
    return s;
  }
  // 三段各自的单位提示：syncTimerMenu 要跟输入框成对显隐，按 [时, 分, 秒] 记一份
  var timerSegUnits = [timerUnit('时'), timerUnit('分'), timerUnit('秒')];

  var timerTime = document.createElement('input');
  timerTime.type = 'time';
  timerTime.className = 'dshwv-number dshwv-timer-time';
  timerTime.value = TIMER_AT_DEFAULT;
  timerTime.title = '定时刻（HH:MM，已过点则顺延到明天，回车生效）';
  commitOnEnter(timerTime, function () { saveCfg(); });

  // 计时留言：开始前写一句话，到点后在气泡与系统通知里显示（「接下来要做什么」）
  var timerNoteEl = document.createElement('input');
  timerNoteEl.type = 'text';
  timerNoteEl.className = 'dshwv-timer-note';
  timerNoteEl.maxLength = TIMER_NOTE_MAX;
  timerNoteEl.placeholder = '到点提醒我…（回车生效，可留空）';
  timerNoteEl.title = '计时到点后要做什么：这里写的一句会显示在到点气泡与系统通知里（最多 ' + TIMER_NOTE_MAX + ' 字，回车生效）';
  // 留言框是 textarea 式自由输入，回车提交而不是换行，故要拦默认行为（见 commitOnEnter）
  commitOnEnter(timerNoteEl, function () { setTimerNote(timerNoteEl.value); });

  // 到点后的动作档：休息 N 分钟（0 = 不提供「休息」按钮）
  var timerBreak = document.createElement('input');
  timerBreak.type = 'number';
  timerBreak.min = '0'; timerBreak.max = '120'; timerBreak.step = '5';
  timerBreak.className = 'dshwv-number dshwv-timer-break';
  timerBreak.value = String(TIMER_BREAK_DEFAULT);
  timerBreak.title = '到点后「休息」按钮的分钟数（0 = 不显示该按钮，回车生效）';
  commitOnEnter(timerBreak, function () { setTimerBreakMin(timerBreak.value); });

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

  // 菜单里的控件都没有可见 <label>（同行那个只是 span），补可访问名：
  // title 只在悬停时可见，辅助技术读的是 aria-label
  [
    [scaleInput, '大小（滑块）'], [scaleNumber, '大小（1–20）'],
    [soundToggle, '音效开关'], [soundSelect, '音色'], [volInput, '音量'],
    [opacitySelect, '透明度'], [usageSelect, '用量口径'], [peakSelect, '峰谷方案'],
    [bubbleToggle, '思考气泡'], [remindToggle, '峰谷提醒'], [remindSelect, '到点提醒停留时长'],
    [timeToggle, '气泡报时'], [lockToggle, '锁定位置'],
    [timerSelect, '计时模式'], [timerHour, '倒计时小时'], [timerMin, '倒计时分钟'], [timerSec, '倒计时秒'],
    [timerTime, '定时时刻'], [timerNoteEl, '到点提醒我'], [timerBreak, '到点后休息分钟'],
    [notifyToggle, '到点通知'], [persistToggle, '记住计时状态'],
    [pinToggle, '计时气泡常驻'], [onlyToggle, '计时中只显示计时'],
  ].forEach(function (pair) {
    pair[0].setAttribute('aria-label', pair[1]);
  });

  var row1 = menuRow();
  row1.appendChild(menuLabel('大小')); row1.appendChild(scaleInput); row1.appendChild(scaleNumber);
  var row2 = menuRow();
  row2.appendChild(menuLabel('音效')); row2.appendChild(soundToggle); row2.appendChild(soundSelect);
  var row3 = menuRow();
  row3.appendChild(menuLabel('音量')); row3.appendChild(volInput); row3.appendChild(volPct);
  var rowOpacity = menuRow();
  rowOpacity.appendChild(menuLabel('透明度')); rowOpacity.appendChild(opacitySelect);
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
  rowTimerArg.appendChild(menuLabel('目标'));
  rowTimerArg.appendChild(timerHour); rowTimerArg.appendChild(timerSegUnits[0]);
  rowTimerArg.appendChild(timerMin); rowTimerArg.appendChild(timerSegUnits[1]);
  rowTimerArg.appendChild(timerSec); rowTimerArg.appendChild(timerSegUnits[2]);
  rowTimerArg.appendChild(timerTime);
  rowTimerArg.appendChild(timerResetBtn);
  // 到点要做什么：留言一句（可留空）+ 「休息」按钮的分钟档，两者到点后都作用在提醒气泡与通知上
  var rowTimerNote = menuRow();
  rowTimerNote.appendChild(menuLabel('留言')); rowTimerNote.appendChild(timerNoteEl);
  var rowTimerBreak = menuRow();
  rowTimerBreak.appendChild(menuLabel('休息档')); rowTimerBreak.appendChild(timerBreak);
  rowTimerBreak.appendChild(timerUnit('分钟'));
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
  // 隐藏挂件：与设置页的「隐藏挂件」同一路径（宿主销毁悬浮窗），
  // 之后可用「显示挂件」设置按钮或切换挂件快捷键再次唤出
  var hideBtn = document.createElement('button');
  hideBtn.type = 'button';
  hideBtn.className = 'dshwv-menu-link dshwv-menu-link-2nd';
  hideBtn.textContent = '隐藏挂件';
  hideBtn.title = '隐藏挂件（设置页「显示挂件」或切换挂件快捷键可再次唤出）';
  // 二次确认：它在菜单最底部、旁边就是「打开设置」，误触一下挂件就没了（虽然能唤回，
  // 但用户未必知道路径）→ 首次点击只进确认态，3s 内再点一次才真隐藏
  var hideConfirmTimer = null;
  function resetHideBtn() {
    if (hideConfirmTimer) { clearTimeout(hideConfirmTimer); hideConfirmTimer = null; }
    hideBtn.classList.remove('dshwv-menu-link-warn');
    hideBtn.textContent = '隐藏挂件';
  }
  hideBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    if (!hideConfirmTimer) {
      hideBtn.classList.add('dshwv-menu-link-warn');
      hideBtn.textContent = '再点一次隐藏';
      hideConfirmTimer = setTimeout(resetHideBtn, 3000);
      return;
    }
    resetHideBtn();
    closeMenu();
    try { whaleApi.hideWidget(); } catch (err) {}
  });
  row9.appendChild(hideBtn);
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
  var dshStartBtn = dshBtn('启动', 'start', '启动 dsh Web UI（插件目录里还没有时会先自动下载安装）');
  var dshRestartBtn = dshBtn('重启', 'restart', '先结束再启动 dsh');
  var dshStopBtn = dshBtn('结束', 'stop', '结束 dsh 进程');
  var dshUpdateBtn = dshBtn('更新', 'update', '结束并按「dsh 版本」重新安装（自动＝latest），装完用新版启动');
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

  // 分组：常用组默认展开，其余折叠，菜单整体高度约减半。
  // look 组默认收起：里面 7 行控件（大小 / 音效 / 音量 / 透明度 / 气泡 / 报时 / 锁定）
  // 一次铺开会把菜单塞满，而打开菜单最高频的动作是切模型 —— 见下面 models 组
  var groupLook = menuGroup('look', '外观与音效', false);
  groupLook.body.appendChild(row1); groupLook.body.appendChild(row2); groupLook.body.appendChild(row3);
  groupLook.body.appendChild(rowOpacity);
  groupLook.body.appendChild(row6); groupLook.body.appendChild(row7); groupLook.body.appendChild(row8);
  var groupUsage = menuGroup('usage', '用量与峰谷', false);
  groupUsage.body.appendChild(row4); groupUsage.body.appendChild(row5);
  groupUsage.body.appendChild(rowRemind);
  var groupTimer = menuGroup('timer', '计时', false);
  groupTimer.body.appendChild(rowTimer); groupTimer.body.appendChild(rowTimerArg);
  groupTimer.body.appendChild(rowTimerNote); groupTimer.body.appendChild(rowTimerBreak);
  groupTimer.body.appendChild(rowNotify);
  // 三个次要行为开关（只显计时 / 气泡常驻 / 计时保存）再套一层折叠：
  // 计时组本身已有 8 行，展开后一屏装不下；这三个都是「设一次就不再动」的开关
  var groupTimerAdv = menuGroup('timerAdv', '更多（显隐与保存）', false);
  groupTimerAdv.body.appendChild(rowOnly);
  groupTimerAdv.body.appendChild(rowPin); groupTimerAdv.body.appendChild(rowPersist);
  groupTimer.body.appendChild(groupTimerAdv.el);
  // dsh 是面向开发者的功能，但打包版同样要有 —— 早先按 window.whale.dev 建组，
  // 结果正式安装的 .upx 里开发者模式默认关闭，这一节整个消失（连 DOM 都没有）。
  // 现在无条件建组，再用「这台机器上有没有 dsh」决定显隐：探测到已安装（source 非空）
  // 或正在运行（running / external）才显示，没装过 dsh 的普通用户依旧看不到这一节。
  // 初始先藏起来，等首帧探测结果回来再决定 —— 否则没装 dsh 的用户会看到它闪一下
  var groupDsh = menuGroup('dsh', 'dsh', false, function () { dshSend('status') });
  groupDsh.body.appendChild(rowDsh); groupDsh.body.appendChild(rowDshPage);
  groupDsh.body.appendChild(rowDshState); groupDsh.body.appendChild(rowDshCmd);
  groupDsh.el.style.display = 'none';

  // —— 多厂商模型：点一行即把它设为挂件主显示 ——
  var groupModels = menuGroup('models', '模型', true);
  var modelsListEl = document.createElement('div');
  modelsListEl.className = 'dshwv-models';
  var rowModelsRefresh = menuRow();
  var modelsRefreshBtn = document.createElement('button');
  modelsRefreshBtn.type = 'button';
  modelsRefreshBtn.className = 'dshwv-menu-link';
  modelsRefreshBtn.textContent = '刷新全部';
  // 忙碌态只在「刷新完成」时收尾：宿主收到请求会先推一次旧快照、拉完再推一次带 refreshDone 的
  // （见 preload/lib/ipc.js）。用定时器猜网络耗时不是提前解锁（慢了能连点）就是残留「刷新中…」。
  // 兜底定时器只防极端情况（宿主异常 / 窗口重建丢了那次推送），不能让按钮永久禁用
  var modelsRefreshTimer = null;
  function setModelsRefreshBusy(busy) {
    if (modelsRefreshTimer) { clearTimeout(modelsRefreshTimer); modelsRefreshTimer = null; }
    modelsRefreshBtn.disabled = busy;
    modelsRefreshBtn.textContent = busy ? '刷新中…' : '刷新全部';
    if (busy) {
      modelsRefreshTimer = setTimeout(function () {
        modelsRefreshTimer = null;
        setModelsRefreshBusy(false);
      }, 30000);
    }
  }
  modelsRefreshBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    setModelsRefreshBusy(true);
    whaleApi.refreshModels(null, true);
  });
  rowModelsRefresh.appendChild(menuLabel('余额'));
  rowModelsRefresh.appendChild(modelsRefreshBtn);
  groupModels.body.appendChild(modelsListEl);
  groupModels.body.appendChild(rowModelsRefresh);

  // models 放最前：它是菜单里最高频的操作，且只在多模型时显示（见下面的 display 切换），
  // 隐藏时也不会在中间留出一段空白把上下两组隔开
  menuBox.appendChild(groupModels.el);
  menuBox.appendChild(groupLook.el);
  menuBox.appendChild(groupUsage.el);
  menuBox.appendChild(groupTimer.el);
  menuBox.appendChild(groupDsh.el);
  menuBox.appendChild(row9);

  // 模型行的数值文案：额度型显示「已用 x%」，余额型显示原币种金额
  function modelValueText(m) {
    if (m.error) return '失败';
    if (m.kind === 'quota') {
      return (m.usedPct === null || m.usedPct === undefined) ? '--' : '已用 ' + Number(m.usedPct) + '%';
    }
    if (m.kind === 'codex') {
      return (m.tokens === null || m.tokens === undefined) ? '--' : fmtTokens(m.tokens);
    }
    if (m.balance === null || m.balance === undefined) return '--';
    return fmtModelMoney(m.balance, m.currency);
  }
  function renderModelsMenu() {
    // 只有内置 DeepSeek 时整组收起，菜单保持原样；添加过模型才出现
    var hasExtra = models.length > 1;
    groupModels.el.style.display = hasExtra ? '' : 'none';
    modelsListEl.textContent = '';
    if (!hasExtra) return;
    models.forEach(function (m) {
      var row = document.createElement('button');
      row.type = 'button';
      var on = m.id === mainModelId;
      row.className = 'dshwv-model-row' + (on ? ' dshwv-model-on' : '');
      var mark = document.createElement('span');
      mark.className = 'dshwv-model-mark';
      mark.textContent = on ? '✓' : '';
      var name = document.createElement('span');
      name.className = 'dshwv-model-name';
      name.textContent = m.name + (m.builtin ? '（内置）' : '');
      var val = document.createElement('span');
      val.className = 'dshwv-model-val' + (m.error ? ' dshwv-model-err' : '');
      val.textContent = modelValueText(m);
      // Codex 的订阅窗口塞进悬浮提示：菜单行只有一行，放不下窗口信息，鼠标停一下就能看到
      var winTip = m.kind === 'codex' ? codexWinParts(m.codexWindows) : '';
      row.title = (m.error ? m.error : (on ? '当前挂件主显示' : '点击设为挂件主显示')) + (winTip ? ' · ' + winTip : '');
      row.appendChild(mark); row.appendChild(name); row.appendChild(val);
      row.addEventListener('click', function (e) {
        e.stopPropagation();
        if (on) return;
        whaleApi.setMainModel(m.id);
      });
      modelsListEl.appendChild(row);
    });
  }

  // dsh 状态渲染（宿主回推快照；菜单打开与启动时也会主动问一次）
  function dshRender(s) {
    if (!s) return;
    // 这组只在「这台机器上确实有 dsh」时才露面：已安装（source 为 global/plugin）或
    // 正在运行（本插件启的 running / 别的终端启的 external）都算。都没探测到时保持隐藏，
    // 没装过 dsh 的普通用户菜单里就不会多出这一节。
    // 注意 error 不算「有」：探测失败时若显示这组，用户只会看到一行报错却无从下手
    var dshUsable = !!(s.source || s.running || (s.external && s.externalPid));
    var shown = groupDsh.el.style.display !== 'none';
    if (dshUsable !== shown) {
      groupDsh.el.style.display = dshUsable ? '' : 'none';
      positionMenu(); // 菜单高度变了，重新夹一次，别让它顶出可视区
    }
    var err = s.error ? String(s.error) : '';
    // 3080 上的进程：running=本插件启动；external=别的终端启动的 dsh；portOther=非 dsh 占用
    var ext = !!(s.external && s.externalPid);
    var other = s.portOther || '';
    var text = '未获取';
    if (s.busy === 'install') text = '安装中…';
    else if (s.busy === 'update') text = '更新中…';
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
      (s.running ? '\n状态：' + (s.ready ? '3080 已就绪' : '启动中，稍等') + (s.needsRestart ? '（已换成 ' + (s.resolved || '') + '，点「重启」生效）' : '') : '') +
      '\nNode：' + (s.nodeDir || '未找到') + (s.nodeVersion ? '（' + s.nodeVersion + '）' : '') +
      '\n版本：' + (s.resolved || '未安装') + (s.source === 'global' ? '（全局）' : s.source === 'plugin' ? '（插件目录）' : '') +
      (ext ? '\n外部进程：由别的终端启动，「结束」会结束它，「重启」会用当前配置重新启动' : '') +
      '\n页面：' + (s.webUrl ? '已捕获带 token 地址' : (s.url || '')) +
      '\n详细日志见设置页「DeepSeek Harness」';
    dshCmdEl.textContent = s.lastCmd || '—';
    dshCmdEl.title = s.lastCmd
      ? '最近执行的命令：\n' + s.lastCmd + '\n（完整日志见设置页「DeepSeek Harness」）'
      : '还没有执行过命令';
    var busy = s.busy === 'update' || s.busy === 'versions' || s.busy === 'install';
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
  // 常驻说明行默认就允许换行：它是三行里最长的一行，nowrap 会撑宽、把三行一起缩小（见 fitBubbleText）
  hintEl.className = 'dshwv-hint dshwv-wrap';
  textBox.appendChild(labelEl); textBox.appendChild(amountEl); textBox.appendChild(hintEl);

  var bubbleBox = document.createElement('div');
  bubbleBox.className = 'dshwv-bubble';
  bubbleBox.innerHTML =
    '<svg viewBox="0 0 1026 700" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg">' +
    '<path class="dshwv-bshape" stroke-width="18" stroke-linejoin="round" stroke-linecap="round" d="M 827 248 A 373 232 0 1 0 81 246 A 373 232 0 0 0 301 465 A 57 32 10 0 0 413 484 A 373 232 0 0 0 827 248 Z"/>' +
    '<ellipse class="dshwv-b1" cx="352" cy="561" rx="37.5" ry="26" stroke-width="18"/>' +
    '<ellipse class="dshwv-b2" cx="442" cy="646" rx="24.5" ry="18" stroke-width="18"/>' +
    '</svg>';
  var gifEl = document.createElement('img');
  gifEl.className = 'dshwv-gif';
  gifEl.src = GIF_URL;
  gifEl.alt = '';
  gifEl.draggable = false;
  var gifFailed = false;
  // 当前 gifEl.src 对应的「原始值」：img.src 读出来是绝对 URL（相对路径会被解析成 file://…），
  // 拿它跟 './whale/rua.gif' 比对永远不相等，只能自己记一份
  var gifSrcSet = GIF_URL;
  // 换图：自定义气泡图与内置 rua.gif 共用这一个 <img>。图变了才重设 src 并复位失败标记，
  // 否则每次抽到同一张都会重新发起加载（data URL 也会白解码一遍）
  function setGifSrc(url) {
    var u = url || GIF_URL;
    if (u === gifSrcSet) return;
    gifSrcSet = u;
    gifFailed = false;
    try { gifEl.src = u; } catch (err) { gifFailed = true; }
  }
  gifEl.onerror = function () {
    gifFailed = true;
    // 自定义图加载失败：此时气泡已经切到「只显示图」的状态，光记标记会留下一片空白，
    // 当场换成失败文案（下一次抽到别的图时 setGifSrc 会复位标记）
    if (gifEl.style.display === 'block' && bubbleShown) {
      bubbleRandomLines = singleCenter('A', pickOne(QUOTES.gifFail), '', true);
      applyBubbleLines(bubbleRandomLines);
    }
  };
  bubbleBox.appendChild(gifEl);
  bubbleBox.appendChild(textBox);
  bubbleBox.addEventListener('click', function (e) {
    e.stopPropagation();
    if (!bubbleShown) return;
    if (bubbleRandomActive || bubbleTimerActive) {
      // 「只显计时」关闭时计时只是先弹一下：点掉它要接着显示常规内容，而不是直接把气泡收起
      if (bubbleTimerActive && !timerTakesBubble()) { timerPeekDone(); return; }
      // 依次播放：随机台词阶段再点一次切下一组，播完最后一组才收起
      if (bubbleRandomActive && clickQueueOn && queueNext()) return;
      hideBubble(); // 再次点击：关闭（计时气泡收起后计时继续）
    } else {
      // 首次点击：切随机台词（依次播放时从第一组开始），并重置自动关闭计时（保证第二段有完整停留时间）
      bubbleRemindActive = false; // 用户点击后让随机台词接管，避免被峰谷提醒覆盖
      bubbleRemindLines = null;
      bubbleRandomActive = true;
      queueIdx = 0;
      bubbleRandomLines = clickQueueOn ? RANDOM_GROUPS[0].lines() : pickRandomLines();
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
  var state = { balance: null, currency: null, todayUsage: null, isPeak: false, peakNextAt: 0, budgetOver: false, lowOver: false, status: 'loading', message: '', adjustNote: null };
  // 多厂商模型（宿主 whale:models 推送）：list 含内置 DeepSeek 那条，mainModelId 决定挂件主显示
  var models = [];
  var mainModelId = 'deepseek';
  // 币种前缀与宿主 constants.js 的 MODEL_MONEY_PREFIX 保持一致（浮动页没有 require，读不到宿主常量）
  var MODEL_MONEY_PREFIX = { CNY: '¥ ', USD: '$' };
  var curScale = 1.3;
  var flipped = false;
  var animDelayTimer = null, drag = null, shown = null, animId = null;
  var bubbleShown = false, bubbleTimer = null, bubbleRandomActive = false, bubbleRandomLines = null;
  var bubbleRemindActive = false, bubbleRemindLines = null; // 峰谷提醒气泡（优先级高于随机台词）
  var queueIdx = 0; // 「点按依次播放」当前播到第几组台词
  var bubbleTimerActive = false; // 计时气泡（正计时/倒计时/定时/时间到），优先级最高
  var BUBBLE_STYLE_CLASS = { A: 'dshwv-label', B: 'dshwv-amount', P: 'dshwv-period', C: 'dshwv-hint' };

  var soundOn = true, soundVol = 0.9, soundSet = 'duck';
  // 宿主推送的 base64 data URL（whale:sounds），**每个槽位是一组**（同一类可导入多段，播放时随机取一条）。
  // press/release 是「音色」两段，low/budget/peak/pass 是四类提醒各自的提醒音（没有内置回落，留空即静音）
  var customSounds = { press: [], release: [], low: [], budget: [], peak: [], pass: [] };
  var customSkin = '';         // 宿主推送的自定义形象 base64 data URL（whale:skin，空串=未导入）
  // 宿主推送的自定义气泡图片（whale:bubbles，base64 data URL 数组）。与形象不同，这里没有
  // 「当前用哪张」：抽到「动图组」时从里面随机取一张，空数组则回退内置 rua.gif
  var customBubbles = [];
  var skinId = DEFAULT_SKIN;   // 当前形象：BUILTIN_SKINS 的键，或 'custom'（用户导入）
  var themeId = 'default';     // 当前气泡配色：'default' | 'dark' | 'sakura'
  var opacityPct = 100;        // 窗口透明度 20–100
  var passThroughOn = false;   // 鼠标穿透总开关：开启后连鲸鱼也穿透；悬停片刻可临时接管
  // 透明度：写成 CSS 变量 --dshw-opacity，由样式表消费（.dshwv-root 与菜单打开态各自相乘）。
  // 千万不能给 root/menuBox 写内联 opacity：菜单的显隐本身就是靠 opacity:0/1，内联值会
  // 盖掉它的关闭态，表现为「三点菜单关不掉」。
  function applyOpacityCss() {
    try {
      document.documentElement.style.setProperty('--dshw-opacity', String(opacityPct / 100));
    } catch (err) {}
  }

  // 套用挂件形象：内置形象走插件包内相对路径，自定义走宿主推来的 data URL。
  // 命中测试画布是按图片像素建的，换图必须重建，否则透明区穿透判定还停留在旧形象的轮廓上。
  function applySkin() {
    var url = (skinId === 'custom' && customSkin) ? customSkin : (BUILTIN_SKINS[skinId] || BUILTIN_SKINS[DEFAULT_SKIN]);
    if (url === IMG_URL) return;
    IMG_URL = url;
    try { img.src = url; } catch (err) { logErr('[whale][page] 切换形象失败', err && err.message); }
    setupHitTest();
  }
  // 套用气泡配色：只重写 CSS 变量（颜色本体在样式表里，见 .dshwv-text / .dshwv-hint / 气泡 SVG）
  function applyTheme() {
    var t = THEMES[themeId] || THEMES.default;
    try {
      root.style.setProperty('--dshwv-text', t.text);
      root.style.setProperty('--dshwv-hint', t.hint);
      root.style.setProperty('--dshwv-fill', t.fill);
      root.style.setProperty('--dshwv-stroke', t.stroke);
    } catch (err) {}
  }

  // —— 鼠标穿透：悬停临时接管 + IPC 去重 ——
  // 穿透态下窗口 setIgnoreMouseEvents(true, {forward:true}) 仍会把 mousemove 转给页面，
  // 所以「悬停唤醒」与「穿透中」角标都能工作；点击/滚轮才真正穿透给下层应用。
  var PASS_DWELL_MS = 1200;    // 穿透态下鼠标在鲸鱼/菜单按钮上停留多久 → 临时接管
  var PASS_RELEASE_MS = 700;   // 临时接管后离开 UI 多久 → 交回穿透
  var passHoverActive = false; // 临时接管中（可点、可拖、可开菜单）
  var passDwellTimer = null, passReleaseTimer = null;
  var passNoticeReady = false; // 首次配置下发（onInit）不弹说明气泡，避免每次重建挂件都提示一遍
  var lastIgnoreSent = null;   // 去重：值没变就不发 IPC（鼠标移动时每秒几十次无谓调用）
  function sendIgnoreMouse(ignore) {
    var v = !!ignore;
    if (v === lastIgnoreSent) return;
    lastIgnoreSent = v;
    whaleApi.setIgnoreMouse(v);
  }
  function passDwellCancel() { if (passDwellTimer) { clearTimeout(passDwellTimer); passDwellTimer = null; } }
  function passReleaseCancel() { if (passReleaseTimer) { clearTimeout(passReleaseTimer); passReleaseTimer = null; } }
  // 穿透中且未接管时，让菜单按钮以低透明度常显：既是「此刻点不动」的提示，也是悬停接管的抓手
  function passApplyIndicator() {
    var on = passThroughOn && !passHoverActive && menuBtnEnabled;
    menuBtn.classList.toggle('dshwv-menu-btn-pass', on);
  }
  function passTakeOver() {
    passHoverActive = true;
    passApplyIndicator();
    menuBtn.classList.add('dshwv-menu-btn-visible');
    sendIgnoreMouse(false);
  }
  function passRelease() {
    passHoverActive = false;
    passApplyIndicator();
    menuBtn.classList.remove('dshwv-menu-btn-visible');
    sendIgnoreMouse(true);
  }
  // 提醒气泡自动收起：remindSec = 0 表示常驻，等用户点掉（设置页可配）
  function setRemindAutoHide() {
    if (remindSec > 0) bubbleTimer = setTimeout(hideBubble, remindSec * 1000);
  }
  // 提醒气泡统一入口：峰谷/预算/低余额/穿透说明都走这里（三行内容，停留秒数共用设置）
  function showRemindBubble(lines) {
    if (!bubbleOn || timerActive()) return; // 计时进行中不打断（此时也有系统通知兜底）
    if (bubbleTimer) { clearTimeout(bubbleTimer); bubbleTimer = null; }
    if (gifFadeTimer) { clearTimeout(gifFadeTimer); gifFadeTimer = null; }
    bubbleShown = true;
    bubbleRandomActive = false;
    bubbleRandomLines = null;
    bubbleTimerActive = false;
    bubbleRemindActive = true;
    bubbleRemindLines = lines;
    restoreBubbleLines();
    applyBubbleLines(lines);
    bubbleBox.classList.add('dshwv-bubble-open');
    setRemindAutoHide();
  }
  // 穿透开关切换的一次性说明气泡（穿透只影响输入、不影响绘制，气泡照常可见）。
  // 文案取设置页的「提醒文案」模板，红/绿沿用状态色（开=红，关=绿）
  function showPassNotice(on) {
    playAlertSound('pass');
    showRemindBubble(alertLines(on ? 'passOn' : 'passOff', {}, on ? '#e0433f' : '#2fa24c'));
  }
  var timerNotifyOn = true, timerPersistOn = true; // 计时到点系统通知 / 计时状态持久化
  // 计时到点的邮件通知开关，以及「邮件渠道总开关」的本地副本：页面不自己发信，
  // 只用来判断「到点该不该叫宿主发」—— 两个渠道都关时才真的不发。
  var timerMailOn = true, mailOn = false;
  var usageMode = 'ledger', peakMode = 'default', bubbleOn = true;
  var peakRemindOn = true; // 峰/谷时段切换时用气泡提醒（需开启思考气泡）
  var menuBtnEnabled = true; // 挂件右上角菜单按钮开关（设置页可关）
  var lowAlertOn = true, lowAlertAmount = 10; // 低余额预警（余额低于阈值时数字变红）
  var budgetOn = false, budgetAmount = 0; // 今日预算：用量超过预算额时提醒（0 = 未设置）
  var clickQueueOn = false; // 点气泡依次播放台词（关掉则每次随机一组）
  var timeBubbleOn = true; // 报时：气泡首行显示当前时间
  var dragLock = false; // 锁定位置：禁止拖拽与滚轮缩放（点击刷新仍可用）
  var menuOpen = false;
  var menuDown = false; // 本次打开锁定的展开方向（true = 向按钮下方展开）
  var menuDirLocked = false; // 方向已定：打开动画期间内容高度变化不重算，防面板在按钮上下侧来回翻
  var hideBtnTimer = null; // 菜单按钮延迟隐藏（鲸鱼→按钮之间的透明间隙里保持可点）
  var firstBalance = true, pendingManual = false;
  var lastIsPeak = null; // 上一次的峰谷状态，用于检测「进入峰时/谷时」的切换

  // —— 随机台词 ——
  // 台词库内置默认值：与宿主 store.js 的 QUOTES_DEFAULT 逐字一致（浮动页没有 require 读不到宿主常量，
  // 靠 scripts/check-shared.mjs 在构建时比对，改一处忘另一处会构建失败）。
  // hint / chat / dsh / short 是内置六组里那四个文本组的默认台词（设置页没配过组列表时用它拼出六组）；
  // time 是白天报时模板（{t} 换当前时间）、gifFail 是动图加载失败的顶替文案 —— 这两项不走抽签，
  // 固定就是这两份，设置页改过则由 applyConfig 覆盖。
  var QUOTES = {
    hint: ['好模型... ↓', '好女孩...↓'],
    chat: ['不知道用户有什么用，先赶走吧~', '我...我...我也要挣钱吗？', '我去吃饭啦，测完叫我', '压力一只蓝色大肥鱼？！', 'DeepSleep...', '坏了...用户彻底怒了！'],
    dsh: ['你目录里的dsh是什么...大烧货吗...?', '恭喜你实现token自由！token全跑了！', '真当我是便宜货啊...'],
    short: ['哦鲸鲸...'],
    time: ['现在是 {t}', '已经 {t} 啦', '都 {t} 了哦', '小鲸鱼报时：{t}'],
    gifFail: ['gif 加载失败了...', '今天没有动图给你看~', '呜呜 动图不见了...'],
  };
  // 上面这两项（不走抽签的那两份）的 key：applyConfig 里逐个覆盖
  var QUOTE_TEXT_KEYS = ['time', 'gifFail'];
  // 随机取一条，且不与上次同组取到的重复（组内只有 1 条时无从避免，直接返回）。
  // 记在数组自身引用上，所以每一组各记各的，不会互相干扰
  var lastPicked = new WeakMap();
  function pickOne(arr) {
    if (arr.length < 2) return arr[0];
    var last = lastPicked.get(arr);
    var i = Math.floor(Math.random() * arr.length);
    // 撞上上次那条就在「其余 len-1 条」里等概率重抽一个（不是简单 +1，避免总是抽到相邻那条）
    if (i === last) i = (i + 1 + Math.floor(Math.random() * (arr.length - 1))) % arr.length;
    lastPicked.set(arr, i);
    return arr[i];
  }
  // 随机抽一张自定义气泡图（不连续重复，复用 pickOne 的 WeakMap 机制）；没导入时回空串，
  // 调用方据此回退内置 rua.gif
  function pickBubbleUrl() {
    if (!customBubbles.length) return '';
    return pickOne(customBubbles) || '';
  }
  // 提醒文案模板：内置默认值（与宿主 store.js 的 ALERTS_DEFAULT 保持一致，浮动页没有 require 读不到宿主常量）。
  // 四类提醒（低余额 / 今日预算 / 峰谷切换 / 鼠标穿透）共用这一份，气泡与系统通知取同一套文案。
  // 模板按行映射到气泡三行：第 1 行标题 / 第 2 行大字 / 第 3 行说明。设置页改过则由 applyConfig 覆盖。
  var ALERTS = {
    low: '【余额预警】\n仅剩 {balance}\n已低于预警阈值 {threshold}（设置页可改）',
    budget: '【预算提醒】\n超预算 {over}\n今日已用 {used}，预算 {budget}（设置页可改）',
    peakOn: '【峰时提醒】\n峰时\n叮咚～进入峰时段啦（北京时间）！{schedule}，其余谷时',
    peakOff: '【谷时提醒】\n谷时\n好消息～进入谷时段啦（北京时间）！{schedule}外为谷时',
    passOn: '【鼠标穿透】已开启\n穿透中\n在鲸鱼上停留约 1 秒可临时接管；也可用「切换鼠标穿透」快捷键关闭',
    passOff: '【鼠标穿透】已关闭\n可操作\n点击、拖拽与菜单已恢复',
  };
  // 模板 → 气泡三行：替换 {占位符}（未提供的原样留着，便于发现写错），
  // 行数不足对应槽位留空，超过三行的并入说明行（气泡只有三行，多了显示不出来）
  function alertLines(key, vars, midColor) {
    var v = vars || {};
    var text = String(ALERTS[key] || '').replace(/\{(\w+)\}/g, function (m, k) {
      return Object.prototype.hasOwnProperty.call(v, k) ? String(v[k]) : m;
    });
    var all = text.split('\n');
    var rows = [];
    for (var i = 0; i < all.length; i++) {
      var s = all[i].replace(/^\s+|\s+$/g, '');
      if (s) rows.push(s);
    }
    if (rows.length > 3) rows = [rows[0], rows[1], rows.slice(2).join(' ')];
    return [
      rows[0] ? { t: rows[0], s: 'A', c: '' } : null,
      rows[1] ? { t: rows[1], s: 'P', c: midColor || '' } : null,
      rows[2] ? { t: rows[2], s: 'C', c: '', w: true } : null,
    ];
  }
  // 报时文案（鲸鱼娘语气，按时段变化）；白天几种说法可在设置页改，{t} 换成当前时间
  function timeLabel() {
    var d = new Date();
    var p2 = function (n) { return String(n).padStart(2, '0'); };
    var t = p2(d.getHours()) + ':' + p2(d.getMinutes());
    var h = d.getHours();
    if (h < 6) return '都 ' + t + ' 了，还不睡吗…';
    if (h >= 23) return '都 ' + t + ' 了，早点休息…';
    if (h < 11) return '早安~ 现在是 ' + t;
    return pickOne(QUOTES.time).split('{t}').join(t);
  }
  function singleCenter(style, text, color, wrap) { return [null, { t: text, s: style, c: color || '', w: !!wrap }, null]; }
  function fmt(balance, currency) {
    var num = Number(balance);
    var fixed = isFinite(num) ? num.toFixed(2) : '--';
    return currency === 'CNY' ? '¥ ' + fixed : fixed + ' ' + currency;
  }
  // token 数按万/亿缩写（与设置页口径一致）：大字行放不下长串数字
  function fmtTokens(n) {
    var v = Number(n) || 0;
    if (v >= 1e8) return (v / 1e8).toFixed(2) + ' 亿';
    if (v >= 1e4) return (v / 1e4).toFixed(1) + ' 万';
    return String(v);
  }
  // —— 多厂商模型：主显示取值 ——
  function currentModel() {
    for (var i = 0; i < models.length; i++) {
      if (models[i].id === mainModelId) return models[i];
    }
    return null;
  }
  // 原币种金额（不折汇率：各模型余额彼此独立，不参与 DeepSeek 的账本记账）
  function fmtModelMoney(v, currency) {
    var num = Number(v);
    var fixed = isFinite(num) ? num.toFixed(2) : '--';
    var pre = MODEL_MONEY_PREFIX[currency];
    return pre ? pre + fixed : fixed + ' ' + String(currency || '');
  }
  function resetTail(ms) {
    var t = Number(ms) || 0;
    if (!t) return '';
    var d = new Date(t);
    return ' · ' + (d.getMonth() + 1) + '-' + d.getDate() + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ' 重置';
  }
  // 常规状态下的标题行：主显示不是 DeepSeek 时用该模型名（报时只属于内置 DeepSeek）
  function defaultLabelText() {
    if (mainModelId !== 'deepseek') {
      var m = currentModel();
      var suffix = m && m.kind === 'quota' ? ' 额度' : (m && m.kind === 'codex' ? ' 用量' : ' 余额');
      return (m ? m.name : '模型') + suffix;
    }
    return timeBubbleOn ? timeLabel() : 'DeepSeek 余额';
  }
  // 「今日已用 ¥x」在常驻主显示、峰谷组、多厂商模型三处都要显示，措辞集中在这里，避免各写各的
  function usedTodayText(money) { return '今日已用 ' + money; }
  // Codex 订阅窗口文案（5h / 周）：与额度型多窗口同一写法 —— 逐窗口列已用%，尾部接首个窗口的重置时间。
  // 窗口名优先按 window_minutes 推断（各 Codex 版本给的不一样），没给就按位置叫 5h / 周
  function codexWinLabel(w, idx) {
    var mins = Number(w.windowMinutes) || 0;
    if (mins >= 1440) return Math.round(mins / 1440) + '天';
    if (mins >= 60) return Math.round(mins / 60) + 'h';
    if (mins > 0) return mins + '分钟';
    return idx === 0 ? '5h' : '周';
  }
  function codexWinParts(w) {
    if (!w) return '';
    var list = [];
    if (w.primary) list.push(w.primary);
    if (w.secondary) list.push(w.secondary);
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var one = list[i];
      if (one.usedPct === null || one.usedPct === undefined) continue;
      out.push(codexWinLabel(one, i) + ' ' + Number(one.usedPct) + '%');
    }
    if (!out.length) return '';
    return out.join(' · ') + (w.primary ? resetTail(w.primary.resetAt) : '');
  }
  // 主显示模型的金额行 + 说明行
  function modelDisplay() {
    var m = currentModel();
    if (!m) return { amount: '…', hint: '加载中…' };
    if (m.error) return { amount: '--', hint: String(m.error).slice(0, 14) };
    if (m.kind === 'quota') {
      if (m.usedPct === null || m.usedPct === undefined) return { amount: '…', hint: '额度查询中…' };
      var left = Math.round((100 - Number(m.usedPct)) * 10) / 10;
      // 多窗口接口（OpenCode Go 的 5h/周/月、MiniMax 的 5h/周）：大字取首个窗口的剩余，
      // 说明行逐窗口列出已用% —— 只显示首个窗口的话，周/月额度在挂件上完全看不到
      var ws = m.windows;
      if (ws && ws.length > 1) {
        var parts = [];
        for (var i = 0; i < ws.length; i++) parts.push(ws[i].label + ' ' + Number(ws[i].usedPct) + '%');
        return { amount: left + '%', hint: '已用 ' + parts.join(' · ') + resetTail(m.resetAt) };
      }
      return { amount: left + '%', hint: '已用 ' + Number(m.usedPct) + '%' + resetTail(m.resetAt) };
    }
    // Codex 本地会话统计：大字是今日 token，说明行给本月累计
    if (m.kind === 'codex') {
      if (m.tokens === null || m.tokens === undefined) return { amount: '…', hint: '统计中…' };
      var mh = '今日 token';
      if (m.monthTokens) mh += ' · 本月 ' + fmtTokens(m.monthTokens);
      // 订阅窗口（5h / 周）：挂件上就能看到已用% 与重置时间，不必进设置页；没订阅时这段为空
      var cw = codexWinParts(m.codexWindows);
      if (cw) mh += ' · ' + cw;
      return { amount: fmtTokens(m.tokens), hint: mh };
    }
    if (m.balance === null || m.balance === undefined) return { amount: '…', hint: '查询中…' };
    // 今日已用是「本次余额 - 上次余额」估出来的（插件拦不到对话），所以带 ~ 标记
    var used = (m.todayUsage === null || m.todayUsage === undefined)
      ? (Number(m.at) ? '更新于 ' + fmtHm(m.at) : '')
      : '~' + usedTodayText(fmtModelMoney(m.todayUsage, m.currency));
    return { amount: fmtModelMoney(m.balance, m.currency), hint: used };
  }
  // 第 3 行（说明行）一律允许换行：它是三行里最长的一行，也是三行中唯一会超出可用宽
  // （FIT_W=660u）的那行。若保持 nowrap，fitBubbleText 会按它算出缩放系数、把三行一起缩小
  // —— 第 2 行的大字金额会跟着从 140u 掉到约 105u，挂件越小越看不清。
  function buildGroup1() {
    // 峰谷时段是 DeepSeek 专属概念：主显示换成别的模型时，这组台词改报该模型的余额/额度
    if (mainModelId !== 'deepseek') {
      var d = modelDisplay();
      return [
        { t: defaultLabelText(), s: 'A', c: '' },
        { t: d.amount, s: 'P', c: '' },
        { t: d.hint, s: 'C', c: '', w: true },
      ];
    }
    var peak = !!state.isPeak;
    var tail = peakCountdownText();
    return [
      { t: '当前时间段为:', s: 'A', c: '' },
      { t: peakLabelText(peak), s: 'P', c: peak ? '#e0433f' : '#2fa24c' },
      { t: usedTodayText(fmt(state.todayUsage, state.currency)) + (tail ? ' · ' + tail : ''), s: 'C', c: '', w: true },
    ];
  }
  // 内置默认组：与宿主 store.js 的 QUOTE_GROUPS_DEFAULT 一一对应（顺序、权重、样式都要一致）。
  // 权重沿用整理前写死在挂件页里的那套（45 / 7 / 7 / 10 / 3 / 1）
  function defaultRandomGroups() {
    return [
      { kind: 'card', w: 45 },
      { kind: 'text', w: 7, style: 'B', lines: QUOTES.hint },
      { kind: 'text', w: 7, style: 'A', lines: QUOTES.chat },
      { kind: 'image', w: 10 },
      { kind: 'text', w: 3, style: 'A', lines: QUOTES.dsh },
      { kind: 'text', w: 1, style: 'B', lines: QUOTES.short },
    ];
  }
  // 台词占位符：{balance} 当前主显示金额 / {today} 今日已用 / {peak} 当前时段 / {next} 距下次峰谷切换。
  // 后三项都是 DeepSeek 口径：主显示换成别的模型时 state.isPeak / peakNextAt 不再更新
  // （见 handleBalance 的提前返回），此时给空串而不是旧值，免得台词里报出一个早就过期的时段。
  // 认不出的占位符原样保留（与提醒文案 alertLines 同一口径），便于用户发现写错。
  function linePlaceholderValue(k) {
    if (k === 'balance') return mainAmountText();
    if (k !== 'today' && k !== 'peak' && k !== 'next') return null;
    if (mainModelId !== 'deepseek') return '';
    if (k === 'today') return (state.todayUsage === null || state.todayUsage === undefined) ? '--' : fmt(state.todayUsage, state.currency);
    if (k === 'peak') return peakLabelText(!!state.isPeak);
    return peakCountdownLeftText();
  }
  // 占位符在「这一组真被抽到」时才替换：抽签那一刻换会拿到上一轮刷新的旧余额
  function renderLinePlaceholders(text) {
    return String(text == null ? '' : text).replace(/\{(\w+)\}/g, function (m, k) {
      var v = linePlaceholderValue(k);
      return v === null ? m : v;
    });
  }
  // 文本组 → 抽签项：组内随机抽一条；A 允许换行（长句折行），B 不换行（靠挂件按可用宽度整体缩放）
  function textGroupLines(list, style) {
    return function () { return singleCenter(style, renderLinePlaceholders(pickOne(list)), '', style === 'A'); };
  }
  // 图片组 → 抽签项：抽一张自定义气泡图（没导入过时回空串，渲染层据此回退内置 rua.gif）
  function imageGroupLines() { return { gif: true, src: pickBubbleUrl() }; }
  // 组配置 → 抽签项列表。card 是内置的余额 / 时段卡（内容按当前数据现算，文本不可编辑）；
  // 文本组没有有效台词就整组丢掉（清空 = 这组不出现，与宿主 normQuotes 口径一致）；
  // 一组不剩时回退内置六组 —— 全空会让「随机台词」整个功能消失。
  function buildRandomGroups(groups) {
    var src = Array.isArray(groups) && groups.length ? groups : defaultRandomGroups();
    var out = [];
    for (var i = 0; i < src.length; i++) {
      var g = src[i] || {};
      var w = Number(g.w);
      if (!(w > 0)) w = 1; // 宿主已把权重压在 1–999，这里只是兜底（0 / NaN 会让抽签把该组当兜底项）
      if (g.kind === 'card') { out.push({ w: w, lines: buildGroup1 }); continue; }
      if (g.kind === 'image') { out.push({ w: w, lines: imageGroupLines }); continue; }
      var list = Array.isArray(g.lines) ? g.lines : [];
      if (!list.length) continue;
      out.push({ w: w, lines: textGroupLines(list, g.style === 'B' ? 'B' : 'A') });
    }
    return out.length ? out : buildRandomGroups(defaultRandomGroups());
  }
  var RANDOM_GROUPS = buildRandomGroups(null);
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
  // 「依次播放」：展示下一组台词；已是最后一组时返回 false，由调用方收起气泡
  function queueNext() {
    if (queueIdx + 1 >= RANDOM_GROUPS.length) { queueIdx = 0; return false; }
    queueIdx += 1;
    bubbleRandomLines = RANDOM_GROUPS[queueIdx].lines();
    swapBubbleContent(function () { applyBubbleLines(bubbleRandomLines); });
    if (bubbleTimer) { clearTimeout(bubbleTimer); bubbleTimer = null; }
    bubbleTimer = setTimeout(hideBubble, BUBBLE_MS);
    return true;
  }

  // —— 峰谷时段提醒 ——
  // 时段表在页面内按内置规则拼出（浮动页没有 require，读不到宿主 constants）
  var PEAK_HOURS = [[9, 12], [14, 18]]; // 工作日峰时（北京时间）
  // 模板里的 {schedule}：只给时段表本身，前后缀（「其余谷时」/「外为谷时」）写在模板里，用户可改
  function scheduleText() {
    return '峰时' + PEAK_HOURS.map(function (h) { return h[0] + '-' + h[1]; }).join('/') + '点';
  }
  // 气泡只有三行，模板按行映射为 A=标题、P=时段、C=正文（见 alertLines）
  function peakRemindLines(isPeak) {
    return alertLines(isPeak ? 'peakOn' : 'peakOff', { schedule: scheduleText() },
      isPeak ? '#e0433f' : '#2fa24c');
  }
  // 距下次峰谷切换的剩余时间（1h23m / 23m）。切换时刻由宿主按 constants 里的同一套规则下发
  // （payload.peakNextAt），页面只做 at − now 换算，不在页面里实现第二套时段规则（页面拿不到宿主 constants）。
  // 时刻缺失或已过点（left <= 0）返回空串：等下一轮刷新拿到新时刻
  function peakCountdownLeftText() {
    var at = Number(state.peakNextAt) || 0;
    if (!at) return '';
    var left = at - Date.now() / 1000;
    if (left <= 0) return '';
    var m = Math.max(1, Math.round(left / 60));
    var h = Math.floor(m / 60);
    return h > 0 ? h + 'h' + pad2(m % 60) + 'm' : m + 'm';
  }
  // 气泡第三行的倒计时尾巴（不足 1 小时按分钟显示）
  function peakCountdownText() {
    var left = peakCountdownLeftText();
    return left ? '距' + (state.isPeak ? '谷时' : '峰时') + ' ' + left : '';
  }
  // 峰谷两种状态的叫法（跟随设置页的「峰谷」模式）：余额卡与台词占位符 {peak} 共用，避免两处各写一套
  function peakLabelText(peak) {
    if (peakMode === 'liangwen') return peak ? '梁文峰' : '梁文谷';
    if (peakMode === 'qiangqiang') return peak ? '!?峰峰?!' : '!?谷谷?!';
    return peak ? '高峰时段' : '空闲时段';
  }

  // —— 今日预算 ——
  // 超出预算的金额；未开启 / 未设金额 / 未超出都返回 null
  function budgetOverAmount() {
    if (!budgetOn || !(budgetAmount > 0)) return null;
    var used = Number(state.todayUsage);
    if (!isFinite(used) || used <= budgetAmount) return null;
    return used - budgetAmount;
  }
  function budgetRemindLines(over) {
    return alertLines('budget', {
      used: fmt(state.todayUsage, state.currency),
      budget: fmt(budgetAmount, state.currency),
      over: fmt(over, state.currency),
    }, '#e0433f');
  }
  // 首次超出预算时提醒一次（复用提醒气泡通道）；计时进行中不打断，宿主侧另有系统通知兜底
  function showBudgetRemind(over) {
    playAlertSound('budget');
    showRemindBubble(budgetRemindLines(over));
  }

  // —— 低余额预警 ——
  // 与数字变红同一判据（开关 + 阈值），这里额外在首次跌破阈值时弹一次提醒气泡
  function lowBalanceHit() {
    return lowAlertOn && state.balance !== null && isFinite(Number(state.balance))
      && Number(state.balance) < lowAlertAmount;
  }
  function lowRemindLines() {
    return alertLines('low', {
      balance: fmt(state.balance, state.currency),
      threshold: fmt(lowAlertAmount, state.currency),
    }, '#e0433f');
  }
  function showLowRemind() {
    playAlertSound('low');
    showRemindBubble(lowRemindLines());
  }

  // —— 计时 / 定时 / 倒计时（结果显示在思考气泡内，每秒刷新） ——
  var timerMode = 'off';     // off | up(正计时) | down(倒计时) | at(定时)
  var timerRunning = false;  // 正在走秒
  var timerPaused = false;   // 已暂停：进度保留，点「继续」接着走
  var timerFinished = false; // 刚结束，气泡里显示「时间到」
  var timerStartAt = 0;      // 正计时本段起点（暂停时为 0）
  var timerEndAt = 0;        // 倒计时/定时终点（暂停时为 0）
  var timerElapsed = 0;      // 正计时累计已计毫秒
  var timerRemain = 0;       // 倒计时/定时暂停时的剩余毫秒
  var timerArg = '';         // 倒计时时长（HH:MM:SS）/ 定时 HH:MM
  var timerNote = '';        // 到点要做什么：开始前写的留言，到点后显示在气泡与通知里
  var timerBreakMin = TIMER_BREAK_DEFAULT; // 到点后「休息」按钮的分钟数（0 = 不显示该按钮）
  var timerRemindSec = 8;    // 到点提醒气泡停留秒数（0 = 常驻，手动点气泡关闭）
  var timerBubblePin = true; // 计时中气泡是否常驻显示（关闭则只短暂显示，点小鲸鱼可再看）
  var timerBubbleOnly = true; // 气泡是否只显示计时：关掉后气泡照常显示余额/用量等全部内容
  var timerTick = null;
  var timerClockText = '';   // 气泡里已渲染的时钟文本：每秒只改这一处，避免整块重排
  // —— 到点气泡里的可点动作（挂 body，与菜单同级）——
  var timerDoneActions = document.createElement('div');
  timerDoneActions.className = 'dshwv-timer-actions';
  timerDoneActions.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
  timerDoneActions.addEventListener('click', function (e) { e.stopPropagation(); });
  var timerBreakBtn = document.createElement('button');
  timerBreakBtn.type = 'button';
  timerBreakBtn.className = 'dshwv-timer-act dshwv-timer-act-main';
  timerBreakBtn.addEventListener('click', function () { repeatTimerTimer(timerBreakMin * 60); });
  var timerAgainBtn = document.createElement('button');
  timerAgainBtn.type = 'button';
  timerAgainBtn.className = 'dshwv-timer-act';
  timerAgainBtn.textContent = '再来一轮';
  timerAgainBtn.title = '按上次的目标接着计时';
  timerAgainBtn.addEventListener('click', function () { repeatTimerTimer(0); });
  var timerDoneBtn = document.createElement('button');
  timerDoneBtn.type = 'button';
  timerDoneBtn.className = 'dshwv-timer-act';
  timerDoneBtn.textContent = '知道了';
  timerDoneBtn.title = '收起提醒（计时已结束）';
  timerDoneBtn.addEventListener('click', function () { hideBubble(); });
  timerDoneActions.appendChild(timerBreakBtn);
  timerDoneActions.appendChild(timerAgainBtn);
  timerDoneActions.appendChild(timerDoneBtn);
  document.body.appendChild(timerDoneActions);
  function pad2(n) { return n < 10 ? '0' + n : String(n); }
  // 时长统一显示成 时:分:秒（满一分钟起就带小时位，避免正计时走成 90:00 这种读不出小时的形式）
  function fmtClock(ms) {
    var s = Math.max(0, Math.round(ms / 1000));
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return h > 0 ? h + ':' + pad2(m) + ':' + pad2(sec) : pad2(m) + ':' + pad2(sec);
  }
  function fmtHm(ts) {
    var d = new Date(ts);
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }
  // 时/分/秒三段 → 总秒数（超上限截到 23:59:59）；全为 0 用默认 25 分钟，避免「填了 0 就开始不了」
  function timerSegTotalSec() {
    var h = Math.max(0, Math.round(Number(timerHour.value) || 0));
    var m = Math.max(0, Math.round(Number(timerMin.value) || 0));
    var s = Math.max(0, Math.round(Number(timerSec.value) || 0));
    var total = h * 3600 + m * 60 + s;
    if (total <= 0) total = TIMER_MIN_DEFAULT * 60;
    return Math.min(TIMER_MAX_SEC, total);
  }
  function timerActive() { return timerRunning || timerPaused || timerFinished; }
  function timerBusy() { return timerRunning || timerPaused; }
  // —— 到点动作条：只有「时间到」且气泡在显示时才出现（挂在 body 上，定位到气泡下缘） ——
  function updateTimerActions() {
    if (!timerFinished || !bubbleShown) { timerDoneActions.classList.remove('dshwv-actions-open'); return; }
    timerBreakBtn.style.display = timerBreakMin > 0 ? '' : 'none';
    timerBreakBtn.textContent = '休息 ' + timerBreakMin + ' 分钟';
    timerDoneActions.classList.add('dshwv-actions-open');
    positionTimerActions();
  }
  function positionTimerActions() {
    if (!timerDoneActions.classList.contains('dshwv-actions-open')) return;
    try {
      var bb = bubbleBox.getBoundingClientRect();
      var vw = window.innerWidth || document.documentElement.clientWidth || 300;
      var vh = window.innerHeight || document.documentElement.clientHeight || 300;
      var w = timerDoneActions.offsetWidth || 0;
      // 气泡在左吸附（根元素镜像）时视觉位置由 rect 反映，但按钮文案不该跟着镜像，
      // 所以只借 rect 定位、不做 scaleX(-1)，横向夹在窗口内即可
      var left = (bb.left + bb.right - w) / 2;
      left = Math.max(4, Math.min(vw - w - 4, left));
      timerDoneActions.style.left = left + 'px';
      if (bb.bottom + 6 < vh - 34) {
        timerDoneActions.style.top = bb.bottom + 6 + 'px';
        timerDoneActions.style.bottom = 'auto';
      } else {
        timerDoneActions.style.top = 'auto';
        timerDoneActions.style.bottom = Math.max(4, vh - bb.top + 6) + 'px';
      }
    } catch (err) {}
  }
  // 到点后的「再来一轮 / 休息 N 分钟」：sec > 0 用该秒数，sec <= 0 按上次的目标重来
  function repeatTimerTimer(sec) {
    var n = Math.round(Number(sec)) || 0;
    if (n <= 0) n = Math.round(Number(timerArg)) || 0;
    if (n <= 0) n = TIMER_MIN_DEFAULT * 60; // 正计时/定时没有「时长」概念，退回默认倒计时
    n = Math.min(TIMER_MAX_SEC, Math.max(1, n));
    timerMode = 'down';
    timerSelect.value = 'down';
    timerHour.value = String(Math.floor(n / 3600));
    timerMin.value = String(Math.floor((n % 3600) / 60));
    timerSec.value = String(n % 60);
    startTimer();
  }
  function timerModeLabel() { return timerMode === 'up' ? '正计时' : (timerMode === 'at' ? '定时' : '倒计时'); }
  function timerLabelText() { return timerPaused ? timerModeLabel() + '（已暂停）' : timerModeLabel(); }
  function timerRemainMs() {
    if (timerMode === 'up') return timerRunning ? timerElapsed + (Date.now() - timerStartAt) : timerElapsed;
    if (timerRunning) return Math.max(0, timerEndAt - Date.now());
    return Math.max(0, timerRemain);
  }
  function timerTailText() {
    if (timerFinished) return '点下方按钮选择下一步';
    if (timerPaused) return '点继续接着走';
    if (timerMode === 'up') return '点气泡可收起';
    if (timerMode === 'at') {
      // 跨到明天时标明「明天」，避免误读成今天到点
      var d = new Date(timerEndAt);
      var now = new Date();
      var crossDay = d.getFullYear() !== now.getFullYear() || d.getMonth() !== now.getMonth() || d.getDate() !== now.getDate();
      return '到点 ' + (crossDay ? '明天 ' : '') + fmtHm(timerEndAt);
    }
    return '共 ' + fmtClock((Number(timerArg) || 0) * 1000);
  }
  function timerLines() {
    if (timerFinished) {
      // 到点：大字给「时间到！」，说明行优先显示用户自己写的留言（这才是他要知道的「接下来做什么」）
      return [
        { t: timerModeLabel() + '结束', s: 'A', c: '' },
        { t: timerNote || '时间到！', s: timerNote ? 'B' : 'P', c: '#e0433f', w: !!timerNote },
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
  // 退出「刚结束」展示态：气泡收起 / 用户点了鲸鱼都算已经看到，标记清掉后
  // 菜单时长与留言重新可编辑、气泡也不再一直被计时占用（否则点鲸鱼永远只弹「时间到」）
  function clearTimerDone() {
    timerFinished = false;
    timerDoneActions.classList.remove('dshwv-actions-open');
    syncTimerMenu();
  }
  // 到点通知（宿主按渠道配置分发：系统通知 / 邮件）。两个开关是「或」关系 ——
  // 平时只开系统通知时行为不变；只开邮件时也该发信，所以不能只看 timerNotifyOn。
  // 正文带上用户开始前写的那句留言：通知离开挂件也要能看出「接下来做什么」。
  function notifyTimerDone() {
    if (!timerNotifyOn && !(timerMailOn && mailOn)) return;
    var text = '小鲸鱼提醒：' + timerDoneText();
    try { whaleApi.notifyTimerDone(text); } catch (err) { logErr('[whale][page] 计时通知失败', err && err.message); }
  }
  // 到点说的一句话：用户留言优先，没有就按模式给默认说法
  function timerDoneText() {
    var base = timerMode === 'at' ? '定时到点（' + timerArg + '）' : timerModeLabel() + '结束（' + timerArg + '）';
    return timerNote ? base + ' · ' + timerNote : base;
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
      // 时/分/秒三段合计：允许 90 分、80 秒这类填法，只按总秒数截上限
      var sec = timerSegTotalSec();
      timerHour.value = String(Math.floor(sec / 3600));
      timerMin.value = String(Math.floor((sec % 3600) / 60));
      timerSec.value = String(sec % 60);
      timerArg = String(sec); // 秒数：气泡「共 x」与「再来一轮」都按它复原
      timerEndAt = now + sec * 1000;
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
    // 上一轮「时间到」的气泡可能还挂着（常驻或还没到 timerRemindSec）：
    // 先收起它，否则到点动作条会和新一轮计时气泡叠在一起，timerFinished 也会把它当结束态
    if (timerFinished) hideBubble();
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
  // 到点留言：只影响「下次到点」（本次计时用的就是开始时那句），所以改完不必重绘气泡
  function setTimerNote(v) {
    timerNote = String(v || '').slice(0, TIMER_NOTE_MAX);
    timerNoteEl.value = timerNote;
    saveCfg();
  }
  function setTimerBreakMin(v) {
    var n = Math.round(Number(v));
    if (!isFinite(n)) n = TIMER_BREAK_DEFAULT;
    timerBreakMin = Math.min(120, Math.max(0, n));
    timerBreak.value = String(timerBreakMin);
    saveCfg();
    updateTimerActions();
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
    // 「刚结束」不算忙：到点后气泡可能还挂着（常驻或还没到 timerRemindSec），
    // 但这只是展示态 —— 菜单必须能直接改时长/留言开下一轮，否则要等气泡消失才解锁，用起来像卡死
    var idle = !busy;
    // 「目标」行：计时中/暂停时让位给「重置」；未开始时才显示时/分/秒或时刻输入
    rowTimerArg.style.display = (busy || (idle && (timerMode === 'down' || timerMode === 'at'))) ? '' : 'none';
    timerResetBtn.style.display = busy ? '' : 'none';
    var down = idle && timerMode === 'down';
    timerHour.style.display = down ? '' : 'none';
    timerMin.style.display = down ? '' : 'none';
    timerSec.style.display = down ? '' : 'none';
    timerTime.style.display = (idle && timerMode === 'at') ? '' : 'none';
    // 单位提示跟着自己的输入框一起显隐（各自成对，避免「时」标签孤零零留在行里）
    timerSegUnits[0].style.display = down ? '' : 'none';
    timerSegUnits[1].style.display = down ? '' : 'none';
    timerSegUnits[2].style.display = down ? '' : 'none';
    // 留言与休息档：只在还没开始时显示 —— 计时中改它们没有意义（这次到点用的就是开始时那句）
    rowTimerNote.style.display = idle ? '' : 'none';
    rowTimerBreak.style.display = idle ? '' : 'none';
    updateTimerActions();
  }

  // —— 气泡内容 ——
  var bubbleSwapTimer = null, hintFadeTimer = null, gifFadeTimer = null, lastHintText = null;
  // 气泡自适应：三行字号固定（数值与 floating.css 的 .dshwv-label/amount/period/hint 必须一致），
  // 长文案换行后可能撑出气泡，这里按可用区域测量后等比缩小字号
  // （只缩不放，正常内容保持原字号）；单位 u = 挂件基准 / 1026，与 CSS 的 --dshw-u 一致
  var BUBBLE_FONT = { 'dshwv-label': 72, 'dshwv-amount': 140, 'dshwv-period': 114, 'dshwv-hint': 72 };
  // 气泡内文字可用区域（单位 u = 挂件基准/1026）。与 CSS 里 .dshwv-bubble 的放大倍数(1.18)保持一致：
  // 圆圈放大多少，这里就放大多少，字号才会跟着变大而不是被压小。
  // FIT_H 430 是按「说明行折成两行」定的：三行全展开约 404u（72×1.15 + 140×1.05 + 9 + 2×72×1.15），
  // 留到 430u 才不会被折行后的高度反压回去；再大就顶到大椭圆下缘（内高约 547u，居中后下侧仅 251u）
  var FIT_W = 660, FIT_H = 430, FIT_MIN = 0.5;
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
      // 有自定义气泡图就用它，否则回退内置 rua.gif（lines.src 为空串 = 用内置）
      setGifSrc(lines.src);
      if (gifFailed) {
        lines = singleCenter('A', pickOne(QUOTES.gifFail), '', true);
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
    labelEl.textContent = defaultLabelText();
    labelEl.style.color = '';
    amountEl.style.display = '';
    amountEl.className = 'dshwv-amount';
    amountEl.style.color = '';
    hintEl.style.display = '';
    hintEl.className = 'dshwv-hint dshwv-wrap'; // 与初始化一致：常驻说明行允许换行
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
      // 用户主动点鲸鱼 = 已经看到「时间到」了：正常收起这一态，别让它一直占着气泡
      // （自动刷新 / 余额推送触发的 fromUser 为假，那时仍保持结束态直到提醒时长走完）
      if (timerFinished && fromUser) { hideBubble(); return; }
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
    timerDoneActions.classList.remove('dshwv-actions-open');
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
    updateTimerActions(); // 到点后把「休息 / 再来一轮 / 知道了」摆到气泡下缘
    if (autoHideMs) bubbleTimer = setTimeout(thenNormal ? timerPeekDone : hideBubble, autoHideMs);
  }
  // 峰/谷时段切换提醒：独立于随机台词，内容多一行时段表
  function showPeakRemind(isPeak) {
    playAlertSound('peak');
    showRemindBubble(peakRemindLines(isPeak));
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
    // 「时间到」提示收起后回到普通状态（计时已结束，模式保留便于重新开始）；
    // 动作条与气泡同生共死，否则气泡没了按钮还浮在那儿
    timerDoneActions.classList.remove('dshwv-actions-open');
    if (timerFinished) clearTimerDone();
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
    var low = mainModelId !== 'deepseek' ? modelLowHit() : lowBalanceHit();
    amountEl.classList.toggle('dshwv-low', low);
    hintEl.classList.toggle('dshwv-low', low);
  }
  // 主显示模型的低余额判定：开关与阈值取该模型自己的条目（内置 DeepSeek 走 lowBalanceHit）
  function modelLowHit() {
    var m = currentModel();
    if (!m || m.kind !== 'balance' || !m.lowAlertOn) return false;
    if (!(Number(m.lowAlertAmount) > 0)) return false;
    if (m.balance === null || m.balance === undefined) return false;
    return Number(m.balance) < Number(m.lowAlertAmount);
  }
  // 「这笔余额下降没算进用量」的解释在第三行停留 12s（赠送额到期/异常跳变时由后端下发）
  var ADJUST_NOTE_MS = 12000;
  function activeAdjustNote() {
    var n = state.adjustNote;
    if (!n) return null;
    if (Date.now() >= n.until) { state.adjustNote = null; return null; }
    return n;
  }
  function adjustNoteText(a) {
    var money = fmt(Number(a && a.amount), state.currency);
    return a && a.why === '赠送额度到期/被收回'
      ? '赠送额到期 ' + money + '，未计用量'
      : '少了 ' + money + ' 太快，未计用量';
  }
  // 主显示金额（大字行）的文本：render() 与台词占位符 {balance} 共用同一份状态判断，
  // 免得两处各写一套、日后改口径漏掉一处
  function mainAmountText() {
    // 主显示是别的模型：DeepSeek 的加载 / 错误态都不参与展示
    if (mainModelId !== 'deepseek') return modelDisplay().amount;
    if (state.status === 'error') return shown !== null ? fmt(shown, state.currency) : '--';
    if (state.balance === null) return shown !== null ? fmt(shown, state.currency) : '…';
    return shown !== null ? fmt(shown, state.currency) : fmt(state.balance, state.currency);
  }
  function render() {
    var hint;
    var note = activeAdjustNote();
    var amount = mainAmountText();
    if (mainModelId !== 'deepseek') {
      // 主显示是别的模型：DeepSeek 的状态（错误/加载/今日已用/预算/调整说明）都不参与展示
      hint = modelDisplay().hint;
    } else if (state.status === 'error') {
      hint = state.message ? state.message.slice(0, 14) : '获取失败 · 点击重试';
    } else if (state.balance === null) {
      hint = '加载中…';
    } else {
      var usedText = (state.todayUsage !== null && state.todayUsage !== undefined) ? fmt(state.todayUsage, state.currency) : '--';
      var overAmt = budgetOverAmount();
      // 超预算后第三行常驻显示，不依赖「首次超出」那次提醒气泡
      hint = note ? note.text : usedTodayText(usedText) + (overAmt !== null ? ' · 超预算 ' + fmt(overAmt, state.currency) : '');
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
    // 主显示不是内置 DeepSeek 时另外刷该模型：force 让它与 DeepSeek 同频（60s 一次）
    if (mainModelId !== 'deepseek') whaleApi.refreshModels([mainModelId], true);
  }
  function handleBalance(data, manual) {
    // 主显示不是内置 DeepSeek 时，DeepSeek 的余额变动、峰谷/预算/低余额提醒都不该出现：
    // 它的数字滚动动画会直接改写当前显示，提醒气泡也会盖掉模型内容
    if (mainModelId !== 'deepseek') return;
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
      state.peakNextAt = Number(data.peakNextAt) || 0;
      // 本轮下降被判定为非消费（赠送额到期等）：第三行解释 12s；正常采样不带此字段
      state.adjustNote = (data.adjust && data.adjust.amount)
        ? { text: adjustNoteText(data.adjust), until: Date.now() + ADJUST_NOTE_MS }
        : null;
      // 峰/谷时段切换：仅在上一次已有状态且发生变化时提醒（首次拉取不弹）
      var peakChanged = lastIsPeak !== null && lastIsPeak !== state.isPeak;
      lastIsPeak = state.isPeak;
      if (peakChanged && peakRemindOn) showPeakRemind(state.isPeak);
      // 今日预算：首次超出时提醒（比峰谷提醒更该被看到，所以放在其后覆盖）；
      // 与峰谷提醒一致，插件刚进入时已有状态的那一次不弹，第三行的「超预算」常驻提示照常显示
      var overAmt = budgetOverAmount();
      var budgetCrossed = overAmt !== null && !state.budgetOver && !firstBalance;
      state.budgetOver = overAmt !== null;
      if (budgetCrossed) showBudgetRemind(overAmt);
      // 低余额预警：首次跌破阈值时提醒。放在预算之后，两者同时命中时以「余额不足」为准（更紧急）；
      // 同样不在插件刚进入那一次补弹，但数字变红照常
      var lowHit = lowBalanceHit();
      var lowCrossed = lowHit && !state.lowOver && !firstBalance;
      state.lowOver = lowHit;
      if (lowCrossed) showLowRemind();
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

  // —— 多厂商模型（宿主 whale:models 推送）——
  // 峰谷/预算/用量口径都是 DeepSeek 专属：主显示换成别的模型时把「用量与峰谷」整组收起
  function applyModelVisibility() {
    groupUsage.el.style.display = mainModelId === 'deepseek' ? '' : 'none';
  }
  function handleModels(data) {
    if (!data || typeof data !== 'object') return;
    // refreshDone = 宿主刷新流程收尾那次推送（先前那次只是把旧快照推来垫显示）→ 解锁「刷新全部」
    if (data.refreshDone) setModelsRefreshBusy(false);
    var prev = mainModelId;
    models = Array.isArray(data.list) ? data.list : [];
    mainModelId = String(data.mainModelId || 'deepseek');
    renderModelsMenu();
    applyModelVisibility();
    positionMenu(); // 行数变化后重新夹取高度，避免菜单被窗口边缘裁掉
    if (mainModelId !== 'deepseek') {
      render();
    } else if (prev !== mainModelId) {
      // 切回内置 DeepSeek：状态可能已是一分钟前的，立刻要一次新的（handleBalance 已放行）
      refresh(true);
    }
  }

  // —— 配置（菜单改动 → 上报宿主；宿主回推 config 统一 apply） ——
  function saveCfg() {
    whaleApi.saveConfig({
      scale: curScale, vol: soundVol, soundOn: soundOn, soundSet: soundSet,
      opacity: opacityPct,
      usageMode: usageMode, peakMode: peakMode, bubbleOn: bubbleOn,
      timeBubbleOn: timeBubbleOn, peakRemindOn: peakRemindOn, dragLock: dragLock,
      timerNotifyOn: timerNotifyOn, timerPersistOn: timerPersistOn,
      // 这两个「邮件」开关本页只读（回填自 applyConfig），但必须原样带回去：
      // 挂件菜单任何一次改动都会整份 saveCfg → patchConfig 逐字段覆盖，
      // 漏带就等于用 undefined 把用户在设置页开的邮件通知悄悄关掉
      timerMailOn: timerMailOn, notifyMailOn: mailOn,
      timerMode: timerMode,
      timerSec: timerSegTotalSec(),
      timerAt: String(timerTime.value || ''),
      // 到点要做什么：留言 + 「休息」档（都只在开始前可改，见 syncTimerMenu）
      timerNote: String(timerNoteEl.value || '').slice(0, TIMER_NOTE_MAX),
      timerBreakMin: Math.min(120, Math.max(0, Math.round(Number(timerBreak.value) || 0))),
      timerRemindSec: timerRemindSec,
      timerBubblePin: timerBubblePin,
      timerBubbleOnly: timerBubbleOnly,
      // 分组展开组合（整份提交；宿主侧逐组合并，不会影响其余组）
      menuGroups: menuGroups,
      // 带上版本号，下次启动才不会再触发一次 look 迁移（见 onInit）
      menuGroupsRev: MENU_GROUPS_REV,
    });
  }
  function scaleToDisplay(s) {
    return Math.round((s - MIN_SCALE) / ((MAX_SCALE - MIN_SCALE) / (SCALE_STEPS - 1))) + 1;
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
    applySoundVolume();
    if (commit) saveCfg(); // 拖动中只改本地音量，松手才持久化（避免高频存储写入）
  }
  function setSoundSet(v) {
    soundSet = (v === 'fx1' || v === 'custom') ? v : 'duck';
    soundSelect.value = soundSet;
    applySoundSet();
    saveCfg();
  }
  // 挂件菜单透明度档位（设置页有连续滑块，同一配置字段）
  function setOpacityPreset(v) {
    var n = Math.round(Number(v));
    if (OPACITY_PRESETS.indexOf(n) < 0) return;
    opacityPct = n;
    opacitySelect.value = String(n);
    saveCfg(); // opacity 随配置广播回本页，applyConfig 把它落到 root 的 CSS opacity
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
    if (bubbleShown && !bubbleRandomActive) labelEl.textContent = defaultLabelText();
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
      var nextSet = (cfg.soundSet === 'fx1' || cfg.soundSet === 'custom') ? cfg.soundSet : 'duck';
      if (nextSet !== soundSet) { soundSet = nextSet; applySoundSet(); }
      soundSelect.value = soundSet;
    }
    if (typeof cfg.opacity === 'number' && isFinite(cfg.opacity)) {
      opacityPct = Math.min(100, Math.max(20, Math.round(cfg.opacity)));
      // 透明度走页面 CSS opacity，不用窗口 setOpacity（transparent 窗口会整窗不显示）
      applyOpacityCss();
      // 菜单只有几个档位，非档位值（设置页连续滑块改的）就近显示
      var best = OPACITY_PRESETS[0];
      for (var i = 0; i < OPACITY_PRESETS.length; i++) {
        if (Math.abs(OPACITY_PRESETS[i] - opacityPct) < Math.abs(best - opacityPct)) best = OPACITY_PRESETS[i];
      }
      opacitySelect.value = String(best);
    }
    if (typeof cfg.passThrough === 'boolean' && cfg.passThrough !== passThroughOn) {
      passThroughOn = cfg.passThrough;
      // 状态切换：清掉悬停接管的中间态，立即生效（不能等下一次 mousemove —— 鼠标可能正静止）
      passHoverActive = false;
      passDwellCancel();
      passReleaseCancel();
      if (passThroughOn) {
        if (menuOpen) closeMenu();
        menuBtn.classList.remove('dshwv-menu-btn-visible');
        sendIgnoreMouse(true);
        if (passNoticeReady) showPassNotice(true);
      } else {
        // 关闭穿透：先按安全默认忽略鼠标，指针移到鲸鱼上时悬停逻辑会重新判定
        sendIgnoreMouse(true);
        menuBtn.classList.remove('dshwv-menu-btn-visible');
        if (passNoticeReady) showPassNotice(false);
      }
      passApplyIndicator();
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
      passApplyIndicator(); // 按钮被关掉时，穿透角标也要跟着收起
      if (!menuBtnEnabled) {
        if (hideBtnTimer) { clearTimeout(hideBtnTimer); hideBtnTimer = null; }
        menuBtn.classList.remove('dshwv-menu-btn-visible');
        if (menuOpen) closeMenu();
      }
    }
    // 菜单分组展开态：设置页 / 别的窗口改过就同步过来；不在这里回写（saveCfg），
    // 否则自己刚存的展开组合会被自己再提交一遍。
    // look 组从「默认展开」改成「默认收起」后，老配置里存量 look:true 会盖掉新默认值，
    // 菜单看起来跟没改一样 —— 这里对 look 做一次性迁移：旧配置从没存过 menuGroupsRev，
    // 认作迁移前的数据，强制收起一次；之后用户的点击都会带上 rev 正常生效
    var needLookMigration = cfg.menuGroupsRev !== MENU_GROUPS_REV;
    if (cfg.menuGroups && typeof cfg.menuGroups === 'object') {
      Object.keys(menuGroupEls).forEach(function (k) {
        if (needLookMigration && k === 'look') { menuGroups[k] = false; menuGroupEls[k].setOpen(false); return; }
        if (typeof cfg.menuGroups[k] !== 'boolean') return;
        menuGroups[k] = cfg.menuGroups[k];
        menuGroupEls[k].setOpen(cfg.menuGroups[k]);
      });
      positionMenu(); // 展开组合变了，菜单高度跟着变
    }
    if (typeof cfg.lowAlertOn === 'boolean') lowAlertOn = cfg.lowAlertOn;
    if (typeof cfg.lowAlertAmount === 'number' && isFinite(cfg.lowAlertAmount)) lowAlertAmount = Math.max(0, cfg.lowAlertAmount);
    // 阈值/开关变化后同步「已低于阈值」状态，避免下一次刷新把旧状态当越线又弹一次
    state.lowOver = lowBalanceHit();
    applyLowAlert();
    // 提醒气泡停留秒数（0 = 常驻）
    if (typeof cfg.remindSec === 'number' && isFinite(cfg.remindSec)) {
      var rs = Math.round(cfg.remindSec);
      remindSec = (rs === 0 || rs === 5 || rs === 8 || rs === 15) ? rs : 8;
    }
    // 今日预算：开关/金额变化后即时刷新第三行的「超预算」，同时同步「已超出」状态，
    // 避免改完设置下一次刷新又弹一遍首次提醒气泡
    if (typeof cfg.budgetOn === 'boolean' || (typeof cfg.budgetAmount === 'number' && isFinite(cfg.budgetAmount))) {
      if (typeof cfg.budgetOn === 'boolean') budgetOn = cfg.budgetOn;
      if (typeof cfg.budgetAmount === 'number' && isFinite(cfg.budgetAmount)) budgetAmount = Math.max(0, cfg.budgetAmount);
      state.budgetOver = budgetOverAmount() !== null;
      if (!bubbleShown) render();
    }
    if (typeof cfg.clickQueueOn === 'boolean') clickQueueOn = cfg.clickQueueOn;
    if (typeof cfg.timeBubbleOn === 'boolean') {
      timeBubbleOn = cfg.timeBubbleOn;
      timeToggle.checked = timeBubbleOn;
      // 气泡正显示且未切随机台词时，即时更新首行报时文案
      if (bubbleShown && !bubbleRandomActive) labelEl.textContent = defaultLabelText();
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
    if (typeof cfg.timerMailOn === 'boolean') timerMailOn = cfg.timerMailOn;
    if (typeof cfg.notifyMailOn === 'boolean') mailOn = cfg.notifyMailOn;
    if (typeof cfg.timerPersistOn === 'boolean') {
      timerPersistOn = cfg.timerPersistOn;
      persistToggle.checked = timerPersistOn;
    }
    // 计时偏好：运行中的状态以 timer 状态为准，这里只在空闲时套用。
    // 注意：宿主每次广播配置都会走到这里，若不加判断就会把「正在编辑中」的输入框
    // 强行回填 —— 用户打字打到一半被覆盖，看起来就像「输入实时生效」。
    // 所以凡是当前持有焦点的输入框一律跳过回显，交由 commitOnEnter 在回车/blur 时提交。
    function editing(el) { return document.activeElement === el; }
    if (typeof cfg.timerSec === 'number' && isFinite(cfg.timerSec)) {
      var ts = Math.min(TIMER_MAX_SEC, Math.max(0, Math.round(cfg.timerSec))) || TIMER_MIN_DEFAULT * 60;
      if (!editing(timerHour)) timerHour.value = String(Math.floor(ts / 3600));
      if (!editing(timerMin)) timerMin.value = String(Math.floor((ts % 3600) / 60));
      if (!editing(timerSec)) timerSec.value = String(ts % 60);
    }
    if (typeof cfg.timerAt === 'string' && /^\d{1,2}:\d{2}$/.test(cfg.timerAt) && !editing(timerTime)) {
      timerTime.value = cfg.timerAt;
    }
    if (typeof cfg.timerNote === 'string') {
      timerNote = cfg.timerNote.slice(0, TIMER_NOTE_MAX);
      if (!editing(timerNoteEl)) timerNoteEl.value = timerNote;
    }
    if (typeof cfg.timerBreakMin === 'number' && isFinite(cfg.timerBreakMin)) {
      timerBreakMin = Math.min(120, Math.max(0, Math.round(cfg.timerBreakMin)));
      if (!editing(timerBreak)) timerBreak.value = String(timerBreakMin);
    }
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
    // 挂件形象与气泡配色：值没变时 applySkin/applyTheme 内部自己短路，不必先比对
    if (typeof cfg.skin === 'string') {
      skinId = (cfg.skin === 'custom' || BUILTIN_SKIN_IDS.indexOf(cfg.skin) >= 0) ? cfg.skin : DEFAULT_SKIN;
      applySkin();
    }
    if (typeof cfg.theme === 'string') {
      themeId = (cfg.theme === 'dark' || cfg.theme === 'sakura') ? cfg.theme : 'default';
      applyTheme();
    }
    // 台词库：time / gifFail 是非空字符串数组才覆盖（空数组会让报时/降级文案没字）；
    // groups 是随机组的抽签配置，整份重建（宿主侧已清洗过，这里只做抽签项装配）
    if (cfg.quotes && typeof cfg.quotes === 'object') {
      for (var qi = 0; qi < QUOTE_TEXT_KEYS.length; qi++) {
        var qk = QUOTE_TEXT_KEYS[qi];
        if (Array.isArray(cfg.quotes[qk]) && cfg.quotes[qk].length) QUOTES[qk] = cfg.quotes[qk].slice();
      }
      RANDOM_GROUPS = buildRandomGroups(cfg.quotes.groups);
    }
    // 提醒文案模板：只接受非空字符串（空模板会让气泡没字），逐条覆盖
    if (cfg.alerts && typeof cfg.alerts === 'object') {
      for (var ak in ALERTS) {
        if (typeof cfg.alerts[ak] === 'string' && cfg.alerts[ak]) ALERTS[ak] = cfg.alerts[ak];
      }
    }
    syncTimerMenu();
    applySoundVolume();
  }

  // —— 音效 ——
  var SQUISH = 'scaleY(0.88) scaleX(1.05)';
  // 每个槽位是一组音频，播放时随机取一条（听久了不腻）。Audio 对象按 URL 缓存并预加载：
  // 每次播放都新建会多一次解码等待，而 pressUp 还要读当前按压音的 duration 才能决定何时接释放音
  var audioPool = {};
  function audioFor(url) {
    if (!url) return null;
    if (!audioPool[url]) {
      try {
        var a = new Audio(url);
        a.preload = 'auto';
        a.volume = soundVol;
        audioPool[url] = a;
      } catch (err) { return null; }
    }
    return audioPool[url];
  }
  // 宿主推来的一律是数组；不是数组时按「单段」兜底，免得拿字符串当数组用（取出来是半个字符）
  function toList(v) { return Array.isArray(v) ? v : (v ? [v] : []); }
  function pickUrl(list) { return list && list.length ? list[Math.floor(Math.random() * list.length)] : null; }
  // 池里只留当前引用的 URL：删掉/换掉一段音效后，旧的 data URL 不该继续占着内存（一段 wav 可能近 1MB）
  function prunePool() {
    var keep = {};
    var lists = [pressList, releaseList, alertUrls.low, alertUrls.budget, alertUrls.peak, alertUrls.pass];
    for (var i = 0; i < lists.length; i++) {
      for (var j = 0; j < lists[i].length; j++) keep[lists[i][j]] = true;
    }
    for (var url in audioPool) { if (!keep[url]) delete audioPool[url]; }
  }
  var pressList = [], releaseList = [];
  var pressAudio = null, releaseAudio = null;
  var pressing = false, pressEnded = false, releasePlayed = false, releaseTimer = null;
  function applySoundSet() {
    if (soundSet === 'custom') {
      // 自定义：以按压音为准；没导入按压音时整体回退小黄鸭（避免「点了没反应」）
      // 释放音可缺：松开时静音，音效仍比整段回退自然
      var hasPress = customSounds.press.length > 0;
      pressList = hasPress ? customSounds.press : toList(SOUND_FILES.duck.press);
      releaseList = hasPress ? customSounds.release : toList(SOUND_FILES.duck.release);
    } else {
      var f = SOUND_FILES[soundSet] || SOUND_FILES.duck;
      pressList = toList(f.press);
      releaseList = toList(f.release);
    }
    pressAudio = null;
    releaseAudio = null;
    for (var i = 0; i < pressList.length; i++) audioFor(pressList[i]); // 预加载，按下即响
    for (var j = 0; j < releaseList.length; j++) audioFor(releaseList[j]);
    prunePool();
  }
  function playPress() {
    if (!soundOn) return;
    pressAudio = audioFor(pickUrl(pressList));
    if (!pressAudio) return;
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
    if (releasePlayed || !soundOn) return;
    releaseAudio = audioFor(pickUrl(releaseList));
    if (!releaseAudio) return;
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
  // 音量统一落到所有音频对象上（含提醒音）：菜单滑块与设置页滑块两条路径共用。
  // 池里已收着全部音频对象，遍历它一处即够，免得新增槽位后漏掉某一处
  function applySoundVolume() {
    try {
      for (var url in audioPool) { if (audioPool[url]) audioPool[url].volume = soundVol; }
    } catch (err) {}
  }

  // —— 提醒音（低余额 / 预算 / 峰谷 / 穿透，每类可多段，随机播一条） ——
  // 与上面的「音色」相互独立：press/release 缺失时回退内置音色，提醒音没有回落 ——
  // 不打扰是默认，没导入就不响。播放只受「音效开关 + 音量」影响，不受音色选择影响。
  var alertUrls = { low: [], budget: [], peak: [], pass: [] };
  function applyAlertSounds() {
    for (var role in alertUrls) {
      alertUrls[role] = toList(customSounds[role]);
      for (var i = 0; i < alertUrls[role].length; i++) audioFor(alertUrls[role][i]);
    }
    prunePool();
  }
  function playAlertSound(role) {
    if (!soundOn) return;
    var a = audioFor(pickUrl(alertUrls[role]));
    if (!a) return; // 未导入 = 静音
    try {
      a.currentTime = 0;
      var p = a.play();
      if (p && typeof p.catch === 'function') p.catch(function () {});
    } catch (err) {}
  }

  // —— 菜单 ——
  function toggleMenu() {
    menuOpen = !menuOpen;
    if (menuOpen) {
      menuDirLocked = false; // 新一轮打开：按当前几何重新决定展开方向（见 positionMenu）
      positionMenu();
      menuBox.scrollTop = 0; // 小尺寸挂件上菜单可滚动：重开时回到顶部，否则停在上次滚到的位置
      // dsh 分组收着时状态行看不见，不必白探一次 3080；展开时才拉（见 menuGroup 的 onExpand）
      if (groupDsh.el.classList.contains('dshwv-group-open')) dshSend('status');
      // 模型列表懒加载：宿主侧有 5 分钟节流，反复开菜单不会一直打网络
      whaleApi.refreshModels(null, false);
      // 菜单里的数字不该是几分钟前的。余额侧有 25s 缓存 + 请求去重（见 preload/lib/api.js），
      // 这个补充很便宜；走的是与轮询同一条路径，所以不会切到 loading 态
      refresh(false);
      // 菜单里有输入框（留言/时长/定时），窗口默认 focusable:false 收不到键盘 → 借一次焦点
      try { whaleApi.setInputFocus(true); } catch (err) {}
      // 打开菜单这一刻指针往往停在按钮上，而「穿透恢复」定时器（PASS_RELEASE_MS）可能在
      // 菜单展开后才开火，把整窗切成点击穿透 —— 菜单明明画着，点输入框却点到了下层应用。
      // 这里立即取消待恢复的穿透并强制可交互，不等下一次 pointermove 兜底
      passReleaseCancel();
      sendIgnoreMouse(false);
    }
    menuBox.classList.toggle('dshwv-menu-open', menuOpen);
    menuBtn.setAttribute('aria-expanded', menuOpen ? 'true' : 'false');
    if (menuOpen) menuBtn.classList.add('dshwv-menu-btn-visible');
  }
  function closeMenu() {
    menuOpen = false;
    menuBox.classList.remove('dshwv-menu-open');
    menuBtn.setAttribute('aria-expanded', 'false');
    resetHideBtn(); // 关菜单即退出「隐藏挂件」确认态，免得下次打开时按钮还停在「再点一次隐藏」
    // 交还焦点：否则挂件一直占着焦点，设置窗（uTools 主窗）会失焦并自动隐藏
    try { whaleApi.setInputFocus(false); } catch (err) {}
  }
  // Esc 关菜单：挂件窗口默认 focusable=false，但菜单打开时会经 whale:input-focus 借到焦点，
  // 所以菜单开着时 Esc 能收到；菜单没开时收不到也不影响原有的「点空白关闭」
  window.addEventListener('keydown', function (e) {
    if (menuOpen && (e.key === 'Escape' || e.key === 'Esc')) closeMenu();
  });
  // 挂件到工作区上/下边缘的空白（宿主随 init / snapped 下发，见 preload/lib/widget.js 的 spaceAround）。
  // 窗口留白（--whale-pad）之外的部分落在屏幕外，菜单摆过去也看不见，必须扣掉
  var menuSpace = null;
  function padPx() {
    try {
      var n = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--whale-pad'));
      if (isFinite(n) && n > 0) return n;
    } catch (err) {}
    return 0;
  }
  function positionMenu() {
    // 菜单没打开时不定位：模型行数变化等会无条件调到，白量一次自然高度（强制 layout）
    if (!menuOpen) return;
    try {
      var b = menuBtn.getBoundingClientRect();
      var vw = window.innerWidth || document.documentElement.clientWidth || 300;
      var vh = window.innerHeight || document.documentElement.clientHeight || 300;
      // 菜单按钮被隐藏（display:none）时，rect 全 0；改用鲸鱼图片位置定位
      if (!menuBtnEnabled || b.width <= 0) {
        var wb = img.getBoundingClientRect();
        b = { left: wb.right - 30, top: wb.top + 4, right: wb.right, bottom: wb.top + 30, width: 26, height: 26 };
      }
      // 先解除高度限制量出自然高度：判断「向上是否装得下」（装得下就向上，不遮小鲸鱼）
      menuBox.style.maxHeight = 'none';
      var natural = menuBox.offsetHeight || 0;
      var pad = padPx();
      // 上/下可用高度 = 屏幕内可见的窗口留白 + 按钮到挂件本体边缘的距离
      var up = b.top;
      var down = vh - b.bottom;
      if (menuSpace && pad > 0) {
        up = Math.min(menuSpace.up, pad) + Math.max(0, b.top - pad);
        down = Math.min(menuSpace.down, pad) + Math.max(0, vh - b.bottom - pad);
      }
      // 展开方向在「本次打开的第一帧」定一次就锁住：打开动画期间 handleModels / 分组展开 /
      // resize 都会再次进到这里，若每次按新内容高度重算方向，恰好跨过「up-8」阈值时面板会
      // 在按钮上下两侧来回翻（top/bottom 锚点即时切换 + transformOrigin 跟着换 → 肉眼看到乱跳）。
      // 高度变化只重新夹 maxHeight（菜单内部滚动兜住），锚点与方向保持稳定；重开/吸附才重算。
      if (!menuDirLocked) {
        // 挂件贴在屏幕上边时上方只剩挂件内那点空间 → 改向按钮下方展开（否则菜单上半截在屏幕外）
        menuDown = down > up && up < natural + 8;
        menuDirLocked = true;
      }
      var openDown = menuDown;
      // 用按钮的「视觉」中心判断左右（根元素左吸附时整体 scaleX(-1) 镜像，
      // getBoundingClientRect 已反映镜像后的实际位置，不能再用根布局中心判断）
      var btnCx = b.left + b.width / 2;
      var onLeft = btnCx < vw / 2;
      if (onLeft) {
        menuBox.style.left = Math.max(4, b.left) + 'px';
        menuBox.style.right = 'auto';
        menuBox.style.transformOrigin = openDown ? 'top left' : 'bottom left';
      } else {
        menuBox.style.right = Math.max(4, (vw - b.right)) + 'px';
        menuBox.style.left = 'auto';
        menuBox.style.transformOrigin = openDown ? 'top right' : 'bottom right';
      }
      menuBox.classList.toggle('dshwv-menu-down', openDown);
      // 高度不足时压缩并在菜单内滚动（不把菜单压到屏幕外）
      if (openDown) {
        menuBox.style.top = Math.max(0, b.bottom) + 'px';
        menuBox.style.bottom = 'auto';
        menuBox.style.maxHeight = Math.max(0, down - 8) + 'px';
      } else {
        menuBox.style.bottom = Math.max(0, vh - b.top) + 'px';
        menuBox.style.top = 'auto';
        menuBox.style.maxHeight = Math.max(0, up - 8) + 'px';
      }
    } catch (err) {}
  }

  // —— 像素命中测试（透明区域不响应/可穿透） ——
  var hitCanvas = null, hitReady = false;
  function setupHitTest() {
    try {
      hitReady = false; // 换形象时先失效，避免旧轮廓还在生效
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
    var overBtn = isOverMenuBtn(e);
    var overWhale = isWhaleHit(e);
    // 「鼠标穿透」未接管时：恒穿透。鼠标在鲸鱼/菜单按钮上停留一小会儿 → 临时接管（可点可拖），
    // 这样既满足「平时不挡下层应用」，又不用回设置页就能操作挂件。
    if (passThroughOn && !passHoverActive) {
      if (menuOpen) closeMenu();
      setWidgetCursor('');
      if (drag && drag.active) return; // 开关切换瞬间若在拖拽，等 pointerup 自然收尾
      if (overWhale || overBtn) {
        passReleaseCancel();
        if (!passDwellTimer) {
          passDwellTimer = setTimeout(function () {
            passDwellTimer = null;
            if (!passThroughOn || passHoverActive) return;
            // 用最后一次已知位置复核：指针若已移出窗口（贴着屏幕边移走时不再有 move 事件），
            // 不能误判为「仍在鲸鱼上」而接管
            var p = lastHoverPt;
            if (!p || !(isWhaleHit(p) || isOverMenuBtn(p))) return;
            passTakeOver();
          }, PASS_DWELL_MS);
        }
      } else {
        passDwellCancel();
        sendIgnoreMouse(true);
      }
      return;
    }
    var overUI = false;
    var el = null;
    try { el = document.elementFromPoint(e.clientX, e.clientY); } catch (err) {}
    if (el && el.closest) {
      if (el.closest('.dshwv-menu.dshwv-menu-open')) overUI = true;
      else if (el.closest('.dshwv-bubble.dshwv-bubble-open')) overUI = true;
    }
    if (!overUI) overUI = overBtn || overWhale || menuOpen;
    // 菜单开着就绝不穿透：菜单里的输入框要靠窗口本身接收鼠标与键盘，
    // 一旦这里 setIgnoreMouse(true)，整窗变点击穿透，输入框点不进去也打不了字。
    // （overUI 用 elementFromPoint 判定，指针掠过透明间隙/菜单边缘的瞬间会误判成「非 UI」，
    //   所以不能只靠 overUI，必须把 menuOpen 作为硬性条件兜底）
    if (menuOpen) { passReleaseCancel(); sendIgnoreMouse(false); }
    else sendIgnoreMouse(!overUI);
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
    // 临时接管中：离开鲸鱼/菜单/按钮一小会儿后交回穿透（拖拽期间不交回，否则会拖一半断掉）
    if (passThroughOn && passHoverActive) {
      if (overUI || (drag && drag.active)) passReleaseCancel();
      else if (!passReleaseTimer) {
        passReleaseTimer = setTimeout(function () {
          passReleaseTimer = null;
          if (menuOpen || (drag && drag.active)) return; // 期间又用起来了，等下一次 pointermove 再判
          passRelease();
        }, PASS_RELEASE_MS);
      }
    }
  }

  // pointermove 高频触发：把命中测试合并到每帧一次（elementFromPoint + closest 不便宜），
  // 并为配置变更后的立即重算保留最后一个指针位置
  var hoverRaf = 0, lastHoverPt = null;
  function scheduleHover(e) {
    if (e && isFinite(e.clientX)) lastHoverPt = { clientX: e.clientX, clientY: e.clientY };
    if (hoverRaf) return;
    hoverRaf = requestAnimationFrame(function () {
      hoverRaf = 0;
      if (lastHoverPt) updateHover(lastHoverPt);
    });
  }
  function hoverNow() {
    if (hoverRaf) { cancelAnimationFrame(hoverRaf); hoverRaf = 0; }
    if (lastHoverPt) updateHover(lastHoverPt);
  }
  // 用事件里的最新位置立即重算（拖拽收尾、配置变更后用）
  function hoverAt(e) {
    if (e && isFinite(e.clientX)) lastHoverPt = { clientX: e.clientX, clientY: e.clientY };
    hoverNow();
  }

  // —— 拖拽 / 按压 / 点击 ——
  function onDocPointerDown(e) {
    if (e.target && e.target.closest) {
      if (e.target.closest('.dshwv-bubble') || e.target.closest('.dshwv-menu') || e.target.closest('.dshwv-menu-btn')) return;
    }
    if (menuOpen) {
      // 关菜单这一下：按在鲸鱼上就照常当点击/拖拽用（否则得先点一下关菜单、再点一下才能拖），
      // 按在别处（透明留白）只关菜单，并立刻重算穿透/按钮显隐
      var onWhale = isWhaleHit(e);
      closeMenu();
      if (!onWhale || (e.button !== 0 && e.pointerType === 'mouse')) { hoverAt(e); return; }
    }
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    if (!isWhaleHit(e)) return;
    try { e.preventDefault(); e.stopPropagation(); } catch (err) {}
    // 目标窗口左上角 = 屏幕指针坐标 - 指针在窗内的客户区坐标（拖拽过程恒定）
    drag = { active: true, sSX: e.screenX, sSY: e.screenY, cx0: e.clientX, cy0: e.clientY, moved: false, raf: 0, tx: 0, ty: 0 };
    passReleaseCancel(); // 开始拖拽：别让「交回穿透」的定时器在拖拽中途开火
    sendIgnoreMouse(false);
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
    scheduleHover(e); // 合并到每帧一次
  }
  function onDocPointerUp(e) {
    try { if (isWhaleHit(e)) { e.preventDefault(); e.stopPropagation(); } } catch (err) {}
    endDrag(e, true);
  }
  // pointercancel：系统/浏览器没收了手势（触摸端最常被判定成滚动）。它的坐标常为 0,0、不可信，
  // 且「取消 ≠ 松手」——不吸附、不落盘（位置只在正常 pointerup 才提交），也不拿 (0,0) 污染悬停点。
  function onDocPointerCancel() {
    if (!drag || !drag.active) return;
    drag.active = false;
    if (drag.raf) { cancelAnimationFrame(drag.raf); drag.raf = 0; }
    document.removeEventListener('pointerup', onDocPointerUp, true);
    document.removeEventListener('pointercancel', onDocPointerCancel, true);
    pressUp();
    drag = null;
    hoverAt(null); // 沿用上一次有效悬停点重算（取消事件的位置字段不可信）
  }
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
    hoverAt(e); // 立即按松手位置重算：穿透态下这里要决定是交回穿透还是保持接管
  }
  function onDocClickStopper(e) {
    // 菜单/气泡/到点动作条都压在鲸鱼图形上：不排除的话这里会 preventDefault 掉菜单里
    // 输入框的点击，留言框点不进光标、数字框选不中 —— 看着就像「菜单改不了」
    if (e.target && e.target.closest) {
      if (e.target.closest('.dshwv-menu') || e.target.closest('.dshwv-bubble') || e.target.closest('.dshwv-timer-actions')) return;
    }
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

  // 窗口尺寸变化（滚轮缩放在鲸鱼上实时预览时宿主会连续 setSize）：
  // 菜单是按按钮的旧位置摆的，不重摆就会和按钮错位
  window.addEventListener('resize', function () { positionMenu(); positionTimerActions(); });

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
    // 自定义形象本体必须先于 applyConfig 落地：applyConfig 会按 skin 值立刻套图，
    // 此时 customSkin 若还是空串，会先闪一下内置形象再换成自定义
    customSkin = data.skin || '';
    customBubbles = toList(data.bubbles);
    applyConfig(data.config);
    passNoticeReady = true; // 之后的配置变更（快捷键/设置页切换）才弹说明气泡
    if (data.sounds) {
      customSounds.press = toList(data.sounds.press);
      customSounds.release = toList(data.sounds.release);
      customSounds.low = toList(data.sounds.low);
      customSounds.budget = toList(data.sounds.budget);
      customSounds.peak = toList(data.sounds.peak);
      customSounds.pass = toList(data.sounds.pass);
      if (soundSet === 'custom') applySoundSet();
      applyAlertSounds();
    }
    if (data.anchor) {
      flipped = !!data.anchor.flipped;
      root.classList.toggle('dshwv-left', flipped);
    }
    // 挂件到工作区上下边缘的空白：菜单展开方向据此判断（见 positionMenu）
    if (data.space) menuSpace = data.space;
    // 模型列表必须先落地：handleBalance 要按主显示决定是否参与展示
    if (data.models) handleModels(data.models);
    if (data.balance) handleBalance(data.balance, false);
    restoreTimer(data.timer); // 「计时保存」开启时恢复上次的计时状态
    if (!document.hidden) startPolling();
  });
  whaleApi.onBalance(function (data) {
    handleBalance(data, pendingManual);
    pendingManual = false;
  });
  whaleApi.onConfig(function (cfg) { applyConfig(cfg); });
  whaleApi.onModels(function (data) { handleModels(data); });
  whaleApi.onSounds(function (data) {
    // 设置页导入/删除自定义音效后宿主重推；当前正用自定义音色时立即换源，
    // 提醒音与音色无关，每次都要重建（导入即生效、删除即静音）
    customSounds.press = toList(data && data.press);
    customSounds.release = toList(data && data.release);
    customSounds.low = toList(data && data.low);
    customSounds.budget = toList(data && data.budget);
    customSounds.peak = toList(data && data.peak);
    customSounds.pass = toList(data && data.pass);
    if (soundSet === 'custom') applySoundSet();
    applyAlertSounds();
  });
  whaleApi.onSkin(function (data) {
    // 设置页导入/删除自定义形象后宿主重推；当前正用自定义形象时立即换图
    customSkin = data || '';
    if (skinId === 'custom') applySkin();
  });
  whaleApi.onBubbles(function (data) {
    // 设置页导入/删除自定义气泡图后宿主重推；没有「当前用哪张」，下次抽到动图组自然生效
    customBubbles = toList(data);
  });
  whaleApi.onSnapped(function (data) {
    flipped = !!(data && data.flipped);
    root.classList.toggle('dshwv-left', flipped);
    // 吸附后位置变了，菜单展开方向要跟着重算（开着就解锁重摆，否则面板停在旧几何上）
    if (data && data.space) menuSpace = data.space;
    if (menuOpen) { menuDirLocked = false; positionMenu(); }
  });

  // —— 启动 ——
  render();
  applyOpacityCss(); // 透明度初始值（onInit 配置到达后会再校正）
  applySoundSet();
  syncTimerMenu();
  setupHitTest();
  sendIgnoreMouse(true); // 初始全穿透，悬停鲸鱼时自动取消
  passApplyIndicator();  // 若配置里已开穿透，先把「穿透中」角标显示出来
  // 先取一次 dsh 状态：既决定 dsh 组显不显示（装过才显示，见 dshRender），
  // 也让菜单里的状态行/按钮一开始就是对的。无宿主桥接时问了也没人答，跳过
  if (HAS_BRIDGE) dshSend('status');
  whaleApi.ready();
})();
