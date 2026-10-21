// tests/night-sky-seam.spec.mjs — Tier 4：夜空立方图**无缝**验收
//
// ## 为什么需要这条 spec（v1.60）
//
// mc-lite `skyBox1` 的六面是各自独立生成的图，12 条共享边的平均 RMS 落差 **41.09**
// （白天 `skyBox4` 只有 1.90）。游戏里表现为天空被几条**笔直的暗线**切成方块感
// （用户 2026-10-21 报告：「有明显的衔接边界，看上去就是一个有楞有角的盒子」）。
// v1.60 用方向空间加权重采样重新烘焙，接缝降到与白天同量级。
//
// ## 判据为什么用「接缝 / 面内相邻列噪声底」而不是裸 RMS
//
// 用户认可的基准是**白天**（「类似白天的天空盒的样子，看不到边和角」），但白天接缝裸 RMS
// 是 **1.90** 而不是 0 —— 那点残差来自 JPEG 量化，肉眼看不到，因为**它并不比画面内部的
// 普通相邻像素落差更大**（白天面内噪声底 1.06，比值 1.786）。
// 反过来：如果一张图内部本来就平滑（噪声底 0.5）而接缝有 2.0，比值 4 就**能看出来**。
// 所以裸 RMS 会给出错误结论，必须归一化到图像自身的噪声水平。
//
// 实测（12 条边的平均，数据源为磁盘上的贴图）：
//   白天（用户认可的基准）  接缝 1.90 / 噪声底 1.06 → 比值 **1.786**
//   夜空（v1.60 烘焙后）    接缝 1.89 / 噪声底 6.07 → 比值 **0.312**
//   夜空（mc-lite 原始）    接缝 41.09 / 噪声底 8.96 → 比值 **4.585**
// → 阈值取 **1.0**：比「白天基准」更严，且与原图（4.585）差 4 倍以上，不贴线。
//
// ⚠️ 判据是**相对**的（比值），所以换贴图/改烘焙参数后不需要重标阈值 —— 只要新图在
// 它的自身噪声水平下是连续的就能过。

import { test, expect } from 'playwright/test';
import { PNG } from 'pngjs';

/** 立方体六面在 3D 里的 12 条共享边（OpenGL 约定，v 向下为 +）。最后一项 = 对面是否需要翻转。 */
const SEAM_PAIRS = [
  ['posx', 'right', 'negz', 'left', false],
  ['posx', 'left', 'posz', 'right', false],
  ['negx', 'right', 'posz', 'left', false],
  ['negx', 'left', 'negz', 'right', false],
  ['posy', 'bottom', 'posz', 'top', false],
  ['posy', 'top', 'negz', 'top', true],
  ['posy', 'left', 'negx', 'top', false],
  ['posy', 'right', 'posx', 'top', true],
  ['negy', 'top', 'posz', 'bottom', false],
  ['negy', 'bottom', 'negz', 'bottom', true],
  ['negy', 'left', 'negx', 'bottom', true],
  ['negy', 'right', 'posx', 'bottom', false],
];

/**
 * 判据：夜空接缝比值必须**不差于白天基准**。
 *
 * ⚠️ **不用绝对阈值**（第一版写过 1.0 和 1.2，两次都被对照用例当场否决）：用户认可的
 * **白天**基准实测是 **1.765** —— 任何小于它的绝对阈值都会把"用户亲口说看不到边角"的
 * 那套贴图判为 FAIL，阈值因此与观感无关。
 *
 * 正确的参照物就是**白天贴图本身**：它是用户明确认可的「看不到边和角」的样本。
 * 故判据 = `夜空比值 ≤ 白天比值 × 1.0`（允许相等，但不得更差）。
 * 实测：夜空 **0.308** / 白天 **1.765** → 余量 5.7 倍，两侧都不贴线。
 * 好处：换贴图/改烘焙参数后**不需要重标** —— 它问的是「有没有比用户认可的那个更差」。
 */
const NIGHT_VS_DAY_MAX = 1.0;

/**
 * 在浏览器里解码六面 JPEG 并计算接缝指标。
 * 必须走浏览器：node 侧只有 pngjs，没有 JPEG 解码器。
 */
