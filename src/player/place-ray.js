// src/player/place-ray.js — 沿视线「就近优先」的放置候选扫描（v1.72 兜底 → v2.25 就近优先）
//
// 对齐 mc-lite `PlayerInteraction.js:781-806` 的 `doSkyPlace()`：玩家准心对着空气
// （前方没有任何方块）时，仍要能贴着**最近的**方块面放置方块。
//
// **v2.25 起语义改为「就近优先」**（用户 2026-10-30：「不管十字准心方向经过多少个可放置方块的
// 位置，总是先就近放置」）：落点 = 沿视线**从近到远第一个**可放的候选格；准心命中面前的那一格
// （A，`target.prevPos`）只是这串候选里排在最后的一个。命中与打空走同一套流程（打空 = 没有 A
// 的特例），所以本文件的扫描既服务「打空」也服务「命中」，不再是只在 `player.target === null`
// 时才调的兜底。
// ⚠️ 这**取代了 v1.72 的用户裁定①**（「兜底只在完全未命中时生效」）；该裁定的顾虑——回落会把
// 方块放到玩家没对准的地方——已由用户明确接受。射程仍是 mc-lite 的 15 格，且**只约束候选**，
// A 再远（≤ 40 格）也照放。
// **v2.25 追加**（用户 2026-10-30，对齐 mc-lite `interact()`）：命中 **< 15 格**（`PLACE_NEAR_HIT_DIST`）
// 时**不走本扫描**，直接放命中面前；扫描只服务「命中 ≥ 15 格」与「打空」两种情形。
//
// 候选的判据（缺一不可）：
//   ① 该格本身非实心                     —— 否则放在方块里
//   ①b 沿途没有更早的实心格（遮挡）       —— 否则会放到墙后（相机看不到的地方）
//   ② 至少一个**正交**邻居是实心          —— 否则是「凭空放空中方块」
//   ③ 没有任何实心邻居位于视线前方        —— 否则正对着的那面墙也会被贴上一块
//   头格出局（v2.25）：**起点格（= 相机所在格）永不作候选**，与手里是什么方块、命中与否无关。
//     背靠墙或头顶有天花板时，离相机最近的候选恰是头格；就近优先后它会吞掉每一次右键
//     （实心方块被身体守卫拒绝，花草之类非实心方块则会被放进自己的脑袋里）。
//   止于命中格（v2.25）：`opts.stopAt`（主射线命中的方块格，**不含**）。A 在命中格之前，越过它
//     没有意义；命中格是花草这类非实心方块时，扫描本身不会被它遮挡，必须靠这条截止。
//
// ①b 与 ③ 的分工（两条都在 mc-lite 的 `doSkyPlace` 里，不能只留一条）：
//   ①b 管「沿途」，③ 管「候选格自己的邻居」—— 前者防墙后放块，后者防把正对的那面墙
//   再贴一层（那面墙本该由常规 `prevPos` 路径处理，即候选序列末尾的 A）。
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
 * 的同源值），候选扫描只用 15 格 —— 否则远处天空会冒出方块。
 */
export const PLACE_RAY_MAX_DIST = 15;

/**
 * 近处命中的分流阈值（格）：主射线命中距离 **< 15** 时直接放命中面前（A），不看沿途候选。
 *
 * **= mc-lite `interact()` 右键的 `hits[0].distance < 15`**（`PlayerInteraction.js:124`）：近处命中走
 * `tryPlaceBlock(命中面相邻格)`，否则才走 `doSkyPlace()`。用户（2026-10-30）要求本仓库在这一点上与
 * mc-lite 一致；命中 ≥ 15 格与打空仍先找沿途候选。
 * 与 `PLACE_RAY_MAX_DIST` 同值（mc-lite 里是两处字面量 15），但**语义不同**：这个管「走哪条路」，
 * 那个管「候选搜多远」。
 */
export const PLACE_NEAR_HIT_DIST = PLACE_RAY_MAX_DIST;

/**
 * 兜底搜索的步长（格）—— mc-lite 的 `step = 0.1`。
 * ⚠️ **本仓库不用它步进**（见 `scanPlaceCells` 的注释）；保留是为了让「射程 15 格」这个
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
 * 沿视线从近到远逐个访问「可放候选」，直到某个候选被 `visit` 接受（放成功）。
 *
 * **候选判据只写在这里一处**（红线 1）：`findPlaceCell` 是它的薄包装，`player.js` 的
 * `_placeNearest` 是它的调用方；身体守卫与写入则只在 `Player._placeSingle()`，不在本文件。
 *
 * ⚠️ **不用 0.1 步长采样，直接用体素 DDA 的逐格回调**（`raycastVoxel` 的 `onCell`）：
 * 本仓红线 5/6 规定地形交互走 DDA，而 0.1 步长在斜射时会**漏格**（同一格被采样多次、
 * 某一格被跳过 —— mc-lite 因为只用来做「贴面」而没暴露，但「取第一个满足的格」语义下
 * 漏格会直接漏掉合法的放置位）。DDA 逐格恰好每条格边界走一次，且与主射线共用同一份
 * 遍历实现（红线 1：不写第二份）。
 *
 * @param {import('../voxel/world-data.js').WorldData} world
 * @param {number[]} origin 视线起点（通常是相机位置；它所在的格就是「头格」）
 * @param {number[]} dir 视线方向（世界空间，**无需归一化** —— 内部归一化）
 * @param {(x: number, y: number, z: number, neighbor: number[]) => boolean} visit
 *        每个候选按 DDA 顺序（近→远）调一次；返回 `true` = 已放置，**立即中止遍历**；
 *        返回 `false` = 这格放不下（如被身体守卫拒绝），继续找下一个（mc-lite `doSkyPlace` 同款）。
 * @param {{maxDist?: number, stopAt?: number[] | null}} [opts]
 *        `maxDist`：搜索距离（格），缺省 `PLACE_RAY_MAX_DIST`；
 *        `stopAt`：主射线命中的方块格 `[x,y,z]`，走到它即截止（**不含**该格），无命中传 null。
 * @returns {{hit: boolean, placeCell?: number[], neighbor?: number[]}}
 *          `hit` = 某次 `visit` 返回了 true；`neighbor` = 被贴住的那一面所在的格子（诊断/测试用）。
 *          ⚠️ `hit:false` 时**没有** `placeCell` —— 调用方必须判 `.hit`。
 */
