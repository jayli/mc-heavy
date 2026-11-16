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
import {
  behaviorFor, recordSample, detectStuck, decideBehavior, speedScale, steerYawLimited,
} from '../entities/zombies/zombie-behavior.js';
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
 * 浮点比较（本文件局部）。⚠️ `assert.js` 没有 `assertClose`（它是 `test-zombies.js`
 * 的文件内局部函数）—— 本文件自己定义一份。
 */
function assertClose(actual, expected, tolerance, message = '') {
  if (!(Math.abs(actual - expected) <= tolerance)) {
    throw new Error(`${message ? message + ': ' : ''}Expected ~${expected} (±${tolerance}), got ${actual}`);
  }
}

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
// ==================== Task 3：状态机 ====================

/** 造一个「远且走不动」的 behavior（信号 A 会触发） */
function stuckBehavior(nowMs) {
  const b = behaviorFor(memoryFor(new Map(), 'z0'), nowMs);
  b.hist.length = 0;
  b.hist.push([nowMs - 1500, 32.5, 32.5]);
  b.hist.push([nowMs, 32.5, 32.5]);
  return b;
}

/** 朝北的 decideStep 结果（玩家在正北） */
const NORTH_STEP = { vx: 0, vz: -1, mode: 'chasing', plannedDirection: 'north', blocked: false, reachable: true };
/** 「A* 判不可达但仍给出沿墙方向」——徘徊类用例必须用它，否则语义自相矛盾 */
const UNREACHABLE_STEP = { ...NORTH_STEP, reachable: false };
const FAR_PLAYER = [32.5, 1, 20.5];
const FAR_POS = [32.5, 1, 32.5];

test('decideBehavior 前置门: 距玩家0.48格 ⇒ 恒 chase，不进任何新状态', () => {
  const nowMs = 10000;
  const b = stuckBehavior(nowMs);
  // 位置改到玩家跟前（0.48 格），hist 也同点 ⇒ 净位移 0 但已抵达
  b.hist.length = 0;
  b.hist.push([nowMs - 1500, 32.5, 20.98]);
  b.hist.push([nowMs, 32.5, 20.98]);
  const r = decideBehavior({
    behavior: b, position: [32.5, 1, 20.98], playerPosition: FAR_PLAYER,
    step: NORTH_STEP, nowMs, rng: () => 0,
  });
  assertEqual(r.phase, 'chase', '已抵达 ⇒ 不得进犹豫/后退/徘徊');
  assertEqual(r.mode, 'chasing');
  assertFalse(r.replan);
});

test('decideBehavior n: blocked（四面围死）⇒ mode=blocked，不进犹豫', () => {
  const nowMs = 10000;
  const b = stuckBehavior(nowMs);
  const r = decideBehavior({
    behavior: b, position: FAR_POS, playerPosition: FAR_PLAYER,
    step: { vx: 0, vz: 0, mode: 'blocked', plannedDirection: null, blocked: true },
    nowMs, rng: () => 0,
  });
  assertEqual(r.mode, 'blocked', '围死须保持既有 blocked 语义');
  assertEqual(r.vx, 0);
  assertEqual(r.vz, 0);
  assertFalse(r.phase === 'hesitate' || r.phase === 'backoff' || r.phase === 'wander',
    '围死不得进犹豫循环');
});

test('decideBehavior f: 状态序 chase→hesitate→backoff→replan（rng 两端）', () => {
  for (const rngVal of [0, 1]) {
    const rng = () => rngVal;
    let nowMs = 10000;
    const b = stuckBehavior(nowMs);
    const phases = [];
    let hesitateStart = null, hesitateEnd = null;
    // 逐拍推进 6 秒（20Hz），位置固定不动（持续卡住）
    for (let i = 0; i < 120; i++) {
      const r = decideBehavior({
        behavior: b, position: FAR_POS, playerPosition: FAR_PLAYER,
        step: NORTH_STEP, nowMs, rng,
      });
      phases.push(r.phase);
      if (r.phase === 'hesitate' && hesitateStart === null) hesitateStart = nowMs;
      if (hesitateStart !== null && hesitateEnd === null && r.phase !== 'hesitate') hesitateEnd = nowMs;
      recordSample(b, FAR_POS, nowMs);
      nowMs += 50;
    }
    assertTrue(phases.includes('hesitate'), `rng=${rngVal}: 须出现 hesitate`);
    assertTrue(phases.includes('backoff'), `rng=${rngVal}: 须出现 backoff`);
    assertTrue(phases.indexOf('hesitate') < phases.indexOf('backoff'),
      `rng=${rngVal}: hesitate 须早于 backoff`);
    assertTrue(phases.includes('replan'), `rng=${rngVal}: 须出现 replan`);
    // hesitate 时长落在配置区间（±一个决策周期 50ms 的量子化容差）
    const dur = (hesitateEnd - hesitateStart) / 1000;
    assertTrue(dur >= 0.6 - 0.05 && dur <= 1.2 + 0.05,
      `rng=${rngVal}: hesitate 时长须在 [0.6,1.2]，实际 ${dur}`);
  }
});

test('decideBehavior g: hesitate 期间 vx=vz=0（愣住）', () => {
  let nowMs = 10000;
  const b = stuckBehavior(nowMs);
  let sawHesitate = false;
  for (let i = 0; i < 40; i++) {
    const r = decideBehavior({
      behavior: b, position: FAR_POS, playerPosition: FAR_PLAYER,
      step: NORTH_STEP, nowMs, rng: () => 0,
    });
    if (r.phase === 'hesitate') {
      sawHesitate = true;
      assertEqual(r.vx, 0, 'hesitate 须零速度');
      assertEqual(r.vz, 0, 'hesitate 须零速度');
      assertEqual(r.mode, 'hesitating');
    }
    recordSample(b, FAR_POS, nowMs);
    nowMs += 50;
  }
  assertTrue(sawHesitate, '前提：须真的进过 hesitate');
});

