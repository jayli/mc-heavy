import { test, expect } from 'playwright/test';

/**
 * 焰魔（Ignis，v2.55）真游戏页 E2E —— Tier 4 像素实测。
 *
 * ## 为什么必须有这个 spec（`docs/testing-policy.md` 的 Tier 4）
 *
 * 焰魔的烘焙产物有两类缺陷**只有像素能抓**（单测抓不到，见 spec Review Focus）：
 *   ① **Bedrock box UV 布局写错** —— 贴图错位到邻面（脸跑到侧面），而 UV 全部 ∈ [0,1]、
 *      顶点数/骨骼数/指纹全绿；
 *   ② **骨骼变换链写错** —— 模型炸成碎片，而 53 骨骼 / 80 立方体 / 1920 顶点全部通过。
 *
 * ## 判据口径（AGENTS.md：像素断言必须同时钉上下界 + 先测噪声底）
 *
 * 噪声底实测（2026-11-05，本机，同状态连拍 3 张 680×520）：
 *   `changed = 0 / 326400`，`maxDelta = 0` —— 渲染是确定性的，阈值可以收到「> 0」。
 * 但**不能**只钉「变了」：还要钉「变了的范围落在焰魔身上」（防止「整屏乱码也算变了」）。
 *
 * ## 从玩家真实入口驱动（AGENTS.md M7 教训）
 *
 * 召唤走 `g.summonBoss()`（与 B 键同一条路径），而不是直接调 `ignises.summon()` ——
 * 后者会漏掉「名册没登记 / service 没装配 / 地图判定不对」这类接线缺陷。
 *
 * ⚠️ seed 用 12345（默认）。祭坛地带在 region(2,0)。
 */

const SEED = 12345;

async function waitWorldReady(page) {
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 90_000 });
}

/** 传送到祭坛高台地带的圆心（那里保证有 TARN 地图判定） */
async function teleportToTarnCenter(page) {
  return page.evaluate(async () => {
    const { findAltarTarnRegion } = await import('/src/gen/structures/tarn-zone.js');
    const g = window.__MC_GAME__;
    const a = findAltarTarnRegion(g.seed);
    if (!a) return null;
    g.player.spawn(a.cx, 40, a.cz);
    return { cx: a.cx, cz: a.cz };
  });
}

/**
 * 等玩家**真正落地**（`player.spawn(x, 40, z)` 之后 y 会继续下坠）。
 *
 * ⚠️ **这是踩到的真坑**：传送后立刻读 `player.physics.pos` 会拿到半空坐标（y≈36），
 * 用它去 `ignises.summon()` 会让焰魔落在**空中**（地表扫描在该列找到了云层/半空平台），
 * 于是 E2E 里「焰魔离玩家 30 格高」→ 画面里看不见 → 像素差为 0。
 */
async function waitPlayerLanded(page) {
  await page.waitForFunction(() => {
    const g = window.__MC_GAME__;
    if (!g?.player?.physics) return false;
    const p = g.player.physics.pos;
    // 落地判据：脚下那一格是实心（与 spawn 的 y 下坠无关，直接看世界）
    return g.world.isSolid(Math.floor(p.x), Math.floor(p.y - 0.5), Math.floor(p.z));
  }, null, { timeout: 30_000 });
  // 再等一拍让物理彻底稳定（避免 y 还在 1cm 级抖动）
  await page.waitForTimeout(400);
}

/** 截图（固定 clip，避免 UI 面板/云层噪声进入判据） */
async function shoot(page) {
  return page.screenshot({ clip: { x: 300, y: 120, width: 680, height: 520 } });
}

/** 两张 PNG（Buffer）的差异统计 */
async function pixelDiff(page, a, b) {
  return page.evaluate(async ([b64a, b64b]) => {
    const load = (b64) => new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = img.width; c.height = img.height;
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0);
        resolve(ctx.getImageData(0, 0, img.width, img.height));
      };
      img.src = `data:image/png;base64,${b64}`;
    });
    const A = await load(b64a);
    const B = await load(b64b);
    let changed = 0;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < A.data.length; i += 4) {
      const d = Math.abs(A.data[i] - B.data[i])
        + Math.abs(A.data[i + 1] - B.data[i + 1])
        + Math.abs(A.data[i + 2] - B.data[i + 2]);
      if (d === 0) continue;
      changed++;
      const px = (i / 4) % A.width;
      const py = Math.floor((i / 4) / A.width);
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;
    }
    return { changed, total: A.data.length / 4, minX, maxX, minY, maxY, w: A.width, h: A.height };
  }, [a.toString('base64'), b.toString('base64')]);
}

/**
 * 往页面里装一个「把焰魔渲染器的姿态衔接走到稳态」的辅助（v2.76）。
 *
 * ## 为什么需要
 *
 * v2.76 起 idle ↔ 攻击片段切换会淡入淡出，不再硬切：默认 `IGNIS_POSE_BLEND.seconds`（0.2s），
 * v2.77 起**旋斩入场** `spinInSeconds`（0.6s）。调用方传「要走满的最长时长」即可。
 * 这些用例的套路是「注入 state → 手动 `sync` → 立刻读骨骼/截图」，想要的是**这一状态的稳态姿态**；
 * 单次 `sync` 之后只是淡入的起点（姿态差 0.012 而期望 >0.3，实测踩到）。
 *
 * ## 怎么走
 *
 * 以合成时间戳（每步 1/60s）连续 `sync` 同一状态直到淡入走满。⚠️ **必须与状态注入在同一个同步
 * `evaluate` 里完成** —— 中间让出给 rAF 的话，游戏循环会用真实时间戳、并用被 Agent 推进过的 state
 * 再 `sync` 一次，取到的就不是想要的那一刻。合成时间戳超前于真实时间不会留下后遗症：下一次真实
 * `sync` 的 `dt = max(0, 负数) = 0`，随后恢复正常。
 */
async function installSettle(page) {
  await page.evaluate(() => {
    window.__e2eSettle = (blendSeconds) => {
      const g = window.__MC_GAME__;
      const list = g.ignises.activeEntities();
      let ms = performance.now();
      for (let i = 0; i < Math.ceil(blendSeconds * 60) + 3; i++) {
        ms += 1000 / 60;
        g.ignisRenderer.sync(list, ms);
      }
    };
  });
}

