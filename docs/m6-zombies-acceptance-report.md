# M6 丧尸验收报告

> **状态：** 已实施（2026-09-08）
> **规格：** `docs/superpowers/specs/2026-08-23-m6-zombies-design.md`
> **计划：** `docs/superpowers/plans/2026-08-23-m6-zombies.md`
> **基线参照：** `docs/m3-baseline.md`（M3 冻结基线，只参照不修改其阈值）

## 1. 环境

| 项 | 值 |
|---|---|
| 日期 | 2026-09-08 |
| 设备 | macOS ARM（本机设备矩阵，硬验收口径） |
| WebGPU adapter | apple / metal-3（`channel:'chromium'` 零 flag） |
| 浏览器 | Playwright 1.62.1 / Chromium 151（headless，真 GPU） |
| Node | v26.4.0 |
| three | r185.1（本地 `vendor/three/`） |
| 视距 | 8（289 column，稳态压力 case）；4（功能 case，加速） |

## 2. 验收项对照（M6 规格 §4）

每条验收都有对应断言，且**做了负向验证**（注入缺陷确认测试真的 FAIL —— 否则断言可能恒真）。

| 验收项 | 断言落点 | 负向验证 |
|---|---|---|
| 合法出生、脚/头空气 + 脚下 solid 校验 | `test-zombies.js`「四道门」+ `zombies.spec.mjs`「真实地形出生」 | 删任一门控 → FAIL；column 门控补了「唯一拒绝者」边界（见 §3） |
| 默认全局 20 上限 | 同上「20 上限」+「缺省上限派生」 | 删上限门控 → FAIL（抛错取代静默 null，见 §3） |
| 生命 100 与死亡 slot 回收 | 同上「精确伤害」+ spec「死亡对称回收」 | 改 health / 死亡不 despawn → FAIL |
| AABB 0.6×1.8×0.6 | 同上「实体 AABB」（命中距离从 `ZOMBIE.width/height` 派生） | 改 width/height → FAIL |
| 手枪 25 / 加特林 35 / MAG7 999；射程 40/40/10 | `test-weapons.js`「六个冻结数值」+ spec 三条 | 改任一数值 → FAIL（四发/三发/一击致死的关系式也钉住） |
| 近实体优先、近方块阻挡、相等按方块 | `test-weapons.js` 四条 + spec「放石头阻挡」 | 删遮挡判定 / 改 `<` 为 `<=` → FAIL |
| MAG7 先实体命中再方块扫描（非 projectile） | 同上「MAG7 实体射程 10」 | 改成 projectile（命中后不 setBlocks）→ FAIL |
| 单次 AI RPC 承载 60 格内全部丧尸 | `test-zombies.js`「20Hz + 60 格门控」+ spec「AI batch 可观测」 | 删 60 格门控 / 改 aiPeriod → FAIL |
| 80 格感知数据保留（与 60 格预算门分离） | 同上「80 格感知」+ spec worker 契约 | 两门混为一处 → FAIL |
| 迟到 generation 回包不改已 despawn/reused id | 同上「迟到 generation 回包」 | 删代数校验 → FAIL |
| 在途期间不重复发 RPC | 同上「真实在途窗口」 | 删在途门控 → FAIL（见 §3） |
| 六部件固定实例池 + 步态 + 200ms 红闪 | `test-zombies.js` 渲染五条 + spec（像素级实例色） | 改几何/配色/步态/红闪 → FAIL |
| column 卸载无 snapshot / scene child / slot 泄漏 | spec「真实 column 卸载链路」 | 绕过 ZombieService 回收 → slot 泄漏 FAIL |
| 默认 20 只相对 M3 基线回退 ≤10% | spec「压力验收」+ `bench --check` 交替对照 | — （见 §5） |
| 30 只 M7 联调压力 fixture（非默认配置） | spec「30 只压力 fixture」 | 纯 fixture 断言容量随 maxActive 扩到 30 |

## 3. 负向验证实测（Tier 1 必需环节）

四个 Task（含追加的 X 键调试键与朝向修复）分别做负向验证，**全部注入项都被抓到，0 漏网**：

