// tools/ruined-citadel-fingerprint.mjs — 废弃堡垒（Ruined Citadel）烘焙的**映射表、产物指标与输入指纹**共享模块
//
// 唯一权威（红线 1）：烘焙脚本 `bake-ruined-citadel.mjs` 与数据契约门 `check-data.mjs` 都从这里
// import，不得各写一份。与 `burning-arena-fingerprint.mjs` / `giant-pyramid-fingerprint.mjs` 同一手法。
//
// 素材**入库**（`assets/ruined-citadel/src/`，与 `assets/burning-arena/src/` 同口径：烘焙输入，
// 不是渲染资源）→ 指纹不依赖仓库外文件，任何机器 `npm run check` 结果一致。
//
// ⚠️ node 侧模块（要读文件），不进 `src/`，浏览器不消费。
// ⚠️ **`src/**` 与浏览器单测绝不能 import 它** —— 它依赖 `node:fs`，浏览器无法解析
// `node:` 协议 → 整个模块不加载 → Worker 起不来 / 游戏白屏，而 `check:arch` 抓不到这类
// 运行时解析失败（B1 教训）。运行期需要的纯数据在 `src/gen/structures/ruined-citadel-data.js` 侧。
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

// 台阶 facing→orient 的唯一权威在巨型金字塔那侧（同一事实不抄第二份，红线 1）。
// 这里 import 后**再导出**，使烘焙脚本只有一个 import 源，且本模块的参数指纹能覆盖它
// （改朝向表会改变产物 → 指纹必须跟着变，否则门禁拓不到）。
export { FACING_TO_ORIENT } from './giant-pyramid-fingerprint.mjs';
import { FACING_TO_ORIENT } from './giant-pyramid-fingerprint.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

/** 烘焙输入目录（**入库**，不是渲染资源） */
export const RUINED_CITADEL_SOURCE_DIR = path.join(ROOT, 'assets', 'ruined-citadel', 'src');

/** 烘焙产物：结构 JSON（进运行期，经 structure-json.js 加载） */
export const RUINED_CITADEL_JSON = path.join(ROOT, 'assets', 'structures', 'ruined_citadel.json');
/** 烘焙产物：伴随元数据（尺寸 / 计数 / 指纹，不进运行期） */
export const RUINED_CITADEL_META = path.join(ROOT, 'assets', 'structures', 'ruined_citadel.meta.json');

/** `placement` 类型名 → 产物基名（`structure-json.js` 的 `STRUCTURE_FILES` 从这里派生） */
export const RUINED_CITADEL_VARIANTS = Object.freeze(['ruinedCitadel']);

/**
 * 18 片的拼合偏移（**逐字抄自** `RuinedCitadelStructure.java` 的 `OFFSET` 表 +
 * `start()` 里的 `rotationOffSet`，rotation = NONE；spec §2.1）。
 *
 * **两层结构**：文件 1~9 是下层（y 偏移 **-45**，各片 36×45×37，44 层地牢主体），
 * 文件 10~18 是上层（y 偏移 **0**，各片 36×21×37，甲板 + 塔楼）。
 *
 * ⚠️ **x/z 偏移是 36/37**：片宽 36、偏移 36 ⇒ 相邻片首尾相接不重叠；z 方向片深 37、
 * 偏移 37 同理（与大竞技场的 47/38 不同）。实测组装后包围盒 106×63×108 连续无断层。
 *
 * 组装后实测（`npm run ruinedcitadel -- --census` 可复现）：包围盒 106×63×108
 * （x∈[-35,70]，y∈[-45,17]，z∈[-35,72]），非空气 261,775 格，显式空气 257,265 格。
 */
