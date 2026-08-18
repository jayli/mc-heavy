import { AdditiveBlending, NearestFilter, NormalBlending, Sprite, SpriteMaterial, Texture } from 'three';
import type { Vec3 } from '../domain/coords';

export type ParticleType = 'block_crash' | 'explosion';

export type ParticleHost = Readonly<{
  add(object: Sprite): void;
  remove(object: Sprite): void;
}>;

export type ParticleAssets = Readonly<{
  loadTexture(name: string): Promise<Texture>;
}>;

type PoolDefinition = Readonly<{
  texture: string;
  tilesX: number;
  tilesY: number;
  maxLifeMs: number;
  capacity: number;
  additive: boolean;
}>;

const POOL_DEFINITIONS: Readonly<Record<ParticleType, PoolDefinition>> = {
  block_crash: {
    texture: 'block_crash.png',
    tilesX: 5,
    tilesY: 3,
    maxLifeMs: 500,
    capacity: 15,
    additive: false,
  },
  explosion: {
    texture: 'big_blow.png',
    tilesX: 5,
    tilesY: 2,
    maxLifeMs: 500,
    capacity: 10,
    additive: true,
  },
};

type PooledSprite = {
  sprite: Sprite;
  active: boolean;
  timer: number;
  spawnedAt: number;
};

export class ParticleSystem {
  private readonly pools = new Map<ParticleType, PooledSprite[]>();
  private sequence = 0;
  private disposed = false;

  constructor(
    private readonly host: ParticleHost,
    private readonly assets: ParticleAssets = {
      loadTexture: (name) => loadParticleTexture(name),
    },
  ) {}

  async load(): Promise<void> {
    for (const type of Object.keys(POOL_DEFINITIONS) as ParticleType[]) {
      const definition = POOL_DEFINITIONS[type];
      const texture = await this.assets.loadTexture(definition.texture);
      texture.magFilter = NearestFilter;
      texture.minFilter = NearestFilter;
      texture.repeat.set(1 / definition.tilesX, 1 / definition.tilesY);
      texture.needsUpdate = true;

      const pool: PooledSprite[] = [];
      for (let index = 0; index < definition.capacity; index += 1) {
        const material = new SpriteMaterial({
          map: texture,
          transparent: true,
          opacity: 0,
          depthWrite: false,
          blending: definition.additive ? AdditiveBlending : NormalBlending,
        });
        const sprite = new Sprite(material);
        sprite.visible = false;
        this.host.add(sprite);
        pool.push({ sprite, active: false, timer: 0, spawnedAt: 0 });
      }
      this.pools.set(type, pool);
    }
  }

  spawn(type: ParticleType, pos: Vec3): void {
    if (this.disposed) return;
    const pool = this.pools.get(type);
    if (!pool) return;
    let candidate = pool.find((item) => !item.active);
    if (!candidate) {
      candidate = pool.reduce((oldest, item) => (
        item.spawnedAt < oldest.spawnedAt ? item : oldest
      ));
    }
    candidate.sprite.position.set(pos.x, pos.y, pos.z);
    candidate.sprite.visible = true;
    candidate.sprite.material.opacity = 1;
    candidate.sprite.scale.set(1, 1, 1);
    candidate.timer = 0;
    candidate.spawnedAt = this.sequence;
    candidate.active = true;
    this.sequence += 1;
  }

  update(dtMs: number): void {
    if (this.disposed) return;
    for (const [type, pool] of this.pools) {
      const definition = POOL_DEFINITIONS[type];
      for (const item of pool) {
        if (!item.active) continue;
        item.timer += dtMs;
        const progress = Math.min(1, item.timer / definition.maxLifeMs);
        if (progress >= 1) {
          item.active = false;
          item.sprite.visible = false;
          continue;
        }

        const frame = Math.floor(progress * definition.tilesX * definition.tilesY);
        const column = frame % definition.tilesX;
        const row = Math.floor(frame / definition.tilesX);
        item.sprite.material.map!.offset.set(
          column / definition.tilesX,
          1 - (row + 1) / definition.tilesY,
        );
        if (type === 'block_crash') {
          const scale = 1.5 * (1 + progress * 0.5);
          item.sprite.scale.set(scale, scale, 1);
        } else {
          const scale = 3 + progress * 5;
          item.sprite.scale.set(scale, scale, 1);
          item.sprite.material.opacity = progress < 0.8
            ? 1
            : 1 - (progress - 0.8) / 0.2;
        }
      }
    }
  }

  activeCount(): number {
    return [...this.pools.values()]
      .reduce<number>((count, pool) => count + pool.filter((item) => item.active).length, 0);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const pool of this.pools.values()) {
      for (const item of pool) {
        this.host.remove(item.sprite);
        item.sprite.material.dispose();
      }
    }
    this.pools.clear();
  }
}

async function loadParticleTexture(name: string): Promise<Texture> {
  const response = await fetch(`/assets/effects/${name}`);
  if (!response.ok) throw new Error(`Particle texture fetch failed: ${name} (${response.status})`);
  const bitmap = await createImageBitmap(await response.blob());
  const texture = new Texture(bitmap);
  texture.needsUpdate = true;
  return texture;
}
