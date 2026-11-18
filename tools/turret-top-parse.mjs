// tools/turret-top-parse.mjs — 炮塔塔顶 OBJ 的解析与部件切分（**纯函数，无 node: 依赖**）
//
// 为什么独立成文件：烘焙脚本与数据契约门要读文件（`node:fs`），而浏览器内单测要跑同一份
// 算法。把纯函数放这里、指纹模块（`turret-top-fingerprint.mjs`）从它 re-export，
// 两侧就共用同一份逻辑（红线 1）。手法照 `tools/molang-eval.mjs` ——
// `src/tests/test-molang.js:16` 已证实浏览器单测可以 import `tools/` 下的纯函数模块。
//
// ⚠️ **本文件不得 import `node:` 协议模块**：浏览器无法解析 → 整个模块不加载 →
// 测试页白屏，而 `check:arch` 抓不到这类运行时解析失败。
//
// 素材：`assets/turret/src/TankCannon.obj`（整辆坦克，2128 面 / 2192 顶点）。
// 设计：docs/superpowers/specs/2026-11-18-turret-top-model-replacement-design.md §2.2

/**
 * 解析 Wavefront OBJ 的 `v` / `vn` / `vt` / `g` / `f` 五种行。
 *
 * `f` 的每个 token 形如 `vi/vti/vni`（也可能是 `vi//vni` 或 `vi`）⇒ 统一解析成三元组，
 * **空段记 0**、**1-indexed 原样保留**（deref 留给 splitParts，便于负向验证时核对索引）。
 *
 * ⚠️ **本素材的 `vt` 是三分量**（`u v w`，w 恒 0，实测 1194 行全部如此）。
 * `uvs` **只取前两个分量** —— 带着 w 会让下游 `uv[0].length === 2` 的契约失败，
 * 且 `BufferAttribute(uv, 2)` 会按 stride 2 读三元组数组 ⇒ UV 整体错位。
 * （`v` / `vn` 实测均为三分量，原样保留。）
 *
 * @param {string} text
 * @returns {{positions: number[][], normals: number[][], uvs: number[][],
 *            groups: Record<string, number[][][]>}}
 */
export function parseObj(text) {
  const positions = [];
  const normals = [];
  const uvs = [];
  /** @type {Record<string, number[][][]>} */
  const groups = {};
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('v ')) {
      positions.push(line.slice(2).trim().split(/\s+/).map(Number));
    } else if (line.startsWith('vn ')) {
      normals.push(line.slice(3).trim().split(/\s+/).map(Number));
    } else if (line.startsWith('vt ')) {
      const c = line.slice(3).trim().split(/\s+/).map(Number);
      uvs.push([c[0], c[1]]);   // 丢掉第三分量 w（本素材恒 0）
    } else if (line.startsWith('g ')) {
      current = line.slice(2).trim();
      if (!groups[current]) groups[current] = [];
    } else if (line.startsWith('f ')) {
      if (current === null) continue;
      const face = line.slice(2).trim().split(/\s+/).map((token) => {
        const parts = token.split('/');
        return [Number(parts[0]) || 0, Number(parts[1]) || 0, Number(parts[2]) || 0];
      });
      groups[current].push(face);
    }
  }
  return { positions, normals, uvs, groups };
}

/**
 * 面归属哪个语义部件。
 *
 * ⚠️⚠️ **判定顺序是载荷性的**：先判组名（炮管/副武器是独立 g 组），再判 y 窗口
 * （塔身 y≥30 / 车体 y≤28.2），最后兜底 ring（转台环带 y 25.7~30）。
 * 调换顺序会让 ring 被车体窗口吞掉 —— 实测把 `ymax <= 28.2` 放宽到 `<= 30.05`
 * 会让 ring 面数 123 → 0，而总面数不变（静默失效）。
 *
 * ⚠️ 阈值 29.99 / 28.2 / 16 / 13.6 / 40.5 都是**实测标定**的切分面，不是圆整数：
 * 平台顶面恰在 y=30.00，车体最高点 y=28.19，颊舱最内侧 |x|=17.64，炮座最外 |x|=13.29，
 * 鼻段起点 z=40.85。取整会让相邻部件互相吞面。
 *
 * @param {string} groupName @param {number[][]} p 面的顶点坐标
 * @returns {'cheek'|'mantlet'|'deckMid'|'ring'|'nose'|'podR'|'podL'|'barrel'|'hull'}
 */
