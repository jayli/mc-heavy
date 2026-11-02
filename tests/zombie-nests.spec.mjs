import { test, expect } from 'playwright/test';

/**
 * M7 丧尸巢穴验收。
 *
 * Tier 1 断言落点说明：本 spec 的关键回归是「GEN 接管后 edits 与 anchor 必须一起重建」。
 * 该缺陷在方块层面**看不出差别**（旧 anchor 的 gold_block 仍在渲染、巢穴照样刷怪），
 * 只在「接管后再编辑一次 + flush + 重启」时暴露 —— 旧 edits 被只含新编辑的 Map 整库覆盖。
 * 故断言必须落在**落盘结果与重启后的 anchor**上，不能只检查 scene 或方块 id。
 */

/** 等待世界完全收敛（M4/M5 同一口径：队列全零）。 */
/**
 * 等世界真正稳定。
 *
 * ⚠️ **不能只判队列归零** —— 那是瞬时状态。`worldReady === true` 仅表示出生点邻域就绪，
 * 后台仍在填充 column/sections；高负载下（全量回归连跑）队列可能短暂归零而 column 还在加载。
 * 此时 `findLegalOrigin` 会对**未加载**位置读到 `getBlockId === 0` → `groundY === null` →
 * 返回 null，断言根本没跑到（实测踩坑：`hydrate` 用例单独跑通过、全量跑时
 * `expect(legal).not.toBe(null)` 失败）。
 *
 * 正确判据 = **sections 连续两次采样不变**（跨帧比较）+ 队列归零。
 * @see 项目记忆 world-stable-judgement-in-playwright-specs
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

test('GEN 接管后旧 edits 与 anchor 不被新编辑覆盖（重启两次仍保留）', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/?vd=2');
  await waitWorldSettled(page);

  // 第一次：写入 anchor（gold_block + blockEntity）与一个普通 edit，flush 落盘
  const placed = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    const px = Math.floor(g.player.physics.pos.x) + 2;
    const pz = Math.floor(g.player.physics.pos.z) + 2;
    let groundY = -1;
    for (let y = 90; y > -32; y--) { if (g.world.getBlockId(px, y, pz) !== 0) { groundY = y; break; } }
    const goldId = g.registry.idOf('gold_block');
    const stoneId = g.registry.idOf('stone');
    const anchor = { x: px, y: groundY + 5, z: pz };
    // 关键方块下方垫支撑，保证 anchor 是真实可放置位置（不参与断言，只避免悬空）
    g.editor.setBlocks([
      { x: anchor.x, y: groundY + 1, z: anchor.z, id: stoneId },
      { x: px, y: groundY + 1, z: pz, id: stoneId },
      {
        x: anchor.x, y: anchor.y, z: anchor.z, id: goldId,
        blockEntity: {
          kind: 'zombie-nest', id: 'nest-a', origin: [anchor.x, groundY, anchor.z],
          critical: { ...anchor, id: goldId }, lastSpawnAt: 0,
        },
      },
    ]);
    const key = `${Math.floor(anchor.x / 16)},${Math.floor(anchor.z / 16)}`;
    await g.persistence.flushNow(g.world);
    return { anchor, goldId, key, groundY };
  });

  // 第二次：重启 → GEN 接管该 column。接管必须重建 edits Map 与 blockEntities
  await page.reload();
  await waitWorldSettled(page);
  await page.waitForFunction(
    ([x, z]) => window.__MC_GAME__.world.hasColumn(Math.floor(x / 16), Math.floor(z / 16)),
    [placed.anchor.x, placed.anchor.z], { timeout: 60_000 },
  );
  const afterTakeover = await page.evaluate(({ anchor, key }) => {
    const g = window.__MC_GAME__;
    const col = g.world.getColumn(Math.floor(anchor.x / 16), Math.floor(anchor.z / 16));
    return {
      editsSize: col.edits.size,
      entitiesSize: col.blockEntities.size,
      anchorKind: g.world.getBlockEntity(anchor.x, anchor.y, anchor.z)?.kind ?? null,
      anchorId: g.world.getBlockEntity(anchor.x, anchor.y, anchor.z)?.id ?? null,
      key,
    };
  }, placed);
  expect(afterTakeover.editsSize).toBeGreaterThan(0); // 接管重建 edits（缺陷时为 0）
  expect(afterTakeover.entitiesSize).toBe(1);
  expect(afterTakeover.anchorKind).toBe('zombie-nest');
  expect(afterTakeover.anchorId).toBe('nest-a');

  // 第三次：接管后再编辑一格 + flush + 重启。旧 anchor 必须不被覆盖
  await page.evaluate(async ({ anchor }) => {
    const g = window.__MC_GAME__;
    const dirtId = g.registry.idOf('dirt');
    g.editor.setBlock({ x: anchor.x + 1, y: anchor.y, z: anchor.z, id: dirtId });
    await g.persistence.flushNow(g.world);
  }, placed);

  await page.reload();
  await waitWorldSettled(page);
  await page.waitForFunction(
    ([x, z]) => window.__MC_GAME__.world.hasColumn(Math.floor(x / 16), Math.floor(z / 16)),
    [placed.anchor.x, placed.anchor.z], { timeout: 60_000 },
  );
  const afterSecondReload = await page.evaluate(({ anchor, goldId }) => {
    const g = window.__MC_GAME__;
    const entity = g.world.getBlockEntity(anchor.x, anchor.y, anchor.z);
    return {
      blockId: g.world.getBlockId(anchor.x, anchor.y, anchor.z),
      kind: entity?.kind ?? null,
      id: entity?.id ?? null,
      stoneId: g.registry.idOf('stone'),
      goldId,
    };
  }, placed);
  expect(afterSecondReload.blockId).toBe(placed.goldId); // 关键方块仍是 gold_block
  expect(afterSecondReload.kind).toBe('zombie-nest');     // anchor 未被 flush 覆盖丢失
  expect(afterSecondReload.id).toBe('nest-a');
});

test('listBlockEntities 枚举的锚点数与已加载 column 无关', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/?vd=2');
  await waitWorldSettled(page);
  const anchors = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    const goldId = g.registry.idOf('gold_block');
    // 往一个**未加载** column 直接写 anchor 行（模拟远处巢穴只存在于存档）
    await g.persistence.saveColumnEdits('99,99', [
      { index: 10, id: goldId, meta: 0, blockEntity: { kind: 'zombie-nest', id: 'nest-far' } },
    ]);
    const list = await g.persistence.listBlockEntities('zombie-nest');
    return { count: list.length, hasFar: list.some((a) => a.columnKey === '99,99') };
  });
  expect(anchors.count).toBeGreaterThanOrEqual(1);
  expect(anchors.hasFar).toBe(true); // 未加载 column 的锚点仍可枚举 → 上限跨卸载有效
});

test('新放置的巢穴必须立刻有 controller 并在 8 秒后刷怪', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/?vd=2');
  await waitWorldSettled(page);

  // 关键缺口：column 加载时 onColumnReady 已触发（那时还没有锚点），故 place() 成功后
  // 若没人创建 controller，巢穴**永不刷怪**（方块都写对了、anchor 也在，肉眼看不出差别）。
  const legal = await findLegalOrigin(page);
  expect(legal).not.toBe(null);
  const placed = await page.evaluate((origin) => {
    const g = window.__MC_GAME__;
    g.selectPlaceable('zombie_nest_alias_block');
    // 真实 DDA target 形状：`blockPos` = 命中的地面格（巢穴 origin），
    // `prevPos` = 命中前一格（空气）。`placeBlock` 的物品名分流读 `blockPos`。
    g.player.target = {
      hit: true, blockPos: [origin[0], origin[1], origin[2]],
      prevPos: [origin[0], origin[1] + 1, origin[2]], dist: 2, normal: [0, 1, 0],
    };
    g.player.placeBlock();
    return {
      controllers: g.nests.controllers().size,
      zombiesBefore: g.zombies.count(),
      origin,
    };
  }, legal.origin);
  expect(placed.controllers).toBe(1); // place 成功后须立刻有 controller（缺口时为 0）

  // 8 秒后须刷出丧尸（controller 缺失时恒为 0）
  await page.waitForTimeout(10_000);
  const after = await page.evaluate(() => window.__MC_GAME__.zombies.count());
  expect(after).toBeGreaterThan(placed.zombiesBefore);
});

test('受控创造模式选择入口：alias 可放置巢穴、不改 hotbar、播放 put', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/?vd=2');
  await waitWorldSettled(page);

  // 未知物品 → selectPlaceable 返回 false 且不写世界
  const unknown = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    const before = g.world.columns.size;
    const ok = g.selectPlaceable('no_such_block');
    return { ok, before, after: g.world.columns.size };
  });
  expect(unknown.ok).toBe(false);
  expect(unknown.after).toBe(unknown.before);

  // alias → selectPlaceable 返回 true，且 hotbar index / 库存不变
  const selected = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    const indexBefore = g.player.hotbarIndex;
    const slotBefore = g.player.inventory.getSelected()?.item ?? null;
    const ok = g.selectPlaceable('zombie_nest_alias_block');
    return {
      ok,
      indexChanged: g.player.hotbarIndex !== indexBefore,
      slotChanged: (g.player.inventory.getSelected()?.item ?? null) !== slotBefore,
    };
  });
  expect(selected.ok).toBe(true);
  expect(selected.indexChanged).toBe(false); // 五格 hotbar 语义不变
  expect(selected.slotChanged).toBe(false);
});

test('玩家主路径：从背包选中巢穴图标 → 右键放置整个 38 方块结构（不是单格）', async ({ page }) => {
  // ⚠️ **独立 test（新 page = 新 game 实例）**，不与上一条合并 —— 上一条调过
  // `selectPlaceable()` 会残留 `_selectedPlaceable` 标志，让 `placeBlock` 走 API 分支
  // 而非背包物品名分流分支。合并时注入「移除背包分流」仍全绿（实测无效盲区）：
  // 用户报告的缺陷恰恰发生在背包分流路径，却被 API 分支掩盖了。
  test.setTimeout(120_000);
  await page.goto('/?vd=2');
  await waitWorldSettled(page);

  const legal = await findLegalOrigin(page);
  expect(legal).not.toBe(null);
  const placed = await page.evaluate(async (origin) => {
    const g = window.__MC_GAME__;
    const putBefore = g.audioDebugState().playRequests.put ?? 0;
    const aliasId = g.registry.idOf('zombie_nest_alias_block');

    // ① 在背包里找到巢穴图标槽并选中（模拟玩家从背包面板点击）
    const slotIdx = g.player.inventory.slots.findIndex((s) => s.item === 'zombie_nest_alias_block');
    if (slotIdx < 0) return { noSlotInInventory: true };
    g.player.inventory.selectSlot(slotIdx);
    const selectedItem = g.player.inventory.getSelected()?.item ?? null;
    const hotbarIndexBefore = g.player.hotbarIndex;

    // ② 构造真实 DDA target：玩家看向地面格。`blockPos` = 命中方块（地面），
    //    `prevPos` = 命中前一格（空气）—— 与 raycast.js 返回的形状一致。
    const [gx, gy, gz] = origin;
    g.player.target = { hit: true, blockPos: [gx, gy, gz], prevPos: [gx, gy + 1, gz], dist: 2, normal: [0, 1, 0] };

    // ③ 右键放置（走 Player.placeBlock 的物品名分流）
    g.player.placeBlock();

    // ④ 用蓝图核对**全部 38 个方块**都落地（核心断言：不是单格！）
    const { loadNestBlueprint } = await import('/src/entities/zombie-nests/nest-blueprint.js');
    const bp = await loadNestBlueprint(g.registry);
    const expected = bp.changesAt(origin);
    const missing = expected.filter((c) => g.world.getBlockId(c.x, c.y, c.z) !== c.id);
    const anchor = [gx, gy + 5, gz];
    return {
      selectedItem,
      hotbarChanged: g.player.hotbarIndex !== hotbarIndexBefore,
      expectedCount: expected.length,
      missingCount: missing.length,
      missing: missing.slice(0, 3),
      aliasBlocksInWorld: expected.filter((c) => g.world.getBlockId(c.x, c.y, c.z) === aliasId).length,
      anchorEntityId: g.world.getBlockEntity(anchor[0], anchor[1], anchor[2])?.id ?? null,
      anchorBlockId: g.world.getBlockId(anchor[0], anchor[1], anchor[2]),
      goldId: g.registry.idOf('gold_block'),
      aliasId,
      count: g.nests.count(),
      controllers: g.nests.controllers().size,
      putBefore,
      putAfter: g.audioDebugState().playRequests.put ?? 0,
    };
  }, legal.origin);

  expect(placed.noSlotInInventory).toBe(undefined); // 巢穴图标须在背包里（mc-lite 同口径）
  expect(placed.selectedItem).toBe('zombie_nest_alias_block');
  expect(placed.expectedCount).toBe(38);
  // **整个结构全部落地**。缺陷时（不路由到实体放置）实测 missing = **38**（不是 37）：
  // 退化的单格放置落在 `blockPos` = 地面格，而该格本就是 solid → 38 个期望格无一匹配。
  expect(placed.missingCount).toBe(0);
  expect(placed.aliasBlocksInWorld).toBe(0); // alias 本身不写入世界
  expect(placed.anchorEntityId).not.toBe(null); // 锚点建立 → 能刷怪
  expect(placed.anchorBlockId).toBe(placed.goldId);
  expect(placed.count).toBe(1);
  expect(placed.controllers).toBe(1);
  expect(placed.hotbarChanged).toBe(false); // 五格 hotbar 语义不变
  expect(placed.putAfter).toBe(placed.putBefore + 1); // 成功放置尝试播放 put
});

/**
 * 找一个可用的巢穴 origin。
 *
 * **两段式**：先找「5×5×5 占地天然全空 + 脚下 solid」的落点；找不到就**人为清理**一个。
 * 为什么必须兜底 —— Playwright 每个 test 是全新 context = **新随机 seed**，出生点落在
 * 城市里时房子/树密集，单靠搜索会间歇性找不到落点（实测踩坑：`skipped=true`，断言根本没跑到，
 * 且同一份代码不同 seed 时过时不过）。扩搜索范围只是降低概率，没消除 flaky。
 *
 * 人为清理不会掩盖 `occupied` 判定的真实行为 —— 那条判定由**单测**独立覆盖
 * （`ZombieNestService: 第九个、碰撞和玩家重叠均零写入`）；本 spec 各条测的是**接线**
 * （alias 分流 / controller 创建 / 三种破坏同义），不是放置预检。
 * @returns {Promise<{origin: number[]}|null>}
 */
