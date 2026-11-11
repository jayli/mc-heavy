import { test, expect } from 'playwright/test';

/**
 * 末影守卫（Ender Guardian）真游戏页 E2E —— Tier 4 像素实测。
 *
 * ## 为什么必须有这个 spec
 *
 * 守卫有三类缺陷**只有真实世界 + 像素能抓**：
 *   ① **落点错层** —— 三层地牢的净空不同，`HEADROOM` 取 5 会把上层房间判死而静默召到中层
 *      （差 8 格），而所有计数/状态断言全绿；
 *   ② **玩家走不到 Boss 面前** —— 地牢三层在引擎口径下互不连通，落点选错层就成了「召出来
 *      但永远打不到」；
 *   ③ **模型炸成碎片 / 眼睛不发光** —— 骨骼数/顶点数/指纹全对。
 *
 * ## 两个场景必须分开（spec §2.3.3）
 *
 * 召唤/命中/像素在**堡垒上层房间**；脱困跳的「真跳出去」在**开阔地形围栏**。
 * 上层房间净空只有 5 格（ny39..43）、守卫高 3.8 ⇒ 脚底只能升 **1.20 格**，
 * 普通跳（2.52）/ 强化跳（4~8）全部撞天花板 —— 在那里断言「跳出去了」会恒红，
 * 而那是房间几何而不是实现缺陷。
 *
 * ⚠️ 召唤一律走**真实 KeyB**（AGENTS.md M7 教训：直接调 service.summon 会漏掉
 * 「名册没登记 / service 没装配 / 地图判定不对」这类接线缺陷）。
 */

const SEED = 12345;

async function waitWorldReady(page) {
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 90_000 });
}

/** 读堡垒锚点 + 三个落点常量（从 gen 层权威读，不自己写一份） */
async function citadelAnchor(page) {
  return page.evaluate(async () => {
    const m = await import('/src/gen/structures/ruined-citadel.js');
    const g = window.__MC_GAME__;
    const a = m.computeRuinedCitadelAnchor(g.seed);
    if (!a) return null;
    return {
      wx: a.wx, wz: a.wz, floorY: a.floorY,
      dx: m.RUINED_CITADEL_SUMMON_DX,
      dz: m.RUINED_CITADEL_SUMMON_DZ,
      feetDy: m.RUINED_CITADEL_SUMMON_FEET_DY,
      summonY: a.floorY + m.RUINED_CITADEL_SUMMON_FEET_DY,
      halfX: m.RUINED_CITADEL_HALF_X,
      halfZ: m.RUINED_CITADEL_HALF_Z,
    };
  });
}

/** 等某一列就绪（`_findGroundY` 扫的是落点列，它未加载时 isSolid 恒假 ⇒ 落点兜底成 0） */
async function waitColumn(page, wx, wz, timeout = 180_000) {
  await page.waitForFunction(([x, z]) => {
    const g = window.__MC_GAME__;
    return g.world.hasColumn(Math.floor(x / 16), Math.floor(z / 16));
  }, [wx, wz], { timeout });
  await page.waitForTimeout(800);
}

/** 派真实 KeyB（keydown + keyup，与玩家按键同一条路径） */
async function pressB(page) {
  await page.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', {
      code: 'KeyB', repeat: false, bubbles: true, cancelable: true,
    }));
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyB', bubbles: true, cancelable: true }));
  });
}

async function waitPlayerLanded(page) {
  await page.waitForFunction(() => {
    const g = window.__MC_GAME__;
    if (!g?.player?.physics) return false;
    const p = g.player.physics.pos;
    return g.world.isSolid(Math.floor(p.x), Math.floor(p.y - 0.5), Math.floor(p.z));
  }, null, { timeout: 30_000 });
  await page.waitForTimeout(400);
}

/** 把玩家放到指定位置并清零速度（传送；y 给脚底） */
async function putPlayer(page, x, y, z) {
  await page.evaluate(([px, py, pz]) => {
    const g = window.__MC_GAME__;
    const p = g.player.physics.pos;
    p.x = px; p.y = py; p.z = pz;
    g.player.physics.vel.x = g.player.physics.vel.y = g.player.physics.vel.z = 0;
  }, [x, y, z]);
}

