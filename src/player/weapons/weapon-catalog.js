// src/player/weapons/weapon-catalog.js — 武器静态目录（M4 规格 §3/§4.2）
// 只含数字和数组的静态配置：无 three、无 DOM。渲染层只读消费，不得改写（递归冻结）。
// 模型 transform 沿用 mc-lite 归一化模型后的值；所有坐标均为相机局部坐标，cooldown 单位为秒。
//
// 「曳光停留时间」= 各武器 `tracer.lifetime`，**有意偏离 mc-lite 的四分之一**（v1.62）：
// mc-lite 原值 0.10 / 0.15 / 0.08（`Gun.js` 的 tracerLifetime）。曳光起点/终点都冻结在
// 开火瞬间的世界空间（v1.33），玩家奔跑时残影钉在原地不动 → 全长（接近原值）会在身后
// 连成一排射向远方残余的火线。缩短到 1/4 后残影只闪一下即消隐；其余参数（颜色/粗细）不变。

export const WEAPON_IDS = Object.freeze({ ARM: 'arm', PISTOL: 'pistol', MAG7: 'mag7', MINIGUN: 'minigun' });

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
});
