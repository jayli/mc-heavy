// src/tests/test-boss-hint.js — 「这里可以召唤 Boss」提示（用户 2026-11-18）
//
// 用户原话：「在可以召唤 Boss 的位置，显示一个提示，可以召唤 Boss。离开这个区域后就让
// 这个提示消失，如果已经召唤 boss 出来后，已经没有更多的 boss 可以召唤了，这个提示也消失。」
//
// ## 为什么必须单测这一段（三类静默失效）
//
// ① **判据漂移**：提示自己写一份「这里有没有 Boss」⇒ 与按 B 的真实结果分裂
//    （形态：提示说能召，按 B 却说「这里没有可召唤的 Boss」）。故本文件的判据一律
//    **转调真实 service 的 summon 结果**来校准名册表，而不是拿表比表。
// ② **槽位口径错**：高台地带有两个 Boss，召了第一个之后提示必须**还在**（还能召第二个）；
//    只有两个都占着才消失。只判「有没有 Boss 在场」会让第一次按 B 后提示就没了。
// ③ **死亡不复活**：Boss 死即 despawn ⇒ 槽位重新可召 ⇒ 提示必须自己回来。
//    额外记一个「已召过」标记就会让它永不回来（v2.41 的 dragonDead 正是被移除的那种标记）。
//
// ⚠️ HUD 用 `Object.create(Game.prototype)` 造壳 + **真实四个 service**
//（同 `test-boss-hit-sound.js` 手法）：fake service 的形状不对会让测试绿而生产红。
import { test } from './runner.js';
import { assertEqual, assertTrue, assertNull, assertNotNull } from './assert.js';
import { Game } from '../core/game.js';
import { EntityManager } from '../entities/entity-manager.js';
import { DragonService, dragonDefinition } from '../entities/dragons/dragon-system.js';
import { DRAGON_TYPE, DRAGON_MAX_ALIVE } from '../entities/dragons/dragon-config.js';
import { IgnisService, ignisDefinition } from '../entities/ignis/ignis-system.js';
import { IGNIS_TYPE, IGNIS } from '../entities/ignis/ignis-config.js';
import { GuardianService, guardianDefinition } from '../entities/guardian/guardian-system.js';
import { GUARDIAN_TYPE, GUARDIAN } from '../entities/guardian/guardian-config.js';
import { bossMapAt, warmBossAnchors } from '../entities/bosses/boss-map.js';
import {
  BOSS_ROSTER, bossSlotsFor, nextSummonableBoss,
} from '../entities/bosses/boss-registry.js';
import { findAltarTarnRegion } from '../gen/structures/tarn-zone.js';
import { computeArenaAnchor } from '../gen/structures/arena.js';
import { getCityBoundsForSeed } from '../gen/structures/city-layout.js';
import {
  BossHintHUD, BOSS_HINT_Z_INDEX, BOSS_HINT_TITLE, BOSS_HINT_KEY, BOSS_HINT_INTERVAL_MS,
} from '../ui/boss-hint.js';

const SEED = 12345;

/** 平地世界（地面 Boss 的落点扫描用它；y ≤ 10 实心） */
function flatWorld() {
  return {
    isSolid: (_x, y, _z) => y <= 10,
    getBlockId: (_x, y, _z) => (y <= 10 ? 1 : 0),
    hasColumn: () => true,
  };
}

/**
 * 装好三个 Boss service 的 Game 壳（玩家位置可写）。
 * @param {number} x @param {number} z
 */
function hintFixture(x, z) {
  const world = flatWorld();
  const em = new EntityManager();
  em.registerType(DRAGON_TYPE, dragonDefinition);
  em.registerType(IGNIS_TYPE, ignisDefinition);
  em.registerType(GUARDIAN_TYPE, guardianDefinition);
  const game = Object.create(Game.prototype);
  game.entities = em;
  game.seed = SEED;
  game.dragons = new DragonService({ entities: em, seed: SEED });
  game.ignises = new IgnisService({ entities: em, world, seed: SEED });
  game.guardians = new GuardianService({ entities: em, world, seed: SEED });
  game.player = { physics: { pos: { x, y: 11, z } } };
  // ⚠️ **不在这里写 `game.uiModal`**：它是 `Game.prototype` 上的 **getter**（读 `_modals`），
  // 在实例上赋值同名属性会抛 TypeError（严格模式）。HUD 本来也不读它（z 50 < 面板 70）。
  return game;
}

