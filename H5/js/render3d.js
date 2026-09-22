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
  //   · 偏航 yaw   —— 绕【世界 Z 轴】旋转（世界系 → 左乘 premultiply）
  //   · 俯仰 pitch —— 绕【相机自身 X 轴（右向量）】旋转（局部系 → 右乘 multiply）
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
      resetHome: () => setView(homeEye, homeLook),
      getDistance: () => distance,
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
  let angLastKey = '';
  const ANG_RES = 30;           // θ 方向网格数

  // 标量场（由 grid 节点构成），缓存以便调整阈值时不必重算 |ψ|²
  let field = null, gradX = null, gradY = null, gradZ = null;
  let nGrid = 0, gridExtent = 0, fieldMax = 0;
  let surfaceLevelFraction = 0.08;

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
    fitView(cloud.extent);
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
  function computeField(n, l, m, mode, res, level) {
    const iso = (level > 0) ? level : 0;
    const extent = Math.max(OM.isoRadius(n, l, m, mode, iso) * 1.12, 1.2);
    nGrid = res;
    gridExtent = extent;
    const NN = nGrid * nGrid * nGrid;      // 节点总数
    field = new Float32Array(NN);
    gradX = new Float32Array(NN); gradY = new Float32Array(NN); gradZ = new Float32Array(NN);

    const step = (2 * extent) / (nGrid - 1);
    let maxVal = 0;

    for (let k = 0; k < nGrid; k++) {
      const z = -extent + k * step;
      for (let j = 0; j < nGrid; j++) {
        const y = -extent + j * step;
        for (let i = 0; i < nGrid; i++) {
          const x = -extent + i * step;
          const r = Math.hypot(x, y, z);
          const theta = r > 1e-9 ? Math.acos(Math.max(-1, Math.min(1, z / r))) : 0;
          const phi = Math.atan2(y, x);
          const v = OM.psiDensity(n, l, m, r, theta, phi, mode);
          field[k * nGrid * nGrid + j * nGrid + i] = v;
          if (v > maxVal) maxVal = v;
        }
      }
    }
    fieldMax = maxVal;
    computeGradient(step);
    return { maxVal: maxVal, extent: extent };
  }

  // 节点梯度：中心差由 field 数组读取（无需额外 psi 计算）
  function computeGradient(step) {
    const n = nGrid;
    const idx = (i, j, k) => k * n * n + j * n + i;
    for (let k = 0; k < n; k++) {
      for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
          const id = idx(i, j, k);
          const i0 = Math.max(0, i - 1), i1 = Math.min(n - 1, i + 1);
          const j0 = Math.max(0, j - 1), j1 = Math.min(n - 1, j + 1);
          const k0 = Math.max(0, k - 1), k1 = Math.min(n - 1, k + 1);
          // 取反：∇|ψ|² 指向密度增大方向（对成键轨道朝核内），法线应为朝外 → 负梯度
          gradX[id] = (field[idx(i0, j, k)] - field[idx(i1, j, k)]) / ((i1 - i0) * step);
          gradY[id] = (field[idx(i, j0, k)] - field[idx(i, j1, k)]) / ((j1 - j0) * step);
          gradZ[id] = (field[idx(i, j, k0)] - field[idx(i, j, k1)]) / ((k1 - k0) * step);
        }
      }
    }
  }

  // 节点 id -> [x,y,z]
  function nodeCoord(id) {
    const n = nGrid;
    const k = Math.floor(id / (n * n));
    const rem = id - k * n * n;
    const j = Math.floor(rem / n);
    const i = rem - j * n;
    const step = (2 * gridExtent) / (nGrid - 1);
    return [
      -gridExtent + i * step,
      -gridExtent + j * step,
      -gridExtent + k * step,
    ];
  }

  // 提取等值面，返回 BufferGeometry
  function extractSurface(iso) {
    const n = nGrid;
    const positions = [];
    const normals = [];
    const indices = [];
    const idx = (i, j, k) => k * n * n + j * n + i;

    // 求线段 (a,b) 与 isosurface 交点及插值梯度
    const crossInfo = (idA, idB) => {
      const va = field[idA], vb = field[idB];
      let t = (iso - va) / (vb - va);
      if (!isFinite(t)) t = 0.5;
      const ca = nodeCoord(idA), cb = nodeCoord(idB);
      return {
        p: [ca[0] + t * (cb[0] - ca[0]), ca[1] + t * (cb[1] - ca[1]), ca[2] + t * (cb[2] - ca[2])],
        n: [gradX[idA] + t * (gradX[idB] - gradX[idA]),
            gradY[idA] + t * (gradY[idB] - gradY[idA]),
            gradZ[idA] + t * (gradZ[idB] - gradZ[idA])],
      };
    };
    // 推入一个三角形并强制"一致朝外"绕向：几何法线与梯度法线(朝外)对齐，否则交换顶点序。
    // 否则绕向随机会让 DoubleSide 按 gl_FrontFacing 乱翻法线 → 面片明暗不均。
    const pushTri = (pts) => {
      if (!pts || pts.length < 3) return;
      const [p0, p1, p2] = [pts[0].p, pts[1].p, pts[2].p];
      // 几何法线 = (p1-p0) × (p2-p0)
      const ax = p1[0] - p0[0], ay = p1[1] - p0[1], az = p1[2] - p0[2];
      const bx = p2[0] - p0[0], by = p2[1] - p0[1], bz = p2[2] - p0[2];
      const gnx = ay * bz - az * by, gny = az * bx - ax * bz, gnz = ax * by - ay * bx;
      // 朝外法线 = 各顶点梯度法线平均值
      const onx = (pts[0].n[0] + pts[1].n[0] + pts[2].n[0]) / 3;
      const ony = (pts[0].n[1] + pts[1].n[1] + pts[2].n[1]) / 3;
      const onz = (pts[0].n[2] + pts[1].n[2] + pts[2].n[2]) / 3;
      const order = (gnx * onx + gny * ony + gnz * onz) >= 0 ? [0, 1, 2] : [0, 2, 1];
      for (const k of order) {
        positions.push(pts[k].p[0], pts[k].p[1], pts[k].p[2]);
        normals.push(pts[k].n[0], pts[k].n[1], pts[k].n[2]);
      }
      const base = positions.length / 3 - 3;   // 本三角形首顶点的索引
      indices.push(base, base + 1, base + 2);
    };

    for (let k = 0; k < n - 1; k++) {
      for (let j = 0; j < n - 1; j++) {
        for (let i = 0; i < n - 1; i++) {
          // 8 个角点的全局 id
          const c = CUBE_OFF.map(o => idx(i + o[0], j + o[1], k + o[2]));
          for (const tet of TETS) {
            const ids = tet.map(t => c[t]);
            const vals = ids.map(v => field[v]);
            const inFlag = vals.map(v => v >= iso);
            const cnt = inFlag.filter(Boolean).length;
            if (cnt === 0 || cnt === 4) continue;

            if (cnt === 1 || cnt === 3) {
              const oddIdx = cnt === 1
                ? inFlag.findIndex(Boolean)                        // 唯一的"内"顶点
                : inFlag.findIndex(v => !v);                       // 唯一的"外"顶点
              const ptList = [];
              for (let e = 0; e < 4; e++) if (e !== oddIdx) ptList.push(crossInfo(ids[oddIdx], ids[e]));
              pushTri(ptList);
            } else {  // cnt === 2
              const ins = [], outs = [];
              for (let e = 0; e < 4; e++) (inFlag[e] ? ins : outs).push(e);
              const pac = crossInfo(ids[ins[0]], ids[outs[0]]);
              const pad = crossInfo(ids[ins[0]], ids[outs[1]]);
              const pbc = crossInfo(ids[ins[1]], ids[outs[0]]);
              const pbd = crossInfo(ids[ins[1]], ids[outs[1]]);
              pushTri([pac, pbc, pbd]);
              pushTri([pac, pbd, pad]);
            }
          }
        }
      }
    }

    // 构建几何（法线来自梯度、方向朝外；三角形绕向已在 pushTri 中强制一致）
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
    const peak = OM.maxDensity(P.n, P.l, P.m, P.mode);
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
      const newExtent = Math.max(OM.isoRadius(P.n, P.l, P.m, P.mode, levelAbs) * 1.12, 1.2);
      if (!surfaceObj || critChanged || Math.abs(newExtent - gridExtent) / gridExtent > 0.12) {
        computeField(P.n, P.l, P.m, P.mode, lastRes, levelAbs);
      }
      rebuildSurface();
    } else if (colorChanged && surfaceGeoRef) {
      paintSurfaceColors(surfaceGeoRef);
    }
  }

  function buildSurface(levelFraction) {
    if (!field) return;
    surfaceLevelFraction = levelFraction;
    rebuildSurface();
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
      for (let i = 0; i < cnt; i++) {
        const x = posAttr.getX(i), y = posAttr.getY(i), z = posAttr.getZ(i);
        const r = Math.hypot(x, y, z);
        const th = r > 1e-9 ? Math.acos(Math.max(-1, Math.min(1, z / r))) : 0;
        const ph = Math.atan2(y, x);
        const col = (P.mode === 'real')
          ? OM.phaseColor(OM.angularReal(P.l, P.m, th, ph) >= 0 ? 0 : Math.PI, 0.62)
          : OM.phaseColor(OM.angularComplex(P.l, P.m, th, ph).arg(), 0.62);
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

  function rebuildSurface() {
    if (surfaceObj) {
      scene.remove(surfaceObj);
      surfaceObj.geometry.dispose();
      surfaceObj.material.dispose();
      surfaceObj = null;
    }
    surfaceGeoRef = null;
    const iso = Math.max(1e-9, surfaceLevelFraction * fieldMax);
    const geo = extractSurface(iso);
    if (!geo.getAttribute('position').count) return;
    // 焊接 → 平滑（消除行进四面体的离散凹凸，轮廓更光滑）
    const welded = weldTriangleSoup(
      geo.getAttribute('position').array,
      geo.getAttribute('normal').array,
      geo.getIndex().array
    );
    const nv = welded.positions.length / 3;
    if (nv > 800 && nv < 300000) smoothVertices(welded.positions, welded.indices, 2);

    const geo2 = new THREE.BufferGeometry();
    geo2.setAttribute('position', new THREE.BufferAttribute(welded.positions, 3));
    geo2.setAttribute('normal', new THREE.BufferAttribute(welded.normals, 3));
    geo2.setIndex(new THREE.BufferAttribute(welded.indices, 1));
    geo2.computeBoundingSphere();
    paintSurfaceColors(geo2);          // 顶点着色（相位色 / 轨道色）
    surfaceGeoRef = geo2;

    // 基色置白，实际颜色全部来自顶点色；不透明实体 + 朝外梯度法线 → 平滑实心
    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      vertexColors: true,
      roughness: 0.5,
      metalness: 0.0,
      side: THREE.DoubleSide,
    });
    surfaceObj = new THREE.Mesh(geo2, mat);
    scene.add(surfaceObj);
    const refExt = refExtentFor(surfaceParams);
    fitView(Math.max(refExt, gridExtent), refExt);
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
  const FRAME_REF_LEVEL = 0.30;
  function refExtentFor(P) {
    if (!P) return gridExtent;
    const refAbs = FRAME_REF_LEVEL * OM.maxDensity(P.n, P.l, P.m, P.mode);   // 恒按 |ψ|² 记
    return Math.max(OM.isoRadius(P.n, P.l, P.m, P.mode, refAbs) * 1.12, 1.2);
  }

  let currentL = 0;
  let currentColorMode = 'phase';      // 'phase' | 'orbital'
  let surfaceGeoRef = null;            // 当前等值面几何（供"只改着色"时快速重涂）
  let surfaceParams = null;            // 当前等值面对应的 (n,l,m,mode)，供重涂/重算时用
  let lastRes = 68;                    // 上次使用的网格分辨率

  function updateSurface(n, l, m, mode, res, levelFraction, colorMode, psiCrit) {
    currentL = l;
    currentColorMode = colorMode || 'phase';
    lastRes = res;
    surfaceParams = { n: n, l: l, m: m, mode: mode, psiCrit: psiCrit || 'psi2' };
    // 先把"占峰值的比例"（按当前判据）换算成 |ψ|² 绝对值，才能定出随阈值自适应的网格范围
    const levelAbs = levelAbsFor(surfaceParams, levelFraction, surfaceParams.psiCrit);
    computeField(n, l, m, mode, res, levelAbs);
    buildSurface(levelFraction);
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
  function fitView(extent, decorExt) {
    if (!camera || !viewCtl) return;
    const dist = Math.max(extent * 2.8, 3);
    camera.near = Math.max(extent * 0.02, 1e-3);
    camera.far = extent * 60;
    camera.updateProjectionMatrix();
    viewCtl.setLimits(extent * 0.15, extent * 40);
    viewCtl.setDistance(dist);
    // 装饰参照（坐标轴 ±12、赤道环 r=12）缩放为固定标尺
    const de = decorExt || extent;
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
  }
  function setAutoRotate(v) { if (viewCtl) viewCtl.setAutoRotate(v); }
  function resetView() {
    if (!viewCtl) return;
    viewCtl.resetHome();                       // 回到初始朝向（z 向上）
    if (gridExtent) fitView(gridExtent);
  }
  function disposeGrid() {           // 释放等值面缓存的标量场
    field = null; gradX = gradY = gradZ = null; nGrid = 0;
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
          const idx = (i * (NP + 1) + j) * 3;
          if (which === 'Y2') {
            // |Y|² 暂时填 0，第二遍按密度上色；先存符号无关——此处用密度色
          } else {
            const c = (Y >= 0) ? [0.42, 0.8, 1.0] : [1.0, 0.6, 0.25];   // + 青 / − 橙
            clr[idx] = c[0]; clr[idx + 1] = c[1]; clr[idx + 2] = c[2];
          }
        }
      }
    }
    if (maxR < 1e-12) maxR = 1e-12;
    // 第二遍：实函数 |Y|² 的密度着色 + 生成顶点/索引
    for (let i = 0; i <= NT; i++) {
      const th = Math.PI * i / NT;
      const sT = Math.sin(th), cT = Math.cos(th);
      for (let j = 0; j <= NP; j++) {
        const ph = 2 * Math.PI * j / NP;
        const vid = i * (NP + 1) + j;
        const radius = (rval[vid] / maxR) * 1.0;      // 归一化到最大半径 1（世界单位）
        positions.push(radius * sT * Math.cos(ph), radius * sT * Math.sin(ph), radius * cT);
        if (mode === 'real' && which === 'Y2') {
          const t = rval[vid] / maxR;
          const col = simpleColorScale(t);
          clr[vid * 3] = col[0]; clr[vid * 3 + 1] = col[1]; clr[vid * 3 + 2] = col[2];
        }
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

  // 角度曲面用的强度色标（深蓝→青→黄→红），避免依赖 Charts
  function simpleColorScale(t) {
    t = Math.max(0, Math.min(1, t));
    const s = [[0, 10, 40], [0.3, 40, 90, 180], [0.55, 45, 190, 220], [0.8, 255, 200, 80], [1, 255, 80, 80]];
    for (let i = 1; i < s.length; i++) {
      if (t <= s[i][0]) {
        const k = (t - s[i - 1][0]) / (s[i][0] - s[i - 1][0]);
        return [
          s[i - 1][1] + (s[i][1] - s[i - 1][1]) * k,
          s[i - 1][2] + (s[i][2] - s[i - 1][2]) * k,
          s[i - 1][3] + (s[i][3] - s[i - 1][3]) * k,
        ].map(x => x / 255);
      }
    }
    return [1, 0.3, 0.3];
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

  const api = {
    init, render, resize, setAutoRotate, resetView,
    updateCloud, updateSurface, setSurfaceLevel, setVisibility,
    disposeGrid, setNucleusVisible,
    initAngular, updateAngular, renderAngular, resizeAngular,
  };
  return api;
})();
