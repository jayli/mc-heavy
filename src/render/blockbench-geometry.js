// src/render/blockbench-geometry.js — Blockbench「逐面 UV」item 模型的纯数据解析（three-free）
//
// **为什么单独一个 three-free 模块**：剑体模型（`assets/models/weapons/sword/sword.json`）是
// Blockbench 导出的 Java item model（elements + 每面独立 uv 矩形）。把「JSON → 元素盒 + 每面
// UV 矩形」的解析与 UV 数学放在 three-free 模块里，Node 侧门禁与浏览器内单测都能直接对账
// （红线 8 同构口径），three 依赖只剩 `blockbench-model-loader.js` 里薄薄一层装配。
//
// **几何不自己推顶点**：装配层用 three `BoxGeometry` 逐元素建盒（与 `zombie-renderer.js` /
// `turret-renderer.js` 同一手法），绕序与法线由 three 保证。曾经手写过四角点 + 三角形绕序，
// 实测 6 面里有 4 面法线朝内（east/west/up/down 绕序反了）—— 那种缺陷在「模型能看见」的
// 判据下不报错，只在光照/背面剔除下现形。
//
// ## UV 口径（实测定，勿凭直觉改）
//
// ① **归一化 = uv / 16**（与 `texture_size` 无关）。实测交叉验证两个模型：dragonrend
//    （texture_size 64）与 ancientblade（texture_size 32），`uv/16` 的足迹都精确覆盖贴图的
//    不透明美术区（dragonrend 足迹 x[0,24]y[0,64] ≈ 不透明 bbox x[0,23]y[0,54]；ancientblade
//    足迹 x[0,19]y[0,19] ≈ bbox x[0,18]y[0,18]）。若按「uv = 像素」只覆盖 25%~50% 美术区，是错的。
// ② **v 方向翻一次**：Blockbench 的 uv v=0 在图片**顶部**（图像坐标），而 three `TextureLoader`
//    默认 `flipY=true`（v=0 在图片**底部**）。故 `three_v = 1 - v_blockbench/16`。漏翻的形态是
//    「贴图上下颠倒」（AGENTS.md 皮肤矩形同一陷阱）。
// ③ **面的 `rotation: 180`**：把该面的 UV 矩形四角对调（原地转 180°）。本素材只出现 0/180，
//    90/270 会**抛错**而不是静默错（用不到，但要挡住未来的素材）。

/** 模型单位 → 方块单位（Minecraft 惯例：16 模型单位 = 1 格） */
export const BLOCKBENCH_UNITS_PER_BLOCK = 16;

/**
 * UV 归一化的分母。**恒为 16，不是 `texture_size`**（见文件头 UV 口径 ①，两模型实测交叉验证）。
 */
export const BLOCKBENCH_UV_DIVISOR = 16;

/**
 * three `BoxGeometry` 的面序 → Blockbench 面名。
 *
 * 出处：`three.core.js` 的 `BoxGeometry` 依次 build `+X, -X, +Y, -Y, +Z, -Z`
 * （与 `zombie-model.js` 的 `ZOMBIE_UV_FACES` 同一口径，那边写的是轴名，这里写 MC 面名）。
 * ⚠️ 改这个映射会让全部面的贴图张冠李戴，而「模型能看见」的判据抓不到。
 */
export const BOX_FACE_NAMES = Object.freeze(['east', 'west', 'up', 'down', 'south', 'north']);

/**
 * `BoxGeometry` 每个面 4 个顶点的 (u,v) 布局（实测，6 个面完全一致）：
 * `v0=(0,1) v1=(1,1) v2=(0,0) v3=(1,0)`。
 *
 * 故 UV 重映射只需把「矩形左上/右上/左下/右下」按这个次序写进去，不必读 position 推朝向。
 */
export const BOX_FACE_VERT_UV = Object.freeze([[0, 1], [1, 1], [0, 0], [1, 0]]);

