// tests/minecarts.spec.mjs — 矿车 Epic 验收（设计文档 §7）
//
// Tier 1 断言落点说明（照 turrets.spec.mjs 头部同手法）：本 spec 的关键回归是
// ① 背包选中路径的放置分流（M7 教训：只测 API 会漏玩家主路径）；
// ② 帧序接线（beginFrame → entities.update → applyDeferred → syncIndex 缺一环车就不动）；
// ③ reload 恢复（持久实体 snapshot 往返）；
// ④ 乘坐跟随的分轴障碍检测（Task 6：车穿低矮隧道时玩家不被埋进实心块）。
import { test, expect } from 'playwright/test';

/**
 * 等世界真正稳定。⚠️ **没有共享 helper 模块** —— 整段照
 * `tests/turrets.spec.mjs` 复制（含其判据与 90s timeout）。
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
 * ⚠️ **必须钉 seed**：地形随 seed 变化，落点可复现性决定断言稳定（与 turrets.spec.mjs 同口径）。
 */
const URL = '/?vd=2&seed=12345';

async function boot(page) {
  // ⚠️ **必须显式抬超时**：`playwright.config` 的全局 timeout 是 **60s**，而本 spec 每个用例
  // 都要 `waitWorldSettled`（内部 waitForFunction 各给 90s）+ 数秒 rAF 循环 → 60s 必超时。
  // 放在共享 helper 里而不是逐个用例写（DRY）—— `test.setTimeout` 在被 await 的 helper 内
  // 调用同样生效（仍在该 test 的执行上下文里）。与 `tests/turrets.spec.mjs` 同口径。
  test.setTimeout(180_000);
  await page.goto(URL);
  await waitWorldSettled(page);
}

/**
 * 在玩家附近找一段可铺轨的地面并铺一条直轨，返回轨道上方格（矿车放置点）。
 * ⚠️ 铺轨走 editor.setBlock（唯一世界写入入口），不用 world.setBlock 绕过 remesh。
 * ⚠️ 放置点取 ox+1（不是 ox）：给激活后「确实移动过」的断言留出 6 格行程，
 * 且车头前方立即有轨（alignToTrack 不会返回 null）。
 */
async function layTrackNearPlayer(page, length = 8) {
  return page.evaluate((len) => {
    const g = window.__MC_GAME__;
    const px = Math.floor(g.player.physics.pos.x);
    const pz = Math.floor(g.player.physics.pos.z);
    const trackId = g.registry.idOf('sand_train_track');
    for (let ox = px + 2; ox <= px + 30; ox++) {
      for (let oz = pz - 20; oz <= pz + 20; oz++) {
        if (!g.world.hasColumn(Math.floor(ox / 16), Math.floor(oz / 16))) continue;
        let groundY = null;
        for (let y = 90; y > -32; y--) {
          if (g.world.getBlockId(ox, y, oz) !== 0) { groundY = y; break; }
        }
        // ⚠️ 地面必须实心（排除水面：water 非空气但 solid=false，轨道不能铺在水面上）
        if (groundY === null || !g.world.isSolid(ox, groundY, oz)) continue;
        // 轨道层（groundY+1）与其上方一格必须全空
        let clear = true;
        for (let i = 0; i < len && clear; i++) {
          const x = ox + i;
          if (!g.world.hasColumn(Math.floor(x / 16), Math.floor(oz / 16))) { clear = false; break; }
          if (g.world.getBlockId(x, groundY + 1, oz) !== 0) clear = false;
          if (g.world.getBlockId(x, groundY + 2, oz) !== 0) clear = false;
        }
        if (!clear) continue;
        for (let i = 0; i < len; i++) {
          g.editor.setBlock({ x: ox + i, y: groundY + 1, z: oz, id: trackId, meta: 0 });
        }
        return { cell: [ox + 1, groundY + 2, oz], trackY: groundY + 1 };
      }
    }
    return null;
  }, length);
}

