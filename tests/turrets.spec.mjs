// tests/turrets.spec.mjs — M8 炮塔装置层验收（规格 §3）
//
// Tier 1 断言落点说明：本 spec 的关键回归是「**接线时序**」与「**背包分流**」—— 两者在
// 纯逻辑单测里都能全绿却仍可能失效：
// ① 炮塔装配晚于 `_waitForColumn` → reload 后 anchor 与索引都恢复了，但 controller 恒为 0
//    （炮塔方块全写对、锚点也在，肉眼看不出差别）；
// ② `CREATIVE_SPECIALS` 漏了 turret_alias_block → 背包右键只放出一个贴图案的正方体。
// 故断言必须落在**真游戏页**（M7 实测教训，验收报告 §3.7）。
import { test, expect } from 'playwright/test';

/**
 * 等世界真正稳定。⚠️ **没有共享 helper 模块** —— 整段照
 * `tests/zombie-nests.spec.mjs` 复制（含其判据与 90s timeout）。
 * 判据 = sections 连续两次采样不变（跨帧比较）+ 队列归零；**不能只判队列归零**
 * （那是瞬时状态，高负载下队列可能短暂归零而 column 还在加载）。
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
 * 本 spec 起手式（⚠️ **没有 `startGame(page)` 这个 helper** —— 全仓 tests/ 零命中）。
 *
 * ⚠️ **必须钉 seed**：地形随 seed 变化，而「炮塔落在哪个 column」直接决定接线时序缺陷
 * 能否被抓到（见 `findOriginInSpawnColumn` 的注释）。不钉 seed 会让「装配挪到
 * `_waitForColumn` 之后」的注入**时抓到时抓不到** —— 实测踩过：同一注入第一次全绿、
 * 第二次真 FAIL，唯一变量就是落点落在出生点 column 内还是外。
 */
const URL = '/?vd=2&seed=12345';

async function boot(page) {
  await page.goto(URL);
  await waitWorldSettled(page);
}

/**
 * 找一个合法 origin（照 `zombie-nests.spec.mjs` 的 `findLegalOrigin` 同手法）。
 * ⚠️ **必须先确认 column 已加载**：未加载位置的 `getBlockId` 恒为 0（air），会让「全空」
 * 判定误判为合法落点 → place() 随后以 'bounds' 拒绝。
 * 结构占地 3×3（dx/dz ∈ [-1,1]）+ 上方 2 格，故探测范围比巢穴的 5×5 小。
 */
async function findLegalOrigin(page, notAt = null) {
  return page.evaluate((skip) => {
    const g = window.__MC_GAME__;
    const px = Math.floor(g.player.physics.pos.x);
    const pz = Math.floor(g.player.physics.pos.z);
    const probe = (ox, oz) => {
      if (!g.world.hasColumn(Math.floor(ox / 16), Math.floor(oz / 16))) return null;
      let groundY = null;
      for (let y = 90; y > -32; y--) {
        if (g.world.getBlockId(ox, y, oz) !== 0) { groundY = y; break; }
      }
      if (groundY === null || !g.world.isSolid(ox, groundY, oz)) return null;
      // 底座在 origin.y+1、柱在 +2/+3 → 探测 dy 1..3 必须全空
      for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
          for (let dy = 1; dy <= 3; dy++) {
            if (g.world.getBlockId(ox + dx, groundY + dy, oz + dz) !== 0) return null;
          }
        }
      }
      return [ox, groundY, oz];
    };
    for (let ox = px + 4; ox <= px + 30; ox++) {
      for (let oz = pz - 30; oz <= pz + 30; oz++) {
        // 跳过指定落点（destroy 只删锚点、结构方块保留 → 同 origin 会判 occupied）
        if (skip && ox === skip[0] && oz === skip[2]) continue;
        const hit = probe(ox, oz);
        if (hit) return { origin: hit };
      }
    }
    return null;
  }, notAt);
}

/**
 * 在**出生点所在 column** 内找合法 origin。
 *
 * ⚠️ 这是接线时序断言的必要前提（实测踩坑）：`_waitForColumn` 只等**出生点 column**，
 * 它的 `onColumnReady` 在装配段之前就已触发。故只有落在**该 column** 内的炮塔锚点，
 * 才能暴露「炮塔装配晚于 `_waitForColumn` → 回调跑时 `this.turrets` 还是 null →
 * 第一行直接 return → controller 恒为 0」这个缺陷。落在其它 column 的炮塔，其
 * `onColumnReady` 发生在装配**之后**，注入照样全绿（无效盲区）。
 */
