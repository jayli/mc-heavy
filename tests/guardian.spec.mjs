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

/**
 * 等世界稳定：上传队列排空 + sections 连续两次相同（**不能只看队列瞬时归零**）。
 * draw call 类断言必须先过这道门 —— 地形加载期的读数与守卫无关。
 */
async function waitWorldStable(page, timeout = 120_000) {
  await page.waitForFunction(() => {
    const g = window.__MC_GAME__;
    const s = g.scheduler.stats();
    const n = g.renderStats().sections;
    const ok = s.genInflight === 0 && s.meshInflight === 0 && s.uploadQueue === 0
      && window.__LAST_SECTIONS__ === n;
    window.__LAST_SECTIONS__ = n;
    return ok;
  }, null, { timeout, polling: 500 });
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

  /**
   * 受击后退（用户 2026-11-11：「末影守卫没有被砍到击中时的回退动作，焰魔有这个动作」）。
   *
   * ⚠️ **焰魔那个「后退」不是动画帧，是位置位移 + 渲染层缓动**：
   * 剑命中 → `Game.knockbackEntity()` → service `knockback()` 瞬时改权威 `state.position`
   * → 注入钩子 `onKnockback` → 渲染器 `noteKnockback()` → 渲染位置滞后 ~0.2s ease-out 追平。
   * 守卫的 `GuardianService.knockback` / `GuardianRenderer.noteKnockback` 早已齐备，
   * 唯一缺的是 `knockbackEntity` 里对守卫的硬早退（v2.91 判「完全免疫击退」）。
   *
   * ⚠️ **与「不动如山」的区分**（别把这两条混成一条）：
   *   · 不动如山 = 玩家贴身推它时**不主动退让**（每帧的走位策略，`_ringIntent` 死区站定）；
   *   · 本用例 = 被砍一刀的**一次性受击反馈**（焰魔 v2.65 同口径）。
   *
   * ⚠️ **必须同步读**（同焰魔/飞龙用例的理由）：击退是同步写入，让出一帧就会把 0.9 格
   * 淹没在守卫自己的 `chaseSpeed` 5.4 位移里。而**渲染补间**必须隔 50ms 再读
   *（偏移在下一次 `_syncOne` 才写进矩阵，同拍读两侧都是 0 ⇒ 无判别力）。
   */
  test('受击后退：剑砍中守卫 → 扣血 + 沿背离玩家方向后退 + 渲染位置滞后补间', async ({ page }) => {
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

    // ⚠️ **先选剑、等模型，再读基线**（同焰魔用例）：模型加载期间守卫会自己走动，
    // 拿选武器之前的位置当基线会把 AI 位移混进判据。
    const result = await page.evaluate(async () => {
      const g = window.__MC_GAME__;
      await g.selectWeapon('sword');
      await new Promise((r) => setTimeout(r, 600));
      const e = g.guardians.activeEntities()[0];
      if (!e) return { summoned: false };
      const id = e.id;
      const [gx, gy, gz] = g.entities.get(id).state.position;
      // 玩家站到守卫正前方 2 格、同高（剑射程 3 内）
      g.player.spawn(gx, gy + 1, gz - 2);
      await new Promise((r) => setTimeout(r, 500));
      // 瞄准守卫身体中心（脚底 + 1.6）
      const now = g.entities.get(id).state;
      const [nx, ny, nz] = now.position;
      const cam = g.camera.position.toArray();
      g.player.setTestAim([nx - cam[0], ny + 1.6 - cam[1], nz - cam[2]]);
      const before = g.entities.get(id).state;
      const beforeHealth = before.health;
      const beforeFlash = before.flashedUntil;
      const firePos = [...before.position];
      const px = g.player.physics.pos.x;
      const pz = g.player.physics.pos.z;
      const idx = g.guardianRenderer._byId.get(id);
      const readGap = () => {
        const inst = g.guardianRenderer.instances[idx];
        const st = g.entities.get(id).state;
        return Math.hypot(
          inst.pivot.position.x - st.position[0],
          inst.pivot.position.z - st.position[2],
        );
      };
      // ⚠️ **基准必须在挥砍之前读**：`fireWeaponOnce()` 同步触发 `noteKnockback()`，
      // 偏移当场登记 0.9 格 ⇒ 砍后再当「基准」会把击退本身量成 0.9。
      const gapBefore = idx === undefined ? -1 : readGap();
      const effects = g.fireWeaponOnce();
      // 同步读权威位置（让出帧就会被 Agent 自己的移动污染）
      const after = g.entities.get(id).state;
      const physAfter = [...after.position];
      await new Promise((r) => setTimeout(r, 50));
      const gapMid = idx === undefined ? -1 : readGap();
      await new Promise((r) => setTimeout(r, 600));
      const gapSettled = idx === undefined ? -1 : readGap();
      return {
        summoned: true,
        beforeHealth,
        afterHealth: after.health,
        beforeFlash,
        afterFlash: after.flashedUntil,
        effectType: effects[0]?.type ?? null,
        firePos,
        physAfter,
        playerPos: [px, pz],
        inPool: idx !== undefined,
        gapBefore, gapMid, gapSettled,
      };
    });

    expect(result.summoned, '守卫必须被召出').toBe(true);
    expect(result.effectType, '这一刀必须砍中（melee-hit，不是挥空）').toBe('melee-hit');
    expect(result.afterHealth, '剑砍中守卫必须扣血 50').toBe(result.beforeHealth - 50);
    expect(result.afterFlash, '命中必须置红闪').toBeGreaterThan(result.beforeFlash);

    // ① 权威位置：沿**背离玩家**的方向后退（守卫 AI 自己也在动 ⇒ 用距离判据而不是纯位移）
    const [px, pz] = result.playerPos;
    const distBefore = Math.hypot(result.firePos[0] - px, result.firePos[2] - pz);
    const distAfter = Math.hypot(result.physAfter[0] - px, result.physAfter[2] - pz);
    expect(distAfter, `击退必须使守卫远离玩家（${distBefore.toFixed(3)} → ${distAfter.toFixed(3)}）`)
      .toBeGreaterThan(distBefore + 0.5);

    // ② 渲染补间：中间态滞后、末态追平（同时钉上下界，防「瞬移」与「永久错位」）
    expect(result.inPool, '守卫应在渲染池里（否则补间无从测）').toBe(true);
    expect(result.gapBefore, '击退前渲染位置应与物理位置重合').toBeLessThan(0.05);
    expect(result.gapMid,
      `击退后 ~50ms 渲染位置必须滞后于物理位置（实测 gap=${result.gapMid.toFixed(3)}，"瞬移"缺陷下恒为 0）`)
      .toBeGreaterThan(0.15);
    expect(result.gapSettled,
      `0.65s 后渲染位置应已追平物理位置（差 ${result.gapSettled.toFixed(3)}）`)
      .toBeLessThan(0.06);
  });

  /**
   * 上一条的**真负向锚点**：拆掉服务层的击退接线 → 守卫不再后退，而血量照掉。
   *
   * ⚠️ 只拆 `knockback` 一个注入项（`raycast`/`damage`/`isHittable` 全留），
   * 故两侧只差一个变量。若上一条的「距离变大」其实来自守卫自己的 AI 追击，
   * 这条会红 —— 只有它能拆穿那种假阳性。
   */
  test('负向对照：拆掉 knockback 注入 → 守卫不后退（血量仍掉，证明上一条不是 AI 位移的假阳性）', async ({ page }) => {
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

    const result = await page.evaluate(async () => {
      const g = window.__MC_GAME__;
      await g.selectWeapon('sword');
      await new Promise((r) => setTimeout(r, 600));
      const e = g.guardians.activeEntities()[0];
      if (!e) return { summoned: false };
      const id = e.id;
      const [gx, gy, gz] = g.entities.get(id).state.position;
      g.player.spawn(gx, gy + 1, gz - 2);
      await new Promise((r) => setTimeout(r, 500));
      // 拆掉击退接线（保留其余三项）
      const q = g.player.weaponController.entityQuery;
      g.player.weaponController.setEntityQuery({
        raycast: q.raycast, damage: q.damage, isHittable: q.isHittable,
      });
      const now = g.entities.get(id).state;
      const [nx, ny, nz] = now.position;
      const cam = g.camera.position.toArray();
      g.player.setTestAim([nx - cam[0], ny + 1.6 - cam[1], nz - cam[2]]);
      const before = g.entities.get(id).state;
      const beforeHealth = before.health;
      const firePos = [...before.position];
      const px = g.player.physics.pos.x;
      const pz = g.player.physics.pos.z;
      const effects = g.fireWeaponOnce();
      const after = g.entities.get(id).state;
      return {
        summoned: true,
        beforeHealth,
        afterHealth: after.health,
        effectType: effects[0]?.type ?? null,
        firePos,
        afterPos: [...after.position],
        playerPos: [px, pz],
        knockbackWired: typeof g.player.weaponController.entityQuery.knockback === 'function',
      };
    });

    expect(result.summoned, '守卫必须被召出').toBe(true);
    expect(result.knockbackWired, '前提：击退注入必须真的被拆掉').toBe(false);
    expect(result.effectType, '破坏接线后这一刀仍应命中').toBe('melee-hit');
    expect(result.afterHealth, '拆掉击退不得影响伤害').toBe(result.beforeHealth - 50);
    const [px, pz] = result.playerPos;
    const distBefore = Math.hypot(result.firePos[0] - px, result.firePos[2] - pz);
    const distAfter = Math.hypot(result.afterPos[0] - px, result.afterPos[2] - pz);
    // 无击退 ⇒ 距离只能由守卫自己的 AI 改变；砍的当帧它是同步冻结的，故距离逐位不变
    expect(Math.abs(distAfter - distBefore),
      `拆掉击退后不得有瞬时位移（${distBefore.toFixed(3)} → ${distAfter.toFixed(3)}）`).toBeLessThan(0.02);
  });

  /**
   * v3.09：围场（用户口中的「围栏」）占地内按 B → 召出末影守卫。
   *
   * ⚠️ **判别力在玩家高度**：把玩家放在占地内**最高自然地表上方 2 格**（土壁之上）。
   * 围场是下沉式场地，若 `summonY` 没接线，`_findGroundY` 会取「离玩家最近」的土壁层
   * ⇒ `got.y` 断言红。玩家放最低层则用例退化成假绿。
   * ⚠️ 量 draw call 前**关阴影**（VSM 下 receiveShadow 对象也进阴影 pass，会让读数无关波动）。
   */
  test('围场：占地内按 B → 守卫落在场地中心地板上，且在栏杆环内', async ({ page }) => {
    test.setTimeout(300_000);
    await page.goto(`/?seed=${SEED}`);
    await waitWorldReady(page);
    const a = await page.evaluate(async () => {
      const m = await import('/src/gen/structures/arena.js');
      const anchor = m.computeArenaAnchor(window.__MC_GAME__.seed);
      return anchor && {
        wx: anchor.wx, wz: anchor.wz, floorY: anchor.floorY, maxH: anchor.maxH,
        dy: m.ARENA_SUMMON_FEET_DY, hx: m.ARENA_HALF_X, hz: m.ARENA_HALF_Z,
      };
    });
    expect(a, '前提：seed 12345 必须有围场').not.toBeNull();
    await page.evaluate(() => window.__MC_GAME__.setShadowsEnabled(false));
    await page.waitForTimeout(300);
    await putPlayer(page, a.wx + 0.5, a.maxH + 2, a.wz + 0.5);
    await waitColumn(page, a.wx, a.wz);
    // ⚠️ **必须等世界真的稳定再读 draw 基线**（实测：传送后 draw 118→343→464 才稳，
    // sections 494→1593、uploadQueue 1790→0，约 3s）。召唤前读到的数是「世界还在加载」
    // 的读数 ⇒ 与 despawn 后比会把地形加载误判成守卫留了常驻 draw。
    await waitWorldStable(page);
    const drawBefore = await page.evaluate(() => window.__MC_GAME__.renderStats().drawCalls);
    await pressB(page);
    await page.waitForFunction(() => window.__MC_GAME__.guardians.activeEntities().length === 1,
      null, { timeout: 30_000 });
    await page.waitForFunction(() => window.__MC_GAME__.guardians.activeEntities()[0]?.state.onGround === true,
      null, { timeout: 15_000 });
    const got = await page.evaluate(() => {
      const g = window.__MC_GAME__;
      const e = g.guardians.activeEntities()[0];
      const [x, y, z] = e.state.position;
      return {
        id: e.id, x, y, z,
        below: g.world.getBlockId(Math.floor(x), Math.floor(y) - 1, Math.floor(z)),
        self: g.world.getBlockId(Math.floor(x), Math.floor(y), Math.floor(z)),
        playerY: g.player.physics.pos.y,
      };
    });
    console.log('ARENA GUARDIAN SPAWN:', JSON.stringify(got), 'expect y', a.floorY + a.dy);
    expect(got.id, 'id 必须带围场标识').toContain('arena:0');
    expect(got.y, '脚底 = 地板层上方一格（不是土壁那一层）').toBe(a.floorY + a.dy);
    expect(Math.floor(got.x), '落点 x = 场地中心').toBe(a.wx);
    expect(Math.floor(got.z), '落点 z = 场地中心').toBe(a.wz);
    expect(got.below, '脚下应实心').not.toBe(0);
    expect(got.self, '自身所在格应是空气').toBe(0);
    expect(Math.abs(got.x - a.wx), '必须在栏杆环内（X）').toBeLessThan(a.hx);
    expect(Math.abs(got.z - a.wz), '必须在栏杆环内（Z）').toBeLessThan(a.hz);
    // 击杀后 draw call 回基线（守卫池扩到 2 仍不得留常驻 draw）
    await page.evaluate(() => {
      const g = window.__MC_GAME__;
      const e = g.guardians.activeEntities()[0];
      g.guardians.damage(e.id, 999999, performance.now());
    });
    await waitWorldStable(page);
    const drawAfter = await page.evaluate(() => window.__MC_GAME__.renderStats().drawCalls);
    expect(drawAfter, `守卫 despawn 后 draw call 须回基线（before=${drawBefore}）`)
      .toBeLessThanOrEqual(drawBefore);
  });

  /**
   * v3.09：守卫移动时双腿真的交替踱步（Tier 4，判据落在**真实骨骼四元数**上）。
   *
   * 用户 2026-11-16：「移动的过程中，双腿没有踱步的动作，感觉不真实」。
   * 两处缺陷：① Agent 恒返回 velocity[0,vy,0] ⇒ 摆腿分支从未执行；② 相位按 dt 推 ⇒ 慢动作。
   *
   * ⚠️ **不能只断言「角度有变化」**：那对「按 dt 推」的退化零判别力。故同时钉
   * 幅度上下界（从 GUARDIAN_GAIT 派生）+ 左右反相 + 站定后回 bind。
   * ⚠️ 前提断言 `totalDisplacement > 2`：守卫没真走起来时用例必须红，不能空跑。
   */
  test('踱步：守卫追击时双腿真的交替摆动，站定后回 bind（Tier 4 真实骨骼）', async ({ page }) => {
    test.setTimeout(300_000);
    await page.goto(`/?seed=${SEED}&vd=3`);
    await waitWorldReady(page);
    // 开阔地（远离城市，建筑遮挡会让 AI 抖动）——同 ignis-fx.spec 的 gotoOpenField 手法
    await page.evaluate(async () => {
      const g = window.__MC_GAME__;
      const p = g.player.physics.pos;
      g._teleportTo(Math.floor(p.x) + 600, 45, Math.floor(p.z) + 600);
      await new Promise((r) => setTimeout(r, 2500));
    });
    const r = await page.evaluate(async () => {
      const g = window.__MC_GAME__;
      const { GUARDIAN_GAIT } = await import('/src/entities/guardian/guardian-config.js');
      const p = g.player.physics.pos;
      const sum = g.guardians.summon('gait:e2e', Math.floor(p.x), Math.floor(p.z) - 14, 0, Math.floor(p.y));
      if (!sum.ok) return { err: sum.reason };
      await new Promise((res) => setTimeout(res, 1500));
      const d = g.guardianRenderer.asset;
      const li = d.bones.findIndex((b) => b.name === 'left_leg');
      const ri = d.bones.findIndex((b) => b.name === 'right_leg');
      const ang = (i) => {
        const q = g.guardianRenderer.instances[0].bones[i].quaternion;
        return 2 * Math.atan2(q.x, q.w);
      };
      const frames = [];
      // ⚠️ **只采「非攻击态」的帧**：守卫追到 4.25 格就起手，攻击片段自己也驱动双腿
      //（实测 strong_right 腿摆 12.5~17.5°）⇒ 混进来会让「幅度上界」判据测的是片段而不是步态。
      // 步态只在 idle/chase 生效，故按 mode 过滤（这是被测语义本身，不是放宽断言）。
      let prev = g.entities.get(sum.id).state.position.slice();
      for (let k = 0; k < 300; k++) {
        await new Promise((res) => requestAnimationFrame(res));
        const cur = g.entities.get(sum.id)?.state.position;
        if (!cur) break;
        const mode = g.entities.get(sum.id).state.mode;
        frames.push({ mode, moved: Math.hypot(cur[0] - prev[0], cur[2] - prev[2]), l: ang(li), rr: ang(ri) });
        prev = cur.slice();
      }
      const moving = frames.filter((f) => f.moved > 0.01 && f.mode !== 'attack');
      const opposed = moving.filter((f) => f.l * f.rr < -1e-8).length;
      const peak = Math.max(...moving.map((f) => Math.abs(f.l)), 0);
      // ⚠️ **把玩家挪到 disengageRange 之外**让它回 idle（真静止）。
      // 不能用「贴近到死区」：那会触发起手，攻击片段自己驱动双腿 ⇒ 测的不是「静止回 bind」。
      const e = g.entities.get(sum.id);
      const gp = e.state.position;
      const pp = g.player.physics.pos;
      pp.x = gp[0]; pp.z = gp[2] + 80; pp.y = gp[1];
      g.player.physics.vel.x = g.player.physics.vel.y = g.player.physics.vel.z = 0;
      for (let k = 0; k < 180; k++) await new Promise((res) => requestAnimationFrame(res));
      const st = g.entities.get(sum.id).state;
      return {
        movingFrames: moving.length, opposed, peak, amp: GUARDIAN_GAIT.limbAmplitude,
        restAngle: Math.abs(ang(li)), restMode: st.mode,
        restDist: Math.hypot(g.player.physics.pos.x - st.position[0], g.player.physics.pos.z - st.position[2]),
        totalDisplacement: frames.reduce((s, f) => s + f.moved, 0),
      };
    });
    console.log('GUARDIAN GAIT:', JSON.stringify(r));
    expect(r.err).toBeUndefined();
    expect(r.totalDisplacement, '前提：守卫须真的走起来（否则用例空跑）').toBeGreaterThan(2);
    expect(r.movingFrames, '须有足够移动帧').toBeGreaterThan(20);
    expect(r.opposed, `左右腿须反相（${r.opposed}/${r.movingFrames}）`).toBeGreaterThan(r.movingFrames * 0.4);
    expect(r.peak, '摆幅须接近标定值').toBeGreaterThan(r.amp * 0.5);
    expect(r.peak, '摆幅不得超标定值').toBeLessThanOrEqual(r.amp + 1e-6);
    expect(r.restMode, '前提：玩家挪远后守卫须回 idle（真静止）').toBe('idle');
    expect(r.restAngle, `静止且淡入走完后腿须回 bind（mode=${r.restMode}）`).toBeLessThan(1e-3);
  });
});
