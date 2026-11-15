# 焰魔攻击特效：地面火焰法阵 + 碎石爆散（B + D）

> **v3.04b 追加裁定（2026-11-15 用户实玩后）—— 以本节为准，下文 §3.3/§5 的旧参数已被它取代：**
>
> 用户原话①「这个特效的起始距离焰魔的身体有点远，如果玩家在跟焰魔对打的时候，这个特效的
> 圆圈就生成在了玩家的身后的地面，看不到了，我希望让第一个圆圈就在焰魔的脚底下的位置」；
> ②「碎石圆环的面积也有点太小了，把碎石圆环的面积扩大一倍」。
>
> | 参数 | v3.04（旧） | **v3.04b（现行）** |
> |---|---|---|
> | `FLAME_SIGIL.firstOffset` | 2（首段 8.5 格） | **0**（首段就在脚底） |
> | 四段距离 | 8.5 / 12.75 / 17 / 21.25 | **0 / 4.25 / 8.5 / 12.75** |
> | `IGNIS_SMASH_DEBRIS.radius` | 1.3（直径 2.6） | **2.6**（直径 **5.2**） |
>
> **v3.04c 再追加（同日，用户：碎石「不够厉害」）**：原话「碎石的方块有点过于小，震动起来的
> 幅度也不高，感觉不厉害，就好像一圈小石子蹦起来一样，每次动画方块数量增加50%，
> 方块大小增加两倍。方块跳起的高度增加两倍。」
>
> | 参数 | v3.04b | **v3.04c（现行）** |
> |---|---|---|
> | `count` | 28 | **42**（+50%） |
> | `size` | [0.14, 0.24] | **[0.28, 0.48]**（×2） |
> | `speed` | [1.2, 2.6] | **[1.697, 3.677]**（×√2） |
>
> ⚠️⚠️ **「高度增加两倍」= 峰高 ×2 ⇒ speed ×√2，不是 speed ×2**：
> `debrisOffset` 竖直项是 `vy·t − ½·g·t²` ⇒ 峰高 **`h = vy²/(2g)`**，h 与 vy 是**平方**关系；
> 直接 speed ×2 会让高度变 **4 倍**。`DEBRIS_GRAVITY = 18` 与枪击/死亡爆散**共享**，
> 不得为本招改它（否则枪击手感一起变）。
> 实测：峰高 0.18778 → **0.37556 格**（比 **2.00002**）；到峰 0.204s < 缩零起点 0.484s。
> 池容量：42 + 死亡爆散 32 = **74 ≤ 128** ✓。
>
> **观感复核（几何口径）**：最大抬升 **0.5708 格**（lift 0.3 + 峰高 0.271）vs 块边长 **0.478**
> ⇒ 抬升/边长 **1.194**，方块跳得比自身更高、不是贴地。
> ⚠️ 第一版像素探针（颜色阈值定 bbox）**无判别力**（三档 spanY 全是 410 = 整个 clip 高度），
> 已改用**实例矩阵的世界 y**。
>
> **为什么首段必须在脚底**：焰魔站定环是 **4.25~5.0 格**（`IGNIS_AI.standoffRange`，
> 用户裁定「不动如山」），旧首段 8.5 格 ⇒ **四段全在玩家身后** ⇒ 对打时一个也看不到。
> 改后首段在焰魔脚下（玩家正对着它），后退时后续段依次进入视野。
>
> **「面积扩大一倍」的口径取舍（我的调用）**：取**半径 ×2**（1.3→2.6）而不是字面面积 ×2
> （那使半径只 ×√2≈1.84、直径 3.68 格，观感变化很小，不符「太小了」的诉求）。
> 连带：环最近点到脚底 `2.75−2.6=0.15` 格（几乎贴脚）、最远 5.35 格，与①同向。
>
> **Tier 4 阈值重标（实测，非放宽）**：首段落到脚底后落点分布变化（ys=[-1,8,0,1]）
> ⇒ 法阵帧 2885~2889 → **2497**（Δ 2333→1943），基线仍 **554**（零噪声）；
> 下界 noiseFloor+1200 → **+900**。另新增两条真实消费路径判据：
> `firstSegmentDist < 0.01`（实测 **0**）与 `debrisRadius === 2.6`。