test.describe('焰魔（Ignis）Tier 4', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'WebGPU 只在 chromium 有 adapter');

  test('召唤：按 B（summonBoss）在祭坛高台地带召出焰魔，且落在地面上', async ({ page }) => {
    await page.goto(`/?seed=${SEED}`);
    await waitWorldReady(page);
    const center = await teleportToTarnCenter(page);
    expect(center).not.toBeNull();
    // 等传送后的 column 加载（否则地表扫描走兜底）
    await page.waitForTimeout(2500);

    const result = await page.evaluate(async () => {
      const g = window.__MC_GAME__;
      // 第一次 summonBoss → 飞龙（slot 0）；第二次 → 焰魔（slot 1）
      const r1 = g.summonBoss();
      await new Promise((r) => setTimeout(r, 300));
      const r2 = g.summonBoss();
      await new Promise((r) => setTimeout(r, 800));
      const ignises = g.ignises.activeEntities();
      const e = ignises[0];
      return {
        r1: r1?.reason || (r1?.ok ? 'ok' : 'unknown'),
        r2: r2?.reason || (r2?.ok ? 'ok' : 'unknown'),
        dragonCount: g.dragons.activeEntities().length,
        ignisCount: ignises.length,
        ignisPos: e ? [...e.state.position] : null,
        groundY: e ? g.world.getBlockId(
          Math.floor(e.state.position[0]), Math.floor(e.state.position[1]) - 1,
          Math.floor(e.state.position[2])) : null,
        selfAir: e ? g.world.getBlockId(
          Math.floor(e.state.position[0]), Math.floor(e.state.position[1]),
          Math.floor(e.state.position[2])) : null,
        onGround: e ? e.state.onGround : null,
        rendererVisible: g.ignisRenderer?.instances?.[0]?.pivot?.visible ?? null,
      };
    });

    // 第一次召飞龙、第二次召焰魔（用户裁定「飞龙先，焰魔后」）
    expect(result.r1, '第一次 summonBoss 应成功（飞龙）').toBe('ok');
    expect(result.r2, '第二次 summonBoss 应成功（焰魔）').toBe('ok');
    expect(result.dragonCount, '飞龙应共存').toBe(1);
    expect(result.ignisCount, '焰魔应被召出').toBe(1);
    // 落点在地面上：脚下实心、自身空气、onGround
    expect(result.groundY, '焰魔脚下应是实心方块（不是悬空）').not.toBe(0);
    expect(result.selfAir, '焰魔自身所在格应是空气（不是埋在地下）').toBe(0);
    expect(result.onGround, '焰魔应站在地面上').toBe(true);
    expect(result.rendererVisible, '渲染器实例应可见').toBe(true);
  });

  test('大竞技场：占地内任意层按 B → 焰魔恒召在房顶下面那一层的中心 + Boss BGM 切换', async ({ page }) => {
    test.setTimeout(300_000);
    await page.goto(`/?seed=${SEED}`);
    await waitWorldReady(page);

    // 锚点 + 预期召唤高度（从 gen 层权威读，不自己写一份）
    const arena = await page.evaluate(async () => {
      const m = await import('/src/gen/structures/burning-arena.js');
      const a = m.computeBurningArenaAnchor(window.__MC_GAME__.seed);
      if (!a) return null;
      return {
        wx: a.wx, wz: a.wz, floorY: a.floorY,
        summonY: a.floorY + m.BURNING_ARENA_SUMMON_FEET_DY,
        roofFeetY: a.floorY + m.BURNING_ARENA_HEIGHT - 9,
      };
    });
    expect(arena, '前置：seed 12345 必须有大竞技场').not.toBeNull();

    // 把玩家放在**房顶上**（脚底 = roofFeetY）。
    // ⚠️ 这是**判别力**的关键：中心列只有两个可站候选（塔顶 34 / 屋顶 70）。
    // 玩家站屋顶时，不传 summonY 的 `_findGroundY` 会取「离玩家最近」= 70（屋顶）；
    // 传了 summonY 才强制落到 34（房顶下面那一层）。若用例把玩家放低层（y≈0），
    // `_findGroundY` 自然选 34 = 期望值 ⇒ 用例退化成「测不到 summonY」的假绿。
    // 这也正是用户要求「不管玩家在什么高度」的最强验证：站在屋顶上按 B，Boss 仍召到屋顶下面。
    await page.evaluate((a) => {
      const g = window.__MC_GAME__;
      const p = g.player.physics.pos;
      p.x = a.wx; p.y = a.roofFeetY; p.z = a.wz;
      g.player.physics.vel.x = g.player.physics.vel.y = g.player.physics.vel.z = 0;
    }, arena);

    // ⚠️ 等的是**召唤点（锚点中心）**那列就绪，不是玩家那列：`_findGroundY` 扫的是
    // 中心列，它未加载时 `isSolid` 恒假 ⇒ 候选为空 ⇒ 落点兜底成 y=0（静默错召）。
    await page.waitForFunction((a) => {
      const g = window.__MC_GAME__;
      const ccx = Math.floor(a.wx / 16), ccz = Math.floor(a.wz / 16);
      return g.world.hasColumn(ccx, ccz);
    }, arena, { timeout: 180_000 });
    await page.waitForTimeout(800);

    // 真实 B 键路径（不直接调 summonBoss，AGENTS.md M7 教训）
    await page.evaluate(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', {
        code: 'KeyB', repeat: false, bubbles: true, cancelable: true,
      }));
      window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyB', bubbles: true, cancelable: true }));
    });
    await page.waitForFunction(
      () => window.__MC_GAME__.ignises.activeEntities().length === 1,
      null, { timeout: 30_000 });

    // ⚠️ **等物理真的站稳**（onGround）再读位置：召唤当帧还没跑过重力积分。
    // 这一步是载荷性的：若 `summonY` 差一格（悬空），焰魔会开始下落 ⇒ 本等待超时，
    // 把「落点算错一格」这类缺陷从「y 恰好相等」的假绿里拽出来。
    await page.waitForFunction(
      () => window.__MC_GAME__.ignises.activeEntities()[0]?.state.onGround === true,
      null, { timeout: 15_000 });

    const got = await page.evaluate(() => {
      const g = window.__MC_GAME__;
      const e = g.ignises.activeEntities()[0];
      const [x, y, z] = e.state.position;
      return {
        id: e.id,
        x, y, z,
        below: g.world.getBlockId(Math.floor(x), Math.floor(y) - 1, Math.floor(z)),
        self: g.world.getBlockId(Math.floor(x), Math.floor(y), Math.floor(z)),
        onGround: e.state.onGround,
        playerY: g.player.physics.pos.y,
      };
    });
    console.log('ARENA BOSS:', JSON.stringify(got), 'expected summonY', arena.summonY);

    // ① 召唤点 = 房顶**下面**那一层的中心（与玩家所在高度无关）
    // ⚠️ 用户 2026-11-09 裁定：「不要召唤到房顶上，而是房顶下面的这一层」。
    // 实测竖向结构（真实世界，floorY=−1）：y=69 netherrack = 房顶（脚底 70）、
    // y=34..68 全空（室内净空 35 格）、y=33 gold_block = 室内顶层中心可站面（脚底 34）。
    expect(got.y, `焰魔必须站在房顶下面那一层（玩家站在屋顶 y=${got.playerY.toFixed(1)}）`)
      .toBe(arena.summonY);
    expect(got.y, '不得站在房顶上（用户裁定）').not.toBe(arena.roofFeetY);
    expect(Math.floor(got.x), '召唤点 x = 锚点中心').toBe(arena.wx);
    expect(Math.floor(got.z), '召唤点 z = 锚点中心').toBe(arena.wz);
    // ② 真的站在室内顶层上（脚下实心、自身空气、onGround）
    expect(got.below, '脚下应是室内顶层方块（不是悬空）').not.toBe(0);
    expect(got.self, '自身所在格应是空气（不是埋在方块里）').toBe(0);
    expect(got.onGround, '焰魔应站在室内顶层上（不是悬空下落）').toBe(true);
    // ③ id 带本图标识（与高台地带的焰魔不互抢槽位）
    expect(got.id, '实体 id 必须带 burningarena 地图标识').toContain('burningarena:0');

    // ④ Boss BGM 切换（与高台地带同一逻辑：`_syncBossAudio` 按 IGNIS 计数置意图位）
    await page.locator('#app-canvas').click({ position: { x: 200, y: 200 } });
    await page.waitForFunction(
      () => window.__MC_GAME__.audioManager.debugMusicState().boss.wanted === true,
      null, { timeout: 15_000 });
    await page.waitForFunction(
      () => window.__MC_GAME__.audioManager.debugMusicState().boss.mix >= 1,
      null, { timeout: 60_000 });
    const music = await page.evaluate(() => window.__MC_GAME__.audioManager.debugMusicState());
    expect(music.boss.playing, '战斗曲必须在播').toBe(true);
    expect(music.playing, '淡变完成后普通曲必须停（不是两首叠播）').toBe(false);
  });

  test('渲染(v2.83)：盾牌真的画出来了（盾骨骼区域像素级，未合成贴图时信号恒为 0）', async ({ page }) => {
    await page.goto(`/?seed=${SEED}`);
    await waitWorldReady(page);
    await teleportToTarnCenter(page);
    await waitPlayerLanded(page);

    // 召唤焰魔（正对镜头，盾在它自己左侧 = 画面右侧）
    await page.evaluate(async () => {
      const g = window.__MC_GAME__;
      g.player.yaw = Math.PI;   // yaw=π ⇒ 前向 +Z
      g.player.pitch = -0.15;
      const p = g.player.physics.pos;
      const sum = g.ignises.summon('tarn:e2e:shield', Math.floor(p.x), Math.floor(p.z) + 4, 1);
      window.__E2E_ID__ = sum.ok ? sum.id : null;
      await new Promise((r) => setTimeout(r, 500));
    });
    await page.waitForTimeout(400);

    // ⚠️⚠️ **必须冻结帧循环**（`renderer.setAnimationLoop(null)`）。
    //
    // 不冻的版本实测**负向验证通不过**：idle 是 128°/s 的持续呼吸动画，两次截图之间画面
    // 自然差异就有 1.3~2.0 万像素（同一状态连拍 3 张的噪声底），把「盾约 1.8 万」的信号
    // 完全盖住 —— 注入缺陷后这条用例仍然绿。冻结后噪声底实测 **0**（渲染是确定性的），
    // 信号 17797 / 缺陷 0，判别力彻底干净。
    //
    // 冻结之后由本用例手动 `sync` + `render`，两次截图之间**只差盾骨骼的 scale 一个变量**。
    await page.evaluate(() => {
      const g = window.__MC_GAME__;
      g.renderer.setAnimationLoop(null);
    });
    await page.waitForTimeout(150);

    /** 手动推一次渲染：冻住 AI + 走满姿态衔接 + 渲染一帧 */
    const renderOnce = () => page.evaluate(() => {
      const g = window.__MC_GAME__;
      const list = g.ignises.activeEntities();
      const e = g.entities.get(window.__E2E_ID__);
      if (e) e.state = { ...e.state, mode: 'idle', attackAnimT: 0, idleTime: 0, velocity: [0, 0, 0] };
      let ms = performance.now();
      for (let i = 0; i < 40; i++) {
        ms += 1000 / 60;
        g.ignisRenderer.sync(list, ms);
      }
      g.renderer.render(g.scene, g.camera);
    });
    /**
     * 把盾骨骼缩成 0 / 还原。
     *
     * ⚠️ **用 `scale` 而不是 `visible`**：`visible` 是 SkinnedMesh（整个身体）级别的，
     * 会把焰魔整个隐掉；骨骼 `scale = 0` 让盾的 240 个顶点塌到一点 ⇒ 只有盾消失，
     * 身体、剑、相机、光照一概不变（单变量对照）。
     */
    const setShieldScale = (v) => page.evaluate((s) => {
      const g = window.__MC_GAME__;
      const inst = g.ignisRenderer.instances[0];
      const bone = inst && inst.bones.find((b) => b.name === 'shield_root');
      if (bone) bone.scale.setScalar(s);
    }, v);

    // ① 前提：盾骨骼在渲染器里真的存在（否则下面的判据只是"测了个不存在的对象"）
    const boneNames = await page.evaluate(() => {
      const g = window.__MC_GAME__;
      return g.ignisRenderer.instances[0].bones.map((b) => b.name).filter((n) => /^shield/.test(n));
    });
    expect(boneNames.length, '渲染器里应有盾骨骼（shield_root/shield/shield_right/shield_left）')
      .toBeGreaterThanOrEqual(4);

    // ② 噪声底：同一状态连拍两张，必须逐位相同（判定渲染确定性成立，阈值可以收到 > 0）
    await setShieldScale(1); await renderOnce(); const n1 = await shoot(page);
    await setShieldScale(1); await renderOnce(); const n2 = await shoot(page);
    const noise = await pixelDiff(page, n1, n2);
    expect(noise.changed, '冻结帧循环后同状态连拍必须逐位相同（噪声底 = 0）').toBe(0);

    // ③ 信号：盾可见 vs 盾缩成一点
    await setShieldScale(1); await renderOnce(); const withShield = await shoot(page);
    await setShieldScale(0); await renderOnce(); const noShield = await shoot(page);

    // 还原（同一浏览器上下文里的后续用例不该受这次改动影响）
    await setShieldScale(1);
    await renderOnce();
    await page.evaluate(() => window.__MC_GAME__.renderer.setAnimationLoop(null));

    const d = await pixelDiff(page, withShield, noShield);

    // **下界**：盾占了可观面积。缺盾贴图时盾完全透明 ⇒ 实测 **0**（就是用户报的那个缺陷）
    expect(d.changed, '盾应让画面产生可观像素变化（未合成盾贴图时恒为 0）')
      .toBeGreaterThan(3000);
    // **上界**：只有盾变了，不该牵连整个画面
    expect(d.changed / d.total, '盾的变化面积不应超过画面的 1/4').toBeLessThan(0.25);
    // 变化的包围盒必须落在画面的中下部（盾挂在左臂 ≈ 身体中线高度），不是在屏幕顶上
    expect(d.minY, '变化不应贴在画面最顶（那里是天空/云）').toBeGreaterThan(d.h * 0.2);
  });
  test('渲染：焰魔在真实 WebGPU 下画出来了（画面与"没有焰魔"显著不同）+ 像素变化集中在焰魔区域', async ({ page }) => {
    await page.goto(`/?seed=${SEED}`);
    await waitWorldReady(page);
    await teleportToTarnCenter(page);
    await waitPlayerLanded(page);

    // 先把玩家朝向调好（看向 +Z，焰魔会被召唤到那儿）
    await page.evaluate(() => {
      const g = window.__MC_GAME__;
      g.player.yaw = Math.PI;   // yaw=π ⇒ 前向 +Z
      g.player.pitch = -0.15;
    });
    await page.waitForTimeout(400);

    // ① 空场景基线
    const empty = await shoot(page);

    // ② 召唤焰魔（直接调 service 以便精确控制位置：玩家正前方 4 格）
    await page.evaluate(async () => {
      const g = window.__MC_GAME__;
      const p = g.player.physics.pos;
      const sum = g.ignises.summon('tarn:e2e:0', Math.floor(p.x), Math.floor(p.z) + 4, 1);
      window.__E2E_ID__ = sum.ok ? sum.id : null;
      await new Promise((r) => setTimeout(r, 500));
      // 冻住 AI（避免它走近/挥砍让两次截图差异混入动作噪声）
      const e = g.entities.get(window.__E2E_ID__);
      if (e) e.state = { ...e.state, mode: 'idle', attackAnimT: 0, idleTime: 0, velocity: [0, 0, 0] };
      g.ignisRenderer.sync(g.ignises.activeEntities(), performance.now());
    });
    await page.waitForTimeout(300);
    // 再冻一次（AI 可能在上一个 tick 又推进了）
    await page.evaluate(() => {
      const g = window.__MC_GAME__;
      const e = g.entities.get(window.__E2E_ID__);
      if (e) e.state = { ...e.state, mode: 'idle', attackAnimT: 0, idleTime: 0, velocity: [0, 0, 0] };
      g.ignisRenderer.sync(g.ignises.activeEntities(), performance.now());
    });
    const withIgnis = await shoot(page);

    const d = await pixelDiff(page, empty, withIgnis);

    // **下界**：焰魔确实画出来了（噪声底实测为 0，任何变化都是真的）
    expect(d.changed, '焰魔应让画面产生大量像素变化').toBeGreaterThan(5000);
    // **上界**：变化不该铺满整屏（铺满意味着相机/世界状态变了，不是"画了个焰魔"）
    expect(d.changed / d.total, '变化面积不应超过一半（否则不是"只多了焰魔"）')
      .toBeLessThan(0.5);
    // 变化的包围盒应落在画面中下部（焰魔站在地上），而不是贴在屏幕顶上（云层/天空）
    expect(d.maxY, '变化应延伸到画面下部（焰魔的腿脚）').toBeGreaterThan(d.h * 0.5);
  });

  test('渲染：挥砍动画的姿态与待机显著不同（像素级，不是"动画表有变"）', async ({ page }) => {
    await page.goto(`/?seed=${SEED}`);
    await waitWorldReady(page);
    await teleportToTarnCenter(page);
    await waitPlayerLanded(page);

    await page.evaluate(async () => {
      const g = window.__MC_GAME__;
      g.player.yaw = Math.PI;
      g.player.pitch = -0.15;
      const p = g.player.physics.pos;
      const sum = g.ignises.summon('tarn:e2e:1', Math.floor(p.x), Math.floor(p.z) + 4, 1);
      window.__E2E_ID__ = sum.ok ? sum.id : null;
      await new Promise((r) => setTimeout(r, 500));
    });
    await page.waitForTimeout(300);

    // ① 待机帧
    await page.evaluate(() => {
      const g = window.__MC_GAME__;
      const e = g.entities.get(window.__E2E_ID__);
      if (e) e.state = { ...e.state, mode: 'idle', attackAnimT: 0, idleTime: 0, velocity: [0, 0, 0] };
      g.ignisRenderer.sync(g.ignises.activeEntities(), performance.now());
    });
    const idle = await shoot(page);

    // ② 命中帧（attackAnimT = hitFrameSeconds = 1.20）
    await installSettle(page);
    await page.evaluate(async () => {
      const g = window.__MC_GAME__;
      const { IGNIS_AI, IGNIS_POSE_BLEND } = await import('/src/entities/ignis/ignis-config.js');
      const e = g.entities.get(window.__E2E_ID__);
      if (e) e.state = { ...e.state, attackAnimT: IGNIS_AI.hitFrameSeconds, velocity: [0, 0, 0] };
      g.ignisRenderer.sync(g.ignises.activeEntities(), performance.now());
      window.__e2eSettle(Math.max(IGNIS_POSE_BLEND.seconds, IGNIS_POSE_BLEND.spinInSeconds, IGNIS_POSE_BLEND.bashInSeconds));   // idle → attack 的淡入走满（v2.76）
    });
    const attack = await shoot(page);

    const d = await pixelDiff(page, idle, attack);
    // 实测（2026-11-05）：idle vs attack@1.20 变化 99911 / 353600（28%）
    expect(d.changed, '挥砍命中帧应让焰魔的姿态明显变化').toBeGreaterThan(20000);
    expect(d.maxX - d.minX, '变化应横跨焰魔身体的宽度（挥臂）').toBeGreaterThan(100);
  });

  test('渲染(v2.75)：旋斩 vs 横扫是两个不同姿态（像素级，且剑扫到身体另一侧）', async ({ page }) => {
    await page.goto(`/?seed=${SEED}`);
    await waitWorldReady(page);
    await teleportToTarnCenter(page);
    await waitPlayerLanded(page);

    await page.evaluate(async () => {
      const g = window.__MC_GAME__;
      g.player.yaw = Math.PI;
      g.player.pitch = -0.15;
      const p = g.player.physics.pos;
      const sum = g.ignises.summon('tarn:e2e:spin', Math.floor(p.x), Math.floor(p.z) + 4, 1);
      window.__E2E_ID__ = sum.ok ? sum.id : null;
      await new Promise((r) => setTimeout(r, 500));
    });
    await page.waitForTimeout(300);

    await installSettle(page);

    /** 把 state 钉到「某一招 + 某一时刻」再截屏（不经 AI，否则它会选招/推进） */
    const poseAt = async (kind, t) => {
      await page.evaluate(async ([k, tt]) => {
        const g = window.__MC_GAME__;
        const { IGNIS_POSE_BLEND } = await import('/src/entities/ignis/ignis-config.js');
        const e = g.entities.get(window.__E2E_ID__);
        // ⚠️ `mode` 必须是 attack 且 `attackAnimT` 非零，否则渲染器会去播 idle
        if (e) e.state = { ...e.state, mode: 'attack', attackKind: k, attackAnimT: tt, velocity: [0, 0, 0] };
        g.ignisRenderer.sync(g.ignises.activeEntities(), performance.now());
        window.__e2eSettle(Math.max(IGNIS_POSE_BLEND.seconds, IGNIS_POSE_BLEND.spinInSeconds, IGNIS_POSE_BLEND.bashInSeconds));   // 淡入走满（v2.76/v2.77：旋斩入场 0.6s），截到的才是这一招这一刻的稳态
      }, [kind, t]);
      return shoot(page);
    };

    /**
     * **骨骼姿态指纹** —— 「渲染器到底播了哪一支动画」的最直接证据。
     *
     * ⚠️ **不能只用像素作判据**（v2.75 实测踩到）：像素差分比的是「两帧画面不同」，
     * 而 `attackAnimT` 不同本身就足以让画面不同 —— 注入「永远播 attack」后仍会因时刻不同
     * 而差异巨大，用例照旧绿（**判据无判别力**）。骨骼四元数是动画采样的直接输出，
     * 同一时刻下只取决于选的是哪一支。
     */
    const bonePoseAt = async (kind, t) => {
      return page.evaluate(async ([k, tt]) => {
        const g = window.__MC_GAME__;
        const { IGNIS_POSE_BLEND } = await import('/src/entities/ignis/ignis-config.js');
        const e = g.entities.get(window.__E2E_ID__);
        if (e) e.state = { ...e.state, mode: 'attack', attackKind: k, attackAnimT: tt, velocity: [0, 0, 0] };
        g.ignisRenderer.sync(g.ignises.activeEntities(), performance.now());
        window.__e2eSettle(Math.max(IGNIS_POSE_BLEND.seconds, IGNIS_POSE_BLEND.spinInSeconds, IGNIS_POSE_BLEND.bashInSeconds));   // 淡入走满（v2.76/v2.77：旋斩入场 0.6s）：否则读到的是起点姿态
        const idx = g.ignises.activeEntities().findIndex((x) => x.id === window.__E2E_ID__);
        const inst = g.ignisRenderer.instances[idx];
        return inst ? inst.bones.map((b) => b.quaternion.toArray()) : null;
      }, [kind, t]);
    };
    const poseDist = (a, b) => {
      let s = 0;
      for (let i = 0; i < a.length; i++) for (let k = 0; k < 4; k++) s += Math.abs(a[i][k] - b[i][k]);
      return s;
    };

    // ① 骨骼层：同一时刻（0.55s）下两招必须是两个不同姿态。
    // 实测（2026-11-07）：swing@0.55 vs spin@0.55 的骨骼四元数总差 = 1.86（远大于 0.05）。
    const swingBones = await bonePoseAt('swing', 0.55);
    const spinBones = await bonePoseAt('spin', 0.55);
    expect(swingBones, '取不到焰魔实例的骨骼').not.toBeNull();
    const boneDiff = poseDist(swingBones, spinBones);
    expect(boneDiff, `同一时刻两招的骨骼姿态差 ${boneDiff.toFixed(3)}（应显著不同）`).toBeGreaterThan(0.3);

    // ② 像素层：两招的**命中帧**（横扫 1.20s / 旋斩 0.70s，玩家真正挨刀那一瞬）画面不同
    const swingHit = await poseAt('swing', 1.20);
    const spinHit = await poseAt('spin', 0.70);
    const d = await pixelDiff(page, swingHit, spinHit);
    expect(d.changed, '旋斩与横扫在命中帧应显著不同').toBeGreaterThan(15000);
    expect(d.maxX - d.minX, '差异应横跨焰魔身体宽度').toBeGreaterThan(100);

    // ③ 旋斩的形态：剑绕身扫 —— 与**起手帧**相比，变化必须横跨身体两侧
    //（只在前方摆动的横扫做不到；这条是「真的转了」的像素证据）
    const spinStart = await poseAt('spin', 0.02);
    const spinMid = await poseAt('spin', 0.55);
    const ds = await pixelDiff(page, spinStart, spinMid);
    expect(ds.changed, '旋斩从起手到中段应大幅改变画面').toBeGreaterThan(15000);
    expect(ds.maxX - ds.minX, '旋斩的变化应横跨身体两侧（转身扫剑）').toBeGreaterThan(100);
  });

  test('渲染(v2.76)：站定 → 旋斩起手，真实游戏页发布的骨骼无单帧跳变（用户缺陷：录像 1.13s 硬切）', async ({ page }) => {
    // 用户 2026-11-07（录像「焰魔旋转.mov」1.13s）：「身体本来是站定的，突然就切换到身体旋转举刀的
    // 形态了，中间没有补间过渡 …… 我要求有一个过渡动画」。逐帧抽录像：n=9（t=1.117s）站定，
    // n=10（t=1.133s）已是旋斩起手姿态 —— 相邻两帧（16.7ms）整副骨架跳变。
    // 实测（真实烘焙产物）：idle → spin(t=1/60) 单帧最大骨骼角 177°，旋斩自身最快的合法单帧仅 24.5°。
    //
    // ## 从玩家真实入口驱动（M7 教训：单测只能测算法与「注入的时间戳」）
    // 状态序列与 Agent 自己起手时一致（`mode='attack'`、`attackKind='spin'`、`attackAnimT` 从 0 起
    // 由 Agent 逐帧推进）；帧由游戏自己的 rAF 循环产出、经真实 `IgnisRenderer.sync(nowMs)` 发布。
    // 本用例**不手动 sync、不合成时间戳**，只在每帧渲染后读发布到 `bones[i].quaternion` 的结果，
    // 并按真实帧间隔把单帧转角换算成角速度（°/s）—— 机器慢时帧率会变，角速度不会。
    await page.goto(`/?seed=${SEED}`);
    await waitWorldReady(page);
    await teleportToTarnCenter(page);
    await waitPlayerLanded(page);

    await page.evaluate(async () => {
      const g = window.__MC_GAME__;
      g.player.yaw = Math.PI;
      g.player.pitch = -0.15;
      const p = g.player.physics.pos;
      const sum = g.ignises.summon('tarn:e2e:pop', Math.floor(p.x), Math.floor(p.z) + 4, 1);
      window.__E2E_ID__ = sum.ok ? sum.id : null;
      await new Promise((r) => setTimeout(r, 500));
      // 压住 Agent 自己的起手（冷却设得很大）：「站定」这一段由本用例控制，起手由本用例注入
      const e = g.entities.get(window.__E2E_ID__);
      if (e) e.state = { ...e.state, attackCooldown: 1e6, velocity: [0, 0, 0] };
    });
    await page.waitForTimeout(1200);            // 站稳：渲染器早已走过首帧，处在 idle 稳态

    const frames = await page.evaluate(async () => {
      const g = window.__MC_GAME__;
      const id = window.__E2E_ID__;
      const rec = [];
      let on = true;
      // 游戏的 rAF 回调先注册，本回调后注册 ⇒ 同一帧内本回调在游戏渲染（含 sync）之后执行。
      // ⚠️ 时间戳用 rAF 回调收到的**帧时间戳参数 `ts`**，不是回调里的 `performance.now()`：同一帧里所有
      // rAF 回调拿到同一个 `ts`，与游戏循环喂给 `sync` 的 `nowMs` 同源；而 `performance.now()` 是回调
      // 实际执行的时刻，相对帧时间有抖动（实测相邻两条记录只差 5.1ms）—— 把角速度虚高约 3 倍，
      // 窗口一旦覆盖片段自身的快旋段（24.5°/帧，合法动作）就会被放大成假红。
      const tick = (ts) => {
        const idx = g.ignises.activeEntities().findIndex((x) => x.id === id);
        const inst = idx >= 0 ? g.ignisRenderer.instances[idx] : null;
        const e = g.entities.get(id);
        if (inst && e) {
          rec.push({
            t: ts,
            animT: e.state.attackAnimT,
            kind: e.state.attackKind,
            q: inst.bones.map((b) => b.quaternion.toArray()),
          });
        }
        if (on) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      await new Promise((r) => setTimeout(r, 300));          // 先录一小段站定
      const e0 = g.entities.get(id);
      if (e0) e0.state = { ...e0.state, mode: 'attack', attackKind: 'spin', attackAnimT: 0, velocity: [0, 0, 0] };
      await new Promise((r) => setTimeout(r, 1500));         // 起手后 ~1.5s：覆盖 0.6s 淡入 + 命中帧 0.70s + 快旋段
      on = false;
      return rec;
    });

    // 判据常量全部由真实烘焙产物现算（不写死魔数）：旋斩自身最快的合法角速度 + root 的 bind
    const ref = await page.evaluate(async () => {
      const { loadIgnisAsset, sampleIgnisAttack } = await import('/src/render/ignis-model.js');
      const d = await loadIgnisAsset();
      const ang = (a, b) => {
        const rw = a[3] * b[3] + a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
        const rx = a[3] * b[0] - a[0] * b[3] - a[1] * b[2] + a[2] * b[1];
        const ry = a[3] * b[1] + a[0] * b[2] - a[1] * b[3] - a[2] * b[0];
        const rz = a[3] * b[2] - a[0] * b[1] + a[1] * b[0] - a[2] * b[3];
        return (2 * Math.atan2(Math.hypot(rx, ry, rz), Math.abs(rw)) * 180) / Math.PI;
      };
      const spin = d.animations.spin;
      const dt = 1 / 60;
      let maxStep = 0;
      for (let t = 0; t + dt <= spin.frameCount / spin.fps; t += dt) {
        const p = sampleIgnisAttack(spin, t);
        const q = sampleIgnisAttack(spin, t + dt);
        for (const [bi, x] of p) maxStep = Math.max(maxStep, ang(x.rot, q.get(bi).rot));
      }
      const rootIdx = d.bones.findIndex((b) => b.name === 'root');
      return { clipMaxDegPerSec: maxStep / dt, rootIdx, rootBind: d.bones[rootIdx].bindQuaternion };
    });

    const ang = (a, b) => {
      const rw = a[3] * b[3] + a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
      const rx = a[3] * b[0] - a[0] * b[3] - a[1] * b[2] + a[2] * b[1];
      const ry = a[3] * b[1] + a[0] * b[2] - a[1] * b[3] - a[2] * b[0];
      const rz = a[3] * b[2] - a[0] * b[1] + a[1] * b[0] - a[2] * b[3];
      return (2 * Math.atan2(Math.hypot(rx, ry, rz), Math.abs(rw)) * 180) / Math.PI;
    };
    const stepDeg = (f0, f1) => Math.max(...f0.q.map((q, i) => ang(q, f1.q[i])));

    // 起手帧 = 第一条 animT>0 且 kind==='spin'
    const i0 = frames.findIndex((f) => f.animT > 0 && f.kind === 'spin');
    expect(i0, `应录到旋斩起手（共 ${frames.length} 帧）`).toBeGreaterThan(3);
    // 观察窗口按**时间**取（不按帧数，帧率不同帧数不同）：起手后 1.2s，覆盖 0.6s 淡入、命中帧 0.70s 与快旋段
    let end = i0;
    while (end + 1 < frames.length && frames[end + 1].t - frames[i0].t <= 1200) end++;
    expect(frames[end].t - frames[i0].t, `起手后应至少录到 1s（实录 ${(frames[end].t - frames[i0].t).toFixed(0)}ms）`)
      .toBeGreaterThan(1000);

    // 起手前 3 帧 → 起手后 1.2s 逐对相邻帧的最大骨骼角速度
    let worst = { speed: 0, i: -1, step: 0, dtMs: 0 };
    for (let i = i0 - 3; i < end; i++) {
      const dtSec = (frames[i + 1].t - frames[i].t) / 1000;
      if (dtSec <= 0) continue;
      const step = stepDeg(frames[i], frames[i + 1]);
      if (step / dtSec > worst.speed) worst = { speed: step / dtSec, i, step, dtMs: dtSec * 1000 };
    }
    // 上限 = 旋斩自身最快合法角速度的 2 倍（吸收帧间隔抖动）。硬切换（177° / 一帧）在 60fps 约
    // 10600°/s、30fps 约 5300°/s —— 远在上限之上，约 18fps 以上都分得开。
    const limit = ref.clipMaxDegPerSec * 2;
    expect(worst.speed,
      `起手前后的最大骨骼角速度 ${worst.speed.toFixed(0)}°/s（第 ${worst.i - i0} 帧：单帧 ${worst.step.toFixed(1)}°、`
      + `间隔 ${worst.dtMs.toFixed(1)}ms）超过旋斩自身合法上限的 2 倍 ${limit.toFixed(0)}°/s —— 站定 → 旋斩仍是硬切换`)
      .toBeLessThan(limit);

    // 非空洞：旋斩真的播了。看 `root`（整副身体的偏航）而不是 `sword`：v2.77 起旋斩入场淡入 0.6s，
    // 淡入期内 sword 只显示到 ~34°（0.5s 后片段里它本就归零），而 root 在命中帧 0.70s 前后已转到 ~132°。
    // 站定时 root 只有 idle 的呼吸晃动（<1°）。
    let rootMax = 0;
    for (let i = i0; i <= end; i++) rootMax = Math.max(rootMax, ang(frames[i].q[ref.rootIdx], ref.rootBind));
    expect(rootMax, `起手后 root 最大偏离 bind ${rootMax.toFixed(0)}°：旋斩没真正播出来（判据会空洞地通过）`)
      .toBeGreaterThan(60);
  });

  test('战斗：挥剑真的扣玩家血（20 → 6，正好 IGNIS.attackDamage = 14）', async ({ page }) => {
    await page.goto(`/?seed=${SEED}`);
    await waitWorldReady(page);
    await teleportToTarnCenter(page);
    await waitPlayerLanded(page);

    const r = await page.evaluate(async () => {
      const g = window.__MC_GAME__;
      const { IGNIS } = await import('/src/entities/ignis/ignis-config.js');
      const hpStart = g.player.health;
      const p = g.player.physics.pos;
      // 召唤到玩家旁边 3 格（在 hitRange 6.5 之内，且已在 attackRange 5.5 之内）
      const sum = g.ignises.summon('tarn:e2e:2', Math.floor(p.x), Math.floor(p.z) + 3, 1);
      if (!sum.ok) return { err: sum.reason, hpStart };
      // 等它走完接近 + 一次完整攻击（动画 2.75s + 余量）
      const samples = [];
      for (let i = 0; i < 40; i++) {
        await new Promise((res) => setTimeout(res, 250));
        samples.push(g.player.health);
        if (g.player.health < hpStart) break;
      }
      return {
        hpStart,
        hpEnd: g.player.health,
        damage: hpStart - g.player.health,
        expectedDamage: IGNIS.attackDamage,
        samples: samples.slice(-6),
      };
    });

    expect(r.err).toBeUndefined();
    expect(r.hpStart, '起始满血 40（v3.29 血量翻倍）').toBe(40);
    // **上下界同时钉**：只钉「掉血」抓不到「一下掉到 0」或「扣错量」
    expect(r.damage, `应为一次完整伤害 ${r.expectedDamage}`).toBe(r.expectedDamage);
    expect(r.hpEnd, '40 − 14 = 26').toBe(26);
  });

  /**
   * v2.75：**两招的锥宽差必须在真实结算里生效**。
   *
   * ## 为什么必须有这条（手工负向验证揭出的覆盖缺口）
   *
   * 把 `_consumeIgnisAttackRequests` 里的 `IGNIS_ATTACKS[req.kind]` 改成恒 `swing`
   * （= 旋斩也按 35° 判定）时，**既有全部用例仍然全绿** —— 因为两招的 `hitRange` 都是
   * 6.5，而既有 E2E 测的都是正面命中。那个缺陷的真实形态是「旋斩打不到侧面」，
   * 除了这一条没人能发现。
   *
   * ## 驱动方式（为什么直接调消费点，而不是等 AI 起手）
   *
   * `attackRequest` 是**瞬态**：`ignisDefinition.update` 每帧都会返回 `attackRequest: null`
   * （除非本帧正好越过命中帧），所以**往 state 里塞一个 request 会被下一帧的 Agent 覆写掉**
   * —— 实测踩到：注入后所有角度都不掉血（连 0° 都不掉），而当时误以为是锥宽算错了。
   * 这里改为「把 request 塞进去 → **同步**调一次唯一的消费点」，测的仍是同一条结算路径
   * （`game._consumeIgnisAttackRequests` 与真实战斗同一个方法、同一份 profile 查表）。
   *
   * ## 判据（同一几何：玩家在焰魔侧方，距 3 格）
   *
   * | 角度 | 旋斩（半角 155°） | 横扫（半角 35°） |
   * |---|---|---|
   * | 0°（正面） | 掉血 | 掉血 |
   * | 80°（侧方） | **掉血** | **不掉血** |
   * | 170°（背后） | **不掉血**（作者刻意的 50° 死角） | 不掉血 |
   *
   * 实测（2026-11-07）：旋斩 0°/80° → 6，170° → 20；横扫只有 0° → 6。
   */
  test('战斗(v2.75)：旋斩覆盖侧方但留 50° 背向死角，横扫只打正面（锥宽差真的生效）', async ({ page }) => {
    await page.goto(`/?seed=${SEED}`);
    await waitWorldReady(page);
    await teleportToTarnCenter(page);
    await waitPlayerLanded(page);

    const r = await page.evaluate(async () => {
      const g = window.__MC_GAME__;
      const { IGNIS, IGNIS_ATTACKS } = await import('/src/entities/ignis/ignis-config.js');
      const p = g.player.physics.pos;
      const sum = g.ignises.summon('tarn:e2e:cone', Math.floor(p.x), Math.floor(p.z) + 3, 1);
      if (!sum.ok) return { err: sum.reason };
      const id = sum.id;
      await new Promise((res) => setTimeout(res, 600));
      const e0 = g.entities.get(id);
      if (!e0) return { err: 'entity gone' };
      // 焰魔朝向钉成 yaw=0（本仓前向 = (−sin yaw, −cos yaw) ⇒ 前方 −Z）
      const ex = e0.state.position[0], ey = e0.state.position[1], ez = e0.state.position[2];

      /** 把玩家摆到「前方偏 deg 度、距 3 格」，注入一刀，同步消费，返回血量 */
      const hitAt = (deg, kind) => {
        const ang = deg * Math.PI / 180;
        g.player.physics.pos.x = ex - Math.sin(ang) * 3;
        g.player.physics.pos.z = ez - Math.cos(ang) * 3;
        g.player.health = 20;
        const e = g.entities.get(id);
        e.state = {
          ...e.state, yaw: 0,
          attackRequest: { at: [ex, ey, ez], yaw: 0, kind },
        };
        // 同步调**唯一**的结算入口（与真实战斗同一方法；不走 AI 的瞬态覆写）
        g._consumeIgnisAttackRequests(performance.now());
        return g.player.health;
      };

      return {
        spinFront: hitAt(0, 'spin'),
        spinSide: hitAt(80, 'spin'),
        spinBack: hitAt(170, 'spin'),
        swingFront: hitAt(0, 'swing'),
        swingSide: hitAt(80, 'swing'),
        spinCone: IGNIS_ATTACKS.spin.hitConeDeg,
        swingCone: IGNIS_ATTACKS.swing.hitConeDeg,
        damage: IGNIS.attackDamage,
      };
    });

    expect(r.err).toBeUndefined();
    expect(r.spinCone, '旋斩半角').toBe(155);
    expect(r.swingCone, '横扫半角').toBe(35);
    expect(r.damage, '两招同伤害').toBe(14);

    // 满血 20 → 挨一刀 6
    expect(r.spinFront, '旋斩正面必须命中').toBe(6);
    expect(r.spinSide, '侧方 80° 必须被旋斩打中（半角 155°）').toBe(6);
    // ⚠️ 这条是「照原版 310°」的形态判据：作者刻意留的 50° 背向死角
    expect(r.spinBack, '背后 170° 不得被旋斩打中 —— 作者刻意的 50° 死角').toBe(20);
    expect(r.swingFront, '横扫正面必须命中').toBe(6);
    expect(r.swingSide, '侧方 80° 不得被横扫打中（半角 35°）').toBe(20);
  });

  // ==================== 第三招：持盾冲撞（v3.01）====================

  test('渲染(v3.01)：持盾冲撞 vs 横扫 vs 旋斩 三两不同姿态（像素级 + 骨骼层双判据）', async ({ page }) => {
    await page.goto(`/?seed=${SEED}`);
    await waitWorldReady(page);
    await teleportToTarnCenter(page);
    await waitPlayerLanded(page);

    await page.evaluate(async () => {
      const g = window.__MC_GAME__;
      g.player.yaw = Math.PI;
      g.player.pitch = -0.15;
      const p = g.player.physics.pos;
      const sum = g.ignises.summon('tarn:e2e:smash', Math.floor(p.x), Math.floor(p.z) + 4, 1, Math.floor(p.y));
      window.__E2E_ID__ = sum.ok ? sum.id : null;
      await new Promise((r) => setTimeout(r, 500));
    });
    await page.waitForTimeout(300);

    // ⚠️⚠️ **必须冻结帧循环**（同 v2.83 盾贴图用例的口径）：idle 是持续呼吸动画，
    // 不冻的话同状态连拍就有上万像素差异，会把信号盖住 ⇒ 注入缺陷后仍绿。
    await page.evaluate(() => window.__MC_GAME__.renderer.setAnimationLoop(null));
    await page.waitForTimeout(150);
    await installSettle(page);

    /**
     * 把 state 钉到「某一招 + 某一时刻」→ 走满淡入 → **手动 render** → 截屏。
     *
     * ⚠️ `installSettle` 只 `sync` 不 `render`；冻结帧循环后 WebGPU canvas 不会自己重绘，
     * 不补这一次 render 的话两张截图拿到的是**同一帧旧画面**（差异 0，假绿）。
     */
    const poseAt = async (kind, t) => {
      await page.evaluate(async ([k, tt]) => {
        const g = window.__MC_GAME__;
        const { IGNIS_POSE_BLEND } = await import('/src/entities/ignis/ignis-config.js');
        const e = g.entities.get(window.__E2E_ID__);
        if (e) e.state = { ...e.state, mode: 'attack', attackKind: k, attackAnimT: tt, velocity: [0, 0, 0] };
        g.ignisRenderer.sync(g.ignises.activeEntities(), performance.now());
        window.__e2eSettle(Math.max(IGNIS_POSE_BLEND.seconds, IGNIS_POSE_BLEND.spinInSeconds, IGNIS_POSE_BLEND.bashInSeconds));
        g.renderer.render(g.scene, g.camera);
      }, [kind, t]);
      return shoot(page);
    };

    /** 骨骼姿态指纹（同一时刻下只取决于选了哪一支动画） */
    const bonePoseAt = async (kind, t) => page.evaluate(async ([k, tt]) => {
      const g = window.__MC_GAME__;
      const { IGNIS_POSE_BLEND } = await import('/src/entities/ignis/ignis-config.js');
      const e = g.entities.get(window.__E2E_ID__);
      if (e) e.state = { ...e.state, mode: 'attack', attackKind: k, attackAnimT: tt, velocity: [0, 0, 0] };
      g.ignisRenderer.sync(g.ignises.activeEntities(), performance.now());
      window.__e2eSettle(Math.max(IGNIS_POSE_BLEND.seconds, IGNIS_POSE_BLEND.spinInSeconds, IGNIS_POSE_BLEND.bashInSeconds));
      const idx = g.ignises.activeEntities().findIndex((x) => x.id === window.__E2E_ID__);
      const inst = g.ignisRenderer.instances[idx];
      return inst ? inst.bones.map((b) => b.quaternion.toArray()) : null;
    }, [kind, t]);
    const poseDist = (a, b) => {
      let s = 0;
      for (let i = 0; i < a.length; i++) for (let k = 0; k < 4; k++) s += Math.abs(a[i][k] - b[i][k]);
      return s;
    };

    // ① 噪声底：同一状态连拍两张必须逐位相同（证明冻结后渲染确定性成立）
    const n1 = await poseAt('shieldSmash', 1.0);
    const n2 = await poseAt('shieldSmash', 1.0);
    const noise = await pixelDiff(page, n1, n2);
    expect(noise.changed, '冻结帧循环后同状态连拍必须逐位相同（噪声底 = 0）').toBe(0);

    // ② 骨骼层：**同一时刻 1.0s**（持盾冲撞蓄力到位）下三招必须是三个不同姿态。
    // ⚠️ 不能只用像素作判据：时刻不同本身就足以让画面不同，注入「恒播 attack」后仍绿。
    const swingBones = await bonePoseAt('swing', 1.0);
    const spinBones = await bonePoseAt('spin', 1.0);
    const smashBones = await bonePoseAt('shieldSmash', 1.0);
    expect(smashBones, '取不到焰魔实例的骨骼').not.toBeNull();
    const dSmashSwing = poseDist(smashBones, swingBones);
    const dSmashSpin = poseDist(smashBones, spinBones);
    expect(dSmashSwing, `持盾冲撞与横扫在 1.0s 的骨骼姿态差 ${dSmashSwing.toFixed(3)}（应显著不同）`)
      .toBeGreaterThan(0.3);
    expect(dSmashSpin, `持盾冲撞与旋斩在 1.0s 的骨骼姿态差 ${dSmashSpin.toFixed(3)}（应显著不同）`)
      .toBeGreaterThan(0.3);

    // ③ 像素层：同一时刻 1.0s 下三两截图两两不同
    const smashPix = await poseAt('shieldSmash', 1.0);
    const swingPix = await poseAt('swing', 1.0);
    const spinPix = await poseAt('spin', 1.0);
    const dSS = await pixelDiff(page, smashPix, swingPix);
    const dSP = await pixelDiff(page, smashPix, spinPix);
    expect(dSS.changed, `持盾冲撞与横扫的像素差 ${dSS.changed}（应远大于噪声底 0）`).toBeGreaterThan(1500);
    expect(dSP.changed, `持盾冲撞与旋斩的像素差 ${dSP.changed}（应远大于噪声底 0）`).toBeGreaterThan(1500);

    // 还原帧循环（同一浏览器上下文里的后续用例不该受影响）
    await page.evaluate(() => window.__MC_GAME__.renderer.setAnimationLoop(null));
  });

  /**
   * v3.01 持盾冲撞的**真实射程多点取样**。
   *
   * ⚠️ **用户 2026-11-14 二次裁定后本表整段重写**：射程从原版 4.85 改成 **6.5**（与另两招同值），
   * 贴身门（3.0）已删。旧版「5.0 格打不中」的判据现在**必须反过来**（它正是用户报的「苛刻」）。
   *
   * | 距离 | 期望 | 依据 |
   * |---|---|---|
   * | 2.5 | 扣 14 血 | `< hitRange 6.5` |
   * | **5.0** | **扣 14 血** | 站定环外沿 —— 旧版在这里是盲区（`> 4.85`），用户裁定要消除它 |
   * | 6.0 | 扣 14 血 | `< 6.5` |
   * | 7.0 | 不掉血 | `> 6.5` |
   *
   * ⚠️ **6.0 与 7.0 两点夹住 6.5 边界**，才有判别力：只测「近处命中」时，把射程误写成
   * 4.85（回退旧值）也会全绿。
   *
   * ⚠️ 焰魔朝向**钉死 yaw=0**（照 v2.78 的教训：靠 AI 自然转身制造前提是非确定性的）。
   */
  test('战斗(v3.01)：持盾冲撞射程与另两招同值 6.5 —— 5.0/6.0 格命中，7.0 格打不中', async ({ page }) => {
    await page.goto(`/?seed=${SEED}`);
    await waitWorldReady(page);
    await teleportToTarnCenter(page);
    await waitPlayerLanded(page);

    const r = await page.evaluate(async () => {
      const g = window.__MC_GAME__;
      const { IGNIS, IGNIS_ATTACKS } = await import('/src/entities/ignis/ignis-config.js');
      const p = g.player.physics.pos;
      const sum = g.ignises.summon('tarn:e2e:smashrange', Math.floor(p.x), Math.floor(p.z) + 3, 1, Math.floor(p.y));
      if (!sum.ok) return { err: sum.reason };
      const id = sum.id;
      await new Promise((res) => setTimeout(res, 600));
      const e0 = g.entities.get(id);
      if (!e0) return { err: 'entity gone' };
      const ex = e0.state.position[0], ey = e0.state.position[1], ez = e0.state.position[2];

      /** 把玩家摆到正前方 dist 格，注入一刀。
       * ⚠️ **不强制 y**（同 v2.75 锥宽用例的 hitAt 口径）：玩家落地 y 与焰魔脚底 y 可差 2 格
       *（实测 landedY=5 / ignisY=3），把玩家摩到焰魔脚底会把它塞进目标列的实心地形里 ⇒
       * LOS 被挡 ⇒ 明明在射程内却「打不中」（实测踩到：2.5 命中、3.0/4.5 不命中的非连续形态）。
       * 只改 x/z，y 保持玩家真实落地高度，LOS 端点 `to=[px, p.y+1, pz]` 自然用真实 y。 */
      const hitAt = (dist, kind) => {
        g.player.physics.pos.x = ex;
        g.player.physics.pos.z = ez - dist;
        g.player.health = 20;
        const e = g.entities.get(id);
        e.state = {
          ...e.state, yaw: 0,
          attackRequest: { at: [ex, ey, ez], yaw: 0, kind },
        };
        g._consumeIgnisAttackRequests(performance.now());
        return g.player.health;
      };

      return {
        smash25: hitAt(2.5, 'shieldSmash'),
        // ⚠️ 5.0 = 站定环外沿：旧版射程 4.85 时这里是盲区（用户报的「苛刻」核心）
        smash50: hitAt(5.0, 'shieldSmash'),
        smash60: hitAt(6.0, 'shieldSmash'),
        smash70: hitAt(7.0, 'shieldSmash'),
        // 对照组：横扫的 6.5 在同一组距离上应得相同结果（三招射程同值）。
        // 没有对照，「7.0 不掉血」可能是 LOS 被地形挡住造成的假结论。
        swing50: hitAt(5.0, 'swing'),
        swing70: hitAt(7.0, 'swing'),
        smashRange: IGNIS_ATTACKS.shieldSmash.hitRange,
        swingRange: IGNIS_ATTACKS.swing.hitRange,
        damage: IGNIS.attackDamage,
      };
    });

    expect(r.err).toBeUndefined();
    expect(r.smashRange, '持盾冲撞射程（用户裁定：与另两招同值）').toBe(6.5);
    expect(r.swingRange, '横扫射程').toBe(6.5);
    expect(r.damage, '三招同伤害').toBe(14);

    expect(r.smash25, '2.5 格持盾冲撞必须命中：20 → 6').toBe(6);
    // ⚠️ 本用例的核心：旧版这里是盲区（> 4.85），用户裁定后必须命中
    expect(r.smash50, '5.0 格（站定环外沿）持盾冲撞必须命中 —— 旧版的射程盲区已消除').toBe(6);
    expect(r.smash60, '6.0 格仍在射程内（6.0 < 6.5）⇒ 必须命中').toBe(6);
    expect(r.smash70, '7.0 格超出射程 6.5 ⇒ 打不中').toBe(20);
    // 对照组：证明这些位置本身是可判定的（LOS 通、y 对），而非假命中/假落空
    expect(r.swing50, '对照组：5.0 格横扫必须命中').toBe(6);
    expect(r.swing70, '对照组：7.0 格横扫也必须打不中（射程同为 6.5）').toBe(20);
  });

  /**
   * v3.01 持盾冲撞的**锥宽**：半角 22.5°，比横扫的 35° 更窄、远窄于旋斩的 155°。
   *
   * 取样 **40°**：它同时落在「持盾冲撞半角 22.5 之外」与「旋斩半角 155 之内」⇒ 同一位置对照
   * 就能证明锥宽真的按招取（而不是所有招共用派生最大值 155）。
   * 另取 0°（三招都该中）与 170°（旋斩的背向死角，三招都不该中）做两侧锚点。
   */
  test('战斗(v3.01)：持盾冲撞锥宽半角 22.5° —— 侧向 40° 打不中，而旋斩打得到（同位置对照）', async ({ page }) => {
    await page.goto(`/?seed=${SEED}`);
    await waitWorldReady(page);
    await teleportToTarnCenter(page);
    await waitPlayerLanded(page);

    const r = await page.evaluate(async () => {
      const g = window.__MC_GAME__;
      const { IGNIS_ATTACKS } = await import('/src/entities/ignis/ignis-config.js');
      const p = g.player.physics.pos;
      const sum = g.ignises.summon('tarn:e2e:smashcone', Math.floor(p.x), Math.floor(p.z) + 3, 1, Math.floor(p.y));
      if (!sum.ok) return { err: sum.reason };
      const id = sum.id;
      await new Promise((res) => setTimeout(res, 600));
      const e0 = g.entities.get(id);
      if (!e0) return { err: 'entity gone' };
      const ex = e0.state.position[0], ey = e0.state.position[1], ez = e0.state.position[2];

      /** 玩家摆到「前方偏 deg 度、距 3 格」（3 < 6.5 ⇒ 射程内，只剩锥判据）。
       * ⚠️ **不强制 y**（同射程用例）：摩到焰魔脚底会把玩家塞进地形 ⇒ LOS 被挡 ⇒ 假「打不中」。 */
      const hitAt = (deg, kind) => {
        const ang = deg * Math.PI / 180;
        g.player.physics.pos.x = ex - Math.sin(ang) * 3;
        g.player.physics.pos.z = ez - Math.cos(ang) * 3;
        g.player.health = 20;
        const e = g.entities.get(id);
        e.state = { ...e.state, yaw: 0, attackRequest: { at: [ex, ey, ez], yaw: 0, kind } };
        g._consumeIgnisAttackRequests(performance.now());
        return g.player.health;
      };

      return {
        smashFront: hitAt(0, 'shieldSmash'),
        smashSide40: hitAt(40, 'shieldSmash'),
        smashBack: hitAt(170, 'shieldSmash'),
        spinSide40: hitAt(40, 'spin'),
        swingSide40: hitAt(40, 'swing'),
        smashCone: IGNIS_ATTACKS.shieldSmash.hitConeDeg,
        spinCone: IGNIS_ATTACKS.spin.hitConeDeg,
      };
    });

    expect(r.err).toBeUndefined();
    expect(r.smashCone, '持盾冲撞半角').toBe(22.5);
    expect(r.spinCone, '旋斩半角').toBe(155);

    expect(r.smashFront, '正面 0° 持盾冲撞必须命中').toBe(6);
    expect(r.smashSide40, '侧向 40° 超出持盾冲撞半角 22.5° ⇒ 打不中').toBe(20);
    expect(r.smashBack, '背后 170° 持盾冲撞打不中').toBe(20);
    // 同位置对照：证明 40° 这个位置本身可命中，且锥宽真的按招取
    expect(r.spinSide40, '对照组：侧向 40° 旋斩（半角 155°）必须命中').toBe(6);
    expect(r.swingSide40, '对照组：侧向 40° 横扫（半角 35°）也打不中 —— 持盾冲撞比它更窄').toBe(20);
  });

  /**
   * v3.03 举盾砸击的**射程 + 锥宽 + 砸下段画面**三合一验收。
   *
   * 前三项照 v3.01 持盾冲撞的同口径（四招射程同值 6.5 / 半角 22.5）；
   * 第四项是本招特有的：**砸下段真的在画面上发生**（t=1.59 峰值 → t=1.89 砸到底）。
   * 它守的是「时间重映射真的生效」—— 只测最终姿态时，warp 写成恒等也会全绿。
   */
  test('战斗/渲染(v3.03)：举盾砸击射程 6.5 / 半角 22.5，且砸下段在画面上真的发生', async ({ page }) => {
    await page.goto(`/?seed=${SEED}`);
    await waitWorldReady(page);
    await teleportToTarnCenter(page);
    await waitPlayerLanded(page);

    const r = await page.evaluate(async () => {
      const g = window.__MC_GAME__;
      const { IGNIS, IGNIS_ATTACKS } = await import('/src/entities/ignis/ignis-config.js');
      const p = g.player.physics.pos;
      const sum = g.ignises.summon('tarn:e2e:bash', Math.floor(p.x), Math.floor(p.z) + 3, 1, Math.floor(p.y));
      if (!sum.ok) return { err: sum.reason };
      const id = sum.id;
      await new Promise((res) => setTimeout(res, 600));
      const e0 = g.entities.get(id);
      if (!e0) return { err: 'entity gone' };
      const ex = e0.state.position[0], ey = e0.state.position[1], ez = e0.state.position[2];
      // 同 v3.01 口径：只改 x/z，y 保持玩家真实落地高度（否则 LOS 被地形挡 ⇒ 假落空）
      const hitAt = (dist, kind) => {
        g.player.physics.pos.x = ex;
        g.player.physics.pos.z = ez - dist;
        g.player.health = 20;
        const e = g.entities.get(id);
        e.state = { ...e.state, yaw: 0, attackRequest: { at: [ex, ey, ez], yaw: 0, kind } };
        g._consumeIgnisAttackRequests(performance.now());
        return g.player.health;
      };
      const hitAngle = (deg, kind) => {
        const rad = deg * Math.PI / 180, dist = 3.0;
        g.player.physics.pos.x = ex + Math.sin(rad) * dist;
        g.player.physics.pos.z = ez - Math.cos(rad) * dist;
        g.player.health = 20;
        const e = g.entities.get(id);
        e.state = { ...e.state, yaw: 0, attackRequest: { at: [ex, ey, ez], yaw: 0, kind } };
        g._consumeIgnisAttackRequests(performance.now());
        return g.player.health;
      };
      const out = {
        bash25: hitAt(2.5, 'shieldBash'),
        bash50: hitAt(5.0, 'shieldBash'),
        bash60: hitAt(6.0, 'shieldBash'),
        bash70: hitAt(7.0, 'shieldBash'),
        bashFront: hitAngle(0, 'shieldBash'),
        bashSide40: hitAngle(40, 'shieldBash'),
        bashBack: hitAngle(170, 'shieldBash'),
        // 对照组：同位置下旋斩（半角 155）必须命中，证明 40° 本身可判定
        spinSide40: hitAngle(40, 'spin'),
        bashRange: IGNIS_ATTACKS.shieldBash.hitRange,
        bashCone: IGNIS_ATTACKS.shieldBash.hitConeDeg,
        damage: IGNIS.attackDamage,
      };
      window.__E2E_ID__ = id;
      return out;
    });

    expect(r.err).toBeUndefined();
    expect(r.bashRange, '举盾砸击射程（四招同值）').toBe(6.5);
    expect(r.bashCone, '举盾砸击半角（arc 45 的一半）').toBe(22.5);
    expect(r.damage, '四招同伤害').toBe(14);
    expect(r.bash25, '2.5 格必须命中：20 → 6').toBe(6);
    expect(r.bash50, '5.0 格（站定环外沿）必须命中').toBe(6);
    expect(r.bash60, '6.0 格仍在射程内').toBe(6);
    expect(r.bash70, '7.0 格超出射程 6.5 ⇒ 打不中').toBe(20);
    expect(r.bashFront, '正面 0° 必须命中').toBe(6);
    expect(r.bashSide40, '侧向 40° 超出半角 22.5° ⇒ 打不中').toBe(20);
    expect(r.bashBack, '背后 170° 打不中').toBe(20);
    expect(r.spinSide40, '对照组：侧向 40° 旋斩必须命中').toBe(6);

    // ---- 砸下段的像素实测（冻结帧循环 + 手动 render，同 v3.01 口径）----
    await page.evaluate(() => window.__MC_GAME__.renderer.setAnimationLoop(null));
    await page.waitForTimeout(150);
    await installSettle(page);
    const poseAt = async (kind, t) => {
      await page.evaluate(async ([k, tt]) => {
        const g = window.__MC_GAME__;
        const { IGNIS_POSE_BLEND } = await import('/src/entities/ignis/ignis-config.js');
        const e = g.entities.get(window.__E2E_ID__);
        if (e) e.state = { ...e.state, mode: 'attack', attackKind: k, attackAnimT: tt, velocity: [0, 0, 0] };
        g.ignisRenderer.sync(g.ignises.activeEntities(), performance.now());
        window.__e2eSettle(Math.max(IGNIS_POSE_BLEND.seconds, IGNIS_POSE_BLEND.spinInSeconds, IGNIS_POSE_BLEND.bashInSeconds));
        g.renderer.render(g.scene, g.camera);
      }, [kind, t]);
      return shoot(page);
    };
    // 噪声底：同状态连拍必须逐位相同
    const n1 = await poseAt('shieldBash', 1.89);
    const n2 = await poseAt('shieldBash', 1.89);
    expect((await pixelDiff(page, n1, n2)).changed, '噪声底必须为 0').toBe(0);
    // 峰值（1.59s）vs 砸到底（1.89s）：画面必须显著不同
    const peakPix = await poseAt('shieldBash', 1.59);
    const slamPix = await poseAt('shieldBash', 1.89);
    const dSlam = await pixelDiff(page, peakPix, slamPix);
    expect(dSlam.changed, `砸下段像素差 ${dSlam.changed}（应远大于噪声底 0）`).toBeGreaterThan(1500);
    // 上界：不得整屏变（那是相机/场景挂了，不是动作）
    expect(dSlam.changed, `砸下段像素差 ${dSlam.changed} 过大（整屏重绘？）`).toBeLessThan(400000);
    await page.evaluate(() => window.__MC_GAME__.renderer.setAnimationLoop(null));
  });

  /**
   * v2.60：玩家站定不动时，焰魔**不得穿模**，且要能连续砍中。
   *
   * ## 为什么这条只能做成 E2E（Tier 4）
   *
   * 缺陷的两个面向分别需要「真物理 + 真 `_consumeIgnisAttackRequests` 锥判据」：
   * - 数据层看着都正常（`attackRequest` 每轮都出现一次、health 也真掉过一次）；
   * - 但玩家站定后焰魔会走到 `hDist ≈ 0`（穿过玩家），下一刀玩家在它背后，锥判据
   *   （半角 35°）全程跳过 ⇒ **只有一刀能打中**。
   *
   * 单测（`test-ignis-boss-agent.js`）钉了 agent 的行为面（最近距离 / 命中帧朝向 /
   * 原地连砍），这里钉真实帧循环里的最终观感与结算：**第二次及以上命中**。
   */
  test('战斗：玩家站定不动 → 焰魔停在几格外连续砍中，且不穿模（v2.60）', async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto(`/?seed=${SEED}`);
    await waitWorldReady(page);
    await teleportToTarnCenter(page);
    await waitPlayerLanded(page);

    const r = await page.evaluate(async () => {
      const g = window.__MC_GAME__;
      const { IGNIS_AI } = await import('/src/entities/ignis/ignis-config.js');
      const p0 = g.player.physics.pos;
      const start = [p0.x, p0.y, p0.z];
      // 召唤到玩家 11 格外（远于站定环）⇒ 必须走过来
      const sum = g.ignises.summon('tarn:e2e:3', Math.floor(p0.x), Math.floor(p0.z) + 11, 1);
      if (!sum.ok) return { err: sum.reason };
      const dists = [];
      const strikes = [];
      // ⚠️ 每刀 14、玩家 20 格血 ⇒ 第二刀就钳到 0（本仓"只扣血不死亡"）。
      // 每次命中后把血回满，否则第三刀起 0 → 0 看不到变化，"连砍"就测不出来了。
      const FULL_HP = g.player.health;
      let prevHp = FULL_HP;
      for (let i = 0; i < 150; i++) {          // 150 × 200ms = 30 秒
        await new Promise((res) => setTimeout(res, 200));
        const e = g.entities.get(sum.id);
        if (!e) break;
        const [ex, , ez] = e.state.position;
        const pp = g.player.physics.pos;
        dists.push(Math.hypot(ex - pp.x, ez - pp.z));
        if (g.player.health < prevHp) {
          strikes.push({ t: +(i * 0.2).toFixed(1), d: Math.hypot(ex - pp.x, ez - pp.z) });
          g.player.health = FULL_HP;
          prevHp = FULL_HP;
        }
      }
      const pp = g.player.physics.pos;
      return {
        strikeCount: strikes.length,
        strikes,
        minDist: Math.min(...dists),
        // 玩家自己没动（没受击位移）—— 若这条不为 0，说明距离变化来自玩家而非焰魔
        playerMoved: Math.hypot(pp.x - start[0], pp.z - start[2]),
        standoffRange: IGNIS_AI.standoffRange,
      };
    });

    expect(r.err).toBeUndefined();
    expect(r.playerMoved, '玩家应站定不动（否则测的不是 Boss 的行为）').toBeLessThan(0.5);
    // ① **不穿模**：任何时刻都不能挤到玩家身上（实测修前最小距 0.01 格）
    //    留 1 格余量：追击慢近时最后一步会落到站定环内侧，死区上半区容差
    expect(r.minDist, `最近只到 ${r.minDist?.toFixed(2)} 格（应停在站定环外）`)
      .toBeGreaterThan(r.standoffRange - 1.5);
    // ② **能连砍**：玩家站定 ⇒ 至少命中三刀（修前只有第一刀能中，第二刀起玩家在它背后）
    expect(r.strikeCount, `30 秒内只命中 ${r.strikeCount} 刀（站定时应能连砍）`)
      .toBeGreaterThanOrEqual(3);
    // ③ 命中发生在合理距离上（不是贴着 0 格砍）
    for (const s of r.strikes) {
      expect(s.d, `第 ${s.t}s 的命中距离只有 ${s.d.toFixed(2)} 格（应该相距几格）`)
        .toBeGreaterThan(r.standoffRange - 1.5);
    }
  });

  /**
   * v2.61：焰魔必须能**绕过方块障碍**走到玩家身边。
   *
   * ## 为什么这条只能做成 E2E
   *
   * 单测（`test-ignis-system.js` 的闭环用例）证明了「平面 + 一道墙」上能绕，但那是假世界。
   * 真实页面有三个单测盖不到的面：
   * ① `game.js` 的帧序（`ignises.update` 必须在 `entities.update` **之前**，否则绕行动作
   *    永远晚一拍）；② 真实 `WorldData` 的 `isSolid`（含 `opaqueTable` / `solidTable` 语义）；
   * ③ 真实 `editor.setBlock` 写盘后的 remesh/light 收敛时机（墙刚垒上时 column 是否已就绪）。
   *
   * ## 判据为什么是「血量下降」而不是「位移」
   *
   * 墙后的玩家看不见 ⇒ `attack` 进不去（起手要求视线通，这是刻意的）⇒ **只有绕过墙**
   * 到能看见的位置才可能扣血。于是「血量真的降了」同时钉住了「绕到了」与「绕完能打」。
   * 反向钉一条「墙还在」—— 防止实现改成拆方块过关。
   */
  test('寻路：玩家躲在墙后不动 → 焰魔绕过墙砍到人，且不拆墙（v2.61）', async ({ page }) => {
    test.setTimeout(240_000);
    await page.goto(`/?seed=${SEED}`);
    await waitWorldReady(page);
    await teleportToTarnCenter(page);
    await waitPlayerLanded(page);

    // ---- ① 垒墙：在玩家 +Z 侧 9 格处垒一道 15 格宽、高到天花板之下的墙 ----
    const built = await page.evaluate(() => {
      const g = window.__MC_GAME__;
      const p = g.player.physics.pos;
      const stone = g.registry.idOf('stone');
      const pz = Math.floor(p.z);
      const px = Math.floor(p.x);
      const wallZ = pz + 9;
      // 墙底从玩家脚底所在层开始，往上 6 格（焰魔 3.25 高，必须真的挡住）
      const feetY = Math.floor(p.y);
      let placed = 0;
      for (let dx = -7; dx <= 7; dx++) {
        for (let dy = 0; dy < 6; dy++) {
          g.editor.setBlock({ x: px + dx, y: feetY + dy, z: wallZ, id: stone });
          placed++;
        }
      }
      return { px, pz, wallZ, feetY, placed };
    });
    expect(built.placed, '墙应垒满 15×6 = 90 格').toBe(90);
    // 等 remesh / 光照收敛（墙刚写进去时 column 可能还在队列里）
    await page.waitForTimeout(2500);

    // ---- ② 把焰魔召到墙外侧（穿墙看不见玩家），然后站定 60 秒 ----
    const r = await page.evaluate(async (b) => {
      const g = window.__MC_GAME__;
      const { IGNIS_AI } = await import('/src/entities/ignis/ignis-config.js');
      const p0 = g.player.physics.pos;
      const start = [p0.x, p0.y, p0.z];
      // 召唤在墙另一侧：比墙再远 11 格 ⇒ 玩家 → 墙(9) → 焰魔(20)，直线视野被墙完全挡住
      const sum = g.ignises.summon('tarn:e2e:4', Math.floor(p0.x), b.wallZ + 11, 1, Math.floor(p0.y));
      if (!sum.ok) return { err: sum.reason };
      const FULL_HP = g.player.health;
      let prevHp = FULL_HP;
      let strikes = 0;
      let minDist = Infinity;
      let navDecisions = 0;
      let minWallBlocks = Infinity;
      for (let i = 0; i < 300; i++) {           // 300 × 200ms = 60 秒
        await new Promise((res) => setTimeout(res, 200));
        const e = g.entities.get(sum.id);
        if (!e) break;
        const [ex, , ez] = e.state.position;
        const pp = g.player.physics.pos;
        minDist = Math.min(minDist, Math.hypot(ex - pp.x, ez - pp.z));
        if (e.state.needsPath) navDecisions++;
        if (g.player.health < prevHp) {
          strikes++;
          g.player.health = FULL_HP;          // 回满以便测「多次命中」
          prevHp = FULL_HP;
        }
        // 墙还在？（每次抽样都数一遍，取最小值）
        if (i % 20 === 0) {
          let n = 0;
          for (let dx = -7; dx <= 7; dx++) {
            for (let dy = 0; dy < 6; dy++) {
              if (g.world.isSolid(b.px + dx, b.feetY + dy, b.wallZ)) n++;
            }
          }
          minWallBlocks = Math.min(minWallBlocks, n);
        }
        if (strikes >= 2) break;                // 砍到两刀就够了（不必跑满 60 秒）
      }
      const pp = g.player.physics.pos;
      return {
        strikes, minDist, navDecisions, minWallBlocks,
        playerMoved: Math.hypot(pp.x - start[0], pp.z - start[2]),
        standoffRange: IGNIS_AI.standoffRange,
      };
    }, built);

    expect(r.err).toBeUndefined();
    // ① 玩家自始至终站定（否则测的不是 Boss 的行为）
    expect(r.playerMoved, '玩家应站定不动').toBeLessThan(0.5);
    // ② **真的绕过去了**：墙挡住直线视野时它砍到了人
    expect(r.strikes, `60 秒内一刀没砍到（焰魔在墙后原地不动？minDist=${r.minDist?.toFixed(2)}）`)
      .toBeGreaterThanOrEqual(1);
    // ③ 走过寻路（否则可能是别的原因成立的）
    expect(r.navDecisions, '整个过程中一次寻路需求都没产生 —— 这条用例没测到绕行')
      .toBeGreaterThan(0);
    // ④ **不拆墙**：90 格必须全程都在
    expect(r.minWallBlocks, '墙被拆了 —— 实现应该是绕过去，不是清障')
      .toBe(90);
  });

  /**
   * v2.62 用户缺陷⑦：「玩家奔跑向焰魔，撞到焰魔的身体，焰魔应该不动如山，
   * 玩家也应当停止前进，就类似撞到实心方块一样」。
   *
   * ## 为什么只能做成 E2E
   *
   * 单测（`test-physics.js`）用**假 service** 证明了「玩家物理会消费 `overlapsAabb`」，
   * `test-ignis-system.js` 证明了「真 service 的 `overlapsAabb` 契约对」。但两者中间还有一段
   * 只有真实页面能盖住的接线：`game.js` 是否真的把 `this.ignises` 注入了 `player.physics`
   *（漏接线的形态是两侧单测全绿、游戏里玩家直接穿过焰魔）。
   *
   * ## 判据钉上下界（AGENTS.md）
   *
   * 只钉「没穿过」（下界）会漏掉「玩家根本就没走过去」的假绿；只钉上界会漏掉穿模。
   * 下界取身体盒半宽（0.71~0.83）+ 玩家半宽（0.3）的量级；上界取 3 格（再远就是没撞上）。
   */
  test('不动如山：玩家全速冲向焰魔 → 被身体挡住、焰魔不被推着走（v2.62）', async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto(`/?seed=${SEED}`);
    await waitWorldReady(page);
    await teleportToTarnCenter(page);
    await waitPlayerLanded(page);

    const r = await page.evaluate(async () => {
      const g = window.__MC_GAME__;
      const p0 = g.player.physics.pos;
      // 召唤到玩家 +Z 侧 7 格（在跳劈窗 [8,14] 之外 ⇒ 它只会走过来，不会跳劈干扰本用例）
      const sum = g.ignises.summon('tarn:e2e:7', Math.floor(p0.x), Math.floor(p0.z) + 7, 1, Math.floor(p0.y));
      if (!sum.ok) return { err: sum.reason };
      await new Promise((res) => setTimeout(res, 1500));   // 等它落地站稳
      const e0 = g.entities.get(sum.id);
      if (!e0) return { err: 'despawned' };
      const ignisStart = e0.state.position.slice();

      // 玩家转向焰魔（yaw=π ⇒ 前向 +Z，同本文件既有用例口径）并全速前进
      const px = g.player.physics.pos.x;
      const pz = g.player.physics.pos.z;
      g.player.yaw = (ignisStart[2] > pz) ? Math.PI : 0;
      g.player.keys.add('KeyW');

      const dists = [];
      const ignisTail = [];
      for (let i = 0; i < 30; i++) {          // 30 × 100ms = 3 秒
        await new Promise((res) => setTimeout(res, 100));
        const e = g.entities.get(sum.id);
        if (!e) break;
        const pp = g.player.physics.pos;
        dists.push(Math.hypot(e.state.position[0] - pp.x, e.state.position[2] - pp.z));
        ignisTail.push(e.state.position.slice());
      }
      g.player.keys.delete('KeyW');

      const e = g.entities.get(sum.id);
      // 「不动如山」：取最后 1 秒的焰魔位移（它应该已经站定，而不是被玩家推着退）
      const tail = ignisTail.slice(-10);
      let tailDrift = 0;
      if (tail.length > 1) {
        for (const q of tail) {
          tailDrift = Math.max(tailDrift,
            Math.hypot(q[0] - tail[0][0], q[2] - tail[0][2]));
        }
      }
      return {
        minDist: Math.min(...dists),
        finalDist: dists[dists.length - 1],
        tailDrift,
        ignisStart,
        ignisEnd: e ? e.state.position.slice() : null,
        playerX: g.player.physics.pos.x, playerZ: g.player.physics.pos.z,
        px, pz,
      };
    });
    console.log('[不动如山]', JSON.stringify(r));

    expect(r.err).toBeUndefined();
    // ① 玩家真的走到了焰魔跟前（否则测不到「撞」）
    expect(r.minDist, '玩家根本没靠近焰魔，本用例没测到阻挡').toBeLessThan(3.0);
    // ② **被身体挡住**：中心距不得小于「身体盒半宽 + 玩家半宽」的量级。
    // ⚠️ **下界必须是 1.0，不能是 0.8**（final review P2-3）：身体盒最窄半宽
    // `IGNIS_CORE_OBB.halfExtents[2]` = 0.7125 + 玩家半宽 0.3 = **1.0125**。
    // 写 0.8 会让「玩家停在 0.85 格」这种**已经穿进躯干**的形态变绿（判据无判别力，
    // AGENTS.md 已记的坑）；写 1.0 则「用了错的盒（例如碰撞盒 1.0 半宽）」也会被发现。
    // 实测值 1.36 格，两侧都有余量。
    expect(r.minDist, `玩家穿进了焰魔身体（最近 ${r.minDist?.toFixed(2)} 格，应 ≥ 1.0）`)
      .toBeGreaterThan(1.0);
    // ③ **焰魔不动如山**：最后 1 秒它几乎不动（被推着退会表现为持续位移）
    expect(r.tailDrift, `焰魔被玩家推着走了 ${r.tailDrift?.toFixed(2)} 格（应不动如山）`)
      .toBeLessThan(0.6);
  });

  /**
   * v2.78 用户缺陷：「玩家跑进焰魔，跑的太近就会和焰魔靠在一起，然后玩家就不能动弹了，
   * 跳也不行，前后左右都无法动弹，是发生穿模了吗？」
   *
   * ## 根因（真实游戏实测，不是几何推演）
   *
   * 焰魔的阻挡盒 = 身体 OBB 绕 yaw 旋转后的轴对齐包围盒，**随朝向变形**（yaw=0° 时重叠区单边 1.13，
   * 45° 时 1.54）。焰魔醒来 / 追击 / 起手都会转向玩家，盒子扫过站得近的玩家 ⇒ 玩家落进盒内（斜角站位
   * 陷入 0.3~0.4 格，而单步位移只有 0.133）。玩家物理把盒子当实心且没有「已经在里面」的分支 ⇒
   * 每个候选位置都仍重叠 ⇒ 四轴 + 跳跃全拒。焰魔侧的自愈（`overlapEscapeDist = 1.15`，仅 chase 态）
   * 在斜角站位 `d ≈ 1.4` 时从不触发 ⇒ 永久软锁。
   *
   * 修复前实测（seed=12345）：玩家站在盒斜角外，焰魔转到 −126° 后 **30/40 帧 `overlap=true`**，
   * W/S/A/D/Space 六个方向位移**全是 0**。
   *
   * ## 判据
   *
   * ① 场景有效：焰魔真的转了身（否则没测到「盒子扫过来」）；
   * ② 玩家被推出：重叠的采样帧极少、最终不重叠；
   * ③ 不冻结：远离 / 沿盒面平移 / 起跳都能动；
   * ④ 「不动如山」不变：朝焰魔里走仍被挡住（不陷进盒内）。
   */
  test('不卡死(v2.78)：玩家贴在焰魔盒斜角外，焰魔转身把盒子扫过来 → 被推出盒外，四向与跳跃都不冻结', async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto(`/?seed=${SEED}`);
    await waitWorldReady(page);
    await teleportToTarnCenter(page);
    await waitPlayerLanded(page);

    const r = await page.evaluate(async () => {
      const g = window.__MC_GAME__;
      const p0 = g.player.physics.pos;
      const sum = g.ignises.summon('tarn:e2e:stuck', Math.floor(p0.x), Math.floor(p0.z) + 8, 1, Math.floor(p0.y));
      if (!sum.ok) return { err: sum.reason };
      await new Promise((res) => setTimeout(res, 1500));              // 落地站稳
      const id = sum.id;
      const e = g.entities.get(id);
      // 压住它自己起手（本用例只观察「转身扫盒」）；朝向 yaw=0（此时盒最小）
      e.state = { ...e.state, yaw: 0, mode: 'idle', attackCooldown: 1e6, velocity: [0, 0, 0] };
      const ip = e.state.position;
      // 玩家紧贴 yaw=0 盒的**斜角**外侧：x 向盒边 0.826、+z 向盒边 0.503，各加玩家半宽 0.3 与 0.01
      g.player.spawn(ip[0] + 0.826 + 0.3 + 0.01, ip[1], ip[2] + 0.503 + 0.3 + 0.01);
      await new Promise((res) => setTimeout(res, 400));
      const pl0 = { x: g.player.physics.pos.x, z: g.player.physics.pos.z };

      // 焰魔「转身面向玩家」之后的朝向（与 Agent 的 `_angleTo` 同口径：yaw = atan2(−dx, −dz)，d = 玩家 − 焰魔）。
      // ⚠️ **把朝向钉在这个终态，不靠 AI 自然转身来制造「盒子扫到玩家」**：自然转身的终点取决于感知快照与
      // 时序（实测同一场景有的运行转到 −126°、有的转到 160°），后者盒子压根没扫到玩家 ⇒ 关掉修复后本用例
      // **空洞地通过**（负向对照实测踩到）。每 20ms 重置一次防止 AI 又转开；盒子「扫到」的瞬间就是下面这次赋值。
      const PIN = Math.atan2(-(pl0.x - ip[0]), -(pl0.z - ip[2]));
      const pin = setInterval(() => {
        const en0 = g.entities.get(id);
        if (en0) en0.state = { ...en0.state, yaw: PIN };
      }, 20);

      // 观察 4s：盒子已扫到玩家，玩家物理应把人推出
      const overlapSeries = [];
      const samples = 40;
      for (let i = 0; i < samples; i++) {
        await new Promise((res) => setTimeout(res, 100));
        overlapSeries.push(g.ignises.overlapsAabb(g.player.physics.aabb()) ? 1 : 0);
      }
      const overlapSamples = overlapSeries.reduce((a, b) => a + b, 0);
      const lateOverlap = overlapSeries.slice(20).reduce((a, b) => a + b, 0);   // 后 2 秒
      const finalOverlap = g.ignises.overlapsAabb(g.player.physics.aabb());
      const pl1 = g.player.physics.pos;
      const displacement = Math.hypot(pl1.x - pl0.x, pl1.z - pl0.z);

      // 面向焰魔（与 Agent 的 `_angleTo` 同口径：yaw = atan2(−dx, −dz)），逐键试 600ms
      const en = g.entities.get(id);
      const pp = g.player.physics.pos;
      g.player.yaw = Math.atan2(-(en.state.position[0] - pp.x), -(en.state.position[2] - pp.z));
      const home = { x: pp.x, y: pp.y, z: pp.z };
      const moved = {};
      for (const k of ['KeyW', 'KeyS', 'KeyA', 'KeyD', 'Space']) {
        g.player.spawn(home.x, home.y, home.z);
        await new Promise((res) => setTimeout(res, 150));
        const a = { x: g.player.physics.pos.x, y: g.player.physics.pos.y, z: g.player.physics.pos.z };
        g.player.keys.add(k);
        await new Promise((res) => setTimeout(res, 600));
        // 取按键期间的最大位移（Space 看峰值抬升，不看落地后的净位移）
        const b = g.player.physics.pos;
        moved[k] = {
          horiz: Math.hypot(b.x - a.x, b.z - a.z),
          up: b.y - a.y,
          overlapAfter: g.ignises.overlapsAabb(g.player.physics.aabb()),
        };
        g.player.keys.delete(k);
        await new Promise((res) => setTimeout(res, 150));
      }
      clearInterval(pin);
      return { overlapSamples, lateOverlap, samples, displacement, finalOverlap, moved };
    });
    console.log('[不卡死]', JSON.stringify(r));

    expect(r.err).toBeUndefined();
    // ① 场景有效：盒子确实「罩住」过玩家 —— 要么观察到重叠（修复前 36/40），要么玩家被推开了（修复后位移 ≈ 陷入深度
    // 0.3~0.4 格）。两者都没有 ⇒ 盒子根本没扫到玩家，本用例会在关掉修复后**空洞地通过**（负向对照实测踩到）。
    expect(r.overlapSamples >= 1 || r.displacement >= 0.1,
      `场景无效：盒子没罩住玩家（重叠采样 ${r.overlapSamples}、玩家位移 ${r.displacement.toFixed(3)} 格）`).toBe(true);
    // ② 被推出。实测（朝向钉死后，确定性）：修复后盒子扫到的下一个物理步（≤ 16ms）就被推出，100ms 间隔的采样
    // 几乎碰不到重叠 —— 3 次运行均为 0/40、玩家被推开 0.29~0.40 格；关掉推出：一次 40/40 且五个键位移全 0，
    // 一次 13/40（焰魔自己走开后才解除）。故两道判据：后 2 秒必须 0 次重叠（钉「不再持续被罩住」），
    // 全程 ≤ 4（修复后 0 与修复前最小 13 之间；不取 10 —— 离 13 太近，焰魔恰好早走开时会漏）。
    expect(r.lateOverlap, `后 2 秒的 20 个采样里有 ${r.lateOverlap} 个仍处在焰魔身体盒内（玩家被罩住没有被推出）`)
      .toBe(0);
    expect(r.overlapSamples, `40 个采样里有 ${r.overlapSamples} 个处在焰魔身体盒内（应被很快推出）`)
      .toBeLessThanOrEqual(4);
    expect(r.finalOverlap, '4 秒后玩家仍在焰魔身体盒内').toBe(false);
    // ③ 不冻结：远离(S) / 沿盒面平移(A、D) 都能走 ≥ 1 格；起跳能离地 ≥ 0.5 格（修复前全是 0）
    for (const k of ['KeyS', 'KeyA', 'KeyD']) {
      expect(r.moved[k].horiz, `${k} 位移 ${r.moved[k].horiz.toFixed(3)} 格：玩家被冻住了`).toBeGreaterThan(1.0);
    }
    expect(r.moved.Space.up, `起跳只抬升了 ${r.moved.Space.up.toFixed(3)} 格：玩家被冻住了`).toBeGreaterThan(0.5);
    // ④ 不动如山不变：朝焰魔里走（W）仍被盒子挡住，不陷进去
    expect(r.moved.KeyW.overlapAfter, '按 W 朝焰魔里走后陷进了身体盒（不动如山失效）').toBe(false);
  });

  /**
   * v2.62 用户缺陷⑥：「距离玩家一定的距离，就执行一个飞跃向前的动作，落点刚好就在
   * 玩家的面前，飞跃到快触碰到地面的时候，执行当前的劈砍的动作」。
   *
   * 判据三层：① 真的进了 `leap(attack)`（而不是直接走过来）；② 随后进了 `attack`；
   * ③ 玩家真的被砍到（跳完砍得到 —— 落点预判与命中锥都对）。
   */
  test('跳跃劈砍：相距 ~11 格 → 飞跃向前、近地起劈、砍中玩家（v2.62）', async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto(`/?seed=${SEED}`);
    await waitWorldReady(page);
    await teleportToTarnCenter(page);
    await waitPlayerLanded(page);

    const r = await page.evaluate(async () => {
      const g = window.__MC_GAME__;
      const p0 = g.player.physics.pos;
      const start = [p0.x, p0.y, p0.z];
      // 召唤到玩家 +Z 侧 11 格 —— 正好在跳劈窗 [leapAttackMin, leapAttackMax] 内
      const sum = g.ignises.summon('tarn:e2e:6', Math.floor(p0.x), Math.floor(p0.z) + 11, 1, Math.floor(p0.y));
      if (!sum.ok) return { err: sum.reason };
      const FULL_HP = g.player.health;
      let prevHp = FULL_HP;
      let sawLeapAttack = false;
      let sawAttackAfterLeap = false;
      let strikes = 0;
      let minDist = Infinity;
      let maxLeapY = -Infinity;
      const modes = new Set();
      for (let i = 0; i < 150; i++) {          // 150 × 100ms = 15 秒
        await new Promise((res) => setTimeout(res, 100));
        const e = g.entities.get(sum.id);
        if (!e) break;
        const st = e.state;
        modes.add(st.mode + (st.leapKind ? ':' + st.leapKind : ''));
        if (st.mode === 'leap' && st.leapKind === 'attack') {
          sawLeapAttack = true;
          maxLeapY = Math.max(maxLeapY, st.position[1]);
        }
        if (sawLeapAttack && st.mode === 'attack') sawAttackAfterLeap = true;
        const pp = g.player.physics.pos;
        minDist = Math.min(minDist, Math.hypot(st.position[0] - pp.x, st.position[2] - pp.z));
        if (g.player.health < prevHp) {
          strikes++;
          g.player.health = FULL_HP;           // 回满以便测多次命中（20 格血 ÷ 14 伤害）
          prevHp = FULL_HP;
        }
        if (sawAttackAfterLeap && strikes >= 1) break;
      }
      const pp = g.player.physics.pos;
      return {
        sawLeapAttack, sawAttackAfterLeap, strikes, minDist, maxLeapY,
        modes: [...modes],
        playerMoved: Math.hypot(pp.x - start[0], pp.z - start[2]),
      };
    });
    console.log('[跳跃劈砍]', JSON.stringify(r));

    expect(r.err).toBeUndefined();
    expect(r.playerMoved, '玩家应站定不动（否则测的不是 Boss 的行为）').toBeLessThan(0.5);
    // ① 真的飞跃了（而不是单纯走过来）
    expect(r.sawLeapAttack, `从未进入 leap(attack)，实际经过的状态：${r.modes.join(',')}`)
      .toBe(true);
    // ② 飞跃后接上了劈砍
    expect(r.sawAttackAfterLeap, '飞跃后没有起劈（应「快触地时执行劈砍」）').toBe(true);
    // ③ 跳完砍得到
    expect(r.strikes, `跳跃劈砍后一刀没砍中（落点预判或命中锥不对）`)
      .toBeGreaterThanOrEqual(1);
  });

  /**
   * v2.62 用户缺陷⑤：「当焰魔卡住不动的时候，比如卡住 4 秒钟，就飞跃出来，
   * 不要陷在卡住的位置一直动弹不得」。
   *
   * ## 围栏为什么是 2 格高
   *
   * `leapJumpForce`(11) 的抛物线顶点 = `v²/(2|g|) = 121/48 ≈ 2.52` 格（spec §3.2 的标定：
   * 「越得过 2 格障碍」）。3 格高的墙它跳不出去 —— 那不是本用例要测的「卡住」，
   * 而是「真的困死了」（spec §6 已记：焰魔不拆方块，绕不过去就走不过去）。
   * 2 格高也超过 `maxStep`(1.0) ⇒ step-up 上不去，只能靠飞跃。
   */
  test('围困脱困：2 格高围栏困住焰魔 → 卡住约 4 秒后飞跃出来（v2.62）', async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto(`/?seed=${SEED}`);
    await waitWorldReady(page);
    await teleportToTarnCenter(page);
    await waitPlayerLanded(page);

    // ---- ① 先召焰魔，读它落地后的真实位置，再围着那个位置垒栏 ----
    const built = await page.evaluate(async () => {
      const g = window.__MC_GAME__;
      const p0 = g.player.physics.pos;
      const sum = g.ignises.summon('tarn:e2e:5', Math.floor(p0.x), Math.floor(p0.z) + 6, 1, Math.floor(p0.y));
      if (!sum.ok) return { err: sum.reason };
      await new Promise((res) => setTimeout(res, 1500));   // 等落地站稳
      const e = g.entities.get(sum.id);
      if (!e) return { err: 'despawned' };
      const [ex, ey, ez] = e.state.position;
      const cx = Math.floor(ex), cz = Math.floor(ez);
      const feetY = Math.floor(ey);
      const stone = g.registry.idOf('stone');
      // 切比雪夫距离 **2** 的闭合围栏，高 2 格（y = feetY, feetY+1）。
      //
      // ⚠️ **半径必须是 2，不能是 3**（首轮实测逼出来的）：半径 3 的围栏内部有 5×5 格
      // 空间，焰魔能贴着内壁**滑动**追玩家 —— 每帧都有进展 ⇒ `stuckT` 被正确清零
      //（实测 15 秒只累到 0.0166 = 恰好一帧）。那不是用户说的「卡住不动」。
      //
      // ⚠️ **也不能是 1**：焰魔 halfWidth 0.5 ⇒ `aabbCollidesAt` 采样 floor(px±0.5) 共 2 格，
      // 墙贴在 1 格外会让它**出生即被埋** ⇒ 走的是 Task 4 的 `_resolveStuck`（直接抬到墙顶）
      // 而不是本用例要测的脱困飞跃。
      // 半径 2 恰好：可移动范围 ≈ 1 格（约 0.23 秒走到头）⇒ 之后真的动不了。
      let placed = 0;
      for (let dx = -2; dx <= 2; dx++) {
        for (let dz = -2; dz <= 2; dz++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== 2) continue;   // 只要环
          for (let dy = 0; dy < 2; dy++) {
            g.editor.setBlock({ x: cx + dx, y: feetY + dy, z: cz + dz, id: stone });
            placed++;
          }
        }
      }
      return { id: sum.id, cx, cz, feetY, placed, ex, ey, ez, px: p0.x, py: p0.y, pz: p0.z };
    });
    expect(built.err).toBeUndefined();
    expect(built.placed, '围栏应垒满 16 格 × 2 层 = 32').toBe(32);
    await page.waitForTimeout(2500);           // 等 remesh / 光照收敛

    // ---- ② 把玩家移到远处（关键！）----
    //
    // ⚠️ **这一步是实测逼出来的**（首轮失败：`stuckT` 只到 0.0166 = 恰好一帧）：
    // 召唤点只离玩家 6 格，而 `hitRange` 是 6.5 ⇒ 焰魔站在围栏里就能砍到人 ⇒
    // 一直停在 `attack` 态（意图恒 0）⇒ `stuckT` 被**正确地**清零（能砍到人的焰魔
    // 本来就不算「卡住」）。要测脱困，必须让它**够不着玩家、非得移动不可**：
    // 移到 25 格外 ⇒ > `attackRange`(5.5) 且 > `leapAttackMax`(14) ⇒ 只能 chase 走过来。
    await page.evaluate((b) => {
      const g = window.__MC_GAME__;
      g.player.spawn(b.px, b.py, b.cz - 22);   // 移到围栏另一侧远处（-Z）
    }, built);
    await waitPlayerLanded(page);

    // ---- ③ 观察 15 秒：它应该卡住约 4 秒后飞跃出来 ----
    const r = await page.evaluate(async (b) => {
      const g = window.__MC_GAME__;
      let sawLeap = false;
      let sawEscape = false;
      let escaped = false;
      let maxStuckT = 0;
      let maxY = -Infinity;
      let minDistToCenter = Infinity;
      const modes = new Set();
      for (let i = 0; i < 150; i++) {          // 15 秒
        await new Promise((res) => setTimeout(res, 100));
        const e = g.entities.get(b.id);
        if (!e) break;
        const st = e.state;
        modes.add(st.mode + (st.leapKind ? ':' + st.leapKind : ''));
        maxStuckT = Math.max(maxStuckT, st.stuckT || 0);
        maxY = Math.max(maxY, st.position[1]);
        if (st.mode === 'leap') {
          sawLeap = true;
          if (st.leapKind === 'escape') sawEscape = true;
        }
        // 脱困判据：脚底高过栏顶（feetY+2）或水平出了围栏（切比雪夫距 > 2.5）
        const dCheb = Math.max(Math.abs(st.position[0] - (b.cx + 0.5)),
          Math.abs(st.position[2] - (b.cz + 0.5)));
        minDistToCenter = Math.min(minDistToCenter, dCheb);
        if (st.position[1] > b.feetY + 2 || dCheb > 2.5) escaped = true;
        if (escaped && sawEscape) break;
      }
      const e = g.entities.get(b.id);
      return {
        sawLeap, sawEscape, escaped, maxStuckT, maxY,
        finalPos: e ? e.state.position.slice() : null,
        finalMode: e ? e.state.mode : null,
        modes: [...modes], feetY: b.feetY, cx: b.cx, cz: b.cz,
      };
    }, built);
    console.log('[围困脱困]', JSON.stringify(r));

    // ① 真的卡住过（stuckT 累计起来了 —— 否则本用例没测到「卡住」这个前提）
    expect(r.maxStuckT, `stuckT 只到 ${r.maxStuckT?.toFixed(2)}，围栏没真的困住它（modes=${r.modes}）`)
      .toBeGreaterThan(1.0);
    // ② 触发了脱困飞跃
    expect(r.sawEscape, `从未进入 leap(escape)，实际状态：${r.modes.join(',')}`).toBe(true);
    // ③ 真的出来了
    expect(r.escaped,
      `飞跃了但没出来（finalPos=${JSON.stringify(r.finalPos)}, feetY=${r.feetY}, maxY=${r.maxY?.toFixed(2)}）`)
      .toBe(true);
  });

  /**
   * v2.84 用户需求：「现在的跳跃高度不是很高，如果焰魔掉入了一个很深的深坑……可以计算焰魔被困住
   * 所在的高度 y 和玩家所在的高度 y 之间的差，相差多高，就通过跳跃多高来脱困，只有数次普通跳跃
   * 没有成功脱困的时候才进行高跳来脱困」。
   *
   * ## 为什么围墙必须是 4 格（Tier 4 首轮实测逼出来的）
   *
   * 3 格高的墙**普通跳就能上去**（顶点 2.52 ⇒ 脚底 12.5，而墙顶在 y=12，借 step-up 落地），
   * 首次跳就脱困了 ⇒ 本用例的前提不成立。4 格墙的墙顶在 y=13，要站上去得脚底 ≥ 14（= 起点 + 4），
   * 普通跳到不了；而它又超过 `maxStep`(1.0) ⇒ step-up 也上不去。
   *
   * ## 判据（三层）
   *
   * ① 至少发生 4 次 escape 跳；
   * ② 前 3 次普通跳的**最高脚底**都在普通跳顶点的量级（≈ 2.5 格）⇒ 爬不上 4 格墙；
   * ③ 第 4 次的最高脚底 ≥ 起点 + 3.6（强化跳顶点 4 格），且真的出了围。
   *
   * ⚠️ **不要断言起跳 vy**：本用例是 100ms 轮询，拿不到起跳那一瞬的值
   *（采到的是飞行中途已被重力衰减的 vy，实测差 1.2 格/秒）。峰值高度则是采样不敏感的。
   * ⚠️ 玩家必须移到 `leapAttackMax`(14) 之外：否则焰魔会先尝试跳劈，`escape` 计数不推进。
   */
  test('脱困高跳：4 格围墙困住 → 前 3 次普通跳出不去，第 4 次强化跳越出（v2.84）', async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto(`/?seed=${SEED}`);
    await waitWorldReady(page);
    await teleportToTarnCenter(page);
    await waitPlayerLanded(page);

    // ---- ① 召焰魔、读它落地后的真实位置，再围着它垒 4 格高的围栏 ----
    const built = await page.evaluate(async () => {
      const g = window.__MC_GAME__;
      const p0 = g.player.physics.pos;
      const sum = g.ignises.summon('tarn:e2e:9', Math.floor(p0.x), Math.floor(p0.z) + 6, 1, Math.floor(p0.y));
      if (!sum.ok) return { err: sum.reason };
      await new Promise((res) => setTimeout(res, 1500));
      const e = g.entities.get(sum.id);
      if (!e) return { err: 'despawned' };
      const [ex, ey, ez] = e.state.position;
      const cx = Math.floor(ex), cz = Math.floor(ez);
      const feetY = Math.floor(ey);
      const stone = g.registry.idOf('stone');
      // 切比雪夫半径 2 的闭合围栏（理由同上面的 2 格围栏用例：半径 1 会出生即被埋），高 **4** 格
      let placed = 0;
      for (let dx = -2; dx <= 2; dx++) {
        for (let dz = -2; dz <= 2; dz++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== 2) continue;
          for (let dy = 0; dy < 4; dy++) {
            g.editor.setBlock({ x: cx + dx, y: feetY + dy, z: cz + dz, id: stone });
            placed++;
          }
        }
      }
      return { id: sum.id, cx, cz, feetY, placed, px: p0.x, py: p0.y, pz: p0.z };
    });
    expect(built.err).toBeUndefined();
    expect(built.placed, '围栏应垒满 16 格 × 4 层 = 64').toBe(64);
    await page.waitForTimeout(2500);           // 等 remesh / 光照收敛

    // ---- ② 玩家移到 22 格外：> attackRange 与 leapAttackMax ⇒ 只能 chase 走过来 ----
    await page.evaluate((b) => {
      window.__MC_GAME__.player.spawn(b.px, b.py, b.cz - 22);
    }, built);
    await waitPlayerLanded(page);

    // ---- ③ 观察 25 秒：每 100ms 采一份，记录每次 escape 起跳的 vy 与最高脚底 ----
    const r = await page.evaluate(async (b) => {
      const g = window.__MC_GAME__;
      const hops = [];                 // 每次 escape 起跳的 vy（物理后值）+ "是否越过墙顶"
      let prevMode = '';
      let maxY = -Infinity;
      let escaped = false;
      const modes = new Set();
      for (let i = 0; i < 250; i++) {          // 25 秒
        await new Promise((res) => setTimeout(res, 100));
        const e = g.entities.get(b.id);
        if (!e) break;
        const st = e.state;
        const tag = st.mode + (st.leapKind ? ':' + st.leapKind : '');
        modes.add(tag);
        maxY = Math.max(maxY, st.position[1]);
        // 新的一次 escape 起跳：failCount 递增且当前在 leap:escape
        if (st.mode === 'leap' && st.leapKind === 'escape'
          && hops.length < (st.escapeFailCount || 0)) {
          hops.push({ vy: st.velocity[1], maxY: st.position[1], fail: st.escapeFailCount });
        }
        // 本次跳期间的最高脚底（用于「普通跳越不过墙顶」）
        if (hops.length && st.position[1] > hops[hops.length - 1].maxY) {
          hops[hops.length - 1].maxY = st.position[1];
        }
        // 脱困：站上墙顶（脚底 ≥ feetY+4）或水平出了围栏
        const dCheb = Math.max(Math.abs(st.position[0] - (b.cx + 0.5)),
          Math.abs(st.position[2] - (b.cz + 0.5)));
        if (st.position[1] >= b.feetY + 4 - 0.05 || dCheb > 2.5) { escaped = true; break; }
      }
      return { hops, escaped, maxY, modes: [...modes], feetY: b.feetY };
    }, built);
    console.log('[脱困高跳]', JSON.stringify(r));

    // ① 真的发生了多次 escape（否则本用例什么都没测到）
    expect(r.hops.length, `escape 起跳次数 ${r.hops.length}（应 ≥ 4，modes=${r.modes.join(',')}）`)
      .toBeGreaterThanOrEqual(4);
    // ② 前 3 次是普通跳：峰值高度落在「顶点 2.52」的量级，且**必然爬不上 4 格墙**
    //    （墙顶 = 起点 + 4；普通跳脚底最高只到 起点 + ~2.45）
    for (let i = 0; i < 3; i++) {
      const rise = r.hops[i].maxY - r.feetY;
      expect(rise, `第 ${i + 1} 次普通跳只应升高 ~2.5 格，实测 ${rise.toFixed(2)}`).toBeLessThan(3.0);
      expect(rise, `第 ${i + 1} 次根本没跳起来（升高 ${rise.toFixed(2)}）`).toBeGreaterThan(1.5);
    }
    // ③ 第 4 次是强化跳：顶点 4 格（≥ 3.6 才算真的到了强化档）
    const rise4 = r.hops[3].maxY - r.feetY;
    expect(rise4, `第 4 次应是 4 格顶点的强化跳，实测升高 ${rise4.toFixed(2)}`).toBeGreaterThanOrEqual(3.6);
    // ④ 强化跳真的把它弄出去了
    expect(r.escaped,
      `强化跳后仍在围栏内（maxY=${r.maxY.toFixed(2)}, 墙顶=${r.feetY + 4}, modes=${r.modes.join(',')}）`)
      .toBe(true);
  });

  /**
   * v2.63 用户第③项：「不是每时每刻都检测玩家位置，而是间隔最快 1 秒检测玩家位置，
   * 根据这个检测到的玩家位置进行位置移动和转向」。
   *
   * ## 为什么需要这条 E2E（单测盖不住什么）
   *
   * 单测证明了 Agent 读快照、且快照按间隔刷新。但真实页面有三个单测盖不住的面：
   * ① 帧循环真的以 60fps 驱动（单测是手动喂 dt）；② 玩家真的在跑（`keys.add` 路径）；
   * ③ **行为后果**：焰魔是不是真的在追「1~2 秒前的你」而不是当前的你。
   *
   * ## 判据（三层，缺一不可）
   *
   * ① 刷新次数：4 秒内 `sensedPlayer` 的变更次数必须远小于帧数（每帧刷新 = 机制失效）；
   * ② 滞后量：存在时刻「快照 vs 真实位置」差 > 2 格（玩家 8 格/秒 × 1~2 秒 ⇒ 应有 8~16 格）；
   * ③ **行为**：焰魔的行进方向更接近「快照方向」而不是「真实玩家方向」——
   *   这是用户真正要的东西（前两条只证明机制在跑，不证明它被用上了）。
   */
  test('感知间隔：玩家跑动时焰魔追的是「1~2 秒前的你」，不是每帧跟随（v2.63）', async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto(`/?seed=${SEED}`);
    await waitWorldReady(page);
    await teleportToTarnCenter(page);
    await waitPlayerLanded(page);

    const r = await page.evaluate(async () => {
      const g = window.__MC_GAME__;
      const p0 = g.player.physics.pos;
      // 召唤到玩家 +Z 侧 12 格（在跳劈窗内，但本用例只看追击方向，跳劈不影响判据）
      const sum = g.ignises.summon('tarn:e2e:8', Math.floor(p0.x), Math.floor(p0.z) + 12, 1, Math.floor(p0.y));
      if (!sum.ok) return { err: sum.reason };
      await new Promise((res) => setTimeout(res, 2500));   // 等它落地 + 完成首次感知
      const e0 = g.entities.get(sum.id);
      if (!e0) return { err: 'despawned' };

      // 玩家横向（+X）全速跑动 4 秒：yaw=-π/2 ⇒ 前向 +X（同本文件既有用例口径）
      g.player.yaw = -Math.PI / 2;
      g.player.keys.add('KeyW');

      const samples = [];
      let prevSensed = null;
      let refreshes = 0;
      for (let i = 0; i < 40; i++) {          // 40 × 100ms = 4 秒
        await new Promise((res) => setTimeout(res, 100));
        const e = g.entities.get(sum.id);
        if (!e) break;
        const st = e.state;
        const pp = g.player.physics.pos;
        const sensed = st.sensedPlayer;
        if (sensed) {
          // 快照变更计数（位置差 > 1e-6 才算一次刷新）
          if (!prevSensed
            || Math.hypot(sensed[0] - prevSensed[0], sensed[2] - prevSensed[2]) > 1e-6) {
            refreshes++;
          }
          prevSensed = sensed.slice();
          samples.push({
            ex: st.position[0], ez: st.position[2],
            px: pp.x, pz: pp.z,
            sx: sensed[0], sz: sensed[2],
            yaw: st.yaw,
            lag: Math.hypot(sensed[0] - pp.x, sensed[2] - pp.z),
            mode: st.mode,
          });
        }
      }
      g.player.keys.delete('KeyW');

      // ③ 行为判据（直接对应用户原文「面向一直朝向玩家」）：
      //    量 **yaw 与「朝真实玩家」的夹角**。每帧跟随（v2.62）时 chase 的 yaw 朝行进
      //    方向、而行进方向朝真实玩家 ⇒ 夹角恒≈ 0；有感知间隔（v2.63）时行进方向朝
      //    **快照**，而快照滞后于横向跑动的玩家 ⇒ 夹角必然显著偏离 0。
      //    ⚠️ 不用「朝快照 vs 朝真实」的细微比较（实测踩到：玩家横跑、焰魔纵追时
      //    两个方向在 -Z 主轴上夹角都只有 0.2~0.3 rad，被 navDir/steering 噪声淹没）。
      const norm = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
      let maxYawOff = 0, sumYawOff = 0, compared = 0;
      for (const b of samples) {
        if (b.mode !== 'chase' || b.lag <= 3) continue;
        // 朝真实玩家的角度（本仓 yaw 口径：前向 = (−sin yaw, −cos yaw) ⇒ yaw = atan2(−dx, −dz)）
        const want = Math.atan2(-(b.px - b.ex), -(b.pz - b.ez));
        const off = Math.abs(norm(b.yaw - want));
        maxYawOff = Math.max(maxYawOff, off);
        sumYawOff += off;
        compared++;
      }
      return {
        refreshes,
        sampleCount: samples.length,
        maxLag: samples.length ? Math.max(...samples.map((s) => s.lag)) : 0,
        maxYawOff,
        avgYawOff: compared ? sumYawOff / compared : null,
        compared,
      };
    });
    console.log('[感知间隔]', JSON.stringify(r));

    expect(r.err).toBeUndefined();
    // ① 快照不是每帧刷新：4 秒 / 最快 1 秒间隔 ⇒ 最多约 5 次（含首次）。
    //    每帧刷新（60fps × 4s = 240 帧，采样 40 次）会让这个数接近采样数。
    expect(r.refreshes, `sensedPlayer 在 4 秒内刷新了 ${r.refreshes} 次（应 ≤ 6，每帧刷新就是机制失效）`)
      .toBeLessThanOrEqual(6);
    expect(r.refreshes, '快照一次都没刷新过（应至少按间隔重采）').toBeGreaterThanOrEqual(2);
    // ② 真的有滞后：玩家 8 格/秒 × 1~2 秒间隔 ⇒ 滞后应有数格
    expect(r.maxLag, `快照与真实位置最大只差 ${r.maxLag?.toFixed(2)} 格（应 > 2，否则等于实时跟随）`)
      .toBeGreaterThan(2);
    // ③ 行为：yaw 不是一直精确对准真实玩家（用户原文「不要一直朝向玩家」）。
    //    阈值 0.15 rad ≈ 8.6°：每帧跟随时该值恒≈ 0（行进方向即朝真实玩家）；
    //    滞后 9 格、玩家横跑 16 格时，朝快照与朝真实玩家的夹角在 30°+ 量级。
    expect(r.compared, '没有可用采样点（滞后 > 3 格且在 chase 的帧太少）').toBeGreaterThan(3);
    expect(r.maxYawOff,
      `yaw 与「朝真实玩家」的最大夹角只有 ${(r.maxYawOff * 180 / Math.PI).toFixed(1)}°（应 > 8.6°，否则就是每帧精确跟随）`)
      .toBeGreaterThan(0.15);
  });
});

