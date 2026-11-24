# 敌人士兵（soldier）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 `soldier` 敌人类型 —— 端枪远程射手，C 键召唤（上限 10），丧尸巢穴交替产出，现有全部武器与 TNT 可击伤，子弹命中玩家扣 2 血。

**Architecture:** 同构层 `entities/soldiers/` 四件（config / shooting 纯函数 / agent 状态机 / system+service），渲染层 `render/soldier-*` 三件（几何 / 7 部件 InstancedMesh / 枪口火光池）。AI 取上游状态机但**不扫掩体**（方案 B：距离环 8~20 格 + 侧向游走 + 周期蹲起）。寻路、物理、命中、曳光全部复用既有件；两处纯提取重构（丧尸物理三件、KV-9 火光材质）使两侧共用一份实现。

**Tech Stack:** 原生 ES module、three r185.1 WebGPU + TSL、Playwright、Node v26。零新依赖、零新贴图、零新音频文件。

**Spec:** `docs/superpowers/specs/2026-11-24-soldier-enemy-port-design.md`

## Global Constraints

- **同构层纪律**（红线 8/10）：`src/entities/soldiers/**` 不得 import three、不碰 DOM（`document`/`window`/`createImageBitmap`）、不自建 Worker。`npm run check:arch` 静态门守。
- **只读 state 返回全新对象 + 全新数组**（M5 不变式）：`EntityManager.update` 的跨 column 索引迁移判据是「赋值前 position vs 赋值后 position」，原地改写或浅拷贝会让索引永不迁移 → column 卸载漏回收。
- **跨帧量必须留在 state**：`_physAccum` / `awareness` / 各计时器 / `burst` / `deadT` 丢掉任一 ⇒ 每帧重置 ⇒ 该机制永不生效而数值看着全对。
- **Agent 不生成实体、不改世界、不写玩家血量**：只写 `shotRequest` 意图，由 `game.js` 在 `entities.update` 之后结算。
- **时间基准 `performance.now()`**，禁 `Date.now()`。
- **常态零分配门控**：每帧跑的方法在场上无士兵时只做一次 `entities.count(SOLDIER_TYPE)`；门控须区分「已知为 0」与「未知」。
- **空载 draw call 回基线**：无士兵时全部 InstancedMesh 与火光池 `visible=false`。
- **不改既有冻结数值**：`ZOMBIE.*` / `TURRET.*` / `NEST.spawnIntervalMs` / `NEST.spawnOffsets` / `NEST.spawnDy*` / `CARBINE.*` 一个不动。
- **TSL 五条已实测口径**：常量色显式拆分量 `vec3(c.r,c.g,c.b)`（`vec3(Color)` 输出纯黑且零报错）；节点不与裸数字算术（用 `.mul(1.4)`）；径向量必须片元算；不链式 `.mix()`；逐实例亮度走 `instanceColor` 而非共享 `material.opacity`。
- **负向验证纪律**：用 `edit` 注入并**读回源码确认注入落地**；还原用 `cp` 副本，**禁 `git checkout`/`restore`**。
- **测试命令不接管道**（`| tail` 会把退出码换成管道末端工具的）。
- **提交等明确指令**；Conventional Commits（`feat:`/`test:`/`refactor:`/`chore:`）。本计划的 commit 步骤是**计划内的提交点**，执行时按用户当次授权决定是否真的执行。
- **最小充分集**：见每个 Task 的验证步骤。**不跑 `npm test`**（本次不是全局基础设施改动）。

## Review Focus

以下五类是 spec 蕴含但最可能咬人的失效，按咬人概率排序。每类都在指定 Task 里有对应判据：

1. **留尸期与上限判定混用** —— 玩家打死一个士兵后 1.2s 内按 C 应能立刻补上（用户要的是「同时**存活** 10 个」）。用 `entities.count()` 会把留尸算进去 ⇒ 按键没反应而数值全对。→ Task 4 Step 7 的「留尸期上限」用例。
2. **士兵退化成「会开枪的丧尸」** —— combat 态应始终与玩家保持 8~20 格，而不是直冲到 0.6 格贴身。这是方案 B 的身份载体。→ Task 8 Step 3 的距离环用例 + N5 负向验证。
3. **子弹穿墙打人** —— 玩家与士兵之间砌一堵实心墙后，玩家血量必须逐位不变。体素世界随时被挖改，`sees()` 的 10Hz 缓存结果可能已过期。→ Task 3 Step 5 的不穿墙用例。
4. **巢穴只出一种 / 满额不回落** —— 连续到期必须交替产出；士兵满额时必须回落丧尸；两者都满时不产出但仍写回时钟。→ Task 6 Step 3/5/7 三条用例。
5. **两处提取重构改坏既有对象** —— 丧尸物理三件提取后丧尸/焰魔/守卫行为须逐位不变；火光材质提取后 KV-9 火光须逐位不变。→ Task 1 Step 5 与 Task 7 Step 5 的既有 spec 全跑。

---

## File Structure

| 文件 | 职责 |
|---|---|
| `src/entities/zombies/zombie-navigation.js`（改） | 新增导出的参数化物理三件（`moveAxisAabb` / `tryStepUpAabb` / `physicsStepAabb`），丧尸与士兵共用 |
| `src/entities/zombies/zombie-system.js`（改） | 私有物理三件改为转调上面的导出（纯提取，行为逐位不变） |
| `src/entities/soldiers/soldier-config.js`（新） | 玩法数值唯一权威 + `SOLDIER_TYPE` + `soldierEntityIdFor` |
| `src/entities/soldiers/soldier-shooting.js`（新） | 纯函数：命中率 / 散布点 / 弹道判定 |
| `src/entities/soldiers/soldier-agent.js`（新） | 状态机 + 移动意图 + 点射节奏 + 姿态量 |
| `src/entities/soldiers/soldier-system.js`（新） | `soldierDefinition` + `SoldierService` |
| `src/render/soldier-geometry.js`（新） | 上游 5 个部件几何 + 逐顶点色/aSurf/aGlow + 锚点 |
| `src/render/soldier-renderer.js`（新） | 7 个容量 10 的 InstancedMesh + 步态/蹲姿/后坐/倒地/红闪 |
| `src/render/muzzle-flash-material.js`（新） | 从 `carbine-view.js` 提取的枪口火光材质（两侧共用） |
| `src/render/soldier-muzzle-fx.js`（新） | 士兵枪口火光池（容量 4） |
| `src/render/carbine-view.js`（改） | 改 import 提取出去的火光材质 |
| `src/render/carbine-fx.js`（改） | 三个公开薄方法 + `clear({keepWorldFx})` |
| `src/render/turret-metal.js`（改） | 加 `vertexColor` / `glowAttribute` 可选分支（缺省关闭） |
| `src/entities/entity-types.js`（改） | 可击中集合加 `'soldier'` |
| `src/entities/zombie-nests/nest-config.js`（改） | 加 `spawnOrder` |
| `src/entities/zombie-nests/zombie-nest-controller.js`（改） | 交替产出 + 满额回落 |
| `src/core/game.js`（改） | 装配 + 7 处接线 + `_consumeSoldierShots` + `spawnSoldierNearPlayer` |
| `src/player/player.js`（改） | `KeyC` 绑定 + `onSpawnSoldier` / `onPlayerShot` 注入 |
| `src/core/perf-hud.js`（改） | HELP_LINES 加 C 键 |
| `src/tests/test-perf.js`（改） | 同步文案断言 |
| `src/tests/test-weapons.js`（改） | 「恰好四类型」断言改五项 |
| `tests/enemy-roster.mjs`（改） | 登记 soldier |
| `src/tests/test-soldier-config.js` / `test-soldier-shooting.js` / `test-soldier-agent.js` / `test-soldier-system.js` / `test-soldier-render.js`（新） | 浏览器内单测 |
| `tests/soldier.spec.mjs`（新） | 真实页面 E2E + Tier 4 像素 |
| `src/tests/index.html` / `tools/test-tiers.mjs`（改） | 注册与归档 |

