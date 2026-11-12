// tests/tnt.spec.mjs — M8 TNT 引爆/爆炸/连锁验收（规格 §2）
//
// Tier 1 断言落点说明：本 spec 的关键回归是「爆炸伤害半径」与「连锁去重」——
// 两者在纯逻辑单测里都能全绿却仍可能失效（伤害漏接线 → 丧尸不掉血但方块照样消失；
// 去重漏接线 → A↔B 永久互爆）。故断言必须落在**真游戏页的世界状态与计数**上。
import { test, expect } from 'playwright/test';

/**
 * 等世界真正稳定。
 *
 * ⚠️ **不能只判队列归零** —— 那是瞬时状态。`worldReady === true` 仅表示出生点邻域就绪，
 * 后台仍在填充 column/sections；高负载下队列可能短暂归零而 column 还在加载。
 * 正确判据 = **sections 连续两次采样不变**（跨帧比较）+ 队列归零。
 * ⚠️ **没有共享 helper 模块** —— `waitWorldSettled` 各 spec 各自定义
 * （整段照 `tests/zombie-nests.spec.mjs` 复制，含其注释与 90s timeout）。
 */
async function waitWorldSettled(page) {
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 90_000 });
  await page.waitForFunction(() => {
    const g = window.__MC_GAME__;
    const s = g.scheduler.stats();
    const sections = g.renderStats().sections;
    const prev = window.__MC_STABLE_PREV__;
    window.__MC_STABLE_PREV__ = sections;
    return prev === sections &&
      s.genInflight === 0 && s.meshInflight === 0 && s.meshQueued === 0 &&
      s.pendingMesh === 0 && s.lightInflight === 0 && s.lightQueued === 0 && s.uploadQueue === 0;
  }, null, { timeout: 90_000, polling: 500 });
}

/**
 * 本 spec 的起手式（⚠️ **没有 `startGame(page)` 这个 helper** —— 全仓 tests/ 零命中）：
 * 导航 + 等世界稳定。`?vd=2` 与既有 spec 同口径：加载半径小 → 世界稳定快。
 *
 * ⚠️ **必须钉 seed**：出生点由 region layout 派生（随 seed 变化），而本 spec 的测试场是
 * 相对玩家位置搭的 —— 不钉 seed 会让「测试场落在什么地形上」每次不同，全量连跑时偶发
 * FAIL（实测：单跑全绿、与 zombie-nests/turrets 连跑时第一条用例失败）。
 */
const URL = '/?vd=2&seed=12345';

async function boot(page) {
  await page.goto(URL);
  await waitWorldSettled(page);
}

/**
 * 在玩家附近搭一个 TNT 测试场：一片 stone 平台（y = by−1）+ 按 tntOffsets 放 TNT。
 *
 * `tntOffsets` 的每项是 **[dx, dy, dz]**（v2.97 前是两元 [dx, dz]，后者会把 dz 当 dy 用）。
 *
 * ⚠️ 平台必须铺在 **by−1** 而不是 by：`ZombieService.spawn()` 的门控是「脚格与头格必须是
 * 空气 + 脚下必须 solid」（`zombie-system.js:362-365`）。铺在 by 会占住丧尸脚格 →
 * `spawn()` 返回 null → 断言恒真（testing-policy §2.7：无效盲区）。
 */
