// src/render/zombie-model.js — 丧尸模型版式的唯一权威（原版 Minecraft 人形，32px = 2.0 格）
//
// 为什么住 src/ 而不是 tools/：渲染器**运行时**要用这张表构建 BoxGeometry 与 UV
// （`zombie-renderer.js` 的构造期），所以版式必须能被浏览器 import。
// `tools/zombie-skin-fingerprint.mjs` 只 re-export 它并把内容算进指纹
// （手法同 `tools/cloudland-kit-fingerprint.mjs` re-export `src/gen/structures/cloudland-kit-data.js`，
// 红线 1：同一事实只有一份权威）。
//
// 本模块无 three、无 DOM、无 node 依赖（纯数据 + 纯数组运算），故渲染层与单测都能直接跑。
//
// 数值出处：标准 Minecraft 人形模型（头 8³ / 躯干 8×12×4 / 肢 4×12×4，合计 32px），
// 与用户提供的 The Walking Zombie Pack 的 .bbmodel 骨架逐项一致
// （设计说明 docs/superpowers/specs/2026-11-04-zombie-model-rebuild-design.md §3.1）。
// UV 矩形出处：标准 64×64 皮肤版式（同文档 §3.2 的实测表）。
//
// ⚠️ 素材（.bbmodel）把 12 高的躯干与四肢**切成上下两段**（各 6 高、各有自己的 UV 矩形），
// 因为它的动画要弯肘/膝。本设计合成单段，故 UV 取**标准版式的整段矩形**（一个面的 v 跨度是
// 12 而不是 6）。照抄素材那批两段矩形会让每个面只采到半个纹理 —— 观感是「衣服纹理纵向压扁一半」。
//
// ⚠️ 素材里元素名与纹理区是**错位**的（名为 left_arm 的元素用的是标准右臂纹理区，反之亦然）。
// 本表按**几何位置**分配：`rightArm`（x = +0.375）→ 标准右臂区，`leftArm` → 标准左臂区。

/** 1 源像素 = 1/16 格（原版口径） */
export const PIXEL = 1 / 16;

/** 部件集合与顺序（与 `zombie-renderer.js` 的 `ZOMBIE_PARTS` 同序，测试断言两者一致） */
export const ZOMBIE_MODEL_PARTS = Object.freeze([
  'head', 'body', 'leftArm', 'rightArm', 'leftLeg', 'rightLeg',
]);

/** 皮肤贴图边长（标准 Minecraft 皮肤是 64×64） */
export const SKIN_SIZE = 64;

/**
 * 部件几何（单位：格）。
 *
 * - `size`：盒体尺寸。
 * - `pivot`：部件轴心相对丧尸脚底的本地偏移。**头/躯干是盒中心**（`pivotAtTop = false`），
 *   **臂/腿是关节所在那一端**（`pivotAtTop = true`）—— 臂绕肩、腿绕髋。不把轴心移到顶端，
 *   摆动时肢体整体**平移**而不是扫弧线（走起来像踩滑板）。
 * - `fallbackColor`：无纹理时的退回色（有纹理时六部件都用白底 `0xffffff` 乘纹理色）。
 *
 * 布局（格）：脚底 `y = 0`、腿 [0, 0.75]、躯干 [0.75, 1.5]、头 [1.5, 2.0]，总高恰 **2.0**；
 * 臂外缘 `x = ±0.5`，总宽恰 **1.0**。
 */
