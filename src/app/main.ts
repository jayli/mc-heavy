import { blockById, blockByKey } from '../domain/blocks';
import type { BlockPos } from '../domain/coords';
import { MESH_CHANNELS } from '../meshing/mesh-types';
import { Inventory } from '../gameplay/inventory';
import { PlayerController } from '../gameplay/player-controller';
import { PlayerInteraction } from '../gameplay/player-interaction';
import {
  RendererAdapter,
  type RendererAdapterOptions,
} from '../render/renderer-adapter';
import type { WorkerFactory } from '../workers/worker-client';
import { WorldService } from '../world/world-service';
import { FrameMetrics } from '../benchmark/frame-metrics';
import { GameHud } from './hud';
import { movementInputFromKeys } from './input';
import {
  BYTES_PER_UPLOAD_MILLISECOND,
  meshByteLength,
  RenderUploadQueue,
  type RenderUploadDrain,
  type UploadSink,
} from './render-upload-queue';
import type { ChannelUploadJob } from '../render/render-page';
import { channelUploadKey } from '../render/render-page';
import { buildTextureAtlas } from '../render/texture-atlas';
import { createTerrainMaterials } from '../render/materials';

const DEFAULT_SEED = 0x5eed_1234;
const CAMERA_HEIGHT = 50;
const HUD_UPDATE_INTERVAL_MS = 250;
const RENDER_UPLOAD_BUDGET_MS = 2;
const MINIMUM_UPLOAD_COST_MS = 1;

