import { test, expect } from 'playwright/test';
import {
  ARROW_ID, ARROW_COLORS, ENEMY_ARROW_ROWS, ARROW_GEOM,
} from '../src/ui/enemy-arrows.js';

// tests/enemy-arrows.spec.mjs — 屏外敌人方位箭头的真游戏页 E2E（用户 2026-11-26，UI 档）
//
// 用户原话：「在屏幕的四周加上指示箭头……如果敌人不在玩家的视口范围内，就给一个小箭头
// 指示敌人的位置，用不同颜色的小三角形来指示」。
// 三项裁定：① 守卫粉红；② 每类最近一只 + 屏外计数；③ 带距离 + 远近透明度。
//
// ## 为什么这些判据只能在浏览器里
//
// 「真的画出来了」「转视角后消失」「层级不压模态」都是布局/装配事实，Node 里量不到。
// 纯几何与读数逻辑归 `src/tests/test-enemy-arrows.js`（Node 档，23 例）。
//
// ## ⚠️⚠️ 本文件的核心判据：背后的**左右方位**不是镜像
//
// 公式用 `|cz|` 让前后共用一套符号（相机空间 +x 恒为右侧）。写成两套（背后再翻一次）的
// 形态是「箭头指向镜像侧」—— 玩家朝反方向转永远找不到敌人，而「箭头出现了」「颜色对了」
// 「落点在屏幕内」这些判据**全绿**。故用例 3 用 `camera.matrixWorldInverse` **独立**算
// 一遍相机空间 x 的符号，与箭头所在半屏比对（不读被测模块自己算的值）。
//
// ## ⚠️ 落点必须真的在屏外
//
// 每条用例召唤前先用相机矩阵验算该点 `cz >= 0`（正后方）。不验算的形态是「其实在屏内」
// ⇒ 用例在测「屏内不画箭头」而以为是「背后画箭头」，注入缺陷也不会红。

const SEED = 12345;

async function boot(page, query = '') {
  // ⚠️ `vd` 只能出现一次：`resolveSettings` 按 URLSearchParams 取值，重复键取第一个
  // ⇒ 写成 `?vd=4…&vd=12` 时 12 被静默忽略（实测踩到：远处 column 仍不加载）。
  const vd = /(?:^|&)vd=/.test(query) ? '' : 'vd=4&';
  await page.goto(`/?${vd}seed=${SEED}${query}`);
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 90_000 });
}

/** 等两帧（几何每帧算，两帧足够；比等固定 ms 稳） */
const TWO_FRAMES = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

/**
 * 把玩家视角钉成「前向 −Z、无俯仰」，并停掉视图晃动/后坐对相机的干扰。
 * ⚠️ yaw=0 ⇒ 前向 (sin0, −cos0) = (0,−1) = −Z（`player.js` 的实测口径）。
 */
async function faceNorth(page) {
  await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    g.player.yaw = 0;
    g.player.pitch = 0;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  });
}

/**
 * 在玩家**正后方**（+Z）指定距离处找一块空地并召唤丧尸。
 * 返回真实落点与相机空间坐标（用相机矩阵独立算，作为判据的真值来源）。
 */
const SPAWN_BEHIND = async ({ dist, side = 0, kind = 'zombie' }) => {
  const g = window.__MC_GAME__;
  const p = g.player.physics.pos;
  // ⚠️⚠️ **横向必须精确对齐相机 x**（`side=0` 时用 `p.x` 而不是 `floor(p.x)+0.5`）：
  // 实测教训 —— 差 0.5 格在 12 格外仍让 |sx|>1，于是「去掉背后判定」的缺陷版也能
  // 靠「横向出界」蒙对 ⇒ 判据零判别力（N1 首次注入后 E2E 仍 PASS）。
  // 对齐后 sx≈0、sy≈−0.06 都在视口内 ⇒ **只有背后判定能把它归为屏外**。
  const bx = side === 0 ? p.x : Math.floor(p.x) + side;
  const bz = Math.floor(p.z) + dist;
  const gx = Math.floor(bx);
  // 向下扫真实地面（照 spawnZombieNearPlayer 的手法）
  for (let y = Math.floor(p.y) + 4; y >= Math.floor(p.y) - 32; y -= 1) {
    if (g.world.getBlockId(gx, y, bz) === 0
      && g.world.getBlockId(gx, y + 1, bz) === 0
      && g.world.isSolid(gx, y - 1, bz)) {
      const pos = [bx, y, bz + 0.5];
      const id = kind === 'zombie'
        ? g.zombies.spawn(pos, { source: 'spec' })
        : g.soldiers.spawn(pos, { source: 'spec' });
      if (!id) return { ok: false, reason: 'spawn rejected' };
      // 返回**实体真实位置**（spawn 可能微调）而不是请求位置
      const e = g.entities.get(id);
      return { ok: true, id, pos: e ? [...e.state.position] : pos };
    }
  }
  return { ok: false, reason: 'no ground' };
};

