# 焰魔 AoE 玩家伤害 + 血量翻倍 + 受伤红闪 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让焰魔的剑阵尖刺与地面法阵各对玩家造成 1 格伤害，玩家满血翻倍到 40 格（20 颗心两排），并在任何掉血时闪现一次屏幕四周 40px 红色渐变。

**Architecture:** 两处新增判定都在装配层 `src/core/game.js` 里结算（渲染层只画不管玩法，延续 `_consumeIgnisFxRequests` 的既有分工）；伤害数值与法阵足迹的权威进同构层 `ignis-config.js` 的 `IGNIS_AOE`；红闪是 `src/ui/` 的 DOM 覆盖层（零 draw call），接在伤害唯一入口 `_damagePlayer()` 上；血量口径只在 `player/health.js` 改常量。

**Tech Stack:** 原生 ES module、WebGPU/three r185.1、Playwright（E2E + Tier 4 像素）、浏览器内单测（`src/tests/runner.js`）、Node 侧单测 runner（`tools/run-unit-node.mjs`）。

**Spec:** `docs/superpowers/specs/2026-11-21-ignis-aoe-player-damage-design.md`

## Global Constraints

- **红线 1（同一事实一份权威）**：1 格伤害只写在 `IGNIS_AOE.damage`；法阵足迹半宽只写在 `IGNIS_AOE.sigilHalfExtent`；血量上限只写在 `player/health.js` 的 `PLAYER_MAX_HEALTH` / `PLAYER_MAX_HEARTS`。任何消费方不得复制字面量。
- **红线 8（同构层）**：`src/entities/` 在 `tools/check-architecture.mjs` 的 `ISOMORPHIC_DIRS` 里 ⇒ `ignis-config.js` 不得 import three / DOM / `src/render/`。`IGNIS_AOE` 与 `FLAME_SIGIL` 的等式只能由单测跨层钉住。
- **红线：渲染层不持有玩法**：法阵伤害在 `game.js` 判定，`flame-sigil.js` 一行不改。
- **禁止 `Date.now()`**：一切时间基准是 `performance.now()`，且必须由调用方一路透传 `nowMs`（不得在消费方法内另取）。
- **用户裁定（2026-11-21）**：扩散火圈**保持纯视觉、零伤害**；尖刺 18 → **1**；法阵 **1 格**且一次攻击最多扣一次；红闪 **任何掉血**都闪、**0.35 秒**、**40px**；血量 **40 格 = 20 颗心 = 两排 10+10**；红闪 DOM 覆盖层；血量为 0 时**仍闪**但**不死**。
- **UI 层级不等式**（`CLAUDE.md`）：`… 50（血心/坐标/性能面板） < 55（伤害数字） < 56（红闪） < 60（设置按钮） < 70（设置面板） < 80（背包） …`，不得取 100+。
- **提交纪律**：每个 Task 一次 commit，Conventional Commits；不得 `git add -A`（只 add 本 Task 的文件）。
- **测试纪律**：默认最小充分集。本计划的门禁命令在每个 Task 里写明；**不跑** `npm run bench -- --check`（渲染管线与热路径零改动）。

## Review Focus

按「最容易伤到玩家」排序，每条都在下面的具体 Task 里有对应判据：

1. **法阵的判定尺寸与画出来的尺寸漂移** —— 玩家看着踩在图案上却不掉血，或站在图案外却掉血。`FLAME_SIGIL.radius`（`render/`，画多大）与 `IGNIS_AOE.sigilHalfExtent`（`entities/`，判多大）是两个文件里的数，import 方向不允许它们互相引用 ⇒ 靠 Task 3 的跨层等式单测钉住。
2. **法阵伤害挂在渲染器存在性上** —— `flame_sigil.png` 加载失败时 `this.flameSigil` 为 null，若伤害仍写在 `!this.flameSigil` 门控内，玩法伤害会静默消失，而单测用 `flameSigil: null` 造壳会把它读成「不扣血 = 正常」。Task 4 的用例 ⑤ 专抓它。
3. **一次攻击扣多次** —— 法阵四段、尖刺三十根，若忘了 `break`，玩家一次挨打会掉 2~4 格。Task 4 用例 ③ 与 Task 5 的既有用例（已存在）各自钉住。
4. **血量翻倍后 HUD 画错格数** —— 把 20 颗心画成一排会横穿屏幕中心压住准心区域；像素计数抓不到（20 颗单排照样有足够红像素），只有几何断言能抓。Task 7 的「第二排 top = 第一排 top + 18」是唯一有判别力的判据。
5. **红闪在血量为 0 时不闪** —— 若把触发条件写成「血量真的变了」，血停在 0 后所有受击都不再闪现，而用户明确要求仍要闪。Task 6 的用例 ③ 钉住 `amount > 0` 就闪。

---

## 文件结构

| 文件 | 职责 | 动作 |
|---|---|---|
| `src/player/health.js` | 血量口径（常量 + `heartsFor` + `applyDamage`）的唯一权威 | 改两个常量 + 注释 |
| `src/ui/health-hud.js` | 只负责把 `heartsFor()` 的输出画成 DOM 心形 | 改两排布局 |
| `src/ui/damage-flash.js` | 红闪覆盖层：四条 40px 渐变 + 淡出包络（纯函数 `flashOpacityAt` 同文件） | **新建** |
| `src/core/game.js` | 装配层：伤害结算、HUD 构造、帧循环 | 4 处改动 |
| `src/entities/ignis/ignis-config.js` | 焰魔玩法数据唯一权威 | 新增 `IGNIS_AOE`、改 `IGNIS_SPIKE.damage` |
| `src/tests/test-damage-flash.js` | 红闪包络的纯函数契约 | **新建** |
| `src/tests/test-flame-sigil.js` | 追加装配层法阵伤害用例 | 追加 |
| `src/tests/test-spike-fx.js` | 尖刺结算用例（既有） | 改数值 |

依赖方向：`ui/` ← `player/`（只读常量）、`core/` → 全部。`entities/` 不依赖 `render/`。

---

### Task 1: 血量口径翻倍（40 格 / 20 颗心）

**Files:**
- Modify: `src/player/health.js:30-36`（两个常量 + 注释）
- Test: `src/tests/test-health.js`（全文 20/10 → 40/20）

**Interfaces:**
- Consumes: 无
- Produces: `PLAYER_MAX_HEALTH = 40`、`PLAYER_MAX_HEARTS = 20`；`heartsFor(health)` 返回长度恒为 20 的 `Array<'full'|'half'|'empty'>`；`applyDamage(health, amount)` 语义不变、上限变 40。

- [ ] **Step 1: 改测试为 40/20（先让它红）**

把 `src/tests/test-health.js` 里所有 20/10 改为 40/20，并把「两下即死」那条设计判据改成三下：

```js
test('health: 常量自洽（40 血 = 20 心，半心 = 1 血）', () => {
  assertEqual(PLAYER_MAX_HEALTH, 40, '用户 2026-11-21 裁定：血量翻倍');
  assertEqual(PLAYER_MAX_HEARTS, 20, '用户 2026-11-21 裁定：心数翻倍');
  assertEqual(PLAYER_MAX_HEALTH / PLAYER_MAX_HEARTS, 2, '每颗心 = 2 格血');
});

test('applyDamage: 焰魔的一击（14）打三次就让满血归 0', () => {
  let hp = PLAYER_MAX_HEALTH;
  hp = applyDamage(hp, 14);
  assertEqual(hp, 26);
  hp = applyDamage(hp, 14);
  assertEqual(hp, 12);
  hp = applyDamage(hp, 14);
  assertEqual(hp, 0);
});
```

`heartsFor` 的既有四条用例同步替换数字（`heartsFor(40)` 全满 20 颗、`heartsFor(39)` 末颗半心、`heartsFor(1)` 首颗半心、长度恒为 `PLAYER_MAX_HEARTS`、边界全扫 `0..40`）。

- [ ] **Step 2: 跑测试确认红**

Run: `node tools/run-unit-node.mjs --only=test-health.js`
Expected: FAIL，首条断言报 `Expected 40, got 20`。

⚠️ **`--only` 的真实语法是 `--only=a.js,b.js`（等号），不是空格分隔**（`tools/run-unit-node.mjs:37`）。
且 `--only` 里的文件**必须在 `UNIT_NODE_SAFE` 白名单内**，否则会直接报「不在白名单内」而不跑。

- [ ] **Step 3: 改常量**

`src/player/health.js`：

```js
export const PLAYER_MAX_HEALTH = 40;
export const PLAYER_MAX_HEARTS = 20;
```

同步更新文件头注释：满血 40 格、20 颗心、每颗心 2 格、半颗心 1 格；并写明「2026-11-21 用户裁定血量翻倍（原 20 格 / 10 颗心），原因是焰魔新增了法阵 1 格与尖刺 1 格两处小额伤害源，20 格上读不出分量」。