test('decideBehavior h: backoff 方向背离玩家，mode=backing', () => {
  let nowMs = 10000;
  const b = stuckBehavior(nowMs);
  let sawBackoff = false;
  for (let i = 0; i < 60; i++) {
    const r = decideBehavior({
      behavior: b, position: FAR_POS, playerPosition: FAR_PLAYER,
      step: NORTH_STEP, nowMs, rng: () => 0.5,
    });
    if (r.phase === 'backoff') {
      sawBackoff = true;
      assertEqual(r.mode, 'backing');
      // 玩家在正北 ⇒ 背离玩家 = 正南 ⇒ vz > 0
      assertTrue(r.vz > 0, `后退须背离玩家（vz=${r.vz}）`);
      assertClose(Math.abs(r.vx), 0, 1e-9, '正南后退时 vx 须为 0');
    }
    recordSample(b, FAR_POS, nowMs);
    nowMs += 50;
  }
  assertTrue(sawBackoff, '前提：须真的进过 backoff');
});

test('decideBehavior i: backoff 背后撞墙 ⇒ 立即结束（不硬顶）', () => {
  // 夹具：丧尸 [32.5,1,32.5] 关在一条**东西向封死**的夹缝里：
  //   z=31 与 z=34 各一道 3 格高墙（挡住北面的玩家与南面的退路），
  //   x=31 与 x=34 再各一道墙把东西两端也封上。
  // ⚠️ **东西两端必须封**（实测踩到）：只建 z 方向两道墙时丧尸会沿夹缝横向跑
  //   到墙端外绕过去 ⇒ 它一直「走得动」⇒ 信号 A 永不触发 ⇒ 根本进不了 backoff，
  //   用例的前提断言直接红（那是夹具缺陷，不是实现缺陷）。
  // 玩家在正北 ⇒ 后退正南；退 1.0 格可走、退 1.5 格撞墙。
  const { world, set } = makeFlat();
  for (let x = 31; x <= 34; x++) {
    for (let dy = 0; dy < 3; dy++) { set(x, 1 + dy, 31); set(x, 1 + dy, 34); }
  }
  for (let z = 31; z <= 34; z++) {
    for (let dy = 0; dy < 3; dy++) { set(31, 1 + dy, z); set(34, 1 + dy, z); }
  }
  // 前提断言：夹具真的是「退 1.0 可走、退 1.5 撞墙」
  assertFalse(zombieCollidesAt(world, 32.5, 1, 33.5), '前提：退 1.0 格须可走');
  assertTrue(zombieCollidesAt(world, 32.5, 1, 34.0), '前提：退 1.5 格须撞墙');

  const entities = new EntityManager();
  entities.registerType('zombie', zombieDefinition);
  const zombies = new ZombieService({ entities, world });
  const id = zombies.spawn([32.5, 1, 32.5], { source: 'test' });
  assertTrue(id !== null, '前提：夹缝内须能生成');
  const mem = memoryFor(new Map(), id);
  const b = behaviorFor(mem, 0);
  const cache = new PathCache();
  const isWalkable = makeWalkable();
  const dt = 1 / 60;
  let t = 0, backoffTicks = 0, maxSouthDisp = 0;
  const startZ = 32.5;
  while (t < 12) {
    zombies.update(dt, { playerPosition: FAR_PLAYER, nowMs: t * 1000 });
    entities.update(dt, { world });
    const st = zombies.get(id);
    const nowMs = t * 1000;
    const step = decideStep({
      world, position: st.position, playerPosition: FAR_PLAYER, memory: mem,
      pathCache: cache, nowMs, isWalkable,
    });
    recordSample(b, st.position, nowMs);
    const r = decideBehavior({
      behavior: b, position: st.position, playerPosition: FAR_PLAYER,
      step, nowMs, rng: () => 1,   // 取后退距离上界 2.0 格
    });
    if (r.phase === 'backoff') backoffTicks++;
    maxSouthDisp = Math.max(maxSouthDisp, st.position[2] - startZ);
    t += dt;
  }
  assertTrue(backoffTicks > 0, '前提：须真的进过 backoff');
  // 退够 2.0 格需要撞穿 z=34 的墙 ⇒ 实际最大南移必须明显小于 2.0
  assertTrue(maxSouthDisp < 1.5,
    `背后撞墙时不得硬顶到目标距离（实际南移 ${maxSouthDisp.toFixed(3)} 格）`);
});

test('decideBehavior j: replan 拍返回 replan=true', () => {
  let nowMs = 10000;
  const b = stuckBehavior(nowMs);
  let sawReplan = false;
  for (let i = 0; i < 120; i++) {
    const r = decideBehavior({
      behavior: b, position: FAR_POS, playerPosition: FAR_PLAYER,
      step: NORTH_STEP, nowMs, rng: () => 0,
    });
    if (r.phase === 'replan') { sawReplan = true; assertTrue(r.replan, 'replan 拍须要求清缓存'); }
    recordSample(b, FAR_POS, nowMs);
    nowMs += 50;
  }
  assertTrue(sawReplan, '前提：须真的进过 replan');
});

test('decideBehavior k: 连续失败3次 ⇒ wander，且 wander 有非零位移', () => {
  let nowMs = 10000;
  const b = stuckBehavior(nowMs);
  let sawWander = false, wanderMoving = 0;
  // 跑 40 秒：每轮 hesitate+backoff+replan 约 2~3 秒，3 次失败后应进 wander
  for (let i = 0; i < 800; i++) {
    const r = decideBehavior({
      behavior: b, position: FAR_POS, playerPosition: FAR_PLAYER,
      step: UNREACHABLE_STEP, nowMs, rng: () => 0,
    });
    if (r.phase === 'wander') {
      sawWander = true;
      assertEqual(r.mode, 'wandering');
      if (Math.hypot(r.vx, r.vz) > 1e-6) wanderMoving++;
    }
    recordSample(b, FAR_POS, nowMs);
    nowMs += 50;
  }
  assertTrue(sawWander, '连续失败后须进 wander');
  assertTrue(wanderMoving > 0, 'wander 不得是原地站死（须有非零速度拍）');
});

