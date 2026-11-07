# 焰魔（Ignis）Boss 导入 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Bedrock 素材包里的焰魔（53 骨骼 / 88 立方体 / 纯 Molang 待机 + 数值攻击）导入 mc-heavy，作为高台地带的第二个 Boss（slot 1），地面行走、挥剑近战、可被玩家打死。

**Architecture:** 新建独立的 Bedrock 烘焙管线（不复用飞龙的 bbmodel 烘焙器——输入格式不同）。烘焙期用 Molang 子集求值器把表达式动画转成帧序列；运行期焰魔是**临时地面实体**（`persistent: false`，同飞龙），AI 走 `BossAgent` 子类三态机，物理复用丧尸的分轴碰撞 + step-up（碰撞判据参数化成 AABB 无关），攻击意图写进 `attackRequest` 由 `game.js` 消费并扣玩家血。

**Tech Stack:** Node 26（烘焙，无新依赖）、three r185.1（SkinnedMesh）、Playwright（Tier 4）、既有 `pngjs`（烘焙期 PNG 读写）。

**Spec:** `docs/superpowers/specs/2026-11-05-ignis-boss-design.md`

## Global Constraints

- **同构层禁 three/DOM**：`src/entities/**` 不得 `import 'three'`、不得引用 `document`/`window`/`createImageBitmap`、不得 `new Worker`（`npm run check:arch` 静态门守）。唯一 Worker 入口是 `core/worker-pool.js`。
- **资源路径只走 `resourceUrl()`**：禁止 `'/assets/...'`、`'/src/...'` 站点根绝对路径字面量。
- **`WorkerPool.call()` 返回 `{id, promise}`**，不是 promise。
- **时间基准统一 `performance.now()`**，禁止 `Date.now()`。
- **坐标类判据一律非负取模**（JS 的 `%` 对负数返回负值）。
- **状态推进不得原地改写**：`EntityManager.update` 的跨 column 索引迁移判据是「赋值前 position vs 赋值后 position」，必须返回全新 state + 全新数组。
- **烘焙 = 数据格式转换，不新增任何美术资源**。
- **素材入库**：烘焙输入放 `assets/ignis/src/`，不放 `assets/textures/`（后者被 `build-atlas` 递归扫描）。
- **不提交**：本计划的每个 commit 步骤只在用户明确要求时执行；默认实现后停下报告。
- **重生点数值禁止写死**：所有玩法数值从 `ignis-config.js` 派生，不得在 system/renderer/test 里写第二份字面量。
- **Tier 1 必须 TDD**：先写失败测试再实现。计时/像素类断言必须先打印实际值再定阈值。

## Review Focus

1. **Bedrock 骨骼变换的 `T(-pivot)` 项** —— 素材的 `cube.origin` 是**绝对模型空间**坐标，骨骼必须按 `M = M(parent) · T(pivot) · R(rot) · T(-pivot)` 计算。漏掉 `T(-pivot)` 的形态是模型炸成碎片（每个部件被甩到别处），而**所有计数类断言（53 骨骼 / 88 立方体 / 顶点数）全部通过**。这正是本计划最容易出错、且单测最难抓到的一处。
2. **Bedrock box UV 布局** —— 六面矩形由 `[u,v]` 起点 + 尺寸自动铺开，顺序是「down, up, 西, 北(正面), 东, 南」。写错的形态是贴图错位到邻面（脸跑到侧面），而 UV 全部落在 [0,1] 内、指纹全对。
3. **`inflate` 的语义** —— 是向外均匀外扩（盒从 `origin-inflate` 到 `origin+size+inflate`），不是尺寸加 `inflate`。写错的形态是 18 个外扩部件（肩甲/胸甲/护腿）**内缩半格**，观感是装甲嵌进身体。
4. **`mirror` 的 u 翻转** —— 22 个镜像件。不翻的形态是左右两侧贴图不对称（左肩金的、右肩同样的金但方向反了看不出，而 `right_helmet` 之类有明确朝向的会明显错）。
5. **`pivot` 是绝对坐标 vs `localPosition` 是相对坐标** —— 这两个概念混淆会得到「模型能渲染但关节位置全偏」。飞龙的 `bake-dragon.mjs` 已经踩过这个坑（它的文件头有完整推导），本计划直接复用它的解法。
6. **地面实体的 `position` 语义** —— 丧尸的 `position` 是脚底，飞龙的是身体中心。焰魔是地面实体，**必须用脚底**（否则重力/step-up 全部错位一格半）。而模型最低顶点在 **y = −0.304 格**（不是 0），渲染时必须补偿。

---

## File Structure

| 文件 | 职责 |
|---|---|
| `tools/molang-eval.mjs` | Molang 子集求值器（node 侧；烘焙期用） |
| `tools/ignis-fingerprint.mjs` | 烘焙参数 / 产物度量 / 输入指纹的**唯一权威**（烘焙脚本与 `check-data` 共用） |
| `tools/bake-ignis.mjs` | Bedrock `geo.json` + `animation.json` → `assets/ignis/ignis.json` + `.png` + `.meta.json` |
| `src/entities/ignis/ignis-config.js` | 玩法数值 + 模型度量（同构，**运行期唯一权威**） |
| `src/entities/ignis/ignis-system.js` | `ignisDefinition` + `IgnisService`（同构） |
| `src/entities/bosses/ignis-boss-agent.js` | 地面三态机 AI（`BossAgent` 子类，同构） |
| `src/entities/entities-navigation.js`（改） | `zombie-navigation.js` 参数化为 AABB 无关 |
| `src/render/ignis-model.js` | 产物装载 + 动画采样（three-free 采样函数） |
| `src/render/ignis-renderer.js` | SkinnedMesh 渲染器 |
| `src/player/health.js`（改） | 新增 `applyDamage()` |
| `src/entities/bosses/boss-registry.js`（改） | TARN 名册加 slot 1 |
| `src/entities/entity-types.js`（改） | `WEAPON_HITTABLE_TYPES` 加 `ignis` |
| `src/core/game.js`（改） | service + renderer 装配；`damageEntity` 路由；攻击结算 |
| `tools/check-data.mjs`（改） | `[焰魔]` 契约环节 |
| `src/tests/index.html`（改） | 注册新单测 |

---

### Task 1: Molang 子集求值器

**Files:**
- Create: `tools/molang-eval.mjs`
- Test: `src/tests/test-molang.js`

**Interfaces:**
- Produces:
  - `compileMolang(expr: string) -> (scope: {lifeTime: number, targetYaw?: number, targetPitch?: number}) => number`
  - `MolangError extends Error` —— 不支持任何语法时抛出
- 支持的标识符**仅**：`q.life_time`、`q.target_y_rotation`、`q.target_x_rotation`、`Math.sin`、`Math.cos`
- 支持的运算：`+ - * /`、括号、一元负号、数字字面量（含 `-96` 这类）

- [ ] **Step 1: 写失败测试**

