# 浅水高台 v2.15（不规则湖岸 / 接壤水系 / moss 换深草）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让浅水高台的湖岸不再是正圆、接壤海洋时水面直接连通（水下按坡度接壤），并把五个模型里 21,535 格 `moss` 全部换成深草 `dark_grass`。

**Architecture:** 湖岸改为径向谐波 `R(θ)`（纯函数 + seed 相位），三条带按 `e = d − R(θ)` 判定；干湿两态由**既有的**平滑自然高度 `hS` 单一决定（`hS ≥ 0` 逐位等于现行为，`hS ≤ SEA_Y-1` 下沉成水下坡）。材质侧把「草分块的载体」从基准色 `dark_grass` 换成真方块标记 `light_grass`（`green_wool` 也烘成 `dark_grass`，两者必须可区分；**标记不能用香草 `grass`** —— 刷草扫整列，缓坡带地表就是 `grass`，实测会把普通地形草一起刷掉）。

**Tech Stack:** 纯 JS ESM（无编译）、Worker 同构纯函数、Playwright（浏览器内单测 + 真游戏页 Tier 4）、`npm run check:data` 关系式门禁。

**Spec:** `docs/superpowers/specs/2026-11-01-shallow-water-tarns-design.md`（v2.15 修订：§1 R16~R19 / §5.1 / §6.3 / §8.1 / §10(7)(8) / §11 / **§14 全部**）

## Global Constraints

- **提交纪律**：本仓 `AGENTS.md` 规定「提交必须等用户明确指令」。所有 `Commit` 步骤在获得用户明确授权前**只暂缓、不执行**；任务完成以「验证命令全绿」为准。
- **数据只有一份权威（红线 1）**：湖形、草标记、贴图名都只在一处定义，消费者 import；`SHALLOW_TARN_PALETTE` / `BLOCK_MAP` / `GRASS_MARKER_BLOCK` 的唯一权威是 `src/gen/structures/shallow-water-tarn-data.js`（浏览器侧）与 `tools/shallow-tarns-fingerprint.mjs`（node 侧，**re-export** 前者，不得再写一份字面量）。
- **`src/**` 与浏览器单测绝不能 import `tools/*.mjs`**（`node:fs` → 模块不加载 → 白屏）。
- **生成路径不记 edits、不 bump version**（与 `fillColumn` / `fillTarnPlateau` 同口径）。
- **实测先于断言**：任何阈值/常量都必须先在真实数据上跑一次并打印实际值，再写进断言（`docs/testing-policy.md` §2.6 ⑤）。
- **负向验证**：每条新门禁都要注入一次回退并确认**真红**；撤销注入必须用 `cp` 副本还原，**禁止 `git checkout` / `git restore`**（本仓发生过未提交改动被冲掉）。
- 湖底恒 `SEA_Y-1`、水深 0.5 格、五座台地选型/环半径 45/间距 6/湖底高度、`CAPACITY` 全部**不动**。
- 数值常量（spec §14.2）：`LAKE_RADIUS = 102`、谐波 `k=[2,3,5,7] / amp=[2.5,1.9,1.2,0.7] / φ=[0,1.7,3.4,5.1]`、salt **1037**（已程序化扫描：1020~1036 被高台地带与浅水高台占用，1037~1099 空闲）。

## Review Focus

（spec 隐含、但没有哪个任务能直接单测「用户会不会被坑」的五类输入；每条都已经指派给某个任务的用例）

1. **玩家沿干沙滩行走**：相邻列不得出现 ≥2 格高差（要跳）。→ Task 2 的「逐方向单步落差 ≤1」+ Task 3 的干态单调抬升。
2. **最窄方位的台地余量**：湖岸内凹到 95.7 时台地（最远角 92.4）仍须整体在水里。→ Task 2 的「每个 AABB 角 `d < R(角)`」。
3. **接壤处的水下坡**：从湖底（0.5 深）到自然水底（实测最深 -15）之间必须连续、无台阶。→ Task 3 的湿态单调下降 + 单步 ≤1。
4. **接壤坡面上的水面平面**：放大门控后必须覆盖整条水下方坡（否则只剩无波纹的体素水顶面 —— v2.14 修过的形态）；同时**干燥列不得冒出假水面**。→ Task 4 的两条判据（覆盖率下界 + 「干燥列地表恒高于平面」）。
5. **草标记的残留**：`grass` 是临时标记，刷色漏跑时平台上会出现香草方块。→ Task 5 的真实页面断言「平台顶层 `grass` 数 = 0」。

---

### Task 1: 材质 —— moss 全部换深草 + 草标记改真方块

**Files:**
- Modify: `src/gen/structures/shallow-water-tarn-data.js`（`GRASS_BASE_BLOCK` → `GRASS_MARKER_BLOCK`，值改 `'grass'`）
- Modify: `tools/shallow-tarns-fingerprint.mjs`（`BLOCK_MAP` / `SHALLOW_TARN_PALETTE` / re-export 标记常量）
- Modify: `tools/bake-shallow-tarns.mjs`（改 import 名与普查文案）
- Modify: `src/gen/structures/shallow-water-terrain.js`（`paintShallowTarnGrass` 扫标记而非基准色）
- Re-bake: `assets/structures/shallow_tarn_0{1..5}.json` + `shallow_tarns.meta.json`
- Modify: `tools/check-data.mjs`（`[浅水高台]` 新增三条关系式断言）
- Test: `src/tests/test-shallow-water-tarns.js`

**Interfaces:**
- Produces: `GRASS_MARKER_BLOCK = 'grass'`（`shallow-water-tarn-data.js` 导出；`tools/shallow-tarns-fingerprint.mjs` re-export 同名常量）。
- Produces: `paintShallowTarnGrass(column, anchor, seed, registry, setBlock)` 语义变为「把每格 `GRASS_MARKER_BLOCK` 按噪声刷成 `dark_grass`/`light_grass`」，签名不变。
- Produces: 烘焙产物 palette 不含 `moss`，含 `grass` 与 `dark_grass`。

- [ ] **Step 1: 只重命名，不动值（零行为变更）**

