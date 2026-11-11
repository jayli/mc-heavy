// tools/guardian-fingerprint.mjs — 末影守卫（Ender Guardian）烘焙的**参数、产物指标与输入指纹**共享模块
//
// 唯一权威（红线 1）：烘焙脚本 `bake-guardian.mjs` 与数据契约门 `check-data.mjs` 都从这里
// import，不得各写一份。与 `ignis-fingerprint.mjs` / `dragon-fingerprint.mjs` 同一手法。
//
// 素材**入库**（`assets/guardian/src/`，与 `assets/ignis/src/` 同口径：烘焙输入，不是渲染资源）
// → 指纹不依赖仓库外文件，任何机器 `npm run check` 结果一致。
//
// ⚠️ node 侧模块（要读文件），不进 `src/`，浏览器不消费。
// ⚠️ **`src/**` 与浏览器单测绝不能 import 它** —— 它依赖 `node:fs`，浏览器无法解析 `node:`
// 协议 → 整个模块不加载 → 游戏白屏，而 `check:arch` 抓不到这类运行时解析失败。
// 运行期消费的纯数据是 `assets/guardian/guardian.json`（产物）与
// `src/entities/guardian/guardian-config.js`（玩法数值）。
//
// ## 素材来源
//
// 姊妹仓库 `cataclysm1.19.2modding`（Java 版 Cataclysm）：
// `client/model/entity/ModelEnder_Guardian.java` + `textures/entity/ender_guardian{,_layer}.png`。
// 与焰魔不同 —— 焰魔用的是 Bedrock 附加包（建模迭代不同），守卫**只有 Java 源**，
// 所以本次是「Java 模型 → 本仓产物」的直接转换（spec §2.1 / §2.2.1）。
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const ROOT = path.resolve(import.meta.dirname, '..');

/** 烘焙输入目录（**入库**，不是渲染资源；绝不放 `assets/textures/` —— 那会被 build-atlas 递归扫描） */
export const GUARDIAN_SRC_DIR = path.join(ROOT, 'assets', 'guardian', 'src');
/** 输入：Java 模型（20 骨骼 / 24 立方体，含四条动画的关键帧） */
export const GUARDIAN_MODEL_SRC = path.join(GUARDIAN_SRC_DIR, 'ModelEnder_Guardian.java');
/** 输入：主贴图（256²） */
export const GUARDIAN_TEX_SRC = path.join(GUARDIAN_SRC_DIR, 'ender_guardian.png');
/**
 * 输入：**眼睛层贴图**（256²，与主贴图分开的一张）。
 *
 * ⚠️⚠️ **与焰魔的盾恰好相反：本层与主贴图 100% 重叠**（2026-11-11 实测）：
 * 主图不透明 23752、layer 非透明（alpha > 0）2749、**交集 2749**、layer 落在主图透明区 **0** 个像素。
 * 原 Mod 的 `RenderType.eyes(...)` 是**叠加层**语义（同一几何再画一遍发光层），
 * 不是焰魔盾那种「补一块空白 UV」。
 *
 * ⇒ 合成必须**直接覆盖**，**不得照搬焰魔的「零重叠预检 + assertNoBodyPollution」**
 * （那会在正确实现上报错）。
 *
 * ⚠️⚠️⚠️ **阈值必须用 `alpha > 0`，不能用焰魔的 `alpha > 128`**（2026-11-11 实测）：
 * layer 的 alpha 只有三种取值 `{0: 62787, 1: 145, 255: 2604}`，而
 * **alpha = 1 的那 145 个像素恰好就是全部真正改色的像素**（alpha = 255 的 2604 个
 * 与主图 RGB **逐位相同**，一个也不改色）。
 * ⇒ 用 `> 128` 会把这 145 个全部丢掉，**合成后画面与不合成完全一样**，
 * 而骨骼数/顶点数/UV/指纹全绿 —— 正是本项目最怕的静默失效型。
 *
 * ⚠️ **拷贝时要连带把 alpha 抬到 255**：渲染器材质是 `alphaTest: 0.5`（与焰魔同口径），
 * 原样拷 alpha = 1 会在片元阶段被 discard，效果等同于没合成。
 *
 * 缺了它的形态：几何/骨骼/UV/指纹全对，只有数贴图才发现守卫眼睛不发光。
 * `check:data` 用**内容级**判据钉住：产物 PNG 在 layer 非透明处与 layer **RGB 逐像素全等**
 * 的像素数必须 === `GUARDIAN_METRICS.layerOpaquePixels`（2749），且这些像素的 alpha 全为 255。
 * ⚠️ 判据不能写成「紫色像素 > 0」——主图自身就有 2885 个紫像素，漏合成时同样 > 0。
 * ⚠️ 也不能取「> 128 口径的 2604」作满值：那在**漏合成时就已经成立**（零判别力）。
 */
