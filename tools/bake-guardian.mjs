#!/usr/bin/env node
// tools/bake-guardian.mjs — 末影守卫（Ender Guardian）烘焙：Java 模型源码 → 本仓产物
//
// 用法：npm run guardian
// 输入：assets/guardian/src/{ModelEnder_Guardian.java, ender_guardian.png, ender_guardian_layer.png}
// 产物：assets/guardian/{guardian.json, guardian.png, guardian.meta.json}（**不要手改**）
//
// ⚠️ **烘焙 = 数据格式转换，不产生新美术资源**：不新增方块、不新增贴图，只把 Java 的
// 模型/动画声明转成运行期直接消费的扁平数组，并把眼睛层合成进主贴图（单贴图单材质）。
//
// ## 与 bake-ignis.mjs 的三处根本差异（别照搬）
//
// ### ① 顶点坐标系：口径 A「仅翻转 + 局部顶点」（spec §2.2.1）
//
// Java `addBox` 的 origin 是**骨骼局部**坐标；Bedrock 的 cube origin 是**绝对模型**坐标。
// 两者差一个 `T(绝对pivot)`。实测例：`left_leg` 相对 pos `(11,−22,0)`、绝对 pivot `(11,2,0)`、
// cube origin `(−4,0,−8)`。
//
// 本仓取口径 A：顶点 = `BoxGeometry(size + 2·inflate)` 平移到 `origin + size/2`，
// **然后整体 `y → −y`**（x/z 不变），**不加绝对 pivot**。
// ⇒ `localPosition = [pos.x/16, −pos.y/16, pos.z/16]`、`pivot` 恒 `[0,0,0]`。
// ⇒ 渲染器每帧 `bone.position = localPosition + delta.pos`，
//    **不是**焰魔的 `pivot − R_current·pivot + delta`（那是绝对口径的公式）。
// 加错 pivot 的形态：所有部件挤到模型原点附近；忘了 y 取反的形态：整体上下颠倒。
// 两种形态下骨骼数/盒数/顶点数/指纹**全对**。
//
// ### ② 旋转约定：与焰魔**同一条**（`bedrockRotation`，不得改）
//
// `R = Rz(−θz)·Ry(+θy)·Rx(−θx)`，关键帧与 bind 欧拉角**逐轴相加**。
// ⚠️ Java `setRotationAngle` 给的是**弧度**，而 `bedrockRotation` 收**度** ⇒ 传参前 ×180/π。
// 这是焰魔 v2.58 用「蓄力向身后抡接近 180°」换来的实测结论，标准右手系 `Euler('XYZ')` 是错的。
//
// ### ③ 眼睛层合成：100% 重叠的叠加层（不是焰魔盾那种补空白）
//
// 见 `compositeLayerTexture` 的注释 —— 阈值必须 `alpha > 0` 且强制 `alpha = 255`。
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import * as THREE from '../vendor/three/three.core.js';
import {
  GUARDIAN_MODEL_SRC, GUARDIAN_TEX_SRC, GUARDIAN_LAYER_TEX_SRC,
  GUARDIAN_JSON, GUARDIAN_PNG, GUARDIAN_META,
  GUARDIAN_BAKE_PARAMS, GUARDIAN_METRICS, GUARDIAN_ANIM_SOURCES,
  guardianInputFingerprint,
} from './guardian-fingerprint.mjs';
import { parseBones, parseAnimation, evalKeyframes } from './java-model-parse.mjs';
import { citadelFaceUVs, citadelCorners } from './citadel-box-uv.mjs';

const { scale, pxPerBlock, textureSize, animFps } = GUARDIAN_BAKE_PARAMS;
/** px → 格（已含 scale 倍）。运行时不再乘 scale */
const PX2BLOCK = scale / pxPerBlock;
const DEG = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

function fail(msg) { throw new Error(`[守卫烘焙] ${msg}`); }

