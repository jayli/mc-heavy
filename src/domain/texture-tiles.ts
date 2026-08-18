export const TEXTURE_FILES = Object.freeze([
  'Acacia_Planks.png',
  'Ancient_Debris_side.png',
  'Ancient_Debris_top.png',
  'Azure_Bluet.png',
  'Bedrock.png',
  'Birch_Log_side.png',
  'Birch_Log_top.png',
  'Block_of_Amber.png',
  'Block_of_Quartz.png',
  'Blue_Wood_Planks.png',
  'Bone_Block_side_texture_JE2_BE2.png',
  'Bone_Block_top_texture_JE2_BE2.png',
  'Bookshelf_texture_JE2_BE2.png',
  'Brain_Coral_Block.png',
  'Bricks.png',
  'Clay.png',
  'Cobblestone.png',
  'Cobblestone_step.png',
  'Cobblestone_step_updown.png',
  'Dead_Bush.png',
  'Deepslate.png',
  'Deepslate_Diamond_Ore.png',
  'Deepslate_Gold.png',
  'End_Stone.png',
  'End_Stone_Bricks.png',
  'Floatato.png',
  'Glass.png',
  'Glowstone.png',
  'Green_Wood_Planks.png',
  'Hay_Bale.png',
  'Hay_Bale_top.png',
  'Invicon_Minecart.png',
  'Iron_Ore.png',
  'Lava.png',
  'Light_Gray_Cloth.png',
  'Mossy_Cobblestone.png',
  'Mossy_Cobblestone_side.png',
  'Mud_Bricks.png',
  'Nether_Bricks.png',
  'Nether_Bricks_1.png',
  'Nether_Gold_Ore.png',
  'Netherrack.png',
  'Oak_Planks.png',
  'Oak_Planks_1.png',
  'Oak_Planks_step.png',
  'Obsidian.png',
  'Ochre_Froglight.png',
  'Orange_Shulker_Box.png',
  'Oxeye_Daisy.png',
  'Oxidized_Cut_Copper.png',
  'Pink_Wool.png',
  'Piston.png',
  'Piston_Head.png',
  'Polished_Blackstone_Bricks.png',
  'Polished_Deepslate.png',
  'Polished_Diorite.png',
  'Polished_Granite.png',
  'Quartz_Bricks.png',
  'Red_Mushroom.png',
  'Smooth_Stone.png',
  'Smooth_Stone_1.png',
  'Snow.png',
  'Snow_top.png',
  'Snowy_Grass_Block_side.png',
  'Stone_Bricks.png',
  'Stripped_Dark_Oak_Log_(texture)_JE1.png',
  'Tuff_Bricks.png',
  'Weathered_Cut_Copper.png',
  'White_Wood_Planks.png',
  'amethyst.png',
  'azalea_leaves.png',
  'bed/Bed_(back_texture)_JE2_BE2.png',
  'bed/Bed_(bottom_side_texture)_JE2_BE2.png',
  'bed/Bed_(bottom_texture)_JE1_BE1.png',
  'bed/Bed_(front_texture)_JE2_BE2.png',
  'bed/Bed_(top_side_texture)_JE2_BE2.png',
  'bed/Bed_(top_texture)_JE1_BE1.png',
  'box_face.png',
  'box_side.png',
  'box_top.png',
  'dark_planks.png',
  'diamond.png',
  'dirt.png',
  'dirt_podzol_side.png',
  'dirt_podzol_top.png',
  'double_plant_grass_carried.png',
  'emerald.png',
  'flower_Allium.png',
  'flowering_azalea_leaves.png',
  'glass_blink.png',
  'gold.png',
  'gold_block.png',
  'grass_carried.png',
  'grass_side_carried.png',
  'handrail.png',
  'handrailA.png',
  'handrailB.png',
  'ice.png',
  'iron.png',
  'leaves.png',
  'leaves_original.png',
  'leaves_with_snow.png',
  'leaves_yellow.png',
  'log_big_oak.png',
  'log_big_oak_top.png',
  'moss_block.png',
  'oak_leaves_branch_medium.png',
  'pillar.png',
  'pillar_horizontal.png',
  'planks_birch.png',
  'sand.png',
  'sand_side.png',
  'sand_train_track.png',
  'sand_train_track_conner.png',
  'stone.png',
  'stone_andesite.png',
  'stone_diorite.png',
  'stone_diorite_step.png',
  'tnt_side.png',
  'tnt_top.png',
  'turret.png',
  'zombie_nest_alias_block.png',
] as const);

export type SyntheticTile = Readonly<{
  key: string;
  color?: string;
  alpha?: number;
  draw?: 'flower' | 'vine' | 'lilypad';
}>;

export const SYNTHETIC_TILES = Object.freeze([
  { key: 'color:#205099', color: '#205099', alpha: 0.6 },
  { key: 'color:#2F4F4F', color: '#2F4F4F', alpha: 0.7 },
  { key: 'color:#559944', color: '#559944' },
  { key: 'color:#FFFFFF', color: '#FFFFFF' },
  { key: 'color:#DDA0DD', color: '#DDA0DD' },
  { key: 'color:#635338', color: '#635338' },
  { key: 'color:#FF69B4', color: '#FF69B4' },
  { key: 'color:#2E8B57', color: '#2E8B57' },
  { key: 'color:#3E5A3A', color: '#3E5A3A' },
  { key: 'color:#E8E8E8', color: '#E8E8E8' },
  { key: 'color:#F2F0E6', color: '#F2F0E6' },
  { key: 'color:#4C5E34', color: '#4C5E34' },
  { key: 'color:#FFD75E', color: '#FFD75E' },
  { key: 'draw:flower', draw: 'flower' },
  { key: 'draw:vine', draw: 'vine' },
  { key: 'draw:lilypad', draw: 'lilypad' },
] as const satisfies readonly SyntheticTile[]);

export const TILE_COUNT = TEXTURE_FILES.length + SYNTHETIC_TILES.length;

export function textureTileId(name: string): number {
  const id = (TEXTURE_FILES as readonly string[]).indexOf(name);
  if (id < 0) throw new Error(`Unknown texture: ${name}`);
  return id;
}

export function textureTileName(tileId: number): string {
  const name = TEXTURE_FILES[tileId];
  if (name === undefined) throw new Error(`Unknown tile id: ${tileId}`);
  return name;
}

export function syntheticTileId(key: string): number {
  const id = (SYNTHETIC_TILES as readonly SyntheticTile[]).findIndex((tile) => tile.key === key);
  if (id < 0) throw new Error(`Unknown synthetic tile: ${key}`);
  return TEXTURE_FILES.length + id;
}

export function tileSpec(tileId: number): { kind: 'file'; name: string } | { kind: 'synthetic'; spec: SyntheticTile } {
  if (tileId < TEXTURE_FILES.length) return { kind: 'file', name: TEXTURE_FILES[tileId] };
  const spec = SYNTHETIC_TILES[tileId - TEXTURE_FILES.length];
  if (!spec) throw new Error(`Unknown tile id: ${tileId}`);
  return { kind: 'synthetic', spec };
}