| Task | 注入项数 | 被抓 | 漏网 |
|---|---:|---:|---:|
| Task 1（state / 出生 / 六部件渲染） | 27 | 27 | 0 |
| Task 2（批量 AI RPC / 60Hz 物理 / column 回收） | 26 | 26 | 0 |
| Task 3（实体伤害 / 最近命中 / MAG7） | 21 | 21 | 0 |
| §3.1 X 键生成丧尸（调试键） | 9 | 8 | 0（1 条如实标注为不可检测） |
| §3.2 朝向从速度派生（交付后修复） | 8 | 8 | 0 |

### 3.1 X 键生成丧尸（追加交付）

对齐 mc-lite `Game.js:155-202` 的 `KeyX` 调试键：随机角度 + 距玩家 2~10 格 + 向下扫地面。
负向验证 9 条注入，8 条被抓（repeat 守卫 / 模态守卫 / 「非空气」判据 / 不调 spawn / 上限钳制 /
不注入回调 / 回调空实现 / 距离范围），1 条如实标注为不可检测（向下扫深度 64→10，见下表）。

自查发现 3 条盲区并修正：① 判定谓词漏了「生成数量掉零」信号（只判「脚下不 solid」）；
② 多 seed 对照无效 —— `?seed=` 被 IndexedDB 存档覆盖（`game.js:138-139`），同一 context 里
后续 seed 全部失效，须每 seed 一个独立 browser context；③ 距离范围无断言（补 [1,12] 量级断言）。

### 自查发现并修掉的无效盲区（注入后仍全绿 → 断言没落在被测路径）

负向验证的价值不在「跑了多少条」，而在**抓出哪些看起来有效实则恒真的断言**。本次实测发现 12 条，全部修正：

| 盲区 | 根因 | 修法 |
|---|---|---|
| 缺「上限」门控不被抓 | 超上限落点落在**未加载 column** → column 门控先拒绝，上限门控不被触发 | 落点改到已加载 column 内（`x=50.5`）；并把 slot 耗尽从「静默 null」改为**抛错**（两道等价冗余门互相兜底会掩盖状态不同步） |
| 缺「column 已加载」门控不被抓 | 缺失 column 时 `getBlockId` 返 air、`isSolid` 返 false → 脚下门控总会先拒绝，column 门控在常规高度是冗余防御 | 补一条能让 column 门控成为**唯一拒绝者**的边界：`y = WORLD_MIN_Y`（脚下 `y-1 < WORLD_MIN_Y` → 返 bedrock = solid → 脚下门控通过）；fixture 需注册 bedrock |
| 「右腿不取反」不被抓 | `legSwingOf` 读 pose 内存值，而注入改的是**实例矩阵** | 补矩阵级断言：从两腿 `instanceMatrix` 反解 x 轴旋转，断言符号相反 |
| 「acquireSlot 不重置红闪」不被抓 | 测试在 acquireSlot 后立刻 `sync` → 初值被覆盖 | 断言挪到 sync **之前** |
| 容量/上限默认值不被抓 | fixture 显式传 `maxActive`，覆盖了被测默认参数 | 补两条**不传 maxActive** 的测试钉住默认值派生 |
| 材质类型无断言 | 文件头写了「用 MeshBasicMaterial 而非 Lambert」的理由却没钉住 | 补 `material.type === 'MeshBasicMaterial'` 断言 |
| 「在途不重复调用」不被抓 | fake pool 用 `Promise.resolve` 立即完成 → `_aiInFlight` 在两次 update 之间已清零 | 补一条把回包挂在**手动 resolve 的 promise** 上的测试，制造真实跨帧在途窗口 |
| 「createState 丢 _physAccum」不被抓 | 物理累积靠 update 里的**直接赋值**，不经 createState；且其余测试 dt 恰等于步长 → accumulator 恒为 0 | 补两条：非对齐 dt（0.025 秒 = 1.5 步）验余量跨 update 累积；中途 `damage` 重建 state 后验余量不丢 |
| 「水平撞墙清零 velocity」不被抓 | 只断言「没穿墙 + 移动过」，丧尸贴墙停住时两条仍成立 | 补「撞墙后 velocity 保留意图」+「拆墙后继续前进」（真实危害：RPC 20Hz vs 物理 60Hz，清零会让丧尸在两次 RPC 之间卡住） |
| 「超速钳制」不被抓 | 只断言常量，没触发钳制代码 | 走真实回包路径（`update()` → `_applyIntent`）注入超速回包，断言钳到 `ZOMBIE.speed`；不直接调私有方法 |
| worker 4 条注入不被抓 | 脚本跑的是**单测页**，而 worker 代码只在真游戏页的 WorkerPool 里加载 | worker 注入改走真游戏页 RPC；并修两条注入本身的设计问题（感知门注入需用 80 格外的 probe 才可检测；「夹带 world 字段」需断言 `Object.keys(reply)` 而非 `Object.keys(update)`） |
| 「setTestAim 不重算 target」不被抓 | 只断言 `aimedHit === true`，而陈旧 target 在真实世界里大概率也是 hit=true | 改为断言**两个明显不同朝向给出不同 target**（`aimedKey !== awayKey`） |

