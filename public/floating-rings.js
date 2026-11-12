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
  // 浅底 / 认不出颜色时插值用的原色端点
  var WORK_FROM = hexRgb(BLUE), WORK_TO = hexRgb(AMBER);

  // 圈色随挂件的明暗主题取：深色系（夜间 / 深蓝 / 墨黑）底上固定蓝 #4a90d9 压成灰蓝，
  // 长休橙 #e8a317 也发闷；浅底（蓝白 / 樱花）上亮蓝亮橙又太抢眼。手调四色的深色档位在下面这张表，
  // 浅底压暗与表外颜色按统一幅度算（见 ringColor）
  var RING_DARK = { [BLUE]: '#7db4f0', [GREEN]: '#4fc777', [AMBER]: '#ffc247', [HOT_RED]: '#ff6b66' };
  // 主题级个性化：只给两个招牌主题各配一组手调档表，其余主题仍走「深色提亮 / 浅底压暗」的通用口径。
  // 「跟随主题」开着时按当前气泡主题取（theme 为 null 表示开关关掉 → 原色，见 ringColor）；
  // 表里缺的键（插值段、表外的颜色）回落到该主题自己的通用调法（fantasy 提亮 / sakura 压深）
  //   fantasy（未至之境）：底色 #0A1020、描边品牌蓝 #3A7BFF —— 圈色往品牌蓝偏一档，蓝圈直接用
  //     #3A7BFF 的亮版，与气泡描边同源，不再是与主题无关的通用 #7db4f0
  //   sakura（樱花）：底色 #FFF3F8、描边 #d9789f —— 圈色往粉调，「专注蓝」压深并往玫红偏一点，
  //     压在粉白上既不像贴纸蓝也不至于与背景糊成一片；琥珀 / 绿 / 橙红同步压深，亮度与蓝圈同一档
  var RING_THEME = {
    fantasy: { [BLUE]: '#5b93ff', [GREEN]: '#45d6a8', [AMBER]: '#ffc247', [HOT_RED]: '#ff6b66' },
    sakura: { [BLUE]: '#b8567f', [GREEN]: '#2f8a58', [AMBER]: '#c8821a', [HOT_RED]: '#c73f49' },
  };
  // 深色底上的提亮幅度：同一色相往白里拉这么多，亮度抬一档而不丢「蓝 / 绿 / 橙 / 红」的身份
  var DARK_LIFT = 0.28;
  // 气泡是**浅底**时（默认蓝白 / 樱花）圈色再压一档：原先亮蓝 / 亮橙直接压在浅粉白气泡上，
  // 对比不足、像贴纸描边。往黑里收这一比例，浅底上更有分量也更看得清（深色档仍按 RING_DARK 手调）
  var LIGHT_SINK = 0.12;

  // 深色底提亮：先查上面那张手调的档位表（常见四色保持既有观感），表外颜色（下班倒计时的
  // 蓝→琥珀插值段）按同一幅度往白里拉。早先这里只认表内四色，插值段的 rgb() 串一律原样返回，
  // 于是深色主题下圈色会在中途突然变暗 —— 圈悬在深色底上，后半段的黄绿几乎看不清
  function liftForDark(hex, rgb) {
    return RING_DARK[hex] || liftRgb(rgb);
  }
  // 颜色串 → [r, g, b]：认 7 位十六进制与 rgb(r, g, b)，两种都能进提亮 / 压暗；认不出返回 null
  function parseRgb(hex) {
    if (typeof hex !== 'string') return null;
    if (hex.charAt(0) === '#') return hex.length === 7 ? hexRgb(hex) : null;
    var m = /^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/.exec(hex);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  }
  // 往白里拉：深色底用
  function liftRgb(rgb) {
    return 'rgb(' + rgb.map(function (c) { return Math.round(c + (255 - c) * DARK_LIFT); }).join(',') + ')';
  }
  // 往黑里收：浅底用（保留一点色相，压到 LIGHT_SINK 的强度）
  function sinkRgb(rgb) {
    return 'rgb(' + rgb.map(function (c) { return Math.round(c * (1 - LIGHT_SINK)); }).join(',') + ')';
  }

  // 圈色唯一出口。theme = 当前气泡主题；页面在「圈色跟随」关掉时传 null：
  //   null：原样返回（= 原色口径，即原设计里的亮蓝亮橙；早先恒浅色口径反而会把圈压暗）
  //   'sakura' / 'fantasy'：先查 RING_THEME 手调表，缺键回落到该主题的通用调法（压深 / 提亮）
  //   其余（default / dark）：走通用明暗口径 —— 深色提亮、浅底压深
  // 认不出的颜色原样返回 —— 宁可不调也不把颜色弄坏
  function ringColor(hex, theme) {
    var rgb = parseRgb(hex);
    if (!rgb) return hex;
    if (theme === null) return hex;
    var own = theme && RING_THEME[theme];
    if (own && own[hex]) return own[hex];
    if (theme === 'fantasy') return liftRgb(rgb);    // 深色底，但不用 RING_DARK（那是无主题关联的通用档）
    if (theme === 'dark') return liftForDark(hex, rgb);
    return sinkRgb(rgb);                             // default / sakura 浅底
  }

  // 圈粗细三档（CSS 里的 stroke-width 变量值，单位是 viewBox 的 user units）：细 / 标准 / 粗。
  // 标准 3.5 与旧版硬编码值一致，改档只换变量，不动几何。
  // 描边随 svg 等比缩放（默认挂件下 svg 约 150px 宽，1 单位 ≈ 1.5px，三档渲染出来约 2.6 / 5.2 / 8.9px）。
  // 细档不能太小：相邻档至少差一倍多才分得清（1.75 / 3.5 / 6，细档是标准的 0.5 倍、粗档约 1.7 倍）
  var RING_WIDTHS = { thin: 1.75, normal: 3.5, thick: 6 };

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
  //   过渡段是连续插值，整段按明暗档位同幅度调整（深色提亮、浅色压暗），
  //   否则中途会掉回未调过的那一档，端点也会与相邻阶段色对不上（见 liftForDark / sinkRgb）
  function workColor(s, near, theme) {
    if (near) return ringColor(HOT_RED, theme);
    s = Math.max(0, Math.min(1, Number(s) || 0));
    if (s >= 0.5) return ringColor(BLUE, theme);
    var k = 1 - s / 0.5; // 0 = 过半那一刻，1 = 下班那一刻
    // 端点一律先过 ringColor：蓝 / 琥珀在深色下已提亮、浅色下已压暗，插值段首尾与相邻档位天然对齐
    var from = parseRgb(ringColor(BLUE, theme)) || WORK_FROM;
    var to = parseRgb(ringColor(AMBER, theme)) || WORK_TO;
    return mixRgb(from, to, k);
  }
  function mixRgb(from, to, k) {
    var mix = function (a, b) { return Math.round(a + (b - a) * k); };
    return 'rgb(' + mix(from[0], to[0]) + ',' + mix(from[1], to[1]) + ',' + mix(from[2], to[2]) + ')';
  }

  // 计时阶段配色：休息轮→绿（长休→琥珀），专注轮→专注蓝
  function timerColor(s, theme) {
    if (!s.isBreak) return ringColor(BLUE, theme);
    return ringColor((s.pomoOn && s.longBreak) ? AMBER : GREEN, theme);
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
  function timerFrame(t, theme) {
    return { pct: timerPct(t), color: timerColor(t, theme), hot: false };
  }
  // o.s = 当日工时进度对象（dayProgress 的返回），o.near = 是否处于临近档
  function workFrame(o, theme) {
    // 剩余比例 = 1 − 当日工时进度，同计时倒计时的「从满到空」
    return { pct: 1 - o.s.pct / 100, color: workColor(1 - o.s.pct / 100, o.near === true, theme), hot: o.near === true };
  }

  // 外圈样式预览（设置页改粗细 / 圈色跟随时临时亮几秒）：用真实专注轮的配色，
  // 画 3/4 圈留缺口，缺口处粗细变化看得清，不是一整圈糊成一坨
  function previewColor(theme) { return timerColor({ isBreak: false }, theme); }
  var PREVIEW_PCT = 0.75;

  window.WhaleRings = {
    setRing: setRing, setWidth: setWidth, timerColor: timerColor, timerPct: timerPct, workColor: workColor,
    timerFrame: timerFrame, workFrame: workFrame, previewColor: previewColor, RING_WIDTHS: RING_WIDTHS,
    PREVIEW_PCT: PREVIEW_PCT,
  };
})();
