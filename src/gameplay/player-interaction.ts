import { blockById, blockByKey } from '../domain/blocks';
import type { BlockPos, Vec3 } from '../domain/coords';
import type { WorldQuery } from '../world/world-query';
import { Inventory } from './inventory';
import {
  PLAYER_ABOVE_POSITION,
  PLAYER_BELOW_POSITION,
  PLAYER_HALF_WIDTH,
  type HorizontalDirection,
  PlayerController,
} from './player-controller';

const INTERACTION_REACH = 6;

export type InteractionEffects = Readonly<{
  onBlockBroken?(block: BlockPos, blockId: number): void;
  onChestOpened?(block: BlockPos, orientation: number): void;
  onTntIgnited?(block: BlockPos): void;
  onBlockPlaced?(block: BlockPos, blockId: number): void;
}>;

export class PlayerInteraction {
  private readonly openedChests = new Set<string>();

  constructor(
    private readonly inventory: Inventory,
    private readonly player: PlayerController,
    private readonly effects: InteractionEffects = {},
  ) {}

  breakBlock(world: WorldQuery, origin: Vec3, direction: Vec3): boolean {
    const hit = world.raycast(origin, direction, INTERACTION_REACH);
    if (!hit || !world.isSolid(hit.block)) return false;

    blockById(hit.blockId);
    if (hit.blockId === blockByKey('chest').id) {
      const key = `${hit.block.x},${hit.block.y},${hit.block.z}`;
      if (!this.openedChests.has(key)) {
        this.openedChests.add(key);
        this.effects.onChestOpened?.(hit.block, world.getOrientation?.(hit.block) ?? 0);
        return true;
      }
    }
    if (hit.blockId === blockByKey('tnt').id) {
      world.applyEdits([{ pos: hit.block, blockId: 0 }]);
      this.effects.onTntIgnited?.(hit.block);
      return true;
    }
    world.applyEdits([{ pos: hit.block, blockId: 0 }]);
    this.inventory.add(hit.blockId, 1);
    this.effects.onBlockBroken?.(hit.block, hit.blockId);
    return true;
  }

  placeBlock(world: WorldQuery, origin: Vec3, direction: Vec3, blockId: number): boolean {
    const definition = blockById(blockId);
    const selected = this.inventory.selected();
    if (!selected || selected.blockId !== blockId || selected.count < 1) return false;

    const hit = world.raycast(origin, direction, INTERACTION_REACH);
    if (!hit || !hasUniqueFace(hit.normal)) return false;

    const target = {
      x: hit.block.x + hit.normal.x,
      y: hit.block.y + hit.normal.y,
      z: hit.block.z + hit.normal.z,
    };
    if (world.getBlock(target) !== 0 || this.overlapsPlayer(target)) return false;

    world.applyEdits([{
      pos: target,
      blockId,
      orientation: definition.orientation ? quantizeDirection(this.player.facing) : undefined,
    }]);
    if (!this.inventory.remove(blockId, 1)) {
      throw new Error('Inventory changed during block placement');
    }
    this.effects.onBlockPlaced?.(target, blockId);
    return true;
  }

  private overlapsPlayer(block: BlockPos): boolean {
    const position = this.player.position;
    return intersects(block.x, block.x + 1, position.x - PLAYER_HALF_WIDTH, position.x + PLAYER_HALF_WIDTH)
      && intersects(block.y, block.y + 1, position.y - PLAYER_BELOW_POSITION, position.y + PLAYER_ABOVE_POSITION)
      && intersects(block.z, block.z + 1, position.z - PLAYER_HALF_WIDTH, position.z + PLAYER_HALF_WIDTH);
  }
}

const hasUniqueFace = (normal: BlockPos): boolean => (
  Math.abs(normal.x) + Math.abs(normal.y) + Math.abs(normal.z) === 1
);

const intersects = (minimumA: number, maximumA: number, minimumB: number, maximumB: number): boolean => (
  minimumA < maximumB && maximumA > minimumB
);

const quantizeDirection = ({ x, z }: HorizontalDirection): number => {
  if (Math.abs(x) >= Math.abs(z)) return x >= 0 ? 0 : 2;
  return z >= 0 ? 1 : 3;
};
