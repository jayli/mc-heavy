// src/tests/test-guardian-system.js — 末影守卫 definition + service（Tier 1，TDD）
//
// 覆盖：命中盒（局部盒 / 相对脚底 / 产物独立复算 / yaw 现算）、create 校验与跨帧字段、
// summon 幂等与上限、**上层房间落点与 HEADROOM**、overlapsAabb、damage/knockback、寻路接线。
//
// ⚠️ 用**真实 EntityManager**（不是 fake）：fake 形状不对会让测试绿而生产红
// （`WorkerPool.call()` 返回 `{id,promise}` 那个坑的同源教训）。
import * as THREE from 'three';
import { test } from './runner.js';
import { assertEqual, assertTrue, assertNull, assertNotNull, assertFalse } from './assert.js';
import {
  GUARDIAN_TYPE, GUARDIAN, GUARDIAN_AI, GUARDIAN_ATTACKS, GUARDIAN_ATTACK_IDS,
  GUARDIAN_CORE_OBB, guardianEntityIdFor,
} from '../entities/guardian/guardian-config.js';
import {
  guardianDefinition, GuardianService, guardianAabbFor,
} from '../entities/guardian/guardian-system.js';
import { EntityManager } from '../entities/entity-manager.js';
import { resourceUrl } from '../core/resource-url.js';

/** 平地世界：y <= groundY 实心 */
function flatWorld(groundY) {
  return {
    isSolid: (_x, y, _z) => y <= groundY,
    getBlockId: (_x, y, _z) => (y <= groundY ? 1 : 0),
  };
}

/** 装好一个 service（真实 EntityManager + 注册 type） */
function mkSvc(world = flatWorld(10), extra = {}) {
  const em = new EntityManager();
  em.registerType(GUARDIAN_TYPE, guardianDefinition);
  return { em, svc: new GuardianService({ entities: em, world, seed: 12345, ...extra }) };
}

// ==================== 命中盒 ====================

test('守卫盒: guardianAabbFor 返回**局部盒**（不是世界盒）', () => {
  const box = guardianAabbFor({ position: [100, 10, 200], yaw: 0 });
  // 返回世界盒会让 position 被加两次 ⇒ 水平射线永远打不中，而盒尺寸断言全绿
  assertTrue(Math.abs(box.min[0]) < 5 && Math.abs(box.max[0]) < 5,
    `必须是相对 position 的局部盒，实际 min[0]=${box.min[0]}`);
  assertTrue(Math.abs(box.min[2]) < 5 && Math.abs(box.max[2]) < 5, 'z 同理');
});

test('守卫盒: 盒是相对**脚底**的（min[1] ≈ 1.4993，不是 0）', () => {
  const box = guardianAabbFor({ position: [0, 0, 0], yaw: 0 });
  // ⚠️ 守卫躯干含头盔，从脚底往上 1.5 格才开始 —— 照抄焰魔的「min[1] ≈ 0」会写错断言
  assertTrue(box.min[1] > 1.0, `核心盒下沿应 ≈1.4993，实际 ${box.min[1]}`);
  assertTrue(box.max[1] > 3.5, `盒必须覆盖到头顶（≈3.9369），实际 ${box.max[1]}`);
  assertTrue(box.min[1] >= 0, '盒底不得入地');
});

test('守卫盒: yaw 现算（0 与 π/4 的 AABB 必须不同）', () => {
  const a = guardianAabbFor({ position: [0, 0, 0], yaw: 0 });
  const b = guardianAabbFor({ position: [0, 0, 0], yaw: Math.PI / 4 });
  assertTrue(JSON.stringify(a) !== JSON.stringify(b), 'AABB 必须按 yaw 现算（固定盒会漏判）');
});

test('守卫盒: 旋转后最大水平半宽 = √(hx²+hz²) = 1.6205（overlapEscapeDist 的依据）', () => {
  // ⚠️ 量的是**对称跳度的一半**（(max−min)/2），不是 max(|min|,|max|)：
  // 后者含 `center.z = −0.4062` 的偏心，实测会得 1.9050（那是「推出所需距离」口径，
  // 服务 EJECT_MAX 复核），而 overlapEscapeDist 的下界用的是**盒自身的半宽** 1.6205。
  let mx = 0;
  for (let deg = 0; deg < 360; deg += 0.5) {
    const box = guardianAabbFor({ position: [0, 0, 0], yaw: deg * Math.PI / 180 });
    mx = Math.max(mx, (box.max[0] - box.min[0]) / 2, (box.max[2] - box.min[2]) / 2);
  }
  const h = GUARDIAN_CORE_OBB.halfExtents;
  const expect = Math.hypot(h[0], h[2]);
  assertTrue(Math.abs(mx - expect) < 0.01,
    `最大水平半宽 ${mx.toFixed(4)} 应 ≈ ${expect.toFixed(4)}`);
  assertTrue(GUARDIAN_AI.overlapEscapeDist >= expect + 0.3,
    '重叠阈必须 ≥ 最大半宽 + 玩家半宽');
});

