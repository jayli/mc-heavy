import { blockById } from '../domain/blocks';
import { localIndex, SECTION_SIZE, sectionOf, type BlockPos, type SectionPos, type Vec3 } from '../domain/coords';
import { VoxelSection } from '../domain/voxel-section';
import type { OpaqueMesh } from '../meshing/mesh-types';
import { StreamController } from '../streaming/stream-controller';
import type { ColumnPos, MeshWorkRequest, UploadJob, Vec2, WorkRequest } from '../workers/protocol';
import {
  WorkerClient,
  type WorkerFactory,
} from '../workers/worker-client';
import { deserializeVoxelSection, serializeVoxelSection } from '../workers/voxel-section-codec';
import { createGenerator } from './terrain';
import { InMemoryWorld, type BlockEdit, type VoxelHit, type WorldQuery } from './world-query';

const DEFAULT_VIEW_RADIUS = 8;
const SPAWN_RADIUS = 1;
const CANONICAL_SECTION_Y = 0;
const ALL_UPLOADS_BUDGET_MS = Number.POSITIVE_INFINITY;

export type WorldServiceOptions = Readonly<{
  seed: number;
  workerFactory?: WorkerFactory;
  viewRadius?: number;
}>;

export type WorkerFailure = Readonly<{
  key: string;
  epoch: number;
  reason: unknown;
}>;

const sectionKey = ({ x, y, z }: SectionPos): string => `${x},${y},${z}`;
const columnKey = ({ x, z }: ColumnPos): string => `${x},${CANONICAL_SECTION_Y},${z}`;
const localCoordinate = (value: number): number => ((value % SECTION_SIZE) + SECTION_SIZE) % SECTION_SIZE;

function sectionPosFromKey(key: string): SectionPos {
  const parts = key.split(',').map(Number);
  if (parts.length !== 3 || !parts.every(Number.isInteger)) throw new Error(`Invalid section key: ${key}`);
  return { x: parts[0], y: parts[1], z: parts[2] };
}

function desiredKeys(center: ColumnPos, radius: number): Set<string> {
  const keys = new Set<string>();
  const integerRadius = Math.max(0, Math.floor(radius));
  for (let dz = -integerRadius; dz <= integerRadius; dz += 1) {
    for (let dx = -integerRadius; dx <= integerRadius; dx += 1) {
      keys.add(columnKey({ x: center.x + dx, z: center.z + dz }));
    }
  }
  return keys;
}

function sectionWithEdits(
  section: VoxelSection,
  edits: ReadonlyMap<number, number> | undefined,
  editVersion: number,
): VoxelSection {
  const data = section.toPaletteIndices();
  const palette = Array.from(data.palette);
  const paletteByBlock = new Map(palette.map((blockId, index) => [blockId, index]));
  if (edits) {
    for (const [index, blockId] of edits) {
      let paletteIndex = paletteByBlock.get(blockId);
      if (paletteIndex === undefined) {
        paletteIndex = palette.length;
        palette.push(blockId);
        paletteByBlock.set(blockId, paletteIndex);
      }
      data.indices[index] = paletteIndex;
    }
  }
  return VoxelSection.fromPaletteIndices(
    section.pos,
    Uint16Array.from(palette),
    data.indices,
    editVersion,
  );
}

export class WorldService implements WorldQuery {
  private readonly seed: number;
  private readonly viewRadius: number;
  private readonly world: InMemoryWorld;
  private readonly workers: WorkerClient;
  private readonly stream: StreamController;
  private readonly editVersions = new Map<string, number>();
  private readonly editsBySection = new Map<string, Map<number, number>>();
  private readonly generatedSections = new Map<string, VoxelSection>();
  private readonly visibleMeshes = new Map<string, UploadJob>();
  private readonly workerFailures = new Map<string, WorkerFailure>();
  private desired = new Set<string>();
  private visibility: Readonly<{ center: ColumnPos; velocity: Vec2; radius: number }> | null = null;
  private haloRefreshNeeded = false;
  private pipeline: Promise<void> | null = null;
  private disposed = false;

  constructor(options: WorldServiceOptions) {
    this.seed = options.seed;
    this.viewRadius = options.viewRadius ?? DEFAULT_VIEW_RADIUS;
    const generator = createGenerator(options.seed);
    this.world = new InMemoryWorld(generator.blockAt);
    this.workers = new WorkerClient(options.workerFactory);
    this.stream = new StreamController((key) => this.editVersions.get(key) ?? 0);
  }

