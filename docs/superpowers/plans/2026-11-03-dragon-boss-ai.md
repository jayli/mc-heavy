# 祭坛飞龙 AI 与火球攻击实施计划（v2.44）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给祭坛飞龙加 Boss 级智能 —— 发现玩家（视线未被实心不透明方块遮挡 + 水平距 ≤60）就追击，递近后按随机 5~10 秒间隔喷火球；玩家静止时飞跃玩家再盘旋回头；玩家脱离视线后返回轨道盘旋（盘旋半径正弦调制，不再死板画圆）。火球击中玩家或实体方块（含树叶/玻璃）即爆炸，破坏范围与开关口径与 TNT 完全一致；玩家暂不掉血。

**Architecture:** AI 抽成**独立的 Boss 智能体类层级**（用户指令：后续会有很多 Boss，每个都有自己的智能体）—— `BossAgent` 抽象基类收纳共用工具，`DragonBossAgent` 子类实现飞龙四态机，`dragonDefinition.update` 只做委托。Agent 只读 state 与 ctx、返回全新 state，**不生成实体、不改世界**（把开火意图写进 state 的 `fireRequest`，由 game.js 消费 —— 与矿车 `pendingPlayerLift` 同一先例）。火球是独立临时实体系统（不复用炮塔弹丸的数值与遮挡判据），爆炸从 `explodeTnt` 抽出 `_applyExplosion` 复用，**刻意绕开 TNT 的去重集合**。

**Tech Stack:** 纯 JavaScript ES2022 + JSDoc（无 TS、无 bundler）；three.js r185.1 WebGPU 后端；Playwright Tier 4 像素实测。

**Spec:** `docs/superpowers/specs/2026-11-03-dragon-boss-ai-design.md`

## Global Constraints

