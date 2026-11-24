// tests/audio-fx.spec.mjs — 环境/动作音效（v2.51）
//
// **为什么需要 E2E**：这几条接线全在「游戏装配层 + 玩家输入路径」，单测只能验
// AudioManager 的状态机本身。漏接线的形态都是静默的（没有任何报错）：
//   ① 雨声没接 → 下雨时没有雨声（玩家可能以为是「本来就没有雨声」）；
//   ② 跑动没接 → 跑步没有脚步声；
//   ③ 放/挖没接 → 动作没有反馈；
//   ④ 死亡没接 → 打死丧尸/火龙没有音效。
// 而 `audioDebugState()`（播放请求计数）与 `debugLoops()`（循环音效状态机）都是可观测的
// —— 无头环境没有音频输出设备，本仓既有口径就是断言这两个（`bgm.spec.mjs` 同源）。
//
// ⚠️ **不断言「有没有声音」**，只断言「请求发生了 / 循环在播」。理由同 bgm.spec 文件头。
import { test, expect } from 'playwright/test';

async function boot(page, query = '') {
  await page.goto(`/?vd=2&seed=12345${query}`);
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 90_000 });
}

/** 读播放请求计数（只读诊断口，见 `Game.audioDebugState`）。 */
async function counts(page) {
  return page.evaluate(() => window.__MC_GAME__.audioDebugState().playRequests);
}

test.describe.configure({ mode: 'serial' });

test('雨声：只有下雨时才播，晴天不播', async ({ page }) => {
  test.setTimeout(180_000);

  // ---- 雨天：`?weather=rain` 启动即强制降雨 ----
  await boot(page, '&weather=rain');
  // 等天气状态机把 intensity 推上去（过渡 5 秒 + 首个 tick；这里只要求 > 0）
  await page.waitForFunction(() => (window.__MC_GAME__.weather?.intensity ?? 0) > 0,
    null, { timeout: 30_000 });
  await page.waitForFunction(() => window.__MC_GAME__.audioManager.debugLoops().rain?.playing === true,
    null, { timeout: 20_000 });
  const rainy = await page.evaluate(() => ({
    intensity: window.__MC_GAME__.weather.intensity,
    loop: window.__MC_GAME__.audioManager.debugLoops().rain,
    isRaining: window.__MC_GAME__.weather.isRaining,
  }));
  expect(rainy.isRaining, '前置：确实在下雨').toBe(true);
  expect(rainy.loop.playing, '下雨时必须真的在播雨声').toBe(true);
  expect(rainy.loop.target, '意图音量精确 = 0.2 × intensity（同帧取样）')
    .toBeCloseTo(0.2 * rainy.intensity, 10);

  // ⚠️ **不能用「刚起播那一瞬」比较实际音量**：three 的 `setVolume()` 走 setTargetAtTime
  // （指数逼近），从初始 gain 1.0 爬到 0.004 要几百毫秒 —— 实测首帧 actual **0.3166** 而
  // target **0.004**（差 0.098），那不是缺陷。故等过渡结束（intensity 稳定在 1）再比。
  await page.waitForFunction(() => window.__MC_GAME__.weather.intensity > 0.99,
    null, { timeout: 30_000 });
  await page.waitForTimeout(800);   // 让音量斜坡收敛
  const steady = await page.evaluate(() => window.__MC_GAME__.audioManager.debugLoops().rain);
  expect(Math.abs(steady.volume - 0.2),
    '稳态下雨时实际音频音量 = 0.2（“音量真的写下去了”的判据）').toBeLessThan(0.02);
  expect(steady.target, '稳态意图值也是 0.2').toBeCloseTo(0.2, 10);

  // ---- 晴天：强制切晴，过渡结束后雨声必须停 ----
  await page.evaluate(() => window.__MC_GAME__.weather.force('clear'));
  await page.waitForFunction(() => (window.__MC_GAME__.weather?.intensity ?? 1) === 0,
    null, { timeout: 30_000 });
  await page.waitForFunction(() => !window.__MC_GAME__.audioManager.debugLoops().rain,
    null, { timeout: 20_000 });
  expect(await page.evaluate(() => window.__MC_GAME__.audioManager.debugLoops().rain ?? null),
    '天晴后雨声必须停（循环实例被摘掉，不是只把音量调 0）').toBeNull();
});