export const RUINED_CITADEL_PIECES = Object.freeze([
  // ---- 下层 9 片（地牢主体，y 偏移 -45）----
  Object.freeze({ file: 'ruined_citadel1.nbt',  ox: -36, oy: -45, oz: -37 }),
  Object.freeze({ file: 'ruined_citadel2.nbt',  ox: -36, oy: -45, oz: 0   }),
  Object.freeze({ file: 'ruined_citadel3.nbt',  ox: -36, oy: -45, oz: 37  }),
  Object.freeze({ file: 'ruined_citadel4.nbt',  ox: 0,   oy: -45, oz: -37 }),
  Object.freeze({ file: 'ruined_citadel5.nbt',  ox: 0,   oy: -45, oz: 0   }),
  Object.freeze({ file: 'ruined_citadel6.nbt',  ox: 0,   oy: -45, oz: 37  }),
  Object.freeze({ file: 'ruined_citadel7.nbt',  ox: 36,  oy: -45, oz: -37 }),
  Object.freeze({ file: 'ruined_citadel8.nbt',  ox: 36,  oy: -45, oz: 0   }),
  Object.freeze({ file: 'ruined_citadel9.nbt',  ox: 36,  oy: -45, oz: 37  }),
  // ---- 上层 9 片（甲板 + 塔楼，y 偏移 0）----
  Object.freeze({ file: 'ruined_citadel10.nbt', ox: -36, oy: 0,   oz: -37 }),
  Object.freeze({ file: 'ruined_citadel11.nbt', ox: -36, oy: 0,   oz: 0   }),
  Object.freeze({ file: 'ruined_citadel12.nbt', ox: -36, oy: 0,   oz: 37  }),
  Object.freeze({ file: 'ruined_citadel13.nbt', ox: 0,   oy: 0,   oz: -37 }),
  Object.freeze({ file: 'ruined_citadel14.nbt', ox: 0,   oy: 0,   oz: 0   }),
  Object.freeze({ file: 'ruined_citadel15.nbt', ox: 0,   oy: 0,   oz: 37  }),
  Object.freeze({ file: 'ruined_citadel16.nbt', ox: 36,  oy: 0,   oz: -37 }),
  Object.freeze({ file: 'ruined_citadel17.nbt', ox: 36,  oy: 0,   oz: 0   }),
  Object.freeze({ file: 'ruined_citadel18.nbt', ox: 36,  oy: 0,   oz: 37  }),
]);

