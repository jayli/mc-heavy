// tools/citadel-box-uv.mjs — Citadel（Java）盒模型的**面 → UV 角映射**唯一权威
//
// ## 为什么需要独立一份，不能复用 bake-ignis 的 `boxUVRects`
//
// 焰魔素材是 **Bedrock 附加包**，守卫素材是 **Java + Citadel**。两者的 box UV 铺开
// **不是同一套布局**：面与源矩形的对应关系不同，同一面内四个角的 UV 分配也不同。
// 照抄 Bedrock 表的形态（2026-11-11 实测）：**576 个角里 563 个 UV 错**，
// 而骨骼数 / 盒数 / 顶点数 / 索引数 / UV 值域 / 指纹**全部通过** —— 只有画面能看出来
// （躯干亮面朝下、护甲渐变上下颠倒、侧面贴图整体错位）。
//
// ## 权威来源
//
// `com.github.alexthe666.citadel.client.model.basic.BasicModelPart.ModelBox`
// （Citadel master，1.19.2 用的同一份）。逐字摘录关键部分：
//
//   float f = x + width, f1 = y + height, f2 = z + depth;
//   x -= deltaX; y -= deltaY; z -= deltaZ;
//   f += deltaX; f1 += deltaY; f2 += deltaZ;
//   if (mirorIn) { swap(x, f); }
//
//   8 个角（**按声明顺序**编号 V0..V7 —— 源码变量名后缀与顺序差一，别按名字读）：
//     V0=(x,y,z)  V1=(f,y,z)  V2=(f,f1,z)  V3=(x,f1,z)
//     V4=(x,y,f2) V5=(f,y,f2) V6=(f,f1,f2) V7=(x,f1,f2)
//
//   quads[0] EAST  V{5,1,2,6}  uv(f6, f11, f8, f12)
//   quads[1] WEST  V{0,4,7,3}  uv(f4, f11, f5, f12)
//   quads[2] DOWN  V{5,4,0,1}  uv(f5, f10, f6, f11)
//   quads[3] UP    V{2,3,7,6}  uv(f6, f11, f7, f10)
//   quads[4] NORTH V{1,0,3,2}  uv(f5, f11, f6, f12)
//   quads[5] SOUTH V{4,5,6,7}  uv(f8, f11, f9, f12)
//
//   TexturedQuad 的 UV 分配：pos[0]=(u2,v1) pos[1]=(u1,v1) pos[2]=(u1,v2) pos[3]=(u2,v2)
//   mirror ⇒ **整个 {position, uv} 元素**首尾对调（0↔3、1↔2）
//
// ⚠️⚠️⚠️ **mirror 的对调搬的是整个元素，不是「只换 UV」**（2026-11-11 实测）：
// 源码 `positionsIn[j] = positionsIn[i-1-j]` 搬的是 `PositionTextureVertex` 引用，
// 而该对象**同时持有 position 与 uv** ⇒ 对调后「角位置 ↔ UV」的**配对不变**，
// 变的只是数组顺序（= 三角形绕序）。
// ⇒ 对「按角位置查 UV」的本仓烘焙而言，**mirror 的 UV 对调是恒等操作**；
//    真正影响 UV 的是前面那个 `swap(x, f)`（它改了角的空间位置）。
// 只对调 UV 而不动位置（本次第一版修法）会把 7 个 mirror 盒的贴图上下翻转（168 个角）。
//
// ⚠️ **Java 的 y 向下**：`Direction.DOWN` 是 y **小**的那面（`f10 = v` 一侧），
// 本仓顶点做 `y → −y` 后它变成世界 **+Y**。`UP` 反之。这一条是「亮面朝上还是朝下」的开关。
//
// ⚠️ **`quads[3]` 的 v1 > v2**（`f11` 在前、`f10` 在后）—— 源码就是这么写的，
// 不是笔误，不要「顺手修正」成升序。
//
// ⚠️ 本表由 `tools/citadel-quads.json`（程序化提取自 Citadel 源码）核对过，
// 手抄索引极易出错（本次调查连错 5 版）。改它之前先跑 `test-guardian-uv` 的逐角用例。

