# 瞬移解卡 + 重启恢复玩家位置

> 计划日期：2026-10-31（slug: teleport-unstuck-and-resume-position）。用户批准「Write the plan and implement」。

## 一、根因（已实测代码路径确认，非推测）

### Bug 1：瞬移后卡在地下方块里

`Game._teleportTo()`（`src/core/game.js:1344`）**刻意不等目标 column 加载**（注释里写明：等 1200 格外的 column 会让面板点击阻塞秒级、且 async 异常被吞成「按钮没反应」）。后果链条：

1. 传送当帧目标区域全是未加载 column，`WorldData.getBlockId()` 对缺失 column 返回 **0（空气）**（`world-data.js:26-32`）；
2. 玩家悬空 → 帧循环重力持续拉落，`_moveAxis` 的碰撞检测读到的全是空气 → **一路掉到世界底**（`y < WORLD_MIN_Y` 时 `getBlockId` 返回 bedrock，停在 `y = -32`）；
3. 目标 column 随后 GEN 完成，`fillColumn` 的「底部补实」把 `y=-32` 到地表之间全填成 stone → **玩家 AABB 整个埋在实心石头里**；
4. 卡死的机制：`_moveAxis` 只在 `delta !== 0` 时检测碰撞，碰撞后二分回退到 `old + delta*lo`（lo→0）→ 每帧位移被压成 0、`vel` 清零 → **水平与竖直全部冻结**，正是用户描述的「动弹不得」。

同一机制也解释「有时候」：只有目标 column 加载慢于玩家下落时才会掉到地表以下；近处传送（column 已加载）不会。

### Bug 2：重启后永远出生在 City 中央

`start()` 里 `meta.spawn` **只写不读**（`game.js:700-702` 写、`411-419` 只读 `meta.seed`），出生位置恒取 `getCitySpawnPoint(city)` + `findSpawnY()`。玩家位置从未持久化。

## 二、方案

### A. 解卡：`PlayerPhysics.resolveStuck()`（唯一实现）

`src/player/physics.js` 新增：

```js
resolveStuck(maxRaise = WORLD_HEIGHT) {
  if (!this.collidesAt(this.pos.x, this.pos.y, this.pos.z)) return 0;
  for (let dy = 1; dy <= maxRaise; dy++) {
    if (!this.collidesAt(this.pos.x, this.pos.y + dy, this.pos.z)) {
      this.pos.y += dy; this.vel.y = 0; return dy;
    }
  }
  return 0;
}
```

- **判据复用既有的 `collidesAt(x,y,z)`**（`physics.js` 已有，乘坐跟随的分轴障碍检测在用）：与 `_collides` 同一份 `PLAYER_WIDTH/HEIGHT` 权威，**只查方块、不查矿车** —— 这正是需要的语义（站在矿车上/车里不会被误判成卡住）。
- 常态成本 = 一次 `collidesAt`（≤12 次 `getBlockId`，~1µs）；只有真被埋时才逐格上扫（最坏 128×12 ≈ 1536 次读，~0.1ms，一次性）。
- 抬升后可能悬空 → 由既有重力自然落下站稳，不做额外处理。

`Game._resolvePlayerStuck()` 做门控后转调：`player` 未构造 / **乘坐矿车中**（位置由矿车锁定，不得抢写）→ 直接 return。

**三个触发点**（覆盖全部被埋路径，不放帧循环以免与矿车 `pendingPlayerLift` 的帧内时序打架）：

| 触发点 | 覆盖的场景 |
|---|---|
| `scheduler.onColumnReady` 回调末尾（既有回调里加一行） | **主根因**：传送/出生后目标 column 加载完成的那一刻；以及 column 卸载重载后结构覆盖玩家 |
| `_teleportTo()` 内 `player.spawn` 之后 | 近处传送（目标 column 已加载）落点被埋 |
| `start()` 内 `player.spawn` 之后 | 恢复的位置被埋 |

`onColumnReady` 里先判「ready 的 column 是否与玩家 AABB 覆盖的 column 范围（最多 2×2）相交」，不相交直接 return —— 远处 column 加载不该付这份钱。

### B. 位置持久化：写进既有 `meta` 行，不新增 store

`src/save/persistence.js`：
- 内部缓存 meta（`loadMeta()` / `saveMeta()` 都刷新它）；
- 新增 `savePlayerPos([x,y,z])` = merge 进缓存后 `_put('meta', …)`。**必须 merge**：`saveMeta` 是整行 put，只写 `playerPos` 会把 `seed`/`spawn` 抹掉。

`src/core/game.js` 写入时机（用户要求「不要影响性能」）：
- **帧循环节流**：`_maybeSavePlayerPos(nowMs)` —— 距上次写入 ≥5s **且** 相对上次写入位置移动 ≥1 格才写。常态每帧成本 = 3 次减法比较；静止时零写入。
- **`_teleportTo()` 里立即写一次**（传送后位置突变，不能等 5s）；
- **`visibilitychange` / `beforeunload`** 既有 flush 处各补一次（⚠️ CLAUDE.md 已实测 unload 期的 IndexedDB 事务常被中止，所以它只是补充，5s 节流才是主保障）。

