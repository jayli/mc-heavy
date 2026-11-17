// tools/bake-grass-textures.mjs — 深草/浅草方块贴图烘焙（浅水高台 Epic）
// 用法：npm run grasstextures
//       产物 assets/textures/procedural/dark_grass.png + light_grass.png（16×16）
//       + procedural/grass_textures.meta.json（尺寸 + 输入指纹）
//
// ## 为什么必须盒式平均，不能直接 nearest 缩到 16×16
// 源图 736×736 → 16×16 是 **46 倍**降采样。nearest 只取 1/2116 的像素 —— 原图那套
// 柔和的色阶层次会变成随机跳变（观感是噪点，不是草皮）。盒式平均保住均值与明暗层次。
//
// ## 为什么 46 是精确整除的
// `736 = 46 × 16`。每个目标像素恰好是源图一个 46×46 方块的均值 ——
// 无余数、无边界特判、无重采样相位误差。换源图后 `boxDownsample` 会因非整除而 throw。
//
// ## 源 jpg 保持不动
// 与树叶孔洞压缩、巨树贴图同一口径：源素材是入库的原始资产，产物落 `procedural/`。
// 指纹记录源图 sha256，`check:data` 的 `[草贴图]` 环节用它抓「产物过期」。
//
// ## ⚠️ 本仓没有 jpeg 解码器
// `node_modules` 里只有 `pngjs`（读不了 JPEG）。源图是 `.jpg` → 烘焙前必须先把它转成
// 同名 `.png` 中间物（macOS 自带 `sips` 即可）。转换产物**不入库**（`.gitignore` 掉），
// 缺了会被下面的报错提示拦住，不会静默产出错贴图。
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import {
  GRASS_TEXTURES, GRASS_TILE_SIZE, GRASS_META, ROOT,
  sourcePath, outputPath, fileSha256, grassTextureInputFingerprint,
  GRASS_TINT, TINTED_TEXTURES, tintedSourcePath, tintedBasePath, tintedOutputPath,
  TINTED_TARGET_MEAN,
} from './grass-textures-fingerprint.mjs';
import { applyTint, retintFringe } from '../src/voxel/tint-math.js';

const SIZE = GRASS_TILE_SIZE;

/**
 * JPEG 尺寸读取（只解析 SOF 段头，不解码像素）—— 用来校验 PNG 中间物与源图同尺寸，
 * 并给「缺 PNG 中间物」的报错附上正确尺寸。
 * @param {string} file @returns {{width:number, height:number}}
 */
function jpegSize(file) {
  const b = fs.readFileSync(file);
  let i = 2;
  while (i < b.length - 8) {
    if (b[i] !== 0xff) { i++; continue; }
    const m = b[i + 1];
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    }
    i += 2 + b.readUInt16BE(i + 2);
  }
  throw new Error(`${file}: 找不到 JPEG SOF 段`);
}

/**
 * 把源图按 `factor × factor` 盒式平均降采样到 16×16。
 *
 * ⚠️ **必须是精确整除**：非整除时盒与盒之间会留下未采样的缝隙（或重叠），均值系统性偏移。
 * 源图 736 = 46 × 16 恰好成立；换源图后这条断言会立刻失败，提示重新标定。
 *
 * @param {{data:Uint8Array|Buffer, width:number, height:number}} src
 * @returns {PNG}
 */
export function boxDownsample(src) {
  const factorX = src.width / SIZE;
  const factorY = src.height / SIZE;
  if (!Number.isInteger(factorX) || !Number.isInteger(factorY)) {
    throw new Error(`源图 ${src.width}×${src.height} 不能被 ${SIZE} 整除（factor ${factorX}×${factorY}）`);
  }
  const dst = new PNG({ width: SIZE, height: SIZE });
  const n = factorX * factorY;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < factorY; sy++) {
        const rowBase = (y * factorY + sy) * src.width;
        for (let sx = 0; sx < factorX; sx++) {
          const i = (rowBase + x * factorX + sx) << 2;
          r += src.data[i]; g += src.data[i + 1]; b += src.data[i + 2]; a += src.data[i + 3];
        }
      }
      const di = (y * SIZE + x) << 2;
      dst.data[di] = Math.round(r / n);
      dst.data[di + 1] = Math.round(g / n);
      dst.data[di + 2] = Math.round(b / n);
      dst.data[di + 3] = Math.round(a / n);
    }
  }
  return dst;
}

