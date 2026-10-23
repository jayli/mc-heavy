// tools/giant-trees-fingerprint.mjs — 巨树烘焙的参数与输入指纹
//
// **两个消费者共用同一份逻辑**（红线 1），沿用 `turret-armor-fingerprint.mjs` 的模式：
//   - `tools/bake-giant-trees.mjs` 烘焙时按本参数生成并写进 `assets/giant-trees/trees.meta.json`
//   - `tools/check-data.mjs` 用当前参数重算并比对 → 不匹配即报「跑 npm run gianttrees」
//
// trees.json 是**派生产物**，权威输入 = 入库的 `.schem` + 本文件的全部参数。改了源文件/映射表却忘跑烘焙，
// 产物会静默过期（渲染旧树形，肉眼只觉得「树形怪怪的」）。
//
// 素材**入库**（`assets/giant-trees/src/`，与 `assets/sky/night-src/` 同口径：烘焙输入，不是渲染资源）：
// 指纹因此不依赖任何仓库外文件，任何机器 `npm run check` 结果一致。
//
// node 侧模块（要读文件），不进 src/，浏览器不消费。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(__dirname, '..');

/** 产物与输入路径（烘焙脚本与门禁共用，避免两处各写一份） */
export const SCHEM_PATH = path.join(ROOT, 'assets', 'giant-trees', 'src', '40AssortedTreesPack.schem');
export const TREES_JSON = path.join(ROOT, 'assets', 'giant-trees', 'trees.json');
export const TREES_META = path.join(ROOT, 'assets', 'giant-trees', 'trees.meta.json');

/** 降采样比例：每 SCALE³ 立方块合成 1 格（1/2 比例） */
export const SCALE = 2;

/** 素材里的地块总数（netherite_block 圈在 y=1 层的连通分量数） */
export const PAD_COUNT = 40;

/**
 * 地块（pad）索引 = 把 40 个连通分量按 `(minZ, minX)` 升序排好后的下标。
 * ⚠️ 这个排序约定是载荷性的：改成 x 优先则 40 个位置全部错位，整张族映射表作废。
 * 唯一实现 = `sortPads()`；烘焙脚本末尾还会按 FAMILY_MARKERS 用源方块名反向校验族归属。
 */
export function sortPads(pads) {
  return [...pads].sort((a, b) => a.minZ - b.minZ || a.minX - b.minX);
}

/**
 * 族 → 变体（pad 索引，按数组顺序即运行时变体顺序）。
 * 28 个变体 = 40 − 12 个排除项：
 *   - 12/18/28/38：云杉带园墙，实测**无树干**（只有叶团 + 砖墙/栅栏门）；
 *   - 4/9/15/25/35：混交巨树（jungle+oak 叶混生，偏热带，spec §2.2 决策：不用于森林）；
 *   - 2/3/5：丛林巨树（同上，且无任何落位路径使用它们 —— 不烘焙死数据）。
 */
export const TREE_FAMILIES = Object.freeze({
  tallOak: Object.freeze([8, 10, 14, 16, 24, 26, 34, 36]),       // 高橡 / 白桦
  snowSpruce: Object.freeze([11, 17, 27, 37]),                    // 雪松
  cherry: Object.freeze([0, 1, 6, 7]),                            // 樱花
  palm: Object.freeze([13, 19, 29, 39]),                          // 椰子树
  banyanLeafy: Object.freeze([20, 21, 30, 31]),                   // 榕树（有叶）
  banyanBare: Object.freeze([22, 23, 32, 33]),                    // 榕树（枯干）
});

/**
 * 族 → 调色板。**`palette[0]` 恒为树干**（运行时的地基填充按这个约定认树干，见 giant-trees.js）。
 * 全部 8 个名字 = Task 2 声明的 8 个 `giant_*` 方块，不多不少（check:data 双向断言）。
 */
export const FAMILY_PALETTES = Object.freeze({
  tallOak: Object.freeze(['giant_oak_log', 'giant_oak_leaves', 'giant_birch_leaves']),
  snowSpruce: Object.freeze(['giant_oak_log', 'giant_spruce_leaves']),
  cherry: Object.freeze(['giant_oak_log', 'giant_cherry_leaves']),
  palm: Object.freeze(['giant_oak_log', 'giant_palm_leaves']),
  banyanLeafy: Object.freeze(['giant_mangrove_log', 'giant_banyan_leaves']),
  banyanBare: Object.freeze(['giant_mangrove_log']),
});