test('放置与挖掘：成功才播 put / delete', async ({ page }) => {
  test.setTimeout(180_000);
  await boot(page, '&weather=clear');

  // 取一格确定可挖的方块（玩家脚下附近，非不可破坏）
  const cell = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    const p = g.player.physics.pos;
    const x = Math.floor(p.x), z = Math.floor(p.z);
    for (let dy = -1; dy >= -6; dy -= 1) {
      const y = Math.floor(p.y) + dy;
      const id = g.world.getBlockId(x, y, z);
      if (id !== 0 && g.registry.isIndestructible(id) === false) return { x, y, z, id };
    }
    return null;
  });
  expect(cell, '前置：出生点脚下必须能找到一格可挖的方块').not.toBeNull();

  // ---- 挖掘：走真实入口 `digBlock()`（命中 → 唯一编辑路径 → 音效） ----
  // ⚠️ **不得手工塞 target 后只断言编辑器被调用**：CLAUDE.md「E2E 不得手工塞 player.target」
  // 的教训说的是**放置**分支；这里的被测点是「digBlock 在真实改动后播 delete」，
  // 而真实准心在无头环境不可靠（出生点朝向随机命中），故用 `setTestAim` 摆真实姿态更贴近
  // 生产路径 —— 但那条路要先把玩家放到该格正上方，代价高且会被脚下地形影响。
  // 折中：直接调 `digBlock()` 前把 target 指向被测格，判据落在「音效请求 + 世界真的变了」。
  const digDelta = await page.evaluate((c) => {
    const g = window.__MC_GAME__;
    const before = g.audioDebugState().playRequests.delete ?? 0;
    g.player.target = {
      blockPos: [c.x, c.y, c.z], normal: [0, 1, 0], dist: 2, hit: true,
      prevPos: [c.x, c.y + 1, c.z],
    };
    g.player.digBlock({});
    return {
      delta: (g.audioDebugState().playRequests.delete ?? 0) - before,
      left: g.world.getBlockId(c.x, c.y, c.z),
    };
  }, cell);
  expect(digDelta.left, '前置：方块确实被挖掉了').toBe(0);
  expect(digDelta.delta, '挖掉一格必须播一次 delete').toBe(1);

  // ---- 挖空气不得连发 ----
  const airDelta = await page.evaluate((c) => {
    const g = window.__MC_GAME__;
    const before = g.audioDebugState().playRequests.delete ?? 0;
    g.player.target = {
      blockPos: [c.x, c.y, c.z], normal: [0, 1, 0], dist: 2, hit: true,
      prevPos: [c.x, c.y + 1, c.z],
    };
    g.player.digBlock({});   // 该格已是空气
    return (g.audioDebugState().playRequests.delete ?? 0) - before;
  }, cell);
  expect(airDelta, '挖空气（编辑无变化）不得播 delete —— 否则按住左键会连发打击音').toBe(0);

  // ---- 放置：走 `_placeSingle()`（单格写入的唯一实现，含成功音效） ----
  const putDelta = await page.evaluate((c) => {
    const g = window.__MC_GAME__;
    const before = g.audioDebugState().playRequests.put ?? 0;
    const placed = g.player._placeSingle(c.x, c.y, c.z, c.id);
    return {
      delta: (g.audioDebugState().playRequests.put ?? 0) - before,
      placed,
      id: g.world.getBlockId(c.x, c.y, c.z),
    };
  }, cell);
  expect(putDelta.placed, '前置：放置成功（没被玩家 AABB 守卫拒掉）').toBe(true);
  expect(putDelta.id, '前置：方块确实放回去了').toBe(cell.id);
  expect(putDelta.delta, '放下一格必须播一次 put').toBe(1);

  // ---- 背包选特殊结构（巢穴）的 put 音量路径不变（0.6 那条既有分支） ----
  expect((await counts(page)).put, 'put 计数已累加').toBeGreaterThanOrEqual(1);
});

