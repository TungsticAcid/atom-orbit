/**
 * sched.js — 把长任务切成小片、摊到多帧里跑完（主线程时间切片）
 *
 * ★ 为什么只能在主线程上做：本项目要求 **file:// 离线可用**（见 index.html 脚本区的注释与
 *   README「不装、不注册、不需要服务器」）。而实测在该协议下 Worker 用不了 ——
 *   普通 worker 文件被 `SecurityError` 挡下；Blob worker 虽能构造，但里面的
 *   `importScripts('file://…/math.js')` 报 `NetworkError`，即 worker 的源码必须完全自包含，
 *   等于把物理计算复制一份。所以不引入 Worker，改为把重活切片。
 *
 * ★ 切片必须挂进**既有的渲染循环**（main.js 的 animate），而不是另开一条 rAF 链：
 *   这样相机阻尼与自动旋转照常每帧推进，用户看到的是"画面在动、结果慢慢长出来"，
 *   而不是"整屏卡死几百毫秒、然后结果突然出现"。
 *
 * ★ 取消用 generation 语义：`run()` 返回的句柄带 `cancel()`，被取消时调用 `abort()`
 *   让调用方还原现场。项目里已有同款写法（agent/scene-bridge.js 的 generation），
 *   这里沿用同一套语义，不再另发明一种。
 */
window.Sched = (function () {
  'use strict';

  // 一帧 16.7ms，留一半以上给渲染、输入与相机 —— 超过这个数就让出。
  const DEFAULT_BUDGET_MS = 8;

  const jobs = [];
  let seq = 0;

  /**
   * 排入一个长任务。
   * @param {Object} o
   * @param {Function} o.step  推进一小片；返回 false 表示全部完成
   * @param {Function} [o.done] 完成时调用
   * @param {Function} [o.abort] 被取消时调用（还原现场 / dispose 中间对象）
   * @param {number} [o.budgetMs] 每帧最多占用多少毫秒，默认 8
   * @param {string} [o.label] 仅用于调试与报错信息
   * @returns {{cancel: Function, isDone: Function}}
   */
  function run(o) {
    const job = {
      id: ++seq,
      label: o.label || 'job',
      step: o.step,
      done: o.done || null,
      abort: o.abort || null,
      budgetMs: o.budgetMs || DEFAULT_BUDGET_MS,
      dead: false,
    };
    jobs.push(job);
    return {
      cancel: function () { kill(job, true); },
      isDone: function () { return job.dead; },
    };
  }

  function kill(job, callAbort) {
    if (job.dead) return;
    job.dead = true;
    const i = jobs.indexOf(job);
    if (i >= 0) jobs.splice(i, 1);
    if (callAbort && job.abort) {
      // ★ abort 里若再抛错，不能让它把这一帧的渲染循环带崩 —— 吞掉并记账。
      try { job.abort(); } catch (e) { console.error('[Sched] ' + job.label + ' 的 abort 抛错', e); }
    }
  }

  /**
   * 由渲染循环每帧调用一次：把在排的任务各自推进到本帧预算用完为止。
   * 倒序遍历 —— 完成/取消的任务会就地 splice，倒着走下标才不错位。
   */
  function tick() {
    for (let i = jobs.length - 1; i >= 0; i--) {
      const job = jobs[i];
      if (job.dead) continue;
      const t0 = performance.now();
      for (;;) {
        let more;
        try {
          more = job.step();
        } catch (e) {
          // 单片出错不能把渲染循环带崩：中止这个任务并走 abort 收尾。
          console.error('[Sched] ' + job.label + ' 的 step 抛错，任务中止', e);
          kill(job, true);
          break;
        }
        if (!more) {
          job.dead = true;
          jobs.splice(i, 1);
          if (job.done) {
            try { job.done(); } catch (e) { console.error('[Sched] ' + job.label + ' 的 done 抛错', e); }
          }
          break;
        }
        // 预算用完就让出 —— 剩下的下一帧继续。这是"不卡顿"的全部机制。
        if (performance.now() - t0 >= job.budgetMs) break;
      }
    }
  }

  function cancelAll() { jobs.slice().forEach(function (j) { kill(j, true); }); }

  return { run: run, tick: tick, cancelAll: cancelAll, count: function () { return jobs.length; } };
})();
