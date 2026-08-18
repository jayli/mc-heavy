# 阶段 2：世界体验完善实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在阶段 1 可玩核心之上迁移 mc-lite 的全部方块内容、真实贴图、异形模型、宝箱、TNT、粒子、下雨、光照画质档位、旧存档导入 UI，并补齐重力与跳跃。

**Architecture:** 内容全部数据驱动：方块注册表声明几何/贴图/发光/不可破坏属性，Worker 输出 opaque/cutout/translucent 三通道网格，渲染层用共享光照材质与图集把 `tileId + 单位 UV` 映射到图集。所有玩法（爆炸、宝箱、粒子、雨）只通过 WorldQuery 影响世界。玩家物理保持 `step()` 纯水平语义，新增独立垂直物理。

**Tech Stack:** TypeScript strict、Vite 8、Three.js r184（WebGPU 首选 / WebGL2 回退）、Vitest、Playwright。

## Global Constraints

- 所有实现遵循 [2026-08-18-stage-2-world-experience-design.md](../specs/2026-08-18-stage-2-world-experience-design.md)（本计划的 spec）。
- `domain`、`world`、`streaming`、`meshing` 不得导入 Three.js 或 DOM API；贴图/图集只存在于 `render` 与 `app`。
- 现有方块 id 0..7 不变（air/stone/grass/water/sand/wood/leaves/glass），新方块从 8 递增。
- `PlayerController.step(input, dt)` 保持纯水平运动，300 秒基准与 e2e 依赖其语义。
- WebGPU 验收：300 秒基准默认高画质档，1% low FPS >= 90，p99 帧时长 <= 11.1 ms；不得降低默认视距或默认画质来达标。
- 每个任务：先写失败测试并确认失败（RED），再写最小实现（GREEN），随后 `npm run test:unit` 相关文件与 `npm run lint`，最后提交。提交信息用 Conventional Commits（`feat:` / `test:` / `refactor:`）。
- 工作区为当前 `main` 分支（用户明确要求，不使用 worktree）。

---

## 文件结构

```text
public/assets/textures/*.png       # 从 mc-lite 复制的 122 张贴图
public/assets/effects/*.png        # pick/block_crash/big_blow 粒子序列帧
src/domain/
  blocks.ts                        # 完整方块注册表 + 贴图槽位 + 朝向映射
  texture-tiles.ts                 # 贴图文件名 -> tileId 的确定性表（纯数据）
  voxel-section.ts                 # 增加每格 orientation 状态位
src/meshing/
  mesh-types.ts                    # ChannelMesh / SectionMesh
  ao.ts                            # 四角 AO 纯函数
  greedy-mesher.ts                 # 三通道贪心 + 异形几何构建
src/workers/
  protocol.ts                      # SectionMesh 协议 + ChannelUploadJob
  voxel-section-codec.ts           # orientation 序列化
  work-handlers.ts                 # 三通道网格输出与转移列表
src/world/world-service.ts         # SectionMesh 生命周期、orientation 编辑
src/render/
  texture-atlas.ts                 # PNG -> 图集 DataTexture + 发光表
  materials.ts                     # 共享光照材质（太阳/环境/AO/发光）
  render-page.ts                   # Group + 三通道 staged upload
  renderer-adapter.ts              # 特效容器、pixelRatio、三通道页面
  particles.ts                     # 序列帧 Sprite 池
  rain.ts                          # GPU 雨效
  light-quality.ts                 # 画质档位 preset
src/gameplay/
  player-controller.ts             # 重力/跳跃/setPosition
  spawn.ts                         # 出生列表面高度
  player-interaction.ts            # 距离 6、宝箱/TNT 事件回调
  tnt.ts                           # 点燃/连锁/破坏纯逻辑 + 调度
  chest-animations.ts              # 开盖动画管理
src/app/
  settings-ui.ts                   # 画质/下雨/TNT 设置面板
  import-ui.ts                     # 新世界/导入入口
  main.ts                          # 组合根接线
tests/unit/...                     # 每个模块对应单测
tests/integration/app/stage-2.e2e.ts  # 浏览器功能回归
```

---

## Task 1: 迁移贴图资源与完整方块注册表

**Files:**
- Create: `public/assets/textures/`（122 张 PNG）、`public/assets/effects/`（3 张 PNG）
- Create: `src/domain/texture-tiles.ts`
- Modify: `src/domain/blocks.ts`
- Test: `tests/unit/domain/blocks.test.ts`、`tests/unit/domain/texture-tiles.test.ts`

**Interfaces:**
- Consumes: 现有 `BlockDefinition`/`blockRegistry`（`main.ts`、`meshing`、`legacy-import`、`snapshot-store` 使用）。
- Produces:
  - `textureTileId(name: string): number`；`textureTileName(tileId: number): string`；`TILE_COUNT`。
  - `BlockDefinition` 新字段：`geometryType`、`textures`、`emissive`、`indestructible`。
  - `blockRegistry.tileForFace(blockId: number, face: FaceIndex, orientation: number): number`。
  - `blockRegistry.isFullOccluder(blockId: number): boolean`。

- [ ] **Step 1: 复制资源**

```bash
mkdir -p public/assets/textures public/assets/effects
cp ~/jaylli/mc-lite/src/assets/textures/*.png public/assets/textures/
cp ~/jaylli/mc-lite/src/assets/gif/pick.png ~/jaylli/mc-lite/src/assets/gif/block_crash.png ~/jaylli/mc-lite/src/assets/gif/big_blow.png public/assets/effects/
find public/assets -type f | wc -l   # 期望 125
```

- [ ] **Step 2: 写贴图槽位表的失败测试**

`tests/unit/domain/texture-tiles.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { TILE_COUNT, textureTileId, textureTileName } from '../../../src/domain/texture-tiles';

describe('texture tiles', () => {
  it('assigns a stable id to every known texture and round-trips names', () => {
    expect(TILE_COUNT).toBeGreaterThanOrEqual(122);
    const id = textureTileId('stone.png');
    expect(textureTileId('stone.png')).toBe(id);
    expect(textureTileName(id)).toBe('stone.png');
  });

  it('rejects unknown texture names', () => {
    expect(() => textureTileId('missing.png')).toThrow('Unknown texture: missing.png');
  });
});
```

运行 `npx vitest run tests/unit/domain/texture-tiles.test.ts`，确认失败（模块不存在）。

- [ ] **Step 3: 实现 `src/domain/texture-tiles.ts`**

```ts
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

export type SyntheticTile = Readonly<{ key: string; color?: string; draw?: 'flower' | 'vine' | 'lilypad' }>;

export const SYNTHETIC_TILES = Object.freeze([
  { key: 'color:#205099', color: '#205099' },
  { key: 'color:#2F4F4F', color: '#2F4F4F' },
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
```

运行 Step 2 测试确认通过。

- [ ] **Step 4: 更新方块注册表测试**

在 `tests/unit/domain/blocks.test.ts` 增加：

```ts
import { blockByKey, blockRegistry } from '../../../src/domain/blocks';
import { textureTileId } from '../../../src/domain/texture-tiles';

describe('block registry content', () => {
  it('keeps ids 0..7 stable and resolves the legacy glass_block alias', () => {
    expect(blockByKey('air').id).toBe(0);
    expect(blockByKey('glass').id).toBe(7);
    expect(blockByKey('glass_block').id).toBe(7);
  });

  it('marks chest as an oriented cutout cube and tnt as opaque', () => {
    expect(blockByKey('chest')).toMatchObject({
      solid: true,
      renderClass: 'cutout',
      geometryType: 'cube',
      orientation: true,
    });
    expect(blockByKey('tnt')).toMatchObject({ solid: true, renderClass: 'opaque', geometryType: 'cube' });
  });

  it('treats only opaque cubes as full occluders', () => {
    expect(blockRegistry.isFullOccluder(blockByKey('stone').id)).toBe(true);
    expect(blockRegistry.isFullOccluder(blockByKey('leaves').id)).toBe(false);
    expect(blockRegistry.isFullOccluder(blockByKey('bed_head').id)).toBe(false);
  });

  it('selects the front face tile from chest orientation', () => {
    const chest = blockByKey('chest').id;
    const front = blockRegistry.tileForFace(chest, 0, 0);
    expect(front).toBe(textureTileId('box_face.png'));
    // orientation 0 对应 +X 面；front 纹理必须随朝向轮转。
    expect(blockRegistry.tileForFace(chest, 0, 0)).toBe(front);
    expect(blockRegistry.tileForFace(chest, 2, 0)).not.toBe(front);
  });
});
```

