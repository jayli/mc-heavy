// src/render/spike-fx-config.js — 焰魔尖刺的**破土火星 / 上浮余烬**观感常量（**three-free**）
//
// 用户 2026-11-20：「我想让焰魔的尖刺攻击特效中，从地面升起的若干个尖刺升起的时候，
// 带有粒子特效，丰富一下视觉体验，就好像蹦出的火星一样。」
//
// **两项选型裁定**（`ask_user_question`）：
//   ① 节奏 = **破土猛迸 + 余烬渐稀**：升起段（`riseMs` 180ms）喷得最密，
//      保持期只剩零星几颗往上飘，**尖锥开始缩回时停**（火星跟着刺走）。
//      不取「只迸一次」（保持期 700ms 里刺是静止的）也不取「全程持续冒」
//      （会盖过刺本身的形体，且与法阵/火圈的观感撞车）。
//   ② 构成 = **条状火星 + 少量上浮余烬**，**不加烟**（5 根刺各冒烟会糊成一片灰雾，
//      且烟是非加法混合，会压暗地面）。
//
// ## 与 `fire-ring-config.js` / `cinder-fall-config.js` 的分工
//
// 三者都是「暖色 GPU 粒子」，但**发射几何完全不同**，故不共用出生数据函数：
//   · 火圈：沿**圆周**撒（`fireRingSparks`，半径随时间外扩）；
//   · Cinder：沿**弹道弧**撒（`cinderArcPoint`，飞行中）+ 落点一次大喷发；
//   · 本表：沿**每根刺的破土环**撒，出生高度跟着那一根的**升起进度**上移。
// 共用的只有 **TSL 结构**（阻力积分 + 屏幕尺寸硬钳 + 四停靠渐变 + 视图空间拉伸）
// 与 **配色**（直接引 `CINDER_FX`，红线 1：不另写一套橙）。
//
// ## 为什么单独成模块（与 storm-lance / cinder-fall / fire-ring 同手法）
//
//   ① Tier 1 单测能直接 import 它断言常量关系与纯函数，**不必经过 three 的 GPU 初始化**；
//   ② 玩法量（高度/半径/升起时长/寿命）从 `IGNIS_SPIKE` **派生**，观感量在这里 ——
//      两边各写一份会漂移出「火星从半空中冒出来而刺还在地里」（红线 1）。
//
// ⚠️ **本文件不 import three**，也不 import `spike-fx.js`（后者会 import 本文件 ⇒ 循环）。
// 依赖方向单向：`spike-fx-config` ← `spike-fx-material` ← `spike-fx`。
import { IGNIS_SPIKE } from '../entities/ignis/ignis-config.js';
import { CINDER_FX as CF } from './cinder-fall-config.js';

/**
 * 尖刺火星的节奏、形状与容量（冻结，渲染层不得改写）。
 *
 * ⚠️ **前五项全部派生自玩法权威 `IGNIS_SPIKE`** —— 在这里另写一份 height/riseMs
 * 的形态是「火星与刺长在不同尺度上」，而颗数/可见性/draw call 判据全绿。
 */