- [ ] **Step 4: 跑测试确认绿**

Run: `node tools/run-unit-node.mjs --only=test-health.js`
Expected: 全绿，`heartsFor(40)` 长度为 20。

- [ ] **Step 5: 提交**

```bash
git add src/player/health.js src/tests/test-health.js
git commit -m "feat(player): 玩家血量翻倍到 40 格 / 20 颗心"
```

---

### Task 2: 血心 HUD 改两排 10+10

**Files:**
- Modify: `src/ui/health-hud.js:60-150`（构造期节点结构 + `_paint`）
- Test: `tests/health-hud.spec.mjs`（10→20、20→40，新增两排几何断言）

**Interfaces:**
- Consumes: Task 1 的 `PLAYER_MAX_HEARTS = 20`、`heartsFor()`
- Produces: `HealthHUD` 的 DOM 形状 —— `#mc-health` 内部是两个行容器 `#mc-health-row0` / `#mc-health-row1`，各 10 个 `<img>`；`hearts()` 仍返回长度 20 的数组（顺序：row0 从左到右 = 索引 0..9，row1 = 10..19）

- [ ] **Step 1: 改 E2E 断言（先让它红）**

`tests/health-hud.spec.mjs` 的第一条用例改为：

```js
test('玩家血心：20 颗红心两排画出来（像素断言）且紧挨性能看板右侧', async ({ page }) => {
  test.setTimeout(180_000);
  await boot(page);
  await waitHeartsLoaded(page);

  const m = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    const health = document.getElementById('mc-health');
    const perf = g._hud.el.getBoundingClientRect();
    const hr = health.getBoundingClientRect();
    const rows = ['#mc-health-row0', '#mc-health-row1'].map((s) => {
      const r = document.querySelector(s).getBoundingClientRect();
      return { top: r.top, left: r.left, width: r.width, count: document.querySelectorAll(`${s} img`).length };
    });
    const imgs = [...health.querySelectorAll('img')];
    return {
      count: imgs.length,
      srcs: imgs.map((i) => i.src.split('/').pop()),
      rowCounts: rows.map((r) => r.count),
      rowTops: rows.map((r) => r.top),
      rowLefts: rows.map((r) => r.left),
      rowWidths: rows.map((r) => r.width),
      zIndex: getComputedStyle(health).zIndex,
      gap: hr.left - perf.right,
      top: hr.top, perfTop: perf.top,
      hudHearts: g._healthHud.hearts(),
    };
  });

  expect(m.count, '必须恰好 20 颗心').toBe(20);
  expect(m.rowCounts, '两排各 10 颗').toEqual([10, 10]);
  expect(m.srcs, '满血 = 20 张红心图').toEqual(Array(20).fill('heart.png'));
  expect(m.hudHearts, 'HUD 内部状态 = 全满 20 颗').toEqual(Array(20).fill('full'));
  // ⚠️ 这是唯一能抓住「把 20 颗画成一排」的判据：
  // 单排 20 颗 = 360px 宽，像素计数照样过（只有几何位置不对），屏宽 1280 时也不会溢出。
  expect(m.rowTops[1] - m.rowTops[0], '第二排在第一条正下方，行距 = 心高 18px').toBeCloseTo(18, 0);
  expect(m.rowLefts[0], '两排左缘对齐').toBeCloseTo(m.rowLefts[1], 0);
  expect(m.rowWidths[0], '每排宽 = 10 × 18px').toBeCloseTo(180, 0);
  expect(m.rowWidths[1], '每排宽 = 10 × 18px').toBeCloseTo(180, 0);
  expect(m.zIndex, '血心与性能/坐标面板同层（50）').toBe('50');
  expect(m.gap, '血心左缘与看板右缘的间距应为 8px').toBeGreaterThan(6);
  expect(m.gap).toBeLessThan(10);
  expect(m.top, '与看板同高（top:8px）').toBeCloseTo(m.perfTop, 0);

  // 像素断言下限从 200 提到 400（心数翻倍）
  // ...（保留既有裁剪 + 偏红像素计数代码，把 200 改成 400）
});

test('玩家血量当前恒为满血 40', async ({ page }) => {
  test.setTimeout(180_000);
  await boot(page);
  const hp = await page.evaluate(() => window.__MC_GAME__.player.health);
  expect(hp, '血量权威 = 满血 40').toBe(40);
});
```

同时把 `waitHeartsLoaded()` 的 `imgs.length === 10` 改成 `=== 20`。

- [ ] **Step 2: 跑测试确认红**

Run: `npx playwright test tests/health-hud.spec.mjs -g "血心"`
Expected: FAIL，`m.count` 为 10 而非 20。

- [ ] **Step 3: 改 `health-hud.js` 为两排**

构造期把单层 `this.el` 改成「外层 + 两行」：

```js
/** 每排的心数（= PLAYER_MAX_HEARTS / 2 = 10） */
const PER_ROW = PLAYER_MAX_HEARTS / 2;

// 外层：固定定位，高度 = 两排
this.el.style.cssText =
  `position:fixed;top:8px;left:${LEFT_PX}px;z-index:${HEALTH_Z_INDEX};` +
  `display:flex;flex-direction:column;gap:0;pointer-events:none;` +
  `height:${HEART_SIZE_PX * 2}px;`;

this._imgs = [];
for (let row = 0; row < 2; row += 1) {
  const rowEl = document.createElement('div');
  rowEl.id = `mc-health-row${row}`;
  rowEl.style.cssText = `display:flex;gap:0;height:${HEART_SIZE_PX}px;`;
  for (let i = 0; i < PER_ROW; i += 1) {
    const img = document.createElement('img');
    // ...（既有样式不变）
    rowEl.appendChild(img);
    this._imgs.push(img);   // 顺序 = row0 的 0..9 然后 row1 的 0..9
  }
  this.el.appendChild(rowEl);
}
```

`_paint()` 与 `hearts()` 一行不改（它们按 `this._imgs` 顺序铺，行结构对它们透明）。
`LEFT_PX` 不变。注释里补一句「两排是用户 2026-11-21 裁定的布局；不得用 `flex-wrap` —— 它会在父宽变化时不可控地重排，第 11 颗落到哪排取决于父宽」。

- [ ] **Step 4: 跑测试确认绿**

Run: `npx playwright test tests/health-hud.spec.mjs -g "血心"`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/ui/health-hud.js tests/health-hud.spec.mjs
git commit -m "feat(hud): 血心改两排 10+10 容纳 20 颗心"
```

---

### Task 3: `IGNIS_AOE` 权威 + 尖刺伤害改 1

**Files:**
- Modify: `src/entities/ignis/ignis-config.js`（新增 `IGNIS_AOE`；`IGNIS_SPIKE.damage` 18→1 + 注释）
- Modify: `src/tests/test-ignis-system.js`（`damage` 断言 18→1，新增 `IGNIS_AOE` 断言）
- Modify: `src/tests/test-spike-fx.js:553,559,576,579,597`（18→1，用例名同步）

**Interfaces:**
- Consumes: 无
- Produces:
  - `IGNIS_AOE = Object.freeze({ damage: 1, sigilHalfExtent: 2.0 })`
  - `IGNIS_SPIKE.damage === 1`

- [ ] **Step 1: 写失败的测试**

`src/tests/test-ignis-system.js`：把两处 `assertEqual(IGNIS_SPIKE.damage, 18, ...)` 改成 `1`，并追加：

```js
test('ignis aoe: 法阵与尖刺共用 1 格伤害（用户 2026-11-21）', () => {
  assertEqual(IGNIS_AOE.damage, 1, '两处新增伤害各 1 格');
  assertEqual(IGNIS_AOE.sigilHalfExtent, 2.0, '法阵足迹半宽 = 4×4 格的一半');
  assertTrue(IGNIS_AOE.damage < IGNIS.attackDamage, '小额伤害必须严格小于挥砍');
});

