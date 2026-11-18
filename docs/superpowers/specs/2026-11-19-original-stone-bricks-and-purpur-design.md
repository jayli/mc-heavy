# 丛林要塞原版石砖 + 末日地堡紫珀方块（v3.19）设计

日期：2026-11-19　分支：`feat/original-stone-blocks-purpur`

## 1. 意图与背景（用户原话）

> 现在丛林要塞中的方块有一部分是用已有的方块来代替的，没有做原版方块的烘焙，现在除了台阶
> 方块之外，其他的方块都用原版里提供的方块重新烘焙出来，并加到背包里，即从
> `/Users/bachi/jaylli/RepurposedStructures` 这里烘焙出丛林要塞的石头建筑中缺失的方块，
> 台阶方块除外。
>
> 末日地堡里的 deepslate 方块都替换成紫色方块，Purpur Block，这是一个新方块，面用的图是
> `/Users/bachi/ttt/b/purpur_block.png`，六个面都用这个图，请你根据这个图烘焙出正确大小的
> 贴图，并在游戏中新增这个方块，新增到背包里，代替末日地堡里的 deepslate 方块。

两件事共同的诉求：**别再拿近似方块凑**，把原版真正的那几种石头做出来。

「末日地堡」= 废弃堡垒 `ruined_citadel`（用户俗称，见既有约定）。

## 2. 现状（全部实测，不是读注释）

### 2.1 丛林要塞现在用的是替身

`tools/bake-jungle-fortress.mjs` 的 `STONE_VARIANTS` 把上游生成期随机固化成四档，
但四档里有三档是**替身**：

| 上游概率 | 原版方块 | 现在映到 | 那个替身的真实贴图 |
|---|---|---|---|
| 50% | `mossy_stone_bricks` | `mossy_stone` | `Mossy_Cobblestone` —— **苔石圆石**，不是砖 |
| 25% | `cracked_stone_bricks` | `cobblestone` | `Cobblestone` —— **圆石** |
| 5% | `chiseled_stone_bricks` | `tuff_bricks` | `Tuff_Bricks` —— **凝灰岩砖**（偏绿） |
| 20% | `stone_bricks` | `stone_bricks` | `Stone_Bricks`（本仓已有，但是**旧版图案**，80 色） |

实测格数（`materialize()` 直接跑）：mossy_stone 30503 / cobblestone 15085 /
stone_bricks 12092 / tuff_bricks 3012，合计 **60692 格 = 全部石砖族**。

源 nbt 普查（17 片）确认石砖族只有 `stone_bricks`（5749 格次）+ `red_stained_glass`
（588，pillar_processor 的柱子占位符，也映 stone_bricks）。苔藓/裂纹/雕纹**不在 nbt 里**，
由 `processor_list/fortresses/jungle_main.json` 按概率替换 —— 本仓已把这套概率固化。

其余非台阶源方块的现状：`iron_bars` → 手拉手栏杆（v3.13b 用户明确要的自家几何，**不动**）、
`coarse_dirt` → `dirt`、`brown_mushroom` → `red_mushroom`、`chest`/`water` 同名直通。
它们**不属于「石头建筑」**，本期不动（见 §3 非目标）。

### 2.2 废弃堡垒的 deepslate 就是紫珀族的替身

`tools/ruined-citadel-fingerprint.mjs`：

```
purpur_block: 'deepslate'                        // 2799 格
purpur_pillar: 'deepslate'                       //  263 格
'cataclysm:purpur_void_rune_trap_block': 'deepslate'  //   70 格
SLAB_BASE.purpur_slab: 'deepslate'               // top/double 半砖 → 整块
```

产物实测 `deepslate` **4210 格**。v2.90 用户裁定从 `amethyst` 改成 `deepslate`，
理由当时是「本仓无紫珀贴图」。现在用户给了贴图 ⇒ 该前提消失。

⚠️ **其他用 deepslate 的地方一律不动**：高台/拱洞（`cloudland-kit-fingerprint`）、
大竞技场（`burning-arena-fingerprint` 的 blackstone 族）。用户说的是「末日地堡里的」。

### 2.3 贴图从哪来（关键约束，实测）

- `~/jaylli/RepurposedStructures` 的 `assets/repurposed_structures/` **只有 lang + logo**，
  零方块贴图（`find *.png` 只出 `images/` 里的宣传截图）。**它提供的是结构数据与方块名，
  不是贴图**。