test('守卫盒: 盒不对称（center.z ≠ 0）⇒ 旋转后前后跨度不等', () => {
  const box = guardianAabbFor({ position: [0, 0, 0], yaw: Math.PI / 4 });
  assertTrue(Math.abs(Math.abs(box.min[2]) - Math.abs(box.max[2])) > 0.1,
    'center.z 非零 ⇒ 斜角时前后半宽不等（只转半长会抹掉这个特征）');
});

/** 核心四骨骼（躯干 + 上下身 + 头盔 + 头，共 6 盒；不含四肢/护肩/尖刺） */
const CORE_BONES = Object.freeze(['lowerbody', 'upperbody', 'helmet', 'head']);

/**
 * 从烘焙产物**独立复算**核心包围盒（模型空间，格；尚未加 feetOffsetY）。
 *
 * ⚠️ **骨骼链口径 A**（spec §2.2.1）：`T(localPosition)·R(bindQuaternion)`，**pivot 恒零**。
 * 照搬焰魔的 `pivot − R·pivot` 会差 1.5 格而恒红。
 *
 * ⚠️⚠️ **顶点口径 B**（`metrics.vertexConvention === 'java-model-absolute'`，2026-11-11）：
 * 顶点已预乘 bind 世界矩阵（SkinnedMesh 必需 —— 否则 bind 姿态下顶点原样返回，
 * 24 个盒全堆在原点）。故本函数**不能再乘 world**，否则 bind 位置算两次
 *（实测 halfExtents[1] 从 1.2188 变成 2.4375）。
 * ⚠️ 用 `Matrix4.compose` 而非手写 4×4（烘焙器用的是手写）—— 两种独立实现得出同一组数才算复核。
 */
function coreBboxFromAsset(d) {
  const world = new Array(d.bones.length);
  d.bones.forEach((b, i) => {
    const local = new THREE.Matrix4().compose(
      new THREE.Vector3(...b.localPosition),
      new THREE.Quaternion(...b.bindQuaternion),
      new THREE.Vector3(1, 1, 1));
    world[i] = b.parentIndex === -1
      ? local
      : new THREE.Matrix4().multiplyMatrices(world[b.parentIndex], local);
  });
  const core = new Set(CORE_BONES.map((n) => d.bones.findIndex((b) => b.name === n)));
  assertTrue(!core.has(-1), '核心骨骼名在产物里找不到（骨骼改名了？）');
  const absolute = d.metrics.vertexConvention === 'java-model-absolute';
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  const P = d.geometry.position;
  for (let i = 0; i < P.length / 3; i++) {
    const bi = d.geometry.skinIndex[i * 4];
    if (!core.has(bi)) continue;
    v.set(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]);
    // 口径 B：顶点已是模型空间 bind 位置，直接用；口径 A：需乘世界链
    if (!absolute) v.applyMatrix4(world[bi]);
    box.expandByPoint(v);
  }
  return box;
}

/** 取烘焙产物（走真实 resourceUrl 路径，不写站点根绝对路径） */
async function loadAsset() {
  const res = await fetch(resourceUrl('assets/guardian/guardian.json'));
  assertTrue(res.ok, '产物 guardian.json 应可加载（跑过 npm run guardian 吗）');
  return res.json();
}

test('守卫盒: 命中盒 = 产物核心骨骼 bind pose 包围盒（独立复算，容差 1e-4）', async () => {
  const d = await loadAsset();
  const box = coreBboxFromAsset(d);
  const c = box.getCenter(new THREE.Vector3());
  const half = box.getSize(new THREE.Vector3()).multiplyScalar(0.5);
  const feet = d.metrics.feetOffsetY;
  const near = (cfg, derived, what) => assertTrue(Math.abs(cfg - derived) <= 1e-4,
    `${what}: 配置 ${cfg} vs 产物复算 ${derived.toFixed(5)}（改了素材/烘焙器？重标 GUARDIAN_CORE_OBB）`);
  for (let a = 0; a < 3; a++) near(GUARDIAN_CORE_OBB.halfExtents[a], half.getComponent(a), `halfExtents[${a}]`);
  near(GUARDIAN_CORE_OBB.center[0], c.x, 'center[0]');
  // ⚠️ 只有 y 受 feetOffsetY 影响（渲染器没有 x/z 偏移）
  near(GUARDIAN_CORE_OBB.center[1], c.y + feet, 'center[1]（= 模型空间 y + feetOffsetY）');
  near(GUARDIAN_CORE_OBB.center[2], c.z, 'center[2]');
});

