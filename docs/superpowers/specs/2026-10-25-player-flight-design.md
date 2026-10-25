# 玩家飞行（创造模式飞行）设计文档

> 日期：2026-10-25 ｜ 状态：**已实施**（v1.81，2026-10-25）
> 用户需求：「实现玩家会飞的能力，参照我的世界原版」
> 上游对齐：Minecraft Java Edition 创造/旁观模式飞行（wiki `Flying` / `Creative` 页 + Mojang 官方热键表）
> 设计文档影响：`docs/phase-1-engine-design.md` §4.4（玩家物理与移动）增补一节 + 修订说明一条

## 1. 背景与目标

本仓库玩家只有行走/跳跃：`src/player/physics.js` 只有 `GRAVITY=-24` / `JUMP_FORCE=10` / `SPEED=8`，
没有任何飞行状态。用户要求补上原版创造模式的飞行能力，用于快速勘查世界（视距 8 chunk ≈ 128 格，
当前只能靠跳跃与地形攀爬）。

**目标**：玩家可在任意高度开关飞行、自由升降、水平飞行速度是走路的两倍、落地自动退出。

**原版口径（核实来源，作为设计参照）**：

| 动作 | 原版 Java 默认 | 说明 |
|---|---|---|
| 开关飞行 | 双击空格（Jump） | 创造/旁观模式，两次按键间隔 ≤7 tick（约 350ms）；第一次按空格会先跳一下 |
| 上升 | 按住空格 | 飞行中空格不再当跳 |
| 下降 | 按住左 Shift（潜行键） | 飞行中 Shift 不再当潜行 |
| 水平移动 | W A S D | 始终水平，不受俯仰影响 |
| 加速 | 按住左 Ctrl（疾跑键） | 水平速度翻倍 |
| 落地退出 | 无按键 | **Java 特有**：碰到地面立即退出飞行（Bedrock 落地后仍保持飞行态） |

原版速度（wiki，格/秒）：走路 4.317 / 创造飞行 10.92（≈走路 2.5 倍）/ 飞行+疾跑 21.6。

**明确不做**（防止范围膨胀）：

- **不做 Ctrl 加速档**（用户裁定）——飞行只有一个速度档；
- **不照搬「双击空格」**（用户裁定改用单击 F 键）——因此没有 350ms 时间窗，也没有「起飞先跳一下」；
- 不做飞行惯性/阻尼（本仓库地面移动本就是无惯性的定步长手感，飞行沿用同一口径）；
- 不做飞行视角晃动（见 §4.5.3）；
- 不做旁观模式（穿墙/无碰撞）、不做飞行音效、不做飞行速度面板开关；
- **飞行状态不持久化**：进不了存档、进不了进度包（`save/progress-codec.js`），reload 落到地面 ——
  它是瞬时移动状态，不是世界状态（红线 1：只有 typed array 体素数据与玩家改动才是权威持久数据）；
- 不改 `SPEED`、不改 `GRAVITY`、不改 `JUMP_FORCE`（`view-bob.js` 的 `phasePerBlock` 由 `SPEED`
  派生，改它要连带重标晃动频率，与本次无关）。

## 2. 需求口径（用户裁定，逐条对应到实现）

| # | 裁定 | 实现落点 |
|---|---|---|
| R1 | 切换键 = **F 单击** | `player.js` `onKeyDown`：`e.code === 'KeyF' && !e.repeat` |
| R2 | 升降 = **空格升 / Shift 降** | `player.js` `_applyInput()` → `physics.moveVertical(±1/0)` |
| R3 | 落地退出飞行（Java 口径） | `physics.step()` 的飞行分支：向下移动触地 → `flying = false` |
| R4 | 水平速度 = **走路 2 倍** | `physics.js` `FLY_SPEED_MULT = 2` → `SPEED × 2 = 16` 格/秒 |
| R5 | **不设 Ctrl 加速** | 不读 `ControlLeft/ControlRight`；`move()` 只有一档飞行速度 |

## 3. 现状与差距（代码事实，已逐条核对）