- 本仓 `assets/textures/` 与 mc-lite 都没有 mossy/cracked/chiseled **stone bricks**。
- 用户给的 `purpur_block.png` 是 **512×512**，实测 = 16×16 texel 的**放大渲染图**：
  不透明 bbox `[25,486]²`（462×462），每 texel 28.875px，边缘一圈半透明抗锯齿。
  按 texel 中心取样得 16×16，**逐格与该 texel 区域的众数完全一致（0/256 不符）**，
  区域纯度 98.29% ⇒ 可以无损还原成 16×16。

## 3. 目标 / 非目标 / 反目标

**目标**
1. 新增 3 个原版石砖方块：`mossy_stone_bricks` / `cracked_stone_bricks` / `chiseled_stone_bricks`，
   贴图取自 vanilla，丛林要塞石砖族四档全部用原版方块。
2. 新增 `purpur_block`，六面同一张贴图，由用户给的 512×512 图烘成 16×16；
   废弃堡垒里 4210 格 deepslate 全部换成它。
3. 4 个新方块全部进背包（用户明确要求；本仓背包是派生集合，跑 `npm run icons` 即可）。
4. 老存档**不清档**（见 §5.4，这是本期唯一的运行期代码改动）。

**非目标**
- 台阶（`stone_brick_stairs` / `mossy_stone_brick_stairs`）：用户点名除外，仍映 `cobblestone_step`。
- 栏杆：v3.13b 用户裁定用自家手拉手几何，不动。
- `coarse_dirt` / `brown_mushroom` / `chest` / `water`：不是石头，不动。
- 其他结构的 deepslate / mossy_stone / cobblestone / tuff_bricks：不动。
- 不移植上游的 gravel / suspicious_gravel / infested 变体、刷怪笼、破洞语义（既有偏离，保留）。

**反目标（做成了也算失败）**
- 新增贴图落进 `assets/textures/` 的源图目录 ⇒ 被 build-atlas 递归扫成巨型 tile。
- 新方块插在 `BLOCKS` 数组中间 ⇒ 旧存档数字 id 位移。
- 为了「让新方块进背包」而清掉玩家已有 edits。
- 像素判据只钉「有紫色」而不带对照组 ⇒ 分不清「真换了」与「本来就有的紫」。

## 4. 三条可行路线与取舍

### 路线 A（采纳）：vanilla 贴图等色重映射入库 + 用户图降采样

- 三张石砖贴图：取 blockrender.dev 的 `/texture/block/<id>.png`（16×16，钉 Java 26.2），
  **按 vanilla 官方渲染图的逐 texel 对应关系重映射成 wiki 现版配色**后入库。
  为什么要重映射：blockrender 的色板与 wiki 现版渲染图**逐色不同**（例：mossy 的
  `8b898b` vs 渲染图 `888688`）。实测把 wiki 300×300 等轴测渲染图的**顶面**按
  `TV=(148,0) / RV=(282,66) / LV=(14,66)` 反解，四张图（含 stone_bricks 对照）
  **256/256 texel 与 blockrender 图案逐格同构、每个源色唯一映到一个渲染色（bad=0）**
  ⇒ 图案一致、只差一层全局配色。取 wiki 配色 = 与官方观感一致，且**可复现可验证**。
- `purpur_block`：用户 512×512 图按 texel 中心取样 → 16×16（§2.3 已验无损）。
  ⚠️ 用户图比 vanilla 暗一档（均值 135.5/100.3/135.3 vs blockrender 169.9/125.9/169.7），
  **保留用户图的配色**（用户指定「面用的图是这张」）。
- 代价：多一个离线烘焙脚本 + 一个指纹模块 + 一份出处说明；素材入库 ~2KB。
- 收益：零运行期渲染改动（4 个 `geometry:"box"` + `cullMode:"opaque"`），
  mesher / materials / CAPACITY 全不动。

### 路线 B（否决）：直接用 blockrender 的原始字节

省掉重映射，但配色与官方现版渲染图差一层（实测每色都差 2~6），
且**无法解释「为什么和 wiki 不一样」**。既然重映射有 bad=0 的可验证判据，就不留这个疑问。

### 路线 C（否决）：程序化生成近似贴图

不新增素材，但那是「再造一个替身」——正是用户这次要消除的东西。