- **红线 1**：同一事实只有一份权威。AI 数值权威 = `dragon-config.js` 的 `DRAGON_AI` / `FIREBALL`；视线判据权威 = `turret-system.js` 的 `hasLineOfSight` / `isProjectileOccluding`；角度差权威 = `turret-system.js` 的 `shortestAngleDiff`；实体 AABB 射线权威 = `entity-types.js` 的 `raycastAabbSlab`；体素 DDA 权威 = `player/raycast.js` 的 `raycastVoxel`；爆炸范围权威 = `voxel/explosion.js` 的 `computeExplosion`；玩家尺寸权威 = `player/physics.js`。渲染层与单测都从这些派生，不写字面量。
- **红线 2**：龙是临时实体（`persistent: false`），位置**不进存档**。orbit 模式仍是 `(seed, 时间)` 纯函数；chase/attack/return 依赖玩家位置与随机冷却，本就非确定，可接受。
- **红线 3**：主线程每帧只做输入/物理/调度/上传/渲染。AI 每帧 O(1)；LOS 按 10Hz 缓存（60 格 × 多龙每帧全查太贵），但**开火瞬间做一次新鲜复查**。
- **红线 6**：实体命中唯一真相 = `raycastAabbSlab`；地形交互一律体素 DDA（`raycastVoxel`）。**禁止** `THREE.Raycaster` / `intersectObjects`。
- **红线 8/10**：`src/entities/**` 是同构层，**不得 import three、不得 import DOM、不得新建 Worker**（`check:arch` 的 `ISOMORPHIC_DIRS` 守）。新增文件头部必须带同构声明（`ISOMORPHIC_DECLARED` 正则匹配）。
- **entities/ 不得 import player/**（矿车先例）：玩家盒由 game.js 装配层读 `physics.playerHitboxLocal()` 后**注入** ctx。
- **资源路径**：一律走 `resourceUrl(...)`。禁止站点根绝对路径字面量（`check:arch` 的 `[资源 URL]` 零白名单挂掉式拦截）。
- **命名禁令**：不得出现 `RegionCache`、`safeBounds` 等 `FORBIDDEN_NAMES` 子串（子串匹配）。
- **时间基准**：一律 `performance.now()`，禁止 `Date.now()`。冷却用 **dt 倒计时**（不是绝对时间戳），从根上绕开混用陷阱。
- **门禁分层**（testing-policy §6）：Tier 1（纯函数/机制）必须 TDD（RED → 验证 RED → GREEN → 验证 GREEN）；Tier 4（GPU 渲染）必须像素实测，不宣称目视。
- **提交纪律**：每个 Task 结束提交一次，Conventional Commits，**不加 `--no-verify`**。

## Review Focus

spec 隐含、但最可能咬到玩家的五类失效（每条都在 owning task 里加了对应测试）：

1. **火球直接调 `explodeTnt` 污染去重集合**：火球炸过的格（不是 TNT）的键会永久留在 `_ignitingTnt` 里 → 之后玩家在同格放 TNT 引爆返回 false **静默不爆**。方块层面看不出，只有「先炸火球再放 TNT」的对照能抓。→ Task 5 的负向验证。
2. **火球遮挡判据误用 `isProjectileOccluding`**：玻璃 `opaqueTable=0` 会被那个判据放过 → 火球**穿过玻璃**继续飞（用户明确要求玻璃要挡）。而树叶是 `opaque:true` 会挡住 → 只测树叶的断言全绿。→ Task 4 必须单独钉玻璃。
3. **视线与火球遮挡是两个判据，混用会撕裂**：视线要 `solid && opaque`（用户说「实心不透明」），火球要 `solid`（用户说「包括树叶、玻璃等半透明方块」）。写成同一个 → 要么龙隔着玻璃看不见玩家，要么火球穿过玻璃。→ Task 2 与 Task 4 各自钉自己的判据。
4. **`wobbleAmp = 0` 时 yaw 不逐位退回 `π − θ`**：既有「yaw 是切线方向」用例（点积 > 0.99）会破，或更糟 —— 用例仍绿但龙的朝向与轨道切线错开（侧着身子飞）。→ Task 3 的退化断言（逐位相等，不是近似）。
5. **`fireRequest` 进了 serialize**：瞬态字段被写进 snapshot → 若将来龙改持久化，重启后会凭空喷一发火球；更直接的形态是 snapshot 里攒了一堆陈旧请求。→ Task 3 钉「serialize 输出不含 fireRequest」。

---

### Task 1: `BossAgent` 抽象基类 + AI 常量

**Tier:** 1（机制/架构）—— 必须 TDD。

**Files:**
- Create: `src/entities/bosses/boss-agent.js`
- Modify: `src/entities/dragons/dragon-config.js`（加 `DRAGON_AI`）
- Create: `src/tests/test-boss-agent.js`
- Modify: `src/tests/index.html`（注册新测试文件 —— 漏了 `check:data` 的 `[测试注册]` 会红）

**Interfaces:**

```js
// boss-agent.js —— 头部必须带同构声明（无 DOM、无 three、不新增 Worker）
import { hasLineOfSight, shortestAngleDiff } from '../turrets/turret-system.js';

export class BossAgent {
  /** @abstract 推进一帧。@param {object} state @param {number} dt @param {object} ctx
   *  @returns {object} 全新 state 各字段（plain 对象，由调用方的 createState 包裹校验） */
  update(state, dt, ctx) { throw new Error('BossAgent.update 是抽象方法，子类必须实现'); }

  /** 视线判定（复用炮塔 LOS 唯一权威）。ctx = {world, registry} */
  _hasLos(ctx, from, to) { return hasLineOfSight({ world: ctx.world, registry: ctx.registry, from, to }); }
  /** 水平指向角（本仓 yaw→前向口径 = (−sin yaw, −cos yaw)，故 atan2(−dx, −dz)） */
  _angleTo(from, to) { return Math.atan2(-(to[0] - from[0]), -(to[2] - from[2])); }
  /** 最短角差（复用炮塔唯一权威，归一化到 [-π, π]） */
  _angleDiff(from, to) { return shortestAngleDiff(from, to); }
  /** 水平距离（不含 y —— 龙恒在半高，竖直差不该影响「远不远」） */
  _hDist(a, b) { return Math.hypot(a[0] - b[0], a[2] - b[2]); }
}
```

```js
// dragon-config.js 追加（数值见 spec §11，全部单一权威）
export const DRAGON_AI = Object.freeze({
  sightRange: 60, chaseSpeed: 9, attackRange: 20, flyoverDistance: 6,
  turnAroundDistance: 22, disengageDistance: 78, fireConeDeg: 20,
  fireCooldownMin: 5, fireCooldownMax: 10, fireRange: 60,
  turnRate: 3.0, wobbleAmp: 5, wobbleFreq: 3, losInterval: 0.1,
  playerAimOffsetY: 1.0,   // 玩家胸部（视线终点 / 火球瞄准点）
});
```

**Steps:**
- [ ] 写 RED：`test-boss-agent.js` 断言 ① `new BossAgent().update(...)` 抛错（抽象方法）② `_angleTo` 对四个基本方向给出与「本仓 yaw→前向口径」一致的值（北 = 0、南 = π、东 = −π/2、西 = π/2，对照 AGENTS.md 的实测表）③ `_hDist` 忽略 y ④ `_hasLos` 转调 `hasLineOfSight`（用假 world 钉住它真的被调用）
- [ ] 跑 RED，确认失败（模块不存在）
- [ ] 实现 `boss-agent.js` + `DRAGON_AI` 常量
- [ ] 跑 GREEN，确认通过
- [ ] `npm run check`（`[测试注册]` 须含新文件；`check:arch` 的同构声明须过）
- [ ] 提交

---

### Task 2: `DragonBossAgent` 四态机（转移 + 移动，不含开火）

**Tier:** 1（机制）—— 必须 TDD。

**Files:**
- Create: `src/entities/bosses/dragon-boss-agent.js`
- Create: `src/tests/test-dragon-boss-agent.js`
- Modify: `src/tests/index.html`

**Interfaces:**

```js
// dragon-boss-agent.js —— 同构声明；不 import dragon-system.js（避免环）
import { BossAgent } from './boss-agent.js';
import { DRAGON_AI } from '../dragons/dragon-config.js';

