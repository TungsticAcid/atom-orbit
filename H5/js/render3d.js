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
  let nucleusObj = null;
  let axesObj = null;
  let gridObj = null;
  let decorGroup = null;        // 坐标轴 + 赤道环（随轨道尺度整体缩放）

  // 角度分布 3D 曲面（独立小场景）：r(θ,φ) 从原点沿 (θ,φ) 引射线
  let angScene = null, angCamera = null, angRenderer = null, angCtl = null, angMesh = null, angAxes = null;
  let angResizeObs = null;      // 角度小场景的尺寸观察器
  let angLastKey = '';
  const ANG_RES = 30;           // θ 方向网格数

  // 标量场（由 grid 节点构成），缓存以便调整阈值时不必重算 |ψ|²
  let field = null, gradX = null, gradY = null, gradZ = null;
  let nGrid = 0, gridExtent = 0, fieldMax = 0;
  // 当前标量场各轴节点的坐标。均匀网格时三轴相同且等距；局部精细化的细网格用
  // **径向渐变**（核附近密、往外稀）—— 单靠提高分辨率救不了细颈：
  // 缝隙 0.24a₀ 要在 5.66a₀ 半径的盒子里跨 4 个单元格，均匀网格需要 ~190³ ≈ 108MB。
  let gridXs = null;

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
   * 计算 |ψ|² 标量场（缓存在模块级），供 buildSurface / setSurfaceLevel 复用。
   * res 为每轴网格点数（立方）；level 为绝对值阈值，用于自适应网格范围。
   *
   * 网格范围 = 该阈值下等值面的实际外延（而非波函数渐近尾部）。这一步很关键：
   * 例如 2p_z 按尾部取需 ±23.5，而阈值 8% 时等值面只在 ±8 内，同样 68³ 节点
   * 的格距会相差 3 倍——格距过粗时，节面附近两瓣之间约 1 a₀ 的缝只有一两个格子宽，
   * 行进算法无法分辨，会把两瓣连成一体并被切出"平底贴合"的丑陋形状。
   */
  function computeField(n, l, m, mode, res, level, terms, relPhase, extentOverride, grading) {
    const iso = (level > 0) ? level : 0;
    // 叠加态：范围取各分量外延的最大值；否则按单一本征态
    const useSuper = !!(terms && terms.length);
    const extent = (extentOverride > 0)
      ? extentOverride            // 局部精细化的细网格：盒子必须正好等于节点球半径
      : (useSuper
        ? Math.max(
          OM.superpositionRefExtent(terms) * 1.15,          // 取景基准（与阈值无关，保证常见阈值下盒子稳定）
          OM.superpositionIsoRadius(terms, iso) * 1.12,     // ★ 还要装得下当前阈值对应的等值面
          //    （阈值越低面越大；少了这一项，低阈值下曲面会被盒子切出平边）
          1.5)
        : Math.max(OM.isoRadius(n, l, m, mode, iso) * 1.12, 1.2));
    nGrid = res;
    gridExtent = extent;
    const NN = nGrid * nGrid * nGrid;      // 节点总数
    field = new Float32Array(NN);
    gradX = new Float32Array(NN); gradY = new Float32Array(NN); gradZ = new Float32Array(NN);

    let maxVal = 0;

    // ★ 性能：|ψ|² 的主力开销是径向部分（pow + exp + 拉盖尔递推）。
    //   固定 (n,l) 下用 R² 查表替代，并把坐标预计算、用 sqrt 替代较慢的 hypot。
    //   实测单次重建由 ~1200ms 降到 ~250ms 量级，滑块与扫参动画因此才跟得上手。
    const psi2Fast = useSuper
      ? (function () {
          const phases = terms.map((t, i) => i * (relPhase || 0));
          return function (r, theta, phi) { return OM.densitySuperposition(terms, r, theta, phi, phases); };
        })()
      : OM.makePsiDensityFast(n, l, m, mode, extent * 1.8);
    const xs = makeAxisCoords(nGrid, extent, grading || 0);
    gridXs = xs;

    for (let k = 0; k < nGrid; k++) {
      const z = xs[k];
      const zz = z * z;
      const kBase = k * nGrid * nGrid;
      for (let j = 0; j < nGrid; j++) {
        const y = xs[j];
        const yy = y * y + zz;
        const jBase = kBase + j * nGrid;
        for (let i = 0; i < nGrid; i++) {
          const x = xs[i];
          const r = Math.sqrt(x * x + yy);
          const theta = r > 1e-9 ? Math.acos(Math.max(-1, Math.min(1, z / r))) : 0;
          const phi = Math.atan2(y, x);
          const v = psi2Fast(r, theta, phi);
          field[jBase + i] = v;
          if (v > maxVal) maxVal = v;
        }
      }
    }
    fieldMax = maxVal;
    computeGradient();
    return { maxVal: maxVal, extent: extent };
  }

  // 节点梯度：中心差由 field 数组读取（无需额外 psi 计算）
  /**
   * 由标量场算 ∇|ψ|²（取反 → 朝外法线）。
   * ★ 分母用**实际坐标差**而不是 (i1−i0)·step：细网格用径向渐变，节点间距不等，
   *   沿用均匀间距会让法线在各轴上的权重不一致（法线歪掉 → 光照看出条纹）。
   */
  function computeGradient() {
    const n = nGrid;
    const X = gridXs;
    const idx = (i, j, k) => k * n * n + j * n + i;
    for (let k = 0; k < n; k++) {
      for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
          const id = idx(i, j, k);
          const i0 = Math.max(0, i - 1), i1 = Math.min(n - 1, i + 1);
          const j0 = Math.max(0, j - 1), j1 = Math.min(n - 1, j + 1);
          const k0 = Math.max(0, k - 1), k1 = Math.min(n - 1, k + 1);
          // 取反：∇|ψ|² 指向密度增大方向（对成键轨道朝核内），法线应为朝外 → 负梯度
          gradX[id] = (field[idx(i0, j, k)] - field[idx(i1, j, k)]) / (X[i1] - X[i0]);
          gradY[id] = (field[idx(i, j0, k)] - field[idx(i, j1, k)]) / (X[j1] - X[j0]);
          gradZ[id] = (field[idx(i, j, k0)] - field[idx(i, j, k1)]) / (X[k1] - X[k0]);
        }
      }
    }
  }

  // 提取等值面，返回 BufferGeometry
  /**
   * 行进四面体抽取等值面。
   *
   * @param {number} iso          等值面的绝对值（|ψ|²）
   * @param {number} [maskR]      >0 时启用球形掩膜（半径，世界单位）
   * @param {boolean} [keepInside] true=只处理**整格都在球内**的单元；
   *                              false=跳过这些单元（其余照常）。
   *
   * ★ 掩膜用来做"局部精细化"：粗网格跳过节点球内的单元，细网格只填球内。
   *   两边的单元集合互斥且完整覆盖，因此两片曲面既不重叠也不留缝
   *   （球面正好取在径向节点上，那里 |ψ|²=0、本来就没有曲面）。
   *   判据取"单元里离原点最远的那个角"——整格都在球内 ⇔ 最远角在球内。
   */
  function extractSurface(iso, maskR, keepInside) {
    const n = nGrid;
    const n2 = n * n;
    const X = gridXs;                  // 节点坐标（均匀或径向渐变）
    // 掩膜：每个单元**中心**在各轴上离原点的距离（三轴公式相同，共用一张表）。
    // ★ 用单元中心而不是"最远的角"：用最远的角会把跨界单元整格推给粗网格，
    //   而那些单元里含有内层壳的曲面 → 细网格又画一遍 → 重叠出碎三角片。
    const useMask = maskR > 0;
    const maskR2 = maskR * maskR;
    let cArr = null;
    if (useMask) {
      cArr = new Float64Array(n);
      for (let t = 0; t < n; t++) cArr[t] = Math.abs((X[t] + X[t + 1]) / 2);
    }

    // ★ 性能关键：本函数在 68³ 网格上要处理约 1.8M 个四面体。
    //   原实现每个四面体都在 map / filter / findIndex 里分配数组，
    //   造成巨大 GC 压力——实测占等值面重建总耗时的约 78%（~600ms）。
    //   现改为零分配：角点 id 直接算、交点直接写入输出数组、绕向判定用局部变量。
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

    const cIds = new Int32Array(8);
    const in4 = new Uint8Array(4);
    const tIds = new Int32Array(4);

    for (let k = 0; k < n - 1; k++) {
      const kBase = k * n2;
      const kz2 = useMask ? cArr[k] * cArr[k] : 0;
      for (let j = 0; j < n - 1; j++) {
        const jBase = kBase + j * n;
        const jy2 = useMask ? kz2 + cArr[j] * cArr[j] : 0;
        for (let i = 0; i < n - 1; i++) {
          if (useMask) {
            // 单元中心在球内 ⇔ 归细网格；否则归粗网格（两边互斥且完整覆盖）
            const inside = (jy2 + cArr[i] * cArr[i]) <= maskR2;
            if (inside !== !!keepInside) continue;
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
              const ins = field[id] >= iso ? 1 : 0;
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
    }

    // 构建几何（法线来自梯度、方向朝外；绕向已在 pushTri 中强制一致）
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geo.setIndex(indices);
    geo.computeBoundingSphere();
    return geo;
  }

  /**
   * 仅调整等值面阈值或着色方式：
   *   · 阈值变了 → 需重新提取网格
   *   · 只有着色变了 → 复用已有网格，仅重涂顶点色（快得多）
   */
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
    // ★ 叠加态用「无干涉参考峰值」Σ|cᵢ|²peakᵢ 作基准，而不是实际扫描峰值：
    //   干涉会让实际峰值高出近 2 倍，若按它取 30%，曲面会远小于单一轨道并碎成几块。
    const peak = (P.terms && P.terms.length)
      ? OM.superpositionRefPeak(P.terms)
      : OM.maxDensity(P.n, P.l, P.m, P.mode);
    return (psiCrit === 'psi') ? fraction * fraction * peak : fraction * peak;
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
      if (!surfaceObj || critChanged || needGrow || needShrink) {
        // ★ terms / relPhase 必须一起传下去。漏了它们，computeField 会把叠加态当成
        //   单一本征态重算 —— 盒子按单轨道定尺寸（可塌到 1.2 的下限）、内容也不是叠加态。
        //   叠加态"一调阈值体积就变 0"正是这么来的。
        computeField(P.n, P.l, P.m, P.mode, lastRes, levelAbs, P.terms, P.relPhase);
      }
      rebuildSurface(false);   // 仅阈值/着色变化：相机原则上不动
      // ★ 但阈值低到曲面胀出当前取景时就必须拉远，否则曲面被裁。
      //   fitViewIfNeeded 只在"尺度真的变了"时才动相机，故常见阈值区间
      //   （≥30% 参考水平）仍是相机纹丝不动，只有往低调时才逐步拉远。
      fitViewIfNeeded(currentFrameExtent(), lastDecorExtent);
    } else if (colorChanged && surfaceGeoRef) {
      paintSurfaceColors(surfaceGeoRef);
      // ★ 局部精细化的补片是**另一块网格**，必须一起重涂。
      //   漏了这一步，切三维着色时外层壳（粗网格画）会变色、内层壳（细网格画）
      //   却保持旧色，看起来像"只改了一半"。
      if (fineObj) paintSurfaceColors(fineObj.geometry);
    }
  }

  function buildSurface(levelFraction, refit) {
    if (!field) return;
    surfaceLevelFraction = levelFraction;
    rebuildSurface(!!refit);
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
        let col;
        if (P.terms) {
          // 叠加态：相位直接取整个叠加态波函数的 arg ψ
          col = OM.phaseColor(OM.psiSuperposition(P.terms, r, th, ph, phases).arg(), 0.62);
        } else {
          col = (P.mode === 'real')
            ? OM.phaseColor(OM.angularReal(P.l, P.m, th, ph) >= 0 ? 0 : Math.PI, 0.62)
            : OM.phaseColor(OM.angularComplex(P.l, P.m, th, ph).arg(), 0.62);
        }
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

  // 顶点平滑（Taubin λ-μ 迭代）：松弛行进四面体产生的离散凹凸，使表面光滑且体积基本不变
  function smoothVertices(positions, indices, iterations) {
    const nv = positions.length / 3;
    // 用邻接数组（比 Set 更省内存）
    const deg = new Uint32Array(nv);
    // 先统计度
    for (let i = 0; i < indices.length; i += 3) {
      deg[indices[i]]++; deg[indices[i + 1]]++; deg[indices[i + 2]]++;
    }
    const off = new Int32Array(nv + 1);
    for (let v = 0; v < nv; v++) off[v + 1] = off[v] + deg[v];
    const adj = new Int32Array(off[nv]);          // 按总度数分配，绝不越界
    for (let v = 0; v < nv; v++) deg[v] = 0;      // 复用为写入游标
    for (let i = 0; i < indices.length; i += 3) {
      const a = indices[i], b = indices[i + 1], c = indices[i + 2];
      const put = (u, w) => { let ok = true; for (let k = off[u]; k < off[u] + deg[u]; k++) if (adj[k] === w) { ok = false; break; } if (ok) adj[off[u] + deg[u]++] = w; };
      put(a, b); put(a, c); put(b, a); put(b, c); put(c, a); put(c, b);
    }
    const tmp = new Float32Array(positions.length);
    for (let it = 0; it < iterations; it++) {
      const lambda = (it % 2 === 0) ? 0.5 : -0.53;    // Taubin: 交替正负
      for (let v = 0; v < nv; v++) {
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
      positions.set(tmp);
    }
  }

  // 焊接行进输出的"三角形汤"为真正的索引网格（合并重复顶点，法线取平均并归一化）
  function weldTriangleSoup(positions, normals, indices) {
    const npos = positions.length / 3;
    const map = new Map();
    const wp = [], wn = [], wmap = new Array(npos);
    const PREC = 1e4;
    for (let i = 0; i < npos; i++) {
      const key = Math.round(positions[3 * i] * PREC) + '_' +
                  Math.round(positions[3 * i + 1] * PREC) + '_' +
                  Math.round(positions[3 * i + 2] * PREC);
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
    const win = new Uint32Array(indices.length);
    for (let i = 0; i < indices.length; i++) win[i] = wmap[indices[i]];
    const nv = wp.length / 3;
    for (let v = 0; v < nv; v++) {
      const len = Math.hypot(wn[3 * v], wn[3 * v + 1], wn[3 * v + 2]) || 1;
      wn[3 * v] /= len; wn[3 * v + 1] /= len; wn[3 * v + 2] /= len;
    }
    return { positions: new Float32Array(wp), normals: new Float32Array(wn), indices: win };
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
  const FINE_RES_MAX = 112;      // 细网格分辨率上限（112³ ≈ 1.1M 节点 ≈ 18MB）
  const FINE_SETTLE_MS = 450;    // 距上次重建小于此值视为"用户还在连续调整"
  let fineObj = null;            // 精细化补出来的那块曲面
  let lastRebuildAt = 0;
  let fineRetryTimer = null;

  /**
   * 拖阈值时每一步都会重建，细网格要多花约 0.7 秒，连续拖动会明显发卡。
   * 所以：**连续调整期间先跳过精细化，停下来后自动补一次**。
   * 关键是"补一次"——否则跳过之后就再也没人触发重建，细网格永远不出现。
   */
  function scheduleFineRetry() {
    if (fineRetryTimer) return;
    fineRetryTimer = setTimeout(function () {
      fineRetryTimer = null;
      rebuildSurface(false);
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
   *   ② l ≥ 1 且有径向节点——细颈由**角节面**造成，径向节点提供无接缝的分界面
   *   ③ 细颈比粗网格单元格还窄——粗网格已经分得开就不必精细化
   */
  function planFinePatch(iso) {
    if (window.__ORBIT_PREVIEW__) return null;                 // 拖动中不付这份开销
    // 连续调整期间跳过（见 scheduleFineRetry）：先保证拖动跟手，停下来再补精细化
    if (performance.now() - lastRebuildAt < FINE_SETTLE_MS) { scheduleFineRetry(); return null; }
    const P = surfaceParams;
    if (!P || (P.terms && P.terms.length)) return null;
    if (P.l < 1 || P.n - P.l - 1 < 1) return null;
    // ★ 分界球面必须落在"两层壳之间**必然**没有曲面"的位置（见 shellGaps 的推导），
    //   否则两套网格会在交界处各画一遍 → 重叠、z-fighting、碎三角片。
    //   放在径向节点上也**不行**：节点虽然 |ψ|²=0，但两侧的曲面都贴着它，跨界的单元
    //   里照样含曲面。
    const gaps = OM.shellGaps(P.n, P.l, P.m, P.mode, iso);
    if (!gaps.length) return null;                             // 只有一层壳 → 无需分层
    // 细网格覆盖到第几层？盒子越大、远处的单元格越粗，所以要权衡：
    //   ① 盖得越多，越多"折角"（壳的内/外边界，曲率最高处）能摆脱粗网格的锯齿；
    //   ② 盒半径 L 越大，同样 112³ 节点摊到每一层就越粗。
    // 经验规则：最多外扩到最内分界的 3 倍（此时最外侧那层仍有 ~3 个细单元格的余量）。
    let radius = gaps[0];
    for (let i = 1; i < gaps.length; i++) if (gaps[i] <= gaps[0] * 3) radius = gaps[i];
    const half = OM.isoNeckHalf(P.n, P.l, P.m, P.mode, iso, radius);
    if (!isFinite(half) || !(half > 0)) return null;
    const gap = 2 * half;
    const cellCoarse = (2 * gridExtent) / (nGrid - 1);
    if (gap > 2.5 * cellCoarse) return null;                   // 粗网格分得开，不必精细化
    // 让缝隙跨约 2.5 个细单元格：盒边长 2·radius，故 res ≈ 2·radius/(gap/2.5) = 5·radius/gap
    // 让缝隙跨约 2.5 个细单元格：盒边长 2·radius，故 res ≈ 2·radius/(gap/2.5) = 5·radius/gap
    let res = Math.ceil((5 * radius) / gap);
    res = Math.min(Math.max(res, nGrid), FINE_RES_MAX);
    // ★ 细网格用**径向渐变**坐标。缝隙要跨 ~4 个单元格才不会被焊在一起：
    //   均匀网格在半径 radius 的盒子里做到这点需要 res ≈ 4·2·radius/gap ≈ 190³（≈108MB）；
    //   渐变后同样的节点数足以把核附近的单元格压到 gap/4。
    //   x = L(a·u + (1−a)u³) 在 u=0 处的间距 = L·a·du，由此反解 a。
    const du = 2 / (res - 1);
    const grade = Math.max(0.15, Math.min(1, (gap / 4) / (radius * du)));
    return { radius: radius, res: res, gap: gap, cellCoarse: cellCoarse, grade: grade };
  }

  /** 在节点球内用更细的网格重算并抽取那块曲面（需在粗网格建好之后调用） */
  function buildFinePatch(iso, plan) {
    if (!plan) return null;
    const P = surfaceParams;
    // computeField / extractSurface 都读写模块级的那几个场量，这里先存后还原，
    // 免得为了"再算一张网格"去把整条管线改成传参式（改动大、风险高）。
    const saved = { field: field, gx: gradX, gy: gradY, gz: gradZ,
      n: nGrid, ext: gridExtent, mx: fieldMax, xs: gridXs };
    let soup = null;
    try {
      computeField(P.n, P.l, P.m, P.mode, plan.res, iso, null, 0, plan.radius, plan.grade);
      soup = extractSurface(iso, plan.radius, true);           // 只取中心在球内的单元
    } finally {
      field = saved.field; gradX = saved.gx; gradY = saved.gy; gradZ = saved.gz;
      nGrid = saved.n; gridExtent = saved.ext; fieldMax = saved.mx;
      // ★ gridXs 也必须还原：粗网格后续的抽取（如换阈值时复用缓存场）仍要用它。
      //   漏了这一步，粗网格会用细网格的渐变坐标去解释自己的场 → 形状整体错乱。
      gridXs = saved.xs;
    }
    if (!soup || !soup.getAttribute('position').count) return null;
    const welded = weldTriangleSoup(
      soup.getAttribute('position').array,
      soup.getAttribute('normal').array,
      soup.getIndex().array
    );
    const nv = welded.positions.length / 3;
    // ★ 这里**刻意不做 Taubin 平滑**（粗网格那一步要做）。
    //   平滑的作用尺度正比于网格间距：粗网格 0.82a₀ 间距下 2 轮只抹掉行进四面体的
    //   锯齿（正是设计意图），但细网格是 0.11a₀ 间距，同样 2 轮会抹平 0.2a₀ 尺度的
    //   东西 —— 那恰好就是细颈的尺寸，于是真实的喇叭口被抹成弯月面（"像有表面张力"、
    //   曲率符号翻转）。而细网格的锯齿在正常缩放下不到 1 像素，本来也不需要平滑。
    fineObj = meshFromWelded(welded);
    scene.add(fineObj);
    return { verts: nv, res: plan.res, radius: plan.radius, gap: plan.gap, grade: plan.grade };
  }

  function rebuildSurface(refit) {
    // 本次已在重建，作废排队中的那次"补精细化"重试
    if (fineRetryTimer) { clearTimeout(fineRetryTimer); fineRetryTimer = null; }
    if (surfaceObj) {
      scene.remove(surfaceObj);
      surfaceObj.geometry.dispose();
      surfaceObj.material.dispose();
      surfaceObj = null;
    }
    disposeFine();
    surfaceGeoRef = null;
    const __t0 = performance.now();
    const iso = Math.max(1e-9, surfaceLevelFraction * fieldMax);
    // 先决定要不要精细化：粗网格抽取时就要跳过节点球内的单元
    const finePlan = planFinePatch(iso);
    const geo = extractSurface(iso, finePlan ? finePlan.radius : 0, false);
    if (!geo.getAttribute('position').count) {
      // ★ 抽出空面时也要留下现场：否则"体积为 0"这类问题连 fieldMax 是多少、
      //   阈值相对基准高出多少都看不到（下面那个探针在 return 之后，够不着）。
      if (window.__ORBIT_DEBUG__) {
        window.__SURF_TIMING__ = {
          empty: true, verts: 0, total: Math.round(performance.now() - __t0),
          nGrid: nGrid, gridExtent: +gridExtent.toFixed(4),
          fieldMax: +fieldMax.toFixed(8), fraction: +surfaceLevelFraction.toFixed(4),
          isoAbs: +iso.toFixed(8),
          refPeak: surfaceParams ? +levelAbsFor(surfaceParams, 1, surfaceParams.psiCrit).toFixed(8) : null,
          terms: surfaceParams && surfaceParams.terms ? surfaceParams.terms.length : 0,
        };
      }
      lastRebuildAt = performance.now();
      return;
    }
    const __tExtract = performance.now();
    // 焊接 → 平滑（消除行进四面体的离散凹凸，轮廓更光滑）
    const welded = weldTriangleSoup(
      geo.getAttribute('position').array,
      geo.getAttribute('normal').array,
      geo.getIndex().array
    );
    const nv = welded.positions.length / 3;
    if (nv > 800 && nv < 300000) smoothVertices(welded.positions, welded.indices, 2);
    const __tWeld = performance.now();

    surfaceObj = meshFromWelded(welded);
    const geo2 = surfaceObj.geometry;
    surfaceGeoRef = geo2;

    // ★ 局部精细化：节点球内那一块改用更细的网格（粗网格已跳过球内单元）
    const fineInfo = buildFinePatch(iso, finePlan);
    // 诊断探针：仅在 window.__ORBIT_DEBUG__ 为真时记录（默认关闭，不产生开销）。
    // 除耗时外还记下"这一次抽面用的是哪个场、什么阈值"——排查"曲面为空 / 尺寸异常
    // / 换了预设却没变"这类问题时，没有这些数字就只能靠猜。
    if (window.__ORBIT_DEBUG__) {
      window.__SURF_TIMING__ = {
        extract: Math.round(__tExtract - __t0),
        weldSmooth: Math.round(__tWeld - __tExtract),
        build: Math.round(performance.now() - __tWeld),
        total: Math.round(performance.now() - __t0),
        verts: geo2.getAttribute('position').count,
        // ---- 场与阈值的状态 ----
        nGrid: nGrid,
        gridExtent: +gridExtent.toFixed(4),
        fieldMax: +fieldMax.toFixed(8),
        fraction: +surfaceLevelFraction.toFixed(4),
        isoAbs: +(surfaceLevelFraction * fieldMax).toFixed(8),
        // 阈值"应该"取的基准（无干涉参考峰值 Σ|cᵢ|²·peakᵢ）——与 isoAbs 对照即可看出
        // 两者是否用了同一个基准
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
        // ---- 局部精细化 ----
        fine: fineInfo
          ? { 触发: true, 细网格: fineInfo.res + '³', 渐变系数: fineInfo.grade,
              节点球半径: +fineInfo.radius.toFixed(3),
              细颈缝隙: +fineInfo.gap.toFixed(3), 细网格顶点: fineInfo.verts }
          : { 触发: false, 粗网格单元格: +((2 * gridExtent) / (nGrid - 1)).toFixed(3) },
      };
    }
    scene.add(surfaceObj);
    lastRebuildAt = performance.now();     // 供"是否还在连续调整"判断
    // ★ 只在"换轨道 / 复位"时重新取景；切换判据、阈值、渲染方式时相机保持不动
    if (refit) fitViewIfNeeded(currentFrameExtent(), frameExtentFor(surfaceParams));
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
    const refAbs = FRAME_REF_LEVEL * OM.maxDensity(P.n, P.l, P.m, P.mode);
    return Math.max(OM.isoRadius(P.n, P.l, P.m, P.mode, refAbs) * 1.12, 1.2);
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
      return Math.max(OM.superpositionRefExtent(P.terms) * 1.25, 1.5);
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
    const base = S.terms && S.terms.length
      ? Math.max(OM.superpositionRefExtent(S.terms) * 1.25, 1.5)
      : frameExtentFor({ n: S.n, l: S.l, m: S.m, mode: S.wavefunction, psiCrit: S.psiCriterion, terms: null });
    const levelAbs = levelAbsFor(
      { n: S.n, l: S.l, m: S.m, mode: S.wavefunction, terms: S.terms },
      S.levelFraction, S.psiCriterion);
    const need = frameExtentForLevel(
      { n: S.n, l: S.l, m: S.m, mode: S.wavefunction, terms: S.terms }, levelAbs);
    return Math.max(base, need);
  }

  /** 按"给定绝对阈值"取景的尺度（与 frameExtentFor 同构，只把基准换成实际阈值） */
  function frameExtentForLevel(P, levelAbs) {
    const r = (P.terms && P.terms.length)
      ? OM.superpositionIsoRadius(P.terms, levelAbs)
      : OM.isoRadius(P.n, P.l, P.m, P.mode, levelAbs);
    return Math.max(r * 1.12 * 1.25, 1.5);      // 与 refExtentFor × frameExtentFor 的系数保持一致
  }

  let currentL = 0;
  let currentColorMode = 'phase';      // 'phase' | 'orbital'
  let surfaceGeoRef = null;            // 当前等值面几何（供"只改着色"时快速重涂）
  let surfaceParams = null;            // 当前等值面对应的 (n,l,m,mode)，供重涂/重算时用
  let lastRes = 68;                    // 上次使用的网格分辨率

  function updateSurface(n, l, m, mode, res, levelFraction, colorMode, psiCrit, terms, relPhase) {
    currentL = l;
    currentColorMode = colorMode || 'phase';
    lastRes = res;
    surfaceParams = {
      n: n, l: l, m: m, mode: mode, psiCrit: psiCrit || 'psi2',
      terms: (terms && terms.length) ? terms : null,
      relPhase: relPhase || 0,
    };
    // 叠加态时阈值按各分量峰值的加权和为基准；单一态时按解析峰值
    const levelAbs = levelAbsFor(surfaceParams, levelFraction, surfaceParams.psiCrit);
    computeField(n, l, m, mode, res, levelAbs, surfaceParams.terms, surfaceParams.relPhase);
    buildSurface(levelFraction, true);   // 换轨道 → 尺度变了，重新取景
  }

  // ---------------------------------------------------------------------------
  // 显示模式
  // ---------------------------------------------------------------------------
  function setVisibility(mode) {
    if (cloudObj) cloudObj.visible = (mode === 'points');
    if (surfaceObj) surfaceObj.visible = (mode === 'surface');
    if (nucleusObj) nucleusObj.visible = true;
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
   * ★ 同时作用于**主视图与角度分布小场景**：两处都是"绕着看形状"，共用一个开关
   *   才符合直觉，也省得再加一套控件。原先小场景在 init 时写死 setAutoRotate(true)，
   *   用户没有任何入口关掉它 —— "角度分布图的自动旋转无法控制"就是这么来的。
   */
  function setAutoRotate(v) {
    if (viewCtl) viewCtl.setAutoRotate(v);
    if (angCtl) angCtl.setAutoRotate(v);
  }
  function resetView() {
    if (!viewCtl) return;
    viewCtl.resetHome();                       // 回到初始朝向（z 向上）
    fitView(currentFrameExtent(), frameExtentFor(null));
  }
  function disposeGrid() {           // 释放等值面缓存的标量场
    field = null; gradX = gradY = gradZ = null; nGrid = 0;
    disposeFine();                   // 精细化补片同样依赖这个场，一并清掉
  }

  // ---------------------------------------------------------------------------
  // 角度分布 3D 曲面（独立小场景）
  //   r(θ,φ)：从原点沿 (θ,φ) 方向引射线，长度 = |Y| 或 |Y|²。
  //   实函数按 Y 符号分色（+青 / −橙），复函数按相位（arg Y）彩虹着色。
  // ---------------------------------------------------------------------------
  function initAngular(container) {
    const w = container.clientWidth || 300, h = container.clientHeight || 200;
    angScene = new THREE.Scene();
    angCamera = new THREE.PerspectiveCamera(45, w / h, 0.01, 40);
    angRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    angRenderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    angRenderer.setSize(w, h);
    container.appendChild(angRenderer.domElement);
    // 同样使用四元数控制器（小场景不需要平移，旋转 + 缩放即可）
    angCtl = createQuatOrbit(angCamera, angRenderer.domElement, {
      distance: 3.4, rotateSpeed: 1.0, damping: 0.2, autoRotateSpeed: 0.006,
    });
    angCtl.setView(new THREE.Vector3(0, -2.6, 2.2), new THREE.Vector3(0, 0, 0));
    angCtl.setLimits(1.2, 12);
    angCtl.setAutoRotate(true);
    buildAngularAxes();

    // 同理：小场景也要跟随容器尺寸变化（图表卡宽度随响应式布局改变）
    if (window.ResizeObserver) {
      const ro = new ResizeObserver(function () {
        const w = container.clientWidth, h = container.clientHeight;
        if (w > 0 && h > 0) resizeAngular(w, h);
      });
      ro.observe(container);
      angResizeObs = ro;
    }
  }

  // 小坐标轴（x 红 / y 绿 / z 蓝，z 竖直）与参考球
  function buildAngularAxes() {
    const pts = [];
    const mk = (a, b) => { pts.push(new THREE.Vector3(...a), new THREE.Vector3(...b)); };
    mk([-1.6, 0, 0], [1.6, 0, 0]); mk([0, -1.6, 0], [0, 1.6, 0]); mk([0, 0, -1.6], [0, 0, 1.6]);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pts.flatMap(v => [v.x, v.y, v.z]), 3));
    const mat = new THREE.LineBasicMaterial({ color: 0x77809b, transparent: true, opacity: 0.6 });
    angAxes = new THREE.LineSegments(geo, mat);
    angScene.add(angAxes);
  }

  // 按 (l,m,mode,which) 重建角度曲面
  function updateAngular(l, m, mode, which) {
    if (!angScene) return;
    const key = l + '-' + m + '-' + mode + '-' + which;
    if (key === angLastKey) return;
    angLastKey = key;
    if (angMesh) { angScene.remove(angMesh); angMesh.geometry.dispose(); angMesh.material.dispose(); angMesh = null; }

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
        let Y, len;
        if (mode === 'real') {
          Y = OM.angularReal(l, m, th, ph);
          len = (which === 'Y2') ? Y * Y : Math.abs(Y);
        } else {
          const c = OM.angularComplex(l, m, th, ph);
          const mag = c.abs();
          len = (which === 'Y2') ? mag * mag : mag;
          // 复：按相位着色
          const hue = ((c.arg() / (2 * Math.PI)) % 1 + 1) % 1 * 360;
          const hsl = OM.hslToRgb(hue, 0.85, 0.58);
          const idx = (i * (NP + 1) + j) * 3;
          clr[idx] = hsl[0]; clr[idx + 1] = hsl[1]; clr[idx + 2] = hsl[2];
        }
        rval[i * (NP + 1) + j] = len;
        if (len > maxR) maxR = len;
        if (mode === 'real') {
          // ★ 着色只由「实函数 / 复函数」决定，与「|Y| 还是 |Y|²」**无关**。
          //   颜色表达的是相位信息（实函数 → 符号），而相位不因把半径画成 |Y| 还是
          //   |Y|² 而改变——判据只改径向轮廓。复函数分支本来就是这么做的（两种判据
          //   同色），这里统一过来，也才与模块注释、README 的描述一致。
          //   （原先 |Y|² 另走一套强度色标，是全项目唯一一处"颜色随判据变"的地方。）
          const idx = (i * (NP + 1) + j) * 3;
          const c = (Y >= 0) ? [0.42, 0.8, 1.0] : [1.0, 0.6, 0.25];   // + 青 / − 橙
          clr[idx] = c[0]; clr[idx + 1] = c[1]; clr[idx + 2] = c[2];
        }
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
    const mat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
    angMesh = new THREE.Mesh(geo, mat);
    angScene.add(angMesh);
  }

  function renderAngular() {
    if (angRenderer && angScene && angCamera) {
      if (angCtl) angCtl.update();
      angRenderer.render(angScene, angCamera);
    }
  }
  function resizeAngular(w, h) {
    if (!angCamera || !angRenderer) return;
    angCamera.aspect = w / h;
    angCamera.updateProjectionMatrix();
    angRenderer.setSize(w, h);
  }

  // ---------------------------------------------------------------------------
  // 教学辅助：参考球（linkRadialTo3D）与节面高亮（spotlightNodes）
  // 这两者把"径向图上的一个横坐标"与"三维中的一层壳"在空间上对应起来，
  // 是本工具区别于普通轨道查看器的关键教学动作。
  // ---------------------------------------------------------------------------
  let auxGroup = null;

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
      el.addEventListener('click', onClear);
      chipBar().appendChild(el);
      chipEls[key] = el;
    }
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
    g.add(mesh);
    setChip('ring', '参考球 r = ' + radius.toFixed(2) + ' a₀  ✕', function () { ringHighlight(0); });
  }

  /**
   * 高亮节面（把节点公式变成可点亮、可数的几何对象）。
   *   type='radial'  → 在每个径向零点半径处画线框球（"套娃"结构）
   *   type='angular' → 在每个角节点的 θ 处画圆锥、φ 处画过 z 轴的平面
   * 节面几何由 math.js 确定性给出，不依赖视觉推断。
   */
  function spotlightNodes(type, on) {
    const g = ensureAuxGroup();
    // 清除旧的节面对象
    for (let i = g.children.length - 1; i >= 0; i--) {
      if (g.children[i].userData.kind === 'node') {
        const c = g.children[i];
        g.remove(c); if (c.geometry) c.geometry.dispose(); if (c.material) c.material.dispose();
      }
    }
    if (!on) {
      curSpotlight = null;
      setChip('nodes', null);
      return;
    }
    curSpotlight = { type: type, on: true };
    // 同一个标签兼管两种节面（radial/angular），点击即全部清除
    setChip('nodes', (type === 'radial' ? '径向节面' : '角节面') + '高亮  ✕',
      function () { spotlightNodes(type, false); });

    const S = (window.OrbitApp && window.OrbitApp.getState()) || {};
    const n = S.n, l = S.l, m = S.m, mode = S.wavefunction || 'real';
    if (n == null || l == null) return;
    const R = gridExtent || 10;

    const matR = new THREE.MeshBasicMaterial({ color: 0x7ad4ff, wireframe: true, transparent: true, opacity: 0.30, depthWrite: false });
    const matA = new THREE.MeshBasicMaterial({ color: 0xff8ad4, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false });

    if (type === 'radial') {
      // 径向节面：以核为中心的球壳
      const zeros = OM.radialZeros(n, l);
      const seg = 48;
      for (const r of zeros) {
        const geo = new THREE.SphereGeometry(r, seg, 24);
        const mesh = new THREE.Mesh(geo, matR.clone());
        mesh.userData.kind = 'node';
        g.add(mesh);
      }
      if (!zeros.length) matR.dispose();
    } else {
      const nodes = OM.angularNodes(l, Math.abs(m), mode);
      // 锥面：用"圆环 + 母线"示意，读作以 z 轴为轴、半顶角 θ 的锥
      for (const th of nodes.cones) {
        const rho = R * Math.sin(th), z = R * Math.cos(th);
        const circle = new THREE.EllipseCurve(0, 0, rho, rho, 0, Math.PI * 2, false, 0);
        const pts = circle.getPoints(64).map((p) => new THREE.Vector3(p.x, p.y, z));
        const cg = new THREE.BufferGeometry().setFromPoints(pts);
        const line = new THREE.Line(cg, new THREE.LineBasicMaterial({ color: 0xff8ad4, transparent: true, opacity: 0.55 }));
        line.userData.kind = 'node';
        g.add(line);
        // 4 条母线，帮助读出锥面
        for (let k = 0; k < 4; k++) {
          const a = (k * Math.PI) / 2;
          const lg = new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(0, 0, 0),
            new THREE.Vector3(rho * Math.cos(a), rho * Math.sin(a), z),
          ]);
          const ll = new THREE.Line(lg, new THREE.LineBasicMaterial({ color: 0xff8ad4, transparent: true, opacity: 0.35 }));
          ll.userData.kind = 'node';
          g.add(ll);
        }
      }
      // 平面节点（实函数 m≠0）：过 z 轴的半透明矩形
      for (const ph of nodes.planes) {
        const geo = new THREE.PlaneGeometry(R * 2, R * 2);
        const mesh = new THREE.Mesh(geo, matA.clone());
        mesh.userData.kind = 'node';
        // 平面法线方向为 φ+90°，绕 z 转 ph 使其落在方位角 ph 处
        mesh.rotation.set(Math.PI / 2, 0, ph);
        g.add(mesh);
      }
      matR.dispose();
    }
  }

  const api = {
    init, render, resize, setAutoRotate, resetView,
    updateCloud, updateSurface, setSurfaceLevel, setVisibility,
    disposeGrid, setNucleusVisible,
    initAngular, updateAngular, renderAngular, resizeAngular,
    ringHighlight, spotlightNodes,
    /** 取当前"画上去的辅助几何"状态（参考球 / 节面高亮） */
    getAnnotations: () => ({ ring: curRingRadius, spotlight: curSpotlight }),
    /** 还原辅助几何状态；供演示「上一步」回退使用 */
    setAnnotations: (a) => {
      a = a || {};
      ringHighlight(a.ring > 0 ? a.ring : 0);
      if (a.spotlight && a.spotlight.on) spotlightNodes(a.spotlight.type, true);
      else spotlightNodes('radial', false);
    },
    /** 相机状态查询（供测试与"预设视角"复用） */
    getCameraState: () => (camera ? {
      pos: camera.position.toArray().map((v) => +v.toFixed(3)),
      orient: camera.quaternion.toArray().map((v) => +v.toFixed(4)),
      dist: viewCtl ? +viewCtl.getDistance().toFixed(3) : null,
      gridExtent: +gridExtent.toFixed(3),
      autoRotate: viewCtl ? viewCtl.isAutoRotate() : null,
    } : null),
    /** 角度分布小场景的状态（同一开关应同时作用于它） */
    getAngularState: () => (angCtl ? {
      dist: +angCtl.getDistance().toFixed(3),
      autoRotate: angCtl.isAutoRotate(),
    } : null),
  };
  return api;
})();