/** 造一个挂在临时容器上的 HUD（用完 dispose，避免污染后续用例的 document） */
function mountHint(game) {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const hud = new BossHintHUD(root, game);
  return { root, hud };
}

/** 高台地带中心（真实 gen 权威，不硬编码坐标） */
function tarnCenter() {
  const a = findAltarTarnRegion(SEED);
  assertTrue(a !== null, '前提：seed 12345 有祭坛地带');
  return a;
}

// ==================== 名册表：与真实 service 校准 ====================

test('Boss 提示: 名册每行都带实体 id 派生器 / 存活上限 / 中文名（三列缺一即静默错判）', () => {
  for (const kind of Object.keys(BOSS_ROSTER)) {
    for (const s of BOSS_ROSTER[kind]) {
      assertEqual(typeof s.entityId, 'function', `${kind} slot${s.slot} 缺 entityId 派生器`);
      assertTrue(Number.isInteger(s.maxAlive) && s.maxAlive > 0,
        `${kind} slot${s.slot} 的 maxAlive 必须是正整数`);
      assertTrue(typeof s.label === 'string' && s.label.length > 0,
        `${kind} slot${s.slot} 缺中文名（提示副行会是空白）`);
      // id 派生器必须带 type 前缀且随 (mapKey, slot) 变化（否则两张图会互相判成占用）
      assertTrue(s.entityId('m:0', s.slot).startsWith(`${s.type}:`), 'id 必须带 type 前缀');
      assertTrue(s.entityId('m:0', s.slot) !== s.entityId('m:1', s.slot), '不同地图 id 必须不同');
    }
  }
});

test('Boss 提示: 名册的 entityId 与真实 summon 出来的实体 id 逐位相同（防表与实现漂移）', () => {
  const game = hintFixture(0, 0);
  // 三张有 Boss 的地图各召一遍，拿真实返回的 id 校准表
  const cases = [
    ['TARN', 'tarn:2:0', 1000, 200],
    ['BURNING_ARENA', 'burningarena:0', 700, 300],
    ['RUINED_CITADEL', 'ruinedcitadel:0', -400, -70],
    ['ARENA', 'arena:0', 280, 460],
  ];
  let checked = 0;
  for (const [kind, mapKey, cx, cz] of cases) {
    for (const s of bossSlotsFor(kind)) {
      const svc = game[s.service];
      const r = svc.summon(mapKey, cx, cz, s.slot, 11);
      assertTrue(r.ok, `前提：${kind} slot${s.slot} 应召唤成功（${JSON.stringify(r)}）`);
      assertEqual(r.id, s.entityId(mapKey, s.slot),
        `${kind} slot${s.slot} 的表内 id 与 service 实际 id 不一致`);
      assertNotNull(game.entities.get(s.entityId(mapKey, s.slot)),
        '按表内 id 必须真的查得到那只 Boss（提示的占用判据就是这一查）');
      checked++;
    }
  }
  assertTrue(checked >= 5, `应至少校准 5 个槽位，实际 ${checked}`);
});

test('Boss 提示: 名册的 maxAlive 与真实 service 的上限逐位相同', () => {
  const byType = { [DRAGON_TYPE]: DRAGON_MAX_ALIVE, [IGNIS_TYPE]: IGNIS.maxAlive, [GUARDIAN_TYPE]: GUARDIAN.maxAlive };
  for (const kind of Object.keys(BOSS_ROSTER)) {
    for (const s of BOSS_ROSTER[kind]) {
      assertEqual(s.maxAlive, byType[s.type], `${kind} slot${s.slot} 的 maxAlive 与 config 漂移`);
    }
  }
});

// ==================== nextSummonableBoss：空槽判定 ====================

test('Boss 提示: 不在任何地图 / 地图没登记 Boss → 无可召槽位', () => {
  const game = hintFixture(9999, 9999);
  assertNull(nextSummonableBoss(null, game.entities), 'map 为 null 必须返回 null');
  const city = bossMapAt(283, 117, SEED);
  assertNotNull(city, '前提：该点在城市内');
  assertEqual(city.kind, 'CITY');
  assertNull(nextSummonableBoss(city, game.entities), '城市没有 Boss ⇒ 不提示');
});

test('Boss 提示: 高台地带空场 → 下一个是 slot 0（飞龙）', () => {
  const c = tarnCenter();
  const game = hintFixture(c.cx, c.cz);
  const map = bossMapAt(c.cx, c.cz, SEED);
  assertEqual(map.kind, 'TARN');
  const next = nextSummonableBoss(map, game.entities);
  assertNotNull(next, '空场必须有一个可召槽位');
  assertEqual(next.slot, 0);
  assertEqual(next.type, DRAGON_TYPE);
});

