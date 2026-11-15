// src/render/block-hit-fx.js — 枪击方块命中特效（白闪 / 碎块）
//
// **为什么不用 mc-lite 的 `pick.png` / `block_crash.png`**：那两张是**与方块无关**的通用
// 序列帧（烟花状爆点 / 灰渣），打石头和打草长得一模一样 —— 与「方块本身在碎」无关。
// 本实现的碎块颜色取自该方块**命中那一面**在 atlas 里的平均色（`block-color.js`），
// 判据因此在观感上是「这堵墙的这块石头被打碎了」，而不是「这里播了一个碎屑动画」。
//
// 两层（用户 2026-10-23 二次拍板后收敛到两层）：
//   ① 白闪   — 命中格画一个整格白立方，纯白保持片刻后淡出（「方块变白闪一下，然后消失」）
//   ② 碎块   — InstancedMesh 实心小立方碎片，初速 + 重力 + 自旋，末段缩零（手枪/加特林）
//
// ⚠️ **MAG7 的白闪是「波浪」而不是单格**（用户 2026-10-23 第二轮）：「所有伴随着消失的
// 方块都做白闪后消失……用 600ms 的时间依次让应该消失的方块白闪后消失，模拟一个有扩散
// 过程的击中效果」。事件里的 `stagger` 列表带着全部被毁格（由命中点向外排序），
// `staggerTimes()` 把它们在 `whiteFlash.staggerMs` 内均匀摊开。
// 该时长后被实玩反馈下调为 150ms（600ms「太慢」）。
// ⚠️ **世界仍然立即原子删除**（用户拍板）：波浪只是视觉错开，不是延后删除 ——
// 那样会让方块在那 600ms 内仍可站/可挡子弹，且需新增定时器队列与取消路径。
//
// ⚠️ **三层已删除，不要再加回来**（用户 2026-10-23 实玩反馈）：
//   · 球形闪光（径向渐变 Sprite）—— 用户原话「不要用一个球形闪光球了，直接让被击中的
//     方块变成白色闪一下」。白闪取代它。
//   · 面闪灭（贴命中面真实 tile、亮灭两轮）—— 与白闪是同一件事的两种表达，并存只会
//     「两套闪」互相打架；白闪取代它。
//   · MAG7 的冲击波环 / 碎块 —— 用户原话「散弹枪 MAG7 的击碎效果不好，把碎片散落效果
//     和光晕扩散效果给去掉」。MAG7 现在与手枪同一套命中反馈，差异只剩玩法上的 3×3 范围破坏。
//
// ⚠️ 「枪械破坏」关闭时**仍出白闪**、不出碎块（改发少量粉尘）—— 默认设置下也要能看出
// 「打中了」，而碎屑四溅会误导成「方块碎了」。白闪盖在未删除的方块上会淡出复原，不误导。
//
// ⚠️ **碎块池兼宿主实体死亡爆散（v2.64）**：丧尸被击杀时走 `spawnDeathBurst()` ——
// 同一个 InstancedMesh 池、同一套抛物线/自旋/缩零曲线，**不开第二个池**（红线自检：
// 不绕过统一管线新开子系统）。与枪击碎块唯一的实质差别是**方向分布**：枪击以命中面法线
// 为轴取半球（碎块永远朝被打的那一面外飞），死亡爆散没有「命中面」⇒ 取**全球面**
// （上下两个半球各撒一半，读作「身体整体炸开」）。白闪层不参与死亡爆散 ——
// 白闪的语义是「这块方块变白了」，用在实体身上会误导成「方块碎了」。
//
// ⚠️ 三条池化硬约束（与 tracer-renderer / explosion-renderer 同口径，M6 实测教训）：
//   · 空闲 slot 必须 `visible=false`，否则每帧恒增 draw call 且进透明排序列表
//   · 每帧零分配：所有临时矩阵/四元数/向量都是模块级常量
//   · 时间基准 `performance.now()`，禁止 `Date.now()`（两者差约 17 亿毫秒 → 特效首帧即消失）
//
// ⚠️ **两层都不走加法混合**：
//   · 碎块是不透明的实体小方块，加法混合会让白色石头在亮背景上消失、且互相叠加成过曝；
//   · 白闪在命中格内，而该格此时**往往已是空气洞**（方块被删）→ 加法混合直接叠到天空上
//     会**烧成白团**（MAG7 时代的实测结论）。白闪走 NormalBlending，读作「方块变白了」。
import * as THREE from 'three';

/** 全局节奏与容量（武器之间的差异在 `IMPACT_PROFILES`）—— 递归冻结，渲染层不得改写 */
export const IMPACT_FX = freezeDeep({
  debris: {
    lifeMs: 620,      // 碎块存活：抛物线落到地面以下即可（重力给定，见 DEBRIS_GRAVITY）
    shrinkFrom: 0.78, // 寿命进度到此开始缩零（前 78% 保持原尺寸）
    maxActive: 128,   // 碎块实例池上限
  },
  whiteFlash: {
    holdMs: 55,       // 纯白保持段（这一段读作「这块方块变成白色了」）
    totalMs: 150,     // 之后淡出；须远短于碎块寿命，否则白板会盖住碎块飞散的全过程
    // 用户 2026-10-23：先要求「用 600ms 的时间依次让应该消失的方块白闪后消失，模拟一个扩散
    // 过程」，实玩后反馈「太慢，改为 150ms」。MAG7 把它的全部被毁格在这段时长内依次亮起
    // （Pistol/Minigun 单格 → 这个值不起作用）。
    // ⚠️ 150ms 与单格白闪寿命（totalMs）**同量级**：40 格摊开后每格仅隔 ~3.8ms（120Hz
    // 下约 2 格/帧）—— 观感是「一大片同时变白、但边缘略有先后」，而不是慢慢铺。这是用户
    // 要的节奏；若将来要更慢，改这个值即可（波浪逻辑与测试都按它派生，不需动代码）。
    staggerMs: 150,
    // 池容量须装得下**一次 MAG7 的全部格**（扫描上限 40）：装不下时尾部格子会回退到
    // `_flashSlots[0]`，把第一格提前杀掉 —— 观感是「扩散到一半就没了」（静默）。
    maxActive: 48,
  },
  heat: {
    decayMs: 1500,   // 加特林停火后 1.5s 热度归零
    maxDebrisBonus: 4, // 满热度时碎块额外 +4
  },
});

