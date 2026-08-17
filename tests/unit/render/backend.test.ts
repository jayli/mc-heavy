import { describe, expect, it } from 'vitest';
import { detectRenderBackend } from '../../../src/render/backend';

describe('detectRenderBackend', () => {
  it('prefers WebGPU when navigator exposes gpu', () => {
    expect(detectRenderBackend({ gpu: {} })).toBe('webgpu');
  });

  it('uses WebGL2 only when WebGPU is absent and a WebGL2 factory exists', () => {
    expect(detectRenderBackend({ createWebGL2Context: () => ({}) })).toBe('webgl2');
  });

  it('reports unsupported when neither capability is available', () => {
    expect(detectRenderBackend({})).toBe('unsupported');
  });
});