test('放置：背包选中 mine_cart 右键 → 矿车实体出现并被渲染', async ({ page }) => {
  await boot(page);
  const spot = await layTrackNearPlayer(page);
  expect(spot).not.toBeNull();
  const r = await page.evaluate(({ cell }) => {
    const g = window.__MC_GAME__;
    // 走背包选中路径（M7 教训：不能只测 selectPlaceable API）
    const slotIdx = g.player.inventory.slots.findIndex((s) => s.item === 'mine_cart');
    g.player.inventory.selectSlot(slotIdx);
    g.player.target = {
      hit: true, blockPos: [cell[0], cell[1] - 1, cell[2]],
      prevPos: cell, dist: 2, normal: [0, 1, 0],
    };
    g.player.placeBlock();
    const cars = g.minecarts.cars();
    return {
      slotIdx,
      count: cars.length,
      pos: cars[0]?.state.position ?? null,
    };
  }, spot);
  expect(r.slotIdx).toBeGreaterThanOrEqual(0);   // mine_cart 必须在背包里（否则分流无从谈起）
  expect(r.count).toBe(1);
  expect(r.pos).toEqual(spot.cell);
  // ⚠️ 渲染状态（slotCount/visible）必须**等一帧**再读 —— `minecartRenderer.sync()` 只在
  // 帧循环里跑（game.js 帧序末段），`placeBlock()` 本身不碰渲染器。同步读会拿到陈旧的 0/false。
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(r)));
  const renderState = await page.evaluate(() => ({
    slotCount: window.__MC_GAME__.minecartRenderer.slotCount(),
    visible: window.__MC_GAME__.minecartRenderer.meshes.body.visible,
  }));
  expect(renderState.slotCount).toBe(1);
  expect(renderState.visible).toBe(true);
});

test('激活与移动：ctrl 激活后车沿轨移动，尽头停车吸附整数格', async ({ page }) => {
  await boot(page);
  const spot = await layTrackNearPlayer(page, 8);
  expect(spot).not.toBeNull();
  const result = await page.evaluate(async ({ cell }) => {
    const g = window.__MC_GAME__;
    const { ok, id } = g.minecarts.place({ cell });
    if (!ok) return { placed: false };
    g.minecarts.activate(id, false);
    // 推进 ~6 秒（2 格/秒 × 6 格行程 = 3s 理论值；窗口放宽到 6s 防转弯/跨中心检查帧不推进）
    const t0 = performance.now();
    while (performance.now() - t0 < 6000) {
      await new Promise((r) => requestAnimationFrame(r));
      const st = g.entities.get(id)?.state;
      if (st?.movementState === 'idle' && st.position[0] > cell[0]) break;   // 已移动且停稳
    }
    const elapsed = performance.now() - t0;
    const st = g.entities.get(id)?.state;
    return {
      placed: true, id,
      movement: st?.movementState,
      x: st?.position[0],
      startX: cell[0],
      elapsedMs: Math.round(elapsed),
    };
  }, spot);
  expect(result.placed).toBe(true);
  expect(result.movement).toBe('idle');          // 尽头停车
  expect(result.x).toBeGreaterThan(result.startX);   // 确实移动过（车没动则此处 FAIL）
  expect(Number.isInteger(Math.round(result.x))).toBe(true);
  expect(Math.abs(result.x - Math.round(result.x))).toBeLessThan(0.01);  // 吸附整数格
});

test('拾取：徒手左键命中矿车 → 实体消失、slot 归还', async ({ page }) => {
  await boot(page);
  const spot = await layTrackNearPlayer(page);
  expect(spot).not.toBeNull();
  const r = await page.evaluate(({ cell }) => {
    const g = window.__MC_GAME__;
    const { ok, id } = g.minecarts.place({ cell });
    if (!ok) return { placed: false };
    g.minecarts.pickUp(id);
    return {
      placed: true,
      count: g.minecarts.cars().length,
      entity: g.entities.get(id) ?? null,
    };
  }, spot);
  expect(r.placed).toBe(true);
  expect(r.count).toBe(0);
  expect(r.entity).toBeNull();
  // slot 归还在下一帧 sync 生效；等一帧
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(r)));
  const slotCount = await page.evaluate(() => window.__MC_GAME__.minecartRenderer.slotCount());
  expect(slotCount).toBe(0);
});

test('reload 恢复：flush + 重载后矿车位置与朝向不变', async ({ page }) => {
  await boot(page);
  const spot = await layTrackNearPlayer(page);
  expect(spot).not.toBeNull();
  const before = await page.evaluate(({ cell }) => {
    const g = window.__MC_GAME__;
    const { ok, id } = g.minecarts.place({ cell });
    if (!ok) return null;
    return { id, pos: g.entities.get(id).state.position, orient: g.entities.get(id).state.orientation };
  }, spot);
  expect(before).not.toBeNull();
  await page.evaluate(() => {
    const g = window.__MC_GAME__;
    return Promise.all([g.persistence.flushNow(g.world), g.persistence.flushEntities()]);
  });
  await page.reload();
  await waitWorldSettled(page);
  // 持久实体在 column ready 回调里恢复 —— 显式等它出现（恢复缺失时在此超时 FAIL，
  // 错误信息比「after 为 null」更直接）
  await page.waitForFunction(() => window.__MC_GAME__.minecarts.cars().length === 1, null,
    { timeout: 30_000, polling: 500 });
  const after = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    const cars = g.minecarts.cars();
    if (cars.length === 0) return null;
    return { pos: cars[0].state.position, orient: cars[0].state.orientation };
  });
  expect(after).not.toBeNull();
  expect(after.pos).toEqual(before.pos);
  expect(after.orient).toBe(before.orient);
});