/** PNG 逐通道均值（门禁与自检共用）。只算不透明像素（alpha>=8）——
 *  植被贴图有大量全透明格，把它们算进去会把均值拉向 0。 */
export function meanRgb(png) {
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < png.data.length; i += 4) {
    if (png.data[i + 3] < 8) continue;
    r += png.data[i]; g += png.data[i + 1]; b += png.data[i + 2]; n++;
  }
  return n ? [r / n, g / n, b / n] : [0, 0, 0];
}

/**
 * 读源图的**像素**：优先同名 PNG 中间物（本仓没有 jpeg 解码器）。
 * @param {string} jpgPath
 */
function loadSourcePixels(jpgPath) {
  const pngPath = jpgPath.replace(/\.jpg$/i, '.png');
  const size = jpegSize(jpgPath);
  if (!fs.existsSync(pngPath)) {
    throw new Error(
      `源图像素需要先转成 PNG（本仓没有 jpeg 解码器）：\n`
      + `  sips -s format png "${jpgPath}" --out "${pngPath}"\n`
      + `（源尺寸 ${size.width}×${size.height}；转换后重跑本脚本）`,
    );
  }
  const png = PNG.sync.read(fs.readFileSync(pngPath));
  if (png.width !== size.width || png.height !== size.height) {
    throw new Error(`${path.basename(pngPath)} 尺寸 ${png.width}×${png.height} ≠ 源 jpg ${size.width}×${size.height}`);
  }
  return png;
}