### C. 启动恢复

`start()` 改动（`spawnX/spawnY/spawnZ` 的语义**完全不动** —— 它们仍是 City 出生点，是「回家」按钮与 5 个既有 spec 的权威）：

1. 读 `meta.playerPos`，经 `validPlayerPos()` 校验（三个有限数 + y 在世界范围内），非法/缺失 → 回落 City 出生点（旧存档自然兼容，**不需要 settingsVersion 式迁移**）；
2. `preloadEdits` 的中心从「只有 City」改为 **City ∪ 恢复位置** 两个 (2R+1)² 区域的 key 并集（`Set` 去重）。⚠️ 这一步是必需的：`getEditsSync` 是同步的，GEN 前没 preload 就等于「该 column 无修改」→ 玩家改动静默丢失。顺带修掉一个既有缺口（在远离 City 处编辑后重启、再走回去，改动会丢）；
3. 仍先 `scheduler.update(spawnX,spawnZ)` + `_waitForColumn(city)` + `findSpawnY` 算出 `spawnY`（「回家」的落点权威不变）；
4. 若恢复位置的 column 尚未加载（`!world.hasColumn`），再 `scheduler.update(startX,startZ)` + `_waitForColumn(rcx, rcz, 10000, startX, startZ)`（第 4/5 参把调度中心推到目标，这是 v1.92 已踩过的坑）；
5. `player.spawn(startX, startY, startZ)` → `_resolvePlayerStuck()`。

启动成本：恢复位置在 City 加载半径内时**零额外开销**（`hasColumn` 命中即跳过）；远离时多等一个 column GEN + 多 preload 一批 edits（多为空行），一次性几百 ms。

## 三、改动文件

| 文件 | 改动 |
|---|---|
| `src/player/physics.js` | 新增 `resolveStuck(maxRaise)`；import `WORLD_HEIGHT` |
| `src/core/game.js` | `_resolvePlayerStuck()` / `_maybeSavePlayerPos()` / `validPlayerPos()`；`onColumnReady` 回调加一行；`_teleportTo` 加解卡+写盘；`start()` 恢复位置 + preload 并集 + 二次 `_waitForColumn`；帧循环与两个 unload 监听接线 |
| `src/save/persistence.js` | meta 缓存 + `savePlayerPos()` |
| `src/tests/test-physics.js` | 新增 `resolveStuck` 单测（Tier 1） |
| `tests/teleport.spec.mjs` | 新增「远处传送后不被埋」E2E（Tier 4） |
| `tests/persistence.spec.mjs` | 新增「重启恢复玩家位置」E2E（Tier 4） |
| `docs/roadmap.md` | v2.29 行 |
| `CLAUDE.md` | 活跃约束：`_teleportTo` 不等 column ⇒ 必须配解卡；`spawnX/Y/Z` 与「实际出生位置」是两套口径 |

## 四、验证

- **Tier 1**（`test-physics.js`，走 RED→GREEN）：① 埋 3 格深 → 抬到地表且 `vel.y=0`；② 未埋 → 返回 0 且 y 逐位不变；③ 全实心到顶 → 抬到 `WORLD_MAX_Y` 不越界；④ 花草/水（非 solid）不算被埋。
- **Tier 4**：
  - 传送：`?vd=2` 点「湖」/「高台」（目标 1000+ 格外）→ 等目标 column ready → 断言 `!physics.collidesAt(pos)` 且 `pos.y > WORLD_MIN_Y + 1`（**下界必须远离 -32**，否则注入回退也全绿）；
  - 恢复：走远/瞬移 → 显式 `savePlayerPos` + reload → 断言坐标与退出前一致（容差 1 格）且不在方块里；
  - 每条都做**负向验证**（去掉解卡 / 去掉恢复分支 → 必须真 FAIL），撤销注入用 `cp` 副本还原。
- **回归**：`npm run check`；`tests/teleport.spec.mjs`（8 条，其中「回家」断言 `home.y === spawnY` 依赖 `spawnX/Y/Z` 语义不变）、`persistence` / `clear-save` / `minecarts` / `turrets` / `playground` / `progress` / `city-visual`（都读 `spawnX/spawnZ` 或以出生点为基准放块）。
- **性能**：`npm run bench -- --check`（帧循环新增了每帧一次位置差比较，需确认 frameP95 无回退；若门禁阻断先做交替对照，不看单次数值）。

## 五、有意不做

- 不改 `_teleportTo` 的「不等 column」语义（那是 v1.92 实测定的，改成等待会让面板点击阻塞秒级）；
- 不动 `spawnX/spawnY/spawnZ` 的含义（「回家」按钮 + 5 个 spec 的权威）；
- 不把 `playerPos` 放进设置对象 / 进度包（`exportProgress` 的注释明确「不导出玩家位置，与 meta.spawn 语义冲突」——本次仍遵守，进度包格式不变）；
- 不做「解卡失败时回落到 City 出生点」的兜底（一路到顶都实心在世界生成里不存在，加了是死代码）。