- [ ] **Step 5: 重写 `src/domain/blocks.ts`**

```ts
import { textureTileId } from './texture-tiles';

export type RenderClass = 'opaque' | 'cutout' | 'translucent' | 'none';
export type GeometryType =
  | 'cube' | 'cross' | 'slab' | 'slab_top' | 'half_block'
  | 'pillar_vertical' | 'pillar_horizontal' | 'handrail'
  | 'handrail_a' | 'handrail_b' | 'chimney' | 'lamp'
  | 'vine' | 'lilypad' | 'cactus';
export type FaceIndex = 0 | 1 | 2 | 3 | 4 | 5; // +X -X +Y -Y +Z -Z

export type BlockTextures = Readonly<{
  all?: string;
  top?: string;
  bottom?: string;
  side?: string;
  front?: string; // front 贴到朝向对应的水平面，其余水平面用 side
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
  0: 0, 1: 4, 2: 1, 3: 5,
};

const blockSeeds: readonly BlockSeed[] = [
  { key: 'air', solid: false, renderClass: 'none', textures: {} },
  { key: 'stone', textures: { top: 'stone_andesite.png', bottom: 'stone_andesite.png', side: 'stone.png' } },
  { key: 'grass', textures: { top: 'grass_carried.png', bottom: '#559944', side: 'grass_side_carried.png' } },
  { key: 'water', solid: false, renderClass: 'translucent', textures: { all: '#205099' } },
  { key: 'sand', textures: { top: 'sand.png', bottom: 'sand.png', side: 'sand_side.png' } },
  { key: 'wood', orientation: true, textures: { top: 'log_big_oak_top.png', bottom: 'log_big_oak_top.png', side: 'log_big_oak.png' } },
  { key: 'leaves', renderClass: 'cutout', orientation: true, textures: { all: 'leaves.png' } },
  { key: 'glass', renderClass: 'translucent', orientation: true, textures: { all: 'Glass.png' } },
  { key: 'glass_block', renderClass: 'translucent', orientation: true, textures: { all: 'Glass.png' }, aliasOf: 'glass' },
  { key: 'collider', renderClass: 'none', textures: {} },
  { key: 'swamp_water', solid: false, renderClass: 'translucent', textures: { all: '#2F4F4F' } },
  { key: 'cloud', solid: false, renderClass: 'cutout', textures: { all: '#FFFFFF' } },
  { key: 'glass_blink', renderClass: 'translucent', orientation: true, textures: { all: 'glass_blink.png' } },
  { key: 'birch_log', textures: { top: 'Birch_Log_top.png', bottom: 'Birch_Log_top.png', side: 'Birch_Log_side.png' } },
  { key: 'dark_oak', textures: { all: 'Stripped_Dark_Oak_Log_(texture)_JE1.png' } },
  { key: 'sky_wood', textures: { all: '#DDA0DD' } },
  { key: 'azalea_log', textures: { all: '#635338' } },
  { key: 'azalea_leaves', renderClass: 'cutout', orientation: true, textures: { all: 'azalea_leaves.png' } },
  { key: 'azalea_flowers', renderClass: 'cutout', orientation: true, textures: { all: 'flowering_azalea_leaves.png' } },
  { key: 'yellow_leaves', renderClass: 'cutout', orientation: true, textures: { all: 'leaves_yellow.png' } },
  { key: 'sky_leaves', renderClass: 'cutout', orientation: true, textures: { all: '#FF69B4' } },
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
  { key: 'cactus', renderClass: 'cutout', orientation: true, geometryType: 'cactus', textures: { all: '#2E8B57' } },
  { key: 'handrail', renderClass: 'cutout', orientation: true, geometryType: 'handrail', textures: { all: 'handrail.png' } },
  { key: 'handrailA', renderClass: 'cutout', orientation: true, geometryType: 'handrail_a', textures: { all: 'handrailA.png' } },
  { key: 'handrailB', renderClass: 'cutout', orientation: true, geometryType: 'handrail_b', textures: { all: 'handrailB.png' } },
  { key: 'vertical_pillar', renderClass: 'cutout', orientation: true, geometryType: 'pillar_vertical', textures: { all: 'pillar.png' } },
  { key: 'horizontal_pillar', renderClass: 'cutout', orientation: true, geometryType: 'pillar_horizontal', textures: { all: 'pillar_horizontal.png' } },
  { key: 'chimney', geometryType: 'chimney', textures: { all: 'stone.png' } },
  { key: 'swamp_leaves', renderClass: 'cutout', orientation: true, textures: { all: '#3E5A3A' } },
  { key: 'snow_leaves', renderClass: 'cutout', orientation: true, textures: { all: 'leaves_with_snow.png' } },
  { key: 'calcite', textures: { all: '#E8E8E8' } },
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
  { key: 'marble', textures: { all: '#F2F0E6' } },
  { key: 'dirt', textures: { top: 'dirt_podzol_top.png', bottom: 'dirt_podzol_top.png', side: 'dirt.png' } },
  { key: 'snow', textures: { top: 'Snow_top.png', bottom: 'dirt.png', side: 'Snow.png' } },
  { key: 'snow_grass', textures: { top: 'Snow_top.png', bottom: 'dirt.png', side: 'Snowy_Grass_Block_side.png' } },
  { key: 'ice', renderClass: 'translucent', textures: { all: 'ice.png' } },
  { key: 'dark_planks', textures: { all: 'dark_planks.png' } },
  { key: 'blue_planks', textures: { all: 'Blue_Wood_Planks.png' } },
  { key: 'green_planks', textures: { all: 'Green_Wood_Planks.png' } },
  { key: 'hay_bale', textures: { top: 'Hay_Bale_top.png', bottom: 'Hay_Bale_top.png', side: 'Hay_Bale.png' } },
  { key: 'swamp_grass', textures: { top: '#4C5E34', bottom: '#4C5E34', side: 'Mossy_Cobblestone_side.png' } },
  { key: 'bookbox', orientation: true, textures: { top: 'Bone_Block_top_texture_JE2_BE2.png', bottom: 'Bone_Block_top_texture_JE2_BE2.png', front: 'Bookshelf_texture_JE2_BE2.png', side: 'Bone_Block_side_texture_JE2_BE2.png' } },
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
  { key: 'hanging_lamp', solid: false, renderClass: 'cutout', geometryType: 'lamp', emissive: 1, textures: { all: '#FFD75E' } },
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

export const blockRegistry = Object.freeze({
  byId: blockById,
  byKey: blockByKey,
  tileForFace(blockId: number, face: FaceIndex, orientation: number): number {
    const block = blockById(blockId);
    const frontFace = ORIENTED_FACES[((orientation % 4) + 4) % 4];
    let name: string | undefined;
    if (block.textures.front && face === frontFace) name = block.textures.front;
    else if (face === 2) name = block.textures.top ?? block.textures.all;
    else if (face === 3) name = block.textures.bottom ?? block.textures.all;
    else name = block.textures.side ?? block.textures.all;
    if (!name) return textureTileId('stone.png');
    if (name.startsWith('color:')) return syntheticTileId(`color:${name.slice(6)}`);
    if (name.startsWith('draw:')) return syntheticTileId(name);
    return textureTileId(name);
  },
  isFullOccluder(blockId: number): boolean {
    const block = blockById(blockId);
    return block.renderClass === 'opaque' && block.geometryType === 'cube';
  },
});
```

