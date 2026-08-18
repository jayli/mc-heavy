import {
  Box3,
  Camera,
  Color,
  Frustum,
  Group,
  Matrix4,
  PerspectiveCamera,
  Scene,
  Vector3,
  WebGLRenderer,
} from 'three';
import { WebGLNodesHandler } from 'three/addons/tsl/WebGLNodesHandler.js';
import { detectRenderBackend } from './backend';
import {
  RenderPage,
  RenderStaging,
  type CameraFrustum,
  type ChannelUploadJob,
  type RenderPageTarget,
} from './render-page';
import { TerrainLod } from './terrain-lod';
import { WaterSurface } from './water';
import type { TerrainMaterials } from './materials';

export type RenderCamera = Readonly<{
  position: Readonly<{ x: number; y: number; z: number }>;
  direction: Readonly<{ x: number; y: number; z: number }>;
  aspect: number;
}>;

export type RenderFrame = Readonly<{
  camera: CameraFrustum | RenderCamera;
  timeMs: number;
}>;

export type RendererDriver = Readonly<{
  backend: 'webgpu' | 'webgl2';
  render(scene: Scene, camera: Camera): void;
  setPixelRatio(scale: number): void;
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
      setPixelRatio: (scale) => {
        renderer.setPixelRatio(scale);
        renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
      },
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
      setPixelRatio: (scale) => {
        renderer.setPixelRatio(scale);
        renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
      },
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
  private readonly viewProjection = new Matrix4();
  private readonly viewFrustum = new Frustum();
  private readonly visibilityBox = new Box3();
  private readonly lookTarget = new Vector3();
  private readonly physicalCameraFrustum: CameraFrustum = {
    intersectsAabb: (bounds) => {
      this.visibilityBox.min.set(bounds.min.x, bounds.min.y, bounds.min.z);
      this.visibilityBox.max.set(bounds.max.x, bounds.max.y, bounds.max.z);
      return this.viewFrustum.intersectsBox(this.visibilityBox);
    },
  };
  private readonly pages = new Map<string, RenderPage>();
  private readonly stagings = new Map<string, RenderStaging>();
  private readonly objects = new Map<string, Group>();
  private readonly terrainLod = new TerrainLod();
  private readonly water = new WaterSurface();
  private readonly effects = new Group();
  private readonly materials: TerrainMaterials;
  private visiblePageCount = 0;
  private disposed = false;

  private constructor(driver: RendererDriver, materials: TerrainMaterials) {
    this.backend = driver.backend;
    this.driver = driver;
    this.materials = materials;
    this.scene.background = new Color(0x8fc8ee);
    this.effects.name = 'effects';
    this.scene.add(this.terrainLod.renderObject(), this.water.renderObject(), this.effects);
  }

  static async create(
    canvas: HTMLCanvasElement,
    options: RendererAdapterOptions = {},
    materials: TerrainMaterials,
  ): Promise<RendererAdapter> {
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
      return new RendererAdapter(driver, materials);
    }
    if (backend === 'webgl2' && webgl2Context) {
      return new RendererAdapter(factory.createWebGL2(canvas, webgl2Context), materials);
    }
    throw new Error('Renderer initialization failed: Neither WebGPU nor WebGL2 is available');
  }

  enqueueUpload(job: ChannelUploadJob): void {
    if (this.disposed) return;
    this.pageFor(job.sectionKey).replace(job.channel, job.mesh);
  }

  stageUpload(job: ChannelUploadJob, maxBytes: number): number {
    if (this.disposed || maxBytes <= 0) return 0;
    let staging: RenderStaging | null = this.stagings.get(job.key) ?? null;
    if (!staging || staging.sourceVersion !== job.mesh.sourceVersion) {
      staging?.cancel();
      this.stagings.delete(job.key);
      staging = this.pageFor(job.sectionKey).beginStaging(job.channel, job.mesh);
      if (!staging) return 0;
      this.stagings.set(job.key, staging);
    }
    return staging.stage(maxBytes);
  }

  commitUpload(job: ChannelUploadJob): void {
    if (this.disposed) return;
    const staging = this.stagings.get(job.key);
    if (!staging || staging.sourceVersion !== job.mesh.sourceVersion) return;
    staging.commit();
    this.stagings.delete(job.key);
  }

  removeChannel(sectionKey: string, channel: ChannelUploadJob['channel']): void {
    if (this.disposed) return;
    this.pages.get(sectionKey)?.removeChannel(channel);
  }

  cancelUpload(key: string): void {
    const staging = this.stagings.get(key);
    if (!staging) return;
    staging.cancel();
    this.stagings.delete(key);
  }

  removePage(key: string): void {
    if (this.disposed) return;
    const page = this.pages.get(key);
    if (!page) return;
    for (const stagingKey of [...this.stagings.keys()]) {
      if (stagingKey.startsWith(`${key}#`)) this.cancelUpload(stagingKey);
    }
    page.dispose();
    this.pages.delete(key);
  }

  retainPages(keys: ReadonlySet<string>): void {
    if (this.disposed) return;
    for (const [key, page] of this.pages) {
      if (keys.has(key)) continue;
      for (const stagingKey of [...this.stagings.keys()]) {
        if (stagingKey.startsWith(`${key}#`)) this.cancelUpload(stagingKey);
      }
      page.dispose();
      this.pages.delete(key);
    }
    this.visiblePageCount = [...this.objects.values()].filter((object) => object.visible).length;
  }

  setPixelRatio(scale: number): void {
    if (this.disposed) return;
    this.driver.setPixelRatio(scale);
  }

  addTransient(object: Parameters<Group['add']>[0]): void {
    if (this.disposed) return;
    this.effects.add(object);
  }

  removeTransient(object: Parameters<Group['remove']>[0]): void {
    if (this.disposed) return;
    this.effects.remove(object);
  }

  render(frame: RenderFrame): void {
    if (this.disposed) return;
    const cameraPosition = frame.camera.position ?? this.camera.position;
    this.camera.position.copy(cameraPosition);
    const pageFrustum = isPhysicalCamera(frame.camera)
      ? this.updatePhysicalCamera(frame.camera)
      : frame.camera;
    this.camera.updateMatrixWorld();
    this.terrainLod.update(cameraPosition);
    this.water.update(cameraPosition, frame.timeMs);
    let visible = 0;
    for (const [key, page] of this.pages) {
      const object = this.objects.get(key);
      const pageVisible = page.isVisible(pageFrustum);
      if (object) object.visible = pageVisible;
      if (pageVisible) visible += 1;
    }
    this.visiblePageCount = visible;
    this.driver.render(this.scene, this.camera);
  }

  private updatePhysicalCamera(camera: RenderCamera): CameraFrustum {
    const aspect = Number.isFinite(camera.aspect) && camera.aspect > 0 ? camera.aspect : 1;
    if (this.camera.aspect !== aspect) {
      this.camera.aspect = aspect;
      this.camera.updateProjectionMatrix();
    }
    this.lookTarget.set(
      camera.position.x + camera.direction.x,
      camera.position.y + camera.direction.y,
      camera.position.z + camera.direction.z,
    );
    this.camera.lookAt(this.lookTarget);
    this.camera.updateMatrixWorld();
    this.viewProjection.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
    this.viewFrustum.setFromProjectionMatrix(this.viewProjection);
    return this.physicalCameraFrustum;
  }

  diagnostics(): Readonly<{
    pageCount: number;
    visiblePageCount: number;
    translucentTriangles: number;
    background: string | null;
  }> {
    let translucentTriangles = 0;
    for (const page of this.pages.values()) {
      translucentTriangles += page.channelIndexCount('translucent') / 3;
    }
    const background = this.scene.background instanceof Color
      ? `#${this.scene.background.getHexString()}`
      : null;
    return {
      pageCount: this.pages.size,
      visiblePageCount: this.visiblePageCount,
      translucentTriangles,
      background,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const page of this.pages.values()) page.dispose();
    this.terrainLod.dispose();
    this.water.dispose();
    this.scene.clear();
    this.pages.clear();
    this.stagings.clear();
    this.objects.clear();
    this.driver.dispose();
  }

  private swapObject(key: string, previous: Group | null, next: Group | null): void {
    if (next) {
      this.scene.add(next);
      this.objects.set(key, next);
    } else {
      this.objects.delete(key);
    }
    if (previous) this.scene.remove(previous);
  }

  private pageFor(key: string): RenderPage {
    let page = this.pages.get(key);
    if (!page) {
      const target: RenderPageTarget = {
        swap: (previous, next) => this.swapObject(key, previous, next),
      };
      page = new RenderPage(key, this.materials, undefined, target);
      this.pages.set(key, page);
    }
    return page;
  }
}

function isPhysicalCamera(camera: CameraFrustum | RenderCamera): camera is RenderCamera {
  return !('intersectsAabb' in camera);
}