test('乘坐：玩家站到车顶上自动绑定，空格下车', async ({ page }) => {
  await boot(page);
  const spot = await layTrackNearPlayer(page);
  expect(spot).not.toBeNull();
  const r = await page.evaluate(async ({ cell }) => {
    const g = window.__MC_GAME__;
    const { ok, id } = g.minecarts.place({ cell });
    if (!ok) return { placed: false };
    // 把玩家传送到车顶（mc-lite 绑定判据：|playerY − 车顶| < 0.3）
    const topY = cell[1] + 0.9;
    g.player.physics.pos.x = cell[0] + 0.5;
    g.player.physics.pos.y = topY;
    g.player.physics.pos.z = cell[2] + 0.5;
    // 跑几帧让 _updateMinecartRiding 绑定
    for (let i = 0; i < 5; i++) await new Promise((r) => requestAnimationFrame(r));
    const bound = g.player.ridingMinecartId === id;
    // 空格下车
    g.player.keys.add('Space');
    for (let i = 0; i < 5; i++) await new Promise((r) => requestAnimationFrame(r));
    g.player.keys.delete('Space');
    const unbound = g.player.ridingMinecartId === null;
    return { placed: true, bound, unbound };
  }, spot);
  expect(r.placed).toBe(true);
  expect(r.bound).toBe(true);
  expect(r.unbound).toBe(true);
});

test('乘坐边沿语义：按住空格上车不被弹下；松开再按才下车（Task 6 fix round 1 覆盖）', async ({ page }) => {
  await boot(page);
  const spot = await layTrackNearPlayer(page);
  expect(spot).not.toBeNull();
  const r = await page.evaluate(async ({ cell }) => {
    const g = window.__MC_GAME__;
    const { ok, id } = g.minecarts.place({ cell });
    if (!ok) return { placed: false };
    const topY = cell[1] + 0.9;
    // ① 按住空格上车（模拟跳上车时还按着空格）
    g.player.keys.add('Space');
    g.player.physics.pos.x = cell[0] + 0.5;
    g.player.physics.pos.y = topY;
    g.player.physics.pos.z = cell[2] + 0.5;
    for (let i = 0; i < 5; i++) await new Promise((r) => requestAnimationFrame(r));
    const boundWhileHolding = g.player.ridingMinecartId === id;
    const notEjected = g.player.ridingMinecartId === id;   // 按住空格不应被弹下
    // ② 仍按住空格 → 不下车（边沿触发：未松开不算「再按」）
    for (let i = 0; i < 5; i++) await new Promise((r) => requestAnimationFrame(r));
    const stillRidingWhileHeld = g.player.ridingMinecartId === id;
    // ③ 松开空格（复位边沿）
    g.player.keys.delete('Space');
    for (let i = 0; i < 3; i++) await new Promise((r) => requestAnimationFrame(r));
    // ④ 再按空格 → 下车
    g.player.keys.add('Space');
    for (let i = 0; i < 5; i++) await new Promise((r) => requestAnimationFrame(r));
    g.player.keys.delete('Space');
    const dismountedAfterReleasePress = g.player.ridingMinecartId === null;
    return { placed: true, boundWhileHolding, notEjected, stillRidingWhileHeld, dismountedAfterReleasePress };
  }, spot);
  expect(r.placed).toBe(true);
  expect(r.boundWhileHolding).toBe(true);
  expect(r.notEjected).toBe(true);
  expect(r.stillRidingWhileHeld).toBe(true);
  expect(r.dismountedAfterReleasePress).toBe(true);
});

