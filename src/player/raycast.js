// src/player/raycast.js — Amanatides-Woo DDA 体素射线（§4.5.2，DR-4）
// O(距离) 次 getBlockId；替代 mc-lite 每帧 Raycaster.intersectObjects 数万次矩阵求交。

/**
 * @param {import('../voxel/world-data.js').WorldData} world
 * @param {number[]} origin [x,y,z]
 * @param {number[]} dir 归一化方向 [dx,dy,dz]
 * @param {number} [maxDist=40]
 * @param {(id: number) => boolean} [occludes] 遮挡判据（M8）：缺省 = 既有语义
 *        「非空气且非水即命中」。弹丸传 `isProjectileOccluding`（实心且不透明才阻挡）——
 *        玻璃/树叶/云等透明方块可穿透。
 *        ⚠️ **加参数而非写第二份 DDA**（红线 1：同一事实的两个副本会漂移出
 *        「炮塔看得见但弹丸打不着」）。既有三个消费者（`player.js` ×2 / `test-raycast.js`）
 *        不传第五参数 → 行为完全不变。
 * @param {(x: number, y: number, z: number, t: number) => boolean} [onCell]
 *        逐格访问回调（未命中时的放置兜底，`place-ray.js`）：按 DDA 顺序对**每一格**调一次
 *        （含起点格），返回 true = 立刻中止遍历并返回 `{hit:false, aborted:true}`。
 *        ⚠️ 与 `occludes` 的分工：`occludes` 只回「这一格算不算命中」，回调能看**坐标**
 *        与**距离**，故「找最近的可贴格」这类需要看邻居的用途只能走它。
 *        ⚠️ 缺省 null 时每格只多一次 `!== null` 比较（热路径：玩家每帧 1 次 + 弹丸每步 1 次）。
 * @returns {{hit: boolean, blockPos?: number[], normal?: number[], prevPos?: number[], dist?: number,
 *            aborted?: boolean}}
 *          ⚠️ **未命中返回 `{hit:false}`（truthy 对象），不是 null** → 调用方必须判 `.hit`；
 *          写成 `if (blockHit)` 会让每次判定都立刻判「撞方块」（M8 弹丸踩过这条）。
 */
export function raycastVoxel(world, origin, dir, maxDist = 40, occludes = null, onCell = null) {
  let [x, y, z] = origin;
  let ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const [dx, dy, dz] = dir;
  const stepX = dx > 0 ? 1 : -1, stepY = dy > 0 ? 1 : -1, stepZ = dz > 0 ? 1 : -1;
  const tDeltaX = dx !== 0 ? Math.abs(1 / dx) : Infinity;
  const tDeltaY = dy !== 0 ? Math.abs(1 / dy) : Infinity;
  const tDeltaZ = dz !== 0 ? Math.abs(1 / dz) : Infinity;
  let tMaxX = dx !== 0 ? ((dx > 0 ? ix + 1 - x : x - ix) * tDeltaX) : Infinity;
  let tMaxY = dy !== 0 ? ((dy > 0 ? iy + 1 - y : y - iy) * tDeltaY) : Infinity;
  let tMaxZ = dz !== 0 ? ((dz > 0 ? iz + 1 - z : z - iz) * tDeltaZ) : Infinity;
  let normal = [0, 0, 0];
  let prev = [ix, iy, iz];
  let t = 0;
  const maxSteps = Math.ceil(maxDist * 3);
  const waterId = world.registry.idOf('water');
  // 遮挡判据：传入则用它（弹丸的「实心且不透明才阻挡」），否则保持既有语义
  const hitTest = occludes ? occludes : (id) => id !== 0 && id !== waterId;

  for (let i = 0; i < maxSteps && t <= maxDist; i++) {
    if (onCell !== null && onCell(ix, iy, iz, t)) return { hit: false, aborted: true };
    const id = world.getBlockId(ix, iy, iz);
    if (hitTest(id)) {
      return { hit: true, blockPos: [ix, iy, iz], normal, prevPos: prev, dist: t };
    }
    prev = [ix, iy, iz];
    if (tMaxX < tMaxY && tMaxX < tMaxZ) {
      ix += stepX; t = tMaxX; tMaxX += tDeltaX; normal = [-stepX, 0, 0];
    } else if (tMaxY < tMaxZ) {
      iy += stepY; t = tMaxY; tMaxY += tDeltaY; normal = [0, -stepY, 0];
    } else {
      iz += stepZ; t = tMaxZ; tMaxZ += tDeltaZ; normal = [0, 0, -stepZ];
    }
  }
  return { hit: false };
}