export class DragonBossAgent extends BossAgent {
  /** @param {{rng?: () => number}} [opts] rng 可注入（默认 Math.random），测试钉冷却区间 */
  constructor(opts = {}) { super(); this.rng = opts.rng ?? Math.random; }

  /**
   * @param {object} state 龙 state（含 mode/orbit/orbitT/attackPhase/fireCooldown/losTimer/
   *                       losVisible/orbitBlend/turnDist）
   * @param {number} dt 秒
   * @param {{world, registry, player: {position:[number,number,number]} | null}} ctx
   * @returns {object} 全新 state 各字段（含 fireRequest，本 Task 恒 null）
   */
  update(state, dt, ctx) { /* 四态机 */ }
}
```

**Steps:**
- [ ] 写 RED（转移）：① `orbit` + 视线通 + 水平距 59 → `chase`；距 61 → 仍 `orbit` ② `chase` + 距 19 → `attack`；距 21 → 仍 `chase` ③ `attack` + 距 79 → `return`；距 77 → 仍 `attack`（**滞回**：60 进 / 78 出，钉住边界两侧）④ `chase` + 视线断 → `return` ⑤ `return` + 到达圆心 → `orbit`
- [ ] 写 RED（移动）：⑥ `chase` 一帧后水平位移 = `chaseSpeed × dt`（方向指向玩家）⑦ `chase` 的 y **恒等于** `orbit.y`（不俯冲不爬升）⑧ `attack` 的 `approach` 距 ≤6 → `turn`；`turn` 累计到 22 → 回 `approach`（飞跃循环）⑨ `orbit` 的半径按 θ 调制（`wobbleAmp=5` 时实测半径在 `[19, 29]` 内起伏，且**不是常数**）
- [ ] 写 RED（视线缓存）：⑩ 连续 5 帧（dt=0.016）只查 1 次 LOS（`losInterval=0.1`）；第 7 帧查第 2 次
- [ ] 跑 RED，确认全部失败
- [ ] 实现 `DragonBossAgent`
- [ ] 跑 GREEN，确认通过
- [ ] `npm run check`
- [ ] 提交

---

### Task 3: 开火条件 + `dragon-system.js` 接线（state 字段 / wobble 轨道 / 委托）

**Tier:** 1（机制）—— 必须 TDD。

**Files:**
- Modify: `src/entities/bosses/dragon-boss-agent.js`（开火四条判据）
- Modify: `src/entities/dragons/dragon-system.js`（state 字段 + `dragonPoseAt` wobble + `update` 委托）
- Modify: `src/tests/test-dragon-boss-agent.js`
- Modify: `src/tests/test-dragon-system.js`

**Interfaces:**

```js
// dragon-system.js：createState 新增字段（全部有缺省，旧调用不破）
//   mode='orbit', attackPhase='approach', fireCooldown=0, losTimer=0, losVisible=false,
//   orbitBlend=1, turnDist=0, fireRequest=null
// normalizeOrbit 新增可选 wobbleAmp/wobbleFreq/wobblePhase（缺省 0/0/0 = 无调制）

