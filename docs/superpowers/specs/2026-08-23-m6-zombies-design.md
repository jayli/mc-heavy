# M6 丧尸设计

**状态：** 已实施并验收（2026-09-08，验收报告 `docs/m6-zombies-acceptance-report.md`）
**定位：** 第二阶段敌人垂直切片；依赖 M5 实体运行时与 M4 武器的实体射线适配点，不包含巢穴。
**关联：** `docs/superpowers/specs/2026-08-23-m5-entity-runtime-design.md`；M7 仅通过
`ZombieService.spawn()` 使用本 Epic。

## 1. 目标、语义与非目标

M6 交付可被玩家武器命中、追逐玩家、死亡回收的临时丧尸。它**不攻击玩家**，不含 `PlayerVitals`、
玩家死亡/重生、掉落物、昼夜自然刷怪、寻路网格或巢穴。这是严格保留 mc-lite 的现有语义：mc-lite 的
丧尸没有攻击行为和玩家生命系统；若以后需要生存战斗，应另立 PlayerVitals Epic，并完整定义数值、HUD、
死亡和重生。

固定玩法数据如下（数值直接对齐 mc-lite）：

| 项 | 值 | 说明 |
|---|---:|---|
| 丧尸 AABB | `0.6 × 1.8 × 0.6` | 脚底为 position |
| 生命 | 100 | 临时 state，不存档 |
| 手枪 | 25 伤害，40 格 | 四发死亡 |
| 加特林 | 35 伤害，40 格 | 三发死亡 |
| MAG7 | 999 伤害，10 格 | 实体一击死亡；仍保留 M4 的体积方块破坏 |
| 默认活动上限 | 20 | mc-lite 默认值；未来设置可选 20 / 30 / 50，本 Epic 不做 UI/持久化 |
| 感知范围 | 80 格 | 保留为 type 数据 |
| AI 预算门 | 距玩家不超过 60 格 | 超出后冻结 AI 意图而非立即销毁 |
| 追逐速度 | 1.2 格/秒 | mc-lite `0.02 格/帧` 按 60Hz 换算 |
| AI 周期 | 0.05 秒（20Hz） | 等价于 mc-lite 60fps 下每 3 帧一次 |

临时丧尸的生命周期由 M5 的 column 卸载通知决定：其所在 column 超过 `viewDistance + 2` 后被卸载时销毁，
不写 snapshot。与 mc-lite 的“超过 60 格仅冻结 AI”相比，流式世界卸载是有意差异；60 格仍只控制 AI
预算，不能被误当作销毁半径。

## 2. 架构与契约

`ZombieService` 是 M6 唯一的玩法入口；`ZombieState` 至少包含
`{position, velocity, yaw, health, mode, flashedUntil}`。攻击冷却不属于 state，因为 M6 没有
近战攻击。

**实施偏离（2026-09-08）：`generation` 不入 state。** 本规格原写「至少包含 {…, generation, …}」，
但 generation 的唯一权威是 M5 的 Entity wrapper（`EntityManager` 不变式 ②：单调递增、despawn 后
不重置）。复制进 state 会开**第二份版本协议真相** —— 两者漂移时无法判断哪份对，且 AI 回包校验会
读到过期代数（违反红线 1）。故 state 不含 generation，AI 回包一律经 manager 的
`entity.generation` 校验。已用单测钉住（`assertFalse('generation' in state)`）。

另有两处瞬态物理派生量入 state（`onGround` / `_physAccum`），不入 snapshot（丧尸是临时实体，
本就不写盘），故不算第二份权威。

```js
zombies.spawn(position, { source }); // string | null；成功返回 id，满额/非法位置返回 null
zombies.get(id);                     // Readonly<ZombieState> | null（只读测试接口）
zombies.count();                     // number
zombies.damage(id, amount, nowMs);   // {dead:boolean, health:number} | null
zombies.update(dt, { world, playerPosition, nowMs });
zombies.despawnColumn(columnKey);    // number；M5 column 卸载前的临时实体回收包装
zombies.dispose();
```

spawn 在 `EntityManager` 前验证脚和头为空、脚下 solid、位置 column 已加载及全局上限；死亡/column 卸载/
`dispose()` 都从 `EntityManager` 与渲染 slot 对称回收。`damage()` 立即改变权威 state、设置
`flashedUntil = nowMs + 200`，health 小于等于零立刻 despawn。返回值用于测试而非效果事件替代品。

M6 在**既有** `world-worker.js`/WorkerPool 中增加一个 `ai` 操作，不新建 Worker：每 0.05 秒仅发出一条
RPC，携带全部未死亡且距玩家不超过 60 格的 plain state、player position 与本周期 `dt`。不传局部体素
view；worker 仅输出每只丧尸的 `{id,generation,vx,vz,mode}`。主线程按既有 60Hz 固定步长以
`world.isSolid()` 应用重力、AABB 碰撞和一格 step-up；回包 id/generation 不匹配即丢弃。这样没有每尸
往返、主线程 BFS 或第二套物理。

M4 的冻结 `WEAPONS` catalog 在 M6 增补 `entityDamage` 与 `entityRange` 字段。`WeaponController` 对三把
枪都以该 range 发起 `EntityManager.raycast()`，并与 DDA 体素命中比较距离：更近的实体受伤；更近的方块
阻挡实体。这是 M6 明确的统一遮挡口径。MAG7 先完成该 10 格实体命中，再按 M4 已定义的单发体积扫描
提交方块 `setBlocks()`；它不是 projectile，也不把方块扫描改成实体射线。

## 3. 渲染与性能

`ZombieRenderer` 只读 pose，用六个固定容量为 20 的 `InstancedMesh` 渲染 `head`、`body`、`leftArm`、
`rightArm`、`leftLeg`、`rightLeg`。几何为程序化盒体，部件尺寸、配色及偏移沿 mc-lite；不得导入 GLB、
不得为每只丧尸创建 `Group`。

渲染保留 mc-lite 的两项反馈：按移动速度驱动、速度 10/摆幅 `π/8` 的腿部摆动，以及受伤后 200ms 红闪。
slot 只在 spawn 时占用，死亡、卸载和 dispose 必须归还；不得因性能压力淘汰仍存活的实体。未来 30/50 配置
档须重新验收容量与性能，不能把 20 的固定容量静默用作高档配置。

## 4. 验收

- 合法出生、脚/头空气和脚下 solid 校验、默认全局 20 上限、AABB 碰撞、step-up、生命 100 与死亡 slot
  回收均有浏览器/纯逻辑测试。
- 手枪命中使 health 从 100 变 75；加特林三次伤害后死亡；MAG7 在 10 格内一击死亡、10 格外不伤害。
  每把枪均验证“近实体优先、近方块阻挡”。
- 单次 AI RPC 承载所有在 60 格内的丧尸；80 格感知数据保留，超过 60 格不产生 AI 输入；迟到 generation
  回包不改变已 despawn/reused id 的实体。
- 六部件固定实例池保留步行动画和 200ms 红闪；column 卸载没有 entities snapshot、scene child 或 slot
  泄漏。
- 默认 20 个活动丧尸下相对 M3 冻结基线性能回退不超过 10%；若用 30 作为 M7 联调压力 fixture，报告须
  明示它不是默认配置。
