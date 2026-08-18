export type MovementInput = Readonly<{ x: number; z: number }>;

/**
 * Maps WASD/arrow keys to a camera-relative horizontal input vector. The
 * controller receives world-space movement, so forward is the horizontal
 * facing direction and strafe is its right-hand perpendicular.
 */
export function movementInputFromKeys(keys: ReadonlySet<string>, yaw: number): MovementInput {
  const forward = Number(keys.has('w') || keys.has('arrowup'))
    - Number(keys.has('s') || keys.has('arrowdown'));
  const strafe = Number(keys.has('d') || keys.has('arrowright'))
    - Number(keys.has('a') || keys.has('arrowleft'));
  if (forward === 0 && strafe === 0) return Object.freeze({ x: 0, z: 0 });

  const facingX = -Math.sin(yaw);
  const facingZ = -Math.cos(yaw);
  const rightX = Math.cos(yaw);
  const rightZ = -Math.sin(yaw);
  const x = forward * facingX + strafe * rightX;
  const z = forward * facingZ + strafe * rightZ;
  return Object.freeze({
    x: x === 0 ? 0 : x,
    z: z === 0 ? 0 : z,
  });
}
