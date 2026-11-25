# 屏外敌人方位指示箭头设计（v3.42）

日期：2026-11-26
状态：待用户批准

## 1. 意图与为什么

用户 2026-11-26 原话：「在屏幕的四周加上指示箭头，来指示丧尸、soldier、飞龙、焰魔、末影守卫等
敌人的位置，因为地图很大，很容易找不到敌人的位置，如果敌人不在玩家的视口范围内，就给一个小
箭头指示敌人的位置，用不同颜色的小三角形来指示」。

世界无边界、敌人随结构散布在几百格尺度上，而 HUD 现有的敌人计数行（v3.36）只回答「有几只」，
不回答「在哪个方向」。本特性补的是**方位**这一维：屏外的敌人沿屏幕边框给一个指向它的小三角，
玩家转视角/跑动时箭头跟着动，转到看得见它时箭头消失。

### 用户已定的（不再讨论）

| 项 | 裁定 |
|---|---|
| 颜色 | soldier 灰、丧尸 绿、飞龙 紫、焰魔 黄、末影守卫 **粉红**（`ask_user_question` 2026-11-26 确认「分红」= 粉红） |
| 形状 | 小三角形，贴在屏幕四周 |
| 触发 | 敌人**不在玩家视口范围内**时才显示 |
| 粒度 | **每类只画最近一只** + 旁边小字标该类屏外总数（避免 20 只丧尸在边上挤成一排） |
| 附加读数 | 带**距离**（`37m`）+ **远近透明度**（远淡近实） |

## 2. 目标 / 非目标 / 反目标

**目标**
- 五类敌人各一个方位箭头，颜色可区分，指向真实方位（含俯仰：敌人在头顶/脚下时贴上下边）。
- 屏外总数与距离读数与真实实体集合逐位一致。
- 零 draw call、零 GPU 资源、零烘焙、零新素材。
- 空闲（无敌人在场）时每帧成本 = 一次时间比较。

**非目标**
- 不做世界内 billboard / 3D 标记（要逐实体几何与材质，撞既有「零实例必须 visible=false」预算口径）。
- 不做遮挡判定（被墙挡住的敌人也算「在视口内」→ 不画箭头）。视口内即视口内，与玩家实际能否看见无关。
- 不做敌人类型以外的目标（矿车、炮塔、火球、弹丸、装置一律不指示）。
- 不加设置面板开关（用户未要求；将来要加是独立一轮）。
- 不做小地图上的敌人点（那是另一件事，本轮不碰 `minimap.js`）。

**反目标（做到了也算失败）**
- 箭头指向镜像方位（相机背后的点直接 `project()` 会除以负 w，得到屏幕内的假坐标）。
- 20 只丧尸 → 20 个箭头把边框挤满。
- 士兵留尸期间仍显示箭头（尸体不是敌人）。
- 箭头压在设置面板/背包/toast 之上，或盖住 WebGPU 启动失败遮罩。
- 玩家死亡/存档切换后残留上一局的箭头。

## 3. 现状与约束（已读代码确认）

- HUD 一律是 DOM 覆盖层挂 `#hud-root`（血心 `health-hud.js`、计数行 `enemy-counts.js`、
  红闪 `damage-flash.js`、迷你地图 `minimap.js`）。Tier 4 像素用例通过
  `#hud-root > *` 全部 `display:none` 来隔离 HUD ⇒ 新箭头必须挂 `#hud-root` 下，否则污染全部像素基线。
- **UI 层级不等式**（`CLAUDE.md`）：hotbar 40 < 迷你地图 45 < 坐标/性能面板 50 = 血心 50 =
  计数行 50 = Boss 提示 50 < 伤害数字 55 < 红闪 56 < 设置按钮 60 < 设置面板 70 < 背包 80 <
  hover 85 < toast 90 < loading 95 < 错误遮罩 100。**不得取 100+**。