/** 读一个槽的可见性、颜色、中心坐标、读数文本 */
const READ_SLOT = (key) => {
  const box = document.getElementById(`mc-enemy-arrows-${key}`);
  if (!box) return { missing: true };
  const cs = getComputedStyle(box);
  const tri = box.querySelector('i');
  const label = box.querySelector('span');
  const r = box.getBoundingClientRect();
  const tr = tri.getBoundingClientRect();
  return {
    display: cs.display,
    opacity: Number(cs.opacity),
    color: getComputedStyle(tri).borderLeftColor,
    // 三角的实际几何中心（box 是零尺寸定位点，故用三角自己的矩形）
    cx: tr.left + tr.width / 2,
    cy: tr.top + tr.height / 2,
    boxX: r.left, boxY: r.top,
    text: label.textContent,
    triTransform: getComputedStyle(tri).transform,
    vw: window.innerWidth, vh: window.innerHeight,
  };
};

/** 独立算某世界点的相机空间坐标（判据真值，不读被测模块） */
const CAM_SPACE = (pos) => {
  const g = window.__MC_GAME__;
  const v = new (g.camera.position.constructor)(pos[0], pos[1], pos[2]);
  v.applyMatrix4(g.camera.matrixWorldInverse);
  return [v.x, v.y, v.z];
};

test('敌人箭头: 装配与层级（挂 hud-root、z-index 52、pointer-events:none、五槽都在）', async ({ page }) => {
  test.setTimeout(180_000);
  await boot(page);
  const m = await page.evaluate((id) => {
    const el = document.getElementById(id);
    if (!el) return { missing: true };
    const cs = getComputedStyle(el);
    return {
      parentIsHud: el.parentElement?.id === 'hud-root',
      zIndex: cs.zIndex, pointerEvents: cs.pointerEvents, overflow: cs.overflow,
      slots: [...el.children].map((c) => c.dataset.enemy),
    };
  }, ARROW_ID);
  expect(m.missing ?? false, '箭头容器必须存在').toBe(false);
  expect(m.parentIsHud, '必须挂 #hud-root（Tier 4 像素用例靠它一并隐藏 HUD）').toBe(true);
  expect(m.zIndex, '层级 52（>50 常驻读数，<55 伤害数字）').toBe(String(ARROW_GEOM.zIndex));
  expect(m.pointerEvents, '不得吃鼠标').toBe('none');
  expect(m.overflow, '必须裁掉溢出（箭头不得画出屏幕）').toBe('hidden');
  expect(m.slots, '五类槽位按登记顺序常驻').toEqual(ENEMY_ARROW_ROWS.map((r) => r.key));
});

test('敌人箭头: 开局无敌人在场时五槽全隐藏（不是空箭头堆在边上）', async ({ page }) => {
  test.setTimeout(180_000);
  await boot(page);
  const vis = await page.evaluate(() => window.__MC_GAME__._enemyArrows.activeKeys());
  expect(vis, '开局不该有任何箭头').toEqual([]);
});

/**
 * 在玩家**正后方**铺一块石台并召一只丧尸，使它的身体中心与相机眼高**齐平**。
 *
 * ⚠️⚠️ **为什么必须齐平（实测两次踩到）**：只有当该点的横向与纵向 NDC **都在视口内**时，
 * 「它被归为屏外」才**只能**源于背后判定。否则「去掉背后判定」的缺陷版靠「横向/纵向出界」
 * 也能蒙对 ⇒ 判据零判别力（N1 首次注入后 E2E 仍 PASS：先是差 0.5 格横向，再是丧尸落在
 * 低 17 格的地面使 |sy|=2.01）。直接改 `camera.position.y` 不行 —— `player.update()` 每帧重写它。
 * 故用**真实方块**铺台（走唯一写入口 `editor.setBlock`），让目标站得与玩家同高。
 */
const SPAWN_LEVEL_BEHIND = async ({ dist }) => {
  const g = window.__MC_GAME__;
  const p = g.player.physics.pos;
  const stone = g.registry.idOf('stone');
  const bx = Math.floor(p.x);
  const bz = Math.floor(p.z) + dist;
  const feetY = Math.floor(p.y);          // 与玩家脚底同高
  // 铺 3×3 台面（顶面 = feetY-1，故站位面 = feetY）+ 清出上方 3 格空气
  for (let dx = -1; dx <= 1; dx += 1) {
    for (let dz = -1; dz <= 1; dz += 1) {
      g.editor.setBlock({ x: bx + dx, y: feetY - 1, z: bz + dz, id: stone });
      for (let dy = 0; dy < 4; dy += 1) {
        g.editor.setBlock({ x: bx + dx, y: feetY + dy, z: bz + dz, id: 0 });
      }
    }
  }
  const id = g.zombies.spawn([p.x, feetY, bz + 0.5], { source: 'spec' });
  if (!id) return { ok: false, reason: 'spawn rejected' };
  const e = g.entities.get(id);
  return { ok: true, id, pos: [...e.state.position], eyeY: g.camera.position.y };
};

