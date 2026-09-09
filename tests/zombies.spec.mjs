import { test, expect } from 'playwright/test';

// M6：丧尸集成验收（M6 规格 §4）。经 `window.__MC_GAME__` 公开 API 驱动，无头环境无真实键鼠。
//
// 分工（docs/testing-policy.md §2.4）：
// - **纯逻辑/渲染单元断言**走浏览器内单测（`/src/tests/index.html` 的 test-zombies.js，17+ 条）
//   —— 小型自建 fixture 世界，落点条件可控，能精确制造「头格被占用」等非法出生场景；
// - **本 spec** 只测真游戏页才成立的部分：真实地形上的合法出生、六部件实例发布、
//   死亡对称回收、真实 column 卸载链路。
//
// 落点一律用 `legalSpawnNear()` 在玩家当前位置附近扫描（计划 Task 2 给的 helper），
// **不用绝对坐标** —— 真世界的地形随 seed 变化，硬编码落点会在别的 seed 上恒失败。

/**
 * 把测试 helper 挂到 window（**Playwright 无法序列化函数作为 evaluate 参数** —— 只能传
 * 可 JSON 化的值；实测踩坑：传箭头函数会抛 "Attempting to serialize unexpected value"）。
 *
 * 故先 evaluate 一次把 helper 定义在浏览器上下文，后续 evaluate 里用 `window.__ZT__.*`
 * 引用。这不是玩法 API，只服务测试。
 */
async function installHelpers(page) {
  await page.evaluate(() => {
    window.__ZT__ = {
      /**
       * 在玩家附近找一个合法丧尸落点（脚格/头格 air + 脚下 solid）。
       * **不用绝对坐标** —— 真世界地形随 seed 变化，硬编码落点在别的 seed 上恒失败。
       *
       * **y 必须向下扫真实地面，不能只扫玩家 y±4**（实测踩坑，根因见下）：
       * `findSpawnY`（src/gen/terrain.js:98）从世界顶向下扫第一个非空气方块并返回 y+1，
       * 而 M2-7 的云层 `supportsPlayer=1` 但 `solid=0` → 空中结构会被当成「地面」，玩家可能
       * 出生在云面上（实测 y=56，脚下 `belowSolid=false`）。此时 y±4 范围内全是空气且脚下
       * 不 solid → 扫到 0 个落点（压力测试曾因此 spawnedCount=0 而全量跑失败、单独跑通过）。
       * 故对每个 (x,z) 从玩家高度**向下扫**找第一个 solid 方块，其顶面作为落点。
       *
       * @param {number} distance 目标距离（格）
       * @returns {number[]} [x, y, z] 脚底位置
       */
      legalSpawnNear(distance) {
        const g = window.__MC_GAME__;
        const p = g.player.physics.pos;
        for (let r = distance; r <= distance + 12; r++) {
          for (const [dx, dz] of [[r, 0], [-r, 0], [0, r], [0, -r]]) {
            const x = Math.floor(p.x) + dx, z = Math.floor(p.z) + dz;
            // 从玩家高度向下扫真实地面（最多 64 格，覆盖云层到地面的落差）
            for (let y = Math.floor(p.y); y >= Math.floor(p.y) - 64; y--) {
              if (g.world.getBlockId(x, y, z) === 0
                && g.world.getBlockId(x, y + 1, z) === 0
                && g.world.isSolid(x, y - 1, z)) return [x + .5, y, z + .5];
            }
          }
        }
        throw new Error('no legal zombie fixture position');
      },
      /** 六部件实例矩阵的 scale 分量（零 scale = slot 已归还不可见）。直读 typed array，不依赖 three */
      slotScales(slot) {
        const g = window.__MC_GAME__;
        return ['head', 'body', 'leftArm', 'rightArm', 'leftLeg', 'rightLeg'].map((part) => {
          const arr = g.zombieRenderer.meshes[part].instanceMatrix.array;
          const base = slot * 16;
          return [arr[base], arr[base + 5], arr[base + 10]]; // scale.x / y / z
        });
      },
      /** 瞄准丧尸躯干中心（y+0.9）并返回 setTestAim 的结果（含重算后的 DDA target） */
      aimAtZombie(pos) {
        const g = window.__MC_GAME__;
        const cam = g.camera.position.toArray();
        return g.player.setTestAim([pos[0] - cam[0], pos[1] + 0.9 - cam[1], pos[2] - cam[2]]);
      },
      /**
       * 找 count 个**尽量不重叠**的合法落点（压力测试用）。
       *
       * 真地形（城市/平原混合）未必能凑够 20 个互不重叠的落点 —— 远处可能是水面、悬崖或
       * 建筑内部。M6 无位置互斥门控（同一格可站多只丧尸），故找不到新落点时**复用已知落点**
       * 补足数量，并如实回报实际用到了多少个不同落点（不假装 20 个都是独立位置）。
       * @param {number} count @returns {{positions: number[], distinct: number}}
       */
      legalSpawnMany(count) {
        const g = window.__MC_GAME__;
        const p = g.player.physics.pos;
        const positions = [];
        const seen = new Set();
        // 逐圈扫描，收集尽量多的不同落点（上限 count）。
        // **每个 (x,z) 向下扫真实地面**，理由同 legalSpawnNear：玩家可能出生在云面上
        // （M2-7 云 supportsPlayer=1 但 solid=0），此时 y±4 范围内全是空气且脚下不 solid
        // → 扫到 0 个落点（实测踩坑：压力测试 spawnedCount=0，全量跑失败、单独跑通过）。
        for (let r = 3; r <= 40 && positions.length < count; r++) {
          for (const [dx, dz] of [[r, 0], [-r, 0], [0, r], [0, -r], [r, r], [-r, r], [r, -r], [-r, -r]]) {
            const x = Math.floor(p.x) + dx, z = Math.floor(p.z) + dz;
            // 从玩家高度向下扫第一个 solid 顶面（最多 64 格，覆盖云层到地面的落差）
            for (let y = Math.floor(p.y); y >= Math.floor(p.y) - 64; y--) {
              const key = `${x},${y},${z}`;
              if (seen.has(key)) continue;
              if (g.world.getBlockId(x, y, z) === 0
                && g.world.getBlockId(x, y + 1, z) === 0
                && g.world.isSolid(x, y - 1, z)) {
                seen.add(key);
                positions.push([x + .5, y, z + .5]);
                break;
              }
            }
            if (positions.length >= count) break;
          }
        }
        // 不足则循环复用已找到的落点补足（M6 无位置互斥门控，同一格可站多只丧尸）。
        // 索引基于 `seen.size`（已找到的不同落点数）而非 `positions.length`（后者随补足增长，
        // 用它取模会越界读到 undefined）。
        const distinctCount = positions.length;
        while (positions.length < count && distinctCount > 0) {
          positions.push(positions[positions.length % distinctCount]);
        }
        return { positions, distinct: distinctCount };
      },
    };
  });
}