test('decideBehavior l: wander 中有路 ⇒ 回 chase', () => {
  let nowMs = 10000;
  const b = stuckBehavior(nowMs);
  // 先跑到 wander（持续不可达）
  for (let i = 0; i < 800; i++) {
    decideBehavior({
      behavior: b, position: FAR_POS, playerPosition: FAR_PLAYER,
      step: UNREACHABLE_STEP, nowMs, rng: () => 0,
    });
    recordSample(b, FAR_POS, nowMs);
    nowMs += 50;
  }
  assertEqual(b.phase, 'wander', '前提：须已在 wander');
  // 现在「有路了」= **A* 报可达**（`step.reachable === true`）。
  // ⚠️ 不能只用「hist 显示在移动」伪造有路：wander 自己就在小范围踱步，
  // 净位移天然可能很小 ⇒ 那不是「有路」的证据（final review 实测纠正）。
  b.hist.length = 0;
  b.hist.push([nowMs - 1500, 32.5, 32.5]);
  b.hist.push([nowMs, 32.5, 30.0]);
  const r = decideBehavior({
    behavior: b, position: [32.5, 1, 30.0], playerPosition: FAR_PLAYER,
    step: { ...NORTH_STEP, reachable: true }, nowMs, rng: () => 0,
  });
  assertEqual(r.phase, 'chase', 'A* 报可达后须回 chase');
  assertEqual(r.mode, 'chasing');
  // 反向：仍不可达时不得退出徘徊（哪怕这几秒在动）
  const b2 = behaviorFor(memoryFor(new Map(), 'z1'), nowMs);
  b2.phase = 'wander';
  b2.wanderAnchor = [32.5, 32.5];
  b2.wanderNextRetry = nowMs + 2000;
  b2.hist.push([nowMs - 1500, 32.5, 32.5]);
  b2.hist.push([nowMs, 32.5, 30.0]);
  const r2 = decideBehavior({
    behavior: b2, position: [32.5, 1, 30.0], playerPosition: FAR_PLAYER,
    step: { ...NORTH_STEP, reachable: false }, nowMs, rng: () => 0,
  });
  assertEqual(r2.phase, 'wander', '仍不可达时须留在徘徊');
});

test('decideBehavior r: 同 rng 同输入 ⇒ 逐位同输出（确定性）', () => {
  const run = () => {
    let nowMs = 10000;
    const b = stuckBehavior(nowMs);
    const out = [];
    for (let i = 0; i < 100; i++) {
      const r = decideBehavior({
        behavior: b, position: FAR_POS, playerPosition: FAR_PLAYER,
        step: NORTH_STEP, nowMs, rng: () => 0.37,
      });
      out.push([r.vx, r.vz, r.mode, r.phase, r.replan]);
      recordSample(b, FAR_POS, nowMs);
      nowMs += 50;
    }
    return out;
  };
  const a = run(), c = run();
  assertEqual(a.length, c.length);
  for (let i = 0; i < a.length; i++) {
    assertEqual(a[i][0], c[i][0], `第 ${i} 拍 vx 须逐位相同`);
    assertEqual(a[i][1], c[i][1], `第 ${i} 拍 vz 须逐位相同`);
    assertEqual(a[i][3], c[i][3], `第 ${i} 拍 phase 须相同`);
  }
});

test('decideBehavior: chase 时方向与 decideStep 一致（行为层不改方向，只改速度）', () => {
  const nowMs = 10000;
  const b = behaviorFor(memoryFor(new Map(), 'z0'), nowMs);
  // 净位移足够 ⇒ 不卡住；且早已完成起步加速（隔离包络的 accel 项）
  b.hist.push([nowMs - 1500, 32.5, 34.0]);
  b.hist.push([nowMs, 32.5, 32.5]);
  b.movingSince = nowMs - 10000;
  const r = decideBehavior({
    behavior: b, position: FAR_POS, playerPosition: FAR_PLAYER,
    step: NORTH_STEP, nowMs, rng: () => 0.5,
  });
  assertEqual(r.phase, 'chase');
  assertEqual(r.mode, 'chasing');
  // ⚠️ 钉的是**方向**（单位化后与 decideStep 一致），不是长度 ——
  // 长度由 Task 4 的速度包络决定（巡航×起步×转向），那是本轮的目的。
  const len = Math.hypot(r.vx, r.vz);
  assertTrue(len > 0, '已完成起步加速后须有非零速度');
  assertClose(r.vx / len, 0, 1e-9, 'vx 方向须与 decideStep 一致');
  assertClose(r.vz / len, -1, 1e-9, 'vz 方向须与 decideStep 一致（朝北）');
  assertTrue(len <= 1 + 1e-9, '倍率不得超过 1');
});

// ==================== Task 3：接线（只测纯函数会漏「没接线」，M7 教训）====================

