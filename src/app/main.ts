import { detectRenderBackend, type BackendCapabilities } from '../render/backend';

const capabilities: BackendCapabilities = {
  gpu: (navigator as Navigator & { gpu?: unknown }).gpu,
  createWebGL2Context: () => document.createElement('canvas').getContext('webgl2'),
};

const root = document.createElement('main');
root.textContent = `Render backend: ${detectRenderBackend(capabilities)}`;
document.body.append(root);
