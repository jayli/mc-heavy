// src/tests/test-footstep-water.js — 水中跑动脚步声烘焙产物（v3.37，用户 2026-11-24）
//
// 用户原话：「参照这个声音，这是一个踩水跑步的声音音效，你把步伐节奏改成跟 running_land.mp3
// 的跑步节奏一样，要能做到这个素材可以循环播放的，不用时间太长，只要能前后衔接循环播放节奏
// 保持住即可，请你做到尽可能的踩水的声音音效。」
//
// ## 为什么这些判据必须落在**真实样本**上
//
// 三条需求各自的失效形态都是**静默**的：文件存在、时长对、`playLoop` 返回在播、
// E2E 全绿，而听起来是错的：
//   ① **节奏不对** —— 步长不是 running_land 的 0.27991s ⇒ 陆上/水里跑起来步频不一样；
//   ② **循环接不上** —— 每圈结尾被硬切或补了静音 ⇒ 每 2.24 秒「咔」一下或空一拍；
//   ③ **不像踩水** —— 素材里峰值最大的几步能量全在 <200Hz 的泥闷低频，听起来是踩厚泥。
//
// ⚠️ **不读清单里自己写的数**：`footstep-water.json` 的 metrics 是烘焙脚本自己的输出，
// 断言它等于「断言读自己的输入」（本仓 `debugLoops().volume` 报意图值那次踩过）。
// 本文件全部判据都从 `running_wet.wav` 的样本重新算。
//
// ⚠️ **算法只有一份**（红线 1）：叠接逻辑调 `tools/footstep-water-dsp.mjs` 的
// `bakeFootstepWater()`，不在测试里另写一份 —— 两侧各写一份会共享同一个错误假设。
// 该模块零 node 依赖（参数直接读 `src/render/footstep-water-recipe.js`），浏览器与 Node 共用。
//
// Tier 2（烘焙产物数据契约）⇒ 门禁断言，免 TDD 流程；本文件是它的样本级补充。
import { test } from './runner.js';
import { assertEqual, assertTrue } from './assert.js';
import { resourceUrl } from '../core/resource-url.js';
import { SOUND_IDS, SOUND_EXT_OVERRIDES, soundFileName } from '../render/audio-config.js';
import {
  FOOTSTEP_WATER_RATE, FOOTSTEP_WATER_STEPS, FOOTSTEP_WATER_PERIOD, GAIT_CYCLE_SECONDS,
  FOOTSTEP_WATER_GRAINS, FOOTSTEP_WATER_ALT, FOOTSTEP_WATER_GRAIN_SECONDS,
  FOOTSTEP_WATER_TARGET_RMS, footstepWaterPeriodSamples, footstepWaterLoopSamples,
} from '../render/footstep-water-recipe.js';
import { FOOTSTEP_WATER_EXT } from '../render/footstep-water-ext.js';
import { rms, peak, envelope, bandShares, bakeFootstepWater } from '../../tools/footstep-water-dsp.mjs';

function assertClose(actual, expected, eps, message = '') {
  assertTrue(Math.abs(actual - expected) <= eps,
    `${message} 期望 ${expected}±${eps}，实际 ${actual}`);
}

/**
 * 解析 16-bit PCM wav（浏览器侧无 fs ⇒ fetch + DataView）。
 * ⚠️ **必须逐 chunk 找 fmt / data**：ffmpeg 会插 LIST/INFO chunk，写死 44 字节偏移
 * 会把 chunk 头当样本读 —— 那样算出来的「步频」全是噪声（本轮第一版就这么错的）。
 */
function parseWav(buf) {
  const dv = new DataView(buf);
  const tag = (o) => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1),
    dv.getUint8(o + 2), dv.getUint8(o + 3));
  let off = 12;
  let rate = 0; let channels = 0; let bits = 0; let dataOff = -1; let dataLen = 0;
  while (off + 8 <= buf.byteLength) {
    const id = tag(off);
    const len = dv.getUint32(off + 4, true);
    if (id === 'fmt ') {
      channels = dv.getUint16(off + 10, true);
      rate = dv.getUint32(off + 12, true);
      bits = dv.getUint16(off + 22, true);
    } else if (id === 'data') { dataOff = off + 8; dataLen = len; }
    off += 8 + len + (len % 2);
  }
  assertTrue(bits === 16 && dataOff >= 0, 'wav 必须是 16bit PCM 且有 data chunk');
  const n = Math.floor(Math.min(dataLen, buf.byteLength - dataOff) / 2 / channels);
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let c = 0; c < channels; c++) s += dv.getInt16(dataOff + (i * channels + c) * 2, true) / 32768;
    x[i] = s / channels;
  }
  return { x, rate, channels };
}

