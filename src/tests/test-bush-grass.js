// src/tests/test-bush-grass.js — 矮草丛方块（v3.12）
//
// 用户 2026-11-17：「增加一个矮草丛……样子类似 short_grass，只是稍微比 short_grass 更大一些」。
// 贴图取 vanilla `short_grass`（灰度）× GRASS_TINT，与新草方块同色调。
//
// ⚠️ **「更大」必须按实际草的 bbox 算，不能按 quad 尺寸算**：
// 本仓 short_grass 用的 `double_plant_grass_carried` 贴图左右各留 1 列空、上下满格；
// vanilla `short_grass` 贴图满宽、顶部留 2 行空。两者的「贴图占 quad 的比例」不同 ——
// 按 quad 尺寸等比放大 15%，实际草高只 +0.6%（几乎看不出），宽度却 +31%。
// 故本用例的判据落在 **quad 跨度 × 贴图不透明 bbox 占比** 上。
import { test } from './runner.js';
import { assertEqual, assertTrue, assertNotNull } from './assert.js';
import { TEMPLATES } from '../mesh/mesher.js';
import { BLOCKS } from '../voxel/blocks-data.js';
import { FACES_DATA } from '../voxel/faces-data.js';
import { createRegistry } from '../voxel/block-registry.js';

function assertClose(actual, expected, tol, message = '') {
  if (!(Math.abs(actual - expected) <= tol)) {
    throw new Error(`${message ? message + ': ' : ''}期望 ${expected}±${tol}，实得 ${actual}`);
  }
}

/** quad 集合的三轴跨度 */
function spanOf(quads) {
  const xs = [], ys = [], zs = [];
  for (const q of quads) for (const v of q.v) { xs.push(v[0]); ys.push(v[1]); zs.push(v[2]); }
  return {
    x: Math.max(...xs) - Math.min(...xs),
    y: Math.max(...ys) - Math.min(...ys),
    z: Math.max(...zs) - Math.min(...zs),
    yMin: Math.min(...ys),
    yMax: Math.max(...ys),
  };
}

/**
 * 两张贴图的「不透明 bbox 占整图的比例」（实测值，写死是有意的 —— 它是素材事实）。
 * 实测：double_plant_grass_carried 不透明 bbox x1..14 y0..15（宽 14/16、高 16/16）
 *       vanilla short_grass       不透明 bbox x0..15 y2..15（宽 16/16、高 14/16）
 */
const SHORT_GRASS_TEX = { wFrac: 14 / 16, hFrac: 16 / 16 };
const BUSH_GRASS_TEX = { wFrac: 16 / 16, hFrac: 14 / 16 };

test('bush_grass 有几何模板，且与 flower 同结构（2 个双面 cross 平面）', () => {
  const q = TEMPLATES.bush_grass;
  assertNotNull(q, 'TEMPLATES.bush_grass 存在');
  assertEqual(q.length, TEMPLATES.flower.length, 'quad 数与 flower 相同');
  assertTrue(q.every((t) => t.ds === true), '全部双面（ds:true）');
  // 两个正交平面：一个朝 Z（face 4）、一个朝 X（face 0），与 flower 同序
  assertEqual(q.map((t) => t.face).join(','), TEMPLATES.flower.map((t) => t.face).join(','), 'face 序');
});

test('bush_grass 的实际草尺寸比 short_grass 大（按贴图 bbox 折算，不是按 quad）', () => {
  const bush = spanOf(TEMPLATES.bush_grass);
  const short = spanOf(TEMPLATES.flower);
  // 实际草宽 = quad 水平跨度 × 贴图不透明宽占比
  const bushW = bush.x * BUSH_GRASS_TEX.wFrac;
  const shortW = short.x * SHORT_GRASS_TEX.wFrac;
  // 实际草高 = quad 竖直跨度 × 贴图不透明高占比
  const bushH = bush.y * BUSH_GRASS_TEX.hFrac;
  const shortH = short.y * SHORT_GRASS_TEX.hFrac;
  assertTrue(bushH > shortH, `草高 ${bushH.toFixed(4)} 应 > short_grass 的 ${shortH.toFixed(4)}`);
  assertTrue(bushW > shortW, `草宽 ${bushW.toFixed(4)} 应 > short_grass 的 ${shortW.toFixed(4)}`);
  // 「稍微更大」= 草高 +15%（0.700 → 0.805），双侧钉界防止调过头
  assertClose(bushH, 0.805, 0.025, '实际草高');
  assertClose(bushW, 0.805, 0.025, '实际草宽');
  const ratio = bushH / shortH;
  assertTrue(ratio > 1.10 && ratio < 1.25, `草高放大比 ${ratio.toFixed(3)} 应在 1.10~1.25（稍微更大）`);
});

