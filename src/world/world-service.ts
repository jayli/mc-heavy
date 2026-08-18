import { blockById } from '../domain/blocks';
import { localIndex, SECTION_SIZE, sectionOf, type BlockPos, type SectionPos, type Vec3 } from '../domain/coords';
import { VoxelSection } from '../domain/voxel-section';
import type { OpaqueMesh } from '../meshing/mesh-types';
import { StreamController } from '../streaming/stream-controller';
import type { ColumnPos, MeshWorkRequest, UploadJob, Vec2, WorkRequest } from '../workers/protocol';
import {
  isWorkerWideError,
  WorkerClient,
  type WorkerFactory,
} from '../workers/worker-client';
import { deserializeVoxelSection, serializeVoxelSection } from '../workers/voxel-section-codec';
import { createGenerator } from './terrain';
import { InMemoryWorld, type BlockEdit, type VoxelHit, type WorldQuery } from './world-query';

const DEFAULT_VIEW_RADIUS = 8;
const SPAWN_RADIUS = 1;
const STREAM_SECTION_YS = [0, 1, 2] as const;
const ALL_UPLOADS_BUDGET_MS = Number.POSITIVE_INFINITY;
const MAX_WORK_PER_BATCH = 8;

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
const columnKey = ({ x, z }: ColumnPos, y: number): string => `${x},${y},${z}`;
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
      for (const y of STREAM_SECTION_YS) keys.add(columnKey({ x: center.x + dx, z: center.z + dz }, y));
    }
  }
  return keys;
}

function sectionWithEdits(
  section: VoxelSection,
  edits: ReadonlyMap<number, Readonly<{ blockId: number; orientation: number }>> | undefined,
  editVersion: number,
): VoxelSection {
  const data = section.toPaletteIndices();
  const palette = Array.from(data.palette);
  const paletteByBlock = new Map(palette.map((blockId, index) => [blockId, index]));
  const orientations = data.orientations;
  if (edits) {
    for (const [index, edit] of edits) {
      let paletteIndex = paletteByBlock.get(edit.blockId);
      if (paletteIndex === undefined) {
        paletteIndex = palette.length;
        palette.push(edit.blockId);
        paletteByBlock.set(edit.blockId, paletteIndex);
      }
      data.indices[index] = paletteIndex;
      orientations[index] = edit.orientation;
    }
  }
  return VoxelSection.fromPaletteIndices(
    section.pos,
    Uint16Array.from(palette),
    data.indices,
    editVersion,
    orientations,
  );
}

export class WorldService implements WorldQuery {
  private readonly seed: number;
  private readonly viewRadius: number;
  private readonly world: InMemoryWorld;
  private readonly loadedWorldQuery: InMemoryWorld;
  private readonly workers: WorkerClient;
  private readonly stream: StreamController;
  private readonly persistentEditVersions = new Map<string, number>();
  private readonly transientVersions = new Map<string, number>();
  private readonly editsBySection = new Map<string, Map<number, Readonly<{ blockId: number; orientation: number }>>>();
  private readonly generatedSections = new Map<string, VoxelSection>();
  private readonly visibleMeshes = new Map<string, UploadJob>();
  private readonly workerFailures = new Map<string, WorkerFailure>();
  private readonly pendingMeshes: MeshWorkRequest[] = [];
  private desired = new Set<string>();
  private visibility: Readonly<{ center: ColumnPos; velocity: Vec2; radius: number }> | null = null;
  private haloRefreshNeeded = false;
  private pipeline: Promise<void> | null = null;
  private disposed = false;
  private loadedSectionQueries = 0;

  constructor(options: WorldServiceOptions) {
    this.seed = options.seed;
    this.viewRadius = options.viewRadius ?? DEFAULT_VIEW_RADIUS;
    const generator = createGenerator(options.seed);
    this.world = new InMemoryWorld(generator.blockAt);
    this.loadedWorldQuery = new InMemoryWorld((pos) => this.getBlock(pos));
    this.workers = new WorkerClient(options.workerFactory);
    this.stream = new StreamController((key) => this.versionFor(key));
  }

  async prepareSpawn(center: ColumnPos): Promise<void> {
    this.assertActive();
    const requested = desiredKeys(center, SPAWN_RADIUS);
    this.setVisibility(center, { x: 0, z: 0 }, SPAWN_RADIUS);
    this.stream.requestVisibleColumns(center, { x: 0, z: 0 }, SPAWN_RADIUS, STREAM_SECTION_YS);
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
    this.stream.requestVisibleColumns(center, velocity, this.viewRadius, STREAM_SECTION_YS);
    void this.pumpPipeline().catch(() => undefined);
  }

  loadedColumns(): readonly ColumnPos[] {
    const columns = new Map<string, ColumnPos>();
    for (const key of this.visibleMeshes.keys()) {
      const { x, z } = sectionPosFromKey(key);
      columns.set(`${x},${z}`, { x, z });
    }
    return [...columns.values()]
      .sort((a, b) => a.z - b.z || a.x - b.x);
  }

