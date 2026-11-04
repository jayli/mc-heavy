// 等轴测投影图标纯函数单测（§4.5.4 v1.24）
// 形状权威 = mesher.js 的 TEMPLATES（红线 1：图标不得有第二份几何定义）。
// 本文件只测投影与明暗的**几何正确性**；图标 PNG 的像素断言在 Playwright spec 里做
// （浏览器内 canvas 读像素，单测环境无 atlas.png）。
import { test } from './runner.js';
import { assertEqual, assertTrue, assertFalse } from './assert.js';
import { resourceUrl } from '../core/resource-url.js';
// FACE_VERTICES/FACE_UVS 是形状与 UV 的**唯一权威**（v1.26 导出）——单测逐顶点比对
// cubeQuads 是否与之一致，防止 iso-icon.js 出现第二份立方体/UV 定义（红线 1）。
import { TEMPLATES, FACE_VERTICES, FACE_UVS } from '../mesh/mesher.js';
import {
  ISO_SHADE, ISO_ALPHA_TEST, ISO_RENDER_VERSION,
  projectIso, isoPolygons, isoBBox, renderIsoIcon, cubeQuads,
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
 * 这 9 项是 v1.24 起就做等轴测的异形方块（§4.5.4）。v1.26 扩到物品集合全量后，
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
  if (!iconMeta) iconMeta = await (await fetch(resourceUrl('assets/icons.json'))).json();
  return iconMeta;
}
/** 从图标 atlas 裁某方块矩形 → canvas ImageData（size × size RGBA） */
async function iconPixels(name) {
  const meta = await iconMetaLoad();
  const css = meta.hotbar[name];
  const m = css.match(/(-?\d+)px (-?\d+)px \/ /); // background-position: -Xpx -Ypx
  const ox = -+m[1], oy = -+m[2];
  const bmp = await createImageBitmap(
    await (await fetch(resourceUrl('assets/icons-atlas.png'))).blob());
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
 * **静默放宽断言**（CLAUDE.md 规则禁止），故改为测更本质的不变式。
 *
 * ## v1.29 重标：取样窗必须按「这个方块**实际可见**的面」摆
 *
 * 旧实现下这条用例**碰巧**通过，现在修正了重心插值反而红了 —— 值得记下来：
 * 竖柱是细柱（0.3×0.3），等轴测下**三个面里只有顶面 + 一个侧面可见**：
 * 另一个侧面朝向相机内部，被自身几何挡住。两个可见面的屏幕位置（几何推导，
 * 与 `test-iso-icon.js` 的 `isoBBox` 数字一致）：
 *   - 顶面（+Y）：菱形，占 y ∈ [11.8, 20.0] px；
 *   - 侧面（+Z，暗面）：占 y ∈ [20.0, 37.9] px 的左下半；
 *   - 0.5 高度处的像素正好是**两个面的交界**，所以“右侧”那个窗口全落在顶面上。
 * 旧的重心错位把顶面图案向下拉了，右窗口才恰好采到侧面 —— 判据因此在测实现缺陷。
 * 现改为：**只有两个可见面**时比较「顶部区域 vs 下侧区域」，并要求下面那条交叉比对
 * （顶面亮于侧面）由面编码的几何用例（`test-iso-icon.js` 的 `ISO_SHADE` 那三条）守。
 */
test('iso-icon: 柱子图标的两个可见面有明暗分层（顶面亮于侧面）', async () => {
  const { d, size } = await iconPixels('vertical_pillar');
  /** 某区域的平均亮度（只算不透明像素） */
  const lum = (x0, y0, w, h) => {
    let sum = 0, n = 0;
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) {
        const i = (y * size + x) * 4;
        if (d[i + 3] < 250) continue; // 跳过抗锯齿边缘（半透明像素混了背景）
        sum += (d[i] + d[i + 1] + d[i + 2]) / 3; n++;
      }
    }
    return { v: n ? sum / n : NaN, n };
  };
  // 几何标定（40px）：顶面 y∈[11.8,20]、侧面 y∈[20,37.9]、柱体 x∈[11.8,28.2]
  const top = lum(Math.round(size * 0.30), Math.round(size * 0.32), Math.round(size * 0.4), Math.round(size * 0.12));
  const side = lum(Math.round(size * 0.30), Math.round(size * 0.60), Math.round(size * 0.4), Math.round(size * 0.25));
  assertTrue(top.n > 20 && side.n > 20,
    `两个取样窗都有足够像素（顶 ${top.n} / 侧 ${side.n}）—— 防窗口摆错变成空扫描`);
  assertTrue(top.v > side.v,
    `顶面亮度 ${top.v.toFixed(1)} > 侧面 ${side.v.toFixed(1)}（ISO_SHADE 1.0 > 0.55，立体感来源）`);
});