/** BoxGeometry 的面序（three 源码）：+X, −X, +Y, −Y, +Z, −Z */
export const BOX_FACE_ORDER = Object.freeze(['+X', '-X', '+Y', '-Y', '+Z', '-Z']);

/**
 * Citadel 的六个面：顶点索引（V0..V7）+ UV 边界（用 f4..f12 的名字，见下方 `uvBounds`）。
 *
 * 数组顺序**已对齐 `BOX_FACE_ORDER`**，不是 Citadel 的 quads slot 顺序：
 *   +X ← EAST(slot0)   −X ← WEST(slot1)
 *   +Y ← DOWN(slot2)   −Y ← UP(slot3)      ← Java y 向下，翻转后对调
 *   +Z ← SOUTH(slot5)  −Z ← NORTH(slot4)
 */
export const CITADEL_FACES = Object.freeze([
  Object.freeze({ face: '+X', vi: Object.freeze([5, 1, 2, 6]), uv: Object.freeze(['f6', 'f11', 'f8', 'f12']) }),
  Object.freeze({ face: '-X', vi: Object.freeze([0, 4, 7, 3]), uv: Object.freeze(['f4', 'f11', 'f5', 'f12']) }),
  Object.freeze({ face: '+Y', vi: Object.freeze([5, 4, 0, 1]), uv: Object.freeze(['f5', 'f10', 'f6', 'f11']) }),
  Object.freeze({ face: '-Y', vi: Object.freeze([2, 3, 7, 6]), uv: Object.freeze(['f6', 'f11', 'f7', 'f10']) }),
  Object.freeze({ face: '+Z', vi: Object.freeze([4, 5, 6, 7]), uv: Object.freeze(['f8', 'f11', 'f9', 'f12']) }),
  Object.freeze({ face: '-Z', vi: Object.freeze([1, 0, 3, 2]), uv: Object.freeze(['f5', 'f11', 'f6', 'f12']) }),
]);

/**
 * 面的 outward 法线（本仓坐标系，y 已翻转）—— **仅适用于非 mirror 盒**。
 *
 * ⚠️⚠️ **mirror 盒不能用这张表**（2026-11-11 实测，80 个角失配）：
 * Citadel 的 `swap(x, f)` 让 `x > f`，于是标为 `EAST(+X)` 的那四个角实际落在
 * **x 最小**的一侧 ⇒ 面标签与几何位置脱节。法线必须**由角位置推**（见 `faceNormalOf`）。
 */
export const CITADEL_FACE_NORMALS = Object.freeze({
  '+X': Object.freeze([1, 0, 0]),
  '-X': Object.freeze([-1, 0, 0]),
  '+Y': Object.freeze([0, 1, 0]),
  '-Y': Object.freeze([0, -1, 0]),
  '+Z': Object.freeze([0, 0, 1]),
  '-Z': Object.freeze([0, 0, -1]),
});

/**
 * UV 边界（源像素）。`u,v` = `setTextureOffset`，`w,h,d` = `addBox` 的 width/height/depth。
 * 名字与 Citadel 源码的 f4..f12 一一对应，便于逐字核对。
 */
export function uvBounds(u, v, w, h, d) {
  return {
    f4: u,
    f5: u + d,
    f6: u + d + w,
    f7: u + d + w + w,
    f8: u + d + w + d,
    f9: u + d + w + d + w,
    f10: v,
    f11: v + d,
    f12: v + d + h,
  };
}

/**
 * 一个盒的 8 个角（**Java 空间**，px，y 向下；已含 inflate 与 mirror 的 swap）。
 *
 * @param {{origin:number[], size:number[], inflate?:number, mirror?:boolean}} cube
 * @returns {number[][]} V0..V7
 */
