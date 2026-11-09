# burning_arena 烘焙输入（8 片 nbt）

**出处**：L_Ender's Cataclysm mod（Minecraft 1.19.2 Forge），
`src/main/resources/data/cataclysm/structures/burning_arena{1..8}.nbt`。

**内容**：仅**方块布局数据**（Minecraft structure NBT：`size` / `palette` / `blocks`）。
不含该模组的 Java 代码，不含其自定义方块贴图，不含原版 Minecraft 资源。

**用途**：`npm run burningarena` 的烘焙输入 —— 把 8 片按
`Burning_Arena_Structure.java` 的 OFFSET 表拼合成 85×85×80 的单体结构，重映射到本仓
现有方块（方案 A：只换数据格式，不新增方块/贴图），产出
`assets/structures/burning_arena.json`。

**许可备注**：源仓库的 `LICENSE.txt` 是 Forge MDK 模板（LGPL），未声明模组本体许可。
入库的这 8 个文件是数据（方块坐标 + 方块名），非可执行代码。