test('行为层接线: 整图封死时真 service 会进 hesitate/backoff（不是只测纯函数）', () => {
  // 夹具（写计划阶段实测）：整张图 z=30 一道 3 格高墙 ⇒ 真不可达。
  // 现状实测：20s 净位移 2.12 格、朝向翻转 354 次、mode 全程 chasing。
  const { world, set } = makeFlat();
  for (let x = 0; x < 64; x++) for (let dy = 0; dy < 3; dy++) set(x, 1 + dy, 30);
  const entities = new EntityManager();
  entities.registerType('zombie', zombieDefinition);
  const zombies = new ZombieService({ entities, world, rng: () => 0 });
  const id = zombies.spawn([32.5, 1, 33.5], { source: 'test' });
  assertTrue(id !== null, '前提：须能生成');
  const playerPosition = [32.5, 1, 20.5];
  const dt = 1 / 60;
  let t = 0;
  const modes = new Set();
  while (t < 20) {
    zombies.update(dt, { playerPosition, nowMs: t * 1000 });
    entities.update(dt, { world });
    modes.add(zombies.get(id).mode);
    t += dt;
  }
  const phases = zombies.debugNavigator().behaviorPhases;
  assertTrue(phases.hesitate > 0, `真 service 须进过 hesitate（实际 ${phases.hesitate}）`);
  assertTrue(phases.backoff > 0, `真 service 须进过 backoff（实际 ${phases.backoff}）`);
  assertTrue(modes.has('hesitating'), 'state.mode 须真的出现过 hesitating（白名单接线）');
  assertTrue(modes.has('backing'), 'state.mode 须真的出现过 backing');
});

test('行为层接线: 开阔地正常追逐不进犹豫（零回归）', () => {
  const { world } = makeFlat();
  const entities = new EntityManager();
  entities.registerType('zombie', zombieDefinition);
  const zombies = new ZombieService({ entities, world, rng: () => 0.5 });
  const id = zombies.spawn([32.5, 1, 44.5], { source: 'test' });
  const playerPosition = [32.5, 1, 20.5];
  const dt = 1 / 60;
  let t = 0;
  // ⚠️ 窗口取 24s 而不是 18s：巡航均值 0.96 ⇒ 18s 只走 20.7 格 < 24 格距离。
  // 24s × 1.2 × 0.96 ≈ 27.6 格 > 24 ⇒ 能追到。（Task 3 时速度恒 1.2，18s 走 21.6 格勉强够，
  // 引入包络后必须同步延长窗口 —— 这是判据随新语义重标，不是放宽。）
  while (t < 24) {
    zombies.update(dt, { playerPosition, nowMs: t * 1000 });
    entities.update(dt, { world });
    t += dt;
  }
  const st = zombies.get(id);
  const phases = zombies.debugNavigator().behaviorPhases;
  assertEqual(phases.hesitate, 0, '开阔地直追不得犹豫');
  assertEqual(phases.backoff, 0, '开阔地直追不得后退');
  const dist = Math.hypot(st.position[0] - playerPosition[0], st.position[2] - playerPosition[2]);
  assertTrue(dist < 3, `须追到玩家附近（实际距 ${dist.toFixed(2)} 格）`);
});

// ==================== Task 4：速度包络 ====================

test('speedScale b: 巡航倍率 ∈ [0.92,1.0]，恒 ≤ 1', () => {
  const b = behaviorFor(memoryFor(new Map(), 'z0'), 0);
  b.movingSince = -10000;   // 早已完成起步加速，只考察巡航项
  for (let t = 0; t <= 10000; t += 50) {
    const s = speedScale({ behavior: b, id: 'z0', nowMs: t, dir: [0, -1], moving: true });
    assertTrue(s >= 0.92 - 1e-9 && s <= 1.0 + 1e-9,
      `巡航倍率须在 [0.92,1.0]，t=${t} 实际 ${s}`);
    // 方向不变 ⇒ 无转向减速（lastDir 由生产代码自己维护）
  }
});

test('speedScale c: 静止起步前 0.35s 递增，之后达巡航', () => {
  const b = behaviorFor(memoryFor(new Map(), 'z0'), 0);
  // 首拍 moving=true ⇒ movingSince 置为 nowMs ⇒ 加速因子 0
  const s0 = speedScale({ behavior: b, id: 'z0', nowMs: 1000, dir: [0, -1], moving: true });
  b.lastDir = [0, -1];
  const s1 = speedScale({ behavior: b, id: 'z0', nowMs: 1175, dir: [0, -1], moving: true });
  b.lastDir = [0, -1];
  const s2 = speedScale({ behavior: b, id: 'z0', nowMs: 1350, dir: [0, -1], moving: true });
  assertTrue(s0 < s1 && s1 < s2, `起步须递增（${s0} → ${s1} → ${s2}）`);
  assertClose(s0, 0, 1e-9, '首拍加速因子为 0');
  assertTrue(s2 >= 0.92 - 1e-9, `0.35s 后须达巡航（实际 ${s2}）`);
});

test('speedScale c2: moving=false 时清 movingSince（下次重新起步）', () => {
  const b = behaviorFor(memoryFor(new Map(), 'z0'), 0);
  speedScale({ behavior: b, id: 'z0', nowMs: 1000, dir: [0, -1], moving: true });
  assertTrue(b.movingSince !== null, '前提：移动中须记起点');
  speedScale({ behavior: b, id: 'z0', nowMs: 2000, dir: [0, 0], moving: false });
  assertEqual(b.movingSince, null, '静止须清起点');
});