  async prepareSpawn(center: ColumnPos): Promise<void> {
    this.assertActive();
    const requested = desiredKeys(center, SPAWN_RADIUS);
    this.setVisibility(center, { x: 0, z: 0 }, SPAWN_RADIUS);
    this.stream.requestVisibleColumns(center, { x: 0, z: 0 }, SPAWN_RADIUS);
    await this.pumpPipeline();
    if (requested.size !== this.desired.size || [...requested].some((key) => !this.desired.has(key))) {
      throw new Error('Spawn preparation was superseded by a newer visibility request');
    }
    for (const key of requested) {
      if (!this.visibleMeshes.has(key)) throw new Error(`Spawn section failed to become visible: ${key}`);
    }
  }

  updateStreaming(player: Vec3, velocity: Vec2): void {
    if (this.disposed) return;
    const center = {
      x: Math.floor(player.x / SECTION_SIZE),
      z: Math.floor(player.z / SECTION_SIZE),
    };
    this.setVisibility(center, velocity, this.viewRadius);
    this.stream.requestVisibleColumns(center, velocity, this.viewRadius);
    void this.pumpPipeline().catch(() => undefined);
  }

  loadedColumns(): readonly ColumnPos[] {
    return [...this.visibleMeshes.keys()]
      .map(sectionPosFromKey)
      .filter((pos) => pos.y === CANONICAL_SECTION_Y)
      .map(({ x, z }) => ({ x, z }))
      .sort((a, b) => a.z - b.z || a.x - b.x);
  }

  cachedSectionCount(): number {
    return this.generatedSections.size;
  }

  visibleMeshFor(key: string): OpaqueMesh | undefined {
    return this.visibleMeshes.get(key)?.mesh;
  }

  handleWorkerFailure(failure: WorkerFailure): void {
    this.stream.rejectWork(failure);
    this.workerFailures.set(failure.key, failure);
  }

  getBlock(pos: BlockPos): number {
    const key = sectionKey(sectionOf(pos));
    const index = localIndex(pos);
    const edits = this.editsBySection.get(key);
    if (edits?.has(index)) return edits.get(index) as number;
    return this.generatedSections.get(key)?.get(index) ?? this.world.getBlock(pos);
  }

  isSolid(pos: BlockPos): boolean {
    return blockById(this.getBlock(pos)).solid;
  }

  raycast(origin: Vec3, direction: Vec3, maxDistance: number): VoxelHit | null {
    return this.world.raycast(origin, direction, maxDistance);
  }

  applyEdits(edits: readonly BlockEdit[]): Readonly<{ changedSections: readonly SectionPos[] }> {
    const result = this.world.applyEdits(edits);
    const invalidated = new Set(result.changedSections.map(sectionKey));
    for (const edit of edits) {
      const pos = sectionOf(edit.pos);
      const key = sectionKey(pos);
      let sectionEdits = this.editsBySection.get(key);
      if (!sectionEdits) {
        sectionEdits = new Map();
        this.editsBySection.set(key, sectionEdits);
      }
      sectionEdits.set(localIndex(edit.pos), edit.blockId);
      if (pos.y !== CANONICAL_SECTION_Y) continue;
      const localX = localCoordinate(edit.pos.x);
      const localZ = localCoordinate(edit.pos.z);
      if (localX === 0) invalidated.add(sectionKey({ x: pos.x - 1, y: pos.y, z: pos.z }));
      if (localX === SECTION_SIZE - 1) invalidated.add(sectionKey({ x: pos.x + 1, y: pos.y, z: pos.z }));
      if (localZ === 0) invalidated.add(sectionKey({ x: pos.x, y: pos.y, z: pos.z - 1 }));
      if (localZ === SECTION_SIZE - 1) invalidated.add(sectionKey({ x: pos.x, y: pos.y, z: pos.z + 1 }));
    }
    for (const key of invalidated) this.incrementEditVersion(key);
    return result;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.workers.dispose();
  }

  private async pumpPipeline(): Promise<void> {
    if (this.pipeline) return this.pipeline;
    const current = this.runPipeline();
    this.pipeline = current;
    try {
      await current;
    } finally {
      if (this.pipeline === current) this.pipeline = null;
    }
  }

