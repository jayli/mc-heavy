import type { GenerationWorkerRequest, GenerationWorkerResponse } from './protocol';
import { generationTransferables, handleGenerationRequest } from './work-handlers';

type GenerationWorkerScope = {
  addEventListener(type: 'message', listener: (event: MessageEvent<GenerationWorkerRequest>) => void): void;
  postMessage(message: GenerationWorkerResponse, transfer: Transferable[]): void;
};

const workerScope = globalThis as unknown as GenerationWorkerScope;
workerScope.addEventListener('message', ({ data }) => {
  const response = handleGenerationRequest(data);
  workerScope.postMessage(response, generationTransferables(response));
});