| 事实 | 位置 | 对本次的影响 |
|---|---|---|
| 物理常量集中在本模块顶部 | `src/player/physics.js:4-8` | 新增飞行常量与它们并列，**不散落到 `player.js`** |
| `step(dt)` = 重力 → 水平分轴 → 竖直分轴 | `physics.js:35-50` | 飞行分支插在 `step()` 开头，绕开重力块 |
| `move()` 内写死 `SPEED` | `physics.js:200-208` | 改为按 `flying` 选速度 |
| `_tryStepUp()` 门控是「地面或下落中」 | `physics.js:118-141` | 飞行时直接返回 false（原版飞行没有自动上台阶概念） |
| `jump()` 的 `onGround` 门控 + `dismountJump()` | `physics.js:184-198` | 飞行时 `jump()` 早退；`dismountJump()` 不通飞行 |
| 空格只有两个消费点 | `player.js:596`（跳）、`player.js:409`（矿车下车） | 前者改成按飞行分流；后者不动 |
| 乘坐矿车时**整段跳过** `physics.step` | `player.js:270-300` | 飞行态在车上无物理效果 → F 键在乘坐期忽略（§4.5.1） |
| `Shift` 已用于挖块（矿车后退分支） | `player.js:245` → `player.js:641` | 不冲突：那是 `shiftKey + 左键`，键位层面无重叠 |
| `Ctrl` 已用于点燃 TNT / 启动矿车 | `player.js:245,637` | 本次不读 Ctrl，无影响 |
| 跑动晃动判据含 `jumping: !onGround` | `player.js:288` + `view-bob.js:127` | 飞行时 `onGround` 恒 false → 晃动自动为 0，**不新增第二份判据** |
| 操作说明是静态常量 | `src/core/perf-hud.js:33-37`（`HELP_LINES`） | 加一行；面板宽度固定 330px（`PANEL_WIDTH_PX`），须实测不撑宽 |
| 键盘单测走真实 window 事件 | `src/tests/test-player-input.js` | 新用例同一手法（只塞 `keys` 测不到 keydown 分支） |
| `check:data` 要求 `src/tests/test-*.js` 全部在 `index.html` 注册 | `tools/check-data.mjs:275` | **不新增测试文件**，把用例加进既有两个文件 |

## 4. 设计

### 4.1 状态归属：`PlayerPhysics.flying` 是唯一权威

`flying` 字段放 `PlayerPhysics`，**不放 `Player`**：

- 重力、定步长积分、分轴碰撞、自动上台阶全在 physics 层。若 `flying` 放 Player，物理层就不知道
  玩家在飞，会继续施加重力、继续尝试 step-up → 要么在 Player 里重复判一遍（第二份权威，红线 1），
  要么在 physics 里塞一个由外部猜出来的标志（同样漂移）；
- 与既有先例一致：`inWater`、`onGround`、`vel` 都在 physics（`physics.js:14-20`），
  `player.js` 只做输入编排（`_applyInput` 写 `vel`，不自行判定物理状态）。

公开面：`player.physics.flying`（布尔，可读可写 —— 测试与调试直接读）。Player 不额外复制一份字段。

### 4.2 常量（`src/player/physics.js` 顶部，与既有常量并列）

```js
/** 飞行水平速度倍率（用户裁定：走路 2 倍，不设 Ctrl 加速档） */
const FLY_SPEED_MULT = 2;
/** 飞行垂直速度（格/秒，空格升 / Shift 降）。初值 8，实玩后可标定（与 view-bob 的频率一样是标定值） */
const FLY_VERTICAL_SPEED = 8;
```

推导记录（供将来改值的人看）：

- 水平 16 格/秒 = 用户直接给的**倍率**口径（`SPEED × 2`），不是照搬原版绝对值 10.92。
  原版倍率是 2.5×，但本仓 `SPEED = 8` 已是原版疾跑（5.612）的 1.43 倍，2.5× 会到 20 格/秒；
  用户选「走路 2 倍」，故取 **16**；
- 垂直 8 格/秒 ≈ 水平的一半，观感与「按住空格爬升」的原版比例同量级。原版垂直飞行速度无公开
  稳定数值可引，**这是初值不是推导值** —— 若实玩觉得爬升太慢/太快，只改这一个常量。

### 4.3 `PlayerPhysics` 的行为改动

**新增公开方法**：

```js
/** F 键切换（边沿由调用方保证）。落地/起飞时清零竖直速度 —— 见下方三条行为约定。 */
toggleFlight() {
  this.flying = !this.flying;
  this.vel.y = 0;
}

/** 飞行垂直输入：dir = +1 升 / -1 降 / 0 悬停。按 60Hz 每步重设 vel.y（无惯性）。 */
moveVertical(dir) {
  if (!this.flying) return;
  this.vel.y = dir * FLY_VERTICAL_SPEED;
}
```