test('speedScale o1: 转向那一拍减速，但不累积', () => {
  const b = behaviorFor(memoryFor(new Map(), 'z0'), 0);
  b.movingSince = -10000;
  // 每拍都转 45°：第 1 拍与第 20 拍的倍率必须相同（不累乘）
  // ⚠️ **用例不得自己写 `b.lastDir`**：那是生产代码维护的状态，手动赋值会掩盖
  // 「生产代码是否真的每拍更新它」这个被测行为（实测：注入「只设一次不更新」仍全绿）。
  // 先用一拍直走让生产代码自己建立 lastDir（首拍无参照 ⇒ turn=1 是正确的）。
  speedScale({ behavior: b, id: 'z0', nowMs: 5000, dir: [0, -1], moving: true });
  const scales = [];
  for (let i = 0; i < 20; i++) {
    // 每拍都相对上拍转 45°（而不是相对固定轴），这样每拍的转向量恒定
    const th = ((i + 1) * 45 * Math.PI) / 180;
    const dir = [Math.sin(th), -Math.cos(th)];
    scales.push(speedScale({ behavior: b, id: 'z0', nowMs: 5000, dir, moving: true }));
  }
  // 巡航项随时间漂移，故比「转向因子」而非绝对值：用同 nowMs 的直走值做基准
  const b2 = behaviorFor(memoryFor(new Map(), 'z0'), 0);
  b2.movingSince = -10000;
  speedScale({ behavior: b2, id: 'z0', nowMs: 5000, dir: [0, -1], moving: true });
  const straight = speedScale({ behavior: b2, id: 'z0', nowMs: 5000, dir: [0, -1], moving: true });
  const ratioFirst = scales[0] / straight;
  assertTrue(ratioFirst < 1, `转向那一拍须减速（比值 ${ratioFirst}）`);
  assertTrue(ratioFirst >= 0.7 - 1e-9, `转向减速不得低于 floor 0.7（比值 ${ratioFirst}）`);
  // ⚠️ **必须钉绝对值不衰减**：只比「首拍/直走」的比值会约掉累积衰减 ——
  // 注入「lastDir 只设一次」时倍率实测 0.999→0.874→0.749→0.699 逐拍下滑，
  // 而比值判据仍全绿（实测踩到）。这里钉住 20 拍的倍率**逐位相同**。
  for (let i = 1; i < scales.length; i++) {
    assertClose(scales[i], scales[0], 1e-12,
      `第 ${i} 拍的转向减速不得累积（首拍 ${scales[0]}，本拍 ${scales[i]}）`);
  }
  // 第 20 拍与第 1 拍的转向角度相同（都是 45°）⇒ 减速幅度须一致（±巡航漂移的 8%）
  const b3 = behaviorFor(memoryFor(new Map(), 'z0'), 0);
  b3.movingSince = -10000;
  const th19 = (19 * 45 * Math.PI) / 180, th18 = (18 * 45 * Math.PI) / 180;
  // 同上：让生产代码自己建立 lastDir，不手动写
  speedScale({ behavior: b3, id: 'z0', nowMs: 5000, dir: [Math.sin(th18), -Math.cos(th18)], moving: true });
  const s19 = speedScale({
    behavior: b3, id: 'z0', nowMs: 5000, dir: [Math.sin(th19), -Math.cos(th19)], moving: true,
  });
  const straightBehavior = behaviorFor(memoryFor(new Map(), 'z0'), 0);
  straightBehavior.movingSince = -10000;
  speedScale({ behavior: straightBehavior, id: 'z0', nowMs: 5000, dir: [0, -1], moving: true });
  const straightSame = speedScale({
    behavior: straightBehavior, id: 'z0', nowMs: 5000, dir: [0, -1], moving: true,
  });
  assertClose(s19 / straightSame, ratioFirst, 1e-9, '同样转 45° 的减速幅度须逐位相同（不累积）');
});

test('speedScale o2: 三项相乘后仍 ≤ 1 且 ≥ 0', () => {
  const b = behaviorFor(memoryFor(new Map(), 'z3'), 0);
  for (let t = 0; t <= 5000; t += 50) {
    const th = (t / 100) % (Math.PI * 2);
    const s = speedScale({ behavior: b, id: 'z3', nowMs: t, dir: [Math.sin(th), Math.cos(th)], moving: true });
    assertTrue(s >= 0 && s <= 1 + 1e-12, `倍率须在 [0,1]，t=${t} 实际 ${s}`);
  }
});

test('speedScale 相位: 不同 id 不同步（避免全场齐步走）', () => {
  const mk = (id) => {
    const b = behaviorFor(memoryFor(new Map(), id), 0);
    b.movingSince = -10000;
    speedScale({ behavior: b, id, nowMs: 3000, dir: [0, -1], moving: true });
    return speedScale({ behavior: b, id, nowMs: 3000, dir: [0, -1], moving: true });
  };
  const a = mk('z0'), c = mk('z7');
  assertFalse(a === c, `不同 id 的巡航倍率须不同（z0=${a}, z7=${c}）`);
});

test('speedScale 确定性: 同 id 同 nowMs ⇒ 逐位相同', () => {
  const mk = () => {
    const b = behaviorFor(memoryFor(new Map(), 'z5'), 0);
    b.movingSince = -10000;
    speedScale({ behavior: b, id: 'z5', nowMs: 4321, dir: [0, -1], moving: true });
    return speedScale({ behavior: b, id: 'z5', nowMs: 4321, dir: [0, -1], moving: true });
  };
  assertEqual(mk(), mk());
});

test('decideBehavior 速度包络: chase 时不再是二值速度（distinct > 5）', () => {
  const { world } = makeFlat();
  const entities = new EntityManager();
  entities.registerType('zombie', zombieDefinition);
  const zombies = new ZombieService({ entities, world, rng: () => 0.5 });
  const id = zombies.spawn([32.5, 1, 44.5], { source: 'test' });
  const playerPosition = [32.5, 1, 20.5];
  const dt = 1 / 60;
  let t = 0;
  const speeds = new Set();
  while (t < 12) {
    zombies.update(dt, { playerPosition, nowMs: t * 1000 });
    entities.update(dt, { world });
    const st = zombies.get(id);
    speeds.add(Math.round(Math.hypot(st.velocity[0], st.velocity[2]) * 1000) / 1000);
    t += dt;
  }
  assertTrue(speeds.size > 5, `速度取值须多于 5 种（现状实测恰好 2 种，实际 ${speeds.size}）`);
  // 硬上限不变式：任何一帧都不得超过 1.2
  for (const s of speeds) assertTrue(s <= 1.2 + 1e-9, `速度不得超过 1.2（实际 ${s}）`);
});

