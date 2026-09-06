# M4 玩家武器系统设计

**状态：** 已实施，验收报告：docs/m4-weapons-acceptance-report.md
**定位：** 第二阶段的首个独立 Epic；不属于第一阶段 M2/M3。
**关联：** `docs/phase-1-engine-design.md` §4.5.2、§4.5.3、§9；`docs/superpowers/plans/2026-08-20-phase1-remaining-roadmap.md`。

## 1. 决策与范围

第一阶段的 M2、M3 保持原定义和顺序：M2 完成世界完整性，M3 完成性能验收与收尾。M4 在 M3 的性能报告验收后开始，是第二阶段的“玩家第一人称武器”垂直切片；不为给武器腾位置而重命名或拆散 M3。

M4 的可玩交付是三把 mc-lite 玩家枪：手枪（`pistol`）、MAG7（`mag7`）、加特林（`minigun`）。玩家可用按键在手/三把枪间切换；枪在相机空间显示，具备举枪、后坐、连射、曳光和音效；枪口朝向使用 DDA 命中方块。手枪和加特林可按设置破坏方块；MAG7 是明确例外，始终用一次批量世界编辑制造近距离散射破坏，不受该设置限制。

下列内容明确不在 M4：炮塔、飞行炮弹、丧尸和伤害结算、第三人称武器、网络同步、弹药/装填/背包消耗、任意用户上传模型、创造台模型编辑。这些分别依赖实体系统、库存规则或受限资产导入，不能作为“武器模型导入”的附带范围进入 M4。

## 2. 为什么放在第二阶段而非 M2/M3

- 设计文档 §4.5.2 已将“少量实体射线（子弹）”定义为第二阶段工作；§9 将“炮塔/子弹/丧尸”归入后续功能。
- M2 的验收是确定性结构与世界视觉完整性，M3 的验收是视距 8 性能、雨效、HUD 与基线报告。两者都不以武器玩法为验收对象。
- 当前实现已有 40 格 DDA 命中、`WorldData.setBlock()` 与 section 快速重建，但设计 §4.5.3 已预留而尚未实现的 `setBlocks(batch)`、`block-changed` 事件、实体接口和音频接口正好是第二阶段的基础工作。
- 把模型加载、批量编辑和持续连射混入 M3，会让性能基线不再是纯体素引擎的冻结基线，无法判断后续回归来自世界管线还是武器渲染。

因此，M4 可以作为独立的路线图 Epic 和独立验收/提交序列执行，但不是“零前置的单一任务”：它内部必须先完成最小的世界编辑与静态资产底座。

## 3. mc-lite 语义与保留口径

mc-lite 的玩家枪不是飞行弹丸系统。手枪与加特林是 40 格 hitscan：命中后生成短寿命曳光；MAG7 在近距离扫描有限数量方块并批量删除。真正持续飞行的 `Projectile` 属于炮塔系统，留到实体 Epic。

M4 保留以下玩法语义：

| 武器 | 射速/特点 | 方块语义 | 视觉语义 |
|---|---|---|---|
| 手枪 | 0.09 秒冷却 | 默认仅阻挡；开启方块破坏后删除首个可破坏命中 | 黄色细曳光、轻微后坐 |
| MAG7 | 1.5 秒冷却；只在一次按下时开火，不按住连射 | 无视 `canGunsDestroyBlocks`；近距离散射最多 40 个通过破坏策略的候选块，以一次批量编辑提交 | 橙色粗曳光、较强后坐 |
| 加特林 | 0.07 秒冷却 | 与手枪相同 | 黄色细曳光、枪管旋转 |

`canGunsDestroyBlocks` 默认关闭，保留 mc-lite 的安全默认值。关闭时体素仍会阻挡手枪/加特林射线并决定曳光终点，但不会写世界；MAG7 保留 mc-lite 的例外语义，始终破坏候选块。所有方块破坏最终都走同一世界编辑入口；武器不得直接改 `blocks`、不得直接调用渲染层、不得使用 `setTimeout` 分批写入世界。

M4 有一项有意偏离：mc-lite 会把 MAG7 的候选按每批 5 块、间隔 50ms 的 `setTimeout` 延迟写入，产生由近及远的连锁破坏。M4 将全部候选在同一逻辑事务中提交 `setBlocks()`，派生网格随后经 Worker REMESH 异步收敛；因此世界破坏是原子可重建的，视觉不会保留 50ms 的多层写入动画。开火/曳光仍当帧触发，网格可见更新遵守既有上传预算，不承诺固定“一帧内”完成。