test('ignis aoe: 法阵足迹与渲染层的实时尺寸必须相等（跨层等式，唯一能比对的地方）', () => {
  // ⚠️ src/entities/ 在同构目录里，不得 import src/render/ ⇒ 这条单测是唯一的跨层守卫。
  // 不钉它的形态：有人把 FLAME_SIGIL.radius 改成 3（画面 6×6）而判定仍 4×4，
  // 所有数值断言全绿，只有「看着踩在图案上却不扣血」的手感抱怨。
  assertEqual(IGNIS_AOE.sigilHalfExtent, FLAME_SIGIL.radius);
});
```

⚠️ **本文件顶部 import 要补两项**：`IGNIS_AOE` 加进已存在的 `ignis-config.js` import 行；
`FLAME_SIGIL` 需要新增一行 `import { FLAME_SIGIL } from '../render/flame-sigil.js';`
（本文件已 import 了 `../render/ignis-renderer.js` 与 `ignis-model.js`，加载 three 与 render 层是它的常态，
所以跨层等式放这里合规 —— 反过来 `ignis-config.js` import `render/` 才违规）。

`test-spike-fx.js`：三处 `assertDeepEqual(..., [18])` 改 `[1]`；用例名 `'玩家站在尖刺格内扣 18，格外不扣'` 改 `'扣 1 格'`；`'不是每根 18'` 改 `'不是每根 1 格'`。

- [ ] **Step 2: 跑测试确认红**

Run: `node tools/run-unit-node.mjs --only=test-ignis-system.js`
Expected: FAIL，`IGNIS_AOE is not defined`。

- [ ] **Step 3: 加 `IGNIS_AOE` 并改尖刺伤害**

`src/entities/ignis/ignis-config.js` 在 `IGNIS_SPIKE` 之前插入：

```js
/**
 * 焰魔的**小额 AoE 伤害**（法阵 + 尖刺）—— 唯一权威（用户 2026-11-21）。
 *
 * | 消费方 | 判定 | 数值 |
 * |---|---|---|
 * | 地面火焰法阵（`shieldBash` / `spin`） | 玩家 AABB 与落点 ±`sigilHalfExtent` 的 XZ 矩形相交 | `damage` |
 * | 剑阵尖刺（`spikeSlash`） | 玩家 AABB 与任一刺所在格重叠 | `damage` |
 *
 * ⚠️ **与 `IGNIS.attackDamage`（14）是两份独立权威**：挥砍 / 旋斩 / 头部撞击 / 举盾砸击 /
 * 剑阵的刀砍仍扣 14，只有这两处「碰到就掉」的小额伤害是 1。
 *
 * ⚠️ **`sigilHalfExtent` 必须等于 `FLAME_SIGIL.radius`**（`render/` 侧画多大）。
 * `src/entities/` 在同构目录里（`tools/check-architecture.mjs` 的 `ISOMORPHIC_DIRS`）
 * ⇒ 不得 import `render/`，等式只能由 `test-ignis-system.js` 的单测跨层钉住。
 *
 * ⚠️ `sigilHalfExtent` 是**半宽**：法阵画出来是 `radius` 乘基准 `PlaneGeometry(2,2)`
 * ⇒ 实际边长 = `2 × radius` = 4 格。
 */
export const IGNIS_AOE = Object.freeze({
  damage: 1,
  sigilHalfExtent: 2.0,
});
```

`IGNIS_SPIKE.damage` 改 `1`，并把该字段注释改写为：

```js
  /**
   * 尖刺伤害（格）—— 走 `IGNIS_AOE.damage`（用户 2026-11-21 裁定「剑阵刺到玩家掉 1 格血」）。
   *
   * ⚠️ **推翻了 2026-11-21 早先的草图值 18**：草图给的是「伤害 18 点」，
   * 但同一天稍后用户明确要求「剑阵攻击的剑阵刺到玩家，玩家也掉 1 格血」⇒ 以最新指令为准。
   * 从 18 降到 1 后，一次完整尖刺攻击的总伤害 = 刀砍 14 + 刺 1 = 15。
   */
  damage: IGNIS_AOE.damage,
```

- [ ] **Step 4: 跑测试确认绿**

Run: `node tools/run-unit-node.mjs --only=test-ignis-system.js`
Expected: 全绿。跨层等式若红，说明 `FLAME_SIGIL.radius` 不是 2.0 —— 去核实后再决定改哪边。

Run: `node tools/run-unit-node.mjs --only=test-spike-fx.js`
Expected: 全绿。

- [ ] **Step 5: 提交**

```bash
git add src/entities/ignis/ignis-config.js src/tests/test-ignis-system.js src/tests/test-spike-fx.js
git commit -m "feat(ignis): 新增 IGNIS_AOE 权威，尖刺伤害 18 降为 1"
```

---

### Task 4: 法阵对玩家造成 1 格伤害

**Files:**
- Modify: `src/core/game.js:4154-4170`（法阵段落：伤害结算 + 伤害移出 `!flameSigil` 门控）
- Test: `src/tests/test-flame-sigil.js`（追加 6 条装配层用例）

**Interfaces:**
- Consumes: Task 3 的 `IGNIS_AOE.damage` / `IGNIS_AOE.sigilHalfExtent`
- Produces: 无新导出；`_consumeIgnisFxRequests` 的行为约定 —— `shieldBash` / `spin` 命中帧判定一次法阵伤害

- [ ] **Step 1: 写失败的测试**

在 `src/tests/test-flame-sigil.js` 末尾追加（复用 `test-fire-ring.js` 的 `Object.create(Game.prototype)` 造壳手法）。

⚠️ **本文件的既有 import 里没有 `Game` / `IGNIS_TYPE` / `IGNIS_AOE`** —— 必须在 Step 3 之前把它们加进顶部 import：

```js
import { Game } from '../core/game.js';
import { IGNIS_AOE, IGNIS_TYPE } from '../entities/ignis/ignis-config.js';
```

（照 `test-fire-ring.js:21-22` 的同一写法。）

```js
/**
 * 装配层壳：法阵伤害用例专用。
 * 玩家 AABB 宽 0.6（半宽 0.3）、高 1.8，与 PlayerPhysics 同口径。
 */
function sigilGameFixture({ playerPos, groundY = 10, flameSigil = true } = {}) {
  const game = Object.create(Game.prototype);
  const isSolid = (_x, y, _z) => y < groundY;
  game.world = { isSolid, getBlockId: (x, y, z) => (isSolid(x, y, z) ? 1 : 0) };
  game.registry = { nameOf: () => 'stone' };
  const damages = [];
  game._damagePlayer = (n) => { damages.push(n); return 40 - n; };
  const hw = 0.3;
  game.player = {
    physics: {
      pos: { x: playerPos[0], y: playerPos[1], z: playerPos[2] },
      overlapsBlock: (x, y, z) => {
        const [px, py, pz] = playerPos;
        return px - hw < x + 1 && px + hw > x
          && py < y + 1 && py + 1.8 > y
          && pz - hw < z + 1 && pz + hw > z;
      },
    },
  };
  const spawned = [];
  game.fireRing = { spawn: () => {} };
  game.spikeFx = { spawn: () => {} };
  // ⚠️ flameSigil: false 模拟 flame_sigil.png 加载失败（渲染器为 null 是允许的降级）
  game.flameSigil = flameSigil ? { spawn: (pts) => spawned.push(...pts) } : null;
  const state = { attackFxRequest: null };
  game.ignises = { activeEntities: () => [{ id: 'ignis:t:0', state }] };
  game.entities = { count: (t) => (t === IGNIS_TYPE ? 1 : 0) };
  return { game, state, damages, spawned };
}

test('法阵伤害: 玩家站在首段图案中心 ⇒ 扣 1 格（走 IGNIS_AOE.damage）', () => {
  // 焰魔在 (0.5, 10, 0.5)、yaw=0 ⇒ 正前方 = z 递减
  // 首段 firstOffset=0 ⇒ 落点在焰魔脚底 (0.5, 0.5)，半宽 2.0 ⇒ z ∈ [-1.5, 2.5]
  const f = sigilGameFixture({ playerPos: [0.5, 10, 0.5] });
  f.state.attackFxRequest = { at: [0.5, 10, 0.5], yaw: 0, kind: 'shieldBash' };
  f.game._consumeIgnisFxRequests(1000);
  assertDeepEqual(f.damages, [IGNIS_AOE.damage], `首段压到玩家须扣 1 格，实得 ${JSON.stringify(f.damages)}`);
  assertTrue(f.spawned.length > 0, '前置：法阵确实生成了');
});

test('法阵伤害: 玩家横向偏离到足迹外 ⇒ 不扣', () => {
  // 落点 z=0.5 ± 2.0 ⇒ z ∈ [-1.5, 2.5]；玩家 z = 6.0（超出首段），
  // 但第 2 段在 4.25 ⇒ z ∈ [2.25, 6.25] 会命中 ⇒ 必须沿 X 偏出去测
  // 首段中心 x=0.5，半宽 2.0 ⇒ x ∈ [-1.5, 2.5]；玩家 x = 6.0 ⇒ 远离所有段（各段 x 恒 0.5）
  const f = sigilGameFixture({ playerPos: [6.0, 10, 0.5] });
  f.state.attackFxRequest = { at: [0.5, 10, 0.5], yaw: 0, kind: 'shieldBash' };
  f.game._consumeIgnisFxRequests(1000);
  assertDeepEqual(f.damages, [], `足迹外不得扣血，实得 ${JSON.stringify(f.damages)}`);
});

