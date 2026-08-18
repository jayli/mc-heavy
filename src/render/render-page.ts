import {
  Box3,
  BufferGeometry,
  Float32BufferAttribute,
  Mesh,
  Sphere,
  Uint8BufferAttribute,
  Uint16BufferAttribute,
  Uint32BufferAttribute,
  Vector3,
} from 'three';
import { SECTION_SIZE } from '../domain/coords';
import type { ChannelMesh, MeshChannel } from '../meshing/mesh-types';
import type { Aabb } from '../world/structure-template';
import { acquireBlockMaterial, type BlockMaterialLease } from './materials';

export type ChannelUploadJob = Readonly<{
  key: string;
  sectionKey: string;
  channel: MeshChannel;
  editVersion: number;
  mesh: ChannelMesh;
  estimatedUploadMs: number;
}>;

export const channelUploadKey = (sectionKey: string, channel: MeshChannel): string => `${sectionKey}#${channel}`;

export type CameraFrustum = Readonly<{
  intersectsAabb(bounds: Aabb): boolean;
  position?: Readonly<{ x: number; y: number; z: number }>;
}>;

export type RenderPageTarget = Readonly<{
  swap(previous: Mesh | null, next: Mesh | null): void;
}>;

function boundsFromKey(key: string): Aabb {
  const coordinates = key.split(',').map(Number);
  if (coordinates.length !== 3 || !coordinates.every(Number.isInteger)) {
    throw new Error(`Invalid section key: ${key}`);
  }
  const [x, y, z] = coordinates;
  return {
    min: { x: x * SECTION_SIZE, y: y * SECTION_SIZE, z: z * SECTION_SIZE },
    max: {
      x: (x + 1) * SECTION_SIZE,
      y: (y + 1) * SECTION_SIZE,
      z: (z + 1) * SECTION_SIZE,
    },
  };
}

function validateMesh(mesh: ChannelMesh): number {
  if (mesh.positions.length % 3 !== 0) throw new Error('positions must contain complete xyz vertices');
  const vertexCount = mesh.positions.length / 3;
  if (mesh.normals.length !== mesh.positions.length) throw new Error('normals must match positions');
  if (mesh.uvs.length !== vertexCount * 2) throw new Error('uvs must match the vertex count');
  if (mesh.tileIds.length !== vertexCount) throw new Error('tileIds must match the vertex count');
  if (mesh.ao.length !== vertexCount) throw new Error('ao must match the vertex count');
  for (const index of mesh.indices) {
    if (index >= vertexCount) throw new Error(`index ${index} exceeds the vertex count`);
  }
  return vertexCount;
}

function geometryFor(mesh: ChannelMesh): BufferGeometry {
  validateMesh(mesh);
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(mesh.positions, 3));
  geometry.setAttribute('normal', new Float32BufferAttribute(mesh.normals, 3));
  geometry.setAttribute('uv', new Float32BufferAttribute(mesh.uvs, 2));
  geometry.setAttribute('tileId', new Uint16BufferAttribute(mesh.tileIds, 1));
  geometry.setAttribute('ao', new Uint8BufferAttribute(mesh.ao, 1));
  geometry.setIndex(new Uint32BufferAttribute(mesh.indices, 1));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

type StagedBounds = Readonly<{
  min: Readonly<{ x: number; y: number; z: number }>;
  max: Readonly<{ x: number; y: number; z: number }>;
}>;

/** Byte-budgeted, cancellable copy of one channel mesh upload. */
export class RenderStaging {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly uvs: Float32Array;
  readonly tileIds: Uint16Array;
  readonly ao: Uint8Array;
  readonly indices: Uint32Array;
  readonly sourceVersion: number;

  private readonly source: ChannelMesh;
  private readonly onCommit: (staging: RenderStaging) => void;
  private readonly onCancel: (staging: RenderStaging) => void;
  private phase: 0 | 1 | 2 | 3 | 4 | 5 = 0;
  private positionOffset = 0;
  private normalOffset = 0;
  private uvOffset = 0;
  private tileIdOffset = 0;
  private aoOffset = 0;
  private indexOffset = 0;
  private minimum = { x: Number.POSITIVE_INFINITY, y: Number.POSITIVE_INFINITY, z: Number.POSITIVE_INFINITY };
  private maximum = { x: Number.NEGATIVE_INFINITY, y: Number.NEGATIVE_INFINITY, z: Number.NEGATIVE_INFINITY };
  private finished = false;
  private released = false;

