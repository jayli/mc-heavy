// src/player/weapons/weapon-catalog.js — 武器静态目录（M4 规格 §3/§4.2）
// 只含数字和数组的静态配置：无 three、无 DOM。渲染层只读消费，不得改写（递归冻结）。
// 模型 transform 沿用 mc-lite 归一化模型后的值；所有坐标均为相机局部坐标，cooldown 单位为秒。
//
// 「曳光停留时间」= 各武器 `tracer.lifetime`，**有意偏离 mc-lite 的四分之一**（v1.62）：
// mc-lite 原值 0.10 / 0.15 / 0.08（`Gun.js` 的 tracerLifetime）。曳光起点/终点都冻结在
// 开火瞬间的世界空间（v1.33），玩家奔跑时残影钉在原地不动 → 全长（接近原值）会在身后
// 连成一排射向远方残余的火线。缩短到 1/4 后残影只闪一下即消隐；其余参数（颜色/粗细）不变。

export const WEAPON_IDS = Object.freeze({
  ARM: 'arm', PISTOL: 'pistol', MAG7: 'mag7', MINIGUN: 'minigun', SWORD: 'sword',
});

/**
 * 剑体基础朝向（弧度，XYZ 序）。
 *
 * 来源：先定「相机空间目标基」再反解欧拉角（推导见 `WEAPONS[SWORD].transform` 注释），
 * 度数结果是 **-60° / -90°**。这里用表达式而不是 `-1.047` 这类硬编码小数，是为了让
 * 后面的人一眼看出它是角度换算 —— v2.65 的缺陷就是「度/弧度」混用。
 */
const SWORD_LENGTH_SCALE = 1.07534;
const SWORD_ROTATION_X = (-87.626 * Math.PI) / 180;
const SWORD_ROTATION_Y = (-29.922 * Math.PI) / 180;
const SWORD_ROTATION_Z = (-53.738 * Math.PI) / 180;