async function findLegalOrigin(page) {
  return page.evaluate(() => {
    const g = window.__MC_GAME__;
    const px = Math.floor(g.player.physics.pos.x);
    const pz = Math.floor(g.player.physics.pos.z);
    const probe = (ox, oz) => {
      // ⚠️ **必须先确认 column 已加载**：未加载位置的 `getBlockId` 恒为 0（air），
      // 会让下面的「全空」判定**误判为合法落点** → place() 随后以 'bounds' 拒绝，
      // 表现为「找到了 origin 却放置失败」而非「没找到 origin」，更难定位。
      if (!g.world.hasColumn(Math.floor(ox / 16), Math.floor(oz / 16))) return null;
      let groundY = null;
      for (let y = 90; y > -32; y--) {
        if (g.world.getBlockId(ox, y, oz) !== 0) { groundY = y; break; }
      }
      if (groundY === null || !g.world.isSolid(ox, groundY, oz)) return null;
      let clear = true;
      for (let dx = -2; dx <= 2 && clear; dx++) {
        for (let dz = -2; dz <= 2 && clear; dz++) {
          for (let dy = 1; dy <= 5; dy++) {
            if (g.world.getBlockId(ox + dx, groundY + dy, oz + dz) !== 0) { clear = false; break; }
          }
        }
      }
      return clear ? [ox, groundY, oz] : null;
    };
    // ① 天然全空落点（不写世界，保留 occupied 判定的真实输入）
    for (let ox = px + 4; ox <= px + 30; ox++) {
      for (let oz = pz - 30; oz <= pz + 30; oz++) {
        const hit = probe(ox, oz);
        if (hit) return { origin: hit };
      }
    }
    // ② 兜底：取一个脚下 solid 的位置，清理 5×5×5 占地后返回
    for (let ox = px + 4; ox <= px + 30; ox++) {
      for (let oz = pz - 30; oz <= pz + 30; oz++) {
        if (!g.world.hasColumn(Math.floor(ox / 16), Math.floor(oz / 16))) continue; // 同上
        let groundY = null;
        for (let y = 90; y > -32; y--) {
          if (g.world.getBlockId(ox, y, oz) !== 0) { groundY = y; break; }
        }
        if (groundY === null || !g.world.isSolid(ox, groundY, oz)) continue;
        const clear = [];
        for (let dx = -2; dx <= 2; dx++) {
          for (let dz = -2; dz <= 2; dz++) {
            for (let dy = 1; dy <= 5; dy++) {
              clear.push({ x: ox + dx, y: groundY + dy, z: oz + dz, id: 0 });
            }
          }
        }
        g.editor.setBlocks(clear);
        if (probe(ox, oz)) return { origin: [ox, groundY, oz], cleared: true };
      }
    }
    return null;
  });
}

