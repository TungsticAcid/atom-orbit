/**
 * panel.js — Agent 面板：悬浮球 + 侧边抽屉 + 消息渲染
 *
 * 悬浮球设计要求（见实施计划 §8.6）：
 *   · 可拖动、位置记忆、松手贴边吸附 —— 避免遮挡三维视图
 *   · 拖动与点击分离（位移超阈值判为拖动，不触发展开）
 *   · 有未读的主动提示时显示小圆点
 *
 * 消息渲染：思考折叠 / Markdown 正文 / 动作气泡 / 题目卡 / 反馈卡 / 提示卡。
 * Markdown 与 LaTeX 用内联小渲染器（不引入额外依赖，保持离线可用）。
 */
window.Panel = (function () {
  'use strict';

  const POS_KEY = 'orbit.agent.fabPos';
  let fab, drawer, msgBox, inputEl, sendBtn, stopBtn, dot;
  let demoBar, demoIdx, demoText, demoNextHint;
  let demoPrev, demoNext, demoAuto, demoManual, demoStop, demoReplay, demoDismiss;

  // ---------------------------------------------------------------------------
  // 极简 Markdown + LaTeX 渲染（按需，不引入 marked.js）
  // ---------------------------------------------------------------------------
  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  const KATEX_OPTS = { throwOnError: false, trust: true, output: 'html' };

  /**
   * 裁掉"还没写完"的公式尾巴。
   *
   * ★ 这是流式输出下"公式很混乱"的主要来源：模型逐 token 吐字，在配对的
   *   $ 出现之前，整段 LaTeX 源码会以纯文本裸露出来（"系数各为 $\frac{1}{2"）。
   *   每写一个公式就闪一次源码，一行里两个公式就闪两次。
   *   做法：把未闭合的那一段整段截掉——宁可晚几十毫秒出现，也不要露源码。
   *   转义符 \$ 会被跳过，避免把正文里的美分符号当成公式起点。
   */
  function trimUnclosedFormula(text) {
    const t = String(text == null ? '' : text);
    let openAt = -1;
    for (let i = 0; i < t.length; i++) {
      if (t[i] === '\\') { i++; continue; }        // 跳过转义字符
      if (t[i] !== '$') continue;
      const isBlock = t[i + 1] === '$';
      if (openAt < 0) openAt = i;                  // 开公式
      else { openAt = -1; }                        // 配对成功
      if (isBlock) i++;
    }
    return openAt < 0 ? t : t.slice(0, openAt);
  }

  /** 单个公式 → KaTeX HTML；KaTeX 缺席或报错时退化为等宽源码（总比空白好） */
  function katexHtml(tex, display) {
    if (!window.katex) return '<code>' + escapeHtml(tex) + '</code>';
    try {
      return window.katex.renderToString(tex, Object.assign({ displayMode: display }, KATEX_OPTS));
    } catch (e) {
      return '<code>' + escapeHtml(tex) + '</code>';
    }
  }

  /**
   * 渲染消息正文为 HTML。
   *
   * ★ 次序很关键（原先就错在这里）：
   *   1) 先裁掉未闭合的公式（流式时）
   *   2) 把块级公式 $$…$$ 抽成占位符，**并在两侧强制断行**
   *   3) 再把行内公式 $…$ 抽成占位符
   *   4) 此时剩下的才是纯文本 → 可以安全地 escapeHtml（公式里的 & < > 不受影响）
   *   5) 逐行组装：块公式独占一行 div，行内公式留在流式文本里
   *
   *   若把公式分出来后各段单独走 md()，每段都会变成一个块级 div，
   *   一句话就会被行内公式切成好几行——正是之前"公式很混乱"的原因。
   *   而 $$…$$ 若夹在文字中间不强制断行，display 模式的公式会和文字挤在
   *   同一个 div 里，把行高撑成两倍、上下留白对不齐，同样显得杂乱。
   *
   * @param {string} text
   * @param {Object} [opts] { streaming:true } 时裁掉未闭合公式（流式增量渲染用）
   */
  function renderRich(text, opts) {
    let s = String(text == null ? '' : text);
    if (opts && opts.streaming) s = trimUnclosedFormula(s);

    // 块公式：连同其两侧的换行一起吃掉，改为「前后各一个换行」，
    // 这样无论模型写成独占一行还是夹在句中，落到的都是同一个块级位置
    const blocks = [];
    s = s.replace(/\n*\$\$([\s\S]+?)\$\$\n*/g, (m, tex) => {
      blocks.push(tex);
      return '\n\u0001' + (blocks.length - 1) + '\u0001\n';
    });

    const inlines = [];
    s = s.replace(/\$([^$\n]+?)\$/g, (m, tex) => {
      inlines.push(tex);
      return '\u0002' + (inlines.length - 1) + '\u0002';
    });

    s = escapeHtml(s);

    s = s.replace(/\u0002(\d+)\u0002/g, (m, i) => katexHtml(inlines[+i], false));

    return md(s, blocks);
  }

  /**
   * 逐行组装：标题 / 列表 / 表格 / 块公式 / 段落。
   * 每个内容行只包一个 div，因此行内的公式与文字能正常连成一句。
   */
  function md(src, blocks) {
    const lines = String(src).split('\n');
    const out = [];
    let inList = false;
    let inTable = false;
    const closeList = () => { if (inList) { out.push('</ul>'); inList = false; } };
    const closeTable = () => { if (inTable) { out.push('</tbody></table>'); inTable = false; } };
    const inline = (t) => t
      .replace(/\*\*([^*]+?)\*\*/g, '<b>$1</b>')
      .replace(/(^|[^*\w])\*([^*\n]+?)\*/g, '$1<i>$2</i>')
      .replace(/`([^`\n]+?)`/g, '<code>$1</code>');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // 块级公式：独占一行，左右居中、超宽可横向滚动（长公式不撑破抽屉）
      const bm = /^\s*\u0001(\d+)\u0001\s*$/.exec(line);
      if (bm) {
        closeList(); closeTable();
        out.push('<div class="md-math-block">' + katexHtml((blocks || [])[+bm[1]] || '', true) + '</div>');
        continue;
      }

      if (/^\s*\|.*\|\s*$/.test(line)) {
        const cells = line.trim().replace(/^\||\|$/g, '').split('|').map((c) => inline(c.trim()));
        if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue;
        const isHeader = !inTable;
        if (!inTable) { out.push('<table class="md-table"><thead>'); inTable = true; }
        if (isHeader) out.push('<tr>' + cells.map((c) => '<th>' + c + '</th>').join('') + '</tr></thead><tbody>');
        else out.push('<tr>' + cells.map((c) => '<td>' + c + '</td>').join('') + '</tr>');
        continue;
      }
      closeTable();

      const h = /^(#{1,4})\s+(.*)$/.exec(line);
      if (h) { closeList(); out.push('<div class="md-h">' + inline(h[2]) + '</div>'); continue; }

      const li = /^\s*[-*·]\s+(.*)$/.exec(line);
      if (li) {
        if (!inList) { out.push('<ul>'); inList = true; }
        out.push('<li>' + inline(li[1]) + '</li>');
        continue;
      }
      closeList();

      if (line.trim() === '') { out.push('<div class="md-gap"></div>'); continue; }
      // 引用块
      if (/^&gt;\s?/.test(line)) { out.push('<div class="md-quote">' + inline(line.replace(/^&gt;\s?/, '')) + '</div>'); continue; }
      out.push('<div class="md-line">' + inline(line) + '</div>');
    }
    closeList(); closeTable();
    return out.join('');
  }

  // ---------------------------------------------------------------------------
  // 构建 UI
  // ---------------------------------------------------------------------------
  function el(tag, attrs, children) {
    const e = document.createElement(tag);
    if (attrs) for (const k of Object.keys(attrs)) {
      if (k === 'class') e.className = attrs[k];
      else if (k === 'text') e.textContent = attrs[k];
      else if (k === 'html') e.innerHTML = attrs[k];
      else e.setAttribute(k, attrs[k]);
    }
    (children || []).forEach((c) => e.appendChild(c));
    return e;
  }

  function build() {
    // ---- 悬浮球 ----
    fab = el('div', { class: 'agent-fab', title: '原子轨道教学智能体（可拖动）' }, [
      // 图标为位图设计稿；圆形裁切会自然去掉四角的多余元素
      el('img', { class: 'agent-fab-img', src: 'assets/agent-icon-128.png', alt: 'AI' }),
    ]);
    dot = el('span', { class: 'agent-fab-dot' });
    fab.appendChild(dot);
    document.body.appendChild(fab);

    // ---- 抽屉 ----
    drawer = el('div', { class: 'agent-drawer' });

    const head = el('div', { class: 'agent-head' });
    head.appendChild(el('span', { class: 'agent-head-title', text: '轨道视界 · 教学智能体' }));

    const acts = el('div', { class: 'agent-head-acts' });
    const mkBtn = (label, fn, cls) => { const b = el('button', { class: 'agent-tbtn ' + (cls || ''), text: label }); b.onclick = fn; return b; };
    acts.appendChild(mkBtn('练习', () => startPractice()));
    acts.appendChild(mkBtn('演示', () => startDemo()));
    acts.appendChild(mkBtn('会话', () => enterConvPage()));
    acts.appendChild(mkBtn('设置', () => window.Settings.open()));
    const closeBtn = mkBtn('✕', () => close(), 'agent-x');
    acts.appendChild(closeBtn);
    head.appendChild(acts);
    drawer.appendChild(head);

    msgBox = el('div', { class: 'agent-msgs' });
    drawer.appendChild(msgBox);

    // ---- 演示分镜控制条 ----
    // ★ 存在的理由：动作是"一步一步走、由学生点确认"的，而三维视图在抽屉**外面**。
    //   没有这条控制条，学生只会看到右侧画面自己在变，既不知道演到第几步、
    //   这一步在讲什么，也没有"下一步"可按。
    demoBar = el('div', { class: 'agent-demo hidden' });
    const demoTop = el('div', { class: 'agent-demo-top' });
    demoIdx = el('span', { class: 'agent-demo-idx', text: '' });
    const demoBtns = el('span', { class: 'agent-demo-btns' });
    const mkAct = (label, fn, cls) => {
      const b = el('button', { class: 'agent-btn sm ' + (cls || ''), text: label, type: 'button' });
      b.onclick = fn;
      return b;
    };
    demoPrev = mkAct('◀ 上一步', () => window.SceneBridge.prev());
    demoNext = mkAct('下一步 ▶', () => window.SceneBridge.next(), 'primary');
    demoAuto = mkAct('连续播放', () => window.SceneBridge.autoPlay());
    // ★ 「⏸ 逐步」是连播态的**出口**。原先 autoPlay() 之后界面上再没有任何按钮能切回
    //   逐步（「下一步 / 连续播放」在 auto 态都被 hidden），学生一旦点了连播就只能一路看完。
    demoManual = mkAct('⏸ 逐步', () => window.SceneBridge.setManual(true));
    demoStop = mkAct('■ 停止', () => window.SceneBridge.stop(), 'stop');
    demoReplay = mkAct('↻ 重新演示', () => window.SceneBridge.replay(), 'primary');
    // ★ 「收起」只隐藏这条控制条，**不**清空播放状态 —— 「结束」原先调的是 stop()，
    //   会把队列一并清掉，于是"看完顺手收起"就再也重播不了了。
    demoDismiss = mkAct('✕ 收起', () => hideBar());
    [demoPrev, demoNext, demoAuto, demoManual, demoStop, demoReplay, demoDismiss]
      .forEach((b) => demoBtns.appendChild(b));
    demoTop.appendChild(demoIdx);
    demoTop.appendChild(demoBtns);
    demoText = el('div', { class: 'agent-demo-text', text: '' });
    demoNextHint = el('div', { class: 'agent-demo-hint hidden', text: '' });
    demoBar.appendChild(demoTop);
    demoBar.appendChild(demoText);
    demoBar.appendChild(demoNextHint);
    drawer.appendChild(demoBar);

    // ---- 输入区 ----
    const foot = el('div', { class: 'agent-foot' });
    inputEl = el('textarea', { class: 'agent-input-text', rows: '1', placeholder: '问原子轨道相关的问题，或让我演示…（Enter 发送，Shift+Enter 换行）' });
    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); }
    });
    inputEl.addEventListener('input', () => {
      inputEl.style.height = 'auto';
      inputEl.style.height = Math.min(120, inputEl.scrollHeight) + 'px';
    });
    sendBtn = el('button', { class: 'agent-btn primary', text: '发送' });
    sendBtn.onclick = doSend;
    stopBtn = el('button', { class: 'agent-btn stop hidden', text: '■ 停止' });
    stopBtn.onclick = () => { window.AgentCore.stop(); };
    foot.appendChild(inputEl);
    const fbtns = el('div', { class: 'agent-foot-btns' }, [stopBtn, sendBtn]);
    foot.appendChild(fbtns);
    drawer.appendChild(foot);

    document.body.appendChild(drawer);
    bindFabDrag();
    restoreFabPos();
    renderEmptyState();
  }

  // ---------------------------------------------------------------------------
  // 悬浮球拖动（拖动与点击分离 + 贴边吸附 + 位置记忆）
  // ---------------------------------------------------------------------------
  function bindFabDrag() {
    let dragging = false, moved = false, sx = 0, sy = 0, ox = 0, oy = 0;

    fab.addEventListener('pointerdown', (e) => {
      dragging = true; moved = false;
      sx = e.clientX; sy = e.clientY;
      const r = fab.getBoundingClientRect();
      ox = r.left; oy = r.top;
      fab.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    fab.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - sx, dy = e.clientY - sy;
      if (!moved && Math.hypot(dx, dy) > 5) moved = true;   // 超过阈值才算拖动
      if (!moved) return;
      const w = fab.offsetWidth, h = fab.offsetHeight;
      const x = Math.min(window.innerWidth - w - 4, Math.max(4, ox + dx));
      const y = Math.min(window.innerHeight - h - 4, Math.max(4, oy + dy));
      fab.style.left = x + 'px';
      fab.style.top = y + 'px';
      fab.style.right = 'auto';
      fab.style.bottom = 'auto';
    });
    fab.addEventListener('pointerup', (e) => {
      if (!dragging) return;
      dragging = false;
      if (!moved) { toggle(); return; }        // 没移动 → 视为点击
      snapToEdge();
      saveFabPos();
    });
  }

  /** 松手后贴边吸附，避免长期停在视图中央遮挡 */
  function snapToEdge() {
    const w = fab.offsetWidth;
    const r = fab.getBoundingClientRect();
    const cx = r.left + w / 2;
    const toLeft = cx < window.innerWidth / 2;
    fab.style.transition = 'left .18s ease';
    fab.style.left = (toLeft ? 10 : window.innerWidth - w - 10) + 'px';
    setTimeout(() => { fab.style.transition = ''; }, 200);
  }

  function saveFabPos() {
    try {
      localStorage.setItem(POS_KEY, JSON.stringify({
        left: fab.style.left, top: fab.style.top, right: fab.style.right, bottom: fab.style.bottom,
      }));
    } catch (e) { /* ignore */ }
  }

  function restoreFabPos() {
    let p = null;
    try { p = JSON.parse(localStorage.getItem(POS_KEY) || 'null'); } catch (e) { p = null; }
    if (p && p.left != null) {
      fab.style.left = p.left; fab.style.top = p.top;
      fab.style.right = 'auto'; fab.style.bottom = 'auto';
      // 窗口尺寸变化后可能跑到屏外，钳回来
      const r = fab.getBoundingClientRect();
      if (r.left > window.innerWidth - 20 || r.top > window.innerHeight - 20) {
        fab.style.left = ''; fab.style.top = ''; fab.style.right = ''; fab.style.bottom = '';
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 开合
  // ---------------------------------------------------------------------------
  /**
   * 抽屉开合会改变主布局宽度（padding-right 过渡 .24s）。
   *
   * 主画布与角度分布画布都有 ResizeObserver，会自己跟上；但径向/截面是**手绘
   * Canvas**——它们只在下次绘制时才按 clientWidth 重设位图尺寸。不触发重绘的话，
   * 位图还是旧宽度，被 CSS 缩放显示 → 看着发虚。这里复用主控制器已有的
   * window resize 通路（它会 resize 三维并重绘全部图表）。
   */
  function redrawChartsAfterLayout() {
    clearTimeout(layoutRedrawTimer);
    layoutRedrawTimer = setTimeout(() => {
      window.dispatchEvent(new Event('resize'));
    }, 280);                              // 略大于 240ms 的过渡时长
  }
  let layoutRedrawTimer = null;

  function open(opts) {
    drawer.classList.add('show');
    // ★ 让主布局向左压缩，而不是把右侧控制面板盖住
    document.body.classList.add('agent-open');
    dot.classList.remove('show');
    // 由演示自动唤出时不要抢焦点——学生此刻的注意力在三维视图上
    if (!opts || opts.focus !== false) inputEl.focus();
    redrawChartsAfterLayout();
  }
  function close() {
    drawer.classList.remove('show');
    document.body.classList.remove('agent-open');
    redrawChartsAfterLayout();
  }
  function toggle() { drawer.classList.contains('show') ? close() : open(); }
  function markUnread() { if (!drawer.classList.contains('show')) dot.classList.add('show'); }

  // ---------------------------------------------------------------------------
  // 消息渲染
  // ---------------------------------------------------------------------------
  /**
   * @param {string} [mid] 对应的 ConvStore 节点 id —— 挂上之后，恢复路径与 fork/编辑
   *   才能定位"这条消息是哪一条"。不传就是原行为（多数调用点不需要）。
   */
  function addMsg(html, cls, mid) {
    const m = el('div', { class: 'agent-msg ' + (cls || '') , html: html });
    if (mid) m.dataset.mid = mid;
    msgBox.appendChild(m);
    scrollDown();
    return m;
  }
  function scrollDown() { msgBox.scrollTop = msgBox.scrollHeight; }

  function addUser(text, mid) { return addMsg(escapeHtml(text), 'user', mid); }

  /** 助手消息：思考折叠 + 流式正文 */
  function beginAssistant(mid) {
    const wrap = el('div', { class: 'agent-msg assistant' });
    if (mid) wrap.dataset.mid = mid;
    const think = el('details', { class: 'agent-think' });
    think.appendChild(el('summary', { text: '思考中…' }));
    const thinkBody = el('div', { class: 'agent-think-body' });
    think.appendChild(thinkBody);
    if (!(window.Settings.get().showReasoning)) think.classList.add('hidden');
    const body = el('div', { class: 'agent-text' });
    wrap.appendChild(think);
    wrap.appendChild(body);
    msgBox.appendChild(wrap);
    scrollDown();
    // 流式正文渲染节流：每个 token 都重解析整段 + 重排 KaTeX 会很卡，
    // 且中间态（公式只写了一半）本来就不该显示。用 rAF 合并到每帧一次，
    // 并且**始终以 streaming 模式渲染**——未闭合的公式会被截掉而不是裸露源码。
    let pendingText = '';
    let rafId = 0;
    const flush = (streaming) => {
      rafId = 0;
      body.innerHTML = renderRich(pendingText, { streaming: streaming });
      scrollDown();
    };

    return {
      wrap: wrap,
      setReasoning(text) { thinkBody.textContent = text; scrollDown(); },
      setContent(text) {
        pendingText = text;
        if (rafId) return;
        rafId = requestAnimationFrame(() => flush(true));
      },
      finish(o) {
        o = o || {};
        // ★ 先掐掉排队中的那一帧再收尾。否则 finish 里已经把正文刷好了、
        //   并把 pendingText 清空，随后那一帧才执行，用空字符串再刷一次 ——
        //   界面就被刷成了空泡（"模型没有输出"的另一种成因，纯属自己造成的）。
        if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
        // 收尾时用**非流式**渲染兜一次：万一模型最后一条公式没闭合
        // （被 max_tokens 截断等），流式模式会把它整段吞掉，这里补显。
        if (pendingText) { flush(false); pendingText = ''; }

        const hasThink = !!thinkBody.textContent.trim();
        const sum = think.querySelector('summary');
        // ★ 绝不留给用户一个空白气泡。正文一个字都没有时必须说清是哪一种情况——
        //   否则"界面上什么都没有"看上去就是工具坏了，而不是模型被截断了。
        if (!o.hasContent) {
          // ★ 把证据一并打出来：finish_reason 与 token 用量。
          //   否则"没有正文"只能靠猜——是截断？还是模型只调了工具？还是流没解析到？
          const diag = [];
          if (o.finishReason) diag.push('finish_reason: ' + o.finishReason);
          const u = o.usage || {};
          if (u.completion_tokens != null) {
            const det = u.completion_tokens_details || {};
            diag.push('输出 ' + u.completion_tokens + ' tokens'
              + (det.reasoning_tokens != null ? '（其中思考 ' + det.reasoning_tokens + '）' : ''));
          }
          if (u.prompt_tokens != null) diag.push('输入 ' + u.prompt_tokens + ' tokens');
          const tail = diag.length ? '<br><span class="agent-diag">' + escapeHtml(diag.join('　·　')) + '</span>' : '';

          let why;
          if (o.finishReason === 'length') {
            why = '模型这次没有输出正文：输出被长度上限截断。'
              + '可在「设置 → 输出上限 max_tokens」调大后重试。';
          } else if (o.finishReason === 'tool_calls') {
            why = '模型这次只发起了动作调用，没写正文。动作可能已经排进演示队列了，看一下上面的动作气泡。';
          } else {
            why = '模型这次没有返回正文';
            why += hasThink ? '（只输出了思考内容）' : '（连思考内容也没有，可能是服务端返回异常）';
            why += '。可以再问一次，或换一个模型试试。';
          }
          body.innerHTML = '<div class="agent-warn">' + escapeHtml(why) + tail + '</div>';
        }
        think.removeAttribute('open');
        if (!hasThink) { think.classList.add('hidden'); }
        else {
          sum.textContent = o.hasContent ? '已思考（点击展开）' : '模型实际输出的思考内容（点击展开）';
          // 没正文时把思考展开，让用户至少还能看到模型干了什么
          if (!o.hasContent) think.setAttribute('open', '');
        }
      },
      setError(text) { body.innerHTML = '<span class="agent-err">' + escapeHtml(text) + '</span>'; },
    };
  }

  /** 动作气泡：把"智能体动了什么"显式呈现出来 */
  function addActionBubble(name, argsOrActions, result) {
    const ok = !(result && result.error);
    const d = el('details', { class: 'agent-action ' + (ok ? '' : 'bad') });

    // applySceneActions 的实际内容在 actions 数组里——那才是"智能体动的手"
    const acts = (name === 'applySceneActions' && Array.isArray(argsOrActions))
      ? argsOrActions
      : [{ action: name, params: argsOrActions }];
    d._acts = acts;                       // 供 enrichActionBubble 回填「引用 / 重播」

    const lines = acts.map((a) => describeAction(a.action, a.params || a));
    d.appendChild(el('summary', {
      html: '<span class="agent-act-dot"></span>' + escapeHtml(lines[0]) +
        (lines.length > 1 ? '<span class="agent-act-more">等 ' + lines.length + ' 个动作</span>' : ''),
    }));
    const body = el('div', { class: 'agent-act-body' });
    // 每步一行。**引用 / 重播按钮与"演示 #N"标签在 enrichActionBubble 里挂**，
    // 因为直播路径创建气泡时工具还没执行、我们手上没有 demoId 与 perAction
    // （结果要等 onToolResult 才回来）。
    lines.forEach((line, i) => {
      const row = el('div', { class: 'agent-act-row' });
      row.setAttribute('data-i', String(i));
      row.appendChild(el('span', { class: 'agent-act-txt', text: line }));
      body.appendChild(row);
    });
    d.appendChild(body);
    msgBox.appendChild(d);
    scrollDown();
    if (result) enrichActionBubble(d, result);
    return d;
  }

  /**
   * 把工具回执里的地址信息回填到动作气泡上（「引用」与「重播这个演示」）。
   *
   * ★ 为什么单独一个函数：**直播路径创建气泡时还不知道结果**（工具是随后才执行的），
   *   所以这两条路径必须在同一个地方汇合 —— 恢复路径在 `addActionBubbleForCall` 里
   *   一次性带结果调用，直播路径在 `onToolResult` 里回填。写在两处必然会漂移，
   *   而上一轮"图表浮窗完全画不出内容"的教训正是"同一件事写在两处"。
   *
   * ★ demoId 与 perAction 是「气泡上的第 i 行 ↔ 演示里的第几步」的对应表：
   *   气泡渲染的是模型**原始**的动作数组，队列里只有校验通过的部分，两者会错位。
   *   有了这张表，「引用」才能写出"演示 #3 的第 5 步"这种**可寻址**的引用 ——
   *   而它随工具结果一起存档，所以刷新之后引用依然准确。
   */
  function enrichActionBubble(d, result) {
    if (!d || !result || d.dataset.enriched) return;
    d.dataset.enriched = '1';
    const acts = d._acts || [];
    const demoId = (result.demoId != null) ? result.demoId : null;
    const per = Array.isArray(result.perAction) ? result.perAction : null;
    const body = d.querySelector('.agent-act-body');
    if (!body) return;

    Array.prototype.forEach.call(body.querySelectorAll('.agent-act-row[data-i]'), function (row) {
      const i = Number(row.getAttribute('data-i'));
      const pa = per ? per[i] : null;
      // ① 被校验退回的动作：标出来，否则学生会以为"这一步也演过了"
      if (pa && !pa.ok) {
        row.appendChild(el('span', { class: 'agent-act-skip',
          text: '未执行：' + (pa.error || '参数不合法') }));
        return;
      }
      // ② 可寻址的引用
      const stepIndex = (pa && pa.stepIndex != null) ? pa.stepIndex : (demoId != null && !per ? i : null);
      if (demoId == null || stepIndex == null) return;
      const q = el('button', { class: 'agent-act-btn', text: '引用',
        title: '把「演示 #' + demoId + ' 的第 ' + (stepIndex + 1) + ' 步」写进输入框，便于提整改意见' });
      q.type = 'button';
      q.addEventListener('click', function (ev) {
        ev.stopPropagation();
        quoteStep(acts[i], {
          demoId: demoId, stepIndex: stepIndex,
          total: result.totalSteps || (per ? per.length : acts.length),
        });
      });
      row.appendChild(q);
    });

    // ③ 「重播这个演示」：演示记录独立于播放队列存在（见 scene-bridge 的"演示记录"），
    //    所以哪怕这条演示早就播完、甚至刷新过页面，也还能整条重播。
    if (demoId != null && window.SceneBridge && window.SceneBridge.replayDemo) {
      const foot = el('div', { class: 'agent-act-row agent-act-foot' });
      const rp = el('button', { class: 'agent-act-btn', type: 'button',
        text: '↻ 重播这个演示', title: '从第 1 步重新播放演示 #' + demoId });
      rp.addEventListener('click', function (ev) {
        ev.stopPropagation();
        const r = window.SceneBridge.replayDemo(demoId);
        if (r && r.ok) addChip('正在重播演示 #' + demoId + '（共 ' + r.total + ' 步）');
        else addChip((r && r.error) || '重播失败', 'warn');
      });
      foot.appendChild(rp);
      body.appendChild(foot);
      const sm = d.querySelector('summary');
      if (sm) sm.insertAdjacentHTML('beforeend',
        '<span class="agent-act-more">演示 #' + demoId + '</span>');
    }
    body.appendChild(el('div', { class: 'agent-act-ret',
      text: '返回：' + JSON.stringify(result).slice(0, 400) }));
  }

  // ---------------------------------------------------------------------------
  // 恢复路径：按 ConvStore 的当前分支重建整个消息区
  // ---------------------------------------------------------------------------
  /**
   * 为一个回合建静态容器（非流式）。一轮回复可能有多条 assistant 节点（多轮工具调用），
   * 它们都进**同一个**容器 —— 这样"回合组"的 dataset.mid 就是它起始 user 节点的 id，
   * 组上的「重答」语义 = 重发这条 user 消息，多轮工具调用被正确当作一个整体。
   */
  function beginStaticTurn(mid) {
    const wrap = el('div', { class: 'agent-msg assistant' });
    if (mid) wrap.dataset.mid = mid;
    const body = el('div', { class: 'agent-text' });
    wrap.appendChild(body);
    msgBox.appendChild(wrap);
    return {
      wrap: wrap,
      setReasoning(text) {
        if (!text) return;
        let think = wrap.querySelector('.agent-think');
        if (!think) {
          think = el('details', { class: 'agent-think' });
          think.appendChild(el('summary', { text: '思考过程' }));
          think.appendChild(el('div', { class: 'agent-think-body' }));
          wrap.insertBefore(think, body);
          if (!(window.Settings.get().showReasoning)) think.classList.add('hidden');
        }
        think.querySelector('.agent-think-body').textContent = text;
      },
      addText(text) {
        if (!text || !text.trim()) return;
        body.appendChild(el('div', { html: renderRich(text, { streaming: false }) }));
      },
    };
  }

  /**
   * 恢复路径的动作气泡：判据与直播路径完全一致（applySceneActions 或 ACTION_LABEL 里有名字的）。
   * @param {Array=} demoReg 演示记录的重建清单；applySceneActions 会把真正入队的动作追加进去
   */
  function addActionBubbleForCall(tc, toolNode, demoReg) {
    const name = tc.function && tc.function.name;
    if (!name) return;
    let args = {};
    try { args = JSON.parse((tc.function && tc.function.arguments) || '{}'); } catch (e) { args = {}; }
    let result = null;
    if (toolNode) { try { result = JSON.parse(toolNode.content); } catch (e) { result = null; } }
    if (name === 'applySceneActions') {
      const acts = (args && args.actions) || [];
      addActionBubble(name, acts, result);
      if (demoReg && result && result.demoId != null) {
        // ★ 只登记**真正入队**的动作（perAction 标了 ok 的那些）：被校验退回的动作不在
        //   队列里、也不该出现在重播的演示里。perAction 缺失（旧存档）时退回全量。
        const per = Array.isArray(result.perAction) ? result.perAction : null;
        const steps = acts
          .filter((a, i) => (!per || (per[i] && per[i].ok)))
          .map((a) => ({ action: a && a.action, params: (a && a.params) || null, speech: a && a.speech }));
        if (steps.length) demoReg.push({ demoId: result.demoId, origin: 'agent', steps: steps });
      }
    } else if (ACTION_LABEL[name]) addActionBubble(name, args, result);
  }

  /**
   * 按当前分支重建消息区（刷新后调用）。
   * ★ 分组规则必须与直播路径一致，否则用户会觉得"刷新后变了样"：
   *   · 真用户消息 → 关上一组、渲染气泡、开新组（其 id 即组 id）
   *   · internal → 关上一组、**不渲染气泡**（与直播一致）
   *   · continuation → 不渲染、不开新组（它属于上一条回答的续写）
   *   · assistant / tool → 进当前组；动作气泡由 tool_calls 与对应 tool 节点**派生**
   *     （所以动作气泡不必存进 store）
   *   · card（题目卡等）→ 归后续批次渲染，这里先跳过
   */
  function renderPath() {
    const S = window.ConvStore;
    if (!S) return;
    msgBox.innerHTML = '';
    const chain = S.path();
    if (!chain.length) {
      // 空白起点也要把演示登记清掉（否则切到空分支后，上一条演示还留在清单里）
      if (window.SceneBridge && SceneBridge.syncDemosFromHistory) SceneBridge.syncDemosFromHistory([]);
      renderEmptyState();
      return;
    }
    const ids = S.idMap ? S.idMap() : {};
    const idOf = (n) => ids[n.seq] || null;
    const toolByCall = Object.create(null);
    chain.forEach(function (n) {
      if (n.role === 'tool' && n.tool_call_id) toolByCall[n.tool_call_id] = n;
    });
    // ★ 演示记录的重建清单（按渲染顺序累积）。渲染完后一次性交给 SceneBridge ——
    //   演示记录不单独持久化，**对话历史本身就是它的真相**：每个 applySceneActions
    //   的 tool_call 带着动作、紧跟的 tool 结果带着 demoId 与逐步的入队结果。
    //   于是"重播之前对话里的演示"刷新后依然成立。
    const demoReg = [];

    let turn = null;
    let turnMid = null;      // 当前回合**起始 user 节点**的 id —— 组的 dataset.mid 取它
    chain.forEach(function (n) {
      if (n.role === 'card') { turn = null; turnMid = null; return; }
      if (n.role === 'user') {
        if (n.origin === 'continuation') return;      // 续写提示：不渲染、不开新组
        turn = null;                                  // 关上一组
        turnMid = idOf(n);
        if (n.origin === 'internal') return;          // 内部提示：不渲染气泡
        const un = addUser(n.content, idOf(n));
        attachActs(un, idOf(n), 'user');
        return;
      }
      if (n.role === 'assistant') {
        if (!turn) {
          turn = beginStaticTurn(turnMid);
          attachActs(turn.wrap, turnMid, 'turn');
        }
        if (n.reasoning) turn.setReasoning(n.reasoning);
        turn.addText(n.content);
        (n.tool_calls || []).forEach(function (tc) {
          addActionBubbleForCall(tc, toolByCall[tc.id], demoReg);
        });
        return;
      }
    });
    // 一次性重建演示记录（幂等：见 syncDemosFromHistory 的说明）
    if (window.SceneBridge && SceneBridge.syncDemosFromHistory) {
      try { SceneBridge.syncDemosFromHistory(demoReg); } catch (e) { /* 记录重建失败不该影响渲染 */ }
    }
    scrollDown();
  }

  // ---------------------------------------------------------------------------
  // 消息工具条：复制 / 编辑 / 分支 / 重答
  // ---------------------------------------------------------------------------
  /**
   * 复制文本。
   * ★ 不用 navigator.clipboard：它要求 secure context，而本项目定位是"file:// 双击
   *   即用"，file:// 在 Chrome / Edge / Safari 里都不算 secure context —— clipboard
   *   直接是 undefined 或 reject。故走隐藏 textarea + execCommand 的降级路径，
   *   navigator.clipboard 只作为 https 部署时的快路径。
   */
  function copyText(text, btn) {
    const done = (ok) => {
      if (!btn) return;
      const old = btn.textContent;
      btn.textContent = ok ? '已复制' : '复制失败';
      btn.classList.add(ok ? 'ok' : 'bad');
      setTimeout(() => { btn.textContent = old; btn.classList.remove('ok', 'bad'); }, 1200);
    };
    let ok = false;
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      // 不能 display:none（那样选不中），移到屏幕外即可
      ta.style.cssText = 'position:fixed;top:0;left:-9999px;opacity:0';
      document.body.appendChild(ta);
      // iOS Safari 必须显式 setSelectionRange，否则会复制到空串
      ta.select();
      ta.setSelectionRange(0, ta.value.length);
      ok = document.execCommand('copy');
      document.body.removeChild(ta);
    } catch (e) { ok = false; }
    if (!ok && navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => done(true), () => done(false));
      return;
    }
    done(ok);
  }

  /**
   * 把"这一步"写进输入框，光标留在末尾等学生补"改成什么"。
   * ★ 现在**会写明演示编号与步号**（演示 #N 的第 M 步），因为这两个值有了确切来源：
   *   动作气泡的 perAction → 该动作在这条演示里的 stepIndex，配合 result.demoId。
   *   原先只能写成一段可读描述、让模型自己"对照 getSnapshot 去定位"—— 演示一多或
   *   一播完，模型定位不到就只能重发整条，于是"新演示只剩这一条"。
   * @param {Object} act  动作对象 {action, params}
   * @param {Object} info {demoId, stepIndex, total}
   */
  function quoteStep(act, info) {
    if (!inputEl) return;
    const a = act || {};
    const inf = info || {};
    const addr = (inf.demoId != null && inf.stepIndex != null)
      ? '【整改演示】演示 #' + inf.demoId + ' 的第 ' + (inf.stepIndex + 1) + ' 步'
        + (inf.total ? '（共 ' + inf.total + ' 步）' : '')
      : '【整改演示】';
    const txt = addr + '\n这一步是：' + describeAction(a.action || '', a.params || a)
      + '\n我想改成：';
    inputEl.value = txt;
    inputEl.focus();
    try { inputEl.setSelectionRange(txt.length, txt.length); } catch (e) { /* 忽略 */ }
  }

  /** 正在跑就把当前回合停掉 —— 结构性操作（分叉 / 重答）前必须先停，否则在飞的回合会继续往新分支追加 */
  function stopRunning() {
    if (window.AgentCore && window.AgentCore.isRunning && window.AgentCore.isRunning()) {
      window.AgentCore.stop();
      addChip('已停止（本次循环剩余动作已丢弃）', 'warn');
    }
  }

  /**
   * 挂工具条。
   * ★ 只 appendChild 到消息节点上，**绝不新增 DOM 层级包住正文** —— beginAssistant 的
   *   setContent 会整段重写内层 .agent-text 的 innerHTML，工具条挂在 wrap 上才不会被
   *   流式重渲染吃掉。
   * @param {string} role 'user'（单条提问）| 'turn'（一个回合并为一组）| 'card'
   */
  function attachActs(node, mid, role) {
    if (!node || !mid || !window.ConvStore) return;
    const bar = el('div', { class: 'agent-msg-acts' });
    const mk = (label, title, fn) => {
      const b = el('button', { class: 'agent-act-btn', text: label, title: title });
      b.type = 'button';
      b.addEventListener('click', (ev) => { ev.stopPropagation(); fn(b); });
      return b;
    };
    // ★ 复制的是**存档里的原文**，不从 DOM 反解析：DOM 里是 KaTeX 渲染后的 HTML，
    //   textContent 会把 $\frac{1}{2}$ 变成 "21"（分子分母粘连），公式源码彻底丢失。
    bar.appendChild(mk('复制', '复制原文（含公式源码）', (b) => {
      const n = window.ConvStore.nodeById(mid);
      copyText(n ? n.content : '', b);
    }));
    if (role === 'user') {
      bar.appendChild(mk('编辑', '改这条提问并从它重新提问（原分支保留）', () => editUserMsg(mid)));
      bar.appendChild(mk('另起', '从这条提问之前另起一条分支，文字不变（原分支保留）', () => forkFrom(mid)));
    } else if (role === 'turn') {
      bar.appendChild(mk('重答', '让智能体重新回答这一轮（原回答保留为另一条分支）', () => reanswer(mid)));
      bar.appendChild(mk('追问', '从这一轮末尾另起一条分支，接着问（原分支保留）', () => forkFrom(mid, true)));
    }
    node.appendChild(bar);
  }

  /** 编辑提问 = 从它的**上一条**分叉 + 用新文本重发（原分支一个字节都不动） */
  function editUserMsg(mid) {
    const S = window.ConvStore;
    const n = S.nodeById(mid);
    if (!n) return;
    const next = window.prompt('改这条提问（将从这里重新提问，原分支会保留）：', n.content);
    if (next == null) return;
    const text = String(next).trim();
    if (!text || text === n.content) return;
    stopRunning();
    S.branchFrom(n.parent);
    const nm = S.appendUser(text, n.origin || 'user');
    renderPath();
    refreshBranchBars();
    runAgent(null, nm);
  }

  /** 重答：回到该回合的提问重发一次 */
  function reanswer(userMid) {
    const S = window.ConvStore;
    const n = S.nodeById(userMid);
    if (!n || n.role !== 'user') return;
    stopRunning();
    S.branchFrom(n.parent);
    const nm = S.appendUser(n.content, n.origin || 'user');
    renderPath();
    refreshBranchBars();
    runAgent(null, nm);
  }

  /**
   * 分叉。
   * @param {boolean} atTurnEnd true = 以该回合末尾为起点（"接着这条回答另起一问"）；
   *   false = 以该节点的前一条为起点（"换个问法"）
   */
  function forkFrom(mid, atTurnEnd) {
    const S = window.ConvStore;
    const n = S.nodeById(mid);
    if (!n) return;
    stopRunning();
    let from = n.parent;
    if (atTurnEnd) {
      const ids = S.idMap();
      const last = S.lastNodeOfTurn(mid);
      if (last && ids[last.seq]) from = ids[last.seq];
    }
    S.branchFrom(from);
    renderPath();
    refreshBranchBars();
    addChip('已另起一条分支（原分支保留 —— 分叉处的分支片与「会话」页都能切回）');
    if (inputEl) inputEl.focus();
  }

  // ---------------------------------------------------------------------------
  // 分支切换片：只在"真正分叉"的地方出现
  // ---------------------------------------------------------------------------
  /**
   * 一个节点在分支片上的短标签（首条内容摘要）。
   * ★ 必须取自 ConvStore 的源文本，不解析 DOM（DOM 里是渲染后的 HTML，公式会变成
   *   一堆上下标数字），与「复制」的取法保持一致。
   */
  function branchLabel(id, S) {
    const nd = S.nodeById(id);
    if (!nd) return '（未知）';
    if (nd.role === 'card') return nd.kind === 'quiz' ? '（练习题）' : '（卡片）';
    const t = String(nd.content || '').replace(/\s+/g, ' ').trim();
    if (t) return t.slice(0, 14);
    return nd.role === 'assistant' ? '（回答）' : '（动作记录）';
  }

  /**
   * 给"同一 parent 下 ≥2 个子节点"的地方插一条分支切换片。
   *
   * ★ 为什么是**可点的分支片**而不是原来的 `分支 1/2 ‹ ›`：
   *   原样式独占一行、带两个箭头，看着像"整段对话的分页器"，而且不点开根本不知道
   *   另一条是什么。现在把**每条分支的首句**直接列出来，当前那条高亮且不可点 ——
   *   "这里有 N 个版本、各是什么、我现在看的是哪个"一眼可见，"怎么切"只剩一个动作。
   *   懒渲染：绝大多数会话一条都不显示，零视觉噪音。
   */
  function refreshBranchBars() {
    const S = window.ConvStore;
    if (!S || !msgBox) return;
    Array.prototype.forEach.call(msgBox.querySelectorAll('.agent-branch-bar'), (b) => b.remove());
    const chain = S.path();
    const ids = S.idMap();
    chain.forEach(function (n) {
      const myId = ids[n.seq];
      if (!myId) return;
      const sibs = S.siblings(myId);
      if (sibs.length < 2) return;
      const here = sibs.indexOf(myId);
      if (here < 0) return;
      const node = msgBox.querySelector('[data-mid="' + myId + '"]');
      if (!node || !node.parentNode) return;
      const bar = el('div', { class: 'agent-branch-bar' });
      bar.appendChild(el('span', { class: 'agent-branch-label',
        text: '⑂ 这处分出 ' + sibs.length + ' 条：' }));
      sibs.forEach(function (id, k) {
        const cur = (id === myId);
        const depth = S.branchDepth ? S.branchDepth(id) : 0;
        const chip = el('button', {
          class: 'agent-branch-chip' + (cur ? ' active' : ''),
          type: 'button',
          text: (k + 1) + '. ' + branchLabel(id, S) + (depth ? ' · ' + depth + ' 条' : ''),
          title: cur ? '当前显示的就是这一条' : '切到这一条（该分支共 ' + depth + ' 条消息）',
        });
        // 当前这条不可点：留着可点只会让人以为"再点一下会有什么"
        chip.disabled = cur;
        if (!cur) {
          chip.addEventListener('click', function () {
            S.switchLeaf(id);
            renderPath();
            refreshBranchBars();
            const hit = msgBox.querySelector('[data-mid="' + id + '"]');
            if (hit && hit.scrollIntoView) hit.scrollIntoView({ block: 'center' });
          });
        }
        bar.appendChild(chip);
      });
      node.parentNode.insertBefore(bar, node);
    });
  }

  // ---------------------------------------------------------------------------
  // 会话页（抽屉内的二级页，绝对定位滑入 —— 不动抽屉既有的 flex 列）
  // ---------------------------------------------------------------------------
  let convPage = null;

  function agoText(ts) {
    if (!ts) return '';
    const d = Math.max(0, Date.now() - ts);
    if (d < 60000) return '刚刚';
    if (d < 3600000) return Math.floor(d / 60000) + ' 分钟前';
    if (d < 86400000) return Math.floor(d / 3600000) + ' 小时前';
    return Math.floor(d / 86400000) + ' 天前';
  }

  function buildConvPage() {
    if (convPage) return convPage;
    convPage = el('div', { class: 'agent-conv-page' });
    const head = el('div', { class: 'agent-conv-head' });
    const back = el('button', { class: 'agent-tbtn', text: '← 返回' });
    back.type = 'button';
    back.onclick = () => leaveConvPage();
    const add = el('button', { class: 'agent-tbtn primary', text: '+ 新建' });
    add.type = 'button';
    add.onclick = () => {
      window.ConvStore.newSession('');
      leaveConvPage();
      renderPath();
      refreshBranchBars();
      addChip('已新建会话');
    };
    head.appendChild(back);
    head.appendChild(el('span', { class: 'agent-conv-title', text: '会话' }));
    head.appendChild(add);
    convPage.appendChild(head);
    convPage.appendChild(el('div', { class: 'agent-conv-list' }));
    convPage.appendChild(el('div', { class: 'agent-conv-foot' }));
    drawer.appendChild(convPage);
    return convPage;
  }

  function renderConvList() {
    const S = window.ConvStore;
    if (!S || !convPage) return;
    const list = convPage.querySelector('.agent-conv-list');
    const foot = convPage.querySelector('.agent-conv-foot');
    list.innerHTML = '';
    const active = S.activeSessionId();
    const rows = S.sessions().slice()
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    rows.forEach((s) => {
      const row = el('div', { class: 'agent-conv-row' + (s.id === active ? ' active' : '') });
      const t = el('span', { class: 'agent-conv-t', text: s.title || '（未命名）' });
      row.appendChild(t);
      // 当前会话标出"分过几次叉" —— 只读文本足矣，切分支的入口在下方的分支点清单里
      // （原先这里写的是"分支 1/2"，与消息区的分支片重复，且看不出切哪儿去）
      if (s.id === active) {
        const nf = (S.forkPoints ? S.forkPoints().length : 0);
        if (nf) {
          row.appendChild(el('span', { class: 'agent-conv-meta', text: nf + ' 处分叉' }));
        }
      }
      row.appendChild(el('span', { class: 'agent-conv-meta',
        text: (s.count || 0) + ' 条 · ' + agoText(s.updatedAt) }));
      const ren = el('button', { class: 'agent-act-btn', text: '✎', title: '重命名' });
      ren.type = 'button';
      ren.onclick = (ev) => { ev.stopPropagation(); renameInline(row, t, s); };
      const del = el('button', { class: 'agent-act-btn', text: '✕', title: '删除' });
      del.type = 'button';
      del.onclick = (ev) => {
        ev.stopPropagation();
        if (!confirm('删除这个会话？不可恢复。')) return;
        S.deleteSession(s.id);
        renderConvList();
        renderPath();
        refreshBranchBars();
      };
      row.appendChild(ren);
      row.appendChild(del);
      row.onclick = () => {
        if (s.id === active) { leaveConvPage(); return; }
        S.switchSession(s.id);
        leaveConvPage();
        renderPath();
        refreshBranchBars();
      };
      list.appendChild(row);
    });
    // ---- 分支点清单 ----
    // ★ 消息区的分支片只在**当前路径**上出现：切到另一条分支后，原来那个分叉点就不在
    //   路径上了，学生便"找不到回去的路"。这里给出全局视角，并让"在哪切分支"只有
    //   这一个答案（另一个入口是分叉处那条分支片）。
    const forks = S.forkPoints ? S.forkPoints() : [];
    if (forks.length) {
      const sec = el('div', { class: 'agent-conv-sec' });
      sec.appendChild(el('div', { class: 'agent-conv-sec-t',
        text: '当前会话的分支点（' + forks.length + ' 处）' }));
      forks.forEach(function (fp) {
        const node = fp.id ? S.nodeById(fp.id) : null;
        const box = el('div', { class: 'agent-fork' });
        box.appendChild(el('div', { class: 'agent-fork-at',
          text: '分叉于：' + (fp.root ? '会话开头' : (node ? branchLabel(fp.id, S) : '（未知）')) }));
        const chips = el('div', { class: 'agent-fork-chips' });
        fp.children.forEach(function (id, k) {
          const depth = S.branchDepth ? S.branchDepth(id) : 0;
          const b = el('button', { class: 'agent-branch-chip', type: 'button',
            text: (k + 1) + '. ' + branchLabel(id, S) + (depth ? ' · ' + depth + ' 条' : ''),
            title: '切到这一条并收起本页' });
          b.addEventListener('click', function (ev) {
            ev.stopPropagation();
            S.switchLeaf(id);
            leaveConvPage();
            renderPath();
            refreshBranchBars();
            const hit = msgBox.querySelector('[data-mid="' + id + '"]');
            if (hit && hit.scrollIntoView) hit.scrollIntoView({ block: 'center' });
            addChip('已切到该分支');
          });
          chips.appendChild(b);
        });
        box.appendChild(chips);
        sec.appendChild(box);
      });
      list.appendChild(sec);
    }
    const st = S.stats();
    foot.textContent = '已用 ' + st.sessions + ' 个会话 · 约 ' + Math.round(st.bytes / 1024) + ' KB'
      + ' / 上限 ' + S.MAX_SESSIONS + ' 个'
      + (st.persist ? '' : ' · ⚠ 本机存储已满，本次对话不再自动保存');
  }

  /** 行内重命名（不用 prompt()，移动端也顺手） */
  function renameInline(row, span, s) {
    const inp = el('input', { class: 'agent-conv-input' });
    inp.value = s.title || '';
    inp.placeholder = '会话名';
    row.replaceChild(inp, span);
    inp.focus();
    inp.select();
    let done = false;
    const commit = (save) => {
      if (done) return;
      done = true;
      if (save) window.ConvStore.renameSession(s.id, inp.value.trim());
      renderConvList();
    };
    inp.addEventListener('keydown', (ev) => {
      ev.stopPropagation();                  // 别让 Enter 冒泡到输入框的发送逻辑
      if (ev.key === 'Enter') commit(true);
      else if (ev.key === 'Escape') commit(false);
    });
    inp.addEventListener('blur', () => commit(true));
    inp.addEventListener('click', (ev) => ev.stopPropagation());
  }

  function enterConvPage() {
    buildConvPage();
    renderConvList();
    convPage.classList.add('show');
    if (inputEl) inputEl.blur();    // 移动端：不收键盘的话列表会被压掉一半
  }

  function leaveConvPage() {
    if (convPage) convPage.classList.remove('show');
  }

  const ACTION_LABEL = {
    setQuantumNumbers: '切换轨道', sweepQuantumNumber: '连续扫描量子数',
    setWavefunctionMode: '切换实/复函数', setRenderMode: '切换渲染方式',
    setColorMode: '切换着色', setPsiCriterion: '切换 |ψ| / |ψ|² 判据',
    setIsosurfaceLevel: '调整等值面阈值', animateIsosurfaceLevel: '扫描等值面阈值',
    showRadial: '切换径向曲线', highlightRadialFeature: '标注峰值/零点',
    linkRadialTo3D: '画出参考球（把半径与三维对应）',
    setAngularView: '切换角度分布', setSectionPlane: '切换截面', setSectionMode: '切换截面模式',
    spotlightNodes: '高亮节面', setFormulaHighlight: '高亮公式项',
    setAutoRotate: '自动旋转', resetCamera: '复位视角', resetSectionView: '复位截面缩放',
    showReferenceTable: '打开教材对照表', focusChart: '放大图表讲解',
  };
  function describeAction(name, args) {
    const label = ACTION_LABEL[name] || name;
    if (name === 'setQuantumNumbers' && args) {
      return label + ' → n=' + (args.n != null ? args.n : '-') + ' l=' + (args.l != null ? args.l : '-') + ' m=' + (args.m != null ? args.m : '-');
    }
    if (args && Object.keys(args).length) {
      const kv = Object.keys(args).map((k) => k + '=' + JSON.stringify(args[k])).join(' ');
      return label + '（' + kv + '）';
    }
    return label;
  }

  function addChip(text, cls) {
    addMsg('<span class="agent-chip ' + (cls || '') + '">' + escapeHtml(text) + '</span>', 'chip-row');
  }

  function renderEmptyState() {
    msgBox.innerHTML = '';
    addMsg(
      '<div class="agent-hello">' +
      '<b>我是轨道视界教学智能体</b><br>' +
      '我能感知你此刻在看哪个轨道，也能动手把话演示出来。<br><br>' +
      '试试：<br>' +
      '· 「3d 有几个径向节点？切过去给我看」<br>' +
      '· 「我分不清 R(r) 和 D(r)」<br>' +
      '· 「复函数和实函数有什么区别」<br>' +
      '或点上方 <b>练习</b> 开始一个知识点的完整闭环。' +
      '</div>', 'assistant'
    );
  }

  // ---------------------------------------------------------------------------
  // 发送
  // ---------------------------------------------------------------------------
  let cur = null;

  async function doSend() {
    const text = inputEl.value.trim();
    if (!text) return;
    if (!window.Settings.hasKey()) {
      addMsg('<span class="agent-err">尚未配置 API Key。请点右上角「设置」填写你自己的模型密钥（BYOK，本工具不提供额度）。</span>', 'assistant');
      window.Settings.open();
      return;
    }
    inputEl.value = ''; inputEl.style.height = 'auto';
    // ★ 先落树、再发送：send(null) 不会重复追加（agent-core 里是 `if (userText)`），
    //   于是"这条消息归属哪一轮"只有一处真相 —— fork / 编辑才定位得到它。
    const S = window.ConvStore;
    const mid = S ? S.appendUser(text, 'user') : null;
    const un = addUser(text, mid);
    attachActs(un, mid, 'user');
    await runAgent(null, mid);
  }

  /**
   * @param {string|null} userText 传 null 表示"消息已由调用方落树"（doSend 与 fork / 编辑
   *   路径都这样）；其余调用方（练习 / 演示）仍传文本，这里代为落树，但**不渲染用户
   *   气泡** —— 保持它们原本的样子。
   * @param {string} [mid] 该回合起始 user 节点的 id，用来给消息组打标记
   */
  async function runAgent(userText, mid) {
    const S = window.ConvStore;
    if (userText != null && S) mid = S.appendUser(userText, 'internal');
    cur = beginAssistant(mid);
    attachActs(cur.wrap, mid, 'turn');   // 直播时也挂工具条，与恢复路径行为一致
    let reasoning = '', content = '';
    let lastBubble = null;
    let truncated = false;
    stopBtn.classList.remove('hidden');
    sendBtn.disabled = true;

    const r = await window.AgentCore.send(userText, {
      onDelta(ev) {
        if (ev.type === 'reasoning') { reasoning += ev.text; cur.setReasoning(reasoning); }
        else if (ev.type === 'content') { content += ev.text; cur.setContent(content); }
      },
      // 截断之类的"非错误但需要说一声"的情况
      onNotice(n) {
        if (!n) return;
        if (n.kind === 'truncated') {
          truncated = true;
          addChip('输出触发长度上限，正在接着写…', 'warn');
        } else if (n.kind === 'truncated_giveup') {
          addChip('输出仍被截断，已停止续写；可在「设置 → 输出上限」调大后重试', 'warn');
        } else if (n.kind === 'param_downgrade') {
          addChip(n.text, 'warn');
        }
      },
      onToolCall(info) {
        // 只有"动手"的工具才显示气泡；查询/知识类属内部行为，静默
        if (info.name === 'applySceneActions') {
          lastBubble = addActionBubble('applySceneActions', (info.args && info.args.actions) || []);
        } else if (ACTION_LABEL[info.name]) {
          lastBubble = addActionBubble(info.name, info.args);
        }
      },
      onToolResult(info) {
        if (!lastBubble) return;
        if (info.name !== 'applySceneActions' && !ACTION_LABEL[info.name]) return;
        const failed = info.result && info.result.failed;
        if (failed && failed.length) {
          lastBubble.classList.add('bad');
          const s = lastBubble.querySelector('summary');
          if (s) s.insertAdjacentHTML('beforeend',
            '<span class="agent-act-err">· ' + failed.length + ' 个动作未执行</span>');
        }
        // ★ 直播路径的气泡是"先建后填"：创建时工具还没执行，demoId / perAction 要等结果
        //   回来才拿得到。这里回填「引用」与「重播这个演示」—— 与恢复路径**共用同一段
        //   代码**（enrichActionBubble）。写在两处必然漂移。
        enrichActionBubble(lastBubble, info.result);
        lastBubble = null;
      },
      onDone(summary) {
        cur.finish({
          hasContent: !!content.trim(),
          truncated: truncated,
          finishReason: summary && summary.finishReason,
          usage: summary && summary.usage,
        });
        if (summary && summary.aborted) addChip('已停止（本次循环剩余动作已丢弃）', 'warn');
      },
      onError(err) {
        cur.finish({ hasContent: true });     // 错误另行显示，别让 finish 再补一条"没正文"
        if (err.kind === 'no_key') {
          cur.setError('尚未配置 API Key，请点「设置」填写。');
          window.Settings.open();
        } else if (err.kind === 'auth') {
          cur.setError(err.message + '（点「设置」检查密钥）');
        } else {
          cur.setError('出错了：' + err.message);
        }
      },
    });

    stopBtn.classList.add('hidden');
    sendBtn.disabled = false;
    cur = null;
    return r;
  }

  // ---------------------------------------------------------------------------
  // 练习 / 演示 入口（由 question-engine / demo 模块驱动，未就绪时给出提示）
  // ---------------------------------------------------------------------------
  function startPractice() {
    if (!window.QuestionEngine) return addChip('练习模块尚未就绪', 'warn');
    // 无密钥时先说清原因再引导，避免"我点练习怎么弹出设置"的困惑
    if (!window.Settings.hasKey()) {
      addMsg('<span class="agent-err">练习需要模型支持（出题讲解与错因分析）。'
        + '请先在「设置」里填写你自己的 API Key（BYOK，本工具不提供额度）。</span>', 'assistant');
      const openBtn = document.querySelector('.agent-msg.assistant:last-of-type');
      return window.Settings.open();
    }
    window.QuestionEngine.startFlow();
  }
  function startDemo() {
    if (!window.DemoMode) return addChip('演示模块尚未就绪', 'warn');
    // 演示脚本是预置回放，**不消耗 token、也不需要密钥** —— 直接可用
    window.DemoMode.openPicker();
  }

  // ---------------------------------------------------------------------------
  // 演示分镜控制条（订阅 SceneBridge 的播放进度）
  //
  // 三种状态的显示逻辑：
  //   step    —— 第 i 步已执行完 → 显示这一步的旁白（学生对照刚看到的画面）
  //   waiting —— 停在闸门上 → 额外预告"下一步要做什么"，学生据此决定点不点
  //   auto    —— 连播中 → 收起「下一步 / 连播」，只留「停止」
  // ---------------------------------------------------------------------------
  let demoHideTimer = null;

  function setBarMode(m) {
    if (!demoBar) return;
    demoBar.classList.toggle('manual', m === 'manual');
    demoBar.classList.toggle('auto', m === 'auto');
    demoBar.classList.toggle('done', m === 'done');
    const isManual = (m === 'manual');
    const isDone = (m === 'done');
    demoPrev.classList.toggle('hidden', !(isManual || isDone));   // 结束后也能退回去重看
    demoNext.classList.toggle('hidden', !isManual);
    demoAuto.classList.toggle('hidden', !isManual);
    demoManual.classList.toggle('hidden', isManual || isDone);    // 连播态下唯一的出口
    demoStop.classList.toggle('hidden', isDone);
    demoReplay.classList.toggle('hidden', !isDone);
    demoDismiss.classList.toggle('hidden', !isDone);
  }

  function renderStep(evt) {
    if (!demoBar) return;
    clearTimeout(demoHideTimer);
    demoBar.classList.remove('hidden', 'bad');
    // 快进段（整改演示时把前面的步骤快速走一遍）在编号上标出来，否则学生会以为
    // 自己的演示被"跳着播"了
    demoIdx.textContent = (evt.fast ? '⚡快进 · 第 ' : '第 ')
      + evt.index + '/' + evt.total + ' 步' + (evt.ok === false ? '（未执行）' : '');
    demoText.textContent = evt.speech || evt.label;
    demoText.classList.toggle('muted', !evt.speech);
    if (evt.ok === false) demoBar.classList.add('bad');
    if (evt.manual === false) {
      setBarMode('auto');
    } else {
      setBarMode('manual');
      // 刚执行完这一步还没到闸门，此时不能回退（回退会与正在播放的动作打架）
      demoPrev.disabled = true;
    }
  }

  function renderWaiting(evt) {
    if (!demoBar) return;
    demoIdx.textContent = '已完成 ' + evt.index + '/' + evt.total + ' 步';
    setBarMode('manual');
    demoPrev.disabled = !evt.canPrev;
    const nx = evt.next || {};
    demoNextHint.classList.remove('hidden');
    // forced：整改后快进到位、特意停下来让学生看"这一步改成了什么样"
    demoNextHint.textContent = (evt.forced ? '整改后停在这一步 · 点「下一步」看变化：'
      : '下一步：') + (nx.speech || nx.label || '');
  }

  /** 退回上一步之后：显示"这一步还没执行"，预告即将重播的那一步 */
  function renderBack(evt) {
    if (!demoBar) return;
    demoBar.classList.remove('hidden', 'done', 'bad');
    demoIdx.textContent = '已退回 · 已完成 ' + evt.index + '/' + evt.total + ' 步';
    setBarMode('manual');
    demoPrev.disabled = !(evt.index > 0);
    const st = evt.step || {};
    demoText.textContent = st.speech || st.label || '（已回到上一步之前）';
    demoText.classList.toggle('muted', false);
    demoNextHint.classList.remove('hidden');
    demoNextHint.textContent = '下一步（重播）：' + (st.label || '');
  }

  function renderAuto(evt) {
    setBarMode('auto');
    demoIdx.textContent = '连续播放中 ' + evt.index + '/' + evt.total;
    demoNextHint.classList.add('hidden');
  }

  /** 连播中途按了「⏸ 逐步」：提示"下一步会停下来等你" */
  function renderManual(evt) {
    if (!demoBar) return;
    demoBar.classList.remove('hidden');
    setBarMode('manual');
    demoIdx.textContent = '已切到逐步 · 第 ' + (evt.index || 0) + '/' + evt.total + ' 步';
    demoPrev.disabled = true;                  // 当前这步正在播，还不能回退
    demoNextHint.classList.remove('hidden');
    demoNextHint.textContent = '当前这一步放完就会停下等你点「下一步」';
  }

  /** 队列被就地整改（reviseDemo 的 inplace 路径）后刷新控制条 */
  function renderRevised(evt) {
    if (!demoBar) return;
    demoBar.classList.remove('hidden', 'done');
    demoIdx.textContent = '已修改第 ' + ((evt.index || 0) + 1) + ' 步 · 共 ' + evt.total + ' 步';
    demoText.textContent = '改动已生效，下面的步骤保持不变';
    demoText.classList.add('muted');
    demoNextHint.classList.remove('hidden');
    const st = window.SceneBridge.state ? window.SceneBridge.state() : null;
    const nx = st && st.pending && st.pending[0];
    if (nx) demoNextHint.textContent = '下一步：' + (nx.speech || nx.action);
  }

  function renderQueued(evt) {
    if (!demoBar) return;
    demoBar.classList.remove('hidden');
    demoIdx.textContent = '已完成 ' + (evt.index || 0) + '/' + evt.total + ' 步 · 新增 ' + evt.added + ' 步';
    // 追加后"下一步"可能是刚入队的那一条，重新预告一次（否则预告会停留在旧的那条）
    const st = window.SceneBridge.state ? window.SceneBridge.state() : null;
    const nx = st && st.pending && st.pending[0];
    if (nx && demoBar.classList.contains('manual')) {
      demoNextHint.classList.remove('hidden');
      demoNextHint.textContent = '下一步：' + (nx.speech || nx.action);
    }
  }

  /** 播完：**不自动收起**，把「上一步 / 重新演示」留在手边 */
  function renderDone(evt) {
    if (!demoBar) return;
    clearTimeout(demoHideTimer);
    demoNextHint.classList.add('hidden');
    demoBar.classList.remove('hidden');
    setBarMode('done');
    demoPrev.disabled = !(evt.canPrev !== false && evt.total > 0);
    demoIdx.textContent = '演示完成';
    demoText.textContent = '共 ' + ((evt && evt.total) || 0) + ' 步 · 可重新演示，或退回去重看某一步';
    demoText.classList.add('muted');
  }

  function hideBar() {
    if (!demoBar) return;
    clearTimeout(demoHideTimer);
    demoNextHint.classList.add('hidden');
    demoBar.classList.add('hidden');
  }

  function bindSceneProgress() {
    if (!window.SceneBridge || !window.SceneBridge.onProgress) return;
    window.SceneBridge.onProgress((evt) => {
      if (!evt) return;
      switch (evt.phase) {
        case 'step':
          // 手动演示的第一帧就要让学生看见控制条，否则他会不知道要动手
          if (evt.manual !== false && !drawer.classList.contains('show')) open({ focus: false });
          renderStep(evt);
          break;
        case 'waiting': renderWaiting(evt); break;
        case 'back': renderBack(evt); break;
        case 'replay':
          clearTimeout(demoHideTimer);
          demoBar.classList.remove('hidden', 'done');
          demoIdx.textContent = (evt.reason === 'revise' ? '整改后重播' : '重新演示')
            + ' · 共 ' + evt.total + ' 步';
          demoText.textContent = (evt.fastForwardTo > 0)
            ? ('快速回放到第 ' + (evt.fastForwardTo + 1) + ' 步前，然后停在那里')
            : '从头开始';
          demoText.classList.add('muted');
          break;
        case 'fastforward':
          clearTimeout(demoHideTimer);
          demoBar.classList.remove('hidden');
          demoIdx.textContent = '快速回放中 → 第 ' + (evt.to + 1) + ' 步';
          demoText.textContent = '整改后正在把前面的步骤快速走一遍，到改动处会停下来';
          demoText.classList.add('muted');
          break;
        case 'manual': renderManual(evt); break;
        case 'auto': renderAuto(evt); break;
        case 'queued': renderQueued(evt); break;
        case 'revised': renderRevised(evt); break;
        case 'done': renderDone(evt); break;
        case 'stopped': hideBar(); break;
        default: break;
      }
    });
  }

  function init() {
    build();
    // ★ 恢复上次的对话：ConvStore 持有分支树与持久化，这里只负责"把它画出来"。
    //   build() 末尾已经显示过一次欢迎语，renderPath 会清空消息区重画（无害）。
    const S = window.ConvStore;
    if (S) {
      S.load();
      if (S.isEmpty()) renderEmptyState();
      else { renderPath(); refreshBranchBars(); }
    }
    bindSceneProgress();
    window.addEventListener('resize', () => {
      const r = fab.getBoundingClientRect();
      if (r.left > window.innerWidth - 20) snapToEdge();
    });
  }

  return { init, open, close, toggle, addMsg, addUser, addChip, addActionBubble, runAgent, markUnread, renderEmptyState, renderRich };
})();
