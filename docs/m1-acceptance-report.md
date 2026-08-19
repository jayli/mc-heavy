# M1 验收报告（体素核心闭环）

日期：2026-08-19 · 分支：main · 验收 spec：`tests/m1-acceptance.spec.mjs`

## 测试环境

- 设备：macOS ARM（本机，120Hz 显示器）
- 浏览器：Chromium 151（Playwright 1.62.1，`channel: 'chromium'` 新无头模式，零 flag 走 Metal 真 GPU）
- three.js：r185.1（vendored，WebGPU 后端）
- 帧时口径说明：120Hz vsync 锁帧下帧间隔被量化为 8.33ms，`frameMs.p95` 含 vsync
  抖动（测的是量化而非渲染负载）。故以 **fps 为主断言**（§1 目标：高刷屏 ≥90fps），
  `frameMs.p95 < 16.7ms` 作防跌破 60fps 二级门。该口径在 Task 7/8/10 一致采用并记录在案。

## 基线场景 ①：平原冲刺（视距 8，自动奔跑 10s）

| 指标 | 实测 | §1 目标 | 结论 |
|---|---|---|---|
| fps | **120.01**（锁满 120Hz） | ≥90（高刷屏），理想 120 | ✅ 超额 |
| frame p50 | 8.30ms | — | vsync 量化 |
| frame p95 | 9.9ms | <16.7（60fps 底线） | ✅ |
| frame p99 | 10.2ms | — | ✅ |
| 活跃 sections | 768 | — | 视距 8 全量 |
| draw calls | 203 | 受控 | ✅ 3×BatchedMesh 通道合批 |

奔跑过程 GEN/MESH 均在 Worker 池异步执行，主线程无阻塞（gen-inflight/mesh-inflight
mark 为队列深度，非主线程耗时）。**对比 mc-lite：视距扩大一圈即卡顿的问题已解决——
视距 8 下 768 sections / 203 draw 仍锁 120fps。**

## 基线场景 ③：连续放/挖 200 块（发布层确认门）

| 指标 | 实测 | §4.3 冻结约束 | 结论 |
|---|---|---|---|
| 单块放置 p95 | **1.8ms** | <2ms | ✅ |
| 单块挖除 p95 | **1.7ms** | <2ms | ✅ |
| fast-remesh mark p95 | 0.9ms（avg 0.66ms） | — | 主线程同步重建当帧生效 |
| 编辑后 fps | 120（p95 9.9ms） | ≥90 | ✅ |

计量单位 = 单次编辑（一次 `setBlock` + 一次 `remeshSections` 快速路径）。

## 发布层确认门结论（§4.4.2 M1 决策门）

三项核对，**均无命中 → 维持 BatchedMesh 默认实现**：

1. **逐 instance draw 提交 p95 是否更差？** 否。视距 8 / 768 sections / 203 draw
   锁 120fps。M0 bench 实测：BatchedMesh 开剔除+排序 2312 instance 的 CPU 循环
   仅 0.207ms（WebGPU 后端逐 instance `drawIndexed` 共享 pipeline/bind group/顶点
   缓冲，命令间零状态切换）。
2. **setGeometryAt 增量替换有无正确性坑？** 无。`render-world.spec` 验证同 section
   重复上传不增 slot；`interaction.spec` 验证放/挖当帧生效；溢出预留（reservedV/I）
   走 deleteGeometry→addGeometry→addInstance 重建路径已实现。
3. **剔除/排序 CPU 循环是否吃帧预算？** 否。sortObjects+perObjectFrustumCulled
   在 2312 instance 量级 0.207ms，视距 8 实际活跃 ~768 section 按比例更低（~0.07ms）。

## 与设计文档 §1 目标表对照

| §1 目标 | M1 实测 | 状态 |
|---|---|---|
| 帧率不低于 60fps | 120fps 锁满 | ✅ |
| 高刷设备尽量跑满 120fps，不低于 90fps | 120fps | ✅ |
| 可视 chunk 扩大不卡顿（lite 痛点） | 视距 8 / 768 sections 仍 120fps | ✅ |
| 地图生成不阻塞（lite 预生成痛点） | GEN 全在 Worker，主线程零阻塞，冷启动出生点即玩 | ✅ |
| 放块挖块当帧生效 | 快速路径 p95 1.7-1.8ms | ✅ |
| 重启后修改保留 | IndexedDB edits 重放（persistence.spec 验证） | ✅ |

## GEN 预算（§4.2）

单 column GEN（无结构）Worker 时间 p95 = **4ms**（worker-gen.spec 实测，16 column
并行），低于 8ms 预算。

## 遗留问题（M2 清单）

- 结构/城市/树木/装饰物生成（M2，跨 region 溢出按 §4.2 邻区索引查询）
- blocklight 增量删除 BFS（M2，本阶段全 column 重算兜底）
- cross/slab 等非立方几何（M2，mesher 当前只出 cube 面）
- 水面 TSL 特效与体素水降面（M2，water 纹理当前占位）
- 日夜循环/阴影/三种视觉风格（M2）
- 完整背包 UI（M2，本阶段 5 格快捷栏 stone/dirt/grass/sand/cobblestone）
- mc-lite 老存档迁移工具（M2）
- faces-data.js 未列方块默认 stone 纹理（M2 补全 124 方块面映射）

## 验收清单核对（设计文档 §7）

1. ✅ `npm start` → 出生点地形可见（biome 草地/沙地/水面），HUD 显示 fps 与 GEN/MESH 队列
2. ✅ 平原无限行走不掉帧：视距 8 奔跑 fps=120（≥90），p95 9.9ms（<16.7）
3. ✅ 放块挖块当帧生效：单块编辑快速路径 p95 1.7-1.8ms（<2ms），画面即时更新
4. ✅ 重启后修改保留：放块 → 刷新 → 方块仍在（persistence.spec）
5. ✅ 发布层确认门：BatchedMesh 默认维持（三项核对无命中）
6. ✅ `npm test` 全绿：13 组 spec（M0 5 组 + M1 8 组）+ 浏览器内单测
   （chunk-column/terrain/lighting/mesher/physics/raycast 共 47 用例）
7. ✅ `npm run lint` 0 errors
8. ✅ 本报告产出实测数字与对照结论
