// tools/cloudland-kit-fingerprint.mjs — Cloudland 素材套件烘焙的**输入指纹与映射表**共享模块
//
// 唯一权威（红线 1）：烘焙脚本 `bake-cloudland-kit.mjs` 与数据契约门 `check-data.mjs`
// 都从这里 import，不得各写一份。两处各写一份会漂移出「门禁说产物新鲜、实际映射表改了」
// 或反过来的撕裂 —— 与 `giant-trees-fingerprint.mjs` / `icon-fingerprint.mjs` 同一手法。
//
// ⚠️ **本文件依赖 node 内建模块**（fs/path/crypto），只能被 tools/ 与 check-data 使用。
// 浏览器单测与 Worker 侧的 `structure-json.js` 必须 import
// `src/gen/structures/cloudland-kit-data.js`（纯数据、零 node 依赖）——
// `node:` 协议在浏览器无法解析会让**整个模块不加载**（测试全不跑 / Worker 起不来 / 白屏），
// 而 `npm run check:arch` 抓不到这类运行时失败。
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
// 纯数据从 src/ 来（单一定义处，红线 1）；本文件只加 node 侧的东西并 re-export。
// ⚠️ 相对路径是 `../src/...`（本文件在 tools/ 下）—— 写成 `../../src/...` 会解析到仓库**父目录**。
import { KIT_METRICS, KIT_VARIANTS } from '../src/gen/structures/cloudland-kit-data.js';
export { KIT_METRICS, KIT_VARIANTS };

const ROOT = path.resolve(import.meta.dirname, '..');

/** 烘焙输入（**入库**，不是渲染资源 —— 与 assets/giant-trees/src/ 同口径） */
export const SCHEM_PATH = path.join(ROOT, 'assets', 'cloudland', 'src', 'cloudlandassets_1.20.schem');
/** 烘焙产物目录（35 个结构 JSON） */
export const KIT_JSON_DIR = path.join(ROOT, 'assets', 'structures');
/** 烘焙产物的伴随元数据（尺寸 + 指纹，不进运行期） */
export const KIT_META = path.join(KIT_JSON_DIR, 'cloudland_kit.meta.json');

/**
 * 源方块名 → 本仓 registry 方块名。
 *
 * ⚠️ key 必须与 `.schem` palette 里的实际名字**逐字一致**（`minecraft:` 前缀与 `[axis=y]`
 * 之类的属性后缀在解析时已剥掉）。核对方式：`node tools/bake-cloudland-kit.mjs --census`
 * 会打印现场全部源名与各自格数，并与本表逐个比对；烘焙前还有一道 **73/73 去重源名**的
 * 全量覆盖断言（palette 88 条条目 —— `purple_stained_glass_pane` 独占 18 种 blockstate，
 * 剥掉前缀/属性后是 73 个去重名字）。
 *
 * ⚠️ value 必须是 registry 里**已注册**的名字（`src/voxel/blocks-data.js`），
  * 且**全部走 opaque 通道** —— cutout/transparent 会让十万级方块的三通道容量预算失控
  * （`check:data` 的 `[高台地带]` 环节钉住这条）。
  * ⚠️ **v1.89 起没有任何例外**：原本紫晶柱的 `purple_stained_glass_pane → glass_block`
  * （180 格 transparent）已按用户裁定改为 opaque 的 `amethyst`。
 * 紫晶部分（180 格），是唯一有意例外（设计文档 §4.4 第 5 条）。
 *
 * ⚠️ **不得映射到砖块族（`*bricks`）或木族（`*wood` / `*planks` / `*log`）**
 * （v1.77 用户裁定：「不要用砖块，都改用不同颜色的石头方块……看起来高台要更像天然形成的，
 * 而不是人工打造的」）。`check:data` 的 `[高台地带]` 与 `test-mesa.js` 都用名字模式钉住。
 * ⚠️ 注意 `oak_planks` 与 `moss` 在 registry 里**存在**但前者不可用作映射目标
 * （见下方 `stripped_dark_oak_wood` / `oak_planks` 两条）。
 *
 * 格数由 `node tools/bake-cloudland-kit.mjs --census` 实测（四族并集 69 种源方块）。
 */