export const SPIKE_SPARK_FX = Object.freeze({
  // ---- 玩法派生（唯一权威在 entities/ignis/ignis-config.js）----
  /** 尖锥高度（格）—— 出生高度沿它上移 */
  height: IGNIS_SPIKE.height,
  /** 尖锥底半径（格）—— 破土环的基准半径 */
  radius: IGNIS_SPIKE.radius,
  /** 升起时长（ms）—— 猛迸段 */
  riseMs: IGNIS_SPIKE.riseMs,
  /** 尖锥总寿命（ms） */
  lifeMs: IGNIS_SPIKE.lifeMs,
  /**
   * 尖锥开始缩零的寿命进度 —— **本仓这一事实的唯一权威**。
   *
   * `spike-fx.js` 的 `SPIKE_FX.shrinkFrom` **派生自它**（那边是包络，这边是「停止发射」
   * 的时刻，两者必须是同一个数：刺开始缩回时火星就得停）。
   * ⚠️ 权威放在 three-free 的本文件是为了避免循环 import
   * （`spike-fx.js` 要 import 本表拿速率与容量）。
   */
  shrinkFrom: 0.7,

  // ---- 绘制顺序与容量 ----
  /**
   * transparent 队列里的绘制序号。**与闪电 / Cinder / 火圈同档 3**
   * （体素水 0 < 海面 1 < 曳光 2 < 特效 3）。空闲 `visible=false` ⇒ 队列回到基线，
   * 水面顺序不变式（`water-order.spec.mjs`）不受影响。
   */
  renderOrder: CF.renderOrder,
  /**
   * 两个粒子池各自的容量（环形缓冲）。
   *
   * **推导，不是拍的**（v3.26 按 30 根重算）：
   * 一次 spawn = **30 根** × (火星 27 + 余烬 9) = **1080 颗**；
   * 同一只焰魔两刀的最小间隔 = `secondHitFrame − hitFrameSeconds` = **1.225s**，
   * 而一次 spawn 的粒子最长命 = 最大延迟 250ms + 缩回起点 630ms + 余烬 0.95×1.3s
   * ≈ **2.115s** > 1.225s ⇒ **两批会重叠**。
   * 单类最坏并发 = 27 × 30 × 2 = **1620 颗** ⇒ 取 **4096**（2 的幂）。
   *
   * ⚠️ 4096 同时装得下「速率还原成不降」那个口子（30×55×2 = **3300**）——
   * 若用户实玩后要「每根都和以前一样密」，只需还原四个速率，不必再改容量。
   * 两池属性合计 320 KiB（旧 768 时是 60 KiB）。
   * 关系式由 `test-spike-sparks.js` 钉住（改颗数/寿命/根数会红）。
   */
  capacity: 4096,

  // ---- 三段速率（颗/秒）----
  //
  // ⚠️⚠️ **v3.26 四个速率一律÷2**（根数 5 → 30，单根减半）。
  //
  // **为何不取÷6（保持总量持平）—— 实测推翻了首版方案**：
  // ÷6 后每根只剩 **9 颗**火星，逐帧 16ms 的批次序列是 `[1,1,1,1,1,1,1,1,1]`
  // ⇒ **每批恒 1 颗**，「破土猛迸」在单根上读不出来，且既有断言
  // 「首批（破土）须多于末批（渐稀）」**直接红**（1 vs 1）—— 那条断言是真判别力，不得放宽。
  //
  // 五档扇描（每档跑全部九条既有关系式）：
  //   不降 55/18 ⇒ 池账红；÷6 9/3 ⇒ 首>末红；÷4 13/4 ⇒ 首>末红；
  //   ÷3 18/6 ⇒ 首>末红；**÷2 27/9 ⇒ 九条全过**（首批 2 / 末批 1，17 批）。
  //
  // 总量：火星 27×30 = **810 颗/次**（旧 275 的 2.95 倍）—— 根数 6 倍而单根减半，
  // 单位面积密度降到旧的一半，既不糊成橙雾盖掉剑形体，也保住了单根的「猛迸→渐稀」节奏。
  /**
   * 破土段速率（`lived < riseMs`）—— **猛迸**。
   *
   * ⚠️ **旧值 240 是像素实测标定的**（v3.23）：首版 150 在真实交战距离（4 格）
   * 只得到 **7~193** 个暖色像素（每颗只 2.3px）—— 读不出「蹦出的火星」。
   * 同机位单变量扇描（密度×尺寸）：基线 150/0.055 ⇒ 193；尺寸×1.8 ⇒ 425；
   * **密度×1.6 + 尺寸×1.8 ⇒ 884**；×2.2/×2.2 ⇒ 1655（开始糊成一片）。
   * v3.26 在此基础上÷2（根数涨了 6 倍）。
   */
  burstRate: 120,
  /**
   * 保持段速率（`riseMs ≤ lived < lifeMs × shrinkFrom`）—— **渐稀**。
   * 450ms × 13 ≈ 6 颗/根。⚠️ 不得为 0（用户裁定「渐稀」不是「归零」），
   * 也不得接近 burstRate（那读作匀速冒烟，猛迸感消失）。
   */
  trickleRate: 13,
  /** 余烬的两段速率（同形，量级更小 —— 用户要「少量」） */
  emberBurstRate: 38.5,
  emberTrickleRate: 5,

  // ---- 出生几何 ----
  /**
   * 破土环半径倍率（× 尖锥底半径）。
   * ⚠️ **不得为 0**：全部从刺心一个点发射会读作「定点星爆」
   * （Storm Lance v3.20 实测教训）。取 1.6 ⇒ 环半径 0.56 格，
   * 比刺底稍宽 —— 读作「土被顶开的那一圈」。
   */
  ringSpread: 1.6,
  /**
   * 出生高度沿锥面的爬升系数（× 升起进度 × height）。
   *
   * ⚠️ 取 **0.55 而不是 1.0**：火星是「土被顶开时迸出的」，主体应贴着**地面**，
   * 只有少部分跟着锥尖上爬。取 1.0 会让全部火星贴着锥尖跑 ⇒ 读作「刺在喷火」
   * 而不是「破土迸火星」。
   */
  climb: 0.55,
  /** 出生高度的随机抖动（格）—— 避免所有粒子在同一水平面上（读作一条线） */
  birthJitter: 0.12,

  // ---- 火星（条状，沿速度拉伸）----
  /** 初速（格/秒）。比火圈的 4.2 快 —— 破土是瞬时的冲击，不是缓慢燃烧 */
  sparkSpeed: 5.4,
  /** 竖直分量占比（0..1）—— 越大越「向上迸」，越小越「向四周溅」 */
  sparkUpBias: 0.72,
  sparkLifetime: 0.55,
  /** 重力（格/秒²，负 = 下坠）—— 火星走抛物线，读作迸出去又落下来 */
  sparkGravity: -9.5,
  /**
   * 火星尺寸（格）。⚠️ **0.10 是像素实测标定的**：首版照 Cinder 取 0.055，
   * 在 4~8 格距离上只投影成 **2.3px**（实测中位数）⇒ 几乎看不见。
   * ×1.8 后 ≈ 4.2px，配密度×1.6 得到 884 个暖色像素（基线 193）。
   * 上限仍由 `sparkMaxScreen` 硬钳（玩家站在刺上时不糊成大光斑）。
   */
  sparkSize: 0.10,
  sparkDrag: 0.9,
  /**
   * 速度拉伸系数。⚠️ **必须 >0**：圆形羽化 quad 会被用户读作「冒爆米花」
   * （Storm Lance v3.20 实测）。拉伸与条状轮廓**缺一都退回圆点**。
   */
  sparkStretch: 0.18,
  /**
   * 屏幕空间尺寸上限（占屏高比例）。
   * ⚠️⚠️ 玩家可能正站在刺上（尖刺伤害判据就是「玩家压在刺格内」）⇒ 粒子离相机
   * 0.3 格，不钳的话会投影成上百像素的大光斑（Cinder Fall 实测的「爆米花」成因）。
   */
  sparkMaxScreen: 0.018,

  // ---- 余烬（圆点，往上飘）----
  emberSpeed: 1.7,
  emberUpBias: 0.85,
  emberLifetime: 0.95,
  /**
   * 浮力（格/秒²，**正 = 往上飘**）。
   * ⚠️⚠️ **符号与火星相反**：照抄 `sparkGravity` 的负值会让余烬往下掉，
   * 读作「碎屑落地」而不是「烧着的余烬慢慢升起来」，而所有计数判据全绿。
   */
  emberRise: 1.4,
  /** 余烬尺寸（格）—— 同步×1.8（否则余烬在画面上根本不存在） */
  emberSize: 0.063,
  emberDrag: 1.25,
  /** 余烬是圆点 ⇒ 屏幕上限定得比火星更紧（否则近处糊成大光斑） */
  emberMaxScreen: 0.012,

  /**
   * 粒子空闲多久后隐藏 mesh（秒）。
   * 取最长寿命（余烬 0.95 × 1.3 抖动上限 = 1.235s）的 **1.6 倍** ⇒ 让在飞的自然衰亡，
   * 而不是尖锥一回收就硬切（硬切会让火星凭空消失）。
   */
  particleIdleSeconds: 2.0,

  // ---- v3.26：表面着色参数**已整体退场** ----
  //
  // 用户 2026-11-21：「现在的圆锥体的带有纹路的尖刺模型不要了，换成焰魔宝剑刺出地面的样子」。
  // 剑体几何（`spike-blade-geometry.js`）从产物抽剑身两盒，**UV 天然对齐**且六面实测
  // 100% 不透明 ⇒ 材质侧原色直采（`createSpikeBladeMaterial`），本表不再持有
  // textureRect / wrapTiles / riseTiles / charcoalRamp / charcoalWindow / charcoalGain / opacity。
  // v3.24 之所以要「亮度 → 炭火色阶」，是因为锥面 UV 是环绕 0..1、只能取剑纹一条带再铺贴。

  /** 总增益。⚠️ 暖色 additive 的增益必须按像素标定，不得照抄冷色（v3.21 实测） */
  gain: 1.0,

  // ---- 配色（引 Cinder 火焰色阶，不另写一套橙）----
  colorSparkA: CF.colorSparkA,
  colorSparkB: CF.colorSparkB,
  colorSparkC: CF.colorSparkC,
  colorSparkD: CF.colorSparkD,
  colorEmberA: CF.colorEmberA,
  colorEmberB: CF.colorEmberB,
  colorEmberC: CF.colorEmberC,
  colorEmberD: CF.colorEmberD,
});

