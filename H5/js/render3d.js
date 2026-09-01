/**
 * render3d.js — Three.js 三维渲染：粒子云 + 等值面（marching tetrahedra）
 *
 * 设计要点：
 *   - 使用 Three.js r147 全局构建（window.THREE），通过 <script> 引入。
 *   - 化学约定：z 轴为量化轴（竖直），通过 camera.up=(0,0,1) 让屏幕上方向 = 世界 z。
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

  let scene = null, camera = null, renderer = null, controls = null;
  let cloudObj = null;          // THREE.Points
  let surfaceObj = null;        // THREE.Mesh
  let nucleusObj = null;
  let axesObj = null;
  let gridObj = null;

  // 角度分布 3D 曲面（独立小场景）：r(θ,φ) 从原点沿 (θ,φ) 引射线
  let angScene = null, angCamera = null, angRenderer = null, angControls = null, angMesh = null, angAxes = null;
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
    camera.up.set(0, 0, 1);                       // 量化轴 z 朝上
    camera.position.set(0, -4, 3);

    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(width, height);
    container.appendChild(renderer.domElement);

    controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.screenSpacePanning = true;
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.9;

    // 灯光（供表面使用）
    const ambient = new THREE.AmbientLight(0xffffff, 0.55);
    const dir = new THREE.DirectionalLight(0xffffff, 1.0);
    dir.position.set(3, -2, 5);
    const dir2 = new THREE.DirectionalLight(0x88aaff, 0.35);
    dir2.position.set(-4, 3, -2);
    scene.add(ambient, dir, dir2);

    buildAxes();
    buildGrid();

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
   * res 为每轴网格点数（立方）。返回 { maxVal }。
   */
  function computeField(n, l, m, mode, res) {
    const extent = OM.rExtent(n, l) * 1.15;
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
    const pushTri = (pts) => {
      if (!pts || pts.length < 3) return;
      for (const pt of pts) {
        positions.push(pt.p[0], pt.p[1], pt.p[2]);
        normals.push(pt.n[0], pt.n[1], pt.n[2]);
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

    // 构建几何（法线来自梯度，无需 computeVertexNormals，绕序不影响明暗）
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geo.setIndex(indices);
    geo.computeBoundingSphere();
    return geo;
  }

  function setSurfaceLevel(fraction) {
    surfaceLevelFraction = fraction;
    if (!field) return;
    rebuildSurface();
  }

  function buildSurface(levelFraction) {
    if (!field) return;
    surfaceLevelFraction = levelFraction;
    rebuildSurface();
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
    if (nv > 800 && nv < 300000) smoothVertices(welded.positions, welded.indices, 4);

    const geo2 = new THREE.BufferGeometry();
    geo2.setAttribute('position', new THREE.BufferAttribute(welded.positions, 3));
    geo2.setAttribute('normal', new THREE.BufferAttribute(welded.normals, 3));
    geo2.setIndex(new THREE.BufferAttribute(welded.indices, 1));
    geo2.computeBoundingSphere();

    const baseColor = OM.lColor(currentL || 0);
    const color = new THREE.Color(baseColor[0], baseColor[1], baseColor[2]);
    // 不透明实体 + 中等粗糙度 + 梯度法线（朝外）→ 平滑实心
    const mat = new THREE.MeshStandardMaterial({
      color: color,
      roughness: 0.5,
      metalness: 0.0,
      side: THREE.DoubleSide,
    });
    surfaceObj = new THREE.Mesh(geo2, mat);
    scene.add(surfaceObj);
    fitView(gridExtent);
  }

  let currentL = 0;
  function updateSurface(n, l, m, mode, res, levelFraction) {
    currentL = l;
    computeField(n, l, m, mode, res);
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

  // 相机取景：保持当前朝向，按轨道尺度调整距离
  function fitView(extent) {
    if (!camera || !controls) return;
    const dir = camera.position.clone().sub(controls.target);
    if (dir.lengthSq() < 1e-8) dir.set(0, -1, 0.5);
    dir.normalize();
    const dist = Math.max(extent * 2.8, 3);
    camera.position.copy(controls.target).add(dir.multiplyScalar(dist));
    camera.near = extent * 0.02;
    camera.far = extent * 60;
    camera.updateProjectionMatrix();
    controls.minDistance = extent * 0.15;
    controls.maxDistance = extent * 40;
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
      controls.update();
      renderer.render(scene, camera);
    }
  }
  function resize(w, h) {
    if (!camera || !renderer) return;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  }
  function setAutoRotate(v) { if (controls) controls.autoRotate = !!v; }
  function resetView() {
    camera.up.set(0, 0, 1);
    camera.position.set(0, -4, 3);
    controls.target.set(0, 0, 0);
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
    angCamera.up.set(0, 0, 1);
    angCamera.position.set(0, -2.6, 2.2);
    angRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    angRenderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    angRenderer.setSize(w, h);
    container.appendChild(angRenderer.domElement);
    angControls = new THREE.OrbitControls(angCamera, angRenderer.domElement);
    angControls.enableDamping = true;
    angControls.dampingFactor = 0.08;
    angControls.enablePan = false;
    angControls.autoRotate = true;
    angControls.autoRotateSpeed = 1.2;
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
      angControls.update();
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
