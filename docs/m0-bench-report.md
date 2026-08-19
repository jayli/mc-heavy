# M0 WebGPU 发布路径语义实测报告

> 产出：设计文档 §7 M0 验收项 ⑤。基准页 `src/bench/webgpu-publish.html`，
> 验收 spec `tests/webgpu-publish.spec.mjs`（冻结断言，未修改）。

## 测试环境

- 设备：macOS ARM（Apple Silicon），本机真 GPU（Metal），非 SwiftShader
- 浏览器：Chromium（playwright 1.62.1，channel:'chromium' 零 flag 走 Metal）
- three.js：r185.1（CDN jsdelivr，three.webgpu.js）
- 日期：2026-08-19

## 实测结果（全部对齐设计文档 v1.7 冻结断言）

| 用例 | 冻结断言 | 实测 | 结论 |
|---|---|---|---|
| 3-group 单 Mesh | drawCalls === 3 | **3** | ✓ |
| 24-group 单 Mesh | drawCalls === 24 | **24** | ✓ |
| BatchedMesh 2312 instance（关剔除/排序） | drawCalls === 2312 | **2312** | ✓ |
| BatchedMesh 2312 instance（开剔除+排序） | drawCalls === 2312 | **2312** | ✓ |
| BatchedMesh culled CPU 循环 | < 4ms/帧（本地硬门槛） | **0.197ms** | ✓ |
| setGeometryAt 快路径（1000 面/4000 顶点） | < 2ms（硬门槛） | **0.0295ms** | ✓ |

## 关键实测发现：WebGPU 后端每帧 +1 RTT 输出 pass

首轮实测所有 drawCalls 比冻结断言**系统性 +1**（4/25/2313/2313）。探针定位根因：

- 空场景（无任何 mesh）每帧 `drawCalls=1, triangles=1`——一个全屏三角形；
- 来源：r185.1 WebGPURenderer 的 **RTT 输出 pass**（tone mapping + 色彩空间转换，
  源码 `_quadMesh.render`，three.webgpu.js 38317-38418），与场景内容、发布路径无关；
- `renderer.toneMapping = NoToneMapping` 单独设置**不能**消除（色彩空间转换仍在）；
  需 `NoToneMapping + outputColorSpace = LinearSRGBColorSpace` 同时设置才消除。

处理：bench 渲染器按上述组合隔离场景 draw，使测量精确对齐断言语义（断言针对发布路径
draw 分发，不含后处理）。冻结断言本身一字未改。游戏运行时保留默认 tone mapping /
色彩空间（视觉正确性优先），该 +1 为每帧常数，不影响 draw call 量级分析。

## 与设计文档 v1.7 预期的对照结论

1. **material 数组逐 group 发 draw**（Renderer.js:3149-3158）：3-group → 3 draw、
   24-group → 24 draw，逐 group 线性，证实 v1.1 修订的「24-group 陷阱」判断。
2. **WebGPU 后端 BatchedMesh 非 multi-draw**（WebGPUBackend.js:1806-1824）：2312 个
   可见 instance → 2312 次 drawIndexed，与 v1.6 源码核验定稿一致。开剔除+排序后命令数
   不变（全部 instance 可见），CPU 循环 0.197ms/帧，远低于 4ms 门槛——per-instance
   剔除/排序在 120fps 预算内无风险。
3. **setGeometryAt 快路径**：flat 属性 `array.set` 拷贝 1000 面 section 平均 0.0295ms，
   约为 2ms 门槛的 1.5%，单块编辑当帧生效的预算充足。

## 对 M1 的输入

- 发布层默认实现维持 **BatchedMesh**（设计文档 §4.4.2），实测确认其 draw 命令数与
  column 3-group 候选同量级，但单命令零状态切换 + 剔除/排序/增量更新官方内置；
- 视距 8 下 2312 section 的 per-instance CPU 循环（0.2ms）与 setGeometryAt 拷贝
  （0.03ms）均非瓶颈，M1 瓶颈预期在 GEN/MESH 队列与顶点上传；
- 运行时不要关 tone mapping / 色彩空间（会改变画面观感），接受每帧 +1 常数 draw。
