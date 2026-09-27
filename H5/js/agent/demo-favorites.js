/**
 * demo-favorites.js — 演示收藏夹（只存本机）
 *
 * 解决的问题：**一条讲得好的演示，学生想留着反复看**。
 * 演示记录（scene-bridge 的 `demos`）只活在一次会话里 —— 刷新就没了（靠对话历史重建），
 * 换一个会话也带不过去，历史被裁剪后更找不到。而"哪条演示值得留着"是**人的判断**，
 * 程序猜不出来，所以要有显式的"收藏"动作。
 *
 * ★ 与演示记录的分工（两者都要有，别合并）：
 *   · 演示记录 = "这次会话放过什么"（自动、易失、由对话历史重建）
 *   · 收藏夹   = "哪些值得留着"（手动、持久、跨会话）
 *   前者的价值是"刚才那条能重播"，后者的价值是"上周那条还在"。
 *
 * ★ 只存本机（localStorage），不上传 —— 与 BYOK 的隐私姿态一致。
 * ★ 收藏的是**步骤清单**（action / params / speech），不是渲染结果：
 *   回放时按**当前**视图重新执行一遍，所以一年后回放仍然是对的（而截图会过时）。
 *   这也是它必须走 `SceneBridge.loadDemo` 而不是"存一份快照"的原因。
 *
 * ★ 刻意**不进工具表**：收藏与否是人按自己的判断按的按钮，不该由模型代劳
 *   （模型既不知道哪条对学生有用，也不该替他决定留下什么）。
 */
window.DemoFavorites = (function () {
  'use strict';

  /** 最多收藏多少条（每条几十步，50 条大约几十 KB，远在 localStorage 配额之内） */
  var MAX_FAVORITES = 50;

  /**
   * @param {Object} [opts]
   * @param {Object} [opts.storage] 具备 getItem/setItem/removeItem（缺省 localStorage）
   * @param {string} [opts.storageKey]
   * @param {Function} [opts.now]   时间源（可注入以便测试）
   */
  function create(opts) {
    opts = opts || {};
    var storage = opts.storage ||
      (typeof localStorage !== 'undefined' ? localStorage : null);
    var key = opts.storageKey || 'orbit.agent.demoFavorites';
    var now = opts.now || Date.now;

    function read() {
      try {
        var raw = storage && storage.getItem(key);
        var list = raw ? JSON.parse(raw) : [];
        // 逐条体检：结构坏掉的记录直接丢掉，别让一条脏数据毁掉整个收藏夹
        return Array.isArray(list)
          ? list.filter(function (x) { return x && x.key && Array.isArray(x.steps); })
          : [];
      } catch (e) { return []; }
    }

    function write(list) {
      try {
        if (storage) storage.setItem(key, JSON.stringify(list));
        return true;
      } catch (e) {
        // ★ 配额满时降级：丢掉最旧的一半再试一次。
        //   收藏夹被砍总比"点收藏报错、学生以为功能坏了"要好；而最旧的几条
        //   本来也是他最不可能再看的。
        try {
          if (storage && list.length > 4) {
            storage.setItem(key, JSON.stringify(list.slice(0, Math.floor(list.length / 2))));
            return true;
          }
        } catch (e2) { /* 放弃持久化，本次仍返回的是"存过"的事实 */ }
        return false;
      }
    }

    /** 全部收藏（最近收藏的在前） */
    function list() {
      return read().sort(function (a, b) { return (b.at || 0) - (a.at || 0); });
    }

    /** 取某一条 */
    function get(k) {
      var hit = read().filter(function (x) { return x.key === k; });
      return hit.length ? hit[0] : null;
    }

    /**
     * 收藏一条演示。
     * @param {string} label 给学生看的名字（缺省取第一条有旁白的步骤的前 40 字）
     * @param {Array}  steps 步骤清单（与 applySceneActions 的 actions 同形）
     * @param {Object} [meta] { origin, kp }
     * @returns {{ok:boolean, key?:string, label?:string, count?:number, error?:string}}
     */
    function save(label, steps, meta) {
      var cur = read();
      if (!Array.isArray(steps) || !steps.length) {
        return { ok: false, error: '这条演示没有可收藏的步骤' };
      }
      var name = String(label || '').trim();
      if (!name) {
        // 缺省名取**第一条有旁白**的步骤 —— 旁白是学生判断"这条讲的是什么"的唯一依据
        var withSpeech = steps.filter(function (s) { return s && s.speech; });
        name = withSpeech.length ? withSpeech[0].speech : '未命名演示';
      }
      var entry = {
        // ★ key 用 'f' 前缀，与演示记录的 'dN' 是**两个独立的 ID 空间** ——
        //   收藏回放会新开一条演示记录，不会与任何既有记录撞号。
        key: 'f' + now().toString(36) + Math.floor(Math.random() * 1e4).toString(36),
        label: String(name).slice(0, 40),
        at: now(),
        origin: (meta && meta.origin) || 'agent',
        kp: (meta && meta.kp) || null,
        // 只留这三样：回放要靠 loadDemo 重新 validate 并重新分配步骤 id，
        // 存多了反而会出现"存的是旧形状、回放时不认"的漂移。
        steps: steps.map(function (s) {
          return { action: s.action, params: s.params, speech: s.speech };
        }),
      };
      cur.unshift(entry);
      while (cur.length > MAX_FAVORITES) cur.pop();
      write(cur);
      return { ok: true, key: entry.key, label: entry.label, count: entry.steps.length };
    }

    /** 改名（store 支持，界面上暂无入口 —— 留给后续） */
    function rename(k, label) {
      var cur = read();
      var rec = null;
      for (var i = 0; i < cur.length; i++) { if (cur[i].key === k) { rec = cur[i]; break; } }
      if (!rec) return false;
      rec.label = String(label || '').slice(0, 40) || rec.label;
      write(cur);
      return true;
    }

    /** 删除一条（界面上是"删除"按钮；没有单独的"取消收藏"） */
    function remove(k) {
      var cur = read();
      var next = cur.filter(function (x) { return x.key !== k; });
      if (next.length === cur.length) return false;
      write(next);
      return true;
    }

    function count() { return read().length; }

    return { list: list, get: get, save: save, rename: rename, remove: remove,
      count: count, MAX: MAX_FAVORITES };
  }

  // 默认单例（面板直接用 window.DemoFavorites.list() 等）——
  // ★ create 也一并导出，好让自检脚本注入内存 storage、不污染真实 localStorage。
  var singleton = create();
  return {
    create: create,
    list: function () { return singleton.list(); },
    get: function (k) { return singleton.get(k); },
    save: function (l, s, m) { return singleton.save(l, s, m); },
    rename: function (k, l) { return singleton.rename(k, l); },
    remove: function (k) { return singleton.remove(k); },
    count: function () { return singleton.count(); },
    MAX: MAX_FAVORITES,
    /** 持久化用的 key —— settings.js 的"清除本机全部数据"要删它 */
    STORAGE_KEY: 'orbit.agent.demoFavorites',
  };
})();
