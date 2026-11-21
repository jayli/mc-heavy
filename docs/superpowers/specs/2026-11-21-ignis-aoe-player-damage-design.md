# 焰魔 AoE 对玩家伤害 + 血量翻倍 + 受伤红闪（设计稿）

日期：2026-11-21
状态：待用户批准
范围：焰魔（Ignis）的三处攻击判定、玩家血量上限、血心 HUD、受伤红闪覆盖层

## 1. 意图与「为什么」

用户原文（2026-11-21）：

> 我希望增加一个功能，就是焰魔攻击对玩家的伤害范围，比如头部撞击攻击脚底的火焰波只要碰到玩家，
> 玩家就掉血，掉 1 格血。剑阵攻击的剑阵刺到玩家，玩家也掉 1 格血，法阵的图案如果在玩家脚底生成，
> 玩家也掉 1 格血。同时，玩家的血量默认在增加一倍，页面上方有玩家的血条一排小心心图案，
> 向右数量增加一倍。玩家如果受到攻击时，屏幕四周闪现一下掉血的动画……40 像素的从半透明红到
> 全透明红的渐变……现在的设定是玩家血量掉完也不死，这个设定不变，但如果血量掉完，受到攻击时
> 也显示这个掉血的动画。

目标：让焰魔的战斗「每一次攻击都在画面上留下代价」，而不是只有挥砍那一下扣血。玩家从 20 格血
翻到 40 格，是因为新增了两处小额伤害源 —— 若不翻倍，1 格伤害在 20 格血上读不出分量。

## 2. 现状（实测读码，不是推测）

| 事实 | 所在位置 |
|---|---|
| 玩家满血 **20 格 = 10 颗心**，每颗心 2 格；半颗心 = 1 格 | `src/player/health.js` 的 `PLAYER_MAX_HEALTH` / `PLAYER_MAX_HEARTS` |
| 血量换算 `heartsFor()` 是纯函数，渲染层只消费它的输出 | `src/player/health.js:52` / `src/ui/health-hud.js:_paint` |
| 伤害唯一入口 `_damagePlayer(amount)`：`applyDamage` → 写 `player.health` → 血真的变了才播 `ignis_hurt` | `src/core/game.js:4249` |
| 焰魔挥砍/旋斩/**持盾冲撞（用户口语「头部撞击」）**/举盾砸击/剑阵刀砍 全部 = `IGNIS.attackDamage = 14` | `ignis-config.js` + `game.js:4069` |
| **扩散火圈 = 纯视觉零伤害**（用户 2026-11-20 裁定） | `src/render/fire-ring-renderer.js` |
| **法阵 = 纯视觉零伤害**（v3.04 用户裁定③「只扣血」时的遗留） | `src/render/flame-sigil.js` 文件头 |
| 剑阵尖刺 = **18 格**（`IGNIS_SPIKE.damage`），AABB 与任一格刺重叠就扣一次并 break | `game.js:4146` |
| 尖刺落点 = 焰魔正前方五向各 6 根，半径 2/4/6/8/10/12 格 —— **玩家脚下没有刺** | `spike-fx.js:spikeSpawnPoints` |
| 法阵落点 = 焰魔前方 4.25/8.5/12.75 格 + **焰魔自己脚下**那一段 | `flame-sigil.js:sigilSpawnPoints` |
| 屏幕四周红闪**不存在**（没有任何 vignette / damage flash 实现） | 全仓 grep 无 |
| **丧尸、TNT、飞龙火球目前都不扣玩家血** —— `_damagePlayer` 只有三处调用点（焰魔、尖刺、守卫） | `grep -rn "_damagePlayer" src/` |

## 3. 已由用户裁定的决定（本次对话）

1. **新增的伤害只给「剑阵刺到」与「法阵压在脚底」两处，各 1 格**；挥砍 / 旋斩 / 头部撞击 / 举盾砸击 /
   剑阵的刀砍仍扣 14。⇒ 不是「焰魔所有攻击统一 1 格」。
2. **扩散火圈保持纯视觉，不加伤害** （用户原话：「为了简单起见，火圈扫到玩家不掉血了，火圈纯粹是一个
   视觉特效来对待」）。这一条**推翻**了本轮早些时候「跟随火圈外推的环带」的口头选择。
