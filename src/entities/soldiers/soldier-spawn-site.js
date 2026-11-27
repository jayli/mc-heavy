// src/entities/soldiers/soldier-spawn-site.js — C 键落点选取（同构纯函数）
//
// 同构层：**无 DOM、无 three、不新增 Worker**（`npm run check:arch` 静态门守）。
//
// ## 要解决的问题（用户 2026-11-27 实玩报告）
//
// 「我在地上的时候，按 c，有时候会把 soldier 生成到地下矿洞里，我希望生成 soldier 的时候，
//   尽量生成在跟玩家一个水平线上的空间内，即便有高度差，也要在一个联通的空间内，
//   高度差不要太大，不要生成在高度差很多的地下矿洞，云层等地方。」
//
// ## 旧口径的病根（实测，不是推断）
//
// 旧 `Game.spawnSoldierNearPlayer()` 逐行照 X 键丧尸：随机角度 + 2~10 格，然后
// **从玩家高度向下扫 64 格**，第一个「本格 air + 上格 air + 下格 solid」即采用。
// 那条判据**只问这一格能不能站**，不问它与玩家是否连通、差多少高度 ——
// 洞穴顶板天然满足它，而洞穴在地表下 4~40 格 ⇒ 向下扫必然先撞到它。
// 实测（真实 seed 12345 + `fillColumn` + `carveCaves`，8 点 × 200 次）最深 **−39 格**，
// 洞口密集点 11/200 落到 dy ≤ −8；浏览器真实按键 20 次里出现 −32 / −28 / −26。
//
// ## 做法：从玩家出发的**有界连通洪泛**
//
// 每个入选格都是**从玩家一步步走过去的** ⇒ 可达性由构造保证，而不是「选完再校验」。
// 这一点是载荷性的：随机取点 + 校验只能验「这一格自己合法」，验不出「与玩家连通」。
//
// ## ☠️☠️ 为什么高度差上限**不够**（本文件最重要的一条实测教训）
//
// 「在 ±N 格窗口里找可站面」这种朴素做法会**穿过实心天花板**：实测在 4545 个洞内
// 可站列上，朴素窗口上浮穿岩 **5024 次**（洞里的玩家把 soldier 生成到露天地表）。
// 所以必须显式验**空气通路**：从当前格高度到目标格高度的**整段身体走廊**
// （`[min(cy,y)+1, max(cy,y)+1]`，两端脚格已由 AABB 与支撑判据各自验过）无实心。
// 少了这一条，「连通」就是假的；下界写成 `min` 则会把**支撑块**算进走廊
// ⇒ 任何向上的台阶都被判堵死（实测高于玩家 = 0/1600，而其余判据全绿）。
//
// ## 两条与下游必须同源的判据（都是本轮实测抓到的）
//
// ① **可站格要「严格 air」而不是「非实心」**：`SoldierService.spawn` 的门是
//    `getBlockId === 0`，而水/花/草/藤蔓/睡莲/吊灯/矿车 等 **15 种方块非实心但非 air**。
//    只用 `isSolid` ⇒ 选中它们、service 静默拒收（实测：玩家站水里时 24 次按键只成功 6 次）。
//    ⚠️ 但**空气通路仍用 `isSolid`** —— 玩家物理只撞实心方块，水/草能走。两处故意不同。
// ② **取距从玩家真实位置算，不从格心算**：`physics.pos` 不一定带 .5（传送/解卡后
//    常见整数坐标），从 `floor(x)+0.5` 算有半格系统偏差 ⇒ 选出真实距 1.58 格的落点。
//
// ## 云为什么不需要单独排除
//
// 云在 y=35/55，玩家在地面时它与玩家之间没有空气通路 ⇒ 洪泛结构性到不了
// （实测「地面玩家有没有云落点：false」）。玩家**自己站在云上**时云上生成是对的
// —— 那正是它所在的水平连通空间。**不写名字白名单**（红线 1）。
//
// ## 兜底阶梯（用户裁定「附近确实没有合法落点时放宽高度差再试一次」）
//
// | 级 | 种子高度 | 带宽 |
// |---|---|---|
// | ① | 玩家脚底 y | `maxDy`（±3） |
// | ② | 玩家自己那一列往下找到的支撑面 | `maxDy` |
// | ③ | 同② | `relaxedDy`（±8） |
//
// **三级共用同一个洪泛 ⇒ 空气通路判据一次都不放松。** 三级全空（独柱顶端 / 被墙围死，
// 实测两者候选数 0）⇒ 返回 null，由装配层给 toast，**绝不退回旧的向下扫算法**。
import { SOLDIER, SOLDIER_SPAWN } from './soldier-config.js';
import { aabbCollidesAt } from '../zombies/zombie-navigation.js';