## 1. 意图与由来

焰魔四招（`swing` / `spin` / `shieldSmash` / `shieldBash`）移植时按用户裁定③「只扣血」，
把原版的**全部打击反馈**去掉了（`src/entities/ignis/ignis-config.js` 各招注释明确列出了被去掉的项）。
后果在 2026-11-14 实玩中现形：持盾冲撞那一下零反馈，用户读作「类似头部撞击的动作，而不是盾牌攻击」。

本轮补回其中两项，让「砸中了」在画面上成立。

**用户裁定（2026-11-15 本轮对话）**：
- **只做 B（地面火焰法阵）+ D（碎石爆散）**；
- **A（震屏）不做** —— 用户原话「不做震屏，只做 B+D」。与本仓既有取向一致
  （`BOB.rollAmount ≡ 0`，`src/tests/test-view-bob.js` 断言「地平线必须水平」）。
  **本轮不得碰相机**（`src/player/player.js` 的 `camera.position.set` / `rotateX` / `rotateZ` 一行不改）。
- **默认打开，不加设置面板开关** —— 与既有枪击碎块 / TNT 爆炸特效同口径（它们也没有开关）。

## 2. 目标 / 非目标 / 反目标

**目标**
- 举盾砸击（`shieldBash`）命中帧沿正前方铺出一串递延点亮的地面火焰法阵（原版 8 段，本轮取 4 段）。
- 持盾冲撞（`shieldSmash`）与举盾砸击命中帧在**前方地面环心**炸出一圈碎石，
  颜色取自**该环心脚下那一格方块**。
- 两项都**不受命中判定的新鲜视线复查（`freshLos`）影响**，与原版一致。

⚠️ **但不绕过「招式中止门」**（builder check 第 1 条，已核实）：
`ignis-boss-agent.js:326-332` 在命中帧推进块**之前**有一条既有玩法：
```js
} else if (mode === 'attack') {
  if (!losVisible || hDist > IGNIS_AI.disengageRange) {
    mode = 'chase'; attackAnimT = 0; attackKind = null;   // 中断：动画放弃
  }
}
```
玩家在蓄力期间（`shieldBash` 命中帧 1.89s）让 10Hz 缓存 LOS 变假 ⇒ **整招被中止**，
命中帧块根本不跑，特效自然也不播。

**决定（我的调用，不改玩法）**：**保持这条中止门不动**。理由：
① 原版动画是 goal 驱动、**不会**因 LOS 丢失而中止 —— 这条门是**本仓既有偏离**，不是原版语义，
   所以「原版无条件播」的正确对应是「不受命中那一刻的 `freshLos` 复查影响」，而**不是**「招式中止了也要播」；
② 招式被中止 ⇒ 本来就没有「砸中」这件事，播法阵反而误导；
③ 改它就是改状态机/玩法，与本轮「伤害路径一个字不改」冲突，超出用户批准的范围。

**因此 §2 反目标「玩家躲开时看不到 Boss 大招的规模」的准确含义是**：
*玩家躲开「命中判定」*（侧移出锥、隔墙、`freshLos` 失败）时特效**仍播**；
而*玩家躲开「整招」*（蓄力期间让缓存 LOS 变假 ⇒ 招式中止）时特效**不播**（因为招式本身没发生）。

**非目标**
- 不做震屏（A）、剑尖拖焰（C）、球形火焰爆发（E）、常驻烟/魂火（G）。
- 不引入原版法阵的**伤害**与**燃烧 debuff**（`Flame_Strike_Entity.damage()` / `EFFECTBLAZING_BRAND`）——
  本轮是纯视觉，沿用裁定③「只扣血」的伤害口径，四招伤害仍走 `IGNIS.attackDamage`。
