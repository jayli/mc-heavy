# 敌人/Boss 接线完整性门（方案 2）设计

**日期**：2026-11-23
**状态**：待用户批准
**取代**：同日的「类型分发收口（方案 A）」设计已废弃（副本存 `/tmp/mc-design-archive/A-version-superseded.md`，未提交过）。废弃理由见 §6。

---

## 1. 意图与理由

用户下一步要**增加敌人种类或 Boss 种类**。当前每加一个类型，要在既有文件里插 15 处、写约 82 行净代码。

**问题不是行数，是漏改的后果。** 实测逐处后果：

| 插刀点 | 漏改后果 | 是否静默 |
|---|---|---|
| `damageEntity` | 新敌人打不掉血 | 可见（立刻发现） |
| `knockbackEntity` | 挨剑不后退 | 观感缺陷，实玩才发现 |
| `_onEntityDeath` | 死亡无声、无碎块爆散 | **静默**（扣血/数字全对） |
| `headY` 三元链 | 伤害数字飘在胸口 | **静默**（文本对、位置错） |
| `half` 三元链 | 溅射判定中心偏低半个身高 | **静默** |
| `bossAlive` | Boss 战 BGM 不响 | **静默** |
| `_syncBossAudio` 循环 | 起手音/跳跃音不响 | **静默** |
| `_runTurretAi` | 炮塔不打它（武器能打） | **静默** |
| `physics` 两处 | 玩家停在身体盒内 0.12 格 | **静默** |

**9 处里 7 处静默失效。且不是我推测——git 里有真实发生过的记录：**

- `197ebd4 feat(guardian): 末影守卫受击后退，与焰魔同口径` —— 守卫落地时漏了击退，事后补，附带 182 行新 spec。
- `d198d1f feat(ignis): 焰魔死亡碎块爆散（火焰色，Boss 口径）` —— 焰魔落地时漏了爆散，事后补。
- `game.js:3339` 注释原文：焰魔受击音「**这里原来一行都没有** ⇒ 焰魔挨枪只有枪声、没有受击反馈（扣血/红闪/伤害数字全对，纯静默缺陷）」。

### 1.1 为何现有 spec 不能自动覆盖新类型（收益的直接依据，实测）

这是本设计成立的关键前提 —— 若现有 spec 已能自动覆盖新类型，本门就是冗余。

**实测：`tests/boss-audio.spec.mjs` 共 10 个 `test()`，其中 9 个标题写死了具体 Boss 名**：

```
'焰魔：挥刀播 ignis_attack_swing、跳跃播 ignis_jump、死亡播 ignis_die'
'焰魔：旋斩起手播 ignis_attack_circle、普攻起手播 ignis_attack_swing（两音不混）'
'末影守卫：枪击中播 gun_hit，不再播 guardian_hurt'
'飞龙：喷火球播 dragon_fire，空中随机吼 dragon_shout'
```

它们不是「验所有 Boss 的接线」，而是「验焰魔的接线」「验守卫的接线」。
⇒ **加一个新 Boss，这 9 个用例一个都不会覆盖它。**

那 4 个引用 `WEAPON_HITTABLE_TYPES` 的单测（`test-weapons` / `test-projectiles` / `test-storm-lance` / `test-cinder-fall`）也不行：实测它们是在**夹具里注入 predicate**（`isHittable: (e) => WEAPON_HITTABLE_TYPES.includes(e.type)`），验的是 controller 的注入契约，**不是真实 Game 里每个类型都接通了**。

### 1.2 收益（三件具体的事）与不带来的东西

**收益**：
1. **新类型自动进入覆盖**，不需要谁记得写新 spec。今天加一个 Boss 要手写一整套接线 spec（`197ebd4` 那次附带 **182 行**）；登记进名册即自动被 12 项判据扫一遍。
2. **漏改从「实玩才发现」变成「改动当场红并指名漏点」**（上述 7 处静默失效，历史上每处都花了一个专门的补修提交）。
3. **双向钉住使门自己不会变成新的漏改点**（§4.3）。

**不带来**（诚实边界）：
- 不减少写代码的量。加一个 Boss 仍要写那 82 行。
- 不覆盖玩法正确性（只验「接通了没有」，不验「这一招该不该打 18 点」）。
- 不覆盖新类型的特有缺陷（守卫「落点错层」、焰魔「模型埋地下」那类仍需各自的 spec）。
- **收益只在真的加类型时兜现**；若最后没加，这 ~150 行就是纯成本。

⇒ **本设计的目标：把「漏一处接线」从「实玩才发现、事后开一个补修提交」变成「改动当场红，并指出漏的是哪一处」。**

