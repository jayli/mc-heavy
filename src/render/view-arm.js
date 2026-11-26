// src/render/view-arm.js — 第一人称手臂（v3.46：**整体照抄 OpusCraft / vanilla 口径**）
//
// 只在主线程引入 three：单个 Mesh 挂到 camera 下（一个相机子节点，不新增地形渲染通道 /
// InstancedMesh / BatchedMesh）。与 `view-weapon.js`（持枪/持剑视图模型）互斥：
// 同一时刻只显示其中一个，由 `setWeapon(id)` 切换。
//
// ## 上游出处（逐条）
//
// 上游 = `~/jaylli/OpusCraft`（从零重写的 MC Java 1.21，TS + WebGL2，MIT），
// 它的手臂是**逐行照 vanilla `ItemInHandRenderer` / `PlayerRenderer.renderRightHand`** 写的。
//
//   · 几何：`src/render/model.ts:161` 的 `right_arm`
//       cube {x:-3, y:-2, z:-2, w:4, h:12, d:4, u:40, v:16}，pivot [-5, 2, 0]
//       袖子 {同上, u:40, v:32, inflate:0.25}
//     几何单位是**像素 /16**（`bakeCube` 里 `p[i]/16`）⇒ 手臂 0.25 × 0.75 × 0.25 格。
//   · 挥动：`src/render/handRenderer.ts` 的 `renderArm`（11 步变换链，见 `ARM_POSE`）。
//   · 皮肤：`src/textures/skin.ts` 的 `steveSkin()`（本仓离线烘焙，见 `tools/bake-player-skin.mjs`）。
//   · 步态：`VIEW_BOB`（`render/view-bob-config.js`，three-free 共享配置）。
//
// ## 三条有意偏离（完整表见设计稿 §2）
//
//  ① **材质 unlit**（`MeshBasicMaterial({ map })`）而非上游的 lightmap 受光：
//     本仓全场景 unlit，受光材质会让肤色随日夜漂移、且比同屏方块亮一档
//     （v1.48 已记录的取舍，`minecart-renderer.js` / 枪的 PBR 是例外）。
//     明暗改由**皮肤贴图自带**（三档色 + 逐像素噪声），不再烘焙顶点色。
//  ② **手臂 + 袖子合并进同一 geometry**（两组顶点、一份材质、一个 Mesh）：
//     本仓 WebGPU 后端 `getMaterial()` 不遍历 `geometry.groups`
//     （`zombie-skin-texture.js` 已记）⇒ 两个 mesh 要多一份材质与一个 draw call。
//     合并保住「camera 只增 1 个节点」的既有断言。
//  ③ **挥动时长固定 6 tick = 0.1s**：上游 `swingDuration()` 受 haste/挖掘疲劳影响，
//     本仓无药水效果系统。
//
// ## 已实测：上游常数在本仓相机下可直接用（不需缩放重标定）
//
// 复刻变换链投影手臂盒 8 角（fov 70 / near 0.1 / 1280×720）：
//   swing=0     近平面内 0/8，z ∈ [−1.185, −0.438]，屏幕 bbox x[902,1378] y[506,1322]
//   swing=0.25  近平面内 0/8，z ∈ [−1.360, −0.660]
//   swing=0.5   近平面内 0/8，z ∈ [−1.533, −0.750]（手端最远）
//   swing=1     与 swing=0 **逐位相同**（严格回位）
// ⇒ 右下角一条粗手臂、下缘出屏 = 原版观感。
//
// ⚠️ **改任何变换常数前先重跑 `test-view-bob.js` 的相机空间锚点断言** ——
// 那些数值是逐条实测定出来的，不是推导值。
import * as THREE from 'three';
import { resourceUrl } from '../core/resource-url.js';
import { VIEW_BOB } from './view-bob-config.js';
import {
  PLAYER_SKIN_SIZE, PLAYER_SKIN_UV, ARM_CUBE, ARM_PIVOT, ARM_SLEEVE_INFLATE,
  ARM_REST_ROLL, ARM_SWING_DURATION, ARM_POSE,
} from './view-arm-data.js';

