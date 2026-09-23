/**
 * demo-mode.js — 课堂演示模式（脚本回放，零 token）
 *
 * ★ 为什么演示回放不走 LLM：
 *   课堂上不能容忍"每点一次下一步就等模型 3 秒"。演示脚本在**首次生成时**由人/模型
 *   编排一次，之后存为脚本反复回放——既保证课堂流畅，也支撑"演示脚本可保存复用"
 *   这一推广卖点。
 *
 * 每个脚本 = 若干步，每步 = 一句讲解 + 一组受控动作。
 * 内置脚本的物理内容已核对（如 3d 的径向节点是 0 个而非 2 个）。
 */
window.DemoMode = (function () {
  'use strict';

  const SCRIPTS = {
    /* --------------------------------------------------------------- */
    nodeDistribution: {
      title: '同一层里，径向节点与角节点如何此消彼长',
      points: ['K5', 'K2'],
      steps: [
        {
          speech: '先看 3s。它是个球，没有方向性——说明角节点是 0 个。',
          actions: [
            { action: 'setQuantumNumbers', params: { n: 3, l: 0, m: 0 } },
            { action: 'setWavefunctionMode', params: { mode: 'real' } },
            { action: 'setRenderMode', params: { mode: 'surface' } },
            { action: 'setIsosurfaceLevel', params: { fraction: 0.08 } },
          ],
        },
        {
          speech: '把等值面阈值降下来——看到了吗？像套娃一样出现了内层壳。每两层之间就是一层**径向节点**。数一数：3s 有两层内壳，所以径向节点 2 个。',
          actions: [
            { action: 'setIsosurfaceLevel', params: { fraction: 0.012 } },
            { action: 'spotlightNodes', params: { type: 'radial', on: true } },
          ],
        },
        {
          speech: '换到 3p。它变成哑铃形了——有方向性，说明出现了角节点。同时看看内层壳：只剩一层了。',
          actions: [
            { action: 'spotlightNodes', params: { type: 'radial', on: false } },
            { action: 'setQuantumNumbers', params: { n: 3, l: 1, m: 0 } },
            { action: 'setIsosurfaceLevel', params: { fraction: 0.05 } },
          ],
        },
        {
          speech: '再到 3d。形状更复杂（四叶草/双瓣加环），角节点更多了；但内层壳——没有了。',
          actions: [
            { action: 'setQuantumNumbers', params: { n: 3, l: 2, m: 0 } },
            { action: 'setIsosurfaceLevel', params: { fraction: 0.10 } },
          ],
        },
        {
          speech: '把径向分布函数画出来，让"D(r) 的零点"直接可见——那就是径向节点。',
          actions: [
            { action: 'showRadial', params: { which: ['D'] } },
            { action: 'highlightRadialFeature', params: { target: 'D', feature: 'zeros' } },
          ],
        },
        {
          speech: '小结：3s（径向 2 + 角 0）、3p（径向 1 + 角 1）、3d（径向 0 + 角 2）——**总数恒为 n−1 = 2**。这就是"同一层里 l 越大，径向节点越少、角节点越多"的来源。',
          actions: [
            { action: 'setAutoRotate', params: { on: false } },
          ],
        },
      ],
    },

    /* --------------------------------------------------------------- */
    rVsD: {
      title: 'R(r) 与 D(r)：为什么峰值不在同一个地方',
      points: ['K3'],
      steps: [
        {
          speech: '先看 1s 的径向波函数 R(r)——它在 r=0 处最大，随半径单调下降。',
          actions: [
            { action: 'setQuantumNumbers', params: { n: 1, l: 0, m: 0 } },
            { action: 'showRadial', params: { which: ['R'] } },
          ],
        },
        {
          speech: '现在把 D(r) = r²R(r)² 也画上。注意峰值位置变了——D 的峰在 r = 1 a₀，不是 0。',
          actions: [
            { action: 'showRadial', params: { which: ['R', 'D'] } },
            { action: 'highlightRadialFeature', params: { target: 'D', feature: 'peak' } },
          ],
        },
        {
          speech: '我把这个半径对应的一层"球壳"在三维里标出来——径向图上的一个横坐标，对应的就是三维里的一层壳。',
          actions: [
            { action: 'setRenderMode', params: { mode: 'points' } },
            { action: 'linkRadialTo3D', params: { radius: 1 } },
            { action: 'setAutoRotate', params: { on: true } },
          ],
        },
        {
          speech: '为什么差一个 r²？因为"概率密度"要乘以球壳的体积才有"概率"的意义，而球壳体积 ∝ r²。原点处密度虽然最大，但那一层几乎不占体积。',
          actions: [
            { action: 'setAutoRotate', params: { on: false } },
            // 演示结束顺手撤掉参考球：辅助几何用完不收，会把画面一直弄脏
            { action: 'linkRadialTo3D', params: { radius: 0 } },
          ],
        },
      ],
    },

    /* --------------------------------------------------------------- */
    complexReal: {
      title: '实轨道与复轨道：同一个能量，两种长相',
      points: ['K6', 'K7'],
      steps: [
        {
          speech: '先看复函数下的 2p（m=+1）。密度是一个绕 z 轴的环——为什么是环？因为 |e^{imφ}|=1，相位取模后消失了，密度与 φ 无关。',
          actions: [
            { action: 'setQuantumNumbers', params: { n: 2, l: 1, m: 1 } },
            { action: 'setWavefunctionMode', params: { mode: 'complex' } },
            { action: 'setColorMode', params: { mode: 'orbital' } },
            { action: 'setRenderMode', params: { mode: 'surface' } },
            { action: 'setAutoRotate', params: { on: true } },
          ],
        },
        {
          speech: '打开相位着色——绕一圈，彩虹正好走完一周，这就是相位缠绕（arg = mφ）。',
          actions: [
            { action: 'setColorMode', params: { mode: 'phase' } },
          ],
        },
        {
          speech: '现在切回实函数。环变成了两个定向的瓣——变成 p_x。注意：**能量没有变**。',
          actions: [
            { action: 'setAutoRotate', params: { on: false } },
            { action: 'setWavefunctionMode', params: { mode: 'real' } },
            { action: 'setColorMode', params: { mode: 'orbital' } },
          ],
        },
        {
          speech: '既然能量一样（简并），它们的任意线性组合就还是同一能量的状态。所以"实轨道是复轨道的线性组合"——它们不是两种不同的物理，而是同一空间的两组基底。',
          actions: [
            { action: 'setCameraView', params: {} },
          ],
        },
      ],
    },
  };

  let playing = null, idx = 0, bar = null;

  function el(tag, attrs, kids) {
    const e = document.createElement(tag);
    if (attrs) for (const k of Object.keys(attrs)) {
      if (k === 'class') e.className = attrs[k];
      else if (k === 'text') e.textContent = attrs[k];
      else if (k === 'html') e.innerHTML = attrs[k];
      else e.setAttribute(k, attrs[k]);
    }
    (kids || []).forEach((c) => e.appendChild(c));
    return e;
  }

  /** 演示控制条 */
  function ensureBar() {
    if (bar) return bar;
    bar = el('div', { class: 'demo-bar hidden' });
    const title = el('span', { class: 'demo-title', text: '' });
    const prev = el('button', { class: 'agent-tbtn', text: '← 上一步' });
    const next = el('button', { class: 'agent-tbtn primary', text: '下一步 →' });
    const stop = el('button', { class: 'agent-tbtn', text: '停止' });
    const prog = el('span', { class: 'demo-prog', text: '' });
    prev.onclick = () => step(-1);
    next.onclick = () => step(1);
    stop.onclick = () => exit();
    bar.appendChild(title);
    bar.appendChild(prog);
    bar.appendChild(prev);
    bar.appendChild(next);
    bar.appendChild(stop);
    bar._title = title; bar._prog = prog;
    document.body.appendChild(bar);
    return bar;
  }

  function openPicker() {
    const P = window.Panel;
    let html = '<b>选择演示脚本</b>（回放不消耗 token）<div class="agent-picker">';
    Object.keys(SCRIPTS).forEach((k) => {
      html += '<button class="agent-pick-btn" data-s="' + k + '">' + SCRIPTS[k].title + '</button>';
    });
    html += '</div>';
    P.addMsg(html, 'assistant');
    document.querySelectorAll('.agent-pick-btn').forEach((b) => {
      b.onclick = () => {
        document.querySelectorAll('.agent-pick-btn').forEach((x) => { x.disabled = true; });
        play(b.getAttribute('data-s'));
      };
    });
  }

  function play(scriptId) {
    const s = SCRIPTS[scriptId];
    if (!s) return { error: '脚本不存在' };
    playing = s; playing._id = scriptId; idx = -1;
    const b = ensureBar();
    b.classList.remove('show', 'hidden');
    b.classList.add('show');
    b._title.textContent = '演示：' + s.title;
    window.Panel.addChip('已进入演示模式（点「下一步」逐级播放，不消耗 token）');
    step(1);
    return { ok: true, total: s.steps.length };
  }

  async function step(dir) {
    if (!playing) return;
    const n = playing.steps.length;
    const ni = idx + dir;
    if (ni < 0) return;
    if (ni >= n) { finish(); return; }        // 走完最后一步 → 给出重播入口
    idx = ni;
    const st = playing.steps[idx];
    if (dir > 0 && st.speech) window.Panel.addMsg(window.Panel.renderRich(st.speech), 'assistant');
    if (st.actions && st.actions.length) {
      // auto:true —— 演示者在**脚本层面**已经点过「下一步」了，脚本内部的子动作
      // 应当连贯播完，不再逐个等他确认（否则每一步要点两次）
      await window.SceneBridge.applySequence(st.actions, { auto: true });
    }
    if (bar) bar._prog.textContent = (idx + 1) + ' / ' + n;
    return { idx: idx, total: n };
  }

  /** 演示结束：提供「重新播放」，而不是直接消失 */
  function finish() {
    const id = playing && playing._id;
    const P = window.Panel;
    if (P) {
      const card = P.addMsg(
        '<div class="demo-end">演示已结束' +
        '<button class="agent-btn primary demo-replay">↻ 重新播放</button>' +
        '<button class="agent-btn demo-close">关闭</button></div>', 'assistant');
      const rp = card.querySelector('.demo-replay');
      if (rp) rp.onclick = function () {
        rp.disabled = true;
        if (id) play(id); else exit();
      };
      const cl = card.querySelector('.demo-close');
      if (cl) cl.onclick = function () { card.classList.add('fade'); setTimeout(function () { if (card.parentNode) card.parentNode.removeChild(card); }, 200); };
    }
    playing = null; idx = 0;
    if (bar) bar.classList.remove('show');
    if (window.SceneBridge) window.SceneBridge.stop();
    return { finished: true, replay: id };
  }

  function exit() {
    playing = null; idx = 0;
    if (bar) bar.classList.remove('show');
    if (window.SceneBridge) window.SceneBridge.stop();
  }

  function list() { return Object.keys(SCRIPTS).map((k) => ({ id: k, title: SCRIPTS[k].title, points: SCRIPTS[k].points })); }

  return { openPicker, play, step, exit, list, SCRIPTS, isPlaying: () => !!playing };
})();
