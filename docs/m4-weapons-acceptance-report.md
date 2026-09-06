# M4 玩家武器系统验收报告

> **状态：** 已实施（2026-09-05）
> **规格：** `docs/superpowers/specs/2026-08-23-m4-player-weapons-design.md`
> **计划：** `docs/superpowers/plans/2026-08-23-m4-player-weapons.md`
> **基线参照：** `docs/m3-baseline.md`（M3 冻结基线，只参照不修改其阈值）

## 1. 环境

| 项 | 值 |
|---|---|
| 日期 | 2026-09-05 |
| 设备 | macOS ARM（本机设备矩阵，硬验收口径） |
| WebGPU adapter | apple / metal-3（`channel:'chromium'` 零 flag） |
| 浏览器 | Playwright 1.62.1 / Chromium 151（headless，真 GPU） |
| Node | v26.4.0 |
| three | r185.1（本地 `vendor/three/`，GLTFLoader 同版本 vendoring） |
| 视距 | 8（289 column） |

## 2. 性能（视距 8，持续加特林 100 发）

口径：fps 为主断言，`frameMs.p95<16.7` 作防跌破 60fps 二级门（120Hz vsync 锁帧，
见 CLAUDE.md「性能验收口径」）。draw call 门：minigun 不高于徒手 +2。

| 阶段 | fps | p95(ms) | draw | 备注 |
|---|---:|---:|---:|---|
| before（徒手稳态） | 119.99 | 10.0 | 363 | 289 column / 2312 section 全收敛后沉淀 5s |
| during（minigun 连射 100 发） | 119.97 | 9.9 | 363 | activeTracers=1，viewLoaded=true，audio 请求 57 |
| after（队列收敛） | 119.98 | 9.9 | 363 | gen/mesh/light/upload 全 0 |

- **draw 增量 = 0（≤ +2 门）**：视图模型 1 个相机子节点 + 曳光单个 InstancedMesh，
  未新增地形渲染通道，不污染 M3 draw-call 基线。
- **fps 回退 = (119.99 − 119.98) / 119.99 ≈ 0.01%**，远低于 10% 阻断线。
- 持枪连射期间帧率锁定 120fps，无掉帧。

## 3. 真实世界编辑压力（200 次普通枪 + 20 次 MAG7）

| 指标 | 实测 | 门 |
|---|---:|---|
| 普通枪 world-edit p95 | **0.8ms** | <2ms（既有单块编辑冻结口径）✅ |
| MAG7 批量提交 p95 | 0.6ms | 不新增未冻结阈值（仅记录） |
| 普通枪 200 发全部删空（pistolAir） | true | ✅ |
| MAG7 20 发全部删空（mag7Air，开关关闭仍破坏） | true | ✅ |
| 权威 column 版本 | 600 | — |
| 已发布 section 版本 | 600 | **== 权威版本** ✅（过期 mesh 丢弃协议有效） |
| 收敛后 scene child 数 | 7（before 7） | 无增长 ✅ |
| 收敛后 camera child 数 | 2（before 2） | 无增长 ✅ |
| 收敛后 activeTracers | 0 | 无悬挂曳光 ✅ |
| 收敛后队列（gen/mesh/meshQueued/pendingMesh/light/lightQueued/upload） | 全 0 | 无永久积压 ✅ |

**结论**：200 次单块编辑 + 20 次批量编辑后，目标 section 的已发布版本等于权威 column
版本（覆盖 `_onMeshResult()` 与 `_processUploadQueue()` 的过期结果丢弃协议），无 three
对象增长、无悬挂曳光、队列全部收敛。

## 4. 相对 M3 冻结基线（`npm run bench -- --check`）

```
[bench] gpu: apple/metal-3
[bench] ① 平原冲刺:        fps=120.01 p95=10   draw=490 (42s)
[bench] ② 城市中心环视:     fps=120.04 p95=10   draw=546 (9s)
[bench] ③ 连续放/挖 200 块: fps=111.43 p95=16.7 draw=546 (7s)
[bench] ④ 模拟 TNT 批量删:  fps=119.37 p95=9.8  draw=527 (5s)
[bench] --check 通过（无显著回退）
```

四场景 fps/p95/draw 与 M3 基线（120.02 / 120 / 108.33 / 119.28）持平，无回退 >10%。
M4 的武器渲染层（视图模型 + 曳光 + 音频）只在持枪时产生开销，未触及体素 meshing/
光照/调度热路径，故 M3 冻结基线不受影响。

## 5. 门禁命令输出摘要

| 命令 | 结果 |
|---|---|
| `npm run validate:weapon-assets` | 3 件受控 GLB 通过（pistol 1,620,828B / mag7 94,248B / minigun 32,884B；无外链、无 extensionsRequired、无 Draco/KTX2/动画/皮肤） |
| `npm test`（全量 56 用例） | **56 passed**（含 M4 新增 7 spec：world-editor / weapons-logic / weapon-assets / weapon-view / weapons / weapons-performance / weapons-world-edit；weapon-view 含交付后修正的曳光冻结 + 武器灯光 2 用例） |
| `npm run lint` | 0 error（9 个既有 camelcase warning，非本次引入） |
| `npm run check`（arch+data+lint） | 通过 |
| `npm run bench -- --check` | 通过（无显著回退） |
| DDA 红线检索 `rg "Raycaster\|intersectObjects" src/player/weapons` | 无命中 |

## 6. 交付清单

- **M4-0** `WorldEditor`（`src/core/world-editor.js`）：单块/批量原子写入 + 每 column 一次
  版本递增 + 逐格 edits + `block-changed` 事件；`WorldData.setBlocks()` 批量入口。