// dragonPoseAt(orbit, t)：
//   radius(θ) = orbit.radius + wobbleAmp × sin(wobbleFreq × θ + wobblePhase)
//   yaw = atan2(−dx/dθ, −dz/dθ)   // 调制路径的解析切线
//   ⚠️ wobbleAmp=0 时 yaw 必须**逐位**等于 π − θ（既有断言不破）

// dragonDefinition.update(entity, dt, context)：委托给模块级单例 DragonBossAgent，
//   返回值经 createState 包裹（校验 + 冻结 orbit）
// serialize(state)：⚠️ **不含 fireRequest**（瞬态）
```

**Steps:**
- [ ] 写 RED（开火四条，逐条注入不满足）：① 锥外（yaw 与指向玩家差 21°）→ `fireRequest === null`；差 19° → 非 null ② 冷却未到（`fireCooldown = 1`）→ null；到点（0）→ 非 null ③ 开火瞬间视线断（缓存说通、新鲜查说不通）→ null（**钉住「新鲜复查」而非用缓存**）④ 水平距 61 → null；59 → 非 null ⑤ 四条全满足 → `fireRequest = {position, direction}`，direction 归一化且指向玩家胸部
- [ ] 写 RED（冷却区间）：注入确定性 `rng`（返回 0 / 0.5 / 1），断言开火后 `fireCooldown` 分别 = 5 / 7.5 / 10（钉住 `[fireCooldownMin, fireCooldownMax]` 两端与中点）
- [ ] 写 RED（模式门控）：`orbit` 与 `return` 模式下**永不**开火（四条都满足也不喷）
- [ ] 写 RED（yaw 退化）：`wobbleAmp = 0` 时 `dragonPoseAt(orbit, t).yaw` 与 `Math.PI - theta` **逐位相等**（`Object.is` 或差 === 0，不是近似）
- [ ] 写 RED（wobble 生效）：`wobbleAmp = 5, wobbleFreq = 3` 时一圈内半径有 3 次起伏（采样 360 点，统计过均值的次数 = 6）
- [ ] 写 RED（serialize）：`dragonDefinition.serialize(state)` 的输出**不含** `fireRequest` 键
- [ ] 跑 RED，确认失败
- [ ] 实现开火判据 + `dragon-system.js` 接线
- [ ] 跑 GREEN；**并跑既有 `test-dragon-system.js` 全部用例确认零回归**（尤其「yaw 是切线方向」与「state 全新对象」两条）
- [ ] `npm run check`
- [ ] 提交

---

### Task 4: 火球系统（definition + 判定）

**Tier:** 1（机制）—— 必须 TDD。

**Files:**
- Create: `src/entities/dragons/fireball-system.js`
- Modify: `src/entities/dragons/dragon-config.js`（加 `FIREBALL` 常量 + `FIREBALL_TYPE`）
- Modify: `src/player/physics.js`（新增导出 `playerHitboxLocal()`）
- Create: `src/tests/test-fireball.js`
- Modify: `src/tests/index.html`

**Interfaces:**

```js
// dragon-config.js
export const FIREBALL_TYPE = 'fireball';
export const FIREBALL = Object.freeze({
  speed: 15, maxDistance: 80, radius: 0.45, poolSize: 16,
});

// physics.js（玩家尺寸的唯一权威仍在此，entities/ 不 import 它 —— 由 game.js 注入）
/** 玩家命中盒（相对脚底中心的局部盒）。@returns {{min:number[], max:number[]}} */
export function playerHitboxLocal() {
  const h = PLAYER_WIDTH / 2;
  return { min: [-h, 0, -h], max: [h, PLAYER_HEIGHT, h] };
}

// fireball-system.js —— 同构声明
export const fireballDefinition = Object.freeze({
  create(state) { /* position/direction/traveled/source 校验 */ },
  update(entity, dt, _context) { /* 直线积分，返回全新 state（含全新 position 数组） */ },
  raycastAabb: (state, origin, dir, maxDist) => raycastAabbSlab(state, origin, dir, maxDist, FIREBALL_AABB),
  serialize(state) { /* 临时实体最小 snapshot */ },
  deserialize(raw) { /* 同上 */ },
});

