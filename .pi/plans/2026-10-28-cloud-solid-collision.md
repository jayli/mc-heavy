# cloud 改 solid=true（不可穿越）

日期：2026-10-28 ｜ slug：`cloud-solid-collision` ｜ 目标版本：v1.96
分级：**Tier 1**（机制/语义变更，静默影响六个消费方 → 必须 TDD）

## 1. 目标

`cloud` 从 `solid: false` 改成 `solid: true`，让云不可穿越。

用户裁定（2026-10-28）：
- 只要「**不能穿过**」这一个后果；
- Y=55 覆盖率 28~30% 的薄云毯「跳上去被挡住 / 站上去」**符合预期**。

## 2. 现状

`src/voxel/blocks-data.js:30`：
```js
{"name":"cloud","solid":false,"supportsPlayer":true,"cullMode":"opaque",
 "orientationModes":4,"geometry":"box","shadowCast":false}
```

`solid` 是 `block-registry.js` 的单一权威表（`solidTable`），消费方全部跟着变、无需改代码：

| 消费方 | 位置 | 改后行为 |
| --- | --- | --- |
| 玩家物理 `_collides` | `player/physics.js:195` | 水平被云墙挡 / 向上撞云底 / step-up 走云 |
| 丧尸物理与站立判据 | `entities/zombies/zombie-system.js:245,370` | 丧尸不再穿云，可站云上 |
| 炮塔 LOS + 弹丸阻挡 | `entities/turrets/turret-system.js:31` | 云开始挡视线、挡子弹（`solid && opaque` 两者都是 1） |
| 矿车前方实心 / 玩家头顶净空 | `minecart-system.js:105,219,400` | 撞云停住 |
| 雨滴地面截停 | `render/rain.js:165` | 雨滴停在云顶而非落向地面 |
| 放置兜底遮挡 / 结构探地 | `player/place-ray.js:85`、`structure-json.js:172` | 云成为合法贴靠面 / 探地面 |

### 已实测的现场数据（Tier 1 证据）

- Y=55 单云层覆盖率：seed 12345 = **28.1%**、seed 424242 = **30.3%**（400×400 采样）。
- 出生点 City 中心 ±8 格：**0** 个云列；雨幕半径 18 内 **0** 个云列。
- Y=35 云簇 ±2 region 共 3169 个，其中 **695** 个落在城市 bounds 内。
- 全仓 16 个 `solid=false` 方块里，只有 `cloud` 本次变更。

## 3. 改动清单

### 3.1 声明（`src/voxel/blocks-data.js`）

1. `"solid":false` → `"solid":true`。
2. **`supportsPlayer:true` 保留**。理由：用户选「仅不能穿过」，站立手感不变；现在 `isSolid`
   先命中，`supportsPlayer` 成了冗余但无害的第二道门。删掉它会改动「向下碰撞」分支的组合，
   属无收益的行为变更，且 `test-block-registry.js` 有一条「supportsPlayer 表仅 cloud=1」门禁。
3. 注释更新：
   - 行内注释补 **v1.96**：`solid=true` ⇒ 玩家/丧尸/弹丸/矿车都不能穿云；连带 LOS、雨滴截停、
     ground-support 探地跟着变。
   - 文件头「转换规则」段补一句：cloud 的 `isSolid:false` 曾是**有意偏离 mc-lite**，
     v1.96 起改回 `solid:true`。

### 3.2 被行为变更打断的既有断言（同批改，否则门禁恒红）

`src/tests/test-physics.js`：
- `physics: 上跳穿过头顶云（向上不碰撞，M2-7）` → 改名「上跳被头顶云挡住」，
  断言从 `maxY > 2.8` 改成「峰值 < 云底」（云 grid y=4，故 `maxY < 3.9`，实测 ~2.2）。
- `physics: X/Z 穿过侧面云（水平不碰撞，M2-7）` → 改名「X/Z 被侧面云墙挡住」，
  断言从 `pos.x > 11` 改成 `pos.x < 10 - 0.3`（对照同文件 stone 墙用例）。