```js
// src/tests/test-molang.js
import { test } from './runner.js';
import { assertEqual, assertTrue, assertThrows } from './assert.js';
import { compileMolang, MolangError } from '../../tools/molang-eval.mjs';

// 素材里实际出现的 4 条表达式，逐字复制（改素材这里会同步报出）
test('molang: 素材 generala 的四条表达式逐条求值', () => {
  const cases = [
    ['Math.sin(q.life_time * 128) * -2.5', 0, 0],
    ['2.5 + Math.sin(q.life_time * 128) * 2.5', 0, 2.5],
  ];
  for (const [expr, t, want] of cases) {
    const f = compileMolang(expr);
    assertEqual(f({ lifeTime: t }), want, expr);
  }
});

test('molang: generalb 的带负偏移常量', () => {
  const f = compileMolang('Math.sin(q.life_time * 128 + (-96)) * 0.75');
  const want = Math.sin(0 * 128 + (-96)) * 0.75;
  assertEqual(f({ lifeTime: 0 }), want);
});

test('molang: q.target_y_rotation / q.target_x_rotation 读 scope', () => {
  const fy = compileMolang('q.target_y_rotation');
  const fx = compileMolang('q.target_x_rotation');
  assertEqual(fy({ lifeTime: 0, targetYaw: 17.5 }), 17.5);
  assertEqual(fx({ lifeTime: 0, targetPitch: -3.25 }), -3.25);
});

test('molang: 缺省的 target 旋转按 0（烘焙期它们不可知）', () => {
  assertEqual(compileMolang('q.target_y_rotation')({ lifeTime: 0 }), 0);
  assertEqual(compileMolang('q.target_x_rotation')({ lifeTime: 0 }), 0);
});

// assertThrows(fn, ExpectedErrorClass) —— 第二参是错误类，不是消息串
test('molang: 未知标识符抛错，不静默回 0', () => {
  assertThrows(() => compileMolang('Math.cos(q.life_time)'), MolangError);
  assertThrows(() => compileMolang('q.ground_speed'), MolangError);
  assertThrows(() => compileMolang('variable.foo * 2'), MolangError);
});

test('molang: 语法错误抛错', () => {
  assertThrows(() => compileMolang('1 +'), MolangError);
  assertThrows(() => compileMolang('(1'), MolangError);
  assertThrows(() => compileMolang(''), MolangError);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm start` 后打开 `http://localhost:8081/src/tests/index.html`
Expected: FAIL —— `Cannot find module '../../tools/molang-eval.mjs'`

- [ ] **Step 3: 实现求值器**

递归下降解析（词法 → 语法 → 闭包树）。`compileMolang` 返回一个闭包，闭包内每个节点是 `(scope) => number`。

错误用 `MolangError`（构造时把原表达式放进 message，烘焙时一眼看出是哪条）。

⚠️ **`Math.cos` 明确不支持**：素材里只出现 `Math.sin`，加 `cos` 会让「素材悄悄换了函数」不被发现。若将来素材用了 `cos`，`MolangError` 会当场指出。

- [ ] **Step 4: 运行测试确认通过**

Run: 同 Step 2
Expected: PASS（`test-molang.js` 全绿）

- [ ] **Step 5: 加进测试入口**

在 `src/tests/index.html` 的 import 列表里加 `import './test-molang.js';`（位置紧邻其它 `test-*.js`）。

Run: `npm run check:data`
Expected: PASS —— `[测试注册]` 环节双向钉住（新文件必须出现在 index.html，否则报错）

- [ ] **Step 6: Commit**

```bash
git add tools/molang-eval.mjs src/tests/test-molang.js src/tests/index.html
git commit -m "feat(ignis): Molang 子集求值器（烘焙期用，未知标识符抛错）"
```

---

### Task 2: 烘焙指纹模块

**Files:**
- Create: `tools/ignis-fingerprint.mjs`
- Test: 无独立测试（被 Task 3 的产物契约测试覆盖）

**Interfaces:**
- Consumes: 无
- Produces（Task 3 与 `check-data.mjs` 都 import 这些）：
  - `IGNIS_SRC_DIR: string`
  - `IGNIS_GEO_SRC: string`、`IGNIS_ANIM_SRC: string`、`IGNIS_TEX_SRC: string`
  - `IGNIS_JSON`、`IGNIS_PNG`、`IGNIS_META`
  - `IGNIS_BAKE_PARAMS: {pxPerBlock: 16, textureSize: 256, defaultFps: 30, idleFrameCount: 12}`
  - `IGNIS_METRICS: {boneCount: 53, cubeCount: 88, skippedCubes: 8, bakedCubes: 80, bonesWithCubes: 50, vertexCount: 1920, indexCount: 2880}`
  - `ignisInputFingerprint() -> {input: string, sourceSha256: string, paramsSha256: string}`
  - `IGNIS_ANIM_PERIODS: {idle: number, attack: number}`（`idle` = `2 * Math.PI / 128`；`attack` = 2.75 ——
    对应素材 `attack6a` 的 `animation_length`，**不是** `attack1` 的 3.5）

**实测值来源**（不是猜的）：
- 骨骼 53 / 立方体 88 / 零尺寸 8 ⇒ 烘焙 80 个；带立方体的骨骼 50（Python 实测）
- 每立方体 `BoxGeometry` 产出 24 顶点 / 36 索引 ⇒ `80 × 24 = 1920` 顶点、`80 × 36 = 2880` 索引
- `idle` 周期 = `2π / 128 = 0.04908738521234052` 秒（素材表达式 `q.life_time * 128`）
- `attack` 长度 = **2.75** 秒（素材 `attack6a` 的 `animation_length` = 55 tick）
  ⚠️ **用 `attack6a` 而不是 `attack1`**：tick 配对表（spec §2.0）显示 55 tick ↔ Java `SWING_ATTACK`，
  而 `attack1`（70 tick）对应的是 `SHIELD_SMASH_ATTACK`（盾碎）。交叉证据：`attack6a` 的
  `root.rotation.y` 到 −65°（配得上 arc 70° 的横扫），`attack1` 只到 +30°

- [ ] **Step 1: 实现指纹模块**

照 `tools/dragon-fingerprint.mjs` 的结构（路径常量 + `*_BAKE_PARAMS` + `*_METRICS` + `*InputFingerprint()`）。`input` 指纹格式与飞龙一致：`${sourceSha256.slice(0,16)}:${paramsSha256.slice(0,16)}`，其中 `sourceSha256` 是**三个输入文件内容的串联 sha256**（geo + anim + png）。

⚠️ **`idleFrameCount: 12` 与 `IGNIS_ANIM_PERIODS.idle` 是同一个事实的两面**（帧数取 12，`fps = 12 / period`）。两者写在同一对象里，`period` 由 `2 * Math.PI / 128` 算出（**不写 0.0490873 字面量**——写死会让改素材频率时静默过期）。

- [ ] **Step 2: 验证指纹可算**

Run: `node -e "import('./tools/ignis-fingerprint.mjs').then(m => console.log(m.ignisInputFingerprint()))"`
Expected: 打印 `{input: 'xxxxxxxxxxxxxxxx:yyyyyyyyyyyyyyyy', ...}`，且不抛错

> 前提：Task 3 Step 1 已把三份素材拷到 `assets/ignis/src/`。若该步尚未做，先执行 Task 3 Step 1。

- [ ] **Step 3: Commit**

```bash
git add tools/ignis-fingerprint.mjs
git commit -m "feat(ignis): 烘焙参数/度量/输入指纹共享模块"
```

---

### Task 3: Bedrock 烘焙器

**Files:**
- Create: `tools/bake-ignis.mjs`
- Create（产物，由脚本生成，需入库）: `assets/ignis/ignis.json`、`assets/ignis/ignis.png`、`assets/ignis/ignis.meta.json`
- Create（素材，入库）: `assets/ignis/src/ignis.geo.json`、`assets/ignis/src/ignis.animation.json`、`assets/ignis/src/ignis_idle_0.png`
- Test: `src/tests/test-ignis-bake.js`
- Modify: `package.json`（加 `"ignis": "node tools/bake-ignis.mjs"` 到 scripts）

**Interfaces:**
- Consumes: `tools/ignis-fingerprint.mjs`（Task 2 全部导出）、`tools/molang-eval.mjs`（Task 1 的 `compileMolang`）
- Produces:
  - `assets/ignis/ignis.json` 形状：`{scale: number, bones: Array<{name, parentIndex, localPosition: [x,y,z], bindQuaternion: [x,y,z,w]}>, geometry: {position: number[], normal: number[], uv: number[], skinIndex: number[], index: number[]}, animations: {idle: {fps, frameCount, boneIndices, frames}, attack: {...}}, metrics: {...}}`
  - 与飞龙产物的**唯一结构差异**：多一个 `bindTranslation` 不需要（`localPosition` 已含），但 `animations.idle.fps` 不是整数

- [ ] **Step 1: 素材入库**