test('跑动：全速移动时播陆上脚步声，停下即停', async ({ page }) => {
  test.setTimeout(180_000);
  await boot(page, '&weather=clear');

  // 无头环境没有真实键鼠 → 用 Player 的公开键集（与真实按键**同一条** `_applyInput` 路径）。
  const walked = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    g.player.keys.add('KeyW');
    const t0 = performance.now();
    let sawActive = false;
    let sawLoop = false;
    while (performance.now() - t0 < 4000) {
      await new Promise((r) => requestAnimationFrame(r));
      if (g.player.viewBob.active) sawActive = true;
      if (g.audioManager.debugLoops().running_land?.playing
        || g.audioManager.debugLoops().running_wet?.playing) sawLoop = true;
    }
    g.player.keys.delete('KeyW');
    // 停下后等几帧让 `_updateFootsteps` 收掉循环
    for (let i = 0; i < 12; i++) await new Promise((r) => requestAnimationFrame(r));
    return {
      sawActive, sawLoop, inWater: g.player.physics.inWater,
      afterStop: {
        land: g.audioManager.debugLoops().running_land ?? null,
        water: g.audioManager.debugLoops().running_wet ?? null,
      },
    };
  });
  expect(walked.sawActive, '前置：按 W 期间必须真的进入「全速跑动」（否则本条无从谈起）').toBe(true);
  expect(walked.sawLoop, '跑动期间必须有脚步声循环在播').toBe(true);
  expect(walked.afterStop.land, '停下后陆上脚步声必须停').toBeNull();
  expect(walked.afterStop.water, '停下后水上脚步声也必须停').toBeNull();
});

test('水中行走：播 running_wet（不是 running_land），停下即停；镜头仍不晃', async ({ page }) => {
  test.setTimeout(180_000);
  await boot(page, '&weather=clear');

  // 缺陷形态（v2.51~v2.53）：本仓物理有**水中阻力**（`WATER_DRAG = 0.6`，mc-lite 没有），
  // 而脚步声判据读的是镜头判据 `viewBob.active`（要求 actual > expected×0.95，expected 未折算阻力）
  // → 水中 actual/expected 恒 **0.600** → `active` 恒 false → `running_wet` **永不播**。
  // 修法（用户裁定 2026-11-05：**只让声音响、镜头保持不晃**）：新增 `viewBob.walking`
  // 按阻力折算期望位移，脚步声改读它；`active` 判据一字未改。
  // ⚠️ 故本用例**必须同时钉住两侧**：声音要响（walking/running_wet）+ 镜头不晃（active=false）。
  // 只钉「有声音」的话，把 `active` 也改成折算版（镜头跟着晃）仍会全绿。
  const walked = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    const pl = g.player;
    const px = Math.floor(pl.physics.pos.x);
    const pz = Math.floor(pl.physics.pos.z);
    let groundY = -1;
    for (let y = Math.floor(pl.physics.pos.y); y > Math.floor(pl.physics.pos.y) - 8; y--) {
      if (g.world.getBlockId(px, y, pz) !== 0) { groundY = y; break; }
    }
    const feetY = groundY + 1;
    // 造一条 18 格长、6 格深的水池。⚠️ 出生点地形会向 +X 抬升（实测池深 3 格时玩家
    // 4 秒内会爬上池沿出水），故池深取 6 格、清空高度取 8 格，尽量把玩家留在水里；
    // 断言本身按「在水中的帧」统计，不要求全窗口在水下（地形不可控）。
    const stone = g.registry.idOf('stone');
    const water = g.registry.idOf('water');
    for (let dx = -3; dx <= 18; dx++) for (let dz = -3; dz <= 3; dz++) {
      for (let y = feetY - 1; y <= feetY + 7; y++) g.editor.setBlock({ x: px + dx, y, z: pz + dz, id: 0 });
      g.editor.setBlock({ x: px + dx, y: feetY - 1, z: pz + dz, id: stone });
      for (let y = feetY; y <= feetY + 5; y++) g.editor.setBlock({ x: px + dx, y, z: pz + dz, id: water });
    }
    pl.physics.pos.x = px + 0.5;
    pl.physics.pos.y = feetY;
    pl.physics.pos.z = pz + 0.5;
    pl.physics.vel.x = 0; pl.physics.vel.y = 0; pl.physics.vel.z = 0;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

    pl.keys.add('KeyW');
    const t0 = performance.now();
    let frames = 0, waterFrames = 0, walkingInWater = 0, activeInWater = 0, landLoopInWater = 0;
    let sawWaterLoop = false;
    let drag = null;
    while (performance.now() - t0 < 4000) {
      await new Promise((r) => requestAnimationFrame(r));
      frames++;
      const loops = g.audioManager.debugLoops();
      if (pl.physics.inWater) {
        waterFrames++;
        if (pl.viewBob.walking) walkingInWater++;
        if (pl.viewBob.active) activeInWater++;
        if (loops.running_land?.playing) landLoopInWater++;
        drag = pl.physics.horizontalDrag;
      }
      if (loops.running_wet?.playing) sawWaterLoop = true;
    }
    pl.keys.delete('KeyW');
    for (let i = 0; i < 15; i++) await new Promise((r) => requestAnimationFrame(r));
    const after = g.audioManager.debugLoops();
    return {
      frames, waterFrames, walkingInWater, activeInWater, landLoopInWater, drag,
      sawWaterLoop,
      afterStop: { water: after.running_wet ?? null, land: after.running_land ?? null },
    };
  });

  // 前提：采样窗口内有足够多的帧确实在水里（否则测的是陆地路径，断言全绿也无意义）。
  // ⚠️ 不要求全窗口在水下：出生点地形向 +X 抬升，玩家可能中途爬上池沿（不可控）。
  expect(walked.waterFrames, '前置：按 W 期间须有 ≥60 帧在水中').toBeGreaterThanOrEqual(60);
  expect(walked.drag, '前置：水中阻力系数 = 0.6（缺陷的成因）').toBeCloseTo(0.6, 10);
  // 核心：水中的每一帧脚步声判据都成立（旧版读 active 恒 false → 此值恒 0）
  expect(walked.walkingInWater, '水中行走的每一帧 walking 判据都必须成立').toBe(walked.waterFrames);
  expect(walked.sawWaterLoop, '水中行走必须播 running_wet').toBe(true);
  expect(walked.landLoopInWater, '两路互斥：在水中的帧不得同时播 running_land').toBe(0);
  // 用户裁定：镜头保持不晃（active 判据不变）
  expect(walked.activeInWater, '镜头判据不变：水中的帧 actual/expected=0.6 < 0.95 → 不晃').toBe(0);
  // 停下后两路都收掉
  expect(walked.afterStop.water, '停下后水中脚步声必须停').toBeNull();
  expect(walked.afterStop.land, '停下后陆上脚步声也必须停').toBeNull();
});