### 3.2 朝向从速度派生（交付后修复）

用户实玩报告「丧尸只能面向一个方向、无法转向」。根因：`state.yaw` 初始化后从未更新（见 §4）。
修复后负向验证 8 条注入全部被抓（删派生 / 删移动门控 / 公式参数颠倒 / 不写进 state / 阈值改 0 /
渲染层不写 yaw / 父级旋转不应用 yaw / 渲染层改用本地阈值字面量）。

自查发现 2 条盲区并修正，**其中第 ② 条是我在本次修复中刚踩的同一个陷阱**：

| 盲区 | 根因 | 修法 |
|---|---|---|
| ① 阈值注入不被抓 | 只测精确零速度 → 对精确零 `abs(0) > 0` 为 false，yaw 照样不变；阈值的真正用途是挡**浮点噪声**，但从未测过噪声级输入 | 补一条喂 0.0005（低于真实阈值 0.001）的断言 |
| ② 第 ① 条的第一版修法本身恒真 | 写成 `micro = ZOMBIE_MOVING_EPSILON / 2` —— **测试输入从被测常量派生**，注入把常量改成 0 时 micro 也变成 0 → 回到精确零 → 断言恒真 | 改用**字面量** 0.0005 + 前提断言（`0.0005 < ZOMBIE_MOVING_EPSILON`）。这与 lilypad 那次「硬编码被测代码写入的那个值」是同一陷阱 |
| ③ 渲染层阈值漂移不被抓 | 步态测试用速度 1.2（远大于注入的 0.5）→ 判定结果不变 | 补一条**跨层一致性**测试：在临界值附近（0.0015）断言朝向派生与步态累积**同时生效** —— 真实危害是两层阈值漂移导致「腿在摆但朝向没跟上」的撕裂状态 |

**另发现一条矩阵反解口径的陷阱**（已修，值得记进 CLAUDE.md）：three 的 `Euler.setFromQuaternion`
对 'XYZ' 序的 Y 轴用 `asin(m13)`，而 `asin(sin θ)` 在 `|θ| > π/2` 时会**折叠**回 [-π/2, π/2] ——
实测 yaw=2.4805 时 Euler.y 读出 0.661。第一版朝向测试选的 π/2 与 0 恰好在有效范围内 → 断言通过
**纯属侥幸**，换一个方向就会假失败。正确口径 = `atan2(elements[8], elements[0])`（纯 Y 旋转下
`elements[0]=cos θ`、`elements[8]=sin θ`，范围无关）。测试已改用该口径并补一条落在折叠区的用例。

### 如实标注的三条「注入构造不出可检测缺陷」（不计入漏网）

| 注入 | 为何不可检测 |
|---|---|
| 物理轴顺序颠倒（水平先走 → 竖直后走） | 颠倒后水平移动时 `tryStepUp` 读到的是**上一帧残留的 onGround**（站立场景恒 true），恰好补偿了顺序问题 → step-up 仍生效。真实危害仅限「上一步在空中、这一步落地、同帧撞墙」这个边界（差一步上台阶，下一帧即恢复），不值得补一条依赖精确帧对齐的脆弱测试 |
| MAG7 射程 10→15（spec 侧） | spec runner 只打手枪近距，构造不出 MAG7 射程缺陷。它已由**单测**覆盖并抓到（「MAG7 射程与 scan.max 漂移」+「maxDist 用 MISS_RANGE 而非 entityRange」） |
| X 键向下扫深度 64→10（见 §3.1） | 云面出生时 10 格内会命中**悬浮空岛**（M2 空中结构）→ 丧尸站在空岛上脚下 solid，是完全合法的结果。实测：固定方向诊断脚本得 `scan10=null`（看似可检测），但真实代码是随机角度 + 8 次重试，几乎总能命中有结构的方向 → `afterThree=3`、`feetSolidOk=true`。丧尸站在空岛上属合法玩法，不值得为「必须落在主地面」补断言 |

