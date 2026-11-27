# 「普通」环境风格默认参数落地（v3.53）

## 要解决什么

用户在「光影微调」Tab 里调出一组满意的参数，要求把它固化成 `visualStyle: normal` 的**默认配置**（复制文本 16 行原样给出）。

## 现状与实测差距

`VISUAL_STYLES.normal`（`src/render/daynight.js:277-311`）当前值 vs 目标值，逐项核对（已跑 `readTuningValues` + `clampTuningValue`，15 项**全部落在滑块区间内**，无需扩区间）：

| 参数 | 现值 | 目标 | 处置 |
|---|---|---|---|
| sunIntensity | 0.956 | **1.282** | 改 |
| shadowFloor | 0.14 | **0.399** | 改 |
| sunColor[0..2] | 1.214 / 1.018 / 0.768 | 同 | 不动 |
| hemiGround | 0.12 | 0.120 | 不动 |
| ambientColor[0..2] | 0.8544 / 0.97515 / 1.17045 | **0.854 / 0.975 / 1.170** | 改（去掉四位小数尾巴，均值 0.999667 仍 ≈1） |
| toneMappingExposure | 2.2 | **1.63** | 改 |
| skyDim | 1.0 | **0.95** | 改 |
| blockBoost | 1.0 | 1.000 | 不动 |
| waterTint | 0.55 ×3 | 0.550 | 不动 |
| punchGamma | 1.28（全局常量） | **1.34** | 新增 per-style 字段 |
| punchSat | 1.17（全局常量） | **0.94** | 新增 per-style 字段 |

### 三条冻结不变式被推翻（用户已裁定「按新值重标断言」）

1. `normal.skyDim === 1`（设计 §3.4.1：skyDim 同时驱动 `uShadowStrength`）→ 新值 0.95，阴影浓度随之 0.95。
2. `normal.shadowFloor < SHADOW_FLOOR(0.38)` → 新值 0.399 **高于**正午。
3. `直射/环境比 > 正午 × 1.5` → 实测新比值 **1.7223**，正午 1.6316，旧档 3.6604。仍高于正午但远不到 1.5 倍。

### CPU 屏幕口径预测（基色 0.5，本档 AgX+punch；仅供重标参考，真值以 Tier 4 实测为准）

| 量 | 旧档 | 新档 | 正午(ACES) |
|---|---|---|---|
| 顶面 | 174.0 | 178.4 | 205.9 |
| 背光面 | 69.2 | 97.9 | 128.8 |
| 底面 | 15.8 | 32.2 | 108.3 |
| 顶/背光 | 2.514 | **1.823** | 1.598 |

⇒ 新档整体**比旧档亮、对比更柔**，暗部仍显著低于正午（Tier 4 的 `normal.p5 < noon.p5` 结构上仍成立）。

### punch 落点（用户已裁定 per-style）

`ASHLAR_PUNCH_GAMMA/SAT` 保持 1.28/1.17 **不动** —— 它们被 `tools/normal-sky-tonemap.mjs` 消费，改常量会让 `check:data` 判天空贴图过期、要重烘六面（约 5min）。`_apply`（daynight.js:818-819）与 `readTuningValues`（light-tuning-config.js:161-162）**已经支持 per-style 回落**，只需在风格表里写字段。`lerpParams` 不插值 punch，自动循环两端都不写 ⇒ 恒 undefined ⇒ 其余四档逐位零回归。

## 打算改哪些文件、各改什么

### 1. `src/render/daynight.js`（数据 + 注释）
- `normal` 档：改 5 个标量 + `ambientColor` 三分量；新增 `punchGamma: 1.34` / `punchSat: 0.94`。
- 重写该档注释里已被推翻的三处论断：`skyDim 必须为 1`、`曝光 2.2 的标定理由`、`地板 0.14`；改成「用户 2026-11-27 实调标定」并记下新的实测比值 1.7223 / 云地板派生 0.60935。
- `_apply` 的云地板注释（:768-769）里 `floor 0.14 ⇒ 0.441` 更新为 `0.399 ⇒ 0.60935`（派生逻辑一行不改）。

