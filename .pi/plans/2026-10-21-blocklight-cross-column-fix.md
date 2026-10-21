# blocklight 跨 column 边界修复

> 日期：2026-10-21 ｜ Tier：1（纯函数算法 + 调度协议）｜ 触发：用户实玩报告「灯光有边界」

## 1. 现象

用户报告：放置灯具后，照明区域有一条笔直边界；**紧挨该边界再放一盏灯，光又能跨过去**。
提供两张截图 `/Users/bachi/ttt/bug/灯光有边界.png` 与 `灯光有边界_跨过了边界.png`。

## 2. 复现（真游戏页实测）

`?vd=8&seed=12345&style=noon&weather=clear`，把 glowstone 放在 column 中心 `(lx=8, lz=8)` 的悬空位置：

```
+X 方向逐格 blocklight：15,14,13,12,11,10,9,8,0,0,0,0,0,0,0,0,0,0,0
                                      ↑ 跨过 column 边界（距光源 8 格）即归零
四邻居 column 的 blocklight 非零格数：+X 0 / −X 0 / +Z 0 / −Z 0
放灯后 scheduler 实际入队的 column 清单：只有 ['17,7']（光源自己那一列）
```

边界就是 column（16×16）边界。用户观察到的「贴边放灯就能过去」也有解释：编辑格贴边时
`WorldData._affectedFor` 会把邻居 column 一并列进 `affected`，`remeshSections` 于是对邻居也调了
`enqueueLight` —— 邻居因此**碰巧**有了自己的 task。

结构性光源（存档/房屋里的 glowstone 等）同样受影响：实测 43 个发光方块，跨列邻居格有
**126/134** 是 0（应为 `15 - hop`）。

## 3. 根因（两处独立缺陷，都属「区域语义」）

### ① 重算区域缺了对角邻居 —— `computeBlocklightRegion` / `computeSkylightRegion` 的 offsets

现实现只取「中心 + 4 个**正交**邻居」共 5 列。blocklight 强度 15、每格 −1、最远照 **14 格**；
column 边长 16。于是：

| 偏移 | 最近格距中心列边缘 | 是否在 14 格射程内 |
|---|---|---|
| 正交 (±1, 0) / (0, ±1) | 1 格 | ✅ 必须参与 |
| **对角 (±1, ±1)** | **2 格** | ✅ **必须参与（当前漏了）** |
| 隔列 (±2, 0) 等 | 17 格 | ❌ 永远贡献 0 |

正确区域恰好是 **3×3**。plus-5 不充分，「5×5」则是白算（多算 16 列、多拷 16 份 blocks）。

**严格对照**：自写「全量参考 BFS」（扫整个宽世界、无区域截断）作真值，120~200 组随机世界
（8 灯 + 60 障碍，确定性 PRNG）：

| 区域 | 与全量真值的最大差 | 不一致格数 |
|---|---|---|
| 现状 plus-5 | **10 级** | **982** |
| 3×3 | **0** | 0 |
| 5×5 | 0 | 0 |

`computeSkylightRegion` 用同一份 offsets，对**它**同样不充分（同为 14 格射程）；第一阶段
skylight 恒 15、水平 BFS 是 no-op 才没暴露 —— 后续启用阳光遮挡会立刻犯同一个错。

### ② 入队范围 = 写回范围，但两者不该相等

`_onLightResult` 的写回协议是「每列只由以它为中心的 task 写回」（v1.8 的正确设计，**必须保留**：
3×3 只对中心列精确，对偏移 ±1 的列会截断）。真正的缺口在**入队**：`remeshSections` 只对编辑
所在列调 `enqueueLight(cx, cz)`，于是灯的邻居列从来没有自己的 task → 它们的 light 永远停在
GEN 时那个单列截断值（0）。

### ③ 连带：在途结果的输入已过期

邻居列的 `version` 没变（只有放灯那列变了），在途旧 task 回包会被照单接收 → 用「放灯前」的
blocks 算出的 light 覆盖回去。需要把版本校验从「查中心列」扩到「查整个 region 的输入列」。

## 4. 方案

### 4.1 `src/mesh/lighting.js`

- 新增导出 `LIGHT_REGION_OFFSETS`（3×3，冻结的 coords 数组），
  `computeBlocklightRegion` / `computeSkylightRegion` / `recomputeLight` 统一消费它。
- 注释写清上述推导（14 格射程 ⇒ 只相邻列可达、对角必须在内、隔列必为 0），替换现有
  「光泄漏过界」的含糊表述。
- `recomputeLight` 的返回 keys 同步改为 3×3 内已存在的列。

### 4.2 `src/core/scheduler.js`

1. **`enqueueLight(cx, cz)` 语义定为「这一列的光照输入变了」→ 入队 3×3 内已就绪的列**
   （未加载的列不入，避免 `_lightQueue` 无界堆积；它们由第 2 条兜住）。
   同时保留「column 必须 ready 才入队」的既有门控，并只对中心列做 ready 判定（邻居逐个判）。