- `src/ui/**` 既有口径：**不 import three**。世界→屏幕投影由装配层 `game.js` 注入
  （`DamageNumbers` 的 `projectFn` 就是这么做的）。
- 相机姿态：`player.update()` 每帧 `camera.rotation.set(0,0,0)` → `rotateY(yaw)` →
  `rotateX(pitch)` → viewBob/后坐的局部分量。`camera.matrixWorldInverse` 由
  `renderer.render()` 每帧重算 ⇒ **投影必须在 render 之后**（`_damageNumbers.update()` 已在该位置，
  注释里写明了理由）。
- 实体权威：`entities.entities()` / `entities.count(type)`；士兵留尸 1.2s 仍在集合里且
  `state.dead === true`，`enemy-counts.js` 已因此显式过滤。五类型名从各自 config import
  （`SOLDIER_TYPE` / `DRAGON_TYPE` / `IGNIS_TYPE` / `GUARDIAN_TYPE`；丧尸历史上是字面量 `'zombie'`）。
- 身高/体心语义（`tests/enemy-roster.mjs` 实测冻结）：zombie/soldier/ignis/guardian 是**脚底**
  （`position.y` = 脚底），dragon 是**体心**。锚点取身体中心比脚底更稳（指示的是实体本体）。
- 存活上限：丧尸 20、士兵 10、焰魔 2、守卫 2、飞龙若干 ⇒ 每帧遍历实体集合（几十项）成本可忽略。
- `performance.now()` 是唯一时间基准，禁 `Date.now()`。
- 分档清单 `tools/test-tiers.mjs` 与 `src/tests/index.html` 被 `check:data` 双向钉住：
  新增单测要注册进 index.html + `UNIT_NODE_SAFE`，新增 spec 要归档进 `UI` 档。

## 4. 三条可行路线（Approaches）

### A. DOM 三角覆盖层（**推荐，已选**）
每类一个常驻 `<div>`，内含 CSS border 画的三角 + 一行小字（`×3 37m`）。
装配层注入 `cameraSpaceFn`（复用 `DamageNumbers` 那条已验证的 `matrixWorldInverse` 路径，
但不做透视除法），本模块只做几何与 DOM 写入。

- 优点：零 draw call / 零 GPU 资源 / 零烘焙；与血心/计数行/红闪同口径 ⇒ Tier 4 隔离自动生效；
  纯几何部分可在 Node 单测里驱动（无 DOM）；空闲零成本。
- 代价：DOM 写入触发合成（每类每帧一次 `transform` + `opacity`，5 项，远低于既有 HUD 开销）。

### B. 画进迷你地图那张 overlay canvas
- 否决理由：迷你地图只有 153px 见方且在左下角，表达不了「屏幕四周」；且它的底图是区域采样，
  没有敌人数据通路，要新开一条实体→地图的查询。与用户要的形态不符。

### C. WebGPU 后处理 / 世界内 billboard
- 否决理由：新增 render pass 或逐实体 mesh，撞 draw call 冻结断言与「零实例必须 visible=false」
  预算口径；还要单独做像素标定。用户要的只是一个 HUD 提示，代价不成比例。

## 5. 设计细节（A 的实现契约）

### 5.1 新文件与职责

