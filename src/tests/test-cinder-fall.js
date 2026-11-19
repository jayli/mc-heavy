// src/tests/test-cinder-fall.js — Cinder Fall（第三秒大招）的弹道与命中（v3.21）
//
// 设计：docs/superpowers/specs/2026-11-19-cinder-fall-staged-charge-design.md
//
// 覆盖「改坏了肉眼玩不出来」的部分：
// ① **抛物线末端仍落在准心瞄准点** —— 拱起是叠加在 origin→target 直线上的，
//    不是独立弹道。写成「先抛后落」时仰视/俯视会打不中准心，而飞行看着完全正常。
// ② **判定线段取 prevPosition → position**（抛物线下方向每步在变）——
//    照抄直线弹丸的 `position − direction×stepLen` 会算出错误线段 ⇒ dt 尖峰穿墙。
// ③ **遮挡只看 solidTable**（与飞龙火球同口径，用户「和 storm lance 一样」）——
//    玻璃那条是判别性用例（炮塔的 solid && opaque 会放过它）。
// ④ **实体命中走 entities.raycastAll**（丧尸 + 三种 Boss）——
//    只遍历丧尸的写法打不到 Boss，而计数类判据全绿。
// ⑤ 超距**不爆炸**（没撞到东西就消失）。
// ⑥ 派生关系式：伤害/半径来自爆炸常量、单槽前提、碎块池账。
//
// ⚠️ fixture 用**真实 WorldData + registry**（不是桩件）：`raycastVoxel` 内部读
// `world.registry.idOf('water')`，桩件缺它会让 DDA 直接抛错。
// ⚠️ 本文件同时在 Node 轻档与浏览器整页跑 ⇒ 不得 import node:* 模块。
import { test } from './runner.js';
import { assertEqual, assertTrue, assertNull, assertNotNull, assertDeepEqual } from './assert.js';
import { createRegistry } from '../voxel/block-registry.js';
import { BLOCKS } from '../voxel/blocks-data.js';
import { ChunkColumn } from '../voxel/chunk-column.js';
import { WorldData } from '../voxel/world-data.js';
import { WEAPONS, WEAPON_IDS } from '../player/weapons/weapon-catalog.js';
import { EXPLOSION_DAMAGE, EXPLOSION_DAMAGE_RADIUS } from '../voxel/explosion.js';
import { WEAPON_HITTABLE_TYPES } from '../entities/entity-types.js';
import {
  cinderLaunch, cinderArcPoint, cinderAdvance, CINDER_TYPE,
} from '../player/weapons/cinder-fall.js';
import { cinderDefinition, judgeCinder, CINDER_AABB } from '../entities/cinder/cinder-system.js';

/** assert.js 没有 assertClose，本文件自带（AGENTS.md 已记） */
function assertClose(actual, expected, eps, msg) {
  assertTrue(Math.abs(actual - expected) <= eps,
    `${msg ?? 'assertClose'}: expected ${expected} ±${eps}, got ${actual}`);
}

const CFG = () => WEAPONS[WEAPON_IDS.SWORD].cinderFall;
const SL = () => WEAPONS[WEAPON_IDS.SWORD].stormLance;

function makeRegistry() {
  const reg = createRegistry();
  for (const def of BLOCKS) reg.register(def.name, def);
  reg.freeze();
  return reg;
}

/** 全空气世界（column [0,2]²：20 格射程会跨 column） */
function makeWorld() {
  const registry = makeRegistry();
  const world = new WorldData(registry);
  for (let cx = -1; cx <= 2; cx++) {
    for (let cz = -1; cz <= 2; cz++) {
      const col = new ChunkColumn(cx, cz);
      col.state = 'ready';
      world.add(col);
    }
  }
  return { world, registry };
}

/** 平视 aim（相机在 y=5，朝 −Z） */
function aimFlat(over = {}) {
  return {
    origin: [0, 5, 0], forward: [0, 0, -1], right: [1, 0, 0], up: [0, 1, 0],
    target: null, ...over,
  };
}