2. **`_onGenResult`：新列到达时若 3×3 内有 emissive 方块则入队收敛**。
   扫描 9 列 × 32768 格实测 **0.286ms**（首次命中即退出）；无灯列零成本。
   不补这条则「走远再回来」仍会看到同样的边界。
3. **`_onLightResult` 写入前校验整个 region 的输入版本**：任一输入列当前 `version` ≠ 回包
   `version` → 丢弃并重新入队（沿用既有版本协议，**不引入** epoch/防抖/staging，红线 7）。
4. **脏标记只打真正变化的 section**：逐 section 比对 light 字节；邻居只在「中心列该 sy 确实变了」
   时置脏（邻列的 −X/−Z 面 faceLight 采的正是中心列的格，这条不能省）。替代现在
   「5 列 × 8 section 无条件全脏」的粗口径 —— 入队扩大后必须做。
   实测逐 section 比对成本：全相同 **0.4ms** / 全不同 **0ms**（提前退出）。

### 4.3 light RPC 结果形状

从「9 列 light 数组」改为「**只回中心列 light + 9 个输入列 version**」：

- 邻居 light 本来就被丢弃（中心权威协议），传它纯属浪费；入队扩到 9 倍后会放大 80%；
- 改完比**现在**的 plus-5 结果还小（32KB vs 160KB）；
- 实测 RPC 成本（交替多轮取中位）：加 region 前 9 列 **7.8ms / 0.59MB 入**，
  25 列 9.8ms / 1.64MB 入 —— 区域从 5 列改 9 列**并没有增加** RPC 总量。

消费者：`scheduler._onLightResult`、`src/tests/test-light-writeback.js` 的 fake（同步改）。

## 5. 测试（Tier 1，RED → 验证 RED → GREEN → 验证 GREEN）

### `src/tests/test-lighting.js`（新增）
- 灯在**对角邻居列**时，中心列角落格必须被点亮（现状 0 / 期望 13）；
- 3×3 区域算出的中心列 == 测试内自带的「全量参考 BFS」真值（只差 region 这一个变量）；
- 隔一列（offset 2）必须仍为 0 —— 防止「把更大范围都点亮」这种假修。

### `src/tests/test-light-writeback.js`（改）
- 适配新结果形状；
- 「region 输入版本不符 → 丢弃 + 重新入队」；
- 「只对变化 section 置脏」（未变的 sy 不得进脏列表）。

### 新增 `tests/light-spread.spec.mjs`（真游戏页 E2E）
- 放一盏灯 → 等 `lightQueued/lightInflight` 归零 → 断言 ±X/±Z 四条线上 blocklight 单调衰减、
  **跨边界处不出现归零跳变**，且四个邻居列都有亮格；
- 反向判据：隔两列必须仍为 0（同 `fog-color.spec` 的双向判据思路 —— 只钉一侧等于没钉）。

### 负向验证（必须真跑，不口头声称）
- region 改回 plus-5 → 新单测必须 FAIL；
- `enqueueLight` 改回单列 → E2E 必须 FAIL。

## 6. 门禁

1. `npm run check`（check:arch + check:data + lint）
2. `tests/harness.spec.mjs`（浏览器内单测全量）
3. 新增 `light-spread` + 既有 `light-arch` / `light-house` / `light-init`
4. `m1-acceptance`：编辑 p95 < 2ms 必须不变（冻结断言，实测不符**停下报告**，不擅自放宽）
5. `npm run bench -- --check`：改了 scheduler 热路径。若被 vsync 量子化误报阻断，按 AGENTS.md
   做**交替对照**（HEAD 与改动交错各 2~3 轮比分布），而不是改断言

## 7. 文档同步

- `docs/phase-1-engine-design.md` §4.6：区域语义 plus-5 → 3×3（附推导）、写回协议补
  「region 输入版本校验」、入队范围口径；版本号 v1.63 → v1.64 + 一条修订说明。
- `docs/roadmap.md`：v1.64 一行（现象 / 根因 / 修法 / 实测）。
- `AGENTS.md`：新增「blocklight 区域语义」活跃约束 —— region 必须是 3×3、写回只写中心列、
  入队必须覆盖 3×3，**三者是一个不变式，改一处必须同时看另外两处**（这是本次 bug 的完整形态：
  两处各自「看起来合理」的写法拼在一起才出错）。

## 8. 明确不做

- 不改 blocklight 强度/衰减（15 级、每格 −1 是既有口径）。
- 不做增量增亮/降光 BFS —— 仍走区域重算（§4.6 第一阶段口径），本次只把区域改对。
- 不动阳光阴影 / skylight 的视觉（skylight 第一阶段恒 15 不变）。