test('敌人箭头: ⭐ 正后方的丧尸出绿色箭头，落点在边框内缩带上', async ({ page }) => {
  test.setTimeout(180_000);
  await boot(page);
  await faceNorth(page);

  const r = await page.evaluate(async ({ spawnSrc, readSrc, camSrc, twoSrc }) => {
    const spawn = new Function(`return (${spawnSrc})`)();
    const read = new Function(`return (${readSrc})`)();
    const cam = new Function(`return (${camSrc})`)();
    const two = new Function(`return (${twoSrc})`)();
    const g = window.__MC_GAME__;
    const s = await spawn({ dist: 12 });
    if (!s.ok) return { err: s.reason };
    await two(); await two();
    const e = g.entities.get(s.id);
    const pos = e ? [...e.state.position] : s.pos;
    const cs = cam([pos[0], pos[1] + 0.9, pos[2]]);
    return {
      spawn: s, camSpace: cs, realPos: pos,
      slot: read('zombie'), active: g._enemyArrows.activeKeys(),
    };
  }, {
    spawnSrc: SPAWN_LEVEL_BEHIND.toString(), readSrc: READ_SLOT.toString(),
    camSrc: CAM_SPACE.toString(), twoSrc: TWO_FRAMES.toString(),
  });

  expect(r.err).toBeUndefined();
  // 前置：落点真的在相机背后（否则本用例在测别的东西）
  expect(r.camSpace[2], `落点必须在相机背后（cz>0），实测 ${r.camSpace[2]}`).toBeGreaterThan(0);
  // ⚠️⚠️ **非退化前置：该点的横向/纵向 NDC 必须都在视口内**。
  // 否则「去掉背后判定」的缺陷版也能靠「横向出界」蒙对 ⇒ 本用例零判别力
  //（N1 首次注入后 E2E 仍 PASS，就是差 0.5 格横向偏移导致的）。
  const tan = Math.tan((70 * Math.PI) / 360);
  const aspect = r.slot.vw / r.slot.vh;
  const sx = r.camSpace[0] / (Math.abs(r.camSpace[2]) * tan * aspect);
  const sy = -r.camSpace[1] / (Math.abs(r.camSpace[2]) * tan);
  expect(Math.abs(sx), `前置：横向 NDC 必须在视口内（实测 ${sx.toFixed(3)}）`).toBeLessThan(1);
  expect(Math.abs(sy), `前置：纵向 NDC 必须在视口内（实测 ${sy.toFixed(3)}）`).toBeLessThan(1);
  expect(r.active).toContain('zombie');
  expect(r.slot.display, '丧尸槽必须可见').not.toBe('none');
  expect(r.slot.color, '丧尸 = 绿 #4ade80').toBe('rgb(74, 222, 128)');
  // 落点在内缩带上（允许 1px 取整误差）
  const { cx, cy, vw, vh } = r.slot;
  expect(cx).toBeGreaterThanOrEqual(ARROW_GEOM.marginX - 2);
  expect(cx).toBeLessThanOrEqual(vw - ARROW_GEOM.marginX + 2);
  expect(cy).toBeGreaterThanOrEqual(ARROW_GEOM.marginY - 2);
  expect(cy).toBeLessThanOrEqual(vh - ARROW_GEOM.marginY + 2);
  const onEdge = Math.min(
    Math.abs(cx - ARROW_GEOM.marginX), Math.abs(cx - (vw - ARROW_GEOM.marginX)),
    Math.abs(cy - ARROW_GEOM.marginY), Math.abs(cy - (vh - ARROW_GEOM.marginY)),
  );
  expect(onEdge, `必须贴在边框内缩带上（实测离最近边界 ${onEdge}px）`).toBeLessThan(36);
});

test('敌人箭头: ⭐⭐ 背后的左右不镜像（右后方→右半屏，左后方→左半屏）', async ({ page }) => {
  test.setTimeout(200_000);
  await boot(page);
  await faceNorth(page);

  const r = await page.evaluate(async ({ spawnSrc, readSrc, camSrc, twoSrc }) => {
    const spawn = new Function(`return (${spawnSrc})`)();
    const read = new Function(`return (${readSrc})`)();
    const cam = new Function(`return (${camSrc})`)();
    const two = new Function(`return (${twoSrc})`)();
    const g = window.__MC_GAME__;
    const out = [];
    // 两轮各只留一只：同时放两只时「最近的那只」会决定指向，测不出单只的左右
    for (const side of [10, -10]) {
      const s = await spawn({ dist: 10, side });
      if (!s.ok) { out.push({ side, err: s.reason }); continue; }
      await two();
      const cs = cam(s.pos);
      const slot = read('zombie');
      out.push({ side, camX: cs[0], camZ: cs[2], arrowX: slot.cx, vw: slot.vw, text: slot.text });
      g.damageEntity(s.id, 1e9, performance.now());
      await two();
    }
    return out;
  }, {
    spawnSrc: SPAWN_BEHIND.toString(), readSrc: READ_SLOT.toString(),
    camSrc: CAM_SPACE.toString(), twoSrc: TWO_FRAMES.toString(),
  });

  expect(r.length, '两轮都要跑').toBe(2);
  for (const one of r) {
    expect(one.err, `side=${one.side} 召唤失败`).toBeUndefined();
    expect(one.camZ, `side=${one.side} 必须在相机背后`).toBeGreaterThan(0);
    const camRight = one.camX > 0;
    const arrowRight = one.arrowX > one.vw / 2;
    expect(arrowRight,
      `相机空间 x=${one.camX.toFixed(2)}（${camRight ? '右' : '左'}后方）`
      + ` ⇒ 箭头应在${camRight ? '右' : '左'}半屏，实测 x=${one.arrowX.toFixed(1)} / 中线 ${one.vw / 2}`)
      .toBe(camRight);
  }
});

