// 等轴测投影图标纯函数单测（§4.5.4 v1.24）
// 形状权威 = mesher.js 的 TEMPLATES（红线 1：图标不得有第二份几何定义）。
// 本文件只测投影与明暗的**几何正确性**；图标 PNG 的像素断言在 Playwright spec 里做
// （浏览器内 canvas 读像素，单测环境无 atlas.png）。
import { test } from './runner.js';
import { assertEqual, assertTrue, assertFalse } from './assert.js';
import { TEMPLATES } from '../mesh/mesher.js';
import {
  ISO_SHADE, projectIso, isoPolygons, isoBBox, renderIsoIcon,
} from '../mesh/iso-icon.js';

// --- 投影公式（2:1 等轴测） ---

test('iso-icon: projectIso 公式 sx=x-z, sy=(x+z)/2-y', () => {
  assertEqual(projectIso(1, 0, 0)[0], 1); // sx = 1-0
  assertEqual(projectIso(1, 0, 0)[1], 0.5); // sy = (1+0)/2 - 0
  assertEqual(projectIso(0, 1, 0)[0], 0);
  assertEqual(projectIso(0, 1, 0)[1], -1); // 抬高 1 格 → sy 减 1（屏幕上方）
  assertEqual(projectIso(0, 0, 1)[0], -1); // +Z 向左
  assertEqual(projectIso(0, 0, 1)[1], 0.5);
});

// --- 可见面筛选（只取朝向观察者的 +X/+Y/+Z） ---

test('iso-icon: isoPolygons 只取 +X(0)/+Y(2)/+Z(4) 三面', () => {
  const polys = isoPolygons(TEMPLATES.vertical_pillar);
  const faces = new Set(polys.map((p) => p.face));
  assertEqual(polys.length, 3, '竖柱 3 个可见面');
  assertTrue(faces.has(0) && faces.has(2) && faces.has(4), '含 +X/+Y/+Z');
  assertFalse(faces.has(1) || faces.has(3) || faces.has(5), '不含 -X/-Y/-Z（背向观察者）');
});

// --- 形状辨识度：竖柱 vs 横梁的投影包围盒宽高比相反 ---

/**
 * 回归防线：竖柱与横梁几何形状相反（`boxQuads(0.35,0,0.35,0.65,1,0.65)` vs
 * `boxQuads(0,0.35,0.35,1,0.65,0.65)`），投影后必须一个竖长一个横扁。
 * 若有人把两者几何写反、或图标烘焙漏了其中一个，本断言会抓到。
 * 实测投影包围盒：竖柱 sx∈[-0.30,0.30] 宽 0.60 / sy∈[-0.65,0.65] 高 1.30 → 比值 0.46；
 * 横梁 sx∈[-0.65,0.65] 宽 1.30 / sy∈[-0.475,0.475] 高 0.95 → 比值 1.37。
 */
test('iso-icon: 竖柱投影竖长、横梁投影横扁（宽高比相反）', () => {
  const v = isoBBox(isoPolygons(TEMPLATES.vertical_pillar));
  const h = isoBBox(isoPolygons(TEMPLATES.horizontal_pillar));
  const vr = (v.maxX - v.minX) / (v.maxY - v.minY);
  const hr = (h.maxX - h.minX) / (h.maxY - h.minY);
  assertTrue(vr < 1, `竖柱宽高比 ${vr.toFixed(3)} < 1（竖长）`);
  assertTrue(hr > 1, `横梁宽高比 ${hr.toFixed(3)} > 1（横扁）`);
  assertTrue(hr / vr > 2, `两者比值相差 ${(hr / vr).toFixed(2)} 倍 > 2（一眼可分）`);
});

// --- 台阶阶梯轮廓：正置底宽顶窄、倒置顶宽底窄 ---

/**
 * 回归防线：`STEP_QUADS`（下半全幅 + 左上 1/4 柱）投影后**底部宽、顶部窄**；
 * `STEP_UPDOWN_QUADS`（上半全幅 + 右下 1/4 柱）投影后**顶部宽、底部窄**。
 * 这是「正置/倒置图标必须不同」的几何依据（图标撞脸 = 丢失辨识度）。
 *
 * **测量口径 = 图标行剖面**（每行不透明像素数），不是投影顶点坐标——等轴测下
 * sy 极值点是单个顶点（前下角）而非有宽度的行，用顶点测量会恒得 0。行剖面正是
 * 图标真实轮廓（与 v1.23 台阶图标验证用的同一判据）。
 * 实测（64px）：正置上部均宽 25.5 / 下部 29.0；倒置上部 29.0 / 下部 25.5；
 * `vertical_pillar` 上下同为 21.0（对称柱体，作对照组）。
 */
