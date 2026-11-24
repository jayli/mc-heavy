// src/render/footstep-water-recipe.js — 水中跑动脚步声的烘焙配方（three-free / DOM-free / node-free）
//
// **烘焙 = 数据格式转换，不产生新美术资源。** 声音内容逐样本取自用户提供的素材
// `assets/sounds/src/wet-mud-source.mp3`（freesound「walking through thick wet mud」，
// 53.592s / 24kHz / 立体声），本配方只做三件事：
//   ① 从素材里**截出 8 个真实单步**（不合成音色、不加混响、不叠素材里没有的声音）；
//   ② 按 `running_land.mp3` 实测步频重排到时间轴上；
//   ③ 高通去泥闷 + 压嘶声（把「厚泥」的听感推向「踩水」），尾部淡出保证循环接缝无爆音。
//
// ## 为什么参数放 src/ 而不是 tools/
//
// 与 `carbine-audio-recipes.js` 同一手法（红线 1：同一事实只有一份权威）：
//   · `tools/bake-footstep-water.mjs` 按它烘焙；
//   · `tools/footstep-water-fingerprint.mjs` 用当前参数重算指纹写进清单；
//   · `tools/check-data.mjs` 比对指纹 → 改了参数忘重烘当场报错。
// src/ 不得 import tools/，而门禁与烘焙都要读同一份参数 ⇒ 参数放这个零依赖小模块。
//
// ⚠️ **步频不是估的，是实测的**：`running_land.mp3` 的包络自相关在 lag≈0.560s 处有强峰
// （左右两步一个完整步态），全片细化 0.55981s、尾段 6.0~8.93s 为 0.55952s
// ⇒ 单步 0.27991s（≈214 步/分）。取 `GAIT_CYCLE_SECONDS / 2` 而不是直接写 0.28：
// 直接写单步值会让「左右交替」这个语义丢掉，而交替正是 8 步循环成立的前提。
//
// ⚠️ **8 步而不是 4 步**：4 步（1.12s）虽然更短，但同一组音色每 1.1 秒重复一次，
// 长跑时听得出「循环感」。8 步 = 4 个完整左右步态 = 2.239s，仍在用户「不用时间太长」的范围内。
// 步数必须是**偶数**（否则左右脚在圈与圈之间对调，重音落在同一只脚上）。

/** 采样率：与 `running_land.mp3` / 卡宾枪烘焙产物一致（44100） */
export const FOOTSTEP_WATER_RATE = 44100;

/**
 * 素材原始路径（**已按用户 2026-11-24 裁定从仓库删除，不入库**）。
 *
 * ⚠️⚠️ **本产物因此是「不可重烘」的**：`npm run footstepwater` 需要这份 mp3，
 * 仓库里没有它 ⇒ 该命令会硬失败并打印取回办法（不是静默产出别的声音）。
 * 这是用户明确的取舍（「只把 running_wet 文件提交」），不是遗漏。
 *
 * ⇒ **门禁改为钉「产物自身的 sha256」**（见 `FOOTSTEP_WATER_PRODUCT_SHA256`）：
 * 素材没了，唯一还能守住「产物没被换掉 / 没被手改」的判据就是产物内容哈希。
 * 素材 sha256 仍然保留在配方与清单里**作为出处留档**（将来取回同一份素材时可核对），
 * 但门禁**不再要求它存在于磁盘**。
 *
 * 素材出处：用户提供的 `freesound_community-walking-through-thick-wet-mud-63770.mp3`
 * （53.592s / 24kHz / 立体声）。要重烘须先把同一份文件放回下面这个路径。
 */
export const FOOTSTEP_WATER_SOURCE = 'assets/sounds/src/wet-mud-source.mp3';

/**
 * 素材解码后的单声道重采样中间物（ffmpeg 产出，可重建，不入库）。
 * 本仓没有 mp3 解码器（同 `bake-grass-textures.mjs` 没有 jpeg 解码器的情形）。
 */
