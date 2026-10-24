// tools/cloudland-mesa-fingerprint.mjs — Cloudland 高台烘焙的**输入指纹与映射表**共享模块
//
// 唯一权威（红线 1）：烘焙脚本 `bake-cloudland-mesa.mjs` 与数据契约门 `check-data.mjs`
// 都从这里 import，不得各写一份。两处各写一份会漂移出「门禁说产物新鲜、实际映射表改了」
// 或反过来的撕裂 —— 与 `giant-trees-fingerprint.mjs` / `icon-fingerprint.mjs` 同一手法。
//
// ## 映射表为什么是一张显式表而不是规则
// 素材用 40+ 种本仓 registry 没有的方块（tuff / mud / gray_concrete_powder / moss_block /
// chiseled_nether_bricks / deepslate_* …）。规则式映射（如「名字含 concrete → 某方块」）
// 会在源模型换一批方块时**静默给出荒谬结果**；显式表则让烘焙对未知名字 throw —— 那格
// 不会变成空气（`makeColumnSetter` 对未注册名字是静默 return，方块层面看不出是映射错了）。
//
// ## 观感取舍（用户裁决：全部映射到已有方块，零新增方块/贴图/图标）
// 源模型的观感来自四层色带：深色底座 → 中灰台身 → 浅色横带 → 顶部苔藓。
// 映射保留这个层次结构，但具体配色会偏离原版（源图是灰混凝土粉 + 凝灰岩的冷灰色调）。
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const ROOT = path.resolve(import.meta.dirname, '..');

/** 烘焙输入（**入库**，不是渲染资源 —— 与 assets/giant-trees/src/ 同口径） */
export const SCHEM_PATH = path.join(ROOT, 'assets', 'cloudland', 'src', 'cloudlandassets_1.20.schem');
/** 烘焙产物：结构 JSON（进运行期，经 structure-json.js 加载） */
export const MESA_JSON = path.join(ROOT, 'assets', 'structures', 'cloudland_mesa_small.json');
/** 烘焙产物：伴随元数据（尺寸 + 指纹，不进运行期） */
export const MESA_META = path.join(ROOT, 'assets', 'structures', 'cloudland_mesa_small.meta.json');

/**
 * Landscape/9 的方块数 —— 用来在 38 个连通分量里唯一匹配它。
 * 见 bake-cloudland-mesa.mjs 文件头的「为什么按 BlockCount 匹配」。
 */
export const SOURCE_COMPONENT_BLOCKS = 10712;

/**
 * 平移原点：基座（y=1 层，164 格）的质心。
 *
 * 素材里 Landscape/9 的 bbox 是 x[275,294] y[1,43] z[127,147]（绝对坐标），
 * 基座质心落在相对 (9, 11)。烘焙时减去它 → 落点的 `wx, wz` 就是**高台的正中心**，
 * 候选发现与光栅化都用同一个原点（不必在两处各做一次偏移换算）。
 */
export const MESA_ORIGIN = Object.freeze({ cx: 9, cz: 11 });

/**
 * 产物必须满足的全部尺寸指标 —— 烘焙脚本与 `check:data` 共用这一份。
 *
 * `baseCells: 164` 是 y=1 层（基座）的格数。它同时是「基座每列都有支撑」的判据来源：
 * 基座列数 == 164 说明底座没有被削掉任何一列。
 */
export const MESA_METRICS = Object.freeze({
  width: 20, height: 43, depth: 21,
  blocks: 10712,
  baseCells: 164,
});

/**
 * 源方块名 → 本仓 registry 方块名。
 *
 * ⚠️ key 必须与 `.schem` palette 里的实际名字**逐字一致**（`minecraft:` 前缀与 `[axis=y]`
 * 之类属性后缀在解析时已剥掉）。核对方式：`node tools/bake-cloudland-mesa.mjs --census`
 * 会打印现场全部源名与各自格数，并与本表逐个比对。
 *
 * ⚠️ value 必须是 registry 里**已注册**的名字，且**全部走 opaque 通道** —— cutout/transparent
 * 会让 1 万格方块的三通道容量预算失控（`check:data` 的 `[高台]` 环节钉住这条）。
 */
