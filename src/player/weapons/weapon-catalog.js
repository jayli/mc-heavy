// src/player/weapons/weapon-catalog.js — 武器静态目录（M4 规格 §3/§4.2）
// 只含数字和数组的静态配置：无 three、无 DOM。渲染层只读消费，不得改写（递归冻结）。
// 模型 transform 沿用 mc-lite 归一化模型后的值；所有坐标均为相机局部坐标，cooldown 单位为秒。

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
    tracer: { color: 0xffff00, thickness: 1, lifetime: 0.1 }, automatic: true,
  },
  [WEAPON_IDS.MAG7]: {
    id: 'mag7', model: 'mag7', cooldown: 1.5, recoil: 0.15, sound: 'mag7_fire', volume: 0.2,
    transform: { scale: [1.3, 1.3, 1.3], position: [0.44, -0.5, -0.8], rotation: [0, -Math.PI / 2, 0] },
    muzzleOffset: [0.3, -0.82, -0.44], localStart: [0.55, -0.4, -1.8],
    tracer: { color: 0xff6600, thickness: 6, lifetime: 0.15 }, automatic: false,
    scan: { min: 1, max: 10, step: 0.5, halfWidth: 1, maxBlocks: 40 },
  },
  [WEAPON_IDS.MINIGUN]: {
    id: 'minigun', model: 'minigun', cooldown: 0.07, recoil: 0, sound: 'minigun_fire', volume: 0.15,
    // 加特林视图节点在应用绕局部 x 轴的枪管旋转前必须设 rotation.order='YXZ'，
    // 避免 mc-lite 已修复的欧拉万向锁。
    transform: { scale: [0.5, 0.5, 0.5], position: [0.48, -0.56, 0.6], rotation: [-Math.PI / 2, -Math.PI / 2, -Math.PI], rotationOrder: 'YXZ' },
    muzzleOffset: [0.3, -0.82, -0.44], localStart: [0.5, -0.5, -1.8],
    tracer: { color: 0xffff00, thickness: 0.5, lifetime: 0.08 }, automatic: true,
    spin: { targetRadiansPerSecond: 25, shootingRetentionAt60Hz: 0.9, idleRetentionAt60Hz: 0.85 },
  },
});
