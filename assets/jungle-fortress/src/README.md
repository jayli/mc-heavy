# fortress_jungle 烘焙输入（17 片 nbt）

**出处**：Repurposed Structures mod（TelepathicGrunt），本地检出
`~/jaylli/RepurposedStructures`，路径
`common/src/main/resources/data/repurposed_structures/structure/fortresses/jungle/*.nbt`。
上游版本 `mod_version=7.8.4`（`gradle.properties`）。

**内容**：仅**方块布局数据**（Minecraft structure NBT：`size` / `palette` / `blocks`，
其中 `jigsaw` 格携带 `pool` / `target` / `final_state` 等拼装元数据）。
不含该模组的 Java 代码，不含任何方块贴图 —— 源仓库 `assets/repurposed_structures/`
只有 lang 与 logo（实测），**不含原版 Minecraft 资源**。

**用途**：`npm run junglefortress` 的烘焙输入。与既有 8 个烘焙结构不同，本结构的素材是
**jigsaw 动态拼装**（17 个件 + 权重池 + 10 层递归），故烘焙器先按
`PieceLimitedJigsawManager.java` 的语义**离线拼出一个定版布局**
（`tools/jungle-fortress-fingerprint.mjs` 的 `JUNGLE_FORTRESS_ASSEMBLE`，seed=263
⇒ 193 件 / 17 种件全出现 / 159×33×155），再做空气分层 / 支撑柱 / 石砖族变体 /
藤蔓 / 栏杆朝向，产出 `assets/structures/jungle_fortress.json`。

**重映射口径**：**零新增方块、零新增几何、零新增贴图** —— 13 种源方块全部映到既有方块
（石砖族四色按上游 processor 概率固化；`iron_bars` → `handrailA`/`handrail` 手拉手栏杆；
台阶 → `cobblestone_step`；`spawner` 丢弃）。详见
`docs/superpowers/specs/2026-11-17-jungle-fortress-port-design.md` DR-3。

**许可备注**：源仓库 `LICENSE.txt` 是 **GNU LGPL-3.0**（实测首行
`GNU LESSER GENERAL PUBLIC LICENSE / Version 3, 29 June 2007`）。
入库的这 17 个文件是**数据**（方块坐标 + 方块名 + 拼装元数据），非可执行代码。