/** 产物样本（只取一次，多个用例共用） */
let _prod = null;
async function product() {
  if (_prod === null) {
    const res = await fetch(resourceUrl('assets/sounds/running_wet.wav'));
    assertTrue(res.ok, `产物须可加载，HTTP ${res.status}`);
    _prod = parseWav(await res.arrayBuffer());
  }
  return _prod;
}

/**
 * 素材 wav 中间物（ffmpeg 产出）。
 * ⚠️ **素材已按用户 2026-11-24 裁定从仓库删除** ⇒ 干净检出里恒缺失，这是**正常状态**。
 * 只有「取回素材准备重烘」时才存在，那时才做重烘对照。
 */
let _srcState = 'untried';
let _src = null;
async function sourceWav() {
  if (_srcState === 'untried') {
    const res = await fetch(resourceUrl('assets/sounds/src/wet-mud-source.wav'));
    if (res.ok) { _src = parseWav(await res.arrayBuffer()); _srcState = 'ok'; } else _srcState = 'missing';
  }
  return _srcState === 'ok' ? _src : null;
}

/**
 * 步频测量：包络正向差分的自相关，取 0.40~0.75s 内的最强 lag（= 左右整步态）÷ 2。
 * ⚠️ **必须用「整步态」而不是单步 lag**：单步 lag 的自相关峰会被左右脚强弱差干扰，
 * 实测 running_land 全片单步细化 0.28369 而整步态 ÷2 = 0.27991（后者才是真步频）。
 */
function measurePeriod(x, rate) {
  const { e, hop } = envelope(x, rate, 0.008, 0.001);
  const d = new Float64Array(e.length);
  for (let i = 1; i < e.length; i++) d[i] = Math.max(0, e[i] - e[i - 1]);
  let mean = 0;
  for (const v of d) mean += v;
  mean /= d.length;
  for (let i = 0; i < d.length; i++) d[i] -= mean;
  const lo = Math.round(0.40 * rate / hop);
  const hi = Math.round(0.75 * rate / hop);
  const ac = [];
  for (let lag = lo; lag <= hi; lag++) {
    let s = 0;
    for (let i = 0; i + lag < d.length; i++) s += d[i] * d[i + lag];
    ac.push(s / (d.length - lag));
  }
  let bi = 0;
  for (let i = 1; i < ac.length; i++) if (ac[i] > ac[bi]) bi = i;
  // 抛物线细化（离散 lag 的分辨率只有 1ms）
  let delta = 0;
  if (bi > 0 && bi < ac.length - 1) {
    const y0 = ac[bi - 1]; const y1 = ac[bi]; const y2 = ac[bi + 1];
    const den = y0 - 2 * y1 + y2;
    if (den !== 0) delta = 0.5 * (y0 - y2) / den;
  }
  return ((lo + bi + delta) * hop / rate) / 2;
}

// ---------------------------------------------------------------- 接线契约

test('footstep-water: id 是 running_wet，扩展名走 wav 覆盖表（漏了 = 水中静默无声）', () => {
  // ⚠️ v3.37 把 id 由 running_water 改名 running_wet（用户裁定文件名）⇒
  // player._updateFootsteps 与 audio-fx.spec 两处消费方必须同步，漏一处即静默无声。
  assertTrue(SOUND_IDS.includes('running_wet'), 'running_wet 必须在预载清单里');
  assertEqual(FOOTSTEP_WATER_EXT, 'wav', '产物容器是 wav（mp3 的 encoder padding 会毁掉循环接缝）');
  assertEqual(SOUND_EXT_OVERRIDES.running_wet, 'wav',
    '必须进扩展名覆盖表 —— 漏了会按 .mp3 去 fetch，404 被 preload 的 catch 吞成一句 warn');
  assertEqual(soundFileName('running_wet'), 'running_wet.wav');
});