test('守卫盒: 产物的 feetOffsetY 与口径 A 哨兵自洽', async () => {
  const d = await loadAsset();
  assertTrue(Math.abs(d.metrics.feetOffsetY - 1.6243) < 1e-3,
    `feetOffsetY 应 ≈ +1.6243，实际 ${d.metrics.feetOffsetY}`);
  assertEqual(JSON.stringify(d.bones[0].localPosition), JSON.stringify([0, -1.5, 0]),
    '口径 A 哨兵：root.localPosition');
  assertTrue(d.bones.every((b) => b.pivot.every((v) => v === 0)), 'pivot 恒零（口径 A）');
});

test('守卫盒: 脚底 +1.6…+3.9 格的水平射线都命中，地下与半空不命中', () => {
  const state = { position: [0, 10, 0], yaw: 0 };
  const hitAt = (y) => guardianDefinition.raycastAabb(state, [0, y, -6], [0, 0, 1], 20);
  for (const dy of [1.6, 2.0, 2.7, 3.5, 3.9]) {
    assertNotNull(hitAt(10 + dy), `脚底 +${dy} 格应命中核心躯干`);
  }
  assertNull(hitAt(10 - 0.5), '脚底之下不该有幻影命中');
  assertNull(hitAt(10 + 4.5), '头顶之上不该有幻影命中');
  assertNull(guardianDefinition.raycastAabb(state, [0, 12.7, 6], [0, 0, 1], 20),
    '朝远离方向射不命中');
});

// ==================== definition / createState ====================

test('守卫 definition: create 拒绝非法 position', () => {
  assertNull(guardianDefinition.create(null));
  assertNull(guardianDefinition.create({ position: [NaN, 0, 0] }));
  assertNull(guardianDefinition.create({ position: [0, 0] }));
});

test('守卫 definition: create 补全缺省字段', () => {
  const s = guardianDefinition.create({ position: [1, 2, 3] });
  assertNotNull(s);
  assertEqual(s.health, GUARDIAN.health);
  assertEqual(s.mode, 'idle');
  assertNull(s.attackKind);
  assertNull(s.attackRequest);
  assertEqual(s.attackAnimT, 0);
  assertNotNull(s.attackCooldowns, 'attackCooldowns 必须存在');
  for (const id of GUARDIAN_ATTACK_IDS) assertEqual(s.attackCooldowns[id], 0, `${id} 缺省 0`);
});

test('守卫 definition: create 保留跨帧累积字段（丢掉任一个都会静默失效）', () => {
  const cds = {};
  for (const id of GUARDIAN_ATTACK_IDS) cds[id] = 3.5;
  const s = guardianDefinition.create({
    position: [1, 2, 3],
    attackCooldowns: cds,
    _physAccum: 0.008,
    acquireT: 0.9,
    stuckT: 2.5,
    stuckAnchor: [4, 5],
    sensedPlayer: [7, 8, 9],
    senseTimer: 1.2,
    escapeFailCount: 2,
    idleTime: 3.3,
  });
  for (const id of GUARDIAN_ATTACK_IDS) {
    assertEqual(s.attackCooldowns[id], 3.5, `${id} 冷却必须跨帧保留（否则独立冷却永不生效）`);
  }
  assertEqual(s._physAccum, 0.008, '_physAccum（否则 onGround 恒 false）');
  assertEqual(s.acquireT, 0.9, 'acquireT（否则立即追击）');
  assertEqual(s.stuckT, 2.5, 'stuckT');
  assertEqual(JSON.stringify(s.stuckAnchor), JSON.stringify([4, 5]), 'stuckAnchor（否则脱困永不触发）');
  assertEqual(JSON.stringify(s.sensedPlayer), JSON.stringify([7, 8, 9]));
  assertEqual(s.senseTimer, 1.2);
  assertEqual(s.escapeFailCount, 2, 'escapeFailCount（否则永远等不到强化跳）');
  assertEqual(s.idleTime, 3.3);
});

test('守卫 definition: create 的 attackKind 取值域是四档（非法回落第一档）', () => {
  for (const id of GUARDIAN_ATTACK_IDS) {
    assertEqual(guardianDefinition.create({ position: [0, 0, 0], attackKind: id }).attackKind, id);
  }
  assertNull(guardianDefinition.create({ position: [0, 0, 0], attackKind: null }).attackKind);
  assertEqual(guardianDefinition.create({ position: [0, 0, 0], attackKind: 'spin' }).attackKind,
    GUARDIAN_ATTACK_IDS[0], '焰魔的 spin 不是守卫的招式 ⇒ 回落');
});

