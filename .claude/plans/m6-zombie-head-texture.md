# 补齐 M6 遗留 TODO：丧尸头部马赛克图案（含黑色眼睛）

## 半成品核查结论

roadmap TODO 记的半成品**已不存在**，须从头制作：

- `assets/zombie/` 目录不存在
- `.tmp-neg/bake-zombie-head.mjs` 不存在
- `git ls-files` 无任何 zombie 纹理/烘焙脚本记录（从未入库）

## 决定性实测：TODO 预设的方案 A 走不通

TODO 原文标注了「**未验证的前提**：three r185 WebGPU 后端对 `InstancedMesh` + 材质数组 +
`groups` 的支持 —— 不支持则须改走单纹理方案（UV 分区放眼睛）」。本次实测给出了答案：**不支持**。

实测手法（渲染红/绿两个纯色材质 → 读渲染像素，非读定义推断）：

| 探测 | 正面像素 | 结论 |
|---|---|---|
| A：`clearGroups`/`addGroup` + 材质数组（mc-lite 原样） | `[255,0,0]` **红** | ❌ 只用 `material[0]`，正面未换成绿 |
| B：单材质 + 单纹理 + UV 分区 | `[0,255,0]` **绿** | ✅ 生效 |
| C：`instanceColor` | `[0,255,0]` **绿** | ✅ 照常工作（红闪与部件配色不受影响） |

三方交叉一致：像素实测 + `three.webgpu.js:34592` `getMaterial()` 直接 `return material`
（不看 `geometry.groups`、不遍历 draw range）+ 子代理独立调查。
WebGL 后端支持 groups（`:30472` 遍历 `geometry.groups` 按 `materialIndex` 分次 draw）→
是 **WebGPU 后端刻意不实现**，非整体不支持。

**后果**：TODO 的 ②③⑤ 步骤要改写；连带影响里的「draw call 6 → 7」**不会发生**
（单材质单 draw range，draw call 仍是 6，`tests/zombies.spec.mjs` 的 `+6` 冻结断言无需改）。

## 方案：单纹理 128×64 双区 + 正面 UV 分区

一张 `assets/zombie/head.png`（128×64）：左半 64×64 = 无眼睛马赛克，右半 64×64 = 有眼睛马赛克。
（不能用 64×64 上下分区 —— 马赛克是 8×8 网格 × 8px = 64×64，压到 64×32 会破坏马赛克比例。）

head 几何 UV 改写（`BoxGeometry` 面序 `[右,左,上,下,前,后]` × 4 顶点，**正面 = 顶点 16-19**，
已在实测中钉住）：

- 顶点 16-19（正面）：`u' = 0.5 + u × 0.5` → u ∈ [0.5, 1] → 右半（有眼睛）
- 其余 20 个顶点：`u' = u × 0.5` → u ∈ [0, 0.5] → 左半（无眼睛）

材质：head 用单个 `MeshBasicMaterial({ map: headTexture, color: 0xffffff })`；其余五部件不变。

## 图案参数（逐项实测自 mc-lite，非凭字段名推断）

mc-lite `ZombieInstancedRenderer.js:99-119` `TEXTURE_CONFIG` + `:581-666` 绘制：

| 参数 | 值 | 注意 |
|---|---|---|
| 网格 | 8×8，每格 8px → 64×64 | |
| `headPalette.base` | `[64, 107, 48]` | |
| 噪点色 | `[48,80,36]` / `[80,134,60]` / `[96,160,72]` | |
| 噪点概率 | 字段名 `noiseProbability: 0.7`，但判定是 **`> 0.7` 才用噪点 → 实际仅 30%** | **照字段名理解会把图案画反** |
| `baseColorVariation` | 5（`(rand-0.5)×5` 波动） | |
| 眼睛 | 网格 (2,3) 与 (5,3) → 像素 (16,24) 与 (40,24)，各 8×8 纯黑 | |

**两处有意偏离 mc-lite**（须在代码与文档标注）：

1. **随机源用固定种子 mulberry32**（mc-lite 用 `Math.random()` → 每次加载图案都不同 → 违反红线 2）。
   沿用 `tools/bake-procedural-textures.mjs` 既有先例。
2. **两区共用同一份马赛克背景**（mc-lite 两次独立 `Math.random()` → 正面与侧面是两张不同的随机图）。
   六面同一材质图案视觉上更连贯；mc-lite 的「两张不同随机图」是 `Math.random` 的副作用，非设计意图。

## 实施步骤

### 1. 烘焙脚本 `tools/bake-zombie-head.mjs`（新建）

逐行复刻上表参数，`mulberry32` 固定种子，输出 `assets/zombie/head.png`（128×64）。
沿用 `tools/bake-procedural-textures.mjs` 的 `pngjs` + `fillRect` 手法。
`package.json` 加 `"zombie": "node tools/bake-zombie-head.mjs"`（与 `icons` / `atlas` 命名一致）。

**纹理放 `assets/zombie/` 而非 `assets/textures/`**：后者被 `build-atlas.mjs` 的
`collectPngs` 递归扫描进世界 atlas（已确认），丧尸头部纹理不属世界方块贴图，进去会污染 atlas。

### 2. `src/render/zombie-head-texture.js`（新建）

导出 `loadZombieHeadTexture()`（`TextureLoader.loadAsync('/assets/zombie/head.png')`，
`NearestFilter` + `SRGBColorSpace`，口径同 `mesh/atlas-loader.js`）。
**主线程专用**（运行时加载纹理必然依赖 three）—— 与 `atlas-loader.js` 同类，
须在 `tools/check-architecture.mjs` 白名单加一条（该门已有 atlas-loader 例外先例）。