```bash
mkdir -p assets/ignis/src
cp "/tmp/yanmo_extract/焰魔RP/models/entity/ignis.geo.json" assets/ignis/src/ignis.geo.json
cp "/tmp/yanmo_extract/焰魔RP/animations/ignis.animation.json" assets/ignis/src/ignis.animation.json
cp "/tmp/yanmo_extract/焰魔RP/textures/null/entity/ignis_idle_0.png" assets/ignis/src/ignis_idle_0.png
```

> 素材已在 `/tmp/yanmo_extract` 解包（GBK 路径）。若该目录已丢，重新解包：
> `python3 -c "import zipfile,os; z=zipfile.ZipFile('/Users/bachi/Downloads/[苦力怕论坛]v1.3.0-焰魔.mcaddon'); [open(os.path.join('/tmp/yanmo_extract', (i.filename.encode('cp437').decode('gbk') if not i.flag_bits&0x800 else i.filename)),'wb').write(z.read(i)) for i in z.infolist() if not i.is_dir()]"`（需先建目录）

- [ ] **Step 2: 写失败测试**

```js
// src/tests/test-ignis-bake.js
import { test } from './runner.js';
import { assertEqual, assertTrue } from './assert.js';

let asset;
export async function setup() {
  const res = await fetch('/assets/ignis/ignis.json');
  asset = await res.json();
}

test('ignis-bake: 骨骼数与素材一致', () => {
  assertEqual(asset.bones.length, 53);
});

test('ignis-bake: 顶点/索引数 = 烘焙立方体数 × 24 / 36', () => {
  assertEqual(asset.geometry.position.length / 3, 1920);
  assertEqual(asset.geometry.index.length, 2880);
});

test('ignis-bake: 全部 UV 落在 [0,1] 内', () => {
  for (const v of asset.geometry.uv) assertTrue(v >= 0 && v <= 1, `uv ${v}`);
});

test('ignis-bake: 零尺寸薄片被跳过（80 个立方体参与烘焙）', () => {
  assertEqual(asset.metrics.bakedCubes, 80);
  assertEqual(asset.metrics.skippedCubes, 8);
});

// ⚠️ 这条是 Review Focus 1 的守卫：漏 T(-pivot) 时模型炸开，但计数全对
test('ignis-bake: bind pose 的模型包围盒高度约 4.07 格（漏 T(-pivot) 会炸开到数倍）', () => {
  const h = bindPoseHeightBlocks(asset);
  assertTrue(Math.abs(h - 4.0668) < 0.02, `高度 ${h}`);
});

test('ignis-bake: idle fps 不是整数，且 duration 逐位等于 2π/128', () => {
  const a = asset.animations.idle;
  assertTrue(a.fps !== Math.round(a.fps), `fps ${a.fps} 被取整了`);
  assertTrue(Math.abs(a.frameCount / a.fps - 2 * Math.PI / 128) < 1e-12, `duration ${a.frameCount / a.fps}`);
  assertEqual(a.frameCount, 12);
});

test('ignis-bake: attack 是 82 帧 @ 30fps（素材 attack6a 的 animation_length 2.75s）', () => {
  assertEqual(asset.animations.attack.frameCount, 83);   // Math.round(2.75 * 30)
  assertEqual(asset.animations.attack.fps, 30);
  // 采样 t = f/fps, f ∈ [0,83) ⇒ 末帧 t = 82/30 = 2.7333，距素材 2.75 差半帧
  const lastT = (asset.animations.attack.frameCount - 1) / asset.animations.attack.fps;
  assertTrue(Math.abs(lastT - 2.75) < 1 / 30 + 1e-9, `末帧 t=${lastT}`);
});

// ⚠️ 命中帧 = 1.20s（作者 SWING_ATTACK 的 tick 24 / 20）
test('ignis-bake: 攻击动画在命中帧（t=1.20）姿态与首帧显著不同', () => {
  const d = frameDelta(asset.animations.attack, 0, Math.round(1.20 * 30));
  assertTrue(d > 0.15, `delta ${d}`);
});
```

`bindPoseHeightBlocks` / `frameDelta` 是测试文件里的两个 local helper（前者把 bind pose 的 `localPosition` + `bindQuaternion` 层级累乘后算所有几何顶点的 y 跨度再 `/16`；后者对两帧的四元数取最大分量差）。

- [ ] **Step 3: 运行测试确认失败**

Run: `npx playwright test` → 不行，这是浏览器内单测。打开 `http://localhost:8081/src/tests/index.html`
Expected: FAIL —— `fetch('/assets/ignis/ignis.json')` 404

- [ ] **Step 4: 实现烘焙器**

骨架照 `tools/bake-dragon.mjs`，**五处必须按下面写**：

1. **骨骼局部变换**（Review Focus 5）：
   ```js
   // pivot 是绝对模型空间 → 必须做旋转修正（同 bake-dragon.mjs 的解法）
   worldQuat[i] = parentWorldQuat * localQuat
   localPosition = R_parentWorld⁻¹ · (childPivot − parentPivot)
   bindQuaternion = localQuat
   ```
   ⚠️ 这一项是给**运行期骨骼层级**用的（three 的 `Bone.position` 是相对父骨骼）。
   与下面第 2 项的 `T(-pivot)` 是**两件不同的事**，不要合并。

2. **立方体顶点是绝对模型空间坐标，直接写入**（Review Focus 1）：`origin`/`size` 不用减 pivot，
   `BoxGeometry(size + 2*inflate)` 后 `translate(center)`，其中 `center = origin + size/2`。
   旋转由骨骼的 `bindQuaternion` 在运行期施加 —— **烘焙器不需要乘任何矩阵**。
   > 本节 Step 2 的 `bindPoseHeightBlocks` helper 会做累乘验证这一点。

3. **`inflate` 语义**（Review Focus 3）：`BoxGeometry(sx+2*inf, sy+2*inf, sz+2*inf)`，
   中心不变（`origin + size/2`）。**不是** `size + inflate`。

4. **Bedrock box UV 布局**（Review Focus 2）—— 顺序固定为：

   | 面序（BoxGeometry） | 面名 | 源矩形（`[u0,v0]` 起点 + 尺寸 `w×h`） |
   |---|---|---|
   | 0 `+X` | east | `(u0 + dz + dx, v0 + dz)` 尺寸 `(dz, dy)` |
   | 1 `-X` | west | `(u0, v0 + dz)` 尺寸 `(dz, dy)` |
   | 2 `+Y` | up | `(u0 + dz + dx, v0)` 尺寸 `(dx, dz)` |
   | 3 `-Y` | down | `(u0 + dz, v0)` 尺寸 `(dx, dz)` |
   | 4 `+Z` | south | `(u0 + dz + dx + dz, v0 + dz)` 尺寸 `(dx, dy)` |
   | 5 `-Z` | north | `(u0 + dz, v0 + dz)` 尺寸 `(dx, dy)` |

   **本表已由软件光栅化实测验证**（渲染出的正视图与素材一致：脸在正前方、角在头顶、
   肩甲在两侧、剑在右手）。⛔ **不要凭 Minecraft 文档「推导」重排这张表**——
   已知按 `ModelPart.Cube` 的 Java 源码顺序（down, up, west, north, east, south）铺
   会得到**错误的**结果（实测眼睛跑到两侧）。

5. **`mirror`**（Review Focus 4）：u 方向翻转 `u' = u_start + u_width − u`，
   作用在该面已算出的矩形上（v 不动）。

