// public/floating-pages.js
// 悬浮窗气泡页队列（纯逻辑：不碰 DOM、不读配置、不引宿主模块）。
// 队列 = 自定义泡泡步骤 → 倒计时页（offworkOn 时，排在所有步骤页之后）。
// 第一张气泡必须是步骤页：倒计时不许出现在第一页的任何位置（首行、说明行都不行）。
// 没有「常规页 / 概览页」：自定义气泡未开启时，页面用宿主随配置下发的出厂默认队列（bub.dft），
// 渲染结果与「未被用户修改过的默认配置」完全一致（见 store.js 的 bubbleDefaultItems）。
// 单独成文件而不是塞进 floating-page.js：后者卡在 6269 行硬棘轮上（scripts/check-file-size.mjs），
// 页面侧只留装配，新增能力由这个文件承载。
(function () {
  'use strict';
  var OFFWORK_PAGE = { k: 'offwork' };
  // 倒计时页是唯一的固定页（带 k）；其余步骤都来自 bubble items，靠 isCustom 区分。
  // 并列泡（kind:'choice'，按权重抽台词 / 角色图）也是步骤页：无论抽到哪一支都排在第一，倒计时随后。
  function queue(o) {
    o = o || {};
    var items = Array.isArray(o.items) ? o.items : [];
    if (!o.offworkOn) return items;
    // 没有步骤可排时退化为只有倒计时页：否则整条队列为空，点气泡什么都不出
    return items.length ? items.concat([OFFWORK_PAGE]) : [OFFWORK_PAGE];
  }
  function isCustom(step) { return !!step && !step.k; }
  window.WhalePages = {
    OFFWORK_PAGE: OFFWORK_PAGE,
    queue: queue,
    isCustom: isCustom,
  };
})();
