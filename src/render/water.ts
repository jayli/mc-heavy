import { Mesh, MeshBasicMaterial, PlaneGeometry } from 'three';

type CameraPosition = Readonly<{ x: number; z: number }>;

/** One camera-following water plane; updates mutate transforms/material uniforms only. */
export class WaterSurface {
  readonly geometry = new PlaneGeometry(4_096, 4_096, 1, 1);
  private readonly material = new MeshBasicMaterial({
    color: 0x3a8fb7,
    opacity: 0.68,
    transparent: true,
    depthWrite: false,
  });
  private readonly mesh = new Mesh(this.geometry, this.material);
  private position: CameraPosition = { x: 0, z: 0 };
  private timeMs = 0;
  private disposed = false;

  constructor() {
    this.mesh.name = 'water-surface';
    this.mesh.rotation.x = -Math.PI / 2;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.updateMatrix();
  }

  renderObject(): Mesh<PlaneGeometry, MeshBasicMaterial> {
    return this.mesh;
  }

  update(cameraPosition: CameraPosition, timeMs: number): void {
    if (this.disposed) return;
    this.position = { x: cameraPosition.x, z: cameraPosition.z };
    this.timeMs = timeMs;
    this.mesh.userData.timeMs = timeMs;
    this.mesh.position.set(cameraPosition.x, 0, cameraPosition.z);
    this.material.opacity = 0.66 + Math.sin(timeMs * 0.001) * 0.02;
    this.mesh.updateMatrix();
  }

  diagnostics(): Readonly<{
    position: CameraPosition;
    timeMs: number;
  }> {
    return { position: this.position, timeMs: this.timeMs };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.geometry.dispose();
    this.material.dispose();
  }
}