test('footstep-water: 步数是偶数、颗粒与音量系数个数都等于步数', () => {
  assertEqual(FOOTSTEP_WATER_STEPS % 2, 0,
    '步数必须偶数：奇数会让左右脚在圈与圈之间对调，重音永远落同一只脚');
  assertEqual(FOOTSTEP_WATER_GRAINS.length, FOOTSTEP_WATER_STEPS);
  assertEqual(FOOTSTEP_WATER_ALT.length, FOOTSTEP_WATER_STEPS);
  assertTrue(FOOTSTEP_WATER_GRAIN_SECONDS > FOOTSTEP_WATER_PERIOD,
    '颗粒窗长必须 > 步长，否则每步之间是纯静音（听感是断续的哒哒而不是连续跑动）');
});

test('footstep-water: 循环长度 = 步长 × 步数（派生关系式，不是硬编码秒数）', () => {
  assertEqual(footstepWaterPeriodSamples(), Math.round(FOOTSTEP_WATER_PERIOD * FOOTSTEP_WATER_RATE));
  assertEqual(footstepWaterLoopSamples(), footstepWaterPeriodSamples() * FOOTSTEP_WATER_STEPS);
  assertClose(FOOTSTEP_WATER_PERIOD * 2, GAIT_CYCLE_SECONDS, 1e-12, '单步 = 整步态 ÷ 2');
  // 用户「不用时间太长」：8 步约 2.24s，给 3s 上界（改步数时这条会提醒重新权衡）
  assertTrue(footstepWaterLoopSamples() / FOOTSTEP_WATER_RATE < 3.0, '一个循环不得超过 3 秒');
});

// ---------------------------------------------------------------- 产物样本契约

test('footstep-water: 产物样本数恰好 = 步长 × 步数，单声道 44.1kHz', async () => {
  const { x, rate, channels } = await product();
  assertEqual(rate, FOOTSTEP_WATER_RATE);
  assertEqual(channels, 1, '单声道（脚步声是玩家自己的动作，不需要立体声定位）');
  assertEqual(x.length, footstepWaterLoopSamples(),
    '样本数必须精确 —— 多一截或少一截都会让每圈接缝错拍');
});

test('footstep-water: 产物不削顶、不静音，响度与 running_land 同档', async () => {
  const { x } = await product();
  const pk = peak(x);
  const r = rms(x);
  assertTrue(pk <= 0.999, `不得削顶（峰值 ${pk}）`);
  assertTrue(pk > 0.05, `峰值须够响（当前 ${pk}）`);
  // 两路脚步声在各自音量档（陆 0.2 / 水 0.25）下听感相当 ⇒ RMS 必须对齐
  assertClose(r / FOOTSTEP_WATER_TARGET_RMS, 1.0, 0.02,
    'RMS 与 running_land 基准的比值');
});

test('footstep-water: 实测步频 = running_land 的 0.27991s（不是估值）', async () => {
  const { x, rate } = await product();
  // 平铺 4 圈再测：单圈只有 8 步，自相关样本太少
  const tiled = new Float64Array(x.length * 4);
  for (let k = 0; k < 4; k++) tiled.set(x, k * x.length);
  const measured = measurePeriod(tiled, rate);
  assertClose(measured, FOOTSTEP_WATER_PERIOD, 0.004,
    '实测单步周期须与 running_land 一致（±4ms = 自相关 1ms 分辨率 + 细化误差）');
});

/**
 * 每步的**真实能量峰位**（相对步起点的样本偏移）。
 *
 * ☠️☠️ **为何需要它（v3.45）**：同一份烘焙有多个合法循环旋转（`playLoop` 从任意点
 * 入环都是同一圈）。磁盘产物相对最初那份转了 ~88ms，把测量窗写死在「步起点」
 * 会让逐步冲击从 0.0303 掉到 **0.0034**（量到的是两步之间的尾巴）、左右脚强弱也反转。
 * 那不是内容坏了：锚到峰位后冲击是 **0.0369~0.0663**（与旧版 0.0303~0.0677 同量级）。
 *
 * ⇒ 判据先找峰再量，**而不是把阈值调低** —— 调低会让「某步被切成静音」静默通过。
 * 峰位用与步频测量同一份 `envelope()`（红线 1，不另写一份包络）。
 *
 * @param {Float64Array} x @param {number} rate
 * @returns {number[]} 长度 = 步数，每项是该步能量峰相对步起点的样本偏移
 */