`shallow-water-tarn-data.js`：`export const GRASS_BASE_BLOCK = 'dark_grass'` → `export const GRASS_MARKER_BLOCK = 'dark_grass'`（**值先不动**），注释改为「草标记方块：烘焙产物里代表素材 `grass_block` 的格」。
同步改 4 个消费点：`tools/shallow-tarns-fingerprint.mjs`（改为 `import { ..., GRASS_MARKER_BLOCK } from '../src/gen/structures/shallow-water-tarn-data.js'` 并 `export { GRASS_MARKER_BLOCK }`，**删掉本地那份字面量**）、`tools/bake-shallow-tarns.mjs`、`src/gen/structures/shallow-water-terrain.js`、`tools/check-data.mjs`。

验证：`npm run check && npx playwright test tests/harness.spec.mjs` → 全绿（零行为变更）。

- [ ] **Step 2: 写失败测试（paint 只吃标记格）**

在 `src/tests/test-shallow-water-tarns.js` 第 ④ 节追加：

```js
test('shallowTarn: paintShallowTarnGrass 只改标记格，不碰其它草方块', () => {
  const reg = registry();
  const a = computeShallowTarnAnchor(DEFAULT_SEED);
  const col = new ChunkColumn(Math.floor(a.wx / 16), Math.floor(a.wz / 16));
  const markerId = reg.idOf(GRASS_MARKER_BLOCK);
  const darkId = reg.idOf('dark_grass');
  const mossId = reg.idOf('moss');
  const y = a.lakeFloorY + 4;
  // 三簇各 4 格：标记 / 深草 / 苔藓（同一 y，避免互相影响）
  const cells = [];
  for (let i = 0; i < 4; i++) {
    col.blocks[blockIndex(i * 3, y, 0)] = markerId; cells.push([i * 3, 0, 'marker']);
    col.blocks[blockIndex(i * 3, y, 1)] = darkId;   cells.push([i * 3, 1, 'dark']);
    col.blocks[blockIndex(i * 3, y, 2)] = mossId;   cells.push([i * 3, 2, 'moss']);
  }
  paintShallowTarnGrass(col, a, DEFAULT_SEED, reg, (wx, wy, wz, name) => {
    col.blocks[blockIndex(wx - col.cx * 16, wy, wz - col.cz * 16)] = reg.idOf(name);
  });
  let markerLeft = 0, painted = 0, othersChanged = 0;
  for (const [lx, lz, kind] of cells) {
    const id = col.blocks[blockIndex(lx, y, lz)];
    if (kind === 'marker') {
      if (id === markerId) markerLeft++;
      else if (id === reg.idOf('light_grass') || id === reg.idOf('dark_grass')) painted++;
    } else if (kind === 'dark') {
      if (id !== darkId) othersChanged++;
    } else if (id !== mossId) othersChanged++;
  }
  assertEqual(markerLeft, 0, '标记格必须被刷掉（否则世界里留下香草草方块）');
  assertEqual(painted, 4, '标记格必须刷成 dark/light_grass');
  assertEqual(othersChanged, 0, '非标记格（dark_grass / moss）必须逐格不变');
});
```

（`paintShallowTarnGrass` 与 `GRASS_MARKER_BLOCK` / `blockIndex` 需加进本文件顶部的 import 清单。）

- [ ] **Step 3: 跑测试确认 RED**

Run: `npx playwright test tests/harness.spec.mjs`
Expected: FAIL —— `非标记格（dark_grass / moss）必须逐格不变`（当前实现扫 `dark_grass` 会把 `dark` 那 4 格刷成 `light_grass`，`othersChanged = 4`）。

- [ ] **Step 4: 改标记值 + 映射表 + 刷色目标**

```js
// shallow-water-tarn-data.js
export const GRASS_MARKER_BLOCK = 'grass';
```

```js
// tools/shallow-tarns-fingerprint.mjs（BLOCK_MAP）
green_wool: 'dark_grass',              // 用户 2026-11-02：moss 全部换深草
grass_block: GRASS_MARKER_BLOCK,       // 'grass'，光栅化后刷成 dark/light_grass
```

```js
// SHALLOW_TARN_PALETTE：删 'moss'，加 GRASS_MARKER_BLOCK
export const SHALLOW_TARN_PALETTE = Object.freeze([
  'light_gray_cloth', 'stone', 'stone_diorite', 'polished_blackstone_bricks',
  'dark_grass', 'light_grass', GRASS_MARKER_BLOCK,
]);
```

`paintShallowTarnGrass` 的扫描目标改成 `GRASS_MARKER_BLOCK`（`const markerId = registry.idOf(GRASS_MARKER_BLOCK)`），并更新函数头注释（数据流 `grass_block → grass → dark/light`；`green_wool → dark_grass` 为终态）。

- [ ] **Step 5: 重新烘焙**

Run: `npm run shallowtarns`
Expected：5 个产物重写；`shallow_tarn_01` 含草（palette 有 `grass` 与 `dark_grass`、**无 `moss`**），`shallow_tarn_05` 只有 `dark_grass`（该分量本来就没有 `grass_block`），meta 里 `blockMap.green_wool === "dark_grass"`。

- [ ] **Step 6: 跑测试确认 GREEN**

Run: `npx playwright test tests/harness.spec.mjs`
Expected: PASS。

- [ ] **Step 7: check:data 三条关系式断言**

在 `tools/check-data.mjs` 的 `checkShallowTarns()` 里，② 号循环内补：

```js
// ⑦ moss 必须已全部迁出（用户 2026-11-02）
if (json.palette.includes('moss')) fail(`${base}: palette 仍含 moss（moss 应全部换成 dark_grass）`);
// ⑧ 两条格数关系式（不硬编码格数，改选型/改素材自动跟随）
const GRASS_MARKER = SHALLOW.GRASS_MARKER_BLOCK;   // 'grass'，不写字面量
const counts = new Map();
for (let i = 3; i < json.blocks.length; i += 4) {
  const n = json.palette[json.blocks[i]];
  counts.set(n, (counts.get(n) || 0) + 1);
}
const src = meta.variantMetrics?.[base]?.sourceCounts || {};
const expectDark = src.green_wool || 0;
const expectMarker = src.grass_block || 0;
if ((counts.get('dark_grass') || 0) !== expectDark) {
  fail(`${base}: dark_grass ${counts.get('dark_grass') || 0} 格 ≠ 素材 green_wool ${expectDark} 格`);
}
if ((counts.get(GRASS_MARKER) || 0) !== expectMarker) {
  fail(`${base}: ${GRASS_MARKER} ${counts.get(GRASS_MARKER) || 0} 格 ≠ 素材 grass_block ${expectMarker} 格`);
}
```