3. **红闪在玩家掉任何血时都出现**：丧尸、TNT、火球、焰魔、末影守卫、未来新增的伤害源一律覆盖。
   ⚠️ **实际执行范围**：目前只有焰魔与末影守卫会扣玩家血（见 §2）；丧尸/TNT/火球的伤害源本轮**不新增**，
   只是把红闪放在唯一入口，将来它们接入时自动生效。
4. **红闪时长 0.35 秒**，40px 从半透明红线性淡到全透明。
5. **法阵一次攻击最多扣 1 格**（四段共享一次，不是每段各扣）。
6. **血心两排 10+10**，上排沿用现状位置，下排直接叠在它下面（总宽不变，不挤压准心区域）。
7. **红闪用 DOM 覆盖层**，不用 WebGPU 后处理 pass。

## 4. 目标 / 非目标 / 反目标

**目标**

- 玩家站进法阵图案 → 掉 1 格；被剑阵尖刺刺到 → 掉 1 格。
- 玩家满血 40 格，HUD 20 颗心分两排，半颗心仍是 1 格血。
- 任何让血量真的减少的伤害都触发一次屏幕四周红闪。
- 血掉到 0 后**仍然**显示红闪（但不死、不重生、不回血，维持既有裁定）。

**非目标**

- 不改焰魔的 AI、动画、走位、招式概率，不改任何一格 `hitRange` / `hitConeDeg`。
- 不改丧尸 / 守卫 / 龙的伤害数值与判定。
- 不做死亡界面、不做重生、不做回血、不把血量写进存档（维持「重进回满」）。
- 不动扩散火圈的观感参数（本轮只把它文档化地标记为「纯视觉，有裁定出处」）。
- 不做音效新增（受击音仍是既有的 `ignis_hurt`）。

**反目标（技术上做成了但算失败）**

- 玩家能在法阵/尖刺里站着不掉血，或反过来在图案/刺之外也被扣。
- 红闪只在焰魔的某一条伤害路径上出现（守卫打到你时也要闪）。
- 血量翻倍后 HUD 画 20 颗心但排成一排横穿屏幕中心。
- 血降到 0 后红闪停掉（用户明确要求「血量掉完，受到攻击时也显示这个掉血的动画」）。
- 法阵伤害随 `flame_sigil.png` 加载失败而静默消失。

⚠️ **两条不能当验收项的「反目标」**（审稿指正，已核实）：
「丧尸打你时不闪」与「TNT / 火球不闪」**无法当作失败条件** —— 全仓 `_damagePlayer` 只有三处调用点
（焰魔、尖刺、守卫），丧尸/TNT/火球根本不扣玩家血，这类判据既不能红也不能绿。

## 5. 约束

- **红线 1（数据只有一份权威）**：1 格伤害不能在两处各写一个字面量 `1`。落地形态 = 一张
  `IGNIS_AOE` 档案，两个消费方（尖刺结算 / 法阵结算）都读它。
- **红线 8（主线程/Worker 同构层）**：`ignis-config.js` 属同构层，不得 import three / DOM。
  本轮只加纯常量，不越界。
- **Tier 1 TDD**：`applyDamage` / `heartsFor` 的契约是纯函数，改常量与新增红闪包络函数都必须
  先 RED 后 GREEN（`docs/testing-policy.md`）。
- **Tier 4 像素实测**：血心从 10 颗变 20 颗、红闪覆盖层，两者都是「画面上看得见的东西」，
  必须像素级实测，不得目视宣称。
- **UI 层级不等式**（AGENTS.md）：红闪 z-index 必须落进既有不等式且不得取 100+。

## 6. 方案（Approaches）

### A. 剑阵尖刺的伤害归属

| 方案 | 说明 | 取舍 |
|---|---|---|
| **A1（选定）** 改 `IGNIS_SPIKE.damage` 18 → 1 | 结算路径一行未改，只改权威常量 | 最小改动；但「18」是用户 2026-11-21 草图亲口给的数（`test-ignis-system.js:1011` 钉着），改它等于推翻一条旧裁定，必须显式记录 |
| A2 保留 18，另加一路「1 格」判定 | 两套伤害同时生效 | 玩家一次被刺吃 19，读作 bug；且两套判定的「哪根算刺到」口径会漂 |
| A3 只在尖刺阵列里标出一根「轻刺」扣 1 | 部分根轻、部分重 | 无从向玩家传达哪根是轻的，纯属增加不可见规则 |

