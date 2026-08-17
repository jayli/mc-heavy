import { Group, Mesh, MeshBasicMaterial, RingGeometry } from 'three';

type CameraPosition = Readonly<{ x: number; z: number }>;

const RING_RADII: readonly (readonly [number, number])[] = [
  [128, 256],
  [256, 512],
  [512, 1_024],
  [1_024, 2_048],
];

/** Fixed-size far-terrain placeholders that follow the camera independently of section streaming. */
export class TerrainLod {
  private readonly group = new Group();
  private readonly material = new MeshBasicMaterial({ color: 0x557744, depthWrite: false });
  private readonly rings: readonly Mesh<RingGeometry, MeshBasicMaterial>[];
  private center: CameraPosition = { x: 0, z: 0 };
  private disposed = false;

  constructor() {
    this.group.name = 'terrain-lod';
    this.rings = RING_RADII.map(([inner, outer]) => {
      const ring = new Mesh(new RingGeometry(inner, outer, 64), this.material);
      ring.name = 'terrain-lod-ring';
      ring.rotation.x = -Math.PI / 2;
      ring.updateMatrix();
      this.group.add(ring);
      return ring;
    });
  }

  renderObject(): Group {
    return this.group;
  }

  update(cameraPosition: CameraPosition): void {
    if (this.disposed) return;
    this.center = { x: cameraPosition.x, z: cameraPosition.z };
    this.group.position.set(cameraPosition.x, 0, cameraPosition.z);
    this.group.updateMatrix();
  }

  diagnostics(): Readonly<{
    center: CameraPosition;
    ringCount: number;
    geometryIds: readonly number[];
  }> {
    return {
      center: this.center,
      ringCount: this.rings.length,
      geometryIds: this.rings.map((ring) => ring.geometry.id),
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const ring of this.rings) ring.geometry.dispose();
    this.material.dispose();
    this.group.clear();
  }
}
