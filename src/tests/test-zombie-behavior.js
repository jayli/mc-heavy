// src/tests/test-zombie-behavior.js — 丧尸行为层（犹豫/后退/徘徊/速度包络/转身限速）
//
// 设计：docs/superpowers/specs/2026-11-16-zombie-behavior-realism-design.md
// 计划：docs/superpowers/plans/2026-11-16-zombie-behavior-realism.md
//
// ⚠️ 断言里的期望值一律用**字面量**，不从被测常量派生（testing-policy §2.7 第 7 类：
// 输入从被测常量派生时，注入把常量改错的缺陷会让断言恒真）。
import { test } from './runner.js';
import { assertEqual, assertTrue, assertFalse } from './assert.js';
import { ZOMBIE_BEHAVIOR, ZOMBIE_MAX_STEP } from '../entities/zombies/zombie-config.js';
import { behaviorFor, recordSample, detectStuck } from '../entities/zombies/zombie-behavior.js';
import { memoryFor, decideStep, DIRECTION_VECTORS } from '../entities/zombies/zombie-navigator.js';
import { PathCache } from '../entities/zombies/zombie-pathfinder.js';
import { zombieCollidesAt, zombieStepUpY } from '../entities/zombies/zombie-navigation.js';
import { ZombieService, zombieDefinition } from '../entities/zombies/zombie-system.js';
import { EntityManager } from '../entities/entity-manager.js';
import { createRegistry } from '../voxel/block-registry.js';
import { ChunkColumn } from '../voxel/chunk-column.js';
import { WorldData } from '../voxel/world-data.js';
import { WORLD_MIN_Y } from '../voxel/constants.js';

/**
 * 平地世界（与 test-zombie-pathfinder.js 的 makeFlat 同手法）。
 * `top=0` ⇒ 地面只到 y=0，丧尸站 y=1。
 */
function makeFlat({ size = 64, top = 0 } = {}) {
  const registry = createRegistry();
  registry.register('air', { solid: false, opaque: false, cullMode: 'none' });
  registry.register('stone', { solid: true, opaque: true, cullMode: 'opaque' });
  registry.register('bedrock', { solid: true, opaque: true, cullMode: 'opaque' });
  registry.freeze();
  const stone = registry.idOf('stone');
  const world = new WorldData(registry);
  for (let cx = 0; cx * 16 < size; cx++) {
    for (let cz = 0; cz * 16 < size; cz++) {
      const col = new ChunkColumn(cx, cz);
      for (let lx = 0; lx < 16; lx++) {
        for (let lz = 0; lz < 16; lz++) {
          for (let y = WORLD_MIN_Y; y <= top; y++) col.set(lx, y, lz, stone);
        }
      }
      world.add(col);
    }
  }
  return { world, set: (x, y, z) => world.setBlock(x, y, z, stone) };
}

/** 格坐标可走判据 —— 与生产 `_stepNavigator` 的 isWalkable 同源 */
function makeWalkable() {
  return (w, bx, y, bz) => {
    if (!zombieCollidesAt(w, bx + 0.5, y, bz + 0.5)) return true;
    const lifted = zombieStepUpY(y);
    return lifted - y <= ZOMBIE_MAX_STEP && !zombieCollidesAt(w, bx + 0.5, lifted, bz + 0.5);
  };
}

/** 造一份 behavior，hist 铺满一个窗口：两端相距 disp 格 */
function behaviorWithDisp(disp, nowMs = 10000) {
  const b = behaviorFor(memoryFor(new Map(), 'z0'), nowMs);
  const winMs = 1500; // 字面量：窗口 1.5s
  b.hist.length = 0;
  b.hist.push([nowMs - winMs, 32.5, 32]);
  b.hist.push([nowMs, 32.5 + disp, 32]);
  return b;
}

// ==================== Task 1：冻结常量表 ====================

test('ZOMBIE_BEHAVIOR: 阈值取实测标定值', () => {
  assertEqual(ZOMBIE_BEHAVIOR.arriveDistance, 1.5);
  assertEqual(ZOMBIE_BEHAVIOR.stuckWindowSeconds, 1.5);
  assertEqual(ZOMBIE_BEHAVIOR.stuckDistance, 0.35);
  assertEqual(ZOMBIE_BEHAVIOR.awayAngleDeg, 120);
  assertEqual(ZOMBIE_BEHAVIOR.cruiseScaleMin, 0.92);
  assertEqual(ZOMBIE_BEHAVIOR.turnRateDegPerSec, 540);
});

