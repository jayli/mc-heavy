# 「这里可以召唤 Boss」提示 — 设计文档

日期：2026-11-18 ｜ 版本：v3.16 ｜ 状态：已实现并验证（待用户实玩验收）

## 1. 意图与背景

用户原话：

> 在可以召唤 Boss 的位置，显示一个提示，可以召唤 Boss。离开这个区域后就让这个提示消失，
> 如果已经召唤 boss 出来后，已经没有更多的 boss 可以召唤了，这个提示也消失。

**为什么需要**：Boss 召唤（按 B）自 v2.43 起是「站在哪张地标级地图里就召哪张图的 Boss」，
但玩家**无从知道自己现在站的地方能不能召**。既有反馈只有按下 B 之后的 toast ——
按之前是一片沉默，按错了才被告知「这里没有可召唤的 Boss」。性能面板底部虽有一行
`B：召唤Boss` 的静态键位说明，但它不携带「此处此刻是否有效」的信息。

三条显式要求（全部是硬约束）：
1. 能召的位置 → 显示提示；
2. 离开该区域 → 提示消失；
3. 本图 Boss 已全部召出（没有更多可召）→ 提示消失。

## 2. 现状与约束（探索实测）

| 事实 | 出处 | 对本设计的约束 |
|---|---|---|
| 「玩家在哪张地图」唯一权威 = `bossMapAt(wx,wz,seed)` | `entities/bosses/boss-map.js` | 提示**不得**自写一份判据（红线 1） |
| 「哪张图有哪些 Boss」唯一权威 = `BOSS_ROSTER` | `entities/bosses/boss-registry.js` | 加 Boss 只改名册，提示零改动 |
| `summonBoss()` 的两道门：`count(type) >= maxAlive` → limit；`get(id)` 非空 → exists | `core/game.js:2627` | 提示的「可召」判据必须与这两道门逐条同口径 |
| Boss 死即 despawn，槽位自动空出（v2.43 已移除 `dragonDead` 标记） | `dragon-system.damage` | 提示必须**自己回来**，不得记「已召过」 |
| 高台地带有 2 个 Boss（飞龙 slot0 / 焰魔 slot1），其余三图各 1 个 | `BOSS_ROSTER` | 召了第一个后提示**必须还在** |
| 主线程锚点 memo 与 Worker 的是**两份**；未预热首次远点 `bossMapAt` 实测 **111ms** | Node 实测（`computeArenaAnchor` 22~88ms） | 进帧循环前必须预热 |
| 预热后 `bossMapAt`：中位 **0.004ms** / p99 **0.054ms** / 最坏 **0.13ms** | Node 300 点 × 5 seed | 250ms 节流后主线程开销可忽略 |
| toast 是 2.2s 自动淡出的一次性反馈，且与设置面板**共享同一个 `#mc-toast`** | `ui/toast.js` | 状态类提示不能复用 toast |
| UI 层级不等式（AGENTS.md） | hotbar 40 < minimap 45 < 看板/血心 50 < 伤害数字 55 < … | 常驻信息取 **50** |

## 3. 考虑过的三条路

| 方案 | 做法 | 取舍 | 结论 |
|---|---|---|---|
| **A. 独立常驻 HUD（采用）** | 新建 `ui/boss-hint.js`，判据转调 `bossMapAt` + 新的 `nextSummonableBoss`，250ms 节流 | 零 draw call、零 GPU；与既有 HUD 同生命周期；一个新增文件 + 名册补三列 | ✅ **采用** |
| B. 复用 toast，进区域时 `show()` 一条 | 零新组件 | ① 2.2s 后自己消失，玩家还在区域里却看不到；② 任何别的 toast（放炮塔/瞬移）会顶掉它；③ 「离开区域消失」需要额外撤销逻辑，而 toast 没有「按来源撤销」的能力 | ❌ 语义不符（状态 vs 事件） |
| C. 世界内 billboard（地标上方浮字） | 3D 文字/精灵 | 逐帧投影 + 常驻 mesh（违反「零实例必须 visible=false」的预算口径）；玩家背对地标时看不见 —— 而那正是刚走进区域最需要提示的时刻 | ❌ 成本与可用性都更差 |

