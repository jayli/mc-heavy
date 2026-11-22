// src/voxel/wet-material-data.js — 方块的「湿表面材质分类」（v3.31，three-free）
//
// 设计稿：docs/superpowers/specs/2026-11-22-wet-surface-rebuild-design.md §5
//
// ## 为什么需要分类（用户 2026-11-22 裁定）
//
// 用户原话：「地面反光材质有好几种，有光滑的比较镜面反射的，有草地的，带一些粗糙纹理的
// 反光的，等等有不同的材料，你直接就一种反光材质」。
// 上游 bj-shooting-game 只有一张地面 mesh、一套 puddle 参数 ⇒ 挂到体素上就是「一刀切」。
// 本表按**表面物理**（致密度 / 吸水性）把 150 个渲染通道方块分成九类，
// 每类一组 (wetGain, darken, rough, specGain)，参数表在 `render/wet-surface-config.js`。
//
// ## 为什么分类走 packed 位而不是新顶点属性（**硬约束，实测**）
//
// 三通道静态顶点缓冲（CAPACITY：opaque 4.275M / cutout 2.20M / transparent 0.30M，索引 ×1.5）：
//   · 24B/顶点（pos 3×f32 + uv 2×f32 + packed u32）= **193.83 MiB**
//   · 28B/顶点（加一个 float 属性）      = **219.68 MiB**
// 而 `tests/m3-fullscene.spec.mjs` 的门是 **200 MiB** ⇒ 加属性直接超门 19.7 MiB。
// ⇒ 分类塞进 `packed` 的 **bit15–18**（Uint32，现用 bit0–14，高位全空）：
//   **零字节增量**，且 mesher 是 Worker/主线程共用同一份（红线 8）⇒ 两条路径自动一致。
//
// ## 为什么 NONE 是默认值（安全失败方向）
//
// 未列出的方块回落 `NONE`（完全不湿）—— 新增方块顶多「在雨里是干的」，
// 不会「湿错」（例如把云当成地面，那正是用户报告的高空光晕根因）。
// 漏分类由 `test-wet-surface.js` 的覆盖断言当场抓红，不靠人肉核对。
//
// ⚠️ 本文件不 import three（Worker 同构层，红线 8/10）。
// ⚠️ **不改 blocks-data.js 的方块顺序或数量** —— 本表是 name→值 的旁路映射，
//    registry 的 `fingerprint()` 只哈希有序名字串 ⇒ 旧存档 edits 逐位不受影响。

/**
 * 湿表面材质类（4 bit，写入 `packed` bit15–18）。
 *
 * ⚠️ **数值是载荷性的**：它进 packed 位段，也是 `WET_CLASS_PARAMS` 的下标。
 * 改数值等于改 GPU 上的语义，必须同步参数表并重跑 Tier 4。
 * ⚠️ 新增类必须同步 `WET_CLASS_COUNT`（参数数组长度由它钉住）；
 * 超过 16 类会溢出 4 bit —— 那时才需要动位段布局。
 */
export const WET_CLASS = Object.freeze({
  /** 完全不湿：云 / 自发光体 / 装置占位块 / 机械件 */
  NONE: 0,
  /** 抛光致密面：近镜面（平滑石 / 抛光岩 / 大理石 / 石英 / 黑曜石 / 雕纹砖） */
  POLISHED: 1,
  /** 粗糙石材：中等反光、明显压暗（原石 / 圆石 / 砖 / 各矿石 / 深板岩） */
  STONE: 2,
  /** 土 / 草 / 沙 / 雪 / 黏土：强吸水 ⇒ 最暗、最散 */
  SOIL: 3,
  /** 木材：中等（原木 / 木板 / 台阶 / 栏杆 / 柱子） */
  WOOD: 4,
  /** 金属与宝石：少吸水、强镜面（高折射率） */
  METAL: 5,
  /** 冰：本来就滑 ⇒ 湿增益小，但镜面最强 */
  ICE: 6,
  /** 布 / 羊毛 / 干草：极强吸水 ⇒ 最暗、几乎无镜面 */
  FABRIC: 7,
  /** 树叶 / 花 / 草 / 藤 / 仙人掌：极弱（植被在雨里保持哑光） */
  PLANT: 8,
});

/** 类数 —— `WET_CLASS_PARAMS` 的长度由它钉住（Review Focus #2）。 */
export const WET_CLASS_COUNT = 9;

/**
 * 方块名 → 湿表面材质类。**150 项，覆盖全部 opaque(105) + cutout(45) 方块**。
 *
 * 分组依据是表面物理，不是 biome、不是贴图名：
 *   · 同为「石头」，`smooth_stone`（抛光）与 `cobblestone`（粗糙）分属两类；
 *   · 同为「植物」，`hay_bale`（干草捆，吸水如布）归 FABRIC 而 `short_grass` 归 PLANT；
 *   · `mossy_stone` / `mossy_stone_bricks` 表面覆苔 ⇒ 归 SOIL（吸水如土），不是 STONE。
 *
 * ⚠️ **`cloud` 必须是 NONE**：它 `cullMode:'opaque'` 会吃体素 opaque 通道的湿分支，
 * 而云在 y=35/55 —— 上游那套「压平到镜面再投影」在那里必然错位，
 * 正是用户截图里高空云层光晕的根因（spec §2.2）。
 * ⚠️ 自发光体（lava/glowstone/ochre_froglight/hanging_lamp）也必须是 NONE：
 * 它们自身发亮，再叠一层「湿反光」会读作双层光源。
 */