并把 ④ 段的 `GRASS_BASE_BLOCK` 判断改为「`GRASS_MARKER_BLOCK` 在白名单内 **且** 已注册」（`BLOCKS.some(b => b.name === SHALLOW.GRASS_MARKER_BLOCK)`），成功行文案同步。
（`GRASS_MARKER` 用 `SHALLOW.GRASS_MARKER_BLOCK` 取，不写字面量。）

- [ ] **Step 8: 跑门禁 + 负向验证**

Run: `npm run check:data`
Expected: `[浅水高台] … 共 … 格 / palette 全在白名单 / 源方块全映射 / 草标记 grass / 指纹匹配`。

负向验证（**必须真红**）：
1. `cp tools/shallow-tarns-fingerprint.mjs /tmp/fp.bak.mjs`
2. 把 `green_wool` 改回 `'moss'`、`SHALLOW_TARN_PALETTE` 加回 `'moss'`（否则先被白名单拦下，看不到 ⑦ 的判据）→ `npm run shallowtarns` → `npm run check:data`
3. Expected: `✗ [浅水高台] shallow_tarn_01: palette 仍含 moss`
4. 还原：`cp /tmp/fp.bak.mjs tools/shallow-tarns-fingerprint.mjs && npm run shallowtarns` → `npm run check:data` 重新全绿。

- [ ] **Step 9: Commit（等用户授权）**

```bash
git add src/gen/structures/shallow-water-tarn-data.js src/gen/structures/shallow-water-terrain.js \
  tools/shallow-tarns-fingerprint.mjs tools/bake-shallow-tarns.mjs tools/check-data.mjs \
  src/tests/test-shallow-water-tarns.js assets/structures/shallow_tarn_0*.json \
  assets/structures/shallow_tarns.meta.json
git commit -m "feat(gen): 浅水高台 moss 全部换深草，草分块载体改为真方块标记 grass"
```

---

### Task 2: 湖岸形状 —— 径向谐波 + 保守半径切面

**Files:**
- Modify: `src/gen/structures/shallow-water-tarns.js`
- Modify: `src/gen/structures/shallow-water-terrain.js`
- Test: `src/tests/test-shallow-water-tarns.js`

**Interfaces:**
- Produces: `LAKE_RADIUS = 102`、`LAKE_SHAPE_HARMONICS`、`LAKE_SHAPE_AMP_SUM`（由谐波 `reduce` 派生）、`LAKE_RADIUS_MIN`、`LAKE_RADIUS_MAX`、`SHALLOW_TARN_HARD_RADIUS`、`SHALLOW_TARN_SHAPE_SALT = 1037`。
- Produces: `shallowTarnShapePhase(seed) → number`（[0, 2π)，Map 缓存 64 项，纯函数）、`shallowTarnLakeRadiusAt(angleRad, phase) → number`。
- 语义变更：`SHALLOW_TARN_OUTER_RADIUS = LAKE_RADIUS_MAX + BEACH_WIDTH + SLOPE_WIDTH`（139.3，原 130）；`anchor.hardRadius === SHALLOW_TARN_HARD_RADIUS`。

- [ ] **Step 1: 写失败测试（湖形函数 + 台地余量）**

在 `src/tests/test-shallow-water-tarns.js` ① 节前新增：

```js
test('shallowTarn: 湖岸半径是谐波函数（不是常数、不是正圆）', () => {
  const phase = shallowTarnShapePhase(DEFAULT_SEED);
  let mn = Infinity, mx = -Infinity, sum = 0;
  for (let deg = 0; deg < 360; deg += 1) {
    const r = shallowTarnLakeRadiusAt(deg * Math.PI / 180, phase);
    if (r < mn) mn = r;
    if (r > mx) mx = r;
    sum += r;
  }
  assertTrue(mx - mn > 6, `360° 极差 ${(mx - mn).toFixed(2)} 必须 > 6（否则退化成正圆）`);
  assertTrue(mn >= LAKE_RADIUS_MIN - 1e-9 && mx <= LAKE_RADIUS_MAX + 1e-9,
    `半径必须落在 [${LAKE_RADIUS_MIN.toFixed(2)}, ${LAKE_RADIUS_MAX.toFixed(2)}]，实得 [${mn.toFixed(2)}, ${mx.toFixed(2)}]`);
  assertTrue(Math.abs(sum / 360 - LAKE_RADIUS) < 1,
    `360° 均值 ${(sum / 360).toFixed(2)} 必须贴近名义半径 ${LAKE_RADIUS}`);
  // 相位是 seed 的纯函数：同 seed 同值，不同 seed 不同值
  assertEqual(shallowTarnShapePhase(DEFAULT_SEED), phase, '同 seed 相位一致');
  assertTrue(Math.abs(shallowTarnShapePhase(999) - phase) > 1e-6, '不同 seed 相位必须不同');
});

test('shallowTarn: 最窄方位的台地余量（构造性下界）', () => {
  assertTrue(LAKE_RADIUS_MIN > 92.4 + 1,
    `最小湖岸半径 ${LAKE_RADIUS_MIN} 必须 > 台地最远角 92.4 + 1`);
  for (const seed of [12345, 1, 424242, 8888, 20240101, 777]) {
    const phase = shallowTarnShapePhase(seed);
    for (const p of computeShallowTarnLayout(seed)) {
      for (const ox of [-p.hiX, p.loX]) for (const oz of [-p.hiZ, p.loZ]) {
        const d = Math.hypot(p.cx + ox, p.cz + oz);
        const ang = Math.atan2(p.cz + oz, p.cx + ox);
        assertTrue(d < shallowTarnLakeRadiusAt(ang, phase),
          `seed ${seed} ${p.variant} 角 (${ox},${oz}) 距湖心 ${d.toFixed(1)} 必须在湖岸内`);
      }
    }
  }
});
```

- [ ] **Step 2: 跑测试确认 RED**

Run: `npx playwright test tests/harness.spec.mjs`
Expected: FAIL —— `shallowTarnLakeRadiusAt is not a function`（新导出不存在）。

- [ ] **Step 3: 实现常数与纯函数**

