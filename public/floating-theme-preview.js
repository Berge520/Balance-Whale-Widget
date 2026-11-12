// 气泡配色临时预览（theme-preview）的状态机 —— 从 floating-page.js 抽出，
// 免得再往那个文件的行数棘轮里塞逻辑。只做「亮几秒 → 回落」这一件事，不碰 DOM：
// 读写渲染用的 themeId 与重绘都经调用方传进来的 getTheme / setTheme / repaint，本文件不做 IO。
// 不写配置：配置由设置页自己的 patch 落盘，这里只借真实挂件演示一眼。
(function () {
  'use strict';
  if (window.WhaleThemePreview) return;

  // 缺省 3.2s（与外圈预览同口径）；上限 20s 防御异常入参，别让挂件长期停在没落盘的主题上
  var DEFAULT_MS = 3200, MAX_MS = 20000;

  // getTheme / setTheme：读写页面当前渲染用的 themeId；repaint：套用配色（页面里的 applyTheme）；
  // onOpen(open)：预览开始弹泡 / 结束时收泡（页面实现，缺省空函数）。
  // shown 由页面在气泡被任何途径收起时复位（hideBubble），故这里是「弹着就别重画、没弹才弹」
  window.WhaleThemePreview = function (getTheme, setTheme, repaint, onOpen) {
    var onOpenCb = typeof onOpen === 'function' ? onOpen : function () {};
    var api = {
      state: null,          // { timer }：非空 = 预览进行中（此期间配置推送不打断预览）
      shown: false,         // 气泡是不是本预览弹出来的（连改几档时不重复重画，免得闪）
      savedTheme: getTheme(), // 配置里落盘的主题（applyConfig 刷新），预览结束回到它
      // 开关气泡：已处于目标态就跳过
      open: function (v) {
        if (!!v === api.shown) return;
        api.shown = !!v;
        onOpenCb(api.shown);
      },
      // 配置推送：更新回落目标；预览进行中不打断（设置页的 patch 与预览指令一前一后到，打断就白闪了）
      applyConfig: function (theme) {
        api.savedTheme = (theme === 'dark' || theme === 'sakura' || theme === 'fantasy') ? theme : 'default';
        if (api.state) return;
        setTheme(api.savedTheme);
        repaint();
      },
      start: function (theme, ms) {
        // 非法主题一律不动：预览是「看一眼」，换成空值会把正在看的那一档抹掉
        if (!window.BubbleRender.THEMES[theme]) return;
        if (api.state) clearTimeout(api.state.timer);
        var dur = Number(ms);
        if (!isFinite(dur) || dur <= 0 || dur > MAX_MS) dur = DEFAULT_MS;
        setTheme(theme);
        repaint();
        api.open(true); // 只换色用户看不见（气泡平时是收起的），得真把气泡弹出来
        api.state = {
          timer: setTimeout(function () {
            api.state = null;
            setTheme(api.savedTheme); // 回落的是「最近一次配置推送」的主题，落盘失败回读旧值时也跟着回旧色
            repaint();
            api.open(false);
          }, dur),
        };
      },
    };
    return api;
  };
})();
