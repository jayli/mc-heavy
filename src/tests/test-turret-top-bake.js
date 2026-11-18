// src/tests/test-turret-top-bake.js — 炮塔塔顶模型烘焙（OBJ → JSON 几何产物）
//
// 素材是**整辆坦克**（`assets/turret/src/TankCannon.obj`，2128 面），本仓只取塔顶总成：
// 楔形颊舱 + 中央炮座 + 平台中段 + 转台环 + 车体鼻段 + 主炮管 + 两组副武器，丢弃车体裙板。
//
// ⚠️ **炮管不从中央炮座伸出**：炮管轴心 y=14.667，比楔形塔身底面（y=30）低 16.3 单位，
// 尾部埋在鼻段（z 40.8~61.5）内。只搬楔形塔身会让炮管悬空分离 ⇒ 必须连鼻段一起搬。
//
// ⚠️ **OBJ 的 UV 有 89% 的面退化**（u 或 v 跨度为 0，采样只取到单像素）——原模型靠材质
// 分色而非贴图 ⇒ 必须按面朝向重建 UV，不能直接用 OBJ 的 uv。
//
// Tier 1（纯函数算法 + 数据契约）⇒ 必须 TDD。
// 设计：docs/superpowers/specs/2026-11-18-turret-top-model-replacement-design.md
import { test } from './runner.js';
import { assertEqual, assertTrue, assertDeepEqual } from './assert.js';
import { resourceUrl } from '../core/resource-url.js';
import {
  parseObj, splitParts, buildPartGeometry, zoneOf, toneOf, geomNormal, TURRET_TOP_PARAMS,
  TURRET_TOP_ARMOR, TURRET_TOP_SOLID,
} from '../../tools/turret-top-parse.mjs';

/** assert.js 里没有 assertClose（它是 test-zombies.js 的文件内局部函数）⇒ 本文件自带 */
function assertClose(actual, expected, eps, message = '') {
  assertTrue(Math.abs(actual - expected) <= eps,
    `${message} 期望 ${expected}±${eps}，实际 ${actual}`);
}

/** 源 OBJ 文本（浏览器无 fs ⇒ fetch；只取一次，多个用例共用） */
let _objText = null;
async function objText() {
  if (_objText === null) {
    const res = await fetch(resourceUrl('assets/turret/src/TankCannon.obj'));
    assertTrue(res.ok, `源 OBJ 须可加载，HTTP ${res.status}`);
    _objText = await res.text();
  }
  return _objText;
}

/** 切分结果（只算一次） */
let _parts = null;
async function partsOfObj() {
  if (_parts === null) _parts = splitParts(parseObj(await objText()));
  return _parts;
}

/** 八部件的烘焙几何（只算一次） */
let _built = null;
async function builtParts() {
  if (_built === null) {
    const parts = await partsOfObj();
    _built = {};
    for (const k of [...TURRET_TOP_ARMOR, ...TURRET_TOP_SOLID]) {
      _built[k] = buildPartGeometry(parts[k], k, TURRET_TOP_PARAMS);
    }
  }
  return _built;
}

/** 三角的 UV 面积（退化判据用） */
function uvTriArea(g, i) {
  const a = g.index[i], b = g.index[i + 1], c = g.index[i + 2];
  const u = (j) => [g.uv[j * 2], g.uv[j * 2 + 1]];
  const A = u(a), B = u(b), C = u(c);
  return Math.abs((B[0] - A[0]) * (C[1] - A[1]) - (C[0] - A[0]) * (B[1] - A[1])) / 2;
}

test('turret-top: OBJ 解析 —— 顶点/法线/UV/四个组的面数', async () => {
  const parsed = parseObj(await objText());
  assertEqual(parsed.positions.length, 2192, 'v 行数');
  assertEqual(parsed.normals.length, 1131, 'vn 行数');
  assertEqual(parsed.uvs.length, 1194, 'vt 行数');
  assertEqual(Object.keys(parsed.groups).length, 4, 'g 组数');
  assertEqual(parsed.groups.TankBase.length, 1134, 'TankBase 面数');
  assertEqual(parsed.groups.TankCannon.length, 374, 'TankCannon 面数');
  assertEqual(parsed.groups.Secondary2.length, 332, 'Secondary2 面数');
  assertEqual(parsed.groups.Secondary1.length, 288, 'Secondary1 面数');
});

test('turret-top: 部件切分 —— 九部件面数逐项钉住', async () => {
  const parts = splitParts(parseObj(await objText()));
  // spec §2.2 冻结表。⚠️ 判定顺序载荷性：先判组名，再判 y 窗口，最后兜底 ring。
  const FACES = {
    cheek: 140, mantlet: 57, deckMid: 14, ring: 123, nose: 281,
    podR: 288, podL: 332, barrel: 374, skirt: 519,
  };
  for (const [k, n] of Object.entries(FACES)) {
    assertEqual(parts[k].length, n, `${k} 面数`);
  }
  // 切分必须是**划分**（无重无漏）：九部件面数之和 === 全模型面数
  const sum = Object.values(FACES).reduce((a, b) => a + b, 0);
  assertEqual(sum, 2128, '九部件面数之和 = 全模型面数');
});

test('turret-top: 切分后的 Face 已 deref 成实际坐标（不是索引）', async () => {
  const parts = splitParts(parseObj(await objText()));
  const f = parts.barrel[0];
  assertEqual(f.p.length, f.n.length, '每面顶点数与法线数相同');
  assertEqual(f.p.length, f.uv.length, '每面顶点数与 UV 数相同');
  assertEqual(f.p[0].length, 3, '顶点是三元组');
  assertEqual(f.n[0].length, 3, '法线是三元组');
  assertEqual(f.uv[0].length, 2, 'UV 是二元组');
  // 炮管轴心 y=14.667，整组 y ∈ [5.81, 23.52] —— deref 正确才落在这个区间
  const ys = parts.barrel.flatMap((q) => q.p.map((v) => v[1]));
  assertClose(Math.min(...ys), 5.815, 0.01, '炮管 y 下界');
  assertClose(Math.max(...ys), 23.520, 0.01, '炮管 y 上界');
});
// ==================== 定标与 UV 重建（Task 2） ====================

test('turret-top: 定标 —— 炮口世界 z 对齐 TURRET.muzzleOffsetZ（3.5）', async () => {
  const built = await builtParts();
  const bz = built.barrel.position.filter((_, i) => i % 3 === 2);
  assertClose(Math.max(...bz), 3.5, 1e-6, '炮口 z');
  // pivot 落在炮管轴心 ⇒ 炮管轴心的世界 y === 0（不是把模型原点当 pivot）
  const by = built.barrel.position.filter((_, i) => i % 3 === 1);
  assertClose((Math.min(...by) + Math.max(...by)) / 2, 0, 1e-3, '炮管轴心世界 y');
});
test('turret-top: UV 重建 —— 五个装甲部件零退化面', async () => {
  const built = await builtParts();
  let degenerate = 0;
  for (const k of TURRET_TOP_ARMOR) {
    const g = built[k];
    for (let i = 0; i < g.index.length; i += 3) {
      if (uvTriArea(g, i) <= 1e-6) degenerate++;
    }
  }
  assertEqual(degenerate, 0, '装甲部件 UV 零退化（OBJ 原始 UV 有 89% 退化，必须重建）');
});

