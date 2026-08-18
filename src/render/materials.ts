import {
  DataTexture,
  DoubleSide,
  NearestFilter,
  RGBAFormat,
  SRGBColorSpace,
  UnsignedByteType,
  Vector3,
} from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import {
  attribute,
  float,
  floor,
  max,
  mod,
  normalize,
  texture,
  uniform,
  uv,
  vec2,
} from 'three/tsl';
import { ATLAS_COLUMNS } from './texture-atlas';
import type { BuiltAtlas } from './texture-atlas';

const ATLAS_LAYERS = 256;

export type LightingState = Readonly<{
  sunEnabled: boolean;
  aoEnabled: boolean;
  emissiveEnabled: boolean;
}>;

export type TerrainMaterials = Readonly<{
  opaque: MeshBasicNodeMaterial;
  cutout: MeshBasicNodeMaterial;
  translucent: MeshBasicNodeMaterial;
  dispose(): void;
}>;

type UniformRef = { value: number };

type LightingUniformRefs = Readonly<{
  sunIntensity: UniformRef;
  ambientIntensity: UniformRef;
  aoStrength: UniformRef;
  emissiveStrength: UniformRef;
}>;

const lightingRefs = new Map<MeshBasicNodeMaterial, LightingUniformRefs>();

export function createTerrainMaterials(atlas: BuiltAtlas): TerrainMaterials {
  const atlasRows = Math.max(1, Math.ceil(atlas.tileCount / ATLAS_COLUMNS));
  const sunDirection = uniform(new Vector3(0.35, 0.8, 0.35).normalize());
  const sunIntensity = uniform(1.0);
  const ambientIntensity = uniform(0.55);
  const aoStrength = uniform(1.0);
  const emissiveStrength = uniform(1.0);

  const column = mod(attribute<'float'>('tileId', 'float'), ATLAS_COLUMNS);
  const row = floor(attribute<'float'>('tileId', 'float').div(ATLAS_COLUMNS));
  const atlasUv = vec2(
    column.add(uv().x).div(ATLAS_COLUMNS),
    float(1).sub(row.add(float(1)).sub(uv().y).div(atlasRows)),
  );
  const albedo = texture(atlas.texture, atlasUv);
  const diffuse = max(
    normalize(attribute<'vec3'>('normal', 'vec3')).dot(normalize(sunDirection)),
    0,
  ).mul(sunIntensity).add(ambientIntensity);
  const aoFactor = float(1).sub(
    float(1).sub(attribute<'float'>('ao', 'float').div(3)).mul(aoStrength),
  );
  const emissiveTerm = texture(
    atlas.emissive,
    vec2(attribute<'float'>('tileId', 'float').add(0.5).div(atlas.tileCount), 0.5),
  ).mul(emissiveStrength);
  const colorNode = albedo.mul(diffuse.mul(aoFactor)).add(emissiveTerm);

  const opaque = new MeshBasicNodeMaterial();
  opaque.colorNode = colorNode;

  const cutout = new MeshBasicNodeMaterial({ alphaTest: 0.5, side: DoubleSide });
  cutout.colorNode = colorNode;

  const translucent = new MeshBasicNodeMaterial({ transparent: true, depthWrite: false });
  translucent.colorNode = colorNode;

  const refs: LightingUniformRefs = {
    sunIntensity,
    ambientIntensity,
    aoStrength,
    emissiveStrength,
  };
  lightingRefs.set(opaque, refs);
  lightingRefs.set(cutout, refs);
  lightingRefs.set(translucent, refs);

  return Object.freeze({
    opaque,
    cutout,
    translucent,
    dispose() {
      for (const material of [opaque, cutout, translucent]) {
        lightingRefs.delete(material);
        material.dispose();
      }
    },
  });
}

export function applyLighting(materials: TerrainMaterials, state: LightingState): void {
  const refs = [materials.opaque, materials.cutout, materials.translucent].map((material) => {
    const found = lightingRefs.get(material);
    if (!found) throw new Error('Terrain material is missing lighting uniforms');
    return found;
  });
  for (const current of refs) {
    current.sunIntensity.value = state.sunEnabled ? 1 : 0;
    current.ambientIntensity.value = state.sunEnabled ? 0.55 : 1;
    current.aoStrength.value = state.aoEnabled ? 1 : 0;
    current.emissiveStrength.value = state.emissiveEnabled ? 1 : 0;
  }
}

// ---- 阶段 1 的共享材质租约，Task 7 前由 RenderPage 使用，之后删除 ----

function channel(id: number, salt: number): number {
  let value = Math.imul(id + salt, 0x45d9f3b);
  value = Math.imul(value ^ (value >>> 16), 0x45d9f3b);
  return 64 + ((value ^ (value >>> 16)) & 0x7f);
}

function createAtlas(): DataTexture {
  const pixels = new Uint8Array(ATLAS_LAYERS * 4);
  pixels[3] = 0;
  for (let id = 1; id < ATLAS_LAYERS; id += 1) {
    const offset = id * 4;
    pixels[offset] = channel(id, 11);
    pixels[offset + 1] = channel(id, 37);
    pixels[offset + 2] = channel(id, 71);
    pixels[offset + 3] = 255;
  }
  const atlas = new DataTexture(pixels, ATLAS_LAYERS, 1, RGBAFormat, UnsignedByteType);
  atlas.colorSpace = SRGBColorSpace;
  atlas.magFilter = NearestFilter;
  atlas.minFilter = NearestFilter;
  atlas.generateMipmaps = false;
  atlas.needsUpdate = true;
  return atlas;
}

type SharedResources = {
  atlas: DataTexture;
  material: MeshBasicNodeMaterial;
  references: number;
};

export type BlockMaterialLease = Readonly<{
  material: MeshBasicNodeMaterial;
  release(): void;
}>;

let sharedResources: SharedResources | null = null;

function createResources(): SharedResources {
  const atlas = createAtlas();
  const material = new MeshBasicNodeMaterial();
  const atlasUv = vec2(
    attribute<'float'>('tileId', 'float').add(0.5).div(ATLAS_LAYERS),
    0.5,
  );
  material.colorNode = texture(atlas, atlasUv);
  material.userData.blockAtlas = atlas;
  return { atlas, material, references: 0 };
}

/** Acquires one lease on the process-shared block atlas and node material. */
export function acquireBlockMaterial(): BlockMaterialLease {
  const resources = sharedResources ?? createResources();
  sharedResources = resources;
  resources.references += 1;
  let released = false;
  return {
    material: resources.material,
    release() {
      if (released) return;
      released = true;
      resources.references -= 1;
      if (resources.references !== 0) return;
      resources.material.dispose();
      resources.atlas.dispose();
      if (sharedResources === resources) sharedResources = null;
    },
  };
}