  constructor(
    mesh: ChannelMesh,
    onCommit: (staging: RenderStaging) => void,
    onCancel: (staging: RenderStaging) => void,
  ) {
    this.source = mesh;
    this.sourceVersion = mesh.sourceVersion;
    this.positions = new Float32Array(mesh.positions);
    this.normals = new Float32Array(mesh.normals.length);
    this.uvs = new Float32Array(mesh.uvs);
    this.tileIds = new Uint16Array(mesh.tileIds);
    this.ao = new Uint8Array(mesh.ao);
    this.indices = new Uint32Array(mesh.indices);
    this.onCommit = onCommit;
    this.onCancel = onCancel;
  }

  get complete(): boolean {
    return this.finished && !this.released;
  }

  stage(maxBytes: number): number {
    if (this.released || Number.isNaN(maxBytes) || maxBytes <= 0) return 0;
    let budget = Number.isFinite(maxBytes) ? Math.floor(maxBytes) : Number.POSITIVE_INFINITY;
    let staged = 0;

    while (budget > 0 && !this.finished) {
      const before = staged;
      if (this.phase === 0) {
        const count = Math.min(this.positions.length - this.positionOffset, Math.floor(budget / 4));
        if (count === 0) {
          this.phase = 1;
        } else {
          this.positions.set(
            this.source.positions.subarray(this.positionOffset, this.positionOffset + count),
            this.positionOffset,
          );
          for (let index = this.positionOffset; index < this.positionOffset + count; index += 1) {
            const x = this.positions[index * 3];
            const y = this.positions[index * 3 + 1];
            const z = this.positions[index * 3 + 2];
            if (x < this.minimum.x) this.minimum.x = x;
            if (x > this.maximum.x) this.maximum.x = x;
            if (y < this.minimum.y) this.minimum.y = y;
            if (y > this.maximum.y) this.maximum.y = y;
            if (z < this.minimum.z) this.minimum.z = z;
            if (z > this.maximum.z) this.maximum.z = z;
          }
          this.positionOffset += count;
          staged += count * 4;
          budget -= count * 4;
          if (this.positionOffset === this.positions.length) this.phase = 1;
        }
      } else if (this.phase === 1) {
        const count = Math.min(this.normals.length - this.normalOffset, Math.floor(budget / 4));
        if (count === 0) {
          this.phase = 2;
        } else {
          for (let index = 0; index < count; index += 1) {
            this.normals[this.normalOffset + index] = this.source.normals[this.normalOffset + index];
          }
          this.normalOffset += count;
          staged += count * 4;
          budget -= count * 4;
          if (this.normalOffset === this.normals.length) this.phase = 2;
        }
      } else if (this.phase === 2) {
        const count = Math.min(this.uvs.length - this.uvOffset, Math.floor(budget / 4));
        if (count === 0) {
          this.phase = 3;
        } else {
          this.uvs.set(
            this.source.uvs.subarray(this.uvOffset, this.uvOffset + count),
            this.uvOffset,
          );
          this.uvOffset += count;
          staged += count * 4;
          budget -= count * 4;
          if (this.uvOffset === this.uvs.length) this.phase = 3;
        }
      } else if (this.phase === 3) {
        const count = Math.min(this.tileIds.length - this.tileIdOffset, Math.floor(budget / 2));
        if (count === 0) {
          this.phase = 4;
        } else {
          this.tileIds.set(
            this.source.tileIds.subarray(this.tileIdOffset, this.tileIdOffset + count),
            this.tileIdOffset,
          );
          this.tileIdOffset += count;
          staged += count * 2;
          budget -= count * 2;
          if (this.tileIdOffset === this.tileIds.length) this.phase = 4;
        }
      } else if (this.phase === 4) {
        const count = Math.min(this.ao.length - this.aoOffset, Math.floor(budget));
        if (count === 0) {
          this.phase = 5;
        } else {
          this.ao.set(
            this.source.ao.subarray(this.aoOffset, this.aoOffset + count),
            this.aoOffset,
          );
          this.aoOffset += count;
          staged += count;
          budget -= count;
          if (this.aoOffset === this.ao.length) this.phase = 5;
        }
      } else {
        const count = Math.min(this.indices.length - this.indexOffset, Math.floor(budget / 4));
        if (count === 0) break;
        this.indices.set(
          this.source.indices.subarray(this.indexOffset, this.indexOffset + count),
          this.indexOffset,
        );
        this.indexOffset += count;
        staged += count * 4;
        budget -= count * 4;
      }
      if (staged === before) break;
    }

    if (this.phase === 5 && this.indexOffset === this.indices.length) this.finished = true;
    return staged;
  }

  bounds(): StagedBounds {
    return Object.freeze({
      min: Object.freeze({ ...this.minimum }),
      max: Object.freeze({ ...this.maximum }),
    });
  }