- `physics: 下落落在云上（仅向下 Y 支撑，M2-7）` → 断言不变（仍落在 y=11），改注释。
- `physics: 云上对 solid 台阶仍走 _tryStepUp（M2-7）` → 断言不变，改注释（M2-7 非实心 → 实心）。

### 3.3 新增门禁（RED → GREEN，负向验证必须真 FAIL）

1. `src/tests/test-block-registry.js` — `solidTable[cloud] === 1`（本改动的唯一直接落点）。
2. `src/tests/test-turrets.js` — `isProjectileOccluding(cloud) === true`（最易漏的玩法后果）。
3. `src/tests/test-place-ray.js` — 云邻居算实心 ⇒ 可作为放置贴靠面。
4. `src/tests/test-raycast.js` — 标题措辞修正（云已非 non-solid），断言不变。
5. `src/tests/test-minecarts.js` — 补 `hasSolidAt(cloud) === true` 对照（water 那条负向保留）。

### 3.4 注释与文档同步

- `src/core/game.js` 三处：`:719`（rain）、`:1128-1132`（teleport 的 `findSpawnY` 说明）、
  `:1616-1621`（`spawnZombieNearPlayer` 的偏离 ①）。凡「云 `solid=0` …」变假话的句子必须改。
- `docs/phase-1-engine-design.md`：首行版本号 v1.88 → **v1.96**（该文档自身首行是唯一权威）；
  §4.2 M2-7 段「cloud … 仍为 non-solid、transparent、非遮光方块」改为实心；
  修订说明加 v1.96 段。
- `docs/roadmap.md`：改动表加 v1.96 一行（含实测数据与连带后果）。
- `CLAUDE.md`：M2-7 / 云相关活跃约束补一段 —— **`solid` 与 `supportsPlayer` 现在是叠加关系**，
  任何读 `solidTable` 的消费者都会看到云；`shadowCast:false` / `opaqueTable` 口径不变。

### 3.5 刻意不做

- **不改 `findSpawnY`**（`gen/terrain.js:98`）。它会把 Y=55 云毯当「地面」，但：
  ① 实测默认 seed 出生点 City 中心 ±8 内 0 个云列，正常出生不受影响；
  ② 这是 CLAUDE.md 已记录的既有已知坑（「findSpawnY 会把空中结构当出生点」）；
  ③ 改它会变更 `spawnY` 语义，属计划外。**只在注释里登记这条后果。**
- **不改雨滴让雨穿云**：用户没选这项。
- **不改 `opaque` / `shadowCast` / `cullMode`**（云仍不投影、不遮光、走 opaque 通道）。

## 4. 验证

按 `docs/testing-policy.md`：Tier 1 → 严格 RED → 验证 RED → GREEN → 验证 GREEN。

1. **RED**：先写 3.3 的 5 条新断言（`solidTable[cloud]===1` 等），在未改 `blocks-data.js` 时
   跑到**真 FAIL**（浏览器内单测 `npm test tests/harness.spec.mjs`）。
   同时确认 3.2 的两条穿云断言此刻**仍通过**（证明它们确实在测旧语义）。
2. **GREEN**：改 `blocks-data.js` 一行 + 翻 3.2 的两条断言 → 单测全绿。
3. `npm run check`（check:arch + check:data + lint）。
4. 关键 E2E（只跑消费 `solid` 的那几个，不铺开全量）：
   `zombies` / `turrets` / `projectiles` / `minecarts` / `m3-rain` / `sky-structures`。
5. `npm run bench -- --check`（mesher 侧零变化，用最短路径探回退）。
6. **负向验证**：把 `solid` 改回 `false`，确认 3.3 新增断言全部真 FAIL（不是恒真）。

## 5. 风险

- 炮塔/弹丸被云拦截是**改变玩法**的连带后果（用户已知悉并选择「仅不能穿过」）。
- 雨滴在高空停在云顶（地面附近无云，常规体验不受影响）。
- 已有存档里若玩家的 edits 落在云格上，行为随之改变（无数据迁移需求）。