test('行为层不缩放排斥力: 20只同点生成仍散开', () => {
  const { world } = makeFlat();
  const entities = new EntityManager();
  entities.registerType('zombie', zombieDefinition);
  const zombies = new ZombieService({ entities, world, rng: () => 0.5 });
  const ids = [];
  for (let i = 0; i < 20; i++) ids.push(zombies.spawn([32.5, 1, 32.5], { source: 'test' }));
  assertEqual(ids.filter(Boolean).length, 20, '前提：20 只须全部生成');
  const playerPosition = [32.5, 1, 20.5];
  const dt = 1 / 60;
  let t = 0;
  while (t < 3) {
    zombies.update(dt, { playerPosition, nowMs: t * 1000 });
    entities.update(dt, { world });
    t += dt;
  }
  const zs = zombies.activeEntities();
  let min = Infinity;
  for (let i = 0; i < zs.length; i++) {
    for (let j = i + 1; j < zs.length; j++) {
      min = Math.min(min, Math.hypot(
        zs[i].state.position[0] - zs[j].state.position[0],
        zs[i].state.position[2] - zs[j].state.position[2],
      ));
    }
  }
  assertTrue(min > 0.4, `20 只同点须散开（最小间距 ${min.toFixed(3)}，判据 >0.4）`);
});

// ==================== Task 5：转身限速 ====================

test('steerYawLimited p1: 单拍不超过限速上限', () => {
  const maxStep = 540 * Math.PI / 180 * 0.05;   // 字面量：540°/s × 0.05s = 27°
  const out = steerYawLimited(0, Math.PI / 2, maxStep);
  assertTrue(Math.abs(out) <= maxStep + 1e-12, `单拍转角须 ≤ 上限（实际 ${out}）`);
  assertClose(out, maxStep, 1e-12, '0→90° 该拍恰好用满上限');
});

test('steerYawLimited p2: 走最短弧（+179°→−179° 只转 2°，不绕 358°）', () => {
  const cur = 179 * Math.PI / 180;
  const tgt = -179 * Math.PI / 180;
  const out = steerYawLimited(cur, tgt, Math.PI);   // 上限足够大 ⇒ 应一步到位
  // 目标 −179° 与 +181° 等价，故比「归一化后的角差」
  const diff = Math.abs(Math.atan2(Math.sin(out - tgt), Math.cos(out - tgt)));
  assertTrue(diff < 1e-9, `须走最短弧一步到位（角差 ${diff}）`);
});

test('steerYawLimited p3: 反向也走最短弧（−179°→+179°）', () => {
  const cur = -179 * Math.PI / 180;
  const tgt = 179 * Math.PI / 180;
  const out = steerYawLimited(cur, tgt, 540 * Math.PI / 180 * 0.05);
  // 最短弧是 −2° 方向 ⇒ 单拍走 −27° 上限，但方向必须是「往负方向」
  const moved = Math.atan2(Math.sin(out - cur), Math.cos(out - cur));
  assertTrue(moved < 0, `须往负方向转（实际 ${moved}）`);
  assertTrue(Math.abs(moved) <= 540 * Math.PI / 180 * 0.05 + 1e-12);
});

test('steerYawLimited: 已达目标则原样返回（逐位）', () => {
  for (const y of [0, 1.234, -2.5, Math.PI - 0.01]) {
    assertEqual(steerYawLimited(y, y, 0.47), y, '已达目标须逐位原样返回');
  }
});

test('steerYawLimited: 返回值 wrap 到 ±π', () => {
  const out = steerYawLimited(3.0, -3.0, Math.PI);
  assertTrue(out >= -Math.PI - 1e-12 && out <= Math.PI + 1e-12, `须 wrap 到 ±π（实际 ${out}）`);
});

test('转身限速接线: 真 service 单拍 yaw 变化 ≤ 27°（现状实测 135°）', () => {
  const { world } = makeFlat();
  // 场景：先朝北走建立朝向，再让玩家跳到正南 ⇒ 需要 180° 转向
  const entities = new EntityManager();
  entities.registerType('zombie', zombieDefinition);
  const zombies = new ZombieService({ entities, world, rng: () => 0.5 });
  const id = zombies.spawn([32.5, 1, 32.5], { source: 'test' });
  const dt = 1 / 60;
  let t = 0;
  // 先朝北走 2 秒（建立朝向）
  while (t < 2) {
    zombies.update(dt, { playerPosition: [32.5, 1, 20.5], nowMs: t * 1000 });
    entities.update(dt, { world });
    t += dt;
  }
  // 玩家瞬移到正南 ⇒ 需要 180° 转向
  let prevYaw = zombies.get(id).yaw;
  let maxJump = 0;
  const t0 = t;
  while (t < t0 + 3) {
    zombies.update(dt, { playerPosition: [32.5, 1, 44.5], nowMs: t * 1000 });
    entities.update(dt, { world });
    const y = zombies.get(id).yaw;
    const d = Math.abs(Math.atan2(Math.sin(y - prevYaw), Math.cos(y - prevYaw)));
    maxJump = Math.max(maxJump, d);
    prevYaw = y;
    t += dt;
  }
  const maxDeg = maxJump * 180 / Math.PI;
  assertTrue(maxDeg <= 27 + 1e-6, `单帧转身须 ≤27°（实际 ${maxDeg.toFixed(2)}°，现状 135°）`);
  assertTrue(maxDeg > 1, '前提：须真的发生过转身（否则断言恒真）');
});

