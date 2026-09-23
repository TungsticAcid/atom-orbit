/**
 * mastery-model.js — 掌握度追踪与知识点推荐
 *
 * 每个知识点独立维护掌握度（简单可解释的加减规则，避免黑箱）：
 *   答对 +1　答错 −1　费曼复述通过 +2
 * 连续 2 次答对同一知识点 → 标记「已掌握」。
 *
 * 推荐依据：掌握度最低 + 与当前轨道的关联度（取自知识点—轨道映射矩阵）。
 * 数据只存本机 localStorage，不上传。
 */
window.MasteryModel = (function () {
  'use strict';

  const KEY = 'orbit.mastery';

  const KP_META = {
    K1: { name: '量子数与轨道命名', orbital: [{ n: 1, l: 0, m: 0 }, { n: 2, l: 1, m: 0 }, { n: 3, l: 2, m: 0 }] },
    K2: { name: '波函数与分离变量', orbital: [{ n: 3, l: 1, m: 0 }] },
    K3: { name: '径向函数辨析 R/R²/D/D²', orbital: [{ n: 1, l: 0, m: 0 }, { n: 3, l: 0, m: 0 }] },
    K4: { name: '角度分布与轨道形状', orbital: [{ n: 2, l: 1, m: 0 }, { n: 3, l: 2, m: 1 }] },
    K5: { name: '节面与节点计数', orbital: [{ n: 3, l: 0, m: 0 }, { n: 3, l: 1, m: 0 }, { n: 3, l: 2, m: 0 }] },
    K6: { name: '实函数与复函数', orbital: [{ n: 2, l: 1, m: 1 }] },
    K7: { name: '相位与符号', orbital: [{ n: 3, l: 2, m: 2 }] },
    K8: { name: '概率诠释与 |ψ|²', orbital: [{ n: 1, l: 0, m: 0 }] },
    K9: { name: '叠加态 / 杂化 / 力学量', orbital: [{ n: 3, l: 2, m: 0 }] },
  };

  let state = null;

  function load() {
    if (state) return state;
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { saved = null; }
    state = saved && typeof saved === 'object' ? saved : {};
    Object.keys(KP_META).forEach(function (kp) {
      if (!state[kp]) state[kp] = { score: 0, right: 0, wrong: 0, streak: 0, mastered: false, lastAt: 0 };
    });
    return state;
  }

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* 隐私模式 */ }
  }

  function update(kp, delta) {
    load();
    if (!state[kp]) return { error: '未知知识点：' + kp };
    const s = state[kp];
    s.score += Number(delta) || 0;
    s.lastAt = Date.now();
    if (delta > 0) {
      s.right++; s.streak++;
      if (s.streak >= 2) s.mastered = true;
    } else if (delta < 0) {
      s.wrong++; s.streak = 0; s.mastered = false;
    }
    save();
    return { knowledgePoint: kp, score: s.score, mastered: s.mastered, streak: s.streak };
  }

  /** 总览（进快照，供模型判断学情） */
  function summary() {
    load();
    const out = {};
    Object.keys(KP_META).forEach(function (kp) {
      out[kp] = { score: state[kp].score, mastered: state[kp].mastered };
    });
    return out;
  }

  /** 给模型看的紧凑文本 */
  function toText() {
    load();
    return Object.keys(KP_META).map(function (kp) {
      const s = state[kp];
      const tag = s.mastered ? '已掌握' : (s.score > 0 ? '学习中' : (s.wrong ? '待巩固' : '未接触'));
      return kp + '(' + KP_META[kp].name + '):' + tag + '/' + s.score;
    }).join('；');
  }

  function meta(kp) { return KP_META[kp] || null; }
  function allKnowledgePoints() { return Object.keys(KP_META); }

  /**
   * 推荐下一个知识点：优先掌握度最低的；同分时优先与当前轨道关联度高的。
   */
  function recommend(count, currentOrbital) {
    load();
    const cur = currentOrbital || (window.OrbitApp ? window.OrbitApp.getState() : null);
    const list = Object.keys(KP_META).map(function (kp) {
      const s = state[kp];
      let relevance = 0;
      if (cur) {
        (KP_META[kp].orbital || []).forEach(function (o) {
          if (o.n === cur.n && o.l === cur.l) relevance += 2;
          else if (o.l === cur.l) relevance += 1;
        });
      }
      return { kp: kp, name: KP_META[kp].name, score: s.score, mastered: s.mastered, relevance: relevance };
    }).filter(function (x) { return !x.mastered; });

    list.sort(function (a, b) {
      if (a.score !== b.score) return a.score - b.score;        // 掌握度低者优先
      return b.relevance - a.relevance;                          // 再按关联度
    });

    const n = Math.max(1, Math.min(count || 1, 3));
    return {
      recommended: list.slice(0, n),
      note: '优先推荐掌握度最低且与当前轨道关联度高的知识点',
    };
  }

  function reset() {
    state = null;
    try { localStorage.removeItem(KEY); } catch (e) { /* ignore */ }
    load(); save();
  }

  return { update, summary, toText, recommend, meta, allKnowledgePoints, reset, load };
})();