export const BLOCK_MAP = Object.freeze({
  // ---- 深色底座（y 1-10） ----
  mud: 'mud_bricks',
  coal_block: 'polished_blackstone_bricks',
  // ---- 台身主体（y 11-30） ----
  tuff: 'tuff_bricks',
  gray_concrete_powder: 'calcite',
  light_gray_concrete_powder: 'calcite',
  white_concrete_powder: 'calcite',
  gray_concrete: 'smooth_stone_1',
  light_gray_concrete: 'smooth_stone',
  // ---- 横带（y 21-40） ----
  cracked_stone_bricks: 'stone_bricks',
  stone_bricks: 'stone_bricks',
  chiseled_nether_bricks: 'nether_bricks_1',
  cracked_nether_bricks: 'nether_bricks',
  nether_bricks: 'nether_bricks',
  gray_wool: 'stone',
  // ---- 台顶苔藓层（y 41-42） ----
  moss_block: 'moss',
  green_terracotta: 'moss',
  green_concrete: 'mossy_stone',
  lime_terracotta: 'moss',
  green_wool: 'moss',
  // ---- 木质（原设计里的攀爬架/装饰） ----
  acacia_wood: 'acacia_planks',
  oak_wood: 'wood',
  birch_wood: 'birch_log',
  // ---- 陶土族 ----
  cyan_terracotta: 'clay',
  blue_terracotta: 'clay',
  light_gray_terracotta: 'light_gray_cloth',
  // ---- 深板岩族（整族归并到 3 个目标） ----
  deepslate: 'deepslate',
  cobbled_deepslate: 'deepslate',
  deepslate_tiles: 'deepslate',
  cracked_deepslate_tiles: 'deepslate',
  deepslate_bricks: 'deepslate',
  chiseled_deepslate: 'polished_deepslate',
  cracked_deepslate_bricks: 'polished_deepslate',
  polished_deepslate: 'polished_deepslate',
  deepslate_coal_ore: 'deepslate',
  deepslate_copper_ore: 'deepslate',
  deepslate_iron_ore: 'iron_ore',
  // ---- 混凝土族 ----
  black_concrete: 'deepslate',
  black_concrete_powder: 'deepslate',
  smooth_basalt: 'deepslate',
  // ---- 羊毛 ----
  black_wool: 'deepslate',
  light_gray_wool: 'light_gray_cloth',
  white_wool: 'marble',
});

/**
 * 烘焙输入指纹：`<schem 内容 sha 前 16>:<参数 sha 前 16>`。
 *
 * 两个消费方（烘焙脚本写进 meta、check:data 重算比对）必须拿到同一格式。
 * 改 `BLOCK_MAP` / `MESA_METRICS` / `MESA_ORIGIN` / `SOURCE_COMPONENT_BLOCKS` 任一都会
 * 改变 `paramsSha256` → 门禁报「产物已过期，跑 npm run mesa」，防静默过期。
 *
 * 已知盲区（与图标/夜空同一口径）：只改**烘焙算法**而不动参数时指纹不变 ——
 * 那类改动须靠单测/像素实测兜住。
 */
export function cloudlandMesaInputFingerprint() {
  const schemSha256 = createHash('sha256').update(fs.readFileSync(SCHEM_PATH)).digest('hex');
  const paramsSha256 = createHash('sha256')
    .update(JSON.stringify({
      BLOCK_MAP,
      MESA_METRICS,
      MESA_ORIGIN,
      SOURCE_COMPONENT_BLOCKS,
    }))
    .digest('hex');
  return {
    input: `${schemSha256.slice(0, 16)}:${paramsSha256.slice(0, 16)}`,
    schemSha256,
    paramsSha256,
  };
}