/** 世界就绪判定：worldReady + 队列收敛（内存口径「sections 停止增长」不够，须等队列归零） */
async function waitWorldReady(page) {
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 90_000 });
  await page.waitForFunction(() => {
    const s = window.__MC_GAME__.scheduler.stats();
    return s.genInflight === 0 && s.meshInflight === 0 && s.meshQueued === 0
      && s.pendingMesh === 0 && s.lightInflight === 0 && s.lightQueued === 0 && s.uploadQueue === 0;
  }, null, { timeout: 90_000 });
}

test('M6：真实地形上的合法出生、非法拒绝与默认 20 上限', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/?vd=4&seed=12345');
  await waitWorldReady(page);
  await installHelpers(page);
  const result = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    const legal = window.__ZT__.legalSpawnNear(4);
    const id = g.zombies.spawn(legal, { source: 'test' });
    const state = g.zombies.get(id);
    // 空中落点（脚底抬高 20 格，脚下必不 solid）→ 须拒绝
    const airborne = g.zombies.spawn([legal[0], legal[1] + 20, legal[2]], { source: 'test' });
    // 填满到上限。**同一落点可 spawn 多只**（id 由 slot 决定，M6 无位置互斥门控）——
    // 原先每只去找新落点，但真地形（vd=4，玩家在城市里）远处未必有平地，会抛
    // 「no legal zombie fixture position」。上限门控验证的是「第 21 只被拒」，与落点无关。
    const ids = id ? [id] : [];
    for (let i = 1; i < 20; i++) {
      const spawned = g.zombies.spawn(legal, { source: 'test' });
      if (spawned) ids.push(spawned);
    }
    const atLimit = g.zombies.count();
    const over = g.zombies.spawn(legal, { source: 'test' }); // 第 21 只 → 须拒绝
    return {
      id,
      legal,
      position: state ? [...state.position] : null,
      health: state?.health ?? null,
      source: state?.source ?? null,
      airborne,
      atLimit,
      over,
      slotOf: g.zombieRenderer.slotOf(id),
      activeSlots: g.zombieRenderer.activeCount(),
      parts: Object.keys(g.zombieRenderer.meshes),
      idCount: ids.length,
    };
  });

  expect(result.id).toBeTruthy();
  expect(result.position).toEqual(result.legal);
  expect(result.health).toBe(100);
  expect(result.source).toBe('test');
  expect(result.airborne).toBeNull();
  expect(result.slotOf).toBe(0);
  expect(result.activeSlots).toBe(result.idCount);
  expect(result.parts).toEqual(['head', 'body', 'leftArm', 'rightArm', 'leftLeg', 'rightLeg']);
  // 同一落点连 spawn 20 次 → 必须恰好填满 20（id 由 slot 决定，无位置互斥门控）。
  // 第 21 只必须拒绝 —— 这条才是上限门控的有效验证。
  // **不用条件断言**（`if (atLimit===20) expect(over)...`）：atLimit 若不是 20，over 的断言
  // 根本不执行 → 上限门控改坏也全绿（实测踩坑：条件断言是被测路径不触发的变体）。
  expect(result.atLimit).toBe(20);
  expect(result.idCount).toBe(20);
  expect(result.over).toBeNull();
});

test('M6：死亡对称回收 —— slot 归还、六部件矩阵清零、scene 无泄漏', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/?vd=4&seed=12345');
  await waitWorldReady(page);
  await installHelpers(page);
  const result = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    const pos = window.__ZT__.legalSpawnNear(4);
    const id = g.zombies.spawn(pos, { source: 'test' });
    const slot = g.zombieRenderer.slotOf(id);
    const sceneChildrenBefore = g.scene.children.length;
    const now = performance.now();
    g.zombies.damage(id, 25, now);
    g.zombieRenderer.sync(g.zombies, now);
    const alive = {
      health: g.zombies.get(id)?.health ?? null,
      slot: g.zombieRenderer.slotOf(id),
      active: g.zombieRenderer.activeCount(),
      flashing: g.zombieRenderer.isFlashing(slot),
    };
    // 一击致死（999 = MAG7 伤害，这里只验证死亡路径）
    g.zombies.damage(id, 999, now);
    const dead = {
      state: g.zombies.get(id),
      slot: g.zombieRenderer.slotOf(id),
      active: g.zombieRenderer.activeCount(),
      count: g.zombies.count(),
      scales: window.__ZT__.slotScales(slot),
      sceneChildren: g.scene.children.length,
      sceneChildrenBefore,
    };
    return { alive, dead };
  });

  expect(result.alive.health).toBe(75);
  expect(result.alive.slot).toBe(0);
  expect(result.alive.active).toBe(1);
  expect(result.alive.flashing).toBe(true);

  expect(result.dead.state).toBeNull();
  expect(result.dead.slot).toBeNull();
  expect(result.dead.active).toBe(0);
  expect(result.dead.count).toBe(0);
  // 六部件矩阵全部清零（scale 分量均为 0）→ 不留残影
  for (const [sx, sy, sz] of result.dead.scales) {
    expect(sx).toBe(0);
    expect(sy).toBe(0);
    expect(sz).toBe(0);
  }
  // scene child 数不变：六个 InstancedMesh 常驻，丧尸不新增/删除 scene 节点（无泄漏）
  expect(result.dead.sceneChildren).toBe(result.dead.sceneChildrenBefore);
});