/**
 * 造一个假 entities（只实现 raycastAll）。
 *
 * ⚠️⚠️ **hits 给的是「世界坐标点」而不是固定 `dist`**（首版这里错过）：
 * 真实判定是**逐步**的，每步线段只有 `speed × dt` = **0.3 格**（dt=1/60）。
 * 写固定 `dist: 6` 的假 raycast 永远落在窗外 ⇒ 永远不命中 ⇒ 用例会去「修」
 * 本来正确的生产代码。这里按真实语义算：**点到本步线段的投影**在 [0, maxDist]
 * 内、且垂距 ≤ 0.35 格（岩石半径量级）才算命中。
 */
function fakeEntities(hits) {
  return {
    raycastAll(origin, dir, maxDist, predicate) {
      const out = [];
      for (const h of hits) {
        if (predicate && !predicate({ type: h.type ?? 'zombie' })) continue;
        const vx = h.at[0] - origin[0], vy = h.at[1] - origin[1], vz = h.at[2] - origin[2];
        const along = vx * dir[0] + vy * dir[1] + vz * dir[2];
        // ⚠️ **上界取闭区间**（与真 `raycastAabbSlab` 同口径：它判 `tEnter > maxDist`）。
        // 写严格 `<` 会把「恰好落在本步末端」的命中排除掉 —— 而飞到位那一步的
        // 末端正是瞄准点，站在那里敌人本该被打中（实测：along == maxDist == 0.4313）。
        if (along < 0 || along > maxDist + 1e-9) continue;
        const px = origin[0] + dir[0] * along;
        const py = origin[1] + dir[1] * along;
        const pz = origin[2] + dir[2] * along;
        const perp = Math.hypot(h.at[0] - px, h.at[1] - py, h.at[2] - pz);
        if (perp > 0.35) continue;
        out.push({ id: h.id, type: h.type ?? 'zombie', dist: along, point: [px, py, pz] });
      }
      return out.sort((a, b) => a.dist - b.dist);
    },
  };
}

// ==================== ① 配置与派生关系式 ====================

test('cinder catalog: 伤害与溅射半径都派生自爆炸常量（红线 1）', () => {
  const c = CFG();
  assertEqual(c.damage, EXPLOSION_DAMAGE, '不得在本文件写第二份 50');
  assertEqual(c.blastRadius, EXPLOSION_DAMAGE_RADIUS, '溅射半径 = 炸弹伤害半径');
});

test('cinder catalog: 手点与 Storm Lance 同一个（蓄力球在手里，岩石不得从别处飞出）', () => {
  assertDeepEqual(CFG().handOffset, SL().handOffset);
});

test('cinder: 落点特效单槽前提 —— 最长视觉 < 最小施法间隔（载荷性推导）', () => {
  const c = CFG();
  const s = SL();
  // 飞行 + 落点余烬（保守 1.5s，碎块寿命 620ms 之上留余量）
  const visual = c.range / c.speed + 1.5;
  const gap = s.chargeDelaySeconds + s.chargeSeconds + c.chargeSeconds;
  assertTrue(visual < gap,
    `视觉 ${visual.toFixed(3)} 必须 < 最小间隔 ${gap}，否则两次爆炸重叠、单槽不成立`);
  assertTrue(c.cooldown >= gap,
    `冷却 ${c.cooldown} 必须 ≥ 最小施法间隔 ${gap}（否则连发时冷却先于蓄力结束）`);
});

test('cinder: 碎块池账 —— Cinder + 焰魔死亡 + 焰魔砸击 ≤ 池容量', async () => {
  const { IMPACT_FX, IGNIS_DEATH_BURST, IGNIS_SMASH_DEBRIS } =
    await import('../render/block-hit-fx.js');
  const total = CFG().debrisCount + IGNIS_DEATH_BURST.count + IGNIS_SMASH_DEBRIS.count;
  assertTrue(total <= IMPACT_FX.debris.maxActive,
    `碎块并发上限 ${total} 必须 ≤ 池容量 ${IMPACT_FX.debris.maxActive}`
    + '（超池会 FIFO 绕回，观感「只炸出半边」且静默）');
});