- 不改任何招式数值（射程/锥角/命中帧/时长/权重一律不动）。
- 不新增方块、不新增美术资源（法阵贴图是 mod 既有素材**逐字节拷入**，不是新画的）。

**反目标（做成了也算失败）**
- 碰相机 → 违反本轮裁定。
- 新开第二个碎块池 → 违反红线 1 与「不绕过统一管线新开子系统」自检。
- 特效只在「打中玩家」时才播 → 与原版不符，且玩家躲开时看不到 Boss 大招的规模。
- 常驻 draw call 增长（零活跃时必须 `visible=false`）。

## 3. 现状与约束（已核实）

### 3.1 可复用的基建（四套池，全部已在 `game.js` 装配）

| 池 | 文件 | 手法 | 本轮用途 |
|---|---|---|---|
| 碎块 | `src/render/block-hit-fx.js` | InstancedMesh + `setColorAt`，容量 128，FIFO | **D 直接复用** |
| additive billboard | `src/render/fireball-renderer.js` | InstancedMesh + AdditiveBlending + `depthWrite:false` | **B 照此手法新建**（几何朝向不同，见 §5.1） |
| 序列帧 Sprite | `src/render/explosion-sprite.js` | 10 × Sprite + `texture.offset` | 不用 |
| 球体扩张 | `src/render/explosion-renderer.js` | InstancedMesh 球 | 不用 |

碎块池已有的可复用纯函数（**不重写抽样数学**）：
`createDebrisSeeds(profile, normal, rand, count)` / `debrisOffset` / `debrisSizeAt` / `debrisSpinAngle`。
`spawnDeathBurst(position, colorRgb, nowMs, {burst})` 是「一簇碎块」的现成入口，
D 需要的是**沿弧线分布的多簇**，故新增一个薄方法复用它（见 §5.2）。

### 3.2 触发点：`attackRequest` 不可用作特效触发（关键约束）

`src/entities/bosses/ignis-boss-agent.js:729-731`：

```js
const freshLos = player !== null && this._queryLos([px, py, pz], ctx);
if (freshLos) {
  attackRequest = { at: [px, py, pz], yaw, kind: attackKind };
  ...
}
```

⇒ **`attackRequest` 只在有视线时产生**，而原版 `Ignis_Entity.aiStep()` 的特效调用**不看视线**。
若把特效挂在 `_consumeIgnisAttackRequests()` 上，玩家隔墙/躲开时法阵与碎石都不播 —— 违反 §2 目标。

**决策（我的调用）**：在 Agent 里新增一个与 `attackRequest` 并列的瞬态字段
`attackFxRequest = { at, yaw, kind }`，在**越过命中帧的那一帧无条件产生**（不进 LOS 分支）。
- 与 `attackRequest` 同样**不进 snapshot**、下一帧自动清 `null`（沿用既有瞬态口径）。
- 伤害路径一个字不改 ⇒ 裁定③的伤害语义零回归。
- ⚠️ 必须在 `createState` 里显式保留/透传（`ignis-system.js`），
  否则每帧被重置（同 `_physAccum` / `spinCooldown` 的既有教训）。

### 3.3 原版数值（本轮取用的部分，逐条核实过行号）