async function findOriginInSpawnColumn(page) {
  return page.evaluate(() => {
    const g = window.__MC_GAME__;
    const px = Math.floor(g.player.physics.pos.x);
    const pz = Math.floor(g.player.physics.pos.z);
    const cx = Math.floor(px / 16), cz = Math.floor(pz / 16);
    for (let ox = cx * 16 + 1; ox <= cx * 16 + 14; ox++) {
      for (let oz = cz * 16 + 1; oz <= cz * 16 + 14; oz++) {
        let groundY = null;
        for (let y = 90; y > -32; y--) {
          if (g.world.getBlockId(ox, y, oz) !== 0) { groundY = y; break; }
        }
        if (groundY === null || !g.world.isSolid(ox, groundY, oz)) continue;
        let clear = true;
        for (let dx = -1; dx <= 1 && clear; dx++) {
          for (let dz = -1; dz <= 1 && clear; dz++) {
            for (let dy = 1; dy <= 3; dy++) {
              if (g.world.getBlockId(ox + dx, groundY + dy, oz + dz) !== 0) clear = false;
            }
          }
        }
        if (clear) return { origin: [ox, groundY, oz], column: `${cx},${cz}` };
      }
    }
    return null;
  });
}

/** 统计 origin 周围的结构方块（断言「不是一个贴图案的正方体」）。 */
async function countStructure(page, anchor) {
  return page.evaluate((a) => {
    const g = window.__MC_GAME__;
    const ironId = g.registry.idOf('iron_ore');
    const obsId = g.registry.idOf('obsidian');
    const aliasId = g.registry.idOf('turret_alias_block');
    let iron = 0, obs = 0, alias = 0;
    // 底座 = anchor.y − 2（anchor 在 origin.y+3，底座在 origin.y+1）
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        if (g.world.getBlockId(a[0] + dx, a[1] - 2, a[2] + dz) === ironId) iron++;
      }
    }
    if (g.world.getBlockId(a[0], a[1] - 1, a[2]) === obsId) obs++;
    if (g.world.getBlockId(a[0], a[1], a[2]) === obsId) obs++;
    // 单格 alias 方块 = 缺陷判据（背包分流缺失时会出现）
    if (g.world.getBlockId(a[0], a[1] - 2, a[2]) === aliasId) alias++;
    return { iron, obs, alias };
  }, anchor);
}

