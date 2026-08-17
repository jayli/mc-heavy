import type { SectionPos } from './coords';

const CELL_COUNT = 16 * 16 * 16;

export class VoxelSection {
  readonly pos: SectionPos;
  readonly editVersion: number;
  private readonly palette: readonly number[];
  private readonly indices: Uint16Array;

  private constructor(
    pos: SectionPos,
    palette: readonly number[],
    indices: Uint16Array,
    editVersion: number,
  ) {
    this.pos = Object.freeze({ ...pos });
    this.palette = palette;
    this.indices = indices;
    this.editVersion = editVersion;
  }

  static filled(pos: SectionPos, blockId: number): VoxelSection {
    return new VoxelSection(pos, [blockId], new Uint16Array(CELL_COUNT), 0);
  }

  get(localIndex: number): number {
    return this.palette[this.indices[localIndex]];
  }

  set(localIndex: number, blockId: number): VoxelSection {
    if (this.get(localIndex) === blockId) return this;

    const paletteIndex = this.palette.indexOf(blockId);
    const nextPalette = paletteIndex === -1 ? [...this.palette, blockId] : this.palette;
    const nextIndices = this.indices.slice();
    nextIndices[localIndex] = paletteIndex === -1 ? nextPalette.length - 1 : paletteIndex;
    return new VoxelSection(this.pos, nextPalette, nextIndices, this.editVersion + 1);
  }
}
