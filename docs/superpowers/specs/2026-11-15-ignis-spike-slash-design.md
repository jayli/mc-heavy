# 焰魔第五招：尖刺攻击（spikeSlash）

> 用户 2026-11-15 手写草图 + 文字裁定。本文是设计文档，实施计划另出。

## 1. 意图与由来

用户草图（`/Users/bachi/ttt/bug/尖刺攻击.jpg`）原文：

> 把大剑举起，用力向下劈向目标，如果玩家很近，就再接第二刀，向前 10 格内放出尖刺。
> 伤害 18 点，玩家距离 4 格以内就连续再劈第二刀，玩家在 4 格以外，就不再劈第二刀。

草图右侧画了 4 个「尖刺」示意（箭头状凸起 + 底部圆环）。

**本轮裁定（`ask_user_question` 实测回答）**：
- 尖刺形态 = **火焰尖锥（橙红发光）**，程序化几何，零新增贴图；
- 握剑 = **照原版单手**（左臂张开平衡），不改动画；
- 伤害 = **只尖刺 18，刀砍仍 14**（沿用 `IGNIS.attackDamage`）；
- 权重 = **新招 0.20**，横扫/持盾冲撞各 .25→.175（仍严格平分），举盾砸击 .20→.15，旋斩 .30 不动；
- 尖刺布局 = **5 根，隔格一根**（正前方 2/4/6/8/10 格）。

## 2. 原版调研结论（实测，不是猜的）

### 2.1 原版有这一招：`EARTH_SHUDDERS_ATTACK`

| 项 | 实测值 | 出处 |
|---|---|---|
| Java 动画 | `EARTH_SHUDDERS_ATTACK = Animation.create(138)` = 6.9s | `Ignis_Entity.java:112` |
| Bedrock 素材 | **`attack3a`**（`animation_length` 6.9） | 逐轴平均差 **1.053°**，第二名 `attack3b` 10.004° |
| 触发 goal | `Earth_Shudders`（独立 goal，`goalSelector.addGoal(1, …)`） | `Ignis_Entity.java:269` |
| 触发条件 | 距离 4.5~11 格 + 1% 概率 + 独立冷却 + 高差 ≤2.5 | `:759` |
| 三段伤害 | tick 32 / 73 / 117，各 `AreaAttack(4f, 6, 80, …)` + `ShieldSmashDamage` | `:1214-1252` |

**配对依据**（复用 `tools/java-model-parse.mjs` 唯一权威，不自己重写矩阵链）：
全量扫描 84 条 Bedrock 动画 × 139 个 tick × 9 根骨骼 × 3 轴 = 3753 个分量，
`attack3a` 平均差 1.053°（最坏 38.20° @sword.x tick132，是收势段的线性插值 vs 原版缓动），
`attack3b` 平均差 10.004°（最坏 58.01°）⇒ **`attack3a` 是唯一候选**。

### 2.2 三刀的几何语义（真实 200 角点，不是单点探针）

| 刀 | 源 tick | 源 t | 剑身轴竖直分量 | 剑最低点 y | 剑尖前方距 | 语义 |
|---|---|---|---|---|---|---|
| 第一刀 | 32 | 1.60s | **−0.915** | −2.04 格 | 3.14 格 | **下劈** ✓ |
| 第二刀 | 74 | 3.70s | **+0.851** | −0.26 格 | 3.84 格 | **上撩** ✗ |
| 第三刀 | 118 | 5.90s | **−0.915** | −2.04 格 | 3.14 格 | **下劈** ✓ |

⇒ 用户要的「第二刀向下劈」= 原版的**第三刀**。中间的上撩段整段去掉。

**两刀的劈底姿态逐位相同**（9 根骨骼 × 3 轴全 0 差）⇒ 拼接后观感是「同一个动作劈两次」。

### 2.3 原版不是「尖刺」

原版 `ShieldSmashDamage`（`:1704`）与 `UltimateAttack`（`:1769`）都是：
- 在目标格生成 `Cm_Falling_Block_Entity`（**把地面方块整块掀飞**，真实体方块）；
- 对该格 AABB 内的生物扣血 + 击飞。

**没有尖锥几何**。本仓的尖刺是新建的程序化几何（用户裁定火焰尖锥）。

### 2.4 单手 vs 双手

`attack3a` 的左拳↔剑柄握把距离全程 **≥3.24 格**（`left_fist` 无动画通道）⇒ **单手**。
对照：`attack11`（举盾砸击）最小 0.56 格 ⇒ 双手。
用户裁定照原版单手 ⇒ 零改动画。

## 3. 目标 / 非目标 / 反目标