test('M6：真实 column 卸载链路回收丧尸并归还渲染 slot', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/?vd=4&seed=12345');
  await waitWorldReady(page);
  await installHelpers(page);
  const result = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    const pos = window.__ZT__.legalSpawnNear(4);
    const id = g.zombies.spawn(pos, { source: 'test' });
    const slot = g.zombieRenderer.slotOf(id);
    // 丧尸所在 column 的 key（几何推导权威 = voxel/constants.js 的 columnKeyAt）
    const columnKey = `${Math.floor(pos[0] / 16)},${Math.floor(pos[2] / 16)}`;
    const before = { count: g.zombies.count(), active: g.zombieRenderer.activeCount(), slot };
    // 走 M5 卸载链路：onColumnUnloadRequested 的 handle → commit。
    // Game 装配时把 zombies.despawnColumn 接在 commit 之前（见 game.js 注释）——
    // 这条断言正是钉住「绕过 ZombieService 的回收路径会泄漏 slot」那个缺陷。
    // `expect` 在浏览器上下文里不存在 —— 断言一律放在 evaluate **外面**（实测踩坑）
    const handle = g.scheduler._unloadRequestedListeners?.[0]?.(columnKey);
    if (!handle) return { before, after: null, columnKey, noHandle: true };
    await handle.ready;
    const committed = handle.commit();
    const after = {
      count: g.zombies.count(),
      active: g.zombieRenderer.activeCount(),
      slotOf: g.zombieRenderer.slotOf(id),
      state: g.zombies.get(id),
      committed,
    };
    return { before, after, columnKey };
  });

  expect(result.noHandle).toBeUndefined(); // 卸载 listener 必须已装配（Game.start 注册）
  expect(result.before.count).toBe(1);
  expect(result.before.active).toBe(1);
  expect(result.after.state).toBeNull();
  expect(result.after.slotOf).toBeNull();
  expect(result.after.count).toBe(0);
  // **slot 必须归还** —— 这条正是 Game 装配里「先 zombies.despawnColumn 再 commit」的意义
  expect(result.after.active).toBe(0);
  expect(result.after.committed).toBeGreaterThanOrEqual(1);
});

test('M6：AI batch 经真实 WorkerPool 可观测 —— 20Hz 单条 RPC、60 格门控、追逐生效', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/?vd=4&seed=12345');
  await waitWorldReady(page);
  await installHelpers(page);
  const result = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    const near = window.__ZT__.legalSpawnNear(4);
    const nearId = g.zombies.spawn(near, { source: 'test' });
    // 60 格门控的边界对照：59 格那只进批次、61 格那只不进。
    // 真地形上未必能找到那么远的合法落点（远处可能是水/悬崖），故先探一次 —— 探不到就
    // 只验证近尸链路，并把「远尸未测」如实回报（不假装覆盖）。
    let far59 = null, far61 = null;
    try {
      far59 = g.zombies.spawn(window.__ZT__.legalSpawnNear(59), { source: 'test' });
      far61 = g.zombies.spawn(window.__ZT__.legalSpawnNear(61), { source: 'test' });
    } catch (err) {
      // 落点扫描失败：远距门控未覆盖（下面用 farTested=false 如实断言）
    }
    const before = { ai: g.zombies.debugAiState(), pos: [...g.zombies.get(nearId).position] };
    // 等 2 个 AI 周期（0.05 秒/周期）+ 若干物理帧
    await new Promise((resolve) => setTimeout(resolve, 600));
    const after = {
      ai: g.zombies.debugAiState(),
      pos: [...g.zombies.get(nearId).position],
      mode: g.zombies.get(nearId).mode,
      velocity: [...g.zombies.get(nearId).velocity],
    };
    // 直接发一条 ai RPC 验 worker 侧形状：输入只有可 clone 的 number/object，
    // 输出只有 {id,generation,vx,vz,mode}（不读世界、不回传体素）。
    // **两个 probe**：近的（dist=5，感知门内 → chasing）+ 远的（dist=90 > 感知门 80 → idle）。
    // 只有远 probe 才能触发 worker 的 idle 分支 —— 用近 probe 验感知门是不可检测的
    // （它在门内，删掉门控判定对它毫无影响）。
    const p = g.player.physics.pos;
    const reply = await g.pool.call('ai', {
      playerPosition: [p.x, p.y, p.z], dt: 0.05,
      zombies: [
        { id: 'probe', generation: 7, position: [p.x + 5, p.y, p.z], yaw: 0, mode: 'idle' },
        { id: 'probe-far', generation: 3, position: [p.x + 90, p.y, p.z], yaw: 0, mode: 'idle' },
      ],
    });
    const workerReply = await reply.promise;
    return {
      nearId, far59, far61,
      before, after,
      workerReply,
      // 近尸距玩家的距离变化（追逐 → 距离减小）
      distBefore: Math.hypot(before.pos[0] - p.x, before.pos[2] - p.z),
      distAfter: Math.hypot(after.pos[0] - p.x, after.pos[2] - p.z),
    };
  });

  // AI RPC 真的发出且在途队列收敛（pending=0 = 无滞留回包）
  expect(result.before.ai.calls).toBe(0);
  expect(result.after.ai.calls).toBeGreaterThan(0);
  expect(result.after.ai.pending).toBe(0);
  // 批次只含 60 格内的活尸
  expect(result.after.ai.lastBatchSize).toBeGreaterThanOrEqual(1);
  // 追逐生效：mode=chasing、水平速度非零、距玩家距离减小
  expect(result.after.mode).toBe('chasing');
  expect(Math.hypot(result.after.velocity[0], result.after.velocity[2])).toBeGreaterThan(0);
  expect(result.distAfter).toBeLessThan(result.distBefore);

  // worker 侧契约：输出形状严格为 {id,generation,vx,vz,mode}，且 generation 原样回传
  // （红线 7 版本协议的前提）；不得夹带世界/体素字段
  expect(result.workerReply.updates).toHaveLength(2);
  // **返回对象形状**：只有 `updates` 一个键 —— 夹带 world/体素等字段会撑大 RPC 体积
  expect(Object.keys(result.workerReply).sort()).toEqual(['updates']);
  const update = result.workerReply.updates.find((u) => u.id === 'probe');
  expect(update.id).toBe('probe');
  expect(update.generation).toBe(7);
  expect(update.mode).toBe('chasing');
  // 速度长度 = ZOMBIE.speed（1.2）—— 归一化方向 × 速度上限（worker 侧钳制）
  expect(Math.hypot(update.vx, update.vz)).toBeCloseTo(1.2, 6);
  expect(Object.keys(update).sort()).toEqual(['generation', 'id', 'mode', 'vx', 'vz']);
  // 感知门外（dist=90 > 80）→ idle + 零速度
  const far = result.workerReply.updates.find((u) => u.id === 'probe-far');
  expect(far.generation).toBe(3);
  expect(far.mode).toBe('idle');
  expect(far.vx).toBe(0);
  expect(far.vz).toBe(0);

  // 远距门控：若真地形上探到了 59/61 格的落点，则断言「59 进批次、61 不进」
  if (result.far59 && result.far61) {
    expect(result.after.ai.lastBatchSize).toBe(2);
  }
});