test('ZOMBIE_BEHAVIOR: 载荷性不变式（到达门/巡航下界/卡住阈值/区间顺序）', () => {
  // ① 到达门必须大于正常抵达距离 0.67（实测），否则「追到就退开」
  assertTrue(ZOMBIE_BEHAVIOR.arriveDistance > 0.67, '到达门须大于实测抵达距离 0.67');
  // ② 到达门必须小于信号B距离门（两信号职责不重叠：A 管远而走不动，B 管近而没路）
  assertTrue(ZOMBIE_BEHAVIOR.arriveDistance < ZOMBIE_BEHAVIOR.nearPlayerDistance,
    '到达门须小于信号B距离门');
  // ③ 巡航下界不得低于 0.90（既有 12s 绕墙 E2E 的实测余量：0.80 贴线、0.70 FAIL）
  assertTrue(ZOMBIE_BEHAVIOR.cruiseScaleMin >= 0.90, '巡航下界须保住既有 E2E 余量');
  assertTrue(ZOMBIE_BEHAVIOR.cruiseScaleMax <= 1.0, '巡航不得超过 ZOMBIE.speed');
  // ④ 卡住阈值须小于正常绕墙的窗口净位移最小值 0.85（实测）
  assertTrue(ZOMBIE_BEHAVIOR.stuckDistance < 0.85, '卡住阈值须小于正常绕墙最小净位移');
  // ⑤ 区间上下界顺序
  assertTrue(ZOMBIE_BEHAVIOR.hesitateSecondsMin < ZOMBIE_BEHAVIOR.hesitateSecondsMax);
  assertTrue(ZOMBIE_BEHAVIOR.backoffDistanceMin < ZOMBIE_BEHAVIOR.backoffDistanceMax);
  assertTrue(ZOMBIE_BEHAVIOR.cruisePeriodSecondsMin < ZOMBIE_BEHAVIOR.cruisePeriodSecondsMax);
  assertTrue(ZOMBIE_BEHAVIOR.paceStepsMin <= ZOMBIE_BEHAVIOR.paceStepsMax);
  // ⑥ 各状态速度倍率都不得超过 1（速度上限权威仍是 ZOMBIE.speed）
  assertTrue(ZOMBIE_BEHAVIOR.backoffSpeedScale <= 1.0);
  assertTrue(ZOMBIE_BEHAVIOR.wanderSpeedScale <= 1.0);
  assertTrue(ZOMBIE_BEHAVIOR.turnSlowFloor > 0 && ZOMBIE_BEHAVIOR.turnSlowFloor <= 1.0);
});

// ==================== Task 2：卡住检测 ====================

test('behaviorFor: 同一 memory 复用同一 behavior，不同 id 各自独立', () => {
  const map = new Map();
  const m0 = memoryFor(map, 'z0');
  const b1 = behaviorFor(m0, 0);
  const b2 = behaviorFor(m0, 100);
  assertTrue(b1 === b2, '同一 memory 须复用同一 behavior 对象');
  const bOther = behaviorFor(memoryFor(map, 'z1'), 0);
  assertFalse(b1 === bOther, '不同 id 须各自独立');
  assertEqual(b1.phase, 'chase', '初始 phase 须为 chase');
  assertEqual(b1.hist.length, 0, '初始 hist 为空');
  assertEqual(b1.awaySince, null, '初始 awaySince 为 null');
});

test('recordSample: 滚动窗口只保留最近 1.5 秒', () => {
  const b = behaviorFor(memoryFor(new Map(), 'z0'), 0);
  // 每 50ms 采一次，共 4 秒
  for (let t = 0; t <= 4000; t += 50) recordSample(b, [32.5 + t / 1000, 1, 32], t);
  const oldest = b.hist[0][0];
  assertTrue(4000 - oldest <= 1500 + 50, `窗口跨度须 ≤1.5s（+一采样间隔），实际 ${4000 - oldest}ms`);
  assertTrue(b.hist.length <= 32, `采样数须有界，实际 ${b.hist.length}`);
});

test('detectStuck d1: 距玩家11.5格 + 1.5s净位移0.02 ⇒ no-progress', () => {
  const nowMs = 10000;
  const b = behaviorWithDisp(0.02, nowMs);
  const r = detectStuck({
    behavior: b, position: [32.52, 1, 32], playerPosition: [32.5, 1, 20.5],
    plannedDirection: 'east', blocked: false, nowMs,
  });
  assertTrue(r.stuck, '远且走不动 ⇒ 须判卡住');
  assertEqual(r.reason, 'no-progress');
});

