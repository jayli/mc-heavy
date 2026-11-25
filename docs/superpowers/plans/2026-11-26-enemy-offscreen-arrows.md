# 屏外敌人方位箭头 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task（用户 2026-11-19 已定：Native 内联执行，不派 subagent、不建 worktree）。Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 屏外敌人沿屏幕边框显示彩色小三角（每类最近一只 + 屏外计数 + 距离），零 draw call。

**Architecture:** 新增 `src/ui/enemy-arrows.js`（three-free：配色 + 几何纯函数 + 5 槽 DOM 池）。
装配层 `game.js` 注入唯一的 `cameraSpaceFn`（世界→相机空间，复用 `matrixWorldInverse`），
本模块用 `sx=cx/(|cz|·tan·aspect)`、`sy=−cy/(|cz|·tan)` 一个公式同时判屏外与算边缘方位。
帧循环在 `renderer.render()` **之后**调 `update(nowMs)`（与 `_damageNumbers` 同位置同理由）。

**Tech Stack:** 原生 DOM/CSS（无新依赖）、Playwright（E2E）、仓库自带 `src/tests/runner.js`（Node 单测）。

**Spec:** `docs/superpowers/specs/2026-11-26-enemy-offscreen-arrows-design.md`

## Global Constraints

- 所有解释/注释用中文；代码注释尽量中文。
- `src/ui/**` **不 import three**（既有口径，投影由装配层注入）。
- 时间基准 `performance.now()`，**禁 `Date.now()`**。
- 挂 `#hud-root` 下（Tier 4 像素用例靠 `#hud-root > *` 隐藏 HUD）。
- `z-index = 52`（>50 血心/计数行/看板，<55 伤害数字，<56 红闪）；**不得取 100+**。
- `pointer-events:none`。
- 五类型名从各自 config import：`SOLDIER_TYPE`/`DRAGON_TYPE`/`IGNIS_TYPE`/`GUARDIAN_TYPE`；丧尸是字面量 `'zombie'`。
- 配色（用户裁定）：soldier `#9aa3ad`、zombie `#4ade80`、dragon `#a855f7`、ignis `#facc15`、guardian `#ff69b4`。
- 士兵必须过滤 `state.dead === true`（留尸 1.2s 仍在集合里）。
- 每类只画最近一只；`count` = 该类**屏外**总数；距离向下取整 `NNm`。
- 透明度：`NEAR=16`、`FAR=160`、`MIN=0.35`。
- 内缩：`MARGIN_X=62`、`MARGIN_Y=30`；跨类最小间距 `MIN_GAP=34`。
- 零烘焙、零新素材、零新 render pass。
- **不跑 `npm test`**（非全局基础设施改动、非里程碑收尾）。不跑 bench（不碰热路径）。
- 负向验证注入用 `edit` + 读回确认，还原用 `cp` 副本（**禁 `git checkout`**）。
- 不提交（用户未下提交指令）。

## Review Focus

1. **背后敌人的左右方位**：`|cz|` 写成 `cz` 或额外取反 ⇒ 箭头指向镜像侧，玩家转身反方向找不到敌人。→ Task 1 单测 + Task 3 E2E「右后方→右半屏」。
2. **士兵留尸**：不过滤 `dead` ⇒ 打死士兵后箭头还在，读作「没打死」。→ Task 1 单测 + Task 3 E2E。
3. **count 口径**：写成全场总数 ⇒ 已经看得见的敌人也计进「还没找到」。→ Task 1 单测（屏内 1 + 屏外 2）。
4. **NaN 落点/透明度**：正后方 `cx=cy=0` 或 `cz=0` ⇒ NaN 写进 style 被静默忽略，箭头卡在旧位置。→ Task 1 退化用例。
5. **箭头压住模态**：z-index 取错 ⇒ 设置面板/背包被箭头压住，或盖住启动错误遮罩。→ Task 1 常量断言 + Task 3 层级用例。

---

### Task 1: 几何与配色纯函数（three-free，Node 可测）