**任务顺序的理由**：Task 1（物理提取）与 Task 7（材质提取）是两处独立重构，各自可被既有 spec 单独验收，故各自成 Task；Task 2→3→4→5 是同构层自底向上（数值→纯函数→状态机→服务），每层只依赖下层已定好的接口；Task 6（巢穴）只依赖 Task 4 的 `spawn` 签名；Task 8 是唯一的整页接线 Task。

---

### Task 1: 物理三件提取为共用参数化实现

**Files:**
- Modify: `src/entities/zombies/zombie-navigation.js`（在文件末尾追加三个导出）
- Modify: `src/entities/zombies/zombie-system.js:187-266`（私有三件改转调）
- Test: `src/tests/test-zombies.js`（既有，不改）、`tests/zombies.spec.mjs`（既有，不改）

**Interfaces:**
- Consumes: 既有 `aabbCollidesAt(world,x,y,z,halfWidth,height)`、`zombieStepUpY(y)`（同文件已导出）
- Produces:
  ```js
  // 全部原地改写传入 state（与既有私有版同语义）
  moveAxisAabb(state, world, delta, axis, box, zeroVelocityOnHit) -> void
  tryStepUpAabb(state, world, box) -> boolean
  physicsStepAabb(state, world, dt, box) -> void
  // box = {halfWidth:number, height:number, maxStep:number, gravity:number}
  ```

- [ ] **Step 1: 写失败测试 —— 参数化物理与丧尸私有版逐位等价**

在 `src/tests/test-zombies.js` 末尾追加（该文件已在 `index.html` 注册，无需改注册）：

```js
test('物理提取: physicsStepAabb(丧尸 box) 与丧尸 definition 逐位等价', () => {
  const { world, entities } = makeZombieFixture({ withRenderer: false });
  const box = { halfWidth: ZOMBIE.width / 2, height: ZOMBIE.height,
                maxStep: ZOMBIE_MAX_STEP, gravity: -24.0 };
  // 对照组：走丧尸自己的 definition（唯一权威）
  const ref = entities.spawn({ id: 'ref', type: 'zombie',
    state: { position: [0.5, 3, 0.5], velocity: [1.2, 0, 0] } });
  // 被测组：只调 physicsStepAabb 的临时 definition
  entities.registerType('probe-phys', {
    create: (s) => ({ ...s, position: [...s.position], velocity: [...s.velocity] }),
    update: (e, dt) => {
      const s = { ...e.state, position: [...e.state.position], velocity: [...e.state.velocity] };
      physicsStepAabb(s, world, dt, box);
      return s;
    },
    raycastAabb: () => null, serialize: () => null, deserialize: () => null,
  });
  const got = entities.spawn({ id: 'got', type: 'probe-phys',
    state: { position: [0.5, 3, 0.5], velocity: [1.2, 0, 0] } });
  // 喂同一串 dt（每步恰为 1/60，保证两边都只跑一个固定步）
  for (let i = 0; i < 120; i++) {
    entities.update(1 / 60, { world });
    assertDeepEqual(entities.get('got').state.position, entities.get('ref').state.position,
      `第 ${i} 步位置逐位相等`);
  }
});
```

⚠️ **对照必须走丧尸自己的 definition**，不得在本用例里复制一份物理公式（那是「对照脚本与被测代码共享同一个错误假设」）。
⚠️ 两组必须喂**完全相同的 dt 序列**且 `_physAccum` 初值都是 0，否则固定步数不同会造成假红。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx playwright test tests/unit-fast.spec.mjs`
Expected: FAIL —— `physicsStepAabb is not defined` / import 报错

- [ ] **Step 3: 实现三个导出**

在 `zombie-navigation.js` 末尾追加。把 `zombie-system.js:199-266` 的 `moveAxis` / `tryStepUp` / `physicsStep` **逐行搬过来**，只把三处硬编码换成 `box` 字段：
- `collides(state, world)` → `aabbCollidesAt(world, ...state.position, box.halfWidth, box.height)`
- `ZOMBIE_MAX_STEP` → `box.maxStep`
- `GRAVITY` → `box.gravity`

⚠️ **三条载荷性细节一个字不改**（原注释一并搬过来）：
① `physicsStepAabb` 里**竖直轴先走**（`onGround` 要先算出来，水平轴的 step-up 依赖它）；
② 水平轴撞墙**不清零速度**（AI 意图 20Hz 才刷新，清零会让实体在两次刷新间卡死），竖直轴必须清零；
③ `tryStepUpAabb` 的门控是 `!state.onGround && state.velocity[1] > 0` 才拒绝（下落中允许上台阶）。

然后 `zombie-system.js` 的三个私有函数改成一行转调，传丧尸 box（`gravity: -24.0` 保留原 `GRAVITY` 常量）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx playwright test tests/unit-fast.spec.mjs`
Expected: PASS

- [ ] **Step 5: 跑既有消费方 spec 证明零回归**

Run: `npx playwright test tests/zombies.spec.mjs tests/ignis.spec.mjs tests/guardian.spec.mjs`
Expected: 全部 PASS（这三个 spec 覆盖 `zombie-navigation.js` 的全部消费方）

- [ ] **Step 6: Commit**

```bash
git add src/entities/zombies/zombie-navigation.js src/entities/zombies/zombie-system.js src/tests/test-zombies.js
git commit -m "refactor(entities): 物理三件提取为参数化共用实现（丧尸行为逐位不变）"
```

---

### Task 2: 士兵玩法数值表

**Files:**
- Create: `src/entities/soldiers/soldier-config.js`
- Create: `src/tests/test-soldier-config.js`
- Modify: `src/tests/index.html`（加一行 import）
- Modify: `tools/test-tiers.mjs`（`UNIT_NODE_SAFE` 加 `'test-soldier-config.js'`）

