// tools/bake-turret-top.mjs — 把坦克 OBJ 的塔顶总成烘焙成 JSON 几何产物（确定性）
//
// **烘焙 = 数据格式转换，不产生新美术资源**：只把 OBJ 的顶点/法线转成本仓 JSON，
// 贴图复用既有 `assets/turret/armor.png`（三张源图早已入库），不新增方块/贴图。
//
// 产物：`assets/turret/turret-top.json` + `turret-top.meta.json`（指纹 + 指标）
// 用法：node tools/bake-turret-top.mjs（或 npm run turretop）
//
// ⚠️ **UV 权威在本脚本**：装甲部件的 UV 已按面压进 1/3 区，渲染层**不得再调 applyZoneUV**
// （再压一次会把 u' = z/3 + (z/3+u/3)/3 ⇒ 全部采到 front 区左侧）。
//
// ⚠️ **内容级断言不可省**：指纹只覆盖源文件与参数，改算法而不动参数时指纹不变
// ⇒ 必须用炮口 z / UV 零退化 / 逐面拆顶点 / 各区面数这些内容判据钉住。
import fs from 'node:fs';
import path from 'node:path';
import {
  TURRET_TOP_SRC, TURRET_TOP_JSON, TURRET_TOP_META,
  TURRET_TOP_PARAMS, TURRET_TOP_ARMOR, TURRET_TOP_SOLID, TURRET_TOP_METRICS,
  parseObj, splitParts, buildPartGeometry, zoneOf, turretTopInputFingerprint,
} from './turret-top-fingerprint.mjs';
import { TURRET_GUN_COLOR, TURRET_TOP_SCALE, TURRET_TOP_PIVOT_Y } from '../src/entities/turrets/turret-config.js';

/**
 * 纯色部件色值 —— **从 config 取，不在本脚本写字面量**（红线 1）。
 * 门禁会断言产物色值 ≡ config，两处漂移即红。
 */
const SOLID_COLORS = {
  barrel: TURRET_GUN_COLOR.BARREL,
  podR: TURRET_GUN_COLOR.POD,
  podL: TURRET_GUN_COLOR.POD,
};

function fail(msg) { throw new Error(`[turret-top] ${msg}`); }

// 定标常量两侧同源（config 是运行期权威，烘焙参数是离线权威，不得漂移）
if (Math.abs(TURRET_TOP_PARAMS.scale - TURRET_TOP_SCALE) > 1e-12) fail('scale 与 config 漂移');
if (Math.abs(TURRET_TOP_PARAMS.pivotY - TURRET_TOP_PIVOT_Y) > 1e-12) fail('pivotY 与 config 漂移');

/** 三角的 UV 面积（退化判据） */
function uvTriArea(g, i) {
  const a = g.index[i], b = g.index[i + 1], c = g.index[i + 2];
  const u = (j) => [g.uv[j * 2], g.uv[j * 2 + 1]];
  const A = u(a), B = u(b), C = u(c);
  return Math.abs((B[0] - A[0]) * (C[1] - A[1]) - (C[0] - A[0]) * (B[1] - A[1])) / 2;
}

