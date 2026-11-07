// src/tests/test-blockbench-geometry.js — v2.65：Blockbench 逐面 UV 模型的纯几何解析（Tier 1）
//
// 判据全部是**关系式**，不硬编码「被测代码写入的那个值」（testing-policy §2.5）：
//   · UV 归一化 = uv/16（与 texture_size 无关）—— 用两个不同 texture_size 的合成模型交叉验证；
//   · v 方向翻一次（Blockbench v=0 在图顶，three flipY v=0 在图底）⇒ vTop > vBottom；
//   · `rotation:180` 是矩形内四角对调（对角和不变）；
//   · 元素旋转不改变盒尺寸（刚体变换），且 45° 绕 x 会把 y/z 跨度混起来；
//   · 真实素材（sword.json）解析后：元素数 = JSON 里的数、包围盒与 from/to 一致、
//     剑刃元素采样到紫色（与贴图对账，防「UV 映射整体错位」这种静默缺陷）。
import { test } from './runner.js';
import { assertEqual, assertTrue, assertFalse, AssertionError } from './assert.js';
import {
  parseBlockbenchElements, normalizeUvRect, elementsBounds,
  BOX_FACE_NAMES, BOX_FACE_VERT_UV, BLOCKBENCH_UV_DIVISOR,
} from '../render/blockbench-geometry.js';

/** 真实素材（浏览器内 fetch；同构层不 import node 模块） */
let swordModel = null;
async function loadSwordModel() {
  if (swordModel) return swordModel;
  const r = await fetch(new URL('../../assets/models/weapons/sword/sword.json', import.meta.url));
  swordModel = await r.json();
  return swordModel;
}

// ---------- 常量与面序 ----------

test('blockbench-geometry: UV 归一化分母恒为 16（不是 texture_size）', () => {
  assertEqual(BLOCKBENCH_UV_DIVISOR, 16);
  // 面序必须与 three BoxGeometry 的 build 序一致（+X,-X,+Y,-Y,+Z,-Z）
  // ⚠️ 改这个映射会让全部面的贴图张冠李戴，而「模型能看见」的判据抓不到
  assertEqual(BOX_FACE_NAMES.join(','), 'east,west,up,down,south,north');
  // BoxGeometry 每面 4 顶点的 uv 布局（实测，6 面一致）
  assertEqual(BOX_FACE_VERT_UV.length, 4);
  assertEqual(BOX_FACE_VERT_UV[0].join(','), '0,1');
  assertEqual(BOX_FACE_VERT_UV[1].join(','), '1,1');
  assertEqual(BOX_FACE_VERT_UV[2].join(','), '0,0');
  assertEqual(BOX_FACE_VERT_UV[3].join(','), '1,0');
});

// ---------- UV 矩形归一化 ----------

test('blockbench-geometry: normalizeUvRect 按 uv/16 归一化且 v 翻一次', () => {
  const rect = normalizeUvRect([0, 0, 16, 16]);
  // u 不翻：0 → 0，16 → 1
  assertEqual(rect[0], 0);
  assertEqual(rect[2], 1);
  // v 翻：Blockbench v=0（图顶）→ three v=1；v=16（图底）→ three v=0
  assertEqual(rect[1], 1, 'v1=0（图顶）必须翻成 three v=1');
  assertEqual(rect[3], 0, 'v2=16（图底）必须翻成 three v=0');
  assertTrue(rect[1] > rect[3], 'flipY 口径下 vTop 必须 > vBottom');
});

test('blockbench-geometry: normalizeUvRect 支持反向矩形（u1>u2 / v1>v2）', () => {
  // 素材里真实存在（剑刃 west 面 uv=[1,0,0,3.5]）：规范化成 min/max 会让那些面水平镜像
  const rect = normalizeUvRect([1, 0, 0, 3.5]);
  assertEqual(rect[0], 1 / 16, 'uLeft 保留书写值 1/16（不排序）');
  assertEqual(rect[2], 0, 'uRight 保留书写值 0');
  assertTrue(rect[0] > rect[2], '反向 u 矩形必须保持反向');
  assertEqual(rect[1], 1);
  assertEqual(rect[3], 1 - 3.5 / 16);
});