test('爆炸摧毁：TNT 半径内的矿车被移除', async ({ page }) => {
  await boot(page);
  const spot = await layTrackNearPlayer(page);
  expect(spot).not.toBeNull();
  const r = await page.evaluate(({ cell }) => {
    const g = window.__MC_GAME__;
    const { ok } = g.minecarts.place({ cell });
    if (!ok) return { placed: false };
    // 在车旁放 TNT 并引爆（爆炸中心 = TNT 格）
    const tntId = g.registry.idOf('tnt');
    g.editor.setBlock({ x: cell[0] + 1, y: cell[1], z: cell[2], id: tntId });
    g.explodeTnt(cell[0] + 1, cell[1], cell[2]);
    return { placed: true, count: g.minecarts.cars().length };
  }, spot);
  expect(r.placed).toBe(true);
  expect(r.count).toBe(0);
});

test('乘坐：玩家从轨道上走进静止矿车 → 自动站上并绑定（不穿模，不 teleport）', async ({ page }) => {
  await boot(page);
  const spot = await layTrackNearPlayer(page, 8);
  expect(spot).not.toBeNull();
  const r = await page.evaluate(async ({ cell }) => {
    const g = window.__MC_GAME__;
    const { ok, id } = g.minecarts.place({ cell });
    if (!ok) return { skipped: true, reason: `place-failed:${id ?? ''}` };
    // 把玩家放到车前 3 格的**轨面上**（脚底 y = 车顶格 y），朝 +X 走。
    // ⚠️ 不 teleport 到车顶 —— 那正是既有用例绕过「走上去」这一步而漏掉本缺陷的原因
    // （M7 教训：测试须走玩家主路径）。
    const p = g.player.physics.pos;
    p.x = cell[0] - 3 + 0.5;
    p.y = cell[1];
    p.z = cell[2] + 0.5;
    g.player.physics.vel.y = 0;
    g.player.yaw = -Math.PI / 2;   // `_applyInput` 下 yaw=-π/2 → move(1, 0) = +X
    g.player.keys.add('KeyW');
    // 3 格 / 8 格每秒 ≈ 0.4s；给 4s 余量（含 step-up 与绑定帧）
    const t0 = performance.now();
    let boundAt = null;
    let clippedFrames = 0;
    while (performance.now() - t0 < 4000) {
      await new Promise((rr) => requestAnimationFrame(rr));
      const q = g.player.physics.pos;
      // 穿模判据：脚底格与车格重叠（XZ）且脚底低于车顶
      const car = g.entities.get(id);
      if (car) {
        const [cx, cy, cz] = car.state.position;
        const sameCellXZ = Math.floor(q.x) === Math.floor(cx) && Math.floor(q.z) === Math.floor(cz);
        if (sameCellXZ && q.y < cy + 0.9 - 0.05) clippedFrames++;
      }
      if (boundAt === null && g.player.ridingMinecartId === id) boundAt = performance.now() - t0;
      if (boundAt !== null) break;
    }
    // ⚠️ 绑定帧**不**锁 y：绑定发生在 `_updateMinecartRiding` 的未绑定分支，而
    // 「y 锁车顶」在已绑定分支（下一帧才跑）—— mc-lite 同序同行为。故绑定后多跑几帧
    // 再读 y，否则读到的是 step-up 落点 carY+1（实测 20 vs 车顶 19.9，差 0.1）。
    for (let i = 0; i < 5; i++) await new Promise((rr) => requestAnimationFrame(rr));
    g.player.keys.delete('KeyW');
    const car = g.entities.get(id);
    return {
      skipped: false,
      bound: g.player.ridingMinecartId === id,
      boundAt,
      clippedFrames,
      playerY: g.player.physics.pos.y,
      carTopY: car ? car.state.position[1] + 0.9 : null,
    };
  }, spot);
  if (r.skipped) test.skip(true, `无法建立场景：${r.reason}`);
  console.log('[walk-onto-cart] 实测值:', JSON.stringify(r));
  // 核心断言：走进车后自动绑定乘坐（mc-lite 同行为）
  expect(r.bound).toBe(true);
  // 全程零帧穿模（脚底与车体重叠）
  expect(r.clippedFrames).toBe(0);
  // 绑定后玩家脚底锁在车顶（不是轨面）
  expect(Math.abs(r.playerY - r.carTopY)).toBeLessThan(0.01);
});

