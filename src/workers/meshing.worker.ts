import type { MeshingWorkerRequest, MeshingWorkerResponse } from './protocol';
import { handleMeshingRequest, meshingTransferables } from './work-handlers';

type MeshingWorkerScope = {
  addEventListener(type: 'message', listener: (event: MessageEvent<MeshingWorkerRequest>) => void): void;
  postMessage(message: MeshingWorkerResponse, transfer: Transferable[]): void;
};

const workerScope = globalThis as unknown as MeshingWorkerScope;
workerScope.addEventListener('message', ({ data }) => {
  const response = handleMeshingRequest(data);
  workerScope.postMessage(response, meshingTransferables(response));
});
