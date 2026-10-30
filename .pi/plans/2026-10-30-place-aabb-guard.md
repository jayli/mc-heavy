# 放置方块的自身 AABB 守卫（v2.22）

> 用户反馈（2026-10-30 前后）：玩家放置方块时，如果方块离玩家太近，放完会让玩家直接穿模 ——
> 需要在放置时判断「方块与玩家 AABB 相交就拒绝放置」。

## 1. 根因（已实测，非推测）

`src/player/player.js` 的 `_placeSingle()` 开头那行「不与玩家自身 AABB 重叠」守卫**不是 AABB
判据，而是格近似**：

```js
if (x === Math.floor(p.x) && z === Math.floor(p.z) &&
    (y === Math.floor(p.y) || y === Math.floor(p.y + 1))) return false;
```

玩家碰撞盒是 **0.6×1.8×0.6**（`src/player/physics.js` 的 `PLAYER_WIDTH` / `PLAYER_HEIGHT`），
而上面这行只覆盖「玩家所处的那一列 + 脚底/头顶两格」。两处漏洞都能用纯数值复现：

### 漏洞 A：水平偏心时 AABB 跨两列

半宽 0.3 → `p.x` 的小数部分 > 0.7 或 < 0.3 时 AABB 跨两个 x 格（z 同理）。实测
玩家 `(8.9, 1, 8.9)` 时，「旧守卫放行但真实 AABB 相交」的格有 **6 个**：

```
(9,1,8) (9,2,8) (8,1,9) (8,2,9) (9,1,9) (9,2,9)
```

这正是准心斜向下对着邻格顶面时 `prevPos` 落到的格 —— 玩家报告的穿模形态。

### 漏洞 B：竖直用 `floor(p.y)+1` 而非真实顶面

跳跃/下落中 `p.y` 是小数（如 1.5），真实 AABB 覆盖 `1.5 ~ 3.3` = 格 1/2/3，旧守卫只挡住
1/2 → **头顶格 y=3 漏判**。

### 对照上游

mc-lite `src/actors/player/PlayerInteraction.js:305-312` 的 `tryPlaceBlock` 用的是**真实 AABB
精确判据**（`position.x ± 0.3 < x+1 && …`）。本仓移植时退化成了格近似 —— CLAUDE.md 既有约束
「对齐上游须实测其运行时行为，不能读定义推断」的又一实例。

### 不需要改的部分

`findPlaceCell`（v1.70 兜底，`src/player/place-ray.js`）不需要改：它天然不会返回玩家体内格
（判据 ③ 会否决视线前方的实心邻居）。`_placeSingle()` 是两条单格放置路径（主射线命中 /
兜底）的**唯一**写入点，守卫加在这里两条都覆盖。

## 2. 改动

### 2.1 `src/player/physics.js` — 新增 `overlapsBlock(x, y, z)`

在 `collidesAt()` 旁边加一个方法：**玩家当前 AABB 与单位立方体格是否正体积重叠**。

- 尺寸走既有的 `this.aabb()`（`PLAYER_WIDTH`/`PLAYER_HEIGHT` 的单一权威，nests/turrets 已这么
  用）—— 不重算一遍字面量。
- 判据用**严格不等式**：贴面（盒面正好落在格边界）不算重叠。否则 `p.x = 8.7` 这种刚好切齐
  的位置会误杀合法放置。

### 2.2 `src/player/player.js` — `_placeSingle()` 的守卫换成真实 AABB

```js
if (this.registry.solidTable[id] === 1 && this.physics.overlapsBlock(x, y, z)) return false;
```

**只对实心方块拒绝**（相对 mc-lite 的一处有意偏离，注释写明理由）：花草 / 水 / 藤 / 睡莲等
`solid=false` 的方块放进玩家 AABB 也**不会产生任何碰撞**，不存在「穿模」；这与原版
`Level.isUnblocked()`（只对非空碰撞形状拒绝）同口径，而 mc-lite 的无条件拒绝是更粗的口径。
判据落在 `registry.solidTable` —— 碰撞语义的唯一权威（`physics._collides` 读的就是它）。

时机不变：仍是 `_placeSingle` 的第一步，早于朝向计算与 `editor.setBlock` → 失败路径零副作用、
不挥手、不消耗。v1.70 的裁决「命中但放不下时不回落到兜底」原样保留。

### 2.3 新增 `src/tests/test-player-place.js`（Tier 1，先 RED）+ 在 `src/tests/index.html` 注册

（漏注册等于静默不跑，`check:data` 的 `[测试注册]` 会抓。）用例：

| 用例 | 断言 |
|---|---|
| 偏心跨列（核心回归） | 玩家脚底 `(8.9,1,8.9)`，六个跨列格逐个 `getBlockId === 0`（被拒、世界零变化） |
| 正向对照（防守卫过宽） | 同姿态 `(10,1,8)` 必须**放得下** |
| 贴面切线不误杀 | `p.x = 8.7` 时 `(9,1,8)` 盒面相切 → 允许放 |
| 跳跃中的头顶格 | `p.y = 1.5` 时 `(8,3,8)` 必须被拒（旧守卫漏判的那格） |
| 非实心不受限 | `short_grass` 在玩家体内格可以放，且确实写进世界 |
| `overlapsBlock()` 纯函数语义 | 相交 / 相切 / 上下方 1 格 / 偏离 1 格 |

### 2.4 文档

- `AGENTS.md`「放置」段活跃约束加一条：**自身 AABB 守卫必须是真实 AABB
  （`physics.overlapsBlock`），不得退回格近似**，附 6 格漏判实测与「只拒实心方块」的理由。
- `docs/roadmap.md`「已补齐的实玩反馈修正」表加 v2.22 一行（反馈原文 + 根因 + 修法 + 实测）。
  不 bump 设计文档版本号（实玩反馈修正口径）。

## 3. 验证

1. **RED**：新用例在 HEAD 上真失败（临时 `tests/tmp-*.spec.mjs` 探针打印失败用例名/消息，跑完删）。
2. **GREEN**：同一探针全绿。
3. **负向验证（两条，缺一不可）**：
   - 守卫注回格近似 → 偏心跨列用例必须 FAIL；
   - 去掉 `solidTable` 门控（无条件拒绝）→ 非实心用例必须 FAIL。
   注入前 `cp` 备份、验完 `cp` 还原（禁止对含未提交改动的文件用 `git checkout`）。
4. `npm run check`（arch + data + lint）。
5. `npx playwright test tests/harness.spec.mjs`（浏览器内全量单测 0 失败）。
6. 受影响 E2E：`place-fallback`、`m3-1-inventory`、`m3-2-orientation`、`tnt`、`view-bob`、`minecarts`。

## 4. 风险与已知边界

- 行为上唯一「变宽」处：非实心方块（花草/水）现在可以放进玩家自己所在的格 —— 碰撞语义的
  正确结果，是本次唯一放宽项，注释与 roadmap 都会写明。
- 矿车 / 巢穴 / 炮塔走 `_placeSpecial` 分支，不经过本守卫：巢穴/炮塔已有 `playerAabb` 预检；
  矿车是单格实体（非方块、无碰撞形状）—— **不在本次范围**。
- 不新增渲染/性能路径：守卫是每次右键一次小数比较 + `aabb()` 一次小对象分配。
