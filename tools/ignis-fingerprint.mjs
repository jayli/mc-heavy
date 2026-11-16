// tools/ignis-fingerprint.mjs — 焰魔（Ignis）烘焙的**参数、产物指标与输入指纹**共享模块
//
// 唯一权威（红线 1）：烘焙脚本 `bake-ignis.mjs` 与数据契约门 `check-data.mjs` 都从这里
// import，不得各写一份。与 `dragon-fingerprint.mjs` / `arena-fingerprint.mjs` /
// `zombie-skin-fingerprint.mjs` 同一手法。
//
// 素材**入库**（`assets/ignis/src/`，与 `assets/dragon/src/` 同口径：烘焙输入，不是渲染资源）
// → 指纹不依赖仓库外文件，任何机器 `npm run check` 结果一致。
//
// ⚠️ node 侧模块（要读文件），不进 `src/`，浏览器不消费。
// ⚠️ **`src/**` 与浏览器单测绝不能 import 它** —— 它依赖 `node:fs`，浏览器无法解析 `node:`
// 协议 → 整个模块不加载 → 游戏白屏，而 `check:arch` 抓不到这类运行时解析失败。
// 运行期消费的纯数据是 `assets/ignis/ignis.json`（产物）与 `src/entities/ignis/ignis-config.js`
// （玩法数值）。
//
// ## 素材来源（2026-11-05 用户提供）
//
// `[苦力怕论坛]v1.3.0-焰魔.mcaddon`（Bedrock 附加包，zip 内 GBK 编码路径）。
// 与姊妹仓库 `cataclysm1.19.2modding`（Java 版同 mod）的对照见
// `docs/superpowers/specs/2026-11-05-ignis-boss-design.md` §2.0：
// 贴图逐像素相同，但模型是**不同的建模迭代**（剑/盾骨骼拆分不同）⇒ 采用 Bedrock 版。
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const ROOT = path.resolve(import.meta.dirname, '..');

/** 烘焙输入目录（**入库**，不是渲染资源） */
export const IGNIS_SRC_DIR = path.join(ROOT, 'assets', 'ignis', 'src');
/** 输入：Bedrock 几何（53 骨骼 / 88 立方体 / 256² 贴图） */
export const IGNIS_GEO_SRC = path.join(IGNIS_SRC_DIR, 'ignis.geo.json');
/** 输入：Bedrock 动画（84 条；本仓只取 idle 与 attack） */
export const IGNIS_ANIM_SRC = path.join(IGNIS_SRC_DIR, 'ignis.animation.json');
/**
 * 输入：贴图（256²）。
 *
 * ⚠️ **只取 `ignis_idle_0.png` 这一张**：素材有 `idle_0`~`idle_7` 八帧火焰闪烁
 * （render_controller 按 `q.life_time * 12` 循环切帧），但用户 2026-11-05 裁定
 * **只取一张静态贴图**（与飞龙同口径）。八帧里第 0 帧是基准姿态，其余是火焰位移。
 */
export const IGNIS_TEX_SRC = path.join(IGNIS_SRC_DIR, 'ignis_idle_0.png');
/**
 * 输入：**盾的贴图**（256²，与主贴图分开的一张）。
 *
 * ⚠️⚠️ **主贴图里没有盾的任何像素**（2026-11-08 实测）：盾的 240 个顶点 UV 落在
 * `ignis_idle_0.png` 的一块**全透明区域**（盾 UV 覆盖的 771 像素里主贴图只有 23 个不透明），
 * 而同一区域在本文件里是 346 个不透明像素。原 Mod 的 `ignis.render_controllers.json` 把盾做成
 * **独立 render controller**（`Texture.shield` + `part_visibility: {"*": false, "shield*": true}`），
 * 即盾从来就用第二张贴图。
 *
 * 缺了它的形态：几何/骨骼/UV 全对、`check:data` 的结构判据全绿，但渲染器材质的
 * `alphaTest: 0.5` 把每个盾面判为透明 ⇒ **盾画了却一个像素也看不见**（用户 2026-11-08 报告
 * 「游戏里没见到焰魔携带盾牌」的真根因）。
 *
 * 烘焙期由 `bake-ignis.mjs` 把它**合成进**主贴图（两张图不透明像素零重叠，实测 8 帧 idle
 * 全为 0），运行期仍是单贴图单材质 ⇒ 零 draw call 增加、渲染器不必改。
 *
 * ⚠️ **只取基础版**：素材另有 `ignis_shield_crack1~3`（破盾裂纹）与 `ignis_soul_shield`
 * （魂态），本轮「只做视觉」不取；将来做破盾玩法时再加。
 */
export const IGNIS_SHIELD_TEX_SRC = path.join(IGNIS_SRC_DIR, 'ignis_shield.png');

/** 烘焙产物：模型 JSON（进运行期，`src/render/ignis-model.js` 加载） */
export const IGNIS_JSON = path.join(ROOT, 'assets', 'ignis', 'ignis.json');
/** 烘焙产物：贴图（进运行期，`TextureLoader` 加载） */
export const IGNIS_PNG = path.join(ROOT, 'assets', 'ignis', 'ignis.png');
/** 烘焙产物：伴随元数据（度量 / 指纹，不进运行期） */
export const IGNIS_META = path.join(ROOT, 'assets', 'ignis', 'ignis.meta.json');

