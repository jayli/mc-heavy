# 丧尸局部避障（贴身绕行）设计

**状态：** 待实施（2026-11-02 用户裁定：只需「贴身绕行即可」，卡死时「留在原地不追」）
**定位：** M6 丧尸 AI 的增量增强，不属于新 Epic。**不**引入寻路网格 / A* / 新 Worker。
**关联：** `docs/superpowers/specs/2026-08-23-m6-zombies-design.md`（M6 冻结数据与架构口径）、
`docs/m6-zombies-acceptance-report.md`（AI/物理分层与踩坑）、`docs/testing-policy.md`（分级）。

## 1. 问题、目标与非目标

### 1.1 用户报告（2026-11-02）

> 「丧尸现在只是无脑的走向玩家，有点无脑，中间也不会绕过障碍物，能不能让丧尸的行走更智能一些，
> 可以绕过简单的障碍物」

两轮澄清后的裁定：

- **智能程度 = 贴身绕行即可**（不做绕整面墙跑十几格、不做迷宫寻路）。
- **完全过不去时 = 留在原地不追**（不做「沿墙一直找」「卡 N 秒换方向」）。

### 1.2 现状为什么「无脑」

| 层 | 现状 | 后果 |
|---|---|---|
| AI（worker，`computeAiUpdates`） | 只输出「朝玩家的归一化方向 × `ZOMBIE.speed`」+ 实体排斥力 | 意图方向与地形无关 |
| 物理（主线程，`zombieDefinition.update`） | 分轴推进 + 一格 step-up + 二分回退 | 只有「对角滑动」（x 被挡时 z 照走），**意图方向永不改变** |
| worker 视野 | **没有世界数据**（M6 规格 §2：RPC 只传 plain state，不传体素视域） | 避障**只能**在主线程做 —— 世界数据的唯一权威在主线程（红线 1） |

即：缺的是**转向**，不是滑动。

### 1.3 目标

1. 丧尸朝玩家走，**正前方 1.2 格内不可通行**时，按最小偏角转向绕行；缝隙一开立刻转回玩家方向。
2. 一格的台阶 / 高低差**不算障碍**（既有 step-up 手感零回归）。
3. 所有方向都不可通行时**原地站住**（零速度 + `mode='blocked'`），等下一 AI 周期重探。
4. 不改变 worker / RPC 形状 / 渲染层 / 存档 / 物理碰撞语义。
5. 常态成本可忽略；最坏（全被堵）也不构成帧预算压力。

### 1.4 非目标（明确不做）

- **不做寻路网格 / A\* / BFS**（M6 规格 §1 的非目标「寻路网格」仍然有效；本设计只做**局部**转向）。
- **不做随机游荡 / 随机转头**（红线 2 的确定性口径；「卡住时乱转」需要给 intent 加 `yaw` 字段并改
  `setIntent` 的「静止保持朝向」契约，属另一个增量）。
- **不做朝向平滑**（首版）：转向后 `yaw` 由速度派生，可能出现一帧 90° 的转头跳变。见 §7 风险。
- **不管下落**：探针只判「目标点能否站」，不检查脚下支撑 —— 从平台边缘走向玩家仍会走下去
  （与改动前同行为）。检查支撑会造出「丧尸不敢走下坡」的新问题。
- **不顺带修**：不改 `computeAiUpdates` 的感知门 / 预算门 / 排斥力；不改 M6 速度与 AABB。
- 不做「丧尸跳跃」「爬梯」「破坏方块」。

## 2. 架构与接口

### 2.1 新增一个同构模块（唯一新增文件）

`src/entities/zombies/zombie-navigation.js`（无 DOM、无 three、不新建 Worker；`src/entities/**`
受 `check:arch` 的同构检查约束）。

导出三样，**每样都是单一权威**：