test('三种破坏来源同义：徒手 / 武器 / TNT 批量均使 controller 与锚点注销', async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto('/?vd=2');
  await waitWorldSettled(page);

  for (const source of ['bare-hand', 'weapon', 'tnt-batch']) {
    // 每轮换一个 origin：上一轮的结构方块仍在世界里（destroy 只删锚点），同 origin 会 occupied
    const legal = await findLegalOrigin(page);
    expect(legal).not.toBe(null);
    const placed = await page.evaluate((origin) => {
      const g = window.__MC_GAME__;
      const r = g.nests.place({ origin, playerAabb: null });
      if (!r.ok) return { failed: r.reason };
      return { id: r.id, anchor: r.anchor, controllers: g.nests.controllers().size };
    }, legal.origin);
    expect(placed.failed).toBe(undefined);
    expect(placed.controllers).toBe(1);

    const broken = await page.evaluate(async ({ source, anchor }) => {
      const g = window.__MC_GAME__;
      const state = g.world.getBlockEntity(anchor[0], anchor[1], anchor[2]);
      const c = state.critical;
      if (source === 'bare-hand') {
        // 徒手等价：单块 setBlock(id:0)
        g.editor.setBlock({ x: c.x, y: c.y, z: c.z, id: 0 });
      } else if (source === 'weapon') {
        // 武器：选 pistol + 开启方块破坏 + 瞄准 critical（走真实 M4 controller 路径，
        // 不是直接调 editor —— 那条路径已被徒手等价覆盖，此处要验的是武器路径同义）
        await g.selectWeapon('pistol');
        g.setGunBlockDamage(true);
        g.player.target = { hit: true, blockPos: [c.x, c.y, c.z], dist: 2 };
        g.fireWeaponOnce();
      } else {
        // TNT 等价：一次批量变更（未来 TNT/爆炸只能走这个入口，M7 规格 §2）
        g.editor.setBlocks([{ x: c.x, y: c.y, z: c.z, id: 0 }]);
      }
      return {
        controllers: g.nests.controllers().size,
        anchor: g.world.getBlockEntity(c.x, c.y, c.z),
        blockId: g.world.getBlockId(c.x, c.y, c.z),
        count: g.nests.count(),
      };
    }, { source, anchor: placed.anchor });

    // 三种来源必须同义：controller 注销 + 锚点删除 + 索引移除（不只检查 scene）
    expect(broken.blockId).toBe(0); // 关键方块确实被破坏（武器路径若没命中则仍是 gold）
    expect(broken.anchor).toBe(null);
    expect(broken.controllers).toBe(0);
    expect(broken.count).toBe(0);
  }
});

