// src/render/view-bob-config.js — 第一人称视图模型的**步态摆动幅度**（v3.46）
//
// ## 为什么单独成文件
//
// 三个消费方要读同一组数：`carbine-view.js`（KV-9，v3.30 起）/ `view-arm.js`（徒手手臂）/
// `view-weapon.js`（近战剑）。写在任一个里都会让另外两个 import 一个**带 TSL 的重模块**：
//   · `view-arm.js` 若 import `carbine-view.js` ⇒ 手臂皮肤烘焙脚本（Node 侧读 UV 表）
//     被迫解析 `three/tsl`，而 `tools/bake-*.mjs` 没有 three 解析映射（实测报 ERR_MODULE_NOT_FOUND）；
//   · 反向 import 同理。
//
// 本文件 **three-free**（只有数字），故三方都能安全 import，Node 侧也能读。
// 手法同 `render/ambient-fx-config.js` / `render/spike-fx-config.js`（配置与渲染分离）。
//
// ## 上游出处
//
// OpusCraft 的 KV-9 视图模型（本仓 v3.30 移植）：
//   `rig.position.x += cos(ph) * 0.012 * amp`
//   `rig.position.y += -|sin(ph)| * 0.014 * amp`
//   `rig.rotation.z += sin(ph) * 0.018 * amp`
//
// ⚠️ **相位与幅度不在这里** —— 唯一权威是 `player/view-bob.js` 的 `ViewBob`
//（距离驱动相位 + 一阶平滑幅度），装配层每帧喂 `bobPhase` / `bobAmp`。
// 本表只管「幅度换算成视图模型的位移/滚转是多少」。

/** 步态摆动幅度（冻结，单一权威）。 */
export const VIEW_BOB = Object.freeze({
  /** 横向位移（格）：`cos(φ) · bobX · amp` */
  x: 0.012,
  /** 纵向位移（格，**只向下**）：`−|sin(φ)| · bobY · amp` */
  y: 0.014,
  /** 滚转（弧度）：`sin(φ) · bobRoll · amp` */
  roll: 0.018,
});