## 4. 实施中发现并修掉的真实缺陷

按「诊断不猜」原则，每条都先在隔离环境复现、读实际数据定位根因，再动手修。

| 缺陷 | 根因（实测数据） | 修法 |
|---|---|---|
| **丧尸索引永不迁移 → 卸载漏回收** | `EntityManager.update()` 的迁移判据是「赋值前 position vs 赋值后 position」；物理原地改写 state 并返回同一对象 → before/after 从同一份已改写位置算出 → 恒相等。实测：跨 column 后 `entitiesInColumn('0,0')` 仍为 1 | 物理推进在**全新 state + 全新数组**上做（浅拷贝不够：position 数组引用相同仍会被污染）。开销 20 只 × 60Hz ≈ 1200 个小对象/秒，bench 实测无回退 |
| **step-up 完全失效** | `onGround = false` 放在水平移动**之前** → `tryStepUp` 永远拿不到 onGround | 竖直轴先走算出 onGround，水平轴再据此判定能否上台阶（与 `player/physics.js` 同序） |
| **丧尸撞墙后彻底卡住** | 水平碰撞时清零 `velocity[0]`，而 AI 意图每 0.05 秒才刷新（物理跑 60Hz） | 水平轴撞墙**不清零**（竖直轴必须清零，否则重力累积穿地抖动） |
| **AI 意图永远写不进 state（丧尸原地不动）** | `WorkerPool.call` 返回 `{id, promise}`（`worker-pool.js:71`）而非 promise 本身；代码只判 `typeof result.then` → 走同步分支拿到 `{id,promise}` 对象（无 `updates` 字段）。实测：RPC 发出 11 次、回包也回来了（pending 0），但 velocity 恒 0、mode 恒 idle | 显式取 `.promise`；**并同步修 fake pool 返回形状**（原先返回裸 promise，纯逻辑测试全绿而真实接线失败 —— 测试与接线口径不一致的盲区会让缺陷静默逃逸） |
| **丧尸永久红闪、永不消退** | 红闪用 `Date.now()`，而 `ZombieRenderer.sync(zombies, nowMs)` 的 nowMs 来自 `setAnimationLoop` 回调（= `performance.now()` 基准）。实测两基准相差约 17 亿毫秒（`Date.now()=1788847988963` vs `performance.now()=676.6`）→ `nowMs < flashedUntil` 恒真 | 统一用 `performance.now()`。实测确认修复生效：实例色 `#ff0000` 亮起 → 250ms 后复位为 `#406b30` |
| **六个常驻 mesh 恒增 6 个 draw call** | InstancedMesh 构造期 `count=20`，即使全部 slot 是零 scale 仍被提交渲染。实测：bench 场景 ④ draw 530（HEAD）→ 536（改动侧），恰好 +6 | 无活跃丧尸时 `visible=false`（与 `tracer-renderer.js` 同一手法与理由）。修复后两侧 draw 均为 530 |
| **丧尸永远面向同一方向、不转向**（交付后用户实玩报告） | `state.yaw` 只在 `createState` 初始化为 0，此后**从未被更新** —— `setIntent` 只写 velocity/mode。渲染层确实消费 yaw（`_parent.rotation.set(0, pose.yaw, 0)`），但读到的恒是 0 | 在 `setIntent` 里按 mc-lite `Zombie.js:230-239` 的 `setDesiredVelocity` 口径派生：`yaw = atan2(vx, vz)`，且**仅在移动时更新**（静止保持原朝向，避免零速度把 yaw 清零）。实测确认：玩家移动后两只丧尸 yaw 均随之改变，`state.yaw` 与渲染矩阵一致 |

### 测试侧根因（非产品缺陷，但会导致假失败）

压力测试在全量跑中曾出现 `spawnedCount=0` 而单独跑通过。两次独立诊断（落点扫描构成、存档残留）都无法复现，故让失败自带现场数据后连跑复现，拿到 `seed=3560085 pos=283,56,206 biome=CITY scanned=0` —— 玩家 **y=56**。