export const GUARDIAN_LAYER_TEX_SRC = path.join(GUARDIAN_SRC_DIR, 'ender_guardian_layer.png');

/** 烘焙产物：模型 JSON（进运行期，`src/render/guardian-model.js` 加载） */
export const GUARDIAN_JSON = path.join(ROOT, 'assets', 'guardian', 'guardian.json');
/** 烘焙产物：贴图（进运行期，`TextureLoader` 加载；已合成眼睛层） */
export const GUARDIAN_PNG = path.join(ROOT, 'assets', 'guardian', 'guardian.png');
/** 烘焙产物：伴随元数据（度量 / 指纹，不进运行期） */
export const GUARDIAN_META = path.join(ROOT, 'assets', 'guardian', 'guardian.meta.json');

/**
 * 烘焙参数。
 *
 * ⚠️ **`scale: 1`**（spec §2.2）：素材 16px/格下 bind bbox 是
 * **5.4176 × 4.2844 × 2.9017 格**（宽×高×深，含四肢），约玩家 1.8 格的 2.4 倍。原生就对。
 *
 * ⚠️ **`animFps: 20`** 是 Java/MC 的原生 tick 率（1 tick = 1/20 秒）。四条动画的
 * `frameCount` 直接等于 tick 数，`duration = ticks / 20`。
 *
 * ⚠️ **`rotationConvention: 'java-zyx-additive'`**（照焰魔 v2.58 先例）：
 * 骨骼旋转 `R = Rz(−θz) · Ry(+θy) · Rx(−θx)`，关键帧与 bind 欧拉角**逐轴相加**。
 * 标准右手系 `Euler('XYZ')` 会把出招方向拧反，而「关键帧数值与原版一致」证明不了姿态一致。
 *
 * ⚠️⚠️ **`coordinateConvention: 'java-local-flipy'`（本次新增，spec §2.2.1 的口径 A）**：
 * Java `addBox` 的 origin 是**骨骼局部**坐标，Bedrock 是**绝对模型**坐标 —— 两者不是一回事。
 * 本仓取口径 A：**保留 Java 的局部顶点**，只做 `y → −y` 翻转；
 * `bones[].localPosition = pos / 16`（y 取反）、`bones[].pivot` 恒为 `[0,0,0]`。
 *
 * 连带影响（三处必须同口径，否则整体差 1.5 格）：
 *  - `metrics.feetOffsetY = −1.5`（root 的 Java pos.y = 24 ⇒ 24/16 = 1.5，翻转后 −1.5）；
 *  - `bones[0].localPosition` 逐位 `[0, −1.5, 0]`（口径哨兵，`check:data` 钉住）；
 *  - 渲染器每帧 `bone.position = localPosition + delta.pos`，
 *    **不是**焰魔的 `pivot − R·pivot + delta`（那是绝对坐标口径的公式，用在这里会让模型炸成碎片）。
 *
 * ⚠️ **两个 convention 都是烘焙「算法」的版本标记，不是可调参数。**
 * 输入指纹只覆盖输入文件与参数，**改烘焙算法而不动参数时指纹不变**（本文件下方已记的盲区）——
 * 坐标/旋转约定恰恰是这类改动：它们不改任何输入，却改变产物里每一个顶点与每一帧的姿态。
 * 写进参数 ⇒ 换约定必换指纹 ⇒ `check:data` 会报「产物已过期，跑 npm run guardian」。
 */