/** 碎块重力（世界单位/秒²）。比真实重力轻，碎块才有「悬停一下再落」的观感。 */
const DEBRIS_GRAVITY = 18;
/** 碎块总数按热度增加时的上限（避免实例池被单发吃满） */
const MAX_DEBRIS_PER_IMPACT = 12;
/**
 * 白闪立方体的边长（方块 = 1）。
 * 必须略大于 1：破坏关闭时方块还在，≤1 会让白立方与方块表面共面 → z-fighting 花屏；
 * 略大出的那 0.01 落在邻格的实心方块内部，被不透明通道的深度挡掉，不会穿帮。
 */
const WHITE_FLASH_SIZE = 1.02;

/**
 * 每把枪的命中表现。
 * `debrisCount` = 一次命中出多少碎块（MAG7 为 0：只有白闪）；`size` = 碎块边长（方块 = 1）；
 * `speed` = 初速区间（世界单位/秒）；`spin` = 自旋角速度区间（弧度/秒）。
 */
export const IMPACT_PROFILES = freezeDeep({
  pistol: {
    // ⚠️ `size` 是**边长**（方块 = 1），实测 0.11 在 6 格外近乎看不见 → 取方块的 1/6~1/4
    debrisCount: 9, size: [0.15, 0.26], speed: [2.5, 4.6], spin: [6, 14],
    heat: false,
    dustCount: 4,   // 破坏关闭时的粉尘碎块数
  },
  minigun: {
    debrisCount: 9, size: [0.13, 0.22], speed: [2.6, 4.8], spin: [8, 18],
    heat: true,
    dustCount: 4,
  },
  mag7: {
    // 用户 2026-10-23：「散弹枪 MAG7 的击碎效果不好，把碎片散落效果和光晕扩散效果给去掉」。
    // 故 debrisCount/dustCount 都归零 —— MAG7 的命中反馈**只有白闪**，与手枪同一套表现。
    // ⚠️ size/speed/spin 一并删掉：留着就是死字段，改它们不会有任何可见变化。
    debrisCount: 0, dustCount: 0, heat: false,
  },
});