export type GameApp = Readonly<{
  player: PlayerController;
  seed: number;
  placeForTest(pos: BlockPos, block: string): void;
  readBlockForTest(pos: BlockPos): string;
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
  const seed = options.seed ?? DEFAULT_SEED;
  const builtAtlas = await buildTextureAtlas();
  const terrainMaterials = createTerrainMaterials(builtAtlas);
  let renderer: RendererAdapter;
  try {
    renderer = await createRendererWithFallback(canvas, options.renderer, terrainMaterials);
  } catch (error) {
    terrainMaterials.dispose();
    world.dispose();
    canvas.remove();
    loading.remove();
    throw error;
  }

  const player = new PlayerController(world, { x: 0.5, y: CAMERA_HEIGHT, z: 0.5 });
  const inventory = new Inventory();
  // A stack above one keeps the five fixed hotbar slots stable while playing.
  inventory.add(1, 64);
  inventory.add(2, 64);
  inventory.add(4, 64);
  inventory.add(5, 64);
  inventory.add(7, 64);
  const interaction = new PlayerInteraction(inventory, player);
  const metrics = new FrameMetrics();
  const hud = new GameHud(ownerDocument);
  container.append(hud.element);

  const crosshair = ownerDocument.createElement('div');
  crosshair.dataset.testid = 'crosshair';
  crosshair.style.cssText = [
    'position:fixed',
    'left:50%',
    'top:50%',
    'width:6px',
    'height:6px',
    'transform:translate(-50%,-50%)',
    'border:1px solid rgba(255,255,255,.85)',
    'border-radius:50%',
    'z-index:2',
    'pointer-events:none',
  ].join(';');
  container.append(crosshair);

  const pointerLockHint = ownerDocument.createElement('div');
  pointerLockHint.dataset.testid = 'pointer-lock-hint';
  pointerLockHint.textContent = 'Click to play';
  pointerLockHint.style.cssText = [
    'position:fixed',
    'inset:0',
    'display:flex',
    'align-items:center',
    'justify-content:center',
    'z-index:3',
    'background:rgba(8,12,18,.55)',
    'color:#fff',
    'font:18px system-ui',
    'pointer-events:none',
  ].join(';');
  container.append(pointerLockHint);

  const hotbar = ownerDocument.createElement('div');
  hotbar.dataset.testid = 'hotbar';
  hotbar.style.cssText = [
    'position:fixed',
    'left:50%',
    'bottom:16px',
    'transform:translateX(-50%)',
    'display:flex',
    'gap:4px',
    'z-index:2',
  ].join(';');
  container.append(hotbar);

  const uploadedVersions = new Map<string, number>();
  const uploadQueue = new RenderUploadQueue();
  let totalUploadBytes = 0;
  let frameRequest = 0;
  let stopped = false;
  let previousFrameMs: number | undefined;
  let previousPosition = player.position;
  let lastHudUpdateMs = Number.NEGATIVE_INFINITY;
  let inputActive = false;
  const pressedKeys = new Set<string>();

  const updateHotbar = (): void => {
    const selectedBlockId = inventory.selected()?.blockId ?? null;
    const cells = inventory.slots().map((slot, index) => {
      const cell = ownerDocument.createElement('div');
      cell.dataset.testid = `hotbar-slot-${index + 1}`;
      cell.dataset.selected = String(slot.blockId === selectedBlockId);
      cell.textContent = blockById(slot.blockId).key;
      cell.style.cssText = [
        'min-width:44px',
        'padding:6px 10px',
        'border:1px solid rgba(255,255,255,.4)',
        'border-radius:4px',
        'background:rgba(8,12,18,.7)',
        'color:#fff',
        'font:12px system-ui',
        'text-align:center',
      ].join(';');
      return cell;
    });
    hotbar.replaceChildren(...cells);
  };
  updateHotbar();

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
    updateHotbar();
  };

  const readBlockForTest = (pos: BlockPos): string => blockById(world.getBlock(pos)).key;

  const game: GameApp = Object.freeze({ player, seed, placeForTest, readBlockForTest });

  const onKeyDown = (event: KeyboardEvent): void => {
    pressedKeys.add(event.key.toLowerCase());
    if (event.code.startsWith('Digit')) {
      const slot = Number(event.code.slice('Digit'.length));
      if (slot >= 1 && slot <= 9 && inventory.selectSlot(slot - 1)) updateHotbar();
    }
  };
  const onKeyUp = (event: KeyboardEvent): void => {
    pressedKeys.delete(event.key.toLowerCase());
  };
  const onMouseMove = (event: MouseEvent): void => {
    if (!inputActive) return;
    player.turn(event.movementX, event.movementY);
  };
  const onMouseDown = (event: MouseEvent): void => {
    if (!inputActive) return;
    if (event.button === 0) {
      interaction.breakBlock(world, player.position, player.viewDirection);
      updateHotbar();
    } else if (event.button === 2) {
      const selected = inventory.selected();
      if (selected) {
        interaction.placeBlock(world, player.position, player.viewDirection, selected.blockId);
        updateHotbar();
      }
    }
  };
  const onWheel = (event: WheelEvent): void => {
    if (!inputActive) return;
    if (event.deltaY > 0) inventory.selectNext();
    else if (event.deltaY < 0) inventory.selectPrevious();
    updateHotbar();
  };
  const onContextMenu = (event: MouseEvent): void => {
    if (!inputActive) return;
    event.preventDefault();
  };
  const onCanvasClick = (event: MouseEvent): void => {
    if (event.button !== 0) return;
    inputActive = true;
    try {
      const lockRequest = canvas.requestPointerLock?.();
      if (lockRequest && typeof (lockRequest as PromiseLike<unknown>).then === 'function') {
        (lockRequest as Promise<unknown>).catch(() => undefined);
      }
    } catch {
      // Pointer lock is best-effort; input still works through the active flag.
    }
  };
  const onPointerLockChange = (): void => {
    pointerLockHint.hidden = ownerDocument.pointerLockElement === canvas;
  };
  ownerWindow.addEventListener('keydown', onKeyDown);
  ownerWindow.addEventListener('keyup', onKeyUp);
  ownerWindow.addEventListener('mousemove', onMouseMove);
  ownerWindow.addEventListener('wheel', onWheel);
  ownerWindow.addEventListener('pointerlockchange', onPointerLockChange);
  canvas.addEventListener('mousedown', onMouseDown);
  canvas.addEventListener('contextmenu', onContextMenu);
  canvas.addEventListener('click', onCanvasClick);

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    ownerWindow.cancelAnimationFrame(frameRequest);
    ownerWindow.removeEventListener('keydown', onKeyDown);
    ownerWindow.removeEventListener('keyup', onKeyUp);
    ownerWindow.removeEventListener('mousemove', onMouseMove);
    ownerWindow.removeEventListener('wheel', onWheel);
    ownerWindow.removeEventListener('pointerlockchange', onPointerLockChange);
    canvas.removeEventListener('mousedown', onMouseDown);
    canvas.removeEventListener('contextmenu', onContextMenu);
    canvas.removeEventListener('click', onCanvasClick);
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

  totalUploadBytes += updateRenderUploads(
    world,
    renderer,
    uploadQueue,
    uploadedVersions,
    RENDER_UPLOAD_BUDGET_MS,
  ).uploadedBytes;
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

    const input = movementInputFromKeys(pressedKeys, player.yaw);
    player.step(input, dtSeconds);
    const position = player.position;
    const inverseDt = dtSeconds > 0 ? 1 / dtSeconds : 0;
    const velocity = {
      x: (position.x - previousPosition.x) * inverseDt,
      z: (position.z - previousPosition.z) * inverseDt,
    };
    previousPosition = position;
    world.updateStreaming(position, velocity);
    totalUploadBytes += updateRenderUploads(
      world,
      renderer,
      uploadQueue,
      uploadedVersions,
      RENDER_UPLOAD_BUDGET_MS,
    ).uploadedBytes;
    renderer.render({
      camera: {
        position,
        direction: player.viewDirection,
        aspect: canvas.clientHeight > 0 ? canvas.clientWidth / canvas.clientHeight : 1,
      },
      timeMs: timestampMs,
    });
    metrics.recordFrame(timestampMs);

    if (timestampMs - lastHudUpdateMs >= HUD_UPDATE_INTERVAL_MS) {
      lastHudUpdateMs = timestampMs;
      updateHotbar();
      const streaming = world.streamingDiagnostics();
      const rendering = renderer.diagnostics();
      hud.update({
        backend: renderer.backend,
        metrics: metrics.summary(),
        renderPages: rendering.pageCount,
        visibleSections: rendering.visiblePageCount,
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
  materials: ReturnType<typeof createTerrainMaterials>,
): Promise<RendererAdapter> {
  try {
    return await RendererAdapter.create(canvas, options, materials);
  } catch (webGpuError) {
    const gpu = options?.capabilities?.gpu
      ?? (canvas.ownerDocument.defaultView?.navigator as Navigator & { gpu?: unknown } | undefined)?.gpu;
    if (!gpu) throw webGpuError;
    return RendererAdapter.create(canvas, {
      ...options,
      capabilities: { gpu: undefined },
    }, materials);
  }
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

function updateRenderUploads(
  world: WorldService,
  renderer: RendererAdapter,
  uploadQueue: RenderUploadQueue,
  uploadedVersions: Map<string, number>,
  budgetMs: number,
): RenderUploadDrain {
  const loadedKeys = new Set(world.loadedSectionKeys());
  renderer.retainPages(loadedKeys);
  const channelKeys = new Set<string>();
  for (const key of loadedKeys) {
    for (const channel of MESH_CHANNELS) channelKeys.add(channelUploadKey(key, channel));
  }
  uploadQueue.retain(channelKeys);
  for (const key of uploadedVersions.keys()) {
    if (!channelKeys.has(key)) uploadedVersions.delete(key);
  }

  const sink: UploadSink = {
    stage: (job, maxBytes) => renderer.stageUpload(job, maxBytes),
    commit: (job) => {
      renderer.commitUpload(job);
      uploadedVersions.set(job.key, job.editVersion);
    },
  };

  for (const key of world.loadedSectionKeys()) {
    const section = world.visibleMeshFor(key);
    if (!section) continue;
    let hasContent = false;
    for (const channel of MESH_CHANNELS) {
      const mesh = section[channel];
      const jobKey = channelUploadKey(key, channel);
      if (mesh.indices.length === 0) {
        if (uploadedVersions.has(jobKey)) {
          renderer.removeChannel(key, channel);
          uploadedVersions.delete(jobKey);
        }
        continue;
      }
      hasContent = true;
      if (uploadedVersions.get(jobKey) === mesh.sourceVersion) continue;
      const job: ChannelUploadJob = {
        key: jobKey,
        sectionKey: key,
        channel,
        editVersion: mesh.sourceVersion,
        mesh,
        estimatedUploadMs: Math.max(
          MINIMUM_UPLOAD_COST_MS,
          meshByteLength(mesh) / BYTES_PER_UPLOAD_MILLISECOND,
        ),
      };
      uploadQueue.enqueue(job);
    }
    if (!hasContent) {
      renderer.removePage(key);
      for (const channel of MESH_CHANNELS) uploadedVersions.delete(channelUploadKey(key, channel));
    }
  }
  return uploadQueue.drain(budgetMs, sink);
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