/** 士兵 AABB 半宽（派生自体型唯一权威，不写字面量） */
const HALF_WIDTH = SOLDIER.width / 2;

/**
 * 数字 key（**不是字符串**）—— 照 `zombie-pathfinder.js` 已实测的口径：
 * 字符串模板 key 的 Map 查找比数字慢 4~5 倍，而洪泛每格要做 8 次查找。
 */
const KEY_OFFSET = 1 << 12;
const KEY_SPAN = 1 << 14;
const keyOf = (x, z) => (x + KEY_OFFSET) * KEY_SPAN + (z + KEY_OFFSET);

/**
 * 从 `fromY` 走到 `toY` 的**整段身体走廊**是否全程无实心（连通性的载体）。
 *
 * ☠️☠️ **区间两端都是载荷性的，各自修一种实测缺陷**：
 *
 * ① **上界必须 `+1`**：士兵高 1.8 ⇒ 脚底在 y 时占 y 与 y+1 两层。只验到
 *    `max(fromY,toY)` 会漏掉头顶那一格，形态是「从 2 格高走廊钻进 1 格高缝」。
 * ② **下界必须排除目标格的支撑块**（`min+1` 而不是 `min`）—— 支撑块本身就是实心的！
 *    把它算进走廊 ⇒ **任何向上的台阶都被判成堵死**。实测（真实地形 8 点 × 200 次）：
 *    写成 `min` 时落点 **高于玩家 = 0 / 1600**（连 1 格台阶都上不了），而全部数值判据
 *    （|dy| ≤ 3 / 可站 / 见天 / 取距）**全绿** —— 静默失效。
 *    正确的走廊 = 两端**身体占据的格**的并集：`[min+1, max+1]`
 *    （fromY 与 toY 各自的脚格都已被 AABB / 支撑判据单独验过）。
 *
 * @param {{isSolid(x:number,y:number,z:number):boolean}} world
 * @param {number} x @param {number} z 整数列坐标
 * @param {number} fromY @param {number} toY 两端脚底格
 * @returns {boolean}
 */
function airPathClear(world, x, z, fromY, toY) {
  const lo = Math.min(fromY, toY) + 1;
  const hi = Math.max(fromY, toY) + 1;
  for (let y = lo; y <= hi; y++) if (world.isSolid(x, y, z)) return false;
  return true;
}

/**
 * 该列在 `[lo, hi]` 里**自高到低**第一个可站脚位（连通 + AABB + 严格 air 三重判据）。
 *
 * ⚠️ **自高到低**：同列有多层可站面时取贴近来源高度的那一层（与「尽量同一水平线」一致）。
 * ⚠️ 碰撞判据复用 `aabbCollidesAt`（物理 / 避障 / A\* 共用那一份，红线 1）。
 *
 * ☠️☠️ **必须验「严格 air」而不是「非实心」**（本轮浏览器实测抓到的真缺陷）：
 * `SoldierService.spawn` 的门是 `getBlockId(脚格) === 0 && getBlockId(头格) === 0`，
 * 而水 / 花 / 草 / 藤蔓 / 睡莲 / 吊灯 / 矿车 等 **15 种方块是非实心但非 air**。
 * 只用 `isSolid` 判可站 ⇒ 选中它们 ⇒ service 静默拒收。
 * 实测形态：玩家站在水里（y=−2 = SEA_Y）时 **24 次真实 C 键只成功 6 次**，
 * 而落点算法自认为全部成功（stage=1 / dy 合法）—— 典型的「两侧判据不同源」。
 *
 * @returns {number|null}
 */