test('守卫 definition: leapKind 只接受 escape（守卫无跳劈）', () => {
  assertEqual(guardianDefinition.create({ position: [0, 0, 0], leapKind: 'escape' }).leapKind, 'escape');
  assertNull(guardianDefinition.create({ position: [0, 0, 0], leapKind: 'attack' }).leapKind,
    'attack 飞跃必须被拒（原版守卫无此招）');
});

test('守卫 definition: create 返回全新数组（不共享输入）', () => {
  const p = [1, 2, 3];
  const s = guardianDefinition.create({ position: p });
  assertTrue(s.position !== p, 'position 必须是新数组');
  p[0] = 99;
  assertEqual(s.position[0], 1, '改输入不得影响 state');
});

test('守卫 definition: update 返回全新 state（M5 不变式）', () => {
  const s = guardianDefinition.create({ position: [0, 10, 0] });
  const entity = { id: 'guardian:t:0', type: GUARDIAN_TYPE, state: s };
  const next = guardianDefinition.update(entity, 1 / 60, { world: flatWorld(9) });
  assertNotNull(next);
  assertTrue(next !== s, '不得原地返回同一对象');
  assertTrue(next.position !== s.position, 'position 必须是新数组');
});

test('守卫 definition: serialize 不含瞬态字段（attackRequest / attackCooldowns）', () => {
  const s = guardianDefinition.create({
    position: [1, 2, 3], yaw: 0.5, health: 1500,
    attackRequest: { at: [1, 2, 3], yaw: 0, kind: 'stomp' },
  });
  const snap = guardianDefinition.serialize(s);
  assertNull(snap.attackRequest === undefined ? null : snap.attackRequest,
    'attackRequest 不得进快照（陈旧请求复活）');
  assertTrue(!('attackAnimT' in snap), 'AI 瞬态不进快照');
  assertEqual(snap.health, 1500);
  const back = guardianDefinition.deserialize(snap);
  assertNotNull(back);
  assertNull(back.attackRequest, '反序列化后 attackRequest 必须显式 null');
  assertEqual(back.mode, 'idle');
});

// ==================== service.summon ====================

test('守卫 service: summon 在地表落点生成实体（脚下实心 / 自身空气）', () => {
  const { svc, em } = mkSvc(flatWorld(10));
  const r = svc.summon('ruinedcitadel:0', 100, 200, 0, 11);
  assertTrue(r.ok, '首次召唤应成功');
  const e = em.get(r.id);
  assertNotNull(e);
  assertEqual(e.state.position[1], 11, '脚底应贴地面 y=11');
  assertEqual(e.state.position[0], 100.5, 'x 取格中心');
  assertEqual(e.state.position[2], 200.5, 'z 取格中心');
  assertEqual(e.state.health, GUARDIAN.health);
});

test('守卫 service: summon 幂等（同槽重召不产生第二条）', () => {
  const { svc } = mkSvc();
  const a = svc.summon('ruinedcitadel:0', 10, 20, 0, 11);
  assertTrue(a.ok);
  const b = svc.summon('ruinedcitadel:0', 10, 20, 0, 11);
  assertFalse(b.ok);
  // ⚠️ **maxAlive = 1 ⇒ count 检查先命中，返回 'limit' 而不是 'exists'**
  //（焰魔 maxAlive=2 时同槽重召才走到 id 检查）。两者都是「拒绍且零副作用」，
  // 关键判据是**场上仍只有一条**；这里钉住真实 reason，不写成想象中应该的那个。
  assertEqual(b.reason, 'limit', 'maxAlive=1 时上限检查先命中');
  assertEqual(svc.activeEntities().length, 1);
});

test('守卫 service: 死后重召复用同 id 且场上只有一条（Review Focus #4）', () => {
  const { svc } = mkSvc();
  const r1 = svc.summon('ruinedcitadel:0', 10, 20, 0, 11);
  assertTrue(r1.ok);
  const d = svc.damage(r1.id, 99999, 1000);
  assertTrue(d.dead, '超量伤害应致死');
  const r2 = svc.summon('ruinedcitadel:0', 10, 20, 0, 11);
  assertTrue(r2.ok, '死后应可重召');
  assertEqual(r2.id, r1.id, '必须复用同 id（否则攒出第二条）');
  assertEqual(svc.activeEntities().length, 1);
});