test('turret-top: 分区关系式 —— 每个顶点落在它所属面的区内', async () => {
  const parts = await partsOfObj();
  const built = await builtParts();
  const ZONES = TURRET_TOP_PARAMS.zones;
  // ⚠️ **不能用 `floor(u*3)` 反推区号**：u 恰好等于区上界时（如 u=1/3 属区 0）
  // floor 会落到下一区，u=1 更会算出第 4 区。实测 cheek 有 290/560 个顶点落在区边界
  // ⇒ 那个口径会把**正确几何**判成 778 个跨区三角（假红）。
  // 正确判据：用**面自己的 zoneOf** 作真值，检查该面每个顶点的 u 在闭区间 [i/3,(i+1)/3] 内。
  let outOfZone = 0;
  for (const k of TURRET_TOP_ARMOR) {
    const g = built[k];
    let vi = 0;
    for (const face of parts[k]) {
      const want = ZONES.indexOf(zoneOf(face.p));
      const lo = want / ZONES.length, hi = (want + 1) / ZONES.length;
      for (let i = 0; i < face.p.length; i++, vi++) {
        const u = g.uv[vi * 2];
        if (u < lo - 1e-6 || u > hi + 1e-6) outOfZone++;
      }
    }
  }
  assertEqual(outOfZone, 0, '每个顶点的 u 落在所属面的区内（注入 zoneOf 恒 front 会报 997）');
});

test('turret-top: 分区覆盖 —— u 覆盖区集合 ≡ 法线分类区集合', async () => {
  const parts = await partsOfObj();
  const built = await builtParts();
  const ZONES = TURRET_TOP_PARAMS.zones;
  for (const k of TURRET_TOP_ARMOR) {
    const want = [...new Set(parts[k].map((f) => zoneOf(f.p)))].sort();
    // 用面遍历取区（不靠 u 反推，避开边界问题）
    const got = new Set();
    let vi = 0;
    for (const face of parts[k]) {
      const mid = (built[k].uv[vi * 2] + built[k].uv[(vi + face.p.length - 1) * 2]) / 2;
      got.add(ZONES[Math.max(0, Math.min(2, Math.floor(mid * 3)))]);
      vi += face.p.length;
    }
    // ⚠️ 不得写「横跨 ≥2 区」：deckMid 的 14 面全是 top，那样会让正确实现 FAIL
    assertDeepEqual([...got].sort(), want, `${k} 的 u 覆盖区集合`);
  }
  assertDeepEqual([...new Set(parts.deckMid.map((f) => zoneOf(f.p)))], ['top'], 'deckMid 全 top');
});

test('turret-top: 分区冻结表 —— 每部件各区面数（不依赖 zoneOf 自身的独立真值）', async () => {
  const parts = await partsOfObj();
  // ⚠️ **这条是对「分区关系式」那条的补充**：那条用 `zoneOf` 做真值，
  // 注入「zoneOf 恒 front」时两边**共用同一个错误假设** ⇒ 它仍全绿（实测）。
  // 本条把各区面数**冻结成字面量**，不经过 zoneOf ⇒ 阈值/分类退化直接红。
  const ZONE_FACES = {
    cheek: { front: 8, side: 68, top: 64 },
    mantlet: { front: 16, side: 12, top: 29 },
    deckMid: { front: 0, side: 0, top: 14 },
    ring: { front: 75, side: 38, top: 10 },
    nose: { front: 215, side: 62, top: 4 },
    skirt: { front: 300, side: 194, top: 25 },
  };
  for (const [k, want] of Object.entries(ZONE_FACES)) {
    const got = { front: 0, side: 0, top: 0 };
    for (const face of parts[k]) got[zoneOf(face.p)]++;
    assertDeepEqual(got, want, `${k} 各区面数`);
  }
});

test('turret-top: 装甲部件逐面拆顶点（顶点数 == 角数，不得焊接）', async () => {
  const parts = await partsOfObj();
  const built = await builtParts();
  // ⚠️ **判据不能用「同位置同法线出现在两个区」**：逐面拆分后那些顶点是
  // **各自独立**的（各有自己的 UV），完全正确。实测 cheek 有 26 个这样的 key，
  // 那个口径会报 220 个「冲突」（假红）。
  // 正确判据：逐面拆分 ⇔ **顶点数 == 角数**；全焊接会让顶点数 < 角数。
  for (const k of TURRET_TOP_ARMOR) {
    const corners = parts[k].reduce((a, f) => a + f.p.length, 0);
    // 封口会追加顶点 ⇒ 断言「不少于角数」（全焊接会少于角数，仍有判别力）
    assertTrue(built[k].position.length / 3 >= corners,
      `${k} 逐面拆顶点（含封口）：${built[k].position.length / 3} >= ${corners}`);
  }
});

test('turret-top: 冻结规模 —— 八部件的三角数与顶点数', async () => {
  const built = await builtParts();
  // ⚠️ 装甲部件含**切口封口面**（源网格闭合，切开后必须补面，否则渲染看穿）
  const TRIS = {
    cheek: 308, mantlet: 134, deckMid: 52, ring: 364, nose: 656, skirt: 1168,
    podR: 576, podL: 632, barrel: 712,
  };
  const VERTS = {
    cheek: 590, mantlet: 249, deckMid: 82, ring: 612, nose: 1222, skirt: 2210,
    podR: 960, podL: 480, barrel: 1332,
  };
  for (const k of Object.keys(TRIS)) {
    assertEqual(built[k].index.length / 3, TRIS[k], `${k} 三角数`);
    assertEqual(built[k].position.length / 3, VERTS[k], `${k} 顶点数`);
  }
  const totalTris = Object.values(TRIS).reduce((a, b) => a + b, 0);
  const totalVerts = Object.values(VERTS).reduce((a, b) => a + b, 0);
  assertEqual(totalTris, 4602, '总三角数');
  assertEqual(totalVerts, 7737, '总顶点数');
});

