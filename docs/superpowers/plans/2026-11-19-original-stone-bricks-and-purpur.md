# 丛林要塞原版石砖 + 末日地堡紫珀方块 实施计划（v3.19）

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans（本会话内实施）。
> 步骤用 `- [ ]` 复选框跟踪。

**Goal:** 新增 3 个原版石砖方块 + 1 个紫珀方块（共 4 个，全部进背包），把丛林要塞石砖族的三个替身
和废弃堡垒 4210 格 deepslate 换成它们，且老存档不清档。

**Architecture:** 纯离线烘焙（新脚本 + 新指纹模块 + 纯函数模块）→ 4 张 16×16 tile 进既有 atlas →
4 行 `geometry:"box"` 方块声明追加在 `BLOCKS` 末尾 → 两个结构的映射表改目标名 → 重烘产物。
运行期只改一处：存档兼容判据从「方块清单指纹全等」放宽成「旧清单是当前清单的前缀」。

**Tech Stack:** Node 26 + pngjs（离线烘焙）；浏览器内单测 `src/tests/`；Playwright（Tier 4）。

**Spec:** `docs/superpowers/specs/2026-11-19-original-stone-bricks-and-purpur-design.md`

## Global Constraints

- 新方块**必须追加在 `BLOCKS` 数组末尾**（id = 下标；IndexedDB edits 存数字 id）。
- 烘焙输入放 `assets/stone-bricks/src/`，**绝不放 `assets/textures/`**（build-atlas 递归扫描）。
- 资源路径只走 `resourceUrl()`；`src/**` 与浏览器单测**不得 import** 依赖 `node:` 的模块。
- 台阶（`cobblestone_step`）、栏杆（`handrail`/`handrailA`）、`dirt`/`red_mushroom`/`chest`/`water`
  的映射**一字不动**。
- 其他结构的 `deepslate` / `mossy_stone` / `cobblestone` / `tuff_bricks` **不动**。
- 冻结数字不符时**停下报告**，不擅自放宽断言。
- 浏览器验证必须核对端口归属：8081 已被主仓占用（PID 31879，cwd=`~/jaylli/mc-heavy`）
  ⇒ 本 worktree 用 **8082**，且 `playwright.config.mjs` 的 baseURL 要按环境变量切。
- 提交按 Conventional Commits；`AGENTS.md` 是 `CLAUDE.md` 的符号链接 ⇒ 改高频坑一律 `git add CLAUDE.md`。

## Review Focus

1. **老存档的手工建造被清掉** —— 追加方块后指纹变了，但既有 id 一个没动 ⇒ 必须不清档（Task 5）。
2. **中间插入/删除方块仍必须清档** —— 放宽兼容判据不能把真位移也放行（Task 5 负向）。
3. **purpur 取样相位错一格** —— 512→16 若 origin/span 取错，产物仍是「紫色 16×16」而图案全错
   ⇒ 众数一致性判据（Task 2）。
4. **替身没换干净** —— 只改了 bands 而漏了墩材质 / 漏了 SLAB_BASE ⇒ 画面两种石头（Task 3/4 内容级判据）。
5. **新贴图色调让既有像素阈值贴线** —— 三张新石砖均值必须实测后再判阈值（Task 6）。

---

### Task 1: 素材入库 + 烘焙纯函数（RED→GREEN）

**Files:**
- Create: `assets/stone-bricks/src/{mossy_stone_bricks,cracked_stone_bricks,chiseled_stone_bricks,purpur_block}.png`
- Create: `assets/stone-bricks/src/reference/{Mossy,Cracked,Chiseled,Stone}_Stone_Bricks_JE3_BE2.png`（+ `Purpur_Block_JE2_BE2.png` 备用）
- Create: `assets/stone-bricks/src/README.md`
- Create: `tools/stone-bricks-parse.mjs`（纯函数，无 `node:`）
- Create: `src/tests/test-stone-bricks.js`
- Modify: `src/tests/index.html`（注册新测试文件）
- Modify: `tools/test-tiers.mjs`（`UNIT_NODE_SAFE` 加一行）

**Interfaces:**
- Produces:
  - `topFaceColorMap(render, tex, geom)` → `Map<string,string>`（键/值都是 `"r,g,b"`）；
    每个源色映到多于一个渲染色时 throw。
  - `remapPalette(tex, map)` → `{width,height,data}`（新缓冲，alpha 原样）。
  - `downsampleByTexelCenter(src, opts)` → `{width:16,height:16,data}`；
    `opts = {origin:25, span:462, size:16}`；每 texel 与该区域众数不符时 throw。
  - `TOP_FACE_GEOM = {tv:[148,0], rv:[282,66], lv:[14,66]}`（wiki 300×300 渲染图顶面三角）。