test('背包选中路径：选中 turret_alias_block 右键 → 放置完整 11 格结构 + 立刻有 controller', async ({ page }) => {
  test.setTimeout(180_000);
  await boot(page);
  const legal = await findLegalOrigin(page);
  expect(legal).not.toBe(null);

  // ⚠️ **走背包面板的真实点击路径**（M7 教训：只走测试 API 的 E2E 曾全绿却漏了
  // 「背包放置只放一格」缺陷）。背包槽是 `.mc-slot` + `dataset.index`（**不是**计划里写的
  // `[data-item=...]` —— 该选择器在本仓不存在）。
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyZ' })));
  await page.waitForFunction(() =>
    document.getElementById('inventory-modal').style.display === 'flex', null, { timeout: 5_000 });
  const picked = await page.evaluate(() => {
    const slots = [...document.querySelectorAll('#inventory-grid .mc-slot')];
    const slot = slots.find((s) => s.querySelector('.mc-item-name')?.textContent === 'turret_alias_block');
    if (!slot) return null;
    const idx = Number(slot.dataset.index);
    slot.click();
    return { idx, selected: window.__MC_GAME__.player.inventory.selectedSlot };
  });
  expect(picked).not.toBe(null);
  expect(picked.selected).toBe(picked.idx);
  expect(picked.idx).toBeGreaterThan(4);   // turret_alias_block 不在快捷栏前 5 格
  // 关闭背包（放块要走真实交互路径，需解除模态）
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape' })));
  await page.waitForFunction(() => window.__MC_GAME__.uiModal === false, null, { timeout: 5_000 });

  const placed = await page.evaluate((origin) => {
    const g = window.__MC_GAME__;
    // 真实 DDA target 形状：`blockPos` = 命中的地面格（炮塔 origin），`prevPos` = 前一格空气
    g.player.target = {
      hit: true, blockPos: [origin[0], origin[1], origin[2]],
      prevPos: [origin[0], origin[1] + 1, origin[2]], dist: 2, normal: [0, 1, 0],
    };
    g.player.placeBlock();
    return {
      count: g.turrets.count(),
      controllers: g.turrets.controllers().size,
      anchor: g.turrets.anchorOf('turret-1'),
      putPlays: g.audioDebugState().playRequests.put ?? 0,
    };
  }, legal.origin);
  expect(placed.count).toBe(1);
  // ⚠️ onPlaced 接线生效（否则恒 0 —— M7 实测坑）
  expect(placed.controllers).toBe(1);
  expect(placed.putPlays).toBeGreaterThanOrEqual(1);

  // 断言**不是**一个贴图案的正方体：9 格 iron_ore + 2 格 obsidian、0 格 alias
  const structure = await countStructure(page, placed.anchor);
  expect(structure.iron).toBe(9);
  expect(structure.obs).toBe(2);
  expect(structure.alias).toBe(0);      // 单格 alias 方块是缺陷判据

  // ⚠️ **必须钉住 origin → 锚点的绝对高度关系**（实测补的断言）：`countStructure` 的位置是从
  // **返回的锚点**反推的，故「整个结构上移一格」在它眼里内部一致、断言全绿 —— 注入
  // 「origin 改用 prevPos」实测第一次就是全绿。真正的判据是这两条绝对关系：
  // ① 锚点 y === origin.y + 3（底座 origin.y+1、柱 +2/+3）；
  // ② **origin 格本身仍是原地面方块**（炮塔坐在地面之上，从不替换地形 —— mc-lite 同口径）。
  const heights = await page.evaluate(({ origin, anchor }) => {
    const g = window.__MC_GAME__;
    return {
      anchorY: anchor[1],
      originY: origin[1],
      originBlock: g.world.getBlockId(origin[0], origin[1], origin[2]),
      baseY: anchor[1] - 2,
      baseBlock: g.world.getBlockId(origin[0], anchor[1] - 2, origin[2]),
    };
  }, { origin: legal.origin, anchor: placed.anchor });
  expect(heights.anchorY).toBe(legal.origin[1] + 3);
  expect(heights.baseY).toBe(legal.origin[1] + 1);
  expect(heights.originBlock).not.toBe(0);                    // 地面格未被替换
  expect(heights.originBlock).not.toBe(
    await page.evaluate(() => window.__MC_GAME__.registry.idOf('iron_ore')));
});

test('reload 后每个锚点只恢复一个 controller（对象引用相等，不是 size 断言）', async ({ page }) => {
  test.setTimeout(180_000);
  await boot(page);
  // ⚠️ 必须落在**出生点 column** 内（见 findOriginInSpawnColumn 的注释）——
  // 落在其它 column 会让「装配晚于 _waitForColumn」的注入全绿，断言失去意义。
  const legal = await findOriginInSpawnColumn(page);
  expect(legal).not.toBe(null);
  await page.evaluate((origin) => {
    const g = window.__MC_GAME__;
    g.placeTurret(origin);
    return g.persistence.flushNow(g.world);
  }, legal.origin);
  await page.waitForTimeout(500);

  await page.reload();
  await waitWorldSettled(page);
  await page.waitForFunction(
    ([x, z]) => window.__MC_GAME__.world.hasColumn(Math.floor(x / 16), Math.floor(z / 16)),
    [legal.origin[0], legal.origin[2]], { timeout: 60_000 },
  );
  const after = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    // ⚠️ **去重断言须比较对象引用**（`first === second`），不能用 `controllers().size`：
    // `_controllers` 按 id 为键 → 重复创建是覆盖写，size 恒为 1（M7 实测无效盲区）。
    const first = g.turrets.controllers().get('turret-1');
    g._createTurretController('turret-1');   // 再建一次 → 必须复用同一个对象
    const second = g.turrets.controllers().get('turret-1');
    return {
      count: g.turrets.count(),
      size: g.turrets.controllers().size,
      sameRef: first === second && first !== null,
      notDisposed: first ? !first.isInvalidated() : false,
    };
  });
  expect(after.count).toBe(1);           // 索引恢复
  expect(after.size).toBe(1);            // controller 恢复（装配时序正确）
  expect(after.sameRef).toBe(true);      // 重复创建复用同一对象
  expect(after.notDisposed).toBe(true);  // 原对象未被 dispose
});

