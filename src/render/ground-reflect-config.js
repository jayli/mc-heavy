// src/render/ground-reflect-config.js — 湿地面反射的标定常数与纯函数（**three-free**）
//
// ## 为什么必须独立一条 pass（用户 2026-11-22 裁定，本轮几何取证的结论）
//
// 上游 `GROUND_FRAG` 的 planar reflection 之所以正确，是因为**它的地面就在 y=0，
// 而反射镜面也在 y=0** ⇒ `vReflPos = uReflMatrix * vec4(wp.x, 0.0, wp.z, 1)` 的
// 「压平到镜面高度」是 **no-op**。
//
// 本仓地面是**体素地形**，高度随 biome 起伏（实测出生带 y≈22），而既有水面 reflector
// 的镜面固定在 `WATER_LEVEL_OFFSET = −1.5` ⇒ 压平会把地面点**推低 23.5 格**
// ⇒ 投影出画：近处完全没反光、远处采到错位内容（用户读作「地下一层模糊的透射」）。
// **复用海平面 reflector 在几何上不可能正确**，与采样坐标怎么写无关。
//
// ⇒ 本模块定义**第二条 reflector**，镜面高度 = **玩家脚下地面顶面**（每帧跟随）。
// 这样地面点压平到镜面的位移 ≈ 0（玩家站的那一层），近中远都有正确倒影。
//
// ## 与既有水面 pass 的关系（三条硬约束）
//
// ① **两条 pass 都必须在主 render 之前手动跑**（v3.17 的 indirect 索引表约束）；
// ② **不能同帧交错**：BatchedMesh 的 `_indirectTexture` 一帧内最后一次写入胜出
//    ⇒ 必须「跑完 A → 恢复列表 → 跑完 B → 恢复列表 → 主 render」，
//    每条 pass 各自套 `render-world.js` 的 multi-draw 守卫（见 `_installReflectionGuard`）；
// ③ **各自藏掉对方**：地面 pass 要藏水面平面（否则地面映出水面）、
//    水面 pass 要藏…… 不，水面 pass 保持原样（它本来就藏第一人称与特效池）。
//
// ⚠️ 本文件不 import three（Node 单测直接读）。

/** 反射 RT 相对 drawing buffer 的边长倍率（同水面口径：省钱靠节流不靠降分辨率） */
export const GROUND_REFLECT_SCALE = 0.5;

/** 刷新间隔（帧）。2 = 60Hz 屏上 30Hz 刷新，同水面口径 */
export const GROUND_REFLECT_EVERY = 2;

/** 采样 mip 级别（朦胧度；上游 prough*7，本仓固定 2 与水面同口径） */
export const GROUND_REFLECT_MIP = 2;

/**
 * 镜面相对「玩家脚下地面顶面」的抬升（格）。
 *
 * ⚠️ **取 0.02 而不是 0**：完全共面会让反射相机的 oblique 裁剪面与地面 z-fighting
 * ⇒ 倒影里地面自己闪烁。抬 2cm 足够分开，且对倒影几何的影响肉眼不可辨。
 */
export const GROUND_MIRROR_LIFT = 0.02;

/**
 * 反射强度上限（0 = 关掉反射项）。
 * 上游 `col += refl * fres * (1 − 0.45*prough)`，fres 在掠射时 ≈1 ⇒ 有效强度 ≈0.5。
 * 本仓取 0.5（比旧值 0.35 高：旧值是为了压住「错位内容」的可见度，几何修好后不需要）。
 */
export const GROUND_REFLECT_STRENGTH = 0.5;

/**
 * 镜面高度的**平滑跟随**系数（每秒）。
 *
 * ⚠️ **必须平滑**：玩家上下台阶/跳跃时地面高度会阶跃 1 格，镜面随之阶跃
 * ⇒ 倒影整片跳一下（读作闪）。取 12/s 的一阶低通（≈80ms 收敛），
 * 与 `view-bob` / `step-lift` 的同量级手感。
 * ⚠️ 大幅瞬移（>8 格）时**直接吸附**，不平滑（否则倒影要滑好几秒才到位）。
 */
