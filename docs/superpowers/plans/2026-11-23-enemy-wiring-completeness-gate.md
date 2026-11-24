# 敌人/Boss 接线完整性门 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增一个遍历名册的 Playwright spec，使「加敌人/Boss 类型时漏改任一处接线」在门禁当场 FAIL 并指名漏点，生产代码一行不动。

**Architecture:** 测试侧建一张名册表（每类型的 service 字段名 + Y 口径语义 + 音视觉登记项），spec 遍历它逐项验真实 `window.__MC_GAME__` 的接线。双向钉住（表 ↔ `entities` 已注册可击中类型）使门自动覆盖未来新增类型。**不改任何分发逻辑**。

**Tech Stack:** Playwright（`playwright/test`）、真实游戏页 `window.__MC_GAME__`、Node v26、无新依赖。

**Spec:** `docs/superpowers/specs/2026-11-23-enemy-wiring-completeness-gate-design.md`

## Global Constraints

- **生产代码零改**：`src/` 下非测试文件一行不动。允许改的既有文件只有 `tools/test-tiers.mjs`（`ENTITY` 数组加一行）。
- **表放 `tests/` 侧**，不放 `src/entities/`（避免 `entities → render` 反向边；`check-architecture.mjs` 的 `LAYER_ORDER` 不含 `entities`，方向门抓不到）。放 `tests/` 也免去 `src/tests/index.html` 注册。
- **期望值独立派生**：Y 口径一律从 `ZOMBIE.height` / `IGNIS.height` / `GUARDIAN.height` / `DRAGON_CORE_OBB.halfExtents[1]` / `TURRET.enemyBodyOffsetY` 算出，**禁止 import `game.js` 的公式或抄它的三元链**。
- **时间基准 `performance.now()`**，禁 `Date.now()`。
- **召唤走真实入口**：Boss 按 KeyB（`pressB`），丧尸走 `g.spawnZombieNearPlayer()`。直接调 `service.summon` 会漏掉「名册没登记 / service 没装配 / 地图判定不对」这类接线缺陷（`guardian.spec.mjs` 文件头教训）。
- **不改 TNT 杀伤范围**：`_damageEntitiesInRadius` 只遍历丧尸是刻意设计（`game.js:3761`/`:3867`），本计划不碰。
- **不改任何 Boss 击退裁定**（守卫 v2.91 硬早退 → v3.10 撤销）。
- **不新增 `ZOMBIE_TYPE` 常量**去替换 `game.js` 里 6 处 `'zombie'` 字面量。
- **负向验证纪律**：用 `edit` 注入并**读回源码确认注入落地**；还原用 `cp` 副本，**禁 `git checkout`/`restore`**（本仓有过真实数据丢失）。
- **测试命令不接管道**（`| tail` 会把退出码换成管道末端工具的）。
- **提交等明确指令**；Conventional Commits。
- **最小充分集**：`npm run check` + 本 spec。**不跑 `npm test`**、**不跑 `test:unit`**（未改纯函数/协议/数据模型）、**不跑 `bench --check`**（零改热路径）。

## Review Focus

以下五类是本 spec 自身最可能出的错（不是被测代码的错），按咬人概率排序：

1. **判据恒真** —— 断言在缺陷注入后仍 PASS。spec §7.2 已实测出一例（溅射朴素写法对三类型全部零判别力）。每个判据都必须有对应的负向验证步骤。
2. **夹具坐标口径混用** —— `_cinderBlast` 用 `at` 不加 0.5，`_damageEntitiesInRadius` 用 `center+0.5`。搬错引入 0.5 格误差，而 zombie 的判别区间只有 0.103 格宽。
3. **新类型登记但 service 未装配时静默跳过** —— 门变成「登记了就绿」。必须先断言 service 存在，失败信息指名缺哪一步。
4. **AI 移动导致瞄准/位置读数过期** —— Boss 每帧在动，瞄准必须用**当下**位置（`boss-audio.spec.mjs:650` 口径）。
5. **世界未稳定就取样** —— 判「稳定」须等 sections 停止增长，不能只看队列瞬时归零（`guardian.spec.mjs:63` 的 `waitWorldStable`）。

