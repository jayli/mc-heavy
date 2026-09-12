# M8 TNT 爆炸 / 炮塔弹丸 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **实施状态（2026-09-11）：** Task 0~7 全部完成并已提交（`1b74281`）。
> 验收报告 `docs/m8-tnt-turret-acceptance-report.md`。
> 全量回归 108 passed、单测 499 passed、bench 无回退、check:arch/data 全绿。
> 实施中与本计划的偏差（均为实测必需，详见验收报告 §5）：
> ① 炮塔底座 dy=1（规格「底座 origin.y」+「origin=blockPos」+「occupied 全空气」三者矛盾，
>    实测恒 occupied → 底座上移一格，与 mc-lite 空气格语义等价）；
> ② TNT 连锁破坏过滤改用「已有去重键 ∪ 本批待爆项」合集（计划的过滤只查 `_ignitingTnt`
>    恒不命中）；③ `muzzle()` pitch 符号修正（E2E 抓到弹丸往天上飞）+ 补交叉比对断言；
> ④ `TURRET_PART_DEFS`/`ARMOR_ZONES`/`TURRET_TOWER_COLOR` 等定义补齐进 turret-config.js；
> ⑤ 弹丸池容量提为 `TURRET.projectilePoolSize` 派生（不写死 64）；
> ⑥ `raycastVoxel` 加 `occludes` 第五参数（共用一份 DDA）。

**Goal:** 交付 TNT 引爆与爆炸、玩家放置炮塔（自动索敌 + 飞行弹丸命中丧尸掉血）两个 mc-lite 已有玩法。

> **创造台已拆到 M9**（`docs/superpowers/plans/2026-09-11-m9-playground.md`）。M8 只交付 `indestructible` 表（登记 bedrock），M9 复用该表并追加创造台两项。

**Architecture:** 三者共用 M4~M7 底座 —— `WorldEditor.setBlocks()` 是唯一世界写入入口（爆炸破坏 / 炮塔结构 / 平台生成三条路径都走它）；炮塔复用 M7 的方块锚定装置模式（`blockEntity` 为持久真相 + `block-changed` 增量失效 + `listBlockEntities` 扫库判上限）；弹丸走 M5 `EntityManager` 临时实体；丧尸伤害一律经 `ZombieService.damage()`。新增一份 `indestructibleTable` typed 属性表作为「哪些方块不可破坏」的单一权威。

**Tech Stack:** ES2022 ESM、JSDoc、WebGPU（three r185.1 本地 vendor）、WorkerPool RPC、IndexedDB、离线烘焙 + 指纹门禁、浏览器内单测 + Playwright。

**Spec:** `docs/superpowers/specs/2026-09-11-m8-tnt-turret-design.md`（**计划从规格推论，执行者两份都要读**）

## Global Constraints

- **红线 1**：数据只有一份权威。禁止第二份逻辑副本、多层缓存、「渲染态与逻辑态分离」的容器。派生对象（索引 / controller / 渲染 slot）不得当真相。
- **红线 2**：seed 确定性生成。禁止 `Math.random()` 参与任何生成期判定（连锁延迟、图案散列一律用坐标/id 派生的确定性散列）。
- **红线 3**：重计算离开主线程。本 Epic 的例外须在验收报告说明理由 —— 爆炸计算（152 次查询，须与音效同帧）。
- **红线 6**：地形交互走体素 DDA（`raycastVoxel`），实体命中只由 `EntityManager.raycast()` 给出。禁止 `THREE.Raycaster.intersectObjects`。
- **红线 7**：Worker 任务携带 `(columnKey, columnVersion)` / `(id, generation)`，回传不符即丢弃。
- **红线 8**：主线程/Worker 同构纯函数。`src/entities/**` 与 `src/voxel/**` 不得 import three、无 DOM。`src/workers/**` 不得 import three（module worker 不继承页面 import map）。
- **红线 9**：WebGPU 唯一后端 —— 不支持「InstancedMesh + 材质数组 + `geometry.groups`」，多面不同图案一律走单材质 + 单纹理 + UV 分区。
- **时间基准一律 `performance.now()`**，禁止 `Date.now()`（两者相差约 17 亿毫秒 → 到期判定恒真）。
- **`WorkerPool.call()` 返回 `{id, promise}`**，消费回包必须取 `.promise`；fake pool 必须返回同形状。
- **常驻 InstancedMesh 无活跃实例时 `visible=false`**（否则每个恒增 1 个 draw call）。
- **玩法服务的 controller 接线必须在 `_waitForColumn` 之前**，且须有「放置成功即建 controller」的 `onPlaced` 回调。
- **先 RED 后 GREEN**；Tier 1 改动禁止跳步或省略失败验证。**每个提交都必须等用户明确授权。**
- 计划中标注「冻结」的断言数字实测不符时**停下来报告，不要擅自改断言或静默放宽**。

---

## 文件责任图

```text
Task 0（文档同步，无代码）
  docs/phase-1-engine-design.md    §4.1 indestructibleTable / §4.5 爆炸小节 / DR-17 回填 / §9 扩展点
  docs/roadmap.md                  里程碑总表加 M8 行
  CLAUDE.md                        M8 活跃约束（⚠️ **物品集合口径 118 项 M8 不动** —— 移交 M9）

Task 1（不可破坏权威）
  src/voxel/blocks-data.js         bedrock 加 indestructible（创造台两项移交 M9）
  src/voxel/block-registry.js      indestructibleTable + isIndestructible(id)
  src/player/player.js             digBlock() 改读表
  src/player/weapons/weapon-target-policy.js  IMMUNE_NAMES 收敛为读表（保留 end_stone 武器专属例外）
  tools/check-data.mjs             新增 [不可破坏] 环节

Task 2（TNT）
  src/voxel/explosion.js           computeExplosion 同构纯函数
  src/render/explosion-renderer.js 球体扩张特效
  src/player/player.js             左键引爆路径（薄路由 → game.explodeTnt）
  src/player/weapons/weapon-controller.js  枪击引爆路径
  src/core/game.js                 canTntDestroyBlocks + 连锁队列 + 爆炸装配
  src/ui/settings-panel.js / settings.js   「TNT 破坏」开关
  tests/tnt.spec.mjs               真游戏页引爆 + 破坏开关 + 连锁 E2E

Task 3（炮塔装置层）
  src/entities/turrets/turret-config.js     TURRET 冻结玩法数据（唯一权威）
  src/entities/turrets/turret-blueprint.js  11 格结构展开 + 唯一锚点校验
  src/entities/turrets/turret-service.js    全局索引 + 预检 + 原子放置 + hydrate
  src/entities/turrets/turret-controller.js block-changed 失效 + 开火时钟写回
  src/player/player.js             CREATIVE_SPECIALS 加 turret_alias_block
  src/core/game.js                 turrets hydrate / column 生命周期 / onPlaced 接线
  tools/icon-fingerprint.mjs       FLAT_BLOCKS 加 turret_alias_block
  tests/turrets.spec.mjs           **背包选中路径**放置 + reload 恢复 E2E

Task 4（炮塔 AI）
  src/entities/turrets/turret-system.js     computeTurretUpdates 同构纯函数（索敌 + LOS）
                                           **主线程执行** —— worker 内无持久世界数据（规格 §4.1）
  src/entities/turrets/turret-controller.js  朝向插值 + 开火节流（主线程）
  src/core/game.js                 AI 编排（8Hz accumulator）

Task 5（炮塔渲染）
  tools/bake-turret-armor.mjs      三张装甲贴图 → 单张多区并排纹理（npm run turret）
  tools/turret-armor-fingerprint.mjs  图案参数与指纹单一权威
  assets/turret/*                  三张源贴图（从 mc-lite 拷入）+ 烘焙产物 armor.png/json
  src/render/turret-armor-texture.js / turret-renderer.js  纹理加载 + 8 部件实例池 + UV 分区
  tools/check-data.mjs             新增 [炮塔装甲] 环节
  tests/turret-render.spec.mjs     Tier 4 像素实测

Task 6（弹丸）
  src/entities/turrets/projectile-system.js  projectileDefinition（直线推进）
  src/render/projectile-renderer.js          固定 slot InstancedMesh（圆柱）
  src/entities/turrets/turret-controller.js  发射接线（炮口位置 + 方向）
  src/player/raycast.js            raycastVoxel 加 occludes 第五参数（弹丸遮挡判据，不写第二份 DDA）
  src/render/audio-manager.js      SOUND_IDS 加 turret_gun_fire
  src/core/game.js                 projectile 类型注册 + 渲染层装配（slot 差集驱动回收）
  assets/sounds/turret_gun_fire.mp3  从 mc-lite 拷入
  src/tests/test-projectiles.js    推进 / DDA 阻挡 / 实体命中 / 伤害换算单测
  tests/projectiles.spec.mjs       弹丸命中丧尸掉血 E2E

Task 7（验收）
  docs/m8-tnt-turret-acceptance-report.md  实测数据 + 偏离表 + 负向验证清单
  docs/roadmap.md                  回填 M8 commit hash
```

---

### Task 0: 设计文档与协作规范同步

**Files:**

- Modify: `docs/phase-1-engine-design.md`（§4.1 / §4.5 / DR-17 / §9 / 修订说明 + bump 版本号）
- Modify: `docs/roadmap.md`（里程碑总表）
- Modify: `CLAUDE.md`（背包物品集合口径 + M8 活跃约束）

**Interfaces:**

- Consumes: 规格 §8 的三项新机制清单
- Produces: 后续任务引用设计文档时的章节号（实施中若发现章节号不符，按实际章节走并在验收报告记录）

本任务是 CLAUDE.md 规则「需要新增机制/改动设计时，先更新设计文档再动代码」的落实，**无代码改动**，故不走 TDD。

- [ ] **Step 1: 在设计文档 §4.1 体素数据层补 `indestructibleTable`**

⚠️ **§4.1 里没有「typed 属性表清单」这个东西**（实测：§4.1 的「存储」段描述的是 `ChunkColumn`
的字段 —— `blocks`/`meta`/`edits`/`blockEntities`/`light`；registry 的属性表只在散文里点名
过 2 张，带省略号）。**不要写成「在清单里加第五张表」** —— 那会往设计文档里写进一个假前提。
代码里实际有 **7 张表**（`block-registry.js` 实测 `Table = new Uint8Array` × 7：
solid / opaque / cull / emissive / geometry / orientationModes / supportsPlayer），
新增后是 8 张。正确做法：在 §4.1 的存储段**新增一小段**介绍这张表，并顺带把 8 张表的
完整清单写出来（补上文档欠账）。要写入的内容：

```markdown
**registry 的属性表（8 张 typed 表，主线程与 Worker 同构可用）**：`solidTable` /
`opaqueTable` / `cullTable` / `emissiveTable` / `geometryTable` / `orientationModesTable` /
`supportsPlayerTable` / **`indestructibleTable`（M8 新增）**。每张表由 `register(name, def)`
从声明派生，`freeze()` 后不可变。

**`indestructibleTable`（M8 新增）**：「哪些方块不可被破坏」的唯一权威。
三个消费者全部读这张表，不得各写字面量：① `Player.digBlock()` 徒手挖块门控；
② `weapon-target-policy.js` 枪械可破坏判定（与 `settings.gunBlockDamage` 开关叠加，链路：`game.setGunBlockDamage()` → `weaponController.setBlockDamage()`，
   其 `end_stone` 例外是**武器专属**收紧，仍留在该模块）；③ `computeExplosion()` 爆炸过滤。
mc-lite 的表达是**分散且不重合**的：`ExplosionWorker.js:8` 的字面量数组
`['playground_block','playground_center_block','bedrock','barrier']`，与
`BlockData.js:244/252` 的 `isIndestructible: true` 字段 —— 后者**只标了 playground 两项**
（bedrock/barrier 只在字面量里）。即「哪些不可破坏」在上游没有一个完整清单，
本仓库收敛成一处权威。
**M8 只登记一项：`bedrock`**（TNT 爆炸过滤需要）。`playground_block` /
`playground_center_block` 两项移交 M9 —— 登记 indestructible 与「移出背包」必须成对做
（只登记不移出会产出「放得出来但挖不掉」的撕裂状态），故两项一起留在 M9。
```

- [ ] **Step 2: 在 §4.5 玩家与交互新增「爆炸计算」小节**

写明同构纯函数、归属层与**红线 3 的边界判定**（这是后人最容易误判的点）：

```markdown
**爆炸计算（M8）**：`src/voxel/explosion.js` 的 `computeExplosion()` 是**同构纯函数**，
在主线程同步执行，**不走 Worker**。判定依据：计算量 = 27 + 125 = 152 次 `getBlockId`
（3×3×3 破坏 + 5×5×5 连锁搜索），比 M7 放置 38 格结构还轻；且爆炸的方块破坏、音效、
特效必须**同帧**发生 —— 走 Worker 要等回包，玩家会先看到方块消失再听到爆炸声。
红线 3 禁的是「全量 meshing/AO/结构布局」这类主线程重计算，不含此类交互级查询。
归属 `src/voxel/` 而非 `src/gen/`：它是纯体素层查询，不是生成；且 voxel 是分层图最底层
（`voxel ← gen ← mesh ← render`），三个消费者都能 import 而不触发依赖方向门。
```

- [ ] **Step 3: 回填 DR-17 的 blockEntity 通道段 + 划掉 §9 扩展点表三行**

DR-17 原文已写「后续炮塔/床/宝箱等同类装置可直接复用此通道」，M8 是**第二批消费者**，
须回填实测结论：

```markdown
> **第二批消费者已由 M8 落地**：`turret`（炮塔锚点 `{kind:'turret', id, origin, critical,
> rotation, lastFireAt}`）。（`playground` kind 属 **M9** 范围，届时再回填。）
> 两个 kind（zombie-nest / turret）共用同一 edits 通道与
> `Persistence.listBlockEntities(kind)` cursor 扫库判上限，未引发 schemaVersion 变更 ——
> DR-17 当初预留的形状经第二批消费者验证够用。
```

⚠️ **三.6：设计文档 §9「后续功能扩展点」表的接入点表述与本计划不符，须改写**
（CLAUDE.md 明写「新功能必须通过上述接入点实现，不得绕过 meshing/数据/事件管线另开路径」，
不改写会让后续读者以为本计划绕过了规定接入点）。⚠️ **落点是设计文档
`docs/phase-1-engine-design.md` §9（`:2075` TNT 行 / `:2082` 创造台行），不是 roadmap** ——
roadmap 的对应两行已在拆分提交 `ed7abdd` 改好，勿重复改：

- 设计文档 §9 的 `| TNT / 爆炸 | ... + 粒子 |` —— 本计划**不移植粒子层**
  （mc-heavy 没有 ParticleSystem，只移植 `World.js:1301-1311` 的球体扩张层）。改写为
  「`WorldEditor.setBlocks(batch)` + REMESH + 球体扩张特效（mc-heavy 无粒子系统）」。
- 设计文档 §9 的 `| 创造台 | mesher 顶点模板机制 |` —— 属 **M9** 范围，本任务不动该行
  （M9 时改写为「`WorldEditor.setBlocks` 真实方块 + `blockEntity` 锚点（M7 装置模式）」）。

⚠️ **粒子层未移植须记进偏离表**（规格 §2.4 只在散文里提了，偏离表没列）—— 视觉比对时
mc-lite 有 2D Billboard 爆炸粒子而 mc-heavy 只有球体扩张，属可感知差异。

§9「后续功能扩展点」表把 `TNT / 爆炸`、`炮塔 / 飞行弹丸` 两行标为「✅ M8 已交付」
（创造台那行留给 M9）。

- [ ] **Step 4: bump 设计文档版本号 + 写修订说明**

⚠️ **本 Epic 的三项属架构口径变更**（新数据通道 / 新子系统边界），故须进修订说明并 bump
版本号 —— 与 M4~M7 的实玩反馈修正不同（那些**不进**修订说明）。**目标版本号 = v1.39**（现 v1.35；roadmap 的独立改动表已占用 v1.36/v1.37/v1.38，故 M8 取 v1.39、M9 取 v1.40 —— 避免撞号）。

- [ ] **Step 5: 同步 roadmap 与 CLAUDE.md**

roadmap 里程碑总表加 M8 行（内容 / 状态「📝 待实施」/ 关键 commit 留空待回填）；
后续扩展点表同步标注 TNT / 炮塔两行已交付（创造台留给 M9）。

⚠️ **CLAUDE.md 的「背包物品集合口径 118 项」这条活跃约束 M8 不动** —— 创造台两项移出背包
属 M9 范围（M9 时该数字变为 116、门禁打印变为「排除 10」，届时再改写）。M8 期间物品集合
仍是 118 项。

⚠️ **规格 §8 还要求同步「目录结构清单 + 开发命令清单」**（本任务不可漏）。CLAUDE.md 的
「文档同步」规则明写：新增产物或删除文件时，必须同步「目录结构清单」「开发命令清单」
「现状声明」三类文档。M8 新增的产物须进对应清单：

- **目录结构清单**（设计文档 §5）：`assets/turret/`（三张源贴图 + `armor.png`/`armor.json`）、
  `assets/sounds/{explosion,turret_gun_fire}.mp3`、`tools/bake-turret-armor.mjs`、
  `tools/turret-armor-fingerprint.mjs`、`src/entities/turrets/`（config / blueprint / service /
  controller / system / projectile-system）、
  `src/render/{turret-armor-texture,turret-renderer,projectile-renderer,explosion-renderer}.js`、
  `src/voxel/explosion.js`；（⚠️ **不含 `src/ui/toast.js`** —— toast 是 M9 的交付物，
  M8 阶段登记它会写进一个不存在的文件）
- **开发命令清单**：`npm run turret`（烘焙炮塔装甲纹理）；
- **现状声明**：CLAUDE.md 的「一句话现状」与 roadmap 的里程碑总表（Task 7 回填）。

同时在 CLAUDE.md 的 M7 段之后新增一段 M8 活跃约束：

```markdown
### M8 TNT / 炮塔沉淀的活跃约束（后续同类装置 Epic 必读）

- **「哪些方块不可破坏」的唯一权威 = registry `indestructibleTable`**：mc-lite 用
  `ExplosionWorker.js:8` 的字面量数组（含 bedrock/barrier）与 `BlockData.js:244/252` 的
  `isIndestructible` 字段（**只标 playground 两项**）—— 两处**分散且不重合**，上游没有
  一个完整的「哪些不可破坏」清单。
  三个消费者（徒手挖块 / 枪械破坏 / 爆炸过滤）都读这张表，各写一份会漂移出
  「TNT 炸得掉但玩家挖不掉」的撕裂语义。
- **炮塔/弹丸的速度类参数不需要 ×60 换算**（与 `ZOMBIE.speed` 相反）：mc-lite 的
  `ROTATION_SPEED`/`PITCH_SPEED`/`PROJECTILE_SPEED` 都乘 `deltaTime`（已是格/秒与弧度/秒），
  而 `Zombie.js` 的 `predictNextPosition` 不乘 dt（格/帧）。**照搬前须逐项核对是否乘 dt** ——
  这类缺陷肉眼难辨（实体照常动，只是速度不对），须靠 A/B 对照实测。
- **爆炸计算在主线程是有意的**（152 次查询 + 须与音效同帧），不要「优化」成 Worker 任务 ——
  会引入回包延迟让方块先消失后爆炸。理由记在设计文档 §4.5。
```

- [ ] **Step 6: 提交（仅获授权后执行）**

```bash
git add docs/phase-1-engine-design.md docs/roadmap.md CLAUDE.md
git commit -m "docs(m8): 设计文档同步——indestructible 权威 / 爆炸计算归属 / DR-17 回填"
```


---

### Task 1: `indestructible` 数据权威

**Files:**

- Modify: `src/voxel/blocks-data.js`（`bedrock` 加 `indestructible: true`）
- Modify: `src/voxel/block-registry.js`（新增 `indestructibleTable` + `isIndestructible(id)`）
- Modify: `src/player/player.js`（`digBlock` 门控改读表）
- Modify: `src/player/weapons/weapon-target-policy.js`（`IMMUNE_NAMES` 收敛为读表）
- Modify: `tools/check-data.mjs`（新增 `[不可破坏]` 环节）
- Modify: `src/tests/test-block-registry.js`
- Modify: `src/tests/test-weapons.js`（⚠️ **既有三条 playground 断言翻转**，见 Step 3 的 A8 说明）

**Interfaces:**

- Consumes: `createRegistry().register(name, def)`（既有；`def` 新增可选字段 `indestructible`）、
  `registry.idOf(name)` / `registry.nameOf(id)` / `registry.all()`
- Produces（后续任务与 M9 依赖，签名必须一致）:

```js
registry.indestructibleTable;          // Uint8Array(MAX_BLOCKS)，值 0/1
registry.isIndestructible(id);         // boolean；未知 id 返回 false
```

⚠️ **M8 只登记 `bedrock` 一项**（TNT 爆炸过滤需要）。**`playground_block` /
`playground_center_block` 两项移交 M9** —— 理由：`indestructible` 的登记与「移出背包」
必须成对做。M8 期间若只登记而不移出背包，会立刻产出撕裂状态（玩家在背包里选得到这两项，
放得出来但挖不掉、TNT 也炸不掉，而 M8 没有创造台功能可批量删）。反过来两项都不登记也不移出
（M8 现状）则无害。故两项一起留在 M9。**本任务不碰物品集合**（`HIDDEN_FROM_INVENTORY` 不动，
物品集合仍是 118 项）。

- [ ] **Step 1: 写失败的表契约与三消费者测试**

在 `src/tests/test-block-registry.js` 追加四条用例（`makeRegistry()` 若该文件里没有，照
`test-zombie-nests.js:24-29` 的同名 helper 定义）：

```js
test('indestructibleTable：bedrock 登记且可破坏方块判 false', () => {
  const registry = makeRegistry();
  // ① 表的单一权威：登记 bedrock
  assertTrue(registry.isIndestructible(registry.idOf('bedrock')));
  // ② **临界值附近断言**：可破坏方块必须判 false（不能把整表当恒真判据）
  assertEqual(registry.isIndestructible(registry.idOf('stone')), false);
  assertEqual(registry.isIndestructible(registry.idOf('tnt')), false);
  // ③ collider 系**不**登记（「不进背包」与「不可破坏」是两个互斥集合）
  assertEqual(registry.isIndestructible(registry.idOf('collider')), false);
  // ④ 未知 id 防御
  assertEqual(registry.isIndestructible(999), false);
  // ⑤ **M8 不登记 playground**（移交 M9）—— 钉住 M8 的范围边界
  assertEqual(registry.isIndestructible(registry.idOf('playground_block')), false);
});

test('digBlock 对 indestructible 方块零写入', () => {
  const { player, editor } = makePlayerFixture();
  const id = player.registry.idOf('bedrock');
  player.world.setBlock(4, 1, 4, id);
  player.target = { blockPos: [4, 1, 4], prevPos: [4, 2, 4], normal: [0, 1, 0], dist: 2 };
  const before = editor.calls.length;
  player.digBlock();
  assertEqual(editor.calls.length, before);            // 零写入
  assertEqual(player.world.getBlockId(4, 1, 4), id);   // 方块还在
});

test('isWeaponDestructible 读表而非字面量', () => {
  const registry = makeRegistry();
  assertEqual(isWeaponDestructible(registry.idOf('bedrock'), registry), false);
  assertEqual(isWeaponDestructible(registry.idOf('stone'), registry), true);
  // end_stone 是**武器专属**收紧（不在 indestructibleTable 里），须保留
  assertEqual(isWeaponDestructible(registry.idOf('end_stone'), registry), false);
});
```

`makePlayerFixture()` 须用**记录调用的 fake editor**（照 `test-zombie-nests.js` 里
`makeNestFixture` 的同手法：`{ calls: [], setBlock(c) { this.calls.push(c); ... },
setBlocks(cs) { ... }, setBlockEntity(r) { ... } }`），断言落在 `editor.calls` 上而非
直接看 world —— 那才是「零写入」的真实判据。

- [ ] **Step 2: 验证 RED**

Run: `npx playwright test tests/harness.spec.mjs`
Expected: FAIL —— `registry.isIndestructible is not a function`；`digBlock` 仍只硬拦 bedrock
（`editor.calls.length` 增加 1 —— 因为既有实现是硬编码 `idOf('bedrock')` 判定，改读表后行为
等价但实现不同，故这条断言在 RED 阶段仍可能通过；真正的 RED 是 `isIndestructible` 未定义）。

- [ ] **Step 3: 实现表与三消费者接线**

`src/voxel/blocks-data.js` —— 给 `bedrock` 加字段（其余条目不动）：

```js
{"name":"bedrock","solid":true,"cullMode":"opaque","orientationModes":0,"geometry":"box","indestructible":true},
```

⚠️ **不登记 `barrier`** —— 该方块在本仓 registry 里不存在（它对应 mc-lite 的 `collider` 系），
照搬会登记一个不存在的名字 → 门控静默失效。`collider`/`realistic_trunk_collider` 也不登记
（它们已在 `NON_PLACEABLE_ITEMS`，那是「不进背包」的事实，不是「不可破坏」的事实）。
⚠️ **不登记 playground 两项**（移交 M9，见上方 ⚠️）。

`src/voxel/block-registry.js` —— 在既有表旁加一张：

```js
/** 不可破坏表（M8）：徒手挖块 / 枪械破坏 / 爆炸过滤三个消费者共用单一权威 */
const indestructibleTable = new Uint8Array(MAX_BLOCKS);
// register() 内（与 orientationModesTable[id] = ... 并列）：
indestructibleTable[id] = def.indestructible ? 1 : 0;
// 返回对象内（与 solidTable 等并列导出）：
solidTable, opaqueTable, cullTable, emissiveTable, geometryTable, orientationModesTable,
supportsPlayerTable, indestructibleTable,
// 新增查询方法（放在 idOf/nameOf 附近）：
/**
 * 该方块是否不可被破坏（M8）。未知 id 返回 false（防御：不存在的方块不该被当成不可破坏）。
 * @param {number} id @returns {boolean}
 */
isIndestructible(id) {
  return Number.isInteger(id) && id >= 0 && id < MAX_BLOCKS ? indestructibleTable[id] === 1 : false;
},
```

