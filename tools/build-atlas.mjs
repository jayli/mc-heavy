// tools/build-atlas.mjs — 离线 atlas 打包（设计文档 §4.4.1）
// 用法：npm run atlas。产物：assets/atlas.png + assets/atlas.json。
// 规则：2048×2048；tile 间 2px gutter；shelf 装箱；>128px 的大图（handrail/pillar/
// turret/zombie_nest 等 7 张 250~362px 特殊几何/实体贴图，与代码阈值 LARGE_TILE=128 一致）
// 按 128×128 入图（nearest 采样）——2048² atlas 余量充足（全部 tile 仅占 ~13%），
// 缩到 64×64 会白白损失细节，破坏 M2 的结构轮廓/配色对比验收。
import { PNG } from 'pngjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const TEX_DIR = path.join(ROOT, 'assets', 'textures');
const SIZE = 2048;
const GUTTER = 2;
const LARGE_TILE = 128;

function collectPngs(dir, prefix = '') {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...collectPngs(path.join(dir, entry.name), rel));
    else if (entry.name.endsWith('.png')) out.push(rel);
  }
  return out.sort();
}

function readPng(file) {
  return PNG.sync.read(fs.readFileSync(file));
}

// nearest 缩放到 LARGE_TILE×LARGE_TILE（大图专用）
function downscale(src) {
  const dst = new PNG({ width: LARGE_TILE, height: LARGE_TILE });
  for (let y = 0; y < LARGE_TILE; y++) {
    for (let x = 0; x < LARGE_TILE; x++) {
      const sx = Math.floor((x / LARGE_TILE) * src.width);
      const sy = Math.floor((y / LARGE_TILE) * src.height);
      const si = (sy * src.width + sx) << 2;
      const di = (y * LARGE_TILE + x) << 2;
      dst.data[di] = src.data[si];
      dst.data[di + 1] = src.data[si + 1];
      dst.data[di + 2] = src.data[si + 2];
      dst.data[di + 3] = src.data[si + 3];
    }
  }
  return dst;
}

const atlas = new PNG({ width: SIZE, height: SIZE });
// 填不透明黑底，便于排查未覆盖区域
for (let i = 3; i < atlas.data.length; i += 4) atlas.data[i] = 255;

const tiles = {};
let shelfX = GUTTER, shelfY = GUTTER, shelfH = 0;

for (const rel of collectPngs(TEX_DIR)) {
  let img = readPng(path.join(TEX_DIR, rel));
  if (img.width > LARGE_TILE || img.height > LARGE_TILE) img = downscale(img);
  const w = img.width, h = img.height;
  if (shelfX + w + GUTTER > SIZE) { // 换行
    shelfX = GUTTER;
    shelfY += shelfH + GUTTER;
    shelfH = 0;
  }
  if (shelfY + h + GUTTER > SIZE) throw new Error(`atlas overflow at tile ${rel}`);
  PNG.bitblt(img, atlas, 0, 0, w, h, shelfX, shelfY);

  const name = rel.replace(/\.png$/, '');
  const halfTexel = 0.5 / SIZE;
  tiles[name] = {
    x: shelfX, y: shelfY, w, h,
    u0: shelfX / SIZE + halfTexel,
    v0: 1 - (shelfY + h) / SIZE + halfTexel, // PNG 行序翻转 → v 翻转
    u1: (shelfX + w) / SIZE - halfTexel,
    v1: 1 - shelfY / SIZE - halfTexel,
  };
  shelfX += w + GUTTER;
  shelfH = Math.max(shelfH, h);
}

fs.writeFileSync(path.join(ROOT, 'assets', 'atlas.png'), PNG.sync.write(atlas));
fs.writeFileSync(path.join(ROOT, 'assets', 'atlas.json'),
  JSON.stringify({ size: SIZE, gutter: GUTTER, tiles }, null, 1));
console.log(`atlas: ${Object.keys(tiles).length} tiles → assets/atlas.png (${SIZE}x${SIZE})`);