`resolveSeeds` 的实现：id 从 0 开始对每个 seed 递增；带 `aliasOf` 的条目复用目标 key 的 id 并注册到 `byKey`，不占新 id。`#RRGGBB` 走 `syntheticTileId('color:#RRGGBB')`，`draw:*` 走 `syntheticTileId('draw:*')`；`tileForFace` 里 `front` 只贴到 `ORIENTED_FACES[orientation]` 那一面，其余水平面用 `side`，无 `side` 时用 `all`。所有 key 与 mc-lite `BLOCK_DATA.js` 一一对应。

- [ ] **Step 6: 全量回归与提交**

```bash
npm run test:unit
npm run lint
git add public src/domain tests/unit/domain
git commit -m "feat(blocks): port mc-lite block registry, textures and tile slots"
```

注意：本任务只扩展注册表，`legacy-import` 的 `blockByKey('wood')` 等映射仍成立；`main.ts` 的 `blockById(...).key` 热栏文案随之变全，但 e2e 断言的是具体 key，不受影响。

---

## Task 2: VoxelSection 状态位（orientation）贯通

**Files:**
- Modify: `src/domain/voxel-section.ts`、`src/workers/voxel-section-codec.ts`、`src/workers/protocol.ts`、`src/world/world-service.ts`
- Test: `tests/unit/domain/voxel-section.test.ts`、`tests/integration/workers/world-service.test.ts`

**Interfaces:**
- Produces:
  - `VoxelSection.filled(pos, blockId): VoxelSection`（orientation 全 0）
  - `VoxelSection.set(index, blockId, orientation = 0): VoxelSection`
  - `VoxelSection.getOrientation(index): number`（0..3）
  - `SerializedVoxelSection.orientations: ArrayBuffer`
  - `WorldService.applyEdits` 把 `orientation` 写入 `editsBySection` 并在 `sectionWithEdits` 时应用。

- [ ] **Step 1: 失败测试**

`tests/unit/domain/voxel-section.test.ts` 增加：

```ts
it('stores a per-cell orientation and keeps it across the wire codec', () => {
  let section = VoxelSection.filled({ x: 0, y: 0, z: 0 }, 5);
  section = section.set(12, 5, 2);
  expect(section.getOrientation(12)).toBe(2);
  expect(section.getOrientation(13)).toBe(0);

  const wire = serializeVoxelSection(section);
  const restored = deserializeVoxelSection(wire);
  expect(restored.getOrientation(12)).toBe(2);
  expect(wire.orientations).toBeInstanceOf(ArrayBuffer);
});

it('resets orientation when a cell changes to another block', () => {
  let section = VoxelSection.filled({ x: 0, y: 0, z: 0 }, 5).set(3, 5, 3);
  section = section.set(3, 1);
  expect(section.getOrientation(3)).toBe(0);
});
```

- [ ] **Step 2: 实现**

- `VoxelSection` 增加 `private readonly orientations: Uint8Array`；`filled` 与 `fromPaletteIndices(pos, palette, indices, editVersion, orientations?)` 校验 `orientations.length === CELL_COUNT` 且每个值 <= 3；`set` 生成 `nextOrientations`（换方块时置 0）；`toPaletteIndices` 同时导出 `orientations.slice()`。
- `serializeVoxelSection` 返回 `orientations: section.orientations.buffer` 的拷贝；`deserializeVoxelSection` 回读。
- `world-service.ts`：`editsBySection` 改为 `Map<string, Map<number, { blockId: number; orientation: number }>>`；`applyEdits` 写入两字段；`sectionWithEdits` 在改 palette 的同时更新 `orientations`（构造时按 edit 设置，未编辑格保持生成值 0）；`getBlock` 分支读取 `edits.get(index)?.blockId`。
- `generation.worker` 路径不产生 orientation（生成方块朝向恒 0），codec 默认补 0。

- [ ] **Step 3: 回归与提交**

```bash
npm run test:unit
npm run lint
git add src/domain/voxel-section.ts src/workers/voxel-section-codec.ts src/world/world-service.ts tests
git commit -m "feat(world): carry per-cell orientation through worker wire format"
```

---

## Task 3: AO 纯函数与三通道网格类型

**Files:**
- Create: `src/meshing/ao.ts`
- Modify: `src/meshing/mesh-types.ts`
- Test: `tests/unit/meshing/ao.test.ts`

**Interfaces:**
- Produces:
  - `computeCornerAo(side1: boolean, side2: boolean, corner: boolean): number`，返回 0..3。
  - `MeshChannel = 'opaque' | 'cutout' | 'translucent'`；`MESH_CHANNELS`。
  - `ChannelMesh = { positions: Float32Array; normals: Int8Array; uvs: Float32Array; tileIds: Uint16Array; ao: Uint8Array; indices: Uint32Array }`。
  - `SectionMesh = { opaque: ChannelMesh; cutout: ChannelMesh; translucent: ChannelMesh; sourceVersion: number }`。
  - `emptyChannelMesh()`、`emptySectionMesh(sourceVersion)`。

- [ ] **Step 1: AO 失败测试**

```ts
import { describe, expect, it } from 'vitest';
import { computeCornerAo } from '../../../src/meshing/ao';

describe('computeCornerAo', () => {
  it('returns 0 in an enclosed corner and 3 in an open corner', () => {
    expect(computeCornerAo(true, true, true)).toBe(0);
    expect(computeCornerAo(false, false, false)).toBe(3);
  });

  it('deducts one for each occluding side or corner', () => {
    expect(computeCornerAo(true, false, false)).toBe(2);
    expect(computeCornerAo(true, false, true)).toBe(1);
  });
});
```

- [ ] **Step 2: 实现 `ao.ts`**

```ts
export const computeCornerAo = (side1: boolean, side2: boolean, corner: boolean): number => {
  if (side1 && side2) return 0;
  return 3 - Number(side1) - Number(side2) - Number(corner);
};
```

- [ ] **Step 3: 扩展 mesh-types**

把 `OpaqueMesh` 重命名为 `ChannelMesh`，`materialIds` 改为 `tileIds`，增加 `ao: Uint8Array`；同时导出 `SectionMesh`、`MESH_CHANNELS` 与两个 `empty*` 工厂。同步修改所有引用（`greedy-mesher.ts`、`protocol.ts`、`work-handlers.ts`、`worker-client.ts`、`world-service.ts`、`stream-controller.ts`、`render-page.ts`、`renderer-adapter.ts`、`main.ts`、`render-upload-queue.ts` 及全部相关测试）——本任务暂保持单通道行为：`greedy-mesher.ts` 继续返回 `ChannelMesh`，调用点用 `meshOpaque(...)` 的返回值不变，只是字段名 `tileIds`/新增 `ao` 全 3。为保持本任务可编译，`SectionMesh` 与 `emptySectionMesh` 先定义但尚未使用。

- [ ] **Step 4: 回归与提交**

```bash
npm run test:unit && npm run lint
git add -A src tests && git commit -m "refactor(mesh): split mesh types into channels and add AO attribute"
```

---

## Task 4: 三通道贪心网格与异形几何

**Files:**
- Modify: `src/meshing/greedy-mesher.ts`（拆为贪心通道 + 异形发射器）
- Modify: `src/workers/work-handlers.ts`
- Test: `tests/unit/meshing/greedy-mesher.test.ts`（重写为 `meshSection`）

**Interfaces:**
- Produces: `meshSection(input: MeshingInput, blocks: BlockRegistry): SectionMesh`。
- `MeshingInput` 增加 `orientations?: (localIndex: number) => number`（中心 section，可选，默认 0）。

- [ ] **Step 1: 三通道失败测试**

重写 `tests/unit/meshing/greedy-mesher.test.ts` 的核心断言：

