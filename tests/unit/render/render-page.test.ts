import { Mesh, type Material } from 'three';
import { describe, expect, it } from 'vitest';
import type { OpaqueMesh } from '../../../src/meshing/mesh-types';
import { RenderPage, type RenderPageTarget } from '../../../src/render/render-page';

function opaqueMesh(sourceVersion: number, materialId = 1): OpaqueMesh {
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
    materialIds: new Uint16Array([materialId, materialId, materialId]),
    indices: new Uint32Array([0, 1, 2]),
    sourceVersion,
  };
}

function capturingTarget(): Readonly<{
  target: RenderPageTarget;
  current(): Mesh | null;
}> {
  let current: Mesh | null = null;
  return {
    current: () => current,
    target: {
      swap(previous, next) {
        expect(previous).toBe(current);
        current = next;
      },
    },
  };
}

function nodeGraphUsesAttribute(root: unknown, attributeName: string): boolean {
  const visited = new Set<object>();
  const pending: unknown[] = [root];
  while (pending.length > 0) {
    const value = pending.pop();
    if (!value || typeof value !== 'object' || visited.has(value)) continue;
    visited.add(value);
    const candidate = value as { getAttributeName?: (builder?: unknown) => string };
    if (candidate.getAttributeName?.() === attributeName) return true;
    pending.push(...Object.values(value));
  }
  return false;
}

describe('RenderPage', () => {
  it('keeps version 2 and its GPU object when an older or equal upload arrives', () => {
    const capture = capturingTarget();
    const page = new RenderPage('0,0,0', undefined, capture.target);
    page.replace(opaqueMesh(2));
    const versionTwoObject = capture.current();

    page.replace(opaqueMesh(1));
    page.replace(opaqueMesh(2, 4));

    expect(page.sourceVersion).toBe(2);
    expect(capture.current()).toBe(versionTwoObject);
    page.dispose();
  });

  it('builds complete Three geometry before swapping and disposes the old geometry afterwards', () => {
    let current: Mesh | null = null;
    let oldGeometryDisposed = false;
    let oldWasLiveDuringSwap = false;
    const target: RenderPageTarget = {
      swap(previous, next) {
        if (previous) oldWasLiveDuringSwap = !oldGeometryDisposed;
        if (!next) {
          current = null;
          return;
        }
        expect(next.geometry.getAttribute('position').count).toBe(3);
        const expectedMaterialId = previous ? 4 : 1;
        expect(next.geometry.getAttribute('blockId').array).toEqual(
          new Uint16Array([expectedMaterialId, expectedMaterialId, expectedMaterialId]),
        );
        current = next;
      },
    };
    const page = new RenderPage('0,0,0', undefined, target);
    page.replace(opaqueMesh(1));
    const firstObject = current as Mesh | null;
    expect(firstObject).not.toBeNull();
    firstObject?.geometry.addEventListener('dispose', () => {
      oldGeometryDisposed = true;
    });

    page.replace(opaqueMesh(2, 4));

    expect(oldWasLiveDuringSwap).toBe(true);
    expect(oldGeometryDisposed).toBe(true);
    expect(page.sourceVersion).toBe(2);
    page.dispose();
  });

  it('uses one shared atlas material whose shader graph selects layers from blockId', () => {
    const first = capturingTarget();
    const second = capturingTarget();
    const firstPage = new RenderPage('0,0,0', undefined, first.target);
    const secondPage = new RenderPage('1,0,0', undefined, second.target);
    firstPage.replace(opaqueMesh(1, 3));
    secondPage.replace(opaqueMesh(1, 7));

    const firstObject = first.current();
    const secondObject = second.current();
    expect(firstObject?.material as Material).toBe(secondObject?.material as Material);
    expect(firstObject?.geometry.getAttribute('blockId').array).toEqual(new Uint16Array([3, 3, 3]));
    expect(secondObject?.geometry.getAttribute('blockId').array).toEqual(new Uint16Array([7, 7, 7]));
    expect(nodeGraphUsesAttribute(
      (firstObject?.material as Material & { colorNode?: unknown }).colorNode,
      'blockId',
    )).toBe(true);
    expect(firstObject?.geometry.getAttribute('uv').array).toEqual(opaqueMesh(1, 3).uvs);
    firstPage.dispose();
    secondPage.dispose();
  });

  it('derives canonical section bounds and excludes a page outside the camera frustum', () => {
    const page = new RenderPage('12,0,0');
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

  it('honors explicit BlockPos bounds and releases its geometry exactly once', () => {
    const capture = capturingTarget();
    const page = new RenderPage('arbitrary-key', {
      min: { x: 200, y: -4, z: 300 },
      max: { x: 216, y: 12, z: 316 },
    }, capture.target);
    page.replace(opaqueMesh(1));
    let disposeEvents = 0;
    capture.current()?.geometry.addEventListener('dispose', () => {
      disposeEvents += 1;
    });

    expect(page.isVisible({ intersectsAabb: (bounds) => bounds.min.x === 200 })).toBe(true);
    page.dispose();
    page.dispose();

    expect(capture.current()).toBeNull();
    expect(disposeEvents).toBe(1);
  });
});
