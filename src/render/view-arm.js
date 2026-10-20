// src/render/view-arm.js — 第一人称手臂（徒手时可见 + 挖/放挥动）
// 只在主线程引入 three：单个 Mesh 挂到 camera 下（一个相机子节点，不新增地形渲染通道 /
// InstancedMesh / BatchedMesh）。与 `view-weapon.js`（持枪视图模型）互斥：
// 同一时刻只显示其中一个，由 `setWeapon(id)` 切换。
//
// 造型/站位/刻度/静止角/挥动公式**逐字对齐 mc-lite**（`Player.js:137-141` 建模型 +
// `PlayerInteraction.js:923-933` 更新）：
//   BoxGeometry(0.4, 1.2, 0.4)、scale 0.1、静止 rotation.x = −0.8、
//   位置 (0.07, −0.10 − (1−drawProgress)²·0.5, −0.12)、
//   挥动 rotation.x = −0.8 − sin(p·π)·0.87。
//
// **两处有意偏离 mc-lite**：
//  ① 材质用 `MeshBasicMaterial`（unlit）而非上游的 `MeshStandardMaterial`：本仓库体素/实体
//     全走 unlit 管线，场景里的 AmbientLight + DirectionalLight 只为枪的 PBR 模型而设
//     （`game.js` 构造处注释）。跟随上游用受光材质会让肤色随日夜灯光漂移，且比同一画面里
//     的方块亮一档（`minecart-renderer.js` 用 MeshBasicMaterial 是先例）。
//  ② 挥动时长改为 **dt 基定长**（`swingDuration` 秒）。上游 `swingTime--` 是「每渲染帧减 1」，
//     120Hz 下挥动只有 60Hz 的一半时长（10 帧 → 83ms vs 167ms），是帧率依赖的实现缺陷。
//     这里按 60Hz 的 10 帧折算成 1/6 秒，公式与幅度不变。
import * as THREE from 'three';

/**
 * 手臂几何与动画参数（冻结常量，单一权威）。数值逐字取自 mc-lite：
 * 尺寸/刻度/静止角/挥动幅度见 `Player.js:137-141` 与 `PlayerInteraction.js:927-932`。
 */