**Interfaces:**
- Produces:
  ```js
  export const SOLDIER_TYPE = 'soldier';
  export const SOLDIER = Object.freeze({
    maxAlive: 10, health: 100, width: 0.6, height: 1.8, flashMs: 200,
    deadLingerSeconds: 1.2, maxStep: 1.0, gravity: -24.0,
  });
  export const SOLDIER_AI = Object.freeze({
    aiPeriod: 0.05, patrolSpeed: 1.5, searchSpeed: 2.8, combatSpeed: 4.0,
    sightRangePatrol: 27, sightRangeSearch: 34, fovCosPatrol: 0.42, fovCosSearch: 0.1,
    combatLosRange: 60, standoffMin: 8, standoffMax: 20,
    towardFar: 1.5, towardNear: -1.5,
    strafeFlipMin: 0.9, strafeFlipMax: 2.0, strafeReach: 2,
    peekStandMin: 1.6, peekStandMax: 2.8, peekCrouchMin: 0.8, peekCrouchMax: 1.9,
    crouchDrop: 0.44, eyeYStand: 1.56, eyeYCrouch: 1.0,
    awarenessDecayPerSecond: 0.28, searchSeconds: 7, loseSightToSearchSeconds: 12,
    patrolWaitMin: 1.5, patrolWaitMax: 4, patrolRadius: 3,
    stuckSeconds: 0.7, stuckDistance: 0.25,
    alertRadius: 34, alertDelayMin: 0.5, alertDelayMax: 1.4, alertDelayPerBlock: 0.03,
    hearRadius: 48, hearSearchSeconds: 6, hearAwarenessFloor: 0.45,
    advancerPeriod: 2, advancerSinceSeconds: 2.5,
    turnRateCombat: 9, turnRateIdle: 4.5,
  });
  export const SOLDIER_SHOT = Object.freeze({
    playerDamage: 2, burstMin: 3, burstMax: 6, shotInterval: 0.105,
    burstGapLosMin: 0.8, burstGapLosMax: 1.7, burstGapBlindMin: 1.4, burstGapBlindMax: 2.6,
    maxConcurrentBursts: 2, burstBusyGapMin: 0.2, burstBusyGapMax: 0.5,
    accuracyFirst: 0.4, accuracyRest: 0.66,
    accuracyPerBlock: 0.011, accuracyPerSpeed: 0.03, accuracyAirPenalty: 0.12,
    accuracyMin: 0.06, accuracyMax: 0.82,
    missRadiusMin: 0.5, missRadiusRange: 1.1, missYMin: 0.4, missYRange: 1.6,
    fireYawTolerance: 0.35, fireCrouchMax: 0.35,
    suppressSinceMin: 0.6, suppressSinceMax: 8,
    maxDistance: 80, reactionMin: 0.45, reactionMax: 0.85,
    muzzleLocal: Object.freeze([0.07, 0.39, 0.98]),   // torso 局部（上游同值）
    torsoPivotY: 1.0,                                 // torso 相对 body 的高度
  });
  export const SOLDIER_TRACER = Object.freeze({
    color: Object.freeze([12, 3.5, 1.5]), speed: 170, width: 0.013,
  });
  export const SOLDIER_GAIT = Object.freeze({
    phasePerBlock: 2.6, thighSwing: 0.62, shinSwing: 0.9,
    crouchThighL: -1.25, crouchThighR: -0.35, crouchShinL: 1.75, crouchShinR: 1.6,
    bobAmplitude: 0.03, torsoRecoilPerShot: 0.03, aimPitchMin: -0.7, aimPitchMax: 0.9,
  });
  export const SOLDIER_STEERING = Object.freeze({
    probeDistance: 1.2, anglesDeg: Object.freeze([22.5, 45, 67.5, 90]),
  });
  export function soldierEntityIdFor(slot) { return `s${slot}`; }   // 与丧尸 z0~z19 同手法
  export function soldierAwarenessRate(dist, sprinting, searching) -> number
  export function soldierEyeY(crouch) -> number      // lerp(1.56, 1.0, crouch)
  export function soldierMuzzleWorld(position, yaw, crouch) -> [x,y,z]
  ```

- [ ] **Step 1: 写失败测试**

`src/tests/test-soldier-config.js`，照 `test-guardian-config.js` 的结构（`import { test } from './runner.js'` + `assertEqual/assertTrue`）。四组断言：

```js
test('士兵: 体形与丧尸逐位同尺寸（复用寻路缺省 box 的前提）', () => {
  assertEqual(SOLDIER.width, ZOMBIE.width);
  assertEqual(SOLDIER.height, ZOMBIE.height);
  assertEqual(SOLDIER.maxStep, ZOMBIE_MAX_STEP);
});
test('士兵: 上限 10、血量 100、留尸 1.2s（用户裁定）', () => {
  assertEqual(SOLDIER.maxAlive, 10);
  assertEqual(SOLDIER.health, 100);
  assertEqual(SOLDIER.deadLingerSeconds, 1.2);
});
test('士兵: 每发扣玩家 2 血（用户裁定）', () => {
  assertEqual(SOLDIER_SHOT.playerDamage, 2);
});
test('士兵: 距离环落在开火射程内（否则站定了打不到）', () => {
  assertTrue(SOLDIER_AI.standoffMax < SOLDIER_AI.combatLosRange);
  assertTrue(SOLDIER_AI.standoffMin < SOLDIER_AI.standoffMax);
});
test('士兵: awareness 速率四档 + 疾跑/search 倍率（上游逐值）', () => {
  assertEqual(soldierAwarenessRate(5, false, false), 4.2);
  assertEqual(soldierAwarenessRate(10, false, false), 1.7);
  assertEqual(soldierAwarenessRate(18, false, false), 0.9);
  assertEqual(soldierAwarenessRate(25, false, false), 0.5);
  assertEqual(soldierAwarenessRate(10, true, false), 1.7 * 1.5);
  assertEqual(soldierAwarenessRate(10, false, true), 1.7 * 1.8);
});
test('士兵: 枪口世界坐标随 yaw 旋转、随蹲下降低', () => {
  const stand = soldierMuzzleWorld([0, 0, 0], 0, 0);
  const crouch = soldierMuzzleWorld([0, 0, 0], 0, 1);
  assertTrue(stand[1] - crouch[1] > 0.4, '蹲下枪口必须降低');
  // yaw=π/2 时前向 +X ⇒ 枪口 x 显著为正、z 近 0
  const side = soldierMuzzleWorld([0, 0, 0], Math.PI / 2, 0);
  assertTrue(side[0] > 0.9 && Math.abs(side[2]) < 0.1);
});
```

⚠️ `soldierMuzzleWorld` 的 yaw→前向口径**必须与丧尸一致**：前向 = `(sin yaw, cos yaw)`（`yaw = atan2(vx,vz)`），**不是** Boss 那套 `(-sin,-cos)`。用错一侧的形态是「士兵背对玩家开枪」。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx playwright test tests/unit-fast.spec.mjs`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 实现 config**

按上面 Interfaces 的字段与值建表，全部 `Object.freeze`。三个纯函数：
- `soldierAwarenessRate`：四档距离查表 × `(sprinting ? 1.5 : 1)` × `(searching ? 1.8 : 1)`
- `soldierEyeY`：`eyeYStand + (eyeYCrouch - eyeYStand) * crouch`
- `soldierMuzzleWorld`：`muzzleLocal` 先加 `torsoPivotY`，再减 `crouch × crouchDrop`，绕 Y 转 yaw（`x' = lx·cos + lz·sin`，`z' = -lx·sin + lz·cos`，与 `guardianAabbFor` 同式），最后加 position

每个常量上方写一行出处注释（上游 `enemies.js` 的哪一行 / 哪条用户裁定）。

- [ ] **Step 4: 注册并跑测试**

`src/tests/index.html` 加 `import './test-soldier-config.js';`；`tools/test-tiers.mjs` 的 `UNIT_NODE_SAFE` 加 `'test-soldier-config.js'`（本文件无 DOM 依赖，可 Node 跑）。

Run: `npm run check && node tools/run-unit-node.mjs`
Expected: check exit 0（测试注册与分档双向钉住通过）；Node 单测全绿

- [ ] **Step 5: Commit**

```bash
git add src/entities/soldiers/soldier-config.js src/tests/test-soldier-config.js src/tests/index.html tools/test-tiers.mjs
git commit -m "feat(soldier): 玩法数值唯一权威表"
```

---

### Task 3: 开火判定纯函数

**Files:**
- Create: `src/entities/soldiers/soldier-shooting.js`
- Create: `src/tests/test-soldier-shooting.js`
- Modify: `src/tests/index.html`、`tools/test-tiers.mjs`（同 Task 2 Step 4 手法）

**Interfaces:**
- Consumes: `SOLDIER_SHOT`（Task 2）；既有 `raycastVoxel(world, origin, dir, maxDist, occludes)`、`raycastAabbSlab(state, origin, dir, maxDist, aabb)`、`isProjectileOccluding(id, registry)`
- Produces:
  ```js
  soldierHitChance({accuracy, distance, playerSpeed, playerGrounded}) -> number
  soldierMissPoint(playerPos, rand) -> [x,y,z]
  judgeSoldierShot({muzzle, target, world, registry, player, maxDistance})
    -> {end:[x,y,z], normal:[x,y,z]|null, hitPlayer:boolean, blockPos:[x,y,z]|null}
  // player = {position:[x,y,z], aabb:{min,max}} | null（装配层注入，火球先例）
  // target = 期望弹着点（命中骰子通过时是玩家眼位下方 0.3，否则是 soldierMissPoint）
  ```

- [ ] **Step 1: 写失败测试**

```js
test('士兵命中率: 上游公式逐项 + 两端钳制', () => {
  // accuracy 0.66、距离 10、速度 0、着地 ⇒ 0.66 − 0.11 = 0.55
  assertEqual(soldierHitChance({accuracy:0.66, distance:10, playerSpeed:0, playerGrounded:true}), 0.55);
  // 腾空扣 0.12
  assertEqual(soldierHitChance({accuracy:0.66, distance:10, playerSpeed:0, playerGrounded:false}), 0.43);
  // 远距 + 高速 ⇒ 钳到下界 0.06（不是负数）
  assertEqual(soldierHitChance({accuracy:0.4, distance:100, playerSpeed:8, playerGrounded:false}), 0.06);
  // 贴脸 ⇒ 钳到上界 0.82（不是 1）
  assertEqual(soldierHitChance({accuracy:0.99, distance:0, playerSpeed:0, playerGrounded:true}), 0.82);
});