export const BLOCK_MAP = Object.freeze({
  // ================================================================ 高台族（tarn）主体
  // ---- 深色底座（y 1-10）：深板岩族不再用「砖」，改纯岩石 ----
  mud: 'clay',                        // 37,123 格（最大一块）。天然黏土（161,166,179 冷灰蓝），取代红砖 mud_bricks
  coal_block: 'polished_deepslate',    // 8,039 格。深色致密岩（71,71,71），取代黑砖
  // ---- 台身主体（y 11-30）：最大两块改成原石 ----
  tuff: 'stone',                       // 78,112 格（tarn 60,162 + cloud 17,950，全局最大）。原石（136,136,137）
  gray_concrete_powder: 'stone_diorite',      // 48,229 格。闪长岩（189,188,189 浅灰），取代灰泥 calcite
  light_gray_concrete_powder: 'smooth_stone_1', // 2,480 格（tarn 6 + arch 273 + cloud 2,201）。
                                                // ⚠️ 继承表原值 `stone_diorite`，本次按 brief Step 3
                                                // 第 4 条改为 `smooth_stone_1`（云族占比最大，平滑石更贴云材质）
  white_concrete_powder: 'calcite',            // 841 格。灰阶极值（calcite 无图标，不属背包，仅作填充）
  gray_concrete: 'smooth_stone_1',     // 956 格。平滑石（156,156,156）
  light_gray_concrete: 'smooth_stone',  // 2,883 格。平滑石（164,164,164）
  // ---- 横带（y 21-40）：砖纹全部换掉 ----
  cracked_stone_bricks: 'cobblestone',  // 22,802 格。鹅卵石（125,125,125 天然碎裂感）
  stone_bricks: 'cobblestone',          // ⚠️ 本素材 palette 里**不存在**（继承表保留，删掉会让
                                        // 「换素材后名字回归」变成静默 air；烘焙不消费它）
  chiseled_nether_bricks: 'deepslate',   // 29,641 格。深板岩（120,120,145 冷灰），取代深红砖
  cracked_nether_bricks: 'deepslate',    // 335 格
  nether_bricks: 'deepslate',            // 520 格（全在 arch 族）
  gray_wool: 'stone',                    // 25,321 格灰羊毛 → 石头
  // ---- 台顶苔藓层：**用户 2026-10-26 裁定 moss → grass** ----
  // 「高台顶部的方块原来是 moss，现在换成 grass」。四个源名共 22,926 格（= 全部高台格数的 8.0%）。
  // 两者都是 opaque 通道，通道与容量不受影响；grass 与 moss 都在背包里，无需改 HIDDEN_FROM_INVENTORY。
  moss_block: 'grass',                 // 22,145 格（台顶主材）
  green_terracotta: 'grass',           // 733 格
  green_wool: 'grass',                 // 26 格
  lime_terracotta: 'grass',            // 22 格
  green_concrete: 'light_gray_cloth',   // 428 格。v1.94 前是苔石（104,110,93）
  // ---- 原本的木质装饰：去掉木头 → 浅灰布（v1.94: 原为苔石） ----
  // ⚠️ 木族映射**必须**落在非木目标上：`check:data` 用 `/log|wood|plank|birch/i` 判 palette，
  // 映射成 `oak_planks` / `dark_oak_planks` 会当场红（且 v1.77 明确要求「像天然形成」）。
  //
  // ⚠️ **v1.94（用户 2026-10-29）：「高台里的 mossy 方块和 iron_ore 方块都换成 light_gray_cloth」**
  // —— 改的是**映射目标**，不是只改产物 palette：`mossy_stone` / `iron_ore` 在这张表里是
  // 7 个源方块的落点（绿混凝土 + 5 个木族 + 深板岩铁矿），只改 palette 会漏掉这些
  // （实测：调色板里 mossy_stone 4,092 格，但由它承接的源方块共 6,133 格）。
  acacia_wood: 'light_gray_cloth',          // 5,589 格（tarn 3,656 + cloud 1,933）
  oak_wood: 'light_gray_cloth',             // 84 格（tarn 1 + cloud 83）
  birch_wood: 'light_gray_cloth',           // 453 格（全在 cloud）
  stripped_dark_oak_wood: 'light_gray_cloth', // 5 格（仅 tarn_01/tarn_03）。剥皮深色橡木 → 苔石
  oak_planks: 'light_gray_cloth',           // 2 格（仅 tarn_01/tarn_03）。⚠️ registry 里有 `oak_planks`
                                       // 但**不可用作映射目标**（木族，门禁会红 + 观感是人造砌筑）
  // ---- 陶土族：保留天然黏土/浅灰 ----
  cyan_terracotta: 'clay',             // 3,092 格
  blue_terracotta: 'block_of_quartz',  // 17 格（arch 1 + spire 16）。
                                       // ⚠️ 继承表原值 `clay`，本次按 brief Step 3 第 3 条改为
                                       // `block_of_quartz` —— 它在紫晶柱族里是石英柱的偏蓝部分
  light_gray_terracotta: 'clay',       // 37 格（arch 9 + cloud 28）。
                                       // ⚠️ 继承表原值 `light_gray_cloth`，本次按 brief Step 3 第 4 条改为 `clay`
  gray_terracotta: 'clay',             // 21 格（仅 tarn_01/tarn_03）。与 cyan_terracotta → clay 同口径
  black_terracotta: 'clay',            // 5 格（仅 tarn_01/tarn_03）。同上（y=0 地板层的 70,099 格已剔除）
  // ---- 深板岩族（整族归并到 2 个天然岩石目标） ----
  deepslate: 'deepslate',              // ⚠️ 本素材 palette 里**不存在**（继承表保留，同 stone_bricks 的理由）
  cobbled_deepslate: 'deepslate',      // 1,317 格（tarn 1,294 + cloud 23）
  deepslate_tiles: 'deepslate',        // 380 格
  cracked_deepslate_tiles: 'deepslate', // 1,333 格
  deepslate_bricks: 'deepslate',       // 684 格
  chiseled_deepslate: 'polished_deepslate', // 449 格
  cracked_deepslate_bricks: 'polished_deepslate', // 1,336 格
  polished_deepslate: 'polished_deepslate', // 600 格
  deepslate_coal_ore: 'deepslate',     // 797 格
  deepslate_copper_ore: 'deepslate',   // 3,660 格（tarn 2,682 + cloud 978）
  deepslate_iron_ore: 'light_gray_cloth', // 1,415 格。v1.94 前是铁矿（100,93,87）—— 天然矿脉点缀
  // ---- 混凝土族 ----
  black_concrete: 'deepslate',         // 742 格
  black_concrete_powder: 'deepslate',  // 893 格
  smooth_basalt: 'deepslate',          // 86 格
  // ---- 羊毛 ----
  black_wool: 'deepslate',             // 1,957 格
  light_gray_wool: 'light_gray_cloth', // 1,206 格（全在 cloud）

  // ================================================================ 高台族散布的深色点缀
  // 7,829 格 = 全部高台格数的 2.7%，散布在整座台身（逐 y 层占比最高只有 y=2 的 12.9%，
  // 同层主力是 white_concrete_powder 的 5,735 格 ⇒ 它**不是「深色底层带」而是散布点缀**）。
  // 选 deepslate 的理由与既有表 `black_concrete` / `smooth_basalt` / `nether_bricks` 同一口径 ——
  // 项目有意去掉深红色相（registry 里 `netherrack` 存在却没被任何一项选中就是证据）。
  magma_block: 'deepslate',            // 7,829 格（tarn_01 5,090 + tarn_02 1,721 + tarn_03 1,018）
  // 零星矿脉点缀：与上面 `deepslate_coal_ore` / `deepslate_copper_ore` 同口径落到 deepslate
  coal_ore: 'deepslate',               // 7 格（tarn_02 4 + tarn_03 2 + tarn_04 1）
  deepslate_redstone_ore: 'deepslate', // 4 格（tarn_04 1 + tarn_05 1 + tarn_06 2）。registry 无红石方块
  soul_sand: 'dirt',                   // 6 格（tarn_04 3 + tarn_05 1 + tarn_06 2）。暗褐土色，比 clay 更贴原版

  // ================================================================ 拱洞族（arch，灰岩）
  // 5 个有效分量（1,480 / 1,185 / 1,142 / 1,113 / 640 格），合计 5,560 格。
  andesite: 'stone',                   // 2,239 格（arch 1,555 + spire 270 + cloud 414）。安山岩 → 原石
  cobblestone: 'cobblestone',          // 1,749 格（恒等；arch 1,497 是主体）
  stone: 'stone',                      // 103 格（arch 1 + spire 85 + cloud 17）。恒等映射 —— registry 有 `stone`
  polished_andesite: 'stone_diorite',  // 576 格（cloud 549 + arch 11 + tarn 8 + spire 8）。
                                       // 抛光的浅灰岩。云族主体是 marble（237 明度），
                                       // 用 stone_diorite（189）能拉开层次；且与
                                       // gray_concrete_powder → stone_diorite 同口径
  clay: 'clay',                        // 2,282 格（arch 288 + cloud 1,994）。恒等映射 —— registry 有 `clay`

  // ================================================================ 紫晶柱族（spire，紫晶 + 石英）
  // 7 个分量（436 / 381 / 345 / 298 / 134 / 79 / 21 格），合计 1,694 格。
  light_blue_terracotta: 'block_of_quartz',   // 326 格。柱子主体（「石英巨柱」）
   purple_stained_glass_pane: 'amethyst',      // 180 格。⚠️ **v1.89 改用 opaque 实心方块**
                                               // 用户 2026-10-27 裁定：「把高台地图里所有方块中的
                                               // 玻璃透明方块都去掉，换成实心方块……全都是不透明
                                               // 的实心方块」—— 排除一切可能影响性能的因素。
                                               // 映射到 `amethyst`（紫水晶，opaque，与同族
                                               // `chorus_plant → amethyst` 同色系）。
  chorus_plant: 'amethyst',                   // 12 格。紫晶柱顶端
  purple_concrete: 'block_of_quartz',         // 5 格
  purple_concrete_powder: 'block_of_quartz',  // 38 格
  purple_terracotta: 'block_of_quartz',       // 11 格
  purple_wool: 'block_of_quartz',             // 4 格

  // ================================================================ 巨型云族（giantCloud）
  // 12 个分量（最大 73×38×38 / 29,836 格，最小 3×6×5 / 60 格），合计 110,260 格。
  diorite: 'marble',                   // 62,922 格（全族最大；cloud 61,782 + arch 1,140）。闪长岩 → 大理石（雪白）
  polished_diorite: 'marble',          // 1,818 格。抛光的也是白，与 diorite 同目标
  snow_block: 'snow',                  // 5,079 格。雪块 → 雪
  basalt: 'deepslate',                 // 5,539 格。玄武岩 → 深板岩（与云族的深色底部带配合）
  white_concrete: 'marble',            // 1,656 格。白混凝土 → 大理石（云材质）
  white_wool: 'snow',                  // 1,815 格。
                                       // ⚠️ 继承表原值 `marble`，本次按 brief Step 3 第 4 条改为 `snow`
                                       // —— 云族是雪/云材质，`snow` 比 `marble` 更贴观感
  iron_block: 'iron',                  // 710 格。铁块 → 铁（天然矿脉点缀）
  gravel: 'debris',                    // 638 格。砂砾 → 远古残骸（深褐碎屑感）
  calcite: 'calcite',                  // 278 格。恒等映射 —— registry 有 `calcite`
  coarse_dirt: 'dirt',                 // 2 格。粗土 → 土
});

/**
 * 烘焙输入指纹：`<schem 内容 sha 前 16>:<参数 sha 前 16>`。
 *
 * 两个消费方（烘焙脚本写进伴随 meta、check:data 重算比对）必须拿到同一格式。
 * 改 `BLOCK_MAP` / `KIT_METRICS` / `KIT_VARIANTS` 任一都会改变 `paramsSha256`
 * → 门禁报「产物已过期，跑 npm run tarn」，防静默过期。
 *
 * 已知盲区（与图标/夜空同一口径）：只改**烘焙算法**而不动参数时指纹不变 ——
 * 那类改动须靠单测/像素实测兜住。
 */
export function cloudlandKitInputFingerprint() {
  const schemSha256 = createHash('sha256').update(fs.readFileSync(SCHEM_PATH)).digest('hex');
  const paramsSha256 = createHash('sha256')
    .update(JSON.stringify({ BLOCK_MAP, KIT_METRICS, KIT_VARIANTS }))
    .digest('hex');
  return {
    input: `${schemSha256.slice(0, 16)}:${paramsSha256.slice(0, 16)}`,
    schemSha256,
    paramsSha256,
  };
}