export const WET_CLASS_DATA = Object.freeze({
  // ---- NONE（18）：云 / 自发光 / 装置占位 / 机械件 ----
  cloud: WET_CLASS.NONE,
  lava: WET_CLASS.NONE,
  glowstone: WET_CLASS.NONE,
  ochre_froglight: WET_CLASS.NONE,
  hanging_lamp: WET_CLASS.NONE,
  turret_alias_block: WET_CLASS.NONE,
  zombie_nest_alias_block: WET_CLASS.NONE,
  playground_block: WET_CLASS.NONE,
  playground_center_block: WET_CLASS.NONE,
  floatato: WET_CLASS.NONE,
  brain_coral_block: WET_CLASS.NONE,
  bed_head: WET_CLASS.NONE,
  bed_tail: WET_CLASS.NONE,
  orange_shulker_box: WET_CLASS.NONE,
  piston: WET_CLASS.NONE,
  piston_head: WET_CLASS.NONE,
  sand_train_track: WET_CLASS.NONE,
  sand_train_track_corner: WET_CLASS.NONE,

  // ---- POLISHED（21）：抛光 / 致密 / 雕纹 ----
  smooth_stone: WET_CLASS.POLISHED,
  smooth_stone_1: WET_CLASS.POLISHED,
  polished_diorite: WET_CLASS.POLISHED,
  polished_granite: WET_CLASS.POLISHED,
  polished_deepslate: WET_CLASS.POLISHED,
  polished_blackstone_bricks: WET_CLASS.POLISHED,
  polished_end_stone: WET_CLASS.POLISHED,
  marble: WET_CLASS.POLISHED,
  block_of_quartz: WET_CLASS.POLISHED,
  quartz_bricks: WET_CLASS.POLISHED,
  obsidian: WET_CLASS.POLISHED,
  obsidian_bricks: WET_CLASS.POLISHED,
  chiseled_obsidian_bricks: WET_CLASS.POLISHED,
  obsidian_brick_step: WET_CLASS.POLISHED,
  obsidian_brick_step_updown: WET_CLASS.POLISHED,
  obsidian_brick_slab: WET_CLASS.POLISHED,
  chiseled_purpur_block: WET_CLASS.POLISHED,
  purpur_block: WET_CLASS.POLISHED,
  chiseled_stone_bricks: WET_CLASS.POLISHED,
  chiseled_end_stone_bricks: WET_CLASS.POLISHED,
  end_stone_pillar: WET_CLASS.POLISHED,

  // ---- STONE（31）：粗糙石材 / 砖 / 矿石 ----
  stone: WET_CLASS.STONE,
  stone_diorite: WET_CLASS.STONE,
  cobblestone: WET_CLASS.STONE,
  bricks: WET_CLASS.STONE,
  calcite: WET_CLASS.STONE,
  end_stone: WET_CLASS.STONE,
  end_stone_bricks: WET_CLASS.STONE,
  stone_bricks: WET_CLASS.STONE,
  cracked_stone_bricks: WET_CLASS.STONE,
  tuff_bricks: WET_CLASS.STONE,
  mud_bricks: WET_CLASS.STONE,
  nether_bricks: WET_CLASS.STONE,
  nether_bricks_1: WET_CLASS.STONE,
  netherrack: WET_CLASS.STONE,
  deepslate: WET_CLASS.STONE,
  deepslate_diamond_ore: WET_CLASS.STONE,
  bedrock: WET_CLASS.STONE,
  gold_ore: WET_CLASS.STONE,
  iron_ore: WET_CLASS.STONE,
  nether_gold_ore: WET_CLASS.STONE,
  debris: WET_CLASS.STONE,
  tnt: WET_CLASS.STONE,
  sky_stone: WET_CLASS.STONE,
  void_stone: WET_CLASS.STONE,
  void_infused_end_stone_bricks: WET_CLASS.STONE,
  cobblestone_step: WET_CLASS.STONE,
  cobblestone_step_updown: WET_CLASS.STONE,
  stone_diorite_step: WET_CLASS.STONE,
  end_stone_brick_step: WET_CLASS.STONE,
  end_stone_brick_step_updown: WET_CLASS.STONE,
  end_stone_brick_slab: WET_CLASS.STONE,

  // ---- SOIL（16）：土 / 草 / 沙 / 雪 / 黏土 / 覆苔 ----
  grass: WET_CLASS.SOIL,
  dark_grass: WET_CLASS.SOIL,
  light_grass: WET_CLASS.SOIL,
  swamp_grass: WET_CLASS.SOIL,
  sky_grass: WET_CLASS.SOIL,
  dirt: WET_CLASS.SOIL,
  moss: WET_CLASS.SOIL,
  mossy_stone: WET_CLASS.SOIL,
  mossy_stone_bricks: WET_CLASS.SOIL,
  sand: WET_CLASS.SOIL,
  sand_step: WET_CLASS.SOIL,
  sand_slab: WET_CLASS.SOIL,
  snow: WET_CLASS.SOIL,
  snow_grass: WET_CLASS.SOIL,
  snow_block: WET_CLASS.SOIL,
  clay: WET_CLASS.SOIL,

  // ---- WOOD（27）：原木 / 木板 / 木台阶 / 栏杆 / 柱子 / 木箱 ----
  wood: WET_CLASS.WOOD,
  dark_oak: WET_CLASS.WOOD,
  birch_log: WET_CLASS.WOOD,
  azalea_log: WET_CLASS.WOOD,
  giant_oak_log: WET_CLASS.WOOD,
  giant_mangrove_log: WET_CLASS.WOOD,
  sky_wood: WET_CLASS.WOOD,
  planks: WET_CLASS.WOOD,
  oak_planks: WET_CLASS.WOOD,
  oak_planks_1: WET_CLASS.WOOD,
  white_planks: WET_CLASS.WOOD,
  dark_planks: WET_CLASS.WOOD,
  blue_planks: WET_CLASS.WOOD,
  green_planks: WET_CLASS.WOOD,
  acacia_planks: WET_CLASS.WOOD,
  chorus_planks: WET_CLASS.WOOD,
  planks_step: WET_CLASS.WOOD,
  planks_step_updown: WET_CLASS.WOOD,
  half_block_updown: WET_CLASS.WOOD,
  handrail: WET_CLASS.WOOD,
  handrailA: WET_CLASS.WOOD,
  handrailB: WET_CLASS.WOOD,
  vertical_pillar: WET_CLASS.WOOD,
  horizontal_pillar: WET_CLASS.WOOD,
  chimney: WET_CLASS.WOOD,
  chest: WET_CLASS.WOOD,
  bookbox: WET_CLASS.WOOD,

  // ---- METAL（8）：金属块 / 宝石 / 氧化铜 ----
  iron: WET_CLASS.METAL,
  gold_block: WET_CLASS.METAL,
  diamond: WET_CLASS.METAL,
  emerald: WET_CLASS.METAL,
  amethyst: WET_CLASS.METAL,
  block_of_amber: WET_CLASS.METAL,
  oxidized_cut_copper: WET_CLASS.METAL,
  weathered_cut_copper: WET_CLASS.METAL,

  // ---- ICE（1）----
  ice: WET_CLASS.ICE,

  // ---- FABRIC（3）：布 / 羊毛 / 干草捆 ----
  light_gray_cloth: WET_CLASS.FABRIC,
  pink_wool: WET_CLASS.FABRIC,
  hay_bale: WET_CLASS.FABRIC,

  // ---- PLANT（25）：树叶族 / 花 / 草 / 藤 / 睡莲 / 仙人掌 ----
  leaves: WET_CLASS.PLANT,
  azalea_leaves: WET_CLASS.PLANT,
  azalea_flowers: WET_CLASS.PLANT,
  yellow_leaves: WET_CLASS.PLANT,
  realistic_yellow_leaves: WET_CLASS.PLANT,
  swamp_leaves: WET_CLASS.PLANT,
  snow_leaves: WET_CLASS.PLANT,
  sky_leaves: WET_CLASS.PLANT,
  giant_oak_leaves: WET_CLASS.PLANT,
  giant_birch_leaves: WET_CLASS.PLANT,
  giant_spruce_leaves: WET_CLASS.PLANT,
  giant_cherry_leaves: WET_CLASS.PLANT,
  giant_palm_leaves: WET_CLASS.PLANT,
  giant_banyan_leaves: WET_CLASS.PLANT,
  flower: WET_CLASS.PLANT,
  short_grass: WET_CLASS.PLANT,
  bush_grass: WET_CLASS.PLANT,
  allium: WET_CLASS.PLANT,
  azure_bluet: WET_CLASS.PLANT,
  dead_bush: WET_CLASS.PLANT,
  oxeye_daisy: WET_CLASS.PLANT,
  red_mushroom: WET_CLASS.PLANT,
  vine: WET_CLASS.PLANT,
  lilypad: WET_CLASS.PLANT,
  cactus: WET_CLASS.PLANT,
});

/**
 * 方块名 → 类值。未列出 ⇒ `NONE`（安全失败：顶多不湿，不会湿错）。
 * @param {string} name
 * @returns {number} 0..WET_CLASS_COUNT-1
 */
export function wetClassOf(name) {
  return WET_CLASS_DATA[name] ?? WET_CLASS.NONE;
}