/**
 * Java 骨骼旋转（**度**，欧拉三元组）→ 四元数。**本脚本唯一的「角度 → 旋转」入口。**
 *
 * `R = Rz(−θz) · Ry(+θy) · Rx(−θx)`：three 的 `'ZYX'` 欧拉序即 `Rz·Ry·Rx`，
 * X、Z 取反是 Java（y 向下）→ 本仓几何（y 向上）的换算。
 *
 * ⚠️ 与 `bake-ignis.mjs` 的 `bedrockRotation` **逐字相同** —— 两处都不得改成 `Euler('XYZ')`。
 */
function bedrockRotation(rxDeg, ryDeg, rzDeg) {
  return new THREE.Quaternion().setFromEuler(
    new THREE.Euler(-rxDeg * DEG, ryDeg * DEG, -rzDeg * DEG, 'ZYX'));
}

/** 收**弧度**的薄包装（Java `setRotationAngle` / `Math.toRadians` 都是弧度） */
const rotationRad = (r) => bedrockRotation(r[0] * RAD2DEG, r[1] * RAD2DEG, r[2] * RAD2DEG);

/**
 * 某骨骼在一帧的「增量四元数」：`delta = bind⁻¹ · 总旋转`。
 * 总旋转 = `bedrockRotation(bind欧拉 + 关键帧欧拉)` —— **欧拉角域逐轴相加**，不是四元数复合。
 */
function deltaRotation(bindQ, bindRad, animRad) {
  const total = rotationRad([
    bindRad[0] + animRad[0], bindRad[1] + animRad[1], bindRad[2] + animRad[2],
  ]);
  return bindQ.clone().invert().multiply(total);
}

/**
 * Minecraft 标准 box UV 铺开 —— **Citadel（Java）口径**，权威在 `citadel-box-uv.mjs`。
 *
 * ⚠️⚠️ **不得照搬 `bake-ignis.mjs` 的 `boxUVRects`**（2026-11-11 实测缺陷）：
 * 焰魔素材是 **Bedrock 附加包**，守卫是 **Java + Citadel**，两者的 box UV 铺开
 * **不是同一套布局**：面与源矩形的对应关系不同，同一面内四角的 UV 分配也不同。
 * 照搬的形态：**576 个角里 563 个 UV 错**，而骨骼数/盒数/顶点数/索引数/UV 值域/指纹
 * **全部通过** —— 只有画面能看出来（躯干亮面朝下、护甲渐变上下颠倒、侧面整体错位）。
 *
 * 具体差异（以 upperbody `uv(0,0) size 40×32×20` 为例，源像素 u 区间）：
 *   面    Bedrock（错）        Citadel（对）
 *   +X    [60,80] 但 v 反     [60,80]
 *   −X    [0,20]  但 v 反     [0,20]
 *   +Y    [60,100]（砖纹）    [20,60]（纯色暗块）  ← 上下颠倒
 *   −Y    [20,60]             [60,100]
 *   +Z    [80,120] 但 180°旋   [80,120]
 *   −Z    [20,60]  但 180°旋   [20,60]
 *
 * 本函数不再返回「矩形」而是直接返回**逐角 UV**：矩形不足以定 UV，
 * 还要知道哪个角配哪个 uv（那正是 Bedrock 与 Citadel 分歧最大的地方）。
 *
 * @returns {Array<{face:string, normal:number[], corners:Array<{vi:number,u:number,v:number}>}>}
 *   顺序对齐 `BoxGeometry` 面序 [+X,−X,+Y,−Y,+Z,−Z]；u/v 是**源像素**（图像左上原点）。
 */
function boxFaceUVs(cube) {
  return citadelFaceUVs(cube);
}