function main() {
  const parsed = parseObj(fs.readFileSync(TURRET_TOP_SRC, 'utf8'));
  const parts = splitParts(parsed);

  // ---- 源模型契约 ----
  if (parsed.positions.length !== TURRET_TOP_METRICS.sourcePositions) fail(`v 行数 ${parsed.positions.length}`);
  if (parsed.normals.length !== TURRET_TOP_METRICS.sourceNormals) fail(`vn 行数 ${parsed.normals.length}`);
  if (parsed.uvs.length !== TURRET_TOP_METRICS.sourceUvs) fail(`vt 行数 ${parsed.uvs.length}`);
  const totalFaces = Object.values(parts).reduce((a, f) => a + f.length, 0);
  if (totalFaces !== TURRET_TOP_METRICS.sourceFaces) fail(`全模型面数 ${totalFaces}`);
  if (parts.hull.length !== TURRET_TOP_METRICS.hullFaces) fail(`hull 面数 ${parts.hull.length}`);

  // ---- 逐部件构造（**丢弃 hull**）----
  const keys = [...TURRET_TOP_ARMOR, ...TURRET_TOP_SOLID];
  const out = {};
  let tris = 0, verts = 0;
  for (const key of keys) {
    const g = buildPartGeometry(parts[key], key, TURRET_TOP_PARAMS);
    const nTri = g.index.length / 3, nVert = g.position.length / 3;
    if (nTri !== TURRET_TOP_METRICS.triangles[key]) fail(`${key} 三角数 ${nTri} ≠ ${TURRET_TOP_METRICS.triangles[key]}`);
    if (nVert !== TURRET_TOP_METRICS.vertices[key]) fail(`${key} 顶点数 ${nVert} ≠ ${TURRET_TOP_METRICS.vertices[key]}`);
    const entry = {
      position: g.position, normal: g.normal, uv: g.uv, index: g.index,
      zone: null,                       // 逐面跨区 ⇒ 部件级无单一 zone，UV 已是最终值
      textured: TURRET_TOP_ARMOR.includes(key),
    };
    if (!entry.textured) entry.color = SOLID_COLORS[key];
    out[key] = entry;
    tris += nTri; verts += nVert;
  }

  // ---- 内容级断言（指纹拓不到的部分）----
  // ① 炮口 z 对齐 muzzleOffsetZ ⇒ 弹道零改动
  const muzzleZ = Math.max(...out.barrel.position.filter((_, i) => i % 3 === 2));
  if (Math.abs(muzzleZ - TURRET_TOP_METRICS.muzzleZ) > 1e-6) fail(`炮口 z ${muzzleZ} ≠ 3.5`);
  // ② 装甲部件 UV 零退化（OBJ 原始 UV 有 89% 退化）
  let degenerate = 0;
  for (const key of TURRET_TOP_ARMOR) {
    const g = out[key];
    for (let i = 0; i < g.index.length; i += 3) if (uvTriArea(g, i) <= 1e-6) degenerate++;
  }
  if (degenerate !== 0) fail(`装甲部件有 ${degenerate} 个退化 UV 三角`);
  // ③ 装甲部件逐面拆顶点（封口会追加顶点 ⇒ 断言「不少于角数」；全焊接会少于角数）
  for (const key of TURRET_TOP_ARMOR) {
    const corners = parts[key].reduce((a, f) => a + f.p.length, 0);
    if (out[key].position.length / 3 < corners) fail(`${key} 未逐面拆顶点`);
  }
  // ③b **装甲部件必须闭合**（切口封口）—— 用户实玩缺陷的内容级判据。
  //     开放壳在 FrontSide/DoubleSide 下都会从切口看穿，而顶点数/UV/法线全对。
  for (const key of TURRET_TOP_ARMOR) {
    const g = out[key];
    const wIdx = new Map();
    const idOf = (vi) => {
      const k2 = [0, 1, 2].map((q) => g.position[vi * 3 + q].toFixed(4)).join(',');
      if (!wIdx.has(k2)) wIdx.set(k2, wIdx.size);
      return wIdx.get(k2);
    };
    const edges = new Map();
    for (let i = 0; i < g.index.length; i += 3) {
      const ids = [g.index[i], g.index[i + 1], g.index[i + 2]].map(idOf);
      for (let e = 0; e < 3; e++) {
        const a = ids[e], b = ids[(e + 1) % 3];
        const ek = Math.min(a, b) + '_' + Math.max(a, b);
        edges.set(ek, (edges.get(ek) || 0) + 1);
      }
    }
    let open = 0;
    for (const c of edges.values()) if (c === 1) open++;
    if (open !== 0) fail(`${key} 有 ${open} 条开放边（切口未封口 ⇒ 渲染看穿）`);
  }
  // ④ 各区面数（不经过 zoneOf 自身的独立冻结表）
  for (const key of TURRET_TOP_ARMOR) {
    const got = { front: 0, side: 0, top: 0 };
    for (const face of parts[key]) got[zoneOf(face.p)]++;
    const want = TURRET_TOP_METRICS.zoneFaces[key];
    for (const z of ['front', 'side', 'top']) {
      if (got[z] !== want[z]) fail(`${key}.${z} 面数 ${got[z]} ≠ ${want[z]}`);
    }
  }
  // ⑤ 划分恒等式：产物面数 = 全模型 − hull（漏排 hull 会多出 519）
  const productFaces = keys.reduce((a, k) => a + parts[k].length, 0);
  if (productFaces !== totalFaces - parts.hull.length) fail('产物面数 ≠ 全模型 − hull');
  if (productFaces !== TURRET_TOP_METRICS.productFaces) fail(`产物面数 ${productFaces}`);
  // ⑤b 炮管尾端埋入鼻段（防尾部前移造成真实缝隙）
  {
    let noseFront = -Infinity, barrelTail = Infinity;
    const np = out.nose.position, bp2 = out.barrel.position;
    for (let i = 2; i < np.length; i += 3) noseFront = Math.max(noseFront, np[i]);
    for (let i = 2; i < bp2.length; i += 3) barrelTail = Math.min(barrelTail, bp2[i]);
    const embed = noseFront - barrelTail;
    if (!(embed > TURRET_TOP_METRICS.minBarrelEmbed)) {
      fail(`炮管尾端埋入鼻段 ${embed.toFixed(4)} 格 ≤ ${TURRET_TOP_METRICS.minBarrelEmbed}`);
    }
  }
  // ⑥ UV 值域
  for (const [key, g] of Object.entries(out)) {
    for (const u of g.uv) if (u < -1e-6 || u > 1 + 1e-6) fail(`${key} UV 越界：${u}`);
  }
  if (tris !== TURRET_TOP_METRICS.triangleCount) fail(`总三角数 ${tris}`);
  if (verts !== TURRET_TOP_METRICS.vertexCount) fail(`总顶点数 ${verts}`);

  // ---- 落盘 ----
  const json = { scale: TURRET_TOP_PARAMS.scale, pivotY: TURRET_TOP_PARAMS.pivotY, parts: out };
  fs.mkdirSync(path.dirname(TURRET_TOP_JSON), { recursive: true });
  fs.writeFileSync(TURRET_TOP_JSON, JSON.stringify(json));
  fs.writeFileSync(TURRET_TOP_META, JSON.stringify({
    fingerprints: { input: turretTopInputFingerprint() },
    metrics: {
      productFaces, triangleCount: tris, vertexCount: verts,
      muzzleZ, degenerateUvTriangles: degenerate,
      barrelEmbed: (() => {
        let nf = -Infinity, bt = Infinity;
        for (let i = 2; i < out.nose.position.length; i += 3) nf = Math.max(nf, out.nose.position[i]);
        for (let i = 2; i < out.barrel.position.length; i += 3) bt = Math.min(bt, out.barrel.position[i]);
        return nf - bt;
      })(),
      triangles: TURRET_TOP_METRICS.triangles,
      vertices: TURRET_TOP_METRICS.vertices,
      zoneFaces: TURRET_TOP_METRICS.zoneFaces,
    },
  }, null, 2));
  console.log(`[turret-top] 烘焙完成 ${keys.length} 部件 / ${tris} 三角 / ${verts} 顶点`
    + `（炮口 z=${muzzleZ.toFixed(6)}，UV 零退化，逐面拆顶点）`);
}

main();
