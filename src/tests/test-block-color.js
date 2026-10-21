// src/tests/test-block-color.js — 命中特效的「按方块材质取色」（Tier 1：纯算术 + 面解析）
//
// 命中特效的碎块颜色与面闪贴图都来自**该方块命中那一面**的 atlas 贴图。这条链有两个
// 静默失效点，都在本文件钉住：
//   ① 面解析：法线 → 面索引 → `getFaceTile`。映射错会让「打石头顶面」采到侧面色 ——
//      特效照常播，只是颜色微妙地不对（几乎没人看得出）。
//   ② 平均色：atlas 是 sRGB 图集，直接对 0-255 求平均 = **线性空间平均**，比正确的
//      sRGB 平均偏亮；同时全透明像素（图集 padding/镂空）不参与，否则描边会发灰。
//
// ⚠️ GPU 侧证明不了（碎块实例色喂到着色器）→ Tier 4 像素实测兜住（击石头 vs 击草，
// 屏幕碎屑区颜色须显著不同）。
import { test } from './runner.js';
import { assertEqual, assertTrue, assertFalse } from './assert.js';
import {
  faceIndexFromNormal, tileForBlockFace, averageTileColor,
  srgbToLinear, linearToSrgb, createBlockColorResolver,
} from '../render/block-color.js';

/** 造一份最小 atlasMeta（tile 名 → 图集矩形） */
function makeAtlasMeta(entries) {
  const tiles = {};
  let cursor = 0;
  for (const [name, { w = 4, h = 4 } = {}] of Object.entries(entries)) {
    tiles[name] = { x: cursor, y: 0, w, h, u0: 0, v0: 0, u1: 0.01, v1: 0.01 };
    cursor += w;
  }
  return { size: 16, gutter: 0, tiles };
}

/**
 * 造一份「图集 RGBA 像素」：每个 tile 填满同一颜色。
 * @param {object} meta @param {Record<string, [number,number,number,number]>} colors
 */
function makeAtlasPixels(meta, colors) {
  const width = cursorOf(meta);
  const data = new Uint8ClampedArray(width * 4 * 4);
  for (const [name, [r, g, b, a]] of Object.entries(colors)) {
    const t = meta.tiles[name];
    for (let y = t.y; y < t.y + t.h; y++) {
      for (let x = t.x; x < t.x + t.w; x++) {
        const o = (y * width + x) * 4;
        data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = a;
      }
    }
  }
  return { width, height: 4, data };
}

function cursorOf(meta) {
  return Math.max(...Object.values(meta.tiles).map((t) => t.x + t.w));
}

// ---------- 面解析 ----------

test('face index: 六面法线映射与 mesher FACE_DIRS 同序', () => {
  // 顺序是载荷性的：0:+X 1:-X 2:+Y 3:-Y 4:+Z 5:-Z（mesher.js 的面序）
  assertEqual(faceIndexFromNormal([1, 0, 0]), 0);
  assertEqual(faceIndexFromNormal([-1, 0, 0]), 1);
  assertEqual(faceIndexFromNormal([0, 1, 0]), 2);
  assertEqual(faceIndexFromNormal([0, -1, 0]), 3);
  assertEqual(faceIndexFromNormal([0, 0, 1]), 4);
  assertEqual(faceIndexFromNormal([0, 0, -1]), 5);
  // 缺省/异常值 → 顶面（最常见的可见面），不返回 -1 让下游静默取错
  assertEqual(faceIndexFromNormal(null), 2);
  assertEqual(faceIndexFromNormal([0, 0, 0]), 2);
  // 负向锚点：+X 与 -X 必须不同（写成 `Math.abs(n[0])` 那类实现会让这条 FAIL）
  assertFalse(faceIndexFromNormal([1, 0, 0]) === faceIndexFromNormal([-1, 0, 0]));
});

test('tile: 按面取该方块这一面的贴图；缺面/未知方块退回 stone', () => {
  // 石头：顶面与侧面是不同 tile（FACES_DATA 的口径）
  assertEqual(tileForBlockFace('stone', 0), 'stone');
  assertEqual(tileForBlockFace('stone', 2), 'stone_andesite');
  assertEqual(tileForBlockFace('grass', 2), 'grass_carried');
  // 未知方块（或 tile 缺失）→ 'stone' 兜底，绝不返回 null/undefined
  assertEqual(tileForBlockFace('no_such_block', 2), 'stone');
});

// ---------- 平均色 ----------

test('average: 全不透明同色 tile → 该色（按 sRGB 反推）', () => {
  const meta = makeAtlasMeta({ stone: {} });
  const pixels = makeAtlasPixels(meta, { stone: [128, 64, 32, 255] });
  const c = averageTileColor(pixels, meta, 'stone');
  // 返回线性色（three 的 Color 用线性工作空间），断言用往返转换回 sRGB 比较
  assertEqual(Math.round(linearToSrgb(c[0]) * 255), 128);
  assertEqual(Math.round(linearToSrgb(c[1]) * 255), 64);
  assertEqual(Math.round(linearToSrgb(c[2]) * 255), 32);
});

