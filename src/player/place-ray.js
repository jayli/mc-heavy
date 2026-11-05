// src/player/place-ray.js — 打空时沿视线「就近优先」的放置候选扫描（v1.72 兜底 → v2.25 就近优先 → v2.54 面级筛选）
//
// 对齐 mc-lite `PlayerInteraction.js:781-806` 的 `doSkyPlace()`：玩家准心对着空气
// （前方没有任何方块）时，仍要能贴着**最近的**方块面放置方块。
//
// **v2.54 起本扫描只服务「打空」**（用户 2026-11-05：「如果十字准心对准了任何一个可以放置方块的
// 面，则优先在这个面上放置方块，这个优先级永远是最高的」）：主射线命中任何方块（不论远近）
// 都直接放命中面前那一格 A（`target.prevPos`），**不看沿途候选**；只有完全打空才跑本扫描。
// ⚠️ 这**取代了 v2.25 的 15 格分流**（命中 <15 放 A、≥15 先看候选）—— 那道分界会让
// 「瞄哪儿放哪儿」在 15 格处跳变，且与「命中优先级永远最高」矛盾。`PLACE_NEAR_HIT_DIST`
// 与 `opts.stopAt` 因此一并删除（无消费者）。
//
// 落点 = 沿视线**从近到远第一个**可放的候选格（就近原则）。
// 射程仍是 mc-lite 的 15 格，且**只约束候选**。
//
// 候选的判据（缺一不可）：
//   ① 该格本身非实心                     —— 否则放在方块里
//   ①b 沿途没有更早的实心格（遮挡）       —— 否则会放到墙后（相机看不到的地方）
//   ② 至少一个**正交**邻居是实心          —— 否则是「凭空放空中方块」
//   ③ 该邻居**不**位于视线前方            —— 否则正对着的那面墙也会被贴上一块
//   头格出局（v2.25）：**起点格（= 相机所在格）永不作候选**，与手里是什么方块、命中与否无关。
//     背靠墙或头顶有天花板时，离相机最近的候选恰是头格；就近优先后它会吞掉每一次右键
//     （实心方块被身体守卫拒绝，花草之类非实心方块则会被放进自己的脑袋里）。
//
// ①b 与 ③ 的分工（两条都在 mc-lite 的 `doSkyPlace` 里，不能只留一条）：
//   ①b 管「沿途」，③ 管「候选格自己的邻居」—— 前者防墙后放块，后者防把正对的那面墙
//   再贴一层（那面墙本该由常规 `prevPos` 路径处理）。
//
// ③ 的判据是 `dot(视线, 该邻居方向) > 0.01`：邻居在视线前方（含正前方）即**跳过该面**。
// 这 0.01 的余量与 mc-lite 同值 —— 它排除的是「视线几乎平行于该面」的擦边情形，
// 此时玩家显然不是想贴那一面。
// ⚠️ **v2.54：③ 是「面级筛选」而不是「格级否决」**（用户报告的「就远」缺陷根因）。
//   旧实现是「该格只要有任一实心邻居在视线前方 → 整格出局」，于是一个**同时**挨着
//   背对面（合法落点，如它脚下的方块）与正对面（如它头顶的方块）的近处格会被整格否掉，
//   落点退到更远处的背对面 —— 实测 (5,3,8) 被否后落到 7 格外的 (12,4,8)。
//   改为「正对面只跳过该面、格子仍凭其余背对/侧面成为候选」后，就近原则才真的成立。
//   下界守卫：唯一实心邻居就在正前方的格仍然出局（那面墙由 A 路径处理），见
//   `test-place-ray.js` 的「面级筛选不放宽」用例。
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
 * @param {{maxDist?: number}} [opts]
 *        `maxDist`：搜索距离（格），缺省 `PLACE_RAY_MAX_DIST`。
 *        ⚠️ v2.25 的 `stopAt`（止于命中格）已删除：命中一律走 A 路径、不再进本扫描，
 *        故它没有消费者（留着就是「看起来有用其实永不触发」的死参数）。
 * @returns {{hit: boolean, placeCell?: number[], neighbor?: number[]}}
 *          `hit` = 某次 `visit` 返回了 true；`neighbor` = 被贴住的那一面所在的格子（诊断/测试用）。
 *          ⚠️ `hit:false` 时**没有** `placeCell` —— 调用方必须判 `.hit`。
 */
export function scanPlaceCells(world, origin, dir, visit, opts = {}) {
  const { maxDist = PLACE_RAY_MAX_DIST } = opts;
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
    // 遮挡判据（mc-lite 同口径：`if (!isSolid) {...} else break;`）：碰到第一个**实心**格
    // 就停止 —— 它后面的格子从相机看是被遮住的。⚠️ 这条不能用「继续前进」代替：
    // 实测漏掉它会在**墙后**凭空放出一块（射线穿过 x=12 的墙后到达 x=13，
    // 13 的 -X 邻居正是那面墙且 dot=-1 → 不被③否决 → 被当作合法位置）。
    // 起点格同样适用（相机在实心格内 → 一个候选都没有）。
    // ⚠️ 只在实心时中断：植物/栅栏等非实心方块不挡视线（主射线的判据是
    // 「非空气且非水即命中」，它们不会走到本扫描 —— 命中即走 A 路径）。
    if (world.isSolid(x, y, z)) return true;
    // 头格出局：仍参与上面的遮挡判据，但不作候选
    if (isStart) return false;
    // ②③ 邻居判定（**面级筛选**，v2.54）：逐个邻居看，正对面只跳过该面，
    // 背对/侧面则记为候选面。⚠️ 不得写成「有正对邻居就 return false」（格级否决）——
    // 那会让同时挨着背对面与正对面的近处格整格出局，落点退到更远处（用户报告的「就远」缺陷）。
    let neighbor = null;
    for (const [dx, dy, dz] of NEIGHBORS) {
      if (!world.isSolid(x + dx, y + dy, z + dz)) continue;
      // ③ 该邻居位于视线前方（含正前方）→ 这一面属于「正对着一面可见的墙」，
      // 留给常规 `prevPos` 路径（mc-lite `allInvisible` 的 `dot > 0.01` 同值判据）
      if (nd[0] * dx + nd[1] * dy + nd[2] * dz > FACING_EPSILON) continue;
      if (neighbor === null) neighbor = [x + dx, y + dy, z + dz]; // 第一个背对/侧面的实心邻居
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