test('敌人箭头: 转向面对它之后箭头消失（屏内不指示）', async ({ page }) => {
  test.setTimeout(180_000);
  await boot(page);
  await faceNorth(page);

  const r = await page.evaluate(async ({ spawnSrc, readSrc, twoSrc }) => {
    const spawn = new Function(`return (${spawnSrc})`)();
    const read = new Function(`return (${readSrc})`)();
    const two = new Function(`return (${twoSrc})`)();
    const g = window.__MC_GAME__;
    const s = await spawn({ dist: 10 });
    if (!s.ok) return { err: s.reason };
    await two();
    const before = read('zombie').display;
    // 转身 180°：yaw=π ⇒ 前向 (sin(−π), −cos π) = (0, +1) = +Z，正对丧尸
    g.player.yaw = Math.PI;
    g.player.pitch = 0;
    await two(); await two();
    return { before, after: read('zombie').display, active: g._enemyArrows.activeKeys() };
  }, {
    spawnSrc: SPAWN_BEHIND.toString(), readSrc: READ_SLOT.toString(), twoSrc: TWO_FRAMES.toString(),
  });

  expect(r.err).toBeUndefined();
  expect(r.before, '前置：背对时必须可见').not.toBe('none');
  expect(r.after, '转过来看得见它之后必须隐藏').toBe('none');
  expect(r.active).not.toContain('zombie');
});

test('敌人箭头: ⭐ count = 屏外总数（看得见的那只不计进「还没找到」）', async ({ page }) => {
  test.setTimeout(200_000);
  await boot(page);
  await faceNorth(page);

  const r = await page.evaluate(async ({ spawnSrc, readSrc, twoSrc }) => {
    const spawn = new Function(`return (${spawnSrc})`)();
    const read = new Function(`return (${readSrc})`)();
    const two = new Function(`return (${twoSrc})`)();
    const g = window.__MC_GAME__;
    const ids = [];
    // 三只全在正后方（不同距离，避免同格冲突）
    for (const dist of [8, 14, 20]) {
      const s = await spawn({ dist });
      if (s.ok) ids.push(s.id);
    }
    await two();
    const allBehind = { text: read('zombie').text, truth: g.entities.count('zombie') };
    // 把最近那只挪到正前方（屏内）：直接改 state.position 会绕过权威 ⇒ 用 despawn + 前方重召
    g.damageEntity(ids[0], 1e9, performance.now());
    await two();
    const p = g.player.physics.pos;
    const bx = Math.floor(p.x), bz = Math.floor(p.z) - 8;
    let frontId = null;
    for (let y = Math.floor(p.y) + 4; y >= Math.floor(p.y) - 32; y -= 1) {
      if (g.world.getBlockId(bx, y, bz) === 0 && g.world.getBlockId(bx, y + 1, bz) === 0
        && g.world.isSolid(bx, y - 1, bz)) {
        frontId = g.zombies.spawn([bx + 0.5, y, bz + 0.5], { source: 'spec' });
        break;
      }
    }
    await two(); await two();
    const e = frontId ? g.entities.get(frontId) : null;
    const v = e ? new (g.camera.position.constructor)(...e.state.position)
      .applyMatrix4(g.camera.matrixWorldInverse) : null;
    return {
      spawned: ids.length, allBehind, frontSpawned: !!frontId,
      frontCamZ: v ? v.z : null,
      withFront: { text: read('zombie').text, truth: g.entities.count('zombie') },
    };
  }, {
    spawnSrc: SPAWN_BEHIND.toString(), readSrc: READ_SLOT.toString(), twoSrc: TWO_FRAMES.toString(),
  });

  expect(r.spawned, '前置：至少召出 2 只').toBeGreaterThanOrEqual(2);
  expect(r.allBehind.text, `全在屏外时读数 = ×${r.allBehind.truth}`)
    .toMatch(new RegExp(`^×${r.allBehind.truth} \\d+m$`));
  expect(r.frontSpawned, '前置：前方那只召唤成功').toBe(true);
  expect(r.frontCamZ, '前置：前方那只必须在相机前方（cz<0）').toBeLessThan(0);
  // 总数不变（杀一只 + 召一只），但屏外数少 1 ⇒ 读数必须少 1
  expect(r.withFront.truth, '总数应与之前相同').toBe(r.allBehind.truth);
  expect(r.withFront.text, `屏外数应为 ${r.withFront.truth - 1}（前方那只不计）`)
    .toMatch(new RegExp(`^×${r.withFront.truth - 1} \\d+m$`));
});