test('关键 obsidian 被破坏 → controller 注销、锚点与索引删除', async ({ page }) => {
  test.setTimeout(180_000);
  await boot(page);
  const legal = await findLegalOrigin(page);
  expect(legal).not.toBe(null);
  const placed = await page.evaluate((origin) => {
    const g = window.__MC_GAME__;
    const r = g.placeTurret(origin);
    return { anchor: r.anchor, id: r.id };
  }, legal.origin);
  expect(placed.anchor).not.toBe(null);

  // 徒手挖掉关键格（走 editor.setBlock → block-changed 增量事件，与武器/TNT 同一语义）
  const after = await page.evaluate((a) => {
    const g = window.__MC_GAME__;
    g.editor.setBlock({ x: a.anchor[0], y: a.anchor[1], z: a.anchor[2], id: 0 });
    return {
      count: g.turrets.count(),
      controllers: g.turrets.controllers().size,
      anchorEntity: g.world.getBlockEntity(a.anchor[0], a.anchor[1], a.anchor[2]),
    };
  }, placed);
  expect(after.count).toBe(0);                       // 索引删除
  expect(after.controllers).toBe(0);                 // controller 注销
  expect(after.anchorEntity).toBe(null);             // 锚点删除

  // 炮塔自己的时钟写回**不**触发失效（同格同 id）—— 另放一个炮塔验证
  // ⚠️ 落点须重新探测：destroy 只删锚点、结构方块保留，故第一个 origin 仍 occupied；
  // 且 `[origin+8]` 这种硬偏移在真实地形上未必合法（会返回 occupied → 断言假失败）。
  const second = await findLegalOrigin(page, legal.origin);
  expect(second).not.toBe(null);
  const clock = await page.evaluate((origin) => {
    const g = window.__MC_GAME__;
    const r = g.placeTurret(origin);
    const c = g.turrets.controllers().get(r.id);
    c.writeBackFireClock(performance.now());
    // 同格同 id 写回 → block-changed 事件的 newId === critical.id
    return { ok: r.ok, invalidated: c.isInvalidated(), count: g.turrets.count() };
  }, second.origin);
  expect(clock.ok).toBe(true);
  expect(clock.invalidated).toBe(false);
  expect(clock.count).toBe(1);
});

test('远处炮塔 column 未加载时上限仍生效（走远再回来不能无限放置）', async ({ page }) => {
  test.setTimeout(240_000);
  await boot(page);
  // ⚠️ **不能在真游戏页里平铺放 20 个炮塔**：vd=2 的加载半径只有 4 column（64 格），
  // 而 20 个炮塔相隔 12 格要跨 228 格 → 大部分会以 'bounds'（column 未加载）失败，
  // 断言根本测不到上限语义。故改用 hydrate 路径：把 20 个锚点写进 edits store 的
  // **永不加载**的 column（照 M7 spec 的 `99,99` 手法），再 hydrate 建索引。
  // 这正是规格 §3.2 的真实机制 —— 上限来自 edits store 扫库，不是已加载 controller 数。
  const seeded = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    const obsId = g.registry.idOf('obsidian');
    for (let i = 0; i < 20; i++) {
      const cx = 900 + i;   // 极远 column：玩家永远不会走到 → 永不加载
      await g.persistence.saveColumnEdits(`${cx},0`, [{
        // ⚠️ blockIndex(lx,y,lz) = lx + lz*16 + (y − WORLD_MIN_Y)*256（`constants.js:15`）。
        // lx=1, lz=1, y=−27 → 1 + 16 + 5*256 = 1297。**不要写成 `1 + 5*256`**（漏了 lz*16）。
        index: 1 + 1 * 16 + 5 * 256, id: obsId, meta: 0,
        blockEntity: {
          kind: 'turret', id: `turret-${i + 1}`, origin: [cx * 16 + 1, -30, 1],
          critical: { x: cx * 16 + 1, y: -27, z: 1, id: obsId },
          rotation: 0, lastFireAt: 0,
        },
      }]);
    }
    await g.turrets.hydrate(g.persistence);
    return {
      count: g.turrets.count(),
      controllers: g.turrets.controllers().size,
      loadedAny: g.turrets.controllers().size > 0,
    };
  });
  // 20 个锚点全部计入上限，但**没有任何 controller**（column 未加载）
  expect(seeded.count).toBe(20);
  expect(seeded.controllers).toBe(0);
  expect(seeded.loadedAny).toBe(false);

  // 新放置必须被 'limit' 拒绝 —— 若上限改用 controller 数，这里会成功（无限放置）
  const legal = await findLegalOrigin(page);
  expect(legal).not.toBe(null);
  const over = await page.evaluate((origin) => {
    const g = window.__MC_GAME__;
    const r = g.placeTurret(origin);
    return { reason: r.reason, ok: r.ok, count: g.turrets.count(), wrote: g.world.getBlockId(origin[0], origin[1] + 1, origin[2]) !== 0 };
  }, legal.origin);
  expect(over.ok).toBe(false);
  expect(over.reason).toBe('limit');
  expect(over.count).toBe(20);
  expect(over.wrote).toBe(false);   // 失败路径零世界写入
  await page.evaluate(() => window.__MC_GAME__.persistence.clearAllEdits());
});