test('cinder: type 名不得与既有实体撞（两个渲染器都按 type 过滤）', () => {
  assertEqual(CINDER_TYPE, 'cinder');
  for (const t of ['fireball', 'projectile', 'zombie', 'dragon', 'ignis', 'guardian', 'minecart']) {
    assertTrue(CINDER_TYPE !== t, `不得复用 ${t}`);
  }
  // 自己不在可击中集合里（否则岩石会被自己的后续射线打中）
  assertTrue(!WEAPON_HITTABLE_TYPES.includes(CINDER_TYPE), '岩石不是可被武器击中的类型');
});

// ==================== ② 抛物线（末端仍落在准心）====================

test('cinder 弹道: 起点 = 相机 + handOffset（读作从剑尖抛出）', () => {
  const c = CFG();
  const launch = cinderLaunch(aimFlat(), c, 12);
  const [hr, hu, hf] = c.handOffset;
  assertClose(launch.origin[0], hr, 1e-9);
  assertClose(launch.origin[1], 5 + hu, 1e-9);
  assertClose(launch.origin[2], -hf, 1e-9);
});

test('cinder 弹道: t=1 恰好落在瞄准点（水平与竖直都要）', () => {
  const c = CFG();
  const aim = aimFlat();
  const dist = 12;
  const launch = cinderLaunch(aim, c, dist);
  const end = cinderArcPoint(launch, 1);
  const want = [
    launch.origin[0] + aim.forward[0] * dist,
    launch.origin[1] + aim.forward[1] * dist,
    launch.origin[2] + aim.forward[2] * dist,
  ];
  for (let i = 0; i < 3; i++) assertClose(end[i], want[i], 1e-6, `末端分量 ${i}`);
});

test('cinder 弹道: t=0 恰好是手点', () => {
  const launch = cinderLaunch(aimFlat(), CFG(), 12);
  const p0 = cinderArcPoint(launch, 0);
  for (let i = 0; i < 3; i++) assertClose(p0[i], launch.origin[i], 1e-9, `起点分量 ${i}`);
});

test('cinder 弹道: 中段拱起 ≈ arc（t=0.5 时 sin(π/2)=1）', () => {
  const c = CFG();
  const launch = cinderLaunch(aimFlat(), c, 12);
  const mid = cinderArcPoint(launch, 0.5);
  const linearY = (launch.origin[1] + launch.target[1]) / 2;
  assertClose(mid[1] - linearY, c.arc, 1e-6, '中段必须比直线高出 arc');
});

test('cinder 弹道: 仰视 45° 末端仍落在瞄准点（不是「先抛后落」的独立弹道）', () => {
  const c = CFG();
  const k = Math.SQRT1_2;
  const aim = aimFlat({ forward: [0, k, -k] });
  const dist = 12;
  const launch = cinderLaunch(aim, c, dist);
  const end = cinderArcPoint(launch, 1);
  assertClose(end[1], launch.origin[1] + k * dist, 1e-6, '仰视时末端 y 必须跟着抬高');
  assertClose(end[2], launch.origin[2] - k * dist, 1e-6, '仰视时末端 z');
  // 中段仍要拱起（否则「抛物线」这条需求在仰视时静默失效）
  const mid = cinderArcPoint(launch, 0.5);
  const linearY = (launch.origin[1] + launch.target[1]) / 2;
  assertTrue(mid[1] - linearY > c.arc * 0.9, '仰视时中段仍要拱起');
});

test('cinder 弹道: 俯视 45° 末端仍落在瞄准点', () => {
  const c = CFG();
  const k = Math.SQRT1_2;
  const aim = aimFlat({ forward: [0, -k, -k] });
  const dist = 12;
  const launch = cinderLaunch(aim, c, dist);
  const end = cinderArcPoint(launch, 1);
  assertClose(end[1], launch.origin[1] - k * dist, 1e-6);
  assertClose(end[2], launch.origin[2] - k * dist, 1e-6);
});