export function partOf(groupName, p) {
  let ymin = Infinity, ymax = -Infinity, xmax = 0, zmin = Infinity;
  for (const q of p) {
    if (q[1] < ymin) ymin = q[1];
    if (q[1] > ymax) ymax = q[1];
    const ax = Math.abs(q[0]);
    if (ax > xmax) xmax = ax;
    if (q[2] < zmin) zmin = q[2];
  }
  if (groupName === 'TankCannon') return 'barrel';
  if (groupName === 'Secondary1') return 'podR';
  if (groupName === 'Secondary2') return 'podL';
  if (ymin >= 29.99) return xmax >= 16 ? 'cheek' : (xmax <= 13.6 ? 'mantlet' : 'deckMid');
  if (ymax <= 28.2) return zmin >= 40.5 ? 'nose' : 'hull';
  return 'ring';
}

/**
 * 把解析结果切成九个语义部件，每面 deref 成实际坐标。
 *
 * @param {ReturnType<typeof parseObj>} parsed
 * @returns {Record<string, Array<{p: number[][], n: number[][], uv: number[][]}>>}
 */
export function splitParts(parsed) {
  const { positions, normals, uvs, groups } = parsed;
  /** @type {Record<string, Array<{p: number[][], n: number[][], uv: number[][]}>>} */
  const parts = {};
  for (const [groupName, faces] of Object.entries(groups)) {
    for (const face of faces) {
      const p = face.map((t) => positions[t[0] - 1]);
      const key = partOf(groupName, p);
      if (!parts[key]) parts[key] = [];
      parts[key].push({
        p,
        n: face.map((t) => normals[t[2] - 1]),
        uv: face.map((t) => uvs[t[1] - 1]),
      });
    }
  }
  return parts;
}
// --------------------------------------------------------------------------
// 定标 / 分区 / 几何构造（Task 2）
// --------------------------------------------------------------------------

/**
 * 烘焙参数（唯一权威，烘焙脚本与门禁与单测三方共用）。
 *
 * ⚠️ **`scale` 的判据是炮口对齐 `TURRET.muzzleOffsetZ`（3.5 格）**，不是「塔身宽度好看」：
 * 模型炮口在 z=**113.3627**（实测精确值，不是四舍五入的 113.36），取 k=3.5/113.3627
 * 后炮口世界 z 恰好 3.5 ⇒ `controller.muzzle()` 与弹道**零改动**。
 * ⚠️ 用 113.36 作分母会让炮口落在 **3.5000834**（越出 1e-6 容差）—— 实测踩过。
 *
 * ⚠️ **`pivotY` 取炮管轴心 14.667**（不是模型原点 y=0，也不是塔身底面 y=30）：
 * 炮管绕自身轴俯仰才符合「炮管与炮头刚性一体」的观感。
 *
 * ⚠️ **`zoneNyThreshold = 0.85` 是实测选的**：扫描 0.70/0.80/0.85/0.90/0.95 五档，
 * 0.85 让颊舱两个大斜面（几何 ny=0.967，面积各 1036）归 top、四个大侧壁（ny=0.273，
 * 面积 814/763）归 side。取 0.90 会把 deckMid 的 37% 面积错划到 side。
 */
export const TURRET_TOP_PARAMS = Object.freeze({
  scale: 3.5 / 113.3627,
  pivotY: 14.667,
  zoneNyThreshold: 0.85,
  zones: Object.freeze(['front', 'side', 'top']),
});

/** 走三区贴图的装甲部件（顺序即产物键序的一部分，与 config 的 textured 集合须一致） */
export const TURRET_TOP_ARMOR = Object.freeze(['cheek', 'mantlet', 'deckMid', 'ring', 'nose']);
/** 走纯色的部件（炮管 + 两组副武器；用户明确允许炮管是灰色而非黑色） */
export const TURRET_TOP_SOLID = Object.freeze(['barrel', 'podR', 'podL']);

/**
 * 面的**几何法线**（Newell 法，对非平面四边形也稳）与面积。
 *
 * ⚠️ **着色分类必须用几何法线，不能用 OBJ 提供的 `vn`**：`vn` 是平滑法线，
 * 颊舱顶面四角法线各不相同、平均后 ny≈0.995，而几何法线 ny≈0.967 —— 用 vn 分类
 * 会把大侧壁（vn 平均 ny≈0.27 但逐角差异大）划错区。光照仍用原始 vn（保留倒角高光）。
 *
 * @param {number[][]} p @returns {{n: number[], area: number}}
 */
export function geomNormal(p) {
  let nx = 0, ny = 0, nz = 0;
  for (let i = 1; i < p.length - 1; i++) {
    const a = p[0], b = p[i], c = p[i + 1];
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    nx += e1[1] * e2[2] - e1[2] * e2[1];
    ny += e1[2] * e2[0] - e1[0] * e2[2];
    nz += e1[0] * e2[1] - e1[1] * e2[0];
  }
  const len = Math.hypot(nx, ny, nz) || 1;
  return { n: [nx / len, ny / len, nz / len], area: len / 2 };
}