test('丧尸进入检测范围且有 LOS → 炮塔转向它（帧循环 8Hz 索敌生效）', async ({ page }) => {
  test.setTimeout(180_000);
  await boot(page);
  // ⚠️ 落在**出生点 column** 内：炮塔 controller 由 `onColumnReady` / `onPlaced` 创建，
  // 而帧循环的 `_updateTurretControllers` 只推进已存在的 controller。
  const legal = await findOriginInSpawnColumn(page);
  expect(legal).not.toBe(null);
  const setup = await page.evaluate((origin) => {
    const g = window.__MC_GAME__;
    const r = g.placeTurret(origin);
    const controller = g.turrets.controllers().get(r.id);
    const before = controller.currentRotation;
    // 在炮塔 +X 方向放一只丧尸（pivot 下方、水平可见 → yaw 应指向 +X ≈ π/2）
    const pivot = controller.pivot();
    const zx = Math.floor(pivot[0]) + 3, zz = Math.floor(pivot[2]);
    // 丧尸脚格须为空气、脚下须 solid
    g.editor.setBlock({ x: zx, y: Math.floor(pivot[1]) - 4, z: zz, id: g.registry.idOf('stone') });
    g.editor.setBlock({ x: zx, y: Math.floor(pivot[1]) - 3, z: zz, id: 0 });
    g.editor.setBlock({ x: zx, y: Math.floor(pivot[1]) - 2, z: zz, id: 0 });
    const zid = g.zombies.spawn([zx + 0.5, Math.floor(pivot[1]) - 3, zz + 0.5], { source: 'turret-spec' });
    return { id: r.id, before, zid, pivot };
  }, legal.origin);
  expect(setup.zid).not.toBe(null);   // 前置自检：丧尸必须生成成功，否则断言无效

  // 帧循环 8Hz 索敌 → 约 250ms 内 targetRotation 应被写成指向 +X
  await page.waitForFunction((id) => {
    const c = window.__MC_GAME__.turrets.controllers().get(id);
    return c && Math.abs(c.targetRotation - Math.PI / 2) < 0.3;
  }, setup.id, { timeout: 5_000, polling: 100 });

  // 朝向插值真的在累积（限角速度 → 逐帧逼近目标，不是瞬移）
  await page.waitForFunction((id) => {
    const c = window.__MC_GAME__.turrets.controllers().get(id);
    return c && Math.abs(c.currentRotation - Math.PI / 2) < 0.3;
  }, setup.id, { timeout: 10_000, polling: 100 });
  const after = await page.evaluate((id) => {
    const c = window.__MC_GAME__.turrets.controllers().get(id);
    return { currentRotation: c.currentRotation, targetRotation: c.targetRotation,
      currentPitch: c.currentPitch };
  }, setup.id);
  expect(Math.abs(after.currentRotation - Math.PI / 2)).toBeLessThan(0.3);
  // 丧尸在 pivot 下方 → 俯视（pitch < 0）
  expect(after.currentPitch).toBeLessThan(0);
});