/**
 * 族 → 源方块名 → 调色板下标（-1 = 丢弃）。这是**唯一**的分类表：
 * 素材里出现、但表里没有的方块名会让烘焙直接 throw（不允许「悄悄丢掉」或「悄悄归到某类」）。
 *
 * 丢弃的两类：① 装饰件（栅栏/台阶/半砖/活板门/雪层以外的几何，实测占 3.6%）——它们需要新几何模板，
 * 本 Epic 不做；② 地面植被（large_fern：展示台上的地被，不是树的一部分）。
 * 保留的「花色」：樱花树的粉色体积主要来自 pink_concrete(_powder)/pink_wool/sponge（占樱花树体 ~70%），
 * 全部并入樱花叶（漏掉 pink_concrete* 会把樱花冠掏空近三成）。
 * 雪块/雪层并入雪松的叶（8 个方块是上限，不新增雪方块）。
 */
export const SOURCE_MAP = Object.freeze({
  tallOak: Object.freeze({
    oak_wood: 0, birch_wood: 0, oak_leaves: 1, birch_leaves: 2,
    large_fern: -1, spruce_slab: -1, spruce_stairs: -1,
  }),
  snowSpruce: Object.freeze({
    stripped_dark_oak_wood: 0, spruce_leaves: 1, snow_block: 1, snow: 1,
    dark_oak_slab: -1, dark_oak_trapdoor: -1, dark_oak_fence: -1,
  }),
  cherry: Object.freeze({
    spruce_planks: 0, oak_wood: 0, stripped_spruce_wood: 0,
    cherry_leaves: 1, pink_concrete_powder: 1, pink_concrete: 1, pink_wool: 1, sponge: 1,
    spruce_slab: -1,
  }),
  palm: Object.freeze({ spruce_planks: 0, jungle_leaves: 1 }),
  banyanLeafy: Object.freeze({ mangrove_wood: 0, oak_leaves: 1, birch_leaves: 1 }),
  banyanBare: Object.freeze({ dark_oak_wood: 0, dark_oak_fence: -1 }),
});

/** 展示台材质（不是树）：连同 air 一起，在所有统计与降采样里一律跳过 */
export const DISPLAY_BLOCKS = Object.freeze(new Set([
  'air', 'cyan_terracotta', 'light_gray_concrete', 'white_stained_glass', 'netherite_block',
]));

/**
 * 族归属的反向校验（防「排序约定错了 → 整张映射表错位」静默发生）：
 * 每个变体的**源方块名集合**必须：包含 `has` 全部；对 `hasAnyOf` 的每一组至少含其中一个；不含 `lacks` 任一。
 */
export const FAMILY_MARKERS = Object.freeze({
  tallOak: { has: [], hasAnyOf: [['oak_wood', 'birch_wood'], ['oak_leaves', 'birch_leaves']], lacks: ['jungle_leaves', 'snow_block', 'cherry_leaves'] },
  snowSpruce: { has: ['snow_block', 'spruce_leaves'], lacks: ['birch_leaves', 'cherry_leaves'] },
  cherry: { has: ['cherry_leaves'], lacks: ['snow_block', 'jungle_leaves'] },
  palm: { has: ['jungle_leaves', 'spruce_planks'], lacks: ['dark_oak_wood', 'oak_leaves'] },
  banyanLeafy: { has: ['mangrove_wood'], lacks: ['dark_oak_wood', 'cherry_leaves'] },
  banyanBare: { has: ['dark_oak_wood'], lacks: ['mangrove_wood', 'oak_leaves', 'birch_leaves'] },
});

/** 输入指纹：入库 .schem 的内容哈希 + 全部烘焙参数。.schem 缺失即 throw（它是入库文件，缺了是仓库损坏）。 */
export function giantTreesInputFingerprint() {
  if (!fs.existsSync(SCHEM_PATH)) throw new Error(`[巨树] 烘焙输入缺失：${SCHEM_PATH}`);
  const schemSha = crypto.createHash('sha256').update(fs.readFileSync(SCHEM_PATH)).digest('hex');
  const params = JSON.stringify({
    scale: SCALE, padCount: PAD_COUNT, families: TREE_FAMILIES, palettes: FAMILY_PALETTES, map: SOURCE_MAP,
    markers: FAMILY_MARKERS,
  });
  const paramsSha = crypto.createHash('sha256').update(params).digest('hex');
  return { schemSha256: schemSha, paramsSha256: paramsSha, input: `${schemSha.slice(0, 16)}:${paramsSha.slice(0, 16)}` };
}