export const VIEW_ARM = Object.freeze({
  /** 截面边长（格，mc-lite BoxGeometry 的 width / depth） */
  size: 0.4,
  /** 长度（格，mc-lite BoxGeometry 的 height） */
  height: 1.2,
  /** 整体缩放（mc-lite `arm.scale.set(0.1, 0.1, 0.1)`） */
  scale: 0.1,
  /** 肤色（mc-lite `0xeebb99`，材质用 unlit —— 见文件头偏离 ①） */
  color: 0xeebb99,
  /**
   * 六面烘焙明暗系数（**vanilla 方块面遮挡系数**，顶 1.0 / 前后 0.8 / 左右 0.6 / 底 0.5）。
   *
   * 用户反馈「横面和竖面没有光影效果，一个颜色，没有立体感」。做法是把明暗**烘焙进顶点色**，
   * 而不是换受光材质：本仓全场景 unlit（场景双灯只为枪的 PBR 模型而设），换受光材质会让肤色
   * 随日夜灯光漂移、且比同屏方块亮一档（v1.48 已记录的取舍，`minecart-renderer.js` 同手法）。
   * 与 `mesh/iso-icon.js` 的 `ISO_SHADE` **不是同一口径**：那是 UI 图标惯例的三面系数，
   * 这里是世界内 vanilla 方块的面系数，二者不可复用（同「吊灯 blocklight vs 材质自发光」的区分）。
   */
  faceShade: Object.freeze({ up: 1.0, down: 0.5, z: 0.8, x: 0.6 }),
  /**
   * 固定光照方向（世界空间，与手臂无关）—— 与 `faceShade` **相乘**得到每面亮度。
   *
   * ⚠️ **只有面遮挡系数不够**（实测踩到）：手臂 `rotation.x = -0.8`（≈46°）时，
   * 朝向相机的是**底面（0.5）与前面（0.8）**，顶面（1.0）转到背面 —— 屏幕上只剩两档、
   * 相差 37.5%，直方图实测 78.9% / 19.5% 两个峰，看起来仍然「平」。
   * 乘上一个朝左上前方的固定 Lambert 项后：底面 0.45 / 前面 0.67 / 左右面 0.64 —— 三档明显分离，
   * 且**不管挥动到哪个姿态**都有明暗梯度（不是只对某个固定角度成立）。
   * 取 (0.35, 0.85, 0.4)：略偏右上与前方，与体素世界「天光自上而下」一致。
   */
  lightDir: Object.freeze({ x: 0.35, y: 0.85, z: 0.4 }),
  /** 环境项：把 Lambert 的 `[0,1]` 抬到 `[ambient, 1]`，避免背光面全黑 */
  ambient: 0.45,
  /**
   * 沿手臂长度方向的亮度衰减（远端比根部暗）。
   *
   * ⚠️ **为什么还需要它**（实测）：`rotation.x = -0.8`（≈46°）下手臂只露出**两个面**
   * （底面 + 前面），第三个面被几何本身挡住 —— 所以「六面系数」再准，屏幕上也只有两档亮度，
   * 单个面内部仍然是纯色（直方图实测 79% / 19.6% 两个尖峰，中间几乎无过渡）。
   * 加一层沿长度方向的渐变后，**每个面内部都有梯度** → 观感从「两块色板」变成「有曲面的柱体」。
   * 物理依据：远侧离玩家/场景主光更远；vanilla 的视图模型远端本来也略暗。
   * 0.78 = 远端保留 78% 亮度（再暗会像阴影，不自然）。
   */
  lengthFade: 0.78,
  /** 静止俯仰（弧度，mc-lite `rotation.x = -0.8`） */
  restPitch: 0.8,
  /** 挥动幅度（弧度，mc-lite `sin(progress·π)·0.87`） */
  swingArc: 0.87,
  /**
   * 滚转幅度（弧度，绕 Z 轴）—— **原版 `ItemInHandRenderer` 的甩腕分量**。
   * 原版：`rotate(sin(p²·π) · -20°, Z)`，取 20° = 0.349 rad。峰值在 p≈0.707（滞后于主臂）。
   */
  swingRoll: 0.349,
  /**
   * 横摆幅度（弧度，绕 Y 轴）—— **原版的主摆动轴**。
   * 原版：`rotate(sin(√p·π) · 70°, Y)`，本仓远小于此（70° 是整条手臂骨豁空间里的角度），
   * 取 0.14 rad（≈8°）—— 足够看出“手在往里摆”而不过头。
   */
  swingYaw: 0.14,
  /** 挥动时向前的位移（格）—— 原版 `swingZ = -0.4·sin(p·π)` 在骨豁空间的量级缩放到本仓 */
  swingForward: 0.05,
  /** 挥动时向下的位移（格）—— 原版 `swingY = 0.4·sin(√p·2π)`（双频）的量级缩放 */
  swingDrop: 0.035,
  /** 挥动总时长（秒）—— mc-lite 是「10 帧@60Hz」，折算 1/6 秒（见文件头偏离 ②） */
  swingDuration: 1 / 6,
  /** 就位位置（相机局部坐标，mc-lite `position.set(0.07, -0.10, -0.12)`） */
  position: [0.07, -0.10, -0.12],
  /** 举手臂下移量：`(1 - drawProgress)² × 0.5`（mc-lite `:927`） */
  drawDrop: 0.5,
  /** drawProgress 收敛速度（每秒增量，mc-lite `:926` 的 `dt * 4`） */
  drawSpeed: 4,
  /** 选中这个武器 id 时显示手臂；其余（持枪）隐藏 —— mc-lite `updateArm` 同口径 */
  weaponId: 'arm',
});

/**
 * 把六面明暗**烘焙进顶点色**（每面一个系数，面内均匀 —— 与 vanilla 方块的面级遮挡一致）。
 *
 * `BoxGeometry` 的顶点顺序是固定的 `+X, -X, +Y, -Y, +Z, -Z`，每面 4 个顶点
 * （实测 24 顶点 / 6 组，见 `test-view-bob.js` 的断言）。故按 `f * 4` 直接索引，
 * 不需要读 normal —— 但**读 normal 更稳**（万一将来换几何体，顺序假设会失效）：
 * 这里用 normal 的分量判断朝向，顺序变了也不会错。
 *
 * @param {import('three').BoxGeometry} geometry 原地写入 `color` 属性
 * @param {number} baseColor 基色（0xRRGGBB）
 * @param {{up:number, down:number, z:number, x:number}} shade 六面系数（±X 同、±Z 同）
 */
