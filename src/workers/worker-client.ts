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
  private readonly generationWorker: WorkerPort<GenerationWorkerRequest, GenerationWorkerResponse>;
  private readonly meshingWorker: WorkerPort<MeshingWorkerRequest, MeshingWorkerResponse>;
  private readonly pendingGeneration = new Map<string, Pending<GenerationWorkerResponse>>();
  private readonly pendingMeshing = new Map<string, Pending<MeshingWorkerResponse>>();
  private disposed = false;

  constructor(factory: WorkerFactory = createModuleWorkerFactory()) {
    this.generationWorker = factory.createGenerationWorker();
    this.meshingWorker = factory.createMeshingWorker();
    this.generationWorker.onmessage = ({ data }) => this.resolve(this.pendingGeneration, data);
    this.meshingWorker.onmessage = ({ data }) => this.resolve(this.pendingMeshing, data);
    this.generationWorker.onerror = (event) => this.rejectAll(this.pendingGeneration, errorFromEvent(event));
    this.meshingWorker.onerror = (event) => this.rejectAll(this.pendingMeshing, errorFromEvent(event));
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

function createInProcessPort<Request, Response>(
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
          port.onerror?.({ error: reason, message: reason.message } as ErrorEvent);
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