test('乘坐：玩家静止站着，矿车开过来撞 → 自动被抬上车并绑定（不穿模）', async ({ page }) => {
  await boot(page);
  const spot = await layTrackNearPlayer(page, 10);
  expect(spot).not.toBeNull();
  const r = await page.evaluate(async ({ cell }) => {
    const g = window.__MC_GAME__;
    const { ok, id } = g.minecarts.place({ cell });
    if (!ok) return { skipped: true, reason: `place-failed:${id ?? ''}` };
    g.minecarts.activate(id, false);
    // 玩家静止站在车前方 3 格的轨面上，**不按任何键**（纯「车撞上来」）。
    // ⚠️ 脚底 y = 车占据格 y（轨面），与「走进静止车」用例同口径。
    const p = g.player.physics.pos;
    p.x = cell[0] + 3 + 0.5;
    p.y = cell[1];
    p.z = cell[2] + 0.5;
    g.player.physics.vel.y = 0;
    g.player.keys.clear();
    const playerCellX = Math.floor(p.x);
    const t0 = performance.now();
    let boundAt = null;
    let clippedFrames = 0;
    while (performance.now() - t0 < 6000) {
      await new Promise((rr) => requestAnimationFrame(rr));
      const q = g.player.physics.pos;
      const car = g.entities.get(id);
      if (!car) continue;
      const [cx, cy, cz] = car.state.position;
      // 穿模判据：车与玩家同格（XZ）且玩家脚底低于车顶
      if (Math.floor(q.x) === Math.floor(cx) && Math.floor(q.z) === Math.floor(cz)
          && q.y < cy + 0.9 - 0.05) clippedFrames++;
      if (boundAt === null && g.player.ridingMinecartId === id) boundAt = performance.now() - t0;
      // 车已走过玩家格 → 结束（无论是否绑定）
      if (Math.floor(cx) > playerCellX + 1) break;
    }
    // 绑定帧不锁 y（mc-lite 同序）→ 多跑几帧再读
    for (let i = 0; i < 5; i++) await new Promise((rr) => requestAnimationFrame(rr));
    const car = g.entities.get(id);
    return {
      skipped: false,
      bound: g.player.ridingMinecartId === id,
      boundAt: boundAt === null ? null : Math.round(boundAt),
      clippedFrames,
      playerY: g.player.physics.pos.y,
      carTopY: car ? car.state.position[1] + 0.9 : null,
    };
  }, spot);
  if (r.skipped) test.skip(true, `无法建立场景：${r.reason}`);
  console.log('[cart-hits-idle-player] 实测值:', JSON.stringify(r));
  // 核心断言：车撞上来后玩家被抬上车并绑定
  expect(r.bound).toBe(true);
  // 绑定后玩家脚底锁在车顶
  expect(Math.abs(r.playerY - r.carTopY)).toBeLessThan(0.01);
  // 穿模帧数极少。⚠️ **阈值刻意不贴实测值**：实测 2 帧是帧序结构性决定的
  // （车入格帧 + 绑定帧不锁 y），但贴线断言在高负载下会 flaky（同 CLAUDE.md 记的
  // `weapons-world-edit` 5ms 余量教训）。取 5：与修复前实测 **60 帧** 仍差一个数量级
  // → 注入回退必 FAIL，同时留出负载余量。
  expect(r.clippedFrames).toBeLessThanOrEqual(5);
});