export const FOOTSTEP_WATER_SOURCE_WAV = 'assets/sounds/src/wet-mud-source.wav';

/** 素材原始文件的 sha256（**出处留档**；素材已不在库，门禁不校验它的存在） */
export const FOOTSTEP_WATER_SOURCE_SHA256 =
  '0c2c8c65c1065483a8ff7e3c0341fb5fe6b6a0f8afbc29f85c41cfa938309d13';

/**
 * **产物自身**的 sha256（冻结实测值）—— 素材不入库后唯一的产物完整性判据。
 *
 * ⚠️ 与其余烘焙门禁「不钉产物哈希期望值」的口径**刻意不同**：那些产物可重烘，
 * 钉期望值会把产物变成改动放大器；本产物**不可重烘**（素材已删）⇒
 * 不钉死它的形态是「产物被换成任何别的声音，而所有数值判据照样全绿」。
 * 重新烘焙（取回素材后）必须同时更新这个常量与清单。
 */
export const FOOTSTEP_WATER_PRODUCT_SHA256 =
  '9e9d472fc3ebcf4e5016d2ca7c117cb715953006cb8874ced059e315212670e3';

/**
 * 一个完整左右步态的时长（秒）—— `running_land.mp3` 包络自相关实测值。
 * ⚠️ **这是冻结的实测常量**，不是可调参数：改它等于改「与陆地跑步同节奏」这条需求本身。
 */
export const GAIT_CYCLE_SECONDS = 0.55981;

/** 单步周期（秒）= 整步态 ÷ 2。派生值，不另写一份字面量。 */
export const FOOTSTEP_WATER_PERIOD = GAIT_CYCLE_SECONDS / 2;

/**
 * 一个循环的步数。**必须偶数**（左右脚交替在接缝处才对得上）。
 * 8 步 = 4 个完整步态 ≈ 2.239s。
 */
export const FOOTSTEP_WATER_STEPS = 8;

/**
 * 单步颗粒窗长（秒）。**必须 > 单步周期**：相邻步的水花尾巴要自然叠接，
 * 否则每步之间是纯静音，听感是「断续的哒哒」而不是连续跑动。
 */
export const FOOTSTEP_WATER_GRAIN_SECONDS = 0.340;

/** 颗粒起点相对检测到的冲击时刻前移量（秒）—— 保住起音的最前几个样本 */
export const FOOTSTEP_WATER_GRAIN_PRE_SECONDS = 0.006;

/** 颗粒尾部淡出时长（秒）：让末端归零，循环接缝不产生爆音 */
export const FOOTSTEP_WATER_TAIL_FADE_SECONDS = 0.045;

/**
 * 8 个单步在**素材里的时刻**（秒，已含冲击检测口径）。
 *
 * ⚠️ **选粒判据是频谱，不是峰值**：素材里峰值最大的几步（10.746 / 11.968 / 24.332）
 * 能量集中在 <200Hz 的泥闷低频（占 40~57%），听起来是「踩厚泥」而不是「踩水」。
 * 这里按 `wetScore = (0.5~5kHz 泼溅 + 0.5×5~8kHz 飞溅) − 0.8×>8kHz 嘶声 − 0.6×<200Hz 泥闷`
 * 排序取前列，并掺两步低频体感较强的（20.823 / 22.514 / 15.807）以免整段发飘。
 * 各步实测占比见 `assets/sounds/footstep-water.json` 的 `metrics.grains`。
 *
 * ⚠️ 奇偶位是**左右脚**：偶数索引（0/2/4/6）为重脚，奇数为轻脚，
 * 与 `FOOTSTEP_WATER_ALT` 一一对应。调换顺序会改变强弱落点（听感变，数值判据拓不到）。
 */
export const FOOTSTEP_WATER_GRAINS = Object.freeze([
  31.336, 20.823, 35.227, 22.514, 39.647, 43.568, 49.934, 15.807,
]);