6. **动画重采样**：
   - `idle`：`frameCount = 12`，`fps = 12 / (2π/128)`（≈ 244.4577，**不取整**）。
     采样时刻 `t = f / fps`，代入 Molang 的 `q.life_time`。
     `q.target_y_rotation` / `q.target_x_rotation` 按 **0** 传（见 spec §4.2）。
     ⚠️ `generala` 与 `generalb` 是**两条**动画、驱动不同骨骼，必须**合并成一条** `idle`
     （两边的表达式在同一个时刻求值后一起写进同一帧）。素材把它们拆成两条是因为 Bedrock
     的 `animate` 列表会同时播放；本仓产物每帧只采一条动画。
   - `attack`：取 **`animation.null.ignis.attack6a`**，`fps = 30`，`frameCount = 83`
     （`Math.round(2.75 × 30)` = **83**，与 `bake-dragon.mjs` 的
     `Math.round(anim.length * ANIM_FPS)` 同一公式 —— 采样 `t = f/fps`，`f ∈ [0,83)`，
     末帧 t = 82/30 = 2.7333，距 `animation_length` 2.75 差半帧，可接受）。
     ⚠️ **不是 `attack1`** —— 见 Task 2 的配对依据。
     ⚠️ 素材里**没有剑/盾骨骼的关键帧**（`sword` 不在这条动画的 `bones` 里），
     剑跟着 `right_fist` 走 —— 正确，不要给 `sword` 补关键帧。

7. **旋转是增量还是绝对**：Bedrock 的关键帧值是**相对 bind pose 的增量**（与飞龙的
   `override: false` 同语义）。验证：`attack6a` 的 `root.rotation.y` 峰值 −65°，
   而 bind pose 里 `root` 没有 rotation ⇒ 两者无法区分；`head` 的 bind 是 −20.00196°，
   而 `attack6a` 给它数值关键帧 —— 若是绝对语义，头会在挥砍时从 −20° 跳到关键帧值（不合理）。
   ⇒ **按增量烘焙**（运行期 `bindQuat * deltaQuat`，与飞龙渲染器同口径）。

- [ ] **Step 5: 跑烘焙**

```bash
npm run ignis
```
Expected: 打印 `[焰魔] ✓ 53 骨骼 / 80 立方体 / 1920 顶点 / 2880 索引 / 贴图 256²` 与产物路径、指纹

- [ ] **Step 6: 运行测试确认通过**

Run: 打开 `http://localhost:8081/src/tests/index.html`
Expected: PASS（`test-ignis-bake.js` 全绿）

- [ ] **Step 7: 像素实测（Tier 4 前置）**

用 `tests/tmp-ignis-bake.spec.mjs`（一次性探针，已 gitignore）在真实游戏页把产物渲染成
SkinnedMesh 并截图，与 `/tmp/ignis_front.png`（本计划 Step 4 之前的软件光栅化参考）比对。

⚠️ **这一步不能跳过**：计数类断言抓不到 UV 布局错（Review Focus 2）。
Expected: 正视图能看到「脸 + 双眼 + 双角 + 肩甲 + 剑 + 盾」，与参考图一致。

- [ ] **Step 8: Commit**

```bash
git add tools/bake-ignis.mjs assets/ignis src/tests/test-ignis-bake.js package.json
git commit -m "feat(ignis): Bedrock 烘焙器（geo/anim/Molang → 产物 + 指纹）"
```

---

### Task 4: 碰撞判据参数化（丧尸零回归）

**Files:**
- Modify: `src/entities/zombies/zombie-navigation.js`
- Test: `src/tests/test-ignis-collision.js`

**Interfaces:**
- Consumes: 无
- Produces:
  - `aabbCollidesAt(world, x, y, z, halfWidth: number, height: number) -> boolean`
  - `steerIntentAabb({world, position, vx, vz, halfWidth, height, maxStep, steering}) -> {vx, vz, blocked}`
  - 既有 `zombieCollidesAt` / `steerIntent` / `zombieStepUpY` **签名与行为不变**（变成薄包装）

- [ ] **Step 1: 写失败测试（先钉住丧尸零回归）**

```js
// src/tests/test-ignis-collision.js
import { test } from './runner.js';
import { assertEqual, assertTrue, assertFalse } from './assert.js';
import {
  zombieCollidesAt, aabbCollidesAt, steerIntent, steerIntentAabb,
} from '../entities/zombies/zombie-navigation.js';
import { ZOMBIE } from '../entities/zombies/zombie-config.js';

/** 假世界：用一个 Set 存实心格 */
function fakeWorld(solid) {
  return { isSolid: (x, y, z) => solid.has(`${x},${y},${z}`) };
}

test('collision: zombieCollidesAt 与 aabbCollidesAt(丧尸参数) 逐位等价', () => {
  const w = fakeWorld(new Set(['1,0,0', '2,1,0', '0,0,1']));
  for (const p of [[0.5,0,0.5],[0.5,1,0.5],[1.5,0,0.5],[0.5,0,1.5],[3.5,0,3.5]]) {
    assertEqual(
      zombieCollidesAt(w, p[0], p[1], p[2]),
      aabbCollidesAt(w, p[0], p[1], p[2], ZOMBIE.width / 2, ZOMBIE.height),
      `at ${p}`,
    );
  }
});

test('collision: 1.0×3.25 的 AABB 撞到 1.8 高丧尸撞不到的天花板', () => {
  // 天花板在 y=3（1.8 高丧尸脚底 0 时头顶 1.8，够不到；焰魔 3.25 高够得到）
  const w = fakeWorld(new Set(['0,3,0']));
  assertFalse(aabbCollidesAt(w, 0.5, 0, 0.5, 0.3, 1.8));
  assertTrue(aabbCollidesAt(w, 0.5, 0, 0.5, 0.5, 3.25));
});

test('collision: steerIntent 与 steerIntentAabb(丧尸参数) 逐位等价', () => {
  const w = fakeWorld(new Set(['1,0,0']));
  const a = steerIntent({ world: w, position: [0.5,0,0.5], vx: 1.2, vz: 0 });
  const b = steerIntentAabb({
    world: w, position: [0.5,0,0.5], vx: 1.2, vz: 0,
    halfWidth: ZOMBIE.width / 2, height: ZOMBIE.height,
    maxStep: ZOMBIE_MAX_STEP, steering: ZOMBIE_STEERING,
  });
  assertEqual(a.vx, b.vx); assertEqual(a.vz, b.vz); assertEqual(a.blocked, b.blocked);
});
```

⚠️ `ZOMBIE_MAX_STEP` / `ZOMBIE_STEERING` 从 `zombie-config.js` import（它们已经在那里）。

- [ ] **Step 2: 运行测试确认失败**

Report: FAIL —— `aabbCollidesAt is not a function`

- [ ] **Step 3: 参数化实现**

把 `zombieCollidesAt(world, x, y, z)` 的盒尺寸提取成参数 → `aabbCollidesAt(world, x, y, z, halfWidth, height)`；
`zombieCollidesAt` 变成 `aabbCollidesAt(world, x, y, z, ZOMBIE.width/2, ZOMBIE.height)`。
`steerIntent` 同理：抽出 `steerIntentAabb`，原函数传丧尸参数。

⚠️ `PHYS_EPSILON` 的门控逻辑（`y1 = floor(y + height - EPSILON)`）**原样保留**，
参数化只换 `halfWidth`/`height` 两个数 —— 那条注释里记录的「净空恰好 1.8 的走廊」缺陷
不能因为重构而复现。

- [ ] **Step 4: 运行测试确认通过 + 丧尸全量回归**

Run: 打开 `http://localhost:8081/src/tests/index.html`
Expected: `test-ignis-collision.js` 全绿，且**既有** `test-zombie-navigation.js` / `test-zombie-system.js` 全绿

- [ ] **Step 5: Commit**

```bash
git add src/entities/zombies/zombie-navigation.js src/tests/test-ignis-collision.js
git commit -m "refactor(navigation): 碰撞/绕行判据参数化为 AABB 无关（丧尸零回归）"
```

---

### Task 5: 焰魔配置 + 实体定义

**Files:**
- Create: `src/entities/ignis/ignis-config.js`
- Create: `src/entities/ignis/ignis-system.js`
- Test: `src/tests/test-ignis-system.js`

