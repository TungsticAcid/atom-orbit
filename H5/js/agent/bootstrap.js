/**
 * bootstrap.js — 启动接线
 *
 * 职责：把各模块挂到一起，注册扩展钩子，启动感知与主动服务。
 * 放在最后加载，确保所有依赖已就绪。
 */
(function () {
  'use strict';

  function boot() {
    // ---- 注册 scene-bridge 的扩展钩子（避免模块间硬耦合）----
    if (window.SceneBridge) {
      window.SceneBridge.registerHooks({
        ringHighlight: function (radius) {
          if (window.Orbit3D && window.Orbit3D.ringHighlight) window.Orbit3D.ringHighlight(radius);
        },
        spotlightNodes: function (type, on) {
          if (window.Orbit3D && window.Orbit3D.spotlightNodes) window.Orbit3D.spotlightNodes(type, on);
        },
        setFormulaHighlight: function (part) {
          if (window.OrbitApp) window.OrbitApp.applyAction({ action: 'setFormulaHighlight', params: { part: part } });
        },
      });
    }

    // ---- 感知快照（轮询状态差分，零侵入采集交互痕迹）----
    if (window.Perception) {
      try { window.Perception.start(); } catch (e) { console.warn('感知启动失败', e); }
    }

    // ---- 面板（悬浮球 + 抽屉）----
    if (window.Panel) {
      try { window.Panel.init(); } catch (e) { console.error('面板启动失败', e); }
    }

    // ---- 量子态编辑器（辅助功能，收在「进阶」折叠区）----
    if (window.StateEditor) {
      try { window.StateEditor.init(); } catch (e) { console.warn('量子态编辑器启动失败', e); }
    }

    // ---- 主动服务（本地规则，零 token）----
    if (window.ProactiveRules) {
      try { window.ProactiveRules.start(); } catch (e) { console.warn('主动服务启动失败', e); }
    }

    // ---- 教材对照表入口 ----
    window.addEventListener('orbit:reftable', function (ev) {
      if (window.ReferenceTable) window.ReferenceTable.toggle(ev.detail || {});
    });

    // ---- 图表浮动窗 ----
    // 演示讲到"看径向分布 / 截面密度"时，把那张（位于页面底部的）图放大到浮层里，
    // 讲解与图才能同时可见。用事件而不是直接调用：动作层（scene-bridge）不该依赖 UI 模块。
    window.addEventListener('orbit:chart-focus', function (ev) {
      if (!window.ChartOverlay) return;
      const p = ev.detail || {};
      if (p.target === 'none') window.ChartOverlay.close();
      else window.ChartOverlay.open(p.target);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
