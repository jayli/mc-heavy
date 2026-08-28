// tools/bake-procedural-textures.mjs — 烘焙 mc-lite 程序化材质为 PNG（确定性）
// mc-lite MaterialManager 中约 17 种方块的贴图是运行时 canvas 程序化绘制（mkMat/
// mkProceduralMat/mkDetailMat），无 PNG 文件。mc-heavy 走 atlas 单材质管线，
// 需要离线烘焙成 PNG 入图。本脚本逐行复刻 mc-lite 的绘制参数（64×64 画布），
// 随机源用固定种子 mulberry32（mc-lite 用 Math.random，每次加载都不同；
// mc-heavy 红线要求确定性生成，固定种子取其中一种稳定形态）。
// 用法：node tools/bake-procedural-textures.mjs（产物 assets/textures/procedural/*.png，
// 随后 npm run atlas 入图）。
import { PNG } from 'pngjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, '..', 'assets', 'textures', 'procedural');
const SIZE = 64; // mc-lite 程序化纹理画布尺寸（MaterialManager.js:282-283）

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function makeBuf() {
  return new PNG({ width: SIZE, height: SIZE });
}

function fillRect(buf, x, y, w, h, [r, g, b], a = 255) {
  for (let py = Math.max(0, y); py < Math.min(SIZE, y + h); py++) {
    for (let px = Math.max(0, x); px < Math.min(SIZE, x + w); px++) {
      const i = (py * SIZE + px) << 2;
      // alpha over 合成
      const sa = a / 255, da = buf.data[i + 3] / 255;
      const oa = sa + da * (1 - sa);
      if (oa > 0) {
        buf.data[i] = Math.round((r * sa + buf.data[i] * da * (1 - sa)) / oa);
        buf.data[i + 1] = Math.round((g * sa + buf.data[i + 1] * da * (1 - sa)) / oa);
        buf.data[i + 2] = Math.round((b * sa + buf.data[i + 2] * da * (1 - sa)) / oa);
      }
      buf.data[i + 3] = Math.round(oa * 255);
    }
  }
}

function fillAll(buf, rgb, a = 255) { fillRect(buf, 0, 0, SIZE, SIZE, rgb, a); }

// mc-lite mkMat 的噪点：100 个 2×2 黑色半透明点（MaterialManager.js:522-525）
function addNoise(buf, rng) {
  for (let i = 0; i < 100; i++) {
    const a = Math.round(rng() * 0.15 * 255);
    fillRect(buf, Math.floor(rng() * SIZE), Math.floor(rng() * SIZE), 2, 2, [0, 0, 0], a);
  }
}

// 实心圆（逐像素，canvas arc+fill 语义）
function fillCircle(buf, cx, cy, r, rgb, a = 255) {
  for (let py = 0; py < SIZE; py++) {
    for (let px = 0; px < SIZE; px++) {
      const dx = px + 0.5 - cx, dy = py + 0.5 - cy;
      if (dx * dx + dy * dy <= r * r) fillRect(buf, px, py, 1, 1, rgb, a);
    }
  }
}

// 扇形（canvas beginPath+arc(start,end)+fill 的饼形语义）
function fillPie(buf, cx, cy, r, startRad, endRad, rgb) {
  for (let py = 0; py < SIZE; py++) {
    for (let px = 0; px < SIZE; px++) {
      const dx = px + 0.5 - cx, dy = py + 0.5 - cy;
      if (dx * dx + dy * dy > r * r) continue;
      let ang = Math.atan2(dy, dx); // canvas y 向下，atan2(dy,dx) 即画布角
      if (ang < 0) ang += Math.PI * 2;
      // 归一化到 [start, start+2π)，落在 [start,end] 内则填充
      let rel = ang - startRad;
      while (rel < 0) rel += Math.PI * 2;
      if (rel <= endRad - startRad) fillRect(buf, px, py, 1, 1, rgb);
    }
  }
}

// 三次贝塞尔描边（lineWidth 3 → 3×3 笔刷；采样 256 段）
function strokeBezier(buf, p0, p1, p2, p3, rgb, width = 3) {
  const half = Math.floor(width / 2);
  for (let s = 0; s <= 256; s++) {
    const t = s / 256, mt = 1 - t;
    const x = mt * mt * mt * p0[0] + 3 * mt * mt * t * p1[0] + 3 * mt * t * t * p2[0] + t * t * t * p3[0];
    const y = mt * mt * mt * p0[1] + 3 * mt * mt * t * p1[1] + 3 * mt * t * t * p2[1] + t * t * t * p3[1];
    fillRect(buf, Math.round(x) - half, Math.round(y) - half, width, width, rgb);
  }
}

// ---- mc-lite mkMat（纯色 + 噪点）----
function bakeMat(color, seed) {
  const buf = makeBuf();
  fillAll(buf, hexToRgb(color));
  addNoise(buf, mulberry32(seed));
  return buf;
}

