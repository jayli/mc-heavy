# 修复丧尸互相重叠 —— 补齐 mc-lite 的实体间排斥（M6 移植遗漏）

## 问题确认

用户报告：多只丧尸挤成一坨，重叠到一起看起来像一只。

**根因（读码确认，无需实测复现）**：mc-heavy 侧**完全没有实体间互斥逻辑**。

| 文件 | 现状 |
|---|---|
| `zombie-system.js:129-143` `collides()` | 只查方块 `world.isSolid()`，**不查其它丧尸** |
| `world-worker.js:186-208` `ai()` | 每只丧尸独立算「朝玩家单位向量 × speed」，**批次里有全部位置但从不两两比较** |
| `zombie-system.js:254-285` `spawn()` | 四道门只查方块（上限/column/脚格/头格/脚下 solid），**无「落点已有丧尸」门控** |

后果：所有丧尸朝同一玩家走 → 收敛到同一点且无排斥 → 叠成一坨。

## mc-lite 的实现（实测读源，参数逐项对应）

| 项 | mc-lite | 出处 |
|---|---|---|
| 算法 | **软排斥 / 位置推挤**（不是硬碰撞求解，也不改 velocity） | `ZombieManager.js:454-511` `separateOverlappingZombies` |
| 检测半径 | `SEPARATION_RADIUS: 0.6` | `ZombieManager.js:35` |
| 推力 | `PUSH_STRENGTH: 0.5` | `ZombieManager.js:39` |
| 单次推挤上限 | `MAX_PUSH_DISTANCE: 0.3`（钳制） | `ZombieManager.js:42` |
| 两两对称 | 同一对循环里 i 加偏移、j 减偏移（牛顿第三定律式） | `ZombieManager.js:497-504` |
| 完全重叠 tie-break | `Math.random() > 0.5 ? pushDir = -pushDir : randomAngle`（随机方向推开） | `ZombieManager.js:476-494` |
| 无空间索引 | 嵌套 `for i<j` O(n²)，上限 `MAX_ZOMBIES=100` → 最坏 4950 对 | `ZombieManager.js:31` / `:469-474` |
| 执行层 | **manager 层改 position**（不是 AI 层、不是物理层） | `ZombieManager.js:454` |
| 频率 | **20Hz**（`ZOMBIE_DECISION_INTERVAL=3`，60fps 下每 3 帧） | `ZombieManager.js:237-239` |
| 帧序 | AI 决策 → 物理 → **分离（最后）** | `ZombieManager.js:222-251` |
| 方块碰撞 | **不检查** —— 推挤直接改 position，可能推进方块 | `:454-511` 无 `isSolid` |
| 生成时门控 | **无**「落点已有丧尸」检查（只查方块 + 区域上限） | `:537-604` |

**死字段警示**：`Zombie.js:59-65` 的 `PHYSICS_CONFIG.collisionBox`（0.6×1.8×0.6）全仓**零消费点** ——
真正的碰撞盒硬编码在 `Physics.js:500` 的 `MOB_HALF_WIDTH = 0.3`。`SEPARATION_RADIUS: 0.6`
与 AABB 宽度同值是**巧合**，mc-lite 里是两个独立常量（语义不同：玩法参数 vs 几何参数）。

## 方案（用户已选定：mc-lite 原样推挤位置）

### 1. 参数落进 `zombie-config.js`（红线 1 单一权威）

```js
/** 实体间排斥参数（mc-lite `ZombieManager.js:35/39/42` 逐项对应） */
export const ZOMBIE_SEPARATION = Object.freeze({
  radius: 0.6,        // 检测半径（与 AABB 宽度碰巧同值但语义独立 —— mc-lite 也是两个常量）
  pushStrength: 0.5,  // 推力系数（各推开 dx×0.5）
  maxPush: 0.3,       // 单次推挤上限（钳制，防重叠深时一次弹飞）
});
```

不派生 `radius: ZOMBIE.width`：两者语义独立（玩法参数 vs 几何参数），派生会让「改 AABB 宽度」
连带改排斥半径 —— 那不是同一个事实。

### 2. `ZombieService.separateOverlapping()`（新增独立方法）

逐行复刻 mc-lite 算法：

```js
separateOverlapping() {
  // 枚举全部丧尸（O(n²)，n ≤ maxActive=20 → 最多 190 对；20Hz → 3800 次/秒，开销可忽略）
  for (let i = 0; i < list.length; i++) for (let j = i+1; j < list.length; j++) {
    dx = xj - xi; dz = zj - zi;
    distSq = dx² + dz²;
    if (distSq >= radius² || distSq <= 0) continue;
    dist = sqrt(distSq);
    pushX = (dx/dist) × pushStrength × dx;   // mc-lite 同式（非归一化，距离越近推越大）
    pushZ = (dz/dist) × pushStrength × dz;
    if (|pushX| > maxPush) pushX = sign × maxPush;  // 同上钳制 Z
    // 两两对称：i 推开、j 反向推开
    // **重建 state**（createState → 新对象 + 新数组）
  }
}
```