/**
 * 烘焙参数。
 *
 * ⚠️ **`scale: 1`**（用户 2026-11-05 裁定「原生 1 倍」）：素材 16px/格下模型是
 * **3.73 × 4.07 × 5.16 格**（含剑尖，已由软件光栅化实测），约玩家 1.8 格的 2.2 倍。
 * 与飞龙的 `scale: 3` 不同 —— 飞龙的素材原生只有 6.25 格长，需要放大；焰魔原生就对。
 *
 * ⚠️ **`pxPerBlock: 16`** 是 Bedrock/MC 的原生口径（1 格 = 16 像素）。
 *
 * ⚠️ **`idleFrameCount: 60` 与 `IGNIS_ANIM_PERIODS.idle` 是同一个事实的两面**：
 * 待机动画的角速度是 128 **度/秒**（素材表达式 `q.life_time * 128` —— Molang 的三角函数
 * 以度为单位），周期 `360/128 = 2.8125` 秒。取 60 帧覆盖**恰好一个**周期，
 * `fps = 60 / 2.8125 = 21.333`（**不是整数，这是刻意的**）⇒ 产物 `duration` 与周期
 * **逐位相等**，循环接缝在数学上恒为 0。每帧转 `128/60 = 2.13°` ⇒ 缓慢呼吸是平滑的。
 *
 * ⚠️ **曾经取 12 帧**（当时误把周期算成 `2π/128` = 0.049 秒的快频摆动，12 帧正好一个周期）。
 * 度制修正后周期变成 2.8125 秒（**57 倍长**），12 帧会退化成每帧 10.67° 的可见跳帧。
 *
 * ⚠️ **`rotationConvention`（v2.58）是烘焙「算法」的版本标记，不是可调参数。**
 * 输入指纹只覆盖输入文件与参数，**改烘焙算法而不动参数时指纹不变**（本文件下方已记的盲区）——
 * 旋转约定恰恰是这类改动：它不改任何输入，却改变产物里每一根骨骼的 bind 四元数与每一帧的姿态。
 * 把约定写进参数 ⇒ 换约定必换指纹 ⇒ `check:data` 会报「产物已过期，跑 npm run ignis」。
 *
 * 取值 `'java-zyx-additive'` 的含义（权威说明见 `tools/bake-ignis.mjs` 的 `bedrockRotation`）：
 * 骨骼旋转 `R = Rz(−θz) · Ry(+θy) · Rx(−θx)`（Z→Y→X 作用顺序，X/Z 取反），关键帧与 bind 欧拉角**逐轴相加**。
 * 曾经的 `'xyz-composed'`（`Euler('XYZ')` + `bind × delta`）把蓄力翻成向身后抡、劈砍翻成向前尖刺。
 */
export const IGNIS_BAKE_PARAMS = Object.freeze({
  scale: 1,
  pxPerBlock: 16,
  textureSize: 256,
  /** 待机动画的帧率不是这个值 —— 它由 `idleFrameCount / 周期` 算出。此字段只用于攻击 */
  defaultFps: 30,
  idleFrameCount: 60,
  rotationConvention: 'java-zyx-additive',
});

/**
 * 动画周期（秒）。**由素材内容计算，不写字面量**。
 *
 * - `idle`：素材 `generala`/`generalb` 的表达式是 `Math.sin(q.life_time * 128)`，
 *   而 **Molang 的三角函数以「度」为单位**（不是弧度）⇒ 角速度 128 **度/秒**
 *   ⇒ 周期 `360 / 128 = 2.8125` 秒。
 *
 *   ⚠️⚠️ **不是 `2π/128`（那是弧度的算法）**：2026-11-05 实测踩到 —— 按弧度算得到
 *   0.049 秒的周期，把「缓慢呼吸」变成了 20.4 Hz 的抖动（用户实玩报告「身体在抖动」）。
 *   两者相差 **57 倍**，而「帧数 = 12、duration ≡ 周期」这个产物契约在两种口径下都自洽，
 *   所以只有**求值器的单位口径**拦得住（`src/tests/test-molang.js` 的度制用例）。
 * - `attack`：素材 `attack6a` 的 `animation_length` = 2.75 秒（55 tick）。
 *   ⚠️ **不是 `attack1`（3.5 秒 / 70 tick）** —— tick 配对表（spec §2.0）显示 55 tick
 *   ↔ Java `SWING_ATTACK`，而 `attack1` 对应 `SHIELD_SMASH_ATTACK`（盾碎）。
 * - `spin`（v2.75）：素材 `attack8a3` 的 `animation_length` = 1.9 秒（38 tick），
 *   ↔ Java `SPIN_ATTACK`（`Animation.create(38)`）。
 *   ⚠️ 38 tick 在素材里有 4 条候选，**只有 `attack8a3`** 在 t=0.0 / 0.5 的九根骨骼上与
 *   `SPIN_ATTACK` 非破盾分支逐位相等（`attack8b3` = 破盾变体，`attack8a2/b2` =
 *   `HORIZONTAL_SMALL_SWING_ALT_ATTACK2`）。详见 `ignis-config.js` 的 `IGNIS_ATTACKS`。
 * - `shieldSmash`（v3.01）：素材 `attack1` 的 `animation_length` = 3.5 秒（70 tick），
 *   ↔ Java `SHIELD_SMASH_ATTACK`（`Animation.create(70)`）。
 *   ⚠️ 2026-11-13 实测扫描全部 82 条 ignis 动画：`attack1` 与 `SHIELD_SMASH_ATTACK`
 *   共有骨骼关键帧最大逐轴差 **15.000°**（对照组 `attack6a ↔ SWING_ATTACK` 12.462°，同量级），
 *   第二名 30° 已是 2 倍。且 3.5s 的候选只有 4 条，其余三条是阶段转换（`phase_soul*`）。
 * - `shieldBash`（v3.03）：素材 `attack11` 的 `animation_length` = 5.7 秒（114 tick），
 *   ↔ Java `ULTIMATE_ATTACK`（`Animation.create(114)`）。
 *   ⚠️ 这是**源时长**，不是产物时长 —— 本招有三段时间重映射（见 `IGNIS_ANIM_TIME_WARP`），
 *   产物时长由 `ignisAnimOutputPeriod('shieldBash')` 给出（3.89s）。
 *   ⚠️ 关键帧级比对：108 个共有分量中 **107 个逐轴 0 差**（唯一差异 t=3.70 的 `sword.y` 2.5°）。
 */