/**
 * 源方块名 → 本仓方块名。**空串 = 丢弃**（当作空气）。
 *
 * 与 DR-4 总表逐条对应（spec §DR-4，v2 定稿）。9 个整块/柱映到 Task 1 **新烘焙**的
 * 同名方块（照 mod 自带 16×16 贴图）；其余映到既有方块。
 *
 * ⚠️ **未知源方块名必须 throw**（烘焙脚本侧）：`makeColumnSetter` 对未注册名字是
 * **静默 return**，那格会变成 air —— 方块层面完全看不出是映射错了（v1.80 高台烘焙教训）。
 *
 * ⚠️ **三类东西刻意不在本表**，由烘焙脚本的 classify 分支处理：
 *   · `air` —— 要按**甲板分层**（spec DR-2）：组装 y<0 的空气写进产物挖出地牢，
 *     y≥0 的空气丢弃。直查表会丢掉分层语义（全留 → JSON 17MB，全丢 → 地牢被填实）；
 *   · `*_stairs` —— 朝向在 `Properties.facing` 里、倒置在 `half` 里，要转成 meta；
 *     且按源名分流到有/无新烘焙台阶的两组（见烘焙脚本）。
 *   · `*_slab` —— 半/整/倒置在 `Properties.type` 里，要分流（见下方 `SLAB_BASE`）。
 * 把它们塞进本表会让 classify 的分支永远走不到（直查先命中）—— 静默丢朝向/丢分层。
 *
 * 映射理由（逐个说明，便于将来体检）：
 *  - 同名直通 5 种：end_stone / end_stone_bricks / obsidian / chest / stone（本仓已有）。
 *  - 9 个 `cataclysm:*` 整块/柱 → Task 1 新注册的同名方块（obsidian_bricks 9,134 格是
 *    地牢主材；end_stone_pillar 是 cube_column 整块不是细柱，axis 实测 1024/1029 全 y 轴）。
 *  - `cataclysm:void_lantern_block` → `ochre_froglight`：地牢在地下（skylight=0），
 *    134 格灯是唯一的 blocklight 来源；ochre_froglight（亮度档 217 暖白）比 glowstone
 *    （99 暗棕）更接近虚空灯的亮奶白色。**不新烘**（用户裁定：不需要发光新方块）。
 *  - `purpur_block` / `purpur_pillar` / `cataclysm:purpur_void_rune_trap_block` → `purpur_block`：
 *    ⚠️ **v3.19 用户裁定新烘紫珀方块**（提供了 512×512 贴图，六面同图）。
 *    历史：v2.89 映 amethyst → v2.90 改映 deepslate（当时「本仓无紫珀贴图」）→ v3.19 新烘。
 *    只改**本结构**的映射：其他用 amethyst 的地方（祭坛 `tarn-altar.js`、
 *    `cloudland-kit-fingerprint.mjs` 的紫晶柱）与其他用 deepslate 的地方（高台/拱洞/
 *    大竞技场）**一律不动** —— 用户明确要求「不是其他所有的」。
 *  - `crying_obsidian` / `cataclysm:obsidian_explosion_trap_bricks` → `obsidian`：
 *    本仓无哭泣黑曜石；陷阱砖映基础砖（同色系，丢泪痕/裂纹细节）。
 *  - `cataclysm:end_stone_teleport_trap_bricks` → `end_stone_bricks`：传送陷阱→基础砖。
 *    ⚠️ 与 `chiseled_end_stone_bricks` 不同：后者**新烘**（有 mod 贴图），前者没有。
 *  - 4 种墙/栅栏 → `handrail`：本仓唯一的细件栏杆几何。
 *    ⚠️ **本表只给「基础名」，朝向与直段/转角拆分在烘焙脚本的栏杆朝向 pass 里做**
 *    （`bake-ruined-citadel.mjs` 移植自 `bake-burning-arena.mjs` 的 `computeRailOrientations`）：
 *    pass 把 708 格按邻居连接关系改写成 `handrail`（转角件）或 `handrailA`（直段件）。
 *    故 `BLOCK_MAP` 的目标值**保持 `handrail` 不动** —— 它是 `RAIL_SOURCES` 的反查依据
 *    （映射到 handrail 的源方块即栏杆），改它会同时改掉「哪些格参与朝向计算」。
 *  - `chorus_plant` → `vine`、`chorus_flower` → `allium`：紫颂植物/花的最近似。
 *  - `end_rod` → `vertical_pillar`：末地烛细竖件。
 *  - `purple_stained_glass_pane` → `glass_block`：transparent 通道（本仓无玻璃板，用整玻璃）。
 *  - `ender_chest` → `chest`、`shulker_box` → `orange_shulker_box`、`lantern` → `hanging_lamp`。
 *  - 地毯 ×3 / 活板门 ×2 / 花盆 / 拉杆 / 绊线钩 / 木桶（81 格）→ 丢弃：无对应几何，
 *    实测丢弃不造洞（都是贴附在实心面上的薄件）。
 *  - `structure_block`（10 格，Boss 刷怪标记：golem 3 / mimic 4 / sentry 3）与
 *    `cataclysm:altar_of_void`（1 格，虚空祭坛功能块）→ 丢弃：功能标记不是美术内容，
 *    本仓不移植对应生成逻辑。
 */
