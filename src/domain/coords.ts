export const SECTION_SIZE = 16;

export type BlockPos = Readonly<{ x: number; y: number; z: number }>;
export type SectionPos = Readonly<{ x: number; y: number; z: number }>;
export type Vec3 = Readonly<{ x: number; y: number; z: number }>;

const floorDiv = (value: number): number => Math.floor(value / SECTION_SIZE);
const mod = (value: number): number => ((value % SECTION_SIZE) + SECTION_SIZE) % SECTION_SIZE;

export const sectionOf = ({ x, y, z }: BlockPos): SectionPos => ({
  x: floorDiv(x),
  y: floorDiv(y),
  z: floorDiv(z),
});

export const localIndex = ({ x, y, z }: BlockPos): number => mod(x) | (mod(z) << 4) | (mod(y) << 8);

export const localPos = (index: number): BlockPos => ({
  x: index & 15,
  z: (index >>> 4) & 15,
  y: (index >>> 8) & 15,
});