```js
// ① 丧尸 AABB 与实心方块的碰撞判据（物理层与探针共用，红线 1）
zombieCollidesAt(world, x, y, z) -> boolean

// ② 一格 step-up 的落点（物理 tryStepUp 与探针前瞻共用，红线 1）
zombieStepUpY(y) -> number            // = Math.floor(y + 0.01) + 1

// ③ 转向探针（纯函数、无状态、无随机）
steerIntent({ world, position, vx, vz }) -> { vx, vz, blocked }
```

### 2.2 `zombie-system.js` 的三处改动（都只是转调）

| 位置 | 现状 | 改成 |
|---|---|---|
| `collides(state, world)`（`:236`） | 内联 AABB 三循环 | `zombieCollidesAt(world, ...state.position)` |
| `tryStepUp()`（`:206`） | 内联 `Math.floor(y + 0.01) + 1` | `zombieStepUpY(state.position[1])` |
| `ZombieService._applyIntent()`（`:546`） | 钳速 → `setIntent` | 钳速 → **`steerIntent`** → `setIntent` |

⚠️ `collides()` 里的 `PHYS_EPSILON = 0.001` 是**载荷性的**：`y1 = floor(y + height − 0.001)`。
搬进 `zombieCollidesAt` 必须原样带上 —— 少了这个 ε 会让「站在 2 格高隧道里」多采一格头顶，
探针把**能走的隧道判成堵死**（丧尸在走廊里僵住，而方块层面完全看不出）。

### 2.3 常量进 `zombie-config.js`（唯一权威）

```js
export const ZOMBIE_MAX_STEP = 1.0;            // 从 zombie-system.js 的局部 MAX_STEP 上移
export const ZOMBIE_STEERING = Object.freeze({
  probeDistance: 1.2,
  anglesDeg: [22.5, 45, 67.5, 90],
});
```

- `probeDistance = 1.2`：约等于「半宽 0.3 + 0.9」，即提前约 1 秒行程发现障碍 —— 观感是「提前拐」
  而不是「贴到墙上才蹭」。**这是实玩标定值不是推导值**：嫌拐早/拐晚只改它。
- `anglesDeg` 是**升序**的偏角阶梯，保证「取能走的最小偏角」（偏角越小越接近玩家方向）。

### 2.4 数据流（改动后）

```
worker: computeAiUpdates  →  { id, generation, vx, vz, mode }        ← 形状不变
   ↓ RPC（20Hz）
ZombieService._applyIntent:
   ① 速度长度钳到 ZOMBIE.speed（既有）
   ② steerIntent({ world, position, vx, vz })   ← 新增，只换方向、不改长度
   ③ setIntent(id, { vx, vz, mode })            ← mode 白名单 + 'blocked'
   ↓
zombieDefinition.update（60Hz 物理，不变）
```

**RPC 形状与体积零变化**（`tests/zombies.spec.mjs` 已有断言钉住键集
`['generation','id','mode','vx','vz']`）。**渲染层零改动**（renderer 不消费 `mode`）。

⚠️ **探针只能接在 `_applyIntent`，不得接在 `setIntent`**：`setIntent` 是**通用意图写入口**，
物理用例、调试代码、将来的玩法模块都用它直接下令（若探针长在里面，`test-zombies.js` 那些
「设了 vx 就往 +X 走」的物理用例会被地形挡住而假红，且「想让它走就必须能走」的语义被偷换）。
`_applyIntent` 是 **AI 回包的唯一消费点**（`:552`，先验 generation）——**避障是 AI 的能力，
不是指令通道的行为**。

### 2.5 `mode` 白名单扩展

`createState`（`:138`）与 `setIntent`（`:466`）现在都写死 `mode === 'chasing' ? 'chasing' : 'idle'`
—— 直接传 `'blocked'` 会被**静默规范化成 `'idle'`**（方块、位置、速度全对，只有状态看不出来）。
两处改成三值白名单 `{'idle','chasing','blocked'}`。

## 3. 转向算法（`steerIntent`）

