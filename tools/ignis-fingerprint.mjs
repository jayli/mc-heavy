// tools/ignis-fingerprint.mjs — 焰魔（Ignis）烘焙的**参数、产物指标与输入指纹**共享模块
//
// 唯一权威（红线 1）：烘焙脚本 `bake-ignis.mjs` 与数据契约门 `check-data.mjs` 都从这里
// import，不得各写一份。与 `dragon-fingerprint.mjs` / `arena-fingerprint.mjs` /
// `zombie-skin-fingerprint.mjs` 同一手法。
//
// 素材**入库**（`assets/ignis/src/`，与 `assets/dragon/src/` 同口径：烘焙输入，不是渲染资源）
// → 指纹不依赖仓库外文件，任何机器 `npm run check` 结果一致。
//
// ⚠️ node 侧模块（要读文件），不进 `src/`，浏览器不消费。
// ⚠️ **`src/**` 与浏览器单测绝不能 import 它** —— 它依赖 `node:fs`，浏览器无法解析 `node:`
// 协议 → 整个模块不加载 → 游戏白屏，而 `check:arch` 抓不到这类运行时解析失败。
// 运行期消费的纯数据是 `assets/ignis/ignis.json`（产物）与 `src/entities/ignis/ignis-config.js`
// （玩法数值）。
//
// ## 素材来源（2026-11-05 用户提供）
//
// `[苦力怕论坛]v1.3.0-焰魔.mcaddon`（Bedrock 附加包，zip 内 GBK 编码路径）。
// 与姊妹仓库 `cataclysm1.19.2modding`（Java 版同 mod）的对照见
// `docs/superpowers/specs/2026-11-05-ignis-boss-design.md` §2.0：
// 贴图逐像素相同，但模型是**不同的建模迭代**（剑/盾骨骼拆分不同）⇒ 采用 Bedrock 版。
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const ROOT = path.resolve(import.meta.dirname, '..');

/** 烘焙输入目录（**入库**，不是渲染资源） */
export const IGNIS_SRC_DIR = path.join(ROOT, 'assets', 'ignis', 'src');
/** 输入：Bedrock 几何（53 骨骼 / 88 立方体 / 256² 贴图） */
export const IGNIS_GEO_SRC = path.join(IGNIS_SRC_DIR, 'ignis.geo.json');
/** 输入：Bedrock 动画（84 条；本仓只取 idle 与 attack） */
export const IGNIS_ANIM_SRC = path.join(IGNIS_SRC_DIR, 'ignis.animation.json');
/**
 * 输入：贴图（256²）。
 *
 * ⚠️ **只取 `ignis_idle_0.png` 这一张**：素材有 `idle_0`~`idle_7` 八帧火焰闪烁
 * （render_controller 按 `q.life_time * 12` 循环切帧），但用户 2026-11-05 裁定
 * **只取一张静态贴图**（与飞龙同口径）。八帧里第 0 帧是基准姿态，其余是火焰位移。
 */
export const IGNIS_TEX_SRC = path.join(IGNIS_SRC_DIR, 'ignis_idle_0.png');
/**
 * 输入：**盾的贴图**（256²，与主贴图分开的一张）。
 *
 * ⚠️⚠️ **主贴图里没有盾的任何像素**（2026-11-08 实测）：盾的 240 个顶点 UV 落在
 * `ignis_idle_0.png` 的一块**全透明区域**（盾 UV 覆盖的 771 像素里主贴图只有 23 个不透明），
 * 而同一区域在本文件里是 346 个不透明像素。原 Mod 的 `ignis.render_controllers.json` 把盾做成
 * **独立 render controller**（`Texture.shield` + `part_visibility: {"*": false, "shield*": true}`），
 * 即盾从来就用第二张贴图。
 *
 * 缺了它的形态：几何/骨骼/UV 全对、`check:data` 的结构判据全绿，但渲染器材质的
 * `alphaTest: 0.5` 把每个盾面判为透明 ⇒ **盾画了却一个像素也看不见**（用户 2026-11-08 报告
 * 「游戏里没见到焰魔携带盾牌」的真根因）。
 *
 * 烘焙期由 `bake-ignis.mjs` 把它**合成进**主贴图（两张图不透明像素零重叠，实测 8 帧 idle
 * 全为 0），运行期仍是单贴图单材质 ⇒ 零 draw call 增加、渲染器不必改。
 *
 * ⚠️ **只取基础版**：素材另有 `ignis_shield_crack1~3`（破盾裂纹）与 `ignis_soul_shield`
 * （魂态），本轮「只做视觉」不取；将来做破盾玩法时再加。
 */
