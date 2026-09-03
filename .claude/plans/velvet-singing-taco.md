# 吊灯渲染：按用户描述的外观重构（有意偏离 mc-lite）

## 背景与实测依据

用户要求「绳单色深灰、灯体发光、灯面不含绳图案」。**实测 mc-lite 并非如此**（本次调查已用
vendored three 实跑 UV + Playwright 真实渲染 + 像素级分析定论）：

| 实测项 | mc-lite 实际值 | 出处 |
|---|---|---|
| 绳几何 UV | u∈[0,1] v∈[0,1]（采样整张贴图） | `ChunkConsolidation.js:216-227` 实跑 |
| 灯体几何 UV | u∈[0,1] v∈[0,1]（采样整张贴图） | 同上 |
| 贴图布局 | 64×64 canvas：背景 `#aaa49a` 全图 + 绳 `#333333`(col30~34,row0~20) + 灯体 `#FFE4B5`(col18~46,row20~48) + 发光区 `#FFF5E6` + 高光 `#FFFFFF` | `MaterialManager.js:1197-1220` |
| 按部件拆分 UV | **无** —— 四条放置路径只设 position/rotation | `ChunkConsolidation.js:529` / `Chunk.js:2464` / `ChunkGenerator.js:175,224` |
| 真实渲染绳色 | rgb(231,224,209) —— emissive 加项淹没贴图图案，绳**不呈深色** | 三样本像素分析（A≡C） |

故本次是**有意偏离 mc-lite**，照 vine 先例（§4.3 已标注 vine 为「已知的有意偏离」）。
mc-heavy 当前实现与 mc-lite 逐格一致（几何/UV/贴图/emissive 五项全等），改动即为偏离。

## 目标外观

1. **绳**：单色深灰 `#333333`，不吃 emissive（保持深色，不被暖黄加项冲淡）
2. **灯体**：采样灯体图案区（`#FFE4B5` + 发光区 + 高光），吃 emissive → 发光暖黄
3. **灯体四个面**：不含绳图案

## 改动方案

### 1. 设计文档先行（CLAUDE.md 规则：新增机制须先更新设计文档）

`docs/phase-1-engine-design.md` §4.3：
- 版本 v1.21 → **v1.22**，加修订说明
- 新增「吊灯 UV 分区与 quad 级自发光」小节，**明确标注为有意偏离 mc-lite**（照 vine 口径），
  附本次实测证据表（上表），并注明「视觉比对 mc-lite 时勿按其原样判定」
- 更新 bit13 段落：从「方块级」扩为「quad 级可覆盖」

### 2. mesher：模板 quad 增加两个可选字段（对其他方块零影响）

`src/mesh/mesher.js`：

**a) `uvRegion` —— quad 级 UV 子区域**

模板 quad 可选字段 `uvRegion: [u0, v0, u1, v1]`（tile 内局部坐标）。发射循环重映射：

```js
const [cu, cv] = q.uv ? q.uv[vi] : FACE_UVS[q.face][vi];
const [ru, rv] = q.uvRegion ? remapRegion(cu, cv, q.uvRegion) : [cu, cv];
const [uu, vv] = transformUV(blockName, q.face, ru, rv);
```

`remapRegion(u, v, [a,b,c,d])` = `[a + (c-a)*u, b + (d-b)*v]`（纯函数，线性重映射）。

**b) `em` —— quad 级自发光覆盖**

```js
const emissiveBit = q.em === undefined
  ? blockEmissiveBit                       // 未声明 → 方块级默认（既有行为不变）
  : (q.em ? (1 << 13) : 0);                // 声明了 → quad 级覆盖
```

`blockEmissiveBit` 即现有 `EMISSIVE_MATERIALS.has(blockName)` 结果（移到方块循环内即可，
现有位置已在方块循环内）。`q.em === undefined` 分支保证 chimney/台阶等既有模板行为零变化。

**c) hanging_lamp 模板改造**