test('转身限速接线: 直接 setIntent 仍瞬时朝向（通用写入口契约不动）', () => {
  const { world } = makeFlat();
  const entities = new EntityManager();
  entities.registerType('zombie', zombieDefinition);
  const zombies = new ZombieService({ entities, world });
  const id = zombies.spawn([32.5, 1, 32.5], { source: 'test' });
  // 直接下令朝 +X（yaw 应为 π/2），一次到位 —— 不经 _applyIntent 的限速
  zombies.setIntent(id, { vx: 1.2, vz: 0, mode: 'chasing' });
  assertClose(zombies.get(id).yaw, Math.PI / 2, 1e-9,
    'setIntent 是通用写入口，朝向须瞬时（限速只接 AI 决策路径）');
});

// ==================== Task 6：记忆回收与诊断 ====================

test('行为记忆 q: despawn 后回收，id 复用不带旧状态', () => {
  // 夹具：整图封死 ⇒ 会进 hesitate/backoff，记忆里有非空 hist 与 failCount
  const { world, set } = makeFlat();
  for (let x = 0; x < 64; x++) for (let dy = 0; dy < 3; dy++) set(x, 1 + dy, 30);
  const entities = new EntityManager();
  entities.registerType('zombie', zombieDefinition);
  const zombies = new ZombieService({ entities, world, rng: () => 0 });
  const id = zombies.spawn([32.5, 1, 33.5], { source: 'test' });
  const playerPosition = [32.5, 1, 20.5];
  const dt = 1 / 60;
  let t = 0;
  while (t < 6) {
    zombies.update(dt, { playerPosition, nowMs: t * 1000 });
    entities.update(dt, { world });
    t += dt;
  }
  // 前提：记忆里确实攒了状态（否则「回收」无从谈起，断言恒真）
  const memBefore = zombies._navMemory.get(id);
  assertTrue(!!(memBefore && memBefore.behavior), '前提：须已建立行为记忆');
  assertTrue(memBefore.behavior.hist.length > 0, '前提：hist 须非空');
  assertTrue(memBefore.behavior.phase !== 'chase' || memBefore.behavior.failCount > 0,
    `前提：须已攒下非初始状态（phase=${memBefore.behavior.phase}, failCount=${memBefore.behavior.failCount}）`);

  // 一击致死 → 回收路径①
  zombies.damage(id, 999, 1000);
  assertEqual(zombies.get(id), null, '前提：须已死亡回收');
  assertFalse(zombies._navMemory.has(id), 'despawn 须回收导航记忆（含 behavior）');

  // 同 slot 同 id 重新生成 ⇒ 不得带上一只的状态
  const id2 = zombies.spawn([32.5, 1, 33.5], { source: 'test' });
  assertEqual(id2, id, '前提：slot 低位优先 ⇒ id 复用');
  const memAfter = zombies._navMemory.get(id2);
  // 记忆是懒建的：spawn 后还没跑导航时可能尚未建立，那也是「不带旧状态」
  if (memAfter && memAfter.behavior) {
    assertEqual(memAfter.behavior.phase, 'chase', 'id 复用不得继承旧 phase');
    assertEqual(memAfter.behavior.hist.length, 0, 'id 复用不得继承旧 hist');
    assertEqual(memAfter.behavior.failCount, 0, 'id 复用不得继承旧 failCount');
  }
  // 再跑一拍，确认新建的记忆是干净的初始态
  zombies.update(0.05, { playerPosition, nowMs: 7000 });
  const fresh = zombies._navMemory.get(id2).behavior;
  assertEqual(fresh.failCount, 0, '新建记忆的 failCount 须为 0');
  assertTrue(fresh.hist.length <= 1, '新建记忆的 hist 须从零开始');
});

test('行为记忆 q2: dispose 回收全部行为记忆（回收路径③）', () => {
  const { world } = makeFlat();
  const entities = new EntityManager();
  entities.registerType('zombie', zombieDefinition);
  const zombies = new ZombieService({ entities, world });
  for (let i = 0; i < 5; i++) zombies.spawn([10.5 + i * 2, 1, 10.5], { source: 'test' });
  zombies.update(0.05, { playerPosition: [10.5, 1, 2.5], nowMs: 1000 });
  assertTrue(zombies._navMemory.size > 0, '前提：须已建立记忆');
  zombies.dispose();
  assertEqual(zombies._navMemory.size, 0, 'dispose 须清空导航记忆');
  assertEqual(zombies.count(), 0);
});

test('行为诊断: debugNavigator 暴露五个 phase 计数且随决策增长', () => {
  const { world } = makeFlat();
  const entities = new EntityManager();
  entities.registerType('zombie', zombieDefinition);
  const zombies = new ZombieService({ entities, world });
  zombies.spawn([32.5, 1, 40.5], { source: 'test' });
  const before = zombies.debugNavigator().behaviorPhases;
  assertEqual(typeof before, 'object', '须暴露 behaviorPhases');
  for (const k of ['chase', 'hesitate', 'backoff', 'replan', 'wander']) {
    assertEqual(before[k], 0, `初始 ${k} 计数须为 0`);
  }
  zombies.update(0.05, { playerPosition: [32.5, 1, 20.5], nowMs: 1000 });
  const after = zombies.debugNavigator().behaviorPhases;
  assertTrue(after.chase > 0, '开阔地追逐须累加 chase 计数');
  // 只读快照：改返回值不得影响内部状态
  after.chase = 9999;
  assertEqual(zombies.debugNavigator().behaviorPhases.chase, 1, '须返回快照而非内部引用');
});