**Files:**
- Create: `src/ui/enemy-arrows.js`（本任务只写常量 + 三个纯函数，DOM 类在 Task 2 追加）
- Create: `src/tests/test-enemy-arrows.js`
- Modify: `src/tests/index.html`（在 `import './test-enemy-counts.js';` 后加一行 import）
- Modify: `tools/test-tiers.mjs`（`UNIT_NODE_SAFE` 里 `'test-enemy-counts.js',` 后加 `'test-enemy-arrows.js',`）

**Interfaces:**
- Produces:
  - `ARROW_COLORS: Readonly<Record<'zombie'|'soldier'|'dragon'|'guardian'|'ignis', string>>`
  - `ENEMY_ARROW_ROWS: ReadonlyArray<{key:string, type:string, color:string}>`（顺序：尸/兵/龙/守/焰）
  - `ARROW_GEOM = { marginX:62, marginY:30, minGap:34, sizePx:14, zIndex:52, near:16, far:160, minOpacity:0.35 }`
  - `arrowNdc(camSpace:[number,number,number], tanHalfFov:number, aspect:number) → {sx:number, sy:number, behind:boolean}`
  - `isOffscreen(ndc:{sx,sy,behind}) → boolean`
  - `arrowPlacement(camSpace, tanHalfFov, aspect, vw, vh) → {x:number, y:number, deg:number}`
  - `arrowOpacity(distance:number) → number`
  - `enemyArrowTargets(entities:Iterable<{type:string,state:{position:number[],dead?:boolean}}>, playerPos:{x,y,z}, cameraSpaceFn:(p:number[])=>number[], tanHalfFov:number, aspect:number) → Array<{key,type,color,count,distance,camSpace}>`

- [ ] **Step 1: 写失败测试** `src/tests/test-enemy-arrows.js`

用 `import { test } from './runner.js'` + `assertEqual/assertTrue/assertDeepEqual`（**无 `assertCloseTo`，用 `assertTrue(Math.abs(a-b)<eps)`**）。必须包含下列用例（名字可微调，断言值照抄）：

```js
// ① 配色与登记：五项、色值互不相同、type 从 config 派生
assertDeepEqual(ENEMY_ARROW_ROWS.map(r => r.key), ['zombie','soldier','dragon','guardian','ignis']);
assertEqual(ARROW_COLORS.soldier, '#9aa3ad'); // 其余四项同法
assertEqual(new Set(Object.values(ARROW_COLORS)).size, 5);
assertEqual(byKey.soldier, SOLDIER_TYPE); // dragon/ignis/guardian 同法；zombie === 'zombie'
// ② 层级：50 < zIndex < 55，且 < 100
// ③ 前向一致性（对照式独立写，不 import 被测公式）：cz<0 时
//    nx = cx/(-cz*tan*aspect); ny = -cy/(-cz*tan)  与 arrowNdc 的 sx/sy 逐位一致（1e-12）
//    夹具至少 5 组，含负 x、负 y、非正方形 aspect（1280/720）
// ④ 屏外判据：{sx:0.5,sy:0.5,behind:false} → false；{sx:1.2,...} → true；
//    {sy:-1.2} → true；behind:true → true（哪怕 sx/sy 为 0）
// ⑤ 背后左右：arrowPlacement([3,0,10],...) → x > vw/2；[-3,0,10] → x < vw/2
//    上下：[0,3,10] → y < vh/2（相机空间 +y 向上 ⇒ 屏幕上方）；[0,-3,10] → y > vh/2
// ⑥ 八方向落点：a=0..315 步 45，构造 camSpace 使 dir 为该角度，
//    断言落点在内缩矩形边界上（|x-vw/2| ≈ hw 或 |y-vh/2| ≈ hh，1e-6），且 0<=x<=vw、0<=y<=vh
//    角度 deg 与 a 一致（模 360，容差 1e-6）
// ⑦ 退化不产 NaN：[0,0,10]、[0,0,-10]、[1,0,0]、[0,0,0] 四组，
//    Number.isFinite(x/y/deg) 全真，且落点在屏幕内
// ⑧ 透明度：arrowOpacity(0)=1、(16)=1、(160)=0.35、(1000)=0.35；
//    单调不增（d=0..200 步 5）；NaN/undefined/-5 → 1（按最近算，不产 NaN）
// ⑨ 每类最近 + count=屏外数：构造丧尸三只（一只在正前方近处屏内、两只屏外一近一远），
//    cameraSpaceFn 用纯数学夹具（不碰 three）：把世界点减玩家位置后按 yaw=0（前向 -Z）映射
//    ⇒ camSpace = [dx, dy, dz]（yaw=0 时相机空间 = 世界差值，x 同向、z 同向）
//    断言 zombie 项 count===2、distance === 较近那只的距离
// ⑩ 士兵留尸排除：两只士兵，一只 dead:true（更近）⇒ count===1 且指向活的那只
// ⑪ 龙体心 vs 脚底：同一 position=[0,10,0]、玩家在原点，
//    龙的锚点 y = 10，丧尸 = 10 + ZOMBIE.height/2 ⇒ 两者 camSpace[1] 不同
// ⑫ 非登记类型（turret/minecart/fireball）不进候选
```