**B 法阵** —— `Ignis_Entity.java:1302-1327`（`ULTIMATE_ATTACK`，tick 74）：
```java
for (int l = 0; l < 8; ++l) {
    double d2 = 4.25D * (l + 2);        // 距离 8.5, 12.75, ... 38.25
    int j2 = (int)(1.5F * l);           // 延迟 tick 0,1,3,4,6,7,9,10
    spawnFlameStrike(x + f1*d2, z + f2*d2, d0, d1, f0, 60, j2, j2, 2.0f, false);
}
```
- `radius = 2.0`、`duration = 60` tick = **3.0s**、`wait = delay = j2` tick。
- 方向 `f1 = cos(yaw+90°)`, `f2 = sin(yaw+90°)`（原版 yaw 口径，本仓需换算，见 §5.1）。
- 落点 y：`spawnFlameStrike`（`:2163-2189`）从 `maxY` 向下扫到第一个「上表面坚实」的方块，
  取其顶面 y；扫到 `minY - 1` 仍无地面则**不生成**。
  ⚠️ **扫描窗口口径（builder check 第 4 条，本轮明确定义）**：
  原版 `maxY = max(target.y, self.y) + 1.0`、`minY = min(target.y, self.y)`。
  本仓取 **`maxY = 焰魔脚底 y + 4`**（从 Boss 上方起扫，而不是从脚底起扫）、
  **`minY = 焰魔脚底 y − 8`**（向下最多扫 12 格）。
  理由：从脚底起扫会在**前方有凸起地形**时扫进山体内部（脚底高度已低于前方地表），
  把法阵放进方块里；从上方起扫才能命中凸起地表。
  **未加载列兜底**：`world.getBlockId` 对未加载列恒返 0（air，`world-data.js:26`）
  ⇒ 扫完窗口无地面时**跳过该段**（不生成），与原版「`flag` 为假则不生成」同语义。
  **不得**回落到世界底 bedrock 或 y=0（那会在空中/地底凭空出一个法阵）。
- 渲染（`RendererFlame_Strike.java`）：**单个 quad**，基准顶点是 `(±1, 0, ±1)` ⇒ **基准就是 2×2**，
  再 `scale(radius)` ⇒ `radius=2.0` 时实际 **4×4 格**。
  ⚠️ **builder check 第 3 条已纠正：本仓 `PlaneGeometry` 必须用 `(2,2)` 而不是 `(1,1)`**
  （用 `(1,1)` + scale 2.0 只得 2×2，**尺寸差一倍**，Tier 4 的像素占比上下界会标错）。
  段间距 4.25 > 直径 4 ⇒ 相邻法阵**略有间隙**（不是相接），与原版一致。
  绕 Y 旋转 `90 − yRot + tickCount`（**每 tick 转 1°**），贴图 `flame_strike_sigil.png`，
  additive 发光（`getGlowingEffect`），`isSee()` 为假时**不画**。
- `isSee` 在 `tickCount >= warmupDelayTicks` 后为真（`Flame_Strike_Entity.java:150-152`）
  ⇒ **延迟期内法阵不可见**，这正是「一串递延点亮」的来源。

⚠️ **距离取舍（我的调用）**：原版最远 38.25 格，远超本仓 `shieldBash.hitRange = 6.5`。
原版 ULTIMATE 的伤害也确实铺到 38 格（`UltimateAttack(l, ...)` 的 `l` 到 37），
但本仓裁定③已把 AoE 全部去掉 ⇒ 38 格外纯视觉法阵在 8 视距下大量落在未加载区、且玩家看不见。
**取 `4.25 × (l+2)` 的原版间距，但段数由 8 降到 4**（8.5 / 12.75 / 17 / 21.25 格）。
理由：保住「一路砸过去」的递延推进观感，最远 21.25 格仍在默认视距 8 区块（128 格）内且肉眼可辨。
这是**观感旋钮**，不是原版语义改动；若用户要 8 段，改一个常量即可。

**D 碎石** —— `Ignis_Entity.java:1665-1690`（`ShieldSmashparticle`）：
- `80 + random.nextInt(12)` 个 `BlockParticleOption`（取 `hit.below()` 的方块贴图）。
- 分布（⚠️ builder check 第 2 条已纠正，**是「前方环心 + 整圆」，不是「脚下弧形」**）：
  ```java
  float angle  = (0.01745329251F * yBodyRot) + i1;      // i1 直接当弧度 ⇒ 绕约 12.7 圈
  double extraX = radius * sin(PI + angle);              // = −radius·sin(angle)
  double extraZ = radius * cos(angle);
  // 环心 = 身体 + 正前方×vec + 侧向偏移×math
  addParticle(getX() + vec*vecX + extraX + f*math, getY() + 0.3, getZ() + vec*vecZ + extraZ + f1*math)
  ```
  ⇒ **环心前移 `vec`（=2.75）**，环上是半径 `radius`（=1.3）的**整圆**；
  `i1` 当弧度绕多圈只是「密度不均的圆环采样」，整体形状是圆环。
  **Tier 1 的环断言圆心必须是「前移后的环心」，不是脚底**（以脚底为圆心写会恒红）。