test('雨天湿地：开雨天档后跑动换 running_wet，盖屋顶/关档后回到 running_land', async ({ page }) => {
  test.setTimeout(240_000);
  /**
   * v3.38（用户 2026-11-24）：「开启雨天光影的时候，当玩家进入被雨淋的湿地的时候，跑动时的
   * 脚步声音用 running_wet.wav，而不是继续用 running_land.mp3，当回到非被雨淋的区域时，
   * 才用回 running_land.mp3，当未开启雨天光影的时候，玩家跑动时的音效始终都是 running_land.mp3」。
   *
   * 四个阶段全在一个 evaluate 里跑完（中间不 await 外部）：
   *   ① 开档前跑 → land；
   *   ② 开档 + 露天草地跑 → wet（且 land 不播）；
   *   ③ 同位置给头顶盖石砖屋顶 → 回 land（且 wet 不播）；
   *   ④ 拆屋顶 → 回 wet；
   *   ⑤ 关档（原地跑）→ 恒 land。
   *
   * ⚠️ 判据读 `debugLoops()` 的 **playing / target**，不读常量：
   * 缺陷形态是「两个分支都合法但选错了那一路」，而任何请求计数类判据都拓不到。
   * ⚠️ 湿地必须自己造一个**露天干地平台**：出生点附近可能本来就在水里/棚下。
   */
  await boot(page, '&weather=clear');
  const r = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    const pl = g.player;
    const frame = () => new Promise((res) => requestAnimationFrame(res));

    /**
     * 造一条**长露天石廊**（会湿的材质）并清空头顶。
     * ⚠️ 实测教训：第一版只铺 5×5 石台，按 W 跑 40 帧就走出去了（玩家 8 格/秒，
     * 40 帧≈15 格），后面几个窗口实际在自然地形上跑 —— 第五个窗口撞进林地时
     * `walking` 只剩 2 帧（前置判据当红抓到）。走廊必须比「每窗口跑动距离 × 窗口数」长。
     * 长度方向沿 +X（`_applyInput` 对 KeyW 的方向由 yaw 决定，这里改为直接按 X 轴推速度，
     * 让走廊方向确定）。
     */
    const px = Math.floor(pl.physics.pos.x);
    const pz = Math.floor(pl.physics.pos.z);
    let groundY = -1;
    for (let y = Math.floor(pl.physics.pos.y); y > Math.floor(pl.physics.pos.y) - 12; y--) {
      if (g.world.getBlockId(px, y, pz) !== 0) { groundY = y; break; }
    }
    const feetY = groundY + 1;
    const stone = g.registry.idOf('stone');
    const bricks = g.registry.idOf('stone_bricks');
    const CORRIDOR = 72;             // 走廊长度（格，沿 +X）
    const HALF_Z = 3;
    for (let dx = -6; dx <= CORRIDOR; dx++) for (let dz = -HALF_Z; dz <= HALF_Z; dz++) {
      // 清空头顶 8 格（保证露天），再铺一层石台
      for (let y = feetY; y <= feetY + 8; y++) g.editor.setBlock({ x: px + dx, y, z: pz + dz, id: 0 });
      g.editor.setBlock({ x: px + dx, y: feetY - 1, z: pz + dz, id: stone });
    }

    /** 回到走廊起点（每个窗口前重置，消除「跑动会逐窗口漂移」） */
    const resetPos = async () => {
      pl.keys.delete('KeyW');
      pl.physics.pos.x = px + 0.5;
      pl.physics.pos.y = feetY;
      pl.physics.pos.z = pz + 0.5;
      pl.physics.vel.x = 0; pl.physics.vel.y = 0; pl.physics.vel.z = 0;
      // yaw 让 KeyW 朝 +X（走廊方向）：前向 (sin(−yaw), 0, −cos(yaw)) = (+1,0,0) ⇒ yaw = −π/2
      pl.yaw = -Math.PI / 2;
      for (let i = 0; i < 4; i++) await frame();
    };
    await resetPos();

    /** 跑 n 帧并统计两路各自在播的帧数与目标音量 */
    const sample = async (label, frames = 40) => {
      await resetPos();
      pl.keys.add('KeyW');
      const st = { label, frames: 0, land: 0, wet: 0, landTarget: null, wetTarget: null,
        wetAt02: 0, wetAt025: 0, walking: 0, inWater: 0, stepped: [] };
      for (let i = 0; i < frames; i++) {
        await frame();
        st.frames++;
        if (pl.viewBob.walking) st.walking++;
        if (pl.physics.inWater) st.inWater++;
        const loops = g.audioManager.debugLoops();
        if (loops.running_land?.playing) { st.land++; st.landTarget = loops.running_land.target; }
        if (loops.running_wet?.playing) {
          st.wet++; st.wetTarget = loops.running_wet.target;
          if (Math.abs(loops.running_wet.target - 0.2) < 1e-6) st.wetAt02++;
          if (Math.abs(loops.running_wet.target - 0.25) < 1e-6) st.wetAt025++;
        }
        st.stepped.push(pl._isRainWetGround());
      }
      pl.keys.delete('KeyW');
      for (let i = 0; i < 10; i++) await frame();
      st.afterStop = {
        land: g.audioManager.debugLoops().running_land ?? null,
        wet: g.audioManager.debugLoops().running_wet ?? null,
      };
      return st;
    };

    const before = await sample('before');           // ① 未开档
    g.setStormLighting(true);
    for (let i = 0; i < 4; i++) await frame();
    const on = await sample('storm-on');             // ② 开档 + 露天
    /**
     * ③ 给**整条走廊**盖屋顶（玩家在里面怎么跑都在屋顶下）。
     * ⚠️ 不能只盖起点那 5×5：按 W 跑 40 帧就走了 15 格，会跑出屋顶覆盖区
     * （第一版实测就是这样，`roofed` 窗口的 stepped 全 true）。
     */
    const roofY = feetY + 4;
    for (let dx = -6; dx <= CORRIDOR; dx++) for (let dz = -HALF_Z; dz <= HALF_Z; dz++) {
      g.editor.setBlock({ x: px + dx, y: roofY, z: pz + dz, id: bricks });
    }
    for (let i = 0; i < 4; i++) await frame();
    const roofed = await sample('roofed');           // ④ 屋顶下
    // ⑤ 拆屋顶 → 回湿地
    for (let dx = -6; dx <= CORRIDOR; dx++) for (let dz = -HALF_Z; dz <= HALF_Z; dz++) {
      g.editor.setBlock({ x: px + dx, y: roofY, z: pz + dz, id: 0 });
    }
    for (let i = 0; i < 4; i++) await frame();
    const unroofed = await sample('unroofed');
    // ⑥ 关档（仍在露天石廊上）⇒ 恒 land
    g.setStormLighting(false);
    // ⚠️ 生效值必须在**关档那一刻**采样：下面第 ⑦ 步会重新开档，末尾再读恒为 true
    // （第一版就是这样，前置判据以「关档后生效值必须为 false」红）。
    const stormActiveAfterOff = g.stormLighting;
    for (let i = 0; i < 4; i++) await frame();
    const off = await sample('storm-off');

    /**
     * ⑦ 单次「原地不跑」的缓存失效专测（与位置无关）：
     *    玩家停在起点，落地后给头顶盖一格屋顶 —— 缓存键（格）不变，
     *    只有编辑事件能让它失效。旧写法（只在跨格时重算）在这里静默不过。
     */
    await resetPos();
    g.setStormLighting(true);
    for (let i = 0; i < 4; i++) await frame();
    const stillOpen = pl._isRainWetGround();
    g.editor.setBlock({ x: px, y: roofY, z: pz, id: bricks });
    for (let i = 0; i < 3; i++) await frame();
    const stillRoofed = pl._isRainWetGround();
    g.editor.setBlock({ x: px, y: roofY, z: pz, id: 0 });
    for (let i = 0; i < 3; i++) await frame();
    const stillBack = pl._isRainWetGround();

    return { feetY, roofY, stone, bricks, corridor: CORRIDOR,
      stormActiveAfterOff,
      before, on, roofed, unroofed, off, stillOpen, stillRoofed, stillBack };
  });
  console.log('WET FOOTSTEP:', JSON.stringify(r));

  // 前置：五个窗口都真的跑起来了（否则后面的「有没有湿声」是在测静止）
  for (const k of ['before', 'on', 'roofed', 'unroofed', 'off']) {
    expect(r[k].walking, `前置（${k}）：按 W 期间必须真的进入跑动判据`).toBeGreaterThan(30);
    expect(r[k].inWater, `前置（${k}）：不该落进水里（否则测的是入水那一路）`).toBe(0);
  }
  // ① 未开档 ⇒ 恒 land，wet 一帧都不许有
  expect(r.before.land, '未开档：跑动必须播 running_land').toBeGreaterThan(30);
  expect(r.before.wet, '未开档：running_wet 一帧都不许播').toBe(0);
  // ② 开档 + 露天草地/石台 ⇒ 换 wet，音量 0.2，land 一帧不许有
  expect(r.on.wet, '开档 + 露天：必须播 running_wet').toBeGreaterThan(30);
  expect(r.on.wetAt02, '湿地那一路的意图音量必须是 0.2（与陆地同档）').toBe(r.on.wet);
  expect(r.on.wetAt025, '湿地不得用入水那档的 0.25').toBe(0);
  expect(r.on.land, '两路互斥：湿地上不得同时播 running_land').toBe(0);
  expect(r.on.stepped.every((v) => v === true), '开档 + 露天：谓词每帧都应为 true').toBe(true);
  // ③ 原地盖屋顶 ⇒ 当场回 land（缓存必须被编辑事件失效，而不是等玩家跨格）
  expect(r.roofed.stepped.every((v) => v === false), '有屋顶：谓词每帧都应为 false').toBe(true);
  expect(r.roofed.land, '屋顶下：必须回 running_land').toBeGreaterThan(30);
  expect(r.roofed.wet, '屋顶下：running_wet 一帧都不许播').toBe(0);
  // ④ 拆屋顶 ⇒ 当轮回湿地（证明③不是「开档被关掉了」）
  expect(r.unroofed.wet, '拆屋顶后：必须回 running_wet').toBeGreaterThan(30);
  expect(r.unroofed.land, '拆屋顶后：不得再播 running_land').toBe(0);
  // ⑤ 关档 ⇒ 恒 land（用户裁定：未开启时始终 running_land）
  expect(r.stormActiveAfterOff, '关档后生效值必须为 false').toBe(false);
  expect(r.off.land, '关档：必须回到 running_land').toBeGreaterThan(30);
  expect(r.off.wet, '关档：running_wet 一帧都不许播').toBe(0);
  // 每个窗口停下后两路都收掉（不得残留）
  for (const k of ['before', 'on', 'roofed', 'unroofed', 'off']) {
    expect(r[k].afterStop.land, `停下后（${k}）陆上脚步声必须停`).toBeNull();
    expect(r[k].afterStop.wet, `停下后（${k}）湿/水脚步声必须停`).toBeNull();
  }
  /**
   * ⑦ 缓存失效专测（玩家**不跨格**）：
   *   玩家停在同一格、落地后盖一格屋顶 → 谓词必须当场变 false，拆掉再回 true。
   * ⚠️ 这是「按格缓存」最容易漏的那条：只靠跨格失效时，原地盖屋顶永远不会重算，
   * 静默形态是「盖了屋顶仍然踩出踩水声」。
   */
  expect(r.stillOpen, '前置：起点露天时谓词为 true').toBe(true);
  expect(r.stillRoofed, '原地盖屋顶（不跨格）后谓词必须当场变 false').toBe(false);
  expect(r.stillBack, '拆掉屋顶后谓词必须回到 true').toBe(true);
});