- [ ] **Step 2: 跑测试确认 RED**

Run: `node tools/run-unit-node.mjs --only=test-enemy-arrows.js`
Expected: FAIL —— `import 失败：test-enemy-arrows.js`（模块还不存在），**硬失败退出码 1**。

- [ ] **Step 3: 实现 `src/ui/enemy-arrows.js` 的常量与三个纯函数**

文件头注释写清：用户原话、三项裁定、为什么 DOM、为什么不注入第二个投影函数、`|cz|` 的载荷性。

`arrowNdc`：`behind = cz >= -0.05`；分母 `d = Math.abs(cz) * tanHalfFov`，`d < 1e-6` 时返回 `{sx:0, sy:0, behind}`（退化，不产 Infinity）；否则 `sx = cx/(d*aspect)`、`sy = -cy/d`。

`isOffscreen`：`behind || Math.abs(sx) > 1 || Math.abs(sy) > 1`。

`arrowPlacement`：取 `arrowNdc` 的 `sx/sy` 当方向向量；`len = hypot(sx,sy)`，`len < 1e-9` ⇒ `dir=(0,1)`；否则归一化。`hw = vw/2 - marginX`、`hh = vh/2 - marginY`（都 `Math.max(1, ...)` 防窄屏负值）；`t = min(hw/|dx|, hh/|dy|)`（分母 `<1e-9` 时该项取 `Infinity`）；`x = vw/2 + dx*t`、`y = vh/2 + dy*t`；`deg = atan2(dy,dx)*180/π`。

`arrowOpacity`：`Number.isFinite(d)` 为假或 `d <= near` ⇒ 1；否则 `max(minOpacity, 1-(d-near)/(far-near))`。

`enemyArrowTargets`：按 `ENEMY_ARROW_ROWS` 建 5 个累加槽（`{count:0, best:null, bestD:Infinity}`）；遍历实体，`type` 查表（用 `Map` 由 rows 派生，不写 if 链）；士兵 `state.dead === true` 跳过；锚点 y = `type === DRAGON_TYPE ? y : y + heightOf(type)/2`（`heightOf` 从 config 的 `ZOMBIE.height`/`SOLDIER.height`/`IGNIS.height`/`GUARDIAN.height` 建表）；`camSpace = cameraSpaceFn([x, ay, z])`；`isOffscreen(arrowNdc(...))` 为假则跳过；`count++`，`d = Math.hypot(x-px, ay-py, z-pz)`，`d < bestD` 则更新 best。输出按 rows 顺序、只含 `count > 0` 的项。

- [ ] **Step 4: 跑测试确认 GREEN**

Run: `node tools/run-unit-node.mjs --only=test-enemy-arrows.js`
Expected: PASS，`failed === 0`，且注册例数 > 0。

- [ ] **Step 5: 注册 + 门禁**

`src/tests/index.html` 加 import；`tools/test-tiers.mjs` 的 `UNIT_NODE_SAFE` 加文件名。
Run: `npm run check`
Expected: exit 0，`[测试注册]` 与 `[测试分档]` 计数各 +1。
（`check:data` 若报既有的 `running_wet.wav` 指纹不符，那是与本轮无关的既有失败，如实记录不修。）

---

### Task 2: DOM 池与装配接线

**Files:**
- Modify: `src/ui/enemy-arrows.js`（追加 `EnemyArrows` 类 + `ARROW_ID`）
- Modify: `src/core/game.js`（import；`_damageNumbers` 装配段之后构造；帧循环 `_damageNumbers.update(nowMs)` 之后调 update；`dispose()` 里 `_damageFlash?.dispose()` 附近摘除）