根因：`findSpawnY`（`src/gen/terrain.js:98-102`）从世界顶向下扫第一个非空气方块并返回 `y+1`，而 M2-7 的云层 `supportsPlayer=1` 但 `solid=0` → **空中结构会被当成「地面」**，随机 seed 下玩家可能出生在云面上（实测 6 次试验中 1 次 y=56、`belowSolid=false`）。此时落点扫描的 `y±4` 范围内全是空气且脚下不 solid → 扫到 0 个落点。

**这是既有行为，不是 M6 引入的缺陷**（seed=12345 出生正常在 stone 上）。修法：两个落点 helper 改为对每个 `(x,z)` **从玩家高度向下扫真实地面**（最多 64 格），不再依赖玩家当前 y。修复后压力测试连跑 5/5 通过。

> **遗留观察（不属 M6 范围，供后续参考）：** `findSpawnY` 把云层当出生点会让玩家出生在高空云面上，而丧尸 spawn 要求「脚下 solid」→ 云面上不会自然刷怪。若后续要让丧尸在玩家身边自然出现，需先决定 `findSpawnY` 是否应跳过 `supportsPlayer` 非 solid 方块。本次未改动该函数（属 M1/M2 的出生点口径，改它会牵动 M1 验收与既有 spec）。

## 5. 性能实测与交替对照

### 默认 20 只丧尸稳态（`vd=8`，289 column）

| 项 | 值 |
|---|---|
| fps | 120.01 |
| frameMs.p95 | 10 |
| drawCalls（丧尸前 → 后） | 391 → **397**（恰好 +6 = 六个部件 mesh） |
| sections | 1614 |
| AI | calls=41、lastBatchSize=20、pending=0（队列收敛） |
| slot | 20 个互不重复，全部在 [0,20) |
| scheduler 七项 | genInflight/meshInflight/meshQueued/pendingMesh/lightInflight/lightQueued/uploadQueue **全部为 0** |

**合批收益**：draw call 增量恒为 6，与丧尸数量无关（对比 mc-lite「每类型 InstancedMesh + 每尸 Group」会随丧尸数线性增长）。

### `bench --check` 交替对照（CLAUDE.md 要求的口径）

首次 `bench --check` 阻断（场景 ④ `frameP95: 9 → 10`，回退 11.1%）。按纪律**不擅自改断言或静默放宽**，改为交替对照（改动侧 N 次 → HEAD 侧 N 次 → 反复）：

| 轮次 | 侧 | 场景 ④ frameP95 | draw | --check |
|---|---|---|---:|---|
| 第 1 轮 | 改动侧（3 次） | 10 / 9.8 / 9.2 | 536 | 2 次阻断 |
| 第 1 轮 | HEAD 侧（3 次） | 9.1 / 9.1 / 9.1 | 530 | 全通过 |
| — | **修掉 +6 draw call 缺陷** | | | |
| 第 2 轮 | 改动侧（3 次） | 9.1 / 9.2 / 9.2 | **530** | 1 次阻断 |
| 第 2 轮 | 改动侧（3 次） | 9.3 / 9.2 / 9.2 | 530 | 全通过 |
| 第 2 轮 | **HEAD 侧（3 次）** | 9.1 / 9.3 / 9.2 | 530 | **2 次阻断** |

**结论：**

1. **修掉真实缺陷后两侧 draw 完全一致（530）** —— M6 对稳态 draw call 零增量（无丧尸时六部件 `visible=false`）。
2. **`bench --check` 的阻断是既有 flaky 计时断言，与 M6 无关**：HEAD 侧同样 sporadic 阻断（实测抓到两次），且阻断指标在两侧都落在**场景 ③ 的 remesh/upload 热路径**（`fastRemeshP95: 1.1 → 1.3`、`uploadMsP95: 0.6 → 0.7`）—— M6 完全不碰那条路径（丧尸物理在主线程 60Hz accumulator，武器伤害是 O(1) 实体 AABB 比较）。
3. **两侧 frameP95 分布重叠**（改动侧 9.1~9.3 vs HEAD 侧 9.1~9.3），无系统性回退。

这与 CLAUDE.md 记录的既有事实一致：`m1-acceptance` 计时断言在高负载下偶发贴线 flaky；计时类断言须交替对照，单侧连跑会让后跑的一侧承担更高负载。

### `m1-acceptance` 放挖 p95 的交替对照

