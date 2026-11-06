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
    transform: { scale: [1.0, 1.0, 1.0], position: [0.42, -0.42, -0.55], rotation: [0.25, -0.35, -0.5] },
    // 近战：无 muzzleOffset / localStart / tracer / automatic / scan（枪专属字段）
    entityDamage: 50, entityRange: 3, melee: true,
    hitSound: 'emp_activated', hitVolume: 0.6,
    swingSeconds: 0.3,
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