- [ ] **Step 1: 入库素材**（blockrender 三张 16×16 + 用户 512×512 原图 + wiki 渲染图），写 README 记出处/许可/重映射理由。
- [ ] **Step 2: 写失败测试** `src/tests/test-stone-bricks.js`：
  - `topFaceColorMap` 对 mossy 源图 + wiki 渲染图返回 12 项映射，且 `8b898b → 888688`（`"139,137,139" → "136,134,136"`）；
  - 同一源色映到两个渲染色时 throw（构造 2×2 假图注入）；
  - `remapPalette` 不改 alpha、不改入参、图案分区不变（同色格集合逐格一致）；
  - `downsampleByTexelCenter` 对用户 purpur 图产出 16×16、alpha 全 255、7 色、
    首格 `[159,134,159]`、末格 `[115,80,115]`；
  - `origin` 改成 26（错一格）时 throw（负向：相位判据真有判别力）。
  - 素材经 `fetch(resourceUrl('assets/stone-bricks/src/...'))` + `PNG.sync.read`？
    ⚠️ 浏览器无 pngjs ⇒ **改用 `createImageBitmap` + canvas 读像素**？该路径 Node 无垫片。
    **定案**：纯函数用例只喂**合成小图**（`{width,height,data}` 字面量），真实素材的判据
    全部落在 Task 2 的 node 烘焙器自检与 `check:data`（Tier 2）。故本文件进 `UNIT_NODE_SAFE`。
- [ ] **Step 3: 跑测试确认 RED**：`node tools/run-unit-node.mjs --only=test-stone-bricks.js` → import 失败（模块不存在）。
- [ ] **Step 4: 实现 `tools/stone-bricks-parse.mjs`**（三个函数 + 一个常量，签名见上）。
- [ ] **Step 5: 跑测试确认 GREEN**（同上命令）。
- [ ] **Step 6: `npm run check:data` 的 `[测试注册]`/`[测试分档]` 通过**（新文件已双向注册）。
- [ ] **Step 7: Commit** `feat(stone-bricks): 原版石砖/紫珀素材入库 + 烘焙纯函数与单测`

---

### Task 2: 烘焙器 + 指纹 + 4 张 tile 产物

**Files:**
- Create: `tools/stone-bricks-fingerprint.mjs`（路径 / 参数 / 目标均值 / 指纹；node 侧）
- Create: `tools/bake-stone-bricks.mjs`
- Modify: `package.json`（`"stonebricks": "node tools/bake-stone-bricks.mjs"`）
- Modify: `tools/check-data.mjs`（新增 `[石砖贴图]` 环节 + 调用行）

**Interfaces:**
- Consumes: Task 1 的三个纯函数 + `TOP_FACE_GEOM`。
- Produces:
  - `STONE_BRICK_TEXTURES`（4 项：`{source, out, mode:'remap'|'texel', reference?}`）
  - `STONE_BRICK_TARGET_MEAN`（4×3 数组，实测冻结）
  - `STONE_BRICKS_META`、`stoneBricksInputFingerprint()`
  - 产物 `assets/textures/{mossy_stone_bricks,cracked_stone_bricks,chiseled_stone_bricks,purpur_block}.png`

- [ ] **Step 1: 写指纹模块**（源图 sha + 参数 + 目标均值 + `ISO_RENDER_VERSION` 无关）。
- [ ] **Step 2: 写烘焙器**：三张走 `topFaceColorMap`+`remapPalette`，purpur 走 `downsampleByTexelCenter`；
      自守断言：尺寸 16、图案分区不变（remap 路径）、均值命中目标 ±0.05、purpur alpha 全 255。
- [ ] **Step 3: 跑 `npm run stonebricks`**，把实测均值填进 `STONE_BRICK_TARGET_MEAN` 后重跑至绿。
      已知预期：purpur `135.5273/100.3398/135.2891`。
- [ ] **Step 4: `npm run atlas`**（tile 174 → 178）。
- [ ] **Step 5: `check:data` 新增 `[石砖贴图]`**：产物存在 / 尺寸 / 指纹 / 均值 / purpur 众数一致性 /
      remap 三张与源图图案同构。⚠️ 调用行必须加，否则门禁永不执行。
