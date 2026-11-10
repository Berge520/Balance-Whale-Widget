// public/floating-todo-edit.js
// 待办行内编辑器（改名 / 到点提醒 / 删除）—— 从 floating-page.js 抽出，
// 免得这块继续撑大那个文件的行数棘轮（scripts/check-file-size.mjs）。
// 单独成文件的理由与 floating-pages.js 同：页面侧只留装配，新增能力由独立文件承载。
// 本文件只建 DOM，不持有状态：编辑态（哪条在编辑）由页面持有并在点击回调里写，
// 页面通过 opts.getEdit / opts.setEdit 两个钩子读写，两处状态不会各存一份。
(function () {
  'use strict';
  if (window.WhaleTodoEdit) return;

  // 到点提醒的四种形态，与设置页 FocusView 的顺序一致。
  // kind 取值必须与宿主 reminders.normKind 的合法集合同名：'weekdays'（不是 workday），
  // 写错会被归一成 'once' —— 用户选了「工作日」，实际变成一次性提醒
  var REMIND_KINDS = [
    { k: 'once', t: '一次性' },
    { k: 'daily', t: '每天' },
    { k: 'weekdays', t: '工作日' },
    { k: 'weekly', t: '每周' },
  ];

  function p(n) { return (n < 10 ? '0' : '') + n; }

  // ms → <input type="datetime-local"> 的 value（本地时区，不带秒）
  function msToLocalInput(ms) {
    var d = new Date(ms);
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
      + 'T' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  // 从控件读回一份 remind 草稿；控件没给时沿用条目现值（用于「只改开关」这类局部提交）
  function currentRemindDraft(it, whenInput, dowSel) {
    function kindOf(el) {
      var sel = el.parentNode.querySelector('.dshwv-todo-edit-sel');
      return (sel && sel.value) || it.remindKind || 'once';
    }
    var kind = (whenInput && whenInput.parentNode)
      ? kindOf(whenInput) : (it.remindKind || 'once');
    var at = Number(it.remindAt) || 0;
    if (whenInput && whenInput.value) {
      if (kind === 'once') {
        var t = Date.parse(whenInput.value);
        // 拒掉 1970 这类离谱值：宿主那边只做 clamp，不辨真假
        if (Number.isFinite(t) && t > 0) at = t;
      } else {
        var parts = String(whenInput.value).split(':');
        var h = Math.round(Number(parts[0]));
        var m = Math.round(Number(parts[1]));
        if (Number.isFinite(h) && Number.isFinite(m)) at = Math.max(0, Math.min(1439, h * 60 + m));
      }
    }
    var dow = dowSel ? Math.round(Number(dowSel.value)) || 0 : (Number(it.remindDow) || 0);
    return { remindOn: !!it.remindOn, remindKind: kind, remindAt: at, remindDow: dow };
  }

  // 形态切换时换算 remindAt：once 是绝对 ms，其余是当天分钟数
  function convertRemindAt(at, fromKind, toKind) {
    if (!at) return 0;
    var fromOnce = fromKind === 'once';
    var toOnce = toKind === 'once';
    if (fromOnce === toOnce) return at;
    if (fromOnce) {
      var d = new Date(at);
      return Math.max(0, Math.min(1439, d.getHours() * 60 + d.getMinutes()));
    }
    // 分钟数 → 绝对时刻：取今天该时刻，已过则顺延到明天（与「下一个整点」的直觉一致）
    var now = new Date();
    var t = new Date(now.getFullYear(), now.getMonth(), now.getDate(), Math.floor(at / 60), at % 60, 0, 0);
    if (t.getTime() <= Date.now()) t.setDate(t.getDate() + 1);
    return t.getTime();
  }

  // 提醒编辑器：形态下拉 + 时刻 +（每周）星期几。
  // 字段与设置页 FocusView 完全同构（remindOn / remindKind / remindAt / remindDow），
  // 由宿主 reminders.normRemind 归一 —— 挂件不自己算「下次哪天」，那是宿主的事
  function remindEditor(it, o) {
    var wrap = document.createElement('div');
    wrap.className = 'dshwv-todo-remind';
    var head = document.createElement('div');
    head.className = 'dshwv-todo-edit-row';
    var label = document.createElement('label');
    label.className = 'dshwv-todo-remind-on';
    var onBox = document.createElement('input');
    onBox.type = 'checkbox';
    onBox.checked = !!it.remindOn;
    label.appendChild(onBox);
    label.appendChild(document.createTextNode(' 到点提醒'));
    head.appendChild(label);
    wrap.appendChild(head);
    if (!it.remindOn) {
      // 关着时也把开关放出来（点一下就能开），但不再铺时刻控件 —— 折叠区的行数要省着用
      onBox.addEventListener('change', function (e) {
        e.stopPropagation();
        if (onBox.checked) {
          // 开提醒但还没选时刻：宿主侧 at=0 视为「未选」，徽标不画、也不会响。
          // 这里先给一个默认（下一个整点），用户不改也能直接生效
          var d = new Date();
          d.setSeconds(0, 0);
          d.setMinutes(0);
          d.setHours(d.getHours() + 1);
          o.send({ op: 'due', id: it.id, remind: { remindOn: true, remindKind: 'once', remindAt: d.getTime(), remindDow: 0 } });
        } else {
          o.send({ op: 'due', id: it.id, remind: { remindOn: false, remindKind: it.remindKind || 'once', remindAt: Number(it.remindAt) || 0, remindDow: Number(it.remindDow) || 0 } });
        }
      });
      return wrap;
    }
    onBox.addEventListener('change', function (e) {
      e.stopPropagation();
      var req = currentRemindDraft(it);
      req.remindOn = !!onBox.checked;
      o.send({ op: 'due', id: it.id, remind: req });
      o.rerender();
    });
    var kindSel = document.createElement('select');
    kindSel.className = 'dshwv-todo-edit-sel';
    kindSel.setAttribute('aria-label', '提醒方式');
    REMIND_KINDS.forEach(function (k) {
      var opt = document.createElement('option');
      opt.value = k.k;
      opt.textContent = k.t;
      if ((it.remindKind || 'once') === k.k) opt.selected = true;
      kindSel.appendChild(opt);
    });
    var kindRow = document.createElement('div');
    kindRow.className = 'dshwv-todo-edit-row';
    kindRow.appendChild(kindSel);
    // 时刻：一次性用 datetime-local，其余用 time（与设置页同口径）
    var whenInput = document.createElement('input');
    whenInput.className = 'dshwv-todo-edit-when';
    if ((it.remindKind || 'once') === 'once') {
      whenInput.type = 'datetime-local';
      whenInput.value = msToLocalInput(Number(it.remindAt) || Date.now());
    } else {
      whenInput.type = 'time';
      var mins = Number(it.remindAt) || 0;
      whenInput.value = p(Math.floor(mins / 60)) + ':' + p(mins % 60);
    }
    whenInput.setAttribute('aria-label', '提醒时间');
    kindRow.appendChild(whenInput);
    // 每周：星期几下拉（0=周日，与 JS getDay 同口径）
    var dowSel = null;
    if ((it.remindKind || 'once') === 'weekly') {
      dowSel = document.createElement('select');
      dowSel.className = 'dshwv-todo-edit-sel';
      dowSel.setAttribute('aria-label', '每周哪一天');
      ['周日', '周一', '周二', '周三', '周四', '周五', '周六'].forEach(function (t, i) {
        var opt = document.createElement('option');
        opt.value = String(i);
        opt.textContent = t;
        if ((Number(it.remindDow) || 0) === i) opt.selected = true;
        dowSel.appendChild(opt);
      });
      kindRow.appendChild(dowSel);
    }
    wrap.appendChild(kindRow);
    // 形态切换要重画（时刻控件类型不同），单独监听：切换后立刻写回，
    // 时刻沿用用户原本填的那个（don't-carry 会让用户每切一次都得重填）
    kindSel.addEventListener('change', function (e) {
      e.stopPropagation();
      var req = currentRemindDraft(it);
      req.remindOn = true;
      req.remindKind = kindSel.value;
      // 形态变了，原 remindAt 的语义也变了（ms ↔ 当天分钟数），必须就地换算
      req.remindAt = convertRemindAt(Number(it.remindAt) || 0, it.remindKind || 'once', req.remindKind);
      o.send({ op: 'due', id: it.id, remind: req });
      o.rerender();
    });
    function applyWhen() {
      var req = currentRemindDraft(it, whenInput, dowSel);
      req.remindOn = true;
      o.send({ op: 'due', id: it.id, remind: req });
    }
    whenInput.addEventListener('change', function (e) { e.stopPropagation(); applyWhen(); });
    if (dowSel) dowSel.addEventListener('change', function (e) { e.stopPropagation(); applyWhen(); });
    // 关掉提醒的小入口：与开关同一个意思，但放在控件区末尾更顺手
    var offBtn = document.createElement('button');
    offBtn.type = 'button';
    offBtn.className = 'dshwv-menu-link dshwv-todo-edit-off';
    offBtn.textContent = '关闭提醒';
    offBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      o.send({ op: 'due', id: it.id, remind: { remindOn: false, remindKind: it.remindKind || 'once', remindAt: Number(it.remindAt) || 0, remindDow: Number(it.remindDow) || 0 } });
      o.rerender();
    });
    wrap.appendChild(offBtn);
    return wrap;
  }

  // 预估轮数编辑器：数字框 + 「轮」，只提交 0–99 的整数（宿主 todoSetEst 会再 clamp 一次，
  // 这里先拦是为了「输入 500」时立刻给出可见的上限，而不是等宿主静默改成 99）
  function estEditor(it, o) {
    var row = document.createElement('div');
    row.className = 'dshwv-todo-edit-row';
    var label = document.createElement('span');
    label.className = 'dshwv-todo-edit-label';
    label.textContent = '预估';
    var input = document.createElement('input');
    input.type = 'number';
    input.className = 'dshwv-todo-edit-num';
    input.min = '0';
    input.max = '99';
    input.step = '1';
    input.value = String(Number(it.est) || 0);
    input.title = '预估要几轮做完（0 = 不设）';
    input.setAttribute('aria-label', '预估轮数');
    var unit = document.createElement('span');
    unit.className = 'dshwv-todo-edit-label';
    unit.textContent = '轮';
    var hint = document.createElement('span');
    hint.className = 'dshwv-todo-edit-hint';
    // 说清 rounds 从哪来：不然用户会以为这里填的是「已经做完几轮」
    hint.textContent = '已做 ' + Math.max(0, Number(it.rounds) || 0) + ' 轮';
    function commitEst() {
      var n = Math.round(Number(input.value));
      if (!Number.isFinite(n)) n = 0;
      n = Math.max(0, Math.min(99, n));
      input.value = String(n);
      if (n === (Number(it.est) || 0)) return;
      o.send({ op: 'est', id: it.id, est: n });
      o.rerender();
    }
    input.addEventListener('change', function (e) { e.stopPropagation(); commitEst(); });
    input.addEventListener('keydown', function (e) {
      e.stopPropagation();
      if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); commitEst(); }
    });
    // 点数字框会冒泡到行上（行上没有再监听，但菜单有「点外部收起」），挡一道保险
    row.addEventListener('click', function (e) { e.stopPropagation(); });
    row.appendChild(label);
    row.appendChild(input);
    row.appendChild(unit);
    row.appendChild(hint);
    return row;
  }

  // 行内编辑器：与待办行平级插在清单里（todo-row 是 flex 单行，塞进去只会被挤成窄条），
  // 由页面在对应行之后 append。
  // 三个字段各管一段，改完立刻上报 —— 不做「最后统一保存」：挂件是个小浮层，
  // 用户点完「保存」就切走了，留着未提交的草稿只会变成幽灵状态
  // o = { send(op 对象), rerender(), close(), warn(text), isText(it) }
  function editor(it, o) {
    var box = document.createElement('div');
    box.className = 'dshwv-todo-edit';
    box.addEventListener('click', function (e) { e.stopPropagation(); });
    // —— 改名 ——
    var nameRow = document.createElement('div');
    nameRow.className = 'dshwv-todo-edit-row';
    var nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'dshwv-todo-add dshwv-todo-edit-name';
    nameInput.maxLength = 60; // 同 constants.js 的 TODO_TEXT_MAX（宿主也会按同一上限截断）
    nameInput.value = it.text;
    nameInput.setAttribute('aria-label', '改名');
    function commitRename() {
      var next = String(nameInput.value == null ? '' : nameInput.value).replace(/\s+/g, ' ').trim().slice(0, 60);
      if (!next) {
        // 宿主侧也会把空文本拒掉，这里先拦一下给个说法
        o.warn('名字不能为空');
        return;
      }
      o.close();
      if (next !== it.text) o.send({ op: 'rename', id: it.id, text: next });
      o.rerender();
    }
    nameInput.addEventListener('keydown', function (e) {
      e.stopPropagation();
      if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) {
        e.preventDefault();
        commitRename();
      }
      if (e.key === 'Escape') { e.preventDefault(); o.close(); o.rerender(); }
    });
    var nameOk = document.createElement('button');
    nameOk.type = 'button';
    nameOk.className = 'dshwv-menu-link dshwv-todo-edit-ok';
    nameOk.textContent = '改名';
    nameOk.addEventListener('click', function (e) { e.stopPropagation(); commitRename(); });
    nameRow.appendChild(nameInput);
    nameRow.appendChild(nameOk);
    box.appendChild(nameRow);
    // —— 预估轮数（①）——
    // 这条早先只能在设置页填，而它驱动的进度点恰恰显示在挂件行上：
    // 「填了 3 轮、发现要 5 轮」就得开设置页翻到专注卡。这里给一个 0–99 的数字框，
    // 0 = 不设（进度点整列消失）。只上报 est，不做本地累加 —— rounds 是会话明细派生的
    box.appendChild(estEditor(it, o));
    // —— 到点提醒 ——
    box.appendChild(remindEditor(it, o));
    // —— 删除 ——
    var delRow = document.createElement('div');
    delRow.className = 'dshwv-todo-edit-row';
    var delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'dshwv-menu-link dshwv-todo-edit-del';
    delBtn.textContent = '删除这条';
    delBtn.title = '删除「' + it.text + '」';
    delBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      o.close();
      // 删除是 destructive：不给二次确认，改为立刻提示「已删除」，避免手滑连点
      o.send({ op: 'remove', id: it.id });
      o.rerender();
    });
    delRow.appendChild(delBtn);
    box.appendChild(delRow);
    return box;
  }

  // 待办到点徽标：once 非今天显示 M-D HH:MM；重复形态显示 HH:MM；过期用 over 标记。
  // 只做展示（编辑入口在下面的行内编辑器）；at=0 视为「还没选时刻」，不画徽标
  function remindLabel(it) {
    var at = Number(it.remindAt) || 0;
    if (!at) return null;
    if (it.remindKind === 'once') {
      var d = new Date(at);
      var hm = p(d.getHours()) + ':' + p(d.getMinutes());
      var sameDay = d.toDateString() === new Date().toDateString();
      return { text: sameDay ? hm : (d.getMonth() + 1) + '-' + d.getDate() + ' ' + hm, full: d.toLocaleString(), over: at < Date.now() };
    }
    var mins = Math.max(0, Math.min(1439, at));
    return { text: p(Math.floor(mins / 60)) + ':' + p(mins % 60), full: it.remindKind, over: false };
  }

  // 一行待办。o = {
  //   send(op), rerender(), start(it), markDone(id) / unmarkDone(id),
  //   focusId(), editId(), toggleEdit(id), timerBusy()
  // }
  // 页面状态（当前专注 / 编辑态 / 刚勾掉的痕迹 / 计时是否在跑）全由 o 的读函数提供 ——
  // 本文件不缓存这些值，重画时现读，避免页面与本文件各存一份而走样。
  // 唯一的例外是拖拽中的 id（draggingId）：它是纯 DOM 交互瞬态，页面不关心
  function row(it, o) {
    var el = document.createElement('div');
    el.className = 'dshwv-todo-row' + (it.done ? ' dshwv-todo-done' : '');
    // 拖拽落点靠它认行（见 dropTarget）：不从闭包里读 id，是因为 dragover 是容器级委托，
    // 拿到的是 DOM 节点而不是创建该行时的闭包
    el.setAttribute('data-todo-id', it.id);
    var check = document.createElement('input');
    check.type = 'checkbox';
    check.className = 'dshwv-todo-check';
    check.checked = !!it.done;
    check.title = it.done ? '标为未完成' : '标为已完成';
    // 只上报操作、不自改本地状态：宿主写库后统一回推整份清单（单一事实来源，
    // 避免本地先改再回推造成两次重绘 / 短暂不一致）
    check.addEventListener('change', function (e) {
      e.stopPropagation();
      // 只维护「本次菜单内的显示痕迹」，权威状态仍等宿主回推（单一事实来源）
      if (check.checked) o.markDone(it.id);
      else o.unmarkDone(it.id);
      o.send({ op: 'toggle', id: it.id });
    });
    var text = document.createElement('span');
    text.className = 'dshwv-todo-text';
    text.textContent = it.text;
    text.title = it.text;
    el.appendChild(check);
    el.appendChild(text);
    // 到点提醒徽标：到点只提醒，不自动开始计时
    if (it.remindOn) {
      var due = remindLabel(it);
      if (due) {
        var dueEl = document.createElement('span');
        dueEl.className = 'dshwv-todo-due';
        dueEl.textContent = due.text;
        if (due.over) dueEl.classList.add('dshwv-todo-due-over');
        dueEl.title = '到点提醒：' + due.full;
        el.appendChild(dueEl);
      }
    }
    // 预估进度点（v1.17 恢复，形态与 v1.15 的「N/M」文字不同）：
    // est / rounds 一直在存储与设置页里，v1.15 把挂件的展示一并删掉后，用户填了「预估 3 轮」
    // 就再没有地方能看到「做了几轮 / 还差几轮」—— 填了等于白填。
    // 不写数字：把 est 画成 est 个小点、rounds 个填实，占位不到 40u，不挤窄文字。
    // est 上限 99，99 个点会撑爆整行 —— 超过 8 轮改用「前 7 点 + 省略点」的压缩画法，
    // 真实数字仍在 title 里
    if (it.est > 0) {
      var estShown = Math.min(it.est, 8);
      var dots = document.createElement('span');
      dots.className = 'dshwv-todo-dots';
      dots.title = '已完成 ' + Math.min(it.rounds, it.est) + ' / 预估 ' + it.est + ' 轮';
      for (var di = 0; di < estShown; di++) {
        var dot = document.createElement('i');
        // 第 8 个点代表「8 轮及以后」：只在 rounds 已到该档时才填实
        if (di < it.rounds) dot.className = 'on';
        dots.appendChild(dot);
      }
      el.appendChild(dots);
    }
    if (it.done) {
      // 刚勾掉的行留在原位（置灰），并给一个明确的撤销入口：
      // 早先只能靠再点一次那个小小的勾选框反悔，勾掉后它看起来就像「已经完事了」，
      // 用户不会想到还能点回来。按钮只在这一轮菜单内出现（重开菜单清空 justDone 痕迹）
      var undoBtn = document.createElement('button');
      undoBtn.type = 'button';
      undoBtn.className = 'dshwv-todo-undo';
      undoBtn.textContent = '撤销';
      undoBtn.title = '把「' + it.text + '」恢复为未完成';
      undoBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        o.unmarkDone(it.id);
        o.send({ op: 'toggle', id: it.id });
      });
      el.appendChild(undoBtn);
    }
    if (!it.done) {
      var on = it.id === o.focusId();
      // 每条待办自带计时方式（学番茄 todo）：'down' 倒计时 / 'up' 正计时 / '' 不计时。
      // 按钮从「专注」改成「开始」：点一下 = 设为专注 + 按这条的参数启动计时（不计时的只设专注）。
      // 三种态：进行中（这条正在计时，不可点）/ 专注中（是当前专注但没在计时，点一下取消）/ 开始
      var todoTm = it.tm === 'up' || it.tm === '' ? it.tm : 'down';
      var running = on && o.timerBusy();
      var focusBtn = document.createElement('button');
      focusBtn.type = 'button';
      focusBtn.className = 'dshwv-todo-focusbtn' + ((on || running) ? ' dshwv-todo-focusing' : '');
      if (running) {
        focusBtn.textContent = '进行中';
        focusBtn.title = '这条正在计时';
        focusBtn.disabled = true;
      } else if (on && !todoTm) {
        focusBtn.textContent = '专注中';
        focusBtn.title = '点一下取消专注';
      } else {
        focusBtn.textContent = '开始';
        focusBtn.title = todoTm === 'up'
          ? '设为当前专注并开始正计时'
          : (todoTm === 'down'
            ? '设为当前专注并开始倒计时 ' + (Number(it.mins) || 25) + ' 分钟'
            : '把这条设为当前专注（这条设为「不计时」）');
      }
      focusBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        if (running) return;
        // 已经是当前专注、且这条「不计时」→ 点一下取消。取消是独立 op，不再靠 focus 的开关语义
        if (on && !todoTm) { o.send({ op: 'unfocus', id: it.id }); return; }
        o.start(it);
      });
      el.appendChild(focusBtn);
    }
    // 「…」编辑入口：改名 / 删除 / 设提醒原先只能去设置页做（挂件只收 5 个 op），
    // 而挂件恰恰是用户正在看清单的地方 —— 改一个字要开设置页翻到「专注与待办」，
    // 成本高到多数人干脆不改。已完成的条目不挂这个入口（撤销按钮已够用，且不改已完成项）
    if (!it.done) {
      var editing = o.editId() === it.id;
      var moreBtn = document.createElement('button');
      moreBtn.type = 'button';
      moreBtn.className = 'dshwv-todo-more' + (editing ? ' dshwv-todo-more-on' : '');
      moreBtn.textContent = '…';
      moreBtn.title = '改名 / 删除 / 设提醒';
      moreBtn.setAttribute('aria-label', '编辑「' + it.text + '」');
      moreBtn.setAttribute('aria-expanded', editing ? 'true' : 'false');
      moreBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        // 再点一次关掉；点别的条目则切过去（同一条目各字段共用一份编辑态）
        o.toggleEdit(it.id);
        o.rerender();
      });
      el.appendChild(moreBtn);
      // 拖拽手柄放在最后：它是纯排序用的抓手，不承担任何点击动作。
      // 为什么不做「整行可拖」：行里已有勾选框、开始、…，pointerdown 落在这几个控件上
      // 时如果也进入拖拽，点一下按钮会被判成一次「拖了 0 像素」的排序，
      // 既发了一次无意义的 move，又会把按钮的 click 吞掉。故只在手柄上开拖拽。
      el.appendChild(dragHandle(it, o));
    }
    return el;
  }

  // 拖拽排序（③）：手柄按住 → 移动时用 dataTransfer 只带 id，
  // 经过的其它行根据落点上下半区给出 dshwv-todo-drop-before / -after 高亮，
  // 松手时算出「要插到谁前面」并上报 move。
  //
  // 用 HTML5 drag 而不是 pointer 事件：挂件是置顶浮层，pointer 拖拽一旦移出窗口
  // 就收不到 pointerup（窗口不会捕获鼠标），行会卡在 dragging 态。
  // draggable 的 dragend 由 Chromium 自己保证一定触发，即便指针出了窗口。
  function dragHandle(it, o) {
    var h = document.createElement('span');
    h.className = 'dshwv-todo-drag';
    h.textContent = '⠿';
    h.title = '拖动调整顺序';
    h.setAttribute('aria-label', '拖动调整「' + it.text + '」的顺序');
    h.setAttribute('draggable', 'true');
    // 拖拽源就是手柄自己：行上不再标 draggable，否则在勾选框 / 按钮上按下再拖也会起拖，
    // 把这几处控件的点击吞成一次排序。handle 是独立 span，按下它不会碰到别的控件
    h.addEventListener('dragstart', function (e) {
      var rowEl = h.parentNode;
      if (!rowEl) return;
      rowEl.classList.add('dshwv-todo-dragging');
      draggingId = it.id;
      try {
        e.dataTransfer.effectAllowed = 'move';
        // 只放 id：不放 index，避免列表在拖拽期间被宿主回推刷新后 index 对不上
        e.dataTransfer.setData('text/plain', 'whale-todo:' + it.id);
      } catch (err) {}
      e.stopPropagation();
    });
    h.addEventListener('dragend', function (e) {
      e.stopPropagation();
      var fromId = draggingId;
      draggingId = '';
      // 顺序要紧：先读落点标记再清标记，清完再读就永远读不到目标了
      var target = dropTarget();
      clearDropMarks();
      var rowEl = h.parentNode;
      if (rowEl) rowEl.classList.remove('dshwv-todo-dragging');
      if (!fromId || !target) return;
      // 落在下拉目标上：before=true 插到该行前，false 插到该行后（换算成「插到下一行之前」）
      var beforeId = target.before ? target.id : target.nextId;
      if (beforeId === fromId) return; // 拖回原位：不发指令
      o.send({ op: 'move', id: fromId, beforeId: beforeId });
    });
    return h;
  }

  // 当前拖拽会话：只有一份（同一时刻只拖一行）。
  // 拖拽中的 id 与落点高亮都**只活在本文件里**：它们是纯 DOM 交互的瞬态，
  // 页面既不读也不写，没必要经 o 传上去再传回来（早先想做成 o.beginDrag/endDrag，
  // 那等于让页面平白多存一份可变状态）
  var draggingId = '';
  // 落点高亮记在这张表里，dragend 统一清掉 —— 中途重画（宿主回推）会让旧节点被替换，
  // 表里的引用要能容忍已脱离 DOM 的元素
  var dropMarks = [];

  function clearDropMarks() {
    for (var i = 0; i < dropMarks.length; i++) {
      var m = dropMarks[i];
      if (m && m.el) m.el.classList.remove('dshwv-todo-drop-before', 'dshwv-todo-drop-after');
    }
    dropMarks = [];
  }

  // 找一个「当前被标记的落点」：读 DOM 上的标记类比读内部变量可靠 ——
  // 重画后标记已经跟着新节点了，而变量里可能还指着老节点
  function dropTarget() {
    var list = document.querySelector('.dshwv-todo');
    if (!list) return null;
    var rows = list.querySelectorAll('.dshwv-todo-row');
    for (var i = 0; i < rows.length; i++) {
      var el = rows[i];
      if (!el.classList.contains('dshwv-todo-drop-before') && !el.classList.contains('dshwv-todo-drop-after')) continue;
      var id = el.getAttribute('data-todo-id') || '';
      if (!id) continue;
      var next = rows[i + 1];
      return {
        id: id,
        before: el.classList.contains('dshwv-todo-drop-before'),
        nextId: next ? (next.getAttribute('data-todo-id') || '') : '',
      };
    }
    return null;
  }

  // 在清单容器上做一次事件委托：dragover / dragleave / drop 只需一套监听，
  // 不必每行各挂一份。写在文件首次 row() 调用时挂（清单容器由页面创建并插入）
  var dragBound = false;
  function bindDragOnce() {
    if (dragBound) return;
    var list = document.querySelector('.dshwv-todo');
    if (!list) return;
    dragBound = true;
    list.addEventListener('dragover', function (e) {
      if (list.querySelector('.dshwv-todo-dragging') === null) return;
      e.preventDefault(); // 不 preventDefault 就不会有 drop
      try { e.dataTransfer.dropEffect = 'move'; } catch (err) {}
      var rowEl = e.target && e.target.closest ? e.target.closest('.dshwv-todo-row') : null;
      // 指针在自身行 / 已完成的灰行 / 清单空白上：一律清掉标记，
      // 否则上一次划过的行会留着高亮，松手时按旧落点排序（用户明明已经移开了）
      if (!rowEl || rowEl.classList.contains('dshwv-todo-dragging') || rowEl.classList.contains('dshwv-todo-done')) {
        clearDropMarks();
        return;
      }
      var box = rowEl.getBoundingClientRect();
      var after = e.clientY > box.top + box.height / 2;
      var cls = after ? 'dshwv-todo-drop-after' : 'dshwv-todo-drop-before';
      // 同一行同半边不重设 class：dragover 每几十毫秒一次，反复 remove/add 会让
      // 高亮闪一下（class 变更触发样式重算）
      for (var k = 0; k < dropMarks.length; k++) {
        if (dropMarks[k].el === rowEl && dropMarks[k].cls === cls) return;
      }
      clearDropMarks();
      rowEl.classList.add(cls);
      dropMarks.push({ el: rowEl, cls: cls });
      e.stopPropagation();
    });
    list.addEventListener('dragleave', function (e) {
      // 只在离开整个清单时清标记；行与行之间的 dragleave 交给下一次 dragover 重算
      if (e.target === list) clearDropMarks();
    });
    list.addEventListener('drop', function (e) {
      // 真正的落点处理在 dragend 里（dragend 一定触发，drop 在某些路径下不会），
      // 这里只阻止默认行为（否则 Chromium 会尝试把 text/plain 当 URL 打开）
      e.preventDefault();
      e.stopPropagation();
    });
  }

  window.WhaleTodoEdit = { editor: editor, row: row, REMIND_KINDS: REMIND_KINDS, bindDrag: bindDragOnce };
})();