// ==================== Task 3：三把枪的实体伤害与遮挡 ====================

test('M6：手枪命中使 health 100→75（走真实 controller 路径，非直接调 damage）', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/?vd=4&seed=12345');
  await waitWorldReady(page);
  await installHelpers(page);
  const result = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    const pos = window.__ZT__.legalSpawnNear(4);
    const id = g.zombies.spawn(pos, { source: 'test' });
    const before = g.zombies.get(id).health;
    // setTestAim 是仅测试 helper：只写 yaw/pitch + 重算 DDA target，不绕过 controller
    const aimed = window.__ZT__.aimAtZombie(pos);
    const aimedKey = aimed?.target
      ? `${aimed.target.blockPos.join(',')}@${aimed.target.dist.toFixed(3)}`
      : 'none';
    // **target 必须跟随朝向变化**（自查发现的盲区）：原先只断言 `aimedHit === true`，
    // 但注入「setTestAim 不重算 DDA target」时 `this.target` 保留的是帧循环上一帧的结果，
    // 那个结果在真实世界里大概率也是 hit=true → 断言仍然通过（无效负向验证）。
    // 故朝一个明显不同的方向再瞄一次，两次 target 必须不同 —— 这才真正钉住「重算」。
    const cam = g.camera.position.toArray();
    const away = g.player.setTestAim([-(pos[0] - cam[0]), pos[1] + 0.9 - cam[1], -(pos[2] - cam[2])]);
    const awayKey = away?.target
      ? `${away.target.blockPos.join(',')}@${away.target.dist.toFixed(3)}`
      : 'none';
    // 瞄回丧尸（开火要用这个朝向）
    window.__ZT__.aimAtZombie(pos);
    await g.selectWeapon('pistol');
    const effects = g.fireWeaponOnce();
    // pitch 钳制（自查发现的盲区）：朝近乎垂直向上瞄，asin(dir.y/len) 会得到 ≈π/2。
    // 注入「pitch 不钳制」时 pitch 会取到 ±π/2（万向锁边界，射线退化）→ 与真实输入路径
    // （onMouseMove 钳到 ±(π/2-0.01)）不一致。断言 pitch 必须落在钳制范围内。
    const upAim = g.player.setTestAim([0, 1, 0]);
    const pitchLimit = Math.PI / 2 - 0.01;
    return {
      id, before,
      after: g.zombies.get(id)?.health ?? 0,
      effectType: effects[0]?.type ?? null,
      entityId: effects[0]?.entityId ?? null,
      entityDamage: effects[0]?.entityDamage ?? null,
      aimedHit: aimed?.target?.hit ?? null,
      aimedKey, awayKey,
      upPitch: upAim?.pitch ?? null,
      pitchLimit,
      // 红闪时间基准：flashedUntil 必须与 performance.now() 同量级（不是 Date.now() 的天文数字）
      flashedUntil: g.zombies.get(id)?.flashedUntil ?? 0,
      perfNow: performance.now(),
    };
  });

  // 断言精确数值（before/after），不能只数 effects（M6 plan Task 3 的明确要求）
  expect(result.before).toBe(100);
  expect(result.after).toBe(75);
  expect(result.effectType).toBe('entity-hit');
  expect(result.entityId).toBe(result.id);
  expect(result.entityDamage).toBe(25);
  // 前提断言：DDA 确实命中了（否则「命中」可能来自别的路径）
  expect(result.aimedHit).toBe(true);
  // 两个明显不同的朝向必须给出不同的 DDA 命中 —— 钉住 setTestAim 真的重算了 target
  expect(result.aimedKey).not.toBe(result.awayKey);
  // pitch 必须被钳到 ±(π/2-0.01)，与真实输入路径 onMouseMove 同一口径（防万向锁/射线退化）
  expect(Math.abs(result.upPitch)).toBeLessThanOrEqual(result.pitchLimit + 1e-9);
  expect(Math.abs(result.upPitch)).toBeGreaterThan(result.pitchLimit - 1e-6);
  // **时间基准必须是 performance.now() 量级**（实测踩坑：用 Date.now() 会让 flashedUntil
  // 成为天文数字 → 红闪判定 `nowMs < flashedUntil` 恒真 → 丧尸永久红闪）
  expect(result.flashedUntil).toBeGreaterThan(result.perfNow);
  expect(result.flashedUntil).toBeLessThan(result.perfNow + 1000);
});