test('LOS 被实心不透明方块阻挡时不索敌；透明方块不阻挡', async ({ page }) => {
  test.setTimeout(180_000);
  await boot(page);
  const legal = await findOriginInSpawnColumn(page);
  expect(legal).not.toBe(null);
  const setup = await page.evaluate((origin) => {
    const g = window.__MC_GAME__;
    const r = g.placeTurret(origin);
    const c = g.turrets.controllers().get(r.id);
    const pivot = c.pivot();
    const zx = Math.floor(pivot[0]) + 3, zz = Math.floor(pivot[2]);
    const gy = Math.floor(pivot[1]) - 3;
    g.editor.setBlock({ x: zx, y: gy - 1, z: zz, id: g.registry.idOf('stone') });
    g.editor.setBlock({ x: zx, y: gy, z: zz, id: 0 });
    g.editor.setBlock({ x: zx, y: gy + 1, z: zz, id: 0 });
    const zid = g.zombies.spawn([zx + 0.5, gy, zz + 0.5], { source: 'turret-spec' });
    // 在 pivot 与丧尸之间砌一堵 stone 墙（阻挡 LOS）
    const wallX = Math.floor(pivot[0]) + 1;
    for (let dy = -4; dy <= 2; dy++) {
      g.editor.setBlock({ x: wallX, y: gy + dy, z: zz, id: g.registry.idOf('stone') });
    }
    return { id: r.id, zid, wallX, gy, zz, defaultRotation: c.anchor.rotation };
  }, legal.origin);
  expect(setup.zid).not.toBe(null);

  // 墙挡住 → 炮塔保持默认朝向（targetRotation 回归 placement rotation）
  await page.waitForTimeout(400);
  const blocked = await page.evaluate((s) => {
    const c = window.__MC_GAME__.turrets.controllers().get(s.id);
    return { targetRotation: c.targetRotation, expected: s.defaultRotation };
  }, setup);
  expect(blocked.targetRotation).toBe(blocked.expected);

  // 把墙换成玻璃（实心但透明）→ 不阻挡 → 炮塔索敌成功
  await page.evaluate((s) => {
    const g = window.__MC_GAME__;
    for (let dy = -4; dy <= 2; dy++) {
      g.editor.setBlock({ x: s.wallX, y: s.gy + dy, z: s.zz, id: g.registry.idOf('glass_block') });
    }
  }, setup);
  await page.waitForFunction((id) => {
    const c = window.__MC_GAME__.turrets.controllers().get(id);
    return c && Math.abs(c.targetRotation - Math.PI / 2) < 0.3;
  }, setup.id, { timeout: 5_000, polling: 100 });
});

/**
 * 造一处「3×3 实心地面 + 中心一株草」的场地，并把玩家飞到斜上方（避开 player-overlap）。
 *
 * ⚠️ **地面要自己铺平**：出生点周围是山地/森林，天然地形里找不到「3×3 同高实心 + 上方三格
 * 只有植物」的场地（实测扫 ±24 格零命中）。铺平后**唯一变量就是中心那一格草**，
 * 两侧对照才只差一个变量（AGENTS.md：对照脚本与被测代码只差一个变量）。
 *
 * ⚠️ 玩家用 `physics.flying = true` 悬停：不飞就会掉到地面上，站位随机 → 射线姿态不可控。
 */
async function makeFlatSiteWithPlant(page, plantName) {
  return page.evaluate(async (plant) => {
    const g = window.__MC_GAME__;
    const pl = g.player;
    const R = g.registry;
    const px = Math.floor(pl.physics.pos.x);
    const pz = Math.floor(pl.physics.pos.z);
    const nameAt = (x, y, z) => R.nameOf(g.world.getBlockId(x, y, z)) ?? 'air';
    // 找一处 3×3 已加载、且上方三格没有实心障碍的位置（植物可清）
    let site = null;
    for (let ox = px + 4; ox <= px + 12 && !site; ox++) {
      for (let oz = pz - 12; oz <= pz + 12 && !site; oz++) {
        let ok = true;
        let groundY = null;
        for (let dx = -1; dx <= 1 && ok; dx++) {
          for (let dz = -1; dz <= 1 && ok; dz++) {
            const x = ox + dx, z = oz + dz;
            if (!g.world.hasColumn(Math.floor(x / 16), Math.floor(z / 16))) { ok = false; break; }
            let top = null;
            for (let y = 90; y > -32; y--) if (g.world.getBlockId(x, y, z) !== 0) { top = y; break; }
            if (top === null) { ok = false; break; }
            // 该列的地面 = 最高实心格；它上方只允许空气/植物
            let gy = null;
            for (let y = top; y > top - 6; y--) if (g.world.isSolid(x, y, z)) { gy = y; break; }
            if (gy === null) { ok = false; break; }
            if (groundY === null) groundY = gy;
            if (gy !== groundY) { ok = false; break; }
            for (let y = gy + 1; y <= gy + 3; y++) {
              const n = nameAt(x, y, z);
              if (n !== 'air' && !R.isPlant(R.idOf(n))) { ok = false; break; }
            }
          }
        }
        if (ok && groundY !== null) site = { ox, oz, groundY };
      }
    }
    if (!site) return null;
    // 铺平 3×3 地面 + 清空上方三格，只在中心种一株植物（plant=null 则不种）
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const x = site.ox + dx, z = site.oz + dz;
        g.editor.setBlock({ x, y: site.groundY, z, id: R.idOf('stone') });
        for (let dy = 1; dy <= 3; dy++) g.editor.setBlock({ x, y: site.groundY + dy, z, id: 0 });
      }
    }
    if (plant) {
      g.editor.setBlock({ x: site.ox, y: site.groundY + 1, z: site.oz, id: R.idOf(plant) });
    }
    // 玩家飞到斜上方 3 格（水平离 2.5 格 → 结构 AABB 不相交）
    pl.physics.flying = true;
    pl.physics.pos.x = site.ox - 2.5;
    pl.physics.pos.y = site.groundY + 3;
    pl.physics.pos.z = site.oz + 0.5;
    pl.physics.vel.x = 0; pl.physics.vel.y = 0; pl.physics.vel.z = 0;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return site;
  }, plantName);
}