/**
 * 解析一个 Blockbench item model 的元素列表（纯数据，无 three）。
 *
 * 返回的每个元素含：
 *  - `size` / `center`：**方块单位**（模型单位 / 16），center 是盒中心
 *  - `rotation`：`{angleDeg, axis, origin}`（origin 也是方块单位）；无旋转时 `angleDeg = 0`
 *  - `faces`：`{面名: {rect, uvRotation}}`，`rect` = **three flipY 口径的归一化矩形**
 *    `[uLeft, vTop, uRight, vBottom]`（v 已按 `1 - v/16` 折算，故 vTop > vBottom）
 *
 * @param {object} model Blockbench model JSON（含 `elements`）
 * @returns {Array<{size:number[], center:number[], rotation:{angleDeg:number,axis:string,origin:number[]},
 *                  faces: Object<string,{rect:number[], uvRotation:number}>}>}
 */
export function parseBlockbenchElements(model) {
  if (!model || !Array.isArray(model.elements)) {
    throw new Error('blockbench-geometry: model.elements 缺失');
  }
  const U = BLOCKBENCH_UNITS_PER_BLOCK;
  const out = [];
  for (const el of model.elements) {
    if (!Array.isArray(el.from) || !Array.isArray(el.to)) {
      throw new Error('blockbench-geometry: element 缺 from/to');
    }
    const [x0, y0, z0] = el.from;
    const [x1, y1, z1] = el.to;
    const rot = el.rotation || null;
    const angleDeg = rot ? (rot.angle || 0) : 0;
    const axis = rot && rot.axis ? rot.axis : 'y';
    // origin 缺省 = 盒中心（Blockbench 惯例）
    const origin = rot && Array.isArray(rot.origin)
      ? [rot.origin[0] / U, rot.origin[1] / U, rot.origin[2] / U]
      : [(x0 + x1) / 2 / U, (y0 + y1) / 2 / U, (z0 + z1) / 2 / U];
    const faces = {};
    for (const name of Object.keys(el.faces || {})) {
      const face = el.faces[name];
      if (!face || !Array.isArray(face.uv)) continue;
      const uvRotation = face.rotation || 0;
      if (uvRotation !== 0 && uvRotation !== 180) {
        throw new Error(`blockbench-geometry: 不支持的面 UV 旋转 ${uvRotation}（面 ${name}）`);
      }
      faces[name] = { rect: normalizeUvRect(face.uv), uvRotation };
    }
    out.push({
      size: [Math.abs(x1 - x0) / U, Math.abs(y1 - y0) / U, Math.abs(z1 - z0) / U],
      center: [(x0 + x1) / 2 / U, (y0 + y1) / 2 / U, (z0 + z1) / 2 / U],
      rotation: { angleDeg, axis, origin },
      faces,
    });
  }
  return out;
}

/**
 * Blockbench uv 矩形 → three（`flipY=true`）口径的归一化矩形。
 *
 * @param {number[]} uv `[u1, v1, u2, v2]`（Blockbench 单位，v=0 在图片顶部）
 * @returns {number[]} `[uLeft, vTop, uRight, vBottom]`（归一化，v=0 在图片底部 ⇒ vTop > vBottom）
 */
export function normalizeUvRect(uv) {
  const D = BLOCKBENCH_UV_DIVISOR;
  const [u1, v1, u2, v2] = uv;
  return [u1 / D, 1 - v1 / D, u2 / D, 1 - v2 / D];
}

/**
 * 元素列表的包围盒（方块单位，**不含元素旋转** —— 旋转后的实际范围由装配层用 three
 * `Box3.setFromObject` 量，那才是权威；本函数只用于 Node 侧对账与诊断）。
 * @param {Array<{size:number[], center:number[]}>} elements
 * @returns {{min:number[], max:number[], size:number[]}}
 */
export function elementsBounds(elements) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const el of elements) {
    for (let i = 0; i < 3; i++) {
      const half = el.size[i] / 2;
      const lo = el.center[i] - half;
      const hi = el.center[i] + half;
      if (lo < min[i]) min[i] = lo;
      if (hi > max[i]) max[i] = hi;
    }
  }
  return { min, max, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] };
}
