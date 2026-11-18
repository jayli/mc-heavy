# 原版石砖 / 紫珀方块烘焙输入（v3.19）

**本目录是烘焙输入，不是渲染资源。** 产物落 `assets/textures/`（4 张 16×16），
由 `npm run stonebricks` 生成，之后必须 `npm run atlas` + `npm run icons`。

⚠️ **绝不能把这些文件放进 `assets/textures/`**：`build-atlas` 递归扫描那个目录，
512×512 的源图与 300×300 的参考渲染图会各变成一个被降到 128×128 的巨型 tile
（同 `assets/grass-textures/src/`、`assets/ruined-citadel/src/` 的处置）。

## 1. 三张石砖贴图（`mossy_/cracked_/chiseled_stone_bricks.png`，16×16）

**出处**：blockrender.dev 的 `https://blockrender.dev/texture/block/<id>.png`。
该服务把版本**钉在 Java Edition 26.2**（其 FAQ 原文：「The version is pinned rather than
followed」），故同一 URL 恒返回同一 PNG，烘焙可复现。

**为什么要重映射配色**（`reference/` 的用途）：blockrender 的色板与 Minecraft Wiki 现版
**方块渲染图**逐色不同（例：mossy 的灰砖 `8b898b` vs 渲染图 `888688`）。实测把
`reference/Mossy_Stone_Bricks_JE3_BE2.png`（300×300 等轴测）的**顶面**按
`tv=(148,0) / rv=(282,66) / lv=(14,66)` 反解逐 texel 取样后：

| 源图 | 与渲染图顶面的图案一致性 | 色数 |
|---|---|---|
| mossy_stone_bricks | 256/256 texel 分区一致，每源色唯一映一个渲染色（bad=0） | 12 |
| cracked_stone_bricks | 同上 | 7 |
| chiseled_stone_bricks | 同上 | 7 |
| stone_bricks（对照，本仓已有） | 同上 | 7 |

⇒ **图案完全一致，只差一层全局配色**。烘焙器据此把色值换成 wiki 现版配色，
图案（哪些格是砖缝、哪些格是苔藓）逐格不动。这条判据由 `check:data` 的 `[石砖贴图]` 复核。

`reference/` 只在烘焙期读，**不进 atlas、不进运行期**。

## 2. `purpur_block.png`（512×512，用户提供）

**出处**：用户 2026-11-19 指定的 `/Users/bachi/ttt/b/purpur_block.png`，逐字节复制入库。

实测它是 **16×16 texel 的放大图**：不透明 bbox `[25,486]²`（462×462），
每 texel 28.875px，边缘一圈半透明抗锯齿（1844 px，全在 bbox 边界上）。
按 texel 中心取样 → 16×16，**逐格与该 texel 区域的众数完全一致（0/256 不符）**，
区域纯度 98.29%（207987/211600）⇒ 无损还原。

⚠️ **配色刻意保留用户图**（均值 135.53/100.34/135.29），它比 vanilla `purpur_block`
（blockrender 均值 169.92/125.92/169.68）**暗一档**。用户原话是「面用的图是这张」，
故不换成 vanilla 版；两者图案同构（实测 bad=0），只差配色。

## 3. 许可备注

- blockrender.dev 的说明：「The renders are made from Mojang's textures, so the same rules
  apply as to a screenshot or a wiki image: fine for fan sites, wikis, plugin pages …
  not for anything that passes itself off as an official Minecraft product.」
- 入库的是 **4 张小贴图 + 4 张参考渲染图**（合计 ~26KB），不是材质包，
  与既有 `assets/grass-textures/src/vanilla/` 同口径。
- 本仓库不声称是官方 Minecraft 产品。
- 结构数据（`assets/jungle-fortress/src/`）的 LGPL-3.0 出处见该目录自己的 README。