/**
 * 把眼睛层叠到主贴图上（烘焙期合成，不新增运行时贴图）。
 *
 * ## 与焰魔盾的根本差异
 *
 * 焰魔盾是「两块不相交的 UV 区」（盾像素落在主图的全透明区），所以那边有
 * `assertNoBodyPollution` + 零重叠预检。**守卫的眼睛层是原版 `RenderType.eyes` 的叠加层**，
 * 本就画在身体上：实测主图不透明 23,752、layer 非透明 2,749、**交集 2,749（100% 重叠）**、
 * layer 落在主图透明区 **0**。
 * ⇒ **不得写零重叠断言**（那会在正确实现上报错）。
 *
 * ## 合成规则（逐像素）
 *
 * | layer alpha | 输出 |
 * |---|---|
 * | > 0 | 取 layer 的 RGB，**alpha 强制 255** |
 * | = 0 | 保留主贴图原像素 |
 *
 * ⚠️⚠️⚠️ **阈值 `> 0` 而不是焰魔的 `> 128`，且必须把 alpha 抬到 255**（实测）：
 * layer 的 alpha 只有 `{0: 62787, 1: 145, 255: 2604}`，而 **alpha = 1 的那 145 个像素恰好
 * 就是全部真正改色的像素**（alpha = 255 的 2604 个与主图 RGB 逐位相同）。双重陷阱：
 *   ① 用 `> 128` 筛 ⇒ 丢掉全部 145 个改色像素，合成退化成**空操作**；
 *   ② 原样拷 alpha = 1 ⇒ 渲染器 `alphaTest: 0.5` 在片元阶段 discard，效果**等同于没合成**。
 * 两种形态下骨骼数/顶点数/UV/指纹全绿 —— 只有内容级判据拦得住。
 *
 * @returns {{painted:number, changed:number}} 覆盖像素数 / 其中真正改色的像素数
 */
function compositeLayerTexture(base, layer) {
  if (base.width !== layer.width || base.height !== layer.height) {
    fail(`眼睛层尺寸 ${layer.width}×${layer.height} ≠ 主贴图 ${base.width}×${base.height}`);
  }
  let painted = 0, changed = 0;
  for (let i = 0; i < base.data.length; i += 4) {
    if (layer.data[i + 3] === 0) continue;
    const diff = base.data[i] !== layer.data[i]
      || base.data[i + 1] !== layer.data[i + 1]
      || base.data[i + 2] !== layer.data[i + 2]
      || base.data[i + 3] !== 255;
    base.data[i] = layer.data[i];
    base.data[i + 1] = layer.data[i + 1];
    base.data[i + 2] = layer.data[i + 2];
    base.data[i + 3] = 255;   // ⚠️ 强制不透明，见上方陷阱②
    painted++;
    if (diff) changed++;
  }
  return { painted, changed };
}

// ---- 4×4 行主序矩阵（脚底扫描用；与渲染器同一口径）----
const mul4 = (a, b) => {
  const o = new Array(16);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[r * 4 + k] * b[k * 4 + c];
    o[r * 4 + c] = s;
  }
  return o;
};
const trMat = (q, t) => {
  const [x, y, z, w] = q;
  const xx = x * x, yy = y * y, zz = z * z;
  const xy = x * y, xz = x * z, yz = y * z;
  const wx = w * x, wy = w * y, wz = w * z;
  return [
    1 - 2 * (yy + zz), 2 * (xy - wz), 2 * (xz + wy), t[0],
    2 * (xy + wz), 1 - 2 * (xx + zz), 2 * (yz - wx), t[1],
    2 * (xz - wy), 2 * (yz + wx), 1 - 2 * (xx + yy), t[2],
    0, 0, 0, 1,
  ];
};
const apply4 = (m, p) => [
  m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3],
  m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7],
  m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11],
];
const qmulLocal = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];

