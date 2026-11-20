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
   * **推导，不是拍的**：一次 spawn = 5 根 × (火星 55 + 余烬 18) = **365 颗**；
   * 同一只焰魔两刀的最小间隔 = `secondHitFrame − hitFrameSeconds` = **1.225s**，
   * 而一次 spawn 的粒子最长命 = 最大延迟 200ms + 缩回起点 630ms + 余烬 0.95×1.3s
   * ≈ **2.07s** > 1.225s ⇒ **两批会重叠**。
   * 单类最坏并发 = 55 × 5 × 2 = **550 颗** ⇒ 取 **768**（≈1.4 倍余量，
   * 两只焰魔同时出招时靠环形缓冲覆盖最旧 —— 纯视觉无副作用）。
   * 关系式由 `test-spike-sparks.js` 钉住（改颗数/寿命会红）。
   */
  capacity: 768,

  // ---- 三段速率（颗/秒）----
  /**
   * 破土段速率（`lived < riseMs`）—— **猛迸**。
   *
   * ⚠️ **240 是像素实测标定的，不是拍的**：首版 150 在真实交战距离（4 格）
   * 只得到 **7~193** 个暖色像素（每颗只 2.3px）—— 读不出「蹦出的火星」。
   * 同机位单变量扇描（密度×尺寸）：
   *   基线 150/0.055 ⇒ 193；尺寸×1.8 ⇒ 425；**密度×1.6 + 尺寸×1.8 ⇒ 884**；
   *   ×2.2/×2.2 ⇒ 1655（开始糊成一片，且近白像素仍 76 不变）。
   * 取 ×1.6：火星可数、不糊成难。
   */
  burstRate: 240,
  /**
   * 保持段速率（`riseMs ≤ lived < lifeMs × shrinkFrom`）—— **渐稀**。
   * 450ms × 26 ≈ 12 颗/根。⚠️ 不得为 0（用户裁定「渐稀」不是「归零」），
   * 也不得接近 burstRate（那读作匀速冒烟，猛迸感消失）。
   */
  trickleRate: 26,
  /** 余烬的两段速率（同形，量级更小 —— 用户要「少量」） */
  emberBurstRate: 77,
  emberTrickleRate: 10,

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

  // ---- v3.24：锥面剑纹（用户 2026-11-20）----
  //
  // 「我想给从地表升起的尖刺的锥体表面挂上一些纹理，纹理的颜色图案类比焰魔的剑的图案
  //   贴图，可以随机一些，不要是单纯的没有纹理的锥体。」
  //
  // 纹理**直接复用已加载的 `assets/ignis/ignis.png`**（零新增贴图、零烘焙）：
  // 只把 UV 重映射到「剑身核心的长侧嵌纹带」——那 7 行是焰魔贴图里**唯一 100% 不透明**
  // 的剑身 UV 矩形（列 90..170 / 行 128..134，实测不透明率 100.0%）。
  // 其余剑身 UV 都有透明镂空（剑身平面 61.7%、侧面 17.7%）⇒ 采到那里会出黑洞。
  //
  // ⚠️ **`ignis.png` 是 `TextureLoader` 加载的（flipY=true）**：图片行号 y 越大 ⇒ v 越小。
  // 换贴图时必须重算这两个 v（`test-spike-fx.js` 用同一份 PNG 内容级钉住）。
  /** 剑身嵌纹带在 ignis.png 里的像素矩形 `[x0, y0, w, h]`（256×256） */
  textureRect: Object.freeze([90, 128, 82, 7]),
  /**
   * 锥面环绕方向重复份数区间 `[min, max)`。**逐根随机**（用户要「可以随机一些」）。
   *
   * ⚠️ 用户 2026-11-20 第二轮的反馈是**「锥体太花了，纹理有点乱」** ⇒ 从 `[2,5)` 降到 `[1,3)`。
   * 剑纹带本身是 82×7 的碎嵌纹，铺 2~4 圈后每块纹样在锥面上只有十几像素 ⇒ 读作噪点。
   * 取 1~2 圈，纹样块变大，才看得出是「纹理」而不是「花斑」。
   */
  wrapTiles: Object.freeze([1, 3]),
  /** 沿母线（纵向）重复份数区间 —— 同理由，太密会糊成噪点 */
  riseTiles: Object.freeze([1, 3]),
  // ---- 表面着色：**烧炭**（正常混合，不是 additive）----
  //
  // 用户 2026-11-20 第二轮原话：「这个锥体要是一个被炭烧了的物体，烧炭你见过吗，
  // 有黑色的暗区，但整体是红色的烧着的纹理……让纹理里的暗条纹也变亮一些，
  // 整体呈现出一种刚从火中拿出的烧炭的感觉」。
  //
  // ⚠️⚠️ **不能再用「贴图原色 × 基色」**（v3.24 首版的写法）：贴图的暗紫底 `#512930`
  // 乘完基色后是**接近黑的暗紫**，读作「脏」而不是「高温的炭」。烧炭的暗区是**发光的暗红**。
  // ⇒ 改为把纹理**亮度**重映射到一条炭火色阶上（`charcoalRamp`），色相由色阶决定，
  // 贴图只贡献「哪里暗、哪里亮」这一层信息。
  //
  // 放弃 additive 的理由见 git 历史（additive 在亮天空前必然钳白，金色纹样出不来）；
  // 现在色相由色阶给定，**不再依赖背景**，所以正常混合下暗红也能压得住。
  /**
   * 炭火色阶（温度从低到高）。纹理亮度 t 在 `charcoalRamp` 上取色：
   *   t=0（最暗的纹路）→ 暗红（**不是黑**：烧着的炭暗区也在发光）
   *   t=1（金纹）→ 白热的橙黄
   * ⚠️ 三个停靠点顺序 = 温度顺序，改顺序会让「暗处比亮处更亮」而结构判据全绿。
   */
  charcoalRamp: Object.freeze([
    Object.freeze([0.55, 0.06, 0.02]),   // 暗红：炭的暗区（仍发光）
    Object.freeze([1.05, 0.26, 0.04]),   // 橙红：主体
    Object.freeze([1.55, 0.72, 0.22]),   // 白热：金色纹路
  ]),
  /**
   * 纹理亮度 → 色阶位置的**重映射窗口**。
   *
   * ⚠️⚠️ **下沿必须压在纹理暗部之上**：剑纹带的暗紫底线性亮度约 **0.21**，
   * 若窗口从 0 起（`[0, 0.9]`）会把暗底映射到色阶最左端 ⇒ 整锥偏红但**看不出纹理**。
   * 从 0.10 起 + 上沿 0.85 ⇒ 暗底落在色阶 ~0.15（暗红），金纹落在 ~1.0（白热），
   * 这才读作「烧炭表面的纹理」。改它等价于改「暗条纹被压住多少」。
   */
  charcoalWindow: Object.freeze([0.10, 0.85]),
  /**
   * 整体亮度倍率。⚠️ 用户两轮都说「不够亮」⇒ 1.35（而不是 1.0）。
   * 它是**单一旋钮**：觉得暗就调它，色阶的相对关系不变。
   */
  charcoalGain: 1.35,
  /**
   * 不透明度。取 1.0：烧炭是实体，透出背景会让它读作「红色玻璃」而不是「烧着的石头」。
   * 通透感由 `depthWrite=false` + 正常混合保留（仍走 transparent 队列）。
   */
  opacity: 1.0,

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
/**
 * 纹理矩形 `[x0, y0, w, h]`（图片像素，**左上原点**）→ UV 矩形 `[u0, v0, u1, v1]`。
 *
 * ⚠️⚠️ **`flipY` 必须显式折算**：`ignis.png` 走 `TextureLoader`（默认 `flipY = true`），
 * v=0 对应图片**底边**。直接 `v = y / size` 会把纹样上下颠倒 ——
 * 而「锥面有纹理」这个事实仍然成立，所有结构判据全绿（`zombie-model.js` 记过同一类坑）。
 * 本函数是**唯一的换算入口**，几何侧只拿返回值，不自己再算一次。
 *
 * @param {readonly number[]} rect `[x0, y0, w, h]` 图片像素
 * @param {number} size 贴图边长（`ignis.png` = 256）
 * @returns {{u0:number, v0:number, u1:number, v1:number}} `v0 < v1`
 */
