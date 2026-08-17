export type BackendCapabilities = {
  gpu?: unknown;
  createWebGL2Context?: () => unknown | null;
};

export function detectRenderBackend(
  capabilities: BackendCapabilities,
): 'webgpu' | 'webgl2' | 'unsupported' {
  if (capabilities.gpu) return 'webgpu';
  if (capabilities.createWebGL2Context?.()) return 'webgl2';
  return 'unsupported';
}