async function setupField(page, { tntOffsets = [[0, 0, 0]] } = {}) {
  return page.evaluate((offsets) => {
    const g = window.__MC_GAME__;
    const p = g.player.physics.pos;
    const bx = Math.floor(p.x) + 3, by = Math.floor(p.y), bz = Math.floor(p.z);
    const stoneId = g.registry.idOf('stone');
    const tntId = g.registry.idOf('tnt');
    // 平台铺在 by−1（丧尸脚格 by 须为空气、脚下 by−1 须 solid）
    for (let dx = -4; dx <= 4; dx++) {
      for (let dz = -4; dz <= 4; dz++) {
        g.editor.setBlock({ x: bx + dx, y: by - 1, z: bz + dz, id: stoneId });
        // ⚠️ **必须清掉 by 与 by+1 两层**：`ZombieService.spawn()` 的门控是「脚格与头格
        // 都必须是空气」。天然地形（草/花/台阶/结构残块）可能正好占住这两层 →
        // `spawn()` 返回 null → 「不掉血」断言变成无效盲区（且前置自检的 `not.toBe(null)`
        // 会偶发失败）。实测：不钉 seed 时全量连跑偶发 FAIL 正是这条。
        g.editor.setBlock({ x: bx + dx, y: by, z: bz + dz, id: 0 });
        g.editor.setBlock({ x: bx + dx, y: by + 1, z: bz + dz, id: 0 });
      }
    }
    for (const [ox, oy, oz] of offsets) {
      g.editor.setBlock({ x: bx + ox, y: by + oy, z: bz + oz, id: tntId });
    }
    // 半径内一只（距中心约 2.04 格）+ 半径外一只（距中心约 6 格）
    const inner = g.zombies.spawn([bx + 2.5, by, bz + 0.5], { source: 'tnt-spec' });
    const outer = g.zombies.spawn([bx + 6.5, by, bz + 0.5], { source: 'tnt-spec' });
    // 半径内放一个 **非丧尸实体**（M5 probe）作对照 —— 爆炸伤害只枚举
    // `ZombieService.activeEntities()`（slot 表是单一权威），**不扫 EntityManager 全量集合**：
    // 那会把未来其它实体类型（弹丸/炮塔）也炸伤。⚠️ **没有这个对照，该断言是无效盲区**
    // （testing-policy §2.7 第 1 类）：注入「改用 entities() 全量枚举」时若无 probe 在场，
    // 断言照样全绿。
    const probe = g.entities.spawn({
      id: 'tnt-spec-probe', type: 'probe', persistent: false,
      state: { position: [bx + 2.5, by, bz + 0.5] },
    });
    return { bx, by, bz, inner, outer, probe, neighbor: [bx + 1, by - 1, bz] };
  }, tntOffsets);
}

test('引爆 TNT：默认不破坏地形但伤害半径内丧尸；开关开启后破坏地形', async ({ page }) => {
  test.setTimeout(120_000);
  await boot(page);
  const setup = await setupField(page);
  // ⚠️ 前置自检：两只丧尸都必须生成成功（否则「不掉血」断言是无效盲区）
  expect(setup.inner).not.toBe(null);
  expect(setup.outer).not.toBe(null);

  // 默认关（canTntDestroyBlocks=false）：地形不变
  await page.evaluate((c) => window.__MC_GAME__.explodeTnt(c.bx, c.by, c.bz), setup);
  const terrainIntact = await page.evaluate((n) =>
    window.__MC_GAME__.world.getBlockId(n[0], n[1], n[2]) !== 0, setup.neighbor);
  expect(terrainIntact).toBe(true);
  // 引爆格自身被移除（独立于破坏开关 —— mc-lite `PlayerInteraction.js:683-688` 同口径）
  const centerGone = await page.evaluate((c) =>
    window.__MC_GAME__.world.getBlockId(c.bx, c.by, c.bz) === 0, setup);
  expect(centerGone).toBe(true);
  // 半径内丧尸掉血 100 → 50
  const innerHealth = await page.evaluate((id) =>
    window.__MC_GAME__.zombies.get(id)?.health ?? null, setup.inner);
  expect(innerHealth).toBe(50);
  // 半径外丧尸不受影响（断言必须成对 —— 只断言「半径内掉血」会让恒真伤害全绿）
  const outerHealth = await page.evaluate((id) =>
    window.__MC_GAME__.zombies.get(id)?.health ?? null, setup.outer);
  expect(outerHealth).toBe(100);
  // 半径内的非丧尸实体不受影响（对照断言 —— 见 setupField 的 ⚠️）
  const probeAlive = await page.evaluate(() =>
    window.__MC_GAME__.entities.get('tnt-spec-probe') !== null);
  expect(probeAlive).toBe(true);
  // 音效播放请求计数增加（AudioContext 在无头环境未必可播 → 断言请求计数，M4 同手法）
  const plays = await page.evaluate(() =>
    window.__MC_GAME__.audioDebugState().playRequests.explosion ?? 0);
  expect(plays).toBeGreaterThanOrEqual(1);

  // 开启破坏后再炸一次 → 地形被破坏
  const destroyed = await page.evaluate((c) => {
    const g = window.__MC_GAME__;
    g.setTntBlockDamage(true);
    g.editor.setBlock({ x: c.bx, y: c.by, z: c.bz, id: g.registry.idOf('tnt') });
    g.explodeTnt(c.bx, c.by, c.bz);
    return g.world.getBlockId(c.neighbor[0], c.neighbor[1], c.neighbor[2]) === 0;
  }, setup);
  expect(destroyed).toBe(true);
});