另一项有意偏离是曳光起点坐标系。mc-lite 的 `PlayerInteraction.updateTracers()` 每帧以当前相机基底重算曳光起点（`localStart.applyQuaternion(camera.quaternion).add(camera.position)`），而终点在开火瞬间冻结在世界命中点——起点在相机空间、终点在世界空间的**混合坐标系**导致快速转镜头时起点被相机拖着走、终点钉死不动，两点连线偏离枪管指向，弹道看上去歪了。M4 将曳光起点也**冻结在世界空间**（开火瞬间算好的枪口世界坐标），起点与终点同为世界坐标；曳光代表子弹已飞完的真实弹道残影（寿命 0.08~0.15s），镜头移动时整条曳光纹丝不动，枪管转开是自然的，歪斜感从机制上消失。这是 hitscan 曳光的标准做法（DOOM/Quake 类），也与「曳光是可丢弃的纯视觉派生数据」的定位一致。

## 4. 架构

### 4.1 世界编辑与事件：M4-0 的唯一前置

新增一个注入 `WorldData` 与 `Scheduler` 的主线程世界编辑协调器。它不保存体素副本，职责仅是协调已有唯一权威数据与派生重建：

```js
class WorldEditor {
  setBlock({ x, y, z, id, meta = 0 }, { fastPath = true } = {}) {}
  setBlocks([{ x, y, z, id, meta = 0 }]) {}
  subscribe(listener) {} // 返回 unsubscribe；listener({ type: 'block-changed', changes })
}
```

- `setBlock` 调用 `world.setBlock()`，合并其 affected sections，调用 `scheduler.remeshSections()`，再广播变更。
- `setBlocks` 忽略世界边界外或当前未加载 column 的变更，以及“目标当前是基岩、请求把它改为其他方块”的破坏变更；按最后一个同坐标变更去重、再按 column 聚合。每个有效变更都写入该 column 的 `edits`（确保卸载、持久化与确定性重生正确），但每个受影响 column 仅递增一次版本号。它合并所有脏 section，对每个变更 column 及其 affected 邻 column 调用 `scheduler.enqueueLight()`，跳过同步快速网格，统一转 Worker REMESH。它是 TNT、MAG7 与未来批量工具的共享入口。
- 两个方法都返回 `{changes, affected, skipped}`；`changes` 的每项为 `{x,y,z,oldId,oldMeta,newId,newMeta}`。事件只携带同一份增量，不保存第二份世界状态。音频、粒子、未来实体可以订阅；事件不会进入 Worker，也不参与版本判定。
- 现有玩家挖/放改为调用此协调器，确保 M4 没有第二条写世界路径。`WorldData` 仍是 `blocks + meta + blockEntities` 的唯一权威，网格、光照与事件均为派生结果。

### 4.2 命中、武器状态和渲染职责

`src/player/weapons/` 分为三层：

1. `weapon-catalog.js`：只含数字和数组的静态配置；无 three、无 DOM。它定义冷却、曳光、模型 transform、MAG7 扫描参数与 `MAX_ACTIVE_TRACERS=32`；模型 transform 沿用 mc-lite 归一化模型后的值：手枪 `scale=[.09,.09,.09] position=[.3,-.85,-.4] rotation=[0,0,0]`，MAG7 `scale=[1.3,1.3,1.3] position=[.44,-.5,-.8] rotation=[0,-π/2,0]`，加特林 `scale=[.5,.5,.5] position=[.48,-.56,.6] rotation=[-π/2,-π/2,-π]`。加特林视图节点在应用绕局部 x 轴的枪管旋转前必须设 `rotation.order='YXZ'`，避免 mc-lite 已修复的欧拉万向锁。
2. `weapon-target-policy.js`：武器专属、无 three 的纯谓词模块；不把武器规则塞入通用 `BlockRegistry`。它通过注入的 `registry.nameOf(id)` 判断：`bedrock`、`end_stone`、`playground_block`、`playground_center_block` 对所有枪械不可破坏；`end_stone_bricks` 可破坏。DDA 已跳过水，故手枪/加特林不命中水；MAG7 体积扫描保留 mc-lite 语义，可把水作为候选并删除。将创造台两类方块也排除在 MAG7 外，是 M4 有意收紧的偏离：mc-lite 的 MAG7 批量过滤只排 `end_stone`/`bedrock`，而 M4 不允许武器破坏创造台基础方块。
3. `weapon-controller.js`：主线程玩法状态机。接收玩家提供的相机姿态、缓存的 DDA 命中、`WorldEditor` 和只读 `BlockQuery`（`getBlockId(x,y,z)` + `registry.nameOf(id)`）；处理切枪、冷却、持续射击、普通 hitscan 与 MAG7 的变更列表；返回纯效果事件（曳光/音效/后坐），不创建 three 对象。
4. `view-weapon.js` 与 `tracer-renderer.js`：只在主线程引入 three。前者把已加载模型克隆后挂到 camera；后者用一个固定 32 slot 的 `THREE.InstancedMesh` 渲染曳光，并通过实例颜色和矩阵区分普通枪/MAG7。池满时丢弃最旧的纯视觉曳光，绝不丢弃命中或世界编辑。该 InstancedMesh 是独立的短寿命视觉对象，不是地形 InstancedMesh、BatchedMesh 或第二份体素状态；二者销毁时从 scene/camera 移除并归还/释放资源。

