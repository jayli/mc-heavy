// tools/bake-zombie-skin.mjs — 烘焙丧尸皮肤（标准 Minecraft 64×64 版式，确定性）
//
// 产物：`assets/zombie/skin.png`（64×64）+ `assets/zombie/skin.json`（尺寸 / 版式版本 / 指纹）。
// **不放 `assets/textures/`**：那里被 `build-atlas.mjs` 递归扫描进世界 atlas，
// 丧尸皮肤不属世界方块贴图，进去会污染 atlas（同 `assets/zombie/head.png` 的既有口径）。
//
// 配色与区域划分的权威 = `tools/zombie-skin-fingerprint.mjs`（门禁共用同一份参数）。
// UV 矩形的权威 = `src/render/zombie-model.js`（渲染器运行时读那份，本脚本经指纹模块 re-export 拿到）。
//
// **确定性**（红线 2）：所有随机都用固定种子的 mulberry32，禁止 `Math.random()`
// —— 否则每次加载图案都不同，违反「同 seed 同世界」的前提。
//
// 绘制顺序是载荷性的：**先按部件的六个 UV 矩形铺满基色**（保证每个被采样到的像素都有颜色），
// 再做袖子/裤腿分段（覆盖基色下半部），再噪声、破损、五官。倒过来会把分段边界抹掉，
// 或让某些面采样到未写入的透明黑。
//
// 用法：node tools/bake-zombie-skin.mjs（或 npm run zombieskin）
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import {
  SKIN_PNG, SKIN_JSON, SKIN_SIZE, SKIN_LAYOUT_VERSION,
  SKIN_PALETTE, SKIN_REGIONS, SKIN_EYES, SKIN_NOISE, SKIN_TEAR_RATIO, SKIN_ROT_RATIO,
  SKIN_SEED, ZOMBIE_SKIN_UV, mulberry32, skinInputFingerprint,
} from './zombie-skin-fingerprint.mjs';

const OUT_DIR = path.dirname(SKIN_PNG);
const FACES = ['px', 'nx', 'py', 'ny', 'pz', 'nz'];

/**
 * 手臂上袖子的占比（其余是裸露皮肤）。
 * 1/3 → 12px 的手臂里上 4px 是袖子、下 8px 是绿皮肤（原版丧尸的「破袖子」观感）。
 */
const ARM_SLEEVE_RATIO = 1 / 3;

/**
 * 小腿最底下鞋的占比（其余是裤子）。
 *
 * 标准 Minecraft 皮肤里「裤子」占整条腿的 12px 全部、鞋只体现在**底面**（`ny`）。
 * 但我们要的是**原版丧尸的观感**：脚上有一双深色鞋。
 * 实测标定：1/4 时屏幕读数 裤:鞋 = 74%:26%（`fillRect` 的 y1 是开区间，少一格）；
 * 1/3 时 12px 里下 4px 是鞋 → 屏幕读数约 67:33，与标准 MC 的 8:4 一致。
 */
const LEG_SHOE_RATIO = 1 / 3;

/** 把 RGB 写进 PNG 缓冲的 (x,y)（越界静默跳过 —— UV 表已由单测钉在图内） */
function put(buf, x, y, rgb) {
  if (x < 0 || y < 0 || x >= SKIN_SIZE || y >= SKIN_SIZE) return;
  const i = (y * SKIN_SIZE + x) << 2;
  buf.data[i] = rgb[0];
  buf.data[i + 1] = rgb[1];
  buf.data[i + 2] = rgb[2];
  buf.data[i + 3] = 255;
}

/** 读 (x,y) 的 RGB */
function get(buf, x, y) {
  const i = (y * SKIN_SIZE + x) << 2;
  return [buf.data[i], buf.data[i + 1], buf.data[i + 2]];
}

/** 把一个 UV 矩形规范化成左闭右开的整数区间（反向书写在这里才规范化 —— 绘制不需要方向） */
function rectOf([u1, v1, u2, v2]) {
  return {
    x0: Math.min(u1, u2), x1: Math.max(u1, u2),
    y0: Math.min(v1, v2), y1: Math.max(v1, v2),
  };
}

/** 填一个整数区间 */
function fillRect(buf, r, rgb) {
  for (let y = r.y0; y < r.y1; y++) {
    for (let x = r.x0; x < r.x1; x++) put(buf, x, y, rgb);
  }
}

/** 按部件铺满它六个面的 UV 矩形（不含分段） */
function fillPart(buf, part, rgb) {
  for (const f of FACES) fillRect(buf, rectOf(ZOMBIE_SKIN_UV[part][f]), rgb);
}