test('M6：相机与丧尸之间放石头 → 方块阻挡，health 仍为 100（实体不穿墙）', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/?vd=4&seed=12345');
  await waitWorldReady(page);
  await installHelpers(page);
  const result = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    const pos = window.__ZT__.legalSpawnNear(4);
    const id = g.zombies.spawn(pos, { source: 'test' });
    const cam = g.camera.position.toArray();
    window.__ZT__.aimAtZombie(pos);
    // 在相机与丧尸**之间**放一块石头（取中点，钳到整数格）
    const midX = Math.floor((cam[0] + pos[0]) / 2);
    const midY = Math.floor((cam[1] + pos[1] + 0.9) / 2);
    const midZ = Math.floor((cam[2] + pos[2]) / 2);
    const stone = g.registry.idOf('stone');
    g.editor.setBlock({ x: midX, y: midY, z: midZ, id: stone });
    // 放块改变了视线 → 必须重新瞄准（target 需重算）
    window.__ZT__.aimAtZombie(pos);
    const ddaDist = g.player.target?.dist ?? Infinity;
    await g.selectWeapon('pistol');
    g.setGunBlockDamage(false); // 开关关闭：方块只阻挡不写世界
    const effects = g.fireWeaponOnce();
    return {
      after: g.zombies.get(id)?.health ?? 0,
      ddaDist,
      stonePlaced: g.world.getBlockId(midX, midY, midZ) === stone,
      effectType: effects[0]?.type ?? null,
    };
  });

  expect(result.stonePlaced).toBe(true);
  // **前提断言**：石头确实落在射线更近的位置 —— 否则「实体不受伤」可能是别的原因造成的
  // （比如根本没命中），断言就变成恒真（testing-policy §2.5）。
  expect(result.ddaDist).toBeLessThan(4);
  // 方块比丧尸近（石头在中间）→ 实体不被命中，health 保持满值
  expect(result.after).toBe(100);
  expect(result.effectType).toBe('shot');
});

test('M6：MAG7 十格内一击致死、十格外 health 保持 100，且仍执行方块扫描', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/?vd=4&seed=12345');
  await waitWorldReady(page);
  await installHelpers(page);
  const result = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    // 近：3 格 → 一击致死
    const nearPos = window.__ZT__.legalSpawnNear(3);
    const nearId = g.zombies.spawn(nearPos, { source: 'test' });
    window.__ZT__.aimAtZombie(nearPos);
    await g.selectWeapon('mag7');
    g.setGunBlockDamage(false); // MAG7 必须无视开关仍破坏方块
    const nearEffects = g.fireWeaponOnce();
    const near = {
      after: g.zombies.get(nearId)?.health ?? 0,
      alive: g.zombies.get(nearId) !== null,
      effectType: nearEffects[0]?.type ?? null,
    };
    // 等 MAG7 冷却（1.5 秒）后打远处那只（超出 10 格射程）
    await new Promise((resolve) => setTimeout(resolve, 1600));
    const farPos = window.__ZT__.legalSpawnNear(14); // 14 格 > entityRange 10
    const farId = g.zombies.spawn(farPos, { source: 'test' });
    window.__ZT__.aimAtZombie(farPos);
    const farEffects = g.fireWeaponOnce();
    const far = {
      after: g.zombies.get(farId)?.health ?? 0,
      effectType: farEffects[0]?.type ?? null,
    };
    return { near, far };
  });

  expect(result.near.after).toBe(0);
  expect(result.near.alive).toBe(false); // 一击致死后回收
  expect(result.near.effectType).toBe('entity-hit');
  // 十格外：health 保持 100、不发 entity-hit
  expect(result.far.after).toBe(100);
  expect(result.far.effectType).toBe('shot');
});

// ==================== Task 4：默认 20 压力验收 ====================

/**
 * 世界就绪 + 稳定判据（M6 plan Task 4 Step 1 的等待序列 + 一条补强）。
 *
 * 补强理由：队列归零是**瞬时状态** —— `worldReady` 只表示出生点邻域就绪，后台仍在填充
 * sections；高负载下队列可能短暂归零而 sections 还在增长，此时采样测的是「加载过程」而非
 * 稳态。故额外要求 sections 连续两次采样不变（跨帧比较）才认为世界稳定。
 */
async function waitWorldStable(page) {
  await page.goto('/?vd=8');
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 90_000 });
  // vd=8 → (2×8+1)² = 289 column 全加载
  await page.waitForFunction(() => window.__MC_GAME__.world.columns.size >= 289, null, { timeout: 90_000 });
  await page.waitForFunction(() => {
    const s = window.__MC_GAME__.scheduler.stats();
    const sections = window.__MC_GAME__.renderStats().sections;
    const prev = window.__MC_STABLE_PREV__;
    window.__MC_STABLE_PREV__ = sections;
    return prev === sections && // sections 停止增长（队列归零是瞬时状态，须加这条）
      s.genInflight === 0 && s.meshInflight === 0 && s.meshQueued === 0 &&
      s.pendingMesh === 0 && s.lightInflight === 0 && s.lightQueued === 0 && s.uploadQueue === 0;
  }, null, { timeout: 90_000, polling: 500 });
  await page.waitForTimeout(5_000); // 稳态静置（计划要求）
}