  commit(): void {
    if (this.released) throw new Error('Cannot commit a cancelled staging');
    if (!this.finished) throw new Error('Cannot commit an incomplete staging');
    this.released = true;
    this.onCommit(this);
  }

  cancel(): void {
    if (this.released) return;
    this.released = true;
    this.finished = false;
    this.onCancel(this);
  }
}

const nullTarget: RenderPageTarget = { swap() {} };

/** A section-local, versioned owner of render resources only. */
export class RenderPage {
  readonly key: string;
  private readonly bounds: Aabb;
  private readonly target: RenderPageTarget;
  private readonly materialLease: BlockMaterialLease;
  private current: Mesh | null = null;
  private currentVersion = -1;
  private staging: RenderStaging | null = null;
  private disposed = false;

  constructor(key: string, bounds?: Aabb, target: RenderPageTarget = nullTarget) {
    this.key = key;
    this.bounds = bounds ?? boundsFromKey(key);
    this.target = target;
    this.materialLease = acquireBlockMaterial();
  }

  get sourceVersion(): number {
    return this.currentVersion;
  }

  replace(mesh: ChannelMesh): void {
    if (this.disposed || mesh.sourceVersion <= this.currentVersion) return;
    this.cancelStaging();

    const geometry = geometryFor(mesh);
    const next = new Mesh(geometry, this.materialLease.material);
    next.name = `section:${this.key}`;
    next.position.set(this.bounds.min.x, this.bounds.min.y, this.bounds.min.z);
    next.updateMatrix();

    const previous = this.current;
    try {
      this.target.swap(previous, next);
    } catch (error) {
      geometry.dispose();
      throw error;
    }
    this.current = next;
    this.currentVersion = mesh.sourceVersion;
    previous?.geometry.dispose();
  }

  beginStaging(mesh: ChannelMesh): RenderStaging | null {
    if (this.disposed || mesh.sourceVersion <= this.currentVersion) return null;
    validateMesh(mesh);
    this.cancelStaging();
    const staging = new RenderStaging(
      mesh,
      (completed) => this.commitStaging(completed),
      (cancelled) => {
        if (this.staging === cancelled) this.staging = null;
      },
    );
    this.staging = staging;
    return staging;
  }

  isVisible(camera: CameraFrustum): boolean {
    return !this.disposed && camera.intersectsAabb(this.bounds);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelStaging();
    const previous = this.current;
    this.current = null;
    try {
      this.target.swap(previous, null);
    } finally {
      previous?.geometry.dispose();
      this.materialLease.release();
    }
  }

  private commitStaging(completed: RenderStaging): void {
    if (this.disposed || this.staging !== completed || completed.sourceVersion <= this.currentVersion) {
      if (this.staging === completed) this.staging = null;
      return;
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(completed.positions, 3));
    geometry.setAttribute('normal', new Float32BufferAttribute(completed.normals, 3));
    geometry.setAttribute('uv', new Float32BufferAttribute(completed.uvs, 2));
    geometry.setAttribute('tileId', new Uint16BufferAttribute(completed.tileIds, 1));
    geometry.setAttribute('ao', new Uint8BufferAttribute(completed.ao, 1));
    geometry.setIndex(new Uint32BufferAttribute(completed.indices, 1));
    const stagedBounds = completed.bounds();
    geometry.boundingBox = new Box3(
      new Vector3(stagedBounds.min.x, stagedBounds.min.y, stagedBounds.min.z),
      new Vector3(stagedBounds.max.x, stagedBounds.max.y, stagedBounds.max.z),
    );
    geometry.boundingSphere = new Sphere();
    geometry.boundingSphere.set(
      new Vector3(
        (stagedBounds.min.x + stagedBounds.max.x) / 2,
        (stagedBounds.min.y + stagedBounds.max.y) / 2,
        (stagedBounds.min.z + stagedBounds.max.z) / 2,
      ),
      new Vector3(
        stagedBounds.max.x - stagedBounds.min.x,
        stagedBounds.max.y - stagedBounds.min.y,
        stagedBounds.max.z - stagedBounds.min.z,
      ).length() / 2,
    );

    const next = new Mesh(geometry, this.materialLease.material);
    next.name = `section:${this.key}`;
    next.position.set(this.bounds.min.x, this.bounds.min.y, this.bounds.min.z);
    next.updateMatrix();

    const previous = this.current;
    try {
      this.target.swap(previous, next);
    } catch (error) {
      geometry.dispose();
      throw error;
    }
    this.current = next;
    this.currentVersion = completed.sourceVersion;
    this.staging = null;
    previous?.geometry.dispose();
  }

  private cancelStaging(): void {
    const staging = this.staging;
    this.staging = null;
    staging?.cancel();
  }
}
