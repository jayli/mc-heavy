import { Group, Mesh } from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
// Three r184 does not publish declarations for this private compatibility utility.
// @ts-expect-error -- exercised deliberately to probe the real WebGPU vertex layout mapping.
import WebGPUAttributeUtils from 'three/src/renderers/webgpu/utils/WebGPUAttributeUtils.js';
import { describe, expect, it } from 'vitest';
import type { ChannelMesh } from '../../../src/meshing/mesh-types';
import { RenderPage, type RenderPageTarget } from '../../../src/render/render-page';
import type { TerrainMaterials } from '../../../src/render/materials';

function channelMesh(sourceVersion: number, materialId = 1): ChannelMesh {
  return {
    positions: new Float32Array([
      0, 0, 0,
      1, 0, 0,
      0, 1, 0,
    ]),
    normals: new Int8Array([
      0, 0, 1,
      0, 0, 1,
      0, 0, 1,
    ]),
    uvs: new Float32Array([
      0, 0,
      1, 0,
      0, 1,
    ]),
    tileIds: new Uint16Array([materialId, materialId, materialId]),
    ao: new Uint8Array([3, 3, 3]),
    indices: new Uint32Array([0, 1, 2]),
    sourceVersion,
  };
}

function materials(): TerrainMaterials {
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

function capturingTarget(): Readonly<{
  target: RenderPageTarget;
  group(): Group | null;
}> {
  let group: Group | null = null;
  return {
    group: () => group,
    target: {
      swap(previous, next) {
        expect(previous).toBe(group);
        group = next;
      },
    },
  };
}

function childOf(group: Group, channel: string): Mesh | undefined {
  return group.children.find((child) => child.name.endsWith(`:${channel}`)) as Mesh | undefined;
}

describe('RenderPage', () => {
  it('swaps each channel independently and drops stale channel versions', () => {
    const capture = capturingTarget();
    const page = new RenderPage('0,0,0', materials(), undefined, capture.target);

    page.replace('opaque', channelMesh(1));
    page.replace('opaque', channelMesh(2));
    page.replace('cutout', channelMesh(2));

    expect(page.channelVersion('opaque')).toBe(2);
    expect(page.channelVersion('cutout')).toBe(2);
    page.replace('opaque', channelMesh(1));
    expect(page.channelVersion('opaque')).toBe(2);
    expect(capture.group()?.children).toHaveLength(2);
    page.dispose();
  });

  it('mounts the section group once and disposes the replaced geometry', () => {
    let oldGeometryDisposed = false;
    let group: Group | null = null;
    const target: RenderPageTarget = {
      swap(_previous, next) {
        group = next;
      },
    };
    const page = new RenderPage('0,0,0', materials(), undefined, target);
    page.replace('opaque', channelMesh(1));
    expect(group).not.toBeNull();
    const first = childOf(group!, 'opaque');
    first?.geometry.addEventListener('dispose', () => {
      oldGeometryDisposed = true;
    });

    page.replace('opaque', channelMesh(2));

    expect(oldGeometryDisposed).toBe(true);
    expect(page.channelVersion('opaque')).toBe(2);
    page.dispose();
  });

  it('decodes mesher Int8 normals into a WebGPU-valid float32x3 vertex layout', () => {
    const capture = capturingTarget();
    const page = new RenderPage('0,0,0', materials(), undefined, capture.target);
    page.replace('opaque', channelMesh(1));

    const normal = childOf(capture.group()!, 'opaque')?.geometry.getAttribute('normal');
    expect(normal?.array).toBeInstanceOf(Float32Array);
    expect(normal?.itemSize).toBe(3);
    expect(normal?.normalized).toBe(false);
    expect(normal?.array).toEqual(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]));

    const webGpuAttributes = new WebGPUAttributeUtils({});
    expect(webGpuAttributes.createShaderVertexBuffers({
      getAttributes: () => [normal],
    })).toEqual([{
      arrayStride: 12,
      attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }],
      stepMode: 'vertex',
    }]);
    page.dispose();
  });

  it('shares the injected terrain materials across pages and keeps channel tileIds', () => {
    const shared = materials();
    const firstCapture = capturingTarget();
    const secondCapture = capturingTarget();
    const first = new RenderPage('0,0,0', shared, undefined, firstCapture.target);
    const second = new RenderPage('1,0,0', shared, undefined, secondCapture.target);
    first.replace('opaque', channelMesh(1, 3));
    second.replace('opaque', channelMesh(1, 7));

    const firstMesh = childOf(firstCapture.group()!, 'opaque');
    const secondMesh = childOf(secondCapture.group()!, 'opaque');
    expect(firstMesh?.material).toBe(shared.opaque);
    expect(secondMesh?.material).toBe(shared.opaque);
    expect(firstMesh?.geometry.getAttribute('tileId').array).toEqual(new Uint16Array([3, 3, 3]));
    expect(secondMesh?.geometry.getAttribute('tileId').array).toEqual(new Uint16Array([7, 7, 7]));
    expect(second.channelVersion('opaque')).toBe(1);
    first.dispose();
    second.dispose();
    shared.dispose();
  });

  it('derives canonical section bounds and excludes a page outside the camera frustum', () => {
    const page = new RenderPage('12,0,0', materials());
    let testedBounds: unknown;
    const visible = page.isVisible({
      intersectsAabb(bounds) {
        testedBounds = bounds;
        return bounds.max.x <= 32;
      },
    });

    expect(visible).toBe(false);
    expect(testedBounds).toEqual({
      min: { x: 192, y: 0, z: 0 },
      max: { x: 208, y: 16, z: 16 },
    });
    page.dispose();
  });

  it('keeps the old channel visible and versioned until a staged upload commits', () => {
    const capture = capturingTarget();
    const page = new RenderPage('0,0,0', materials(), undefined, capture.target);
    page.replace('opaque', channelMesh(1));
    const original = childOf(capture.group()!, 'opaque');

    const staging = page.beginStaging('opaque', channelMesh(2, 4));
    expect(staging).not.toBeNull();
    const staged = staging as NonNullable<ReturnType<RenderPage['beginStaging']>>;
    expect(staged.stage(12)).toBe(12);
    expect(staged.complete).toBe(false);
    expect(page.channelVersion('opaque')).toBe(1);
    expect(childOf(capture.group()!, 'opaque')).toBe(original);
    expect(() => staged.commit()).toThrow('incomplete');

    expect(staged.stage(Number.POSITIVE_INFINITY)).toBeGreaterThan(0);
    expect(staged.complete).toBe(true);
    staged.commit();

    expect(page.channelVersion('opaque')).toBe(2);
    expect(childOf(capture.group()!, 'opaque')).not.toBe(original);
    expect(childOf(capture.group()!, 'opaque')?.geometry.getAttribute('tileId').array)
      .toEqual(new Uint16Array([4, 4, 4]));
    page.dispose();
  });

  it('disposes its group and every channel exactly once', () => {
    const capture = capturingTarget();
    const page = new RenderPage('0,0,0', materials(), undefined, capture.target);
    page.replace('opaque', channelMesh(1));
    page.replace('cutout', channelMesh(1));
    const disposed: string[] = [];
    for (const child of capture.group()?.children ?? []) {
      (child as Mesh).geometry.addEventListener('dispose', () => disposed.push(child.name));
    }

    page.dispose();
    page.dispose();

    expect(capture.group()).toBeNull();
    expect(disposed.sort()).toEqual(['section:0,0,0:cutout', 'section:0,0,0:opaque']);
  });
});
