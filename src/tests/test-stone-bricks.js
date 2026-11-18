// src/tests/test-stone-bricks.js — 原版石砖 + 紫珀方块（v3.19）
//
// 用户 2026-11-19：「除了台阶方块之外，其他的方块都用原版里提供的方块重新烘焙出来，
// 并加到背包里」+「末日地堡里的 deepslate 方块都替换成紫色方块 Purpur Block……
// 面用的图是 /Users/bachi/ttt/b/purpur_block.png，六个面都用这个图」。
//
// 本文件两段：
//   ① 烘焙纯函数（`tools/stone-bricks-parse.mjs`）—— 喂**合成小图**，不读真实素材
//      （浏览器无 pngjs、Node 无 canvas，两侧都拿不到真实 PNG 的像素；真实素材的判据
//       落在 node 烘焙器自检与 `check:data` 的 `[石砖贴图]`，Tier 2）。
//   ② 4 个新方块的声明 / 贴图映射 / 进背包 / **id 追加不位移**。
//
// ⚠️ 判据设计的两条教训（本仓既有）：
//   · 「色数不变」对图案打乱零判别力 ⇒ 用 `patternSignature` 逐格比分区；
//   · 「均值接近」对取样相位错一格几乎不敏感 ⇒ 用众数一致性（函数内 throw）。
import { test } from './runner.js';
import { assertEqual, assertTrue, assertDeepEqual, assertThrows, assertNotNull } from './assert.js';
import {
  TOP_FACE_GEOM, topFaceColorMap, remapPalette, downsampleByTexelCenter,
  patternSignature, meanRgb,
} from '../../tools/stone-bricks-parse.mjs';
import { BLOCKS } from '../voxel/blocks-data.js';
import { FACES_DATA, getFaceTile } from '../voxel/faces-data.js';
import { createRegistry } from '../voxel/block-registry.js';
import { buildItemNames, NON_PLACEABLE_ITEMS, HIDDEN_FROM_INVENTORY } from '../player/inventory.js';

/** 造一张 w×h 的图（每格给 [r,g,b,a]） */
function img(w, h, cells) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const c = cells[i];
    data[i * 4] = c[0]; data[i * 4 + 1] = c[1]; data[i * 4 + 2] = c[2];
    data[i * 4 + 3] = c[3] === undefined ? 255 : c[3];
  }
  return { width: w, height: h, data };
}

/** 把 16×16 的 tex 图铺成「等轴测顶面」渲染图（只填顶面，其余留黑） */
function renderTopFace(tex, geom = TOP_FACE_GEOM, size = 300) {
  const out = img(size, size, new Array(size * size).fill([0, 0, 0, 0]));
  const { tv, rv, lv } = geom;
  const n = tex.width;
  // 逐渲染像素反查它落在哪个 texel（逆变换），保证与正向取样一致
  const ax = (rv[0] - tv[0]) / n, ay = (rv[1] - tv[1]) / n;
  const bx = (lv[0] - tv[0]) / n, by = (lv[1] - tv[1]) / n;
  const det = ax * by - ay * bx;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x - tv[0], py = y - tv[1];
      const u = (px * by - py * bx) / det;
      const v = (ax * py - ay * px) / det;
      if (u < 0 || v < 0 || u >= n || v >= n) continue;
      const si = (Math.floor(v) * n + Math.floor(u)) * 4;
      const di = (y * size + x) * 4;
      out.data[di] = tex.data[si]; out.data[di + 1] = tex.data[si + 1];
      out.data[di + 2] = tex.data[si + 2]; out.data[di + 3] = 255;
    }
  }
  return out;
}

// ==================== ① 烘焙纯函数 ====================

test('stone-bricks: TOP_FACE_GEOM 是实测标定的三顶点（不是「看着对」的坐标）', () => {
  assertDeepEqual([...TOP_FACE_GEOM.tv], [148, 0], '上顶点');
  assertDeepEqual([...TOP_FACE_GEOM.rv], [282, 66], '右顶点');
  assertDeepEqual([...TOP_FACE_GEOM.lv], [14, 66], '左顶点');
});

test('stone-bricks: topFaceColorMap 从渲染图顶面反解逐色映射', () => {
  // 2×2 源图，四格四色
  const tex = img(2, 2, [[10, 20, 30], [40, 50, 60], [70, 80, 90], [100, 110, 120]]);
  const geom = { tv: [8, 0], rv: [16, 4], lv: [0, 4] };
  // 渲染图 = 顶面铺 tex 后整体 +5（模拟「只差一层配色」）
  const shifted = img(2, 2, [...tex.data].reduce((acc, _, i) => {
    if (i % 4 === 0) acc.push([tex.data[i] + 5, tex.data[i + 1] + 5, tex.data[i + 2] + 5]);
    return acc;
  }, []));
  const render = renderTopFace(shifted, geom, 20);
  const map = topFaceColorMap(render, tex, geom);
  assertEqual(map.size, 4, '四种源色各一条映射');
  assertEqual(map.get('10,20,30'), '15,25,35', '第一色 +5');
  assertEqual(map.get('100,110,120'), '105,115,125', '第四色 +5');
});