`src/player/player.js` 的 `digBlock()` —— 把 bedrock 字面量判定换成读表：

```js
digBlock() {
  if (!this.target) return;
  const [x, y, z] = this.target.blockPos;
  const id = this.world.getBlockId(x, y, z);
  // M8：命中 tnt → 引爆而非挖块。⚠️ **这是新增偏离**：mc-lite **没有**「普通左键挖块命中
  // tnt 即引爆」这条入口（它只有 ctrl+左键 `:179` 与枪击 `:1048`）。本仓库把徒手挖块也接成
  // 引爆，是因为 mc-heavy 的左键挖块是 `digBlock()`（无 ctrl 修饰键路径）—— 记进偏离表。
  if (id === this.registry.idOf('tnt')) { this.igniteTnt(x, y, z); return; }
  // M8：不可破坏门控改读 registry 单一权威（此前只硬拦 bedrock）。徒手拦截保留 ——
  // editor 的 bedrock 门控只覆盖 bedrock，故两处都要拦。M9 追加 playground 两项后，
  // 这一行自动覆盖它们（无需改代码 —— 单一权威的收益）。
  if (this.registry.isIndestructible(id)) return;
  // ...（以下不变：recordRemovedBlock + editor.setBlock）
}
```

`src/player/weapons/weapon-target-policy.js` —— 收敛 `IMMUNE_NAMES`，但**保留 `end_stone`
的武器专属例外**：

```js
// M8：不可破坏判定改读 registry 单一权威（此前 IMMUNE_NAMES 字面量与 blocks-data.js 的
// indestructible 字段是同一事实的两个副本 → 漂移风险）。
// 保留 end_stone：**武器专属**收紧（mc-lite 的 MAG7 只排 end_stone/bedrock，本仓库 M4 有意
// 把创造台两项也排掉），它不属于全局「不可破坏」语义，故不进 indestructibleTable。
const WEAPON_ONLY_IMMUNE = new Set(['end_stone']);

export function isWeaponDestructible(id, registry) {
  if (id === registry.idOf('air')) return false;
  if (registry.isIndestructible(id)) return false;   // bedrock（M9 追加 playground 两项）
  return !WEAPON_ONLY_IMMUNE.has(registry.nameOf(id));
}
```

⚠️ **既有 `IMMUNE_NAMES` 含 `playground_block` / `playground_center_block`** —— 收敛后这两项
改由 `indestructibleTable` 提供（M9 登记）。**M8 期间它们不在表里 → 枪械仍可破坏它们**，
这与既有行为不同（既有是字面量排除）。⚠️ 这是 M8 的一处**行为变更**：M8 期间玩家放出的
playground 方块可被枪械破坏（M9 登记后恢复不可破坏）。须记进验收报告偏离表，且 Task 1 的
单测须断言 `isWeaponDestructible(playground_block) === true`（M8 期间）—— M9 时该断言改为 false。

⚠️ **A8：这会立刻让既有断言真 FAIL —— 本任务必须同步改 `src/tests/test-weapons.js`**
（否则 Step 4 的 GREEN 跑不过）。该文件 `:90/91/97` 有三条既有断言：

```js
assertFalse(isWeaponDestructible(ids.playground, registry));            // :90
assertFalse(isWeaponDestructible(registry.idOf('playground_center_block'), registry)); // :91
assertFalse(isMag7Candidate(ids.playground, registry));                 // :97
```

M8 收敛 `IMMUNE_NAMES` 后 playground 两项不在表里 → 这三条会变成 `true` → **既有测试 FAIL**。
故本任务须把它们改成 `assertTrue` 并改测试名（`'weapon policy: bedrock/end_stone/创造台不可破坏...'`
里的「创造台不可破坏」在 M8 期间不成立）：

```js
test('weapon policy: bedrock/end_stone 不可破坏；M8 期间创造台两项可破坏（M9 登记后翻转）', () => {
  const { registry, ids } = makeRegistryWithWeaponBlocks();
  assertFalse(isWeaponDestructible(ids.bedrock, registry));
  assertFalse(isWeaponDestructible(ids.endStone, registry));
  // ⚠️ M8 期间 playground 两项**不在** indestructibleTable → 枪械打得动（M9 登记后翻转回 assertFalse）
  assertTrue(isWeaponDestructible(ids.playground, registry));
  assertTrue(isWeaponDestructible(registry.idOf('playground_center_block'), registry));
  assertTrue(isMag7Candidate(ids.playground, registry));
  // ...（其余断言不变）
});
```

⚠️ **这是跨 Epic 的「断言翻转」**：M9 Task 1 登记两项后须把这三条**改回 `assertFalse`**
（M9 计划 Task 1 已认领该步骤）。两个阶段方向相反是同一个事实在不同状态的正确表达，
不是矛盾 —— 但**必须由各自 Task 显式认领**，否则 M8 的 GREEN 会卡在既有测试上。

- [ ] **Step 4: 验证 GREEN + 门禁**

Run: `npx playwright test tests/harness.spec.mjs`
Expected: PASS —— bedrock 登记、可破坏方块判 false、digBlock 零写入、枪械判定读表。

Run: `npm run check`
Expected: `check:arch` / `lint` 通过。**物品集合仍是 118 项**（本任务不动排除集合）。

- [ ] **Step 5: 在 `tools/check-data.mjs` 新增 `[不可破坏]` 环节**

照既有 `checkItemSetRelation()` 的手法加一个函数，并在汇总处调用：

```js
/**
 * [不可破坏] 契约：blocks-data.js 里标了 indestructible 的名字必须都在 registry 内
 * （拼错则门控静默失效 —— 方块名对不上，表里恒 0，方块照常被炸）。
 * 另断言表与声明数量一致（register 漏写表 → 门控全失效）。
 */
function checkIndestructibleContract() {
  const marked = BLOCKS.filter((b) => b.indestructible).map((b) => b.name);
  const allNames = new Set(REGISTRY.all().map((e) => e.name));
  for (const n of marked) {
    if (!allNames.has(n)) {
      failures.push(`[不可破坏] "${n}" 标了 indestructible 但不在 registry 内（拼错则门控静默失效）`);
    }
  }
  if (marked.length === 0) failures.push('[不可破坏] blocks-data.js 无任何 indestructible 条目（表失效）');
  const tableCount = marked.filter((n) => REGISTRY.isIndestructible(REGISTRY.idOf(n))).length;
  if (tableCount !== marked.length) {
    failures.push(`[不可破坏] 表里 ${tableCount} 项 ≠ 声明 ${marked.length} 项（register 未写表？）`);
  }
  infos.push(`[不可破坏] ${marked.length} 项：${marked.join(', ')}`);
}
```

⚠️ **负向验证**（两条，全部须真 FAIL）：① 注入「`register()` 漏写 `indestructibleTable`」
→ `表里 0 项 ≠ 声明 1 项`；② 在 `blocks-data.js` 临时加一条不存在的方块名标
`indestructible` → `不在 registry 内`。
**自查无效盲区**：若只断言 `marked.length > 0`，注入①仍全绿 —— 故必须有「表与声明数量
一致」那条配对断言。

- [ ] **Step 6: 提交（仅获授权后执行）**

```bash
git add src/voxel/blocks-data.js src/voxel/block-registry.js src/player/player.js \
  src/player/weapons/weapon-target-policy.js src/tests/test-block-registry.js \
  tools/check-data.mjs
git commit -m "feat(voxel): indestructible 单一权威（M8 只登记 bedrock）"
```


### Task 2: TNT 引爆、爆炸破坏、连锁与丧尸伤害

**Files:**

- Create: `src/voxel/explosion.js`, `src/render/explosion-renderer.js`, `src/tests/test-explosion.js`, `tests/tnt.spec.mjs`
- Create: `assets/sounds/explosion.mp3`（从 mc-lite `src/assets/sound/explosion.mp3` 拷入）
- Modify: `src/player/player.js`（左键引爆 + 去重集合）
- Modify: `src/player/weapons/weapon-controller.js`（枪击引爆）
- Modify: `src/render/audio-manager.js`（`SOUND_IDS`）
- Modify: `src/entities/zombies/zombie-system.js`（新增只读活动实体枚举）
- Modify: `src/core/game.js`（开关 + 连锁队列 + 爆炸装配 + 测试 API）
- Modify: `src/ui/settings-panel.js`, `src/ui/settings.js`（开关档位 + 持久化）
- Modify: `src/tests/index.html`（注册新单测文件）

**Interfaces:**

- Consumes: Task 1 的 `registry.isIndestructible(id)`；既有 `editor.setBlocks(changes)` /
  `raycastVoxel(world, origin, dir, maxDist)` / `zombies.damage(id, amount, nowMs)` /
  `zombies.get(id)` / `zombies.spawn(position, {source})` / `audioManager.play(id, volume)` /
  `game.audioDebugState().playRequests`
- Produces（后续任务依赖，签名必须一致）:

```js
computeExplosion({ world, registry, center })
// → { center:[x,y,z], destroy: Array<{x,y,z}>, chain: Array<{x,y,z,delayMs}> }
//   destroy = 3×3×3 内可破坏格；chain = 5×5×5 内其他 tnt，delayMs ∈ [500,1100] 确定性抖动
export const EXPLOSION_DAMAGE_RADIUS = 4;  // 单一权威，game.js 与测试共用
export const EXPLOSION_DAMAGE = 50;

game._ignitingTnt;                      // Set<'x,y,z'>，引爆去重（**单一权威在 game 侧**）
player.igniteTnt(x, y, z);              // boolean；薄路由 → game.explodeTnt，去重命中返回 false
game.explodeTnt(x, y, z);              // 唯一爆炸入口（测试 API 也走它）
game.canTntDestroyBlocks;              // boolean，默认 false
game.setTntBlockDamage(enabled);       // boolean
game.tntChainDebugState();             // { pending: number, exploded: number }；只读测试钩子
zombies.activeEntities();              // Array<Entity>（只读快照；type==='zombie'）
ExplosionRenderer({ scene, maxActive })// .burst(position:[x,y,z], nowMs) / .update(nowMs) / .dispose()
```

- [ ] **Step 1: 写失败的爆炸计算测试**

新建 `src/tests/test-explosion.js`，并在 `src/tests/index.html` 静态 import 它（在
`import './test-zombie-nests.js';` 之后追加一行 `import './test-explosion.js';`）。
`makeWorldFixture()` **需新建**（`test-zombie-nests.js` 里只有 `makeRegistry()` 与
`makeNestFixture()`，**没有** `makeWorldFixture`）。照 `makeNestFixture` 的同手法构造（`createRegistry()` + `new WorldData(registry)`
+ 手工铺一层地面 + 预加载两个 column）。

```js
test('computeExplosion：3×3×3 破坏 + indestructible 过滤', () => {
  const { world, registry } = makeWorldFixture();
  const stoneId = registry.idOf('stone');
  world.setBlock(5, 1, 5, stoneId);
  world.setBlock(6, 1, 5, registry.idOf('bedrock'));   // 3×3×3 内的不可破坏格
  const r = computeExplosion({ world, registry, center: [5, 1, 5] });
  assertEqual(r.center[0], 5);
  // 3×3×3 = 27 格，其中 bedrock 那格被过滤 → 26
  assertEqual(r.destroy.length, 26);
  assertEqual(r.destroy.some((c) => c.x === 6 && c.y === 1 && c.z === 5), false);
  // 中心格自身在列表内（由引爆路径移除自身，见 game.explodeTnt）
  assertTrue(r.destroy.some((c) => c.x === 5 && c.y === 1 && c.z === 5));
});

test('computeExplosion：5×5×5 连锁 + 确定性延迟（同输入两次一致）', () => {
  const { world, registry } = makeWorldFixture();
  const tntId = registry.idOf('tnt');
  world.setBlock(5, 1, 5, tntId);   // 中心
  world.setBlock(7, 1, 5, tntId);   // 距离 2 → 在 5×5×5 内
  world.setBlock(9, 1, 5, tntId);   // 距离 4 → 超出
  const a = computeExplosion({ world, registry, center: [5, 1, 5] });
  assertEqual(a.chain.length, 1);
  assertEqual(a.chain[0].x, 7);
  assertTrue(a.chain[0].delayMs >= 500 && a.chain[0].delayMs <= 1100);
  // **红线 2**：同输入两次结果完全一致（不是 Math.random）
  const b = computeExplosion({ world, registry, center: [5, 1, 5] });
  assertEqual(b.chain[0].delayMs, a.chain[0].delayMs);
  // 不同中心 → 该 tnt 不在范围内（散列真的在生效，不是恒返回同一值）
  const c = computeExplosion({ world, registry, center: [6, 1, 5] });
  assertEqual(c.chain.length, 0);
});
```

- [ ] **Step 2: 验证 RED**

Run: `npx playwright test tests/harness.spec.mjs`
Expected: FAIL —— `computeExplosion` 未定义（模块不存在 → import 报错）。

- [ ] **Step 3: 实现 `src/voxel/explosion.js`**

```js
// src/voxel/explosion.js — M8：爆炸计算（同构纯函数，规格 §2.1）
// **无 DOM、无 three、不走 Worker** —— 计算量 152 次 getBlockId，且爆炸须与音效/特效同帧
// （理由记在设计文档 §4.5）。归属 voxel 层：纯体素查询，不是生成。
// 数值逐项对齐 mc-lite `ExplosionWorker.js`（3×3×3 破坏 / 5×5×5 连锁 / 500~1100ms 延迟）。

/** 破坏范围半径（mc-lite dx/dy/dz ∈ [-1,1] → 3×3×3 = 27 格） */
const DESTROY_RADIUS = 1;
/** 连锁搜索半径（mc-lite [-2,2] → 5×5×5 = 125 格） */
const CHAIN_RADIUS = 2;
/** 连锁延迟区间（mc-lite `500 + Math.random() * 600`） */
const CHAIN_DELAY_MIN = 500;
const CHAIN_DELAY_RANGE = 600;

/** 爆炸对实体的伤害半径与数值（mc-lite `PlayerInteraction.js:629-630`）。
 *  导出为单一权威 —— game.js 与测试共用，不得各写字面量（红线 1）。 */
export const EXPLOSION_DAMAGE_RADIUS = 4;
export const EXPLOSION_DAMAGE = 50;

/**
 * 中心坐标 → 确定性散列（替代 mc-lite 的 `Math.random()`）。
 * **红线 2**：同 seed 两次生成须一致；随机延迟会让同一存档两次引爆的连锁时序不同。
 * 手法照 M6 排斥力 tie-break（质数加权散列）。
 * @param {[number,number,number]} center @returns {number} [0, 1)
 */
function centerHash(center) {
  const [x, y, z] = center;
  const code = Math.abs(
    (Math.trunc(x) * 73856093) ^ (Math.trunc(y) * 19349663) ^ (Math.trunc(z) * 83492791),
  );
  return (code % 100000) / 100000;
}

/**
 * 计算一次爆炸的破坏范围与连锁 TNT。
 * @param {{world: import('./world-data.js').WorldData,
 *          registry: ReturnType<import('./block-registry.js').createRegistry>,
 *          center: [number, number, number]}} p
 * @returns {{center: [number,number,number],
 *            destroy: Array<{x:number,y:number,z:number}>,
 *            chain: Array<{x:number,y:number,z:number,delayMs:number}>}}
 */
export function computeExplosion({ world, registry, center }) {
  const bx = Math.floor(center[0]), by = Math.floor(center[1]), bz = Math.floor(center[2]);
  const outCenter = [bx, by, bz];
  const destroy = [];
  for (let dx = -DESTROY_RADIUS; dx <= DESTROY_RADIUS; dx++) {
    for (let dy = -DESTROY_RADIUS; dy <= DESTROY_RADIUS; dy++) {
      for (let dz = -DESTROY_RADIUS; dz <= DESTROY_RADIUS; dz++) {
        const x = bx + dx, y = by + dy, z = bz + dz;
        const id = world.getBlockId(x, y, z);
        // 空气格也进列表：WorldData.setBlocks 会判 no-change 跳过，不需要在此过滤
        // （让「破坏 27 格」的口径与 mc-lite 的 blocksToDestroy 一致）
        if (id !== 0 && registry.isIndestructible(id)) continue;  // M8 单一权威门控
        destroy.push({ x, y, z });
      }
    }
  }
  const chain = [];
  const tntId = registry.idOf('tnt');
  const hash = centerHash(outCenter);
  for (let dx = -CHAIN_RADIUS; dx <= CHAIN_RADIUS; dx++) {
    for (let dy = -CHAIN_RADIUS; dy <= CHAIN_RADIUS; dy++) {
      for (let dz = -CHAIN_RADIUS; dz <= CHAIN_RADIUS; dz++) {
        if (dx === 0 && dy === 0 && dz === 0) continue;  // 中心格由引爆路径自身移除
        const x = bx + dx, y = by + dy, z = bz + dz;
        if (world.getBlockId(x, y, z) !== tntId) continue;
        // 确定性抖动：同中心两次计算结果一致；同一批连锁里多个 TNT 的延迟各不相同
        // （偏移量参与散列 → 依次炸而非同时炸，手感对齐 mc-lite）
        const jitter = (hash + Math.abs(dx * 3 + dy * 5 + dz * 7) / 125) % 1;
        const delayMs = CHAIN_DELAY_MIN + Math.round(jitter * CHAIN_DELAY_RANGE);
        chain.push({ x, y, z, delayMs });
      }
    }
  }
  return { center: outCenter, destroy, chain };
}
```

- [ ] **Step 4: 验证 GREEN + 负向验证**

Run: `npx playwright test tests/harness.spec.mjs`
Expected: PASS —— 26 格破坏（bedrock 过滤）、连锁 1 个且延迟确定、不同中心不同结果。

⚠️ **负向验证**（三条，全部须真 FAIL，做完须恢复源码）：
① 注入「删掉 `isIndestructible` 判定」→ bedrock 出现在 destroy 里（`destroy.length` 变 27）；
② 注入「`centerHash` 改成 `() => Math.random()`」→ 两次 `delayMs` 不一致；
③ 注入「`CHAIN_RADIUS` 改成 4」→ 距离 4 的 tnt 进 chain（`chain.length === 1` FAIL）。

**自查无效盲区**：若断言只写 `delayMs >= 500`，注入「延迟恒返回 500」仍全绿 ——
故必须有「同输入两次一致」+「不同中心结果不同」两条配对断言钉住散列真的在生效。

- [ ] **Step 5: 接线两条引爆路径与连锁队列**

`src/player/player.js` —— 构造函数新增回调字段（**去重集合不在 player 侧**，见下方理由）：

```js
/** M8 引爆回调（Game 注入）。Player 不反向依赖 core/（依赖方向 §3，与 onSpawnZombie 同惯例） */
this._onIgniteTnt = opts.onIgniteTnt ?? null;
```

`digBlock()` 开头插入 tnt 分流（在 Task 1 的 indestructible 门控**之前**）：

```js
digBlock() {
  if (!this.target) return;
  const [x, y, z] = this.target.blockPos;
  const id = this.world.getBlockId(x, y, z);
  // M8：命中 tnt → 引爆而非挖块。⚠️ **这是新增偏离**：mc-lite **没有**「普通左键挖块命中
  // tnt 即引爆」这条入口（它只有 ctrl+左键 `:179` 与枪击 `:1048`）。本仓库把徒手挖块也接成
  // 引爆，是因为 mc-heavy 的左键挖块是 `digBlock()`（无 ctrl 修饰键路径）—— 记进偏离表。
  if (id === this.registry.idOf('tnt')) { this.igniteTnt(x, y, z); return; }
  if (this.registry.isIndestructible(id)) return;
  // ...（以下不变）
}

/**
 * 引爆一格 TNT（M8）—— **薄路由**，去重判定在 `game.explodeTnt()` 内（单一权威）。
 *
 * ⚠️ **去重不放在 player 侧**：三条引爆路径（左键 / 枪击 / 连锁到期）中，后两条不经 player
 * —— 若去重只在 player 侧，连锁路径会绕开它 → A↔B 两格相距 ≤2 的 TNT 永久互爆。
 * mc-lite 的 `player.ignitingTNTs` 之所以够用，是因为它的四个入口全部在
 * `PlayerInteraction` 内（`:179`/`:617`/`:1051`/`:1083`）；本仓库的连锁队列在 `Game`，
 * 故去重必须下沉到 `Game.explodeTnt()`。
 * @param {number} x @param {number} y @param {number} z @returns {boolean}
 */
igniteTnt(x, y, z) {
  if (!this._onIgniteTnt) return false;
  // 返回值透传 game.explodeTnt 的去重结果（false = 已引爆过）
  return this._onIgniteTnt(Math.floor(x), Math.floor(y), Math.floor(z));
}
```

`src/player/weapons/weapon-controller.js` —— 枪击命中 tnt 时引爆（在体素命中分支里、
`isWeaponDestructible` 判定之前）。`onIgniteTnt` 由构造函数 opts 注入（缺省 null）：

```js
// 体素命中分支内（拿到 bx/by/z 与 hitId 之后）：
// M8：枪击命中 tnt → 引爆（mc-lite `PlayerInteraction.js:1048` 是 `executeShot()` 内的
// 枪击命中路径；`:172` 才是 ctrl+左键。本仓库简化为「命中即引爆」—— 有意偏离，规格 §2.2）
if (hitId === this.registry.idOf('tnt')) {
  if (this.onIgniteTnt) this.onIgniteTnt(bx, by, bz);
  return;   // 不走破坏分支
}
```

`src/entities/zombies/zombie-system.js` —— 新增只读活动实体枚举（爆炸伤害需要它）：

```js
/**
 * 只读活动实体快照（M8 爆炸半径伤害用）。**不新建第二份实体集合**（红线 1）——
 * 只是从 M5 EntityManager 的迭代器过滤 type。返回数组快照而非迭代器：
 * 调用方会在遍历中调 `damage()` → 可能触发 despawn 改变底层集合（迭代器失效）。
 * @returns {Array<import('../entity-manager.js').Entity>}
 */
activeEntities() {
  const out = [];
  for (const entity of this.entities.entities()) {
    if (entity.type === 'zombie') out.push(entity);
  }
  return out;
}
```

`src/core/game.js` —— 开关 + 爆炸执行 + 连锁队列。装配段（`this.zombies` / `this.nests`
之后、`_waitForColumn` 之前）加：

```js
/** TNT 是否破坏地形（mc-lite `Game.js:92` 代码事实为 false：默认只伤害 + 连锁。
 *  ⚠️ 不宣称「实测过默认开关下的爆炸行为」—— mc-lite 的 TNT 运行时目前是坏的，见下方 ⚠️） */
this.canTntDestroyBlocks = false;
/**
 * 引爆去重集合（**单一权威在此**，不在 player 侧）。三条引爆路径（左键 / 枪击 / 连锁到期）
 * 共用它 —— 防止连锁回环把同一格引爆两次（A↔B 相距 ≤2 的 TNT 会永久互爆）。
 * @type {Set<string>}
 */
this._ignitingTnt = new Set();
/** 连锁引爆队列：Array<{x,y,z,dueAt}>，dueAt 是 performance.now() 基准 */
this._tntChain = [];
/** 爆炸计数（只读测试钩子） */
this._tntExploded = 0;
this.explosionRenderer = new ExplosionRenderer({ scene: this.scene });
```

Player 装配处注入回调（与 `onSpawnZombie` 同一位置）：
`onIgniteTnt: (x, y, z) => this.explodeTnt(x, y, z),`（**透传返回值** —— player 的
`igniteTnt()` 据此告诉调用方是否真的引爆了）；weaponController 装配处注入同一个函数。

⚠️ **对齐 mc-lite TNT 的证据基础须如实记录**（CLAUDE.md 规矩「对齐上游须实测其运行时行为，
不能读定义推断」在这里**无法满足**）：mc-lite 的 TNT 运行时目前是坏的 ——
`PlayerInteraction.js:620` 与 `:686` 引用了**未声明**的 `worldAccess`（全仓只有三处
`const worldAccess = this.player.world.worldAccessLayer;` 在 `:287`/`:327`/`:453`，
都在各自方法内，`handleExplosionResult` 与 `explode()` 里没有，也无全局注入点）。
ESM 是严格模式，`?.` **不保护未声明标识符**（实测：`undeclaredThing?.foo?.()` 抛
`ReferenceError`）→ `:686` 抛错 → `:697` 的 `postMessage` 不执行 → 没有爆炸、没有伤害/粒子/音效，
连锁也起不来。**故本任务的 TNT 数值/语义对齐是「读源码 + 推断意图」，不是实测对齐** ——
验收报告的偏离表须显式记这一句，不要写成「实测对齐 mc-lite」。