```js
// 区域边界按 **texel 中心**对齐（不是像素边界）：fillRect(30,0,4,20) 填 col 30~33 / row 0~19，
// texel 中心在 30.5~33.5 / 0.5~19.5 → NearestFilter 下采样点落在纯色区内，不会采到相邻
// 背景 #aaa49a。atlas 的 v 轴翻转（build-atlas.mjs:103 `v0 = 1-(shelfY+h)/SIZE`）
// → canvas row r 对应 tile 局部 v = 1 - r/64。
// 绳图案区：u∈[30.5/64, 33.5/64]，v∈[1-19.5/64, 1-0.5/64]
// 灯体图案区（col 18~45 / row 20~47）：u∈[18.5/64, 45.5/64]，v∈[1-47.5/64, 1-20.5/64]
const LAMP_ROPE_REGION = [30.5 / 64, 1 - 19.5 / 64, 33.5 / 64, 1 - 0.5 / 64];
const LAMP_BODY_REGION = [18.5 / 64, 1 - 47.5 / 64, 45.5 / 64, 1 - 20.5 / 64];

hanging_lamp: [
  ...prismQuads(0.5, 0.5, 0.015, 0.6, 1.0).map((q) => ({ ...q, uvRegion: LAMP_ROPE_REGION, em: false })),
  ...boxQuads(0.35, 0.35, 0.35, 0.65, 0.65, 0.65).map((q) => ({ ...q, uvRegion: LAMP_BODY_REGION, em: true })),
],
```

几何坐标**不变**（120 顶点、绳 r=0.015/y∈[0.6,1.0]、灯体 0.3³），只改 UV 与 bit13。
`prismQuads` 的顶盖/底盖共用同一 `uv` 数组（`mesher.js:157,159-163`），故绳侧面+上下盖
统一落到绳区域。

### 3. materials.js —— 无需改动

`vEmissive` 已是逐顶点 float varying（`materials.js:44`），片元按顶点值分支。bit13 降到
quad 级后自动生效：绳顶点 `vEmissive=0` → 只有 `贴图色×shade`；灯体顶点 `vEmissive=1`
→ `贴图色×shade + 暖黄×0.8`。**发布粒度不变**（红线 5，仍三通道）。

### 4. 测试（TDD，Red-Green-Refactor）

`src/tests/test-mesher.js`：

**改现有断言**（当前钉死「所有 120 顶点置 bit13」，改动后必然失败）：
- `hanging_lamp 顶点置 packed bit13` → 改为「绳 96 顶点**不置** bit13、灯体 24 顶点**置** bit13」
- `bit13 不污染既有位段` 保留（仍成立）
- `glowstone 不置 bit13` / `stone/vine 不置 bit13` 保留（回归防线不变）

**新增断言**：
- 绳 quad UV 全部落在 `LAMP_ROPE_REGION` 内（钉死采样区域，防误改常量）
- 灯体 quad UV 全部落在 `LAMP_BODY_REGION` 内
- 绳 UV 区域**不含**灯体图案区（反向防线：若有人把绳区域写成全幅会立刻被抓到）
- 既有「绳 96 顶点 + r≤0.015 + y∈[0.6,1.0]」断言保留（几何未变）

`tests/` 新增 Playwright 视觉 spec（用保留的 fixture）：
- 绳行平均色显著暗于灯体行（钉死「绳呈深色」观感）
- 灯体行呈暖黄（钉死发光）

### 5. 保留 fixture 作对照工具

`src/tests/test-lamp-compare.html`（两侧对照）与 `src/tests/test-lamp-lite.html`（三样本）
保留，不注册进 `src/tests/index.html`、不纳入 Playwright 套件（手动调试页）。
改动后需更新 `test-lamp-compare.html` 右侧断言口径（mc-heavy 侧现在是偏离后的外观）。

## 验证步骤

1. `npm run lint` → 新增代码 0 error
2. 浏览器单测全绿（计数 246 → 约 250，含新增断言）
3. Playwright 全量回归（44 用例 + 新增视觉 spec）
4. `npm run bench -- --check` → 无回退（>10% 阻断）
5. 截图对照 + 像素级 diff：绳呈深灰、灯体暖黄发光、其余方块不受影响
6. 提交（等用户明确指令）

## 风险与边界

- **只影响 hanging_lamp**：`uvRegion`/`em` 均为可选字段，`q.em === undefined` 分支保证
  chimney/台阶/床/cactus 等既有模板行为零变化
- **不影响背包图标**：图标走 `bake-procedural-textures.mjs` 烘焙的整张 tile
  （`HIDDEN_FROM_INVENTORY` 不含 hanging_lamp，图标仍是完整图案）—— 这是 mc-lite 同源语义
  （`HUD.js:117-152` 取同一材质 `mat.map`），保持不变
- **blocklight 不变**：`blocks-data.js:142` 的 `emissive:15` 是光照源（照亮周围方块），
  与材质自发光无关，本次不动
- **红线自查**：不引入第二份数据、不开新子系统、不动主线程、发布粒度不变（三通道）
