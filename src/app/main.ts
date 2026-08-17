import { blockById, blockByKey } from '../domain/blocks';
import type { BlockPos } from '../domain/coords';
import { Inventory } from '../gameplay/inventory';
import { PlayerController } from '../gameplay/player-controller';
import { PlayerInteraction } from '../gameplay/player-interaction';
import type { OpaqueMesh } from '../meshing/mesh-types';
import {
  RendererAdapter,
  type RendererAdapterOptions,
} from '../render/renderer-adapter';
import type { WorkerFactory } from '../workers/worker-client';
import { WorldService } from '../world/world-service';
import { FrameMetrics } from '../benchmark/frame-metrics';
import { GameHud } from './hud';

const DEFAULT_SEED = 0x5eed_1234;
const CAMERA_HEIGHT = 40;
const HUD_UPDATE_INTERVAL_MS = 250;

export type GameApp = Readonly<{
  player: PlayerController;
  placeForTest(pos: BlockPos, block: string): void;
}>;

export type GameAppOptions = Readonly<{
  seed?: number;
  viewRadius?: number;
  workerFactory?: WorkerFactory;
  renderer?: RendererAdapterOptions;
}>;

declare global {
  interface Window {
    game?: GameApp;
  }
}

export async function createGameApp(
  container: HTMLElement,
  options: GameAppOptions = {},
): Promise<GameApp> {
  const ownerDocument = container.ownerDocument;
  const ownerWindow = ownerDocument.defaultView;
  if (!ownerWindow) throw new Error('GameApp requires a window-backed document');

  const loading = ownerDocument.createElement('div');
  loading.dataset.testid = 'loading-world';
  loading.textContent = 'Loading world…';
  container.append(loading);

  const canvas = ownerDocument.createElement('canvas');
  canvas.setAttribute('aria-label', 'Voxel world');
  canvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;display:block;background:#8fc8ee';
  container.append(canvas);

  const world = new WorldService({
    seed: options.seed ?? DEFAULT_SEED,
    viewRadius: options.viewRadius,
    workerFactory: options.workerFactory,
  });
  let renderer: RendererAdapter;
  try {
    renderer = await createRendererWithFallback(canvas, options.renderer);
  } catch (error) {
    world.dispose();
    canvas.remove();
    loading.remove();
    throw error;
  }

  const player = new PlayerController(world, { x: 0.5, y: CAMERA_HEIGHT, z: 0.5 });
  const inventory = new Inventory();
  const interaction = new PlayerInteraction(inventory, player);
  const metrics = new FrameMetrics();
  const hud = new GameHud(ownerDocument);
  container.append(hud.element);

  const uploadedVersions = new Map<string, number>();
  let totalUploadBytes = 0;
  let frameRequest = 0;
  let stopped = false;
  let previousFrameMs: number | undefined;
  let previousPosition = player.position;
  let lastHudUpdateMs = Number.NEGATIVE_INFINITY;
  const pressedKeys = new Set<string>();

  const placeForTest = (pos: BlockPos, block: string): void => {
    const definition = blockByKey(block);
    clearInventory(inventory);
    inventory.add(definition.id, 1);

    const center = { x: pos.x + 0.5, y: pos.y + 0.5, z: pos.z + 0.5 };
    if (world.isSolid(pos) && !interaction.breakBlock(world, center, { x: 0, y: 0, z: 0 })) {
      throw new Error(`Could not break block at ${pos.x},${pos.y},${pos.z}`);
    }
    const direction = adjacentSolidDirection(world, pos);
    if (!direction || !interaction.placeBlock(world, center, direction, definition.id)) {
      throw new Error(`Could not place ${block} at ${pos.x},${pos.y},${pos.z}`);
    }

    const result = blockById(world.getBlock(pos)).key;
    let output = ownerDocument.querySelector<HTMLElement>(`[data-testid="block-at-${pos.x}-${pos.y}-${pos.z}"]`);
    if (!output) {
      output = ownerDocument.createElement('output');
      output.dataset.testid = `block-at-${pos.x}-${pos.y}-${pos.z}`;
      output.hidden = true;
      container.append(output);
    }
    output.textContent = result;
  };

  const game: GameApp = Object.freeze({ player, placeForTest });

  const onKeyDown = (event: KeyboardEvent): void => {
    pressedKeys.add(event.key.toLowerCase());
  };
  const onKeyUp = (event: KeyboardEvent): void => {
    pressedKeys.delete(event.key.toLowerCase());
  };
  ownerWindow.addEventListener('keydown', onKeyDown);
  ownerWindow.addEventListener('keyup', onKeyUp);

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    ownerWindow.cancelAnimationFrame(frameRequest);
    ownerWindow.removeEventListener('keydown', onKeyDown);
    ownerWindow.removeEventListener('keyup', onKeyUp);
    renderer.dispose();
    world.dispose();
  };
  ownerWindow.addEventListener('pagehide', stop, { once: true });

  try {
    await world.prepareSpawn({ x: 0, z: 0 });
  } catch (error) {
    stop();
    throw error;
  }

  totalUploadBytes += drainUploads(world, renderer, uploadedVersions);
  loading.remove();
  const ready = ownerDocument.createElement('div');
  ready.dataset.testid = 'world-ready';
  ready.textContent = 'World ready';
  ready.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:2;color:white;font:14px system-ui';
  container.append(ready);
  ownerDocument.documentElement.dataset.renderBackend = renderer.backend;
  ownerWindow.game = game;

  const updateFrame = (timestampMs: number): void => {
    if (stopped) return;
    const dtSeconds = previousFrameMs === undefined
      ? 0
      : Math.min(50, timestampMs - previousFrameMs) / 1_000;
    previousFrameMs = timestampMs;

    const input = inputFromKeys(pressedKeys);
    player.step(input, dtSeconds);
    const position = player.position;
    const inverseDt = dtSeconds > 0 ? 1 / dtSeconds : 0;
    const velocity = {
      x: (position.x - previousPosition.x) * inverseDt,
      z: (position.z - previousPosition.z) * inverseDt,
    };
    previousPosition = position;
    world.updateStreaming(position, velocity);
    totalUploadBytes += drainUploads(world, renderer, uploadedVersions);
    renderer.render({
      camera: { position, intersectsAabb: () => true },
      timeMs: timestampMs,
    });
    metrics.recordFrame(timestampMs);

    if (timestampMs - lastHudUpdateMs >= HUD_UPDATE_INTERVAL_MS) {
      lastHudUpdateMs = timestampMs;
      const streaming = world.streamingDiagnostics();
      hud.update({
        backend: renderer.backend,
        metrics: metrics.summary(),
        visibleSections: renderer.diagnostics().visiblePageCount,
        workerQueue: streaming.queuedWork + streaming.pendingMeshes,
        uploadBytes: totalUploadBytes,
      });
    }
    frameRequest = ownerWindow.requestAnimationFrame(updateFrame);
  };
  frameRequest = ownerWindow.requestAnimationFrame(updateFrame);

  return game;
}

