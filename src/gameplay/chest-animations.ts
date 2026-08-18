import { BoxGeometry, Group, Mesh, Uint8BufferAttribute, Uint16BufferAttribute } from 'three';
import type { BlockPos } from '../domain/coords';
import { textureTileId } from '../domain/texture-tiles';
import type { TerrainMaterials } from '../render/materials';

const OPEN_DURATION_MS = 340;

export type ChestAnimationHost = Readonly<{
  add(object: Group): void;
  remove(object: Group): void;
}>;

type ActiveChest = Readonly<{
  group: Group;
  lid: Group;
  openedAt: number;
}>;

/** 管理宝箱开盖动画；动画与权威方块数据完全解耦，超时自动回收。 */
export class ChestAnimations {
  private readonly active = new Map<string, ActiveChest>();

  constructor(
    private readonly host: ChestAnimationHost,
    private readonly materials: TerrainMaterials,
  ) {}

  open(pos: BlockPos, orientation: number, timeMs: number): void {
    const key = `${pos.x},${pos.y},${pos.z}`;
    this.removeKey(key);

    const group = new Group();
    group.name = `chest-lid:${key}`;
    group.position.set(pos.x + 0.5, pos.y + 0.7, pos.z + 0.5);
    group.rotation.y = -((orientation % 4) + 4) % 4 * (Math.PI / 2);

    const lid = new Group();
    const geometry = new BoxGeometry(1, 0.3, 1);
    geometry.translate(0, 0.15, 0.5);
    const vertexCount = geometry.attributes.position.count;
    geometry.setAttribute('tileId', new Uint16BufferAttribute(
      new Uint16Array(vertexCount).fill(textureTileId('box_top.png')),
      1,
    ));
    geometry.setAttribute('ao', new Uint8BufferAttribute(new Uint8Array(vertexCount).fill(3), 1));
    lid.add(new Mesh(geometry, this.materials.cutout));
    group.add(lid);

    this.host.add(group);
    this.active.set(key, { group, lid, openedAt: timeMs });
  }

  update(timeMs: number): void {
    for (const [key, chest] of this.active) {
      const progress = Math.max(0, Math.min(1, (timeMs - chest.openedAt) / OPEN_DURATION_MS));
      chest.lid.rotation.x = -1.9 * progress;
      if (progress >= 1) this.removeKey(key);
    }
  }

  removeAt(pos: BlockPos): void {
    this.removeKey(`${pos.x},${pos.y},${pos.z}`);
  }

  dispose(): void {
    for (const key of [...this.active.keys()]) this.removeKey(key);
  }

  private removeKey(key: string): void {
    const chest = this.active.get(key);
    if (!chest) return;
    this.active.delete(key);
    this.host.remove(chest.group);
  }
}