选 A1：用户本轮的原话是「剑阵攻击的剑阵刺到玩家，玩家也掉 1 格血」，与草图里「伤害 18 点」
直接冲突。按「最新指令覆盖旧裁定」处理，并把旧断言改成新值 + 注明推翻原因。

### B. 法阵伤害的判定

| 方案 | 说明 | 取舍 |
|---|---|---|
| **B1（选定）** 在法阵 **spawn 那一刻**（`_consumeIgnisFxRequests` 的命中帧）**一次性判定全部四段**，命中即扣 1 并 `break` | 无需新状态；`break` 天然满足「一次攻击最多扣 1 格」 | **比第 1 段视觉点亮同步（delay 0），比第 2~4 段早 50/150/200ms**；且「生成之后再走进后面几段」不扣 |
| B2 法阵存活 3 秒期间持续判定 | 玩家走进去也扣 | 变成持续磨血，掉血幅度取决于站多久，与「掉 1 格」的描述不符；还要引入节流 |
| B3 每段各判一次（最多 4 格） | 站得正对焰魔时伤害翻倍 | 用户已明确否掉（选了「每次攻击最多扣 1 格」） |

选 B1。落地：在 `_consumeIgnisFxRequests` 里、`points` 已算好（含 y）之后，逐段判 XZ 矩形重叠：
玩家 AABB 的 x/z 区间与「落点 ± 足迹半宽」相交即算压到，命中即 `break`。

⚠️ **不得追求「逐段在各自点亮时刻判定」**（这是审稿后推翻的第一版写法）。原因：`attackFxRequest`
是**瞬态**，`_consumeIgnisFxRequests` 只在命中帧看得到它，下一帧 Agent 已清空；而四段的点亮延迟
（`sigilDelayMs` = 0/50/150/200ms）由 `flame-sigil.js` 渲染器内部按 `age ≥ delayMs` 判定，**装配层完全看不到**。
要实现「真·点亮即判」得新建一个跨帧追踪器 + 攻击实例标识 + 池覆盖处理，代价等于多一个模块。
用户要的是「图案如果在玩家脚底生成就扣 1 格」——「生成」就是命中帧那一瞬，无需等它画出来。

⚠️⚠️ **法阵伤害必须移出 `!this.flameSigil` 门控**。现有段落是
`if ((req.kind !== 'shieldBash' && req.kind !== 'spin') || !this.flameSigil || !this.world) continue;`
—— 照字面写会把**玩法伤害**挂在「贴图加载成功」上：`flame_sigil.png` 加载失败时 `this.flameSigil` 为 null
（该渲染器文件头明说这是允许的降级），于是伤害静默消失，而单测用 `flameSigil: null` 造壳还会把它读成
「不扣血 = 正常」。⇒ 落点计算与伤害判定只依赖 `world` 与 `player`；`flameSigil?.spawn(...)` 单独
用可选链，渲染器缺席不影响伤害。

### B′. 法阵足迹的尺寸权威（新增小节，审稿后补）

法阵画出来是 **4×4 格**：`FLAME_SIGIL.radius = 2.0` **乘基准几何 2×2**（`flame-sigil.js` 文件头明说
「基准几何必须是 `PlaneGeometry(2,2)`，写成 `(1,1)` 会让实际尺寸只有一半，而所有计数类断言仍全绿」）。

**问题**：`FLAME_SIGIL` 住在 `src/render/`，而 `src/entities/` 在 `tools/check-architecture.mjs:75` 的
`ISOMORPHIC_DIRS` 里 ⇒ `IGNIS_AOE`（住 `ignis-config.js`）**不能 import `FLAME_SIGIL`**；反过来
`render/` 可以 import `entities/`。⇒ 权威只能放一处、另一处派生。

