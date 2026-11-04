// src/entities/dragons/dragon-facing.js — 飞龙「机头朝向」的唯一权威（v2.48）
//
// 同构层：**无 DOM、无 three**（`check:arch` 的 `ISOMORPHIC_DIRS` 静态门守）。
//
// ## 为什么要有这个模块（红线 1）
//
// v2.45 之前，龙的前向在**四处各写一份**、且各自只覆盖 yaw：
// ① `dragon-config.js` 注释里的「前向 = (−sin yaw, −cos yaw)」；
// ② `test-dragon-boss-agent.js` 的 `muzzleWorld()` helper（公式抄一份）；
// ③ `dragon-renderer.js` 的 `pivot.rotation.set(0, yaw, 0)`（three 绕 Y 的矩阵）；
// ④ `dragon-system.js` 的 `dragonAabbFor()` 手写旋转。
//
// v2.48 给龙加了**俯仰**（俯冲喷火），这四处必须同时扩成 `R(yaw)·R(pitch)`。继续各写一份
// 会漂移出「看到的龙低头 40°，机关算出的火球却按低头 20° 飞」——而格数、指纹、单测全绿。
// 这正是 M8 炮塔「弹丸往天上飞」的同一类缺陷（逻辑朝向与渲染朝向两套公式）。
// 故本文件是唯一实现，四个消费方都必须 import 它。
//
// ## 旋转约定（与 three 一致，勿改）
//
// three 的 Y 轴旋转：`x' = x·cosθ + z·sinθ`、`z' = −x·sinθ + z·cosθ`；
// X 轴旋转（右手系、绕 +X）：`y' = y·cosφ − z·sinφ`、`z' = y·sinφ + z·cosφ`。
// 渲染层用 `pivot.rotation.set(pitch, yaw, 0, 'YXZ')` —— 即先绕 Y 再绕 X（**顺序必须显式
// 'YXZ'**：默认 'XYZ' 会让偏航与俯仰互相耦合，龙会侧着走）。
//
// `pitch` 的符号：**负 = 低头**（与 three 的 `rotation.x` 同向）。验证：yaw=0 时前向本为
// (0,0,−1)，pitch=−π/2 时 → (0,−1,0) 即朝正下方 —— 低头。见 `test-dragon-facing.js`。

/** 零俯仰（平飞）。渲染与命中盒的缺省 pitch。 */
export const ZERO_PITCH = 0;

/**
 * 机头前向单位向量（世界空间）。
 *
 * @param {number} yaw 偏航（弧度，本仓口径：yaw=0 朝北 = −Z）
 * @param {number} [pitch] 俯仰（弧度，**负 = 低头**），缺省 0 = 平飞（逐位等于旧行为）
 * @returns {[number, number, number]} 归一化前向（长度恒 1）
 */
export function dragonForward(yaw, pitch = ZERO_PITCH) {
  const cp = Math.cos(pitch);
  return [-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp];
}

/**
 * 把「机头局部空间的偏移」（如 `DRAGON.muzzleOffset`）变换到世界空间方向。
 *
 * = `R(yaw)·R(pitch)` 作用在偏移上。⚠️ 与 `dragonForward` 同源：
 * `dragonMuzzleOffsetWorld(yaw, pitch, [0, 0, -1])` 恒等于 `dragonForward(yaw, pitch)`。
 *
 * @param {number} yaw @param {number} pitch
 * @param {[number, number, number]} local 局部偏移（x=右, y=上, z=−前）
 * @returns {[number, number, number]} 新数组（世界空间的偏移，未归一化）
 */
export function dragonRotateLocal(yaw, pitch, local) {
  const [lx, ly, lz] = local;
  // 先绕 X（俯仰）：局部 y/z 平面内旋转
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const y1 = ly * cp - lz * sp;
  const z1 = ly * sp + lz * cp;
  // 再绕 Y（偏航）：three 约定
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  return [lx * cy + z1 * sy, y1, -lx * sy + z1 * cy];
}

/**
 * 嘴部相对身体中心的世界空间偏移（= `dragonRotateLocal(yaw, pitch, muzzleOffset)`）。
 *
 * 拆出这个薄包装只为一件事：让 `_muzzlePosition`、渲染层、测试夹具都从**同一个入口**
 * 取偏移，不必各自 import `DRAGON.muzzleOffset` 再自己旋转。
 *
 * @param {number} yaw @param {number} pitch @param {[number,number,number]} muzzleOffset
 * @returns {[number, number, number]}
 */
export function dragonMuzzleOffsetWorld(yaw, pitch, muzzleOffset) {
  return dragonRotateLocal(yaw, pitch, muzzleOffset);
}