| 文件 | 职责 |
|---|---|
| `src/ui/enemy-arrows.js`（新） | **配色 + 几何 + DOM**。导出纯函数 `enemyArrowTargets()`（选目标）、`arrowPlacement()`（算边缘位置与角度）、`arrowOpacity()`（远近包络）与 `EnemyArrows` 类（DOM 池 + 每帧刷新）。**不 import three**。 |
| `src/core/game.js`（改） | 装配：构造 `EnemyArrows`（注入 `cameraSpaceFn` + 每帧读 `camera.fov`/视口），帧循环在 `_damageNumbers.update()` 旁调 `update(nowMs)`（**同样必须在 render 之后**），`dispose()` 里摘除。 |
| `src/tests/test-enemy-arrows.js`（新） | 纯函数契约（Node 档，无 DOM）。 |
| `tests/enemy-arrows.spec.mjs`（新） | 真实页面 E2E：颜色/位置/指向/数量对账/尸体排除/层级。 |
| `src/tests/index.html`、`tools/test-tiers.mjs`（改） | 注册新单测 + 归档新 spec 进 `ui` 档。 |
| `CLAUDE.md`（改） | UI 层级不等式补一项；代码地图 `src/ui/` 行无需改（已含 HUD）。 |
| `docs/roadmap.md`（改） | 新增 v3.42 行。 |

### 5.2 配色（唯一权威，导出常量）

```
ARROW_COLORS = { soldier:'#9aa3ad', zombie:'#4ade80', dragon:'#a855f7',
                 ignis:'#facc15', guardian:'#ff69b4' }
```
- 灰取偏冷亮灰 `#9aa3ad`（纯 `#808080` 在暗洞穴/夜空上读不出）。
- 紫 `#a855f7` 与粉红 `#ff69b4` 色相分得开（用户已确认这条配色）。
- 每个三角带 1px 深色描边（`filter: drop-shadow(0 0 1px #000)`），保证在亮草地与雪地上也读得出。

### 5.3 目标选择（`enemyArrowTargets`）

输入：实体可迭代集合 + 玩家位置 + **相机空间函数** `cameraSpaceFn(worldPos) → [cx,cy,cz]`
+ 视口尺寸 + `tanHalfFov`。输出：每类至多一条
`{ key, type, color, count, distance, camSpace }`。

1. 遍历实体，只收五个登记类型；**士兵额外过滤 `state.dead === true`**（留尸不算敌人）。
2. 锚点取**身体中心**：脚底语义 `y + height/2`，龙 `y`（与 `enemy-roster` 同语义，但从各 config
   的 `height` / `DRAGON_CORE_OBB.halfExtents[1]` 直接派生，不 import 测试侧名册）。
3. **只用一个注入函数**：`cameraSpaceFn`。它既能判屏内屏外（下面第 4 条），又能算边缘方位
   （§5.4）⇒ **不注入第二个透视投影函数**（两个函数就是两套口径，漂移时无法察觉）。
4. **屏外判据**（与 §5.4 同一公式，`cz < 0` 才是前方）：
   `cz >= -0.05`（相机背后，与 `DamageNumbers` 同阀值）→ 屏外；
   否则算 `sx/sy`，`|sx| > 1 || |sy| > 1` → 屏外（NDC 超出 ±1）。
5. 每类取**欧氏距离最近**的那只作为箭头指向目标，`count` = 该类**屏外**总数（不是全场总数 ——
   已经看得见的那几只不该计进「还没找到」）。
6. `distance` = 玩家到该目标的三维欧氏距离，向下取整显示为 `NNm`。

### 5.4 边缘位置与角度（`arrowPlacement`）

**输入**：相机空间坐标 `[cx, cy, cz]` + 视口 `vw/vh` + 垂直半 FOV 的正切 `tanHalfFov`
（= `tan(camera.fov·π/360)`，由装配层每帧读，不写死 70）。

**一个公式管全部情形**（屏外 / 背后 / 正后方）：

```
sx = cx / (|cz| · tanHalfFov · aspect)      // aspect = vw/vh
sy = −cy / (|cz| · tanHalfFov)              // 屏幕 y 向下 ⇒ 取反
dir = normalize(sx, sy)
```

- 用 `|cz|` 而不是 `cz`：**背后（cz>0）与前方（cz<0）共用同一套符号**。
  相机空间 `+x` 恒为相机右侧 ⇒ 背后偏右的敌人箭头也在右边（转身向右就能找到它）。
  写两套符号（背后再翻一次）是本设计最容易错的地方，**不得引入**。
  前方时该公式与真实透视投影同值（只差一个正比例因子）⇒ 与玩家看到的方位一致。