test('乘坐穿低矮隧道：障碍检测阻止玩家被埋进实心块', async ({ page }) => {
  await boot(page);
  // ⚠️ **几何必须这样搭**（controller 实测核实）：车Y = groundY+2，玩家脚底 = 车Y+0.9，
  // 玩家高 1.8 → 身体跨 groundY+2 ~ groundY+4.7（含整数层 groundY+2/+3/+4）。
  // 若把天花板放在玩家绑定位置的正上方，**绑定瞬间就已嵌入** —— 障碍检测只拦移动，
  // 救不了已嵌入的状态。故正确测法：天花板**只盖隧道内部**，玩家在隧道口外绑定
  // （净空足够），车开进去时玩家跟随被挡 → 停在隧道口 → 偏离 > 0.6 自动下车。
  const r = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    const px = Math.floor(g.player.physics.pos.x);
    const pz = Math.floor(g.player.physics.pos.z);
    const trackId = g.registry.idOf('sand_train_track');
    const stoneId = g.registry.idOf('stone');
    // 找一段可铺 8 格轨的地面（前 2 格做隧道口，后 6 格盖天花板）
    let spot = null;
    for (let ox = px + 2; ox <= px + 20 && !spot; ox++) {
      for (let oz = pz - 10; oz <= pz + 10 && !spot; oz++) {
        if (!g.world.hasColumn(Math.floor(ox / 16), Math.floor(oz / 16))) continue;
        let groundY = null;
        for (let y = 90; y > -32; y--) {
          if (g.world.getBlockId(ox, y, oz) !== 0) { groundY = y; break; }
        }
        // ⚠️ 地面必须实心（排除水面）
        if (groundY === null || !g.world.isSolid(ox, groundY, oz)) continue;
        let clear = true;
        for (let i = 0; i < 8 && clear; i++) {
          const x = ox + i;
          if (!g.world.hasColumn(Math.floor(x / 16), Math.floor(oz / 16))) { clear = false; break; }
          // 轨道层 + 上方 3 格净空（玩家高 1.8 站在车顶上需要）
          for (let dy = 1; dy <= 4; dy++) {
            if (g.world.getBlockId(x, groundY + dy, oz) !== 0) clear = false;
          }
        }
        if (clear) spot = { ox, oz, groundY };
      }
    }
    if (!spot) return { skipped: true };
    const { ox, oz, groundY } = spot;
    const cartY = groundY + 2;
    // 铺 8 格轨
    for (let i = 0; i < 8; i++) {
      g.editor.setBlock({ x: ox + i, y: groundY + 1, z: oz, id: trackId, meta: 0 });
    }
    // 天花板只盖隧道内部（i=2..7），高度 = groundY+3 —— 玩家身体跨 +2~+4.7，必被挡
    for (let i = 2; i < 8; i++) {
      g.editor.setBlock({ x: ox + i, y: groundY + 3, z: oz, id: stoneId });
    }
    // 车放在隧道口（i=0），玩家站在它顶上绑定（此处无天花板，净空足够）
    const { ok, id } = g.minecarts.place({ cell: [ox, cartY, oz] });
    if (!ok) return { skipped: true, reason: 'place-failed' };
    g.player.physics.pos.x = ox + 0.5;
    g.player.physics.pos.y = cartY + 0.9;
    g.player.physics.pos.z = oz + 0.5;
    g.minecarts.activate(id, false);
    // 跑足够帧让车开进隧道（8 格 / 2 格每秒 = 4s，给 6s 余量）
    const t0 = performance.now();
    let maxPlayerY = -Infinity;
    let embeddedFrames = 0;
    while (performance.now() - t0 < 6000) {
      await new Promise((r) => requestAnimationFrame(r));
      const p = g.player.physics.pos;
      maxPlayerY = Math.max(maxPlayerY, p.y);
      // 嵌入判据：玩家身体（脚底~脚底+1.8）跨到的整数层里有实心块
      // （与 physics.collidesAt 同口径：半宽 0.3、高 1.8−0.001）
      const y0 = Math.floor(p.y), y1 = Math.floor(p.y + 1.8 - 0.001);
      const x0 = Math.floor(p.x - 0.3), x1 = Math.floor(p.x + 0.3);
      const z0 = Math.floor(p.z - 0.3), z1 = Math.floor(p.z + 0.3);
      let embedded = false;
      for (let bx = x0; bx <= x1 && !embedded; bx++) {
        for (let by = y0; by <= y1 && !embedded; by++) {
          for (let bz = z0; bz <= z1 && !embedded; bz++) {
            if (g.world.isSolid(bx, by, bz)) embedded = true;
          }
        }
      }
      if (embedded) embeddedFrames++;
    }
    const carX = g.entities.get(id)?.state.position[0] ?? null;
    return {
      skipped: false,
      embeddedFrames,
      maxPlayerY,
      ceilingY: groundY + 3,
      playerY: g.player.physics.pos.y,
      playerX: g.player.physics.pos.x,
      riding: g.player.ridingMinecartId,
      carX,
      tunnelMouthX: ox + 0.5,
    };
  });
  if (r.skipped) test.skip(true, '找不到可铺轨的地面');
  // 核心断言：全程零帧嵌入（障碍检测生效）
  expect(r.embeddedFrames).toBe(0);
  // 车确实开进了隧道（否则用例是无效盲区 —— 恒真）
  expect(r.carX).toBeGreaterThan(r.tunnelMouthX + 2);
  // 玩家被挡在隧道口附近（没跟着车进去），且已自动下车
  expect(r.playerX).toBeLessThan(r.carX);
  expect(r.riding).toBeNull();
});