在 `shallow-water-tarns.js` 的尺度常量段：

```js
export const LAKE_RADIUS = 102;          // 名义半径 = 谐波均值（v2.14 是 99）
export const LAKE_SHAPE_HARMONICS = Object.freeze([
  Object.freeze({ k: 2, amp: 2.5, phase: 0 }),
  Object.freeze({ k: 3, amp: 1.9, phase: 1.7 }),
  Object.freeze({ k: 5, amp: 1.2, phase: 3.4 }),
  Object.freeze({ k: 7, amp: 0.7, phase: 5.1 }),
]);
export const LAKE_SHAPE_AMP_SUM = LAKE_SHAPE_HARMONICS.reduce((s, h) => s + h.amp, 0);
export const LAKE_RADIUS_MIN = LAKE_RADIUS - LAKE_SHAPE_AMP_SUM;
export const LAKE_RADIUS_MAX = LAKE_RADIUS + LAKE_SHAPE_AMP_SUM;
export const SHALLOW_TARN_HARD_RADIUS = LAKE_RADIUS_MAX + BEACH_WIDTH;
export const SHALLOW_TARN_OUTER_RADIUS = SHALLOW_TARN_HARD_RADIUS + SLOPE_WIDTH;
export const SHALLOW_TARN_SHAPE_SALT = 1037;
```

`shallowTarnLakeRadiusAt(angleRad, phase)` = `LAKE_RADIUS + Σ amp·sin(k·θ + phase_i + phase)`；
`shallowTarnShapePhase(seed)` = `seededRandom(0, 0, seed + SHALLOW_TARN_SHAPE_SALT) * 2π`，带 `Map` 缓存（上限 64，`clearShallowTarnCache()` 一并清空）。
⚠️ 常量段的位置：`BEACH_WIDTH` / `SLOPE_WIDTH` 必须先于上面两行派生常量定义（现有顺序已满足）。

- [ ] **Step 4: 切面换成保守半径**

- `candidateCenters`：`baseX = cityBounds.maxX + SHALLOW_TARN_HARD_RADIUS + CITY_CLEARANCE + 1`。
- `fixedBlockers`：`const R = SHALLOW_TARN_HARD_RADIUS;`（pad 计算同步）。
- `computeShallowTarnAnchor`：`const HARD = SHALLOW_TARN_HARD_RADIUS;`，`hardRadius: HARD`。
- `inShallowTarnFootprint` / `shallowTarnOverlapsRegion`：已读 `SHALLOW_TARN_OUTER_RADIUS`（派生后自动变大，无需改代码，只更新注释说明「保守圆」）。

- [ ] **Step 5: 地形三条带改用 `e = d − R(θ)`**

`shallowTarnSurfaceYAt` 与 `shallowTarnSurfaceBlock` 里把 `const d = Math.hypot(...)` 之后插入：

```js
const e = d - shallowTarnLakeRadiusAt(Math.atan2(dz, dx), shallowTarnShapePhase(seed));
```

随后三段判据从 `d` 改为 `e`（`e <= 0` / `e <= BEACH_WIDTH` / `e > BEACH_WIDTH + SLOPE_WIDTH`），`t` 用 `e / BEACH_WIDTH`、`(e - BEACH_WIDTH) / SLOPE_WIDTH`。
`fillShallowTarnBasin` 的外接方形裁剪保持 `SHALLOW_TARN_OUTER_RADIUS`（现在是最大值 → 仍需 `d2 > outer2` 提前跳过），只更新注释。
⚠️ `shallowTarnSurfaceBlock(wx, wz, anchor)` 目前拿不到 `seed`：改为 `shallowTarnSurfaceBlock(wx, wz, seed, anchor)`，调用点（`fillShallowTarnBasin` 第 296 行附近）同步传 `seed`。

- [ ] **Step 6: 更新被形状影响的既有用例**

- 「五座全部落在湖盆内」→ 删除（被 Step 1 的新用例取代）。
- 「湖盆地表恒 `SEA_Y-1`」→ 采样半径改成 `Math.floor(shallowTarnLakeRadiusAt(ang, phase) * f)`（`f ∈ [0, 0.25, 0.5, 0.9]`）。
- 「缓坡带内单步落差 ≤1」→ 采样上界从 `SHALLOW_TARN_OUTER_RADIUS - 1` 改成 `shallowTarnLakeRadiusAt(ang, phase) + BEACH_WIDTH + SLOPE_WIDTH - 1`（逐方向边界；用名义圆会把「本地图外的自然接缝」算进来）。
- 「湖盆只填一格水」/「湖盆下方实心」/「湖底正下方不得残留天然水」→ 采样半径 `LAKE_RADIUS - 8` 改成逐点判 `d < shallowTarnLakeRadiusAt(ang, phase) - 8`。
- 「hardRadius = 湖 + 沙滩」→ `assertEqual(a.hardRadius, SHALLOW_TARN_HARD_RADIUS)`。
- 「整个湖都在城东」/「落点不与高台地带重叠」里的 `LAKE_RADIUS + BEACH_WIDTH` → `SHALLOW_TARN_HARD_RADIUS`。
- `inShallowTarnFootprint` 用例的「湖盆内缘」文案改成「整形区保守圆内缘」。

- [ ] **Step 7: 跑测试确认 GREEN**

Run: `npx playwright test tests/harness.spec.mjs`
Expected: PASS（全绿，含「逐方向单步落差 ≤1」——干态实测值 1）。

- [ ] **Step 8: 跑门禁与生成预算**

Run: `npm run check && npx playwright test tests/structure-gen.spec.mjs tests/worker-gen.spec.mjs`
Expected: 全绿。若 genP95 越线：先做交替对照（`git stash` HEAD 与本改动交错各跑 2~3 次），不要看单次数值。

- [ ] **Step 9: Commit（等用户授权）**

```bash
git add src/gen/structures/shallow-water-tarns.js src/gen/structures/shallow-water-terrain.js \
  src/tests/test-shallow-water-tarns.js
git commit -m "feat(gen): 浅水高台湖岸改为径向谐波（名义 102、摆幅 ±6.3）"
```

---

### Task 3: 接壤水系 —— 干湿两态水下坡

**Files:**
- Modify: `src/gen/structures/shallow-water-terrain.js`
- Test: `src/tests/test-shallow-water-tarns.js`