test('连锁 TNT 依次引爆，且同格不重复引爆（去重生效）', async ({ page }) => {
  test.setTimeout(120_000);
  await boot(page);
  // 两格相距 2 的 tnt → 引爆第一格 → pending 队列 1 项
  const setup = await setupField(page, { tntOffsets: [[0, 0, 0], [2, 0, 0]] });
  const ignited = await page.evaluate((c) => window.__MC_GAME__.explodeTnt(c.bx, c.by, c.bz), setup);
  expect(ignited).toBe(true);
  const rightAfter = await page.evaluate(() => window.__MC_GAME__.tntChainDebugState());
  expect(rightAfter.pending).toBe(1);
  expect(rightAfter.exploded).toBe(1);

  // 等连锁到期（延迟 ∈ [500,1100]ms；轮询到 pending 归零，上限 5s）
  await page.waitForFunction(() => window.__MC_GAME__.tntChainDebugState().pending === 0,
    null, { timeout: 5_000, polling: 100 });
  const after = await page.evaluate(() => window.__MC_GAME__.tntChainDebugState());
  // ⚠️ **exploded === 2 而不是 3** —— 若去重失效，A↔B 相距 2 会永久互爆（计数无界增长）
  expect(after.exploded).toBe(2);
  // 两格 tnt 都已移除（连锁链终止的前提 = 引爆格自身被移除）
  const bothGone = await page.evaluate((c) => {
    const g = window.__MC_GAME__;
    return g.world.getBlockId(c.bx, c.by, c.bz) === 0 &&
      g.world.getBlockId(c.bx + 2, c.by, c.bz) === 0;
  }, setup);
  expect(bothGone).toBe(true);

  // ⚠️ **刻意不断言「同一格再放一格 tnt 后引爆返回 false」** —— 那不是缺陷而是正确行为：
  // `explodeTnt` 移除引爆格自身后会**释放去重键**（mc-lite `PlayerInteraction.js:687` 同口径，
  // 该格已非 tnt），故重新放一格新 tnt 再引爆理应成功。连锁**终止**靠的是「引爆格自身被移除」
  // （A 炸完变空气 → B 的连锁搜索找不到 A），不是靠去重键常驻。上面 `exploded === 2` 那条
  // 才是去重的真实证明（若去重失效，A↔B 会永久互爆 → 计数无界增长）。
});