export const GROUND_MIRROR_DAMP = 12;
export const GROUND_MIRROR_SNAP_DIST = 8;

/**
 * 地面顶面探针的搜索深度（格）。
 * 从玩家脚底往下找第一个实心格 —— 与 `rain-shelter` 同口径，但深度小得多
 * （玩家要么站在地面上，要么在飞行；飞行时取脚下 32 格内的地面）。
 */
export const GROUND_PROBE_DEPTH = 32;

/**
 * 镜面高度候选（纯函数）：从玩家脚底往下找第一个**挡雨方块**的顶面。
 *
 * ⚠️ 判据复用 `rain-shelter.blocksRain`（实心 ∧ 非 cutout ∧ 非云）——
 * 树叶/云不该当镜面（它们不是地面）。扫不到返回 null（飞行在高空 ⇒ 不画湿地面反射）。
 *
 * @param {{getBlockId:Function}} world
 * @param {object} registry
 * @param {number} x @param {number} y @param {number} z 玩家脚底位置
 * @param {(id:number, reg:object)=>boolean} blocksRain 注入判据（避免循环 import）
 * @param {number} [depth]
 * @returns {number|null} 地面顶面世界 y
 */
export function groundMirrorCandidate(world, registry, x, y, z, blocksRain, depth = GROUND_PROBE_DEPTH) {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const start = Math.floor(y);
  for (let yy = start; yy >= start - depth; yy--) {
    if (blocksRain(world.getBlockId(ix, yy, iz), registry)) return yy + 1;
  }
  return null;
}

/**
 * 镜面高度的平滑推进（纯函数，帧率无关）。
 *
 * @param {number} current 当前镜面 y（null = 尚未初始化）
 * @param {number|null} target 本帧候选（null = 扫不到地面）
 * @param {number} dt 秒
 * @param {number} [damp]
 * @param {number} [snapDist]
 * @returns {number|null} 新的镜面 y
 */
export function groundMirrorAdvance(current, target, dt, damp = GROUND_MIRROR_DAMP, snapDist = GROUND_MIRROR_SNAP_DIST) {
  if (target === null || !Number.isFinite(target)) return null;
  if (current === null || !Number.isFinite(current)) return target;
  if (Math.abs(target - current) > snapDist) return target;   // 瞬移：直接吸附
  const k = 1 - Math.exp(-damp * Math.max(0, dt));
  return current + (target - current) * k;
}

/**
 * 本帧是否应刷新地面反射（节流 + 可见性）。
 *
 * ⚠️ 与水面同口径：**按帧节流**而不是按毫秒（倒影的延迟观感单位是帧）。
 * ⚠️ 首帧恒放行（否则第一帧采到空 RT = 纯黑倒影，而计数类判据全对）。
 *
 * @param {number} frame 帧序号（只增）
 * @param {number} lastFrame 上次刷新的帧号（−1 = 从未）
 * @param {boolean} visible 本帧地面是否可能被看到
 * @param {number} [every]
 * @returns {boolean}
 */
export function groundReflectDue(frame, lastFrame, visible, every = GROUND_REFLECT_EVERY) {
  if (!visible) return false;
  if (lastFrame < 0) return true;
  return frame - lastFrame >= every;
}

/**
 * 地面反射的可见性门（纯函数）。
 *
 * 两条：① 相机在镜面**之上**（否则倒影朝下看不见）；② 视线朝下（视野里有地面）。
 * ⚠️ 与水面 `reflectVisible` 同结构，但**镜面高度是动态的**（玩家脚下地面）。
 *
 * @param {number} cameraY @param {number|null} mirrorY
 * @param {number} forwardY 相机前向 y（>0 = 抬头）
 * @param {number} [halfFovRad]
 * @returns {boolean}
 */
export function groundReflectVisible(cameraY, mirrorY, forwardY, halfFovRad = 0.61) {
  if (mirrorY === null || !Number.isFinite(mirrorY)) return false;
  if (!Number.isFinite(cameraY) || !Number.isFinite(forwardY)) return false;
  if (cameraY <= mirrorY) return false;
  return forwardY <= Math.sin(halfFovRad);
}