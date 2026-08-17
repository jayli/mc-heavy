import type {
  GenerationWorkerRequest,
  GenerationWorkerResponse,
  MeshingWorkerRequest,
  MeshingWorkerResponse,
  SerializedVoxelSection,
} from './protocol';
import {
  generationTransferables,
  handleGenerationRequest,
  handleMeshingRequest,
  meshingTransferables,
} from './work-handlers';

export type WorkerPort<Request, Response> = {
  onmessage: ((event: MessageEvent<Response>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: Request, transfer?: Transferable[]): void;
  terminate(): void;
};

export type WorkerFactory = Readonly<{
  createGenerationWorker(): WorkerPort<GenerationWorkerRequest, GenerationWorkerResponse>;
  createMeshingWorker(): WorkerPort<MeshingWorkerRequest, MeshingWorkerResponse>;
}>;

export class WorkerWideError extends Error {
  readonly workerWide = true;

  constructor(message: string, cause: Error) {
    super(message, { cause });
    this.name = 'WorkerWideError';
  }
}

class WorkerRequestError extends Error {
  readonly request: Readonly<{ key: string; epoch: number; editVersion: number }>;

  constructor(cause: Error, request: Readonly<{ key: string; epoch: number; editVersion: number }>) {
    super(cause.message, { cause });
    this.name = 'WorkerRequestError';
    this.request = request;
  }
}

export function isWorkerWideError(reason: unknown): reason is WorkerWideError {
  return reason instanceof WorkerWideError;
}

type Pending<Response> = {
  resolve(response: Response): void;
  reject(reason: Error): void;
};

function requestId(request: { key: string; epoch: number; editVersion: number }): string {
  return `${request.key}:${request.epoch}:${request.editVersion}`;
}

function errorFromEvent(event: ErrorEvent): Error {
  if (event.error instanceof Error) return event.error;
  return new Error(event.message || 'Worker failed');
}

function bufferForTransfer(view: ArrayBufferView): ArrayBuffer {
  if (!(view.buffer instanceof ArrayBuffer)) throw new Error('Worker payload requires ArrayBuffer-backed arrays');
  return view.buffer;
}

function sectionTransferables(section: SerializedVoxelSection): Transferable[] {
  return [bufferForTransfer(section.palette), section.indices];
}

function meshRequestTransferables(request: MeshingWorkerRequest): Transferable[] {
  return [request.section, ...request.neighbors]
    .filter((section): section is SerializedVoxelSection => section !== null)
    .flatMap(sectionTransferables);
}

export class WorkerClient {
  private generationWorker: WorkerPort<GenerationWorkerRequest, GenerationWorkerResponse>;
  private meshingWorker: WorkerPort<MeshingWorkerRequest, MeshingWorkerResponse>;
  private readonly factory: WorkerFactory;
  private readonly pendingGeneration = new Map<string, Pending<GenerationWorkerResponse>>();
  private readonly pendingMeshing = new Map<string, Pending<MeshingWorkerResponse>>();
  private disposed = false;

  constructor(factory: WorkerFactory = createModuleWorkerFactory()) {
    this.factory = factory;
    this.generationWorker = this.bindGenerationWorker(factory.createGenerationWorker());
    this.meshingWorker = this.bindMeshingWorker(factory.createMeshingWorker());
  }

  private bindGenerationWorker(
    worker: WorkerPort<GenerationWorkerRequest, GenerationWorkerResponse>,
  ): WorkerPort<GenerationWorkerRequest, GenerationWorkerResponse> {
    worker.onmessage = ({ data }) => this.resolve(this.pendingGeneration, data);
    worker.onerror = (event) => this.handleGenerationError(worker, event);
    return worker;
  }

  private bindMeshingWorker(
    worker: WorkerPort<MeshingWorkerRequest, MeshingWorkerResponse>,
  ): WorkerPort<MeshingWorkerRequest, MeshingWorkerResponse> {
    worker.onmessage = ({ data }) => this.resolve(this.pendingMeshing, data);
    worker.onerror = (event) => this.handleMeshingError(worker, event);
    return worker;
  }

  private handleGenerationError(
    worker: WorkerPort<GenerationWorkerRequest, GenerationWorkerResponse>,
    event: ErrorEvent,
  ): void {
    if (this.disposed || worker !== this.generationWorker) return;
    if (event.error instanceof WorkerRequestError) {
      this.rejectOne(this.pendingGeneration, event.error.request, event.error);
      return;
    }
    const cause = errorFromEvent(event);
    this.disconnect(worker);
    this.generationWorker = this.bindGenerationWorker(this.factory.createGenerationWorker());
    this.rejectAll(this.pendingGeneration, new WorkerWideError(cause.message, cause));
  }

  private handleMeshingError(
    worker: WorkerPort<MeshingWorkerRequest, MeshingWorkerResponse>,
    event: ErrorEvent,
  ): void {
    if (this.disposed || worker !== this.meshingWorker) return;
    if (event.error instanceof WorkerRequestError) {
      this.rejectOne(this.pendingMeshing, event.error.request, event.error);
      return;
    }
    const cause = errorFromEvent(event);
    this.disconnect(worker);
    this.meshingWorker = this.bindMeshingWorker(this.factory.createMeshingWorker());
    this.rejectAll(this.pendingMeshing, new WorkerWideError(cause.message, cause));
  }

  private disconnect<Request, Response>(worker: WorkerPort<Request, Response>): void {
    worker.terminate();
    worker.onmessage = null;
    worker.onerror = null;
  }

  private rejectOne<Response>(
    pending: Map<string, Pending<Response>>,
    request: Readonly<{ key: string; epoch: number; editVersion: number }>,
    error: Error,
  ): void {
    const id = requestId(request);
    const current = pending.get(id);
    if (!current) return;
    pending.delete(id);
    current.reject(error);
  }

  generate(request: GenerationWorkerRequest): Promise<GenerationWorkerResponse> {
    return this.submit(this.pendingGeneration, request, () => this.generationWorker.postMessage(request));
  }

  mesh(request: MeshingWorkerRequest): Promise<MeshingWorkerResponse> {
    return this.submit(
      this.pendingMeshing,
      request,
      () => this.meshingWorker.postMessage(request, meshRequestTransferables(request)),
    );
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generationWorker.terminate();
    this.meshingWorker.terminate();
    this.generationWorker.onmessage = null;
    this.generationWorker.onerror = null;
    this.meshingWorker.onmessage = null;
    this.meshingWorker.onerror = null;
    const error = new Error('WorkerClient disposed');
    this.rejectAll(this.pendingGeneration, error);
    this.rejectAll(this.pendingMeshing, error);
  }

  private submit<Request extends { key: string; epoch: number; editVersion: number }, Response>(
    pending: Map<string, Pending<Response>>,
    request: Request,
    post: () => void,
  ): Promise<Response> {
    if (this.disposed) return Promise.reject(new Error('WorkerClient disposed'));
    const id = requestId(request);
    if (pending.has(id)) return Promise.reject(new Error(`Duplicate worker request ${id}`));
    return new Promise<Response>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      try {
        post();
      } catch (error) {
        pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private resolve<Response extends { key: string; epoch: number; editVersion: number }>(
    pending: Map<string, Pending<Response>>,
    response: Response,
  ): void {
    const id = requestId(response);
    const request = pending.get(id);
    if (!request) return;
    pending.delete(id);
    request.resolve(response);
  }

  private rejectAll<Response>(pending: Map<string, Pending<Response>>, error: Error): void {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  }
}

function createInProcessPort<
  Request extends { key: string; epoch: number; editVersion: number },
  Response,
>(
  handler: (request: Request) => Response,
  responseTransferables: (response: Response) => Transferable[],
): WorkerPort<Request, Response> {
  let terminated = false;
  const port: WorkerPort<Request, Response> = {
    onmessage: null,
    onerror: null,
    postMessage(message, transfer = []) {
      const requestCopy = structuredClone(message, { transfer });
      queueMicrotask(() => {
        if (terminated) return;
        try {
          const response = handler(requestCopy);
          const data = structuredClone(response, { transfer: responseTransferables(response) });
          port.onmessage?.({ data } as MessageEvent<Response>);
        } catch (error) {
          const reason = error instanceof Error ? error : new Error(String(error));
          const requestError = new WorkerRequestError(reason, requestCopy);
          port.onerror?.({ error: requestError, message: requestError.message } as ErrorEvent);
        }
      });
    },
    terminate() {
      terminated = true;
    },
  };
  return port;
}

export function createInProcessWorkerFactory(): WorkerFactory {
  return {
    createGenerationWorker: () => createInProcessPort(handleGenerationRequest, generationTransferables),
    createMeshingWorker: () => createInProcessPort(handleMeshingRequest, meshingTransferables),
  };
}

export function createModuleWorkerFactory(): WorkerFactory {
  return {
    createGenerationWorker: () => new Worker(
      new URL('./generation.worker.ts', import.meta.url),
      { type: 'module' },
    ),
    createMeshingWorker: () => new Worker(
      new URL('./meshing.worker.ts', import.meta.url),
      { type: 'module' },
    ),
  };
}