export function spikeTexUvRect(rect, size) {
  const [x0, y0, w, h] = rect;
  const u0 = x0 / size;
  const u1 = (x0 + w) / size;
  // 图片行号 → v：flipY ⇒ 行号大的一端 v 小
  const vTop = 1 - y0 / size;             // 带子上沿（图片 y 小）⇒ v 大
  const vBot = 1 - (y0 + h) / size;       // 带子下沿 ⇒ v 小
  return { u0, v0: vBot, u1, v1: vTop };
}

/**
 * 单根尖刺的**纹理铺贴参数**（逐根随机 ⇒ 「可以随机一些」）。
 *
 * 纯函数、`rand` 注入 ⇒ Tier 1 可复现断言。渲染器把结果写进逐实例属性，
 * shader 侧只做算术（不得在 TSL 里再抽一次随机 —— 那是第二个权威）。
 *
 * @param {() => number} rand [0,1) 均匀随机
 * @param {object} [cfg]
 * @returns {{tiles:number, reps:number, phase:number, mirror:number}}
 *   `tiles` 环绕份数（整数）、`reps` 纵向份数（整数）、`phase` u 相位 0..1、
 *   `mirror` 0 或 1（1 = 纹样左右镜像 ⇒ 同一条带能出两种读法）
 */
export function spikeTexPattern(rand, cfg = SPIKE_SPARK_FX) {
  const pick = ([lo, hi]) => lo + Math.floor(rand() * Math.max(1, hi - lo));
  return {
    tiles: pick(cfg.wrapTiles),
    reps: pick(cfg.riseTiles),
    phase: rand(),
    mirror: rand() < 0.5 ? 0 : 1,
  };
}