/**
 * 逐步音量系数（左右脚强弱交替）。长度必须 = `FOOTSTEP_WATER_STEPS`。
 * 实测 `running_land` 奇偶步 RMS 均值差约 5%（0.0488 / 0.0511），这里略放大到 ~13%
 * 让「左右交替」听得出来；改这个数组只改强弱，不改节奏。
 */
export const FOOTSTEP_WATER_ALT = Object.freeze([1.0, 0.87, 0.96, 0.85, 1.0, 0.88, 0.95, 0.86]);

/**
 * 每步能量归一的**部分**幂次（0 = 完全归一、1 = 完全不归一）。
 * 0.65 = 压掉素材里步与步之间的悬殊差异，但保留自然起伏（全归一听起来像机器）。
 */
export const FOOTSTEP_WATER_NORM_POWER = 0.65;

/**
 * 逐颗粒 EQ 链（RBJ biquad，与 Web Audio 同公式）。按顺序串联。
 *
 * ⚠️ **两遍 180Hz 高通是必需的**：单遍 110Hz 后 80~200Hz 仍占 8~19%（实测），
 * 那一段是厚泥的隆隆声，与「踩水」无关。180Hz×2 把它压到 0.3%（实测），
 * 而 500~1200Hz 的水花体感只掉 1~2 个百分点。
 * ⚠️ **9kHz 高架 −4dB**：素材 >8kHz 占 10.5%，部分是录音底噪的嘶声；压掉后
 * 「沙沙」变「泼溅」。压过头（−8dB 以上）会让水花失去「水星子」的细节。
 * ⚠️ 2.2kHz +1.5dB 抬泼溅主体、550Hz +3dB 补「脚踩进水里」的重量感。
 */
export const FOOTSTEP_WATER_EQ = Object.freeze([
  Object.freeze({ kind: 'hp', f0: 180, q: 0.7071, gainDb: 0 }),
  Object.freeze({ kind: 'hp', f0: 180, q: 0.7071, gainDb: 0 }),
  Object.freeze({ kind: 'highshelf', f0: 9000, q: 0.7071, gainDb: -4.0 }),
  Object.freeze({ kind: 'peak', f0: 2200, q: 0.8, gainDb: 1.5 }),
  Object.freeze({ kind: 'peak', f0: 550, q: 0.7, gainDb: 3.0 }),
]);

/**
 * 响度对齐目标：`running_land.mp3` 的实测全片 RMS。
 * ⚠️ 冻结实测值。产物的 RMS 会被归一到它 —— 两路脚步声在各自音量档
 *（陆 0.2 / 水 0.25，见 `player._updateFootsteps`）下听感相当。
 */
export const FOOTSTEP_WATER_TARGET_RMS = 0.01780;

/**
 * 实现版本。改**算法**（叠接方式、归一顺序、淡出曲线形状）时必须 +1 ——
 * 那是参数指纹抓不到的一类改动（与 `CARBINE_SYNTH_VERSION` 同一手法）。
 */
export const FOOTSTEP_WATER_IMPL_VERSION = 1;

/**
 * 渲染预热圈数。⚠️ **不是可选项**：颗粒尾巴跨圈 + biquad 有状态，
 * 第 1 圈缺少「上一轮末尾几步的尾巴」⇒ 直接取第 1 圈当循环体，接缝处会缺一段声音。
 * 取第 2 圈（稳态）作为产物，实测「产物平铺 4 圈 ≡ 稳态长渲染」逐样本误差 **0**。
 */
export const FOOTSTEP_WATER_WARMUP_LOOPS = 1;

/** 渲染总圈数（预热 + 取样 + 校验用余量） */
export const FOOTSTEP_WATER_RENDER_LOOPS = 6;

/** 单步周期对应的样本数（整数，循环长度必须是它的整数倍） */
export function footstepWaterPeriodSamples() {
  return Math.round(FOOTSTEP_WATER_PERIOD * FOOTSTEP_WATER_RATE);
}

/** 循环总样本数 */
export function footstepWaterLoopSamples() {
  return footstepWaterPeriodSamples() * FOOTSTEP_WATER_STEPS;
}