async function createRendererWithFallback(
  canvas: HTMLCanvasElement,
  options: RendererAdapterOptions | undefined,
): Promise<RendererAdapter> {
  try {
    return await RendererAdapter.create(canvas, options);
  } catch (webGpuError) {
    const gpu = options?.capabilities?.gpu
      ?? (canvas.ownerDocument.defaultView?.navigator as Navigator & { gpu?: unknown } | undefined)?.gpu;
    if (!gpu) throw webGpuError;
    return RendererAdapter.create(canvas, {
      ...options,
      capabilities: { gpu: undefined },
    });
  }
}

function inputFromKeys(keys: ReadonlySet<string>): Readonly<{ x: number; z: number }> {
  return {
    x: Number(keys.has('d') || keys.has('arrowright')) - Number(keys.has('a') || keys.has('arrowleft')),
    z: Number(keys.has('s') || keys.has('arrowdown')) - Number(keys.has('w') || keys.has('arrowup')),
  };
}

function clearInventory(inventory: Inventory): void {
  let selected = inventory.selected();
  while (selected) {
    inventory.remove(selected.blockId, selected.count);
    selected = inventory.selected();
  }
}

function adjacentSolidDirection(
  world: WorldService,
  pos: BlockPos,
): Readonly<{ x: number; y: number; z: number }> | null {
  const directions = [
    { x: 1, y: 0, z: 0 },
    { x: -1, y: 0, z: 0 },
    { x: 0, y: 1, z: 0 },
    { x: 0, y: -1, z: 0 },
    { x: 0, y: 0, z: 1 },
    { x: 0, y: 0, z: -1 },
  ] as const;
  return directions.find((direction) => world.isSolid({
    x: pos.x + direction.x,
    y: pos.y + direction.y,
    z: pos.z + direction.z,
  })) ?? null;
}

function drainUploads(
  world: WorldService,
  renderer: RendererAdapter,
  uploadedVersions: Map<string, number>,
): number {
  let uploadedBytes = 0;
  for (const { x, z } of world.loadedColumns()) {
    const key = `${x},0,${z}`;
    const mesh = world.visibleMeshFor(key);
    if (!mesh || uploadedVersions.get(key) === mesh.sourceVersion) continue;
    renderer.enqueueUpload({
      key,
      editVersion: mesh.sourceVersion,
      mesh,
      estimatedUploadMs: 0,
    });
    uploadedVersions.set(key, mesh.sourceVersion);
    uploadedBytes += meshByteLength(mesh);
  }
  return uploadedBytes;
}

function meshByteLength(mesh: OpaqueMesh): number {
  return mesh.positions.byteLength
    + mesh.normals.byteLength
    + mesh.uvs.byteLength
    + mesh.materialIds.byteLength
    + mesh.indices.byteLength;
}

function showBootstrapError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const output = document.createElement('main');
  output.dataset.testid = 'renderer-error';
  output.textContent = `Unable to start game: ${message}`;
  document.body.replaceChildren(output);
}

if (
  typeof window !== 'undefined'
  && typeof document !== 'undefined'
  && (import.meta as ImportMeta & { env?: { MODE?: string } }).env?.MODE !== 'test'
) {
  void createGameApp(document.body).catch(showBootstrapError);
}