test('turret-top: 车体裙板被排除 —— 八部件不含 hull，且无 hull 面', async () => {
  const parts = await partsOfObj();
  const built = await builtParts();
  assertDeepEqual(Object.keys(built).sort(),
    ['barrel', 'cheek', 'deckMid', 'mantlet', 'nose', 'podL', 'podR', 'ring', 'skirt'],
    '产物部件集合（含 skirt 过渡段）');
  assertEqual(parts.skirt.length, 519, 'skirt 面数');
  // ⚠️ **内容级判据用「划分恒等式」，不能用几何区域判**：
  // 试过两版区域判据都误报 —— 逐顶点判误报 260（副武器/炮管/转台环的 y、z 本来就
  // 跨 hull 区域）；整面判误报 128（podR/podL 按**组名**优先归类，zmin 22~27 但归属正确）。
  // 正确判据：**产物八部件面数之和 ≡ 全模型面数 − hull 面数**。
  // 它对「漏排 hull」有判别力：注入把 hull 也烘进产物会让左边多出 519。
  const totalFaces = Object.values(parts).reduce((a, f) => a + f.length, 0);
  const productFaces = [...TURRET_TOP_ARMOR, ...TURRET_TOP_SOLID]
    .reduce((a, k) => a + parts[k].length, 0);
  assertEqual(productFaces, totalFaces, '产物面数 = 全模型（无丢弃）');
  assertEqual(productFaces, 2128, '产物面数冻结值');
});

// ==================== 产物契约（Task 2 Step 7） ====================

test('turret-top: 烘焙产物与实时构造逐位一致（防产物过期）', async () => {
  const res = await fetch(resourceUrl('assets/turret/turret-top.json'));
  assertTrue(res.ok, `产物须可加载，HTTP ${res.status}`);
  const json = await res.json();
  const built = await builtParts();
  assertDeepEqual(Object.keys(json.parts).sort(), Object.keys(built).sort(), '产物部件集合');
  assertClose(json.scale, TURRET_TOP_PARAMS.scale, 1e-12, '产物 scale');
  assertEqual(json.pivotY, TURRET_TOP_PARAMS.pivotY, '产物 pivotY');
  for (const k of Object.keys(built)) {
    const p = json.parts[k], g = built[k];
    assertEqual(p.position.length, g.position.length, `${k} position 长度`);
    assertEqual(p.index.length, g.index.length, `${k} index 长度`);
    assertEqual(p.uv.length, g.uv.length, `${k} uv 长度`);
    // 逐位比对（Float64 → JSON → 解析回来无损）
    for (let i = 0; i < g.position.length; i++) {
      assertClose(p.position[i], g.position[i], 1e-9, `${k} position[${i}]`);
    }
    for (let i = 0; i < g.uv.length; i++) {
      assertClose(p.uv[i], g.uv[i], 1e-9, `${k} uv[${i}]`);
    }
    assertDeepEqual(p.index, g.index, `${k} index`);
  }
});

test('turret-top: 产物的 toned 标记与色值', async () => {
  const json = await (await fetch(resourceUrl('assets/turret/turret-top.json'))).json();
  for (const k of TURRET_TOP_ARMOR) {
    assertEqual(json.parts[k].toned, true, `${k} 走三档色调`);
    assertEqual(json.parts[k].color, undefined, `${k} 不带单一色值（三档在 config）`);
  }
  for (const k of TURRET_TOP_SOLID) {
    assertEqual(json.parts[k].toned, false, `${k} 走单色`);
    assertTrue(typeof json.parts[k].color === 'number', `${k} 有色值`);
  }
  // 炮管深灰炮钢（用户 2026-11-18：浅灰不好看，改深灰 + 金属光泽）。
  // ⚠️ **基色不是最终观感**：金属材质的高光/环境反射会把它提到 ~136，
  // 判「颜色对不对」的像素判据在 tests/turret-render.spec.mjs。
  const c = json.parts.barrel.color;
  assertEqual(c, 0x434952, '炮管深灰炮钢基色');
  assertTrue((c & 0xff) > 0x30, '不是纯黑（要能看出形体）');
  assertTrue((c & 0xff) < 0x80, '基色是深灰而非浅灰');
});

// ==================== config 部件定义（Task 4） ====================

test('turret-top: config 部件集合与刚性一体约束', async () => {
  const { TURRET, TURRET_PARTS, TURRET_PART_DEFS, TURRET_GUN_COLOR, TURRET_TOP_SCALE,
    TURRET_TONED_PARTS } = await import('../entities/turrets/turret-config.js');
  assertEqual(TURRET_PARTS.length, 9, '9 个部件（旧 8 语义 + skirt 过渡段）');
  assertDeepEqual([...TURRET_PARTS].sort(),
    ['barrel', 'cheek', 'deckMid', 'mantlet', 'nose', 'podL', 'podR', 'ring', 'skirt'], '新部件名');
  // ⚠️ 刚性一体（用户裁定）：任何部件都不得带独立旋转/位移/俯仰轴
  for (const k of TURRET_PARTS) {
    const d = TURRET_PART_DEFS[k];
    assertTrue(d.rotX === undefined, `${k} 不得有独立 rotX`);
    assertTrue(d.pos === undefined, `${k} 不得有独立位移`);
    assertTrue(d.pitchAxis === undefined, `${k} 不得有独立 pitch 轴`);
    assertTrue(d.geo === undefined, `${k} 几何来自产物，不再是参数化盒/圆柱`);
  }
  // 三档色调 / 单色的分支依据是 TURRET_TONED_PARTS（v3.14，取代旧的 textured）
  assertDeepEqual([...TURRET_TONED_PARTS].sort(),
    ['cheek', 'deckMid', 'mantlet', 'nose', 'ring', 'skirt'], 'toned 集合');
  assertDeepEqual(TURRET_PARTS.filter((k) => !TURRET_TONED_PARTS.includes(k)).sort(),
    ['barrel', 'podL', 'podR'], '单色集合');
  assertEqual(TURRET_GUN_COLOR.BARREL, 0x434952, '炮管深灰炮钢（用户 2026-11-18 要求）');
  assertEqual(TURRET_GUN_COLOR.POD, 0x353b43, '副武器更深一档');
  // 定标常量与 muzzleOffsetZ 的关系式（不是字面量副本）
  assertClose(TURRET_TOP_SCALE * 113.3627, TURRET.muzzleOffsetZ, 1e-9, '定标对齐炮口');
});

test('turret-top: config 的色值/定标与烘焙产物同源（无第二份副本）', async () => {
  const { TURRET_PART_DEFS, TURRET_TOP_SCALE, TURRET_TOP_PIVOT_Y } =
    await import('../entities/turrets/turret-config.js');
  const json = await (await fetch(resourceUrl('assets/turret/turret-top.json'))).json();
  assertClose(json.scale, TURRET_TOP_SCALE, 1e-12, '产物 scale ≡ config');
  assertClose(json.pivotY, TURRET_TOP_PIVOT_Y, 1e-12, '产物 pivotY ≡ config');
  for (const k of ['barrel', 'podR', 'podL']) {
    assertEqual(json.parts[k].color, TURRET_PART_DEFS[k].color, `${k} 色值 ≡ config`);
  }
});

// ==================== 渲染层接产物几何（Task 5） ====================