```
输入：world（只读）、position（脚底中心）、vx/vz（已钳制的意图速度）
输出：{ vx, vz, blocked }

1. len = hypot(vx, vz)；len ≤ ZOMBIE_MOVING_EPSILON → 原样返回 { vx, vz, blocked:false }
   （零意图不探针：静止丧尸不该凭空转向，也不该被判 blocked）
2. 归一化：u = (vx/len, vz/len)。候选方向 = 把 u 旋转 θ ∈ 0°, [+22.5°, −22.5°,
   +45°, −45°, +67.5°, −67.5°, +90°, −90°]（升序、每档先 + 后 −，共 9 个探针）。
   旋转公式固定为（x east / z south，与 yaw = atan2(vx, vz) 同序）：
       rotate(u, θ) = (u.x·cosθ − u.z·sinθ,  u.x·sinθ + u.z·cosθ)
3. 对每个方向 d：
     tx = x + d.x × probeDistance;  tz = z + d.z × probeDistance
     if (!zombieCollidesAt(world, tx, y, tz))            → 可通行，选它
     else if (zombieStepUpY(y) − y ≤ ZOMBIE_MAX_STEP
              && !zombieCollidesAt(world, tx, zombieStepUpY(y), tz))
                                                        → 可通行（一格台阶，物理会抬上来）
4. 第一个可通行的方向：
   - 若它就是 **0°（原方向）** → **原样返回输入 `{ vx, vz, blocked:false }`**（不重建速度向量）
     —— 因为 `vx/len×len` 不保证逐位回到 `vx`，而「无障碍时逐位零回归」是硬判据（用例 a）；
   - 否则 → `{ vx: d.x × len, vz: d.z × len, blocked:false }`
   全部不可通行 → `{ vx: 0, vz: 0, blocked:true }`
```

`steerIntent` 从 `zombie-config.js` import `ZOMBIE_MOVING_EPSILON` 做零速判定、`ZOMBIE_STEERING`
取探针参数与候选角度、`ZOMBIE_MAX_STEP` 取台阶上限 —— **不新增任何字面量**（红线 1）；
AABB 尺寸从 `ZOMBIE.width` / `ZOMBIE.height` 派生（`zombie-system.js` 的 `ZOMBIE_AABB` 是
**相对偏移**形状、供射线用，不是格采样清单，故不复用）。

三条载荷性约定：

- **速度长度不变**：只换方向。速度上限的权威仍是 `_applyIntent` 的钳制与 `ZOMBIE.speed`（红线 1：
  转向层不得复制一份速度权威）。
- **确定性**：同样的 `(world, position, vx, vz)` 必然给出同样的输出；无 `Math.random`、无
  「记住上次绕哪边」。副作用是「两侧都通时永远先试 +22.5」（稳定不抖，可测试）。
- **台阶前瞻与物理同源**：`zombieStepUpY` 是唯一实现，物理的 `tryStepUp` 与探针都用它 ——
  漂移的形态是「探针以为能上台阶、物理抬不上去」→ 丧尸贴着台阶反复试探（静默、只能靠实玩发现）。
  ⚠️ 探针**不复制** `tryStepUp` 的「跳跃上升段拒绝」门控：探针回答的是**几何可达性**，物理回答的是
  **此刻能否抬**。丧尸不会跳，几乎不处于上升段。
  ⚠️ `zombieStepUpY(y) − y ≤ ZOMBIE_MAX_STEP` 在现有定义下**恒成立**（`floor(y+0.01)+1` 最多抬 1 格），
  保留它是为了与物理 `tryStepUp` 同构（若将来改台阶高度口径，两边一起失效才不致撕裂）。

## 4. 与既有行为的交互