function bakeFaceShading(geometry, baseColor, shade, lightDir, ambient, lengthFade) {
  const r0 = ((baseColor >> 16) & 0xff) / 255;
  const g0 = ((baseColor >> 8) & 0xff) / 255;
  const b0 = (baseColor & 0xff) / 255;
  const L = lightDir;
  const len = Math.hypot(L.x, L.y, L.z) || 1;
  const lx = L.x / len;
  const ly = L.y / len;
  const lz = L.z / len;
  const pos = geometry.attributes.position;
  const nor = geometry.attributes.normal;
  const colors = new Float32Array(pos.count * 3);
  // 沿长度方向的归一化位置：盒子局部 y ∈ [-h/2, +h/2] → t ∈ [0,1]
  const halfH = (VIEW_ARM.height / 2) || 1;
  for (let i = 0; i < pos.count; i++) {
    const nx = nor.getX(i);
    const ny = nor.getY(i);
    const nz = nor.getZ(i);
    // ① vanilla 面遮挡系数：竖直分量优先（±Y），其余按 X/Z 区分侧面
    const faceK = Math.abs(ny) > 0.5 ? (ny > 0 ? shade.up : shade.down)
      : (Math.abs(nx) > 0.5 ? shade.x : shade.z);
    // ② 固定光向的 Lambert 项（抬到 [ambient, 1]，背光面不归零）
    const lambert = Math.max(0, nx * lx + ny * ly + nz * lz);
    // ③ 沿长度衰减：**让每个面内部也有梯度**（否则单面仍是纯色，见 lengthFade 注释）
    const t = Math.min(1, Math.max(0, (pos.getY(i) / halfH + 1) / 2));
    const fade = 1 - (1 - lengthFade) * t;
    const k = faceK * (ambient + (1 - ambient) * lambert) * fade;
    colors[i * 3] = r0 * k;
    colors[i * 3 + 1] = g0 * k;
    colors[i * 3 + 2] = b0 * k;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}

export class ViewArm {
  /**
   * @param {{camera: import('three').PerspectiveCamera}} deps
   */
  constructor({ camera }) {
    this.camera = camera;
    this.geometry = new THREE.BoxGeometry(VIEW_ARM.size, VIEW_ARM.height, VIEW_ARM.size);
    bakeFaceShading(this.geometry, VIEW_ARM.color, VIEW_ARM.faceShade,
      VIEW_ARM.lightDir, VIEW_ARM.ambient, VIEW_ARM.lengthFade);
    // MeshBasicMaterial（unlit）+ 顶点色烘焙明暗：见文件头偏离 ① 与 `faceShade` 注释。
    // 材质色保持白色，实际颜色全部来自顶点色 —— 这样明暗与基色是同一份数据，
    // 不会出现「材质调了色但顶点色没跟上」的两份权威（红线 1）。
    this.material = new THREE.MeshBasicMaterial({ vertexColors: true });
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.scale.setScalar(VIEW_ARM.scale);
    // 视图模型不投影：挂相机上的几何投影没有意义且会随转头闪烁
    // （`sun-shadow.spec.mjs` 对枪模型钉着同一条不变式）
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.visible = false;
    camera.add(this.mesh);
    /** 举手臂进度（0 = 完全收起，1 = 就位） */
    this.drawProgress = 0;
    /** 当前选中的武器 id */
    this.selectedId = null;
    /** 挥动已过时间（秒）；>= swingDuration 即结束 */
    this.swingElapsed = VIEW_ARM.swingDuration;
    /** 当前挥动进度的稳定快照（0..1，1 表示未在挥动） */
    this.swingProgress = 1;
    this._apply();
  }

  /**
   * 切换显示（由武器选择驱动）。`arm` 时显示 + 重播「举起」，其余隐藏。
   * @param {string} id 当前武器 id（`WEAPON_IDS.ARM` / `'pistol'` / `'mag7'` / `'minigun'`）
   */
  setWeapon(id) {
    const wasArm = this.selectedId === VIEW_ARM.weaponId;
    this.selectedId = id;
    const isArm = id === VIEW_ARM.weaponId;
    this.mesh.visible = isArm;
    if (isArm && !wasArm) {
      // 从徒手以外切回徒手 → 重播举起（mc-lite 切武器时 drawProgress 归零）
      this.drawProgress = 0;
    }
    this._apply();
  }

  /** 触发一次挥动（挖块成功 / 放置成功时调用）。重复触发时从 0 重播。 */
  swing() {
    this.swingElapsed = 0;
    this.swingProgress = 0;
  }

  /**
   * 每渲染帧推进：举手臂缓动 + 挥动进度，并把姿态写入 mesh。
   * 帧率无关：`drawProgress` 按 dt 增量（mc-lite 同式），挥动按 dt 累计（偏离 ②）。
   * @param {number} dt 秒
   */
  update(dt) {
    if (this.drawProgress < 1) {
      this.drawProgress = Math.min(1, this.drawProgress + dt * VIEW_ARM.drawSpeed);
    }
    if (this.swingElapsed < VIEW_ARM.swingDuration) {
      // 上限夹住：一次大 dt（如切页回来）不得让进度越过 1
      this.swingElapsed = Math.min(VIEW_ARM.swingDuration, this.swingElapsed + dt);
      this.swingProgress = this.swingElapsed / VIEW_ARM.swingDuration;
    } else {
      this.swingProgress = 1;
    }
    this._apply();
  }

  /** 把当前状态写进 mesh（位置/旋转/刻度）。纯派生，无副作用。 */
  _apply() {
    const [baseX, baseY, z] = VIEW_ARM.position;
    const drop = Math.pow(1 - this.drawProgress, 2) * VIEW_ARM.drawDrop;
    const p = this.swingProgress;
    const swinging = p < 1;

    // ---- 曲线（v1.49：对齐原版 `ItemInHandRenderer` 的双曲线，取代 mc-lite 的对称单曲线）----
    // 原版有两个**峰值错开**的曲线：
    //   · `attack = sin(√p·π)` —— 峰值在 p=0.25（快出）。主臂下劈跟这条。
    //   · `whip   = sin(p²·π)` —— 峰值在 p≈0.707（滞后）。甩腕（roll）跟这条。
    // mc-lite 只有 `sin(p·π)`（峰在 p=0.5、前后等速）→ 看着生硬，没有“快落慢收”与甩腕。
    const attack = swinging ? Math.sin(Math.sqrt(p) * Math.PI) : 0;
    const whip = swinging ? Math.sin(p * p * Math.PI) : 0;

    // 位移：下劈时向前向下探（原版是骨豁空间的 swingX/swingY/swingZ，这里等比缩到本仓尺度）
    this.mesh.position.set(
      baseX,
      baseY - drop - attack * VIEW_ARM.swingDrop,
      z - attack * VIEW_ARM.swingForward,
    );
    this.mesh.scale.setScalar(VIEW_ARM.scale);

    // 三轴同步：pitch（主下劈，快出曲线）、yaw（横摆，快出曲线）、roll（甩腕，滞后曲线）
    this.mesh.rotation.x = -VIEW_ARM.restPitch - attack * VIEW_ARM.swingArc;
    this.mesh.rotation.y = attack * VIEW_ARM.swingYaw;
    // 静止时两个曲线都归 0 → 三轴严格回零（roll/yaw 不残留）
    this.mesh.rotation.z = whip * VIEW_ARM.swingRoll;
  }

  /** 只读状态（测试 / 调试用）。@returns {{selectedId: string|null, visible: boolean, swingProgress: number}} */
  get state() {
    return { selectedId: this.selectedId, visible: this.mesh.visible, swingProgress: this.swingProgress };
  }

  /** 从相机移除并释放几何/材质（Player.dispose 调用，防 reload 后节点叠加）。 */
  dispose() {
    this.camera.remove(this.mesh);
    this.geometry.dispose();
    this.material.dispose();
  }
}