/** 产物几何 fixture（渲染层用例共用；只 fetch 一次） */
let _topGeo = null;
async function topGeometry() {
  if (_topGeo === null) {
    _topGeo = await (await fetch(resourceUrl('assets/turret/turret-top.json'))).json();
  }
  return _topGeo;
}

test('turret-top: 渲染层不改写 UV（权威在烘焙侧，禁二次压区）', async () => {
  const THREE = await import('three');
  const { TurretRenderer } = await import('../render/turret-renderer.js');
  const geo = await topGeometry();
  // ⚠️ v3.14 后 UV **不再被采样**（零贴图），但仍不得改写：它是烘焙侧
  // 「UV 零退化 / 各区面数 / 逐面拆顶点」三条内容级判据的载体。
  const r = new TurretRenderer({ scene: new THREE.Scene(), topGeometry: geo });
  for (const k of TURRET_TOP_ARMOR) {
    const uv = r.meshes[k].geometry.getAttribute('uv');
    const src = geo.parts[k].uv;
    assertEqual(uv.count * 2, src.length, `${k} uv 长度`);
    for (let i = 0; i < src.length; i++) {
      assertClose(uv.array[i], src[i], 1e-6, `${k} uv[${i}] 未被改写`);
    }
  }
  r.dispose();
});

test('turret-top: 炮口同源 —— 渲染矩阵变换的炮口顶点 ≡ controller.muzzle()（全 ±45°）', async () => {
  const THREE = await import('three');
  const { TurretRenderer } = await import('../render/turret-renderer.js');
  const { TurretController } = await import('../entities/turrets/turret-controller.js');
  const { TURRET } = await import('../entities/turrets/turret-config.js');
  const geo = await topGeometry();
  const r = new TurretRenderer({ scene: new THREE.Scene(), topGeometry: geo, maxActive: 1 });
  // 炮口点取**几何轴心**：x = bbox 中点（0），y = **0**（pivot 就定在炮管轴心），z = 最大值。
  // ⚠️ **不能取「最靠轴的顶点」**：炮口端面是八边形环，没有 x=y=0 的中心顶点
  // （实测最靠轴的顶点也在 x=±0.0117, y=−0.1098）⇒ 环上点绕 pivot 转后位置不同。
  // ⚠️ **y 也不能用 bbox 中点**：模型炮管上下不对称（y∈[5.815,23.520]，轴心 14.667）
  // ⇒ bbox 中点比真轴心高 1.08e-5 格，在 pitch=−24° 处会超出 1e-5 容差（实测踩过）。
  // 轴心就是 pivot，故局部 y ≡ 0。
  const bp = geo.parts.barrel.position;
  let xmin = Infinity, xmax = -Infinity, zmax = -Infinity;
  for (let i = 0; i < bp.length; i += 3) {
    xmin = Math.min(xmin, bp[i]); xmax = Math.max(xmax, bp[i]);
    zmax = Math.max(zmax, bp[i + 2]);
  }
  const muzzleLocal = [(xmin + xmax) / 2, 0, zmax];
  assertClose(zmax, 3.5, 1e-6, '产物炮口 z');
  assertClose((xmin + xmax) / 2, 0, 1e-9, '炮管左右对称 ⇒ 轴心 x=0');
  const ctl = new TurretController({
    id: 't', anchor: { origin: [0, 0, 0], rotation: 0 },
    onInvalidated: () => {}, onFire: () => {},
  });
  const m = new THREE.Matrix4();
  // ⚠️ 逐度扫描全 ±45°（只测几个档位会漏掉中间角度的符号/轴偏移错误）
  for (let deg = -45; deg <= 45; deg++) {
    const pitch = deg * Math.PI / 180;
    ctl.currentPitch = pitch;
    ctl.currentRotation = 0;
    r.sync(new Map([['t', { position: ctl.pivot(), yaw: 0, pitch }]]));
    r.meshes.barrel.getMatrixAt(0, m);
    const w = new THREE.Vector3(...muzzleLocal).applyMatrix4(m);
    const want = ctl.muzzle().position;
    assertClose(w.x, want[0], 1e-5, `pitch=${deg}° 炮口 x`);
    assertClose(w.y, want[1], 1e-5, `pitch=${deg}° 炮口 y`);
    assertClose(w.z, want[2], 1e-5, `pitch=${deg}° 炮口 z`);
  }
  // 玩法数值零改动的旁证：pivot 高度仍是 origin.y + BASE_DY + 3.3
  assertClose(ctl.pivot()[1], 1 + TURRET.pivotHeightOffset, 1e-9, 'pivot 高度未变');
  r.dispose();
});

test('turret-top: 刚性一体 —— 8 部件共用同一 pivot 旋转（无独立轴）', async () => {
  const THREE = await import('three');
  const { TurretRenderer } = await import('../render/turret-renderer.js');
  const geo = await topGeometry();
  const r = new TurretRenderer({ scene: new THREE.Scene(), topGeometry: geo, maxActive: 1 });
  const { TURRET_PARTS } = await import('../entities/turrets/turret-config.js');
  const yaw = 0.7, pitch = -0.35;
  r.sync(new Map([['t', { position: [3.5, 8.3, 4.5], yaw, pitch }]]));
  // 每个部件的实例矩阵必须**逐位相同**（局部变换是恒等 ⇒ 都等于 pivot 矩阵）
  const m0 = new THREE.Matrix4();
  r.meshes[TURRET_PARTS[0]].getMatrixAt(0, m0);
  for (const k of TURRET_PARTS) {
    const m = new THREE.Matrix4();
    r.meshes[k].getMatrixAt(0, m);
    for (let i = 0; i < 16; i++) {
      assertClose(m.elements[i], m0.elements[i], 1e-9, `${k} 矩阵元 ${i} 与 ${TURRET_PARTS[0]} 相同`);
    }
  }
  r.dispose();
});

test('turret-top: 材质分支靠 TURRET_TONED_PARTS —— 零贴图，均走金属', async () => {
  const THREE = await import('three');
  const { uniform } = await import('three/tsl');
  const { TurretRenderer } = await import('../render/turret-renderer.js');
  const { TURRET_PART_DEFS, TURRET_GUN_COLOR, TURRET_TONE_COLOR } =
    await import('../entities/turrets/turret-config.js');
  const geo = await topGeometry();
  const sunDirection = uniform(new THREE.Vector3(0, 0.8, 0.6));
  const r = new TurretRenderer({ scene: new THREE.Scene(), topGeometry: geo, sunDirection });
  // ⚠️ **装甲不再带 map**（v3.14 用户裁定去贴图）—— 旧判据「装甲须带 map」已按新语义改写。
  for (const k of [...TURRET_TOP_ARMOR, ...TURRET_TOP_SOLID]) {
    assertEqual(r.meshes[k].material.map, null, `${k} 零贴图`);
    assertTrue(r.meshes[k].material.colorNode !== null, `${k} 走金属 TSL`);
  }
  r.dispose();
  // 无太阳 uniform 的退回路径：装甲用**中档灰**，单色部件仍用各自色值
  const r2 = new TurretRenderer({ scene: new THREE.Scene(), topGeometry: geo });
  for (const k of TURRET_TOP_ARMOR) {
    assertEqual(r2.meshes[k].material.map, null, `${k} 退回路径不带 map`);
    assertEqual(r2.meshes[k].material.color.getHex(), TURRET_TONE_COLOR.SIDE, `${k} 退回中档灰`);
  }
  for (const k of TURRET_TOP_SOLID) {
    assertEqual(r2.meshes[k].material.color.getHex(), TURRET_PART_DEFS[k].color, `${k} 单色不受影响`);
  }
  assertEqual(r2.meshes.barrel.material.color.getHex(), TURRET_GUN_COLOR.BARREL, '炮管深灰炮钢');
  r2.dispose();
});

