// src/render/view-arm-data.js — 第一人称手臂的**几何与皮肤版式数据**（v3.46，three-free）
//
// ## 为什么单独成文件
//
// `view-arm.js` 依赖 three（Mesh / Material / Texture），而**烘焙脚本与门禁在 Node 侧**
// 要读同一份 UV 表与几何常数，它们没有 three 解析映射（实测 `ERR_MODULE_NOT_FOUND`）。
//
// 手法同 `render/zombie-model.js`（那个文件本身就是 three-free 的纯数据，
// `tools/zombie-skin-fingerprint.mjs` 直接 re-export 它）。
//
// ⚠️ **本文件不得 import three**，也不得 import 任何依赖 three 的模块。
// 数值与 UV 的**唯一权威在这里**，`view-arm.js` 只 import 不另写一份（红线 1）。

/** 皮肤图边长（标准 Minecraft 64×64 版式） */
export const PLAYER_SKIN_SIZE = 64;

/**
 * 手臂与袖子的六面 UV 矩形（**唯一权威**）。
 *
 * 来源：上游 OpusCraft `src/render/model.ts:161` 的 `right_arm`
 *（cube u=40 v=16，袖子 u=40 v=32），按 `boxFaces(u, v, w=4, h=12, d=4)` 展开：
 *   top    = (u+d,     v,     w, d)
 *   bottom = (u+d+w,   v,     w, d)
 *   right  = (u,       v+d,   d, h)
 *   front  = (u+d,     v+d,   w, h)
 *   left   = (u+d+w,   v+d,   d, h)
 *   back   = (u+d+w+d, v+d,   w, h)
 *
 * ⚠️ **面名 → three BoxGeometry 面的映射是载荷性的**：上游 `front` 是 **−Z**（NORTH），
 * `back` 是 **+Z**（SOUTH）—— 与 Minecraft 的朝向约定一致，**不是**「front = +Z」。
 * 写反会让手臂的前后两面对调（观感是袖口跑到手背上），而所有计数判据全绿。
 *
 * 格式：`[u1, v1, u2, v2]`（像素，左上原点）。袖子层 = 基础层 v + 16。
 */
export const PLAYER_SKIN_UV = Object.freeze({
  /** 右臂基础层（u=40, v=16）：袖口 4 行衬衫色 + 裸露前臂 */
  arm: Object.freeze({
    px: Object.freeze([40, 20, 44, 32]),   // right
    nx: Object.freeze([48, 20, 52, 32]),   // left
    py: Object.freeze([44, 16, 48, 20]),   // top（肩端）
    ny: Object.freeze([48, 16, 52, 20]),   // bottom（手端）
    pz: Object.freeze([52, 20, 56, 32]),   // back (+Z)
    nz: Object.freeze([44, 20, 48, 32]),   // front (−Z)
  }),
  /** 右臂外套层（u=40, v=32）：整段衬衫色（上游该段未绘制，本仓补上，见设计稿 §4.4） */
  sleeve: Object.freeze({
    px: Object.freeze([40, 36, 44, 48]),
    nx: Object.freeze([48, 36, 52, 48]),
    py: Object.freeze([44, 32, 48, 36]),
    ny: Object.freeze([48, 32, 52, 36]),
    pz: Object.freeze([52, 36, 56, 48]),
    nz: Object.freeze([44, 36, 48, 48]),
  }),
});

/** 手臂盒（像素，上游 `right_arm` 的 cube；渲染时 /16） */
export const ARM_CUBE = Object.freeze({ x: -3, y: -2, z: -2, w: 4, h: 12, d: 4 });

/** 部件支点（像素，上游 `ModelPart` 的 pivot；渲染时 /16） */
export const ARM_PIVOT = Object.freeze([-5, 2, 0]);

/** 袖子外扩（像素，上游 `inflate: 0.25`） */
export const ARM_SLEEVE_INFLATE = 0.25;

/** 静止时手臂绕 Z 的外张角（**弧度**，上游 `drawArm` 的 `arm.zRot = 0.1`） */
export const ARM_REST_ROLL = 0.1;

/**
 * 挥动总时长（秒）—— 上游 `swingDuration()` 返回 **6 tick**，60Hz ⇒ 0.1s。
 * ⚠️ 本仓上一版是 1/6 秒（mc-lite 的 10 帧口径）；照抄上游后缩短 40%。
 */
export const ARM_SWING_DURATION = 6 / 60;

/**
 * 上游 `renderArm` 的 11 步变换链常数（`handRenderer.ts`，逐字）。
 *
 * 曲线只有四条：
 *   · `sin(√p·π)`  —— 峰在 p=0.25（**快出**）
 *   · `sin(p²·π)`  —— 峰在 p≈0.707（**滞后**，甩腕）
 *   · `sin(√p·2π)` —— 双频，上下探
 *   · `sin(p·π)`   —— 对称，前后探
 */
export const ARM_POSE = Object.freeze({
  /** `f2 = −0.3·sin(√p·π)` 的幅度 */
  swingX: -0.3,
  /** `f3 = 0.4·sin(√p·2π)` 的幅度 */
  swingY: 0.4,
  /** `f4 = −0.4·sin(p·π)` 的幅度 */
  swingZ: -0.4,
  /** 就位平移基准（上游 `f·(f2+0.64000005)` / `f3−0.6+equip·(−0.6)` / `f4−0.71999997`） */
  baseX: 0.64000005,
  baseY: -0.6,
  baseZ: -0.71999997,
  /** equip（收起进度）的下移量 */
  equipDrop: -0.6,
  /** 第一次 `rotY(f·45)` */
  baseYaw: 45,
  /** `rotY(f·sin(√p·π)·70)` —— 主摆动轴 */
  swingYaw: 70,
  /** `rotZ(f·sin(p²·π)·(−20))` —— 甩腕（滞后曲线） */
  swingRoll: -20,
  /** 第二次平移 `translate(f·(−1), 3.6, 3.5)` */
  boneShift: Object.freeze([-1, 3.6, 3.5]),
  /** 骨骼空间三连转 `rotZ(f·120) / rotX(200) / rotY(f·(−135))` */
  boneRoll: 120,
  bonePitch: 200,
  boneYaw: -135,
  /** 第三次平移 `translate(f·5.6, 0, 0)` */
  boneOffsetX: 5.6,
});