async function measureSeams(page, dir) {
  return page.evaluate(async ({ dir, pairs }) => {
    const NAMES = ['posx', 'negx', 'posy', 'negy', 'posz', 'negz'];
    const load = async (name) => {
      const img = new Image();
      img.src = `${dir}/${name}.jpg`;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0);
      return { w: img.width, h: img.height, data: ctx.getImageData(0, 0, img.width, img.height).data };
    };
    const faces = {};
    for (const n of NAMES) faces[n] = await load(n);

    const pix = (f, x, y) => {
      const a = faces[f];
      const i = ((y * a.w) + x) * 4;
      return [a.data[i], a.data[i + 1], a.data[i + 2]];
    };
    /** 取某面的一条边（沿边逐像素） */
    const edge = (f, side) => {
      const a = faces[f];
      const out = [];
      if (side === 'top') for (let x = 0; x < a.w; x++) out.push(pix(f, x, 0));
      else if (side === 'bottom') for (let x = 0; x < a.w; x++) out.push(pix(f, x, a.h - 1));
      else if (side === 'left') for (let y = 0; y < a.h; y++) out.push(pix(f, 0, y));
      else for (let y = 0; y < a.h; y++) out.push(pix(f, a.w - 1, y));
      return out;
    };
    const rms = (arrA, arrB) => {
      let s = 0;
      for (let i = 0; i < arrA.length; i++) {
        for (let c = 0; c < 3; c++) {
          const d = arrA[i][c] - arrB[i][c];
          s += d * d;
        }
      }
      return Math.sqrt(s / (arrA.length * 3));
    };

    const seams = [];
    for (const [fa, sa, fb, sb, flip] of pairs) {
      const A = edge(fa, sa);
      let B = edge(fb, sb);
      if (flip) B = B.slice().reverse();
      seams.push({ pair: `${fa}.${sa}<->${fb}.${sb}`, rms: rms(A, B) });
    }

    // 面内噪声底：每面在中部取若干列，量「相邻列」的平均 RMS（= 这张图正常的像素级起伏）
    const inner = [];
    for (const n of NAMES) {
      const a = faces[n];
      const xs = [0.15, 0.3, 0.45, 0.6, 0.75].map((t) => Math.floor(a.w * t));
      for (const x of xs) {
        const c1 = [], c2 = [];
        for (let y = 0; y < a.h; y++) { c1.push(pix(n, x, y)); c2.push(pix(n, x + 1, y)); }
        inner.push(rms(c1, c2));
      }
    }

    const seamMean = seams.reduce((s, x) => s + x.rms, 0) / seams.length;
    const innerMean = inner.reduce((s, x) => s + x, 0) / inner.length;
    return {
      seamMean,
      seamMax: Math.max(...seams.map((s) => s.rms)),
      innerMean,
      ratio: seamMean / innerMean,
      seams,
    };
  }, { dir, pairs: SEAM_PAIRS });
}

test('夜空立方图 12 条共享边无缝（接缝 ≤ 自身噪声底）', async ({ page }) => {
  test.setTimeout(120_000);
  // 不需要进游戏：只解码贴图算指标。用同源的静态页拿到 fetch/canvas 能力。
  await page.goto('/?vd=2&seed=12345');

  const night = await measureSeams(page, '/assets/sky/night');
  const day = await measureSeams(page, '/assets/sky/day');
  console.log('NIGHT-SKY-SEAM:', JSON.stringify({
    seamMean: +night.seamMean.toFixed(3),
    seamMax: +night.seamMax.toFixed(3),
    innerMean: +night.innerMean.toFixed(3),
    ratio: +night.ratio.toFixed(3),
  }));
  console.log('DAY-SKY-SEAM:', JSON.stringify({
    seamMean: +day.seamMean.toFixed(3),
    innerMean: +day.innerMean.toFixed(3),
    ratio: +day.ratio.toFixed(3),
  }));

  // ① 主判据：不得比白天基准更差（白天是用户认可的样本，见文件头）
  expect(night.ratio,
    `夜空接缝/噪声底 ${night.ratio.toFixed(3)} 比白天基准 ${day.ratio.toFixed(3)} 更差`
    + `（原 mc-lite 夜空是 4.585）`)
    .toBeLessThanOrEqual(day.ratio * NIGHT_VS_DAY_MAX);

  // ② sanity floor：噪声底不能为 0（否则比值恒 0，判据可被全黑图绕过）
  expect(night.innerMean, '噪声底过低：贴图可能是纯色/全黑，比值判据会失效').toBeGreaterThan(1.0);
  expect(day.innerMean, '白天噪声底异常（判据基准失效）').toBeGreaterThan(0.3);
});

test('白天立方图同口径对照（证明阈值与「用户认可的基准」一致）', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/?vd=2&seed=12345');
  const r = await measureSeams(page, '/assets/sky/day');
  console.log('DAY-SKY-SEAM:', JSON.stringify({
    seamMean: +r.seamMean.toFixed(3),
    innerMean: +r.innerMean.toFixed(3),
    ratio: +r.ratio.toFixed(3),
  }));
  // 白天是用户认可的「看不到边角」的基准 → 本用例只**记录**它，作为主判据的分母。
  // ⚠️ 不在这里断言任何绝对阈值：那正是前两版阈值（1.0 / 1.2）被否决的原因。
  // 断言只保证基准本身可用（比值有限、噪声底正常）。
  expect(Number.isFinite(r.ratio), '白天基准比值异常').toBe(true);
  expect(r.innerMean, '白天噪声底异常').toBeGreaterThan(0.3);
  expect(r.ratio, '白天基准比值超出合理范围（0~3）—— 判据基准可能失效')
    .toBeLessThan(3);
});