**选法**：足迹权威放 **`IGNIS_AOE.sigilHalfExtent`**（玩法口径，2.0 格半宽 = 4×4），
`flame-sigil.js` 侧**不改**（它已经用 `radius: 2.0` 且乘基准 2）。两边相等由**单测跨层钉住**
（`test-flame-sigil.js` 里 `IGNIS_AOE.sigilHalfExtent === FLAME_SIGIL.radius`），
因为 import 方向不允许，单测是唯一能跨层比对的地方。
⚠️ 不钉这条等式的形态是：将来有人把 `FLAME_SIGIL.radius` 改成 3（画面变成 6×6）
而判定仍是 4×4 —— 所有数值断言全绿，只有「看着像碰到了却没扣血」这种手感抱怨。

⚠️ **相邻两段几乎连成一片**：段间距 `spacing = 4.25`，单段半宽 2.0 ⇒ 相邻段**边隙只有 0.25 格**，
而玩家 AABB 宽 0.6 格（半宽 0.3）⇒ 沿轴线上「站在两段之间且两者都不重叠」**数学上不存在**。
四段实际拼成 4×16.75 的连续走廊，而焰魔站定环 `standoffRange = 5.0` 正落在第 0/1 段上
⇒ `shieldBash` / `spin` 时只要玩家在正面 2.25~14.75 格内，**几乎必定扣这 1 格**。
**这是意图**（用户说「法阵的图案如果在玩家脚底生成，玩家就掉 1 格血」，而图案确实铺在他脚下），
但必须在注释里写明，否则下一个人会当它是缺陷。

## 6.5 方案 C. 血量与血心

| 方案 | 说明 | 取舍 |
|---|---|---|
| **C1（选定）** `PLAYER_MAX_HEALTH 20→40`、`PLAYER_MAX_HEARTS 10→20`，`HEALTH_PER_HEART` 保持 2 | `heartsFor()` 的循环体一行不改，只是长度变 20 | 常量派生关系自洽；`heartsFor` 的边界用例要跟着从 20 扩到 40 |
| C2 每颗心改成代表 4 格血 | 心数不变仍是 10 | 半颗心 = 2 格血，与既有「半颗心 = 1 格」裁定冲突，且和原版口径断开 |

选 C1。布局：**显式两排**（两个 `display:flex` 行，上排 10 颗下排 10 颗）。
不用 `flex-wrap`：它会在容器宽度变化时不可控地重排（第 11 颗跑到上排还是下排取决于父宽）。

HUD 位置：上排 `top:8`，下排 `top:8+18=26`（心高 18px、行间距 0，与现有 `gap:0` 一致）。
`LEFT_PX` 不变（8 + 330 + 8 = 346）。

⚠️ **既有断言要改**：`tests/health-hud.spec.mjs` 有 4 条断言钉死 10 颗 / 20 格
（`count === 10`、`srcs` 长度 10、`hudHearts` 长度 10、`player.health === 20`）。全部改为 20 / 40。

⚠️⚠️ **血量翻倍会连带推翻四条既有用例的语义**（审稿后逐条实测核对，全部属实）：

| 位置 | 现状 | 40 格后 |
|---|---|---|
| `tests/ignis.spec.mjs:716` | `expect(r.hpStart, '起始满血').toBe(20)` | **必红**。走真实召唤路径读真实初值 ⇒ 改为 40（或改读 `PLAYER_MAX_HEALTH`，但该文件口径是「不复制权威」，故直接跑 40）|
| `tests/boss-audio.spec.mjs:600` | 等待条件 `g.player.health < 20` | 用例**会过但语义已漂**（注释写「14 伤害 / 20 格血 ⇒ 第二刀就到 0」）。改为 `< 40` 并重写注释 |
| `src/tests/test-health.js:129` | 「焰魔一击 14 打两次就归 0（作者的原始压迫感）」 | **必红**（40−28 = 12）。这是一条**设计判据**不是边界值，必须显式改写为「三下」（40−42 = 0）并在 roadmap 记明旧裁定被推翻 |
| `src/tests/test-spike-fx.js:559/576/597` | `assertDeepEqual(hit.damages, [18])` 共 3 处 | 尖刺 18→1 后必红，改为 `[1]` |

