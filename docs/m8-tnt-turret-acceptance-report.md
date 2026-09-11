# M8 TNT 爆炸 / 炮塔弹丸 验收报告

**日期：** 2026-09-11 ｜ **规格：** `docs/superpowers/specs/2026-09-11-m8-tnt-turret-design.md` ｜
**计划：** `docs/superpowers/plans/2026-09-11-m8-tnt-turret.md` ｜ **状态：** ✅ 实施完成（未提交，待用户授权）

> ⚠️ **创造台（playground）已拆到 M9**，本报告不含创造台（`indestructible` 表 M8 只登记
> `bedrock`，创造台两项移交 M9）。用例计数以 `npm run check:data` 输出为准，本报告不硬编码
> （CLAUDE.md：同一事实的多个副本会漂移）。

## §1 交付摘要

三个 mc-lite 既有玩法在 mc-heavy 用 M4~M7 底座重做，全部走既有管线（无新开 Worker / 子系统）：

1. **TNT 引爆与爆炸**：`src/voxel/explosion.js`（同构纯函数）+ `Game.explodeTnt()`（唯一入口 +
   去重）+ `explosion-renderer.js`（球体扩张特效）+ 面板「TNT 破坏」开关（默认关）。3×3×3 破坏
   + 5×5×5 连锁（确定性抖动）+ 4 格 50 伤害（经 `ZombieService.damage`）。
2. **炮塔装置层**：`turret-config/blueprint/service/controller`（复用 M7 方块锚定装置模式）+
   背包放置分流（`CREATIVE_SPECIALS`）+ 平面图标。11 格结构、20 上限（edits store 扫库）、
   `block-changed` 增量失效。
3. **炮塔 AI + 弹丸**：`turret-system.js`（主线程索敌纯函数 + LOS）+ `turret-controller` 朝向
   插值/开火节流 + `projectile-system.js`（M5 临时实体 + DDA 阻挡 + 实体 raycast）+
   `projectile-renderer.js`（实例池）。8Hz 索敌、三发 34 伤害、40 格/秒。

## §2 规格逐项对照

| 规格节 | 要求 | 实测结果 |
|---|---|---|
| §1 `indestructible` 权威 | registry typed 表 + 三消费者；只登记 bedrock | ✅ `[不可破坏] 1 项：bedrock`；挖块/枪械/爆炸三消费者读同一表 |
| §2.1 爆炸计算 | 同构纯函数、主线程、152 次查询 | ✅ `computeExplosion` 无 DOM/three（check:arch 守） |
| §2.2 引爆入口 + 连锁 | 两条路径 + 去重 + 确定性延迟 | ✅ 左键挖块 / 枪击命中 / 连锁到期三路径共用 `explodeTnt` 去重 |
| §2.3 破坏开关 + 伤害 | 默认 false、4 格 50 伤害 | ✅ 默认关；半径内 50、半径外 0（E2E 双向断言） |
| §2.4 视觉音效 | 球体扩张 + explosion.mp3 | ✅ 0.3s/targetScale 5.0/pow(1-t,1.5)；无活跃时 visible=false |
| §3.1 结构锚点 | 11 格、锚点 origin.y+2 | ✅（⚠️ 底座 dy=1，见 §5 偏离①） |
| §3.2 失效上限 | 增量失效、20 上限扫库 | ✅ `newId !== critical.id` 判据；上限来自索引非 controller 数 |
| §3.4 背包分流 | alias → 装置放置 | ✅ E2E 走背包面板点击路径 |
| §4.1 AI 主线程 | 同构纯函数、不走 Worker | ✅ 规格 §4.1 三选项实测对比，LOS 留主线程 |
| §4.2 数值口径 | 逐项对齐 TURRET_CONFIG | ✅ 14 项逐项实测；不做 ×60 换算 |
| §5.1 炮塔渲染 | 单纹理 UV 分区 + 8 部件池 | ✅ Tier 4 像素实测三区可区分 |
| §5.2 弹丸 | M5 实体 + DDA + 34 伤害 | ✅ 三发死、透明穿透、超距消失 |
| §5.3 弹丸渲染回收 | 差集驱动 slot | ✅ E2E 验回收后 slotCount 归零 |
| §6 验收口径 | TNT + 炮塔 + 回归门禁 | ✅ 全绿（见 §3） |
| §8 设计文档同步 | v1.39 + 三项新机制 | ✅ §4.1/§4.5.5/DR-17/§9 已落 |

## §3 实测数据

**门禁三件套全绿：**