/**
 * 面归属哪个贴图区（按几何法线主轴）。
 *
 * 底面（ny < −阈值）也归 `top` —— 照 mc-lite「BACK 也用 pic3」的同口径：
 * 背面/底面没有专属贴图，复用顶面那张斑驳蓝灰。
 *
 * @param {number[][]} p @param {number} [threshold]
 * @returns {'front'|'side'|'top'}
 */
export function zoneOf(p, threshold = TURRET_TOP_PARAMS.zoneNyThreshold) {
  const { n } = geomNormal(p);
  if (n[1] > threshold || n[1] < -threshold) return 'top';
  return Math.abs(n[0]) >= Math.abs(n[2]) ? 'side' : 'front';
}

/**
 * 把一个部件的面集构造成索引化几何（世界坐标，格）。
 *
 * **装甲部件逐面拆顶点**：同一顶点被不同朝向的面共用时 UV 只能有一个值，
 * 实测原始数据有 26/1974 个顶点跨区 ⇒ 全焊接会让它们采到错误区。
 *
 * **纯色部件按坐标焊接**：UV 恒 0，不存在跨区问题。
 * ⚠️ 焊接键用**世界化前的模型坐标 + 法线，`toFixed(4)`**。实测 toFixed(3)/(4)/(6)
 * 三档同结果（barrel 1332 / podR 960 / podL 480）⇒ 冻结数字无容差歧义。
 * ⚠️ **不得改用 OBJ 索引对 `(vi,vni)`**：导出器有 8 组「同坐标同法线但不同 vn 索引」
 * 的冗余，那样 barrel 会得 1340 而非 1332。
 *
 * @param {Array<{p:number[][], n:number[][], uv:number[][]}>} faces
 * @param {string} key @param {typeof TURRET_TOP_PARAMS} params
 * @returns {{position:number[], normal:number[], uv:number[], index:number[]}}
 */
export function buildPartGeometry(faces, key, params = TURRET_TOP_PARAMS) {
  const k = params.scale, py = params.pivotY;
  const position = [], normal = [], uv = [], index = [];
  const textured = TURRET_TOP_ARMOR.includes(key);
  /** 纯色部件的焊接表：模型坐标+法线 → 顶点下标 */
  const weld = new Map();

  /** 追加一个顶点（世界化坐标 + 原样法线 + 给定 UV），返回下标 */
  const pushVertex = (q, n, u, v) => {
    const vi = position.length / 3;
    position.push(q[0] * k, (q[1] - py) * k, q[2] * k);
    normal.push(n[0], n[1], n[2]);
    uv.push(u, v);
    return vi;
  };

  for (const face of faces) {
    const { n: gn } = geomNormal(face.p);
    // UV 投影：丢弃几何法线的主轴，另两轴在**该面自身 bbox** 内归一化
    let axis = 0;
    for (let j = 1; j < 3; j++) if (Math.abs(gn[j]) > Math.abs(gn[axis])) axis = j;
    const [ua, va] = [0, 1, 2].filter((j) => j !== axis);
    let umin = Infinity, umax = -Infinity, vmin = Infinity, vmax = -Infinity;
    let zoneIndex = 0;
    if (textured) {
      zoneIndex = params.zones.indexOf(zoneOf(face.p));
      for (const q of face.p) {
        if (q[ua] < umin) umin = q[ua];
        if (q[ua] > umax) umax = q[ua];
        if (q[va] < vmin) vmin = q[va];
        if (q[va] > vmax) vmax = q[va];
      }
    }
    const base = [];
    for (let i = 0; i < face.p.length; i++) {
      const q = face.p[i], n = face.n[i];
      if (textured) {
        const u = (q[ua] - umin) / (umax - umin || 1);
        const v = (q[va] - vmin) / (vmax - vmin || 1);
        // 只改 u 压进对应区，不碰 v（沿用现有 applyZoneUV 的口径）
        base.push(pushVertex(q, n,
          zoneIndex / params.zones.length + u / params.zones.length, v));
      } else {
        const wkey = `${q[0].toFixed(4)},${q[1].toFixed(4)},${q[2].toFixed(4)}|`
          + `${n[0].toFixed(4)},${n[1].toFixed(4)},${n[2].toFixed(4)}`;
        let vi = weld.get(wkey);
        if (vi === undefined) {
          vi = pushVertex(q, n, 0, 0);
          weld.set(wkey, vi);
        }
        base.push(vi);
      }
    }
    for (let i = 1; i < base.length - 1; i++) index.push(base[0], base[i], base[i + 1]);
  }
  return { position, normal, uv, index };
}