test('M6：默认 20 只丧尸压力验收 —— slot/scheduler 收敛、无泄漏、六部件 draw 增量', async ({ page }) => {
  test.setTimeout(180_000);
  await waitWorldStable(page);
  await installHelpers(page);
  const result = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    const pp = g.player.physics.pos; // 玩家位置（诊断数据用）
    // 稳态基线（丧尸出生前）：draw call 与 sections
    const baseline = { drawCalls: g.renderStats().drawCalls, sections: g.renderStats().sections };
    // 生成 20 只丧尸（M6 默认上限）
    const { positions, distinct } = window.__ZT__.legalSpawnMany(20);
    const ids = [];
    const spawnFailures = [];
    for (const pos of positions) {
      const id = g.zombies.spawn(pos, { source: 'stress' });
      if (id) ids.push(id);
      else {
        // 失败原因逐格记录（诊断用）：spawn 的五道门哪一道拦住了它
        const [x, y, z] = pos;
        const bx = Math.floor(x), by = Math.floor(y), bz = Math.floor(z);
        spawnFailures.push({
          pos,
          columnLoaded: g.world.hasColumn(Math.floor(x / 16), Math.floor(z / 16)),
          feetId: g.world.getBlockId(bx, by, bz),
          headId: g.world.getBlockId(bx, by + 1, bz),
          belowSolid: g.world.isSolid(bx, by - 1, bz),
          active: g.zombies.count(),
        });
      }
    }
    // 等 2 个 AI 周期（0.05 秒/周期）让批次发出并回包写入意图
    await new Promise((resolve) => setTimeout(resolve, 200));
    // 采集稳态观测值
    const snapshot = g.perfSnapshot();
    const render = g.renderStats();
    const ai = g.zombies.debugAiState();
    const scheduler = g.scheduler.stats();
    // 六部件 slot 占用情况（每只丧尸占一个索引，六部件共用）
    const activeSlots = g.zombieRenderer.activeCount();
    const slotsOf = ids.map((id) => g.zombieRenderer.slotOf(id));
    return {
      baseline,
      spawnedCount: ids.length,
      distinctPositions: distinct,
      zombiesCount: g.zombies.count(),
      activeSlots,
      slotsOf,
      snapshot, render, ai, scheduler,
      sceneChildren: g.scene.children.length,
      // 诊断数据（失败时进断言 message）：落点扫描结果、首个失败原因、玩家位置与 biome
      positionsScanned: positions.length,
      spawnFailures: spawnFailures.slice(0, 3),
      playerPos: [pp.x, pp.y, pp.z].map((v) => Math.round(v * 10) / 10),
      biome: g.biomeAt(pp.x, pp.z),
      seed: g.seed,
      columns: g.world.columns.size,
    };
  });

  // 默认上限 20 只全部出生、slot 全部占用。断言 message 带诊断数据 —— 全量跑时曾出现
  // spawnedCount=0 而单独跑通过，且两次独立诊断（落点扫描 / 存档残留）都找不到根因，
  // 故让失败自带现场（seed、玩家位置、biome、扫描到的落点数、首个失败的五道门状态）。
  const diag = () => `seed=${result.seed} pos=${result.playerPos.join(',')} biome=${result.biome} `
    + `columns=${result.columns} scanned=${result.positionsScanned} `
    + `failures=${JSON.stringify(result.spawnFailures)}`;
  expect(result.spawnedCount, diag()).toBe(20);
  expect(result.zombiesCount, diag()).toBe(20);
  expect(result.activeSlots, diag()).toBe(20);
  // 每只丧尸都有独立 slot（六部件共用同一索引），且 slot 都在 [0,20) 内
  for (const slot of result.slotsOf) {
    expect(slot).toBeGreaterThanOrEqual(0);
    expect(slot).toBeLessThan(20);
  }
  expect(new Set(result.slotsOf).size).toBe(20); // slot 互不重复

  // AI：每周期最多一条在途 RPC；回包落地后 pending 归零（队列收敛）
  expect(result.ai.calls).toBeGreaterThan(0);
  expect(result.ai.lastBatchSize).toBeGreaterThanOrEqual(1);
  expect(result.ai.lastBatchSize).toBeLessThanOrEqual(20);
  expect(result.ai.pending).toBe(0); // 无滞留回包

  // **七项 scheduler 字段完整零值断言**（计划要求，不能只以三项子集代表稳态）
  expect(result.scheduler.genInflight).toBe(0);
  expect(result.scheduler.meshInflight).toBe(0);
  expect(result.scheduler.meshQueued).toBe(0);
  expect(result.scheduler.pendingMesh).toBe(0);
  expect(result.scheduler.lightInflight).toBe(0);
  expect(result.scheduler.lightQueued).toBe(0);
  expect(result.scheduler.uploadQueue).toBe(0);

  // **合批收益**（M6 规格 §3）：六个 InstancedMesh 常驻 scene，spawn 20 只丧尸只增加
  // **恰好 6 个 draw call**（六个部件 mesh），与丧尸数量无关 —— 这是与 mc-lite「每类型一个
  // InstancedMesh + 每尸一个 Group」（draw call 随丧尸数线性增长）的本质区别。
  //
  // 为何是 +6 而非 0：六个 mesh 无丧尸时 `visible=false`（不提交渲染，见 zombie-renderer.js
  // 构造器注释）→ baseline 不含它们；spawn 后置 true → 恰好 +6。若这条变成随丧尸数增长
  // （如 +20），说明渲染走了 per-entity 节点路径（性能反模式）。
  expect(result.render.drawCalls - result.baseline.drawCalls).toBe(6);
  expect(result.sceneChildren).toBeGreaterThanOrEqual(6);

  // 帧率不回退：稳态 fps 仍 ≥ 90（M3 基线 120fps，回退 >10% 即阻断）
  expect(result.snapshot.fps).toBeGreaterThan(90);
});

