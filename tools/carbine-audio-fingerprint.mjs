// tools/carbine-audio-fingerprint.mjs — KV-9 / 雨声烘焙产物的参数与指纹
//
// **两个消费者共用同一份逻辑**（红线 1，同 `zombie-skin-fingerprint.mjs`）：
//   · `tools/bake-carbine-audio.mjs` 渲染时按配方合成，并把指纹写进 `assets/sounds/carbine.json`
//   · `tools/check-data.mjs` 用当前配方重算并比对 → 不匹配即报「跑 npm run carbineaudio」
//
// ⚠️ **配方本体不在这里** —— 从 `src/render/carbine-audio-recipes.js` re-export
// （运行时/单测/烘焙三方读同一份）。本模块只管路径、版本与指纹算法。
//
// ⚠️ **已知盲区**（与其余烘焙指纹同类）：改**合成算法**而不动配方参数时指纹不变。
// 兜底 = 产物契约测试（时长/峰值/RMS/非静音）+ 实际试听。

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  CARBINE_AUDIO_RATE, CARBINE_AUDIO_MASTER_GAIN, NOISE_BUFFERS, REVERB_IR, MASTER_COMP,
  CARBINE_RECIPES, RAIN_STORM_RECIPE, THUNDER_RECIPE, CARBINE_AUDIO_IDS, recipeKey,
} from '../src/render/carbine-audio-recipes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 产物目录与清单路径（烘焙与门禁共用） */
export const SOUND_DIR = path.join(__dirname, '..', 'assets', 'sounds');
export const CARBINE_MANIFEST = path.join(SOUND_DIR, 'carbine.json');

/** 产物文件扩展名（wav：无损、浏览器原生解码、无需编码器依赖）。
 *  ⚠️ 权威在 `src/render/carbine-audio-ext.js`（src/ 不得 import tools/，而
 *  `audio-config.js` 也要读它）—— 这里只 re-export。 */
export { CARBINE_AUDIO_EXT } from '../src/render/carbine-audio-ext.js';
import { CARBINE_AUDIO_EXT } from '../src/render/carbine-audio-ext.js';

/**
 * 合成实现版本。改**算法**（噪声生成、包络形状、混响 IR 构造）时必须 +1 ——
 * 那是参数指纹抓不到的那一类改动，靠这个版本号强制重烘。
 */
export const CARBINE_SYNTH_VERSION = 1;

/** 固定种子（红线 2：噪声与雨点击打都必须可复现，否则每次烘焙产物都不同） */
export const CARBINE_AUDIO_SEED = 20261122;

export {
  CARBINE_AUDIO_RATE, CARBINE_AUDIO_MASTER_GAIN, NOISE_BUFFERS, REVERB_IR, MASTER_COMP,
  CARBINE_RECIPES, RAIN_STORM_RECIPE, THUNDER_RECIPE, CARBINE_AUDIO_IDS, recipeKey,
};

/** 产物文件名（`<id>.wav`） */
export function carbineAudioFileName(id) { return `${id}.${CARBINE_AUDIO_EXT}`; }

/**
 * 输入指纹 = 合成版本 + 采样率 + 种子 + 噪声 buffer 参数 + 混响 IR + 压缩器 + 全部配方。
 * @returns {string}
 */
export function carbineAudioInputFingerprint() {
  const buffers = Object.entries(NOISE_BUFFERS)
    .map(([k, v]) => `${k}:${v.kind},${v.seconds},${v.channels},${v.drops ?? 0}`).join('|');
  const ir = Object.entries(REVERB_IR)
    .map(([k, v]) => `${k}:${Array.isArray(v) ? v.join('.') : v}`).join(',');
  const comp = Object.entries(MASTER_COMP).map(([k, v]) => `${k}:${v}`).join(',');
  const recipes = CARBINE_AUDIO_IDS.map((id) => {
    const r = CARBINE_RECIPES[id]
      ?? (id === RAIN_STORM_RECIPE.id ? RAIN_STORM_RECIPE : THUNDER_RECIPE);
    return `${id}=${recipeKey(r)}`;
  }).join('|');
  return [
    `synth:${CARBINE_SYNTH_VERSION}`,
    `rate:${CARBINE_AUDIO_RATE}`,
    `gain:${CARBINE_AUDIO_MASTER_GAIN}`,
    `seed:${CARBINE_AUDIO_SEED}`,
    `buffers:${buffers}`,
    `ir:${ir}`,
    `comp:${comp}`,
    `recipes:${recipes}`,
  ].join(';');
}

/**
 * 文件内容哈希（FNV-1a 32bit，同 `zombie-skin-fingerprint.pngHash` 的手法）。
 * ⚠️ 读**原始字节**而不解码 —— wav 头里的时长/采样率变化也会被抓到。
 * @param {string} file
 * @returns {string}
 */
export function fileHash(file) {
  const buf = fs.readFileSync(file);
  let h = 0x811c9dc5;
  for (let i = 0; i < buf.length; i++) {
    h ^= buf[i];
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return (h >>> 0).toString(36);
}

/**
 * 解析 16-bit PCM wav 头 + 采样统计（产物契约测试与门禁共用）。
 *
 * ⚠️ **只支持本烘焙脚本写出的格式**（PCM s16le，单/双声道）—— 不是通用 wav 解析器。
 * 格式不符时抛错而不是静默返回 0（静默 0 会让「产物是空文件」看起来像「音量很小」）。
 *
 * @param {string} file
 * @returns {{rate:number, channels:number, frames:number, seconds:number,
 *            peak:number, rms:number, nonSilentRatio:number}}
 */
export function wavStats(file) {
  const buf = fs.readFileSync(file);
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`${file}: 不是 RIFF/WAVE`);
  }
  let off = 12;
  let fmt = null;
  let dataOff = -1;
  let dataLen = 0;
  while (off + 8 <= buf.length) {
    const tag = buf.toString('ascii', off, off + 4);
    const len = buf.readUInt32LE(off + 4);
    if (tag === 'fmt ') {
      fmt = {
        format: buf.readUInt16LE(off + 8),
        channels: buf.readUInt16LE(off + 10),
        rate: buf.readUInt32LE(off + 12),
        bits: buf.readUInt16LE(off + 22),
      };
    } else if (tag === 'data') {
      dataOff = off + 8; dataLen = len;
    }
    off += 8 + len + (len % 2);
  }
  if (!fmt || fmt.format !== 1 || fmt.bits !== 16) throw new Error(`${file}: 期望 PCM s16le`);
  if (dataOff < 0) throw new Error(`${file}: 缺 data chunk`);
  const n = Math.floor(dataLen / 2);
  let peak = 0;
  let sum2 = 0;
  let nonSilent = 0;
  for (let i = 0; i < n; i++) {
    const v = buf.readInt16LE(dataOff + i * 2) / 32768;
    const a = Math.abs(v);
    if (a > peak) peak = a;
    sum2 += v * v;
    if (a > 1 / 32768) nonSilent++;
  }
  const frames = Math.floor(n / fmt.channels);
  return {
    rate: fmt.rate, channels: fmt.channels, frames,
    seconds: frames / fmt.rate,
    peak, rms: Math.sqrt(sum2 / Math.max(1, n)),
    nonSilentRatio: nonSilent / Math.max(1, n),
  };
}