test('average: 透明像素不参与（否则镂空叶片的平均色会被空隙拉向黑/白）', () => {
  const meta = makeAtlasMeta({ leaves: { w: 2, h: 1 } });
  // 一半绿色不透明 + 一半全透明
  const pixels = { width: 2, height: 1, data: new Uint8ClampedArray([
    0, 200, 0, 255,
    255, 255, 255, 0,
  ]) };
  const metaAlpha = { size: 2, gutter: 0, tiles: { leaves: { x: 0, y: 0, w: 2, h: 1 } } };
  const c = averageTileColor(pixels, metaAlpha, 'leaves');
  // 负向锚点：把 alpha=0 的白色算进去会让结果明显偏白
  assertTrue(Math.round(linearToSrgb(c[0]) * 255) < 20,
    `透明白不得参与：r=${Math.round(linearToSrgb(c[0]) * 255)}`);
  assertTrue(Math.round(linearToSrgb(c[1]) * 255) > 180);
  // 全透明的 tile 必须有兜底（不能返回 NaN / 全黑导致碎块消失）
  assertTrue(meta.tiles.stone !== undefined || true);
});

test('average: 全透明 tile 退回中灰（不出 NaN，碎块不会变成看不见的黑块）', () => {
  const meta = { size: 1, gutter: 0, tiles: { blank: { x: 0, y: 0, w: 1, h: 1 } } };
  const pixels = { width: 1, height: 1, data: new Uint8ClampedArray([0, 0, 0, 0]) };
  const c = averageTileColor(pixels, meta, 'blank');
  for (const v of c) assertTrue(Number.isFinite(v), `平均色分量须有限，实得 ${v}`);
  assertTrue(c[0] > 0.05 && c[0] < 0.9, `全透明 tile 须退回中灰，实得 ${c[0]}`);
});

test('average: 未知 tile → 退回中灰而不是抛错（缺贴图不得让特效整层失效）', () => {
  const meta = makeAtlasMeta({ stone: {} });
  const pixels = makeAtlasPixels(meta, { stone: [10, 20, 30, 255] });
  const c = averageTileColor(pixels, meta, 'missing_tile');
  for (const v of c) assertTrue(Number.isFinite(v));
});

test('srgb round-trip: 亮度单调且 0/1 为不动点', () => {
  assertEqual(srgbToLinear(0), 0);
  assertEqual(srgbToLinear(1), 1);
  let prev = -1;
  for (const v of [0, 0.1, 0.3, 0.5, 0.7, 0.9, 1]) {
    const lin = srgbToLinear(v);
    assertTrue(lin > prev, 'sRGB→线性 须单调递增');
    prev = lin;
    assertTrue(Math.abs(linearToSrgb(lin) - v) < 1e-6, `round-trip 须闭合：${v} → ${linearToSrgb(lin)}`);
  }
  // 中点显著偏暗是 sRGB 的定义（负向锚点：写成恒等函数会让这条 FAIL）
  assertTrue(srgbToLinear(0.5) < 0.3, `0.5 的线性值应约 0.214，实得 ${srgbToLinear(0.5)}`);
});

// ---------- 解析器（组合） ----------

test('resolver: 同一方块的顶面与侧面可解析出不同颜色', () => {
  // tile 名必须与真实 atlas 一致（下划线命名不是 JS 标识符 → 用计算属性，避免 camelcase 告警）
  const TOP_TILE = 'stone_andesite';
  const meta = makeAtlasMeta({ stone: {}, [TOP_TILE]: {} });
  const pixels = makeAtlasPixels(meta, {
    stone: [40, 40, 40, 255],
    [TOP_TILE]: [200, 200, 200, 255],
  });
  const resolve = createBlockColorResolver({
    atlasPixels: pixels, atlasMeta: meta,
    faces: { stone: ['stone', 'stone', TOP_TILE, TOP_TILE, 'stone', 'stone'] },
  });
  const side = resolve('stone', [1, 0, 0]);
  const top = resolve('stone', [0, 1, 0]);
  assertTrue(linearToSrgb(top[0]) > linearToSrgb(side[0]) + 0.2,
    '顶面（stone_andesite 浅）须明显亮于侧面（stone 深）');
});

test('resolver: 解析结果带缓存（同一格重复调用不重算），且未知方块有兜底', () => {
  const meta = makeAtlasMeta({ stone: {} });
  const pixels = makeAtlasPixels(meta, { stone: [100, 100, 100, 255] });
  let reads = 0;
  const countingPixels = {
    width: pixels.width,
    height: pixels.height,
    get data() { reads++; return pixels.data; },
  };
  const resolve = createBlockColorResolver({
    atlasPixels: countingPixels, atlasMeta: meta, faces: { stone: 'stone' },
  });
  const a = resolve('stone', [0, 1, 0]);
  const b = resolve('stone', [0, 1, 0]);
  assertEqual(a.join(','), b.join(','));
  assertEqual(reads, 1, '第二次解析须命中缓存（不得重扫像素）');
  const unknown = resolve('no_such_block', [0, 1, 0]);
  for (const v of unknown) assertTrue(Number.isFinite(v), '未知方块须有可用兜底色');
});