```ts
it('puts full cubes, cutout cubes and translucent cubes into separate channels', () => {
  const section = sectionWith([
    { x: 0, y: 0, z: 0, blockId: blockByKey('stone').id },
    { x: 0, y: 1, z: 0, blockId: blockByKey('leaves').id },
    { x: 0, y: 2, z: 0, blockId: blockByKey('water').id },
  ]);
  const mesh = meshSection({ section, neighbors: [], sourceVersion: 1 }, blockRegistry);
  expect(mesh.opaque.indices.length).toBeGreaterThan(0);
  expect(mesh.cutout.indices.length).toBeGreaterThan(0);
  expect(mesh.translucent.indices.length).toBeGreaterThan(0);
  expect(mesh.opaque.ao.every((value) => value >= 0 && value <= 3)).toBe(true);
});

it('emits both faces between two adjacent cutout cubes', () => {
  const leaves = blockByKey('leaves').id;
  const section = sectionWith([{ x: 0, y: 0, z: 0, blockId: leaves }, { x: 1, y: 0, z: 0, blockId: leaves }]);
  const mesh = meshSection({ section, neighbors: [], sourceVersion: 1 }, blockRegistry);
  expect(countQuadsWithNormal(mesh.cutout, [1, 0, 0])).toBeGreaterThanOrEqual(1);
  expect(countQuadsWithNormal(mesh.cutout, [-1, 0, 0])).toBeGreaterThanOrEqual(1);
});

it('emits a two-quad cross for a non-solid plant', () => {
  const flower = blockByKey('short_grass').id;
  const section = sectionWith([{ x: 3, y: 3, z: 3, blockId: flower }]);
  const mesh = meshSection({ section, neighbors: [], sourceVersion: 1 }, blockRegistry);
  expect(mesh.cutout.indices.length).toBe(12); // 2 quads * 6 indices
});

it('rotates a front-textured cube by its orientation', () => {
  const chest = blockByKey('chest').id;
  const section = sectionWith([{ x: 2, y: 2, z: 2, blockId: chest }]);
  const input = { section, neighbors: [], sourceVersion: 1, orientations: () => 2 };
  const mesh = meshSection(input, blockRegistry);
  const front = textureTileId('box_face.png');
  expect(someTileOnFace(mesh.cutout, [-1, 0, 0], front)).toBe(true);
});
```

辅助断言函数 `countQuadsWithNormal`、`someTileOnFace` 读取 `indices/positions/normals/tileIds`。

- [ ] **Step 2: 实现三通道构建器**

- 对每个轴向切片，为三通道各建一个 `(Face | undefined)[]` mask：
  - `a=slice`、`b=slice+1` 两个格子；若两格都是 `isFullOccluder` 则无面。
  - 暴露方块在 opaque 立方体上时进 opaque mask（法线指向邻格）。
  - 暴露方块为 cutout 立方体、邻居非完整遮挡时进 cutout mask；translucent 同理进 translucent mask。
  - `Face = { tileId, normal, ao: [4], channel }`；`tileId = blocks.tileForFace(blockId, face, orientation)`。
  - opaque mask 的 AO：按面法线取两个侧轴与角点，用 `sampleBlockId` 判完整遮挡，`computeCornerAo` 填四角；其余通道 ao 全 3。
- 贪心合并规则：`blockId` 换成 `tileId` 相等、normal 相等、四角 ao 相等（cutout/translucent 也允许同 tile 合并）。
- 异形几何：遍历中心 section 每个非 `cube` 且 `renderClass !== 'none'` 的格子，调用对应发射器，把四边形写入所属通道；面被完整遮挡邻居遮住时跳过；发射器按 `orientation` 旋转。发射器清单：`cross`、`slab`、`slab_top`、`half_block`、`pillar_vertical`、`pillar_horizontal`、`handrail`、`handrail_a`、`handrail_b`、`chimney`、`lamp`、`vine`、`lilypad`、`cactus`（尺寸参照 mc-lite 比例，AO 全 3）。
- 三个通道分别转 `ChannelMesh`，返回 `SectionMesh`。

- [ ] **Step 3: 切换 work-handlers 并跑全量**

`handleMeshingRequest` 返回 `mesh: meshSection({ section, neighbors, sourceVersion: request.editVersion, orientations: localIndex => section.getOrientation(localIndex) }, blockRegistry)`；`meshingTransferables` 列出三个通道各 5 个 buffer（`positions/normals/uvs/tileIds/ao/indices`，共 18 个）。

```bash
npm run test:unit && npm run lint
git add src/meshing src/workers tests/unit/meshing && git commit -m "feat(mesh): build opaque, cutout and translucent channels with shapes and AO"
```

---

## Task 5: 三通道网格协议与世界管线（临时合并渲染路径）

**Files:**
- Modify: `src/workers/protocol.ts`、`src/streaming/stream-controller.ts`、`src/world/world-service.ts`、`src/meshing/mesh-types.ts`、`src/app/main.ts`、`src/app/render-upload-queue.ts`
- Test: `tests/unit/streaming/stream-controller.test.ts`、`tests/integration/workers/world-service.test.ts`

**Interfaces:**
- Produces:
  - `MeshingWorkerResponse.mesh: SectionMesh`、`MeshedSection.mesh: SectionMesh`。
  - `UploadJob.mesh: ChannelMesh`（保持 `UploadJob` 单通道形状）。
  - `flattenSectionMesh(mesh: SectionMesh): ChannelMesh`：三通道数组拼接为一个几何（`indices` 依次偏移），供临时单通道渲染。
  - `meshByteLength` 增加 `ao.byteLength`。

- [ ] **Step 1: 失败测试**

`tests/unit/meshing/greedy-mesher.test.ts` 增加：

```ts
it('flattens three channels into one channel without index overlap', () => {
  const stone = blockByKey('stone').id;
  const leaves = blockByKey('leaves').id;
  const water = blockByKey('water').id;
  const section = sectionWith([
    { x: 0, y: 0, z: 0, blockId: stone },
    { x: 0, y: 1, z: 0, blockId: leaves },
    { x: 0, y: 2, z: 0, blockId: water },
  ]);
  const mesh = meshSection({ section, neighbors: [], sourceVersion: 7 }, blockRegistry);
  const flat = flattenSectionMesh(mesh);
  expect(flat.positions.length).toBe(
    mesh.opaque.positions.length + mesh.cutout.positions.length + mesh.translucent.positions.length,
  );
  expect(flat.indices.length).toBe(
    mesh.opaque.indices.length + mesh.cutout.indices.length + mesh.translucent.indices.length,
  );
  for (const index of flat.indices) expect(index).toBeLessThan(flat.positions.length / 3);
});
```

- [ ] **Step 2: 实现协议与管线**

- `protocol.ts`：`MeshingWorkerResponse.mesh`/`MeshedSection.mesh` 改为 `SectionMesh`；新增 `ChannelUploadJob` 不需要——本任务继续用 `UploadJob`，`UploadJob.mesh: ChannelMesh`。
- `stream-controller.ts`：`uploadCost(mesh: SectionMesh)` 求和三通道字节。
- `world-service.ts`：`MeshWorkRequest.section` 不变；`mesh()` 后 `acceptMeshed` 得到 SectionMesh；在 `publishUploads` 用 `flattenSectionMesh` 生成单通道 `UploadJob` 存入 `visibleMeshes`；`visibleMeshFor` 返回类型改为 `ChannelMesh`。
- `mesh-types.ts`：实现 `flattenSectionMesh`。
- `render-upload-queue.ts`：`meshByteLength` 增加 `mesh.ao.byteLength`。
- `main.ts`：`world.visibleMeshFor(key)` 现在返回扁平 ChannelMesh，`mesh.materialIds` 引用点改为 `mesh.tileIds`；渲染层暂以同一 opaque 材质显示全部通道（后续任务替换）。

- [ ] **Step 3: 回归与提交**

```bash
npm run test:unit && npm run lint
git add src/workers src/streaming src/world src/meshing src/app tests && git commit -m "feat(streaming): publish three-channel section meshes through the worker pipeline"
```

---

## Task 6: 纹理图集与共享光照材质

**Files:**
- Create: `src/render/texture-atlas.ts`
- Rewrite: `src/render/materials.ts`
- Test: `tests/unit/render/texture-atlas.test.ts`（node 环境注入假 loader）