**Interfaces:**
- Consumes: Task 4 的 `aabbCollidesAt` / `steerIntentAabb`
- Produces:
  - `IGNIS_TYPE = 'ignis'`
  - `IGNIS`：`{health, halfWidth, height, modelFeetOffsetY, attackDamage, flashMs, maxAlive}`
  - `IGNIS_AI`：`{sightRange, attackRange, hitRange, hitConeDeg, chaseSpeed, turnRate, gravity, maxStep, hitFrameSeconds, attackCooldownMin, attackCooldownMax, losInterval, disengageRange}`
  - `IGNIS_CORE_OBB`：`{halfExtents: [number,number,number], center: [number,number,number]}`
  - `IGNIS_MODEL_CENTER`：`[number, number, number]`
  - `ignisEntityIdFor(mapKey: string, slot: number) -> string`
  - `ignisDefinition`（`create` / `update` / `raycastAabb` / `serialize` / `deserialize`）
  - `IgnisService`（`constructor({entities, world, seed})` / `summon(mapKey, cx, cz, slot)` / `damage(id, amount, nowMs)` / `activeEntities()` / `dispose()`）

**实测数值（写进 config，来自本设计实测）**：
```js
// ⚠️ 全部取自 Java 作者的真实属性（Ignis_Entity.java 的 ignis()），不是猜的
IGNIS = {
  health: 450,             // 作者 MAX_HEALTH（与 Bedrock ignis.json 一致）
  halfWidth: 0.5,          // Bedrock collision_box width 1
  height: 3.25,            // Bedrock collision_box height 3.25
  modelFeetOffsetY: 0.3042, // 模型最低顶点在 y = -4.87px = -0.3042 格 → 渲染时抬这么多
  attackDamage: 14,        // 作者 ATTACK_DAMAGE
  flashMs: 200,
  maxAlive: 2,
}
```
`IGNIS_AI` 的**作者真实值**（照抄，不要改）：
```js
IGNIS_AI = {
  sightRange: 50,          // 作者 FOLLOW_RANGE
  chaseSpeed: 6.6,         // 作者 MOVEMENT_SPEED 0.33 格/tick × 20
  hitRange: 6.5,           // 作者 AreaAttack 的 range（SWING_ATTACK）
  hitConeDeg: 35,          // 作者 AreaAttack 的 arc=70 → 半角。⚠️ 填 70 会变 140° 扇面
  hitFrameSeconds: 1.20,   // 作者在 SWING_ATTACK 的 tick 24 结算；24/20
  attackAnimSeconds: 2.75, // 作者 SWING_ATTACK = 55 tick ↔ 素材 attack6a
  // ---- 以下 6 项是本仓自己标定（Java 无对应项）----
  attackRange: 5.5,        // < hitRange 的滞回门
  disengageRange: 60,      // sightRange × 1.2 滞回上界
  turnRate: 3.0,           // 与飞龙同
  attackCooldownMin: 2.75, // = 动画时长；动画播完才可能再起手
  attackCooldownMax: 5.0,
  losInterval: 0.1,
  gravity: -24,            // 与 zombie-system / player/physics 同口径
  maxStep: 1.0,            // 与 ZOMBIE_MAX_STEP 同口径
}
```

`IGNIS_CORE_OBB.halfExtents` = `[0.8264, 1.421, 0.777]`（躯干核心 bbox 实测），
`center` = `[0, 0, 0]`（`position` 语义 = 身体核心中心，与飞龙同）。
`IGNIS_MODEL_CENTER` = `[0, 1.7335, 0.0895]`（核心 bbox 中心，相对模型原点，单位格）。

- [ ] **Step 1: 写失败测试**

```js
// src/tests/test-ignis-system.js
import { test } from './runner.js';
import { assertEqual, assertNull, assertTrue } from './assert.js';
import {
  IGNIS_TYPE, IGNIS, IGNIS_CORE_OBB, IGNIS_MODEL_CENTER, ignisEntityIdFor,
  ignisDefinition, IgnisService,
} from '../entities/ignis/ignis-system.js';
import { EntityManager } from '../entities/entity-manager.js';

test('ignis: create 拒绝非法 position', () => {
  assertNull(ignisDefinition.create({ position: [NaN, 0, 0] }));
  assertNull(ignisDefinition.create({ position: [0, 0] }));
  assertNull(ignisDefinition.create(null));
});

test('ignis: create 补全缺省字段（health = IGNIS.health）', () => {
  const st = ignisDefinition.create({ position: [1, 2, 3] });
  assertEqual(st.health, IGNIS.health);
  assertEqual(st.mode, 'idle');
});

test('ignis: 实体 id 由 (mapKey, slot) 派生，同参恒同 id', () => {
  assertEqual(ignisEntityIdFor('tarn:2:0', 1), ignisEntityIdFor('tarn:2:0', 1));
  assertTrue(ignisEntityIdFor('tarn:2:0', 1) !== ignisEntityIdFor('tarn:3:0', 1));
});

test('ignis: summon 幂等（同槽位二次召唤返回 exists）', () => {
  const em = new EntityManager();
  em.registerType(IGNIS_TYPE, ignisDefinition);
  const svc = new IgnisService({ entities: em, world: null, seed: 1 });
  const a = svc.summon('tarn:2:0', 100, 200, 1);
  assertTrue(a.ok, JSON.stringify(a));
  const b = svc.summon('tarn:2:0', 100, 200, 1);
  assertEqual(b.reason, 'exists');
});

test('ignis: damage 到 0 即 despawn', () => {
  const em = new EntityManager();
  em.registerType(IGNIS_TYPE, ignisDefinition);
  const svc = new IgnisService({ entities: em, world: null, seed: 1 });
  const { id } = svc.summon('tarn:2:0', 0, 0, 1);
  const r1 = svc.damage(id, IGNIS.health - 1, 1000);
  assertEqual(r1.dead, false);
  const r2 = svc.damage(id, 1, 1000);
  assertEqual(r2.dead, true);
  assertNull(em.get(id));
});

test('ignis: CORE_OBB 与 MODEL_CENTER 的字面量来自实测（防手改漂移）', () => {
  assertEqual(IGNIS_CORE_OBB.halfExtents[1], 1.421);
  assertEqual(IGNIS_MODEL_CENTER[1], 1.7335);
  assertEqual(IGNIS.modelFeetOffsetY, 0.3042);
});
```

- [ ] **Step 2: 运行测试确认失败**

Expected: FAIL —— module not found

- [ ] **Step 3: 实现 config**

照 `dragon-config.js` 的结构：文件头写「同构层：无 DOM、无 three」，每个常量带出处注释
（实测值标注「实测」、用户裁定标注「用户裁定」、待调标注「可调」）。

⚠️ **`IGNIS.modelFeetOffsetY` 的语义要写清**：`position` 是脚底，但模型的 y=0 平面
**不是**脚底（最低顶点在 −0.3042 格）⇒ 渲染时 `mesh.position.y = +modelFeetOffsetY`。

- [ ] **Step 4: 实现 system**

`createState` 照 `dragon-system.js` 的 `createState` 手法（校验 + 全新对象 + 全部字段有缺省）。
`ignisDefinition.update` 委托给 `IgnisBossAgent`（Task 7 才实现，本步先用一个**只做重力的
最小实现**占位，Task 7 再替换 —— 这样本任务可以独立测通）。

`IgnisService.summon` 与 `DragonService.summon` 同形状，差异：
- 找落点：从 `(cx, cz)` 起向下扫到第一个「脚下实心且自身与头顶都是空气」的 y（照
  `game.js teleportToTarnZone` 的 `plateauY` 向上扫描手法，**不要用 `findSpawnY`** —— 它会把巨型云当地面）
- `persistent: false`（临时实体，同飞龙）
- `maxAlive` 超出返回 `{ok:false, reason:'limit'}`