export const BLOCK_MAP = Object.freeze({
  // 同名直通（本仓已有）
  end_stone: 'end_stone',
  end_stone_bricks: 'end_stone_bricks',
  obsidian: 'obsidian',
  chest: 'chest',
  stone: 'stone',

  // 9 个新烘焙整块/柱（Task 1 注册，照 mod 贴图）
  'cataclysm:obsidian_bricks': 'obsidian_bricks',
  'cataclysm:end_stone_pillar': 'end_stone_pillar',
  'cataclysm:chiseled_end_stone_bricks': 'chiseled_end_stone_bricks',
  'cataclysm:polished_end_stone': 'polished_end_stone',
  'cataclysm:chiseled_purpur_block': 'chiseled_purpur_block',
  'cataclysm:chorus_planks': 'chorus_planks',
  'cataclysm:chiseled_obsidian_bricks': 'chiseled_obsidian_bricks',
  'cataclysm:void_stone': 'void_stone',
  'cataclysm:void_infused_end_stone_bricks': 'void_infused_end_stone_bricks',

  // 照明（不新烘，用户裁定）
  'cataclysm:void_lantern_block': 'ochre_froglight',

  // 紫珀族 → **新烘的 purpur_block**（v3.19 用户裁定，原为 deepslate / 更早是 amethyst）
  // 用户：「末日地堡里的 deepslate 方块都替换成紫色方块，Purpur Block，这是一个新方块，
  // 面用的图是 /Users/bachi/ttt/b/purpur_block.png，六个面都用这个图」。
  // ⚠️ **只改本结构**：高台/拱洞（cloudland-kit）与大竞技场（burning-arena）的 deepslate
  //    一律不动 —— 用户只点名了末日地堡（= 废弃堡垒）。
  // ⚠️ **台阶/半砖不在本期范围**：STAIR_TARGETS.purpur_stairs 与 SLAB_BOTTOM.purpur_slab
  //    仍映既有台阶/沙半砖（用户只对丛林要塞点名了台阶除外，本结构未要求新烘台阶）。
  //    但 SLAB_BASE.purpur_slab（top/double → **整块**）必须跟着换成 purpur_block。
  purpur_block: 'purpur_block',
  purpur_pillar: 'purpur_block',
  'cataclysm:purpur_void_rune_trap_block': 'purpur_block',

  // 黑曜石族归并
  crying_obsidian: 'obsidian',
  'cataclysm:obsidian_explosion_trap_bricks': 'obsidian',
  'cataclysm:end_stone_teleport_trap_bricks': 'end_stone_bricks',

  // 墙/栅栏 → 栏杆（朝向 pass 拆转角/直段，目标值保持 handrail 不动）
  'cataclysm:obsidian_brick_wall': 'handrail',
  end_stone_brick_wall: 'handrail',
  'cataclysm:chorus_fence': 'handrail',
  'cataclysm:purpur_wall': 'handrail',

  // 植物与细件
  chorus_plant: 'vine',
  chorus_flower: 'allium',
  end_rod: 'vertical_pillar',
  purple_stained_glass_pane: 'glass_block',
  ender_chest: 'chest',
  shulker_box: 'orange_shulker_box',
  lantern: 'hanging_lamp',

  // 丢弃：无对应几何的薄件
  purple_carpet: '',
  white_carpet: '',
  magenta_carpet: '',
  iron_trapdoor: '',
  spruce_trapdoor: '',
  flower_pot: '',
  lever: '',
  tripwire_hook: '',
  barrel: '',

  // 丢弃：功能标记
  structure_block: '',
  'cataclysm:altar_of_void': '',
});

/**
 * 半砖（`*_slab`）的**基础整块**显式表 —— `type` 为 `top` / `double` 时映射到这里。
 *
 * ⚠️ **不得用「剥掉 `_slab` 后缀再查 BLOCK_MAP」的写法**：`obsidian_brick_slab` 剥出
 * `cataclysm:obsidian_brick`，而表里是 `cataclysm:obsidian_bricks`（复数）→ 查不到会
 * 静默落到兜底值。兜底成浅色石时，暗色地牢里成片的 double 半砖会极其显眼，
 * 而且**格数完全对得上**，只有看画面才发现（burning-arena 探针实测过这个坑）。
 *
 * `type==='bottom'` 的分流在烘焙脚本：有新半砖的两族（obsidian_brick / end_stone_brick）
 * 映 Task 1 新烘焙的同名半砖，其余族（purpur / polished_end_stone）映 `sand_slab`。
 */