test('乘坐跨模态暂停：钳制跟随增量，玩家不瞬移且自动下车（最终评审 MUST-FIX #1）', async ({ page }) => {
  await boot(page);
  const spot = await layTrackNearPlayer(page, 12);
  expect(spot).not.toBeNull();
  const r = await page.evaluate(async ({ cell }) => {
    const g = window.__MC_GAME__;
    const { ok, id } = g.minecarts.place({ cell });
    if (!ok) return { skipped: true, reason: 'place-failed' };
    // 玩家传送到车顶并绑定
    g.player.physics.pos.x = cell[0] + 0.5;
    g.player.physics.pos.y = cell[1] + 0.9;
    g.player.physics.pos.z = cell[2] + 0.5;
    g.minecarts.activate(id, false);
    for (let i = 0; i < 5; i++) await new Promise((r) => requestAnimationFrame(r));
    if (g.player.ridingMinecartId !== id) return { skipped: true, reason: 'not-bound' };
    const boundPos = { ...g.player.physics.pos };

    // ① 开面板：`game.js` 的 `player.update` 被 `!uiModal` 门控 → `_updateMinecartRiding`
    //    不再被调用（`_lastRidePos` 冻结），而 `entities.update` **不受门控** → 车继续移动。
    g.pushModal('settings');
    const modalOn = g.uiModal;
    // ② 等车移动数格（speed=2 格/秒；给 3s → 约 6 格，12 格轨够跑）
    const t0 = performance.now();
    while (performance.now() - t0 < 3000) await new Promise((r) => requestAnimationFrame(r));
    const carPosDuringModal = g.entities.get(id)?.state.position ?? null;
    const playerPosDuringModal = { ...g.player.physics.pos };
    // ③ 关面板 → 下一帧 `_updateMinecartRiding` 会看到「全部累积位移」的增量
    g.popModal('settings');
    await new Promise((r) => requestAnimationFrame(r));
    const after = { ...g.player.physics.pos };
    const riding = g.player.ridingMinecartId;

    // 嵌入判据（与 physics.collidesAt 同口径：半宽 0.3、高 1.8−0.001）
    const y0 = Math.floor(after.y), y1 = Math.floor(after.y + 1.8 - 0.001);
    const x0 = Math.floor(after.x - 0.3), x1 = Math.floor(after.x + 0.3);
    const z0 = Math.floor(after.z - 0.3), z1 = Math.floor(after.z + 0.3);
    let embedded = false;
    for (let bx = x0; bx <= x1 && !embedded; bx++) {
      for (let by = y0; by <= y1 && !embedded; by++) {
        for (let bz = z0; bz <= z1 && !embedded; bz++) {
          if (g.world.isSolid(bx, by, bz)) embedded = true;
        }
      }
    }
    return {
      skipped: false, modalOn,
      // 模态期车确实移动了数格（否则用例是无效盲区 —— 恒真）
      carTravel: carPosDuringModal ? carPosDuringModal[0] - cell[0] : null,
      // 模态期玩家位置冻结（player.update 未被调用）
      playerFrozenDelta: Math.abs(playerPosDuringModal.x - boundPos.x),
      // 关面板后一帧的位移（钳制生效 → 约等于一帧步长；未钳制 → 等于 carTravel）
      jumpDelta: Math.abs(after.x - playerPosDuringModal.x),
      playerX: after.x, carX: carPosDuringModal ? carPosDuringModal[0] : null,
      riding, embedded,
    };
  }, spot);
  if (r.skipped) test.skip(true, `无法建立乘坐状态：${r.reason}`);
  console.log('[modal-ride] 实测值:', JSON.stringify(r));
  // 前置：模态确实生效、车确实移动了数格（防恒真盲区）
  expect(r.modalOn).toBe(true);
  expect(r.carTravel).toBeGreaterThan(2);
  expect(r.playerFrozenDelta).toBe(0);   // 模态期 player.update 未被调用 → 位置冻结
  // ① 玩家没有瞬移：位移被钳到「一帧合理步长」量级（远小于 carTravel 的数格）
  expect(r.jumpDelta).toBeLessThan(0.5);
  // ② 车已走远 → 既有偏离检查触发自动下车
  expect(r.riding).toBeNull();
  // ③ 玩家没被埋进实心块
  expect(r.embedded).toBe(false);
});