function bake() {
  fs.mkdirSync(path.dirname(GRASS_META), { recursive: true });
  const records = {};
  const tintedRecords = {};
  for (const name of Object.keys(GRASS_TEXTURES)) {
    const jpg = sourcePath(name);
    if (!fs.existsSync(jpg)) throw new Error(`源图不存在：${GRASS_TEXTURES[name].source}`);
    const src = loadSourcePixels(jpg);
    const out = boxDownsample(src);
    fs.writeFileSync(outputPath(name), PNG.sync.write(out));

    const srcMean = meanRgb(src);
    const outMean = meanRgb(out);
    const delta = srcMean.map((v, i) => Math.abs(v - outMean[i]));
    // 盒式平均的均值偏差应当极小（理论 ≤0.5/通道，只剩整数取整误差）。超过 2 说明算法错了。
    if (delta.some((d) => d > 2)) {
      throw new Error(`${name}：降采样后均值偏离源图 ${delta.map((d) => d.toFixed(2)).join('/')} > 2/通道 —— 算法有问题`);
    }
    records[name] = {
      source: GRASS_TEXTURES[name].source,
      sourceSize: [src.width, src.height],
      sourceSha256: fileSha256(jpg),
      out: `procedural/${GRASS_TEXTURES[name].out}`,
      outSize: SIZE,
      factor: src.width / SIZE,
      sourceMean: srcMean.map((v) => +v.toFixed(2)),
      outMean: outMean.map((v) => +v.toFixed(2)),
      delta: delta.map((v) => +v.toFixed(2)),
    };
    console.log(`${name.padEnd(12)} ${src.width}×${src.height} → ${SIZE}×${SIZE} `
      + `(×${src.width / SIZE} 盒式平均)  均值 ${outMean.map((v) => v.toFixed(0)).join('/')}  `
      + `偏差 ${delta.map((v) => v.toFixed(2)).join('/')}`);
  }
  // ---- 着色类产物（v3.12）----
  // 与上面的盒式平均是**两条不同路径**：这里的均值必然偏离源图（那就是着色），
  // 故**不能复用「偏差 ≤2/通道」那条断言** —— 它会把正常着色判成算法错误。
  // 判据改为「产物均值 == 预先标定的目标值」（TINTED_TARGET_MEAN，与门禁共用）。
  for (const [name, def] of Object.entries(TINTED_TEXTURES)) {
    const srcFile = tintedSourcePath(name);
    if (!fs.existsSync(srcFile)) throw new Error(`vanilla 源图不存在：${def.source}`);
    const src = PNG.sync.read(fs.readFileSync(srcFile));
    if (src.width !== SIZE || src.height !== SIZE) {
      throw new Error(`${name}: vanilla 源图 ${src.width}×${src.height} ≠ ${SIZE}×${SIZE}`);
    }
    let pixels;
    let baseSha;
    if (def.mode === 'tint') {
      pixels = applyTint(src, GRASS_TINT).data;
    } else if (def.mode === 'fringe') {
      const baseFile = tintedBasePath(name);
      if (!fs.existsSync(baseFile)) throw new Error(`${name}: 缺 base ${def.base}`);
      const base = PNG.sync.read(fs.readFileSync(baseFile));
      pixels = retintFringe(base, src, GRASS_TINT).data;
      baseSha = fileSha256(baseFile);
    } else if (def.mode === 'copy') {
      pixels = src.data;
    } else {
      throw new Error(`${name}: 未知 mode ${def.mode}`);
    }
    const out = new PNG({ width: SIZE, height: SIZE });
    out.data.set(pixels);
    const outFile = tintedOutputPath(name);
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, PNG.sync.write(out));

    const outMean = meanRgb(out);
    const target = TINTED_TARGET_MEAN[name];
    const dev = outMean.map((v, i) => Math.abs(v - target[i]));
    if (dev.some((d) => d > 0.05)) {
      throw new Error(`${name}: 产物均值 ${outMean.map((v) => v.toFixed(2)).join('/')}`
        + ` 偏离目标 ${target.join('/')} 达 ${dev.map((d) => d.toFixed(2)).join('/')} > 0.05/通道`);
    }
    // fringe 模式的内容级判据：非草沿区必须逐字节不变（指纹拓不到这条）
    let untouchedDiff = 0;
    if (def.mode === 'fringe') {
      const base = PNG.sync.read(fs.readFileSync(tintedBasePath(name)));
      for (let i = 0; i < pixels.length; i += 4) {
        if (src.data[i + 3] > 0) continue;
        for (let c = 0; c < 3; c++) if (pixels[i + c] !== base.data[i + c]) untouchedDiff++;
      }
      if (untouchedDiff !== 0) {
        throw new Error(`${name}: 非草沿区被改动了 ${untouchedDiff} 个字节 —— base 用错了（不能用 dirt.png）`);
      }
    }
    tintedRecords[name] = {
      source: def.source,
      sourceSha256: fileSha256(srcFile),
      base: def.base ?? null,
      baseSha256: baseSha ?? null,
      out: def.out,
      mode: def.mode,
      tint: [...GRASS_TINT],
      outMean: outMean.map((v) => +v.toFixed(2)),
      targetMean: target,
      untouchedDiff,
    };
    console.log(`${name.padEnd(28)} ${def.mode.padEnd(6)} 均值 ${outMean.map((v) => v.toFixed(2)).join('/')}`
      + (def.mode === 'fringe' ? `  非草沿区改动 ${untouchedDiff} 字节` : ''));
  }

  const fp = grassTextureInputFingerprint();
  fs.writeFileSync(GRASS_META, `${JSON.stringify({
    version: 1, tileSize: SIZE, textures: records, tinted: tintedRecords, fingerprints: fp,
  }, null, 2)}\n`);
  console.log(`指纹 ${fp.input}`);
  console.log(`meta → ${path.relative(ROOT, GRASS_META)}`);
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(import.meta.url.replace('file://', ''));
if (invokedDirectly) bake();
