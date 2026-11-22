// tools/bake-carbine-audio.mjs — 烘焙 KV-9 卡宾枪与雨声音效（离线渲染上游 Web Audio 合成配方）
//
// **烘焙 = 数据格式转换，不产生新美术资源。** 声音的每一层参数、包络、滤波、混响都来自
// 姊妹开源项目 `~/jaylli/bj-shooting-game/night-heron-src/src/audio.js`，本脚本只是把
// 「运行时用 Web Audio 算」换成「提前算好存成 wav」。配方本体在
// `src/render/carbine-audio-recipes.js`（运行时/单测/烘焙三方共用同一份）。
//
// ## 为什么是纯 JS 合成而不是 Web Audio
//
// 初版用 Playwright 的 Chromium 跑 `OfflineAudioContext`（与上游同一套实现）。
// **实测三轮重烘逐字节对比：长产物逐次运行输出不同字节**
// （12s 雨声床与 6.4s 雷声不稳定；≤0.62s 的短音效恰好稳定）。
// 去掉 DynamicsCompressor、去掉随机起始相位、每个产物独立 RNG 流之后**仍不稳定**
// ⇒ 与分块调度/节点内部状态有关，不是配方问题。而烘焙产物必须可复现（指纹门禁）。
// ⇒ 整条链改成确定性 JS（`tools/carbine-synth.mjs`）：RBJ biquad（与 Web Audio 同公式）
// + 逐样本指数扫频 + 上游 `_env` 包络 + FFT 卷积混响。声音内容全部读同一份配方。
//
// ⚠️ **确定性**（红线 2）：所有噪声/雨点击打用固定种子的 mulberry32（`CARBINE_AUDIO_SEED`），
// 禁止 `Math.random()`。上游用 Math.random ⇒ 每次运行声音都不同；本仓产物必须可复现，
// 否则指纹门禁每次烘焙都报「过期」。
//
// 用法：node tools/bake-carbine-audio.mjs（或 npm run carbineaudio）
//       node tools/bake-carbine-audio.mjs --stats   只打印产物统计，不重写文件
import fs from 'node:fs';
import path from 'node:path';
import { synthAll } from './carbine-synth.mjs';
import {
  SOUND_DIR, CARBINE_MANIFEST, CARBINE_AUDIO_IDS, CARBINE_AUDIO_EXT,
  CARBINE_AUDIO_RATE, CARBINE_AUDIO_SEED, CARBINE_SYNTH_VERSION, CARBINE_AUDIO_MASTER_GAIN,
  NOISE_BUFFERS, REVERB_IR, CARBINE_RECIPES,
  RAIN_STORM_RECIPE, THUNDER_RECIPE,
  carbineAudioFileName, carbineAudioInputFingerprint, fileHash, wavStats,
} from './carbine-audio-fingerprint.mjs';

const STATS_ONLY = process.argv.includes('--stats');


/** Float32 交错样本 → 16-bit PCM wav（无损、浏览器原生解码、零编码器依赖） */
function encodeWav(samples, channels, rate) {
  const n = samples.length;
  const bytes = 44 + n * 2;
  const buf = Buffer.alloc(bytes);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(bytes - 8, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);            // PCM
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * channels * 2, 28);
  buf.writeUInt16LE(channels * 2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    // 钳到 [-1,1] 再量化（上游压缩器后仍可能瞬时越界；不钳会整段翻相）
    const v = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  return buf;
}

async function main() {
  fs.mkdirSync(SOUND_DIR, { recursive: true });
  if (STATS_ONLY) {
    for (const id of CARBINE_AUDIO_IDS) {
      const f = path.join(SOUND_DIR, carbineAudioFileName(id));
      if (!fs.existsSync(f)) { console.log(`${id}: 缺产物`); continue; }
      const s = wavStats(f);
      console.log(`${id}: ${s.seconds.toFixed(3)}s ${s.channels}ch peak=${s.peak.toFixed(3)} rms=${s.rms.toFixed(4)} nonSilent=${(s.nonSilentRatio * 100).toFixed(1)}%`);
    }
    return;
  }

  const rendered = synthAll({
    rate: CARBINE_AUDIO_RATE, seed: CARBINE_AUDIO_SEED, gain: CARBINE_AUDIO_MASTER_GAIN,
    buffers: NOISE_BUFFERS, ir: REVERB_IR,
    recipes: CARBINE_RECIPES, rainBed: RAIN_STORM_RECIPE, thunder: THUNDER_RECIPE,
  });

  const files = {};
  const metrics = {};
  for (const id of CARBINE_AUDIO_IDS) {
    const r = rendered[id];
    if (!r || !r.samples?.length) throw new Error(`${id}: 离线渲染返回空样本`);
    const wav = encodeWav(r.samples, r.channels, CARBINE_AUDIO_RATE);
    const file = path.join(SOUND_DIR, carbineAudioFileName(id));
    fs.writeFileSync(file, wav);
    const s = wavStats(file);
    // 产物契约：非静音 + 不削顶（削顶 = 配方增益写错，听感是破音）
    if (s.nonSilentRatio < 0.05) throw new Error(`${id}: 几乎全静音（nonSilent=${s.nonSilentRatio}）`);
    if (s.peak > 0.999) throw new Error(`${id}: 峰值削顶 ${s.peak}（配方增益过大）`);
    files[id] = { file: carbineAudioFileName(id), hash: fileHash(file), seconds: s.seconds, channels: s.channels };
    metrics[id] = { peak: +s.peak.toFixed(4), rms: +s.rms.toFixed(5), nonSilentRatio: +s.nonSilentRatio.toFixed(4) };
    console.log(`[carbineaudio] ${id}: ${s.seconds.toFixed(3)}s ${s.channels}ch peak=${s.peak.toFixed(3)} rms=${s.rms.toFixed(4)}`);
  }

  const manifest = {
    synthVersion: CARBINE_SYNTH_VERSION,
    rate: CARBINE_AUDIO_RATE,
    masterGain: CARBINE_AUDIO_MASTER_GAIN,
    seed: CARBINE_AUDIO_SEED,
    format: `pcm-s16le-${CARBINE_AUDIO_EXT}`,
    fingerprints: { input: carbineAudioInputFingerprint() },
    files,
    metrics,
    source: 'bj-shooting-game/night-heron-src/src/audio.js（合成配方逐字移植，纯 JS 离线渲染）',
  };
  fs.writeFileSync(CARBINE_MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`[carbineaudio] ${CARBINE_AUDIO_IDS.length} 个产物 + carbine.json 已写入 assets/sounds/`);
}

await main();