/**
 * 肢体分段：四个**侧面**（px/nx/pz/nz，各 4×12px）里上半给 `upperColor`、下半给 `lowerColor`。
 *
 * ⚠️ **顶面 `py` 与底面 `ny` 必须单独指定颜色，不能靠 fillPart 的基色**（实测踩到）：
 * 它们各只有 4×4px，但**手臂前伸后，从正面看到的主要就是底面 `ny`**（臂绕 X 转 -π/2 后，
 * 底面法线朝前）。底面若留在 `fillPart` 涂的袖子色，整条手臂看上去就是「被袖子包住」
 * （用户实拍反馈：短袖套在手臂上）。正确的语义是：
 *   · `py`（肩/髋那一端）= 衣物色
 *   · `ny`（手/脚那一端）= **皮肤色 / 鞋色**
 *
 * @param {string} part 部件名
 * @param {number} upperRatio 侧面上「衣物」所占的比例（0..1）
 * @param {number[]} upperColor 侧面上的衣物色
 * @param {number[]} lowerColor 侧面上的露出色
 * @param {number[]} topColor 顶面（肩/髋端）颜色
 * @param {number[]} bottomColor 底面（手/脚端）颜色
 */
function splitLimbs(buf, part, upperRatio, upperColor, lowerColor, topColor, bottomColor) {
  for (const f of ['px', 'nx', 'pz', 'nz']) {
    const r = rectOf(ZOMBIE_SKIN_UV[part][f]);
    const split = Math.round(r.y0 + (r.y1 - r.y0) * upperRatio);
    fillRect(buf, { ...r, y1: split }, upperColor);
    fillRect(buf, { ...r, y0: split }, lowerColor);
  }
  fillRect(buf, rectOf(ZOMBIE_SKIN_UV[part].py), topColor);
  fillRect(buf, rectOf(ZOMBIE_SKIN_UV[part].ny), bottomColor);
}

/**
 * 逐像素明度抖动（`±SKIN_NOISE/2`）。
 *
 * ⚠️ **逐像素取随机，不按像素块** —— 皮肤是 64px 尺度，块状抖动看起来像马赛克，
 * 而我们要的是「布料/皮肤的细腻杂色」。
 */
function applyNoise(buf, rng, noise) {
  for (let y = 0; y < SKIN_SIZE; y++) {
    for (let x = 0; x < SKIN_SIZE; x++) {
      const [r, g, b] = get(buf, x, y);
      const d = (rng() - 0.5) * noise;
      put(buf, x, y, [
        Math.max(0, Math.min(255, Math.round(r + d))),
        Math.max(0, Math.min(255, Math.round(g + d))),
        Math.max(0, Math.min(255, Math.round(b + d))),
      ]);
    }
  }
}

/** 在若干矩形内按比例撒指定颜色（破损 / 腐斑）：固定种子，逐像素独立判定 */
function sprinkle(buf, rects, rgb, ratio, rng) {
  for (const r of rects) {
    for (let y = r.y0; y < r.y1; y++) {
      for (let x = r.x0; x < r.x1; x++) {
        if (rng() < ratio) put(buf, x, y, rgb);
      }
    }
  }
}

/** 画眼睛（在正脸 UV 矩形内，按 `SKIN_EYES` 的相对坐标） */
function drawEyes(buf) {
  const [u1, v1] = ZOMBIE_SKIN_UV.head.pz;
  for (const e of SKIN_EYES) {
    for (let dy = 0; dy < e.h; dy++) {
      for (let dx = 0; dx < e.w; dx++) {
        put(buf, u1 + e.dx + dx, v1 + e.dy + dy, SKIN_PALETTE.eye);
      }
    }
  }
}

