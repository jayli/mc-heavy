// tools/bake-turret-armor.mjs — 烘焙炮塔装甲纹理为单张多区 PNG（确定性）
// mc-lite 用「8 部件 mesh + 材质数组 + 三张贴图」（`Turret.js:47-80`）。本仓库的 WebGPU
// 后端**不支持** InstancedMesh + 材质数组 + geometry.groups（`three.webgpu.js:34592`
// `getMaterial()` 直接 return material，不遍历 groups、不取 materialIndex → 六面恒用
// `material[0]`，静默只渲染第一张）。故改走**单材质 + 单纹理 + UV 分区**（M6 丧尸头部同手法）。
// 产物：`assets/turret/armor.png`（192×64，三区横向并排）+ `armor.json`（尺寸 + 输入指纹）。
// 用法：node tools/bake-turret-armor.mjs（或 npm run turret）
import { PNG } from 'pngjs';
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import {
  ARMOR_TEXTURE_CONFIG, ARMOR_WIDTH, ARMOR_HEIGHT, ARMOR_PNG, ARMOR_JSON,
  ARMOR_SOURCES, armorInputFingerprint,
} from './turret-armor-fingerprint.mjs';

/**
 * JPEG 解码：node 侧无原生 JPEG 解码器 → 用 Playwright 的 chromium 离屏 canvas 解码 +
 * nearest 降采样（避免引入新依赖；playwright 已是本仓依赖）。
 * ⚠️ `imageSmoothingEnabled=false` = nearest 降采样，与 mc-lite 的 `NearestFilter` 一致
 * （保像素风；区域平均会糊）。
 * @returns {Promise<{data: Uint8Array, width: number, height: number}>} RGBA
 */
async function decodeAndResize(browser, srcPath, size) {
  const page = await browser.newPage();
  const b64 = fs.readFileSync(srcPath).toString('base64');
  const ext = srcPath.endsWith('.jpeg') ? 'jpeg' : 'jpg';
  const rgba = await page.evaluate(async ({ b64, ext, size }) => {
    const img = new Image();
    img.src = `data:image/${ext};base64,${b64}`;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = size; canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;   // nearest 降采样
    ctx.drawImage(img, 0, 0, size, size);
    return Array.from(ctx.getImageData(0, 0, size, size).data);
  }, { b64, ext, size });
  await page.close();
  return { data: new Uint8Array(rgba), width: size, height: size };
}

async function main() {
  const out = new PNG({ width: ARMOR_WIDTH, height: ARMOR_HEIGHT });
  const browser = await chromium.launch();
  try {
    // 区序固定 front / side / top（与渲染层 ARMOR_ZONES 同序 —— 改区序须同步改渲染层）
    for (let i = 0; i < ARMOR_TEXTURE_CONFIG.zones.length; i++) {
      const zone = ARMOR_TEXTURE_CONFIG.zones[i];
      const img = await decodeAndResize(browser, ARMOR_SOURCES[zone], ARMOR_TEXTURE_CONFIG.zoneSize);
      const x0 = i * ARMOR_TEXTURE_CONFIG.zoneSize;
      for (let y = 0; y < ARMOR_HEIGHT; y++) {
        for (let x = 0; x < ARMOR_TEXTURE_CONFIG.zoneSize; x++) {
          const src = (y * ARMOR_TEXTURE_CONFIG.zoneSize + x) * 4;
          const dst = (y * ARMOR_WIDTH + x0 + x) * 4;
          out.data[dst] = img.data[src];
          out.data[dst + 1] = img.data[src + 1];
          out.data[dst + 2] = img.data[src + 2];
          out.data[dst + 3] = img.data[src + 3];   // 源图无 alpha → 255
        }
      }
    }
  } finally {
    await browser.close();
  }
  fs.mkdirSync(path.dirname(ARMOR_PNG), { recursive: true });
  fs.writeFileSync(ARMOR_PNG, PNG.sync.write(out));
  fs.writeFileSync(ARMOR_JSON, JSON.stringify({
    width: ARMOR_WIDTH, height: ARMOR_HEIGHT,
    zones: ARMOR_TEXTURE_CONFIG.zones, zoneSize: ARMOR_TEXTURE_CONFIG.zoneSize,
    fingerprint: armorInputFingerprint(),
  }, null, 2));
  console.log(`[turret-armor] 烘焙完成 ${ARMOR_WIDTH}×${ARMOR_HEIGHT}（${ARMOR_TEXTURE_CONFIG.zones.join('/')}）`);
}
main().catch((err) => { console.error(err); process.exit(1); });