最终一次全量跑里 `m1-acceptance`「放挖压力 p95」失败。单独复跑 3 次 + HEAD 侧对照 3 次：

| 侧 | digP95 三次采样 | 结果 |
|---|---|---|
| 改动侧 | 1.8 / **2.0** / 1.8 | 2 失败 1 通过 |
| HEAD 侧 | **2.0** / 1.8 / 1.7 | 1 失败 2 通过 |

**结论：既有 flaky，与 M6 无关。** 断言阈值是 `digP95 < 2`，两侧都在采样恰好等于 2.0 时失败
（贴线抖动），且失败有时落在另一条断言（`frameMs.p95 < 16.7`）上 —— 失败的指标每次不同是
抖动而非系统性回退的特征。机制上 M6 不碰放挖热路径（丧尸物理在主线程 60Hz accumulator，
武器伤害是 O(1) 实体 AABB 比较，`zombies.update()` 在零丧尸时只累加 accumulator 即返回）。
两侧分布重叠，未改断言、未放宽阈值。

## 6. 有意偏离 mc-lite（逐项实测读源，非凭字段名推断）

mc-lite 丧尸实现在 `src/actors/enemy/Zombie.js` + `ZombieInstancedRenderer.js`（几何常量表 `:28-82`、几何构造 `:176-210`、矩阵计算 `:548-566`）。

| 项 | mc-lite | mc-heavy | 理由 |
|---|---|---|---|
| head 配色 | `ZOMBIE_COLORS.head = 0xffffff` | `0x406b30` | 那是**白底乘纹理色**（六面材质 color 全是白色，真实颜色由马赛克 CanvasTexture 给，`headPalette.base = [64,107,48]`）。本仓库不做 CanvasTexture（M6 规格 §3 只要求「配色沿 mc-lite」），直接用其视觉色 —— 照 `0xffffff` 实现会渲染成纯白头 |
| 材质 | `MeshLambertMaterial` | `MeshBasicMaterial`（unlit） | mc-heavy 全场景是 unlit 设计，灯光只为 PBR 武器模型标定（`game.js` 的 Ambient 2.3 / Directional 3.2 注释）。用 Lambert 会让丧尸吃到为枪标定的环境光强度 → 偏亮且随日夜灯光漂移。与 ocean/rain/tracer 同口径 |
| 步态驱动 | `_walkTime += deltaTime`（按时间累积） | 同口径 | 实测读源确认：不是「按移动距离累积」。静止时 `_walkTime = 0` **归零而非冻结** |
| 生命周期 | 超过 60 格仅冻结 AI | 临时实体随 column 卸载销毁；60 格仍只控制 AI 预算 | M6 规格 §1 明确的有意差异（流式世界卸载）；60 格不是销毁半径 |
| X 键落点判据 | `getBlock !== null && !== 'air'`（非空气即当地面） | `isSolid`（脚下须 solid） | mc-lite 判据会把 M2-7 云层（`supportsPlayer=1` 但 `solid=0`）当地面 → `ZombieService.spawn` 的「脚下 solid」门控拒绝 → 生成静默失败（实测：注入 mc-lite 判据后按 3 次只生成 0 只） |
| X 键向下扫深度 | 10 格 | 64 格 | `findSpawnY` 会把空中结构当出生点 → 玩家可能在云面上（实测 y≈56），与真实地面（y≈17~26）落差约 40 格，10 格扫不到。注：此偏离属「注入不可检测」（见 §3 第三条标注） |
| X 键随机数 | `Math.random()` | 同口径 | 调试键是玩家手动触发的动作，时机本身不可复现，且丧尸是临时实体不入存档 —— 不属红线 2 的「seed 确定性世界生成」范畴（对比 v1.37：`generateCodeHouse` 是生成期代码，必须用 seededRandom） |
| X 键失败处理 | 只试一次落点，失败静默无输出 | 最多试 8 次不同随机落点，并把结果返回给调用方 | 便于测试断言（不靠 console.log），且提高真实地形上的成功率 |

**照搬未偏离的关键细节**（照字段名实现会渲错）：leg 几何做了 `translate(0, -height/2, 0)`（mc-lite `:203`）→ 几何原点在大腿**根部**而非盒中心，故 offset `y=0.9` 是轴心高度、盒体向下延伸 1.0。不做 translate 则整条腿随摆动平移（像踩高跷），而不是绕髋部扫弧线 —— 这是行走动画的关键，已用包围盒断言钉住。