export const GUARDIAN_BAKE_PARAMS = Object.freeze({
  scale: 1,
  pxPerBlock: 16,
  textureSize: 256,
  animFps: 20,
  rotationConvention: 'java-zyx-additive',
  coordinateConvention: 'java-local-flipy',
});

/**
 * 素材里的动画名（Java `Animation.create(...)` 的静态字段名），烘焙脚本按此取。
 *
 * ⚠️ 上勾拳的素材名带 `AND_BULLET`（原版这一招会发射弹丸），但用户裁定
 * **纯近战无弹丸** ⇒ 本仓只取它的骨骼动画，不实现弹丸（spec §1）。名字保持原样，
 * 便于与 Java 源对照。
 */
export const GUARDIAN_ANIM_SOURCES = Object.freeze({
  /** 右重击（Java `GUARDIAN_RIGHT_STRONG_ATTACK`，60 tick） */
  strong_right: 'GUARDIAN_RIGHT_STRONG_ATTACK',
  /** 左重击（Java `GUARDIAN_LEFT_STRONG_ATTACK`，60 tick） */
  strong_left: 'GUARDIAN_LEFT_STRONG_ATTACK',
  /** 上勾拳（Java `GUARDIAN_UPPERCUT_AND_BULLET`，关键帧 90 tick） */
  uppercut: 'GUARDIAN_UPPERCUT_AND_BULLET',
  /** 踩踏（Java `GUARDIAN_STOMP`，48 tick） */
  stomp: 'GUARDIAN_STOMP',
});

/**
 * 产物必须满足的指标 —— 烘焙脚本与 `check:data` 共用这一份。
 *
 * 全部实测值（解析 `assets/guardian/src/ModelEnder_Guardian.java` 可复现，
 * `node tools/guardian-java-reference.mjs` 独立复算）：
 *  - **20 根骨骼**、**24 个立方体**，其中 mirror 7 个、负 inflate 1 个、**零尺寸 0 个**
 *    ⇒ 与焰魔不同，**没有任何立方体被跳过**（`bakedCubes === cubeCount`）
 *  - 每立方体 `BoxGeometry` 24 顶点 / 36 索引 ⇒ `24 × 24 = 576` 顶点、`24 × 36 = 864` 索引
 *
 * ⚠️ **`animTicks` 取「关键帧覆盖的 tick 数」，不是 `Animation.create(n)` 的声明值**：
 * 上勾拳声明 `Animation.create(100)` 但关键帧只到 **90** tick。照声明值烘焙会多出
 * 0.5 秒的静止尾巴（帧数/指纹全对，只有看动画才发现）。左右重击与踩踏的声明值与关键帧一致。
 *
 * ⚠️ **`boneCount` / `cubeCount` 是「素材事实」而不是「可调参数」**：素材换了它们才会变。
 * 钉在这里的意义是「烘焙漏了骨骼/立方体」会立刻被抓到（静默缺肉的形态是身上有洞）。
 */