/**
 * 找一个**不与已有锚点冲突**的巢穴 origin（放多个巢穴时用）。
 *
 * ⚠️ 不能复用 `findLegalOrigin` 的兜底清理分支：它会清掉 5×5×5（dy 1..5）占地，而巢穴结构
 * 正好落在 dy 1..5 —— 放第二个巢穴时兜底会把第一个巢穴的结构方块连关键方块一起清掉，
 * 第一个巢穴当场失效（实测：8 巢穴 fixture 只剩最后放置的那个）。
 * 故本 helper **只走天然全空分支**，并排除已有锚点 ±6 格内的位置（结构占地 5×5 再加余量）。
 *
 * @param {Array<[number, number, number]>} takenOrigins 已放置巢穴的 origin
 * @returns {Promise<{origin: number[]}|null>}
 */
async function findOriginAwayFrom(page, takenOrigins) {
  return page.evaluate((taken) => {
    const g = window.__MC_GAME__;
    const px = Math.floor(g.player.physics.pos.x);
    const pz = Math.floor(g.player.physics.pos.z);
    const tooClose = (ox, oz) => taken.some(([tx, , tz]) => Math.abs(ox - tx) < 7 && Math.abs(oz - tz) < 7);
    for (let ox = px - 40; ox <= px + 40; ox++) {
      for (let oz = pz - 40; oz <= pz + 40; oz++) {
        if (tooClose(ox, oz)) continue;
        if (!g.world.hasColumn(Math.floor(ox / 16), Math.floor(oz / 16))) continue;
        let groundY = null;
        for (let y = 90; y > -32; y--) {
          if (g.world.getBlockId(ox, y, oz) !== 0) { groundY = y; break; }
        }
        if (groundY === null || !g.world.isSolid(ox, groundY, oz)) continue;
        let clear = true;
        for (let dx = -2; dx <= 2 && clear; dx++) {
          for (let dz = -2; dz <= 2 && clear; dz++) {
            for (let dy = 1; dy <= 5; dy++) {
              if (g.world.getBlockId(ox + dx, groundY + dy, oz + dz) !== 0) { clear = false; break; }
            }
          }
        }
        if (clear) return { origin: [ox, groundY, oz] };
      }
    }
    return null;
  }, takenOrigins);
}