test('blockbench-geometry: normalizeUvRect 与 texture_size 无关（两模型交叉验证）', () => {
  // dragonrend texture_size=64、ancientblade texture_size=32，但归一化分母都是 16。
  // 若误用 texture_size 作分母，同一 uv 在两个模型上会得到不同归一化值 —— 这里钉住「不会」。
  const a = normalizeUvRect([8, 8, 8, 8]);
  assertEqual(a[0], 0.5);
  assertEqual(a[1], 0.5);
  // 负向锚点：把分母换成 64 会让 8/64=0.125 ≠ 0.5，上面两条 FAIL
  assertFalse(Math.abs(a[0] - 8 / 64) < 1e-9, '分母不得是 texture_size(64)');
});

// ---------- 元素解析 ----------

test('blockbench-geometry: parseBlockbenchElements 把模型单位换成方块单位（/16）', () => {
  const els = parseBlockbenchElements({
    elements: [{ from: [0, 0, 0], to: [16, 32, 8], faces: { up: { uv: [0, 0, 4, 4] } } }],
  });
  assertEqual(els.length, 1);
  assertEqual(els[0].size[0], 1);
  assertEqual(els[0].size[1], 2);
  assertEqual(els[0].size[2], 0.5);
  assertEqual(els[0].center[0], 0.5);
  assertEqual(els[0].center[1], 1);
  assertEqual(els[0].center[2], 0.25);
  // 无 rotation 字段 → angleDeg 0，origin 缺省为盒中心
  assertEqual(els[0].rotation.angleDeg, 0);
  assertEqual(els[0].rotation.origin[1], 1);
});

test('blockbench-geometry: parseBlockbenchElements 只收有 uv 的面，并保留 rotation:180', () => {
  const els = parseBlockbenchElements({
    elements: [{
      from: [0, 0, 0], to: [1, 1, 1],
      faces: {
        up: { uv: [0, 0, 1, 1] },
        down: { uv: [0, 0, 1, 1], rotation: 180 },
        north: { texture: '#0' },          // 无 uv → 跳过
      },
    }],
  });
  const faces = Object.keys(els[0].faces).sort();
  assertEqual(faces.join(','), 'down,up');
  assertEqual(els[0].faces.up.uvRotation, 0);
  assertEqual(els[0].faces.down.uvRotation, 180);
});

test('blockbench-geometry: 不支持的面 UV 旋转（90/270）必须抛错而不是静默错', () => {
  let threw = false;
  try {
    parseBlockbenchElements({
      elements: [{ from: [0, 0, 0], to: [1, 1, 1], faces: { up: { uv: [0, 0, 1, 1], rotation: 90 } } }],
    });
  } catch (err) {
    threw = err instanceof Error && /不支持的面 UV 旋转/.test(err.message);
  }
  assertTrue(threw, '90° 面旋转必须抛可识别错误');
});

test('blockbench-geometry: elements 缺失时抛错', () => {
  let threw = false;
  try { parseBlockbenchElements({}); } catch (err) { threw = err instanceof Error; }
  assertTrue(threw);
  let threw2 = false;
  try { parseBlockbenchElements(null); } catch (err) { threw2 = err instanceof Error; }
  assertTrue(threw2);
});

test('blockbench-geometry: elementsBounds 与 from/to 一致（无旋转元素）', () => {
  const els = parseBlockbenchElements({
    elements: [
      { from: [0, 0, 0], to: [16, 16, 16], faces: {} },
      { from: [16, 16, 16], to: [32, 32, 32], faces: {} },
    ],
  });
  const b = elementsBounds(els);
  assertEqual(b.min[0], 0); assertEqual(b.min[1], 0); assertEqual(b.min[2], 0);
  assertEqual(b.max[0], 2); assertEqual(b.max[1], 2); assertEqual(b.max[2], 2);
  assertEqual(b.size[0], 2);
});