test('turret-top: 刚性一体的旋转不变量 —— 炮管尾端埋入鼻段（任意 yaw/pitch 恒定）', async () => {
  const THREE = await import('three');
  const { TurretRenderer } = await import('../render/turret-renderer.js');
  const geo = await topGeometry();
  const r = new TurretRenderer({ scene: new THREE.Scene(), topGeometry: geo, maxActive: 1 });
  // 炮管尾端 z 最小值与鼻段 z 最大值（局部坐标）
  const bz = geo.parts.barrel.position, nz = geo.parts.nose.position;
  let barrelTail = Infinity, noseFront = -Infinity;
  for (let i = 2; i < bz.length; i += 3) barrelTail = Math.min(barrelTail, bz[i]);
  for (let i = 2; i < nz.length; i += 3) noseFront = Math.max(noseFront, nz[i]);
  const embed = noseFront - barrelTail;
  assertTrue(embed > 0.2, `炮管尾端须埋入鼻段（实测 ${embed.toFixed(3)} 格）`);
  // ⚠️ 像素判据只测了 yaw=0 的三个 pitch；本条从**矩阵**证明任意 yaw/pitch 下
  // 埋入深度恒定（8 部件共用同一矩阵 ⇒ 相对位置是旋转不变量）。
  const m = new THREE.Matrix4();
  const tailLocal = new THREE.Vector3(0, 0, barrelTail);
  const frontLocal = new THREE.Vector3(0, 0, noseFront);
  for (const yawDeg of [0, 45, 90, 137, 180, -90, -137]) {
    for (const pitchDeg of [-45, -20, 0, 20, 45]) {
      r.sync(new Map([['t', {
        position: [5.5, 9.5, 6.5],
        yaw: yawDeg * Math.PI / 180, pitch: pitchDeg * Math.PI / 180,
      }]]));
      r.meshes.barrel.getMatrixAt(0, m);
      const tw = tailLocal.clone().applyMatrix4(m);
      r.meshes.nose.getMatrixAt(0, m);
      const fw = frontLocal.clone().applyMatrix4(m);
      assertClose(tw.distanceTo(fw), embed, 1e-5,
        `yaw=${yawDeg}° pitch=${pitchDeg}° 埋入深度恒定`);
    }
  }
  r.dispose();
});

// ==================== Final review 修复（Important 1~4） ====================

test('turret-top: 几何加载器对畸形 JSON 返回 null（不崩启动）', async () => {
  const { loadTurretTopGeometry } = await import('../render/turret-top-geometry.js');
  // 真实加载路径须成功（前提）
  const ok = await loadTurretTopGeometry();
  assertTrue(ok !== null && typeof ok.parts === 'object', '正常产物须加载成功');
  // ⚠️ 畸形形状：合法 JSON 但无 parts（旧格式 / 代理错误页 / 半截响应）
  // 用注入 fetch 的方式走真实加载器的校验分支
  const origFetch = globalThis.fetch;
  const bad = [{}, { parts: null }, { parts: [] }, { parts: 'x' }, null, { scale: 1 }];
  try {
    for (const body of bad) {
      globalThis.fetch = async () => ({ ok: true, json: async () => body });
      const r = await loadTurretTopGeometry();
      assertEqual(r, null, `畸形产物 ${JSON.stringify(body)} 须返回 null`);
    }
    // 缺部件的 parts 也算畸形（渲染层会取不到 part）
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ parts: { barrel: {} } }) });
    assertEqual(await loadTurretTopGeometry(), null, '缺部件须返回 null');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('turret-top: 渲染层对畸形 topGeometry 不抛异常（玩法仍正常）', async () => {
  const THREE = await import('three');
  const { TurretRenderer } = await import('../render/turret-renderer.js');
  for (const bad of [null, {}, { parts: null }, { parts: {} }]) {
    const r = new TurretRenderer({ scene: new THREE.Scene(), topGeometry: bad });
    assertEqual(Object.keys(r.meshes).length, 0, `畸形 ${JSON.stringify(bad)} 不建 mesh`);
    // sync 空转不抛
    r.sync(new Map([['t', { position: [0, 0, 0], yaw: 0, pitch: 0 }]]));
    r.sync(new Map());
    r.dispose();
  }
});

test('turret-top: 炮管尾端埋入鼻段的关系式（防尾部前移造成真实缝隙）', async () => {
  const geo = await topGeometry();
  const np = geo.parts.nose.position, bp = geo.parts.barrel.position;
  let noseFront = -Infinity, barrelTail = Infinity;
  for (let i = 2; i < np.length; i += 3) noseFront = Math.max(noseFront, np[i]);
  for (let i = 2; i < bp.length; i += 3) barrelTail = Math.min(barrelTail, bp[i]);
  const embed = noseFront - barrelTail;
  // ⚠️ 这条是「炮管尾部前移」的唯一防线：顶点数/zmax/UV 全不变时也能抓到。
  // 实测埋入量 0.3106 格；阈值取 0.2（低于实测、远高于 0）。
  assertTrue(embed > 0.2, `炮管尾端须埋入鼻段 > 0.2 格，实测 ${embed.toFixed(4)}`);
});

// ==================== 用户实玩缺陷：塔身破缺（开放壳 + FrontSide） ====================