**完全重叠的 tie-break**（`distSq <= 0`）：mc-lite 用 `Math.random()`。本仓库沿用 ——
红线 2 是「seed 确定性**世界生成**」，丧尸是临时实体不入存档，M6 验收报告已有先例
（X 键落点用 `Math.random()`，理由同上）。测试断言「两只都动了且方向相反」而非具体方向。

**有意增强（须标注）**：推挤后调 `collides(state, world)`，碰撞则回退该次推挤。
mc-lite **不检查方块碰撞** → 可能把丧尸推进实心方块卡住。mc-heavy 有 `world.isSolid`，
成本极低，故补上。这是修 mc-lite 也有的潜在 bug，标注为有意偏离。

### 3. 接线：`game.js` 帧序

放在 `entities.update` **之前**（不是 mc-lite 的「物理之后」），理由是本仓库的活跃约束：

> `EntityManager.update()` 的跨 column 索引迁移判据是「赋值前 position vs 赋值后 position」

若在 `entities.update` **之后**改 position，就绕过了这个判据 → **索引不迁移** → column
卸载漏回收实体。放在之前则推挤后的位置会被 `entities.update` 正常处理。

```js
this.zombies.update(dt, { playerPosition: [...] });
this.zombies.separateOverlapping();      // ← 新增（20Hz 内部节流）
this.entities.update(dt, { world: this.world });
```

频率对齐 mc-lite 的 20Hz：方法内部用独立 accumulator（**不复用 `_aiAccum`** ——
那个受 `if (!this.pool) return` 与 `_aiInFlight` 早返回影响，会让互斥在 RPC 在途期间停摆）。
独立 accumulator 让纯 fixture（无 pool）也能测到互斥。

### 4. 不做的事

- **不加 spawn 避免重叠门控**：mc-lite 也没有；有了运行时推挤，生成时重叠会立刻被推开
- **不加空间索引**：n ≤ 20，190 对 @ 20Hz 开销可忽略（mc-lite n=100 也是 O(n²)）
- **不改 worker AI**：互斥在 manager 层（mc-lite 同口径），AI 层保持「只管追逐」

## 测试

### 单测（`src/tests/test-zombies.js`，Tier 1 TDD）

| 用例 | 注入什么会失败 |
|---|---|
| ① 两只水平重叠 → 推开且方向相反 | 去掉互斥 / pushStrength 改 0 |
| ② 距离恰在半径边界（0.6）→ **不**推开 | `>=` 改成 `>`（边界含/不含反了） |
| ③ 深度重叠 → 推挤量钳到 0.3 | 去掉 maxPush 钳制 |
| ④ 完全重叠（同坐标）→ 两只都动、方向相反 | 去掉 `distSq <= 0` 分支（会 NaN 或跳过） |
| ⑤ 不重叠 → 位置不变 | 无条件推开 |
| ⑥ 推挤后 state 是**新对象 + 新数组** | 原地改写（索引迁移失效） |
| ⑦ 推挤进实心方块 → 回退（有意增强） | 去掉 collides 检查 |
| ⑧ 参数对齐 mc-lite（0.6/0.5/0.3） | 数值漂移 |

### E2E（`tests/zombies.spec.mjs` 新增一条）

20 只丧尸追同一玩家 → 稳态后断言**任意两只的水平距离 ≥ 阈值**。
判据须用「最小两两距离」而非「位置去重数」（去重数对重叠不敏感）。
阈值取 mc-lite 的语义：稳态最小距离应 > 0（不重叠），实际会收敛到 radius 附近。

### 门禁

- `npm run check`（arch + data + lint）
- `npm test` 全量 E2E（`m1-acceptance` 的既有 flaky 按规范做交替对照）
- **不需跑 bench**：未碰 mesher/materials/render/scheduler/physics 热路径
  （互斥在 ZombieService，20Hz、190 对）

## 文档同步

| 文档 | 改动 |
|---|---|
| `docs/roadmap.md` | 「M6 之后的遗留 TODO」表加一条：丧尸互斥补齐（✅） |
| `docs/m6-zombies-acceptance-report.md` | §6 偏离表加「方块碰撞检查」那条有意增强；正文补互斥接线 |
| `CLAUDE.md` 活跃约束 | 加一条：实体间互斥在 manager 层推挤位置、须在 `entities.update` **之前**调用（索引迁移约束），后续实体类 Epic（M7 巢穴刷怪、炮塔）同理 |
| `docs/phase-1-engine-design.md` | **不 bump 版本**（玩法机制补齐，非架构口径变更） |

## 风险

1. **推挤与物理的交互**：推挤改 position → 下一步物理以新位置为起点。若推挤把丧尸推到
   悬空处，重力会把它拉回地面（正常）。若推进方块，`collides` 回退兜住（有意增强）。
2. **20Hz vs 60Hz**：互斥 20Hz、物理 60Hz → 两次互斥之间丧尸可能又靠得更近。mc-lite 同口径
   （也是 20Hz），实测其效果足够（用户报告的是「完全叠成一坨」，不是「靠得略近」）。
3. **O(n²) 在未来 30/50 档**：M6 规格 §3 已要求「未来 30/50 配置档须重新验收容量与性能」。
   50 只 → 1225 对 @ 20Hz = 24500 次/秒，仍可忽略，但须按规格重新验收。
