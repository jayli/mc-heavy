import { syntheticTileId, textureTileId } from './texture-tiles';

export type RenderClass = 'opaque' | 'cutout' | 'translucent' | 'none';

export type GeometryType =
  | 'cube'
  | 'cross'
  | 'slab'
  | 'slab_top'
  | 'half_block'
  | 'pillar_vertical'
  | 'pillar_horizontal'
  | 'handrail'
  | 'handrail_a'
  | 'handrail_b'
  | 'chimney'
  | 'lamp'
  | 'vine'
  | 'lilypad'
  | 'cactus';

export type FaceIndex = 0 | 1 | 2 | 3 | 4 | 5;

export type BlockTextures = Readonly<{
  all?: string;
  top?: string;
  bottom?: string;
  side?: string;
  front?: string;
}>;

export type BlockDefinition = Readonly<{
  id: number;
  key: string;
  solid: boolean;
  renderClass: RenderClass;
  geometryType: GeometryType;
  orientation: boolean;
  textures: BlockTextures;
  emissive: number;
  indestructible: boolean;
}>;

type BlockSeed = Readonly<{
  key: string;
  solid?: boolean;
  renderClass?: RenderClass;
  geometryType?: GeometryType;
  orientation?: boolean;
  textures?: BlockTextures;
  emissive?: number;
  indestructible?: boolean;
  aliasOf?: string;
}>;

const ORIENTED_FACES: Readonly<Record<number, FaceIndex>> = {
  0: 0,
  1: 4,
  2: 1,
  3: 5,
};