**Interfaces:**
- Consumes: `shallowTarnLakeRadiusAt` / `shallowTarnShapePhase`（Task 2）、`slopeNaturalHeight`（本文件内已有，半径 8 均值）。
- Produces: `shallowTarnSurfaceYAt(wx, wz, seed, anchor)` 的干湿语义（签名不变）。
- **签名变更**：`shallowTarnSurfaceBlock(wx, wz, seed, anchor)`（Task 2 的产物）→ `shallowTarnSurfaceBlock(wx, wz, seed, anchor, targetY) → 'sand' | 'grass'`（多一个已算好的地表高度，用于判「该列在水下」）。

- [ ] **Step 1: 写失败测试（干湿两态 + 连通性）**

```js
test('shallowTarn: 沙滩带干态单调抬升、湿态单调下降（无台阶）', () => {
  for (const seed of [12345, 1, 424242]) {
    clearShallowTarnCache(); clearShallowTarnTerrainCache();
    const a = computeShallowTarnAnchor(seed);
    const phase = shallowTarnShapePhase(seed);
    let dry = 0, wet = 0;
    for (let deg = 0; deg < 360; deg += 3) {
      const ux = Math.cos(deg * Math.PI / 180), uz = Math.sin(deg * Math.PI / 180);
      const R = shallowTarnLakeRadiusAt(deg * Math.PI / 180, phase);
      const ys = [];
      for (let e = 0; e <= BEACH_WIDTH; e += 1) {
        ys.push(shallowTarnSurfaceYAt(Math.round(a.wx + ux * (R + e)), Math.round(a.wz + uz * (R + e)), seed, a));
      }
      const rising = ys.every((y, i) => i === 0 || y >= ys[i - 1]);
      const falling = ys.every((y, i) => i === 0 || y <= ys[i - 1]);
      const maxStep = Math.max(...ys.slice(1).map((y, i) => Math.abs(y - ys[i])));
      assertTrue(maxStep <= 1, `seed ${seed} ang ${deg}: 沙滩带单步 ${maxStep} 必须 ≤1`);
      assertTrue(rising || falling, `seed ${seed} ang ${deg}: 沙滩带必须单调（y=${ys.join(',')}）`);
      if (ys[ys.length - 1] >= SEA_Y) dry++; else wet++;
    }
    assertTrue(dry > 0 && wet > 0, `seed ${seed}: 必须同时存在干岸 ${dry} 与湿岸 ${wet} 方位`);
  }
});

test('shallowTarn: 湿岸整条带都在水下（水面能连过去）', () => {
  clearShallowTarnCache(); clearShallowTarnTerrainCache();
  const a = computeShallowTarnAnchor(DEFAULT_SEED);
  const phase = shallowTarnShapePhase(DEFAULT_SEED);
  let wetDirs = 0, dryDirs = 0;
  for (let deg = 0; deg < 360; deg += 2) {
    const ux = Math.cos(deg * Math.PI / 180), uz = Math.sin(deg * Math.PI / 180);
    const R = shallowTarnLakeRadiusAt(deg * Math.PI / 180, phase);
    const endY = shallowTarnSurfaceYAt(Math.round(a.wx + ux * (R + BEACH_WIDTH)), Math.round(a.wz + uz * (R + BEACH_WIDTH)), DEFAULT_SEED, a);
    if (endY >= SEA_Y) { dryDirs++; continue; }
    wetDirs++;
    // 湿岸：沙滩外缘到整形区外缘之间不得出现「高于水面」的列（否则就是堤坝）
    for (let e = BEACH_WIDTH + 1; e <= BEACH_WIDTH + SLOPE_WIDTH; e += 1) {
      const y = shallowTarnSurfaceYAt(Math.round(a.wx + ux * (R + e)), Math.round(a.wz + uz * (R + e)), DEFAULT_SEED, a);
      assertTrue(y <= SEA_Y - 1, `ang ${deg} e=${e}: y=${y} 不得高于水面（湿岸必须整条连通）`);
    }
  }
  assertTrue(wetDirs > 0, `默认 seed 必须有湿岸方位（实测 22/48 左右）`);
});

test('shallowTarn: 湖心水团能连到 150 格外的大洋（洪水填充）', () => {
  const seed = DEFAULT_SEED;
  const a = computeShallowTarnAnchor(seed);
  const STEP = 4, RANGE = 200;
  const N = Math.floor(RANGE / STEP) * 2 + 1;
  const wet = (x, z) => shallowTarnSurfaceYAt(x, z, seed, a) <= SEA_Y - 1;
  const seen = new Uint8Array(N * N);
  const mid = Math.floor(N / 2);
  const stack = [mid * N + mid];
  seen[stack[0]] = 1;
  let maxDist = 0;
  while (stack.length) {
    const cur = stack.pop();
    const ci = cur % N, cj = Math.floor(cur / N);
    const dist = Math.hypot((ci - mid) * STEP, (cj - mid) * STEP);
    if (dist > maxDist) maxDist = dist;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ni = ci + di, nj = cj + dj;
      if (ni < 0 || nj < 0 || ni >= N || nj >= N) continue;
      const k = nj * N + ni;
      if (seen[k] || !wet(a.wx - RANGE + ni * STEP, a.wz - RANGE + nj * STEP)) continue;
      seen[k] = 1; stack.push(k);
    }
  }
  assertTrue(maxDist > 150, `湖心水团最远只到 ${maxDist.toFixed(0)} 格（修前是 100 = 湖半径+1，说明仍被堤坝隔断）`);
});
```

- [ ] **Step 2: 跑测试确认 RED**

Run: `npx playwright test tests/harness.spec.mjs`
Expected: FAIL —— 三条新用例全红（现状沙滩恒抬到 `SEA_Y+2`：无湿岸、水团停在 ~100 格）。

- [ ] **Step 3: 实现干湿两态**

`shallowTarnSurfaceYAt` 的沙滩/缓坡两段（`e > 0` 之后）：