**目标**
- 焰魔新增第五招 `spikeSlash`：举剑过顶 → 向下劈地 → 正前方 5 根火焰尖锥递延升起。
- 第一刀命中帧（产物 0.992s）时若玩家水平距 **≤4 格** ⇒ 接第二刀（产物 2.250s 再劈一次）。
- 尖刺覆盖格内的玩家扣 **18** 点（每刀一次，不逐帧）。
- 刀砍本身仍走 `IGNIS.attackDamage = 14`（与另四招同口径）。

**非目标**
- 不做原版第二刀的上撩（用户要的是「再劈一次」）。
- 不做 `Cm_Falling_Block_Entity`（真实掀飞方块 = 改玩法，超出范围）。
- 不做震屏（沿用 v3.04 裁定「不做震屏」）。
- 不改另四招的任何数值（射程/锥角/命中帧/时长一律不动，只改权重）。
- 不新增贴图文件（尖锥是程序化几何 + 逐实例颜色）。

**反目标（做成了也算失败）**
- 尖刺只在「打中玩家」时才出 ⇒ 与原版不符（原版特效不看视线）。
- 常驻 draw call 增长（零活跃时必须 `visible=false`）。
- 第二刀的距离门用「起手时距离」而不是「第一刀命中帧时距离」⇒ 玩家跑开仍被追劈。
- 拼接接缝有可见跳变（>片段自身合法单帧）。

## 4. 现状与约束（已核实）

### 4.1 可复用的基建

| 基建 | 文件 | 本轮用途 |
|---|---|---|
| 分段时间重映射 | `tools/ignis-fingerprint.mjs` 的 `IGNIS_ANIM_TIME_WARP` / `ignisAnimTimeWarp` | **扩展为多段**（现有只支持 4 段 A/B/C/D） |
| 逐实例颜色池 | `src/render/flame-sigil.js`（additive + `setColorAt`） | 尖锥照此手法新建 |
| 特效触发 | `attackFxRequest`（不受 `freshLos` 影响） | 尖刺走它 |
| 地面查找 | `Game._findSigilGroundY`（脚底+4 → 脚底−8 向下扫） | 尖刺落点复用 |
| 姿态衔接 | `IgnisPoseTransition`（smoothstep） | 拼接接缝补间 |
| 玩家格重叠 | `PlayerPhysics.overlapsBlock(x,y,z)` | 尖刺伤害判据 |

### 4.2 关键约束

- **`feetOffsetY` 不刷新**（实测）：新招源区间 `[0,2.75] ∪ [4.70,6.90]` 内身体最低点
  **0.295845**（`lowerbody2` @源t 0.77），高于现有最低点 0.048090 ⇒ `IGNIS_CORE_OBB.center[1]` 不变。
- **冷却不变式**：新招最长 2.750s < `attackCooldownMin` 4.0 ✓（余量 1.25s）。
- **片段自身最快单帧**（排除接缝）：**14.93°**（`sword` @产物t 2.633）。
- **入场硬切**：新招首帧 = bind（`attack3a` t=0 全通道为 0），与 idle 差 **≤0.26°**
  ⇒ 默认 0.2s 淡入足够（不需要旋斩 0.6 / 举盾砸击 0.8 那种长淡入）。
- **拼接接缝**：源 2.75 → 源 4.70，逐骨最大差 **17.8°**（`left_arm_joint`）。
  压缩后该处单帧 24.39° > 片段上限 14.93° ⇒ **必须补间**。
- **`IGNIS_ATTACK_IDS` 顺序载荷性**：既有断言「末档 = shieldBash」⇒ 新招必须排在它**之前**，
  或改断言。本轮取**新招排最后**并改断言（语义更清晰：新招是最新加的）。
- **`spikeSlash2` 不进 `IGNIS_ATTACKS`**：它不是独立抽签档，只是同一招的第二段。
  产物动画两条（`spikeSlash` / `spikeSlash2`），`attackKind` 恒为 `spikeSlash`，
  state 增 `spikeSecond: boolean` 决定播哪条与何时结束。

### 4.3 时间重映射（压缩后，实测）

**单刀 `spikeSlash`**（总 1.717s，52 帧 @30fps）：

| 段 | 源区间 | 倍率 | 产物区间 |
|---|---|---|---|
| 举起 | [0.00, 0.75] | ×0.5 | [0.000, 0.375] |
| 举剑保持 | [0.75, 1.40] | ×1/3 | [0.375, 0.592] |
| 劈下 | [1.40, 1.60] | ×2.0 | [0.592, 0.992] |
| 劈底保持 | [1.60, 2.55] | ×0.5 | [0.992, 1.467] |
| 收势到 bind | [6.40, 6.90] | ×0.5 | [1.467, 1.717] |