/**
 * v3.29（用户 2026-11-21）：焰魔的两处小额 AoE 伤害各扣玩家 1 格。
 *
 * 用户原文：「剑阵攻击的剑阵刺到玩家，玩家也掉 1 格血，法阵的图案如果在玩家脚底生成，
 * 玩家也掉 1 格血」。
 *
 * ## 驱动方式
 *
 * 与既有「旋斩锥宽」用例同一手法：把 `attackFxRequest` 直接塞进 state → **同步**调一次
 * 唯一的消费点 `_consumeIgnisFxRequests`。`attackFxRequest` 是瞬态（Agent 下一帧清 null），
 * 等 AI 自然起手不可控且慢。
 *
 * ## 站位（真实落点，不是手算想象）
 *
 * - 法阵：`sigilSpawnPoints` 的段落 z = 焰魔z − {0, 4.25, 8.5, 12.75}，半宽 2.0。
 *   玩家站在焰魔脚底 ⇒ 首段（z=焰魔z）压住。
 * - 尖刺：`spikeSpawnPoints` 的正前方（deg=0）六根刺心 z = 焰魔z − {2,4,6,8,10,12}。
 *   玩家站在焰魔z − 6（第 3 根，格 z ∈ [焰魔z−7, 焰魔z−6)）⇒ 命中。
 */