/** 等待 vd=8 世界完全收敛（M4/M6 同一口径 + 289 columns + 5s settle）。 */
async function waitFullWorldVD8(page) {
  await page.goto('/?vd=8');
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 90_000 });
  await page.waitForFunction(() => window.__MC_GAME__.world.columns.size >= 289, null, { timeout: 90_000 });
  await page.waitForFunction(() => {
    const s = window.__MC_GAME__.scheduler.stats();
    return s.genInflight === 0 && s.meshInflight === 0 && s.meshQueued === 0 &&
      s.pendingMesh === 0 && s.lightInflight === 0 && s.lightQueued === 0 && s.uploadQueue === 0;
  }, null, { timeout: 90_000 });
  await page.waitForTimeout(5_000);
}

test('reload 后每个锚点只恢复一个 controller（重复 reload 不重复增长）', async ({ page }) => {
  test.setTimeout(300_000);
  await page.goto('/?vd=2');
  await waitWorldSettled(page);

  const legal = await findLegalOrigin(page);
  expect(legal).not.toBe(null);
  const placed = await page.evaluate((origin) => {
    const g = window.__MC_GAME__;
    const r = g.nests.place({ origin, playerAabb: null });
    if (!r.ok) return { failed: r.reason };
    return { id: r.id, anchor: r.anchor, controllers: g.nests.controllers().size };
  }, legal.origin);
  expect(placed.failed).toBe(undefined);

  // 普通编辑 + flush 落盘（验证 reload 后旧 edits 与 anchor 一起恢复）
  await page.evaluate((anchor) => {
    const g = window.__MC_GAME__;
    g.editor.setBlock({ x: anchor[0] + 3, y: anchor[1] + 1, z: anchor[2], id: g.registry.idOf('dirt') });
    return g.persistence.flushNow(g.world);
  }, placed.anchor);

  // 第一次 reload
  await page.reload();
  await waitWorldSettled(page);
  await page.waitForFunction(
    ([x, z]) => window.__MC_GAME__.world.hasColumn(Math.floor(x / 16), Math.floor(z / 16)),
    [placed.anchor[0], placed.anchor[2]], { timeout: 60_000 },
  );
  const first = await page.evaluate((anchor) => {
    const g = window.__MC_GAME__;
    const entity = g.world.getBlockEntity(anchor[0], anchor[1], anchor[2]);
    return {
      controllers: g.nests.controllers().size,
      count: g.nests.count(),
      anchorKind: entity?.kind ?? null,
      anchorId: entity?.id ?? null,
      dirtId: g.world.getBlockId(anchor[0] + 3, anchor[1] + 1, anchor[2]),
      expectedDirt: g.registry.idOf('dirt'),
      sceneChildren: g.scene.children.length,
      entityCount: g.entities.count(),
    };
  }, placed.anchor);
  // 规格 §3：每个锚点只恢复一个 controller（不是「有 controller」而是「恰好一个」）
  expect(first.controllers).toBe(1);
  expect(first.count).toBe(1);
  expect(first.anchorKind).toBe('zombie-nest');
  expect(first.anchorId).toBe(placed.id);
  expect(first.dirtId).toBe(first.expectedDirt); // 普通 edit 也恢复（restoreEdits 不只救 anchor）

  // 第二次 reload：controller 数仍为 1（不重复增长）
  await page.reload();
  await waitWorldSettled(page);
  await page.waitForFunction(
    ([x, z]) => window.__MC_GAME__.world.hasColumn(Math.floor(x / 16), Math.floor(z / 16)),
    [placed.anchor[0], placed.anchor[2]], { timeout: 60_000 },
  );
  const second = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    return {
      controllers: g.nests.controllers().size,
      count: g.nests.count(),
      sceneChildren: g.scene.children.length,
      entityCount: g.entities.count(),
    };
  });
  expect(second.controllers).toBe(1); // 重复 reload 不产生第二个 controller
  expect(second.count).toBe(1);
  // scene / entity count 不重复增长（规格 §3 的明确口径）
  expect(second.sceneChildren).toBe(first.sceneChildren);
  expect(second.entityCount).toBe(first.entityCount);
});