- 初速：三轴各 `nextGaussian() × 0.07`（很小 —— 是「原地溅起」不是「四散飞射」）。
- 调用点：`shieldSmash` tick 34 → `(radius 1.3, vec 2.75, math −0.1)`（`:889`）；
  `shieldBash` 走 `UltimateAttack`，其碎石由 `Cm_Falling_Block_Entity` 掀飞石承担，
  **本轮给 `shieldBash` 也用 `ShieldSmashparticle` 同口径**（我的调用：两招观感一致，
  且 `Cm_Falling_Block_Entity` 是真实体方块，移植它等于改玩法，超出本轮范围）。

⚠️ **密度取舍（我的调用）**：原版 80~92 粒会吃掉碎块池 128 的 62~72%，与枪击碎块并发时互相覆盖
（FIFO 绕回，观感「只炸出半边」—— `DEATH_BURST` 注释已记过这个坑）。
**取 28 块**（约原版 1/3），仍在池容量安全区（28 + 焰魔死亡爆散 32 = 60 < 128）。

### 3.4 其它约束

- **素材落位**：`assets/ignis/src/` 下的 4 个文件被 `ignisInputFingerprint()` **逐个列举**哈希
  （`tools/ignis-fingerprint.mjs:368-380`，不是目录扫描）⇒ 往该目录加文件**不会**动指纹。
  但为语义清晰，法阵贴图放 **`assets/ignis/flame_sigil.png`**（产物同级，非烘焙输入）。

  **现状（已完成，本轮对话内做的）**：已从 mod 逐字节拷入，实测确认：
  · 源 = `cataclysm1.19.2modding/src/main/resources/assets/cataclysm/textures/entity/flame_strike_sigil.png`；
  · **3114 字节**，`Buffer.equals` 逐字节比对源文件 = **true**（未转码、未重编码）；
  · sha256 = `adc9d07f88cf031c9cacb1917a92cb8f34020dd68d6c4523eeae6b18d33a26e6`；
  · `git status` 显示 `?? assets/ignis/flame_sigil.png`（新增未跟踪）。

  ⚠️ **builder check 第 5 条声称「已存在、256²」是错的**：实测为 **128×128**，
  且是本轮刚拷入的（不是仓库原有）。哈希基准的权威来源就是上面那个 mod 源路径，
  已用逐字节比对确认 ⇒ `check:data` 直接冻结该 sha256（拷入素材，不是烘焙产物 ⇒ 不需重烘指纹）。
- **资源 URL** 一律走 `resourceUrl()`（`src/core/resource-url.js`），禁止 `'/assets/`。
- **时间基准** `performance.now()`，禁止 `Date.now()`。
- **零分配**：每帧临时矩阵/向量用模块级常量。
- **零活跃 `visible=false`**：否则恒增 draw call 且进透明排序列表（会干扰水面绘制顺序不变式）。
- 新渲染器归属 `src/render/`（不在 `ISOMORPHIC_DIRS`）⇒ 可 import three。
  **不得**在 `src/entities/` 侧 import three。
- `src/tests/test-*.js` 必须同时注册进 `src/tests/index.html`（漏注册 = 静默不跑）。

## 4. 方案取舍（Approaches）

### B 法阵的三条路

1. **照搬原版：单 quad + additive + 每 tick 转 1°**（选中）
   与原版渲染逐行对应，素材直接用，成本 ~150 行。缺点：quad 是平面，从侧面看会「压扁」——
   但原版就是这样，且法阵本就贴地。
