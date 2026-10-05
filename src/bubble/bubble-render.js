/*
 * 气泡渲染器：悬浮窗与设置页共享的单一来源。
 *
 * 悬浮窗：vite build 的 closeBundle 钩子用 esbuild 把本文件打成 IIFE 产出 dist/bubble-render.js
 * （不压缩，与 dist 里其他原样文件一致，便于排障），floating.html 在 floating-page.js 之前
 * 以普通 <script> 挂载，全局名 window.BubbleRender。悬浮窗页面不能用 ES module（file:// 硬约束），
 * 所以共享源码只能走「ESM 源文件 → esbuild 现场打包」这一条路。
 *
 * 设置页：直接 ESM import 本文件，在按压气泡编辑里做真预览（与悬浮窗同一套 DOM / 适配算法）。
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

// 泡泡模块的字号档表（fz 取 1~11，下标 0~10 对应档位 1~11），只归本模块使用
export const FONT_TIERS = [26, 32, 40, 48, 58, 66, 72, 90, 104, 114, 140];

// 气泡内文字可用区域（单位 u = 挂件基准/1026）。与 CSS 里 .dshwv-bubble 的放大倍数(1.18)保持一致：
// 圆圈放大多少，这里就放大多少，字号才会跟着变大而不是被压小。
// FIT_H 430 是按「说明行折成两行」定的：三行全展开约 404u（72×1.15 + 140×1.05 + 9 + 2×72×1.15），
// 留到 430u 才不会被折行后的高度反压回去；再大就顶到大椭圆下缘（内高约 547u，居中后下侧仅 251u）
const FIT_W = 660, FIT_H = 430, FIT_MIN = 0.5;

// 跑马灯（文字/底色渐变）每次渲染随机 1.5s~4.5s 的动画时长，各行速度不同。
// 与上游 bubbleMarqueeDur 同口径（实时泡泡与设置页预览共用同一渲染器，速度一致）
function bubbleMarqueeDur() {
  return Math.round(1500 + Math.random() * 3000) + 'ms';
}

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
  // 泡泡模块的行容器（多模块按 row 归行）：与上方三行结构互斥显示，平时隐藏。段点击（链接）由宿主页面接
  var rowsBox = document.createElement('div');
  rowsBox.className = 'dshwv-rows';
  rowsBox.style.display = 'none';
  textBox.appendChild(rowsBox);
  // 按压气泡（bubble 模型）的行容器：行×模块，模块自带字号/配色/底色/跑马灯/图片。
  // 与三行结构、台词 v2 行结构三者互斥显示
  var modsBox = document.createElement('div');
  modsBox.className = 'dshwv-rows dshwv-mods';
  modsBox.style.display = 'none';
  textBox.appendChild(modsBox);

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
  return { bubbleBox: bubbleBox, gifEl: gifEl, textBox: textBox, labelEl: labelEl, amountEl: amountEl, hintEl: hintEl, rowsBox: rowsBox, modsBox: modsBox };
}

// 渲染器工厂。opts：
//   rootEl         挂件根元素（.dshwv-root），fitText 用它的 clientWidth 推单位 u
//   defaultGifUrl  内置动图地址（相对路径，悬浮窗 './whale/rua.webp'；设置页传可解析到的地址）
//   gifFailLines() gif 加载失败且 applyLines 又抽到它时，替换显示的文案行（页面用固定文案池的 gifFail 组）
//   onGifError()   gif onerror 且图正处于「只显示图」状态时回调；「气泡是否正开着」由页面判断
export function createBubbleRenderer(opts) {
  opts = opts || {};
  var rootEl = opts.rootEl;
  var defaultGifUrl = opts.defaultGifUrl;
  var dom = buildBubbleDom({ defaultGifUrl: defaultGifUrl });
  var gifEl = dom.gifEl, labelEl = dom.labelEl, amountEl = dom.amountEl, hintEl = dom.hintEl, rowsBox = dom.rowsBox, modsBox = dom.modsBox;

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
    var segs = rowsBox.querySelectorAll('.dshwv-seg');
    for (var i = 0; i < segs.length; i++) {
      segs[i].style.fontSize = '';
      segs[i].style.height = '';
    }
    // 模块行字号记在模块元素自身的 dataset.fz（applyMods 写入），超框缩放后复位基准
    var mods = modsBox.querySelectorAll('[data-fz]');
    for (var j = 0; j < mods.length; j++) {
      var base = parseFloat(mods[j].dataset.fz || '0');
      if (base) mods[j].style.fontSize = 'calc(var(--dshw-u) * ' + base + ')';
    }
  }
  // 量出文本块的真实占位：宽取各行「内容宽度」的最大值（scrollWidth 能反映 nowrap 溢出的宽度，
  // 而 offsetWidth 会被绝对定位的 shrink-to-fit 上限截断），高为可见各行 offsetHeight 之和。
  // 均用布局尺寸而非 getBoundingClientRect：后者会带上 Q 弹的 scaleY(.88)/scaleX(1.05)
  // 与贴左镜像的 scaleX(-1)，导致测量失真。v2 的行是段容器（dshwv-row），行本身无字号，
  // 宽高都落在段元素上，所以按「行内全部段」量
  function measureText(els) {
    var w = 0, h = 0, i;
    for (i = 0; i < els.length; i++) {
      var el = els[i];
      if (el.style.display === 'none') continue;
      if (el.classList.contains('dshwv-row')) {
        var segs = el.querySelectorAll('.dshwv-seg');
        for (var j = 0; j < segs.length; j++) {
          if (segs[j].scrollWidth > w) w = segs[j].scrollWidth;
          h += segs[j].offsetHeight;
        }
        continue;
      }
      if (el.scrollWidth > w) w = el.scrollWidth;
      h += el.offsetHeight;
    }
    return { w: w, h: h };
  }
  // els 排布：三行结构传 [label, amount, hint]；rows 结构传 rowsBox 的可见行（applyRows 里缓存）
  function fitText(els) {
    if (gifEl.style.display === 'block') return;
    var u = (rootEl.clientWidth || 0) / 1026;
    if (!u) return;
    if (!els) els = [labelEl, amountEl, hintEl];
    var availW = FIT_W * u, availH = FIT_H * u;
    var i, k = 1, pass, m;
    for (pass = 0; pass < 3; pass++) {
      m = measureText(els);
      if (!m.w || !m.h) return;
      var f = Math.min(1, availW / m.w, availH / m.h);
      if (f > 0.995) return;
      k = Math.max(FIT_MIN, k * f);
      for (i = 0; i < els.length; i++) {
        var el = els[i];
        if (el.classList.contains('dshwv-row')) {
          var segs = el.querySelectorAll('.dshwv-seg');
          for (var j = 0; j < segs.length; j++) shrinkSeg(segs[j], k);
          continue;
        }
        var base = BUBBLE_FONT[String(el.className).split(' ')[0]];
        if (base) el.style.fontSize = 'calc(var(--dshw-u) * ' + (base * k).toFixed(1) + ')';
      }
      if (k <= FIT_MIN + 0.001) return;
    }
  }
  // 段的当前基准字号记在 dataset（applyRows 写入），缩放只乘系数，重复 fit 不叠加
  function shrinkSeg(seg, k) {
    var base = parseFloat(seg.dataset.fz || '0');
    if (!base) return;
    seg.style.fontSize = 'calc(var(--dshw-u) * ' + (base * k).toFixed(1) + ')';
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
        rowsBox.style.display = 'none';
        modsBox.style.display = 'none';
        return;
      }
    }
    if (gifFadeTimer) { clearTimeout(gifFadeTimer); gifFadeTimer = null; }
    gifEl.style.display = 'none';
    gifEl.style.opacity = '';
    resetFont();
    // v2 行组 { rows }：与三行结构互斥，走段级渲染（含图片/链接/占位段）
    if (lines && lines.rows) { rowsBox.style.display = 'none'; modsBox.style.display = 'none'; applyRows(lines.rows); return; }
    // 按压气泡 { mods }：行×模块渲染（模块自带字号/配色/底色/跑马灯/图片）
    if (lines && lines.mods) { applyMods(lines.mods); return; }
    rowsBox.style.display = 'none';
    modsBox.style.display = 'none';
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

  // —— v2 行×段渲染 ——
  // rows 形态与 store.js normRows 出口一致：行 = { segs, w? }（字符串/数组输入已在清洗层归一）。
  // 回调缺省时对应段整段丢（试播载荷不含图段是常态，设置页真预览才传全）：
  //   bubbleSrc(img) 图片段取图地址（下标进 customBubbles；缺省 = 内置图）
  //   randImgSrc()   randimg 段取图（从「已装共享角色图」池随机抽一张；未装时回 null 整段丢）
  //   modelText(model) 占位段现算文本（balance/today/peak/next → 本机实时值）
  //   onLinkClick(url) 链接段点击（渲染器不绑事件，只标 dataset.url，宿主接 click）
  // fit 缩放系数只在 applyRows 内部生效（shrinkSeg 按 dataset 基准值乘系数），不写回数据
  var visRows = [];
  function applyRows(rows) {
    labelEl.style.display = 'none';
    amountEl.style.display = 'none';
    hintEl.style.display = 'none';
    var needFit = false;
    var frag = document.createDocumentFragment();
    for (var i = 0; i < rows.length && i < 30; i++) {
      var row = normalizeRowInput(rows[i]);
      if (!row) continue;
      var segs = row.segs;
      // br:1 的段后硬换行，行内剩下的段都丢（与 store.js normSeg 注释同口径）
      var cut = segs.length;
      for (var s = 0; s < segs.length; s++) {
        if (segs[s].br === 1) { cut = s + 1; break; }
      }
      var rowEl = document.createElement('div');
      rowEl.className = 'dshwv-row' + (row.w ? ' dshwv-wrap' : '');
      var made = false;
      for (var s2 = 0; s2 < cut && s2 < 12; s2++) {
        var segEl = buildSeg(segs[s2]);
        if (segEl) { rowEl.appendChild(segEl); made = true; }
      }
      if (!made) continue;
      frag.appendChild(rowEl);
    }
    rowsBox.innerHTML = '';
    // 先数好再搬：appendChild 会把 fragment 的子节点整体移进 rowsBox，之后再查
    // frag.childNodes.length 恒为 0，rowsBox 会被永久藏住（试播气泡空白只剩壳的根因）
    var rowCount = frag.childNodes.length;
    rowsBox.appendChild(frag);
    rowsBox.style.display = rowCount ? 'block' : 'none';
    visRows = [];
    var kids = rowsBox.children;
    for (var k2 = 0; k2 < kids.length; k2++) visRows.push(kids[k2]);
    if (rowsBox.style.display === 'block') { needFit = true; }
    if (needFit) fitText(visRows);
  }
  // 行输入双认：数组 = 段列表（清洗层已保证对象形态，这里只兜字符串），字符串 = 单 text 段
  function normalizeRowInput(row) {
    if (typeof row === 'string') return { segs: [{ type: 'text', t: row, fz: 7 }] };
    if (Array.isArray(row)) return { segs: row };
    if (row && typeof row === 'object' && Array.isArray(row.segs)) return row;
    return null;
  }
  function buildSeg(seg) {
    if (!seg || typeof seg !== 'object') return null;
    if (seg.type === 'image') {
    var src = opts.bubbleSrc ? opts.bubbleSrc(seg.img) : null;
    if (!src) return null;
    var img = document.createElement('img');
    img.className = 'dshwv-seg dshwv-seg-img';
    img.alt = '';
    img.draggable = false;
    // 图高参与 fit 缩放：按段基准记 dataset.fz（复用 shrinkSeg 通道），超高时图也能缩
    var h = Number(seg.h) > 0 ? Number(seg.h) : 96;
    img.dataset.fz = String(h);
    img.style.height = 'calc(var(--dshw-u) * ' + h + ')';
    img.src = src;
    return img;
  }
  if (seg.type === 'randimg') {
    // randimg 段：从「已装共享角色图」池随机抽一张（池由宿主注入 randImgSrc 回调）。
    // 与 image 段同构，只是取图源不同；没装任何共享角色时回调回 null，整段丢
    var rsrc = opts.randImgSrc ? opts.randImgSrc() : null;
    if (!rsrc) return null;
    var rimg = document.createElement('img');
    rimg.className = 'dshwv-seg dshwv-seg-img';
    rimg.alt = '';
    rimg.draggable = false;
    var rh = Number(seg.h) > 0 ? Number(seg.h) : 96;
    rimg.dataset.fz = String(rh);
    rimg.style.height = 'calc(var(--dshw-u) * ' + rh + ')';
    rimg.src = rsrc;
    return rimg;
  }
    var isLink = seg.type === 'link';
    var el = document.createElement('span');
    el.className = 'dshwv-seg' + (isLink ? ' dshwv-link' : '');
    if (isLink) el.dataset.url = String(seg.url || '');
    var text = String(isLink ? (seg.t || seg.url || '') : (seg.t || ''));
    if (seg.type === 'model') {
      text = opts.modelText ? String(opts.modelText(seg.model) || '') : '';
      if (!text) return null;
    } else if (seg.type === 'random') {
      // 段级随机句池：由宿主注入的 randText 回调加权抽一条（含避重），这里只管取字
      text = opts.randText ? String(opts.randText(seg) || '') : '';
    }
    if (!text) return null;
    var fz = FONT_TIERS[(Math.round(Number(seg.fz)) || 7) - 1] || 72;
    el.dataset.fz = String(fz);
    el.style.fontSize = 'calc(var(--dshw-u) * ' + fz + ')';
    el.textContent = text;
    applyTextStyle(el, seg);
    return el;
  }
  function applyTextStyle(el, seg) {
    if (seg.c) el.style.color = String(seg.c);
    if (seg.g) {
      el.style.backgroundImage = String(seg.g);
      el.style.backgroundClip = 'text';
      el.style.webkitBackgroundClip = 'text';
      el.style.color = 'transparent';
    }
    if (seg.b === 1) el.style.fontWeight = '700';
    if (seg.i === 1) el.style.fontStyle = 'italic';
  }

  // —— 按压气泡：行×模块渲染 ——
  // mods 形态与 store.js normBubbleModules 出口一致：平铺模块数组（同行模块带同一 row 键，
  // 图片/随机图片独占一行）。模块取文本/取图/取色都交给宿主回调（渲染器不掌握实时数据）：
  //   modText(mod) 取模块文本（text/random/link 直读；balance/bonus/…/plan 由宿主现算，缺省 '—'）
  //   modImageSrc(mod) 取图片/随机图片地址（index 进 customBubbles，缺省回 null 整行丢）
  //   onLinkClick(url) 链接模块点击（渲染器只标 dataset.url，宿主接 click）
  // 行数上限 6、每行模块数上限 6（BUBBLE_ROW_MAX / BUBBLE_MOD_MAX，与 store.js 同值）；
  // 底色/跑马灯按模块独立，字号 size 经 data-fz 记基准供超框缩放（复用 resetFont 通道）
  var MOD_ROW_MAX = 6, MOD_COL_MAX = 6;
  function modFontU(size) {
    var n = Math.round(Number(size)) || 6;
    if (n < 1) n = 1; else if (n > 50) n = 50;
    return Math.round(40 + (n - 1) * 200 / 49);
  }
  // 模块是否独占一整行（图片/随机图片）；store.js 的 normBubbleModules 同口径
  function isImgMod(m) { return !!m && (m.type === 'image' || m.type === 'randimg'); }
  // 平铺模块 → 视觉行（同行同 row 键合并；图片各自成行）
  function modsToRows(mods) {
    var out = [], cur = null;
    for (var i = 0; i < mods.length; i++) {
      var m = mods[i];
      if (!m || typeof m !== 'object') continue;
      if (isImgMod(m)) { out.push([m]); cur = null; continue; }
      var key = (typeof m.row === 'number' && isFinite(m.row) && m.row > 0) ? m.row : null;
      if (cur && cur.key !== null && key === cur.key) { cur.row.push(m); continue; }
      cur = { key: key, row: [m] };
      out.push(cur.row);
    }
    return out;
  }
  function buildModBlock(m) {
    var txt = opts.modText ? String(opts.modText(m) == null ? '' : opts.modText(m)) : '';
    if (!txt && m.type !== 'image' && m.type !== 'randimg') txt = String(m.text || '');
    var needBg = !!(m.bg || m.bgRgb);
    var row = document.createElement('span');
    row.className = 'dshwv-trow';
    if (m.type === 'link') { row.className += ' dshwv-link'; row.dataset.url = String(m.url || ''); }
    var fzU = modFontU(m.size);
    row.dataset.fz = String(fzU);
    row.style.fontSize = 'calc(var(--dshw-u) * ' + fzU + ')';
    if (needBg) {
      row.style.padding = '0 calc(var(--dshw-u) * 6)';
      row.style.borderRadius = 'calc(var(--dshw-u) * 7)';
      row.style.display = 'inline-block';
    }
    var tx = row;
    if (needBg) { tx = document.createElement('span'); row.appendChild(tx); }
    tx.textContent = txt;
    if (m.bold) row.style.fontWeight = '700';
    if (m.italic) row.style.fontStyle = 'italic';
    if (m.ul) row.style.textDecoration = 'underline';
    if (m.fontFamily) row.style.fontFamily = String(m.fontFamily);
    var marquee = m.rgb;
    if (marquee) {
      tx.classList.add('dshwv-rgb');
      var scheme = marquee === true ? 'macaron' : String(marquee || 'macaron');
      if (scheme) tx.classList.add('dshwv-rgb-' + scheme);
      tx.style.animationDuration = bubbleMarqueeDur();
    } else if (m.color) {
      row.style.color = String(m.color);
    }
    if (needBg) {
      if (m.bgRgb) {
        row.classList.add('dshwv-bgrgb');
        row.classList.add('dshwv-bgrgb-' + String(m.bgRgb));
        row.style.animationDuration = bubbleMarqueeDur();
      } else if (m.bg) {
        row.style.background = String(m.bg);
      }
    }
    return row;
  }
  function buildModImg(m) {
    var src = opts.modImageSrc ? opts.modImageSrc(m) : null;
    if (!src) return null;
    var img = document.createElement('img');
    img.className = 'dshwv-mimg';
    img.alt = '';
    img.draggable = false;
    var sc = Number(m.imgScale);
    if (isFinite(sc) && sc > 0) img.style.maxWidth = 'calc(var(--dshw-u) * ' + (540 * Math.max(0.1, Math.min(1, sc))) + ')';
    img.src = src;
    return img;
  }
  var visMods = [];
  function applyMods(mods) {
    labelEl.style.display = 'none';
    amountEl.style.display = 'none';
    hintEl.style.display = 'none';
    rowsBox.style.display = 'none';
    if (!Array.isArray(mods)) mods = [];
    var rows = modsToRows(mods);
    var frag = document.createDocumentFragment();
    var used = 0;
    for (var g = 0; g < rows.length && used < MOD_ROW_MAX; g++) {
      var grp = rows[g];
      if (!grp || !grp.length) continue;
      if (isImgMod(grp[0])) {
        var im = buildModImg(grp[0]);
        if (im) { frag.appendChild(im); used++; }
        continue;
      }
      // 一行超过 MOD_COL_MAX 个模块时拆成多行
      for (var s = 0; s < grp.length && used < MOD_ROW_MAX; s += MOD_COL_MAX) {
        var line = document.createElement('div');
        line.className = 'dshwv-trowline';
        var made = false;
        for (var c = s; c < grp.length && c < s + MOD_COL_MAX; c++) {
          var blk = buildModBlock(grp[c]);
          blk.style.margin = '0 calc(var(--dshw-u) * 6) 0 0';
          line.appendChild(blk);
          made = true;
        }
        if (made) { frag.appendChild(line); used++; }
      }
    }
    modsBox.innerHTML = '';
    var count = frag.childNodes.length;
    modsBox.appendChild(frag);
    modsBox.style.display = count ? 'block' : 'none';
    visMods = [];
    var kids = modsBox.children;
    for (var k = 0; k < kids.length; k++) visMods.push(kids[k]);
    if (modsBox.style.display === 'block') fitText(visMods);
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
    applyRows: applyRows,
    applyMods: applyMods,
    resetFont: resetFont,
    fitText: fitText,
    setGifSrc: setGifSrc,
    cancelGifFade: cancelGifFade,
    fadeOutGif: fadeOutGif,
    isGifDisplayed: function () { return gifEl.style.display === 'block'; },
    visibleRows: function () { return visRows; },
    visibleMods: function () { return visMods; },
  };
}
