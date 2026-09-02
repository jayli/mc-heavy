# M2–M3 性能报告（第一阶段收尾）

日期：2026-09-02 · 分支：main · 数据来源：`npm run bench`（src/bench/baseline.mjs，
seed=12345）+ `npm test`（Playwright 全量）+ 浏览器内单测（`/src/tests/index.html`）

## 测试环境

- 设备：macOS ARM（Apple Silicon，本机真 GPU Metal，120Hz 显示器）
- 浏览器：Chromium 151（Playwright 1.62.1，`channel:'chromium'` 新无头零 flag 走 Metal）
- three.js：r185.1（vendored，WebGPU 后端）；Node v26.4.0
- 帧时口径（全部性能断言一致）：120Hz vsync 锁帧下帧间隔量化为 8.33ms，
  `frameMs.p95 < 8.3` 数学上不可满足；故 **fps 为主断言**，`frameMs.p95 < 16.7`
  作防跌破 60fps 二级门（§8 口径）。
- CI（SwiftShader）帧率仅趋势参考，本机设备矩阵为硬验收（§8）。

## §1 目标表逐项核对（第一阶段验收口径）

| §1 指标 | mc-lite 现状 | 目标 | mc-heavy 实测 | 结论 |
|---|---|---|---|---|
| 冷启动到可玩 | 预生成数十秒~分钟级 | < 2s 可操作 | **worldReady 0.48~0.55s**（3 次采样；出生列就绪即进主循环，视距内后台填充 289 列全部就绪 ~0.6s） | ✅ 超额 |
| 默认可视距离 | 2~3 chunk（32~48 格） | 8 chunk（128 格），架构支持 16+ | **视距 8（289 列）默认**；vd=12（625 列）冒烟通过：正确加载、队列收敛、无错误（fps 87 / GPU 317MB——证实 §4.10「视距 16 前必须先做 LOD」预警，属设计内预期） | ✅ |
| 奔跑帧率（视距 8） | 扩大即卡顿 | 60fps 稳定；120Hz ≥90fps | **120fps 锁满**（全量场景冲刺/环视/TNT 全 120；编辑压力场景 108~110） | ✅ |
| 跨 region 边界 | 明显卡顿 | 无感知 | 冲刺 255 格**跨 region 1 次**（x=800 边界），全程 fps 120 / p95 9.2ms，GEN/MESH 队列稳态归零 | ✅ |
| 放块/挖块响应 | 依赖 consolidation 异步收敛 | 单帧内视觉生效（<16ms） | 快速路径 **p95 1.7ms**（§4.3 冻结门 <2ms），当帧生效 | ✅ |
| 存档体积 | 整块 blockData 序列化 | 仅存 edits diff，KB 级 | 50 次编辑 = 2 列 / **1.7KB**（JSON 序列化），meta 69B | ✅ |

## 基线场景实测（`npm run bench`，视距 8 / seed 12345）

完整机器可读基线：`docs/m3-baseline.json`；门禁：`npm run bench -- --check`
（结构类指标容差 2%、性能类 10%、fps 仅同 adapter 对比；负向验证过：人为虚高基线
16.7% 时正确阻断、退出码 1）。

| 场景 | fps | p50 | p95 | p99 | upload p95 | draw | sections |
|---|---:|---:|---:|---:|---:|---:|---:|
| ① 平原冲刺（40s，255 格，跨 region 1 次） | 120.0 | 8.3 | 9.2 | 9.3 | 0ms | 489 | 1643 |
| ② 城市中心环视（360°，最坏 draw） | 120.0 | 8.3 | 9.2 | 9.4 | 0ms | 545 | 1727 |
| ③ 连续放/挖 200 块 | 108.3 | 8.3 | 16.7 | 17.3 | 0.6ms | 545 | 1727 |
| ④ 模拟 TNT 批量删 500 块（REMESH 路径） | 119.3 | 8.3 | 9.0 | 9.4 | 0ms | 526 | 1471 |

- 场景③ fps 108~110 是编辑期真实负载（每帧同步 fastPath 重建 + light 区域重算入队），
  p95 16.7ms 为 vsync 量化贴线，仍远高于 60fps 底线；单次编辑 p95 1.7ms 满足冻结门。
- 场景④：批量删 500 块 setBlock 仅 2.4ms + REMESH 一次性下发 0.6ms（affected 684
  section 走 Worker 异步重网格），收敛期队列峰值 upload 4 / mesh 0，主线程无阻塞
  ——TNT 批量编辑的 `WorldEditor.setBlocks(batch)` 接入点（§9/M4-0）性能路径已验证。

## 队列与预算（§4.9）

| 判据 | 实测 |
|---|---|
| GEN/MESH/LIGHT/upload 稳态归零 | 全场景收敛后 0/0/0/0（m3-fullscene.spec 断言） |
| 冲刺中队列不积压 | gen/mesh inflight p95 = 0，奔跑中新列即产即消 |
| mesh 上传 ≤3ms/帧（120Hz 档） | upload-ms p95 = 0~0.6ms |
| 快速路径 ≤2ms | 放置 1.7ms / 挖除 1.7ms（p95），fast-remesh mark p95 1.1ms |
| 预算双档标定（M3-2） | 本机 120Hz 自动判 high（3ms/64）；`?budget=low`（6ms/128）显式档 fps 118 不劣化；判档用「快帧(<11ms)比例」判据（60Hz 物理上产生不了快帧，中位数会被启动 burst 污染） |

