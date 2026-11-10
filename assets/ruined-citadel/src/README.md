# ruined_citadel 烘焙输入（18 片 nbt）

**出处**：L_Ender's Cataclysm mod（Minecraft 1.19.2 Forge），
`src/main/resources/data/cataclysm/structures/ruined_citadel{1..18}.nbt`。

**内容**：仅**方块布局数据**（Minecraft structure NBT：`size` / `palette` / `blocks`）。
不含该模组的 Java 代码，不含其自定义方块贴图，不含原版 Minecraft 资源。

**用途**：`npm run ruinedcitadel` 的烘焙输入 —— 把 18 片按
`RuinedCitadelStructure.java` 的 OFFSET 表拼合成 106×63×108 的单体结构
（下层 9 片 y 偏移 -45 是 44 层地牢主体，上层 9 片 y 偏移 0 是甲板 + 塔楼），
重映射到本仓方块（9 个整块/柱 + 4 台阶 + 2 半砖照 mod 自带贴图新烘焙，
其余映到既有方块），产出 `assets/structures/ruined_citadel.json`。

**许可备注**：源仓库的 `LICENSE.txt` 是 Forge MDK 模板（LGPL），未声明模组本体许可。
入库的这 18 个文件是数据（方块坐标 + 方块名），非可执行代码。