test('破坏开关开启时，爆炸事务不删掉待爆的连锁 TNT（mc-lite :610 同口径）', async ({ page }) => {
  test.setTimeout(120_000);
  await boot(page);
  // 两格相距 1：既在 3×3×3 破坏范围内，也在 5×5×5 连锁范围内 → 破坏事务会碰到待爆 TNT
  const setup = await setupField(page, { tntOffsets: [[0, 0, 0], [1, 0, 0]] });
  await page.evaluate(() => window.__MC_GAME__.setTntBlockDamage(true));
  await page.evaluate((c) => window.__MC_GAME__.explodeTnt(c.bx, c.by, c.bz), setup);
  // 待爆的那格**仍在**（若没被过滤，它会被自己的破坏事务删掉 → 连锁静默丢失）
  const pendingIntact = await page.evaluate((c) =>
    window.__MC_GAME__.world.getBlockId(c.bx + 1, c.by, c.bz) !== 0, setup);
  expect(pendingIntact).toBe(true);
  const rightAfter = await page.evaluate(() => window.__MC_GAME__.tntChainDebugState());
  expect(rightAfter.pending).toBe(1);
  // 它照常到期引爆 → 总数 2
  await page.waitForFunction(() => window.__MC_GAME__.tntChainDebugState().pending === 0,
    null, { timeout: 5_000, polling: 100 });
  const after = await page.evaluate(() => window.__MC_GAME__.tntChainDebugState());
  expect(after.exploded).toBe(2);
  // 周围普通地形确实被破坏了（开关生效 —— 证明上一条不是「破坏根本没发生」的假绿）
  const neighborGone = await page.evaluate((c) =>
    window.__MC_GAME__.world.getBlockId(c.bx + 1, c.by - 1, c.bz) === 0, setup);
  expect(neighborGone).toBe(true);
});

test('v2.97 回归：TNT 团组连锁后每格都消失，且不留去重键（用户报告「有些 TNT 没消失」）', async ({ page }) => {
  test.setTimeout(120_000);
  await boot(page);
  // 2×2×2 八连通团组：每一格都在别人的 5×5×5 里，也是首爆 3×3×3 的破坏对象。
  // 这是链式重复入队与「待爆 TNT 被自身破坏事务删掉」两件事同时压到的形态。
  const offsets = [];
  for (let ox = 0; ox < 2; ox++) {
    for (let oy = 0; oy < 2; oy++) {
      for (let oz = 0; oz < 2; oz++) offsets.push([ox, oy, oz]);
    }
  }
  const setup = await setupField(page, { tntOffsets: offsets });
  // 前置自检：八格必须真的都放上了 TNT（放不上 = 断言无效盲区）
  const placed = await page.evaluate(({ c, off }) => {
    const g = window.__MC_GAME__;
    const tntId = g.registry.idOf('tnt');
    return off.filter(([ox, oy, oz]) =>
      g.world.getBlockId(c.bx + ox, c.by + oy, c.bz + oz) === tntId).length;
  }, { c: setup, off: offsets });
  expect(placed).toBe(offsets.length);

  // 走玩家真实入口（左键命中 TNT → 引爆），不用测试 API 直接点火
  const ignited = await page.evaluate((c) => {
    const g = window.__MC_GAME__;
    g.player.target = { blockPos: [c.bx, c.by, c.bz], prevPos: [c.bx, c.by + 1, c.bz], normal: [0, 1, 0], dist: 2 };
    g.player.digBlock();
    return g.tntChainDebugState();
  }, setup);
  expect(ignited.exploded, '左键命中 TNT 必须引爆').toBe(1);

  await page.waitForFunction(() => window.__MC_GAME__.tntChainDebugState().pending === 0,
    null, { timeout: 10_000, polling: 100 });

  const after = await page.evaluate(({ c, off }) => {
    const g = window.__MC_GAME__;
    const tntId = g.registry.idOf('tnt');
    return {
      remain: off.filter(([ox, oy, oz]) =>
        g.world.getBlockId(c.bx + ox, c.by + oy, c.bz + oz) !== 0).length,
      tnt: off.filter(([ox, oy, oz]) =>
        g.world.getBlockId(c.bx + ox, c.by + oy, c.bz + oz) === tntId).length,
      ...g.tntChainDebugState(),
    };
  }, { c: setup, off: offsets });
  // 核心断言：八格必须全部消失（旧实现下会残留 TNT 格）
  expect(after.tnt, '连锁后不得有任何 TNT 格残留').toBe(0);
  // exploded 必须是 8 而不是更多 —— >8 即「同一格被炸两次」（幽灵爆炸）
  expect(after.exploded, '八格 TNT 恰好 8 次爆炸（多出即重复引爆）').toBe(8);
  // 队列排空且不再增长（旧实现会不断重复入队）
  expect(after.pending).toBe(0);
});