**Interfaces:**
- Produces:
  - `buildTextureAtlas(loaders?: { image(name: string): Promise<ImageBitmapLike> }): Promise<BuiltAtlas>`。
  - `BuiltAtlas = { atlas: DataTexture; emissive: DataTexture; tileCount: number }`。
  - `createTerrainMaterials(atlas: BuiltAtlas): TerrainMaterials`。
  - `TerrainMaterials = { opaque: MeshBasicNodeMaterial; cutout: MeshBasicNodeMaterial; translucent: MeshBasicNodeMaterial; dispose(): void }`。
  - `LightingState = { sunEnabled: boolean; aoEnabled: boolean; emissiveEnabled: boolean }`；`applyLighting(materials, state)`。

- [ ] **Step 1: 图集失败测试**

```ts
import { describe, expect, it } from 'vitest';
import { buildTextureAtlas } from '../../../src/render/texture-atlas';

function fakeLoader(size = 16) {
  return {
    async image(_name: string) {
      return { width: size, height: size, close() {} } as ImageBitmap;
    },
  };
}

describe('buildTextureAtlas', () => {
  it('packs every tile into a square grid atlas', async () => {
    const built = await buildTextureAtlas(fakeLoader());
    expect(built.tileCount).toBeGreaterThanOrEqual(128);
    expect(built.atlas.image.width).toBe(built.atlas.image.height);
    built.atlas.dispose();
    built.emissive.dispose();
  });
});
```

实现用 OffscreenCanvas/canvas + `createImageBitmap`；`image.width` 取自然宽度，全部 tile 等比缩放进统一格（当前贴图均为 16px 或更小，统一 16px 格）。失败时按 tile 填洋红色并在 `diagnostics.failedTiles` 记录，不抛错。`emissive` 为与图集同格的 R8 纹理：遍历方块定义，把每面的 tile 对应格设为该方块 `emissive * 255`。

- [ ] **Step 2: 光照材质实现**

`src/render/materials.ts` 用 TSL 重写：

```ts
import { DataTexture } from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import { attribute, floor, mod, normalize, dot, max, texture, uniform, uv, vec2, vec3 } from 'three/tsl';

const ATLAS_COLUMNS = 16;

export function createTerrainMaterials(built: BuiltAtlas): TerrainMaterials {
  const atlasRows = Math.ceil(built.tileCount / ATLAS_COLUMNS);
  const sunDirection = uniform(vec3(0.35, 0.8, 0.35).normalize());
  const sunIntensity = uniform(1.0);
  const ambientIntensity = uniform(0.55);
  const aoStrength = uniform(1.0);
  const emissiveStrength = uniform(1.0);

  const col = mod(attribute('tileId', 'float'), ATLAS_COLUMNS);
  const row = floor(attribute('tileId', 'float').div(ATLAS_COLUMNS));
  const atlasUv = vec2(
    col.add(uv().x).div(ATLAS_COLUMNS),
    float(1).sub(row.add(float(1)).sub(uv().y).div(atlasRows)),
  );
  const albedo = texture(built.atlas, atlasUv);
  const diffuse = max(normalize(attribute('normal', 'vec3')).dot(normalize(sunDirection)), 0)
    .mul(sunIntensity).add(ambientIntensity);
  const aoFactor = float(1).sub(float(1).sub(attribute('ao', 'float').div(3)).mul(aoStrength));
  const emissive = texture(built.emissive, vec2(
    attribute('tileId', 'float').add(0.5).div(built.tileCount), 0.5,
  )).r.mul(emissiveStrength);

  const make = (options: { transparent?: boolean; alphaTest?: number }) => {
    const material = new MeshBasicNodeMaterial(options);
    material.colorNode = albedo.mul(diffuse.mul(aoFactor)).add(emissive);
    uniformRefs.set(material, {
      sunIntensity,
      ambientIntensity,
      aoStrength,
      emissiveStrength,
    });
    return material;
  };
  const opaque = make({});
  const cutout = make({ alphaTest: 0.5 });
  const translucent = make({ transparent: true, depthWrite: false });
  return { opaque, cutout, translucent, dispose };
}

export function applyLighting(materials: TerrainMaterials, state: LightingState): void {
  const refs = [materials.opaque, materials.cutout, materials.translucent].map((material) => {
    const found = uniformRefs.get(material);
    if (!found) throw new Error('Terrain material is missing lighting uniforms');
    return found;
  });
  for (const current of refs) {
    current.sunIntensity.value = state.sunEnabled ? 1 : 0;
    current.ambientIntensity.value = state.sunEnabled ? 0.55 : 1;
    current.aoStrength.value = state.aoEnabled ? 1 : 0;
    current.emissiveStrength.value = state.emissiveEnabled ? 1 : 0;
  }
}
```

`uniformRefs` 是模块级 `Map<MeshBasicNodeMaterial, LightingUniformRefs>`，`LightingUniformRefs` 四个字段为 TSL `uniform()` 返回的 uniform 节点。具体 TSL 导入名以 `node_modules/three/tsl` 实际导出为准，实现时以 `npm run build` 类型检查通过为门槛。`ao` attribute 由三个通道都提供（非 opaque 恒 3）。

- [ ] **Step 3: 回归与提交**

```bash
npm run test:unit && npm run build && npm run lint
git add src/render tests/unit/render && git commit -m "feat(render): add texture atlas and shared lit terrain materials"
```

---

## Task 7: 三通道渲染页面与主循环接入

**Files:**
- Rewrite: `src/render/render-page.ts`
- Modify: `src/render/renderer-adapter.ts`、`src/app/main.ts`、`src/app/render-upload-queue.ts`
- Test: `tests/unit/render/render-page.test.ts`、`tests/integration/render/renderer-fallback.test.ts`

**Interfaces:**
- Produces:
  - `RenderPage.beginStaging(channel: MeshChannel, mesh: ChannelMesh): RenderStaging | null`。
  - `RenderPage.setVisible(visible: boolean): void`；`RenderPage.isVisible(camera: CameraFrustum): boolean`。
  - `RendererAdapter.addTransient(object: Object3D): void`、`removeTransient(object: Object3D): void`、`setPixelRatio(scale: number): void`。
  - `ChannelUploadJob = { key: string; sectionKey: string; channel: MeshChannel; editVersion: number; mesh: ChannelMesh; estimatedUploadMs: number }`。
  - `channelUploadKey(sectionKey: string, channel: MeshChannel): string`（`${sectionKey}#${channel}`）。

- [ ] **Step 1: RenderPage 失败测试**

```ts
it('swaps each channel independently and drops stale channel versions', () => {
  const page = new RenderPage('0,0,0', materials, capturingTarget());
  const v1 = channelMesh(1, [0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 1, 2], [1, 1, 1]);
  const v2 = channelMesh(2, [0, 0, 0, 2, 0, 0, 0, 2, 0], [0, 1, 2], [1, 1, 1]);
  page.replace('opaque', v1);
  page.replace('opaque', v2);
  page.replace('cutout', v2);
  expect(page.channelVersion('opaque')).toBe(2);
  expect(page.channelVersion('cutout')).toBe(2);
  page.replace('opaque', v1); // stale
  expect(page.channelVersion('opaque')).toBe(2);
});
```

- [ ] **Step 2: 实现 RenderPage 三通道**

- 构造参数 `(key, materials: TerrainMaterials, target: RenderPageTarget)`；内部 `channels: Map<MeshChannel, Mesh>`、`staging: Map<MeshChannel, RenderStaging>`、`group: Group`。`group.name = \`section:${key}\``，在构造时创建，但只在第一个通道物化时通过 `target.swap(null, group)` 挂入场景。
- `replace(channel, mesh)` 校验 `sourceVersion` 单调，创建 `Mesh(geometryFor(mesh), materials[channel])`，在 `group` 内做 `previous?.removeFromParent()` + `group.add(next)`，随后 dispose 旧 geometry；若这是页面首个物化通道，先调 `target.swap(null, group)`。`beginStaging(channel, mesh)` 沿用 `RenderStaging`（`materialIds -> tileIds`，增加 `ao` 阶段与 `tileIds` 2 字节阶段）；`commitStaging` 走同样的 channel 内替换。
- `RenderPageTarget` 为 `{ swap(previous: Group | null, next: Group | null): void }`（只表达整页挂载/卸载）；`dispose()` 调 `target.swap(group, null)` 并逐个 `geometry.dispose()`、释放材质租约。`setVisible(visible)` 直接设置 `group.visible`。