---

## 2. 目标 / 非目标 / 反目标

### 目标

1. 新增敌人/Boss 类型时，若漏改上述任一处接线，**门禁当场 FAIL 并指名漏点**。
2. **零改现有生产代码**（`game.js` / `physics.js` / `entity-types.js` 一行不动）。
3. 新增判据本身必须有判别力——注入缺陷后真 FAIL（§7）。

### 非目标（明确不做）

- **不改任何分发逻辑**。else-if 链、三元链、手写索敌清单全部原样保留。
- **不追求「加类型只写一行」**。加类型仍要写那 82 行——本设计只保证漏写会被抓住。
- **不抽表来供生产代码读**。表只被测试消费（这是与方案 A 的根本区别）。
- **不改 TNT 杀伤范围**（`_damageEntitiesInRadius` 只遍历丧尸，`game.js:3761`/`:3867` 两处注释明写「Boss 压根打不到」，Storm Lance / Cinder Fall 刻意绕开它）。
- **不改任何 Boss 的击退裁定**（守卫 v2.91 硬早退 → v3.10 撤销的用户裁定原样保留）。
- **不新增 `ZOMBIE_TYPE` 常量**去替换 `game.js` 里 6 处 `'zombie'` 字面量（无关改动）。

### 反目标（做成了也算失败）

- **判据恒真**：断言在缺陷注入后仍 PASS。§7.2 记录了我在设计期实测到的一个恒真陷阱。
- **假红**：新类型刚登记进表、service 还没装配时就 FAIL，让人以为门坏了（§5.3 处理）。
- **第二套语义**：断言自己写一份 Y 口径公式，与被测代码同时错 ⇒ 「两者一致」的假结论。派生值必须从**各自 config 的常量**独立算出。

---

## 3. 现状取证（行号为 HEAD `d9f4119`）

| 位置 | 形态 | 可观测点（实测存在） |
|---|---|---|
| `game.js:3331` | `damageEntity` else-if 链 | 返回值 `{dead, health}` |
| `game.js:3408` | `knockbackEntity` if 链 | `state.position` 变化 |
| `game.js:3457` | `_onEntityDeath` else-if 链 | `g.audioDebugState().playRequests` + `g.blockHitFx.activeDebrisCount` |
| `game.js:3515` | `headY` 三元链 | `_damageNumbers` 的锚点 y（`health-hud.spec:242` 已有同口径用例） |
| `game.js:3898` | `half` 三元链 | 溅射是否调 `damageEntity`（需构造边界几何，见 §7.2） |
| `game.js:4021` | `bossAlive` 求和 | `audioManager.debugMusicState().boss.wanted` |
| `game.js:4035-4120` | `_syncBossAudio` 三循环 | `playRequests` 计数 |
| `game.js:4396` | `_runTurretAi` 手写清单 | `controller.targetId` |
| `physics.js:203,361,367` | service 数组 + 两处盒判定 | `physics._collides()` / `_ejectFromBoss` 位移 |

**驱动方式**：真实游戏页 `window.__MC_GAME__`（`tests/guardian.spec.mjs` 等既有 spec 的口径）。
**不能用 Node 单测**：`game.js` import three 且需 DOM/WebGPU，不在 `UNIT_NODE_SAFE` 白名单（实测该白名单无 game.js 消费方）。

---

## 4. 关键约束

### 4.1 表只能被测试消费，否则等于方案 A

若让生产代码读表，就重新引入方案 A 的全部风险（`entities → render` 反向边、12 数值迁移、38 spec 契约）。**表落 `tests/` 或 `src/tests/`，不进 `src/entities/`。**

实测支撑：`entities/` 当前零 `render/` 依赖（grep 到的 5 处全是注释），而死亡音在 `render/audio-config.js`、爆散色在 `render/*-model.js`。表若建在 `entities/` 并读它们就会新开反向边，且 `check-architecture.mjs` 的 `LAYER_ORDER` 只含 `[voxel,gen,mesh,render]` ⇒ **`entities` 不在其中，方向门直接跳过、抓不到**。本设计把表放测试侧，从结构上避开这个问题。

### 4.2 Y 口径是三个独立量（沿用 A 版已证实的结论）

| 类型 | `position` 语义 | 爆散/溅射锚点 | 头顶数字 | 炮塔瞄准 |
|---|---|---|---|---|
| zombie | 脚底 (h=1.8) | +0.9 | +1.8 | +1.2 |
| ignis | 脚底 (h=3.25) | +1.625 | +3.25 | +1.2 |
| guardian | 脚底 (h=3.8) | +1.9 | +3.8 | +1.2 |
| dragon | **体心** | **+0** | **+1.875** | **+0** |