- `npm run check`：check:arch ✓（红线全守住）、check:data ✓（含新增 `[不可破坏]` /
  `[炮塔装甲]` 两环节）、lint **0 errors**（9 warnings 全是既有 mesher 的 camelcase —— 本 Epic
  **未新增任何 warning**：`projectileDefinition.update` 的第三参数刻意不消费，按 eslint 的
  `/^_/` 约定命名 `_context`）。
- `npm test`：**108 passed**（全量 Playwright，含本 Epic 新增 tnt/turrets/turret-render/
  projectiles 四个 spec）。
- `npm run bench -- --check`：**通过，无显著回退**。四场景：

| 场景 | fps | frameP95 | drawCalls |
|---|---|---|---|
| ① 平原冲刺 | 120.43 | 9.3 | 496 |
| ② 城市中心环视 | 120.18 | 9.2 | 558 |
| ③ 连续放/挖 200 块 | 108.34 | 16.7 | 558 |
| ④ 模拟 TNT 批量删 500 块 | 119.37 | 9.3 | 530 |

（bench 场景无炮塔/弹丸/爆炸在场，故 draw 与基线同量级 —— M8 的三个实例池在无活跃实例时
全部 `visible=false`，不进渲染列表。）

**单测：** 499 passed（浏览器内 runner；本 Epic 新增 test-explosion / test-turrets /
test-projectiles 三个文件）。

**炮塔索敌开销**（规格 §4.1 最坏情况）：20 炮塔 × 20 丧尸 × LOS 采样，8Hz 节流 + `distSq`
粗筛先于 LOS。索敌在主线程同步执行，帧循环 bench 无回退（④ 场景 p95=9.3 与基线 9 同量级）。

## §4 draw call 对照表

实测探针（`?vd=2&seed=12345`，隔离场景 drawCalls 基线 53）：

| 状态 | M8 实例池 visible | drawCalls | 增量 |
|---|---|---|---|
| idle（无炮塔/弹丸/爆炸） | 0/9（8 炮塔部件 + 1 弹丸池全 false） | 53 | 基线 |
| 放 1 个炮塔 | 8/9（8 部件可见） | 61 | **+8** |
| 爆炸特效活跃 | 9/9（+ 爆炸球体池） | 64 | +1（爆炸池）+ TNT 方块移除的地形网格变化 |
| 爆炸结束 1s 后 | 8/9（爆炸池回 false） | 62 | 炮塔 +8 常驻，爆炸池已归还 |

⚠️ **三个实例池无活跃实例时全部 `visible=false`** 已逐条实测：炮塔 8 部件（idle m8Visible=0）、
弹丸池（count=0 时 poolVisible=false）、爆炸球体池（爆炸结束 draw 回落）。这是 CLAUDE.md
活跃约束（常驻 InstancedMesh 恒增 draw call）的落实 —— M6 六部件实测教训的同款防护。

## §5 偏离表

**规格已列的有意偏离**（§2.5 / §3.2 / §5.2）全部按规格实施，不赘述。以下为**实施中新发现的
偏离与修正**（均为实测必需，照 M7 验收报告 §4 同手法记录）：

① **炮塔底座 dy=1（阻断级矛盾修正）**：规格 §3.1 说底座落在 `origin.y`、又说 origin =
`blockPos`（solid 地面格），而 `occupied` 预检要求 11 格全空气 —— 三者矛盾，实测
`placeTurret([ox, groundY, oz])` 恒返回 `occupied`（炮塔完全放不下去）。修正为底座 dy=1
（坐在地面格之上，不替换地形），与 mc-lite `_getBlockPositionFromHit()`（返回命中方块 + 法线
的相邻空气格）+ `canPlace()` 语义完全等价：mc-lite pivot = 空气格 y + 3.3 = 本仓库
`origin.y + 1 + 3.3`。锚点随之为 `origin.y + 3`。

② **TNT 连锁破坏过滤顺序修正**：破坏事务（④）跑在连锁入队（⑤）之前，计划写的过滤只查
`this._ignitingTnt` → 恒不命中。改成 mc-lite `:605-606` 的「已有去重键 ∪ 本批待爆项」合集
语义（`pending = new Set(_ignitingTnt)` + add 本批 chain）。否则待爆 TNT 被自己的破坏事务删掉
→ 连锁静默丢失。

③ **`muzzle()` pitch 符号 bug（E2E 实测抓到）**：炮塔朝下瞄准（pitch<0）时炮口方向 y 为正
（朝上）→ 弹丸往天上飞、丧尸恒 100 血。根因是红线 1 漂移：渲染层用 `Rx(-pitch)` 矩阵（正确），
`muzzle()` 自己另写一套旋转公式（符号错）。修正为 `y' = +mz·sin(pitch)`（与渲染层同源），
并补一条「muzzle 方向 == 渲染矩阵炮口位置」的交叉比对断言（只读渲染矩阵的单测测不到本方法）。

