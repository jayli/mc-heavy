// tools/bake-player-skin.mjs — 烘焙第一人称手臂皮肤（标准 MC 64×64 版式，只烘手臂两段）
//
// 产物：`assets/player/skin.png`（64×64）+ `assets/player/skin.json`（尺寸 / 版式 / 指纹）。
// **不放 `assets/textures/`**：那里被 `build-atlas.mjs` 递归扫描进世界 atlas，
// 手臂皮肤不属世界方块贴图（同 `assets/zombie/skin.png` 的既有口径）。
//
// ⚠️ **烘焙只是数据格式转换，不产生新美术资源**：配色与绘制规则逐条取自上游
// OpusCraft `src/textures/skin.ts` 的 `steveSkin()`，本脚本只是把「运行时逐像素绘制」
// 换成「离线烘焙 + 指纹门」（本仓皮肤类素材的既有口径）。
//
// 参数与 UV 的权威 = `tools/player-skin-fingerprint.mjs`（门禁共用同一份，它 re-export
// `src/render/view-arm.js` 的 UV 表）。
//
// **确定性**（红线 2）：所有随机用固定种子 mulberry32，禁止 `Math.random()`。
// ⚠️ 上游用 xoshiro128**，本仓用 mulberry32 ⇒ **逐像素图案不与上游逐位相同**，
// 但配色、分段位置、噪声概率三项一致 ⇒ 观感等价（不为一个素材引入第二套 PRNG）。
//
// 用法：node tools/bake-player-skin.mjs（或 npm run playerskin）
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import {
  PLAYER_SKIN_PNG, PLAYER_SKIN_JSON, PLAYER_SKIN_SIZE, PLAYER_SKIN_LAYOUT_VERSION,
  PLAYER_SKIN_PALETTE, PLAYER_SKIN_REGIONS, PLAYER_SKIN_UV,
  PLAYER_SKIN_FAR_ROWS, PLAYER_SKIN_SIDE_NOISE,
  PLAYER_SKIN_TOP_NOISE, PLAYER_SKIN_BOTTOM_NOISE,
  PLAYER_SKIN_SEED, mulberry32, playerSkinInputFingerprint,
} from './player-skin-fingerprint.mjs';

const OUT_DIR = path.dirname(PLAYER_SKIN_PNG);
const P = PLAYER_SKIN_PALETTE;
const SKIN3 = [P.skin, P.skinMid, P.skinLight];
const SHIRT3 = [P.shirt, P.shirtMid, P.shirtLight];

/** 写一个像素（越界静默跳过 —— UV 表已由单测钉在图内） */
function put(buf, x, y, rgb, alpha = 255) {
  if (x < 0 || y < 0 || x >= PLAYER_SKIN_SIZE || y >= PLAYER_SKIN_SIZE) return;
  const i = (y * PLAYER_SKIN_SIZE + x) << 2;
  buf.data[i] = rgb[0];
  buf.data[i + 1] = rgb[1];
  buf.data[i + 2] = rgb[2];
  buf.data[i + 3] = alpha;
}

function rectOf([u1, v1, u2, v2]) {
  return {
    x0: Math.min(u1, u2), x1: Math.max(u1, u2),
    y0: Math.min(v1, v2), y1: Math.max(v1, v2),
  };
}

/**
 * 上游 `fillFace(t, f, pal, r, noise)`：
 *   `k = r.next() < noise ? (r.next() < 0.5 ? 0 : 2) : 1`
 * ⇒ 以 noise 的概率取暗/亮档，否则取中档。
 */
function fillFace(buf, r, pal, rng, noise) {
  for (let y = r.y0; y < r.y1; y++) {
    for (let x = r.x0; x < r.x1; x++) {
      const k = rng() < noise ? (rng() < 0.5 ? 0 : 2) : 1;
      put(buf, x, y, pal[k]);
    }
  }
}

/**
 * 上游手臂四个侧面的逐像素规则：
 *   `pal[r.next() < 0.3 ? r.nextInt(3) : 1]`
 * ⇒ 30% 取随机档、70% 取中档。
 *
 * ⚠️ **v3.46b 起整条 12 行都是肤色**（用户 2026-11-27：「手臂前方的蓝色部分
 * 也烘焙成跟手臂一样的色调，不然看起来感觉怪怪的」）。
 * 上游原本是 `y < 4 ? shirt : skin`（短袖），但那 4 行落在几何 y 最大端，
 * 而那一端实测 **z=−1.095（更远）/ y=−0.438（更高）** ⇒ 就是屏幕上**朝前的远端**
 *（探针实测：teal 12500 像素全在沿长轴的 bin 8~9）。
 */
function fillSide(buf, r, rng) {
  for (let y = r.y0; y < r.y1; y++) {
    for (let x = r.x0; x < r.x1; x++) {
      const k = rng() < PLAYER_SKIN_SIDE_NOISE ? Math.floor(rng() * 3) : 1;
      put(buf, x, y, SKIN3[Math.min(2, k)]);
    }
  }
}