test('法阵伤害: 四段全部压到玩家也只扣一次（break，不是每段各扣）', () => {
  // 段间距 4.25 / 半宽 2.0 ⇒ 相邻段边隙仅 0.25 格 < 玩家半宽 0.3
  // ⇒ 站在首段中心时，前后几段几乎必然也重叠 ⇒ 这条用例天然覆盖「多段同时命中」
  const f = sigilGameFixture({ playerPos: [0.5, 10, 0.5] });
  f.state.attackFxRequest = { at: [0.5, 10, 0.5], yaw: 0, kind: 'shieldBash' };
  f.game._consumeIgnisFxRequests(1000);
  assertEqual(f.spawned.length >= 4, true, '前置：至少 4 段法阵生成（多段重叠是常态）');
  assertDeepEqual(f.damages, [IGNIS_AOE.damage], `多段重叠仍只扣一次，实得 ${JSON.stringify(f.damages)}`);
});

test('法阵伤害: 扫不到地面（未加载列）⇒ 不扣，也不生成法阵', () => {
  const f = sigilGameFixture({ playerPos: [0.5, 10, 0.5], groundY: -100 });   // 全 air
  f.state.attackFxRequest = { at: [0.5, 10, 0.5], yaw: 0, kind: 'shieldBash' };
  f.game._consumeIgnisFxRequests(1000);
  assertEqual(f.spawned.length, 0, '未加载列不生成法阵');
  assertDeepEqual(f.damages, [], '未加载列不得扣血（回落 y 会在空中判伤害）');
});

test('法阵伤害: 法阵渲染器为 null（贴图加载失败）时伤害仍然生效', () => {
  // ⚠️ 这是审稿抓到的静默失效：伤害若写在 `!this.flameSigil` 门控内，
  // flame_sigil.png 加载失败 ⇒ 观感没了、玩法伤害也静默没了。
  const f = sigilGameFixture({ playerPos: [0.5, 10, 0.5], flameSigil: false });
  f.state.attackFxRequest = { at: [0.5, 10, 0.5], yaw: 0, kind: 'shieldBash' };
  f.game._consumeIgnisFxRequests(1000);
  assertEqual(f.game.flameSigil, null, '前置：渲染器缺席');
  assertDeepEqual(f.damages, [IGNIS_AOE.damage], '伤害不得挂在渲染器存在性上');
});

test('法阵伤害: 旋斩（spin）也铺法阵并扣 1 格（与举盾砸击同源）', () => {
  const f = sigilGameFixture({ playerPos: [0.5, 10, 0.5] });
  f.state.attackFxRequest = { at: [0.5, 10, 0.5], yaw: 0, kind: 'spin' };
  f.game._consumeIgnisFxRequests(1000);
  assertDeepEqual(f.damages, [IGNIS_AOE.damage], 'spin 也扣 1 格');
});

test('法阵伤害: 另三招（swing / spikeSlash / shieldSmash）不走法阵判定', () => {
  for (const kind of ['swing', 'shieldSmash']) {
    const f = sigilGameFixture({ playerPos: [0.5, 10, 0.5] });
    f.state.attackFxRequest = { at: [0.5, 10, 0.5], yaw: 0, kind };
    f.game._consumeIgnisFxRequests(1000);
    assertDeepEqual(f.damages, [], `${kind} 不得走法阵判定`);
  }
});
```

- [ ] **Step 2: 跑测试确认红**

Run: `node tools/run-unit-node.mjs --only=test-flame-sigil.js`
Expected: FAIL —— 用例 1 实得 `[]`（法阵目前零伤害）。

- [ ] **Step 3: 在 `game.js` 的法阵段落加伤害，并把伤害移出 `!flameSigil` 门控**

把现有段落（`game.js` 约 4154-4170）改为：

```js
      // ---- 地面火焰法阵（举盾砸击 + 旋斩）----
      // v3.09：旋斩也铺法阵（用户 2026-11-16）。
      // v3.29（用户 2026-11-21）：「法阵的图案如果在玩家脚底生成，玩家也掉 1 格血」。
      //
      // ⚠️⚠️ **门槛里刻意不含 `!this.flameSigil`**：伤害是玩法，渲染器是观感。
      // `flame_sigil.png` 加载失败时 `this.flameSigil` 为 null（`flame-sigil.js` 文件头
      // 明确允许这个降级）⇒ 若把伤害写进 `!this.flameSigil` 门控，观感降级会连带
      // **让玩法伤害静默消失**，而单测用 `flameSigil: null` 造壳还会把它读成
      // 「不扣血 = 正常」。伤害只依赖 `world` 与 `player`。
      if ((req.kind !== 'shieldBash' && req.kind !== 'spin') || !this.world) continue;
      const points = [];
      for (const p of sigilSpawnPoints(req.at, req.yaw)) {
        const y = this._findSigilGroundY(p.x, p.z, req.at[1]);
        // 扫不到地面（未加载列 / 悬崖外）⇒ **跳过该段**，不得回落到 y=0 或世界底
        if (y === null) continue;
        points.push({ x: p.x, y, z: p.z, delayMs: p.delayMs });
      }
      if (points.length === 0) continue;

      // 玩法：玩家 AABB 与任一段法阵的 XZ 足迹相交 ⇒ 扣 1 格，命中即 break
      //（四段共用一次机会，"一次攻击最多扣 1 格" 是用户 2026-11-21 的裁定）。
      //
      // ⚠️ **在 spawn 那一刻一次性判全部四段**，不追求「逐段在各自点亮时刻判定」：
      // 四段的点亮延迟（`sigilDelayMs` = 0/50/150/200ms）由 `flame-sigil.js` 渲染器
      // 内部按 `age >= delayMs` 决定，装配层完全看不到；而 `attackFxRequest` 是瞬态，
      // 本方法只在命中帧拿得到它。用户说的「图案在玩家脚底**生成**」就是这一刻。
      //
      // ⚠️ 判定用 **XZ 矩形重叠**，不是 `overlapsBlock`（那是单格）：法阵画出来是
      // `2 × sigilHalfExtent` = 4×4 格的面。高度不判 —— 法阵贴地，玩家不可能在它下方。
      const phys = this.player?.physics?.pos;
      if (phys) {
        const hw = 0.3;          // 玩家半宽，与 PlayerPhysics.PLAYER_WIDTH/2 同口径
        const pMinX = phys.x - hw, pMaxX = phys.x + hw;
        const pMinZ = phys.z - hw, pMaxZ = phys.z + hw;
        const e = IGNIS_AOE.sigilHalfExtent;
        for (const s of points) {
          if (pMaxX > s.x - e && pMinX < s.x + e
            && pMaxZ > s.z - e && pMinZ < s.z + e) {
            this._damagePlayer(IGNIS_AOE.damage);
            break;
          }
        }
      }

      this.flameSigil?.spawn(points, nowMs);
```

`game.js` 顶部 import 补 `IGNIS_AOE`（与既有的 `IGNIS` / `IGNIS_ATTACKS` / `IGNIS_SPIKE` 同一行来源）。

- [ ] **Step 4: 跑测试确认绿**

Run: `node tools/run-unit-node.mjs --only=test-flame-sigil.js`
Expected: 全绿。

Run: `node tools/run-unit-node.mjs --only=test-fire-ring.js`
Expected: 全绿（火圈是纯视觉，本轮一行未改；既有「举盾砸击仍同时铺地面法阵」用例必须仍过 —— 那正是 `points.length === 0` 提前 `continue` 不能误伤的路径）。

- [ ] **Step 5: 提交**

```bash
git add src/core/game.js src/tests/test-flame-sigil.js
git commit -m "feat(ignis): 法阵落在玩家脚下时扣 1 格血"
```

---

### Task 5: 受伤红闪覆盖层（纯函数 + DOM）

**Files:**
- Create: `src/ui/damage-flash.js`
- Create: `src/tests/test-damage-flash.js`
- Modify: `src/tests/index.html`（注册新单测）
- Modify: `tools/test-tiers.mjs`（进 `UNIT_NODE_SAFE`）

**Interfaces:**
- Consumes: 无
- Produces:
  - `export const DAMAGE_FLASH = Object.freeze({ bandPx: 40, lifeMs: 350, color: '200,0,0', maxAlpha: 0.55, zIndex: 56 })`
  - `export function flashOpacityAt(ageMs, cfg = DAMAGE_FLASH): number` —— 0..1，`ageMs <= 0` 返 1，`ageMs >= lifeMs` 返 0，NaN 返 0
  - `export class DamageFlash { constructor(root), show(nowMs), update(nowMs), dispose(), get active() }`

- [ ] **Step 1: 写失败的测试**

`src/tests/test-damage-flash.js`：

```js
// src/tests/test-damage-flash.js — 受伤红闪的纯函数契约（Tier 1）
//
// 只有淡出包络是有对错可言的逻辑（越界、NaN、边界）；DOM 布局由 E2E 像素用例覆盖。
import { test } from './runner.js';
import { assertEqual, assertTrue } from './assert.js';
import { DAMAGE_FLASH, flashOpacityAt } from '../ui/damage-flash.js';