test('敌人箭头: ⭐ 士兵留尸不计数（打死后箭头读数立刻减 1）', async ({ page }) => {
  test.setTimeout(200_000);
  await boot(page);
  await faceNorth(page);

  const r = await page.evaluate(async ({ spawnSrc, readSrc, twoSrc }) => {
    const spawn = new Function(`return (${spawnSrc})`)();
    const read = new Function(`return (${readSrc})`)();
    const two = new Function(`return (${twoSrc})`)();
    const g = window.__MC_GAME__;
    const ids = [];
    for (const dist of [9, 16]) {
      const s = await spawn({ dist, kind: 'soldier' });
      if (s.ok) ids.push(s.id);
    }
    if (ids.length < 2) return { err: `只召出 ${ids.length} 名` };
    await two();
    const alive = {
      text: read('soldier').text,
      truth: g.soldiers.activeEntities().filter((e) => !e.state.dead).length,
      total: g.soldiers.activeEntities().length,
    };
    g.damageEntity(ids[0], 1e9, performance.now());
    // 留尸窗口 1.2s 内取样：尸体仍在 activeEntities 里，这正是判据要区分的那一刻
    await new Promise((res) => setTimeout(res, 400));
    await two();
    const afterKill = {
      text: read('soldier').text,
      truth: g.soldiers.activeEntities().filter((e) => !e.state.dead).length,
      total: g.soldiers.activeEntities().length,
    };
    return { alive, afterKill };
  }, {
    spawnSrc: SPAWN_BEHIND.toString(), readSrc: READ_SLOT.toString(), twoSrc: TWO_FRAMES.toString(),
  });

  expect(r.err).toBeUndefined();
  expect(r.alive.text, `两名活士兵 ⇒ ×2`).toMatch(/^×2 \d+m$/);
  expect(r.afterKill.total, '前置：尸体仍在 activeEntities 里（留尸窗口）')
    .toBeGreaterThan(r.afterKill.truth);
  expect(r.afterKill.text, `打死一名后必须 ×${r.afterKill.truth}（尸体不算敌人）`)
    .toMatch(new RegExp(`^×${r.afterKill.truth} \\d+m$`));
});

test('敌人箭头: 焰魔 = 黄色，守卫 = 粉红，飞龙 = 紫，士兵 = 纯白（四色各自可辨）', async ({ page }) => {
  test.setTimeout(240_000);
  await boot(page);
  await faceNorth(page);

  const r = await page.evaluate(async ({ readSrc, twoSrc, camSrc }) => {
    const read = new Function(`return (${readSrc})`)();
    const two = new Function(`return (${twoSrc})`)();
    const cam = new Function(`return (${camSrc})`)();
    const g = window.__MC_GAME__;
    const p = g.player.physics.pos;
    const bx = Math.floor(p.x), bz = Math.floor(p.z), by = Math.floor(p.y);
    const out = {};
    // 焰魔/守卫：直接放在正后方（+Z）。
    // ⚠️⚠️ **飞龙的 summon 参数是「轨道中心」而不是落点**（实测）：半径 24 的圈
    // 会把龙带到中心±24，中心放 +14 时它当场在**前方** cz=−9.35 且在视口内
    // ⇒ 箭头本就不该出现（第一版夹具就是这么错的）。中心放 +60 ⇒ 整圈最近点仍 +36。
    const sums = {
      ignis: g.ignises.summon('arrows:e2e:i', bx, bz + 10, 1, by),
      guardian: g.guardians.summon('arrows:e2e:g', bx + 6, bz + 12, 0, by),
      dragon: g.dragons.summon('arrows:e2e:d', bx, bz + 60, 0),
    };
    await two(); await two();
    for (const key of ['ignis', 'guardian', 'dragon']) {
      const slot = read(key);
      const list = g[key === 'ignis' ? 'ignises' : key === 'guardian' ? 'guardians' : 'dragons']
        .activeEntities();
      const e = list[0];
      out[key] = {
        ok: sums[key]?.ok === true, display: slot.display, color: slot.color, text: slot.text,
        camZ: e ? cam(e.state.position)[2] : null,
      };
    }
    out.active = g._enemyArrows.activeKeys();
    return out;
  }, {
    readSrc: READ_SLOT.toString(), twoSrc: TWO_FRAMES.toString(), camSrc: CAM_SPACE.toString(),
  });

  const WANT = {
    ignis: 'rgb(250, 204, 21)',    // #facc15 黄
    guardian: 'rgb(255, 105, 180)', // #ff69b4 粉红
    dragon: 'rgb(168, 85, 247)',   // #a855f7 紫
  };
  for (const key of ['ignis', 'guardian', 'dragon']) {
    expect(r[key].ok, `前置：${key} 召唤成功`).toBe(true);
    expect(r[key].camZ, `前置：${key} 必须在相机背后（cz>0），实测 ${r[key].camZ}`)
      .toBeGreaterThan(0);
    expect(r[key].display, `${key} 在正后方 ⇒ 箭头必须可见`).not.toBe('none');
    expect(r[key].color, `${key} 的颜色`).toBe(WANT[key]);
  }
  // 三色互不相同（撞色 = 分不出类型）
  expect(new Set(Object.values(WANT)).size).toBe(3);
  expect(ARROW_COLORS.ignis).toBe('#facc15');
  expect(ARROW_COLORS.guardian).toBe('#ff69b4');
});