test('v2.97 回归：同一弹坑重建 TNT 再引爆仍能炸掉（去重键不泄漏）', async ({ page }) => {
  test.setTimeout(120_000);
  await boot(page);
  const offsets = [[0, 0, 0], [1, 0, 0], [2, 0, 0]];
  const setup = await setupField(page, { tntOffsets: offsets });
  const ignite = () => page.evaluate((c) => {
    const g = window.__MC_GAME__;
    g.player.target = { blockPos: [c.bx, c.by, c.bz], prevPos: [c.bx, c.by + 1, c.bz], normal: [0, 1, 0], dist: 2 };
    g.player.digBlock();
    return g.tntChainDebugState();
  }, setup);
  const cellIds = () => page.evaluate(({ c, off }) => {
    const g = window.__MC_GAME__;
    const tntId = g.registry.idOf('tnt');
    return {
      ids: off.map(([ox, oy, oz]) => g.world.getBlockId(c.bx + ox, c.by + oy, c.bz + oz)),
      tntRemain: off.filter(([ox, oy, oz]) =>
        g.world.getBlockId(c.bx + ox, c.by + oy, c.bz + oz) === tntId).length,
      ...g.tntChainDebugState(),
    };
  }, { c: setup, off: offsets });
  const settleChain = () => page.waitForFunction(
    () => window.__MC_GAME__.tntChainDebugState().pending === 0, null, { timeout: 10_000, polling: 100 });

  // 第一轮
  await ignite();
  await settleChain();
  const round1 = await cellIds();
  expect(round1.tntRemain, '第一轮三连 TNT 必须全部消失').toBe(0);
  expect(round1.exploded, '三连 = 3 次爆炸（多出即幽灵爆炸）').toBe(3);

  // 第二轮：玩家会在同一弹坑里重新放 TNT 继续玩 —— 旧实现下第三格会静默拒爆、永远留在原地。
  // 放块走 `editor.setBlock`（= `WorldEditor` 唯一写入口，玩家右键的 `placeBlock()` 也落到它）：
  // 本用例要验的是「引爆链路不因旧键而拒爆」，放块本身已有专项用例覆盖。
  const round2Ignite = await page.evaluate(({ c, off }) => {
    const g = window.__MC_GAME__;
    const tntId = g.registry.idOf('tnt');
    for (const [ox, oy, oz] of off) {
      const x = c.bx + ox, y = c.by + oy, z = c.bz + oz;
      g.editor.setBlock({ x, y, z, id: tntId });
    }
    g.player.target = { blockPos: [c.bx, c.by, c.bz], prevPos: [c.bx, c.by + 1, c.bz], normal: [0, 1, 0], dist: 2 };
    g.player.digBlock();
    return g.tntChainDebugState();
  }, { c: setup, off: offsets });
  expect(round2Ignite.exploded, '第二轮的首格必须能引爆（旧实现这里返回 false 静默不动）').toBe(4);
  await settleChain();
  const round2 = await cellIds();
  expect(round2.tntRemain, '第二轮三连也必须全部消失').toBe(0);
  expect(round2.exploded, '第二轮总数 6（3 + 3）').toBe(6);
});