三个脚底类型满足「头顶 = 2×中心」，**龙不满足**。炮塔瞄准恒 `TURRET.enemyBodyOffsetY=1.2`（与身高无关），龙显式传 0。

⇒ 表里登记 `positionSemantics` / `height` / `coreHalfY` / `aimOffsetY`，**期望值从各 config 常量独立算出**，不抄 `game.js` 的公式。

### 4.3 双向钉住（照 `check:data` 的「测试注册」范本）

漏登记与死登记都要抓：
- 表里有、`entities` 未注册该类型 ⇒ 死登记（FAIL）
- `entities` 注册了可击中类型、表里没有 ⇒ **漏登记（FAIL）** ← 这条才是防「加了新类型忘了登记」的关键

第二条使本门**自动覆盖未来新增类型**，不需要谁记得去更新表。

---

## 5. 设计

### 5.1 名册表（新文件，测试侧）

`src/tests/enemy-wiring-roster.js`（或 `tests/` 下，实施者定）：

```js
// 每个可击中类型的「必须接线项」清单。期望值一律从 config 常量派生。
export const ENEMY_ROSTER = Object.freeze({
  zombie:   { service: 'zombies',   semantics: 'feet',   height: ZOMBIE.height,   boss: false, blocksPlayer: false, deathSound: 'z_die',       burst: true },
  dragon:   { service: 'dragons',   semantics: 'center', coreHalfY: DRAGON_CORE_OBB.halfExtents[1], aimOffsetY: 0, boss: true, blocksPlayer: false, deathSound: 'ignis_die', burst: false },
  ignis:    { service: 'ignises',   semantics: 'feet',   height: IGNIS.height,    boss: true,  blocksPlayer: true,  deathSound: 'ignis_die',   burst: true, hitSound: BOSS_HIT_SOUND },
  guardian: { service: 'guardians', semantics: 'feet',   height: GUARDIAN.height, boss: true,  blocksPlayer: true,  deathSound: 'guardian_die',burst: true, hitSound: BOSS_HIT_SOUND },
});
```

`burst: false`（龙）是**刻意不做爆散**（用户未要求），不是遗漏——与 `boss-registry.js` 刻意不为无 Boss 地图写空数组同一手法。

`boss` 字段必需：`bossAlive` 实测只求和三 Boss，**丧尸在场不触发战斗 BGM**。

### 5.2 完整性 spec（新文件）

`tests/enemy-wiring.spec.mjs`，遍历名册，对每个类型逐项验：

| 项 | 判据 |
|---|---|
| 双向钉住 | 表 ↔ `entities` 已注册的可击中类型集合相等 |
| damage | 真实入口打它 ⇒ 返回 `{dead,health}` 非 null |
| knockback | 调 `knockbackEntity` ⇒ `state.position` 真的变了（`blocksPlayer` 无关） |
| death 音 | 打死后 `playRequests[deathSound]` 增长 |
| death 爆散 | `burst:true` ⇒ `activeDebrisCount` 增长；`burst:false` ⇒ **不增长** |
| hit 音 | 有 `hitSound` ⇒ 非致死命中后该计数增长 |
| 头顶锚点 | 数字锚点 y == `semantics==='feet' ? y+height : y+coreHalfY`（独立算） |
| 溅射中心 | 边界几何构造（§7.2），漏登记 ⇒ 不扣血。**只适用于 Cinder Fall 路径**（TNT 路径只遍历丧尸，属非目标）|
| boss BGM | `boss:true` ⇒ 召唤后 `debugMusicState().boss.wanted===true`；`boss:false` ⇒ 仍 false |
| 起手音 | 进 attack 态 ⇒ `playRequests` 增长 |
| 炮塔索敌 | 放炮塔 + 该类型 ⇒ `controller.targetId` 非 null |
| 玩家阻挡 | `blocksPlayer:true` ⇒ 玩家盒重叠时 `_collides()` 为真 |

**召唤一律走真实入口**（Boss 按 KeyB、丧尸走巢穴/spawn API），照 `guardian.spec.mjs` 的既有教训：直接调 `service.summon` 会漏掉「名册没登记 / service 没装配 / 地图判定不对」这类接线缺陷。

### 5.3 假红的处理

新类型「已登记进表但 service 尚未装配」时，`this[service]` 为 undefined。此时**必须报「service 未装配」而不是逐项静默跳过** —— 否则门变成「登记了就绿」。

实现：先断言 `g[service]` 存在且 `entities` 已注册该类型，失败信息直接指名缺哪一步。

### 5.4 分档