- [ ] **Step 3: 适配层与主循环**

- `renderer-adapter.ts`：`RenderPage` 构造传材质；`swapObject(key, previous, next)` 管理 `Map<string, Group>`；`stageUpload/commitUpload` 用 `channelUploadKey` 与 `page.beginStaging(channel, job.mesh)`；`retainPages` 按 section key；`render()` 遍历 page 设置 `group.visible = page.isVisible(pageFrustum)`；`diagnostics().pageCount` 统计 section 页面数。
- `RendererDriver` 增加 `setPixelRatio(scale: number): void`（内部 `renderer.setPixelRatio(scale); renderer.setSize(canvas.clientWidth, canvas.clientHeight, false)`）；`RendererAdapter.setPixelRatio` 转发。`scene` 增加 `effects` Group 常驻；`addTransient/removeTransient` 增删该 Group 子节点。
- `main.ts`：启动时 `await buildTextureAtlas()`（放在 loading 阶段，失败自动回退），`createTerrainMaterials` 后 `RendererAdapter.create(canvas, options, materials)`；`updateRenderUploads` 遍历 `world.visibleMeshFor(sectionKey)` 的 `SectionMesh` 三通道，逐个构造 `ChannelUploadJob`（空 `indices` 的通道调用 `renderer.removeChannel(sectionKey, channel)`），`uploadQueue` 与 `uploadedVersions` 键用 `channelUploadKey`。
- 空 section（三通道全空）时移除整个页面。

- [ ] **Step 4: 回归与提交**

```bash
npm run test:unit && npm run build && npm run lint
git add src/render src/app tests && git commit -m "feat(render): render section pages as three channel groups with atlas lighting"
```

---

## Task 8: 玩家重力、跳跃、出生落地与交互距离

**Files:**
- Create: `src/gameplay/spawn.ts`
- Modify: `src/gameplay/player-controller.ts`、`src/gameplay/player-interaction.ts`、`src/app/main.ts`
- Test: `tests/unit/gameplay/player-controller.test.ts`、`tests/unit/gameplay/spawn.test.ts`

**Interfaces:**
- Produces:
  - `PlayerController.verticalVelocity`、`isOnGround`、`requestJump()`、`setPosition(pos: Vec3)`、`applyVerticalPhysics(dtSeconds: number): Vec3`。
  - `PLAYER_GRAVITY = -24`、`PLAYER_TERMINAL_VELOCITY = -50`、`PLAYER_JUMP_FORCE = 10`、`INTERACTION_REACH = 6`。
  - `surfaceFeetY(world: WorldQuery, x: number, z: number): number`（最高非空气方块顶部 + 1，无方块时 0）。

- [ ] **Step 1: 物理失败测试**

```ts
it('falls under gravity and settles on a solid floor', () => {
  const world = new InMemoryWorld();
  world.applyEdits([{ pos: { x: 0, y: 0, z: 0 }, blockId: 1 }]);
  const player = new PlayerController(world, { x: 0.5, y: 3, z: 0.5 });
  for (let i = 0; i < 240; i += 1) player.applyVerticalPhysics(1 / 60);
  expect(player.position.y).toBeCloseTo(1, 5);
  expect(player.isOnGround).toBe(true);
  expect(player.verticalVelocity).toBe(0);
});

it('jumps only from the ground and falls back under gravity', () => {
  const world = new InMemoryWorld();
  world.applyEdits([{ pos: { x: 0, y: 0, z: 0 }, blockId: 1 }]);
  const player = new PlayerController(world, { x: 0.5, y: 1, z: 0.5 });
  player.applyVerticalPhysics(1 / 60); // 落地
  player.requestJump();
  player.applyVerticalPhysics(1 / 60);
  expect(player.verticalVelocity).toBe(PLAYER_JUMP_FORCE);
  expect(player.isOnGround).toBe(false);
  player.applyVerticalPhysics(1 / 60);
  expect(player.verticalVelocity).toBeLessThan(PLAYER_JUMP_FORCE);
});

it('keeps step horizontal and terminal velocity bounded', () => {
  const player = new PlayerController(new InMemoryWorld(), { x: 0.5, y: 80, z: 0.5 });
  player.step({ x: 1, z: 0 }, 0.25);
  expect(player.position.y).toBe(80);
  for (let i = 0; i < 200; i += 1) player.applyVerticalPhysics(1 / 20);
  expect(player.verticalVelocity).toBeGreaterThanOrEqual(PLAYER_TERMINAL_VELOCITY);
});
```

- [ ] **Step 2: 实现垂直物理**

- `applyVerticalPhysics`：若 `jumpQueued && onGround` 设 `verticalVelocity = 10`；`velocity += -24 * dt` 并 clamp 到 [-50, +∞)；按新 y 用与水平一致的 AABB（`PLAYER_BELOW_POSITION=1`、`PLAYER_ABOVE_POSITION=0.8`、halfWidth=0.3）做逐格碰撞：向下撞到底面时 `y = cellTop`、`onGround=true`、`velocity=0`；向上撞到顶面时 `velocity=0`。结束 `jumpQueued=false`。
- `onGround` 每帧重算：`applyVerticalPhysics` 先探测脚下 0.001 处是否碰撞；未调用时 `isOnGround` 返回缓存值。
- `requestJump()` 只置位；`setPosition` 校验有限值并同步重置速度/地面标志。
- `surfaceFeetY` 从 y=127 向下扫描第一个 `blockId !== 0`（空气），返回 `y + 1`；找不到返回 0。`main.ts` 在 `prepareSpawn` 后用 `surfaceFeetY(world, 0, 0)` 创建玩家；主循环把 `step` 与 `applyVerticalPhysics` 都调用；Space keydown（`event.code === 'Space'`，`preventDefault`）调用 `requestJump()`。
- `player-interaction.ts`：`INTERACTION_REACH = 6`。

- [ ] **Step 3: 回归与提交**

```bash
npm run test:unit && npm run build && npm run lint
git add src/gameplay src/app tests && git commit -m "feat(physics): add gravity, jumping and surface spawn"
```

---

## Task 9: TNT 点燃与连锁爆炸

**Files:**
- Create: `src/gameplay/tnt.ts`
- Modify: `src/gameplay/player-interaction.ts`、`src/app/main.ts`
- Test: `tests/unit/gameplay/tnt.test.ts`

**Interfaces:**
- Produces:
  - `InteractionEffects = { onBlockBroken?(block: BlockPos, blockId: number): void; onChestOpened?(block: BlockPos, orientation: number): void; onTntIgnited?(block: BlockPos): void; onBlockPlaced?(block: BlockPos, blockId: number): void }`（后续任务复用）。
  - `computeExplosion(world: WorldQuery, center: BlockPos, destroyBlocks: boolean): ExplosionEvent`。
  - `ExplosionEvent = { center: BlockPos; destroyed: readonly BlockPos[]; ignited: readonly { pos: BlockPos; delayMs: number }[] }`。
  - `createTntSystem(deps: { world: WorldQuery; destroyBlocks: boolean; now(): number; schedule(fn: () => void, delayMs: number): void; onExplode(event: ExplosionEvent): void }): TntSystem`。
  - `TntSystem.ignite(pos: BlockPos): boolean`、`dispose(): void`；`TntSystem.setDestroyBlocks(enabled: boolean): void`。

- [ ] **Step 1: 失败测试**

