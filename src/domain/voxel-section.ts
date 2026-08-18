import type { SectionPos } from './coords';

const CELL_COUNT = 16 * 16 * 16;

export type VoxelSectionData = Readonly<{
  palette: Uint16Array;
  indices: Uint16Array;
  orientations: Uint8Array;
}>;

export class VoxelSection {
  readonly pos: SectionPos;
  readonly editVersion: number;
  private readonly palette: readonly number[];
  private readonly indices: Uint16Array;
  private readonly orientations: Uint8Array;

  private constructor(
    pos: SectionPos,
    palette: readonly number[],
    indices: Uint16Array,
    orientations: Uint8Array,
    editVersion: number,
  ) {
    this.pos = Object.freeze({ ...pos });
    this.palette = palette;
    this.indices = indices;
    this.orientations = orientations;
    this.editVersion = editVersion;
  }

  static filled(pos: SectionPos, blockId: number): VoxelSection {
    return new VoxelSection(
      pos,
      [blockId],
      new Uint16Array(CELL_COUNT),
      new Uint8Array(CELL_COUNT),
      0,
    );
  }

  static fromPaletteIndices(
    pos: SectionPos,
    palette: Uint16Array,
    indices: Uint16Array,
    editVersion: number,
    orientations?: Uint8Array,
  ): VoxelSection {
    if (palette.length === 0) throw new Error('VoxelSection palette cannot be empty');
    if (indices.length !== CELL_COUNT) throw new Error(`VoxelSection requires ${CELL_COUNT} indices`);
    if (!Number.isInteger(editVersion) || editVersion < 0) throw new Error('Invalid VoxelSection editVersion');
    const nextOrientations = orientations ?? new Uint8Array(CELL_COUNT);
    if (nextOrientations.length !== CELL_COUNT) {
      throw new Error(`VoxelSection requires ${CELL_COUNT} orientations`);
    }
    for (const orientation of nextOrientations) {
      if (orientation > 3) throw new Error(`Invalid VoxelSection orientation ${orientation}`);
    }
    for (const paletteIndex of indices) {
      if (paletteIndex >= palette.length) throw new Error(`Invalid VoxelSection palette index ${paletteIndex}`);
    }
    return new VoxelSection(
      pos,
      Array.from(palette),
      indices.slice(),
      nextOrientations.slice(),
      editVersion,
    );
  }

  toPaletteIndices(): VoxelSectionData {
    return {
      palette: Uint16Array.from(this.palette),
      indices: this.indices.slice(),
      orientations: this.orientations.slice(),
    };
  }

  get(localIndex: number): number {
    return this.palette[this.indices[localIndex]];
  }

  getOrientation(localIndex: number): number {
    return this.orientations[localIndex];
  }

  set(localIndex: number, blockId: number, orientation = 0): VoxelSection {
    if (!Number.isInteger(orientation) || orientation < 0 || orientation > 3) {
      throw new Error(`Invalid VoxelSection orientation ${orientation}`);
    }
    if (this.get(localIndex) === blockId && this.getOrientation(localIndex) === orientation) return this;

    const paletteIndex = this.palette.indexOf(blockId);
    const nextPalette = paletteIndex === -1 ? [...this.palette, blockId] : this.palette;
    const nextIndices = this.indices.slice();
    nextIndices[localIndex] = paletteIndex === -1 ? nextPalette.length - 1 : paletteIndex;
    const nextOrientations = this.orientations.slice();
    nextOrientations[localIndex] = orientation;
    return new VoxelSection(
      this.pos,
      nextPalette,
      nextIndices,
      nextOrientations,
      this.editVersion + 1,
    );
  }
}