export const IGNIS_ANIM_PERIODS = Object.freeze({
  idle: 360 / 128,
  attack: 2.75,
  spin: 1.9,
  /** v3.01：Java `Animation.create(70)` ÷ 20 = 3.5 秒（素材 `attack1`） */
  shieldSmash: 3.5,
  /** v3.03：Java `Animation.create(114)` ÷ 20 = 5.7 秒（素材 `attack11`）—— **源**时长 */
  shieldBash: 5.7,
  /**
   * v3.06：Java `EARTH_SHUDDERS_ATTACK` = `Animation.create(138)` ÷ 20 = 6.9 秒
   *（素材 `attack3a`）—— **源**时长。两条产物共用同一源，段表不同。
   * ⚠️ 配对依据是**关键帧级实测**：全量扫描 84 条素材 × 139 tick × 9 骨骼 × 3 轴 = 3753 个分量，
   * `attack3a` 平均差 **1.053°**，第二名 `attack3b` **10.004°**（10 倍）⇒ 唯一候选。
   */
  spikeSlash: 6.9,
  spikeSlash2: 6.9,
});

/**
 * 招式的**分段时间重映射**（v3.03，用户裁定②「保留但压缩蓄力段」）。
 *
 * ## 为什么需要它（不是为了让测试通过而调参）
 *
 * 原版 `ULTIMATE_ATTACK` 全长 5.70s，其中 **3.35s 是举盾/举剑蓄力**（原版这段配火焰柱 +
 * 震屏 + 8 段火焰喷射，按「只扣血」裁定全部去掉）⇒ 去掉特效后 3.35s 纯举盾显得空。
 * 而真正的砸下段是 `startKeyframe(2)` = **2 tick = 100ms = 3 帧 @30fps**，
 * 在 60fps 画面上只有 6 帧，叠加淡入后几乎看不见（v3.02 两次实玩都报「只有一个起手式」）。
 *
 * ⇒ **蓄力压缩、砸下拉长**，其余段原速。这是用户明确选择的取舍，
 * 与 v3.02 失败的第 3 轮调参的区别：那次是在**错误的招式**上拉长时间，这次是在正确的招式上按裁定压缩。
 *
 * ## 四段语义（源时间轴，秒）
 *
 * | 段 | 源区间 | 产物时长 | 倍率 |
 * |---|---|---|---|
 * | A 蓄力 | `0 ~ chargeEnd` | `chargeEnd / chargeScale` | 压缩 |
 * | B 峰值静止 | `chargeEnd ~ slamStart` | 原速 | ×1 |
 * | C 砸下 | `slamStart ~ slamEnd` | `dstSlamSeconds` | 拉长 |
 * | D 砸后 + 收势 | `slamEnd ~ period` | 原速 | ×1 |
 *
 * ⚠️ **命中帧的语义位置不变**：仍是「盾刚砸到底」那一刻（源 tick 74），
 * 只是到达它的墙钟时间变短 ⇒ `hitFrameSeconds` = A+B+C = 1.89s。
 *
 * ⚠️ **参数进指纹**（`ignisInputFingerprint` 的 params 哈希）⇒ 改这里必须重烘，
 * 否则是「warp 参数变了但产物还是旧节奏」的静默过期。
 */
export const IGNIS_ANIM_TIME_WARP = Object.freeze({
  shieldBash: Object.freeze({
    /** 蓄力段结束（源秒）= 盾二次举到最高点前的最后一次缓入终点 */
    chargeEnd: 3.35,
    /** 蓄力段压缩倍率（源时长 ÷ 此值 = 产物时长）。2.5 ⇒ 3.35s → 1.34s */
    chargeScale: 2.5,
    /** 砸下段起点（源秒）= 峰值静止段结束 */
    slamStart: 3.60,
    /** 砸下段终点（源秒）= 盾砸到底，也是原版 tick 74 的结算时刻 */
    slamEnd: 3.70,
    /** 砸下段的产物时长（秒）。0.30 ⇒ 源 100ms 拉长 ×3，画面可见过程实测 500ms */
    dstSlamSeconds: 0.30,
  }),
});