2. 用 `explosion-sprite.js` 的 Sprite 池
   Sprite 恒面向相机 ⇒ 贴地法阵会「立起来」跟着镜头转，与原版语义不符。**否决**。
3. 程序化 canvas 画符文（不引入素材）
   省去素材入库，但等于**新画美术资源**，且与原版图案不一致。**否决**（用户对「烘焙 ≠ 新美术」敏感）。

### D 碎石的三条路

1. **复用 `block-hit-fx` 碎块池，新增一个沿前方圆环撒多簇的薄方法**（选中）
   零新池、零新抽样数学，~60 行。
2. 新建独立「碎石」渲染器
   违反红线 1 与自检第 4 问（绕过统一管线新开子系统）。**否决**。
3. 用 `explosion-renderer` 球体扩张代替
   那是「爆炸闪光」不是「碎石」，观感不符。**否决**。

### 触发点的两条路

1. **Agent 新增 `attackFxRequest` 瞬态字段，在命中帧不受 `freshLos` 影响**（选中）
   与原版一致（原版特效不看视线），伤害路径零改动。代价：多一个瞬态字段要在 `createState` 透传。
   ⚠️ **不改既有的招式中止门**（§2）—— 那是本仓玩法，不在本轮范围。
2. 复用 `attackRequest`
   零新字段，但**只在有视线时播** ⇒ 违反 §2 目标。**否决**。

## 5. 设计

### 5.1 新文件 `src/render/flame-sigil.js`

- 常量 `FLAME_SIGIL`（冻结）：`radius 2.0`、`lifeMs 3000`、`segments 4`、
  `spacing 4.25`、`firstOffset 2`（⇒ 距离 `spacing×(l+firstOffset)`）、
  `delayPerSegmentTicks 1.5`（原版 `j2 = (int)(1.5F*l)`，见下）、`spinDegPerSec 20`（= 每 tick 1° × 20）、
  `maxActive 16`（4 段 × 并发 4 招余量）、`yLift 0.02`（原版 0.001 太小会 z-fighting，见下）。
  ⚠️ **延迟取原版截断序列**（builder check 第 6 条）：`delayTicks = Math.floor(1.5 * l)`
  ⇒ tick `0,1,3,4` ⇒ ms `0,50,150,200`。**不用线性 `l×75ms`**（那会得 `0,75,150,225`，与原版不符）。
- 纯函数（可单测、无 three）：
  - `sigilSpawnPoints(at, yaw, cfg)` → 4 个 `{x, z, delayMs}`；
    **yaw 换算**：本仓 yaw 口径「指向玩家 = atan2(−dx, −dz)」，正前方向 = `(−sin yaw, −cos yaw)`
    （已核实：`dragon-boss-agent.js:127-128` 的移动方向就是它）。
    ⚠️ 这是本仓口径，**不照抄原版 `cos(yaw+90°)`**（原版 yaw 定义不同，照抄会整体偏 90°）。
  - `sigilRotationRad(ageMs, cfg)` → 旋转角。
  - `sigilOpacityAt(ageMs, delayMs, cfg)` → `{opacity, visible, done}`；
    **延迟期内 `visible:false`**（原版 `isSee`），之后立刻满亮、末段淡出。
- `FlameSigilRenderer`：InstancedMesh(**`PlaneGeometry(2,2)`** 旋转成水平，additive，`depthWrite:false`，
  `DoubleSide`)，容量 `maxActive`；实例 scale = `radius` ⇒ 实际 **4×4 格**（与原版一致，
  原版基准 quad 顶点是 `±1` ⇒ 2×2）。
  `spawn(at, yaw, nowMs)` 一次入 4 段；`update(nowMs)`；`dispose()`。
- **地面查找**：`spawn` 接收调用方算好的 y（渲染层不查体素 —— 保持 render 层无 world 依赖，
  与 `block-hit-fx` 同口径）。y 由 `game.js` 侧用 `world.isSolid` 向下扫得到（复用 §3.3 语义）。
