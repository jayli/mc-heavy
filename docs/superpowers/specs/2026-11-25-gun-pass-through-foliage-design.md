# 枪械射穿装饰性非实心方块（藤蔓 / 枯草 / 蘑菇 / 花草）设计

**日期**：2026-11-25
**状态**：待用户批准（brainstorming HARD-GATE：批准前不写产品代码）
**范围**：pistol / minigun / carbine 三把枪的**方块遮挡判据**；MAG7 与剑逐位不变

---

## 1. 意图与 why

用户原话（2026-11-25）：

> 「当设置了枪械无法破坏方块，pistol、minigun 射击到藤蔓、地面上的蘑菇、枯草方块的时候，
> 要求可以射穿……这些装饰性非实心（即玩家无法踩上去的方块，玩家无法跟他发生碰撞）的方块……
> 直接射穿，而不是击中。只有当设置了枪械可以破坏方块，才让这两个枪可以击中这些方块，
> 击中即消除，跟原来的逻辑一样。carbine 枪械也是一样的逻辑……mag7 的逻辑不变。」

即：**「能不能破坏」与「能不能挡住子弹」是两件事**。今天它们被同一个开关绑在一起 ——
开关关掉时枪打不掉草，于是草反而成了一堵挡子弹的墙（玩家看得见草是镂空的，子弹却停在草上）。

### 目标

- G1 破坏开关**关闭**时，pistol / minigun / carbine 的子弹**穿过**装饰性非实心方块，
  命中它后面的第一个实心方块（或射程末端）；穿过的方块**不被写、不出命中特效**。
- G2 破坏开关**开启**时，三把枪的行为**逐位回到今天**：命中草即消除（白闪 + 碎块 + delete 音）。
- G3 MAG7 的体积扫描、曳光终点、开关豁免**逐位不变**；剑（近战）与徒手挖块、右键放置、
  准心高亮框**逐位不变**。
- G4 「哪些方块算装饰性非实心」只有**一份权威**，新增植物按既有口径声明即自动纳入。

### 非目标 / 反目标

- N1 不改玻璃 / 树叶 / 云 / 台阶 / 栏杆 / 仙人掌的遮挡语义 —— 它们 `solid:true`，玩家撞得上，
  仍然挡子弹（用户口径是「玩家无法发生碰撞的方块」）。
- N2 不改水：主 DDA 本来就跳过水与沼泽水。
- N3 不新增名字白名单（`vine`/`short_grass`/… 逐个列出来 = 第二份权威，将来加植物必漏）。
- N4 不动 MAG7 的 `aim.target` 语义（它的扫描与曳光终点都依赖今天那条射线）。
- A1 反目标：只改 `_fireHitscan` 里的 `destroyed` 判定就宣称修好 —— 那样子弹仍停在草格上，
  数值判据（「没写世界」）全绿而观感完全没变。

## 2. 现状取证（只读侦察，实测）

- 三把枪的方块命中来自 **`Player.update()` 每帧那条主 DDA**（`player.js:477`，`REACH=40`，
  判据「非空气且非水即命中」），经 `_buildAim()` 的 `target` 传给 controller；
  KV-9 另有一条**抖动后重发的 DDA**（`weapon-controller.js:523`）。
  ⇒ 落点在**射线的遮挡判据**，不在破坏分支。
- `raycastVoxel(world, origin, dir, maxDist, occludes, onCell)` 第 5 参数已是既有扩展点
  （炮塔弹丸 / 士兵弹道 / 火球 / 岩石在用）⇒ **加判据，不写第二份 DDA**（红线 6）。
- 全库 159 个方块中 `solid:false` 的共 16 个（实测枚举）：
  `air`、`water`、`swamp_water`、9 个花草族（`flower` `short_grass` `allium` `azure_bluet`
  `dead_bush` `oxeye_daisy` `red_mushroom` `vine` `lilypad`）、`bush_grass`、`hanging_lamp`、
  `mine_cart`、`bed_alias_block`。
- 现成谓词 **`registry.isPlant(id)` = `solidTable=0 && cullTable=cutout`**（v3.13 为炮塔落地新增），
  实测正好覆盖上面 11 项植物 + 吊灯，且**不含**水（transparent）与两个 alias（none）。
- `mine_cart` / `bed_alias_block` 是 `cullMode:'none'` 的不渲染 alias：真实世界里矿车是**实体**
  （`MinecartService.place()` 只 spawn 实体，不写方块），床已从背包移除 ⇒ 无实际消费者。

