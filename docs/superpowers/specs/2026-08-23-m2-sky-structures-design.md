# M2-7 空中结构设计：悬浮空岛与云层

**状态：** 已确认，待实施<br>
**定位：** 第一阶段 M2 的追加任务；必须在 M2 关闭及 M3 性能冻结前完成。<br>
**关联：** `docs/phase-1-engine-design.md` §4.2、§7、§8；`docs/superpowers/plans/2026-08-20-phase1-remaining-roadmap.md`。

> ⚠️ **部分被反转（2026-09-20）**：本文 §1「明确不包含：天空树」与 §4 验收第 3 条
> 「空岛…不含 `sky_wood`、`sky_leaves`」已由
> [`2026-09-20-sky-tree-design.md`](2026-09-20-sky-tree-design.md) 反转 ——
> 天空树按产品范围回补（宝箱仍不迁移）。**本文正文作为历史决策记录保留不改。**

## 1. 目标与范围

迁移 mc-lite `src/world/entities/Island.js` 与 `Cloud.js` 的可见世界语义：悬浮空岛、噪声单云层和连通云簇。输出仍是主线程 `ChunkColumn.blocks` 的确定性生成结果，网格、光照与碰撞均继续是派生数据。

本任务只包含：

- 新增实体素方块 `sky_stone`、`sky_grass`：二者均为 solid/opaque box，六面分别映射到离线烘焙的 `procedural/sky_stone`（mc-lite `mkMat('#DDDDDD')`）与 `procedural/sky_grass`（`mkMat('#88CCFF')`）。方块注册由 124 增至 126，atlas tile 由 145 增至 147；
- 空岛候选率 8%，候选中心为来源 16×16 chunk 的中心，底部 Y 为 `40..69`；岛体半径 `5..9`、高度 `5..7`，顶部 `sky_grass`、其余层 `sky_stone`；
- `Y=55` 的噪声单云块（`noise(wx,wz,seed,0.03) > 1.2`），以及候选率 20%、`Y=35`、规模 `30..50` 的四邻接连通云簇；
- `cloud` 的“可站立、非实心、透明、不遮光”语义。

明确不包含：空岛宝箱、天空树、背包/库存、动态云、独立 entity、结构中心缓存、运行期跨 chunk 补刷或新的渲染通道。

## 2. 架构与数据流

每个 400×400 region 的 `StructureIndex` layout 派生两份只读紧凑 `Int32Array`：`skyIslands`（stride 5：`[originCx,originCz,bottomY,radius,height]`）与 `cloudClusters`（stride 5：`[originCx,originCz,startX,startZ,size]`）。候选由 `(seed, originChunkX, originChunkZ, salt)` hash 唯一决定；同一 region 任何 Worker 重算结果相同。该表示避免约 50 个岛和约 125 个云簇候选以对象数组随每个 GEN 任务重复 structured-clone。查询 column 时仍取基 region 的 3×3 邻域，只将水平 AABB 覆盖该 column 的候选交给 GEN。

`sky-structures.js` 是无 three/DOM 的纯函数模块：空岛逐层圆形光栅化；云簇以 hash 驱动的 frontier 游走生成四邻接坐标并限于目标数量；单云层直接检查固定噪声公式。`applyStructuresToColumn()` 对空中层执行严格的 mc-lite 覆盖顺序：先无条件写 `Y=55` 单云和 `Y=35` 云簇，后无条件写空岛；因此空岛在 `Y=55` 相交处覆盖 cloud，绝不在岛体内遗留透明云。所有写入均裁剪到当前 column；不保存空岛或云块的第二份数据，也不让主线程重新计算。

实施顺序也属于该层序契约：Task 2 必须先实现 Y=55 单云层和空岛，令 island-over-cloud 的 RED/GREEN 有真实 cloud 输入；Task 3 仅把 Y=35 连通云簇追加到既有 `writeClouds()`，其调用位置仍在 `writeIslands()` 之前。

`BlockRegistry` 新增通用 `supportsPlayer` 属性及其 typed 查询表，`WorldData` 暴露对应坐标查询。`cloud` 保持 `solid=false`，但 `PlayerPhysics._moveAxis()` 仅在 **Y 轴向下** 时把 `solid || supportsPlayer` 作为碰撞目标；Y 轴向上（头顶）、X/Z 与 `_tryStepUp()` 的净空碰撞仍只检查 solid。因此玩家可落在云顶、从侧面和下方穿过云，而不会把云当墙或遮光体。DDA 保持现有“非 air 且非 water 即命中”规则：cloud 可被瞄准/挖掘，不得因其 non-solid 而跳过。

## 3. 确定性与边界

mc-lite 的 `Math.random` 只保留分布语义，全部换为现有 `seededRandom` 或等价纯 hash。固定 salt 口径为：空岛候选 `seed+50`、底部 Y `seed+51`、半径 `seed+56`、高度 `seed+57`；云簇候选 `seed+52`、起点 X/Z `seed+53/+54`、大小 `seed+55`、frontier 每一步 `seed+58` 加步号。50..55 必须与 mc-lite 的 chunkRandom 口径一致；56..58 只替代原实现未 seed 化的随机量。不得让 Worker 调度顺序、页面刷新或加载半径改变结果。

空岛最大水平半径为 9；云簇最大连续行走长度为 50。region layout 必须保留足以被相邻 region column 查询到的候选，生成侧以候选 AABB 过滤，不能假定结构中心与当前 column 相同。Y=35、55 与 40..76 均在 `WORLD_MIN_Y=-32`、`WORLD_MAX_Y=96` 内；写入前仍由 `ChunkColumn` 边界检查保护。

## 4. 验收

- 固定 seed 下重复 layout、任意顺序生成相同 column，空岛/云块逐格相同；不同 seed 至少有一个空中候选或其形状不同。
- `sky_stone`/`sky_grass` 完成 BlockRegistry、六面 faces-data、程序化烘焙和 atlas 注册；注册数为 126、atlas 为 147 tile。
- 空岛只有 `sky_stone` 与顶部 `sky_grass`，不含 `chest`、`sky_wood`、`sky_leaves`；尺寸与 Y 范围符合上文，且岛体与 Y=55 云相交时岛体覆盖云。
- 每个云簇为 30..50 个四邻接连通的 `cloud`；单云层、云簇都跨 column 时无截断、无重复和无运行期补刷；单云公式固定为 scale=0.03、阈值=1.2。
- 玩家能从上方稳定落在云上、可穿过其侧面和下方；云不作为 solid 碰撞或光照遮挡，DDA 仍可命中 cloud。
- 固定 seed 的悬浮空岛/云层截图与 mc-lite 对比结构轮廓和配色基调；视距 8、完整队列收敛后满足 M3 冻结 fps/draw 口径。若实测不达标，记录数字并停止，不降低候选率或放宽断言。