/** 曳光池上限：池满时丢弃最旧的纯视觉曳光，绝不丢弃命中或世界编辑（M4 规格 §4.2） */
export const MAX_ACTIVE_TRACERS = 32;

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export const WEAPONS = freeze({
  [WEAPON_IDS.PISTOL]: {
    id: 'pistol', model: 'pistol', cooldown: 0.09, recoil: 0.05, sound: 'gun_fire', volume: 0.09,
    transform: { scale: [0.09, 0.09, 0.09], position: [0.3, -0.85, -0.4], rotation: [0, 0, 0] },
    muzzleOffset: [0.3, -0.82, -0.44], localStart: [0.3, -0.33, -0.98],
    tracer: { color: 0xffff00, thickness: 1, lifetime: 0.025 }, automatic: true,
    // M6 增补（M6 规格 §2）：实体伤害与射程。手枪 25 → 四发致死（生命 100）
    entityDamage: 25, entityRange: 40,
  },
  [WEAPON_IDS.MAG7]: {
    id: 'mag7', model: 'mag7', cooldown: 1.5, recoil: 0.15, sound: 'mag7_fire', volume: 0.2,
    transform: { scale: [1.3, 1.3, 1.3], position: [0.44, -0.5, -0.8], rotation: [0, -Math.PI / 2, 0] },
    muzzleOffset: [0.3, -0.82, -0.44], localStart: [0.55, -0.4, -1.8],
    tracer: { color: 0xff6600, thickness: 6, lifetime: 0.0375 }, automatic: false,
    scan: { min: 1, max: 10, step: 0.5, halfWidth: 1, maxBlocks: 40 },
    // M6 增补：实体射程**必须等于** `scan.max`（同一把枪的实体/方块两个射程口径不得漂移）。
    // 999 → 一击致死；MAG7 不是 projectile，实体命中与方块扫描是同一发的两个独立步骤。
    entityDamage: 999, entityRange: 10,
  },
  [WEAPON_IDS.MINIGUN]: {
    id: 'minigun', model: 'minigun', cooldown: 0.07, recoil: 0, sound: 'minigun_fire', volume: 0.15,
    // 加特林视图节点在应用绕局部 x 轴的枪管旋转前必须设 rotation.order='YXZ'，
    // 避免 mc-lite 已修复的欧拉万向锁。
    transform: { scale: [0.5, 0.5, 0.5], position: [0.48, -0.56, 0.6], rotation: [-Math.PI / 2, -Math.PI / 2, -Math.PI], rotationOrder: 'YXZ' },
    muzzleOffset: [0.3, -0.82, -0.44], localStart: [0.5, -0.5, -1.8],
    tracer: { color: 0xffff00, thickness: 0.5, lifetime: 0.02 }, automatic: true,
    spin: { targetRadiansPerSecond: 25, shootingRetentionAt60Hz: 0.9, idleRetentionAt60Hz: 0.85 },
    // M6 增补：35 → 三发致死
    entityDamage: 35, entityRange: 40,
  },

  /**
   * 紫色剑（v2.65，用户 2026-11-06）—— 本仓**第一件近战武器**，故有一组枪没有的字段：
   *
   * - `melee: true` —— controller 据此走 `_fireMelee`（**不写方块、不发曳光**）。
   *   用户明确：「剑不能像枪一样可以破坏方块，但可以伤害敌人」。
   * - `hitSound` / `hitVolume` —— 砍中敌人的音效（`emp_activated.ogg`）。与 `sound`
   *   （挥砍音 `player_swing.ogg`）分开：挥空也响 `sound`，只有命中才响 `hitSound`。
   * - `swingSeconds` —— 视图模型挥砍动画时长（`view-weapon.js` 消费）。
   *
   * ## 数值设计（用户授权「掉血幅度你来设计决定」）
   *
   * `entityDamage = 50` / `cooldown = 0.5` ⇒ 100 DPS，各实体的刀数：
   *   · 丧尸（health 100）→ **2 刀**（手枪 25 要 4 发，剑更快 —— 近战的回报）；
   *   · 焰魔（health 450）→ 9 刀；
   *   · 飞龙（health 3000）→ 60 刀（飞龙是飞行 Boss，近战本就难贴身，这是设计意图）。
   * DPS 刻意低于枪（手枪 278 / 加特林 500）：枪是安全距离输出，剑要贴脸挨打。
   *
   * ## `entityRange = 3` 的可达性（实测定，不是拍脑袋）
   *
   * 三类敌人都够得着：
   *   · 丧尸贴身追击，玩家能到 ≈0.6 格（半宽 0.3 + 0.3）；
   *   · 焰魔**站定环 4.25~5.0 格**（`IGNIS_AI.standoffRange`，用户裁定「不动如山」），
   *     但玩家可主动贴近到 ≈1.36 格（被身体盒挡住，E2E 实测值）⇒ 3 格内能砍到。
   *     代价是先挨几下（焰魔 `hitRange` 6.5）—— 近战 vs 远程 Boss 的风险回报；
   *   · 飞龙俯冲（`diveOffset`）与飞跃（`flyoverDistance` 6）时会进到 3 格内。
   * ⚠️ **改这个值前先核对焰魔的 `standoffRange`**：若剑射程 < 焰魔站定环下界，
   * 形态是「焰魔站在环上砍你、你永远砍不到它」，而数据层看不出因果。
   */
  [WEAPON_IDS.SWORD]: {
    id: 'sword', model: 'sword', cooldown: 0.5, recoil: 0, sound: 'player_swing', volume: 0.5,
    /**
     * 第一人称摆放（v2.66 重构，实测定标 —— 勿凭手感改）。
     *
     * **欧拉角不是拍脑袋的**：先定「相机空间目标基」，再反解欧拉角。模型空间轴 ↔ 相机空间：
     *   · 模型 +X（薄轴 = 剑面法线）→ (0, √3/2, 0.5)  朝相机且略朝上 ⇒ 看到剑面而不是刀背
     *   · 模型 +Y（柄→尖）          → (0, 0.5, -√3/2) 向前且朝上 ⇒ **刀刃向前**（用户裁定）
     *   · 模型 +Z（剑身宽度）        → (-1, 0, 0)      屏幕内朝左
     * 三个基向量正交（c3 由前两者叉乘得到）、det = +1、欧拉往返误差 1.5e-8。
     * 反解结果是 **90° / -70.08° / 144.96°（XYZ 序）**，见文件头 `SWORD_ROTATION_*` 常量注释。
     *
     * ⚠️ **catalog 的 `rotation` 单位是弧度**（与枪同一口径：MAG7 写的是 `-Math.PI / 2`）。
     * 曾经把度数（-60）直接填进来，实测被当成 **-60 弧度 = -3437°** ⇒ 剑体变成无从预期的朝向。
     * 这种错在任何「模型加载成功 / 非黑像素」类判据下都不会报，只有量相机空间坐标才现形。
     *
     * ⚠️ **v2.65 的 `[0.25, -0.35, -0.5]` 是错的**（实测：剑尖 z=-0.362 比剑柄 z=-0.738
     * 更靠近相机 ⇒ 剑体前后颠倒，柄朝前、尖朝脸），且屏幕包围盒 x[575..2162] y[-277..1357]
     * 对 1280×720 视口只有 **19.6%** 落在窗内。两个缺陷同源。
     * 自我约束：改这三个数后必须重跑 `tests/sword.spec.mjs` 的「剑体朝向」与
     * 「剑体大部分在视窗内」两条 —— 它们判的是**相机空间坐标与屏幕包围盒**，不是目视。
     */
    transform: {
      scale: [SWORD_LENGTH_SCALE, SWORD_LENGTH_SCALE, SWORD_LENGTH_SCALE],
      position: [1.09287, -0.006, -1.00283],
      rotation: [SWORD_ROTATION_X, SWORD_ROTATION_Y, SWORD_ROTATION_Z],
      rotationOrder: 'XYZ',
    },
    /**
     * 挥砍支点（**节点局部坐标**，未乘 scale）= 剑柄末端在节点里的位置。
     *
     * 实测值 = 柄末端**节点局部**坐标 `(0, -0.9375, 0.0996)`，**不乘 scale**：
     * 挥砍矩阵 `M = ΔR · baseM · T(c)` 作用在节点局部点上，而 baseM 已含节点 scale，
     * 再乘一次 scale 等于把支点推远一倍（v2.69 实测握点漂移 166px 的根因）。
     * 不乘 scale 还有个好处：改 `SWORD_LENGTH_SCALE` 时支点不用跟着重标。
     * 挥砍时绕它转，则**握点（手）在相机空间里不动**、剑身在支点外侧扫弧 —— 这才是挥砍。
     * 绕模型中心转的形态是「螺旋桨」，用户 2026-11-06 已明确否掉。
     */
    swingPivot: [0, -0.9375, 0.09958],
    // 近战：无 muzzleOffset / localStart / tracer / automatic / scan（枪专属字段）
    entityDamage: 50, entityRange: 3, melee: true,
    hitSound: 'emp_activated', hitVolume: 0.6,
    swingSeconds: 0.3,
    /**
     * 挥砍幅度（弧度）。轴是**相机空间**的（见 `view-weapon.js` 头部注释）：
     * 相机 Z+ = 屏幕平面内逆时针（蓄力与主挥同号连续斜劈）、Y+ = 收刀沿屏底拉回；
     * 与静止姿态解耦，改姿态不重标。
     * 蓄力（Z+ 抬向正上）→ 主挥（Z+ 继续斜劈到左下）→ 收刀（Y+ 沿屏底回位）→ 甩腕。
     */
    swing: {
      /** 蓄力段占比：前 25% 抬剑，后 75% 砍出去再收回 */
      windupEnd: 0.25,
      /** 蓄力抬剑（相机 Z+，屏幕平面内逆时针：剑尖从右上抬向正上） */
      windupRoll: 0.35,
      /** 主挥（相机 Z+ 继续逆时针：正上 → 左 → 左下，右手持剑的斜劈半圆） */
      roll: 3.1,
      /** 下劈带的深度（相机 X，辅助） */
      chop: 0.3,
      /** 下劈带的横移（相机 Y，辅助） */
      sweep: 0.18,
      /** 收刀（相机 Y+，滞后曲线）：把回位路径沿屏底拉回，不走原弧翻回屏顶 */
      returnSweep: 0.9,
      /** 甩腕（绕剑身长轴拧腕，滞后曲线） */
      wrist: 0.5,
    },
    /**
     * 击退距离（格）。用户：「挨了一剑后，如果没死的话，就往后退一小步」。
     *
     * 0.4 格的标定依据：丧尸追击速度 1.2 格/秒 ⇒ 0.4 格 = 它 0.33 秒的行程，
     * 看得见「被推开」又不会像瞬移；且小于丧尸排斥半径 `ZOMBIE_SEPARATION.minDistance`(1.2)，
     * 不会把两只丧尸一次击退到互相排斥的阈值外造成连锁推挤。
     */
    knockbackDistance: 0.4,
  },
});