- **武器纯逻辑层**（`src/player/weapons/`）：`weapon-catalog`（三枪参数递归冻结）/
  `weapon-target-policy`（免疫名单）/ `mag7-pattern`（3×3 扫描先过滤再计 40）/
  `weapon-controller`（DDA hitscan 状态机，无 three）。
- **资产管线**：3 件受控 GLB + 4 个音效 + `vendor/three/addons/` GLTFLoader r185.1 闭包 +
  `tools/validate-weapon-assets.mjs`。
- **渲染层**（`src/render/`）：`weapon-model-loader`（模板缓存 + clone）/ `audio-manager`
  （手势解锁 + 播放请求计数）/ `view-weapon`（相机子节点 + YXZ 枪管旋转）/
  `tracer-renderer`（单 InstancedMesh 32 slot 池）。
- **装配**：Player 挖放迁移到 `editor.setBlock`（保留 M3.2 朝向分支）；Game 公开 API
  `selectWeapon/fireWeaponOnce/setGunBlockDamage/weaponDebugState`。
- **只读诊断**：`Scheduler.stats()` 队列观测值 + `RenderWorld.getSectionVersion()`。

## 7. 有意偏离 mc-lite（已在规格 §3 记录）

1. MAG7 候选一次 `setBlocks()` 原子提交，取代 mc-lite 的 5 块/50ms `setTimeout` 分批
   （连锁视觉不作为 M4 必须保留语义）。
2. MAG7 的 40 上限表示「最多 40 个实际可破坏候选」（先过滤再计数），修正 mc-lite
   「基岩可占 40 名额、延迟删除时才过滤」的怪癖。
3. 创造台两类方块（`playground_block`/`playground_center_block`）也排除在 MAG7 外
   （mc-lite 只排 `end_stone`/`bedrock`）——不允许武器破坏创造台基础方块。
4. **曳光起点世界空间冻结**（2026-09-05 交付后修正，v1.33）：mc-lite 每帧以当前相机基底
   重算曳光起点（相机空间起点 + 世界空间终点的混合坐标系），快速转镜头时弹道看上去歪斜
   （用户实玩反馈，mc-lite 同款问题）。修正为起点/终点都在开火瞬间冻结在世界空间——
   曳光 = 子弹真实弹道残影，镜头移动时纹丝不动。单测钉住「两个相机基底下实例矩阵位置
   不变」（RED `moved=51` → GREEN `<1e-6`）；像素实测镜头甩 90° 再转回，投影差异 0.027%
   （复原）vs 甩开时 57.28%（投影移动），世界空间语义确认。
5. **武器灯光**（2026-09-05 交付后修正，v1.34）：GLTFLoader 对 GLB 生成
   `MeshPhysicalMaterial`（PBR 吃灯光），而 mc-heavy 全场景是 unlit 设计（体素亮度烘焙在
   顶点 shade）且场景原本零灯光 → 枪体渲染为纯黑（用户实玩反馈；诊断探针实测
   `lights=[]`、材质 baseColor 数据完好——建模颜色没丢在资源里，丢在渲染端没有光源）。
   补 mc-lite 同款双灯：`AmbientLight(0xddeeff, 2.3)`（Engine.js:194 的 1×_ambientBoost）
   + `DirectionalLight(0xfffaf0, 3.2)` 方向 `[0,0.8,0.6]`（Engine.js:168,161）；手枪 METAL
   材质 metallicFactor=1（金属 diffuse 为 0），方向光高光不可省。灯光只影响 PBR 材质（枪），
   unlit 材质一律不吃灯光。RED（`lights=[]` 断言失败）→ GREEN；像素实测（差分口径：徒手 vs
   持枪截图差分 = 枪体覆盖处）修复后 pistol avgLum=65.0 / mag7=105.6 / minigun=92.3，
   迷彩绿贴图色与金属高光恢复。世界视觉零回归：8 个视觉 spec（render-terrain/water×2/
   ao×2/city/sky/daynight）全绿；对照实验（灯光移除/恢复两侧连跑）证明全量跑的
   m1-acceptance/m3-2 偶发失败与灯光无关（两侧失败率分布相同，为既有计时/负载 flaky）。
6. **MAG7 曳光终点恒在准心轴上**（2026-09-07 交付后修正，v1.36）：原实现把曳光终点设为
   扫描候选的第一个块中心，而 MAG7 是 right/up 基底上 `i,j∈{-1,0,1}` 的 3×3 体积扫描，
   首个候选常在准心轴之外（±1 格）→ 准心未瞄到方块、射界内击中邻格时，曳光从枪口斜射向
   旁边那块被击中的方块，与枪管方向不对齐（用户实玩反馈；隔离复现实测偏离准心轴 45°）。
   **这不是有意偏离，是移植偏差**：mc-lite 的 MAG7 曳光终点来自准心中心射线命中点
   （`Player.js:781-783` 的 `raycaster.setFromCamera(this.center)` + `far=10` → `Gun.onFire`），
   本来就在准心轴上。修正为 `end = origin + forward * min(target.dist ?? 10, 10)`：终点距离
   = 准心命中距离钳到扫描范围上限（主 DDA 的 REACH=40 远超 MAG7 的 1~10 格扫描范围），
   无命中取上限；上限派生自 catalog `scan.max`，不另写字面量。单测钉住不变式
   「终点在准心基底上的 right/up 分量恒为 0」三种场景（邻格有方块无准心命中 / 准心命中 /
   命中超出扫描范围），RED 3 失败 → GREEN 299 全绿；两个变量分别负向验证（改回候选中心
   终点 → 3 失败；去掉钳制 → 钳制断言 FAIL `Expected 10, got 25`）。
   M4 plan Task 4 Step 4 的错误口径（「用第一个距离组的中心候选作为效果终点」）已同步勘误。