test('背包选中路径：从背包选 tnt 右键放块，再左键挖块引爆（不是挖掉）', async ({ page }) => {
  test.setTimeout(120_000);
  await boot(page);
  // ⚠️ M7 教训：只走测试 API 的 E2E 曾全绿却漏了「背包放置只放一格」缺陷（M7 验收报告 §3.7）。
  // 故本用例走**背包选中槽**（`inventory.selectSlot` = 背包面板点击槽位的真实落点）+
  // `player.placeBlock()` / `player.digBlock()`（与键鼠同一代码路径）。
  const placed = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    const p = g.player.physics.pos;
    const bx = Math.floor(p.x) + 3, by = Math.floor(p.y), bz = Math.floor(p.z);
    // 铺支撑（by−1），使 by 格可放块且有地面
    g.editor.setBlock({ x: bx, y: by - 1, z: bz, id: g.registry.idOf('stone') });
    const idx = g.player.inventory.slots.findIndex((s) => s.item === 'tnt');
    g.player.inventory.selectSlot(idx);
    // 右键放块：origin = prevPos（空气格），命中方块 = 脚下支撑格
    g.player.target = { blockPos: [bx, by - 1, bz], prevPos: [bx, by, bz], normal: [0, 1, 0], dist: 2 };
    g.player.placeBlock();
    return {
      bx, by, bz, slotIndex: idx, id: g.world.getBlockId(bx, by, bz),
      selectedItem: g.player.inventory.getSelected()?.item ?? null,
      hotbarIndex: g.player.hotbarIndex,
    };
  });
  // ⚠️ 这条要保留判别力（M7 教训）：只要 tnt 能被**快捷栏数字键**一键选到，就测不到那条缺陷（先 shortcut 后成功，遮蔽了面板分流路径）。
  // v2.96 把 tnt 放到了快捷栏第 8 格（index 7）⇒ 旧断言 `> 4` 失效、`>= 9` 也不成立。
  // 改为钉「选中槽确实被换成 tnt 那一槽、且 hotbarIndex 别名同步」（证明走的是 selectSlot 而非原来的首槽 stone）。
  expect(placed.slotIndex).toBeGreaterThan(0);           // 不是首槽 stone
  expect(placed.selectedItem).toBe('tnt');                // 选中槽确实切到了 tnt
  expect(placed.hotbarIndex).toBe(placed.slotIndex);      // hotbarIndex 是 selectedSlot 的别名（单一权威）
  expect(placed.id).toBe(await page.evaluate(() => window.__MC_GAME__.registry.idOf('tnt')));

  // 左键挖块命中 tnt → 引爆（**不是**把它当普通方块挖掉）
  const dug = await page.evaluate((c) => {
    const g = window.__MC_GAME__;
    const before = g.tntChainDebugState().exploded;
    g.player.target = { blockPos: [c.bx, c.by, c.bz], prevPos: [c.bx, c.by + 1, c.bz], normal: [0, 1, 0], dist: 2 };
    g.player.digBlock();
    return {
      exploded: g.tntChainDebugState().exploded,
      grew: g.tntChainDebugState().exploded > before,
      id: g.world.getBlockId(c.bx, c.by, c.bz),
      // 徒手挖块会记 lastRemovedBlock；引爆不该记（它不是「挖掉一个方块」）
      remembered: g.player.lastRemovedBlock ? { ...g.player.lastRemovedBlock } : null,
    };
  }, placed);
  expect(dug.grew).toBe(true);        // 真的引爆了
  expect(dug.id).toBe(0);             // 引爆格自身被移除
  expect(dug.remembered).toBe(null);  // 走的是引爆分支，不是挖块分支
});