**`step(dt)` 分两条路**（飞行分支必须放在重力和水判定之前）：

```js
step(dt) {
  if (this.flying) { this._stepFlying(dt); return; }
  /* …既有重力路径逐字不动… */
}

_stepFlying(dt) {
  // 1. 水平：与地面同一套分轴移动 + 碰撞（撞墙停住，不改速度语义）
  this._moveAxis(this.vel.x * dt, 0);
  this._moveAxis(this.vel.z * dt, 2);
  // 2. 竖直：onGround 必须**每步先清零**（见下方约定 1、2）
  this.onGround = false;
  this._moveAxis(this.vel.y * dt, 1);
  // 3. 落地退出飞行（Java 口径）：向下碰撞会把 onGround 置 true
  if (this.onGround) { this.flying = false; this.vel.y = 0; }
  // 4. 水平速度每步清零（与地面同口径：move() 每步重设，无惯性）
  this.vel.x = 0; this.vel.z = 0;
}
```

四条行为约定（写进实现细节，前三条为**载荷性**）：

1. **`onGround` 每步先清零是落地判据的前提**。`onGround` 只由 `_moveAxis` 在**向下碰撞**时置 true，
   所以「清零 → 移动 → 判 `onGround`」与「本步向下且触地」等价。**不清零则判据失效**：玩家先站在
   地面上（`onGround === true`）再按 F 悬停时，竖直步长为 0 → `_moveAxis` 直接 `return`，
   `onGround` 带着上一步的 `true` 进入下次判定 → **贴地悬停被立即踢出飞行**（对应 P4 与 N2）。
   ⚠️ 故**不引入 `wasDown` 这类额外门控** —— 清零之后它是恒真的死分支（YAGNI）；
2. **飞行中 `onGround` 恒 false 同时是「飞行时不晃」的判据来源**（§4.5.3：`player.js` 传的是
   `jumping: !onGround`）—— 两个用途共用这一行，不要为了其中一个单开一份判据；
3. **直线向下飞触地才算落地退出**：向上顶到天花板时 `_moveAxis` 不会置 `onGround`（只置 `vel.y = 0`）
   → 撞头仍保持飞行态（对应 P8）；
4. **`toggleFlight()` 清零 `vel.y`**：避免「下落中被 F 拦住 → 保留 −24 的竖直速度继续往下掉」
   和「起跳上升段按 F → 保留 +10 继续往上窜」。起飞与降落都从静止竖直速度开始（悬停）。

**`move()` 改为按状态选速度**：

```js
move(inputX, inputZ) {
  /* …归一化不动… */
  const speed = this.flying ? SPEED * FLY_SPEED_MULT : SPEED * (this.inWater ? 0.6 : 1);
  this.vel.x = ix * speed;
  this.vel.z = iz * speed;
}
```

**`_tryStepUp()` 在飞行时返回 false**（顶部一行）：飞行中撞到方块边缘应当停住，而不是被抬上去
（原版飞行没有自动上台阶）。地面/空中下落段的既有行为逐字不变。

**`jump()` 在飞行时早退**：飞行中空格被 `moveVertical(+1)` 接管，不再走跳跃分支
（`player.js` 侧也不会调用它 —— 双保险，避免将来有人只改一边）。

**水与下落**：飞行分支不看 `inWater`（原版飞行下水照常飞，只是水面上有粒子）；
退出飞行后从当前高度正常自由落体，无缓降（原版同口径）。

### 4.4 输入绑定（`src/player/player.js`）

**KeyF 切换**（与 `KeyR` / `KeyX` 同一段，模态守卫已在前面）：

```js
if (e.code === 'KeyF' && !e.repeat) this.physics.toggleFlight();
```

- `!e.repeat`：按住 F 只切一次（键盘重复率约 30Hz，不判会疯狂抖动）；
- **不 `preventDefault`**：F 在浏览器里不是功能键（F5/F12 才是），与既有 `ARROW_CODES` 只拦方向键
  的口径一致；
- 模态守卫（设置面板/背包打开时 `keys.clear()` + return）已覆盖 F，无需额外改。

**空格/Shift 分流**（`_applyInput()` 末尾）：

```js
if (this.physics.flying) {
  const up = k.has('Space') ? 1 : 0;
  const down = (k.has('ShiftLeft') || k.has('ShiftRight')) ? 1 : 0;
  this.physics.moveVertical(up - down);
} else if (k.has('Space')) this.physics.jump();
```