test('detectStuck d2: 1.5s净位移1.04格（正常绕墙）⇒ 不触发', () => {
  const nowMs = 10000;
  const b = behaviorWithDisp(1.04, nowMs);
  const r = detectStuck({
    behavior: b, position: [33.54, 1, 32], playerPosition: [32.5, 1, 20.5],
    plannedDirection: 'east', blocked: false, nowMs,
  });
  assertFalse(r.stuck, '正常绕墙的净位移不得判卡住');
  assertEqual(r.reason, 'none');
});

test('detectStuck d3: 净位移0 但距玩家0.48格（已抵达）⇒ 不触发【到达门】', () => {
  // ⚠️ 这条是本轮实测新增的核心防线：丧尸追到玩家身边后本来就零位移，
  // 没有到达门 ⇒ 每只追上玩家的丧尸都会开始「犹豫+后退」（实测开阔地 191 帧误触发）。
  const nowMs = 10000;
  const b = behaviorWithDisp(0, nowMs);
  b.hist.length = 0;
  b.hist.push([nowMs - 1500, 32.5, 20.98]);
  b.hist.push([nowMs, 32.5, 20.98]);
  const r = detectStuck({
    behavior: b, position: [32.5, 1, 20.98], playerPosition: [32.5, 1, 20.5],
    plannedDirection: null, blocked: false, nowMs,
  });
  assertFalse(r.stuck, '已抵达玩家身边 ⇒ 不得判卡住（否则追到就退开）');
  assertEqual(r.reason, 'none');
});

test('detectStuck d4: 窗口未铺满（开局）⇒ 不触发', () => {
  const nowMs = 500;
  const b = behaviorFor(memoryFor(new Map(), 'z0'), 0);
  recordSample(b, [32.5, 1, 32], 0);
  recordSample(b, [32.5, 1, 32], 500);
  const r = detectStuck({
    behavior: b, position: [32.5, 1, 32], playerPosition: [32.5, 1, 20.5],
    plannedDirection: 'north', blocked: false, nowMs,
  });
  assertFalse(r.stuck, '窗口未铺满时不得判卡住（避免开局误判）');
});

/** 造一个「规划方向与朝玩家直线夹角 ≈ angDeg」的场景，返回 detectStuck 入参 */
function awayCase({ dist, angDeg, holdMs, nowMs = 10000 }) {
  // 玩家在丧尸正北 dist 格；规划方向取与「朝玩家」夹角 angDeg 的 8 向之一
  const position = [32.5, 1, 32.5];
  const playerPosition = [32.5, 1, 32.5 - dist];
  // 朝玩家单位向量 = (0,-1)（正北）。绕它转 angDeg 得到目标方向，再找最近的 8 向名
  const th = (angDeg * Math.PI) / 180;
  const tx = 0 * Math.cos(th) - (-1) * Math.sin(th);
  const tz = 0 * Math.sin(th) + (-1) * Math.cos(th);
  let best = null, bestDot = -Infinity;
  for (const [name, v] of Object.entries(DIRECTION_VECTORS)) {
    const len = Math.hypot(v[0], v[1]);
    const dot = (v[0] / len) * tx + (v[1] / len) * tz;
    if (dot > bestDot) { bestDot = dot; best = name; }
  }
  const b = behaviorFor(memoryFor(new Map(), 'z0'), nowMs);
  // hist 铺满且净位移足够大（隔离信号 A，只考察信号 B）
  b.hist.push([nowMs - 1500, 32.5, 32.5]);
  b.hist.push([nowMs, 33.9, 32.5]);
  if (holdMs > 0) b.awaySince = nowMs - holdMs;
  return { behavior: b, position, playerPosition, plannedDirection: best, blocked: false, nowMs };
}

test('detectStuck e1: 距5格 + 背离160° + 持续0.8s ⇒ no-way', () => {
  const p = awayCase({ dist: 5, angDeg: 160, holdMs: 800 });
  const r = detectStuck(p);
  assertTrue(r.stuck, `近距 + 大背离角 + 够时长 ⇒ 须判没路（plannedDirection=${p.plannedDirection}）`);
  assertEqual(r.reason, 'no-way');
});

test('detectStuck e2: 距5格 + 背离74°（正常绕墙）+ 持续0.8s ⇒ 不触发', () => {
  const p = awayCase({ dist: 5, angDeg: 74, holdMs: 800 });
  const r = detectStuck(p);
  assertFalse(r.stuck, '正常绕墙的背离角不得判没路');
});

