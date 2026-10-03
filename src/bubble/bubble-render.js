/*
 * 气泡渲染器：悬浮窗与设置页共享的单一来源。
 *
 * 悬浮窗：vite build 的 closeBundle 钩子用 esbuild 把本文件打成 IIFE 产出 dist/bubble-render.js
 * （不压缩，与 dist 里其他原样文件一致，便于排障），floating.html 在 floating-page.js 之前
 * 以普通 <script> 挂载，全局名 window.BubbleRender。悬浮窗页面不能用 ES module（file:// 硬约束），
 * 所以共享源码只能走「ESM 源文件 → esbuild 现场打包」这一条路。
 *
 * 设置页：直接 ESM import 本文件，在台词库编辑里做真预览（与悬浮窗同一套 DOM / 适配算法）。
 *
 * 本文件不依赖宿主桥接与页面状态：gif 加载失败后的「失败文案」与「气泡是否正开着」
 * 都通过回调（gifFailLines / onGifError）交还宿主页面处理，渲染器只认得自己的 DOM。
 *
 * 与 CSS 的三处副本一致性由 scripts/check-shared.mjs 钉住（改这里必须同步
 * public/floating-bubble.css，反之亦然）：BUBBLE_FONT 字号 ↔ .dshwv-label/amount/period/hint、
 * THEMES.default 配色 ↔ .dshwv-bubble 的变量默认值、下方「/ 1026」注释 ↔ CSS 的 --dshw-u 除数。
 */

// 气泡配色预设：气泡颜色全部走 CSS 变量，换主题只重写变量、不重建 DOM。
// 「低余额」的红色是状态色，不随主题变（见 CSS 的 .dshwv-low）
export const THEMES = {
  default: { text: '#536ba9', hint: '#9fb0d9', fill: '#FFFFFF', stroke: '#203170' },
  dark:    { text: '#dbe4ff', hint: '#94a3c8', fill: '#1f2437', stroke: '#8fa3e0' },
  sakura:  { text: '#a3486f', hint: '#c98aa8', fill: '#FFF3F8', stroke: '#d9789f' },
};

// 台词行类型 → 样式类：A 标签行 / B 金额行 / P 时段行 / C 说明行
export const BUBBLE_STYLE_CLASS = { A: 'dshwv-label', B: 'dshwv-amount', P: 'dshwv-period', C: 'dshwv-hint' };

// 气泡自适应：三行字号固定（数值与 CSS 的 .dshwv-label/amount/period/hint 必须一致），
// 长文案换行后可能撑出气泡，这里按可用区域测量后等比缩小字号
// （只缩不放，正常内容保持原字号）；单位 u = 挂件基准 / 1026，与 CSS 的 --dshw-u 一致
export const BUBBLE_FONT = { 'dshwv-label': 72, 'dshwv-amount': 140, 'dshwv-period': 114, 'dshwv-hint': 72 };

// 气泡内文字可用区域（单位 u = 挂件基准/1026）。与 CSS 里 .dshwv-bubble 的放大倍数(1.18)保持一致：
// 圆圈放大多少，这里就放大多少，字号才会跟着变大而不是被压小。
// FIT_H 430 是按「说明行折成两行」定的：三行全展开约 404u（72×1.15 + 140×1.05 + 9 + 2×72×1.15），
// 留到 430u 才不会被折行后的高度反压回去；再大就顶到大椭圆下缘（内高约 547u，居中后下侧仅 251u）
const FIT_W = 660, FIT_H = 430, FIT_MIN = 0.5;

// 气泡 DOM：SVG 壳 + 动图 + 三行文本。宿主页面拿到引用后再自行接线
// （click 处理依赖页面状态，不在这里绑）
export function buildBubbleDom(opts) {
  var textBox = document.createElement('div');
  textBox.className = 'dshwv-text';
  var labelEl = document.createElement('div');
  labelEl.className = 'dshwv-label';
  labelEl.textContent = 'DeepSeek 余额';
  var amountEl = document.createElement('div');
  amountEl.className = 'dshwv-amount';
  var hintEl = document.createElement('div');
  // 常驻说明行默认就允许换行：它是三行里最长的一行，nowrap 会撑宽、把三行一起缩小（见 fitText）
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
  gifEl.src = opts.defaultGifUrl;
  gifEl.alt = '';
  gifEl.draggable = false;
  bubbleBox.appendChild(gifEl);
  bubbleBox.appendChild(textBox);
  return { bubbleBox: bubbleBox, gifEl: gifEl, textBox: textBox, labelEl: labelEl, amountEl: amountEl, hintEl: hintEl };
}