### 路线 D（否决）：purpur 直接用 vanilla purpur_block 贴图

用户明确给了自己那张图。vanilla 版更亮，观感不同 ⇒ 违背指令。

## 5. 设计细节

### 5.1 素材与产物布局

```
assets/stone-bricks/src/            ← 烘焙输入（**不在 assets/textures/ 下**）
  README.md                         出处 / 许可 / 重映射口径
  mossy_stone_bricks.png            blockrender 16×16 原字节
  cracked_stone_bricks.png
  chiseled_stone_bricks.png
  purpur_block.png                  用户 512×512 原图（逐字节复制）
  reference/                        wiki 300×300 等轴测渲染图（配色权威，仅烘焙期读）
    Mossy_Stone_Bricks_JE3_BE2.png ...
assets/textures/
  mossy_stone_bricks.png            ← 产物 16×16（进 atlas）
  cracked_stone_bricks.png
  chiseled_stone_bricks.png
  purpur_block.png
  stone_bricks.meta.json            伴生指纹（4 张一份）
```

`npm run stonebricks` → `tools/bake-stone-bricks.mjs`，之后必须 `npm run atlas` + `npm run icons`。

### 5.2 烘焙算法（纯函数落 `tools/stone-bricks-parse.mjs`，无 `node:` 依赖）

两个函数，浏览器单测与 node 烘焙器共用（红线 1/8，手法照 `turret-top-parse.mjs`）：

- `topFaceColorMap(render, tex)`：从 300×300 渲染图顶面反解「源色 → 渲染色」。
  逐 texel 取样，要求**每个源色只映到一个渲染色**（否则 throw）。
- `remapPalette(tex, map)`：按映射换色，alpha 原样。
- `downsampleByTexelCenter(src, {origin, span, size})`：512×512 → 16×16，
  texel 中心取样 + **众数一致性自检**（不一致即 throw）。

判据（烘焙期自守 + `check:data` 复核）：
- 三张石砖产物与源图**图案逐格同构**（同色分区不变），只有色值变；
- 重映射后产物均值 = 预先标定的目标值（±0.05/通道）；
- purpur 产物 16×16、alpha 全 255、7 种色、均值 135.5273/100.3398/135.2891；
- purpur 每 texel == 源图该 texel 区域众数（内容级判据，指纹拓不到「取样相位错了」）。

### 5.3 方块声明与映射改动

`src/voxel/blocks-data.js` **末尾追加 4 行**（id 155~158，既有 155 个 id 逐位不变）：
全部 `{"solid":true,"cullMode":"opaque","orientationModes":0,"geometry":"box"}`。
`faces-data.js` 四项都是单 tile 字符串（purpur 六面同图 = 用户明确要求）。

丛林要塞 `STONE_VARIANTS.bands`：
`mossy_stone → mossy_stone_bricks` / `cobblestone → cracked_stone_bricks` /
`tuff_bricks → chiseled_stone_bricks`；概率、seed、阈值口径**一字不动**
⇒ 格数逐档不变（30503 / 15085 / 3012 / 12092），palette 仍 13 种，bbox 与 floorRow 不变。

⚠️ **墩材质跟着改**：`jungle-fortress-terrain.js` 的石墩写 `mossy_stone`，
理由是「材质选建筑主材」；主材换了名字，墩必须跟着换 `mossy_stone_bricks`，
否则墩与墙是两种石头（用户看不出错，但那是第二套口径）。墩格数/列数冻结表不变。

废弃堡垒：`BLOCK_MAP` 三个 purpur 源 + `SLAB_BASE.purpur_slab` 全部 `deepslate → purpur_block`。
`STAIR_TARGETS.purpur_stairs` / `SLAB_BOTTOM.purpur_slab` **不动**（台阶/半砖不在本期范围）。
⇒ `deepslate` 4210 → 0，`purpur_block` 0 → 4210，palette 仍 34 种。

### 5.4 存档兼容（唯一的运行期改动）

现状：`Game.start` 比 `meta.blockFp !== registry.fingerprint()` 就
**清空全部 edits + entities**。实测追加 4 个方块后指纹 `fc6212f5 → 16d99151`
⇒ 老玩家手工建造全丢，而**既有 id 一个都没动**（实测 `BLOCKS.every((d,i)=>idOf(d.name)===i)` 为真）。

