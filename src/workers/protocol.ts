import type { VoxelSection } from '../domain/voxel-section';
import type { OpaqueMesh } from '../meshing/mesh-types';

export type SectionState =
  | 'absent'
  | 'queued'
  | 'generating'
  | 'meshing'
  | 'uploadQueued'
  | 'visible'
  | 'evicting';

export type ColumnPos = Readonly<{ x: number; z: number }>;
export type Vec2 = Readonly<{ x: number; z: number }>;
export type WorkRequest = Readonly<{
  key: string;
  epoch: number;
  priority: number;
  editVersion: number;
  kind: 'generate' | 'mesh';
}>;
export type GeneratedSection = Readonly<{
  key: string;
  epoch: number;
  editVersion: number;
  section: VoxelSection;
}>;
export type MeshedSection = Readonly<{
  key: string;
  epoch: number;
  editVersion: number;
  mesh: OpaqueMesh;
}>;
export type UploadJob = Readonly<{
  key: string;
  editVersion: number;
  mesh: OpaqueMesh;
  estimatedUploadMs: number;
}>;