另外这些**描述性注释**要跟着改口径（不改注释就是第二份过期权威）：
`src/tests/test-spike-fx.js:553`（用例名里的「扣 18」）、`src/render/spike-fx.js` 文件头第 ③ 条、
`ignis-config.js:88`（「14 对 20 格血意味着两下即死」）、`ignis-config.js:331-332` 与 `:397`、
`src/core/game.js:4124`、`src/tests/test-ignis-system.js:1011` 与 `:1041`。

### D. 受伤红闪

| 方案 | 说明 | 取舍 |
|---|---|---|
| **D1（选定）** DOM 覆盖层：`#hud-root` 下一个 `position:fixed; inset:0` 的容器，四个 40px 宽的渐变条（上/下/左/右），`pointer-events:none` | 零 draw call、零 GPU；与血心/小地图/伤害数字同口径；四条独立渐变能精确表达「从边缘向内 40px 淡出」 | 需要一条 z-index 裁定 |
| D2 单张大图的 `box-shadow: inset` | 一行 CSS | 40px 内 inset shadow 的实际投影形状不易精确控制，且四角有可见差异 |
| D3 WebGPU 后处理 pass | 不受 DOM 层级影响 | 多一个 pass；与色调映射/天空盒交互要单独像素标定；用户已选 DOM |

选 D1。**渐变写法**：上下两条 `height:40px` 的 `background: linear-gradient(to bottom, rgba(200,0,0,α), transparent)`，
左右两条 `width:40px` 的 `linear-gradient(to right, …)`。四角由上下两条优先（它们先画、覆盖矩形四角），
观感是「边框亮、四角略重」，这是可接受的；如需精确的径向角落，改为一个 `radial-gradient` 遮罩层。

**淡出**：`opacity` 动画 0.35s 线性 1→0，用 `requestAnimationFrame` 驱动（不用 CSS transition ——
连续挨打时要能**重头再闪**，CSS transition 在元素已处于淡出中途时重新设为 1 的行为不可控）。

**触发点**：`_damagePlayer()` 内，`after < before` 分支。⚠️ 但用户又要求「血掉到 0 后受击**也要**闪」——
那时 `after === before === 0`，走不到这个分支。⇒ 判据改为 `amount > 0` 就闪，**不看血量是否真的变了**。

✅ **已核实**：`_damagePlayer` 当前只有三处调用点（`game.js:4069` 焰魔挥砍、`4146` 尖刺、`4228` 守卫），
三处都由**瞬态请求**驱动（`attackRequest` / `attackFxRequest` 命中帧出现一次、下一帧 Agent 自动清空），
不存在每帧重复判定的路径 ⇒ 血为 0 时不会刷成常亮。

⚠️ **反过来也要说清**：丧尸、TNT、飞龙火球**目前根本不扣玩家血** —— 全仓 `_damagePlayer` 只有上面三处
调用点。所以「任何掉血都闪」在本轮的实际效果是「焰魔与末影守卫打到你时闪」；将来接入丧尸/爆炸/摔落
伤害时，只要走 `_damagePlayer` 就自动覆盖，这是把红闪放进唯一入口的理由。

**音效**：保持现状（`after < before` 才播 `ignis_hurt`）。血为 0 时不响，避免音效持续刷。

**z-index**：取 **56**。落进既有不等式
`50（血心/坐标/看板） < 55（伤害数字） < 56（红闪） < 60（设置按钮） < 70（设置面板）`。
为什么不取更低：红闪要压过血心与伤害数字，否则「受到攻击」的即时反馈被 HUD 盖住。
为什么不取更高：它绝不该盖住设置按钮/面板/背包/toast。

## 7. 要改的文件（逐项）