```js
const hS = slopeNaturalHeight(wx, wz, seed);
// 干湿权重：0 = 自然地形本身是水（接壤），1 = 干地（今天的沙滩，逐位不变）
const wetLo = SEA_Y - 1;
const t = Math.min(1, Math.max(0, (hS - wetLo) / (BEACH_OUTER_Y - wetLo)));
const w = t * t * (3 - 2 * t);                       // smoothstep
const endY = Math.min(BEACH_OUTER_Y, hS) * (1 - w);
const midY = Math.max(LAKE_FLOOR_Y - BEACH_RISE, Math.min(endY, BEACH_OUTER_Y));
if (e <= BEACH_WIDTH) return Math.round(LAKE_FLOOR_Y + (midY - LAKE_FLOOR_Y) * (e / BEACH_WIDTH));
if (e > BEACH_WIDTH + SLOPE_WIDTH) return generateHeight(wx, wz, seed);
const t2 = (e - BEACH_WIDTH) / SLOPE_WIDTH;
return Math.round(midY * (1 - t2) + hS * t2);
```

⚠️ **干湿判据只读 `hS`，禁止把 `generateHeight` 掺进来**（spec §14.3 实测：`min(hS, hNat)` 会产生 2 格台阶）。

材质：`shallowTarnSurfaceBlock(wx, wz, seed, anchor, targetY)` —— 沙滩带（`e <= BEACH_WIDTH`）恒 `'sand'`；缓坡带若 `targetY <= SEA_Y - 1`（该列在水下）也返回 `'sand'`，否则 `'grass'`。调用点把已算好的 `targetY` 传进去。

- [ ] **Step 4: 跑测试确认 GREEN**

Run: `npx playwright test tests/harness.spec.mjs`
Expected: PASS（含 Task 2 的「逐方向单步落差 ≤1」与既有的「湖盆只填一格水」）。

- [ ] **Step 5: 负向验证（判据换回真实高度）**

`cp src/gen/structures/shallow-water-terrain.js /tmp/terr.bak.js`，把 `const hS = ...` 之后改成 `const hS = Math.min(slopeNaturalHeight(...), generateHeight(wx, wz, seed));`（临时）→ 跑 `npx playwright test tests/harness.spec.mjs`
Expected: FAIL —— 「本地图范围内最大单步落差 2」，与 spec §14.3 的表一致。
还原：`cp /tmp/terr.bak.js src/gen/structures/shallow-water-terrain.js`。

- [ ] **Step 6: Commit（等用户授权）**

```bash
git add src/gen/structures/shallow-water-terrain.js src/tests/test-shallow-water-tarns.js
git commit -m "feat(gen): 浅水高台接壤水系时水下坡连通大洋（只读平滑自然高度）"
```

---

### Task 4: 水面平面门控放大到整形区

**Files:**
- Modify: `src/core/game.js`（`setLakeCircle` 的半径来源）
- Modify: `src/render/ocean-mask.js`（`inLakeCircle` 的语义注释）
- Test: `src/tests/test-ocean-mask.js`、`tests/lake-ripple.spec.mjs`

**接口说明：** 本任务是**接线值**改动 —— 单测只能钉常量不变式与几何论证，真正的可观测判据在真游戏页（`uLakeCircle.value.z`），所以 RED 先发生在 E2E 上。

Step 5 的两条单测需补 import：`SHALLOW_TARN_OUTER_RADIUS` / `LAKE_RADIUS_MAX` / `BEACH_WIDTH` / `SLOPE_WIDTH` /
`shallowTarnShapePhase` / `shallowTarnLakeRadiusAt` 来自 `gen/structures/shallow-water-tarns.js`；
`shallowTarnSurfaceYAt` / `clearShallowTarnTerrainCache` 来自 `gen/structures/shallow-water-terrain.js`。

**Interfaces:**
- Consumes: `SHALLOW_TARN_OUTER_RADIUS`（Task 2）。
- Produces: `ocean.uLakeCircle.value.z === SHALLOW_TARN_OUTER_RADIUS`（接线的可观测判据）。

- [ ] **Step 1: 先写真游戏页的接线断言（这一步的 RED）**

在 `tests/lake-ripple.spec.mjs` 第二条用例（已读 `uLakeCircle`）末尾追加：

```js
// 半径必须是整形区最大半径（不是名义湖半径）—— 门控盖不到接壤坡面时，
// 那里只剩体素水顶面（无波纹），而像素用例只采样湖心，抓不到
const outer = await page.evaluate(async () => {
  const m = await import('/src/gen/structures/shallow-water-tarns.js');
  return m.SHALLOW_TARN_OUTER_RADIUS;
});
expect(Math.round(uniform.radius), `uLakeCircle.radius 必须是整形区最大半径 ${Math.round(outer)}`)
  .toBe(Math.round(outer));
```

- [ ] **Step 2: 跑测试确认 RED**

Run: `npx playwright test tests/lake-ripple.spec.mjs -g "同一套着色器"`
Expected: FAIL —— `uLakeCircle.radius` 实得 102（名义湖半径），期望 139。

- [ ] **Step 3: 改接线 + 语义注释**

```js
// src/core/game.js
import { computeShallowTarnAnchor, SHALLOW_TARN_OUTER_RADIUS } from '../gen/structures/shallow-water-tarns.js';
...
this.ocean.setLakeCircle(shallowTarn
  ? { cx: shallowTarn.wx, cz: shallowTarn.wz, radius: SHALLOW_TARN_OUTER_RADIUS }
  : null);
```

`ocean-mask.js` 的 `inLakeCircle` 注释补一段：v2.15 起传入的是**整形区最大半径**（不是湖半径），理由是「整形区内淹不淹由本地图自己的 target 决定；干燥列地表恒 > 平面 → 被深度测试遮掉，故放大零风险」。

- [ ] **Step 4: 跑测试确认 GREEN**

Run: `npx playwright test tests/lake-ripple.spec.mjs`
Expected: 全绿（`blue > 0.3` / `changed > 0.05` 判据不变）。

- [ ] **Step 5: 单测级回归门（常量不变式 + 假水面论证）**

在 `src/tests/test-ocean-mask.js` 追加（这两条是回归门，写完成即绿 —— 它们钉的是不变式，不是新行为）：