| 场景 | 行为 | 说明 |
|---|---|---|
| 平地无遮挡 | 输出**逐位等于**输入 | 零回归的核心判据（Tier 1 用例 a） |
| 一格台阶（1/2 半砖、`planks_step`…） | **不偏转**，照旧 step-up | 台阶在 `y` 层是实心，只能靠前瞻判据放行 |
| 2 格高墙 | 偏转绕行 | 前瞻的 `y+1` 仍碰撞 → 不算台阶 |
| 3 格高墙 | 偏转绕行 | 同上 |
| 墙角/门柱 | 偏到能过的角度；1 格宽门（0.6 宽丧尸）判定为可通 | AABB 全宽判定，不走「单点射线」 |
| 四面围死 | `blocked`、零速度、**朝向不变** | 用户裁定：留在原地不追 |
| 围死解除 | 下一 AI 周期（50ms 内）重探 → 恢复 `chasing` | 无需额外状态，探针无记忆 |
| 玩家在 80 格外（idle）+ 同伴排斥 | 只要合成速度非零就走 2.4 的探针 | 判据只有「速度是否非零」，与 mode 无关 |
| 跨 column 移动 | 不受影响 | 转向不改 `position`，索引迁移判据（before/after）不受影响 |
| 矿车/其它实体 | 不算障碍（探针只看方块） | 与物理同口径：丧尸 AABB 只与方块碰撞 |

## 5. 性能

**实测**（2026-11-02，真浏览器页内 2000 次/档，计数包装 `world.isSolid`；下面是实测值，
不是解析上界 —— 上界按 AABB 覆盖格数算是 ≤12 / ≤24，但围死时多数探针**第一次采样就命中**，
根本走不到台阶分支，所以真实值低一档）：

| 场景 | `isSolid`/次探针 | 单次耗时 | 20 只 @ 20Hz 合计 |
|---|---:|---:|---|
| 开阔地（0° 直接命中） | **3.22** | 0.45 µs | 1288 次/秒 ≈ 0.18 ms/秒 |
| 四面围死（9 个探针全试） | **18.0** | 1.75 µs | 7200 次/秒 ≈ 0.70 ms/秒 |

即最坏也**只占 1 秒里的 0.7 毫秒（≈0.07% CPU）**。单次 AABB 采样 2 次 `isSolid`（站在整数 y 上
时竖直只覆盖一层）。
- 性能门沿用既有 `tests/zombies.spec.mjs` 的「默认 20 只压力验收」`fps > 90`，**不新增计时断言**
  （每秒量级的微开销做计时断言只会引入 flake，见 `docs/testing-policy.md` §2.5）。

## 6. 测试分级（`docs/testing-policy.md`）

本改动属 **Tier 1**（机制/API/热路径）⇒ **必须 TDD**（RED → 验证 RED → GREEN → 验证 GREEN）。

### 6.1 浏览器内单测（`src/tests/test-zombies.js`，新文件段落）

`zombie-navigation.js` 纯函数用例（全部用 `makeAiFixture` 的平地 world + `setBlock` 造墙）：

| # | 用例 | 为什么必须有 |
|---|---|---|
| a | 无障碍 → 输出**逐位等于**输入 | 零回归；只钉「方向被换过」抓不到「平地也被打偏」 |
| b | 正前 1 格墙、右侧通 → 偏 +22.5° | 最小偏角语义 |
| c | 正前墙、左侧通 → 偏 −22.5° | 双向对称（只测一侧会让「永远偏右」通过） |
| d | 正前墙、两侧都通 → 取 +22.5 | 确定性（钉住候选顺序常量） |
| e | 正前 2 格高墙 → 偏转；**正前 1 格台阶 → 不偏转** | 台阶前瞻与物理同源（砍掉前瞻 → e 的一半红；`y+1` 判据写死成 2 格 → 另一半红） |
| f | 四面围死 → `blocked:true` 且 `vx===vz===0` | 用户裁定的兜底语义 |
| g | 速度长度守恒（9 个方向逐一，误差 1e-12） | 只换方向、不改速度权威 |
| h | 净空 1.8 的走廊（脚下 y=1、`y=3` 有顶），脚底 **y=1.0 与 y=1.2** 两个高度都不判 blocked | `PHYS_EPSILON` 同源：y=1.2 时 AABB 顶面恰为 3.0，没 ε 会多采一格头顶 → 走廊里僵住 |
| i | 零速度意图 → 原样返回、不判 blocked | 静止丧尸不得凭空转向 |

`ZombieService` 集成用例：