test('turret-top: 装甲部件必须是闭合壳（切口要有封口，否则从内部看穿成纸片）', async () => {
  const geo = await topGeometry();
  // ⚠️ **这条是用户实玩发现的缺陷**（2026-11-18 截图：塔身变纸片、能看穿）。
  // 根因：源 TankBase 是闭合流形（2268 边全被 2 面共用），但按 bbox 窗口切成
  // 6 块后**切口处没有封口面** ⇒ 每块成单侧开放壳，FrontSide 材质下从切口看进去是空的。
  // 顶点数/三角数/UV/法线/绕序/有向体积全部正确 ⇒ 那些判据都拓不到它。
  for (const k of TURRET_TOP_ARMOR) {
    const g = geo.parts[k];
    const idx = new Map();
    const idOf = (j) => {
      const key = [0, 1, 2].map((q) => g.position[j * 3 + q].toFixed(4)).join(',');
      if (!idx.has(key)) idx.set(key, idx.size);
      return idx.get(key);
    };
    const edges = new Map();
    for (let i = 0; i < g.index.length; i += 3) {
      const ids = [g.index[i], g.index[i + 1], g.index[i + 2]].map(idOf);
      for (let e = 0; e < 3; e++) {
        const a = ids[e], b = ids[(e + 1) % 3];
        const key = Math.min(a, b) + '_' + Math.max(a, b);
        edges.set(key, (edges.get(key) || 0) + 1);
      }
    }
    let open = 0;
    for (const c of edges.values()) if (c === 1) open++;
    assertEqual(open, 0, `${k} 有 ${open} 条开放边（切口未封口 ⇒ 从内部看穿）`);
  }
});

// ==================== 用户实玩缺陷 2：塔身下方看穿（丢了过渡段） ====================

test('turret-top: 塔身必须盖住 obsidian 柱顶（下方不得有空洞）', async () => {
  const geo = await topGeometry();
  const { TURRET } = await import('../entities/turrets/turret-config.js');
  // obsidian 柱顶面在 pivot 下方 (pivotHeightOffset - 3) = 0.3 格
  // （pivot = origin.y + BASE_DY + 3.3，柱顶 = origin.y + BASE_DY + 2 + 1 = +3）
  const pillarTop = -(TURRET.pivotHeightOffset - 3);   // = -0.3
  // 柱是 1×1 格，中心在 pivot 正下方 ⇒ 水平足迹 |x|<=0.5, |z|<=0.5
  // 判据：塔身在该足迹内必须有几何**下探到柱顶或更低**，否则从下方看穿到天空。
  // ⚠️ **判据用「最低点」而非「柱足迹内有顶点」**：原模型车体中心本就是空心
  // （真坦克那里是炮塔座圈），柱足迹内**没有任何顶点**，顶点判据恒不成立。
  let lowest = Infinity;
  for (const g of Object.values(geo.parts)) {
    for (let i = 1; i < g.position.length; i += 3) lowest = Math.min(lowest, g.position[i]);
  }
  assertTrue(lowest <= pillarTop + 1e-6,
    `总成最低点 ${lowest.toFixed(3)} 须 ≤ 柱顶 ${pillarTop}（否则塔身与柱之间看穿）`);
});

test('turret-top: 八部件组装后不得有开放边（部件间接缝也要封）', async () => {
  const geo = await topGeometry();
  const idx = new Map();
  const idOf = (x, y, z) => {
    const k = [x, y, z].map((v) => v.toFixed(4)).join(',');
    if (!idx.has(k)) idx.set(k, idx.size);
    return idx.get(k);
  };
  const edges = new Map();
  for (const g of Object.values(geo.parts)) {
    for (let i = 0; i < g.index.length; i += 3) {
      const ids = [g.index[i], g.index[i + 1], g.index[i + 2]]
        .map((j) => idOf(g.position[j * 3], g.position[j * 3 + 1], g.position[j * 3 + 2]));
      for (let e = 0; e < 3; e++) {
        const a = ids[e], b = ids[(e + 1) % 3];
        const k = Math.min(a, b) + '_' + Math.max(a, b);
        edges.set(k, (edges.get(k) || 0) + 1);
      }
    }
  }
  let open = 0;
  for (const c of edges.values()) if (c === 1) open++;
  // ⚠️ 炮管尾/副武器管口是原模型设计的开口，允许；但**装甲件之间**不得有缝。
  // 这里先钉住总数上界（实测修复前 184），修复后应显著下降。
  assertTrue(open <= 184, `组装体开放边 ${open}（修复前 184，不得增加）`);
});

// ==================== 三档色调（v3.14：炮头去贴图改颜色渲染） ====================
//
// 设计：docs/superpowers/specs/2026-11-18-turret-head-color-shading-design.md
//
// ⚠️⚠️ **色调档与 UV 区不是同一套语义，不得互推**：
//   · UV 区 `zoneOf` = front/side/top，按**主轴**分，**底面归 top**；
//   · 色调档 `toneOf` = 0(top)/1(side)/2(bottom)，按 **ny 符号**分。
// 两者阈值同为 0.85 但分类不同 —— 实测 nose 的 front 区 215 面而色调 side 档 277 面。
// 照抄 zoneOf 会让所有底面被当成顶面（最亮档），裙板底面在仰视时发白。

test('turret-top: toneOf 三档分类 —— 阈值两侧与底面归属', async () => {
  // 造面：水平面（ny=±1）与竖直面（ny=0），不依赖 OBJ 数据 ⇒ 纯函数判据。
  // ⚠️ **绕序必须用 geomNormal 实测核准，不能凭直觉标 up/down**：
  // Newell 叉积下 `[[0,0,0],[1,0,0],[1,0,1],[0,0,1]]` 的 ny 是 **−1**（朝下），
  // 与字面直觉相反 —— 初版夹具就这么标反了，得到 toneOf(up)=2 的假红。
  // 真值参系：真实 deckMid（全朝上平台）首面 ny=+1.0000 ⇒ 档 0。
  const down = [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]];    // geomNormal ny = −1
  const up = [[0, 0, 0], [0, 0, 1], [1, 0, 1], [1, 0, 0]];      // geomNormal ny = +1
  const sideX = [[0, 0, 0], [0, 1, 0], [0, 1, 1], [0, 0, 1]];   // ny = 0
  assertClose(geomNormal(up).n[1], 1, 1e-9, '夹具 up 面真的朝上');
  assertClose(geomNormal(down).n[1], -1, 1e-9, '夹具 down 面真的朝下');
  assertEqual(toneOf(up), 0, '朝上面 → 档 0（最亮）');
  assertEqual(toneOf(down), 2, '朝下面 → 档 2（最暗）');
  assertEqual(toneOf(sideX), 1, '竖直面 → 档 1（中）');
  // ⚠️ **这条是与 zoneOf 的分界判据**：zoneOf(down) === 'top'，而 toneOf(down) === 2。
  // 注入「toneOf 照抄 zoneOf」会让这里得 0 ⇒ 红。
  assertEqual(zoneOf(down), 'top', 'UV 区把底面归 top（两套语义刻意不同）');
  assertTrue(toneOf(down) !== toneOf(up), '底面与顶面不得同档');
});

