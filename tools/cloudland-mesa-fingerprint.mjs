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
 *
 * ⚠️ **不得映射到砖块族或木族**（v1.77 用户裁定：「不要用砖块，都改用不同颜色的石头方块……
 * 看起来高台要更像天然形成的，而不是人工打造的」）。砖纹（`*_bricks`）与木板会直接读成
 * 人造砌筑 → 整座台子失去天然感。`check:data` 的 `[高台]` 环节与 `test-mesa.js` 都钉住这条。
 *
 * **色阶设计**：天然岩层在明度 44~237 之间取 8 档，去掉原方案里的
 * `mud_bricks`(暖红 42% 饱和) / `nether_bricks_1`(深红) / `tuff_bricks`(砖纹) /
 * `stone_bricks`(砖纹) / `polished_blackstone_bricks`(砖纹) / `acacia_planks`+`wood`(木)。
 * `moss`（台顶苔藓层）按用户要求**不动**。
 */
export const BLOCK_MAP = Object.freeze({
  // ---- 深色底座（y 1-10）：深板岩族不再用「砖」，改纯岩石 ----
  mud: 'clay',                       // 天然黏土（161,166,179 冷灰蓝），取代红砖 mud_bricks
  coal_block: 'polished_deepslate',   // 深色致密岩（71,71,71），取代黑砖
  // ---- 台身主体（y 11-30）：最大两块改成原石 ----
  tuff: 'stone',                     // 原石（136,136,137）—— 2574 格，最大一块
  gray_concrete_powder: 'stone_diorite',      // 闪长岩（189,188,189 浅灰），取代灰泥 calcite
  light_gray_concrete_powder: 'stone_diorite',
  white_concrete_powder: 'calcite',           // 灰阶极值（calcite 无图标，不属背包，仅作填充）
  gray_concrete: 'smooth_stone_1',   // 平滑石（156,156,156）
  light_gray_concrete: 'smooth_stone',  // 平滑石（164,164,164）
  // ---- 横带（y 21-40）：砖纹全部换掉 ----
  cracked_stone_bricks: 'cobblestone',  // 鹅卵石（125,125,125 天然碎裂感）
  stone_bricks: 'cobblestone',
  chiseled_nether_bricks: 'deepslate',   // 深板岩（120,120,145 冷灰），取代深红砖
  cracked_nether_bricks: 'deepslate',
  nether_bricks: 'deepslate',
  gray_wool: 'stone',                // 原石（773 格灰羊毛 → 石头）
  // ---- 台顶苔藓层（y 41-42）：**用户明确要求不动** ----
  moss_block: 'moss',
  green_terracotta: 'moss',
  green_concrete: 'mossy_stone',     // 苔石（104,110,93）
  lime_terracotta: 'moss',
  green_wool: 'moss',
  // ---- 原本的木质装饰：去掉木头 → 苔石 ----
  acacia_wood: 'mossy_stone',
  oak_wood: 'mossy_stone',
  birch_wood: 'mossy_stone',
  // ---- 陶土族：保留天然黏土/浅灰 ----
  cyan_terracotta: 'clay',
  blue_terracotta: 'clay',
  light_gray_terracotta: 'light_gray_cloth',
  // ---- 深板岩族（整族归并到 2 个天然岩石目标） ----
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
  deepslate_iron_ore: 'iron_ore',    // 铁矿（100,93,87）—— 天然矿脉点缀
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