// --- 遮挡正确性（v1.28：深度度量 y 符号 + 逐像素深度测试） ---

/**
 * 恒色贴图下的三面亮度（`ISO_SHADE` × 100）：顶面 100 / +X 75 / +Z 55。
 * 判据用亮度反推「这块像素属于哪个面」—— 无需暴露面占据统计，现有 API 即可判定。
 */
const FLAT_TEX = () => [100, 100, 100];

/** 画布下半部里「顶面亮度（100）」的像素数 —— 顶面出现在下半部即意味着遮挡判定有误 */
function topFacePixelsInLowerHalf(quads, size = 32) {
  const d = renderIsoIcon(quads, size, FLAT_TEX);
  let n = 0;
  for (let y = Math.floor(size / 2); y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      if (d[i + 3] === 0) continue;
      if (d[i] === 100 && d[i + 1] === 100 && d[i + 2] === 100) n++;
    }
  }
  return n;
}

/**
 * 深度度量方向：等轴测投影 `sx=x-z`、`sy=(x+z)/2-y` 的两轴叉乘得投影平面法线
 * `(-1,-1,-1)` → 视线方向 `(1,1,1)` → **正确深度 = x+y+z（越高越近）**。
 *
 * 回归防线：屏幕上位置最高的顶面（投影 sy 平均最小）必须同时拥有最大的 depth。
 * 若有人把深度度量写回 `x+z-y`（y 符号反了），这条会抓到 —— 该度量对只在 y 上不同
 * 的两点判定完全相反（`(0,1,0)` vs `(0,0,0)`：判成 -1 < 0 = 高处更远）。
 *
 * 用 `cobblestone_step_updown` 作载体：它有两个 +Y 面 —— 真顶面（y=1）与下半柱的
 * 柱顶面（y=0.5，被上半块完全遮住）。现状错度量下真顶面 depth=0.00 < 柱顶面 0.75。
 */
test('iso-icon: 屏幕位置最高的顶面 depth 最大（深度度量 y 符号不得反）', () => {
  const polys = isoPolygons(TEMPLATES.cobblestone_step_updown).filter((p) => p.face === 2);
  assertEqual(polys.length, 2, '两个 +Y 面（真顶面 y=1 + 柱顶面 y=0.5）');
  const avgSy = (p) => p.v.reduce((s, v) => s + v[1], 0) / p.v.length;
  // 屏幕位置最高 = sy 平均最小（sy 越小越靠上）
  const highest = polys.reduce((a, b) => (avgSy(a) < avgSy(b) ? a : b));
  const maxDepth = Math.max(...polys.map((p) => p.depth));
  assertEqual(highest.depth, maxDepth,
    `屏幕最高的顶面（sy 平均 ${avgSy(highest).toFixed(3)}）depth=${highest.depth.toFixed(3)} ` +
    `必须是顶面中最大（实得最大 ${maxDepth.toFixed(3)}）——越高越近`);
});

/**
 * 回归防线：**被完全遮住的面不得占据像素**（本次修的幻影面 bug）。
 *
 * `cobblestone_step_updown` 的下半柱在 y=0.5 有个顶面，被上半块（x/z 范围完整覆盖它）
 * **完全遮住** —— 现实中看不见。但 `VISIBLE_FACES` 只按面索引过滤、不知道它被遮挡，
 * 照样发射；painter 的平均深度排序又判它比柱侧面更近 → 覆盖掉本该可见的柱侧面，
 * 渲成一片亮楔形（实测现状 32px 下 88px 顶面色，修正后 4px 边界残留）。
 */
test('iso-icon: 倒置台阶下半部不得出现顶面（被遮住的面不占像素）', () => {
  const n = topFacePixelsInLowerHalf(TEMPLATES.cobblestone_step_updown);
  assertTrue(n < 10,
    `倒置台阶下半画布顶面像素 ${n}px < 10（柱顶面被上半块完全遮住，不应可见）`);
});

