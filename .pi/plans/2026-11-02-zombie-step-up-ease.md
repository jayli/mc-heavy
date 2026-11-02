# 丧尸上台阶缓动（v2.39）

## 问题（已实测，非推断）

用户 2026-11-02 报告：丧尸上台阶是瞬移，下台阶有下落动画。

诊断探针（fixture：平地 `y=0` 全 stone + `x ≥ 12` 抬一层，丧尸 `[10.5, 1, 0.5]` 朝 +X 走，逐帧追踪）：

| 场景 | y 轨迹 | 结论 |
|---|---|---|
| 上台阶 | 一帧内 `1 → 2`（`dy = +1.0000`），整个 300 步窗口里**只有 1 帧** y 变化 | 瞬移 |
| 下台阶（走下 1 格高台） | 19 帧连续下落：`−0.0067, −0.0133, … −0.1067, −0.0003`，共 283ms | 有动画 |

根因：`tryStepUp`（`src/entities/zombies/zombie-system.js`）在水平碰撞时把脚底**一次性**抬到上一格整数面
（物理必须瞬时 —— AABB 状态要精确），而 `zombie-renderer.js` 直接把 `state.position` 原样发布成实例平移，
于是这一格跳跃原样出现在画面上。下台阶没有这个问题，因为重力天然是一帧一帧下落的。

## 口径（用户裁定 2026-11-02）

> 「就用最简单的方法，整体把丧尸上移一格高度，只要不是瞬移就行，丧尸的动作不要有任何的变化，
> 唯一就是加上了一个缓动上台阶的过渡，而不是瞬移。所以这个实现很简单，下台阶是怎么做的，就参照下台阶即可。」

即：**视觉层整体 y 缓动**，物理照旧瞬时。这正是本仓库已有的 `player/step-lift.js` 手法
（玩家的上台阶相机缓动：物理瞬时、相机 ease-out 追平），方向相反 —— 玩家是「相机压在物理下方追上」，
丧尸是「整体模型从旧高度追上」。

**不动**：物理碰撞、`state.position`、实体射线 `raycastAabb`、spawn/存档、步态与摆动
（`walkTime / swing / armSwing / headSway` 一行不改）、模型尺寸与 UV。

## 改动

### 1. `src/render/zombie-renderer.js`（核心）

- `import { StepLift } from '../player/step-lift.js'` —— **复用，不复制公式**（纯视觉、无 three 无 DOM；
  再写一份 `exp(-12·dt)` 就是同一事实的第二个副本，红线 1）。
- `_poses[slot]` 增两字段：`lift`（StepLift 实例）、`prevY`（上一帧物理 y，`null` = 未对齐）。
- `sync()` 每只丧尸：
  - `dy = state.position[1] - pose.prevY`；
  - `pose.prevY === null`（首帧 / 刚 acquireSlot）→ **不触发**，直接对齐
    （`acquireSlot` 的 position 初值是 `[0,0,0]`，不挡就会「从 y=0 升上来」，这个坑必然踩）；
  - `dy > ZOMBIE_STEP_LIFT.epsilon` → `pose.lift.trigger(dy)`；
  - `dy < 0`（下落）→ `pose.lift.offset = 0`，立即跟随物理（保持「下台阶由物理驱动」的既有观感；
    残留缓动会让丧尸陷到台阶下方）；
  - `pose.lift.update(dt)`（复用 sync 已算好的 `dt`）。
- `_writeSlot()`：`_parent.position.set(px, py + pose.lift.offset, pz)`。
  `pose.position` 仍是物理位置副本 → `poseOf()` 语义不变。
- 新增只读测试接口：`liftOffsetOf(slot)`、`renderYOf(slot)`。
  `releaseSlot` / `dispose` 走既有 `_poses[slot] = null` 自然清理。

### 2. `src/entities/zombies/zombie-config.js`

新增 `ZOMBIE_STEP_LIFT = { epsilon: 1e-4 }` —— **只放上升判定的噪声门**这一个常量
（实测台阶抬升在 0.01~1.0 格，1e-4 远离两侧）。衰减率 / 归零阈值 / 滞后上限**全部复用 `StepLift`
的既有常量**（`DECAY_RATE 12` → 190ms 到 10%、`CUTOFF 0.004`、`MAX_LAG 1.0` 防连续爬台阶时插进方块），
不新增第二套数值。

### 3. 测试（Tier 1：先 RED，验证 RED，再 GREEN）

`src/tests/test-zombies.js` 新增 5 条：

1. **真实物理路径**：`makeAiFixture` + `x ≥ 12` 台阶 + 逐帧 `entities.update(1/120)` + `renderer.sync(nowMs)`，
   断言 step-up 那一帧 `renderYOf !== 物理 y`（滞后）、~200ms（≥20 帧）内收敛到物理 y（< 1e-3）、
   全程单调上升（不抖）。
2. 下台阶（`applyAsyncPose` 把 y 降 1）→ `liftOffsetOf === 0`，渲染 y 立即等于物理 y。
3. 首帧 / spawn 后第一次 sync → `liftOffset === 0`（不从地底升起）。
4. 两只丧尸各自独立（一只爬台阶、一只不动 → 后者 offset 恒 0）。
5. slot 归还后重分配不残留（`releaseSlot` → `acquireSlot` → offset 0）。

### 4. 文档

- `docs/roadmap.md` 加 v2.39 行：根因 + 上面那张实测轨迹表 + 门禁。
- `AGENTS.md`「M6 丧尸沉淀的活跃约束」补一条：**上台阶缓动只在渲染层，物理必须保持瞬时**
  （物理渐变会让 AABB 与台阶重叠 → 碰撞/射线口径全变，且该窗口内 `collides` 恒真会卡住），
  附「首帧必须对齐」「下落必须清零缓动」两条载荷性口径。

## 验证

1. `npm run check`（arch + data + lint）→ 0 error。
2. `npx playwright test tests/harness.spec.mjs` → 整页浏览器单测 0 失败。
   ⚠️ 该页实测已 70~72s、窗口 90s：新用例是纯矩阵读（< 50ms），报告实际耗时确认没贴线。
3. `npx playwright test tests/zombies.spec.mjs` → 真游戏页不回归。
4. 诊断探针（`/tmp`，不提交）输出逐帧渲染 y 轨迹：上台阶 190ms 平滑追上，与下台阶 283ms 的自然下落
   同量级 —— 「不是瞬移」的直接证据。
5. 负向验证：去掉 `_writeSlot` 里的 `+ pose.lift.offset`（等价回退），确认新增用例真 FAIL。

## 已知边界

- 缓动期间模型从旧高度追上，脚在台阶内侧会短暂（~0.1 秒）穿过方块。这是「整体平移、动作零变化」
  这一口径的必然代价，用户已知悉并选定。
- 传送/瞬移（`applyAsyncPose` 大幅改 y）不触发缓动：只有 `dy > epsilon` 才触发，且 `sync` 单帧
  `dt` 有限（一帧最多衰减少量）—— 若将来出现「丧尸被瞬移 1 格以上」的玩法，需在那条路径上显式
  `pose.lift.offset = 0` 与 `pose.prevY = 新 y`。当前无此类路径（`applyAsyncPose` 只在测试与
  worker pose 回包用，而 AI RPC 只回 vx/vz/mode）。