---

## File Structure

| 文件 | 职责 |
|---|---|
| `tests/enemy-roster.mjs`（新建） | 名册表 + Y 口径派生函数 + 溅射边界 r 计算。**只被 spec import**，无 DOM/three 依赖 ⇒ 可被 Node 直接单测 |
| `tests/enemy-roster.spec.mjs`（新建） | 纯函数档：派生值 12 个数值、r 区间、双向钉住的集合逻辑。**不需要浏览器** |
| `tests/enemy-wiring.spec.mjs`（新建） | 真实页面档：遍历名册验 12 项接线 |
| `tools/test-tiers.mjs`（改） | `ENTITY` 数组加 `'enemy-roster'`、`'enemy-wiring'` 两行 |

**为什么拆两个 spec**：派生函数与 r 计算是纯算术，放浏览器档要为 12 个数值付一次整页加载（~10s+）；而接线项必须有真实 Game。分开后纯函数档可秒级复跑，负向验证迭代快。

---

## Task 1: 名册表与 Y 口径派生（纯函数）

**Files:**
- Create: `tests/enemy-roster.mjs`
- Create: `tests/enemy-roster.spec.mjs`
- Modify: `tools/test-tiers.mjs`（`ENTITY` 数组加 `'enemy-roster'`）

**Interfaces:**
- Consumes: `ZOMBIE` from `../src/entities/zombies/zombie-config.js`；`IGNIS` from `../src/entities/ignis/ignis-config.js`；`GUARDIAN` from `../src/entities/guardian/guardian-config.js`；`DRAGON_CORE_OBB` from `../src/entities/dragons/dragon-config.js`；`TURRET` from `../src/entities/turrets/turret-config.js`；`EXPLOSION_DAMAGE_RADIUS` from `../src/voxel/explosion.js`（实测五个 config 全部零 import，无环）
- Produces:
  - `ENEMY_ROSTER: Readonly<Record<string, RosterEntry>>`，`RosterEntry = { service: string, semantics: 'feet'|'center', height?: number, coreHalfY?: number, aimOffsetY?: number, boss: boolean, blocksPlayer: boolean, deathSound: string, burst: boolean, hitSound?: string }`
  - `bodyCenterOffset(type: string): number` —— 脚底返回 `height/2`，体心返回 `0`
  - `headTopOffset(type: string): number` —— 脚底返回 `height`，体心返回 `coreHalfY`
  - `aimOffset(type: string): number` —— `aimOffsetY ?? TURRET.enemyBodyOffsetY`
  - `blastEdgeRadius(type: string): number` —— 溅射判别用的水平距离，见 Step 3

- [ ] **Step 1: 写失败测试 —— 12 个 Y 数值**

`tests/enemy-roster.spec.mjs`：

```js
import { test, expect } from 'playwright/test';
import { ENEMY_ROSTER, bodyCenterOffset, headTopOffset, aimOffset } from './enemy-roster.mjs';

// 冻结基线（spec §4.2 实测表）：四类型 × 三口径
const FROZEN = {
  zombie:   { center: 0.9,   head: 1.8,   aim: 1.2 },
  ignis:    { center: 1.625, head: 3.25,  aim: 1.2 },
  guardian: { center: 1.9,   head: 3.8,   aim: 1.2 },
  dragon:   { center: 0,     head: 1.875, aim: 0 },
};

test('Y 口径派生：12 个数值逐位等于冻结基线', () => {
  for (const [type, want] of Object.entries(FROZEN)) {
    expect(bodyCenterOffset(type), `${type} 中心`).toBe(want.center);
    expect(headTopOffset(type), `${type} 头顶`).toBe(want.head);
    expect(aimOffset(type), `${type} 瞄准`).toBe(want.aim);
  }
});

test('龙不满足「头顶 = 2×中心」（语义独立的证据）', () => {
  expect(headTopOffset('dragon')).not.toBe(2 * bodyCenterOffset('dragon'));
});
```

- [ ] **Step 2: 跑测试确认 FAIL**

Run: `npx playwright test tests/enemy-roster.spec.mjs`
Expected: FAIL —— `Failed to resolve import "./enemy-roster.mjs"`（文件不存在）