/** 画嘴（眼睛下两行的暗色横线，居中） */
function drawMouth(buf) {
  const [u1, v1] = ZOMBIE_SKIN_UV.head.pz;
  for (let dx = 2; dx <= 5; dx++) put(buf, u1 + dx, v1 + 5, SKIN_PALETTE.eye);
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const buf = new PNG({ width: SKIN_SIZE, height: SKIN_SIZE });
  const rng = mulberry32(SKIN_SEED);

  // ① 整图铺中性基色（皮肤色）—— 标准皮肤里有些格子（1.8+ 外套层）本模型不采样，
  //    但不写的像素是透明黑；铺一层基色让任何遗漏都退化成「皮肤色」而不是黑洞。
  fillRect(buf, { x0: 0, y0: 0, x1: SKIN_SIZE, y1: SKIN_SIZE }, SKIN_PALETTE.skin);

  // ② 按部件铺六个面（部件的基色）
  fillPart(buf, 'head', SKIN_PALETTE.skin);
  fillPart(buf, 'body', SKIN_PALETTE.shirt);
  fillPart(buf, 'rightArm', SKIN_PALETTE.shirt);
  fillPart(buf, 'leftArm', SKIN_PALETTE.shirt);
  fillPart(buf, 'rightLeg', SKIN_PALETTE.pants);
  fillPart(buf, 'leftLeg', SKIN_PALETTE.pants);

  // ③ 肢体分段（**在基色之后、噪声之前** —— 倒过来边界会被抹掉）
  //
  // 比例按**原版 Minecraft 丧尸**的观感定（不是均分）：
  //   · 手臂：只有上臂一小段是袖子（`ARM_SLEEVE_RATIO = 1/3`），其余 2/3 是**裸露的绿皮肤**
  //     —— 原版丧尸的典型特征就是「袖子破了、前臂露出来」。
  //     ⚠️ 早先写成 2/3 袖子时，侧面整条都是青蓝、只有手部端面露出皮肤 →
  //     观感是「胳膊全被衣服包着」，用户实玩反馈「短袖套在手臂上」。
  //   · 腿：整条都是裤子，只在最底下 `LEG_SHOE_RATIO = 1/4` 是鞋。
  //   顶面 = 肩/髋端（衣物色），底面 = 手/脚端（皮肤/鞋色）—— 见 splitLimbs 的注释
  for (const arm of ['rightArm', 'leftArm']) {
    splitLimbs(buf, arm, ARM_SLEEVE_RATIO,
      SKIN_PALETTE.shirt, SKIN_PALETTE.skin,   // 侧面：上袖下皮
      SKIN_PALETTE.shirt, SKIN_PALETTE.skin);  // 顶=肩(袖) 底=手(皮)
  }
  for (const leg of ['rightLeg', 'leftLeg']) {
    splitLimbs(buf, leg, 1 - LEG_SHOE_RATIO,
      SKIN_PALETTE.pants, SKIN_PALETTE.shoe,   // 侧面：上裤下鞋
      SKIN_PALETTE.pants, SKIN_PALETTE.shoe);  // 顶=髋(裤) 底=脚(鞋)
  }

  // ④ 全图噪声
  applyNoise(buf, rng, SKIN_NOISE);

  // ⑤ 破损：躯干 + 两臂露皮肤（原版丧尸的「衣服破了」）
  const tearRects = [...SKIN_REGIONS.torso, ...SKIN_REGIONS.arm];
  sprinkle(buf, tearRects, SKIN_PALETTE.skin, SKIN_TEAR_RATIO, rng);

  // ⑥ 腐斑：头部
  sprinkle(buf, SKIN_REGIONS.head, SKIN_PALETTE.rot, SKIN_ROT_RATIO, rng);

  // ⑦ 五官（最后画，不被噪声/破损盖掉）
  drawEyes(buf);
  drawMouth(buf);

  fs.writeFileSync(SKIN_PNG, PNG.sync.write(buf));

  const fingerprint = skinInputFingerprint();
  fs.writeFileSync(SKIN_JSON, JSON.stringify({
    width: SKIN_SIZE,
    height: SKIN_SIZE,
    layout: SKIN_LAYOUT_VERSION,
    regions: SKIN_REGIONS,
    eyes: SKIN_EYES,
    fingerprint,
  }, null, 2) + '\n');

  // 摘要（含四区均值 —— 标定三区色距时直接读这里，不必另写脚本）
  const means = {};
  for (const [name, rects] of Object.entries(SKIN_REGIONS)) {
    let sr = 0, sg = 0, sb = 0, n = 0;
    for (const r of rects) {
      for (let y = r.y0; y < r.y1; y++) {
        for (let x = r.x0; x < r.x1; x++) {
          const [rr, gg, bb] = get(buf, x, y);
          sr += rr; sg += gg; sb += bb; n++;
        }
      }
    }
    means[name] = [Math.round(sr / n), Math.round(sg / n), Math.round(sb / n)];
  }
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]).toFixed(1);
  console.log(`[zombieskin] 烘焙完成：assets/zombie/skin.png ${SKIN_SIZE}×${SKIN_SIZE}`);
  console.log(`[zombieskin]   版式 ${SKIN_LAYOUT_VERSION} / 眼睛 ${SKIN_EYES.length} 只`);
  console.log(`[zombieskin]   区均值 head=${means.head} torso=${means.torso} `
    + `arm=${means.arm} leg=${means.leg}`);
  console.log(`[zombieskin]   色距 head-torso=${dist(means.head, means.torso)} `
    + `torso-leg=${dist(means.torso, means.leg)} head-leg=${dist(means.head, means.leg)}`);
  console.log(`[zombieskin]   指纹 ${fingerprint}`);
}

main();