/**
 * 判定顺序照 judgeProjectile：① 超距 → ② 方块阻挡（DDA）→ ③ 玩家命中。
 * ⚠️ 遮挡判据是 `registry.solidTable[id] === 1`（**只看 solid**），有意不同于
 * `isProjectileOccluding`（solid && opaque）—— 玻璃 opaqueTable=0 会被那个判据放过，
 * 而用户明确火球要「击中树叶、玻璃等半透明方块」也爆炸。
 * @param {{next, world, registry, player: {position, aabb} | null, stepLen}} p
 * @returns {{reason: 'block'|'player'|'max-distance'|null, at?: [number,number,number]}}
 *          `at` = 爆炸中心（block 用 blockPos，player 用命中点）
 */
export function judgeFireball({ next, world, registry, player, stepLen }) { /* ... */ }
```

**Steps:**
- [ ] 写 RED（推进）：① 一帧后位移 = `speed × dt`（方向不变）② 返回**全新** state 与全新 position 数组（M5 不变式：原地改写会让 column 索引永不迁移）
- [ ] 写 RED（判定顺序与口径）：③ `traveled ≥ 80` → `reason='max-distance'` 且**无 `at`**（不爆炸）④ 路径上有 `stone` → `reason='block'`，`at` = 那个 blockPos ⑤ 路径上有 **`glass_block`** → `reason='block'`（**这条是 Review Focus 2 的判别性用例**：误用 `isProjectileOccluding` 时它返回 null）⑥ 路径上有 `leaves` → `reason='block'` ⑦ 路径上有 `water` / `short_grass` → **穿过**（reason=null）⑧ 路径命中玩家盒 → `reason='player'`，`at` = 命中点
- [ ] 写 RED（判定区间）：⑨ dt 尖峰（stepLen = 3 格）时 1 格厚的墙仍被判定到（`from = position − direction × stepLen`，与 `judgeProjectile` 同口径）
- [ ] 跑 RED，确认失败
- [ ] 实现 `fireball-system.js` + `FIREBALL` 常量 + `playerHitboxLocal()`
- [ ] 跑 GREEN
- [ ] `npm run check`
- [ ] 提交

---

### Task 5: game.js 装配（抽 `_applyExplosion` + fireRequest 消费 + 火球判定）

**Tier:** 1（机制）—— 必须 TDD（负向验证是 Review Focus 1 的唯一防线）。

**Files:**
- Modify: `src/core/game.js`
- Modify: `src/tests/test-player-input.js` 或新增 `src/tests/test-game-explosion.js`（爆炸口径单测）
- Modify: `src/tests/index.html`

**Interfaces:**

```js
// game.js
/**
 * 爆炸执行（从 explodeTnt 抽出，**不碰去重集合**）。
 * computeExplosion → 受 canTntDestroyBlocks 门控的破坏事务 → 连锁 TNT 入队 →
 * 半径 4 内丧尸 50 伤 → 矿车摧毁 → 音效 → 两层特效。
 * @returns {boolean} 是否真的执行了（computeExplosion 恒成功 → 恒 true）
 */
_applyExplosion(x, y, z) { /* ... */ }

/** TNT 引爆唯一入口 = 去重 + 移除自身 TNT + _applyExplosion（行为逐位不变） */
explodeTnt(x, y, z) { /* 去重 → 移除自身 → this._applyExplosion(x,y,z) */ }

/** entities.update 之后消费龙的开火意图（生成火球实体） */
_consumeDragonFireRequests() { /* 遍历 dragons.activeEntities()，读 state.fireRequest */ }