test('枪击命中 TNT 引爆，且不受「枪械破坏」开关门控（mc-lite 同口径）', async ({ page }) => {
  test.setTimeout(120_000);
  await boot(page);
  const setup = await setupField(page);
  const r = await page.evaluate(async (c) => {
    const g = window.__MC_GAME__;
    await g.selectWeapon('pistol');
    g.setGunBlockDamage(false);           // 枪械破坏关闭
    const before = g.tntChainDebugState().exploded;
    // 瞄准 tnt（朝下瞄向脚前一格）：setTestAim 会同帧重算 player.target
    g.player.spawn(c.bx + 0.5, c.by + 2, c.bz + 0.5);
    g.player.setTestAim([0, -1, 0]);
    g.fireWeaponOnce();
    return {
      grew: g.tntChainDebugState().exploded > before,
      id: g.world.getBlockId(c.bx, c.by, c.bz),
    };
  }, setup);
  expect(r.grew).toBe(true);   // 引爆发生（mc-lite `PlayerInteraction.js:1048-1057`：tnt 分支在破坏开关之前）
  expect(r.id).toBe(0);
});

test('设置面板：TNT 破坏开关落在右列、生效且持久化', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(URL);
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 90_000 });
  await page.locator('#settings-btn').click();
  await expect(page.locator('#settings-modal')).toBeVisible();

  // ⚠️ 落位断言：该组必须落在**右列**（`.mc-columns` 的第二个 `.mc-column`），
  // 且 v1.98 起与「进度管理」共用合并盒（用户 2026-10-31：「同样的处理方式，也处理一下
  // TNT破坏和进度管理」）。断言钉住两件事：① 仍在右列；② 与进度同盒（被挪回独立一行
  // 或跨列都会失败）。
  const placement = await page.evaluate(() => {
    const cols = [...document.querySelectorAll('#settings-modal .mc-columns > .mc-column')];
    if (cols.length !== 2) return { cols: cols.length };
    const inCol = (col, title) => [...col.querySelectorAll('.mc-title')]
      .some((t) => t.textContent === title);
    const combined = document.getElementById('btn-progress-import')?.closest('.mc-combined');
    const titles = combined
      ? [...combined.querySelectorAll('.mc-title')].map((t) => t.textContent) : [];
    return {
      cols: 2,
      tntInRight: inCol(cols[1], 'TNT 破坏'),
      tntInLeft: inCol(cols[0], 'TNT 破坏'),
      sameCombined: titles.includes('TNT 破坏') && titles.includes('进度管理'),
    };
  });
  expect(placement.cols).toBe(2);
  expect(placement.tntInRight, '「TNT 破坏」必须在右列').toBe(true);
  expect(placement.tntInLeft).toBe(false);
  expect(placement.sameCombined, 'TNT 破坏与进度管理必须同处一个合并盒').toBe(true);

  // ⚠️ **不能用全局文本匹配点按钮** —— 「关闭/开启」文案在面板里有**多组重复**
  // （枪械破坏 / TNT 破坏 / 雾色 / 背景音乐），全局查找会先命中其它组。
  // 故按**组标题作用域**定位：先找到含「TNT 破坏」标题的组，再点它自己的按钮。
  await page.evaluate(() => {
    const row = [...document.querySelectorAll('#settings-modal .mc-combined-col')]
      .find((r) => r.querySelector('.mc-title')?.textContent === 'TNT 破坏');
    [...row.querySelectorAll('button')].find((b) => b.textContent === '开启').click();
  });
  await page.waitForFunction(() => {
    const g = window.__MC_GAME__;
    const s = JSON.parse(localStorage.getItem('mc_heavy_settings_v1') || '{}');
    return g.canTntDestroyBlocks === true && s.tntDamage === true;
  }, null, { timeout: 5_000 });
  // 关掉：两态都要可达（单态开关是常见回归）
  await page.evaluate(() => {
    const row = [...document.querySelectorAll('#settings-modal .mc-combined-col')]
      .find((r) => r.querySelector('.mc-title')?.textContent === 'TNT 破坏');
    [...row.querySelectorAll('button')].find((b) => b.textContent === '关闭').click();
  });
  await page.waitForFunction(() => {
    const g = window.__MC_GAME__;
    const s = JSON.parse(localStorage.getItem('mc_heavy_settings_v1') || '{}');
    return g.canTntDestroyBlocks === false && s.tntDamage === false;
  }, null, { timeout: 5_000 });
});