```ts
it('destroys a 3x3x3 area but keeps indestructible blocks', () => {
  const world = new InMemoryWorld();
  world.applyEdits([
    { pos: { x: 0, y: 0, z: 0 }, blockId: blockByKey('tnt').id },
    { pos: { x: 1, y: 0, z: 0 }, blockId: blockByKey('stone').id },
    { pos: { x: 0, y: 1, z: 1 }, blockId: blockByKey('bedrock').id },
  ]);
  const event = computeExplosion(world, { x: 0, y: 0, z: 0 }, true);
  expect(event.destroyed).toContainEqual({ x: 1, y: 0, z: 0 });
  expect(event.destroyed).not.toContainEqual({ x: 0, y: 1, z: 1 });
  expect(event.destroyed.some((pos) => pos.x === 0 && pos.y === 0 && pos.z === 0)).toBe(true);
});

it('chains to tnt within 5 blocks and applies edits after the delay', () => {
  const world = new InMemoryWorld();
  const tnt = blockByKey('tnt').id;
  world.applyEdits([
    { pos: { x: 0, y: 0, z: 0 }, blockId: tnt },
    { pos: { x: 2, y: 0, z: 0 }, blockId: tnt },
  ]);
  let now = 0;
  const scheduled: Array<{ delayMs: number; run(): void }> = [];
  const system = createTntSystem({
    world,
    destroyBlocks: true,
    now: () => now,
    schedule: (run, delayMs) => scheduled.push({ delayMs, run }),
    onExplode: () => {},
  });
  expect(system.ignite({ x: 0, y: 0, z: 0 })).toBe(true);
  expect(world.getBlock({ x: 0, y: 0, z: 0 })).toBe(0);
  expect(scheduled.length).toBe(1);
  now += scheduled[0].delayMs;
  scheduled[0].run();
  expect(world.getBlock({ x: 2, y: 0, z: 0 })).toBe(0);
});
```

- [ ] **Step 2: 实现 `tnt.ts`**

- `computeExplosion`：3×3×3 遍历，`world.getBlock` 为 air 跳过、`blockById(...).indestructible` 跳过，其余进 `destroyed`；5×5×5 遍历（去掉中心）找 `tnt` 进 `ignited`，`delayMs = 500 + Math.random() * 600`。
- `createTntSystem.ignite`：位置仍是 tnt 才处理；`applyEdits` 移除自身与 `destroyed`（`destroyBlocks` 为 false 时只移除自身）；调用 `onExplode`；对每个 `ignited` 用 `schedule` 延时后再次 `ignite`（若该格已非 tnt 则跳过）；返回是否真实点燃。
- `dispose` 置位使已调度回调失效。

- [ ] **Step 3: 接入交互与主循环**

- `PlayerInteraction` 构造新增 `effects: InteractionEffects`（Task 10 定义同文件）：`breakBlock` 命中 tnt 时不加背包，改调 `effects.onTntIgnited?.(hit.block)` 并 `applyEdits` 移除 tnt 后返回 true。
- `main.ts` 创建 `tntSystem`，`onTntIgnited -> tntSystem.ignite`，`onExplode -> particles.spawn('explosion', center)`；设置面板开关调用 `tntSystem.setDestroyBlocks`。

```bash
npm run test:unit && npm run lint
git add src/gameplay src/app tests && git commit -m "feat(gameplay): add TNT ignition, chained explosions and block destruction"
```

---

## Task 10: 宝箱开盖动画

**Files:**
- Create: `src/gameplay/chest-animations.ts`
- Modify: `src/gameplay/player-interaction.ts`、`src/app/main.ts`
- Test: `tests/unit/gameplay/chest-animations.test.ts`（注入假 add/remove 适配器）

**Interfaces:**
- Produces:
  - `ChestAnimations.open(pos: BlockPos, orientation: number, timeMs: number): void`、`update(timeMs: number): void`、`removeAt(pos: BlockPos): void`、`dispose(): void`。

- [ ] **Step 1: 失败测试**

```ts
it('creates one lid per open and removes it after the animation', () => {
  const added: Object3D[] = [];
  const removed: Object3D[] = [];
  const animations = new ChestAnimations({
    add: (object) => added.push(object),
    remove: (object) => removed.push(object),
  });
  animations.open({ x: 1, y: 2, z: 3 }, 2, 1000);
  expect(added).toHaveLength(1);
  animations.update(2000);
  expect(removed).toHaveLength(1);
  animations.dispose();
});

it('recycles an open chest instead of stacking lids', () => {
  const added: Object3D[] = [];
  const animations = new ChestAnimations({ add: (o) => added.push(o), remove: () => {} });
  animations.open({ x: 0, y: 0, z: 0 }, 0, 0);
  animations.open({ x: 0, y: 0, z: 0 }, 0, 100);
  expect(added).toHaveLength(1);
});
```

- [ ] **Step 2: 实现**

- `open`：同一格子已有动画则替换；创建 `Group`，内放 `Mesh(BoxGeometry(1, 0.3, 1), materials.cutout)`，几何加 `tileId` 顶点属性 = `box_top.png` 的 tileId（复用共享材质）；lid 挂在铰链 `Group`，位置按方块中心向上偏移；记录 `openedAt`。
- `update`：`t = (timeMs - openedAt) / 340`，`lid.rotation.x = lerp(0, -1.9, clamp(t,0,1))`，`t >= 1` 后 `remove`。
- `removeAt/dispose` 同步清理。
- `player-interaction.ts`：持有 `openedChests: Set<string>`（`${x},${y},${z}`）；`breakBlock` 命中 chest：不在集合 → 加入集合、调 `onChestOpened`，返回 true；已在集合 → 走正常破坏并加 chest 物品。
- `main.ts`：创建 `ChestAnimations` 并接入 `effects.onChestOpened`；主循环调用 `update(timestampMs)`；`placeForTest` 等路径不触发动画。

```bash
npm run test:unit && npm run lint
git add src/gameplay src/app tests && git commit -m "feat(gameplay): add chest open animations"
```

---

## Task 11: 破坏/爆炸粒子

**Files:**
- Create: `src/render/particles.ts`
- Modify: `src/app/main.ts`
- Test: `tests/unit/render/particles.test.ts`（注入假 texture loader 与假 Sprite 工厂的最小簿记）

**Interfaces:**
- Produces:
  - `ParticleSystem.load(): Promise<void>`、`spawn(type: 'block_crash' | 'explosion', pos: Vec3): void`、`update(dtMs: number): void`、`dispose(): void`。
  - `ParticleSystem.activeCount(): number`（诊断）。

- [ ] **Step 1: 失败测试**

```ts
it('caps pools and reuses the least recently used sprite', async () => {
  const system = new ParticleSystem(fakeAdapter(), fakeAssets());
  await system.load();
  for (let i = 0; i < 20; i += 1) system.spawn('block_crash', { x: 0, y: 0, z: 0 });
  expect(system.activeCount()).toBeLessThanOrEqual(15);
  system.update(1_000);
  expect(system.activeCount()).toBe(0);
  system.dispose();
});
```

- [ ] **Step 2: 实现**

- 三池：`block_crash` 15、`explosion` 10（`pick` 池定义但阶段 2 不触发）。加载 `public/assets/effects/*.png` 为共享 Texture，每池克隆并设置 `repeat(1/tilesX, 1/tilesY)`。
- `spawn`：找空闲 Sprite，无空闲则复用最旧；设置 `position`、`timer=0`、`visible=true`、`opacity=1`。
- `update`：推进 `timer/maxLife`，按帧索引更新 `texture.offset`，按类型做缩放/淡出（crash 放大 1.5、explosion 扩张+末 20% 淡出）；到期隐藏。
- Sprite 加入 `renderer.addTransient` 提供的作用域（由适配层 Group 持有），`dispose` 全部移除并释放。

```bash
npm run test:unit && npm run lint
git add src/render src/app tests && git commit -m "feat(render): add pooled sprite-sheet break and explosion particles"
```

---

## Task 12: GPU 雨效

**Files:**
- Create: `src/render/rain.ts`
- Modify: `src/app/main.ts`
- Test: `tests/unit/render/rain.test.ts`

**Interfaces:**
- Produces:
  - `resolveRainMinY(isSolid: (x: number, y: number, z: number) => boolean, x: number, topY: number, z: number, playerY: number, searchDepth = 56): number`。
  - `RainEffect.setDensity(count: number): void`、`update(playerPos: Vec3, dtSeconds: number): void`、`setEnabled(enabled: boolean): void`、`dispose(): void`。

- [ ] **Step 1: 失败测试**