## 3. 方案取舍（用户在对话中已选定）

| 方案 | 判据 | 取舍 |
|---|---|---|
| **A（选定）** | `registry.isPlant(id)`（非实心 ∧ cutout） | 复用唯一权威、零名字白名单、新植物自动纳入；吊灯一并放行（它同样无碰撞，是装饰件） |
| B | A + `mine_cart`/`bed_alias_block` 两个 alias | 多一条分支，覆盖的是世界里不会出现的格；用户未选 |
| C | 只列 `vine`/`short_grass`/`bush_grass`/`dead_bush`/`red_mushroom` | 花、睡莲、吊灯仍挡子弹；新增植物要手工补名单（漂移风险）；用户未选 |

用户 2026-11-25 选 **A**。

## 4. 设计（三处改动，一份权威）

### 4.1 `src/player/weapons/weapon-target-policy.js`

新增 `isGunPassThrough(id, registry)` = **转调 `registry.isPlant(id)`**。
不在这里重写 `solidTable=0 && cutout` —— 那会是第二份判据（红线 1）。
本函数存在的意义是给「枪械可射穿」这个语义一个命名入口（与 `isWeaponDestructible` 并列），
将来若要与 `isPlant` 分道（例如保住吊灯），改这一处即可。

### 4.2 `src/player/weapons/weapon-controller.js`

新增公开方法 **`gunOccludes(id)`**，返回「这一格是否挡住 pistol/minigun/carbine 的子弹」：

```
破坏开关开启 → id !== air && id !== water      // 逐字回到今天
破坏开关关闭 → 上式 && !isGunPassThrough(id)   // 再放行装饰性非实心
```

- 水的 id 从 `registry.idOf('water')` 取（与 `raycast.js` 缺省判据同源），不写字面量 2。
- **只对这三把枪生效**：`gunOccludes` 是给「持这三把枪时的射线」用的判据，
  MAG7 / 剑 / 徒手仍走 `raycastVoxel` 的缺省判据。

### 4.3 `src/player/player.js`

`update()` 与 `setTestAim()` 里那条主 DDA 之后，**持 pistol/minigun/carbine 且破坏开关关闭时**
用 `gunOccludes` 再算一条「武器专用 target」，交给 `_buildAim()`；
`this.target`（高亮框 / 挖块 / 放置 / 矿车交互读它）**保持不变**。

- 开关开启或持其它武器时**不多发一条射线**（零开销、零行为差）。
- KV-9 抖动后那条 DDA（`_fireCarbine`）传同一个 `gunOccludes`。

### 4.4 连带效果（有意，不是缺陷）

开关关闭时，躲在草丛/藤蔓后的实体会被打到 —— 装饰方块不再遮挡实体射线（`_queryEntityHit`
用 `target.dist` 做遮挡比较）。这与「射穿」是同一件事的两面。

## 5. 验证口径

- **Tier 1（必须 TDD）**：`src/tests/test-weapons.js`（谓词成员 + 三态门）、
  `src/tests/test-carbine.js`（抖动 DDA 用同一判据）、新增 Player 侧真实 DDA 用例。
  判据必须落在**命中格坐标 / 曳光终点 / editor 是否被调**，不是「有没有效果事件」。
- **Tier 3/4**：真实页 spec（`tests/weapons.spec.mjs` 增补）——
  三枪各自「开关关 → 草格仍在、命中后方石墙」与「开关开 → 草格变 air」两侧对照；
  MAG7 同场景下**仍消除草**（不变式）。
- **负向验证**：注掉放行分支后上述用例必须真 FAIL；还原用 `cp` 副本，不用 `git checkout`。
- 最小充分集：`npm run check` + `node tools/run-unit-node.mjs --only=test-weapons.js,test-carbine.js,test-raycast.js,test-block-registry.js`
  + `npx playwright test tests/weapons.spec.mjs tests/weapons-world-edit.spec.mjs tests/carbine.spec.mjs tests/tnt.spec.mjs`。
  不跑 `npm test`（本改动不属全局基础设施）。

## 6. 留给实施者的

- 方法/字段命名可按本文；`_buildAim()` 里武器 target 的存放字段名自定，但**不得**改写 `this.target`。
- 测试夹具沿用各文件既有手法（`test-weapons.js` 的 `makeRegistryWithWeaponBlocks` 需补登记
  一个 `solid:false, cullMode:'cutout'` 的植物方块，否则新用例没有判别力）。