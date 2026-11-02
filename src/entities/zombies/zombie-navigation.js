// src/entities/zombies/zombie-navigation.js — v2.40：丧尸局部避障（贴身绕行）
//
// 同构层：**无 DOM、无 three、不新建 Worker**（`npm run check:arch` 静态门守）。
// 本模块是三件事的**唯一实现**（红线 1：同一判据只留一份，物理与探针共用）：
//   ① `zombieCollidesAt` —— 丧尸 AABB 0.6×1.8×0.6 与实心方块是否相交
//   ② `zombieStepUpY`    —— 一格台阶的落点脚底高度
//   ③ `steerIntent`      —— 局部转向探针（只换方向、不改速度长度）
//
// ## 为什么避障在主线程而不在 worker
//
// worker 里**没有世界数据**（M6 规格 §2：`ai` RPC 只传 plain state，不传局部体素视域），而世界
// 数据的唯一权威在主线程（红线 1）。故避障只能在主线程做，且接在 `ZombieService._applyIntent()`
// ——**AI 回包的唯一消费点**。⚠️ **不得接在 `setIntent()`**：那是通用意图写入口（物理用例、调试
// 代码都用它直接下令），探针长在里面会让「想让它走就必须能走」的语义被偷换。
//
// ## 与 mc-lite 的关系
//
// mc-lite 的丧尸是纯直线追逐（靠 S 路线随机偏移角减少彼此重叠），**没有避障**。本模块是**有意
// 增强**（用户 2026-11-02：「可以绕过简单的障碍物」），不属于「对齐上游」，故不进 CLAUDE.md 的
// 「六处偏离」清单（那是视觉比对专用）。
//
// ## 非目标
//
// 不做寻路网格 / A* / BFS（M6 规格 §1 的非目标仍然有效）；不做随机游荡；不检查脚下支撑
// （从平台边缘走向玩家仍会走下去，与改动前同行为）。
import { ZOMBIE, ZOMBIE_MAX_STEP, ZOMBIE_MOVING_EPSILON, ZOMBIE_STEERING } from './zombie-config.js';

/**
 * AABB 竖直采样的噪声门（与 `zombie-system.js` 的 `PHYS_EPSILON` **是同一个口径**，
 * 随 `collides()` 一并搬来这里 —— 那边已无同名常量，全局只有这一份）。
 *
 * ⚠️ **载荷性**：`y1 = floor(y + height - EPSILON)`。少了它会让"净空恰好 1.8"的走廊
 * （脚底 y=1.2 时 AABB 顶面恰为 3.0）多采一格头顶，把**能走的走廊判成堵死** —— 丧尸在门洞、
 * 隧道、2 格高的走廊里原地僵住，而方块层面完全看不出问题。
 */
const PHYS_EPSILON = 0.001;

/**
 * 丧尸 AABB 与实心方块是否相交（脚底为 `y`，半宽 0.3、高 1.8）。
 *
 * **物理的 `collides()` 与避障探针共用本函数**（红线 1）：两份判据会漂移成「探针以为能过、
 * 物理撞墙」或反之，且这种漂移是静默的（只表现为丧尸莫名卡顿），只能靠实玩发现。
 *
 * @param {{isSolid(x: number, y: number, z: number): boolean}} world
 * @param {number} x 脚底中心 x @param {number} y 脚底 y @param {number} z 脚底中心 z
 * @returns {boolean}
 */
export function zombieCollidesAt(world, x, y, z) {
  if (!world || typeof world.isSolid !== 'function') return false;
  const hw = ZOMBIE.width / 2;
  const x0 = Math.floor(x - hw), x1 = Math.floor(x + hw);
  const y0 = Math.floor(y), y1 = Math.floor(y + ZOMBIE.height - PHYS_EPSILON);
  const z0 = Math.floor(z - hw), z1 = Math.floor(z + hw);
  for (let bx = x0; bx <= x1; bx++) {
    for (let by = y0; by <= y1; by++) {
      for (let bz = z0; bz <= z1; bz++) {
        if (world.isSolid(bx, by, bz)) return true;
      }
    }
  }
  return false;
}

/**
 * 一格台阶的落点脚底高度（物理 `tryStepUp` 与探针共用，红线 1）。
 *
 * `+0.01` 是浮点容错：站立时脚底 ≈ 整数，不加容错会算出「上一格」而不是「上两格」。
 * 漂移的形态是「探针以为能上台阶、物理抬不上去」→ 丧尸贴着台阶反复试探（静默）。
 *
 * @param {number} y 当前脚底高度 @returns {number} 抬升后的脚底高度
 */
export function zombieStepUpY(y) {
  return Math.floor(y + 0.01) + 1;
}