// ---- mc-lite mkProceduralMat（底色 + 斑点）----
function bakeProceduralMat(baseColor, spotColor, spotSize, seed) {
  const buf = makeBuf();
  const rng = mulberry32(seed);
  fillAll(buf, hexToRgb(baseColor));
  const spotRgb = hexToRgb(spotColor);
  const count = Math.floor(100 / spotSize);
  for (let i = 0; i < count; i++) {
    fillRect(buf, Math.floor(rng() * SIZE), Math.floor(rng() * SIZE), spotSize, spotSize, spotRgb);
  }
  return buf;
}

const textures = {};

// 大理石 / 仙人掌 / 烟囱 / 杜鹃原木 / 草底 / 沼泽草顶 / 柱子 / 天空木（mkMat 系）
textures.marble = bakeMat('#F2F0E6', 1);
textures.cactus = bakeMat('#2E8B57', 2);
textures.chimney = bakeMat('#7f5b37', 3);
textures.azalea_log = bakeMat('#635338', 4);
textures.grass_bottom = bakeMat('#559944', 5);
textures.swamp_grass_top = bakeMat('#4C5E34', 6);
textures.pillar = bakeMat('#b98e5b', 7);          // vertical_pillar
textures.pillar_horizontal = bakeMat('#b98e5b', 8); // horizontal_pillar
textures.sky_wood = bakeMat('#DDA0DD', 9);

// 空岛（M2-7，mc-lite Island.js 岛体材质：mkMat('#DDDDDD') / mkMat('#88CCFF')）
textures.sky_stone = bakeMat('#DDDDDD', 18);
textures.sky_grass = bakeMat('#88CCFF', 19);

// 天空树叶（mkMat 0.9 不透明度）
textures.sky_leaves = bakeMat('#FF69B4', 10);
{
  const buf = textures.sky_leaves;
  for (let i = 3; i < buf.data.length; i += 4) buf.data[i] = Math.round(0.9 * 255);
}

// 炮塔别名（纯颜色材质，无噪点——MaterialManager.js:947-951）
textures.turret_alias_block = (() => {
  const buf = makeBuf();
  fillAll(buf, [0x80, 0x80, 0x80]);
  return buf;
})();

// 云 / 创造台（mkMat 系，MaterialManager.js:805,945-946）
// 云不烘噪点：blur 档 mipmap 下块面 UV wrap 边界导数尖峰采样最高级 mip（整 tile 均值），
// 噪点使均值偏灰 → 大白面出现方格带；纯白令各级 mip 与基色一致（mc-lite 观感本即纯白）。
{
  const buf = makeBuf();
  fillAll(buf, hexToRgb('#FFFFFF'));
  textures.cloud = buf;
}
textures.playground_block = bakeMat('#808080', 16);
textures.playground_center_block = bakeMat('#4a90e2', 17);

// 栏杆系（mkProceduralMat：斑点大小 4 / 10）
textures.handrail = bakeProceduralMat('#b98e5b', '#8e6148', 4, 11);
textures.handrailA = bakeProceduralMat('#b98e5b', '#8e6148', 10, 12);
textures.handrailB = bakeProceduralMat('#b98e5b', '#8e6148', 10, 13);

// 藤蔓（mkDetailMat 透明底 + 5 条贝塞尔，MaterialManager.js:865-873）
textures.vine = (() => {
  const buf = makeBuf();
  const rng = mulberry32(14);
  const rgb = hexToRgb('#355E3B');
  for (let i = 0; i < 5; i++) {
    strokeBezier(
      buf,
      [10 + i * 10, 0],
      [rng() * SIZE, 20],
      [rng() * SIZE, 40],
      [10 + i * 10, SIZE],
      rgb, 3,
    );
  }
  return buf;
})();

// 睡莲（mkDetailMat 透明底 + 缺角圆，MaterialManager.js:875-877）
textures.lilypad = (() => {
  const buf = makeBuf();
  fillPie(buf, 32, 32, 28, 0.3, Math.PI * 1.8, hexToRgb('#228B22'));
  return buf;
})();

// 花（mkDetailMat 透明底 + 茎/瓣/蕊，MaterialManager.js:847-851）
textures.flower = (() => {
  const buf = makeBuf();
  fillRect(buf, 30, 24, 4, 40, hexToRgb('#2E8B57')); // 茎干
  fillCircle(buf, 32, 24, 12, hexToRgb('#FF4444'));   // 花瓣
  fillCircle(buf, 32, 24, 4, hexToRgb('#FFD700'));    // 花蕊
  return buf;
})();

// 吊灯（MaterialManager.js:1197-1219：绳 + 灯体 + 发光中心 + 高光）
textures.hanging_lamp = (() => {
  const buf = makeBuf();
  fillAll(buf, hexToRgb('#aaa49a'));
  fillRect(buf, 30, 0, 4, 20, hexToRgb('#333333'));
  fillRect(buf, 18, 20, 28, 28, hexToRgb('#FFE4B5'));
  fillRect(buf, 24, 26, 16, 16, hexToRgb('#FFF5E6'));
  fillRect(buf, 26, 28, 4, 4, hexToRgb('#FFFFFF'));
  return buf;
})();

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const [name, buf] of Object.entries(textures)) {
  fs.writeFileSync(path.join(OUT_DIR, `${name}.png`), PNG.sync.write(buf));
}
console.log(`baked ${Object.keys(textures).length} procedural textures → assets/textures/procedural/`);