**双刀 `spikeSlash2`**（总 2.750s，83 帧 @30fps）：

| 段 | 源区间 | 倍率 | 产物区间 |
|---|---|---|---|
| 第一刀举起 | [0.00, 0.75] | ×0.5 | [0.000, 0.375] |
| 第一刀举剑保持 | [0.75, 1.40] | ×1/3 | [0.375, 0.592] |
| 第一刀劈下 | [1.40, 1.60] | ×2.0 | [0.592, 0.992] |
| 第一刀劈底保持 | [1.60, 2.55] | ×0.5 | [0.992, 1.467] |
| 剑回正（前段） | [2.55, 2.75] | ×0.5 | [1.467, 1.567] |
| 第三刀举起（后段） | [4.70, 4.90] | ×0.5 | [1.567, 1.667] |
| 第三刀举剑保持 | [4.90, 5.75] | ×1/3 | [1.667, 1.950] |
| 第三刀劈下 | [5.75, 5.90] | ×2.0 | [1.950, 2.250] |
| 第三刀劈底保持 | [5.90, 6.40] | ×0.5 | [2.250, 2.500] |
| 收势到 bind | [6.40, 6.90] | ×0.5 | [2.500, 2.750] |

**命中帧**：第一刀 **0.991667s**（两条动画逐位相同）；第二刀 **2.250s**（仅双刀）。
**接缝**：单刀产物 1.466667s（源 2.55 → 6.40，35.0°）；双刀产物 1.566667s（源 2.75 → 4.70，17.8°）
⇒ 两处都用 0.2s smoothstep 补间。

⚠️ **`animSeconds` 取段表总时长（1.716667 / 2.75），不是 `frames/fps`**：
帧数取整后产物 duration 是 1.733333 / 2.766667，与段表总时长差 0.0167s。
`shieldBash` 同口径（它 `animSeconds` 3.89 而 `frames/fps` = 3.90）。

## 5. 设计

### 5.1 烘焙（`tools/ignis-fingerprint.mjs` + `tools/bake-ignis.mjs`）

- `IGNIS_ANIM_SOURCES` 增两条：`spikeSlash: ['attack3a']` / `spikeSlash2: ['attack3a']`。
- `IGNIS_ANIM_PERIODS` 增两条：源时长都是 6.9。
- **`IGNIS_ANIM_TIME_WARP` 扩展为多段形态**：现有 4 段 A/B/C/D 是 `shieldBash` 专用，
  新招需要 5/10 段 + **源区间跳跃**（2.75 → 4.70 不连续）。
  新增 `IGNIS_ANIM_SEGMENTS`（段表：`[{srcStart, srcEnd, scale}]`），
  `ignisAnimTimeWarp` 优先读它，无则回落现有 4 段逻辑（`shieldBash` 不动）。
- **接缝补间在烘焙期做**（不在渲染期）：段表增 `blendIn: 0.2` 标记，
  烘焙器在该段前 0.2s 内把「上一段末姿态」与「本段实时采样」smoothstep 混合。
  ⇒ 产物帧已含补间，渲染器零改动、`sampleIgnisAttack` 零改动。
- `IGNIS_ATTACK_ANIM_KEYS` 自动派生（现有逻辑）⇒ `check:data` 自动跟上。

### 5.2 玩法档案（`src/entities/ignis/ignis-config.js`）

```js
spikeSlash: Object.freeze({
  hitRange: 6.5,          // 与另四招同值（用户 v3.01 裁定「不要窄距离门」）
  hitConeDeg: 40,         // 原版 AreaAttack(4f, 6, 80) 的半角
  hitFrameSeconds: 0.991667, // 第一刀劈底（产物，精确 0.9916666…）
  animSeconds: 2.750,     // 取双刀时长（派生最大值用）
  weight: 0.20,
}),
```

新增常量：
```js
export const IGNIS_SPIKE = Object.freeze({
  count: 5,               // 用户裁定「5 根，隔格一根」
  spacing: 2,             // 正前方 2/4/6/8/10 格
  firstOffset: 2,
  damage: 18,             // 用户草图「伤害 18 点」
  secondRange: 4,         // 用户草图「距离 4 格以内就连续再劈第二刀」
  secondHitFrame: 2.250,  // 第二刀劈底（产物）
  soloSeconds: 1.716667,  // 单刀时长（段表总时长，非 frames/fps）
  doubleSeconds: 2.750,   // 双刀时长
  riseMs: 180,            // 尖锥升起时长（观感旋钮）
  lifeMs: 900,            // 尖锥存活（含升起 + 保持 + 缩回）
  delayPerSegmentMs: 50,  // 递延点亮（同法阵口径）
  height: 1.6,            // 尖锥高度（格）
  radius: 0.35,           // 尖锥底半径（格）
  maxActive: 20,          // 池容量（5 根 × 并发 4 招余量）
});
```