MAG7 的纯扫描算法固定如下：从相机原点沿视线前向取 `d=1..10`、步长 `0.5`；每个距离在相机 right/up 基底上取 `i,j∈{-1,0,1}` 的 3×3 截面采样；坐标向下取整；先用世界坐标去重，再以 `floor((d-1)/2)` 作为距离组排序键。候选先经过 `weapon-target-policy`，之后才计入 40 上限，最后按距离组展平为一次 `WorldEditor.setBlocks()` 调用。这有意修正 mc-lite“基岩可占用 40 名额、但延迟删除时才过滤”的怪癖；M4 的 40 表示最多 40 个实际可破坏候选。

地形命中永远使用 `raycastVoxel()`。每帧保留至多一次主 DDA 结果，开火消费该结果及其 `dist`；将来实体系统提供 `EntityManager.raycast(origin, dir, maxDist)` 后，控制器只比较实体命中与体素命中的距离，取最近者。该扩展在 M6 才生效：M6 向冻结 catalog 增补 `entityDamage/entityRange`（手枪 `25/40`、加特林 `35/40`、MAG7 `999/10`），并以“近方块优先”定义遮挡；M4 本身不结算实体伤害。M4 没有 `THREE.Raycaster.intersectObjects()`，也不创建实体射线的临时兼容层。

视图模型采用“单个相机子节点”而非新增地形渲染通道、InstancedMesh 或 BatchedMesh。每次只有当前一把枪存在，模型缓存只保存只读模板，装备时 clone；世界体素继续由既有三通道 BatchedMesh 独占。这避免引入渲染态与游戏态双权威，也不污染 M3 的 draw-call 基线。

武器模型灯光：GLTFLoader 对 GLB 生成 `MeshPhysicalMaterial`（PBR，必须吃场景灯光），而 mc-heavy 全场景是 unlit 设计（体素 `MeshBasicNodeMaterial` 亮度烘焙在顶点 shade，ocean/rain/tracer/highlight 均不吃灯光），场景原本零灯光 → 枪体渲染为纯黑（实测探针：`lights=[]`，材质 baseColor 数据完好——建模颜色没丢在资源里，丢在渲染端没有光源）。mc-lite 的枪正常是因为其场景有灯（`Engine.js:194` AmbientLight + `Engine.js:168` DirectionalLight）。因此场景补 mc-lite 同款双灯：`AmbientLight(0xddeeff, 2.3)`（`Engine.js:194` 的 `1 × _ambientBoost=2.3`，WebGPURenderer TSL 管线间接漫射偏暗的经验补偿）+ `DirectionalLight(0xfffaf0, 3.2)` 方向 `[0,0.8,0.6]`（`Engine.js:168,161`）。手枪 `METAL` 材质 `metallicFactor` 缺省 = 1（金属 diffuse 为 0、全靠镜面反射），只给环境光金属件仍然发黑，方向光高光不可省。灯光只影响 PBR 材质（枪），unlit 材质一律不吃灯光 → 世界视觉零回归（像素 spec 验证）。平行光方向恒定、不跟随玩家——mc-lite 的光源跟随（`Game.js:556`）是为阴影投射服务，mc-heavy 不开 `castShadow`。mc-lite 的 moonLight(0.02) 与日夜风格的灯光调制不移植：mc-heavy 枪体灯光恒定，体素日夜调制走独立 uniform 体系（M2-6），互不耦合。

### 4.3 GLB 资产管线