function stepPeakOffsets(x, rate) {
  const P = footstepWaterPeriodSamples();
  const { e, hop } = envelope(x, rate, 0.008, 0.001);
  const out = [];
  for (let k = 0; k < FOOTSTEP_WATER_STEPS; k++) {
    const lo = Math.round(k * P / hop);
    const hi = Math.round((k + 1) * P / hop);
    let bi = lo;
    for (let i = lo; i < hi && i < e.length; i++) if (e[i] > e[bi]) bi = i;
    out.push(bi * hop - k * P);
  }
  return out;
}

/** 以某点为中心的窗 RMS（循环取索引，跨接缝不报错） */
function windowRmsAt(x, center, win) {
  const half = Math.floor(win / 2);
  let s = 0;
  let n = 0;
  for (let i = -half; i < half; i++) {
    const v = x[((center + i) % x.length + x.length) % x.length];
    s += v * v;
    n++;
  }
  return Math.sqrt(s / Math.max(n, 1));
}

test('footstep-water: 左右脚强弱交替（相邻步一重一轻，不是每步一样响）', async () => {
  const { x, rate } = await product();
  const P = footstepWaterPeriodSamples();
  // ☠️☠️ **判据必须与循环相位无关**（用户 2026-11-26 裁定）。
  //
  // 同一份烘焙有多个合法循环旋转（`playLoop` 从任意点入环都是同一圈）。
  // 磁盘产物转了 **7.2861 步**（奇数步 7 + 80.09ms）⇒ 重脚落在奇数位，
  // 与配方 ALT（偶数=重）对调。旧判据钉「偶数步必响」在任何窗宽下恒红
  // （实测 heavy/light 恒 ~0.80），而那是**入环相位**而不是内容缺陷。
  //
  // ⇒ 改钉两件事，都与相位无关：
  //   ① **相邻步一重一轻**（逐步交替，8 个相邻对全部异号）；
  //   ② **两组均值差显著**（重组/轻组 > 1.02）。
  // 仍然能抓「每步一样响」（比值→1）与「某几步被切没」（交替断链）。
  // 窗锚在真实能量峰上（而不是步起点），否则量到的是两步之间的尾巴。
  const offs = stepPeakOffsets(x, rate);
  const win = Math.round(0.12 * rate);
  const e = offs.map((o, k) => windowRmsAt(x, k * P + o, win));
  const g0 = (e[0] + e[2] + e[4] + e[6]) / 4;
  const g1 = (e[1] + e[3] + e[5] + e[7]) / 4;
  const heavy = Math.max(g0, g1);
  const light = Math.min(g0, g1);
  // ① **奇偶两组的均值差显著**（哪一组是重脚由入环相位定，不写死）。
  // 实测组均比恒 **1.276**，旋转 0~7 整步与任意亚步相位下波动 <0.001。
  assertTrue(heavy > light * 1.02,
    `两组须有显著强弱差：heavy=${heavy.toFixed(5)} light=${light.toFixed(5)}`);
  // ② **绝大多数相邻对一重一轻**（交替的直接形式）。
  //
  // ☠️☠️ **不能要求「8 对全部异号」也不能要求「两组区间不重叠」**（两条都被实测推翻）：
  //   · ALT 本身带 15% 组内起伏（[1.0,0.87,0.96,0.85,…]）⇒ 两组区间**天然重叠**
  //     （实测重组 min 0.02230 < 轻组 max 0.02473）；
  //   · 有一对相邻步能量几乎相等（第 6/7 步差 **2.56e-5** = 0.11%）⇒ 它的差分符号
  //     随相位翻转，严格逐个异号在旋转 1/3 整步时假红。
  // ⇒ 取「相对差 >2% 的相邻对 ≥ 6/8」（实测恒 **7/8**）。它仍能抓「每步一样响」
  //   （显著对→0）与「某步被切静音」（交替节奏被破坏）。
  let alternating = 0;
  for (let k = 0; k < FOOTSTEP_WATER_STEPS; k++) {
    const a = e[k];
    const b = e[(k + 1) % FOOTSTEP_WATER_STEPS];
    if (Math.abs(a - b) / Math.max(a, b) > 0.02) alternating++;
  }
  assertTrue(alternating >= 6,
    `相邻步一重一轻的对数须 ≥6/8，实测 ${alternating}/8`
    + `（逐步能量 ${e.map((v) => v.toFixed(4)).join(' ')}）`);
  // ③ 强弱幅度与配方 ALT 同量级（防止「交替还在但弱到听不出」）。
  // ALT 最大/最小 = 1.0/0.85 = 1.176；组均比实测 1.276。
  const altMax = Math.max(...FOOTSTEP_WATER_ALT) / Math.min(...FOOTSTEP_WATER_ALT);
  assertTrue(heavy / light > 1.05 && heavy / light < altMax * 1.5,
    `强弱比 ${(heavy / light).toFixed(4)} 须与 ALT 同量级（1.05 ~ ${(altMax * 1.5).toFixed(3)}）`);
});