### 3. `src/render/zombie-renderer.js`（改）

- 构造器新增**可选** `headTexture` 参数：有则 head 材质加 `map` + 改写 UV；无则退回纯色
  （让既有单测 fixture 不需纹理也能跑，向后兼容）
- `ZOMBIE_PART_DEFS.head.color`：`0x406b30` → `0xffffff`（白底乘纹理色，回归 mc-lite 口径；
  不改则「深绿 instanceColor × 深绿纹理」严重变暗）
- 文件头注释的「有意偏离 ②」（不做 CanvasTexture）**删除**，改为记录实测结论
- `dispose()` 释放新增纹理
- 新增只读接口 `headHasTexture()`（供 E2E 断言钉住，防「game.js 忘传纹理」静默缺失）

### 4. `src/core/game.js`（改）

atlas 加载处一并 `await loadZombieHeadTexture()`，传给 `ZombieRenderer`
（保持构造器同步 → 首帧不闪纯色）。

### 5. 单测断言（`src/tests/test-zombies.js`）

- 反转 `:440` 的 `head.color` 断言：`0x406b30` → `0xffffff`
- 新增 UV 分区断言（纯几何数据，无需 GPU）：顶点 16-19 的 u ∈ [0.5,1]、其余 ∈ [0,0.5]
- 新增「传入 headTexture 时 head 材质有 map / 未传时无 map」断言

### 6. Tier 4 像素实测（`src/tests/test-zombie-head.html` + `tests/zombie-head.spec.mjs`）

沿用 `tests/ao-corner-visual.spec.mjs` 手法（fixture 自己投影世界点 → 屏幕像素，spec 不硬编码位置）。
四条断言，都能双向验证：

| 断言 | 注入什么会失败 |
|---|---|
| ① 正面眼睛点显著暗于正面非眼睛点 | 去掉 UV 改写 → 正面采样左半（无眼睛） |
| ② 顶面/侧面取样点非黑（无眼睛） | 眼睛画进两区 |
| ③ 红闪时正面 R 通道显著高于 G/B | 见下「红闪」注 |
| ④ 前提：fixture 确实暴露全部取样点 | 断言到 undefined |

**红闪注**：head 有 map → 红闪 = `instanceColor(红)` × `map(深绿马赛克)` = 暗红（≈ rgb(64,0,0)），
**不是纯红**。这是 mc-lite 的既有行为（它同样 map × flash color），故断言写「R 显著高于 G/B」
而非「纯红 [255,0,0]」—— 断言要诚实反映真实表现。其余五部件无 map，红闪仍是纯红。

### 7. 门禁 `tools/check-data.mjs`（改）

加 `[丧尸头部纹理]` 段，沿用 `tools/icon-fingerprint.mjs` 的手法（烘焙脚本与门禁共用同一份
指纹逻辑，红线 1）：校验 PNG 存在 + 尺寸 128×64 + 黑像素数 = 2 × 64（两个 8×8 眼睛块，
关系型断言 → 抓「眼睛画错位置/数量」）+ 输入指纹匹配（抓「改了烘焙脚本忘记重跑 → 静默过期」）。

### 8. 文档同步

| 文档 | 改动 |
|---|---|
| `docs/roadmap.md` | 「M6 之后的遗留 TODO」那条 ⬜ → ✅，并记录「方案 A 实测不可行」的结论 |
| `docs/m6-zombies-acceptance-report.md` §6 偏离表 | 「head 配色 `0x406b30`」那条偏离**反转**（TODO 明确要求） |
| `CLAUDE.md` 活跃约束 | **加一条**：WebGPU 后端不支持 `InstancedMesh` + 材质数组 + `groups`（实测证据 + 单纹理 UV 分区替代）—— M7 巢穴/炮塔等任何多材质实体同理，属「会影响后续实现决策的活跃约束」 |
| `docs/phase-1-engine-design.md` | **不 bump 版本**：本次是 M6 遗留 TODO 补齐（渲染实现细节），非架构口径变更；按 CLAUDE.md「M4 交付后的实玩反馈修正不进设计文档修订说明」的既有纪律 |

## 分级与门禁

- **Tier 4**（GPU 渲染结果）→ 像素级实测，**不宣称目视验证**（本环境截图的 `Read` 只返回 URL）
- **Tier 2**（图案参数集合口径）→ `check:data` 门禁断言，免 TDD 流程
- 改动落在 `src/render/`（非 mesher/materials/scheduler/physics 热路径）→ **不需跑 bench**；
  但 `tests/zombies.spec.mjs` 的 `+6` draw 断言须复跑确认未变
- 收尾：`npm run check` + 浏览器内单测 + 新增 spec + `tests/zombies.spec.mjs`

## 风险

1. **UV 左右分区方向**：实测只验证了上下分区（v），左右分区（u）靠 Tier 4 断言 ① 兜住 ——
   方向反了会立刻失败（正面读到无眼睛区）。
2. **眼睛的上下位置**：`flipY=true` + `BoxGeometry` 的 `v = 1 - iy/gridY` + pz 面 `vdir=-1`
   → PNG row 24-31 渲染在头部**上半部分**（与 mc-lite 一致，非翻转）。若 Tier 4 断言 ① 取样点
   落空，说明这套推导有误，须按实测重新定位取样点而非改图案。