test('战斗(v3.29)：法阵落在玩家脚下 ⇒ 扣 1 格', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto(`/?seed=${SEED}`);
  await waitWorldReady(page);
  await teleportToTarnCenter(page);
  await waitPlayerLanded(page);

  const r = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    const { IGNIS_AOE } = await import('/src/entities/ignis/ignis-config.js');
    const p = g.player.physics.pos;
    // 焰魔召到玩家正前方 1 格，然后把玩家放回它脚底（法阵首段就在脚底）
    const sum = g.ignises.summon('tarn:e2e:aoe', Math.floor(p.x), Math.floor(p.z) - 1, 1);
    if (!sum.ok) return { err: sum.reason };
    const ent = g.entities.get(sum.id);
    if (!ent) return { err: 'entity-missing' };
    const e = ent;
    const at = e.state.position;
    g.player.physics.pos.x = at[0];
    g.player.physics.pos.z = at[2];
    const hpBefore = g.player.health;
    e.state.attackFxRequest = { at: [...at], yaw: 0, kind: 'shieldBash' };
    g._consumeIgnisFxRequests(performance.now());
    return { hpBefore, hpAfter: g.player.health, expect: IGNIS_AOE.damage };
  });

  expect(r.err).toBeUndefined();
  expect(r.hpBefore - r.hpAfter, `法阵须扣 ${r.expect} 格（实得 ${r.hpBefore} → ${r.hpAfter}）`)
    .toBe(r.expect);
});