## 4. 设计

### 4.1 判据（唯一权威链）

```
每 250ms：
  bossMapAt(player.x, player.z, seed)        ← 按 B 用的同一个函数
    → nextSummonableBoss(map, entities)      ← 与 summonBoss 的循环逐条同口径
      → null  ⇒ 隐藏
      → slot  ⇒ 显示，副行写 slot.label + Boss{slot+1}
```

`nextSummonableBoss` 的实现刻意与 `summonBoss()` 的循环同形：按 slot 升序，
`count(type) >= maxAlive` 即整体返回 null（对应 summonBoss 在 limit 处直接 return，
不继续试下一槽），`get(entityId(mapKey, slot))` 为空即返回该槽。

名册每行补三列（全部 import 既有权威，不写字面量）：
- `entityId`：转调 `dragonEntityIdFor` / `ignisEntityIdFor` / `guardianEntityIdFor`；
- `maxAlive`：转调 `DRAGON_MAX_ALIVE` / `IGNIS.maxAlive` / `GUARDIAN.maxAlive`；
- `label`：中文名（`祭坛飞龙` / `焰魔` / `末影守卫`），只服务提示副行；toast 文案一字未改。

### 4.2 预热（进帧循环的硬前置）

`warmBossAnchors(seed)` 在 `Game.start()` 里、`_waitForColumn` 之后调一次：
按 city → shallow → arena → burningArena → ruinedCitadel 顺序各调一次既有 compute 函数，
让它们**自己的** memo 填上。它不缓存任何结果、不构成第二份权威。

### 4.3 视觉

骨架沿用快捷栏那套原版 GUI 语言（2px 纯黑外描边 + 左上亮/右下暗 inset 浮雕），
底色改为**冷紫黑**而非箱子的 `#8b8b8b` —— 灰底会与快捷栏撞成「又一个物品栏」。
配色取自本仓既有 Boss 视觉（守卫紫 / 焰魔橙金）：

| 角色 | 色值 | 对底渐变三档的对比度 |
|---|---|---|
| 底（渐变） | `#1b1230` → `#120d1c` → `#0d0a14` | — |
| 主标题 / 按键徽标 | `#ffd75e` | 12.87 / 13.76 / 14.14 |
| 副行容器 | `#cbb8ee` | 9.89 / 10.57 / 10.86 |
| 副行 Boss 名 | `#f2f4f8` | 16.22 / 17.34 / 17.81 |
| 副行尾注 | `#9aa6ba` | 7.26 / 7.76 / 7.97 |
| 徽标文字 | `#1a1206` on `#ffe08a`/`#f0b429` | 14.37 / 9.94 |

全部 ≥ 7.26:1（WCAG AA 要求 4.5）。呼吸动画（1.8s）只落在**左侧 3px 指示条**上，
文字恒定不闪 —— 常驻 HUD 的文字动画会持续夺取注意力。`prefers-reduced-motion` 下关闭动画。

位置：屏幕正下方居中，`bottom: 76px`。
⚠️ 该值是**实测标定**：快捷栏总盒高 52px（图标 40 + 格边框 4 + 容器 padding 4 + 容器边框 4）
且 `bottom:12px` ⇒ 顶边距屏底 64px。初版写 68px 只剩 4px 间距，窄屏档写 64px ⇒ **实测 gap 0**
（两块黑边糊成一条）。现取 76 = 64 + 12，且窄屏只改字号/内距、**不改 bottom**。

### 4.4 生命周期

构造期建 DOM（默认隐藏）→ `start()` 里显式 `update()` 一次（恢复存档可能直接落在地带里）
→ 帧循环 `update(nowMs)`（血心之后）→ `dispose()` 摘节点。挂 `#hud-root` 下，
故 Tier 4 像素用例隐藏 HUD 时一并被隐藏。`pointer-events:none`，`isModal()` 恒 false。

## 5. 非目标