| # | 用例 | 为什么必须有 |
|---|---|---|
| j | `_applyIntent` 后 `state.velocity` 已偏转、`mode==='chasing'` | 接线（只测纯函数会漏「没接线」，M7 教训） |
| k | `mode:'blocked'` 能进 state 且**不被规范化成 idle** | 白名单扩展（静默规范化是纯逻辑盲区） |
| l | 围死 → 零速度、位置不动；拆墙后下一周期恢复 `chasing` 并移动 | 恢复路径（只测「变 blocked」会让「永久 blocked」通过） |

### 6.2 Tier 4（真实游戏页，`tests/zombies.spec.mjs`）

1. `editor.setBlock({x,y,z,id})` 砌一道 3 格高的短墙（挡住玩家与丧尸之间的直线），生成丧尸 →
   **断言它绕过墙**：最终丧尸落在墙的**玩家这一侧**（跨越墙所在直线），且与玩家的距离
   显著减小（不是「撞墙不动」）。
2. 完全围死（四面围墙）→ 断言丧尸位置在容差内不动（`blocked`），且 20 秒内仍存活（不 despawn）。
3. **负向验证**：临时把 `steerIntent` 短路成「原样返回」，用例 1 必须真 FAIL（撞墙不动）——
   这是唯一能证明判据有判别力的手段。

### 6.3 必须复跑的既有回归（不被本改动碰，但会被它暴露）

- `test-zombies.js` 的「丧尸物理: 一格 step-up（1 格台阶能上，2 格墙不能上）」（`:1092`）——
  前瞻判据写错会红。
- `tests/zombies.spec.mjs` 的「AI batch 经真实 WorkerPool 可观测」（`:277`）—— RPC 键集与
  `mode` 断言（`chasing` / `idle`）。
- `tests/zombies.spec.mjs` 的「默认 20 只丧尸压力验收」（`:541`）—— fps 门。

## 7. 风险与已知观感取舍

1. **90° 转向的转头跳变**：`setIntent` 由速度派生 `yaw`，转向 90° 时朝向一帧内改变。首版不做平滑
   （避免为观感引入第二份每实体状态）；实施后实玩观察，若确实生硬再单开增量加 yaw 插值。
2. **贴墙蹭**：撞长墙时先偏 90° 沿墙走，缺口一开立刻转回。这正是「贴身绕行」的收益，也可能是
   用户觉得「怪」的地方 —— 调整手段是 `probeDistance`；不接受才考虑「绕行侧记忆」。
3. **窄缝通过**：0.6 宽丧尸对 1 格宽门可通（AABB 判定）；但**探针只看目标点**，极端情形（门在 1.2 格
   之外且需要先贴边再进）可能本轮判 blocked、下一轮换个位置就通 —— 观感是「犹豫一下」。可接受。
4. **与 mc-lite 的关系**：mc-lite 的丧尸是纯直线追逐（靠 S 路线随机偏移角减少重叠），**没有避障**。
   本改动是**有意增强**，不属于「对齐上游」，故不进 CLAUDE.md 的「六处偏离」清单（那是视觉比对专用）。

## 8. 验收

- 上述 §6 全部用例绿；`npm run check`（arch + data + lint）通过。
- §6.3 的三条既有用例绿。
- Tier 4 两条正向 + 一条负向验证按预期（负向必须真 FAIL）。
- 实施后在本文件 §9 补记：实测探针次数/成本、实玩观感结论（拐早拐晚、转头是否生硬、
  是否需要「绕行侧记忆」）。

## 9. 文档同步（实施时一并做）

- `docs/roadmap.md`：新增一行版本记录（下一个版本号 = **v2.40**，前一版 v2.39 是丧尸上台阶缓动）——
  含用户原话、实现要点、实测探针成本、已知取舍。
- `CLAUDE.md` 的「M6 丧尸沉淀的活跃约束」段：新增两条活跃约束 ——
  ① 探针接在 `_applyIntent`（AI 回包唯一消费点），**不得接在 `setIntent`**；
  ② `zombieCollidesAt` 是丧尸 AABB 碰撞的唯一实现（物理与探针共用，含 `PHYS_EPSILON`），
  改它要同时跑物理与探针两侧用例。