export function freezeDeep(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * 宿主实体死亡爆散（v2.64，用户 2026-11-07：「加一个丧尸死亡消失的特效」，裁定形态 =
 * 绿色碎块爆散；v2.64b 用户追问「焰魔的死亡特效你实现了吗」→ 补焰魔的火焰色爆散）。
 *
 * 字段语义与 `IMPACT_PROFILES` 的碎块项一致（`size` 边长 / `speed` 初速区间 / `spin` 自旋
 * 角速度区间），故能直接喂给 `createDebrisSeeds`（不写第二套抽样数学 —— 红线 1）。
 *
 * ⚠️ **寿命沿用 `IMPACT_FX.debris.lifeMs`**（不另设一个）：`debrisSizeAt` / `debrisOffset`
 * 都从那个常量读寿命，另设一份会让「缩零时刻」与「回收时刻」分家（形态：碎块缩到 0 后
 * 仍占着 slot 直到另一个时刻才回收）。
 *
 * ⚠️ **`count` 必须 ≤ `IMPACT_FX.debris.maxActive`**（单测钉住）：一次爆散就超池容量时，
 * 后面的碎块会覆盖前面**同一发**的（FIFO 绕回），观感是「只炸出半边」。
 */
export const DEATH_BURST = freezeDeep({
  count: 20,             // 一次死亡出多少块（丧尸体型 0.6×1.8×0.6，20 块读作「整个人炸开」）
  size: [0.16, 0.28],    // 边长（方块=1）：与手枪碎块同量级，6 格外仍肉眼可见
  speed: [2.2, 4.8],     // 初速区间（世界单位/秒）
  spin: [6, 14],         // 自旋角速度区间（弧度/秒）
});

/**
 * 焰魔死亡爆散（v2.64b）。与丧尸同一套池与曲线，差别只在**体型与颜色**：
 * 焰魔 1×3.25×1（丧尸的近 2 倍高）⇒ 块数更多、块更大、炸得更开；颜色 = 火焰橙
 * （与丧尸的「皮肤绿」同位点 —— 颜色由调用方给，见 `Game._onEntityDeath`）。
 */
export const IGNIS_DEATH_BURST = freezeDeep({
  count: 32,             // 体型更大 → 更多块（32 < 池容量 128，一次爆散不会自己覆盖自己）
  size: [0.2, 0.34],     // 边长略大于丧尸（读作「更大的身体碎成更大的块」）
  speed: [2.6, 5.6],     // 初速略快（Boss 死亡应当比杂兵更有爆发力）
  spin: [6, 16],
});

/**
 * 焰魔砸击碎石圆环（v3.04）—— 原版 `ShieldSmashparticle`
 * （`Ignis_Entity.java:1665-1690`）的本仓标定口径。
 *
 * ## 形状：**前方环心 + 整圆**（不是「脚下弧形」）
 *
 * 原版：`angle = yBodyRot·(π/180) + i1`（**`i1` 直接当弧度**，80~92 个粒子绕约 12.7 圈）、
 * `extraX = radius·sin(π+angle)`、`extraZ = radius·cos(angle)`，落点再加
 * `vec·vecX`（正前方前移）与 `f·math`（侧向偏移）⇒ **环心在身体前方 `vec` 处**。
 *
 * ⚠️ 本仓只取形状语义，**不照抄那 80~92 粒**：原版密度会吃掉碎块池 128 的 62~72%，
 * 与枪击碎块 / 焰魔死亡爆散并发时 FIFO 绕回互相覆盖（观感「只炸出半边」，
 * `DEATH_BURST` 注释记过同一个坑）。取 **28 块**（≈原版 1/3），
 * 28 + 焰魔死亡爆散 32 = 60 < 128，安全区。
 *
 * ⚠️ **radius 已从原版 1.3 翻倍到 2.6**（用户 2026-11-15 实玩后裁定：「碎石圆环的面积也
 * 有点太小了，把碎石圆环的面积扩大一倍」）⇒ 直径 2.6 → **5.2 格**。
 * 取**半径翻倍**而不是字面面积×2（那使半径只×√2≈1.84、直径 3.68 格，观感变化很小）。
 * 连带效果：环最近点到脚底 `2.75 − 2.6 = 0.15` 格（几乎贴脚）、最远 `5.35` 格
 * ⇒ 玩家对打时碎石就在眼前，与法阵首段落到脚底的裁定同向。
 *
 * ⚠️ **初速比枪击碎块低**：原版三轴各 `nextGaussian() × 0.07` 是「原地溅起」，
 * 不是「四散飞射」。v3.04b 取 `[1.2, 2.6]`（枪击是 `[2.5, 4.6]`）。
 *
 * ## v3.04c：用户实玩后要求「更厉害」（2026-11-15）
 *
 * 用户原话：「碎石的方块有点过于小，震动起来的幅度也不高，感觉不厉害，就好像一圈
 * 小石子蹦起来一样，每次动画方块数量增加50%，方块大小增加两倍。方块跳起的高度增加两倍。」
 *
 * 三项落地：
 *   · `count` 28 → **42**（+50%）；池容量核对 42 + 死亡爆散 32 = 74 ≤ 128 ✓
 *   · `size` `[0.14,0.24]` → **`[0.28,0.48]`**（边长 ×2）
 *   · `speed` `[1.2,2.6]` → **`[1.697,3.677]`**（×√2）
 *
 * ⚠️⚠️ **为什么高度×2 是 speed ×√2 而不是 ×2**：`debrisOffset` 的竖直项是
 * `vy·t − ½·g·t²`，峰高 **`h = vy²/(2g)`** ⇒ h 与 vy 是**平方**关系。
 * 直接 speed ×2 会让高度变 **4 倍**（超出用户要求的两倍）。
 * `DEBRIS_GRAVITY = 18` 与枪击/死亡爆散**共享**，不得为本招改它（否则枪击手感一起变）。
 * 实测：峰高 0.18778 → **0.37556 格**（恰 2.0000×）；到峰时刻 0.204s < 缩零起点 0.484s ✓
 */
export const IGNIS_SMASH_DEBRIS = freezeDeep({
  count: 42,             // v3.04c：28 的 +50%（用户裁定）；42 + 32 = 74 ≤ 池 128
  radius: 2.6,           // 原版 1.3 翻倍（用户 v3.04b，见上）
  forward: 2.75,         // 原版 `vec=2.75`：环心前移量（`Ignis_Entity.java:889`）
  lateral: -0.1,         // 原版 `math=-0.1`：环心侧向偏移
  lift: 0.3,             // 原版 `extraY = 0.3`：碎块相对脚底的抬高
  size: [0.28, 0.48],    // v3.04c：边长 ×2（用户「方块大小增加两倍」）
  speed: [1.6970562748477143, 3.6769552621700474],   // v3.04c：×√2 ⇒ 峰高恰 ×2（h ∝ vy²）
  spin: [4, 10],
});

/**
 * 死亡爆散配置 → `createDebrisSeeds` 的 profile 形状（与 `IMPACT_PROFILES` 的碎块项一致）。
 * ⚠️ 逐字段派生而不是共享引用：`createDebrisSeeds` 只读这四个字段，形状对齐即可。
 */
function deathBurstProfile(cfg) {
  return Object.freeze({
    debrisCount: cfg.count,
    size: cfg.size,
    speed: cfg.speed,
    spin: cfg.spin,
  });
}

/**
 * 一簇死亡爆散碎块的随机种子（纯函数，`rand` 注入 → 可复现）。
 *
 * **全球面 = 上/下两个半球各撒一半**：`createDebrisSeeds` 的抽样是「以法线为轴的半球」，
 * 调两次（法线 +Y 与 −Y）拼出全球面。不自己写球面抽样数学 —— 那会是第二份权威，
 * 且两套抽样的分布差异肉眼看不出来（正是「对照脚本与被测代码共用同一个错误假设」的温床）。
 *
 * @param {() => number} rand [0,1) 均匀随机
 * @param {number} [count] 覆盖 `cfg.count`
 * @param {object} [cfg] 爆散配置（`DEATH_BURST` / `IGNIS_DEATH_BURST`），缺省丧尸口径
 * @returns {Array<{velocity:number[], spinRate:number, spinAxis:number[], size:number, tone:number}>}
 */
export function createDeathBurstSeeds(rand, count, cfg = DEATH_BURST) {
  const n = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : cfg.count;
  const up = Math.ceil(n / 2);
  const down = n - up;
  const profile = deathBurstProfile(cfg);
  const seeds = up > 0 ? createDebrisSeeds(profile, [0, 1, 0], rand, up) : [];
  if (down > 0) seeds.push(...createDebrisSeeds(profile, [0, -1, 0], rand, down));
  return seeds;
}

/**
 * 碎石圆环的**环心**（世界坐标，y = 脚底 y，不含 lift）。
 *
 * ⚠️ **环心公式只此一份**（红线 1）：`smashDebrisRing` 算落点用它，
 * `Game._consumeIgnisFxRequests` 取「环心脚下那一格」的颜色也用它。
 * 两处各写一遍就是第二份权威 ⇒ 碎石颜色会取自错误的格（观感：石地上炸出绿色碎块）。
 *
 * yaw 用**本仓口径**：正前方 = `(−sin yaw, −cos yaw)`
 * （同 `entities/bosses/dragon-boss-agent.js:127-128`）；侧向 = 正前方绕 Y 转 90°
 * = `(cos yaw, −sin yaw)`（yaw=0 时为 `(1,0,0)`，与原版 `f=cos(yBodyRot)` 同位）。
 *
 * @param {number[]} at 焰魔身体位置 `[x,y,z]`（脚底）
 * @param {number} yaw 本仓 yaw（弧度）
 * @param {object} [cfg] 缺省 `IGNIS_SMASH_DEBRIS`
 * @returns {number[]} `[x,y,z]`
 */
export function smashRingCenter(at, yaw, cfg = IGNIS_SMASH_DEBRIS) {
  const fx = -Math.sin(yaw);
  const fz = -Math.cos(yaw);
  const sx = Math.cos(yaw);
  const sz = -Math.sin(yaw);
  return [
    at[0] + fx * cfg.forward + sx * cfg.lateral,
    at[1],
    at[2] + fz * cfg.forward + sz * cfg.lateral,
  ];
}

/**
 * 碎石圆环的逐块落点与法线（纯函数）。
 *
 * 落点是**确定性几何**（原版 `angle = yBodyRot + i1`，无随机项）；
 * `i1` 当弧度用绕多圈 ⇒ 整圆上密度不均的采样，整体形状仍是圆环。
 * 随机性全部来自复用 `createDebrisSeeds` 的**速度/尺寸/自旋**抽样
 * （与原版 `nextGaussian()×0.07` 同位）。
 *
 * ⚠️ `rand` 保留在签名里但**本函数不消费它** —— 落点无随机项，
 * 传它只为与 `createDeathBurstSeeds(rand, count, cfg)` 的调用形状一致。
 * 想改变落点分布得改 `cfg`，不是换 rand。
 *
 * @param {number[]} at 焰魔身体位置（脚底）
 * @param {number} yaw 本仓 yaw
 * @param {object} [cfg]
 * @param {() => number} [_rand] 未消费（见上）
 * @returns {Array<{position:number[], normal:number[]}>}
 */
export function smashDebrisRing(at, yaw, cfg = IGNIS_SMASH_DEBRIS, _rand = Math.random) {
  const c = smashRingCenter(at, yaw, cfg);
  const points = [];
  for (let i = 0; i < cfg.count; i++) {
    const angle = yaw + i;   // 原版：i 直接当弧度
    points.push({
      position: [
        c[0] - cfg.radius * Math.sin(angle),
        at[1] + cfg.lift,
        c[2] + cfg.radius * Math.cos(angle),
      ],
      normal: [0, 1, 0],     // 向上溅起
    });
  }
  return points;
}

/**
 * 武器 id → 命中表现。徒手与未知 id 返回 null（调用方据此跳过特效）。
 * @param {string} weaponId @returns {object|null}
 */
export function impactProfile(weaponId) {
  return Object.prototype.hasOwnProperty.call(IMPACT_PROFILES, weaponId)
    ? IMPACT_PROFILES[weaponId]
    : null;
}

/**
 * 命中点世界坐标 = 块中心 + 法线 × 0.5（贴在命中面上，不落在方块内部）。
 * @param {number[]} blockPos @param {number[]|null} normal
 * @returns {number[]}
 */
export function impactPosition(blockPos, normal) {
  const nx = normal ? normal[0] : 0;
  const ny = normal ? normal[1] : 0;
  const nz = normal ? normal[2] : 0;
  return [blockPos[0] + 0.5 + nx * 0.5, blockPos[1] + 0.5 + ny * 0.5, blockPos[2] + 0.5 + nz * 0.5];
}

/**
 * 方块格中心的世界坐标（白闪的落点）。
 * ⚠️ 与 `impactPosition` 是**两个不同的锚点**，勿混用：白闪要盖住**整个格子**
 * （读作「这块方块变白了」），贴到命中面上会半个方块偏移、露出发白的半边。
 * @param {number[]} blockPos @returns {number[]}
 */
export function blockCenter(blockPos) {
  return [blockPos[0] + 0.5, blockPos[1] + 0.5, blockPos[2] + 0.5];
}

/**
 * 一次命中要发多少碎块：基础数量 + 热度加成（仅 `heat` 武器）。
 * @param {object} profile @param {number} heat 0..1（会被钳制）
 */
export function debrisCountFor(profile, heat) {
  const h = Math.min(Math.max(heat, 0), 1);
  if (!profile.heat) return profile.debrisCount;
  const count = profile.debrisCount + Math.round(h * IMPACT_FX.heat.maxDebrisBonus);
  return Math.min(count, MAX_DEBRIS_PER_IMPACT);
}

/**
 * 生成一簇碎块的随机种子（纯函数，`rand` 注入 → 可复现）。
 *
 * 方向：以命中面法线为轴取**半球**（法线分量恒为正）—— 碎块永远朝被打的那一面外飞，
 * 不会穿进方块内部（负向锚点见测试）。
 *
 * @param {object} profile
 * @param {number[]} normal 命中面法线（缺省按 +Y 处理）
 * @param {() => number} rand [0,1) 均匀随机
 * @param {number} [count] 覆盖 profile 的默认数量（热度 / 粉尘路径用）
 * @returns {Array<{velocity:number[], spinRate:number, spinAxis:number[], size:number,
 *                  tone:number}>}
 *    `tone` = 该碎块的亮度系数（0.75~1.0），让同一面的碎块有明暗差、不像复制粘贴。
 */
export function createDebrisSeeds(profile, normal, rand, count = profile.debrisCount) {
  const n = normalizeNormal(normal);
  // 法线基：任取一个与 n 不平行的向量做叉乘
  const helper = Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const t1 = normalizeNormal(cross(helper, n));
  const t2 = cross(n, t1);
  const seeds = [];
  for (let i = 0; i < count; i++) {
    // 半球均匀抽样：u 沿法线（含少量向内滑移，让碎块有「从裂缝里崩出来」的层次）
    const u = 0.35 + rand() * 0.65;
    const theta = rand() * Math.PI * 2;
    const radial = Math.sqrt(Math.max(0, 1 - u * u));
    const dx = n[0] * u + (t1[0] * Math.cos(theta) + t2[0] * Math.sin(theta)) * radial;
    const dy = n[1] * u + (t1[1] * Math.cos(theta) + t2[1] * Math.sin(theta)) * radial;
    const dz = n[2] * u + (t1[2] * Math.cos(theta) + t2[2] * Math.sin(theta)) * radial;
    const dirLen = Math.hypot(dx, dy, dz) || 1;
    const speed = profile.speed[0] + rand() * (profile.speed[1] - profile.speed[0]);
    const axisTheta = rand() * Math.PI * 2;
    const axisY = rand() * 2 - 1;
    const axisR = Math.sqrt(Math.max(0, 1 - axisY * axisY));
    seeds.push({
      velocity: [(dx / dirLen) * speed, (dy / dirLen) * speed, (dz / dirLen) * speed],
      spinRate: profile.spin[0] + rand() * (profile.spin[1] - profile.spin[0]),
      spinAxis: [Math.cos(axisTheta) * axisR, axisY, Math.sin(axisTheta) * axisR],
      size: profile.size[0] + rand() * (profile.size[1] - profile.size[0]),
      tone: 0.75 + rand() * 0.25,
    });
  }
  return seeds;
}

/**
 * 碎块在 `ageMs` 时刻相对命中点的位移（丢给渲染层的纯函数）:
 * `p = v·t + ½·g·t²`（竖直方向）。水平方向不衰减 —— 短寿命（0.62s）不需要阻力项。
 *
 * ⚠️ `out` 是**调用方提供的可复用数组**（每帧每碎块调一次，返回新数组会持续分配）。
 * 默认新建一个（单测/一次性消费方便），渲染器必须传自己的缓冲。
 * @param {{velocity:number[]}} seed @param {number} ageMs @param {number[]} [out] @returns {number[]}
 */
export function debrisOffset(seed, ageMs, out = [0, 0, 0]) {
  const t = ageMs / 1000;
  const v = seed.velocity;
  out[0] = v[0] * t;
  out[1] = v[1] * t - 0.5 * DEBRIS_GRAVITY * t * t;
  out[2] = v[2] * t;
  return out;
}

/**
 * 碎块边长：前 `shrinkFrom` 全程保持，之后线性缩到 0（缩零而非透明 —— 不透明网格没有
 * 排序问题，也不需要 per-instance opacity）。
 * @param {{size:number}} seed @param {number} ageMs
 */
export function debrisSizeAt(seed, ageMs) {
  const life = IMPACT_FX.debris.lifeMs;
  if (ageMs >= life) return 0;
  const p = ageMs / life;
  if (p <= IMPACT_FX.debris.shrinkFrom) return seed.size;
  const k = 1 - (p - IMPACT_FX.debris.shrinkFrom) / (1 - IMPACT_FX.debris.shrinkFrom);
  return seed.size * k;
}

/** 自旋角（弧度）：线性增长。`@param {{spinRate:number}} seed @param {number} ageMs` */
export function debrisSpinAngle(seed, ageMs) {
  return seed.spinRate * (ageMs / 1000);
}

/**
 * 多格白闪的启动时刻表（纯函数）：把 `count` 格在 `staggerMs` 内**均匀铺开**。
 *
 * 用户 2026-10-23：「每个方块消失过程中设定一个定时器，不要同一时刻消失，比如用 600ms
 * 的时间依次让应该消失的方块白闪后消失，模拟一个有扩散过程的击中效果」（该时长后调为 150ms）。
 *
 * 首格恒为 `nowMs`（命中瞬间就要有东西亮，否则打击感滞后）；末格落在 `nowMs + staggerMs`。
 * 边界：`count <= 1` 时不分摊（避免除以 `count-1 = 0`）、`staggerMs <= 0` 时退化为「全部同一时刻」。
 * @param {number} count @param {number} staggerMs @param {number} nowMs
 * @returns {number[]}
 */
export function staggerTimes(count, staggerMs, nowMs) {
  const times = new Array(count);
  if (count <= 0) return times;
  if (count === 1 || staggerMs <= 0) {
    for (let i = 0; i < count; i++) times[i] = nowMs;
    return times;
  }
  for (let i = 0; i < count; i++) times[i] = nowMs + (staggerMs * i) / (count - 1);
  return times;
}

/**
 * 白闪不透明度：`holdMs` 内恒为 1（「这块方块变成白色了」），之后线性淡出到 0。
 *
 * 不用二次曲线收尾：白闪的落点往往已是空气洞，淡出太快会读成「闪一下就没了」；
 * 线性淡出在 150ms 内读完两段（变白 → 复原/消失），与用户描述的节奏一致。
 * ⚠️ 返回值是**复用对象**（每帧每个 slot 调一次）：调用方须立即消费，不得保留引用。
 * @param {number} ageMs @param {{opacity:number, done:boolean}} [out]
 * @returns {{opacity:number, done:boolean}}
 */
export function whiteFlashOpacityAt(ageMs, out = { opacity: 0, done: false }) {
  const { holdMs, totalMs } = IMPACT_FX.whiteFlash;
  if (ageMs >= totalMs) { out.opacity = 0; out.done = true; return out; }
  if (ageMs <= holdMs) { out.opacity = 1; out.done = false; return out; }
  out.opacity = 1 - (ageMs - holdMs) / (totalMs - holdMs);
  out.done = false;
  return out;
}

/**
 * 加特林热度的线性衰减：`heat · (1 − elapsedMs/decayMs)`（到 0 即归零）。
 * @param {number} heat 当前热度 @param {number} elapsedMs 距上次命中
 */
export function heatDecay(heat, elapsedMs) {
  if (elapsedMs >= IMPACT_FX.heat.decayMs) return 0;
  return heat * (1 - elapsedMs / IMPACT_FX.heat.decayMs);
}

// 内部工具 ----

/**
 * 一个 impact 的波浪总时长：事件自带 `staggerMs` 时用它，否则退回全局配置。
 * 单一权威在 `IMPACT_FX.whiteFlash.staggerMs`（控制器不得另写一份字面量作为默认）。
 */
function waveStaggerMs(impact) {
  return typeof impact?.staggerMs === 'number'
    ? impact.staggerMs
    : IMPACT_FX.whiteFlash.staggerMs;
}

function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function normalizeNormal(n) {
  if (!n) return [0, 1, 0];
  const len = Math.hypot(n[0], n[1], n[2]);
  if (len === 0) return [0, 1, 0];
  return [n[0] / len, n[1] / len, n[2] / len];
}

// ============================================================================
// 渲染器
// ============================================================================

/**
 * 共享的单位立方体几何：碎块按实例 scale 缩到 `size`，白闪按 mesh scale 缩到
 * `WHITE_FLASH_SIZE`。一份几何两处用 —— 两条池都是方块形状（红线 1：形状只有一份权威）。
 */
const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);

