import { blockById } from '../domain/blocks';
import type { BlockPos, SectionPos, Vec3 } from '../domain/coords';
import { EditOverlay } from './edit-overlay';

export type VoxelHit = Readonly<{
  block: BlockPos;
  normal: BlockPos;
  distance: number;
  blockId: number;
}>;

export type BlockEdit = Readonly<{ pos: BlockPos; blockId: number; orientation?: number }>;

export interface WorldQuery {
  getBlock(pos: BlockPos): number;
  isSolid(pos: BlockPos): boolean;
  raycast(origin: Vec3, direction: Vec3, maxDistance: number): VoxelHit | null;
  applyEdits(edits: readonly BlockEdit[]): Readonly<{ changedSections: readonly SectionPos[] }>;
  getOrientation?(pos: BlockPos): number | undefined;
}

type BlockGenerator = (pos: BlockPos) => number;

export class InMemoryWorld implements WorldQuery {
  private readonly overlay = new EditOverlay();

  constructor(private readonly generatedBlockAt: BlockGenerator = () => 0) {}

  getBlock(pos: BlockPos): number {
    return this.overlay.get(pos) ?? this.generatedBlockAt(pos);
  }

  isSolid(pos: BlockPos): boolean {
    return blockById(this.getBlock(pos)).solid;
  }

  getOrientation(pos: BlockPos): number | undefined {
    return this.overlay.getOrientation(pos);
  }

  raycast(origin: Vec3, direction: Vec3, maxDistance: number): VoxelHit | null {
    if (maxDistance < 0 || !Number.isFinite(maxDistance)) return null;

    const length = Math.hypot(direction.x, direction.y, direction.z);
    if (!Number.isFinite(length) || length === 0) {
      return this.hitAt(origin, { x: 0, y: 0, z: 0 }, 0);
    }

    const ray = { x: direction.x / length, y: direction.y / length, z: direction.z / length };
    let voxel: BlockPos = {
      x: Math.floor(origin.x),
      y: Math.floor(origin.y),
      z: Math.floor(origin.z),
    };
    let normal: BlockPos = { x: 0, y: 0, z: 0 };
    let distance = 0;

    const axes = [
      createAxis(0, origin.x, voxel.x, ray.x),
      createAxis(1, origin.y, voxel.y, ray.y),
      createAxis(2, origin.z, voxel.z, ray.z),
    ];

    while (distance <= maxDistance) {
      const hit = this.hitAt(voxel, normal, distance);
      if (hit) return hit;

      const enteredAxes = nextAxes(axes);
      distance = enteredAxes[0].tMax;
      if (distance > maxDistance) return null;
      for (const axis of enteredAxes) axis.tMax += axis.tDelta;
      voxel = moveAcrossBoundary(voxel, enteredAxes);
      normal = enteredAxes.length === 1
        ? faceNormal(enteredAxes[0].index, enteredAxes[0].step)
        : { x: 0, y: 0, z: 0 };
    }

    return null;
  }

  applyEdits(edits: readonly BlockEdit[]): Readonly<{ changedSections: readonly SectionPos[] }> {
    for (const edit of edits) blockById(edit.blockId);

    const changedSections: SectionPos[] = [];
    const changedKeys = new Set<string>();
    for (const edit of edits) {
      const section = this.overlay.set(edit.pos, edit.blockId, edit.orientation);
      const key = `${section.x},${section.y},${section.z}`;
      if (!changedKeys.has(key)) {
        changedKeys.add(key);
        changedSections.push(section);
      }
    }
    return { changedSections };
  }

  clear(): void {
    this.overlay.clear();
  }

  private hitAt(block: BlockPos, normal: BlockPos, distance: number): VoxelHit | null {
    const blockId = this.getBlock(block);
    if (!blockById(blockId).solid) return null;
    return { block, normal, distance, blockId };
  }
}

type Axis = { index: 0 | 1 | 2; step: number; tMax: number; tDelta: number };

const createAxis = (index: Axis['index'], origin: number, voxel: number, direction: number): Axis => {
  const step = Math.sign(direction);
  if (step === 0) return { index, step, tMax: Infinity, tDelta: Infinity };
  const boundary = step > 0 ? voxel + 1 : voxel;
  return { index, step, tMax: (boundary - origin) / direction, tDelta: 1 / Math.abs(direction) };
};

const nextAxes = (axes: readonly Axis[]): readonly Axis[] => {
  const nextDistance = Math.min(...axes.map((axis) => axis.tMax));
  return axes.filter((axis) => axis.tMax === nextDistance);
};

const moveAcrossBoundary = (voxel: BlockPos, axes: readonly Axis[]): BlockPos => {
  const next = { ...voxel };
  for (const axis of axes) {
    if (axis.index === 0) next.x += axis.step;
    if (axis.index === 1) next.y += axis.step;
    if (axis.index === 2) next.z += axis.step;
  }
  return next;
};

const faceNormal = (axis: Axis['index'], step: number): BlockPos => {
  if (axis === 0) return { x: -step, y: 0, z: 0 };
  if (axis === 1) return { x: 0, y: -step, z: 0 };
  return { x: 0, y: 0, z: -step };
};