/**
 * 招式的**多段时间重映射**（v3.06）—— 比 `IGNIS_ANIM_TIME_WARP` 的四段形态更通用。
 *
 * ## 为什么需要它（四段 warp 装不下本招）
 *
 * `shieldBash` 的四段 A/B/C/D 是**源时间轴上连续**的四段（只改倍率，不跳跃）。
 * 而尖刺攻击要**跳过源素材的中间一整段**：
 * 原版 `EARTH_SHUDDERS_ATTACK` 三刀是「下劈(tick32) → **上撩**(tick74) → 下劈(tick118)」，
 * 用户要的是「劈两次」⇒ 取第一刀与第三刀，**上撩整段去掉**。
 * 实测剑身轴竖直分量：第一/三刀 **−0.915**（剑尖朝下），第二刀 **+0.851**（朝上）。
 * ⇒ 源时间轴必须从 2.75 **跳到** 4.70，四段连续 warp 表达不了。
 *
 * ## 段表语义
 *
 * 每段 `{srcStart, srcEnd, scale, blendIn?}`：产物时长 = `(srcEnd − srcStart) × scale`，
 * 段内线性映射回源时间。段与段之间**源时间可以不连续**（那就是拼接接缝）。
 *
 * `blendIn`（秒，产物时间）标在**接缝后的那一段**上：该段前 `blendIn` 秒内，
 * 把「上一段末源时刻的姿态」与「本段实时采样」按 smoothstep 混合，消除接缝跳变。
 * ⚠️ **补间在烘焙期做**（产物帧已含补间）⇒ 渲染器与 `sampleIgnisAttack` 零改动。
 * ⚠️ 首段不得有 `blendIn`（没有「上一段」）。
 *
 * ## 倍率取值（同 shieldBash 的手法：蓄力压缩、劈下拉长）
 *
 * 举起 ×0.5 / 举剑保持 ×1/3 / **劈下 ×2** / 劈底保持与收势 ×0.5。
 * 源劈下段只有 0.20s（第一刀）/ 0.15s（第三刀），×2 后是 0.40s / 0.30s ⇒ 肉眼可见。
 * 压缩后单刀 1.716667s / 双刀 2.75s，都 < `attackCooldownMin` 4.0（冷却不变式保住）。
 *
 * ⚠️ **参数进指纹** ⇒ 改这里必须重烘。
 */
export const IGNIS_ANIM_SEGMENTS = Object.freeze({
  /** 单刀：第一刀 + 收势（玩家 > 4 格时播这条） */
  spikeSlash: Object.freeze([
    Object.freeze({ srcStart: 0.00, srcEnd: 0.75, scale: 0.5 }),      // 举起
    Object.freeze({ srcStart: 0.75, srcEnd: 1.40, scale: 1 / 3 }),    // 举剑保持
    Object.freeze({ srcStart: 1.40, srcEnd: 1.60, scale: 2.0 }),      // 劈下（命中帧在末）
    Object.freeze({ srcStart: 1.60, srcEnd: 2.55, scale: 0.5 }),      // 劈底保持
    // 收势：源 2.55 → 6.40 是接缝（逐骨差 35.0° @upperbody）⇒ 补间。
    //
    // ⚠️⚠️ **收势段不压缩（×1）且 blendIn 只取 0.1**（实测缺陷，同双刀那一段）：
    // 源 [6.40,6.90] 里 sword.x 从 **180° 转到 0°**（整个翻回）。
    // 初版 ×0.5 ⇒ 0.25s = 7.5 帧要转 180°（24°/帧），而 blendIn 0.2 又占掉 6 帧
    // ⇒ 180° 被挤进最后 1.5 帧，实测单帧 **22.64°** > 片段上限 15.58°。
    // ×1 ⇒ 0.5s = 15 帧（12°/帧），blendIn 0.1 只占 3 帧 ⇒ 剩下 12 帧做旋转。
    Object.freeze({ srcStart: 6.40, srcEnd: 6.90, scale: 1.0, blendIn: 0.1 }),
  ]),
  /** 双刀：第一刀 + 剑回正 + 第三刀 + 收势（玩家 ≤ 4 格时播这条） */
  spikeSlash2: Object.freeze([
    Object.freeze({ srcStart: 0.00, srcEnd: 0.75, scale: 0.5 }),      // 第一刀举起
    Object.freeze({ srcStart: 0.75, srcEnd: 1.40, scale: 1 / 3 }),    // 第一刀举剑保持
    Object.freeze({ srcStart: 1.40, srcEnd: 1.60, scale: 2.0 }),      // 第一刀劈下
    Object.freeze({ srcStart: 1.60, srcEnd: 2.55, scale: 0.5 }),      // 第一刀劈底保持
    Object.freeze({ srcStart: 2.55, srcEnd: 2.75, scale: 0.5 }),      // 剑回正（前段）
    // 第三刀举起 + 举剑保持（合成一段）：源 2.75 → 4.70 是接缝（逐骨差 17.8°）⇒ 补间。
    //
    // ⚠️⚠️ **必须把「举起」与「保持」合成一段，不能拆开**（实测缺陷）：
    // 初版拆成 [4.70,4.90]×0.5（3 帧）+ [4.90,5.75]×1/3，并给前者 blendIn 0.1。
    // 但前者自身就要转 54.4°（sword.x 125.6 → 180）—— 3 帧里既要做完 54.4° 旋转
    // 又要释放 17.8° 接缝跳变 ⇒ smoothstep 把变化挤进最后一帧，实测单帧 **30.11°**
    //（片段自身上限 14.93° 的 2 倍）。且 blendIn 不得超本段时长，3 帧段装不下更长的补间。
    //
    // 合成后：源 [4.70,5.75] × 1/3 = 0.35s = **10 帧**，blendIn 0.35 铺满整段
    // ⇒ 权重每帧只降 ~0.1，接缝跳变被摊到 10 帧上。
    // 代价：举剑保持段从 0.283s 缩到 0.217s（观感上仍是「举起来停一下」）。
    Object.freeze({ srcStart: 4.70, srcEnd: 5.75, scale: 1 / 3, blendIn: 0.35 }),
    Object.freeze({ srcStart: 5.75, srcEnd: 5.90, scale: 2.0 }),      // 第三刀劈下
    Object.freeze({ srcStart: 5.90, srcEnd: 6.40, scale: 0.5 }),      // 第三刀劈底保持
    // 收势（源连续，无接缝）—— ⚠️ **同样不压缩**：该段 sword 要转 180°，
    // ×0.5 会得 24°/帧（超片段上限）。与单刀收势段保持同一倍率。
    Object.freeze({ srcStart: 6.40, srcEnd: 6.90, scale: 1.0 }),
  ]),
});

