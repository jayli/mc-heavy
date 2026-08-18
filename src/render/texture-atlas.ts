import { blockRegistry, type BlockDefinition, type FaceIndex } from '../domain/blocks';
import {
  SYNTHETIC_TILES,
  TEXTURE_FILES,
  TILE_COUNT,
  type SyntheticTile,
} from '../domain/texture-tiles';
import {
  DataTexture,
  NearestFilter,
  RedFormat,
  RGBAFormat,
  SRGBColorSpace,
  UnsignedByteType,
} from 'three';

export const ATLAS_COLUMNS = 16;
export const ATLAS_TILE_SIZE = 16;

export type TileInput = Readonly<{
  width: number;
  height: number;
  rgba?: Uint8ClampedArray;
}>;

export type PackedAtlas = Readonly<{
  pixels: Uint8ClampedArray;
  emissive: Uint8Array;
  tileSize: number;
  columns: number;
  rows: number;
}>;

export type BuiltAtlas = Readonly<{
  texture: DataTexture;
  emissive: DataTexture;
  tileCount: number;
  columns: number;
  rows: number;
  failedTiles: readonly string[];
}>;

export function packTextureAtlas(
  tiles: readonly TileInput[],
  emissiveByTile: Uint8Array,
  columns: number,
  tileSize: number,
): PackedAtlas {
  if (columns <= 0 || tileSize <= 0) throw new Error('Atlas columns and tile size must be positive');
  if (emissiveByTile.length < tiles.length) throw new Error('Atlas emissive table must cover every tile');
  const rows = Math.max(1, Math.ceil(tiles.length / columns));
  const pixels = new Uint8ClampedArray(columns * tileSize * rows * tileSize * 4);

  for (let tileId = 0; tileId < tiles.length; tileId += 1) {
    const column = tileId % columns;
    const row = Math.floor(tileId / columns);
    const tile = tiles[tileId];
    const valid = tile.rgba !== undefined
      && tile.width === tileSize
      && tile.height === tileSize
      && tile.rgba.length === tileSize * tileSize * 4;
    for (let y = 0; y < tileSize; y += 1) {
      for (let x = 0; x < tileSize; x += 1) {
        const targetOffset = ((row * tileSize + y) * columns * tileSize + column * tileSize + x) * 4;
        if (valid) {
          const sourceOffset = (y * tileSize + x) * 4;
          pixels[targetOffset] = tile.rgba![sourceOffset];
          pixels[targetOffset + 1] = tile.rgba![sourceOffset + 1];
          pixels[targetOffset + 2] = tile.rgba![sourceOffset + 2];
          pixels[targetOffset + 3] = tile.rgba![sourceOffset + 3];
        } else {
          pixels[targetOffset] = 255;
          pixels[targetOffset + 1] = 0;
          pixels[targetOffset + 2] = 255;
          pixels[targetOffset + 3] = 255;
        }
      }
    }
  }

  return {
    pixels,
    emissive: Uint8Array.from(emissiveByTile.subarray(0, tiles.length)),
    tileSize,
    columns,
    rows,
  };
}

export type AtlasImage = Readonly<{
  width: number;
  height: number;
  close?(): void;
}>;

export type AtlasOptions = Readonly<{
  loadImage?: (name: string) => Promise<AtlasImage>;
  scaleToTile?: (image: AtlasImage, tileSize: number) => Uint8ClampedArray | null;
}>;

async function loadBrowserImage(name: string): Promise<AtlasImage> {
  const response = await fetch(`/assets/textures/${name}`);
  if (!response.ok) throw new Error(`Texture fetch failed: ${name} (${response.status})`);
  return response.blob().then((blob) => createImageBitmap(blob));
}

function scaleWithCanvas(image: AtlasImage, tileSize: number): Uint8ClampedArray | null {
  const canvas = new OffscreenCanvas(tileSize, tileSize);
  const context = canvas.getContext('2d');
  if (!context) return null;
  context.imageSmoothingEnabled = false;
  context.drawImage(image as CanvasImageSource, 0, 0, tileSize, tileSize);
  return context.getImageData(0, 0, tileSize, tileSize).data;
}

