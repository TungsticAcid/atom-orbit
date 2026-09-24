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
  let demoPrev, demoNext, demoAuto, demoStop, demoReplay, demoDismiss;

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
    demoStop = mkAct('■ 停止', () => window.SceneBridge.stop(), 'stop');
    demoReplay = mkAct('↻ 重新演示', () => window.SceneBridge.replay(), 'primary');
    demoDismiss = mkAct('结束', () => window.SceneBridge.stop());
    [demoPrev, demoNext, demoAuto, demoStop, demoReplay, demoDismiss].forEach((b) => demoBtns.appendChild(b));
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
  function addMsg(html, cls) {
    const m = el('div', { class: 'agent-msg ' + (cls || '') , html: html });
    msgBox.appendChild(m);
    scrollDown();
    return m;
  }
  function scrollDown() { msgBox.scrollTop = msgBox.scrollHeight; }

  function addUser(text) { addMsg(escapeHtml(text), 'user'); }

  /** 助手消息：思考折叠 + 流式正文 */
  function beginAssistant() {
    const wrap = el('div', { class: 'agent-msg assistant' });
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

    const lines = acts.map((a) => describeAction(a.action, a.params || a));
    d.appendChild(el('summary', {
      html: '<span class="agent-act-dot"></span>' + escapeHtml(lines[0]) +
        (lines.length > 1 ? '<span class="agent-act-more">等 ' + lines.length + ' 个动作</span>' : ''),
    }));
    const body = el('div', { class: 'agent-act-body' });
    body.textContent = lines.join('\n') +
      (result ? '\n\n返回：' + JSON.stringify(result).slice(0, 400) : '');
    d.appendChild(body);
    msgBox.appendChild(d);
    scrollDown();
    return d;
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
    addUser(text);
    await runAgent(text);
  }

  async function runAgent(userText) {
    cur = beginAssistant();
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
        if (info.name !== 'applySceneActions' || !lastBubble) return;
        const failed = info.result && info.result.failed;
        if (failed && failed.length) {
          lastBubble.classList.add('bad');
          const s = lastBubble.querySelector('summary');
          if (s) s.insertAdjacentHTML('beforeend',
            '<span class="agent-act-err">· ' + failed.length + ' 个动作未执行</span>');
        }
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
    demoStop.classList.toggle('hidden', isDone);
    demoReplay.classList.toggle('hidden', !isDone);
    demoDismiss.classList.toggle('hidden', !isDone);
  }

  function renderStep(evt) {
    if (!demoBar) return;
    clearTimeout(demoHideTimer);
    demoBar.classList.remove('hidden', 'bad');
    demoIdx.textContent = '第 ' + evt.index + '/' + evt.total + ' 步' + (evt.ok === false ? '（未执行）' : '');
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
    demoNextHint.textContent = '下一步：' + (nx.speech || nx.label || '');
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
          demoIdx.textContent = '重新演示 · 共 ' + evt.total + ' 步';
          demoText.textContent = '从头开始';
          demoText.classList.add('muted');
          break;
        case 'auto': renderAuto(evt); break;
        case 'queued': renderQueued(evt); break;
        case 'done': renderDone(evt); break;
        case 'stopped': hideBar(); break;
        default: break;
      }
    });
  }

  function init() {
    build();
    bindSceneProgress();
    window.addEventListener('resize', () => {
      const r = fab.getBoundingClientRect();
      if (r.left > window.innerWidth - 20) snapToEdge();
    });
  }

  return { init, open, close, toggle, addMsg, addUser, addChip, addActionBubble, runAgent, markUnread, renderEmptyState, renderRich };
})();
