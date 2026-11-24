// tools/footstep-water-fingerprint.mjs — 水中跑动脚步声烘焙产物的路径、指纹与 wav 读写
//
// **两个消费者共用同一份逻辑**（红线 1，同 `carbine-audio-fingerprint.mjs`）：
//   · `tools/bake-footstep-water.mjs` 按配方烘焙，把指纹写进 `assets/sounds/footstep-water.json`
//   · `tools/check-data.mjs` 用当前配方重算并比对 → 不匹配即报「跑 npm run footstepwater」
//
// ⚠️ **配方本体不在这里** —— 从 `src/render/footstep-water-recipe.js` re-export。
// 本模块只管路径、版本、指纹算法与 wav 编解码。
//
// ⚠️ **已知盲区**（与其余烘焙指纹同类）：改**算法**而不动参数时参数指纹不变 ⇒
// 用 `FOOTSTEP_WATER_IMPL_VERSION` 强制重烘，并靠产物契约（步数 / 步频 / 无缝性）兜住。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  FOOTSTEP_WATER_RATE, FOOTSTEP_WATER_SOURCE, FOOTSTEP_WATER_SOURCE_WAV,
  FOOTSTEP_WATER_SOURCE_SHA256, FOOTSTEP_WATER_PRODUCT_SHA256, GAIT_CYCLE_SECONDS, FOOTSTEP_WATER_PERIOD,
  FOOTSTEP_WATER_STEPS, FOOTSTEP_WATER_GRAIN_SECONDS, FOOTSTEP_WATER_GRAIN_PRE_SECONDS,
  FOOTSTEP_WATER_TAIL_FADE_SECONDS, FOOTSTEP_WATER_GRAINS, FOOTSTEP_WATER_ALT,
  FOOTSTEP_WATER_NORM_POWER, FOOTSTEP_WATER_EQ, FOOTSTEP_WATER_TARGET_RMS,
  FOOTSTEP_WATER_IMPL_VERSION, FOOTSTEP_WATER_WARMUP_LOOPS, FOOTSTEP_WATER_RENDER_LOOPS,
  footstepWaterPeriodSamples, footstepWaterLoopSamples,
} from '../src/render/footstep-water-recipe.js';
import { FOOTSTEP_WATER_EXT } from '../src/render/footstep-water-ext.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(__dirname, '..');
export const SOUND_DIR = path.join(ROOT, 'assets', 'sounds');
export const FOOTSTEP_WATER_MANIFEST = path.join(SOUND_DIR, 'footstep-water.json');

/** 产物 id（v3.37 由 `running_water` 改名，用户裁定文件名 `running_wet.wav`） */
export const FOOTSTEP_WATER_ID = 'running_wet';

export {
  FOOTSTEP_WATER_RATE, FOOTSTEP_WATER_SOURCE, FOOTSTEP_WATER_SOURCE_WAV,
  FOOTSTEP_WATER_SOURCE_SHA256, FOOTSTEP_WATER_PRODUCT_SHA256, GAIT_CYCLE_SECONDS, FOOTSTEP_WATER_PERIOD,
  FOOTSTEP_WATER_STEPS, FOOTSTEP_WATER_GRAIN_SECONDS, FOOTSTEP_WATER_GRAIN_PRE_SECONDS,
  FOOTSTEP_WATER_TAIL_FADE_SECONDS, FOOTSTEP_WATER_GRAINS, FOOTSTEP_WATER_ALT,
  FOOTSTEP_WATER_NORM_POWER, FOOTSTEP_WATER_EQ, FOOTSTEP_WATER_TARGET_RMS,
  FOOTSTEP_WATER_IMPL_VERSION, FOOTSTEP_WATER_WARMUP_LOOPS, FOOTSTEP_WATER_RENDER_LOOPS,
  FOOTSTEP_WATER_EXT, footstepWaterPeriodSamples, footstepWaterLoopSamples,
};

/** 产物文件名（`running_wet.wav`） */
export function footstepWaterFileName() { return `${FOOTSTEP_WATER_ID}.${FOOTSTEP_WATER_EXT}`; }