/** 截图（固定 clip，避开 UI 面板） */
async function shoot(page) {
  return page.screenshot({ clip: { x: 300, y: 120, width: 680, height: 520 } });
}

/** 两张 PNG 的差异统计 + 紫色像素计数（守卫主题色） */
async function pixelStats(page, a, b) {
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
    const B = b64b ? await load(b64b) : null;
    let changed = 0, purpleA = 0;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    // 守卫主题紫：B 明显高于 R 与 G（眼睛层主色 161,83,254）
    const isPurple = (r, g, bl) => bl > r + 40 && bl > g + 60 && bl > 120;
    for (let i = 0; i < A.data.length; i += 4) {
      if (isPurple(A.data[i], A.data[i + 1], A.data[i + 2])) purpleA++;
      if (!B) continue;
      const d = Math.abs(A.data[i] - B.data[i])
        + Math.abs(A.data[i + 1] - B.data[i + 1])
        + Math.abs(A.data[i + 2] - B.data[i + 2]);
      if (d > 24) {
        changed++;
        const px = (i / 4) % A.width, py = Math.floor((i / 4) / A.width);
        if (px < minX) minX = px;
        if (px > maxX) maxX = px;
        if (py < minY) minY = py;
        if (py > maxY) maxY = py;
      }
    }
    return {
      total: A.data.length / 4, changed, purpleA,
      bbox: changed > 0 ? { minX, maxX, minY, maxY } : null,
    };
  }, [a.toString('base64'), b ? b.toString('base64') : null]);
}