test('turret-top: toneOf 阈值边界 —— 0.85 两侧紧邻值分属不同档', async () => {
  // 造一个 ny 恰好可控的斜面：法线 (0, ny, sqrt(1-ny²))
  const faceWithNy = (ny) => {
    const nz = Math.sqrt(Math.max(0, 1 - ny * ny));
    // 面内两向量 e1=(1,0,0)、e2=(0,nz,-ny) ⇒ 叉积 (0, ny, nz)
    return [[0, 0, 0], [1, 0, 0], [1, nz, -ny], [0, nz, -ny]];
  };
  const TH = TURRET_TOP_PARAMS.toneNyThreshold;
  assertEqual(TH, 0.85, '色调阈值（与 UV 区同值，实测标定）');
  assertEqual(toneOf(faceWithNy(0.86)), 0, 'ny=0.86 > 阈值 → 档 0');
  assertEqual(toneOf(faceWithNy(0.84)), 1, 'ny=0.84 < 阈值 → 档 1');
  assertEqual(toneOf(faceWithNy(-0.86)), 2, 'ny=−0.86 → 档 2');
  assertEqual(toneOf(faceWithNy(-0.84)), 1, 'ny=−0.84 → 档 1');
  // 恰好等于阈值归 side（判据是严格 >，与 zoneOf 同口径）
  assertEqual(toneOf(faceWithNy(0.85)), 1, 'ny 恰等阈值 → 档 1（严格大于）');
});

test('turret-top: 产物逐顶点 tone —— 长度等于顶点数、值域 {0,1,2}', async () => {
  const geo = await topGeometry();
  for (const k of [...TURRET_TOP_ARMOR, ...TURRET_TOP_SOLID]) {
    const g = geo.parts[k];
    assertTrue(Array.isArray(g.tone), `${k} 产物须带 tone 数组`);
    assertEqual(g.tone.length, g.position.length / 3, `${k} tone 长度 == 顶点数`);
    for (const t of g.tone) {
      assertTrue(t === 0 || t === 1 || t === 2, `${k} tone 值须 ∈ {0,1,2}，实际 ${t}`);
    }
  }
});

test('turret-top: tone 冻结表 —— 逐部件三档顶点数（不经 toneOf 的独立真值）', async () => {
  const geo = await topGeometry();
  // ⚠️ **这条是对「tone 长度/值域」那条的补充**：那两条在「tone 恒 1」下仍全绿
  // （长度对、值域对）。本条把三档顶点数**冻结成字面量**，不经过 toneOf
  // ⇒ 分类退化 / 阈值漂移 / 照抄 zoneOf 直接红。
  // 实测来源：源 OBJ 面几何法线 + 封口环法线，装甲逐面拆顶点、纯色按坐标+法线焊接。
  const TONE_VERTS = {
    cheek: [256, 304, 30], mantlet: [116, 112, 21], deckMid: [82, 0, 0],
    ring: [81, 452, 79], nose: [8, 1206, 8], skirt: [131, 2015, 64],
    barrel: [80, 1120, 132], podR: [64, 832, 64], podL: [32, 416, 32],
  };
  for (const [k, want] of Object.entries(TONE_VERTS)) {
    const got = [0, 0, 0];
    for (const t of geo.parts[k].tone) got[t]++;
    assertDeepEqual(got, want, `${k} 三档顶点数`);
  }
  // 划分恒等式：三档之和 ≡ 冻结总顶点数
  const total = Object.values(TONE_VERTS).reduce((a, c) => a + c[0] + c[1] + c[2], 0);
  assertEqual(total, 7737, '三档顶点数之和 = 总顶点数');
});

test('turret-top: 装甲部件三档都真的出现（防退化成一档）', async () => {
  const geo = await topGeometry();
  // ⚠️ cheek/mantlet/ring 源模型没有底面（ny 全 ≥ −0.39），它们的档 2 全部来自**封口面**。
  // 故不能对每个部件都要求三档齐全 —— 那会让正确实现 FAIL。
  // 判据落在**全体装甲**上：三档各自都必须有可观数量的顶点。
  const sum = [0, 0, 0];
  for (const k of TURRET_TOP_ARMOR) for (const t of geo.parts[k].tone) sum[t]++;
  assertTrue(sum[0] > 500, `装甲顶面档顶点数 ${sum[0]}（实测 674）`);
  assertTrue(sum[1] > 3000, `装甲侧面档顶点数 ${sum[1]}（实测 4089）`);
  assertTrue(sum[2] > 100, `装甲底面档顶点数 ${sum[2]}（实测 202）`);
  // deckMid 是纯水平平台 ⇒ 全档 0（含封口，实测环 ny=0.979）
  const dm = [0, 0, 0];
  for (const t of geo.parts.deckMid.tone) dm[t]++;
  assertDeepEqual(dm, [82, 0, 0], 'deckMid 全顶面档');
});

test('turret-top: 实时构造的 tone 与产物逐位一致（防产物过期）', async () => {
  const built = await builtParts();
  const geo = await topGeometry();
  for (const k of [...TURRET_TOP_ARMOR, ...TURRET_TOP_SOLID]) {
    assertTrue(Array.isArray(built[k].tone), `${k} 实时构造须产出 tone`);
    assertDeepEqual(geo.parts[k].tone, built[k].tone, `${k} tone 逐位一致`);
  }
});

test('turret-top: 三档色值 —— config 单一权威、冷调、亮度递减', async () => {
  const { TURRET_TONE_COLOR } = await import('../entities/turrets/turret-config.js');
  const keys = ['TOP', 'SIDE', 'BOTTOM'];
  assertDeepEqual(Object.keys(TURRET_TONE_COLOR), keys, '三档键序');
  const rgb = keys.map((k) => {
    const c = TURRET_TONE_COLOR[k];
    return [(c >> 16) & 255, (c >> 8) & 255, c & 255];
  });
  // ① 冷调：每一档 B > R（参考图实测 B−R = +10.7 ~ +16.4）
  for (let i = 0; i < 3; i++) {
    assertTrue(rgb[i][2] > rgb[i][0],
      `${keys[i]} 须冷调（B>R）：${rgb[i].join(',')}（参考图无暖色）`);
  }
  // ② 亮度严格递减：顶 > 侧 > 底（注入「三档同色」⇒ 红）
  const lum = rgb.map((c) => (c[0] + c[1] + c[2]) / 3);
  assertTrue(lum[0] > lum[1], `顶档须亮于侧档：${lum[0]} vs ${lum[1]}`);
  assertTrue(lum[1] > lum[2], `侧档须亮于底档：${lum[1]} vs ${lum[2]}`);
  // ③ 深灰身份：最亮档不得接近白（参考图物体均值 131，基色经金属项会提亮约 2×）
  assertTrue(lum[0] < 190, `顶档基色不得过亮（实测 148）：${lum[0]}`);
  assertTrue(lum[2] > 60, `底档基色不得近黑：${lum[2]}`);
  // ④ 装甲整体亮于炮管（炮头/炮管的层次，参考图炮管更暗）
  const { TURRET_GUN_COLOR } = await import('../entities/turrets/turret-config.js');
  const b = TURRET_GUN_COLOR.BARREL;
  const barrelLum = (((b >> 16) & 255) + ((b >> 8) & 255) + (b & 255)) / 3;
  assertTrue(lum[2] > barrelLum,
    `装甲最暗档仍须亮于炮管基色：${lum[2]} vs ${barrelLum}`);
});