test('战斗(v3.29)：剑阵尖刺刺到玩家 ⇒ 扣 1 格（不是 18）', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto(`/?seed=${SEED}`);
  await waitWorldReady(page);
  await teleportToTarnCenter(page);
  await waitPlayerLanded(page);

  const r = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    const { IGNIS_AOE } = await import('/src/entities/ignis/ignis-config.js');
    const p = g.player.physics.pos;
    const sum = g.ignises.summon('tarn:e2e:spike2', Math.floor(p.x), Math.floor(p.z) - 6, 1);
    if (!sum.ok) return { err: sum.reason };
    const ent = g.entities.get(sum.id);
    if (!ent) return { err: 'entity-missing' };
    const e = ent;
    const at = e.state.position;   // 脚底
    // yaw=0 ⇒ 正前方 = z 递减；第 3 根刺心 = at[2] − 6（格 z ∈ [at[2]−7, at[2]−6)）
    // ⚠️ **y 也要对齐焰魔脚底**：实测焰魔落在地表 y=3 而玩家可能站在更高的一层（y=5），
    // 只改 x/z 会让玩家悬在刺上方 2 格 ⇒ 刺的格与玩家 AABB 不重叠 ⇒ 静默不扣血。
    g.player.physics.pos.x = at[0];
    g.player.physics.pos.z = at[2] - 6;
    g.player.physics.pos.y = at[1];
    g.player.physics.vel.y = 0;
    const hpBefore = g.player.health;
    e.state.attackFxRequest = { at: [...at], yaw: 0, kind: 'spikeSlash' };
    g._consumeIgnisFxRequests(performance.now());
    return { hpBefore, hpAfter: g.player.health, expect: IGNIS_AOE.damage };
  });

  expect(r.err).toBeUndefined();
  expect(r.hpBefore - r.hpAfter, `尖刺须扣 ${r.expect} 格（不再是 18）`).toBe(r.expect);
});
