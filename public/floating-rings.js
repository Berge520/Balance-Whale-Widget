// 鲸鱼外的环形进度（svg.dshwv-ring）的绘制与计时进度计算 —— 从 floating-page.js 抽出，
// 免得这两段继续撑大那个文件的行数棘轮。只做纯计算 + 对一个 svg 写属性，不碰页面状态：
// 「这一秒圈归计时还是归下班倒计时」由页面判（offworkOwnsRing），本文件两种用途都只是画。
(function () {
  'use strict';
  if (window.WhaleRings) return;

  // 配色缓存：颜色没变就不重写内联变量 —— 每秒重写同值等于每秒让内联样式失效重算
  var colorCache = '';

  // 圈色一律只在这一处定义：计时阶段色与倒计时阶段色共用同一组常量，
  // 免得「专注蓝」在 timerColor 与 workColor 里各写一份、改一处忘了另一处
  var BLUE = '#4a90d9', GREEN = '#2fa24c', AMBER = '#e8a317', HOT_RED = '#e0433f';
  // 下班倒计时不用固定蓝：以「当天剩余工时」由蓝过渡到琥珀，最后 30 / 10 分钟再变橙红并呼吸
  // （与气泡标题行的 near 档同色同义），用户扫一眼圈的颜色就知道离下班还有多久，不必点开气泡。
  // 过渡端点从上面的十六进制常量解析出来，不另抄一份 RGB
  function hexRgb(h) { return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]; }
  var WORK_FROM = hexRgb(BLUE), WORK_TO = hexRgb(AMBER);

  // 圈色随挂件的明暗主题取：深色系（夜间 / 深蓝 / 墨黑）底上固定蓝 #4a90d9 压成灰蓝，
  // 长休橙 #e8a317 也发闷。根节点没有 dark 类时一律用原色，行为不变
  var RING_DARK = { [BLUE]: '#7db4f0', [GREEN]: '#4fc777', [AMBER]: '#ffc247', [HOT_RED]: '#ff6b66' };

  function ringColor(hex, dark) {
    return (dark && RING_DARK[hex]) || hex;
  }

  // 圈粗细三档（CSS 里的 stroke-width 变量值）：细 / 标准 / 粗。
  // 标准 3.5 与旧版硬编码值一致，改档只换变量，不动几何
  var RING_WIDTHS = { thin: 2.5, normal: 3.5, thick: 5 };

  function normWidth(v) {
    return Object.prototype.hasOwnProperty.call(RING_WIDTHS, v) ? v : 'normal';
  }

  // 把粗细档位写到 svg 上的 CSS 变量（stroke-width 在 CSS 里读它）。
  // 缓存上一次的档位：每秒重写同值等于每秒让内联样式失效重算，与配色缓存同理
  var widthCache = '';
  function setWidth(ringSvg, level) {
    var key = normWidth(level);
    if (key === widthCache) return;
    ringSvg.style.setProperty('--dshw-ring-width', String(RING_WIDTHS[key]));
    widthCache = key;
  }

  // 画一次圈。on=false 收起；pct 为「剩余比例」（1 = 满圈），与倒计时「从满到空」同一语义
  function setRing(ringSvg, ringFill, circum, on, color, pct, hot) {
    if (!on) {
      ringSvg.classList.remove('dshwv-ring-active', 'dshwv-ring-hot');
      // 颜色变量是内联的，不随类名一起失效：停表后不清掉，下一轮会从「上一轮的颜色」
      // 渐变成新颜色（CSS 里 stroke 有 .4s 过渡），看着像配色串了台
      ringSvg.style.removeProperty('--dshw-ring-color');
      colorCache = ''; // 变量被摘掉了，缓存也要失效，否则下一轮同色会被跳过而根本不写回
      return;
    }
    var firstFrame = !ringSvg.classList.contains('dshwv-ring-active');
    // 下班倒计时的「临近」呼吸：由页面每秒按 near 档切类（CSS 动的是圈本身，不碰 svg 的 opacity，
    // 免得与下面 active 类的淡入打架 —— 嵌套动画在部分 Chromium 上会被父级 opacity 过渡盖掉）
    ringSvg.classList.toggle('dshwv-ring-hot', hot === true);
    if (firstFrame) ringSvg.classList.add('dshwv-ring-active');
    if (color !== colorCache) {
      ringSvg.style.setProperty('--dshw-ring-color', color);
      colorCache = color;
    }
    pct = Math.max(0, Math.min(1, Number(pct) || 0));
    var offset = circum * (1 - pct);
    if (firstFrame) {
      // 圈刚亮起这一帧直接落到当前进度、不走 CSS 的 .9s 过渡：
      // 否则倒计时会先「从空圈涨满」再开始递减，与「从满开始减少」的语义打架
      ringFill.style.transition = 'none';
      ringFill.setAttribute('stroke-dashoffset', String(offset));
      ringSvg.getBoundingClientRect(); // 强制回流，让 none 生效后再恢复过渡
      ringFill.style.transition = '';
    } else {
      ringFill.setAttribute('stroke-dashoffset', String(offset));
    }
  }

  // 下班倒计时的圈色：当天剩余比例 s（1 = 刚上班，0 = 已下班）。
  //   已过一半之前保持专注蓝（刚上班就变黄会显得「快下班了」）；
  //   过半后在中点起蓝色线性过渡到琥珀，最后 30 分钟切橙红并呼吸（near 档）——
  //   与气泡标题行的变色同一时刻发生，圈与文字不会各说各话。
  //   过渡段是连续插值，深色主题下不换色（换色会让整段跳变）
  function workColor(s, near, dark) {
    if (near) return ringColor(HOT_RED, dark);
    s = Math.max(0, Math.min(1, Number(s) || 0));
    if (s >= 0.5) return ringColor(BLUE, dark);
    var k = 1 - s / 0.5; // 0 = 过半那一刻，1 = 下班那一刻
    var mix = function (a, b) { return Math.round(a + (b - a) * k); };
    return 'rgb(' + mix(WORK_FROM[0], WORK_TO[0]) + ',' + mix(WORK_FROM[1], WORK_TO[1]) + ',' + mix(WORK_FROM[2], WORK_TO[2]) + ')';
  }

  // 计时阶段配色：休息轮→绿（长休→琥珀），专注轮→专注蓝
  function timerColor(s, dark) {
    if (!s.isBreak) return ringColor(BLUE, dark);
    return ringColor((s.pomoOn && s.longBreak) ? AMBER : GREEN, dark);
  }

  // 计时进度（剩余比例）
  // up 正计时无固定总量，以 60 分钟为周期循环；at 定时用起止跨度；其余为倒计时「剩余/总量」，
  // 从满圈开始递减（早先按已用比例画，圈是一点点涨满的，与「倒计时」的直觉相反）
  function timerPct(s) {
    var pct = 0;
    if (s.mode === 'up') {
      var elapsed = s.running ? s.elapsed + (s.now - s.startAt) : s.elapsed;
      pct = (elapsed % 3600000) / 3600000;
    } else if (s.mode === 'at') {
      if (s.atSpan > 0) pct = 1 - (s.remain / s.atSpan);
    } else if (s.totalSec > 0) {
      pct = s.remain / (s.totalSec * 1000);
    }
    return pct;
  }

  // 倒计时 / 计时两种用途对上的「剩余比例 + 圈色 + 是否呼吸」。
  // 页面只管收集原始量、判归属，口径与配色都留在这里，挂件页不再各写一份 setRing 参数
  // t.s = { isBreak, pomoOn, longBreak, mode, now, running, elapsed, startAt, atSpan, remain, totalSec }
  function timerFrame(t, dark) {
    return { pct: timerPct(t), color: timerColor(t, dark), hot: false };
  }
  // o.s = 当日工时进度对象（dayProgress 的返回），o.near = 是否处于临近档
  function workFrame(o, dark) {
    // 剩余比例 = 1 − 当日工时进度，同计时倒计时的「从满到空」
    return { pct: 1 - o.s.pct / 100, color: workColor(1 - o.s.pct / 100, o.near === true, dark), hot: o.near === true };
  }

  window.WhaleRings = {
    setRing: setRing, setWidth: setWidth, timerColor: timerColor, timerPct: timerPct, workColor: workColor,
    timerFrame: timerFrame, workFrame: workFrame, RING_WIDTHS: RING_WIDTHS,
  };
})();