/**
 * 真实姿态瞄准某格中心 → 等一帧让 update() 重算 target → 真实 placeBlock()。
 * ⚠️ **不手塞 target**：本缺陷的落点正是「真实 DDA 命中草格」，手塞会把它测没。
 */
async function aimAndPlaceTurret(page, site, aimY) {
  return page.evaluate(async ({ site, aimY }) => {
    const g = window.__MC_GAME__;
    const pl = g.player;
    const eye = [pl.physics.pos.x, pl.physics.pos.y + 1.62, pl.physics.pos.z];
    const aim = [site.ox + 0.5, aimY + 0.5, site.oz + 0.5];
    pl.setTestAim([aim[0] - eye[0], aim[1] - eye[1], aim[2] - eye[2]]);
    await new Promise((r) => requestAnimationFrame(r));
    const t = pl.target;
    const target = t ? {
      blockPos: [...t.blockPos],
      name: g.registry.nameOf(g.world.getBlockId(t.blockPos[0], t.blockPos[1], t.blockPos[2])),
    } : null;
    const before = g.turrets.count();
    pl.placeBlock();
    const after = g.turrets.count();
    const anchor = after > before ? g.turrets.anchorOf(`turret-${after}`) : null;
    const baseY = anchor ? anchor[1] - 2 : null;
    return {
      target, before, after, anchor, baseY,
      baseName: anchor
        ? g.registry.nameOf(g.world.getBlockId(anchor[0], baseY, anchor[2])) : null,
      plantCellName: g.registry.nameOf(g.world.getBlockId(site.ox, site.groundY + 1, site.oz)),
      groundName: g.registry.nameOf(g.world.getBlockId(site.ox, site.groundY, site.oz)),
      pivotY: anchor ? g.turrets.controllers().get(`turret-${after}`)?.pivot()[1] ?? null : null,
    };
  }, { site, aimY });
}