/**
 * 某招的**产物时长**（秒）—— 烘焙器定帧数与 `check:data` 校验帧数的**唯一权威**（红线 1）。
 *
 * ⚠️⚠️ **不能直接用 `IGNIS_ANIM_PERIODS[key]`**：有 warp 的招两者不同
 *（`shieldBash` 源 5.7 / 产物 3.89）。两侧各写一份换算的形态是
 * 「产物对了但门禁按源时长算帧数 ⇒ 新招必红」，而红的原因看起来像产物错。
 *
 * ⚠️ **参数非法必须 throw，不得静默返回原 period**：静默回落会让「warp 写错了」
 * 表现为「动画没压缩」——那是观感缺陷，而所有计数类判据仍然自洽。
 *
 * @param {string} key 招式键（`IGNIS_ANIM_PERIODS` 的键）
 * @returns {number} 产物时长（秒）
 */
export function ignisAnimOutputPeriod(key) {
  const period = IGNIS_ANIM_PERIODS[key];
  if (!Number.isFinite(period) || period <= 0) {
    throw new Error(`[焰魔] 招式 "${key}" 缺合法的 IGNIS_ANIM_PERIODS`);
  }
  // v3.06：多段段表优先（源时间轴可跳跃，四段 warp 表达不了）
  const segs = IGNIS_ANIM_SEGMENTS[key];
  if (segs) {
    const bad = (why) => {
      throw new Error(`[焰魔] 招式 "${key}" 的 IGNIS_ANIM_SEGMENTS 非法：${why}`);
    };
    if (!Array.isArray(segs) || segs.length === 0) bad('段表为空');
    let total = 0;
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      if (!(s.srcEnd > s.srcStart)) bad(`seg${i} srcEnd ${s.srcEnd} 必须 > srcStart ${s.srcStart}`);
      if (!(s.scale > 0)) bad(`seg${i} scale ${s.scale} 必须 > 0`);
      if (!(s.srcStart >= 0 && s.srcEnd <= period)) bad(`seg${i} 源区间 [${s.srcStart},${s.srcEnd}] 超出 [0,${period}]`);
      const dur = (s.srcEnd - s.srcStart) * s.scale;
      if (s.blendIn !== undefined) {
        if (i === 0) bad('首段不得有 blendIn（没有「上一段」可混）');
        if (!(s.blendIn >= 0)) bad(`seg${i} blendIn ${s.blendIn} 必须 ≥ 0`);
        // ⚠️ 容差 1e-9：`(5.75−4.70)×(1/3)` 的浮点结果是 0.3499999999999999，
        // 而人写的 blendIn 是 0.35 —— 严格比较会把「铺满整段」这个合法写法判非法。
        if (!(s.blendIn <= dur + 1e-9)) bad(`seg${i} blendIn ${s.blendIn} 超过本段产物时长 ${dur}`);
      }
      total += dur;
    }
    return total;
  }
  const w = IGNIS_ANIM_TIME_WARP[key];
  if (!w) return period;
  const { chargeEnd, chargeScale, slamStart, slamEnd, dstSlamSeconds } = w;
  const bad = (why) => {
    throw new Error(`[焰魔] 招式 "${key}" 的 IGNIS_ANIM_TIME_WARP 非法：${why}`);
  };
  if (!(chargeEnd > 0)) bad(`chargeEnd ${chargeEnd} 必须 > 0`);
  if (!(chargeScale > 0)) bad(`chargeScale ${chargeScale} 必须 > 0`);
  if (!(slamStart >= chargeEnd)) bad(`slamStart ${slamStart} 必须 ≥ chargeEnd ${chargeEnd}`);
  if (!(slamEnd > slamStart)) bad(`slamEnd ${slamEnd} 必须 > slamStart ${slamStart}`);
  if (!(slamEnd <= period)) bad(`slamEnd ${slamEnd} 必须 ≤ 源时长 ${period}`);
  if (!(dstSlamSeconds > 0)) bad(`dstSlamSeconds ${dstSlamSeconds} 必须 > 0`);
  return chargeEnd / chargeScale + (slamStart - chargeEnd) + dstSlamSeconds + (period - slamEnd);
}