test('敌人箭头: 距离读数与真实欧氏距离一致，远处更淡', async ({ page }) => {
  test.setTimeout(240_000);
  // ⚠️ **视距必须够大**（实测夹具坑）：vd=4 时 80 格外的 column 根本未加载
  // ⇒ `isSolid` 恒假 ⇒ 远处落点找不到地面（第一版报 `no ground`）。
  // vd=12 实测 150 格外列已加载、groundY=5。这不是实现缺陷，是夹具选错视距。
  await boot(page, '&vd=12');
  await faceNorth(page);

  const r = await page.evaluate(async ({ spawnSrc, readSrc, twoSrc }) => {
    const spawn = new Function(`return (${spawnSrc})`)();
    const read = new Function(`return (${readSrc})`)();
    const two = new Function(`return (${twoSrc})`)();
    const g = window.__MC_GAME__;
    const near = await spawn({ dist: 8 });
    if (!near.ok) return { err: near.reason };
    await two();
    const p = g.player.physics.pos;
    const e = g.entities.get(near.id);
    const [ex, ey, ez] = e.state.position;
    // 身体中心锚点（丧尸 height=1.8 ⇒ +0.9），与源码同语义但独立算
    const truthNear = Math.hypot(ex - p.x, ey + 0.9 - p.y, ez - p.z);
    const nearSlot = read('zombie');
    g.damageEntity(near.id, 1e9, performance.now());
    await two();
    // 远处：等目标列真的加载完再找地面（未加载时 isSolid 恒假）
    const bx = Math.floor(p.x), bz = Math.floor(p.z) + 150;
    const t0 = performance.now();
    while (!g.world.hasColumn(Math.floor(bx / 16), Math.floor(bz / 16))
      && performance.now() - t0 < 40_000) {
      await new Promise((res) => setTimeout(res, 200));
    }
    const far = await spawn({ dist: 150 });
    if (!far.ok) return { err: `远处落点失败：${far.reason}`, truthNear, nearSlot };
    await two();
    const e2 = g.entities.get(far.id);
    const [fx, fy, fz] = e2.state.position;
    const truthFar = Math.hypot(fx - p.x, fy + 0.9 - p.y, fz - p.z);
    return { truthNear, nearSlot, truthFar, farSlot: read('zombie') };
  }, {
    spawnSrc: SPAWN_BEHIND.toString(), readSrc: READ_SLOT.toString(), twoSrc: TWO_FRAMES.toString(),
  });

  expect(r.err).toBeUndefined();
  const nearShown = Number(r.nearSlot.text.match(/(\d+)m/)[1]);
  expect(Math.abs(nearShown - r.truthNear), `近处读数 ${nearShown} vs 真值 ${r.truthNear.toFixed(2)}`)
    .toBeLessThanOrEqual(1);
  expect(r.nearSlot.opacity, '16 格内应实心').toBe(1);
  const farShown = Number(r.farSlot.text.match(/(\d+)m/)[1]);
  expect(Math.abs(farShown - r.truthFar), `远处读数 ${farShown} vs 真值 ${r.truthFar.toFixed(2)}`)
    .toBeLessThanOrEqual(1);
  expect(r.farSlot.opacity, '160 格外应淡到下限 0.35').toBeLessThanOrEqual(ARROW_GEOM.minOpacity + 0.02);
  expect(r.farSlot.opacity, '但不得完全消失').toBeGreaterThan(0.2);
});

test('敌人箭头: 不压模态（设置面板 70 高于箭头 52，箭头不吃点击）', async ({ page }) => {
  test.setTimeout(180_000);
  await boot(page);
  await faceNorth(page);
  const r = await page.evaluate(async ({ spawnSrc, readSrc, twoSrc }) => {
    const spawn = new Function(`return (${spawnSrc})`)();
    const read = new Function(`return (${readSrc})`)();
    const two = new Function(`return (${twoSrc})`)();
    const s = await spawn({ dist: 12 });
    if (!s.ok) return { err: s.reason };
    await two();
    const slot = read('zombie');
    document.getElementById('settings-btn').click();
    await two();
    const panel = document.getElementById('settings-modal');
    const pcs = panel ? getComputedStyle(panel) : null;
    // 箭头 pointer-events:none ⇒ 命中测试必然穿透到别的元素（不得是箭头自己）
    const hit = document.elementFromPoint(slot.cx, slot.cy);
    return {
      slot, panelZ: pcs ? Number(pcs.zIndex) : null,
      panelDisplay: pcs ? pcs.display : null,
      hitIsArrow: !!(hit && hit.closest && hit.closest(`#${'mc-enemy-arrows'}`)),
    };
  }, {
    spawnSrc: SPAWN_BEHIND.toString(), readSrc: READ_SLOT.toString(), twoSrc: TWO_FRAMES.toString(),
  });
  expect(r.err).toBeUndefined();
  expect(r.panelZ, '前置：设置面板已打开且层级可读').not.toBeNull();
  expect(r.panelZ, '设置面板必须高于箭头').toBeGreaterThan(ARROW_GEOM.zIndex);
  expect(r.hitIsArrow, '箭头 pointer-events:none ⇒ 命中测试不得落在它上面').toBe(false);
});

// ---------------------------------------------------------------- v3.43 直觉化方位
//
// 用户 2026-11-26：「如果敌人在身后……不要显示在上方，显示在上方，就给人感觉好像在空中
// 一样，如果是在玩家头顶上方空中的位置，比如飞龙，似乎应该把箭头显示在头顶。」

/** 读某类箭头归哪条边（独立几何判定：离哪条 margin 界最近） */
const EDGE_OF = (key) => {
  const box = document.getElementById(`mc-enemy-arrows-${key}`);
  if (!box || getComputedStyle(box).display === 'none') return 'hidden';
  const tri = box.querySelector('i');
  const r = tri.getBoundingClientRect();
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const MX = 62;
  const MY = 30;
  const onX = Math.min(Math.abs(x - MX), Math.abs(x - (vw - MX)));
  const onY = Math.min(Math.abs(y - MY), Math.abs(y - (vh - MY)));
  if (onY < onX) return y < vh / 2 ? 'top' : 'bottom';
  return x < vw / 2 ? 'left' : 'right';
};