test('stone-bricks: topFaceColorMap 在「同一源色映到多个渲染色」时 throw（图案不一致的判据）', () => {
  const tex = img(2, 2, [[10, 20, 30], [10, 20, 30], [70, 80, 90], [70, 80, 90]]);
  // 渲染图里两个「同色」texel 给了不同颜色 ⇒ 图案不一致
  const bad = img(2, 2, [[15, 25, 35], [99, 99, 99], [75, 85, 95], [75, 85, 95]]);
  const geom = { tv: [8, 0], rv: [16, 4], lv: [0, 4] };
  const render = renderTopFace(bad, geom, 20);
  const err = assertThrows(() => topFaceColorMap(render, tex, geom), '映到');
  assertTrue(String(err.message).includes('10,20,30'), '报错要点名冲突的源色');
});

test('stone-bricks: topFaceColorMap 取样越界时 throw（几何标定错了不许静默）', () => {
  const tex = img(2, 2, [[1, 2, 3], [4, 5, 6], [7, 8, 9], [10, 11, 12]]);
  const render = img(4, 4, new Array(16).fill([0, 0, 0]));
  assertThrows(() => topFaceColorMap(render, tex, { tv: [8, 0], rv: [16, 4], lv: [0, 4] }), '越界');
});

test('stone-bricks: remapPalette 只改色值，图案分区逐格不变', () => {
  const tex = img(2, 2, [[10, 20, 30], [40, 50, 60], [10, 20, 30], [70, 80, 90]]);
  const map = new Map([['10,20,30', '11,21,31'], ['40,50,60', '41,51,61'], ['70,80,90', '71,81,91']]);
  const out = remapPalette(tex, map);
  assertDeepEqual(patternSignature(out), patternSignature(tex), '图案分区逐格一致');
  assertDeepEqual([...out.data.slice(0, 4)], [11, 21, 31, 255], '首格换色');
  // 色数不变但图案被打乱的情形必须被抓到（负向：只比色数会放行）
  const shuffled = img(2, 2, [[11, 21, 31], [11, 21, 31], [41, 51, 61], [71, 81, 91]]);
  assertTrue(JSON.stringify(patternSignature(shuffled)) !== JSON.stringify(patternSignature(tex)),
    '打乱后分区签名必须不同（证明该判据有判别力）');
});

test('stone-bricks: remapPalette 保留 alpha、不改入参、映射外颜色 throw', () => {
  const tex = img(1, 2, [[10, 20, 30, 128], [40, 50, 60, 0]]);
  const before = [...tex.data];
  const out = remapPalette(tex, new Map([['10,20,30', '1,2,3'], ['40,50,60', '4,5,6']]));
  assertEqual(out.data[3], 128, '半透明 alpha 原样');
  assertEqual(out.data[7], 0, '全透明 alpha 原样');
  assertDeepEqual([...tex.data], before, '入参未被改写');
  assertTrue(out.data !== tex.data, '必须是新缓冲');
  assertThrows(() => remapPalette(tex, new Map([['10,20,30', '1,2,3']])), '映射表外的颜色');
});

/** 造一张「N×N texel 放大图」：每 texel 一个 step×step 纯色块，边缘留透明 */
function magnify(cells, size, step, origin) {
  const span = size * step;
  const side = origin * 2 + span;
  const out = img(side, side, new Array(side * side).fill([0, 0, 0, 0]));
  for (let ty = 0; ty < size; ty++) {
    for (let tx = 0; tx < size; tx++) {
      const c = cells[ty * size + tx];
      for (let y = 0; y < step; y++) {
        for (let x = 0; x < step; x++) {
          const di = ((origin + ty * step + y) * side + origin + tx * step + x) * 4;
          out.data[di] = c[0]; out.data[di + 1] = c[1]; out.data[di + 2] = c[2]; out.data[di + 3] = 255;
        }
      }
    }
  }
  return out;
}

test('stone-bricks: downsampleByTexelCenter 无损还原放大图（含 alpha 归 255）', () => {
  const cells = [[159, 134, 159], [115, 80, 115], [137, 98, 137], [148, 119, 148]];
  const src = magnify(cells, 2, 8, 3);
  const out = downsampleByTexelCenter(src, { origin: 3, span: 16, size: 2 });
  assertEqual(out.width, 2, '宽');
  assertEqual(out.height, 2, '高');
  assertDeepEqual([...out.data], [159, 134, 159, 255, 115, 80, 115, 255, 137, 98, 137, 255, 148, 119, 148, 255],
    '逐格还原 + alpha 全 255');
});