function standableNear(world, x, z, fromY, hi, lo) {
  for (let y = hi; y >= lo; y--) {
    if (!airPathClear(world, x, z, fromY, y)) continue;
    // 与 `SoldierService.spawn` 逐位同源：脚格与头格必须是真正的 air
    if (world.getBlockId(x, y, z) !== 0) continue;
    if (world.getBlockId(x, y + 1, z) !== 0) continue;
    if (aabbCollidesAt(world, x + 0.5, y, z + 0.5, HALF_WIDTH, SOLDIER.height)) continue;
    if (!world.isSolid(x, y - 1, z)) continue;
    return y;
  }
  return null;
}

/**
 * 从 `(sx, sy, sz)` 出发做有界连通洪泛，收集水平距 ∈ [minDist, maxDist] 的可站格。
 *
 * ☠️☠️ **取距必须从玩家真实位置算，不能从种子格心算**（本轮 E2E 实测抓到的真缺陷）：
 * 玩家 `physics.pos` **不一定带 .5**（传送/解卡后常见整数坐标，如 903.0）。
 * 从 `sx+0.5` 算会把距离系统性偏半格 ⇒ 选出真实距 **1.58 格**的落点（声称 ≥2），
 * 形态是「士兵贴脸生成」。Node 夹具全部用 x+0.5 ⇒ **结构上抓不到**。
 *
 * @param {object} world
 * @param {number} sx @param {number} sy @param {number} sz 种子格（整数）
 * @param {number} band 全局高度带（相对**种子**高度，双向）
 * @param {object} cfg `SOLDIER_SPAWN` 或覆盖后的同形状对象
 * @param {number} originX @param {number} originZ 玩家**真实**水平坐标（取距基准）
 * @returns {Array<{x:number,y:number,z:number}>}
 */
function flood(world, sx, sy, sz, band, cfg, originX, originZ) {
  const seen = new Map([[keyOf(sx, sz), sy]]);
  // 三个并行数组而不是元组数组：避免每格分配一个小数组（照 planStep 口径）
  const qx = [sx], qz = [sz], qy = [sy];
  const out = [];
  let head = 0;
  while (head < qx.length && seen.size <= cfg.maxCells) {
    const cx = qx[head], cz = qz[head], cy = qy[head];
    head++;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        if (dx === 0 && dz === 0) continue;
        const nx = cx + dx, nz = cz + dz;
        if (Math.max(Math.abs(nx - sx), Math.abs(nz - sz)) > cfg.radius) continue;
        const k = keyOf(nx, nz);
        if (seen.has(k)) continue;
        // ⚠️ **未加载 column 必须跳过**：`getBlockId` 对缺失 column 返回 0（空气）
        // ⇒ 不判它会把「世界还没生成出来的地方」当成一片开阔平地。
        if (!world.hasColumn(Math.floor(nx / 16), Math.floor(nz / 16))) continue;
        // 每步限幅（台阶能力）∩ 全局高度带（相对种子）
        const hi = Math.min(cy + cfg.stepPerCell, sy + band);
        const lo = Math.max(cy - cfg.stepPerCell, sy - band);
        const y = standableNear(world, nx, nz, cy, hi, lo);
        if (y === null) continue;
        seen.set(k, y);
        qx.push(nx); qz.push(nz); qy.push(y);
        const d = Math.hypot(nx + 0.5 - originX, nz + 0.5 - originZ);
        if (d >= cfg.minDist && d <= cfg.maxDist) out.push({ x: nx, y, z: nz });
      }
    }
  }
  return out;
}