```js
/**
 * 引爆一格 TNT（M8 唯一爆炸入口）。三条路径（左键 / 枪击 / 连锁到期）都经此处。
 *
 * 顺序固定（规格 §2.2）：① **去重** → ② 算范围 → ③ 移除引爆格自身 → ④ 破坏事务 →
 * ⑤ 入队连锁 → ⑥ 伤害丧尸 → ⑦ 音效与特效。
 *
 * ⚠️ **去重必须在本函数内**（不能只在 `player.igniteTnt` 里）：连锁队列与枪击路径都直接
 * 调本函数，若去重只在 player 侧，A↔B 两格相距 ≤2 的 TNT 会**永久互爆**
 * （A 炸 → 入队 B → B 到期炸 → 入队 A → …），`_tntExploded` 无界增长。
 * mc-lite 同口径：四个引爆入口（`:179` ctrl+左键 / `:617` 连锁 / `:1051` / `:1083` 子弹命中）
 * 全部先 `has` 再 `add`。
 *
 * ⚠️ **移除引爆格自身独立于破坏开关**：mc-lite `explode()` 的 `removeBlock` 只以
 * 「该格是 tnt」为条件（`PlayerInteraction.js:683-688`），而 `canTntDestroyBlocks` 门控只包住
 * 周围 3×3×3 的 `removeBlocksBatch`（`:608-614`）。若把自身移除塞进破坏开关内，默认关闭时
 * 被引爆的 TNT 方块永不消失 → 连锁链永不终止（这是 mc-lite 的链能终止的原因：
 * `:620` 先 removeBlock 再 explode）。
 *
 * @param {number} x @param {number} y @param {number} z
 * @returns {boolean} false = 去重命中（已引爆过），零世界写入
 */
explodeTnt(x, y, z) {
  // ① 去重（唯一入口 —— 三条路径共用同一集合）
  const key = `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`;
  if (this._ignitingTnt.has(key)) return false;
  this._ignitingTnt.add(key);

  const result = computeExplosion({ world: this.world, registry: this.registry, center: [x, y, z] });
  const tntId = this.registry.idOf('tnt');
  // ③ 移除引爆格自身（**不受破坏开关影响** —— 见上方 ⚠️）
  if (this.world.getBlockId(result.center[0], result.center[1], result.center[2]) === tntId) {
    this.editor.setBlock({ x: result.center[0], y: result.center[1], z: result.center[2], id: 0 });
    this._ignitingTnt.delete(key);   // mc-lite `:687` 同口径：移除后释放去重键（该格已非 tnt）
  }
  // ④ 破坏事务（周围 3×3×3，受开关门控）。⚠️ **过滤掉已在去重集合里的待爆 TNT**
  //    （mc-lite `:610` 同手法）—— 否则连锁 TNT 会被自己的破坏事务删掉
  if (this.canTntDestroyBlocks && result.destroy.length > 0) {
    this.editor.setBlocks(result.destroy
      .filter((c) => !this._ignitingTnt.has(`${c.x},${c.y},${c.z}`))
      .map((c) => ({ x: c.x, y: c.y, z: c.z, id: 0 })));
  }
  // ⑤ 入队连锁。**performance 基准 —— 禁止 Date.now()**（Global Constraints）
  const now = performance.now();
  for (const t of result.chain) {
    this._tntChain.push({ x: t.x, y: t.y, z: t.z, dueAt: now + t.delayMs });
  }
  // ⑥ 半径 4 格内丧尸受 50 伤害
  this._damageEntitiesInRadius(result.center, EXPLOSION_DAMAGE_RADIUS, EXPLOSION_DAMAGE, now);
  // ⑦ 音效与特效同帧。音效出处 = mc-lite `PlayerInteraction.js:673`（音量 0.4）；
  //    特效出处 = `World.js:1296 spawnExplosionParticles` 的球体扩张层（`World.js` **无音频代码**）
  this.audioManager?.play('explosion', 0.4);
  this.explosionRenderer.burst(
    [result.center[0] + 0.5, result.center[1] + 0.5, result.center[2] + 0.5], now,
  );
  this._tntExploded++;
  return true;
}

/**
 * 半径内丧尸伤害。枚举 `ZombieService.activeEntities()`（slot 表是单一权威），
 * **不扫 EntityManager 全量集合** —— 那会把未来其它实体类型（弹丸/炮塔）也炸伤。
 * @param {[number,number,number]} center @param {number} radius
 * @param {number} damage @param {number} nowMs
 */
_damageEntitiesInRadius(center, radius, damage, nowMs) {
  const cx = center[0] + 0.5, cy = center[1] + 0.5, cz = center[2] + 0.5;
  for (const entity of this.zombies.activeEntities()) {
    const [px, py, pz] = entity.state.position;
    const dy = py + ZOMBIE.height / 2;   // 度量用丧尸 AABB 中心（mc-lite 同口径）
    if (Math.hypot(px - cx, dy - cy, pz - cz) <= radius) {
      this.zombies.damage(entity.id, damage, nowMs);
    }
  }
}

/** 帧循环内推进连锁（放在 `_updateNestControllers(nowMs)` 之后） */
_updateTntChain(nowMs) {
  if (this._tntChain.length === 0) return;
  const due = this._tntChain.filter((t) => nowMs >= t.dueAt);
  if (due.length === 0) return;
  this._tntChain = this._tntChain.filter((t) => nowMs < t.dueAt);
  for (const t of due) this.explodeTnt(t.x, t.y, t.z);
}

⚠️ **不要在到期回调里加「先验证该格仍是 TNT」的门控**（审查明确指出这是无谓偏离）：
mc-lite 的到期回调也不重新校验（`PlayerInteraction.js:619-623` 直接 removeBlock →
delete(key) → explode()），`explode()` 对空气坐标照样发 worker。本计划的行为与上游同构 ——
加了门控会引入一处上游没有的偏离。

setTntBlockDamage(enabled) {
  this.canTntDestroyBlocks = !!enabled;
  return this.canTntDestroyBlocks;
}
/** 只读测试钩子 */
tntChainDebugState() { return { pending: this._tntChain.length, exploded: this._tntExploded }; }
```

帧循环内两处接线：`this._updateTntChain(nowMs);`（放在 `_updateNestControllers` 之后）、
`this.explosionRenderer.update(nowMs);`（放在 `zombieRenderer.sync` 之后、`render` 之前）。

- [ ] **Step 6: 实现爆炸特效与音效**

`src/render/explosion-renderer.js`（照 `tracer-renderer.js` 手法）：

```js
// src/render/explosion-renderer.js — M8：爆炸球体扩张特效（规格 §2.4）
// 固定 slot InstancedMesh，池满覆盖最旧。mc-heavy 没有粒子系统，只移植 mc-lite
// `World.js:1301-1311` 的球体扩张层（寿命 0.3s / targetScale 5.0 / opacity 1→0）。
// ⚠️ 无活跃实例时 visible=false（否则恒增 1 个 draw call —— M6 实测教训）。
import * as THREE from 'three';

const BURST_LIFE_MS = 300;       // mc-lite sphere.maxLife = 0.3
const BURST_TARGET_SCALE = 5.0;  // mc-lite `World.js:1306` 运行时覆盖值（池初始化是 8.0，被覆盖）
const _matrix = new THREE.Matrix4();
const _zero = new THREE.Matrix4().makeScale(0, 0, 0);

export class ExplosionRenderer {
  constructor({ scene, maxActive = 16 }) {
    this.scene = scene;
    this.maxActive = maxActive;
    // ⚠️ 几何/材质逐项照搬 mc-lite `World.js:111-127`（池初始化值，运行时**未**被覆盖）：
    // 半径 **1**（不是 0.5 —— 写 0.5 会让直径只有一半）、24×24 段、颜色 **0xffff00 黄**
    // （不是橙）、`depthWrite:false` + `side: DoubleSide`（mc-lite 注释：避免深度冲突，
    // 提升重叠球体的视觉效果）。
    const geometry = new THREE.SphereGeometry(1, 24, 24);
    const material = new THREE.MeshBasicMaterial({
      color: 0xffff00, transparent: true, opacity: 0, depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.InstancedMesh(geometry, material, maxActive);
    this.mesh.visible = false;   // 无爆炸时不提交渲染
    for (let i = 0; i < maxActive; i++) this.mesh.setMatrixAt(i, _zero);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.scene.add(this.mesh);
    /** @type {Array<{slot:number, startedAt:number}>} */
    this._bursts = [];
    this._nextSlot = 0;
  }

  /** 起一次爆炸特效。池满时覆盖最旧 slot（纯视觉，丢弃无副作用）。 */
  burst(position, nowMs) {
    const slot = this._nextSlot;
    this._nextSlot = (this._nextSlot + 1) % this.maxActive;
    _matrix.makeTranslation(position[0], position[1], position[2]);
    this.mesh.setMatrixAt(slot, _matrix);
    const existing = this._bursts.find((b) => b.slot === slot);
    if (existing) { existing.startedAt = nowMs; existing.position = position; }
    else this._bursts.push({ slot, startedAt: nowMs, position });
    this.mesh.visible = true;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  /** 每帧推进：按寿命比例扩张 + 淡出；全部结束后 visible=false。 */
  update(nowMs) {
    if (this._bursts.length === 0) { if (this.mesh.visible) this.mesh.visible = false; return; }
    let maxOpacity = 0;
    for (let i = this._bursts.length - 1; i >= 0; i--) {
      const b = this._bursts[i];
      const t = (nowMs - b.startedAt) / BURST_LIFE_MS;
      if (t >= 1) { this.mesh.setMatrixAt(b.slot, _zero); this._bursts.splice(i, 1); continue; }
      // 扩张与淡出照搬 mc-lite `World.js:1260-1263`：
      // scale = 0.1 + progress × targetScale（终值 ≈ 5.1）；淡出 = pow(1 − progress, 1.5)
      // （mc-lite 注释「指数函数实现先慢后快的透明度淡出」）—— **不是线性淡出**，
      // 线性会让特效前半段就明显变透明，观感与 mc-lite 不一致。
      const scale = 0.1 + t * BURST_TARGET_SCALE;
      _matrix.makeScale(scale, scale, scale);
      _matrix.setPosition(b.position[0], b.position[1], b.position[2]);
      this.mesh.setMatrixAt(b.slot, _matrix);
      const opacity = Math.pow(1 - t, 1.5);
      if (opacity > maxOpacity) maxOpacity = opacity;
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.material.opacity = maxOpacity;
    if (this._bursts.length === 0) this.mesh.visible = false;
  }

  dispose() {
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();  // InstancedMesh.dispose 不释放材质
  }
}
```

⚠️ 所有活跃 burst 共享一个材质 opacity —— mc-lite 也是共享材质（`sphere.material.opacity`），
且爆炸寿命仅 0.3 秒。**不要**照 `tracer-renderer` 改成 per-instance color（对 0.3 秒的特效
是过度设计）。⚠️ 注意 `_matrix.makeScale` 会清掉位移 → 须再 `setPosition`。

音效：拷入 `assets/sounds/explosion.mp3`（`cp ../mc-lite/src/assets/sound/explosion.mp3
assets/sounds/`）；`src/render/audio-manager.js` 的 `SOUND_IDS` 改为
`['gun_load', 'gun_fire', 'mag7_fire', 'minigun_fire', 'put', 'explosion']`，并更新文件头
注释说明 M8 追加了 `explosion`。

- [ ] **Step 7: 设置面板开关与持久化**

`src/ui/settings.js` —— 照 `gunBlockDamage` 同手法加字段：默认 `false`、随 settings 持久化、
`?tntDamage=` URL 可达。

`src/ui/settings-panel.js` —— 加一行两按钮档位（开/关），**放右列**。

⚠️ **落位决策已定（不留给执行者裁量）**：CLAUDE.md 两条活跃约束在这里看似打架 ——
「新配置往右列填」vs「两组两按钮档位优先用合并盒共用一行」。实测现有结构后判定：
**右列独立一行（`.mc-item`），不进左列的合并盒**。理由三条：

1. 现有合并盒 `_combinedBlurGunDamage()` 在**左列**，已容纳两组（画质 + 枪械破坏 = 4 按钮）。
   面板总宽 770px、两列各约 375px（v1.35 实测）→ 再塞第三组会让 6 按钮挤在 375px 内，
   按钮文案会被压缩或换行（观感劣化，且属「立刻可见」的 Tier 3 缺陷）。
2. 「两组两按钮档位优先用合并盒」这条约束的适用前提是**有两组要合并**；TNT 破坏是单组，
   单独成行不适用该条。把它与左列既有组合并反而会**违反**「新配置往右列填」
   （那是更具体、更新的约束，且明写右列纵向余量更大）。
3. 右列已有 视距 / 帧预算 / 世界操作 三行，TNT 破坏作为**运行时即时**开关与「帧预算」
   同性质，放这里语义连贯；且不触碰左列既有合并盒 → 避开 v1.35 那条 CSS 特异性陷阱
   （`.mc-column > :first-child` 会抹掉 `.mc-combined` 的装饰边框）。

实现照 `_rowBudget()` 的同手法（`_makeRow('TNT 破坏', [false, true], ['关闭', '开启'], ...)`），
点击调 `game.setTntBlockDamage(enabled)` 并 `this._save()`（与 `setGunBlockDamage` 同接线）。
⚠️ 须补一条断言：该行落在右列容器内（`.mc-columns` 的第二个 `.mc-column`），
避免后续调整面板时被误挪到左列。

⚠️ **`PANEL_CSS` 是 JS 模板字面量 —— 注释里禁用反引号包裹标识符**（会提前终止模板字符串
→ 整个模块解析失败 → 游戏页**白屏**，不是面板样式错）。改完先跑 `npm run lint`。

⚠️ **列分隔线规则只作用于 `.mc-item`，不得通配所有子项**（v1.35 踩坑：写
`.mc-column > :first-child` 会连带抹掉 `.mc-combined` 合并盒自己的装饰边框）。
加新容器类型时须同步考虑这条选择器，并补四边 `getComputedStyle` solid 断言。

- [ ] **Step 8: 写 Playwright E2E**

`tests/tnt.spec.mjs`。⚠️ **没有 `startGame(page)` 这个 helper**（全仓 `tests/` 零命中）——
实际写法是裸 `page.goto('/?vd=2')` + `waitWorldSettled(page)`，而 `waitWorldSettled` 由
**每个 spec 各自定义**（`tests/zombie-nests.spec.mjs:25`，无共享 helper 模块）。
故本 spec 须把 `waitWorldSettled` **整段复制**过来（照 zombie-nests 的实现，含其
「sections 连续两次采样不变 + 队列归零」的判据与注释 —— 不能只判队列归零，那是瞬时状态）：

```js
import { test, expect } from 'playwright/test';

/** 等世界真正稳定（判据 = sections 连续两次采样不变 + 队列归零）。
 *  ⚠️ 不能只判队列归零 —— 那是瞬时状态，高负载下队列可能短暂归零而 column 还在加载。
 *  整段照 `tests/zombie-nests.spec.mjs:25` 复制（含其注释与 90s timeout）。 */
async function waitWorldSettled(page) { /* 照 zombie-nests.spec.mjs 实现 */ }

/** 本 spec 的起手式（替代不存在的 startGame）：导航 + 等世界稳定 */
async function boot(page) {
  await page.goto('/?vd=2');
  await waitWorldSettled(page);
}
```

⚠️ 用 `?vd=2` 而非默认视距：M1/M3 的既有 spec 同口径，加载半径小 → 世界稳定快、
spec 不 flaky。实测口径：加载半径 = `(vd + 2) × 16` 格（`scheduler.js:242`「加载半径 + 2」
滞回）→ vd=2 是 **64 格**、vd=8 是 **160 格**。平台距玩家 10~64 格，故两种视距下平台
覆盖的 column **通常都已加载**；Task 7 的「未加载视为重叠」判据是边界防护（玩家站在
加载半径边缘时平台会部分超出），该 spec 用 `?vd=2` 即可触发到它，见 Task 7 Step 5 的负向验证 ②。

```js
test('引爆 TNT：默认不破坏地形但伤害丧尸；开关开启后破坏地形', async ({ page }) => {
  await boot(page);
  const setup = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    const p = g.player.physics.pos;
    const bx = Math.floor(p.x) + 3, by = Math.floor(p.y), bz = Math.floor(p.z);
    const stoneId = g.registry.idOf('stone');
    // 先铺一片 stone，再放 tnt 在中心（顺序：tnt 后放，避免被 stone 覆盖）
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        g.editor.setBlock({ x: bx + dx, y: by, z: bz + dz, id: stoneId });
      }
    }
    g.editor.setBlock({ x: bx, y: by, z: bz, id: g.registry.idOf('tnt') });
    // 生成一只丧尸在 4 格内（走 ZombieService.spawn，不是测试专用 API）
    const zid = g.zombies.spawn([bx + 2.5, by, bz + 0.5], { source: 'tnt-spec' });
    return { bx, by, bz, zid, neighbor: [bx + 1, by, bz] };
  });
  // 默认关：地形不变
  await page.evaluate((c) => window.__MC_GAME__.explodeTnt(c.bx, c.by, c.bz), setup);
  const terrainIntact = await page.evaluate((n) =>
    window.__MC_GAME__.world.getBlockId(n[0], n[1], n[2]) !== 0, setup.neighbor);
  expect(terrainIntact).toBe(true);
  // 丧尸掉血 100 → 50
  const health = await page.evaluate((id) => window.__MC_GAME__.zombies.get(id)?.state.health ?? null, setup.zid);
  expect(health).toBe(50);
  // 音效播放请求计数增加
  const plays = await page.evaluate(() => window.__MC_GAME__.audioDebugState().playRequests.explosion ?? 0);
  expect(plays).toBeGreaterThanOrEqual(1);
  // 开启破坏后再炸一次 → 地形被破坏
  const destroyed = await page.evaluate((c) => {
    const g = window.__MC_GAME__;
    g.setTntBlockDamage(true);
    g.editor.setBlock({ x: c.bx, y: c.by, z: c.bz, id: g.registry.idOf('tnt') });
    g.explodeTnt(c.bx, c.by, c.bz);
    return g.world.getBlockId(c.neighbor[0], c.neighbor[1], c.neighbor[2]) === 0;
  }, setup);
  expect(destroyed).toBe(true);
});

test('连锁 TNT 依次引爆，且同格不重复引爆', async ({ page }) => {
  // 放两格相距 2 的 tnt → 引爆第一格 → pending 队列 1 项；等待 1.2s 后 exploded === 2
  // 断言 tntChainDebugState() 的 pending 归零、exploded === 2（不是 3 —— 去重生效）
});

test('**背包选中路径**：从背包选 tnt 右键放块，再左键引爆', async ({ page }) => {
  // 走 inventory 面板点击选中 tnt 槽 → 右键放置 → 左键引爆（玩家主路径，不是测试 API）
  // ⚠️ M7 教训：只走测试 API 的 E2E 曾全绿却漏了「背包放置只放一格」缺陷（验收报告 §3.7）
});
```

⚠️ **负向验证**（落在真游戏页，全部须真 FAIL）：
① 注入「`explodeTnt` 不调 `_damageEntitiesInRadius`」→ health 仍 100；
② 注入「`canTntDestroyBlocks` 默认改成 `true`」→ 第一次炸就破坏地形（`terrainIntact` FAIL）；
③ 注入「连锁 `dueAt` 用 `Date.now()`」→ 到期判定恒真，连锁当帧全炸；
④ 注入「`ignitingTnt` 去重删掉」→ 同一格被引爆两次（`exploded` 计数偏高）；
⑤ 注入「爆炸伤害改用 `EntityManager.entities()` 全量枚举」→ 若有非丧尸实体在场会被炸伤
（该注入须在 spec 里放一个 probe 实体作对照，否则断言恒真 —— testing-policy §2.7 第 1 类盲区）。

- [ ] **Step 9: 验证 GREEN + 门禁 + bench**

Run: `npm run check && npx playwright test tests/tnt.spec.mjs tests/harness.spec.mjs`
Expected: 全绿。

Run: `npm run bench -- --check`
Expected: 通过。⚠️ 爆炸特效新增 1 个 InstancedMesh，须在验收报告记录 draw call 增量
（无爆炸时应回到基线 —— `visible=false`）。
⚠️ **不带 `--check` 跑 bench 会自动重写 `docs/m3-baseline.*`**（冻结基线）—— 诊断后须
`git checkout` 恢复。门禁阻断时先做**交替对照**（vsync 量子化噪声会让 frameP95 误报）。

- [ ] **Step 10: 提交（仅获授权后执行）**

```bash
git add src/voxel/explosion.js src/render/explosion-renderer.js src/player/player.js \
  src/player/weapons/weapon-controller.js src/render/audio-manager.js \
  src/entities/zombies/zombie-system.js src/core/game.js \
  src/ui/settings-panel.js src/ui/settings.js src/tests/test-explosion.js \
  src/tests/index.html tests/tnt.spec.mjs assets/sounds/explosion.mp3
git commit -m "feat(tnt): 引爆与爆炸——3×3×3 破坏 / 5×5×5 连锁 / 4 格 50 伤害"
```

---

### Task 3: 炮塔装置层（蓝图 / service / controller / 背包放置分流）

**Files:**

- Create: `src/entities/turrets/turret-config.js`, `src/entities/turrets/turret-blueprint.js`,
  `src/entities/turrets/turret-service.js`, `src/entities/turrets/turret-controller.js`,
  `src/tests/test-turrets.js`, `tests/turrets.spec.mjs`
- Modify: `src/player/player.js`（`CREATIVE_SPECIALS` + `_placeSpecial` 分流）
- Modify: `src/core/game.js`（turrets 装配 + hydrate + column 生命周期 + 测试 API）
- Modify: `tools/icon-fingerprint.mjs`（`FLAT_BLOCKS` 加 `turret_alias_block`）
- Modify: `assets/icons-atlas.png`, `assets/icons.json`（`npm run icons` 产物）
- Modify: `src/tests/index.html`（注册新单测文件）

**Interfaces:**

- Consumes: `editor.setBlocks(changes)` / `editor.setBlockEntity({x,y,z,value})` /
  `editor.subscribe(listener)` / `persistence.listBlockEntities('turret')` /
  `world.getBlockId(x,y,z)` / `world.hasColumn(cx,cz)` / `zombies.spawn(...)`（Task 6 的发射接线才用）/
  `audioManager.play('put', volume)`
- Produces（Task 4/5/6 依赖，签名必须一致）:

```js
// turret-config.js
export const TURRET = Object.freeze({
  maxTurrets: 20, detectionRange: 50, rotationSpeed: Math.PI / 2, pitchSpeed: Math.PI / 3,
  fireCooldownMs: 500, fireAngleThreshold: 0.26, maxPitchAngle: Math.PI / 4,
  enemyBodyOffsetY: 1.2, losSampleStep: 0.5, targetReacquireMs: 120,
  projectileSpeed: 40, projectileMaxDistance: 50, projectileDamage: 34,
  muzzleOffsetZ: 3.5, pivotHeightOffset: 3.3, aiPeriodMs: 125,
});
export const TURRET_ALIAS_BLOCK = 'turret_alias_block';

// turret-blueprint.js（**代码生成，不 fetch JSON** —— 与 nest-blueprint 不同）
export function createTurretBlueprint(registry);
// → { changesAt(origin), criticalAt(origin), boundsAt(origin), inWorldBounds(origin) }
//   11 格：3×3 iron_ore（y=origin.y）+ 中心两格 obsidian（y+1、y+2）
//   critical = [origin.x, origin.y+2, origin.z]，id = obsidian

// turret-service.js
turrets.place({ origin, playerAabb, rotation });
// → {ok:true, id, anchor:[x,y,z]} | {ok:false, reason:'limit'|'bounds'|'occupied'|'player-overlap'}
turrets.hydrate(persistence);      // Promise<void>
turrets.controllers();             // ReadonlyMap<string, TurretController>
turrets.destroy(id);               // boolean
turrets.count();                   // number（全局索引条目数 = 上限判定来源）
turrets.setController(id, controller|null);
turrets.hasIndex(id);              // boolean
turrets.registerAnchor(id, anchor);
turrets.anchorOf(id);              // [x,y,z] | null
turrets.anchorColumnKey(id);       // string | null

// turret-controller.js
new TurretController({ world, zombies, editor, anchor, onInvalidated });
controller.onWorldChange(event);   // block-changed 增量失效
controller.update(nowMs);          // 朝向插值 + 开火节流（Task 4/6 填充内部逻辑）
controller.dispose();

// game.js
game.placeTurret(origin);          // 测试 API
game.selectPlaceable('turret_alias_block');  // 既有 API，CREATIVE_SPECIALS 扩项后自动可用
game.turretsDebugState();          // { count, controllers }；只读测试钩子
```

- [ ] **Step 1: 写失败的蓝图与放置测试**

新建 `src/tests/test-turrets.js`，并在 `src/tests/index.html` 追加
`import './test-turrets.js';`。fixture 照 `test-zombie-nests.js` 的 `makeNestFixture`
同手法（fake editor 记录 `calls`）。

```js
test('炮塔蓝图：11 格结构 + 唯一锚点在最高 obsidian', () => {
  const registry = makeRegistry();
  const bp = createTurretBlueprint(registry);
  const changes = bp.changesAt([10, 4, 10]);
  assertEqual(changes.length, 11);                       // 3×3 底座 + 2 柱
  const ironId = registry.idOf('iron_ore');
  const obsidianId = registry.idOf('obsidian');
  assertEqual(changes.filter((c) => c.id === ironId).length, 9);
  assertEqual(changes.filter((c) => c.id === obsidianId).length, 2);
  // 锚点 = 最高 obsidian 上格
  const critical = bp.criticalAt([10, 4, 10]);
  assertEqual(critical.x, 10); assertEqual(critical.y, 6); assertEqual(critical.z, 10);
  assertEqual(critical.id, obsidianId);
  // 底座最低层落在 origin.y（玩家脚下的地面格），**不是** origin.y+1（悬空一格）
  assertEqual(Math.min(...changes.map((c) => c.y)), 4);
  assertTrue(bp.inWorldBounds([10, 4, 10]));
  assertEqual(bp.inWorldBounds([10, WORLD_MAX_Y - 1, 10]), false);   // 顶部越界
});

test('炮塔放置：第 21 个、重叠与玩家重叠均零写入', () => {
  // ⚠️ **fixture 须预加载 column 0~15**（20 个炮塔跨 x=0..228 → cx=0..14）：
  // place() 预检顺序是 bounds（含 hasColumn）→ occupied → player-overlap → limit，
  // 不预加载会先返回 'bounds'，下面的 'limit'/'player-overlap' 断言根本跑不到。
  const { turrets, editor, playerAabb } = makeTurretFixture({ loadedColumns: 16 });
  for (let i = 0; i < 20; i++) {
    assertTrue(turrets.place({ origin: [i * 12, 0, 0], playerAabb: null, rotation: 0 }).ok);
  }
  const before = editor.calls.length;
  assertEqual(turrets.place({ origin: [240, 0, 0], playerAabb: null, rotation: 0 }).reason, 'limit');
  assertEqual(turrets.place({ origin: [0, 0, 0], playerAabb: null, rotation: 0 }).reason, 'occupied');
  assertEqual(turrets.place({ origin: [252, 0, 0], playerAabb, rotation: 0 }).reason, 'player-overlap');
  assertEqual(editor.calls.length, before);             // 三种失败路径零写入
});

test('炮塔放置：一次事务写 11 格且锚点带 blockEntity', () => {
  const { turrets, editor } = makeTurretFixture();
  const r = turrets.place({ origin: [4, 0, 4], playerAabb: null, rotation: Math.PI / 2 });
  assertTrue(r.ok);
  assertEqual(editor.setBlocksCalls.length, 1);         // **一次**事务
  const changes = editor.setBlocksCalls[0];
  assertEqual(changes.length, 11);
  const withEntity = changes.filter((c) => c.blockEntity);
  assertEqual(withEntity.length, 1);                    // 只有锚点格带 entity
  assertEqual(withEntity[0].blockEntity.kind, 'turret');
  assertEqual(withEntity[0].blockEntity.rotation, Math.PI / 2);
  assertEqual(withEntity[0].blockEntity.lastFireAt, 0);
  // alias 方块**不在** changes 里（炮塔结构不含 turret_alias_block）
  const aliasId = turrets.registry.idOf('turret_alias_block');
  assertEqual(changes.some((c) => c.id === aliasId), false);
});

test('炮塔失效：关键格被破坏即注销，时钟写回不失效', () => {
  const { turrets, controller, anchor } = makeTurretControllerFixture();
  let invalidated = null;
  controller.onWorldChange({ type: 'block-changed', changes: [
    { x: anchor.x, y: anchor.y, z: anchor.z, newId: 0 },     // 挖掉 → newId !== critical.id
  ] });
  // 时钟写回（同格同 id）→ **不**失效
  const c2 = makeController(anchor);
  c2.onWorldChange({ type: 'block-changed', changes: [
    { x: anchor.x, y: anchor.y, z: anchor.z, newId: anchor.id },
  ] });
  assertEqual(c2.isInvalidated(), false);
});

test('hydrate 从 edits store 恢复全局索引（跨 column 卸载仍有效）', async () => {
  const { turrets, persistence } = makeTurretFixture();
  persistence.editsCache.set('0,0', [{ index: blockIndex(4, 6, 4), id: obsidianId, meta: 0,
    blockEntity: { kind: 'turret', id: 'turret-1', origin: [4, 4, 4],
      critical: { x: 4, y: 6, z: 4, id: obsidianId }, rotation: 0, lastFireAt: 0 } }]);
  await turrets.hydrate(persistence);
  assertEqual(turrets.count(), 1);
  assertEqual(turrets.anchorOf('turret-1')[1], 6);
});
```