export const GUARDIAN_METRICS = Object.freeze({
  boneCount: 20,
  cubeCount: 24,
  /** 实际参与烘焙的立方体数 —— 零尺寸盒 0 个 ⇒ 等于 cubeCount */
  bakedCubes: 24,
  vertexCount: 576,
  indexCount: 864,
  /**
   * 眼睛层贴图里的**非透明**像素数（**alpha > 0**）= **2749**。
   *
   * ⚠️⚠️ **阈值是 `> 0` 而不是焰魔的 `> 128`**（字段名沿用 `OpaquePixels` 只为与焰魔同形）：
   * layer 的 alpha 只有 `{0, 1, 255}` 三种，**alpha = 1 的 145 个像素是全部真正改色的像素**；
   * `> 128` 只能数到 2604，而那 2604 个与主图逐位相同 ⇒ 那个口径下「合成」是空操作。
   *
   * ⚠️ 这条度量是**内容级**判据：结构判据（骨骼数/顶点数/UV 值域）在「眼睛层漏合成」时
   * **全部通过**，只有「数一数贴图里到底有没有东西」才能抓住它。
   *
   * ⚠️⚠️ **判据必须取「RGB 逐像素全等的像素数 === 2749」这个满值，不能取「> 0」或「接近」**：
   * 实测漏合成时全等数仍有 **2604**（主图与 layer 本就大面积同色，只差 145 像素）。
   * 对照：漏合成 2604 / 正确合成 2749。
   */
  layerOpaquePixels: 2749,
  /**
   * 合成后真正发生改色的像素数 = **145**（= alpha 为 1 的那一批）。
   *
   * 它是「合成确实改了东西」的**正向**判据，与 `layerOpaquePixels` 的「覆盖完整」判据互补：
   * 前者拓「抬阈值把改色像素全丢了」，后者拓「只改了部分」。
   */
  layerChangedPixels: 145,
  /** 各动画的关键帧 tick 数（不是声明值，见上方说明） */
  animTicks: Object.freeze({
    strong_right: 60,
    strong_left: 60,
    uppercut: 90,
    stomp: 48,
  }),
});

/**
 * 烘焙输入指纹：`<三份输入内容 sha 前 16>:<参数 sha 前 16>`。
 *
 * 两个消费方（烘焙脚本写进 meta、`check:data` 重算比对）必须拿到同一格式，
 * 且**与 `ignisInputFingerprint()` 同形状**（返回 `{input, sourceSha256, paramsSha256}`）。
 *
 * ⚠️ **三份输入串联后取一次 sha**（不是各自取 sha 再拼）：拼接顺序固定
 * （model → png → layerPng），换顺序会换指纹，这是刻意的 —— 指纹描述的是「这一组输入」。
 *
 * ⚠️ **眼睛层贴图必须进指纹**：它参与合成产物 PNG，改了它不重烘就是
 * 「眼睛造型静默变了但产物没变」——正是指纹要防的那类过期。
 *
 * 已知盲区（与图标/夜空/巨树/高台/竞技场/中世纪船/龙/焰魔同口径）：只改**烘焙算法**而不动
 * 参数时指纹不变 —— 那类改动靠产物契约测试与 Tier 4 兜住；两个 `*Convention` 参数已把
 * 最容易静默失效的两类算法改动纳入指纹。
 *
 * @returns {{input: string, sourceSha256: string, paramsSha256: string}}
 */
export function guardianInputFingerprint() {
  for (const [label, p] of [
    ['Java 模型', GUARDIAN_MODEL_SRC], ['贴图', GUARDIAN_TEX_SRC],
    ['眼睛层贴图', GUARDIAN_LAYER_TEX_SRC],
  ]) {
    if (!fs.existsSync(p)) {
      throw new Error(`[守卫] 烘焙输入缺失（${label}）：${p}（素材入库，缺失 = 仓库损坏）`);
    }
  }
  const hash = createHash('sha256');
  for (const p of [GUARDIAN_MODEL_SRC, GUARDIAN_TEX_SRC, GUARDIAN_LAYER_TEX_SRC]) {
    hash.update(fs.readFileSync(p));
  }
  const sourceSha256 = hash.digest('hex');
  const paramsSha256 = createHash('sha256')
    .update(JSON.stringify({ GUARDIAN_BAKE_PARAMS, GUARDIAN_METRICS, GUARDIAN_ANIM_SOURCES }))
    .digest('hex');
  return {
    input: `${sourceSha256.slice(0, 16)}:${paramsSha256.slice(0, 16)}`,
    sourceSha256,
    paramsSha256,
  };
}