- [ ] **Step 6: `npm run check:data` 绿**（此时 faces-data 还没引用新 tile，`[引用完整性]` 不受影响）。
- [ ] **Step 7: Commit** `feat(stone-bricks): 烘焙 4 张 16×16 tile + 指纹与数据契约门`

---

### Task 3: 4 个方块声明 + 背包 + 丛林要塞映射

**Files:**
- Modify: `src/voxel/blocks-data.js`（末尾追加 4 行）
- Modify: `src/voxel/faces-data.js`（4 项单 tile）
- Modify: `tools/bake-jungle-fortress.mjs`（`STONE_VARIANTS.bands` 三个目标名 + 注释）
- Modify: `tools/jungle-fortress-fingerprint.mjs`（`targetCounts` 换名 + `STONE_VARIANTS` 进指纹参数）
- Modify: `src/gen/structures/jungle-fortress-terrain.js`（墩材质 `mossy_stone → mossy_stone_bricks`）
- Modify: `src/tests/test-jungle-fortress-gen.js`（主材/墩材质/palette 判据）
- Modify: `src/tests/test-block-registry.js` / `test-inventory.js` / `test-inventory-ui.js` / `test-orientation.js`（冻结计数）
- Modify: `tools/check-data.mjs`（`[丛林要塞]` 加「不得含替身」判据）

**Interfaces:**
- Consumes: Task 2 的 4 个 tile 名。
- Produces: 方块名 `mossy_stone_bricks` / `cracked_stone_bricks` / `chiseled_stone_bricks` / `purpur_block`
  （id 155/156/157/158），全部在 `buildItemNames()` 内。

- [ ] **Step 1: 先改单测（RED）**：`test-stone-bricks.js` 加「4 个方块已注册 + 声明同 stone 口径 +
      faces 单 tile + 在背包 + 追加在末尾且既有 id 不位移」；`test-jungle-fortress-gen.js` 的
      主材判据改成新名 + 加「palette 不含三个替身」。
- [ ] **Step 2: 跑 RED**（`--only=test-stone-bricks.js,test-jungle-fortress-gen.js`，后者需 `--tier=all`）。
- [ ] **Step 3: 追加 4 行声明 + 4 项 faces**（purpur 六面同图用单字符串）。
- [ ] **Step 4: 改 bands 三个目标名 + 墩材质**；`STONE_VARIANTS` 已在指纹参数内？
      ⚠️ 实测：`jungleFortressInputFingerprint()` 的参数清单**不含 `STONE_VARIANTS`** ⇒ 必须补进去
      （否则「改映射不动参数」指纹拓不到）。
- [ ] **Step 5: `npm run junglefortress -- --census`** 核实测值：格数 81238 / air 15536 / palette 13 /
      四档 30503·15085·3012·12092 逐档不变；把 `targetCounts` 换名后 `npm run junglefortress` 写产物。
- [ ] **Step 6: `npm run icons`**（背包 145 → 149）。
- [ ] **Step 7: 改四处冻结计数** 155→159 / 145→149 / 136→140 / 109→113（连算式注释一起改）。
- [ ] **Step 8: GREEN**：`node tools/run-unit-node.mjs --only=test-stone-bricks.js,test-block-registry.js,test-inventory.js,test-orientation.js`
      + `--only=test-jungle-fortress-gen.js --tier=all`；`npm run check`。
- [ ] **Step 9: Commit** `feat(jungle-fortress): 石砖族改用原版三变体 + 4 个新方块进背包`

---

### Task 4: 废弃堡垒 deepslate → purpur_block

**Files:**
- Modify: `tools/ruined-citadel-fingerprint.mjs`（`BLOCK_MAP` 三项 + `SLAB_BASE.purpur_slab` + `targetCounts` + 新烘方块常量）
- Modify: `tools/check-data.mjs`（`[废弃堡垒]` 的新方块派生集合带上 purpur_block + 「palette 不含 deepslate」）
- Modify: `src/tests/test-ruined-citadel-gen.js`（若有相关判据则改；无则加一条 purpur 格数判据）

**Interfaces:**
- Consumes: Task 3 的 `purpur_block` 方块名。
- Produces: `RUINED_CITADEL_NEW_BLOCKS`（显式常量，含既有 15 个 + `purpur_block`），两侧共用。