- ⚠️ `yLift` 取 0.02 而非原版 0.001：本仓相机 near=0.1、far≈200，深度精度下 0.001 会与地面共面闪烁。
  这是本仓标定值，Tier 4 像素实测钉住「不闪」。

### 5.2 `src/render/block-hit-fx.js` 新增

- 常量 `IGNIS_SMASH_DEBRIS`（冻结）：`count 28`、`radius 1.3`、`forward 2.75`、
  `lateral −0.1`（原版 `math`）、`size [0.14, 0.24]`、`speed [1.2, 2.6]`、`spin [4, 10]`、`lift 0.3`。
  （`speed` 比枪击碎块低 —— 原版初速 `gaussian×0.07` 是「原地溅起」。）
- 纯函数 `smashDebrisRing(at, yaw, cfg, rand)` → 28 个 `{position, normal}`：
  **环心 = `at` + 正前方×`forward` + 侧向×`lateral`**，环上半径 `radius` 的**整圆**：
  `angle = yaw + i`（i 当弧度，同原版）、`position = 环心 + (−radius·sin angle, lift, radius·cos angle)`；
  `normal` 取 `[0,1,0]`（向上溅起）。
  ⚠️ **名字用 Ring 不用 Arc**：它是圆环不是扇弧（builder check 第 2 条）。
  `forward` **不是死字段** —— 它就是环心的前移量。
- 方法 `spawnSmashRing(at, yaw, colorRgb, nowMs, {rand, cfg})`：
  逐点复用现有 `_spawnDebris(origin, normal, profile, color, rand, count=1, nowMs, dust=false)`。
  **不新建池、不改 `IMPACT_FX.debris.maxActive`**。

### 5.3 接线（`src/core/game.js`）

- 装配 `this.flameSigil = new FlameSigilRenderer({scene, texture})`，
  贴图 `resourceUrl('assets/ignis/flame_sigil.png')`，加载失败则**不阻断启动**（同爆炸图集容错）。
- `update` 链里加 `this.flameSigil.update(nowMs)`（紧邻 `blockHitFx.update`）。
- `dispose()` 里加 `this.flameSigil?.dispose()`。
- 新方法 `_consumeIgnisFxRequests()`：读 `attackFxRequest`，
  - `kind === 'shieldBash'` → 法阵 4 段（逐段查地面 y）+ 碎石圆环；
  - `kind === 'shieldSmash'` → 只碎石圆环；
  - `swing` / `spin` → 本轮不加（原版这两招的特效是剑尖拖焰 C，未选）。
  - 常态零分配门控：`entities.count(IGNIS_TYPE) === 0` 直接返回（同既有两个 `_consume*`）。
- 碎石颜色：取**环心脚下那一格**的 `blockNameOf` + `colorResolver`
  （已注入 `blockHitFx`，复用同一份权威；原版取的也是 `hit.below()` 而不是 Boss 脚下）。

### 5.4 Agent / state

- `ignis-boss-agent.js`：命中帧内、**`freshLos` 判定之外**产生 `attackFxRequest`；返回值带上它。
  ⚠️ 既有的招式中止门（`:326-332`）**一行不改**（§2）。
- `ignis-system.js`：`createState` 增 `attackFxRequest`（缺省 `null`，非法回落 `null`）；
  snapshot **不含**它（瞬态，同 `attackRequest`）。

## 6. 验证

**Tier 1（必须 TDD，RED→GREEN）** —— 新增 `src/tests/test-flame-sigil.js`
+ 扩 `src/tests/test-block-hit-fx.js` + 扩 `src/tests/test-ignis-boss-agent.js`：
- 法阵 4 段的距离 = `4.25×(l+2)`、方向沿**本仓** yaw 正前方（用已知 yaw 算期望点，不照抄原版公式）；
- **实例 scale = `radius` 且基准几何边长 = 2** ⇒ 实际 4×4 格（builder check 第 3 条的回归判据）；
- 延迟序列 = `floor(1.5l)×50ms` ⇒ `0,50,150,200`（不是线性 `0,75,150,225`）；
- 延迟期内 `visible=false`、延迟后 `visible=true`、寿命末 `done=true`；
- 旋转角随时间单调增；
- 碎石 28 块、**全部在「前移 `forward` 后的环心」为圆心、半径 `radius` 的圆上**
  （以脚底为圆心写会恒红 —— builder check 第 2 条）、`count ≤ 池容量`；
