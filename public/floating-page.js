(function () {
  'use strict';
  if (window.__dshWhaleWidget) return;
  window.__dshWhaleWidget = true;

  // —— 常量 ——
  var MIN_SCALE = 0.6, MAX_SCALE = 2.5, SCALE_STEPS = 15, CLICK_SQ = 9;
  // 档位 ↔ 倍率换算（与设置页 App.vue 同一刻度，SCALE_STEPS 同值由 check-shared.mjs 校验）。
  // 菜单滑块现在走 1–SCALE_STEPS 整数档，值即档位；真正推给宿主的仍是倍率 scale。
  function numToScale(n) {
    var v = Math.max(1, Math.min(SCALE_STEPS, Math.round(Number(n) || 1)));
    return MIN_SCALE + (v - 1) * ((MAX_SCALE - MIN_SCALE) / (SCALE_STEPS - 1));
  }
  function scaleToNum(s) {
    return Math.round((Number(s) - MIN_SCALE) / ((MAX_SCALE - MIN_SCALE) / (SCALE_STEPS - 1))) + 1;
  }
  // 任意倍率吸附到最近整数档：旧存储的 1.3 这类非整档值要归到档位
  function snapNum(s) {
    return Math.max(1, Math.min(SCALE_STEPS, scaleToNum(s)));
  }
  var REFRESH_MS = 60000, CHANGE_MS = 900, ANIM_MS = 700, BUBBLE_MS = 5000;
  // 出厂默认气泡停留时长（5s）。BUBBLE_MS 保留为「出厂常量」，运行期实际取值走 bubbleDwellMs，
  // 由设置页 cfg.bubbleDwell（3–60 整数）覆盖；所有「按默认口径收起」的引用点都改读它
  var bubbleDwellMs = BUBBLE_MS;
  // 提醒气泡（峰谷/预算/低余额/穿透说明）停留秒数，由设置页下发；0 = 常驻，手动点掉
  var remindSec = 8;
  var TIMER_PEEK_MS = 2000; // 「只显计时」关闭时，点小鲸鱼先显示计时的时长（随后切回常规内容）
  var TIMER_MAX_SEC = 86399; // 倒计时上限 23:59:59
  var TIMER_MIN_DEFAULT = 25; // 三段全填 0 时的兜底分钟数（避免「填了 0 就开不了」）
  var TIMER_AT_DEFAULT = '07:30'; // 定时刻默认值（与宿主 store.js 的 defaultConfig 同值）
  var TIMER_BREAK_DEFAULT = 5;    // 到点后「休息 N 分钟」的默认档位
  var TIMER_NOTE_MAX = 60;        // 到点留言长度上限（留言只在设置页编辑，与那里输入框的 maxLength、宿主清洗同值）
  // 快捷时长四档（分钟）的出厂默认：设置页可改（cfg.timerPresets），这里只在配置缺失时兜底
  var TIMER_PRESETS_DEFAULT = [15, 25, 45, 60];
  // 随包分发的内置挂件形象（相对插件根目录；用哪张由设置页的 skin 值决定）。
  // 键 = public/whale/ 下的图片文件名，加形象时这里加一行、设置页「形象」下拉加一个 option；
  // 宿主 store.js 的 BUILTIN_SKINS 另有一份同值的合法值清单，三处要一起改。
  // 统一用 WebP（有损 q90，带 alpha）：这批原为 PNG 共 10.8MB，占插件包体积的 94%，
  // 转 WebP 后约 1.0MB（形象 id 不含扩展名，故三处副本不受影响）。
  // v1.7.x 起只留默认这一张随包（约 39KB），其余改为用户按需下载 ——
  // 下载回来的形象落进自定义画廊、走 data URL 推送（见 lib/skin-packs.js），不进本表：
  // 本表是**相对路径**表，读不到 userData 下的文件（见 lib/skins.js 文件头记的坑）。
  // 用户导入的自定义形象仍是 PNG，同样走 data URL，与本表无关。
  var BUILTIN_SKINS = {
    DSniang1: './whale/DSniang1.webp',
  };
  var DEFAULT_SKIN = 'DSniang1'; // 默认形象，也是配置里非法值 / v1.5.0 老值 'whale' 的落点
  var BUILTIN_SKIN_IDS = Object.keys(BUILTIN_SKINS);
  var IMG_URL = BUILTIN_SKINS[DEFAULT_SKIN];
  // 内置气泡动图（动 WebP：与旧 rua.gif 逐帧像素一致、体积小 ~34KB）。变量名与 CSS 类
  // 仍叫 gif，指的是「这张内置动图」这个概念，不是文件格式
  var GIF_URL = './whale/rua.webp';
  // 气泡配色预设已移入共享渲染器（src/bubble/bubble-render.js，构建后经 dist/bubble-render.js
  // 以 window.BubbleRender 暴露）：THEMES 原样别名，applyTheme 零改动
  var THEMES = window.BubbleRender.THEMES;
  var SOUND_FILES = {
    duck: { press: './whale/Ya1.mp3', release: './whale/Ya2.mp3' },
    fx1:  { press: './whale/D1.mp3',  release: './whale/D2.mp3' },
  };
  // 四类提醒音的内置回落（用户没导入对应提醒音时用这些，而不是静音）。
  // 刻意与 SOUND_FILES 分开：后者是「音色」两段（受音色选择影响），这里与音色无关；
  // 另外 check-shared.mjs 只比对 SOUND_FILES 的 ./whale/*.mp3 副本，WAV 不参与那套校验。
  var ALERT_FALLBACK = {
    low: './whale/alert-low.wav',
    budget: './whale/alert-budget.wav',
    peak: './whale/alert-peak.wav',
    pass: './whale/alert-pass.wav',
  };

  // 宿主桥接（preload/floating.js 注入）；缺省空实现，单独打开页面也不报错
  var whaleApi = window.whale || {
    onInit: function () {}, onBalance: function () {}, onConfig: function () {}, onSnapped: function () {},
    onSounds: function () {}, onSkin: function () {}, onBubbles: function () {}, onSharedSkins: function () {}, onRandimgData: function () {}, onModels: function () {}, onDark: function () {},
    onBubblePreview: function () {}, onTodo: function () {}, onTodoDue: function () {}, onFocusStats: function () {}, onFocusSession: function () {}, onCmd: function () {}, onCursor: function () {}, onForcePass: function () {},
    isDark: function () { return false; }, copyText: function () { return false; },
    ready: function () {}, refresh: function () {}, saveConfig: function () {},
    saveTimer: function () {}, notifyTimerDone: function () {},
    todoSend: function () {}, todoDueAck: function () {}, focusSession: function () {},
    dragBegin: function () {}, dragMove: function () {}, dragEnd: function () {}, setIgnoreMouse: function () {}, setInputFocus: function () {},
    probeCursor: function () {}, requestRandimg: function () {},
    openSettings: function () {}, dsh: function () {}, onDsh: function () {},
    refreshModels: function () {}, setMainModel: function () {}, hideWidget: function () {},
    reportError: function () {},
  };
  // 是否有真实宿主桥接（没有时 dsh 等需要宿主的操作要给提示，而不是一直转圈）
  var HAS_BRIDGE = !!(window.whale && window.whale.__bridge);
  // 调试日志门控：宿主 preload 把 uTools 开发者模式标志透传为 window.whale.dev
  var DEV = !!(window.whale && window.whale.dev);
  function log() { if (DEV) console.log.apply(console, arguments); }
  function logErr() {
    if (DEV) console.error.apply(console, arguments);
    // 打包版没有 DevTools，console 里的错误用户取不到；转交宿主写进 %TEMP%\whale-debug.log。
    // 宿主侧已对 msg/detail 截断，这里只做拼接
    try {
      if (window.whale && window.whale.reportError) {
        var args = Array.prototype.slice.call(arguments);
        window.whale.reportError(String(args[0] || ''), args.slice(1).join(' '));
      }
    } catch (e) {}
  }
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

  // 计时器环形进度条：与鲸鱼形象同位置同尺寸，计时进行中才可见
  var ringSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  ringSvg.setAttribute('viewBox', '0 0 100 100');
  ringSvg.setAttribute('class', 'dshwv-ring');
  var ringTrack = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  ringTrack.setAttribute('cx', '50'); ringTrack.setAttribute('cy', '50'); ringTrack.setAttribute('r', '46');
  ringTrack.setAttribute('class', 'dshwv-ring-track');
  var ringFill = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  ringFill.setAttribute('cx', '50'); ringFill.setAttribute('cy', '50'); ringFill.setAttribute('r', '46');
  ringFill.setAttribute('class', 'dshwv-ring-fill');
  // 周长 = 2πr ≈ 289.03
  var RING_CIRCUM = 2 * Math.PI * 46;
  ringFill.setAttribute('stroke-dasharray', String(RING_CIRCUM));
  ringFill.setAttribute('stroke-dashoffset', String(RING_CIRCUM));
  ringSvg.appendChild(ringTrack);
  ringSvg.appendChild(ringFill);

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
  // 面板是「对话框」而不是 menu/menuitem：里面是开关、下拉、滑块，套 menuitem 语义反而读不出来。
  // aria-modal：面板一开就借走焦点（见 toggleMenu 的 setInputFocus），菜单外的挂件本体此刻不可交互，
  // 声明成模态能让辅助技术在面板内循环读，而不是顺着 DOM 读到后面的挂件
  menuBox.setAttribute('role', 'dialog');
  menuBox.setAttribute('aria-modal', 'true');
  menuBox.setAttribute('aria-label', '挂件菜单');
  function menuLabel(text) { var s = document.createElement('span'); s.className = 'dshwv-menu-label'; s.textContent = text; return s; }
  function menuRow() { var r = document.createElement('div'); r.className = 'dshwv-menu-row'; return r; }
  // 组内说明行：灰底一句说明（menuHint）+ 蓝色一句怎么做（menuHintAct）。
  // 菜单里三处空态/提示（计时、专注、待办）早先各起一套 class，同一角色四种长相，
  // 缩进和字号也各调各的 —— 收敛成这一对唯一来源，各组只剩文案差异。
  function menuHint(text) { var d = document.createElement('div'); d.className = 'dshwv-menu-hint'; d.textContent = text; return d; }
  function menuHintAct(text) { var d = document.createElement('div'); d.className = 'dshwv-menu-hint-act'; d.textContent = text; return d; }

  // 菜单分组：**全部默认折叠，且每次打开菜单都重置成全折叠** —— 展开组合不落盘、不记忆，
  // 无论上次展开过哪一组，重新打开都回到「一屏可扫、每组标题都看得见」的收起态（见 toggleMenu）。
  // 这样菜单高度恒定、不会因为上次展开的组把别的组挤到折叠线以下。
  var menuGroupEls = {};

  // 菜单分组：点标题折叠/展开。
  // key：标识（menuGroupEls 的键）；onExpand：展开时的回调（dsh 组用它按需拉状态：收着时状态行看不见，不必白探一次端口）
  function menuGroup(key, title, onExpand) {
    var box = document.createElement('div');
    box.className = 'dshwv-group';
    var head = document.createElement('button');
    head.type = 'button';
    head.className = 'dshwv-group-head';
    head.title = title;
    var arrow = document.createElement('span');
    arrow.className = 'dshwv-group-arrow';
    var name = document.createElement('span');
    name.textContent = title;
    // 折叠态摘要（setSummary）：折叠时也能一眼看到这组的关键值（大小档位 / 余额 / 计时剩余），
    // 展开后隐藏 —— 展开时组内就有同一个数，再挂一份纯属重复
    var sum = document.createElement('span');
    sum.className = 'dshwv-group-sum';
    head.appendChild(arrow); head.appendChild(name); head.appendChild(sum);
    var bodyEl = document.createElement('div');
    bodyEl.className = 'dshwv-group-body';
    // 多包一层 inner：组体用 grid-template-rows 0fr↔1fr 做高度过渡，
    // 这个技巧要求 grid 只有「一个」子项 —— 各组的行数不同、且是逐个 append 进来的，
    // 直接放进 grid 会让每行各占一条轨道，0fr 只压得住第一行，收起时下面的行还露在外面。
    // 故 bodyEl（grid + overflow:hidden）里只放 inner，行统统 append 到 inner 里。
    var inner = document.createElement('div');
    inner.className = 'dshwv-group-inner';
    bodyEl.appendChild(inner);
    box.appendChild(head); box.appendChild(bodyEl);
    // 出厂即收起（展开态不落盘、不记忆，见上面的说明）
    var open = false;
    function apply() {
      box.classList.toggle('dshwv-group-open', open);
      // 展开/收起在 CSS 里用 grid-template-rows 0fr↔1fr 过渡（见 floating.css）。
      // 不再直接切 display：那样高度是瞬变的，positionMenu 重夹 maxHeight 时肉眼能看到跳一下
      arrow.textContent = open ? '▾' : '▸';
      // 摘要只在折叠态显示：展开后组内已有同一个数
      sum.style.display = open ? 'none' : '';
      head.setAttribute('aria-expanded', open ? 'true' : 'false');
      // 收起只是把 grid 压成 0fr + overflow:hidden，里面的控件仍在 DOM 里、仍能被 Tab 聚焦 ——
      // 按 Tab 会把焦点送进「看不见的」输入框（在 uTools 窗口里尤其明显）。
      // inert 一次性把整棵子树的聚焦与点击都停掉，比逐个 tabindex="-1" 稳妥
      try { inner.inert = !open; } catch (err) {}
    }
    head.addEventListener('click', function (e) {
      e.stopPropagation();
      open = !open;
      apply();
      // 不再 saveCfg()：展开态是纯展示态、不落盘（每次开菜单都重置，见 toggleMenu）
      if (open && typeof onExpand === 'function') { try { onExpand() } catch (err) {} }
      positionMenu(); // 高度变化后重新夹取，保证菜单始终在按钮上方
    });
    apply();
    var api = {
      el: box,
      // 暴露 inner：各组的行都 append 到这里（bodyEl 只是高度动画用的 grid 外壳）
      body: inner,
      setOpen: function (v) { open = !!v; apply(); },
      // 折叠态摘要：传空串即清掉。调用点见各组的刷新函数（render / timerStep / renderTodoMenu 等）
      setSummary: function (text) { sum.textContent = text || ''; },
      // 专注组用它切换标题（专注 / 计时）
      setTitle: function (t) { name.textContent = t || ''; head.title = t || '' },
    };
    menuGroupEls[key] = api;
    return api;
  }

  // 大小：菜单里只留滑块（原先滑块旁还挂一个 1–15 档位数字框，同一行两个控件冗余，
  // 精确输入去设置页「外观」）。滑块走整数档位 1–SCALE_STEPS，与设置页同一刻度；
  // 值经 numToScale 换算成倍率后推给宿主。
  var scaleInput = document.createElement('input');
  scaleInput.type = 'range';
  scaleInput.min = '1'; scaleInput.max = String(SCALE_STEPS); scaleInput.step = '1';
  scaleInput.className = 'dshwv-range';
  // 初值由 curScale（本地默认倍率）反推档位，不写死数字：写死会在改默认倍率 / 档位数后错位。
  // applyConfig 落地时会再校正一次，这里只保证首帧滑块与读数和 curScale 一致。
  var scaleNum0 = snapNum(curScale);
  scaleInput.value = String(scaleNum0);
  scaleInput.title = '挂件大小（1–' + SCALE_STEPS + ' 档，' + MIN_SCALE + '–' + MAX_SCALE + ' 倍，精确调整见设置页「外观」）';
  scaleInput.addEventListener('input', function () { setScale(scaleInput.value, false, false); });
  scaleInput.addEventListener('change', function () { setScale(scaleInput.value, false, true); });
  // 刻度点：给整数档提供视觉锚点。拖动中窗口不实时变（见 setScale 注释），
  // 靠它确认当前停在第几档。点亮规则与设置页「外观」一致（n <= 当前档位）。
  var scaleTicks = document.createElement('span');
  scaleTicks.className = 'dshwv-scaleticks';
  for (var ti = 0; ti < SCALE_STEPS; ti++) {
    var tick = document.createElement('i');
    scaleTicks.appendChild(tick);
  }
  function paintScaleTicks(n) {
    for (var i = 0; i < scaleTicks.children.length; i++) {
      if (i < n) scaleTicks.children[i].classList.add('on');
      else scaleTicks.children[i].classList.remove('on');
    }
  }
  // 滑块 + 刻度纵向成组：刻度贴在滑块正下方，与设置页同款布局
  var scaleWrap = document.createElement('span');
  scaleWrap.className = 'dshwv-scalewrap';
  scaleWrap.appendChild(scaleInput);
  scaleWrap.appendChild(scaleTicks);
  // 数值读数：滑块缩短后空出的位置放当前档位（与音量行的百分号同款）
  var scaleVal = document.createElement('span');
  scaleVal.className = 'dshwv-scaleval';
  scaleVal.textContent = String(scaleNum0);
  paintScaleTicks(scaleNum0);

  function soundOpt(value, label) { var o = document.createElement('option'); o.value = value; o.textContent = label; return o; }
  var soundSelect = document.createElement('select');
  soundSelect.className = 'dshwv-sound';
  soundSelect.title = '提示音音色（自定义需先在设置页导入）';
  soundSelect.appendChild(soundOpt('duck', '小黄鸭'));
  soundSelect.appendChild(soundOpt('fx1', '音效1'));
  soundSelect.appendChild(soundOpt('custom', '自定义'));
  soundSelect.addEventListener('change', function () { setSoundSet(soundSelect.value); });

  var OPACITY_PRESETS = [100, 80, 60, 40, 20];
  var opacitySelect = document.createElement('select');
  opacitySelect.className = 'dshwv-sound';
  opacitySelect.title = '挂件整体透明度';
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
  usageSelect.title = '余额按哪种口径统计（实时令牌需在设置页配平台 Token）';
  usageSelect.appendChild(soundOpt('ledger', '小鲸鱼记账 (推荐)'));
  usageSelect.appendChild(soundOpt('token', '实时·令牌 (需平台Token)'));
  usageSelect.addEventListener('change', function () { setUsageMode(usageSelect.value); });

  var peakSelect = document.createElement('select');
  peakSelect.className = 'dshwv-sound';
  peakSelect.title = '峰谷时段方案（决定何时算低谷价）';
  peakSelect.appendChild(soundOpt('default', '默认'));
  peakSelect.appendChild(soundOpt('liangwen', '梁文峰谷'));
  peakSelect.appendChild(soundOpt('qiangqiang', '!?强强?!'));
  peakSelect.addEventListener('change', function () { setPeakMode(peakSelect.value); });

  var bubbleToggle = document.createElement('input');
  bubbleToggle.type = 'checkbox';
  bubbleToggle.className = 'dshwv-check';
  bubbleToggle.checked = true;
  bubbleToggle.title = '开启/关闭思考气泡（关掉后挂件不再弹任何气泡：提醒、计时气泡与到点后的「休息 / 再来一轮」按钮都在气泡上）';
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
  timerSelect.title = '计时模式：正计时 / 倒计时 / 定时';
  timerSelect.appendChild(soundOpt('off', '关闭'));
  timerSelect.appendChild(soundOpt('up', '正计时'));
  timerSelect.appendChild(soundOpt('down', '倒计时'));
  timerSelect.appendChild(soundOpt('at', '定时'));
  timerSelect.addEventListener('change', function () { setTimerMode(timerSelect.value); });

  var timerBtn = document.createElement('button');
  timerBtn.type = 'button';
  timerBtn.className = 'dshwv-menu-link dshwv-timer-btn';
  timerBtn.textContent = '开始';
  timerBtn.title = '开始 / 暂停 / 继续当前计时';
  timerBtn.addEventListener('click', function (e) { e.stopPropagation(); timerBtnClick(); });

  // 重置：清掉进度回到未开始，模式保留。只在「计时中 / 暂停」时出现，集中放在读数行
  // （见 updateTimerStatus）—— 早先挂在「目标」行、倒计时与定时各一个，正计时跑起来后
  // 菜单里就没有任何清零入口了；空闲时本来也没有进度可清，跟着读数行一起显隐即可
  function makeResetBtn() {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'dshwv-menu-link dshwv-timer-reset';
    b.textContent = '重置';
    b.title = '清掉本次计时进度（模式保留）';
    b.addEventListener('click', function (e) {
      e.stopPropagation();
      // 已经专注一会儿的轮次直接清零太可惜：过 1 分钟先问一句（<1 分钟/休息轮不值得打扰）
      requestTimerDiscard(function () { resetTimer(); });
    });
    return b;
  }
  var timerResetBtn = makeResetBtn();

  // 倒计时目标：时 / 分 / 秒 三段（上限 23:59:59）。
  // 三段互不钳制 —— 50 分、80 秒都允许输入，startTimer 里统一折算成秒数，避免「填 90 分要自己换成 1 时 30 分」
  // 菜单输入统一「回车才生效」：change 事件是随输入/失焦触发的，边打字边改目标
  // 会让数字框打一半（如「2」→「25」）就被钳制回填，光标位置也跟着跳。
  // 改为显式提交：回车提交并失焦回显，blur 也提交一次（点到菜单别处不该丢掉这次编辑）。
  // 组字守卫：中文输入法组字期间按 Enter 是「确认候选词」，isComposing/229 时不能当「提交」处理，
  // 否则打着字候选词一确认，倒计时时长就被提交了（参考 DSH 网页版的同类踩坑）
  function commitOnEnter(el, commit) {
    el.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      if (e.isComposing || e.keyCode === 229) return;
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
    // 只改「这一轮」的目标：不落盘（默认时长由设置页写），刷新芯片高亮与折叠摘要即可
    commitOnEnter(el, function () { syncTimerQuick(); refreshMenuSummaries(); });
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
  // 定时刻仍落盘：设置页没有这个字段，重载后沿用上次的时刻最省事。
  // 它和「默认时长」是两回事（一个时刻、一个时长），不会与设置页的默认值互相覆盖
  commitOnEnter(timerTime, function () {
    var at = String(timerTime.value || '');
    if (/^\d{1,2}:\d{2}$/.test(at)) {
      cfgTimerAtSeen = at;
      saveCfg({ timerAt: at });
    }
    refreshMenuSummaries();
  });

  // 到点通知 / 提醒停留 / 气泡常驻 / 只显计时 / 留言 / 休息档：全是「设一次、长期生效」的配置，
  // 菜单里不再各摆一份开关（两处入口两套回填，最容易出现「这边关了那边还开着」）。
  // 页面保留本地副本（到点通知、气泡停留与「休息 N 分钟」按钮要用），由 applyConfig 回推；
  // 想改去设置页「计时」卡，菜单底部留了一个直达入口。

  var volInput = document.createElement('input');
  volInput.type = 'range';
  volInput.min = '0'; volInput.max = '1'; volInput.step = '0.05';
  volInput.className = 'dshwv-range'; volInput.value = '0.9';
  volInput.title = '提示音音量';
  var volPct = document.createElement('span');
  volPct.className = 'dshwv-volpct';
  volPct.textContent = '90%';
  volInput.addEventListener('input', function () { setVol(volInput.value, false); });
  volInput.addEventListener('change', function () { setVol(volInput.value, true); });

  // 菜单里的控件都没有可见 <label>（同行那个只是 span），补可访问名：
  // title 只在悬停时可见，辅助技术读的是 aria-label
  [
    [scaleInput, '大小'],
    [soundToggle, '音效开关'], [soundSelect, '音色'], [volInput, '音量'],
    [opacitySelect, '透明度'], [usageSelect, '用量口径'], [peakSelect, '峰谷方案'],
    [bubbleToggle, '思考气泡'], [remindToggle, '峰谷提醒'],
    [timeToggle, '气泡报时'], [lockToggle, '锁定位置'],
    [timerSelect, '计时模式'], [timerHour, '倒计时小时'], [timerMin, '倒计时分钟'], [timerSec, '倒计时秒'],
    [timerTime, '定时时刻'],
  ].forEach(function (pair) {
    pair[0].setAttribute('aria-label', pair[1]);
  });

  var row1 = menuRow();
  row1.appendChild(menuLabel('大小')); row1.appendChild(scaleWrap); row1.appendChild(scaleVal);
  var row2 = menuRow();
  row2.appendChild(menuLabel('音效')); row2.appendChild(soundToggle); row2.appendChild(soundSelect);
  var row3 = menuRow();
  row3.appendChild(menuLabel('音量')); row3.appendChild(volInput); row3.appendChild(volPct);
  var rowOpacity = menuRow();
  rowOpacity.appendChild(menuLabel('透明度')); rowOpacity.appendChild(opacitySelect);
  // 余额条：**置顶常显，不进任何折叠组**。余额是最高频的信息（「我还有多少钱」），
  // 藏在第二层要点两下才看得到；主显示换成别的模型时它也跟着换口径（mainAmountText），
  // 所以不参与「DeepSeek 专属行收起」那套逻辑
  var rowBalanceTop = menuRow();
  rowBalanceTop.classList.add('dshwv-menu-toprow');
  // 标签跟着主显示类型走（余额 / 剩余额度 / 今日 token）：写死「余额」时，
  // 额度型主显示会出现「余额 62%」——说的和显示的不是一回事
  var menuBalanceLabelEl = menuLabel('余额');
  rowBalanceTop.appendChild(menuBalanceLabelEl);
  var menuBalanceEl = document.createElement('span');
  menuBalanceEl.className = 'dshwv-model-val';
  menuBalanceEl.textContent = '--';
  rowBalanceTop.appendChild(menuBalanceEl);
  // 金额遮蔽的一键入口：余额条右侧的小眼睛（点挂件主体上的数字也能切，见 amountEl 的 click）。
  // 放在这条常显行里而不是某个折叠组：有人凑过来看屏幕时，用户要能在 0.5 秒内点掉金额
  var maskBtn = document.createElement('button');
  maskBtn.type = 'button';
  maskBtn.className = 'dshwv-mask-btn';
  maskBtn.setAttribute('aria-label', '遮蔽金额');
  maskBtn.setAttribute('aria-pressed', 'false');
  rowBalanceTop.appendChild(maskBtn);
  var EYE_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M1.8 12s3.7-6.3 10.2-6.3S22.2 12 22.2 12s-3.7 6.3-10.2 6.3S1.8 12 1.8 12z"/><circle cx="12" cy="12" r="3.1"/></svg>';
  var EYE_OFF_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M1.8 12s3.7-6.3 10.2-6.3S22.2 12 22.2 12s-3.7 6.3-10.2 6.3S1.8 12 1.8 12z"/><circle cx="12" cy="12" r="3.1"/><path d="M3 3l18 18"/></svg>';
  maskBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    toggleHideAmounts();
  });
  updateMaskBtnUi();
  // 穿透中的逃生行：鼠标穿透开着时，挂件本体点不动，只能靠「在鲸鱼上停约 1 秒」临时接管才点得开菜单；
  // 菜单一关又得重来一遍。所以在菜单里给一条「关闭穿透」的直达入口 —— 不用去设置页翻「窗口」Tab
  var rowPass = menuRow();
  rowPass.classList.add('dshwv-menu-passrow');
  rowPass.appendChild(menuLabel('穿透中'));
  var passOffBtn = document.createElement('button');
  passOffBtn.type = 'button';
  passOffBtn.className = 'dshwv-menu-link';
  passOffBtn.textContent = '关闭穿透';
  passOffBtn.title = '立即关闭鼠标穿透（与设置页「窗口 → 鼠标穿透」是同一个开关）';
  // 保存失败时不能让按钮永久卡在「关闭中…」：宿主若没回推配置，3 秒后自己复原
  var passOffTimer = null;
  passOffBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    // 不做「乐观隐藏」：保存失败时行若已消失，用户就失去了这个逃生入口
    passOffBtn.disabled = true;
    passOffBtn.textContent = '关闭中…';
    whaleApi.saveConfig({ passThrough: false });
    if (passOffTimer) clearTimeout(passOffTimer);
    passOffTimer = setTimeout(function () {
      passOffTimer = null;
      syncPassRow(passThroughOn);
    }, 3000);
  });
  rowPass.appendChild(passOffBtn);
  rowPass.style.display = 'none'; // 默认不显示，穿透开启时由 syncPassRow 放出
  // 逃生行的显隐与按钮态：只认「当前穿透是否开着」这一个事实，每次 applyConfig 都刷一遍
  function syncPassRow(on) {
    if (passOffTimer) { clearTimeout(passOffTimer); passOffTimer = null; }
    rowPass.style.display = on ? '' : 'none';
    passOffBtn.disabled = false;
    passOffBtn.textContent = '关闭穿透';
  }
  var row4 = menuRow();
  row4.appendChild(menuLabel('用量')); row4.appendChild(usageSelect);
  var row5 = menuRow();
  row5.appendChild(menuLabel('峰谷')); row5.appendChild(peakSelect);
  var row6 = menuRow();
  row6.appendChild(menuLabel('气泡')); row6.appendChild(bubbleToggle);
  // 「气泡设置」独立成行：它是个跳转按钮，和开关塞在同一行时长得像第二个开关，点错率不低
  var rowBubbleSet = menuRow();
  rowBubbleSet.appendChild(menuLabel('气泡内容'));
  // 「气泡设置」：悬浮窗里没有好的文字/结构编辑环境（自定义泡泡是行×模块 + 占位符 + 预览的复杂编辑器），
  // 直接跳到设置页「外观 → 按压气泡（自定义泡泡）」卡
  var bubbleSettingsBtn = document.createElement('button');
  bubbleSettingsBtn.type = 'button';
  bubbleSettingsBtn.className = 'dshwv-menu-link';
  bubbleSettingsBtn.textContent = '气泡设置';
  bubbleSettingsBtn.title = '打开设置页的「按压气泡」卡，编辑点击气泡要显示的内容';
  bubbleSettingsBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    closeMenu();
    openSettings('bubble');
  });
  rowBubbleSet.appendChild(bubbleSettingsBtn);
  var rowRemind = menuRow();
  rowRemind.appendChild(menuLabel('峰谷提醒')); rowRemind.appendChild(remindToggle);
  // 余额快捷操作：刷新（跳过缓存立即拉取）+ 复制当前余额到剪贴板
  var rowBalanceActions = menuRow();
  var refreshBalanceBtn = document.createElement('button');
  refreshBalanceBtn.type = 'button';
  refreshBalanceBtn.className = 'dshwv-menu-link';
  refreshBalanceBtn.textContent = '刷新余额';
  // 两只刷新按钮并排出现时（模型组展开），光看文字「刷新余额 / 刷新全部」分不清范围。
  // title 里写清「只刷哪一路」：本按钮只发 DeepSeek 余额那一条，模型组的才连全部模型一起刷
  refreshBalanceBtn.title = '跳过缓存，只立刻刷新 DeepSeek 余额（其它模型点「刷新全部」）';
  // 「刷新中…」的置位 / 复位 / 超时兜底都在余额一节的 setRefreshBtnBusy 里
  // （按钮态与挂件本体呼吸圈同一时刻收尾，不各写一套定时器）；点按钮统一走 refresh(true)
  refreshBalanceBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    // 走 refresh(true) 而不是直接 whaleApi.refresh：挂件本体上的「刷新中」呼吸圈也要亮起来
    // （只发 IPC 的话，点了刷新在挂件上、甚至在这只按钮上，除了「刷新中…」没有任何进行中的观感）
    refresh(true);
  });
  var copyBalanceBtn = document.createElement('button');
  copyBalanceBtn.type = 'button';
  copyBalanceBtn.className = 'dshwv-menu-link';
  // 文案跟着主显示的「名分」走（余额 / 额度 / token），初值只是 DeepSeek 默认态，
  // 切到别的模型时由 applyModelVisibility 改写
  copyBalanceBtn.textContent = '复制余额';
  copyBalanceBtn.title = '复制当前余额数字到剪贴板';
  // 复制后的临时态（已复制 / 复制失败）期间不许被 applyModelVisibility 回写冲掉
  var copyBtnBusy = false;
  copyBalanceBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    var text = withRealAmounts(mainAmountText);
    // 页面没有 utools 全局，复制统一走 preload 暴露的 whaleApi.copyText（同步返回是否成功）
    var ok = false;
    try { ok = whaleApi.copyText ? !!whaleApi.copyText(text) : false } catch (err) { ok = false }
    copyBtnBusy = true;
    copyBalanceBtn.textContent = ok ? '已复制' : '复制失败';
    // 复原文案同样走动态名分：主显示若是额度型，不能恢复成「复制余额」
    setTimeout(function () {
      copyBtnBusy = false;
      copyBalanceBtn.textContent = copyAmountLabel();
    }, 1500);
  });
  rowBalanceActions.appendChild(refreshBalanceBtn);
  rowBalanceActions.appendChild(copyBalanceBtn);
  // 「用量明细」：这一组的数字（今日已用 / 额度）都来自账本，看完数字最常见的下一步就是
  // 「钱花哪了」。菜单里其余数据组都有回设置页的入口（气泡设置 / 专注设置 / 待办管理），
  // 这一组不该缺 —— 否则用户想看得细一点，只能自己想到「打开设置」再翻到「用量」Tab
  var usageDetailBtn = document.createElement('button');
  usageDetailBtn.type = 'button';
  usageDetailBtn.className = 'dshwv-menu-link';
  usageDetailBtn.textContent = '用量明细';
  usageDetailBtn.title = '打开设置页的「用量与账本」卡（趋势 / 本月汇总 / 账本明细）';
  usageDetailBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    closeMenu();
    openSettings('usage');
  });
  rowBalanceActions.appendChild(usageDetailBtn);
  var row7 = menuRow();
  row7.appendChild(menuLabel('报时')); row7.appendChild(timeToggle);
  var rowTimer = menuRow();
  rowTimer.appendChild(menuLabel('计时')); rowTimer.appendChild(timerSelect); rowTimer.appendChild(timerBtn);
  // 当前行：计时中 / 暂停时显示「任务名 + 读数 + 暂停 + 重置」；
  // 空闲但已有专注任务时显示「当前 + 任务名 + 开始」。放在合并组最上面，
  // 不用滚到下面的计时块就能暂停 / 重置。
  var rowTimerStatus = menuRow();
  rowTimerStatus.classList.add('dshwv-focus-current');
  var timerStatusLabel = menuLabel('剩余');
  var timerStatusTask = document.createElement('span');
  timerStatusTask.className = 'dshwv-focus-task';
  timerStatusTask.style.display = 'none';
  var timerStatusVal = document.createElement('span');
  timerStatusVal.className = 'dshwv-timer-readout';
  timerStatusVal.textContent = '00:00';
  var timerCurrentBtn = document.createElement('button');
  timerCurrentBtn.type = 'button';
  timerCurrentBtn.className = 'dshwv-menu-link dshwv-timer-current';
  timerCurrentBtn.textContent = '暂停';
  timerCurrentBtn.title = '暂停 / 继续当前计时';
  timerCurrentBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    if (timerRunning) { pauseTimer(); return; }
    if (timerPaused) { resumeTimer(); return; }
    var it = todoFocusItem();
    if (it) startTodoTimer(it);
  });
  rowTimerStatus.appendChild(timerStatusLabel);
  rowTimerStatus.appendChild(timerStatusTask);
  rowTimerStatus.appendChild(timerStatusVal);
  rowTimerStatus.appendChild(timerCurrentBtn);
  rowTimerStatus.appendChild(timerResetBtn);
  rowTimerStatus.style.display = 'none';
  // 目标输入框：计时中 / 暂停时锁住（见 lockTimerTargets）
  var timerTargets = [timerHour, timerMin, timerSec, timerTime];
  // 「目标」拆成两个互斥子行（倒计时 / 定时各一行）：
  // 原先两种输入挤在同一行、靠 display 二选一，但另一样虽看不见仍占着 flex 位置，
  // 切模式时行宽不变、白白吃掉一块；拆开后每行都只放自己那套控件。
  // 两行按当前模式二选一显隐（正计时 / 关闭时两行都收起，见 syncTimerMenu）
  var rowTimerDown = menuRow();
  rowTimerDown.appendChild(menuLabel('目标'));
  rowTimerDown.appendChild(timerHour); rowTimerDown.appendChild(timerSegUnits[0]);
  rowTimerDown.appendChild(timerMin); rowTimerDown.appendChild(timerSegUnits[1]);
  rowTimerDown.appendChild(timerSec); rowTimerDown.appendChild(timerSegUnits[2]);
  var rowTimerAt = menuRow();
  rowTimerAt.appendChild(menuLabel('目标'));
  rowTimerAt.appendChild(timerTime);
  // 放弃确认：重置 / 切模式 / 换一条待办都会丢掉当前进度。内联在菜单里而不是弹系统对话框——
  // 悬浮窗是独立置顶窗，系统对话框会抢焦点、把菜单顶掉，还得再找回来。
  // 只在「非休息轮 + 已专注 ≥1 分钟」时出现：刚开始的几秒和休息轮没什么好可惜的
  var rowTimerConfirm = document.createElement('div');
  rowTimerConfirm.className = 'dshwv-timer-confirm';
  rowTimerConfirm.style.display = 'none';
  var timerConfirmText = document.createElement('div');
  timerConfirmText.className = 'dshwv-timer-confirm-text';
  var timerConfirmRow = document.createElement('div');
  timerConfirmRow.className = 'dshwv-timer-confirm-row';
  var timerConfirmAbortBtn = document.createElement('button');
  timerConfirmAbortBtn.type = 'button';
  timerConfirmAbortBtn.className = 'dshwv-timer-confirm-btn dshwv-timer-confirm-abort';
  timerConfirmAbortBtn.textContent = '放弃本轮';
  timerConfirmAbortBtn.title = '丢掉这一轮的进度：按实际专注分钟记账，但不算完成一轮';
  timerConfirmAbortBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    confirmTimerDiscard();
  });
  var timerConfirmKeepBtn = document.createElement('button');
  timerConfirmKeepBtn.type = 'button';
  timerConfirmKeepBtn.className = 'dshwv-timer-confirm-btn';
  timerConfirmKeepBtn.textContent = '继续计时';
  timerConfirmKeepBtn.title = '不放弃，回到当前这一轮';
  timerConfirmKeepBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    cancelTimerConfirm();
  });
  timerConfirmRow.appendChild(timerConfirmAbortBtn);
  timerConfirmRow.appendChild(timerConfirmKeepBtn);
  rowTimerConfirm.appendChild(timerConfirmText);
  rowTimerConfirm.appendChild(timerConfirmRow);
  // 快捷时长四档：比「选倒计时 → 改三段输入框 → 点开始」少三步，覆盖绝大多数番茄钟时长；
  // 自定义时长仍走下面的目标输入框。档位由设置页决定（cfg.timerPresets），菜单只建 4 个空壳。
  // 点击时读自身 data-min、不在闭包里捕获创建时的分钟数 —— 若按旧值开始，
  // 设置页把档位改完之后就会出现「按钮写着 30 分、计时却跑 45 分」
  var rowTimerQuick = menuRow();
  rowTimerQuick.appendChild(menuLabel('快捷'));
  var timerChips = document.createElement('div');
  timerChips.className = 'dshwv-timer-chips';
  var timerChipEls = [];
  for (var qi = 0; qi < TIMER_PRESETS_DEFAULT.length; qi++) {
    var chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'dshwv-timer-chip';
    chip.textContent = TIMER_PRESETS_DEFAULT[qi] + ' 分';
    chip.title = '倒计时 ' + TIMER_PRESETS_DEFAULT[qi] + ' 分钟并立即开始';
    chip.setAttribute('data-min', String(TIMER_PRESETS_DEFAULT[qi]));
    chip.addEventListener('click', function (e) {
      e.stopPropagation();
      quickStartTimer(Number(this.getAttribute('data-min')) || 0);
    });
    timerChips.appendChild(chip);
    timerChipEls.push(chip);
  }
  rowTimerQuick.appendChild(timerChips);
  // 「只显计时」开着时，计时气泡里只有时间、看不到余额 —— 这是最常被问的一句
  //（设置页那段说明普通用户翻不到，帮助页更不会去翻）。给一行提示，
  // 只在「计时中 / 暂停」且「只显计时」开着时出现：其余时候双击本来就没有特殊行为，写了反而误导
  var rowTimerPeekHint = menuHint('计时中双击小鲸鱼，可临时看一眼余额');
  rowTimerPeekHint.style.display = 'none';
  function syncTimerPeekHint() {
    var show = timerBubbleOnly && (timerRunning || timerPaused);
    rowTimerPeekHint.style.display = show ? '' : 'none';
  }
  // 计时设置：默认时长 / 快捷档位 / 到点提醒 / 番茄循环都收在设置页。
  // 菜单只负责「这一轮」怎么跑；开启专注 / 待办后这只按钮直达合并卡。
  var rowTimerFoot = menuRow();
  var timerSettingsBtn = document.createElement('button');
  timerSettingsBtn.type = 'button';
  timerSettingsBtn.className = 'dshwv-menu-link';
  timerSettingsBtn.textContent = '计时设置';
  timerSettingsBtn.title = '打开设置页的「计时」卡（默认时长、快捷档位、到点提醒、番茄循环）';
  timerSettingsBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    closeMenu();
    openSettings(todoOn ? 'focus' : 'timer');
  });
  rowTimerFoot.appendChild(timerSettingsBtn);
  var row8 = menuRow();
  row8.appendChild(menuLabel('锁定')); row8.appendChild(lockToggle);
  var row9 = menuRow();
  var settingsBtn = document.createElement('button');
  settingsBtn.type = 'button';
  settingsBtn.className = 'dshwv-menu-link';
  settingsBtn.textContent = '打开设置';
  settingsBtn.title = '打开设置页（外观 / 通知 / 数据等都在那里）';
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
  // 但用户未必知道路径）→ 首次点击只进确认态，5s 内再点一次才真隐藏。
  // 取 5s 而不是更短的 3s：确认态出现后用户要「读到文字 → 确认这是自己想点的 → 再挪回来点」，
  // 3s 时手稍慢就白点一次，还容易被当成「点了没反应」
  var hideConfirmTimer = null;
  function resetHideBtn() {
    if (hideConfirmTimer) { clearTimeout(hideConfirmTimer); hideConfirmTimer = null; }
    hideBtn.classList.remove('dshwv-menu-link-warn');
    hideBtn.textContent = '隐藏挂件';
    hideBtn.title = '隐藏挂件（设置页「显示挂件」或切换挂件快捷键可再次唤出）';
  }
  hideBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    if (!hideConfirmTimer) {
      hideBtn.classList.add('dshwv-menu-link-warn');
      hideBtn.textContent = '再点一次隐藏';
      // 确认态里把回退路径也写进 title：此刻用户最担心的就是「藏没了怎么找回来」
      hideBtn.title = '再点一次即隐藏；藏起来后可在设置页点「显示挂件」，或按切换挂件快捷键唤回（5 秒后自动取消）';
      hideConfirmTimer = setTimeout(resetHideBtn, 5000);
      return;
    }
    resetHideBtn();
    closeMenu();
    // 唯一动作，失败必须留痕：否则用户点了「隐藏」没反应却查不到原因
    try { whaleApi.hideWidget(); } catch (err) { logErr('[whale][floating] 隐藏挂件失败', err && err.message); }
  });
  row9.appendChild(hideBtn);
  row9.classList.add('dshwv-menu-foot');

  // —— dsh（DeepSeek Harness，开发者）：启动 / 重启 / 结束 + 打开页面 + 状态 ——
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
  var dshOpenBtn = dshBtn('打开页面', 'open', '在系统浏览器打开 dsh 页面（自动使用 dsh 打印的带 token 地址，避免提示需要认证）');
  var rowDsh = menuRow();
  rowDsh.appendChild(menuLabel('dsh'));
  rowDsh.appendChild(dshStartBtn); rowDsh.appendChild(dshRestartBtn);
  rowDsh.appendChild(dshStopBtn);
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

  // 分组：全部默认折叠，每次打开菜单都重置为全折叠（见 toggleMenu），菜单高度恒定。
  // look 组 8 行（大小 / 音效 / 音量 / 透明度 / 气泡 / 气泡内容 / 报时 / 锁定），
  // 一次铺开会把菜单塞满，故与其他组一样收起、想用再点开
  var groupLook = menuGroup('look', '外观与音效');
  groupLook.body.appendChild(row1); groupLook.body.appendChild(row2); groupLook.body.appendChild(row3);
  groupLook.body.appendChild(rowOpacity);
  groupLook.body.appendChild(row6); groupLook.body.appendChild(rowBubbleSet);
  groupLook.body.appendChild(row7); groupLook.body.appendChild(row8);
  // 组名保留「余额」：余额条虽已置顶常显，但这一组里还有「用量 / 峰谷」，
  // 叫「用量与峰谷」时用户仍会把它当成「管数字的地方」
  var groupUsage = menuGroup('usage', '余额与用量');
  groupUsage.body.appendChild(row4); groupUsage.body.appendChild(row5);
  groupUsage.body.appendChild(rowRemind);
  groupUsage.body.appendChild(rowBalanceActions);
  // 唯一的「专注」组：今日 / 当前 / 放弃确认 / 待办 / 计时 / 底部入口在下方统一装配。
  // 展开态一次解决「选任务 → 开始 → 暂停」，不再跨两个组。
  var groupFocus = menuGroup('focus', '专注');
  // 到点接力状态：null = 未进入接力。具体行为见 timerTodoBtn / timerHandoff 相关函数；
  // 提前声明是因为折叠摘要要先读它。
  var timerHandoff = null;
  // 完成标记的延迟校验：宿主没有回执，等回推后再确认这条真的完成了
  var handoffVerifyTimer = null;
  // dsh 是面向开发者的功能，但打包版同样要有 —— 早先按 window.whale.dev 建组，
  // 结果正式安装的 .upx 里开发者模式默认关闭，这一节整个消失（连 DOM 都没有）。
  // 现在无条件建组，再用「这台机器上有没有 dsh」决定显隐：探测到已安装（source 非空）
  // 或正在运行（running / external）才显示，没装过 dsh 的普通用户依旧看不到这一节。
  // 初始先藏起来，等首帧探测结果回来再决定 —— 否则没装 dsh 的用户会看到它闪一下
  var groupDsh = menuGroup('dsh', 'dsh', function () { dshSend('status') });
  groupDsh.body.appendChild(rowDsh); groupDsh.body.appendChild(rowDshPage);
  groupDsh.body.appendChild(rowDshState); groupDsh.body.appendChild(rowDshCmd);
  groupDsh.el.style.display = 'none';

  // —— 折叠态摘要 ——
  // 菜单收起时只有 7 个组名，什么值都看不到；给每组挂一句「现在是多少」，
  // 折叠态就有信息量（多大 / 今天用了多少 / 还剩多久 / 几条待办）。
  // 用缓存挡住重复写入：计时每秒都会调一次，textContent 赋值会触发重排，不该白做
  var summaryCache = {};
  function setGroupSummary(api, key, text) {
    text = text || '';
    if (summaryCache[key] === text) return;
    summaryCache[key] = text;
    api.setSummary(text);
  }
  // 组标题 / 底部入口：总开关开启时是「专注」枢纽，纯计时才叫「计时」。
  // 缓存 key 挡住每秒刷新时的无谓 DOM 写入。
  var focusChromeKey = '';
  function syncFocusGroupChrome() {
    var hub = todoOn;
    var key = hub ? 'hub' : 'timer';
    if (focusChromeKey === key) return;
    focusChromeKey = key;
    groupFocus.setTitle(hub ? '专注' : '计时');
    timerSettingsBtn.textContent = hub ? '专注与待办设置' : '计时设置';
    timerSettingsBtn.title = hub
      ? '在设置页管理专注记录、待办与计时默认值'
      : '在设置页配置计时默认值（默认时长、快捷档位、到点提醒、番茄循环）';
  }
  function refreshMenuSummaries() {
    setGroupSummary(groupLook, 'look', snapNum(curScale) + ' 档 · ' + opacityPct + '%');
    // 今日用量未知（实时·令牌口径下平台接口没给）时写「--」而不是 ¥0.00：
    // 挂件第三行同场景就是「今日已用 --」，两边口径要一致，否则菜单会把「没拿到」说成「今天没花钱」
    var usedSum = (state.todayUsage === null || state.todayUsage === undefined)
      ? '--' : fmt(Number(state.todayUsage), state.currency);
    setGroupSummary(groupUsage, 'usage', state.balance === null ? '' : '今日 ' + usedSum);
    // 计时摘要必须带「已用 / 剩 / 休息 / 暂停」前缀：光一个 12:34 读不出是已用还是剩余。
    // 空闲时也要有信息量：菜单收起后看不到「下一轮会跑多久」，这里直接写出来 ——
    // 倒计时写本轮目标，定时写时刻，关闭态写设置页的默认时长（「默认 25 分」）
    var timerSum = '';
    if (timerActive()) {
      if (timerFinished) timerSum = '到点';
      else {
        var head = timerPaused ? '暂停 ' : (timerIsBreak ? '休息 ' : (timerMode === 'up' ? '已用 ' : '剩 '));
        timerSum = head + fmtClock(timerRemainMs());
      }
    } else if (timerMode === 'at') {
      timerSum = '定时 ' + (timerTime.value || '--');
    } else if (timerMode === 'down') {
      timerSum = Math.max(1, Math.round(timerSegTotalSec() / 60)) + ' 分';
    } else if (timerMode === 'up') {
      timerSum = '正计时';
    } else {
      timerSum = '默认 ' + Math.max(1, Math.round((cfgTimerSecSeen || TIMER_MIN_DEFAULT * 60) / 60)) + ' 分';
    }
    // 合并组：先给任务 / 清单条数，纯计时才落回默认时长。
    // 时间放在任务名前（如「剩 12:34 · 写周报」）：摘要 104px 截断时先保时间。
    var focusItem = todoFocusItem();
    var focusText = focusItem ? String(focusItem.text || '') : '';
    if (timerHandoff) {
      timerSum = '任务完成';
    } else if (timerActive() && !timerFinished && !timerIsBreak && focusText) {
      timerSum += ' · ' + focusText;
    } else if (!timerActive() && focusText) {
      timerSum = focusText;
    } else if (!timerActive() && todoOn) {
      var todoLeft = 0;
      var todoAll = (todoState && todoState.items) || [];
      for (var ti = 0; ti < todoAll.length; ti++) if (!todoAll[ti].done) todoLeft++;
      // v1.16 起不再拼「今日 N 轮」：挂件的专注统计层已下线，摘要只说还剩几项
      if (todoLeft > 0) timerSum = todoLeft + ' 项';
    }
    setGroupSummary(groupFocus, 'focus', timerSum);
    setGroupSummary(groupModels, 'models', models.length > 1 ? models.length + ' 个' : '');
    syncFocusGroupChrome();
  }

  // —— 待办清单：设置页负责增删改，挂件里可直接开始 / 勾选 / 快速添加 ——
  // 清单常驻在「专注」组里：专注时最想看到的就是「现在做哪条、还剩几条」
  // 「专注与待办」唯一开关（v1.15 合并了原先的 focusOn / todoOn）：挂件里的待办块与计时记录
  // 都只看它。任务开始 / 气泡任务名 / 到点「完成这条」不受它门控（见 2026-11-01 spec）。
  // v1.16 起挂件的专注统计层（今日轮数 / 每日目标进度 / 连续天数 / 近 7 天）整体下线，
  // 只留待办本身；宿主侧 focus.js 与 whale:focus 暂留不动（数据不丢、可逆）
  var todoOn = false;
  var todoState = { items: [], focusId: '' };
  // 本次菜单里刚勾掉的条目：勾完仍留在原位置灰，手滑了点错能马上撤回；
  // 下次打开菜单清空（见 toggleMenu），勾掉的就不再见 —— 挂件只服务「现在要做什么」，
  // 回看 / 清理已完成交给设置页，免得清单越用越长、把待办挤出滚动区
  var todoJustDone = {};
  // 行内编辑态：同一条目同时只开一个编辑器（'id' + 哪个字段在改）。
  // 编辑态只活在页面内存里，重开菜单即清空；取消编辑不做任何上报
  var todoEdit = null;

  // 待办块：挂件里直接开始 / 勾选 / 快速添加 / 编辑（编辑实体在 floating-todo-edit.js）
  var rowTodoAdd = menuRow();
  var todoAddInput = document.createElement('input');
  todoAddInput.type = 'text';
  todoAddInput.className = 'dshwv-todo-add';
  todoAddInput.placeholder = '添加待办，回车保存';
  todoAddInput.title = '添加待办，回车保存';
  todoAddInput.setAttribute('aria-label', '添加待办');
  // 同宿主 constants.js 的 TODO_TEXT_MAX（悬浮页拿不到宿主常量）：宿主也会按同一上限截断
  todoAddInput.maxLength = 60;
  // 待办条数上限：由宿主随 init 下发（单一来源仍是 constants.js 的 TODO_MAX，页面不抄副本）。
  // 满额时宿主会**直接丢弃** add 且不回任何消息 —— 页面若不先拦一下，用户打完字按回车，
  // 输入框清空、清单里却没有这条，看起来就是「加了但没生效」。拦在前面给一句气泡，并保留输入内容
  var todoMax = 0;
  // 提交一条待办：回车与「添加」按钮共用。返回是否已提交（未提交时保留输入框里的内容）
  function submitTodoAdd() {
    var text = todoAddInput.value.trim();
    if (!text) return false;
    if (todoMax > 0 && ((todoState && todoState.items) || []).length >= todoMax) {
      // 用户主动动作，计时中也照常反馈（force）；到点态不抢动作条（同 showRemindBubble 的口径）
      showRemindBubble([
        { t: '待办已满', s: 'A', c: '#e0433f' },
        { t: '最多 ' + todoMax + ' 条', s: 'P', c: '' },
        { t: '先在设置页清掉一些', s: 'C', c: '', w: true },
      ], !timerFinished);
      return false;
    }
    try { whaleApi.todoSend({ op: 'add', text: text }); } catch (_) {}
    todoAddInput.value = '';
    return true;
  }
  todoAddInput.addEventListener('keydown', function (e) {
    e.stopPropagation();
    // 组字守卫与 commitOnEnter 同口径：中文输入法里按 Enter 是「确认候选词」，
    // 只判 isComposing 不够（个别输入法此刻 keyCode 仍是 229），否则会把半截词当成待办提交
    if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      submitTodoAdd();
    }
    if (e.key === 'Escape') { e.preventDefault(); todoAddInput.blur(); }
  });
  todoAddInput.addEventListener('click', function (e) { e.stopPropagation(); });
  var todoAddBtn = document.createElement('button');
  todoAddBtn.type = 'button';
  todoAddBtn.className = 'dshwv-menu-link dshwv-todo-add-btn';
  todoAddBtn.textContent = '添加';
  todoAddBtn.title = '添加这条待办';
  todoAddBtn.setAttribute('aria-label', '添加待办');
  todoAddBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    if (submitTodoAdd()) todoAddInput.focus();
  });
  rowTodoAdd.appendChild(todoAddInput);
  rowTodoAdd.appendChild(todoAddBtn);
  var todoListEl = document.createElement('div');
  todoListEl.className = 'dshwv-todo';
  var rowTodoFoot = menuRow();
  // 清除已完成：一键清理所有已勾选的待办项。待办管理入口统一在组底部「专注与待办设置」，
  // 这里不再重复放一个管理按钮。
  var todoClearDoneBtn = document.createElement('button');
  todoClearDoneBtn.type = 'button';
  todoClearDoneBtn.className = 'dshwv-menu-link dshwv-menu-link-2nd';
  todoClearDoneBtn.textContent = '清除已完成';
  todoClearDoneBtn.title = '一键清除所有已完成的待办项';
  todoClearDoneBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    var all = (todoState && todoState.items) || [];
    var doneCount = all.filter(function (it) { return it.done; }).length;
    if (doneCount === 0) {
      showRemindBubble([
        { t: '没有已完成的待办', s: 'A', c: '#8a95b5' },
        { t: '所有待办项都还未完成', s: 'P', c: '' },
        { t: '继续加油！', s: 'C', c: '', w: true },
      ]);
      return;
    }
    try { whaleApi.todoSend({ op: 'clearDone' }); } catch (_) {}
    showRemindBubble([
      { t: '已清除 ' + doneCount + ' 项', s: 'A', c: '#2fa24c' },
      { t: '完成的待办已移除', s: 'P', c: '' },
      { t: '清单已更新', s: 'C', c: '', w: true },
    ]);
  });
  rowTodoFoot.appendChild(todoClearDoneBtn);
  rowTodoFoot.style.display = 'none';
  var todoBlock = document.createElement('div');
  todoBlock.className = 'dshwv-focus-todo';
  // 下面先按「未折叠」的顺序挂一遍，再被折叠结构整体接管（测试也按这两步钉住）
  todoBlock.appendChild(rowTodoAdd);
  todoBlock.appendChild(todoListEl);
  todoBlock.appendChild(rowTodoFoot);

  // —— 待办块折叠 ——
  // 待办是「选任务」才看的东西，常驻会把「开始计时」挤到滚动区以下。
  // 默认收起，只留一行「待办 (N 条未做)」标题；当前有专注任务时在标题上写出任务名，
  // 收起也不至于不知道在做哪条。展开态不落盘：每次开菜单都回到「开始」优先的布局
  var todoFoldHead = document.createElement('button');
  todoFoldHead.type = 'button';
  todoFoldHead.className = 'dshwv-group-head dshwv-todo-fold-head';
  var todoFoldArrow = document.createElement('span');
  todoFoldArrow.className = 'dshwv-group-arrow';
  todoFoldArrow.textContent = '▸';
  var todoFoldName = document.createElement('span');
  var todoFoldSum = document.createElement('span');
  todoFoldSum.className = 'dshwv-group-sum';
  todoFoldHead.appendChild(todoFoldArrow);
  todoFoldHead.appendChild(todoFoldName);
  todoFoldHead.appendChild(todoFoldSum);
  var todoFoldBody = document.createElement('div');
  todoFoldBody.className = 'dshwv-group-body';
  var todoFoldInner = document.createElement('div');
  todoFoldInner.className = 'dshwv-group-inner';
  todoFoldBody.appendChild(todoFoldInner);
  todoBlock.appendChild(todoFoldHead);
  todoBlock.appendChild(todoFoldBody);
  var todoFoldOpen = false;
  function applyTodoFold() {
    todoFoldOpen = todoFoldOpen && todoOn;
    todoBlock.classList.toggle('dshwv-group-open', todoFoldOpen);
    todoFoldArrow.textContent = todoFoldOpen ? '▾' : '▸';
    todoFoldHead.setAttribute('aria-expanded', todoFoldOpen ? 'true' : 'false');
    var all = (todoState && todoState.items) || [];
    var left = 0;
    for (var i = 0; i < all.length; i++) if (!all[i].done) left++;
    var f = todoFocusItem();
    var name = f ? '待办 · ' + String(f.text || '') : '待办';
    if (todoFoldName.textContent !== name) todoFoldName.textContent = name;
    var sum = left > 0 ? left + ' 条未做' : (all.length ? '都已做完' : '暂无');
    if (todoFoldSum.textContent !== sum) todoFoldSum.textContent = sum;
    todoFoldHead.title = (f ? '当前专注：' + String(f.text || '') + '；' : '')
      + '点开查看（共 ' + all.length + ' 条，' + left + ' 条未做）';
  }
  todoFoldHead.addEventListener('click', function (e) {
    e.stopPropagation();
    todoFoldOpen = !todoFoldOpen;
    applyTodoFold();
  });
  // 添加框原挂在 todoBlock 顶部，折叠后要跟着挪进 inner，否则收起时它还在外面露着
  todoBlock.removeChild(rowTodoAdd);
  todoFoldInner.appendChild(rowTodoAdd);
  todoFoldInner.appendChild(todoListEl);
  todoFoldInner.appendChild(rowTodoFoot);

  // 合并组装配：「开始」置顶是这块的核心 —— 快捷四档 + 计时行 + 当前行，
  // 点开菜单第一眼就能开始下一轮；待办排在计时之后。
  // 放弃确认紧跟当前行（它问的就是「要不要放弃这一轮」）
  //
  // —— 最近计时（⑥）——
  // 数据源是宿主的专注会话明细（whale:focus 落库后的那一条回推，形状见 focus.normSession），
  // 页面只留最近几条做展示，**不另建历史存储**：计时状态机本来就只有一条，
  // 再存一份「计时历史」等于让同一件事有两本账。
  // 所以这项能力是「把宿主已经记下的东西在挂件里露出来」，不是挂件自己记
  var RECENT_MAX = 3;
  var recentDone = [];   // 已落库的会话，最新在前；本次运行内有效，重载即清
  var rowTimerHistory = menuRow();
  rowTimerHistory.className = 'dshwv-menu-row dshwv-timer-hist';
  rowTimerHistory.style.display = 'none';
  function renderTimerHistory() {
    rowTimerHistory.textContent = '';
    if (!recentDone.length) { rowTimerHistory.style.display = 'none'; return; }
    rowTimerHistory.style.display = '';
    var cap = document.createElement('span');
    cap.className = 'dshwv-timer-hist-cap';
    cap.textContent = '最近';
    cap.title = '最近结束的计时（来自专注记录，最多显示 ' + RECENT_MAX + ' 条）';
    rowTimerHistory.appendChild(cap);
    for (var i = 0; i < recentDone.length; i++) {
      var s = recentDone[i];
      var mins = s.m >= 1 ? s.m : 1;
      var chip = document.createElement('span');
      chip.className = 'dshwv-timer-hist-item' + (s.b ? ' dshwv-timer-hist-break' : '') + (s.a ? ' dshwv-timer-hist-a' : '');
      // 文案顺序：时长 → 结束时刻；休息轮加「休」，中途放弃加「· 弃」
      var txt = (s.b ? '休 ' : '') + mins + ' 分 · ' + fmtHm(s.t) + (s.a ? ' · 弃' : '');
      chip.textContent = txt;
      var tip = [];
      tip.push(s.b ? '休息' : (s.k === 'up' ? '正计时' : s.k === 'at' ? '定时刻' : '倒计时'));
      if (s.s > 0 && s.s <= s.t) tip.push(fmtHm(s.s) + '–' + fmtHm(s.t));
      tip.push(mins + ' 分钟');
      if (s.a) tip.push('中途放弃');
      if (s.todoText) tip.push('待办：' + s.todoText);
      chip.title = tip.join(' · ');
      rowTimerHistory.appendChild(chip);
    }
  }
  // 「最近」那一行不占位置：没有记录时整行 display:none，有记录才出现；
  // 重复推送同一条（id 相同）直接忽略，避免同一笔记两遍
  function pushRecentSession(s) {
    if (!s || !s.t) return;
    var id = String(s.id || ('t' + s.t));
    for (var i = 0; i < recentDone.length; i++) {
      if (String(recentDone[i].id || ('t' + recentDone[i].t)) === id) return;
    }
    recentDone.unshift(s);
    if (recentDone.length > RECENT_MAX) recentDone.length = RECENT_MAX;
    renderTimerHistory();
  }

  groupFocus.body.appendChild(rowTimerQuick);
  groupFocus.body.appendChild(rowTimer);
  groupFocus.body.appendChild(rowTimerStatus);
  // 「最近」贴在当前行下面：刚结束的一段紧挨着正在跑的那一轮，扫一眼就知道刚才做了多久
  groupFocus.body.appendChild(rowTimerHistory);
  groupFocus.body.appendChild(rowTimerConfirm);
  groupFocus.body.appendChild(todoBlock);
  groupFocus.body.appendChild(rowTimerDown);
  groupFocus.body.appendChild(rowTimerAt);
  groupFocus.body.appendChild(rowTimerPeekHint);
  groupFocus.body.appendChild(rowTimerFoot);

  // —— 多厂商模型：点一行即把它设为挂件主显示 ——
  var groupModels = menuGroup('models', '模型');
  var modelsListEl = document.createElement('div');
  modelsListEl.className = 'dshwv-models';
  var rowModelsRefresh = menuRow();
  var modelsRefreshBtn = document.createElement('button');
  modelsRefreshBtn.type = 'button';
  modelsRefreshBtn.className = 'dshwv-menu-link';
  modelsRefreshBtn.textContent = '刷新全部';
  // 与「刷新余额」的区分写在这里：那一只只管 DeepSeek，这一只把列表里所有模型都重拉
  modelsRefreshBtn.title = '跳过缓存，立刻刷新列表里的全部模型（含 DeepSeek 余额）';
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
  // 这一行不放「余额」标签：按钮是「刷新全部」（所有模型），额度型模型也在这张表里，
  // 写成「余额 刷新全部」既重复又容易读成「只刷余额」。改成与余额操作行同款的两只按钮
  rowModelsRefresh.appendChild(modelsRefreshBtn);
  // 「管理模型」：菜单里只能切主显示 / 刷新，加模型、改密钥、调字段路径都得回设置页
  var modelsManageBtn = document.createElement('button');
  modelsManageBtn.type = 'button';
  modelsManageBtn.className = 'dshwv-menu-link';
  modelsManageBtn.textContent = '管理模型';
  modelsManageBtn.title = '打开设置页的「模型与余额」卡（添加 / 删除模型、改密钥与字段路径）';
  modelsManageBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    closeMenu();
    openSettings('models');
  });
  rowModelsRefresh.appendChild(modelsManageBtn);
  groupModels.body.appendChild(modelsListEl);
  groupModels.body.appendChild(rowModelsRefresh);

  // 余额条置顶常显：最高频的信息不该藏在折叠组里（详见 rowBalanceTop 的注释）
  menuBox.appendChild(rowBalanceTop);
  // 穿透中的逃生行紧随余额条：穿透期间它是「怎么退出来」的唯一入口，不该藏在折叠组里
  menuBox.appendChild(rowPass);
  // 专注放最前：专注时最常看的是「现在做哪条」；合并组一次展开就有任务 + 计时 + 统计。
  // models 随后：它是余额类操作，且只在多模型时显示（见下面的 display 切换）
  menuBox.appendChild(groupFocus.el);
  menuBox.appendChild(groupModels.el);
  menuBox.appendChild(groupLook.el);
  menuBox.appendChild(groupUsage.el);
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
    refreshMenuSummaries(); // 模型组折叠摘要（几个模型）
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

  // —— 待办菜单渲染 ——
  // 当前专注的那条（宿主侧保证 focusId 一定指向未完成项，这里再兜一层）
  function todoFocusItem() {
    if (!todoState || !todoState.focusId) return null;
    var list = todoState.items || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === todoState.focusId && !list[i].done) return list[i];
    }
    return null;
  }
  // 气泡尾注只有一行的位置，太长会把整块字号压小，截到 8 个字
  function todoFocusText() {
    var it = todoFocusItem();
    if (!it) return '';
    var t = String(it.text || '');
    return t.length > 8 ? t.slice(0, 8) + '…' : t;
  }
  // 下一条：按清单存储顺序取「当前条之后」的下一条未完成，末尾回绕。
  // 用完整 items（含已完成）定位 afterId，这样 afterId 已被勾掉 / 删除时也不会
  // 从清单首条重新开始；afterId 完全不在清单里才退回第一条未完成。
  function nextUnfinishedTodo(afterId) {
    var items = (todoState && todoState.items) || [];
    var start = -1;
    for (var i = 0; i < items.length; i++) if (items[i].id === afterId) { start = i; break }
    for (var n = 0; n < items.length; n++) {
      var idx = start >= 0 ? (start + 1 + n) % items.length : n;
      if (items[idx].id !== afterId && !items[idx].done) return items[idx];
    }
    return null;
  }
  // 按 id 取待办（含已完成的）：接力气泡要拿「刚做完那条」的原文与 id，
  // 而 autoCompleteFocusedTodo 上报后清单里它已被标 done，不能再用「未完成」筛
  function todoById(id) {
    var items = (todoState && todoState.items) || [];
    for (var i = 0; i < items.length; i++) if (items[i].id === id) return items[i];
    return null;
  }
  // 当前专注的待办 id（无论完成与否，只读状态）：到点流程要在勾掉之前先把 id 记下来
  function focusedTodoId() {
    return todoState && todoState.focusId ? String(todoState.focusId) : '';
  }
  function todoTimerLabel(it) {
    if (!it) return '';
    if (it.tm === 'up') return '正计时';
    if (it.tm === '') return '不计时';
    return Math.max(1, Math.min(600, Math.round(Number(it.mins) || 25))) + ' 分';
  }
  // 计时气泡的尾注顺带告诉用户「这一轮在为哪条待办专注」（没有专注项时原样返回）。
  // 总开关只管记录与清单，不挡任务名：关掉时尾注仍要能看出在做哪条
  function withFocusTail(s) {
    var f = todoFocusText();
    return f ? s + ' · 专注：' + f : s;
  }
  // 待办行的渲染实体在 floating-todo-edit.js（window.WhaleTodoEdit.row）：
  // 那一行里有勾选框 / 提醒徽标 / 进度点 / 开始 / 撤销 / 「…」六段，留在本文件会撑破行数棘轮。
  // 这里只把页面状态与动作缝进去
  function todoRow(it) {
    return window.WhaleTodoEdit.row(it, {
      send: function (op) { whaleApi.todoSend(op); },
      rerender: function () { renderTodoMenu(); },
      warn: function (text) { showRemindBubble([{ t: text, s: 'A', c: '#e0433f' }, null, null], !timerFinished); },
      start: function (item) { startTodoTimer(item); },
      markDone: function (id) { todoJustDone[id] = true; },
      unmarkDone: function (id) { delete todoJustDone[id]; },
      isJustDone: function (id) { return !!todoJustDone[id]; },
      focusId: function () { return todoState && todoState.focusId; },
      editId: function () { return todoEdit ? todoEdit.id : ''; },
      toggleEdit: function (id) { todoEdit = todoEdit && todoEdit.id === id ? null : { id: id, field: '' }; },
      timerBusy: function () { return timerRunning || timerPaused; },
    });
  }
  // 行内编辑器（改名 / 提醒 / 删除）实体在 floating-todo-edit.js（window.WhaleTodoEdit），
  // 这里只把页面的状态与能力缝进去：编辑态归页面持有，重画走 renderTodoMenu
  function todoEditor(it) {
    return window.WhaleTodoEdit.editor(it, {
      send: function (op) { whaleApi.todoSend(op); },
      rerender: function () { renderTodoMenu(); },
      close: function () { todoEdit = null; },
      // 三行槽位：只说这一句，后两行留空（气泡只有三行，不硬凑）
      warn: function (text) { showRemindBubble([{ t: text, s: 'A', c: '#e0433f' }, null, null], !timerFinished); },
    });
  }
  function renderTodoMenu() {
    todoBlock.style.display = todoOn ? '' : 'none';
    // 折叠标题上的「N 条未做 / 当前任务」要跟着清单与专注任务实时变，不能只在开菜单时算一次
    applyTodoFold();
    refreshMenuSummaries();
    updateTimerStatus();
    if (!todoOn) return;
    // 拖拽排序的容器级监听只挂一次（清单容器常驻，行是每次重画出来的）
    if (window.WhaleTodoEdit.bindDrag) window.WhaleTodoEdit.bindDrag();
    todoListEl.textContent = '';
    var all = (todoState && todoState.items) || [];
    var doneN = 0;
    for (var di = 0; di < all.length; di++) if (all[di].done) doneN++;
    if (todoClearDoneBtn) {
      todoClearDoneBtn.textContent = doneN > 0 ? '清除已完成（' + doneN + '）' : '清除已完成';
      todoClearDoneBtn.style.display = doneN > 0 ? '' : 'none';
    }
    rowTodoFoot.style.display = doneN > 0 ? '' : 'none';
    // 只画未完成项 + 本次菜单里刚勾掉的（置灰留在原位，顺序不变）
    var items = [];
    for (var i = 0; i < all.length; i++) {
      if (!all[i].done || todoJustDone[all[i].id]) items.push(all[i]);
    }
    if (!items.length) {
      // 空态直接铺说明行（和计时 / 专注组同一对 class），不再套一层自带缩进的容器：
      // 容器再 pad 一次，行上的文字就和上面的清单错开一截
      if (all.length) {
        todoListEl.appendChild(menuHint('待办都完成了，去设置页加新的'));
      } else {
        todoListEl.appendChild(menuHint('还没有待办'));
        todoListEl.appendChild(menuHintAct('点击下方输入框快速添加'));
        // 补一句「这里看不到什么」：勾掉的待办不留在挂件里，用户看不到时容易以为丢了
        todoListEl.appendChild(menuHint('勾选即完成；已完成的到设置页查看'));
      }
      return;
    }
    // 编辑态跟着条目走：只在对应行之后插一整个全宽编辑器 ——
    // 塞进 todo-row（flex 单行）会被挤成窄条，所以由这里负责插入
    items.forEach(function (it) {
      todoListEl.appendChild(todoRow(it));
      if (todoEdit && todoEdit.id === it.id) todoListEl.appendChild(todoEditor(it));
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
    // dsh 端口上的进程：running=本插件启动；external=别的终端启动的 dsh；portOther=非 dsh 占用
    // 端口可配（设置页「高级选项」，默认 3080），文案里的端口号一律取快照的 s.port
    var port = s.port || 3080;
    var ext = !!(s.external && s.externalPid);
    var other = s.portOther || '';
    var text = '未获取';
    if (s.busy === 'install') text = '安装中…';
    else if (s.busy === 'update') text = '更新中…';
    else if (s.busy === 'versions') text = '查询版本中…';
    else if (err) text = err;
    // 端口被改但进程还在跑：ready 描述的是 runPort（旧端口）上的事实，不能读成「启动中」。
    // 与设置页文案保持一致：说明现监听哪个端口，让用户去点「重启」。
    else if (s.running) text = s.stopping ? '正在结束…' : (s.needsPortRestart ? '运行中 · pid ' + s.pid + '（' + s.runPort + '）· 端口已改为 ' + port : (s.ready ? '运行中 · pid ' + s.pid : '启动中…（' + port + ' 未就绪）'));
    // 外部 dsh 同理：它可能停在旧端口上（改过配置端口），要说明「现监听哪个」，否则用户以为端口已切过去。
    else if (ext) text = '外部 dsh · pid ' + s.externalPid + (s.externalRunPort && s.externalRunPort !== port ? '（' + s.externalRunPort + '）· 端口已改为 ' + port : '');
    else if (other) text = '端口 ' + port + ' 被 ' + other + ' 占用';
    else text = '未运行';
    var cls = 'dshwv-dsh-state';
    if (err) cls += ' dshwv-dsh-err';
    else if (s.running || ext) cls += ' dshwv-dsh-on';
    dshStateEl.className = cls;
    dshStateEl.textContent = text;
    dshStateEl.title = text +
      '\ndsh：' + (s.url || '') +
      (s.running ? '\n状态：' + (s.ready ? (s.runPort || port) + ' 已就绪' : '启动中，稍等') + (s.needsPortRestart ? '；端口已改为 ' + port + '，点「重启」生效' : '') + (s.needsRestart ? '（已换成 ' + (s.resolved || '') + '，点「重启」生效）' : '') : '') +
      '\nNode：' + (s.nodeDir || '未找到') + (s.nodeVersion ? '（' + s.nodeVersion + '）' : '') +
      '\n版本：' + (s.resolved || '未安装') + (s.source === 'global' ? '（全局）' : s.source === 'plugin' ? '（插件目录）' : '') +
      (ext ? '\n外部进程：由别的终端启动（' + ((s.externalRunPort && s.externalRunPort !== port) ? '现监听 ' + s.externalRunPort + '，端口已改为 ' + port + '，' : '') + '「结束」会结束它，「重启」会用当前配置重新启动）' : '') +
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
    // DSH 错误气泡：首次出现新错误时弹出提醒，避免每次状态推送都重复打扰
    if (err && err !== lastDshError) {
      lastDshError = err;
      showRemindBubble([
        { t: 'DSH 异常', s: 'A', c: '#e0433f' },
        { t: err.length > 18 ? err.slice(0, 18) + '…' : err, s: 'P', c: '#e0433f' },
        { t: '可在菜单或设置页查看详情', s: 'C', c: '', w: true },
      ]);
    } else if (!err) {
      lastDshError = '';
    }
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

  // 气泡 DOM 构建与渲染算法（setGifSrc / fit / applyLines / gif 失败状态机）在共享渲染器里，
  // 这里只接线：click 处理依赖页面状态（菜单命中 / 台词队列 / bubbleShown），留在页面。
  // onGifError / gifFailLines 两个回调引用的台词区函数是声明提升，运行时才触发，无时序问题
  var renderer = window.BubbleRender.createBubbleRenderer({
    rootEl: root,
    defaultGifUrl: GIF_URL,
    gifFailLines: function () { return singleCenter('A', pickOne(QUOTES.gifFail), '', true); },
    onGifError: function () {
      if (bubbleShown) {
        bubbleRandomLines = singleCenter('A', pickOne(QUOTES.gifFail), '', true);
        applyBubbleLines(bubbleRandomLines);
      }
    },
    // v2 行×段渲染回调（台词区函数靠声明提升，运行时才触发，无时序问题）：
    // bubbleSrc 图片段取图（下标语义见 bubbleImgSrc）；modelText 变量段按当前数据现算
    bubbleSrc: bubbleImgSrc,
    modelText: linePlaceholderValue,
    randText: randSegText,
    randImgSrc: randImgSrc,
    // 按压气泡模块取值回调（v3 bubble 模型）：文本与图片都由页面按实时数据现算，渲染器只负责排版
    modText: bubbleModText,
    modImageSrc: bubbleModImageSrc,
    modStyle: bubbleModStyle,
    // random 模块抽中台词的样式（字号/配色逐条带）；与 modText 共用同一次抽签，见 bubbleRandomPick
    modPick: bubbleModPick,
  });
  var textBox = renderer.els.textBox;
  // 「今日已过百分比」细进度条：倒计时开启时挂在文字块下方，
  // 绝对定位（top:100%）不参与 fitBubbleText 的三行测高，避免多一条元素把主数字挤小。
  // 占比算不出来（休息日 / 跨日班）时整条隐藏，不硬凑数字
  var offworkBarEl = document.createElement('div');
  offworkBarEl.className = 'dshwv-offwork-progress';
  offworkBarEl.style.display = 'none';
  var offworkTrackEl = document.createElement('i');
  var offworkFillEl = document.createElement('b');
  offworkTrackEl.appendChild(offworkFillEl);
  var offworkPctEl = document.createElement('span');
  offworkPctEl.className = 'dshwv-offwork-pct';
  offworkPctEl.textContent = '0%';
  offworkBarEl.appendChild(offworkTrackEl);
  offworkBarEl.appendChild(offworkPctEl);
  textBox.appendChild(offworkBarEl);
  var labelEl = renderer.els.labelEl;
  var amountEl = renderer.els.amountEl;
  var hintEl = renderer.els.hintEl;
  var rowsBox = renderer.els.rowsBox;
  var modsBox = renderer.els.modsBox;
  var bubbleBox = renderer.els.bubbleBox;
  // 大数字不吃点击：它落在气泡中心，点这里想的是「收起 / 推进气泡」，双语义会把误触翻成遮蔽态（遮蔽只留菜单里的小眼睛）
  var gifEl = renderer.els.gifEl;
  bubbleBox.addEventListener('click', function (e) {
    e.stopPropagation();
    // 气泡圆开得很满，打开后 SVG path（visiblePainted）正好盖住右上角菜单按钮；menuBtn 是
    // body 的兄弟节点，冒泡路径不经过它，这里必须显式转交，否则「有气泡时菜单点不开」
    if (isOverMenuBtn(e)) { toggleMenu(); return; }
    if (!bubbleShown) return;
    // 链接段点击：交系统浏览器开，不参与「点气泡推进队列」的语义（点到链接 ≠ 想翻页）
    var linkEl = e.target && e.target.closest ? e.target.closest('.dshwv-link') : null;
    if (linkEl && linkEl.dataset.url) {
      try { whaleApi.openExternal(linkEl.dataset.url); } catch (err) { logErr('[whale][page] 打开链接失败', err && err.message); }
      return;
    }
    // 设置页试播会话进行中：点挂件气泡翻下一条（末条再点收起），不与随机台词互相干扰
    if (bubblePreviewActive) {
      if (!previewSessionNext()) hideBubble();
      return;
    }
    // 按压气泡模型：气泡正显示队列某一页时，点气泡翻下一页（末页再点收起；停留时长由 bubbleNext 布防）
    if (bubbleActive) { if (!bubbleNext()) hideBubble(); return; }
    if (bubbleRandomActive || bubbleTimerActive) {
      // 「只显计时」关闭时计时只是先弹一下：点掉它要接着显示常规内容，而不是直接把气泡收起
      if (bubbleTimerActive && !timerTakesBubble()) { timerPeekDone(); return; }
      hideBubble(); // 再次点击：关闭（计时气泡收起后计时继续）。动图降级文案也在此收起
    } else if (bubbleRemindActive) {
      // 提醒气泡（峰谷 / 预算 / 低余额）：点一下让常规内容接管（用户多半想看余额），不直接收起
      bubbleRemindActive = false;
      bubbleRemindLines = null;
      showBubble(true);
      bubbleArm(bubbleDwellMs, hideBubble);
    } else {
      hideBubble(); // 游离态兜底：内容只有一页时点一下收起（旧实现重呈同一页，真机像「点了没反应」）
    }
  });

  var body = document.createElement('div');
  body.className = 'dshwv-body';
  // 手动刷新的呼吸圈（见 refresh() 的 setRefreshing）。放在 img 之后、ring 之前：
  // 气泡与菜单在 body 之外，不受它影响；ringSvg 的 z-index 更高，计时进行中仍压在上面
  var refreshMask = document.createElement('div');
  refreshMask.className = 'dshwv-refresh-mask';
  body.appendChild(img);
  body.appendChild(refreshMask);
  body.appendChild(ringSvg);
  body.appendChild(bubbleBox);
  root.appendChild(body);
  root.appendChild(menuBtn);
  document.body.appendChild(root);
  document.body.appendChild(menuBox);

  // —— 状态 ——
  var state = { balance: null, currency: null, todayUsage: null, isPeak: false, peakNextAt: 0, change: 0, budgetOver: false, lowOver: false, status: 'loading', message: '', adjustNote: null };
  // 多厂商模型（宿主 whale:models 推送）：list 含内置 DeepSeek 那条，mainModelId 决定挂件主显示
  var models = [];
  var mainModelId = 'deepseek';
  // 币种前缀与宿主 constants.js 的 MODEL_MONEY_PREFIX 保持一致（浮动页没有 require，读不到宿主常量）
  var MODEL_MONEY_PREFIX = { CNY: '¥ ', USD: '$' };
  // 当前倍率（不是档位）。默认 1.3 即默认档位 6（与设置页 cfg.scale 默认一致）；宿主回推会覆盖
  var curScale = 1.3;
  // 滑块初值所用的本地默认倍率即上方 curScale（见 scaleInput 初始化）。
  var flipped = false;
  var animDelayTimer = null, drag = null, shown = null, animId = null;
  var flashTimer = null; // 余额变动动效定时器（1.3s 后移除 flash 类名）
  var bubbleShown = false, bubbleTimer = null, bubbleRandomActive = false, bubbleRandomLines = null;
  // 设置页「挂件气泡试播」会话 {steps, idx}：优先级低于计时/提醒，点挂件气泡才顺序翻条（点鲸鱼本体不抢）
  var bubblePreviewActive = false, previewSession = null;
  // —— 按压气泡（v3 自定义泡泡模型）：设置页下发整份 bubble 配置，bubble.on 决定用哪份步骤 ——
  // 队列 = 步骤 + 倒计时页（开启时，排在最后），见 floating-pages.js；没有常规页 / 概览页。
  //   bubbleItems  —— 用户自定义的点击序列（bubble.on 开启时用）
  //   bubbleDefaultItems —— 宿主下发的出厂默认序列（bubble.on 关闭时用，与默认配置的渲染完全一致）
  //   bubbleIdx    —— 当前页在队列里的下标；bubbleActive = 当前内容来自队列（点击推进走 bubbleNext）
  var bubbleOn = false;
  // 金额遮蔽：为「旁边有人看屏幕」准备的一键隐私态。true 时所有金额类文本统一显示 ***，
  // 只影响显示层，state / 账本 / 复制按钮取到的仍是真实值（见 withRealAmounts）
  var hideAmounts = false;
  var bubbleItems = [], bubbleDefaultItems = [], bubblePreviewItems = null; // 后者仅试播期间非空：顶替整条队列，不含倒计时页
  // 自定义泡泡模型是否启用（bubble.on === true）。与顶层 bubbleOn 分开记：后者是「弹不弹气泡」的总闸，
  // bubbleModelOn 只决定用「你的队列」还是「出厂默认队列」；关闭时不再退回常规三行页
  var bubbleModelOn = false;
  var bubbleTapAdvanceOn = false; // 本模型自带「点鲸鱼本体也推进」
  var bubbleModelDwellMs = BUBBLE_MS; // 本模型自带停留时长（秒 → ms；与顶层 bubbleDwellMs 各管各）
  var bubbleDragLines = [];       // 本模型自带拖拽台词
  var bubbleIdx = 0, bubbleActive = false;
  // 页队列本体在 floating-pages.js（WhalePages）：自定义步骤按原序在前，倒计时哨兵页排在最后。
  // 第一张气泡必须是步骤页 —— 倒计时不许出现在第一页的任何位置（2026-11-09 口径）。
  // 试播用 bubblePreviewItems 顶替整条队列；计时 / 提醒 / 随机台词压在整个队列之上（见点击链与 offworkCanRender）
  var PAGES = window.WhalePages;
  var OFFWORK_PAGE = PAGES.OFFWORK_PAGE;
  function bubbleQueue() {
    var items = bubbleModelOn ? bubbleItems : (bubbleDefaultItems.length ? bubbleDefaultItems : bubbleItems);
    return bubblePreviewItems || PAGES.queue({ offworkOn: offworkOn, items: items });
  }
  // 气泡 TTL 补收：悬浮窗被隐藏 / 系统休眠时 Electron 会节流定时器，单靠 setTimeout 可能「该收不收」；
  // 这里记绝对截止时刻，窗口回到可见 / 拿到焦点时补收一次，另有每秒巡检兜底。
  // 0 = 无 TTL（常驻气泡 / remindSec=0 / 计时气泡 pin），巡检必须跳过，不能误收
  var bubbleTtlDeadline = 0;
  var bubbleRemindActive = false, bubbleRemindLines = null; // 峰谷提醒气泡（优先级高于随机台词）
  var bubbleTimerActive = false; // 计时气泡（正计时/倒计时/定时/时间到），优先级最高
  // BUBBLE_STYLE_CLASS（台词行类型 → 样式类）已移入共享渲染器，applyBubbleLines 经薄壳走渲染器

  // —— 下班倒计时（可开关的独立展示形态）——
  // 算法唯一源在 public/preload/lib/offwork.js（构建期打成 dist/offwork-core.js，宿主 require 同一份源码做配置归一）；
  // 默认值也从那里取，避免页面与宿主两份副本漂移。
  var OFFWORK_CORE = window.OffworkCore || null;
  var OFFWORK_DEFAULTS = (OFFWORK_CORE && OFFWORK_CORE.DEFAULTS) || {
    start: '09:00', end: '18:00', days: [1, 2, 3, 4, 5],
    showSec: true, weekendOn: false, paydayOn: false, paydayDay: 10,
  };
  var offworkOn = false;
  var offworkStart = OFFWORK_DEFAULTS.start;
  var offworkEnd = OFFWORK_DEFAULTS.end;
  var offworkDays = OFFWORK_DEFAULTS.days.slice();
  var offworkShowSec = OFFWORK_DEFAULTS.showSec;
  // 下班倒计时的外圈工时进度环（设置页「下班倒计时 → 显示进度圈」可关）。
  // 关掉后圈只归计时，倒计时改由进度条表示（见 updateOffworkProgress）
  var offworkRing = OFFWORK_DEFAULTS.ring !== false;
  // 外圈画法（只影响两种用途共用的那一圈，不影响进度口径）：
  //   ringWidth 细 / 标准 / 粗；ringFollowTheme = 圈色是否随气泡主题明暗换一档
  var ringWidth = 'normal';
  var ringFollowTheme = true;
  var offworkWeekendOn = OFFWORK_DEFAULTS.weekendOn;
  var offworkPaydayOn = OFFWORK_DEFAULTS.paydayOn;
  var offworkPaydayDay = OFFWORK_DEFAULTS.paydayDay;
  // 时薪（元/小时，0 = 未配置）：只用于「今日已赚」估算；0 时整项不显示，不占位、不显示 0
  var offworkHourlyWage = 0;
  // 最近一次已写入 DOM 的倒计时文本：每秒巡检只在「秒数 / 阶段 / 临近档位」变化时才写 DOM
  var offworkLastKey = '';

  var soundOn = true, soundVol = 0.9, soundSet = 'duck';
  // 提醒音独立音量（low/budget/peak/pass 四类提醒音，press/release 音色音不在此列）：
  // volSet=false = 没动过滑块，播放跟随全局音量；true = 用自己的。必须用布尔位区分
  // 「没动过」和「恰好设成同值」；0 是合法音量（静音），解析不能用 `||` 兜底（会吃掉 0）
  var alertVols = { low: { vol: 1, volSet: false }, budget: { vol: 1, volSet: false }, peak: { vol: 1, volSet: false }, pass: { vol: 1, volSet: false } };
  // 宿主推送的 base64 data URL（whale:sounds），**每个槽位是一组**（同一类可导入多段，播放时随机取一条）。
  // press/release 是「音色」两段，low/budget/peak/pass 是四类提醒各自的提醒音（留空时回落到内置提醒音）
  var customSounds = { press: [], release: [], low: [], budget: [], peak: [], pass: [] };
  var customSkin = '';         // 宿主推送的自定义形象 base64 data URL（whale:skin，空串=未导入）
  // 宿主推送的自定义气泡图片（whale:bubbles，base64 data URL 数组）。与形象不同，这里没有
  // 「当前用哪张」：抽到「动图组」时从里面随机取一张，空数组则回退内置 rua.webp
  var customBubbles = [];
  // 宿主推送的「已装官方可下载形象」**清单**（whale:shared-skins：[{ id, ext, size }]，不含本体）：
  // 台词 v2 randimg 段的共享角色图池。与 customBubbles 分开 —— randimg 抽的是共享角色的
  // 形象图（上游 gif 模块能力），不是用户自定义气泡图；清单为空时 randimg 段整段丢。
  // 为什么推清单而不是整池：整池实测 39MB 原图 / 52MB base64，读盘 + 编码 + 跨进程克隆
  // 全压在「打开挂件」那一下，而且本页要常驻一份、宿主再存一份。现在抽到哪张按 id 单张
  // 来要（whale:randimg → whale:randimg-data），到手存在 sharedImgs（有字节预算，超了淘汰最旧）。
  // 下标语义：randimg 段的 imgs 是「池里第几张」（1 起算），指向 sharedPool 的顺序。
  var sharedPool = [];
  var sharedImgs = {};        // id → data URL（已到手的本体）
  var sharedImgsBytes = 0;    // 已到手本体的原图字节合计（按清单里的 size 记账）
  var sharedPending = {};     // 已发出、还没回包的 id（去重，避免同一张反复要）
  var sharedDead = {};        // 回包为空串的 id：文件已经不在，别再抽它、也别再要它
  var sharedReady = [];       // 已到手的清单项。只在清单/缓存变化时换数组身份 ——
  //                           pickOne 的「不与上次重复」记在数组引用上，每次都新建数组就记不住
  // 本体的字节预算：按清单里的**原图字节**记账，页面里实际是 base64（约 1.37 倍），12MB 原图 ≈ 16MB 字符串。
  // 整池是 39MB 原图 / 52MB base64，且宿主那一份现在完全不留 —— 这里是唯一的一份常驻。
  var SHARED_CACHE_BYTES = 12 * 1024 * 1024;
  var SHARED_PREFETCH = 4;    // 预取的**下限**张数（预算没满就一直预取到满，见 prefetchSharedImgs）
  var SHARED_PREFETCH_FIRST_MS = 800; // 等首帧画完再开始搬图，别跟首帧抢主线程
  var SHARED_PREFETCH_GAP_MS = 200;   // 每张之间隔一下，避免连着几张 1.5MB 克隆挤在同一 tick
  var skinId = DEFAULT_SKIN;   // 当前形象：BUILTIN_SKINS 的键，或 'custom'（用户导入）
  var themeId = 'default';     // 当前气泡配色：'default' | 'dark' | 'sakura' | 'fantasy'
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
      // HUD 装饰的开关：CSS 只在 .dshwv-theme-fantasy 下显示外圈/文字角标
      root.classList.toggle('dshwv-theme-fantasy', themeId === 'fantasy');
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
    // 接管成功＝此刻正在与挂件交互，按钮必须亮起。这里 forceShow：
    // 不能用位置判断（按钮就压在鲸鱼轮廓顶边上沿，位置判定常判成「不在鲸鱼上」→ 按钮不显示）
    forceShowMenuBtn();
    sendIgnoreMouse(false);
  }
  function passRelease() {
    passHoverActive = false;
    passApplyIndicator();
    // 交回穿透后按钮未必该消失：指针可能仍压在鲸鱼上（接管是为别的触发场景发生的）。
    // 用「最后一次已知位置」重算，避免这里无条件移除后、下一次 pointermove 前不显示
    applyMenuBtnAtLast();
    sendIgnoreMouse(true);
  }
  // ============ 菜单按钮显隐 ============
  // 规则（唯一判据）：**指针在鲸鱼轮廓内（或按钮本身上）→ 显示；否则隐藏**。
  //
  // 设计要点（照搬成熟参考项目的范式，也是本项目此前反复出错的教训）：1) **单一入口 + 声明式**：只由 applyMenuBtn(e) 一个函数决定显隐，内部用
  //    classList.toggle(cls, want) 一次性把 class 设成「此刻应有」的样子。命令式的
  //    add/remove 分散在多处时，任何两条路径的结论不一致就会互相翻盘。
  // 2) **单一坐标源**：判定只读调用方手上的那个事件对象（或显式传入的点），不维护
  //    lastHoverPt 之类的快照 —— 双坐标源正是历史上「轮廓边界上两条路径给出相反结论」的根源。
  // 3) **无定时器、无迟滞、无豁免轮次**：这些状态越多，边界上越容易互相抵消。参考项目
  //    的做法（每次 pointermove 同步 toggle）证明了根本不需要它们。
  // 4) 隐藏态由 CSS 的 visibility:hidden + pointer-events:none 保证「看不见＝点不到」，
  //    因此本函数**只**负责按位置决定显隐，不必再为命中测试做任何补偿。
  function applyMenuBtn(e) {
    var want;
    if (!menuBtnEnabled) want = false;
    else if (menuOpen) want = true;                        // 菜单开着：按钮必须常显（它是菜单锚点）
    else if (e && isFinite(e.clientX)) want = isWhaleHit(e) || isOverMenuBtn(e);
    else return;                                          // 没有可信坐标：不动（下次 pointermove 自会纠正）
    try { menuBtn.classList.toggle('dshwv-menu-btn-visible', want); } catch (err) {}
  }
  // 用「最后一次已知的指针位置」重算（关菜单 / 配置变更 / 穿透切换等无事件对象的场景）。
  // 指针可能正静止，不会有 pointermove 来纠正，所以这些场景必须显式重算一次。
  // 没有可信坐标时按「不在鲸鱼上」隐藏，而不是不动：以前这里空操作，于是关菜单后
  // 按钮停在打开菜单时的强显态，要等用户再动一下鼠标才清掉（正是「不自动隐藏」的成因之一）。
  function applyMenuBtnAtLast() {
    if (lastHoverPt) applyMenuBtn(lastHoverPt);
    else try { menuBtn.classList.remove('dshwv-menu-btn-visible'); } catch (err) {}
  }
  // 强制显示：点开菜单、穿透接管等「此刻正在与挂件交互」的场景。
  // 不能靠位置判定 —— 按钮压在鲸鱼轮廓顶边上沿，位置判定容易判成「不在鲸鱼上」而隐藏。
  function forceShowMenuBtn() {
    try { menuBtn.classList.toggle('dshwv-menu-btn-visible', !!menuBtnEnabled); } catch (err) {}
  }
  // 指针离开整个窗口：收起按钮并交回穿透。必须有这条「窗口级」兜底 ——
  // 主判定由 pointermove 驱动，指针一旦移出窗口客户区就不再派发，按钮残留没人清理
  // （窗口比鲸鱼本体四周各多 WIN_PAD=200px 透明留白，指针停在留白里也算「没动」）。
  function onWindowPointerLeave(e) {
    // 子元素之间移动也会冒泡出 pointerleave（relatedTarget 仍在窗口内），只认真正离开窗口的那种。
    // relatedTarget 为 null 时无法区分，按「离开」处理 —— 这是安全的默认值
    // （漏收只是晚一点隐藏，误收也只是按钮多显示一瞬）
    if (e && e.relatedTarget && e.relatedTarget !== document.documentElement
        && document.documentElement.contains(e.relatedTarget)) return;
    passDwellCancel();
    passReleaseCancel();
    if (menuOpen) closeMenu();
    // 指针既然已离开窗口，按钮一律先收起，并作废悬停点 —— 之后若指针回来，
    // 下一次 pointermove 会重新写入 lastHoverPt 并恢复显示
    lastHoverPt = null;
    try { menuBtn.classList.remove('dshwv-menu-btn-visible'); } catch (err) {}
    // 拖拽中不动穿透与光标：窗口正被拖着走，指针必然短暂离开客户区，
    // 此刻 setIgnoreMouse(true) 会掐断后续 pointerup，拖拽就收不了尾
    if (drag && drag.active) return;
    passHoverActive = false;
    // 以下各步各自兜底：这是「窗口级」唯一兜底，任一步抛错都不能让后面的
    // setIgnoreMouse(true) 被跳过 —— 否则指针移出后窗口一直不穿透，挡住下层应用
    try { passApplyIndicator(); } catch (err) {}
    try { setWidgetCursor(''); } catch (err) {}
    sendIgnoreMouse(true);
  }
  // 提醒气泡自动收起：remindSec = 0 表示常驻，等用户点掉（设置页可配）。
  // keepTimerBubble=true（force 顶掉了原本正显示的计时气泡）时，收起后把计时气泡还回去：
  // 否则按完「专注统计」过几秒气泡整个消失，只剩一个还在转的环，容易被当成计时停了
  function setRemindAutoHide(keepTimerBubble) {
    if (remindSec <= 0) { bubbleDisarm(); return; }
    if (!keepTimerBubble) { bubbleArm(remindSec * 1000, hideBubble); return; }
    bubbleArm(remindSec * 1000, function () {
      hideBubble();
      // 还回去的计时气泡仍按「计时气泡常驻」开关决定停留：常驻 → 0（一直挂着），
      // 否则按 bubbleDwell 秒自动收起。写死 0 会让关掉常驻的用户被顶一次提醒后气泡永久不散
      if (timerActive() && !timerFinished) showTimerBubble(timerBubbleAutoMs());
    });
  }
  // 被动提醒的让路条件：计时进行中（系统通知兜底），或「时间到」动作条正显示（不能顶掉它）。
  // 不能直接用 timerActive()：它把 timerFinished 也算「活跃」，而用户点「知道了」/点鲸鱼收起气泡后
  // 该位不会复位（只有开始 / 重置计时才清），会让待办到点、峰谷、低余额这些被动提醒长期静默。
  function remindBubbleBlocked() {
    if (timerRunning || timerPaused) return true;
    return !!(timerFinished && bubbleShown && bubbleTimerActive);
  }
  // 提醒气泡统一入口：峰谷/预算/低余额/穿透说明都走这里（三行内容，停留秒数共用设置）。
  // force=true 只给「用户主动触发的指令」（专注统计、切换穿透）用：计时进行中也照常显示，
  // 否则按了快捷键 / 点了开关毫无反馈。到点态（timerFinished）不传 force —— 那时气泡下缘
  // 挂着「休息 / 再来一轮 / 知道了」动作条，被顶掉后 hideBubble 会 clearTimerDone()，按钮再也回不来
  // 返回值 = 气泡是否真的挂出来了（false = 气泡总开关关 / 计时占位被拦）。
  // 待办到点靠它回执宿主，只有真显示才算送达（见 ipc.js 的 whale:todo-due-ack）
  function showRemindBubble(lines, force) {
    if (!bubbleOn) return false;
    if (!force && remindBubbleBlocked()) return false;
    // 记下「原本正显示计时气泡」：到点自动收起时按此把计时还回去（用户此前已点收则不还）。
    // 只认计时气泡真正占着气泡的情形（只显计时 / 已到点）；peek 态到点本就该切回常规内容，不在此列
    var keepTimerBubble = !!(force && bubbleTimerActive && timerTakesBubble());
    if (bubbleTimer) { clearTimeout(bubbleTimer); bubbleTimer = null; }
    renderer.cancelGifFade();
    bubbleShown = true;
    bubbleRandomActive = false;
    bubbleRandomLines = null;
    bubbleTimerActive = false; bubbleActive = false; // 提醒压过整条队列：点击交给提醒自己的分支，不再翻页
    bubbleRemindActive = true;
    bubbleRemindLines = lines;
    bubblePreviewActive = false; // 提醒优先级高于试播：接管后整段作废
    previewSession = null; bubblePreviewItems = null;
    restoreBubbleLines();
    applyBubbleLines(lines);
    bubbleBox.classList.add('dshwv-bubble-open');
    setRemindAutoHide(keepTimerBubble);
    return true;
  }
  // 穿透开关切换的一次性说明气泡（穿透只影响输入、不影响绘制，气泡照常可见）。
  // 文案取设置页的「提醒文案」模板，红/绿沿用状态色（开=红，关=绿）
  function showPassNotice(on) {
    playAlertSound('pass');
    // 用户自己点的穿透开关，计时进行中也要说一声（否则开了穿透却不知道、也不知道怎么关回来）
    showRemindBubble(alertLines(on ? 'passOn' : 'passOff', {}, on ? '#e0433f' : '#2fa24c'), !timerFinished);
  }
  var timerNotifyOn = true, timerPersistOn = true; // 计时到点系统通知 / 计时状态持久化
  // 计时到点的邮件通知开关，以及「邮件渠道总开关」的本地副本：页面不自己发信，
  // 只用来判断「到点该不该叫宿主发」—— 两个渠道都关时才真的不发。
  var timerMailOn = true, mailOn = false;
  // 重载/休眠回来后，「到点」在 5 分钟内才算刚结束：补铃 + 通知 + 记轮还说得过去；
  // 再久就只是过期状态 —— 补通知等于隔天半夜弹窗，记轮也会记到错误的一天。
  var RESTORE_GRACE_MS = 5 * 60 * 1000;
  var usageMode = 'ledger', peakMode = 'default';
  // 界面深浅色偏好（设置页可改）：'auto' 跟 uTools / 'light' / 'dark' / 'fantasy'（未至之境，暗色专用）。
  // 生效值 = 偏好为 auto 时取 uTools 实际深浅，否则用偏好本身；uTools 侧实时值由 onDark/isDark 维护
  var uiMode = 'auto';
  var utoolsDark = false; // uTools 当前深浅态的最新缓存（applyDark 合成用）
  var peakRemindOn = true; // 峰/谷时段切换时用气泡提醒（需开启思考气泡）
  var menuBtnEnabled = true; // 挂件右上角菜单按钮开关（设置页可关）
  var lowAlertOn = true, lowAlertAmount = 10; // 低余额预警（余额低于阈值时数字变红）
  var budgetOn = false, budgetAmount = 0; // 今日预算：用量超过预算额时提醒（0 = 未设置）
  var tapAdvance = false; // 点挂件本体是否也推进依次播放（默认关；见 endDrag 的 wasClick 分支）
  // 计时中「双击鲸鱼看一眼余额」的连击判定（见 endDrag / showBalancePeek）。
  // 取 500ms = Windows 默认双击间隔：取 320ms 时手慢一点（350~450ms）就会被当成两次单击，
  // 用户只看到「双击没反应」，而且没有任何提示能告诉他差在哪
  var WHALE_DBLCLICK_MS = 500;
  var lastWhaleClickAt = 0;
  var timeBubbleOn = true; // 报时：气泡首行显示当前时间
  var dragLock = false; // 锁定位置：禁止拖拽与滚轮缩放（点击刷新仍可用）
  var menuOpen = false;
  var menuDown = false; // 本次打开锁定的展开方向（true = 向按钮下方展开）
  var menuDirLocked = false; // 方向已定：打开动画期间内容高度变化不重算，防面板在按钮上下侧来回翻
  var firstBalance = true, pendingManual = false;
  var lastIsPeak = null; // 上一次的峰谷状态，用于检测「进入峰时/谷时」的切换
  var lastFailCount = 0; // 上一次收到的连续失败计数，用于只在首次跨过阈值时弹气泡
  var lastDshError = ''; // 上一次的 DSH 错误信息，用于只在首次出现时弹气泡

  // —— 固定文案池 ——
  // 报时模板与动图降级文案：与宿主 store.js 的 QUOTE_TEXT_DEFAULT 逐字一致（浮动页没有 require
  // 读不到宿主常量，靠 scripts/check-shared.mjs 在构建时比对，改一处忘另一处会构建失败）。
  // time 是白天报时模板、timeEarly/timeMorning/timeEve 是深夜/清晨/深夜前报时模板（{t} 换当前时间）、
  // gifFail 是动图加载失败的顶替文案。这几项不走抽签，设置页改过则由 applyConfig 从
  // config.bubble.system 覆盖（已并入按压气泡卡，不再有独立台词库）
  var QUOTES = {
    time: ['现在是 {t}', '已经 {t} 啦', '都 {t} 了哦', '小鲸鱼报时：{t}'],
    timeEarly: ['都 {t} 了，还不睡吗…'],
    timeMorning: ['早安~ 现在是 {t}'],
    timeEve: ['都 {t} 了，早点休息…'],
    gifFail: ['gif 加载失败了...', '今天没有动图给你看~', '呜呜 动图不见了...'],
  };
  // 上面这些固定文案池的 key：applyConfig 里逐个覆盖。顺序即报时四池的判定顺序
  var QUOTE_TEXT_KEYS = ['time', 'timeEarly', 'timeMorning', 'timeEve', 'gifFail'];
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
  // 调用方据此回退内置 rua.webp
  function pickBubbleUrl() {
    if (!customBubbles.length) return '';
    return pickOne(customBubbles) || '';
  }
  // 图片段的取图回调（渲染器 bubbleSrc）：img=0 / 缺省 = 随机抽一张（v1 image 组语义，
  // store.js normSeg 把缺省 img 存成 0）；1..N = 指定第 N 张（1 起算，0 让位给「随机」）。
  // 没导入过气泡图时回 null，渲染器据此整段丢掉（与旧 image 组没图可抽时整组无效的口径一致）
  function bubbleImgSrc(imgIdx) {
    if (!customBubbles.length) return null;
    var i = Math.round(Number(imgIdx) || 0);
    if (i <= 0) return pickBubbleUrl() || null;
    return customBubbles[Math.min(i, customBubbles.length) - 1] || null;
  }
  // randimg 段的取图回调（渲染器 randImgSrc / bubbleModImageSrc）：每次显示从「已装共享角色图」
  // 池里随机抽一张**已经到手**的（不连续重复，复用 pickOne 的 WeakMap 机制）。
  // imgs 是「本段可抽的共享角色下标集」（1 起算，模块编辑器填的就是它）：非空时只在该子集里抽，
  // 空数组 = 不设限、整池随机。没有这个过滤，「随机图池」就成了空设置（曾踩：填了只抽这几张也不生效）。
  // 池子为空、或想要的那几张一张都还没到手时回 null —— 渲染器据此整段丢；
  // 与此同时已经把想要的那张发出去要了，下一次按压（或预取到位）就有图。
  function randImgSrc(imgs) {
    if (!sharedPool.length) return null;
    var cand = filterSharedPool(imgs);
    var want = pickOne(cand);
    // 顺手把「这次想抽的那张」要回来（一次按压至多要一张，免得一口气搬回一堆本体）。
    // 已到手 / 在途 / 已知要不到的 id 由 requestSharedImg 自己跳过
    if (want) requestSharedImg(want.id);
    var ready = readySharedPool(imgs);
    if (!ready.length) return null;
    var one = pickOne(ready);
    return (one && sharedImgs[one.id]) || null;
  }
  // 把 imgs 下标集翻译成 sharedPool 的子集：下标 1 起算（0 / 空 = 随机，落到整池），越界项忽略；
  // 过滤后一张不剩（全是脏值 / 越界）时回退整池，宁可多抽几张也不让整段凭空消失。
  // 整池这一支必须返回 sharedPool 本身：pickOne 的「不与上次重复」记在数组引用上，
  // 每次新建数组等于没有避重（同一张连着抽出来给用户看）。
  function filterSharedPool(imgs) {
    if (!Array.isArray(imgs) || !imgs.length) return sharedPool;
    var out = [];
    for (var i = 0; i < imgs.length; i++) {
      var idx = Math.round(Number(imgs[i]) || 0);
      var e = (idx >= 1 && idx <= sharedPool.length) ? sharedPool[idx - 1] : null;
      if (e && !sharedDead[e.id]) out.push(e);
    }
    return out.length ? out : sharedPool;
  }
  // 「已到手」的那几张（同样按 imgs 限 —— 注意 imgs 的下标指池子位置，不是到手列表的位置）。
  // 不限子集时直接交回 sharedReady，理由同上（数组身份稳定才有避重）。
  function readySharedPool(imgs) {
    if (!Array.isArray(imgs) || !imgs.length) return sharedReady;
    var cand = filterSharedPool(imgs);
    if (cand === sharedPool) return sharedReady;
    var out = [];
    for (var i = 0; i < cand.length; i++) { if (sharedImgs[cand[i].id]) out.push(cand[i]); }
    return out;
  }
  // 重建「已到手」列表：清单换了、新到手一张、淘汰一张、得知一张要不到，都要走这里
  function rebuildSharedReady() {
    var out = [];
    for (var i = 0; i < sharedPool.length; i++) {
      var e = sharedPool[i];
      if (e && sharedImgs[e.id]) out.push(e);
    }
    sharedReady = out;
  }
  // 清单里某张的原图字节数（预算记账用）；清单里没有就按 0，不让预算算飞
  function sharedSizeOf(id) {
    for (var i = 0; i < sharedPool.length; i++) {
      if (sharedPool[i].id === id) return Number(sharedPool[i].size) || 0;
    }
    return 0;
  }
  // 某张在预算里算多少字节。清单一定带 size（宿主按真实文件大小给），这里是异常兜底：
  // 已到手 → 按 base64 长度反推（每 4 字符 ≈3 字节）；还没到手 → 按最坏的一张估。
  // 记账与淘汰必须用同一个口径，否则「加的时候算 90万、减的时候算 0」会把预算一路加爆、
  // 接着把整池淘汰光。
  function sharedCostOf(id) {
    var size = sharedSizeOf(id);
    if (size) return size;
    var url = sharedImgs[id];
    return url ? Math.round(url.length * 0.75) : 900 * 1024;
  }
  // 向宿主单张要一张本体：已到手 / 在途 / 已知要不到的都跳过。
  // 没有真实桥接（单独打开页面调试）时直接不做事，randimg 段维持「没图就不显示」。
  function requestSharedImg(id) {
    if (!id || !whaleApi.requestRandimg) return;
    if (sharedImgs[id] || sharedPending[id] || sharedDead[id]) return;
    sharedPending[id] = true;
    try { whaleApi.requestRandimg(id); } catch (err) { delete sharedPending[id]; }
  }
  // 回包落地。空串 = 那张文件已经不在（用户在文件管理器里清了 userData/whale-skins）：
  // 记成死链，本次会话不再抽它，免得每次按压都白要一次。
  function takeSharedImg(id, url) {
    delete sharedPending[id];
    if (typeof url !== 'string' || !url) { sharedDead[id] = true; rebuildSharedReady(); return; }
    // 重复回包（重推清单时恰好有在途的那次）：本体已经在手里，不必再占一遍预算
    if (sharedImgs[id]) { rebuildSharedReady(); return; }
    sharedImgs[id] = url;
    sharedImgsBytes += sharedCostOf(id);
    // 超预算就淘汰最旧：id 都以字母开头（画廊自生成 k…、官方 DSniang…/s…），
    // 对象键按插入顺序遍历，所以第一个 key 就是最旧那张
    while (sharedImgsBytes > SHARED_CACHE_BYTES) {
      var oldest = null;
      for (var k in sharedImgs) { oldest = k; break; }
      if (oldest === null) break;
      sharedImgsBytes -= sharedCostOf(oldest);
      delete sharedImgs[oldest];
    }
    rebuildSharedReady();
  }
  // 首帧后空闲预取：在字节预算内把本地尽量填满（预算装不下下一张才停，SHARED_PREFETCH 是下限）。
  // 没这一步的话「打开挂件后第一次按压」大概率没图（要一张、回一张十几毫秒，那一泡早就收起来了）。
  // 预取的是**随机**几张而不是「清单前几张」：前几张永远是先下载的那几张，用户会以为随机池坏了。
  // 为什么按预算而不是固定 4 张：池子可能有 36 张，只留 4 张的话 randimg 永远在那几个角色里打转 ——
  // 「抽到不同的共享角色」正是这个模块的看点。预算封顶 ≈10 张，仍然是整池的四分之一不到。
  var sharedPrefetchTimer = null;
  function prefetchSharedImgs() {
    if (sharedPrefetchTimer) { clearTimeout(sharedPrefetchTimer); sharedPrefetchTimer = null; }
    if (!sharedPool.length || !whaleApi.requestRandimg) return;
    if (sharedReady.length >= SHARED_PREFETCH && sharedImgsBytes + sharedCostOf(sharedPool[0].id) > SHARED_CACHE_BYTES) return;
    var want = [];
    for (var i = 0; i < sharedPool.length; i++) {
      var id = sharedPool[i].id;
      if (!sharedImgs[id] && !sharedDead[id]) want.push(id);
    }
    // 洗牌后逐张排空（每张之间隔一下，别把几张 1.5MB 的克隆挤进同一个 tick）
    for (var j = want.length - 1; j > 0; j--) {
      var s = Math.floor(Math.random() * (j + 1)), t = want[j];
      want[j] = want[s]; want[s] = t;
    }
    var n = 0;
    var step = function () {
      sharedPrefetchTimer = null;
      if (n >= want.length) return;
      var id = want[n];
      var cost = sharedCostOf(id);
      if (sharedReady.length >= SHARED_PREFETCH && sharedImgsBytes + cost > SHARED_CACHE_BYTES) return;
      requestSharedImg(id);
      n++;
      if (n < want.length) sharedPrefetchTimer = setTimeout(step, SHARED_PREFETCH_GAP_MS);
    };
    sharedPrefetchTimer = setTimeout(step, SHARED_PREFETCH_FIRST_MS);
  }
  // 收到清单（首推 / 设置页下载或删除后重推）：本体缓存里已经不在池中的那几张当场丢掉，
  // 删一张共享角色不该在挂件里留 1.5MB 尸体。死链标记一并清掉 —— 重新下载过的图要能再试。
  function applySharedPool(data) {
    var list = toList(data), next = [];
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      if (e && typeof e === 'object' && typeof e.id === 'string' && e.id) next.push(e);
    }
    sharedPool = next;
    var keep = {}, bytes = 0;
    for (var j = 0; j < sharedPool.length; j++) {
      var id = sharedPool[j].id;
      keep[id] = true;
      if (sharedImgs[id]) bytes += sharedCostOf(id);
    }
    for (var k in sharedImgs) { if (!keep[k]) delete sharedImgs[k]; }
    sharedImgsBytes = bytes;
    sharedDead = {};
    sharedPending = {};
    rebuildSharedReady();
    prefetchSharedImgs();
  }
  // —— 按压气泡模块取值（渲染器 modText / modImageSrc 回调）——
  // 模板占位符与旧台词同一套（renderLinePlaceholders）；另加四个上游专属 token：
  //   {balance_ds} 余额（同 {balance}）·{expense_ds} 今日已用（同 {today}）·{status} 峰谷状态字·{countdown} 倒计时
  // 认不出的 token 原样留着（与 alertLines 同口径，便于用户发现写错）。模块自带 tpl 为空时用内置自动文本。
  function bubbleModTokenMap() {
    return {
      balance_ds: linePlaceholderValue('balance'),
      expense_ds: linePlaceholderValue('today'),
      status: linePlaceholderValue('peak'),
      countdown: linePlaceholderValue('countdown'),
      balance: linePlaceholderValue('balance'),
      today: linePlaceholderValue('today'),
      peak: linePlaceholderValue('peak'),
      next: linePlaceholderValue('next'),
      change: linePlaceholderValue('change'),
      model: linePlaceholderValue('model'),
      currency: linePlaceholderValue('currency'),
      date: linePlaceholderValue('date'),
      time: linePlaceholderValue('time'),
      weekday: linePlaceholderValue('weekday'),
      session: bubbleSessionText(),
    };
  }
  function bubbleApplyTpl(tpl, autoText) {
    var s = String(tpl == null ? '' : tpl);
    if (!s) return autoText;
    var map = bubbleModTokenMap();
    var keys = Object.keys(map).sort(function (a, b) { return b.length - a.length; });
    for (var i = 0; i < keys.length; i++) {
      var v = map[keys[i]];
      if (v === null || v === undefined) continue;
      s = s.split('{' + keys[i] + '}').join(String(v));
    }
    return s;
  }
  // session 模块：本项目暂无「对话名」数据源，一律占位「—」（锁定决策：全做但占位）
  function bubbleSessionText() {
    return '—';
  }
  // 峰谷状态字（peak 模块按自身 peakStyle 取，不再依赖全局 peakMode；本项目暂只支持 text/mini 两式的语义合并）
  function bubblePeakStatusText(mod) {
    var st = mod && mod.peakStyle;
    var peak = !!state.isPeak;
    if (st === 'mini') return peak ? '峰' : '谷';
    return peakLabelText(peak);
  }
  function bubblePeakModuleText(mod) {
    var st = mod && mod.peakStyle;
    if (st === 'count') return peakCountdownLeftText() || '—';
    return bubblePeakStatusText(mod);
  }
  // 数值模块（balance/bonus/recharge/today）：balance/today 有数据源；bonus/recharge 本项目暂无，回「—」
  function bubbleAmountModuleText(type) {
    if (type === 'balance') return mainAmountText();
    if (type === 'today') return linePlaceholderValue('today');
    return '—';
  }
  // 模块文本回调：按 type 现算自动文本，再套模板（tpl），无数据源回占位「—」
  function bubbleModText(mod) {
    if (!mod || typeof mod !== 'object') return '';
    var type = mod.type;
    if (type === 'text') return renderLinePlaceholders(String(mod.text || ''));
    if (type === 'random') {
      var lines = Array.isArray(mod.lines) ? mod.lines : [];
      if (!lines.length) return '';
      var pick = bubbleRandomPick(mod);
      return renderLinePlaceholders(String((pick && pick.t) || ''));
    }
    if (type === 'link') return renderLinePlaceholders(String(mod.text || mod.url || ''));
    // 报时模块（本插件自有扩展）：自动文本 = 按当前时段取「报时文案池」一句（同小鲸鱼报时口径），
    // 套模板后可写成 {time} / {weekday} 等自定义报时
    if (type === 'time') return bubbleApplyTpl(mod.tpl, timeLabel());
    if (type === 'balance' || type === 'bonus' || type === 'recharge' || type === 'today') {
      return bubbleApplyTpl(mod.tpl, bubbleAmountModuleText(type));
    }
    if (type === 'peak') return bubbleApplyTpl(mod.tpl, bubblePeakModuleText(mod));
    if (type === 'session') return bubbleApplyTpl(mod.tpl, bubbleSessionText());
    if (type === 'quota' || type === 'plan') return bubbleApplyTpl(mod.tpl, bubbleQuotaModuleText(mod));
    return '';
  }
  // random 模块抽取：按台词自带权重 w 抽一条（缺省 1），并按模块对象避重（连着两次不抽同一条）。
  // 口径与 randSegText（段级句池）一致 —— 用模块对象当 WeakMap 键，同一模块跨多次渲染记住上次下标。
  // 抽签结果只在这里定一次，bubbleModText 与 bubbleModPick 都来取它，
  // 保证「文本」与「字号/配色」来自同一条：各自 Math.random() 一次会错位（文本 A、样式 B）
  var randModLast = new WeakMap();
  function bubbleRandomPick(mod) {
    var lines = Array.isArray(mod && mod.lines) ? mod.lines : [];
    if (!lines.length) return null;
    if (lines.length === 1) return lines[0];
    var last = randModLast.get(mod);
    var idx = weightedPick(lines, function (l) { return (l && !Array.isArray(l) && l.w) || 1; }, function () { return last; });
    if (idx < 0) idx = 0;
    randModLast.set(mod, idx);
    return lines[idx];
  }
  // 压中那条台词自带样式的回调（渲染器只认 { size, color, rgb, bold, italic, ul }）：
  // 上游 random 口径就是「字色 / 字号逐条带」，模块级 size 只是兜底；纯字符串台词无色无号 → 回 null
  function bubbleModPick(mod) {
    if (!mod || typeof mod !== 'object' || mod.type !== 'random') return null;
    var pick = bubbleRandomPick(mod);
    if (!pick || typeof pick !== 'object' || Array.isArray(pick)) return null;
    var o = {};
    if (pick.size != null) o.size = pick.size;
    if (pick.color) o.color = pick.color;
    if (pick.rgb) o.rgb = pick.rgb;
    if (pick.bold === true) o.bold = true;
    if (pick.italic === true) o.italic = true;
    if (pick.ul === true) o.ul = true;
    return o;
  }
  // quota/plan 模块：本项目暂无订阅额度 / 订阅窗口数据源，一律占位「—」（全做但占位；tpl 为空时给「—」）
  function bubbleQuotaModuleText() {
    return '—';
  }
  // 模块取图回调：image 用自定义气泡图（imgId 语义同 v1 台词的 img：空/0 = 随机抽一张，
  // 1..N = 指定第 N 张，见 bubbleImgSrc）；randimg 用共享角色池随机抽（与 randimg 段同源）
  function bubbleModImageSrc(mod) {
    if (!mod || typeof mod !== 'object') return null;
    if (mod.type === 'image') return bubbleImgSrc(mod.imgId);
    if (mod.type === 'randimg') return randImgSrc(mod.imgs);
    return null;
  }
  // 模块动态样式回调（渲染器 modStyle）：只有峰谷模块需要 —— 它自带两套配色，取哪套取决于
  // 当前是峰还是谷，而这个是运行时状态，渲染器无从得知。回 null 表示「不覆盖，用模块自带值」
  function bubbleModStyle(mod) {
    if (!mod || typeof mod !== 'object' || mod.type !== 'peak') return null;
    var peak = !!state.isPeak;
    // 对象里只放有值的键：空串键会被渲染器当成「没回」而忽略，与不回等价，但白占内存
    var o = {};
    if (peak) {
      if (mod.peakColor) o.color = mod.peakColor;
      if (mod.peakRgb) o.rgb = mod.peakRgb;
      if (mod.peakBg) o.bg = mod.peakBg;
      // 峰态徽章底：默认模板把「峰」做成白字压 rouge 底；漏传它会让白字压在白卡上、整个字隐形（显示不清楚）
      if (mod.peakBgRgb) o.bgRgb = mod.peakBgRgb;
    } else {
      if (mod.offColor) o.color = mod.offColor;
      if (mod.offRgb) o.rgb = mod.offRgb;
      if (mod.offBg) o.bg = mod.offBg;
      if (mod.offBgRgb) o.bgRgb = mod.offBgRgb;
    }
    return o;
  }
  // —— 拖拽台词 ——
  // 真把挂件拖出一段距离（松手位移 ≥100px）才弹：drag.moved 3px 就置位，日常挪一下位置不该触发。
  // 独立键 cfg.dragLines，不进 QUOTES：它不属固定文案池，但**可在设置页单独编辑**，
  // 由 applyConfig 覆盖。字面量须与宿主 store.js 的 DRAG_LINES_DEFAULT 一致（check-shared 钉住）
  var DRAG_LINES = ['哇——轻点轻点！', '起飞咯——', '放我下来！……好吧，再玩一次。', '晕鱼了晕鱼了……'];
  var DRAG_QUOTE_SQ = 100 * 100;       // 触发阈值的平方（比较平方距离，省开方）
  var DRAG_QUOTE_COOLDOWN = 60 * 1000; // 冷却：连拖几次（如甩到屏幕另一侧）只弹第一句
  var DRAG_QUOTE_MS = 7 * 1000;        // 停留 7s：比随机台词（5s）多 2 秒，拖拽是主动逗鱼
  var lastDragQuoteAt = 0;
  function showDragQuote(distSq) {
    if (distSq < DRAG_QUOTE_SQ) return;
    if (Date.now() - lastDragQuoteAt < DRAG_QUOTE_COOLDOWN) return;
    // 优先级与提醒类入口（showRemindBubble）同口径：计时中不打断，气泡总开关关闭时不弹
    if (!bubbleOn || timerActive() || bubbleRemindActive) return;
    lastDragQuoteAt = Date.now();
    // 新按压气泡模型自带拖拽台词：开着 bubble.on 时优先用它，且同样按模块式渲染；
    // 与顶层 DRAG_LINES 各管各 —— bubbleDragLines 为空则回退顶层台词。
    if (bubbleModelOn && bubbleDragLines.length) {
      var dlines = { mods: [{ type: 'text', text: pickOne(bubbleDragLines), row: 1 }] };
      renderer.cancelGifFade();
      bubbleActive = false; bubblePreviewItems = null; // 拖拽台词是临时接管，压过整条队列
      if (bubbleSwapTimer) { clearTimeout(bubbleSwapTimer); bubbleSwapTimer = null; }
      if (bubbleTimer) { clearTimeout(bubbleTimer); bubbleTimer = null; }
      if (bubbleShown) swapBubbleContent(function () { applyBubbleLines(dlines); });
      else {
        bubbleShown = true;
        restoreBubbleLines();
        applyBubbleLines(dlines);
        bubbleBox.classList.add('dshwv-bubble-open');
      }
      bubbleArm(DRAG_QUOTE_MS, hideBubble);
      return;
    }
    var lines = singleCenter('A', pickOne(DRAG_LINES), '', true);
    bubbleActive = false; bubbleRandomActive = true; // 临时接管：按随机台词口径，点气泡收起
    bubbleRandomLines = lines;
    bubblePreviewActive = false; // 拖拽台词接管内容，试播会话整段作废
    previewSession = null; bubblePreviewItems = null;
    if (bubbleSwapTimer) { clearTimeout(bubbleSwapTimer); bubbleSwapTimer = null; }
    if (bubbleTimer) { clearTimeout(bubbleTimer); bubbleTimer = null; }
    renderer.cancelGifFade();
    if (bubbleShown) {
      // 气泡已开着（多是刚点过鲸鱼）：原地淡入换词，不要闪一下
      swapBubbleContent(function () { applyBubbleLines(lines); });
    } else {
      bubbleShown = true;
      restoreBubbleLines();
      applyBubbleLines(lines);
      bubbleBox.classList.add('dshwv-bubble-open');
    }
    // 拖拽台词比随机台词多停 2 秒：玩拖拽是主动逗鱼，收太快扫兴（随机台词 5s 是被动阅读节奏）
    bubbleArm(DRAG_QUOTE_MS, hideBubble);
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
  // 报时：按小时选池（四池全时段开放，用户可在设置页分别编辑）。
  // 深夜(<6)/清晨(6-10)/白天(11-22)/深夜前(>=23)；每池抽一条，{t} 换成当前时间。
  // 同一 HH:MM 只抽一次：倒计时页的标题行每秒都会被重算，重抽会让台词秒秒乱跳
  var timeLblAt = '', timeLbl = '';
  function timeLabel() {
    var d = new Date();
    var t = pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    if (t === timeLblAt) return timeLbl;
    var h = d.getHours();
    var pool;
    if (h < 6) pool = QUOTES.timeEarly;
    else if (h < 11) pool = QUOTES.timeMorning;
    else if (h < 23) pool = QUOTES.time;
    else pool = QUOTES.timeEve;
    // 池为空（理论上不会，宿主与本地兜底都非空）时退回白天池，别让报时没字
    if (!Array.isArray(pool) || !pool.length) pool = QUOTES.time;
    timeLblAt = t;
    return (timeLbl = pickOne(pool).split('{t}').join(t));
  }
  function singleCenter(style, text, color, wrap) { return [null, { t: text, s: style, c: color || '', w: !!wrap }, null]; }
  function fmt(balance, currency) {
    // 遮蔽态统一占位：调用方拿到的仍是「已格式化好的金额字符串」，不关心具体数值
    if (hideAmounts) return '***';
    var num = Number(balance);
    var fixed = isFinite(num) ? num.toFixed(2) : '--';
    return currency === 'CNY' ? '¥ ' + fixed : fixed + ' ' + currency;
  }
  // 币种符号：{currency} 占位符用（CNY→¥ / USD→$ / 其余原样返回代码，不硬造符号）
  function currencySymbol(currency) {
    return MODEL_MONEY_PREFIX[currency] != null ? String(MODEL_MONEY_PREFIX[currency]).trim() : String(currency || '');
  }
  // 周几标签：{weekday} 占位符用（索引与 Date.getDay() 对齐，0=周日）
  var WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
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
    if (hideAmounts) return '***';
    var num = Number(v);
    var fixed = isFinite(num) ? num.toFixed(2) : '--';
    var pre = MODEL_MONEY_PREFIX[currency];
    return pre ? pre + fixed : fixed + ' ' + String(currency || '');
  }
  // 少数场景（复制到剪贴板）要的是真实数字，不能把 *** 复制进去。
  // 这里只临时关掉显示开关，不改存储、不重绘，做完立即还原
  function withRealAmounts(fn) {
    var prev = hideAmounts;
    hideAmounts = false;
    try { return fn(); } finally { hideAmounts = prev; }
  }
  // 金额遮蔽按钮：同一枚按钮同时承担「切换」和「状态指示」（aria-pressed + 图标一划）
  function updateMaskBtnUi() {
    if (!maskBtn) return;
    maskBtn.innerHTML = hideAmounts ? EYE_OFF_SVG : EYE_SVG;
    maskBtn.title = hideAmounts ? '显示金额（当前已遮蔽）' : '遮蔽金额（旁边有人时用）';
    maskBtn.setAttribute('aria-label', maskBtn.title);
    maskBtn.setAttribute('aria-pressed', hideAmounts ? 'true' : 'false');
  }
  // 即时生效：先本地翻转 + 重绘，再把状态交给宿主持久化（没有动画、没有 toast）
  function toggleHideAmounts() {
    hideAmounts = !hideAmounts;
    updateMaskBtnUi();
    render();
    try { whaleApi.saveConfig({ hideAmounts: hideAmounts }); } catch (err) { logErr('[whale][page] 保存金额遮蔽失败', err); }
  }
  function resetTail(ms) {
    var t = Number(ms) || 0;
    if (!t) return '';
    var d = new Date(t);
    return ' · ' + (d.getMonth() + 1) + '-' + d.getDate() + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ' 重置';
  }
  // 倒计时占标题行：`下班 08:12:34` —— 只留「标签 + 倒计时」。上下班区间与「距上班」都已去掉
  // （前者设置页能看、后者与本行重复，还都挤标题行宽度；2026-11-09 用户要求简洁高效）。
  // 最后 10 分钟（与橙红呼吸同档）换「快到点了」；已下班 / 休息日补半句口语：只在标题行，不弹窗不响铃
  function offworkTitleText(ov) {
    var label = ov.phase === 'work' && ov.near === 'imminent' ? '快到点了' : ov.label;
    if (ov.phase === 'after') label = '已下班 溜了溜了';
    if (ov.phase === 'off') label = '休息日 葛优躺中';
    return label + ' ' + ov.main;
  }
  // 常规标题行：主显示不是 DeepSeek 时用模型名（报时 / 倒计时只属于内置 DeepSeek）；
  // 内置 DeepSeek 下：停在倒计时页由它占位（该页就是为倒计时存在的），其余页 报时 > 「DeepSeek 余额」
  function defaultLabelText() {
    if (mainModelId !== 'deepseek') {
      var m = currentModel();
      var suffix = m && m.kind === 'quota' ? ' 额度' : (m && m.kind === 'codex' ? ' 用量' : ' 余额');
      return (m ? m.name : '模型') + suffix;
    }
    // 气泡收起时没有「页」：报时开着就让它占位（倒计时等翻到它那一页）；报时关着则保持原来的常驻倒计时
    if (offworkCanRender() && (bubbleActive || !timeBubbleOn)) {
      var ov = offworkState();
      if (ov) return offworkTitleText(ov);
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
  // 台词占位符。DeepSeek 专属口径（余额/今日已用/峰谷/倒计时/变化）在主显示换成别的模型时
  // 不再更新（见 handleBalance 的提前返回），此时给空串而不是旧值，免得台词里报出一个早就过期的值。
  // 认不出的占位符原样保留（与提醒文案 alertLines 同一口径），便于用户发现写错。
  //   {balance} 当前主显示金额   {today} 今日已用   {peak} 当前时段   {next} 距下次峰谷切换
  //   {model} 主显示模型名       {currency} 币种符号（¥ / $ / 原币种代码）
  //   {date} 月-日   {time} 时:分   {weekday} 周几（本地时间，页面现算）
  //   {change} 本轮余额降幅（自动采样才有值，手动刷新/无变化给 0）
  //   {countdown} 与 {next} 同源（距下次峰谷切换），单独留名便于用户按语义书写
  function linePlaceholderValue(k) {
    if (k === 'balance') return mainAmountText();
    if (k === 'model') return (currentModel() && currentModel().name) || (mainModelId === 'deepseek' ? 'DeepSeek' : mainModelId);
    if (k === 'currency') return currencySymbol(mainModelId === 'deepseek' ? state.currency : (currentModel() && currentModel().currency) || state.currency);
    if (k === 'date') { var d1 = new Date(); return (d1.getMonth() + 1) + '-' + d1.getDate(); }
    if (k === 'time') { var d2 = new Date(); return pad2(d2.getHours()) + ':' + pad2(d2.getMinutes()); }
    if (k === 'weekday') return WEEKDAY_LABELS[new Date().getDay()];
    // 以下几项都是 DeepSeek 口径：主显示不是内置 DeepSeek 时一律空串
    if (k !== 'today' && k !== 'peak' && k !== 'next' && k !== 'change' && k !== 'countdown') return null;
    if (mainModelId !== 'deepseek') return '';
    if (k === 'today') return (state.todayUsage === null || state.todayUsage === undefined) ? '--' : fmt(state.todayUsage, state.currency);
    if (k === 'peak') return peakLabelText(!!state.isPeak);
    if (k === 'change') { var ch = Number(state.change) || 0; return ch > 0 ? '-' + fmt(ch, state.currency) : fmt(0, state.currency); }
    return peakCountdownLeftText();
  }
  // 占位符在「这一组真被抽到」时才替换：抽签那一刻换会拿到上一轮刷新的旧余额
  function renderLinePlaceholders(text) {
    return String(text == null ? '' : text).replace(/\{(\w+)\}/g, function (m, k) {
      var v = linePlaceholderValue(k);
      return v === null ? m : v;
    });
  }
  // 通用「按权重抽下标」纯函数：累减权重抽一次；若命中上次的下标且池子 ≥2，就在「其余元素」
  // 里按权重再抽一次——与 pickOne 的设计理由相同（不是简单 ±1 平移，避免总抽到相邻项）。
  // lastOf 是「取上次下标的回调」（可为 null，此时不避重），返回抽中的下标；空池返回 -1。
  // 供 randSegText 的段级随机句池抽取复用
  function weightedPick(arr, wOf, lastOf) {
    var n = arr.length;
    if (!n) return -1;
    if (n < 2) return 0;
    var last = lastOf ? lastOf() : -1;
    function draw(skip) {
      var total = 0, i;
      for (i = 0; i < n; i++) { if (i !== skip) total += wOf(arr[i]); }
      if (!(total > 0)) return -1; // 其余项权重全为 0：无从抽，交给调用方定
      var r = Math.random() * total;
      for (i = 0; i < n; i++) {
        if (i === skip) continue;
        r -= wOf(arr[i]);
        if (r < 0) return i;
      }
      return -1;
    }
    var i = draw(-1);
    if (i === last) { var j = draw(last); if (j >= 0) i = j; }
    return i;
  }
  // 段级随机句池取字（random 段）：按 { t, wt } 加权抽一条，并按段对象记住上次抽中的下标避重。
  // 句池是静态的，同一段在多次渲染间复用同一对象，用 WeakMap 记「上次下标」最省事
  var randSegLast = new WeakMap();
  function randSegText(seg) {
    var lines = seg && seg.lines;
    if (!Array.isArray(lines) || !lines.length) return '';
    if (lines.length === 1) return typeof lines[0] === 'string' ? lines[0] : (lines[0].t || '');
    var last = randSegLast.get(seg);
    var idx = weightedPick(lines, function (l) { return (l && !Array.isArray(l) && l.wt) || 1; }, function () { return last; });
    if (idx < 0) idx = 0;
    randSegLast.set(seg, idx);
    var picked = lines[idx];
    return typeof picked === 'string' ? picked : (picked && picked.t) || '';
  }
  // 试播会话推进：展示 steps[idx+1]，重挂自动收起；末条返回 false 由调用方收起气泡。
  // 该屏带停留秒数（step.dwell）时另布自动翻页定时器——到点没被点就走下一屏（参考外部
  // 「泡泡队列」交互：每泡可设停留时长，无人点击也能自己推进），点击翻页会清掉它重来
  function previewSessionNext() {
    if (!previewSession) return false;
    if (previewSession.idx + 1 >= previewSession.steps.length) return false;
    previewSession.idx += 1;
    var step = previewSession.steps[previewSession.idx];
    swapBubbleContent(function () { applyBubbleLines(step); });
    previewArmDwell(step);
    bubbleArmFor(step && step.dwell, hideBubble);
    return true;
  }
  // 试播会话的停留翻页定时器：一屏一个，到点推进；会话结束/被点击重布时清掉
  var previewDwellTimer = null;
  function previewArmDwell(step) {
    if (previewDwellTimer) { clearTimeout(previewDwellTimer); previewDwellTimer = null; }
    if (!previewSession || !step) return;
    var d = Number(step && step.dwell);
    if (!isFinite(d) || d < 1 || d > 120) return; // 没配停留秒数：维持纯点击翻页
    previewDwellTimer = setTimeout(function () {
      previewDwellTimer = null;
      if (!bubblePreviewActive || !previewSession) return;
      if (!previewSessionNext()) hideBubble(); // 末屏到点也自动收，与点击语义一致
    }, Math.round(d * 1000));
  }
  function previewDwellClear() {
    if (previewDwellTimer) { clearTimeout(previewDwellTimer); previewDwellTimer = null; }
  }

  // —— 按压气泡（v3 自定义泡泡模型）——
  // 挂件常规气泡内容的产出路径：bubble.on 开启时由这里产出。
  // 每一步（item）是一个「泡」：单选 {kind:'custom', modules} 或并列 {kind:'choice', options:[{w,item}]}；
  // 并列泡每次呈现时按权重抽一个候选（上游 A/B 并列泡口径）。渲染复用 renderer.applyMods，
  // 内容以 { mods } 形态交给它（applyLines 内部的 mods 分支）。
  // 按权重抽候选下标（avoidIdx 用于不连续重复上一候选）：与上游 bubblePickLine 同口径
  function bubblePickOptionIdx(options, avoidIdx) {
    if (!options || !options.length) return -1;
    if (options.length === 1) return 0;
    var total = 0;
    for (var i = 0; i < options.length; i++) total += Math.max(1, Number(options[i].w) || 1);
    var pick = 0;
    for (var guard = 0; guard < 6; guard++) {
      var r = Math.random() * total, acc = 0;
      pick = options.length - 1;
      for (var j = 0; j < options.length; j++) {
        acc += Math.max(1, Number(options[j].w) || 1);
        if (r < acc) { pick = j; break; }
      }
      if (pick !== avoidIdx) break;
    }
    return pick;
  }
  var bubbleLastOptionIdx = -1; // 并列泡避重：上次呈现的候选下标
  // 一步 → 要渲染的模块数组：单选直取；并列按权重抽一个候选（记录避重下标）。
  // exclude 是本次重试里已试过且渲染为空的下标（避免反复抽中同一个空气泡）
  function bubbleStepModules(step, exclude) {
    if (!step || typeof step !== 'object') return null;
    if (step.kind === 'choice') {
      var opts = Array.isArray(step.options) ? step.options : [];
      var real = [];
      for (var i = 0; i < opts.length; i++) { if (!exclude || exclude.indexOf(i) < 0) real.push(i); }
      if (!real.length) return null;
      // 在「未试过」的候选里按权重抽：把候选下标映射成临时数组交给 bubblePickOptionIdx
      var pick = bubblePickOptionIdx(real.map(function (k) { return { w: opts[k].w, item: opts[k].item }; }), -1);
      var idx = pick >= 0 ? real[pick] : real[0];
      bubbleLastOptionIdx = idx;
      var opt = opts[idx];
      return opt && opt.item ? opt.item.modules : null;
    }
    return Array.isArray(step.modules) ? step.modules : null;
  }
  // 呈现一步：无模块内容时整泡不出（applyBubbleLines({mods:null}) 让渲染器三行全藏）。
  // 并列泡抽中的候选可能渲染成空气泡（典型：候选是 randimg，而用户一张共享角色都没装 ——
  // 取图回 null 整段丢，模块区 count 归 0）。这时在「还没试过」的候选里继续抽，直到渲染出内容；
  // 全候选都空（如整泡只有 randimg）才认命，与单选泡行为一致。
  function bubbleRenderStep(step) {
    if (!PAGES.isCustom(step)) { restoreBubbleLines(); return; } // 倒计时页走常规三行，不归模型渲染
    if (step && step.kind === 'choice' && Array.isArray(step.options) && step.options.length > 1) {
      var tried = [];
      for (var guard = 0; guard < step.options.length; guard++) {
        var mods = bubbleStepModules(step, tried);
        if (applyBubbleLines({ mods: mods })) return;
        if (bubbleLastOptionIdx >= 0) tried.push(bubbleLastOptionIdx);
      }
      // 全部候选都渲染不出内容：最后一次尝试的结果留在屏上（空泡），由调用方按原语义处理
      return;
    }
    applyBubbleLines({ mods: bubbleStepModules(step, null) });
  }
  // 推进到下一步（点击语义）：末步返回 false 由调用方收起
  function bubbleNext() {
    var q = bubbleQueue();
    if (bubbleIdx + 1 >= q.length) return false;
    bubbleIdx += 1;
    var step = q[bubbleIdx];
    swapBubbleContent(function () { bubbleRenderStep(step); });
    bubbleArm(PAGES.isCustom(step) ? bubbleModelDwellMs : bubbleDwellMs, hideBubble); // 停留时长按目标页口径
    return true;
  }
  // 设置页「按压气泡试播」：把当前编辑的整份 items 发来挂成会话，点挂件气泡顺序翻条，
  // 末条再点收起；停留时长走 bubble.dwell（无人点击也能自动推进）
  function showBubblePreviewBubble(payload) {
    if (!bubbleOn || timerActive()) return;
    var data = payload && typeof payload === 'object' ? payload : {};
    var items = Array.isArray(data.items) ? data.items : [];
    if (!items.length) return;
    if (bubbleTimer) { clearTimeout(bubbleTimer); bubbleTimer = null; }
    renderer.cancelGifFade();
    bubbleActive = true;
    bubbleRandomActive = false;
    bubbleRandomLines = null;
    bubbleRemindActive = false;
    bubbleRemindLines = null;
    bubbleTimerActive = false;
    bubblePreviewActive = false;
    previewSession = null;
    bubbleLastOptionIdx = -1;
    // 试播只临时顶替队列，不写 bubbleItems / bubbleIdx（那是正式队列的依据，会被翻错页）
    bubblePreviewItems = items.slice();
    bubbleIdx = 0;
    var first = items[0];
    if (bubbleShown) {
      swapBubbleContent(function () { bubbleRenderStep(first); });
    } else {
      bubbleShown = true;
      restoreBubbleLines();
      bubbleRenderStep(first);
      bubbleBox.classList.add('dshwv-bubble-open');
    }
    bubbleArm(bubbleModelDwellMs, hideBubble);
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
  var timerArg = '';         // 倒计时时长的秒数串（如 '1500'）/ 定时 'HH:MM'；正计时为空
  var timerNote = '';        // 到点要做什么：开始前写的留言，到点后显示在气泡与通知里
  // 休息轮：到点后点「休息 N 分钟」起的那一轮。必须与专注轮分开，否则休息会被记成
  // 专注分钟、气泡还挂着「专注：xxx」、休息完「再来一轮」也按休息时长重启
  var timerIsBreak = false;   // 这一轮是休息：不记专注、不挂专注尾注、到点不给「休息 / 完成这条」
  var timerReported = false;  // 本轮已记账（到点或放弃）：防止「到点后重置」「重载后补弹时间到」再记一次
  var timerBreakBackSec = 0;  // 休息前的专注时长（秒）：休息结束还原给 timerArg，供「继续专注」
  var timerBreakSec = 0;      // 本次休息时长（秒）：刻意不写进三段时间输入框 —— 那是专注时长，
                              // 写进去会被 saveCfg 的 timerSec 永久覆盖，用户下次专注就变 5 分钟了
  var timerBreakMin = TIMER_BREAK_DEFAULT; // 到点后「休息」按钮的分钟数（0 = 不显示该按钮）
  // 番茄循环：短休/长休/每 N 轮/自动衔接。与 timerBreakMin 正交 —— 后者是手动「休息」按钮的时长，
  // 前者是计时结束后自动进入的休息轮。两者可单独使用也可组合
  var timerPomoOn = false;       // 是否开启番茄循环
  var timerLongBreakMin = 15;    // 长休时长（分钟，1–60）
  var timerLongEvery = 4;        // 每几轮专注后进入长休（2–12）
  // 到点自动衔接下一条待办（cfg.todoAutoNext，默认关）。v1.15 曾把「无条件自动衔接」硬移除，
  // 问题不在功能本身而在它必须显式开启：这里既尊重开关，又保留到点气泡上的「取消衔接」。
  // 与番茄循环正交：番茄管轮与轮之间怎么休息，这个只管「这条做完要不要接下一条」
  var todoAutoNext = false;
  // 衔接等待时长：1.5s 太短 —— 气泡刚出来就切走了，用户根本来不及读下一条是什么、
  // 更来不及点「取消衔接」。5 秒够看完「✓ 刚做完 → 下一条是谁」再决定，代价只是多等 5 秒
  var AUTO_NEXT_DELAY_MS = 5000;
  var autoNextTimer = null;      // 等待自动衔接的计时器句柄（null = 没有等待中的衔接）
  var timerCycle = 0;            // 番茄循环的排程位（0 = 未开始/非番茄模式）：只决定「第几轮进长休」，不是账本 —— 只有 timerPomoOn 开着才递增，专注记录关着时也照走
  var timerCycleDate = '';       // 记录 cycle 的日期（YYYY-MM-DD），跨日归零
  var timerAtSpan = 0;           // 「定时」模式的总跨度（毫秒）：进度环需要它当总量，暂停/恢复也不丢
  var timerRemindSec = 8;    // 到点提醒气泡停留秒数（0 = 常驻，手动点气泡关闭）
  var timerBubblePin = true; // 计时中气泡是否常驻显示（关闭则只短暂显示，点小鲸鱼可再看）
  var timerBubbleOnly = true; // 气泡是否只显示计时：关掉后气泡照常显示余额/用量等全部内容
  // 宿主配置里「默认时长 / 默认模式 / 定时刻」最近一次见到的值：只有它们真的变了才回填。
  // 菜单里的时长与模式是「这一轮」的草稿 —— 若每次配置广播都按 cfg 重写，
  // 用户改完目标、随手调一下音量（也会广播配置），目标就被打回默认值了。
  // pendingTimerSec：计时中收到新的默认时长先压着，等回到空闲再落到目标输入框（见 syncTimerMenu）
  var cfgTimerSecSeen = null;
  var cfgTimerModeSeen = null;
  var cfgTimerAtSeen = null;
  var pendingTimerSec = null;
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
  timerBreakBtn.addEventListener('click', function () {
    cancelPomoAutoNext(); // 用户手动操作，取消自动衔接
    // 番茄循环开启时，按 cycle 判断用短休还是长休时长
    var breakMin = (timerPomoOn && shouldLongBreak()) ? timerLongBreakMin : timerBreakMin;
    repeatTimerTimer(breakMin * 60, true);
  });
  var timerAgainBtn = document.createElement('button');
  timerAgainBtn.type = 'button';
  timerAgainBtn.className = 'dshwv-timer-act';
  timerAgainBtn.textContent = '再来一轮';
  timerAgainBtn.title = '按上次的目标接着计时';
  timerAgainBtn.addEventListener('click', function () { cancelPomoAutoNext(); repeatTimerTimer(0); });
  var timerDoneBtn = document.createElement('button');
  timerDoneBtn.type = 'button';
  timerDoneBtn.className = 'dshwv-timer-act';
  timerDoneBtn.textContent = '知道了';
  timerDoneBtn.title = '收起提醒（计时已结束）';
  timerDoneBtn.addEventListener('click', function () { cancelPomoAutoNext(); hideBubble(); });
  // 到点接力：完成当前待办后把「下一条」摆到气泡下方，点一下才启动。
  var timerNextBtn = document.createElement('button');
  timerNextBtn.type = 'button';
  timerNextBtn.className = 'dshwv-timer-act dshwv-timer-act-main';
  timerNextBtn.textContent = '开始下一条';
  timerNextBtn.title = '开始下一条待办的计时';
  timerNextBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    startNextTodo();
  });
  // 专注闭环的收尾：这一轮走完，把正在专注的待办直接勾掉（省得再开菜单找）
  var timerTodoBtn = document.createElement('button');
  timerTodoBtn.type = 'button';
  timerTodoBtn.className = 'dshwv-timer-act';
  timerTodoBtn.textContent = '完成这条';
  timerTodoBtn.title = '把当前专注的待办标为已完成';
  timerTodoBtn.addEventListener('click', function () {
    cancelPomoAutoNext();
    var it = todoFocusItem();
    if (!it) return;
    // todoOn 关闭时保持旧行为：完成即收起，不接力（清单本来就不在挂件里显示）
    if (!todoOn) {
      whaleApi.todoSend({ op: 'toggle', id: it.id });
      hideBubble();
      return;
    }
    enterHandoff(it);
  });
  // 自动衔接的显式取消。原先只有「点挂件任意处」能取消，但那既不可见、又容易误触：
  // 用户想点「知道了」而点偏一点，自动衔接就被悄悄取消了。改成给一个明确的按钮，
  // 并收回「点任何地方都取消」的隐式行为（见 document 上的 pointerdown）。
  // v1.15 曾随自动衔接一起下架，v1.17 待办自动衔接恢复后重新上岗
  var timerPomoCancelBtn = document.createElement('button');
  timerPomoCancelBtn.type = 'button';
  timerPomoCancelBtn.className = 'dshwv-timer-act';
  timerPomoCancelBtn.textContent = '取消衔接';
  timerPomoCancelBtn.title = '停在这里，不自动开始下一条待办';
  timerPomoCancelBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    cancelPomoAutoNext();
    // 只取消衔接、不丢接力态：下一条是谁仍显示在气泡里，用户还能手动点「开始下一条」
    render();
    updateTimerActions();
  });
  timerDoneActions.appendChild(timerBreakBtn);
  timerDoneActions.appendChild(timerAgainBtn);
  timerDoneActions.appendChild(timerTodoBtn);
  timerDoneActions.appendChild(timerNextBtn);
  timerDoneActions.appendChild(timerPomoCancelBtn);
  timerDoneActions.appendChild(timerDoneBtn);
  document.body.appendChild(timerDoneActions);

  // —— 到点接力：完成当前待办 → 气泡显示下一条 → 用户点一下才启动 ——
  function clearTimerHandoff() {
    if (handoffVerifyTimer) { clearTimeout(handoffVerifyTimer); handoffVerifyTimer = null; }
    timerHandoff = null;
  }
  // 标记完成是子→父 IPC，没有返回值；等宿主回推后再校验一次，避免写失败时假装完成。
  function scheduleHandoffVerify() {
    if (handoffVerifyTimer) clearTimeout(handoffVerifyTimer);
    handoffVerifyTimer = setTimeout(function () {
      handoffVerifyTimer = null;
      if (!timerHandoff) return;
      var it = null;
      var items = (todoState && todoState.items) || [];
      for (var i = 0; i < items.length; i++) if (items[i].id === timerHandoff.doneId) { it = items[i]; break }
      if (!it || !it.done) {
        clearTimerHandoff();
        showTimerBubble(timerRemindMs());
      }
    }, 1200);
  }
  function enterHandoff(it) {
    if (!it) { hideBubble(); return; }
    cancelPomoAutoNext();
    var next = nextUnfinishedTodo(it.id);
    timerHandoff = {
      doneId: it.id,
      doneText: String(it.text || ''),
      nextId: next ? next.id : '',
      nextText: next ? String(next.text || '') : '',
      nextTimerLabel: next ? todoTimerLabel(next) : '',
      nextMode: next ? (next.tm === 'up' || next.tm === '' ? next.tm : 'down') : '',
      changed: false,
    };
    todoJustDone[it.id] = true;
    whaleApi.todoSend({ op: 'toggle', id: it.id });
    showTimerBubble(0);
    scheduleHandoffVerify();
  }
  function startNextTodo() {
    if (!timerHandoff) return;
    var next = null;
    var items = (todoState && todoState.items) || [];
    for (var i = 0; i < items.length; i++) {
      if (items[i].id === timerHandoff.nextId && !items[i].done) { next = items[i]; break }
    }
    if (!next) {
      next = nextUnfinishedTodo(timerHandoff.doneId);
      if (!next) {
        timerHandoff.nextId = '';
        timerHandoff.nextText = '';
        timerHandoff.nextTimerLabel = '';
        timerHandoff.nextMode = '';
        timerHandoff.changed = true;
        showTimerBubble(0);
        return;
      }
      timerHandoff.nextId = next.id;
      timerHandoff.nextText = String(next.text || '');
      timerHandoff.nextTimerLabel = todoTimerLabel(next);
      timerHandoff.nextMode = next.tm === 'up' || next.tm === '' ? next.tm : 'down';
    }
    // 用点击这一刻重查到的任务重算模式：入接力后设置页可能把这条改成「不计时」
    var mode = next.tm === 'up' || next.tm === '' ? next.tm : 'down';
    clearTimerHandoff();
    if (mode === '') {
      if (next.id !== todoState.focusId) whaleApi.todoSend({ op: 'focus', id: next.id });
      hideBubble();
      return;
    }
    startTodoTimer(next);
  }

  // 两位补零：报时 / 计时 / 重置时刻统一共用（原先 timeLabel 内另抄了一份 p2；
  // 待办提醒编辑器的时刻回填 / 换算也用这一份）
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  // 本地日期键（YYYY-MM-DD）：番茄轮次的「跨日归零」必须按用户本地日历算。
  // 早先用 toISOString() 取的是 UTC 日期 —— 东八区 0–8 点时它会退回「昨天」，
  // 番茄轮次要到早上 8 点才归零，跨零点反而继续累计。
  function localDayKey() {
    var d = new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }
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
  // 把「默认时长」写进三段输入框。焦点所在的那一格跳过：用户正在编辑时被覆盖，
  // 看起来就像「输入实时生效」。只在宿主默认值真的变化时才走到这里（见 applyConfig）
  function timerEditing(el) { return document.activeElement === el; }
  function writeTimerTargetSec(sec) {
    var ts = Math.min(TIMER_MAX_SEC, Math.max(1, Math.round(Number(sec)) || TIMER_MIN_DEFAULT * 60));
    if (!timerEditing(timerHour)) timerHour.value = String(Math.floor(ts / 3600));
    if (!timerEditing(timerMin)) timerMin.value = String(Math.floor((ts % 3600) / 60));
    if (!timerEditing(timerSec)) timerSec.value = String(ts % 60);
  }
  function timerActive() { return timerRunning || timerPaused || timerFinished; }
  // 休息按钮的显隐 / 文案：正常到点与接力态共用一份计算。
  function updateBreakButton() {
    // 休息轮自己的到点：不再给「休息」（刚休息完）也不给「完成这条」（这一轮没在专注）
    // 番茄循环开启时，按 cycle 判断下一轮是短休还是长休，决定按钮显隐与文案
    var breakMin = timerBreakMin;
    var isLongBreak = false;
    if (timerPomoOn) {
      isLongBreak = shouldLongBreak();
      breakMin = isLongBreak ? timerLongBreakMin : timerBreakMin;
    }
    timerBreakBtn.style.display = (breakMin > 0 && !timerIsBreak) ? '' : 'none';
    // 区分长休/短休文案：番茄循环开启时明确标注，用户一眼知道下一轮是哪种休息
    var breakPrefix = (timerPomoOn && isLongBreak) ? '长休' : '休息';
    timerBreakBtn.textContent = breakPrefix + ' ' + breakMin + ' 分钟';
    if (timerPomoOn && isLongBreak) {
      timerBreakBtn.title = '已完成 ' + timerCycle + ' 轮专注，进入长休（每 ' + timerLongEvery + ' 轮一次）';
    } else if (timerPomoOn) {
      timerBreakBtn.title = '短休 ' + timerCycle + '/' + timerLongEvery + ' 轮，下次长休';
    } else {
      timerBreakBtn.title = '';
    }
  }
  // —— 到点动作条：只有「时间到 / 接力」且气泡在显示时才出现（挂在 body 上，定位到气泡下缘） ——
  function updateTimerActions() {
    if (timerHandoff) {
      if (!bubbleShown) { timerDoneActions.classList.remove('dshwv-actions-open'); return; }
      updateBreakButton();
      timerNextBtn.style.display = timerHandoff.nextId ? '' : 'none';
      timerNextBtn.textContent = timerHandoff.nextMode === '' ? '设为专注' : '开始下一条';
      timerNextBtn.title = timerHandoff.nextMode === ''
        ? '把下一条设为当前专注（该条设为不计时）'
        : '开始下一条待办的计时';
      timerAgainBtn.style.display = 'none';
      timerTodoBtn.style.display = 'none';
      // 「取消衔接」只在「还有一条待接」且确实处于自动衔接等待中时出现：
      // 手动点的「开始下一条」不该长出一个取消按钮（没有等待期可取消），
      // 而没有下一条时点它也没有意义
      timerPomoCancelBtn.style.display = (autoNextTimer && timerHandoff.nextId) ? '' : 'none';
      timerDoneBtn.style.display = '';
      timerDoneActions.classList.add('dshwv-actions-open');
      positionTimerActions();
      return;
    }
    if (!timerFinished || !bubbleShown) { timerDoneActions.classList.remove('dshwv-actions-open'); return; }
    updateBreakButton();
    timerNextBtn.style.display = 'none';
    timerDoneBtn.style.display = '';
    // 「完成这条」只在有正在专注的待办时出现（focusOn 不再门控）
    timerTodoBtn.style.display = (!timerIsBreak && todoFocusText()) ? '' : 'none';
    // 「取消衔接」只在接力分支里出现（见上面的 timerHandoff 分支），
    // 常规「时间到」没有等待中的衔接可取消
    timerPomoCancelBtn.style.display = 'none';
    // 休息结束后的这一轮是「回到专注」：叫「再来一轮」会被当成再来一次休息
    timerAgainBtn.textContent = timerIsBreak ? '继续专注' : '再来一轮';
    timerAgainBtn.title = timerIsBreak ? '按休息前的专注时长接着计时' : '按上次的目标接着计时';
    timerAgainBtn.style.display = '';
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
  // 到点后的「休息 / 再来一轮 / 继续专注」：sec > 0 用该秒数，sec <= 0 按上次的目标重来。
  // asBreak 时起的是休息轮：时长单独记在 timerBreakSec，绝不写进三段时间输入框
  function repeatTimerTimer(sec, asBreak) {
    var n = Math.round(Number(sec)) || 0;
    timerMode = 'down';
    timerSelect.value = 'down';
    if (asBreak) {
      // 先把「这一轮专注了多久」记下来：休息结束要靠它把 timerArg 还原成专注时长，
      // 否则「继续专注」会按休息时长重启（上一轮是正计时 / 定时时没有时长，记 0，走默认值）
      timerBreakBackSec = Math.round(Number(timerArg)) || 0;
      timerBreakSec = Math.min(TIMER_MAX_SEC, Math.max(1, n > 0 ? n : timerBreakMin * 60));
      startTimer(true);
      return;
    }
    if (n <= 0) n = Math.round(Number(timerArg)) || 0;
    if (n <= 0) n = TIMER_MIN_DEFAULT * 60; // 正计时/定时没有「时长」概念，退回默认倒计时
    n = Math.min(TIMER_MAX_SEC, Math.max(1, n));
    timerHour.value = String(Math.floor(n / 3600));
    timerMin.value = String(Math.floor((n % 3600) / 60));
    timerSec.value = String(n % 60);
    startTimer();
  }
  // 从待办直接开始（学番茄 todo：每条待办各自配「倒计时 N 分钟 / 正计时 / 不计时」）：
  // 点该条的「开始」= 设为当前专注 + 按它自己的参数启动计时。
  // 已有计时在跑时不悄悄丢掉：过 1 分钟先弹内联确认，短进度/休息轮直接切（见 requestTimerDiscard）
  function startTodoTimer(it) {
    if (!it) return;
    var tm = it.tm === 'up' || it.tm === '' ? it.tm : 'down';
    function begin() {
      // 只在还不是当前专注时才发 focus：宿主的 focus 是开关语义，对已专注的条目再发一次会取消它
      if (it.id !== todoState.focusId) whaleApi.todoSend({ op: 'focus', id: it.id });
      if (!tm) { closeMenu(); return; } // 不计时：只设专注
      // 新一轮开始 = 上一轮已经结束了：清掉「刚勾掉」的痕迹，免得上一轮被划掉的那条
      // 又跟着留在清单里（这时它已经不该再占位）
      todoJustDone = {};
      timerMode = tm;
      timerSelect.value = tm;
      if (tm === 'down') {
        var mins = Math.max(1, Math.min(600, Math.round(Number(it.mins) || 25)));
        var sec = Math.min(TIMER_MAX_SEC, mins * 60);
        timerHour.value = String(Math.floor(sec / 3600));
        timerMin.value = String(Math.floor((sec % 3600) / 60));
        timerSec.value = String(sec % 60);
      }
      startTimer();
      // 开始后收起菜单：计时气泡才是此刻的主角，菜单压在上面反而挡住读数
      closeMenu();
    }
    if (timerRunning || timerPaused) { requestTimerDiscard(begin); return; }
    begin();
  }
  function timerModeLabel() {
    if (timerIsBreak) return '休息';
    return timerMode === 'up' ? '正计时' : (timerMode === 'at' ? '定时' : '倒计时');
  }
  function timerLabelText() { return timerPaused ? timerModeLabel() + '（已暂停）' : timerModeLabel(); }
  function timerRemainMs() {
    if (timerMode === 'up') return timerRunning ? timerElapsed + (Date.now() - timerStartAt) : timerElapsed;
    if (timerRunning) return Math.max(0, timerEndAt - Date.now());
    return Math.max(0, timerRemain);
  }
  // 休息轮不挂「专注：xxx」：这一轮不在专注，挂着会让人以为休息也算专注
  function timerFocusTail(s) { return timerIsBreak ? s : withFocusTail(s); }
  function timerTailText() {
    // 接力态优先：等待期很短（1.5s），但必须让用户能看见「自动开始」正在发生，
    // 否则只剩一下闪过的接力气泡，用户来不及判断要不要点「取消衔接」
    if (timerHandoff && autoNextTimer && timerHandoff.nextId) return '即将开始下一条…（可点「取消衔接」）';
    if (timerFinished) return '点下方按钮选择下一步';
    if (timerPaused) return timerFocusTail('点继续接着走');
    if (timerMode === 'up') return timerFocusTail('点气泡可收起');
    if (timerMode === 'at') {
      // 跨到明天时标明「明天」，避免误读成今天到点
      var d = new Date(timerEndAt);
      var now = new Date();
      var crossDay = d.getFullYear() !== now.getFullYear() || d.getMonth() !== now.getMonth() || d.getDate() !== now.getDate();
      return timerFocusTail('到点 ' + (crossDay ? '明天 ' : '') + fmtHm(timerEndAt));
    }
    return timerFocusTail('共 ' + fmtClock((Number(timerArg) || 0) * 1000));
  }
  function timerLines() {
    if (timerHandoff) {
      var nextLine = timerHandoff.nextId
        ? '下一条：' + timerHandoff.nextText + '（' + timerHandoff.nextTimerLabel + '）'
        : (timerHandoff.changed ? '待办已变化' : '待办已清空，休息一下');
      return [
        { t: '任务完成', s: 'A', c: '' },
        { t: '✓ ' + timerHandoff.doneText, s: 'P', c: '#2fa24c', w: true },
        { t: nextLine, s: 'C', c: '', w: true },
      ];
    }
    if (timerFinished) {
      // 到点：大字给「结束」，说明行优先显示用户自己写的留言（这才是他要知道的「接下来做什么」）
      var lines = [
        { t: timerModeLabel() + '结束', s: 'A', c: '' },
        { t: timerNote || '时间到！', s: timerNote ? 'B' : 'P', c: '#e0433f', w: !!timerNote },
      ];
      // 尾注：开了自动衔接且在等待期时明确说「即将开始」，否则用户只看到「时间到」，
      // 几秒后计时自己跑起来会以为出 bug；没开就保持「等你自己点」的口径
      lines.push({ t: timerTailText(), s: 'C', c: '', w: true });
      return lines;
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
    if (timerMode !== 'up' && Date.now() >= timerEndAt) {
      // 电脑休眠 / 窗口被长时间节流后唤醒：与 restoreTimer 同口径，超出宽限就静默翻页，
      // 不再补响铃、补记一轮 —— 否则睡一夜回来会突然「时间到」并多记一段专注
      if (Date.now() - timerEndAt > RESTORE_GRACE_MS) { timerReported = true; resetTimer(); return; }
      finishTimer();
      return;
    }
    updateTimerClock();
    updateTimerRing();
    // 菜单开着时同步读数行（关着就不写 DOM，打开那一刻由 toggleMenu 补一次）
    if (menuOpen) updateTimerStatus();
  }
  // 环形进度条的绘制与计时进度计算收在独立小文件（floating-rings.js），免得这两段
  // 继续撑大本文件的行数棘轮；这里只留两种用途的归属判定与秒级调度
  var WHALE_RINGS = window.WhaleRings;
  // 粗细档位写在 svg 的 CSS 变量上，与画不画无关：圈收起时也先写好，亮起那一刻不会先弹一帧旧粗细
  function syncRingWidth() { WHALE_RINGS.setWidth(ringSvg, ringWidth); }
  function setRing(on, color, pct, hot) {
    syncRingWidth();
    WHALE_RINGS.setRing(ringSvg, ringFill, RING_CIRCUM, on, color, pct, hot);
  }
  // 深色系主题（夜间 / 未至之境）底上换一档更亮的圈色，取法见 rings.ringColor。
  // 判据与 bubble-render.js 的 THEMES 对齐，不另立一个没人加的 dark 类名。
  // 「圈色跟随主题」关掉后恒浅色底口径（原色），给用户一个「就要这抹蓝」的出口
  function ringDarkTheme() { return ringFollowTheme && (themeId === 'dark' || themeId === 'fantasy'); }
  // 环形进度条：每秒刷新进度与阶段配色。正计时无固定总量，用已计秒数对 3600 取模做循环动画。
  // 下班倒计时开着且当前该显示它时，圈改由 applyOffworkView 每秒按当日工时进度画（两者不抢：计时优先）
  function updateTimerRing() {
    if (offworkOwnsRing()) { updateOffworkRing(); return; }
    if (!timerRunning && !timerPaused) { setRing(false); return; }
    var f = WHALE_RINGS.timerFrame({
      isBreak: timerIsBreak, pomoOn: timerPomoOn, longBreak: shouldLongBreak(),
      mode: timerMode,
      now: Date.now(),
      running: timerRunning,
      elapsed: timerElapsed,
      startAt: timerStartAt,
      atSpan: timerAtSpan,
      // 定时：运行中用剩余量算；倒计时：总量与本轮已存的剩余
      remain: timerRunning ? Math.max(0, timerEndAt - Date.now()) : timerRemain,
      totalSec: timerArg ? Number(timerArg) : 0,
    }, ringDarkTheme());
    setRing(true, f.color, f.pct, f.hot);
  }
  // 下班倒计时接管圈的条件：倒计时开着且该渲染它，同时没有在跑的计时（计时在进行/暂停时圈归计时）。
  // 「时间到」展示态不占圈 —— 计时已结束，圈让给下班倒计时，到点提醒只占气泡。
  // 用户在设置页关掉「显示进度圈」时整个不接管：圈只给计时用，进度改由细进度条表示
  function offworkOwnsRing() {
    return offworkRing && !!OFFWORK_CORE && offworkCanRender() && !timerRunning && !timerPaused;
  }
  // 下班倒计时的圈：剩余比例 = 1 − 当日工时进度（同计时倒计时的「从满到空」语义），
  // 配色随剩余工时由蓝转琥珀，最后 30 分钟橙红并呼吸（见 rings.workColor）；
  // 进度拿不到（跨日班 / 非工作日 / 休息日）就收起圈，不画一个错误的环
  function updateOffworkRing() {
    // 圈被用户关掉时这里什么都不画；工时进度改由倒计时页里的细进度条表示（见 updateOffworkProgress）
    if (!offworkOwnsRing()) { setRing(false); return; }
    if (typeof OFFWORK_CORE.dayProgress !== 'function') { setRing(false); return; }
    var p = OFFWORK_CORE.dayProgress(Date.now(), offworkCfgObj());
    if (!p) { setRing(false); return; }
    var ov = offworkState();
    var f = WHALE_RINGS.workFrame({ s: p, near: !!(ov && ov.near) }, ringDarkTheme());
    setRing(true, f.color, f.pct, f.hot);
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
    // 接力气泡是决策点，必须等用户选；不能被「气泡常驻 / 只显计时」变更重新布防成 8s 自动收起
    if (timerHandoff) return 0;
    if (timerFinished) return timerRemindMs();
    return (timerBubbleOnly && timerBubblePin) ? 0 : bubbleDwellMs;
  }
  // 计时气泡是否占用思考气泡：到点提醒始终显示；计时中/暂停时由「只显计时」开关决定
  function timerTakesBubble() { return timerFinished || timerBubbleOnly; }
  // 退出「刚结束」展示态：气泡收起 / 用户点了鲸鱼都算已经看到，标记清掉后
  // 菜单时长与留言重新可编辑、气泡也不再一直被计时占用（否则点鲸鱼永远只弹「时间到」）
  function clearTimerDone() {
    clearTimerHandoff();
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
    try {
      // 两个开关随文案一起交给宿主：宿主只看 text 时，timerNotifyOn / timerMailOn 永远不生效
      whaleApi.notifyTimerDone(text, { system: timerNotifyOn, mail: timerMailOn && mailOn });
    } catch (err) { logErr('[whale][page] 计时通知失败', err && err.message); }
  }
  // 到点说的一句话：用户留言优先，没有就按模式给默认说法。
  // 倒计时的 timerArg 是秒数串，必须换算成 时:分:秒 —— 早先直接拼出来是「倒计时结束（1500）」
  function timerDoneText() {
    var base;
    if (timerMode === 'at') base = '定时到点（' + timerArg + '）';
    else if (timerMode === 'up') base = '正计时结束';
    else base = timerModeLabel() + '结束（' + fmtClock((Number(timerArg) || 0) * 1000) + '）';
    return timerNote ? base + ' · ' + timerNote : base;
  }
  // —— 计时状态持久化（开关关闭时不落库；宿主在关闭时会清掉旧值） ——
  function currentTimerState() {
    return {
      mode: timerMode,
      running: timerRunning,
      paused: timerPaused,
      startAt: (timerRunning && (timerMode === 'up' || timerMode === 'at')) ? timerStartAt : 0,
      endAt: (timerRunning && timerMode !== 'up') ? timerEndAt : 0,
      elapsed: timerMode === 'up' ? timerElapsed : 0,
      remain: (timerPaused && timerMode !== 'up') ? timerRemain : 0,
      arg: timerArg,
      // 休息轮必须一起存：重载后恢复成专注轮会把休息记成专注，且「继续专注」会按休息时长重启
      isBreak: timerIsBreak,
      // 本轮是否已记账：重载后补弹「时间到」/「到点后重置」都靠它挡住第二次上报
      reported: timerReported,
      back: timerBreakBackSec,
      // 番茄循环状态：cycle = 本轮是第几个番茄，cycleDate = 记录 cycle 的本地日期（跨日归零）
      cycle: timerCycle,
      cycleDate: timerCycleDate,
      // 「定时」模式的总跨度（毫秒）：进度环当总量用，暂停/重载后也要能算
      span: timerAtSpan,
    };
  }
  function saveTimerState() {
    if (!timerPersistOn) return;
    // 保存失败要留痕：否则用户开了「计时保存」，重载后计时没了却查不到任何线索
    try { whaleApi.saveTimer(currentTimerState()); } catch (err) { logErr('[whale][floating] 保存计时状态失败', err && err.message); }
  }
  // 重建挂件后恢复计时（仅在「计时保存」开启时宿主才会回推 timer）
  function restoreTimer(t) {
    if (!t || !timerPersistOn) return;
    if (t.mode !== 'up' && t.mode !== 'down' && t.mode !== 'at') return;
    timerMode = t.mode;
    timerArg = typeof t.arg === 'string' ? t.arg : '';
    timerIsBreak = t.isBreak === true;
    timerReported = t.reported === true;
    timerBreakBackSec = Math.max(0, Math.round(Number(t.back) || 0));
    // 番茄循环状态恢复：cycle / cycleDate / 定时跨度
    timerCycle = Math.max(0, Math.round(Number(t.cycle) || 0));
    timerCycleDate = (typeof t.cycleDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(t.cycleDate)) ? t.cycleDate : '';
    timerAtSpan = Math.max(0, Math.round(Number(t.span) || 0));
    // 跨日归零：按本地日历判断（UTC 日期在东八区凌晨会退回昨天）
    var today = localDayKey();
    if (timerCycleDate && timerCycleDate !== today) {
      timerCycle = 0;
      timerCycleDate = '';
    }
    timerFinished = false;
    if (t.running) {
      if (timerMode === 'up') {
        timerStartAt = Number(t.startAt) || Date.now();
        // 暂停过再继续的正计时，已计毫秒在 elapsed 里；漏还原会让「已用」只剩最后一段
        timerElapsed = Math.max(0, Number(t.elapsed) || 0);
      } else {
        timerEndAt = Number(t.endAt) || 0;
        // 挂件不在期间已到点：宽限内补一次提示音 + 通知 + 气泡；超出宽限静默放弃。
        // 旧行为是无条件 finishTimer()，重载隔了几天也会补弹「时间到」、补记一轮专注
        if (!timerEndAt) { resetTimer(); return; }
        var late = Date.now() - timerEndAt;
        if (late >= 0) {
          if (late <= RESTORE_GRACE_MS) { finishTimer(); return; }
          // 超出宽限：这一轮既不补「时间到」也不记账。挂件没开着，用户到底专注了多久
          // 无从证实，补一条「放弃 N 分钟」反而把统计带偏 —— 标记为已记账，让这一轮静默翻页
          timerReported = true;
          resetTimer();
          return;
        }
        // 定时模式的进度环需要起点；老状态没存 startAt 时用「终点 - 跨度」反推
        if (timerMode === 'at') {
          timerStartAt = Number(t.startAt) || (timerAtSpan > 0 ? timerEndAt - timerAtSpan : 0);
        }
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
    updateTimerRing(); // 剩余时间已还原，环也要按它重画；否则停在重载前的旧比例
    syncTimerMenu();
    if (timerPaused) showTimerBubble(timerBubbleAutoMs());
  }
  // 专注会话上报：只描述「这一轮实际投了多久、怎么计的、走完还是放弃」，
  // 什么算一轮、归哪天、天表怎么聚，全交给宿主（lib/focus.js）判 ——
  // 早先只在倒计时到点这一个入口记账，正计时与半途放弃都不落，用户坐了 40 分钟统计里却是 0。
  // 与到点通知分开判：通知开关关着也要记账，统计与提醒是两件独立的事。
  function reportFocusSession(extra) {
    if (timerReported) return; // 一轮只记一次（到点后重置 / 重载后补弹时间到都会二次进入）
    if (!todoOn) return;       // 专注与待办总开关（关掉就不记账）
    if (timerMode !== 'down' && timerMode !== 'up' && timerMode !== 'at') return;
    var ms = timerProgressMs();
    var abandoned = !!(extra && extra.abandoned);
    // 刚开始不到 1 分钟就放弃：本来就是「没进入状态」，记一行 1 分钟反而看不出意义
    if (abandoned && ms < DISCARD_CONFIRM_MS) return;
    // 休息轮只记「走完的」：明细里带休息徽标，天表不聚合它。
    // 中途被打断的休息不是专注数据（躺了两分钟就被顶掉，说明不了任何事），别往日志里倒噪音
    if (timerIsBreak && abandoned) return;
    timerReported = true;
    var now = Date.now();
    // 结束时刻取「本轮真正的终点」：走完用预定终点（跨零点的轮次归到结束那天），
    // 中途放弃就是按下按钮这一刻
    var endAt = timerEndAt > 0 ? Math.min(timerEndAt, now) : now;
    try {
      whaleApi.focusSession({
        mode: timerMode,
        startAt: Math.max(0, endAt - ms),
        endAt: endAt,
        minutes: Math.round(ms / 60000),
        isBreak: timerIsBreak,
        abandoned: abandoned,
      });
    } catch (err) { logErr('[whale][page] 上报专注会话失败', err && err.message); }
  }
  // 休息结束：timerArg 这期间存的是休息秒数，不还原的话「继续专注」会按休息时长重启。
  // 三段时间输入框全程没动过（见 timerBreakSec 的注释），所以这里只还原 timerArg 即可。
  // 上一轮是正计时 / 定时时没有「专注时长」可还原（back = 0）：必须清掉休息秒数，
  // 否则「继续专注」会把 5 分钟休息当成专注目标重开一轮，而不是回到默认倒计时
  function restoreFocusAfterBreak() {
    if (!timerIsBreak) return;
    timerArg = timerBreakBackSec > 0 ? String(timerBreakBackSec) : '';
  }
  // 番茄循环：判断下一轮休息是否为长休。每 timerLongEvery 轮专注后进入长休
  function shouldLongBreak() {
    return timerPomoOn && timerCycle > 0 && (timerCycle % timerLongEvery === 0);
  }
  // v1.15 曾把「番茄轮间自动衔接」整个移除，同步留下了这个空函数给散落在
  // 暂停 / 重置 / 起轮等十来处的调用点当锚。v1.17 它重新有了实体：取消待办自动衔接的等待。
  // （番茄轮间自动衔接仍然不做，这条只管待办之间的接手）
  function cancelPomoAutoNext() {
    if (autoNextTimer) { clearTimeout(autoNextTimer); autoNextTimer = null; }
  }
  // 到点自动勾掉当前专注的那条（v1.16「计时结束 = 这条做完了」）。
  // 只做「上报 op: 'toggle'」不本地改：权威状态由宿主写库后回推整份清单（单一事实来源），
  // 与行上勾选框走完全同一条路，宿主那条「勾完当前专注就清 focusId」的规则也一并生效。
  // 先把 id 记进 todoJustDone：回推后它留在原位并划掉（renderTodoMenu 只画未完成 + 刚勾掉的），
  // 这样用户能亲眼看到「这一条被划掉了」而不是凭空少一行。不计时 / 休息轮 / 没有专注项时什么都不做。
  function autoCompleteFocusedTodo() {
    if (timerIsBreak) return;
    var f = todoState && todoState.focusId ? String(todoState.focusId) : '';
    if (!f) return;
    var items = todoState.items || [];
    var target = null;
    for (var i = 0; i < items.length; i++) if (items[i].id === f) { target = items[i]; break }
    if (!target || target.done) return;
    todoJustDone[f] = true;
    whaleApi.todoSend({ op: 'toggle', id: f });
  }
  // 到点：提示音（沿用音效开关与音量）+ 系统通知 + 气泡显示「时间到！」，默认 8s 后自动收起
  function finishTimer() {
    timerRunning = false;
    timerPaused = false;
    stopTimerTick();
    updateTimerRing();
    timerFinished = true;
    timerClockText = '';
    playPress();
    notifyTimerDone();      // 必须早于 restoreFocusAfterBreak：通知要按「这一轮」的时长说话
    // 番茄循环状态更新：专注轮结束时递增 cycle（按本地日期跨日归零）
    var wasBreak = timerIsBreak;
    if (timerPomoOn && timerMode === 'down') {
      var today = localDayKey();
      if (!wasBreak) {
        // 专注轮结束：递增 cycle，更新 cycleDate
        timerCycle = (timerCycleDate === today) ? timerCycle + 1 : 1;
        timerCycleDate = today;
      }
    }
    reportFocusSession();
    // 到点 = 这条做完了：自动勾掉当前专注的待办（只对「按待办起的这一轮」生效，
    // 全局目标 / 休息轮没有专注项时是空操作）。放在 reportFocusSession 之后：
    // 记账那一笔要先按「当时还是未完成」的清单落下来
    var finishedId = focusedTodoId();
    // 开了自动衔接时，这条的「勾完成」交给 enterHandoff 发出（它本来就要发同一个 toggle）：
    // 这里再发一次，等于把刚勾上的又取消一次
    var autoHandoff = todoAutoNext && !wasBreak && !!finishedId && !!todoById(finishedId);
    if (!autoHandoff) autoCompleteFocusedTodo();
    restoreFocusAfterBreak();
    saveTimerState();
    syncTimerMenu();
    showTimerBubble(timerRemindMs());
    // 到点自动衔接下一条待办（cfg.todoAutoNext 才走）：先切到接力气泡 ——
    // 用户看清「✓ 刚才这条 / 下一条是谁（预计多久）」并拿到「取消衔接」按钮，
    // 延时 AUTO_NEXT_DELAY_MS 之后才真的起下一轮。只在前一条确实是「按待办起的专注轮」时衔接：
    // 休息轮 / 全局目标没有待办可接，硬接一条等于替用户做了选择。
    // 前一条做完后已没有未完成项时，enterHandoff 会显示「待办已清空」并停住，不出「开始下一条」。
    if (autoHandoff) {
      var cur = todoById(finishedId);
      if (cur) {
        enterHandoff(cur);
        // enterHandoff 内部会调一次 updateTimerActions，那时 autoNextTimer 还是 null，
        // 而「取消衔接」按钮的显隐正取决于它 —— 所以挂好计时器后要再刷一次按钮状态
        autoNextTimer = setTimeout(function () {
          autoNextTimer = null;
          // 等待期间用户可能点了「取消衔接」/ 关了气泡 / 手动起了一轮：这些路径都会
          // clearTimerHandoff 或 cancelPomoAutoNext，此处凭 timerHandoff 还在不在做最后把关
          if (!timerHandoff || !timerHandoff.nextId) return;
          startNextTodo();
        }, AUTO_NEXT_DELAY_MS);
        updateTimerActions();
      }
    }
    // 未开自动衔接：停在「时间到」，等用户点「再来一轮 / 开始下一条 / 知道了」
  }
  // asBreak：起的是「休息」轮 —— 不记专注、不挂专注尾注、时长不写进三段时间输入框
  function startTimer(asBreak) {
    clearTimerHandoff();
    cancelPomoAutoNext(); // 用户手动起一轮 → 不再等自动衔接（否则几秒后被它盖掉）
    timerIsBreak = !!asBreak;
    timerReported = false; // 新一轮开始：记账标记归零，这一轮到点/放弃时才落一笔
    if (!timerIsBreak) timerBreakBackSec = 0;
    var now = Date.now();
    if (timerMode === 'down') {
      var sec;
      if (timerIsBreak) {
        // 休息时长来自「休息 N 分钟」档，不进输入框：输入框始终是用户的专注时长
        sec = Math.min(TIMER_MAX_SEC, Math.max(1, Math.round(timerBreakSec || timerBreakMin * 60)));
        timerBreakSec = sec;
      } else {
        // 时/分/秒三段合计：允许 90 分、80 秒这类填法，只按总秒数截上限
        sec = timerSegTotalSec();
        timerHour.value = String(Math.floor(sec / 3600));
        timerMin.value = String(Math.floor((sec % 3600) / 60));
        timerSec.value = String(sec % 60);
      }
      timerArg = String(sec); // 秒数：气泡「共 x」与「再来一轮」都按它复原
      timerEndAt = now + sec * 1000;
      timerRemain = 0;
      timerAtSpan = 0; // 定时模式的跨度只在 at 分支用，别把上一轮的值带过来
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
      // 进度环的「总量」= 从现在到目标时刻的跨度，起点一并记下（暂停/重载后仍能算比例）
      timerStartAt = now;
      timerAtSpan = Math.max(0, timerEndAt - now);
    } else {
      timerMode = 'up';
      timerStartAt = now;
      timerElapsed = 0;
      timerRemain = 0;
      timerAtSpan = 0;
    }
    timerRunning = true;
    timerPaused = false;
    // 上一轮「时间到」的气泡可能还挂着（常驻或还没到 timerRemindSec）：
    // 先收起它，否则到点动作条会和新一轮计时气泡叠在一起，timerFinished 也会把它当结束态
    if (timerFinished) hideBubble();
    timerFinished = false;
    startTimerTick();
    updateTimerRing();
    // 不 saveCfg：模式与时长是本轮参数，运行态交给 saveTimerState 持久化。
    // 默认值只由设置页写 —— 早前这里整份落盘，点一次 5 分钟快捷档，下次的默认时长就成 5 分钟了
    saveTimerState();
    syncTimerMenu();
    showTimerBubble(timerBubbleAutoMs()); // 开始/暂停/继续都先弹计时：常驻时不收起，否则短暂提示
  }
  // 暂停：保留进度（正计时记住已计时间，倒计时/定时记住剩余时间），继续时接着走
  function pauseTimer() {
    cancelPomoAutoNext(); // 暂停也是「用户已经接管」，别让自动衔接在等待期结束后把新一轮顶上来
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
    updateTimerRing();
    saveTimerState();
    syncTimerMenu();
    showTimerBubble(timerBubbleAutoMs());
  }
  function resumeTimer() {
    cancelPomoAutoNext();
    var now = Date.now();
    if (timerMode === 'up') timerStartAt = now;
    else {
      timerEndAt = now + Math.max(0, timerRemain);
      // 定时模式恢复起点，进度环接着按跨度算（暂停期间不丢总量）
      if (timerMode === 'at') timerStartAt = timerAtSpan > 0 ? timerEndAt - timerAtSpan : 0;
    }
    timerRemain = 0;
    timerRunning = true;
    timerPaused = false;
    startTimerTick();
    updateTimerRing();
    saveTimerState();
    syncTimerMenu();
    showTimerBubble(timerBubbleAutoMs());
  }
  // 完全复位（切模式 / 点「重置」）：清掉进度回到未开始；不传 nextMode 则保留当前模式
  function resetTimer(nextMode) {
    clearTimerHandoff();
    cancelPomoAutoNext();
    timerRunning = false;
    timerPaused = false;
    timerFinished = false;
    timerIsBreak = false;
    timerBreakBackSec = 0;
    timerBreakSec = 0;
    timerStartAt = 0;
    timerAtSpan = 0;
    timerEndAt = 0;
    timerElapsed = 0;
    timerRemain = 0;
    timerClockText = '';
    stopTimerTick();
    updateTimerRing();
    if (nextMode !== undefined) timerMode = nextMode;
    if (bubbleTimerActive) hideBubble();
    saveTimerState();
    syncTimerMenu();
  }
  function setTimerMode(v) {
    var next = (v === 'up' || v === 'down' || v === 'at') ? v : 'off';
    // 模式是用户显式选的「以后也用这个」：落盘，重载后不用重新选。
    // 快捷档位 / 待办开始 / 再来一轮只是本轮临时切到倒计时，不走这里、不写默认模式
    function commitMode() {
      resetTimer(next);
      // 先记下新值：宿主回推同一个模式时，applyConfig 不会再去改本地状态
      cfgTimerModeSeen = next;
      saveCfg({ timerMode: next });
    }
    // 切模式 = 复位当前轮：已经专注一会儿的先问一句（确认期间下拉先回退到当前模式）
    if (next !== timerMode) { requestTimerDiscard(commitMode); return; }
    commitMode();
  }
  // 到点通知 / 提醒停留 / 留言 / 休息档 / 气泡两个开关：菜单里已无对应控件（只在设置页改），
  // 本地副本由 applyConfig 回推，故这里不再保留 setter
  // 计时气泡常驻 / 只显计时：两个开关只在设置页改，页面按 applyConfig 回推的配置生效。
  // 计时中切回「常驻」时立刻重新展开气泡，否则要等下一次刷新才看得到
  function applyTimerBubblePrefs() {
    if (timerActive() && timerTakesBubble()) showTimerBubble(timerBubbleAutoMs());
  }
  // 主按钮：开始 → 暂停 → 继续 →（到点后）开始
  function timerBtnClick() {
    if (timerRunning) { pauseTimer(); return; }
    if (timerPaused) { resumeTimer(); return; }
    if (timerMode === 'off') timerMode = 'up';
    startTimer();
  }
  // 计时中 / 暂停时锁住「目标」输入：改了也不影响本轮（timerArg 在 startTimer 就固定了），
  // 不锁会让人以为「改完就能延长」，白等一轮。解锁时还原各自原本的 title
  function lockTimerTargets(locked) {
    for (var i = 0; i < timerTargets.length; i++) {
      var el = timerTargets[i];
      if (locked) {
        if (el.disabled) continue;
        el.setAttribute('data-title0', el.title);
        el.disabled = true;
        el.title = '计时中不能改目标：先点「重置」再改';
      } else if (el.disabled) {
        el.disabled = false;
        var t0 = el.getAttribute('data-title0');
        if (t0) el.title = t0;
      }
    }
  }
  // 当前行：计时中 / 暂停时显示读数与暂停；空闲但有专注任务时显示「当前 + 开始」。
  // timerFinished 时整行隐藏：到点后的主角是气泡动作条 / 接力气泡，不在菜单里重复。
  function updateTimerStatus() {
    var busy = timerRunning || timerPaused;
    var focusItem = todoFocusItem();
    var idleFocus = !busy && !timerFinished && !!focusItem;
    rowTimerStatus.style.display = (busy || idleFocus) ? '' : 'none';
    lockTimerTargets(busy);
    // 合并组的折叠摘要（任务 / 剩余 / 今日轮数）：菜单开着时由 timerStep 每秒调到这里
    refreshMenuSummaries();
    if (!busy) {
      if (pendingTimerDiscard) cancelTimerConfirm();
      if (idleFocus) {
        if (timerStatusLabel.textContent !== '当前') timerStatusLabel.textContent = '当前';
        var idleTaskText = String(focusItem.text || '');
        if (timerStatusTask.textContent !== idleTaskText) timerStatusTask.textContent = idleTaskText;
        timerStatusTask.title = idleTaskText;
        timerStatusTask.style.display = '';
        timerStatusVal.style.display = 'none';
        // tm='' 的任务已经设为专注，没有计时可启，不摆「开始」
        var canStart = focusItem.tm === 'down' || focusItem.tm === 'up';
        timerCurrentBtn.style.display = canStart ? '' : 'none';
        if (canStart) {
          timerCurrentBtn.textContent = '开始';
          timerCurrentBtn.title = '按这条待办自己的计时方式开始';
        }
        timerResetBtn.style.display = 'none';
      }
      syncTimerQuick();
      return;
    }
    var label = timerIsBreak ? '休息' : (timerMode === 'up' ? '已用' : '剩余');
    if (timerPaused) label += '·暂停';
    if (timerStatusLabel.textContent !== label) timerStatusLabel.textContent = label;
    if (focusItem && !timerIsBreak) {
      var busyTaskText = String(focusItem.text || '');
      if (timerStatusTask.textContent !== busyTaskText) timerStatusTask.textContent = busyTaskText;
      timerStatusTask.title = busyTaskText;
      timerStatusTask.style.display = '';
    } else {
      timerStatusTask.style.display = 'none';
    }
    timerStatusVal.style.display = '';
    var txt = fmtClock(timerRemainMs());
    if (timerStatusVal.textContent !== txt) timerStatusVal.textContent = txt;
    timerCurrentBtn.style.display = '';
    timerCurrentBtn.textContent = timerRunning ? '暂停' : '继续';
    timerCurrentBtn.title = timerRunning ? '暂停当前计时' : '继续当前计时';
    timerResetBtn.style.display = '';
    // 确认框挂着时进度每秒在走，文案跟着刷新（否则停在一分钟前的「已专注 01:05」）
    if (pendingTimerDiscard) updateTimerConfirmText();
    syncTimerQuick();
  }
  function syncTimerMenu() {
    // 计时中收到的「默认时长」变更：回到空闲再落到目标输入框（理由见 applyConfig 的 timerSec 分支）
    if (pendingTimerSec !== null && !timerRunning && !timerPaused) {
      writeTimerTargetSec(pendingTimerSec);
      pendingTimerSec = null;
    }
    timerSelect.value = timerMode;
    timerBtn.textContent = timerRunning ? '暂停' : (timerPaused ? '继续' : '开始');
    // 「目标」两个互斥子行：倒计时行 / 定时刻行各显示自己那套。
    // 判定只看模式，不看忙闲 —— 早先写成 `idle && timerMode === ...` 是错的：
    // busy 与 idle 互斥（busy = running || paused），计时中/暂停时 down/at 恒为 false，
    // 于是两行同时露出、且倒计时的重置按钮被兜底分支塞进 rowTimerAt
    // （`busy && (down || !at)` 在 down=false、at=false 时化简即 `busy`）：
    // 定时刻行变成「目标 + 重置」而倒计时行只剩输入框。拆行后每行只放自己那套控件，
    // 本就该按模式二选一（重置已统一挪到读数行，不再跟模式走）。
    var down = timerMode === 'down';
    var at = timerMode === 'at';
    rowTimerDown.style.display = down ? '' : 'none';
    rowTimerAt.style.display = at ? '' : 'none';
    timerHour.style.display = down ? '' : 'none';
    timerMin.style.display = down ? '' : 'none';
    timerSec.style.display = down ? '' : 'none';
    timerTime.style.display = at ? '' : 'none';
    // 单位提示跟着自己的输入框一起显隐（各自成对，避免「时」标签孤零零留在行里）
    timerSegUnits[0].style.display = down ? '' : 'none';
    timerSegUnits[1].style.display = down ? '' : 'none';
    timerSegUnits[2].style.display = down ? '' : 'none';
    // 留言与休息档已移到设置页：菜单里不再有对应行，这里也不用显隐
    syncTimerQuick();
    updateTimerStatus();
    updateTimerActions();
    // 「双击看余额」提示只在「只显计时开着 + 计时中/暂停」时出现（见 rowTimerPeekHint）
    syncTimerPeekHint();
  }

  // —— 放弃本轮的内联确认 ——
  // 触发点：重置 / 切计时模式 / 换一条待办开始 / 点快捷时长。这些动作都会清零当前进度，
  // 而进度里最贵的是「已经专注了多久」。低于 1 分钟或休息轮不打扰（本来也没什么可丢的）
  var DISCARD_CONFIRM_MS = 60000;
  var pendingTimerDiscard = null;
  function timerProgressMs() {
    if (timerMode === 'up') {
      return timerRunning ? timerElapsed + (Date.now() - timerStartAt) : Math.max(0, timerElapsed);
    }
    if (timerMode === 'down') {
      var total = Math.max(0, Number(timerArg) || 0) * 1000;
      if (!total) return 0;
      var remain = timerRunning ? Math.max(0, timerEndAt - Date.now()) : Math.max(0, timerRemain);
      return Math.min(total, Math.max(0, total - remain));
    }
    if (timerMode === 'at') {
      var span = Math.max(0, timerAtSpan);
      if (!span) return 0;
      var left = timerRunning ? Math.max(0, timerEndAt - Date.now()) : Math.max(0, timerRemain);
      return Math.min(span, Math.max(0, span - left));
    }
    return 0;
  }
  function discardNeedsConfirm() {
    return (timerRunning || timerPaused) && !timerIsBreak && timerProgressMs() >= DISCARD_CONFIRM_MS;
  }
  function updateTimerConfirmText() {
    timerConfirmText.textContent = '已专注 ' + fmtClock(timerProgressMs()) + '，放弃后只记时长、不算一轮';
  }
  function syncTimerConfirm() {
    var busy = timerRunning || timerPaused;
    if (!busy && pendingTimerDiscard) pendingTimerDiscard = null;
    // 「要不要问」只在按下放弃入口那一刻判一次：进度是随秒涨的，刚过 1 分钟时问了，
    // 下一跳就不能再按「已不够久」把问题收掉 —— 秒针一跳确认行就消失，用户根本点不到（真机复现过）
    if (!pendingTimerDiscard) { rowTimerConfirm.style.display = 'none'; return; }
    var wasShown = rowTimerConfirm.style.display !== 'none';
    rowTimerConfirm.style.display = '';
    updateTimerConfirmText();
    // 触发点可能在顶部重置、待办行「开始」或底部快捷档；确认行紧随当前行，
    // 首次出现时滚到可见，避免「点了没反应」。
    if (!wasShown) {
      try { rowTimerConfirm.scrollIntoView({ block: 'nearest' }); } catch (err) {}
    }
  }
  function cancelTimerConfirm() {
    var had = !!pendingTimerDiscard;
    pendingTimerDiscard = null;
    rowTimerConfirm.style.display = 'none';
    // 只在真取消过时才回写下拉：空闲时 updateTimerStatus 每秒都会走到这里，
    // 每秒给 select 赋值会把用户正展开的模式下拉重置掉
    if (had) timerSelect.value = timerMode;
  }
  function confirmTimerDiscard() {
    var run = pendingTimerDiscard;
    pendingTimerDiscard = null;
    rowTimerConfirm.style.display = 'none';
    if (run) { settleTimerDiscard(); run(); }
  }
  // 放弃出口：重置 / 切模式 / 换待办 / 快捷档都会顶掉当前轮，四个入口各判一次迟早漏一个，
  // 统一在「真的要把这一轮丢掉」之前记一笔 —— 按实际分钟记，不算一轮（判定在宿主）。
  // 「放弃」= 没走到预定终点：只有倒计时 / 定时中途停下才算；正计时本来就没有终点，
  // 用户点停就是正常收尾，标成放弃会让明细里平白多一条「被打断」。
  // 但不满 1 分钟的正计时同样不值得记（与放弃门槛一致，见 reportFocusSession 的短路）
  function settleTimerDiscard() {
    if (!timerRunning && !timerPaused) return; // 空闲/已走完：没有正在进行的轮次要记
    if (timerMode === 'up' && timerProgressMs() < DISCARD_CONFIRM_MS) return;
    reportFocusSession({ abandoned: timerMode !== 'up' });
  }
  // 需要确认就挂起、不需要就立刻执行。返回是否已执行（调用方一般不需要关心）
  function requestTimerDiscard(run) {
    if (typeof run !== 'function') return false;
    if (!discardNeedsConfirm()) {
      cancelTimerConfirm();
      settleTimerDiscard();
      run();
      return true;
    }
    pendingTimerDiscard = run;
    timerSelect.value = timerMode;
    syncTimerConfirm();
    return false;
  }
  // —— 快捷时长 ——
  function quickStartTimer(mins) {
    var n = Math.max(1, Math.min(600, Math.round(Number(mins) || 0)));
    if (!n) return;
    requestTimerDiscard(function () {
      timerMode = 'down';
      timerSelect.value = 'down';
      var sec = Math.min(TIMER_MAX_SEC, n * 60);
      timerHour.value = String(Math.floor(sec / 3600));
      timerMin.value = String(Math.floor((sec % 3600) / 60));
      timerSec.value = String(sec % 60);
      startTimer();
      closeMenu();
    });
  }
  // 把设置页的四档落到芯片。宿主已归一化（固定 4 档、1–600），这里再兜一层缺项补默认；
  // 只改文案 / data-min、不重建节点 —— 重建会打断正按着的点击，也会丢焦点
  function applyTimerPresets(list) {
    var vals = Array.isArray(list) ? list : TIMER_PRESETS_DEFAULT;
    for (var i = 0; i < timerChipEls.length; i++) {
      var raw = vals[i];
      var n = Math.round(Number(raw));
      var mins = (raw == null || raw === '' || !isFinite(n))
        ? TIMER_PRESETS_DEFAULT[i]
        : Math.min(600, Math.max(1, n));
      var chip = timerChipEls[i];
      chip.setAttribute('data-min', String(mins));
      var label = mins + ' 分';
      if (chip.textContent !== label) chip.textContent = label;
      chip.title = '倒计时 ' + mins + ' 分钟并立即开始';
    }
    syncTimerQuick();
  }
  // 快捷档只有「倒计时 / 未开始」时才有意义：正计时与定时没有目标时长可套用。
  // 当前时长与某一档一致时高亮那一档，让「现在这套参数」在快捷行里也读得出来
  function syncTimerQuick() {
    var down = timerMode === 'down';
    var show = down || timerMode === 'off';
    rowTimerQuick.style.display = show ? '' : 'none';
    if (!show) return;
    var active = 0;
    if (down) {
      if (timerRunning || timerPaused) {
        var runningSec = Math.round(Number(timerArg) || 0);
        if (runningSec > 0 && runningSec % 60 === 0) active = runningSec / 60;
      } else {
        var h = Math.max(0, Math.round(Number(timerHour.value) || 0));
        var m = Math.max(0, Math.round(Number(timerMin.value) || 0));
        var s = Math.max(0, Math.round(Number(timerSec.value) || 0));
        var total = h * 3600 + m * 60 + s;
        if (total > 0 && total % 60 === 0) active = total / 60;
      }
    }
    for (var i = 0; i < timerChipEls.length; i++) {
      var on = Number(timerChipEls[i].getAttribute('data-min')) === active;
      timerChipEls[i].classList.toggle('dshwv-timer-chip-on', on);
    }
  }

  // —— 气泡内容 ——
  var bubbleSwapTimer = null, hintFadeTimer = null, lastHintText = null;
  // 说明行底稿（不含倒计时附加项）；null = 不追加附加项。倒计时页渲染时一律传空串（不显示「今日已用」）
  var baseHintText = null;
  // 渲染算法（fit / applyLines / gif 状态机与 gifFadeTimer）已移入共享渲染器；这里留同名薄壳，
  // 保住页面全部调用点（render / show* / hide / updateTimerClock…），行为与抽取前一致
  // 复位字号，并清掉说明行的收窄 / 钳行类与内联 nowrap（nowrap 会让下一轮量高恒等于一行）
  function resetBubbleFont() { renderer.resetFont(); hintEl.classList.remove('dshwv-hint-offwork', 'dshwv-hint-clamp'); hintEl.style.whiteSpace = ''; }
  function fitBubbleText() { renderer.fitText(); }
  function applyBubbleLines(lines) {
    // 切到计时 / 提醒 / 自定义等布局时，倒计时的进度条与临近配色都不属于这些内容
    offworkBarEl.style.display = 'none';
    applyOffworkNear(null);
    return renderer.applyLines(lines);
  }
  // 倒计时页整页隐藏余额行（用户 2026-11-09）：只切 display、不动 textContent（计时与别的页靠它写大字），切页 / 退出接管由 applyBubbleLines、restoreBubbleLines 复原
  function offworkHidesAmount() { return !!OFFWORK_CORE && offworkCanRender(); }
  // 说明行金额不拆行：符号与数字间换 NBSP —— 两行说明行收窄到 520u 会在「¥」后把数字甩下一行；只作用于显示串（fmt() 保持普通空格），\s 含 NBSP 故幂等
  function noBreakMoney(s) { return String(s).replace(/([¥$￥])\s+(?=\d)/g, '$1\u00A0'); }
  function setHint(text) {
    text = noBreakMoney(text);
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
  // 倒计时按秒刷新说明行：直写并同步 lastHintText，避开 setHint 的淡入淡出（每秒淡一次会闪）。
  // 同时取消挂起的淡入定时器，否则它 190ms 后会把旧文案写回去
  function setHintDirect(text) {
    text = noBreakMoney(text); // 量高前先转，否则量到的是「数字被甩下一行」的假行数
    if (text === lastHintText) return;
    lastHintText = text;
    if (hintFadeTimer) { clearTimeout(hintFadeTimer); hintFadeTimer = null; }
    hintEl.style.transition = '';
    hintEl.style.opacity = '';
    hintEl.textContent = text;
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
    renderer.cancelGifFade();
    lastHintText = null;
    textBox.style.transition = '';
    textBox.style.opacity = '';
    resetBubbleFont();
    // v2 行×段内容复位：render() 默认分支不走 applyLines，rowsBox 不会被自动藏掉，这里显式清
    rowsBox.style.display = 'none';
    rowsBox.innerHTML = '';
    // v3 按压气泡模块区（modsBox）同上：不走 applyLines 时也要清掉，否则旧模块内容粘在屏上
    modsBox.style.display = 'none';
    modsBox.innerHTML = '';
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
    // 「只显计时」关闭：点小鲸鱼先显示一眼计时，随后继续常规内容（余额/用量/报时）。
    // peek 还没走完时再点一次 = 用户想「跳过这一眼」，直接切常规内容，而不是把 2 秒重新计一遍
    if (fromUser && timerActive() && !timerFinished) {
      if (timerPeekDone()) return;
      showTimerBubble(TIMER_PEEK_MS, true);
      return;
    }
    showNormalBubble();
  }
  // 常规内容气泡（余额 / 今日用量 / 报时 / 按压气泡模型），停留 bubbleDwellMs 后按 onExpire 收尾。
  // onExpire 缺省 hideBubble；「计时中双击看余额」传一个「到点切回计时气泡」的收尾进来
  function showNormalBubble(onExpire) {
    if (!bubbleOn) return;
    if (bubbleTimer) { clearTimeout(bubbleTimer); bubbleTimer = null; }
    renderer.cancelGifFade();
    bubbleShown = true;
    bubbleTimerActive = false;
    bubbleRandomActive = false;
    bubbleRemindActive = false;
    bubbleRemindLines = null;
    bubblePreviewActive = false; // 点鲸鱼本体 = 常规内容接管，试播会话整段作废
    previewSession = null; bubblePreviewItems = null;
    var q = bubbleQueue(); // 队列 = 倒计时页（开启时）+ 本队列步骤；收起后重开回到第一页
    if (!bubbleActive || bubbleIdx >= q.length) { bubbleIdx = 0; bubbleLastOptionIdx = -1; } // 已在放某一页则保留当前页
    bubbleActive = q.length > 0;
    restoreBubbleLines(); // render() 已按当前页画好：倒计时页走常规三行，自定义步骤走模块结构
    bubbleBox.classList.add('dshwv-bubble-open');
    bubbleArm(PAGES.isCustom(q[bubbleIdx]) ? bubbleModelDwellMs : bubbleDwellMs, onExpire || hideBubble);
  }
  // 计时中双击鲸鱼：临时看一眼余额，停留 bubbleDwell 秒后自己切回计时气泡。
  // 「计时中只显示计时」开着时（默认），单击永远只给计时气泡 —— 这个手势是不改设置也能看余额的入口
  function showBalancePeek() {
    showNormalBubble(function () {
      // 不先 hideBubble：收起再弹会闪一下，直接换行内容更顺；计时已结束就正常收起
      if (timerActive() && !timerFinished) { showTimerBubble(timerBubbleAutoMs()); return; }
      hideBubble();
    });
  }
  // 「只显计时」关闭时，计时先显示一段后原地切回常规内容（气泡不收起，继续按常规时长停留）。
  // 两个入口：peek 到时的定时器（thenNormal=true），以及用户在 peek 期间点了挂件本体
  // （endDrag 那条路径会先 showBubble(true)，而 showBubble 的前半段只认 timerTakesBubble，于是 peek 又重开一遍
  // ——不在这里先立刻切回常规内容，用户点了没反应，2s 后还会自己变一次）。
  // 返回 true 表示「这次确实在 peek 中」，调用方据此决定别再重复开 peek
  function timerPeekDone() {
    if (!bubbleTimerActive || timerTakesBubble()) return false; // 计时气泡不在，或它本来就该占气泡（只显计时/已到点）
    bubbleTimerActive = false;
    timerClockText = '';
    timerDoneActions.classList.remove('dshwv-actions-open');
    if (!bubbleShown) return true; // 期间已被用户/其他开关收起：不再把它弹回来
    showBubble(false);
    return true;
  }
  // 计时气泡：autoHideMs=0 表示常驻（点气泡可收起，计时继续）；thenNormal=true 表示到时切回常规内容
  function showTimerBubble(autoHideMs, thenNormal) {
    if (!bubbleOn) return;
    if (bubbleTimer) { clearTimeout(bubbleTimer); bubbleTimer = null; }
    renderer.cancelGifFade();
    bubbleShown = true;
    bubbleRandomActive = false;
    bubbleRandomLines = null;
    bubbleRemindActive = false;
    bubbleRemindLines = null;
    bubbleTimerActive = true; bubbleActive = false; // 计时压过整条队列：点击交给计时气泡自己的分支
    bubblePreviewActive = false; // 计时优先级最高：接管后试播会话整段作废
    previewSession = null; bubblePreviewItems = null;
    restoreBubbleLines();
    applyBubbleLines(timerLines());
    timerClockText = timerFinished ? '' : fmtClock(timerRemainMs());
    bubbleBox.classList.add('dshwv-bubble-open');
    updateTimerActions(); // 到点后把「休息 / 再来一轮 / 知道了」摆到气泡下缘
    if (autoHideMs) bubbleArm(autoHideMs, thenNormal ? timerPeekDone : hideBubble);
    else bubbleDisarm();
  }
  // 峰/谷时段切换提醒：独立于随机台词，内容多一行时段表
  function showPeakRemind(isPeak) {
    playAlertSound('peak');
    showRemindBubble(peakRemindLines(isPeak));
  }
  function hideBubble() {
    if (bubbleTimer) { clearTimeout(bubbleTimer); bubbleTimer = null; }
    bubbleTtlDeadline = 0;
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
    // 试播会话与气泡同生共死：自动收起 / 手动点收都整段作废
    bubblePreviewActive = false; previewSession = null; bubblePreviewItems = null;
    previewDwellClear();
    // 按压气泡模型与气泡同生共死：收起即退出该模型的显示态（下次点开重新从第 1 泡起）
    bubbleActive = false;
    // 「时间到」提示收起后回到普通状态（计时已结束，模式保留便于重新开始）；
    // 动作条与气泡同生共死，否则气泡没了按钮还浮在那儿
    timerDoneActions.classList.remove('dshwv-actions-open');
    if (timerFinished) clearTimerDone();
    bubbleShown = false;
    bubbleBox.classList.remove('dshwv-bubble-open');
    // gif 靠 CSS opacity 淡出；display:none 会跳过过渡，等淡出完成再隐藏
    renderer.fadeOutGif(240);
  }

  // —— 气泡 TTL 补收（参考 DSH 网页版同类方案）——
  // bubbleArm 是所有「气泡自动收起」的唯一入口：setTimeout 照常布防（前台路径），
  // 同时记一份绝对截止时刻（补收路径用）。悬浮窗隐藏/休眠期间定时器被节流，
  // 窗口回到可见/焦点时由 bubbleTtlSweep 补收；setInterval 每秒巡检兜底（平时两次比较就返回）。
  // 传 0 表示该气泡常驻（无 TTL），巡检必须跳过，不能把用户显式要它留着的气泡收掉
  function bubbleArm(ttlMs, onExpire) {
    if (bubbleTimer) { clearTimeout(bubbleTimer); bubbleTimer = null; }
    bubbleTtlDeadline = Date.now() + ttlMs;
    bubbleTtlAction = onExpire;
    bubbleTimer = setTimeout(function () { bubbleTimer = null; onExpire(); }, ttlMs);
  }
  // 行级停留秒数（r.d 秒）→ TTL：与默认停留同一布防入口，只是时长按行覆盖。
  // dwell 非法（0/负数/超大/非数值）时回全局默认停留（bubbleDwellMs），d 上限 120s 由宿主 normRow 把关，这里只兜底
  function bubbleArmFor(dwellSec, onExpire) {
    var ms = bubbleDwellMs;
    var d = Number(dwellSec);
    if (isFinite(d) && d >= 1 && d <= 120) ms = Math.round(d * 1000);
    bubbleArm(ms, onExpire);
  }
  // 常驻 / 内容切换等场景：只清定时器不动气泡
  function bubbleDisarm() {
    if (bubbleTimer) { clearTimeout(bubbleTimer); bubbleTimer = null; }
    bubbleTtlDeadline = 0;
    bubbleTtlAction = null;
  }
  var bubbleTtlAction = null;
  function bubbleTtlSweep() {
    // 下班倒计时复用这个每秒巡检：气泡没开 / 开关关着时 offworkStep 立刻返回，不额外起定时器。
    // 计时在跑时它不能跳 —— 那里同时是计时圈的每秒刷新入口（见 offworkStep）
    if (offworkOn || timerRunning) offworkStep();
    if (bubbleTimer) return;            // 前台定时器还活着：正常路径会收，不抢
    if (!bubbleTtlDeadline) return;     // 无 TTL（常驻）或已收起：无事可做
    if (Date.now() < bubbleTtlDeadline) return; // 被提前续期过：还没到点
    var act = bubbleTtlAction;
    bubbleDisarm();
    if (act) act();
  }
  document.addEventListener('visibilitychange', function () { if (!document.hidden) bubbleTtlSweep(); });
  window.addEventListener('focus', bubbleTtlSweep);
  window.addEventListener('pageshow', bubbleTtlSweep);
  setInterval(bubbleTtlSweep, 1000);

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
  // 临时说明要自己到期：render() 只在余额推送时被调用，菜单轮询（每分钟）之外没有人再刷第三行，
  // 不补这一下，手动刷新的「本次 ±x」会一直挂到下一次余额推送才消失
  var adjustNoteTimer = null;
  function armAdjustNoteTimer() {
    if (adjustNoteTimer) { clearTimeout(adjustNoteTimer); adjustNoteTimer = null; }
    var n = state.adjustNote;
    if (!n) return;
    adjustNoteTimer = setTimeout(function () {
      adjustNoteTimer = null;
      if (state.adjustNote !== n) return; // 期间被换成了更新的一条：让它的定时器负责
      state.adjustNote = null;
      render();
    }, Math.max(0, n.until - Date.now()) + 20);
  }
  function adjustNoteText(a) {
    var money = fmt(Number(a && a.amount), state.currency);
    return a && a.why === '赠送额到期/被收回'
      ? '赠送额到期 ' + money + '，未计用量'
      : '少了 ' + money + ' 太快，未计用量';
  }
  // 手动刷新前后的差额，在第三行停留 8s。
  // 为什么只对手动刷新显示：自动采样每分钟一次、且本来就带数字滚动 + 变动气泡，再标一遍是噪音；
  // 而手动刷新是用户「主动想知道现在多少」的动作 —— 数字变了却不告诉他变了多少，
  // 他就得自己记住刷新前那个数。差额为 0 时不显示（「本次 ¥0.00」纯属添乱）
  // 时长比 ADJUST_NOTE_MS 短：这条是即时反馈，不是需要读完的解释
  var MANUAL_DELTA_MS = 8000;
  function manualDeltaText(delta) {
    if (!delta) return '';
    return '本次 ' + (delta > 0 ? '+' : '-') + fmt(Math.abs(delta), state.currency);
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
  // 主显示金额的「名分」：余额型 = 余额，额度型 = 剩余额度，Codex = 今日 token。
  // 菜单顶部与「复制」按钮都靠它，别再写死「余额」（额度型会出现「余额 62%」这种自相矛盾的读法）
  function mainAmountKind() {
    if (mainModelId !== 'deepseek') {
      var m = currentModel();
      if (m && m.kind === 'quota') return '剩余额度';
      if (m && m.kind === 'codex') return '今日 token';
    }
    return '余额';
  }
  // 菜单顶部那行的标签：内置 DeepSeek 只写名分；换成别的模型时**带上模型名** ——
  // 否则「剩余额度 62%」看不出是哪一家（模型组默认收着，摘要只说「3 个」）。
  // 命名口径与气泡标题行（defaultLabelText）同源：模型名 + 名分
  function mainAmountLabel() {
    var kind = mainAmountKind();
    if (mainModelId === 'deepseek') return kind;
    var m = currentModel();
    return (m && m.name ? m.name + ' ' : '') + kind;
  }
  // 「复制余额 / 复制额度 / 复制 token」：按钮文案跟着名分走，点完的临时态也用它复原
  function copyAmountLabel() {
    var kind = mainAmountKind();
    return '复制' + (kind === '剩余额度' ? '额度' : (kind === '今日 token' ? 'token' : '余额'));
  }

  // —— 下班倒计时：薄壳（时间算法全在共享的 offwork 模块里） ——
  function offworkCfgObj() {
    return {
      start: offworkStart, end: offworkEnd, days: offworkDays,
      showSec: offworkShowSec, ring: offworkRing, weekendOn: offworkWeekendOn,
      paydayOn: offworkPaydayOn, paydayDay: offworkPaydayDay,
    };
  }
  function offworkState() {
    if (!OFFWORK_CORE) return null;
    try {
      return OFFWORK_CORE.display(Date.now(), offworkCfgObj());
    } catch (err) {
      logErr('[whale][page] 下班倒计时计算失败', err && err.message ? err.message : err);
      return null;
    }
  }
  // 最后 30 / 10 分钟只给倒计时页的标题行轻微变色 / 呼吸（CSS），不弹窗、不响铃；
  // 标题行由报时 / 倒计时谁占用都只在这一页生效（first 页是步骤页，压根不渲染三行）
  function applyOffworkNear(near) {
    root.classList.toggle('dshwv-offwork-soon', near === 'soon' || near === 'imminent');
    root.classList.toggle('dshwv-offwork-imminent', near === 'imminent');
  }
  // 只有停在倒计时页才由它接管标题行、给说明行追加附加项；自定义步骤以及临时接管时全部隐藏
  function offworkCanRender() {
    return !!offworkOn && !bubbleTimerActive && !bubbleRemindActive && !bubblePreviewActive && !bubbleRandomActive &&
      (!bubbleActive || bubbleQueue()[bubbleIdx] === OFFWORK_PAGE);
  }
  // 刷新「今日已过」细进度：只在倒计时可渲染时显示（细条不占文字高度，故不参与三行测高；口径见 offwork.dayProgress）。
  // 圈已画同一份进度时收掉细条（2026-11-09 用户要求，同一信息别两处展示）；圈不画（跨日班 / 休息日 / 计时占圈）时细条兜底
  function updateOffworkProgress() {
    if (!offworkCanRender() || !OFFWORK_CORE || typeof OFFWORK_CORE.dayProgress !== 'function') {
      offworkBarEl.style.display = 'none';
      return;
    }
    var p = OFFWORK_CORE.dayProgress(Date.now(), offworkCfgObj());
    if (!p) {
      offworkBarEl.style.display = 'none';
      return;
    }
    offworkBarEl.style.display = offworkOwnsRing() ? 'none' : '';
    offworkFillEl.style.width = p.pct.toFixed(1) + '%';
    offworkPctEl.textContent = Math.round(p.pct) + '%';
  }
  // 说明行附加项（周末 / 发薪 → 今日已赚）：前两项在 display.hint 里，今日已赚与进度条同口径。
  // **最多一项**（说明行只留给「还剩多久」，挤成一行既不快也不省眼；2026-11-09 用户要求简洁高效），
  // 今日已赚只在另两项都没开时才顶上
  function offworkHintParts(ov) {
    var list = String((ov && ov.hint) || '').split(' · ').slice(1);
    var earned = typeof OFFWORK_CORE.todayEarned === 'function' ? OFFWORK_CORE.todayEarned(Date.now(), offworkCfgObj(), offworkHourlyWage) : null;
    if (earned !== null && !list.length) list.push(hideAmounts ? '今日已赚 ***' : '今日已赚 ≈ ' + fmt(earned, 'CNY'));
    return list;
  }
  // 拼「底稿 + 附加项」保证不超过两行：宽窄靠 .dshwv-hint-offwork 收，仍超就从尾巴整项丢、完整串挂 title
  // （不缩字号硬塞）；分隔符「，」比「 · 」窄。现在正常最多一项，丢弃循环作为多行 / 窄宽度兜底保留
  function fitOffworkHint(base, ov) {
    var parts = offworkHintParts(ov);
    var full = base + (parts.length ? (base ? '，' : '') + parts.join('，') : '');
    hintEl.classList.add('dshwv-hint-offwork'); hintEl.title = '';
    hintEl.style.whiteSpace = ''; // 上一轮截断兜底可能留下内联 nowrap：不清掉量到的永远是一行
    var lh = parseFloat(window.getComputedStyle(hintEl).lineHeight) || 0;
    var keep = parts.length, text = full;
    for (; keep >= 0; keep -= 1) {
      text = keep ? base + (base ? '，' : '') + parts.slice(0, keep).join('，') : base;
      setHintDirect(text);
      if (!keep || !lh || hintEl.offsetHeight <= lh * 2 + 1) break;
    }
    if (text !== full) hintEl.title = full;
    hintEl.classList.toggle('dshwv-hint-clamp', text !== full); // 硬兜底：进位多一字也不许第三行
    return text;
  }
  // 倒计时逐秒刷新：标题行 + 说明行附加项 + 进度条，只在文案变化时碰 DOM
  function applyOffworkView(force) {
    updateOffworkProgress(); // 进度条独立于文本判重：showSec 关掉时文案一分钟才变，进度条仍按秒刷新
    // 鲸鱼外的圈按当日工时进度递减（与气泡里的细进度条同一口径），同样不受文本判重影响
    if (offworkOwnsRing()) updateOffworkRing();
    if (!offworkCanRender()) { applyOffworkNear(null); return; }
    var ov = offworkState();
    if (!ov) { applyOffworkNear(null); return; }
    applyOffworkNear(ov.near);
    // 首行统一问 defaultLabelText；说明行只有附加项（周末 / 发薪 / 今日已赚）
    var title = defaultLabelText();
    // key 与实际渲染同一套拼法（底稿空串 + 「，」），余额显隐也算进去：切页 / 接管后翻回来必须重新复核
    var hintText = baseHintText === null ? '' : offworkHintParts(ov).join('，');
    var hideAmt = offworkHidesAmount();
    var key = title + '|' + hintText + '|' + (ov.near || '') + '|' + (hideAmt ? 1 : 0);
    if (!force && key === offworkLastKey) return;
    offworkLastKey = key;
    if (labelEl.textContent !== title) labelEl.textContent = title;
    // 复位字号：缩放累积进 dataset.k（只缩不放），秒数进位会越缩越小
    resetBubbleFont();
    // 说明行直写、不走 setHint 的淡入淡出：按秒刷新，每秒淡一次会一直闪
    if (hintText) fitOffworkHint('', ov);
    var amtDisplay = hideAmt ? 'none' : ''; // 余额行同进同退
    if (amountEl.style.display !== amtDisplay) amountEl.style.display = amtDisplay;
    fitBubbleText();
  }
  function offworkStep() {
    // 后台节流：复用既有的每秒巡检（bubbleTtlSweep），气泡没开时只刷圈、不碰文案，不做多余 DOM 操作。
    // 例外：计时在跑时它照常走，因为这是计时圈的每秒刷新入口（与气泡无关）
    if (!bubbleShown && !timerRunning) return;
    // 气泡收起时 render 不跑，圈要在这里自己跟着走
    if (!bubbleActive) updateTimerRing();
    if (!offworkCanRender()) return; // 被临时接管（拖拽台词 / 提醒 / 试播 / 随机台词）时不碰文案，圈上面已刷
    applyOffworkView(false);
  }
  // 开关 / 配置变化后的运行态切换：标题行与说明行统一交给 applyOffworkView / render 刷新
  function syncOffworkMode() {
    // 报时与倒计时可同时开（菜单里的报时开关不再置灰）：倒计时只占自己那一页，不挤报时首行
    if (animId) { cancelAnimationFrame(animId); animId = null; }
    if (animDelayTimer) { clearTimeout(animDelayTimer); animDelayTimer = null; }
    if (flashTimer) { clearTimeout(flashTimer); flashTimer = null; }
    amountEl.classList.remove('dshwv-flash-down', 'dshwv-flash-up');
    if (state.balance !== null) shown = state.balance;
    offworkLastKey = '';
    if (offworkOn) {
      updateTimerRing(); // 开关刚打开时立即亮圈，不等下一秒巡检
      applyOffworkView(true);
      return;
    }
    applyOffworkNear(null);
    updateOffworkProgress(); // 关掉倒计时后同步隐藏进度条
    if (!timerRunning && !timerPaused) setRing(false); // 圈归回计时（此刻没在计时就收起，否则 render 不会碰它）
    render(); // 标题行回到报时 / 余额，说明行去掉附加项，低余额红色等状态一并刷新
  }
  // 下班倒计时配置项：宿主已归一过，这里再走一次共享模块的同一套归一（防手改 / 老配置）
  function applyOffworkConfig(cfg) {
    if (!OFFWORK_CORE) { offworkOn = false; return; }
    var wasOn = offworkOn;
    var changed = false;
    var oc = OFFWORK_CORE;
    if (typeof cfg.offworkOn === 'boolean' && cfg.offworkOn !== offworkOn) {
      offworkOn = cfg.offworkOn; changed = true;
    }
    if (cfg.offworkStart !== undefined) {
      var st = oc.normHm(cfg.offworkStart, offworkStart);
      if (st !== offworkStart) { offworkStart = st; changed = true; }
    }
    if (cfg.offworkEnd !== undefined) {
      var en = oc.normHm(cfg.offworkEnd, offworkEnd);
      if (en !== offworkEnd) { offworkEnd = en; changed = true; }
    }
    if (cfg.offworkDays !== undefined) {
      var ds = oc.normDays(cfg.offworkDays, offworkDays);
      if (ds.join(',') !== offworkDays.join(',')) { offworkDays = ds; changed = true; }
    }
    if (cfg.offworkShowSec !== undefined) {
      var sec = cfg.offworkShowSec !== false;
      if (sec !== offworkShowSec) { offworkShowSec = sec; changed = true; }
    }
    if (cfg.offworkRing !== undefined) {
      var rg = cfg.offworkRing !== false;
      if (rg !== offworkRing) { offworkRing = rg; changed = true; }
    }
    if (cfg.ringWidth !== undefined) {
      var rw = cfg.ringWidth === 'thin' || cfg.ringWidth === 'thick' ? cfg.ringWidth : 'normal';
      if (rw !== ringWidth) { ringWidth = rw; changed = true; }
    }
    if (cfg.ringFollowTheme !== undefined) {
      var rf = cfg.ringFollowTheme !== false;
      if (rf !== ringFollowTheme) { ringFollowTheme = rf; changed = true; }
    }
    if (cfg.offworkWeekendOn !== undefined) {
      var we = cfg.offworkWeekendOn === true;
      if (we !== offworkWeekendOn) { offworkWeekendOn = we; changed = true; }
    }
    if (cfg.offworkPaydayOn !== undefined) {
      var pd = cfg.offworkPaydayOn === true;
      if (pd !== offworkPaydayOn) { offworkPaydayOn = pd; changed = true; }
    }
    if (cfg.offworkPaydayDay !== undefined) {
      var day = oc.normPayday(cfg.offworkPaydayDay);
      if (day !== offworkPaydayDay) { offworkPaydayDay = day; changed = true; }
    }
    if (cfg.offworkHourlyWage !== undefined) {
      // 与宿主 patchConfig 同口径：非法值保持现值，0 / 空表示「取消配置」
      var wg = typeof oc.normWage === 'function' ? oc.normWage(cfg.offworkHourlyWage) : 0;
      if (wg !== null && wg !== offworkHourlyWage) { offworkHourlyWage = wg; changed = true; }
    }
    if (!changed) return;
    // 关着的时候改时间 / 工作日不会影响任何展示，不必触发一次完整 render
    if (wasOn || offworkOn) syncOffworkMode();
  }

  function render() {
    var hint;
    var note = activeAdjustNote();
    armAdjustNoteTimer();
    // 下班倒计时不参与金额，只接管标题行（首行）与说明行的附加项：
    // 倒计时页与自定义步骤同队列共存；计时 / 提醒 / 试播 / 随机台词是临时接管，由 applyBubbleLines 罩住
    var realAmount = mainAmountText();
    var amount = realAmount;
    if (mainModelId !== 'deepseek') {
      // 主显示是别的模型：DeepSeek 的状态（错误/加载/今日已用/预算/调整说明）都不参与展示
      hint = modelDisplay().hint;
      baseHintText = null;
    } else if (state.status === 'error') {
      hint = state.message ? state.message.slice(0, 14) : '获取失败 · 点击重试';
      baseHintText = null;
    } else if (state.balance === null) {
      hint = '加载中…';
      baseHintText = null;
    } else {
      var usedText = (state.todayUsage !== null && state.todayUsage !== undefined) ? fmt(state.todayUsage, state.currency) : '--';
      var overAmt = budgetOverAmount();
      // 超预算后第三行常驻显示，不依赖「首次超出」那次提醒气泡
      baseHintText = note ? null : usedTodayText(usedText) + (overAmt !== null ? ' · 超预算 ' + fmt(overAmt, state.currency) : '');
      // 附加项（距周末 / 距发薪 / 今日已赚）不在这里拼：要按说明行两行高度截断（见 fitOffworkHint）
      hint = baseHintText === null ? note.text : baseHintText;
    }
    amountEl.textContent = amount;
    // 菜单「余额」置顶条与各组折叠摘要都跟着同一份状态走
    menuBalanceEl.textContent = realAmount;
    refreshMenuSummaries();
    var curPage = bubbleActive ? bubbleQueue()[bubbleIdx] : null; // 队列当前页：倒计时 / 常规页落常规分支
    if (bubbleTimerActive && timerActive()) {
      applyBubbleLines(timerLines());
      timerClockText = timerFinished ? '' : fmtClock(timerRemainMs());
    } else if (bubbleRemindActive && bubbleRemindLines) {
      applyBubbleLines(bubbleRemindLines);
    } else if (bubblePreviewActive && previewSession) {
      // 试播会话兜底：render() 被余额刷新等高频路径触发时保持会话当前步内容
      applyBubbleLines(previewSession.steps[previewSession.idx]);
    } else if (PAGES.isCustom(curPage)) {
      // 自定义步骤兜底：余额刷新 / 配置推送会把模型内容顶回常规三行；只在被顶掉时重画
      if (modsBox.style.display === 'none') bubbleRenderStep(curPage);
    } else if (bubbleRandomActive && bubbleRandomLines) {
      applyBubbleLines(bubbleRandomLines);
    } else {
      resetBubbleFont(); // 退出气泡文案后恢复默认字号
      applyLowAlert();
      // 标题行统一在这里写：倒计时页给倒计时，其余页 报时 > 「DeepSeek 余额」（换模型时是模型名）。
      // 退出计时 / 提醒等接管内容时也靠这一句把倒计时补回来
      labelEl.textContent = defaultLabelText();
      // 倒计时页不显示「今日已用」与余额：底稿换空串（baseHintText 仍保留「这页有说明行」的语义）
      var ovHint = baseHintText !== null && offworkCanRender() ? offworkState() : null;
      setHint(ovHint ? fitOffworkHint('', ovHint) : hint);
      // 余额行同理：只藏、不碰 textContent（计时与别的页靠它写大字）
      amountEl.style.display = offworkHidesAmount() ? 'none' : '';
      // 报时/余额文案过长时同样等比缩小，避免超出气泡（与计时/随机台词走同一套适配）
      fitBubbleText();
    }
    // render 也负责逐秒内容的立即刷新：气泡刚打开 / 手动刷新时不必等下一次每秒巡检。
    // 圈一起刷（render 是弹出/收起气泡、计时结束等一次性事件的入口，不该等下一秒巡检才对上）；
    // 倒计时关着时圈归计时，只在计时跑着才碰它，免得每次渲染都去摘环
    if (offworkOn || timerRunning || timerPaused) updateTimerRing();
    applyOffworkView(false);
  }

  // —— 余额 ——
  // 手动刷新的「等结果」视觉态。为什么不能靠 state.status = 'loading' 让文案自己表态：
  // render() 在 mainModelId !== 'deepseek' 分支里直接用模型自己的 hint，根本不看 status，
  // 所以主显示换成别的模型后点「刷新余额」，挂件面上一点动静都没有。
  // 这里改成与主显示模型无关的独立状态，由 refresh() 置位、handleBalance/失败/超时收尾。
  var refreshMaskTimer = null;
  var refreshBtnTimer = null;
  var PENDING_MANUAL_MS = 15000; // 「刷新中…」最长等待：按钮与呼吸圈共用的自愈上限
  function setRefreshing(on) {
    if (refreshMaskTimer) { clearTimeout(refreshMaskTimer); refreshMaskTimer = null; }
    body.classList.toggle('dshwv-refreshing', !!on);
    // 兜底：宿主那一路若因窗口重建等原因没回推结果，别让呼吸圈一直转
    if (on) refreshMaskTimer = setTimeout(function () { refreshMaskTimer = null; setRefreshing(false); }, PENDING_MANUAL_MS);
  }
  function setRefreshBtnBusy(on) {
    if (refreshBtnTimer) { clearTimeout(refreshBtnTimer); refreshBtnTimer = null; }
    refreshBalanceBtn.disabled = !!on;
    refreshBalanceBtn.textContent = on ? '刷新中…' : '刷新余额';
    // 等待期在「按钮吃不到这次结果」时自愈：主显示换成别的模型后，DeepSeek 那一路的结果
    // 会被 handleBalance 提前放行（只收呼吸圈、不碰按钮），不自己解就会一直锁着；
    // 取 15s 而不是按钮原本的 10s —— 手动刷新跳过缓存，慢网真要这么久，锁太短会让人以为刷新已结束
    if (on) refreshBtnTimer = setTimeout(function () { refreshBtnTimer = null; setRefreshBtnBusy(false); }, PENDING_MANUAL_MS);
  }
  function refresh(manual) {
    pendingManual = !!manual;
    if (manual) setRefreshBtnBusy(true);
    if (manual || state.balance === null) { state.status = 'loading'; render(); }
    if (manual) setRefreshing(true);
    whaleApi.refresh(manual);
    // 主显示不是内置 DeepSeek 时另外刷该模型：force 让它与 DeepSeek 同频（60s 一次）
    if (mainModelId !== 'deepseek') whaleApi.refreshModels([mainModelId], true);
  }
  function handleBalance(data, manual) {
    // 主显示不是内置 DeepSeek 时，DeepSeek 的余额变动、峰谷/预算/低余额提醒都不该出现：
    // 它的数字滚动动画会直接改写当前显示，提醒气泡也会盖掉模型内容
    // 但「手动刷新」的呼吸圈要收：那一路的结果来自 whale:models，与这里无关，
    // 不收的话只能等 15s 兜底，用户会以为刷新卡住了
    if (mainModelId !== 'deepseek') {
      if (manual) { setRefreshing(false); setRefreshBtnBusy(false); }
      return;
    }
    if (data && data.ok) {
      var nb = Number(data.totalBalance);
      var nc = String(data.currency || 'CNY');
      var changed = state.balance !== null && (nb !== state.balance || nc !== state.currency);
      var currencyChanged = state.currency !== null && nc !== state.currency;
      // 变动前的旧值必须在赋值前取：早先在赋值后取，prev === nb → 差值恒 0，
      // 结果「永远绿闪、大额提醒永不触发」（1.13.0 后未提交改动里的真实 bug）
      var prevBalance = state.balance;
      state.balance = nb;
      state.currency = nc;
      state.message = '';
      state.todayUsage = data.todayUsage !== undefined ? data.todayUsage : null;
      state.isPeak = !!data.isPeak;
      state.peakNextAt = Number(data.peakNextAt) || 0;
      // 本轮余额降幅（占位符 {change} 用）：宿主只在自动采样时给非零，手动刷新/缓存副本恒 0
      state.change = Number(data.change) || 0;
      // 第三行的临时说明，两种来源、后者优先：
      // 1) 本轮下降被判定为非消费（赠送额到期等）：解释 12s，正常采样不带此字段；
      // 2) 手动刷新的前后差额：8s。只认这一轮确实是用户手动点的（manual），
      //    手动刷新之后再来的自动采样不再标 —— 那已经不是用户按下的那一次了；
      //    币种变了不标（两级金额不可比），差额为 0 也不标
      var manualDelta = manual && !firstBalance && prevBalance !== null && !currencyChanged
        ? nb - prevBalance : 0;
      state.adjustNote = (data.adjust && data.adjust.amount)
        ? { text: adjustNoteText(data.adjust), until: Date.now() + ADJUST_NOTE_MS }
        : (manualDelta ? { text: manualDeltaText(manualDelta), until: Date.now() + MANUAL_DELTA_MS } : null);
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
        // 余额变动动效：下降闪红+微抖，上升闪绿+微弹。大额变动（>10%）额外弹气泡提醒
        var balanceDelta = nb - prevBalance;
        var flashCls = balanceDelta < 0 ? 'dshwv-flash-down' : 'dshwv-flash-up';
        amountEl.classList.remove('dshwv-flash-down', 'dshwv-flash-up');
        // 强制 reflow 以重启动画（同一类名连续添加不会重新播放）
        void amountEl.offsetWidth;
        amountEl.classList.add(flashCls);
        if (flashTimer) clearTimeout(flashTimer);
        flashTimer = setTimeout(function () {
          flashTimer = null;
          amountEl.classList.remove('dshwv-flash-down', 'dshwv-flash-up');
        }, 1300);
        if (!manual && !firstBalance && prevBalance > 0 && Math.abs(balanceDelta) / prevBalance > 0.1) {
          var directionText = balanceDelta < 0 ? '下降' : '上升';
          // 金额带币种：非 CNY 账户光写 3.50 看不出是美元还是别的
          var deltaText = (balanceDelta < 0 ? '-' : '+') + fmt(Math.abs(balanceDelta), nc);
          showRemindBubble([
            { t: '余额大幅' + directionText, s: 'A', c: balanceDelta < 0 ? '#e0433f' : '#2fa24c' },
            { t: '变动 ' + deltaText, s: 'P', c: balanceDelta < 0 ? '#e0433f' : '#2fa24c' },
            { t: '请留意账户状态', s: 'C', c: '', w: true },
          ]);
        }
        if (!manual && !firstBalance) {
          // 自动刷新发现余额变动：气泡弹出，0.3s 后数字滚动
          // 峰谷提醒优先，避免被余额气泡覆盖；用户正在看随机/拖拽/试播台词时也不顶掉
          // （那是显式交互，余额变动不紧急，点一下鲸鱼随时能看），数字滚动照常进行
          if (!bubbleRemindActive && !bubbleRandomActive && !bubblePreviewActive) showBubble();
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
      // 恢复提示：之前连续失败 ≥3 次，现在终于拉到了真实数据（recovered 由宿主在恢复那一次标记）
      if (data.recovered) {
        showRemindBubble([
          { t: '网络恢复', s: 'A', c: '#2fa24c' },
          { t: '余额获取已恢复正常', s: 'P', c: '#2fa24c' },
          { t: '继续监控中…', s: 'C', c: '', w: true },
        ]);
      }
      lastFailCount = 0;
      if (manual) { setRefreshing(false); setRefreshBtnBusy(false); }
    } else {
      state.status = 'error';
      // 气泡空间小，错误提示用短句；完整原因在设置页「测试连接」里查看
      var code = data && data.code;
      state.message = code === 'AUTH' ? 'API Key 无效 · 请到设置页检查'
        : code === 'BAD_KEY' ? 'Key 格式错误 · 应为 sk- 开头'
        : code === 'NO_KEY' ? '未配置 API Key · 请到设置页填写'
        : (data && data.error) ? String(data.error).slice(0, 14) : '获取失败 · 点击重试';
      render();
      // 连续失败 ≥3 次时弹气泡提醒（只在首次跨过阈值时弹一次，避免每分钟重复打扰）
      var failCount = (data && data.consecutiveFailures) || 0;
      if (failCount >= 3 && lastFailCount < 3) {
        var errTitle = code === 'AUTH' ? 'API Key 无效'
          : code === 'NO_KEY' ? '未配置 API Key'
          : '余额获取失败';
        showRemindBubble([
          { t: errTitle, s: 'A', c: '#e0433f' },
          { t: '连续 ' + failCount + ' 次刷新失败', s: 'P', c: '#e0433f' },
          { t: '请检查网络或 API Key 设置', s: 'C', c: '', w: true },
        ]);
      }
      lastFailCount = failCount;
      if (manual) { setRefreshing(false); setRefreshBtnBusy(false); }
    }
  }

  // —— 多厂商模型（宿主 whale:models 推送）——
  // 峰谷/预算/用量口径/余额操作都是 DeepSeek 专属：主显示换成别的模型时整组收起。
  // 余额条不受影响 —— 它在折叠组之外常显，且走 mainAmountText()（主显示换哪个模型就跟哪个）
  function applyModelVisibility() {
    groupUsage.el.style.display = mainModelId === 'deepseek' ? '' : 'none';
    // 余额条与「复制」按钮的「名分」都跟着主显示类型走：额度型主显示时写「余额 62%」
    // 说的是和显示的不是一回事（见 mainAmountLabel）
    var amountLabel = mainAmountLabel();
    menuBalanceLabelEl.textContent = amountLabel;
    // 名字过长会被 CSS 的省略号裁掉，悬停给全名
    menuBalanceLabelEl.title = amountLabel;
    if (!copyBtnBusy) copyBalanceBtn.textContent = copyAmountLabel();
    copyBalanceBtn.title = copyAmountLabel() + '到剪贴板';
  }
  function handleModels(data) {
    if (!data || typeof data !== 'object') return;
    // refreshDone = 宿主刷新流程收尾那次推送（先前那次只是把旧快照推来垫显示）→ 解锁「刷新全部」，
    // 同时收掉手动刷新的呼吸圈与「刷新余额」按钮（主显示不是 DeepSeek 时，用户点的刷新结果就在这一路里）
    if (data.refreshDone) { setModelsRefreshBusy(false); setRefreshing(false); setRefreshBtnBusy(false); }
    var prev = mainModelId;
    models = Array.isArray(data.list) ? data.list : [];
    mainModelId = String(data.mainModelId || 'deepseek');
    renderModelsMenu();
    applyModelVisibility();
    positionMenu(); // 行数变化后重新夹取高度，避免菜单被窗口边缘裁掉
    // 主显示切换：DeepSeek 侧的比对基准作废。留着旧 state.balance，切回来第一次采样会拿
    // 切换前的余额当「上一次」再比一遍（误报余额变化 / 大幅波动），今日用量与峰谷、低余额、
    // 预算的越线记忆同理。重置后首样本只建基线，不触发任何「变化」提示。
    if (prev !== mainModelId) {
      state.balance = null;
      state.todayUsage = null;
      state.change = 0;
      state.adjustNote = null;
      state.lowOver = false;
      state.budgetOver = false;
      lastIsPeak = null;
      firstBalance = true;
    }
    if (mainModelId !== 'deepseek') {
      render();
    } else if (prev !== mainModelId) {
      // 切回内置 DeepSeek：状态可能已是一分钟前的，立刻要一次新的。
      // 必须 manual=true：宿主对自动刷新有 25s 缓存，不复用缓存才拿得到新余额。
      // 但不能走 refresh(true) —— 那会点亮手动刷新的呼吸圈与按钮忙碌态，而这是切换触发的
      try { whaleApi.refresh(true); } catch (err) { logErr('[whale][page] 切回 DeepSeek 刷新失败', err && err.message); }
    }
  }

  // —— 配置（菜单改动 → 上报宿主；宿主回推 config 统一 apply） ——
  // 显式补丁：只提交这次真正改动的键。不能再整份提交 ——
  // 1) 本页只读的配置（邮件开关 / uiMode / 到点留言 / 休息档…）会被本页的旧副本一起写回，
  //    设置页刚改完、回推还没到，就被菜单里的任意一次操作盖掉了；
  // 2) 计时时长 / 模式现在只是「这一轮」的参数，不该借任何一次保存改掉默认值
  //   （早前 startTimer 整份 saveCfg，点一次快捷档位就把默认时长改了）。
  // 宿主 patchConfig 对 undefined 键是「不动」，所以只传改动键是安全的。
  function saveCfg(patch) {
    if (!patch) return;
    try { whaleApi.saveConfig(patch); } catch (err) { logErr('[whale][page] 保存配置失败', err && err.message); }
  }
  // 拖动中的实时预览：rAF 合并，只通知宿主改窗口几何，不写存储、不回推
  // 拖拽中不进这里：滚轮 handler 已按 `drag.active` 挡掉实时缩放，而菜单（唯一另一处
  // setScale(false) 来源）在 pointerdown 时就被 closeMenu 关掉了，所以拖拽期本函数只可能
  // 被滚轮调到、且已被上游拦住。这里不再重复判 `drag.active` —— 拖拽冻结的**最终防线在宿主**
  // （applyScaleToWindow 的 dragFrozen，它同时兜住 commit=true 的 saveCfg 路径），
  // 页面侧只负责拦本地滚轮手势，两处判据职责不同，合成一处反而会让 commit 路径丢请求。
  var liveRaf = 0, liveTimer = 0;
  function cancelLiveSlot() {
    if (liveRaf) { cancelAnimationFrame(liveRaf); liveRaf = 0; }
    if (liveTimer) { clearTimeout(liveTimer); liveTimer = 0; }
  }
  // 页面侧 rAF 在窗口被遮挡时会被 Chromium 暂停（挂件常被别的窗口盖住），
  // 只靠 rAF 会让「排队的那次推送永远不发」→ 宿主收不到实时值、拖动中不实时。
  // 用 setTimeout 与 rAF 竞速，谁先到谁执行，保证最坏 ~16ms 一定把最新 scale 推出去。
  // ⚠️ 现在只有滚轮缩放（setScale 的 live 分支）走这里；菜单/设置页滑块拖动一律不推实时值，
  //    见 setScale 的注释（拖动中改窗口尺寸是「拖不动 + 快滑闪」的根因）。
  function sendLiveScale() {
    if (liveRaf || liveTimer) return;
    var push = function () {
      cancelLiveSlot();
      whaleApi.saveConfig({ scale: curScale, __live: true });
    };
    liveRaf = requestAnimationFrame(push);
    liveTimer = setTimeout(push, 16);
  }
  // live=true 才推实时值给宿主（现仅滚轮用）；菜单滑块拖动走 live=false —— 只更新读数与
  // 本地 curScale，窗口尺寸一次都不改，松手(change)才 numToScale 落库并让宿主改窗口。
  // 为什么：滑块所在窗口就是被缩放的对象，拖动中 setBounds 会让窗口边动边缩、thumb 追着手抖，
  // 快速滑动更是每帧一次 setBounds 导致闪烁。拖动期只动 DOM、零重绘，体感最稳。
  function setScale(v, live, commit) {
    // v 是滑块档位（1–SCALE_STEPS）；窗口尺寸由宿主调整（以鲸鱼角为不动点），
    // 推给宿主的始终是倍率 curScale。
    var n = Math.max(1, Math.min(SCALE_STEPS, Math.round(Number(v) || 1)));
    curScale = numToScale(n);
    scaleInput.value = String(n);
    scaleVal.textContent = String(n);
    paintScaleTicks(n);
    if (commit) { cancelLiveSlot(); saveCfg({ scale: curScale }); }
    else if (live) sendLiveScale();
  }
  function setVol(v, commit) {
    var next = Math.round(Math.min(1, Math.max(0, Number(v))) * 100) / 100;
    soundVol = next;
    volInput.value = String(next);
    volPct.textContent = Math.round(next * 100) + '%';
    applySoundVolume();
    if (commit) saveCfg({ vol: soundVol }); // 拖动中只改本地音量，松手才持久化（避免高频存储写入）
  }
  function setSoundSet(v) {
    soundSet = (v === 'fx1' || v === 'custom') ? v : 'duck';
    soundSelect.value = soundSet;
    applySoundSet();
    // 切音色会重建 Audio 池（applySoundSet 里 new Audio），新建的 Audio 默认 volume=1；
    // 这里不重落一次音量，切完的第一声会以满音量播，直到下次配置全量推送才纠正（曾踩）
    applySoundVolume();
    saveCfg({ soundSet: soundSet });
  }
  // 挂件菜单透明度档位（设置页有连续滑块，同一配置字段）
  function setOpacityPreset(v) {
    var n = Math.round(Number(v));
    if (OPACITY_PRESETS.indexOf(n) < 0) return;
    opacityPct = n;
    opacitySelect.value = String(n);
    saveCfg({ opacity: opacityPct }); // opacity 随配置广播回本页，applyConfig 把它落到 root 的 CSS opacity
  }
  function setSoundOn(v) {
    soundOn = !!v;
    soundToggle.checked = soundOn;
    saveCfg({ soundOn: soundOn });
  }
  function setUsageMode(v) {
    usageMode = v === 'token' ? 'token' : 'ledger';
    usageSelect.value = usageMode;
    saveCfg({ usageMode: usageMode });
    refresh(false); // 宿主在 usageMode 变化时已清缓存，会重算今日已用
  }
  function setPeakMode(v) {
    peakMode = (v === 'liangwen' || v === 'qiangqiang') ? v : 'default';
    peakSelect.value = peakMode;
    saveCfg({ peakMode: peakMode });
  }
  function setBubbleOn(v) {
    bubbleOn = !!v;
    bubbleToggle.checked = bubbleOn;
    saveCfg({ bubbleOn: bubbleOn });
    if (!bubbleOn) hideBubble();
  }
  function setTimeBubbleOn(v) {
    timeBubbleOn = !!v;
    timeToggle.checked = timeBubbleOn;
    saveCfg({ timeBubbleOn: timeBubbleOn });
    // 报时来回切会改首行（倒计时页归属也随之变化），必须整体重排而不是只换首行
    if (bubbleShown && !bubbleRandomActive && !bubblePreviewActive) render();
  }
  function setPeakRemindOn(v) {
    peakRemindOn = !!v;
    remindToggle.checked = peakRemindOn;
    saveCfg({ peakRemindOn: peakRemindOn });
    if (!peakRemindOn && bubbleRemindActive) hideBubble();
  }
  function setDragLock(v) {
    dragLock = !!v;
    lockToggle.checked = dragLock;
    saveCfg({ dragLock: dragLock });
  }
  // 请求宿主唤出 uTools 主窗（设置页）。target 可选（如 'quotes' 直达按压气泡卡）
  function openSettings(target) {
    try { whaleApi.openSettings(target || null); } catch (err) { logErr('[whale][page] 打开设置失败', err && err.message); }
  }
  function applyConfig(cfg) {
    if (!cfg || typeof cfg !== 'object') return;
    if (typeof cfg.scale === 'number' && isFinite(cfg.scale)) {
      // 吸附到最近整数档：旧存储里的 1.3 这类非整档倍率要归到档位，
      // 否则滑块停在两档之间、读数与滑块位置对不上（滑块 step=1 只能停整数档）
      var n = snapNum(cfg.scale);
      curScale = numToScale(n);
      scaleInput.value = String(n);
      scaleVal.textContent = String(n);
      paintScaleTicks(n);
    }
    if (typeof cfg.vol === 'number' && isFinite(cfg.vol)) {
      soundVol = Math.min(1, Math.max(0, cfg.vol));
      volInput.value = String(soundVol);
      volPct.textContent = Math.round(soundVol * 100) + '%';
    }
    if (cfg.alertVols && typeof cfg.alertVols === 'object') {
      // 只认 0-1 数字与布尔位，非法字段回当前值（宿主 store.js 已归一化，这里兜一层）
      for (var avKey in alertVols) {
        var avIn = cfg.alertVols[avKey];
        if (!avIn || typeof avIn !== 'object') continue;
        if (typeof avIn.vol === 'number' && isFinite(avIn.vol)) alertVols[avKey].vol = Math.min(1, Math.max(0, avIn.vol));
        if (typeof avIn.volSet === 'boolean') alertVols[avKey].volSet = avIn.volSet;
      }
    }
    if (typeof cfg.soundOn === 'boolean') {
      soundOn = cfg.soundOn;
      soundToggle.checked = soundOn;
    }
    // 金额遮蔽：从设置/备份恢复/另一窗口改过来时同步本地并立刻重绘（只重绘一次，值没变就跳过）
    if (typeof cfg.hideAmounts === 'boolean' && cfg.hideAmounts !== hideAmounts) {
      hideAmounts = cfg.hideAmounts;
      updateMaskBtnUi();
      render();
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
    if (typeof cfg.passThrough === 'boolean') {
      // 逃生行按「当前值」无条件刷一遍：只在值变化的分支里设，重新 applyConfig 时
      // 同一个值也要保证显隐与按钮态是对的
      syncPassRow(cfg.passThrough);
      if (cfg.passThrough !== passThroughOn) {
        passThroughOn = cfg.passThrough;
        // 状态切换：清掉悬停接管的中间态，立即生效（不能等下一次 mousemove —— 鼠标可能正静止）
        passHoverActive = false;
        passDwellCancel();
        passReleaseCancel();
        // 开关穿透即改变「指针是否与挂件交互」的前提，旧悬停点不再可信（鼠标可能正静止，
        // 不会有 pointermove 来纠正），作废它，让按钮先收起
        lastHoverPt = null;
        menuBtn.classList.remove('dshwv-menu-btn-visible');
        if (passThroughOn) {
          if (menuOpen) closeMenu();
          sendIgnoreMouse(true);
          if (passNoticeReady) showPassNotice(true);
        } else {
          // 关闭穿透：先按安全默认忽略鼠标，指针移到鲸鱼上时悬停逻辑会重新判定
          // 菜单此刻若开着要一并收起：开启分支已 closeMenu，这里必须对称，
          // 否则菜单留在屏上、窗口却已 ignoreMouse=true，点了会穿透到下层应用
          if (menuOpen) closeMenu();
          sendIgnoreMouse(true);
          if (passNoticeReady) showPassNotice(false);
        }
        passApplyIndicator();
      }
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
        if (menuOpen) closeMenu();
        applyMenuBtnAtLast(); // applyMenuBtn 的 menuBtnEnabled=false 分支会移除 visible
      }
    }
    // 菜单分组展开态**不从配置回填**：展开组合不落盘、不记忆，每次开菜单都重置（见 toggleMenu）。
    // 设置页 / 别的窗口没有该键的入口，无需同步。
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
    if (typeof cfg.tapAdvance === 'boolean') tapAdvance = cfg.tapAdvance;
    // 全局默认气泡停留时长（秒）：3–60 整数才覆盖，其余（缺省/脏值）回落出厂 5s。
    // 宿主 normConfig 已把非法值摘键，这里只做运行期兜底
    if (typeof cfg.bubbleDwell === 'number' && isFinite(cfg.bubbleDwell)
      && cfg.bubbleDwell >= 3 && cfg.bubbleDwell <= 60) {
      bubbleDwellMs = Math.round(cfg.bubbleDwell) * 1000;
    }
    // 拖拽台词：非空字符串数组才覆盖（空数组会让拖拽没词，保留内置默认）；
    // 逐条清洗（trim + 截 60 字）与宿主 normLineList 同口径，防脏载荷
    if (Array.isArray(cfg.dragLines)) {
      var dl = [];
      for (var di = 0; di < cfg.dragLines.length && dl.length < 10; di++) {
        if (typeof cfg.dragLines[di] !== 'string') continue;
        var ds = cfg.dragLines[di].trim().slice(0, 60);
        if (ds) dl.push(ds);
      }
      if (dl.length) DRAG_LINES = dl;
    }
    if (typeof cfg.timeBubbleOn === 'boolean' && cfg.timeBubbleOn !== timeBubbleOn) {
      timeBubbleOn = cfg.timeBubbleOn;
      timeToggle.checked = timeBubbleOn;
      // 与倒计时共用首行 / 说明行：只在值真变时整体重排（不能只换首行）
      if (bubbleShown && !bubbleRandomActive && !bubblePreviewActive) render();
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
    // 到点通知只在设置页改；这里只回填本地副本（到点通知要用）
    if (typeof cfg.timerNotifyOn === 'boolean') timerNotifyOn = cfg.timerNotifyOn;
    if (typeof cfg.timerMailOn === 'boolean') timerMailOn = cfg.timerMailOn;
    if (typeof cfg.notifyMailOn === 'boolean') mailOn = cfg.notifyMailOn;
    if (typeof cfg.timerPersistOn === 'boolean') timerPersistOn = cfg.timerPersistOn;
    // 默认时长 / 定时刻：只在宿主值真的变化时才回填。
    // 宿主每次广播配置都会走到这里（菜单里改音量也会广播），无条件回填会把用户
    // 刚在菜单里改好的「本轮目标」打回默认值 —— 看起来就像「改了不生效」。
    // 计时中收到新默认时长先压着（pendingTimerSec），回到空闲由 syncTimerMenu 落地：
    // 此刻输入框正锁着，当场改写会让「本轮目标」看着变长/变短。
    if (typeof cfg.timerSec === 'number' && isFinite(cfg.timerSec)) {
      var ts = Math.min(TIMER_MAX_SEC, Math.max(0, Math.round(cfg.timerSec))) || TIMER_MIN_DEFAULT * 60;
      if (ts !== cfgTimerSecSeen) {
        cfgTimerSecSeen = ts;
        if (timerRunning || timerPaused) pendingTimerSec = ts;
        else writeTimerTargetSec(ts);
      }
    }
    if (typeof cfg.timerAt === 'string' && /^\d{1,2}:\d{2}$/.test(cfg.timerAt)) {
      if (cfg.timerAt !== cfgTimerAtSeen) {
        cfgTimerAtSeen = cfg.timerAt;
        // 焦点在定时刻输入框时跳过：用户正在编辑，交由 commitOnEnter 提交
        if (!timerRunning && !timerPaused && !timerEditing(timerTime)) timerTime.value = cfg.timerAt;
      }
    }
    // 留言 / 休息档：菜单里已无输入框，只回填本地副本（到点气泡与「休息 N 分钟」按钮用）
    if (typeof cfg.timerNote === 'string') {
      timerNote = cfg.timerNote.slice(0, TIMER_NOTE_MAX);
    }
    if (typeof cfg.timerBreakMin === 'number' && isFinite(cfg.timerBreakMin)) {
      timerBreakMin = Math.min(120, Math.max(0, Math.round(cfg.timerBreakMin)));
    }
    // 番茄循环三键：开关 / 长休时长 / 每 N 轮长休
    if (typeof cfg.timerPomoOn === 'boolean') timerPomoOn = cfg.timerPomoOn;
    if (typeof cfg.timerLongBreakMin === 'number' && isFinite(cfg.timerLongBreakMin)) {
      timerLongBreakMin = Math.min(60, Math.max(1, Math.round(cfg.timerLongBreakMin)));
    }
    if (typeof cfg.timerLongEvery === 'number' && isFinite(cfg.timerLongEvery)) {
      timerLongEvery = Math.min(12, Math.max(2, Math.round(cfg.timerLongEvery)));
    }
    // 到点自动衔接下一条待办（v1.17 可选恢复）：只有显式 true 才开。
    // 关掉的那一刻把还在等待的衔接一并作废，否则「刚关掉却还是自己跑起来了」
    todoAutoNext = cfg.todoAutoNext === true;
    if (!todoAutoNext) cancelPomoAutoNext();
    // 到点气泡停留：设置页改，本地副本供到点气泡 / 通知用
    if (typeof cfg.timerRemindSec === 'number' && isFinite(cfg.timerRemindSec)) {
      var sec = Math.round(cfg.timerRemindSec);
      timerRemindSec = (sec === 0 || sec === 5 || sec === 8 || sec === 15) ? sec : 8;
    }
    var bubblePrefsChanged = false;
    // 两个气泡开关只在设置页有入口：这里回填本地副本；值变了要让计时气泡立刻按新口径重显
    if (typeof cfg.timerBubblePin === 'boolean' && cfg.timerBubblePin !== timerBubblePin) {
      timerBubblePin = cfg.timerBubblePin;
      bubblePrefsChanged = true;
    }
    if (typeof cfg.timerBubbleOnly === 'boolean' && cfg.timerBubbleOnly !== timerBubbleOnly) {
      timerBubbleOnly = cfg.timerBubbleOnly;
      bubblePrefsChanged = true;
    }
    // 设置页改了这两个开关：计时中立刻让气泡按新口径重显，不必等下一次刷新
    if (bubblePrefsChanged) applyTimerBubblePrefs();
    // 默认模式：同样只在宿主值变化时套用。快捷档位 / 待办开始会把本地模式临时切到倒计时，
    // 若每次广播都按 cfg 重写，随手调一下音量就把这一轮的准备状态打回「关闭」了
    if (cfg.timerMode === 'off' || cfg.timerMode === 'up' || cfg.timerMode === 'down' || cfg.timerMode === 'at') {
      if (cfg.timerMode !== cfgTimerModeSeen && !timerActive()) {
        timerMode = cfg.timerMode;
        cfgTimerModeSeen = cfg.timerMode;
      }
    }
    // 挂件形象与气泡配色：值没变时 applySkin/applyTheme 内部自己短路，不必先比对
    if (typeof cfg.skin === 'string') {
      // 认不出的值（老配置里的历史内置 id、或形象已从包里移出）不能直接落回默认形象：
      // 那些图都在「自定义画廊」里，宿主 current 就指着它 —— 落回默认会让挂件先闪一下内置形象。
      // 与宿主 store.normSkin 的「不打回默认」同口径，改用宿主推来的 current 那张。
      // 注意只能回 'custom'（而不是 DEFAULT_SKIN）：否则 img.src 会先切到内置相对路径，
      // 紧接着下面 customSkin 被赋值、onSkin 回调又换一次图，同样闪一下
      skinId = (cfg.skin === 'custom' || BUILTIN_SKIN_IDS.indexOf(cfg.skin) >= 0) ? cfg.skin
        : (customSkin ? 'custom' : DEFAULT_SKIN);
      applySkin();
    }
    if (typeof cfg.theme === 'string') {
      themeId = (cfg.theme === 'dark' || cfg.theme === 'sakura' || cfg.theme === 'fantasy') ? cfg.theme : 'default';
      applyTheme();
    }
    // 界面深浅色偏好：值变了就立即重新合成（utoolsDark 缓存已是最新，不用等下一轮推送）
    if (typeof cfg.uiMode === 'string') {
      var nextUiMode = (cfg.uiMode === 'light' || cfg.uiMode === 'dark' || cfg.uiMode === 'fantasy') ? cfg.uiMode : 'auto';
      if (nextUiMode !== uiMode) { uiMode = nextUiMode; applyDark(); }
    }
    // 固定文案池（报时四池 + 动图降级）：挂在按压气泡模型的 system 键上，非空字符串数组才覆盖
    //（空数组会让报时/降级文案没字）
    // 新按压气泡模型（bubble.on 开启时挂件改走它；与顶层交互项各管各）：
    // 宿主 store.normBubble 已归一化，这里只做运行期兜底与落地
    if (cfg.bubble && typeof cfg.bubble === 'object') {
      var bub = cfg.bubble;
      if (bub.system && typeof bub.system === 'object') {
        for (var qi = 0; qi < QUOTE_TEXT_KEYS.length; qi++) {
          var qk = QUOTE_TEXT_KEYS[qi];
          if (Array.isArray(bub.system[qk]) && bub.system[qk].length) QUOTES[qk] = bub.system[qk].slice();
        }
      }
      var wasOn = bubbleModelOn;
      // 自定义泡泡开关只决定「用你自己的队列」还是「用出厂默认队列」，两者都走按压气泡渲染；
      // 与顶层「思考气泡」（bubbleOn）分开记：后者是弹不弹气泡的总闸。开启自定义时仍顺手把总闸
      // 打开（与早先行为一致），但不再有「关掉自定义就退回常规三行页」那条路
      bubbleModelOn = bub.on === true;
      if (bubbleModelOn) bubbleOn = true;
      bubbleItems = Array.isArray(bub.items) ? bub.items : [];
      // 出厂默认队列（宿主用 store.normBubble(null).items 生成，随配置下发、不落存储）：
      // 未开启自定义泡泡时页面改用这份，渲染结果与「未被用户改过的默认配置」完全一致
      bubbleDefaultItems = Array.isArray(bub.dft) ? bub.dft : [];
      if (typeof bub.tapAdvance === 'boolean') bubbleTapAdvanceOn = bub.tapAdvance;
      if (typeof bub.dwell === 'number' && isFinite(bub.dwell) && bub.dwell >= 3 && bub.dwell <= 60) {
        bubbleModelDwellMs = Math.round(bub.dwell) * 1000;
      }
      if (Array.isArray(bub.dragLines)) {
        var bdl = [];
        for (var bi = 0; bi < bub.dragLines.length && bdl.length < 10; bi++) {
          if (typeof bub.dragLines[bi] !== 'string') continue;
          var bs = bub.dragLines[bi].trim().slice(0, 60);
          if (bs) bdl.push(bs);
        }
        bubbleDragLines = bdl;
      }
      // 队列构成变了（倒计时页 ± 自定义步骤）：气泡若正显示就按新队列重显一次，避免残留旧内容
      if (bubbleShown && (bubbleModelOn !== wasOn)) {
        if (bubbleOn) showBubble(false); // 交给 showNormalBubble：索引越界会自己回到第一页
        else hideBubble();
      }
    }
    // 提醒文案模板：只接受非空字符串（空模板会让气泡没字），逐条覆盖
    if (cfg.alerts && typeof cfg.alerts === 'object') {
      for (var ak in ALERTS) {
        if (typeof cfg.alerts[ak] === 'string' && cfg.alerts[ak]) ALERTS[ak] = cfg.alerts[ak];
      }
    }
    // 专注与待办：一个总开关（v1.15 合并 focusOn / todoOn）。少一次「关了这个没关那个」；
    // 任务开始 / 气泡尾注 / 到点完成这条仍不受它门控（见 2026-11-01 spec）。
    // 旧宿主读盘兜底 focusOn 已在 store.readConfig 里做掉，挂件只认最终结果
    var todoPrefsChanged = false;
    if (typeof cfg.todoOn === 'boolean' && cfg.todoOn !== todoOn) { todoOn = cfg.todoOn; todoPrefsChanged = true; }
    // 接力依赖挂件里的待办清单：关掉 todoOn 就退回「时间到」，不留一个指向隐藏清单的下一步
    if (!todoOn && timerHandoff) {
      clearTimerHandoff();
      if (bubbleTimerActive && timerFinished) showTimerBubble(timerRemindMs());
    }
    // 下班倒计时配置：开关 / 运行态与主体展示都在这里收口（关掉后 render 走原路径）
    applyOffworkConfig(cfg);
    if (todoPrefsChanged) {
      renderTodoMenu();
      // 计时气泡的尾注里带不带「专注：xxx」取决于上面的开关与清单，正显示着就重画一次
      if (bubbleTimerActive) {
        applyBubbleLines(timerLines());
        timerClockText = timerFinished ? '' : fmtClock(timerRemainMs());
        updateTimerActions();
      }
    }
    // 快捷档位（设置页可改）：落到四个芯片的文案与可点分钟数
    if (Array.isArray(cfg.timerPresets)) applyTimerPresets(cfg.timerPresets);
    syncTimerMenu();
    applySoundVolume();
    // 配置落地即首帧就位：放行画面（见 floating.css 的 .dshwv-root:not(.dshwv-ready)）。
    // 放在 applyConfig 而非启动末尾 —— 自定义形象本体要等这里 whale:skin 落地才对，
    // 提前放行仍会闪内置形象。配置没推来时由宿主 createWidget 的超时兜底显示，不会永远隐形
    try { root.classList.add('dshwv-ready'); } catch (err) {}
  }

  // —— 音效 ——
  var SQUISH = 'scaleY(0.88) scaleX(1.05)';
  // 每个槽位是一组音频，播放时随机取一条（听久了不腻）。Audio 对象按 URL 缓存并预加载：
  // 每次播放都新建会多一次解码等待，而 pressUp 还要读当前按压音的 duration 才能决定何时接释放音
  var audioPool = {};
  function audioFor(url, vol) {
    if (!url) return null;
    if (!audioPool[url]) {
      try {
        var a = new Audio(url);
        a.preload = 'auto';
        audioPool[url] = a;
      } catch (err) { return null; }
    }
    // 音量每次取用时落（不只在创建时）：同一 URL 的归属可能随配置变化，创建时的值会过期
    if (typeof vol === 'number' && isFinite(vol)) audioPool[url].volume = Math.min(1, Math.max(0, vol));
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
  // 池里已收着全部音频对象，遍历它一处即够，免得新增槽位后漏掉某一处。
  // 池按 URL 混存音色与提醒音，落音量要先查 URL 归属：提醒音 URL 走各自独立音量（未设置跟全局），
  // 其余走全局 —— 不能一把统一赋 soundVol，否则用户给某类提醒音单独调的音量会被冲掉
  function applySoundVolume() {
    try {
      for (var url in audioPool) {
        if (!audioPool[url]) continue;
        var role = alertRoleOfUrl(url);
        audioPool[url].volume = role ? alertVolumeOf(role) : soundVol;
      }
    } catch (err) {}
  }

  // —— 提醒音（低余额 / 预算 / 峰谷 / 穿透，每类可多段，随机播一条） ——
  // 与上面的「音色」相互独立：用户导入了就用导入的，没导入回落到内置提醒音（ALERT_FALLBACK），
  // 所以提醒默认是有声音的；不想要声音请关「音效开关」或把该类音量调到 0。
  // 播放只受「音效开关 + 音量」影响，不受音色选择影响。
  var alertUrls = { low: [], budget: [], peak: [], pass: [] };
  function applyAlertSounds() {
    for (var role in alertUrls) {
      var own = toList(customSounds[role]);
      alertUrls[role] = own.length ? own : toList(ALERT_FALLBACK[role]);
      for (var i = 0; i < alertUrls[role].length; i++) audioFor(alertUrls[role][i], alertVolumeOf(role));
    }
    prunePool();
  }
  // 三态音量解析（仿 DSH 网页版 soundVolumeOf）：显式传参 > 该类独立音量（volSet=true 才认）
  // > 跟随全局。⚠️ 独立音量是 0 时也必须生效（静音是合法选择），所以不能写 `Number(x) || 全局`
  function alertVolumeOf(role, override) {
    if (typeof override === 'number' && isFinite(override)) return Math.min(1, Math.max(0, override));
    var av = alertVols[role];
    if (av && av.volSet === true) {
      var n = Number(av.vol);
      if (isFinite(n)) return Math.min(1, Math.max(0, n));
    }
    return soundVol;
  }
  // URL → 提醒音槽位归属：applySoundVolume 给整池落音量时用，音色 URL 不在表里返回 null
  function alertRoleOfUrl(url) {
    for (var role in alertUrls) {
      if (alertUrls[role].indexOf(url) >= 0) return role;
    }
    return null;
  }
  function playAlertSound(role) {
    if (!soundOn) return;
    var a = audioFor(pickUrl(alertUrls[role]), alertVolumeOf(role));
    if (!a) return; // 内置回落也拿不到（音频不可用）= 静音
    try {
      a.currentTime = 0;
      var p = a.play();
      if (p && typeof p.catch === 'function') p.catch(function () {});
    } catch (err) {}
  }

  // —— 菜单 ——
  // 滚动边界提示：面板滚到顶端 / 底端时收回对应那一道边影（样式见 floating.css 的 ::before/::after）。
  // 两端都还剩内容时两道都显示；整个面板装得下（scrollHeight == clientHeight）时两道都不显示
  function syncMenuScrollEdges() {
    var top = menuBox.scrollTop;
    var rest = menuBox.scrollHeight - menuBox.clientHeight - top;
    // 1px 容差：高分屏下 clientHeight 可能带小数，四舍五入后永远「差一点点」而两边都亮着
    menuBox.classList.toggle('dshwv-menu-scroll-up', top > 1);
    menuBox.classList.toggle('dshwv-menu-scroll-down', rest > 1);
  }
  menuBox.addEventListener('scroll', syncMenuScrollEdges, { passive: true });
  function toggleMenu() {
    // 拖拽中一律不许开菜单：拖动会持续派发 pointermove，菜单既挡鲸鱼又会跟着窗口挪，
    // 容易误点进菜单项。右键唤菜单已在 contextmenu 里单独挡，这里兜住其余调用点
    // （触控第二根手指点按钮、外部触发等）。已开着就顺手收起，不留给拖拽结束。
    if (drag && drag.active) {
      if (menuOpen) closeMenu();
      return;
    }
    // 关闭必须走 closeMenu 的交还链路（setInputFocus(false) → 宿主 setFocusable(false)+
    // 重申置顶/任务栏）。旧形态「翻假后跳过打开块」会漏掉交还：焦点一直借著、置顶位掉了
    // 没人安（真机：点按钮关菜单后 TOPMOST=False 且无「交还」日志），顺带还跳过
    // resetHideBtn/cancelTimerConfirm 的清理。
    if (menuOpen) { closeMenu(); return; }
    menuOpen = true;
    if (menuOpen) {
      menuDirLocked = false; // 新一轮打开：按当前几何重新决定展开方向（见 positionMenu）
      // 每次打开菜单一律回到全折叠：展开组合不落盘、不记忆（见 menuGroup 说明），
      // 无论上次展开过哪一组，重开都是「一屏可扫、每组标题都看得见」的收起态。
      // 必须在 positionMenu 之前做：菜单需按折叠后的高度重新量取自然高度、定展开方向
      Object.keys(menuGroupEls).forEach(function (k) { menuGroupEls[k].setOpen(false); });
      // 上一轮勾掉的「已完成」痕迹到此为止：重开菜单只留还没做的（见 todoJustDone）
      todoJustDone = {};
      // 行内编辑态也不跨轮：重开菜单一律收起编辑器（否则会看到一个上次没提交的输入框，
      // 用户也说不清那是草稿还是已保存）
      todoEdit = null;
      renderTodoMenu();
      // 计时读数行只在菜单开着时按秒刷新（见 timerStep），开菜单这一刻先补一次，
      // 否则会先看到上次关菜单时的旧读数
      updateTimerStatus();
      // 余额条同理：打开这一刻先按当前状态补一次（之后随 render 刷新）
      menuBalanceEl.textContent = mainAmountText();
      // 点开菜单＝最强交互信号，无条件亮起按钮。
      // positionMenu 紧接着要读它的 getBoundingClientRect 当锚点 —— 先亮起再定位最稳。
      // 不能靠位置判定：按钮压在鲸鱼轮廓顶边上沿，位置判定常判成「不在鲸鱼上」而隐藏
      forceShowMenuBtn();
      positionMenu();
      menuBox.scrollTop = 0; // 小尺寸挂件上菜单可滚动：重开时回到顶部，否则停在上次滚到的位置
      // 模型列表懒加载：宿主侧有 5 分钟节流，反复开菜单不会一直打网络
      whaleApi.refreshModels(null, false);
      // 菜单里的数字不该是几分钟前的。余额侧有 25s 缓存 + 请求去重（见 preload/lib/api.js），
      // 这个补充很便宜；走的是与轮询同一条路径，所以不会切到 loading 态
      refresh(false);
      // 菜单里还有输入框（倒计时时长 / 定时刻），窗口默认 focusable:false 收不到键盘 → 借一次焦点
      try { whaleApi.setInputFocus(true); } catch (err) {}
      // 打开菜单这一刻指针往往停在按钮上，而「穿透恢复」定时器（PASS_RELEASE_MS）可能在
      // 菜单展开后才开火，把整窗切成点击穿透 —— 菜单明明画着，点输入框却点到了下层应用。
      // 这里立即取消待恢复的穿透并强制可交互，不等下一次 pointermove 兜底
      passReleaseCancel();
      sendIgnoreMouse(false);
    }
    menuBox.classList.toggle('dshwv-menu-open', menuOpen);
    // 滚动边影的初值：必须等面板真正可见后再量。关闭态 scrollTop 恒为 0 且 scrollHeight/clientHeight
    // 都是 0，量不出任何东西；而「重开时 scrollTop 已是 0」不会触发 scroll 事件，没人补这一下
    if (menuOpen) syncMenuScrollEdges();
    menuBtn.setAttribute('aria-expanded', menuOpen ? 'true' : 'false');
    // 开/关都走统一求值：关菜单后若指针已不在鲸鱼/按钮上，会立即隐藏，
    // 不再依赖「用户恰好再动一下鼠标」才清理（这就是按钮偶尔残留的主因）
    applyMenuBtnAtLast();
  }
  function closeMenu() {
    menuOpen = false;
    menuBox.classList.remove('dshwv-menu-open');
    menuBtn.setAttribute('aria-expanded', 'false');
    resetHideBtn(); // 关菜单即退出「隐藏挂件」确认态，免得下次打开时按钮还停在「再点一次隐藏」
    cancelTimerConfirm(); // 同理：放弃确认不跨菜单留存，避免下次打开时莫名挂着
    // 焦点归位：面板是 aria-modal，焦点原本在面板内的某个控件上（或已被借到本窗）。
    // 不还回去的话，纯键盘操作关掉菜单后焦点会掉到 body —— 下一次按 Tab 得从整页头开始找。
    // 只在按钮可见时还：菜单按钮被设置页关掉（dshwv-menu-btn-off）时它不可聚焦，focus() 是空操作
    if (menuBtnEnabled) { try { menuBtn.focus({ preventScroll: true }); } catch (err) {} }
    // 交还焦点：否则挂件一直占着焦点，设置窗（uTools 主窗）会失焦并自动隐藏
    try { whaleApi.setInputFocus(false); } catch (err) {}
    // 关闭菜单后统一重算按钮显隐：菜单开着时 applyMenuBtn 恒为「显」（它是锚点），
    // 而关菜单的各条路径（点菜单链接 / Esc / 再点按钮）都不必各自补一次 —— 漏补的那条
    // 会让按钮停在打开菜单时的强显态，且窗口此刻仍可交互，没有 pointermove 就永不复位
    applyMenuBtnAtLast();
  }
  // Esc 关菜单：挂件窗口默认 focusable=false，但菜单打开时会经 whale:input-focus 借到焦点，
  // 所以菜单开着时 Esc 能收到；菜单没开时收不到也不影响原有的「点空白关闭」。
  // 组字期间按 Esc 是输入法的「取消组字」，不能抢着关菜单
  window.addEventListener('keydown', function (e) {
    if (menuOpen && (e.key === 'Escape' || e.key === 'Esc') && !e.isComposing && e.keyCode !== 229) { closeMenu(); return; }
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
      // 横向锚点：**靠向挂件在屏幕上的内侧**，与垂直方向「只能往屏幕内有空间的那侧摆」同一道理。
      // 挂件四周的窗口留白是 --whale-pad（200px），但菜单固定宽 275px 放不进纯留白区；
      // 若贴按钮边展开，275px 会整个铺在挂件本体上把小鲸鱼盖住。改成贴窗口边缘后菜单落在留白区一侧，
      // 只压到本体靠外的窄条，居中的鲸鱼主体露出来。
      // 关键是选**哪**条窗口边缘，必须按「挂件贴工作区哪一侧」判断，不能用按钮在窗口内的坐标 ——
      // 那是窗口内部几何，跟屏幕位置无关，挂件被拖到屏幕另一侧时方向就反了。
      // flipped = 宿主按 anchor.hAnchor 推出的「挂件贴工作区左侧」（见 preload/lib/widget.js 的 flippedOf，
      // 随 whale:init / whale:snapped 下发）。挂件贴左时左边的留白已在屏幕外、摆过去也看不见，
      // 故菜单该贴窗口**右**边缘（屏幕内侧），反之贴左边缘 —— 取反即得。
      var MENU_EDGE_GAP = 4; // 菜单与窗口边缘的间距，与垂直方向的 max(4, …) 同一口径
      var menuOnRight = flipped;
      if (menuOnRight) {
        menuBox.style.right = MENU_EDGE_GAP + 'px';
        menuBox.style.left = 'auto';
        menuBox.style.transformOrigin = openDown ? 'top right' : 'bottom right';
      } else {
        menuBox.style.left = MENU_EDGE_GAP + 'px';
        menuBox.style.right = 'auto';
        menuBox.style.transformOrigin = openDown ? 'top left' : 'bottom left';
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
    } catch (err) {
      // 定位失败会让菜单画到错位置甚至看不见，属于业务失败必须留痕：
      // 打包版没有 DevTools，经 logErr 转交宿主写进 %TEMP%\whale-debug.log
      logErr('[whale][page] 菜单定位失败', err && err.message);
    }
  }

  // —— 像素命中测试（透明区域不响应/可穿透） ——
  // 性能要点：命中判定在指针移动时每帧都会跑（onDocPointerMove → scheduleHover → updateHover
  // → isWhaleHit）。原先每次都对 610×610 画布做 getImageData(x,y,1,1) 单像素读回 —— 那会强制
  // GPU→CPU 同步，单次几毫秒，**每帧一次**就是拖拽卡顿的根源（也解释了为何「锁定位置」后无此问题：
  // dragLock 时 updateHover 提前 return，压根不做命中检测）。
  // 改为：图片加载完成时一次性把整张 alpha 读进 Uint8Array（610*610 ≈ 372KB），
  // isWhaleHit 只做一次数组下标访问，纯内存、零 GPU 同步。
  var hitReady = false, hitAlpha = null, hitFailed = false;
  function setupHitTest() {
    try {
      hitReady = false; // 换形象时先失效，避免旧轮廓还在生效
      hitFailed = false;
      hitAlpha = null;
      // 离屏画布仅用于一次性把形象描出轮廓，读完 alpha 后即可丢弃，故用局部变量
      var hitCanvas = document.createElement('canvas');
      hitCanvas.width = 610;
      hitCanvas.height = 610;
      var probe = new Image();
      probe.onload = function () {
        try {
          var ctx = hitCanvas.getContext('2d');
          ctx.drawImage(probe, 0, 0, 610, 610);
          // 一次性读回整张画布的 alpha（每像素第 4 个字节），之后命中判定不再碰 canvas
          var rgba = ctx.getImageData(0, 0, 610, 610).data;
          var alpha = new Uint8Array(610 * 610);
          for (var i = 0, n = alpha.length; i < n; i++) alpha[i] = rgba[i * 4 + 3];
          // 采样自检：画布读回在个别环境下会被抹成全透明（隐私保护 / 指纹防护），
          // 此时 alpha 全是 0，命中判定会处处判假 → 整只挂件点不动，而 hitReady 仍为 true
          // 就走不到降级分支。6×6 网格扫一遍，一个不透明像素都取不到就判命中表不可用
          var opaque = 0;
          for (var gy = 0; gy < 6 && !opaque; gy++) {
            for (var gx = 0; gx < 6; gx++) {
              var px = Math.min(609, Math.floor(gx * 610 / 6 + 305 / 6));
              var py = Math.min(609, Math.floor(gy * 610 / 6 + 305 / 6));
              if (alpha[py * 610 + px] > 10) { opaque = 1; break; }
            }
          }
          if (!opaque) {
            hitFailed = true;
            logErr('[whale][page] 命中测试画布读回全透明，降级为矩形判定');
            return;
          }
          hitAlpha = alpha;
          hitReady = true;
        } catch (err) {
          hitFailed = true;
          logErr('[whale][page] 命中测试画布绘制失败', err && err.message);
        }
      };
      probe.onerror = function () {
        hitFailed = true;
        logErr('[whale][page] 命中测试图片加载失败', IMG_URL);
      };
      probe.src = IMG_URL;
    } catch (err) {}
  }
  // 命中表不可用时的降级判定：只在**图片矩形内**算命中。
  // 关键：绝不能在这里返回 true 兜底 —— 那等于「整个窗口（含四周 200px 透明留白）都是鲸鱼」，
  // 指针移出挂件后仍被判成「没离开」，菜单按钮于是不隐藏（历史 bug 的根源之一）。
  function isWhaleRectHit(e) {
    // 自身兜底：getBoundingClientRect 在极端情况下会抛错（如元素脱离文档）。
    // 本函数也被 isWhaleHit 的降级分支调用，抛错会顺着命中判定链连坐
    // 到点击 / 拖拽 / 右键 / 滚轮所有入口，故必须与 isWhaleHit/isOverMenuBtn 同口径返回 false。
    try {
      var r = img.getBoundingClientRect();
      if (!r || r.width <= 0 || r.height <= 0) return false;
      return e.clientX >= r.left && e.clientX < r.right && e.clientY >= r.top && e.clientY < r.bottom;
    } catch (err) {
      return false;
    }
  }
  // 纯几何判定，**无状态**：只回答「这个坐标此刻是否落在鲸鱼轮廓内」。
  // 拖拽 / 点击拦截 / 穿透接管等路径都用它 —— 那些场景要的是即时事实，不能受历史影响。
  function isWhaleHit(e) {
    try {
      var r = img.getBoundingClientRect();
      if (!r || r.width <= 0 || r.height <= 0) return false;
      // 命中表已判定不可用（读回被抹白 / 读回抛错 / 图片加载失败）：直接走矩形降级，
      // 且**记住**这个结论，不再每次重试
      if (hitFailed) return isWhaleRectHit(e);
      var lx = (e.clientX - r.left) / r.width * 610;
      var ly = (e.clientY - r.top) / r.height * 610;
      if (lx < 0 || ly < 0 || lx >= 610 || ly >= 610) return false;
      // 轮廓表尚未就绪（形象刚切换 / 首帧图片还没解码完）：同样只在矩形内算命中
      if (!hitAlpha || !hitReady) return true;
      if (flipped) lx = 610 - lx;
      var x = Math.floor(lx), y = Math.floor(ly);
      // 越界保护：lx/ly 已判非负，但 x/y 可能因 hitAlpha 比 610×610 短（画布尺寸变更 /
      // 采样表被截断）而落到表外。读到 undefined 时 `undefined > 10` 恒为 false，
      // 会让整块区域静默判成「没命中」→ 点不动也拖不动。这里显式兜底为「矩形内即命中」。
      if (x < 0 || y < 0 || x >= 610 || y >= 610) return true;
      var a = hitAlpha[y * 610 + x];
      if (typeof a !== 'number' || !isFinite(a)) return true;
      return a > 10;
    } catch (err) {
      return false;
    }
  }
  // —— 点击穿透 / 光标 ——
  var widgetCursor = '';
  // 光标走**类切换**而不是每次写 document.body.style.cursor：
  // cursor 是可继承属性，改它会让渲染引擎失效本窗口文档树的样式；本函数在按下/抬手
  // 各被调一次，正好压在点击链路上。切 class 只在值变化时动一次 DOM，且让 CSS 持有具体
  // 光标值（切 grab/grabbing 只需换一个类名）。注意作用域是本悬浮窗自己的文档，
  // 与宿主页面无关，失效范围有限。
  function setWidgetCursor(v) {
    if (v === widgetCursor) return;
    widgetCursor = v;
    try {
      document.body.classList.toggle('dshwv-cursor-grab', v === 'grab');
      document.body.classList.toggle('dshwv-cursor-grabbing', v === 'grabbing');
    } catch (err) {}
  }
  // 菜单按钮命中：用屏幕坐标几何判定，按钮四周留过桥边距，
  // 保证从鲸鱼移向按钮经过透明间隙时按钮不消失、窗口不穿透。
  // 注意：这里是**按钮本身**的命中区，和 isWhaleHit 的 alpha 轮廓判定互相独立补充。
  // 按钮钉在 top: calc(40.55% + 4px)（即鲸鱼本体顶边上沿）、right: 4px，二者只隔约 4px，
  // 所以过桥边距不需要很大：取 12px 足以跨过间隙，又不会把命中区撑到远处留白区。
  function isOverMenuBtn(e) {
    if (!menuBtnEnabled) return false;
    try {
      var r = menuBtn.getBoundingClientRect();
      if (!r || r.width <= 0) return false;
      var m = 12; // 过桥边距：够跨过按钮与鲸鱼间的约 4px 间隙，不伸进远处留白
      return e.clientX >= r.left - m && e.clientX <= r.right + m &&
             e.clientY >= r.top - m && e.clientY <= r.bottom + m;
    } catch (err) { return false; }
  }

  // 穿透态下「已经画在屏幕上、用户明显想点」的 UI：打开的气泡 + 到点动作条。
  // 它们不在鲸鱼轮廓里，原先穿透分支只认 overWhale / overBtn，于是气泡里的链接、
  // 动作条的「休息 / 再来一轮 / 知道了」全都点不动 —— 窗口还在 forward 指针事件，
  // 但点击被下层应用吃掉。命中它们时直接接管，不等 PASS_DWELL_MS：
  // 一条已经显示出来的链接，还要先悬停 1.2s 才变得可点，是反直觉的。
  // 只在气泡 / 动作条真的打开时才做 elementFromPoint，平时不增加每帧开销。
  function isOverPassUI(e) {
    var actionsOpen = false;
    try { actionsOpen = timerDoneActions.classList.contains('dshwv-actions-open'); } catch (err) {}
    if (!bubbleShown && !actionsOpen) return false;
    var el = null;
    try { el = document.elementFromPoint(e.clientX, e.clientY); } catch (err) {}
    if (!el || !el.closest) return false;
    return !!el.closest('.dshwv-bubble.dshwv-bubble-open') ||
           !!el.closest('.dshwv-timer-actions.dshwv-actions-open');
  }

  // 根据指针位置决定窗口是否穿透：鲸鱼/打开的气泡/菜单/菜单按钮 → 不穿透；其余透明区 → 穿透
  function updateHover(e, syncBtn) {
    if (!e) return;
    var overBtn = isOverMenuBtn(e);
    var overWhale = isWhaleHit(e);
    // 「鼠标穿透」未接管时：恒穿透。鼠标在鲸鱼/菜单按钮上停留一小会儿 → 临时接管（可点可拖），
    // 这样既满足「平时不挡下层应用」，又不用回设置页就能操作挂件。
    if (passThroughOn && !passHoverActive) {
      if (menuOpen) closeMenu();
      if (drag && drag.active) return; // 开关切换瞬间若在拖拽，等 pointerup 自然收尾
      // 气泡 / 动作条一压上去就接管（理由见 isOverPassUI 上方注释）：先撤掉可能已在跑的
      // 交回穿透定时器，免得刚接管就被它交回去
      if (isOverPassUI(e)) {
        passDwellCancel();
        passReleaseCancel();
        passTakeOver();
        if (syncBtn) applyMenuBtn(e);
        return;
      }
      if (overWhale || overBtn) {
        // 光标只在真正压在鲸鱼/按钮上时才给「可抓」；原先把 setWidgetCursor('') 写在
        // 这个判断之前，导致悬停在鲸鱼上的抓手指针被无条件清掉（看着像没悬停）
        setWidgetCursor(overWhale && !dragLock ? 'grab' : '');
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
        setWidgetCursor('');
        passDwellCancel();
        sendIgnoreMouse(true);
      }
      // 穿透未接管时也要维护按钮显隐：这条分支原先直接 return，按钮的隐藏完全指望
      // passRelease（只在接管过的路径才会走到），于是「穿透中把鼠标移出挂件」时按钮没人收。
      // applyMenuBtn 是唯一判定入口，本次事件坐标直接喂给它
      if (syncBtn) applyMenuBtn(e);
      return;
    }
    var overUI = false;
    // 只在菜单 / 气泡**真的打开时**才做 elementFromPoint：它会强制布局，是每帧最贵的一项。
    // 未打开时那两个选择器也不可能命中 —— class 与 menuOpen / bubbleShown 是同步翻转的
    // （开菜单 toggle(…, menuOpen)，气泡 add/remove 与 bubbleShown 成对），
    // 后面的 `overBtn || overWhale || menuOpen` 兜底照旧。写法与 isOverPassUI 同构：
    // ⚠️ 将来加新的「打开态」class 时，必须同时加标志位，否则这里会漏判
    if (menuOpen || bubbleShown) {
      var el = null;
      try { el = document.elementFromPoint(e.clientX, e.clientY); } catch (err) {}
      if (el && el.closest) {
        if (el.closest('.dshwv-menu.dshwv-menu-open')) overUI = true;
        else if (el.closest('.dshwv-bubble.dshwv-bubble-open')) overUI = true;
      }
    }
    if (!overUI) overUI = overBtn || overWhale || menuOpen;
    // 菜单开着就绝不穿透：菜单里的输入框要靠窗口本身接收鼠标与键盘，
    // 一旦这里 setIgnoreMouse(true)，整窗变点击穿透，输入框点不进去也打不了字。
    // （overUI 用 elementFromPoint 判定，指针掠过透明间隙/菜单边缘的瞬间会误判成「非 UI」，
    //   所以不能只靠 overUI，必须把 menuOpen 作为硬性条件兜底）
    if (menuOpen) { passReleaseCancel(); sendIgnoreMouse(false); }
    else sendIgnoreMouse(!overUI);
    setWidgetCursor((drag && drag.active) ? 'grabbing' : (overUI && !dragLock ? 'grab' : ''));
    // 按钮显隐交 applyMenuBtn 统一决策，坐标同样用本次事件对象。
    // onDocPointerMove 主路径已调用过同一入口（那里的 e 就是事件对象），此处 syncBtn 为真时
    // 属于事后重算场景（hoverAt / hoverNow：拖拽收尾、配置变更、穿透接管），坐标同样可信。
    if (syncBtn) applyMenuBtn(e);
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
    // 原地改写同一个对象：这里每次 pointermove 都跑，高频下别每事件造一个新对象。
    // ⚠️ 首次仍从 null 分配 —— 各处靠 `lastHoverPt === null` 区分「还没有任何可信坐标」
    //   （如穿透驻留定时器的复核、hoverNow 的早退），不能用一个假的 (0,0) 把它糊过去
    if (e && isFinite(e.clientX)) {
      if (!lastHoverPt) lastHoverPt = { clientX: 0, clientY: 0 };
      lastHoverPt.clientX = e.clientX;
      lastHoverPt.clientY = e.clientY;
    }
    if (hoverRaf) return;
    hoverRaf = requestAnimationFrame(function () {
      hoverRaf = 0;
      // syncBtn=false：按钮显隐已由 onDocPointerMove 用本次事件的精确坐标判过，
      // 这里再拿 lastHoverPt（合帧快照）判一次只会与那次冲突（详见 updateHover 里的说明）
      if (lastHoverPt) updateHover(lastHoverPt, false);
    });
  }
  function hoverNow() {
    if (hoverRaf) { cancelAnimationFrame(hoverRaf); hoverRaf = 0; }
    // syncBtn=true：这是「事后重算」路径（拖拽收尾 / 配置变更 / 穿透接管），
    // 此刻 lastHoverPt 刚由 hoverAt 写成最新值或被显式作废，是唯一的可信坐标源
    if (lastHoverPt) updateHover(lastHoverPt, true);
  }
  // 用事件里的最新位置立即重算（拖拽收尾、配置变更后用）
  function hoverAt(e) {
    if (e && isFinite(e.clientX)) lastHoverPt = { clientX: e.clientX, clientY: e.clientY };
    hoverNow();
  }

  // —— 拖拽 / 按压 / 点击 ——
  function onDocPointerDown(e) {
    // 菜单按钮优先于气泡：气泡圆开得很满（left:-7.97%、top:-4.67%、width:118%），
    // 打开后 SVG path 带 pointer-events:visiblePainted，正好盖住右上角按钮那一小块。
    // 若先按 e.target 分流，点在按钮位置上命中的是气泡 path，会走「气泡自己处理」分支，
    // 按钮的按下就此丢掉（点得动气泡、点不动菜单）。所以这里先按几何判按钮，命中就交按钮。
    if (isOverMenuBtn(e)) return;
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
    // 先通知宿主冻结缩放：不能等第一次 drag-move —— 从按下到首次移动之间若来一次
    // 滚轮/实时缩放，窗口尺寸会先被改掉（用户反馈的「拖着拖着变大」由此而来）
    try { whaleApi.dragBegin(); } catch (err) {}
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
        // 只记录「最新」目标位置，实际发送由 pumpDragMove 的 rAF 节流控制
        drag.tx = e.screenX - drag.cx0;
        drag.ty = e.screenY - drag.cy0;
        pumpDragMove();
      }
      // 拖拽中直接返回、不做悬停判定：拖起点必在鲸鱼本体上，指针又随窗口同步移动，
      // 故 overWhale/overBtn/穿透结论在拖拽期恒定不变 —— 而 updateHover 里的
      // elementFromPoint 会强制布局，是除 setPosition 外每帧最贵的一项，纯属白做。
      // （松手后 endDrag 会用最终位置 hoverAt 补算一次，状态不会漏更新）
      return;
    }
    // pointermove 主路径：把本次事件的精确坐标交给按钮显隐唯一入口 applyMenuBtn。
    // 下面的 scheduleHover 只做命中测试（elementFromPoint / 穿透接管），它的 rAF 里
    // 传 syncBtn=false，不会再拿旧快照对按钮显隐判第二次（历史 bug：两套坐标在轮廓边界
    // 交替给出相反结论 → 按钮该隐藏时不隐藏）
    // 两个子步骤各自兜底：本监听器是高频主路径，任一步抛错都不该让另一步（穿透接管 / 合帧重算）跟着断掉
    try { applyMenuBtn(e); } catch (err) {}
    try { scheduleHover(e); } catch (err) {} // 命中测试（elementFromPoint + closest）仍合并到每帧一次
  }
  // 拖拽位置上报：rAF 节流到「每帧最多一发」，宿主在 drag-move 里直接 setPosition。
  // 曾经踩过的两个坑，都别再回头走：1) 「发一帧 → 等宿主 ack → 再发下一帧」的严格背压：那是一条串行往返，画圈时鼠标每帧
  //    位置都不同、没有可合并的冗余帧，吞吐被单个往返延迟锁死，挂件永远落后一个往返时间。
  // 2) 宿主侧 setTimeout 自驱循环（~120Hz）来 apply 最新目标：它与页面 rAF 形成第二条节奏源，
  //    拖拽期空转 setPosition，实测比不加更卡。
  // 结论：只保留「页面 rAF 节流发送 + 宿主直接应用」这一条最简链路。
  function pumpDragMove() {
    if (!drag || !drag.active || drag.raf) return;
    drag.raf = requestAnimationFrame(function () {
      drag.raf = 0;
      if (drag && drag.active) {
        try { whaleApi.dragMove(drag.tx, drag.ty); } catch (err) {}
      }
    });
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
    // 手势被系统没收也要解冻宿主（这里不像 pointerup 会吸附落盘，只是把冻结态撤掉）
    try { whaleApi.dragEnd(); } catch (err) {}
    try { hoverAt(null); } catch (err) {} // 沿用上一次有效悬停点重算（取消事件的位置字段不可信）
  }
  function endDrag(e, clickAllowed) {
    if (!drag || !drag.active) return;
    drag.active = false;
    if (drag.raf) { cancelAnimationFrame(drag.raf); drag.raf = 0; }
    document.removeEventListener('pointerup', onDocPointerUp, true);
    document.removeEventListener('pointercancel', onDocPointerCancel, true);
    pressUp();
    var wasClick = clickAllowed && !drag.moved;
    // 松手位移要在 drag 置 null 前算好：真拖拽收尾时按它决定要不要弹「被拖拽」台词
    var ddx = e.screenX - drag.sSX, ddy = e.screenY - drag.sSY;
    drag = null;
    if (wasClick) {
      // 点挂件本体推进（tapAdvance，默认关）：气泡已在队列某一页（倒计时 / 自定义）时，点本体等同点气泡翻下一页。
      // 首点开泡、计时 peek、「只显计时」等语义完全不变 —— 只有「气泡已开着且有可推进内容」才拦走；
      // 开关仍是 bubbleTapAdvanceOn，与顶层 tapAdvance 各管各。
      if (bubbleActive && bubbleTapAdvanceOn) {
        if (!bubbleNext()) hideBubble();
        try { whaleApi.dragEnd(); } catch (err) {} hoverAt(e); return;
      }
      if (tapAdvance && bubbleShown) {
        if (bubblePreviewActive) { if (!previewSessionNext()) hideBubble(); try { whaleApi.dragEnd(); } catch (err) {} hoverAt(e); return; }
      }
      // 计时中双击鲸鱼 = 临时看一眼余额（单击仍是计时气泡，行为完全不变）。
      // 只在「计时气泡正占着气泡」时接管，其它状态双击仍走两次单击的原逻辑
      if (timerActive() && !timerFinished && timerTakesBubble()) {
        var nowClick = Date.now();
        if (nowClick - lastWhaleClickAt <= WHALE_DBLCLICK_MS) {
          lastWhaleClickAt = 0;
          showBalancePeek();
          refresh(true);
          try { whaleApi.dragEnd(); } catch (err) {}
          hoverAt(e);
          return;
        }
        lastWhaleClickAt = nowClick;
      }
      showBubble(true); // 用户点击：计时气泡即使不常驻也要弹出来
      refresh(true);
      // 只是点击、没真正拖动，不会走下面的 dragEnd（那条路才会解冻宿主）。
      // 不补这一下，宿主会一直停在「拖拽冻结」态 —— 之后滚轮缩放全部失效，
      // 看上去就是「点了挂件一下就再也调不了大小了」。
      try { whaleApi.dragEnd(); } catch (err) {}
    } else {
      // 宿主吸附后回推 whale:snapped → 镜像翻转
      whaleApi.dragEnd();
      showDragQuote(ddx * ddx + ddy * ddy);
    }
    // 立即按松手位置重算：穿透态下这里要决定是交回穿透还是保持接管；
    // 按钮显隐也在这次重算里按松手位置判过（hoverAt → hoverNow → updateHover(..., true)），
    // 不要再补第二次 —— 两次决策配上不同坐标源就会互相翻盘（这正是「偶尔不隐藏」的来源）。
    // 收尾兜底：上面各分支已陆续解冻宿主（dragEnd），此处重算若抛错不应连坐成「拖拽卡死」
    try { hoverAt(e); } catch (err) {}
  }
  function onDocClickStopper(e) {
    // 菜单按钮优先于气泡（原因见 onDocPointerDown 同名判断）：
    // 点在按钮几何范围内时事件目标可能是气泡 path，这里必须先放行给按钮，
    // 否则下面会把这次点击当作「鲸鱼上的点击」preventDefault 掉，菜单按钮的 click 收不到。
    if (isOverMenuBtn(e)) return;
    // 菜单/气泡/到点动作条都压在鲸鱼图形上：不排除的话这里会 preventDefault 掉菜单里
    // 输入框的点击，留言框点不进光标、数字框选不中 —— 看着就像「菜单改不了」
    if (e.target && e.target.closest) {
      if (e.target.closest('.dshwv-menu') || e.target.closest('.dshwv-bubble') || e.target.closest('.dshwv-timer-actions')) return;
    }
    if (!isWhaleHit(e)) return;
    try { e.preventDefault(); e.stopPropagation(); } catch (err) {}
  }
  document.addEventListener('pointerdown', onDocPointerDown, true);
  // 番茄自动衔接的等待期：**不再**「点任何地方都取消」。那条隐式规则会误触 ——
  // 用户想去点「知道了」，点偏一点自动衔接就静悄悄没了，而且没有任何视觉线索说明是谁取消的。
  // 现在只认显式操作：动作条上的「取消衔接」按钮，以及动作条其余按钮各自的 cancelPomoAutoNext
  document.addEventListener('pointermove', onDocPointerMove, true);
  // pointerleave 不冒泡，只能挂在 documentElement 上（挂到 document 上永远收不到）
  document.documentElement.addEventListener('pointerleave', onWindowPointerLeave);
  document.addEventListener('click', onDocClickStopper, true);
  // 右键鲸鱼打开菜单：即使隐藏了右上角菜单按钮，也能通过右键唤出设置菜单
  document.addEventListener('contextmenu', function (e) {
    // 拖拽中不弹菜单：左键按住拖动时再按右键，Windows 仍会派发 contextmenu（右键按下即触发，
    // 与左键是否按住无关）。菜单一弹出来就打断拖拽，用户看到的是「拖到一半突然冒出三点菜单」。
    // 注意这里只挡「正在拖」这一种情况，拖拽结束后右键唤菜单的能力完全保留
    if (drag && drag.active) { try { e.preventDefault(); e.stopPropagation(); } catch (err) {} return; }
    // closest 独立兜底：与 wheel 同理，抛错会吞掉后面的右键唤菜单能力
    var inMenu = false;
    try { inMenu = !!(e.target && e.target.closest && (e.target.closest('.dshwv-menu') || e.target.closest('.dshwv-menu-btn'))); } catch (err) {}
    if (inMenu) return;
    if (!isWhaleHit(e)) return;
    try { e.preventDefault(); e.stopPropagation(); } catch (err) {}
    try { toggleMenu(); } catch (err) {}
  }, true);

  // 窗口尺寸变化（滚轮/菜单滑块缩放在实时预览时宿主会连续 setSize）：
  // 菜单是按按钮的旧位置摆的，不重摆就会和按钮错位。
  // ⚠️ 必须合并到 rAF：positionMenu 内部会 `maxHeight = 'none'` 量自然高度（强制同步 layout），
  //    连续 setSize 时 resize 每帧触发一次，逐帧同步 layout 在 Windows 上会让窗口重绘跟不上
  //    → 挂件花/重影。合并到下一帧，同一帧内多次 resize 只重排一次。
  var menuReposRaf = 0;
  window.addEventListener('resize', function () {
    if (menuReposRaf) return;
    menuReposRaf = requestAnimationFrame(function () {
      menuReposRaf = 0;
      positionMenu(); positionTimerActions();
    });
  });

  // 滚轮缩放：指针在鲸鱼上时滚动调整大小（滚动中实时预览，停手 260ms 后持久化）
  // 锁定位置时禁用缩放（锁定 = 位置与大小都固定），仅保留点击刷新
  // 拖拽中禁用缩放：拖动时难免带出滚轮事件（触控板尤其容易误触），窗口正被拖着走、
  // 尺寸又跟着变，会让人分不清是拖还是缩，也让吸附落点变得不可预期。
  // ⚠️ 这道判据只管「本地滚轮手势」；拖拽冻结的最终防线在宿主 applyScaleToWindow 的 dragFrozen，
  //    那边还要兜住 saveCfg(commit=true) 这条不经本页的路径。两处职责不同，不要合并。
  var wheelCommitTimer = null;
  document.addEventListener('wheel', function (e) {
    // closest 在事件目标被销毁/分离时可能抛错；本监听器在点击链路上，抛错会让后续
    // 缩放逻辑整段中断，故独立兜底为「未命中菜单」继续往下走（isWhaleHit 自身已兜底）
    var inMenu = false;
    try { inMenu = !!(e.target && e.target.closest && e.target.closest('.dshwv-menu')); } catch (err) {}
    // 菜单判定必须排在下面两个早退之前：锁定位置时菜单仍可打开，滚轮要能滚菜单
    if (inMenu) return; // 菜单内滚动不缩放（也不吃默认动作）
    // 锁定 / 拖拽中不做业务缩放，但仍要吃掉默认动作：Ctrl+滚轮与触控板捏合会以
    // ctrlKey+wheel 派发到这里，不拦的话默认动作落到 Chromium 的整页缩放上 ——
    // 窗口尺寸和 scale 读数都不变、画面却整体变大，正是「拖动变大」的观感
    if (dragLock) { try { e.preventDefault(); } catch (err) {} return; }
    if (drag && drag.active) { try { e.preventDefault(); } catch (err) {} return; }
    if (!isWhaleHit(e)) return;
    try { e.preventDefault(); } catch (err) {}
    // 滚轮一次走一档（整数档位），再换算成倍率：curScale 可能是吸附前的非整档值，
    // 先 snapNum 归到当前档再 ±1，避免「滚一下没跨过档」
    var cur = snapNum(curScale);
    var target = Math.max(1, Math.min(SCALE_STEPS, cur + (e.deltaY < 0 ? 1 : -1)));
    if (target === cur) return;
    setScale(target, true, false);
    if (wheelCommitTimer) clearTimeout(wheelCommitTimer);
    wheelCommitTimer = setTimeout(function () {
      wheelCommitTimer = null;
      // 落库要传档位（setScale 的参数是档位 1–SCALE_STEPS），不能传倍率 curScale
      setScale(target, false, true);
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
    // 共享角色图池不在 init 里（整池 52MB base64，读盘+编码+克隆全压在首帧同步段）：
    // 由宿主在 init 之后单独发一条 whale:shared-skins（只有清单，本体抽到才单张来要），
    // 见下面的 onSharedSkins / onRandimgData
    // 待办清单先落地：applyConfig 里 todoOn 变化会触发 renderTodoMenu，
    // 晚赋值的话首次渲染拿到的是空清单（会闪一下「还没有待办」）
    todoState = data.todo || { items: [], focusId: '' };
    // 待办条数上限（宿主 constants.js 的 TODO_MAX，随 init 下发）：满额时页面先拦一道，
    // 否则宿主会静默丢弃这次 add，用户看到的是「输入框清空但清单没变」
    todoMax = Number(data.todoMax) || 0;
    // v1.16 起不再读 data.focusStats：挂件的专注统计层已下线（今日轮数 / 目标 / 连续天数），
    // 这里只送待办整份快照。宿主仍会推这个字段，静默忽略即可
    applyConfig(data.config);
    renderTodoMenu();
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
  // 待办整份回推（勾选 / 设专注 / 设置页增删改都走这里）：本地只读，不改状态
  whaleApi.onTodo(function (data) {
    todoState = data || { items: [], focusId: '' };
    renderTodoMenu();
    // 计时气泡尾注里带着「专注：xxx」，清单或专注项变了要跟着重画
    if (bubbleTimerActive) {
      applyBubbleLines(timerLines());
      timerClockText = timerFinished ? '' : fmtClock(timerRemainMs());
      updateTimerActions();
    }
  });
  // 待办到点提醒（宿主经 whale:cmd 推一条）：只弹提醒气泡，不动计时 / 不改清单
  if (whaleApi.onTodoDue) whaleApi.onTodoDue(function (d) {
    if (!d || !d.text) return;
    // 非 force：计时中会被 showRemindBubble 自动跳过（系统通知兜底），与既有提醒优先级一致。
    // 行必须是 { t, s, c, w } 对象（渲染器按对象取字段），传字符串会把三行全渲染成 undefined
    var shown = false;
    try {
      shown = showRemindBubble([
        { t: '待办到点', s: 'A', c: '' },
        { t: String(d.text).slice(0, 60), s: 'P', c: '' },
        { t: '去设置页可改提醒', s: 'C', c: '', w: true },
      ], false);
    } catch (err) {}
    // 回执：被计时气泡拦下时 shown=false，宿主不写幂等位，下个 tick 还会再投递 ——
    // once 型提醒被拦一次不会永久丢；系统通知这一侧宿主另有一本账（notifiedFor），发过不重发。
    // debug 是设置页调试入口触发的演练，回执带上原样标记，宿主据此跳过记账
    if (whaleApi.todoDueAck) {
      try { whaleApi.todoDueAck({ id: d.id, dueAt: d.dueAt, shown: shown, debug: d.debug === true }); } catch (err) {}
    }
  });
  // 专注统计回推：v1.16 起挂件的统计层已下线（今日轮数 / 目标 / 待办行徽标），收到什么也不做。
  // 订阅照样注册：宿主那边仍在推，注册一下零成本，日后要接回统计时不用再改两处
  if (whaleApi.onFocusStats) whaleApi.onFocusStats(function () {});
  // 刚落库的那一段计时（宿主 whale:focus 记账后回推单条会话）：
  // 菜单里的「最近」直接拿它插到列表头，不必为了一段刚结束的计时拉整份历史
  if (whaleApi.onFocusSession) whaleApi.onFocusSession(function (s) { pushRecentSession(s); });
  // 快捷指令（uTools feature 入口触发）
  whaleApi.onCmd(function (data) {
    if (!data || !data.cmd) return;
    if (data.cmd === 'timer-toggle') {
      if (timerRunning && !timerPaused) {
        pauseTimer();
      } else if (timerPaused) {
        resumeTimer();
      } else {
        startTimer();
      }
    } else if (data.cmd === 'refresh-balance') {
      // 宿主 feature 指令「刷新余额」：由页面发手动刷新，和菜单里的「刷新余额」同一路径。
      // 走 refresh(true) 而不是直接 whaleApi.refresh：这样挂件本体上的呼吸圈与兜底超时也一并生效
      try { refresh(true); } catch (err) { logErr('[whale][page] 指令刷新余额失败', err && err.message); }
    } else if (data.cmd === 'todo-start') {
      // 设置页待办行点的「开始」：走与菜单里同一个 startTodoTimer，参数用这条自己的 tm / mins，
      // startTodoTimer 内部自带「还不是当前专注就先设上」的补发，这里不必重复判断
      var tid = String((data.payload && data.payload.id) || '');
      var items = (todoState && todoState.items) || [];
      var target = null;
      for (var i = 0; i < items.length; i++) { if (items[i].id === tid) { target = items[i]; break; } }
      if (!target) { logErr('[whale][page] 指令开始计时：找不到待办条目', tid); return; }
      startTodoTimer(target);
      // 菜单可能正开着（用户从设置页回来时挂件没关），刷新一下行内按钮的三态
      if (menuOpen) renderTodoMenu();
    }
  });
  whaleApi.onBubblePreview(function (data) { showBubblePreviewBubble(data); });
  whaleApi.onSounds(function (data) {
    // 设置页导入/删除自定义音效后宿主重推；当前正用自定义音色时立即换源，
    // 提醒音与音色无关，每次都要重建（导入即生效、删除即回落到内置提醒音）
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
  if (whaleApi.onSharedSkins) whaleApi.onSharedSkins(function (data) {
    // 设置页下载/删除共享角色后宿主重推**清单**；没有「当前用哪张」，下次抽到 randimg 段自然生效
    applySharedPool(data);
  });
  if (whaleApi.onRandimgData) whaleApi.onRandimgData(function (data) {
    // 单张本体的回包（要那张就回那张，取不到时 url 为空串）。挂到 randimg 段上是异步的：
    // 这一泡多半已经按「没图」画完了，落地后下一次按压才用得上 —— 所以不必重画气泡
    if (!data || typeof data.id !== 'string' || !data.id) return;
    takeSharedImg(data.id, data.url);
  });
  whaleApi.onSnapped(function (data) {
    flipped = !!(data && data.flipped);
    root.classList.toggle('dshwv-left', flipped);
    // 吸附后位置变了，菜单展开方向要跟着重算（开着就解锁重摆，否则面板停在旧几何上）
    if (data && data.space) menuSpace = data.space;
    if (menuOpen) { menuDirLocked = false; positionMenu(); }
  });
  // 光标探测回包：窗口平时是 ignoreMouse，指针若本来就停在鲸鱼上（页面刚重建 / 挂件刚被拖到
  // 光标下），没有 pointermove 就建立不了悬停 —— 用户点一下会被穿透到下层应用，看着像「点了没反应」。
  // 这里拿宿主给的坐标补一次命中测试，等价于「刚发生过一次 pointermove」
  whaleApi.onCursor(function (pt) {
    if (!pt || !isFinite(pt.x) || !isFinite(pt.y)) return;
    hoverAt({ clientX: Number(pt.x), clientY: Number(pt.y) });
  });
  // 宿主强制穿透的告知（宿主 250ms 兜底确认「指针已在窗口矩形外」且已把窗口改成穿透态后才发）：
  // 此时页面很可能因收不到 pointerleave 停在了「可交互」状态。这里按一次真正的离开收尾，
  // 并把去重缓存对齐到宿主已落地的 true —— 否则指针回来悬停时，页面发的 false 会被自己的
  // lastIgnoreSent 吞掉，窗口就一直点不着（宿主只补「在窗口外强制穿透」这一侧，
  // 窗口内的命中最优仍由页面的精确判定负责）。
  whaleApi.onForcePass(function () {
    passDwellCancel();
    passReleaseCancel();
    if (menuOpen) closeMenu();
    lastHoverPt = null;
    try { menuBtn.classList.remove('dshwv-menu-btn-visible'); } catch (err) {}
    lastIgnoreSent = true;
    passHoverActive = false;
    try { passApplyIndicator(); } catch (err) {}
    try { setWidgetCursor(''); } catch (err) {}
  });
  // 深浅色跟 uTools 走（preload 轮询 isDarkColors 后本地推送）：挂 <html> 的 dark 类，
  // 菜单/计时条等面板的深色形态全在 floating.css 的 html.dark 系列规则里。
  // 首条推送在 preload 阶段就发过（早于本回调注册），此处先把类补齐一次——类已对时 toggle 是空操作。
  // 生效值由 uiMode 合成：auto 取 uTools 实际值，手动 light/dark 直接用偏好（见 applyDark）
  whaleApi.onDark(function (dark) {
    utoolsDark = !!dark;
    applyDark();
  });
  function applyDark() {
    var fantasy = uiMode === 'fantasy';
    var dark = fantasy || (uiMode === 'auto' ? utoolsDark : uiMode === 'dark');
    try {
      document.documentElement.classList.toggle('dark', dark);
      document.documentElement.classList.toggle('fantasy', fantasy);
    } catch (err) {}
  }
  try {
    utoolsDark = !!(window.whale && window.whale.isDark && window.whale.isDark());
    applyDark();
  } catch (err) {}

  // —— 启动 ——
  render();
  applyOpacityCss(); // 透明度初始值（onInit 配置到达后会再校正）
  applySoundSet();
  syncTimerMenu();
  renderTodoMenu(); // 配置到达前先按默认隐藏；onInit 后再按真实开关与清单重画
  setupHitTest();
  sendIgnoreMouse(true); // 初始全穿透，悬停鲸鱼时自动取消
  passApplyIndicator();  // 若配置里已开穿透，先把「穿透中」角标显示出来
  // 先取一次 dsh 状态：既决定 dsh 组显不显示（装过才显示，见 dshRender），
  // 也让菜单里的状态行/按钮一开始就是对的。无宿主桥接时问了也没人答，跳过
  if (HAS_BRIDGE) dshSend('status');
  // 请求宿主显示窗口：窗口以 show:false 创建（见宿主 lib/widget.js 的 createWidget），
  // 页面此时已 applySkin 落地首帧，显示出来就直接是用户设置的形象，不会先闪一下随包内置形象。
  // 放在 ready() 之前：宿主收到 ready 后会回推 init/balance，但那都只是改数字，不会换回内置形象
  if (typeof whaleApi.show === 'function') whaleApi.show();
  whaleApi.ready();
  // 页面重建时指针可能正停在鲸鱼上：没有 pointermove 就建立不了悬停，第一下点击会被穿透丢掉。
  // 稍等一下（窗口显示 + 首次布局完成）再问宿主光标位置，补一次命中测试。
  // 与看门狗同一守卫：隐藏态（最小化/显示桌面/切虚拟桌面/被连带 hide）不探测，
  // 否则可能在不可见时把 ignore=false 接管上，重新显示后先吞一次点击；恢复可见后的补问由 visibilitychange 负责
  setTimeout(function () {
    if (document.hidden) return
    try { whaleApi.probeCursor(); } catch (err) {}
  }, 350);

  // —— 穿透死锁看门狗 ——
  // 真机实证：窗口可能被留在 WS_EX_TRANSPARENT(0x20) 上，而 Electron 的 forward 转发钩子已经失效，
  // 页面收不到任何 pointermove；可悬停接管（含上面那次补命中测试）全靠 pointermove 驱动，
  // 350ms 那次探测只在启动时问一次 → 之后再没机会，挂件「看得见、点不着」。
  // 处理：窗口「该穿透」时低频主动问一次光标（等价于补一次 pointermove）；窗口获焦/失焦/页面重新可见时
  // 立刻补问。指针若压在鲸鱼上，悬停逻辑会接管并下发 ignore=false，把窗口捞回来
  // （开穿透时先驻留 PASS_DWELL_MS，关穿透时立即接管）。
  // 为什么门槛看 lastIgnoreSent 而不是 passThroughOn：**两种模式下窗口的闲置态都是穿透**
  //（启动即 sendIgnoreMouse(true)，见下方「初始全穿透」；关掉穿透只是「悬停立即接管」，
  //  不改变闲置态），而 passThrough 的默认值恰是 false —— 按它设门槛，等于把默认配置下
  //  卡死的窗口排除在救援之外（真机症状：设置页「鼠标穿透」没勾、窗口带着 0x20、点鲸鱼没反应）。
  // 窗口此刻已可交互（lastIgnoreSent=false）时没有穿透死锁风险，但按钮可能停在显示态
  //（菜单动作 / Esc 关菜单后没有 pointermove 送达），故按「按钮是否还亮着」再放行一格。
  // 宿主侧另有一条重申路径（lib/widget.js reassertIgnoreMouse）负责把 forward 钩子重新装回去。
  function probeCursorSoon() {
    if (passHoverActive) return;
    // 两种「该补问一次」的处境：
    //  ① 自认已穿透（lastIgnoreSent === true）：可能卡在 0x20 上、点不着，靠这次探测把窗口捞回来；
    //  ② 按钮还亮着但窗口是可交互态（lastIgnoreSent === false）：菜单动作 / Esc 关菜单若不触发
    //     pointermove，按钮会停在显示态；这里用宿主光标重算一次，2.5s 内自愈（不新增定时器）。
    //     只判 lastIgnoreSent 时这一格是空的 —— 可交互态恰好就是最需要它的时候。
    var btnVisible = false;
    try { btnVisible = lastIgnoreSent === false && menuBtn.classList.contains('dshwv-menu-btn-visible'); } catch (err) {}
    if (lastIgnoreSent !== true && !btnVisible) return;
    if (menuOpen || (drag && drag.active)) return;
    // 页面隐藏（挂件被收起 / 全屏自动隐藏）时不问：隐藏态既没有可点的鲸鱼，
    // 问了反而可能在不可见时把 ignore=false 接管上，重新显示后先吞一次点击。
    // 重新可见由下面的 visibilitychange 补问，不靠这个低频轮询。
    if (document.hidden) return;
    try { whaleApi.probeCursor(); } catch (err) {}
  }
  setInterval(probeCursorSoon, 2500);
  try {
    window.addEventListener('focus', probeCursorSoon);
    window.addEventListener('blur', probeCursorSoon);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) probeCursorSoon(); });
  } catch (err) {}
})();