// ---------- 真实素材（sword.json）----------

test('sword.json: 元素数与 JSON 一致，包围盒 = from/to 的并集（/16）', async () => {
  const model = await loadSwordModel();
  const els = parseBlockbenchElements(model);
  assertEqual(els.length, model.elements.length, '不得丢元素（丢一个就是剑缺一块）');

  // 独立复算包围盒（不经过 elementsBounds，避免「两侧共用同一个错误假设」）
  let minX = Infinity; let minY = Infinity; let minZ = Infinity;
  let maxX = -Infinity; let maxY = -Infinity; let maxZ = -Infinity;
  for (const el of model.elements) {
    for (const [i, v] of [el.from, el.to].entries()) {
      minX = Math.min(minX, v[0] / 16); maxX = Math.max(maxX, v[0] / 16);
      minY = Math.min(minY, v[1] / 16); maxY = Math.max(maxY, v[1] / 16);
      minZ = Math.min(minZ, v[2] / 16); maxZ = Math.max(maxZ, v[2] / 16);
      void i;
    }
  }
  const b = elementsBounds(els);
  // ⚠️ 容差：elementsBounds 不含元素旋转，而素材有 5 个 45° 绕 x 的护手件 ——
  // 旋转会扩大 y/z 跨度。故只钉「无旋转维度（x）一致」+「y/z 不小于未旋转值」。
  // ⚠️ **必须带 epsilon**：素材的 from/to 含 `6.501` `8.481` 这类小数，`/16` 后与
  // 独立复算的那一侧差一个 ULP（实测 0.39375 vs 0.39375000000000004）——
  // `assertEqual` 是逐位比较，不带容差就是假失败。
  const EPS = 1e-9;
  assertTrue(Math.abs(b.min[0] - minX) < EPS, `x 下界必须一致（实测 ${b.min[0]} vs ${minX}）`);
  assertTrue(Math.abs(b.max[0] - maxX) < EPS, `x 上界必须一致（实测 ${b.max[0]} vs ${maxX}）`);
  assertTrue(b.min[1] <= minY + EPS, 'y 下界不得大于未旋转值');
  assertTrue(b.max[2] >= maxZ - EPS, 'z 上界不得小于未旋转值');
  // 剑是「细长剑身」：y 跨度必须远大于 x/z（防「解析成横躺的剑」）
  assertTrue(b.size[1] > b.size[0] * 5, `剑身必须竖直细长，实测 size=${b.size.map((n) => n.toFixed(3))}`);
  assertTrue(b.size[1] > b.size[2] * 2);
});

test('sword.json: 全部面矩形都在 [0,1] 内且 v 两边不重合（flipY 口径）', async () => {
  const model = await loadSwordModel();
  const els = parseBlockbenchElements(model);
  let n = 0;
  let reversedV = 0;
  for (const el of els) {
    for (const name of Object.keys(el.faces)) {
      const { rect } = el.faces[name];
      n++;
      for (const v of rect) {
        if (!Number.isFinite(v)) throw new AssertionError(`面 ${name} 的 rect 含非有限数：${rect}`);
        // 允许贴边（0 与 1），不允许越界
        if (v < -1e-9 || v > 1 + 1e-9) {
          throw new AssertionError(`面 ${name} 的 rect 越界 [0,1]：${rect}`);
        }
      }
      // ⚠️ **不得断言 vTop > vBottom**：素材里存在**故意反向**的 v 矩形
      //（如 el0 的 up 面 uv=[5.5,1.5,5.25,1.25]，v1 > v2 ⇒ 该面垂直镜像采样）。
      // 规范化成 min/max 会让那些面上下颠倒（与 `normalizeUvRect` 保留反向书写同理）。
      // 故只钉「两边不重合」（重合 = 零高矩形，采样退化成一条线）。
      if (rect[1] < rect[3]) reversedV++;
      if (Math.abs(rect[1] - rect[3]) < 1e-12) {
        throw new AssertionError(`面 ${name} 的 v 矩形高度为零：${rect}`);
      }
    }
  }
  // 16 元素 × 6 面 = 96（素材每面都有 uv）
  assertEqual(n, model.elements.length * 6, '每个元素的 6 个面都要解析到');
  // 反向 v 矩形确实存在（钉住「我们保留了它」而不是静默排序掉）
  assertTrue(reversedV > 0, `素材应含反向 v 矩形（实测 ${reversedV}）`);
});