test('爆炸序列帧特效：引爆时 spawn 生效，到期后回收（真游戏页接线断言）', async ({ page }) => {
  test.setTimeout(120_000);
  await boot(page);
  const setup = await setupField(page);

  // ⚠️ **为什么须在真游戏页断言**（不能只靠隔离 fixture）：fixture 直接构造
  // `ExplosionSpriteRenderer`，测不到 `game.js` 的**接线** —— 忘了调 `spawn()`、装配顺序
  // 错（M7 活跃约束：controller 接线晚于 `onColumnReady` → 恒 0）、或 `dispose` 漏接线，
  // fixture 全绿而真实游戏里爆炸**只有球体没有序列帧**（静默失效，肉眼只见「少了一层」）。
  // 同 M7 教训：接线测试须从真实入口进入。

  // ① 图集真的加载上了（否则整个特效静默禁用 —— 排除「加载失败 → 断言假绿」）
  const info = await page.evaluate(() => {
    const es = window.__MC_GAME__.explosionSprite;
    return {
      exists: !!es,
      ready: es?.ready ?? false,
      slotCount: es?.sprites().length ?? 0,
      activeBefore: es?.activeCount() ?? -1,
      hiddenBefore: es ? es.sprites().every((s) => !s.visible) : false,
    };
  });
  expect(info.exists, 'game 须装配 explosionSprite（接线断言）').toBe(true);
  expect(info.ready, '爆炸序列帧图集须加载成功').toBe(true);
  expect(info.slotCount, '池容量须为 10').toBe(10);
  expect(info.activeBefore, '引爆前活跃 slot 须为 0').toBe(0);
  expect(info.hiddenBefore, '引爆前全部 slot 须 visible=false（draw call 基线）').toBe(true);

  // ② 引爆 → 序列帧特效真的起了（`explodeTnt` 的 ⑦ 段接线）
  await page.evaluate((c) => window.__MC_GAME__.explodeTnt(c.bx, c.by, c.bz), setup);
  const afterBurst = await page.evaluate(() => {
    const es = window.__MC_GAME__.explosionSprite;
    return {
      active: es.activeCount(),
      visible: es.sprites().filter((s) => s.visible).length,
      // sprite 位置须是**块中心**（块坐标 + 0.5）—— 实例原点换算基准（CLAUDE.md 活跃约束，
      // 极易误判几何差异）。传块坐标会让特效整体偏半格。
      pos: es.sprites().find((s) => s.visible)?.position.toArray() ?? null,
    };
  });
  expect(afterBurst.active, '引爆后须有 1 个活跃序列帧特效').toBe(1);
  expect(afterBurst.visible, '引爆后须有 1 个可见 Sprite').toBe(1);
  expect(afterBurst.pos, '特效位置须为块中心（块坐标 + 0.5）')
    .toEqual([setup.bx + 0.5, setup.by + 0.5, setup.bz + 0.5]);

  // ③ 到期后回收（0.5s 寿命）—— 全部 slot 回到 visible=false → draw call 回基线。
  // ⚠️ 与 M6 活跃约束 ① 同一口径：常驻特效池若空闲时仍 visible，会恒增 draw call 且
  // 进入透明渲染列表干扰水面排序不变式。
  await page.waitForFunction(() => window.__MC_GAME__.explosionSprite.activeCount() === 0,
    null, { timeout: 5_000, polling: 100 });
  const afterExpire = await page.evaluate(() => {
    const es = window.__MC_GAME__.explosionSprite;
    return { active: es.activeCount(), visible: es.sprites().filter((s) => s.visible).length };
  });
  expect(afterExpire.active, '到期后活跃 slot 须归零').toBe(0);
  expect(afterExpire.visible, '到期后可见 Sprite 须归零').toBe(0);
});