## 7. 门禁结果

| 门禁 | 结果 |
|---|---|
| `npm run check`（check:arch + check:data + lint） | ✅ 全绿（0 error；9 warning 全为既有 `mesher.js` camelcase，非本次引入） |
| `npm run check:arch` | ✅ 架构红线全部守住（1 项既有白名单例外） |
| `rg "new Worker\|localVoxelView\|Raycaster\|intersectObjects"` on `src/entities/zombies` + `src/workers/world-worker.js` | ✅ 无匹配 |
| 浏览器内单测 | ✅ **394 passed / 0 failed**（zombie 35 条） |
| `npm test`（全量 E2E） | ⚠️ **75 passed / 1 failed**：唯一失败是 `m1-acceptance`「放挖压力 p95」（既有 flaky 计时断言，见下）。此前一次全量跑为 76 passed / 0 failed |
| `git diff --check` | ✅ 无空白错误 |
| `npm run bench -- --check` | ⚠️ 见 §5：交替对照确认阻断为**既有 flaky**，两侧分布重叠、draw 一致；未改断言、未放宽阈值 |

## 8. 交付物清单

**新增：**

- `src/entities/zombies/zombie-config.js` —— 冻结玩法数据唯一权威（上限/生命/AABB/速度/两门/步态常量 + 两层共用的移动阈值 `ZOMBIE_MOVING_EPSILON`）
- `src/entities/zombies/zombie-system.js` —— `ZombieService`（玩法入口）+ `zombieDefinition`（含 60Hz 固定步长物理）；`setIntent` 内派生朝向（对齐 mc-lite `setDesiredVelocity`）
- `src/render/zombie-renderer.js` —— 六部件固定容量 InstancedMesh（步态 + 红闪 + visible 基线 + 消费 `state.yaw`）
- `src/tests/test-zombies.js` —— 39 条纯逻辑/渲染单测（含朝向派生 3 条 + 跨层阈值一致性 1 条）
- `tests/zombies.spec.mjs` —— 10 条浏览器集成/压力验收（含 X 键调试键）
- `docs/m6-zombies-acceptance-report.md` —— 本报告

**修改：**

- `src/core/game.js` —— 装配 ZombieService/ZombieRenderer、卸载回收顺序（先 service 后 commit）、帧序（AI 编排在 entities.update 之前）、entityQuery 注入、dispose 反向释放；追加 `spawnZombieNearPlayer()`（X 键调试键，对齐 mc-lite）+ `onSpawnZombie` 回调注入
- `src/workers/world-worker.js` —— 既有 message switch 增加 `ai` 分支（**不新建 Worker**）
- `src/player/weapons/weapon-catalog.js` —— 增补 `entityDamage`/`entityRange`（25/40、35/40、999/10）
- `src/player/weapons/weapon-controller.js` —— `setEntityQuery` + 统一遮挡口径 `_queryEntityHit` + `entity-hit` 效果事件
- `src/player/player.js` —— `setTestAim`（仅测试 helper，不绕过 controller）；追加 `KeyX` 处理（repeat 守卫 + 模态守卫）+ `onSpawnZombie` 注入参数
- `src/tests/index.html` —— 加 import map（渲染器断言需 three）+ 注册 `test-zombies.js`
- `src/tests/test-weapons.js` —— 8 条实体伤害/遮挡单测

## 9. 未交付项（M6 规格 §1 明确的非目标）

- **丧尸不攻击玩家**：无 `PlayerVitals`、无近战、无攻击冷却、无玩家死亡/重生（严格保留 mc-lite 语义）。若以后需要生存战斗，应另立 PlayerVitals Epic
- 无掉落物、无昼夜自然刷怪、无寻路网格
- **无巢穴**（M7）；M7 仅通过 `ZombieService.spawn()` 使用本 Epic
- **X 键是调试键，不是玩法生成入口**（对齐 mc-lite 的 `[Debug]` 用途）—— 正式的生成入口是 M7 巢穴。X 键只为实玩验证 M6 的追逐/命中/回收链路，不参与任何玩法数值
- 活动上限 UI/持久化（默认 20；30/50 档须重新验收容量与性能，不得静默复用本容量）