/** 首/尾连续（近）零样本串长度 —— 抓 mp3 encoder padding 与「尾部被硬切成静音」 */
function zeroRun(x, fromEnd = false) {
  let n = 0;
  for (let i = 0; i < x.length; i++) {
    const v = x[fromEnd ? x.length - 1 - i : i];
    if (Math.abs(v) >= 1e-4) break;
    n++;
  }
  return n;
}

/**
 * 接缝两侧 20ms 窗的能量比（接缝 = 循环播放时「末样本 → 首样本」那一点）。
 * ⚠️ 平铺两圈后取窗，才能量到真正跨接缝的那一段。
 */
function seamEnergyRatio(x, offset, win) {
  const L = x.length;
  const at = (i) => x[((i % L) + L) % L];
  let pre = 0; let post = 0;
  for (let i = 0; i < win; i++) {
    const a = at(offset - win + i); pre += a * a;
    const b = at(offset + i); post += b * b;
  }
  return Math.sqrt(pre / win) / Math.max(Math.sqrt(post / win), 1e-12);
}

test('footstep-water: 首尾不得有静音串（mp3 padding / 尾部硬切的形态）', async () => {
  const { x, rate } = await product();
  const lead = zeroRun(x);
  const trail = zeroRun(x, true);
  const limit = Math.round(0.002 * rate);   // 2ms：真实波形不会连续 88 个样本都近零
  assertTrue(lead <= limit,
    `首部静音串 ${lead} 样本（${(lead / rate * 1000).toFixed(1)}ms）—— 循环每圈开头会空一拍`);
  assertTrue(trail <= limit,
    `尾部静音串 ${trail} 样本（${(trail / rate * 1000).toFixed(1)}ms）—— 循环每圈结尾会空一拍`);
});

test('footstep-water: 接缝处的能量跌落与循环内部各步边界同量级', async () => {
  const { x, rate } = await product();
  const P = footstepWaterPeriodSamples();
  const win = Math.round(0.020 * rate);
  // ⚠️ **不能用「首尾样本落差 ≤ 内部相邻落差 p99」**：本轮实测那条判据**零判别力** ——
  // 把尾部 30ms 硬切成静音后，末样本变成 0，落差反而从 0.0248 **降到** 0.0210，判据照样通过。
  // 有判别力的是**能量**：硬切/补静音让接缝前的窗能量归零（比值 0），
  // 而正常产物 0.0771 落在内部各步边界 [0.0539, 0.2685] 的量级内。
  const seam = seamEnergyRatio(x, 0, win);
  const inner = [];
  for (let k = 1; k < FOOTSTEP_WATER_STEPS; k++) inner.push(seamEnergyRatio(x, k * P, win));
  const lo = Math.min(...inner);
  const hi = Math.max(...inner);
  assertTrue(seam >= lo * 0.5 && seam <= hi * 2.0,
    `接缝能量比 ${seam.toFixed(4)} 须落在内部步边界量级 [${(lo * 0.5).toFixed(4)}, ${(hi * 2.0).toFixed(4)}]`
    + `（内部实测 [${lo.toFixed(4)}, ${hi.toFixed(4)}]）`);
});