④ **计划缺 `TURRET_PART_DEFS` 等完整定义**：计划把部件定义指向 `turret-config.js` 但未给完整
代码。按 mc-lite `Turret.js` 实测数值补齐（尺寸/位置/rotX/区归属/颜色逐项），并收进 config 作
单一权威（渲染层/烘焙/门禁三方派生）。

⑤ **弹丸池容量提为 config 派生值**：计划写死 `maxActive=64`。改成 `TURRET.projectilePoolSize`
派生（红线 1：单测不传 maxActive 时钉的是本值，注入「渲染层写死别的数」会被抓到）。

⑥ **`raycastVoxel` 加 `occludes` 第五参数**（选项 A）：弹丸「实心且不透明才阻挡」判据与缺省
「非空气非水」不同。加可选参数共用同一份 DDA（不写第二份 —— 红线 1），既有三消费者不传 →
行为不变。

⑦ **对齐 mc-lite TNT 是「读源码 + 推断意图」，不是实测对齐**（规格 §2.3 已注明）：mc-lite 的
TNT 运行时目前是坏的（`PlayerInteraction.js:620/686` 引用未声明的 `worldAccess` →
ReferenceError → 无爆炸/伤害/连锁）。故本 Epic 的 TNT 数值/语义对齐口径是读源推断，
**不宣称「实测对齐 mc-lite 爆炸行为」**。

### 实玩反馈修正（验收后用户实测发现，两处）

⑧ **炮塔无目标时不得开火（阻断级）**：实玩反馈「炮塔刚创建完就发射炮弹，视野内没有任何丧尸」。
根因是 `update()` 的开火门控**缺了「有无目标」这道门** —— 无丧尸时 `targetRotation` 回归默认
朝向、`targetPitch=0`，而 `currentRotation`/`currentPitch` 的初值恰好就是这两个值 → 角度差为 0、
冷却早已到期 → 刚放置就立刻开火，且丧尸消灭后继续无限打空气。mc-lite 的 `tryFire()` 第一道门控
正是 `if (!this.targetEnemy) return;`（`Turret.js:665`），本实现漏了它。

同时暴露一个**结构性缺陷**：`computeTurretUpdates` 只返回 `{targetYaw, targetPitch}`，没有
「是否找到目标」—— controller 无法区分「无目标回归默认」与「目标恰好在默认朝向上」（后者角度
差也是 0）。故光加门控不够，须两处一起改（红线 1 单一权威）：
- `computeTurretUpdates` 返回 `hasTarget` / `targetId`（无目标时显式 `false`/`null`）；
- `update()` 第一道门 `if (!this.targetId) return false`；`_runTurretAi` 写回 `targetId`。

验证：新增 3 条单测 + 1 条 E2E（正是该反馈场景：放置后静默 3 秒 → 丧尸出现开火 → 消灭后停火）。
负向验证「移除目标门控」→ E2E 与单测双层真 FAIL。两条既有测试原本没设 `targetId`，已显式补上
（它们本意测「瞄准 + 冷却」，须模拟「有目标」）。

⑨ **背包炮塔图标直接复用 mc-lite 手工原图，不再程序化生成**：实玩反馈「完全照搬 mc-lite 背包里
的炮塔贴图」。`faces-data.js` 原本把 `turret_alias_block` 指向程序化生成的
`procedural/turret_alias_block`（纯灰 `#808080`、177 字节、色数 1 —— 是我自己烘的假图），
改为 `'turret'`（`assets/textures/turret.png`，与 mc-lite `src/assets/textures/turret.png`
**字节完全一致**、362×322、已在 atlas 内）。

mc-lite 同口径：`ItemIconUtils.getCustomIconPath()` 把 `turret_alias_block` 映射到
`src/assets/textures/turret.png`（`:23`），与 `zombie_nest_alias_block` 同一手法（后者本仓库
早已是手工图，故炮塔此前是唯一不一致的那个）。验证：指纹变为 `flat;t:turret#1fomudi`，图标色数
562（对照程序化假图色数 1）；`[图标过期] 118 项指纹全部匹配`、`[形状权威] 102 等轴测 + 16 平面`。
⚠️ **未新增任何图形生成** —— 只是把引用指向既有原图 + 重烘图标 atlas（既有流程）。
`tools/bake-procedural-textures.mjs` 里的 `textures.turret_alias_block` 生成代码已无消费者
（残留，见 §7）。

## §6 负向验证清单

共 **33 条注入**，逐条确认**真 FAIL**（做完均恢复源码，用备份/恢复而非 `git checkout`）：

