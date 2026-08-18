import { describe, expect, it } from 'vitest';
import { Group, Mesh, type Scene } from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import type { ChannelMesh } from '../../../src/meshing/mesh-types';
import type { TerrainMaterials } from '../../../src/render/materials';
import {
  RendererAdapter,
  type RendererDriver,
  type RendererFactory,
} from '../../../src/render/renderer-adapter';

const mesh: ChannelMesh = {
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  normals: new Int8Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
  uvs: new Float32Array([0, 0, 1, 0, 0, 1]),
  tileIds: new Uint16Array([1, 1, 1]),
  ao: new Uint8Array([3, 3, 3]),
  indices: new Uint32Array([0, 1, 2]),
  sourceVersion: 1,
};

function fakeMaterials(): TerrainMaterials {
  return {
    opaque: new MeshBasicNodeMaterial(),
    cutout: new MeshBasicNodeMaterial(),
    translucent: new MeshBasicNodeMaterial(),
    dispose() {
      this.opaque.dispose();
      this.cutout.dispose();
      this.translucent.dispose();
    },
  };
}

function canvasWithWebGL2Only(context: WebGL2RenderingContext | null): HTMLCanvasElement {
  return {
    getContext(type: string) {
      return type === 'webgl2' ? context : null;
    },
  } as HTMLCanvasElement;
}