test('乘坐中被相向碰撞回弹：乘客跟随车一起退，不被甩下车（最终评审 P1）', async ({ page }) => {
  // ⚠️ **本用例是「钳制修法」的回归防线**（流程教训：新修法必须补一条能抓住它**新引入**
  // 行为的断言）。相向碰撞把车**整格回弹到 `lastTrack`**（`planMinecartStep` 的相向分支），
  // 而 `lastTrack` 只在「进入新格」时更新 → 回弹是**真·单帧位移**（实测 1.9986 格，
  // dt=1/60）—— 不是跳帧。任何「按位移大小钳制」的修法（曾经用
  // `minecart-config.js` 的一个步长倍数常量实现过，已删）都会把乘客削到偏离阈值 0.6
  // 之外 → 同帧甩下车。
  // 判据必须同时覆盖两侧（只测「没被甩下车」会被「玩家压根没动」蒙混过关）：
  // ① `ejected === false`；② `maxPlayerJump > 1.0`（乘客**确实跟随了回弹**）。
  await boot(page);
  const spot = await layTrackNearPlayer(page, 14);
  expect(spot).not.toBeNull();
  const r = await page.evaluate(async ({ cell }) => {
    const g = window.__MC_GAME__;
    // `cell` = [轨首+1, groundY+2, oz]（车放置点；车下方一格是轨）
    const [cx, carY, oz] = cell;
    // 车必须在**轨格中心**（`place` 的 occupied 判据 + `carAtRound` 索引都是整格基）：
    // 放置点 = 轨格上方的空气格。a = 轨首（cell 下一格）+1 格，b 再东 6 格。
    const ax = cx + 1, bx = cx + 7;
    const a = g.minecarts.place({ cell: [ax, carY, oz] });
    const b = g.minecarts.place({ cell: [bx, carY, oz] });
    if (!a.ok || !b.ok) return { skipped: `place-failed:${a.reason ?? ''}/${b.reason ?? ''}` };
    // 玩家站到 a 车顶并等绑定（`ridingCarFor` 判据：脚下格有车 + 脚底在车顶 ±0.3）
    g.player.physics.pos.x = ax + 0.5;
    g.player.physics.pos.y = carY + 0.9;
    g.player.physics.pos.z = oz + 0.5;
    let frames = 0;
    while (g.player.ridingMinecartId !== a.id && frames++ < 60) {
      await new Promise((r) => requestAnimationFrame(r));
    }
    if (g.player.ridingMinecartId !== a.id) return { skipped: 'not-bound' };
    // 两车相向（a 向东、b 向西）→ 碰撞分支把两车各自回弹到 lastTrack
    g.minecarts.activate(a.id, false);
    g.minecarts.activate(b.id, true);
    const t0 = performance.now();
    let ejectedAt = null;
    let maxPlayerJump = 0;
    let prevPX = g.player.physics.pos.x;
    while (performance.now() - t0 < 8000) {
      await new Promise((r) => requestAnimationFrame(r));
      const p = g.player.physics.pos;
      maxPlayerJump = Math.max(maxPlayerJump, Math.abs(p.x - prevPX));
      prevPX = p.x;
      if (g.player.ridingMinecartId === null && ejectedAt === null) {
        ejectedAt = Math.round(performance.now() - t0);
        break;   // 只在我们确实被甩下车时提前退出；正常情况跑满 8s 让两车停稳
      }
    }
    const sa = g.entities.get(a.id)?.state;
    const sb = g.entities.get(b.id)?.state;
    const rx = (v) => (v === undefined ? null : Number(v.toFixed(3)));
    return {
      skipped: false,
      ax,
      ejected: g.player.ridingMinecartId === null,
      ejectedAtMs: ejectedAt,
      // ⚠️ 钳制阈值（若残留）= `speed*dt*2` ≈ 0.067，正常行驶单帧 = 0.0333
      // → 「实际最大单帧位移」直接读出钳制是否生效（钳制在位时实测 0.0336）
      maxPlayerJump: Number(maxPlayerJump.toFixed(4)),
      playerX: Number(g.player.physics.pos.x.toFixed(3)),
      aPosX: rx(sa?.position[0]), bPosX: rx(sb?.position[0]),
      aState: sa?.movementState ?? null, bState: sb?.movementState ?? null,
    };
  }, spot);
  console.log('[bounce-ride] 实测值:', JSON.stringify(r));
  if (r.skipped) test.skip(true, `无法建立相向碰撞场景：${r.skipped}`);
  // 前置：两车都停稳了（碰撞确实发生且已收敛 —— 否则下面的断言是无效盲区）
  expect(r.aState).toBe('idle');
  expect(r.bState).toBe('idle');
  // ① 乘客没被甩下车
  expect(r.ejected).toBe(false);
  // ② 乘客**确实跟随了回弹**（不是「压根没动」的恒真盲区）：无钳制实测 1.9986
  expect(r.maxPlayerJump).toBeGreaterThan(1.0);
  // ③ 两车终态分开且都在 a 车起始格之后（碰撞逻辑未被玩家侧改动影响）
  expect(r.bPosX).toBeGreaterThan(r.aPosX);
});