const blockSeeds: readonly BlockSeed[] = [
  { key: 'air', solid: false, renderClass: 'none', textures: {} },
  { key: 'stone', textures: { top: 'stone_andesite.png', bottom: 'stone_andesite.png', side: 'stone.png' } },
  { key: 'grass', textures: { top: 'grass_carried.png', bottom: 'color:#559944', side: 'grass_side_carried.png' } },
  { key: 'water', solid: false, renderClass: 'translucent', textures: { all: 'color:#205099' } },
  { key: 'sand', textures: { top: 'sand.png', bottom: 'sand.png', side: 'sand_side.png' } },
  { key: 'wood', orientation: true, textures: { top: 'log_big_oak_top.png', bottom: 'log_big_oak_top.png', side: 'log_big_oak.png' } },
  { key: 'leaves', renderClass: 'cutout', orientation: true, textures: { all: 'leaves.png' } },
  { key: 'glass', renderClass: 'translucent', orientation: true, textures: { all: 'Glass.png' } },
  { key: 'glass_block', renderClass: 'translucent', orientation: true, textures: { all: 'Glass.png' }, aliasOf: 'glass' },
  { key: 'collider', renderClass: 'none', textures: {} },
  { key: 'swamp_water', solid: false, renderClass: 'translucent', textures: { all: 'color:#2F4F4F' } },
  { key: 'cloud', solid: false, renderClass: 'cutout', textures: { all: 'color:#FFFFFF' } },
  { key: 'glass_blink', renderClass: 'translucent', orientation: true, textures: { all: 'glass_blink.png' } },
  { key: 'birch_log', textures: { top: 'Birch_Log_top.png', bottom: 'Birch_Log_top.png', side: 'Birch_Log_side.png' } },
  { key: 'dark_oak', textures: { all: 'Stripped_Dark_Oak_Log_(texture)_JE1.png' } },
  { key: 'sky_wood', textures: { all: 'color:#DDA0DD' } },
  { key: 'azalea_log', textures: { all: 'color:#635338' } },
  { key: 'azalea_leaves', renderClass: 'cutout', orientation: true, textures: { all: 'azalea_leaves.png' } },
  { key: 'azalea_flowers', renderClass: 'cutout', orientation: true, textures: { all: 'flowering_azalea_leaves.png' } },
  { key: 'yellow_leaves', renderClass: 'cutout', orientation: true, textures: { all: 'leaves_yellow.png' } },
  { key: 'sky_leaves', renderClass: 'cutout', orientation: true, textures: { all: 'color:#FF69B4' } },
  { key: 'realistic_oak_leaves', renderClass: 'cutout', orientation: true, textures: { all: 'oak_leaves_branch_medium.png' } },
  { key: 'realistic_yellow_leaves', renderClass: 'cutout', orientation: true, textures: { all: 'leaves_yellow.png' } },
  { key: 'flower', solid: false, renderClass: 'cutout', orientation: true, geometryType: 'cross', textures: { all: 'draw:flower' } },
  { key: 'short_grass', solid: false, renderClass: 'cutout', orientation: true, geometryType: 'cross', textures: { all: 'double_plant_grass_carried.png' } },
  { key: 'allium', solid: false, renderClass: 'cutout', orientation: true, geometryType: 'cross', textures: { all: 'flower_Allium.png' } },
  { key: 'azure_bluet', solid: false, renderClass: 'cutout', orientation: true, geometryType: 'cross', textures: { all: 'Azure_Bluet.png' } },
  { key: 'dead_bush', solid: false, renderClass: 'cutout', orientation: true, geometryType: 'cross', textures: { all: 'Dead_Bush.png' } },
  { key: 'oxeye_daisy', solid: false, renderClass: 'cutout', orientation: true, geometryType: 'cross', textures: { all: 'Oxeye_Daisy.png' } },
  { key: 'red_mushroom', solid: false, renderClass: 'cutout', orientation: true, geometryType: 'cross', textures: { all: 'Red_Mushroom.png' } },
  { key: 'vine', solid: false, renderClass: 'cutout', orientation: true, geometryType: 'vine', textures: { all: 'draw:vine' } },
  { key: 'lilypad', solid: false, renderClass: 'cutout', orientation: true, geometryType: 'lilypad', textures: { all: 'draw:lilypad' } },
  { key: 'cactus', renderClass: 'cutout', orientation: true, geometryType: 'cactus', textures: { all: 'color:#2E8B57' } },
  { key: 'handrail', renderClass: 'cutout', orientation: true, geometryType: 'handrail', textures: { all: 'handrail.png' } },
  { key: 'handrailA', renderClass: 'cutout', orientation: true, geometryType: 'handrail_a', textures: { all: 'handrailA.png' } },
  { key: 'handrailB', renderClass: 'cutout', orientation: true, geometryType: 'handrail_b', textures: { all: 'handrailB.png' } },
  { key: 'vertical_pillar', renderClass: 'cutout', orientation: true, geometryType: 'pillar_vertical', textures: { all: 'pillar.png' } },
  { key: 'horizontal_pillar', renderClass: 'cutout', orientation: true, geometryType: 'pillar_horizontal', textures: { all: 'pillar_horizontal.png' } },
  { key: 'chimney', geometryType: 'chimney', textures: { all: 'stone.png' } },
  { key: 'swamp_leaves', renderClass: 'cutout', orientation: true, textures: { all: 'color:#3E5A3A' } },
  { key: 'snow_leaves', renderClass: 'cutout', orientation: true, textures: { all: 'leaves_with_snow.png' } },
  { key: 'calcite', textures: { all: 'color:#E8E8E8' } },
  { key: 'end_stone', textures: { all: 'End_Stone.png' } },
  { key: 'iron', textures: { all: 'iron.png' } },
  { key: 'diamond', textures: { all: 'diamond.png' } },
  { key: 'obsidian', textures: { all: 'Obsidian.png' } },
  { key: 'moss', textures: { top: 'moss_block.png', bottom: 'moss_block.png', side: 'dirt_podzol_side.png' } },
  { key: 'chest', renderClass: 'cutout', orientation: true, textures: { top: 'box_top.png', bottom: 'box_side.png', front: 'box_face.png', side: 'box_side.png' } },
  { key: 'realistic_trunk_collider', renderClass: 'none', textures: {} },
  { key: 'playground_block', indestructible: true, textures: { all: 'Pink_Wool.png' } },
  { key: 'playground_center_block', indestructible: true, textures: { all: 'Light_Gray_Cloth.png' } },
  { key: 'stone_diorite', textures: { all: 'stone_diorite.png' } },
  { key: 'mossy_stone', textures: { all: 'Mossy_Cobblestone.png' } },
  { key: 'cobblestone', textures: { all: 'Cobblestone.png' } },
  { key: 'bricks', textures: { all: 'Bricks.png' } },
  { key: 'planks', textures: { all: 'planks_birch.png' } },
  { key: 'planks_step', renderClass: 'cutout', orientation: true, geometryType: 'slab', textures: { all: 'planks_birch.png' } },
  { key: 'cobblestone_step', renderClass: 'cutout', orientation: true, geometryType: 'slab', textures: { all: 'Cobblestone.png' } },
  { key: 'cobblestone_step_updown', renderClass: 'cutout', orientation: true, geometryType: 'slab_top', textures: { all: 'Cobblestone.png' } },
  { key: 'stone_diorite_step', renderClass: 'cutout', orientation: true, geometryType: 'slab', textures: { all: 'stone_diorite.png' } },
  { key: 'white_planks', textures: { all: 'White_Wood_Planks.png' } },
  { key: 'oak_planks', textures: { all: 'Oak_Planks.png' } },
  { key: 'gold_ore', textures: { all: 'Deepslate_Gold.png' } },
  { key: 'marble', textures: { all: 'color:#F2F0E6' } },
  { key: 'dirt', textures: { top: 'dirt_podzol_top.png', bottom: 'dirt_podzol_top.png', side: 'dirt.png' } },
  { key: 'snow', textures: { top: 'Snow_top.png', bottom: 'dirt.png', side: 'Snow.png' } },
  { key: 'snow_grass', textures: { top: 'Snow_top.png', bottom: 'dirt.png', side: 'Snowy_Grass_Block_side.png' } },
  { key: 'ice', renderClass: 'translucent', textures: { all: 'ice.png' } },
  { key: 'dark_planks', textures: { all: 'dark_planks.png' } },
  { key: 'blue_planks', textures: { all: 'Blue_Wood_Planks.png' } },
  { key: 'green_planks', textures: { all: 'Green_Wood_Planks.png' } },
  { key: 'hay_bale', textures: { top: 'Hay_Bale_top.png', bottom: 'Hay_Bale_top.png', side: 'Hay_Bale.png' } },
  { key: 'swamp_grass', textures: { top: 'color:#4C5E34', bottom: 'color:#4C5E34', side: 'Mossy_Cobblestone_side.png' } },
  {
    key: 'bookbox',
    orientation: true,
    textures: {
      top: 'Bone_Block_top_texture_JE2_BE2.png',
      bottom: 'Bone_Block_top_texture_JE2_BE2.png',
      front: 'Bookshelf_texture_JE2_BE2.png',
      side: 'Bone_Block_side_texture_JE2_BE2.png',
    },
  },
  { key: 'gold_block', textures: { all: 'gold_block.png' } },
  { key: 'emerald', textures: { all: 'emerald.png' } },
  { key: 'amethyst', textures: { all: 'amethyst.png' } },
  { key: 'iron_ore', textures: { all: 'Iron_Ore.png' } },
  { key: 'debris', textures: { top: 'Ancient_Debris_top.png', bottom: 'Ancient_Debris_top.png', side: 'Ancient_Debris_side.png' } },
  { key: 'tnt', textures: { top: 'tnt_top.png', bottom: 'tnt_top.png', side: 'tnt_side.png' } },
  { key: 'turret_alias_block', textures: { all: 'turret.png' } },
  { key: 'zombie_nest_alias_block', textures: { all: 'zombie_nest_alias_block.png' } },
  { key: 'deepslate', textures: { all: 'Deepslate.png' } },
  { key: 'deepslate_diamond_ore', textures: { all: 'Deepslate_Diamond_Ore.png' } },
  { key: 'polished_deepslate', textures: { all: 'Polished_Deepslate.png' } },
  { key: 'glowstone', emissive: 1, textures: { all: 'Glowstone.png' } },
  { key: 'ochre_froglight', emissive: 1, textures: { all: 'Ochre_Froglight.png' } },
  { key: 'oxidized_cut_copper', textures: { all: 'Oxidized_Cut_Copper.png' } },
  { key: 'weathered_cut_copper', textures: { all: 'Weathered_Cut_Copper.png' } },
  { key: 'lava', emissive: 1, textures: { all: 'Lava.png' } },
  { key: 'block_of_quartz', textures: { all: 'Block_of_Quartz.png' } },
  { key: 'quartz_bricks', textures: { all: 'Quartz_Bricks.png' } },
  { key: 'brain_coral_block', textures: { all: 'Brain_Coral_Block.png' } },
  { key: 'block_of_amber', emissive: 0.8, textures: { all: 'Block_of_Amber.png' } },
  { key: 'floatato', textures: { all: 'Floatato.png' } },
  { key: 'clay', textures: { all: 'Clay.png' } },
  { key: 'end_stone_bricks', textures: { all: 'End_Stone_Bricks.png' } },
  { key: 'smooth_stone', textures: { all: 'Smooth_Stone.png' } },
  { key: 'smooth_stone_1', textures: { all: 'Smooth_Stone_1.png' } },
  { key: 'stone_bricks', textures: { all: 'Stone_Bricks.png' } },
  { key: 'tuff_bricks', textures: { all: 'Tuff_Bricks.png' } },
  { key: 'snow_block', textures: { all: 'Snow.png' } },
  { key: 'light_gray_cloth', textures: { all: 'Light_Gray_Cloth.png' } },
  { key: 'pink_wool', textures: { all: 'Pink_Wool.png' } },
  { key: 'nether_bricks', textures: { all: 'Nether_Bricks.png' } },
  { key: 'nether_bricks_1', textures: { all: 'Nether_Bricks_1.png' } },
  { key: 'nether_gold_ore', textures: { all: 'Nether_Gold_Ore.png' } },
  { key: 'netherrack', textures: { all: 'Netherrack.png' } },
  { key: 'polished_blackstone_bricks', textures: { all: 'Polished_Blackstone_Bricks.png' } },
  { key: 'oak_planks_1', textures: { all: 'Oak_Planks_1.png' } },
  { key: 'acacia_planks', textures: { all: 'Acacia_Planks.png' } },
  { key: 'bedrock', indestructible: true, textures: { all: 'Bedrock.png' } },
  { key: 'polished_diorite', textures: { all: 'Polished_Diorite.png' } },
  { key: 'polished_granite', textures: { all: 'Polished_Granite.png' } },
  { key: 'piston', textures: { all: 'Piston.png' } },
  { key: 'piston_head', textures: { all: 'Piston_Head.png' } },
  { key: 'mud_bricks', textures: { all: 'Mud_Bricks.png' } },
  { key: 'orange_shulker_box', textures: { all: 'Orange_Shulker_Box.png' } },
  {
    key: 'bed_head',
    geometryType: 'half_block',
    textures: {
      top: 'bed/Bed_(top_texture)_JE1_BE1.png',
      bottom: 'bed/Bed_(bottom_texture)_JE1_BE1.png',
      side: 'bed/Bed_(top_side_texture)_JE2_BE2.png',
    },
  },
  {
    key: 'bed_tail',
    geometryType: 'half_block',
    textures: {
      top: 'bed/Bed_(top_texture)_JE1_BE1.png',
      bottom: 'bed/Bed_(bottom_texture)_JE1_BE1.png',
      side: 'bed/Bed_(top_side_texture)_JE2_BE2.png',
    },
  },
  { key: 'bed_alias_block', solid: false, renderClass: 'none', textures: {} },
  { key: 'sand_train_track', orientation: true, textures: { top: 'sand_train_track.png', bottom: 'sand.png', side: 'sand.png' } },
  { key: 'sand_train_track_corner', orientation: true, textures: { top: 'sand_train_track_conner.png', bottom: 'sand.png', side: 'sand.png' } },
  { key: 'mine_cart', solid: false, renderClass: 'none', textures: {} },
  { key: 'hanging_lamp', solid: false, renderClass: 'cutout', geometryType: 'lamp', emissive: 1, textures: { all: 'color:#FFD75E' } },
];

