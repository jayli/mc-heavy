import { PriorityWorkQueue } from './priority-queue';
import type {
  ColumnPos,
  GenerateWorkRequest,
  GeneratedSection,
  MeshWorkRequest,
  MeshedSection,
  SectionState,
  UploadJob,
  Vec2,
  WorkRequest,
} from '../workers/protocol';

type SectionRecord = {
  key: string;
  epoch: number;
  editVersion: number;
  priority: number;
  state: SectionState;
  section?: GeneratedSection['section'];
};

export type EditVersionForKey = (key: string) => number;

const DEFAULT_SECTION_YS = [0] as const;
const MINIMUM_UPLOAD_COST_MS = 1;
const BYTES_PER_UPLOAD_MILLISECOND = 64 * 1024;
const ALLOWED_TRANSITIONS: Readonly<Record<SectionState, readonly SectionState[]>> = {
  absent: ['queued'],
  queued: ['generating'],
  generating: ['meshing'],
  meshing: ['uploadQueued'],
  uploadQueued: ['visible'],
  visible: [],
  evicting: [],
};

function sectionKey(column: ColumnPos, y: number): string {
  return `${column.x},${y},${column.z}`;
}

function columnForKey(key: string): ColumnPos | null {
  const [x, y, z, ...rest] = key.split(',');
  if (rest.length !== 0 || !Number.isInteger(Number(y))) return null;
  const column = { x: Number(x), z: Number(z) };
  return Number.isInteger(column.x) && Number.isInteger(column.z) ? column : null;
}

function uploadCost(mesh: MeshedSection['mesh']): number {
  const bytes =
    mesh.positions.byteLength +
    mesh.normals.byteLength +
    mesh.uvs.byteLength +
    mesh.materialIds.byteLength +
    mesh.indices.byteLength;
  return Math.max(MINIMUM_UPLOAD_COST_MS, bytes / BYTES_PER_UPLOAD_MILLISECOND);
}

export class StreamController {
  private readonly workQueue = new PriorityWorkQueue();
  private readonly sections = new Map<string, SectionRecord>();
  private readonly uploads: UploadJob[] = [];
  private readonly editVersionForKey: EditVersionForKey;
  private nextEpoch = 1;

  constructor(editVersionForKey: EditVersionForKey) {
    this.editVersionForKey = editVersionForKey;
  }

  requestVisibleColumns(
    center: ColumnPos,
    velocity: Vec2,
    radius: number,
    sectionYs: readonly number[] = DEFAULT_SECTION_YS,
  ): void {
    const desired = new Set<string>();
    const integerRadius = Math.max(0, Math.floor(radius));
    const verticalSections = [...new Set(sectionYs)].filter(Number.isInteger);
    if (verticalSections.length === 0) throw new Error('At least one integer vertical section is required');
    for (let dz = -integerRadius; dz <= integerRadius; dz += 1) {
      for (let dx = -integerRadius; dx <= integerRadius; dx += 1) {
        for (const y of verticalSections) {
          desired.add(sectionKey({ x: center.x + dx, z: center.z + dz }, y));
        }
      }
    }

    for (const [key, record] of this.sections) {
      if (desired.has(key) && this.currentEditVersion(key) === record.editVersion) {
        const column = columnForKey(key);
        if (!column) throw new Error(`Invalid canonical section key ${key}`);
        const priority = this.priorityFor(center, velocity, column);
        record.priority = priority;
        this.workQueue.updatePriority(record.key, record.epoch, priority);
        continue;
      }
      this.invalidate(record);
    }

    for (const key of desired) {
      if (this.sections.has(key)) continue;
      const column = columnForKey(key);
      if (!column) throw new Error(`Invalid canonical section key ${key}`);
      const record: SectionRecord = {
        key,
        epoch: this.takeEpoch(),
        editVersion: this.currentEditVersion(key),
        priority: this.priorityFor(center, velocity, column),
        state: 'absent',
      };
      this.transition(record, 'absent', 'queued');
      this.sections.set(key, record);
      this.workQueue.enqueue(this.generateRequestFor(record));
    }
  }

  takeWork(): WorkRequest | null {
    let request: WorkRequest | null;
    while ((request = this.workQueue.take()) !== null) {
      const record = this.sections.get(request.key);
      if (!record || !this.matches(record, request)) continue;
      if (request.kind === 'generate') {
        if (record.state !== 'queued') continue;
        this.transition(record, 'queued', 'generating');
      } else {
        if (
          record.state !== 'meshing' ||
          record.section !== request.section ||
          request.section.editVersion !== request.editVersion
        ) {
          continue;
        }
      }
      return request;
    }
    return null;
  }

  acceptGenerated(result: GeneratedSection): boolean {
    const record = this.sections.get(result.key);
    if (!record || !this.matches(record, result) || record.state !== 'generating') return false;
    if (this.currentEditVersion(result.key) !== record.editVersion) {
      this.invalidateAndRequeue(record);
      return false;
    }
    if (result.section.editVersion !== result.editVersion) return false;
    record.section = result.section;
    this.transition(record, 'generating', 'meshing');
    this.workQueue.enqueue(this.meshRequestFor(record, result.section));
    return true;
  }