test('守卫 service: 超出 maxAlive 返回 limit', () => {
  const { svc } = mkSvc();
  assertTrue(svc.summon('ruinedcitadel:0', 10, 20, 0, 11).ok);
  const b = svc.summon('ruinedcitadel:1', 30, 40, 0, 11);
  assertFalse(b.ok);
  assertEqual(b.reason, 'limit', '守卫上限 1 ⇒ 第二张图也召不出');
});

test('守卫 service: 空世界（isSolid 恒 false）也能召唤（兜底落点，不抛）', () => {
  const { svc } = mkSvc({ isSolid: () => false, getBlockId: () => 0 });
  const r = svc.summon('ruinedcitadel:0', 5, 5, 0, 11);
  assertTrue(r.ok);
});

// ==================== 上层房间落点与 HEADROOM（本任务的核心判别用例）====================

/**
 * 三层地牢 fixture —— **照真实废弃堡垒的净空造**。
 *
 * 真实数据（审阅实测）：最深 floor ny22 / air ny23..29（7 格）；中层 floor ny30 / air ny31..36（6 格）；
 * **上层 floor ny38 / air ny39..43（只有 5 格）**，天花板 ny44。
 * 这里用 y 平移后的等价层：floor 22/30/38，空气从 floor+1 起。
 *
 * ⚠️ **上层净空必须只有 5 格**：造无限净空的 fixture 会让 `HEADROOM=5` 的缺陷测不出来
 * （实测 HEADROOM=5 时 ny39 被判死 ⇒ 落点静默变成 ny31，差 8 格）。
 */
function dungeonWorld() {
  // 每层：floorY 实心，其上 air 直到下一层 floor 之前
  const floors = [22, 30, 38];
  const ceilOf = { 22: 29, 30: 36, 38: 43 };   // 该层最高的空气格
  return {
    isSolid: (_x, y, _z) => {
      if (y <= 22) return true;                 // 最深地板及以下全实心
      for (const f of floors) {
        if (y === f) return true;               // 各层地板
        if (y > ceilOf[f] && y <= (f === 38 ? 44 : f + 8)) return true;   // 天花板/隔层
      }
      return y >= 44;                           // 顶层天花板及以上
    },
    getBlockId(x, y, z) { return this.isSolid(x, y, z) ? 1 : 0; },
  };
}

test('守卫 service: summon 用 refY 落到**上层房间**（不是最深/中层）', () => {
  const { svc, em } = mkSvc(dungeonWorld());
  // refY = 上层脚底 39（对应真实的 floorY − 6）
  const r = svc.summon('ruinedcitadel:0', 4, 4, 0, 39);
  assertTrue(r.ok);
  assertEqual(em.get(r.id).state.position[1], 39,
    '必须落在上层房间（39），不是中层 31 或最深 23');
});

test('守卫 service: HEADROOM ≤ 4 —— 净空只有 5 格的层仍能被选中', () => {
  const w = dungeonWorld();
  // 上层：脚底 39，其上 40..43 空气（4 格），44 实心
  assertTrue(!w.isSolid(4, 39, 4), '39 是空气');
  assertTrue(w.isSolid(4, 38, 4), '38 是地板');
  for (const y of [40, 41, 42, 43]) assertTrue(!w.isSolid(4, y, 4), `${y} 应是空气`);
  assertTrue(w.isSolid(4, 44, 4), '44 是天花板 ⇒ 净空恰好 5 格（39..43）');
  const { svc, em } = mkSvc(w);
  const r = svc.summon('ruinedcitadel:0', 4, 4, 0, 39);
  assertEqual(em.get(r.id).state.position[1], 39,
    'HEADROOM 取 5 会把这层判死 ⇒ 静默落到 31（差 8 格）');
  // 直接钉住常量口径：守卫高 3.8 ⇒ ceil = 4
  assertEqual(Math.ceil(GUARDIAN.height), 4, 'HEADROOM 应为 ceil(height)=4');
});

test('守卫 service: 不传 refY 时取最低可站层（最深房间）—— 说明为何必须传', () => {
  const { svc, em } = mkSvc(dungeonWorld());
  const r = svc.summon('ruinedcitadel:0', 4, 4, 0);
  assertTrue(r.ok);
  assertEqual(em.get(r.id).state.position[1], 23,
    '不传 refY ⇒ 最低层（最深房间，玩家走不下去）⇒ 装配层必须传 summonY');
});

test('守卫 service: 落点满足守卫体形（3×3 footprint × 4 层空气 + 地板实心）', () => {
  const w = dungeonWorld();
  const { svc, em } = mkSvc(w);
  const r = svc.summon('ruinedcitadel:0', 4, 4, 0, 39);
  const y = em.get(r.id).state.position[1];
  for (let dy = 0; dy < Math.ceil(GUARDIAN.height); dy++) {
    assertFalse(w.isSolid(4, y + dy, 4), `脚底 +${dy} 层必须是空气`);
  }
  assertTrue(w.isSolid(4, y - 1, 4), '脚下必须实心');
});

