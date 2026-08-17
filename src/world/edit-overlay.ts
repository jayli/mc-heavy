import { localIndex, sectionOf, type BlockPos, type SectionPos } from '../domain/coords';

type SectionEdits = Map<number, number>;

export class EditOverlay {
  private readonly edits = new Map<string, SectionEdits>();

  get(pos: BlockPos): number | undefined {
    const section = sectionOf(pos);
    return this.edits.get(sectionKey(section))?.get(localIndex(pos));
  }

  set(pos: BlockPos, blockId: number): SectionPos {
    const section = sectionOf(pos);
    const key = sectionKey(section);
    let sectionEdits = this.edits.get(key);
    if (!sectionEdits) {
      sectionEdits = new Map();
      this.edits.set(key, sectionEdits);
    }
    sectionEdits.set(localIndex(pos), blockId);
    return section;
  }
}

const sectionKey = ({ x, y, z }: SectionPos): string => `${x},${y},${z}`;
