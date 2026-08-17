import type { OpaqueMesh } from '../meshing/mesh-types';
import type { UploadJob } from '../workers/protocol';

export type RenderUploadDrain = Readonly<{
  uploads: number;
  uploadedBytes: number;
  spentMs: number;
  queued: number;
}>;

type PendingUpload = {
  job: UploadJob;
  remainingMs: number;
};

export class RenderUploadQueue {
  private readonly jobs = new Map<string, PendingUpload>();

  get queued(): number {
    return this.jobs.size;
  }

  enqueue(job: UploadJob): void {
    if (!Number.isFinite(job.estimatedUploadMs) || job.estimatedUploadMs < 0) {
      throw new Error('Upload estimate must be a finite, non-negative number');
    }
    const pending = this.jobs.get(job.key);
    if (pending && pending.job.editVersion >= job.editVersion) return;
    this.jobs.set(job.key, { job, remainingMs: job.estimatedUploadMs });
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
    for (const [key, pending] of this.jobs) {
      const remainingBudget = budget - spentMs;
      const sliceMs = Math.min(pending.remainingMs, remainingBudget);
      pending.remainingMs -= sliceMs;
      spentMs += sliceMs;
      if (pending.remainingMs > 0) break;

      upload(pending.job);
      this.jobs.delete(key);
      uploads += 1;
      uploadedBytes += meshByteLength(pending.job.mesh);
      if (spentMs >= budget) break;
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