权重改：`swing .175 / spin .30 / shieldSmash .175 / shieldBash .15 / spikeSlash .20`。

### 5.3 Agent（`src/entities/bosses/ignis-boss-agent.js`）

- 抽签：`_rollAttackKind` 自动跟上（`IGNIS_ATTACK_IDS` 派生）。
- 命中推进：`spikeSlash` 档有**两个命中帧**：
  - 第一帧 0.992s：恒触发；产生 `attackRequest`（刀砍 14）+ `attackFxRequest`（尖刺）；
    **同帧判 `hDist <= IGNIS_SPIKE.secondRange`** ⇒ 置 `spikeSecond = true`。
  - 第二帧 2.250s：仅 `spikeSecond` 时触发；同样产生两个 request。
- 动画结束：`spikeSecond ? doubleSeconds : soloSeconds`。
- `spikeSecond` 进 `createState`（缺省 false），**不进 snapshot**（瞬态玩法字段，
  但跨帧保持 ⇒ 不是「本帧消费即清」的瞬态，而是「本招内保持」）。
  ⚠️ 离开 attack 态时复位 false（同 `attackKind`）。

### 5.4 尖刺渲染器（新文件 `src/render/spike-fx.js`）

- 几何：`ConeGeometry(radius, height, 6)`（6 棱锥，像素风），沿 +Y。
- 材质：`MeshBasicMaterial` + `AdditiveBlending` + `depthWrite:false` + `toneMapped:false`。
- 颜色：火焰橙红 `[1.0, 0.45, 0.12]`（比 `IGNIS_DEATH_COLOR` 更红，读作「烧红的刺」）。
- 池：`InstancedMesh`，容量 `maxActive`，零活跃 `visible=false`。
- 纯函数（可单测、无 three）：
  - `spikeSpawnPoints(at, yaw, cfg)` → 5 个 `{x, z, delayMs}`（本仓 yaw 口径 `(−sin, −cos)`）；
  - `spikeScaleAt(ageMs, delayMs, cfg)` → `{scale, visible, done}`（升起 → 保持 → 缩回）；
- `spawn(points, nowMs)` / `update(nowMs)` / `dispose()`。
- **y 由调用方算**（渲染层不查体素，同 `flame-sigil` 口径）。

### 5.5 接线（`src/core/game.js`）

- 装配 `this.spikeFx = new SpikeFxRenderer({scene})`（无贴图依赖，恒装配）。
- `update` 链加 `this.spikeFx.update(nowMs)`（紧邻 `flameSigil.update`）。
- `dispose()` 加 `this.spikeFx?.dispose()`。
- `_consumeIgnisFxRequests`：`kind === 'spikeSlash'` ⇒ 5 根尖刺（逐根查地面 y）+ 碎石圆环（复用）。
- **尖刺伤害**：在 `_consumeIgnisAttackRequests` 里，`kind === 'spikeSlash'` 时
  除了刀砍 14，再判玩家是否与任一根尖刺的格重叠（`overlapsBlock`）⇒ 扣 18。
  ⚠️ 尖刺伤害**不看视线**（原版 `ShieldSmashDamage` 不看 LOS）⇒ 走 `attackFxRequest` 路径，
  但伤害是玩法 ⇒ 需要一个新的 request 字段或复用 `attackRequest` 并标记。
  **决定**：`attackFxRequest` 增 `spikeDamage: boolean`，`_consumeIgnisFxRequests` 里结算尖刺伤害
  （它已经读 `attackFxRequest`，且不受 `freshLos` 影响 ⇒ 与原版一致）。
  ⚠️ 这会让「特效消费」路径带伤害 —— 与 v3.04「纯视觉」口径不同，但那是**法阵**的裁定，
  本轮用户明确要尖刺带 18 伤害 ⇒ 新招新口径，不改法阵。

### 5.6 音效

复用 `ignis_attack_smash`（持盾冲撞的近似替代音）⇒ `IGNIS_ATTACK_SOUNDS.spikeSlash = 'ignis_attack_smash'`。
⚠️ 不新增音频文件（用户未要求）。

## 6. 验证

