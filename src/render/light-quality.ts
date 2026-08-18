export type LightQuality = 'low' | 'medium' | 'high';

export type QualityPreset = Readonly<{
  renderScale: number;
  sunEnabled: boolean;
  aoEnabled: boolean;
  emissiveEnabled: boolean;
  rainParticleCount: number;
}>;

export const LIGHT_QUALITY_PRESETS: Readonly<Record<LightQuality, QualityPreset>> = Object.freeze({
  low: Object.freeze({
    renderScale: 0.6,
    sunEnabled: false,
    aoEnabled: false,
    emissiveEnabled: false,
    rainParticleCount: 250,
  }),
  medium: Object.freeze({
    renderScale: 0.8,
    sunEnabled: true,
    aoEnabled: false,
    emissiveEnabled: true,
    rainParticleCount: 450,
  }),
  high: Object.freeze({
    renderScale: 1.0,
    sunEnabled: true,
    aoEnabled: true,
    emissiveEnabled: true,
    rainParticleCount: 700,
  }),
});
