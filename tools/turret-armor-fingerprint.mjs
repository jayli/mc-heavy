// tools/turret-armor-fingerprint.mjs — 炮塔装甲纹理的参数与输入指纹
//
// **两个消费者共用同一份逻辑**（红线 1），沿用 `zombie-skin-fingerprint.mjs` 的模式：
//   - `tools/bake-turret-armor.mjs` 烘焙时按本参数生成并写进 `assets/turret/armor.json`
//   - `tools/check-data.mjs` 用当前参数重算并比对 → 不匹配即报「跑 npm run turret」
//
// 纹理是**派生产物**，权威输入是本文件的参数 + 三张源图内容。改了源图/参数却忘跑烘焙，
// 纹理会**静默过期**（渲染旧图案，肉眼只觉得「颜色怪怪的」）—— 与图标过期同一条失效路径。
//
// node 侧模块（要读 PNG/JPEG 文件），不进 src/，浏览器不消费。
import { PNG } from 'pngjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 产物路径（烘焙脚本与门禁共用，避免两处各写一份） */
export const ARMOR_PNG = path.join(__dirname, '..', 'assets', 'turret', 'armor.png');
export const ARMOR_JSON = path.join(__dirname, '..', 'assets', 'turret', 'armor.json');
/** 三张源贴图（从 mc-lite 拷入；front/side/top 对应 pic1/pic2/pic3） */
export const ARMOR_SOURCES = Object.freeze({
  front: path.join(__dirname, '..', 'assets', 'turret', 'turret_pic1.jpeg'),
  side: path.join(__dirname, '..', 'assets', 'turret', 'turret_pic2.jpg'),
  top: path.join(__dirname, '..', 'assets', 'turret', 'turret_pic3.jpg'),
});

/**
 * 纹理参数。区序（`ARMOR_TEXTURE_CONFIG.zones`）与渲染层的 `ARMOR_ZONES`（turret-config.js）
 * **必须一致** —— 渲染层据此把部件 UV 映射到对应区。⚠️ 本文件是烘焙侧的区序副本，
 * `check:data` 的 `[炮塔装甲]` 环节会断言两侧一致（见 check-data 的门禁）。
 */
export const ARMOR_TEXTURE_CONFIG = Object.freeze({
  /** 单区尺寸（源图最大边归一化到此尺寸，nearest 降采样保像素风） */
  zoneSize: 64,
  /** 区序（与 turret-config.js 的 ARMOR_ZONES 同序） */
  zones: Object.freeze(['front', 'side', 'top']),
});
export const ARMOR_WIDTH = ARMOR_TEXTURE_CONFIG.zoneSize * ARMOR_TEXTURE_CONFIG.zones.length; // 192
export const ARMOR_HEIGHT = ARMOR_TEXTURE_CONFIG.zoneSize;                                     // 64

/**
 * 输入指纹：三张源图的内容哈希 + 区参数。源图换了而忘重烘焙 → 门禁报错。
 * 简单内容哈希（长度 + 每 997 字节取样）—— 够用于「源图是否变了」判定。
 * @returns {string}
 */
export function armorInputFingerprint() {
  const parts = [];
  for (const zone of ARMOR_TEXTURE_CONFIG.zones) {
    const src = ARMOR_SOURCES[zone];
    if (!fs.existsSync(src)) throw new Error(`[炮塔装甲] 源贴图缺失：${src}`);
    const buf = fs.readFileSync(src);
    let h = buf.length;
    for (let i = 0; i < buf.length; i += 997) h = (h * 31 + buf[i]) >>> 0;
    parts.push(`${zone}:${h}`);
  }
  parts.push(`size:${ARMOR_WIDTH}x${ARMOR_HEIGHT}`);
  parts.push(`zones:${ARMOR_TEXTURE_CONFIG.zones.join('/')}`);
  return parts.join('|');
}

/** 读产物 PNG（门禁比对尺寸与指纹用）；不存在返回 null */
export function readArmorPng() {
  if (!fs.existsSync(ARMOR_PNG)) return null;
  return PNG.sync.read(fs.readFileSync(ARMOR_PNG));
}
