// src/voxel/faces-data.js — 方块→纹理面映射（从 mc-lite MaterialManager.js 逐条转换）
// 面索引：0:+X(东), 1:-X(西), 2:+Y(top), 3:-Y(bottom), 4:+Z(南), 5:-Z(北)
// 格式：blockName → [face0tile, ..., face5tile]；单 tile 方块用字符串（所有面相同）。
// tile 名 = atlas.json 键（纹理文件名去 .png，子目录保留：'procedural/vine'、'bed/Bed_(...)'）。
// mc-lite 程序化材质（mkMat/mkDetailMat 等无 PNG 文件的）由 tools/bake-procedural-textures.mjs
// 离线烘焙到 assets/textures/procedural/，逐行复刻其 canvas 绘制参数。
// null = 该面不渲染（mc-lite 中 transparent opacity 0 的面，如床的连接面/底面）。

export const FACES_DATA = {
  // ---- 地形基础 ----
  grass: ['grass_side_carried', 'grass_side_carried', 'grass_carried', 'procedural/grass_bottom', 'grass_side_carried', 'grass_side_carried'],
  // 浅水高台（v2.11）：深/浅草方块 **六面同一张贴图**（用户 2026-11-01：「六个面贴图用 …」）。
  // 写成单字符串形式（与 `snow: 'Snow_top'` 同手法）而不是 6 项数组 ——
  // 数组会让人以为六面可以各不相同，而这里的语义是「就是同一个 tile」。
  // tile 由 `npm run grasstextures` 烘焙（源图 736×736 → 46×46 盒式平均 → 16×16）。
  dark_grass: 'procedural/dark_grass',
  light_grass: 'procedural/light_grass',
  dirt: ['dirt', 'dirt', 'dirt_podzol_top', 'dirt_podzol_top', 'dirt', 'dirt'],
  stone: ['stone', 'stone', 'stone_andesite', 'stone_andesite', 'stone', 'stone'],
  stone_diorite: 'stone_diorite',
  sand: ['sand_side', 'sand_side', 'sand', 'sand', 'sand_side', 'sand_side'],
  // 巨型金字塔（Giant Pyramid Epic）：台阶与半砖**复用既有 sand tile，零新增贴图**。
  // 面序 0:+X 1:-X 2:+Y 3:-Y 4:+Z 5:-Z；顶/底用 `sand`（正面纹理），四侧用 `sand_side`——
  // 与上面的 sand 方块同口径（否则台阶侧面的砂粒方向与主体不一致，贴面时会看出接缝）。
  sand_step: ['sand_side', 'sand_side', 'sand', 'sand', 'sand_side', 'sand_side'],
  sand_slab: ['sand_side', 'sand_side', 'sand', 'sand', 'sand_side', 'sand_side'],
  moss: ['dirt_podzol_side', 'dirt_podzol_side', 'moss_block', 'moss_block', 'dirt_podzol_side', 'dirt_podzol_side'],
  swamp_grass: ['Mossy_Cobblestone_side', 'Mossy_Cobblestone_side', 'procedural/swamp_grass_top', 'procedural/swamp_grass_top', 'Mossy_Cobblestone_side', 'Mossy_Cobblestone_side'],
  snow: 'Snow_top',
  snow_grass: ['Snowy_Grass_Block_side', 'Snowy_Grass_Block_side', 'Snow_top', 'dirt', 'Snowy_Grass_Block_side', 'Snowy_Grass_Block_side'],
  ice: 'ice',
  marble: 'procedural/marble',
  clay: 'Clay',
  bedrock: 'Bedrock',
  end_stone: 'End_Stone',
  // ---- 水/天空 ----
  // 水方块贴图走烘焙产物（`npm run water`）：源图是高饱和紫蓝 `47/102/211`，与海面平面
  // （`ocean.js`，浅海蓝）差 85 → 海岸线上表现为「亮紫蓝水带浮在浅蓝水面上」。
  // 烘焙只做通道平移（保留 24 种色阶），把均值拉到 `95/140/168`，差距降到 17。
  // ⚠️ 改 `ocean.js` 的水面配色后必须重算 `WATER_TARGET_MEAN` 并重跑 `npm run water` + `npm run atlas`。
  water: 'procedural/water',
  swamp_water: 'procedural/swamp_water',
  cloud: 'procedural/cloud',
  sky_wood: 'procedural/sky_wood',
  sky_leaves: 'procedural/sky_leaves',
  sky_stone: 'procedural/sky_stone',
  sky_grass: 'procedural/sky_grass',
  // ---- 玻璃 ----
  glass_block: 'Glass',
  glass_blink: 'glass_blink',
  // ---- 树叶族（mc-lite 全 FrontSide + alphaTest，realistic_oak 例外 DoubleSide）----
  // ⚠️ 2026-10-23（用户裁定）：本仓全部树叶 **cutout 通道 + opaqueTable=1**，且贴图孔洞率统一压到
  // 14.8%（与巨树叶一致，让叶面更密）。5 张源图的孔洞率原本是 23%~**77.6%**，压完后叶面覆盖
  // 统一到 85%。**孔洞压缩产物在 procedural/leaf_*，源图不动**（`npm run leaftextures` 烘焙）。
  // ⚠️ `procedural/sky_leaves` 例外：它走 opaque 通道（材质本就无 alphaTest）→ 不压缩、不在此列。
  leaves: 'procedural/leaf_leaves',
  azalea_leaves: 'procedural/leaf_azalea_leaves',
  azalea_flowers: 'procedural/leaf_azalea_flowers',
  yellow_leaves: 'procedural/leaf_leaves_yellow',
  realistic_oak_leaves: 'procedural/leaf_oak_leaves_branch_medium',
  realistic_yellow_leaves: 'procedural/leaf_leaves_yellow',
  swamp_leaves: 'procedural/leaf_leaves', // mc-lite 未注册材质（死方块）；按 leaves 渲染兜底
  snow_leaves: ['procedural/leaf_leaves_with_snow', 'procedural/leaf_leaves_with_snow', 'Snow_top', 'procedural/leaf_leaves', 'procedural/leaf_leaves_with_snow', 'procedural/leaf_leaves_with_snow'],
  // ---- 原木/木板 ----
  wood: ['log_big_oak', 'log_big_oak', 'log_big_oak_top', 'log_big_oak_top', 'log_big_oak', 'log_big_oak'],
  dark_oak: 'Stripped_Dark_Oak_Log_(texture)_JE1',
  birch_log: ['Birch_Log_side', 'Birch_Log_side', 'Birch_Log_top', 'Birch_Log_top', 'Birch_Log_side', 'Birch_Log_side'],
  azalea_log: 'procedural/azalea_log',
  planks: 'planks_birch',
  oak_planks: 'Oak_Planks',
  oak_planks_1: 'Oak_Planks_1',
  white_planks: 'White_Wood_Planks',
  dark_planks: 'dark_planks',
  blue_planks: 'Blue_Wood_Planks',
  green_planks: 'Green_Wood_Planks',
  acacia_planks: 'Acacia_Planks',
  hay_bale: ['Hay_Bale', 'Hay_Bale', 'Hay_Bale_top', 'Hay_Bale_top', 'Hay_Bale', 'Hay_Bale'],
  // ---- 石质建材 ----
  cobblestone: 'Cobblestone',
  mossy_stone: 'Mossy_Cobblestone',
  bricks: 'Bricks',
  stone_bricks: 'Stone_Bricks',
  smooth_stone: 'Smooth_Stone',
  smooth_stone_1: 'Smooth_Stone_1',
  polished_diorite: 'Polished_Diorite',
  polished_granite: 'Polished_Granite',
  deepslate: 'Deepslate',
  deepslate_diamond_ore: 'Deepslate_Diamond_Ore',
  polished_deepslate: 'Polished_Deepslate',
  tuff_bricks: 'Tuff_Bricks',
  mud_bricks: 'Mud_Bricks',
  end_stone_bricks: 'End_Stone_Bricks',
  nether_bricks: 'Nether_Bricks',
  nether_bricks_1: 'Nether_Bricks_1',
  polished_blackstone_bricks: 'Polished_Blackstone_Bricks',
  block_of_quartz: 'Block_of_Quartz',
  quartz_bricks: 'Quartz_Bricks',
  // ---- 矿石/金属 ----
  gold_ore: 'Deepslate_Gold',
  iron_ore: 'Iron_Ore',
  nether_gold_ore: 'Nether_Gold_Ore',
  iron: 'iron',
  gold_block: 'gold_block',
  diamond: 'diamond',
  emerald: 'emerald',
  amethyst: 'amethyst',
  debris: ['Ancient_Debris_side', 'Ancient_Debris_side', 'Ancient_Debris_top', 'Ancient_Debris_top', 'Ancient_Debris_side', 'Ancient_Debris_side'],
  obsidian: 'Obsidian',
  netherrack: 'Netherrack',
  // ---- 功能方块 ----
  tnt: ['tnt_side', 'tnt_side', 'tnt_top', 'tnt_top', 'tnt_side', 'tnt_side'],
  chest: ['box_side', 'box_side', 'box_top', 'box_side', 'box_face', 'box_side'],
  bookbox: ['Bone_Block_side_texture_JE2_BE2', 'Bone_Block_side_texture_JE2_BE2', 'Bone_Block_top_texture_JE2_BE2', 'Bone_Block_top_texture_JE2_BE2', 'Bookshelf_texture_JE2_BE2', 'Bone_Block_side_texture_JE2_BE2'],
  glowstone: 'Glowstone',
  ochre_froglight: 'Ochre_Froglight',
  lava: 'Lava',
  oxidized_cut_copper: 'Oxidized_Cut_Copper',
  weathered_cut_copper: 'Weathered_Cut_Copper',
  brain_coral_block: 'Brain_Coral_Block',
  block_of_amber: 'Block_of_Amber',
  floatato: 'Floatato',
  light_gray_cloth: 'Light_Gray_Cloth',
  pink_wool: 'Pink_Wool',
  snow_block: 'Snow',
  piston: 'Piston',
  piston_head: 'Piston_Head',
  orange_shulker_box: 'Orange_Shulker_Box',
  zombie_nest_alias_block: 'zombie_nest_alias_block',
  // M8 实玩反馈修正：**直接复用 mc-lite 的手工炮塔图标** `turret.png`（字节完全一致，
  // 已在 atlas 内）—— 不再用程序化生成的 `procedural/turret_alias_block`。
  // mc-lite 同口径：`ItemIconUtils.getCustomIconPath()` 把 `turret_alias_block` 映射到
  // `src/assets/textures/turret.png`（`:23`），与 `zombie_nest_alias_block` 同一手法。
  turret_alias_block: 'turret',
  playground_block: 'procedural/playground_block',
  playground_center_block: 'procedural/playground_center_block',
  // ---- 轨道 ----
  sand_train_track: ['sand', 'sand', 'sand_train_track', 'sand', 'sand', 'sand'],
  sand_train_track_corner: ['sand', 'sand', 'sand_train_track_conner', 'sand', 'sand', 'sand'],
  // ---- 植被（cross/水平 quad 模板，tile 取 face4 条目）----
  flower: 'procedural/flower',
  short_grass: 'double_plant_grass_carried',
  allium: 'flower_Allium',
  azure_bluet: 'Azure_Bluet',
  dead_bush: 'Dead_Bush',
  oxeye_daisy: 'Oxeye_Daisy',
  red_mushroom: 'Red_Mushroom',
  vine: 'procedural/vine',
  lilypad: 'procedural/lilypad',
  cactus: 'procedural/cactus',
  // ---- 特殊几何（mc-lite 程序化材质，烘焙入图）----
  chimney: 'procedural/chimney',
  handrail: 'procedural/handrail',
  handrailA: 'procedural/handrailA',
  handrailB: 'procedural/handrailB',
  vertical_pillar: 'procedural/pillar',
  horizontal_pillar: 'procedural/pillar_horizontal',
  hanging_lamp: 'procedural/hanging_lamp',
  // ---- 台阶（模板几何，单 tile）----
  planks_step: 'planks_birch',
  cobblestone_step: 'Cobblestone',
  cobblestone_step_updown: 'Cobblestone',
  stone_diorite_step: 'stone_diorite',
  // ---- 床（half_block 模板；UV 变换见 mesher BED_UV；null 面不渲染）----
  bed_head: ['bed/Bed_(top_side_texture)_JE2_BE2', 'bed/Bed_(top_side_texture)_JE2_BE2', 'bed/Bed_(top_texture)_JE1_BE1', null, 'bed/Bed_(back_texture)_JE2_BE2', null],
  bed_tail: ['bed/Bed_(bottom_side_texture)_JE2_BE2', 'bed/Bed_(bottom_side_texture)_JE2_BE2', 'bed/Bed_(bottom_texture)_JE1_BE1', null, null, 'bed/Bed_(front_texture)_JE2_BE2'],
  // ---- 巨树景观（Giant Trees Epic）----
  // giant_oak_log 复用既有 tile（log_big_oak）；其余 7 张由 tools/bake-giant-textures.mjs
  // 烘焙到 assets/textures/procedural/。
  // ⚠️ giant_oak_leaves **不再复用** 普通树叶的 `leaves` tile（2026-10-23 改）：两者必须分开，
  //    否则无法给巨树单独做「更密的孔洞图案」（用户需求：巨树冠更茂盛）。共用一张图时
  //    改它会把普通树叶一起改掉。
  giant_oak_log: ['log_big_oak', 'log_big_oak', 'log_big_oak_top', 'log_big_oak_top', 'log_big_oak', 'log_big_oak'],
  giant_mangrove_log: 'procedural/giant_mangrove_log',
  giant_oak_leaves: 'procedural/giant_oak_leaves',
  giant_birch_leaves: 'procedural/giant_birch_leaves',
  giant_spruce_leaves: 'procedural/giant_spruce_leaves',
  giant_cherry_leaves: 'procedural/giant_cherry_leaves',
  giant_palm_leaves: 'procedural/giant_palm_leaves',
  giant_banyan_leaves: 'procedural/giant_banyan_leaves',
};

/**
 * 获取方块某面的 tile 名。
 * @returns {string|null} tile 名；数组条目可为 null（该面不渲染）；未知方块返回 'stone' 兜底。
 */
export function getFaceTile(blockName, faceIdx) {
  const entry = FACES_DATA[blockName];
  if (!entry) return 'stone';
  if (typeof entry === 'string') return entry;
  return entry[faceIdx] ?? null;
}