/** 整段单色三档抖动（袖子层用：上游该段未绘制，本仓补成衬衫色，见设计稿 §4.4） */
function fillSolid(buf, r, pal, rng, noise) {
  fillFace(buf, r, pal, rng, noise);
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const buf = new PNG({ width: PLAYER_SKIN_SIZE, height: PLAYER_SKIN_SIZE });
  const rng = mulberry32(PLAYER_SKIN_SEED);

  // ① 整图透明（本仓只渲染手臂，其余区域是死像素 —— 留透明比铺基色更诚实：
  //    万一 UV 写错落到别的部件区，会渲染成透明而不是「看起来对的肤色」）。
  for (let y = 0; y < PLAYER_SKIN_SIZE; y++) {
    for (let x = 0; x < PLAYER_SKIN_SIZE; x++) put(buf, x, y, [0, 0, 0], 0);
  }

  // ② 基础层（arm）：**四侧面整条 12 行都是肤色**（v3.46b 用户裁定）。
  // 顶面 py（朝前的远端）与底面 ny（近端）同样用肤色 —— 否则端面会成为新的异色块。
  const arm = PLAYER_SKIN_UV.arm;
  for (const f of ['px', 'nx', 'pz', 'nz']) {
    fillSide(buf, rectOf(arm[f]), rng);
  }
  fillFace(buf, rectOf(arm.py), SKIN3, rng, PLAYER_SKIN_TOP_NOISE);
  fillFace(buf, rectOf(arm.ny), SKIN3, rng, PLAYER_SKIN_BOTTOM_NOISE);

  // ③ 外套层（sleeve）：**整段透明**（= 上游真实行为）。
  //
  // ☠️☠️ 历史：袖子盒是 `inflate 0.25` 的**外包盒**。整段涂实 ⇒ 它把下面的手臂
  // 完全遮住（实测 19550 个手臂像素全是 teal、肤色 0）；只涂袖口 4 行 ⇒ 朝前的
  // 远端变成蓝色块（用户：「看起来感觉怪怪的」）。
  // ⇒ v3.46b 回到上游口径：**overlay 段不写**，屏幕上就是一条完整的肤色手臂。
  //
  // ⚠️ **几何仍保留袖子盒**（形状与上游一致，48 顶点），只是全透明。
  // 材质必须保留 `alphaTest`，否则透明像素会被当成**黑色实心**把整条手臂盖死。
  // （不写任何像素 ⇒ 保持步骤 ① 铺的 alpha=0。）

  fs.writeFileSync(PLAYER_SKIN_PNG, PNG.sync.write(buf));

  const fingerprint = playerSkinInputFingerprint();
  fs.writeFileSync(PLAYER_SKIN_JSON, JSON.stringify({
    width: PLAYER_SKIN_SIZE,
    height: PLAYER_SKIN_SIZE,
    layout: PLAYER_SKIN_LAYOUT_VERSION,
    regions: PLAYER_SKIN_REGIONS,
    fingerprint,
  }, null, 2) + '\n');

  // 摘要：**远端段 vs 近端段**的均值（v3.46b：两段都是肤色，色距应接近 0）
  // ⚠️ 分区仍按「侧面上 4 行 vs 其余」切 —— 它现在是**回归门**：
  // 若有人把袖口改回衬衫色，这两段的色距会从 ~2 跳到 ~188。
  const meanOf = (rects) => {
    let sr = 0, sg = 0, sb = 0, n = 0;
    for (const r of rects) {
      for (let y = r.y0; y < r.y1; y++) {
        for (let x = r.x0; x < r.x1; x++) {
          const i = (y * PLAYER_SKIN_SIZE + x) << 2;
          sr += buf.data[i]; sg += buf.data[i + 1]; sb += buf.data[i + 2]; n++;
        }
      }
    }
    return [Math.round(sr / n), Math.round(sg / n), Math.round(sb / n)];
  };
  const sideRects = ['px', 'nx', 'pz', 'nz'].map((f) => rectOf(arm[f]));
  const far = sideRects.map((r) => ({ ...r, y1: r.y0 + PLAYER_SKIN_FAR_ROWS }));
  const near = sideRects.map((r) => ({ ...r, y0: r.y0 + PLAYER_SKIN_FAR_ROWS }));
  const mf = meanOf(far); const mn = meanOf(near);
  const dist = Math.hypot(mf[0] - mn[0], mf[1] - mn[1], mf[2] - mn[2]).toFixed(1);
  // 外套层透明度（应恒 0）
  const sleeveRects = ['px', 'nx', 'pz', 'nz', 'py', 'ny'].map((f) => rectOf(PLAYER_SKIN_UV.sleeve[f]));
  let sleeveOpaque = 0;
  for (const r of sleeveRects) {
    for (let y = r.y0; y < r.y1; y++) {
      for (let x = r.x0; x < r.x1; x++) {
        if (buf.data[(y * PLAYER_SKIN_SIZE + x) * 4 + 3] > 0) sleeveOpaque++;
      }
    }
  }
  console.log(`[playerskin] 烘焙完成：assets/player/skin.png ${PLAYER_SKIN_SIZE}×${PLAYER_SKIN_SIZE}`);
  console.log(`[playerskin]   版式 ${PLAYER_SKIN_LAYOUT_VERSION} / 全肤色（无袖口）`);
  console.log(`[playerskin]   远端均值 ${mf} / 近端均值 ${mn} / 色距 ${dist}（应 ≈ 0）`);
  console.log(`[playerskin]   外套层不透明像素 ${sleeveOpaque}（应 = 0）`);
  console.log(`[playerskin]   指纹 ${fingerprint}`);
}

main();