export const IGNIS_SHIELD_TEX_SRC = path.join(IGNIS_SRC_DIR, 'ignis_shield.png');

/** 烘焙产物：模型 JSON（进运行期，`src/render/ignis-model.js` 加载） */
export const IGNIS_JSON = path.join(ROOT, 'assets', 'ignis', 'ignis.json');
/** 烘焙产物：贴图（进运行期，`TextureLoader` 加载） */
export const IGNIS_PNG = path.join(ROOT, 'assets', 'ignis', 'ignis.png');
/** 烘焙产物：伴随元数据（度量 / 指纹，不进运行期） */
export const IGNIS_META = path.join(ROOT, 'assets', 'ignis', 'ignis.meta.json');

/**
 * 烘焙参数。
 *
 * ⚠️ **`scale: 1`**（用户 2026-11-05 裁定「原生 1 倍」）：素材 16px/格下模型是
 * **3.73 × 4.07 × 5.16 格**（含剑尖，已由软件光栅化实测），约玩家 1.8 格的 2.2 倍。
 * 与飞龙的 `scale: 3` 不同 —— 飞龙的素材原生只有 6.25 格长，需要放大；焰魔原生就对。
 *
 * ⚠️ **`pxPerBlock: 16`** 是 Bedrock/MC 的原生口径（1 格 = 16 像素）。
 *
 * ⚠️ **`idleFrameCount: 60` 与 `IGNIS_ANIM_PERIODS.idle` 是同一个事实的两面**：
 * 待机动画的角速度是 128 **度/秒**（素材表达式 `q.life_time * 128` —— Molang 的三角函数
 * 以度为单位），周期 `360/128 = 2.8125` 秒。取 60 帧覆盖**恰好一个**周期，
 * `fps = 60 / 2.8125 = 21.333`（**不是整数，这是刻意的**）⇒ 产物 `duration` 与周期
 * **逐位相等**，循环接缝在数学上恒为 0。每帧转 `128/60 = 2.13°` ⇒ 缓慢呼吸是平滑的。
 *
 * ⚠️ **曾经取 12 帧**（当时误把周期算成 `2π/128` = 0.049 秒的快频摆动，12 帧正好一个周期）。
 * 度制修正后周期变成 2.8125 秒（**57 倍长**），12 帧会退化成每帧 10.67° 的可见跳帧。
 *
 * ⚠️ **`rotationConvention`（v2.58）是烘焙「算法」的版本标记，不是可调参数。**
 * 输入指纹只覆盖输入文件与参数，**改烘焙算法而不动参数时指纹不变**（本文件下方已记的盲区）——
 * 旋转约定恰恰是这类改动：它不改任何输入，却改变产物里每一根骨骼的 bind 四元数与每一帧的姿态。
 * 把约定写进参数 ⇒ 换约定必换指纹 ⇒ `check:data` 会报「产物已过期，跑 npm run ignis」。
 *
 * 取值 `'java-zyx-additive'` 的含义（权威说明见 `tools/bake-ignis.mjs` 的 `bedrockRotation`）：
 * 骨骼旋转 `R = Rz(−θz) · Ry(+θy) · Rx(−θx)`（Z→Y→X 作用顺序，X/Z 取反），关键帧与 bind 欧拉角**逐轴相加**。
 * 曾经的 `'xyz-composed'`（`Euler('XYZ')` + `bind × delta`）把蓄力翻成向身后抡、劈砍翻成向前尖刺。
 */