describe('RendererAdapter fallback', () => {
  it('selects WebGL2 from a WebGL2-only canvas and skips frustum-excluded pages', async () => {
    const context = {} as WebGL2RenderingContext;
    const visiblePageCounts: number[] = [];
    let submittedScene: Scene | null = null;
    const driver: RendererDriver = {
      backend: 'webgl2',
      render(scene) {
        submittedScene = scene;
        visiblePageCounts.push(scene.children.filter(
          (child) => child.visible && child.name.startsWith('section:'),
        ).length);
      },
      setPixelRatio() {},
      dispose() {},
    };
    const factory: RendererFactory = {
      async createWebGPU() {
        throw new Error('WebGPU factory must not be selected');
      },
      createWebGL2(receivedCanvas, receivedContext) {
        expect(receivedCanvas).toBe(canvas);
        expect(receivedContext).toBe(context);
        return driver;
      },
    };
    const canvas = canvasWithWebGL2Only(context);
    const materials = fakeMaterials();
    const adapter = await RendererAdapter.create(canvas, {
      capabilities: { gpu: undefined },
      rendererFactory: factory,
    }, materials);
    adapter.enqueueUpload({ key: '0,0,0#opaque', sectionKey: '0,0,0', channel: 'opaque', editVersion: 1, mesh, estimatedUploadMs: 0 });
    adapter.enqueueUpload({ key: '20,0,0#opaque', sectionKey: '20,0,0', channel: 'opaque', editVersion: 1, mesh, estimatedUploadMs: 0 });

    adapter.render({
      camera: {
        intersectsAabb: (bounds) => bounds.min.x < 100,
        position: { x: 64, y: 40, z: -32 },
      },
      timeMs: 1_500,
    });

    expect(adapter.backend).toBe('webgl2');
    expect(adapter.diagnostics()).toEqual({
      pageCount: 2,
      visiblePageCount: 1,
      translucentTriangles: 0,
      background: '#8fc8ee',
    });
    expect(visiblePageCounts).toEqual([1]);
    const scene = submittedScene as Scene | null;
    expect(scene?.getObjectByName('terrain-lod')?.position.toArray()).toEqual([64, 0, -32]);
    expect(scene?.getObjectByName('water-surface')?.position.toArray()).toEqual([64, 0, -32]);
    expect(scene?.getObjectByName('water-surface')?.userData.timeMs).toBe(1_500);

    const section = scene?.getObjectByName('section:0,0,0') as Group | undefined;
    const sectionMesh = section?.children.find((child) => child.name.endsWith(':opaque')) as Mesh | undefined;
    expect(sectionMesh?.material).toBe(materials.opaque);
    let geometryDisposals = 0;
    sectionMesh?.geometry.addEventListener('dispose', () => { geometryDisposals += 1; });

    adapter.dispose();
    adapter.dispose();

    expect(geometryDisposals).toBe(1);
    materials.dispose();
  });

  it('reports the backend returned by asynchronous WebGPU initialization', async () => {
    const driver: RendererDriver = { backend: 'webgl2', render() {}, setPixelRatio() {}, dispose() {} };
    const factory: RendererFactory = {
      async createWebGPU() {
        return driver;
      },
      createWebGL2() {
        throw new Error('canvas fallback must not be selected before WebGPU initialization');
      },
    };

    const adapter = await RendererAdapter.create(canvasWithWebGL2Only(null), {
      capabilities: { gpu: {} },
      rendererFactory: factory,
    }, fakeMaterials());

    expect(adapter.backend).toBe('webgl2');
    adapter.dispose();
  });

  it('derives section visibility from the real camera frustum', async () => {
    const visiblePageCounts: number[] = [];
    const driver: RendererDriver = {
      backend: 'webgl2',
      render(scene) {
        visiblePageCounts.push(scene.children.filter(
          (child) => child.visible && child.name.startsWith('section:'),
        ).length);
      },
      setPixelRatio() {},
      dispose() {},
    };
    const adapter = await RendererAdapter.create(canvasWithWebGL2Only({} as WebGL2RenderingContext), {
      capabilities: { gpu: undefined },
      rendererFactory: {
        async createWebGPU() { throw new Error('unexpected WebGPU'); },
        createWebGL2() { return driver; },
      },
    }, fakeMaterials());
    adapter.enqueueUpload({ key: '0,0,-2#opaque', sectionKey: '0,0,-2', channel: 'opaque', editVersion: 1, mesh, estimatedUploadMs: 1 });
    adapter.enqueueUpload({ key: '0,0,1#opaque', sectionKey: '0,0,1', channel: 'opaque', editVersion: 1, mesh, estimatedUploadMs: 1 });

    adapter.render({
      camera: {
        position: { x: 8, y: 8, z: 8 },
        direction: { x: 0, y: 0, z: -1 },
        aspect: 1,
      },
      timeMs: 0,
    });

    expect(adapter.diagnostics()).toEqual({
      pageCount: 2,
      visiblePageCount: 1,
      translucentTriangles: 0,
      background: '#8fc8ee',
    });
    expect(visiblePageCounts).toEqual([1]);
    adapter.dispose();
  });

  it('disposes pages that leave the retained loaded-key set', async () => {
    let submittedScene: Scene | undefined;
    const driver: RendererDriver = {
      backend: 'webgl2',
      render(scene) { submittedScene = scene; },
      setPixelRatio() {},
      dispose() {},
    };
    const adapter = await RendererAdapter.create(canvasWithWebGL2Only({} as WebGL2RenderingContext), {
      capabilities: { gpu: undefined },
      rendererFactory: {
        async createWebGPU() { throw new Error('unexpected WebGPU'); },
        createWebGL2() { return driver; },
      },
    }, fakeMaterials());
    adapter.enqueueUpload({ key: '0,0,0#opaque', sectionKey: '0,0,0', channel: 'opaque', editVersion: 1, mesh, estimatedUploadMs: 1 });
    adapter.enqueueUpload({ key: '1,0,0#opaque', sectionKey: '1,0,0', channel: 'opaque', editVersion: 1, mesh, estimatedUploadMs: 1 });
    adapter.render({
      camera: { intersectsAabb: () => true, position: { x: 0, y: 0, z: 0 } },
      timeMs: 0,
    });
    const evicted = submittedScene?.getObjectByName('section:1,0,0') as Group | undefined;
    const evictedMesh = evicted?.children.find((child) => child.name.endsWith(':opaque')) as Mesh | undefined;
    let geometryDisposals = 0;
    evictedMesh?.geometry.addEventListener('dispose', () => { geometryDisposals += 1; });

    adapter.retainPages(new Set(['0,0,0']));

    expect(adapter.diagnostics()).toEqual({
      pageCount: 1,
      visiblePageCount: 1,
      translucentTriangles: 0,
      background: '#8fc8ee',
    });
    expect(submittedScene?.getObjectByName('section:1,0,0')).toBeUndefined();
    expect(geometryDisposals).toBe(1);
    adapter.dispose();
  });

  it('rejects clearly when neither WebGPU nor WebGL2 is available', async () => {
    const canvas = canvasWithWebGL2Only(null);

    await expect(RendererAdapter.create(canvas, {
      capabilities: { gpu: undefined },
    }, fakeMaterials())).rejects.toThrow('Neither WebGPU nor WebGL2 is available');
  });
});
