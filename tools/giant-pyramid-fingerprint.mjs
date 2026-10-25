// tools/giant-pyramid-fingerprint.mjs — 巨型金字塔烘焙的**映射表、产物指标与输入指纹**共享模块
//
// 唯一权威（红线 1）：烘焙脚本 `bake-giant-pyramid.mjs` 与数据契约门 `check-data.mjs`
// 都从这里 import，不得各写一份。与 `giant-trees-fingerprint.mjs` /
// `cloudland-mesa-fingerprint.mjs` 同一手法。
//
// 素材**入库**（`assets/giant-pyramid/src/`，与 `assets/giant-trees/src/` 同口径：
// 烘焙输入，不是渲染资源）→ 指纹不依赖仓库外文件，任何机器 `npm run check` 结果一致。
//
// ⚠️ node 侧模块（要读文件），不进 `src/`，浏览器不消费。
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const ROOT = path.resolve(import.meta.dirname, '..');

/** 烘焙输入（**入库**，不是渲染资源） */
export const LITEMATIC_PATH = path.join(ROOT, 'assets', 'giant-pyramid', 'src', 'small_pyramid_maze.litematic');
/** 烘焙产物：结构 JSON（进运行期，经 structure-json.js 加载） */
export const PYRAMID_JSON = path.join(ROOT, 'assets', 'structures', 'giant_pyramid.json');
/** 烘焙产物：伴随元数据（尺寸 / 计数 / 指纹，不进运行期） */
export const PYRAMID_META = path.join(ROOT, 'assets', 'structures', 'giant_pyramid.meta.json');

/**
 * 直台阶的 `facing` → 本仓 `meta` 低 2 位的 orient。
 *
 * ⚠️ **这两半都是实测出来的，不能按 Minecraft 定义推断**：
 *
 * **半 1 — orient → 高侧方向**（用**真实 mesher** 量：给一个 `planks_step` 方块分别设
 * orient = 0/1/2/3，读 `buildSectionMesh` 发射出的顶点里「y ∈ [0.5,1] 那半部」的 bbox）：
 *
 *   orient=0 → 高侧 x∈[0,0.5]     = **西 / -X**
 *   orient=1 → 高侧 z∈[0.5,1]     = **南 / +Z**
 *   orient=2 → 高侧 x∈[0.5,1]     = **东 / +X**
 *   orient=3 → 高侧 z∈[0,0.5]     = **北 / -Z**
 *
 * **半 2 — `facing` 语义 = 高侧**（对素材全部 1173 格直台阶统计）：
 *   · `facing` 方向同层有实心 39~47%（前方可能是更高的台阶/墙）
 *   · `facing` **反**方向同层有实心 **100%**（那是"低的那一侧"/走过来的一侧）
 *   · 楼梯 `facing` 方向朝塔心 **1173 / 1173 = 100%**（塔是向内收的阶梯，高侧朝内）
 *   ⇒ `facing` 指向**高半部**。
 *
 * 若怀疑这张表：`npm run pyramid -- --census-orient` 会现场重测并打印 orient → 高侧。
 * ⚠️ **不要从 `src/player/orientation.js` 推这张表** —— 那个模块管的是「放置时方块朝向
 * 玩家 yaw」的三分支逻辑，与 `TEMPLATES.planks_step` 的高侧在哪无关（实测确认）。
 */
export const FACING_TO_ORIENT = Object.freeze({
  west: 0,   // 高侧 -X
  south: 1,  // 高侧 +Z
  east: 2,   // 高侧 +X
  north: 3,  // 高侧 -Z
});