export const IGNIS_BAKE_PARAMS = Object.freeze({
  scale: 1,
  pxPerBlock: 16,
  textureSize: 256,
  /** 待机动画的帧率不是这个值 —— 它由 `idleFrameCount / 周期` 算出。此字段只用于攻击 */
  defaultFps: 30,
  idleFrameCount: 60,
  rotationConvention: 'java-zyx-additive',
});

/**
 * 动画周期（秒）。**由素材内容计算，不写字面量**。
 *
 * - `idle`：素材 `generala`/`generalb` 的表达式是 `Math.sin(q.life_time * 128)`，
 *   而 **Molang 的三角函数以「度」为单位**（不是弧度）⇒ 角速度 128 **度/秒**
 *   ⇒ 周期 `360 / 128 = 2.8125` 秒。
 *
 *   ⚠️⚠️ **不是 `2π/128`（那是弧度的算法）**：2026-11-05 实测踩到 —— 按弧度算得到
 *   0.049 秒的周期，把「缓慢呼吸」变成了 20.4 Hz 的抖动（用户实玩报告「身体在抖动」）。
 *   两者相差 **57 倍**，而「帧数 = 12、duration ≡ 周期」这个产物契约在两种口径下都自洽，
 *   所以只有**求值器的单位口径**拦得住（`src/tests/test-molang.js` 的度制用例）。
 * - `attack`：素材 `attack6a` 的 `animation_length` = 2.75 秒（55 tick）。
 *   ⚠️ **不是 `attack1`（3.5 秒 / 70 tick）** —— tick 配对表（spec §2.0）显示 55 tick
 *   ↔ Java `SWING_ATTACK`，而 `attack1` 对应 `SHIELD_SMASH_ATTACK`（盾碎）。
 * - `spin`（v2.75）：素材 `attack8a3` 的 `animation_length` = 1.9 秒（38 tick），
 *   ↔ Java `SPIN_ATTACK`（`Animation.create(38)`）。
 *   ⚠️ 38 tick 在素材里有 4 条候选，**只有 `attack8a3`** 在 t=0.0 / 0.5 的九根骨骼上与
 *   `SPIN_ATTACK` 非破盾分支逐位相等（`attack8b3` = 破盾变体，`attack8a2/b2` =
 *   `HORIZONTAL_SMALL_SWING_ALT_ATTACK2`）。详见 `ignis-config.js` 的 `IGNIS_ATTACKS`。
 * - `shieldSmash`（v3.01）：素材 `attack1` 的 `animation_length` = 3.5 秒（70 tick），
 *   ↔ Java `SHIELD_SMASH_ATTACK`（`Animation.create(70)`）。
 *   ⚠️ 2026-11-13 实测扫描全部 82 条 ignis 动画：`attack1` 与 `SHIELD_SMASH_ATTACK`
 *   共有骨骼关键帧最大逐轴差 **15.000°**（对照组 `attack6a ↔ SWING_ATTACK` 12.462°，同量级），
 *   第二名 30° 已是 2 倍。且 3.5s 的候选只有 4 条，其余三条是阶段转换（`phase_soul*`）。
 */
export const IGNIS_ANIM_PERIODS = Object.freeze({
  idle: 360 / 128,
  attack: 2.75,
  spin: 1.9,
  /** v3.01：Java `Animation.create(70)` ÷ 20 = 3.5 秒（素材 `attack1`） */
  shieldSmash: 3.5,
});