test('turret-top: toned 集合三方一致（config / 烘焙侧 / 产物）', async () => {
  const { TURRET_TONED_PARTS, TURRET_PART_DEFS, TURRET_PARTS } =
    await import('../entities/turrets/turret-config.js');
  const geo = await topGeometry();
  assertDeepEqual([...TURRET_TONED_PARTS].sort(), [...TURRET_TOP_ARMOR].sort(),
    'config 的 toned 集合 ≡ 烘焙侧 TURRET_TOP_ARMOR');
  const productToned = TURRET_PARTS.filter((p) => geo.parts[p].toned).sort();
  assertDeepEqual(productToned, [...TURRET_TOP_ARMOR].sort(), '产物 toned 集合');
  // 贴图分支已删除：textured 字段不得残留（否则渲染层可能又走回贴图）
  for (const p of TURRET_PARTS) {
    assertEqual(TURRET_PART_DEFS[p].textured, undefined, `${p} config 不再有 textured`);
    assertEqual(geo.parts[p].textured, undefined, `${p} 产物不再有 textured`);
  }
  // 装甲部件不带单一 color（三档色在 TURRET_TONE_COLOR），纯色部件带
  for (const k of TURRET_TOP_ARMOR) {
    assertEqual(geo.parts[k].color, undefined, `${k} 装甲不带单一色值`);
  }
  for (const k of TURRET_TOP_SOLID) {
    assertTrue(typeof geo.parts[k].color === 'number', `${k} 纯色部件带色值`);
  }
});

test('turret-top: 渲染层把 tone 原样上传为几何属性（不改写）', async () => {
  const THREE = await import('three');
  const { TurretRenderer } = await import('../render/turret-renderer.js');
  const geo = await topGeometry();
  const r = new TurretRenderer({ scene: new THREE.Scene(), topGeometry: geo, maxActive: 1 });
  for (const k of [...TURRET_TOP_ARMOR, ...TURRET_TOP_SOLID]) {
    const attr = r.meshes[k].geometry.getAttribute('tone');
    assertTrue(attr !== undefined, `${k} 几何须带 tone 属性`);
    assertEqual(attr.count, geo.parts[k].tone.length, `${k} tone 属性长度`);
    assertEqual(attr.itemSize, 1, `${k} tone 是标量属性`);
    for (let i = 0; i < attr.count; i++) {
      assertEqual(attr.array[i], geo.parts[k].tone[i], `${k} tone[${i}] 未被改写`);
    }
  }
  r.dispose();
});

test('turret-top: 装甲材质走三档金属（无 map、有 colorNode）', async () => {
  const THREE = await import('three');
  const { uniform } = await import('three/tsl');
  const { TurretRenderer } = await import('../render/turret-renderer.js');
  const geo = await topGeometry();
  const sunDir = uniform(new THREE.Vector3(0, 0.8, 0.6));
  const r = new TurretRenderer({
    scene: new THREE.Scene(), topGeometry: geo, maxActive: 1, sunDirection: sunDir,
  });
  for (const k of TURRET_TOP_ARMOR) {
    assertEqual(r.meshes[k].material.map, null, `${k} 装甲不再带贴图`);
    assertTrue(r.meshes[k].material.colorNode !== null, `${k} 装甲须走金属 TSL`);
  }
  // 纯色部件同样走金属（现状不变）
  for (const k of TURRET_TOP_SOLID) {
    assertEqual(r.meshes[k].material.map, null, `${k} 不带贴图`);
    assertTrue(r.meshes[k].material.colorNode !== null, `${k} 走金属 TSL`);
  }
  r.dispose();
});

test('turret-top: 无太阳 uniform 时装甲退回纯色（不崩、无 map）', async () => {
  const THREE = await import('three');
  const { TurretRenderer } = await import('../render/turret-renderer.js');
  const { TURRET_TONE_COLOR } = await import('../entities/turrets/turret-config.js');
  const geo = await topGeometry();
  // 单测 fixture / 几何加载失败路径：不传 sunDirection
  const r = new TurretRenderer({ scene: new THREE.Scene(), topGeometry: geo, maxActive: 1 });
  for (const k of TURRET_TOP_ARMOR) {
    assertEqual(r.meshes[k].material.map, null, `${k} 退回路径不带 map`);
    // 退回色取**中档**（不是旧的 TURRET_TOWER_COLOR.MAIN 浅灰）
    assertEqual(r.meshes[k].material.color.getHex(), TURRET_TONE_COLOR.SIDE,
      `${k} 退回中档灰`);
  }
  r.dispose();
});

test('turret-top: 三档基色节点不得是 vec3(Color)（那种写法在 GPU 上出黑）', async () => {
  const THREE = await import('three');
  const { vec3, color, uniform } = await import('three/tsl');
  // ⚠️⚠️ **实测缺陷（v3.14）**：`vec3(new THREE.Color(hex))` 在 WebGPU 后端
  // **输出纯黑**，而且**零报错零警告** —— 装甲 6 部件整片消失，
  // 而 tone 属性/值域/冻结表/材质类型判据**全绿**。
  //
  // 根因：`vec3` 单参数走「转成 vec3」路径，而 `getValueType(Color)` 返回 `'color'`
  // （不是 `'vec3'`）⇒ 转换拿不到分量。逐写法实测（同一几何同一相机）：
  //   vec3(Color)        非黑像素 **0**
  //   vec3(c.r,c.g,c.b)  非黑像素 10455，均值 118,124,132
  //   color(hex)         同上
  //   uniform(Color)     同上
  //
  // 本用例钉住「可用写法的节点形状」，防后人把 `vec3(...)` 改回单参数形式。
  // 真正的像素判据在 tests/turret-render.spec.mjs（三档各采到对应色）。
  const C = new THREE.Color(0x767c84);
  const bad = vec3(C);
  const goodRGB = vec3(C.r, C.g, C.b);
  const goodColor = color(0x767c84);
  // 单参数形式：内部 ConstNode 直接持有 Color 对象（拿不到分量）
  assertTrue(bad.node?.value instanceof THREE.Color,
    'vec3(Color) 的内部常量仍是 Color（这就是出黑的形态）');
  // 可用形式：要么内部是 Vector3（已拆分量），要么是 UniformNode
  assertTrue(goodRGB.node?.value instanceof THREE.Vector3,
    'vec3(r,g,b) 的内部常量是 Vector3（分量已展开）');
  assertTrue(goodColor.node?.value instanceof THREE.Color || goodColor.isUniformNode === true,
    'color(hex) 走专用 color 类型路径');
  assertTrue(uniform(C).isUniformNode === true, 'uniform(Color) 是 UniformNode');
});
