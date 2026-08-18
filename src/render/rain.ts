import {
  BufferGeometry,
  DynamicDrawUsage,
  Float32BufferAttribute,
  LineSegments,
  type Object3D,
} from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import {
  attribute,
  max as tslMax,
  mod,
  positionLocal,
  uniform,
  vec3,
} from 'three/tsl';
import type { Vec3 } from '../domain/coords';

export type RainHost = Readonly<{
  add(object: Object3D): void;
  remove(object: Object3D): void;
}>;

export type RainWorld = Readonly<{
  isSolid(x: number, y: number, z: number): boolean;
}>;

export type RainOptions = Readonly<{
  particleCount?: number;
  radius?: number;
  speed?: number;
  dropLength?: number;
  refreshDistance?: number;
  verticalRefreshDistance?: number;
  cycleHeight?: number;
  refreshBatchSize?: number;
  floorOffset?: number;
  searchDepth?: number;
}>;

export function resolveRainMinY(
  isSolid: (x: number, y: number, z: number) => boolean,
  x: number,
  topY: number,
  z: number,
  playerY: number,
  searchDepth = 56,
  floorOffset = 0.02,
  cycleHeight = 42,
): number {
  const defaultMinY = playerY - cycleHeight * 0.35;
  const endY = Math.floor(Math.max(defaultMinY, topY - searchDepth));
  for (let y = Math.floor(topY); y >= endY; y -= 1) {
    if (isSolid(x, y, z)) return y + 1 + floorOffset;
  }
  return defaultMinY;
}

type RainUniforms = Readonly<{
  uTime: { value: number };
}>;

/** GPU 驱动的相机跟随雨幕：位置与碰撞都在顶点着色器完成，主线程只做分批刷新。 */
export class RainEffect {
  private particleCount: number;
  private readonly radius: number;
  private readonly speed: number;
  private readonly dropLength: number;
  private readonly refreshDistanceSq: number;
  private readonly verticalRefreshDistance: number;
  private readonly cycleHeight: number;
  private readonly refreshBatchSize: number;
  private readonly floorOffset: number;
  private readonly searchDepth: number;
  private readonly world: RainWorld | null;
  private positions: Float32Array;
  private phases: Float32Array;
  private speedScales: Float32Array;
  private isBottomVertex: Float32Array;
  private minYs: Float32Array;
  private readonly geometry: BufferGeometry;
  private readonly uniforms: RainUniforms;
  private lines: LineSegments | null = null;
  private elapsed = 0;
  private refreshAccumulator = 0;
  private refreshing = false;
  private refreshCursor = 0;
  private refreshTarget: Vec3 = { x: 0, y: 0, z: 0 };
  private lastRefresh: Vec3 = { x: 0, y: 0, z: 0 };
  private disposed = false;

  constructor(
    private readonly host: RainHost,
    world: RainWorld | null = null,
    options: RainOptions = {},
  ) {
    this.particleCount = options.particleCount ?? 700;
    this.radius = options.radius ?? 20;
    this.speed = options.speed ?? 24;
    this.dropLength = options.dropLength ?? 0.5;
    this.refreshDistanceSq = (options.refreshDistance ?? 8) ** 2;
    this.verticalRefreshDistance = options.verticalRefreshDistance ?? 6;
    this.cycleHeight = options.cycleHeight ?? 42;
    this.refreshBatchSize = options.refreshBatchSize ?? 64;
    this.floorOffset = options.floorOffset ?? 0.02;
    this.searchDepth = options.searchDepth ?? 56;
    this.world = world;

    const vertexCount = this.particleCount * 2;
    this.positions = new Float32Array(vertexCount * 3);
    this.phases = new Float32Array(vertexCount);
    this.speedScales = new Float32Array(vertexCount);
    this.isBottomVertex = new Float32Array(vertexCount);
    this.minYs = new Float32Array(vertexCount);
    for (let index = 0; index < this.particleCount; index += 1) {
      this.resetParticle(index, this.refreshTarget, true);
    }

    this.geometry = new BufferGeometry();
    const positionAttribute = new Float32BufferAttribute(this.positions, 3);
    positionAttribute.setUsage(DynamicDrawUsage);
    this.geometry.setAttribute('position', positionAttribute);
    this.geometry.setAttribute('aPhase', new Float32BufferAttribute(this.phases, 1));
    this.geometry.setAttribute('aSpeedScale', new Float32BufferAttribute(this.speedScales, 1));
    this.geometry.setAttribute('aIsBottomVertex', new Float32BufferAttribute(this.isBottomVertex, 1));
    this.geometry.setAttribute('aMinY', new Float32BufferAttribute(this.minYs, 1));

    const uTime = uniform(0);
    const uBaseSpeed = uniform(this.speed);
    const uDropLength = uniform(this.dropLength);
    const uCycleHeight = uniform(this.cycleHeight);
    this.uniforms = { uTime };

    const aPhase = attribute<'float'>('aPhase', 'float');
    const aSpeedScale = attribute<'float'>('aSpeedScale', 'float');
    const aIsBottomVertex = attribute<'float'>('aIsBottomVertex', 'float');
    const aMinY = attribute<'float'>('aMinY', 'float');
    const fallDistance = mod(
      uTime.mul(uBaseSpeed).mul(aSpeedScale).add(aPhase),
      uCycleHeight,
    );
    const newY = tslMax(
      positionLocal.y.sub(fallDistance).sub(aIsBottomVertex.mul(uDropLength)),
      aMinY,
    );

    const material = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
    material.colorNode = vec3(1.0, 1.0, 1.0);
    material.positionNode = vec3(positionLocal.x, newY, positionLocal.z);
    this.lines = new LineSegments(this.geometry, material);
    this.lines.frustumCulled = false;
    this.lines.visible = false;
    this.host.add(this.lines);
  }