### 2. `src/render/light-tuning-config.js`
- `readTuningValues` 的 punch 注释：说明 normal 档现在**显式给值**，缺省常量只服务其余四档。代码逻辑不动。

### 3. 注释同步（不改逻辑）
`src/render/sun-shade.js:113`、`src/render/shade-params.js:37/64`、`src/render/materials.js:199`、`src/render/cloud-shade.js:72` 里举例用的 `0.14 / 0.956` 改成新值。

### 4. `src/tests/test-normal-style.js`（Tier 1，重标 + 补判据）
- `skyDim 必须为 1` → 改钉 `0.95`，并**保留耦合语义**：`uShadowStrength` 读回 0.95、`uSkyDim` 读回 0.95（判据仍落在「两者同源」上，不是放宽）。
- `shadowFloor < SHADOW_FLOOR` → 改成钉 `0.399`，并新增一条**方向性判据**：本档 `hemiGround(0.12) ≪ 全局 0.6` 仍成立（立体感来源未丢）。
- `直射/环境比 > 正午 ×1.5` → 改成 `> 正午`（实测 1.7223 > 1.6316），并加上下界 `> 1.65` 防回落。
- `shadowKill 分母同步` 用例：新地板 0.399 与全局 0.38 只差 0.019，原判据「中间调绝对差 > 0.1」**必然失效**。取样点从 `0.3` 改为 `floor + 0.001`（实测 synced 0.001664 / desync 0.032258，**相对差 94.8%**），判据改成**相对口径** `synced < desync × 0.2`。端点恒等那两条保留。
- 新增：`normal.punchGamma === 1.34` / `punchSat === 0.94` 显式存在，且其余四档**不写**这两个字段（缺省回落常量，零回归）。
- 新增：`_apply` 后 punch 句柄读回 1.34/0.94；切到 noon 回落 1.28/1.17。

### 5. `src/tests/test-light-tuning.js`（Tier 1）
- `readTuningValues 读 normal 实测值`：0.14→0.399、0.956→1.282、2.2→1.63；punch 两项从「等于全局常量」改成「等于本档 1.34/0.94」，并**另加一条**「noon 缺省仍等于全局常量」。
- 复制文本用例：`强光，sunIntensity: 0.956` → `1.282`。
- `resetTuning` / `override 不污染权威` / `waterTint` 等用例里的 0.14 / 0.956 / 1.17045 同步为新值。
- `切回其余四档 punch 回落常量` 用例保留（它验的正是 per-style 不残留）。

### 6. `src/tests/test-cloud-shade.js`（Tier 1）
- `normal 档派生值` 用例：`cloudSunFloorFor(0.14)=0.441` → `cloudSunFloorFor(0.399)=0.60935`；顶面算式 `0.14+0.956*y` → `0.399+1.282*y`（实测 1.08621 > 0.60935，`max` 恒等仍成立）。
- **☠️ 一处判据仪器错了，必须换**：`全档全面最大线性 <1.0（不削顶）` 用例对五档统一用 **ACES 口径**。新 normal 档云侧面线性达 **1.1371 > 1** 会真红，但它走的是 **AgX**（log2 编码，上界 EV 4.026 ⇒ 线性 16.29 才钳顶），实测屏幕仅 211.2、R−B 仍 8.05，**没有削顶**。处置：扫描按 **per-style 曲线**判「该档是否真钳顶」（normal 走 AgX + 本档曝光，其余走 ACES + 各自曝光）。判别力保留 —— dusk 面4 ao3 在 gain 1.42 时线性 1.0133 仍会被抓（已实测）。
- `五档侧/底屏幕比 ≥1.15` 与 `R−B 保色相` 两条已在新值下预演：全部满足（normal ao1 1.3394 / ao3 1.2545；R−B 偏移 ≤3.24 < 8），**不改阈值**。

### 7. `tests/normal-style.spec.mjs`（Tier 4）
- 三处数值断言：floor 0.14→0.399、intensity 0.956→1.282、exposure 2.2→1.63；`skyDim 须为 1` → `0.95`。
- `normal.p5 < noon.p5`（暗部更黑）**保留不动**，跑实测确认。
- 天空 sanity floor `>40 / <250`：新曲线下同一烘焙像素整体下移约 15~20 灰阶（如烘焙 120 → 屏幕 127.4，旧 146.9），预测仍在带内，**先跑实测再定**，不预先放宽。
- 新增一条：`readState` 读 punch 两 uniform，钉 normal 档 1.34/0.94、切 noon 回落 1.28/1.17（GPU 侧接线证据）。

