// tools/bake-stone-bricks.mjs — 原版石砖三变体 + 紫珀方块贴图烘焙（v3.19）
//
// 用法：npm run stonebricks
// 产物：assets/textures/{mossy_stone_bricks,cracked_stone_bricks,chiseled_stone_bricks,purpur_block}.png
//       + assets/textures/stone_bricks.meta.json（尺寸 / 均值 / 指纹）
// 之后必须：npm run atlas（入世界图集）+ npm run icons（背包图标）
//
// ## 两条烘焙路径（判据不同，不可混用）
//
// **① remap（三张石砖）**：源图取 blockrender.dev 的 16×16 vanilla 贴图，
// 按 Minecraft Wiki 现版**方块渲染图顶面**反解出的逐色映射换色。
// 为什么要换：两者图案逐格一致但色板差一层（实测 mossy 的 `8b898b` vs 渲染图 `888688`）。
// 判据 = **图案分区签名逐格不变**（`patternSignature`）+ 均值命中标定值。
// ⚠️ 只比「色数」对图案打乱零判别力（本仓既有教训）。
//
// **② texel（purpur）**：用户给的 512×512 放大图按 texel 中心取样降回 16×16。
// 判据 = 每 texel 中心色 == 该 texel 区域众数（函数内 throw）+ alpha 全 255 + 均值命中。
// ⚠️ 配色**保留用户图**（比 vanilla 暗一档）—— 用户指定「面用的图是这张」。
//
// 素材出处与许可：assets/stone-bricks/src/README.md
// 设计：docs/superpowers/specs/2026-11-19-original-stone-bricks-and-purpur-design.md §5.2
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import {
  STONE_BRICK_TEXTURES, STONE_BRICK_TILE_SIZE, STONE_BRICK_TARGET_MEAN,
  STONE_BRICKS_META, PURPUR_DOWNSAMPLE, TOP_FACE_GEOM,
  stoneBrickSourcePath, stoneBrickReferencePath, stoneBrickOutputPath,
  stoneBricksInputFingerprint, fileSha256,
  topFaceColorMap, remapPalette, downsampleByTexelCenter, patternSignature, meanRgb,
} from './stone-bricks-fingerprint.mjs';

const SIZE = STONE_BRICK_TILE_SIZE;

function readPng(file) {
  if (!fs.existsSync(file)) throw new Error(`素材缺失：${file}（入库文件，缺失 = 仓库损坏）`);
  return PNG.sync.read(fs.readFileSync(file));
}

function writePng(file, img) {
  const out = new PNG({ width: img.width, height: img.height });
  out.data.set(img.data);
  fs.writeFileSync(file, PNG.sync.write(out));
}

/** 均值断言：与门禁同口径（±0.05/通道） */
function assertMean(name, img) {
  const got = meanRgb(img);
  const want = STONE_BRICK_TARGET_MEAN[name];
  const dev = got.map((v, i) => Math.abs(v - want[i]));
  if (dev.some((d) => d > 0.05)) {
    throw new Error(`${name}: 均值 ${got.map((v) => v.toFixed(4)).join('/')}`
      + ` 偏离标定 ${want.join('/')} 达 ${dev.map((d) => d.toFixed(4)).join('/')} > 0.05/通道`);
  }
  return got;
}

function bake() {
  const records = {};
  for (const [name, def] of Object.entries(STONE_BRICK_TEXTURES)) {
    const srcFile = stoneBrickSourcePath(name);
    const src = readPng(srcFile);
    let out, extra = {};

    if (def.mode === 'remap') {
      if (src.width !== SIZE || src.height !== SIZE) {
        throw new Error(`${name}: 源贴图 ${src.width}×${src.height} ≠ ${SIZE}×${SIZE}`);
      }
      const refFile = stoneBrickReferencePath(name);
      const render = readPng(refFile);
      // 反解映射（每个源色必须唯一映到一个渲染色，否则函数内 throw）
      const map = topFaceColorMap(render, src, TOP_FACE_GEOM);
      out = remapPalette(src, map);
      // **内容级判据**：图案分区逐格不变（换色不得打乱图案）
      const before = patternSignature(src);
      const after = patternSignature(out);
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        throw new Error(`${name}: 重映射后图案分区变了 —— 只允许换色值，不允许动图案`);
      }
      extra = {
        reference: def.reference,
        referenceSha256: fileSha256(refFile),
        colorMap: Object.fromEntries([...map.entries()].sort()),
        patternColors: new Set(before).size,
      };
    } else if (def.mode === 'texel') {
      out = downsampleByTexelCenter(src, PURPUR_DOWNSAMPLE);
      // alpha 必须全 255（方块贴图不透明；源图边缘的抗锯齿半透明不得带进产物）
      let translucent = 0;
      for (let i = 3; i < out.data.length; i += 4) if (out.data[i] !== 255) translucent++;
      if (translucent !== 0) throw new Error(`${name}: 产物含 ${translucent} 个非全不透明像素`);
      extra = { downsample: { ...PURPUR_DOWNSAMPLE }, sourceSize: [src.width, src.height] };
    } else {
      throw new Error(`${name}: 未知 mode ${def.mode}`);
    }

    if (out.width !== SIZE || out.height !== SIZE) {
      throw new Error(`${name}: 产物 ${out.width}×${out.height} ≠ ${SIZE}×${SIZE}`);
    }
    const mean = assertMean(name, out);
    writePng(stoneBrickOutputPath(name), out);
    const colors = new Set();
    for (let i = 0; i < out.data.length; i += 4) {
      colors.add(`${out.data[i]},${out.data[i + 1]},${out.data[i + 2]}`);
    }
    records[name] = {
      source: def.source,
      sourceSha256: fileSha256(srcFile),
      out: def.out,
      mode: def.mode,
      outSize: SIZE,
      outMean: mean.map((v) => +v.toFixed(4)),
      targetMean: [...STONE_BRICK_TARGET_MEAN[name]],
      colors: colors.size,
      ...extra,
    };
    console.log(`${name.padEnd(24)} ${def.mode.padEnd(5)} ${src.width}×${src.height} → ${SIZE}×${SIZE}`
      + `  均值 ${mean.map((v) => v.toFixed(2)).join('/')}  色数 ${colors.size}`);
  }

  const fp = stoneBricksInputFingerprint();
  fs.mkdirSync(path.dirname(STONE_BRICKS_META), { recursive: true });
  fs.writeFileSync(STONE_BRICKS_META, `${JSON.stringify({
    version: 1, tileSize: SIZE, textures: records, fingerprints: fp,
  }, null, 2)}\n`);
  console.log(`指纹 ${fp.input}`);
  console.log('⚠️ 接着必须跑：npm run atlas && npm run icons');
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(import.meta.url.replace('file://', ''));
if (invokedDirectly) bake();