- 升降同时按下 → `up - down = 0` → 悬停（原版同口径，不是互相取消成两个动作）；
- 左右 Shift 等价（`ShiftLeft` / `ShiftRight` 都认，与方向键那套「或」写法同手法）；
- **不要在 `onKeyDown` 里对 Shift `preventDefault`**：那会顺手吞掉 `shiftKey + 左键` 的矿车后退
  分支之外的其它组合（例如将来的快捷键），且没有任何收益。

### 4.5 与既有系统的交互（每一条都要在实现时逐条确认）

#### 4.5.1 矿车乘坐

- 乘坐期间 `player.update()` 整段跳过 `physics.step`（`player.js:270-300`），所以飞行态在车上没有
  物理效果。**F 键在乘坐期忽略**（`if (!this.ridingMinecartId)` 门控），理由：原版「进入矿车不会
  解除飞行」，但本仓飞行被物理步跳过 → 允许切换只会造出「视觉在车上、状态说在飞」的分裂。
- 上车前是飞行态 → 现在 `ridingMinecartId` 非 null → F 无效、空格是下车、Shift 是潜行不下降。
  下车后仍是飞行态（原版同口径：进矿车不解除飞行，随后继续飞），这是可接受的行为，实现时不需要
  额外清理。
- 「空格下车」的边沿状态 `_spaceReleased`（`player.js:357,409`）不动 —— 飞行期不绑车，两条路径互斥。

#### 4.5.2 挖块 / 放置 / 武器

不设任何门控：飞行中照常左键挖、右键放、R 换枪、射击。原版飞行中同样可以放置与破坏。

#### 4.5.3 跑动视角晃动

`player.js:288` 传给 `viewBob.update` 的 `jumping: !this.physics.onGround`，而 §4.3 约定飞行时
`onGround` 恒 false → `ViewBob.shouldBob` 首行 `if (jumping) return false` → **飞行全程零晃动**。
这是靠既有判据自然得到的，**不新增 `flying` 判断**（新增一份判据会与 `onGround` 漂移出
「在飞但还在晃」或「没飞也不晃」的分裂）。`view-bob.js` 一行不改。

> ⚠️ 这条与 `CLAUDE.md` 里「按物理步推进、相位由距离驱动」的既有约束不冲突：飞行时根本不进
> 晃动分支，`amount` 按 `releaseRetention` 收敛到 0。

#### 4.5.4 性能面板操作说明

`src/core/perf-hud.js` 的 `HELP_LINES` 加一行（现有三行 → 四行）：

```
'F：飞行开关 | 飞行中 Space：升 / Shift：降',
```

- 面板宽度固定 330px（`PANEL_WIDTH_PX`，v1.80 实测口径）。这一行必须在**真实页面上实测
  `scrollWidth ≤ 330px`**（含 20px padding），超了就缩短文案 —— 不得靠改 `PANEL_WIDTH_PX` 迁就
  （那会让该常量与实际需要脱钩，且历史上它是对着实测峰值标定的）；
- `helpEl` 的写死路径（构造时写一次 + 折叠用 `max-height`）不变；文本变长不影响折叠逻辑。

#### 4.5.5 其它

- **高亮与射线**：不涉及。
- **阴影/光照**：不涉及（玩家不投射阴影）。
- **存档与进度包**：不涉及（§1「明确不做」）。
- **怪物 AI**：不涉及。丧尸追击的是玩家坐标，飞行会拉开距离（它的 `findSpawnY` 与所在 column 逻辑
  与玩家高度无关）。

### 4.6 未采纳的替代方案与理由

| 方案 | 为什么不用 |
|---|---|
| 照搬原版「双击空格」 | 用户明确选 F 单击。且双击要引入 350ms 时间窗 + 「第一次按空格先跳一下」的特例，与矿车「空格下车」的边沿检测同键位争夺 → 两个时间窗状态机互相干扰 |
| `flying` 放 `Player` | §4.1：物理层会缺状态，被迫重复判定或读外部猜测值（红线 1） |
| 复用 `inWater` 式的「低重力」近似 | 低重力不是飞行：会一直下落、无法悬停、撞地后仍是飞行态 |
| 飞行速度也走 `SPEED` 单一常量 + 乘以一个外部传入的倍率 | 倍率没有单一权威；`move()` 是唯一写水平速度的地方，`flying` 与 `SPEED` 都在本模块，就地选速度最直接 |
| 给飞行加 Ctrl 加速 | 用户明确不要 |