`makeController(anchor)` 与 `controller.isInvalidated()` 是本任务新增的诊断接口
（照 `ZombieNestController` 的 `_invalidated` 私有字段 + 只读 getter 同手法）。

- [ ] **Step 2: 验证 RED**

Run: `npx playwright test tests/harness.spec.mjs`
Expected: FAIL —— `createTurretBlueprint` / `TurretService` / `TurretController` 未定义。

- [ ] **Step 3: 实现 config 与蓝图**

`src/entities/turrets/turret-config.js`（数值逐项对齐 mc-lite `TURRET_CONFIG`）：

```js
// src/entities/turrets/turret-config.js — M8：炮塔冻结玩法数据（规格 §4.2）
// 同构层：**无 DOM、无 three**（`npm run check:arch` 静态门守）。
// 本文件是炮塔玩法数值的**唯一权威** —— system / service / controller / renderer / 测试
// 都从这里派生，不得各自写字面量（红线 1）。数值逐项实测自 mc-lite `Turret.js`
// 的 `TURRET_CONFIG`（读源，非推断）。

/**
 * ⚠️ **单位换算须核对**：mc-lite 的 `ROTATION_SPEED`/`PITCH_SPEED`/`PROJECTILE_SPEED` 都乘
 * `deltaTime`（`Turret.js:637`、`Projectile.js:89`），即**已是格/秒与弧度/秒** ——
 * 与 `ZOMBIE.speed` 那种「格/帧须 ×60」的情况相反（`Zombie.js` 的 `predictNextPosition`
 * 不乘 dt）。故**照搬不做 ×60 换算**；验收须 A/B 对照实测（这类缺陷肉眼难辨）。
 */
export const TURRET = Object.freeze({
  /** 全局最多 20 个（mc-lite `TurretManager.maxTurrets`）。上限判定走 edits store 扫库 */
  maxTurrets: 20,
  /** 检测范围 50 格（`DETECTION_RANGE`） */
  detectionRange: 50,
  /** 旋转速度 π/2 弧度/秒（`ROTATION_SPEED`） */
  rotationSpeed: Math.PI / 2,
  /** 俯仰速度 π/3 弧度/秒（`PITCH_SPEED`） */
  pitchSpeed: Math.PI / 3,
  /** 开火冷却 500ms（`FIRE_COOLDOWN`） */
  fireCooldownMs: 500,
  /** 射击角度阈值 0.26 弧度 ≈ 15°（`FIRE_ANGLE_THRESHOLD`），yaw 与 pitch 各判一次 */
  fireAngleThreshold: 0.26,
  /** 最大俯仰角 ±45°（`MAX_PITCH_ANGLE`） */
  maxPitchAngle: Math.PI / 4,
  /** 瞄准点 Y 偏移 1.2（丧尸胸部，`ENEMY_BODY_OFFSET_Y`） */
  enemyBodyOffsetY: 1.2,
  /** LOS 采样步长 0.5 格（`LOS_SAMPLE_STEP`） */
  losSampleStep: 0.5,
  /** 目标重选间隔 120ms（`TARGET_REACQUIRE_INTERVAL`） */
  targetReacquireMs: 120,
  /** 弹丸速度 40 格/秒（`PROJECTILE_SPEED`） */
  projectileSpeed: 40,
  /** 弹丸最大飞行距离 50 格（`MAX_KILL_DISTANCE`） */
  projectileMaxDistance: 50,
  /**
   * 弹丸伤害 34（**换算值**，mc-lite 无此数字）：mc-lite 是 `hitCount` 计数 + `maxHits=3`
   * （`Zombie.js:163`），mc-heavy 是 `ZOMBIE.health=100` + 数值伤害。34 × 3 = 102 ≥ 100 →
   * 保持「三发杀死」语义。测试须在**临界值附近**断言（两发不死、三发死）——
   * 远离阈值的输入测不出换算错误。
   */
  projectileDamage: 34,
  /** 炮口 Z 偏移 3.5（`MUZZLE_OFFSET_Z`，炮管最前端） */
  muzzleOffsetZ: 3.5,
  /** 旋转中心高度偏移 3.3（`PIVOT_HEIGHT_OFFSET`，相对底座 position.y） */
  pivotHeightOffset: 3.3,
  /** AI RPC 周期 125ms ≈ 8Hz（对齐 `TARGET_REACQUIRE_INTERVAL` 的 120ms） */
  aiPeriodMs: 125,
});

/** 受控创造模式选择入口的物品名（照 nest-config.js 的 NEST_ALIAS_BLOCK 同手法） */
export const TURRET_ALIAS_BLOCK = 'turret_alias_block';
```

`src/entities/turrets/turret-blueprint.js` —— **代码生成，不 fetch JSON**
（mc-lite `TurretPlacementHandler.place()` 是逐格 `setBlock` 写死的 11 格结构，没有 JSON 蓝图；
这与巢穴的 `zombie_nest.json` 不同）：

```js
// src/entities/turrets/turret-blueprint.js — M8：炮塔结构展开（代码生成）
// 同构层：无 DOM、无 three。结构照搬 mc-lite `TurretPlacementHandler.place()`：
// 3×3 `iron_ore` 底座（y=origin.y）+ 中心两格 `obsidian` 柱（y+1、y+2），合计 11 格。
// **不 fetch JSON** —— mc-lite 也是硬编码结构（无 turret.json），与巢穴的 JSON 蓝图不同。
// 蓝图是**只读**的：只做坐标/id 展开，不持有体素数据、不复制第二份方块真相（红线 1）。
import { WORLD_MIN_Y, WORLD_MAX_Y } from '../../voxel/constants.js';

/** 底座材质与柱子材质（mc-lite `place()` 的 `iron_ore` / `obsidian`） */
const BASE_BLOCK = 'iron_ore';
const PILLAR_BLOCK = 'obsidian';
/** 柱子高度 2 格 → 锚点在 origin.y + 2 */
const PILLAR_HEIGHT = 2;

/**
 * @param {ReturnType<import('../../voxel/block-registry.js').createRegistry>} registry
 * @returns {{changesAt: Function, criticalAt: Function, boundsAt: Function, inWorldBounds: Function}}
 */
export function createTurretBlueprint(registry) {
  const baseId = registry.idOf(BASE_BLOCK);
  const pillarId = registry.idOf(PILLAR_BLOCK);
  // 展开相对坐标：3×3 底座（dy=0）+ 中心柱（dy=1..2）
  const expanded = [];
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) expanded.push({ x: dx, y: 0, z: dz, id: baseId });
  }
  for (let dy = 1; dy <= PILLAR_HEIGHT; dy++) expanded.push({ x: 0, y: dy, z: 0, id: pillarId });
  const criticalRel = { x: 0, y: PILLAR_HEIGHT, z: 0 };

  return {
    /** 11 个写入项（origin 平移）。不带 blockEntity —— 锚点富状态由 service 附加。 */
    changesAt(origin) {
      return expanded.map((b) => ({
        x: b.x + origin[0], y: b.y + origin[1], z: b.z + origin[2], id: b.id, meta: 0,
      }));
    },
    /** 锚点 = 最高 obsidian 上格（origin.y + 2） */
    criticalAt(origin) {
      return {
        x: criticalRel.x + origin[0], y: criticalRel.y + origin[1], z: criticalRel.z + origin[2],
        id: pillarId,
      };
    },
    /** 占地 AABB（玩家重叠判定）。方块占据 [x, x+1)，故 max 边界 +1。 */
    boundsAt(origin) {
      return {
        minX: -1 + origin[0], maxX: 2 + origin[0],
        minY: origin[1], maxY: PILLAR_HEIGHT + 1 + origin[1],
        minZ: -1 + origin[2], maxZ: 2 + origin[2],
      };
    },
    inWorldBounds(origin) {
      const b = this.boundsAt(origin);
      return b.minY >= WORLD_MIN_Y && b.maxY <= WORLD_MAX_Y;
    },
  };
}
```

- [ ] **Step 4: 实现 service 与 controller**

`src/entities/turrets/turret-service.js` —— 照 `ZombieNestService` 同结构（全局索引 +
预检 + 原子放置 + hydrate），**逐方法同构**，只改 kind / 上限来源 / 锚点形状：

```js
// src/entities/turrets/turret-service.js — M8 炮塔服务：全局索引 + 预检 + 原子放置
// 同构层：不得 import three。**复用 M7 的方块锚定装置模式**（roadmap「M7 交付的可复用模式」）。
// 职责边界（规格 §3）：
// - 全局索引是派生对象，不是第二份权威（红线 1）—— 持久真相只有锚点 blockEntity；
// - 放置的全部写入经**一次** `WorldEditor.setBlocks()` 事务，失败时没有部分方块/anchor/索引条目；
// - 不轮询 mesh、不维护影子方块表、不另开破坏路径。
import { TURRET } from './turret-config.js';
import { columnKeyAt } from '../../voxel/constants.js';

export class TurretService {
  /**
   * @param {{world, editor, registry, blueprint,
   *          onPlaced?: (id: string, anchor: [number,number,number]) => void}} deps
   *        `onPlaced`（M7 同手法）：放置成功后回调，由 Game 注入「创建 controller」。
   *        **必须有这条路径** —— anchor column 此刻已加载，`onColumnReady` 早在放置前
   *        触发过了，不会再为新锚点触发一次 → 没有它则新炮塔永不工作。
   */
  constructor({ world, editor, registry, blueprint, onPlaced = null }) {
    this.world = world; this.editor = editor; this.registry = registry;
    this.blueprint = blueprint; this._onPlaced = onPlaced;
    /** 派生全局索引：`Map<id, {anchor:[x,y,z], rotation:number}>`。**只含 id/anchor/rotation** */
    this._index = new Map();
    /** 派生 controller 表：`Map<id, TurretController>` */
    this._controllers = new Map();
  }

  count() { return this._index.size; }
  controllers() { return this._controllers; }

  /**
   * 放置炮塔。**预检顺序**（位置合法性先于全局上限，照 M7）：
   * `bounds` → `occupied` → `player-overlap` → `limit`。任何失败都在调 editor **之前**返回。
   * @param {{origin:[number,number,number], playerAabb: Object|null, rotation: number}} req
   */
  place({ origin, playerAabb, rotation = 0 }) {
    // ① bounds：任一格越界或目标 column 未加载
    if (!this.blueprint.inWorldBounds(origin)) return { ok: false, reason: 'bounds' };
    const changes = this.blueprint.changesAt(origin);
    for (const c of changes) {
      if (!this.world.hasColumn(Math.floor(c.x / 16), Math.floor(c.z / 16))) {
        return { ok: false, reason: 'bounds' };
      }
    }
    // ② occupied：所有蓝图位置必须为空
    for (const c of changes) {
      if (this.world.getBlockId(c.x, c.y, c.z) !== 0) return { ok: false, reason: 'occupied' };
    }
    // ③ player-overlap：结构 AABB 与玩家 AABB 相交（不得把玩家埋进结构里）
    if (playerAabb) {
      const b = this.blueprint.boundsAt(origin);
      if (playerAabb.minX < b.maxX && playerAabb.maxX > b.minX &&
          playerAabb.minY < b.maxY && playerAabb.maxY > b.minY &&
          playerAabb.minZ < b.maxZ && playerAabb.maxZ > b.minZ) {
        return { ok: false, reason: 'player-overlap' };
      }
    }
    // ④ limit：全局最多 20 个（跨 column 卸载与重启仍有效 —— 索引来自 edits store）
    if (this._index.size >= TURRET.maxTurrets) return { ok: false, reason: 'limit' };

    // ---- 全部预检通过：一次事务 ----
    const critical = this.blueprint.criticalAt(origin);
    const id = this._nextId();
    const anchorEntity = {
      kind: 'turret', id,
      origin: [origin[0], origin[1], origin[2]],
      critical: { x: critical.x, y: critical.y, z: critical.z, id: critical.id },
      rotation,          // 放置时的默认朝向（无目标时回归它）
      lastFireAt: 0,
    };
    const rawChanges = changes.map((c) => (
      (c.x === critical.x && c.y === critical.y && c.z === critical.z)
        ? { ...c, blockEntity: anchorEntity } : c
    ));
    // 预检前的 id/meta，供事务未完整成功时回滚（M7 同手法）
    const prior = rawChanges.map((c) => ({
      x: c.x, y: c.y, z: c.z,
      id: this.world.getBlockId(c.x, c.y, c.z), meta: this.world.getBlockMeta(c.x, c.y, c.z),
    }));

    const report = this.editor.setBlocks(rawChanges);
    if (report.changes.length !== rawChanges.length || report.skipped.length !== 0) {
      this.editor.setBlocks(prior);   // 回滚，绝不留下「半个炮塔」
      return { ok: false, reason: 'bounds' };
    }
    this._index.set(id, { anchor: [critical.x, critical.y, critical.z], rotation });
    if (this._onPlaced) this._onPlaced(id, [critical.x, critical.y, critical.z]);
    return { ok: true, id, anchor: [critical.x, critical.y, critical.z] };
  }

  /** 删除炮塔：删锚点 + 移除索引 + 注销 controller。**绝不扫描未加载 column 判数量** */
  destroy(id) {
    const entry = this._index.get(id);
    if (!entry) return false;
    const [x, y, z] = entry.anchor;
    this.editor.setBlockEntity({ x, y, z, value: null });
    this._index.delete(id);
    this._controllers.delete(id);
    return true;
  }

  /** 从存档恢复派生索引。⚠️ 调用前必须先 `flushNow()`（hydrate 是 clear()+重建） */
  async hydrate(persistence) {
    const anchors = await persistence.listBlockEntities('turret');
    this._index.clear();
    for (const { blockEntity } of anchors) {
      if (!blockEntity?.critical) continue;
      const { x, y, z } = blockEntity.critical;
      this._index.set(blockEntity.id, { anchor: [x, y, z], rotation: blockEntity.rotation ?? 0 });
    }
  }

  /** 确定性 id（不用 `Math.random()` —— 红线 2）。从现有索引取最大后缀 +1 */
  _nextId() {
    let max = 0;
    for (const id of this._index.keys()) {
      const n = Number.parseInt(id.replace(/^turret-/, ''), 10);
      if (Number.isFinite(n) && n > max) max = n;
    }
    return `turret-${max + 1}`;
  }

  setController(id, controller) {
    if (controller === null || controller === undefined) this._controllers.delete(id);
    else this._controllers.set(id, controller);
  }
  hasIndex(id) { return this._index.has(id); }
  registerAnchor(id, anchor, rotation = 0) { this._index.set(id, { anchor, rotation }); }
  anchorOf(id) { const e = this._index.get(id); return e ? e.anchor : null; }
  rotationOf(id) { const e = this._index.get(id); return e ? e.rotation : 0; }
  anchorColumnKey(id) {
    const e = this._index.get(id);
    return e ? columnKeyAt(e.anchor[0], e.anchor[2]) : null;
  }
}
```

`src/entities/turrets/turret-controller.js` —— 失效判定照 `ZombieNestController` 同口径
（Task 4/6 会往 `update()` 里填朝向插值与发射逻辑，本任务只交付失效 + 时钟写回骨架）：

```js
// src/entities/turrets/turret-controller.js — M8 炮塔控制器：增量失效 + 运行态时钟
// 同构层：不得 import three。
// 职责边界（规格 §3.2）：
// - **只在 anchor column 已加载时存在** —— 派生对象，不是持久状态。column 卸载即销毁，
//   再次加载后从 blockEntity 恢复（`lastFireAt` 不重置）；
// - 失效订阅 `block-changed` **增量事件**，不轮询 mesh（mc-lite 是每 30 帧轮询
//   `checkIntegrity()`，本仓库改走事件 —— 有意偏离，规格 §3.2）。
import { TURRET } from './turret-config.js';

export class TurretController {
  /**
   * @param {{world, zombies, editor, anchor: Object, onInvalidated?: (id:string)=>void}} deps
   *        `onInvalidated` 由 Game 注入 `(id) => turrets.destroy(id)`（注入而非持有 service
   *        引用 —— 与本仓库 `isModal`/`onSpawnZombie`/`damage` 同一惯例，且让 controller 可独立单测）。
   */
  constructor({ world, zombies, editor, anchor, onInvalidated = null }) {
    this.world = world; this.zombies = zombies; this.editor = editor;
    this.anchor = anchor; this._onInvalidated = onInvalidated;
    this.id = anchor?.id ?? null;
    /** 最近一次开火时刻（ms，performance 基准）。与 anchor.lastFireAt 同源同步 */
    this.lastFireAt = anchor?.lastFireAt ?? 0;
    /** 当前朝向（弧度）。初值 = 放置时的默认朝向；Task 4 的插值在此累积 */
    this.currentRotation = anchor?.rotation ?? 0;
    this.currentPitch = 0;
    /** Task 4 填充：worker 回包的目标朝向与开火标志 */
    this.targetRotation = this.currentRotation;
    this.targetPitch = 0;
    this._invalidated = false;
  }

  /** 只读诊断接口（单测断言失效状态用，照 ZombieNestController 同手法） */
  isInvalidated() { return this._invalidated; }

  /**
   * 增量失效判定（M7 同口径）。判据 = **坐标覆盖关键格且 `newId !== critical.id`**。
   *
   * ⚠️ **同格写回同 id 不得失效**：炮塔每次开火都用 `editor.setBlockEntity` 写回
   * `lastFireAt`。若判定只看「坐标覆盖关键格」，自己的时钟写回就会把炮塔杀掉
   * （M7 实测踩坑，规格 §3.2）。
   *
   * 徒手挖掉、M4 武器破坏、M8 TNT 批量编辑走的是同一条 setBlock/setBlocks，
   * 三者产生的 change 都带同样的坐标与 newId → 必然同义。
   * @param {{type:'block-changed', changes: Array<{x,y,z,newId:number}>}} event
   */
  onWorldChange(event) {
    if (this._invalidated) return;
    const critical = this.anchor?.critical;
    if (!critical) return;
    for (const change of event?.changes || []) {
      if (change.x !== critical.x || change.y !== critical.y || change.z !== critical.z) continue;
      if (change.newId === critical.id) continue;   // 同格同 id（时钟写回）→ 不失效
      this._invalidated = true;
      if (this._onInvalidated) this._onInvalidated(this.id);
      return;
    }
  }

  /**
   * 每帧推进（Task 4 填朝向插值、Task 6 填发射）。本任务只交付骨架与失效早退。
   * **时间基准必须是 `performance.now()`** —— 不得用 `Date.now()`（两者相差约 17 亿毫秒，
   * 混用会让冷却判定恒真 → 每帧开火）。
   * @param {number} nowMs @param {number} dt 秒
   * @returns {boolean} 本帧是否开火（Task 6 消费）
   */
  update(nowMs, dt) {
    if (this._invalidated) return false;
    return false;   // Task 4/6 填充
  }

  /**
   * 写回 `lastFireAt`（纯 entity 写：不 bump version、不 remesh/light）。
   * **构造新对象而非原地改 `this.anchor`** —— 原地改会让 `column.blockEntities` 与
   * `column.edits` 持有的同一引用被悄悄改写（红线 1 精神）。
   * 新对象必须保留 kind/id/origin/critical/rotation —— 漏字段会让锚点失真。
   * @param {number} nowMs
   */
  writeBackFireClock(nowMs) {
    this.lastFireAt = nowMs;
    const value = { ...this.anchor, lastFireAt: nowMs };
    this.anchor = value;
    const { x, y, z } = this.anchor.critical;
    this.editor.setBlockEntity({ x, y, z, value });
  }

  dispose() {
    this._invalidated = true;
    this.world = null; this.zombies = null; this.editor = null;
  }
}
```

- [ ] **Step 5: 接线背包放置分流与 Game 装配**

`src/player/player.js` —— `CREATIVE_SPECIALS` 扩项 + `_placeSpecial` 加炮塔分支：

```js
// 物品名派生自两个 config 的单一权威，不在此写字面量（红线 1）
import { NEST_ALIAS_BLOCK } from '../entities/zombie-nests/nest-config.js';
import { TURRET_ALIAS_BLOCK } from '../entities/turrets/turret-config.js';
const CREATIVE_SPECIALS = new Set([NEST_ALIAS_BLOCK, TURRET_ALIAS_BLOCK]);
```

构造函数 opts 加 `turrets = null`，存为 `this.turrets`。⚠️ **`_placeSpecial` 的实际签名是
`_placeSpecial(id, origin)`**（`player.js:442`，参数名是 `id`/`origin`，不是 `item`/`blockPos`），
且既有实现是「先判 `id !== NEST_ALIAS_BLOCK` 就 return false」的单分支结构。改为按物品名分派：

```js
_placeSpecial(id, origin) {
  // M7：巢穴分支（既有实现不变）
  if (id === NEST_ALIAS_BLOCK) {
    if (!this.nests) return false;
    // AABB 派生自 physics（不得在此重算尺寸 —— 否则与碰撞检测的 AABB 撕裂，红线 1）
    const playerAabb = this.physics.aabb();
    const result = this.nests.place({ origin, playerAabb });
    if (!result.ok) return false;
    if (this.audioManager) {
      try { this.audioManager.play('put', 0.6); }
      catch (err) { console.warn('[audio] put play failed:', err); }   // 只记诊断，不回滚
    }
    return true;
  }
  // M8：炮塔分支。**origin = 命中方块格**（调用方传的是 `target.blockPos`）——
  // 底座最低层要落在玩家脚下的地面格上。⚠️ 用 prevPos 会让结构整体上移一格悬空
  // （CLAUDE.md 活跃约束；M7 实测踩坑）。两条放置路径（背包分流与 selectPlaceable
  // 测试 API）的 origin 语义必须一致。
  if (id === TURRET_ALIAS_BLOCK) {
    if (!this.turrets) return false;
    // 默认朝向 = 玩家相对炮塔的方向、取最近四方向之一（mc-lite `DIRECTIONS` 语义）
    const rotation = defaultTurretRotation(this.physics.pos, origin);
    const result = this.turrets.place({
      origin, playerAabb: this.physics.aabb(), rotation,
    });
    if (!result.ok) return false;
    if (this.audioManager) {
      // mc-lite `TurretPlacementHandler.place()` 的 `playSound('put', 0.3)`
      try { this.audioManager.play('put', 0.3); }
      catch (err) { console.warn('[audio] put play failed:', err); }   // 只记诊断，不回滚
    }
    return true;
  }
  return false;
}
```

⚠️ **两个分支的音效音量不同**（巢穴 0.6 / 炮塔 0.3）—— 这是 mc-lite 的实际值
（巢穴 `ZombieNest` 放置 0.6、炮塔 `TurretPlacementHandler` 0.3），不是笔误。

`defaultTurretRotation(playerPos, blockPos)` 放 `turret-config.js` 导出（单一权威，
两条放置路径共用）：

```js
/**
 * 放置时的默认朝向：玩家相对炮塔中心的方向，取最近的四方向之一（mc-lite
 * `TurretPlacementHandler.place()` 的 `DIRECTIONS` 语义照搬）。
 * ⚠️ 这**不是**「方块放置朝向不看玩家 yaw」那条约束的反例 —— 那条说的是单格方块的
 * meta 朝向（M3.2 三分支），炮塔默认朝向是装置运行态、存在 blockEntity 里。
 * @param {{x:number,z:number}} playerPos @param {[number,number,number]} blockPos
 * @returns {number} 弧度（0=+Z / π/2=+X / π=-Z / -π/2=-X）
 */
export function defaultTurretRotation(playerPos, blockPos) {
  const dx = playerPos.x - (blockPos[0] + 0.5);
  const dz = playerPos.z - (blockPos[2] + 0.5);
  if (Math.abs(dx) > Math.abs(dz)) return dx > 0 ? Math.PI / 2 : -Math.PI / 2;
  return dz > 0 ? 0 : Math.PI;
}
```

`tools/icon-fingerprint.mjs` —— `FLAT_BLOCKS` 加 `turret_alias_block`（多方块结构的占位物品，
立方体等轴测图是错的表达；mc-lite `ItemIconUtils.getCustomIconPath()` 把它映射到手工图
`turret.png`）：

