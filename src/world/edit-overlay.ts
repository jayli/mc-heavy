import { localIndex, sectionOf, type BlockPos, type SectionPos } from '../domain/coords';

type BlockState = Readonly<{ blockId: number; orientation?: number }>;
type SectionEdits = Map<number, BlockState>;

export class EditOverlay {
  private readonly edits = new Map<string, SectionEdits>();

  get(pos: BlockPos): number | undefined {
    const section = sectionOf(pos);
    return this.edits.get(sectionKey(section))?.get(localIndex(pos))?.blockId;
  }

  getOrientation(pos: BlockPos): number | undefined {
    const section = sectionOf(pos);
    return this.edits.get(sectionKey(section))?.get(localIndex(pos))?.orientation;
  }

  set(pos: BlockPos, blockId: number, orientation?: number): SectionPos {
    const section = sectionOf(pos);
    const key = sectionKey(section);
    let sectionEdits = this.edits.get(key);
    if (!sectionEdits) {
      sectionEdits = new Map();
      this.edits.set(key, sectionEdits);
    }
    sectionEdits.set(localIndex(pos), {
      blockId,
      orientation: blockId === 0 ? undefined : orientation,
    });
    return section;
  }

  clear(): void {
    this.edits.clear();
  }
}

const sectionKey = ({ x, y, z }: SectionPos): string => `${x},${y},${z}`;