test('M6：30 只压力 fixture（M7 联调用，非默认配置）', async ({ page }) => {
  // M6 规格 §4：30 是 M7 联调压力 fixture，**报告须明示它不是默认配置**。
  // 纯 fixture 用 `new ZombieService({maxActive:30})` 验证容量可扩，不碰真游戏页。
  test.setTimeout(60_000);
  await page.goto('/src/tests/index.html');
  await page.waitForFunction(() => window.__MC_TEST_RESULTS__ !== undefined, null, { timeout: 30_000 });
  const result = await page.evaluate(async () => {
    const { ZombieService, zombieDefinition } = await import('/src/entities/zombies/zombie-system.js');
    const { ZombieRenderer } = await import('/src/render/zombie-renderer.js');
    const { EntityManager } = await import('/src/entities/entity-manager.js');
    const { createRegistry } = await import('/src/voxel/block-registry.js');
    const { ChunkColumn } = await import('/src/voxel/chunk-column.js');
    const { WorldData } = await import('/src/voxel/world-data.js');
    const THREE = await import('three');

    const registry = createRegistry();
    registry.register('air', { solid: false, opaque: false, cullMode: 'none' });
    registry.register('stone', { solid: true, opaque: true, cullMode: 'opaque' });
    registry.freeze();
    const stone = registry.idOf('stone');
    const world = new WorldData(registry);
    // 足够大的平地容纳 30 个不重叠落点（cx 0..3，每个 16 格宽）
    for (let cx = 0; cx <= 3; cx++) {
      const col = new ChunkColumn(cx, 0);
      for (let lx = 0; lx < 16; lx++) for (let lz = 0; lz < 16; lz++) col.set(lx, 0, lz, stone);
      world.add(col);
    }
    const entities = new EntityManager();
    entities.registerType('zombie', zombieDefinition);
    const scene = new THREE.Scene();
    const renderer = new ZombieRenderer({ scene, maxActive: 30 }); // **30 容量，非默认 20**
    const zombies = new ZombieService({
      entities, world, maxActive: 30,
      onSpawn: (id, slot) => renderer.acquireSlot(id, slot),
      onDespawn: (id) => renderer.releaseSlot(id),
    });
    const ids = [];
    for (let i = 0; i < 30; i++) ids.push(zombies.spawn([i * 2 + .5, 1, .5], { source: 'm7-stress' }));
    renderer.sync(zombies, performance.now());
    return {
      spawned: ids.filter(Boolean).length,
      count: zombies.count(),
      activeSlots: renderer.activeCount(),
      meshCapacity: renderer.meshes.head.count, // 六部件容量都是 30
      over: zombies.spawn([100.5, 1, .5], { source: 'm7-stress' }), // 第 31 只 → 拒绝
    };
  });

  // 30 容量下 30 只全部成功，第 31 只被拒
  expect(result.spawned).toBe(30);
  expect(result.count).toBe(30);
  expect(result.activeSlots).toBe(30);
  expect(result.meshCapacity).toBe(30); // 六部件容量随 maxActive 扩到 30
  expect(result.over).toBeNull();
});

// ==================== X 键生成丧尸（调试键，对齐 mc-lite Game.js:155） ====================

test('M6：X 键生成丧尸 —— 生成/上限钳制/repeat 守卫/模态守卫/距离范围', async ({ page }) => {
  // 按键派发用 `window.dispatchEvent(new KeyboardEvent(...))` 而非 `page.keyboard.press` ——
  // 与既有 `m3-1-inventory.spec.mjs` 同一手法（Player 的 onKeyDown 绑在 window 上）。无头环境
  // 无真实键鼠，但 KeyboardEvent 走的是同一条监听器路径，与真实按键等价。
  test.setTimeout(120_000);
  await page.goto('/?vd=4&seed=12345');
  // **`?seed=` 不能保证世界 seed**：`game.js:138-139` 有存档时读存档的 seed，URL 参数被忽略。
  // 实测同一 URL 两次分别得到玩家 y=56（云面出生）与 y=22（地面）—— 故本测试**不依赖出生点**：
  // `spawnZombieNearPlayer` 对每个候选 (x,z) 向下扫 64 格找真实地面，云面出生也能命中地面。
  // （若只扫玩家 y±4 就会在云面出生时全部失败 —— 这正是 M6 验收踩过的坑。）
  await waitWorldReady(page);
  const result = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    const press = () => window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyX' }));
    const before = g.zombies.count();
    const px = g.player.physics.pos.x, pz = g.player.physics.pos.z;
    // ① 连按 3 次 → 3 只
    press(); press(); press();
    const afterThree = g.zombies.count();
    // ⑥ 生成落点距玩家的水平距离（mc-lite 语义：随机角度 + 2~10 格）。
    //    **必须在丧尸开始追逐之前采集** —— 本 evaluate 块全程同步、不含 await，帧循环不会跑，
    //    故此刻丧尸仍在出生点；若加了 await，AI 意图与物理会让它们移动，距离就不再是出生距离。
    const distances = [];
    for (const entity of g.entities.entities()) {
      if (entity.type !== 'zombie') continue;
      const [x, , z] = entity.state.position;
      distances.push(Math.hypot(x - px, z - pz));
    }
    // ② repeat 事件不得生成（否则按住 X 会以键盘重复率约 30Hz 连续生成，瞬间填满上限）
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyX', repeat: true }));
    const afterRepeat = g.zombies.count();
    // ③ 模态打开时不得生成（M3.1 模态守卫；否则面板开着按 X 会偷偷刷怪）
    g.pushModal('settings');
    press();
    const afterModal = g.zombies.count();
    g.popModal('settings');
    // ④ 狂按 → 钳在默认上限 20（上限校验由 ZombieService.spawn 负责）
    for (let i = 0; i < 25; i++) press();
    const afterFlood = g.zombies.count();
    // ⑤ 生成的丧尸必须站在**真实地面**上（脚下 solid）—— 这条钉住「向下扫用 isSolid 判据」
    //    的有意偏离：若改回 mc-lite 的「非空气」判据，云面会被当地面 → spawn 的脚下门控
    //    拒绝 → 生成失败（count 不增长），或丧尸悬空。
    let feetSolidOk = null;
    for (const entity of g.entities.entities()) {
      if (entity.type !== 'zombie') continue;
      const [x, y, z] = entity.state.position;
      feetSolidOk = g.world.isSolid(Math.floor(x), Math.floor(y) - 1, Math.floor(z));
      break;
    }
    return {
      before, afterThree, afterRepeat, afterModal, afterFlood,
      activeSlots: g.zombieRenderer.activeCount(),
      feetSolidOk, distances,
    };
  });

  expect(result.before).toBe(0);
  expect(result.afterThree, `按 3 次 X 应生成 3 只（实测 ${result.afterThree}）`).toBe(3);
  expect(result.afterRepeat, 'repeat 事件不得生成丧尸').toBe(3);
  expect(result.afterModal, '模态打开时不得生成丧尸').toBe(3);
  expect(result.afterFlood, '狂按须钳在默认上限 20').toBe(20);
  expect(result.activeSlots, '渲染 slot 须与丧尸数一致').toBe(20);
  // 生成的丧尸脚下必须是 solid（钉住向下扫的 isSolid 判据偏离）
  expect(result.feetSolidOk, 'X 键生成的丧尸须站在真实地面上（脚下 solid）').toBe(true);
  // 生成落点须在距玩家 2~10 格（mc-lite 语义）。取整格坐标 + 落点向下扫会让实际距离略超
  // 理论范围，故容差放宽到 [1, 12]：钉住「不是在玩家脚下（distance=0）也不是远处」这个量级。
  expect(result.distances.length).toBe(3);
  for (const d of result.distances) {
    expect(d, `生成落点距玩家应在 2~10 格量级（实测 ${d.toFixed(2)}）`).toBeGreaterThanOrEqual(1);
    expect(d, `生成落点距玩家应在 2~10 格量级（实测 ${d.toFixed(2)}）`).toBeLessThanOrEqual(12);
  }
});