M4 只支持仓库受控的 GLB 资源，路径固定为 `assets/models/weapons/`。从 mc-lite 复制并改名：

| M4 id | 来源 | 已测文件大小 | 特性 |
|---|---|---:|---|
| `pistol` | `silahful.glb` | 1,620,828 B | 3 primitives；可选 `KHR_materials_specular`/`KHR_materials_ior` |
| `mag7` | `mag7.glb` | 94,248 B | 3 meshes，内嵌 1 张图像 |
| `minigun` | `minigun.glb` | 32,884 B | 1 mesh，内嵌 1 张图像 |

加载器及其精确的 three r185.1 传递依赖从同一版本源码 vendoring 到 `vendor/three/addons/`，以既有 import map 的 `three/addons/` 前缀引用；`index.html` 已有该映射，M4 只创建 vendor 目录和文件，不修改 import map。不得 CDN、不得 npm 运行时解析、不得 Worker import。加载器在主线程启动后按需加载，失败时报告可识别的武器 id 与资源 URL，并让玩家保持徒手可玩。

资产检查在 CI/Playwright 前执行：仅允许 glTF 2.0 二进制容器、禁止外链 buffer/image、拒绝 `extensionsRequired` 中不在白名单的扩展、限制单文件大小和总大小。当前三件模型不使用 Draco、KTX2、动画或皮肤；因此 M4 不引入对应 decoder。手枪的两个可选材质扩展必须在真实 WebGPU Chromium 上通过加载及首帧渲染测试，否则在离线资产处理阶段降级为标准 PBR 材质，而不是在游戏循环里兜底。

`gun.gltf` 是 mc-lite 中未被玩家武器加载路径使用的简化 JSON，不进入 M4 资产清单。用户选择文件、OBJ/MTL、外链纹理和任意 GLTF 都属于后续“受限用户模型导入” Epic；该 Epic 另行设计尺寸上限、MIME/内容校验、资源释放和持久化策略。

### 4.4 输入、设置、音频与存档边界

- 徒手时左键保持现有挖掘；持枪时左键变为按下/抬起式射击，右键仍可放方块。手枪和加特林在按住时按各自冷却自动重复；MAG7 只在 `mousedown` 边沿、冷却结束时射出一发，按住不会重复。`KeyR` 循环徒手、手枪、MAG7、加特林，与 mc-lite 一致。
- 音频由小型主线程 `AudioManager` 统一预加载/播放；从 mc-lite `src/assets/sound/` 复制 `gun_load.mp3`、`gun_fire.mp3`、`mag7_fire.mp3`、`minigun_fire.mp3` 到 `assets/sounds/` 并提交入库。它不订阅 Worker 消息，也不把解码后的音频放进存档。首次 canvas `pointerdown` 或键盘动作调用 `audio.unlock()`，在用户手势内恢复 `AudioContext`；若浏览器仍拒绝播放，只记录一次效果请求并保持玩法继续。
- M4 暴露 `game.setGunBlockDamage(enabled)` 作为 HUD/自动化测试接入点；默认 `false`。M3 HUD 若已实现设置面板，可直接绑定该 API；没有设置面板也不阻塞 M4 的键盘可玩性。
- M4 不引入弹药或库存持久化。当前武器选择和破坏开关可在一次会话内维持；将来的玩家设置 schema 统一持久化时再迁移，避免为两个布尔值提前扩展不成熟的存档格式。

无头测试不依赖 pointer lock 或真实音频输出。M4 通过实际游戏 API 暴露 `window.__MC_GAME__.selectWeapon(id)`、`fireWeaponOnce()`、`setGunBlockDamage(enabled)` 与 `weaponDebugState()`；前两者走与键鼠完全相同的控制器路径，最后一个只返回 `{selectedId, cooldown, triggerHeld, shotsFired, activeTracers, lastEffect, viewLoaded, audioPlayRequests}`。`AudioManager` 同时暴露只读的播放请求计数，供测试验证效果事件，不以操作系统是否允许出声作为断言。

## 5. 任务划分与依赖

```text
M3 第一阶段性能报告（冻结基线）
  └── M4-0 世界编辑协调器 + 批量写入 + 事件
        ├── M4-1 本地 GLB 资产清单 + r185.1 加载器 + 音频
        └── M4-2 武器状态机 + DDA hitscan + 输入改造
              └── M4-3 视图模型/曳光渲染 + 三把枪联调与验收

未来 EntityManager ──> M4 控制器的 entity-raycast 适配点
未来炮塔/Projectile ──> 独立 Epic，不复用玩家 hitscan 为飞行弹丸
未来用户模型导入 ──> 独立 Epic，不复用 M4 的受控资产加载路径
```