/**
 * 局部转向探针：把「朝玩家的意图速度」按最小偏角修成一条走得通的方向。
 *
 * 语义（用户 2026-11-02 裁定「贴身绕行即可」+「完全过不去时留在原地不追」）：
 * - 候选 = 原方向 0°，然后按 `anglesDeg` **升序**、每档**先 + 后 −**（保证取最小偏角，
 *   ±90° 只在最后兜底沿墙蹭）；
 * - 某个候选的落点（`probeDistance` 之外）AABB 不撞方块 → 可通行；撞了但「抬一格台阶后不撞」
 *   也算可通行（一格台阶交给物理 step-up）；
 * - **0° 命中时原样返回输入**（不重建速度向量）：`vx/len*len` 不保证逐位回到 `vx`，
 *   而「无障碍时逐位零回归」是硬判据（否则丧尸走路会开始画龙，观感缺陷且极难归因）；
 * - 全部不可通行 → `{ vx: 0, vz: 0, blocked: true }`（原地站住，等下一个 AI 周期重探）。
 *
 * **确定性**：同输入必同输出 —— 无 `Math.random()`、不记忆「上次绕哪边」。副作用是两侧都通时
 * 永远先试 +侧（稳定不抖，可测）。
 *
 * ⚠️ **只换方向、不改长度**：速度上限的唯一权威仍是 `ZombieService._applyIntent()` 的钳制
 * ＋ `ZOMBIE.speed`，本函数不复制一份。
 * ⚠️ **不判「当前是否已被埋」**：本函数回答「目标点能不能站」，被埋属于物理层
 * （玩家侧有 `resolveStuck`，丧尸侧靠 column 卸载路径）。
 *
 * @param {{world: object, position: number[], vx: number, vz: number}} p
 * @returns {{vx: number, vz: number, blocked: boolean}}
 */
export function steerIntent({ world, position, vx, vz }) {
  const vx0 = Number.isFinite(vx) ? vx : 0;
  const vz0 = Number.isFinite(vz) ? vz : 0;
  const len = Math.hypot(vx0, vz0);
  // 零速/亚阈值意图不探针：静止的丧尸不该凭空转向，也不该被判 blocked
  // （阈值复用 ZOMBIE_MOVING_EPSILON —— 与步态、朝向派生同一份口径）
  if (len <= ZOMBIE_MOVING_EPSILON) return { vx: vx0, vz: vz0, blocked: false };
  const [x, y, z] = position;
  const ux = vx0 / len, uz = vz0 / len;

  // 0° 先试：命中就原样返回（逐位零回归）
  if (probeClear(world, x, y, z, ux, uz)) return { vx: vx0, vz: vz0, blocked: false };

  for (const deg of ZOMBIE_STEERING.anglesDeg) {
    const theta = deg * Math.PI / 180;
    const cos = Math.cos(theta), sin = Math.sin(theta);
    // 先 +后 −：一个旋转公式两种符号，不写两份（红线 1）
    for (const sign of [1, -1]) {
      const s = sin * sign;
      // 旋转公式与 yaw = atan2(vx, vz) 同序（x east / z south）
      const dx = ux * cos - uz * s;
      const dz = ux * s + uz * cos;
      if (probeClear(world, x, y, z, dx, dz)) {
        return { vx: dx * len, vz: dz * len, blocked: false };
      }
    }
  }
  return { vx: 0, vz: 0, blocked: true };
}

/**
 * 单个候选方向是否可通行：`probeDistance` 之外那一点 AABB 不撞方块，或者抬一格台阶后不撞。
 *
 * ⚠️ **与物理 `tryStepUp` 有两处已知发散，都是有意保留的**：
 * ① **不复制「跳跃上升段拒绝」门控** —— 探针回答的是**几何可达性**，物理回答的是**此刻能否抬**。
 *    丧尸不会跳，几乎不处于上升段。
 * ② **判定位置不同** —— 物理在「已撞到台阶、仍未抬升的当前位置」测抬升后的 AABB；探针在
 *    `probeDistance`（1.2 格）之外的**前瞻落点**测。所以探针可能批准一个「真实落点在那之后
 *    才需要抬」的台阶。实践上物理会分 2~3 个子步完成，不会让丧尸贴墙；代价只是
 *    “探针批准的位置比物理抬升的位置提前”。
 *    ⇒ **不改探针去复制物理的逐格判定**：那会把 1 次探针变成沿路径逐格扫（成本乘上
 *    `probeDistance` 倍），而收益只是消除一个不可见的提前量。
 */
function probeClear(world, x, y, z, dx, dz) {
  const tx = x + dx * ZOMBIE_STEERING.probeDistance;
  const tz = z + dz * ZOMBIE_STEERING.probeDistance;
  if (!zombieCollidesAt(world, tx, y, tz)) return true;
  const lifted = zombieStepUpY(y);
  return lifted - y <= ZOMBIE_MAX_STEP && !zombieCollidesAt(world, tx, lifted, tz);
}
