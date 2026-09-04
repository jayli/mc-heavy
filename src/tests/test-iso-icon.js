// 等轴测投影图标纯函数单测（§4.5.4 v1.24）
// 形状权威 = mesher.js 的 TEMPLATES（红线 1：图标不得有第二份几何定义）。
// 本文件只测投影与明暗的**几何正确性**；图标 PNG 的像素断言在 Playwright spec 里做
// （浏览器内 canvas 读像素，单测环境无 atlas.png）。
import { test } from './runner.js';
import { assertEqual, assertTrue, assertFalse } from './assert.js';
// FACE_VERTICES/FACE_UVS 是形状与 UV 的**唯一权威**（v1.26 导出）——单测逐顶点比对
// cubeQuads 是否与之一致，防止 iso-icon.js 出现第二份立方体/UV 定义（红线 1）。
import { TEMPLATES, FACE_VERTICES, FACE_UVS } from '../mesh/mesher.js';
import {
  ISO_SHADE, projectIso, isoPolygons, isoBBox, renderIsoIcon, cubeQuads,
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

// --- 烘焙产物（tools/bake-icon-atlas.mjs → assets/icons-atlas.png） ---

/**
 * 这 9 项是 v1.24 起就做等轴测的异形方块（§4.5.4）。v1.26 扩到全量 118 项后，
 * 它们仍是形状断言最有代表性的样本（栏杆/柱子/台阶三类几何各不相同）。
 *
 * **覆盖完整性不在这里断言** —— 那是 `npm run check:data` 的 [3] 图标 manifest 覆盖
 * （背包集合与 manifest 双向一致），语义更强且范围自动跟上，无需在此钉数字。
 */
const ICON_BLOCKS = [
  'handrail', 'handrailA', 'handrailB',
  'vertical_pillar', 'horizontal_pillar',
  'planks_step', 'cobblestone_step', 'cobblestone_step_updown', 'stone_diorite_step',
];

/**
 * v1.26：图标不再是独立 PNG，而是烘进单一 `assets/icons-atlas.png`（按显示尺寸 40px）。
 * 从 atlas 裁出某方块的矩形读像素 —— 坐标取自 icons.json 的 CSS 串（离线预生成）。
 * 尺寸取 hotbar 档（40px，比 inventory 的 32px 大，形状断言分辨率更高）。
 */
let iconMeta = null;
async function iconMetaLoad() {
  if (!iconMeta) iconMeta = await (await fetch('/assets/icons.json')).json();
  return iconMeta;
}
/** 从图标 atlas 裁某方块矩形 → canvas ImageData（size × size RGBA） */
async function iconPixels(name) {
  const meta = await iconMetaLoad();
  const css = meta.hotbar[name];
  const m = css.match(/(-?\d+)px (-?\d+)px \/ /); // background-position: -Xpx -Ypx
  const ox = -+m[1], oy = -+m[2];
  const bmp = await createImageBitmap(
    await (await fetch('/assets/icons-atlas.png')).blob());
  const size = 40; // hotbar 档烘焙尺寸（与 bake-icon-atlas.mjs 的 SIZES.hotbar 一致）
  const cv = document.createElement('canvas');
  cv.width = size; cv.height = size;
  const ctx = cv.getContext('2d');
  ctx.drawImage(bmp, ox, oy, size, size, 0, 0, size, size);
  return { d: ctx.getImageData(0, 0, size, size).data, size };
}

/**
 * 异形方块的图标必须有**透明背景**（不铺满正方形 → 轮廓可见，与实心立方体区分）。
 * 从图标 atlas 裁矩形读像素（v1.26：图标烘进单一 atlas，坐标取自 icons.json）。
 * 实心方块等轴测投影是正菱形铺满大部分画布，异形方块（栏杆/柱子/台阶）留大量透明 → 本断言区分二者。
 */
test('iso-icon: 异形方块图标有透明背景（从 icons-atlas 裁矩形）', async () => {
  for (const name of ICON_BLOCKS) {
    const { d, size } = await iconPixels(name);
    let transparent = 0, opaque = 0;
    for (let i = 3; i < d.length; i += 4) { if (d[i] === 0) transparent++; else opaque++; }
    const total = size * size;
    assertTrue(transparent > 0, `${name} 有透明像素（${transparent} 个）`);
    assertTrue(opaque / total > 0.15, `${name} 不透明占比 ${(opaque / total * 100).toFixed(1)}% > 15%`);
    assertTrue(opaque / total < 0.9, `${name} 不透明占比 < 90%（轮廓可见）`);
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
    const { d, size } = await iconPixels(name);
    let minX = size, maxX = -1, minY = size, maxY = -1;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (d[(y * size + x) * 4 + 3] > 0) {
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
    const { d, size } = await iconPixels(name);
    const rows = [];
    for (let y = 0; y < size; y++) {
      let n = 0;
      for (let x = 0; x < size; x++) if (d[(y * size + x) * 4 + 3] > 0) n++;
      rows.push(n);
    }
    const first = rows.findIndex((r) => r > 0);
    const last = size - 1 - [...rows].reverse().findIndex((r) => r > 0);
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
 * 回归防线：烘焙产物必须有**三面明暗分层**（立体感来源）。
 *
 * **判据改为尺寸无关的明暗差**（v1.26）。旧判据是「色数 > 贴图自身 38」，那是按 64px 图标
 * 标定的 —— 图标改成 40px 后采样像素变少、色数降到 33，旧阈值失效。直接调低数字属于
 * **静默放宽断言**（CLAUDE.md 规则禁止），故改为测更本质的不变式：
 * 顶面（+Y，shade 1.0）必须比两个侧面（+X 0.75 / +Z 0.55）亮。
 * 这条与分辨率无关，且比「色数」更贴近它要守的东西（三面明暗）。
 */
test('iso-icon: 柱子图标有三面明暗分层（顶面比侧面亮，尺寸无关）', async () => {
  const { d, size } = await iconPixels('vertical_pillar');
  /** 某区域的平均亮度（只算不透明像素） */
  const lum = (x0, y0, w, h) => {
    let sum = 0, n = 0;
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) {
        const i = (y * size + x) * 4;
        if (d[i + 3] === 0) continue;
        sum += (d[i] + d[i + 1] + d[i + 2]) / 3; n++;
      }
    }
    return n ? sum / n : NaN;
  };
  // 等轴测立方体：顶面在上部中央，+X 面右下、+Z 面左下（与 grass 验证同一分区口径）
  const top = lum(Math.round(size * 0.2), Math.round(size * 0.15), Math.round(size * 0.6), Math.round(size * 0.2));
  const left = lum(Math.round(size * 0.05), Math.round(size * 0.55), Math.round(size * 0.3), Math.round(size * 0.3));
  const right = lum(Math.round(size * 0.65), Math.round(size * 0.55), Math.round(size * 0.3), Math.round(size * 0.3));
  assertTrue(top > left, `顶面亮度 ${top.toFixed(1)} > 左侧(+Z) ${left.toFixed(1)}（shade 1.0 > 0.55）`);
  assertTrue(top > right, `顶面亮度 ${top.toFixed(1)} > 右侧(+X) ${right.toFixed(1)}（shade 1.0 > 0.75）`);
  assertTrue(right > left, `右侧(+X) ${right.toFixed(1)} > 左侧(+Z) ${left.toFixed(1)}（shade 0.75 > 0.55）`);
});

// --- v1.26：全量图标（消除 UV 副本 + 单位立方体 fallback + 逐面采样） ---
// 这三条是 Tier 1 改造点，各有对应的回归防线。

test('iso-icon: cubeQuads 复用 mesher FACE_VERTICES（形状单一权威，禁止手写第二份）', () => {
  // 97 个实心方块无 TEMPLATES 模板 → fallback 单位立方体。
  // 红线 1：形状权威只有 mesher 一份，本文件不得手写立方体顶点。
  //
  // **本断言的局限（实测发现，别高估它）**：它比对的是**值**，所以「手写一份数值完全相同
  // 的第二份定义」会通过——它抓的是「两份定义数值漂移」（改了几何只改一处），不是「存在
  // 第二份定义」。真正的保证来自 `iso-icon.js` 走 import（结构上不可能漂移）：实测把
  // mesher 的 +X 顶点从 1 改成 1.2，`cubeQuads()` 自动跟上、无副本可漏。本用例是那道
  // import 的兜底断言，不是防「有人另写一份」的唯一防线。
  const q = cubeQuads();
  assertEqual(q.length, 3, '只取朝向观察者的 +X/+Y/+Z 三面');
  const faces = q.map((e) => e.face).sort();
  assertEqual(faces.join(','), '0,2,4', '三个可见面');
  // **逐顶点与 mesher 的 FACE_VERTICES 完全相等** —— 若有人在本文件另写一份立方体
  // 定义（哪怕数值相同），几何改动后两份会漂移，这条会抓到。
  for (const e of q) {
    assertEqual(e.v.length, 4, `face ${e.face} 是 quad（4 顶点）`);
    for (let i = 0; i < 4; i++) {
      assertEqual(e.v[i].join(','), FACE_VERTICES[e.face][i].join(','),
        `face ${e.face} 顶点 ${i} 与 mesher FACE_VERTICES 完全一致`);
    }
  }
});

test('iso-icon: cubeQuads 的 UV 与 mesher FACE_UVS 一致（无第二份副本）', () => {
  // v1.24 的 ISO_FACE_UVS 是 mesher FACE_UVS 的第二份副本（实测 face 0/2/4 完全相同）
  // → 本次收掉。断言逐角点相等：若有人写回本地表并改数值，这条会抓到。
  const q = cubeQuads();
  for (const e of q) {
    assertEqual(e.uv.length, 4, `face ${e.face} 有 4 个 UV 角点`);
    for (let i = 0; i < 4; i++) {
      assertEqual(e.uv[i].join(','), FACE_UVS[e.face][i].join(','),
        `face ${e.face} UV 角点 ${i} 与 mesher FACE_UVS 完全一致（口径：three BoxGeometry buildPlane）`);
    }
  }
  // ±X 面的 UV 口径是 u=1-z（M2 修过的历史 bug：曾用统一 [0,0],[1,0],[1,1],[0,0]
  // → 东西面贴图旋转 90°）。钉住首角点防回退。
  assertEqual(q.find((e) => e.face === 0).uv[0].join(','), '1,0', '+X 面首角点 u=1（非 0）');
});

test('iso-icon: renderIsoIcon 的采样回调收到 face 参数（逐面采样的前提）', () => {
  // 17 个实心方块是多面不同贴图（grass 顶绿侧土）。旧签名 sampleTex(u,v) 只能采单面
  // → 三个面全采同一张贴图，图标配色错误。新签名 (u,v,face) 让调用方按面取贴图。
  const seen = new Set();
  renderIsoIcon(cubeQuads(), 16, (u, v, face) => {
    seen.add(face);
    return [255, 255, 255];
  });
  assertEqual([...seen].sort((a, b) => a - b).join(','), '0,2,4',
    '三个可见面各自收到自己的 face 参数（供按面选贴图）');
});

test('iso-icon: 多面贴图方块三面各采各的贴图（grass 顶绿侧土不串色）', () => {
  // 端到端验证：模拟 grass 的 faces-data（顶 grass_carried、侧 grass_side_carried）。
  // 旧实现只采 face 0 → 顶面也是土色（实测配色错误）。新实现三面各采各的。
  const FACE_COLORS = { 0: [140, 100, 60], 2: [80, 170, 60], 4: [140, 100, 60] }; // 侧土色 / 顶草绿
  const buf = renderIsoIcon(cubeQuads(), 24, (u, v, face) => FACE_COLORS[face]);
  const colors = new Set();
  for (let i = 0; i < buf.length; i += 4) {
    if (buf[i + 3] === 0) continue;
    colors.add(`${buf[i]},${buf[i + 1]},${buf[i + 2]}`);
  }
  // 顶面明暗 1.0 → 草绿原色；两个侧面 0.75/0.55 → 土色两档。共 3 种。
  assertEqual(colors.size, 3, `三面各采各的贴图 → 3 种颜色（顶草绿 + 两侧土色明暗档），实得 ${colors.size}`);
  // 顶面必须出现草绿（若只采 face 0，顶面会是土色 → 这条抓配色错误）
  assertTrue(colors.has('80,170,60'), `顶面采到草绿 rgb(80,170,60)（shade 1.0 原色），实得 ${[...colors].join(' ')}`);
  // 侧面必须是土色的明暗档（0.75 / 0.55）
  assertTrue(colors.has('105,75,45'), `+X 面土色 ×0.75 = rgb(105,75,45)，实得 ${[...colors].join(' ')}`);
  assertTrue(colors.has('77,55,33'), `+Z 面土色 ×0.55 = rgb(77,55,33)，实得 ${[...colors].join(' ')}`);
});