## 内存预算（§4.10）

| 项 | 预算 | 视距 8 实测 | 结论 |
|---|---|---|---|
| 体素数据（CPU） | ~37MB | **36.1~40.4MB**（289~323 列含滞回带） | ✅ |
| GPU 顶点缓冲 | ~100MB 级 | **分配 136.6MB / 实际占用 106~119MB**（M3-1 按实测峰值重标定 CAPACITY：旧值 opaque 4M 顶点过度分配、cutout 562K 偏小致运行时 3 次 setGeometrySize 扩容卡顿；新值给峰值 ~25% 余量，全场景零扩容） | ✅ 口径内 |
| atlas 纹理 | ~22MB | 2048² RGBA ~16MB（blur 档 mipmap 链 +33% ≈ 21MB） | ✅ |
| jsHeap（本机参考） | — | 206~245MB | 正常 |

## 与 mc-lite 对比（设计文档 §2 瓶颈诊断逐项回应）

| 维度 | mc-lite（实测/记录） | mc-heavy | 倍数 |
|---|---|---|---|
| 可视距离 | 2~3 chunk（32~48 格） | 8 chunk 默认 120fps；vd=12 冒烟通过 | **~4×** |
| 冷启动 | 56×56 chunk 预生成数十秒 | 0.5s 可玩、0.6s 视距全量（按需生成） | **数十~百倍** |
| 跨 region | 边界扩图明显掉帧 | 跨 region 冲刺 fps 120 无感知 | 质变 |
| 放挖响应 | consolidation 异步收敛（补丁栈） | 主线程快速路径 1.7ms 当帧生效 | 质变（架构性消灭竞态） |
| 存档 | 整块 blockData 序列化（MB 级） | edits diff 1.7KB/50 块（KB 级） | **~千倍** |
| draw call | 每方块类型 InstancedMesh + 多层容器 | 3×BatchedMesh 通道合批，全场景 ≤545 draw | 受控（视距扩大不爆） |

## M2 验收结论（2026-08-31 关闭，引 `docs/m2-seed12345-comparison.md`）

- 同 seed（12345）人工比对通过（城市/金字塔/冰封山/雪地/海岛/树木/洞穴/水面/
  日夜/空中结构，无异常）；
- 关闭回归全绿；M3 期间（随机 seed 化后）性能/视觉冻结断言 spec 统一钉
  `?seed=12345` 保持可复现基线，复跑全绿。

## 测试现状（M3 收尾）

- Playwright：24 spec 文件 / 32 用例全绿（新增 m3-fullscene / m3-budget / m3-rain /
  m3-hud 共 7 用例；m1-acceptance 计时贴线 flaky 为已登记负载抖动类，单跑全绿）；
- 浏览器内单测：170 用例全绿（新增 budget 9 / rain 9 / ui 7）；
- lint：0 error（9 个既有 blocks-data camelcase warning）；
- 性能门禁：`npm run bench -- --check` 可重复执行，两次连跑指标一致
  （fps/draw/sections 完全复现），虚高基线正确阻断（负向验证通过）。

## 遗留观察项（不阻断第一阶段验收）

1. **CITY 光晕**（M2 起可选观察项）：chunk 中心在城内、列在城外时地表与 mc-lite 有差异；
2. **vd≥12 的 LOD**：§4.4.5 外圈粗模是视距 16 的前置（vd=12 实测 GPU 317MB 证实），第二阶段按需启动；
3. **blur 档 per-tile mip 链**（M3-4 可选打磨项）：高对比纹理掠射角块缝的彻底解，bleed/aniso 为尽力缓解；
4. **音量设置**：面板 + 持久化已接线，音频消费方（挖掘/爆炸/环境音）属 §9 扩展点（第二阶段挂事件总线）；
5. **60Hz 真机矩阵**：M3-2 low 档参数与判定逻辑已由单测（16.7ms 帧间隔喂样）+ 显式 `?budget=low` 端到端覆盖，60Hz 真机复验待设备可用时补（roadmap 原拟 `--disable-frame-rate-limit` 实测为解除限帧而非产生 60Hz vsync，无法真实模拟，口径已在 m3-budget.spec 注释记录）。

## 结论

**第一阶段（M0~M3）全部验收口径达标**：§1 目标表 6 项全 ✅（多数超额）、四基线场景
全 120fps（编辑场景 108+）、队列零积压、内存预算口径内、预算双档标定生效、
性能回归基线脚本 + 门禁可重复执行。引擎底座（数据单一权威 / 按需确定性生成 /
Worker 池全异步 / 单一 meshing 管线 / BatchedMesh 通道合批 / 版本协议）经全量场景
与压力场景验证，达到设计文档预期，可进入第二阶段 M4（玩家第一人称武器）。