export const SLAB_BASE = Object.freeze({
  'cataclysm:obsidian_brick_slab': 'obsidian_bricks',
  end_stone_brick_slab: 'end_stone_bricks',
  purpur_slab: 'purpur_block',
  'cataclysm:polished_end_stone_slab': 'polished_end_stone',
});

/**
 * 台阶（`*_stairs`）的**源族 → (正置, 倒置) 目标**显式表。
 *
 * 为什么不能统一映一个台阶：本结构有两族台阶**照 mod 贴图新烘了**（Task 1 的
 * `obsidian_brick_step` / `end_stone_brick_step`，合计 2,994 格，占台阶总量 76%），
 * 其余三族无贴图只能映既有的 `stone_diorite_step`。
 *
 * ⚠️ **倒置（`half=top`）的目标不是「正置名 + `_updown`」**：`stone_diorite_step`
 * **没有 `_updown` 变体**（本仓只有 `cobblestone_step_updown` 与 `planks_step_updown`）。
 * 实测受影响 224 格（purpur top 126 / polished_end_stone top 54 / chorus top 44），
 * 裁定映 `cobblestone_step_updown`（唯一已注册的倒置石质台阶，几何正确、贴图偏灰）。
 * 不为此新注册第 16 块（Task 1 已交付，扩 scope 要重走图集/图标/背包全套门禁）。
 *
 * ⚠️ **这张表必须在指纹参数里**：它是烘焙算法的输入，若写在烘焙脚本里，
 * 改它属于「只改算法不动参数」⇒ 指纹拓不到（本模块头注释点名的盲区）。
 */
export const STAIR_TARGETS = Object.freeze({
  // 新烘族（有 mod 贴图）：正置/倒置都有专属方块
  'cataclysm:obsidian_brick_stairs': Object.freeze({ bottom: 'obsidian_brick_step', top: 'obsidian_brick_step_updown' }),
  end_stone_brick_stairs: Object.freeze({ bottom: 'end_stone_brick_step', top: 'end_stone_brick_step_updown' }),
  // 无贴图族：正置用 stone_diorite_step，倒置只能借用 cobblestone_step_updown
  purpur_stairs: Object.freeze({ bottom: 'stone_diorite_step', top: 'cobblestone_step_updown' }),
  'cataclysm:polished_end_stone_stairs': Object.freeze({ bottom: 'stone_diorite_step', top: 'cobblestone_step_updown' }),
  'cataclysm:chorus_stairs': Object.freeze({ bottom: 'stone_diorite_step', top: 'cobblestone_step_updown' }),
});

/**
 * 半砖（`*_slab`）`type==='bottom'` 的**源族 → 目标**显式表。
 *
 * `type==='top'` / `'double'` 的目标在上方 `SLAB_BASE`（映基础整块）。
 *
 * 有新烘半砖的两族（obsidian_brick 2 格 / end_stone_brick 16 格）用 Task 1 的同名半砖；
 * 其余两族（purpur 1,098 / polished_end_stone 8）无半砖贴图，映既有的 `sand_slab`
 * （与 burning-arena 同口径：本仓唯一的通用半砖几何）。
 *
 * ⚠️ 同 `STAIR_TARGETS`：必须在指纹参数里，否则改它拓不到。
 */
export const SLAB_BOTTOM = Object.freeze({
  'cataclysm:obsidian_brick_slab': 'obsidian_brick_slab',
  end_stone_brick_slab: 'end_stone_brick_slab',
  purpur_slab: 'sand_slab',
  'cataclysm:polished_end_stone_slab': 'sand_slab',
});

