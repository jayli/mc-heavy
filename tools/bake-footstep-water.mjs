// tools/bake-footstep-water.mjs — 烘焙水中跑动脚步声（把用户素材按陆地跑步步频重排成无缝循环）
//
// **烘焙 = 数据格式转换，不产生新美术资源。** 声音内容逐样本取自
// `assets/sounds/src/wet-mud-source.mp3`（用户提供的踩湿泥录音）。本脚本不合成任何音色，
// 只做：截单步 → EQ（去泥闷/压嘶声）→ 按步频叠接 → 尾部淡出 → 响度对齐 running_land。
// 信号处理本体在 `footstep-water-dsp.mjs`（零依赖，单测读同一份 —— 红线 1）。
//
// ## 为什么产物是 wav 而不是 mp3
//
// mp3 编码器会在首尾补静音（encoder delay / padding），循环接缝会多出几十毫秒空档 ——
// 那正是用户要的「循环播放节奏保持住」的反面。wav 无损、浏览器原生解码、零编码器依赖。
//
// ## 为什么必须渲染多圈再取稳态圈
//
// 单步颗粒窗长（0.340s）> 步长（0.2799s），相邻步的水花尾巴自然叠接；而 biquad 有状态。
// 直接渲染一圈当循环体，会缺「上一轮末尾几步压过来的尾巴」⇒ 接缝处声音突然少一截。
// 本脚本渲染 6 圈、取第 2 圈（稳态），并**当场验证**「产物平铺 4 圈 ≡ 稳态长渲染」逐样本相等。
//
// ⚠️ **确定性**：无随机源（所有颗粒时刻是配方里的冻结常量），逐次烘焙逐字节一致。
//
// 用法：npm run footstepwater
//       node tools/bake-footstep-water.mjs --stats   只打印产物统计，不重写文件
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  ROOT, SOUND_DIR, FOOTSTEP_WATER_MANIFEST, FOOTSTEP_WATER_ID,
  FOOTSTEP_WATER_RATE, FOOTSTEP_WATER_SOURCE, FOOTSTEP_WATER_SOURCE_WAV,
  FOOTSTEP_WATER_SOURCE_SHA256, GAIT_CYCLE_SECONDS, FOOTSTEP_WATER_STEPS,
  FOOTSTEP_WATER_IMPL_VERSION, FOOTSTEP_WATER_EXT,
  footstepWaterLoopSamples, footstepWaterFileName,
  footstepWaterInputFingerprint, fileHash, sourceSha256, readWavMono, encodeWavMono, rms, peak,
} from './footstep-water-fingerprint.mjs';
import { bakeFootstepWater } from './footstep-water-dsp.mjs';

const STATS_ONLY = process.argv.includes('--stats');

/**
 * 素材解码：本仓没有 mp3 解码器 ⇒ 用 ffmpeg 转成 44.1kHz 单声道 wav 中间物（不入库）。
 * 与 `bake-grass-textures.mjs` 用 `sips` 转 jpg→png 同一手法。
 */