| 文件 | 改动 |
|---|---|
| `src/player/health.js` | `PLAYER_MAX_HEALTH 20→40`、`PLAYER_MAX_HEARTS 10→20`；注释更新为新口径 |
| `src/ui/health-hud.js` | 两个 flex 行（10+10）；`top` 常量与行高；`_imgs` 长度 20；删掉 `PLAYER_MAX_HEARTS` 单一循环、改为按行铺 |
| `src/ui/damage-flash.js`（**新建**） | 红闪覆盖层：`spawn(nowMs)` / `update(nowMs)` / `dispose()`；常量 `DAMAGE_FLASH`（`bandPx:40`、`lifeMs:350`、`color`、`zIndex:56`）；纯函数 `flashOpacityAt(ageMs)` |
| `src/core/game.js` | ① import + 构造 + 每帧 `update` + `dispose`；② `_damagePlayer()` 内触发红闪；③ 法阵伤害结算（B1） |
| `src/entities/ignis/ignis-config.js` | 新增 `IGNIS_AOE`（`damage:1` + `sigilHalfExtent:2.0`）；`IGNIS_SPIKE.damage 18→1` + 注释说明推翻 |
| `src/tests/test-health.js` | 常量与边界从 20/10 改为 40/20；「两下即死」那条**设计判据**改为「三下」并注明旧裁定被推翻 |
| `src/tests/test-spike-fx.js` | 三处 `assertDeepEqual(..., [18])` → `[1]`；用例名里的「扣 18」与注释跟进 |
| `src/tests/test-damage-flash.js`（**新建**） | `flashOpacityAt` 的包络（0ms 全亮、350ms 归零、越界钳制、NaN）|
| `src/tests/test-ignis-system.js` | 尖刺 `damage` 断言 18→1（两处）；新增 `IGNIS_AOE.damage === 1` |
| `src/tests/test-flame-sigil.js` | 新增「装配层法阵命中判定」用例（照 `test-fire-ring.js` 的 `Object.create(Game.prototype)` 手法）+ **跳层等式** `IGNIS_AOE.sigilHalfExtent === FLAME_SIGIL.radius` |
| `src/render/spike-fx.js` | 仅改文件头第 ③ 条的注释（18→1），**代码零改动** |
| `src/tests/index.html` | 注册 `test-damage-flash.js` |
| `tools/test-tiers.mjs` | `test-damage-flash.js` 进 `UNIT_NODE_SAFE` |
| `tests/health-hud.spec.mjs` | 10→20 颗、20→40 格；新增「两排布局」几何断言（第二排 top = 第一排 top + 18）|
| `tests/ignis.spec.mjs` | `:716` 的 `hpStart === 20` → **40**（**必红项**）；新增「尖刺 1 格」「法阵 1 格」两条 |
| `tests/boss-audio.spec.mjs` | `:600` 等待条件 `health < 20` → `< 40`，重写注释（旧注释依赖「两刀归零」已不成立）|
| `docs/roadmap.md` | 新版本行（v3.29）+ 四条用户裁定 + 三条被推翻的旧裁定 |
| `CLAUDE.md` / `AGENTS.md` | UI 层级不等式补上 56 |

## 8. 留给实现者的判断

- ~~**法阵的几何口径**留待实现者~~ → **已定**：足迹半宽 `IGNIS_AOE.sigilHalfExtent = 2.0`（= 4×4 格），
  与 `FLAME_SIGIL.radius` 的等式由单测钉住。写成 3×3 会让玩家「看着踩在图案上却不扣血」。
- **尖刺 18→1 的连招总伤害**：尖刺刀砍 14 + 刺 1 = 15，40 格血可承受 2 次完整尖刺攻击；
  这是翻倍血量后合理的手感，若实玩发现太松可只调 `IGNIS_AOE.damage`。
- **红闪是否要「叠加强度」**：连续挨打时会连闪。当前设计是「每次触发重置计时到 0」，
  即后一次直接盖掉前一次的进度（不叠加亮度）。若要叠加需要额外的层数池 —— 不做。

## 9. 验证计划

**单测（Tier 1 TDD，Node 轻档）**

- `test-health.js`：40/20 常量自洽、`heartsFor(40)` 全满 20 颗、`heartsFor(39)` 末尾半颗、
  `applyDamage(40,1)=39`、边界不变式对 0..40 全扫。