- [ ] **Step 3: 实现名册与派生函数**

`tests/enemy-roster.mjs`。表按 spec §5.1 的字段填；`burst: false`（龙）是刻意不做爆散，注释写明「用户未要求，不是遗漏」。`boss` 字段注释写明「`bossAlive` 只求和三 Boss，丧尸在场不触发战斗 BGM」。

派生函数按 Interfaces 的语义实现。**未登记类型必须 throw**，不静默返回 0：

```js
function entryOf(type) {
  const e = ENEMY_ROSTER[type];
  if (!e) throw new Error(`未登记的敌人类型: ${type}（名册漏登记 ⇒ 接线门会静默跳过它）`);
  return e;
}
```

`blastEdgeRadius(type)` 是唯一需要算法的函数（spec §7.2）：返回区间 `(sqrt(R²−c²), R]` 的中点，其中 `R = EXPLOSION_DAMAGE_RADIUS`、`c = bodyCenterOffset(type)`。

```js
export function blastEdgeRadius(type) {
  const c = bodyCenterOffset(type);
  const R = EXPLOSION_DAMAGE_RADIUS;
  const lo = Math.sqrt(R * R - c * c);   // 漏改时 dist=sqrt(r²+c²) 恰好等于 R 的临界
  return (lo + R) / 2;                    // 取中点：正确实现 dist=r≤R，漏改 dist>R
}
```

- [ ] **Step 4: 加 r 区间断言并跑测试确认 PASS**

追加到 `tests/enemy-roster.spec.mjs`：

```js
import { blastEdgeRadius } from './enemy-roster.mjs';
import { EXPLOSION_DAMAGE_RADIUS as R } from '../src/voxel/explosion.js';

test('溅射边界 r：正确实现在半径内、漏改（中心落 0）在半径外', () => {
  for (const type of Object.keys(ENEMY_ROSTER)) {
    const r = blastEdgeRadius(type);
    const c = bodyCenterOffset(type);
    expect(r, `${type} r 必须 ≤ R`).toBeLessThanOrEqual(R);
    expect(Math.hypot(r, c), `${type} 漏改时 dist 必须 > R（否则判据恒真）`).toBeGreaterThan(R);
  }
});
```

Run: `npx playwright test tests/enemy-roster.spec.mjs`
Expected: PASS（3 个 test）

⚠️ **dragon 的 `c=0` ⇒ `lo=R` ⇒ 中点 `=R` ⇒ `hypot(R,0)=R` 不 `>R`**。该断言对 dragon 会 FAIL，这是**正确的**：龙是体心语义，`half` 三元链的 else 分支本就返回 0，漏改与正确行为一致 ⇒ **该项对龙无判别力**。修法：该 test 只遍历 `semantics === 'feet'` 的类型，并在注释写明「龙无判别力，刻意排除，不是遗漏」。

- [ ] **Step 5: 登记分档并跑门禁**

`tools/test-tiers.mjs` 的 `ENTITY` 数组加 `'enemy-roster'`。

Run: `npm run check`
Expected: exit 0，`[测试分档]` 行的 spec 计数 +1

- [ ] **Step 6: 负向验证 N-N1（派生函数）**

用 `edit` 把 `ENEMY_ROSTER.dragon.semantics` 改成 `'feet'`，**读回源码确认注入落地**。

Run: `npx playwright test tests/enemy-roster.spec.mjs`
Expected: FAIL（龙的 center/head 不再是 0/1.875）

用 `cp` 副本还原，再跑一次确认 PASS。

- [ ] **Step 7: Commit**

```bash
git add tests/enemy-roster.mjs tests/enemy-roster.spec.mjs tools/test-tiers.mjs
git commit -m "test(enemy): 敌人接线名册与 Y 口径派生（12 数值冻结 + 溅射边界 r）"
```

---

## Task 2: 双向钉住与 service 装配前置断言

**Files:**
- Create: `tests/enemy-wiring.spec.mjs`
- Modify: `tools/test-tiers.mjs`（`ENTITY` 数组加 `'enemy-wiring'`）