- [ ] **Step 5: 运行测试确认通过**

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/entities/ignis src/tests/test-ignis-system.js
git commit -m "feat(ignis): 配置 + 实体定义 + service（地面落点、幂等召唤、死亡即消失）"
```

---

### Task 6: 玩家掉血纯函数

**Files:**
- Modify: `src/player/health.js`
- Test: `src/tests/test-health.js`（已存在，追加用例）

**Interfaces:**
- Produces: `applyDamage(health: number, amount: number) -> number`（钳制到 `[0, PLAYER_MAX_HEALTH]`）

- [ ] **Step 1: 追加失败测试**

```js
// 追加到 src/tests/test-health.js
test('applyDamage: 正常扣血', () => {
  assertEqual(applyDamage(20, 3), 17);
  assertEqual(applyDamage(4, 3), 1);
});

test('applyDamage: 下限钳到 0（用户裁定「停在 0 不动」）', () => {
  assertEqual(applyDamage(1, 3), 0);
  assertEqual(applyDamage(0, 99), 0);
});

test('applyDamage: 上限钳到 PLAYER_MAX_HEALTH（不回血）', () => {
  assertEqual(applyDamage(20, -5), 20);   // 负数伤害 = 0 伤害，不是治疗
});

test('applyDamage: 非法值不产生 NaN', () => {
  assertEqual(applyDamage(NaN, 3), PLAYER_MAX_HEALTH - 3);
  assertEqual(applyDamage(20, NaN), 20);
  assertEqual(applyDamage(20, Infinity), 20);
});
```

- [ ] **Step 2: 运行确认失败**

Expected: FAIL —— `applyDamage is not defined`

- [ ] **Step 3: 实现**

```js
export function applyDamage(health, amount) {
  const hp = Number.isFinite(health) ? health : PLAYER_MAX_HEALTH;
  const dmg = Number.isFinite(amount) && amount > 0 ? amount : 0;
  return Math.max(0, Math.min(PLAYER_MAX_HEALTH, hp - dmg));
}
```
同时更新文件头注释：原文「玩家血量只显示、不掉血」已过期，改为「v2.55 起焰魔会掉血；
仍不入存档，重进游戏回满血」。

- [ ] **Step 4: 运行确认通过**

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/player/health.js src/tests/test-health.js
git commit -m "feat(health): applyDamage 纯函数（钳制到 [0, MAX]，负数伤害不治疗）"
```

---

### Task 7: 焰魔地面 AI（BossAgent 子类）

**Files:**
- Create: `src/entities/bosses/ignis-boss-agent.js`
- Test: `src/tests/test-ignis-boss-agent.js`
- Modify: `src/entities/ignis/ignis-system.js`（把 Task 5 的最小update 换成 delegating）

**Interfaces:**
- Consumes: `BossAgent`（`src/entities/bosses/boss-agent.js`）、`IGNIS_AI`、Task 4 的 `aabbCollidesAt`/`steerIntentAabb`
- Produces: `class IgnisBossAgent extends BossAgent`
  - `constructor({ rng })`
  - `update(state, dt, ctx) -> object`（全新 state）
  - `state` 字段：`position, velocity, yaw, health, flashedUntil, mode, attackAnimT, attackCooldown, losTimer, losVisible, attackRequest`
  - `attackRequest`：`null | {at: [number,number,number], yaw: number}`（**瞬态**，消费后下一帧清空）

**三态机**：
```
idle ──(视线通 + 水平距 ≤ sightRange)──▶ chase
chase ──(水平距 ≤ attackRange)──▶ attack（attackAnimT=0）
attack ──(attackAnimT ≥ 攻击动画时长)──▶ chase
attack ──(水平距 > disengageRange)──▶ chase（中断动画）
```

- [ ] **Step 1: 写失败测试**

```js
// src/tests/test-ignis-boss-agent.js
import { test } from './runner.js';
import { assertEqual, assertTrue, assertNull } from './assert.js';
import { IgnisBossAgent } from '../entities/bosses/ignis-boss-agent.js';
import { IGNIS_AI } from '../entities/ignis/ignis-config.js';
import { IGNIS } from '../entities/ignis/ignis-config.js';

/** 空世界（无遮挡） */
const OPEN = { world: { isSolid: () => false }, registry: {} };

function st(over = {}) {
  return {
    position: [0, 10, 0], velocity: [0, 0, 0], yaw: 0,
    health: IGNIS.health, flashedUntil: 0,
    mode: 'idle', attackAnimT: 0, attackCooldown: 0,
    losTimer: 0, losVisible: false, attackRequest: null,
    ...over,
  };
}

test('ignis-agent: 无玩家上下文时待在 idle、不动', () => {
  const a = new IgnisBossAgent({ rng: () => 0.5 });
  const next = a.update(st(), 1 / 60, { world: null });
  assertEqual(next.mode, 'idle');
  assertEqual(next.position[0], 0);
});

test('ignis-agent: 玩家在 sightRange 内且视线通 → chase，并朝玩家走', () => {
  const a = new IgnisBossAgent({ rng: () => 0.5 });
  const next = a.update(st(), 0.1, {
    ...OPEN, player: { position: [0, 10, -10] },   // 玩家在 -Z 方向（yaw=0 的前方）
  });
  assertEqual(next.mode, 'chase');
  assertTrue(next.position[2] < 0, `没有朝 -Z 移动：${next.position[2]}`);
});

test('ignis-agent: 超出 sightRange 保持 idle', () => {
  const a = new IgnisBossAgent({ rng: () => 0.5 });
  const far = IGNIS_AI.sightRange + 10;
  const next = a.update(st(), 0.1, { ...OPEN, player: { position: [0, 10, -far] } });
  assertEqual(next.mode, 'idle');
});

test('ignis-agent: 进入 attackRange 后切 attack 且播放动画', () => {
  const a = new IgnisBossAgent({ rng: () => 0.5 });
  const next = a.update(st(), 0.1, {
    ...OPEN, player: { position: [0, 10, -3] },
  });
  assertEqual(next.mode, 'attack');
  assertTrue(next.attackAnimT > 0);
});

// ⚠️ Review Focus：攻击意图只在命中帧出现一次
test('ignis-agent: attackRequest 只在命中帧出现一次（不是每帧）', () => {
  const a = new IgnisBossAgent({ rng: () => 0.5 });
  const ctx = { ...OPEN, player: { position: [0, 10, -3] } };
  let s = st({ mode: 'attack', attackAnimT: 0 });
  const hits = [];
  for (let i = 0; i < 300; i++) {           // 5 秒
    s = a.update(s, 1 / 60, ctx);
    if (s.attackRequest) hits.push(s.attackAnimT);
  }
  assertEqual(hits.length, 1, `命中帧数 ${hits.length}：${JSON.stringify(hits)}`);
  // 作者在 tick 24 结算 ⇒ 1.20s。用 1/60 的帧粒度，容差给一帧半
  assertTrue(Math.abs(hits[0] - IGNIS_AI.hitFrameSeconds) < 0.03, `命中帧 ${hits[0]}`);
  assertEqual(IGNIS_AI.hitFrameSeconds, 1.20);
});

test('ignis-agent: 视线被挡 → chase 退回 idle', () => {
  const a = new IgnisBossAgent({ rng: () => 0.5 });
  const wall = { isSolid: (x, y, z) => z > -6 && z < -4 };   // 中间一堵墙
  const next = a.update(st({ mode: 'chase', losVisible: true, losTimer: 1 }), 0.1, {
    world: wall, registry: {}, player: { position: [0, 10, -10] },
  });
  assertEqual(next.mode, 'idle');
});

test('ignis-agent: 重力让悬空的实体下落', () => {
  const a = new IgnisBossAgent({ rng: () => 0.5 });
  let s = st({ position: [0, 20, 0] });
  for (let i = 0; i < 60; i++) s = a.update(s, 1 / 60, { world: null });
  assertTrue(s.position[1] < 20, `没有下落：${s.position[1]}`);
});

test('ignis-agent: 不原地改写输入 state（返回全新对象 + 新 position 数组）', () => {
  const a = new IgnisBossAgent({ rng: () => 0.5 });
  const s0 = st();
  const s1 = a.update(s0, 0.1, OPEN);
  assertTrue(s1 !== s0, '返回了同一个对象');
  assertTrue(s1.position !== s0.position, 'position 数组被复用');
  assertEqual(s0.position[0], 0);   // 原 state 未被污染
});
```