新增 spec 归 `entity` 档（`tools/test-tiers.mjs`）。这是**全局基础设施改动**（分档清单），按 testing-policy 属 Tier 1，需 `check:data` 的双向钉住通过。

---

## 6. approaches（考虑过的三条，含被废弃的 A）

| | 做法 | 一次性成本 | 每次加类型省 | 结论 |
|---|---|---|---|---|
| **A（已废弃）** | 收口分发：建表供生产代码读，改掉 9 处分支 | **~380 行**（含 120 行单测 + 40 行静态门 + 12 数值冻结 + 6 条负向验证） | 49 行 / 少碰 9 处 | **纯行数回本点 8 个新类型**；用户计划 2~4 个 ⇒ 亏。且复杂度全在保护重构自身 |
| **2（本设计）** | 只建完整性门，零改生产代码 | **~100~150 行**（表 + spec） | 0 行，但 7 处静默失效变成当场红 | **用户选定** |
| 3 | 什么都不做 | 0 | 0 | 也成立：历史上 7 处都靠事后补修好了，代价是再加 2~4 个类型大概再补 2~4 次 |

**A 被废弃的核心理由**（用户判断，我复核后同意）：它把「消灭漏改风险」与「让代码更短更抽象」打包了。后者要 8 个类型才回本，而前者用 1/3 的成本就能拿到。

---

## 7. 验证判据

### 7.1 判据必须独立于被测代码

期望值从 `ZOMBIE.height` / `IGNIS.height` / `GUARDIAN.height` / `DRAGON_CORE_OBB.halfExtents[1]` / `TURRET.enemyBodyOffsetY` **独立算出**，不 import `game.js` 的任何公式，也不抄它的三元链。

### 7.2 ⚠️ 设计期实测到的恒真陷阱（必须按此构造，否则判据无效）

**溅射中心（`half`）的朴素判据对现有三个类型全部零判别力。**

朴素写法：爆心放在实体正上方 `h/2` 处（= 真实中心），断言它扣血。
- 正确实现：`dist = 0 ≤ 4` ⇒ 扣血 ✓
- 漏改（`half` 落 0）：`dist = h/2`，而 `blastRadius = 4`

实测：zombie 0.9 / ignis 1.625 / guardian 1.9 —— **全部仍在半径 4 内 ⇒ 漏改也扣血 ⇒ 判据恒真。**

**正解：加水平偏移，使正确实现刚好在半径内、漏改刚好超出。** 设水平距离 `r`：
- 正确：`dist = r`
- 漏改：`dist = sqrt(r² + (h/2)²)`

需 `r ≤ 4` 且 `sqrt(r²+(h/2)²) > 4`，即 `r ∈ (sqrt(16−(h/2)²), 4]`。实测区间：

| 类型 | r 区间 | 建议取值 |
|---|---|---|
| zombie | (3.897, 4] | 3.949 |
| ignis | (3.655, 4] | 3.828 |
| guardian | (3.520, 4] | 3.760 |

**新类型的 r 必须按其 height 现算**，不能写死一个值。

**两个必须注意的坐标口径差异**（自审实测）：
- `_cinderBlast`（本判据的目标）直接用 `const [cx,cy,cz] = at`，**不加 0.5**（`at` 已是世界坐标表面点，v3.21 裁定）。
- `_damageEntitiesInRadius`（TNT 路径）是 `center[i] + 0.5`（块心）。
⇒ **夹具不得混用两者**：把 TNT 的 +0.5 口径搬进 Cinder 夹具会引入 0.5 格系统误差，而本判据的 r 区间宽度只有 **0.103~0.48 格**（guardian 0.48 / ignis 0.345 / zombie 0.103）—— 0.5 格误差足以让判据翻转。

**zombie 的区间只有 0.103 格宽**，对夹具精度要求最高。若实施中发现难以稳定命中，**允许只对 ignis/guardian 做该项判据**，但必须在文档里记下 zombie 未覆盖，不得静默跳过。

### 7.3 负向验证（注入后必须真 FAIL；用 `edit` 注入并读回确认，`cp` 副本还原，禁 `git checkout`）

| 编号 | 注入 | 应红项 |
|---|---|---|
| N1 | 删掉 `damageEntity` 的 guardian 分支 | damage |
| N2 | 删掉 `knockbackEntity` 的 guardian 分支 | knockback |
| N3 | 删掉 `_onEntityDeath` 的 guardian 分支 | death 音 + 爆散 |
| N4 | `headY` 删掉 ignis 分支（落龙口径 1.875） | 头顶锚点 |
| N5 | `half` 删掉 guardian 分支（落 0） | 溅射（**须用 §7.2 的边界 r，否则恒真**） |
| N6 | `bossAlive` 去掉 GUARDIAN 项 | boss BGM |
| N7 | `_syncBossAudio` 删掉守卫循环 | 起手音 |
| N8 | `_runTurretAi` 删掉守卫 for | 炮塔索敌 |
| N9 | `physics._collides` 删掉 guardians 那行 | 玩家阻挡 |
| N10 | 名册里删掉 guardian 一行 | 双向钉住（漏登记） |
| N11 | 名册里加一个不存在的类型 | 双向钉住（死登记） |