  private async runPipeline(): Promise<void> {
    while (true) {
      const batch: WorkRequest[] = [];
      let work: WorkRequest | null;
      while ((work = this.stream.takeWork()) !== null) batch.push(work);
      if (batch.length === 0) return;

      const results = await Promise.allSettled(batch.map((request) => this.processWork(request)));
      this.publishUploads();
      this.refreshAfterHaloArrival();
      const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failure) throw failure.reason;
    }
  }

  private async processWork(work: WorkRequest): Promise<void> {
    try {
      if (work.kind === 'generate') await this.generate(work);
      else await this.mesh(work);
    } catch (reason) {
      this.handleWorkerFailure({ key: work.key, epoch: work.epoch, reason });
      throw reason;
    }
  }

  private async generate(work: Extract<WorkRequest, { kind: 'generate' }>): Promise<void> {
    const result = await this.workers.generate({
      kind: 'generate',
      key: work.key,
      epoch: work.epoch,
      editVersion: work.editVersion,
      seed: this.seed,
    });
    const generated = deserializeVoxelSection(result.section);
    const section = sectionWithEdits(
      generated,
      this.editsBySection.get(work.key),
      work.editVersion,
    );
    if (this.stream.acceptGenerated({ ...result, section })) {
      const isNew = !this.generatedSections.has(work.key);
      this.generatedSections.set(work.key, section);
      if (isNew) this.invalidateVisibleHaloConsumers(work.key);
    }
  }

  private async mesh(work: MeshWorkRequest): Promise<void> {
    const neighbors = this.neighborSections(work.key).map((section) => (
      section ? serializeVoxelSection(section) : null
    ));
    const result = await this.workers.mesh({
      kind: 'mesh',
      key: work.key,
      epoch: work.epoch,
      editVersion: work.editVersion,
      section: serializeVoxelSection(work.section),
      neighbors,
    });
    this.stream.acceptMeshed(result);
  }

  private neighborSections(key: string): readonly (VoxelSection | undefined)[] {
    const { x, y, z } = sectionPosFromKey(key);
    return [
      { x: x - 1, y, z },
      { x: x + 1, y, z },
      { x, y: y - 1, z },
      { x, y: y + 1, z },
      { x, y, z: z - 1 },
      { x, y, z: z + 1 },
    ].map((pos) => this.generatedSections.get(sectionKey(pos)));
  }

  private publishUploads(): void {
    for (const job of this.stream.drainUploads(ALL_UPLOADS_BUDGET_MS)) {
      if (!this.desired.has(job.key)) continue;
      const current = this.visibleMeshes.get(job.key);
      if (!current || current.editVersion <= job.editVersion) this.visibleMeshes.set(job.key, job);
    }
  }

  private setVisibility(center: ColumnPos, velocity: Vec2, radius: number): void {
    this.visibility = { center, velocity, radius };
    this.desired = desiredKeys(center, radius);
    for (const key of this.generatedSections.keys()) {
      if (this.desired.has(key)) continue;
      this.generatedSections.delete(key);
      this.invalidateVisibleHaloConsumers(key);
    }
    for (const key of this.visibleMeshes.keys()) {
      if (!this.desired.has(key)) this.visibleMeshes.delete(key);
    }
  }

  private assertActive(): void {
    if (this.disposed) throw new Error('WorldService disposed');
  }

  private invalidateVisibleHaloConsumers(key: string): void {
    const { x, y, z } = sectionPosFromKey(key);
    for (const neighbor of [
      { x: x - 1, y, z },
      { x: x + 1, y, z },
      { x, y, z: z - 1 },
      { x, y, z: z + 1 },
    ]) {
      const neighborKey = sectionKey(neighbor);
      if (!this.visibleMeshes.has(neighborKey) || !this.desired.has(neighborKey)) continue;
      this.incrementEditVersion(neighborKey);
      this.haloRefreshNeeded = true;
    }
  }

  private refreshAfterHaloArrival(): void {
    if (!this.haloRefreshNeeded || !this.visibility) return;
    this.haloRefreshNeeded = false;
    const { center, velocity, radius } = this.visibility;
    this.stream.requestVisibleColumns(center, velocity, radius);
  }

  private incrementEditVersion(key: string): void {
    this.editVersions.set(key, (this.editVersions.get(key) ?? 0) + 1);
  }
}