```ts
it('stops rain at the first solid floor below its drop column', () => {
  const solid = (x: number, y: number, z: number) => x === 3 && z === 4 && y === 10;
  expect(resolveRainMinY(solid, 3, 40, 4, 0)).toBe(11.02);
});

it('falls back below the player when no floor is found', () => {
  expect(resolveRainMinY(() => false, 1, 40, 2, 0, 8)).toBe(0 - 42 * 0.35);
});
```

- [ ] **Step 2: 实现**

- 按 spec 移植 mc-lite `RainEffect`：`particleCount` 默认 700、半径 20、下落速度 24、滴长 0.5、刷新距离 8、垂直刷新 6、周期高度 42、批大小 64；用 `LineSegments + MeshBasicNodeMaterial`，`positionNode` 实现 GPU 下落，`colorNode` 白、`transparent`、`depthWrite=false`、`frustumCulled=false`。
- `update`：更新 `uTime`，30Hz 检查玩家位移，超过阈值分批重设粒子位置（不重设相位），每批 `needsUpdate`。
- `setEnabled(false)` 隐藏并暂停上传；`setDensity` 重建 attribute 数组。

```bash
npm run test:unit && npm run lint
git add src/render src/app tests && git commit -m "feat(render): add GPU rain with batched ground collision"
```

---

## Task 13: 画质档位与设置 UI

**Files:**
- Create: `src/render/light-quality.ts`、`src/app/settings-ui.ts`
- Modify: `src/app/main.ts`
- Test: `tests/unit/render/light-quality.test.ts`

**Interfaces:**
- Produces:
  - `LIGHT_QUALITY_PRESETS: Record<LightQuality, QualityPreset>`（值按 spec §6）。
  - `SettingsUi` 构造 `(doc: Document, hooks: { setQuality(q): void; toggleRain(): void; toggleTntDestroy(): void; getState(): SettingsState })`；`show()/hide()`。

- [ ] **Step 1: preset 失败测试**

```ts
it('uses the spec render scale and rain density per tier', () => {
  expect(LIGHT_QUALITY_PRESETS.low).toMatchObject({ renderScale: 0.6, aoEnabled: false, rainParticleCount: 250 });
  expect(LIGHT_QUALITY_PRESETS.medium).toMatchObject({ renderScale: 0.8, aoEnabled: false, rainParticleCount: 450 });
  expect(LIGHT_QUALITY_PRESETS.high).toMatchObject({ renderScale: 1.0, aoEnabled: true, rainParticleCount: 700 });
});
```

- [ ] **Step 2: 实现**

- `light-quality.ts` 为纯数据。
- `settings-ui.ts`：⚙ 按钮（`data-testid="settings-button"`）+ 模态（`data-testid="settings-modal"`）含三档按钮（`quality-low/medium/high`）、下雨开关（`rain-toggle`）、TNT 破坏开关（`tnt-destroy-toggle`）、关闭按钮；按钮 `onclick` 调 hook 并刷新高亮（`aria-pressed`）。
- `main.ts`：`applyQuality(q)` 调 `renderer.setPixelRatio(preset.renderScale)`、`applyLighting(materials, { sunEnabled: preset.sunEnabled, aoEnabled: preset.aoEnabled, emissiveEnabled: preset.emissiveEnabled })`、`rain.setDensity(preset.rainParticleCount)`；打开设置时 `document.exitPointerLock()`，关闭时 `canvas.requestPointerLock()`；`window.game` 暴露 `quality` 当前档供 e2e。

```bash
npm run test:unit && npm run lint
git add src/render src/app tests && git commit -m "feat(app): add quality presets and settings panel"
```

---

## Task 14: mc-lite 存档导入 UI

**Files:**
- Create: `src/app/import-ui.ts`
- Modify: `src/app/main.ts`
- Test: `tests/integration/app/stage-2.e2e.ts`（JSON 文件导入流程）

**Interfaces:**
- Produces: `ImportUi.request(): Promise<{ kind: 'new' } | { kind: 'import'; snapshot: ParsedLegacySnapshot }>`；`ImportUi.showReport(report: LegacyImportReport): void`。

- [ ] **Step 1: 实现**

- 启动时显示模态：`新世界`、`从 IndexedDB 导入`、`从 JSON 文件导入`（`data-testid` 对应 `import-new/import-indexeddb/import-file`）。IndexedDB 走 `importFromLegacyIndexedDb(indexedDB)`，文件走 `<input type=file accept=.json>` + `file.text()` + `parseLegacySnapshot`；错误显示 `import-error` 文案。
- `main.ts`：`createGameApp` 增加 `options.legacySnapshot?: ParsedLegacySnapshot`；`prepareSpawn` 完成后 `world.applyEdits(snapshot.edits)`、`player.setPosition(snapshot.player)`、`player.setLook(snapshot.player.yaw, snapshot.player.pitch)`，随后进入正常帧循环（自然下落）；`ImportUi.showReport` 显示"导入 N 方块，封存 M 条，警告 K 条"。
- 保持 `mc_lite_manual_saves` 只读，不做删除。

- [ ] **Step 2: e2e 测试**

在 `tests/integration/app/stage-2.e2e.ts` 中：

```ts
test('imports a JSON legacy snapshot and reports preserved entries', async ({ page }) => {
  await page.goto('/');
  const legacy = {
    player: { x: 1, y: 30, z: 2, pitch: 0, yaw: 0 },
    seed: 5,
    worldDeltas: [{
      key: '0,0',
      blocks: { '1,2,3': { type: 'wood', orientation: 2 }, '4,5,6': { type: 'future_block', orientation: 0 } },
      entities: {},
    }],
  };
  await page.getByTestId('import-file').setInputFiles({
    name: 'legacy.json', mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(legacy)),
  });
  await page.getByText('World ready').waitFor();
  expect(await page.evaluate(() => window.game!.readBlockForTest({ x: 1, y: 2, z: 3 }))).toBe('wood');
  await expect(page.getByTestId('import-report')).toContainText('封存 1');
});
```

```bash
npm run test:unit && npm run lint
git add src/app src/gameplay tests && git commit -m "feat(app): add mc-lite legacy save import flow"
```

---

## Task 15: 浏览器回归、性能基准与文档

**Files:**
- Modify: `tests/integration/app/stage-2.e2e.ts`、`README.md`
- Test: 全量单测、构建、lint、e2e、300 秒 WebGPU 基准。

- [ ] **Step 1: 补齐 e2e**

在 `stage-2.e2e.ts` 增加：出生落地（`player.position.y` 接近地表）；按 Space 后 `y` 上升；宝箱两次点击（第一次出现 `chest-lid`、第二次格子变 air）；TNT 连锁（点燃后 3×3×3 内石头变 air）；设置面板切到 `quality-low` 后 `window.game.quality === 'low'`；下雨开关后 `window.game.rainEnabled === true`。

- [ ] **Step 2: 全量验证**

```bash
npm run test:unit
npm run build
npm run lint
npm run test:e2e
```

- [ ] **Step 3: 300 秒 WebGPU 验收**

```bash
npx playwright test tests/performance/playable-core.spec.ts --project=chrome
```

确认 `artifacts/perf/playable-core.json` 的 `onePercentLowFps >= 90` 且 `p99FrameMs <= 11.1`；不达标则定位真实瓶颈（图集采样/AO/上传）修复后重跑，不改默认视距或画质。

- [ ] **Step 4: 文档与提交**

更新 `README.md` 的玩法与验收说明（阶段 2 内容、画质档、导入入口），然后：

```bash
git add README.md artifacts/perf/playable-core.json tests
git commit -m "test(stage2): verify content features, import flow and 90fps acceptance"
```

---

## 完成核对

- [ ] 全部 mc-lite 方块 key 可通过 `blockByKey` 解析，旧 id 0..7 稳定。
- [ ] 三通道网格与异形几何/AO/朝向均有用例覆盖。
- [ ] 重力/跳跃/出生落地、宝箱、TNT、粒子、雨、画质、导入各有单测或 e2e。
- [ ] 300 秒 WebGPU 基准达到 90 FPS/11.1 ms 契约，报告写入 artifacts。