- 不改 Boss 召唤的任何玩法语义（名册、落点、上限、按键绑定全不动）；
- 不给 CITY / SNOW / SHALLOW_TARN 加 Boss（名册里它们仍然没有条目）；
- 不改 toast 文案与性能面板的静态键位说明；
- 不引入新贴图/几何/材质/音效（纯 DOM + CSS）。

## 6. 验证（实测读数）

**TDD RED**（浏览器取证探针，实现前）：`boss-hint.js` **404**、`nextSummonableBoss` **undefined**、
`warmBossAnchors` **undefined**、名册只有 `slot/type/service` 三列 ⇒ 整页模块图无法求值。

**GREEN**：新增 20 例单测全 passed；整页 **2454/2454，failed 0**，`otherFailed: []`（零回归）。

**Tier 4 真实页 E2E**（`tests/boss-hint.spec.mjs`，7 例全 passed）：
真实 KeyB + `_teleportTo`，覆盖「城市不显示 / 走进地带自动出现 / 走出去消失 / 召 Boss1 后仍在且副行换焰魔 /
召满消失且第三次按 B 真得「Boss 都在了」/ 打死一只自己回来 / 围场单 Boss 召了就没了 /
窄屏 390×780 不折行不溢出 / 预热后 `bossMapAt` 最坏 < 2ms」。

像素实测（noon + 关阴影 + 停物理，采样区 = 文字区 103×30 = 3090px）：
显示态 **360 / 360**（重复截图噪声底 **0**）、隐藏态 **0**、再次显示 **360**。
上下界都钉：下界 `> off + noise + 60`，上界 `< area × 0.5`（防整片涂满）。

**负向验证 4/4 真红**（`page.route` 在浏览器侧换内容，不碰工作树）：
- N1 判据退化为「有 Boss 在场就消失」→ 召 Boss1 后 hint **false**（缺陷复现）；
- N2 移除 limit 门 → hint **true** 而 toast **「Boss 数量已达上限」**（撕裂复现）；
- N3 `update()` 空转（漏接帧循环）→ 走进区域 hint **false**；
- N4 CSS 的 `.mc-boss-hint-on` 不改 visibility → class **true** 而 computed **hidden**
  （证明纯 DOM class 判据对该缺陷零判别力，必须有 CSS/像素层判据）。

**门禁**：`npm run check` exit 0（`check:arch` 172 文件全守住、`check:data` 全绿含
`[测试注册] 116 个文件全部已注册`）；lint **60 warnings = 主仓基线**，新增/改动的 5 个文件
单独 lint **零 warning**。回归：`dragon.spec` 10 passed、`boss-audio.spec` 10 passed。

**未跑 `bench --check`**：不碰 mesher/materials/render-world/scheduler/physics；
新增开销 = 每 250ms 一次纯函数（最坏 0.13ms）+ 状态变化时一次 DOM 写。

## 7. 本轮踩的坑（记下防复发）

1. **`Game.prototype.uiModal` 是只读 getter**：`Object.create(Game.prototype)` 造壳后
   写 `game.uiModal = false` 抛 `TypeError: Cannot set property uiModal ... which has only a getter`
   ⇒ 20 例里 17 例红，且报错文案与被测功能毫无关系（极易误判成实现缺陷）。造壳只注入**数据字段**。
2. **`Range.getClientRects().length` 不是折行判据**：副行含 `<b>` + 匿名文本 + `<i>`，
   **单行**时就返回 4 个行内盒 ⇒ `length === 1` 恒红。正确口径 = **不同行顶边 y 的个数**。
3. **limit 用例必须先占掉前一槽**：`summonBoss` 对 exists 槽是「跳过继续试下一个」，
   不占 slot0 时按 B 会召出飞龙（真的能召）⇒ 初版断言与真实行为相反。
4. **跑浏览器套件期间不得改它读的文件**（AGENTS.md 已记，本轮仍踩三次）：
   一次 harness 超时正是边跑边改注释造成的竞态；零编辑重跑即 2454/2454 全绿。