**N5 是本设计最关键的一条**：它是唯一在设计期就被实测证明「朴素写法恒真」的判据。

### 7.4 门禁与最小充分集

- `npm run check`（含 `check:data` 的测试注册 + 分档双向钉住）
- `npx playwright test tests/enemy-wiring.spec.mjs`（新增）
- 受影响的既有 spec：**无**（零改生产代码）
- **不跑 `npm run test:unit`**（未改纯函数/协议/数据模型）
- **不跑全套**（分档清单改动虽属全局基础设施，但消费方是「新增一个 spec」，`check:data` 的双向钉住足以证明注册正确；若实施中发现分档 runner 行为变化，再按 policy 升级）
- **不跑 `bench --check`**（零改热路径）

---

## 8. 留给实施者的决定

- 表与 spec 的确切落点（`src/tests/` 浏览器内单测 vs `tests/` Playwright spec）。**约束**：需要真实 `window.__MC_GAME__` ⇒ 实质是 Playwright spec；表可放 `tests/` 下被 spec import。
- 每项断言的具体夹具（召唤位置、炮塔摆放、玩家盒重叠构造）——照既有 `guardian.spec` / `turrets.spec` / `boss-audio.spec` / `health-hud.spec` 的已验证口径，**不自造夹具**。
- 溅射边界 `r` 的计算函数落点。
- 是否为「未来新增类型」提供更友好的失败信息（建议：失败信息直接列出「类型 X 缺项 Y」）。

---

## 9. 风险小结（表述已按实测修正）

**会变更现有代码逻辑吗：不会。** 生产代码（`src/` 下非测试）**一行不动** —— `game.js` 的 else-if 链、三元链、手写索敌清单全部原样保留。因此：12 个 Y 数值不需冻结对照（无迁移）、38 个 spec 的 134 处私有引用不受影响、不产生 `entities → render` 反向边、不碰热路径。

**但有两处既有文件必须改（都不是逻辑）** —— 初版写「零改现有代码」不准确，此处修正：

| 文件 | 改动 | 为何必须 |
|---|---|---|
| `tools/test-tiers.mjs` | `ENTITY` 数组加一行字符串 | 实测 `check-data.mjs:365` 有双向钉住：`specActual.filter(f => !archived.includes(f))` 非空即 FAIL（「spec 漏归档 = 分档入口静默不跑它」）。不登记则 `npm run check` 直接红 |
| `docs/superpowers/specs/`（本文档） | 新增 | 设计记录 |

若表放 `src/tests/` 下，还需 `src/tests/index.html` 注册一行（同样被 `check:data` 双向钉住）。**建议表放 `tests/` 侧避开这项**（§8）。

**其余副作用**：
- 新增一个 spec 的执行时间（需真实页面 + 逐类型召唤，估计与 `guardian.spec` 同量级）。归 `entity` 档，**不进日常最小门**。
- 新 spec 会往世界写方块（实测 `turret-service.js:133` 走 `editor.setBlocks` ⇒ 产生 edits ⇒ 落 IndexedDB）；Boss/丧尸均 `persistent: false`（实测三处）不写 snapshot。Playwright 每个 test 默认新 context ⇒ IndexedDB 天然隔离，且 `workers: 1` 串行。既有 `turrets.spec` 有 7 处 `placeTurret` 且无 afterEach 清理 ⇒ 该模式已在本仓安全运行。
- 不改生成逻辑、不移动地图 ⇒ 不会侵占既有用例的取样窗口（本仓有该类实测教训，此处不适用）。

**最大的风险不是破坏现有功能，而是判据本身无判别力** —— §7.2 已实测出一个恒真陷阱并给出正解，§7.3 的 11 条负向验证是兜底。

**一个必须声明的局限**：本文档未经独立审阅（本会话无委派授权，按 brainstorming 本该派 fresh 子代理做 builder check，改为自审）。自审抄不到「文档与作者共享同一个错误假设」这类问题。**所以「安全」的最终证据不是本文的声明，而是实施时那 11 条负向验证：若某条注入后不红，说明判据有问题，而不是代码没问题。**