// ==================== 台阶（取代无判别力的 maxStep 1.75 探针）====================

test('守卫 service: 1 格台阶能上去（守卫半宽 1.25 / 高 3.8）', () => {
  // 地面 y=9；z<=-6 的列在 y=10 也实心（1 格台阶），上方净空充足
  const w = {
    isSolid: (_x, y, z) => y <= 9 || (z <= -6 && y <= 10),
    getBlockId(_x, y, z) { return this.isSolid(_x, y, z) ? 1 : 0; },
  };
  const { svc, em } = mkSvc(w);
  const r = svc.summon('ruinedcitadel:0', 0, 0, 0, 10);
  const e = em.get(r.id);
  const ctx = { world: w, registry: { solidTable: { 1: 1 }, opaqueTable: { 1: 1 } }, player: { position: [0.5, 11, -14.5] } };
  for (let i = 0; i < 400; i++) {
    e.state = guardianDefinition.update(e, 1 / 60, ctx);
  }
  assertTrue(e.state.position[1] > 10.9, `应登上 1 格台阶（y≈11），实际 ${e.state.position[1]}`);
});

test('守卫 service: 2 格台阶上不去（maxStep 是死值的回归守卫）', () => {
  const w = {
    isSolid: (_x, y, z) => y <= 9 || (z <= -6 && y <= 11),
    getBlockId(_x, y, z) { return this.isSolid(_x, y, z) ? 1 : 0; },
  };
  const { svc, em } = mkSvc(w);
  const r = svc.summon('ruinedcitadel:0', 0, 0, 0, 10);
  const e = em.get(r.id);
  const ctx = { world: w, registry: { solidTable: { 1: 1 }, opaqueTable: { 1: 1 } }, player: { position: [0.5, 12, -14.5] } };
  // ⚠️ **只跑 3 秒（< stuckLeapSeconds 4s）**：被 2 格墙挡住后守卫会在 4s 时
  // **正确地触发脱困跳**（实测跳到 y≈11.1）—— 那不是「上了台阶」。
  // 跑 400 帧会把脱困跳误当成 step-up 失效（实测踩过）。
  for (let i = 0; i < 180; i++) {
    e.state = guardianDefinition.update(e, 1 / 60, ctx);
  }
  // 判据：没有**站上台阶顶面**（2 格台阶的顶面是 y=12），也没靠 step-up 抬到 11
  assertTrue(e.state.position[1] < 10.9,
    `2 格台阶不该靠 step-up 上去，实际 y=${e.state.position[1]}`
    + '（若上了 ⇒ zombieStepUpY 被改过，停下报告）');
  assertNull(e.state.leapKind, '3 秒内不应起跳（钉住本用例没被脱困跳污染）');
});

// ==================== overlapsAabb ====================

test('守卫 service: overlapsAabb 相交真 / 远离假 / 无守卫假', () => {
  const { svc } = mkSvc(flatWorld(10));
  assertTrue(svc.summon('ruinedcitadel:0', 5, 5, 0, 11).ok);
  // 守卫脚底 (5.5, 11, 5.5)，核心盒 y ∈ [12.5, 14.9]
  assertTrue(svc.overlapsAabb({
    minX: 5, maxX: 6, minY: 12.6, maxY: 14.4, minZ: 5, maxZ: 6,
  }), '盒内应相交');
  assertFalse(svc.overlapsAabb({
    minX: 50, maxX: 51, minY: 12.6, maxY: 14.4, minZ: 50, maxZ: 51,
  }), '远处不该相交');
  const { svc: svc2 } = mkSvc();
  assertFalse(svc2.overlapsAabb({
    minX: 5, maxX: 6, minY: 12, maxY: 15, minZ: 5, maxZ: 6,
  }), '无守卫时恒假');
});

test('守卫 service: overlapsAabb 贴面不算重叠（严格不等式）', () => {
  const { svc, em } = mkSvc(flatWorld(10));
  const r = svc.summon('ruinedcitadel:0', 5, 5, 0, 11);
  const e = em.get(r.id);
  const box = guardianAabbFor(e.state);
  const p = e.state.position;
  const maxX = p[0] + box.max[0];
  assertFalse(svc.overlapsAabb({
    minX: maxX, maxX: maxX + 1, minY: p[1] + box.min[1], maxY: p[1] + box.max[1],
    minZ: p[2] - 1, maxZ: p[2] + 1,
  }), '恰好贴面不该算重叠（否则玩家被推离，观感是碰不到它）');
});