/** 逐帧复用的临时对象（禁止在 update 里 new） */
const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _v3a = new THREE.Vector3();
const _scale3 = new THREE.Vector3();
const _axis3 = new THREE.Vector3();
const _color = new THREE.Color();
const _zeroMatrix = new THREE.Matrix4().makeScale(0, 0, 0);

/** 白闪包络的复用输出对象（避免每帧每 slot 分配小对象） */
const _flashOut = { opacity: 0, done: false };

/**
 * 枪击方块命中特效渲染器。
 *
 * 两个池（都固定容量、空闲不可见 → draw call 回到基线，见文件头 ⚠️）：
 *   · `_debrisMesh`  —— 一个 InstancedMesh，实例色 = 该方块命中面的平均色 × 亮度系数
 *   · `_flashSlots`  —— 每 slot 一个独立 Mesh（白立方）。**必须独立材质**：opacity 是
 *                       材质级参数，InstancedMesh 的逐实例只有颜色没有不透明度。
 */
export class BlockHitFxRenderer {
  /**
   * @param {{scene: import('three').Scene,
   *          colorResolver?: ((blockName: string, normal: number[]|null) => number[]) | null,
   *          blockNameOf?: ((id: number) => string) | null}} deps
   *   `colorResolver` / `blockNameOf` 由 Game 注入。缺任一项时碎块退化成中性灰，
   *   不阻断玩法 —— 与丧尸头部纹理、爆炸图集的容错口径一致。
   */
  constructor({ scene, colorResolver = null, blockNameOf = null }) {
    this.scene = scene;
    this.colorResolver = colorResolver;
    this.blockNameOf = blockNameOf;

    // ---- 碎块：一个 InstancedMesh 承载全部活跃碎块 ----
    this._debrisMesh = new THREE.InstancedMesh(
      UNIT_BOX,
      // 不透明实体小方块：NormalBlending（加法混合会让石头在亮背景上消失并互相过曝）
      new THREE.MeshBasicMaterial({ toneMapped: false }),
      IMPACT_FX.debris.maxActive,
    );
    this._debrisMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this._debrisMesh.frustumCulled = false;   // 实例包围球按零 scale 算会被误剔除
    this._debrisMesh.visible = false;
    this._debrisMesh.name = 'block-hit-debris';
    for (let i = 0; i < IMPACT_FX.debris.maxActive; i++) this._debrisMesh.setMatrixAt(i, _zeroMatrix);
    this._debrisMesh.instanceMatrix.needsUpdate = true;
    // 实例色初始化：THREE.Color 默认白，配合 setColorAt 建出 instanceColor 属性
    this._debrisMesh.setColorAt(0, _color.setRGB(1, 1, 1));
    this._debrisMesh.instanceColor.needsUpdate = true;
    this.scene.add(this._debrisMesh);

    // ---- 白闪池 ----
    this._flashSlots = this._makeFlashPool(IMPACT_FX.whiteFlash.maxActive);

    /**
     * 活跃碎块：`{slot, origin, seed, bornAt, dust}`。槽位按 FIFO 复用（池满丢最旧）。
     * @type {Array<object>}
     */
    this._debris = [];
    this._nextDebrisSlot = 0;
    /** 加特林热度（0..1），仅 `heat` profile 的武器累积 */
    this._heat = 0;
    this._heatAt = 0;
    this._heatWeapon = null;
  }