```js
export const FLAT_BLOCKS = [
  'water', 'swamp_water', 'cloud', 'flower', 'short_grass', 'allium', 'azure_bluet',
  'dead_bush', 'oxeye_daisy', 'red_mushroom', 'vine', 'lilypad', 'mine_cart', 'hanging_lamp',
  'zombie_nest_alias_block', 'turret_alias_block',
];
```

⚠️ `FLAT_ICON_TILE` **不需要**加条目 —— `faces-data.js:110` 已映射
`turret_alias_block: 'procedural/turret_alias_block'` 且该 tile 在 atlas 内 → 引用完整性门禁
不报（与 `zombie_nest_alias_block` 同情形）。

`src/core/game.js` —— 装配段（**必须在 `_waitForColumn` 之前**，紧跟 M7 巢穴装配之后）：

```js
// ---- M8：炮塔装配 ----
// ⚠️ **装配位置必须在 `_waitForColumn` 之前**（CLAUDE.md 活跃约束）：出生点 column 在
// `_waitForColumn` 时 ready、`onColumnReady` 随之触发。若创建在其后，回调跑时 `this.turrets`
// 还是 null → `_createTurretControllers` 第一行直接 return → reload 后 anchor 与索引都恢复了
// 但 controller 恒为 0（炮塔不工作）。对照 `this.zombies` / `this.nests`：都装配在之前。
this.turrets = new TurretService({
  world: this.world, editor: this.editor, registry: this.registry,
  blueprint: createTurretBlueprint(this.registry),   // 代码生成，无 fetch → 不会失败
  // 放置成功 → 立刻创建 controller。**没有这条接线则新炮塔永不工作**（M7 同坑）
  onPlaced: (id) => this._createTurretController(id),
});
// hydrate 必须在开放放置前。⚠️ hydrate 是 clear()+重建 → 调用前必须先 flushNow()，
// 否则库里没锚点 → 索引被清成 0（真实重启路径本就是 flush → reload → hydrate）
await this.persistence.flushNow(this.world);
await this.turrets.hydrate(this.persistence);
```

失效事件订阅 —— **接到既有的 M7 订阅回调里**（全局只订阅一次，不为每个 controller 单独
subscribe；N 个装置就有 N 份监听器且漏退订就是常驻泄漏）：

```js
this.editor.subscribe((event) => {
  for (const controller of this.nests.controllers().values()) controller.onWorldChange(event);
  for (const controller of this.turrets.controllers().values()) controller.onWorldChange(event);
});
```

column 生命周期 —— 在既有 `_createNestControllers` / `_destroyNestControllers` 的同一位置
加对称方法：

```js
/**
 * 创建炮塔 controller（**照 M7 的实际签名 `_createNestController(id, anchorEntity = null)`**，
 * 不是不存在的 `_readNestAnchor`）。`anchorEntity` 可由调用方直接传入（`onPlaced` 路径此刻
 * anchor 已知，省一次 `getBlockEntity`）；缺省则从 world 重读。
 * @param {string} id @param {Object|null} [anchorEntity]
 */
_createTurretController(id, anchorEntity = null) {
  if (!this.turrets || this.turrets.controllers().has(id)) return;  // 已有 → 不重复创建
  let entity = anchorEntity;
  if (!entity) {
    const anchor = this.turrets.anchorOf(id);
    if (!anchor) return;
    entity = this.world.getBlockEntity(anchor[0], anchor[1], anchor[2]);
  }
  if (!entity || entity.kind !== 'turret') return;
  // 索引缺失（hydrate 前就 ready 的 column）：补登记，使上限判定包含它
  if (!this.turrets.hasIndex(id)) {
    const c = entity.critical;
    this.turrets.registerAnchor(id, [c.x, c.y, c.z], entity.rotation ?? 0);
  }
  const controller = new TurretController({
    world: this.world, zombies: this.zombies, editor: this.editor, anchor: entity,
    onInvalidated: (cid) => this._destroyTurret(cid),
  });
  this.turrets.setController(id, controller);
}

_createTurretControllers(key, column) {
  if (!this.turrets || column?.blockEntities.size === 0) return;
  for (const [, be] of column.blockEntities) {
    if (be?.kind !== 'turret') continue;
    if (!this.turrets.hasIndex(be.id)) {
      const c = be.critical;
      this.turrets.registerAnchor(be.id, [c.x, c.y, c.z], be.rotation ?? 0);
    }
    this._createTurretController(be.id);
  }
}

/** column 卸载 —— 销毁 controller 但**保留 anchor 与全局索引**（炮塔是方块锚定装置，不是临时实体） */
_destroyTurretControllers(key) {
  if (!this.turrets) return;
  for (const [id, controller] of this.turrets.controllers()) {
    if (this.turrets.anchorColumnKey(id) !== key) continue;
    controller.dispose();
    this.turrets.setController(id, null);
  }
}

_destroyTurret(id) { this.turrets.destroy(id); }

/** 帧循环内推进（Task 4/6 填充内部逻辑）。放在 `_updateNestControllers(nowMs)` 之后 */
_updateTurretControllers(nowMs, dt) {
  if (!this.turrets) return;
  for (const controller of this.turrets.controllers().values()) controller.update(nowMs, dt);
}

/** 测试 API */
placeTurret(origin) {
  return this.turrets.place({ origin, playerAabb: null, rotation: 0 });
}
turretsDebugState() {
  return { count: this.turrets.count(), controllers: this.turrets.controllers().size };
}
```

接线四处：① `onColumnReady` 回调里加 `this._createTurretControllers(key, column);`；
② `onColumnWillRemove` 里加 `this._destroyTurretControllers(key);`；
③ 帧循环加 `this._updateTurretControllers(nowMs, dt);`；④ Player 构造 opts 加
`turrets: this.turrets`。

⚠️ **`onColumnWillRemove` 的顺序**：既有代码里 `zombies.despawnColumn(key)` 必须在
`unload.commit()` 之前（CLAUDE.md 活跃约束）。炮塔 controller 不是实体、不进 EntityManager，
故不受此约束，但**弹丸是实体**（Task 6 须处理：弹丸随 column 卸载由 M5 `despawnColumn`
回收，渲染 slot 须在三条路径上显式归还）。

- [ ] **Step 6: 验证 GREEN + 重烘焙图标**

Run: `npx playwright test tests/harness.spec.mjs`
Expected: PASS —— 11 格结构 / 唯一锚点 / 20 上限 / 三种失败零写入 / 一次事务 /
失效与时钟写回区分 / hydrate 恢复索引。

Run: `npm run icons && npm run check`
Expected: 图标指纹匹配（`turret_alias_block` 走平面路径）。
⚠️ **负向验证**：注入「移除 `FLAT_BLOCKS` 里的 `turret_alias_block`」→ 指纹回到 `geom:box`
（门禁须真 FAIL）。⚠️ **注入后先确认源码真的改了** —— M7 实测踩过「perl 模式没匹配 →
注入没生效 → 全绿是假信号」。

- [ ] **Step 7: 写 Playwright E2E（**必须走背包选中路径**）**

`tests/turrets.spec.mjs`：

```js
test('**背包选中路径**：选中 turret_alias_block 右键 → 放置完整 11 格结构', async ({ page }) => {
  await boot(page);
  // 打开背包面板（Z 键）→ 点击 turret_alias_block 槽 → 关闭面板 → 右键
  await page.keyboard.press('KeyZ');
  await page.locator(`[data-item="${'turret_alias_block'}"]`).click();
  await page.keyboard.press('KeyZ');
  const placed = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    const p = g.player.physics.pos;
    // 准心朝下对准脚下地面格（模拟玩家看着地面右键）
    g.player.yaw = 0; g.player.pitch = -Math.PI / 2;
    g.player.setTestAim([0, -1, 0]);   // 朝下对准脚下地面（player.js:304 的既有测试 API）
    g.player.placeBlock();
    return { count: g.turrets.count(), controllers: g.turrets.controllers().size };
  });
  expect(placed.count).toBe(1);
  expect(placed.controllers).toBe(1);   // ⚠️ onPlaced 接线生效（否则恒 0 —— M7 实测坑）
  // 断言**不是**一个贴图案的正方体：11 格结构里 9 格 iron_ore + 2 格 obsidian
  const structure = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    const a = g.turrets.anchorOf('turret-1');
    const ironId = g.registry.idOf('iron_ore'), obsId = g.registry.idOf('obsidian');
    const aliasId = g.registry.idOf('turret_alias_block');
    let iron = 0, obs = 0, alias = 0;
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      if (g.world.getBlockId(a[0] + dx, a[1] - 2, a[2] + dz) === ironId) iron++;
    }
    if (g.world.getBlockId(a[0], a[1] - 1, a[2]) === obsId) obs++;
    if (g.world.getBlockId(a[0], a[1], a[2]) === obsId) obs++;
    if (g.world.getBlockId(a[0], a[1] - 2, a[2]) === aliasId) alias++;
    return { iron, obs, alias };
  });
  expect(structure.iron).toBe(9);
  expect(structure.obs).toBe(2);
  expect(structure.alias).toBe(0);      // 单格 alias 方块是缺陷判据
});

test('reload 后每个锚点只恢复一个 controller（对象引用相等）', async ({ page }) => {
  // 放一个炮塔 → flushNow → reload → 断言 controllers.size === 1
  // ⚠️ **去重断言须比较对象引用**（`first === second`），不能用 `controllers().size`：
  // `_controllers` 按 id 为键，重复创建会覆盖写 → size 恒为 1，注入「不去重」后 size 断言仍全绿
  // （M7 实测无效盲区）。断言 = 两次 `_createTurretController(id)` 后引用未变 + 原对象未被 dispose
});

test('关键 obsidian 被破坏 → controller 注销、锚点与索引删除', async ({ page }) => {
  // 徒手挖 / 武器破坏 / TNT 批量破坏三条路径都须失效（同一 setBlock/setBlocks 语义）
});

test('远处炮塔 column 未加载时上限仍生效', async ({ page }) => {
  // 放满 20 个 → 传送走远（column 卸载 → controller 归零）→ 断言 count 仍 20 且第 21 个 reason==='limit'
  // ⚠️ 用 controller 数判上限会让玩家走远再回来就能无限放置（规格 §3.2）
});
```

⚠️ **负向验证**（全部须真 FAIL）：
① 注入「`onPlaced` 回调删掉」→ `controllers` 恒 0；
② 注入「炮塔装配挪到 `_waitForColumn` 之后」→ reload 后 `controllers` 恒 0
（这正是该 E2E 存在的理由 —— 时序缺陷在纯逻辑测试里测不出来）；
③ 注入「`CREATIVE_SPECIALS` 移除 `turret_alias_block`」→ 背包右键只放出一个 alias 正方体
（`structure.alias` 变 1、`count` 恒 0）；
④ 注入「origin 改用 `prevPos`」→ 结构整体上移一格（`iron` 判据 FAIL）；
⑤ 注入「失效判定去掉 `newId !== critical.id`」→ 炮塔自己的时钟写回把自己杀掉。

- [ ] **Step 8: 提交（仅获授权后执行）**

```bash
git add src/entities/turrets/turret-config.js src/entities/turrets/turret-blueprint.js \
  src/entities/turrets/turret-service.js src/entities/turrets/turret-controller.js \
  src/player/player.js src/core/game.js tools/icon-fingerprint.mjs \
  src/tests/test-turrets.js src/tests/index.html tests/turrets.spec.mjs \
  assets/icons-atlas.png assets/icons.json
git commit -m "feat(turrets): 炮塔装置层——方块锚定 / 20 上限 / 背包放置分流"
```

---

### Task 4: 炮塔 AI（同构纯函数索敌 + 朝向插值 + 开火节流）

**Files:**

- Create: `src/entities/turrets/turret-system.js`
- Modify: `src/entities/turrets/turret-controller.js`（填充 `update()` 的朝向插值与开火节流）
- Modify: `src/core/game.js`（AI 编排：8Hz 调纯函数 + 分派意图）
- Modify: `src/tests/test-turrets.js`（LOS / 索敌 / 角度阈值单测）

**Interfaces:**

- Consumes: Task 3 的 `TURRET`（config）/ `TurretController`（`currentRotation`/`currentPitch`/
  `targetRotation`/`targetPitch`/`lastFireAt` 字段）/ `zombies.activeEntities()`（Task 2 新增）/
  `world.getBlockId(x,y,z)` / `registry.solidTable` / `registry.opaqueTable`
- Produces（Task 5/6 依赖，签名必须一致）:

```js
computeTurretUpdates({ turrets, zombies, world, registry })
// → { updates: Array<{id, targetYaw, targetPitch}> }（无 generation —— 不走 RPC）
//   turrets: Array<{id, pivot:[x,y,z], rotation}>；zombies: Array<{id, position:[x,y,z]}>

hasLineOfSight({ world, registry, from:[x,y,z], to:[x,y,z] });  // boolean（遮挡判据共用）
isProjectileOccluding(id, registry);   // boolean：实心且不透明才阻挡（弹丸与 LOS 共用）

controller.update(nowMs, dt);   // → boolean（本帧是否开火）；填充朝向插值 + 开火节流
controller.muzzle(nowMs);       // → { position:[x,y,z], direction:[dx,dy,dz] }（Task 6 发射用）
controller.targetRotation;      // number（纯函数写入）
controller.targetPitch;         // number（纯函数写入）
```

- [ ] **Step 1: 写失败的索敌与 LOS 测试**

在 `src/tests/test-turrets.js` 追加：

```js
test('computeTurretUpdates：最近的可见丧尸成为目标，算出 yaw/pitch', () => {
  const { world, registry } = makeWorldFixture();
  const turrets = [{ id: 'turret-1', pivot: [10.5, 7.3, 10.5], rotation: 0 }];
  // 一只近、一只远；都在检测范围内
  const zombies = [
    { id: 'z-far', position: [30.5, 4, 10.5] },
    { id: 'z-near', position: [13.5, 4, 10.5] },
  ];
  const r = computeTurretUpdates({ turrets, zombies, world, registry });
  assertEqual(r.updates.length, 1);
  // 近丧尸在 +X 方向 → yaw 指向 +X（atan2 口径，不是 Euler 反解 —— 见下方 CLAUDE.md 约束）
  assertTrue(Math.abs(r.updates[0].targetYaw) > 0);
  // pitch 有限（丧尸在下方 → 俯视）
  assertTrue(r.updates[0].targetPitch <= 0);
});

test('computeTurretUpdates：无丧尸时回归默认朝向', () => {
  const { world, registry } = makeWorldFixture();
  const turrets = [{ id: 'turret-1', pivot: [10.5, 7.3, 10.5], rotation: 1.2 }];
  const r = computeTurretUpdates({ turrets, zombies: [], world, registry });
  assertEqual(r.updates[0].targetYaw, 1.2);   // 回归 placement rotation
  assertEqual(r.updates[0].targetPitch, 0);
});

test('hasLineOfSight：实心不透明方块阻挡，透明方块不阻挡', () => {
  const { world, registry } = makeWorldFixture();
  const from = [10.5, 7.3, 10.5], to = [10.5, 4, 20.5];
  // 无遮挡 → 可见
  assertTrue(hasLineOfSight({ world, registry, from, to }));
  // 中间放一格 stone（实心不透明）→ 阻挡
  world.setBlock(10, 5, 15, registry.idOf('stone'));
  assertEqual(hasLineOfSight({ world, registry, from, to }), false);
  // 换成 glass_block（实心但透明）→ 不阻挡。⚠️ 方块名是 `glass_block`，本仓 registry **无
  // `glass`**（实测 `blocks-data.js`）。对照样本须用真实存在的方块名，否则 idOf 返回 undefined。
  world.setBlock(10, 5, 15, registry.idOf('glass_block'));
  assertTrue(hasLineOfSight({ world, registry, from, to }));
});

test('isProjectileOccluding：solid && opaque 才阻挡（LOS 与弹丸共用判据）', () => {
  const registry = makeRegistry();
  assertTrue(isProjectileOccluding(registry.idOf('stone'), registry));   // 实心不透明
  assertEqual(isProjectileOccluding(registry.idOf('glass_block'), registry), false);  // 实心但透明
  assertEqual(isProjectileOccluding(registry.idOf('leaves'), registry), false);       // 实心但 cutout
  assertEqual(isProjectileOccluding(registry.idOf('water'), registry), false);  // 非实心
  assertEqual(isProjectileOccluding(registry.idOf('air'), registry), false);
});

test('controller.update：朝向按限角速度插值，未对准不开火；对准且冷却到期开火', () => {
  const { controller } = makeTurretControllerFixture();
  controller.targetRotation = Math.PI;   // 目标朝向与当前差 π
  // 第一帧：插值一小步（限角速度 π/2 × dt），yawDiff 仍 > 0.26 → 不开火
  assertEqual(controller.update(1000, 1 / 60), false);
  assertTrue(Math.abs(controller.currentRotation) < Math.PI);   // 只走了一步
  // 推进到对准 + 冷却到期 → 开火
  controller.currentRotation = controller.targetRotation;
  controller.currentPitch = controller.targetPitch;
  assertEqual(controller.update(1000 + TURRET.fireCooldownMs, 1 / 60), true);
  // 冷却未到 → 不开火
  assertEqual(controller.update(1000 + TURRET.fireCooldownMs + 1, 1 / 60), false);
});
```

- [ ] **Step 2: 验证 RED**

Run: `npx playwright test tests/harness.spec.mjs`
Expected: FAIL —— `computeTurretUpdates` / `hasLineOfSight` / `isProjectileOccluding` 未定义；
`controller.update` 恒返回 false（Task 3 的骨架）。

- [ ] **Step 3: 实现 `src/entities/turrets/turret-system.js`**

```js
// src/entities/turrets/turret-system.js — M8：炮塔索敌（同构纯函数，规格 §4）
// 同构层：**无 DOM、无 three**（`npm run check:arch` 静态门守）。
//
// **在主线程执行，不走 Worker**（规格 §4.1）：索敌必须做 LOS 判定，而 LOS 必须读方块 ——
// Worker 内没有持久世界数据（`world-worker.js:178`「worker 里没有世界数据，也不该有」）。
// 传体素 view 给 worker = 每 RPC 1.28MB / 每秒 10MB 结构化克隆；worker 内持久化世界数据 =
// 第二份体素权威（违反红线 1）。故 LOS 留在主线程，红线 3 的第二个边界判定例外。
//
// 数值逐项对齐 mc-lite `TURRET_CONFIG`（见 turret-config.js）。遮挡判据
// `isProjectileOccluding` 被**两个消费方**共用（LOS + 弹丸）—— 红线 1：各写一份会漂移出
// 「看得见但打不着」的撕裂状态。
import { TURRET } from './turret-config.js';

/**
 * 方块是否阻挡视线/弹丸：只有「实心且不透明」阻挡（mc-lite `isBlockOccluding` 同口径
// `props.isSolid && !props.isTransparent`）。透明方块（玻璃/水/云）可穿透。
 * @param {number} id @param {ReturnType<import('../../voxel/block-registry.js').createRegistry>} registry
 * @returns {boolean}
 */
export function isProjectileOccluding(id, registry) {
  if (id === 0) return false;   // air
  return registry.solidTable[id] === 1 && registry.opaqueTable[id] === 1;
}

/**
 * 视线判定（mc-lite `hasLineOfSightToEnemy` 语义照搬）：沿 from→to 按 `losSampleStep` 步长
 * 采样，任一采样格被「实心不透明」方块占据即不可见。
 * @param {{world, registry, from:[number,number,number], to:[number,number,number]}} p
 * @returns {boolean}
 */
export function hasLineOfSight({ world, registry, from, to }) {
  const dx = to[0] - from[0], dy = to[1] - from[1], dz = to[2] - from[2];
  const total = Math.hypot(dx, dy, dz);
  // 起点偏移避免采样到炮塔自身；终点容差避免目标贴身方块误判（mc-lite LOS_*_EPSILON）
  const LOS_START_EPSILON = 0.1, LOS_TARGET_EPSILON = 0.35;
  if (total <= LOS_START_EPSILON) return true;
  const ux = dx / total, uy = dy / total, uz = dz / total;
  const start = LOS_START_EPSILON;
  const end = Math.max(start, total - LOS_TARGET_EPSILON);
  let lastX = NaN, lastY = NaN, lastZ = NaN;
  for (let d = start; d <= end; d += TURRET.losSampleStep) {
    const bx = Math.floor(from[0] + ux * d);
    const by = Math.floor(from[1] + uy * d);
    const bz = Math.floor(from[2] + uz * d);
    if (bx === lastX && by === lastY && bz === lastZ) continue;   // 同格跳过重复查询
    lastX = bx; lastY = by; lastZ = bz;
    if (isProjectileOccluding(world.getBlockId(bx, by, bz), registry)) return false;
  }
  return true;
}

/**
 * 计算一批炮塔的索敌意图。**在主线程同步执行**（规格 §4.1）。
 *
 * 目标选择（mc-lite `findTarget`）：检测范围内**最近**且 LOS 可见的丧尸；先 `distSq` 粗筛
 * 再 LOS（避免对所有丧尸跑 LOS）。无目标时回归炮塔的默认朝向（`rotation`）。
 *
 * ⚠️ **yaw/pitch 用 atan2 算，不用 Euler 反解**（CLAUDE.md 活跃约束：three 的 Euler 'XYZ'
 * 序对 Y 轴用 `asin(m13)`，`|θ| > π/2` 时折叠回 `[-π/2, π/2]`）。本函数从坐标直接算角度，
 * 天然规避；渲染层反解朝向时须用 `atan2(elements[8], elements[0])`（见 Task 5）。
 *
 * @param {{turrets: Array<{id:string, pivot:[number,number,number], rotation:number}>,
 *          zombies: Array<{id:string, position:[number,number,number]}>,
 *          world, registry}} p
 * @returns {{updates: Array<{id:string, targetYaw:number, targetPitch:number}>}}
 */
export function computeTurretUpdates({ turrets, zombies, world, registry }) {
  const updates = [];
  const list = zombies ?? [];
  for (const t of turrets ?? []) {
    let target = null;
    let minDistSq = TURRET.detectionRange * TURRET.detectionRange;
    if (list.length > 0) {
      for (const z of list) {
        // 瞄准丧尸上半身（胸部）—— mc-lite `ENEMY_BODY_OFFSET_Y`
        const tx = z.position[0], ty = z.position[1] + TURRET.enemyBodyOffsetY, tz = z.position[2];
        const dx = tx - t.pivot[0], dy = ty - t.pivot[1], dz = tz - t.pivot[2];
        const distSq = dx * dx + dy * dy + dz * dz;
        if (distSq >= minDistSq) continue;   // 粗筛：超范围或非最近
        if (!hasLineOfSight({ world, registry, from: t.pivot, to: [tx, ty, tz] })) continue;
        minDistSq = distSq;
        target = [tx, ty, tz];
      }
    }
    if (!target) {
      updates.push({ id: t.id, targetYaw: t.rotation, targetPitch: 0 });   // 回归默认朝向
      continue;
    }
    const dx = target[0] - t.pivot[0], dy = target[1] - t.pivot[1], dz = target[2] - t.pivot[2];
    // yaw = atan2(dx, dz)（+Z 为 0，顺时针为正；与渲染层反解口径一致）
    const targetYaw = Math.atan2(dx, dz);
    // pitch = atan2(dy, 水平距离)，限制在 ±45°
    const horizontal = Math.hypot(dx, dz);
    let targetPitch = Math.atan2(dy, horizontal);
    targetPitch = Math.max(-TURRET.maxPitchAngle, Math.min(TURRET.maxPitchAngle, targetPitch));
    updates.push({ id: t.id, targetYaw, targetPitch });
  }
  return { updates };
}
```

⚠️ `hasLineOfSight` 与 `isProjectileOccluding` 里的常量（`LOS_START_EPSILON`/`LOS_TARGET_EPSILON`）
目前内联。若 Task 6 的弹丸遮挡也要用 epsilon，把它们提到 `turret-config.js`（单一权威，
红线 1）—— 本任务先内联，Task 6 视需要再提取并在验收报告记录。

- [ ] **Step 4: 填充 `TurretController.update()` 与朝向插值**

替换 Task 3 的 `update()` 骨架：

```js
update(nowMs, dt) {
  if (this._invalidated) return false;
  // ---- 朝向插值（限角速度，mc-lite `updateRotation` 语义）----
  const yawDiff = shortestAngleDiff(this.currentRotation, this.targetRotation);
  const maxYaw = TURRET.rotationSpeed * dt;
  this.currentRotation = normalizeAngle(
    this.currentRotation + Math.max(-maxYaw, Math.min(maxYaw, yawDiff)),
  );
  const pitchDiff = this.targetPitch - this.currentPitch;
  const maxPitch = TURRET.pitchSpeed * dt;
  this.currentPitch = Math.max(-TURRET.maxPitchAngle, Math.min(TURRET.maxPitchAngle,
    this.currentPitch + Math.max(-maxPitch, Math.min(maxPitch, pitchDiff))));
  // ---- 开火节流：对准（yaw 与 pitch 各 < 阈值）+ 冷却到期 ----
  if (Math.abs(shortestAngleDiff(this.currentRotation, this.targetRotation))
      > TURRET.fireAngleThreshold) return false;
  if (Math.abs(this.currentPitch - this.targetPitch) > TURRET.fireAngleThreshold) return false;
  // **performance 基准 —— 禁止 Date.now()**（冷却判定混用会恒真 → 每帧开火）
  if (nowMs - this.lastFireAt < TURRET.fireCooldownMs) return false;
  this.writeBackFireClock(nowMs);   // 写回 lastFireAt（纯 entity 写）
  return true;   // Task 6 消费：true → 发射弹丸
}

/**
 * 炮口位置与方向（Task 6 发射用）。mc-lite `fire()` 语义照搬：炮口在 `MUZZLE_OFFSET_Z`，
 * 方向 = 炮口位置相对 pivot 的归一化向量（与视觉旋转一致）。
 * @param {number} nowMs @returns {{position:[number,number,number], direction:[number,number,number]}}
 */
muzzle(nowMs) {
  const pivot = this.pivot();
  // 炮口偏移：先按 pitch 绕 X 轴、再按 yaw 绕 Y 轴（mc-lite `applyAxisAngle` 顺序）
  const mz = TURRET.muzzleOffsetZ;
  const cp = Math.cos(this.currentPitch), sp = Math.sin(this.currentPitch);
  // 绕 X 轴旋转 (0,0,mz)：y' = -mz·sin(pitch)... 但 mc-lite 用 visualRotationX = -pitch
  const visPitch = -this.currentPitch;
  const afterPitch = [0, mz * Math.sin(visPitch), mz * Math.cos(visPitch)];
  const cy = Math.cos(this.currentRotation), sy = Math.sin(this.currentRotation);
  // 绕 Y 轴旋转 (x,y,z)：x' = x·cos + z·sin，z' = -x·sin + z·cos（x=0）
  const dir = [afterPitch[2] * sy, afterPitch[1], afterPitch[2] * cy];
  const len = Math.hypot(dir[0], dir[1], dir[2]) || 1;
  return {
    position: [pivot[0] + dir[0], pivot[1] + dir[1], pivot[2] + dir[2]],
    direction: [dir[0] / len, dir[1] / len, dir[2] / len],
  };
}

/** pivot 世界坐标（mc-lite `PIVOT_HEIGHT_OFFSET` 相对底座） */
pivot() {
  const origin = this.anchor?.origin;
  if (!origin) return [0, 0, 0];
  return [origin[0] + 0.5, origin[1] + TURRET.pivotHeightOffset, origin[2] + 0.5];
}
```