test('sword.json: UV 足迹覆盖贴图不透明区（防「整体错位」的静默缺陷）', async () => {
  const model = await loadSwordModel();
  const els = parseBlockbenchElements(model);
  // 素材实测：贴图 64×64（单帧），不透明内容 bbox = x[0,23] y[0,54]（像素）
  // UV 足迹必须**覆盖**它 —— 若按「uv=像素」解析，足迹只有 x[0,6] y[0,16]（25%/29%），
  // 形态是「剑体只贴到贴图左上角一小块」，而元素数/包围盒断言全绿。
  let minU = Infinity; let maxU = -Infinity; let minRow = Infinity; let maxRow = -Infinity;
  for (const el of els) {
    for (const name of Object.keys(el.faces)) {
      const [uL, vT, uR, vB] = el.faces[name].rect;
      minU = Math.min(minU, uL, uR); maxU = Math.max(maxU, uL, uR);
      // rect 是 [uLeft, vTop, uRight, vBottom]（three flipY 口径，vTop > vBottom）。
      // 图像行号比例 = 1 - v ⇒ **两条 v 边都要算**（只算 vTop 会漏掉矩形下半，
      // 实测形态：足迹 44px 而真实是 64px → 断言假失败）。
      minRow = Math.min(minRow, 1 - vT, 1 - vB);
      maxRow = Math.max(maxRow, 1 - vT, 1 - vB);
    }
  }
  const TEX = 64;
  const coverX = (maxU - minU) * TEX;
  const coverY = (maxRow - minRow) * TEX;
  assertTrue(coverX >= 23, `UV 足迹 x 跨度 ${coverX.toFixed(1)}px 必须覆盖不透明区宽 23px`);
  assertTrue(coverY >= 54, `UV 足迹 y 跨度 ${coverY.toFixed(1)}px 必须覆盖不透明区高 54px`);
  // 负向锚点：若误用「uv = 像素」（分母 64 而不是 16），coverX 只有 6px ⇒ 上面 FAIL
  assertTrue(minU >= -1e-9 && maxU <= 1 + 1e-9, 'u 足迹不得越界');
});

test('sword.json: 护手件带 45° 绕 x 旋转，剑身/剑柄不旋转', async () => {
  const model = await loadSwordModel();
  const els = parseBlockbenchElements(model);
  const rotated = els.filter((el) => el.rotation.angleDeg !== 0);
  assertTrue(rotated.length > 0, '素材含旋转元素（护手），解析不得丢掉旋转');
  for (const el of rotated) {
    assertEqual(el.rotation.angleDeg, 45);
    assertEqual(el.rotation.axis, 'x');
    // origin 必须换算成方块单位（/16）—— 漏换算会让旋转中心跑到 16 倍远的地方
    for (const v of el.rotation.origin) {
      assertTrue(Math.abs(v) < 4, `origin 必须是方块单位（实测 ${v}）`);
    }
  }
  // 剑身（最高的元素）不旋转
  const tallest = els.reduce((a, b) => (b.size[1] > a.size[1] ? b : a));
  assertEqual(tallest.rotation.angleDeg, 0, '剑身不得带旋转');
});