test('死亡：丧尸被击杀播 z_die + 绿色碎块爆散，打中但没死时两者都不出', async ({ page }) => {
  test.setTimeout(180_000);
  await boot(page, '&weather=clear');

  const r = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    // ⚠️ `spawnZombieNearPlayer()` 返回的是 `{spawned, position, attempts, count}`，
    // **不是** `{id}`（读错字段会让整条用例以 `skipped` 静默通过 —— 实测踩到）。
    const res = g.spawnZombieNearPlayer();
    if (!res.spawned) return { skipped: true, attempts: res.attempts, count: res.count };
    const id = res.spawned;
    const base = g.audioDebugState().playRequests.z_die ?? 0;
    // v2.64：碎块池的前置读数（先 reset 一次，避免之前挖方块留下的碎块污染计数）
    g.blockHitFx.reset();
    const debrisBase = g.blockHitFx.activeDebrisCount;
    const visibleBase = g.blockHitFx.debrisMesh.visible;
    // ① 打 1 点血（不死）→ 不得响、不得出碎块
    const partial = g.damageEntity(id, 1, performance.now());
    const afterPartial = g.audioDebugState().playRequests.z_die ?? 0;
    const debrisAfterPartial = g.blockHitFx.activeDebrisCount;
    // ② 打满 → 必须响一次 + 爆一簇碎块
    const lethal = g.damageEntity(id, 10_000, performance.now());
    const afterLethal = g.audioDebugState().playRequests.z_die ?? 0;
    const debrisAfterLethal = g.blockHitFx.activeDebrisCount;
    const visibleAfterLethal = g.blockHitFx.debrisMesh.visible;
    // ③ 推进到寿命末尾 → 碎块全部回收、池回到不可见（draw call 回基线）
    g.blockHitFx.update(performance.now() + 5000);
    const debrisAfterExpire = g.blockHitFx.activeDebrisCount;
    const visibleAfterExpire = g.blockHitFx.debrisMesh.visible;
    return { id, partialDead: partial?.dead, lethalDead: lethal?.dead,
      base, afterPartial, afterLethal,
      debrisBase, visibleBase, debrisAfterPartial, debrisAfterLethal, visibleAfterLethal,
      debrisAfterExpire, visibleAfterExpire };
  });
  expect(r.skipped ?? false,
    `丧尸生成失败（attempts=${r.attempts}, count=${r.count}）—— 出生点附近无合法落点或被上限拒绝`).toBe(false);
  expect(r.partialDead, '前置：1 点伤害不该致死').toBe(false);
  expect(r.afterPartial - r.base, '打中但没死时不得播死亡音效').toBe(0);
  expect(r.debrisBase, '前置：reset 后碎块池应为空').toBe(0);
  expect(r.visibleBase, '前置：空池不得提交渲染（draw call 基线）').toBe(false);
  expect(r.debrisAfterPartial, '打中但没死时不得出碎块（否则「打一下就爆一次」）').toBe(0);
  expect(r.lethalDead, '前置：致死伤害').toBe(true);
  expect(r.afterLethal - r.base, '击杀必须播一次 z_die').toBe(1);
  // v2.64：死亡特效（用户 2026-11-07：「加一个丧尸死亡消失的特效」，裁定形态 = 绿色碎块爆散）
  expect(r.debrisAfterLethal, '击杀必须爆出一簇碎块（不得直接消失）').toBeGreaterThanOrEqual(10);
  expect(r.visibleAfterLethal, '有碎块时池必须可见').toBe(true);
  expect(r.debrisAfterExpire, '寿命末尾必须全部回收（不得泄漏 slot）').toBe(0);
  expect(r.visibleAfterExpire, '回收后池必须回到不可见').toBe(false);
});