test('cinder 弹道: 垂直朝上（水平距离 0）不抛异常，退化成直线', () => {
  const c = CFG();
  const aim = aimFlat({ forward: [0, 1, 0] });
  const launch = cinderLaunch(aim, c, 12);
  const end = cinderArcPoint(launch, 1);
  for (const v of end) assertTrue(Number.isFinite(v), `出现非有限数 ${v}`);
  assertClose(end[1], launch.origin[1] + 12, 1e-6, '垂直时末端仍在瞄准点');
  const mid = cinderArcPoint(launch, 0.5);
  assertClose(mid[1], launch.origin[1] + 6, 1e-6, '退化路径必须是直线（无拱起）');
});

test('cinder 弹道: 瞄准距离超过射程时钳到 range', () => {
  const c = CFG();
  const launch = cinderLaunch(aimFlat(), c, 999);
  assertClose(launch.distance, c.range, 1e-9);
});

test('cinder 弹道: 非法瞄准距离回落 range（不抛异常）', () => {
  const c = CFG();
  for (const bad of [NaN, Infinity, -5, undefined, null]) {
    const launch = cinderLaunch(aimFlat(), c, bad);
    assertTrue(Number.isFinite(launch.distance) && launch.distance > 0, `bad=${bad}`);
  }
});

// ==================== ③ 推进（M5 不变式 + prevPosition）====================

function makeState(aim = aimFlat(), dist = 12, over = {}) {
  const launch = cinderLaunch(aim, CFG(), dist);
  return cinderDefinition.create({ launch, traveled: 0, source: 'sword', ...over });
}

test('cinder state: create 校验形状；AABB = radius 见方', () => {
  const st = makeState();
  assertNotNull(st);
  assertEqual(st.traveled, 0);
  assertDeepEqual(st.prevPosition, st.position, '初始 prevPosition = 起点（首帧无位移）');
  assertEqual(CINDER_AABB.max[0], CFG().radius);
  assertEqual(CINDER_AABB.min[0], -CFG().radius);
  assertNull(cinderDefinition.create({ launch: null }));
  assertNull(cinderDefinition.create(null));
});

test('cinder 推进: 返回全新 state 与全新数组（M5 不变式：否则 column 索引永不迁移）', () => {
  const st = makeState();
  const before = [...st.position];
  const next = cinderDefinition.update({ state: st }, 0.016, {});
  assertTrue(next !== st, '必须返回新对象');
  assertTrue(next.position !== st.position, 'position 数组必须是新引用');
  assertTrue(next.prevPosition !== st.position, 'prevPosition 必须是独立数组');
  assertClose(st.position[2], before[2], 1e-12, '原 state 不得被改写');
});

test('cinder 推进: prevPosition 记录上一步位置（判定线段的来源）', () => {
  const st = makeState();
  const next = cinderDefinition.update({ state: st }, 0.05, {});
  assertDeepEqual(next.prevPosition, st.position, 'prevPosition 必须 = 上一步的 position');
  assertTrue(next.position[2] < next.prevPosition[2], '朝 −Z 飞');
});

test('cinder 推进: traveled 累计 = speed × 总时间（推进只做一遍）', () => {
  let st = makeState(aimFlat(), CFG().range);
  const dt = 1 / 60;
  for (let i = 0; i < 30; i++) st = cinderDefinition.update({ state: st }, dt, {});
  assertClose(st.traveled, CFG().speed * 0.5, 1e-6, '半秒的累计路程');
});

