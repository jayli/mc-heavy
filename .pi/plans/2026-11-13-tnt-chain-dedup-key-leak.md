# TNT 连锁去重键泄漏修复

日期：2026-11-13
状态：已批准，实施中

## 问题

用户报告：相邻 / 距离不远的 TNT 一起炸时，连锁之后「有些 TNT 方块却没有消失」，
而且之后在同一位置点它们也没有反应。

## 根因（三段，全部实测复现，非推断）

去重集合 `game._ignitingTnt` 的键生命周期错位。`explodeTnt()` 先 `add(key)`，只在
「③ 移除引爆格自身成功」那个分支里 `delete(key)`（对齐 mc-lite `PlayerInteraction.js:687`）：

```js
this._ignitingTnt.add(key);
if (world.getBlockId(center) === tntId) { editor.setBlock(...0); this._ignitingTnt.delete(key); }
this._applyExplosion(result);   // ← 中心格不是 TNT 时，键就永久留下了
```

于是：

1. **幽灵连锁项**：`computeExplosion` 只在**首次引爆的那一帧**枚举 5×5×5。首爆入队 B、C
   后，B 先炸时把 C 也搜进了 chain（C 还是 TNT）→ 队列里 C 有两项。C 先被 B 的那一项
   引爆（该格变空气），**C 自己的那一项到期后再调一次 `explodeTnt`**：此时中心格已是
   air → 早退路径不释放键 → 键永久残留，并且并发一次**虚假爆炸**（多一次音效 / 伤害 / 特效）。
2. **静默拒绝**：键残留后，玩家在该格重新放 TNT 再点引信 →
   `if (this._ignitingTnt.has(key)) return false;` → 方块**永远炸不掉、也永远不会消失**。
3. **残留键会漏进连锁**：其余「中心格非 TNT」的早退路径（枪击 / 连锁项落在已被破坏的格）
   同样残留；这些键参与 `_applyExplosion` 的 `pending` 过滤，会让真 TNT 被排除出破坏事务
   ——「该消失的方块没消失」。

实测证据（真游戏页，`player.digBlock()` 真实入口 + `explodeTnt`）：

| 场景 | 结果 |
|---|---|
| 三连 TNT（间距 1）首次引爆 | `exploded` 计数 **4**（应为 3 → 1 次幽灵爆炸） |
| 同一弹坑重建同样三连再引爆 | 只剩 `[0,0,83]`：第三格 **TNT 留在原地**，`pending=0` |
| 再点那格（左键） | 引爆被拒，方块**不变**（= 用户描述） |
| 2×2×2 八连通团组 | 8 格炸完，`_ignitingTnt` 残留 **6 个键** |
| 对空气格 `explodeTnt` | 返回 true，键永久残留 |

## 修法（`src/core/game.js`，三处）

1. **`explodeTnt` 的 ③ 段**：把 `delete(key)` 移出「中心格是 TNT」的 `if`，改为
   **只要这一格真的被移除过**就释放键（即写世界成功了就释放）。中心格非 TNT
   （连锁幽灵 / 枪击）时也释放 —— 与 mc-lite 的意图「键存活期 = 引爆进行中」一致。
2. **`_applyExplosion` 的 ⑤ 段入队**：队列里已有同格待引爆项则跳过（`pendingMany` +
   `queued` Set）。键在 ③ 已释放，链条推进时同格必然被重复搜到，必须在入队侧去重。
3. **去重键归属写入成功者**：现在键在 `explodeTnt` 进入时就 `add`，若该格 TNT 的 column
   未加载（`editor.setBlock` 返回 `reason:'column-missing'`，方块实际还在），键会留着 →
   该格以后永久炸不掉。改为：② 算范围之前先查一次「中心格是 TNT 且 column 在位」，
   成立才 `add`；否则直接拒绝（零副作用）。这样「拒爆」与「成功」各自都不会留下脏键。

去重语义（A↔B 相距 ≤2 不永久互爆）不变：键仍覆盖「候选 → 完成」的全窗口，
`tests/tnt.spec.mjs` 的 `exploded === 2` 断言照旧。

## 测试（Tier 1 热路径 → TDD，先 RED）

- **新增** `src/tests/test-tnt-chain.js`（`tinyWorld` fixture）：用只带 `editor` / `registry` /
  `world` 的 fixture 直接驱动 `_applyExplosion` + 队列语义，钉住「同格不重复入队」与
  「2×2×2 炸完集合为空」。
  ⚠️ 加不进 `test-explosion.js` —— 需要 `new Game`，而 Game 依赖 DOM/WebGPU，该文件是
  纯 Node 口径的同构单测。
- **`tests/tnt.spec.mjs` 加两条走真游戏页的用例**（这是能抓住本缺陷的层次）：
  - 「连锁后每格 TNT 都消失」：2×2×2 团组 + 三连，`exploded` 计数必须等于连接分量大小
    （三连必须是 **3**，不是 4）；所有格子读回 `0`。
  - 「同弹坑第二轮」：重建同一批 TNT 再引爆 —— 全部消失、计数仍精确、`_ignitingTnt` 不增长。
- **负向验证**（`cp` 副本还原，逐条单变量）：① 把 ③ 段的 `delete` 移回 `if` 内 → 新用例必须红；
  ② 去掉 ⑤ 的入队去重 → 计数用例必须红；③ 去掉 ① 的 TNT 预检 → column-missing 用例必须红。

## 文档同步

- `AGENTS.md` 高频坑补一条：`explodeTnt` 的早退 / 失败分支不得留下 `_ignitingTnt` 键；
  连锁项必须按格去重（5×5×5 只在首爆发起）。
- `docs/roadmap.md` 加 v2.97 行（根因 / 实测证据 / 修法与验证，同表格既有格式）。
- 不 bump 设计文档版本（bugfix，非架构口径变更）。

## 验证门禁

`npm run check`（arch + data + lint）→ 新增单测 + `tests/harness.spec.mjs`（浏览器内全量
2070+ 例）→ `npx playwright test tests/tnt.spec.mjs tests/minecarts.spec.mjs
tests/dragon-fireball.spec.mjs`（后两者消费 `explodeTnt` / `exploded`）。

`npm run bench -- --check` 跳过并说明理由：爆炸路径不在 4 个 bench 场景内，
`setBlocks` / mesher / scheduler 均未改动。