- [ ] **Step 2: 运行确认失败**

Expected: FAIL —— module not found

- [ ] **Step 3: 实现**

照 `dragon-boss-agent.js` 的结构（把 orbit 换成地面移动、把 `fireRequest` 换成 `attackRequest`）。

**地面移动**：竖直轴先走（重力 + 落地判 `onGround`），再水平两轴。水平方向从 yaw 前向得
`(−sin yaw, −cos yaw)`，然后用 `steerIntentAabb` 做局部绕行（⚠️ 与丧尸不同的两处：
AABB 用焰魔的 `halfWidth`/`height`；`maxStep` 用 `IGNIS_AI.maxStep`）。

**命中帧**：`attackAnimT` 每帧累加 `dt`；**当且仅当**「上一帧 < `hitFrameSeconds` 且本帧 ≥」
时置 `attackRequest`。消费方（game.js）在 `entities.update` 之后处理；`attackRequest` 是瞬态，
下一帧 Agent 返回时自动清成 `null`。

- [ ] **Step 4: 运行确认通过**

Expected: PASS

- [ ] **Step 5: 接上 system（替换 Task 5 的占位 update）**

`ignis-system.js` 的 `ignisDefinition.update` 改为：
```js
const next = ignisAgent.update(entity.state, dt, context || {});
if (!next) return null;
return createState(next);
```
（`ignisAgent` 是模块级单例，与 `dragonAgent` 同手法。）

Run: 打开 `http://localhost:8081/src/tests/index.html`
Expected: `test-ignis-system.js` 仍全绿（create 校验、summon、damage 不因换 update 而破）

- [ ] **Step 6: Commit**

```bash
git add src/entities/bosses/ignis-boss-agent.js src/entities/ignis/ignis-system.js src/tests/test-ignis-boss-agent.js
git commit -m "feat(ignis): 地面三态机 AI（重力/绕行/命中帧攻击意图）"
```

---

### Task 8: 渲染器

**Files:**
- Create: `src/render/ignis-model.js`
- Create: `src/render/ignis-renderer.js`
- Test: `src/tests/test-ignis-render.js`

**Interfaces:**
- Consumes: 烘焙产物（Task 3）
- Produces:
  - `loadIgnisAsset() -> Promise<object>`
  - `sampleIgnisAnim(anim, timeSeconds) -> Map<number, {rot:number[], pos:number[]}>`
  - `class IgnisRenderer`：`constructor(scene, asset, texture?)` / `loadTexture()` / `sync(entities, nowMs)` / `get instances()` / `dispose()`

- [ ] **Step 1: 写失败测试**

```js
// src/tests/test-ignis-render.js
import { test } from './runner.js';
import { assertEqual, assertTrue } from './assert.js';
import * as THREE from 'three';
import { IgnisRenderer } from '../render/ignis-renderer.js';
import { sampleIgnisAnim } from '../render/ignis-model.js';
import { IGNIS_MODEL_CENTER } from '../entities/ignis/ignis-config.js';

function fakeAsset() {
  return {
    scale: 1,
    bones: [
      { name: 'root', parentIndex: -1, localPosition: [0,0,0], bindQuaternion: [0,0,0,1] },
      { name: 'head', parentIndex: 0, localPosition: [0,1,0], bindQuaternion: [0,0,0,1] },
    ],
    geometry: {
      position: [0,0,0, 1,0,0, 1,1,0, 0,1,0],
      normal: [0,0,1, 0,0,1, 0,0,1, 0,0,1],
      uv: [0,0, 1,0, 1,1, 0,1],
      skinIndex: [0,0,0,0, 1,0,0,0, 1,0,0,0, 1,0,0,0],
      index: [0,1,2, 0,2,3],
    },
    animations: { idle: { fps: 10, frameCount: 2, boneIndices: [1],
      frames: [0,0,0,1, 0,0,0, 0,0,0,1, 0,0,0.5,0] } },
    metrics: { boneCount: 2 },
  };
}

test('ignis-render: 池容量 = IGNIS.maxAlive', () => {
  const scene = new THREE.Scene();
  const r = new IgnisRenderer(scene, fakeAsset());
  assertEqual(r.instances.length, 2);
});

test('ignis-render: 无实体时全部实例隐藏（draw call 归零）', () => {
  const scene = new THREE.Scene();
  const r = new IgnisRenderer(scene, fakeAsset());
  r.sync([], 0);
  for (const inst of r.instances) assertEqual(inst.pivot.visible, false);
});

test('ignis-render: 模型 y 偏移补偿（最低顶点在 -0.3042 格）', () => {
  const scene = new THREE.Scene();
  const r = new IgnisRenderer(scene, fakeAsset());
  // mesh 局部偏移 = -(MODEL_CENTER) + 脚底补偿；只断言方向与量级正确
  const inst = r.instances[0];
  const localY = inst.mesh.position.y;
  assertTrue(localY > -IGNIS_MODEL_CENTER[1], `y=${localY} 没有减掉中心偏移`);
});

test('ignis-render: sampleIgnisAnim 循环取模（含负数时刻）', () => {
  const anim = fakeAsset().animations.idle;
  const a = sampleIgnisAnim(anim, 0.05);
  const b = sampleIgnisAnim(anim, 0.05 + 0.2);   // duration = 2/10 = 0.2
  assertEqual(a.get(1).rot[3], b.get(1).rot[3]);
  const neg = sampleIgnisAnim(anim, -0.15);      // 非负取模
  assertTrue(Number.isFinite(neg.get(1).rot[3]));
});
```

- [ ] **Step 2: 运行确认失败**

Expected: FAIL —— module not found

- [ ] **Step 3: 实现 `ignis-model.js`**

`loadIgnisAsset()` 照 `loadDragonAsset()`（`resourceUrl()` + cache-busting 时间戳）。
`sampleIgnisAnim()` 照 `sampleDragonAnim()` 的**逐字复制**（slerp + 非负取模 + 环回）。
> 不抽公共函数：飞龙那份已在生产运行且被 28 个用例覆盖，动它是无收益的风险。

- [ ] **Step 4: 实现 `ignis-renderer.js`**

照 `dragon-renderer.js`，差异只有四处：
1. 池容量 = `IGNIS.maxAlive`（2，不是 4）
2. `mesh.position` 的 y 额外加 `IGNIS.modelFeetOffsetY`（模型脚底不在 y=0）
3. 动画由 `state.attackAnimT > 0 ? 'attack' : 'idle'` 选择（飞龙是 `sampleDragonPose` 的内部状态机）
   - `attack` 播完（`attackAnimT ≥ duration`）后**停在最后一帧**（不循环）
4. 无 `bankRoll`（地面巨兽不倾斜）

⚠️ **材质必须逐实例独立**（红闪是材质级 `color`），与飞龙同。
⚠️ **`alphaTest: 0.5` + `DoubleSide`**：素材有 8 个零尺寸薄片被跳过，但盾面是 2px 实心、头盔侧片是 0 厚 —— 都需要双面。

- [ ] **Step 5: 运行确认通过**

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/render/ignis-model.js src/render/ignis-renderer.js src/tests/test-ignis-render.js
git commit -m "feat(ignis): SkinnedMesh 渲染器（池 2、脚底补偿、idle/attack 动画切换）"
```

---

### Task 9: 装配（registry / game / check-data）

**Files:**
- Modify: `src/entities/bosses/boss-registry.js`
- Modify: `src/entities/entity-types.js`
- Modify: `src/core/game.js`
- Modify: `tools/check-data.mjs`
- Test: `src/tests/test-boss-map.js`（已存在，追加用例）

**Interfaces:**
- Consumes: 全部前置任务的产物
- Produces: `IGNIS_TYPE` 可被 `damageEntity` 路由；`bossSlotsFor('TARN')` 返回 2 个槽位

- [ ] **Step 1: 追加失败测试**

```js
// 追加到 src/tests/test-boss-map.js
test('boss-slots: 高台地带有两个 Boss，slot 0 = 飞龙、slot 1 = 焰魔', () => {
  const slots = bossSlotsFor('TARN');
  assertEqual(slots.length, 2);
  assertEqual(slots[0].slot, 0);
  assertEqual(slots[0].type, 'dragon');
  assertEqual(slots[1].slot, 1);
  assertEqual(slots[1].type, 'ignis');
  assertEqual(slots[1].service, 'ignises');
});