/** 火球判定 + 爆炸 + despawn（仿 _updateProjectiles，放在 entities.update 之后） */
_updateFireballs(nowMs, dt) { /* judgeFireball → reason 非 null 则 _applyExplosion(at) + despawn */ }
```

**Steps:**
- [ ] 写 RED（爆炸口径零回归）：① `_applyExplosion` 与改动前的 `explodeTnt` 在「开关开」下破坏同样的 27 格（用假 world 数被 setBlocks 的格）② 「开关关」下破坏 0 格但仍播放特效/音效、仍对丧尸造成伤害（TNT 既有口径）③ 连锁 TNT 仍入队
- [ ] 写 RED（**Review Focus 1 的负向验证**）：④ 火球爆炸过的格，之后在同格调 `explodeTnt`（该格放 TNT）**仍返回 true 并真的爆炸** —— 即 `_ignitingTnt` 不含火球的格。⚠️ 这条在「火球直接调 explodeTnt」的实现下必须真 FAIL
- [ ] 写 RED（fireRequest 消费）：⑤ 龙 state 有 `fireRequest` → 生成一个 `fireball` 实体，position/direction 逐位等于请求值 ⑥ `fireRequest === null` → 不生成
- [ ] 跑 RED，确认失败
- [ ] 实现 game.js 改动（抽函数 + 两个新方法 + 注册 `FIREBALL_TYPE` + ctx 注入 `playerAabb`）
- [ ] 跑 GREEN
- [ ] **跑既有 TNT 相关全部用例确认零回归**（`test-tnt.js` / `tests/tnt.spec.mjs` 等 —— 先 grep 确认清单）
- [ ] `npm run check`
- [ ] 提交

---

### Task 6: `FireballRenderer`（渲染池）

**Tier:** 4（GPU 渲染）—— 像素实测。

**Files:**
- Create: `src/render/fireball-renderer.js`
- Modify: `src/core/game.js`（装配 + 帧循环 sync + dispose）
- Create: `src/tests/test-fireball-render.js` + `src/tests/test-fireball-render.html`（fixture）
- Modify: `src/tests/index.html`

**Interfaces:**

```js
// fireball-renderer.js（可用 three）
export class FireballRenderer {
  /** @param {{scene, maxActive?: number}} deps  缺省容量从 FIREBALL.poolSize 派生 */
  constructor({ scene, maxActive = FIREBALL.poolSize }) {
    // SphereGeometry(FIREBALL.radius) + MeshBasicMaterial（火焰色，unlit —— 与矿车/丧尸同口径）
    // InstancedMesh；frustumCulled = false；visible = false（零实例不提交渲染）
  }
  /** 差集驱动 slot（同 ProjectileRenderer.sync）。@param {Iterable} entities */
  sync(entities) { /* ... */ }
  slotCount() { return this._slots.size; }
  dispose() { /* geometry/material/mesh 释放 + 从 scene 摘除 */ }
}
```

**Steps:**
- [ ] 写 RED（单测，fixture 页）：① 零实体时 `mesh.visible === false`（draw call 归零，AGENTS.md「常驻实例池」约束）② 有 1 个火球 → `visible === true` 且 `slotCount() === 1` ③ 实体消失 → slot 归还（`slotCount() === 0` 且 `visible === false`）④ 容量从 `FIREBALL.poolSize` 派生（不传 maxActive 时 `mesh.count === FIREBALL.poolSize`）
- [ ] 跑 RED，确认失败
- [ ] 实现 `FireballRenderer` + game.js 装配
- [ ] 跑 GREEN
- [ ] 写 Tier 4 像素用例（`tests/fireball-render.spec.mjs`）：召龙 → 强制开火（注入 `fireRequest` 或直接 spawn 火球实体）→ 火球飞行途中截图，断言画面里出现**火焰色像素**（先测噪声底：无火球时同机位截图的火焰色像素数）；火球撞地后断言爆炸特效出现（复用 TNT 特效的判据手法）
- [ ] ⚠️ Tier 4 必须冻结变量（日夜/阴影/HUD/物理），并先测噪声底（AGENTS.md「写这类 Tier 4 用例前先测噪声底」）
- [ ] 跑 Tier 4，确认通过
- [ ] `npm run check`
- [ ] 提交

---

### Task 7: E2E（真实游戏页：追击 → 开火 → 爆炸）

**Tier:** 4（真实页面行为）。

**Files:**
- Create: `tests/dragon-ai.spec.mjs`

**Steps:**
- [ ] 写 E2E 用例：
  - ① **发现与追击**：按 C 召龙 → 把玩家 teleport 到龙 59 格内（有视线）→ 等若干帧 → 断言 `state.mode === 'chase'`，且龙的水平位置**朝玩家靠近**（距离递减）
  - ② **不触发**：玩家 teleport 到 61 格外 → 断言 `mode === 'orbit'`（钉住阈值两侧）
  - ③ **视线遮挡**：玩家站在实心方块后（或龙与玩家之间放一列 stone）→ 断言 `mode === 'orbit'`（视线判据真的生效，不是只看距离）
  - ④ **飞跃循环**：玩家静止在龙 6 格内 → 断言 `attackPhase` 在 `approach`/`turn` 之间切换（至少各出现一次）
  - ⑤ **开火**：等待龙开火（冷却最长 10 秒，留足窗口）→ 断言世界里出现 `fireball` 实体，且其 direction 指向玩家胸部
  - ⑥ **开火频率**：连续观测 30 秒，统计开火次数 → 断言 ≤ 6 次（30/5）且 ≥ 2 次（30/10 − 余量）—— 钉住「不是机关枪」
  - ⑦ **爆炸破坏方块（开关开）**：`setTntBlockDamage(true)` → 火球撞地 → 断言落点周围方块被破坏（数空气格）
  - ⑧ **爆炸不破坏方块（开关关）**：默认 false → 火球撞地 → 断言方块**一个都没少**，但爆炸特效播了
  - ⑨ **脱离视线返回**：追击状态下把玩家 teleport 到 80 格外 → 断言 `mode === 'return'`，随后回到 `orbit`
  - ⑩ **玩家不掉血**：火球直接命中玩家 → 断言玩家位置/状态无「受伤」变化（当前无血量概念，钉住「不崩溃、不卡死」+ 爆炸照常发生）
- [ ] ⚠️ E2E 必须走**玩家真实入口**（按 C 召龙、真实帧循环推进），不得手工塞 `state.mode`（M7 教训：只测 API 漏玩家主路径）
- [ ] ⚠️ 计时型断言留足余量（AGENTS.md：贴线断言高负载下 flaky）；冷却观测窗口按 `fireCooldownMax` 派生，不写死
- [ ] 跑 E2E，确认通过
- [ ] 提交

---

### Task 8: 全量回归 + 文档同步

**Tier:** 门禁。

**Files:**
- Modify: `docs/roadmap.md`（v2.44 行）
- Modify: `CLAUDE.md`（现状声明 + 活跃约束 + 目录结构）
- Modify: `docs/superpowers/specs/2026-11-03-altar-dragon-design.md`（加「v2.44 取代说明」：哪些 v2.41 裁定被推翻）

**Steps:**
- [ ] 跑 `npm run check`（arch + data + lint 全绿）
- [ ] 跑浏览器内单测全量（`tests/harness.spec.mjs`），确认 0 failed
- [ ] 跑 `npm test` 全量回归（**用 `run_in_background`，约 31 分钟；独占 8081 与 GPU，不与其他 Playwright 并发**）
- [ ] ⚠️ 已知既有失败（**不是本次回归**，勿修勿藏）：`fog-color.spec.mjs:103/:223/:255`（噪声底「必须为 0」，负载敏感）、`zombie-model.spec.mjs:65`（fixture 缺 `lift`，v2.39 遗留）、`lake-ripple` 两侧都 flaky。判定手法 = AGENTS.md 的**交替对照**（干净 HEAD 与改动交错各跑 2~3 轮），不看单次数值
- [ ] 跑 `npm run bench -- --check`（改了帧循环热路径：AI 每帧 + LOS 缓存 + 火球判定）。⚠️ frameP95 门禁会被 vsync 量子化噪声误报 → 阻断时先做交替对照
- [ ] 文档同步：roadmap v2.44 行（含实测数据）、CLAUDE.md（现状 + 活跃约束「Boss 智能体抽象」段 + 目录结构加 `bosses/boss-agent.js`、`bosses/dragon-boss-agent.js`、`dragons/fireball-system.js`、`render/fireball-renderer.js`）、spec 取代说明
- [ ] ⚠️ CLAUDE.md 的活跃约束要记：① 视线判据（solid && opaque）与火球遮挡判据（只看 solid）**是两个判据，刻意不同**；② 火球**不得**走 `explodeTnt`（去重集合污染）；③ `fireRequest` 是瞬态、不进 serialize；④ AI 在独立 Agent 类里、definition 只委托（后续 Boss 照此扩展）
- [ ] 提交