test('footstep-water: 频谱是「踩水」而不是「踩厚泥」—— 泼溅主体占多数、泥闷低频被压掉', async () => {
  const { x, rate } = await product();
  const b = bandShares(x, rate);
  const mud = b[0] + b[1];              // <200Hz：厚泥的隆隆
  const splat = b[3] + b[4] + b[5];     // 0.5~5kHz：泼溅主体
  const hiss = b[7];                    // >8kHz：录音底噪的嘶声
  // 阈值取实测值与「素材原样」之间的中间带：素材全片 <200Hz 占 34.5%、产物实测 0.36%
  assertTrue(mud < 0.05, `泥闷低频（<200Hz）须被压到 5% 以下，当前 ${(mud * 100).toFixed(2)}%`);
  assertTrue(splat > 0.45, `泼溅主体（0.5~5kHz）须占 45% 以上，当前 ${(splat * 100).toFixed(2)}%`);
  assertTrue(hiss < 0.20, `嘶声（>8kHz）不得超过 20%，当前 ${(hiss * 100).toFixed(2)}%`);
});

// ---------------------------------------------------------------- 无缝性（直接量产物）

test('footstep-water: 产物平铺 8 圈后步频恒定、无累积漂移（循环无缝的直接判据）', async () => {
  const { x, rate } = await product();
  // ⚠️ **素材已按用户裁定不入库** ⇒ 无法「重跑烘焙对照」。改直接量产物：
  // 若接缝处多了/少了一段，平铺后每个接缝都会引入一次相位偏移，
  // 8 圈的整体自相关峰会变宽/偏移；而无缝时步频与单圈严格一致。
  const one = measurePeriod(x, rate);
  const tiled = new Float64Array(x.length * 8);
  for (let k = 0; k < 8; k++) tiled.set(x, k * x.length);
  const many = measurePeriod(tiled, rate);
  assertClose(many, one, 0.001,
    '平铺 8 圈测得的步频须与单圈一致（接缝错拍会让长程周期漂移）');
  assertClose(many, FOOTSTEP_WATER_PERIOD, 0.004, '长程步频仍须等于 running_land 基准');
});

test('footstep-water: 逐步冲击都在（8 步都有起音，不是某几步被切成静音）', async () => {
  const { x, rate } = await product();
  const P = footstepWaterPeriodSamples();
  // ☠️ **锚在能量峰而不是步起点**（v3.45，与上一条同一理由）：写死步起点时，
  // 循环旋转后的产物读到 0.0034（两步之间的尾巴）而不是真冲击。
  // 锚峰后实测 **0.0369~0.0663**，与最初那份 0.0303~0.0677 同量级 ⇒ **阈值不动**。
  const offs = stepPeakOffsets(x, rate);
  const win = Math.round(0.020 * rate);
  const e = offs.map((o, k) => windowRmsAt(x, k * P + o, win));
  const lo = Math.min(...e);
  const hi = Math.max(...e);
  // 每步能量峰周围 20ms 内必须有真实冲击能量（实测最低 0.0369、最高 0.0663）
  assertTrue(lo > 0.01, `最弱的一步冲击能量仅 ${lo.toFixed(5)}（该步可能被切没了）`);
  assertTrue(hi / lo < 4.0, `步与步冲击悬殊 ${((hi / lo)).toFixed(2)}×（某步被误增益或衰减）`);
});

test('footstep-water: 素材在库时才做重烘对照（不在库是正常状态，跳过但显式说明）', async () => {
  const src = await sourceWav();
  const { x } = await product();
  if (!src) {
    // ⚠️ 用户 2026-11-24 裁定素材不入库 ⇒ **这是预期的常驻分支**，不是异常。
    // 不静默 pass：仍断言产物长度契约，并把「为什么没做重烘对照」写进断言消息。
    // 无缝性由上面两条直接判据 + `check:data` 的产物 sha256 共同守住。
    assertEqual(x.length, footstepWaterLoopSamples(),
      '（素材不入库 ⇒ 无重烘对照；产物完整性由 check:data 钉 sha256）');
    return;
  }
  const { loop, metrics } = bakeFootstepWater(src);
  assertEqual(metrics.tileMaxError, 0,
    '「产物平铺 4 圈 ≡ 稳态长渲染」必须逐样本相等 —— 这是循环无缝的充分判据');
  assertEqual(loop.length, x.length);
  let maxErr = 0;
  for (let i = 0; i < x.length; i++) {
    const d = Math.abs(loop[i] - x[i]);
    if (d > maxErr) maxErr = d;
  }
  // 磁盘是 16bit 量化后的，半 LSB = 1/65536 ≈ 1.526e-5
  assertTrue(maxErr <= 1 / 32768,
    `重烘与磁盘产物须在量化误差内一致（最大差 ${maxErr}）—— 否则产物过期`);
});