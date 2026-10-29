// src/voxel/blocks-data.js — 126 方块声明数据
// 来源：mc-lite src/constants/BlockData.js（BLOCK_DATA，124 键）+
//       src/core/LightSourceManager.js（LIGHT_CONFIGS，4 个发光方块 → emissive: 15）
// 转换日期：2026-08-19。转换规则见 docs/superpowers/plans/2026-08-19-m0-engine-skeleton.md Task 5：
//   isSolid → solid；isTransparent && !isRendered → cullMode 'none'；
//   geometryType ∈ {flower,vine,lilypad,cactus} 或名字含 leaves → 'cutout'（8 个树叶族，
//   其中 sky_leaves 已于天空树 Epic 改回 'opaque' —— mc-lite 材质无 alphaTest，见该行注释）；
//   其余 isTransparent → 'transparent'；其余 → 'opaque'。
//   orientationEnabled → orientationModes 4/0；geometryType → geometry 原样保留。
// 阴影勘误（§4.4.4）：`shadowCast:false` 对齐 mc-lite `BlockData.isShadowEnabled:false`
// （实测解析其 124 键：102 项投影 / 20 项不投影）。mc-lite 那 20 项里 air/collider/water/
// swamp_water/realistic_trunk_collider 在 mc-heavy 走 cullMode 'none'/'transparent'（通道级
// 已排除投影），bed_alias_block/mine_cart 不是方块 → **只需给落在 opaque/cutout 通道的 13 项
// 声明本字段**。消费方：registry.shadowCastTable → mesher 写 packed bit14 → materials.js
// 的 `maskShadowNode` 在阴影 pass 逐片元 discard（主 pass 不受影响）。
// M2 勘误（cullMode 语义）：cullMode 是渲染通道选择，须对齐 mc-lite 的**材质**透明度
// （MaterialManager 注册），而非 BlockData.isTransparent（面剔除语义）。12 个不透明材质
// 方块（4 台阶 + 3 栏杆 + 2 柱子 + chest + azalea_flowers + hanging_lamp）由
// 'transparent' 改 'cutout'——blended 通道 depthWrite=false 致 L 形台阶凹角透视穿帮。
// 剔除语义由 opaqueTable 独立承担（这些方块仍不剔除邻居面）。详见设计文档 §4.1 勘误。
// v1.96 勘误：`cloud` 由 `solid:false` 改 `solid:true`（云不可穿越）——与 mc-lite 的
// `isSolid:false` 相反，**有意偏离**，理由与六个消费方见下面 cloud 行注释。
// 注意：air 必须是第一个元素（ID 0）。faces 纹理映射在 faces-data.js（对齐 MaterialManager）。