/**
 * 构造某招的「产物时间 → 源时间」映射（分段线性、单调、段界连续）。
 *
 * 无 warp 的招返回 `null`（烘焙器按恒等处理）。
 *
 * @param {string} key 招式键
 * @returns {{toSource: (tOut: number) => number}|null}
 */
export function ignisAnimTimeWarp(key) {
  // v3.06：多段段表（优先于四段 warp）
  const segs = IGNIS_ANIM_SEGMENTS[key];
  if (segs) {
    const total = ignisAnimOutputPeriod(key);   // 顺带做参数合法性校验
    // 预计算每段的产物区间与「上一段末源时刻」（补间的混合起点）
    const rows = [];
    let acc = 0;
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      const dur = (s.srcEnd - s.srcStart) * s.scale;
      rows.push({
        a: acc, b: acc + dur, s0: s.srcStart, s1: s.srcEnd, k: s.scale,
        blendIn: s.blendIn || 0,
        prevSrcEnd: i > 0 ? segs[i - 1].srcEnd : null,
      });
      acc += dur;
    }
    const segAt = (tOut) => {
      // ⚠️⚠️ **容差 1e-9 是载荷性的**（实测缺陷）：段界是累加出来的浮点数
      //（1.5666666666666669），而帧时刻是 `f/fps`（47/30 = 1.5666666666666667）——
      // 两者差 **2.2e-16**，严格 `<` 会把接缝首帧归到**上一段**⇒ 那一帧完全不补间，
      // 观感就是「补间没生效」（实测单帧 30.11°，片段上限 14.93° 的 2 倍）。
      for (let i = 0; i < rows.length; i++) {
        if (tOut < rows[i].b - 1e-9 || i === rows.length - 1) return i;
      }
      return rows.length - 1;
    };
    return {
      toSource: (tOut) => {
        const r = rows[segAt(tOut)];
        return r.s0 + (tOut - r.a) / r.k;
      },
      /**
       * 接缝补间权重（1 = 完全取上一段末姿态，0 = 完全取本段实时采样）。
       * 不在补间窗口内返回 `null`（烘焙器据此走零开销路径）。
       * ⚠️ 用 **smoothstep** 而不是线性：与 `IgnisPoseTransition` 同口径，端点导数为 0
       * ⇒ 补间起止处不产生新的速度跳变。
       */
      blendAt: (tOut) => {
        const r = rows[segAt(tOut)];
        if (!(r.blendIn > 0) || r.prevSrcEnd === null) return null;
        const u = (tOut - r.a) / r.blendIn;
        if (!(u >= 0 && u < 1)) return null;
        const s = u * u * (3 - 2 * u);   // smoothstep 0→1
        return 1 - s;
      },
      /** 上一段末源时刻（补间的混合起点）；无补间时 null */
      blendFromSource: (tOut) => {
        const r = rows[segAt(tOut)];
        return r.blendIn > 0 ? r.prevSrcEnd : null;
      },
      bounds: Object.freeze({
        seams: Object.freeze(rows.slice(1).map((r) => r.a)),
        total,
      }),
    };
  }
  const w = IGNIS_ANIM_TIME_WARP[key];
  if (!w) return null;
  const period = ignisAnimOutputPeriod(key);   // 顺带做参数合法性校验
  const { chargeEnd, chargeScale, slamStart, slamEnd, dstSlamSeconds } = w;
  const a = chargeEnd / chargeScale;           // 段 A 产物终点
  const b = a + (slamStart - chargeEnd);       // 段 B 产物终点
  const c = b + dstSlamSeconds;                // 段 C 产物终点（= 命中帧）
  const slamScale = (slamEnd - slamStart) / dstSlamSeconds;
  return {
    toSource: (tOut) => {
      if (tOut <= a) return tOut * chargeScale;
      if (tOut <= b) return chargeEnd + (tOut - a);
      if (tOut <= c) return slamStart + (tOut - b) * slamScale;
      return slamEnd + (tOut - c);
    },
    /** 段界（产物秒）—— 供判据核对单调性与连续性，不参与采样 */
    bounds: Object.freeze({ chargeEndOut: a, slamStartOut: b, slamEndOut: c, total: period }),
  };
}