test('iso-icon: 正置台阶底宽顶窄、倒置台阶顶宽底窄（行剖面）', () => {
  const SIZE = 64;
  const sample = () => [100, 100, 100];
  // 每行不透明像素数 + 取首/尾各 25% 行的均宽
  const profile = (quads) => {
    const d = renderIsoIcon(quads, SIZE, sample);
    const rows = [];
    for (let y = 0; y < SIZE; y++) {
      let n = 0;
      for (let x = 0; x < SIZE; x++) if (d[(y * SIZE + x) * 4 + 3] > 0) n++;
      rows.push(n);
    }
    const first = rows.findIndex((r) => r > 0);
    const last = SIZE - 1 - [...rows].reverse().findIndex((r) => r > 0);
    const q = Math.max(1, Math.round((last - first) * 0.25));
    const avg = (a) => a.reduce((s, v) => s + v, 0) / a.length;
    return { upper: avg(rows.slice(first, first + q)), lower: avg(rows.slice(last - q + 1, last + 1)) };
  };
  const up = profile(TEMPLATES.planks_step);
  const down = profile(TEMPLATES.cobblestone_step_updown);
  const pillar = profile(TEMPLATES.vertical_pillar);
  assertTrue(up.lower > up.upper,
    `正置台阶下部 ${up.lower.toFixed(1)} > 上部 ${up.upper.toFixed(1)}（底宽顶窄）`);
  assertTrue(down.upper > down.lower,
    `倒置台阶上部 ${down.upper.toFixed(1)} > 下部 ${down.lower.toFixed(1)}（顶宽底窄）`);
  // 对照组：竖柱上下对称（柱体），若台阶断言失效时本条仍通过 → 说明判据本身有效
  assertTrue(Math.abs(pillar.upper - pillar.lower) < 0.5,
    `竖柱上下对称 ${pillar.upper.toFixed(1)} ≈ ${pillar.lower.toFixed(1)}（对照组）`);
});

// --- 三面明暗 ---

test('iso-icon: ISO_SHADE 三面系数（顶面 1.0 / +X 0.75 / +Z 0.55）', () => {
  assertEqual(ISO_SHADE[2], 1.0); // +Y 顶面最亮
  assertEqual(ISO_SHADE[0], 0.75); // +X 中间
  assertEqual(ISO_SHADE[4], 0.55); // +Z 最暗
  assertTrue(ISO_SHADE[2] > ISO_SHADE[0] && ISO_SHADE[0] > ISO_SHADE[4], '单调递减（立体感）');
});

test('iso-icon: 渲染输出按三面分层（同色贴图下有 3 种亮度）', () => {
  // 采样回调恒返回 [100,100,100] → 输出应恰好是 100 / 75 / 55 三种亮度
  const data = renderIsoIcon(TEMPLATES.vertical_pillar, 32, () => [100, 100, 100]);
  const lum = new Set();
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] > 0) lum.add(data[i]); // R 通道即亮度（灰输入）
  }
  assertEqual(lum.size, 3, `三种亮度（实测 ${[...lum].sort((a, b) => a - b).join('/')}）`);
  assertTrue(lum.has(100) && lum.has(75) && lum.has(55), '亮度 = 100/75/55');
});

// --- 透明背景（异形方块不铺满正方形） ---

test('iso-icon: 异形方块图标有透明背景（不铺满正方形）', () => {
  const data = renderIsoIcon(TEMPLATES.vertical_pillar, 32, () => [100, 100, 100]);
  let transparent = 0, opaque = 0;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] === 0) transparent++; else opaque++;
  }
  assertEqual(data.length, 32 * 32 * 4, 'RGBA 缓冲尺寸');
  assertTrue(transparent > 0, `有透明像素（${transparent} 个）`);
  assertTrue(opaque / (32 * 32) > 0.2, `不透明占比 ${(opaque / 1024 * 100).toFixed(1)}% > 20%`);
  assertTrue(opaque / (32 * 32) < 0.9, `不透明占比 < 90%（未铺满 = 轮廓可见）`);
});

