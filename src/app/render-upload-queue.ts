import type { OpaqueMesh } from '../meshing/mesh-types';
import type { UploadJob } from '../workers/protocol';

export type RenderUploadDrain = Readonly<{
  uploads: number;
  uploadedBytes: number;
  spentMs: number;
  queued: number;
}>;

export class RenderUploadQueue {
  private readonly jobs = new Map<string, UploadJob>();

  get queued(): number {
    return this.jobs.size;
  }

  enqueue(job: UploadJob): void {
    if (!Number.isFinite(job.estimatedUploadMs) || job.estimatedUploadMs < 0) {
      throw new Error('Upload estimate must be a finite, non-negative number');
    }
    this.jobs.set(job.key, job);
  }

  retain(keys: ReadonlySet<string>): void {
    for (const key of this.jobs.keys()) {
      if (!keys.has(key)) this.jobs.delete(key);
    }
  }

  drain(budgetMs: number, upload: (job: UploadJob) => void): RenderUploadDrain {
    const budget = Math.max(0, budgetMs);
    let uploads = 0;
    let uploadedBytes = 0;
    let spentMs = 0;
    for (const [key, job] of this.jobs) {
      if (spentMs + job.estimatedUploadMs > budget) break;
      upload(job);
      this.jobs.delete(key);
      uploads += 1;
      uploadedBytes += meshByteLength(job.mesh);
      spentMs += job.estimatedUploadMs;
    }
    return Object.freeze({ uploads, uploadedBytes, spentMs, queued: this.jobs.size });
  }
}

export function meshByteLength(mesh: OpaqueMesh): number {
  return mesh.positions.byteLength
    + mesh.normals.byteLength
    + mesh.uvs.byteLength
    + mesh.materialIds.byteLength
    + mesh.indices.byteLength;
}