`shortestAngleDiff` / `normalizeAngle` —— mc-lite 从 `MathUtils.js` import；mc-heavy 若无，
在 `turret-system.js` 导出这两个纯函数（单一权威，供 controller 与测试共用）：

```js
/** 最短角差（归一化到 [-π, π]）。mc-lite `MathUtils.shortestAngleDiff` 同口径 */
export function shortestAngleDiff(from, to) {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}
/** 归一化角度到 [-π, π)。mc-lite `MathUtils.normalizeAngle` 同口径 */
export function normalizeAngle(a) {
  let x = a % (Math.PI * 2);
  if (x >= Math.PI) x -= Math.PI * 2;
  if (x < -Math.PI) x += Math.PI * 2;
  return x;
}
```

- [ ] **Step 5: Game 的 AI 编排（8Hz）**

`src/core/game.js` —— 在 `_updateTurretControllers` 里加 8Hz 索敌（accumulator 节流，
照 `ZombieService.update` 的 `_aiAccum` 同手法）：

```js
// 构造函数内：
this._turretAiAccum = 0;
this._turretAiInFlight = false;   // 本方案同步执行，不需要 in-flight 门（保留字段供未来改 RPC）

_updateTurretControllers(nowMs, dt) {
  if (!this.turrets) return;
  // 8Hz 索敌（accumulator 节流，对齐 mc-lite TARGET_REACQUIRE_INTERVAL）
  this._turretAiAccum += dt;
  if (this._turretAiAccum >= TURRET.aiPeriodMs / 1000) {
    this._turretAiAccum = 0;
    this._runTurretAi();
  }
  // 每帧朝向插值 + 开火节流（controller.update 自己判冷却）
  for (const controller of this.turrets.controllers().values()) controller.update(nowMs, dt);
}

/** 索敌：同步调纯函数，把意图写进各 controller */
_runTurretAi() {
  const controllers = this.turrets.controllers();
  if (controllers.size === 0) return;
  const turrets = [];
  for (const [id, controller] of controllers) {
    turrets.push({ id, pivot: controller.pivot(), rotation: controller.anchor?.rotation ?? 0 });
  }
  const zombies = this.zombies.activeEntities().map((e) => ({
    id: e.id, position: [...e.state.position],
  }));
  const { updates } = computeTurretUpdates({ turrets, zombies, world: this.world, registry: this.registry });
  for (const u of updates) {
    const c = controllers.get(u.id);
    if (!c) continue;   // 索敌到写回之间 controller 可能已被销毁（column 卸载）
    c.targetRotation = u.targetYaw;
    c.targetPitch = u.targetPitch;
  }
}
```

⚠️ **索敌到写回之间 controller 可能被销毁**（column 卸载）→ 写回前须判 `controllers.get(u.id)`
是否还在。这是同步执行也有的竞态（不像 RPC 有 generation 门），故用「写回前查表」兜住。

- [ ] **Step 6: 验证 GREEN + 负向验证**

Run: `npx playwright test tests/harness.spec.mjs`
Expected: PASS —— 索敌选中最近可见丧尸、无目标回归默认、LOS 遮挡判定、角度阈值与冷却节流。

⚠️ **负向验证**（全部须真 FAIL）：
① 注入「`hasLineOfSight` 恒返回 true」→ 遮挡测试 FAIL（stone 阻挡时仍可见）；
② 注入「索敌不做 LOS 判定」→ 墙后丧尸成为目标；
③ 注入「冷却判定用 `Date.now()`」→ 冷却恒真或恒假（开火节流 FAIL）；
④ 注入「`isProjectileOccluding` 改成只判 `solidTable`」→ glass（实心但透明）被判阻挡
（LOS 测试 FAIL）。

**自查无效盲区**：若索敌测试的丧尸都放在同一距离，注入「不做最近判定」仍全绿 —— 故须有
「一近一远」的配对断言。LOS 测试须**实心不透明 vs 透明**双向断言（只测 stone 会漏掉
glass 误判）。

- [ ] **Step 7: 提交（仅获授权后执行）**

```bash
git add src/entities/turrets/turret-system.js src/entities/turrets/turret-controller.js \
  src/core/game.js src/tests/test-turrets.js
git commit -m "feat(turrets): 炮塔 AI——主线程索敌纯函数 + 朝向插值 + 开火节流"
```

---

### Task 5: 炮塔渲染（装甲纹理烘焙 + 8 部件实例池 + UV 分区）

**Files:**

- Create: `tools/turret-armor-fingerprint.mjs`, `tools/bake-turret-armor.mjs`,
  `src/render/turret-armor-texture.js`, `src/render/turret-renderer.js`,
  `tests/turret-render.spec.mjs`
- Create: `assets/turret/turret_pic1.jpeg`, `assets/turret/turret_pic2.jpg`,
  `assets/turret/turret_pic3.jpg`（从 mc-lite `src/assets/turret/` 拷入）
- Create: `assets/turret/armor.png`, `assets/turret/armor.json`（烘焙产物）
- Modify: `src/core/game.js`（渲染层装配 + sync）
- Modify: `tools/check-data.mjs`（新增 `[炮塔装甲]` 环节）
- Modify: `package.json`（新增 `npm run turret`）

**Interfaces:**

- Consumes: Task 3 的 `TURRET`（pivotHeightOffset / muzzleOffsetZ）/ `turrets.controllers()`；
  Task 4 的 `controller.currentRotation` / `controller.currentPitch` / `controller.pivot()`
- Produces:

```js
loadTurretArmorTexture();   // Promise<THREE.Texture|null>（加载失败返回 null → 纯色退回）
TurretRenderer({ scene, maxActive?, armorTexture? })
// .sync(poses) / .slotCount() / .dispose()
//   poses: Map<id, {position:[x,y,z], yaw:number, pitch:number}>
//   ⚠️ slot 由本层**差集驱动**分配（不用 M6 的「service 分配 + 三条路径显式归还」）——
//   炮塔不是 EntityManager 实体（是方块锚定装置），没有 despawnColumn 绕过玩法服务的
//   回收路径，故差集驱动即可自动覆盖全部回收场景（与 ProjectileRenderer 同手法）

// turret-armor-fingerprint.mjs（烘焙脚本与门禁共用）
export const ARMOR_PNG, ARMOR_JSON;            // 产物路径
export const ARMOR_TEXTURE_CONFIG;             // 三区参数
export const ARMOR_WIDTH, ARMOR_HEIGHT;        // 纹理尺寸（横向三区并排）
export const armorInputFingerprint();          // 输入指纹
```

- [ ] **Step 1: 拷入源贴图并写烘焙指纹模块**

```bash
mkdir -p assets/turret
cp ../mc-lite/src/assets/turret/turret_pic1.jpeg assets/turret/
cp ../mc-lite/src/assets/turret/turret_pic2.jpg assets/turret/
cp ../mc-lite/src/assets/turret/turret_pic3.jpg assets/turret/
```

⚠️ 本仓 `assets/textures/turret.png` 是 mc-lite `ItemIconUtils` 的**背包手工图标**，
不是装甲贴图（两者用途不同勿混）。⚠️ **产物不放 `assets/textures/`** —— 那里被
`build-atlas.mjs` 的 `collectPngs` 递归扫描进世界 atlas，装甲纹理不属世界方块贴图，
进去会污染 atlas（照 `assets/zombie/head.png` 的同手法）。

`tools/turret-armor-fingerprint.mjs`（照 `zombie-head-fingerprint.mjs` 同结构）：

```js
// tools/turret-armor-fingerprint.mjs — 炮塔装甲纹理的参数与输入指纹
// **两个消费者共用同一份逻辑**（红线 1）：`bake-turret-armor.mjs` 烘焙时按本参数生成并写进
// `armor.json`；`check-data.mjs` 用当前参数重算比对 → 不匹配即报「跑 npm run turret」。
// 纹理是**派生产物**，权威输入是本文件的参数。改了参数却忘跑烘焙，纹理会**静默过期**
// （渲染旧图案，肉眼只觉得「颜色怪怪的」）—— 与图标过期同一条失效路径。
// 参数逐项实测自 mc-lite `Turret.js:114-119` 的 `ARMOR_TEXTURES`（4 槽 3 图 —— TOP 与 BACK 都指向 pic3，
// 故本计划的 `back: {zone:'top'}` 是对的）。
import { PNG } from 'pngjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const ARMOR_PNG = path.join(__dirname, '..', 'assets', 'turret', 'armor.png');
export const ARMOR_JSON = path.join(__dirname, '..', 'assets', 'turret', 'armor.json');
/** 三张源贴图（从 mc-lite 拷入） */
export const ARMOR_SOURCES = Object.freeze({
  front: path.join(__dirname, '..', 'assets', 'turret', 'turret_pic1.jpeg'),
  side: path.join(__dirname, '..', 'assets', 'turret', 'turret_pic2.jpg'),
  top: path.join(__dirname, '..', 'assets', 'turret', 'turret_pic3.jpg'),
});

/**
 * ⚠️ **必须横向三区并排，不能上下分区**（CLAUDE.md 活跃约束：上下分区会把图案压成
 * N×(N/3) → 比例失真）。区序固定 front / side / top —— 渲染层按同一区序改写 UV，
 * 改区序须同步改 `turret-renderer.js`。
 */
export const ARMOR_TEXTURE_CONFIG = Object.freeze({
  /** 单区尺寸（源图最大边归一化到此尺寸，nearest 降采样保像素风） */
  zoneSize: 64,
  /** 区序（UV 分区的唯一权威 —— 渲染层据此映射） */
  zones: Object.freeze(['front', 'side', 'top']),
});
export const ARMOR_WIDTH = ARMOR_TEXTURE_CONFIG.zoneSize * ARMOR_TEXTURE_CONFIG.zones.length; // 192
export const ARMOR_HEIGHT = ARMOR_TEXTURE_CONFIG.zoneSize;                                     // 64

/**
 * 输入指纹：三张源图的内容哈希 + 区参数。源图换了而忘重烘焙 → 门禁报错。
 * @returns {string}
 */
export function armorInputFingerprint() {
  const parts = [];
  for (const zone of ARMOR_TEXTURE_CONFIG.zones) {
    const buf = fs.readFileSync(ARMOR_SOURCES[zone]);
    // 简单内容哈希（长度 + 首尾 64 字节 + 中间取样）—— 够用于「源图是否变了」判定
    let h = buf.length;
    for (let i = 0; i < buf.length; i += 997) h = (h * 31 + buf[i]) >>> 0;
    parts.push(`${zone}:${h}`);
  }
  parts.push(`size:${ARMOR_WIDTH}x${ARMOR_HEIGHT}`);
  return parts.join('|');
}

/** 读产物 PNG（门禁比对尺寸与指纹用） */
export function readArmorPng() {
  if (!fs.existsSync(ARMOR_PNG)) return null;
  return PNG.sync.read(fs.readFileSync(ARMOR_PNG));
}
```

- [ ] **Step 2: 写烘焙脚本并生成产物**

`tools/bake-turret-armor.mjs` —— 把三张 JPEG 降采样到 64×64 并横向拼成 192×64 PNG：

```js
// tools/bake-turret-armor.mjs — 烘焙炮塔装甲纹理为单张多区 PNG（确定性）
// mc-lite 用「8 部件 mesh + 材质数组 + 三张贴图」（`Turret.js:47-80`）。本仓库的 WebGPU
// 后端**不支持** InstancedMesh + 材质数组 + geometry.groups（`three.webgpu.js:34592`
// `getMaterial()` 直接 return material，不遍历 groups、不取 materialIndex → 六面恒用
// `material[0]`，静默只渲染第一张）。故改走**单材质 + 单纹理 + UV 分区**（M6 丧尸头部同手法）。
// 产物：`assets/turret/armor.png`（192×64，三区横向并排）+ `armor.json`（尺寸 + 输入指纹）。
// 用法：node tools/bake-turret-armor.mjs（或 npm run turret）
import { PNG } from 'pngjs';
import fs from 'node:fs';
import path from 'node:path';
import {
  ARMOR_TEXTURE_CONFIG, ARMOR_WIDTH, ARMOR_HEIGHT, ARMOR_PNG, ARMOR_JSON,
  ARMOR_SOURCES, armorInputFingerprint,
} from './turret-armor-fingerprint.mjs';

/**
 * JPEG 解码：node 侧无原生 JPEG 解码器 → 用 Playwright 的 chromium 离屏 canvas 解码 +
 * nearest 降采样（与 `bake-icon-atlas.mjs` 的同手法，避免引入新依赖）。
 * @returns {Promise<{data: Uint8Array, width: number, height: number}>} RGBA
 */
async function decodeAndResize(srcPath, size) { /* 见下方实现要点 */ }

async function main() {
  const out = new PNG({ width: ARMOR_WIDTH, height: ARMOR_HEIGHT });
  ARMOR_TEXTURE_CONFIG.zones.forEach((zone, i) => {
    const img = await decodeAndResize(ARMOR_SOURCES[zone], ARMOR_TEXTURE_CONFIG.zoneSize);
    const x0 = i * ARMOR_TEXTURE_CONFIG.zoneSize;
    for (let y = 0; y < ARMOR_HEIGHT; y++) {
      for (let x = 0; x < ARMOR_TEXTURE_CONFIG.zoneSize; x++) {
        const src = (y * ARMOR_TEXTURE_CONFIG.zoneSize + x) * 4;
        const dst = (y * ARMOR_WIDTH + x0 + x) * 4;
        out.data[dst] = img.data[src];
        out.data[dst + 1] = img.data[src + 1];
        out.data[dst + 2] = img.data[src + 2];
        out.data[dst + 3] = img.data[src + 3];   // 源图无 alpha → 255
      }
    }
  });
  fs.mkdirSync(path.dirname(ARMOR_PNG), { recursive: true });
  fs.writeFileSync(ARMOR_PNG, PNG.sync.write(out));
  fs.writeFileSync(ARMOR_JSON, JSON.stringify({
    width: ARMOR_WIDTH, height: ARMOR_HEIGHT,
    zones: ARMOR_TEXTURE_CONFIG.zones, zoneSize: ARMOR_TEXTURE_CONFIG.zoneSize,
    fingerprint: armorInputFingerprint(),
  }, null, 2));
  console.log(`[turret-armor] 烘焙完成 ${ARMOR_WIDTH}×${ARMOR_HEIGHT}`);
}
main().catch((err) => { console.error(err); process.exit(1); });
```

`decodeAndResize` 的实现要点（照 `tools/bake-icon-atlas.mjs` 里既有的浏览器解码手法；
若该文件用的是 pngjs 而非 canvas，则本任务改用同款：JPEG 须经 canvas）：

```js
import { chromium } from 'playwright';
async function decodeAndResize(srcPath, size) {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const b64 = fs.readFileSync(srcPath).toString('base64');
  const ext = srcPath.endsWith('.jpeg') ? 'jpeg' : 'jpg';
  const rgba = await page.evaluate(async ({ b64, ext, size }) => {
    const img = new Image();
    img.src = `data:image/${ext};base64,${b64}`;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = size; canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;   // nearest 降采样（保像素风，与 mc-lite NearestFilter 一致）
    ctx.drawImage(img, 0, 0, size, size);
    return Array.from(ctx.getImageData(0, 0, size, size).data);
  }, { b64, ext, size });
  await browser.close();
  return { data: new Uint8Array(rgba), width: size, height: size };
}
```

`package.json` 的 scripts 加 `"turret": "node tools/bake-turret-armor.mjs"`。

Run: `npm run turret`
Expected: 生成 `assets/turret/armor.png`（192×64）+ `armor.json`。

- [ ] **Step 3: 写失败的渲染层单测**

在 `src/tests/test-turrets.js` 追加（渲染层可在浏览器内构造 —— 照 `test-zombies.js` 的
受控渲染器单测同手法，import map 已提供 three）：

```js
test('TurretRenderer：8 个部件 InstancedMesh，无炮塔时全部 visible=false', () => {
  const renderer = new TurretRenderer({ scene: makeFakeScene(), maxActive: 20 });
  assertEqual(Object.keys(renderer.meshes).length, 8);       // 8 部件
  for (const part of TURRET_PARTS) assertEqual(renderer.meshes[part].visible, false);
  assertEqual(renderer.meshes.front.geometry.type, 'BoxGeometry');
  assertEqual(renderer.meshes.barrel.geometry.type, 'CylinderGeometry');
});

test('TurretRenderer：UV 分区把五块装甲板映射到对应区', () => {
  const renderer = new TurretRenderer({ scene: makeFakeScene(), armorTexture: makeFakeTexture() });
  const zones = ['front', 'side', 'top'];
  for (const part of ['front', 'left', 'right', 'top', 'back']) {
    const uv = renderer.meshes[part].geometry.getAttribute('uv');
    const expectedZone = zones.indexOf(TURRET_PART_DEFS[part].zone);
    // 所有顶点的 u 都落在该区内（`[zoneIndex/3, (zoneIndex+1)/3]`）
    const lo = expectedZone / 3, hi = (expectedZone + 1) / 3;
    for (let i = 0; i < uv.count; i++) {
      const u = uv.getX(i);
      assertTrue(u >= lo - 1e-9 && u <= hi + 1e-9, `${part} 顶点 ${i} 的 u=${u} 不在区 ${expectedZone}`);
    }
  }
  // 纯色部件（炮管/根部/瞄准器）**不**改写 UV
  assertEqual(TURRET_PART_DEFS.barrel.zone, null);
});

test('TurretRenderer：sync 差集驱动 —— 新增分配 slot、消失归还', () => {
  const renderer = new TurretRenderer({ scene: makeFakeScene() });
  const poses = new Map([['turret-1', { position: [10.5, 7.3, 10.5], yaw: 0, pitch: 0 }]]);
  renderer.sync(poses);
  assertEqual(renderer.slotCount(), 1);
  for (const part of TURRET_PARTS) assertEqual(renderer.meshes[part].visible, true);
  renderer.sync(new Map());          // 炮塔消失（column 卸载 / 失效）
  assertEqual(renderer.slotCount(), 0);
  for (const part of TURRET_PARTS) assertEqual(renderer.meshes[part].visible, false);
});
```

- [ ] **Step 4: 验证 RED**

Run: `npx playwright test tests/harness.spec.mjs`
Expected: FAIL —— `TurretRenderer` / `TURRET_PARTS` / `TURRET_PART_DEFS` 未定义（模块不存在）。

- [ ] **Step 5: 写渲染层（8 部件实例池 + UV 分区）**

`src/render/turret-armor-texture.js`（照 `zombie-head-texture.js` 同手法）：

```js
// src/render/turret-armor-texture.js — 加载烘焙的炮塔装甲纹理（多区并排）
// 加载失败返回 null → 渲染层退回纯色（单测 fixture 不需纹理也能跑）。
import * as THREE from 'three';

export async function loadTurretArmorTexture() {
  try {
    const texture = await new THREE.TextureLoader().loadAsync('/assets/turret/armor.png');
    texture.magFilter = THREE.NearestFilter;   // mc-lite `NearestFilter` 同口径
    texture.minFilter = THREE.NearestFilter;
    texture.generateMipmaps = false;
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  } catch (err) {
    console.warn('[turret-armor] texture load failed:', err);
    return null;
  }
}
```

`src/render/turret-renderer.js`：

```js
// src/render/turret-renderer.js — M8：炮塔渲染（8 部件固定容量实例池，规格 §5.1）
//
// **为什么是每部件一个 InstancedMesh 而不是每炮塔 8 个 mesh**：mc-lite 每炮塔创建 8 个
// `THREE.Mesh`（`getTurretResources()` 内）挂在两级 Object3D 上；20 炮塔 = 160 个 scene 节点 +
// 160 个 draw call。本仓库用 8 个固定容量 20 的 InstancedMesh（M6 六部件同手法），
// 每实例矩阵 = `T(pivot) × R_y(yaw) × R_x(-pitch) × 部件局部变换`，等价 mc-lite 的层级但
// 不产生 per-turret 节点。
//
// **为什么单材质 + UV 分区**：WebGPU 后端不支持材质数组 + geometry.groups（CLAUDE.md
// 活跃约束；M6 实测）→ 照 mc-lite 的「每部件一张贴图」写法会静默只渲染第一张。
// 三张装甲贴图烘焙成 192×64 三区横向并排（`tools/bake-turret-armor.mjs`），几何按部件
// 归属改写 UV 到对应区。
//
// ⚠️ **跨面 UV 换算不能用同一套公式**（CLAUDE.md 活跃约束：`BoxGeometry` 各面的
// `buildPlane` `vdir` 符号不同 —— 正面/侧面 `-1`、顶面 `+1`）。故用**归一化 u** 作统一
// 参数：`u' = zoneIndex/3 + u/3`，不碰 v（每个部件几何独立 → 不存在跨面取样问题）。
//
// ⚠️ 无活跃炮塔时 8 个 mesh 全部 `visible=false`（否则恒增 8 个 draw call）。
import * as THREE from 'three';
// ⚠️ 区序（`ARMOR_ZONES`）与部件定义 —— **从 `turret-config.js` 导入，不在本文件写字面量**
// （红线 1）。⚠️ 原先这里写 `const ZONES = ['front','side','top']` 是**第二份副本**
// （注释写「同源」但没有任何机制保证）：改了烘焙侧的区序而忘改这里，UV 会整体错位
// （渲染出错图案，肉眼只觉得「贴图怪怪的」）。提到无 three 的 `turret-config.js` 后，
// 渲染层 / 烘焙脚本 / `check:data` 三方都从同一处派生，且门禁可断言
// `TURRET_PART_DEFS[].zone ⊆ ARMOR_ZONES`（见 Step 6）。
// ⚠️ 本文件内**不得**出现裸标识符 `ZONES` —— 一律用导入的 `ARMOR_ZONES`
// （上一版审查发现三处误用裸 `ZONES.length`/`ZONES.indexOf` → ReferenceError，已全部改用 ARMOR_ZONES）。
import {
  TURRET, TURRET_PARTS, TURRET_PART_DEFS, ARMOR_ZONES, TURRET_TOWER_COLOR,
} from '../entities/turrets/turret-config.js';

// ⚠️ **部件定义不在本文件**（见上方 import）—— 它们是纯数据（尺寸/位置/区归属/颜色，
// 无 three 依赖），放在 `turret-config.js` 让渲染层 / 烘焙脚本 / `check:data` 三方共用
// 同一份权威（红线 1）。本文件只做「几何构造 + UV 改写 + 矩阵合成」。

const _matrix = new THREE.Matrix4();
const _quat = new THREE.Quaternion();
const _euler = new THREE.Euler();
const _pos = new THREE.Vector3();
const _scale = new THREE.Vector3(1, 1, 1);
const _local = new THREE.Matrix4();
const _zero = new THREE.Matrix4().makeScale(0, 0, 0);

/**
 * 按部件归属把 UV 改写进对应区（横向三区）。
 * ⚠️ 只改 u、不碰 v —— 每个部件是独立几何，不存在跨面取样（规避 `buildPlane` vdir 陷阱）。
 * @param {THREE.BufferGeometry} geometry @param {number} zoneIndex 0..2
 */
function applyZoneUV(geometry, zoneIndex) {
  const uv = geometry.getAttribute('uv');
  const offset = zoneIndex / ARMOR_ZONES.length;
  const span = 1 / ARMOR_ZONES.length;
  for (let i = 0; i < uv.count; i++) uv.setX(i, offset + uv.getX(i) * span);
  uv.needsUpdate = true;
}

export class TurretRenderer {
  /**
   * @param {{scene: THREE.Scene, maxActive?: number, armorTexture?: THREE.Texture|null}} deps
   *        `armorTexture` 可选：有则五块装甲板走贴图 + UV 分区；无则退回纯色
   *        `TURRET_TOWER_COLOR.MAIN/DARK`（单测 fixture 不需纹理也能跑）。
   */
  constructor({ scene, maxActive = TURRET.maxTurrets, armorTexture = null }) {
    this.scene = scene;
    this.maxActive = maxActive;
    this._armorTexture = armorTexture;
    this.meshes = {};
    this._geometries = {};
    for (const part of TURRET_PARTS) {
      const def = TURRET_PART_DEFS[part];
      const geometry = def.geo === 'cylinder'
        ? (() => { const g = new THREE.CylinderGeometry(def.diameter / 2, def.diameter / 2, def.length, 12);
                   g.rotateX(Math.PI / 2);   // mc-lite `g.rotateX(Math.PI / 2)` 同口径
                   return g; })()
        : new THREE.BoxGeometry(def.size[0], def.size[1], def.size[2]);
      const useMap = !!def.zone && !!armorTexture;
      if (useMap) applyZoneUV(geometry, ARMOR_ZONES.indexOf(def.zone));
      const material = new THREE.MeshBasicMaterial(useMap
        ? { color: 0xffffff, map: armorTexture }
        : { color: def.color ?? TURRET_TOWER_COLOR[part === 'back' ? 'DARK' : 'MAIN'] });
      const mesh = new THREE.InstancedMesh(geometry, material, maxActive);
      mesh.name = `turret:${part}`;      // 受控标识：测试与调试据此定位节点
      mesh.frustumCulled = false;
      mesh.visible = false;              // ⚠️ 无活跃炮塔时不提交渲染
      for (let i = 0; i < maxActive; i++) mesh.setMatrixAt(i, _zero);
      mesh.instanceMatrix.needsUpdate = true;
      this.scene.add(mesh);
      this.meshes[part] = mesh;
      this._geometries[part] = geometry;
      mesh.userData.material = material;  // dispose 需要（InstancedMesh.dispose 不释放材质）
    }
    /** @type {Map<string, number>} turretId → slot（**本层差集驱动分配**，见文件头） */
    this._slots = new Map();
    this._nextSlot = 0;
  }