**Interfaces:**
- Consumes: Task 1 的 `ENEMY_ROSTER`、`bodyCenterOffset`、`headTopOffset`、`aimOffset`、`blastEdgeRadius`；`WEAPON_HITTABLE_TYPES` from `../src/entities/entity-types.js`
- Produces: 本 spec 内的夹具 helper（后续 Task 复用，同名同签名）：
  - `waitWorldReady(page)` —— 照 `guardian.spec.mjs:28`
  - `gotoOpenField(page, {offsetX=600, offsetZ=600})` —— 照 `boss-audio.spec.mjs:51`
  - `putPlayer(page, x, y, z)` —— 照 `guardian.spec.mjs:97`
  - `pressB(page)` —— 照 `guardian.spec.mjs:77`
  - `rosterGap(page)` → `{ missingInRoster: string[], danglingInRoster: string[], unwired: string[] }`

- [ ] **Step 1: 写失败测试 —— 双向钉住**

```js
test('双向钉住：名册 ↔ entities 已注册的可击中类型集合相等', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/?vd=2&seed=12345');
  await waitWorldReady(page);
  const gap = await page.evaluate(async () => {
    const { WEAPON_HITTABLE_TYPES } = await import('/src/entities/entity-types.js');
    const { ENEMY_ROSTER } = await import('/tests/enemy-roster.mjs');
    const registered = WEAPON_HITTABLE_TYPES;
    const inRoster = Object.keys(ENEMY_ROSTER);
    const g = window.__MC_GAME__;
    return {
      missingInRoster: registered.filter((t) => !inRoster.includes(t)),
      danglingInRoster: inRoster.filter((t) => !registered.includes(t)),
      unwired: inRoster.filter((t) => !g[ENEMY_ROSTER[t].service]),
    };
  });
  expect(gap.missingInRoster, '可击中类型漏登记进名册 ⇒ 门会静默跳过它').toEqual([]);
  expect(gap.danglingInRoster, '名册登记了不可击中的类型（死登记）').toEqual([]);
  expect(gap.unwired, 'service 未装配 ⇒ 逐项断言会静默跳过').toEqual([]);
});
```

⚠️ **`/tests/enemy-roster.mjs` 已实测可达**：`server-script/start-server.js:32` 的 `ROOT` 是仓库根，且 `:60` 显式登记了 `.mjs` 的 MIME 为 `text/javascript`（未登记会回落 `application/octet-stream` ⇒ module script 整体拒载）。名册内部 import `../src/...` 从 `/tests/` 解析成 `/src/...`，同样可达。

⚠️ **但无先例**：实测现有 spec 零处 `import('/tests/...')`。若 Step 2 报 404 或 MIME 错，**改为备选方案**：表在 Node 侧（spec 文件顶部）import，只把类型名数组与期望值传进 `page.evaluate`。备选方案同样成立（双向钉住只需类型名集合），**不要为此把表搬进 `src/`**。

- [ ] **Step 2: 跑测试确认 FAIL 并核实 import 可达**

Run: `npx playwright test tests/enemy-wiring.spec.mjs`
Expected: FAIL —— helper 未定义（`waitWorldReady is not defined`）

若报的是 `/tests/enemy-roster.mjs` 404，按 Step 1 的备选改法调整（表在 Node 侧读，类型名数组传入）。

- [ ] **Step 3: 实现 helper 与本 test**

helper 逐个照抄指定行号的既有实现（**不自造夹具**）。`test.describe.configure({ mode: 'serial' })`。

- [ ] **Step 4: 跑测试确认 PASS**

Run: `npx playwright test tests/enemy-wiring.spec.mjs`
Expected: PASS（1 个 test）

- [ ] **Step 5: 登记分档 + 门禁**

`tools/test-tiers.mjs` 的 `ENTITY` 加 `'enemy-wiring'`。
Run: `npm run check`
Expected: exit 0

- [ ] **Step 6: 负向验证 N10 / N11**

N10：`edit` 删掉 `ENEMY_ROSTER.guardian` 一行 → 读回确认 → 跑 spec → Expected FAIL（`missingInRoster: ['guardian']`）。
N11：`edit` 加一个 `bogus: {...}` 条目 → 读回确认 → 跑 spec → Expected FAIL（`danglingInRoster: ['bogus']`）。
各自 `cp` 还原后复跑确认 PASS。

