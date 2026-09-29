/**
 * render3d.js — Three.js 三维渲染：粒子云 + 等值面（marching tetrahedra）
 *
 * 设计要点：
 *   - 使用 Three.js r147 全局构建（window.THREE），通过 <script> 引入。
 *   - 化学约定：z 轴为量化轴（竖直）。相机朝向由四元数直接描述（初始朝向用
 *     z 向上的 lookAt 矩阵求得），不再依赖 camera.up，从根本上规避万向节锁。
 *   - 粒子云：按 |ψ|² 重要性采样（由 math.samplePoints 生成），透明点云。
 *   - 等值面：在 [-extent, extent]³ 网格上求 |ψ|² 标量场，用四面体行进提取
 *     |ψ|² = level 的等值面。相比经典 marching cubes（需 256×16 巨型查找表），
 *     四面体法仅用 4 顶点判断 + 线性插值，规则简单、实现可靠；代价是三角形略多，
 *     用较高的网格分辨率补偿。法线由标量场梯度（三线性插值）给出，与绕序无关、平滑。
 */
window.Orbit3D = (function () {
  'use strict';

  // 立方体 8 个顶点的 (di,dj,dk) 偏移
  const CUBE_OFF = [
    [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
    [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1],
  ];
  // 立方体按体对角线 0-6 剖分为 6 个四面体（四面体行进）
  const TETS = [
    [0, 1, 2, 6], [0, 2, 3, 6], [0, 3, 7, 6],
    [0, 7, 4, 6], [0, 4, 5, 6], [0, 5, 1, 6],
  ];
  const TET_EDGES = [[0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3]];

  // ---------------------------------------------------------------------------
  // 四元数轨道控制器（取代 THREE.OrbitControls）
  //
  // 为什么换掉 OrbitControls：它用"球坐标(r, θ, φ) + up 向量"描述相机朝向，
  // 当视线与 up 平行时（本工具 z 轴向上，俯视/仰视到极点）方位角失去意义，
  // 即万向节锁，表现为转到极点附近时突然翻转或卡住。
  //
  // 这里改为用四元数累积旋转，全程不经过欧拉角，故不存在奇异点：
  //   · 偏航 yaw   —— 绕【相机自身 Y 轴（屏幕竖直）】旋转（局部系 → 右乘 multiply）
  //   · 俯仰 pitch —— 绕【相机自身 X 轴（屏幕水平）】旋转（局部系 → 右乘 multiply）
  // 两者都取相机局部轴，所以"左右拖"永远是绕屏幕竖直轴转，不会因俯仰角度而反向。
  // 相机朝向 q 直接决定位置：position = target + (q·(0,0,1)) · distance，
  // 即相机局部 +Z 由注视点指向相机，与 Three.js 相机沿 -Z 观察的约定一致。
  // ---------------------------------------------------------------------------
  function createQuatOrbit(camera, dom, opts) {
    opts = opts || {};
    const rotateSpeed = opts.rotateSpeed != null ? opts.rotateSpeed : 1.0;
    const zoomSpeed = opts.zoomSpeed != null ? opts.zoomSpeed : 1.0;
    const damping = opts.damping != null ? opts.damping : 0.18;
    const autoRotateStep = opts.autoRotateSpeed != null ? opts.autoRotateSpeed : 0.0035;

    const quat = new THREE.Quaternion();         // 当前相机朝向
    const quatTarget = new THREE.Quaternion();   // 阻尼目标朝向
    const target = new THREE.Vector3(0, 0, 0);   // 注视点
    const homeEye = new THREE.Vector3(0, -4, 3);
    const homeLook = new THREE.Vector3(0, 0, 0);
    let distance = opts.distance || 5;
    let minDistance = 0.05, maxDistance = 500;
    let autoRotate = false, enabled = true;
    // 用户是否手动动过镜头（旋转/平移/缩放）。动过之后，窗口尺寸变化时
    // **不再**自动重新取景——否则用户刚调好的视角会被"好心"地重置掉。
    let userAdjusted = false;

    const AXIS_Z = new THREE.Vector3(0, 0, 1);   // 世界竖直轴（仅初始 lookAt 用）
    const AXIS_X = new THREE.Vector3(1, 0, 0);   // 相机局部 X（屏幕水平）
    const AXIS_Y = new THREE.Vector3(0, 1, 0);   // 相机局部 Y（屏幕竖直）
    const _v = new THREE.Vector3();
    const _right = new THREE.Vector3();
    const _up = new THREE.Vector3();
    const _qYaw = new THREE.Quaternion();
    const _qPitch = new THREE.Quaternion();

    /** 把当前 quat/distance/target 应用到相机 */
    function apply() {
      camera.quaternion.copy(quat);
      _v.set(0, 0, 1).applyQuaternion(quat).multiplyScalar(distance);
      camera.position.copy(target).add(_v);
      camera.updateMatrixWorld();
    }

    /** 由"眼睛位置 + 注视点"设定朝向（z 向上） */
    function setView(eye, look) {
      homeEye.copy(eye); homeLook.copy(look);
      target.copy(look);
      distance = eye.distanceTo(look);
      const m = new THREE.Matrix4().lookAt(eye, look, AXIS_Z);
      quat.setFromRotationMatrix(m);
      quatTarget.copy(quat);
      apply();
    }

    /**
     * 拖拽旋转 —— 纯相机局部系（trackball）。
     *
     * 偏航绕【相机自身 Y（屏幕竖直）】、俯仰绕【相机自身 X（屏幕水平）】，两者都右乘。
     * 关键点：**不能**用世界 Z 轴做偏航。若用世界 Z，当相机俯仰到极点附近时，
     * 世界 Z 恰好与视线重合，"左右拖"就退化成绕视线的滚转，用户会感到左右反向；
     * 改用局部 Y 后，无论当前朝向如何，左右拖永远绕屏幕竖直轴转，方向始终一致。
     * 代价是允许累积滚转（真正的自由旋转），这也是 trackball 的固有特性。
     */
    function rotate(dx, dy) {
      const w = dom.clientWidth || 1, h = dom.clientHeight || 1;
      const yawAngle = -2 * Math.PI * dx / w * rotateSpeed;
      const pitchAngle = -2 * Math.PI * dy / h * rotateSpeed;
      _qPitch.setFromAxisAngle(AXIS_X, pitchAngle);
      _qYaw.setFromAxisAngle(AXIS_Y, yawAngle);
      quatTarget.multiply(_qPitch).multiply(_qYaw).normalize();
    }

    /** 拖拽平移：沿相机屏幕平面移动注视点（每像素的世界位移随距离缩放，故"跟手"） */
    function pan(dx, dy) {
      const h = dom.clientHeight || 1;
      const k = 2 * distance * Math.tan((camera.fov * Math.PI / 180) / 2) / h;
      _right.set(1, 0, 0).applyQuaternion(quat);
      _up.set(0, 1, 0).applyQuaternion(quat);
      target.addScaledVector(_right, -dx * k);   // 向右拖 → 场景右移
      target.addScaledVector(_up, dy * k);       // 向下拖 → 场景下移
    }

    function zoomBy(factor) {
      distance = Math.min(maxDistance, Math.max(minDistance, distance * factor));
      userAdjusted = true;
    }

    function setDistance(d) {
      distance = Math.min(maxDistance, Math.max(minDistance, d));
      apply();
    }

    // ---- 指针事件（鼠标 + 触摸；双指捏合缩放并平移）----
    const pointers = new Map();
    let dragging = false, panMode = false, lastX = 0, lastY = 0, lastPinch = 0, lastMid = null;

    dom.addEventListener('pointerdown', (e) => {
      if (!enabled) return;
      dom.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 1) {
        dragging = true;
        panMode = (e.button === 2) || e.shiftKey;   // 右键 / Shift+拖 = 平移
        lastX = e.clientX; lastY = e.clientY;
      } else if (pointers.size === 2) {
        dragging = false;
        const p = [...pointers.values()];
        lastPinch = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
        lastMid = { x: (p[0].x + p[1].x) / 2, y: (p[0].y + p[1].y) / 2 };
      }
    });
    dom.addEventListener('pointermove', (e) => {
      if (!enabled || !pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 1 && dragging) {
        const dx = e.clientX - lastX, dy = e.clientY - lastY;
        lastX = e.clientX; lastY = e.clientY;
        if (panMode) pan(dx, dy); else rotate(dx, dy);
        userAdjusted = true;
      } else if (pointers.size === 2) {
        const p = [...pointers.values()];
        const pinch = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
        const mid = { x: (p[0].x + p[1].x) / 2, y: (p[0].y + p[1].y) / 2 };
        if (lastPinch > 0 && pinch > 0) zoomBy(lastPinch / pinch);
        if (lastMid) pan(mid.x - lastMid.x, mid.y - lastMid.y);
        lastPinch = pinch; lastMid = mid;
      }
    });
    const onPointerEnd = (e) => {
      pointers.delete(e.pointerId);
      if (pointers.size === 0) dragging = false;
      if (pointers.size < 2) { lastPinch = 0; lastMid = null; }
    };
    dom.addEventListener('pointerup', onPointerEnd);
    dom.addEventListener('pointercancel', onPointerEnd);
    dom.addEventListener('wheel', (e) => {
      if (!enabled) return;
      e.preventDefault();
      zoomBy(Math.exp(e.deltaY * 0.001 * zoomSpeed));
    }, { passive: false });
    dom.addEventListener('contextmenu', (e) => e.preventDefault());   // 右键留给平移

    /** 每帧调用：自动旋转 + 阻尼插值 + 应用到相机 */
    function update() {
      if (autoRotate && !dragging) {
        // 自动旋转同样绕相机局部 Y（屏幕竖直）→ 视觉上始终是水平自转，
        // 与拖拽行为一致（用世界 Z 的话，俯视极点时会变成原地打转）
        _qYaw.setFromAxisAngle(AXIS_Y, autoRotateStep);
        quatTarget.multiply(_qYaw).normalize();
      }
      if (quat.angleTo(quatTarget) > 1e-5) {
        quat.slerp(quatTarget, damping);        // 四元数球面插值 → 平滑且无奇异
      } else {
        quat.copy(quatTarget);
      }
      apply();
    }

    return {
      update, setView, apply, target,
      setAutoRotate: (v) => { autoRotate = !!v; },
      setEnabled: (v) => { enabled = !!v; },
      setDistance,
      setLimits: (lo, hi) => { minDistance = lo; maxDistance = hi; },
      resetHome: () => { userAdjusted = false; setView(homeEye, homeLook); },
      getDistance: () => distance,
      /** 供调试/测试读取（与 getCameraState 同类用途） */
      isAutoRotate: () => autoRotate,
      isUserAdjusted: () => userAdjusted,
    };
  }

  let scene = null, camera = null, renderer = null, viewCtl = null;
  let cloudObj = null;          // THREE.Points
  let surfaceObj = null;        // THREE.Mesh
  //: 最近一次 setVisibility 收到的档位。存在的理由只有一个：**切片重建提交时要知道
  //: "现在该显还是该隐"** —— 见 commitSurface 末尾。别拿它当"当前档位"的真值去读
  //: （真值在 main.js 的 state.viewTarget）。
  let lastVisMode = 'surface';
  let nucleusObj = null;
  let axesObj = null;
  let gridObj = null;
  let decorGroup = null;        // 坐标轴 + 赤道环（随轨道尺度整体缩放）

  // 球谐曲面（现为主场景内的可切换对象，见 updateAngular）
  const ANG_RES = 30;           // θ 方向网格数

  // 标量场（由 grid 节点构成），缓存以便调整阈值时不必重算 |ψ|²
  let field = null, gradX = null, gradY = null, gradZ = null;
  let nGrid = 0, gridExtent = 0, fieldMax = 0;
  // 当前标量场各轴节点的坐标。均匀网格时三轴相同且等距；局部精细化的细网格用
  // **径向渐变**（核附近密、往外稀）—— 单靠提高分辨率救不了细颈：
  // 缝隙 0.24a₀ 要在 5.66a₀ 半径的盒子里跨 4 个单元格，均匀网格需要 ~190³ ≈ 108MB。
  let gridXs = null;
  // "当前发布的这一份场是什么"（见 commitField）。切片之前这个前提是自动成立的：
  // 场要么刚被同步算完、要么根本没动。切片之后"准备"与"发布"之间隔着几十帧，
  // 于是必须显式记下来，复用缓存场时才验得了"缓存的那份就是现在要的那份"。
  let fieldKey = '';
  let fieldDesc = null;

  /**
   * 生成一维节点坐标。
   * @param {number} a 0 = 均匀；>0 时用 x = L(a·u + (1−a)·u³)（u∈[−1,1]），
   *                   u³ 项把节点往中心拉 → 核附近单元格更小，总节点数不变
   */
  function makeAxisCoords(n, L, a) {
    const xs = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const u = -1 + (2 * i) / (n - 1);
      xs[i] = (a > 0) ? L * (a * u + (1 - a) * u * u * u) : -L + (2 * L * i) / (n - 1);
    }
    return xs;
  }
  let surfaceLevelFraction = 0.08;

  // 取景留白系数：需要容纳的半尺寸 = 轨道取景尺度 × FIT_MARGIN。
  // 相机 fov=50°，竖直半视野 = dist·tan(25°)，故物体占画面高度的比例为
  // 1/FIT_MARGIN。1.42 ⇒ 轨道约占 70% 高度，上下各留约 30% 空白——
  // 原先固定 dist = extent×2.8 相当于占 77%，轨道贴得偏满。
  // ★ 不要退回"距离 = extent × 常数"的写法：那样留白会随画布宽高比漂移，
  //   扁画布上轨道顶满上下边缘，竖屏 / 窄画布还会被左右切掉。见 fitView 注释。
  const FIT_MARGIN = 1.42;
  let lastDecorExtent = null;    // 上次取景用的装饰标尺（窗口尺寸变化时复用）
  let lastFitExtent = 0;         // 上次取景用的轨道尺度（判断是否需要重新取景）

  const containerRef = { el: null };

  // ---------------------------------------------------------------------------
  // 初始化场景
  // ---------------------------------------------------------------------------
  function init(container) {
    containerRef.el = container;
    const width = container.clientWidth || 500;
    const height = container.clientHeight || 400;

    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(50, width / height, 0.001, 200);

    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(width, height);
    container.appendChild(renderer.domElement);

    // 四元数轨道控制器（z 竖直，俯视极点也不会万向节锁）
    viewCtl = createQuatOrbit(camera, renderer.domElement, {
      distance: 5, rotateSpeed: 1.0, damping: 0.18, autoRotateSpeed: 0.0035,
    });
    viewCtl.setView(new THREE.Vector3(0, -4, 3), new THREE.Vector3(0, 0, 0));
    viewCtl.setAutoRotate(true);

    // 灯光（供表面使用）
    const ambient = new THREE.AmbientLight(0xffffff, 0.55);
    const dir = new THREE.DirectionalLight(0xffffff, 1.0);
    dir.position.set(3, -2, 5);
    const dir2 = new THREE.DirectionalLight(0x88aaff, 0.35);
    dir2.position.set(-4, 3, -2);
    scene.add(ambient, dir, dir2);

    buildAxes();
    buildGrid();
    // 坐标轴与赤道环是"装饰性参照"，随当前轨道尺度整体缩放（否则 1s 这类
    // 小轨道会被固定长度的坐标轴淹掉）。统一放进一个组，fitView 里设缩放。
    decorGroup = new THREE.Group();
    if (axesObj) decorGroup.add(axesObj);
    if (gridObj) decorGroup.add(gridObj);
    scene.add(decorGroup);

    // 原子核（发光小球）
    const nucGeo = new THREE.SphereGeometry(1, 24, 24);
    const nucMat = new THREE.MeshStandardMaterial({
      color: 0xff5a2a, emissive: 0xff3a10, emissiveIntensity: 2.0, roughness: 0.3,
    });
    nucleusObj = new THREE.Mesh(nucGeo, nucMat);
    scene.add(nucleusObj);

    // ★ 用 ResizeObserver 监视**容器本身**的尺寸变化，而不只是 window.resize。
    //   否则当布局因其他原因变化时（如展开侧栏的「进阶」折叠区，使网格行变高），
    //   渲染器的宽高比会与 CSS 尺寸失配 → 图形被拉伸、拖拽手感错位。
    if (window.ResizeObserver) {
      const ro = new ResizeObserver(function () {
        const w = container.clientWidth, h = container.clientHeight;
        if (w > 0 && h > 0) resize(w, h);
      });
      ro.observe(container);
      containerRef.ro = ro;
    }

    return api;
  }

  // 坐标轴（z 竖直，化学配色：x 红 / y 绿 / z 蓝）
  function buildAxes() {
    const pts = [];
    const mk = (a, b) => { pts.push(new THREE.Vector3(...a), new THREE.Vector3(...b)); };
    mk([-12, 0, 0], [12, 0, 0]);
    mk([0, -12, 0], [0, 12, 0]);
    mk([0, 0, -12], [0, 0, 12]);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(
      pts.flatMap(v => [v.x, v.y, v.z]), 3));
    const mat = new THREE.LineBasicMaterial({ color: 0x555f77, transparent: true, opacity: 0.5 });
    axesObj = new THREE.LineSegments(geo, mat);
    scene.add(axesObj);
  }

  // 赤道参考圆环（在 xy 平面，z=0，帮助读方位角）
  function buildGrid() {
    const seg = 96, radius = 12;
    const pts = [];
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2;
      const a1 = ((i + 1) / seg) * Math.PI * 2;
      pts.push(new THREE.Vector3(Math.cos(a0) * radius, Math.sin(a0) * radius, 0));
      pts.push(new THREE.Vector3(Math.cos(a1) * radius, Math.sin(a1) * radius, 0));
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(
      pts.flatMap(v => [v.x, v.y, v.z]), 3));
    const mat = new THREE.LineBasicMaterial({ color: 0x39425c, transparent: true, opacity: 0.6 });
    gridObj = new THREE.LineSegments(geo, mat);
    scene.add(gridObj);
  }

  // ---------------------------------------------------------------------------
  // 点云
  // ---------------------------------------------------------------------------
  function updateCloud(cloud) {
    if (cloudObj) { scene.remove(cloudObj); cloudObj.geometry.dispose(); cloudObj.material.dispose(); cloudObj = null; }
    if (!cloud || !cloud.count) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(cloud.positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(cloud.colors, 3));
    const size = Math.max(0.02, cloud.extent * 0.023);
    const mat = new THREE.PointsMaterial({
      size: size, sizeAttenuation: true, vertexColors: true,
      transparent: true, opacity: 0.95, depthWrite: false, depthTest: true,
    });
    cloudObj = new THREE.Points(geo, mat);
    cloudObj.frustumCulled = false;
    scene.add(cloudObj);
    // 与等值面共用同一取景尺度；且尺度没变就不动相机 →
    // 切换渲染方式时视角不跳（见 fitViewIfNeeded 注释）
    fitViewIfNeeded(currentFrameExtent());
  }

  // ---------------------------------------------------------------------------
  // 等值面
  // ---------------------------------------------------------------------------

  /**
   * 由标量场算 ∇|ψ|²（取反 → 朝外法线）—— **一层 k**。
   * ★ 分母用**实际坐标差**而不是 (i1−i0)·step：细网格用径向渐变，节点间距不等，
   *   沿用均匀间距会让法线在各轴上的权重不一致（法线歪掉 → 光照看出条纹）。
   */
  function gradientLayer(ctx, k) {
    const n = ctx.nGrid;
    const X = ctx.xs;
    const F = ctx.field, gx = ctx.gradX, gy = ctx.gradY, gz = ctx.gradZ;
    const id0 = k * n * n;
    const k0 = Math.max(0, k - 1), k1 = Math.min(n - 1, k + 1);
    const kLo = k0 * n * n, kHi = k1 * n * n;
    const dz = X[k1] - X[k0];
    for (let j = 0; j < n; j++) {
      const j0 = Math.max(0, j - 1), j1 = Math.min(n - 1, j + 1);
      const dy = X[j1] - X[j0];
      const rowC = id0 + j * n, rowJ0 = id0 + j0 * n, rowJ1 = id0 + j1 * n;
      for (let i = 0; i < n; i++) {
        const i0 = Math.max(0, i - 1), i1 = Math.min(n - 1, i + 1);
        const dx = X[i1] - X[i0];
        // 取反：∇|ψ|² 指向密度增大方向（对成键轨道朝核内），法线应为朝外 → 负梯度
        gx[rowC + i] = (F[rowC + i0] - F[rowC + i1]) / dx;
        gy[rowC + i] = (F[rowJ0 + i] - F[rowJ1 + i]) / dy;
        gz[rowC + i] = (F[kLo + j * n + i] - F[kHi + j * n + i]) / dz;
      }
    }
  }

  /**
   * 场计算（|ψ|² + 梯度）的**准备**阶段：决策盒子大小、分配数组、建径向查表，
   * 把结果写回那些模块级场量（沿用原有约定，读取方不必改）。
   *
   * ★ 拆成"准备 + 逐层推进"是为了让 `Sched` 能把这场计算摊到多帧里跑完 ——
   *   68³ 的场填充加梯度原本是一次 ~150ms 的同步块，界面会整段卡住。
   *   推进的粒度是**一层 k**（68 层、每层 ~0.2ms），交给 Sched 按预算批。
   */
  function prepareField(n, l, m, mode, res, level, terms, relPhase, extentOverride, grading, Z) {
    const zc = (Z > 0) ? Z : 1;
    const iso = (level > 0) ? level : 0;
    // 叠加态：范围取各分量外延的最大值；否则按单一本征态
    const useSuper = !!(terms && terms.length);
    const extent = (extentOverride > 0)
      ? extentOverride            // 局部精细化的细网格：盒子必须正好等于节点球半径
      : (useSuper
        ? Math.max(
          OM.superpositionRefExtent(terms, zc) * 1.15,      // 取景基准（与阈值无关，保证常见阈值下盒子稳定）
          OM.superpositionIsoRadius(terms, iso, zc) * 1.12, // ★ 还要装得下当前阈值对应的等值面
          //    （阈值越低面越大；少了这一项，低阈值下曲面会被盒子切出平边）
          1.5)
        : Math.max(OM.isoRadius(n, l, m, mode, iso, zc) * 1.12, 1.2));
    // ★ 这里**只分配、不发布**。发布（把这几组数组挂成模块级状态）推迟到填场完成的
    //   那一刻，见 commitField —— 切片之后"准备"与"填完"之间隔着几十帧，中途被新的
    //   重建取消时，模块里就会留下一个**半填的场**；而"只改阈值"那条复用路径
    //   （fieldSpec 为 null）会径直拿模块级的 field 去抽等值面，抽出一团乱东西。
    const nG = res;
    const NN = nG * nG * nG;               // 节点总数
    const fld = new Float32Array(NN);
    const gx = new Float32Array(NN), gy = new Float32Array(NN), gz = new Float32Array(NN);
    // ★ 性能：|ψ|² 的主力开销是径向部分（pow + exp + 拉盖尔递推）。
    //   固定 (n,l) 下用 R² 查表替代，并把坐标预计算、用 sqrt 替代较慢的 hypot。
    const psi2Fast = useSuper
      ? (function () {
          const phases = terms.map((t, i) => i * (relPhase || 0));
          return function (r, theta, phi) { return OM.densitySuperposition(terms, r, theta, phi, phases, zc); };
        })()
      : OM.makePsiDensityFast(n, l, m, mode, extent * 1.8, zc);
    const xs = makeAxisCoords(nG, extent, grading || 0);
    const desc = {
      n: n, l: l, m: m, mode: mode, res: nG, Z: zc,
      // level 只进 desc（供排障读出"这份场是按哪个阈值定盒子算的"），不进指纹 —— 见 keyOf
      level: level, extent: extent,
      terms: termsSig(terms), relPhase: useSuper ? (relPhase || 0) : 0, grading: grading || 0,
    };
    return {
      nGrid: nG, extent, field: fld, gradX: gx, gradY: gy, gradZ: gz, xs, psi2Fast,
      k: 0, maxVal: 0, phase: 0,          // phase 0 = 填场，1 = 算梯度
      desc: desc, key: fieldKeyOf(desc),
    };
  }

  /** 叠加态的指纹：系数与量子数都要进 —— 只比个数会让"换了系数"被当成同一份场 */
  function termsSig(terms) {
    if (!terms || !terms.length) return '-';
    return terms.map((t) => t.n + ',' + t.l + ',' + t.m + ',' + (t.mode || '') + ',' +
      t.c.re.toFixed(9) + ',' + t.c.im.toFixed(9)).join(';');
  }

  /**
   * 标量场的**参数指纹**：描述"这份场是对哪个函数、在哪套配置下采出来的"。
   * ★ 刻意**不含阈值**。阈值只决定采样盒的大小，而"盒子还装不装得下新阈值对应的面"
   *   由调用方按 gridExtent 判断（见 setSurfaceLevel 的 needGrow / needShrink）——
   *   那正是"拖阈值时复用缓存场、不重算"这条流畅度优化成立的地方。把阈值放进指纹
   *   等于每动一下滑块就重算一次场，把优化废掉。
   */
  function fieldKeyOf(d) {
    return [d.n, d.l, d.m, d.mode, d.res, d.Z, d.terms,
      +(+d.relPhase).toPrecision(12), d.grading].join('|');
  }

  /**
   * 把一次算好的场"发布"成模块级的当前场。
   *
   * ★ 发布点必须定在**填场完成的那一刻**，而不是 prepareField 里。原因是切片引入了
   *   原同步版本不存在的中间态：prepareField 之后、填完之前，这个场是不可用的。
   *   若在 prepare 时就挂上去，一次被取消的重建会把模块级的 field / gridExtent /
   *   nGrid 留在"新盒子 + 半填内容"的状态上，而后续"复用缓存场"的抽取（只改阈值、
   *   只改着色）读的正是这几个模块级量 —— 结果是一团没有意义的曲面，而且不报错。
   *   梯度数组此时已分配好（还没算），抽取阶段在梯度算完之后才开始读它，故一并发布。
   * ★ 同时发布"这一份场是什么"（fieldKey / fieldDesc）。只发布数组本身是不够的：
   *   复用缓存场的那条路必须先确认**缓存的那一份就是现在要的那一份**。
   *   切片之后这个前提不再自动成立 —— 一次正在进行、尚未发布的重建会让模块里留着
   *   上一套配置的场，而调用方以为它是最新的。
   */
  function commitField(ctx, mx) {
    nGrid = ctx.nGrid; gridExtent = ctx.extent; gridXs = ctx.xs;
    field = ctx.field; gradX = ctx.gradX; gradY = ctx.gradY; gradZ = ctx.gradZ;
    fieldMax = mx;
    fieldKey = ctx.key; fieldDesc = ctx.desc;
  }

  /** 推进一层：phase 0 填场、phase 1 算梯度。返回 false 表示整场（含梯度）已就绪。 */
  function stepField(ctx) {
    const n = ctx.nGrid;
    if (ctx.phase === 0) {
      const k = ctx.k;
      const z = ctx.xs[k], zz = z * z;
      const kBase = k * n * n;
      let mx = ctx.maxVal;
      for (let j = 0; j < n; j++) {
        const y = ctx.xs[j];
        const yy = y * y + zz;
        const jBase = kBase + j * n;
        for (let i = 0; i < n; i++) {
          const x = ctx.xs[i];
          const r = Math.sqrt(x * x + yy);
          const theta = r > 1e-9 ? Math.acos(Math.max(-1, Math.min(1, z / r))) : 0;
          const phi = Math.atan2(y, x);
          const v = ctx.psi2Fast(r, theta, phi);
          ctx.field[jBase + i] = v;
          if (v > mx) mx = v;
        }
      }
      ctx.maxVal = mx;
      // 整场填完 → **此刻才发布**（见 commitField）并转去算梯度
      if (++ctx.k >= n) { ctx.phase = 1; ctx.k = 0; commitField(ctx, mx); }
      return true;
    }
    gradientLayer(ctx, ctx.k);
    if (++ctx.k >= n) return false;      // 梯度也走完 → 整场就绪
    return true;
  }

  // 提取等值面，返回 BufferGeometry
  /**
   * 行进四面体抽取等值面。
   *
   * @param {number} iso          等值面的绝对值（|ψ|²）
   * @param {number} [maskR]      >0 时启用球形掩膜（半径，世界单位）
   * @param {boolean} [keepInside] true=只处理"**至少一个角在球内**"的单元（细网格用）；
   *                              false=只处理"**所有角都在球外**"的单元（粗网格用）。
   *
   * ★ 掩膜用来做"局部精细化"：两套网格的单元集合必须**互斥且完整覆盖**，否则两片
   *   曲面会在交界处各画一遍 → 重叠、z-fighting、碎三角片。
   *
   * ★ 判据取"单元**离原点最近的角**"，含义是"这个单元有没有一部分落在球内"：
   *     · 粗网格只保留"完全在球外"的单元。由凸性，该单元内**所有点**到原点的距离
   *       都 > maskR；而 maskR 落在两层壳之间的**空档**里（见 math.js 的 shellGaps），
   *       所以这样的单元**不可能**含内层壳的曲面 —— 越界重叠从根上消除。
   *     · 三轴可分离：最近角距² = Σ_a min(X_a[t]², X_a[t+1]²)，不必枚举 8 个角。
   *   演进史（两次都栽在"球面上无曲面 ≠ 单元里无曲面"上）：曾用"最远的角"，
   *   把跨界单元整格推给粗网格 → 重叠；改用"单元中心"只保证了"中心落在内侧"的
   *   那一半，另一半跨界单元仍漏给粗网格（实测 |ψ| 判据 1% 下碎成 572 片）。
   */
  function prepareExtract(iso, maskR, keepInside) {
    const n = nGrid;
    const n2 = n * n;
    const X = gridXs;                  // 节点坐标（均匀或径向渐变）
    // 掩膜：每个单元**离原点最近的角**在各轴上的坐标平方（三轴独立，可分离求和）
    const useMask = maskR > 0;
    const maskR2 = maskR * maskR;
    let cArr = null;
    if (useMask) {
      cArr = new Float64Array(n);
      for (let t = 0; t < n; t++) {
        const a2 = X[t] * X[t], b2 = X[t + 1] * X[t + 1];
        cArr[t] = (a2 < b2) ? a2 : b2;                 // 该轴上更靠近原点的那个角
      }
    }

    // ★ 性能关键：本函数在 68³ 网格上要扫约 30 万个单元、输出上百万个顶点。
    //   原实现每个单元都在 map / filter / findIndex 里分配数组，GC 压力巨大。
    //   现在是**零分配**：角点 id 直接算、交点直接写入输出数组、绕向判定用局部变量。
    const positions = [];
    const normals = [];
    const indices = [];
    const cross = new Int32Array(4);   // 复用：存放交点顶点下标

    /** 求线段 (a,b) 与等值面的交点，直接写入 positions/normals，返回新顶点下标 */
    const emitVertex = (idA, idB) => {
      const va = field[idA], vb = field[idB];
      let t = (iso - va) / (vb - va);
      if (!isFinite(t)) t = 0.5;

      const ka = (idA / n2) | 0, ra = idA - ka * n2, ja = (ra / n) | 0, ia = ra - ja * n;
      const kb = (idB / n2) | 0, rb = idB - kb * n2, jb = (rb / n) | 0, ib = rb - jb * n;
      const ax = X[ia], ay = X[ja], az = X[ka];
      const bx = X[ib], by = X[jb], bz = X[kb];

      const gi = positions.length / 3;
      positions.push(ax + t * (bx - ax), ay + t * (by - ay), az + t * (bz - az));
      normals.push(
        gradX[idA] + t * (gradX[idB] - gradX[idA]),
        gradY[idA] + t * (gradY[idB] - gradY[idA]),
        gradZ[idA] + t * (gradZ[idB] - gradZ[idA])
      );
      return gi;
    };

    /** 按"一致朝外"绕向写入三角形（几何法线与梯度法线对齐，否则交换顶点序） */
    const pushTri = (i0, i1, i2) => {
      const p0 = i0 * 3, p1 = i1 * 3, p2 = i2 * 3;
      const ax = positions[p1] - positions[p0], ay = positions[p1 + 1] - positions[p0 + 1], az = positions[p1 + 2] - positions[p0 + 2];
      const bx = positions[p2] - positions[p0], by = positions[p2 + 1] - positions[p0 + 1], bz = positions[p2 + 2] - positions[p0 + 2];
      const gnx = ay * bz - az * by, gny = az * bx - ax * bz, gnz = ax * by - ay * bx;
      const onx = normals[p0] + normals[p1] + normals[p2];
      const ony = normals[p0 + 1] + normals[p1 + 1] + normals[p2 + 1];
      const onz = normals[p0 + 2] + normals[p1 + 2] + normals[p2 + 2];
      if (gnx * onx + gny * ony + gnz * onz >= 0) indices.push(i0, i1, i2);
      else indices.push(i0, i2, i1);
    };

    // ★ 拆成"准备 + 逐层推进"是为了让 Sched 把抽取摊到多帧里跑完（原来是一次 ~150ms 的同步块）。
    //   推进粒度是**一层 k**（67 层 × 每层约 4500 个单元）；单元之间没有任何依赖
    //   （每个单元独立 emitVertex、pushTri 只读本单元刚写的顶点），所以各层按 k 升序拼接
    //   得到的顶点/索引顺序**与不切片时逐位一致**。
    return {
      n, n2, X, iso, useMask, maskR2, cArr, keepInside,
      positions, normals, indices, emitVertex, pushTri,
      cIds: new Int32Array(8), in4: new Uint8Array(4), tIds: new Int32Array(4),
      cross, k: 0,
    };
  }

  /** 推进一层 k。返回 false 表示所有单元都已扫完。 */
  function stepExtract(ctx) {
    const n = ctx.n, n2 = ctx.n2, X = ctx.X, useMask = ctx.useMask;
    const field_ = field;
    const k = ctx.k;
    const kBase = k * n2;
    const kz2 = useMask ? ctx.cArr[k] : 0;
    const cIds = ctx.cIds, in4 = ctx.in4, tIds = ctx.tIds, cross = ctx.cross;
    const emitVertex = ctx.emitVertex, pushTri = ctx.pushTri;
    for (let j = 0; j < n - 1; j++) {
      const jBase = kBase + j * n;
      const jy2 = useMask ? kz2 + ctx.cArr[j] : 0;
      for (let i = 0; i < n - 1; i++) {
        if (useMask) {
          // 最近角在球内 ⟺ 该单元有一部分在球内 → 归细网格；否则整格在球外 → 归粗网格
          const inside = (jy2 + ctx.cArr[i]) <= ctx.maskR2;
          if (inside !== !!ctx.keepInside) continue;
        }
        const p = jBase + i;
        // 8 个角点的全局 id：直接算，不再每格 map 一次
        cIds[0] = p;              cIds[1] = p + 1;
        cIds[2] = p + 1 + n;      cIds[3] = p + n;
        cIds[4] = p + n2;         cIds[5] = p + 1 + n2;
        cIds[6] = p + 1 + n + n2; cIds[7] = p + n + n2;

        for (let t = 0; t < 6; t++) {
          const T = TETS[t];
          let cnt = 0;
          for (let e = 0; e < 4; e++) {
            const id = cIds[T[e]];
            tIds[e] = id;
            const ins = field_[id] >= ctx.iso ? 1 : 0;
            in4[e] = ins;
            cnt += ins;
          }
          if (cnt === 0 || cnt === 4) continue;

          if (cnt === 1 || cnt === 3) {
            // 唯一的"异类"顶点：cnt=1 时是内部点，cnt=3 时是外部点
            let odd = 0;
            for (let e = 0; e < 4; e++) {
              if ((cnt === 1) === (in4[e] === 1)) { odd = e; break; }
            }
            let m = 0;
            for (let e = 0; e < 4; e++) if (e !== odd) cross[m++] = emitVertex(tIds[odd], tIds[e]);
            pushTri(cross[0], cross[1], cross[2]);
          } else {
            let i0 = -1, i1 = -1, o0 = -1, o1 = -1;
            for (let e = 0; e < 4; e++) {
              if (in4[e]) { if (i0 < 0) i0 = e; else i1 = e; }
              else { if (o0 < 0) o0 = e; else o1 = e; }
            }
            const pac = emitVertex(tIds[i0], tIds[o0]);
            const pad = emitVertex(tIds[i0], tIds[o1]);
            const pbc = emitVertex(tIds[i1], tIds[o0]);
            const pbd = emitVertex(tIds[i1], tIds[o1]);
            pushTri(pac, pbc, pbd);
            pushTri(pac, pbd, pad);
          }
        }
      }
    }
    ctx.k++;
    return ctx.k < n - 1;
  }

  /** 全部单元扫完后建几何（法线来自梯度、方向朝外；绕向已在 pushTri 中强制一致）。 */
  function extractBuildGeometry(ctx) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(ctx.positions, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(ctx.normals, 3));
    geo.setIndex(ctx.indices);
    geo.computeBoundingSphere();
    return geo;
  }

  /**
   * 把"占峰值的比例"换算成 |ψ|² 的绝对阈值。
   *
   * 两种判据给出的是同一族曲面（|ψ| = c ⟺ |ψ|² = c²），差别只在**读数的含义**：
   *   · 按 |ψ|² 计：|ψ|² = f·|ψ|²max
   *   · 按 |ψ|  计：|ψ|  = f·|ψ|max  ⟹  |ψ|² = f²·|ψ|²max
   * 故同一读数下（f<1），|ψ| 判据对应 f²·峰值，比 |ψ|² 判据更小 → 得到**更大**的表面。
   * 这正是切换按钮能被看出来差别的原因。
   */
  function levelAbsFor(P, fraction, psiCrit) {
    // ★ 换算本体已收到 math.js 的 OM.isoLevelAbs（唯一出口）—— 这里只做一次转接。
    //   原先换算写在本函数里，而"真正抽等值面"那一行**自己又写了一遍**（还写错了），
    //   于是同一读数在面板上与画面上是两个不同的面。见 OM.isoLevelAbs 的说明。
    return OM.isoLevelAbs(P.n, P.l, P.m, P.mode, P.Z, P.terms, fraction, psiCrit);
  }

  function setSurfaceLevel(fraction, colorMode, psiCrit) {
    if (!field || !surfaceParams) return;
    const P = surfaceParams;
    const colorChanged = (colorMode != null && colorMode !== currentColorMode);
    const critChanged = (psiCrit != null && psiCrit !== surfaceParams.psiCrit);
    if (psiCrit != null) surfaceParams.psiCrit = psiCrit;
    const levelChanged = Math.abs(fraction - surfaceLevelFraction) > 1e-9;
    surfaceLevelFraction = fraction;
    if (colorMode != null) currentColorMode = colorMode;
    if (levelChanged || critChanged || !surfaceObj) {
      // 阈值变化会改变等值面外延：范围变化超过 12% 才重建标量场，
      // 否则复用已缓存的场（拖动阈值滑块时多数步都走这条路，保持流畅）
      const levelAbs = levelAbsFor(P, fraction, P.psiCrit);
      // ★ 这里必须与 computeField 内部的取范围口径**完全一致**，否则判断的是 A 的尺寸、
      //   重建的是 B 的盒子。两处不一致会同时造成两种故障：该重建时没重建（画面不动），
      //   不该重建时重建（盒子跳变）。
      const expectedExtent = (P.terms && P.terms.length)
        ? Math.max(
            OM.superpositionRefExtent(P.terms) * 1.15,
            OM.superpositionIsoRadius(P.terms, levelAbs) * 1.12,
            1.5)
        : Math.max(OM.isoRadius(P.n, P.l, P.m, P.mode, levelAbs) * 1.12, 1.2);
      // ★ 增长方向**不留容差**：盒子装不下曲面时，哪怕只差 3% 也会切出平边
      //   （实测 5% 阈值下差 3.7% 就足以顶到盒边）。缩小方向才留 12% 容差，
      //   避免阈值来回拖时盒子跟着抖。
      const needGrow = expectedExtent > gridExtent;
      const needShrink = expectedExtent < gridExtent * 0.88;
      // ★ 还要核对"缓存的那份场是不是现在要的那份"。
      //   切片之前这个前提自动成立；切片之后"准备"与"发布"之间隔着几十帧，
      //   若上一次重建还没发布就被新的调用打断，模块里留着的是**上一套配置**的场
      //   （例如刚从 3p_z 切到 3d_z²，场却还是 3p_z 的），此时复用等于拿错函数抽面。
      //   实测就是这样：3d_z² 的盒子 16.69 与 |ψ|² 峰值 7.68e-4 都在，但发布出去的
      //   是 3p_z 的场（峰值 1.67e-3、盒子 13.46）—— 抽出的面看起来"还是那个轨道"，
      //   尺寸却对不上，且不报任何错。
      const sameField = (fieldKey === fieldKeyOf({
        n: P.n, l: P.l, m: P.m, mode: P.mode, res: lastRes,
        Z: (P.Z > 0) ? P.Z : 1, terms: termsSig(P.terms),
        relPhase: (P.terms && P.terms.length) ? (P.relPhase || 0) : 0, grading: 0,
      }));
      // ★ 需要重算场时，把参数**交给流水线**去做第一段，而不是在这里同步算掉 ——
      //   这一算原来是 ~100ms 的硬阻塞，正是"拖阈值卡一下"的主要来源。
      //   terms / relPhase 必须一起传下去：漏了它们，重算会把叠加态当成单一本征态
      //   （盒子按单轨道定尺寸、可塌到 1.2 的下限，内容也不是叠加态），
      //   "叠加态一调阈值体积就变 0"就是这么来的。
      const fieldSpec = (!surfaceObj || critChanged || needGrow || needShrink || !sameField)
        ? [P.n, P.l, P.m, P.mode, lastRes, levelAbs, P.terms, P.relPhase, 0, 0, P.Z]
        : null;
      // ★ 取景交给流水线收尾时做（'decor'）：阈值低到曲面胀出当前取景时必须拉远，
      //   否则曲面被裁。fitViewIfNeeded 只在"尺度真的变了"时才动相机，故常见阈值
      //   区间（≥30% 参考水平）仍是相机纹丝不动，只有往低调时才逐步拉远。
      rebuildSurface(false, fieldSpec, 'decor');
    } else if (colorChanged && surfaceGeoRef) {
      paintSurfaceColors(surfaceGeoRef);
      // ★ 局部精细化的补片是**另一块网格**，必须一起重涂。
      //   漏了这一步，切三维着色时外层壳（粗网格画）会变色、内层壳（细网格画）
      //   却保持旧色，看起来像"只改了一半"。
      if (fineObj) paintSurfaceColors(fineObj.geometry);
    }
  }

  /**
   * @param {number} levelFraction 阈值（占参考峰值的比例）
   * @param {boolean} refit 是否重新取景
   * @param {Array} [fieldSpec] 需要重算标量场时给出的参数数组（见 rebuildSurface）
   */
  function buildSurface(levelFraction, refit, fieldSpec) {
    // ★ 守卫要放行"这一次会现算场"的情形：切片之后 field 是在流水线里才产生的，
    //   首次调用时它还是 null —— 用老写法 `if (!field) return` 会第一次就不建面。
    if (!field && !fieldSpec) return;
    surfaceLevelFraction = levelFraction;
    rebuildSurface(!!refit, fieldSpec || null);
  }

  /**
   * 为等值面顶点着色（与点云共用同一套配色）：
   *   'phase'   —— 按相位着色：复函数取 arg ψ（彩虹相位缠绕）；实函数取符号（± 双色）
   *   'orbital' —— 按支壳层 l 的轨道基础色
   * 等值面上 |ψ|² 恒等于阈值，故强度取固定值，让相位/轨道色本身成为主要视觉信息。
   */
  function paintSurfaceColors(geo) {
    const posAttr = geo.getAttribute('position');
    const cnt = posAttr.count;
    const colors = new Float32Array(cnt * 3);
    const base = OM.lColor(currentL || 0);
    const P = surfaceParams;
    if (currentColorMode === 'phase' && P) {
      const phases = P.terms ? P.terms.map((t, k) => k * (P.relPhase || 0)) : null;
      for (let i = 0; i < cnt; i++) {
        const x = posAttr.getX(i), y = posAttr.getY(i), z = posAttr.getZ(i);
        const r = Math.hypot(x, y, z);
        const th = r > 1e-9 ? Math.acos(Math.max(-1, Math.min(1, z / r))) : 0;
        const ph = Math.atan2(y, x);
        // 相位色的判据收敛到 OM.psiPhase 一处 —— 原先这里三个分支各写一遍，结果
        // **复函数分支漏掉了 R(r)**（写成 arg(angularComplex)），径向节点两侧不变色。
        // 实测 4p：实函数档是红蓝红蓝红蓝（正确），复函数档是红红红蓝蓝蓝（错误）。
        // 判据写三遍迟早分叉，现在只有一处定义（见 math.js 的说明）。
        const col = OM.phaseColor(
          OM.psiPhase(P.mode, P.n, P.l, P.m, r, th, ph, P.terms, phases), 0.62);
        colors[3 * i] = col[0]; colors[3 * i + 1] = col[1]; colors[3 * i + 2] = col[2];
      }
    } else {
      for (let i = 0; i < cnt; i++) {
        colors[3 * i] = base[0]; colors[3 * i + 1] = base[1]; colors[3 * i + 2] = base[2];
      }
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    if (geo.getAttribute('normal')) geo.getAttribute('normal').needsUpdate = true;
  }

  // 单次 step() 里最多处理多少个元素。
  //
  // ★ 这个数字是**切片粒度的真正所在**：Sched 的契约是"step() 返回 true 就立刻再调
  //   一次，直到本帧预算用完"，所以"切得细不细"取决于单次 step 干多少活，而不在于
  //   写了多少个 phase。若某个阶段一口气扫完整个数组（哪怕它挂在切片框架里），
  //   那它依然是一个上百毫秒的阻塞块 —— 等于没切。
  // ★ 取值只影响"什么时候算"，不影响"算什么"：这些阶段全是按固定顺序的纯写入，
  //   一批处理 4096 个还是 400 万个，结果逐位相同。
  const CHUNK_V = 4096;        // 顶点数（平滑 / 焊接）
  const CHUNK_TRI = 2048;      // 三角形数（度数统计 / 邻接填充）

  // 顶点平滑（Taubin λ-μ 迭代）：松弛行进四面体产生的离散凹凸，使表面光滑且体积基本不变
  /**
   * 顶点平滑（Taubin λ-μ 迭代）的准备阶段。
   *
   * ★ 拆成"准备 + 逐段推进"是为了让 Sched 摊到多帧里跑完（原本是一次 10–100ms 的同步块）。
   *   三段各有自己的切片边界：
   *     phase 0 统计各顶点度数 —— 按三角形区间推进；
   *     phase 1 建邻接表     —— 先一次前缀和（单步、很快），再按三角形区间填充；
   *     phase 2+ 逐轮平滑    —— 每轮内按顶点区间推进，**轮与轮之间是硬屏障**
   *                             （positions 被原地覆盖，下一轮读的是上一轮的结果）。
   *   邻接填充按三角形**升序**处理、与不切片时同序，故结果逐位一致。
   */
  function prepareSmooth(positions, indices, iterations) {
    const nv = positions.length / 3;
    return {
      positions, indices, nv, iterations,
      deg: new Uint32Array(nv), off: null, adj: null, tmp: null,
      i: 0, it: 0, phase: 0,
    };
  }

  /** 推进一段。返回 false 表示平滑全部做完（positions 已就地更新）。 */
  function stepSmooth(ctx) {
    const { positions, indices, nv } = ctx;
    if (ctx.phase === 0) {
      const end = Math.min(ctx.i + CHUNK_TRI * 3, indices.length);
      for (let i = ctx.i; i < end; i += 3) {
        ctx.deg[indices[i]]++; ctx.deg[indices[i + 1]]++; ctx.deg[indices[i + 2]]++;
      }
      ctx.i = end;
      if (end < indices.length) return true;        // 这一批扫完，下一批接着扫
      ctx.i = 0; ctx.phase = 1;
      return true;
    }
    if (ctx.phase === 1) {
      if (!ctx.off) {
        // 前缀和 + 把 deg 复用为写入游标 —— 单步完成（O(nv)，很快）
        const off = new Int32Array(nv + 1);
        for (let v = 0; v < nv; v++) off[v + 1] = off[v] + ctx.deg[v];
        ctx.off = off;
        ctx.adj = new Int32Array(off[nv]);          // 按总度数分配，绝不越界
        for (let v = 0; v < nv; v++) ctx.deg[v] = 0;
        ctx.tmp = new Float32Array(positions.length);
        ctx.i = 0;
        return true;
      }
      const off = ctx.off, deg = ctx.deg, adj = ctx.adj;
      const put = (u, w) => { let ok = true; for (let k = off[u]; k < off[u] + deg[u]; k++) if (adj[k] === w) { ok = false; break; } if (ok) adj[off[u] + deg[u]++] = w; };
      const end = Math.min(ctx.i + CHUNK_TRI * 3, indices.length);
      for (let i = ctx.i; i < end; i += 3) {
        const a = indices[i], b = indices[i + 1], c = indices[i + 2];
        put(a, b); put(a, c); put(b, a); put(b, c); put(c, a); put(c, b);
      }
      ctx.i = end;
      if (end < indices.length) return true;
      ctx.i = 0; ctx.phase = 2;
      return true;
    }
    // phase 2..：第 (phase-2) 轮平滑
    const it = ctx.phase - 2;
    const lambda = (it % 2 === 0) ? 0.5 : -0.53;    // Taubin: 交替正负
    const deg = ctx.deg, off = ctx.off, adj = ctx.adj, tmp = ctx.tmp;
    const end = Math.min(ctx.i + CHUNK_V, nv);
    for (let v = ctx.i; v < end; v++) {
      const d = deg[v] || 1;
      let cx = 0, cy = 0, cz = 0;
      for (let k = off[v]; k < off[v] + deg[v]; k++) {
        const u = adj[k];
        cx += positions[3 * u]; cy += positions[3 * u + 1]; cz += positions[3 * u + 2];
      }
      tmp[3 * v] = positions[3 * v] + lambda * (cx / d - positions[3 * v]);
      tmp[3 * v + 1] = positions[3 * v + 1] + lambda * (cy / d - positions[3 * v + 1]);
      tmp[3 * v + 2] = positions[3 * v + 2] + lambda * (cz / d - positions[3 * v + 2]);
    }
    ctx.i = end;
    if (end < nv) return true;                       // 本轮没走完，下一批接着走
    positions.set(tmp);                              // 本轮结束才写回 —— 轮间硬屏障
    ctx.i = 0; ctx.phase++;
    return ctx.phase - 2 < ctx.iterations;
  }

  /**
   * 焊接"三角形汤"为真正的索引网格的准备阶段（合并重复顶点、法线取平均后归一化）。
   *
   * ★ 拆段的理由同其它重活：原本一次 10–100ms 的同步块。
   *   三段：phase 0 去重（按顶点区间）、phase 1 索引重映射（按索引区间）、
   *   phase 2 法线归一化（按焊接后顶点区间）。
   *   ★ 去重**必须按升序、共用同一个 Map** —— 顶点 id 是按"首次出现顺序"分配的，
   *     分成几片各建一个 Map 会让接缝处的重复顶点不被合并（法线不平均），结果就变了。
   *     切片只省"单次阻塞时长"，不省工作量。
   */
  function prepareWeld(positions, normals, indices) {
    const npos = positions.length / 3;
    return {
      positions, normals, indices, npos,
      map: new Map(), wp: [], wn: [], wmap: new Array(npos), win: null,
      i: 0, phase: 0, PREC: 1e4,
    };
  }

  /** 推进一段。返回 false 表示焊接完成，可用 weldResult(ctx) 取结果。 */
  function stepWeld(ctx) {
    const { positions, normals, indices, map, wp, wn, wmap } = ctx;
    if (ctx.phase === 0) {
      const P = ctx.PREC;
      const end = Math.min(ctx.i + CHUNK_V, ctx.npos);
      for (let i = ctx.i; i < end; i++) {
        const key = Math.round(positions[3 * i] * P) + '_' +
                    Math.round(positions[3 * i + 1] * P) + '_' +
                    Math.round(positions[3 * i + 2] * P);
        let id = map.get(key);
        if (id === undefined) {
          id = wp.length / 3;
          map.set(key, id);
          wp.push(positions[3 * i], positions[3 * i + 1], positions[3 * i + 2]);
          wn.push(normals[3 * i], normals[3 * i + 1], normals[3 * i + 2]);
        } else {
          wn[3 * id] += normals[3 * i];
          wn[3 * id + 1] += normals[3 * i + 1];
          wn[3 * id + 2] += normals[3 * i + 2];
        }
        wmap[i] = id;
      }
      ctx.i = end;
      if (end < ctx.npos) return true;               // 这一批去重完，下一批接着来
      // ★ Map 是跨批共享的，且必须按**升序**处理 —— 顶点 id 按"首次出现顺序"分配，
      //   分批各建一个 Map 会让接缝处的重复顶点合不上（法线不平均），结果就变了。
      //   分批只省"单次阻塞时长"，不省工作量。
      ctx.i = 0; ctx.phase = 1;
      return true;
    }
    if (ctx.phase === 1) {
      if (!ctx.win) { ctx.win = new Uint32Array(indices.length); return true; }
      const end = Math.min(ctx.i + CHUNK_V * 3, indices.length);
      for (let i = ctx.i; i < end; i++) ctx.win[i] = wmap[indices[i]];
      ctx.i = end;
      if (end < indices.length) return true;
      ctx.i = 0; ctx.phase = 2;
      return true;
    }
    const nv = wp.length / 3;
    const end = Math.min(ctx.i + CHUNK_V, nv);
    for (let v = ctx.i; v < end; v++) {
      const len = Math.hypot(wn[3 * v], wn[3 * v + 1], wn[3 * v + 2]) || 1;
      wn[3 * v] /= len; wn[3 * v + 1] /= len; wn[3 * v + 2] /= len;
    }
    ctx.i = end;
    if (end < nv) return true;
    return false;
  }

  function weldResult(ctx) {
    return {
      positions: new Float32Array(ctx.wp),
      normals: new Float32Array(ctx.wn),
      indices: ctx.win,
    };
  }

  /** 焊接平滑后的顶点 → 可渲染网格（着色 + 材质）。粗网格与精细化补片共用这一段，
   *  两片的着色/材质必须完全一致，否则接缝处颜色会对不上。 */
  function meshFromWelded(welded) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(welded.positions, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(welded.normals, 3));
    g.setIndex(new THREE.BufferAttribute(welded.indices, 1));
    g.computeBoundingSphere();
    paintSurfaceColors(g);
    const m = new THREE.MeshStandardMaterial({
      color: 0xffffff, vertexColors: true, roughness: 0.5, metalness: 0.0, side: THREE.DoubleSide,
    });
    return new THREE.Mesh(g, m);
  }

  // ---------------------------------------------------------------------------
  // 局部精细化（细颈）
  //
  // 问题：单个均匀网格要同时装下 ~27a₀ 的外层瓣和 ~0.3a₀ 的窄缝。实测 4p 在 3.5%
  // 阈值下，最内层壳的赤道缝隙只有 0.274 a₀，而单元格是 0.82 a₀ —— 缝隙比单元格
  // 还小，网格根本分辨不出，于是把上下两瓣连成一个"花生"。放多大都救不了：把分辨
  // 率翻倍只把缝隙从 1/3 格变成 2/3 格。
  //
  // 做法：**在径向节点球内换一张更细的网格**。
  //   · 粗网格跳过"整格在节点球内"的单元，细网格只填这些单元 → 两边单元集合互斥
  //     且完整覆盖，因此不重叠也不留缝；
  //   · 球面正好取在径向节点上，那里 |ψ|²=0、本来就没有曲面 → **天然无接缝**。
  //     （这就是不采用"只在切点附近挖个小盒"的原因：小盒边界会横穿曲面，
  //       粗细两套网格在边界处不共形，会露出细缝。）
  // ---------------------------------------------------------------------------
  // 细网格分辨率上限。窄屏（同 main.js 的 isMobile 口径）下调一档。
  // ★ 112 不是随手取的：它同时是"外侧壳间空档能不能过关卡①"的分水岭。
  //   实测 5d_{x²−y²} 在 0.784% 下，外侧空档（r=24.2、缝 0.67）需要 res≈122 才能
  //   把细网格单元的外伸限制在空档内，上限 112 时它被拒、补片只能退到内侧空档
  //   （r=10.9），r>10.9 的中间层与外壳就全留给粗网格（格距 1.75 a₀，比细颈还宽）。
  //   而把上限提到 128 让外侧空档过关后，**并没有更好**：几何只小幅改善（中间层内缘
  //   从 0.38 格/缝提到 1.43 格/缝），却把补片推到可见区、在交界处引入新的接缝
  //   （实测：内部色阶突跳 +21%，且集中在一条窄竖带上——那是接缝而非纹理），
  //   同时多付 50% 的内存与时间。故保持 112。
  const FINE_RES_MAX = window.matchMedia('(max-width: 768px)').matches ? 96 : 112;
  const FINE_SETTLE_MS = 450;    // 距上次重建小于此值视为"用户还在连续调整"
  let fineObj = null;            // 精细化补出来的那块曲面
  let lastRebuildAt = 0;
  let fineRetryTimer = null;

  /**
   * 拖阈值时每一步都会重建，细网格要多花约 0.7 秒，连续拖动会明显发卡。
   * 所以：**连续调整期间先跳过精细化，停下来后自动补一次**。
   * 关键是"补一次"——否则跳过之后就再也没人触发重建，细网格永远不出现。
   * ★ 这次重试必须走一个**显式的"我是补精细化来的"入口**（forceFine）：否则它自己会
   *   把"刚重建过"的时间戳刷新，planFinePatch 于是又判定"用户还在调整"、又排一次重试，
   *   无限推迟、细颈永远不出现。实测踩过 —— 8 个用例的细颈补片一夜之间全部消失。
   */
  function scheduleFineRetry() {
    if (fineRetryTimer) return;
    fineRetryTimer = setTimeout(function () {
      fineRetryTimer = null;
      rebuildSurface(false, null, null, true);      // true = 补精细化重试，跳过"还在调整"判据
    }, FINE_SETTLE_MS + 70);
  }

  function disposeFine() {
    if (!fineObj) return;
    scene.remove(fineObj);
    if (fineObj.geometry) fineObj.geometry.dispose();
    if (fineObj.material) fineObj.material.dispose();
    fineObj = null;
  }

  /**
   * 判断是否需要局部精细化，并给出细网格的半径与分辨率；不需要则返回 null。
   * 三个条件同时满足才启用，避免给普通情况白付开销：
   *   ① 单一本征态（叠加态的外延估计是另一套，暂不处理）
   *   ② l ≥ 1 且有径向节点——细颈由**角度节面**造成，径向节点提供无接缝的分界面
   *   ③ 细颈比粗网格单元格还窄——粗网格已经分得开就不必精细化
   */
  function planFinePatch(iso, force) {
    if (window.__ORBIT_PREVIEW__) return null;                 // 拖动中不付这份开销
    // 连续调整期间跳过（见 scheduleFineRetry）：先保证拖动跟手，停下来再补精细化。
    // ★ force 是"这次就是那次补精细化"—— 重试若也受这条判据管，就会自己把自己挡住。
    if (!force && performance.now() - lastRebuildAt < FINE_SETTLE_MS) { scheduleFineRetry(); return null; }
    const P = surfaceParams;
    if (!P || (P.terms && P.terms.length)) return null;
    if (P.l < 1 || P.n - P.l - 1 < 1) return null;
    // ★ 分界球面必须落在"两层壳之间**必然**没有曲面"的位置（见 shellGaps 的推导），
    //   否则两套网格会在交界处各画一遍 → 重叠、z-fighting、碎三角片。
    //   放在径向节点上也**不行**：节点虽然 |ψ|²=0，但两侧的曲面都贴着它，跨界的单元
    //   里照样含曲面。
    const gaps = OM.shellGaps(P.n, P.l, P.m, P.mode, iso, P.Z);
    if (!gaps.length) return null;                             // 只有一层壳 → 无需分层
    const cellCoarse = (2 * gridExtent) / (nGrid - 1);
    // 细网格覆盖到第几层？盒子越大、远处的单元格越粗，所以要权衡：
    //   ① 盖得越多，越多"折角"（壳的内/外边界，曲率最高处）能摆脱粗网格的锯齿；
    //   ② 盒半径 L 越大，同样 112³ 节点摊到每一层就越粗。
    // 从外到内试：优先要覆盖大的方案，但它必须过得了 planFineAt 的两道关。
    //   ★ 粗网格那一侧的越界重叠**已经被判据根治**（extractSurface 现在只保留"完全
    //   在球外"的单元，由凸性它绝不可能扎进内层壳），所以这里只需管细网格一侧。
    const maxR = gaps[0].r * 3;                                // 再大就摊得太薄了
    for (let i = gaps.length - 1; i >= 0; i--) {
      if (gaps[i].r > maxR) continue;
      const plan = planFineAt(P, iso, gaps[i].r, gaps[i].width, cellCoarse);
      if (plan) return plan;
    }
    // 没有任何一层能同时过"不越界"与"分辨率够"两关 → **不做精细化**。
    // ★ 这是有意的取舍：细颈会因此粘连，但那是"分辨率不够"的可理解近似；
    //   强行分层会留下碎三角片，那是明显的渲染错误。宁可前者。
    return null;
  }

  /**
   * 在给定分界半径上算细网格参数。两道关任一不过就返回 null，由调用方继续往内试：
   *   ① 不越界 —— 细网格单元不得伸进外层壳（否则与粗网格各画一遍）
   *   ② 分辨率够 —— 钳位之后核附近的**实际**格距仍要让细颈缝隙跨得开
   */
  function planFineAt(P, iso, radius, width, cellCoarse) {
    const half = OM.isoNeckHalf(P.n, P.l, P.m, P.mode, iso, radius);
    if (!isFinite(half) || !(half > 0)) return null;
    const gap = 2 * half;
    if (gap > 2.5 * cellCoarse) return null;                   // 粗网格分得开，不必精细化
    // 起点：让缝隙跨约 2.5 个细单元格（盒边长 2·radius，故 res ≈ 2·radius/(gap/2.5) = 5·radius/gap）
    const res0 = Math.max(Math.ceil((5 * radius) / gap), nGrid);
    // ★ 然后**往上试**到两道关都过为止，而不是拿估值直接过闸。
    //   理由：上面那个估值只保证**核附近**的格距够细（渐变网格的核最密），
    //   而关卡①管的是盒子**最外层**的格距 —— 外疏内密，两者能差好几倍。
    //   拿核的估值去过外层的闸，低阈值下必然越界，表现就是"阈值一低就不精细化了"：
    //   实测 5f 在 3% 有精细化、降到 1% 就没了，而它只需把 res 从 68 提到 88 就能过。
    //   搜索是单调向上、上限 FINE_RES_MAX，故代价有界（最多几十次纯算术比较）。
    for (let res = Math.min(res0, FINE_RES_MAX); res <= FINE_RES_MAX; res++) {
      const plan = fineAtRes(radius, width, gap, cellCoarse, res);
      if (plan) return plan;
    }
    return null;
  }

  /**
   * 在指定分辨率下算细网格参数；两道关任一不过就返回 null，由调用方提高分辨率再试。
   *   ① 不越界 —— 细网格单元不得伸进外层壳（否则两套网格在接缝处各画一遍 / 露出裂缝）
   *   ② 分辨率够 —— 钳位之后核附近的**实际**格距仍要让细颈缝隙跨得开
   */
  function fineAtRes(radius, width, gap, cellCoarse, res) {
    // ★ 细网格用**径向渐变**坐标。缝隙要跨 ~4 个单元格才不会被焊在一起：
    //   均匀网格在半径 radius 的盒子里做到这点需要 res ≈ 4·2·radius/gap ≈ 190³（≈108MB）；
    //   渐变后同样的节点数足以把核附近的单元格压到 gap/4。
    //   x = L(a·u + (1−a)u³) 在 u=0 处的间距 = L·a·du，由此反解 a。
    const du = 2 / (res - 1);
    const grade = Math.max(0.15, Math.min(1, (gap / 4) / (radius * du)));
    // ★ 关卡①：细网格一侧不得**越界到外层壳**。
    //   细网格处理"至少一个角在球内"的单元，这种单元最远可伸到 r* + 一个全对角线。
    //   要求它 ≤ b = r* + width/2，即 半对角线 ≤ width/4。
    //   格距取径向的（三轴里最大）= radius·(3−2·grade)·du，即渐变坐标 x=L(a·u+(1−a)u³)
    //   在 u=±1 处的导数 × du。
    const cellEdge = radius * (3 - 2 * grade) * du;
    if (0.866 * cellEdge > width / 4) return null;
    // ★ 关卡②：两道钳位（res 撞 FINE_RES_MAX、grade 撞下限 0.15）叠加后，核附近**实际**
    //   的格距可能仍达不到 gap/4 —— 那这个盒子就太大、精细化等于白做（盒子大了而节点数
    //   没变，正是"次外层远不如内部细腻"的原因）。要求缝隙至少跨 3 格，达不到就退回更小的盒子。
    const cellCore = radius * grade * du;
    if (gap / cellCore < 3) return null;
    return { radius: radius, res: res, gap: gap, cellCoarse: cellCoarse, grade: grade };
  }

  /** 细颈阶段要临时顶替的模块级场量 —— 存 / 还原（见 rebuildSurface 的分帧说明） */
  function fineSave() {
    return { field: field, gx: gradX, gy: gradY, gz: gradZ,
             n: nGrid, ext: gridExtent, mx: fieldMax, xs: gridXs,
             key: fieldKey, desc: fieldDesc };
  }
  function fineRestore(s) {
    field = s.field; gradX = s.gx; gradY = s.gy; gradZ = s.gz;
    nGrid = s.n; gridExtent = s.ext; fieldMax = s.mx;
    // ★ gridXs 也必须还原：粗网格后续的抽取（如换阈值时复用缓存场）仍要用它。
    //   漏了这一步，粗网格会用细网格的渐变坐标去解释自己的场 → 形状整体错乱。
    gridXs = s.xs;
    // ★ "这一份场是什么"也要还原 —— 它和数组是一体的：发布了数组却留着细网格的
    //   指纹，下一次复用判断就会把粗网格的场误认成细网格的场（或反之）。
    fieldKey = s.key; fieldDesc = s.desc;
  }

  let rebuildHandle = null;      // 在飞的重建任务
  let pendingRebuild = null;     // 拖动中后来的请求：排队覆盖（见 rebuildSurface 的说明）

  /**
   * 等值面重建的**分帧管线**。这是本次"渲染不卡顿"改动的核心。
   *
   * 原本这是一条同步流水：dispose 旧面 → 抽面 → 焊接 → 平滑 → 建 mesh → 细颈，
   * 一次 200–700ms 全部占住主线程（自动旋转停住、按钮点不动、拖滑块不跟手）。
   * 现在每个阶段都拆成"一次推进一层 k / 一段区间"，交给 `Sched` 按每帧预算批，
   * 结果分帧长出来 —— 相机阻尼与输入全程不被打断。
   *
   * ★ 三条不变量：
   *   ① **新的几何全部就绪后才替换旧的**。原实现是先 dispose 再慢慢算，
   *      切片后这个空窗会持续十几帧、画面会空掉。现在粗面一算完就换上去，
   *      细颈随后分帧补 —— 用户先看到略糙的完整形状，再看到它变精细。
   *   ② **新的重建取消在飞的那一次**（离散变更：状态变了，旧结果已经没人要）。
   *      唯一的例外是**拖动中**——那时改为"排队覆盖"，理由见下面的注释。
   *   ③ 细颈阶段半改过的模块级场量，在 abort 时**同步还原**（见 abortRebuild）。
   *
   * @param {boolean} refit 是否重新取景（换轨道/复位时为真）
   * @param {Array|null} fieldSpec 需要重算标量场时给出的 computeField 参数数组；为 null 表示复用缓存场
   * @param {string} [fitMode] 收尾时怎么取景：'frame' = 按本档尺度重取景（换轨道）；
   *        'decor' = 只按辅助几何（节面球）兜底（降阈值把曲面拖出画面时拉远）；
   *        省略时跟随 refit（refit 为真则 'frame'，否则不取景）。
   *        ★ 取景**必须在流水线收尾时做**，不能在调用方紧接着做：现在调用方一返回，
   *          场还没算，gridExtent / fieldMax 都还是上一轮的，取景会晚一拍。
   * @param {boolean} [fineRetry] 这一次是"补精细化"的重试（见 scheduleFineRetry）。
   *        它必须绕开"用户还在连续调整"那条判据，否则会自己把自己无限挡住。
   */
  function rebuildSurface(refit, fieldSpec, fitMode, fineRetry) {
    // 本次已在重建，作废排队中的那次"补精细化"重试
    if (fineRetryTimer) { clearTimeout(fineRetryTimer); fineRetryTimer = null; }
    // ★ 拖动中**不取消**在飞的那一次，改为"排队并覆盖"。
    //   理由：拖动中每个 input 都来一次请求，若每次都取消，一次重建（宽约 100ms）
    //   永远跑不完 —— 用户在整个拖动过程中一次都看不到新面（实测正是如此：分辨率
    //   采样全程恒为拖动前的值，帧率倒是漂亮，因为根本没在算）。
    //   排队覆盖保证"总有一次能跑完并换上去"，画面于是以重建自身的节奏连续更新。
    //   非拖动时仍照旧取消：那是一次离散变更，旧结果确实没人要，等它跑完只是白等。
    if (rebuildHandle) {
      if (window.__ORBIT_PREVIEW__ && !rebuildHandle.isDone()) {
        pendingRebuild = { refit: refit, fieldSpec: fieldSpec, fitMode: fitMode, fineRetry: fineRetry };
        return;
      }
      rebuildHandle.cancel(); rebuildHandle = null;
    }
    if (!surfaceParams) return;
    // ★ "距今最近的一次重建"要连**开始**时刻一起记（收尾时还会再记一次，见 finishRebuild）。
    //   理由：planFinePatch 用"距上次重建多久"判断"用户是不是还在连续调整"，而切片之后
    //   一次重建从开始到结束要跨几百毫秒 —— 只记结束时刻的话，一个**正在跑**的重建会被
    //   当成"太久没动了"，于是紧接着到来的下一次重建会去规划细颈，正好在最忙的时候加活。
    //   ★ 补精细化的重试**不记** —— 它自己就是"停下来之后的那一次"，记了就把自己也挡住。
    if (!fineRetry) lastRebuildAt = performance.now();
    const st = {
      refit: !!refit,
      fitMode: fitMode || (refit ? 'frame' : null),
      fineRetry: !!fineRetry,
      t0: performance.now(), tExtract: 0, tWeld: 0, tMesh: 0, tSwap: 0,
      iso: 0, finePlan: null, fld: null, ext: null, weld: null, sm: null, geo: null,
      welded: null, coarseMesh: null, fineInfo: null, saved: null, empty: false,
      phase: fieldSpec ? 'fieldPrep' : 'extractPrep',
      fieldSpec: fieldSpec || null,
    };
    rebuildHandle = window.Sched.run({
      label: 'rebuildSurface',
      step: function () { return rebuildStep(st); },
      done: function () {
        rebuildHandle = null;
        finishRebuild(st);
        // 拖动中攒下的那次请求：上一次刚跑完，立刻接着跑（排队覆盖，绝不会堆叠）
        if (pendingRebuild) {
          const p = pendingRebuild; pendingRebuild = null;
          rebuildSurface(p.refit, p.fieldSpec, p.fitMode, p.fineRetry);
        }
      },
      abort: function () { rebuildHandle = null; abortRebuild(st); },
    });
  }

  /** 推进一个阶段。返回 false 表示整条流水走完（含细颈）。 */
  function rebuildStep(st) {
    switch (st.phase) {
      case 'fieldPrep':
        st.fld = prepareField(st.fieldSpec[0], st.fieldSpec[1], st.fieldSpec[2], st.fieldSpec[3],
                              st.fieldSpec[4], st.fieldSpec[5], st.fieldSpec[6], st.fieldSpec[7],
                              st.fieldSpec[8], st.fieldSpec[9], st.fieldSpec[10]);
        st.phase = 'field';
        return true;
      case 'field':
        if (stepField(st.fld)) return true;
        st.fld = null;
        st.phase = 'extractPrep';
        return true;

      case 'extractPrep': {
        // ★ 阈值换算必须走 levelAbsFor 这唯一一个出口（取景/标尺/面板显示都用它）。
        st.iso = Math.max(1e-9, levelAbsFor(surfaceParams, surfaceLevelFraction, surfaceParams.psiCrit));
        // 先决定要不要精细化：粗网格抽取时就要跳过节点球内的单元
        st.finePlan = planFinePatch(st.iso, st.fineRetry);
        st.ext = prepareExtract(st.iso, st.finePlan ? st.finePlan.radius : 0, false);
        st.phase = 'extract';
        return true;
      }
      case 'extract':
        if (stepExtract(st.ext)) return true;
        st.tExtract = performance.now();
        // ★ 必须先落成 Float32 的几何再焊接：焊接的顶点键是 `round(coor × 1e4)`，
        //   是个**量化边界** —— 喂 float64 数组与喂 float32 数组，在极少数贴着
        //   0.00005 的值上会落进不同的格子，顶点数就差几个。这不是洁癖：
        //   "与改动前逐位一致"正是本轮切片的头号验收判据，而 float64 → float32
        //   这一步本来就属于原流水线（原来也是从 BufferGeometry 里取 array）。
        st.geo = extractBuildGeometry(st.ext);
        st.ext = null;
        if (!st.geo.getAttribute('position').count) {
          st.geo = null; st.empty = true; st.phase = 'finish';
          return true;
        }
        st.weld = prepareWeld(st.geo.getAttribute('position').array,
                              st.geo.getAttribute('normal').array,
                              st.geo.getIndex().array);
        st.geo = null;
        st.phase = 'weld';
        return true;

      case 'weld':
        if (stepWeld(st.weld)) return true;
        st.welded = weldResult(st.weld);
        st.weld = null;
        st.tWeld = performance.now();
        { const nv0 = st.welded.positions.length / 3;
          if (nv0 > 800 && nv0 < 300000) {
            st.sm = prepareSmooth(st.welded.positions, st.welded.indices, 2);
            st.phase = 'smooth';
            return true;
          } }
        st.phase = 'mesh';
        return true;
      case 'smooth':
        if (stepSmooth(st.sm)) return true;
        st.sm = null;
        st.phase = 'mesh';
        return true;

      case 'mesh':
        // ★ 这里**只建、不上屏**。有细颈补片时，粗面本身是**不完整**的：抽取时按 maskR
        //   把节点球内的单元挖掉了，那一块是留给细网格补的。若在此就换上屏，从这一帧到
        //   细颈算完（切片后可以长达一秒）画面上就是一个**洞** —— 同步版不会露这个洞，
        //   因为两步在同一帧里完成。所以粗面与补片必须**一起**就绪才上屏（见 commitSurface）。
        st.coarseMesh = meshFromWelded(st.welded);
        st.welded = null;
        st.tMesh = performance.now();      // 粗面已建好（尚未上屏，等细颈一起）
        st.phase = 'finePrep';
        return true;

      case 'finePrep':
        // 这次不需要补片（含拖动中主动跳过）→ 粗面本身就是完整的，直接上屏
        if (!st.finePlan) { commitSurface(st, null); st.phase = 'finish'; return true; }
        st.saved = fineSave();
        { const P = surfaceParams;
          st.fld = prepareField(P.n, P.l, P.m, P.mode, st.finePlan.res, st.iso, null, 0,
                                st.finePlan.radius, st.finePlan.grade, P.Z); }
        st.phase = 'fineField';
        return true;
      case 'fineField':
        if (stepField(st.fld)) return true;
        st.fld = null;
        st.ext = prepareExtract(st.iso, st.finePlan.radius, true);   // 只取中心在球内的单元
        st.phase = 'fineExtract';
        return true;
      case 'fineExtract':
        if (stepExtract(st.ext)) return true;
        st.geo = extractBuildGeometry(st.ext);
        st.ext = null;
        if (!st.geo.getAttribute('position').count) {
          fineRestore(st.saved); st.saved = null;
          st.geo = null;
          commitSurface(st, null);            // 细网格没抽出东西 → 只能拿粗面顶上（会有洞，但不空屏）
          st.phase = 'finish';
          return true;
        }
        st.weld = prepareWeld(st.geo.getAttribute('position').array,
                              st.geo.getAttribute('normal').array,
                              st.geo.getIndex().array);
        st.geo = null;
        st.phase = 'fineWeld';
        return true;
      case 'fineWeld':
        if (stepWeld(st.weld)) return true;
        { const welded = weldResult(st.weld);
          st.weld = null;
          fineRestore(st.saved); st.saved = null;      // 先把场量还回去，再建网格
          // ★ 这里**刻意不做 Taubin 平滑**（粗网格那一步要做）。
          //   平滑的作用尺度正比于网格间距：粗网格 0.82a₀ 间距下 2 轮只抹掉行进四面体的
          //   锯齿（正是设计意图），但细网格是 0.11a₀ 间距，同样 2 轮会抹平 0.2a₀ 尺度的
          //   东西 —— 那恰好就是细颈的尺寸，于是真实的喇叭口被抹成弯月面（"像有表面张力"）。
          //   而细网格的锯齿在正常缩放下不到 1 像素，本来也不需要平滑。
          const nv = welded.positions.length / 3;
          st.fineInfo = { verts: nv, res: st.finePlan.res, radius: st.finePlan.radius,
                          gap: st.finePlan.gap, grade: st.finePlan.grade };
          commitSurface(st, meshFromWelded(welded));   // 粗面与补片一起上屏
        }
        st.phase = 'finish';
        return true;

      default:      // 'finish'
        return false;
    }
  }

  /**
   * 换掉当前等值面：**先把新的挂上去，再拆旧的**，中间不会出现"场景里没有曲面"的帧。
   * 传 null 表示"这次没抽出曲面"（阈值高到只剩空集）—— 那时旧的那张必须收掉，
   * 否则画面上会一直留着一张上一轮阈值的面，读数与画面完全对不上。
   */
  function swapSurfaceMesh(mesh) {
    if (mesh) scene.add(mesh);
    if (surfaceObj) {
      scene.remove(surfaceObj);
      surfaceObj.geometry.dispose();
      surfaceObj.material.dispose();
    }
    surfaceObj = mesh || null;
    surfaceGeoRef = mesh ? mesh.geometry : null;
    // 细颈补片属于旧的那一片：先收掉，等新的一次细颈算完再挂
    disposeFine();
  }

  /**
   * 把这一次算出来的曲面**一次性**换上屏：粗面 + 细颈补片是一个整体，必须一起到位。
   *
   * ★ 为什么不能分两次上屏：粗面抽取时按 maskR **挖掉了节点球内的单元**（那一块留给
   *   细网格补）。只换粗面等于在画面上留一个洞。同步版两步在同一帧里完成，看不出这个
   *   中间态；切片后细颈要跨几十帧（实测 1.2 秒），洞就会一直挂在屏幕上 ——
   *   用户看到的"渲染的时候部分等值面会消失"就是这个洞。
   */
  function commitSurface(st, fineMesh) {
    st.tSwap = performance.now();        // 真正上屏的时刻
    swapSurfaceMesh(st.coarseMesh);      // 加新粗面、拆旧粗面与旧补片
    st.coarseMesh = null;
    if (fineMesh) { fineObj = fineMesh; scene.add(fineObj); }
    // ★ 提交后**必须按当前档位重新同步一次显隐**（不是可选的美化）。
    //   重建是切片跑的、可能跨几十帧才提交；若用户在提交之前切到了球谐档，
    //   那次 setVisibility 关掉的是**旧**那一张，而这两张新网格是 THREE 新建的、
    //   默认 visible = true —— 没人再关它们，于是球谐曲面与空间波函数**同时显示**。
    //   用户实测路径：复解 l=2 把 m 走一个来回（留下一个在飞的重建）再切球谐。
    setVisibility(lastVisMode);
  }

  /** 流水走完后的收尾（取景 + 探针 + lastRebuildAt） */
  function finishRebuild(st) {
    // ★ 'decor' 取景要**在空面判断之前**做，这是为了与原实现严格对齐：
    //   原来这条取景写在调用方 setSurfaceLevel 里，而 rebuildSurface 抽到空面时只是
    //   `return`，并不影响调用方接着取景 —— 即"空面也照取不误"。反过来，'frame'
    //   那条原来在 rebuildSurface 内部、位于空面 return 之后，所以空面时**不取景**。
    if (st.fitMode === 'decor') fitViewIfNeeded(currentFrameExtent(), lastDecorExtent);
    // 兜底：正常路径在 'finePrep' / 'fineWeld' 里就把面换上屏了，这里只防"某个阶段
    // 提前返回、曲面却一直没上屏"——那样会永远停在旧面上，比闪一下难查得多。
    if (st.coarseMesh) commitSurface(st, null);
    if (st.empty) {
      // ★ 空面要**显式清场**：切片版"算完才换面"的策略（为了不闪屏）意味着旧曲面
      //   会一直留在场上 —— 阈值高到抽不出面时必须把它收掉，否则画面上还挂着上一轮
      //   阈值的面，读数与画面完全对不上。原同步实现是开头就 dispose，天然没有这个问题。
      swapSurfaceMesh(null);
      // ★ 抽出空面时也要留下现场：否则"体积为 0"这类问题连 fieldMax 是多少、
      //   阈值相对基准高出多少都看不到。
      if (window.__ORBIT_DEBUG__) {
        window.__SURF_TIMING__ = {
          empty: true, verts: 0, total: Math.round(performance.now() - st.t0),
          nGrid: nGrid, gridExtent: +gridExtent.toFixed(4),
          fieldMax: +fieldMax.toFixed(8), fraction: +surfaceLevelFraction.toFixed(4),
          isoAbs: +st.iso.toFixed(8),
          refPeak: surfaceParams ? +levelAbsFor(surfaceParams, 1, surfaceParams.psiCrit).toFixed(8) : null,
          terms: surfaceParams && surfaceParams.terms ? surfaceParams.terms.length : 0,
        };
      }
      lastRebuildAt = performance.now();
      return;
    }
    if (window.__ORBIT_DEBUG__ && surfaceObj) {
      const geo2 = surfaceObj.geometry;
      window.__SURF_TIMING__ = {
        extract: Math.round(st.tExtract - st.t0),
        weldSmooth: Math.round(st.tWeld - st.tExtract),
        // 粗面建完到上屏；细分与细颈分开报 —— 两者的优化手段完全不同
        // （粗面靠切片与降档，细颈靠"停下再补"），混在一个数里看不出该动哪边。
        build: Math.round((st.tMesh || st.tWeld) - st.tWeld),
        fineMs: st.tMesh ? Math.round((st.tSwap || performance.now()) - st.tMesh) : 0,
        total: Math.round(performance.now() - st.t0),
        verts: geo2.getAttribute('position').count,
        nGrid: nGrid,
        gridExtent: +gridExtent.toFixed(4),
        fieldMax: +fieldMax.toFixed(8),
        fraction: +surfaceLevelFraction.toFixed(4),
        isoAbs: +st.iso.toFixed(8),
        refPeak: surfaceParams ? +levelAbsFor(surfaceParams, 1, surfaceParams.psiCrit).toFixed(8) : null,
        terms: surfaceParams && surfaceParams.terms ? surfaceParams.terms.length : 0,
        // 曲面最外顶点占网格盒子的比例。盒子按"恰好装下"设计，故接近 1 是正常的；
        // ≥ 1 才说明顶到盒面、被裁出了平边（配合截图确认）。
        faceTouch: (function () {
          const pa = geo2.getAttribute('position');
          let mx = 0, my = 0, mz = 0;
          for (let i = 0; i < pa.count; i++) {
            mx = Math.max(mx, Math.abs(pa.getX(i)));
            my = Math.max(my, Math.abs(pa.getY(i)));
            mz = Math.max(mz, Math.abs(pa.getZ(i)));
          }
          return +(Math.max(mx, my, mz) / gridExtent).toFixed(3);
        })(),
        fine: st.fineInfo
          ? { 触发: true, 细网格: st.fineInfo.res + '³', 渐变系数: st.fineInfo.grade,
              节点球半径: +st.fineInfo.radius.toFixed(3),
              细颈缝隙: +st.fineInfo.gap.toFixed(3), 细网格顶点: st.fineInfo.verts }
          : { 触发: false, 粗网格单元格: +((2 * gridExtent) / (nGrid - 1)).toFixed(3) },
      };
    }
    lastRebuildAt = performance.now();     // 供"是否还在连续调整"判断
    // ★ 取景的三种情形，与原实现一一对应：
    //   'frame' —— 换轨道 / 复位 / 切档：本档尺度变了，重新取景；
    //   'decor' —— 只动了阈值：常见区间内相机**纹丝不动**，只有阈值低到曲面胀出
    //              当前取景时才逐步拉远（fitViewIfNeeded 自己判断"尺度是否真变了"）；
    //              （已在函数开头处理，见那里的说明）
    //   null    —— 单纯补精细化：相机完全不动。
    if (st.fitMode === 'frame') {
      fitViewIfNeeded(currentFrameExtent(), frameExtentFor(surfaceParams));
    }
  }

  /** 被新的重建取消时的收尾：把细颈阶段半改过的模块级场量**同步还原** */
  function abortRebuild(st) {
    if (st.saved) { fineRestore(st.saved); st.saved = null; }
    // ★ 已经建好但**还没上屏**的粗面要 dispose 掉：它从未进过场景，没人会替它收尸，
    //   否则每被取消一次就漏一份几何与材质（GPU 显存）。
    if (st.coarseMesh) {
      if (st.coarseMesh.geometry) st.coarseMesh.geometry.dispose();
      if (st.coarseMesh.material) st.coarseMesh.material.dispose();
      st.coarseMesh = null;
    }
    st.fld = null; st.ext = null; st.weld = null; st.sm = null; st.geo = null; st.welded = null;
    // 取消是外部的强制动作（如 Sched.cancelAll / 清空场景），排队中的请求一并作废
    pendingRebuild = null;
  }


  /**
   * 取景尺度没变就不动相机。
   *
   * ★ 这是"切换渲染方式时视角不该跳"的关键：粒子云每次重建都无条件重取景，
   *   而等值面只在换轨道时才取景——两条路径不对称，于是"等值面→粒子云"会把
   *   用户刚调好的缩放重置掉、"粒子云→等值面"又不会，看起来就是"视角重置不一致"。
   *   统一成"尺度变了才取景"之后，纯切换渲染方式相机的朝向与距离都保持不动。
   */
  function fitViewIfNeeded(extent, decorExt) {
    if (Math.abs(extent - lastFitExtent) < 1e-9) return;
    fitView(extent, decorExt);
  }

  /**
   * 取景与"标尺"范围。
   *
   * 用两套范围，是为了让**阈值/判据的变化真正看得见**：
   *   · refExt  —— 固定参考（恒按 |ψ|² 的 30% 算，与当前阈值、判据无关），
   *                用作坐标轴/赤道环的"标尺"，故它不随阈值变化而缩放；
   *   · frameExt = max(refExt, 当前实际外延)，用于相机距离，保证表面永不溢出画面。
   * 于是：抬高阈值 → 表面缩进标尺环内；降低阈值或切到 |ψ| 判据 → 表面涨出环外，
   * 两种情况都肉眼可辨。若两套范围混用（相机跟着表面走），变化就会被完全抵消。
   */
  /** 固定参考范围（恒按 |ψ|² 的 30% 算，与当前阈值、判据无关）——用作取景基准与标尺 */
  const FRAME_REF_LEVEL = 0.30;
  function refExtentFor(P) {
    if (!P) return gridExtent;
    const refAbs = FRAME_REF_LEVEL * OM.maxDensity(P.n, P.l, P.m, P.mode, P.Z);
    return Math.max(OM.isoRadius(P.n, P.l, P.m, P.mode, refAbs, P.Z) * 1.12, 1.2);
  }

  /**
   * ★ 统一取景尺度（相机行为一致性的关键）
   *
   * 取景尺度**只随轨道本身变**（n/l/m/模式/叠加态），与**渲染方式、判据、阈值无关**。
   * 于是三条规则变得可预期、且互相一致：
   *   · 复位            → 重置朝向 + 按本尺度重新取景
   *   · 换轨道          → 保持朝向，按本尺度重新取景（物体尺度真的变了）
   *   · 纯显示参数变化  → 朝向与距离**都保持不动**（判据/阈值/渲染方式/着色）
   * 后者尤其重要：用户常要"切换着对比"，相机若跟着跳就没法比较了。
   */
  function frameExtentFor(P) {
    if (!P) return Math.max(gridExtent, 1.5);
    if (P.terms && P.terms.length) {
      // 用"等值面实际外延"而非渐近尾部，否则叠加态会缩成一小团
      return Math.max(OM.superpositionRefExtent(P.terms, P.Z) * 1.25, 1.5);
    }
    return Math.max(refExtentFor(P) * 1.25, 1.5);
  }

  /**
   * 由当前应用状态取"本轨道"的取景尺度（供粒子云与等值面共用）。
   *
   * ★ 取景必须同时容纳两件事：
   *   ① **与阈值无关的基准尺度**（frameExtentFor，按 30% 参考水平算）——
   *      保证在常见阈值区间里切换阈值时相机不动，便于对照比较；
   *   ② **当前阈值实际需要的尺度**——阈值越低等值面越大。少了这一项，
   *      把阈值调低时曲面会胀出画面被裁掉（3p 在 10% 时曲面半径约 12a₀，
   *      而基准取景半径只有 5.4a₀，胀出 2.2 倍）。
   *   两项取大值 ⇒ 常见区间行为不变，低于基准水平时才逐步拉远。
   */
  function currentFrameExtent() {
    const S = (window.OrbitApp && window.OrbitApp.getState()) || null;
    if (!S) return Math.max(gridExtent, 1.5);
    // 球谐档的尺度是**固定的**：曲面归一到半径 1、参考轴 ±1.6，且形状只依赖 (l,m)、
    // 与 n 无关。所以它不参与下面那套"按阈值算需要多大"的推导 —— 一并跳过，
    // 免得切档时相机按上一个轨道的尺度乱动。
    if (S.viewTarget === 'spherical') return ANGULAR_FRAME_EXTENT;
    // Z 一并带进下面构造的两个 P 对象 —— 取景尺度随 1/Z 缩，不带就会出现
    // "换了 Z 相机不动、轨道胀出画面"
    const Z = S.nuclearCharge || 1;
    const base = S.terms && S.terms.length
      ? Math.max(OM.superpositionRefExtent(S.terms, Z) * 1.25, 1.5)
      : frameExtentFor({ n: S.n, l: S.l, m: S.m, mode: S.wavefunction, psiCrit: S.psiCriterion, terms: null, Z: Z });
    const levelAbs = levelAbsFor(
      { n: S.n, l: S.l, m: S.m, mode: S.wavefunction, terms: S.terms, Z: Z },
      S.levelFraction, S.psiCriterion);
    const need = frameExtentForLevel(
      { n: S.n, l: S.l, m: S.m, mode: S.wavefunction, terms: S.terms, Z: Z }, levelAbs);
    return Math.max(base, need);
  }

  /** 按"给定绝对阈值"取景的尺度（与 frameExtentFor 同构，只把基准换成实际阈值） */
  function frameExtentForLevel(P, levelAbs) {
    const r = (P.terms && P.terms.length)
      ? OM.superpositionIsoRadius(P.terms, levelAbs, P.Z)
      : OM.isoRadius(P.n, P.l, P.m, P.mode, levelAbs, P.Z);
    return Math.max(r * 1.12 * 1.25, 1.5);      // 与 refExtentFor × frameExtentFor 的系数保持一致
  }

  let currentL = 0;
  let currentColorMode = 'phase';      // 'phase' | 'orbital'
  let surfaceGeoRef = null;            // 当前等值面几何（供"只改着色"时快速重涂）
  let surfaceParams = null;            // 当前等值面对应的 (n,l,m,mode)，供重涂/重算时用
  let lastRes = 68;                    // 上次使用的网格分辨率

  function updateSurface(n, l, m, mode, res, levelFraction, colorMode, psiCrit, terms, relPhase, Z) {
    currentL = l;
    currentColorMode = colorMode || 'phase';
    lastRes = res;
    surfaceParams = {
      // 兜底值取 'psi'，与 index.html 上带 active 的判据按钮一致（那儿才是默认的真源）。
      // ★ 这个字段决定三件事：阈值换算（math.js 的 isoLevelAbs）、网格盒与取景、
      //   以及着色（main.js 的 deriveColorMode）。传错值不会报错，只会静默画出别的面。
      n: n, l: l, m: m, mode: mode, psiCrit: psiCrit || 'psi',
      // ★ Z 进 surfaceParams —— 它是"只改着色/阈值"那条复用分支重算时的唯一来源，
      //   不进的话切 Z 后走复用分支、用旧的 Z 重算，画面就错了。
      Z: (Z > 0) ? Z : 1,
      terms: (terms && terms.length) ? terms : null,
      relPhase: relPhase || 0,
    };
    // 叠加态时阈值按各分量峰值的加权和为基准；单一态时按解析峰值
    const levelAbs = levelAbsFor(surfaceParams, levelFraction, surfaceParams.psiCrit);
    // ★ 标量场不再在这里同步算（原来是 ~100ms 的硬阻塞），而是作为切片流水线的
    //   第一段交给 Sched —— 见 rebuildSurface 的说明。
    //   换轨道 → 尺度变了，故 refit = true，取景在流水线收尾时做。
    buildSurface(levelFraction, true,
      [n, l, m, mode, res, levelAbs, surfaceParams.terms, surfaceParams.relPhase, 0, 0, surfaceParams.Z]);
  }

  // ---------------------------------------------------------------------------
  // 显示模式
  // ---------------------------------------------------------------------------
  /**
   * 切换三维里"显示什么"。
   * @param mode 'points' | 'surface' | 'spherical'
   *   'spherical' 是球谐函数档：只显示球谐曲面（连它那组参考轴），与 ψ 的
   *   粒子云 / 等值面互斥。
   */
  function setVisibility(mode) {
    lastVisMode = mode;                  // 供切片重建提交时复用（见 commitSurface）
    const sph = (mode === 'spherical');
    if (angGroup) angGroup.visible = sph;
    if (cloudObj) cloudObj.visible = (mode === 'points');
    if (surfaceObj) surfaceObj.visible = (mode === 'surface');
    if (nucleusObj) nucleusObj.visible = !sph;
    // ★ 两处补漏（原先都没有人管）：
    //   · fineObj 是等值面在细颈处补出来的那一块，它的显隐原先从不跟随 surfaceObj ——
    //     于是切到"粒子云"后，细颈补片会**孤零零留在场景里**。
    //   · decorGroup（坐标轴 + 赤道环）是按**轨道尺度**缩放的，球谐只有单位球大小，
    //     一起显示会缩成一小撮；球谐档有自己的参考轴，故此时整体隐藏。
    if (fineObj) fineObj.visible = (mode === 'surface');
    if (decorGroup) decorGroup.visible = !sph;
    // ★ 辅助几何也要跟着档位走（第 18 条补漏）：径向节面球只对 ψ 有意义，
    //   切到球谐档必须收起，否则 ψ 档画下的"套娃"会一直留在画面上。
    syncAuxVisibility(mode);
    // ★ 节面高亮还要跟着**轨道**走（第 11 条）：换 n/l/m/Z/实复之后重建
    refreshSpotlight();
    // ★ 档位切换时**必须重新取景**，而且只有在这里补才补得全：
    //   两个档的尺度差十几倍（球谐恒为 ANGULAR_FRAME_EXTENT，ψ 随轨道在 1.5～16.7），
    //   而各自的"重建分支"并不对称 —— 进球谐档要走 updateAngular（有 memo），
    //   回 ψ 档若轨道与阈值都没变则走 setSurfaceLevel 的**复用分支，根本不重建**，
    //   于是两条路都可能不取景。实测：漏掉后切档相机距离纹丝不动（停在 63.97），
    //   球谐曲面小到几乎看不见。
    //   放在 setVisibility 里而不是各重建分支里，语义也更准：**变的是档位**，
    //   就该重取景；fitViewIfNeeded 自带"尺度没变就不动相机"的守卫，不会多动。
    if (lastSphVisible !== sph) {
      lastSphVisible = sph;
      fitViewIfNeeded(currentFrameExtent());
    }
  }

  // 相机取景：保持当前朝向（四元数不变），只按轨道尺度调整距离与裁剪面。
  // decorExt 为"标尺"（坐标轴/赤道环）的固定尺度，与当前阈值无关，见 refExtentFor 注释。
  //
  // ★ 为什么不能只写 dist = extent * 常数：
  //   透视相机的**竖直**视野由 fov 决定，水平视野 = 竖直视野 × aspect。若距离只看
  //   extent，画面一扁（宽而矮的画布）轨道就会顶满上下边缘、甚至被切掉；换一台
  //   显示器（画布更高或更窄）同一个轨道又会缩成一小团。所以距离必须由
  //   「fov + aspect + 需要容纳的半尺寸」三者一起算出来，才能保证任何画布比例下
  //   轨道都完整、且四周留白一致。
  function fitView(extent, decorExt) {
    if (!camera || !viewCtl) return;
    const vFov = camera.fov * Math.PI / 180;
    const tanHalf = Math.tan(vFov / 2);
    const aspect = camera.aspect || 1;
    const need = extent * FIT_MARGIN;                  // 需要容纳的半尺寸（含留白）
    const distV = need / tanHalf;                      // 竖直方向刚好容纳
    const distH = need / (tanHalf * aspect);           // 水平方向刚好容纳
    const dist = Math.max(distV, distH);
    camera.near = Math.max(extent * 0.02, 1e-3);
    camera.far = extent * 60;
    camera.updateProjectionMatrix();
    viewCtl.setLimits(extent * 0.15, extent * 40);
    viewCtl.setDistance(dist);
    // 装饰参照（坐标轴 ±12、赤道环 r=12）缩放为固定标尺
    const de = decorExt || extent;
    lastDecorExtent = de;                              // 供窗口尺寸变化时重取景复用
    lastFitExtent = extent;                            // 供 fitViewIfNeeded 判断"尺度是否变了"
    if (decorGroup) decorGroup.scale.setScalar(Math.max(de * 1.12 / 12, 0.02));
    // 更新原子核与参考尺寸
    if (nucleusObj) {
      nucleusObj.scale.setScalar(Math.max(extent * 0.02, 0.04));
    }
  }

  function setNucleusVisible(v) { if (nucleusObj) nucleusObj.visible = v; }

  // ---------------------------------------------------------------------------
  // 生命周期
  // ---------------------------------------------------------------------------
  function render() {
    if (renderer && scene && camera) {
      if (viewCtl) viewCtl.update();
      renderer.render(scene, camera);
    }
  }
  function resize(w, h) {
    if (!camera || !renderer) return;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    // ★ 换了画布比例就要重新取景：同一个轨道在 3:1 的扁画布和 1:1 的方画布里，
    //   能"塞进去"的距离完全不同。用户没手动调过镜头时才自动重取，避免覆盖他的手感。
    //   沿用上次的装饰标尺，保证坐标轴/赤道环的缩放不因窗口变化而跳动。
    if (viewCtl && !viewCtl.isUserAdjusted()) fitView(currentFrameExtent(), lastDecorExtent);
  }
  /**
   * 自动旋转开关。
   * ★ 原先它要同时喂**主视图与角度分布小场景**两套控制器 —— 两处都是"绕着看形状"，
   *   共用一个开关才符合直觉，也省得再加一套控件。球谐曲面合并进主场景之后只剩一套
   *   控制器，这里自然就只剩一句了。（历史：小场景曾在 init 时写死 setAutoRotate(true)，
   *   用户没有任何入口关掉它，"角度分布图的自动旋转无法控制"就是那么来的。）
   */
  function setAutoRotate(v) {
    if (viewCtl) viewCtl.setAutoRotate(v);
  }
  function resetView() {
    if (!viewCtl) return;
    viewCtl.resetHome();                       // 回到初始朝向（z 向上）
    fitView(currentFrameExtent(), frameExtentFor(null));
  }
  function disposeGrid() {           // 释放等值面缓存的标量场
    field = null; gradX = gradY = gradZ = null; nGrid = 0;
    fieldKey = ''; fieldDesc = null;  // ★ 场没了，指纹必须一起清 —— 否则下次复用判断会认下一份不存在的场
    disposeFine();                   // 精细化补片同样依赖这个场，一并清掉
  }

  // ---------------------------------------------------------------------------
  // 球谐曲面（主场景里的一个可切换对象）
  //   r(θ,φ)：从原点沿 (θ,φ) 方向引射线，长度 = |Y| 或 |Y|²。
  //   实函数按 Y 符号分色（+青 / −橙），复函数按相位（arg Y）彩虹着色。
  //
  // ★ 它原先是一个**独立的小场景**（自建 renderer / camera / controller，挂在页面
  //   下方的「角度分布」卡片里）。现合并进主场景 —— 于是球谐与完整波函数共用同一套
  //   相机、控制器、自动旋转与复位，学生在同一个三维窗口里就能把"角度部分"与
  //   "完整波函数"对着看，而不是在两个各自能转的窗口之间来回切换。
  //
  // ★ 合并要解决的核心问题是**尺度**：球谐归一到半径 1，而 ψ 的取景半尺寸随轨道
  //   在 1.5～16.7 之间（见 currentFrameExtent）。所以切档时必须把**本档自己的**
  //   extent 交给 fitView，否则球谐要么被画成一个小点、要么撑满整个视野。
  // ---------------------------------------------------------------------------
  let angGroup = null;          // 球谐曲面 + 参考坐标轴（整组一起显隐，避免"半显"状态）
  let angMesh = null;
  let angLastKey = '';
  let lastSphVisible = null;    // 上一次 setVisibility 是否在球谐档（用于"档位变了才重取景"）

  /** 球谐档的取景半尺寸：参考轴画到 ±1.6，留一点余量（与 FIT_MARGIN 配合） */
  const ANGULAR_FRAME_EXTENT = 1.8;

  function ensureAngGroup() {
    if (angGroup) return angGroup;
    angGroup = new THREE.Group();
    angGroup.visible = false;                     // 默认在"波函数"档
    scene.add(angGroup);
    // 参考坐标轴。刻意用一根中性灰而不是三色轴：球谐曲面本身已经在用颜色表达
    // 正负 / 相位，再叠三根彩轴会抢掉它要传达的信息。
    const pts = [];
    const mk = (a, b) => {
      pts.push(new THREE.Vector3(a[0], a[1], a[2]), new THREE.Vector3(b[0], b[1], b[2]));
    };
    mk([-1.6, 0, 0], [1.6, 0, 0]); mk([0, -1.6, 0], [0, 1.6, 0]); mk([0, 0, -1.6], [0, 0, 1.6]);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position',
      new THREE.Float32BufferAttribute(pts.flatMap((v) => [v.x, v.y, v.z]), 3));
    angGroup.add(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({
      color: 0x77809b, transparent: true, opacity: 0.6,
    })));
    return angGroup;
  }

  // 按 (l,m,mode,which) 重建球谐曲面。
  // memo 守卫：同参数直接返回 —— 这个函数在每次 recompute 时都会被调用，
  // 而建一遍网格要遍历 31×61 个点，不缓存的话拖滑块会明显卡。
  function updateAngular(l, m, mode, which, colorMode) {
    if (!scene) return;
    const cm = colorMode || 'phase';
    const key = l + '-' + m + '-' + mode + '-' + which + '-' + cm;
    if (key === angLastKey && angMesh) return;
    angLastKey = key;
    ensureAngGroup();
    if (angMesh) {
      angGroup.remove(angMesh);
      angMesh.geometry.dispose();
      angMesh.material.dispose();
      angMesh = null;
    }

    const NT = ANG_RES, NP = ANG_RES * 2;
    const positions = [], colors = [], indices = [];
    const rval = new Float32Array((NT + 1) * (NP + 1));
    const clr = new Float32Array((NT + 1) * (NP + 1) * 3);
    let maxR = 0;
    // 第一遍：算长度与颜色
    for (let i = 0; i <= NT; i++) {
      const th = Math.PI * i / NT;
      const sT = Math.sin(th), cT = Math.cos(th);
      for (let j = 0; j <= NP; j++) {
        const ph = 2 * Math.PI * j / NP;
        let len;
        if (mode === 'real') {
          const Y = OM.angularReal(l, m, th, ph);
          len = (which === 'Y2') ? Y * Y : Math.abs(Y);
        } else {
          const mag = OM.angularComplex(l, m, th, ph).abs();
          len = (which === 'Y2') ? mag * mag : mag;
        }
        rval[i * (NP + 1) + j] = len;
        if (len > maxR) maxR = len;
        // 着色用**角度部分的相位**（OM.angularPhase，**故意不含 R(r)**）：这张图画的
        // 本来就是 r = |Y|，没有径向信息，硬乘一个 R 反而会把"径向节点"错误地混进来。
        // ★ 它和三维等值面/截面用的 OM.psiPhase 是**两个不同用途的判据**，别混用 ——
        //   两者各自的适用场合写在 math.js 的函数注释里。
        // ★ 着色**由判据派生**（见 main.js 的 deriveColorMode），已不再是一个独立开关。
        //   调用方传进来的 cm 就是"实/复 + |Y|/|Y|²"两者的合成结果：
        //     「|Y|」+ 实数解 → 'phase' 按 sign(Y) 双色
        //     「|Y|²」        → 'orbital' 纯色（Y² 非负，本就没有正负可谈）
        //     一切复数解      → 'orbital' 纯色（arg Y 是绕 z 轴的连续缠绕，不是两个值）
        const idx = (i * (NP + 1) + j) * 3;
        //   · 'orbital' → 整个曲面刷成该支壳层的单色
        //   · 'phase'   → 实数解按 sign(Y) 分正负双色
        //   注意判据用 OM.angularPhase（**不含 R(r)**）：这张图画的是 r = |Y|，
        //   没有径向信息，硬乘一个 R 会把"径向节点"错误地混进来。
        const col = (cm === 'orbital')
          ? OM.lColor(l)
          : OM.phaseColor(OM.angularPhase(mode, l, m, th, ph), 0.62);
        clr[idx] = col[0]; clr[idx + 1] = col[1]; clr[idx + 2] = col[2];
      }
    }
    if (maxR < 1e-12) maxR = 1e-12;
    // 第二遍：生成顶点与索引（颜色已在第一遍定好，这里不再改）
    for (let i = 0; i <= NT; i++) {
      const th = Math.PI * i / NT;
      const sT = Math.sin(th), cT = Math.cos(th);
      for (let j = 0; j <= NP; j++) {
        const ph = 2 * Math.PI * j / NP;
        const vid = i * (NP + 1) + j;
        const radius = (rval[vid] / maxR) * 1.0;      // 归一化到最大半径 1（世界单位）
        positions.push(radius * sT * Math.cos(ph), radius * sT * Math.sin(ph), radius * cT);
      }
    }
    for (let i = 0; i < NT; i++) {
      for (let j = 0; j < NP; j++) {
        const a = i * (NP + 1) + j, b = a + 1, c = a + (NP + 1), d = c + 1;
        indices.push(a, c, b, b, c, d);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(clr, 3));
    geo.setIndex(indices);
    // ★ 法线必须算：光照材质靠它决定明暗，而这张曲面原先用的是**不受光**的
    //   MeshBasicMaterial —— 几何上根本没给 normal 属性，场景里那三盏灯对它完全浪费。
    geo.computeVertexNormals();
    // ★ 材质与波函数等值面**同一套**（MeshStandardMaterial + 同一组参数）：
    //   原先这里是 MeshBasicMaterial，顶点色直接铺上去，于是整个曲面是一块匀色 ——
    //   看不出哪一瓣朝向观察者、哪一瓣背过去，三维结构被压成了二维剪影。
    //   （用户："球谐函数的三维视图没有空间波函数那么有光泽，看不出三维结构。"）
    //   ★ 顶点色在 Standard 里是**乘**在光照结果上的，而这里的顶点色承载的正是
    //     "相位色 / 支壳层色"这条信息，所以底色调成 white、roughness 与等值面一致，
    //     保证两档观感相同 —— 用户要的正是"一样有光泽"。
    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff, vertexColors: true, roughness: 0.5, metalness: 0.0,
      side: THREE.DoubleSide,
    });
    angMesh = new THREE.Mesh(geo, mat);
    angGroup.add(angMesh);
  }

  /** 球谐档下"该用多大取景尺度"（供 currentFrameExtent 调用） */
  function angularFrameExtent() { return ANGULAR_FRAME_EXTENT; }

  // ---------------------------------------------------------------------------
  // 教学辅助：参考球（linkRadialTo3D）与节面高亮（spotlightNodes）
  // 这两者把"径向图上的一个横坐标"与"三维中的一层壳"在空间上对应起来，
  // 是本工具区别于普通轨道查看器的关键教学动作。
  // ---------------------------------------------------------------------------
  let auxGroup = null;

  /**
   * 辅助几何（参考球 / 节面高亮）变化时的回调 —— 界面上有一枚「节面」按钮要跟着亮灭，
   * 而清除它的入口不止一个（按钮、画布左上角的标签、智能体的 spotlightNodes），
   * 让每条路各自去同步按钮亮态必然会漏；由这里统一广播一次最省事。
   */
  let auxChangeCb = null;
  function notifyAuxChange() { if (auxChangeCb) { try { auxChangeCb(); } catch (e) { /* 忽略 */ } } }

  function ensureAuxGroup() {
    if (!auxGroup) { auxGroup = new THREE.Group(); scene.add(auxGroup); }
    return auxGroup;
  }
  function clearAux() {
    if (!auxGroup) return;
    while (auxGroup.children.length) {
      const c = auxGroup.children.pop();
      if (c.geometry) c.geometry.dispose();
      if (c.material) c.material.dispose();
    }
  }

  // ---------------------------------------------------------------------------
  // 三维视图上的"标注标签"
  //
  // ★ 为什么需要它：参考球、节面高亮这类辅助几何一旦画上去，就没有任何入口能取消。
  //   智能体可以用 linkRadialTo3D{radius:0} 清掉，但用户自己（和课堂上的老师）
  //   只能干看着——一个"加得上、去不掉"的标注等于把画面弄脏了。
  //   这里在画布左上角挂一枚可点击的标签，点一下就撤销，标注变成可逆操作。
  // ---------------------------------------------------------------------------
  const chipEls = {};

  // 当前标注状态：参考球半径与节面高亮。存下来是为了让演示「上一步」能把
  // 这些画上去的辅助几何也一并撤掉（它们不在 OrbitApp 的状态里）。
  let curRingRadius = 0;
  let curSpotlight = null;      // { type, on } | null

  function setChip(key, text, onClear, title) {
    const host = containerRef.el;
    if (!host) return;
    let el = chipEls[key];
    if (!el) {
      el = document.createElement('button');
      el.type = 'button';
      el.className = 'viewer-chip hidden';
      chipBar().appendChild(el);
      chipEls[key] = el;
    }
    // ★ 每次调用都**重绑** onclick，而不是只在创建时绑一次：回调常常闭包着"当时的状态"
    //   （如节面高亮记的 types），只绑一次的话，第一次那个闭包会一直生效、后面换了语义
    //   也换不掉。这正是"参考球/节面有时候点不掉"最可能的来源（第 16 条）。
    if (typeof onClear === 'function') el.onclick = onClear;
    if (text) {
      el.textContent = text;
      el.title = title || '点击移除该标注';
      el.classList.remove('hidden');
    } else {
      el.classList.add('hidden');
    }
  }

  /** 标签容器：懒创建，只建一次 */
  function chipBar() {
    let bar = containerRef.el.querySelector('.viewer-chips');
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'viewer-chips';
      containerRef.el.appendChild(bar);
    }
    return bar;
  }

  /**
   * 画出半径为 radius 的参考球（线框），用于把径向分布的横坐标 r
   * 与三维空间中的"一层球壳"对应起来。
   * radius ≤ 0 表示**清除**参考球。
   */
  function ringHighlight(radius) {
    const g = ensureAuxGroup();
    // 移除旧的参考球（保留节面等其他辅助对象）
    for (let i = g.children.length - 1; i >= 0; i--) {
      if (g.children[i].userData.kind === 'ring') {
        const c = g.children[i];
        g.remove(c); if (c.geometry) c.geometry.dispose(); if (c.material) c.material.dispose();
      }
    }
    if (!(radius > 0)) {
      curRingRadius = 0;
      setChip('ring', null);
      return;
    }
    curRingRadius = radius;

    const seg = Math.max(24, Math.min(64, Math.round(radius * 6)));
    const geo = new THREE.SphereGeometry(radius, seg, Math.max(12, Math.round(seg / 2)));
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffd24a, wireframe: true, transparent: true, opacity: 0.28, depthWrite: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.userData.kind = 'ring';
    // 参考球的半径是**ψ 的尺度**（径向图上的横坐标）；球谐档归一到半径 1，
    // 一起显示会变成一颗包住整个画面的巨球，故按"只在 ψ 档可见"处理。
    mesh.userData.rOnly = true;
    g.add(mesh);
    setChip('ring', '参考球 r = ' + radius.toFixed(2) + ' a₀  ✕', function () { ringHighlight(0); });
    notifyAuxChange();
  }

  /**
   * 节面 chip 上的文字 —— **按当前轨道算出真有几种节面**，而不是只写"你开了哪一类"。
   *
   * ★ 为什么要按轨道算：这个 chip 描述的是**画面上高亮着的东西**，而高亮的内容每次换轨道
   *   都会重建（见 refreshSpotlight）。原先文字是写死的"径向节面 + 角度节面高亮"，
   *   于是 3s（两层球壳、没有角度节面）与 3d（两个锥面、没有径向节面）显示**同一句话**，
   *   而画面根本不是一回事 —— 文字没跟上它描述的对象（用户第 1 条）。
   * ★ 数量为 0 的那一类**不写**：写"角度节面 ×0"只会让人去找一个不存在的东西。
   * ★ 数量直接给出来还有教学价值：径向节面数 = n−l−1、角度节面数 = l，学生点开就能对。
   */
  function nodeChipText(types) {
    const S = (window.OrbitApp && window.OrbitApp.getState()) || {};
    const n = S.n, l = S.l, m = S.m, mode = S.wavefunction || 'real';
    const Zn = S.nuclearCharge || 1;
    const parts = [];
    if (types.indexOf('radial') >= 0 && n != null && l != null) {
      const k = OM.radialZeros(n, l, Zn).length;
      if (k > 0) parts.push('径向节面 ×' + k);
    }
    if (types.indexOf('angular') >= 0 && l != null) {
      const nd = OM.angularNodes(l, m, mode) || {};
      const k = ((nd.cones || []).length) + ((nd.planes || []).length);
      if (k > 0) parts.push('角度节面 ×' + k);
    }
    if (!parts.length) return '本轨道没有节面';
    return parts.join(' + ') + '高亮';
  }

  /**
   * 高亮节面（把节点公式变成可点亮、可数的几何对象）。
   *   type='radial'  → 在每个径向零点半径处画线框球（"套娃"结构）
   *   type='angular' → 在每个角度节面的 θ 处画圆锥、φ 处画过 z 轴的平面
   * 节面几何由 math.js 确定性给出，不依赖视觉推断。
   *
   * ★ type 也接受**数组**（如 ['radial','angular']）—— 界面上的「节面」按钮一次点亮两类。
   *   这时只清除本次要重建的那一类，另一类原样保留（原先一律全清，点第二次会把第一次的抹掉）。
   */
  function spotlightNodes(type, on) {
    const g = ensureAuxGroup();
    const types = Array.isArray(type) ? type.slice() : [type];
    // 清除旧的节面对象 —— **只清本次涉及的类型**
    for (let i = g.children.length - 1; i >= 0; i--) {
      const c = g.children[i];
      if (c.userData.kind === 'node' && types.indexOf(c.userData.spot) >= 0) {
        g.remove(c); if (c.geometry) c.geometry.dispose(); if (c.material) c.material.dispose();
      }
    }
    if (!on) {
      // 只把被点掉的那几类从记录里去掉；都去掉了才整个清空
      if (curSpotlight) {
        curSpotlight.types = curSpotlight.types.filter((t) => types.indexOf(t) < 0);
        if (!curSpotlight.types.length) curSpotlight = null;
      }
      setChip('nodes', curSpotlight ? nodeChipText(curSpotlight.types) + '  ✕' : null,
        curSpotlight ? function () { spotlightNodes(curSpotlight.types, false); } : null);
      notifyAuxChange();
      return;
    }
    curSpotlight = { types: (curSpotlight ? curSpotlight.types.concat(types) : types)
      .filter((t, i, a) => a.indexOf(t) === i) };
    // 同一个标签兼管两类节面，点击即全部清除
    setChip('nodes', nodeChipText(curSpotlight.types) + '  ✕',
      function () { spotlightNodes(curSpotlight.types.slice(), false); });

    const S = (window.OrbitApp && window.OrbitApp.getState()) || {};
    const n = S.n, l = S.l, m = S.m, mode = S.wavefunction || 'real';
    const Zn = S.nuclearCharge || 1;            // 径向节面半径随 1/Z 缩，不带 Z 会画错位置
    if (n == null || l == null) return;
    // ★ 尺度必须**按档取**（第 18 条）：球谐曲面归一到半径 1（取景 ANGULAR_FRAME_EXTENT = 1.8），
    //   而 gridExtent 是 ψ 的网格尺度（随轨道在 1.5～16.7 之间）。原先一律用 gridExtent，
    //   于是球谐档下节面锥面/平面被放大十几倍，整片糊在画面上、根本读不出是锥还是面。
    const sph = (S.viewTarget === 'spherical');
    const R = sph ? ANGULAR_FRAME_EXTENT : (gridExtent || 10);

    if (types.indexOf('radial') >= 0) {
      // 径向节面：以核为中心的球壳
      // ★ 两极那束密集的线**没有物理含义**：SphereGeometry 是经纬参数化造出来的球，
      //   经线从一极出发、到另一极汇合；而 `wireframe: true` 会把三角化后的**每一条边**
      //   都画出来（含对角边），于是两极收成一束。径向节面本身是**球壳**（r = 常数）、
      //   各向同性，连经线纬线都是人为的。
      // ★ 但**极点朝向**可以选，而且该选 z：
      //   three.js 的 SphereGeometry 极点按它的惯例在 ±y，而本程序是化学约定、z 竖直，
      //   θ 从 +z 量起。转 90° 让网格的赤道落在 xy 平面、两极落在 ±z，线框的经纬结构就与
      //   全程序的 θ 约定、以及绕 z 建的角度节面（锥面/平面）对齐了。
      //   顺带一个实测好处：初始相机在 (0,−4,3)，±y 极点与视线只差 37°（正对着看，
      //   那束线落在球面投影的中央）；转到 ±z 后差 53°，挪到上下轮缘、被球体自遮一部分。
      const zeros = OM.radialZeros(n, l, Zn);
      const seg = 48;
      for (const r of zeros) {
        const geo = new THREE.SphereGeometry(r, seg, 24);
        // ★ 极点从 three.js 的默认 ±y 转到 ±z —— 见上面那段说明（对齐本程序的 θ 约定）
        geo.rotateX(Math.PI / 2);
        const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
          color: 0x7ad4ff, wireframe: true, transparent: true, opacity: 0.30, depthWrite: false,
        }));
        mesh.userData.kind = 'node';
        mesh.userData.spot = 'radial';
        // 径向节面只对 ψ 档有意义（球谐档画的是半径 1 的角度曲面，套娃球不在其中）
        mesh.userData.rOnly = true;
        g.add(mesh);
      }
    }
    if (types.indexOf('angular') >= 0) {
      const matA = new THREE.MeshBasicMaterial({ color: 0xff8ad4, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false });
      // ★ 必须把 **带符号的 m** 传进去，不能取绝对值 —— 这一处曾出过错：
      //   angularNodes 内部是按符号分流的（m>0 给 cos φ 型、零点在 φ=π/2 即 **yz 平面**；
      //   m<0 给 sin φ 型、零点在 φ=0 即 **xz 平面**），传 Math.abs(m) 会把两者压成同一种，
      //   于是 3p_x 与 3p_y 的节面**画在同一个平面上** —— 而 p_y 的瓣正沿 ±y，
      //   那个平面恰好穿过波函数中间。学生看到的是"一个穿过了波函数、一个刚好是节面"。
      const nodes = OM.angularNodes(l, m, mode);
      // 锥面：用"圆环 + 母线"示意，读作以 z 轴为轴、半顶角 θ 的锥
      for (const th of nodes.cones) {
        // ★ 半顶角 **90° 的锥面其实是一个平面**（就是 xy 平面）—— 锥退化了。
        //   若照锥面的画法画成"一圈线 + 四条母线"，学生看到的是"一个圆"，
        //   会读成"节面是圆锥面/圆柱面"，而它明明是个平面；更糟的是**同一个 xy 平面**
        //   若由 φ 方向给出（走下面的 planes 分支）却画成矩形 —— 同一种几何、两种画法，
        //   这正是"4p_z 的节面是圆形、4p_x 却是矩形"的来源。
        //   统一到这里：θ=90° 归入平面画法（PlaneGeometry 的法线初值就是 +z，无需旋转）。
        if (Math.abs(th - Math.PI / 2) < 0.02) {
          const geo0 = new THREE.PlaneGeometry(R * 2, R * 2);
          const mesh0 = new THREE.Mesh(geo0, matA.clone());
          mesh0.userData.kind = 'node'; mesh0.userData.spot = 'angular';
          g.add(mesh0);
          continue;
        }
        const rho = R * Math.sin(th), z = R * Math.cos(th);
        // ★ 填充锥面（用户："对于锥形的角度节面，应稍微填充一下"）。
        //   原先只画"一圈线 + 四条母线"，读起来是个线框，与"过 z 轴的半透明矩形"那种
        //   填充画法**不一致** —— 同样是角度节面，一个要学生自己脑补出面来，一个是现成的面。
        //   锥的顶点在核、张口朝 ±z：半顶角 θ ⟹ 底半径 : 高 = tanθ，
        //   故取 高 = |R cosθ|、底半径 = R sinθ，与线框那个圆正好重合。
        const coneH = Math.abs(z);
        const coneGeo = new THREE.ConeGeometry(rho, coneH, 48, 1, true);   // openEnded：只要侧面
        // ConeGeometry 的顶点在 +H/2、底在 −H/2、轴沿 y。先平移把顶点挪到原点，
        // 再绕 x 转 ∓90° 让轴落到 ±z（θ<90° 张口朝 +z，θ>90° 朝 −z）。
        coneGeo.translate(0, -coneH / 2, 0);
        coneGeo.rotateX(z >= 0 ? -Math.PI / 2 : Math.PI / 2);
        const cone = new THREE.Mesh(coneGeo, matA.clone());
        cone.userData.kind = 'node'; cone.userData.spot = 'angular';
        g.add(cone);
        // 口沿那圈线保留：填充面在深色背景上对比度不高，一圈亮线把"锥的口"交代清楚。
        // （原先还有 4 条母线；有了填充面之后它们成了多余的线，去掉。）
        const circle = new THREE.EllipseCurve(0, 0, rho, rho, 0, Math.PI * 2, false, 0);
        const pts = circle.getPoints(64).map((p) => new THREE.Vector3(p.x, p.y, z));
        const cg = new THREE.BufferGeometry().setFromPoints(pts);
        const line = new THREE.Line(cg, new THREE.LineBasicMaterial({ color: 0xff8ad4, transparent: true, opacity: 0.55 }));
        line.userData.kind = 'node'; line.userData.spot = 'angular';
        g.add(line);
      }
      // 平面节点（实函数 m≠0）：过 z 轴的半透明矩形
      for (const ph of nodes.planes) {
        const geo = new THREE.PlaneGeometry(R * 2, R * 2);
        const mesh = new THREE.Mesh(geo, matA.clone());
        mesh.userData.kind = 'node'; mesh.userData.spot = 'angular';
        // ★ 第四个参数（欧拉顺序 'ZYX'）**不能省**，这是"3p_x 与 3p_y 的节面落在同一个
        //   平面上"的第二个原因（第一个是传了 Math.abs(m)），而且它更隐蔽：
        //   PlaneGeometry 的法线初值是 +z。默认顺序 'XYZ' 生成 R = Rx·Ry·Rz，
        //   作用到向量时 **Rz 先作用** —— 而绕 z 轴转无论如何都改不动 (0,0,1)，
        //   于是 Rx(π/2) 把它压成 (0,−1,0) 之后，ph 就再也影响不到结果了：
        //   所有节面平面一起落在同一方位（实测 dump 出的法线恒为 [0,−1,0]）。
        //   'ZYX' 给出 R = Rz·Ry·Rx，Rx 先作用、Rz 最后作用，ph 才真正决定方位角：
        //     ph=π/2（cos φ 型）→ 法线 (1,0,0)，节面是 yz 平面
        //     ph=0  （sin φ 型）→ 法线 (0,−1,0)，节面是 xz 平面
        mesh.rotation.set(Math.PI / 2, 0, ph, 'ZYX');
        g.add(mesh);
      }
      matA.dispose();
    }
    syncAuxVisibility(sph ? 'spherical' : 'wave');
    auxSpotKey = spotKeyOf();
    notifyAuxChange();
  }

  /** 节面几何依赖的轨道参数指纹 —— 变了就得重建 */
  function spotKeyOf() {
    const S = (window.OrbitApp && window.OrbitApp.getState()) || {};
    return [S.n, S.l, S.m, S.wavefunction, S.nuclearCharge, S.viewTarget, S.terms ? S.terms.length : 0].join('/');
  }

  /**
   * 节面高亮**跟着轨道走**（第 11 条）。
   *
   * ★ 原先 spotlightNodes 只在被显式调用时建一次，之后换轨道（n/l/m、实/复、Z、甚至
   *   切球谐档）都不会重建 —— 于是"从 3s 切到 3d"之后，画面上仍然是 3s 的那两层球壳，
   *   学生数出来的节点数是**上一个轨道**的。这类"看着还在、其实已经错了"的残留最难发现。
   * ★ 放在 setVisibility 里（每次 recompute 都经过），并用参数指纹去重 —— 拖滑块时
   *   每帧重建一张球壳网格没有必要。
   */
  let auxSpotKey = null;
  function refreshSpotlight() {
    if (!curSpotlight || !curSpotlight.types.length) return;
    if (spotKeyOf() === auxSpotKey) return;
    spotlightNodes(curSpotlight.types.slice(), true);
  }

  /**
   * 辅助几何与当前档位的相容性。
   *
   * ★ 原先 setVisibility 完全不管 auxGroup，于是切到球谐档后，ψ 档画下的径向节面球
   *   会一直留在画面上 —— 而球谐档画的是半径 1 的角度曲面，那些"套娃"球既不在其中、
   *   也说不通。
   * ★ 第 16 条：径向类（参考球 / 径向节面球）在球谐档要**移除**而不是"隐藏" ——
   *   隐藏会留下"看不见、却还挂在那里、画布上的 chip 也还在"的中间态；学生要么点不到
   *   那个 chip，要么点了没反应（它本来就在球谐档里不显示），感受就是"关不掉"。
   *   直接移除并把 chip 一并收掉，语义就只有一种：这一档没有它。
   *   角度节面（锥面 / 平面）反过来对两档都有意义，保留。
   */
  function syncAuxVisibility(kind) {
    if (!auxGroup) return;
    const sph = (kind === 'spherical');
    if (!sph) {
      for (let i = 0; i < auxGroup.children.length; i++) auxGroup.children[i].visible = true;
      return;
    }
    let changed = false;
    for (let i = auxGroup.children.length - 1; i >= 0; i--) {
      const c = auxGroup.children[i];
      if (!c.userData.rOnly) { c.visible = true; continue; }
      auxGroup.remove(c);
      if (c.geometry) c.geometry.dispose();
      if (c.material) c.material.dispose();
      changed = true;
    }
    if (curRingRadius) { curRingRadius = 0; setChip('ring', null); changed = true; }
    if (curSpotlight && curSpotlight.types.indexOf('radial') >= 0) {
      curSpotlight.types = curSpotlight.types.filter((t) => t !== 'radial');
      setChip('nodes', curSpotlight.types.length
        ? nodeChipText(curSpotlight.types) + '  ✕'
        : null,
        curSpotlight.types.length ? function () { spotlightNodes(curSpotlight.types.slice(), false); } : null);
      if (!curSpotlight.types.length) curSpotlight = null;
      changed = true;
    }
    if (changed) notifyAuxChange();
  }

  const api = {
    init, render, resize, setAutoRotate, resetView,
    updateCloud, updateSurface, setSurfaceLevel, setVisibility,
    disposeGrid, setNucleusVisible,
    updateAngular, angularFrameExtent,
    ringHighlight, spotlightNodes,
    /**
     * 把世界点投到屏幕像素。
     * ★ 判「画面里这个东西是不是太大了」时，靠看截图和靠心算是两回事 —— 相机的视锥是
     *   透视的，物体占多大取决于它到**视轴**的横向距离，不只是相机距离，很容易算错
     *   （本轮就把 40% 误算成 4%，白查了一轮）。投一下最直接。
     */
    _proj: (x, y, z) => {
      if (!camera) return null;
      const v = new THREE.Vector3(x, y, z).project(camera);
      const r = renderer.getSize(new THREE.Vector2());
      return { sx: +(((v.x + 1) / 2) * r.x).toFixed(1), sy: +(((1 - v.y) / 2) * r.y).toFixed(1),
        w: r.x, h: r.y, ndc: [+v.x.toFixed(3), +v.y.toFixed(3), +v.z.toFixed(3)] };
    },
    /** 注册「辅助几何变化」回调（界面按钮据此同步亮灭） */
    setAuxChangeHandler: (fn) => { auxChangeCb = fn; },
    /**
     * 场景里各对象的可见性与世界尺度 —— 排查"画面里那个大绿块到底是什么"这类问题用。
     * 只报概览（名字 / visible / 尺度 / 顶点数），不泄露任何内部结构。
     */
    _dumpScene: () => {
      if (!scene) return null;
      const out = [];
      scene.traverse((o) => {
        if (!o.isMesh && !o.isPoints && !o.isLine && !o.isLineSegments && !o.isGroup) return;
        if (o.isGroup) return;
        const s = new THREE.Vector3();
        o.getWorldScale(s);
        // ★ 平面（角度节面）额外报**世界法线**：节面方位是"肉眼最难判断、又最容易画错"
        //   的东西（p_x 与 p_y 的节面只差 90°，画错了画面看着都像"一个斜切的平面"），
        //   报出来才能定量核对 —— 与 _proj 一样，靠截图猜迟早会猜错。
        let nrm = null;
        if (o.geometry && o.geometry.type === 'PlaneGeometry') {
          const n = new THREE.Vector3(0, 0, 1)
            .applyQuaternion(o.getWorldQuaternion(new THREE.Quaternion()));
          nrm = [+n.x.toFixed(3), +n.y.toFixed(3), +n.z.toFixed(3)];
        }
        // ★ 同时报两种"可见"，它们**不等价**：
        //   · vis   —— 物体**自身的** visible 标志（原字段，语义保持不变，别处有脚本在读）
        //   · shown —— **实际会不会被渲染**（自身与所有祖先都 visible）
        //   只报 vis 会把人带沟里：球谐曲面 angMesh 自身的 visible 恒为 true，它该不该显示
        //   是由父组 angGroup 控制的 —— 只看 vis 会得出"切回波函数档后球谐仍在显示"的
        //   错误结论（本轮据此误判过一次，白查了一轮）。
        let shown = o.visible;
        for (let a = o.parent; a && shown; a = a.parent) shown = a.visible;
        out.push({
          type: o.type, vis: o.visible, shown: shown, scale: +s.x.toFixed(3),
          // ★ 再报一层"挂在哪个组下、那个组可见吗"：定位"物体自身 visible=true 却被父组
          //   关掉"（或反过来）这类问题时，没有这一项就只能靠猜父链。
          grp: (o.parent ? ((o.parent.name || o.parent.type) + (o.parent.visible ? '+vis' : '-hid')) : '-'),
          // ★ 报出**几何类型**：判断"某个东西到底画成了什么形状"最直接的依据。
          //   例如角度节面是锥面还是平面、有没有被填充（Mesh）还是只是一圈线（Line），
          //   靠截图猜容易看错（透视下一个半透明锥与一个三角形很像）。
          geo: (o.geometry && o.geometry.type) || null,
          verts: o.geometry && o.geometry.getAttribute('position') ? o.geometry.getAttribute('position').count : 0,
          nrm: nrm,
        });
      });
      return out;
    },
    /** 取当前"画上去的辅助几何"状态（参考球 / 节面高亮） */
    getAnnotations: () => ({
      ring: curRingRadius, spotlight: curSpotlight,
      // 球谐曲面的**实际顶点最大半径**：它按设计恒为 1（归一化到单位球），
      // 报出来是为了让"画面里它有多大"可核对，而不是靠看截图猜。
      angRadius: (function () {
        if (!angMesh || !angMesh.geometry) return null;
        const p = angMesh.geometry.getAttribute('position');
        if (!p) return null;
        let mx = 0;
        for (let i = 0; i < p.count; i++) {
          const r = Math.hypot(p.getX(i), p.getY(i), p.getZ(i));
          if (r > mx) mx = r;
        }
        return +mx.toFixed(4);
      })(),
      /** 各类辅助对象的**可见**数量 —— 供测试与调试确认"切档后径向球确实收起来了" */
      auxVisible: (function () {
        const out = { ring: 0, radial: 0, angular: 0 };
        if (!auxGroup) return out;
        for (let i = 0; i < auxGroup.children.length; i++) {
          const c = auxGroup.children[i];
          if (!c.visible) continue;
          if (c.userData.kind === 'ring') out.ring++;
          else if (c.userData.spot === 'radial') out.radial++;
          else if (c.userData.spot === 'angular') out.angular++;
        }
        return out;
      })(),
    }),
    /** 还原辅助几何状态；供演示「上一步」回退使用 */
    setAnnotations: (a) => {
      a = a || {};
      ringHighlight(a.ring > 0 ? a.ring : 0);
      // ★ 先全部清掉再按记录重建 —— curSpotlight 现在记的是**类型数组**（第 18 条），
      //   回退时若只加不退会出现"上一步之后节面还留着"。
      spotlightNodes(['radial', 'angular'], false);
      if (a.spotlight && a.spotlight.types && a.spotlight.types.length) {
        spotlightNodes(a.spotlight.types, true);
      }
    },
    /**
     * 当前等值面的**几何摘要**：顶点数 / 三角形数 + 位置与法线的定点校验和。
     *
     * ★ 供离线验证用。本轮把重建切成多帧执行之后，最难证、也最该证的一条是
     *   "结果与切片前逐位一致" —— 而只比顶点数是能被凑巧蒙混过去的（顶点数相同、
     *   位置整体偏了一点点）。
     * ★ 这里刻意用**逐元素滚动哈希**而不是"各分量求和"：本项目的曲面几乎都是中心
     *   对称的（正负坐标成对出现），求和会大幅抵消，实测 6 个用例里有 4 个回到 0 ——
     *   一个恒等于 0 的判据看起来"全过"，实际上什么都没验。哈希不会抵消。
     *   量化到 1e6 后按 int32 混合：任何一处浮点差异都会改变最终的 32 位数。
     * 粗曲面与细颈补片分别给出 —— 两者是**两块独立的网格**，只对其中一块下结论会漏。
     */
    meshDigest: () => {
      const hash6 = (arr) => {
        let h = 0x811c9dc5;
        for (let i = 0; i < arr.length; i++) {
          h ^= (Math.round(arr[i] * 1e6) | 0);
          h = Math.imul(h, 0x01000193);
        }
        return h >>> 0;
      };
      const pack = (o) => {
        if (!o || !o.geometry) return null;
        const g = o.geometry;
        const pos = g.getAttribute('position');
        if (!pos) return null;
        const nor = g.getAttribute('normal');
        const idx = g.getIndex();
        return {
          verts: pos.count,
          tris: idx ? idx.count / 3 : 0,
          posHash: hash6(pos.array),
          norHash: nor ? hash6(nor.array) : null,
        };
      };
      // ★ 附带报出**当前生效的着色**。它由判据派生（见 main.js 的 deriveColorMode），
      //   刻意不进 getState —— 那是"状态"，着色是"推论"。但调试面里必须有它：
      //   posHash / norHash **只覆盖几何**，判据变了而阈值换算正确时它们是**逐位不变**的，
      //   于是"着色到底有没有跟着变"就只剩截图一条路 —— 而截图正是最容易看错的那种证据。
      return {
        field: fieldDesc, fieldKey: fieldKey,
        coarse: pack(surfaceObj), fine: pack(fineObj),
        colorMode: currentColorMode,
      };
    },
    /** 相机状态查询（供测试与"预设视角"复用） */    getCameraState: () => (camera ? {
      pos: camera.position.toArray().map((v) => +v.toFixed(3)),
      orient: camera.quaternion.toArray().map((v) => +v.toFixed(4)),
      dist: viewCtl ? +viewCtl.getDistance().toFixed(3) : null,
      gridExtent: +gridExtent.toFixed(3),
      autoRotate: viewCtl ? viewCtl.isAutoRotate() : null,
      // ★ fov / aspect / 帧尺度也报出来：判断"物体在画面里该多大"离不开它们。
      //   少了这三个数，截图看起来"太大/太小"时只能猜（本轮就因为缺它多绕了一圈）。
      fov: +camera.fov.toFixed(2),
      aspect: +camera.aspect.toFixed(3),
      frameExtent: +(typeof currentFrameExtent === 'function' ? currentFrameExtent() : 0).toFixed(3),
    } : null),
  };
  return api;
})();