test('cinder 推进: 沿抛物线走 —— 中段 y 高于两端连线', () => {
  let st = makeState(aimFlat(), 12);
  const dt = 1 / 60;
  const ys = [];
  for (let i = 0; i < 40; i++) {
    st = cinderDefinition.update({ state: st }, dt, {});
    ys.push(st.position[1]);
  }
  const maxY = Math.max(...ys);
  assertTrue(maxY > st.launch.origin[1] + CFG().arc * 0.5,
    `飞行中必须真的拱起（峰值 ${maxY}）`);
});

test('cinder 推进: 到达末端后不再前进（traveled 钳在 distance）', () => {
  let st = makeState(aimFlat(), 6);
  for (let i = 0; i < 200; i++) st = cinderDefinition.update({ state: st }, 1 / 60, {});
  assertTrue(st.traveled <= st.launch.distance + 1e-9, `traveled=${st.traveled} 超过射程`);
  const end = cinderArcPoint(st.launch, 1);
  for (let i = 0; i < 3; i++) assertClose(st.position[i], end[i], 1e-6, `末端分量 ${i}`);
});

// ==================== ④ 判定：方块 / 实体 / 超距 ====================

/**
 * 逐步推进 + **逐步判定**，返回第一个非空 reason（模拟真实帧循环）。
 *
 * ⚠️⚠️ **不得只判最后一步**（首版这里错过，得到 4 个假红）：真实帧循环是
 * `entities.update()` 推进 → `_updateCinders()` 判定 → 命中就 despawn。岩石命中后就没了，
 * 而只判末步时它已飞过墙（实测：0.4s 时 z=−7.75，墙在 −6）⇒ reason=null，
 * 看起来像「生产代码没判方块」。
 *
 * ⚠️ **dist 缺省必须与 `pathPointAtZ` 一致**：弹道 t = traveled/distance，
 * 射程不同 ⇒ 同一 z 处高度不同（floor 后差一格）⇒ 摆好的墙碰不到。
 */
function stepAndJudge({ aim = aimFlat(), dist = CFG().range, seconds, world, registry, entities = null }) {
  let st = makeState(aim, dist);
  const dt = 1 / 60;
  const n = Math.max(1, Math.round(seconds / dt));
  for (let i = 0; i < n; i++) {
    st = cinderDefinition.update({ state: st }, dt, {});
    const r = judgeCinder({ next: st, world, registry, entities });
    if (r.reason) return { st, r, steps: i + 1 };
  }
  return { st, r: { reason: null }, steps: n };
}

/**
 * 弹道在指定 z 处的**真实高度**（用来摆墙与敌人）。
 *
 * ⚠️⚠️ **不得凭直觉拿相机 y 当弹道 y**（首版这里错过）：拱起会把岩石抬高一格多。
 * 实测：手点 y=4.78，而飞到 z≈−6 时 y≈**5.99** ⇒ 墙摆在 y=4 永远碰不到，
 * 用例会报「生产代码没判方块」—— 实际是夹具几何错了。
 * 故一律用本函数从**真实弹道**取坐标（判据真值独立于被测判定代码）。
 */
function pathPointAtZ(z, dist = CFG().range) {
  const launch = cinderLaunch(aimFlat(), CFG(), dist);
  const span = launch.origin[2] - launch.target[2];
  const t = (launch.origin[2] - z) / span;
  return cinderArcPoint(launch, t);
}

test('cinder 判定: 无遮挡时一路不爆（reason=null）', () => {
  const { world, registry } = makeWorld();
  const { r } = stepAndJudge({ seconds: 0.2, world, registry, entities: fakeEntities([]) });
  assertNull(r.reason);
});

test('cinder 判定: 撞实心方块 → block，at = 那个 blockPos', () => {
  const { world, registry } = makeWorld();
  // 墙摆在**真实弹道经过的那一格**（pathPointAtZ，不凭直觉拿相机 y）
  const p = pathPointAtZ(-6);
  const cell = [Math.floor(p[0]), Math.floor(p[1]), -6];
  world.setBlock(cell[0], cell[1], cell[2], registry.idOf('stone'));
  const { r } = stepAndJudge({ seconds: 0.4, world, registry, entities: fakeEntities([]) });
  assertEqual(r.reason, 'block');
  assertDeepEqual(r.at, cell);
});