- [ ] **Step 7: Commit**

```bash
git add tests/enemy-wiring.spec.mjs tools/test-tiers.mjs
git commit -m "test(enemy): 接线门双向钉住与 service 装配前置断言"
```

---

## Task 3: 伤害 / 击退 / 受击音 / 死亡四项接线

**Files:**
- Modify: `tests/enemy-wiring.spec.mjs`（追加 test）

**Interfaces:**
- Consumes: Task 2 的 helper；`g.damageEntity(id, amount, nowMs)` → `{dead, health}|null`；`g.knockbackEntity(id, dist)` → `boolean`；`g.audioDebugState().playRequests`；`g.blockHitFx.activeDebrisCount`
- Produces: `summonFor(page, type)` → `{ id, feetY }` —— 按类型走真实入口（Boss 传送到其地图 + `pressB`；丧尸 `g.spawnZombieNearPlayer()`），后续 Task 复用

- [ ] **Step 1: 写失败测试 —— 遍历名册验三项**

一个 test 内遍历 `Object.entries(ENEMY_ROSTER)`，每类型：

| 项 | 断言 |
|---|---|
| damage | `g.damageEntity(id, 1, performance.now())` 返回非 null 且 `health` 减 1 |
| knockback | 记 `state.position`，调 `g.knockbackEntity(id, 0.4)`，断言水平位移 > 0 |
| **hit 音** | 有 `hitSound` 的类型：**非致死**命中后 `playRequests[hitSound]` 增长 ≥ 1 |
| death 音 | 打死（`damageEntity(id, 9999, …)`）后 `playRequests[deathSound]` 增长 ≥ 1 |
| death 爆散 | `burst:true` ⇒ `activeDebrisCount` 增长；`burst:false` ⇒ **不增长** |

⚠️ **hit 音项是历史上真实漏过的那一处**（`game.js:3339` 注释：焰魔受击音「这里原来一行都没有」），不得省。它只在 `result && !result.dead` 时播 ⇒ **必须用非致死伤害**（`damageEntity(id, 1, …)`），用致死伤害会恒不播而误判为缺陷。

⚠️ **龙/守卫的召唤有地图约束**：守卫只在废弃堡垒占地内按 B 可召（`bossMapAt`），龙只在祭坛地带。`summonFor` 必须按类型传送到对应地图，照 `guardian.spec.mjs:158` 与 `boss-audio.spec.mjs:83` 的既有夹具。

⚠️ **爆散计数取样前先 `g.blockHitFx.reset()`**（`boss-audio.spec.mjs:214` 口径），否则之前挖方块的碎块会混进来。

- [ ] **Step 2: 跑测试确认 FAIL**

Run: `npx playwright test tests/enemy-wiring.spec.mjs -g "伤害"`
Expected: FAIL —— `summonFor is not defined`

- [ ] **Step 3: 实现 summonFor 与本 test**

`summonFor` 按类型分派到既有夹具口径。Boss 走 `pressB` + `waitForFunction(activeEntities().length === 1)` + 等 `onGround === true`（`guardian.spec.mjs:170` 教训：召唤当帧还没跑重力积分）。

- [ ] **Step 4: 跑测试确认 PASS**

Run: `npx playwright test tests/enemy-wiring.spec.mjs -g "伤害"`
Expected: PASS

- [ ] **Step 5: 负向验证 N1 / N2 / N3 / N-HIT**

逐条用 `edit` 注入 `src/core/game.js`（**这是负向验证的临时注入，不是本计划的交付改动**），读回确认，跑 spec，`cp` 还原：

| 编号 | 注入 | Expected |
|---|---|---|
| N1 | 删 `damageEntity` 的 `GUARDIAN_TYPE` 分支（`game.js:3344`） | damage 项 FAIL |
| N2 | 删 `knockbackEntity` 的 `GUARDIAN_TYPE` 行（`:3428`） | knockback 项 FAIL |
| N-HIT | 删 `damageEntity` 里守卫的 `hitSound` 播放块（`:3350-3352`，已核实：`if (result && !result.dead) { …play(BOSS_HIT_SOUND…) }`） | hit 音项 FAIL |
| N3 | 删 `_onEntityDeath` 的 `GUARDIAN_TYPE` 分支（`:3476`） | death 音 + 爆散 FAIL |