  /** 只读 slot 数（测试钩子：验证卸载/失效后 slot 都归还了） */
  slotCount() { return this._slots.size; }

  /**
   * 发布 pose（只读 → 8 部件矩阵）。矩阵 = `T(pivot) × R_y(yaw) × R_x(-pitch) × 部件局部变换`。
   * ⚠️ **pitch 取反**（mc-lite `pitchObject.rotation.x = -this.currentPitch`，
   * `Turret.js:656`：three 旋转方向与 atan2 结果相反）。
   * **差集驱动 slot**（M5 `EntityRenderLayer.sync` 同手法）：新 id 分配 slot、已有 id 更新矩阵、
   * 消失 id 归还 slot。炮塔不是 EntityManager 实体（是方块锚定装置），没有 `despawnColumn`
   * 绕过玩法服务的回收路径，故差集驱动自动覆盖全部回收场景（column 卸载 / 失效 / 放置）。
   * @param {Map<string, {position:number[], yaw:number, pitch:number}>} poses
   */
  sync(poses) {
    const live = new Set();
    for (const [id, pose] of poses) {
      live.add(id);
      let slot = this._slots.get(id);
      if (slot === undefined) {
        slot = this._nextSlot;
        this._nextSlot = (this._nextSlot + 1) % this.maxActive;   // 池满覆盖最旧（纯视觉）
        this._slots.set(id, slot);
      }
      // pivot 旋转：先 pitch（绕 X，取反）再 yaw（绕 Y）—— 与 mc-lite 的两级 Object3D 等价
      _euler.set(-pose.pitch, pose.yaw, 0, 'YXZ');
      _quat.setFromEuler(_euler);
      _pos.set(pose.position[0], pose.position[1], pose.position[2]);
      for (const part of TURRET_PARTS) {
        const def = TURRET_PART_DEFS[part];
        // 部件局部变换：位置偏移 + 可选 rotX（前装甲板的倾斜）
        _local.makeTranslation(def.pos[0], def.pos[1], def.pos[2]);
        if (def.rotX !== undefined) {
          _euler.set(def.rotX, 0, 0);
          _quat.setFromEuler(_euler);
          _local.multiply(new THREE.Matrix4().makeRotationFromQuaternion(_quat));
        }
        _matrix.copy(_local).premultiply(
          new THREE.Matrix4().compose(_pos, this._pivotQuat(pose), _scale),
        );
       this.meshes[part].setMatrixAt(slot, _matrix);
      }
    }
    // 归还消失 id 的 slot（清空 8 部件矩阵，不留残影）
    for (const [id, slot] of [...this._slots]) {
      if (live.has(id)) continue;
      for (const part of TURRET_PARTS) this.meshes[part].setMatrixAt(slot, _zero);
      this._slots.delete(id);
    }
    for (const part of TURRET_PARTS) this.meshes[part].instanceMatrix.needsUpdate = true;
    const anyActive = this._slots.size > 0;
    for (const part of TURRET_PARTS) this.meshes[part].visible = anyActive;   // ⚠️ 无炮塔时不提交渲染
  }

  /** pivot 四元数（yaw + 取反的 pitch）。'YXZ' 序：先 yaw 后 pitch（与 Object3D 层级等价） */
  _pivotQuat(pose) {
    _euler.set(-pose.pitch, pose.yaw, 0, 'YXZ');
    _quat.setFromEuler(_euler);
    return _quat;
  }

  dispose() {
    for (const part of TURRET_PARTS) {
      const mesh = this.meshes[part];
      this.scene.remove(mesh);
      this._geometries[part].dispose();
      mesh.userData.material.dispose();
      mesh.dispose();
    }
    if (this._armorTexture) this._armorTexture.dispose();
    this._slots.clear();
  }
}
```

⚠️ **上面 `sync()` 里有两处性能隐患须在实现时消除**（保留注释说明理由）：
① `new THREE.Matrix4()` 在双重循环内分配（20 炮塔 × 8 部件 × 60fps = 每秒 9600 个小对象）
→ 改成模块级复用的 `_pivotMatrix` / `_rotMatrix` 两个临时对象（照 `tracer-renderer.js`
的「复用的临时对象（避免每帧分配）」口径）；② `_pivotQuat` 每部件调一次 → 每 pose 只算一次。
**TDD 顺序**：先写能通过的版本（含分配），bench 实测确认无回退后再优化 —— 若 bench 报回退
>10% 则停下来报告（冻结断言纪律），不要静默放宽。

Game 装配（紧跟 `zombieRenderer` 之后）：

```js
this._turretArmorTexture = await loadTurretArmorTexture();
this.turretRenderer = new TurretRenderer({ scene: this.scene, armorTexture: this._turretArmorTexture });
// slot 由 renderer 内部**差集驱动**分配（sync(poses) 里新 id 分配、消失 id 归还）——
// 不在 TurretService 侧建 slot 池。理由：炮塔不是 EntityManager 实体（是方块锚定装置），
// 没有 `despawnColumn` 绕过玩法服务的回收路径，差集驱动即可覆盖全部回收场景
// （column 卸载 / 失效 / 放置）。M6 的 service 侧 slot 池是为高频 spawn/despawn 的丧尸设计的，
// 炮塔低频放置，不需要那套记账。
```

帧循环接线（放在 `zombieRenderer.sync` 之后）：

```js
// 炮塔 pose 发布：pivot 世界坐标 + 当前 yaw/pitch（Task 4 的插值结果）
const turretPoses = new Map();
for (const [id, controller] of this.turrets.controllers()) {
  turretPoses.set(id, {
    position: controller.pivot(),
    yaw: controller.currentRotation,
    pitch: controller.currentPitch,
  });
}
this.turretRenderer.sync(turretPoses);
```

⚠️ **每帧新建 Map 是分配** —— 若 bench 报回退，改成复用的模块级 Map（`clear()` + 重填）。

- [ ] **Step 6: 在 `tools/check-data.mjs` 新增 `[炮塔装甲]` 门禁**

照 `checkZombieHeadTexture()` 同手法：

```js
/**
 * [炮塔装甲] 三环节契约：产物存在 + 尺寸正确 + 指纹匹配当前源图。
 * 漏了会让产物**静默过期**（渲染旧图案，肉眼只觉得「颜色怪怪的」）。
 */
function checkTurretArmorTexture() {
  const png = readArmorPng();
  if (!png) { failures.push('[炮塔装甲] assets/turret/armor.png 不存在 —— 跑 npm run turret'); return; }
  if (png.width !== ARMOR_WIDTH || png.height !== ARMOR_HEIGHT) {
    failures.push(`[炮塔装甲] PNG ${png.width}×${png.height} 与期望 ${ARMOR_WIDTH}×${ARMOR_HEIGHT} 不符`);
  }
  if (!fs.existsSync(ARMOR_JSON)) { failures.push('[炮塔装甲] armor.json 不存在 —— 跑 npm run turret'); return; }
  const meta = JSON.parse(fs.readFileSync(ARMOR_JSON, 'utf8'));
  const current = armorInputFingerprint();
  if (meta.fingerprint !== current) {
    failures.push('[炮塔装甲] 指纹不匹配 —— 源贴图或区参数变了但产物未重烘焙（跑 npm run turret）');
  }
  infos.push(`[炮塔装甲] ${png.width}×${png.height} 三区并排（${ARMOR_TEXTURE_CONFIG.zones.join('/')}）`);
}
```

⚠️ **已知盲区**（照丧尸头部同口径）：改**算法**而不动参数时指纹不变 → 这类改动须靠 Tier 4
像素实测兜住。

- [ ] **Step 7: Tier 4 像素实测**

`tests/turret-render.spec.mjs` —— 照 `tests/zombie-head.spec.mjs` 的同手法（离屏渲染 +
读像素）：

```js
test('炮塔渲染：正面/侧面/顶面各区取到对应装甲贴图，炮管为纯色', async ({ page }) => {
  // 构造一个炮塔（pivot 在原点、yaw=0）→ 离屏渲染 → 读四个面的中心像素
  // 判据用**区差异**而非绝对色值：三区的平均色须互不相同（源图是三种不同装甲图）
  // ⚠️ 取样点须对准被测部件的中心（testing-policy §2.7 第 9 类：取样点没对准 → 注入仍全绿）
  // ⚠️ 断言阈值须匹配 outputColorSpace（testing-policy §5.2）
});

test('炮塔渲染：无炮塔时 8 个 mesh 全部 visible=false', async ({ page }) => {
  const visible = await page.evaluate(() =>
    window.__MC_GAME__.scene.children.filter((c) => c.name?.startsWith('turret:') && c.visible).length);
  expect(visible).toBe(0);
});

test('炮塔渲染：yaw 反解用 atan2 而非 Euler（折叠区取值）', async ({ page }) => {
  // ⚠️ CLAUDE.md 活跃约束：测试取值须至少一个落在折叠区（|yaw| > π/2，如 2.48）
  // 只在 [-π/2, π/2] 内取值会侥幸通过 —— 换方向就假失败
});
```

⚠️ **负向验证**（全部须真 FAIL）：① 注入「`applyZoneUV` 的 zoneIndex 恒 0」→ 三区取样色
相同；② 注入「`armor.json` 的 fingerprint 写死旧值」→ 门禁报指纹不匹配；
③ 注入「删掉 `mesh.visible = false`」→ draw call 增量测试 FAIL；
④ 注入「pitch 不取反」→ 俯仰方向反（瞄准下方丧尸时炮管朝天）。

- [ ] **Step 8: 验证 GREEN + 门禁 + bench**

Run: `npm run check && npx playwright test tests/turret-render.spec.mjs tests/harness.spec.mjs`
Expected: 全绿。

Run: `npm run bench -- --check`
Expected: 通过。**draw call 对照表**须记录：8 个部件 mesh 的增量（无炮塔时回到基线）。

- [ ] **Step 9: 提交（仅获授权后执行）**

```bash
git add tools/turret-armor-fingerprint.mjs tools/bake-turret-armor.mjs \
  src/render/turret-armor-texture.js src/render/turret-renderer.js \
  src/core/game.js tools/check-data.mjs package.json tests/turret-render.spec.mjs \
  assets/turret/
git commit -m "feat(turrets): 炮塔渲染——单纹理 UV 分区 + 8 部件实例池"
```

---

### Task 6: 弹丸实体（DDA 阻挡 + 实体命中 + 伤害 + 实例池渲染）

**Files:**

- Create: `src/entities/turrets/projectile-system.js`, `src/render/projectile-renderer.js`,
  `src/tests/test-projectiles.js`, `tests/projectiles.spec.mjs`
- Create: `assets/sounds/turret_gun_fire.mp3`（从 mc-lite `src/assets/sound/` 拷入）
- Modify: `src/entities/turrets/turret-controller.js`（发射接线，消费 `update()` 的 true）
- Modify: `src/render/audio-manager.js`（`SOUND_IDS` 加 `turret_gun_fire`）
- Modify: `src/core/game.js`（`projectile` 类型注册 + 渲染层装配 + 帧序接线）
- Modify: `src/tests/index.html`（注册新单测文件）

**Interfaces:**

- Consumes: Task 3 的 `TURRET`（projectileSpeed / projectileMaxDistance / projectileDamage）/
  `controller.muzzle(nowMs)`；Task 4 的 `isProjectileOccluding(id, registry)`（遮挡判据共用）；
  既有 `raycastVoxel(world, origin, dir, maxDist)` / `entities.registerType(type, definition)` /
  `entities.spawn({id,type,state,persistent})` / `entities.despawn(id, reason)` /
  `entities.raycast(origin, dir, maxDist, predicate)` / `zombies.damage(id, amount, nowMs)`
- Produces:

```js
// projectile-system.js
export const projectileDefinition;   // {create, update, raycastAabb, serialize, deserialize}
export const PROJECTILE_AABB;        // {min:[-0.15,-0.15,-0.15], max:[0.15,0.15,0.15]}
advanceProjectile({ state, dt, world, registry, entities, nowMs });
// → { state, alive: boolean, reason?: 'block'|'entity'|'max-distance', hitId?: string }
judgeProjectile({ next, world, registry, entities, stepLen, nowMs, onDamage? });
// → { reason: 'block'|'entity'|'max-distance'|null, hitId?: string }
//   **只判定不推进**（纯谓词）—— Game 帧循环用这个；`next` = 本步推进后的 state。
//   推进由 `projectileDefinition.update` 经 `entities.update()` 驱动，避免两处推进。
//   `advanceProjectile` 是它的薄封装（推进 + 判定），仅单测用。

// projectile-renderer.js
ProjectileRenderer({ scene, maxActive? })
// .sync(projectileEntities) / .dispose()   —— 差集驱动 slot（见下方理由）

// game.js
game.projectilesDebugState();   // { count, slots }；只读测试钩子
```

- [ ] **Step 1: 写失败的推进与命中测试**

新建 `src/tests/test-projectiles.js`，并在 `src/tests/index.html` 追加
`import './test-projectiles.js';`：

```js
test('弹丸直线推进：40 格/秒 × dt，traveled 累积', () => {
  const state = projectileDefinition.create({
    position: [10, 5, 10], direction: [0, 0, 1], traveled: 0, source: 'turret-1',
  });
  const next = projectileDefinition.update({ state }, 1 / 60, { world: makeWorld().world });
  // 40 × 1/60 ≈ 0.667 格
  assertTrue(Math.abs(next.position[2] - (10 + 40 / 60)) < 1e-6);
  assertTrue(next.traveled > 0);
  // ⚠️ **必须是全新对象 + 全新数组**（CLAUDE.md 活跃约束）
  assertTrue(next !== state);
  assertTrue(next.position !== state.position);
});

test('弹丸撞实心不透明方块即停，透明方块可穿透', () => {
  const { world, registry, entities } = makeProjectileFixture();
  world.setBlock(10, 5, 14, registry.idOf('stone'));
  const r = advanceProjectile({
    state: projectileDefinition.create({ position: [10.5, 5.5, 10.5], direction: [0, 0, 1],
      traveled: 0, source: 'turret-1' }),
    dt: 0.1, world, registry, entities, nowMs: 0,
  });
  assertEqual(r.alive, false);
  assertEqual(r.reason, 'block');
  // 换成 glass_block（实心但透明）→ 穿透。⚠️ 方块名是 `glass_block`，本仓 registry **无 `glass`**
  world.setBlock(10, 5, 14, registry.idOf('glass_block'));
  const r2 = advanceProjectile({
    state: projectileDefinition.create({ position: [10.5, 5.5, 10.5], direction: [0, 0, 1],
      traveled: 0, source: 'turret-1' }),
    dt: 0.1, world, registry, entities, nowMs: 0,
  });
  assertTrue(r2.alive);
});

test('弹丸命中丧尸：经 EntityManager.raycast，伤害 34（三发死）', () => {
  const { world, registry, entities, zombies } = makeProjectileFixture();
  const zid = zombies.spawn([10.5, 4, 16.5], { source: 'projectile-spec' });
  // ⚠️ **必须传 `onDamage`** —— `judgeProjectile` 里是 `if (onDamage) onDamage(...)`，
  // 不传则伤害不发生，下面的 `health === 32` 与「第三发 despawn」断言都会失败。
  // 用 fixture 里 zombies.damage 的同手法接线（与 game.js 的真实接线口径一致）。
  const onDamage = (id, amount, ms) => zombies.damage(id, amount, ms);
  // **临界值附近断言**（CLAUDE.md 活跃约束：远离阈值的输入测不出换算错误）
  let r;
  for (let i = 0; i < 2; i++) {
    r = advanceProjectile({ state: makeProjectileState([10.5, 5.2, 15.5]), dt: 0.1,
      world, registry, entities, nowMs: i * 100, onDamage });
    assertEqual(r.reason, 'entity');
    assertEqual(r.hitId, zid);
  }
  assertEqual(zombies.get(zid).state.health, 32);      // 100 − 34×2 = 32 → **两发不死**
  r = advanceProjectile({ state: makeProjectileState([10.5, 5.2, 15.5]), dt: 0.1,
    world, registry, entities, nowMs: 200, onDamage });
  assertEqual(zombies.get(zid), null);                  // 第三发 32−34 ≤ 0 → despawn
});

test('弹丸飞满 50 格即消失', () => {
  const { world, registry, entities } = makeProjectileFixture();
  const state = projectileDefinition.create({ position: [10, 5, 10], direction: [1, 0, 0],
    traveled: TURRET.projectileMaxDistance - 0.1, source: 'turret-1' });
  const r = advanceProjectile({ state, dt: 0.1, world, registry, entities, nowMs: 0 });
  assertEqual(r.alive, false);
  assertEqual(r.reason, 'max-distance');
});
```

⚠️ **`makeProjectileFixture()` 的 fake pool 不需要**（弹丸不走 RPC），但 fixture 里的
`entities` 必须是**真实 `EntityManager`**（不是桩件）—— 命中判定走它的 `raycast()`，
桩件会让「命中真相只由 EntityManager 给出」这条红线测不出来（testing-policy §2.7：
断言落点须落在真实接线上）。

- [ ] **Step 2: 验证 RED**

Run: `npx playwright test tests/harness.spec.mjs`
Expected: FAIL —— `projectileDefinition` / `advanceProjectile` 未定义。

- [ ] **Step 3: 实现 `src/entities/turrets/projectile-system.js`**

```js
// src/entities/turrets/projectile-system.js — M8：弹丸实体（M5 临时实体，规格 §5.2）
// 同构层：**无 DOM、无 three**（`npm run check:arch` 静态门守）。
//
// 弹丸是**临时实体**（roadmap 指定接入点：M5 `EntityManager` + 实体 raycast），不是渲染节点：
// 命中真相由实体的逻辑 AABB 给出，渲染层只发布 pose。
//
// **两处判定按红线 6 重写**（有意偏离 mc-lite）：
// ① 方块阻挡：mc-lite 用起点/终点双点 `getBlock` 采样（`Projectile.js:130-152`）→ 一帧
//    0.667 格的步长下斜射可能整步不落在同一格，漏穿薄墙。本仓库走体素 DDA（`raycastVoxel`）；
// ② 实体命中：mc-lite 用「点到线段距离 + 半径容差」（`Projectile.js:157-193`）→ 本仓库走
//    `EntityManager.raycast()`（实体命中唯一入口）。
import { TURRET } from './turret-config.js';
import { isProjectileOccluding } from './turret-system.js';   // 遮挡判据共用（红线 1）
import { raycastAabbSlab } from '../entity-types.js';

/** 弹丸 AABB：0.3 见方的小盒（mc-lite `_projectileRadius = 0.3` 的等价表达） */
export const PROJECTILE_AABB = Object.freeze({
  min: Object.freeze([-0.15, -0.15, -0.15]),
  max: Object.freeze([0.15, 0.15, 0.15]),
});

/** 新建一份合法 state（形状校验：position/direction 必须是 3 个有限数） */
function createState({ position, direction, traveled, source }) {
  if (!Array.isArray(position) || position.length !== 3) return null;
  if (!Array.isArray(direction) || direction.length !== 3) return null;
  for (const v of [...position, ...direction]) if (!Number.isFinite(v)) return null;
  const len = Math.hypot(direction[0], direction[1], direction[2]);
  if (!(len > 0)) return null;   // 零方向 → 无法推进
  return {
    position: [position[0], position[1], position[2]],
    direction: [direction[0] / len, direction[1] / len, direction[2] / len],
    traveled: Number.isFinite(traveled) ? traveled : 0,
    source: typeof source === 'string' ? source : null,
  };
}

/**
 * 单步推进（直线，无重力、无碰撞响应 —— mc-lite 同口径：弹丸只判定命中后即消失，
 * 不弹跳、不下坠）。
 *
 * ⚠️ **必须返回全新 state + 全新数组**（CLAUDE.md 活跃约束）：`EntityManager.update()` 的
 * 跨 column 索引迁移判据是「赋值前 position vs 赋值后 position」。原地改写会让 before/after
 * 从同一份已改位置算出 → 恒相等 → **索引永不迁移** → column 卸载漏回收弹丸。
 * 浅拷贝 `{...state}` 也不够（position 数组引用相同仍会被污染）。
 * 弹丸 40 格/秒 × 最大 50 格 → 寿命约 1.25 秒，跨 column 是常态，故这条尤其关键。
 *
 * @param {import('../entity-manager.js').Entity} entity
 * @param {number} dt @param {{world}} context
 */
function update(entity, dt, context) {
  const prev = entity.state;
  const step = TURRET.projectileSpeed * dt;
  const [dx, dy, dz] = prev.direction;
  return createState({
    position: [prev.position[0] + dx * step, prev.position[1] + dy * step, prev.position[2] + dz * step],
    direction: prev.direction,
    traveled: prev.traveled + step,
    source: prev.source,
  });
}

export const projectileDefinition = Object.freeze({
  create: createState,
  update,
  raycastAabb: (state, origin, dir, maxDist) =>
    raycastAabbSlab(state, origin, dir, maxDist, PROJECTILE_AABB),
  /** 弹丸不存档（临时实体）—— serialize 返回 null 即不进 entities snapshot */
  serialize() { return null; },
  deserialize() { return null; },
});

/**
 * **只判定不推进**的纯谓词 —— 弹丸判定的**唯一实现**（阻挡 + 命中 + 超距）。
 * Game 帧循环用这个（推进由 `projectileDefinition.update` 经 `entities.update()` 驱动 ——
 * 两处推进会让弹丸速度翻倍，见 Step 4 的 ⚠️）；单测用的 `advanceProjectile` 是它的薄封装。
 *
 * 判定顺序（mc-lite `Projectile.update` 同序）：① 超距 → ② 方块阻挡（DDA）→ ③ 实体命中。
 * ⚠️ 顺序不能换：若先判实体命中，弹丸可能在「已飞超最大距离」的位置上命中丧尸。
 *
 * ⚠️ **判定线段必须是本步实际穿越的那段**：`from = 步后 position − direction×stepLen`
 * （`direction` 已归一化，直接可算）。若只从步后位置起算，刚走过的线段永不判定 →
 * dt 尖峰时穿墙（40 格/秒 × 0.05s = 2 格 > 1 格墙厚）。「DDA 取代 mc-lite 的双点采样」
 * 正是本任务的核心论证，判定区间错了会让该论证失效。
 *
 * ⚠️ `raycastVoxel` 未命中返回 **`{hit:false}`（truthy 对象）**，不是 null →
 * 必须判 `blockHit.hit`；写成 `if (blockHit)` 会让弹丸每次判定都立刻判「撞方块」而死。
 *
 * @param {{next: object, world, registry, entities, stepLen: number, nowMs: number,
 *          onDamage?: (id:string, amount:number, nowMs:number)=>void}} p
 *        `next` = 本步推进后的 state（由 `projectileDefinition.update` 或调用方给出）
 * @returns {{reason: 'block'|'entity'|'max-distance'|null, hitId?: string}}
 */
export function judgeProjectile({ next, world, registry, entities, stepLen, nowMs, onDamage = null }) {
  // ① 超距
  if (next.traveled >= TURRET.projectileMaxDistance) return { reason: 'max-distance' };
  // ② 方块阻挡：DDA 遍历 from → to（本步实际穿越的线段）。红线 6：地形交互一律体素 DDA，
  //    遮挡判据用 `isProjectileOccluding`（与炮塔 LOS 共用 —— 红线 1，不写第二份 DDA）
  const [dx, dy, dz] = next.direction;
  const from = [
    next.position[0] - dx * stepLen,
    next.position[1] - dy * stepLen,
    next.position[2] - dz * stepLen,
  ];
  const blockHit = raycastVoxel(world, from, next.direction, stepLen,
    (id) => isProjectileOccluding(id, registry));
  if (blockHit.hit) return { reason: 'block' };   // ⚠️ 判 `.hit`，不是判对象本身
  // ③ 实体命中：EntityManager.raycast（实体命中唯一入口，红线 6）
  if (entities) {
    const hit = entities.raycast(from, next.direction, stepLen,
      (entity) => entity.type === 'zombie');   // 只打丧尸（不打其它弹丸/未来实体）
    if (hit) {
      // 伤害经 ZombieService.damage（M6 已实现红闪 + health ≤ 0 即 despawn，不另写伤害路径）
      if (onDamage) onDamage(hit.id, TURRET.projectileDamage, nowMs);
      return { reason: 'entity', hitId: hit.id };
    }
  }
  return { reason: null };
}

/**
 * `judgeProjectile` 的薄封装（推进 + 判定）—— **单测与「需要同时拿到新 state」的场景用**。
 * ⚠️ Game 帧循环**不用**它（推进已由 `entities.update()` 驱动，见 Step 4）。
 * @returns {{state: object, alive: boolean, reason?: 'block'|'entity'|'max-distance', hitId?: string}}
 */
export function advanceProjectile({ state, dt, world, registry, entities, nowMs, onDamage = null }) {
  const next = update({ state }, dt, { world });
  const { reason, hitId } = judgeProjectile({
    next, world, registry, entities, stepLen: TURRET.projectileSpeed * dt, nowMs, onDamage,
  });
  if (reason) return { state: next, alive: false, reason, ...(hitId ? { hitId } : {}) };
  return { state: next, alive: true };
}