function drawSynthetic(draw: 'flower' | 'vine' | 'lilypad', tileSize: number): Uint8ClampedArray {
  const canvas = new OffscreenCanvas(tileSize, tileSize);
  const context = canvas.getContext('2d');
  if (!context) return new Uint8ClampedArray(tileSize * tileSize * 4);
  if (draw === 'flower') {
    context.fillStyle = '#2E8B57';
    context.fillRect(7, 8, 2, 8);
    context.fillStyle = '#FF4444';
    context.beginPath();
    context.arc(8, 8, 4, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = '#FFD700';
    context.beginPath();
    context.arc(8, 8, 1.5, 0, Math.PI * 2);
    context.fill();
  } else if (draw === 'vine') {
    context.strokeStyle = '#355E3B';
    context.lineWidth = 1.5;
    for (let index = 0; index < 4; index += 1) {
      context.beginPath();
      context.moveTo(3 + index * 3, 0);
      context.bezierCurveTo(6 + index, 5, 2 + index, 11, 3 + index * 3, tileSize);
      context.stroke();
    }
  } else {
    context.fillStyle = '#228B22';
    context.beginPath();
    context.arc(8, 8, 6.5, 0.3, Math.PI * 1.8);
    context.lineTo(8, 8);
    context.closePath();
    context.fill();
  }
  return context.getImageData(0, 0, tileSize, tileSize).data;
}

function emissiveByTile(): Uint8Array {
  const emissive = new Uint8Array(TILE_COUNT);
  const faceTiles = new Map<number, BlockDefinition[]>();
  for (const definition of valuesOf(blockRegistry)) {
    for (let face = 0; face <= 5; face += 1) {
      for (let orientation = 0; orientation < 4; orientation += 1) {
        const tile = blockRegistry.tileForFace(definition.id, face as FaceIndex, orientation);
        const owners = faceTiles.get(tile) ?? [];
        owners.push(definition);
        faceTiles.set(tile, owners);
      }
    }
  }
  for (const [tile, owners] of faceTiles) {
    emissive[tile] = Math.min(255, Math.round(Math.max(...owners.map((owner) => owner.emissive)) * 255));
  }
  return emissive;
}

function valuesOf(registry: { byId(id: number): BlockDefinition }): BlockDefinition[] {
  const definitions: BlockDefinition[] = [];
  for (let id = 0; ; id += 1) {
    try {
      definitions.push(registry.byId(id));
    } catch {
      return definitions;
    }
  }
}

export async function buildTextureAtlas(options: AtlasOptions = {}): Promise<BuiltAtlas> {
  const loadImage = options.loadImage ?? loadBrowserImage;
  const scaleToTile = options.scaleToTile ?? scaleWithCanvas;
  const tiles: TileInput[] = new Array<TileInput>(TILE_COUNT);
  const failedTiles: string[] = [];

  for (let id = 0; id < TEXTURE_FILES.length; id += 1) {
    const name = TEXTURE_FILES[id];
    try {
      const image = await loadImage(name);
      try {
        tiles[id] = { width: ATLAS_TILE_SIZE, height: ATLAS_TILE_SIZE, rgba: scaleToTile(image, ATLAS_TILE_SIZE) ?? undefined };
      } finally {
        image.close?.();
      }
    } catch {
      failedTiles.push(name);
      tiles[id] = { width: ATLAS_TILE_SIZE, height: ATLAS_TILE_SIZE };
    }
  }

  for (let id = 0; id < SYNTHETIC_TILES.length; id += 1) {
    const spec: SyntheticTile = SYNTHETIC_TILES[id];
    const tileId = TEXTURE_FILES.length + id;
    if (spec.draw) {
      tiles[tileId] = {
        width: ATLAS_TILE_SIZE,
        height: ATLAS_TILE_SIZE,
        rgba: drawSynthetic(spec.draw, ATLAS_TILE_SIZE),
      };
      continue;
    }
    const color = spec.color ?? '#FF00FF';
    const rgba = new Uint8ClampedArray(ATLAS_TILE_SIZE * ATLAS_TILE_SIZE * 4);
    const parsed = hexColor(color);
    for (let offset = 0; offset < rgba.length; offset += 4) {
      rgba[offset] = parsed[0];
      rgba[offset + 1] = parsed[1];
      rgba[offset + 2] = parsed[2];
      rgba[offset + 3] = 255;
    }
    tiles[tileId] = { width: ATLAS_TILE_SIZE, height: ATLAS_TILE_SIZE, rgba };
  }

  const packed = packTextureAtlas(tiles, emissiveByTile(), ATLAS_COLUMNS, ATLAS_TILE_SIZE);
  const texture = new DataTexture(
    packed.pixels,
    packed.columns * packed.tileSize,
    packed.rows * packed.tileSize,
    RGBAFormat,
    UnsignedByteType,
  );
  texture.colorSpace = SRGBColorSpace;
  texture.magFilter = NearestFilter;
  texture.minFilter = NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;

  const emissiveTexture = new DataTexture(
    packed.emissive,
    packed.emissive.length,
    1,
    RedFormat,
    UnsignedByteType,
  );
  emissiveTexture.magFilter = NearestFilter;
  emissiveTexture.minFilter = NearestFilter;
  emissiveTexture.generateMipmaps = false;
  emissiveTexture.needsUpdate = true;

  return {
    texture,
    emissive: emissiveTexture,
    tileCount: TILE_COUNT,
    columns: packed.columns,
    rows: packed.rows,
    failedTiles,
  };
}

function hexColor(value: string): readonly [number, number, number] {
  const hex = value.replace('#', '');
  const channel = (start: number): number => Number.parseInt(hex.slice(start, start + 2), 16);
  return [channel(0), channel(2), channel(4)];
}