export const ZOMBIE_MODEL_DEFS = Object.freeze({
  head: Object.freeze({
    size: Object.freeze([0.5, 0.5, 0.5]),
    pivot: Object.freeze([0, 1.75, 0]),
    pivotAtTop: false,
    fallbackColor: 0x406b30,
  }),
  body: Object.freeze({
    size: Object.freeze([0.5, 0.75, 0.25]),
    pivot: Object.freeze([0, 1.125, 0]),
    pivotAtTop: false,
    fallbackColor: 0x037c7c,
  }),
  leftArm: Object.freeze({
    size: Object.freeze([0.25, 0.75, 0.25]),
    pivot: Object.freeze([-0.375, 1.5, 0]),
    pivotAtTop: true,
    fallbackColor: 0x699058,
  }),
  rightArm: Object.freeze({
    size: Object.freeze([0.25, 0.75, 0.25]),
    pivot: Object.freeze([0.375, 1.5, 0]),
    pivotAtTop: true,
    fallbackColor: 0x699058,
  }),
  leftLeg: Object.freeze({
    size: Object.freeze([0.25, 0.75, 0.25]),
    pivot: Object.freeze([-0.125, 0.75, 0]),
    pivotAtTop: true,
    fallbackColor: 0x322b71,
  }),
  rightLeg: Object.freeze({
    size: Object.freeze([0.25, 0.75, 0.25]),
    pivot: Object.freeze([0.125, 0.75, 0]),
    pivotAtTop: true,
    fallbackColor: 0x322b71,
  }),
});

/** 盒体顶面 y（格）：顶端轴心的部件从 pivot 向下延伸，其顶面就是 pivot */
function boxTopOf(def) { return def.pivot[1] + (def.pivotAtTop ? 0 : def.size[1] / 2); }
/**
 * 盒体底面 y（格）：顶端轴心的部件从 pivot 向下延伸**整个**高度，底面 = pivot − size
 * （⚠️ 不能统一写成 `pivot − size/2`：那是「轴心在盒中心」的口径，用在腿/臂上
 * 会让脚底算出 0.375 而不是 0 —— 实测踩到，被单测的绝对字面量 `脚底须恰为 0` 拓到）。
 */
function boxBottomOf(def) { return def.pivot[1] - (def.pivotAtTop ? def.size[1] : def.size[1] / 2); }

/**
 * 模型总高（格）= 最高盒顶 − 最低盒底。原版口径恰为 **2.0**。
 *
 * **从盒体区间实算，不写字面量** —— 写 `return 2.0` 会让「改小某个部件」时该函数仍报 2.0，
 * 而「脚底恰 0 / 头顶恰 2.0」正是本设计要钉住的不变式。
 * @returns {number}
 */
export function zombieModelHeight() {
  const tops = ZOMBIE_MODEL_PARTS.map((p) => boxTopOf(ZOMBIE_MODEL_DEFS[p]));
  const bottoms = ZOMBIE_MODEL_PARTS.map((p) => boxBottomOf(ZOMBIE_MODEL_DEFS[p]));
  return Math.max(...tops) - Math.min(...bottoms);
}

/**
 * 模型水平跨度（格）= 最外侧臂外缘 × 2。原版口径恰为 **1.0**。
 * @returns {number}
 */
export function zombieModelWidth() {
  let maxAbsX = 0;
  for (const p of ZOMBIE_MODEL_PARTS) {
    const d = ZOMBIE_MODEL_DEFS[p];
    maxAbsX = Math.max(maxAbsX, Math.abs(d.pivot[0]) + d.size[0] / 2);
  }
  return maxAbsX * 2;
}

/**
 * 皮肤 UV 矩形（标准 64×64 版式）。
 *
 * 键是 **`BoxGeometry` 的面序**（每面 4 顶点，顶点下标 = `faceIndex × 4 + k`）：
 * `px` = +X、`nx` = -X、`py` = +Y、`ny` = -Y、`pz` = +Z、`nz` = -Z。
 *
 * 轴映射（与 Minecraft 皮肤版式的习惯一致）：`px→east`、`nx→west`、`py→up`、`ny→down`、
 * `pz→north`（**正脸 —— 眼睛在这个矩形里**）、`nz→south`。
 *
 * 值是 `[u1, v1, u2, v2]`（**源像素**，非归一化）。⚠️ **刻意保持源书写方向**：
 * Minecraft 皮肤版式里 `up`/`down` 习惯逆序写（如 `body.py = [28,16,20,20]`，
 * `u1 = 28 > u2 = 20`），把它规范化成 `min/max` 会让那些面**水平镜像**
 * （观感是「衣服纹理左右反了」），且不报错、格数/指纹全对。
 */