/**
 * **本期之外新烘的方块**（v3.19）——  supplement 到门禁的「新方块进背包」集合。
 *
 * 为什么需要它：`check:data` 原本用**派生规则**认新烘方块
 * （`cataclysm:X → X` 同名直通 + obsidian_brick/end_stone_brick 族的台阶/半砖）。
 * `purpur_block` 是 **vanilla 名**，三条派生规则一条都不命中 ⇒ 它会静默逃过
 * 「已注册 / 有 faces / 在背包」三道判据。故显式列出，两侧共用这一份（红线 1）。
 *
 * ⚠️ 不得把它写成「所有 palette 里不在 mc-lite 124 项里的方块」：那会把既有替身
 *    （ochre_froglight / deepslate / handrail ……）也拉进来，语义就散了。
 */
export const RUINED_CITADEL_EXTRA_NEW_BLOCKS = Object.freeze(['purpur_block']);

/**
 * 甲板层在**归一化坐标**里的 y（= 产物 JSON 的 `floorRow`）。
 *
 * 实测（`--census` 可复现）：组装 y=-1 层有 8,196 格甲板（覆盖率 72.3%，非满铺），
 * 归一化后 = 45（组装 y + 46）。落位时使甲板正好坐在 floorY 上
 * （`rasterizeStructure(type, wx, floorY - (FLOOR_ROW - 1), wz, ...)`）。
 *
 * ⚠️ 也是 classify 的**空气分层界**（spec DR-2）：组装 y<0 ⟺ 归一化 ny<46 ⟺ ny≤45，
 * 即甲板及以下层的空气写进产物（挖出地牢），甲板以上（塔楼之间的天空）丢弃。
 */
export const FLOOR_ROW = 45;

/**
 * 产物必须满足的指标 —— 烘焙脚本与 `check:data` 共用这一份。
 *
 * 全部实测值（`npm run ruinedcitadel -- --census` 可复现；2026-11-10 冻结）。
 *
 * ⚠️ **与 spec 初稿的差异已按 census 实测修订**（详见计划 ledger）：
 *   · `contentCells` 288,744 = 261,775 非空气 − **91 丢弃**（功能标记 11 + 无几何薄件 80）
 *     + 27,060 甲板下空气。spec 初稿 288,835 一个丢弃都没减。
 *   · 产物 bbox **107×63×110**（含甲板下空气）；**非空气 bbox 才是 106×63×108**
 *     （= footprint，HALF_X/HALF_Z = 53/54）。两者是不同概念，别混。
 *   · `deckCells` **8,197** 是产物口径（含甲板层那 1 格空气竖井 (31,-1,36)）；
 *     非空气口径是 8,196。bake 的断言数产物格，故冻结 8,197。
 *
 * ⚠️ **三个格数要分开看**：
 *   · `sourceCells` 261,775 = 18 片里全部非空气格（含丢弃项）；
 *   · `droppedCells` 91 = 其中丢弃的（功能标记 11 + 薄件 80）；
 *   · `contentCells` 288,744 = 产物格数 = sourceCells − droppedCells + airCells。
 *
 * ⚠️ **`targetCounts` 刻意不含 `handrail` / `handrailA`**：这两者由栏杆朝向 pass 拆分，
 *   格数随算法浮动（总数恒为 `railCells` 708）。逐档分布见 `railOrientationCounts`。
 *   与 burning-arena 同口径（那边 wantCounts 也不含栏杆两名）。
 *
 * ⚠️ **通道分布**：opaque 256,866 / cutout 4,810 / transparent 8（glass_block）/
 *   none 27,060（air，`cullMode:'none'` 不渲染任何面）。cutout 4,810 < 大竞技场 7,588
 *   （本结构栏杆只 708 格 vs 大竞技场 3,311 格）⇒ 预算无压力（spec DR-8）。
 */