- 实施完成后填本文件 §9 → 顺延为 §10 实施记录（或保留 §9 并把记录写成 §10，实施时定）。

## 10. 实施记录（2026-11-02 落地）

### 实测

- **浏览器单测**：`total 1287 failed 0`，其中「避障」相关 **10 条**（a~i + 单一权威 + j~l）。
- **Tier 4**（`tests/zombies.spec.mjs`）：**13/13**，新增两条 —— 绕 5 格宽 3 格高墙 12 秒后
  `crossed=true`、`endDist < startDist − 2`；3×3 竖井围死 8 秒后 `moved < 0.05`、`mode='blocked'`、
  `count=1`。
- **门禁**：`npm run check` 0 error（44 warnings，均为仓库既有风格项）。
- **负向验证 4 条真红**：
  1. 删 `PHYS_EPSILON` → 只有用例 h 的 y=1.2 那半红（`Expected false, got true`）。
  2. 0° 分支改成 `ux*len` 重建向量 → **初版全绿（盲区）** → 补「非精确往返」输入
     `(-0.720745, 1.028745)` / `(1.05292, -0.870183)` 后真红（`实得 …0000000001`）。
  3. `steerIntent` 首行短路 → Tier 4 两条都红（围死那条 `moved = 0.2828 > 0.05`，比设计预期的
     「可能仍绿」判别力更强）。
  4. 用例 l 的拆墙 fixture 初稿只拆一列 → 仍 `blocked`（真因：探针落点在 1.2 格外、AABB 跨两列），
     用页面内逐候探针定位后改成拆 `x=11..15 / y=4..5`。**属 fixture 缺陷，不是实现缺陷。**

### 偏离本设计之处

1. **§6.1 用例 b 的预期偏角从 22.5° 改为 45°**（几何必然，见 §3 与实施记录）：半宽 0.3 +
   半格 0.5 需横向让开 0.8 格，`sinθ > 0.8/1.2 ⇒ θ > 41.8°`。22.5° 改由新加的用例 d
   （斜擦夹具，脚底 z=2.9）钉住 —— 它证明细档真的会被用到，阶梯不是直接从 0° 跳 45°。
2. **新增一条计划外用例**「`zombieCollidesAt` / `zombieStepUpY` 是本仓的单一权威」：设计 §2.1
   要求它们是唯一实现，但没有任务验证物理侧真的在转调它们。
3. **`PHYS_EPSILON` 随 `collides()` 一并迁到 `zombie-navigation.js` 并删除原处**（设计 §2.2 的
   警告项）：实测它只被 `collides()` 使用，故全局只留一份，不留两份同名常量。
4. **`ZOMBIE_MAX_STEP` 上移到 `zombie-config.js`**（设计 §2.3）：`zombie-system.js` 的局部
   `const MAX_STEP` 已删除，物理与探针共用同一份。

### 实玩观感（待用户确认后再补）

- 拐早拐晚：`probeDistance = 1.2`（提前约 1 秒行程）尚未经实玩校准。
- 转向是否生硬：`yaw` 由速度派生、无平滑，转向 90° 时是**一帧转头**（设计 §7.1 已列为首版取舍）。
- 是否需要「绕行侧记忆」：设计 §7.2 的后续选项，本轮未做。

## 附：本轮未做但值得记住的相邻议题

- **卡住时随机游荡 / 转头张望**：需要给 intent 加 `yaw` 字段并改 `setIntent` 的「静止保持朝向」
  契约（现为 `moving ? atan2(vx,vz) : state.yaw`）。属另一个增量，用户本轮未选。
- **绕行侧记忆**（撞墙后记住上次绕哪边，避免在障碍凸出点左右犹豫）：需要一份每实体瞬态状态，
  属 §7.2 的后续选项。
- **mob 之间的避让**：现有 `ZOMBIE_SEPARATION` 排斥力已覆盖，未与本改动交互。