  get enabled(): boolean {
    return this.lines?.visible === true;
  }

  setEnabled(enabled: boolean): void {
    if (this.disposed || !this.lines) return;
    this.lines.visible = enabled;
  }

  setDensity(count: number): void {
    if (this.disposed || !Number.isInteger(count) || count <= 0) return;
    this.particleCount = count;
    const vertexCount = count * 2;
    this.positions = new Float32Array(vertexCount * 3);
    this.phases = new Float32Array(vertexCount);
    this.speedScales = new Float32Array(vertexCount);
    this.isBottomVertex = new Float32Array(vertexCount);
    this.minYs = new Float32Array(vertexCount);
    for (let index = 0; index < count; index += 1) {
      this.resetParticle(index, this.refreshTarget, true);
    }
    this.geometry.setAttribute('position', new Float32BufferAttribute(this.positions, 3));
    this.geometry.setAttribute('aPhase', new Float32BufferAttribute(this.phases, 1));
    this.geometry.setAttribute('aSpeedScale', new Float32BufferAttribute(this.speedScales, 1));
    this.geometry.setAttribute('aIsBottomVertex', new Float32BufferAttribute(this.isBottomVertex, 1));
    this.geometry.setAttribute('aMinY', new Float32BufferAttribute(this.minYs, 1));
  }

  update(playerPos: Vec3, dtSeconds: number): void {
    if (this.disposed || !this.lines?.visible) return;
    this.elapsed += dtSeconds;
    this.uniforms.uTime.value = this.elapsed;
    this.processBatchedRefresh();

    this.refreshAccumulator += dtSeconds;
    if (this.refreshAccumulator < 1 / 30) return;
    this.refreshAccumulator = 0;

    const reference = this.refreshing ? this.refreshTarget : this.lastRefresh;
    const dx = playerPos.x - reference.x;
    const dz = playerPos.z - reference.z;
    if (dx * dx + dz * dz > this.refreshDistanceSq
      || Math.abs(playerPos.y - reference.y) > this.verticalRefreshDistance) {
      this.refreshing = true;
      this.refreshCursor = 0;
      this.refreshTarget = { ...playerPos };
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.lines) {
      this.host.remove(this.lines);
      this.lines.geometry.dispose();
      const material = this.lines.material;
      if (Array.isArray(material)) {
        for (const entry of material) entry.dispose();
      } else {
        material.dispose();
      }
      this.lines = null;
    }
  }

  private resetParticle(index: number, playerPos: Vec3, randomize: boolean): void {
    const angle = Math.random() * Math.PI * 2;
    const radius = Math.sqrt(Math.random()) * this.radius;
    const x = playerPos.x + Math.cos(angle) * radius;
    const z = playerPos.z + Math.sin(angle) * radius;
    const topY = playerPos.y + 30 + Math.random() * 20;
    const minY = this.world
      ? resolveRainMinY(
        (bx, by, bz) => this.world!.isSolid(bx, by, bz),
        x,
        topY,
        z,
        playerPos.y,
        this.searchDepth,
        this.floorOffset,
        this.cycleHeight,
      )
      : playerPos.y - this.cycleHeight * 0.35;

    const positionOffset = index * 6;
    const vertex = index * 2;
    this.positions[positionOffset] = x;
    this.positions[positionOffset + 1] = topY;
    this.positions[positionOffset + 2] = z;
    this.positions[positionOffset + 3] = x;
    this.positions[positionOffset + 4] = topY;
    this.positions[positionOffset + 5] = z;
    if (randomize) {
      this.phases[vertex] = Math.random() * this.cycleHeight;
      this.phases[vertex + 1] = this.phases[vertex];
      this.speedScales[vertex] = 0.85 + Math.random() * 0.35;
      this.speedScales[vertex + 1] = this.speedScales[vertex];
    }
    this.isBottomVertex[vertex] = 0;
    this.isBottomVertex[vertex + 1] = 1;
    this.minYs[vertex] = minY;
    this.minYs[vertex + 1] = minY;
  }

  private processBatchedRefresh(): void {
    if (!this.refreshing) return;
    const end = Math.min(this.refreshCursor + this.refreshBatchSize, this.particleCount);
    for (let index = this.refreshCursor; index < end; index += 1) {
      this.resetParticle(index, this.refreshTarget, false);
    }
    this.refreshCursor = end;
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.aMinY.needsUpdate = true;
    if (this.refreshCursor >= this.particleCount) {
      this.refreshing = false;
      this.lastRefresh = { ...this.refreshTarget };
    }
  }
}