export const RUINED_CITADEL_METRICS = Object.freeze({
  ruinedCitadel: Object.freeze({
    width: 107,         // 产物包围盒 X 跨度（含甲板下空气）
    height: 63,         // 产物包围盒 Y 跨度（归一化 y ∈ [1,63]）
    depth: 110,         // 产物包围盒 Z 跨度
    floorRow: FLOOR_ROW,
    sourceCells: 261775,   // 18 片全部非空气格（含丢弃项）
    droppedCells: 91,      // 丢弃格 = 功能标记 11（structure_block 10 + altar_of_void 1）+ 薄件 80
    airCells: 27060,       // 写进产物的甲板下空气格（spec DR-2 核心判据）
    contentCells: 288744,  // 产物格数 = sourceCells − droppedCells + airCells
    deckCells: 8197,       // 甲板层（归一化 y=45）产物格数（含 1 格空气竖井；非空气口径 8,196）
    paletteSize: 34,       // 重映射后的目标方块种数（含 air + handrail + handrailA）
    railCells: 708,        // 栏杆总格数 = handrail + handrailA（朝向 pass 只拆分不增删）
    opaqueCells: 256866,
    cutoutCells: 4810,
    transparentCells: 8,

    /** 逐目标方块格数（不含 handrail/handrailA，见上方注释） */
    targetCounts: Object.freeze({
      end_stone: 225176,
      air: 27060,
      end_stone_bricks: 13655,
      obsidian_bricks: 10983,
      // v3.19：紫珀族 4210 格从 deepslate 换成新烘的 purpur_block（格数不变）
      purpur_block: 4210,
      end_stone_brick_step_updown: 1258,
      obsidian_brick_step: 1096,
      end_stone_pillar: 1029,
      stone_diorite_step: 698,
      end_stone_brick_step: 585,
      chiseled_end_stone_bricks: 451,
      obsidian: 410,
      cobblestone_step_updown: 224,
      polished_end_stone: 208,
      chiseled_purpur_block: 156,
      ochre_froglight: 134,
      chorus_planks: 126,
      chiseled_obsidian_bricks: 122,
      void_stone: 122,
      vine: 85,
      void_infused_end_stone_bricks: 81,
      obsidian_brick_step_updown: 55,
      vertical_pillar: 30,
      sand_slab: 28,
      end_stone_brick_slab: 16,
      chest: 15,
      allium: 9,
      glass_block: 8,
      obsidian_brick_slab: 2,
      orange_shulker_box: 2,
      stone: 1,
      hanging_lamp: 1,
    }),

    /**
     * 台阶朝向分布（**冻结实测值**，`npm run ruinedcitadel -- --census` 可复现）。
     *
     * ⚠️ 这一项部分堵上了「只改烘焙算法指纹不变」的已知盲区：它是算法的*产物*，
     * `check:data` 拿它逐档比对产物 meta.json ⇒ 改朝向算法而忘了重烘/重标基线，门禁会红。
     *
     * 四族台阶（新烘 obsidian_brick / end_stone_brick 各正倒两态 + 既有 stone_diorite_step /
     * cobblestone_step_updown）四向俱全，合计 3,916 格。倒置台阶 meta = (orient+2)%4。
     */
    stepOrientationCounts: Object.freeze({
      'cobblestone_step_updown:0': 60,
      'cobblestone_step_updown:1': 54,
      'cobblestone_step_updown:2': 58,
      'cobblestone_step_updown:3': 52,
      'end_stone_brick_step:0': 130,
      'end_stone_brick_step:1': 157,
      'end_stone_brick_step:2': 134,
      'end_stone_brick_step:3': 164,
      'end_stone_brick_step_updown:0': 282,
      'end_stone_brick_step_updown:1': 334,
      'end_stone_brick_step_updown:2': 306,
      'end_stone_brick_step_updown:3': 336,
      'obsidian_brick_step:0': 273,
      'obsidian_brick_step:1': 289,
      'obsidian_brick_step:2': 272,
      'obsidian_brick_step:3': 262,
      'obsidian_brick_step_updown:0': 12,
      'obsidian_brick_step_updown:1': 14,
      'obsidian_brick_step_updown:2': 11,
      'obsidian_brick_step_updown:3': 18,
      'stone_diorite_step:0': 170,
      'stone_diorite_step:1': 181,
      'stone_diorite_step:2': 171,
      'stone_diorite_step:3': 176,
    }),

    /**
     * 栏杆朝向分布（**冻结实测值**）。
     *
     * ⚠️ `handrailA` 只有 0/1 两档：其 orient 0≡2、1≡3（180° 对称），而 `railPlacementFor`
     * 按 orient 升序返回首个命中 ⇒ 恒为 0（X 轴）或 1（Z 轴）。`handrail` 是转角件，四向俱全。
     *
     * ⚠️ **「抓手指向空气」49.4%（700/1416）是废墟的真实形态，不是算法缺陷**：
     * 实测臂数分布 0 臂 175 格（24.7%）/ 1 臂 352 格（49.7%）/ 2 臂 149 / 3 臂 16 / 4 臂 16。
     * 大竞技场是完整的碗（栏杆成环，24.8%），本结构是**废墟**（断墙、孤立残柱占四分之三）。
     * 用户「抓手尽量靠内」的兜底已在单臂/孤立分支生效，不为此调算法。
     */
    railOrientationCounts: Object.freeze({
      'handrail:0': 115,
      'handrail:1': 102,
      'handrail:2': 82,
      'handrail:3': 94,
      'handrailA:0': 88,
      'handrailA:1': 227,
    }),
  }),
});