test('stone-bricks: downsampleByTexelCenter 在 origin 错半格时 throw（相位判据有判别力）', () => {
  const cells = [[159, 134, 159], [115, 80, 115], [137, 98, 137], [148, 119, 148]];
  // ⚠️ **错整一格抓不到**（实测）：step=8 时 origin+4 仍是每个 texel 的正中心，
  //    分区边界跟着平移 ⇒ 中心色与众数仍一致。真实源图的 step 是 **28.875（非整数）**，
  //    相位漂移半格就会让中心落进邻格 ⇒ 这里用 step=7（奇数）造半格漂移。
  const odd = magnify(cells, 2, 7, 3);
  assertThrows(() => downsampleByTexelCenter(odd, { origin: 6, span: 14, size: 2 }), '众数');
  // 正确相位下同一张图必须通过（证明上一条不是恒 throw）
  const ok = downsampleByTexelCenter(odd, { origin: 3, span: 14, size: 2 });
  assertDeepEqual([...ok.data.slice(0, 4)], [159, 134, 159, 255], '正确相位仍还原');
});

test('stone-bricks: downsampleByTexelCenter 中心落在透明像素时 throw', () => {
  const src = img(8, 8, new Array(64).fill([0, 0, 0, 0]));
  assertThrows(() => downsampleByTexelCenter(src, { origin: 0, span: 8, size: 2 }), '全不透明');
});

test('stone-bricks: meanRgb 只算不透明像素（与草贴图门禁同口径）', () => {
  const src = img(2, 1, [[100, 100, 100, 255], [0, 0, 0, 0]]);
  assertDeepEqual(meanRgb(src), [100, 100, 100], '全透明格不参与均值');
});

// ==================== ② 4 个新方块 ====================

/** 本期新增的 4 个方块（声明侧权威 = blocks-data.js，此处是契约清单） */
const NEW_BLOCKS = ['mossy_stone_bricks', 'cracked_stone_bricks', 'chiseled_stone_bricks', 'purpur_block'];

function makeRegistry() {
  const reg = createRegistry();
  for (const def of BLOCKS) reg.register(def.name, def);
  reg.freeze();
  return reg;
}

test('stone-bricks: 4 个新方块全部已注册，且与 stone 逐项同口径（box + opaque + 不旋转）', () => {
  const reg = makeRegistry();
  const stone = BLOCKS.find((b) => b.name === 'stone');
  for (const name of NEW_BLOCKS) {
    const def = BLOCKS.find((b) => b.name === name);
    assertNotNull(def, `${name} 必须在 blocks-data.js 里声明`);
    for (const key of ['solid', 'cullMode', 'orientationModes', 'geometry']) {
      assertEqual(def[key], stone[key], `${name} 的 ${key} 与 stone 一致`);
    }
    const id = reg.idOf(name);
    assertEqual(reg.solidTable[id], 1, `${name} 实心`);
    assertEqual(reg.opaqueTable[id], 1, `${name} opaqueTable=1（实心整块，参与面剔除/AO/LOS）`);
    assertEqual(reg.cullTable[id], 0, `${name} 走 opaque 通道`);
    assertEqual(reg.hollowOccluderTable[id], 0, `${name} 不是镂空遮挡体`);
    assertEqual(reg.castsShadow(id), true, `${name} 投影（建筑主体）`);
  }
});

test('stone-bricks: 4 个新方块的 faces-data 都是单 tile（purpur 六面同图 = 用户明确要求）', () => {
  for (const name of NEW_BLOCKS) {
    const entry = FACES_DATA[name];
    assertEqual(typeof entry, 'string', `${name} 用单 tile 字符串（六面同图）`);
    assertEqual(entry, name, `${name} 的 tile 名与方块同名`);
    for (let f = 0; f < 6; f++) {
      assertEqual(getFaceTile(name, f), name, `${name} 面 ${f} 都是同一张图`);
    }
  }
});

test('stone-bricks: 4 个新方块都在背包物品集合内（用户明确要求）', () => {
  const items = buildItemNames(makeRegistry());
  for (const name of NEW_BLOCKS) {
    assertTrue(items.includes(name), `${name} 必须在背包里`);
    assertTrue(!NON_PLACEABLE_ITEMS.includes(name), `${name} 不得进 NON_PLACEABLE_ITEMS`);
    assertTrue(!HIDDEN_FROM_INVENTORY.includes(name), `${name} 不得进 HIDDEN_FROM_INVENTORY`);
  }
});

test('stone-bricks: 新方块追加在 BLOCKS 末尾，既有 155 个 id 逐位不变（旧存档按数字 id 读）', () => {
  // 既有方块 id 冻结表（与 test-bush-grass.js / test-block-registry.js 同口径）
  const FROZEN_IDS = {
    'air': 0, 'water': 2, 'short_grass': 19, 'stone': 50, 'grass': 69, 'deepslate': 86,
    'end_stone_brick_slab': 153, 'bush_grass': 154,
  };
  for (const [name, id] of Object.entries(FROZEN_IDS)) {
    assertEqual(BLOCKS.findIndex((b) => b.name === name), id, `${name} 的 id 必须恒为 ${id}`);
  }
  assertEqual(BLOCKS.length, 159, '155 既有 + 4 新增');
  assertDeepEqual(BLOCKS.slice(155).map((b) => b.name), NEW_BLOCKS, '新增 4 项按序追加在末尾');
});