  loadedSectionKeys(): readonly string[] {
    return [...this.visibleMeshes.keys()].sort((left, right) => {
      const a = sectionPosFromKey(left);
      const b = sectionPosFromKey(right);
      return a.z - b.z || a.x - b.x || a.y - b.y;
    });
  }

  cachedSectionCount(): number {
    return this.generatedSections.size;
  }

  loadedBlockAt(pos: BlockPos): number | undefined {
    return this.generatedSections.get(sectionKey(sectionOf(pos)))?.get(localIndex(pos));
  }

  loadedOrientationAt(pos: BlockPos): number | undefined {
    return this.generatedSections.get(sectionKey(sectionOf(pos)))?.getOrientation(localIndex(pos));
  }

  streamingDiagnostics(): Readonly<{
    cachedSections: number;
    visibleMeshes: number;
    failures: number;
    persistentEditVersions: number;
    transientVersions: number;
    pendingMeshes: number;
    loadedSectionQueries: number;
    queuedWork: number;
    tombstones: number;
    sectionRecords: number;
  }> {
    return {
      cachedSections: this.generatedSections.size,
      visibleMeshes: this.visibleMeshes.size,
      failures: this.workerFailures.size,
      persistentEditVersions: this.persistentEditVersions.size,
      transientVersions: this.transientVersions.size,
      pendingMeshes: this.pendingMeshes.length,
      loadedSectionQueries: this.loadedSectionQueries,
      ...this.stream.diagnostics(),
    };
  }

  visibleMeshFor(key: string): OpaqueMesh | undefined {
    return this.visibleMeshes.get(key)?.mesh;
  }

  sectionPriorityFor(key: string): number {
    return this.stream.priorityForKey(key);
  }

  handleWorkerFailure(failure: WorkerFailure): boolean {
    if (!this.stream.rejectWork(failure)) return false;
    this.workerFailures.set(failure.key, failure);
    return true;
  }

  getBlock(pos: BlockPos): number {
    const key = sectionKey(sectionOf(pos));
    const index = localIndex(pos);
    const edits = this.editsBySection.get(key);
    if (edits?.has(index)) return edits.get(index)!.blockId;
    const loaded = this.generatedSections.get(key);
    if (loaded) {
      this.loadedSectionQueries += 1;
      return loaded.get(index);
    }
    return this.world.getBlock(pos);
  }

  isSolid(pos: BlockPos): boolean {
    return blockById(this.getBlock(pos)).solid;
  }

  raycast(origin: Vec3, direction: Vec3, maxDistance: number): VoxelHit | null {
    return this.loadedWorldQuery.raycast(origin, direction, maxDistance);
  }