test('守卫 service: overlapsAabb 死亡后不再相交（id 留在 Set 里但实体已 despawn）', () => {
  const { svc } = mkSvc(flatWorld(10));
  const r = svc.summon('ruinedcitadel:0', 5, 5, 0, 11);
  svc.damage(r.id, 99999, 1000);
  assertFalse(svc.overlapsAabb({
    minX: 5, maxX: 6, minY: 12.6, maxY: 14.4, minZ: 5, maxZ: 6,
  }), '已 despawn 的 id 必须跳过（漏 null 检查会抛 TypeError）');
});

test('守卫 service: overlapsAabb 只认守卫（不抢焰魔/丧尸的实体）', () => {
  const { svc, em } = mkSvc(flatWorld(10));
  // 注册一个别的 type 并 spawn 在同位置
  em.registerType('zombie', {
    create: (s) => ({ ...s }),
    update: (e) => e.state,
    raycastAabb: () => null,
    serialize: (s) => s,
    deserialize: (s) => s,
  });
  em.spawn({ id: 'zombie:1', type: 'zombie', state: { position: [5.5, 11, 5.5], yaw: 0 }, persistent: false });
  assertFalse(svc.overlapsAabb({
    minX: 5, maxX: 6, minY: 12.6, maxY: 14.4, minZ: 5, maxZ: 6,
  }), '只有丧尸时守卫 service 不该报相交');
});

// ==================== damage / knockback ====================

test('守卫 service: damage 精确扣血 + 红闪（performance.now 口径）', () => {
  const { svc, em } = mkSvc();
  const r = svc.summon('ruinedcitadel:0', 5, 5, 0, 11);
  const d = svc.damage(r.id, 100, 5000);
  assertFalse(d.dead);
  assertEqual(d.health, GUARDIAN.health - 100);
  assertEqual(em.get(r.id).state.flashedUntil, 5000 + GUARDIAN.flashMs);
});

test('守卫 service: 临界伤害序列（恰好打满致死，少一点不死）', () => {
  const { svc } = mkSvc();
  const r = svc.summon('ruinedcitadel:0', 5, 5, 0, 11);
  // 总伤害恰好 = health：先打 health−1（剩 1 血不死），再补 1 血
  assertFalse(svc.damage(r.id, GUARDIAN.health - 1, 100).dead, '差 1 血不得死');
  const d = svc.damage(r.id, 1, 200);
  assertTrue(d.dead, '恰好打满血量应致死');
  assertEqual(svc.activeEntities().length, 0);
});

test('守卫 service: damage 未知 id / 非守卫实体返回 null', () => {
  const { svc, em } = mkSvc();
  assertNull(svc.damage('nope', 10, 0));
  em.registerType('zombie', {
    create: (s) => ({ ...s }), update: (e) => e.state,
    raycastAabb: () => null, serialize: (s) => s, deserialize: (s) => s,
  });
  em.spawn({ id: 'zombie:1', type: 'zombie', state: { position: [0, 11, 0] }, persistent: false });
  assertNull(svc.damage('zombie:1', 10, 0), '非守卫实体不得被守卫 service 扣血');
});

test('守卫 service: knockback 瞬时位移 + 上报实际位移', () => {
  const seen = [];
  const { svc, em } = mkSvc(flatWorld(10), {
    onKnockback: (id, dx, dz) => seen.push([id, dx, dz]),
  });
  const r = svc.summon('ruinedcitadel:0', 5, 5, 0, 11);
  const before = em.get(r.id).state.position[2];
  assertTrue(svc.knockback(r.id, 0, 0.4), '开阔地应推得动');
  const after = em.get(r.id).state.position[2];
  assertTrue(Math.abs(after - before - 0.4) < 1e-6, '权威位移必须瞬时且等于请求（无阻挡）');
  assertEqual(seen.length, 1, '应上报一次');
  assertTrue(Math.abs(seen[0][2] - 0.4) < 1e-6, '上报的是实际位移');
});

test('守卫 service: knockback 撞墙时上报实际位移（不是请求位移）', () => {
  const seen = [];
  // z >= 7 是墙 ⇒ 从 5.5 往 +Z 推 0.4 会被挡
  const w = {
    isSolid: (_x, y, z) => y <= 10 || z >= 7,
    getBlockId(_x, y, z) { return this.isSolid(_x, y, z) ? 1 : 0; },
  };
  const { svc, em } = mkSvc(w, { onKnockback: (id, dx, dz) => seen.push([id, dx, dz]) });
  const r = svc.summon('ruinedcitadel:0', 5, 5, 0, 11);
  const before = em.get(r.id).state.position[2];
  svc.knockback(r.id, 0, 3);
  const moved = em.get(r.id).state.position[2] - before;
  assertTrue(moved < 3, '撞墙应只走了一部分');
  if (seen.length > 0) {
    assertTrue(Math.abs(seen[0][2] - moved) < 1e-6, '上报必须是实际位移');
  }
});