test('敌人箭头(v3.43): ⭐⭐ 抬头 60° 时身后丧尸的箭头仍在下边（用户报的缺陷）', async ({ page }) => {
  test.setTimeout(200_000);
  await boot(page);
  await faceNorth(page);

  const r = await page.evaluate(async ({ spawnSrc, edgeSrc, twoSrc }) => {
    const spawn = new Function(`return (${spawnSrc})`)();
    const edge = new Function(`return (${edgeSrc})`)();
    const two = new Function(`return (${twoSrc})`)();
    const g = window.__MC_GAME__;
    const s = await spawn({ dist: 12 });
    if (!s.ok) return { err: s.reason };
    await two(); await two();
    const out = { pitches: [] };
    // ⚠️ 逐个俯仰角采样：**只改 pitch，不改 yaw、不动敌人**。
    // 这正是用户实玩时的动作（抬头看天），v3.42 在这里会把箭头甩到上边。
    for (const deg of [0, 30, 60, -30, -60]) {
      g.player.pitch = (deg * Math.PI) / 180;
      await two(); await two();
      out.pitches.push({ deg, edge: edge('zombie'), shown: g._enemyArrows.activeKeys().includes('zombie') });
    }
    g.player.pitch = 0;
    return out;
  }, {
    spawnSrc: SPAWN_LEVEL_BEHIND.toString(), edgeSrc: EDGE_OF.toString(), twoSrc: TWO_FRAMES.toString(),
  });

  expect(r.err).toBeUndefined();
  // 前置：平视时确实有箭头且在下边（否则本用例没在测东西）
  const flat = r.pitches.find((p) => p.deg === 0);
  expect(flat.shown, '前置：平视时身后丧尸必须有箭头').toBe(true);
  expect(flat.edge, '平视时身后丧尸应在下边').toBe('bottom');
  // ⭐ 核心：任何俯仰角下，只要箭头还显示，就必须在**下边**
  for (const p of r.pitches) {
    if (!p.shown) continue;   // 抬头到看得见它了 ⇒ 本就不该有箭头
    expect(p.edge, `pitch=${p.deg}° 时身后丧尸的箭头必须仍在下边（实测 ${p.edge}）`)
      .toBe('bottom');
  }
});

test('敌人箭头(v3.43): ⭐ 头顶上空的飞龙归上边（即使它在身后）', async ({ page }) => {
  test.setTimeout(240_000);
  await boot(page);
  await faceNorth(page);

  const r = await page.evaluate(async ({ edgeSrc, twoSrc, camSrc }) => {
    const edge = new Function(`return (${edgeSrc})`)();
    const two = new Function(`return (${twoSrc})`)();
    const cam = new Function(`return (${camSrc})`)();
    const g = window.__MC_GAME__;
    const p = g.player.physics.pos;
    const bx = Math.floor(p.x);
    const bz = Math.floor(p.z);
    // ⚠️ summon 的参数是**轨道中心**（半径 24）⇒ 中心放 +Z 60 保证整圈在身后；
    // 盘旋高度 = TARN_PLATEAU_Y + orbitYOffset = 30，玩家在 y≈22 ⇒ 高差约 8 格。
    // 为了拿到「明确在头顶上空」（仰角 > 35°）的样本，把玩家传到轨道中心附近。
    const sum = g.dragons.summon('arrows:v343:sky', bx, bz + 60, 0);
    if (!sum.ok) return { err: sum.reason };
    await two();
    const e = g.entities.get(sum.id);
    if (!e) return { err: 'despawned' };
    const dp = e.state.position;
    // 把玩家放到龙下方偏后 6 格（仰角 ≈ atan(8/6) = 53° > 35°），且龙在身后
    g.player.spawn(dp[0], p.y, dp[2] - 6);
    g.player.yaw = 0;   // 前向 −Z ⇒ 龙（+Z 侧）在身后
    g.player.pitch = 0;
    await two(); await two(); await two();
    const e2 = g.entities.get(sum.id);
    const pos = e2 ? e2.state.position : dp;
    const pp = g.player.physics.pos;
    const delta = [pos[0] - pp.x, pos[1] - pp.y, pos[2] - pp.z];
    const hd = Math.hypot(delta[0], delta[2]);
    return {
      delta, elevDeg: (Math.atan2(delta[1], hd) * 180) / Math.PI,
      behind: delta[2] > 0,
      edge: edge('dragon'), shown: g._enemyArrows.activeKeys().includes('dragon'),
      cam: cam(pos),
    };
  }, { edgeSrc: EDGE_OF.toString(), twoSrc: TWO_FRAMES.toString(), camSrc: CAM_SPACE.toString() });

  expect(r.err).toBeUndefined();
  expect(r.behind, `前置：龙必须在身后（delta.z>0），实测 ${r.delta[2].toFixed(2)}`).toBe(true);
  expect(r.elevDeg, `前置：仰角必须 > 35°（真的在头顶上空），实测 ${r.elevDeg.toFixed(1)}°`)
    .toBeGreaterThan(35);
  expect(r.shown, '前置：龙在屏外（平视看不到头顶）').toBe(true);
  expect(r.edge, '头顶上空的飞龙必须归上边').toBe('top');
});