/** 素材里的动画键名（`animation.null.<name>`），烘焙脚本按此取 */
export const IGNIS_ANIM_SOURCES = Object.freeze({
  /** 待机：**两条**动画合并（generala 驱动手臂、generalb 驱动 root/head） */
  idle: Object.freeze(['generala', 'generalb']),
  /** 普攻：蓄力 → 原地横扫（Java 的 SWING_ATTACK，55 tick） */
  attack: Object.freeze(['attack6a']),
  /**
   * 旋斩（v2.75）：整圈旋转 + 剑横持（Java 的 `SPIN_ATTACK`，38 tick）。
   *
   * ⚠️ **借助同一素材里的另一条动画（不新增任何资源）**。素材自带 84 条，本仓 v2.55
   * 只取了 2 条（idle + attack）；本键让烘焙器多取一条，**输入文件与贴图逐字节不变**。
   */
  spin: Object.freeze(['attack8a3']),
  /**
   * 持盾冲撞（v3.01）：举盾过顶后连人带盾向前下方压（Java 的 `SHIELD_SMASH_ATTACK`，70 tick）。
   * ⚠️ 不是「盾砸地」：实测盾尖最低只到 2.43 格（自己的胸腰高度），从未触地。
   *
   * ⚠️⚠️ **是 `attack1`，不是 `attack1_2`**：后者是 3s / 11 骨骼的另一招，
   * 同一探针下与 `SHIELD_SMASH_ATTACK` 差 **72.5°**（而 `attack1` 只差 15.0°）。
   * 键名只差三个字符，写错会烘焙出另一招而部分计数类判据仍通过。
   * 鉴别依据与完整扫描表见 spec §2.2（`2026-11-13-ignis-shield-smash-design.md`）。
   * 同旋斩：**零新增资源**，只是让烘焙器多取一条已入库的动画。
   */
  shieldSmash: Object.freeze(['attack1']),
  /**
   * 举盾砸击（v3.03）：举盾过顶 2.26 格 → 盾面转正前 → 向前 1.03 格 + 向下 2.61 格砸下
   *（Java 的 `ULTIMATE_ATTACK`，114 tick）。
   *
   * ⚠️ **选招依据是原版语义，不是几何形状**（v3.02 失败报告 §4.0 的教训）：
   * 独立 goal（`AttackAnimationGoal1`, look1=72）/ 首帧 `startKeyframe(18)` 能独立成招 /
   * tick 74 结算 `AreaAttack(6f, 6f, 45, …)` 恰好落在盾砸到底那一帧 / 盾面法线前方分量峰值 0.97。
   * 对照：`SHIELD_SMASH_ATTACK` 峰后前推仅 0.14 格而头前推 0.76（用户读作「头撞」）；
   * `SMASH` 峰后前推 **−1.31**（后退）；`STRIKE` 前推 4.18 但只降 0.51（是盾横扫）。
   *
   * ⚠️ **不是 `attack11` 之外的键**：`attack12`/`attack12T` 是 COMBO1 系（5.1/6.3s），
   * `attack10Sa` 是 REINFORCED_SMASH（5.75s，首帧 `startKeyframe(0)` 的连招下半段）。
   * 同旋斩/持盾冲撞：**零新增资源**，只是让烘焙器多取一条已入库的动画。
   */
  shieldBash: Object.freeze(['attack11']),
  /**
   * 尖刺攻击（v3.06）：举剑过顶 → 向下劈地（Java 的 `EARTH_SHUDDERS_ATTACK`，138 tick）。
   *
   * ⚠️ **两条产物共用同一源 `attack3a`**，差别只在段表（`IGNIS_ANIM_SEGMENTS`）：
   * 单刀取第一刀 + 收势；双刀取第一刀 + 剑回正 + 第三刀 + 收势。
   * 原版三刀里**第二刀是上撩**（剑身轴竖直分量 +0.851），用户要「再劈一次」⇒ 取第三刀。
   *
   * ⚠️ **不是 `attack3b`**：那是同一招的破盾变体，与 Java 非破盾分支平均差 10.004°
   *（`attack3a` 只差 1.053°，10 倍差距）。键名只差一个字符，写错会烘焙出另一套姿态。
   * 同旋斩/持盾冲撞：**零新增资源**，只是让烘焙器多取一条已入库的动画。
   */
  spikeSlash: Object.freeze(['attack3a']),
  spikeSlash2: Object.freeze(['attack3a']),
});

/**
 * 产物里属于「招式」的动画键（= `IGNIS_ANIM_SOURCES` 里除 idle 以外的全部）。
 *
 * 烘焙器按这张表**逐招**导出，`check:data` 按它逐招校验帧数 —— 新增一招只需在
 * `IGNIS_ANIM_SOURCES` 加一条，两个消费方自动跟上（不写第二份清单）。
 */
export const IGNIS_ATTACK_ANIM_KEYS = Object.freeze(
  Object.keys(IGNIS_ANIM_SOURCES).filter((k) => k !== 'idle'),
);

/**
 * 产物必须满足的指标 —— 烘焙脚本与 `check:data` 共用这一份。
 *
 * 全部实测值（解析 `assets/ignis/src/ignis.geo.json` 可复现）：
 *  - **53 根骨骼**，其中 50 根挂了立方体，但**只有 43 根**的立方体是非零尺寸
 *  - **88 个立方体**，其中 **8 个含 0 尺寸分量**（`right_helmet` 这类零厚薄片，
 *    `BoxGeometry` 对 0 尺寸会退化成退化三角形 ⇒ 跳过）⇒ **烘焙 80 个**
 *  - 每立方体 `BoxGeometry` 产出 24 顶点 / 36 索引 ⇒ `80 × 24 = 1920` 顶点、
 *    `80 × 36 = 2880` 索引
 *  - bind pose 的模型空间 bbox（含骨骼旋转、含剑盾）= **78.07 × 61.35 × 82.52 px**
 *    = **4.8796 × 3.8346 × 5.1576 格**（宽×高×深，1 倍）
 *    ⚠️ v2.58 前冻结为 3.7329 × 4.0668 × 5.1576，那是**错误旋转约定**下的值；现值由
 *    `node tools/ignis-java-reference.mjs` 直接解析 Java 源码独立复算，与产物逐位一致。
 *
 * ⚠️ **`boneCount` / `cubeCount` 是「素材事实」而不是「可调参数」**：素材换了它们才会变。
 * 把它们钉在这里的意义是「烘焙漏了骨骼/立方体」会立刻被抓到（静默缺肉的形态是身上有洞）。
 */