- **`attackFxRequest` 在 `freshLos` 失败时仍产生，而 `attackRequest` 不产生**
  （本轮核心约束的判据）；另钉一条：**招式被中止（缓存 LOS 丢）时两者都不产生**
  （防止实施时误改中止门）；
- 地面扫描：凸起地形下法阵贴**凸起**顶面而不是山体内；未加载列（全 air）**跳过该段**；
- 零活跃时 `mesh.visible === false`。
- 全部新 test 注册进 `src/tests/index.html`。

**Tier 4（像素实测，不得目视宣称）** —— 新增 `tests/ignis-fx.spec.mjs`：
- **颜色判据的实测依据**（已读贴图像素）：`flame_sigil.png` 128×128，非透明像素 3876/16384，
  均值 RGB **222.7 / 179.9 / 51.6**，alpha **全为 255**（无半透明边缘）。
  ⇒ 判据取 **`r > g && r − b > 100`**（金黄符文），并带对照组校准：
  沙漠沙（`sand_side` 193,183,144）的 `r − b = 49` ⇒ **被排除**，不会「只是沙漠」也命中。
  （同废弃堡垒 v2.89 的教训：像素颜色判据必须带对照组，否则失去判别力。）
- 法阵：命中帧后截图，断言目标区域**上述金黄像素占比**显著高于对照帧，**同时钉上下界**
  （只钉「变亮」抓不到「烧成白团」）；先测同状态重复截图的噪声底。
- 碎石：断言碎块池 `activeDebrisCount > 0` 且截图像素与对照帧有差。
- draw call：零活跃时与基线相同（`visible=false` 生效）。
- ⚠️ WebGPU canvas 像素回读必须在 `renderer.render()` **之后**；逐帧读像素要在 rAF 回调内。
- ⚠️ Playwright 必须 `channel: 'chromium'`（默认 headless shell 拿不到 WebGPU adapter）。

**门禁**：`npm run check`（arch + data + lint）+ 上述 spec。
不改热路径（mesher/materials/render-world/scheduler/physics 均不动）⇒ 按 testing-policy **不需要** `bench --check`。
⚠️ 新增 additive 透明池会进透明排序列表 ⇒ 跑 `tests/water-order.spec.mjs` 确认水面顺序不变式未破。
**已核实该 spec 的实际判据**（`tests/water-order.spec.mjs:60-96`）：它把非水对象归为 `'other'`
并在断言前 `filter(n => n !== 'other')` 过滤掉 ⇒ **新池入列本身不会让它变红**，
它只钉「voxelWater 先于 ocean 且全周恒定」。所以这条是**回归确认**，不是「新池必然触发」的门；
真正的风险是排序锚点交叉（新池锚点在世界原点附近，与体素水合并几何的锚点同区）。
零活跃 `visible=false` 正是消除该风险的手段（`explosion-renderer.js` 文件头记过同一实测教训）。

## 7. 留给实施者的决定

- `yLift` / `spinDegPerSec` / 碎石 `size`·`speed` 的**具体观感值**可实玩微调（都是标定旋钮，非原版语义）。
- 法阵段数若实玩觉得短，改 `FLAME_SIGIL.segments`（4 → 8 即回到原版全距）。
- 若 additive 法阵在亮沙漠背景下过曝，调 `opacity` 包络而不是改混合模式（改模式会破「发光」语义）。

## 8. 本轮明确不做

震屏（A）、剑尖拖焰（C）、球形爆发（E）、常驻烟（G）、法阵伤害与燃烧 debuff、
`Cm_Falling_Block_Entity` 真实掀飞石、任何招式数值改动、任何相机改动、设置面板开关。