/**
 * 源方块名 → 目标方块名。**空串 = 丢弃**（当作空气）。
 *
 * key 必须与 litematic palette 剥净后的名字逐字一致（用 `--census` 核对）。
 * **台阶/半砖不走这张表**：它们的形状/朝向在 `Properties` 里，由 `classify` 分支处理
 * （见 `bake-giant-pyramid.mjs`）。
 *
 * ## 为什么 smooth_sandstone → sand（用户裁定）
 * 用户要求「用沙子方块构建」。本仓 registry **没有** `smooth_sandstone`，新增砂岩方块
 * 要连带 3 张贴图 + 图标 + atlas 重排 —— 而 `sand` 已有贴图，观感就是"沙子金字塔"。
 *
 * ## 为什么 barrier → 丢弃（实测确认安全）
 * barrier 是隐形碰撞/装饰件（1759 格），本仓无对应方块。实测：**没有一个** barrier 格
 * 「若当空气会构成可站立通道」（判据 = 该格与头格均空气 + 下方 1~2 格有支撑，0/1759）
 * ⇒ 丢弃不改变迷宫可走性。
 */
export const BLOCK_MAP = Object.freeze({
  air: '',
  barrier: '',
  smooth_sandstone: 'sand',
});

/**
 * 产物必须满足的全部指标 —— 烘焙脚本与 `check:data` 共用这一份。
 *
 * 全部实测值（`node tools/bake-giant-pyramid.mjs --census` 可复现）：
 *   - 解码非空气格 17966 == `Metadata.TotalBlocks`（精确相等 ⇒ 位打包/索引序正确）
 *   - 实心 16207 = sand 14982 + stairs 1219 + slab 6
 *   - y=0 层（归一化前的底面）满铺 49×49 = 2401 格 ⇒ 归一化后 `baseCells` 在 y=1 层
 */
export const PYRAMID_METRICS = Object.freeze({
  width: 49,
  height: 24,      // 原模型 y∈[0,23] 共 24 层有内容 → 归一化 y∈[1,24]
  depth: 49,
  blocks: 16207,   // 实心格（不含 air/barrier）
  // ⚠️ 下面三个是**目标方块**格数，不是源方块的 —— 两者不同！
  // 源方块：smooth_sandstone 14982 / stairs 1219 / slab 6（double 5 + bottom 1）
  // 目标映射后：double 半砖→sand（+5）、bottom 半砖→sand_slab（仅 1）
  // ⇒ sand 14982+5 = 14987；sand_slab 1。已由 `npm run pyramid -- --census` 实测确认。
  sandCells: 14987,
  stepCells: 1219, // 直台阶 1156 + 转角台阶 63（转角用直台阶近似，spec 偏离 ①）
  slabCells: 1,    // 只有那格塔尖的 bottom 半砖
  baseCells: 2401, // 归一化后 y=1 层满铺 49×49
  paletteSize: 3,  // sand / sand_step / sand_slab
});

/**
 * 烘焙输入指纹：`<litematic 内容 sha 前 16>:<参数 sha 前 16>`。
 *
 * 两个消费方（烘焙脚本写进 meta、`check:data` 重算比对）必须拿到同一格式。
 * 改 `BLOCK_MAP` / `PYRAMID_METRICS` / `FACING_TO_ORIENT` / `.litematic` 任一都会改变指纹
 * → 门禁报「产物已过期，跑 npm run pyramid」，防静默过期。
 *
 * 已知盲区（与图标/夜空/巨树/高台同口径）：只改**烘焙算法**而不动参数时指纹不变 ——
 * 那类改动须靠 `test-giant-pyramid.js` 的产物契约与 Tier 4 兜住。
 */
export function giantPyramidInputFingerprint() {
  if (!fs.existsSync(LITEMATIC_PATH)) {
    throw new Error(`[金字塔] 烘焙输入缺失：${LITEMATIC_PATH}（.litematic 入库，缺失 = 仓库损坏）`);
  }
  const litematicSha256 = createHash('sha256').update(fs.readFileSync(LITEMATIC_PATH)).digest('hex');
  const paramsSha256 = createHash('sha256')
    .update(JSON.stringify({ BLOCK_MAP, PYRAMID_METRICS, FACING_TO_ORIENT }))
    .digest('hex');
  return {
    input: `${litematicSha256.slice(0, 16)}:${paramsSha256.slice(0, 16)}`,
    litematicSha256,
    paramsSha256,
  };
}