test('boss-slots: 名册长度仍不超过 BOSS_SLOTS_PER_MAP', () => {
  for (const kind of BOSS_MAP_KINDS) {
    assertTrue(bossSlotsFor(kind).length <= BOSS_SLOTS_PER_MAP);
  }
});
```

- [ ] **Step 2: 运行确认失败**

Expected: FAIL —— `slots.length` 是 1

- [ ] **Step 3: 改 registry**

在 `BOSS_ROSTER.TARN` 数组里追加一项，并把文件头那句「Boss2 尚未设计（用户：「目前还没有 Boss2」）」
改成指向本 spec。

- [ ] **Step 4: 改 entity-types**

`WEAPON_HITTABLE_TYPES` 加 `'ignis'`。
⚠️ 这条会让**炮塔自动开始索敌焰魔**（`turret-system.js` 消费同一份表）—— 是想要的
（玩家可建炮塔助战），但要在 `game.js` 构造 `targets` 的地方补上 `ignises.activeEntities()`。

- [ ] **Step 5: 改 game.js（五处）**

1. **import**（与 dragon 那组并列）
2. **service 装配**（在 `this.dragons` 之后、`_waitForColumn` 之前）：
   ```js
   this.entities.registerType(IGNIS_TYPE, ignisDefinition);
   this.ignises = new IgnisService({ entities: this.entities, world: this.world, seed: this.seed });
   try {
     const ignisAsset = await loadIgnisAsset();
     this.ignisRenderer = new IgnisRenderer(this.scene, ignisAsset);
     await this.ignisRenderer.loadTexture();
   } catch (err) {
     console.warn('[ignis] 渲染器加载失败，焰魔不显示（不影响游戏）:', err);
     this.ignisRenderer = null;
   }
   ```
3. **帧循环 sync**（在 `dragonRenderer.sync` 旁边）：
   ```js
   if (this.ignisRenderer) this.ignisRenderer.sync(this.ignises.activeEntities(), nowMs);
   ```
4. **`damageEntity` 路由**：加 `else if (entity.type === IGNIS_TYPE) { ... this.ignises.damage(id, amount, nowMs); }`
   以及 `_emitDamageNumber` 的锚点：焰魔 `position` 是**脚底**，头顶 = `y + IGNIS.height`。
5. **攻击结算**（在 `entities.update` 之后、与飞龙的 `fireRequest` 消费并列）：
   ```js
   for (const e of this.ignises.activeEntities()) {
     const req = e.state.attackRequest;
     if (!req) continue;
     const p = this.player.physics.pos;
     const dx = p.x - req.at[0], dz = p.z - req.at[2];
     if (Math.hypot(dx, dz) > IGNIS_AI.hitRange) continue;
     if (Math.abs(shortestAngleDiff(req.yaw, Math.atan2(-dx, -dz))) > IGNIS_AI.hitConeDeg * Math.PI / 180) continue;
     if (!hasLineOfSight({ world: this.world, registry: this.registry,
       from: req.at, to: [p.x, p.y + 1.0, p.z] })) continue;
     this.player.health = applyDamage(this.player.health, IGNIS.attackDamage);
   }
   ```
   ⚠️ **`hitRange` 6.5 与 `hitConeDeg` 35（半角）都来自作者** `AreaAttack(6.5f, 6, 70, ...)`
   的 `range` 与 `arc/2`。改成 6.5/70 会让扇面变成 140°（玩家绕到侧面也躲不掉）。
   ⚠️ `shortestAngleDiff` / `hasLineOfSight` 从 `turrets/turret-system.js` import（唯一权威，
   与 `BossAgent._angleDiff` / `_hasLos` 同源 —— **不要在这里再写一份公式**）。

- [ ] **Step 6: 改 check-data**

新增 `[焰魔]` 环节，照 `[龙]` 那段的六条：
① 三个产物存在；② PNG = `IGNIS_BAKE_PARAMS.textureSize²`；③ `bones.length === IGNIS_METRICS.boneCount`；
④ 顶点/索引数；⑤ `animations` 清单必须是 `idle,attack` 且帧数/fps 匹配；
⑥ 指纹比对（不一致 → 报「跑 npm run ignis」）。

- [ ] **Step 7: 跑门禁**

```bash
npm run check
```
Expected: 三道门全过（arch + data + lint）

- [ ] **Step 8: Commit**

```bash
git add src/entities/bosses/boss-registry.js src/entities/entity-types.js src/core/game.js tools/check-data.mjs src/tests/test-boss-map.js
git commit -m "feat(ignis): 接入高台地带 Boss slot 1（召唤/伤害路由/攻击结算/数据门）"
```

---

### Task 10: Tier 4 像素实测 + 全量回归

**Files:**
- Create: `tests/ignis.spec.mjs`
- Modify: `docs/roadmap.md`（版本行）

**Interfaces:**
- Consumes: 全部前置任务

- [ ] **Step 1: 写 spec**

照 `tests/dragon.spec.mjs` 的 harness 手法（`channel: 'chromium'`、`__MC_GAME__` 编程驱动）。

三条断言：
1. **召唤落点在地面**：传送玩家到高台地带中心 → `__MC_GAME__.summonBoss()` 两次 →
   第二次得到焰魔 → 读 `state.position[1]`，断言它等于地表高度（±1 格内，不是悬空/地下）
2. **挥剑姿态与待机不同**：等到 `attackAnimT ≥ hitFrameSeconds` 时截图，
   与 `attackAnimT === 0` 的截图比像素差 > 噪声底（**先测同状态重复截图的噪声底再定阈值**）
3. **玩家掉血**：把玩家放到焰魔面前，等一次命中 → 读 `player.health` < 20

⚠️ 判据必须**同时钉上下界**（只钉「掉血」抓不到「一下掉到 0」）。

- [ ] **Step 2: 跑 spec**

```bash
npx playwright test tests/ignis.spec.mjs
```
Expected: 3 passed。先打印实际读数再确认阈值。

- [ ] **Step 3: 全量回归**

```bash
npm test
```
Expected: 全绿（既有 dragon / zombie / minecart / turret spec 不受影响）

- [ ] **Step 4: 更新 roadmap**

在版本表加 v2.55 行：用户需求原文 + 六项裁定 + 新增文件清单 + 实测度量（3.73×4.07×5.16 格）。

- [ ] **Step 5: Commit**

```bash
git add tests/ignis.spec.mjs docs/roadmap.md
git commit -m "test(ignis): Tier 4 像素实测 + 更新 roadmap"
```

---

## Self-Review 记录

**Spec 覆盖**：§1 六项裁定 → Task 3（动画范围）、5（地面/缩放）、6（掉血到 0）、7（近战）、8（静态贴图）；
§2.0 素材对照 → 已体现在「不采纳 Java 版」；§3 架构 → File Structure 表逐项落任务；
§4.3 烘焙要点 → Task 3 Step 4 的七个编号点；§4.4/4.5 → Task 7/9；§5 数值 → Task 5；
§6 测试分级 → 每任务的 RED/GREEN + Task 10 的 Tier 4。

**已知留给实施者的判断**（不是空缺，是刻意的）：
- `IGNIS_AI` 的具体数值（`sightRange` / `chaseSpeed` 等）在 spec §5 有初值，实施时若实测
  手感不对可调，但**必须改 config 不改正则**。
- `assets/ignis/` 的产物是否入库由用户决定（与本仓其它烘焙产物同处理）。