每条还原后复跑确认 PASS，并 `git status` 确认 `src/core/game.js` 无残留 diff。

- [ ] **Step 6: Commit**

```bash
git add tests/enemy-wiring.spec.mjs
git commit -m "test(enemy): 遍历名册验伤害/击退/受击音/死亡音与爆散接线"
```

---

## Task 4: 头顶锚点与溅射中心（两个静默 Y 口径）

**Files:**
- Modify: `tests/enemy-wiring.spec.mjs`（追加 test）

**Interfaces:**
- Consumes: Task 1 的 `headTopOffset` / `bodyCenterOffset` / `blastEdgeRadius`；Task 3 的 `summonFor`；`g._damageNumbers._slots`（`health-hud.spec.mjs:276` 口径）；`g.launchCinder(launch)`
- Produces: 无（终端判据）

- [ ] **Step 1: 写失败测试 —— 头顶锚点**

遍历名册，每类型受击一次后读：

```js
const slots = g._damageNumbers._slots.filter((s) => s.active)
  .map((s) => ({ offsetFromFeet: s.lastPos[1] - feetY }));
```

断言 `Math.abs(offsetFromFeet - headTopOffset(type)) < 1e-6`。

⚠️ **必须多等几帧**（`health-hud.spec.mjs:273`）：`update()` 逐帧用 `anchor()` 覆盖 `lastPos`，首帧的 `initial` 不算数 —— 只读首帧抓不到「anchor 漏分支」这个正是本项要防的缺陷。

⚠️ **龙的 `feetY` 语义不同**：其 `position` 已是体心，`offsetFromFeet` 实为 `offsetFromCenter`。断言用 `headTopOffset` 直接比（它已按 semantics 分派），不要额外减 height。

- [ ] **Step 2: 跑测试确认 FAIL**

Run: `npx playwright test tests/enemy-wiring.spec.mjs -g "锚点"`
Expected: FAIL（test 不存在）

- [ ] **Step 3: 实现锚点 test**

- [ ] **Step 4: 写溅射中心 test（按 spec §7.2 的边界几何）**

只对 `semantics === 'feet'` 的类型（龙无判别力，Task 1 Step 4 已证）。每类型：

1. `summonFor` 造出实体，记其 `position = [ex, ey, ez]`
2. 爆心放在**水平距离 `r = blastEdgeRadius(type)`、垂直高度 `ey + bodyCenterOffset(type)`** 处
3. 调 Cinder Fall 的落点结算，断言该实体扣血

⚠️ **坐标口径**：`_cinderBlast` 用 `const [cx,cy,cz] = at`，**不加 0.5**。搬 TNT 的 `center+0.5` 口径会引入 0.5 格误差，而 zombie 的 r 区间只有 **0.103 格**宽 ⇒ 判据翻转。

⚠️ **zombie 区间最窄**：若夹具精度无法稳定命中，**允许只覆盖 ignis/guardian**，但必须在 test 注释与本计划里记下 zombie 未覆盖，**不得静默跳过**。

- [ ] **Step 5: 跑测试确认 PASS**

Run: `npx playwright test tests/enemy-wiring.spec.mjs -g "锚点|溅射"`
Expected: PASS

- [ ] **Step 6: 负向验证 N4 / N5（N5 是本计划最关键的一条）**

| 编号 | 注入 | Expected |
|---|---|---|
| N4 | `headY` 删 ignis 分支（`game.js:3517`，落龙口径 1.875） | 锚点项 FAIL |
| N5 | `half` 删 guardian 分支（`:3900`，落 0） | 溅射项 FAIL |

**N5 特别核验**：若注入后仍 PASS，说明 r 构造错了（判据恒真），**必须停下修判据，不得放宽断言**。spec §7.2 已实测朴素写法对三类型全部零判别力。

各自 `cp` 还原 + 复跑 + `git status` 核对。

