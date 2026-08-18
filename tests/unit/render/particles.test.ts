import { describe, expect, it } from 'vitest';
import type { Object3D, Texture } from 'three';
import { ParticleSystem } from '../../../src/render/particles';

function fakeAssets(): Readonly<{
  loadTexture(name: string): Promise<Texture>;
}> {
  return {
    async loadTexture() {
      return {
        magFilter: 0,
        minFilter: 0,
        needsUpdate: false,
        repeat: { set() {} },
        offset: { set() {} },
      } as unknown as Texture;
    },
  };
}

function fakeHost(): Readonly<{
  added: Set<Object3D>;
  add(object: Object3D): void;
  remove(object: Object3D): void;
}> {
  const added = new Set<Object3D>();
  return {
    added,
    add: (object) => added.add(object),
    remove: (object) => added.delete(object),
  };
}

describe('ParticleSystem', () => {
  it('caps pools and reuses sprites for overspawning', async () => {
    const host = fakeHost();
    const system = new ParticleSystem(host, fakeAssets());
    await system.load();

    for (let index = 0; index < 20; index += 1) {
      system.spawn('block_crash', { x: 0, y: 0, z: 0 });
    }

    expect(system.activeCount()).toBeLessThanOrEqual(15);
    expect(system.activeCount()).toBe(15);
    system.dispose();
  });

  it('expires every active particle after its maximum life', async () => {
    const host = fakeHost();
    const system = new ParticleSystem(host, fakeAssets());
    await system.load();
    system.spawn('explosion', { x: 1, y: 2, z: 3 });
    expect(system.activeCount()).toBe(1);

    system.update(1_000);

    expect(system.activeCount()).toBe(0);
    system.dispose();
  });
});