export function citadelCorners(cube) {
  const inf = cube.inflate || 0;
  const [w, h, d] = cube.size;
  let x = cube.origin[0] - inf;
  let f = cube.origin[0] + w + inf;
  const y = cube.origin[1] - inf;
  const f1 = cube.origin[1] + h + inf;
  const z = cube.origin[2] - inf;
  const f2 = cube.origin[2] + d + inf;
  // ⚠️ mirror 在源码里是 **swap(x, f)**：它改变角的空间位置（几何镜像），
  // 这才是 mirror 影响 UV 的唯一途径（TexturedQuad 里的对调搬整个元素，配对不变）。
  if (cube.mirror) { const t = f; f = x; x = t; }
  return [
    [x, y, z], [f, y, z], [f, f1, z], [x, f1, z],
    [x, y, f2], [f, y, f2], [f, f1, f2], [x, f1, f2],
  ];
}

/**
 * 由四个角位置推面的 outward 法线（**mirror 盒必须走这里**）。
 *
 * 做法：找出四角中取值恒定的那个轴（面所在轴），再取「面中心 − 盒中心」的符号。
 * ⚠️ 恒定判定要用**容差**：浮点除法后同一面的四角可能差 1e-17，
 * 逐位相等会让某些面找不到恒定轴。
 *
 * @param {number[][]} pts 四个角（本仓坐标，y 已翻）
 * @param {number[]} boxCenter 盒中心（同坐标系）
 * @returns {number[]}
 */
export function faceNormalOf(pts, boxCenter) {
  let axis = -1;
  for (let k = 0; k < 3; k++) {
    const vals = pts.map((p) => p[k]);
    if (Math.max(...vals) - Math.min(...vals) < 1e-9) { axis = k; break; }
  }
  if (axis < 0) throw new Error('[citadel-box-uv] 面法线推不出（四角不共面）');
  const center = pts.reduce((s, p) => s + p[axis], 0) / pts.length;
  const n = [0, 0, 0];
  n[axis] = Math.sign(center - boxCenter[axis]) || 1;
  return n;
}

/**
 * 一个盒的六面 UV 角表（**源像素**，v 以图像左上为原点）。
 *
 * 返回顺序对齐 `BOX_FACE_ORDER`；每面 4 个 `{vi, u, v}`，`vi` 是 `citadelCorners` 的下标。
 * 调用方负责 px→格、y 取反、以及 `v → 1 − v/textureSize` 的 flipY 换算。
 *
 * @param {{origin:number[], size:number[], uv:number[], inflate?:number, mirror?:boolean}} cube
 */
export function citadelFaceUVs(cube) {
  const bounds = uvBounds(cube.uv[0], cube.uv[1], cube.size[0], cube.size[1], cube.size[2]);
  const corners = citadelCorners(cube);
  const inf = cube.inflate || 0;
  const [w, h, d] = cube.size;
  // 盒中心（本仓坐标：y 取反、px→格由调用方做，这里保持 px 与 corners 同口径）
  const boxCenter = [
    (cube.origin[0] + w / 2),
    (cube.origin[1] + h / 2),
    (cube.origin[2] + d / 2),
  ];
  void inf;
  return CITADEL_FACES.map((spec) => {
    const [u1, v1, u2, v2] = spec.uv.map((k) => bounds[k]);
    // TexturedQuad：pos[0]=(u2,v1) [1]=(u1,v1) [2]=(u1,v2) [3]=(u2,v2)
    const uv = [[u2, v1], [u1, v1], [u1, v2], [u2, v2]];
    // ⚠️⚠️ **mirror 不在这里对调 UV**：源码对调的是整个 {position, uv} 元素，
    // 「角位置 ↔ UV」的配对不变（只改绕序）。mirror 对 UV 的真正影响已由
    // `citadelCorners` 的 `swap(x, f)` 体现；在这里再对调一次 = 上下翻转。
    const pts = spec.vi.map((vi) => corners[vi]);
    // ⚠️ 法线由**角位置**推，不查静态表 —— mirror 盒的面标签与位置脱节（见上）。
    // 这里在 Java 空间推（y 向下），调用方翻 y 时法线的 y 也要翻。
    const normalJava = faceNormalOf(pts, boxCenter);
    return {
      face: spec.face,
      normal: [normalJava[0], -normalJava[1], normalJava[2]],
      corners: spec.vi.map((vi, k) => ({ vi, u: uv[k][0], v: uv[k][1] })),
    };
  });
}