- `|cx|` 与 `|cy|` 同时近 0（正前/正后方）或 `|cz|` 近 0 时退化：`dir = (0, 1)`（指向下边）。
  正后方无唯一正解，任何稳定选择都可接受，但**不得产出 NaN**。
- 从屏幕中心沿 `dir` 作射线，与**内缩矩形**求交（取两个轴上较小的 `t`）⇒ 箭头中心；
  角度 = `atan2(dir.y, dir.x)`。
- 角度以 CSS `rotate(deg)` 表达，0° = 指向右（三角默认朝右画）。
- **内缩量按侧区分**（载荷性：一个常数容不下水平读数行）：
  上下边 `ARROW_MARGIN_Y_PX = 30`（三角 14 + 读数行 16），
  左右边 `ARROW_MARGIN_X_PX = 62`（读数行 `×3 137m` 在 11px monospace 下实测约 53px）。
  读数行摆在箭头**朝屏幕内侧**那一面，故左右两侧需预留它的宽度。
- **文字不跟着转**：三角旋转，读数行始终水平（转过的数字读不出来）。故 DOM 结构是
  外层定位容器（不旋转）→ 内层三角（旋转）+ 读数 `<span>`（水平，朝屏幕内侧偏移）。
- **跨类重叠**：五类可能指向同一方位（都在背后同一侧）。按固定顺序（尸/兵/龙/守/焰）
  沿边缘做**最小间距推开**（`ARROW_MIN_GAP_PX = 34`），只沿边缘切向平移，不改指向角度；
  推完仍钳在内缩矩形内（钳制到边界，不得推出屏幕）。

### 5.5 远近透明度（`arrowOpacity`）

`opacity = clamp(1 - (d - NEAR) / (FAR - NEAR), MIN, 1)`，`NEAR = 16`、`FAR = 160`、`MIN = 0.35`。
16 格内实心，160 格外恒 0.35（仍可辨认，不消失）。非法距离按最近算（不产 NaN —— NaN 写进
`style.opacity` 会被浏览器静默忽略，形态是「箭头卡在上次亮度」）。

### 5.6 刷新节奏与成本

- **几何每帧算**（转视角时箭头必须跟手，节流会看出滞后）；5 类 × 一次投影 = 每帧个位数运算。
- **DOM 只在值变了才写**（位置取整到 1px、角度取整到 1°、opacity 保留 2 位）——
  静止不动时零写入。
- 实体集合遍历每帧一次（几十项），与 `entityLayer.sync` 同量级。
- 无敌人时 `update()` 只做一次 `entities` 空遍历 + 5 次 `display` 比较。

### 5.7 层级与生命周期

- `z-index: 52`：高于血心/计数行/看板（50），低于伤害数字（55）与红闪（56）。
  理由：它是常驻信息，不该被看板底色盖住；但瞬时反馈（数字/红闪）优先。
  更新 `CLAUDE.md` 不等式为 `… = Boss 提示 50 < **敌人方位箭头 52** < 伤害数字 55 < …`。
- 挂 `#hud-root` 下，`pointer-events:none`，容器 `position:fixed;inset:0;overflow:hidden`。
- `dispose()` 摘节点（纯 DOM，无 GPU 资源、无监听）。
- 实体 despawn / column 卸载 → 下一帧遍历自然不含它 ⇒ 箭头消失，无需事件订阅。

## 6. 验证计划