test('同一 column 重复 ready 不替换已有 controller（去重防对象泄漏）', async ({ page }) => {
  // ⚠️ 这条测的是 `controllers().size` **测不到**的东西 —— 实测踩坑：`_controllers` 是按 id
  // 为键的 Map，重复创建会**覆盖写**，故 size 恒为 1（注入「不去重」后 size 断言仍全绿，
  // 是无效盲区）。去重的真实价值是：不去重时每次 column ready 都新建一个 controller 对象并
  // 覆盖旧的，而**旧对象没有被 dispose** → world/zombies/editor 引用泄漏。
  // 故必须比较**对象引用**：第二次创建若生效，引用会变。
  test.setTimeout(180_000);
  await page.goto('/?vd=2');
  await waitWorldSettled(page);

  const legal = await findLegalOrigin(page);
  expect(legal).not.toBe(null);
  const result = await page.evaluate((origin) => {
    const g = window.__MC_GAME__;
    const r = g.nests.place({ origin, playerAabb: null });
    if (!r.ok) return { failed: r.reason };
    const first = g.nests.controllers().get(r.id);
    // 模拟同一 column 重复 ready（重入竞态 / 卸载后重载）：再走一次创建路径
    g._createNestController(r.id);
    g._createNestController(r.id);
    const second = g.nests.controllers().get(r.id);
    return {
      id: r.id,
      controllersSize: g.nests.controllers().size,
      sameRef: first === second, // 去重生效 → 引用不变
      disposedFlag: first._invalidated, // 若旧对象被替换且 dispose，这里会是 true
    };
  }, legal.origin);
  expect(result.failed).toBe(undefined);
  expect(result.controllersSize).toBe(1);
  expect(result.sameRef).toBe(true); // 重复 ready 没有替换 controller（引用相同）
  expect(result.disposedFlag).toBe(false); // 原 controller 没被 dispose（仍在工作）
});