/**
 * 烘焙输入指纹：`<18 片内容合并 sha 前 16>:<参数 sha 前 16>`。
 *
 * 两个消费方（烘焙脚本写进 meta、`check:data` 重算比对）必须拿到同一格式。
 * 改 `BLOCK_MAP` / `SLAB_BASE` / `STAIR_TARGETS` / `SLAB_BOTTOM` / `RUINED_CITADEL_PIECES` /
 * `FLOOR_ROW` / `RUINED_CITADEL_METRICS` / `FACING_TO_ORIENT` / 任一片 `.nbt`
 * 都会改变指纹 → 门禁报「产物已过期，跑 npm run ruinedcitadel」，防静默过期。
 *
 * ⚠️ **18 片按 `RUINED_CITADEL_PIECES` 顺序合并后整体求 sha**，不是逐片各算一个：
 * 逐片算会让「片顺序被调换」这种改动拓不到（而顺序错了 = 上下层错位，产物完全不对）。
 *
 * 已知盲区（与图标/夜空/巨树/高台/金字塔/竞技场同口径）：只改**烘焙算法**而不动参数时
 * 指纹不变 —— 那类改动须靠 `src/tests/test-ruined-citadel-gen.js` 的产物契约与 Tier 4 兜住。
 */
export function ruinedCitadelInputFingerprint() {
  const missing = RUINED_CITADEL_PIECES
    .map((p) => path.join(RUINED_CITADEL_SOURCE_DIR, p.file))
    .filter((f) => !fs.existsSync(f));
  if (missing.length > 0) {
    throw new Error(
      `[废弃堡垒] 烘焙输入缺失 ${missing.length}/18 片：${missing.map((f) => path.relative(ROOT, f)).join(', ')}`
      + '（.nbt 入库，缺失 = 仓库损坏）',
    );
  }
  const merged = createHash('sha256');
  for (const p of RUINED_CITADEL_PIECES) {
    merged.update(fs.readFileSync(path.join(RUINED_CITADEL_SOURCE_DIR, p.file)));
  }
  const sourceSha256 = merged.digest('hex');
  const paramsSha256 = createHash('sha256')
    .update(JSON.stringify({
      BLOCK_MAP, SLAB_BASE, STAIR_TARGETS, SLAB_BOTTOM, RUINED_CITADEL_PIECES, FLOOR_ROW,
      RUINED_CITADEL_METRICS, FACING_TO_ORIENT, RUINED_CITADEL_EXTRA_NEW_BLOCKS,
    }))
    .digest('hex');
  return {
    input: `${sourceSha256.slice(0, 16)}:${paramsSha256.slice(0, 16)}`,
    sourceSha256,
    paramsSha256,
  };
}