test('damage flash: 常量口径（用户 2026-11-21 裁定）', () => {
  assertEqual(DAMAGE_FLASH.bandPx, 40, '屏幕四周 40 像素');
  assertEqual(DAMAGE_FLASH.lifeMs, 350, '0.35 秒淡出');
  assertTrue(DAMAGE_FLASH.zIndex > 55, '必须高于伤害数字 55');
  assertTrue(DAMAGE_FLASH.zIndex < 60, '必须低于设置按钮 60');
  assertTrue(DAMAGE_FLASH.maxAlpha > 0 && DAMAGE_FLASH.maxAlpha < 1, '半透明红');
});

test('damage flash: 淡出包络（起点全亮、终点归零、中点半亮）', () => {
  assertEqual(flashOpacityAt(0), 1, '刚被打中 = 全亮');
  assertEqual(flashOpacityAt(DAMAGE_FLASH.lifeMs), 0, '寿命到 = 全透明');
  assertTrue(Math.abs(flashOpacityAt(DAMAGE_FLASH.lifeMs / 2) - 0.5) < 0.02, '中点半亮（线性）');
});

test('damage flash: 越界与非法值一律钳制，不抛异常', () => {
  assertEqual(flashOpacityAt(-100), 1, '负 age 按刚触发算（不返 >1）');
  assertEqual(flashOpacityAt(DAMAGE_FLASH.lifeMs * 10), 0, '远超寿命 = 0');
  assertEqual(flashOpacityAt(NaN), 0, 'NaN 不产生 NaN 透明度（否则 DOM 写入被忽略）');
  assertEqual(flashOpacityAt(undefined), 0, 'undefined 同上');
});

test('damage flash: 包络单调不增（不得中途回亮）', () => {
  let prev = 1;
  for (let t = 0; t <= DAMAGE_FLASH.lifeMs; t += 10) {
    const o = flashOpacityAt(t);
    assertTrue(o <= prev + 1e-9, `t=${t} 时 ${o} > 前值 ${prev}`);
    prev = o;
  }
});
```

- [ ] **Step 2: 跑测试确认红**

Run: `node tools/run-unit-node.mjs --only=test-damage-flash.js`
Expected: FAIL，`Cannot find module '../ui/damage-flash.js'`。

- [ ] **Step 3: 实现 `src/ui/damage-flash.js`**

结构照 `ui/damage-numbers.js`（同一个 HUD 覆盖层口径）：外层 `position:fixed;inset:0;pointer-events:none`，内部四条绝对定位的渐变条。

```js
// src/ui/damage-flash.js — 玩家受伤时屏幕四周的红色闪光（用户 2026-11-21）
//
// 用户原话：「屏幕四周闪现一下掉血的动画，很简单，就是屏幕四周向内有一个 40 像素的
// 从半透明红到全透明红的渐变，表明玩家被攻击后掉血了」。
//
// ## 为什么是四条独立的 DOM 渐变条，而不是一张图 / 后处理 pass
//
// 与血心/小地图/伤害数字同口径：DOM 覆盖层零 draw call、零 GPU 开销。
// 四条边各自的 linear-gradient 能精确表达「从边缘向内 40px 淡到全透明」；
// 后处理 pass 要多一个 render pass，且与色调映射/天空盒的交互需要单独像素标定。
//
// ## 为什么用 rAF 驱动而不是 CSS transition
//
// 连续挨打时必须能**从全亮重头再闪**（用户裁定「任何掉血都闪」）。
// CSS transition 在元素已处于淡出中途时把 opacity 重新设为 1 的行为依赖浏览器的
// 中断语义，实测不可控；每帧自己写 opacity 是确定的。
//
// ⚠️ **四角由上下两条优先覆盖**（它们先插入）：观感是「边框亮、四角略重」，
// 这是刻意接受的 —— 用 radial-gradient 做精确角落会让每条边各画一个椭圆，
// 在这个 40px 的尺度上肉眼无差别，却多四层节点。
//
// ⚠️ 时间基准 `performance.now()`，禁止 `Date.now()`（相差约 17 亿毫秒 → 首帧即消失）。

/** 红闪的观感常量（用户 2026-11-21 裁定的三项：40px / 0.35s / 半透明红） */
export const DAMAGE_FLASH = Object.freeze({
  /** 渐变带宽度（CSS px）—— 用户裁定「40 像素」 */
  bandPx: 40,
  /** 总时长（ms）—— 用户裁定「0.35 秒快速一闪」 */
  lifeMs: 350,
  /** 颜色分量（`rgba(${color}, α)`）—— 深红，在亮草地与暗洞穴上都读得出 */
  color: '200, 0, 0',
  /** 边缘处的最大不透明度（半透明红） */
  maxAlpha: 0.55,
  /**
   * z-index = 56。
   * ⚠️ 改这里必须重核 `CLAUDE.md` 的 UI 层级不等式：
   * 50（血心/坐标） < 55（伤害数字） < **56（红闪）** < 60（设置按钮） < 70（设置面板）。
   * 不得取 100+（会盖掉 WebGPU 启动失败遮罩）。
   */
  zIndex: 56,
});

const sat = (x) => Math.max(0, Math.min(1, x));

/**
 * 淡出包络：0ms 全亮 → lifeMs 全透明，线性。
 *
 * ⚠️ **非法值一律钳制**：`ageMs >= lifeMs` 与 NaN 都返 0（写进 `style.opacity` 的 NaN
 * 会被浏览器静默忽略 ⇒ 红闪卡在上一帧的亮度上永不消失）。
 *
 * @param {number} ageMs 自触发起的毫秒数
 * @param {object} [cfg]
 * @returns {number} 0..1
 */
export function flashOpacityAt(ageMs, cfg = DAMAGE_FLASH) {
  if (!Number.isFinite(ageMs)) return 0;
  const t = sat(ageMs / cfg.lifeMs);
  return 1 - t;
}
```

`DamageFlash` 类：构造期建外层 + 四条边（`position:absolute` + 各自的 `linear-gradient`），`_startMs = -1`（未激活）；`show(nowMs)` 把 `_startMs = nowMs`；`update(nowMs)` 算 `flashOpacityAt(nowMs - _startMs)` 写到**外层** `style.opacity`（四条边共享一次写入），到 0 时置 `_startMs = -1` 并 `el.style.display = 'none'`；`active` 返回 `_startMs >= 0`。

四条边的渐变（每条 `position:absolute`，`display:block`）：

```js
const band = DAMAGE_FLASH.bandPx;
const [r, g, b] = [DAMAGE_FLASH.color];
const sides = [
  { css: `top:0;left:0;right:0;height:${band}px;`,
    grad: `linear-gradient(to bottom, rgba(${r},${g},${b},${maxAlpha}), rgba(${r},${g},${b},0))` },
  { css: `bottom:0;left:0;right:0;height:${band}px;`,
    grad: `linear-gradient(to top, rgba(…), rgba(…,0))` },
  { css: `top:0;left:0;bottom:0;width:${band}px;`,
    grad: `linear-gradient(to right, rgba(…), rgba(…,0))` },
  { css: `top:0;right:0;bottom:0;width:${band}px;`,
    grad: `linear-gradient(to left, rgba(…), rgba(…,0))` },
];
```

- [ ] **Step 4: 注册并跑测试确认绿**

`src/tests/index.html` 加 `import './test-damage-flash.js';`（放在 `test-health.js` 附近）。
`tools/test-tiers.mjs` 的 `UNIT_NODE_SAFE` 数组加 `'test-damage-flash.js'`（按字母序插在 `'test-cinder-render.js'` 之后）。

Run: `node tools/run-unit-node.mjs --only=test-damage-flash.js`
Expected: 全绿。

Run: `npm run check`
Expected: exit 0（`check:arch` 的测试注册双向钉住会确认新文件已注册）。

- [ ] **Step 5: 提交**

```bash
git add src/ui/damage-flash.js src/tests/test-damage-flash.js src/tests/index.html tools/test-tiers.mjs
git commit -m "feat(hud): 新增受伤红闪覆盖层"
```

---

### Task 6: 把红闪接到伤害唯一入口

**Files:**
- Modify: `src/core/game.js`（import + 构造 + 帧循环 `update` + `dispose` + `_damagePlayer`）
- Test: `tests/damage-flash.spec.mjs`（**新建**，Tier 4 像素）

**Interfaces:**
- Consumes: Task 5 的 `DamageFlash` / `DAMAGE_FLASH` / `flashOpacityAt`
- Produces: `this._damageFlash` 实例；`_damagePlayer(amount)` 在 `amount > 0` 时调用 `_damageFlash.show(nowMs)` —— **注意 `_damagePlayer` 需要新增第二个参数 `nowMs`**

- [ ] **Step 1: 写失败的 E2E 测试**

新建 `tests/damage-flash.spec.mjs`：

```js
import { test, expect } from 'playwright/test';
import { PNG } from 'pngjs';