function ensureSourceWav() {
  const src = path.join(ROOT, FOOTSTEP_WATER_SOURCE);
  const wav = path.join(ROOT, FOOTSTEP_WATER_SOURCE_WAV);
  // ⚠️ **素材已按用户 2026-11-24 裁定从仓库删除**（只提交产物 running_wet.wav）
  // ⇒ 本命令在干净检出里**必然走到这里**。刻意硬失败并给出取回办法，
  // 绝不静默跳过或产出别的声音（那是「烘焙产物静默换成另一个音」的形态）。
  if (!fs.existsSync(src)) {
    throw new Error(
      `素材不在库：${FOOTSTEP_WATER_SOURCE}\n`
      + '用户 2026-11-24 裁定只提交产物 `assets/sounds/running_wet.wav`，源素材不入库\n'
      + '⇒ **本产物不可重烘**，产物完整性由 `check:data` 钉产物 sha256 守住。\n'
      + '若确实要重烘：把同一份 `freesound_community-walking-through-thick-wet-mud-63770.mp3`\n'
      + `（sha256 ${FOOTSTEP_WATER_SOURCE_SHA256}）放回上面那个路径，重跑本命令，\n`
      + '并同步更新 `footstep-water-recipe.js` 的 FOOTSTEP_WATER_PRODUCT_SHA256。',
    );
  }
  const sha = sourceSha256(src);
  if (sha !== FOOTSTEP_WATER_SOURCE_SHA256) {
    throw new Error(
      '素材内容与配方冻结的 sha256 不一致（换素材了？）\n'
      + `  期望 ${FOOTSTEP_WATER_SOURCE_SHA256}\n  实际 ${sha}\n`
      + '换素材须同时更新 footstep-water-recipe.js 的 SHA256 与颗粒时刻，再重烘。',
    );
  }
  // 中间物可重建 ⇒ 每次重转（避免「改了素材但 wav 是旧的」这类静默过期）
  try {
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', src,
      '-ac', '1', '-ar', String(FOOTSTEP_WATER_RATE), '-c:a', 'pcm_s16le', wav],
    { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (e) {
    throw new Error(
      '需要 ffmpeg 把 mp3 解码成 wav（本仓没有 mp3 解码器）：\n'
      + `  ffmpeg -v error -y -i "${src}" -ac 1 -ar ${FOOTSTEP_WATER_RATE} -c:a pcm_s16le "${wav}"\n`
      + `原始错误：${e.message}`,
    );
  }
  return readWavMono(wav);
}

function main() {
  if (STATS_ONLY) {
    const f = path.join(SOUND_DIR, footstepWaterFileName());
    if (!fs.existsSync(f)) { console.log('缺产物 —— 跑 npm run footstepwater'); return; }
    const { x, rate } = readWavMono(f);
    console.log(`${FOOTSTEP_WATER_ID}: ${(x.length / rate).toFixed(4)}s ${rate}Hz `
      + `peak=${peak(x).toFixed(4)} rms=${rms(x).toFixed(5)}`);
    return;
  }
  const source = ensureSourceWav();
  const { loop, metrics } = bakeFootstepWater(source);
  // 产物契约（烘焙当场硬失败，不把坏产物写进库）
  if (metrics.peak > 0.999) throw new Error(`峰值削顶 ${metrics.peak}（增益过大）`);
  if (metrics.tileMaxError > 1e-12) {
    throw new Error(`循环不无缝：平铺误差 ${metrics.tileMaxError}（接缝会听得出来）`);
  }
  if (metrics.loopSamples !== footstepWaterLoopSamples()) throw new Error('循环长度与配方不符');

  const file = path.join(SOUND_DIR, footstepWaterFileName());
  fs.writeFileSync(file, encodeWavMono(loop, FOOTSTEP_WATER_RATE));
  const manifest = {
    implVersion: FOOTSTEP_WATER_IMPL_VERSION,
    rate: FOOTSTEP_WATER_RATE,
    format: `pcm-s16le-${FOOTSTEP_WATER_EXT}`,
    id: FOOTSTEP_WATER_ID,
    source: {
      file: FOOTSTEP_WATER_SOURCE,
      sha256: FOOTSTEP_WATER_SOURCE_SHA256,
      origin: '用户提供：freesound_community-walking-through-thick-wet-mud-63770.mp3',
    },
    cadence: {
      reference: 'assets/sounds/running_land.mp3',
      gaitCycleSeconds: GAIT_CYCLE_SECONDS,
      periodSamples: metrics.periodSamples,
      steps: FOOTSTEP_WATER_STEPS,
    },
    fingerprints: { input: footstepWaterInputFingerprint() },
    files: {
      [FOOTSTEP_WATER_ID]: {
        file: footstepWaterFileName(),
        hash: fileHash(file),
        seconds: metrics.seconds,
        channels: 1,
      },
    },
    metrics,
  };
  fs.writeFileSync(FOOTSTEP_WATER_MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`[footstepwater] ${FOOTSTEP_WATER_ID}.${FOOTSTEP_WATER_EXT}: `
    + `${metrics.seconds}s ${FOOTSTEP_WATER_STEPS} 步 × ${metrics.periodSamples} 样本 `
    + `peak=${metrics.peak} rms=${metrics.rms} 平铺误差=${metrics.tileMaxError}`);
  console.log(`[footstepwater] 带能量占比 <200Hz=${(metrics.bandShares[0] + metrics.bandShares[1]).toFixed(4)} `
    + `0.5~5kHz=${metrics.bandShares.slice(3, 6).reduce((a, b) => a + b, 0).toFixed(4)} `
    + `>8kHz=${metrics.bandShares[7]}`);
  console.log('[footstepwater] 产物 + footstep-water.json 已写入 assets/sounds/');
}

main();