// src/render/blockbench-model-loader.js — Blockbench「逐面 UV」item 模型的运行时加载（three）
//
// 只在主线程运行（依赖 three）：把 `blockbench-geometry.js` 解析出的元素盒逐个建成
// `BoxGeometry`、按每面 UV 矩形重映射贴图坐标，按元素旋转/中心烘进顶点后**合并成一份几何**，
// 返回一个 `THREE.Group`（与 `WeaponModelLoader` 的 `load()` 同接口，供 `ViewWeapon` 消费）。
//
// **几何用 three `BoxGeometry`，不手工推顶点**：绕序与法线由 three 保证（红线 6 同精神，
// 实体/视图模型命中与渲染都不自造几何面序）。UV 数学在 three-free 的
// `blockbench-geometry.js`（Node 侧可对账）。
//
// ⚠️ **合并成 1 个 Mesh 而不是 16 个**（draw call 口径见 `loadBlockbenchSword` 内注释）。
//
// **贴图参数与 dragon/ignis 渲染器同口径**：`SRGBColorSpace` + `NearestFilter`（像素风，
// 免模糊）+ `alphaTest 0.5`（剑体发光粒子是半透明像素，走 cutout 语义免透明排序）。

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { resourceUrl } from '../core/resource-url.js';
import {
  parseBlockbenchElements, BOX_FACE_NAMES,
} from './blockbench-geometry.js';

/**
 * 剑体素材的仓库相对路径（`resourceUrl()` 派生，子路径部署安全，v1.87 同口径）。
 * 源 JSON 直接入库（Blockbench 导出原样），运行时解析 —— 无烘焙产物，故无指纹环节。
 */
export const SWORD_ASSET_URLS = Object.freeze({
  json: resourceUrl('assets/models/weapons/sword/sword.json'),
  png: resourceUrl('assets/models/weapons/sword/sword.png'),
});

/**
 * 把一个面的 UV 重映射到归一化矩形 `rect = [uLeft, vTop, uRight, vBottom]`
 * （three flipY 口径）。支持 `uvRotation = 180`（四角对调）。
 *
 * ⚠️ **矩形可以是反向的**（`uRight < uLeft` 或 `vBottom > vTop`）—— 素材里真实存在
 * （如 el0 的 up 面 uv=[5.5,1.5,5.25,1.25]），那是**故意的面内镜像采样**。
 * 故这里用线性插值原样保留书写方向，**不得规范化成 min/max**（规范化会让那些面镜像消失）。
 *
 * `BoxGeometry` 每面 4 顶点的 (u,v) 布局固定为
 * `v0=(0,1) v1=(1,1) v2=(0,0) v3=(1,0)`（实测，权威在 `blockbench-geometry.js` 的
 * `BOX_FACE_VERT_UV`）：即 v0=左上、v1=右上、v2=左下、v3=右下（uv 空间，v=1 为图顶）。
 * 因为 6 个面的这个布局完全一致，所以只需按次序写四个角，不必读 position 推朝向。
 *
 * @param {import('three').BufferAttribute} uv `geometry.getAttribute('uv')`
 * @param {number} faceIndex `BoxGeometry` 面序（0=east,1=west,2=up,3=down,4=south,5=north）
 * @param {number[]} rect `[uLeft, vTop, uRight, vBottom]`
 * @param {number} uvRotation 0 或 180
 */
function remapFaceUV(uv, faceIndex, rect, uvRotation) {
  const [uL, vT, uR, vB] = rect;
  // 基准四角（左上/右上/左下/右下），与 BOX_FACE_VERT_UV 的顶点次序一一对应
  const base = [[uL, vT], [uR, vT], [uL, vB], [uR, vB]];
  // rotation 180：矩形内每角换成对角（反向矩形下这个式子依然成立）
  const corners = uvRotation === 180
    ? base.map(([u, v]) => [uL + uR - u, vT + vB - v])
    : base;
  for (let k = 0; k < 4; k++) {
    const i = faceIndex * 4 + k;
    const [tu, tv] = corners[k];
    uv.setXY(i, tu, tv);
  }
  uv.needsUpdate = true;
}

/**
 * 加载剑体模型与贴图，返回归一化后的 `THREE.Group`（与枪的 `_normalize` 同口径：
 * 居中 + 按最大维度缩放到单位尺寸）。
 *
 * @param {{jsonUrl?: string, pngUrl?: string}} [opts] 测试可注入替换 url
 * @returns {Promise<THREE.Group>}
 */