// tests/damage-flash.spec.mjs — 受伤红闪的 Tier 4 像素实测
//
// 用户 2026-11-21：「屏幕四周闪现一下掉血的动画……40 像素的从半透明红到全透明红的渐变」。
//
// ⚠️ 像素基线必须冻住五个动态源（docs/pitfalls.md「像素基线」节）：
//   玩家下落 / 海面 / 第一人称手臂 / 昼夜 / viewBob+stepLift。
//   本用例用 ?shadows=0&reflect=0 + 等玩家落地 + 关掉手臂与 viewBob 来冻结；
//   若某个源无法关，改为「同一帧内 开/关 两张」的差分口径。

const SEED = 12345;

/** 屏幕四周 bandPx 带内的偏红像素数（判据：红显著高于绿蓝） */
function countEdgeRed(png, bandPx) {
  const { width, height, data } = png;
  let n = 0;
  for (let y = 0; y < height; y += 1) {
    const inBandY = y < bandPx || y >= height - bandPx;
    for (let x = 0; x < width; x += 1) {
      if (!inBandY && x >= bandPx && x < width - bandPx) continue;   // 只扫四边带
      const i = (width * y + x) * 4;
      if (data[i] > 90 && data[i] - data[i + 1] > 40 && data[i] - data[i + 2] > 40) n += 1;
    }
  }
  return n;
}

/** 屏幕中心区（远离四边）的偏红像素数 —— 红闪不该影响中心 */
function countCenterRed(png, bandPx) {
  const { width, height, data } = png;
  const x0 = Math.floor(width * 0.35), x1 = Math.floor(width * 0.65);
  const y0 = Math.max(bandPx * 2, Math.floor(height * 0.35));
  const y1 = Math.min(height - bandPx * 2, Math.floor(height * 0.65));
  let n = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const i = (width * y + x) * 4;
      if (data[i] > 90 && data[i] - data[i + 1] > 40 && data[i] - data[i + 2] > 40) n += 1;
    }
  }
  return n;
}

async function bootFrozen(page) {
  await page.goto(`/?vd=4&seed=${SEED}&shadows=0&reflect=0&stats=0`);
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 90_000 });
  // 等玩家真正落地（下坠会改变整个画面）
  await page.waitForFunction(() => {
    const p = window.__MC_GAME__.player.physics.pos;
    return window.__MC_GAME__.world.isSolid(Math.floor(p.x), Math.floor(p.y - 0.5), Math.floor(p.z));
  }, null, { timeout: 30_000 });
  await page.waitForTimeout(400);
}

test('受伤红闪 Tier 4：掉血后屏幕四周 40px 带变红，中心区不受影响', async ({ page }) => {
  test.setTimeout(180_000);
  await bootFrozen(page);

  // 先拍基线（未受伤）
  const before = PNG.sync.read(await page.screenshot());
  const edgeBefore = countEdgeRed(before, 40);
  const centerBefore = countCenterRed(before, 40);

  // 触发一次真实掉血，立刻截图（0.35s 寿命，截图在 ~50ms 内完成）
  await page.evaluate(() => window.__MC_GAME__._damagePlayer(1, performance.now()));
  const flashOn = await page.evaluate(() => window.__MC_GAME__._damageFlash.active);
  const after = PNG.sync.read(await page.screenshot());
  const edgeAfter = countEdgeRed(after, 40);
  const centerAfter = countCenterRed(after, 40);

  expect(flashOn, '前置：红闪已激活').toBe(true);
  expect(edgeAfter - edgeBefore,
    `四周带内偏红像素须显著增加（前 ${edgeBefore} → 后 ${edgeAfter}）`).toBeGreaterThan(2000);
  expect(Math.abs(centerAfter - centerBefore),
    `中心区不得被红闪污染（前 ${centerBefore} → 后 ${centerAfter}）`).toBeLessThan(200);
});

test('受伤红闪 Tier 4：0.35 秒后自动消失，回到基线', async ({ page }) => {
  test.setTimeout(180_000);
  await bootFrozen(page);

  const before = PNG.sync.read(await page.screenshot());
  const edgeBefore = countEdgeRed(before, 40);

  await page.evaluate(() => window.__MC_GAME__._damagePlayer(1, performance.now()));
  await page.waitForTimeout(600);   // 远超 lifeMs=350
  const faded = await page.evaluate(() => window.__MC_GAME__._damageFlash.active);
  const after = PNG.sync.read(await page.screenshot());
  const edgeAfter = countEdgeRed(after, 40);

  expect(faded, '红闪须已自动结束').toBe(false);
  expect(Math.abs(edgeAfter - edgeBefore),
    `淡出后须回到基线（前 ${edgeBefore} → 后 ${edgeAfter}）`).toBeLessThan(500);
});

test('受伤红闪 Tier 4：血量已为 0 时受击仍然闪（用户明确要求）', async ({ page }) => {
  test.setTimeout(180_000);
  await bootFrozen(page);

  // 把血打到 0（用户裁定：不死、停在 0）
  const hp = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    g._damagePlayer(999, performance.now());
    return g.player.health;
  });
  expect(hp, '前置：血量停在 0').toBe(0);
  await page.waitForTimeout(600);   // 让上一次红闪完全淡出

  const before = PNG.sync.read(await page.screenshot());
  const edgeBefore = countEdgeRed(before, 40);

  // 血已是 0，这次伤害不会改变血量 —— 但仍须闪
  const r = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    const before = g.player.health;
    g._damagePlayer(1, performance.now());
    return { before, after: g.player.health, active: g._damageFlash.active };
  });
  const after = PNG.sync.read(await page.screenshot());
  const edgeAfter = countEdgeRed(after, 40);

  expect(r.after, '前置：血量仍是 0（不死）').toBe(0);
  expect(r.active, '血量为 0 时受击仍须触发红闪').toBe(true);
  expect(edgeAfter - edgeBefore,
    `血量为 0 时四周带仍须变红（前 ${edgeBefore} → 后 ${edgeAfter}）`).toBeGreaterThan(2000);
});
```

- [ ] **Step 2: 跑测试确认红**

Run: `npx playwright test tests/damage-flash.spec.mjs`
Expected: FAIL，`window.__MC_GAME__._damageFlash` 为 undefined。

- [ ] **Step 3: 接线**

`src/core/game.js` 四处改动：

① import（与其它 `ui/` 同级位置）：

```js
import { DamageFlash } from '../ui/damage-flash.js';
```

② 构造（紧跟 `this._healthHud = new HealthHUD(...)` 之后，同属常驻 HUD）：

```js
    // 受伤红闪（用户 2026-11-21）：屏幕四周 40px 红色渐变，0.35s 淡出。
    // 挂 `#hud-root` 下 ⇒ Tier 4 像素用例隐藏 HUD 时一并被隐藏（与血心同口径）。
    this._damageFlash = new DamageFlash(this._hudRoot);
```

③ 帧循环（紧跟 `this._healthHud.update(nowMs);` 之后）：

```js
      // 受伤红闪：未激活时内部一次比较就 return（同血心的口径）
      this._damageFlash.update(nowMs);
```

④ `_damagePlayer` 加 `nowMs` 参数并触发（**签名变化，全部调用点要跟着传**）：

```js
  /**
   * @param {number} amount 伤害格数
   * @param {number} nowMs 帧循环的 `performance.now()` 基准时间戳
   *   ⚠️ **必须由调用方传入**，不得在方法内新取 —— 同帧两个时基会让红闪的起点
   *   与 `update(nowMs)` 的基准错开一截（帧内耗时），淡出曲线跟着漂。
   *   同 `_consumeIgnisFxRequests` / `_syncBossAudio` 口径。
   * @returns {number} 扣血后的剩余血量
   */
  _damagePlayer(amount, nowMs) {
    const before = this.player.health;
    const after = applyDamage(before, amount);
    this.player.health = after;
    // ⚠️ **判据是 `amount > 0`，不是 `after < before`**：用户 2026-11-21 明确要求
    // 「血量掉完，受到攻击时也显示这个掉血的动画」。血停在 0 后 `after === before === 0`，
    // 用「血量真的变了」当判据会让所有受击都不再闪。
    // 当前三条伤害路径（焰魔 attackRequest / 尖刺 attackFxRequest / 守卫 attackRequest）
    // 都是瞬态的一次性判定，不会每帧重复触发 ⇒ 不会刷成常亮。
    if (Number.isFinite(amount) && amount > 0) {
      this._damageFlash?.show(nowMs);
    }
    // 音效保持既有口径：血量没真的变就**不响**（血为 0 时站在 Boss 面前不刷音效）
    if (after < before) {
      this.audioManager?.play('ignis_hurt', SOUND_VOLUMES.ignis_hurt);
    }
    return after;
  }
