/**
 * state-editor.js — 量子态编辑器（叠加态 / 杂化 / 力学量）
 *
 * 定位：**辅助功能**。按实施计划 §8.6 的「主打优先」原则：
 *   · 收在首页的「进阶」折叠区，**默认收起**，展开才占空间
 *   · 视觉权重低于主打功能
 *   · 智能体可在讲解叠加态时**主动展开并填入预设**
 *
 * ★ 教学要点：叠加态 |ψ|² 中的**干涉项**是它与"概率简单相加"的本质区别；
 *   而**简并态的线性组合仍是定态**——这正是"实轨道 = 复轨道组合"的一般化。
 */
window.StateEditor = (function () {
  'use strict';

  const S = 1 / Math.sqrt(2), S3 = 1 / Math.sqrt(3), S23 = Math.sqrt(2 / 3);

  // ---------------------------------------------------------------------------
  // 预设（标签不带括号说明，说明改放到 note 里）
  // ---------------------------------------------------------------------------
  const PRESETS = {
    pure: {
      label: '纯态 ψ(n,l,m)',
      terms: [],
      note: '单一本征态（定态）。叠加态编辑器的"原点"——任何时候都可回到这里。',
    },
    '2ψ3dz²+3ψ3dxy': {
      label: '2ψ₃dz² + 3ψ₃dxy',
      terms: [
        { n: 3, l: 2, m: 0, mode: 'real', c: { re: 2 / Math.sqrt(13), im: 0 } },
        { n: 3, l: 2, m: 2, mode: 'real', c: { re: 3 / Math.sqrt(13), im: 0 } },
      ],
      note: '同 n 同 l → 能量**简并** → 组合态**仍是定态**：密度是静态干涉图样，不随时间变化。',
    },
    'ψ1s+ψ2s': {
      label: 'ψ₁ₛ + ψ₂ₛ',
      terms: [
        { n: 1, l: 0, m: 0, mode: 'real', c: { re: S, im: 0 } },
        { n: 2, l: 0, m: 0, mode: 'real', c: { re: S, im: 0 } },
      ],
      note: '能量**不同** → 非定态：密度随时间"呼吸"。★ 动画参数是**相对相位**而非真实时间（ΔE≈10.2 eV ⇒ ν≈2.5×10¹⁵ Hz，不可视化）。',
    },
    'ψ2pz+ψ2px': {
      label: 'ψ₂pz + ψ₂px',
      terms: [
        { n: 2, l: 1, m: 0, mode: 'real', c: { re: S, im: 0 } },
        { n: 2, l: 1, m: 1, mode: 'real', c: { re: S, im: 0 } },
      ],
      note: '同 n 同 l → 简并 → 定态。两个正交的 p 轨道组合出**斜向的瓣**——杂化轨道的雏形。',
    },
    // ★ sp³ 的 4 个等价杂化轨道：s 系数恒为 +½，三个 p 取正四面体的四个方向
    'sp3-1': {
      label: 'sp³-1', terms: sp3(1, 1, 1), hybrid: true,
      note: '$\\psi = \\frac{1}{2}(s + p_x + p_y + p_z)$。四个 sp³ 完全等价，指向**正四面体**，两两夹角 109.5°。',
    },
    'sp3-2': {
      label: 'sp³-2', terms: sp3(1, -1, -1), hybrid: true,
      note: '$\\psi = \\frac{1}{2}(s + p_x - p_y - p_z)$。与 sp³-1 等价且正交，指向另一个顶点。',
    },
    'sp3-3': {
      label: 'sp³-3', terms: sp3(-1, 1, -1), hybrid: true,
      note: '$\\psi = \\frac{1}{2}(s - p_x + p_y - p_z)$。与 sp³-1 等价且正交，指向第三个顶点。',
    },
    'sp3-4': {
      label: 'sp³-4', terms: sp3(-1, -1, 1), hybrid: true,
      note: '$\\psi = \\frac{1}{2}(s - p_x - p_y + p_z)$。与 sp³-1 等价且正交，指向第四个顶点。',
    },
    // sp²：三个轨道共面、两两 120°（只给一个看不出"共面"，故给全）
    'sp2-1': {
      label: 'sp²-1', terms: sp2(0), hybrid: true,
      note: '$\\psi = \\frac{1}{\\sqrt{3}}\\,s + \\sqrt{\\frac{2}{3}}\\,p_x$。三个等价轨道之一，**120° 共面**。',
    },
    'sp2-2': {
      label: 'sp²-2', terms: sp2(1), hybrid: true,
      note: '$\\psi = \\frac{1}{\\sqrt{3}}\\,s - \\frac{1}{\\sqrt{6}}\\,p_x + \\frac{1}{\\sqrt{2}}\\,p_y$。由 sp²-1 绕 $z$ 轴转 120° 得到。',
    },
    'sp2-3': {
      label: 'sp²-3', terms: sp2(2), hybrid: true,
      note: '$\\psi = \\frac{1}{\\sqrt{3}}\\,s - \\frac{1}{\\sqrt{6}}\\,p_x - \\frac{1}{\\sqrt{2}}\\,p_y$。由 sp²-1 绕 $z$ 轴转 240° 得到。',
    },
    'sp-1': {
      label: 'sp-1', terms: sp(1), hybrid: true,
      note: '$\\psi = \\frac{1}{\\sqrt{2}}(s + p_z)$。两个等价轨道之一，**180°** 直线型。',
    },
    'sp-2': {
      label: 'sp-2', terms: sp(-1), hybrid: true,
      note: '$\\psi = \\frac{1}{\\sqrt{2}}(s - p_z)$。另一个 sp 轨道，与 sp-1 正交、恰好反向。',
    },
  };

  // ---------------------------------------------------------------------------
  // 杂化轨道的**隐藏开关**（用户第 9 条："先隐藏掉杂化轨道功能，其中暂时有不少问题。
  // 包括智能体，暂不提供该接口，之后再更新。"）
  //
  // ★ 做法是**标记 + 过滤**，不是物理删除：9 个杂化预设仍留在 PRESETS 里（连
  //   sp3/sp2/sp 三个生成器一起），日后要恢复只需把过滤撤掉。
  //
  // ★ 过滤必须**三处同时**做，少一处就等于没藏住：
  //   ① render()      —— 界面不列按钮
  //   ② matchPreset() —— 免得残留的 state.preset 匹配到一个看不见的预设
  //   ③ scene-bridge 的 listActions()（经 visibleKeys 取 availableKeys）——
  //      这是最容易漏的一处：只藏界面的话，模型仍能从工具清单里读到 'sp-1'
  //      并照着调 loadPreset，validate 也会放行。
  // ---------------------------------------------------------------------------

  /** 是否为杂化预设（sp / sp² / sp³ 共 9 个） */
  function isHybrid(p) {
    return !!(p && p.hybrid);
  }

  /**
   * 内置预设里**当前可见**的键。界面按钮、预设匹配、智能体工具清单**都从这里取** ——
   * 单一出口，避免"藏了界面、漏了接口"。
   */
  function visibleKeys() {
    return Object.keys(PRESETS).filter(function (k) { return !isHybrid(PRESETS[k]); });
  }

  /**
   * 生成一个 sp³ 杂化轨道：ψ = ½(s + sₓ·p_x + s_y·p_y + s_z·p_z)。
   *
   * ★ s 的系数**恒为 +½**，只有三个 p 的符号在变。这是正四面体四个方向的正确构造：
   *   p 矢量取 (1,1,1)、(1,−1,−1)、(−1,1,−1)、(−1,−1,1) 时，四个杂化轨道两两正交
   *   （⟨hᵢ|hⱼ⟩ = ¼(1 + dᵢ·dⱼ) = 0，因为 dᵢ·dⱼ = −1），大瓣夹角 109.47°。
   *
   *   若让 s 也跟着翻符号（这里原先就是如此），会出两个错：① 四个轨道不再正交；
   *   ② 大瓣方向由"s 与 p 的相对符号"决定，s 一翻号，大瓣就偏到正四面体之外的
   *   方向去了。而提示文字写的却是正确公式——界面上说的和画出来的对不上，
   *   这种"注释对了、代码错了"的错最难发现。
   */
  function sp3(sx, sy, sz) {
    const h = 0.5;
    return [
      { n: 2, l: 0, m: 0, mode: 'real', c: { re: h, im: 0 } },          // s：四个轨道完全一致
      { n: 2, l: 1, m: 0, mode: 'real', c: { re: h * sz, im: 0 } },     // p_z（m=0）
      { n: 2, l: 1, m: 1, mode: 'real', c: { re: h * sx, im: 0 } },     // p_x（m=+1）
      { n: 2, l: 1, m: -1, mode: 'real', c: { re: h * sy, im: 0 } },    // p_y（m=−1）
    ];
  }

  /**
   * 生成第 index 个 sp² 杂化轨道（index = 0/1/2）：
   *   ψ = (1/√3)s + √(2/3)(cosθ·p_x + sinθ·p_y)，θ = index × 120°。
   * 三个轨道共面、两两 120°，且两两正交。
   */
  function sp2(index) {
    const th = index * 2 * Math.PI / 3;
    return [
      { n: 2, l: 0, m: 0, mode: 'real', c: { re: S3, im: 0 } },
      { n: 2, l: 1, m: 1, mode: 'real', c: { re: S23 * Math.cos(th), im: 0 } },
      { n: 2, l: 1, m: -1, mode: 'real', c: { re: S23 * Math.sin(th), im: 0 } },
    ];
  }

  /** 生成一个 sp 杂化轨道：ψ = (1/√2)(s + sz·p_z)，sz = ±1 得到方向相反的两个 */
  function sp(sz) {
    return [
      { n: 2, l: 0, m: 0, mode: 'real', c: { re: S, im: 0 } },
      { n: 2, l: 1, m: 0, mode: 'real', c: { re: S * sz, im: 0 } },
    ];
  }

  /** 相对相位的推荐值（以 π 为单位）——0 / π/2 / π / 3π/2 是化学上最常用的四档 */
  const PHASE_PRESETS = [0, 0.5, 1, 1.5];

  // ---------------------------------------------------------------------------
  // 自定义预设（用户 / 智能体可增删）
  //
  // ★ 为什么需要：内置预设表达不了"不等性杂化"这类系数不等的组合。学生问到时，
  //   智能体可以现场构造出示意系数，但**对话一过就没了**——下次还得重来一遍。
  //   把它存成预设，就变成面板上一个可复现的按钮：既省掉重复劳动，
  //   也让"这组示意系数"变成全班可以一起被指着讲的固定教具。
  // ---------------------------------------------------------------------------
  const CUSTOM_KEY = 'orbit.statePresets';

  let host = null;
  let state = { terms: [], relPhase: 0, preset: 'pure' };
  let dragging = false;

  /**
   * 预设说明的轻量标记转换（note 是用 innerHTML 渲染的）。
   *   · `$...$` 行内公式 → **KaTeX**：公式就该是公式，而不是 "(1/√3)s − (1/√6)p_x" 这样的
   *     纯文本；这是与 panel.js 的 renderRich 同一套约定，作者只需写 LaTeX。
   *   · `**加粗**` → <b>（不转就会原样显示星号）
   *   · `p_x` / `d_{xz}` → <sub>（兜底：万一某处没写成 $...$，也不至于露出下划线）
   *
   * ★ 先公式、后其余：KaTeX 的输出本身就是 HTML，若放在后面做，加粗与下标两条正则
   *   会去动它生成的标签属性。故照 renderRich 的做法先把公式摘成占位符，最后再换回来。
   */
  function mdInline(s) {
    let out = String(s == null ? '' : s);
    const forms = [];
    out = out.replace(/\$([^$\n]+?)\$/g, function (m, tex) {
      forms.push(tex);
      return '\u0002' + (forms.length - 1) + '\u0002';
    });
    out = out
      .replace(/\*\*([^*]+?)\*\*/g, '<b>$1</b>')
      .replace(/([spd])_\{([^}]+)\}/g, '$1<sub>$2</sub>')
      .replace(/([spd])_([xyz])/g, '$1<sub>$2</sub>');
    return out.replace(/\u0002(\d+)\u0002/g, function (m, i) {
      const tex = forms[+i];
      try {
        if (window.katex) {
          return window.katex.renderToString(tex, {
            throwOnError: false, displayMode: false, output: 'html', trust: true,
          });
        }
      } catch (e) { /* 降级为原文 */ }
      return '$' + tex + '$';
    });
  }

  /** 从 localStorage 把自定义预设并回 PRESETS（键统一带 u- 前缀，不与内置冲突） */
  function loadCustomPresets() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(CUSTOM_KEY) || '{}') || {}; } catch (e) { saved = {}; }
    Object.keys(saved).forEach(function (k) {
      const p = saved[k];
      if (!p || !Array.isArray(p.terms) || !p.terms.length) return;
      PRESETS[k] = { label: p.label || k, terms: p.terms, note: p.note || '', custom: true };
    });
  }

  function persistCustomPresets() {
    const out = {};
    Object.keys(PRESETS).forEach(function (k) {
      if (PRESETS[k].custom) out[k] = { label: PRESETS[k].label, terms: PRESETS[k].terms, note: PRESETS[k].note };
    });
    try { localStorage.setItem(CUSTOM_KEY, JSON.stringify(out)); } catch (e) { /* 隐私模式可能禁用 */ }
  }

  /** 深拷贝 terms：存进预设后，之后再改系数不应把预设本身也改掉 */
  function cloneTerms(list) {
    return (list || []).map(function (t) {
      return { n: t.n, l: t.l, m: t.m, mode: t.mode || 'real', c: { re: t.c.re, im: t.c.im || 0 } };
    });
  }

  /**
   * 新增一个自定义预设。
   * @param {string} label 显示在按钮上的名字
   * @param {Array}  terms 叠加态分量（缺省用编辑器当前组合）
   * @param {string} [note] 说明
   * @param {string} [key]  指定键（缺省自动生成）
   */
  function addPreset(label, terms, note, key) {
    const list = cloneTerms(terms && terms.length ? terms : state.terms);
    if (!list.length) return { error: '当前没有叠加态分量，无法存为预设' };
    const k = key || ('u-' + Date.now().toString(36) + Math.floor(Math.random() * 1e3).toString(36));
    PRESETS[k] = { label: String(label || '自定义态'), terms: list, note: note || '', custom: true };
    persistCustomPresets();
    render();
    return { ok: true, key: k, label: PRESETS[k].label, terms: list.length };
  }

  function removePreset(key) {
    if (!PRESETS[key]) return { error: '未找到预设：' + key };
    if (!PRESETS[key].custom) return { error: '内置预设不可删除（只允许删自定义预设）' };
    delete PRESETS[key];
    if (state.preset === key) state.preset = 'pure';
    persistCustomPresets();
    render();
    return { ok: true, removed: key };
  }

  /** 键 → 是否自定义（供 scene-bridge 判断能否删除） */
  function isCustom(key) { return !!(PRESETS[key] && PRESETS[key].custom); }

  loadCustomPresets();

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

  // ---------------------------------------------------------------------------
  // 渲染
  // ---------------------------------------------------------------------------
  function render() {
    if (!host) return;
    host.innerHTML = '';

    // 预设
    const row = el('div', { class: 'se-presets' });
    // ★ visibleKeys()：杂化预设已隐藏（见文件上方"隐藏开关"的说明），不列按钮
    visibleKeys().forEach(function (k) {
      const p = PRESETS[k];
      const wrap = el('span', { class: 'se-chipwrap' });
      const b = el('button', {
        class: 'se-chip' + (state.preset === k ? ' on' : '') + (p.custom ? ' custom' : ''),
        text: p.label,
        title: p.custom ? '自定义预设（点右侧 ✕ 可删除）' : '',
      });
      b.onclick = function () { applyPreset(k); };
      wrap.appendChild(b);
      // 自定义预设才带删除按钮：内置的是教学内容，不该被误删
      if (p.custom) {
        const del = el('button', { class: 'se-chipdel', text: '✕', title: '删除「' + p.label + '」' });
        del.onclick = function (ev) {
          if (ev) ev.stopPropagation();
          removePreset(k);
        };
        wrap.appendChild(del);
      }
      row.appendChild(wrap);
    });
    // ＋ 把当前组合存成预设：让"现场凑出来的系数"能留下来复用
    const addBtn = el('button', { class: 'se-chip se-addchip', text: '＋ 存为预设', title: '把当前叠加态存成一个按钮' });
    addBtn.onclick = function () { beginSavePreset(addBtn); };
    row.appendChild(addBtn);
    host.appendChild(row);

    if (state.preset && PRESETS[state.preset] && PRESETS[state.preset].note) {
      host.appendChild(el('div', { class: 'se-note', html: mdInline(PRESETS[state.preset].note) }));
    }

    if (!state.terms.length) {
      host.appendChild(el('div', { class: 'se-empty', text:
        '当前为单一本征态 ψ(n,l,m)，用上方量子数滑块调节。选一个预设即可进入叠加态。' }));
      renderObs();
      return;
    }

    // 组分表（**带表头**：纵向这几个数字框各是什么，原先完全没说明）
    const list = el('div', { class: 'se-list' });
    const head = el('div', { class: 'se-term se-head' });
    head.appendChild(el('span', { class: 'se-idx', text: '#' }));
    [['n', '主量子数 n'], ['l', '角量子数 l']].forEach(function (kv) {
      head.appendChild(el('span', { class: 'se-hcol', text: kv[0], title: kv[1] }));
    });
    head.appendChild(el('span', { class: 'se-hcol se-hcol-mode', text: '解型',
      title: '该分量取波函数的实数解还是复数解。**逐项可选** —— 所以"全实""全复""实复混合"三种都表达得出来。' }));
    head.appendChild(el('span', { class: 'se-hcol se-hcol-pick', text: '轨道 / m',
      title: '复数解用磁量子数 m 标记（m 是 L̂z 的本征值指标，对它才有意义）；'
        + '实数解用实轨道名标记（实解不是 L̂z 的本征函数，m 对它没有意义）。' }));
    head.appendChild(el('span', { class: 'se-hcol se-hcol-c', text: 'c',
      title: '该分量的系数（本模块只填正实数；虚部与项间相位用下面的「相对相位」表达）' }));
    list.appendChild(head);
    state.terms.forEach(function (t, i) {
      const md = t.mode || 'real';
      const r = el('div', { class: 'se-term' });
      r.appendChild(el('span', { class: 'se-idx', text: String(i + 1) }));
      ['n', 'l'].forEach(function (key) {
        const inp = el('input', { class: 'se-num', type: 'number', value: String(t[key]), title: key });
        inp.onchange = function () {
          const v = parseInt(inp.value, 10);
          if (!Number.isFinite(v)) return;
          t[key] = v;
          t.n = Math.max(1, Math.min(6, t.n));
          t.l = Math.max(0, Math.min(t.n - 1, t.l));
          t.m = Math.max(-t.l, Math.min(t.l, t.m));
          push(false);
        };
        r.appendChild(inp);
      });
      // ★ 第 4 条：**逐项**可选实/复。
      //   实解不是 L̂z 的本征函数，所以对实项来说 m 只是个内部索引 —— 界面上就不给它看，
      //   换成实轨道名（p_x、d_xy…；l≥4 没有通名，用直角坐标多项式，见 formula.js）。
      const mb = el('button', { class: 'se-mode' + (md === 'complex' ? ' cx' : ''), text: md === 'complex' ? '复' : '实' });
      mb.title = (md === 'complex')
        ? '该分量为**复数解**（L̂z 的本征函数，用 m 标记）—— 点击改为实数解'
        : '该分量为**实数解**（不是 L̂z 的本征函数，用实轨道名标记）—— 点击改为复数解';
      mb.onclick = function () { t.mode = (md === 'complex') ? 'real' : 'complex'; push(false); };
      r.appendChild(mb);
      // 标记：复解给 m 下拉；实解给实轨道下拉（两者都直接写回同一个 t.m）
      const sel = el('select', { class: 'se-pick' });
      const order = [0];
      for (let mm = 1; mm <= t.l; mm++) order.push(mm, -mm);
      order.forEach(function (mm) {
        const label = (md === 'complex')
          ? ('m = ' + (mm > 0 ? '+' + mm : mm))
          : ((window.Formula && window.Formula.realOrbitalLabelPlain)
              ? window.Formula.realOrbitalLabelPlain(t.l, mm) : String(mm));
        sel.appendChild(el('option', { value: String(mm), text: label }));
      });
      sel.value = String(t.m);
      sel.title = (md === 'complex') ? '磁量子数 m' : '实轨道（该支壳层的 ' + order.length + ' 个实轨道之一）';
      sel.onchange = function () { t.m = parseInt(sel.value, 10); push(false); };
      r.appendChild(sel);
      const amp = el('input', { class: 'se-amp', type: 'number', step: '0.1', value: t.c.re.toFixed(2), title: '系数' });
      amp.onchange = function () {
        const v = Number(amp.value);
        if (!Number.isFinite(v)) return;
        t.c.re = v; t.c.im = 0;
        push(false);
      };
      r.appendChild(amp);
      const del = el('button', { class: 'se-del', text: '✕' });
      del.onclick = function () { state.terms.splice(i, 1); push(false); };
      r.appendChild(del);
      list.appendChild(r);
    });
    host.appendChild(list);
    // ★ 必须解释"为什么我填 0.35、它显示 0.37"：归一化会按比例缩放**全部**系数，
    //   所以任何单项的绝对值都只是"相对大小"。不写清楚，学生会以为工具算错了。
    // ★ 这里必须过 mdInline：`$...$` 要经 KaTeX 才成公式，**加粗** 才成粗体。
    //   原先直接塞 html，屏幕上显示的就是字面的 $\sum_i |c_i|^2 = 1$ 与两个星号。
    host.appendChild(el('div', { class: 'se-hint', html: mdInline(
      '系数按 $\\sum_i |c_i|^2 = 1$ **等比归一化**（本程序基组正交归一，故只需这一条），'
      + '因此**只有比值有物理意义**：把某项填成 0.35，落库可能是 0.37（其余项会同比例缩放），'
      + '这是归一化的必然结果。' ) }));

    const addRow = el('div', { class: 'se-addrow' });
    const add = el('button', { class: 'se-btn', text: '+ 添加态' });
    add.onclick = function () {
      const last = state.terms[state.terms.length - 1] || { n: 3, l: 2, m: 0, mode: 'real' };
      // ★ 沿用上一项的**解型**：混着编的时候（一个实项一个复项）不该每次都被拽回实解
      state.terms.push({ n: last.n, l: last.l, m: last.m, mode: last.mode || 'real', c: { re: 0.5, im: 0 } });
      push(false);
    };
    addRow.appendChild(add);
    host.appendChild(addRow);

    // ---- 相对相位：推荐值 + 手动输入 ----
    host.appendChild(el('div', { class: 'se-phrow-title', text: '相对相位 φ（单位 π）' }));
    const phRow = el('div', { class: 'se-phrow' });
    PHASE_PRESETS.forEach(function (v) {
      const on = Math.abs(state.relPhase - v * Math.PI) < 1e-6;
      const b = el('button', { class: 'se-chip' + (on ? ' on' : ''), text: (v === 0 ? '0' : v === 1 ? 'π' : v + 'π') });
      b.onclick = function () { state.relPhase = v * Math.PI; push(false); };
      phRow.appendChild(b);
    });
    const phNum = el('input', {
      class: 'se-phnum', type: 'number', step: '0.1', min: '0', max: '2',
      value: (state.relPhase / Math.PI).toFixed(2), title: '手动输入（单位 π，0–2）',
    });
    phNum.onchange = function () {
      let v = Number(phNum.value);
      if (!Number.isFinite(v)) return;
      v = Math.max(0, Math.min(2, v));
      state.relPhase = v * Math.PI;
      push(false);
    };
    phRow.appendChild(phNum);
    host.appendChild(phRow);

    // 拖拽条：拖动时用低分辨率预览，松手后回到全分辨率（否则每帧重建等值面会卡）
    const slider = el('input', {
      class: 'se-phase', type: 'range', min: '0', max: '2', step: '0.02',
      value: String(state.relPhase / Math.PI),
    });
    slider.addEventListener('pointerdown', function () { dragging = true; window.__ORBIT_PREVIEW__ = true; });
    slider.addEventListener('input', function () {
      state.relPhase = Number(slider.value) * Math.PI;
      phNum.value = (state.relPhase / Math.PI).toFixed(2);
      push(true);                                   // preview=true → 低分辨率、rAF 节流
    });
    const endDrag = function () {
      if (!dragging) return;
      dragging = false;
      window.__ORBIT_PREVIEW__ = false;
      push(false);                                  // 松手 → 全分辨率重建一次
    };
    slider.addEventListener('pointerup', endDrag);
    slider.addEventListener('pointercancel', endDrag);
    slider.addEventListener('change', endDrag);
    host.appendChild(slider);

    host.appendChild(el('div', { class: 'se-note', html: mdInline(
      '$\\varphi = (E_i - E_j)\\,t/\\hbar$ 是**相对相位**，不是真实时间。真实振荡频率约 $10^{15}$ Hz 无法可视化，'
      + '而干涉图样只依赖相对相位。' )}));

    renderObs();
  }

  // 力学量面板
  function renderObs() {
    if (!state.terms.length || !window.Observables) return;
    const r = window.Observables.superposition(state.terms);
    const box = el('div', { class: 'se-obs' });
    box.appendChild(el('div', { class: 'se-obs-title', text: '力学量（解析式计算）' }));
    [
      ['⟨E⟩', r.energy.mean + ' eV', r.energy.definite ? '有确定值' : '无确定值'],
      ['⟨L²⟩', r.L2.mean + ' ħ²', r.L2.definite ? '有确定值' : '无确定值'],
      ['⟨L<sub>z</sub>⟩', r.Lz.mean + ' ħ', r.Lz.definite ? '有确定值' : '无确定值'],
      ['L<sub>z</sub> 谱', r.Lz.spectrum.map(function (s) { return 'm=' + s.m + ':' + (s.prob * 100).toFixed(1) + '%'; }).join('　'),
        // ★ 含实解分量时，谱里会看到 ±|m| 各一半 —— 那不是画错了，而是"实解不是 L̂z 的
        //   本征函数"的直接体现（复解才是）。这一行就是为了让这件事在界面上一眼可见。
        r.Lz.hasRealNonZero ? '含实解 → ±|m| 各半' : ''],
      ['是否定态', r.isStationary ? '是（各分量能量简并）' : '否（能量不同 → 密度随时间变）', ''],
    ].forEach(function (row) {
      const d = el('div', { class: 'se-obs-row' });
      // 用 html：下标（L_z）要真的渲染成下标，而不是字面的 "L_z"
      d.appendChild(el('span', { class: 'se-obs-k', html: row[0] }));
      d.appendChild(el('span', { class: 'se-obs-v', text: row[1] }));
      if (row[2]) d.appendChild(el('span', { class: 'se-obs-tag', text: row[2] }));
      box.appendChild(d);
    });
    host.appendChild(box);
  }

  // ---------------------------------------------------------------------------
  // 推送到主应用
  // ---------------------------------------------------------------------------
  let rafPending = false;
  function push(preview) {
    if (preview) {
      // 拖动中：用 rAF 节流，且标记预览态（主应用据此降低网格分辨率）
      window.__ORBIT_PREVIEW__ = true;
      if (rafPending) return;
      rafPending = true;
      requestAnimationFrame(function () {
        rafPending = false;
        doPush();
      });
      return;
    }
    window.__ORBIT_PREVIEW__ = false;
    doPush();
  }

  function doPush() {
    const norm = normalize(state.terms);
    window.OrbitApp.applyAction({ action: 'setSuperposition', params: { terms: norm } });
    if (state.relPhase) window.OrbitApp.applyAction({ action: 'setRelPhase', params: { phase: state.relPhase } });
    // 触发一次重算（空参不改变量子数）
    window.OrbitApp.applyAction({ action: 'recomputeOnly', params: {} });
    if (!dragging) render();
    else { /* 拖动中不重绘 UI，避免抖动 */ }
  }

  /** 归一化系数（Σ|c|² = 1）并保证量子数合法 */
  function normalize(terms) {
    const out = terms.map(function (t) {
      const n = Math.max(1, Math.min(6, Math.round(t.n)));
      const l = Math.max(0, Math.min(n - 1, Math.round(t.l)));
      const m = Math.max(-l, Math.min(l, Math.round(t.m)));
      return { n: n, l: l, m: m, mode: t.mode || 'real', c: { re: t.c.re, im: t.c.im || 0 } };
    });
    const s = Math.sqrt(out.reduce(function (a, t) { return a + t.c.re * t.c.re + t.c.im * t.c.im; }, 0));
    if (s > 1e-9) out.forEach(function (t) { t.c.re /= s; t.c.im /= s; });
    return out;
  }

  function applyPreset(key) {
    const p = PRESETS[key];
    if (!p) return { error: '未知预设：' + key };
    state.preset = key;
    if (key === 'pure') {
      state.terms = []; state.relPhase = 0;
      window.OrbitApp.applyAction({ action: 'clearSuperposition', params: {} });
      render();
      return { ok: true, preset: key, note: p.note };
    }
    state.terms = p.terms.map(function (t) {
      return { n: t.n, l: t.l, m: t.m, mode: t.mode, c: { re: t.c.re, im: t.c.im } };
    });
    state.relPhase = 0;
    expand();
    push(false);
    if (window.Panel) window.Panel.addChip('已载入：' + p.label);
    return { ok: true, preset: key, note: p.note, terms: state.terms.length };
  }

  function clear() {
    state.terms = []; state.relPhase = 0; state.preset = 'pure';
    render();
  }

  /**
   * 「＋ 存为预设」：把 ＋ 按钮就地换成一个输入框，回车确认。
   * 不弹原生 prompt —— 它会阻塞整个页面，而且样式与暗色主题割裂。
   */
  function beginSavePreset(anchor) {
    if (!state.terms.length) {
      if (window.Panel) window.Panel.addChip('当前是单一本征态：先选一个预设或构造叠加态，再存为预设');
      return;
    }
    const inp = el('input', {
      class: 'se-num se-savename', type: 'text',
      placeholder: '预设名（回车保存）', maxlength: '16',
    });
    anchor.replaceWith(inp);
    inp.focus();

    let finished = false;
    const finish = function (save) {
      if (finished) return;                 // blur 与 keydown 可能都触发，只认第一次
      finished = true;
      const name = inp.value.trim();
      if (save && name) {
        const r = addPreset(name, state.terms, '自定义预设（' + state.terms.length + ' 个分量）');
        if (r && r.ok) applyPreset(r.key);
        else render();
      } else {
        render();
      }
    };
    inp.onkeydown = function (ev) {
      if (ev.key === 'Enter') { ev.preventDefault(); finish(true); }
      else if (ev.key === 'Escape') { ev.preventDefault(); finish(false); }
    };
    inp.onblur = function () { finish(true); };
  }

  function expand() {
    const d = document.getElementById('advZone');
    if (d) d.open = true;
  }

  /**
   * 整区可用/不可用（第 9 条）：切到**球谐档**时整块收起并隐藏。
   *
   * ★ 依据不是"球谐档用不上"，而是**叠加态在这里根本不成立**：
   *   叠加态描述的是**完整波函数** ψ = Σcᵢψᵢ（render3d 只拿 l/m/mode 去画球谐曲面，
   *   各分量的 n 被整块丢弃）；而球谐曲面画的是**角度部分** Y。二者只有在各分量 n
   *   相同时才能对上，而内置预设 ψ_1s+ψ_2s 恰恰是 n 不同的那一类 —— 所以球谐档里
   *   保留叠加态会出现"三维画着某个单一 l 的曲面、公式却写着多分量叠加"的当场矛盾。
   *   与其显示一个对不上的东西，不如收起入口并把话说清楚（见 sphereHint）。
   */
  function setAvailable(on) {
    const d = document.getElementById('advZone');
    if (!d) return;
    d.style.display = on ? '' : 'none';
    if (!on) d.open = false;                 // 收起，免得切回来时突然弹开
  }

  /**
   * 整个「进阶：量子态」板块**暂时隐藏**（用户第 4 条：与杂化轨道板块一起隐藏）。
   *
   * ★ 与杂化同一套做法 —— **只隐入口，代码全部保留**：预设表、叠加态编辑器的实现、
   *   智能体侧的动作定义都原样留着，日后把这里改回 false 即可恢复
   *   （智能体侧同时要清空 scene-bridge 的 HIDDEN_ACTIONS）。
   * ★ 隐的是**挂载**而不是显示：根本不建这个 <details>，就不存在"展开后露出半截"、
   *   "键盘还能 Tab 进去"这类漏网的操作路径 —— 而"设成 display:none"仍然留着它们。
   */
  const EDITOR_HIDDEN = true;

  function build() {
    if (EDITOR_HIDDEN) return;   // 整块不挂载（见上）
    if (!document.getElementById('advZone')) {
      const panel = document.querySelector('.panel');
      if (!panel) return;
      const d = el('details', { class: 'adv-zone', id: 'advZone' });
      d.appendChild(el('summary', { class: 'adv-summary', text: '进阶：量子态（叠加 / 力学量）' }));
      const body = el('div', { class: 'adv-body' });
      body.appendChild(el('div', { id: 'stateEditor' }));
      d.appendChild(body);
      // ★ 必须挂进 .panel-body 而不是 .panel：面板高度被钉成与三维卡片等高
      //   （见 layout.js 的 --panel-h），.panel 带 overflow:hidden。挂成 .panel 的
      //   第二个 flex 子项时，这块**展开后会超出面板高度被裁掉**；挂进 .panel-body
      //   才与其它控件共用同一条滚动条。
      const pb = panel.querySelector('.panel-body') || panel;
      // ★ 追加到面板末尾。原先这里要 insertBefore 到静态的「进阶：三维着色」
      //   （#colorZone）之前，好让量子态排在它上方 —— 那个折叠区已按用户第 5 条
      //   整块删除，于是本折叠区就成了面板里唯一的「进阶」区，直接追加即可。
      pb.appendChild(d);
      // ★ 第 2 条：展开后把新露出的内容滚进可视区。toggle 事件不冒泡，只能在建的时候绑。
      if (window.OrbitApp && window.OrbitApp.bindAdvScroll) window.OrbitApp.bindAdvScroll(d);
    }
    host = document.getElementById('stateEditor');
    if (!host) return;
    render();
  }

  /** 两组 term 是否等价（用于避免"自己推自己"的同步回环） */
  function sameTerms(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i].n !== b[i].n || a[i].l !== b[i].l || a[i].m !== b[i].m) return false;
      if (Math.abs(a[i].c.re - b[i].c.re) > 1e-6) return false;
      if (Math.abs((a[i].c.im || 0) - (b[i].c.im || 0)) > 1e-6) return false;
    }
    return true;
  }

  /** 当前组合是否与某个预设完全一致（一致则保持该预设选中） */
  function matchPreset(terms) {
    // ★ visibleKeys()：被隐藏的预设不参与匹配 —— 否则 state.preset 可能落在一个
    //   界面上根本不存在的键上，按钮高亮与实际状态对不上。
    const keys = visibleKeys();
    for (let i = 0; i < keys.length; i++) {
      const p = PRESETS[keys[i]];
      if (p.terms.length !== terms.length) continue;
      if (sameTerms(normalize(p.terms), normalize(terms))) return keys[i];
    }
    return null;
  }

  let syncing = false;

  function init() {
    build();
    // ★ 与主应用双向同步：智能体（或任何外部动作）改了叠加态，编辑器 UI 要跟上
    window.OrbitApp.onAction(function () {
      if (syncing) return;
      const st = window.OrbitApp.getState();
      const appTerms = st.terms || [];
      if (sameTerms(appTerms, state.terms)) return;      // 自己发起的变更 → 不回灌
      syncing = true;
      state.terms = appTerms.map(function (t) {
        return { n: t.n, l: t.l, m: t.m, mode: t.mode || 'real', c: { re: t.c.re, im: t.c.im || 0 } };
      });
      state.relPhase = st.relPhase || 0;
      state.preset = appTerms.length ? (matchPreset(appTerms) || null) : 'pure';
      render();
      syncing = false;
    });
  }

  return { init, applyPreset, clear, expand, setAvailable, PRESETS, PHASE_PRESETS,
    /** 可见预设键（杂化已隐藏）—— 智能体的 listActions 也走这里，别再自己 Object.keys */
    visibleKeys, isHybrid,
    addPreset, removePreset, isCustom, _state: state };
})();
