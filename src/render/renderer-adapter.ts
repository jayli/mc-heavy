import {
  Camera,
  PerspectiveCamera,
  Scene,
  WebGLRenderer,
  type Mesh,
} from 'three';
import { WebGLNodesHandler } from 'three/addons/tsl/WebGLNodesHandler.js';
import type { UploadJob } from '../workers/protocol';
import { detectRenderBackend } from './backend';
import { RenderPage, type CameraFrustum, type RenderPageTarget } from './render-page';
import { TerrainLod } from './terrain-lod';
import { WaterSurface } from './water';

export type RenderFrame = Readonly<{
  camera: CameraFrustum;
  timeMs: number;
}>;

export type RendererDriver = Readonly<{
  backend: 'webgpu' | 'webgl2';
  render(scene: Scene, camera: Camera): void;
  dispose(): void;
}>;

export type RendererFactory = Readonly<{
  createWebGPU(canvas: HTMLCanvasElement): Promise<RendererDriver>;
  createWebGL2(canvas: HTMLCanvasElement, context: WebGL2RenderingContext): RendererDriver;
}>;

export type RendererAdapterOptions = Readonly<{
  capabilities?: Readonly<{ gpu?: unknown }>;
  rendererFactory?: RendererFactory;
}>;

const productionRendererFactory: RendererFactory = {
  async createWebGPU(canvas) {
    const { WebGPURenderer } = await import('three/webgpu');
    const renderer = new WebGPURenderer({ canvas });
    await renderer.init();
    const backend = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend
      ? 'webgpu'
      : 'webgl2';
    return {
      backend,
      render: (scene, camera) => renderer.render(scene, camera),
      dispose: () => renderer.dispose(),
    };
  },
  createWebGL2(canvas, context) {
    const renderer = new WebGLRenderer({ canvas, context });
    const nodesHandler = new WebGLNodesHandler();
    nodesHandler.setRenderer(renderer);
    renderer.setNodesHandler(nodesHandler);
    return {
      backend: 'webgl2',
      render: (scene, camera) => renderer.render(scene, camera),
      dispose: () => renderer.dispose(),
    };
  },
};

function browserGpu(): unknown {
  if (typeof navigator === 'undefined') return undefined;
  return (navigator as Navigator & { gpu?: unknown }).gpu;
}

export class RendererAdapter {
  readonly backend: 'webgpu' | 'webgl2';
  private readonly driver: RendererDriver;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(70, 1, 0.1, 4_096);
  private readonly pages = new Map<string, RenderPage>();
  private readonly objects = new Map<string, Mesh>();
  private readonly terrainLod = new TerrainLod();
  private readonly water = new WaterSurface();
  private visiblePageCount = 0;
  private disposed = false;

  private constructor(driver: RendererDriver) {
    this.backend = driver.backend;
    this.driver = driver;
    this.scene.add(this.terrainLod.renderObject(), this.water.renderObject());
  }

  static async create(canvas: HTMLCanvasElement, options: RendererAdapterOptions = {}): Promise<RendererAdapter> {
    let webgl2Context: WebGL2RenderingContext | null = null;
    const gpu = options.capabilities === undefined ? browserGpu() : options.capabilities.gpu;
    const backend = detectRenderBackend({
      gpu,
      createWebGL2Context: () => {
        webgl2Context = canvas.getContext('webgl2');
        return webgl2Context;
      },
    });
    const factory = options.rendererFactory ?? productionRendererFactory;
    if (backend === 'webgpu') {
      const driver = await factory.createWebGPU(canvas);
      return new RendererAdapter(driver);
    }
    if (backend === 'webgl2' && webgl2Context) {
      return new RendererAdapter(factory.createWebGL2(canvas, webgl2Context));
    }
    throw new Error('Renderer initialization failed: Neither WebGPU nor WebGL2 is available');
  }

  enqueueUpload(job: UploadJob): void {
    if (this.disposed) return;
    let page = this.pages.get(job.key);
    if (!page) {
      const target: RenderPageTarget = {
        swap: (previous, next) => this.swapObject(job.key, previous, next),
      };
      page = new RenderPage(job.key, undefined, target);
      this.pages.set(job.key, page);
    }
    page.replace(job.mesh);
  }

  render(frame: RenderFrame): void {
    if (this.disposed) return;
    const cameraPosition = frame.camera.position ?? this.camera.position;
    this.camera.position.copy(cameraPosition);
    this.camera.updateMatrixWorld();
    this.terrainLod.update(cameraPosition);
    this.water.update(cameraPosition, frame.timeMs);
    let visible = 0;
    for (const [key, page] of this.pages) {
      const object = this.objects.get(key);
      if (!object) continue;
      object.visible = page.isVisible(frame.camera);
      if (object.visible) visible += 1;
    }
    this.visiblePageCount = visible;
    this.driver.render(this.scene, this.camera);
  }

  diagnostics(): Readonly<{ pageCount: number; visiblePageCount: number }> {
    return { pageCount: this.pages.size, visiblePageCount: this.visiblePageCount };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const page of this.pages.values()) page.dispose();
    this.terrainLod.dispose();
    this.water.dispose();
    this.scene.clear();
    this.pages.clear();
    this.objects.clear();
    this.driver.dispose();
  }

  private swapObject(key: string, previous: Mesh | null, next: Mesh | null): void {
    if (next) {
      this.scene.add(next);
      this.objects.set(key, next);
    } else {
      this.objects.delete(key);
    }
    if (previous) this.scene.remove(previous);
  }
}