/**
 * 玩家自己那一列往下找第一个可站面（兜底②/③的种子）。
 *
 * ⚠️ 只找**自己这一列**，不换列 —— 换列就回到「随机取点后向下扫」的老病根。
 * @returns {number|null}
 */
function selfSupportY(world, x, z, fromY, maxDrop) {
  for (let y = fromY; y >= fromY - maxDrop; y--) {
    if (world.getBlockId(x, y, z) !== 0) continue;
    if (world.getBlockId(x, y + 1, z) !== 0) continue;
    if (aabbCollidesAt(world, x + 0.5, y, z + 0.5, HALF_WIDTH, SOLDIER.height)) continue;
    if (!world.isSolid(x, y - 1, z)) continue;
    return y;
  }
  return null;
}

/**
 * 选一个 C 键落点：**与玩家同一水平连通空间**、高度差受限。
 *
 * @param {{isSolid:Function, getBlockId:Function, hasColumn:Function}|null} world
 * @param {number[]|null} playerPos 玩家脚底 `[x,y,z]`（物理 pos 口径）
 * @param {{rng?: ()=>number, maxDy?: number, relaxedDy?: number}} [opts]
 *   `rng` 缺省 `Math.random`（C 键是玩家手动触发的调试动作，时机本身不可复现，
 *   与旧口径一致，不属红线 2 的「seed 确定性世界生成」范畴）；
 *   `maxDy` / `relaxedDy` 只为测试覆盖，生产路径不传。
 * @returns {{position: number[], dy: number, stage: number}|null}
 *   `dy` = 落点脚底 − **玩家脚底格**（诊断用，装配层原样透出）；
 *   `stage` = 命中的兜底级（1/2/3）；三级全空返回 null。
 */
export function findSoldierSpawnSite(world, playerPos, opts = {}) {
  if (!world || typeof world.isSolid !== 'function' || typeof world.hasColumn !== 'function'
    || typeof world.getBlockId !== 'function') return null;
  if (!Array.isArray(playerPos) || playerPos.length < 3) return null;
  if (!playerPos.every((v) => Number.isFinite(v))) return null;

  const cfg = {
    ...SOLDIER_SPAWN,
    ...(Number.isFinite(opts.maxDy) ? { maxDy: opts.maxDy } : {}),
    ...(Number.isFinite(opts.relaxedDy) ? { relaxedDy: opts.relaxedDy } : {}),
  };
  const rng = typeof opts.rng === 'function' ? opts.rng : Math.random;

  const px = Math.floor(playerPos[0]);
  const py = Math.floor(playerPos[1]);
  const pz = Math.floor(playerPos[2]);

  /** 三级阶梯：种子高度 + 带宽。②③ 的种子是玩家自己那一列的支撑面（惰求，只算一次） */
  let support;
  let supportResolved = false;
  const resolveSupport = () => {
    if (!supportResolved) {
      support = selfSupportY(world, px, pz, py, cfg.selfSupportDrop);
      supportResolved = true;
    }
    return support;
  };
  const stages = [
    { seedY: py, band: cfg.maxDy },
    { seedY: resolveSupport, band: cfg.maxDy },
    { seedY: resolveSupport, band: cfg.relaxedDy },
  ];

  for (let i = 0; i < stages.length; i++) {
    const s = stages[i];
    const seedY = typeof s.seedY === 'function' ? s.seedY() : s.seedY;
    if (!Number.isFinite(seedY)) continue;
    // ②③ 与 ① 完全同参时不必重跑（玩家自己就站在支撑面上）
    if (i > 0 && seedY === py && s.band === cfg.maxDy) continue;
    const cells = flood(world, px, seedY, pz, s.band, cfg, playerPos[0], playerPos[2]);
    if (cells.length === 0) continue;
    const pick = cells[Math.min(cells.length - 1, Math.floor(rng() * cells.length))];
    return {
      position: [pick.x + 0.5, pick.y, pick.z + 0.5],
      dy: pick.y - py,
      stage: i + 1,
    };
  }
  return null;
}