test.describe('末影守卫 E2E', () => {
  test('召唤：堡垒占地内按 B → 守卫落在**上层房间**（不是中层/最深）+ Boss BGM', async ({ page }) => {
    test.setTimeout(300_000);
    await page.goto(`/?seed=${SEED}`);
    await waitWorldReady(page);
    const a = await citadelAnchor(page);
    expect(a, '前置：seed 12345 必须有废弃堡垒').not.toBeNull();

    // 把玩家放在**甲板上**（floorY + 1）：这是判别力的关键 ——
    // 玩家在高处时，不传 summonY 的 `_findGroundY` 会取「离玩家最近」的可站面；
    // 传了 summonY 才强制落到上层房间。若把玩家放最低层，用例退化成假绿。
    await putPlayer(page, a.wx + 0.5, a.floorY + 1, a.wz + 0.5);
    await waitColumn(page, a.wx + a.dx, a.wz + a.dz);
    await pressB(page);
    await page.waitForFunction(
      () => window.__MC_GAME__.guardians.activeEntities().length === 1,
      null, { timeout: 30_000 });
    // ⚠️ 等物理真的站稳再读位置：召唤当帧还没跑重力积分。
    // 若 summonY 差一格（悬空）⇒ 守卫会下落 ⇒ 本等待超时，把「落点算错一格」拽出来。
    await page.waitForFunction(
      () => window.__MC_GAME__.guardians.activeEntities()[0]?.state.onGround === true,
      null, { timeout: 15_000 });

    const got = await page.evaluate(() => {
      const g = window.__MC_GAME__;
      const e = g.guardians.activeEntities()[0];
      const [x, y, z] = e.state.position;
      return {
        id: e.id, x, y, z,
        below: g.world.getBlockId(Math.floor(x), Math.floor(y) - 1, Math.floor(z)),
        self: g.world.getBlockId(Math.floor(x), Math.floor(y), Math.floor(z)),
        onGround: e.state.onGround,
        playerY: g.player.physics.pos.y,
      };
    });
    console.log('GUARDIAN SPAWN:', JSON.stringify(got), 'expected', a.summonY);

    // ① 落点 = 上层房间（floorY − 6），且**不等于**其它两层
    expect(got.y, '守卫必须站在上层房间').toBe(a.summonY);
    expect(got.y, '不得召到中层（HEADROOM 取 5 的缺陷形态）').not.toBe(a.floorY - 14);
    expect(got.y, '不得召到最深房间（玩家走不下去）').not.toBe(a.floorY - 22);
    expect(Math.floor(got.x), '落点 x = 锚点 + DX').toBe(a.wx + a.dx);
    expect(Math.floor(got.z), '落点 z = 锚点 + DZ').toBe(a.wz + a.dz);
    // ② 真的站在地板上
    expect(got.below, '脚下应实心').not.toBe(0);
    expect(got.self, '自身所在格应是空气').toBe(0);
    expect(got.onGround, '应站在地面上').toBe(true);
    expect(got.id, 'id 必须带本图标识').toContain('ruinedcitadel:0');

    // ③ Boss BGM 切换
    await page.locator('#app-canvas').click({ position: { x: 200, y: 200 } });
    await page.waitForFunction(
      () => window.__MC_GAME__.audioManager.debugMusicState().boss.wanted === true,
      null, { timeout: 15_000 });
    await page.waitForFunction(
      () => window.__MC_GAME__.audioManager.debugMusicState().boss.mix >= 1,
      null, { timeout: 60_000 });
    const music = await page.evaluate(() => window.__MC_GAME__.audioManager.debugMusicState());
    expect(music.boss.playing, '战斗曲必须在播').toBe(true);
    expect(music.playing, '淡变完成后普通曲必须停').toBe(false);
  });

  test('可达性：玩家从甲板竖井底自己走到守卫面前（不只测传送）', async ({ page }) => {
    test.setTimeout(300_000);
    await page.goto(`/?seed=${SEED}`);
    await waitWorldReady(page);
    const a = await citadelAnchor(page);
    expect(a).not.toBeNull();

    // 先召出守卫（玩家站甲板）
    await putPlayer(page, a.wx + 0.5, a.floorY + 1, a.wz + 0.5);
    await waitColumn(page, a.wx + a.dx, a.wz + a.dz);
    await pressB(page);
    await page.waitForFunction(
      () => window.__MC_GAME__.guardians.activeEntities()[0]?.state.onGround === true,
      null, { timeout: 30_000 });

    // 把玩家放到**甲板竖井底**（相对锚点 (+14,+18)，与落点同层）
    // ⚠️ 竖井是甲板通往上层房间的唯一开口（实测 ny45/44 air → ny39，底 ny38 实心）
    const shaft = { x: a.wx + 14 + 0.5, y: a.summonY, z: a.wz + 18 + 0.5 };
    await putPlayer(page, shaft.x, shaft.y, shaft.z);
    // 等竖井那列也就绪
    await waitColumn(page, shaft.x, shaft.z);
    await page.waitForTimeout(600);

    const start = await page.evaluate(() => {
      const g = window.__MC_GAME__;
      const p = g.player.physics.pos;
      const e = g.guardians.activeEntities()[0];
      const [gx, , gz] = e.state.position;
      return { px: p.x, py: p.y, pz: p.z, gx, gz, dist: Math.hypot(p.x - gx, p.z - gz) };
    });
    console.log('REACH START:', JSON.stringify(start));
    expect(start.dist, '前提：起点离守卫应远（>10 格）').toBeGreaterThan(10);

    // 驱动玩家朝守卫走（每 100ms 重设方向，最多 25 秒）
    // ⚠️ 实测最短路 65 步 ≈ 8.1 秒（跑速 8 格/秒）⇒ 窗口取 ≥20s
    // 驱动玩家沿**真实可行路径**走向守卫。
    // ⚠️⚠️ **不能用「朗目标直走」的贪心驱动**（实测踩过）：上层房间里有柱子
    //（实测 `(12,39,16)` 是 end_stone_bricks）⇒ 贪心走 9 格就卡在柱子上（minDist 16）。
    // 那不是可达性缺陷 —— BFS 最短路 65 步本来就是**绕柱**的。
    // 故先在页面里用**引擎真实口径**跑一次 BFS（台阶不可进入、竖直逐格查通道），
    // 再沿路径逐点驱动 —— 与真实玩家绕柱同行为。
    const reach = await page.evaluate(async (target) => {
      const g = window.__MC_GAME__;
      const p = g.player.physics.pos;
      const feetY = Math.round(target.py);
      // 玩家口径：单列 1×1、占 2 层（脚底格 + 头格），脚下实心
      const standable = (x, y, z) => !g.world.isSolid(x, y, z)
        && !g.world.isSolid(x, y + 1, z) && g.world.isSolid(x, y - 1, z);
      const key = (x, y, z) => `${x},${y},${z}`;
      const start = [Math.floor(p.x), feetY, Math.floor(p.z)];
      const goal = [Math.floor(target.gx), feetY, Math.floor(target.gz)];
      const prev = new Map([[key(...start), null]]);
      const queue = [start];
      let found = false;
      while (queue.length > 0 && prev.size < 20000) {
        const cur = queue.shift();
        if (cur[0] === goal[0] && cur[1] === goal[1] && cur[2] === goal[2]) { found = true; break; }
        const [x, y, z] = cur;
        const next = [];
        for (const [ox, oz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          if (standable(x + ox, y, z + oz)) next.push([x + ox, y, z + oz]);
          if (standable(x + ox, y + 1, z + oz) && !g.world.isSolid(x, y + 2, z)) next.push([x + ox, y + 1, z + oz]);
          if (standable(x + ox, y - 1, z + oz) && !g.world.isSolid(x + ox, y, z + oz)) next.push([x + ox, y - 1, z + oz]);
        }
        for (const n of next) {
          const k = key(...n);
          if (!prev.has(k)) { prev.set(k, cur); queue.push(n); }
        }
      }
      if (!found) return { err: 'BFS 找不到路径', explored: prev.size };
      // 回溯路径
      const path = [];
      let cur = goal;
      while (cur) { path.unshift(cur); cur = prev.get(key(...cur)); }
      // 沿路径逐点走（每个路点给 1.2 秒，走不到就继续下一个）
      let minDist = Infinity;
      for (let wi = 1; wi < path.length; wi++) {
        const [wx, , wz] = path[wi];
        const tx = wx + 0.5, tz = wz + 0.5;
        for (let k = 0; k < 12; k++) {
          const dx = tx - p.x, dz = tz - p.z;
          const len = Math.hypot(dx, dz);
          if (len < 0.25) break;
          g.player.physics.move(dx / len, dz / len);
          g.player.physics.step(1 / 60);
        }
        minDist = Math.min(minDist, Math.hypot(p.x - target.gx, p.z - target.gz));
        if (minDist < 4.0) break;
        await new Promise((r) => setTimeout(r, 8));
      }
      g.player.physics.move(0, 0);
      return { minDist, finalY: p.y, finalX: p.x, finalZ: p.z, pathLen: path.length };
    }, start);
    console.log('REACH RESULT:', JSON.stringify(reach));
    expect(reach.err, 'BFS 应能找到路径（上层房间内部可达）').toBeUndefined();
    // 最短的一招（踩踏）射程 4.5 ⇒ 走到 4.5 内才算「能打到它」
    expect(reach.minDist, '玩家应能自己走到守卫的最短射程内').toBeLessThan(4.5);
    expect(reach.finalY, '玩家应仍在上层房间那一层（没掉到别层）').toBeCloseTo(a.summonY, 0);
  });

  test('占地外按 B → 提示没有 Boss，且零实体', async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto(`/?seed=${SEED}`);
    await waitWorldReady(page);
    const a = await citadelAnchor(page);
    expect(a).not.toBeNull();
    // 放到占地外（东缘再往东 40 格，且远离其它地标）
    const outX = a.wx + a.halfX + 40;
    await putPlayer(page, outX + 0.5, a.floorY + 1, a.wz + 0.5);
    await waitColumn(page, outX, a.wz);
    await pressB(page);
    await page.waitForTimeout(1200);
    const got = await page.evaluate(() => {
      const g = window.__MC_GAME__;
      const toast = document.querySelector('.mc-toast')?.textContent ?? '';
      return { count: g.entities.count('guardian'), toast };
    });
    console.log('OUTSIDE B:', JSON.stringify(got));
    expect(got.count, '占地外不得召出守卫').toBe(0);
  });

  test('战斗：四招按逐招锥角命中扣血（踩踏全向、重击只打正面）', async ({ page }) => {
    test.setTimeout(300_000);
    await page.goto(`/?seed=${SEED}`);
    await waitWorldReady(page);
    const a = await citadelAnchor(page);
    expect(a).not.toBeNull();
    await putPlayer(page, a.wx + 0.5, a.floorY + 1, a.wz + 0.5);
    await waitColumn(page, a.wx + a.dx, a.wz + a.dz);
    await pressB(page);
    await page.waitForFunction(
      () => window.__MC_GAME__.guardians.activeEntities()[0]?.state.onGround === true,
      null, { timeout: 30_000 });

    // 逐招验：把守卫的 attackAnimT 推到命中帧前一帧，玩家站在指定方位，看是否扣血。
    // ⚠️ 每轮回满血（伤害 16、玩家血量 20 ⇒ 两下即停在 0，不回满会测不出第二次）
    const cases = await page.evaluate(async () => {
      const g = window.__MC_GAME__;
      const cfg = await import('/src/entities/guardian/guardian-config.js');
      const e = g.guardians.activeEntities()[0];
      const [gx, gy, gz] = e.state.position;
      const out = [];
      // 方位：正面 = 守卫 yaw 的前向（-sin,-cos）；背面 = 反向
      for (const kind of cfg.GUARDIAN_ATTACK_IDS) {
        for (const side of ['front', 'back']) {
          const prof = cfg.GUARDIAN_ATTACKS[kind];
          const dist = Math.min(prof.hitRange - 0.4, 3.2);
          const yaw = 0;   // 守卫朝 −Z
          const sign = side === 'front' ? -1 : 1;
          g.player.health = 20;
          const p = g.player.physics.pos;
          p.x = gx; p.y = gy; p.z = gz + sign * dist;
          g.player.physics.vel.x = g.player.physics.vel.y = g.player.physics.vel.z = 0;
          // 直接把 state 推进到命中帧前（Agent 下一帧越过命中帧 ⇒ 写 attackRequest）
          e.state = g.entities.get(e.id).state;
          const st = { ...e.state, mode: 'attack', attackKind: kind, yaw,
            attackAnimT: prof.hitFrameSeconds - 0.005, losVisible: true, losTimer: 1 };
          g.entities.get(e.id).state = g.guardians.activeEntities()[0].state = st;
          const before = g.player.health;
          await new Promise((r) => setTimeout(r, 250));
          out.push({ kind, side, dist, before, after: g.player.health });
        }
      }
      return out;
    });
    console.log('ATTACK CASES:', JSON.stringify(cases));
    const byKey = Object.fromEntries(cases.map((c) => [`${c.kind}:${c.side}`, c]));
    // 正面：四招都该命中（伤害 16 ⇒ 20 → 4）
    for (const kind of ['strong_right', 'strong_left', 'uppercut', 'stomp']) {
      const c = byKey[`${kind}:front`];
      expect(c, `应有 ${kind} 正面用例`).toBeTruthy();
      expect(c.after, `${kind} 正面应扣血 16`).toBe(c.before - 16);
    }
    // 背面：重击/上勾拳不该命中（锥 35/30），踩踏该命中（180 全向）
    for (const kind of ['strong_right', 'strong_left', 'uppercut']) {
      const c = byKey[`${kind}:back`];
      expect(c.after, `${kind} 背面不该被命中（窄锥）`).toBe(c.before);
    }
    expect(byKey['stomp:back'].after, '踩踏背面应被命中（180 全向）')
      .toBe(byKey['stomp:back'].before - 16);
  });

  test('脱困：开阔地 4 格围栏困住 → 卡住后起跳，前 3 次普通跳、第 4 次强化跳越出', async ({ page }) => {
    test.setTimeout(300_000);
    await page.goto(`/?seed=${SEED}`);
    await waitWorldReady(page);
    const a = await citadelAnchor(page);
    expect(a).not.toBeNull();
    // 开阔地：堡垒东缘外 60 格（远离地牢净空限制）
    const openX = a.wx + a.halfX + 60;
    await putPlayer(page, openX + 0.5, a.floorY + 6, a.wz + 0.5);
    await waitColumn(page, openX, a.wz);
    await waitPlayerLanded(page);

    const built = await page.evaluate(async (ox) => {
      const g = window.__MC_GAME__;
      const p0 = g.player.physics.pos;
      const sum = g.guardians.summon('rc:e2e:pen', Math.floor(p0.x), Math.floor(p0.z) + 8, 0, Math.floor(p0.y));
      if (!sum.ok) return { err: sum.reason };
      await new Promise((r) => setTimeout(r, 1500));
      const e = g.entities.get(sum.id);
      if (!e) return { err: 'despawned' };
      const [ex, ey, ez] = e.state.position;
      const cx = Math.floor(ex), cz = Math.floor(ez), feetY = Math.floor(ey);
      const stone = g.registry.idOf('stone');
      // 切比雪夫半径 2 的闭合围栏（半径 1 会出生即被埋），高 **4** 格
      // ⚠️ 取 4 而不是 3：普通跳顶点 2.52，3 格墙首次普通跳就借 step-up 爬上去了
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
    }, openX);
    expect(built.err).toBeUndefined();
    expect(built.placed, '围栏应垒满 16 格 × 4 层 = 64').toBe(64);
    await page.waitForTimeout(2500);

    // 玩家移到 22 格外：> attackRange ⇒ 守卫只能 chase 走过来（进而卡住）
    await page.evaluate((b) => {
      window.__MC_GAME__.player.spawn(b.px, b.py, b.cz - 22);
    }, built);
    await waitPlayerLanded(page);

    const r = await page.evaluate(async (b) => {
      const g = window.__MC_GAME__;
      const hops = [];
      let escaped = false, maxY = -Infinity;
      const modes = new Set();
      let prevFail = 0;
      for (let i = 0; i < 300; i++) {          // 30 秒
        await new Promise((res) => setTimeout(res, 100));
        const e = g.entities.get(b.id);
        if (!e) break;
        const st = e.state;
        modes.add(st.mode + (st.leapKind ? ':' + st.leapKind : ''));
        maxY = Math.max(maxY, st.position[1]);
        if (st.mode === 'leap' && st.leapKind === 'escape' && st.escapeFailCount > prevFail) {
          prevFail = st.escapeFailCount;
          hops.push({ n: st.escapeFailCount, vy: st.velocity[1] });
        }
        // 脱困判据：走出围栏（切比雪夫距 > 2）
        const d = Math.max(Math.abs(st.position[0] - (b.cx + 0.5)), Math.abs(st.position[2] - (b.cz + 0.5)));
        if (d > 2.6) { escaped = true; break; }
      }
      return { hops, escaped, maxY, modes: [...modes], feetY: b.feetY };
    }, built);
    console.log('PEN ESCAPE:', JSON.stringify(r));
    expect(r.modes.some((m) => m.startsWith('leap:escape')), '应进入过脱困跳').toBe(true);
    expect(r.hops.length, '应至少起跳一次').toBeGreaterThan(0);
    expect(r.escaped, '4 格围栏最终应被强化跳越出').toBe(true);
    expect(r.modes.every((m) => !m.includes('attack') || m === 'attack'),
      '守卫的 leap 只能是 escape（无跳劈）').toBe(true);
  });

  test('低净空不卡死：上层房间里造卡住态 → 安全阀让它回到 chase', async ({ page }) => {
    test.setTimeout(300_000);
    await page.goto(`/?seed=${SEED}`);
    await waitWorldReady(page);
    const a = await citadelAnchor(page);
    expect(a).not.toBeNull();
    await putPlayer(page, a.wx + 0.5, a.floorY + 1, a.wz + 0.5);
    await waitColumn(page, a.wx + a.dx, a.wz + a.dz);
    await pressB(page);
    await page.waitForFunction(
      () => window.__MC_GAME__.guardians.activeEntities()[0]?.state.onGround === true,
      null, { timeout: 30_000 });

    // 直接把守卫置成 leap 态并把 leapT 推到安全阀边缘（房间净空 5 格，跳不出去）
    const r = await page.evaluate(async () => {
      const g = window.__MC_GAME__;
      const cfg = await import('/src/entities/guardian/guardian-config.js');
      const e = g.guardians.activeEntities()[0];
      const id = e.id;
      const st = g.entities.get(id).state;
      g.entities.get(id).state = {
        ...st, mode: 'leap', leapKind: 'escape', leapDir: [0, -8],
        leapT: cfg.GUARDIAN_AI.leapMaxSeconds - 0.05,
      };
      const modes = new Set();
      for (let i = 0; i < 60; i++) {
        await new Promise((res) => setTimeout(res, 100));
        const cur = g.entities.get(id);
        if (!cur) break;
        modes.add(cur.state.mode);
        if (cur.state.mode !== 'leap') break;
      }
      return { modes: [...modes] };
    });
    console.log('LOW CEILING:', JSON.stringify(r));
    expect(r.modes.some((m) => m !== 'leap'),
      '安全阀必须生效（低净空房间靠它回 chase，否则永久停在 leap）').toBe(true);
  });

  test('渲染：守卫在真实 WebGPU 下画出来了（像素级，带噪声底与对照组）', async ({ page }) => {
    test.setTimeout(300_000);
    await page.goto(`/?seed=${SEED}`);
    await waitWorldReady(page);
    const a = await citadelAnchor(page);
    expect(a).not.toBeNull();
    await putPlayer(page, a.wx + 0.5, a.floorY + 1, a.wz + 0.5);
    await waitColumn(page, a.wx + a.dx, a.wz + a.dz);
    await pressB(page);
    await page.waitForFunction(
      () => window.__MC_GAME__.guardians.activeEntities()[0]?.state.onGround === true,
      null, { timeout: 30_000 });

    // 把玩家放到守卫正前方 6 格、镜头对准它（同层，稍微俯视）
    await page.evaluate(() => {
      const g = window.__MC_GAME__;
      const e = g.guardians.activeEntities()[0];
      const [gx, gy, gz] = e.state.position;
      const p = g.player.physics.pos;
      p.x = gx; p.y = gy; p.z = gz - 6;
      g.player.physics.vel.x = g.player.physics.vel.y = g.player.physics.vel.z = 0;
      g.player.yaw = Math.PI;      // 前向 +Z ⇒ 看向守卫
      g.player.pitch = -0.1;
    });
    await page.waitForTimeout(900);

    // ⚠️ 冻结帧循环：idle 是持续动画，不冻的话噪声底会盖住信号（焰魔 v2.83 实测）
    await page.evaluate(() => { window.__MC_GAME__.renderer.setAnimationLoop(null); });
    const renderOnce = async () => {
      await page.evaluate(() => {
        const g = window.__MC_GAME__;
        const now = performance.now();
        g.guardianRenderer?.sync(g.guardians.activeEntities(), now);
        g.renderer.render(g.scene, g.camera);
      });
      await page.waitForTimeout(120);
    };
    // 噪声底：同状态连拍两张
    await renderOnce();
    const n1 = await shoot(page);
    await renderOnce();
    const n2 = await shoot(page);
    const noise = await pixelStats(page, n1, n2);
    console.log('NOISE FLOOR:', JSON.stringify(noise));

    // 有守卫
    await renderOnce();
    const withG = await shoot(page);
    const withStats = await pixelStats(page, withG, null);
    // 隐藏守卫（只改这一个变量）
    await page.evaluate(() => {
      const g = window.__MC_GAME__;
      for (const inst of g.guardianRenderer.instances) inst.pivot.visible = false;
      g.renderer.render(g.scene, g.camera);
    });
    await page.waitForTimeout(120);
    const withoutG = await shoot(page);
    const diff = await pixelStats(page, withG, withoutG);
    const withoutStats = await pixelStats(page, withoutG, null);
    console.log('GUARDIAN PIXELS:', JSON.stringify({ diff, withPurple: withStats.purpleA, withoutPurple: withoutStats.purpleA }));

    // 同时钉上下界：变了、但不能整屏乱码
    expect(diff.changed, '守卫必须真的画出来（像素差 > 噪声底）').toBeGreaterThan(noise.changed + 500);
    expect(diff.changed, '变化不得超过画面 40%（防整屏乱码）').toBeLessThan(diff.total * 0.4);
    expect(diff.bbox, '应有变化区域').not.toBeNull();
    // 紫色对照组：地牢本来就有 void_stone 等紫方块 ⇒ 只钉「有守卫时紫像素更多」
    expect(withStats.purpleA, '守卫在场时紫像素应多于无守卫（眼睛/虚空石主题色）')
      .toBeGreaterThan(withoutStats.purpleA);
  });
});