/** 素材里的动画键名（`animation.null.<name>`），烘焙脚本按此取 */
export const IGNIS_ANIM_SOURCES = Object.freeze({
  /** 待机：**两条**动画合并（generala 驱动手臂、generalb 驱动 root/head） */
  idle: Object.freeze(['generala', 'generalb']),
  /** 普攻：蓄力 → 原地横扫（Java 的 SWING_ATTACK，55 tick） */
  attack: Object.freeze(['attack6a']),
  /**
   * 旋斩（v2.75）：整圈旋转 + 剑横持（Java 的 `SPIN_ATTACK`，38 tick）。
   *
   * ⚠️ **借助同一素材里的另一条动画（不新增任何资源）**。素材自带 84 条，本仓 v2.55
   * 只取了 2 条（idle + attack）；本键让烘焙器多取一条，**输入文件与贴图逐字节不变**。
   */
  spin: Object.freeze(['attack8a3']),
  /**
   * 持盾冲撞（v3.01）：举盾过顶后连人带盾向前下方压（Java 的 `SHIELD_SMASH_ATTACK`，70 tick）。
   * ⚠️ 不是「盾砸地」：实测盾尖最低只到 2.43 格（自己的胸腰高度），从未触地。
   *
   * ⚠️⚠️ **是 `attack1`，不是 `attack1_2`**：后者是 3s / 11 骨骼的另一招，
   * 同一探针下与 `SHIELD_SMASH_ATTACK` 差 **72.5°**（而 `attack1` 只差 15.0°）。
   * 键名只差三个字符，写错会烘焙出另一招而部分计数类判据仍通过。
   * 鉴别依据与完整扫描表见 spec §2.2（`2026-11-13-ignis-shield-smash-design.md`）。
   * 同旋斩：**零新增资源**，只是让烘焙器多取一条已入库的动画。
   */
  shieldSmash: Object.freeze(['attack1']),
});

/**
 * 产物里属于「招式」的动画键（= `IGNIS_ANIM_SOURCES` 里除 idle 以外的全部）。
 *
 * 烘焙器按这张表**逐招**导出，`check:data` 按它逐招校验帧数 —— 新增一招只需在
 * `IGNIS_ANIM_SOURCES` 加一条，两个消费方自动跟上（不写第二份清单）。
 */
export const IGNIS_ATTACK_ANIM_KEYS = Object.freeze(
  Object.keys(IGNIS_ANIM_SOURCES).filter((k) => k !== 'idle'),
);

/**
 * 产物必须满足的指标 —— 烘焙脚本与 `check:data` 共用这一份。
 *
 * 全部实测值（解析 `assets/ignis/src/ignis.geo.json` 可复现）：
 *  - **53 根骨骼**，其中 50 根挂了立方体，但**只有 43 根**的立方体是非零尺寸
 *  - **88 个立方体**，其中 **8 个含 0 尺寸分量**（`right_helmet` 这类零厚薄片，
 *    `BoxGeometry` 对 0 尺寸会退化成退化三角形 ⇒ 跳过）⇒ **烘焙 80 个**
 *  - 每立方体 `BoxGeometry` 产出 24 顶点 / 36 索引 ⇒ `80 × 24 = 1920` 顶点、
 *    `80 × 36 = 2880` 索引
 *  - bind pose 的模型空间 bbox（含骨骼旋转、含剑盾）= **78.07 × 61.35 × 82.52 px**
 *    = **4.8796 × 3.8346 × 5.1576 格**（宽×高×深，1 倍）
 *    ⚠️ v2.58 前冻结为 3.7329 × 4.0668 × 5.1576，那是**错误旋转约定**下的值；现值由
 *    `node tools/ignis-java-reference.mjs` 直接解析 Java 源码独立复算，与产物逐位一致。
 *
 * ⚠️ **`boneCount` / `cubeCount` 是「素材事实」而不是「可调参数」**：素材换了它们才会变。
 * 把它们钉在这里的意义是「烘焙漏了骨骼/立方体」会立刻被抓到（静默缺肉的形态是身上有洞）。
 */