## 5. 测试计划（Tier 1，走 TDD：RED → 验证 RED → GREEN → 验证 GREEN → REFACTOR）

按 `docs/testing-policy.md`：新增移动机制的静默失效模式是「玩家永远飞不起来 / 永远飞下来 / 飞得比
走路还慢」，肉眼只能靠玩，故属 Tier 1。

### 5.1 浏览器内单测（`src/tests/test-physics.js` + `src/tests/test-player-input.js`，不新增文件）

| # | 用例 | 断言（须先在真实数据上跑一遍取实际值，不要拍脑袋写阈值） |
|---|---|---|
| P1 | 飞行悬停不掉落 | 空中 `toggleFlight()` 后 60 步，`pos.y` 变化 < 1e-6（零重力） |
| P2 | 空格上升 / Shift 下降的速度 | 每步 `moveVertical(+1)`，60 步上升距离 ≈ `FLY_VERTICAL_SPEED × 1s`（容差 ±1 步）；`-1` 的下降同量级反向 |
| P3 | 下降触地退出飞行 | 离地 3 格、`moveVertical(-1)` 持续步进到落地：`flying === false` 且 `onGround === true` 且 `pos.y` = 地面 + 1 |
| P4 | 悬停不误退出（贴地场景） | **先落地 10 步**（`onGround === true`）→ `toggleFlight()` → `moveVertical(0)` 跑 60 步：`flying` 仍为 true、`pos.y` 不变（护栏：防止「每步不清 `onGround` → 悬停读上一步的 true → 立即退出」） |
| P5 | 飞行水平速度恰为走路 2 倍 | 同 yaw 下一步位移比 = 2（`round3` 口径），并显式断言 `> 1.5` 且 `< 2.5` |
| P6 | 飞行时 `_tryStepUp` 不生效 | 飞向 1 格台阶：`pos.y` 不变、水平被挡（`pos.x` 停在台阶前） |
| P7 | 关闭飞行恢复重力 | `toggleFlight()` 两次后从 10 格高自由落体 → 落地 |
| P8 | 撞天花板不停在飞行态 | 顶到实心格后 `flying` 仍 true、`vel.y === 0`（撞墙停住但不退出） |
| K1 | 真实 keydown 的 F 切换 | `pressKey('KeyF')` 后 `flying === true`，再按一次 `false`；**不 preventDefault** |
| K2 | F 按住不连发 | 派发 `repeat: true` 的 keydown 后状态不变（用 `new KeyboardEvent('keydown', {code:'KeyF', repeat:true})`） |
| K3 | 模态期间 F 不切换 | `_isModal = () => true` 时 `pressKey('KeyF')` → `flying` 不变 |
| K4 | 飞行时空格走垂直而非跳跃 | 飞行态塞 `Space` 跑 `_applyInput()` → `vel.y` 为正且 `≈ FLY_VERTICAL_SPEED`（不是 0 也不是 `JUMP_FORCE`） |
| K5 | 升降同按 = 悬停 | 飞行态同时塞 `Space` + `ShiftLeft` → `vel.y === 0` |
| K6 | 地面态 Shift 无副作用 | 不飞行时按 Shift 跑 `_applyInput()` → `vel.y` 不等于任何飞行值（不应有飞行分支漏进来） |

### 5.2 E2E（新增 `tests/player-flight.spec.mjs`，走真实页面主路径）

M7 的教训是「只测 API 会漏玩家主路径」，飞行是**纯键盘**玩法，必须走真实 `keydown`：

| # | 用例 | 断言 |
|---|---|---|
E1 | 起飞 | 页面加载后等玩家落地 → 派发真实 `KeyF` keydown → 按住 `Space` 2s → `physics.pos.y` 比起飞点高 ≥ 5 格，且 `physics.flying === true` |
E2 | 空中再按 F 落回地面 | 起飞后在高空再派发 `KeyF` → 3s 内 `onGround === true` 且 `flying === false` |
E3 | 降到地面自动退出 | 起飞后按住 `Shift` → 落地后 `flying === false`、`onGround === true` |
E4 | 水平速度比约 2 | 地面全速前进 6 步记位移 → 起飞后同 yaw 全速前进 6 步记位移 → 比值 `1.8~2.2`（实测值口径，不贴线） |
E5 | 面板文案不撑宽 | `#hud-root` 的 helpEl `scrollWidth ≤ 330`、`clientWidth === 330` |

