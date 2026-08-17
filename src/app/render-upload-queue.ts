import type { OpaqueMesh } from '../meshing/mesh-types';
import type { UploadJob } from '../workers/protocol';

export const BYTES_PER_UPLOAD_MILLISECOND = 64 * 1024;

export type RenderUploadDrain = Readonly<{
  uploads: number;
  uploadedBytes: number;
  spentMs: number;
  queued: number;
}>;

export type UploadSink = Readonly<{
  stage(job: UploadJob, maxBytes: number): number;
  commit(job: UploadJob): void;
}>;

type PendingUpload = {
  job: UploadJob;
  remainingBytes: number;
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
    this.jobs.set(job.key, { job, remainingBytes: meshByteLength(job.mesh) });
  }

  retain(keys: ReadonlySet<string>): void {
    for (const key of this.jobs.keys()) {
      if (!keys.has(key)) this.jobs.delete(key);
    }
  }

  drain(budgetMs: number, sink: UploadSink): RenderUploadDrain {
    const budgetBytes = Math.floor(Math.max(0, budgetMs) * BYTES_PER_UPLOAD_MILLISECOND);
    let uploads = 0;
    let uploadedBytes = 0;
    let spentBytes = 0;
    for (const [key, pending] of this.jobs) {
      const remainingBudget = budgetBytes - spentBytes;
      if (remainingBudget <= 0) break;
      const maxBytes = Math.min(remainingBudget, pending.remainingBytes);
      const staged = sink.stage(pending.job, maxBytes);
      const accepted = Math.max(0, Math.min(staged, maxBytes));
      pending.remainingBytes -= accepted;
      spentBytes += accepted;
      if (pending.remainingBytes > 0) break;

      sink.commit(pending.job);
      this.jobs.delete(key);
      uploads += 1;
      uploadedBytes += meshByteLength(pending.job.mesh);
    }
    return Object.freeze({
      uploads,
      uploadedBytes,
      spentMs: spentBytes / BYTES_PER_UPLOAD_MILLISECOND,
      queued: this.jobs.size,
    });
  }
}

export function meshByteLength(mesh: OpaqueMesh): number {
  return mesh.positions.byteLength
    + mesh.normals.length * Float32Array.BYTES_PER_ELEMENT
    + mesh.uvs.byteLength
    + mesh.materialIds.byteLength
    + mesh.indices.byteLength;
}
