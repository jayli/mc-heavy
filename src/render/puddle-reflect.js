// src/render/puddle-reflect.js — 积水斑的**真倒影**：复用 ocean 已验收的 reflector RT
//
// 用户 2026-11-23 裁定走方案 A：「用目前已有的成熟方案，在地面水汪上构建镜像映射」。
//
// ## 为什么复用而不是自建（复盘 docs/retro-2026-11-23-puddle-mirror-reflection.md）
//
// 自建镜像 pass 那轮卡在「BatchedMesh + 逐实例 atlas UV」的适配上（RT 内容错）。
// 而 `ocean.js` 的 reflector **已在本仓跑通并被验收**
// （`tests/water-reflect.spec.mjs`：signal > 0.05、噪声底 < 0.01、天空不撕碎），
// 它已经解决了全部适配问题。**复用它 = 不重复踩那些坑。**
//
// ## 三条直接沿用既有口径（不自己发明）
//
// ① **采样 UV 用 `screenUV.flipX()`** —— 这是 three reflector 的默认口径
//    （`_defaultUV = screenUV.flipX()`），ocean 也用它。**不需要投影矩阵**：
//    reflector 的虚拟相机与主相机共享投影矩阵，屏幕空间 UV 天然对齐。
//    ⚠️ `.flipX()` 必须保留：RT 是渲染目标纹理，去掉它倒影上下颠倒，
//    而「颠倒的倒影看起来也有点像倒影」，极易误判为正确（ocean 注释已记）。
// ② **mip 模糊**：用户要「模糊一些」，取 `REFLECT_MIP_LEVEL` 同源常量。
// ③ **multi-draw 守卫**：反射 pass 会覆写 BatchedMesh 的 `_indirectTexture`，
//    必须 `beginReflectGuard()/endReflectGuard()` 成对隔离（自建那轮我漏了这一步）。
//
// ## 与 ocean 的唯一差异：镜面高度
//
// ocean 的镜面是海平面（屏幕对齐的大平面），地面水汪在**玩家脚下那一层**。
// 二者高度不同 ⇒ 几何上是近似。用户要「模糊一些」，mip 正好掩盖偏差。
// **只朝上面生效**（用户裁定：只管地面，墙面完全不参与 ⇒ 岩壁光晕无从产生）。
//
// ## 已知硬约束（v3.31 注释记过，本轮必须正面处理）
//
// ⚠️⚠️ 体素材质采样反射 RT 时，若反射 pass 正在写同一张 RT ⇒ WebGPU 报
// `writable usage and another usage in the same synchronization scope` ⇒ 整帧作废。
// v3.31 当初就是因此删掉了地面 RT 采样。
// **本轮解法**：反射 pass 期间把 `uPuddleReflect` 临时置 0 **并不够**
// （texture 节点仍在 bind group 里，WebGPU 按绑定算 usage）⇒ 必须在反射 pass 期间
// **把体素三通道的材质换成不引用该 RT 的替身**，pass 后换回。
// 替身材质必须保留 atlas 采样与 packed 语义（否则 RT 内容错 —— 自建那轮的教训）。
import { float, vec3, mix, min, oneMinus, clamp, step, screenUV } from 'three/tsl';
import { REFLECT_MIP_LEVEL } from './water-reflect-config.js';

/** 积水倒影强度上限（mix 有界 ⇒ 不钳白）。 */
export const PUDDLE_REFLECT_STRENGTH = 0.55;

/** 屏幕边缘淡出带（UV 单位）：贴边/出界淡出，避免取到垃圾像素。 */
export const PUDDLE_REFLECT_EDGE_FADE = 0.06;

/**
 * 造「积水真倒影」的混合节点。
 *
 * @param {{reflectTexture: object, puddleW: object, uStrength: object}} deps
 *   `reflectTexture` ocean 交出的 `reflectTexture`（ReflectorNode.clone()）
 *   `puddleW`        积水权重（已含 topGate × uWetPuddleRefl）
 *   `uStrength`      本功能的开关强度 uniform（0 ⇒ 逐位回到 v3.32b）
 * @returns {{rgb: object, k: object}} 倒影颜色与混合权重
 */
export function createPuddleReflectNode({ reflectTexture, puddleW, uStrength }) {
  // ★ 沿用 reflector 默认口径（ocean 同源）：screenUV.flipX()，不用投影矩阵
  const uv = screenUV.flipX();
  reflectTexture.uvNode = uv;
  reflectTexture.levelNode = float(REFLECT_MIP_LEVEL);
  // ⚠️ 显式拆分量：vec3(node) 在 WebGPU 静默输出黑（本仓已记两次）
  const rgb = vec3(reflectTexture.r, reflectTexture.g, reflectTexture.b);

  const edgeD = min(min(uv.x, oneMinus(uv.x)), min(uv.y, oneMinus(uv.y)));
  const edge = clamp(edgeD.div(float(PUDDLE_REFLECT_EDGE_FADE)), float(0), float(1));
  const k = clamp(
    float(PUDDLE_REFLECT_STRENGTH).mul(puddleW).mul(uStrength).mul(edge),
    float(0), float(PUDDLE_REFLECT_STRENGTH),
  );
  return { rgb, k };
}

void [mix, step];