  /** 活跃碎块数（测试钩子） */
  get activeDebrisCount() { return this._debris.length; }

  /** 当前热度（测试钩子） */
  get heat() { return this._heat; }

  /** 碎块实例网格（测试钩子，勿穿透私有字段改状态） */
  get debrisMesh() { return this._debrisMesh; }

  /** 白闪池的 Mesh 列表（测试钩子） */
  flashMeshes() { return this._flashSlots.map((s) => s.mesh); }

  /**
   * 白闪各 slot 的**最后启动时刻**（`NaN` = 从未启动）。
   * 测试钩子：波浪的「已启动格数」用它数 —— 可见数含消退，不是进度；
   * 也不能靠 `cellKey`（消退后被清空，那是「仍活跃」不是「已启动」）。
   */
  flashStarts() { return this._flashSlots.map((s) => (s.startAt > 0 ? s.startAt : NaN)); }

  _makeFlashPool(count) {
    const slots = [];
    for (let i = 0; i < count; i++) {
      // ⚠️ 每 slot 必须独立材质：opacity 是材质级参数。共享一份 → 全部 slot 同步淡出，
      // 连射时会看到「最早那一发的白闪提前消失」（观感是闪烁而非逐发）。
      const material = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0,
        // 白闪要读作「这块方块变成白色了」→ 需要它盖住背后的碎块与洞口。
        // depthWrite 保留：半透明阶段它不写深度也不会错，但写深度让保持段是实心观感。
        depthWrite: true,
        toneMapped: false,
      });
      const mesh = new THREE.Mesh(UNIT_BOX, material);
      mesh.name = 'block-hit-white';
      mesh.scale.setScalar(WHITE_FLASH_SIZE);
      mesh.visible = false;      // 空闲 → 不提交渲染（draw call 回基线）
      mesh.frustumCulled = false;
      this.scene.add(mesh);
      slots.push({ mesh, startAt: 0, cellKey: '' });
    }
    return slots;
  }

  /**
   * 一次射击的命中特效入口。
   * @param {object} effect 武器效果事件（`weapon-controller.js` 的 `_makeEffect` 产出）
   * @param {number} nowMs `performance.now()` 基准（**禁止 `Date.now()`**，见文件头）
   */
  spawnFromEffect(effect, nowMs) {
    const profile = impactProfile(effect?.weaponId);
    if (!profile) return;                       // 徒手/未知武器：无特效
    const impacts = effect.impacts ?? [];
    if (impacts.length === 0) return;           // 打空气 / 打实体：无特效

    // 热度：只有连续火力的武器累积，且换枪即清零（否则切回加特林会带着旧热度）
    if (profile.heat) {
      if (this._heatWeapon !== effect.weaponId) { this._heat = 0; this._heatWeapon = effect.weaponId; }
      this._heat = Math.min(1, heatDecay(this._heat, nowMs - this._heatAt) + 0.34);
      this._heatAt = nowMs;
    } else {
      this._heat = 0;
      this._heatWeapon = null;
    }
    const heat = profile.heat ? this._heat : 0;
    const rand = Math.random;

    for (const impact of impacts) {
      // ① 白闪：命中格整格变白 → 淡出。**所有武器都有**（MAG7 只有这一层）。
      // MAG7 把全部被毁格在 `staggerMs` 内依次亮起（由命中点向外的波浪）；
      // 其余武器一次一格 → 未到时刻的直接亮（`staggerTimes` 退化为全等于 now）。
      const wave = impact.stagger;
      if (wave?.length) {
        const times = staggerTimes(wave.length, waveStaggerMs(impact), nowMs);
        for (let i = 0; i < wave.length; i++) this._queueWhiteFlash(wave[i], times[i]);
      } else {
        this._queueWhiteFlash({ blockPos: impact.blockPos }, nowMs);
      }

      // ② 碎块（仅真破坏；破坏关闭时改发少量粉尘）。MAG7 两者都配 0 → 整段跳过。
      const count = impact.destroyed ? debrisCountFor(profile, heat) : profile.dustCount;
      if (count <= 0) continue;
      const normal = impact.normal ?? [0, 1, 0];
      const blockName = this.blockNameOf ? this.blockNameOf(impact.blockId) : null;
      const color = this.colorResolver && blockName
        ? this.colorResolver(blockName, impact.normal)
        : [0.6, 0.6, 0.6];
      this._spawnDebris(
        impactPosition(impact.blockPos, impact.normal), normal, profile, color, rand, count,
        nowMs, !impact.destroyed,
      );
    }
  }

  /**
   * 把一个白闪挂到队列（到点才出现在场景里）。
   *
   * ⚠️ 不能用 `setTimeout`：定时器与渲染帧不同源（且页面隐藏时会被节流），
   * 而本类的全部时间基准都是帧循环传入的 `performance.now()`（同其他池的到期判定）。
   * 排队后由 `update()` 逐帧比对 `startAt` → 到点才可见。
   * @param {{blockPos: number[]}} entry
   * @param {number} startAt 开始时刻（`nowMs` 或波浪中它自己的错开时刻）
   */
  _queueWhiteFlash(entry, startAt) {
    if (!entry?.blockPos) return;
    // 先在命中瞬间分配 slot（同格去重），避免同一格在波浪中途被分配到两个 slot。
    // 未到点时的 opacity = 0 且 visible = false → 不提交渲染。
    const slot = this._claimFlashSlot(entry.blockPos);
    slot.startAt = startAt;
    slot.cellKey = `${entry.blockPos[0]},${entry.blockPos[1]},${entry.blockPos[2]}`;
    const center = blockCenter(entry.blockPos);
    slot.mesh.position.set(center[0], center[1], center[2]);
    slot.mesh.material.opacity = 0;
    slot.mesh.visible = false;    // update() 到点才置 true
  }

  /** 同格去重的 slot 分配（波浪里每个格子只占一个 slot）。 */
  _claimFlashSlot(blockPos) {
    const cellKey = `${blockPos[0]},${blockPos[1]},${blockPos[2]}`;
    const same = this._flashSlots.find((s) => s.cellKey === cellKey);
    if (same) return same;
    const free = this._flashSlots.find((s) => !s.cellKey);
    if (free) return free;
    // 池满：取最早启动的那个（与 tracer/explosion 池同语义，纯视觉无副作用）
    let oldest = this._flashSlots[0];
    for (const s of this._flashSlots) if (s.startAt < oldest.startAt) oldest = s;
    return oldest;
  }

  _spawnDebris(origin, normal, profile, color, rand, count, nowMs, dust) {
    // 粉尘：更小更慢、颜色压暗（读作「扬尘」，而不是「方块碎了」）
    const speedScale = dust ? 0.45 : 1;
    const sizeScale = dust ? 0.6 : 1;
    const effective = {
      speed: [profile.speed[0] * speedScale, profile.speed[1] * speedScale],
      size: [profile.size[0] * sizeScale, profile.size[1] * sizeScale],
      spin: profile.spin,
    };
    const seeds = createDebrisSeeds(effective, normal, rand, count);
    for (const seed of seeds) {
      const slot = this._nextDebrisSlot;
      this._nextDebrisSlot = (this._nextDebrisSlot + 1) % IMPACT_FX.debris.maxActive;
      // 池满：覆盖最旧（与 tracer/explosion 池同语义，纯视觉无副作用）
      const existing = this._debris.findIndex((d) => d.slot === slot);
      if (existing !== -1) this._debris.splice(existing, 1);
      this._debris.push({ slot, origin, seed, bornAt: nowMs, dust });
      const tone = seed.tone * (dust ? 0.62 : 1);
      _color.setRGB(color[0] * tone, color[1] * tone, color[2] * tone);
      this._debrisMesh.setColorAt(slot, _color);
    }
    if (this._debrisMesh.instanceColor) this._debrisMesh.instanceColor.needsUpdate = true;
    this._debrisMesh.visible = true;
  }

  /**
   * 宿主实体死亡爆散（v2.64）：在死亡位置向**全球面**撒一簇碎块。
   *
   * 与 `spawnFromEffect`（枪击方块）共用同一个碎块池与同一套推进曲线（`update`），
   * 差别只有三处：
   *   · **方向**：全球面（`createDeathBurstSeeds` 上下半球各一半），不是命中面半球；
   *   · **颜色**：由调用方给（丧尸 = 皮肤绿），不读方块 atlas 平均色；
   *   · **不出白闪、不吃热度**：白闪的语义是「这块方块变白了」，用在实体上会误导；
   *     热度是加特林连射的概念，与死亡无关。
   *
   * ⚠️ **不开第二个池**（红线自检：不绕过统一管线新开子系统）：池满时覆盖最旧 slot
   * 的语义与枪击碎块一致（纯视觉，丢弃无副作用）。
   *
   * @param {number[]} position 世界坐标（实体身体中心，由调用方给）
   * @param {number[]} colorRgb 0..1 三分量（碎块基色，逐块再乘 `tone` 做明暗差）
   * @param {number} nowMs `performance.now()` 基准（**禁止 `Date.now()`**，见文件头）
   * @param {{count?: number, rand?: () => number, burst?: object}} [opts]
   *   `burst` = 爆散配置（`DEATH_BURST` 丧尸 / `IGNIS_DEATH_BURST` 焰魔），缺省丧尸口径；
   *   `count` 直接覆盖块数（测试用）；`rand` 注入确定性随机源（测试用）
   */
  spawnDeathBurst(position, colorRgb, nowMs, { count, rand = Math.random, burst = DEATH_BURST } = {}) {
    if (!Array.isArray(position) || position.length !== 3) return;
    if (!position.every((n) => Number.isFinite(n))) return;   // NaN 会污染整个实例矩阵
    const color = Array.isArray(colorRgb) && colorRgb.length === 3 && colorRgb.every(Number.isFinite)
      ? colorRgb : [0.4, 0.6, 0.3];   // 缺色退回中性绿（不阻断特效）
    const seeds = createDeathBurstSeeds(rand, count, burst);
    if (seeds.length === 0) return;
    for (const seed of seeds) {
      const slot = this._nextDebrisSlot;
      this._nextDebrisSlot = (this._nextDebrisSlot + 1) % IMPACT_FX.debris.maxActive;
      const existing = this._debris.findIndex((d) => d.slot === slot);
      if (existing !== -1) this._debris.splice(existing, 1);
      // `dust: false` —— 死亡碎块是「身体碎了」的实体块，不是扬尘（不压暗、不减速）
      // ⚠️ **origin 必须拷一份**：调用方可能复用同一个数组（逐帧复用的临时向量是本仓
      // 的常规手法），存引用会让已入池的碎块跟着调用方的下一次写入一起漂移。
      this._debris.push({
        slot, origin: [position[0], position[1], position[2]], seed, bornAt: nowMs, dust: false,
      });
      _color.setRGB(color[0] * seed.tone, color[1] * seed.tone, color[2] * seed.tone);
      this._debrisMesh.setColorAt(slot, _color);
    }
    if (this._debrisMesh.instanceColor) this._debrisMesh.instanceColor.needsUpdate = true;
    this._debrisMesh.visible = true;
  }

  /**
   * 焰魔砸击碎石圆环（v3.04）：在**身体前方的环心**一圈溅起碎块。
   *
   * 与 `spawnFromEffect`（枪击）/ `spawnDeathBurst`（死亡爆散）**共用同一个碎块池与同一套
   * 推进曲线**（`update`），差别只有三处：
   *   · **位置**：圆环（`smashDebrisRing`，确定性几何），不是命中面半球 / 全球面；
   *   · **法线**：恒 `[0,1,0]`（向上溅起）；
   *   · **初速更低**（原版 `gaussian×0.07` 是原地溅起，不是四散飞射）。
   *
   * ⚠️ **不开第二个池**（红线自检：不绕过统一管线新开子系统）。
   * 池满时覆盖最旧 slot 的语义与其它两处一致（纯视觉，丢弃无副作用）。
   *
   * @param {number[]} at 焰魔身体位置（脚底）
   * @param {number} yaw 本仓 yaw（弧度）
   * @param {number[]} colorRgb 0..1 三分量（取环心脚下那一格的平均色，由调用方给）
   * @param {number} nowMs `performance.now()` 基准（**禁止 `Date.now()`**）
   * @param {{rand?: () => number, cfg?: object}} [opts] `rand` 只影响速度/尺寸/自旋，
   *   不影响落点（见 `smashDebrisRing` 注释）
   */
  spawnSmashRing(at, yaw, colorRgb, nowMs, { rand = Math.random, cfg = IGNIS_SMASH_DEBRIS } = {}) {
    // 入参校验照 `spawnDeathBurst`：NaN 会污染整个实例矩阵
    if (!Array.isArray(at) || at.length !== 3 || !at.every((n) => Number.isFinite(n))) return;
    if (!Number.isFinite(yaw)) return;
    const color = Array.isArray(colorRgb) && colorRgb.length === 3 && colorRgb.every(Number.isFinite)
      ? colorRgb : [0.5, 0.5, 0.5];   // 缺色退回中性灰（不阻断特效）
    const points = smashDebrisRing(at, yaw, cfg);
    for (const p of points) {
      // `IGNIS_SMASH_DEBRIS` 直接当 profile：`_spawnDebris` 只读 speed/size/spin，
      // count 显式传 1（每点一块）—— 不需再派生一份 profile 形状。
      this._spawnDebris(p.position, p.normal, cfg, color, rand, 1, nowMs, false);
    }
  }

  /**
   * 每帧推进：碎块抛物线 + 自旋 + 末段缩零；白闪按包络变白/淡出。
   * @param {number} nowMs `performance.now()` 基准
   */
  update(nowMs) {
    // ---- 碎块 ----
    let matrixDirty = false;
    for (let i = this._debris.length - 1; i >= 0; i--) {
      const d = this._debris[i];
      const age = nowMs - d.bornAt;
      const size = debrisSizeAt(d.seed, age);
      if (size <= 0) {
        this._debrisMesh.setMatrixAt(d.slot, _zeroMatrix);
        this._debris.splice(i, 1);
        matrixDirty = true;
        continue;
      }
      const off = debrisOffset(d.seed, age);
      _v3a.set(d.origin[0] + off[0], d.origin[1] + off[1], d.origin[2] + off[2]);
      // 自旋轴是随机单位向量：先绕轴转，再乘尺寸
      _axis3.set(d.seed.spinAxis[0], d.seed.spinAxis[1], d.seed.spinAxis[2]);
      _q.setFromAxisAngle(_axis3, debrisSpinAngle(d.seed, age));
      _scale3.set(size, size, size);
      _m4.compose(_v3a, _q, _scale3);
      this._debrisMesh.setMatrixAt(d.slot, _m4);
      matrixDirty = true;
    }
    if (matrixDirty) this._debrisMesh.instanceMatrix.needsUpdate = true;
    if (this._debris.length === 0) this._debrisMesh.visible = false;

    // ---- 白闪 ----
    // 逐 slot 按 `startAt` 判定：波浪中尚未到点的格 opacity=0 / visible=false（不入渲染），
    // 到点才亮。这就是「依次让应该消失的方块白闪」的扩散过程。
    for (const slot of this._flashSlots) {
      if (!slot.cellKey) continue;            // 空闲
      if (nowMs < slot.startAt) continue;     // 波浪中还没轮到它
      const st = whiteFlashOpacityAt(nowMs - slot.startAt, _flashOut);
      if (st.done) {
        slot.cellKey = '';
        slot.mesh.visible = false;
        slot.mesh.material.opacity = 0;
        continue;
      }
      slot.mesh.material.opacity = st.opacity;
      slot.mesh.visible = true;
    }
  }

  /** 清空全部活跃特效（Tier 4 fixture 用来隔离对照组） */
  reset() {
    this._debris.length = 0;
    for (let i = 0; i < IMPACT_FX.debris.maxActive; i++) this._debrisMesh.setMatrixAt(i, _zeroMatrix);
    this._debrisMesh.instanceMatrix.needsUpdate = true;
    this._debrisMesh.visible = false;
    for (const slot of this._flashSlots) {
      slot.cellKey = '';
      slot.startAt = 0;
      slot.mesh.visible = false;
      slot.mesh.material.opacity = 0;
    }
    this._heat = 0;
    this._heatWeapon = null;
    this._heatAt = 0;
  }

  dispose() {
    this.scene.remove(this._debrisMesh);
    this._debrisMesh.dispose();
    this._debrisMesh.material.dispose();
    for (const slot of this._flashSlots) {
      this.scene.remove(slot.mesh);
      slot.mesh.material.dispose();
    }
    this._flashSlots.length = 0;
    UNIT_BOX.dispose();
    this._debris.length = 0;
  }
}