// re-export：数据层的唯一权威在 `view-arm-data.js`（three-free，烘焙脚本与门禁读那份）。
// 这里透出一份是为了让浏览器侧消费方不必记住两个路径（同 zombie-model 的口径）。
export { PLAYER_SKIN_SIZE, PLAYER_SKIN_UV, ARM_POSE };

/**
 * 手臂几何与动画参数（冻结常量，单一权威）。**数值逐条取自上游**，出处见各项注释。
 */
export const VIEW_ARM = Object.freeze({
  /** 手臂盒（像素，上游 `right_arm` 的 cube；渲染时 /16） */
  cube: ARM_CUBE,
  /** 部件支点（像素，上游 `ModelPart` 的 pivot；渲染时 /16） */
  pivot: ARM_PIVOT,
  /** 袖子外扩（像素，上游 `inflate: 0.25`） */
  sleeveInflate: ARM_SLEEVE_INFLATE,
  /** 静止时手臂绕 Z 的外张角（**弧度**，上游 `drawArm` 的 `arm.zRot = 0.1`） */
  restRoll: ARM_REST_ROLL,
  /** 挥动总时长（秒）—— 上游 6 tick @60Hz */
  swingDuration: ARM_SWING_DURATION,
  /** 选中这个武器 id 时显示手臂；其余（持枪/持剑）隐藏 */
  weaponId: 'arm',
  /** drawProgress 收敛速度（每秒增量，本仓既有口径，喂 `equip = (1−p)²`） */
  drawSpeed: 4,
  /**
   * 步态摆动幅度 —— **从 `VIEW_BOB` 派生，不复制字面量**（红线 1）。
   * 上游 `cos(ph)*0.012*amp` / `-|sin(ph)|*0.014*amp` / `sin(ph)*0.018*amp`。
   */
  bobX: VIEW_BOB.x,
  bobY: VIEW_BOB.y,
  bobRoll: VIEW_BOB.roll,
});

/**
 * 加载手臂皮肤（64×64 标准版式，只烘了手臂两段 + 袖子两段）。
 *
 * ⚠️ 走 `resourceUrl()`（部署路径无关，子路径部署也不 404）。
 * ⚠️ Nearest 采样：皮肤是 1px 尺度的图案（袖口分界），线性采样会糊掉。
 * ⚠️ 不开 mipmap：手臂恒在近处（z ≈ −0.5~−1.5），远处看不见。
 *
 * @returns {Promise<THREE.Texture>}
 */
export async function loadPlayerSkinTexture() {
  const texture = await new THREE.TextureLoader().loadAsync(resourceUrl('assets/player/skin.png'));
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  return texture;
}

/**
 * 面间亮度系数（**灰阶**，乘在皮肤贴图上）—— v3.46b 补回立体感。
 *
 * ## 为什么需要它（实测，不是凭直觉）
 *
 * 用户裁定「整条手臂全肤色」后，Tier 4 实测：**78.6% 像素挤在同一个亮度桶、
 * 无双峰**（`secondPeakShare = 0`）—— 这正是 v1.56「一个颜色、没立体感」的读数
 *（当年修复前是 78.9%）。根因：静止姿态下只有**两个面**可见
 *（实测屏幕面积 +Z 3.57 / −X 2.09，其余四面被几何自身挡住），
 * 而两面采同一张肤色贴图 ⇒ **面间零明暗差**。
 *
 * ## 为什么是灰阶而不是旧版那套三层烘焙
 *
 * 用户要的是「跟手臂一样的色调」⇒ **不得改色相**。灰阶系数（r=g=b）
 * 只缩放亮度，皮肤的 R>G>B 关系逐位保持 ⇒ 仍是同一个肤色，只是有向光/背光。
 * 旧版 v1.57 那套 `shadeLow/shadeHigh` 幂律重映射会**改色相**（当时就是为了修发灰），
 * 本轮不重引入。
 *
 * ## 数值来源
 *
 * vanilla `ModelBlockRenderer` 的六面遮挡系数（顶 1.0 / 前后 0.8 / 左右 0.6 / 底 0.5），
 * 但**重标到 [0.72, 1.0]**：原值跨度 0.5~1.0 在屏幕空间会把背光面压得太暗
 *（v1.57 用户报过「手臂颜色过于暗」）。取 0.72 下界：实测两可见面峰距 ~18%，
 * 远高于「双峰可辨」的 10% 阈，且暗面仍在参考肤色的 72%（不发黑）。
 *
 * ⚠️ **面键用的是贴图版式名**（px/nx/py/ny/pz/nz），与 `PLAYER_SKIN_UV` 同口径。
 */