test('cinder 判定: 撞玻璃（solid 但 opaqueTable=0）→ block（**判别性用例**）', () => {
  // ⚠️ 误用炮塔的 `isProjectileOccluding`（solid && opaque）时玻璃会被放过 ⇒ 本例真 FAIL。
  // 用户：「碰到实体方块（**和 storm lance 一样**）」⇒ 与飞龙火球同口径（只看 solid）。
  const { world, registry } = makeWorld();
  const glassId = registry.idOf('glass_block');
  assertEqual(registry.solidTable[glassId], 1, 'sanity：玻璃是 solid');
  assertEqual(registry.opaqueTable[glassId], 0, 'sanity：玻璃 opaqueTable=0（炮塔弹丸会穿过）');
  const p = pathPointAtZ(-6);
  world.setBlock(Math.floor(p[0]), Math.floor(p[1]), -6, glassId);
  const { r } = stepAndJudge({ seconds: 0.4, world, registry, entities: fakeEntities([]) });
  assertEqual(r.reason, 'block', '岩石必须被玻璃挡住');
});

test('cinder 判定: 穿过水与花草（非 solid）→ 不爆', () => {
  const { world, registry } = makeWorld();
  const p = pathPointAtZ(-6);
  const bx = Math.floor(p[0]), by = Math.floor(p[1]);
  for (const name of ['water', 'short_grass', 'flower']) {
    world.setBlock(bx, by, -6, registry.idOf(name));
    const { r } = stepAndJudge({ seconds: 0.4, world, registry, entities: fakeEntities([]) });
    assertNull(r.reason, `${name} 不是 solid，岩石必须穿过`);
    world.setBlock(bx, by, -6, 0);
  }
});

test('cinder 判定: dt 尖峰不穿墙（判定线段取 prevPosition → position）', () => {
  const { world, registry } = makeWorld();
  // 1 格厚的墙在 z=−6；dt=0.2 ⇒ 步长 18×0.2 = 3.6 格，一步就跨过墙
  let st = makeState(aimFlat(), CFG().range);
  // 先飞到墙前（0.2s ≈ 3.6 格 → z≈−4.15）
  for (let i = 0; i < 12; i++) st = cinderDefinition.update({ state: st }, 1 / 60, {});
  assertTrue(st.position[2] > -6, `前提：这一步之前还没到墙（z=${st.position[2]}）`);
  const before = st;
  st = cinderDefinition.update({ state: st }, 0.2, {});
  assertTrue(st.position[2] < -6, `前提：这一步之后已过墙（z=${st.position[2]}）`);
  // 墙要盖住**本步线段实际穿越的高度区间**（抛物线下两端 y 不同）
  const yLo = Math.floor(Math.min(before.position[1], st.position[1]));
  const yHi = Math.floor(Math.max(before.position[1], st.position[1]));
  for (let y = yLo; y <= yHi; y++) world.setBlock(0, y, -6, registry.idOf('stone'));
  const r = judgeCinder({ next: st, world, registry, entities: fakeEntities([]) });
  assertEqual(r.reason, 'block', '3.6 格步长仍须命中 1 格厚的墙');
});

test('cinder 判定: 命中丧尸 → entity，at = 命中点（不是它身后的墙）', () => {
  const { world, registry } = makeWorld();
  const wall = pathPointAtZ(-18);
  world.setBlock(Math.floor(wall[0]), Math.floor(wall[1]), -18, registry.idOf('stone'));
  // 丧尸站在**弹道在 z≈−6 处的真实位置**（逐步判定，每步只 0.3 格）
  const z0 = pathPointAtZ(-6);
  const { r } = stepAndJudge({
    seconds: 0.4, world, registry, entities: fakeEntities([{ id: 'z0', at: z0 }]),
  });
  assertEqual(r.reason, 'entity');
  assertEqual(r.hitId, 'z0');
  assertNotNull(r.at);
  assertTrue(r.at[2] > -18, '落点必须在丧尸身上而不是远处墙上');
});

