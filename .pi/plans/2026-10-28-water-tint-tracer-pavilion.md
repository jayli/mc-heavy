# 水面暗度 / 曳光被水面遮挡 / pavilion 概率与重叠

用户 2026-10-28 报告三件事：

1. 傍晚和夜晚的水面波纹颜色依然过于明亮，要再暗一些。
2. 枪械曳光被水面遮挡：在岸上朝水里射击时，曳光线被波纹水面遮住。正确语义是「只有入水后才被水面遮挡」。
3. pavilion 在 city 中出现的概率降低一倍；渲染时注意不要跟其他实体重叠。

用户裁定（本次问询结果）：

- 水面暗度档位 = **中等（傍晚 luma 95 / 夜晚 82，正午基准 116）**
- pavilion 重叠范围 = **所有撒布结构 + 城市树**
- pavilion 概率 = **减半（×0.5）**

---

## 一、水面「傍晚/夜晚仍然过亮」

### 根因（实测确认，不是参数不够）

`src/render/ocean.js` 里 `uWaterTint` 乘在**雾色混合之前**：

```js
const finalColor = litColor.mul(uWaterTint);
...
return mix(finalColor, uFogColor, fogFactor);   // ← 雾色不吃 tint
```

`WATER_FOG_COLOR = 0x6b9cc0` 是**正午口径的固定常量**，`fogNear=20 / fogFar=70`。于是雾占主导的
**中远景海面完全不吃风格亮度乘数**。

实测（vd=8 深海机位、五变量冻结、水面众数峰 luma，按屏幕分带「远 → 近」）：

| 风格 | 0.55-0.65（远） | 0.65-0.75 | 0.75-0.85 | 0.85-0.96（近） |
|---|---|---|---|---|
| noon | 156 | 126 | 123 | 116 |
| dusk | **170** | 132 | 123 | 116 |
| night | **182** | 133 | 115 | 114 |

夜晚远处海面 182 **比正午 156 还亮一档** —— 这就是「依然过于明亮 / 像发光」的大头。

判别性证据：把 tint 从 0.62 一路压到 0.34，近处按预期从 114 降到 76，而**远处那一带恒定 182
一点没变** ⇒ 它根本不经过 tint。

次要根因：中途档位本身也不够暗（近处 night 114 vs 正午 116，只低 2）。

### 改法

1. `src/render/ocean.js` —— 乘数移到雾混合**之后**：

   ```js
   return mix(litColor, uFogColor, fogFactor).mul(uWaterTint);
   ```

   `tint = 1`（晨/午）时 `× 1.0` 在 IEEE754 下逐位精确 → 晨午**零回归**。

2. `src/render/daynight.js` —— 按「中等」档重标定（标定方法：海岸机位、五变量冻结、
   水面众数峰，**逐值串行「改一个 → 测一个」**，不可先烘完再一次性测）：

   - `dusk.waterTint` 0.84 → **≈0.60**（实测近处 96，目标 95）
   - `night.waterTint` 0.62 → **≈0.38**（实测近处 82~85，目标 82）
   - 精确值实施时按实测微调，不预设死。

   预期中远景随之落到 dusk ≈148 / night ≈147，都低于正午 156 →
   **两个维度同时变暗，且不再出现「夜里远处更亮」**。

---

## 二、曳光被水面遮挡（bug）

### 根因（实测确认）

两者都在 transparent 队列、**都不写深度**；海面 `renderOrder = 1` 排在曳光（默认 0）**之后**：

- 曳光先画，`depthWrite:false` → 深度缓冲里没有它；
- 海面后画，深度测试通过（缓冲里对这块水面没有任何东西）→ **无条件混合覆盖到曳光之上**。

所以不只是「入水后被挡」，**水面上方的曳光同样被盖**。

受控 A/B（同一机位，曳光固定在水面上方 3 格 / 下方 3.5 格，两种配置交替各 3 轮）：

| 配置 | 水面上方（px） | 水面下方（px） |
|---|---|---|
| 修前（海面不写深度、曳光先画） | 1544 / 1544 / 1544 | 3134 / 3134 / 3135 |
| 修后（海面写深度、曳光后画 + 深度测试） | 3528 / 3528 / 3528 | **0 / 0 / 0** |

### 改法

- `src/render/ocean.js`：`waterMaterial.depthWrite = true`。
  水面是单层水面，写深度是正确语义；`Discard` 已处理遮罩/淡出区，不会写进本该透明的像素。
- `src/render/tracer-renderer.js`：`mesh.renderOrder = 2`（抽成具名常量），深度测试保持开启。

于是透明绘制三重顺序固化为：

| 顺序 | 对象 | renderOrder | depthWrite |
|---|---|---|---|
| 1 | 体素水 | 0 | false |
| 2 | 海面 | 1 | **true** |
| 3 | 曳光 | **2** | false |

- 水面之上/之前的曳光：深度测试通过 → 可见
- 入水之后的曳光段：深度测试失败 → 被水面挡住（正是要的语义）

issue #2 的「体素水先、海面后」不变式不动，`tests/water-order.spec.mjs` 继续守。

---

## 三、pavilion 概率与重叠

### 实测现状（seed 12345，真实 JSON 包围盒口径）

- 城市撒布总量：house 148 / **pavilion 174** / flowerBed 69 / tallWell 70
- pavilion 重叠：**pavilion×pavilion 21 对**、pavilion×tallWell 16 对、×house 8 对、×flowerBed 4 对
- pavilion 占地内有城市树：**82/174 个**、共 124 格

