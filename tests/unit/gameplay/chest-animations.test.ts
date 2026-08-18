import { describe, expect, it } from 'vitest';
import type { Object3D } from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import { ChestAnimations } from '../../../src/gameplay/chest-animations';
import type { TerrainMaterials } from '../../../src/render/materials';

function materials(): TerrainMaterials {
  return {
    opaque: new MeshBasicNodeMaterial(),
    cutout: new MeshBasicNodeMaterial(),
    translucent: new MeshBasicNodeMaterial(),
    dispose() {},
  };
}

describe('ChestAnimations', () => {
  it('creates one lid per open and removes it after the animation', () => {
    const added: Object3D[] = [];
    const removed: Object3D[] = [];
    const animations = new ChestAnimations(
      { add: (object) => added.push(object), remove: (object) => removed.push(object) },
      materials(),
    );

    animations.open({ x: 1, y: 2, z: 3 }, 2, 1000);
    expect(added).toHaveLength(1);
    expect(added[0].name).toBe('chest-lid:1,2,3');

    animations.update(2000);
    expect(removed).toHaveLength(1);
    animations.dispose();
  });

  it('recycles an open chest instead of stacking lids', () => {
    const mounted = new Set<Object3D>();
    const animations = new ChestAnimations({
      add: (object) => mounted.add(object),
      remove: (object) => mounted.delete(object),
    }, materials());

    animations.open({ x: 0, y: 0, z: 0 }, 0, 0);
    animations.open({ x: 0, y: 0, z: 0 }, 0, 100);

    expect(mounted.size).toBe(1);
    animations.dispose();
  });
});