export const ARM_FACE_SHADE = Object.freeze({
  py: 1.0,    // 顶（+Y，朝天光）
  ny: 0.72,   // 底（−Y，背光）
  pz: 0.94,   // +Z（静止姿态下正对相机的主可见面）
  nz: 0.86,   // −Z
  px: 0.88,   // +X
  nx: 0.78,   // −X（静止姿态下的第二个可见面，须与 pz 拉开）
});

/**
 * 把一个盒子的 24 顶点 + UV 写进目标数组（**手臂与袖子共用这一份**）。
 *
 * ⚠️ **面归属按法线判，不按下标**：`BoxGeometry` 的面序当前是 `+X,−X,+Y,−Y,+Z,−Z`，
 * 但写死下标会在将来换几何时静默错位（同 `bakeFaceShading` 旧版的取舍）。
 *
 * ⚠️ **UV 的 v 轴翻转**：皮肤 PNG 是左上原点（v 向下），而 three 的 UV 是左下原点
 *（v 向上）⇒ `v_tex = 1 − v_px/64`。不翻会让整条手臂上下颠倒（袖口跑到手上）。
 *
 * ⚠️ **面内归一化位置直接用 `BoxGeometry` 自带的 uv 属性**，不手写切向轴：
 * ±X / ±Y / ±Z 三组面的切向方向各不相同（有的还带镜像），手写极易错一轴。
 *
 * @param {THREE.BoxGeometry} box 已建好的盒（24 顶点）
 * @param {object} uvRects 六面 UV 矩形
 * @param {number[]} outPos @param {number[]} outUv @param {number[]} outIdx
 * @param {number} vertexOffset 本盒在目标数组里的起始顶点号
 * @param {number[]} [outColor] 传入时同时烘焙**面间亮度**（灰阶顶点色，不改色相）
 */
function appendBox(box, uvRects, outPos, outUv, outIdx, vertexOffset, outColor) {
  const pos = box.attributes.position;
  const nor = box.attributes.normal;
  const S = PLAYER_SKIN_SIZE;
  for (let i = 0; i < pos.count; i++) {
    outPos.push(pos.getX(i), pos.getY(i), pos.getZ(i));
    const nx = nor.getX(i), ny = nor.getY(i), nz = nor.getZ(i);
    const key = Math.abs(nx) > 0.5 ? (nx > 0 ? 'px' : 'nx')
      : Math.abs(ny) > 0.5 ? (ny > 0 ? 'py' : 'ny')
        : (nz > 0 ? 'pz' : 'nz');
    const [u1, v1, u2, v2] = uvRects[key];
    const bu = box.attributes.uv.getX(i);
    const bv = box.attributes.uv.getY(i);
    const uPx = u1 + (u2 - u1) * bu;
    const vPx = v1 + (v2 - v1) * (1 - bv);
    outUv.push(uPx / S, 1 - vPx / S);
    if (outColor) {
      const k = ARM_FACE_SHADE[key];
      outColor.push(k, k, k);
    }
  }
  const idx = box.index;
  for (let i = 0; i < idx.count; i++) outIdx.push(idx.getX(i) + vertexOffset);
}