  applyEdits(edits: readonly BlockEdit[]): Readonly<{ changedSections: readonly SectionPos[] }> {
    const result = this.world.applyEdits(edits);
    const editedKeys = new Set(result.changedSections.map(sectionKey));
    const haloConsumers = new Set<string>();
    for (const edit of edits) {
      const pos = sectionOf(edit.pos);
      const key = sectionKey(pos);
      let sectionEdits = this.editsBySection.get(key);
      if (!sectionEdits) {
        sectionEdits = new Map();
        this.editsBySection.set(key, sectionEdits);
      }
      sectionEdits.set(localIndex(edit.pos), {
        blockId: edit.blockId,
        orientation: edit.orientation ?? 0,
      });
      const localX = localCoordinate(edit.pos.x);
      const localY = localCoordinate(edit.pos.y);
      const localZ = localCoordinate(edit.pos.z);
      if (localX === 0) haloConsumers.add(sectionKey({ x: pos.x - 1, y: pos.y, z: pos.z }));
      if (localX === SECTION_SIZE - 1) haloConsumers.add(sectionKey({ x: pos.x + 1, y: pos.y, z: pos.z }));
      if (localZ === 0) haloConsumers.add(sectionKey({ x: pos.x, y: pos.y, z: pos.z - 1 }));
      if (localZ === SECTION_SIZE - 1) haloConsumers.add(sectionKey({ x: pos.x, y: pos.y, z: pos.z + 1 }));
      if (localY === 0) haloConsumers.add(sectionKey({ x: pos.x, y: pos.y - 1, z: pos.z }));
      if (localY === SECTION_SIZE - 1) haloConsumers.add(sectionKey({ x: pos.x, y: pos.y + 1, z: pos.z }));
    }
    for (const key of editedKeys) this.incrementPersistentVersion(key);
    for (const key of haloConsumers) this.incrementTransientVersion(key);
    return result;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.workers.dispose();
    this.stream.dispose();
    this.world.clear();
    this.loadedWorldQuery.clear();
    this.generatedSections.clear();
    this.visibleMeshes.clear();
    this.workerFailures.clear();
    this.pendingMeshes.length = 0;
    this.persistentEditVersions.clear();
    this.transientVersions.clear();
    this.editsBySection.clear();
    this.desired.clear();
    this.visibility = null;
    this.haloRefreshNeeded = false;
    this.loadedSectionQueries = 0;
    this.pipeline = null;
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
      while (batch.length < MAX_WORK_PER_BATCH && (work = this.stream.takeWork()) !== null) batch.push(work);
      if (batch.length > 0) {
        const generation = batch.filter((request): request is Extract<WorkRequest, { kind: 'generate' }> => (
          request.kind === 'generate'
        ));
        this.pendingMeshes.push(...batch.filter((request): request is MeshWorkRequest => request.kind === 'mesh'));
        const results = await Promise.allSettled(generation.map((request) => this.processWork(request)));
        this.refreshAfterHaloArrival();
        const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
        if (failure) throw failure.reason;
        await yieldToEventLoop();
        continue;
      }

      this.refreshAfterHaloArrival();
      work = this.stream.takeWork();
      if (work) {
        if (work.kind === 'mesh') this.pendingMeshes.push(work);
        else await this.processWork(work);
        await yieldToEventLoop();
        continue;
      }

      this.pendingMeshes.sort((left, right) => this.stream.priorityForKey(right.key) - this.stream.priorityForKey(left.key));
      const meshBatch = this.pendingMeshes.splice(0, MAX_WORK_PER_BATCH)
        .filter((request) => this.stream.isCurrentWork(request));
      if (meshBatch.length === 0) {
        if (this.pendingMeshes.length === 0) return;
        await yieldToEventLoop();
        continue;
      }
      const results = await Promise.allSettled(meshBatch.map((request) => this.processWork(request)));
      this.publishUploads();
      const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failure) throw failure.reason;
      await yieldToEventLoop();
    }
  }

  private async processWork(work: WorkRequest): Promise<void> {
    try {
      if (work.kind === 'generate') await this.generate(work);
      else await this.mesh(work);
    } catch (reason) {
      if (isWorkerWideError(reason)) {
        if (this.stream.rejectWork(work)) this.refreshVisibilityNow();
        return;
      }
      if (this.handleWorkerFailure({ key: work.key, epoch: work.epoch, reason })) throw reason;
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
      this.generatedSections.set(work.key, section);
      this.workerFailures.delete(work.key);
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
    if (this.stream.acceptMeshed(result)) this.workerFailures.delete(work.key);
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
    const previousDesired = this.desired;
    this.desired = desiredKeys(center, radius);
    for (const key of this.desired) {
      if (!previousDesired.has(key)) this.invalidateVisibleHaloConsumers(key);
    }
    for (const key of this.generatedSections.keys()) {
      if (this.desired.has(key)) continue;
      this.generatedSections.delete(key);
      this.invalidateVisibleHaloConsumers(key);
    }
    for (const key of this.visibleMeshes.keys()) {
      if (this.desired.has(key)) continue;
      this.visibleMeshes.delete(key);
      this.workerFailures.delete(key);
      this.transientVersions.delete(key);
    }
    for (const key of this.transientVersions.keys()) {
      if (!this.desired.has(key)) this.transientVersions.delete(key);
    }
    for (const key of this.workerFailures.keys()) {
      if (!this.desired.has(key)) this.workerFailures.delete(key);
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
      { x, y: y - 1, z },
      { x, y: y + 1, z },
      { x, y, z: z - 1 },
      { x, y, z: z + 1 },
    ]) {
      const neighborKey = sectionKey(neighbor);
      if (!this.generatedSections.has(neighborKey) || !this.desired.has(neighborKey)) continue;
      this.incrementTransientVersion(neighborKey);
      this.haloRefreshNeeded = true;
    }
  }

  private refreshAfterHaloArrival(): void {
    if (!this.haloRefreshNeeded || !this.visibility) return;
    this.haloRefreshNeeded = false;
    const { center, velocity, radius } = this.visibility;
    this.stream.requestVisibleColumns(center, velocity, radius, STREAM_SECTION_YS);
  }

  private refreshVisibilityNow(): void {
    if (!this.visibility) return;
    const { center, velocity, radius } = this.visibility;
    this.stream.requestVisibleColumns(center, velocity, radius, STREAM_SECTION_YS);
  }

  private incrementPersistentVersion(key: string): void {
    this.persistentEditVersions.set(key, (this.persistentEditVersions.get(key) ?? 0) + 1);
  }

  private incrementTransientVersion(key: string): void {
    if (!this.desired.has(key)) return;
    this.transientVersions.set(key, (this.transientVersions.get(key) ?? 0) + 1);
  }

  private versionFor(key: string): number {
    return (this.persistentEditVersions.get(key) ?? 0) + (this.transientVersions.get(key) ?? 0);
  }
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