export const IGNIS_METRICS = Object.freeze({
  boneCount: 53,
  /** 几何里挂了至少一个立方体的骨骼数（含只有零尺寸薄片的那些）= 50 */
  bonesWithAnyCubes: 50,
  /**
   * 实际有「非零尺寸立方体」被烘焙的骨骼数 = **43**。
   *
   * ⚠️ **不能是 50**：另 7 根骨骼只挂了零尺寸薄片（如 `right_helmet` 的 `[0,5,7]`），
   * 全部被跳过 ⇒ 它们不贡献任何顶点。这是实测值（2026-11-05 逐骨骼统计），
   * 写成 50 会让烘焙器在正确的实现上报错。
   */
  bonesWithCubes: 43,
  cubeCount: 88,
  /** 含 0 尺寸分量、被跳过的立方体数 */
  skippedCubes: 8,
  /** 实际参与烘焙的立方体数 = cubeCount − skippedCubes */
  bakedCubes: 80,
  vertexCount: 1920,
  indexCount: 2880,
  scale: 1,
  /**
   * 盾贴图（`IGNIS_SHIELD_TEX_SRC`）里的不透明像素数（alpha > 128）= **5816**。
   *
   * ⚠️ 这条度量是**内容级**判据：结构判据（骨骼数/顶点数/UV 值域）在「盾不可见」时
   * **全部通过**，只有「数一数贴图里到底有没有东西」才能抓住它。`check:data` 用它交叉
   * 核对烘焙产物确实把盾贴图叠了进来（产物 PNG 的盾 UV 区域不透明像素 > 0）。
   */
  shieldOpaquePixels: 5816,
});

/**
 * 烘焙输入指纹：`<四份输入内容 sha 前 16>:<参数 sha 前 16>`。
 *
 * 两个消费方（烘焙脚本写进 meta、`check:data` 重算比对）必须拿到同一格式。
 * 改 `IGNIS_BAKE_PARAMS` / `IGNIS_METRICS` / `IGNIS_ANIM_PERIODS` / 任一输入文件都会改变
 * 指纹 → 门禁报「产物已过期，跑 npm run ignis」，防静默过期。
 *
 * ⚠️ **四份输入串联后取一次 sha**（不是各自取 sha 再拼）：拼接顺序固定
 * （geo → anim → png → shieldPng），换顺序会换指纹，这是刻意的 —— 指纹描述的是「这一组输入」。
 *
 * ⚠️ v2.83（2026-11-08）起**盾贴图也进指纹**：它参与合成产物 PNG，改了它不重烘就是
 * 「盾的造型静默变了但产物没变」——正是指纹要防的那类过期。
 *
 * 已知盲区（与图标/夜空/巨树/高台/竞技场/中世纪船/龙同口径）：只改**烘焙算法**而不动参数时
 * 指纹不变 —— 那类改动靠 `src/tests/test-ignis-bake.js` 的产物契约与 Tier 4 兜住。
 *
 * @returns {{input: string, sourceSha256: string, paramsSha256: string}}
 */
export function ignisInputFingerprint() {
  for (const [label, p] of [
    ['几何', IGNIS_GEO_SRC], ['动画', IGNIS_ANIM_SRC], ['贴图', IGNIS_TEX_SRC],
    ['盾贴图', IGNIS_SHIELD_TEX_SRC],
  ]) {
    if (!fs.existsSync(p)) {
      throw new Error(`[焰魔] 烘焙输入缺失（${label}）：${p}（素材入库，缺失 = 仓库损坏）`);
    }
  }
  const hash = createHash('sha256');
  for (const p of [IGNIS_GEO_SRC, IGNIS_ANIM_SRC, IGNIS_TEX_SRC, IGNIS_SHIELD_TEX_SRC]) {
    hash.update(fs.readFileSync(p));
  }
  const sourceSha256 = hash.digest('hex');
  const paramsSha256 = createHash('sha256')
    .update(JSON.stringify({
      IGNIS_BAKE_PARAMS, IGNIS_METRICS, IGNIS_ANIM_PERIODS, IGNIS_ANIM_SOURCES,
      // v3.03：warp 参数必须进指纹 —— 否则「改了压缩倍率但没重烘」是静默过期
      IGNIS_ANIM_TIME_WARP,
      // v3.06：多段段表同理（含 blendIn —— 改补间时长不重烘 = 接缝跳变静默复活）
      IGNIS_ANIM_SEGMENTS,
    }))
    .digest('hex');
  return {
    input: `${sourceSha256.slice(0, 16)}:${paramsSha256.slice(0, 16)}`,
    sourceSha256,
    paramsSha256,
  };
}