test('8 巢穴 / 30 丧尸中档压力 fixture：队列与 slot 收敛、失效与重载不增长', async ({ page }) => {
  // ⚠️ **30 丧尸是中档压力 fixture，不是默认配置**（默认上限 20）。
  // 规格 §3 / 计划 Task 4 Step 1：报告与测试名都必须写明这点。
  test.setTimeout(420_000);
  await waitFullWorldVD8(page);

  // ① 放置 8 个巢穴（全局上限正好 8 → 第 9 个必须被拒）。
  // 逐个在 Node 侧搜索不冲突的 origin（helper 是 Node 侧函数，不能塞进 page.evaluate）。
  const placedOrigins = [];
  const placedIds = [];
  for (let i = 0; i < 8; i++) {
    const legal = await findOriginAwayFrom(page, placedOrigins);
    expect(legal).not.toBe(null);
    const r = await page.evaluate((origin) => {
      const g = window.__MC_GAME__;
      const res = g.nests.place({ origin, playerAabb: null });
      return res.ok ? { ok: true, id: res.id } : { ok: false, reason: res.reason };
    }, legal.origin);
    expect(r.ok).toBe(true);
    placedOrigins.push(legal.origin);
    placedIds.push(r.id);
  }
  // 第 9 个必须被拒（上限 8）。
  // ⚠️ 必须用**真实合法**的落点：预检顺序是 bounds → occupied → player-overlap → limit，
  // 位置非法（column 未加载 / 越界）时会先报 bounds，测不到 limit（实测踩坑：远处坐标
  // 返回 'bounds'）。故仍走 findOriginAwayFrom 找一个与前八个不冲突的合法落点。
  const ninthOrigin = await findOriginAwayFrom(page, placedOrigins);
  expect(ninthOrigin).not.toBe(null);
  const ninth = await page.evaluate((origin) => {
    const res = window.__MC_GAME__.nests.place({ origin, playerAabb: null });
    return res.ok ? 'ok' : res.reason;
  }, ninthOrigin.origin);
  expect(ninth).toBe('limit');

  // ② 换成 30 容量 service + renderer（**中档 fixture，非默认 20**），再显式填满 30 只
  const stress = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    const { ZombieService } = await import('/src/entities/zombies/zombie-system.js');
    const { ZombieRenderer } = await import('/src/render/zombie-renderer.js');
    // 释放旧的 20 容量 renderer/service，换 30 容量（先 renderer 后 service，与 game.js 装配同序）
    g.zombies.dispose();
    g.zombieRenderer.dispose();
    g.zombieRenderer = new ZombieRenderer({ scene: g.scene, maxActive: 30, skinTexture: null });
    g.zombies = new ZombieService({
      entities: g.entities, world: g.world, maxActive: 30,
      onSpawn: (id, slot) => g.zombieRenderer.acquireSlot(id, slot),
      onDespawn: (id) => g.zombieRenderer.releaseSlot(id),
    });
    // 显式构造 30 只（计划 Task 4 Step 1：「显式构造 8 个 anchors 与 ZombieService({maxActive:30})」）。
    // 不靠等 8 秒×N 轮自然刷怪 —— 8 巢穴要凑满 30 只须等约 4 分钟，且落点随机不可复现。
    const spawned = [];
    let guard = 0;
    while (spawned.length < 30 && guard < 400) {
      guard++;
      const angle = (guard * 137.5 * Math.PI) / 180; // 黄金角散列，确定性铺点
      const dist = 4 + (guard % 12);
      const x = Math.floor(g.player.physics.pos.x + Math.cos(angle) * dist);
      const z = Math.floor(g.player.physics.pos.z + Math.sin(angle) * dist);
      if (!g.world.hasColumn(Math.floor(x / 16), Math.floor(z / 16))) continue;
      for (let y = Math.floor(g.player.physics.pos.y); y >= Math.floor(g.player.physics.pos.y) - 48; y--) {
        if (g.world.getBlockId(x, y, z) === 0 && g.world.getBlockId(x, y + 1, z) === 0
          && g.world.isSolid(x, y - 1, z)) {
          const id = g.zombies.spawn([x + 0.5, y, z + 0.5], { source: 'm7-stress' });
          if (id) spawned.push(id);
          break;
        }
      }
    }
    g.zombieRenderer.sync(g.zombies, performance.now());
    return {
      spawned: spawned.length,
      zombieCount: g.zombies.count(),
      activeSlots: g.zombieRenderer.activeCount(),
      meshCapacity: g.zombieRenderer.meshes.head.count, // 六部件容量须扩到 30
      nestControllers: g.nests.controllers().size,
      nestCount: g.nests.count(),
    };
  });
  expect(stress.spawned).toBe(30); // 30 容量下 30 只全部成功
  expect(stress.zombieCount).toBe(30);
  expect(stress.activeSlots).toBe(30);
  expect(stress.meshCapacity).toBe(30); // 容量随 maxActive 扩，不是默认 20
  expect(stress.nestCount).toBe(8);

  // ③ 失效一半巢穴 + 反复 hydrate（模拟重启路径），断言索引/controller 不重复增长、slot 不泄漏
  const afterChurn = await page.evaluate(async (ids) => {
    const g = window.__MC_GAME__;
    const beforeSlots = g.zombieRenderer.activeCount();
    const beforeCount = g.nests.count();
    const beforeScene = g.scene.children.length;
    const beforeControllers = g.nests.controllers().size;
    // 失效前 4 个巢穴（走真实批量破坏路径 = TNT 等价入口）
    for (const id of ids) {
      const anchor = g.nests.anchorOf(id);
      g.editor.setBlocks([{ x: anchor[0], y: anchor[1], z: anchor[2], id: 0 }]);
    }
    // **必须先 flush 再 hydrate**：真实重启路径是 flush → reload → preloadEdits → hydrate。
    // hydrate 走 `listBlockEntities` 扫 IndexedDB，若不先落盘，库里没有这些锚点 →
    // hydrate 的 clear()+重建会把索引清成 0（实测踩坑：nestCount 收到 0 而非 4）。
    await g.persistence.flushNow(g.world);
    // 反复 hydrate：不得让索引或 controller 重复增长（M7 规格 §3「每个锚点只恢复一个」）
    await g.nests.hydrate(g.persistence);
    await g.nests.hydrate(g.persistence);
    g.zombieRenderer.sync(g.zombies, performance.now());
    return {
      beforeSlots, beforeCount, beforeScene, beforeControllers,
      afterSlots: g.zombieRenderer.activeCount(),
      zombieCount: g.zombies.count(),
      nestControllers: g.nests.controllers().size,
      nestCount: g.nests.count(),
      sceneChildren: g.scene.children.length,
    };
  }, placedIds.slice(0, 4));
  expect(afterChurn.beforeCount).toBe(8); // 失效前八个全在索引里
  expect(afterChurn.nestCount).toBe(4); // 8 个失效 4 个 → 索引剩 4（hydrate 从库重建后仍是 4）
  expect(afterChurn.nestControllers).toBe(4); // controller 同步减 4，且不重复增长
  expect(afterChurn.afterSlots).toBe(afterChurn.beforeSlots); // 巢穴失效不动丧尸 slot（不泄漏）
  expect(afterChurn.zombieCount).toBe(30);
  expect(afterChurn.sceneChildren).toBe(afterChurn.beforeScene); // scene 不重复增长

  // ④ 等待收敛后对七项队列**逐项**断言为 0（计划 Task 4 Step 1 的明确口径）
  await page.waitForFunction(() => {
    const s = window.__MC_GAME__.scheduler.stats();
    return s.genInflight === 0 && s.meshInflight === 0 && s.meshQueued === 0 &&
      s.pendingMesh === 0 && s.lightInflight === 0 && s.lightQueued === 0 && s.uploadQueue === 0;
  }, null, { timeout: 90_000 });
  const queues = await page.evaluate(() => {
    const s = window.__MC_GAME__.scheduler.stats();
    return {
      genInflight: s.genInflight, meshInflight: s.meshInflight, meshQueued: s.meshQueued,
      pendingMesh: s.pendingMesh, lightInflight: s.lightInflight, lightQueued: s.lightQueued,
      uploadQueue: s.uploadQueue, draw: window.__MC_GAME__.renderStats().drawCalls,
      fps: window.__MC_GAME__.perfSnapshot().fps,
    };
  });
  // 逐项零值断言（不是「队列总和为 0」——逐项才能定位是哪一段积压）
  expect(queues.genInflight).toBe(0);
  expect(queues.meshInflight).toBe(0);
  expect(queues.meshQueued).toBe(0);
  expect(queues.pendingMesh).toBe(0);
  expect(queues.lightInflight).toBe(0);
  expect(queues.lightQueued).toBe(0);
  expect(queues.uploadQueue).toBe(0);
  // 30 丧尸 + 8 巢穴下仍须保持帧率（中档 fixture 的验收口径；低于默认场景不阻断，只记录）
  expect(queues.fps).toBeGreaterThan(0);
});