test('行为层接线 j2: replan 拍真的清了 PathCache（不只是返回 replan=true）', () => {
  // ⚠️ 用例 j 只断言行为层**返回值** replan=true，那与「service 是否真的调 forget」无关
  // ⇒ 注入「service 不清缓存」时 j 仍全绿（实测踩到，testing-policy §2.7 第 12 类）。
  // 这条把判据落在**真实缓存状态**上：replan 发生后该 id 的缓存条目必须消失。
  const { world, set } = makeFlat();
  for (let x = 0; x < 64; x++) for (let dy = 0; dy < 3; dy++) set(x, 1 + dy, 30);
  const entities = new EntityManager();
  entities.registerType('zombie', zombieDefinition);
  const zombies = new ZombieService({ entities, world, rng: () => 0 });
  const id = zombies.spawn([32.5, 1, 33.5], { source: 'test' });
  const playerPosition = [32.5, 1, 20.5];
  const dt = 1 / 60;
  let t = 0;
  let sawReplanWithCache = false, cacheClearedOnReplan = false;
  let prevPhase = 'chase';
  while (t < 20) {
    // 逐拍观察：进入 replan 的那一拍之后，缓存里不得再有该 id 的条目
    zombies.update(dt, { playerPosition, nowMs: t * 1000 });
    entities.update(dt, { world });
    const b = zombies._navMemory.get(id)?.behavior;
    const phase = b?.phase ?? 'chase';
    if (phase === 'replan' && prevPhase !== 'replan') {
      sawReplanWithCache = true;
      // ⚠️ **不能用 `cachedPathOf(id) === null`**：整图封死时 planStep 返回
      // reachable=false，其 `_path` 本就是 null ⇒ 清与不清都读到 null ⇒ 判据恒真
      // （实测踩到）。改用**缓存条目数**：forget 后该 id 的条目必须消失。
      if (zombies._pathCache.debugState().size === 0) cacheClearedOnReplan = true;
    }
    prevPhase = phase;
    t += dt;
  }
  assertTrue(sawReplanWithCache, '前提：须真的进过 replan');
  assertTrue(cacheClearedOnReplan, 'replan 拍须真的清掉该 id 的路径缓存（否则会走回墙边）');
});

// ==================== Final review 修正：失败计数必须能攒到徘徊阈值 ====================

test('行为层: 长墙不可达时 eventually 进 wander（失败计数不得被后退自身的位移清零）', () => {
  // ⚠️ 这条来自 final review 的实测缺陷：小室/长墙场景 40s 内**从未进 wander**
  // （相位统计 chase 1281 / hesitate 285 / backoff 680 / replan 153 / wander 0）。
  // 根因：replan 结算紧跟在 backoff 之后，而 backoff 自己走了 1~2 格 ⇒ 1.5s 窗口
  // 仍显示「在动」⇒ stuck=false ⇒ 判「有路」⇒ failCount 归零 ⇒ 永远攒不到 3。
  // 用户裁定的是「几轮之后原地徘徊等玩家」，故必须真的能进 wander。
  const { world, set } = makeFlat();
  for (let x = 0; x < 64; x++) for (let dy = 0; dy < 3; dy++) set(x, 1 + dy, 30);
  const entities = new EntityManager();
  entities.registerType('zombie', zombieDefinition);
  const zombies = new ZombieService({ entities, world, rng: () => 0.5 });
  const id = zombies.spawn([32.5, 1, 31.5], { source: 'test' });
  const playerPosition = [32.5, 1, 20.5];
  const dt = 1 / 60;
  let t = 0;
  let sawWander = false, maxFail = 0;
  while (t < 40) {
    zombies.update(dt, { playerPosition, nowMs: t * 1000 });
    entities.update(dt, { world });
    const b = zombies._navMemory.get(id)?.behavior;
    if (b) {
      maxFail = Math.max(maxFail, b.failCount);
      if (b.phase === 'wander') sawWander = true;
    }
    t += dt;
  }
  const phases = zombies.debugNavigator().behaviorPhases;
  assertTrue(maxFail >= 3, `失败计数须能攒到 3（实际峰值 ${maxFail}）`);
  assertTrue(sawWander, `40s 内须真的进过 wander（相位计数 ${JSON.stringify(phases)}）`);
  assertTrue(phases.wander > 0, 'wander 相位计数须 > 0');
});

test('行为层: 进 wander 后仍会周期重试，玩家拆墙后恢复追逐', () => {
  const { world, set } = makeFlat();
  for (let x = 0; x < 64; x++) for (let dy = 0; dy < 3; dy++) set(x, 1 + dy, 30);
  const entities = new EntityManager();
  entities.registerType('zombie', zombieDefinition);
  const zombies = new ZombieService({ entities, world, rng: () => 0.5 });
  const id = zombies.spawn([32.5, 1, 31.5], { source: 'test' });
  const playerPosition = [32.5, 1, 20.5];
  const dt = 1 / 60;
  let t = 0;
  while (t < 40) {
    zombies.update(dt, { playerPosition, nowMs: t * 1000 });
    entities.update(dt, { world });
    t += dt;
  }
  assertEqual(zombies._navMemory.get(id).behavior.phase, 'wander', '前提：须已在 wander');
  // 拆一条 3 格宽通道
  const gapX = Math.floor(zombies.get(id).position[0]);
  for (let x = gapX - 1; x <= gapX + 1; x++) {
    for (let dy = 0; dy < 3; dy++) world.setBlock(x, 1 + dy, 30, 0);
  }
  const distBefore = Math.hypot(
    zombies.get(id).position[0] - playerPosition[0],
    zombies.get(id).position[2] - playerPosition[2],
  );
  let recovered = false;
  const t0 = t;
  while (t < t0 + 8) {
    zombies.update(dt, { playerPosition, nowMs: t * 1000 });
    entities.update(dt, { world });
    if (zombies.get(id).mode === 'chasing') recovered = true;
    t += dt;
  }
  const distAfter = Math.hypot(
    zombies.get(id).position[0] - playerPosition[0],
    zombies.get(id).position[2] - playerPosition[2],
  );
  assertTrue(recovered, '拆墙后须恢复 chasing');
  assertTrue(distAfter < distBefore, `须靠近玩家（${distBefore.toFixed(2)} → ${distAfter.toFixed(2)}）`);
});