test('bush_grass 草底略入土、草顶不超出格顶', () => {
  const s = spanOf(TEMPLATES.bush_grass);
  assertTrue(s.yMin < 0, `草底 y=${s.yMin} 应略低于格底（入土，防浮空）`);
  assertTrue(s.yMin > -0.15, `草底 y=${s.yMin} 不应埋太深`);
  assertTrue(s.yMax <= 1.0, `草顶 y=${s.yMax} 不得超出格顶`);
});

test('bush_grass 是水平居中的 cross（x/z 跨度相等且中心在 0.5）', () => {
  const q = TEMPLATES.bush_grass;
  const s = spanOf(q);
  assertClose(s.x, s.z, 1e-9, 'x/z 跨度相等');
  for (const t of q) {
    const xs = t.v.map((v) => v[0]), zs = t.v.map((v) => v[2]);
    const cx = (Math.max(...xs) + Math.min(...xs)) / 2;
    const cz = (Math.max(...zs) + Math.min(...zs)) / 2;
    assertClose(cx, 0.5, 1e-9, 'quad 中心 x');
    assertClose(cz, 0.5, 1e-9, 'quad 中心 z');
  }
});

test('bush_grass 方块声明与 short_grass 逐项同口径', () => {
  const bush = BLOCKS.find((b) => b.name === 'bush_grass');
  const short = BLOCKS.find((b) => b.name === 'short_grass');
  assertNotNull(bush, 'BLOCKS 里有 bush_grass');
  for (const key of ['solid', 'cullMode', 'orientationModes', 'shadowCast']) {
    assertEqual(bush[key], short[key], `字段 ${key} 与 short_grass 一致`);
  }
  assertEqual(bush.geometry, 'bush_grass', 'geometry 指向自己的模板');
});

test('bush_grass 不遮光/不剔邻居面/不挡 LOS（opaqueTable=0）', () => {
  const reg = createRegistry();
  for (const def of BLOCKS) reg.register(def.name, def);
  reg.freeze();
  const id = reg.idOf('bush_grass');
  assertNotNull(id, 'bush_grass 已注册');
  assertEqual(reg.opaqueTable[id], 0, 'opaqueTable=0（与 short_grass 同）');
  assertEqual(reg.opaqueTable[id], reg.opaqueTable[reg.idOf('short_grass')], '与 short_grass 逐位相同');
  assertEqual(reg.solidTable[id], 0, '非实心');
  assertEqual(reg.castsShadow(id), false, '不投影');
});

test('bush_grass 的贴图映射指向着色产物', () => {
  assertEqual(FACES_DATA.bush_grass, 'procedural/bush_grass', 'faces-data 映射');
});

// ⚠️ **存档兼容性回归（final review 实测出的 Critical）**：
// 方块 id = BLOCKS 数组下标，而 IndexedDB 的 edits 存的是**数字 id**
// （`src/save/persistence.js` 的 `{index,id,meta}`）。在数组**中间**插新方块会把它之后
// 所有方块的 id 整体 +1 ⇒ 旧存档里的方块被静默重新解释成别的方块。
// 本轮第一版把 bush_grass 插在 short_grass 旁（下标 20），影响 **134** 个方块。
// 修法：追加到末尾（与巨树/金字塔/废弃堡垒历次 Epic 同口径）。
test('新方块必须追加在 BLOCKS 末尾（id 不得位移，否则旧存档错乱）', () => {
  // 既有方块的 id 冻结表（**从 HEAD 的 registry 实测取得**，不是猜的）。
  // 这些数字是存档契约，**不得因为新增方块而变**。
  const FROZEN_IDS = {
    'air': 0, 'water': 2, 'short_grass': 19, 'allium': 20, 'azure_bluet': 21,
    'dead_bush': 22, 'red_mushroom': 24, 'stone': 50, 'grass': 69,
    'end_stone_brick_slab': 153,
  };
  for (const [name, id] of Object.entries(FROZEN_IDS)) {
    const at = BLOCKS.findIndex((b) => b.name === name);
    assertEqual(at, id, `${name} 的 id 必须恒为 ${id}（旧存档按数字 id 读）`);
  }
  // 新方块在末尾
  assertEqual(BLOCKS[BLOCKS.length - 1].name, 'bush_grass', 'bush_grass 必须是数组最后一项');
});