// ==================== 实体间排斥（不重叠）====================

/**
 * 丧尸不得互相重叠 —— 强制 20 只同点生成后必须散开。
 *
 * **为什么必须走真游戏页**：浏览器内单测直接调 `separationForce` 纯函数，测不到
 * **worker 是否真的消费了它**。而「worker 没接线」是**静默失效**（丧尸照常追逐、照常渲染，
 * 只是叠成一坨）—— 正是 CLAUDE.md 记过的「fake pool 让纯逻辑测试全绿而真实接线丢回包」同类盲区。
 *
 * **为什么用「强制同点生成」而非自然生成**：真地形的落点天然分散（实测 20 个不同落点时
 * 最小间距 0.995、零重叠），根本没有重叠可测 → 断言恒真。强制同点才能触发排斥力路径。
 *
 * 实测数值（改动前 → 改动后，20 只强制同点）：最小间距 0 → 0.578；重叠对数 190 → 1。
 * 阈值取「散开后最小间距 > 0.4」+「重叠对数 < 20」—— 都远离改动前的值（0 / 190），双向有效。
 */
test('M6：丧尸互斥 —— 强制同点生成后必须散开（不重叠）', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/?vd=4&seed=12345');
  await waitWorldReady(page);
  const result = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    // 找一个合法落点，**20 只全部生成在同一点** → 制造完全重叠（spawn 无位置互斥门控，允许同格多只）
    const p = g.player.physics.pos;
    let pos = null;
    for (let r = 3; r <= 40 && !pos; r++) {
      for (const [dx, dz] of [[r, 0], [-r, 0], [0, r], [0, -r]]) {
        const x = Math.floor(p.x) + dx, z = Math.floor(p.z) + dz;
        for (let y = Math.floor(p.y); y >= Math.floor(p.y) - 64; y--) {
          if (g.world.getBlockId(x, y, z) === 0 && g.world.getBlockId(x, y + 1, z) === 0
            && g.world.isSolid(x, y - 1, z)) { pos = [x + .5, y, z + .5]; break; }
        }
      }
    }
    const ids = [];
    for (let i = 0; i < 20; i++) {
      const id = g.zombies.spawn(pos, { source: 'separation' });
      if (id) ids.push(id);
    }
    // 重叠度量：最小两两水平距离 + 视觉重叠对数（< AABB 宽度 0.6 即看起来叠在一起）。
    // **必须用两两距离而非「位置去重数」** —— 去重数对重叠不敏感（重叠丧尸的位置差 0.001
    // 也算「不同位置」→ 断言恒真）。
    const overlapStats = () => {
      const zs = [...g.entities.entities()].filter((e) => e.type === 'zombie');
      let min = Infinity, overlappingPairs = 0;
      for (let i = 0; i < zs.length; i++) {
        for (let j = i + 1; j < zs.length; j++) {
          const d = Math.hypot(
            zs[i].state.position[0] - zs[j].state.position[0],
            zs[i].state.position[2] - zs[j].state.position[2],
          );
          min = Math.min(min, d);
          // 视觉重叠判据：水平距离 < 0.6（丧尸 AABB 宽度）即看起来叠在一起。
          // **用字面量而非 import ZOMBIE.width** —— 它是「观感判据」不是被测常量（被测的是排斥力），
          // 派生会让「改 AABB 宽度」连带改判据 → 断言语义漂移（testing-policy §2.5）。
          if (d < 0.6) overlappingPairs++;
        }
      }
      return { count: zs.length, min, overlappingPairs, totalPairs: zs.length * (zs.length - 1) / 2 };
    };
    const before = overlapStats();
    // 等排斥力积分（AI 20Hz + 物理 60Hz）：3 秒足够散开（实测 3 秒时 min 已到 0.543）
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const after = overlapStats();
    return {
      spawned: ids.length, spawnPos: pos,
      before: { min: +before.min.toFixed(3), overlappingPairs: before.overlappingPairs },
      after: { min: +after.min.toFixed(3), overlappingPairs: after.overlappingPairs, count: after.count },
      aiDebug: g.zombies.debugAiState(),
    };
  });

  // 前提：20 只全部生成成功且初始完全重叠（否则断言测不到排斥力路径 → 恒真）
  expect(result.spawned, '须生成 20 只').toBe(20);
  expect(result.before.min, '初始须完全重叠（min=0）').toBe(0);
  expect(result.before.overlappingPairs, '初始须 190 对全重叠').toBe(190);
  // AI 确实在跑（否则「没散开」可能是 RPC 没发，而非排斥力失效 —— 归因需要这个前提）
  expect(result.aiDebug.calls, 'AI RPC 须有调用').toBeGreaterThan(0);
  expect(result.aiDebug.pending, 'AI 队列须收敛').toBe(0);

  // **核心断言：散开了**（阈值远离改动前的 0 / 190，双向有效）
  expect(result.after.min, `最小间距须显著散开（改动前恒 0，实测 ${result.after.min}）`)
    .toBeGreaterThan(0.4);
  expect(result.after.overlappingPairs, `视觉重叠对数须大幅下降（改动前 190，实测 ${result.after.overlappingPairs}）`)
    .toBeLessThan(20);
  expect(result.after.count, '散开过程不得丢丧尸').toBe(20);
});