/**
 * 回归防线的**另一半**：防止「粗暴把所有顶面砍掉」的假修法。
 *
 * `planks_step`（下半全幅 + 左上 1/4 柱）的柱顶面在 y=1，是**外部面** = 阶梯踏面，
 * 现实中**可见**、必须保留。它与倒置台阶互为镜像：倒置的柱顶面被上半块遮住（实测 2px，
 * 只剩深度并列的边界），而正置的踏面大面积露出。
 *
 * **阈值 50 是几何标定值，不是拟合值**（v1.29 重标，旧注释的 109 是错位权重时代的读数）：
 * 踏面 = y=0.5、x∈[0.5,1]、z∈[0,1] 的水平矩形，投影后是平行四边形，四角像素
 * (23.14,12.43)/(30.29,16.00)/(16.00,23.14)/(8.86,19.57)，总面积 **102.0 px²**；
 * 按 `y ≥ SIZE/2` 裁掉上半后剩 **76.5 px²（75%）**，像素取整后实测 **79**。
 * 取 50 = 实测值的 63%，既不贴线（像素取整/不同 SIZE 不会假失败），又远高于
 * 倒置台阶的 2px（差 25 倍）。★ 该阈值的判别对象就是“全部砍掉顶面”那种修法。
 */
test('iso-icon: 正置台阶阶梯踏面必须保留（外部顶面不得误判为遮挡）', () => {
  const n = topFacePixelsInLowerHalf(TEMPLATES.planks_step);
  const down = topFacePixelsInLowerHalf(TEMPLATES.cobblestone_step_updown);
  assertTrue(n > 50,
    `正置台阶下半画布顶面像素 ${n}px > 50（柱顶面 y=1 是阶梯踏面，外部面必须可见）`);
  assertTrue(n > down * 10,
    `正置踏面 ${n}px 远多于倒置的 ${down}px（后者被上半块遮住）—— 相互对照，两边都不贴线`);
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

// --- v1.29：UV 重心插值正确性 / alpha 传播 / 超采样 ---
//
// **背景（本节三条用例对应三个用户可见缺陷）**：
//   ① 「方块可见的三个面有些变花了」—— 重心权重与顶点索引错位（w 是 [wC,wA,wB]，
//      配的 idx 是 [A,B,C]），每个三角形内的 UV 被**循环旋转**，贴图案被斜向剪切。
//      这是**全部 114 个等轴测图标**共有的缺陷（实测逐像素全变），不是个别方块的问题。
//   ② 「玻璃是黑的 / 树叶镂空过去是黑色的」—— `renderIsoIcon` 末尾硬编码
//      `out[o+3] = 255`，贴图 alpha 被完全丢弃。`Glass.png` 的透明像素 RGB 是 (0,0,0)
//      → 黑底；树叶孔洞采到贴图残留暗色 → 黑点。
//   ③ 32/40px 图标轮廓是硬阶梯（「斜上方拍照截图」缺抗锯齿）—— 需要超采样。

/**
 * ① UV 重心插值正确性（本文件最本质的一条）。
 *
 * **判据 = 从像素反解 UV，与几何投影算出的期望值逐像素比对。**
 * 载体用 `TEMPLATES.lilypad`（**单个水平 quad**）：只有一个面参与，任何被填充的像素
 * 必然属于它，故不需要「这根像素属于哪个面」的判别 —— 而立方体有三个面共享画布，
 * 分面取样会让判据本身带上一个容易出错的假设。
 *
 * 反解口径（全部来自投影公式，不引入第二份几何定义）：
 *   `sx = x − z`、`sy = (x+z)/2 − y` ⇒ `x + z = 2(sy + 0.48)`（lilypad 的 y = −0.48）
 *   该 quad 的 FACE_UVS[2] = [[0,0],[1,0],[1,1],[0,1]] 配顶点
 *   (0.1,0.9)/(0.9,0.9)/(0.9,0.1)/(0.1,0.1) ⇒ `u = (x−0.1)/0.8`、`v = (0.9−z)/0.8`
 *
 * 采样回调把 UV 编码成颜色送回，于是「贴图采样点」= 可读出的测量值。
 * 缺陷态（权重循环旋转）下三角形内 UV 被旋转 → 误差可达 0.5，远超 0.06 容差。
 */
test('iso-icon: UV 按重心插值正确落到面内位置（本轮「面变花」的根因）', () => {
  const SIZE = 64;
  const SPAN_PAD = 1.12; // 与 renderIsoIcon 的默认值一致
  const quads = TEMPLATES.lilypad;
  // 该 quad 投影后的包围盒（与 isoBBox 同口径，但直接由投影公式推出，不经内部实现）
  const pts = quads[0].v.map(([x, y, z]) => projectIso(x, y, z));
  const minX = Math.min(...pts.map((p) => p[0])), maxX = Math.max(...pts.map((p) => p[0]));
  const minY = Math.min(...pts.map((p) => p[1])), maxY = Math.max(...pts.map((p) => p[1]));
  const span = Math.max(maxX - minX, maxY - minY) * SPAN_PAD;
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;

  // 回调把 u,v 编码成颜色（u×255 / v×255）。alpha 用第四分量给满，避免受 alphaMode 影响。
  const d = renderIsoIcon(quads, SIZE, (u, v) => [u * 255, v * 255, 0]);
  let checked = 0, worst = 0, worstAt = '';
  for (let py = 0; py < SIZE; py++) {
    for (let px = 0; px < SIZE; px++) {
      const i = (py * SIZE + px) << 2;
      if (d[i + 3] === 0) continue;
      // 像素中心 → 世界投影坐标 → 世界 (x,z)
      const sx = ((px + 0.5) - SIZE / 2) * span / SIZE + cx;
      const sy = ((py + 0.5) - SIZE / 2) * span / SIZE + cy;
      // 由投影公式反解世界坐标：sx = x−z、sy = (x+z)/2 − y（y = −0.48 是 lilypad 的叶面高度）
      // ⇒ x+z = 2(sy − 0.48)、x = (sx + (x+z))/2、z = (x+z−sx)/2
      const s = 2 * (sy - 0.48);
      const x = (sx + s) / 2;
      const z = (s - sx) / 2;
      const expU = (x - 0.1) / 0.8;
      const expV = (0.9 - z) / 0.8;
      // 只比对 quad 内部（边沿像素可能落在三角形的插值容差带里）
      if (expU < 0.08 || expU > 0.92 || expV < 0.08 || expV > 0.92) continue;
      const err = Math.max(Math.abs(d[i] / 255 - expU), Math.abs(d[i + 1] / 255 - expV));
      if (err > worst) { worst = err; worstAt = `px(${px},${py}) 期望 u=${expU.toFixed(3)} v=${expV.toFixed(3)}`; }
      checked++;
    }
  }
  assertTrue(checked > 100, `内部像素样本 ${checked} 个 > 100（判据有辨识度，不是空扫描）`);
  assertTrue(worst < 0.06,
    `UV 反解最大误差 ${worst.toFixed(3)} < 0.06（重心权重必须配对自己顶点的 UV）——最差在 ${worstAt}`);
});

/**
 * ② alpha 传播：贴图透明像素必须**真的透明**（不是硬编码 255 后被背景染成黑色）。
 *
 * 两种模式各自对应世界渲染的一条真实通道（红线 1：与渲染语义同源，不是另立的 UI 规则）：
 *   - `'opaque'`：世界 `opaque` 通道 alphaTest=0，完全忽略 alpha（97 个实心方块走这条）
 *   - `'cutout'`：世界 `cutout` 通道 alphaTest=0.3 → 低于阈值整片丢弃，高于阈值完全不透明
 *   - `'blend'`：世界 `transparent` 通道 → 保留原 alpha（玻璃）
 */
test('iso-icon: alpha 按通道语义传播（opaque 忽略 / cutout 阈值 / blend 保留）', () => {
  const SIZE = 16;
  const clearTex = () => [0, 0, 0, 0]; // 模拟 Glass.png 的透明像素（RGB 也是 0）
  const opaqueAlpha = (mode) => {
    const d = renderIsoIcon(cubeQuads(), SIZE, clearTex, 1.12, { alphaMode: mode });
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
    return n;
  };
  assertTrue(opaqueAlpha('opaque') > 0,
    `opaque 模式忽略贴图 alpha（世界 alphaTest=0 同口径）→ 仍有 ${opaqueAlpha('opaque')} 个可见像素`);
  assertEqual(opaqueAlpha('cutout'), 0, 'cutout 模式把 alpha=0 的像素整片丢弃（不留黑底）');
  assertEqual(opaqueAlpha('blend'), 0, 'blend 模式 alpha=0 → 全透明');

  // 半透明贴图：cutout 阈值 0.3 分界；blend 原样保留
  const half = (a, mode) => {
    const d = renderIsoIcon(cubeQuads(), SIZE, () => [10, 200, 30, a], 1.12, { alphaMode: mode });
    let sum = 0, n = 0;
    for (let i = 3; i < d.length; i += 4) { if (d[i] > 0) { sum += d[i]; n++; } }
    return { n, mean: n ? sum / n : 0 };
  };
  assertEqual(half(60, 'cutout').n, 0, 'alpha=60/255=0.235 < 0.3 → cutout 丢弃（不留半透明的洞）');
  assertTrue(half(120, 'cutout').n > 0, 'alpha=120/255=0.47 ≥ 0.3 → cutout 保留');
  assertEqual(Math.round(half(120, 'cutout').mean), 255, 'cutout 保留时 alpha 归一为 255（世界 alphaTest 口径）');
  assertEqual(Math.round(half(120, 'blend').mean), 120, 'blend 保留原始 alpha=120（玻璃半透明）');

  // 三元素回调（旧签名）必须照旧工作：alpha 视为不透明。
  // ⚠️ 判据只能是“无 alpha=0 的像素”，不能要求“全是 255”：立方体只有**两个**可见面
  // 覆盖整个菱形（顶面 + 一个侧面占全幅，第三个面退化成一条对角线——实测 161/256 满
  // alpha、其余仍为 0 的空白）。写成“全部 255”是把形状当正方形，断言描述的是想象中的世界。
  const legacy = renderIsoIcon(cubeQuads(), SIZE, () => [100, 100, 100]);
  let cells = 0, partialPx = 0;
  for (let i = 3; i < legacy.length; i += 4) {
    if (legacy[i] > 0) cells++;
    if (legacy[i] > 0 && legacy[i] < 255) partialPx++;
  }
  assertEqual(partialPx, 0, '三元素回调 → 没有半透明像素（缺省 alpha 视为不透明）');
  assertTrue(cells > 0, `三元素回调 → 形状仍然渲染（${cells} 个像素）`);
});

/**
 * ③ 超采样抗锯齿：轮廓像素出现**部分覆盖**（0 < alpha < 255）。
 *
 * 判据的对照侧是同一次渲染的 `samples: 1` —— 它按像素中心采样，每个像素非 0 即全满，
 * 数学上不可能出现部分 alpha（结构性质，不是调参）。故这条不需要外部基准参考图。
 */
test('iso-icon: samples 超采样让轮廓出现部分覆盖（抗锯齿）', () => {
  const SIZE = 40;
  const tex = () => [120, 160, 90]; // 全不透明贴图 → 只有轮廓会产生部分 alpha
  const count = (opts) => {
    const d = renderIsoIcon(cubeQuads(), SIZE, tex, 1.12, opts);
    let partial = 0, solid = 0;
    for (let i = 3; i < d.length; i += 4) {
      if (d[i] === 0) continue;
      if (d[i] === 255) solid++; else partial++;
    }
    return { partial, solid };
  };
  const s1 = count({ samples: 1 });
  const s4 = count({ samples: 4 });
  assertEqual(s1.partial, 0, `samples:1 无部分覆盖（按像素中心采样，结构性质）`);
  assertTrue(s4.partial > 20,
    `samples:4 边缘部分覆盖 ${s4.partial}px > 20（斜边抗锯齿，不再是硬阶梯）`);
  // 超采样不得改变「有没有形状」：实体像素总量必须同量级（防「全糊成半透明」的假修法）
  assertTrue(Math.abs((s4.solid + s4.partial) - s1.solid) / s1.solid < 0.02,
    `覆盖面积不变（samples:1 ${s1.solid}px vs samples:4 ${s4.solid + s4.partial}px，差 < 2%）`);
});

test('iso-icon: ISO_ALPHA_TEST 与世界 cutout 通道的 alphaTest 同值（红线 1）', () => {
  assertEqual(ISO_ALPHA_TEST, 0.3, 'iso 图标的 cutout 阈值 = materials.js 的 cutout alphaTest');
});

test('iso-icon: ISO_RENDER_VERSION 存在（进指纹，防「改了渲染算法但指纹不变」）', () => {
  assertTrue(typeof ISO_RENDER_VERSION === 'string' && ISO_RENDER_VERSION.length > 0,
    `ISO_RENDER_VERSION 是非空字符串（实得 ${JSON.stringify(ISO_RENDER_VERSION)}）`);
});