/**
 * 输入指纹 = 实现版本 + 素材 sha256 + 采样率 + 步态周期 + 全部时间轴参数 + 颗粒时刻 + EQ 链。
 *
 * ⚠️ **必须含素材内容哈希**：换一份同名 mp3（用户替换素材）时参数一个字都没变，
 * 只有内容哈希能抓到 —— 与图标指纹含贴图内容哈希同一条教训。
 * @returns {string}
 */
export function footstepWaterInputFingerprint() {
  const eq = FOOTSTEP_WATER_EQ.map((b) => `${b.kind}@${b.f0}/${b.q}/${b.gainDb}`).join('>');
  return [
    `impl:${FOOTSTEP_WATER_IMPL_VERSION}`,
    `src:${FOOTSTEP_WATER_SOURCE_SHA256}`,
    `rate:${FOOTSTEP_WATER_RATE}`,
    `gait:${GAIT_CYCLE_SECONDS}`,
    `steps:${FOOTSTEP_WATER_STEPS}`,
    `grain:${FOOTSTEP_WATER_GRAIN_SECONDS}`,
    `pre:${FOOTSTEP_WATER_GRAIN_PRE_SECONDS}`,
    `fade:${FOOTSTEP_WATER_TAIL_FADE_SECONDS}`,
    `grains:${FOOTSTEP_WATER_GRAINS.join(',')}`,
    `alt:${FOOTSTEP_WATER_ALT.join(',')}`,
    `norm:${FOOTSTEP_WATER_NORM_POWER}`,
    `eq:${eq}`,
    `rms:${FOOTSTEP_WATER_TARGET_RMS}`,
    `warmup:${FOOTSTEP_WATER_WARMUP_LOOPS}`,
    `loops:${FOOTSTEP_WATER_RENDER_LOOPS}`,
  ].join(';');
}

/**
 * 文件内容哈希（sha256 前 16 位 hex）。
 * ⚠️ 读**原始字节**而不解码 —— wav 头里的时长/采样率变化也会被抓到。
 * @param {string} file @returns {string}
 */
export function fileHash(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 16);
}

/** 素材文件的完整 sha256（与配方里冻结的值比对） */
export function sourceSha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * 解析 16-bit PCM wav → Float64 单声道样本 + 采样率。
 *
 * ⚠️ **必须逐 chunk 找 `fmt ` / `data`，不能写死 44 字节偏移**：ffmpeg 会在 `fmt ` 之后
 * 插一个 `LIST/INFO` chunk（实测本仓三个素材全都有）⇒ 写死偏移会把 chunk 头当样本读，
 * 包络分析出来的「步频」全是噪声。本轮第一版就是这么错的（`Invalid typed array length: -1`）。
 *
 * @param {string} file
 * @returns {{x: Float64Array, rate: number, channels: number, frames: number}}
 */
export function readWavMono(file) {
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
  const n = Math.floor(Math.min(dataLen, buf.length - dataOff) / 2);
  const frames = Math.floor(n / fmt.channels);
  const x = new Float64Array(frames);
  for (let i = 0; i < frames; i++) {
    let s = 0;
    for (let c = 0; c < fmt.channels; c++) s += buf.readInt16LE(dataOff + (i * fmt.channels + c) * 2) / 32768;
    x[i] = s / fmt.channels;
  }
  return { x, rate: fmt.rate, channels: fmt.channels, frames };
}

/** Float64 单声道样本 → 16-bit PCM wav（无损、浏览器原生解码、零编码器依赖） */
export function encodeWavMono(x, rate) {
  const n = x.length;
  const bytes = 44 + n * 2;
  const buf = Buffer.alloc(bytes);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(bytes - 8, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);          // PCM
  buf.writeUInt16LE(1, 22);          // mono
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    // 钳到 [-1,1] 再量化（不钳会整段翻相）
    const v = Math.max(-1, Math.min(1, x[i]));
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  return buf;
}

/**
 * RMS / 峰值：**从 dsp 模块 re-export**，不在这里另写一份（红线 1）。
 * 烘焙时的响度对齐与门禁的响度契约必须是同一个口径，两处各写一份会漂移。
 */
export { rms, peak } from './footstep-water-dsp.mjs';