export const IGNIS_METRICS = Object.freeze({
  boneCount: 53,
  /** 几何里挂了至少一个立方体的骨骼数（含只有零尺寸薄片的那些）= 50 */
  bonesWithAnyCubes: 50,
  /**
   * 实际有「非零尺寸立方体」被烘焙的骨骼数 = **43**。
   *
   * ⚠️ **不能是 50**：另 7 根骨骼只挂了零尺寸薄片（如 `right_helmet` 的 `[0,5,7]`），
   * 全部被跳过 ⇒ 它们不贡献任何顶点。这是实测值（2026-11-05 逐骨骼统计），
   * 写成 50 会让烘焙器在正确的实现上报错。
   */
  bonesWithCubes: 43,
  cubeCount: 88,
  /** 含 0 尺寸分量、被跳过的立方体数 */
  skippedCubes: 8,
  /** 实际参与烘焙的立方体数 = cubeCount − skippedCubes */
  bakedCubes: 80,
  vertexCount: 1920,
  indexCount: 2880,
  scale: 1,
  /**
   * 盾贴图（`IGNIS_SHIELD_TEX_SRC`）里的不透明像素数（alpha > 128）= **5816**。
   *
   * ⚠️ 这条度量是**内容级**判据：结构判据（骨骼数/顶点数/UV 值域）在「盾不可见」时
   * **全部通过**，只有「数一数贴图里到底有没有东西」才能抓住它。`check:data` 用它交叉
   * 核对烘焙产物确实把盾贴图叠了进来（产物 PNG 的盾 UV 区域不透明像素 > 0）。
   */
  shieldOpaquePixels: 5816,
});

/**
 * 烘焙输入指纹：`<四份输入内容 sha 前 16>:<参数 sha 前 16>`。
 *
 * 两个消费方（烘焙脚本写进 meta、`check:data` 重算比对）必须拿到同一格式。
 * 改 `IGNIS_BAKE_PARAMS` / `IGNIS_METRICS` / `IGNIS_ANIM_PERIODS` / 任一输入文件都会改变
 * 指纹 → 门禁报「产物已过期，跑 npm run ignis」，防静默过期。
 *
 * ⚠️ **四份输入串联后取一次 sha**（不是各自取 sha 再拼）：拼接顺序固定
 * （geo → anim → png → shieldPng），换顺序会换指纹，这是刻意的 —— 指纹描述的是「这一组输入」。
 *
 * ⚠️ v2.83（2026-11-08）起**盾贴图也进指纹**：它参与合成产物 PNG，改了它不重烘就是
 * 「盾的造型静默变了但产物没变」——正是指纹要防的那类过期。
 *
 * 已知盲区（与图标/夜空/巨树/高台/竞技场/中世纪船/龙同口径）：只改**烘焙算法**而不动参数时
 * 指纹不变 —— 那类改动靠 `src/tests/test-ignis-bake.js` 的产物契约与 Tier 4 兜住。
 *
 * @returns {{input: string, sourceSha256: string, paramsSha256: string}}
 */
export function ignisInputFingerprint() {
  for (const [label, p] of [
    ['几何', IGNIS_GEO_SRC], ['动画', IGNIS_ANIM_SRC], ['贴图', IGNIS_TEX_SRC],
    ['盾贴图', IGNIS_SHIELD_TEX_SRC],
  ]) {
    if (!fs.existsSync(p)) {
      throw new Error(`[焰魔] 烘焙输入缺失（${label}）：${p}（素材入库，缺失 = 仓库损坏）`);
    }
  }
  const hash = createHash('sha256');
  for (const p of [IGNIS_GEO_SRC, IGNIS_ANIM_SRC, IGNIS_TEX_SRC, IGNIS_SHIELD_TEX_SRC]) {
    hash.update(fs.readFileSync(p));
  }
  const sourceSha256 = hash.digest('hex');
  const paramsSha256 = createHash('sha256')
    .update(JSON.stringify({ IGNIS_BAKE_PARAMS, IGNIS_METRICS, IGNIS_ANIM_PERIODS, IGNIS_ANIM_SOURCES }))
    .digest('hex');
  return {
    input: `${sourceSha256.slice(0, 16)}:${paramsSha256.slice(0, 16)}`,
    sourceSha256,
    paramsSha256,
  };
}