test('士兵弹道: 开阔地命中玩家盒', () => { /* 玩家在原点、枪口在 (0,1.4,5) 朝 −Z ⇒ hitPlayer true */ });

test('士兵弹道: 实心墙挡在中间 ⇒ 不打玩家（Review Focus 3）', () => {
  // 在 z=2 砌一堵 stone 墙；断言 hitPlayer === false 且 blockPos 非 null
  // 且 end 落在墙面上（z ≈ 2.5 侧），不是玩家身上
});

test('士兵弹道: 玻璃挡不住（isProjectileOccluding 口径，与炮塔同源）', () => {
  // glass_block 是 solid=1 opaque=0 ⇒ 穿透。⚠️ 只测树叶抓不到这条（树叶两个判据都挡）
});

test('士兵弹道: 超距不判定', () => { /* maxDistance 之外的玩家 ⇒ hitPlayer false */ });

test('士兵散布点: 落在玩家周围环形域内（上游 0.5~1.6）', () => {
  // 注入定值 rand，断言水平距离 ∈ [0.5, 1.6]、y ∈ [pos.y+0.4, pos.y+2.0]
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node tools/run-unit-node.mjs`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 实现三个纯函数**

`judgeSoldierShot` 的顺序（**载荷性**）：
1. `dir = normalize(target − muzzle)`；
2. `raycastVoxel(world, muzzle, dir, maxDistance, id => isProjectileOccluding(id, registry))` —— ⚠️ 判 `.hit` 不是判对象本身（未命中返回 `{hit:false}` 是 truthy）；
3. 玩家在 `player` 非 null 时走 `raycastAabbSlab({position: player.position}, muzzle, dir, maxDistance, player.aabb)`；
4. **方块距离严格小于玩家距离时按方块优先**（与 `_queryEntityHit` 同口径）；
5. `end` 取更近者的命中点；都没命中则取 `muzzle + dir × maxDistance`。

⚠️ **本函数不掷骰子、不扣血** —— 骰子在 Agent 里（它要跨帧记 `firstBurst`），扣血在装配层。

- [ ] **Step 4: 注册并跑测试**

Run: `npm run check && node tools/run-unit-node.mjs`
Expected: 全绿

- [ ] **Step 5: 负向验证 N9（去掉 DDA）**

用 `edit` 把第 2 步的 DDA 判定改成恒不命中，**读回源码确认注入落地**，跑 `node tools/run-unit-node.mjs` ⇒ 不穿墙用例必须 FAIL。用 `cp` 副本还原。

- [ ] **Step 6: Commit**

```bash
git add src/entities/soldiers/soldier-shooting.js src/tests/test-soldier-shooting.js src/tests/index.html tools/test-tiers.mjs
git commit -m "feat(soldier): 开火判定纯函数（命中率/散布/弹道遮挡）"
```

---

### Task 4: 士兵 Agent 与 Service

**Files:**
- Create: `src/entities/soldiers/soldier-agent.js`
- Create: `src/entities/soldiers/soldier-system.js`
- Create: `src/tests/test-soldier-agent.js`、`src/tests/test-soldier-system.js`
- Modify: `src/tests/index.html`、`tools/test-tiers.mjs`（同 Task 2 Step 4 手法；`UNIT_NODE_SAFE` 加 `'test-soldier-agent.js'` 与 `'test-soldier-system.js'` —— 两者只依赖同构层，零 three）

**Interfaces:**
- Consumes: Task 1 的 `physicsStepAabb`；Task 2 的全部常量；Task 3 的 `soldierHitChance` / `soldierMissPoint`；既有 `PathCache` / `decideStep` / `memoryFor` / `steerIntentAabb` / `aabbCollidesAt` / `displaceGroundEntity` / `hasLineOfSight` / `normalizePosition` / `raycastAabbSlab`
- Produces:
  ```js
  export const SOLDIER_AABB = Object.freeze({min:[-0.3,0,-0.3], max:[0.3,1.8,0.3]});
  export class SoldierAgent {
    constructor({rng = Math.random})
    update(state, dt, ctx) -> object   // 全新 state 各字段
  }
  export const soldierDefinition = Object.freeze({create, update, raycastAabb, serialize, deserialize});
  export class SoldierService {
    constructor({entities, world, maxAlive = SOLDIER.maxAlive, rng = Math.random,
                 onSpawn, onDespawn, onKnockback})
    spawn(position, {source}?) -> string|null
    get(id) -> state|null
    count() -> number                  // ⚠️ 只数 !state.dead
    activeEntities() -> Entity[]       // 含留尸（渲染要画它）
    damage(id, amount, nowMs) -> {dead:boolean, health:number}|null
    knockback(id, dx, dz) -> boolean
    update(dt, {playerPosition, nowMs}) -> void      // 寻路拍 + 班组节拍
    alertNearby(srcId, nowMs) -> void
    hearShot(pos, nowMs) -> void
    lastKnown -> [x,y,z]|null
    lastSeenAny -> number              // ms
    despawnColumn(columnKey) -> number
    dispose() -> void
    debugState() -> {alive, dead, bursting, advancerId, phases}
  }
  ```
  state 形状（`createState` 白名单，**每个跨帧量都必须在内**）：
  ```
  position, velocity, yaw, aimPitch, health, flashedUntil, mode,
  awareness, crouch, crouching, peekT, strafe, strafeT, walkPhase,
  burst, shotT, nextBurst, firstBurst, reaction, alertDelay,
  lastSeen, searchT, patrolWait, patrolAnchor, patrolTarget,
  losTimer, losVisible, stuckT, stuckAnchor, deadT, dead, fallDir,
  navDir, navMode, needsPath, onGround, source, shotRequest, _physAccum
  ```
  `mode ∈ {'patrol','combat','search'}`；`shotRequest = {muzzle, target, accuracy}|null`（瞬态）。

- [ ] **Step 1: 写 Agent 失败测试**

`src/tests/test-soldier-agent.js`，注入定值 rng。六组：

```js
test('士兵 Agent: awareness 累积到 1 才进 combat（不是一看见就打）', () => {
  // 距 10 格、有视线 ⇒ 1.7/s ⇒ 约 0.6s 后进 combat；0.3s 时仍是 patrol
});
test('士兵 Agent: 距离环 —— 远于 20 推进、8~20 侧向、近于 8 后退（Review Focus 2）', () => {
  // 三个初态各跑一拍，断言意图速度在「径向分量」上的符号：+ / ≈0 / −
  // ⚠️ 中段断言径向分量近 0 而不是「速度为 0」—— 侧向分量必须非零
});
test('士兵 Agent: 蹲下时移动意图为 0，且 peekT 到期切换蹲/站', () => {});
test('士兵 Agent: 点射 3~6 发、发间隔 0.105s、结束后 nextBurst ∈ [0.8,1.7]', () => {});
test('士兵 Agent: 12s 无视线转 search、再 7s 回 patrol', () => {});
test('士兵 Agent: 死亡后 deadT 累积，倒地进度驱动 fallDir', () => {});
test('士兵 Agent: 跨帧量不丢 —— 连跑 60 拍后 awareness/burst/_physAccum 单调合理', () => {
  // ⚠️ 这条专抓「createState 漏字段」：漏了会让每个机制每帧重置而数值全对
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node tools/run-unit-node.mjs`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 实现 Agent**

结构照 `guardian-boss-agent.js`（但不继承 `BossAgent` —— 士兵不是 Boss，且 yaw 口径相反）。每帧顺序：
1. 取全部跨帧量（缺省值兜底）；
2. `dead` 分支：只累积 `deadT`，返回（不移动不开火）；
3. 视线缓存 10Hz（`losTimer`），`hasLineOfSight` 从 `eyeY(crouch)` 到玩家胸 `+1.2`；
4. 状态转移（awareness / combat / search / patrol，按 spec §5.3 表）；
5. 移动意图（距离环 + strafe），过 `steerIntentAabb`，`needsPath` 时采纳 `state.navDir`；
6. yaw 缓动（`combat ? turnRateCombat : turnRateIdle`）、`aimPitch` 缓动；
7. 点射（`bursting < maxConcurrentBursts` 由 ctx 传入）⇒ 写 `shotRequest`；
8. `crouch` 向 `crouching && !moving ? 1 : 0` 缓动；`walkPhase += speed × dt × phasePerBlock`。

⚠️ **`ctx.bursting` 与 `ctx.lastKnown` / `ctx.lastSeenAny` 由 Service 传入**（班组共享情报，不是每只一份）。

- [ ] **Step 4: 实现 definition 与 Service**

`definition.update`：调 Agent 拿新 state → `createState` → 跑 `physicsStepAabb`（60Hz accumulator，`n < 5` 上限）。⚠️ **`dead` 时也跑物理**（尸体要落地），但不跑 AI 移动意图（velocity 水平清零）。

`raycastAabb`：`state.dead` 时返回 null（不可鞭尸）。

`Service.spawn`：四道门照 `ZombieService.spawn`（上限 → column 已加载 → 脚格 air → 头格 air → 脚下 solid），slot 池 0~9，id = `soldierEntityIdFor(slot)`。

`Service.count()`：遍历 `entities.entities()` 数 `type === SOLDIER_TYPE && !state.dead`。⚠️ **不用 `entities.count()`**（它含留尸）。

`Service.update`：20Hz 寻路拍（只给 `needsPath` 的跑 `decideStep`）+ 每 2s 选 advancer + 统计 `bursting`，然后把 `{bursting, lastKnown, lastSeenAny, advancerId}` 存起来供 Agent 的 ctx 用。

`alertNearby` / `hearShot`：按 spec §5.3 的半径与延迟写同伴 state。

- [ ] **Step 5: 写 Service 测试并跑**

`src/tests/test-soldier-system.js`，fixture 照 `makeZombieFixture`（真实 `WorldData` + 全空气 + 单点支撑）：

```js
test('士兵 Service: 上限 10，第 11 只返回 null', () => {});
test('士兵 Service: 伤害与红闪，致死置 dead 但不立即 despawn', () => {});
test('士兵 Service: 留尸 1.2s 后才 despawn，且期间不可被射线击中', () => {});
test('士兵 Service: 留尸期上限不占名额（Review Focus 1）', () => {
  // 召满 10 → 打死 1 只 → 立刻再 spawn 必须成功（此时 entities.count 仍是 10）
  // ⚠️ 这条专抓「用 entities.count 判上限」
});
test('士兵 Service: 三条回收路径都归还 slot（死亡/卸载/dispose）', () => {});
test('士兵 Service: alertNearby 只影响 34 格内非 combat 同伴', () => {});
test('士兵 Service: hearShot 让 48 格内 patrol 士兵转 search', () => {});
test('士兵 Service: 并发点射统计 ≤ 2', () => {});
```

Run: `npm run check && node tools/run-unit-node.mjs`
Expected: 全绿

- [ ] **Step 6: 负向验证 N7 / N8 / N10**

逐条用 `edit` 注入（`alertNearby` 空实现 / `hearShot` 空实现 / 死亡立即 despawn），每次**读回确认**后跑 Node 单测，对应用例必须 FAIL；`cp` 还原。

- [ ] **Step 7: 负向验证 N13（留尸期上限）—— Review Focus 1**

把 `Service.count()` 改成 `this.entities.count(SOLDIER_TYPE)`，读回确认，跑 Node 单测 ⇒ 「留尸期上限不占名额」必须 FAIL。`cp` 还原。

> 编号说明：spec §8.4 的 N1~N12 是既定编号，**N13 是本计划自审时新增的一条**（spec 未列，因为它是我写计划时才发现的陷阱）。

- [ ] **Step 8: Commit**

```bash
git add src/entities/soldiers/soldier-agent.js src/entities/soldiers/soldier-system.js src/tests/test-soldier-agent.js src/tests/test-soldier-system.js src/tests/index.html tools/test-tiers.mjs
git commit -m "feat(soldier): Agent 状态机与 Service（班组联动/留尸/上限）"
```

---

### Task 5: 士兵几何与渲染器

**Files:**
- Create: `src/render/soldier-geometry.js`、`src/render/soldier-renderer.js`
- Modify: `src/render/turret-metal.js`（加 `vertexColor` / `glowAttribute` 可选分支）
- Create: `src/tests/test-soldier-render.js`
- Modify: `src/tests/index.html`、`tools/test-tiers.mjs`（`UNIT_NODE_SAFE` 加 `'test-soldier-render.js'` —— 既有 `test-guardian-render.js` / `test-dragon-render.js` 均在白名单，three 在 Node 侧有解析映射）

**Interfaces:**
- Consumes: Task 2 的 `SOLDIER` / `SOLDIER_GAIT` / `SOLDIER_AI`；既有 `createTurretMetalMaterial`、`StepLift`、`KnockbackEase`、`mergeGeometries`
- Produces:
  ```js
  // soldier-geometry.js
  export const SOLDIER_COLORS = Object.freeze({ARMOR:0x353c45, PLATE:0x4a545f, CLOTH:0x262b32, BLACK:0x15171a});
  export const SOLDIER_PARTS = Object.freeze(['pelvis','torso','head','thighL','thighR','shinL','shinR']);
  // ⚠️ 7 个渲染部件，但只有 5 份 unique 几何（左右腿各共用一份）
  export function buildSoldierGeometries() -> {pelvis, torso, head, thigh, shin}  // 5 份
  export const SOLDIER_GEOMETRY_OF = Object.freeze({
    pelvis:'pelvis', torso:'torso', head:'head',
    thighL:'thigh', thighR:'thigh', shinL:'shin', shinR:'shin',
  });
  export const SOLDIER_PIVOTS = Object.freeze({ /* 各部件相对父级的局部偏移 */ });
  // soldier-renderer.js
  export class SoldierRenderer {
    constructor({scene, maxActive = SOLDIER.maxAlive, sunDirection, sunStrength, sunColor})
    sync(entities, nowMs) -> void      // entities = soldiers.activeEntities()（含留尸）
    slotOf(id) -> number|null
    activeCount() -> number
    renderYOf(slot) -> number
    dispose() -> void
    meshes -> Record<part, THREE.InstancedMesh>
  }
  // turret-metal.js 新增可选参数（缺省 undefined ⇒ 行为逐位不变）
  createTurretMetalMaterial({..., vertexColor?:boolean, glowAttribute?:string})
  ```

- [ ] **Step 1: 写失败测试**

```js
test('士兵几何: 5 份 unique 几何齐全且顶点数非零，7 个部件都能映射到', () => {
  const geos = buildSoldierGeometries();
  for (const k of ['pelvis','torso','head','thigh','shin']) {
    assertTrue(geos[k].attributes.position.count > 0, `${k} 顶点数非零`);
  }
  for (const p of SOLDIER_PARTS) assertTrue(!!geos[SOLDIER_GEOMETRY_OF[p]], `${p} 有几何`);
});
test('士兵几何: 逐顶点色/aSurf/aGlow 三属性齐全且长度一致', () => {
  for (const g of Object.values(buildSoldierGeometries())) {
    const n = g.attributes.position.count;
    assertEqual(g.attributes.color.count, n);
    assertEqual(g.attributes.aSurf.count, n);
    assertEqual(g.attributes.aGlow.count, n);
  }
});
test('士兵几何: 护目镜与胸灯有非零 aGlow（自发光载体）', () => {
  const geos = buildSoldierGeometries();
  const maxGlow = (g) => Math.max(...g.attributes.aGlow.array);
  assertTrue(maxGlow(geos.head) > 0.5, '护目镜 e=4.5 ⇒ aGlow≈0.56');
  assertTrue(maxGlow(geos.torso) > 0.2, '胸灯 e=2.5 ⇒ aGlow≈0.31');
});
test('士兵渲染: 缺省容量从 SOLDIER.maxAlive 派生（不传 maxActive）', () => {
  const r = new SoldierRenderer({ scene: new THREE.Scene() });   // 刻意不传 maxActive
  for (const p of SOLDIER_PARTS) assertEqual(r.meshes[p].count, SOLDIER.maxAlive);
});
test('士兵渲染: 空载 7 个 mesh 全 visible=false', () => {
  const r = new SoldierRenderer({ scene: new THREE.Scene() });
  r.sync([], 0);
  for (const p of SOLDIER_PARTS) assertEqual(r.meshes[p].visible, false);
});
test('士兵渲染: 蹲下时渲染 y 降低约 crouchDrop', () => {});
test('士兵渲染: 留尸期播倒地（body 绕 X 倾倒），1.2s 后 slot 归还', () => {});
test('士兵渲染: 红闪走 instanceColor 且逐实例独立', () => {
  // 两只士兵一只受伤 ⇒ 只有它的 instanceColor 是红
});
test('炮塔材质: vertexColor 缺省关闭时与改动前逐位等价', () => {});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx playwright test tests/unit-fast.spec.mjs`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 实现几何**

照 `carbine-geometry.js` 的 `Parts` 类（`box` / `boxRotX` / `capsule` / `add` / `build`），把上游 `soldierGeometries()` **逐行**搬过来：pelvis 4 box、torso 15 box + 1 add + 4 capsule、head 4 box + 1 sphere、thigh 1 box + 1 capsule、shin 2 box + 1 capsule。左右腿共用同一份几何（两个 InstancedMesh 引用它）。

`SOLDIER_PIVOTS` 取上游构造器的 `mk(...)` 位置：pelvis `(0,0.94,0)`、torso `(0,1.0,0)`、head 相对 torso `(0,0.6,0)`、thigh `(±0.1,0.9,0)`、shin 相对 thigh `(0,-0.44,0)`。

- [ ] **Step 4: 给炮塔材质加两个可选分支**

`vertexColor: true` ⇒ `base = attribute('color','vec3')`（**不是** `vertexColors:true` + `colorNode` —— three 把顶点色乘在 colorNode 之后，高光会用材质基色染色）；
`glowAttribute: 'aGlow'` ⇒ `colorNode` 末尾 `.add(base.mul(attribute(glowAttribute)).mul(k))`。

⚠️ 两个参数缺省 undefined 时**一行不走新分支**，炮塔调用点不改。

- [ ] **Step 5: 实现渲染器**

7 个 InstancedMesh，容量 `SOLDIER.maxAlive`，共用一份金属材质（`vertexColor:true, glowAttribute:'aGlow'`）。矩阵链照 `zombie-renderer.js` 的 `_parent × _local`：`root(T(position + lift − knock) · R_y(yaw)) → body(T(0, −crouch×crouchDrop − bob, 0) · R_x(死亡倾倒)) → 部件`。

红闪走 `setColorAt`（基色白）。`StepLift` / `KnockbackEase` 逐 slot 一份，实例复用时重置（照 `guardian-renderer.js` 的 `inst.entityId !== entity.id` 分支）。

- [ ] **Step 6: 注册并跑测试 + 炮塔零回归**

Run: `npm run check && npx playwright test tests/unit-fast.spec.mjs tests/turret-render.spec.mjs`
Expected: 全绿

- [ ] **Step 7: Commit**

```bash
git add src/render/soldier-geometry.js src/render/soldier-renderer.js src/render/turret-metal.js src/tests/test-soldier-render.js src/tests/index.html tools/test-tiers.mjs
git commit -m "feat(soldier): 7 部件实例渲染 + 炮塔金属材质加逐顶点色分支"
```

---

### Task 6: 巢穴交替产出

**Files:**
- Modify: `src/entities/zombie-nests/nest-config.js`（加 `spawnOrder`）
- Modify: `src/entities/zombie-nests/zombie-nest-controller.js:76-95`（`update` 方法）
- Modify: `src/tests/test-zombie-nests.js`（追加用例，既有 20 余条不改）

**Interfaces:**
- Consumes: Task 4 的 `SoldierService.spawn(position, {source}) -> string|null`
- Produces: `NEST.spawnOrder = Object.freeze(['soldier','zombie'])`；controller 构造器新增可选 `soldiers` 依赖（缺省 null ⇒ 退化为只产丧尸）

- [ ] **Step 1: 写失败测试**

在 `src/tests/test-zombie-nests.js` 追加（复用既有 `makeSpawnFixture`，给它加一个 fake `soldiers`）：

```js
test('巢穴交替: 连续四次到期产出 soldier/zombie/soldier/zombie（Review Focus 4）', () => {
  // 每 8000ms 调一次 update，断言两个 fake 的 spawnCalls 交替
});
test('巢穴回落: 士兵满额（spawn 返回 null）时改产丧尸', () => {});
test('巢穴回落: 丧尸满额时改产士兵', () => {});
test('巢穴: 两者都满 ⇒ 不产出但仍写回 lastSpawnAt', () => {});
test('巢穴: soldiers 未注入时退化为只产丧尸（既有 fixture 零回归）', () => {});
test('巢穴: _spawnIndex 只在真的产出一只后推进', () => {
  // 满额那拍不推进 ⇒ 恢复后节奏不乱
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node tools/run-unit-node.mjs`
Expected: FAIL —— 交替用例读到全是丧尸

- [ ] **Step 3: 实现交替与回落**

`nest-config.js` 加 `spawnOrder`。controller 的 `update` 改为：找到合法位置后，按 `_spawnIndex % spawnOrder.length` 取首选，试 spawn；返回 null 则试另一种；都 null 则不产出。**只在成功产出后 `_spawnIndex++`**。无论成败都调既有的 `_writeBackSpawnClock`。

⚠️ **`_findSpawnPosition` 与 8 秒节流一行不改**；`soldiers` 缺省 null 时首选恒为 zombie。

- [ ] **Step 4: 跑测试确认通过 + 既有零回归**

Run: `npm run check && node tools/run-unit-node.mjs && npx playwright test tests/zombie-nests.spec.mjs`
Expected: 全绿

- [ ] **Step 5: 负向验证 N3 / N4**

注入「恒产丧尸」与「去掉回落分支」，各读回确认后跑 Node 单测，对应用例必须 FAIL；`cp` 还原。

- [ ] **Step 6: Commit**

```bash
git add src/entities/zombie-nests/nest-config.js src/entities/zombie-nests/zombie-nest-controller.js src/tests/test-zombie-nests.js
git commit -m "feat(nest): 巢穴交替产出士兵与丧尸，满额回落"
```

---

### Task 7: 枪口火光材质提取 + CarbineFx 公开接口

**Files:**
- Create: `src/render/muzzle-flash-material.js`（从 `carbine-view.js:158-218` 提取）
- Create: `src/render/soldier-muzzle-fx.js`
- Modify: `src/render/carbine-view.js`（改 import）
- Modify: `src/render/carbine-fx.js`（三个薄方法 + `clear` 可选参数）
- Modify: `src/tests/test-carbine-fx.js`（追加用例）

**Interfaces:**
- Produces:
  ```js
  // muzzle-flash-material.js
  export function createMuzzleFlashMaterial() -> {material, uniforms:{uSeed, uPower}}
  // soldier-muzzle-fx.js
  export class SoldierMuzzleFx {
    constructor({scene, capacity = 4})
    fire(position, nowMs) -> void
    update(nowMs) -> void
    activeCount() -> number
    meshes -> THREE.Mesh[]
    dispose() -> void
  }
  // carbine-fx.js 新增
  spawnTracer(from, to, cfg, nowMs) -> void   // ⚠️ 收 ms，内部转 tSec = nowMs/1000 再调 _fireTracer
  spawnSparksAt(seeds, floorY) -> void
  spawnPuffAt(o) -> void
  clear({keepWorldFx = false} = {}) -> void   // 缺省行为逐位不变
  ```

- [ ] **Step 1: 写失败测试**

```js
test('CarbineFx: 三个公开薄方法与私有实现同源（调用后 counts 增长）', () => {});
test('CarbineFx: clear() 缺省仍全清（既有用例零回归）', () => {});
test('CarbineFx: clear({keepWorldFx:true}) 只清弹壳/弹孔，曳光/火花/烟保留', () => {});
test('士兵火光池: fire 后 activeCount>0，寿命结束后归 0 且 visible=false', () => {});
test('火光材质: 提取后只有一份实现（carbine-view 不再自己定义）', () => {
  // 判据落在**源码**而非运行时对象：读 carbine-view.js 文本，
  // 断言它 import 了 createMuzzleFlashMaterial 且不再含 `function makeFlashMaterial`
  // ⚠️ 不写「两个 material 构造参数一致」—— 那需要读 TSL 内部结构，无稳定口径
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node tools/run-unit-node.mjs`
Expected: FAIL —— 新模块不存在

- [ ] **Step 3: 提取火光材质**

把 `carbine-view.js:158-218` 的 `makeFlashMaterial` **整个函数体连同全部注释**搬到新文件，改名 `createMuzzleFlashMaterial` 并导出。`carbine-view.js` 改为 import 它，调用点 `const fl = createMuzzleFlashMaterial();`。

⚠️ **参数一个不改**（`uv()*2-1`、NormalBlending、`alpha = gain`、片元算径向、`lights=false`）—— 那五条都是像素实测标定过的。
⚠️ **varying 名 `vCarbFlashUv` 也不改**：改名本身无害，但会让既有调试探针与文档描述对不上号。

把 `carbine-view.js:158-218` 的 `makeFlashMaterial` **整个函数体连同全部注释**搬到新文件，改名 `createMuzzleFlashMaterial` 并导出。`carbine-view.js` 改为 import 它，调用点 `const fl = createMuzzleFlashMaterial();`。

⚠️ **参数一个不改**（`uv()*2-1`、NormalBlending、`alpha = gain`、片元算径向、`lights=false`）—— 那五条都是像素实测标定过的。

- [ ] **Step 4: 加三个薄方法 + clear 参数 + 火光池**

三个薄方法各一行转调。`clear({keepWorldFx})`：`keepWorldFx` 为 true 时跳过火花/烟/曳光三段清理与它们的计数归零，只清弹壳/弹孔。

`SoldierMuzzleFx`：容量 4 的 quad 池，形状照 `CARBINE_FLASH_QUADS`（星芒 + 两片十字 blade），寿命 0.045s，billboard 朝相机。

- [ ] **Step 5: 跑测试 + KV-9 零回归（Review Focus 5）**

Run: `npm run check && node tools/run-unit-node.mjs && npx playwright test tests/carbine.spec.mjs tests/carbine-flash-wet.spec.mjs tests/carbine-tracer-origin.spec.mjs`
Expected: 全绿（特别是 `carbine.spec:319` 的「切枪后 sparks===0」仍绿）

- [ ] **Step 6: Commit**

```bash
git add src/render/muzzle-flash-material.js src/render/soldier-muzzle-fx.js src/render/carbine-view.js src/render/carbine-fx.js src/tests/test-carbine-fx.js
git commit -m "refactor(render): 枪口火光材质提取共用 + CarbineFx 公开薄方法"
```

---

### Task 8: 装配、接线与 E2E

**Files:**
- Modify: `src/entities/entity-types.js`（`WEAPON_HITTABLE_TYPES` 加 `'soldier'`）
- Modify: `src/core/game.js`（装配段 + 7 处接线 + `_consumeSoldierShots` + `spawnSoldierNearPlayer` + dispose）
- Modify: `src/player/player.js`（`KeyC` + 两个注入 + 开火通知）
- Modify: `src/core/perf-hud.js`、`src/tests/test-perf.js`（文案）
- Modify: `src/tests/test-weapons.js:790-799`（四类型断言改五项）
- Modify: `tests/enemy-roster.mjs`（登记 soldier）
- Create: `tests/soldier.spec.mjs`
- Modify: `tools/test-tiers.mjs`（`ENTITY` 加 `'soldier'`）

**Interfaces:**
- Consumes: Task 2~7 的全部导出
- Produces: `Game.soldiers` / `Game.soldierRenderer` / `Game.soldierMuzzleFx` / `Game.spawnSoldierNearPlayer()` / `Game.soldiersDebugState()`

- [ ] **Step 1: 写 E2E 失败测试**

`tests/soldier.spec.mjs`，夹具照 `tests/enemy-wiring.spec.mjs`（`waitWorldReady` / `gotoOpenField` / `waitPlayerLanded` / `putPlayer`），seed 12345、`?vd=2`。用例：

```js
test('C 键召唤士兵，连按 11 次恰好 10 只', async ({page}) => {});
test('士兵 combat 态始终与玩家保持 6~24 格（Review Focus 2）', async ({page}) => {
  // 30s 采样距离，断言 min > 6 且 max < 24
});
test('士兵会蹲下也会站起（30s 内 crouch 既 >0.9 又 <0.1）', async ({page}) => {});
test('士兵子弹打玩家：命中后血量恰好 −2', async ({page}) => {
  // 注入定值 rng 让命中率骰子必过；等一次命中后同步读血量
});
test('士兵子弹不穿墙（Review Focus 3）', async ({page}) => {});
test('班组报警：一只进 combat ⇒ 34 格内同伴 2s 内也进 combat', async ({page}) => {});
test('听枪声：玩家开火 ⇒ 48 格内 patrol 士兵转 search', async ({page}) => {});
test('并发点射 ≤2', async ({page}) => {});
test('巢穴交替产出士兵与丧尸（Review Focus 4）', async ({page}) => {});
test('巢穴士兵满额时回落丧尸', async ({page}) => {});
test('全部现有武器都能击伤士兵', async ({page}) => {
  // 手枪/MAG7/加特林/剑/KV-9 各打一次，断言血量下降
});
test('TNT 半径内士兵掉血 50、半径外不掉、probe 对照不掉', async ({page}) => {});
test('draw call：无士兵 = 基线，有士兵 = 基线 + 7', async ({page}) => {});
test('Tier 4：士兵上屏 + 护目镜自发光 + 枪口火光暖色', async ({page}) => {});
test('Tier 4：士兵曳光上屏 —— 开火后同步立刻读 GPU 属性', async ({page}) => {
  // ⚠️ 曳光寿命 (L+段长)/170 ≈ 0.3s，但取样仍须同步：任何 await 都可能跨过它
  // 判据 = carbineFx.tracerGeo 的 aA/aB 属性里存在一条起点≈士兵枪口、终点≈弹着点的记录
  // （读真实 GPU 属性，不是「counts.tracers > 0」—— 后者对「画错位置」零判别力）
});
```

⚠️ **Tier 4 三条的口径**（spec §8.5）：固定机位 + 冻住五个动态源（玩家下落/海面/手臂/昼夜/viewBob+stepLift）+ **先藏掉自带同色的宿主**；火光取样必须**开火后同步立刻**（0.045s，任何 await 都会过期）；暖色判据量像素自身 `r > g`，不用差分计数。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx playwright test tests/soldier.spec.mjs`
Expected: FAIL —— `g.soldiers` undefined

- [ ] **Step 3: 装配**

`game.js` 在丧尸装配段之后加士兵段（renderer → service → registerType，顺序照丧尸：先 renderer 后 service，钩子闭包引用 renderer）。renderer 传 `renderWorld.materials.dayNight` 的三个 uniform 句柄（与炮塔同源）。

帧循环插入两处：
- `this.soldiers.update(dt, {playerPosition, nowMs})` 在 `entities.update` **之前**（与丧尸/焰魔/守卫同帧序）；
- `this._consumeSoldierShots(nowMs)` 在 `entities.update` **之后**（消费 `shotRequest`）；
- `this.soldierRenderer.sync(this.soldiers.activeEntities(), nowMs)` 与 `soldierMuzzleFx.update(nowMs)` 在渲染段。

`_consumeSoldierShots`：零分配门控 → 逐只取 `shotRequest` → 掷命中骰子 → `judgeSoldierShot` → 命中玩家则 `_damagePlayer(2, nowMs)` → 曳光/火花/火光 → 更新 `lastKnown`。

- [ ] **Step 4: 七处接线**

按 spec §3.3 表逐处加 soldier 分支：`damageEntity` / `knockbackEntity` / `_onEntityDeath`（`z_die` + 装甲灰爆散）/ `headY` / `_cinderBlast` 的 `half` / `_runTurretAi` 的 targets / `_damageEntitiesInRadius`（**改为遍历丧尸 + 士兵**）。

⚠️ **`bossAlive` 不加 soldier**（士兵不是 Boss，加了会拉起 Boss 战 BGM）。
⚠️ **`physics._collides` 不加 soldier**（10 个士兵会把玩家挤住）。

- [ ] **Step 5: C 键与文案**

`player.js` 加 `KeyC && !e.repeat && this._onSpawnSoldier`；`_applyWeaponEffect` 的枪类分支调 `this._onPlayerShot?.(pos)`。`perf-hud.js` 第三行改 `'Z：背包 | X：丧尸 | C：士兵 | R：换枪'`，同步改 `test-perf.js:161` 的断言。

- [ ] **Step 6: 名册与门禁**

`tests/enemy-roster.mjs` 加 `soldier: {service:'soldiers', semantics:'feet', height:SOLDIER.height, boss:false, blocksPlayer:false, deathSound:'z_die', burst:true}`。
`test-weapons.js` 的四类型断言改五项。`tools/test-tiers.mjs` 的 `ENTITY` 加 `'soldier'`。

- [ ] **Step 7: 跑最小充分集**

```bash
npm run check
node tools/run-unit-node.mjs
npx playwright test tests/soldier.spec.mjs tests/enemy-wiring.spec.mjs tests/enemy-roster.spec.mjs
npx playwright test tests/zombie-nests.spec.mjs tests/tnt.spec.mjs tests/player-flight.spec.mjs
```
Expected: 全绿

- [ ] **Step 8: 负向验证 N1 / N2 / N5 / N6 / N11 / N12**

逐条注入，每次读回确认后跑对应 spec，必须 FAIL；`cp` 还原。

| 编号 | 注入 | 应红用例 |
|---|---|---|
| N1 | `WEAPON_HITTABLE_TYPES` 去掉 `'soldier'` | 「全部现有武器都能击伤士兵」+ 接线门双向钉住 |
| N2 | `_damageEntitiesInRadius` 退回只遍历丧尸 | TNT 用例 |
| N5 | 距离环改成「直冲玩家」 | 距离环用例 |
| N6 | 去掉蹲起切换（`crouching` 恒 false） | 蹲起用例 |
| N11 | 渲染器空载不置 `visible=false` | draw call 基线用例 |
| N12 | `headY` / `half` 三元链漏 soldier | 接线门对应两项 |

⚠️ **N5 最关键**：它证明距离环判据真能区分方案 B 与「会开枪的丧尸」。

- [ ] **Step 9: 性能门禁**

Run: `npm run bench -- --check`
Expected: 通过（本次碰了每帧 Agent 与物理热路径）。⚠️ 若 frameP95 报回退，用**交替对照**判定而非单次测量（vsync 量子化噪声已知会误报）。

- [ ] **Step 10: Commit**

```bash
git add src/entities/entity-types.js src/core/game.js src/player/player.js src/core/perf-hud.js src/tests/test-perf.js src/tests/test-weapons.js tests/enemy-roster.mjs tests/soldier.spec.mjs tools/test-tiers.mjs
git commit -m "feat(soldier): 装配接线、C 键召唤、武器与 TNT 伤害、巢穴交替"
```

---

## 完成后的收尾

- [ ] 更新 `docs/roadmap.md` 版本表（新增一行，附实测证据：单测例数、spec 通过数、draw call 增量、bench 数字、负向验证条数）
- [ ] 把本轮新踩的坑追加进 `docs/pitfalls.md` 的对应小节（若有）
- [ ] ⚠️ **不要跑 `npm run bench` 不带 `--check`**（会重写冻结基线 `docs/m3-baseline.*`）