- `test-damage-flash.js`：`flashOpacityAt(0)=1`、`(175)≈0.5`、`(350)=0`、`(400)=0`、`NaN→0`、负数→1。
- `test-ignis-system.js`：`IGNIS_SPIKE.damage === 1`、`IGNIS_AOE.damage === 1`。
- `test-flame-sigil.js`（新增装配层用例，**构型已按审稿修正**）：
  ① 玩家站在第 0 段落点中心 ⇒ 扣 1 次；
  ② 玩家**横向偏移到足迹外**（XZ 平面上离扇形中心 > 2.0 + 0.3）⇒ 不扣；
  ⚠️ **不得写「站在两段之间」用例** —— 段间距 4.25 / 半宽 2.0 ⇒ 边隙仅 0.25 格，
  比玩家半宽 0.3 还窄，那个构型在数学上不存在（会写成一条永远绿的假用例）；
  ③ 同一次攻击四段都压到玩家 ⇒ 仍只扣 1 次（钉 `break`）；
  ④ 未加载列跳过地面 ⇒ 不扣；
  ⑤ **`flameSigil: null` 时仍然扣**（钉住伤害不挂在渲染器存在性上）；
  ⑥ 跨层等式 `IGNIS_AOE.sigilHalfExtent === FLAME_SIGIL.radius`。

**E2E（Playwright）**

- `tests/health-hud.spec.mjs`：20 颗心、两排、像素断言（偏红像素下限从 200 提到 400）、
  `player.health === 40`。
- `tests/ignis.spec.mjs` +2 条：尖刺命中扣 1、法阵命中扣 1。
- 新增 `tests/damage-flash.spec.mjs`（**Tier 4 像素**）：调用 `_damagePlayer(1)` 后截屏，
  断言①屏幕边缘 40px 带内偏红像素显著高于中心区；②350ms 后回到基线；③血量为 0 时
  `_damagePlayer(1)` 仍能让边缘变红。**必须冻结**既有五个动态源（玩家下落 / 海面 / 第一人称手臂 /
  昼夜 / viewBob+stepLift）——见 `docs/pitfalls.md` 的像素基线节。

**负向验证（注入后必须真红）**

1. `IGNIS_SPIKE.damage` 改回 18 ⇒ 尖刺用例红。
2. 法阵判定去掉 `break`（改成逐段各扣）⇒ ③ 号用例红。
3. 红闪 z-index 取 100 ⇒ 层级断言红（并要目视确认会盖住启动错误遮罩）。
4. ~~`PLAYER_MAX_HEARTS` 只改常量不改 HUD 循环 ⇒ 像素断言红~~ —— **零判别力，已删**：
   `health-hud.js` 的心数就是 `PLAYER_MAX_HEARTS`，只改常量会画出 20 颗**单排**心
   （20×18 = 360px，从 x=346 起，仍在 1280 视口内）⇒ 偏红像素计数照样过 400。
   ⇒ 改注入「只改常量、HUD 仍单排」⇒ **两排布局的几何断言**红（这条才真有判别力）。
5. 法阵伤害恢复到 `!this.flameSigil` 门控内 ⇒ ⑤ 号用例红（`flameSigil: null` 时不扣）。
6. 尖刺伤害改回挂到刀砍上（`IGNIS.attackDamage`）⇒ 尖刺 1 格用例红。

**门禁**

- `npm run check`（arch + data + lint）
- `npx playwright test tests/health-hud.spec.mjs tests/ignis.spec.mjs tests/ignis-spike.spec.mjs tests/damage-flash.spec.mjs`
- `node tools/run-unit-node.mjs --all`（本次动了 `player/health.js`、`ignis-config.js` 两个被大量
  spec 间接消费的权威模块，Node 轻档整跑比逐个 grep 便宜）
- **不跑** `benchs --check`（渲染管线与热路径零改动）

## 10. 风险

| 风险 | 缓解 |
|---|---|
| 血量翻倍让 Boss 战变简单 | 这是用户明确要求；且新增的两处 1 格伤害部分抵消 |
| 法阵判定把「图案边缘」也算命中，读作判定过宽 | 4×4 vs 3×3 留待实测，用例钉住实际口径 |
| 红闪在血量为 0 时被每帧判定刷成常亮 | **已核实：当前三条伤害路径（焰魔 `attackRequest`、尖刺 `attackFxRequest`、守卫 `attackRequest`）全部是瞬态的一次性判定**，不是每帧。将来若接入持续伤害源，红闪要自带最小重复间隔（100ms） |
| 改 `IGNIS_SPIKE.damage` 推翻旧裁定 | 在 `ignis-config.js` 注释与 roadmap 里显式写明推翻关系与日期 |