test('iso-icon: 栏杆图标含把手轮廓（不透明占比高于竖柱）', () => {
  const sample = () => [100, 100, 100];
  const count = (quads) => {
    const d = renderIsoIcon(quads, 32, sample);
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
    return n;
  };
  const pillar = count(TEMPLATES.vertical_pillar);
  const rail = count(TEMPLATES.handrail); // 中柱 + 东/北把手 → 覆盖更大
  assertTrue(rail > pillar, `handrail ${rail}px > vertical_pillar ${pillar}px（把手额外覆盖）`);
});

// --- 烘焙产物（tools/bake-isometric-icons.mjs → assets/textures/inventory-icons/） ---

/**
 * 覆盖范围冻结：9 项异形方块（§4.5.4 v1.24）。
 * 勿擅自扩大——`cactus`/`vine`/`lilypad`/`hanging_lamp`/`flower` 系保持平面贴图现状
 * （用户明确指定的范围）；`chimney`/床三项不在背包内；`mine_cart` 是实体无几何模板。
 */
const ICON_BLOCKS = [
  'handrail', 'handrailA', 'handrailB',
  'vertical_pillar', 'horizontal_pillar',
  'planks_step', 'cobblestone_step', 'cobblestone_step_updown', 'stone_diorite_step',
];

test('iso-icon: 烘焙产物覆盖 9 项异形方块（范围冻结）', async () => {
  for (const name of ICON_BLOCKS) {
    const res = await fetch(`/assets/textures/inventory-icons/${name}.png`);
    assertEqual(res.status, 200, `${name}.png 存在（未跑 npm run icons？）`);
  }
});

/**
 * 烘焙产物必须是 64×64 **透明背景**（异形方块不铺满正方形 → 轮廓可见）。
 * 用 canvas 解码 PNG 读像素——单测环境无 pngjs，浏览器有 createImageBitmap。
 */
test('iso-icon: 烘焙产物 64×64 且有透明背景（不铺满正方形）', async () => {
  for (const name of ICON_BLOCKS) {
    const blob = await (await fetch(`/assets/textures/inventory-icons/${name}.png`)).blob();
    const bmp = await createImageBitmap(blob);
    assertEqual(bmp.width, 64, `${name} 宽 64`);
    assertEqual(bmp.height, 64, `${name} 高 64`);
    const cv = document.createElement('canvas');
    cv.width = 64; cv.height = 64;
    cv.getContext('2d').drawImage(bmp, 0, 0);
    const d = cv.getContext('2d').getImageData(0, 0, 64, 64).data;
    let transparent = 0, opaque = 0;
    for (let i = 3; i < d.length; i += 4) { if (d[i] === 0) transparent++; else opaque++; }
    assertTrue(transparent > 0, `${name} 有透明像素（${transparent} 个）`);
    assertTrue(opaque / 4096 > 0.2, `${name} 不透明占比 ${(opaque / 4096 * 100).toFixed(1)}% > 20%`);
    assertTrue(opaque / 4096 < 0.9, `${name} 不透明占比 < 90%（轮廓可见）`);
  }
});

/**
 * 回归防线：**竖柱与横梁的图标像素形状必须不同**。两者几何形状相反
 * （`boxQuads(0.35,0,0.35,0.65,1,0.65)` 竖长 vs `boxQuads(0,0.35,0.35,1,0.65,0.65)` 横扁），
 * 图标撞脸 = 丢失辨识度（正是本次要修的 bug）。
 *
 * 判据 = 行剖面宽高比（与 v1.23 台阶图标验证同一口径）：竖柱图标「高 > 宽」、
 * 横梁图标「宽 > 高」。若烘焙脚本漏了某个方块、或几何被写反，本断言会抓到。
 */