test('cinder 判定: 三种 Boss 都能命中（只遍历丧尸的写法打不到它们）', () => {
  const { world, registry } = makeWorld();
  const at = pathPointAtZ(-6);
  for (const type of ['dragon', 'ignis', 'guardian']) {
    assertTrue(WEAPON_HITTABLE_TYPES.includes(type), `sanity：${type} 在可击中集合里`);
    const { r } = stepAndJudge({
      seconds: 0.4, world, registry,
      entities: fakeEntities([{ id: `b-${type}`, type, at }]),
    });
    assertEqual(r.reason, 'entity', `${type} 必须被命中`);
    assertEqual(r.hitId, `b-${type}`);
  }
});

test('cinder 判定: 不可击中的类型（矿车/弹丸）不参与命中', () => {
  const { world, registry } = makeWorld();
  const at = pathPointAtZ(-6);
  const entities = {
    raycastAll(origin, dir, maxDist, predicate) {
      // 真实 EntityManager 会消费 predicate；这里显式验证它真的被传下去且生效
      const all = [{ id: 'cart', type: 'minecart' }, { id: 'shot', type: 'projectile' }];
      return all
        .filter((h) => (predicate ? predicate({ type: h.type }) : true))
        .map((h) => ({ ...h, dist: 0.1, point: [...at] }));
    },
  };
  const { r } = stepAndJudge({ seconds: 0.4, world, registry, entities });
  assertNull(r.reason, '矿车/弹丸不得挡下岩石');
});

test('cinder 判定: 飞满射程 ⇒ end-of-flight 且**给 at**（在末端自爆）', () => {
  const { world, registry } = makeWorld();
  const { r } = stepAndJudge({
    dist: CFG().range, seconds: CFG().range / CFG().speed + 0.2,
    world, registry, entities: fakeEntities([]),
  });
  // ⚠️ 新语义（本轮实测修正）：本招的 distance 是**瞄准点**而不是安全上限，
  // 飞到了就该炸（用户：「扔出去的球只要碰到…都爆炸」）。
  // 旧写法照搬直线弹丸的「超距不爆」⇒ 最后一步被静默吃掉（球飞到了但没炸）。
  assertEqual(r.reason, 'end-of-flight');
  assertNotNull(r.at, '末端自爆必须给落点');
});

test('cinder 判定: 顺序 —— 途中命中优先于末端自爆', () => {
  const { world, registry } = makeWorld();
  // 在飞行中途摆一只丧尸 ⇒ 必须先打在它身上，而不是飞到末端才炸
  const mid = pathPointAtZ(-6);
  const { r, st } = stepAndJudge({
    dist: CFG().range, seconds: 0.4,
    world, registry, entities: fakeEntities([{ id: 'z0', at: mid }]),
  });
  assertEqual(r.reason, 'entity', '途中撞到实体就该立即爆');
  assertEqual(r.hitId, 'z0');
  assertTrue(st.traveled < st.launch.distance, '前提：此时还没飞到末端');
});

test('cinder 判定: 到达瞄准点那一步必须爆炸（不得静默消失）', () => {
  const { world, registry } = makeWorld();
  // ⚠️⚠️ **本轮浏览器实测抓到的真缺陷**：岩石在 t≈150ms 消失而 blasts=0。
  // 根因：`update` 把 traveled 钳在 distance，而 judge ① 先判 `traveled >= distance`
  // ⇒ **抵达瞄准点的最后一步永不被判方块/实体**，直接当超距静默 despawn。
  // 形态：朝地面/近处敌人扔时「球飞到了但没炸」，而计数类判据全绿。
  // 造一个真地面：瞄准点就在地表上方，飞到位那一格下方是实心
  const launch = cinderLaunch(aimFlat(), CFG(), 6);
  const end = cinderArcPoint(launch, 1);
  // 在末端**所在格**放实心（岩石飞到那里就该撞上）
  world.setBlock(Math.floor(end[0]), Math.floor(end[1]), Math.floor(end[2]),
    registry.idOf('stone'));
  let st = cinderDefinition.create({ launch, traveled: 0 });
  let sawBlast = null;
  for (let i = 0; i < 60; i++) {
    st = cinderDefinition.update({ state: st }, 1 / 60, {});
    const r = judgeCinder({ next: st, world, registry, entities: fakeEntities([]) });
    if (r.reason) { sawBlast = r; break; }
  }
  assertNotNull(sawBlast, '必须有个终结理由');
  assertEqual(sawBlast.reason, 'block', '抵达瞄准点那一步必须判撞地，不得当超距静默消失');
  assertNotNull(sawBlast.at, '必须给爆炸中心');
});