M4-0 是唯一需要触及体素编辑调度的任务，也是未来 TNT/爆炸的共同底座。M4-1、M4-2 可以并列准备，但 M4-3 只在两者完成后合并；模型加载问题不会阻塞纯逻辑 hitscan 的单测。每个子任务都能独立回退和验收，避免将复杂模型、连射和世界批量编辑堆成一个大改动。

## 6. 验收标准

### 单元与集成

- 武器目录：三把枪的冷却、后坐、射程、曳光、视图模型 transform、32 条曳光池上限、MAG7 扫描参数和默认“不可破坏”配置固定。
- 世界编辑：单块写入、跨 column 批量写入、重复坐标去重、以基岩为目标的破坏变更过滤、每 column 一次版本递增、每块 edits 记录、合并 affected sections、`block-changed` 事件顺序正确；批量路径不走同步快速网格，并对改变 column/边界邻居入 light 队列。
- 命中：手枪/加特林的首个 DDA 方块阻挡与可选破坏正确；水不作为它们的命中；MAG7 的 3×3、0.5 步长、1–10 格扫描、距离组顺序、单发模式、无视开关、`end_stone`/基岩/创造台方块排除、`end_stone_bricks` 与水的候选语义均固定。MAG7 最多产生 40 个唯一、可破坏的变更且用一次 `setBlocks` 提交。
- 输入：徒手左键挖掘、持枪左键射击、右键放置、R 循环切枪互不回归。
- 资产：三件 GLB 可加载，缺失/非法 manifest 的错误可见且游戏继续可玩；所有模型销毁后不留 scene/camera 子节点。

### Playwright 与实机

- WebGPU Chromium 中三把枪均有可见第一人称模型、开火曳光和音效播放请求；MAG7 与普通枪的曳光色/粗细可区分。Playwright 经 `__MC_GAME__` API 驱动切枪与开火，不依赖 pointer lock。
- 视距 8、城市/水面/日夜完整场景下，空闲持枪和持续加特林分别采样帧率、draw call、对象池数量、世界编辑 p95。M3 已冻结基线只做参照，不修改其阈值；性能回退超过 10% 阻断 M4。
- 方块破坏连续 200 次与 MAG7 连续 20 次后，GEN/MESH/LIGHT 队列收敛，没有过期版本写回、悬挂曳光或不断增长的 three 对象。

## 7. 路线图更新原则

本设计获批后：

1. 不改动第一阶段 roadmap 中 M2/M3 的任务编号、范围或验收口径。
2. 在第一阶段 roadmap 的“后续阶段预留”处补充一行，链接到 M4 设计与计划。
3. 新建独立的 `docs/superpowers/plans/2026-08-23-m4-player-weapons.md`，以 M4-0 至 M4-3 编写 TDD 级实施步骤。
4. 将设计文档 §9 的“炮塔/子弹/丧尸”说明细化为：玩家 hitscan 武器先落在 M4；实体命中、炮塔弹丸仍后置。此修改不能反向把实体系统塞回 M4。

## 8. 风险与拒绝的方案

| 方案 | 结论 | 原因 |
|---|---|---|
| 将武器作为 M2 或 M3 子任务 | 拒绝 | 破坏已定义的第一阶段验收与性能冻结边界。 |
| 直接移植 mc-lite 的 `Gun`/`PlayerInteraction` | 拒绝 | 其地形命中依赖 `THREE.Raycaster` 和场景对象，违反 DDA 与单一 meshing 管线红线。 |
| 把玩家枪做成真正 `Projectile` | 拒绝 | mc-lite 玩家枪语义为 hitscan；引入实体生命周期、碰撞和持久化会无谓绑定炮塔/丧尸。 |
| 为 GLB 建通用用户导入器 | 拒绝 | 需要额外的安全、资源、材质和存档设计，不能作为现有三件受控资产的加载实现。 |
| 每把武器单独加载并在切枪时重新解析 | 拒绝 | 加载抖动与重复 GPU 资源；应缓存只读模板并 clone 当前视图模型。 |
| 保留 MAG7 的 5 块/50ms 定时器写入 | 拒绝 | 会产生跨帧、不可原子化的世界变更；改为一次批量写入，连锁视觉不作为 M4 必须保留的语义。 |