export const ZOMBIE_SKIN_UV = Object.freeze({
  head: Object.freeze({
    px: Object.freeze([0, 8, 8, 16]),    // east  （右/耳朵侧）
    nx: Object.freeze([16, 8, 24, 16]),  // west  （左/耳朵侧）
    py: Object.freeze([8, 0, 16, 8]),    // up
    ny: Object.freeze([16, 0, 24, 8]),   // down
    pz: Object.freeze([8, 8, 16, 16]),   // north （正脸 —— 眼睛在这里）
    nz: Object.freeze([24, 8, 32, 16]),  // south （后脑）
  }),
  // 躯干与四肢取标准 64×64 版式的**整段**矩形（v 跨度 12）。
  // 素材把 12 高切成上下两段（各 6 高），本设计合并成单段 —— 见文件头「切成上下两段」段。
  body: Object.freeze({
    px: Object.freeze([16, 20, 20, 32]),
    nx: Object.freeze([28, 20, 32, 32]),
    py: Object.freeze([28, 16, 20, 20]),  // ⚠️ 反向书写（u1 > u2），不得规范化
    ny: Object.freeze([36, 16, 28, 20]),  // ⚠️ 反向书写
    pz: Object.freeze([20, 20, 28, 32]),
    nz: Object.freeze([32, 20, 40, 32]),
  }),
  rightArm: Object.freeze({
    px: Object.freeze([40, 20, 44, 32]),
    nx: Object.freeze([48, 20, 52, 32]),
    py: Object.freeze([44, 16, 40, 20]),  // ⚠️ 反向
    ny: Object.freeze([48, 16, 44, 20]),  // ⚠️ 反向
    pz: Object.freeze([44, 20, 48, 32]),
    nz: Object.freeze([52, 20, 56, 32]),
  }),
  leftArm: Object.freeze({
    px: Object.freeze([32, 52, 36, 64]),
    nx: Object.freeze([40, 52, 44, 64]),
    py: Object.freeze([36, 48, 32, 52]),  // ⚠️ 反向
    ny: Object.freeze([40, 48, 36, 52]),  // ⚠️ 反向
    pz: Object.freeze([36, 52, 40, 64]),
    nz: Object.freeze([44, 52, 48, 64]),
  }),
  rightLeg: Object.freeze({
    px: Object.freeze([0, 20, 4, 32]),
    nx: Object.freeze([8, 20, 12, 32]),
    py: Object.freeze([8, 16, 4, 20]),    // ⚠️ 反向
    ny: Object.freeze([12, 16, 8, 20]),   // ⚠️ 反向
    pz: Object.freeze([4, 20, 8, 32]),
    nz: Object.freeze([12, 20, 16, 32]),
  }),
  leftLeg: Object.freeze({
    px: Object.freeze([16, 52, 20, 64]),
    nx: Object.freeze([24, 52, 28, 64]),
    py: Object.freeze([24, 48, 20, 52]),  // ⚠️ 反向
    ny: Object.freeze([28, 48, 24, 52]),  // ⚠️ 反向
    pz: Object.freeze([20, 52, 24, 64]),
    nz: Object.freeze([28, 52, 32, 64]),
  }),
});

/**
 * 眼睛在**正脸 UV 矩形内**的相对位置（源像素，相对矩形左上角）。
 *
 * 权威在这里（`src/`）而不是 `tools/`：Tier 4 fixture 要按它把「眼睛在哪」换算成世界坐标
 * 才能取到样（自己猜位置会让「眼睛画错地方」类注入测不出来）。烘焙脚本经
 * `tools/zombie-skin-fingerprint.mjs` re-export 消费同一份（红线 1）。
 *
 * 正脸矩形 = `ZOMBIE_SKIN_UV.head.pz` = `[8, 8, 16, 16]`（8×8 像素）。
 * 两只眼水平镜像：`8 - 1 - 2 = 5`。
 */
export const SKIN_EYES = Object.freeze([
  Object.freeze({ dx: 1, dy: 3, w: 2, h: 1 }), // 左眼（从矩形左上角起算）
  Object.freeze({ dx: 5, dy: 3, w: 2, h: 1 }), // 右眼（水平镜像）
]);