test('cinder 判定: 抵达末端时命中实体也要爆（最后一步不得被超距吃掉）', () => {
  const { world, registry } = makeWorld();
  const launch = cinderLaunch(aimFlat(), CFG(), 6);
  const end = cinderArcPoint(launch, 1);
  let st = cinderDefinition.create({ launch, traveled: 0 });
  let saw = null;
  for (let i = 0; i < 60; i++) {
    st = cinderDefinition.update({ state: st }, 1 / 60, {});
    const r = judgeCinder({
      next: st, world, registry, entities: fakeEntities([{ id: 'zEnd', at: end }]),
    });
    if (r.reason) { saw = r; break; }
  }
  assertNotNull(saw);
  assertEqual(saw.reason, 'entity', '末端站在瞄准点的敌人必须被打中');
  assertEqual(saw.hitId, 'zEnd');
});

test('cinder 判定: 开阔地抵达末端 ⇒ 空中自爆（用户「扔出去的球…都爆炸」）', () => {
  const { world, registry } = makeWorld();
  const launch = cinderLaunch(aimFlat(), CFG(), 6);
  let st = cinderDefinition.create({ launch, traveled: 0 });
  let saw = null;
  for (let i = 0; i < 60; i++) {
    st = cinderDefinition.update({ state: st }, 1 / 60, {});
    const r = judgeCinder({ next: st, world, registry, entities: fakeEntities([]) });
    if (r.reason) { saw = r; break; }
  }
  assertNotNull(saw);
  assertEqual(saw.reason, 'end-of-flight');
  assertNotNull(saw.at, '末端自爆必须给落点（否则渲染层不知道在哪炸）');
  const end = cinderArcPoint(launch, 1);
  for (let i = 0; i < 3; i++) assertClose(saw.at[i], end[i], 1e-6, `落点分量 ${i}`);
});

test('cinder 判定: 零位移帧（prevPosition == position）不抛异常', () => {
  const { world, registry } = makeWorld();
  const st = makeState();
  const r = judgeCinder({ next: st, world, registry, entities: fakeEntities([]) });
  assertNull(r.reason, '首帧无位移 ⇒ 无命中（不得因零方向崩掉）');
});

// ==================== ⑤ 薄封装（单测用，帧循环不用）====================

test('cinderAdvance: 推进 + 判定一次完成（单测夹具）', () => {
  const { world, registry } = makeWorld();
  const launch = cinderLaunch(aimFlat(), CFG(), 12);
  const st = cinderDefinition.create({ launch, traveled: 0 });
  // 判定器经参数注入（player/ 不得反向依赖 entities/），但两侧都是**生产代码**
  const r = cinderAdvance({
    state: st, dt: 0.05, world, registry, entities: fakeEntities([]),
    advance: cinderDefinition.update, judge: judgeCinder,
  });
  assertTrue(r.alive, '开阔地第一步不该死');
  assertTrue(r.state.position[2] < st.position[2]);
});

test('cinder 存档: 临时实体不进存档（serialize/deserialize 返回 null）', () => {
  assertNull(cinderDefinition.serialize());
  assertNull(cinderDefinition.deserialize());
});