test('hydrate：八个已存档锚点（全未加载）使第九次放置返回 limit', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/?vd=2');
  await waitWorldSettled(page);

  // 直接往**未加载** column 写八个锚点行（模拟远处巢穴只存在于存档），再 hydrate。
  // 上限判定必须来自 edits store 而非已加载 controller —— 否则玩家走远再回来能无限放。
  // 注意：origin 须在 hydrate **之前**就选好（findLegalOrigin 的兜底分支会清理占地、写世界），
  // 但八个远端锚点在 cx 60+，与玩家附近的落点无关，顺序不影响上限判定。
  const legal = await findLegalOrigin(page);
  expect(legal).not.toBe(null);
  const result = await page.evaluate(async ({ legalOrigin }) => {
    const g = window.__MC_GAME__;
    const goldId = g.registry.idOf('gold_block');
    // index 用真实 blockIndex 算，不手算公式（手算漂移会让断言恒真，testing-policy §2.7）
    const { blockIndex } = await import('/src/voxel/constants.js');
    for (let i = 0; i < 8; i++) {
      const x = (i + 60) * 16 + 1;
      const criticalY = -32 + 5;
      await g.persistence.saveColumnEdits(`${i + 60},0`, [{
        index: blockIndex(1, criticalY, 1), id: goldId, meta: 0,
        blockEntity: {
          kind: 'zombie-nest', id: `nest-far-${i}`, origin: [x, -32, 1],
          critical: { x, y: criticalY, z: 1, id: goldId }, lastSpawnAt: 0,
        },
      }]);
    }
    await g.nests.hydrate(g.persistence);
    const ninth = g.nests.place({ origin: legalOrigin, playerAabb: null });
    return { count: g.nests.count(), controllers: g.nests.controllers().size, ninthReason: ninth.reason };
  }, { legalOrigin: legal.origin });
  expect(result.count).toBe(8); // 八个锚点全部计入索引
  expect(result.controllers).toBe(0); // 但它们一个都没有已加载 controller
  expect(result.ninthReason).toBe('limit'); // 第九次仍拒绝 → 上限跨卸载有效
});
