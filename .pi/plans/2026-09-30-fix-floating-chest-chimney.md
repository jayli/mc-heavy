# 修复悬空宝箱与烟囱下方透明面

日期：2026-09-30
状态：已批准，待实施

## 要解决什么问题

用户报告两个 bug：
1. **天空中有悬空宝箱**（游戏初始化后即可见）
2. **小房子烟囱底部接触的方块面是透明的**（屋顶顶面出现洞）

## 现状与根因（均已实测定位）

### Bug 1：悬空宝箱 = tall_well.json 的孤立数据

- `assets/structures/tall_well.json` 315 块中有一个**孤立 chest**：`(24, 51, 20)`，井体本身只到
  y=16、x∈[-5,3]、z∈[-4,4]。该 chest 与井体相距 20+ 格，纯数据异常（mc-lite 上游数据里就有，
  照搬带来）。
- **实测复现**（fetch stub + 真实 GEN 路径，seed=12345）：tallWell 候选 `(40,7,-53)` 在
  `(64,57,-33)` 产出 chest，下方 3 格为 `air/cloud/air` —— 悬空实锤。每个城市 region 约
  38~77 个 tallWell 候选，各产出一个这样的空中宝箱 → 用户看到的「好多」。
- 连带问题：`SCATTER_FOOTPRINT.tallWell = {halfX:24, halfZ:20}` 是被这个孤立 chest 撑大的
  （`region-config.js:57-64` 注释有记录）→ AABB 裁剪扫描范围虚大 25 倍。mc-lite 的口径是
  **底层 footprint**（`getLoaderBottomFootprint`，WorldWorker.js:600），实测 =
  x[-5,3] z[-4,4] → halfX=5, halfZ=4。
- 其余 chest 来源（house/ship/城市 JSON）实测都有支撑，不是本 bug 来源。

### Bug 2：烟囱下方屋顶顶面被错误剔除

- `chimney` 声明 `cullMode:"opaque"` → registry 派生 `opaqueTable=1`（`block-registry.js:43`）。
- mesher 面剔除判据是 `opaqueTable[neighbor]===1`（`mesher.js:464`）→ **烟囱下方的屋顶块顶面
  被剔除** → 透明洞。
- **实测确认**（mesher 探针）：stone 上方放 chimney → stone 顶面发射数 **0**（期望 1）；
  上方是 air → 1。
- 这是转换规则偏差：mc-lite 的 `BlockData.chimney` **无 `isTransparent` 字段**（= 不剔除邻居面），
  材质也是不透明 `mkMat('#7f5b37')`。mc-heavy 按「cullMode 推 opaqueTable」误伤了剔除语义。
- 修法有现成手法（`cloud` 同款）：`cullMode:"opaque"`（留在 opaque 通道）+ 显式
  `"opaque":false`（opaqueTable=0 → 不剔除邻居面）。chimney 几何是 r=0.15 的细圆柱，本就不占满
  整格，opaqueTable=1 本来就是错的。

## 打算改哪些文件

| 文件 | 改动 |
|---|---|
| `assets/structures/tall_well.json` | 删除孤立 chest 条目（315→314 块）。属数据勘误，同 big_house 删 lilypad 的既有先例（「原样复用」的唯一例外清单 +1） |
| `src/gen/structures/region-config.js` | `SCATTER_FOOTPRINT.tallWell` 24/20 → **5/4**（对齐 mc-lite 底层 footprint 口径），更新注释 |
| `src/voxel/blocks-data.js` | chimney 行加 `"opaque":false` + 注释（对齐 mc-lite 无 isTransparent；cloud 同款手法） |
| `src/tests/test-mesher.js` | 新增 Tier 1 用例：「chimney 下方方块的顶面不被剔除」（**TDD：当前 FAIL，修复后 GREEN**） |
| `src/tests/test-scatter.js` | ① 新增数据契约：全部 27 个结构 JSON 的每个 chest 下方（至 minY）须有同列支撑（防孤立宝箱回归）；② `SCATTER_Y_EXTENT.tallWell` 51→16（扫描范围收缩） |
| `docs/phase-1-engine-design.md` | 修订说明追加两条勘误；§4.3 例外清单补 tall_well（实施时先读相关段落，按实际内容同步） |
| `CLAUDE.md` | 「有意偏离」例外清单补 tall_well；`SAME_TYPE_CULL`/cloud 手法条目补 chimney 第二实例 |

## 明确不做（避免范围蔓延）

- **不修 bed_head/bed_tail 的同类问题**（同为非 box 几何 + opaqueTable=1）：已从背包移除、
  实际不会被放置（既有规避策略），本次只修用户实际可见的 chimney。
- **不动 cloud 的注释与实现不一致**（注释说 opaqueTable=0、实测是 1）：改它会改变云簇渲染面数，
  超出本次范围，只在报告里提。
- **不放宽任何冻结断言**；bench 若阻断，按仓库规程做交替对照再报告。

## 已知影响

- 既有世界的 tallWell 宝箱消失（用户要求）；tallWell 候选抑制范围缩小（footprint 24/20→5/4），
  井的实际数量可能略增（上限受城市空间与互斥门控约束，cutout 预算增量预计可忽略，以 bench
  实测为准）。
- 烟囱不再剔除邻居面：屋顶顶面恢复可见（修复目标）；chimney 不再遮挡 AO / 阻断 blocklight /
  挡炮塔 LOS —— 对齐 mc-lite 语义（mc-lite chimney 无 isTransparent）。

## 怎么验证

1. `npm run lint` + `npm run check`（arch + data）
2. 浏览器内单测全绿（新增 mesher 用例走 TDD：先确认 RED，修复后 GREEN；scatter 数据契约做
   负向验证——把 chest 注入回 JSON 须真 FAIL，验完还原）
3. `npx playwright test` 全量
4. `npm run bench -- --check`（改了 mesher 剔除语义 + GEN 数据，属热路径）
5. Node 探针复测：tallWell 候选附近不再有高空 chest；chimney 下方顶面发射数 = 1