```

**遮挡判据的接线方式** —— `raycastVoxel` 缺省命中任何非空气非水方块，与弹丸的「实心且不
透明才阻挡」判据不匹配。两个选择：

```js
// 选项 A（推荐）：给 raycastVoxel 加可选 occludePredicate 参数（默认保持既有语义不变）
//   → 弹丸与玩家挖放共用同一份 DDA（红线 1：不写第二份 DDA）
// 选项 B：在 projectile-system.js 内写一份 DDA
//   → ❌ 第二份 DDA 实现，与红线 1 冲突（同一事实的两个副本会漂移）
```

**采用选项 A**：`src/player/raycast.js` 的 `raycastVoxel` 加第五个可选参数 `occludes`：

```js
/**
 * @param {import('../voxel/world-data.js').WorldData} world
 * @param {number[]} origin @param {number[]} dir @param {number} [maxDist=40]
 * @param {(id: number) => boolean} [occludes] 遮挡判据（M8）：缺省 = 既有语义
 *        「非空气且非水即命中」。弹丸传 `isProjectileOccluding`（实心且不透明才阻挡）——
 *        玻璃/云等透明方块可穿透。**不写第二份 DDA**（红线 1）。
 */
export function raycastVoxel(world, origin, dir, maxDist = 40, occludes = null) {
  // ...（既有实现不变，只把 `if (id !== 0 && id !== waterId)` 换成：）
  const hitTest = occludes
    ? (id) => occludes(id)
    : (id) => id !== 0 && id !== waterId;
  // for 循环内：if (hitTest(id)) return { hit: true, ... }
}
```

⚠️ **既有三个消费者（`player.js:220` / `:319` / `test-raycast.js`）不传第五参数** →
行为完全不变（缺省判据）。须跑 `npx playwright test tests/harness.spec.mjs` 确认
`test-raycast.js` 的既有用例仍全绿（回归门）。

- [ ] **Step 4: 实现弹丸渲染与发射接线**

`src/render/projectile-renderer.js`（几何照 mc-lite `InstancedProjectileRenderer.js:42`
的 `CylinderGeometry(0.08, 0.08, 2.0, 8)`）：

```js
// src/render/projectile-renderer.js — M8：弹丸渲染（固定 slot InstancedMesh，规格 §5.3）
// 几何照搬 mc-lite `InstancedProjectileRenderer.js:42`（圆柱 0.08 半径 × 2.0 长 × 8 段）。
// 朝向由 direction 派生（照 tracer-renderer 的 setFromUnitVectors 手法）。
//
// ⚠️ **slot 用差集驱动，不用 M6 的「service 分配 + 三条路径显式归还」**：
// M6 之所以要三条路径显式归还，是因为它的 slot 单一权威在 ZombieService，而
// `entities.despawnColumn()` 绕过 service → slot 不归还。弹丸没有玩法服务（直接经
// `entities.spawn/despawn`），故用「当前实体集合 vs 活动 slot」的差集驱动（M5
// `EntityRenderLayer.sync` 的同手法）—— 三条回收路径（命中 despawn / despawnColumn /
// dispose）自动覆盖，不需要逐条记账，也不会漏。
// ⚠️ 无活跃弹丸时 `visible=false`（否则恒增 1 个 draw call）。
import * as THREE from 'three';
import { TURRET } from '../entities/turrets/turret-config.js';

const _matrix = new THREE.Matrix4();
const _quat = new THREE.Quaternion();
const _pos = new THREE.Vector3();
const _scale = new THREE.Vector3(1, 1, 1);
const _dir = new THREE.Vector3();
const _forward = new THREE.Vector3(0, 1, 0);   // CylinderGeometry 默认沿 +Y
const _zero = new THREE.Matrix4().makeScale(0, 0, 0);

export class ProjectileRenderer {
  constructor({ scene, maxActive = 64 }) {
    this.scene = scene;
    this.maxActive = maxActive;
    const geometry = new THREE.CylinderGeometry(0.08, 0.08, 2.0, 8);
    const material = new THREE.MeshBasicMaterial({ color: 0xdddddd });
    this.mesh = new THREE.InstancedMesh(geometry, material, maxActive);
    this.mesh.name = 'projectile:pool';
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    for (let i = 0; i < maxActive; i++) this.mesh.setMatrixAt(i, _zero);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.scene.add(this.mesh);
    /** @type {Map<string, number>} entityId → slot（差集驱动，本层自己分配） */
    this._slots = new Map();
    this._nextSlot = 0;
    this._geometries = geometry;
    this.mesh.userData.material = material;
  }

  /**
   * 与当前弹丸集合对齐：新实体分配 slot、已有实体更新矩阵、消失实体归还 slot。
   * @param {Iterable<{id: string, state: {position:number[], direction:number[]}}>} entities
   */
  sync(entities) {
    const live = new Set();
    for (const entity of entities) {
      if (entity.type !== 'projectile') continue;
      live.add(entity.id);
      let slot = this._slots.get(entity.id);
      if (slot === undefined) {
        slot = this._nextSlot;
        this._nextSlot = (this._nextSlot + 1) % this.maxActive;   // 池满覆盖最旧（纯视觉）
        this._slots.set(entity.id, slot);
      }
      const { position, direction } = entity.state;
      _pos.set(position[0], position[1], position[2]);
      _dir.set(direction[0], direction[1], direction[2]);
      _quat.setFromUnitVectors(_forward, _dir);
      _matrix.compose(_pos, _quat, _scale);
      this.mesh.setMatrixAt(slot, _matrix);
    }
    // 归还消失实体的 slot（三条回收路径自动覆盖 —— 见文件头注释）
    for (const [id, slot] of [...this._slots]) {
      if (live.has(id)) continue;
      this.mesh.setMatrixAt(slot, _zero);
      this._slots.delete(id);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.visible = this._slots.size > 0;   // ⚠️ 无弹丸时不提交渲染
  }

  /** 只读 slot 数（测试钩子：验证三条回收路径都归还了 slot） */
  slotCount() { return this._slots.size; }

  dispose() {
    this.scene.remove(this.mesh);
    this._geometries.dispose();
    this.mesh.userData.material.dispose();
    this.mesh.dispose();
    this._slots.clear();
  }
}
```

`src/entities/turrets/turret-controller.js` —— 消费 Task 4 `update()` 返回的 true 发射弹丸。
构造函数 opts 加 `onFire = null`（Game 注入发射函数，controller 不反向依赖 entities/render）：

```js
// update() 末尾（return true 之前）：
if (this._onFire) {
  const m = this.muzzle(nowMs);
  this._onFire(m.position, m.direction, this.id);
}
this.writeBackFireClock(nowMs);
return true;
```

`src/core/game.js` —— 类型注册 + 渲染层装配 + 帧序接线：

```js
// 装配段（紧跟 turretRenderer 之后）：
this.entities.registerType('projectile', projectileDefinition);
this.projectileRenderer = new ProjectileRenderer({ scene: this.scene });
// TurretService 装配时注入发射函数（炮塔 controller 经它创建弹丸）：
// onFire: (position, direction, turretId) => this.fireProjectile(position, direction, turretId)

/** 创建一颗弹丸（临时实体，不存档）。id 确定性派生（红线 2：不用 Math.random） */
fireProjectile(position, direction, turretId) {
  this._projectileSeq = (this._projectileSeq ?? 0) + 1;
  const id = `projectile-${turretId}-${this._projectileSeq}`;
  return this.entities.spawn({
    id, type: 'projectile',
    state: { position, direction, traveled: 0, source: turretId },
    persistent: false,   // 临时实体：随 column 卸载回收，不进 entities snapshot
  }) !== null;
}

/**
 * 帧循环内判定弹丸（放在 `entities.update` 之后 —— 位置已推进，本方法只判定与 despawn）。
 *
 * ⚠️ **推进不能做两遍**（红线 1：同一事实的两个副本）。位置推进已由
 * `projectileDefinition.update` 经 `entities.update(dt, {world})` 驱动；本方法**只调
 * `judgeProjectile`（纯谓词）+ despawn**，不得再写 state —— 两处推进会让弹丸速度翻倍
 * （与丧尸「两处物理会让丧尸推进两遍」同一类缺陷，见 Step 1 的负向验证 ⑤）。
 * `judgeProjectile` 内部用 `from = position − direction×stepLen` 还原本步穿越的线段，
 * 故即便只拿到步后位置也能判定正确区间（见 Step 3 的 ⚠️）。
 */
_updateProjectiles(nowMs, dt) {
  for (const entity of this.entities.entities()) {
    if (entity.type !== 'projectile') continue;
    const { reason } = judgeProjectile({
      next: entity.state, world: this.world, registry: this.registry,
      entities: this.entities, stepLen: TURRET.projectileSpeed * dt, nowMs,
      onDamage: (id, amount, ms) => this.zombies.damage(id, amount, ms),
    });
    if (reason) this.entities.despawn(entity.id, reason);
  }
}
```

帧序接线（`entities.update` 之后、`entityLayer.sync` 之前）：

```js
this._updateProjectiles(nowMs, dt);
this.projectileRenderer.sync(this.entities.entities());
```

音效：拷入 `assets/sounds/turret_gun_fire.mp3`，`SOUND_IDS` 加 `turret_gun_fire`；
发射时 `this.audioManager?.play('turret_gun_fire', 0.25)`（mc-lite
`TurretManager.handleTurretFire` 同口径）。⚠️ **弹丸池容量 64 的标定依据**：
20 炮塔 × 开火冷却 500ms × 弹丸寿命 1.25s ≈ 50 → 取 64（2 的幂便于索引）。验收须实测峰值
并重标定（照 CLAUDE.md 的 cutout 容量教训）。

- [ ] **Step 5: 验证 GREEN + 负向验证**

Run: `npx playwright test tests/harness.spec.mjs`
Expected: PASS —— 推进速度、DDA 阻挡（透明穿透）、实体命中与三发死、超距消失、
新对象/新数组不变式。

⚠️ **负向验证**（全部须真 FAIL）：
① 注入「`update` 原地改写后返回同一对象」→ 跨 column 索引迁移测试 FAIL
（这条最隐蔽：弹丸照常在飞、照常命中，只是 column 卸载时漏回收 → 须在 spec 里造跨 column
飞行 + 卸载的场景才测得出来）；
② 注入「方块阻挡改用双点采样」→ 斜射穿薄墙（须造一个斜射场景）；
③ 注入「伤害改成 50」→ 两发即死（临界值断言 FAIL）；
④ 注入「判定顺序换成先实体后方块」→ 超距位置也能命中；
⑤ 注入「`_updateProjectiles` 里也推进位置」→ 弹丸速度翻倍（须断言 1 秒内飞行距离 ≈ 40 格）。

**自查无效盲区**：若伤害测试只断言「三发后丧尸消失」，注入「伤害改成 999」（一发死）
仍全绿 —— 故必须有「两发不死（health 32）」那条配对断言。

- [ ] **Step 6: 写 Playwright E2E**

`tests/projectiles.spec.mjs`：

```js
test('炮塔开火 → 弹丸飞行 → 命中丧尸掉血（三发死）', async ({ page }) => {
  await boot(page);
  // 放一个炮塔 + 在它前方 10 格生成一只丧尸 → 等炮塔索敌对准开火
  // 断言：projectilesDebugState().count 曾 > 0；丧尸 health 递减 34/68/100→死
  // ⚠️ 时序：炮塔索敌 8Hz + 朝向插值 π/2 每秒 + 冷却 500ms → 从放置到首次命中约 1~2 秒，
  //    spec 须用 waitForFunction 轮询而非固定 sleep（固定 sleep 在高负载 CI 上 flaky）
});

test('弹丸三条回收路径都归还渲染 slot', async ({ page }) => {
  // ① 命中 despawn → slotCount 归零；② column 卸载（传送走远）→ slotCount 归零；
  // ③ dispose → renderer 移除
  // ⚠️ 差集驱动的 slot 归还须逐条验证 —— M6 的教训是漏一条路径就常驻泄漏
});

test('无弹丸时 projectile mesh visible=false', async ({ page }) => {
  const visible = await page.evaluate(() => {
    const m = window.__MC_GAME__.scene.children.find((c) => c.name === 'projectile:pool');
    return m ? m.visible : null;
  });
  expect(visible).toBe(false);
});
```

⚠️ **负向验证**：注入「炮塔 `onFire` 回调不接线」→ 弹丸恒 0（这条 E2E 存在的理由 ——
接线缺陷在纯逻辑测试里测不出来，M6/M7 实测教训）。

- [ ] **Step 7: 验证 GREEN + 门禁 + bench**

Run: `npm run check && npx playwright test tests/projectiles.spec.mjs tests/harness.spec.mjs`
Expected: 全绿。

Run: `npm run bench -- --check`
Expected: 通过。draw call 对照表记录弹丸池的增量（无弹丸时回到基线）。

- [ ] **Step 8: 提交（仅获授权后执行）**

```bash
git add src/entities/turrets/projectile-system.js src/render/projectile-renderer.js \
  src/entities/turrets/turret-controller.js src/player/raycast.js \
  src/render/audio-manager.js src/core/game.js src/tests/test-projectiles.js \
  src/tests/index.html tests/projectiles.spec.mjs assets/sounds/turret_gun_fire.mp3
git commit -m "feat(projectiles): 弹丸实体——DDA 阻挡 / 实体 raycast 命中 / 三发 34 伤害"
```

---

### Task 7: 验收（全量回归 + 负向验证汇总 + 验收报告）

**Files:**

- Create: `docs/m8-tnt-turret-acceptance-report.md`
- Modify: `docs/roadmap.md`（回填 M8 commit hash + 状态改「✅ 完成」）
- Modify: `docs/superpowers/plans/2026-09-11-m8-tnt-turret.md`（实施状态 + 偏差表）

**Interfaces:**

- Consumes: Task 0~7 的全部产物
- Produces: 验收报告（实测数据 / 偏离表 / 负向验证清单 / draw call 对照）

- [ ] **Step 1: 跑全量门禁与测试**

```bash
npm run check                 # check:arch + check:data + lint
npm test                      # 全量 Playwright spec
npm run bench -- --check      # 性能回归门禁
```

Expected: 三者全绿。⚠️ 用例计数以 `npm run check:data` 输出为准，**不在报告里硬编码**
（CLAUDE.md：同一事实的多个副本会漂移）。

⚠️ **不带 `--check` 跑 bench 会自动重写 `docs/m3-baseline.*`**（冻结基线）—— 若误跑须
`git checkout docs/m3-baseline.md docs/m3-baseline.json` 恢复。门禁阻断时先做**交替对照**
（同会话内 `git stash` HEAD 与改动交错各跑 2~3 次比两侧分布），而非看单次数值
（vsync 量子化噪声会让 frameP95 误报）。

⚠️ **`m1-acceptance` 的计时断言在高负载下偶发贴线 flaky**（既有问题，16.7±1e-6 / 2.1ms）。
若失败须单独复跑 + 交替对照，**不改断言、不放宽阈值**。

- [ ] **Step 2: 汇总负向验证清单**

逐条重跑 Task 1~7 标注的负向验证，确认每条都**真 FAIL**（做完须恢复源码）。
按 `docs/testing-policy.md` §2.7 的十二类高发区自查无效盲区，特别检查：

- 断言落点是否落在真实接线上（而非桩件）—— Task 2 的爆炸伤害、Task 3 的 `onPlaced`、
  Task 6 的 `onFire` 三条接线缺陷都须有落在真游戏页的 E2E 兜住；
- 恒真陷阱：注入后仍全绿的断言（Task 1 的 indestructible 表、Task 6 的伤害换算、
  Task 5 的装甲三区取样三处已标注配对断言）；
- 计时断言交替对照（Task 2 的连锁延迟、Task 4 的开火冷却）；
- 像素取样点是否对准被测图案（Task 5 的三区装甲）；
- 竞态断言落在内存侧而非重载后的落库结果（Task 3/7 的 hydrate）。

- [ ] **Step 3: 写验收报告**

`docs/m8-tnt-turret-acceptance-report.md`，照 M4~M7 验收报告的同结构：

- §1 交付摘要（三个功能各自的玩法口径）
- §2 规格逐项对照（规格 §1~§8 → 实测结果，达标/偏离/未做）
- §3 实测数据（bench 四场景 fps/p95/draw/内存；2916 格平台写入的帧率与队列深度；
  最坏情况炮塔索敌开销 20×20）
- §4 **draw call 对照表**（炮塔 8 部件 + 弹丸池 + 爆炸球体池的增量，以及三者
  `visible=false` 时回到基线）
- §5 偏离表（规格已列的有意偏离 + 实施中新发现的偏离，每条附实测理由）
- §6 负向验证清单（条数 + 每条的注入与 FAIL 证据）+ 自查发现的无效盲区
- §7 遗留 TODO（若有）

⚠️ **实施中与计划的偏差须记进报告**（照 M7 验收报告 §4 的同手法）—— 计划未预见的接线、
实测必需的偏离、顺带修掉的既有缺陷都要写，不要静默吞掉。

- [ ] **Step 4: 回填 roadmap 与本计划的实施状态**

`docs/roadmap.md`：里程碑总表 M8 行填真实 commit hash、状态改「✅ 完成（日期）」；
「一句话现状」段更新；后续扩展点表划掉 TNT / 炮塔两行（创造台留给 M9）；
新增「M8 之后的遗留 TODO」段（若有）。

本计划文件头部加实施状态块（照 M7 计划的同手法）：

```markdown
> **实施状态（日期）：** Task 0~9 完成情况；**Step N（提交）待用户授权后执行**。
> 验收报告 `docs/m8-tnt-turret-acceptance-report.md`。
> 实施中与本计划的偏差（均为实测必需，详见验收报告 §5）：① ...；② ...
```

- [ ] **Step 5: 提交（仅获授权后执行）**

```bash
git add docs/m8-tnt-turret-acceptance-report.md docs/roadmap.md \
  docs/superpowers/plans/2026-09-11-m8-tnt-turret.md
git commit -m "docs(m8): 验收报告与 roadmap 回填"
```

---

## 计划自检

**规格覆盖**（规格 §1~§8 逐项 → 任务）：

| 规格节 | 任务 | 状态 |
|---|---|---|
| §1 `indestructible` 数据权威（**只登记 bedrock**，创造台两项移交 M9） | Task 1 | ✅ 覆盖 |
| §2 TNT（爆炸计算 / 两条引爆路径 / 连锁 / 破坏开关 / 伤害 / 特效音效） | Task 2 | ✅ 覆盖 |
| §3 炮塔装置层（结构锚点 / 失效上限 / 公开契约 / 背包分流 / 接线时序） | Task 3 | ✅ 覆盖 |
| §4 炮塔 AI（同构纯函数 / 数值口径 / 分工 / 朝向插值） | Task 4 | ✅ 覆盖 |
| §5 炮塔渲染与弹丸（UV 分区 / 部件池 / 弹丸实体 / 渲染回收 / 容量标定） | Task 5 + Task 6 | ✅ 覆盖 |
| §6 验收口径（TNT + 炮塔 + 回归门禁） | Task 7 | ✅ 覆盖 |
| §7 任务分解 | 本计划 Task 0~7 | ✅ 一致 |
| §8 设计文档同步 | Task 0 | ✅ 覆盖 |

⚠️ **创造台（原规格 §6/§7）已拆到 M9** —— 见 `docs/superpowers/plans/2026-09-11-m9-playground.md`。

**类型一致性**（跨任务的签名须一致）：

- `registry.isIndestructible(id)` —— Task 1 定义，Task 2/7 消费 ✅
- `computeExplosion({world,registry,center})` → `{center,destroy,chain}` —— Task 2 ✅
- `EXPLOSION_DAMAGE_RADIUS` / `EXPLOSION_DAMAGE` —— Task 2 定义并导出（单一权威）✅
- `zombies.activeEntities()` —— Task 2 定义，Task 4 消费 ✅
- `TURRET`（config）—— Task 3 定义，Task 4/5/6 消费 ✅
- `TurretController` 的 `currentRotation`/`currentPitch`/`targetRotation`/`targetPitch`/
  `lastFireAt`/`pivot()`/`muzzle()`/`isInvalidated()`/`writeBackFireClock()` ——
  Task 3 建骨架，Task 4 填充，Task 5/6 消费 ✅
- `computeTurretUpdates({turrets,zombies,world,registry})` → `{updates:[{id,targetYaw,targetPitch}]}`
  —— Task 4 定义，Game 消费 ✅
- `isProjectileOccluding(id, registry)` —— Task 4 定义，Task 6 消费（遮挡判据共用，红线 1）✅
- `TURRET_PARTS` / `TURRET_PART_DEFS` / `TurretRenderer.sync(poses)` —— Task 5 ✅
- `projectileDefinition` / `advanceProjectile` / `judgeProjectile` —— Task 6 ✅
  ✅ Task 6 已明确：`judgeProjectile`（纯判定，返回 `{reason, hitId}`）是唯一判定实现，
  `advanceProjectile` 是它的薄封装（推进 + 判定）仅单测用，Game 帧循环只用 `judgeProjectile`
  （推进由 `entities.update()` 驱动）—— 避免「两处推进让弹丸速度翻倍」
（`PLAYGROUND` / `Toast` 属 **M9** 范围，其类型一致性在 M9 计划的自检里核对。）

**占位符扫描**：无 TBD / TODO / 「类似 Task N」/ 「添加适当的错误处理」等模式；
每个代码步骤都给了完整代码块。
---

## 既有 API 实际签名对照表（减少执行者猜 API 的空间）

本计划多处消费既有接口。**下表是实测核对过的真实签名/返回值** —— 计划正文里凡引用这些
API 处，以本表为准（审查发现过 8 处凭印象写错的 API，都已在正文订正；本表是防再次猜错的
速查）。执行者遇到正文与本表不一致时，**以本表为准并停下来报告**。

| API | 实际签名 / 返回值 | 出处（实测） | 易错点 |
|---|---|---|---|
| `window.__MC_GAME__` | 全局测试钩子（不是 `window.game`） | `main.js:64` | spec 里一律用 `window.__MC_GAME__`；`window.game` 全仓零命中 |
| spec 起手式 | `await page.goto('/?vd=2')` + `await waitWorldSettled(page)` | `zombie-nests.spec.mjs:25` | **没有 `startGame(page)`**；`waitWorldSettled` 各 spec 各自定义（无共享 helper 模块） |
| `raycastVoxel(world, origin, dir, maxDist?, occludes?)` | 命中 `{hit:true, blockPos, normal, prevPos, dist}`；未命中 **`{hit:false}`（truthy 对象，非 null）** | `raycast.js:11,42` | 必须判 `.hit`；M8 加第五参数 `occludes`（缺省语义不变） |
| `player.setTestAim(dir)` | 设朝向 + 同帧重算 `this.target` | `player.js:304` | **没有 `updateTarget()`**；朝下瞄准传 `[0,-1,0]` |
| `player.physics.aabb()` | 玩家 AABB | `physics.js:108` | **没有 `_playerAabb()`**；不得在此重算尺寸（红线 1） |
| `player._placeSpecial(id, origin)` | 参数名是 `id`/`origin`（不是 `item`/`blockPos`） | `player.js:442` | 既有是「先判 `id !== NEST_ALIAS_BLOCK` return false」单分支 |
| `editor.setBlocks(changes)` | 返回 `{changes, affected, changedColumns, skipped}`；不带 `blockEntity` 即清除该格 entity | `world-editor.js` | 回滚与 close 的「中心块 entity 自动清除」依赖此语义 |
| `editor.setBlock({x,y,z,id,meta?,blockEntity?}, {fastPath?})` | 返回 EditReport；bedrock 门控 `reason:'bedrock'` | `world-editor.js:39` | 单块编辑入口 |
| `editor.setBlockEntity({x,y,z,value})` | `value=null` 删除；不 bump version、不 remesh | `world-editor.js` | 纯 entity 写 |
| `zombies.spawn(position, {source})` | `string \| null`（满额/落点非法 → null） | `zombie-system.js:357` | 不是 `spawnZombieDebug` |
| `zombies.damage(id, amount, nowMs)` | `{dead, health} \| null`；health ≤ 0 即 despawn | `zombie-system.js:405` | 红闪与 despawn 已实现，不另写伤害路径 |
| `zombies.activeEntities()` | `Array<Entity>`（type==='zombie'，Task 2 新增） | 本计划 | 返回数组快照（遍历中 damage 会 despawn 改变底层集合） |
| `entities.raycast(origin, dir, maxDist, predicate)` | `{id, type, dist, point} \| null`；predicate 收 `entity` | `entity-manager.js:277` | 实体命中唯一入口（红线 6） |
| `entities.spawn({id,type,state,persistent})` | `Entity \| null` | `entity-manager.js:57` | 弹丸 `persistent:false` |
| `game.audioDebugState().playRequests` | `{gun_fire: n, put: n, ...}` 只读计数 | `game.js:674` | E2E 据此断言音效播放 |
| `game._createNestController(id, anchorEntity=null)` | M7 实际签名（内联读锚点，支持传入） | `game.js:695` | **没有 `_readNestAnchor`**；炮塔版照此签名 |
| 门禁 `[物品集合]` 打印 | `N 项 = registry 126 − 排除 {两集合之和}` | `check-data.mjs:104` | 当前「排除 8」→ 改后「排除 10」（不是 6） |
| `registry.solidTable` / `opaqueTable` | `Uint8Array`；`opaqueTable[id] = def.opaque ?? (cullMode==='opaque')` | `block-registry.js` | `isProjectileOccluding` = 两表都 === 1 |

⚠️ **mc-lite 侧引用**（计划正文已订正的行号，执行者复核时以此为准）：
`PlayerInteraction.js:172`=ctrl+左键 / `:1048`=枪击命中（`executeShot` 内）/ `:673`=爆炸音效 /
`:683-688`=移除引爆格自身（在破坏开关外）/ `:617-618`=连锁去重 / `ExplosionWorker.js:8`=字面量数组 /
`World.js:111-127`=爆炸球体池 / `:1296`=粒子（World.js 无音频）/ `Turret.js:43`=资源 /
`:114-119`=ARMOR_TEXTURES / `:656`=pitchObject.rotation.x / `Zombie.js:163`=maxHits /
`:526-536`=takeDamage（两套血量并存）。

⚠️ **mc-lite 的 TNT 运行时目前是坏的**（`worldAccess` 未声明 → `:686` 抛 ReferenceError），
故 TNT 对齐口径是「读源码 + 推断意图」，验收报告不得写成「实测对齐 mc-lite」。