export async function loadBlockbenchSword(opts = {}) {
  const jsonUrl = opts.jsonUrl ?? SWORD_ASSET_URLS.json;
  const pngUrl = opts.pngUrl ?? SWORD_ASSET_URLS.png;

  const [modelRes, texture] = await Promise.all([
    fetch(jsonUrl).then((r) => {
      if (!r.ok) throw new Error(`sword model fetch failed: ${jsonUrl} (${r.status})`);
      return r.json();
    }),
    new THREE.TextureLoader().loadAsync(pngUrl),
  ]);

  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;

  const elements = parseBlockbenchElements(modelRes);
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    alphaTest: 0.5,   // 发光粒子半透明像素走 cutout，免透明排序（dragon/ignis 同口径）
    side: THREE.DoubleSide, // 零厚薄片（剑翼）两面都要看见
  });

  const group = new THREE.Group();
  // ⚠️ **全部元素合并成一份几何 = 1 个 Mesh = 1 个 draw call**，不是 16 个。
  //
  // 素材有 16 个 element，若每个建一个 Mesh 就是 **16 个 draw call**（枪只有 1~3 个）。
  // 本仓对 draw call 极度敏感（AGENTS.md：「常驻实例池在零实例时必须 visible=false，
  // 否则每个 mesh 恒增 1 个 draw call」；`weapons-performance.spec.mjs` 钉着
  // 「minigun 不得高于徒手 +2」）。合并的前提完全满足：全部元素共用**同一个材质**，
  // 且都是同属性集的 `BoxGeometry`（position/normal/uv + index）。
  //
  // 做法：把每个元素的「绕 origin 旋转 + 盒中心平移」**烘进顶点**（`applyMatrix4` /
  // `translate`）再合并 —— 合并后几何已在模型空间就位，不需要逐 Mesh 的 position/rotation。
  const geometries = [];
  for (const el of elements) {
    const [w, h, d] = el.size;
    const geometry = new THREE.BoxGeometry(w, h, d);
    const uv = geometry.getAttribute('uv');
    for (let fi = 0; fi < BOX_FACE_NAMES.length; fi++) {
      const name = BOX_FACE_NAMES[fi];
      const face = el.faces[name];
      if (!face) continue;
      remapFaceUV(uv, fi, face.rect, face.uvRotation);
    }
    // ① 元素旋转：绕 origin 转。BoxGeometry 以盒中心为原点，故先把 origin 换成
    //    「相对盒中心」的偏移，做 T(o)·R·T(-o)。
    if (el.rotation.angleDeg) {
      const { angleDeg, axis, origin } = el.rotation;
      const rad = (angleDeg * Math.PI) / 180;
      const ox = origin[0] - el.center[0];
      const oy = origin[1] - el.center[1];
      const oz = origin[2] - el.center[2];
      const axisVec = axis === 'x' ? new THREE.Vector3(1, 0, 0)
        : axis === 'z' ? new THREE.Vector3(0, 0, 1)
        : new THREE.Vector3(0, 1, 0);
      const m = new THREE.Matrix4();
      m.makeTranslation(ox, oy, oz);
      m.multiply(new THREE.Matrix4().makeRotationAxis(axisVec, rad));
      m.multiply(new THREE.Matrix4().makeTranslation(-ox, -oy, -oz));
      geometry.applyMatrix4(m);
    }
    // ② 盒中心平移。**必须在旋转之后**：反序会让旋转把平移一起转掉（护手件会歪出去）。
    geometry.translate(el.center[0], el.center[1], el.center[2]);
    geometries.push(geometry);
  }
  const merged = mergeGeometries(geometries, false);
  // 合并完成后逐份几何已无用（顶点已拷进 merged）—— 释放，避免泄漏
  for (const g of geometries) g.dispose();
  if (!merged) throw new Error('sword model failed: mergeGeometries 返回 null');

  const mesh = new THREE.Mesh(merged, material);
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  group.add(mesh);

  // 归一化：居中 + 按最大维度缩放到 1（与 WeaponModelLoader._normalize 同口径）
  const box = new THREE.Box3().setFromObject(group);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  group.position.set(-center.x, -center.y, -center.z);
  const wrapper = new THREE.Group();
  wrapper.add(group);
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  const scale = 1.0 / maxDim;
  wrapper.scale.set(scale, scale, scale);
  return wrapper;
}