```

**同步改三处调用点传 `nowMs`**（实测行号）：

| 文件位置 | 现状 | 改法 |
|---|---|---|
| `game.js:4043` | `_consumeIgnisAttackRequests() {` | 加形参 → `_consumeIgnisAttackRequests(nowMs) {` |
| `game.js:4206` | `_consumeGuardianAttackRequests() {` | 加形参 → `_consumeGuardianAttackRequests(nowMs) {` |
| `game.js:4095` | `_consumeIgnisFxRequests(nowMs) {` | 已有 `nowMs`，直接把 `this._damagePlayer(IGNIS_SPIKE.damage)` 改成 `this._damagePlayer(IGNIS_SPIKE.damage, nowMs)` |

帧循环的调用点 `game.js:1457 / 1459` 同时改成传 `nowMs`（`:1462` 已经传了）。

⚠️ 不要为了图省事在 `_damagePlayer` 内部新取 `performance.now()` —— 那样红闪起点与同帧 `update(nowMs)`
会差一个帧内耗时，淡出曲线跟着漂（同 `_consumeIgnisFxRequests` 文件头记录的同类教训）。

⚠️ **单测里的 fake `_damagePlayer` 不受影响**（`test-spike-fx.js:527` 的 `(n) => …`、
`test-fire-ring.js:466` 的 `() => 20`）：它只是多传了一个被忽略的实参，JS 不会报错。
但**必须在跑那三个文件时确认它们仍绿**，而不是假定。

- [ ] **Step 4: 跑测试确认绿**

Run: `npx playwright test tests/damage-flash.spec.mjs`
Expected: 3/3 PASS。

Run: `npm run check`
Expected: exit 0（lint 不得引入新 warning —— 改完 `_damagePlayer` 后所有调用点必须传 `nowMs`）。

- [ ] **Step 5: 提交**

```bash
git add src/core/game.js tests/damage-flash.spec.mjs
git commit -m "feat(hud): 受伤红闪接到伤害唯一入口（血量归零后仍闪）"
```

---

### Task 7: 收尾——既有用例的语义迁移与文档

**Files:**
- Modify: `tests/ignis.spec.mjs:716`（`hpStart` 20→40）+ 新增两条 AoE 用例
- Modify: `tests/boss-audio.spec.mjs:600`（`< 20` → `< 40` + 注释）
- Modify: `docs/roadmap.md`（v3.29 版本行）
- Modify: `CLAUDE.md`（UI 层级不等式补 56）

**Interfaces:**
- Consumes: Task 1~6 的全部产物
- Produces: 无

- [ ] **Step 1: 修既有断言（先确认它们红）**

Run: `npx playwright test tests/ignis.spec.mjs -g "挥剑真的扣玩家血"`
Expected: FAIL，`hpStart` 为 40 而非 20 —— 这证明 Task 1 真的生效了。

改 `tests/ignis.spec.mjs:716`：

```js
expect(r.hpStart, '起始满血 40（2026-11-21 血量翻倍）').toBe(40);
expect(r.damage, `应为一次完整伤害 ${r.expectedDamage}`).toBe(r.expectedDamage);
expect(r.hpEnd, '40 − 14 = 26').toBe(26);
```

改 `tests/boss-audio.spec.mjs:600` 附近的等待条件与注释：

```js
  // 等玩家真的被砍到（血量下降）。焰魔 14 伤害 / 玩家 40 格血 ⇒ 需要三刀才归 0，
  // 故窗口内只要看到一次扣血即可（不要求多次）。
  await page.waitForFunction(() => {
    const g = window.__MC_GAME__;
    return (g.audioDebugState().playRequests.ignis_hurt ?? 0) > 0 && g.player.health < 40;
  }, null, { timeout: 40_000 });
```

- [ ] **Step 2: 加两条 AoE E2E 用例**

在 `tests/ignis.spec.mjs` 末尾追加（沿用该文件既有的「塞请求 → 同步调消费点」手法，注释里说明为什么要这样做）：

```js
test('战斗(v3.29)：法阵落在玩家脚下 ⇒ 扣 1 格', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto(`/?seed=${SEED}`);
  await waitWorldReady(page);
  await teleportToTarnCenter(page);
  await waitPlayerLanded(page);

  const r = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    const { IGNIS_AOE } = await import('/src/entities/ignis/ignis-config.js');
    const sum = g.ignises.summon('tarn:e2e:aoe', Math.floor(g.player.physics.pos.x),
      Math.floor(g.player.physics.pos.z) + 1, 1);
    if (!sum.ok) return { err: sum.reason };
    const ignis = g.ignises.activeEntities()[0];
    const p = g.player.physics.pos;
    const hpBefore = g.player.health;
    // 直接塞请求 + 同步调消费点：attackFxRequest 是瞬态，等 AI 起手不可控
    //（与既有「旋斩锥宽」用例同一手法）
    ignis.state.attackFxRequest = {
      at: [p.x, p.y, p.z + 1], yaw: 0, kind: 'shieldBash',
    };
    g._consumeIgnisFxRequests(performance.now());
    return { hpBefore, hpAfter: g.player.health, expect: IGNIS_AOE.damage };
  });

  expect(r.err).toBeUndefined();
  expect(r.hpBefore - r.hpAfter, `法阵须扣 ${r.expect} 格`).toBe(r.expect);
});

test('战斗(v3.29)：剑阵尖刺刺到玩家 ⇒ 扣 1 格（不是 18）', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto(`/?seed=${SEED}`);
  await waitWorldReady(page);
  await teleportToTarnCenter(page);
  await waitPlayerLanded(page);

  const r = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    const { IGNIS_AOE } = await import('/src/entities/ignis/ignis-config.js');
    const sum = g.ignises.summon('tarn:e2e:spike2', Math.floor(g.player.physics.pos.x),
      Math.floor(g.player.physics.pos.z) + 1, 1);
    if (!sum.ok) return { err: sum.reason };
    const ignis = g.ignises.activeEntities()[0];
    const p = g.player.physics.pos;
    // yaw=0 ⇒ 正前方 = z 递减；玩家站在焰魔前方 6 格（第 3 根刺的位置）
    ignis.state.attackFxRequest = {
      at: [p.x, p.y, p.z + 6], yaw: 0, kind: 'spikeSlash',
    };
    // 把玩家挪到那一根刺上
    g.player.physics.pos.x = p.x;
    g.player.physics.pos.z = p.z + 6 - 6;    // 前方 6 格
    const hpBefore = g.player.health;
    g._consumeIgnisFxRequests(performance.now());
    return { hpBefore, hpAfter: g.player.health, expect: IGNIS_AOE.damage };
  });

  expect(r.err).toBeUndefined();
  expect(r.hpBefore - r.hpAfter, `尖刺须扣 ${r.expect} 格（不再是 18）`).toBe(r.expect);
});
```

⚠️ 第二条第 3 步的坐标算术在落地时必须按 `spikeSpawnPoints([0.5,10,0.5], 0)` 的真实输出核定（首根在前方 2 格、间距 2），不能照抄这里的手算值 —— 先在浏览器里打印一次真实落点再定站位。

- [ ] **Step 3: 跑 E2E 确认绿**

Run: `npx playwright test tests/ignis.spec.mjs tests/health-hud.spec.mjs tests/boss-audio.spec.mjs`
Expected: 全绿。

- [ ] **Step 4: 文档**

`docs/roadmap.md` 版本表首行插入 v3.29（照既有格式：版本 / 一句话摘要 / 状态 / 详细段落），内容必须覆盖：

- 用户 2026-11-21 的原始请求（四条）+ 后续两项裁定（火圈回到纯视觉、法阵一次攻击最多扣 1 格）
- **三条被推翻的旧裁定**：尖刺草图值 18 → 1；「焰魔两刀打死满血」→ 三刀；法阵「跟随火圈外推的环带」判定 → 从未实施
- 法阵足迹 4×4 与相邻段边隙 0.25 格 < 玩家半宽 0.3 格的事实（「几乎必定扣 1 格」是意图，不是缺陷）
- 跨层等式 `IGNIS_AOE.sigilHalfExtent === FLAME_SIGIL.radius` 由单测钉住，因为同构目录不能 import `render/`
- 红闪判据是 `amount > 0` 而非「血量真的变了」（血量为 0 时仍闪）
- 验证证据：命令与实际输出

`CLAUDE.md` 的「UI 层级不等式」一行补上 56：

```
hotbar 40 < 迷你地图 45 < 坐标/性能面板 50 = 血心 50 < 伤害数字 55 < **受伤红闪 56** <
设置按钮 60 < 设置面板 70 < 背包 80 < 背包 hover 浮层 85 < toast 90 < 启动 loading 95 < 启动错误遮罩 100
```

⚠️ `AGENTS.md` 是 `CLAUDE.md` 的符号链接 ⇒ 只改 `CLAUDE.md`，用 `git show --stat` 核对它真在提交里。

- [ ] **Step 5: 全量门禁 + 提交**

Run: `npm run check`
Expected: exit 0。

Run: `node tools/run-unit-node.mjs --all`
Expected: 全绿（本计划动了 `player/health.js`、`ignis-config.js`、`ui/` 三个被大量 spec 间接消费的位置，整跑比逐个 grep 便宜）。**不跑** `npm test`（全套 spec 需要「里程碑/发版/全局基础设施」三种理由之一，本轮都不满足）。

```bash
git add tests/ignis.spec.mjs tests/boss-audio.spec.mjs docs/roadmap.md CLAUDE.md
git commit -m "test(ignis): AoE 伤害 E2E + 血量翻倍的既有断言迁移 + roadmap v3.29"
```

---

### Task 8: 负向验证（每条注入都必须真红）

**Files:** 全部是被注入的既有文件，**验证完必须用 `cp` 副本还原**。

**Interfaces:**
- Consumes: Task 1~7 的全部产物
- Produces: 无（只为证伪）

⚠️⚠️ **两条硬规则**（仓库实测教训）：

1. **还原必须用 `cp` 副本，不用 `git checkout` / `git restore`** —— 工作区可能有其他未提交改动，
   `git checkout` 会把它们一起吞掉（本仓已发生过一次真实数据丢失）。
   做法：注入前 `cp <file> /tmp/neg-backup-<n>.<ext>`，验完 `cp /tmp/neg-backup-<n>.<ext> <file>`。
2. **注入必用 `edit` 工具，不用 `sed -i`** —— `sed` 不匹配时静默不写入，你会以为注入了而实际没有。
   注入后用 `grep` 读回源码，确认改动真的落地了。

- [ ] **Step 1: N1 —— 尖刺伤害改回 18**

把 `ignis-config.js` 的 `damage: IGNIS_AOE.damage` 临时改成 `damage: 18`（先 `cp` 备份）。

Run: `node tools/run-unit-node.mjs --only=test-spike-fx.js,test-ignis-system.js`
Expected: **FAIL** —— `test-spike-fx.js` 三处 `[1]` 断言与 `test-ignis-system.js` 的 `IGNIS_SPIKE.damage === 1` 均红。
若全绿 ⇒ 说明断言根本没读那个字段，停下来查。
还原并再跑一次确认绿。

- [ ] **Step 2: N2 —— 法阵去掉 `break`（改成逐段各扣）**

把 `game.js` 法阵伤害循环里的 `break;` 注释掉（先 `cp` 备份）。

Run: `node tools/run-unit-node.mjs --only=test-flame-sigil.js`
Expected: **FAIL** —— 「四段全部压到玩家也只扣一次」用例红（`damages` 长度 > 1）。
还原并再跑一次确认绿。

- [ ] **Step 3: N3 —— 红闪 z-index 取 100**

把 `damage-flash.js` 的 `zIndex: 56` 改成 `100`（先 `cp` 备份）。

Run: `node tools/run-unit-node.mjs --only=test-damage-flash.js`
Expected: **FAIL** —— 「必须低于设置按钮 60」断言红。
还原并再跑一次确认绿。

- [ ] **Step 4: N4 —— 只改心数常量、HUD 仍单排**

把 `health-hud.js` 的构造回退成单层循环（不建两行）（先 `cp` 备份）。

Run: `npx playwright test tests/health-hud.spec.mjs -g "血心"`
Expected: **FAIL** —— 必须是 **「第二排在第一条正下方」** 或 `rowCounts` 断言红。
⚠️ **若只有像素断言红/全绿，说明这两条几何断言没生效** —— 这正是设计稿里
「只改常量会画出 20 颗单排、像素计数照样过 400」那个零判别力坑（审稿拓到），必须修断言。
还原并再跑一次确认绿。

- [ ] **Step 5: N5 —— 法阵伤害放回 `!this.flameSigil` 门控内**

把 `game.js` 的门槛改成 `… || !this.flameSigil || !this.world) continue;`（先 `cp` 备份）。

Run: `node tools/run-unit-node.mjs --only=test-flame-sigil.js`
Expected: **FAIL** —— 「法阵渲染器为 null 时伤害仍然生效」用例红。
还原并再跑一次确认绿。

- [ ] **Step 6: N6 —— 红闪判据退化成「血量真的变了」**

把 `game.js` 的 `if (Number.isFinite(amount) && amount > 0)` 改成 `if (after < before)`（先 `cp` 备份）。

Run: `npx playwright test tests/damage-flash.spec.mjs -g "血量为 0"`
Expected: **FAIL** —— 「血量为 0 时受击仍须触发红闪」用例红。
还原并再跑一次确认绿。

- [ ] **Step 7: 确认全部副本已还原、工作区干净**

Run: `git status --short`
Expected: 只列出本计划要提交的文件（或全空，若已提交），**不得出现 `/tmp` 副本残留被误拷入**。
Run: `npm run check`
Expected: exit 0（证明还原后源码回到正确状态）。

⚠️ **本 Task 不产生 commit**（纯验证）。若某条注入后仍绿，**停下来报告**，
不要把「注入未生效」记成「判据无效」直接过。

---

## 自审记录

**Spec 覆盖**：§2 现状 → Task 1/3/4 的前提已核实；§3 七条裁定 → 尖刺(T3)、法阵(T4)、火圈「不加伤害」(全局约束)、红闪任何掉血(T6)、0.35s(T5 常量)、一次攻击一次(T4 用例③)、两排(T2)、DOM(T5)。§6-A 尖刺→T3；§6-B 法阵→T4；§6-B′ 足迹权威→T3+T4；§6-C 血量→T1+T2；§6-D 红闪→T5+T6。§7 文件清单 → 每个文件都在某个 Task 的 Files 里（含审稿补上的 `test-spike-fx.js`、`boss-audio.spec.mjs`、`ignis.spec.mjs:716`、`test-health.js` 设计判据）。§9 验证 → 各 Task 的 Step 4 + Task 7 的全量门禁 + **Task 8 的六条负向验证**（从设计稿 §9 逐条落地，不再只是「分布在判据设计里」）。

**类型一致性**：`IGNIS_AOE.damage` / `IGNIS_AOE.sigilHalfExtent` / `flashOpacityAt(ageMs, cfg)` / `DamageFlash.{show,update,dispose,active}` / `_damagePlayer(amount, nowMs)` —— 跨 Task 引用一致。

**Review Focus 五条**均有对应判据：① 跨层等式（T3 Step 1）；② `flameSigil: null` 用例（T4 用例⑤）；③ `break` 用例（T4 用例③ + T5 既有）；④ 两排几何断言（T2）；⑤ 血量为 0 仍闪（T6 用例③）。

**数量上的诚实**：本计划 8 个 Task（T8 为纯验证、不提交）、约 45 个 Step。其中 T3/T4 是纯逻辑（单测闭环），
T2/T6 必须 Tier 4 像素（血心与红闪都是「画面上看得见的东西」，数值断言抓不到）。
最容易被误判为「顺手改」的是 T1 —— 它以两个常量的改动为开端，但真实代价在它连锁推翻的四处既有断言，
因此独立成 Task 且单独提交。

**可执行性核对（写完计划后实际跑了命令核对，不是凭记忆）**：

- `tools/run-unit-node.mjs` 的真实参数是 `--only=a.js,b.js`（等号，`:37`）⇒ 计划里 10 处已全部改成等号语法；
- `test-flame-sigil.js` 顶部**没有** `Game` / `IGNIS_TYPE` / `IGNIS_AOE` 的 import ⇒ Task 4 Step 1 已写明要补；
- 跨层等式放 `test-ignis-system.js` 而不是 `test-flame-sigil.js`：前者已 import 了 `../render/` 且加载 three（合规），
  且它已经有 `ignis-config.js` 的 import 行需要补 `IGNIS_AOE`；
- `_consumeIgnisAttackRequests()`（`:4043`）与 `_consumeGuardianAttackRequests()`（`:4206`）**没有** `nowMs` 形参
  ⇒ Task 6 列出了逐个文件行号的改法；
- 单测里的 fake `_damagePlayer`（`test-spike-fx.js:527`、`test-fire-ring.js:466`）参数个数少一个，
  多传实参不会报错，但 Task 6 要求重跑确认。