test('地面长草时放炮塔：底座贴地、草被覆盖（与无草对照逐位同高）', async ({ page }) => {
  test.setTimeout(240_000);
  await boot(page);
  // 真实背包点击路径选中炮塔（M7 教训：只走测试 API 会漏背包分流缺陷）
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyZ' })));
  await page.waitForFunction(() =>
    document.getElementById('inventory-modal').style.display === 'flex', null, { timeout: 5_000 });
  const picked = await page.evaluate(() => {
    const slots = [...document.querySelectorAll('#inventory-grid .mc-slot')];
    const slot = slots.find((s) => s.querySelector('.mc-item-name')?.textContent === 'turret_alias_block');
    if (!slot) return null;
    slot.click();
    return window.__MC_GAME__.player.inventory.selectedSlot;
  });
  expect(picked).not.toBe(null);
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape' })));
  await page.waitForFunction(() => window.__MC_GAME__.uiModal === false, null, { timeout: 5_000 });

  // ---- A 侧：中心一株 short_grass ----
  const siteA = await makeFlatSiteWithPlant(page, 'short_grass');
  expect(siteA, '须造出 3×3 平地场地').not.toBe(null);
  const withPlant = await aimAndPlaceTurret(page, siteA, siteA.groundY + 1);
  // 前提：主射线真的命中了那株草（否则本用例测不到缺陷）
  expect(withPlant.target.blockPos).toEqual([siteA.ox, siteA.groundY + 1, siteA.oz]);
  expect(withPlant.target.name).toBe('short_grass');
  expect(withPlant.after).toBe(withPlant.before + 1);

  // ---- B 侧：同一场地清掉草（唯一变量），再放一座 ----
  const siteB = await page.evaluate((s) => {
    const g = window.__MC_GAME__;
    // 清掉上一座炮塔的 11 格，回到「裸地」初态
    const a = g.turrets.anchorOf(`turret-${g.turrets.count()}`);
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      g.editor.setBlock({ x: a[0] + dx, y: a[1] - 2, z: a[2] + dz, id: 0 });
    }
    g.editor.setBlock({ x: a[0], y: a[1] - 1, z: a[2], id: 0 });
    g.editor.setBlock({ x: a[0], y: a[1], z: a[2], id: 0 });
    g.editor.setBlock({ x: s.ox, y: s.groundY + 1, z: s.oz, id: 0 });
    return s;
  }, siteA);
  const noPlant = await aimAndPlaceTurret(page, siteB, siteB.groundY);
  expect(noPlant.target.name).toBe('stone');
  expect(noPlant.after).toBe(noPlant.before + 1);

  // ⚠️ **判据是两侧绝对高度相等**，不是「有草侧低于某个数」：只看单侧时
  // 「整座炮塔上移一格」在内部一致（锚点/底座/柱同步偏移），断言会全绿 —— 缺陷正是该形态。
  expect(withPlant.baseY, '有草与无草的底座必须同高').toBe(noPlant.baseY);
  expect(withPlant.baseY).toBe(siteA.groundY + 1);          // 底座 = 地面之上第一格
  expect(withPlant.anchor[1]).toBe(siteA.groundY + 3);
  expect(withPlant.baseName).toBe('iron_ore');
  expect(withPlant.plantCellName, '草格被底座覆盖').toBe('iron_ore');
  expect(withPlant.groundName, '地面格本身不被替换').toBe('stone');
  // pivot 由 blockEntity.origin 派生 ⇒ 它也必须与无草侧同高（否则渲染/炮口整体高一格）
  expect(withPlant.pivotY).toBe(noPlant.pivotY);
});

test('3×3 底座里另有一株草：整座炮塔仍放得下且那株草被覆盖', async ({ page }) => {
  test.setTimeout(240_000);
  await boot(page);
  const site = await makeFlatSiteWithPlant(page, null);
  expect(site).not.toBe(null);
  expect(await page.evaluate(() => {
    const inv = window.__MC_GAME__.player.inventory;
    const idx = inv.slots.findIndex((s) => s.item === 'turret_alias_block');
    inv.selectSlot(idx);
    return idx;
  })).toBeGreaterThanOrEqual(0);
  // 中心是裸地（origin 合法），但底座另一格长草 —— 旧 occupied 判据会整座拒放
  const r = await page.evaluate(async (s) => {
    const g = window.__MC_GAME__;
    g.editor.setBlock({ x: s.ox + 1, y: s.groundY + 1, z: s.oz + 1, id: g.registry.idOf('bush_grass') });
    const before = g.turrets.count();
    const res = g.placeTurret([s.ox, s.groundY, s.oz]);
    const anchor = res.ok ? res.anchor : null;
    let iron = 0;
    if (anchor) {
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
        if (g.world.getBlockId(anchor[0] + dx, anchor[1] - 2, anchor[2] + dz) === g.registry.idOf('iron_ore')) iron++;
      }
    }
    return {
      ok: res.ok, reason: res.reason ?? null, grew: g.turrets.count() - before, iron,
      cornerName: g.registry.nameOf(g.world.getBlockId(s.ox + 1, s.groundY + 1, s.oz + 1)),
    };
  }, site);
  expect(r.ok, `邻格有草不得拒放（reason=${r.reason}）`).toBe(true);
  expect(r.grew).toBe(1);
  expect(r.iron).toBe(9);
  expect(r.cornerName).toBe('iron_ore');
});