export function scanPlaceCells(world, origin, dir, visit, opts = {}) {
  const { maxDist = PLACE_RAY_MAX_DIST, stopAt = null } = opts;
  const len = Math.hypot(dir[0], dir[1], dir[2]);
  if (!(len > 0) || !(maxDist > 0)) return { hit: false };
  const nd = [dir[0] / len, dir[1] / len, dir[2] / len];

  // 第一次进入回调的就是起点格（头格）。⚠️ 不能用 `t === 0` 识别：相机恰在格边界时，
  // 头格之后的下一格进入时 `t` 也恰为 0，会被误当成起点而漏掉一个合法候选。
  let atStart = true;
  /** @type {{hit: boolean, placeCell?: number[], neighbor?: number[]} | null} */
  let found = null;

  /** @type {(x: number, y: number, z: number, t: number) => boolean} */
  const onCell = (x, y, z) => {
    const isStart = atStart;
    atStart = false;
    // 止于命中格（不含）：先于实心判据，使命中格是非实心（花草）时也在它之前截止
    if (stopAt !== null && x === stopAt[0] && y === stopAt[1] && z === stopAt[2]) return true;
    // 遮挡判据（mc-lite 同口径：`if (!isSolid) {...} else break;`）：碰到第一个**实心**格
    // 就停止 —— 它后面的格子从相机看是被遮住的。⚠️ 这条不能用「继续前进」代替：
    // 实测漏掉它会在**墙后**凭空放出一块（射线穿过 x=12 的墙后到达 x=13，
    // 13 的 -X 邻居正是那面墙且 dot=-1 → 不被③否决 → 被当作合法位置）。
    // 起点格同样适用（相机在实心格内 → 一个候选都没有）。
    // ⚠️ 只在实心时中断：植物/栅栏等非实心方块不挡视线（主射线的判据是
    // 「非空气且非水即命中」，它们的截止靠 `stopAt`）。
    if (world.isSolid(x, y, z)) return true;
    // 头格出局：仍参与上面的遮挡判据，但不作候选
    if (isStart) return false;
    // ②③ 邻居判定
    let neighbor = null;
    for (const [dx, dy, dz] of NEIGHBORS) {
      if (!world.isSolid(x + dx, y + dy, z + dz)) continue;
      // ③ 该邻居若位于视线前方（含正前方）→ 这一面属于「正对着一面可见的墙」，
      // 留给常规 `prevPos` 路径（mc-lite `allInvisible` 的 `dot > 0.01` 否决）
      if (nd[0] * dx + nd[1] * dy + nd[2] * dz > FACING_EPSILON) return false;
      if (neighbor === null) neighbor = [x + dx, y + dy, z + dz]; // 第一个实心邻居，仅诊断用
    }
    if (neighbor === null) return false;
    // 交给调用方：放成功才中止遍历；放不下（被拒）则继续往远处找
    if (!visit(x, y, z, neighbor)) return false;
    found = { hit: true, placeCell: [x, y, z], neighbor };
    return true;
  };

  // `occludes` 传「永不命中」：本函数只借 DDA 的逐格遍历，命中判定由 `onCell` 负责。
  // ⚠️ 传 `() => false` 而非 null —— null 会走默认判据（非空气即命中），那会在碰到
  // 第一个方块时就返回，`onCell` 就再也不会被调用了。
  raycastVoxel(world, origin, nd, maxDist, () => false, onCell);
  return found ?? { hit: false };
}

/**
 * 沿视线找「最近的可贴格」—— `scanPlaceCells` 的薄包装：第一个候选就算数（不问能否放下）。
 * 判据与头格出局同 `scanPlaceCells`；保留它是因为既有单测把它当判据①②③的回归门。
 *
 * @param {import('../voxel/world-data.js').WorldData} world
 * @param {number[]} origin 视线起点（通常是相机位置）
 * @param {number[]} dir 视线方向（世界空间，**无需归一化** —— 内部归一化）
 * @param {number} [maxDist=PLACE_RAY_MAX_DIST] 搜索距离（格）
 * @returns {{hit: boolean, placeCell?: number[], neighbor?: number[]}}
 *          ⚠️ `hit:false` 时**没有** `placeCell` —— 调用方必须判 `.hit`。
 */
export function findPlaceCell(world, origin, dir, maxDist = PLACE_RAY_MAX_DIST) {
  return scanPlaceCells(world, origin, dir, () => true, { maxDist });
}