修法：指纹判据从「全等」改成「**旧清单是当前清单的前缀**」。
- `BlockRegistry` 新增 `fingerprintOfPrefix(n)`（同一 FNV 算法，只算前 n 项）与
  `nameCountOf` 不需要 —— 直接在 `game.js` 侧用「旧 meta 记的 `blockCount`」判定。
- meta 行新增 `blockCount`（旧存档没有 ⇒ 回落「全等」老口径，行为不变）。
- 判定：`blockFp === fp` → 兼容；否则若 `meta.blockCount` 存在且
  `fingerprintOfPrefix(meta.blockCount) === meta.blockFp` 且 `blockCount <= 当前 count`
  → **追加兼容**，只更新 meta，不清档；否则走原清档路径。
- 单一权威：前缀指纹算法在 registry 里，`game.js` 不自己算哈希。

这条改动**必须 TDD**（Tier 1：数据模型 + 存档契约），且负向验证要钉
「中间插入/删除仍清档」——否则放宽成了「什么都不清」。

### 5.5 门禁与测试

- `check:data` 新增 `[石砖贴图]` 环节：4 张产物存在 / 尺寸 16 / 指纹匹配 / 均值命中 /
  purpur 众数一致性 / 三张石砖与源图图案同构。
- `[丛林要塞]`：`targetCounts` 换名 + 新增「**不得含替身**」判据
  （palette 不含 `mossy_stone` / `cobblestone` / `tuff_bricks`）——这是本期意图的直接判据。
- `[废弃堡垒]`：`targetCounts` 的 deepslate → purpur_block；新增「palette 不含 deepslate」；
  新方块进背包的派生集合要带上 purpur_block（现有派生规则只认 `cataclysm:X→X`，
  purpur 是 vanilla 名 ⇒ 需把「本期新烘方块」显式列入指纹模块的一个常量，两侧共用）。
- 单测：新增 `src/tests/test-stone-bricks.js`（烘焙纯函数 + 4 个方块声明 + faces 映射 +
  进背包 + id 追加不位移）；改 `test-jungle-fortress-gen.js`（palette/主材/墩材质）、
  `test-ruined-citadel-gen.js`（若有 deepslate 判据）、`test-block-registry.js` /
  `test-inventory.js` / `test-inventory-ui.js` / `test-orientation.js` 的冻结计数
  155→159 / 145→149 / 136→140 / 109→113。
- Tier 4 像素：丛林要塞俯瞰「灰石占比」判据仍成立（新贴图仍是低饱和灰绿，均值实测
  115/121/105、118/118/118、120/119/120，全部落在既有 `lum∈[55,175]` 且极差≤30 的口径内）；
  废弃堡垒新增「紫珀像素占比」判据，**必须带同机位对照组**（`page.route` 换回 deepslate）。

## 6. 验证口径

1. `npm run stonebricks` → `npm run atlas` → `npm run icons`；
2. `npm run junglefortress` / `npm run ruinedcitadel` 重烘（先 `--census` 核实测值再重标冻结）；
3. `npm run check`（arch + data + lint）；
4. `node tools/run-unit-node.mjs --only=...` 跑改动相关单测，再 `--all`；
5. Playwright：`jungle-fortress` / `ruined-citadel` / `atlas` / `m3-1-inventory` /
   `persistence`（存档兼容）；
6. 像素实测在**本 worktree 自己的端口**上跑（8081 被主仓占用，实测 PID 31879 cwd=主仓）。

## 7. 风险

| # | 项 | 处置 |
|---|---|---|
| R1 | 用户 purpur 图比 vanilla 暗一档 | 保留用户配色（指令优先），均值冻结进指纹 |
| R2 | 存档兼容放宽后「中间插入」也放行 | 前缀指纹 + `blockCount` 双判据，负向验证钉住 |
| R3 | 新贴图色调与原替身不同 ⇒ 既有像素阈值贴线 | 先实测新均值再判是否需要重标（不擅自放宽） |
| R4 | 三张 vanilla 贴图的许可 | 与既有 `assets/grass-textures/src/vanilla/` 同口径入库 + README 注明出处；不冒充官方产品 |
| R5 | 墩材质改名波及 8 seed 冻结表 | 格数/列数不依赖材质名 ⇒ 冻结值应逐位不变，实测核对 |