function main() {
  const text = fs.readFileSync(GUARDIAN_MODEL_SRC, 'utf8');
  const bonesRaw = parseBones(text, 'ModelEnder_Guardian');
  if (bonesRaw.size !== GUARDIAN_METRICS.boneCount) {
    fail(`骨骼数 ${bonesRaw.size} ≠ 期望 ${GUARDIAN_METRICS.boneCount}`);
  }
  const names = [...bonesRaw.keys()];
  const boneIndex = new Map(names.map((n, i) => [n, i]));

  // 拓扑校验：父必须先出现（否则下面的世界矩阵累乘会读到 undefined）
  for (let i = 0; i < names.length; i++) {
    const p = bonesRaw.get(names[i]).parent;
    if (p === null) continue;
    const pi = boneIndex.get(p);
    if (pi === undefined) fail(`骨骼 ${names[i]} 的父 "${p}" 不存在`);
    if (pi >= i) fail(`骨骼 ${names[i]} 的父 "${p}" 下标 ${pi} 不早于自身 ${i}`);
  }
  if (names.filter((n) => bonesRaw.get(n).parent === null).length !== 1) {
    fail('根骨骼数不为 1');
  }

  // ==================== 1. 骨骼层级（口径 A）====================
  const bindRad = names.map((n) => bonesRaw.get(n).rot);
  const bindQuat = bindRad.map(rotationRad);
  const bones = names.map((n, i) => {
    const b = bonesRaw.get(n);
    const q = bindQuat[i];
    return {
      name: n,
      parentIndex: b.parent === null ? -1 : boneIndex.get(b.parent),
      // ⚠️ Java setPos 已是**相对父骨骼**的偏移 ⇒ 直接换算，**不做** `pivot − R·pivot` 修正
      localPosition: [b.pos[0] * PX2BLOCK, -b.pos[1] * PX2BLOCK, b.pos[2] * PX2BLOCK],
      bindQuaternion: [q.x, q.y, q.z, q.w],
      // ⚠️ 口径 A 下 pivot 恒零（顶点已是骨骼局部坐标，旋转天然绕骨骼原点）
      pivot: [0, 0, 0],
    };
  });
  // 口径 A 哨兵：root 的 Java pos = (0,24,0) ⇒ localPosition = [0,−1.5,0]
  const rootLP = bones[0].localPosition;
  if (rootLP[0] !== 0 || Math.abs(rootLP[1] + 1.5) > 1e-12 || rootLP[2] !== 0) {
    fail(`口径 A 哨兵不符：root.localPosition = ${JSON.stringify(rootLP)}（应为 [0,-1.5,0]）`);
  }

  // ==================== 2. 合并几何（局部顶点 + y 翻转）====================
  const position = [], normal = [], uv = [], skinIndex = [], index = [];
  let vOff = 0, bakedCubes = 0, skippedCubes = 0, cubeCount = 0, mirrorCount = 0;

  for (let bi = 0; bi < names.length; bi++) {
    for (const cube of bonesRaw.get(names[bi]).cubes) {
      cubeCount++;
      const [dx, dy, dz] = cube.size;
      // 零尺寸盒会让 BoxGeometry 产出退化三角形（法线 NaN）。守卫实测 0 个，保留守卫。
      if (dx === 0 || dy === 0 || dz === 0) { skippedCubes++; continue; }
      bakedCubes++;
      if (cube.mirror) mirrorCount++;

      const inf = cube.inflate || 0;
      // inflate = 向外均匀外扩：尺寸 = size + 2*inflate，中心不变。
      // ⚠️ 守卫有 1 个**负** inflate（upperhelmet 的 −0.25）—— 公式同样成立，不要取绝对值。
      const sx = (dx + 2 * inf) * PX2BLOCK;
      const sy = (dy + 2 * inf) * PX2BLOCK;
      const sz = (dz + 2 * inf) * PX2BLOCK;
      const cx = (cube.origin[0] + dx / 2) * PX2BLOCK;
      const cy = (cube.origin[1] + dy / 2) * PX2BLOCK;
      const cz = (cube.origin[2] + dz / 2) * PX2BLOCK;

      const g = new THREE.BoxGeometry(sx, sy, sz);
      g.translate(cx, cy, cz);
      const gp = g.getAttribute('position');
      const gn = g.getAttribute('normal');
      const gu = g.getAttribute('uv');
      const gi = g.getIndex();

      // UV 重映射 —— **逐角**按 Citadel 的角→UV 表写（不是矩形插值）。
      //
      // ⚠️⚠️ 为何不能继续用「BoxGeometry 的归一化 uv × 矩形」：
      // 那只能表达「矩形 + 可选 u 镜像」，而 Citadel 的各面角序不同（有的面 v1>v2），
      // 矩形插值无法表达那些排列 ⇒ 必须按**角位置**匹配后直接赋值。
      //
      // ⚠️ y 翻转**不影响 UV**：源矩形按图像左上原点写，
      // v 换算 `1 − vPx/textureSize`（运行时 TextureLoader.flipY = true 再翻一次）。
      const faces = boxFaceUVs(cube);
      const corners = citadelCorners(cube);   // Java 空间 px（含 inflate / mirror swap）
      // 期望角位置（格，y 已翻）→ UV，按面分组
      const wanted = faces.map((f) => ({
        normal: f.normal,
        pts: f.corners.map((c) => ({
          p: [corners[c.vi][0] * PX2BLOCK, -corners[c.vi][1] * PX2BLOCK, corners[c.vi][2] * PX2BLOCK],
          uv: [c.u / textureSize, 1 - c.v / textureSize],
        })),
      }));
      let uvWritten = 0;
      for (let i = 0; i < gp.count; i++) {
        // 产物顶点（已翻 y）与法线（已翻 y）
        const px = gp.getX(i), py = -gp.getY(i), pz = gp.getZ(i);
        const nx = gn.getX(i), ny = -gn.getY(i), nz = gn.getZ(i);
        const face = wanted.find((f) => f.normal[0] === nx && f.normal[1] === ny && f.normal[2] === nz);
        if (!face) fail(`盒 ${names[bi]} 的顶点法线 (${nx},${ny},${nz}) 不在六面之列`);
        const hit = face.pts.find((q) => Math.hypot(q.p[0] - px, q.p[1] - py, q.p[2] - pz) < 1e-6);
        if (!hit) {
          fail(`盒 ${names[bi]} 面 ${face.normal} 的角 (${px},${py},${pz}) 在 Citadel 角表里找不到`
            + '（inflate / mirror 处理不一致？）');
        }
        gu.setXY(i, hit.uv[0], hit.uv[1]);
        uvWritten++;
      }
      if (uvWritten !== 24) fail(`盒 ${names[bi]} 写了 ${uvWritten} 个 UV，应为 24`);

      for (let i = 0; i < gp.count; i++) {
        // ⚠️ 口径 A：整体 y → −y（顶点与法线都翻），x/z 不变；**不加绝对 pivot**
        position.push(gp.getX(i), -gp.getY(i), gp.getZ(i));
        normal.push(gn.getX(i), -gn.getY(i), gn.getZ(i));
        uv.push(gu.getX(i), gu.getY(i));
        skinIndex.push(bi, 0, 0, 0);
      }
      // y 翻转让三角形绕序反向 —— 靠材质的 DoubleSide 吸收（与焰魔同口径）
      for (let i = 0; i < gi.count; i++) index.push(gi.array[i] + vOff);
      vOff += gp.count;
      g.dispose();
    }
  }

  if (cubeCount !== GUARDIAN_METRICS.cubeCount) fail(`立方体数 ${cubeCount} ≠ 期望 ${GUARDIAN_METRICS.cubeCount}`);
  if (bakedCubes !== GUARDIAN_METRICS.bakedCubes) fail(`烘焙立方体数 ${bakedCubes} ≠ 期望 ${GUARDIAN_METRICS.bakedCubes}`);
  if (vOff !== GUARDIAN_METRICS.vertexCount) fail(`顶点数 ${vOff} ≠ 期望 ${GUARDIAN_METRICS.vertexCount}`);
  if (index.length !== GUARDIAN_METRICS.indexCount) fail(`索引数 ${index.length} ≠ 期望 ${GUARDIAN_METRICS.indexCount}`);
  for (const v of uv) if (!(v >= 0 && v <= 1)) fail(`UV 越界 ${v}（应 ∈ [0,1]）`);

  // ==================== 3. 贴图（主图 + 眼睛层合成）====================
  const basePng = PNG.sync.read(fs.readFileSync(GUARDIAN_TEX_SRC));
  const layerPng = PNG.sync.read(fs.readFileSync(GUARDIAN_LAYER_TEX_SRC));
  const { painted, changed } = compositeLayerTexture(basePng, layerPng);
  if (painted !== GUARDIAN_METRICS.layerOpaquePixels) {
    fail(`眼睛层覆盖像素 ${painted} ≠ 期望 ${GUARDIAN_METRICS.layerOpaquePixels}`
      + '（阈值必须是 alpha>0，不是 >128）');
  }
  if (changed !== GUARDIAN_METRICS.layerChangedPixels) {
    fail(`眼睛层实际改色像素 ${changed} ≠ 期望 ${GUARDIAN_METRICS.layerChangedPixels}`
      + '（为 0 说明合成退化成空操作 —— 检查 alpha 阈值与强制 255）');
  }
  const pngBuf = PNG.sync.write(basePng);
  console.log(`[守卫烘焙]   贴图合成：眼睛层覆盖 ${painted} 像素、其中改色 ${changed}`
    + `（${basePng.width}² 单贴图单材质）`);

  // ==================== 4. 动画（Java 关键帧逐 tick 求值）====================
  const animations = {};
  for (const [key, constName] of Object.entries(GUARDIAN_ANIM_SOURCES)) {
    const stmts = parseAnimation(text, constName);
    const frameCount = GUARDIAN_METRICS.animTicks[key];
    if (!Number.isFinite(frameCount) || frameCount <= 0) fail(`动画 "${key}" 缺 animTicks`);
    // 关键帧声明的 tick 合计必须与冻结值一致（上勾拳声明 100 但关键帧只有 90）
    const declared = stmts
      .filter((s) => ['startKeyframe', 'setStaticKeyframe', 'resetKeyframe'].includes(s.kind))
      .reduce((n, s) => n + s.n, 0);
    if (declared !== frameCount) {
      fail(`动画 "${key}" 关键帧 tick 合计 ${declared} ≠ 冻结 ${frameCount}`);
    }
    // 只导出**真的被驱动**的骨骼（与焰魔同口径：boneIndices 是稀疏的）
    const driven = new Set();
    for (const s of stmts) if (s.name) driven.add(s.name);
    const boneIndices = names.map((n, i) => (driven.has(n) ? i : -1)).filter((i) => i >= 0);
    const frames = [];
    for (let f = 0; f < frameCount; f++) {
      const pose = evalKeyframes(stmts, f);
      for (const bi of boneIndices) {
        const e = pose.get(names[bi]) || { rot: [0, 0, 0], pos: [0, 0, 0] };
        const dq = deltaRotation(bindQuat[bi], bindRad[bi], e.rot);
        frames.push(dq.x, dq.y, dq.z, dq.w);
        // ⚠️ move 是 px 平移，Java y 向下 ⇒ 产物 y 取反。
        // 实测锚点：踩踏 move(left_leg,0,−9,−9) 是抬腿 9px ⇒ pos.y = +0.5625 格。
        frames.push(e.pos[0] * PX2BLOCK, -e.pos[1] * PX2BLOCK, e.pos[2] * PX2BLOCK);
      }
    }
    animations[key] = { fps: animFps, frameCount, boneIndices, frames };
    console.log(`[守卫烘焙]   动画 ${key}: ${frameCount} 帧 × ${boneIndices.length} 骨骼 @ ${animFps}fps`
      + `（${constName}，${(frameCount / animFps).toFixed(2)}s）`);
  }

  const asset = {
    scale,
    bones,
    geometry: { position, normal, uv, skinIndex, index },
    animations,
    metrics: {
      boneCount: bones.length,
      cubeCount,
      skippedCubes,
      bakedCubes,
      vertexCount: vOff,
      indexCount: index.length,
      scale,
      mirrorCubes: mirrorCount,
    },
  };

  // ==================== 5. 脚底补偿量（feetOffsetY）====================
  //
  // 语义与焰魔相同：**渲染器把 mesh 平移 feetOffsetY**，使动画全程最低点落在
  // `state.position.y`（脚底）。守卫没有武器骨骼 ⇒ 扫全部顶点。
  //
  // ⚠️⚠️ **骨骼链必须用口径 A**：`position = localPosition + delta.pos`，
  // **不是** `pivot − R_current·pivot + delta.pos`（那是焰魔的绝对口径公式）。
  // 用错公式的形态：feetOffsetY 差一个常量（本例 1.5 格），模型整体陷地/悬空。
  let lowestY = Infinity;
  const scanAnim = (anim) => {
    for (let f = 0; f < anim.frameCount; f++) {
      const world = new Array(bones.length);
      for (let i = 0; i < bones.length; i++) {
        const b = bones[i];
        const slot = anim.boneIndices.indexOf(i);
        let q = b.bindQuaternion, dp = [0, 0, 0];
        if (slot >= 0) {
          const o = (f * anim.boneIndices.length + slot) * 7;
          const dq = [anim.frames[o], anim.frames[o + 1], anim.frames[o + 2], anim.frames[o + 3]];
          q = qmulLocal(b.bindQuaternion, dq);
          dp = [anim.frames[o + 4], anim.frames[o + 5], anim.frames[o + 6]];
        }
        const pos = [
          b.localPosition[0] + dp[0],
          b.localPosition[1] + dp[1],
          b.localPosition[2] + dp[2],
        ];
        const local = trMat(q, pos);
        world[i] = b.parentIndex === -1 ? local : mul4(world[b.parentIndex], local);
      }
      for (let v = 0; v < vOff; v++) {
        const w = apply4(world[skinIndex[v * 4]], [position[v * 3], position[v * 3 + 1], position[v * 3 + 2]]);
        if (w[1] < lowestY) lowestY = w[1];
      }
    }
  };
  for (const key of Object.keys(GUARDIAN_ANIM_SOURCES)) scanAnim(animations[key]);
  if (!Number.isFinite(lowestY)) fail('脚底补偿扫描失败（没有任何顶点）');
  asset.metrics.feetOffsetY = -lowestY;
  console.log(`[守卫烘焙]   脚底补偿 feetOffsetY = ${(-lowestY).toFixed(4)}`
    + `（动画全程最低点 y = ${lowestY.toFixed(4)} 格）`);

  // ==================== 6. 写产物 ====================
  fs.mkdirSync(path.dirname(GUARDIAN_JSON), { recursive: true });
  fs.writeFileSync(GUARDIAN_PNG, pngBuf);
  fs.writeFileSync(GUARDIAN_JSON, JSON.stringify(asset));
  const fp = guardianInputFingerprint();
  fs.writeFileSync(GUARDIAN_META, JSON.stringify({
    fingerprints: { input: fp.input, sourceSha256: fp.sourceSha256, paramsSha256: fp.paramsSha256 },
    metrics: asset.metrics,
    textureSize,
    animFps,
    animTicks: GUARDIAN_METRICS.animTicks,
    animSources: GUARDIAN_ANIM_SOURCES,
    layerPixels: { painted, changed },
  }, null, 1));

  const rel = (p) => path.relative(process.cwd(), p);
  console.log(`[守卫烘焙] ✓ ${bones.length} 骨骼 / ${bakedCubes} 立方体（跳过 ${skippedCubes} 零尺寸，`
    + `镜像 ${mirrorCount}）/ ${vOff} 顶点 / ${index.length} 索引 / 贴图 ${textureSize}²`);
  console.log(`[守卫烘焙]   产物 ${rel(GUARDIAN_JSON)} + ${rel(GUARDIAN_PNG)} + ${rel(GUARDIAN_META)}`);
  console.log(`[守卫烘焙]   指纹 ${fp.input}`);
}

main();