```js
test('ocean-mask: 门控半径不变式 = 整形区最大半径', () => {
  assertTrue(SHALLOW_TARN_OUTER_RADIUS >= LAKE_RADIUS_MAX + BEACH_WIDTH + SLOPE_WIDTH,
    'OUTER_RADIUS 必须覆盖到整形区最外圈（最大半径口径）');
  const seed = 12345;
  clearShallowTarnCache();
  const a = computeShallowTarnAnchor(seed);
  const phase = shallowTarnShapePhase(seed);
  let minR = Infinity, minAng = 0;
  for (let deg = 0; deg < 360; deg += 1) {
    const r = shallowTarnLakeRadiusAt(deg * Math.PI / 180, phase);
    if (r < minR) { minR = r; minAng = deg; }
  }
  const d = minR + BEACH_WIDTH + SLOPE_WIDTH - 1;
  const x = a.wx + Math.cos(minAng * Math.PI / 180) * d;
  const z = a.wz + Math.sin(minAng * Math.PI / 180) * d;
  assertTrue(inLakeCircle(x, z, { cx: a.wx, cz: a.wz, radius: SHALLOW_TARN_OUTER_RADIUS }),
    `最窄方位整形区外缘（d=${d.toFixed(1)}）必须被门控覆盖`);
  assertFalse(inLakeCircle(x, z, { cx: a.wx, cz: a.wz, radius: LAKE_RADIUS }),
    '名义湖半径覆盖不到 —— 这就是门控必须放大的理由');
});

test('ocean-mask: 整形区内干燥列的地表恒高于水面平面（放大门控不会出假水面）', () => {
  const seed = 12345;
  clearShallowTarnCache(); clearShallowTarnTerrainCache();
  const a = computeShallowTarnAnchor(seed);
  const phase = shallowTarnShapePhase(seed);
  let dry = 0, wet = 0;
  for (let deg = 0; deg < 360; deg += 3) {
    const ux = Math.cos(deg * Math.PI / 180), uz = Math.sin(deg * Math.PI / 180);
    const R = shallowTarnLakeRadiusAt(deg * Math.PI / 180, phase);
    for (let e = -5; e <= BEACH_WIDTH + SLOPE_WIDTH; e += 1) {
      const y = shallowTarnSurfaceYAt(Math.round(a.wx + ux * (R + e)), Math.round(a.wz + uz * (R + e)), seed, a);
      if (y <= SEA_Y - 1) { wet++; continue; }
      dry++;
      // 地面方块顶面 = y + 1；平面在水面方块顶 -0.5 处 = SEA_Y + 0.5
      assertTrue(y + 1 > SEA_Y + 0.5, `干燥列 y=${y} 的顶面必须高于水面平面`);
    }
  }
  assertTrue(dry > 100 && wet > 100, `干/湿样本都必须足量（实得 ${dry}/${wet}）`);
});
```

Run: `npx playwright test tests/harness.spec.mjs`
Expected: PASS。

- [ ] **Step 6: Commit（等用户授权）**

```bash
git add src/core/game.js src/render/ocean-mask.js src/tests/test-ocean-mask.js tests/lake-ripple.spec.mjs
git commit -m "feat(render): 水面平面门控放大到浅水高台整形区"
```

---

### Task 5: 真实页面验收（形状 / 连通 / 材质）

**Files:**
- Modify: `tests/shallow-water-tarns.spec.mjs`

**Interfaces:**
- Consumes: 全部 Task 1~4 的产物与常量。

- [ ] **Step 1: 更新既有三条用例的采样口径**

- `shallowTarnLayout(page)` 额外取回 `lakeRadiusMin` / `lakeRadiusMax` / `shapePhase` / `outerRadius`（全部从模块 import，不写字面量）。
- 「湖盆只有一格水」：采样圆改成逐点 `d < shallowTarnLakeRadiusAt(ang, phase) - 10`。
- 「五座高台」：最远角判据改成 `worst < shallowTarnLakeRadiusAt(该角方位角, phase)`。
- 「只出现在 City 东方」：`westEdge` 用 `wx - lakeRadiusMax - beachWidth`。

- [ ] **Step 2: 新增「湖岸不是圆」用例**

```js
test('浅水高台：湖岸有凹凸（不是正圆）', async ({ page }) => {
  test.setTimeout(900_000);
  await openGame(page);
  const st = await shallowTarnLayout(page);
  await flyTo(page, st.anchor.wx, st.anchor.wz, st.anchor.lakeFloorY + 60, 10);
  const r = await page.evaluate(({ wx, wz, phaseSteps }) => {
    const g = window.__MC_GAME__;
    const waterId = g.registry.idOf('water');
    // 24 个方位：沿射线找「最后一格水」的半径
    const radii = [];
    for (const deg of phaseSteps) {
      const ux = Math.cos(deg * Math.PI / 180), uz = Math.sin(deg * Math.PI / 180);
      let last = null;
      for (let d = 60; d <= 160; d += 1) {
        const x = Math.round(wx + ux * d), z = Math.round(wz + uz * d);
        if (!g.world.hasColumn(Math.floor(x / 16), Math.floor(z / 16))) break;
        if (g.world.getBlockId(x, -2, z) === waterId) last = d;
      }
      if (last !== null) radii.push(last);
    }
    return { radii };
  }, { wx: st.anchor.wx, wz: st.anchor.wz, phaseSteps: [0, 15, 30, 45, 60, 75, 90, 105, 120, 135, 150, 165, 180, 195, 210, 225, 240, 255, 270, 285, 300, 315, 330, 345] });
  const spread = Math.max(...r.radii) - Math.min(...r.radii);
  expect(r.radii.length, '必须量到足够多方位的水面半径').toBeGreaterThan(18);
  expect(spread, `湖岸半径极差 ${spread} 必须 > 6（正圆会是 0~2）`).toBeGreaterThan(6);
  expect(Math.min(...r.radii)).toBeGreaterThanOrEqual(st.lakeRadiusMin - 8);
  expect(Math.max(...r.radii)).toBeLessThanOrEqual(st.lakeRadiusMax + 8);
});
```

- [ ] **Step 3: 新增「水面连通大洋」用例**