  acceptMeshed(result: MeshedSection): boolean {
    const record = this.sections.get(result.key);
    if (!record || !this.matches(record, result) || record.state !== 'meshing') return false;
    if (this.currentEditVersion(result.key) !== record.editVersion) {
      this.invalidateAndRequeue(record);
      return false;
    }
    if (result.mesh.sourceVersion !== result.editVersion) return false;
    this.transition(record, 'meshing', 'uploadQueued');
    record.section = undefined;
    this.uploads.push({
      key: result.key,
      editVersion: result.editVersion,
      mesh: result.mesh,
      estimatedUploadMs: uploadCost(result.mesh),
    });
    return true;
  }

  rejectWork(failure: Pick<WorkRequest, 'key' | 'epoch'> & Partial<Pick<WorkRequest, 'editVersion'>>): boolean {
    const record = this.sections.get(failure.key);
    if (!record || record.epoch !== failure.epoch) return false;
    if (failure.editVersion !== undefined && record.editVersion !== failure.editVersion) return false;
    if (record.state !== 'generating' && record.state !== 'meshing') return false;
    this.invalidate(record);
    return true;
  }

  isCurrentWork(work: WorkRequest): boolean {
    const record = this.sections.get(work.key);
    if (!record || !this.matches(record, work)) return false;
    return work.kind === 'mesh' && record.state === 'meshing' && record.section === work.section;
  }

  dispose(): void {
    this.workQueue.clear();
    this.sections.clear();
    this.uploads.length = 0;
  }

  diagnostics(): Readonly<{
    queuedWork: number;
    tombstones: number;
    sectionRecords: number;
    uploads: number;
  }> {
    return {
      ...this.workQueue.diagnostics(),
      sectionRecords: this.sections.size,
      uploads: this.uploads.length,
    };
  }

  drainUploads(budgetMs: number): readonly UploadJob[] {
    const jobs: UploadJob[] = [];
    let remainingBudget = Math.max(0, budgetMs);
    while (this.uploads.length > 0) {
      const job = this.uploads[0];
      if (job.estimatedUploadMs > remainingBudget) break;
      this.uploads.shift();
      const record = this.sections.get(job.key);
      if (!record || record.editVersion !== job.editVersion || record.state !== 'uploadQueued') continue;
      this.transition(record, 'uploadQueued', 'visible');
      jobs.push(job);
      remainingBudget -= job.estimatedUploadMs;
    }
    return jobs;
  }

  peekPriority(column: ColumnPos): number {
    return this.sections.get(sectionKey(column, 0))?.priority ?? Number.NEGATIVE_INFINITY;
  }

  priorityForKey(key: string): number {
    return this.sections.get(key)?.priority ?? Number.NEGATIVE_INFINITY;
  }

  private matches(record: SectionRecord, result: Pick<WorkRequest, 'key' | 'epoch' | 'editVersion'>): boolean {
    return (
      record.key === result.key &&
      record.epoch === result.epoch &&
      record.editVersion === result.editVersion
    );
  }

  private generateRequestFor(record: SectionRecord): GenerateWorkRequest {
    return {
      key: record.key,
      epoch: record.epoch,
      priority: record.priority,
      editVersion: record.editVersion,
      kind: 'generate',
    };
  }

  private meshRequestFor(record: SectionRecord, section: GeneratedSection['section']): MeshWorkRequest {
    return {
      key: record.key,
      epoch: record.epoch,
      priority: record.priority,
      editVersion: record.editVersion,
      kind: 'mesh',
      section,
    };
  }

  private transition(record: SectionRecord, from: SectionState, to: SectionState): void {
    if (record.state !== from || !ALLOWED_TRANSITIONS[from].includes(to)) {
      throw new Error(`Illegal state transition for ${record.key}: ${record.state} to ${to}`);
    }
    record.state = to;
  }

  private priorityFor(center: ColumnPos, velocity: Vec2, column: ColumnPos): number {
    const dx = column.x - center.x;
    const dz = column.z - center.z;
    return -dx * dx - dz * dz + dx * velocity.x + dz * velocity.z;
  }

  private removeQueuedUploads(key: string): void {
    for (let index = this.uploads.length - 1; index >= 0; index -= 1) {
      if (this.uploads[index].key === key) this.uploads.splice(index, 1);
    }
  }

  private invalidate(record: SectionRecord): void {
    this.workQueue.cancel(record.key, record.epoch);
    this.sections.delete(record.key);
    this.removeQueuedUploads(record.key);
  }

  private invalidateAndRequeue(record: SectionRecord): void {
    this.invalidate(record);
    const replacement: SectionRecord = {
      key: record.key,
      epoch: this.takeEpoch(),
      editVersion: this.currentEditVersion(record.key),
      priority: record.priority,
      state: 'absent',
    };
    this.transition(replacement, 'absent', 'queued');
    this.sections.set(replacement.key, replacement);
    this.workQueue.enqueue(this.generateRequestFor(replacement));
  }

  private currentEditVersion(key: string): number {
    return this.editVersionForKey(key);
  }

  private takeEpoch(): number {
    const epoch = this.nextEpoch;
    this.nextEpoch += 1;
    return epoch;
  }
}