test('Boss 提示: 召了飞龙之后提示仍在，下一个换成 slot 1（焰魔）', () => {
  const c = tarnCenter();
  const game = hintFixture(c.cx, c.cz);
  const map = bossMapAt(c.cx, c.cz, SEED);
  assertTrue(game.dragons.summon(map.key, map.cx, map.cz, 0).ok);
  const next = nextSummonableBoss(map, game.entities);
  assertNotNull(next, '⚠️ 还能召 Boss2 ⇒ 提示不得消失（只判「有没有 Boss 在场」会在这里错）');
  assertEqual(next.slot, 1);
  assertEqual(next.type, IGNIS_TYPE);
});

test('Boss 提示: 两个槽位都占着 → 无可召槽位（提示消失）', () => {
  const c = tarnCenter();
  const game = hintFixture(c.cx, c.cz);
  const map = bossMapAt(c.cx, c.cz, SEED);
  assertTrue(game.dragons.summon(map.key, map.cx, map.cz, 0).ok);
  assertTrue(game.ignises.summon(map.key, map.cx, map.cz, 1, 11).ok);
  assertNull(nextSummonableBoss(map, game.entities), '召满了必须返回 null');
});

test('Boss 提示: Boss 死掉后槽位重新可召（提示自己回来，不需要额外状态）', () => {
  const c = tarnCenter();
  const game = hintFixture(c.cx, c.cz);
  const map = bossMapAt(c.cx, c.cz, SEED);
  const r = game.dragons.summon(map.key, map.cx, map.cz, 0);
  assertTrue(game.ignises.summon(map.key, map.cx, map.cz, 1, 11).ok);
  assertNull(nextSummonableBoss(map, game.entities), '前提：两只都在 ⇒ 无可召');
  // 打死飞龙（真实 damage 路径 → despawn）
  const dead = game.dragons.damage(r.id, 100000, 1000);
  assertEqual(dead.dead, true, '前提：飞龙被打死');
  const next = nextSummonableBoss(map, game.entities);
  assertNotNull(next, '死后必须重新可召（记「已召过」标记会让提示永不回来）');
  assertEqual(next.slot, 0);
});

test('Boss 提示: 单 Boss 地图（围场）召满即无可召，死后恢复', () => {
  const a = computeArenaAnchor(SEED);
  assertNotNull(a, '前提：seed 12345 有围场');
  const game = hintFixture(a.wx, a.wz);
  const map = bossMapAt(a.wx, a.wz, SEED);
  assertEqual(map.kind, 'ARENA');
  assertNotNull(nextSummonableBoss(map, game.entities));
  const r = game.guardians.summon(map.key, map.cx, map.cz, 0, map.summonY);
  assertTrue(r.ok);
  assertNull(nextSummonableBoss(map, game.entities), '围场只有一个 Boss ⇒ 召了就没了');
  game.guardians.damage(r.id, 100000, 1000);
  assertNotNull(nextSummonableBoss(map, game.entities), '死后恢复');
});

test('Boss 提示: 下一槽的类型已达全球上限 → 无可召（与 summonBoss 的 limit 早退同口径）', () => {
  const c = tarnCenter();
  const game = hintFixture(c.cx, c.cz);
  const map = bossMapAt(c.cx, c.cz, SEED);
  // ⚠️ **必须先占掉 slot0**：summonBoss 对 already-exists 的槽是「跳过继续试下一个」，
  // 只有走到那个空槽时才碰 limit 门。不占 slot0 的话按 B 会召出飞龙（真的能召），
  // 提示当然也该显示 —— 初版本用例漏了这一步，判据与真实行为相反。
  assertTrue(game.dragons.summon(map.key, map.cx, map.cz, 0).ok, '前提：先召出 Boss1');
  // 在**别的地图**把焰魔占满（maxAlive=2）：本图 slot1 的 id 是空的，但按 B 会得 limit
  for (let i = 0; i < IGNIS.maxAlive; i++) {
    assertTrue(game.ignises.summon(`tarn:9${i}:9`, 5000 + i * 400, 5000, 1, 11).ok,
      `前提：第 ${i} 只焰魔应召唤成功`);
  }
  assertNotNull(game.entities.get(bossSlotsFor('TARN')[0].entityId(map.key, 0)),
    '前提：slot0 已占（否则测的不是 limit）');
  assertNull(game.entities.get(bossSlotsFor('TARN')[1].entityId(map.key, 1)),
    '前提：本图 slot1 的 id 确实空着（否则测的是 exists 而不是 limit）');
  assertNull(nextSummonableBoss(map, game.entities),
    '⚠️ 按 B 会返回「Boss 数量已达上限」⇒ 提示必须同步消失，否则「说能召却召不出」');
});