```js
test('浅水高台：湖水与接壤的海洋连成一片（无陆地堤坝）', async ({ page }) => {
  test.setTimeout(900_000);
  await openGame(page);
  const st = await shallowTarnLayout(page);
  // 视距 8 的加载半径 = 160 格 → 必须等整圈 column 齐了再填充
  await flyTo(page, st.anchor.wx, st.anchor.wz, st.anchor.lakeFloorY + 20, 10);
  const r = await page.evaluate(({ wx, wz }) => {
    const g = window.__MC_GAME__;
    const waterId = g.registry.idOf('water');
    const STEP = 2, RANGE = 150;
    const N = Math.floor(RANGE / STEP) * 2 + 1;
    const wet = (i, j) => {
      const x = wx - RANGE + i * STEP, z = wz - RANGE + j * STEP;
      return g.world.getBlockId(x, -2, z) === waterId ? 1 : 0;
    };
    const seen = new Uint8Array(N * N);
    const mid = Math.floor(N / 2);
    const stack = [mid * N + mid];
    seen[stack[0]] = 1;
    let maxDist = 0, cells = 0;
    while (stack.length) {
      const cur = stack.pop();
      const ci = cur % N, cj = Math.floor(cur / N);
      cells++;
      const dist = Math.hypot((ci - mid) * STEP, (cj - mid) * STEP);
      if (dist > maxDist) maxDist = dist;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ni = ci + di, nj = cj + dj;
        if (ni < 0 || nj < 0 || ni >= N || nj >= N) continue;
        const k = nj * N + ni;
        if (seen[k] || !wet(ni, nj)) continue;
        seen[k] = 1; stack.push(k);
      }
    }
    return { maxDist, cells };
  }, { wx: st.anchor.wx, wz: st.anchor.wz });
  expect(r.cells, '湖心水团必须真的有一大片水（防止坐标写错）').toBeGreaterThan(2000);
  expect(r.maxDist, `湖心水团最远 ${r.maxDist} 格；修前是 100（= 湖半径+1，被沙滩堤坝隔断）`)
    .toBeGreaterThan(140);
});
```

- [ ] **Step 4: 扩展「五座高台」用例的材质断言**

在既有 ④ 之后追加：
- `expect(r.counts.moss || 0).toBe(0)`（moss 已全部换深草）；
- 保留 `expect(r.counts.grass || 0).toBe(0)`（刷色必须跑过，标记不得残留）；
- `expect(r.counts.dark_grass || 0).toBeGreaterThan(0)`（每座都应有深草）。

- [ ] **Step 5: 跑三条新/改用例**

Run: `npx playwright test tests/shallow-water-tarns.spec.mjs`
Expected: 全绿（单条用例 10 分钟上限，整文件约 20~30 分钟）。

- [ ] **Step 6: 负向验证（三条，必须真红）**

1. **湖岸回正圆**：`cp src/gen/structures/shallow-water-tarns.js /tmp/st.bak.js` → 把 `shallowTarnLakeRadiusAt` 改成 `return LAKE_RADIUS;` → `npx playwright test tests/shallow-water-tarns.spec.mjs -g "湖岸有凹凸"` → Expected: FAIL（极差 0~2）。还原 `cp /tmp/st.bak.js ...`。
2. **去掉湿态**：`cp src/gen/structures/shallow-water-terrain.js /tmp/terr.bak.js` → `midY` 恒 `BEACH_OUTER_Y` → `-g "连成一片"` → Expected: FAIL（`maxDist ≈ 100`）。还原。
3. **刷色不跑**：把 `apply.js` 阶段 2.45 的 `paintShallowTarnGrass(...)` 行注掉 → `-g "五座高台"` → Expected: FAIL（`grass` 残留）。还原。

- [ ] **Step 7: Commit（等用户授权）**

```bash
git add tests/shallow-water-tarns.spec.mjs
git commit -m "test(e2e): 浅水高台湖岸凹凸/水面连通/材质替换的真实页面验收"
```

---

### Task 6: 文档同步

**Files:**
- Modify: `docs/roadmap.md`（新增 v2.15 行 + 遗留 TODO 若有）
- Modify: `AGENTS.md`（「浅水高台沉淀的活跃约束」段补 4 条）

- [ ] **Step 1: roadmap**

在 v2.11 行之后新增 v2.15 行：一句话现状 + 四条实测数字（半径 95.99~108.01 / 单步 1 / 修前水团停在 100 格·修后 4/4 连通 150 格外 / moss 21,535 格迁出）。

- [ ] **Step 2: AGENTS.md 活跃约束**

在「浅水高台沉淀的活跃约束」段追加四条：

1. **湖岸形状唯一权威 = `shallowTarnLakeRadiusAt(θ, phase)`**：三条带与门控的切面全部从它派生；`LAKE_RADIUS` 是名义值，落地用 `LAKE_RADIUS_MIN/MAX`（保守/构造性下界）。改谐波参数会同时改「台地余量」与「岸距」两个观感指标，必须重跑 spec §14.2 的标定表。
2. **干湿判据只读平滑自然高度 `hS`**：掺 `generateHeight` 实测出现 2 格台阶（seed 1 / ang 54 / d 111）。
3. **水面门控半径 = `SHALLOW_TARN_OUTER_RADIUS`**（不是湖半径）：整形区内淹不淹由本地图 target 决定，放大零风险；漏放大 → 接壤坡面只剩体素水顶面（v2.14 缺陷形态复辟）。
4. **草标记 `grass` 是临时方块**：`green_wool → dark_grass`（终态）、`grass_block → grass → dark/light_grass`。`light_grass` 只可能来自 `grass_block`，由 `check:data` 的两条格数关系式钉住；改 `BLOCK_MAP` 后必须 `npm run shallowtarns`，否则产物静默过期。

- [ ] **Step 3: 跑全量门禁**

Run: `npm run check && npx playwright test tests/harness.spec.mjs`
Expected: 全绿。

- [ ] **Step 4: Commit（等用户授权）**

```bash
git add docs/roadmap.md AGENTS.md
git commit -m "docs: roadmap v2.15 与浅水高台活跃约束同步"
```

---

## 收尾检查清单（全部任务之后）

- [ ] `npm run check` 全绿
- [ ] `npx playwright test tests/harness.spec.mjs tests/structure-gen.spec.mjs tests/worker-gen.spec.mjs` 全绿
- [ ] `npx playwright test tests/shallow-water-tarns.spec.mjs tests/lake-ripple.spec.mjs` 全绿
- [ ] `npm run bench -- --check`（改动了 GEN 路径；阻断时先做交替对照，不看单次数值）
- [ ] spec §14.7 的负向验证 5 条都实际跑过并确认真红
- [ ] 设计文档 §14 与实测数字一致（若有偏差，以实测为准并回写）
