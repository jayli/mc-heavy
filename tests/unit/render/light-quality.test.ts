import { describe, expect, it } from 'vitest';
import { LIGHT_QUALITY_PRESETS } from '../../../src/render/light-quality';

describe('LIGHT_QUALITY_PRESETS', () => {
  it('uses the spec render scale and rain density per tier', () => {
    expect(LIGHT_QUALITY_PRESETS.low).toMatchObject({
      renderScale: 0.6,
      sunEnabled: false,
      aoEnabled: false,
      emissiveEnabled: false,
      rainParticleCount: 250,
    });
    expect(LIGHT_QUALITY_PRESETS.medium).toMatchObject({
      renderScale: 0.8,
      sunEnabled: true,
      aoEnabled: false,
      emissiveEnabled: true,
      rainParticleCount: 450,
    });
    expect(LIGHT_QUALITY_PRESETS.high).toMatchObject({
      renderScale: 1.0,
      sunEnabled: true,
      aoEnabled: true,
      emissiveEnabled: true,
      rainParticleCount: 700,
    });
  });
});
