import {
  BufferGeometry,
  Float32BufferAttribute,
  Int8BufferAttribute,
  Mesh,
  Uint16BufferAttribute,
  Uint32BufferAttribute,
} from 'three';
import { SECTION_SIZE } from '../domain/coords';
import type { OpaqueMesh } from '../meshing/mesh-types';
import type { Aabb } from '../world/structure-template';
import { acquireBlockMaterial, type BlockMaterialLease } from './materials';

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

function validateMesh(mesh: OpaqueMesh): number {
  if (mesh.positions.length % 3 !== 0) throw new Error('positions must contain complete xyz vertices');
  const vertexCount = mesh.positions.length / 3;
  if (mesh.normals.length !== mesh.positions.length) throw new Error('normals must match positions');
  if (mesh.uvs.length !== vertexCount * 2) throw new Error('uvs must match the vertex count');
  if (mesh.materialIds.length !== vertexCount) throw new Error('materialIds must match the vertex count');
  for (const index of mesh.indices) {
    if (index >= vertexCount) throw new Error(`index ${index} exceeds the vertex count`);
  }
  return vertexCount;
}

function geometryFor(mesh: OpaqueMesh): BufferGeometry {
  validateMesh(mesh);
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(mesh.positions, 3));
  geometry.setAttribute('normal', new Int8BufferAttribute(mesh.normals, 3, true));
  geometry.setAttribute('uv', new Float32BufferAttribute(mesh.uvs, 2));
  geometry.setAttribute('blockId', new Uint16BufferAttribute(mesh.materialIds, 1));
  geometry.setIndex(new Uint32BufferAttribute(mesh.indices, 1));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
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

  replace(mesh: OpaqueMesh): void {
    if (this.disposed || mesh.sourceVersion <= this.currentVersion) return;

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

  isVisible(camera: CameraFrustum): boolean {
    return !this.disposed && camera.intersectsAabb(this.bounds);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const previous = this.current;
    this.current = null;
    try {
      this.target.swap(previous, null);
    } finally {
      previous?.geometry.dispose();
      this.materialLease.release();
    }
  }
}