/**
 * 造手臂几何（手臂盒 + 袖子盒合并，一份材质一个 Mesh —— 见文件头偏离 ②）。
 * @returns {THREE.BufferGeometry}
 */
export function createArmGeometry() {
  const C = VIEW_ARM.cube;
  const S = 16;   // 像素 → 格
  const g = VIEW_ARM.sleeveInflate;
  const positions = [];
  const uvs = [];
  const colors = [];
  const indices = [];
  const cx = (C.x + C.w / 2) / S;
  const cy = (C.y + C.h / 2) / S;
  const cz = (C.z + C.d / 2) / S;

  // 手臂本体：cube 的 (x,y,z) 是**最小角**，(w,h,d) 是尺寸 ⇒ 中心 = 最小角 + 尺寸/2
  const armBox = new THREE.BoxGeometry(C.w / S, C.h / S, C.d / S);
  armBox.translate(cx, cy, cz);
  appendBox(armBox, PLAYER_SKIN_UV.arm, positions, uvs, indices, 0, colors);
  const armVerts = armBox.attributes.position.count;
  armBox.dispose();

  // 袖子：同盒各向外扩 inflate（上游 `inflate: 0.25` 像素）。
  // ⚠️ v3.46b 起它整段透明（不上屏），但仍给它烘焙同一套面间亮度 ——
  // 将来若有人把袖子改回可见，不会得到一个新的一色块。
  const sleeveBox = new THREE.BoxGeometry(
    (C.w + g * 2) / S, (C.h + g * 2) / S, (C.d + g * 2) / S,
  );
  sleeveBox.translate(cx, cy, cz);
  appendBox(sleeveBox, PLAYER_SKIN_UV.sleeve, positions, uvs, indices, armVerts, colors);
  sleeveBox.dispose();

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  // 灰阶顶点色（r=g=b）：只缩放亮度，**不改色相** ⇒ 仍是同一个肤色。
  // ⚠️ 顶点色缓冲是**线性**工作色空间，而面系数是屏幕空间的观感比例
  // ⇒ 这里直接写线性值（与 three 的 `instanceColor` 同口径），不再做 sRGB 转换：
  // 旧版 v1.57 那套幂律重映射会改色相，本轮不重引入（见 ARM_FACE_SHADE 注释）。
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

/** 逐帧复用的临时对象（禁止在 update 里 new） */
const _m = new THREE.Matrix4();
const _tmp = new THREE.Matrix4();
const _pos = new THREE.Vector3();
const _quat = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _axisX = new THREE.Vector3(1, 0, 0);
const _axisY = new THREE.Vector3(0, 1, 0);
const _axisZ = new THREE.Vector3(0, 0, 1);
const DEG = Math.PI / 180;

/**
 * 上游 `PoseStack` 的右乘语义：`M ← M · T` / `M ← M · R`。
 * three 的 `Matrix4.multiply(m)` 同为右乘 ⇒ 逐条 `.multiply()`，**顺序不能反**。
 */
function poseTranslate(m, x, y, z) {
  return m.multiply(_tmp.makeTranslation(x, y, z));
}
function poseRotate(m, axis, rad) {
  return m.multiply(_tmp.makeRotationAxis(axis, rad));
}

/**
 * 上游 `renderArm` 的完整变换链（纯函数，返回写入 `out`）。
 *
 * @param {number} swing 挥动进度 0..1（1 = 未在挥动，此时曲线全部归零）
 * @param {number} equip 收起进度 0..1（0 = 就位，1 = 完全收起）
 * @param {THREE.Matrix4} out 复用矩阵
 * @returns {THREE.Matrix4} out
 */
export function armPoseMatrix(swing, equip, out = new THREE.Matrix4()) {
  const P = ARM_POSE;
  const f = 1;                       // 右手（本仓无副手）
  const swinging = swing < 1;
  const sq = Math.sqrt(swing);
  const f1 = swinging ? sq : 0;
  const f2 = swinging ? P.swingX * Math.sin(f1 * Math.PI) : 0;
  const f3 = swinging ? P.swingY * Math.sin(f1 * Math.PI * 2) : 0;
  const f4 = swinging ? P.swingZ * Math.sin(swing * Math.PI) : 0;
  const f5 = swinging ? Math.sin(swing * swing * Math.PI) : 0;
  const f6 = swinging ? Math.sin(f1 * Math.PI) : 0;

  out.identity();
  poseTranslate(out,
    f * (f2 + P.baseX),
    f3 + P.baseY + equip * P.equipDrop,
    f4 + P.baseZ);
  poseRotate(out, _axisY, f * P.baseYaw * DEG);
  poseRotate(out, _axisY, f * f6 * P.swingYaw * DEG);
  poseRotate(out, _axisZ, f * f5 * P.swingRoll * DEG);
  poseTranslate(out, f * P.boneShift[0], P.boneShift[1], P.boneShift[2]);
  poseRotate(out, _axisZ, f * P.boneRoll * DEG);
  poseRotate(out, _axisX, P.bonePitch * DEG);
  poseRotate(out, _axisY, f * P.boneYaw * DEG);
  poseTranslate(out, f * P.boneOffsetX, 0, 0);
  // drawArm：arm.resetPose(); xRot=0; zRot=0.1（**弧度**）→ translateAndRotate(pivot/16)
  const pv = VIEW_ARM.pivot;
  poseTranslate(out, pv[0] / 16, pv[1] / 16, pv[2] / 16);
  poseRotate(out, _axisZ, VIEW_ARM.restRoll);
  return out;
}

export class ViewArm {
  /**
   * @param {{camera: import('three').PerspectiveCamera, texture?: import('three').Texture|null}} deps
   *   `texture` 可注入（单测传假纹理免加载）；缺省 null ⇒ 用中性肤色材质兜底，
   *   装配层随后调 `setTexture()` 换成真皮肤（同丧尸渲染器的容错口径）。
   */
  constructor({ camera, texture = null }) {
    this.camera = camera;
    this.geometry = createArmGeometry();
    // unlit + 贴图（见文件头偏离 ①）。材质色保持白，颜色全部来自皮肤贴图。
    this.material = new THREE.MeshBasicMaterial({
      map: texture,
      color: texture ? 0xffffff : 0xb68a6f,
      // 灰阶顶点色乘在贴图上（面间亮度，不改色相）—— 见 ARM_FACE_SHADE。
      vertexColors: true,
      // ⚠️ **alphaTest 是载荷性的**：外套层整段 alpha=0（v3.46b）。
      // 不开 alphaTest 的话那些透明像素会写成**黑色实心**（MeshBasicMaterial 默认
      // transparent=false ⇒ alpha 被忽略）⇒ 袖子盒把整条手臂遮住。
      // 取 0.5 而不是 0：边缘抗锯齿像素（alpha 介于 0~1）寁可不要，避免半透明排序。
      alphaTest: 0.5,
      toneMapped: true,
    });
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.name = 'view-arm';
    // 视图模型不投影：挂相机上的几何投影没有意义且会随转头闪烁
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.visible = false;
    // 手臂恒在近平面附近，包围球按局部几何算会被误剔除
    this.mesh.frustumCulled = false;
    camera.add(this.mesh);
    /** 举手臂进度（0 = 完全收起，1 = 就位） */
    this.drawProgress = 0;
    /** 当前选中的武器 id */
    this.selectedId = null;
    /** 挥动已过时间（秒）；>= swingDuration 即结束 */
    this.swingElapsed = VIEW_ARM.swingDuration;
    /** 当前挥动进度的稳定快照（0..1，1 表示未在挥动） */
    this.swingProgress = 1;
    /** 步态相位（弧度）与幅度（0..1），由装配层从 `ViewBob` 喂进来 */
    this._bobPhase = 0;
    this._bobAmp = 0;
    this._apply();
  }

  /**
   * 换皮肤贴图（装配层加载完成后调）。
   * @param {import('three').Texture} texture
   */
  setTexture(texture) {
    if (!texture) return;
    this.material.map = texture;
    this.material.color.setHex(0xffffff);
    this.material.needsUpdate = true;
  }

  /**
   * 切换显示（由武器选择驱动）。`arm` 时显示 + 重播「举起」，其余隐藏。
   * @param {string} id
   */
  setWeapon(id) {
    const wasArm = this.selectedId === VIEW_ARM.weaponId;
    this.selectedId = id;
    const isArm = id === VIEW_ARM.weaponId;
    this.mesh.visible = isArm;
    if (isArm && !wasArm) this.drawProgress = 0;
    this._apply();
  }

  /** 触发一次挥动（挖块 / 放置成功时调用）。重复触发时从 0 重播。 */
  swing() {
    this.swingElapsed = 0;
    this.swingProgress = 0;
  }

  /**
   * 每渲染帧推进：举手臂缓动 + 挥动进度 + 步态，并把姿态写入 mesh。
   * 帧率无关：`drawProgress` 按 dt 增量，挥动按 dt 累计。
   *
   * @param {number} dt 秒
   * @param {{bobPhase?: number, bobAmp?: number}} [state]
   *   `bobPhase` = `player.viewBob.timer`（**距离驱动**，与相机晃动同源）；
   *   `bobAmp` = `amount / BOB.intensity`（0..1，静止时收敛到 0）。
   *   缺省 ⇒ 无步态（fixture / 旧单测不传则行为逐位等于改动前）。
   */
  update(dt, state = {}) {
    if (this.drawProgress < 1) {
      this.drawProgress = Math.min(1, this.drawProgress + dt * VIEW_ARM.drawSpeed);
    }
    if (this.swingElapsed < VIEW_ARM.swingDuration) {
      this.swingElapsed = Math.min(VIEW_ARM.swingDuration, this.swingElapsed + dt);
      this.swingProgress = this.swingElapsed / VIEW_ARM.swingDuration;
    } else {
      this.swingProgress = 1;
    }
    this._bobPhase = Number.isFinite(state.bobPhase) ? state.bobPhase : 0;
    this._bobAmp = Number.isFinite(state.bobAmp) ? state.bobAmp : 0;
    this._apply();
  }

  /** 把当前状态写进 mesh。纯派生，无副作用，每帧零分配。 */
  _apply() {
    const equip = Math.pow(1 - this.drawProgress, 2);
    armPoseMatrix(this.swingProgress, equip, _m);
    // 步态叠在**最外层**（相机空间）：M_bob · M_arm。
    // ⚠️ 不叠进变换链内部 —— 那会被后面的骨骼旋转带走，读作「手臂自己在扭」而不是「随步伐晃」。
    const amp = this._bobAmp;
    if (amp !== 0) {
      const ph = this._bobPhase;
      _tmp.makeTranslation(
        Math.cos(ph) * VIEW_ARM.bobX * amp,
        -Math.abs(Math.sin(ph)) * VIEW_ARM.bobY * amp,
        0,
      );
      _m.premultiply(_tmp);
      _tmp.makeRotationZ(Math.sin(ph) * VIEW_ARM.bobRoll * amp);
      _m.premultiply(_tmp);
    }
    _m.decompose(_pos, _quat, _scale);
    this.mesh.position.copy(_pos);
    this.mesh.quaternion.copy(_quat);
    this.mesh.scale.copy(_scale);
  }

  /** 只读状态（测试 / 调试用）。 */
  get state() {
    return {
      selectedId: this.selectedId,
      visible: this.mesh.visible,
      swingProgress: this.swingProgress,
      bobPhase: this._bobPhase,
      bobAmp: this._bobAmp,
    };
  }

  /** 从相机移除并释放几何/材质（Player.dispose 调用，防 reload 后节点叠加）。 */
  dispose() {
    this.camera.remove(this.mesh);
    this.geometry.dispose();
    this.material.dispose();
  }
}