test('敌人箭头(v3.43): soldier 箭头是纯白（用户追加裁定）', async ({ page }) => {
  test.setTimeout(200_000);
  await boot(page);
  await faceNorth(page);
  const r = await page.evaluate(async ({ spawnSrc, readSrc, twoSrc }) => {
    const spawn = new Function(`return (${spawnSrc})`)();
    const read = new Function(`return (${readSrc})`)();
    const two = new Function(`return (${twoSrc})`)();
    const s = await spawn({ dist: 12, kind: 'soldier' });
    if (!s.ok) return { err: s.reason };
    await two(); await two();
    return read('soldier');
  }, {
    spawnSrc: SPAWN_BEHIND.toString(), readSrc: READ_SLOT.toString(), twoSrc: TWO_FRAMES.toString(),
  });
  expect(r.err).toBeUndefined();
  expect(r.display, '士兵在身后 ⇒ 箭头必须可见').not.toBe('none');
  expect(r.color, 'soldier 必须是纯白 #ffffff（用户：把灰色改为纯白）').toBe('rgb(255, 255, 255)');
});

test('敌人箭头(v3.43): 转身时箭头连续移动（真实页面 sweep，无半屏跳变）', async ({ page }) => {
  test.setTimeout(240_000);
  await boot(page);
  await faceNorth(page);

  const r = await page.evaluate(async ({ spawnSrc, twoSrc }) => {
    const spawn = new Function(`return (${spawnSrc})`)();
    const two = new Function(`return (${twoSrc})`)();
    const g = window.__MC_GAME__;
    const s = await spawn({ dist: 12 });
    if (!s.ok) return { err: s.reason };
    await two();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const MX = 62;
    const MY = 30;
    const w = vw - 2 * MX;
    const h = vh - 2 * MY;
    const perim = (x, y) => {
      const onX = Math.min(Math.abs(x - MX), Math.abs(x - (vw - MX)));
      const onY = Math.min(Math.abs(y - MY), Math.abs(y - (vh - MY)));
      if (onY < onX) return y < vh / 2 ? (x - MX) : (w + h + (vw - MX - x));
      return x < vw / 2 ? (w + h + w + (vh - MY - y)) : (w + (y - MY));
    };
    const total = 2 * w + 2 * h;
    /**
     * 量一个步长下的最大位移。
     *
     * ⚠️⚠️ **判据是「位移随步长等比缩小」，不是「位移小于某个绝对值」**（实测踩到）：
     * 首版写「15° 步长位移 < 300px」，实测 327px 真红 —— 但探针查明那 327px 是
     * **沿同一条右边从 y=624 滑到 y=297**（两点 x 都是 62），是平滑移动而非闪现。
     * 步长 15°→5°→1° 实测 327→149→48px，**随步长单调缩小** ⇒ 连续。
     * 分带方案的 645~735px 是「跨边闪现」，缩小步长也不会变小。
     */
    const measure = async (step) => {
      let prev = null;
      let worst = 0;
      let info = null;
      let shownCount = 0;
      for (let deg = 0; deg <= 360; deg += step) {
        g.player.yaw = (deg * Math.PI) / 180;
        g.player.pitch = 0;
        await two();
        const box = document.getElementById('mc-enemy-arrows-zombie');
        const shown = box && getComputedStyle(box).display !== 'none';
        if (!shown) { prev = null; continue; }
        shownCount += 1;
        const tr = box.querySelector('i').getBoundingClientRect();
        const x = tr.left + tr.width / 2;
        const y = tr.top + tr.height / 2;
        const s = perim(x, y);
        if (prev !== null) {
          let dd = Math.abs(s - prev.s);
          dd = Math.min(dd, total - dd);
          if (dd > worst) { worst = dd; info = { deg, fromX: prev.x, toX: x, fromY: prev.y, toY: y }; }
        }
        prev = { x, y, s };
      }
      return { worst, info, shownCount };
    };
    const coarse = await measure(15);
    const fine = await measure(3);
    g.player.yaw = 0;
    return { coarse, fine, total };
  }, { spawnSrc: SPAWN_LEVEL_BEHIND.toString(), twoSrc: TWO_FRAMES.toString() });

  expect(r.err).toBeUndefined();
  expect(r.coarse.shownCount, '前置：粗扫至少 6 个采样点显示箭头').toBeGreaterThanOrEqual(6);
  expect(r.fine.shownCount, '前置：细扫采样点更多').toBeGreaterThan(r.coarse.shownCount);
  // ⭐ 连续性签名：步长缩到 1/5，最大位移必须**明显变小**（至少减半）。
  // 跨边闪现（分带方案的 645~735px）对这个比值不敏感 —— 它就是固定的一跃。
  expect(r.fine.worst,
    `细扫(3°)最大位移 ${r.fine.worst.toFixed(0)}px 应明显小于粗扫(15°)的 ${r.coarse.worst.toFixed(0)}px`)
    .toBeLessThan(r.coarse.worst * 0.5);
  // 细扫下的绝对上界：3° 转身不应超过 120px（实测 1°=48px、3°≈100px）
  expect(r.fine.worst, `3° 步长的最大位移 ${r.fine.worst.toFixed(0)}px`).toBeLessThan(120);
});