**Interfaces:**
- Consumes: Task 1 全部导出。
- Produces: `ARROW_ID = 'mc-enemy-arrows'`；`class EnemyArrows { constructor(root, game, cameraSpaceFn); update(nowMs); activeKeys(): string[]; dispose(); }`
  - 每槽 DOM：`<div id="mc-enemy-arrow-<key>">` 内含 `<i>`（三角，旋转）+ `<span>`（读数 `×N Dm`，水平）。
  - `game` 只读 `entities.entities()`、`player.physics.pos`、`camera.fov`。

- [ ] **Step 1: 写失败测试（追加到 `src/tests/test-enemy-arrows.js`）**

DOM 类需要 `document` ⇒ **不能进 Node 白名单**。故本任务的自动化判据放 E2E（Task 3），
Node 侧只加一条**结构断言**（读源码文本，既有手法，如 `test-puddle-reflect.js` 的装配段守卫）：

```js
// 装配接线结构门（Node 侧读 game.js 源码文本）
// ① `new EnemyArrows(` 出现，且三个实参含 cameraSpaceFn
// ② `this._enemyArrows.update(nowMs)` 出现在 `this.renderer.render(this.scene, this.camera)` **之后**
//    （索引比较；这一条是载荷性的：render 前读 matrixWorldInverse 会滞后一帧）
// ③ dispose 段含 `this._enemyArrows?.dispose()`
```
用 `import fs from 'node:fs'`？**不行** —— 浏览器里 `node:fs` 会 import 失败（既有缺口）。
改用 `fetch(new URL('../core/game.js', import.meta.url))` 读文本（Node shim 提供 fetch 垫片，
浏览器同源可取）。**先验证这条路在两侧都能读**，读不到就改成把这条结构门放进 Task 3 的 E2E。

- [ ] **Step 2: 跑测试确认 RED**

Run: `node tools/run-unit-node.mjs --only=test-enemy-arrows.js`
Expected: FAIL（`new EnemyArrows(` 不存在）。

- [ ] **Step 3: 实现 DOM 类与装配**

`EnemyArrows` 构造期建 5 个常驻槽（`display:none`），容器 `position:fixed;inset:0;z-index:52;pointer-events:none;overflow:hidden`。
三角用 CSS border 技巧：`width:0;height:0;border-left:14px solid <color>;border-top:7px solid transparent;border-bottom:7px solid transparent`（默认朝右，0°），`filter:drop-shadow(0 0 1px #000)`。
读数 `<span>`：`font:11px/1 monospace;color:<color>;text-shadow:0 0 2px #000,0 0 2px #000;white-space:nowrap`。

`update(nowMs)`：读 `game.entities.entities()`、`player.physics.pos`、`tan = Math.tan(camera.fov*π/360)`、`vw/vh = window.innerWidth/innerHeight`、`aspect = vw/vh`；调 `enemyArrowTargets`；对每槽：无目标 ⇒ `display:none`（只在变化时写）；有目标 ⇒ `arrowPlacement` + 跨类推开 + `arrowOpacity`，写 `transform:translate(Xpx,Ypx)`（外层）、三角 `rotate(deg)`、读数文本与位置。

**跨类推开**：按 rows 顺序，对落在同一条边（由 `|x-vw/2|≈hw` 或 `|y-vh/2|≈hh` 判定）且切向坐标差 `< minGap` 的后来者，沿该边切向推到 `前一个 ± minGap`，再钳到 `[margin, vw-margin]` / `[margin, vh-margin]`。**不改 deg**。

**DOM 写入去重**：位置 `Math.round`、角度 `Math.round`、opacity `toFixed(2)`、文本字符串比较 —— 与上次相同就不写。

装配（`game.js`）：
```js
const arrowVec = new THREE.Vector3();
this._enemyArrows = new EnemyArrows(this._hudRoot, this, (worldPos) => {
  arrowVec.set(worldPos[0], worldPos[1], worldPos[2]).applyMatrix4(this.camera.matrixWorldInverse);
  return [arrowVec.x, arrowVec.y, arrowVec.z];
});
```
⚠️ 返回**新数组**（每类每帧 5 个小数组，可接受；不得返回复用数组的引用 —— 目标选择要同时持有 5 类的 camSpace）。
帧循环：`this._damageNumbers.update(nowMs);` 之后加 `this._enemyArrows.update(nowMs);` + 中文注释说明「必须在 render 之后」。
`dispose()`：`this._enemyArrows?.dispose();`。

- [ ] **Step 4: 跑测试确认 GREEN**

Run: `node tools/run-unit-node.mjs --only=test-enemy-arrows.js` → PASS
Run: `npm run check` → exit 0（lint 0 error）

---

### Task 3: E2E 判据与分档归档

**Files:**
- Create: `tests/enemy-arrows.spec.mjs`
- Modify: `tools/test-tiers.mjs`（`UI` 数组里 `'enemy-counts',` 后加 `'enemy-arrows',`）

**Interfaces:**
- Consumes: `ARROW_ID`、`ENEMY_ARROW_ROWS`、`ARROW_GEOM`、`ARROW_COLORS`（从源码 import，不写字面量）。

- [ ] **Step 1: 写 spec（先 RED）**

boot 照 `tests/enemy-counts.spec.mjs`：`page.goto('/?vd=4&seed=12345')` + `waitForFunction(worldReady)`，`test.setTimeout(180_000)`。
用例（每条都从真实入口进，不伪造 state）：

1. **装配与层级**：`#mc-enemy-arrows` 存在、`parentElement.id === 'hud-root'`、`zIndex === '52'`、`pointerEvents === 'none'`；5 个槽都在 DOM 里。
2. **背后丧尸出箭头**：`g.player.yaw = 0`（前向 −Z）、`pitch = 0`；在玩家 **+Z 方向 12 格**处 `g.zombies.spawn([...])`（正后方）；等 2 帧 ⇒ zombie 槽 `display !== 'none'`，三角 `borderLeftColor` = `rgb(74, 222, 128)`，槽中心在屏幕内且落在内缩带上。
3. **背后左右不镜像**：两只丧尸分别放右后（+X,+Z）与左后（−X,+Z），**只留一只**分两轮测；判据 = 用 `camera.matrixWorldInverse` **独立**算相机空间 x 的符号，与箭头 `x - vw/2` 的符号一致。
4. **转向后消失**：把 `yaw` 改成 `Math.PI`（面向 +Z）⇒ 等 2 帧 ⇒ zombie 槽 `display === 'none'`。
5. **count = 屏外数**：3 只丧尸全在正后方不同距离 ⇒ 读数含 `×3`，与 `g.entities.count('zombie')` 独立对账；再把其中 1 只挪到正前方屏内 ⇒ 读数变 `×2`。
6. **士兵留尸排除**：`g.soldiers.spawn` 两只在正后方；`g.damageEntity(ids[0], 1e9, performance.now())`；等 400ms（留尸窗口内，`activeEntities().length` 仍为 2）⇒ 读数 `×1`。
7. **焰魔黄色**：`g.ignises.summon('arrows:e2e', px, pz+10, 1, py)`（正后方）⇒ ignis 槽可见、色 = `rgb(250, 204, 21)`。
8. **距离读数**：读 zombie 槽文本里的 `NNm`，与 `Math.hypot` 独立算的距离比对（±1）。
9. **模态不被压住**：打开设置面板（`g.settingsPanel.open()` 或真实点击 `#settings-btn`）⇒ 面板 z-index 70 > 52；用 `document.elementFromPoint(箭头中心)` 断言返回的不是箭头节点（`pointer-events:none` ⇒ 必然穿透，故这条只钉 z-index 数值关系 + 面板覆盖矩形包含箭头中心）。

⚠️ **落点必须真在屏外**：召唤前先用 `camera.matrixWorldInverse` 验算该点 `cz >= 0`（正后方），
不满足就换落点 —— 否则用例在测「屏内不画箭头」而以为是「背后画箭头」。
⚠️ **等帧而不是等固定 ms**：`await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`（几何每帧算，两帧足够）。

- [ ] **Step 2: 跑 spec 确认 RED**

Run: `npx playwright test tests/enemy-arrows.spec.mjs`（**不接管道**）
Expected: 全部 FAIL（元素不存在）。若端口被占，用 `MC_PORT=<空闲端口>` 两侧同源。

- [ ] **Step 3: 修实现直到 GREEN**

只改 `src/ui/enemy-arrows.js` / `game.js`；**不改断言阈值**。

- [ ] **Step 4: 归档 + 门禁**

`tools/test-tiers.mjs` 的 `UI` 加 `'enemy-arrows'`。
Run: `npm run check` → exit 0
Run: `npx playwright test tests/enemy-arrows.spec.mjs tests/enemy-counts.spec.mjs` → 全绿

---

### Task 4: 负向验证（6 条注入必须真 FAIL）

**Files:**
- Modify（临时）: `src/ui/enemy-arrows.js`
- 备份: `cp src/ui/enemy-arrows.js /tmp/enemy-arrows.bak.js`（**还原一律用 cp，禁 git checkout**）

- [ ] **Step 1: 备份并记录 sha256**

Run: `cp src/ui/enemy-arrows.js /tmp/enemy-arrows.bak.js && shasum -a 256 src/ui/enemy-arrows.js /tmp/enemy-arrows.bak.js`

- [ ] **Step 2: 逐条注入 → 跑对应判据 → 读回源码确认注入落地 → cp 还原 → 核对 sha256**

| # | 注入 | 期望真红的判据 |
|---|---|---|
| N1 | `behind = cz >= -0.05` → `behind = false` | E2E 用例 2（背后丧尸出箭头） |
| N2 | `Math.abs(cz)` → `cz`（并让 sx 额外取反） | E2E 用例 3（背后左右）+ Node ⑤ |
| N3 | 删士兵 `dead` 过滤 | E2E 用例 6 + Node ⑩ |
| N4 | `count++` 移到屏外判据**之前** | E2E 用例 5 + Node ⑨ |
| N5 | `d < bestD` → `d > bestD`（初值改 -Infinity） | Node ⑨（指向最近那只） |
| N6 | `arrowOpacity` 直接 `return 1` | Node ⑧（包络） |

每条都要在报告里给出**实际失败读数**（不是「预期会红」）。

- [ ] **Step 3: 确认全部还原**

Run: `shasum -a 256 src/ui/enemy-arrows.js /tmp/enemy-arrows.bak.js`（两值必须相同）
Run: `node tools/run-unit-node.mjs --only=test-enemy-arrows.js` → PASS

---

### Task 5: 文档与最小充分集验证

**Files:**
- Modify: `CLAUDE.md`（UI 层级不等式加「敌人方位箭头 52」；`AGENTS.md` 是符号链接，不单独改）
- Modify: `docs/roadmap.md`（新增 v3.42 行，格式照既有行：用户原话 + 裁定 + 结构 + 判据坑 + 负向验证 + 验证命令与读数）
- Modify: `docs/pitfalls.md`（若本轮踩到新的静默失效形态，追加到 HUD/UI 相关节）

- [ ] **Step 1: 改 CLAUDE.md 的层级不等式**

`… 坐标/性能面板 50 = 血心 50 < **敌人方位箭头 52** < 伤害数字 55 < 受伤红闪 56 < …`

- [ ] **Step 2: 写 roadmap v3.42 行**

含：用户原话、三项 `ask_user_question` 裁定、`|cz|` 单公式的载荷性、count 口径、留尸过滤、
z-index 52、零 draw call、负向验证 6 条的实际读数、验证命令与结果、既有无关失败如实记录。

- [ ] **Step 3: 最小充分集**

Run: `npm run check`
Run: `npm run test:unit`（Node 轻档全量，确认新文件没破坏别的）
Run: `npx playwright test tests/enemy-arrows.spec.mjs tests/enemy-counts.spec.mjs`
Expected: 全绿（既有无关失败如实记录，不修、不放宽阈值）。

**不跑**：`npm test`（非全局基础设施、非里程碑）、`npm run bench`（不碰热路径）。

- [ ] **Step 4: 自审并报告**

Native 内联执行 ⇒ 无新鲜视角 reviewer，**必须在最终报告里明说是 self-review**。
报告列出：改了哪些文件、跑了哪些命令与读数、6 条负向验证的实际失败值、既有无关失败、未跑的验证及理由。