/**
 * 单根刺自**破土**起的**累计**粒子配额（颗）。**唯一权威**：渲染器逐帧取差值发射。
 *
 * 三段：
 *   · `lived < 0`：还没破土 ⇒ 0（延迟期内不得先冒火）
 *   · `lived < riseMs`：猛迸段，速率 `burstRate`
 *   · `riseMs ≤ lived < lifeMs × shrinkFrom`：渐稀段，速率 `trickleRate`
 *   · 之后：**不再增长**（刺开始缩回，火星跟着停）
 *
 * ⚠️ **返回累计量而不是「本帧颗数」**：渲染器用 `quota(now) − emitted` 求差值。
 * 写成 `ceil(rate × dt)` 逐帧累加会在低速率下因取整而永不发射或恒发射
 * （Storm Lance 的 `RateAcc` 就是为此存在），而累计差值天然免疫帧长抖动与掉帧。
 *
 * @param {number} livedMs 自该根**破土**（age − delay）起的毫秒数
 * @param {'spark'|'ember'} kind
 * @param {object} [cfg]
 * @returns {number} 累计颗数（整数，单调不减）
 */
export function spikeSparkQuotaAt(livedMs, kind, cfg = SPIKE_SPARK_FX) {
  const burst = kind === 'ember' ? cfg.emberBurstRate : cfg.burstRate;
  const trickle = kind === 'ember' ? cfg.emberTrickleRate : cfg.trickleRate;
  const stopAt = cfg.lifeMs * cfg.shrinkFrom;
  const t = Math.max(0, livedMs);
  const inBurst = Math.min(t, cfg.riseMs);
  const inTrickle = Math.max(0, Math.min(t, stopAt) - cfg.riseMs);
  return Math.round((inBurst * burst + inTrickle * trickle) / 1000);
}