- [ ] **Step 7: Commit**

```bash
git add tests/enemy-wiring.spec.mjs
git commit -m "test(enemy): 头顶锚点与溅射中心接线（边界几何保判别力）"
```

---

## Task 5: 音频 / 炮塔索敌 / 玩家阻挡三项接线

**Files:**
- Modify: `tests/enemy-wiring.spec.mjs`（追加 test）

**Interfaces:**
- Consumes: Task 2 helper、Task 3 `summonFor`；`g.audioManager.debugMusicState().boss.wanted`；`g.placeTurret(origin)`；`g.turrets.controllers()`；`g.player.physics._collides(x,y,z)`
- Produces: 无

- [ ] **Step 1: 写失败测试 —— boss BGM**

遍历 `boss: true` 的类型：召唤后断言 `debugMusicState().boss.wanted === true`。
另加一条：只有丧尸在场时 `boss.wanted === false`（`boss` 字段的判别力）。

⚠️ 音频需手势解锁：`await page.locator('#app-canvas').click(...)` + 等 `debugMusicState().playing === true`（`boss-audio.spec.mjs:76` 口径）。

- [ ] **Step 2: 写失败测试 —— 起手音**

遍历有攻击态的类型，让其进 `attack` 态后断言 `playRequests` 增长。
⚠️ 焰魔按招分音（`ignisAttackSound(attackKind)`），断言用「该类型登记的任一 attack 音计数增长」，不写死某一个。

- [ ] **Step 3: 写失败测试 —— 炮塔索敌**

放炮塔 + 造该类型实体在射程内，等 `_runTurretAi` 的 8Hz 拍跑过，断言某 controller 的 `targetId === 该实体 id`。

- [ ] **Step 4: 写失败测试 —— 玩家阻挡**

只对 `blocksPlayer: true` 的类型：把玩家盒放进实体盒内，断言 `physics._collides(...)` 为真。

- [ ] **Step 5: 跑测试确认 FAIL 再实现**

Run: `npx playwright test tests/enemy-wiring.spec.mjs -g "BGM|起手音|索敌|阻挡"`
Expected: 先 FAIL（test 不存在），实现后 PASS

- [ ] **Step 6: 负向验证 N6 / N7 / N8 / N9**

| 编号 | 注入 | Expected |
|---|---|---|
| N6 | `bossAlive` 去掉 `GUARDIAN_TYPE` 项（`game.js:4022`） | BGM 项 FAIL |
| N7 | `_syncBossAudio` 删守卫循环（`:4070-4071`） | 起手音项 FAIL |
| N8 | `_runTurretAi` 删守卫 for（`:4405`） | 索敌项 FAIL |
| N9 | `physics._collides` 删 guardians 行（`physics.js:367`） | 阻挡项 FAIL |

各自读回确认 + `cp` 还原 + 复跑 + `git status` 核对。

- [ ] **Step 7: 全 spec 跑 + 门禁**

Run: `npx playwright test tests/enemy-wiring.spec.mjs tests/enemy-roster.spec.mjs`
Expected: 全 PASS
Run: `npm run check`
Expected: exit 0

- [ ] **Step 8: Commit**

```bash
git add tests/enemy-wiring.spec.mjs
git commit -m "test(enemy): Boss BGM/起手音/炮塔索敌/玩家阻挡接线"
```

---

## 收尾验证（不新增文件）

- [ ] `npm run check` exit 0
- [ ] `npx playwright test tests/enemy-roster.spec.mjs tests/enemy-wiring.spec.mjs` 全 PASS
- [ ] `git status --short` —— **`src/` 下必须零 diff**（生产代码零改的硬证据）
- [ ] `git diff --stat` 只含 `tests/enemy-roster.mjs`、`tests/enemy-roster.spec.mjs`、`tests/enemy-wiring.spec.mjs`、`tools/test-tiers.mjs`、两份 docs
- [ ] 12 条负向验证逐条记录实测读数（哪条 FAIL、失败信息是否指名漏点）

**不跑**：`npm test`（未改全局基础设施的消费面）、`test:unit`（未改纯函数/协议/数据模型）、`bench --check`（零改热路径）。