// 渲染器工厂。opts：
//   rootEl         挂件根元素（.dshwv-root），fitText 用它的 clientWidth 推单位 u
//   defaultGifUrl  内置动图地址（相对路径，悬浮窗 './whale/rua.webp'；设置页传可解析到的地址）
//   gifFailLines() gif 加载失败且 applyLines 又抽到它时，替换显示的文案行（页面用台词库的 gifFail 组）
//   onGifError()   gif onerror 且图正处于「只显示图」状态时回调；「气泡是否正开着」由页面判断
export function createBubbleRenderer(opts) {
  opts = opts || {};
  var rootEl = opts.rootEl;
  var defaultGifUrl = opts.defaultGifUrl;
  var dom = buildBubbleDom({ defaultGifUrl: defaultGifUrl });
  var gifEl = dom.gifEl, labelEl = dom.labelEl, amountEl = dom.amountEl, hintEl = dom.hintEl;

  var gifFailed = false;
  // 当前 gifEl.src 对应的「原始值」：img.src 读出来是绝对 URL（相对路径会被解析成 file://…），
  // 拿它跟原始地址比对永远不相等，只能自己记一份
  var gifSrcSet = defaultGifUrl;
  var gifFadeTimer = null;

  // 换图：自定义气泡图与内置图共用这一个 <img>。图变了才重设 src 并复位失败标记，
  // 否则每次抽到同一张都会重新发起加载（data URL 也会白解码一遍）
  function setGifSrc(url) {
    var u = url || defaultGifUrl;
    if (u === gifSrcSet) return;
    gifSrcSet = u;
    gifFailed = false;
    try { gifEl.src = u; } catch (err) { gifFailed = true; }
  }
  gifEl.onerror = function () {
    gifFailed = true;
    // 自定义图加载失败：此时气泡已经切到「只显示图」的状态，光记标记会留下一片空白，
    // 当场换成失败文案（下一次抽到别的图时 setGifSrc 会复位标记）。
    // 「气泡是否正开着」是页面状态，渲染器不掌握，交给 onGifError 回调自行判断
    if (gifEl.style.display === 'block' && opts.onGifError) opts.onGifError();
  };

  function resetFont() {
    labelEl.style.fontSize = '';
    amountEl.style.fontSize = '';
    hintEl.style.fontSize = '';
  }
  // 量出文本块的真实占位：宽取各行「内容宽度」的最大值（scrollWidth 能反映 nowrap 溢出的宽度，
  // 而 offsetWidth 会被绝对定位的 shrink-to-fit 上限截断），高为可见各行 offsetHeight 之和。
  // 均用布局尺寸而非 getBoundingClientRect：后者会带上 Q 弹的 scaleY(.88)/scaleX(1.05)
  // 与贴左镜像的 scaleX(-1)，导致测量失真。
  function measureText(els) {
    var w = 0, h = 0, i;
    for (i = 0; i < 3; i++) {
      var el = els[i];
      if (el.style.display === 'none') continue;
      if (el.scrollWidth > w) w = el.scrollWidth;
      h += el.offsetHeight;
    }
    return { w: w, h: h };
  }
  function fitText() {
    if (gifEl.style.display === 'block') return;
    var u = (rootEl.clientWidth || 0) / 1026;
    if (!u) return;
    var els = [labelEl, amountEl, hintEl];
    var availW = FIT_W * u, availH = FIT_H * u;
    var i, k = 1, pass, m;
    for (pass = 0; pass < 3; pass++) {
      m = measureText(els);
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
  // 应用 3 行模型 { t, s: 'A'|'B'|'P'|'C', c, w }，或 { gif: true, src } 只显示动图。
  // 行序固定为 标签 / 金额 / 说明，s 决定套哪套字号样式
  function applyLines(lines) {
    if (lines && lines.gif) {
      // 有自定义气泡图就用它，否则回退内置图（lines.src 为空串 = 用内置）
      setGifSrc(lines.src);
      if (gifFailed) {
        lines = opts.gifFailLines ? opts.gifFailLines() : null;
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
    resetFont();
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
    fitText();
  }
  function cancelGifFade() {
    if (gifFadeTimer) { clearTimeout(gifFadeTimer); gifFadeTimer = null; }
  }
  // gif 靠 CSS opacity 淡出；display:none 会跳过过渡，等淡出完成再隐藏（气泡收起路径用）
  function fadeOutGif(ms) {
    gifFadeTimer = setTimeout(function () { gifFadeTimer = null; gifEl.style.display = 'none'; }, ms || 240);
  }

  return {
    els: dom,
    applyLines: applyLines,
    resetFont: resetFont,
    fitText: fitText,
    setGifSrc: setGifSrc,
    cancelGifFade: cancelGifFade,
    fadeOutGif: fadeOutGif,
    isGifDisplayed: function () { return gifEl.style.display === 'block'; },
  };
}