function resolveSeeds(): Readonly<{
  byId: ReadonlyMap<number, BlockDefinition>;
  idByKey: ReadonlyMap<string, number>;
}> {
  const byId = new Map<number, BlockDefinition>();
  const idByKey = new Map<string, number>();
  for (const seed of blockSeeds) {
    const targetId = seed.aliasOf === undefined ? undefined : idByKey.get(seed.aliasOf);
    if (seed.aliasOf !== undefined && targetId === undefined) {
      throw new Error(`Alias ${seed.key} must follow ${seed.aliasOf}`);
    }
    const id = targetId ?? byId.size;
    const definition: BlockDefinition = Object.freeze({
      id,
      key: seed.key,
      solid: seed.solid ?? true,
      renderClass: seed.renderClass ?? 'opaque',
      geometryType: seed.geometryType ?? 'cube',
      orientation: seed.orientation ?? false,
      textures: Object.freeze({ ...seed.textures }),
      emissive: seed.emissive ?? 0,
      indestructible: seed.indestructible ?? false,
    });
    if (targetId === undefined) byId.set(id, definition);
    idByKey.set(seed.key, id);
  }
  return { byId, idByKey };
}

const registryData = resolveSeeds();

export function blockById(id: number): BlockDefinition {
  const definition = registryData.byId.get(id);
  if (!definition) throw new Error(`Unknown block id: ${id}`);
  return definition;
}