**Tier 1（Node，纯函数）** `src/tests/test-enemy-arrows.js`
- 配色表五项齐全、色值互不相同、与各 config 的 type 常量绑定（不写字面量）。
- 屏外判据：屏内点不产箭头；NDC 超 ±1 产；`cz ≥ -0.05`（背后）产。
- 每类取最近 + count = 屏外数（构造「一只屏内 + 两只屏外」夹具，钉 count=2 且指向近的那只）。
- 士兵留尸排除（`state.dead:true` 的士兵不得进候选）。
- 边缘求交：八个方向（四正 + 四斜）落点都在内缩矩形边界上，角度与方向一致。
- **背后方位**：`cz>0` 且 `cx>0` → 箭头在右半屏；`cz>0` 且 `cx<0` → 左半屏（钉住 `|cz|`）。
- **前向一致性**：同一世界点用**独立写的**透视式 `x/(−z·tan·aspect)` 算出 NDC，
  与本模块的屏外判据逐位一致（对照式不得 import 被测公式）。
- 正后方（cx=cy=0）与 cz=0 都不产 NaN，且落点仍在屏幕内。
- 非正方形视口（aspect≠1）下水平方向不被拉伸错（斜 45° 的点在 16:9 下应更靠近左右边）。
- 透明度包络：近端 1、远端 0.35、单调不增、NaN/负值钳制。
- 龙体心 vs 脚底语义：同一 `position.y` 下龙的锚点 y 不等于其它四类（防漏改三元链）。

**Tier 3（E2E，真实页面）** `tests/enemy-arrows.spec.mjs`
- 元素存在、挂 `#hud-root`、`z-index=52`、`pointer-events:none`。
- 真实召唤丧尸在**玩家背后**（按 yaw 算落点）→ 该类箭头出现，颜色 = 绿，位置在边框内缩带内。
- **背后的左右正确性**（不是镜像）：敌人在玩家右后方 → 箭头中心在屏幕右半；
  左后方 → 左半。判据取**真实几何**：用 `camera.matrixWorldInverse` 独立算一遍相机空间 x 的符号，
  与箭头所在半屏比对（不读被测模块自己算的值）。
- 转向面对它（改 `player.yaw`）→ 箭头消失（同屏内判据）。
- 数量对账：召唤 3 只全在屏外 → 读数 `×3`，与 `entities.count('zombie')` 独立对账。
- 士兵留尸：打死一只后 400ms 内箭头 count 已减 1（尸体仍在其集合里）。
- 五类颜色各自可辨：召唤焰魔（`ignises.summon`）→ 黄色箭头。
- 距离读数与真实欧氏距离一致（±1m）。
- 层级：打开设置面板后箭头被面板盖住（DOM 层级 + 像素取样任一）。

**负向验证（必须真 FAIL，注入用 `edit` + 读回确认，还原用 `cp` 副本）**
1. 去掉「相机背后」判定（`cz >= -0.05` 改成 `false`）→ 背后敌人箭头消失（E2E 红）。
2. 背后符号翻转（`|cz|` 改回 `cz` 并额外取反 sx）→ 背后左右用例红。
3. 去掉士兵 `dead` 过滤 → 留尸用例红。
4. count 改成全场总数 → 数量对账用例红。
5. 每类取最远而非最近 → 指向用例红。
6. 透明度写成常数 1 → 包络单测红。

**门禁**：`npm run check`（arch + data + lint）；Node 轻档 `--only=test-enemy-arrows.js` 起步，
再跑 `npm run test:unit`；E2E 只跑 `tests/enemy-arrows.spec.mjs` + `tests/enemy-counts.spec.mjs`
（共享装配段邻居）。**不跑 `npm test`**（本改动不属全局基础设施，非里程碑收尾）。
不碰 mesher/materials/render-world/scheduler/physics ⇒ 不跑 bench。

## 7. 留给实施者的

- 三角的具体 CSS 画法（border 技巧 vs clip-path）与三角尺寸微调（基准 14px）。
- 读数行的排版细节（`×3` 与 `37m` 之间的间距、字号 11~12px）。
-  DOM 池的实现细节（5 个常驻槽，按 key 索引）。
- 单测/E2E 的具体断言措辞与夹具落点搜索。