test('Boss 提示: 与真实 summonBoss 的结果逐位一致（四种处境交替对照）', () => {
  const c = tarnCenter();
  const game = hintFixture(c.cx, c.cz);
  // summonBoss 只碰 player / seed / bossMapAt / 名册 / service / toast / audio
  game._bossToastInstance = { show: () => {} };
  game.audioManager = null;
  const map = bossMapAt(c.cx, c.cz, SEED);
  // ① 空场：提示说有 → 按 B 真的召出
  assertNotNull(nextSummonableBoss(map, game.entities));
  assertEqual(game.summonBoss().ok, true);
  // ② 还有一个空槽：提示说有 → 按 B 真的召出
  assertNotNull(nextSummonableBoss(map, game.entities));
  assertEqual(game.summonBoss().ok, true);
  // ③ 召满：提示说没有 → 按 B 真的失败
  assertNull(nextSummonableBoss(map, game.entities));
  assertEqual(game.summonBoss().ok, false);
  // ④ 离开区域：提示说没有 → 按 B 真的失败
  game.player.physics.pos.x = 9999; game.player.physics.pos.z = 9999;
  assertNull(nextSummonableBoss(bossMapAt(9999, 9999, SEED), game.entities));
  assertEqual(game.summonBoss().ok, false);
});

// ==================== 锚点预热（进帧循环的前置） ====================

test('Boss 提示: warmBossAnchors 之后 bossMapAt 的最坏耗时 < 2ms（否则进 HUD 会卡帧）', () => {
  warmBossAnchors(SEED);
  let worst = 0;
  for (let i = 0; i < 300; i++) {
    const x = (i * 137) % 12000 - 4000, z = (i * 311) % 12000 - 4000;
    const t = performance.now();
    bossMapAt(x, z, SEED);
    const d = performance.now() - t;
    if (d > worst) worst = d;
  }
  // 实测（Node，预热后）：median 0.004ms / p99 0.054ms / 最坏 0.127ms。
  // 未预热时首次远点调用实测 **111ms**（computeArenaAnchor 的候选扫描）——
  // 那一下就是一帧卡顿，故预热是 HUD 进帧循环的硬前置。2ms 留足两个数量级余量。
  assertTrue(worst < 2, `预热后最坏耗时 ${worst.toFixed(3)}ms，应 < 2ms`);
});

// ==================== HUD：DOM 与显示/隐藏 ====================

test('Boss 提示 HUD: 出生在城市里 → 不可见（城市没有 Boss）', () => {
  const b = getCityBoundsForSeed(SEED);
  const game = hintFixture(Math.round((b.minX + b.maxX) / 2), Math.round((b.minZ + b.maxZ) / 2));
  const { root, hud } = mountHint(game);
  hud.update(1000);
  assertEqual(hud.isVisible(), false, '城市无 Boss ⇒ 不提示');
  hud.dispose(); root.remove();
});

test('Boss 提示 HUD: 走进高台地带 → 可见，文案含按键与下一个 Boss 的名字', () => {
  const c = tarnCenter();
  const game = hintFixture(c.cx, c.cz);
  const { root, hud } = mountHint(game);
  assertEqual(hud.isVisible(), false, '构造期默认隐藏（首帧 update 才决定）');
  hud.update(1000);
  assertEqual(hud.isVisible(), true, '地带内且有空槽 ⇒ 必须提示');
  const text = hud.text();
  assertTrue(text.includes(BOSS_HINT_KEY), `文案必须点明按键 ${BOSS_HINT_KEY}：${text}`);
  assertTrue(text.includes(BOSS_HINT_TITLE), `文案必须含主标题：${text}`);
  assertTrue(text.includes(bossSlotsFor('TARN')[0].label), `副行必须是下一个 Boss 的名字：${text}`);
  hud.dispose(); root.remove();
});