/**
 * 一批粒子的出生数据（**纯函数，rand 注入 ⇒ 可复现**）。
 *
 * 出生点落在**破土环**上（半径 `radius × ringSpread` 内**面积均匀**采样），
 * 高度 = 地面 + `climb × progress × height` + 抖动 ⇒ 跟着那一根的升起进度上爬。
 * 初速 = 径向外 + 向上（`upBias` 决定两者配比），读作「土被顶开时迸出来」。
 *
 * ⚠️ **不含世界地面查找**：`spike.y` 由调用方（装配层 `_findSigilGroundY`）给，
 * 渲染层不查体素（与 `flame-sigil.js` / `spike-fx.js` / `fire-ring-config.js` 同口径）。
 *
 * @param {{x:number, y:number, z:number}} spike 该根刺的落点（y = 地面顶面）
 * @param {number} progress 该根的升起进度 0..1（= `spikeScaleAt` 的 scale）
 * @param {'spark'|'ember'} kind
 * @param {number} count 颗数（≤0 返回空数组）
 * @param {() => number} rand [0,1) 均匀随机
 * @param {object} [cfg]
 * @returns {Array<{pos:number[], vel:number[], life:number, size:number}>}
 */
export function spikeSparkSeeds(spike, progress, kind, count, rand, cfg = SPIKE_SPARK_FX) {
  const n = Math.max(0, Math.floor(count));
  const out = [];
  if (n === 0) return out;
  const ember = kind === 'ember';
  const speed0 = ember ? cfg.emberSpeed : cfg.sparkSpeed;
  const upBias = ember ? cfg.emberUpBias : cfg.sparkUpBias;
  const life0 = ember ? cfg.emberLifetime : cfg.sparkLifetime;
  const size0 = ember ? cfg.emberSize : cfg.sparkSize;
  const p = Math.max(0, Math.min(1, progress));
  const ringR = cfg.radius * cfg.ringSpread;
  const baseY = spike.y + cfg.climb * p * cfg.height;
  for (let i = 0; i < n; i++) {
    const ang = rand() * Math.PI * 2;
    // sqrt ⇒ 面积均匀（直接用 rand 当半径会挤在圆心 = 定点星爆）
    const r = ringR * Math.sqrt(rand());
    const dx = Math.cos(ang);
    const dz = Math.sin(ang);
    const speed = speed0 * (0.6 + rand() * 0.8);
    // 水平朝外 × (1−upBias)，竖直朝上 × upBias（两者都是正 ⇒ 迸出去而不是吸进来）
    const horiz = speed * (1 - upBias) * (0.6 + rand() * 0.8);
    const vert = speed * upBias * (0.65 + rand() * 0.7);
    out.push({
      pos: [
        spike.x + dx * r,
        baseY + rand() * cfg.birthJitter,
        spike.z + dz * r,
      ],
      vel: [dx * horiz, vert, dz * horiz],
      life: life0 * (0.7 + rand() * 0.6),
      size: size0 * (0.6 + rand() * 0.8),
    });
  }
  return out;
}