export function blockByKey(key: string): BlockDefinition {
  const id = registryData.idByKey.get(key);
  if (id === undefined) throw new Error(`Unknown block key: ${key}`);
  return blockById(id);
}

export type BlockRegistry = Readonly<{
  byId(id: number): BlockDefinition;
  byKey(key: string): BlockDefinition;
  tileForFace(blockId: number, face: FaceIndex, orientation: number): number;
  isFullOccluder(blockId: number): boolean;
}>;

export const blockRegistry: BlockRegistry = Object.freeze({
  byId: blockById,
  byKey: blockByKey,
  tileForFace(blockId: number, face: FaceIndex, orientation: number): number {
    const block = blockById(blockId);
    const frontFace = ORIENTED_FACES[((orientation % 4) + 4) % 4];
    let name: string | undefined;
    if (block.textures.front !== undefined && face === frontFace) {
      name = block.textures.front;
    } else if (face === 2) {
      name = block.textures.top ?? block.textures.all;
    } else if (face === 3) {
      name = block.textures.bottom ?? block.textures.all;
    } else {
      name = block.textures.side ?? block.textures.all;
    }
    if (!name) return textureTileId('stone.png');
    if (name.startsWith('color:') || name.startsWith('draw:')) return syntheticTileId(name);
    return textureTileId(name);
  },
  isFullOccluder(blockId: number): boolean {
    const block = blockById(blockId);
    return block.renderClass === 'opaque' && block.geometryType === 'cube';
  },
});