/**
 * `BoxGeometry` 的面序名（下标即 faceIndex）。
 *
 * 出处：`three.core.js` 的 `BoxGeometry` 依次 build `+X`、`-X`、`+Y`、`-Y`、`+Z`、`-Z`，
 * 每面 4 个顶点 —— 故 `+Z`（正面）恒是顶点 `16..19`（既有常量 `HEAD_FRONT_VERTICES` 就是它）。
 */
export const ZOMBIE_UV_FACES = Object.freeze(['px', 'nx', 'py', 'ny', 'pz', 'nz']);

/**
 * 把一个面的默认 UV（`u, v ∈ [0,1]`）重映射到皮肤矩形 `rect`（源像素）。
 *
 * **支持反向矩形**（`u1 > u0` / `v1 > v0`）：公式 `u1 + u*(u2-u1)` 在 `u2 < u1` 时
 * 自然得到递减映射 —— 这正是 Minecraft 皮肤版式要的镜像效果。
 *
 * ## v 方向：两套坐标系天然相反，必须翻一次
 *
 * - 皮肤矩形按**图片像素**写（左上角原点）⇒ 矩形**顶边**是 `v1`（小值）。
 * - `BoxGeometry` 的侧面（含 `+Z`）`vdir = -1` ⇒ **世界顶部**的顶点 `v = 1`。
 *
 * 两者方向相反 ⇒ 映射必须把 `v = 1` 对到矩形顶边、`v = 0` 对到矩形底边。
 * **漏这一次翻转的形态是「脸上下颠倒」**：眼睛跑到下面、嘴跑到上面
 * （用户 2026-11-04 实玩报告）。它比「整个皮肤错位」隐蔽得多 —— 格数、指纹、
 * 三区色距、眼睛/红闪/摆动全部正常，因为那些判据不看上下。
 *
 * ## 最后还要按 `flipY` 折算
 *
 * three 的 `TextureLoader` 默认 `flipY = true`（v=0 对应图片**底部**），
 * 而 `DataTexture` 默认 `false`。上面算出的「图片行号比例」要按这个再转成纹理坐标。
 *
 * ⚠️ **两处翻转不得互相抵消**：早期版本只做了 `flipY` 那一层（等价于只翻一次但翻错了方向），
 * 结果整套皮肤采样正常、**只有面内上下颠倒**。故本函数用显式的两层：
 * ① 世界顶 ↔ 矩形顶（不再依赖 vdir 推导）；② `flipY` 折算。
 *
 * @param {{getX:(i:number)=>number, getY:(i:number)=>number,
 *          setXY:(i:number,x:number,y:number)=>void, needsUpdate:boolean}} uv
 *   `geometry.getAttribute('uv')`（BufferAttribute 的兼容形状）
 * @param {number} faceIndex `BoxGeometry` 面序（0=+X, 1=-X, 2=+Y, 3=-Y, 4=+Z, 5=-Z）
 * @param {readonly number[]} rect `[u1, v1, u2, v2]`（源像素，左上角原点）
 * @param {boolean} [flipY=true] 纹理是否 flipY（`TextureLoader` 默认 true，`DataTexture` 默认 false）
 */
export function remapFaceUV(uv, faceIndex, rect, flipY = true) {
  const [u1, v1, u2, v2] = rect;
  for (let k = 0; k < 4; k++) {
    const i = faceIndex * 4 + k;
    const u = uv.getX(i);
    const v = uv.getY(i);
    const uOut = (u1 + u * (u2 - u1)) / SKIN_SIZE;
    // ① 面内 v（世界顶 = 1）→ 图片行号比例（矩形顶边 = 0）
    const rowFrac = 1 - v;
    // ② 行号比例 → 矩形内像素 → 纹理坐标（按 flipY 折算）
    const imgRow = (v1 + rowFrac * (v2 - v1)) / SKIN_SIZE;
    uv.setXY(i, uOut, flipY ? 1 - imgRow : imgRow);
  }
  uv.needsUpdate = true;
}