test('守卫 service: knockback 未知 id 返回 false', () => {
  const { svc } = mkSvc();
  assertFalse(svc.knockback('nope', 1, 0));
});

test('守卫 service: activeEntities 返回快照（遍历中 despawn 不失效）', () => {
  const { svc } = mkSvc();
  const r = svc.summon('ruinedcitadel:0', 5, 5, 0, 11);
  const list = svc.activeEntities();
  svc.damage(r.id, 99999, 0);
  assertEqual(list.length, 1, '快照不应随 despawn 变化');
  assertEqual(svc.activeEntities().length, 0);
});

test('守卫 service: dispose 清空全部与寻路残留', () => {
  const { svc } = mkSvc();
  svc.summon('ruinedcitadel:0', 5, 5, 0, 11);
  svc.dispose();
  assertEqual(svc.activeEntities().length, 0);
  assertNull(svc.cachedPathOf(guardianEntityIdFor('ruinedcitadel:0', 0)));
  assertFalse(svc.overlapsAabb({ minX: 5, maxX: 6, minY: 12, maxY: 15, minZ: 5, maxZ: 6 }));
});

// ==================== 寻路接线 ====================

test('守卫 service: update 需要 playerPosition（缺省不抛）', () => {
  const { svc } = mkSvc();
  svc.update(1 / 60);
  svc.update(1 / 60, {});
  svc.update(1 / 60, { playerPosition: [0, 11, 0] });
  assertNotNull(svc.navDebugState());
});

test('守卫 service: needsPath 为真时才跑寻路（开阔地零 A* 开销）', () => {
  const { svc, em } = mkSvc(flatWorld(10));
  const r = svc.summon('ruinedcitadel:0', 5, 5, 0, 11);
  const e = em.get(r.id);
  e.state = guardianDefinition.create({ ...e.state, needsPath: false });
  for (let i = 0; i < 20; i++) svc.update(1 / 60, { playerPosition: [0.5, 11, -20.5], nowMs: i * 16 });
  assertEqual(svc.navDebugState().decisions, 0, 'needsPath 假 ⇒ 不该跑 A*');
});

test('守卫 service: needsPath 为真时写入 navDir 或 blocked', () => {
  const w = {
    isSolid: (x, y, z) => y <= 10 || (z === 0 && x >= -20 && x <= 20 && y <= 14),
    getBlockId(x, y, z) { return this.isSolid(x, y, z) ? 1 : 0; },
  };
  const { svc, em } = mkSvc(w);
  const r = svc.summon('ruinedcitadel:0', 5, 5, 0, 11);
  const e = em.get(r.id);
  e.state = guardianDefinition.create({ ...e.state, needsPath: true });
  for (let i = 0; i < 20; i++) svc.update(1 / 60, { playerPosition: [5.5, 11, -10.5], nowMs: i * 16 });
  assertTrue(svc.navDebugState().decisions > 0, '应跑过寻路决策');
  const s = em.get(r.id).state;
  assertTrue(s.navDir !== null || s.navMode === 'blocked', '应写入方向或 blocked');
});

test('守卫 service: 死亡后寻路缓存与记忆被回收', () => {
  const { svc, em } = mkSvc(flatWorld(10));
  const r = svc.summon('ruinedcitadel:0', 5, 5, 0, 11);
  const e = em.get(r.id);
  e.state = guardianDefinition.create({ ...e.state, needsPath: true });
  svc.update(1 / 60, { playerPosition: [5.5, 11, -10.5], nowMs: 100 });
  svc.damage(r.id, 99999, 200);
  assertNull(svc.cachedPathOf(r.id), '死亡应回收缓存（否则死了又召带着上条命的状态）');
});

// ==================== 四招档案与结算口径 ====================

test('守卫 service: attackRequest 的 kind 让结算方按招取判据（不用派生最大值）', () => {
  // 结算侧口径守卫：踩踏 180° 全向、重击 35° —— 若用派生最大值 180 会让重击也全向
  assertTrue(GUARDIAN_ATTACKS.stomp.hitConeDeg === 180, '踩踏全向');
  assertTrue(GUARDIAN_ATTACKS[GUARDIAN_ATTACK_IDS[0]].hitConeDeg < 90, '重击必须是窄锥');
  assertTrue(GUARDIAN_AI.hitConeDeg === 180, '派生值是最宽的踩踏（只服务「最宽能到多少」读法）');
});