**Tier 1（必须 TDD）**
- 烘焙：两条动画的帧数（52 / 83）、段表时长（1.716667 / 2.75）、命中帧姿态（剑最低点 y < −1.5）；
- 段表：产物时间 → 源时间单调、段界连续、接缝补间后单帧角 ≤ 片段上限 14.93°；
- 玩法：`spikeSlash` 档案形状、权重和 = 1、横扫 == 持盾冲撞、旋斩不动；
- Agent：第一命中帧恒触发；`hDist ≤ 4` ⇒ `spikeSecond = true`；`hDist > 4` ⇒ false；
  第二命中帧仅 `spikeSecond` 时触发；离开 attack 复位；
- 尖刺纯函数：5 根落点 = 正前方 2/4/6/8/10 格（本仓 yaw 口径）、延迟序列 0/50/100/150/200ms、
  升起→保持→缩回的 scale 包络、零活跃 `visible=false`；
- 伤害：玩家站在尖刺格内扣 18、格外不扣、与刀砍 14 叠加。

**Tier 4（像素实测）**
- 尖刺：藏掉焰魔本体（同 v3.04 教训：焰魔自己是火焰橙，会淹没判据），
  判据取「橙红像素」`r > g + 40 && g > b + 20 && r − b > 120`，带沙漠沙对照；
- 上下界都钉；先测同状态重复截图的噪声底；
- draw call：零活跃时与基线相同。

**门禁**：`npm run check` + `npm run ignis`（重烘）+ 上述 spec。
不改热路径 ⇒ 不需要 `bench --check`。
新增 additive 透明池 ⇒ 跑 `tests/water-order.spec.mjs` 确认水面顺序不变式。

## 7. 留给实施者的决定

- 尖锥 `height` / `radius` / `riseMs` / `lifeMs` 的具体观感值可实玩微调。
- 火焰色 `[1.0, 0.45, 0.12]` 若过曝，调 `instanceColor` 亮度而不是改混合模式。
- 接缝补间 0.2s 若仍可见跳变，加长到 0.3s（但必须在第二刀命中帧 2.250s 之前走完）。

## 8. 本轮明确不做

震屏、`Cm_Falling_Block_Entity` 真实掀飞方块、原版第二刀上撩、双手握柄改动画、
新增贴图/音频文件、另四招的数值改动（只改权重）、设置面板开关。

---

## 9. 实施期修订（2026-11-15，以本节为准）

落地时四处与本设计不同，全部有实测依据：

| 项 | 设计原值 | **落地值** | 原因 |
|---|---|---|---|
| 双刀段数 | 10 段 | **9 段** | 举起与保持合成 `[4.70,5.75]×1/3`（10 帧）—— 原 3 帧段自身要转 54.4° 又要释放 17.8° 接缝，smoothstep 把变化挤进末帧（实测 30.11°） |
| 收势段倍率 | ×0.5 | **×1** | 该段 sword 要转 180°，×0.5 得 7.5 帧（24°/帧）；blendIn 再占 6 帧 ⇒ 实测 22.64° > 上限 15.58° |
| 单刀 / 双刀 | 52 帧 1.716667s / 83 帧 2.75s | **59 帧 1.966667s / 89 帧 2.966667s** | 上两项的连带结果 |
| 第二命中帧 | 2.25s | **2.216667s** | 段表合成后重算 |
| 起手音 | 复用 `ignis_attack_smash` | **新拷 `ignis_attack_spike.ogg`**（mod `ignis_impact2.ogg`，11686 字节） | 既有 `test-bgm.js` 断言「五招起手音两两不同」 |

**另修三个实现缺陷**（都是「计数全对但画面错」型）：
1. **three 的 `slerpQuaternions` 是 `this.copy(qa).slerp(qb,t)`** —— `this === qb` 时 qb 被 qa 覆写
   ⇒ 整段恒等上一段末姿态。改用独立 `_blendQuat`。
2. **段界浮点**：累加得 1.5666666666666669 而帧时刻 47/30 = 1.5666666666666667，差 2.2e-16
   ⇒ 严格 `<` 让接缝首帧落进上一段、完全不补间。`segAt` 与 blendIn 校验各加 1e-9 容差。
3. **Tier 4 判据必须用差分**：additive 叠在蓝天空 (86,136,175) 上得 (125,147,176) **仍偏蓝**，
   绝对色 `r > g + 40` 永远不成立（命中 2 = 基线，零判别力）⇒ 改
   `Δr > 25 && Δr > Δg+12 && Δr > Δb+12`，实测基线 0/0/0、尖刺帧 2488~4033。

**版本号 v3.06**（v3.05 已被「焰魔血量 1000→3500」占用）。
