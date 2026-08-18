import { describe, expect, it } from 'vitest';
import type { DataTexture, Material, Mesh, Scene } from 'three';
import type { ChannelMesh } from '../../../src/meshing/mesh-types';
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
    const adapter = await RendererAdapter.create(canvas, {
      capabilities: { gpu: undefined },
      rendererFactory: factory,
    });
    adapter.enqueueUpload({ key: '0,0,0', sectionKey: '0,0,0', channel: 'opaque', editVersion: 1, mesh, estimatedUploadMs: 0 });
    adapter.enqueueUpload({ key: '20,0,0', sectionKey: '20,0,0', channel: 'opaque', editVersion: 1, mesh, estimatedUploadMs: 0 });

    adapter.render({
      camera: {
        intersectsAabb: (bounds) => bounds.min.x < 100,
        position: { x: 64, y: 40, z: -32 },
      },
      timeMs: 1_500,
    });

    expect(adapter.backend).toBe('webgl2');
    expect(adapter.diagnostics()).toEqual({ pageCount: 2, visiblePageCount: 1 });
    expect(visiblePageCounts).toEqual([1]);
    const scene = submittedScene as Scene | null;
    expect(scene?.getObjectByName('terrain-lod')?.position.toArray()).toEqual([64, 0, -32]);
    expect(scene?.getObjectByName('water-surface')?.position.toArray()).toEqual([64, 0, -32]);
    expect(scene?.getObjectByName('water-surface')?.userData.timeMs).toBe(1_500);

    const section = scene?.getObjectByName('section:0,0,0') as Mesh | undefined;
    const material = section?.material as Material | undefined;
    const atlas = material?.userData.blockAtlas as DataTexture | undefined;
    let geometryDisposals = 0;
    let materialDisposals = 0;
    let atlasDisposals = 0;
    section?.geometry.addEventListener('dispose', () => { geometryDisposals += 1; });
    material?.addEventListener('dispose', () => { materialDisposals += 1; });
    atlas?.addEventListener('dispose', () => { atlasDisposals += 1; });

    adapter.dispose();
    adapter.dispose();

    expect(geometryDisposals).toBe(1);
    expect(materialDisposals).toBe(1);
    expect(atlasDisposals).toBe(1);
  });

  it('reports the backend returned by asynchronous WebGPU initialization', async () => {
    const driver: RendererDriver = { backend: 'webgl2', render() {}, dispose() {} };
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
    });

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
      dispose() {},
    };
    const adapter = await RendererAdapter.create(canvasWithWebGL2Only({} as WebGL2RenderingContext), {
      capabilities: { gpu: undefined },
      rendererFactory: {
        async createWebGPU() { throw new Error('unexpected WebGPU'); },
        createWebGL2() { return driver; },
      },
    });
    adapter.enqueueUpload({ key: '0,0,-2', sectionKey: '0,0,-2', channel: 'opaque', editVersion: 1, mesh, estimatedUploadMs: 1 });
    adapter.enqueueUpload({ key: '0,0,1', sectionKey: '0,0,1', channel: 'opaque', editVersion: 1, mesh, estimatedUploadMs: 1 });

    adapter.render({
      camera: {
        position: { x: 8, y: 8, z: 8 },
        direction: { x: 0, y: 0, z: -1 },
        aspect: 1,
      },
      timeMs: 0,
    });

    expect(adapter.diagnostics()).toEqual({ pageCount: 2, visiblePageCount: 1 });
    expect(visiblePageCounts).toEqual([1]);
    adapter.dispose();
  });

  it('disposes pages that leave the retained loaded-key set', async () => {
    let submittedScene: Scene | undefined;
    const driver: RendererDriver = {
      backend: 'webgl2',
      render(scene) { submittedScene = scene; },
      dispose() {},
    };
    const adapter = await RendererAdapter.create(canvasWithWebGL2Only({} as WebGL2RenderingContext), {
      capabilities: { gpu: undefined },
      rendererFactory: {
        async createWebGPU() { throw new Error('unexpected WebGPU'); },
        createWebGL2() { return driver; },
      },
    });
    adapter.enqueueUpload({ key: '0,0,0', sectionKey: '0,0,0', channel: 'opaque', editVersion: 1, mesh, estimatedUploadMs: 1 });
    adapter.enqueueUpload({ key: '1,0,0', sectionKey: '1,0,0', channel: 'opaque', editVersion: 1, mesh, estimatedUploadMs: 1 });
    adapter.render({
      camera: { intersectsAabb: () => true, position: { x: 0, y: 0, z: 0 } },
      timeMs: 0,
    });
    const evicted = submittedScene?.getObjectByName('section:1,0,0') as Mesh | undefined;
    let geometryDisposals = 0;
    evicted?.geometry.addEventListener('dispose', () => { geometryDisposals += 1; });

    adapter.retainPages(new Set(['0,0,0']));

    expect(adapter.diagnostics()).toEqual({ pageCount: 1, visiblePageCount: 1 });
    expect(submittedScene?.getObjectByName('section:1,0,0')).toBeUndefined();
    expect(geometryDisposals).toBe(1);
    adapter.dispose();
  });

  it('rejects clearly when neither WebGPU nor WebGL2 is available', async () => {
    const canvas = canvasWithWebGL2Only(null);

    await expect(RendererAdapter.create(canvas, {
      capabilities: { gpu: undefined },
    })).rejects.toThrow('Neither WebGPU nor WebGL2 is available');
  });
});