- **Task 1（indestructible，5 条）**：register 漏写表 / blocks-data 无条目 / 表→声明多标 /
  digBlock 门控删掉 / digBlock 恒真。check:data 的 `[不可破坏]` 双向断言 + 单测「零写入 vs
  一次写入」配对。
- **Task 2（TNT，5 条）**：伤害漏接线 / 默认破坏=true / 连锁 dueAt 用 Date.now / 自身移除塞进
  破坏开关（→ 连锁永不终止）/ 伤害改全量枚举 entities()（probe 对照）。全部落在真游戏页 E2E。
- **Task 3（炮塔装置，6 条）**：onPlaced 删 / 装配挪到 `_waitForColumn` 后（钉 seed + 出生点
  column 落点后才确定性可抓）/ CREATIVE_SPECIALS 移除 / origin 用 prevPos / 失效判定去 newId /
  FLAT_BLOCKS 移除（图标）。
- **Task 4（AI，5 条）**：LOS 恒 true / 索敌不做 LOS / 冷却用 Date.now / isProjectileOccluding
  只判 solidTable / 不做最近判定（丧尸须「近在前」否则无效盲区）。
- **Task 5（渲染，4 条）**：zoneIndex 恒 0（Tier 4 三区取样）/ armor.json 指纹写死 /
  visible=false 删（构造后未 sync 路径）/ pitch 不取反。
- **Task 6（弹丸，7 条）**：update 原地改写（跨 column 索引迁移）/ 双点采样（斜射+步长尖峰）/
  伤害改 50 / 超距后置 / 两处推进（速度翻倍）/ onFire 不接线 / muzzle pitch 符号反。
- **实玩反馈修正（1 条）**：移除「无目标不开火」门控 → E2E「放置后静默 3 秒」与单测「刚放置时
  不得开火」**双层真 FAIL**（见 §5 ⑧）。

**自查发现并修正的无效盲区**（testing-policy §2.7）：

- 索敌「最近判定」：两只丧尸须**近在前**，否则注入版本选中「最后遍历到的」恰好是近的 → 全绿。
- UV 分区断言容差：UV 存 Float32，1e-9 容差会因存储精度假失败 → 改 1e-6。
- yaw 反解部件：带 `rotX` 的 `front` 部件矩阵不是纯 Y 旋转 → 反解失真，改用无 rotX 的 `top`。
- Tier 4 取样点：front 中心被根部白色部件遮挡 → 读到 (238,238,238)，取样点偏离中心避开遮挡。
- 弹丸斜射测试：步长 ≤ 墙厚时终点必落墙格 → 双点采样也能抓到，改「斜射 + dt 尖峰」组合。
- 弹丸 fixture：只加 column (0,0) 时丧尸落点跨到 cz=1 → spawn 返回 null，须加载 cx/cz∈[0,1]。
- TNT/炮塔 spec 钉 seed：不钉 seed 时出生点随 region 变化，「装配挪后」注入时抓时不抓。
- `shortestAngleDiff(π,0)` / `normalizeAngle(π)`：π↔0 是平局（符号任意），断言落幅度而非符号。

## §7 遗留 TODO

- **弹丸池容量 64 须实测峰值重标定**（照 cutout 容量教训）：当前按「20 炮塔 × 寿命 1.25s ÷
  冷却 500ms ≈ 50 → 取 64」推导，bench 无回退，但 20 炮塔齐射的峰值未单独压测。
- **炮塔 AI 留主线程是红线 3 的第二个边界判定例外**（第一个是爆炸计算）：若未来世界数据可
  后台化，这条须重新判定（规格 §4.1 已注明）。
- **创造台（playground）移交 M9**：`indestructible` 表 M8 只登记 bedrock；M9 追加创造台两项 +
  移出背包（成对做），并把 `test-weapons.js` 三条断言翻回 `assertFalse`。
- **`tools/bake-procedural-textures.mjs` 里 `textures.turret_alias_block` 的生成代码已无消费者**
  （§5 ⑨ 把图标改指向 mc-lite 手工原图后，程序化假图不再被任何地方引用）。残留的 177 字节纯灰
  PNG 与那段生成代码可在后续清理 —— 未顺手删是因为它属 `bake-procedural-textures.mjs` 的产物链
  （删了须同步删 atlas 里的 tile 与产物文件，属独立小改动），且不影响任何门禁与渲染。

## §8 操作失误记录（如实）

验证 TNT 注入②时误用 `git checkout src/core/game.js`，冲掉了该文件的全部 M8 接线。从
`/tmp/game.bak` 恢复并重做炮塔接线，最终状态已验证一致（门禁 + 全量回归全绿）。后续所有注入
改用备份/恢复，不再用 `git checkout`。