test('Boss 提示 HUD: 走出区域 → 消失；走回来 → 重新出现', () => {
  const c = tarnCenter();
  const game = hintFixture(c.cx, c.cz);
  const { root, hud } = mountHint(game);
  hud.update(1000);
  assertEqual(hud.isVisible(), true, '前提：地带内可见');
  // 走远（真实坐标：9999,9999 不在任何地标级地图内）
  game.player.physics.pos.x = 9999; game.player.physics.pos.z = 9999;
  hud.update(1000 + BOSS_HINT_INTERVAL_MS + 1);
  assertEqual(hud.isVisible(), false, '离开区域必须消失');
  game.player.physics.pos.x = c.cx; game.player.physics.pos.z = c.cz;
  hud.update(1000 + 2 * (BOSS_HINT_INTERVAL_MS + 1));
  assertEqual(hud.isVisible(), true, '走回来必须重新出现');
  hud.dispose(); root.remove();
});

test('Boss 提示 HUD: 召满本图 Boss → 消失；打死一只 → 重新出现', () => {
  const c = tarnCenter();
  const game = hintFixture(c.cx, c.cz);
  const { root, hud } = mountHint(game);
  let t = 1000;
  const tick = () => { t += BOSS_HINT_INTERVAL_MS + 1; hud.update(t); };
  tick();
  assertEqual(hud.isVisible(), true, '前提：空场可见');
  const map = bossMapAt(c.cx, c.cz, SEED);
  const r1 = game.dragons.summon(map.key, map.cx, map.cz, 0);
  tick();
  assertEqual(hud.isVisible(), true, '⚠️ 只召了 Boss1，还能召 Boss2 ⇒ 提示必须还在');
  assertTrue(hud.text().includes(bossSlotsFor('TARN')[1].label), '副行应换成 Boss2 的名字');
  game.ignises.summon(map.key, map.cx, map.cz, 1, 11);
  tick();
  assertEqual(hud.isVisible(), false, '两个都召了 ⇒ 提示消失（用户明确要求）');
  game.dragons.damage(r1.id, 100000, t);
  tick();
  assertEqual(hud.isVisible(), true, '打死一只 ⇒ 槽位空出来 ⇒ 提示回来');
  hud.dispose(); root.remove();
});

test('Boss 提示 HUD: 节流生效 —— 同一时间窗内重复 update 不重算（每帧调用零成本）', () => {
  const c = tarnCenter();
  const game = hintFixture(c.cx, c.cz);
  const { root, hud } = mountHint(game);
  hud.update(1000);
  const first = hud.evaluations();
  assertTrue(first > 0, '首次 update 必须真的算一次');
  for (let i = 0; i < 50; i++) hud.update(1000);      // 同一毫秒
  assertEqual(hud.evaluations(), first, '未到期不得重算（bossMapAt 进帧循环必须节流）');
  hud.update(1000 + BOSS_HINT_INTERVAL_MS + 1);
  assertEqual(hud.evaluations(), first + 1, '到期后算一次');
  hud.dispose(); root.remove();
});

test('Boss 提示 HUD: 层级/命中/归属三条契约（常驻信息层，不挡交互）', () => {
  const c = tarnCenter();
  const game = hintFixture(c.cx, c.cz);
  const { root, hud } = mountHint(game);
  hud.update(1000);
  const cs = getComputedStyle(hud.el);
  assertEqual(cs.zIndex, String(BOSS_HINT_Z_INDEX), 'z-index 必须取自导出常量');
  assertEqual(BOSS_HINT_Z_INDEX, 50, '与坐标/性能面板/血心同层（常驻信息）');
  assertEqual(cs.pointerEvents, 'none', '不得挡住任何点击');
  assertEqual(hud.el.parentElement, root, '必须挂在传入的 HUD 容器下（与其它 HUD 一起被隐藏）');
  assertEqual(hud.isModal(), false, '提示不是模态：不得进模态栈锁住玩家');
  hud.dispose(); root.remove();
});

test('Boss 提示 HUD: dispose 摘掉节点（换世界/多实例不残留）', () => {
  const c = tarnCenter();
  const game = hintFixture(c.cx, c.cz);
  const { root, hud } = mountHint(game);
  hud.update(1000);
  assertTrue(root.contains(hud.el), '前提：节点在容器里');
  hud.dispose();
  assertEqual(root.childElementCount, 0, 'dispose 必须摘干净');
  root.remove();
});

test('Boss 提示 HUD: 玩家还没装配时不抛（启动早期帧的纵深防御）', () => {
  const game = hintFixture(0, 0);
  game.player = null;
  const { root, hud } = mountHint(game);
  hud.update(1000);
  assertEqual(hud.isVisible(), false);
  hud.dispose(); root.remove();
});