test('detectStuck e3: 距20格 + 背离160° + 持续0.8s ⇒ 不触发【距离门】', () => {
  const p = awayCase({ dist: 20, angDeg: 160, holdMs: 800 });
  const r = detectStuck(p);
  assertFalse(r.stuck, '远离玩家时的大背离角是合法绕行，不得判没路');
});

test('detectStuck e4: 距5格 + 背离160° 但只持续0.3s ⇒ 不触发【时长门】', () => {
  const p = awayCase({ dist: 5, angDeg: 160, holdMs: 300 });
  const r = detectStuck(p);
  assertFalse(r.stuck, '未持续够时长的瞬时背离不得判没路');
});

test('detectStuck e5: 背离角回落后 awaySince 须清零（不能攒够时长）', () => {
  const nowMs = 10000;
  const p = awayCase({ dist: 5, angDeg: 160, holdMs: 700, nowMs });
  detectStuck(p);
  // 下一拍方向回到朝玩家（0°）⇒ 计时须清零
  const back = { ...p, plannedDirection: 'north', nowMs: nowMs + 50 };
  detectStuck(back);
  assertEqual(p.behavior.awaySince, null, '背离角回落后须清零计时');
  // 再回到大背离角 ⇒ 从零重新计时，不得立刻触发
  const again = { ...p, nowMs: nowMs + 100 };
  const r = detectStuck(again);
  assertFalse(r.stuck, '清零后须重新累计时长');
});

test('detectStuck c: decideStep 报 blocked ⇒ reason=blocked（围死语义不变）', () => {
  const nowMs = 10000;
  const b = behaviorWithDisp(2.0, nowMs);
  const r = detectStuck({
    behavior: b, position: [32.5, 1, 32], playerPosition: [32.5, 1, 20.5],
    plannedDirection: null, blocked: true, nowMs,
  });
  assertTrue(r.stuck);
  assertEqual(r.reason, 'blocked', 'blocked 优先级最高');
});

test('detectStuck m: 1格宽门洞与2格高走廊全程不触发卡住，且真的走过去了', () => {
  // ⚠️ 两个夹具都已在写计划阶段实测验证（16s 后 z=22.98）。
  // ⚠️ 必须同时断言「走过去了」：只断言「没触发」时「丧尸压根没动」也会全绿。
  const fixtures = [
    {
      label: '1格宽门洞',
      build: (set) => {
        for (let z = 20; z <= 45; z++) for (let dy = 0; dy < 3; dy++) { set(31, 1 + dy, z); set(33, 1 + dy, z); }
      },
    },
    {
      label: '2格高走廊',
      build: (set) => {
        for (let z = 20; z <= 45; z++) for (let dy = 0; dy < 3; dy++) { set(31, 1 + dy, z); set(34, 1 + dy, z); }
        for (let z = 20; z <= 45; z++) for (let x = 31; x <= 34; x++) set(x, 3, z);
      },
    },
  ];
  for (const fx of fixtures) {
    const { world, set } = makeFlat();
    fx.build(set);
    const entities = new EntityManager();
    entities.registerType('zombie', zombieDefinition);
    const zombies = new ZombieService({ entities, world });
    const id = zombies.spawn([32.5, 1, 40.5], { source: 'test' });
    assertTrue(id !== null, `${fx.label}: 前提须能生成`);
    const playerPosition = [32.5, 1, 22.5];
    const mem = memoryFor(new Map(), id);
    const b = behaviorFor(mem, 0);
    const cache = new PathCache();
    const isWalkable = makeWalkable();
    const dt = 1 / 60;
    let t = 0, triggers = 0;
    while (t < 16) {
      zombies.update(dt, { playerPosition, nowMs: t * 1000 });
      entities.update(dt, { world });
      const st = zombies.get(id);
      const nowMs = t * 1000;
      const step = decideStep({
        world, position: st.position, playerPosition, memory: mem,
        pathCache: cache, nowMs, isWalkable,
      });
      recordSample(b, st.position, nowMs);
      const r = detectStuck({
        behavior: b, position: st.position, playerPosition,
        plannedDirection: step.plannedDirection, blocked: step.blocked, nowMs,
      });
      if (r.stuck) triggers++;
      t += dt;
    }
    const endZ = zombies.get(id).position[2];
    assertEqual(triggers, 0, `${fx.label}: 全程不得触发卡住（实际 ${triggers} 次）`);
    assertTrue(endZ < 30, `${fx.label}: 须真的走过去（末 z=${endZ.toFixed(2)}，起点 40.5）`);
  }
});