test('iso-icon: 竖柱图标竖长、横梁图标横扁（烘焙产物形状不同）', async () => {
  const bbox = async (name) => {
    const bmp = await createImageBitmap(
      await (await fetch(`/assets/textures/inventory-icons/${name}.png`)).blob());
    const cv = document.createElement('canvas');
    cv.width = 64; cv.height = 64;
    const ctx = cv.getContext('2d');
    ctx.drawImage(bmp, 0, 0);
    const d = ctx.getImageData(0, 0, 64, 64).data;
    let minX = 64, maxX = -1, minY = 64, maxY = -1;
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 64; x++) {
        if (d[(y * 64 + x) * 4 + 3] > 0) {
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
      }
    }
    return { w: maxX - minX + 1, h: maxY - minY + 1 };
  };
  const v = await bbox('vertical_pillar');
  const h = await bbox('horizontal_pillar');
  assertTrue(v.h > v.w, `竖柱 ${v.w}×${v.h} 高 > 宽（竖长）`);
  assertTrue(h.w > h.h, `横梁 ${h.w}×${h.h} 宽 > 高（横扁）`);
});

/**
 * 回归防线：**正置/倒置台阶的图标像素必须不同**（几何形状相反，撞脸 = 丢失辨识度）。
 * 判据同 v1.23 台阶图标验证：正置底宽顶窄、倒置顶宽底窄。
 */
test('iso-icon: 正置/倒置台阶图标形状不同（烘焙产物）', async () => {
  const profile = async (name) => {
    const bmp = await createImageBitmap(
      await (await fetch(`/assets/textures/inventory-icons/${name}.png`)).blob());
    const cv = document.createElement('canvas');
    cv.width = 64; cv.height = 64;
    const ctx = cv.getContext('2d');
    ctx.drawImage(bmp, 0, 0);
    const d = ctx.getImageData(0, 0, 64, 64).data;
    const rows = [];
    for (let y = 0; y < 64; y++) {
      let n = 0;
      for (let x = 0; x < 64; x++) if (d[(y * 64 + x) * 4 + 3] > 0) n++;
      rows.push(n);
    }
    const first = rows.findIndex((r) => r > 0);
    const last = 63 - [...rows].reverse().findIndex((r) => r > 0);
    const q = Math.max(1, Math.round((last - first) * 0.25));
    const avg = (a) => a.reduce((s, v) => s + v, 0) / a.length;
    return { upper: avg(rows.slice(first, first + q)), lower: avg(rows.slice(last - q + 1, last + 1)) };
  };
  const up = await profile('planks_step');
  const down = await profile('cobblestone_step_updown');
  assertTrue(up.lower > up.upper,
    `正置台阶下部 ${up.lower.toFixed(1)} > 上部 ${up.upper.toFixed(1)}`);
  assertTrue(down.upper > down.lower,
    `倒置台阶上部 ${down.upper.toFixed(1)} > 下部 ${down.lower.toFixed(1)}`);
});

/**
 * 回归防线：图标必须有**三面明暗分层**（立体感来源）。
 * 采样的贴图本身近乎纯色（`procedural/handrail` 仅 2 种颜色），故若 shade 失效
 * 图标会退化成单色块 = 立体感丢失。`procedural/pillar` 有 38 种木纹噪点色，
 * 叠加三面明暗后色数应显著多于贴图自身。
 */
test('iso-icon: 柱子图标有三面明暗分层（色数 > 贴图自身）', async () => {
  const bmp = await createImageBitmap(
    await (await fetch('/assets/textures/inventory-icons/vertical_pillar.png')).blob());
  const cv = document.createElement('canvas');
  cv.width = 64; cv.height = 64;
  const ctx = cv.getContext('2d');
  ctx.drawImage(bmp, 0, 0);
  const d = ctx.getImageData(0, 0, 64, 64).data;
  const colors = new Set();
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] > 0) colors.add(`${d[i]},${d[i + 1]},${d[i + 2]}`);
  }
  // procedural/pillar 贴图自身 38 种颜色；×3 面明暗 → 应显著多于 38
  assertTrue(colors.size > 38, `图标色数 ${colors.size} > 贴图自身 38（三面明暗生效）`);
  // 且必须至少有 3 种明显不同的亮度档（顶/侧/侧），排除「全是同一面」的退化
  const lums = [...colors].map((c) => parseInt(c.split(',')[0], 10)).sort((a, b) => a - b);
  assertTrue(lums[lums.length - 1] - lums[0] > 40,
    `亮度跨度 ${lums[0]}~${lums[lums.length - 1]} > 40（三面有明暗差）`);
});
