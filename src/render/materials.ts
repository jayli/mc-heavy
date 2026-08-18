import {
  DataTexture,
  NearestFilter,
  RGBAFormat,
  SRGBColorSpace,
  UnsignedByteType,
} from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import { attribute, texture, vec2 } from 'three/tsl';

const ATLAS_LAYERS = 256;

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