### 8. `tests/light-tuning.spec.mjs`（Tier 4）
- 用例② / ⑤ 的 0.14 / 2.2 → 0.399 / 1.63；用例⑦ 复制文本 `0.956` → `1.282`。
- 用例② 的 step 量化注释：ambientColor 改成三位小数后**偏差应为 0**，注释同步（容差断言本身不动，它是控件固有行为的防线）。
- 用例⑧ `切走后 punch 回落常量 1.28` **保留**（per-style 不残留的证据）。

### 9. 文档
- `docs/superpowers/specs/2026-11-27-normal-env-style-ashlar-port-design.md`：§3.4 标定表与 §3.4.1 加「2026-11-27 用户实调重标」小节，写清新值与被推翻的三条论断（保留原文作为历史，标注已作废）。
- `docs/roadmap.md`：新增 v3.53 行（记参数表、三条不变式重标、punch per-style 化的理由、云扫描换仪器的实测证据）。

## 不改的东西（明确边界）

- **不重烘天空**：`ASHLAR_PUNCH_*` 常量不动 ⇒ `assets/sky/normal/*.jpg` 与指纹逐位不变，不跑 `npm run normalsky`。
- **不动其余四档与自动循环**：它们不写这三个 per-style 字段与 punch 两项 ⇒ 回落全局常量，逐位零回归（既有断言守着）。
- **不动全局常量** `SHADOW_FLOOR=0.38` / `SUN_INTENSITY=0.775` / `HEMI_GROUND=0.6`。
- **不动滑块区间**（15 项已实测全部在区间内）。
- 不提交（等明确指令）。

## 怎么验证

1. `npm run check`（arch + data + lint，~5.4s）—— 必须 exit 0，特别确认 `[普通天空] 烘焙指纹匹配`（证明没触发重烘）。
2. Node 最小充分集（消费被改模块的 6 个文件）：
   `node tools/run-unit-node.mjs --only=test-normal-style.js,test-light-tuning.js,test-cloud-shade.js,test-daynight.js,test-sun-shade.js,test-hemi.js`
3. Tier 4 两个 spec（本改动的直接消费方）：
   `npx playwright test tests/normal-style.spec.mjs tests/light-tuning.spec.mjs`
   —— 端口 8081 已确认归属本仓（`lsof -p 31879` cwd = `/Users/bachi/jaylli/mc-heavy`），且 curl 核对服务返回的就是当前源码。
4. **负向验证 2 组**（`edit` 注入 + 读回源码确认落地 + `cp` 副本还原，**不用 git checkout**）：
   - N1：`_apply` 三个 uniform 恒写全局常量 ⇒ floor/intensity/hemi 三条数值断言 + 比值断言真红；
   - N2：删掉 `normal.punchGamma/punchSat` 两字段 ⇒ punch 接线断言真红（回落 1.28/1.17）。
5. 消费方回归（共享装配段、且**不选 normal 档**的邻居，用来证明零回归）：`cloud-softness`（固定 style=noon）、`sun-directional`、`hemisphere-ambient`。
6. **不跑 `npm test`**：非用户要求 / 非里程碑发版 / 未改全局基础设施。
7. **不跑 bench**：本改动只改风格数据表与测试，未碰 mesher/materials/scheduler 热路径代码（materials.js 只改注释）。

## 风险与已知盲区

- Tier 4 的天空 sanity floor 与 `p5 < noon.p5` 是**预测成立、待实测**。若实测越线，按 AGENTS.md **停下来报告实测值**，不擅自放宽阈值。
- 云「不削顶」扫描换仪器后，normal 档的判别力由 AgX 上界（线性 16.29）承担，比 ACES 的 1.0 宽松得多 —— 这是**曲线本身的性质**，不是放宽；dusk 侧仍保留 1.0 的紧判别力。会在 roadmap 里写明。