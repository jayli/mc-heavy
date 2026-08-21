// src/voxel/faces-data.js — 方块→纹理面映射（从 mc-lite MaterialManager 转换）
// 面索引：0:+X, 1:-X, 2:+Y(top), 3:-Y(bottom), 4:+Z, 5:-Z
// 格式：blockName → [face0tile, face1tile, face2tile, face3tile, face4tile, face5tile]
// 单 tile 方块用字符串（所有面相同）

export const FACES_DATA = {
  grass: ['grass_side_carried', 'grass_side_carried', 'grass_carried', 'dirt', 'grass_side_carried', 'grass_side_carried'],
  dirt: ['dirt', 'dirt', 'dirt_podzol_top', 'dirt_podzol_top', 'dirt', 'dirt'],
  stone: ['stone', 'stone', 'stone_andesite', 'stone_andesite', 'stone', 'stone'],
  stone_diorite: 'stone_diorite',
  gold_ore: 'Deepslate_Gold',
  bricks: 'Bricks',
  cobblestone: 'Cobblestone',
  obsidian: 'Obsidian',
  mossy_stone: 'Mossy_Cobblestone',
  end_stone: 'End_Stone',
  sand: ['sand_side', 'sand_side', 'sand', 'sand', 'sand_side', 'sand_side'],
  hay_bale: ['Hay_Bale', 'Hay_Bale', 'Hay_Bale_top', 'Hay_Bale_top', 'Hay_Bale', 'Hay_Bale'],
  sand_train_track: ['sand', 'sand', 'sand_train_track', 'sand', 'sand', 'sand'],
  sand_train_track_corner: ['sand', 'sand', 'sand_train_track_conner', 'sand', 'sand', 'sand'],
  wood: ['log_big_oak', 'log_big_oak', 'log_big_oak_top', 'log_big_oak_top', 'log_big_oak', 'log_big_oak'],
  birch_log: ['Birch_Log_side', 'Birch_Log_side', 'Birch_Log_top', 'Birch_Log_top', 'Birch_Log_side', 'Birch_Log_side'],
  glass_block: 'Glass',
  glass_blink: 'glass_blink',
  water: 'water',
  swamp_water: 'swamp_water',
  leaves: 'leaves',
  azalea_leaves: 'azalea_leaves',
  yellow_leaves: 'leaves_yellow',
  sky_leaves: 'leaves',
  realistic_oak_leaves: 'oak_leaves_branch_medium',
  realistic_yellow_leaves: 'leaves_yellow',
  swamp_leaves: 'leaves',
  snow_leaves: 'leaves_with_snow',
  moss: 'moss_block',
  swamp_grass: ['grass_side_carried', 'grass_side_carried', 'grass_carried', 'dirt', 'grass_side_carried', 'grass_side_carried'],
  bedrock: 'Bedrock',
  glowstone: 'Glowstone',
  lava: 'Lava',
  hanging_lamp: 'Ochre_Froglight',
  ochre_froglight: 'Ochre_Froglight',
  tnt: ['tnt_side', 'tnt_side', 'tnt_top', 'tnt_top', 'tnt_side', 'tnt_side'],
  // 其余方块默认用 stone（M1 占位，M2 补全）
};

/** 获取方块某面的 tile 名；未知方块返回 'stone' */
export function getFaceTile(blockName, faceIdx) {
  const entry = FACES_DATA[blockName];
  if (!entry) return 'stone';
  if (typeof entry === 'string') return entry;
  return entry[faceIdx] || 'stone';
}