### 三个独立根因

1. **`isFirstInFootprint` 扫描窗不足**：窗口是 `±halfX / ±halfZ`（±5/±3），但两个间距 6~10 格的
   候选本来就会相交 → 必须扫 `±2×half`。所以 pavilion 之间根本没互斥（21 对）。
2. **没有跨类型互斥**：flowerBed / house / tallWell 与 pavilion 各判各的。
3. **城市树后写胜、无占用守卫**：阶段 3 城市树在阶段 2.7 撒布之后跑，`makeColumnSetter`
   无条件覆盖 → 树冠直接打穿亭子屋顶。

### 改法

1. **概率减半**：`src/gen/structures/scatter.js` 的 `CITY_SCATTER_CHANCE.pavilion`
   `flowerBed×6` → **`flowerBed×3`**（与 tallWell 同档）。刻意偏离 mc-lite 的 ×6，注释写明理由。

2. `src/gen/structures/region-config.js` —— `SCATTER_FOOTPRINT` 增加 `real` 真实包围盒字段
   （重叠判定专用）：
   - **为什么必须另给一份**：`tallWell` 的 `24/20` 是**历史遗留抑制范围**、不是真实 AABB
     （真实是 5×4）。用 24/20 做重叠判定会毙掉 20 格外合法的亭子（实测 157 对 vs 真实 16 对）。
   - `check:data` 新增门禁：对每个有 JSON 的类型，用磁盘 JSON 实测包围盒校验 `real` ——
     防它漂移成第二份会撒谎的权威。

3. `src/gen/structures/scatter.js` —— pavilion **移出** `isFirstInFootprint`，改为在
   `computeScatterCandidates` 末尾做**规范顺序贪心后置过滤**：
   - 先算出全部候选（非 pavilion 集合已定）；
   - 按 `(wx, wz)` 字典序遍历 pavilion，用**真实包围盒**剔除与任何已保留非 pavilion 候选、
     或已保留 pavilion 相交者。
   - 保持「同一坐标在任何 column 结论一致」的纯函数不变式（全量城市候选只在持有 city 的
     region 里算一次，与现状口径相同）。
   - 成本：O(n²)，n≈250 → 6 万次 AABB 比较，可忽略；不引入递归/邻域重算。

4. `src/gen/structures/apply.js` —— 阶段 2.7 之后、阶段 3 之前，从已合并的 `scatterCandidates`
   一次性构建「pavilion 覆盖格集合」（真实包围盒**外扩 `VEGETATION_EXT`(3)**，覆盖树冠半径），
   阶段 3 城市树分支命中即跳过。
   - 外扩理由：树冠半径 ≤3，只排基部的话树冠照样会伸进亭子屋顶。
   - 一次构建、O(格数) 查询；不影响普通树/单格植物。

---

## 四、验证

| 改动 | 级别 | 验证 |
|---|---|---|
| ocean tint 移位 + depthWrite | Tier 4 | `tests/water-visual.spec.mjs` 重标定阈值，**新增远景带判据**（dusk/night 远处必须 < noon 远处，这才是根因症状）；`tests/water-order.spec.mjs` 顺序不变式 |
| waterTint 数值 | Tier 1 | `src/tests/test-daynight.js` 现有四条（分量区间 / 亮度序 / 同色相 / 插值） |
| 曳光遮挡 | Tier 4 | **新增** `tests/tracer-water-occlusion.spec.mjs`：同机位两条曳光（水面之上 / 水面之下），断言上方可见、下方被挡；负向验证 = 回退 `depthWrite`/`renderOrder` 必须真 FAIL |
| pavilion 概率/互斥 | Tier 1 | `src/tests/test-scatter.js`：×6→×3 关系式；新增「保留集合内 pavilion 两两不相交」「pavilion 不与任何保留的非 pavilion 相交」「数量相对旧口径下降但 > 0」 |
| pavilion 占地内无树 | Tier 1 | 同文件新增：占地（外扩 3）内不得有 `rollCityTree` 命中 |
| 真实包围盒不漂移 | Tier 2 | `npm run check:data` 新环节 |

另跑 `npm run check`、`npm run lint`、`npm test` 相关 spec。改 `src/**` 后必跑 lint。

---

## 五、文档

- `AGENTS.md`：
  - 水面段补「tint 必须在雾混合之后」+ 实测表；
  - 新增「海面写深度 + 曳光 renderOrder=2 是耦合一组的」约束；
  - pavilion 段记「概率 ×3 = 刻意偏离 mc-lite 的 ×6」「重叠判定用 `real` 包围盒，
    不是 `SCATTER_FOOTPRINT` 的历史抑制范围」「城市树在 pavilion 占地区（外扩 3）内不生成」。
- `docs/roadmap.md`：新增版本记录（含三张实测表）。

---

## 六、明确不做

- 不修 tallWell×tallWell 同类重叠（同一个窗口 bug，会改井密度并撞 cutout 预算）——
  只在报告里点名。
- 不动雨滴 / 爆炸 sprite 的同类「先画后被水面混合覆盖」问题（同一机制家族，但改的是别的
  特效的绘制顺序，超出本次范围）—— 报告里点名。
- 不动 `WATER_FOG_COLOR` 的具体色值（tint 移位后它已能跟随风格，再改色是另一件事）。
