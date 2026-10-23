// src/player/place-ray.js — 未命中时的放置兜底：沿视线找「最近的可贴格」（v1.70）
//
// 对齐 mc-lite `PlayerInteraction.js:781-806` 的 `doSkyPlace()`：玩家准心对着空气
// （前方没有任何方块）时，仍要能贴着**最近的**方块面放置方块。
//
// ⚠️ **与原版的关键差异（有意）**：mc-lite 是在「命中的方块距离 ≥ 15」时才调它，
// 本仓库的调用时机是 `player.target === null`（完全未命中）——与玩家在此处裁定的一致。
// 理由：本仓 `raycastVoxel` 的 `REACH = 40` 是枪械语义，若按「距离 ≥ 15」分流，
// 会对 15 格外的方块**放弃摆到它面上**而改去贴别的东西。语义见 `player.js placeBlock()`。
//
// 三个判据（缺一不可）：
//   ① 该格本身非实心                     —— 否则放在方块里
//   ①b 沿途没有更早的实心格（遮挡）       —— 否则会放到墙后（相机看不到的地方）
//   ② 至少一个**正交**邻居是实心          —— 否则是「凭空放空中方块」
//   ③ 没有任何实心邻居位于视线前方        —— 否则正对着的那面墙也会被贴上一块
//
// ①b 与 ③ 的分工（两条都在 mc-lite 的 `doSkyPlace` 里，不能只留一条）：
//   ①b 管「沿途」，③ 管「候选格自己的邻居」—— 前者防墙后放块，后者防把正对的那面墙
//   再贴一层（那面墙本该由常规 `prevPos` 路径处理）。
//
// ③ 的判据是 `dot(视线, 该邻居方向) > 0.01`：邻居在视线前方（含正前方）即否决。
// 这 0.01 的余量与 mc-lite 同值 —— 它排除的是「视线几乎平行于该面」的擦边情形，
// 此时玩家显然不是想贴那一面。
import { raycastVoxel } from './raycast.js';

/**
 * 沿视线搜索可贴格的最大距离（格）。
 *
 * **= mc-lite `doSkyPlace()` 的 `maxDist = 15`**（`PlayerInteraction.js:783`）。
 * ⚠️ 与 `player.js` 的 `REACH = 40` **不是一个口径**：后者是枪械射程（mc-lite `raycaster.far`
 * 的同源值），放置兜底只用 15 格 —— 否则远处天空会冒出方块。
 */
export const PLACE_RAY_MAX_DIST = 15;

/**
 * 兜底搜索的步长（格）—— mc-lite 的 `step = 0.1`。
 * ⚠️ **本仓库不用它步进**（见 `findPlaceCell` 的注释）；保留是为了让「射程 15 格」这个
 * 上游口径有据可查，同时也用作「步数上界」的自证：15 / 0.1 = 150 格采样点。
 */
export const PLACE_RAY_STEP = 0.1;

/** 视线朝向判据的余量（mc-lite 同值 0.01） */
const FACING_EPSILON = 0.01;

/** 六个正交邻居方向（与 mesher 的 FACE_DIRS 同序语义：只取正交，不含对角） */
const NEIGHBORS = [
  [1, 0, 0], [-1, 0, 0],
  [0, 1, 0], [0, -1, 0],
  [0, 0, 1], [0, 0, -1],
];

/**
 * 沿视线找「最近的可贴格」。
 *
 * ⚠️ **不用 0.1 步长采样，直接用体素 DDA 的逐格回调**（`raycastVoxel` 的 `onCell`）：
 * 本仓红线 5/6 规定地形交互走 DDA，而 0.1 步长在斜射时会**漏格**（同一格被采样多次、
 * 某一格被跳过 —— mc-lite 因为只用来做「贴面」而没暴露，但「取第一个满足的格」语义下
 * 漏格会直接漏掉合法的放置位）。DDA 逐格恰好每条格边界走一次，且与主射线共用同一份
 * 遍历实现（红线 1：不写第二份）。
 *
 * @param {import('../voxel/world-data.js').WorldData} world
 * @param {number[]} origin 视线起点（通常是相机位置）
 * @param {number[]} dir 视线方向（世界空间，**无需归一化** —— 内部归一化）
 * @param {number} [maxDist=PLACE_RAY_MAX_DIST] 搜索距离（格）
 * @returns {{hit: boolean, placeCell?: number[], neighbor?: number[]}}
 *          `neighbor` = 被贴住的那一面所在的格子（诊断/测试用）。
 *          ⚠️ `hit:false` 时**没有** `placeCell` —— 调用方必须判 `.hit`。
 */
export function findPlaceCell(world, origin, dir, maxDist = PLACE_RAY_MAX_DIST) {
  const len = Math.hypot(dir[0], dir[1], dir[2]);
  if (!(len > 0) || !(maxDist > 0)) return { hit: false };
  const nd = [dir[0] / len, dir[1] / len, dir[2] / len];

  let placeCell = null;
  let neighbor = null;

  /** @type {(x: number, y: number, z: number, t: number) => boolean} */
  const onCell = (x, y, z) => {
    // 遮挡判据（mc-lite 同口径：`if (!isSolid) {...} else break;`）：碰到第一个**实心**格
    // 就停止 —— 它后面的格子从相机看是被遮住的。⚠️ 这条不能用「继续前进」代替：
    // 实测漏掉它会在**墙后**凭空放出一块（射线穿过 x=12 的墙后到达 x=13，
    // 13 的 -X 邻居正是那面墙且 dot=-1 → 不被③否决 → 被当作合法位置）。
    // ⚠️ 只在实心时中断：植物/栅栏等非实心方块不挡视线（它们也不会被主射线以外的
    // 路径命中 —— 主射线的判据是「非空气且非水即命中」）。
    if (world.isSolid(x, y, z)) return true; // 中止，且不记录 placeCell
    // ②③ 邻居判定
    let sawSolid = false;
    for (const [dx, dy, dz] of NEIGHBORS) {
      if (!world.isSolid(x + dx, y + dy, z + dz)) continue;
      // ③ 该邻居若位于视线前方（含正前方）→ 这一面属于「正对着一面可见的墙」，
      // 留给常规 `prevPos` 路径（mc-lite `allInvisible` 的 `dot > 0.01` 否决）
      if (nd[0] * dx + nd[1] * dy + nd[2] * dz > FACING_EPSILON) return false;
      sawSolid = true;
    }
    if (!sawSolid) return false;
    placeCell = [x, y, z];
    // 记录被贴住的那一格（选第一个命中的邻居，仅诊断用，不影响判定）
    for (const [dx, dy, dz] of NEIGHBORS) {
      if (world.isSolid(x + dx, y + dy, z + dz)) { neighbor = [x + dx, y + dy, z + dz]; break; }
    }
    return true; // 中止遍历
  };

  // `occludes` 传「永不命中」：本函数只借 DDA 的逐格遍历，命中判定由 `onCell` 负责。
  // ⚠️ 传 `() => false` 而非 null —— null 会走默认判据（非空气即命中），那会在碰到
  // 第一个方块时就返回，`onCell` 就再也不会被调用了。
  raycastVoxel(world, origin, nd, maxDist, () => false, onCell);
  if (!placeCell) return { hit: false };
  return { hit: true, placeCell, neighbor };
}