断言口径注意（写用例时必须遵守）：

- **不用 `page.keyboard.down()` 之外的伪造方式**；E2E 里读的是 `window.__MC_GAME__`（暴露
  `player`/`physics`）。键盘事件通过 `page.keyboard.press('KeyF')` → 真实 keydown/keyup；
- **起飞前必须等玩家站定**（`physics.onGround`）—— 出生点在城市中心，加载期间物理尚未收敛，
  直接按 F 会量到一段自由落体的干扰；
- **水平速度比用例要固定 yaw**（`player.yaw = -Math.PI/2` 使前进沿 +X），并**避开地形**：起飞高度
  取 ≥ 30 格（地面以上），否则撞树/撞建筑会把位移压到 0；
- 该 spec 不量帧时、不量 draw call → 不需要 `setShadowsEnabled(false)` 隔离，但**必须隐藏 HUD**
  才能截图类断言（本 spec 无像素断言，不需要）。

### 5.3 负向验证（每条都必须让对应用例真 FAIL，否则说明断言没落在被测变量上）

| 注入 | 期望 FAIL 的用例 |
|---|---|
N1 | `step()` 飞行分支里删掉「跳过重力」→ 玩家飞行中继续下落 | P1 |
N2 | 删掉 `_stepFlying` 的 `this.onGround = false;` 那一行 | P4 |
N3 | `FLY_SPEED_MULT` 改成 1 | P5、E4 |
N4 | 删掉 `_tryStepUp` 的飞行门控 | P6 |
N5 | 去掉 `!e.repeat` | K2 |
N6 | `_applyInput` 飞行分支写成 `up + down` | K5 |
N7 | 只把 `flying` 画在 `player.js` 而不改 `physics.step` | E1（起飞后仍被重力拉回） |

## 6. 风险与偏离

- **偏离原版（用户裁定，有意）**：切换键 F 单击（原版双击空格）；无 Ctrl 加速档；水平速度 2× 走路
  （原版是 2.5× 且绝对值 10.92 —— 本仓 `SPEED` 基数不同，直接套倍率会到 20 格/秒）。
- **垂直速度 8 格/秒是初值**，不是推导值。实玩后可能标定（同 `BOB.intensity`、`SHADOW` 的历史：
  先给一档、按反馈调、把实测与裁定理由写回注释）。
- **与矿车的交互是新增的语义**：原版「进矿车不解除飞行」在飞行被物理步跳过的本仓库会生产「状态
  在飞、视觉在车上」的分裂 → 采用「乘坐期 F 无效」。这是**有意偏离**，须在本条与验收报告里各记一次。
- **飞行中不会掉进未加载的 column**：世界加载半径 = `(viewDistance+2)×16`，飞行速度 16 格/秒与
  奔跑 8 格/秒同量级 —— 视距 2（加载 64 格）下 4 秒飞到边缘。「走到边界外」的现象与奔跑一致
  （既有行为，`Scheduler` 的径向加载负责追上），**本次不做额外限速**。若实玩出现「飞着飞着掉出
  世界」，再单独评估。

## 7. 实施影响面（文件清单）

| 文件 | 改动 |
|---|---|
| `src/player/physics.js` | 新增 `FLY_SPEED_MULT` / `FLY_VERTICAL_SPEED`（均 `export`，供测试与将来标定读同一份权威）；`flying` 字段；`toggleFlight()` / `moveVertical()` / `_stepFlying()`；`step()` 分支；`move()` 速度选择；`jump()` / `_tryStepUp()` 飞行早退 |
| `src/player/player.js` | `onKeyDown` 加 KeyF（带 `!e.repeat` + 乘坐期门控）；`_applyInput()` 加飞行垂直分支 |
| `src/core/perf-hud.js` | `HELP_LINES` 加一行（实测宽度） |
| `src/tests/test-physics.js` | P1~P8 |
| `src/tests/test-player-input.js` | K1~K6 |
| `tests/player-flight.spec.mjs` | 新增 E1~E5 |
| `docs/phase-1-engine-design.md` | §4.4 增补飞行小节 + 修订说明一条（版本号由实施时递增） |
| `docs/roadmap.md` | 版本表新增一行（v1.81 或实施时确定） |
| `CLAUDE.md` | 「活跃约束」增补飞行段（常量口径、`wasDown` 判据、`onGround` 清零与晃动的耦合、面板宽度实测要求） |