export const BLOCKS = [
  {"name":"air","solid":false,"cullMode":"none","orientationModes":4,"geometry":"box"},
  {"name":"collider","solid":true,"cullMode":"none","orientationModes":4,"geometry":"box"},
  {"name":"water","solid":false,"cullMode":"transparent","orientationModes":4,"geometry":"box"},
  {"name":"swamp_water","solid":false,"cullMode":"transparent","orientationModes":4,"geometry":"box"},
  // M2-7 通道勘误（§4.1 口径）：mc-lite 云材质 mkMat('#FFFFFF',1) opacity=1 不透明；
  // 原 'transparent' 通道 depthWrite=false 使云块侧面混叠成方格缝。opaqueTable 仍 0（不遮光）。
  //
  // v1.96：**cloud 改 solid:true（用户裁定：云不可穿越）**。此前 `isSolid:false` 是有意偏离
  // mc-lite（M2-7 只给了「向下可站立」），但实玩上「能穿过云」是被否掉的体验。
  // `solid` 是 registry 的单一权威表 → 六个消费方**零代码改动**跟着变：
  //   ① 玩家物理 `_collides`（水平撞云墙 / 向上撞云底 / step-up）
  //   ② 丧尸物理与站立判据（`zombie-system.js`）
  //   ③ 炮塔 LOS + 弹丸阻挡（`isProjectileOccluding = solid && opaque`，云两项都是 1）
  //   ④ 矿车「前方实心不能穿」与「玩家头顶净空」
  //   ⑤ 雨滴地面截停（`rain.js`）⑥ 放置兜底遮挡 / 结构 ground-support 探地
  // ⚠️ **`supportsPlayer:true` 保留**：它与 `solid` 是**叠加**关系而非替代 —— 可站立语义
  // 原样不动（`isSolid` 先命中，该表成为冗余但无害的第二道门）。删掉它会改动「向下碰撞」
  // 的分支组合，属无收益的行为变更。`opaque` / `shadowCast` 两项也**未动**。
  {"name":"cloud","solid":true,"supportsPlayer":true,"cullMode":"opaque","orientationModes":4,"geometry":"box","shadowCast":false},
  {"name":"glass_block","solid":true,"cullMode":"transparent","orientationModes":4,"geometry":"box"},
  {"name":"glass_blink","solid":true,"cullMode":"transparent","orientationModes":4,"geometry":"box"},
  // ---- 树叶类：全部 `cutout` 通道 + `opaque:true`（2026-10-23 用户裁定，对齐巨树叶）----
  // `cutout` = 拿到 alphaTest 0.3（镂空生效）；`opaque:true` = opaqueTable 1（叶-叶共享面互剔）。
  // 实测单棵普通树（树干 + 5³ 叶团）总顶点 3068 → **664（−78.4%）**。
  // ⚠️ `opaqueTable=1` 的其余三项后果是**用户明确接受的有意变更**：
  //   ① AO 遮挡（树叶让邻居方块变暗）② blocklight 阻断（火把光透不过树冠）
  //   ③ 炮塔 LOS / 弹丸阻挡 —— **这项改变了玩法**：树叶现在会挡住炮塔视线、弹丸被树叶拦截
  //      （mc-lite 口径是「实心且不透明」，树叶可穿透）。巨树叶自 Epic 起已是这个语义。
  //   四个消费方共用 opaqueTable，故无需改任何消费者代码。
  // ⚠️ **v1.70 新增反方向规则**（mesher 面剔除）：镂空体（本组）不再能当邻居面剔除的遮挡依据——
  //   `hollowOccluderTable` 由 cutout + opaqueTable=1 派生，命中时**不剔**邻居方块朝向它的那一面
  //   （否则玩家透过叶孔看穿背后的空气）。代价 = 每条「实心↔树叶」接触面 +1 面。
  //   叶-叶共享面不受影响（双方都是镂空体，走 cullMode/SAME_TYPE_CULL 分支）。
  {"name":"leaves","solid":true,"cullMode":"cutout","opaque":true,"orientationModes":4,"geometry":"box"},
  {"name":"birch_log","solid":true,"cullMode":"opaque","orientationModes":0,"geometry":"box"},
  {"name":"wood","solid":true,"cullMode":"opaque","orientationModes":0,"geometry":"box"},
  {"name":"dark_oak","solid":true,"cullMode":"opaque","orientationModes":0,"geometry":"box"},
  {"name":"sky_wood","solid":true,"cullMode":"opaque","orientationModes":0,"geometry":"box"},
  {"name":"azalea_log","solid":true,"cullMode":"opaque","orientationModes":0,"geometry":"box"},
  {"name":"azalea_leaves","solid":true,"cullMode":"cutout","opaque":true,"orientationModes":4,"geometry":"box"},
  {"name":"azalea_flowers","solid":true,"cullMode":"cutout","opaque":true,"orientationModes":4,"geometry":"box"},
  {"name":"yellow_leaves","solid":true,"cullMode":"cutout","opaque":true,"orientationModes":4,"geometry":"box"},
  // 通道勘误（方案 C，spec §2.6）：mc-lite 材质是 mkMat('#FF69B4', 0.9) =
  // transparent+opacity，**无 alphaTest** → 不是镂空。原 'cutout' 是 M2-7 按
  // 「名字含 leaves」归类的偏差；cutout 通道 alphaTest=0.3 且无 transparent →
  // 贴图 alpha 0.902 全保留不混合，实际渲染本就是**不透明纯粉**（atlas 实测印证）。
  // 改 opaque 后叶-叶相邻面开始互剔（mesher.js:464 判据 opaqueTable[neighbor]===1），
  // 面数 735,576→700,064；连带效应（AO 遮挡 / blocklight 阻断 / 炮塔 LOS 阻挡）
  // 见 spec §2.6.3，均为有意偏离 mc-lite。
  {"name":"sky_leaves","solid":true,"cullMode":"opaque","orientationModes":4,"geometry":"box"},
  {"name":"realistic_oak_leaves","solid":true,"cullMode":"cutout","opaque":true,"orientationModes":4,"geometry":"box"},
  {"name":"realistic_yellow_leaves","solid":true,"cullMode":"cutout","opaque":true,"orientationModes":4,"geometry":"box"},
  {"name":"flower","solid":false,"cullMode":"cutout","orientationModes":4,"geometry":"flower","shadowCast":false},
  {"name":"short_grass","solid":false,"cullMode":"cutout","orientationModes":4,"geometry":"flower","shadowCast":false},
  {"name":"allium","solid":false,"cullMode":"cutout","orientationModes":4,"geometry":"flower","shadowCast":false},
  {"name":"azure_bluet","solid":false,"cullMode":"cutout","orientationModes":4,"geometry":"flower","shadowCast":false},
  {"name":"dead_bush","solid":false,"cullMode":"cutout","orientationModes":4,"geometry":"flower","shadowCast":false},
  {"name":"oxeye_daisy","solid":false,"cullMode":"cutout","orientationModes":4,"geometry":"flower","shadowCast":false},
  {"name":"red_mushroom","solid":false,"cullMode":"cutout","orientationModes":4,"geometry":"flower","shadowCast":false},
  {"name":"vine","solid":false,"cullMode":"cutout","orientationModes":4,"geometry":"vine","shadowCast":false},
  {"name":"lilypad","solid":false,"cullMode":"cutout","orientationModes":4,"geometry":"lilypad","shadowCast":false},
  {"name":"cactus","solid":true,"cullMode":"cutout","orientationModes":4,"geometry":"cactus"},
  {"name":"handrail","solid":true,"cullMode":"cutout","orientationModes":4,"geometry":"handrail"},
  {"name":"handrailA","solid":true,"cullMode":"cutout","orientationModes":4,"geometry":"handrailA"},
  {"name":"handrailB","solid":true,"cullMode":"cutout","orientationModes":4,"geometry":"handrailB"},
  {"name":"vertical_pillar","solid":true,"cullMode":"cutout","orientationModes":4,"geometry":"vertical_pillar"},
  {"name":"horizontal_pillar","solid":true,"cullMode":"cutout","orientationModes":4,"geometry":"horizontal_pillar"},
  // 剔除语义勘误（2026-09-30）：显式 `opaque:false` → opaqueTable=0（不剔除邻居面），
  // cullMode 仍 'opaque'（留在 opaque 通道，材质不透明 mkMat('#7f5b37') 无 alphaTest）。
  //
  // **根因是转换规则漏网**：registry 按 `cullMode === 'opaque'` 推 opaqueTable，而
  // cullMode 是**渲染通道**语义、opaqueTable 是**面剔除**语义（两套口径，见文件头 M2 勘误）。
  // 实测本仓库**全部非 box 几何的方块 opaqueTable 都是 0**（flower/vine/台阶/柱子/吊灯…
  // 因为它们 cullMode 都是 cutout）—— 唯二的例外是 chimney 与 bed_head/bed_tail：
  // 它们因材质不透明被归进 opaque 通道，连带被误判成「占满整格、可剔除邻居面」。
  //
  // 后果（用户报告）：mesher 剔掉烟囱下方屋顶块的顶面 → 「烟囱底部接触的方块面是透明的」。
  // 几何上 chimney 是 r=0.15 的细圆柱（`prismQuads`，y∈[-0.5,1.5]），本就不占满整格，
  // 拿它当遮挡体去剔邻居面在任何口径下都错。mc-lite 侧是实例级渲染
  // （`CylinderGeometry(0.15,0.15,2,8)`，ChunkConsolidation.js:98），根本没有面剔除这一步。
  //
  // 修法 = cloud 同款手法（cullMode 与 opaque 解耦）。连带效应：不再遮挡 AO /
  // 不阻断 blocklight（lighting.js 读 opaqueTable）/ 不挡炮塔 LOS（turret-system.js:31）——
  // 细圆柱本来就不该完全遮光挡视线，这三项都是修正而非回退。
  // ⚠️ bed_head/bed_tail（half_block）是同类漏网，但已从背包移除、实际不会被放置，暂不修。
  {"name":"chimney","solid":true,"opaque":false,"cullMode":"opaque","orientationModes":0,"geometry":"chimney"},
  {"name":"swamp_leaves","solid":true,"cullMode":"cutout","opaque":true,"orientationModes":4,"geometry":"box"},
  {"name":"snow_leaves","solid":true,"cullMode":"cutout","opaque":true,"orientationModes":4,"geometry":"box"},
  {"name":"calcite","solid":true,"cullMode":"opaque","orientationModes":0,"geometry":"box"},
  {"name":"end_stone","solid":true,"cullMode":"opaque","orientationModes":0,"geometry":"box"},
  {"name":"iron","solid":true,"cullMode":"opaque","orientationModes":0,"geometry":"box"},
  {"name":"diamond","solid":true,"cullMode":"opaque","orientationModes":0,"geometry":"box"},
  {"name":"obsidian","solid":true,"cullMode":"opaque","orientationModes":0,"geometry":"box"},
  {"name":"moss","solid":true,"cullMode":"opaque","orientationModes":0,"geometry":"box"},
  {"name":"chest","solid":true,"cullMode":"cutout","orientationModes":4,"geometry":"box"},
  {"name":"realistic_trunk_collider","solid":true,"cullMode":"none","orientationModes":4,"geometry":"box"},
  {"name":"playground_block","solid":true,"cullMode":"opaque","orientationModes":0,"geometry":"box","indestructible":true,"shadowCast":false},
  {"name":"playground_center_block","solid":true,"cullMode":"opaque","orientationModes":0,"geometry":"box","indestructible":true,"shadowCast":false},
  {"name":"sand","solid":true,"cullMode":"opaque","orientationModes":0,"geometry":"box"},
  // 巨型金字塔（Giant Pyramid Epic）：沙子系台阶/半砖。**几何零新增** —— 复用既有
  // `planks_step`（L 形 2 箱体）/ `half_block`（1 箱体）模板，形状与 UV 的唯一权威仍在 mesher.js。
  // ⚠️ 必须**显式** `opaque:false`：cutout 通道的默认推导已是 0，但 AGENTS.md 要求非 box 几何
  // 显式声明 —— 否则将来有人把 cullMode 改成 opaque 就会静默误推 opaqueTable=1
  // → mesher 剔掉邻居方块朝向台阶的那一面 → 塔身出现洞。
  // ⚠️ 两者都进背包（玩家挖下来能拿起），故改贴图或几何后须跑 `npm run icons`。
  {"name":"sand_step","solid":true,"cullMode":"cutout","opaque":false,"orientationModes":4,"geometry":"planks_step"},
  {"name":"sand_slab","solid":true,"cullMode":"cutout","opaque":false,"orientationModes":0,"geometry":"half_block"},
  {"name":"stone","solid":true,"cullMode":"opaque","orientationModes":0,"geometry":"box"},
  {"name":"stone_diorite","solid":true,"cullMode":"opaque","orientationModes":0,"geometry":"box"},
  {"name":"mossy_stone","solid":true,"cullMode":"opaque","orientationModes":0,"geometry":"box"},
  {"name":"cobblestone","solid":true,"cullMode":"opaque","orientationModes":0,"geometry":"box"},
  {"name":"bricks","solid":true,"cullMode":"opaque","orientationModes":0,"geometry":"box"},
  {"name":"planks","solid":true,"cullMode":"opaque","orientationModes":0,"geometry":"box"},
  {"name":"planks_step","solid":true,"cullMode":"cutout","orientationModes":4,"geometry":"planks_step"},
  {"name":"cobblestone_step","solid":true,"cullMode":"cutout","orientationModes":4,"geometry":"cobblestone_step"},
  {"name":"cobblestone_step_updown","solid":true,"cullMode":"cutout","orientationModes":4,"geometry":"cobblestone_step_updown"},
  {"name":"stone_diorite_step","solid":true,"cullMode":"cutout","orientationModes":4,"geometry":"cobblestone_step"},
  {"name":"white_planks","solid":true,"cullMode":"opaque","orientationModes":0,"geometry":"box"},
  {"name":"oak_planks","solid":true,"cullMode":"opaque","orientationModes":0,"geometry":"box"},
  {"name":"gold_ore","solid":true,"cullMode":"opaque","orientationModes":0,"geometry":"box"},
  {"name":"marble","solid":true,"cullMode":"opaque","orientationModes":0,"geometry":"box"},
  {"name":"dirt","solid":true,"cullMode":"opaque","orientationModes":0,"geometry":"box"},
  {"name":"snow","solid":true,"cullMode":"opaque","orientationModes":0,"geometry":"box"},
  {"name":"snow_grass","solid":true,"cullMode":"opaque","orientationModes":0,"geometry":"box"},
  {"name":"ice","solid":true,"cullMode":"opaque","orientationModes":0,"geometry":"box"},
  {"name":"grass","solid":true,"cullMode":"opaque","orientationModes":0,"geometry":"box"},
  // 浅水高台（v2.11）：深/浅两种草方块，**六面同一张贴图**（用户 2026-11-01 要求）。
  // 声明与 `grass` / `snow_grass` 完全同档（solid + opaque + box）——
  // 不新增非 box 几何，故不触发「非 box 必须显式 opaque:false」那条约束。
  // 贴图 = procedural/dark_grass、procedural/light_grass（`npm run grasstextures` 烘焙）。
  {"name":"dark_grass","solid":true,"cullMode":"opaque","orientationModes":0,"geometry":"box"},
  {"name":"light_grass","solid":true,"cullMode":"opaque","orientationModes":0,"geometry":"box"},
  {"name":"dark_planks","solid":true,"cullMode":"opaque","orientationModes":0,"geometry":"box"},
  {"name":"blue_planks","solid":true,"cullMode":"opaque","orientationModes":0,"geometry":"box"},
  {"name":"green_planks","solid":true,"cullMode":"opaque","orientationModes":0,"geometry":"box"},
  {"name":"hay_bale","solid":true,"cullMode":"opaque","orientationModes":0,"geometry":"box"},
  {"name":"swamp_grass","solid":true,"cullMode":"opaque","orientationModes":0,"geometry":"box"},
  {"name":"bookbox","solid":true,"cullMode":"opaque","orientationModes":4,"geometry":"box"},
  {"name":"gold_block","solid":true,"cullMode":"opaque","orientationModes":0,"geometry":"box"},
  {"name":"emerald","solid":true,"cullMode":"opaque","orientationModes":0,"geometry":"box"},
  {"name":"amethyst","solid":true,"cullMode":"opaque","orientationModes":0,"geometry":"box"},
  {"name":"iron_ore","solid":true,"cullMode":"opaque","orientationModes":0,"geometry":"box"},
  {"name":"debris","solid":true,"cullMode":"opaque","orientationModes":0,"geometry":"box"},
  {"name":"tnt","solid":true,"cullMode":"opaque","orientationModes":0,"geometry":"box"},
  {"name":"turret_alias_block","solid":true,"cullMode":"opaque","orientationModes":0,"geometry":"box"},
  {"name":"zombie_nest_alias_block","solid":true,"cullMode":"opaque","orientationModes":0,"geometry":"box"},
  {"name":"deepslate","solid":true,"cullMode":"opaque","orientationModes":0,"geometry":"box"},
  {"name":"deepslate_diamond_ore","solid":true,"cullMode":"opaque","orientationModes":0,"geometry":"box"},
  {"name":"polished_deepslate","solid":true,"cullMode":"opaque","orientationModes":0,"geometry":"box"},
  {"name":"glowstone","solid":true,"cullMode":"opaque","emissive":15,"orientationModes":0,"geometry":"box"},
  {"name":"ochre_froglight","solid":true,"cullMode":"opaque","emissive":15,"orientationModes":0,"geometry":"box"},
  {"name":"oxidized_cut_copper","solid":true,"cullMode":"opaque","orientationModes":0,"geometry":"box"},
  {"name":"weathered_cut_copper","solid":true,"cullMode":"opaque","orientationModes":0,"geometry":"box"},
  {"name":"lava","solid":true,"cullMode":"opaque","emissive":15,"orientationModes":0,"geometry":"box"},
  {"name":"block_of_quartz","solid":true,"cullMode":"opaque","orientationModes":0,"geometry":"box"},
  {"name":"quartz_bricks","solid":true,"cullMode":"opaque","orientationModes":0,"geometry":"box"},
  {"name":"brain_coral_block","solid":true,"cullMode":"opaque","orientationModes":0,"geometry":"box"},
  {"name":"block_of_amber","solid":true,"cullMode":"opaque","orientationModes":0,"geometry":"box"},
  {"name":"floatato","solid":true,"cullMode":"opaque","orientationModes":0,"geometry":"box"},
  {"name":"clay","solid":true,"cullMode":"opaque","orientationModes":0,"geometry":"box"},
  {"name":"end_stone_bricks","solid":true,"cullMode":"opaque","orientationModes":0,"geometry":"box"},
  {"name":"smooth_stone","solid":true,"cullMode":"opaque","orientationModes":0,"geometry":"box"},
  {"name":"smooth_stone_1","solid":true,"cullMode":"opaque","orientationModes":0,"geometry":"box"},
  {"name":"stone_bricks","solid":true,"cullMode":"opaque","orientationModes":0,"geometry":"box"},
  {"name":"tuff_bricks","solid":true,"cullMode":"opaque","orientationModes":0,"geometry":"box"},
  {"name":"snow_block","solid":true,"cullMode":"opaque","orientationModes":0,"geometry":"box"},
  {"name":"light_gray_cloth","solid":true,"cullMode":"opaque","orientationModes":0,"geometry":"box"},
  {"name":"pink_wool","solid":true,"cullMode":"opaque","orientationModes":0,"geometry":"box"},
  {"name":"nether_bricks","solid":true,"cullMode":"opaque","orientationModes":0,"geometry":"box"},
  {"name":"nether_bricks_1","solid":true,"cullMode":"opaque","orientationModes":0,"geometry":"box"},
  {"name":"nether_gold_ore","solid":true,"cullMode":"opaque","orientationModes":0,"geometry":"box"},
  {"name":"netherrack","solid":true,"cullMode":"opaque","orientationModes":0,"geometry":"box"},
  {"name":"polished_blackstone_bricks","solid":true,"cullMode":"opaque","orientationModes":0,"geometry":"box"},
  {"name":"oak_planks_1","solid":true,"cullMode":"opaque","orientationModes":0,"geometry":"box"},
  {"name":"acacia_planks","solid":true,"cullMode":"opaque","orientationModes":0,"geometry":"box"},
  {"name":"bedrock","solid":true,"cullMode":"opaque","orientationModes":0,"geometry":"box","indestructible":true},
  {"name":"polished_diorite","solid":true,"cullMode":"opaque","orientationModes":0,"geometry":"box"},
  {"name":"polished_granite","solid":true,"cullMode":"opaque","orientationModes":0,"geometry":"box"},
  {"name":"piston","solid":true,"cullMode":"opaque","orientationModes":0,"geometry":"box"},
  {"name":"piston_head","solid":true,"cullMode":"opaque","orientationModes":0,"geometry":"box"},
  {"name":"mud_bricks","solid":true,"cullMode":"opaque","orientationModes":0,"geometry":"box"},
  {"name":"orange_shulker_box","solid":true,"cullMode":"opaque","orientationModes":0,"geometry":"box"},
  {"name":"bed_head","solid":true,"cullMode":"opaque","orientationModes":0,"geometry":"half_block"},
  {"name":"bed_tail","solid":true,"cullMode":"opaque","orientationModes":0,"geometry":"half_block"},
  {"name":"bed_alias_block","solid":false,"cullMode":"none","orientationModes":0,"geometry":"box"},
  {"name":"sand_train_track","solid":true,"cullMode":"opaque","orientationModes":4,"geometry":"box"},
  {"name":"sand_train_track_corner","solid":true,"cullMode":"opaque","orientationModes":4,"geometry":"box"},
  {"name":"mine_cart","solid":false,"cullMode":"none","orientationModes":0,"geometry":"box"},
  {"name":"hanging_lamp","solid":false,"cullMode":"cutout","emissive":15,"orientationModes":0,"geometry":"hanging_lamp","shadowCast":false},
  // M2-7 空岛岛体（mc-lite Island.js：sky_stone 岛身 + sky_grass 顶层）
  {"name":"sky_stone","solid":true,"cullMode":"opaque","orientationModes":0,"geometry":"box"},
  {"name":"sky_grass","solid":true,"cullMode":"opaque","orientationModes":0,"geometry":"box"},
  // ---- 巨树景观（Giant Trees Epic）----
  // 全部 geometry:"box"、orientationModes:0 —— 无新几何模板（mesher 零改动）。
  // ⚠️ 树叶口径（2026-10-23 修订）：**cullMode:"cutout" + 显式 "opaque":true**。
  //    · 为什么是 cutout：opaque 通道的材质 alphaTest=0（materials.js 只有 cutout 挂 alphaTest 0.3）
  //      → 贴图的镂空 alpha 被完全忽略，树叶渲染成完全不透光的实心块（用户实玩反馈）。
  //    · 为什么还要 opaque:true：cutout 通道本身配 opaqueTable=0（看 leaves 方块），见下。
  //    两者是**两套口径**：cullMode 选渲染通道（决定 alphaTest / 镂空），
  //    opaque 决定 opaqueTable（面剔除/AO/blocklight/炮塔 LOS）。**必须同时写，缺一不可**。
  // ⚠️ opaqueTable 必须为 1（即不得写 opaque:false）：mesher.js 判据 opaqueTable[neighbor]===1
  //    决定叶-叶共享面互剔。实测同一片 8³ 叶团（18³ halo，真实 atlas）的总顶点：
  //      opaque + opaqueTable=1         → 1584
  //      cutout + opaqueTable=1（本行）  → 1584（**零增长**，只是分布从 opaque 转到 cutout）
  //      cutout + opaqueTable=0         → 12316（**×7.78**，密林视域会撞破 cutout 容量）
  // ⚠️ 树叶**投影**（不写 shadowCast:false）：cutout 通道 castShadow=true；与既有 leaves 同口径；
  //    `[阴影投射]` 门禁的 13 项清单也要求 leaves 仍须投影。
  // ⚠️ palette[0] 恒为树干（tools/giant-trees-fingerprint.mjs 的 FAMILY_PALETTES）。
  {"name":"giant_oak_log","solid":true,"cullMode":"opaque","orientationModes":0,"geometry":"box"},
  {"name":"giant_mangrove_log","solid":true,"cullMode":"opaque","orientationModes":0,"geometry":"box"},
  {"name":"giant_oak_leaves","solid":true,"cullMode":"cutout","opaque":true,"orientationModes":0,"geometry":"box"},
  {"name":"giant_birch_leaves","solid":true,"cullMode":"cutout","opaque":true,"orientationModes":0,"geometry":"box"},
  {"name":"giant_spruce_leaves","solid":true,"cullMode":"cutout","opaque":true,"orientationModes":0,"geometry":"box"},
  {"name":"giant_cherry_leaves","solid":true,"cullMode":"cutout","opaque":true,"orientationModes":0,"geometry":"box"},
  {"name":"giant_palm_leaves","solid":true,"cullMode":"cutout","opaque":true,"orientationModes":0,"geometry":"box"},
  {"name":"giant_banyan_leaves","solid":true,"cullMode":"cutout","opaque":true,"orientationModes":0,"geometry":"box"},
];