- [ ] **Step 1: RED** —— `test-ruined-citadel-gen.js` 加「产物含 purpur_block 4210 格且不含 deepslate」。
- [ ] **Step 2: 跑 RED**（`--only=test-ruined-citadel-gen.js --tier=all`）。
- [ ] **Step 3: 改映射四处 + targetCounts**；`STAIR_TARGETS` / `SLAB_BOTTOM` 不动。
- [ ] **Step 4: `npm run ruinedcitadel -- --census`** 核 palette 仍 34 / 格数 288744 / deepslate 0 / purpur 4210，再写产物。
- [ ] **Step 5: `check:data` 的新方块集合改用 `RUINED_CITADEL_NEW_BLOCKS`**（派生规则 + 显式补充，红线 1）。
- [ ] **Step 6: GREEN**（单测 + `npm run check`）。
- [ ] **Step 7: Commit** `feat(ruined-citadel): 紫珀族 4210 格改用新方块 purpur_block`

---

### Task 5: 存档兼容（追加方块不清档）—— Tier 1，必须 TDD

**Files:**
- Modify: `src/voxel/block-registry.js`（新增 `fingerprintOfPrefix(n)`）
- Modify: `src/core/game.js:538-556`（兼容判定 + meta 写 `blockCount`）
- Modify: `src/core/game.js:981,2373,2489`（三处 saveMeta 带 `blockCount`）
- Modify: `src/tests/test-block-registry.js`（前缀指纹用例）
- Modify: `tests/persistence.spec.mjs`（追加兼容 / 中间插入仍清档 两条）

**Interfaces:**
- Produces: `registry.fingerprintOfPrefix(n)` → 8 位十六进制串；`n === count` 时 ≡ `fingerprint()`。
  meta 行新增字段 `blockCount`（整数）。

- [ ] **Step 1: RED** —— `test-block-registry.js`：
  - `fingerprintOfPrefix(count) === fingerprint()`；
  - 追加 4 个方块后 `fingerprintOfPrefix(155) === 旧 fp`（用真实 BLOCKS 前 155 项构造对照）；
  - 中间插入一项后 `fingerprintOfPrefix(155) !== 旧 fp`（负向：真位移不能放行）；
  - `n > count` 时 throw。
- [ ] **Step 2: 跑 RED**。
- [ ] **Step 3: 实现 `fingerprintOfPrefix`**（把现有 `fingerprint()` 的循环体抽出共用，避免两份哈希）。
- [ ] **Step 4: GREEN**（单测）。
- [ ] **Step 5: 改 `game.js` 判定**：全等 → 兼容；否则 `meta.blockCount` 为整数且 ≤ count 且
      `fingerprintOfPrefix(meta.blockCount) === meta.blockFp` → 追加兼容（只更新 meta，不清档，
      打一条 `console.info`）；否则原清档路径。三处 saveMeta 补 `blockCount`。
- [ ] **Step 6: Playwright `tests/persistence.spec.mjs`**：既有「不匹配清档」用例仍绿（伪造 `deadbeef`
      且不带 blockCount）；新增「伪造旧前缀 fp + blockCount=155 → edits 保留、meta 修成当前值」。
- [ ] **Step 7: Commit** `fix(save): 末尾追加方块不再清档（前缀指纹判据）`

---

### Task 6: Tier 4 像素实测 + 文档 + 合并

**Files:**
- Modify: `tests/jungle-fortress.spec.mjs`（主材名 + 阈值按实测核对）
- Modify: `tests/ruined-citadel.spec.mjs`（新增紫珀像素判据 + 同机位对照组）
- Modify: `docs/roadmap.md`（v3.19 行）
- Modify: `CLAUDE.md`（高频坑：贴图等色重映射 / 512→16 相位 / 追加方块不清档）
- Modify: `playwright.config.mjs` + `server-script/start-server.js`（端口可配，默认仍 8081）

- [ ] **Step 1: 端口可配**（`MC_PORT` 环境变量，默认 8081；baseURL 同源）——
      ⚠️ 这是**测试基础设施**改动，默认行为逐位不变。
- [ ] **Step 2: 起本 worktree 的 8082 服务并核对内容归属**（`lsof -p` + `curl` 核关键字）。
- [ ] **Step 3: 跑 `jungle-fortress` / `ruined-citadel` / `atlas` / `m3-1-inventory` / `persistence`**，
      记录实测读数；阈值贴线则按实测重标（不放宽）。
- [ ] **Step 4: 紫珀像素判据带对照组**（`page.route` 换回 deepslate 重拍同一机位）。
- [ ] **Step 5: 全量单测** `node tools/run-unit-node.mjs --all`。
- [ ] **Step 6: 写 roadmap v3.19 + CLAUDE.md 高频坑**。
- [ ] **Step 7: Commit + 合并到 main**（`git checkout main && git merge --no-ff`），
      合并后在主仓跑 `npm run check` 复核。