import { test, expect } from 'playwright/test';
import { PNG } from 'pngjs';

// tests/damage-flash.spec.mjs — 受伤红闪的 Tier 4 像素实测（v3.29）
//
// 用户 2026-11-21：「玩家如果受到攻击时，屏幕四周闪现一下掉血的动画，很简单，就是屏幕四周
// 向内有一个 40 像素的从半透明红到全透明红的渐变，表明玩家被攻击后掉血了」。
// 追加裁定：任何掉血都闪；血掉到 0 后受击**仍然**闪。
//
// ## 判据选型（为什么不是「整屏变红像素数」）
//
// 本仓实测教训：暖色/发光特效的判据必须**先排除自带同色的宿主**。
// 这里的宿主就是世界本身（沙漠沙、红石、血心、天空晚霞）。
// ⇒ 用「**四周 40px 带**的偏红像素」与「**中心区**的偏红像素」两个量的差分：
//   · 带内必须显著上升（红闪画在那里）
//   · 中心区必须基本不动（红闪不该污染画面中央）
// 单看带内绝对值会被背景色淹没（草地/沙漠本身就偏暖）。
//
// ## 冻结的动态源
//
// `?shadows=0&reflect=0&stats=0` + 等玩家落地 + 固定 seed。
// 不冻结的源（海面/手臂/昼夜/viewBob）在两次截图间会漂，但它们污染的是**中心区**，
// 而核心判据是「带内 vs 中心」的差分 + 与自身基线的对比 ⇒ 对缓慢漂移不敏感。
// （若实测发现抖动太大，改为「同一帧内 开/关」的两张差分。）

const SEED = 12345;
const BAND = 40;

/** 只扫四边 bandPx 带内的偏红像素数 */
function countEdgeRed(png, bandPx = BAND) {
  const { width, height, data } = png;
  let n = 0;
  for (let y = 0; y < height; y += 1) {
    const inBandY = y < bandPx || y >= height - bandPx;
    for (let x = 0; x < width; x += 1) {
      if (!inBandY && x >= bandPx && x < width - bandPx) continue;
      const i = (width * y + x) * 4;
      // 偏红 = 红显著高于绿与蓝（血心素材 255,19,19 与红闪 200,0,0 都满足）
      if (data[i] > 90 && data[i] - data[i + 1] > 40 && data[i] - data[i + 2] > 40) n += 1;
    }
  }
  return n;
}

/** 屏幕中心区（远离四边）的偏红像素数 —— 红闪不该影响中心 */
function countCenterRed(png, bandPx = BAND) {
  const { width, height, data } = png;
  const x0 = Math.floor(width * 0.35), x1 = Math.floor(width * 0.65);
  const y0 = Math.max(bandPx * 2, Math.floor(height * 0.35));
  const y1 = Math.min(height - bandPx * 2, Math.floor(height * 0.65));
  let n = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const i = (width * y + x) * 4;
      if (data[i] > 90 && data[i] - data[i + 1] > 40 && data[i] - data[i + 2] > 40) n += 1;
    }
  }
  return n;
}

async function bootFrozen(page) {
  await page.goto(`/?vd=4&seed=${SEED}&shadows=0&reflect=0&stats=0`);
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 90_000 });
  // 等玩家真正落地（下坠会改变整个画面）
  await page.waitForFunction(() => {
    const g = window.__MC_GAME__;
    const p = g.player.physics.pos;
    return g.world.isSolid(Math.floor(p.x), Math.floor(p.y - 0.5), Math.floor(p.z));
  }, null, { timeout: 30_000 });
  // 等红闪彻底不在（开局可能为空，这里是纵深防御）
  await page.waitForFunction(() => !window.__MC_GAME__._damageFlash.active, null, { timeout: 10_000 });
  await page.waitForTimeout(300);
}

test('受伤红闪 Tier 4：掉血后屏幕四周 40px 带变红，中心区基本不动', async ({ page }) => {
  test.setTimeout(180_000);
  await bootFrozen(page);

  const before = PNG.sync.read(await page.screenshot());
  const edgeBefore = countEdgeRed(before);
  const centerBefore = countCenterRed(before);

  // 触发一次真实掉血（走唯一入口），立刻截图（0.35s 寿命，截图在 ~50ms 内完成）
  await page.evaluate(() => window.__MC_GAME__._damagePlayer(1, performance.now()));
  const flashOn = await page.evaluate(() => window.__MC_GAME__._damageFlash.active);
  const after = PNG.sync.read(await page.screenshot());
  const edgeAfter = countEdgeRed(after);
  const centerAfter = countCenterRed(after);

  expect(flashOn, '前置：红闪已激活').toBe(true);
  expect(edgeAfter - edgeBefore,
    `四周带内偏红像素须显著增加（前 ${edgeBefore} → 后 ${edgeAfter}）`).toBeGreaterThan(2000);
  expect(Math.abs(centerAfter - centerBefore),
    `中心区不得被红闪污染（前 ${centerBefore} → 后 ${centerAfter}）`).toBeLessThan(400);
});

test('受伤红闪 Tier 4：0.35 秒后自动消失，opacity 回到 0 且节点隐藏', async ({ page }) => {
  test.setTimeout(180_000);
  await bootFrozen(page);

  await page.evaluate(() => window.__MC_GAME__._damagePlayer(1, performance.now()));
  const midState = await page.evaluate(() => ({
    active: window.__MC_GAME__._damageFlash.active,
    display: getComputedStyle(document.getElementById('mc-damage-flash')).display,
  }));
  expect(midState.active, '前置：刚触发时激活').toBe(true);
  expect(midState.display, '前置：刚触发时可见').toBe('block');

  await page.waitForTimeout(600);   // 远超 lifeMs=350
  const afterState = await page.evaluate(() => ({
    active: window.__MC_GAME__._damageFlash.active,
    display: getComputedStyle(document.getElementById('mc-damage-flash')).display,
    opacity: getComputedStyle(document.getElementById('mc-damage-flash')).opacity,
  }));
  expect(afterState.active, '红闪须已自动结束').toBe(false);
  expect(afterState.display, '结束后节点须隐藏（不占合成层）').toBe('none');
  expect(Number(afterState.opacity), '结束后 opacity = 0').toBe(0);
});

test('受伤红闪 Tier 4：血量已为 0 时受击仍然闪（用户明确要求）', async ({ page }) => {
  test.setTimeout(180_000);
  await bootFrozen(page);

  // 把血打到 0（用户裁定：不死、停在 0）
  const hp = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    g._damagePlayer(999, performance.now());
    return g.player.health;
  });
  expect(hp, '前置：血量停在 0').toBe(0);
  await page.waitForTimeout(600);   // 让上一次红闪完全淡出

  const before = PNG.sync.read(await page.screenshot());
  const edgeBefore = countEdgeRed(before);

  // 血已是 0，这次伤害不改变血量 —— 但仍须闪
  const r = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    const before = g.player.health;
    g._damagePlayer(1, performance.now());
    return { before, after: g.player.health, active: g._damageFlash.active };
  });
  const after = PNG.sync.read(await page.screenshot());
  const edgeAfter = countEdgeRed(after);

  expect(r.after, '前置：血量仍是 0（不死）').toBe(0);
  expect(r.active, '血量为 0 时受击仍须触发红闪').toBe(true);
  expect(edgeAfter - edgeBefore,
    `血量为 0 时四周带仍须变红（前 ${edgeBefore} → 后 ${edgeAfter}）`).toBeGreaterThan(2000);
});

test('受伤红闪：z-index = 56，落在伤害数字(55) 与设置按钮(60) 之间', async ({ page }) => {
  test.setTimeout(180_000);
  await bootFrozen(page);
  const z = await page.evaluate(async () => {
    const { DAMAGE_FLASH } = await import('/src/ui/damage-flash.js');
    return {
      declared: DAMAGE_FLASH.zIndex,
      actual: getComputedStyle(document.getElementById('mc-damage-flash')).zIndex,
    };
  });
  expect(z.declared, '常量 = 56').toBe(56);
  expect(z.actual, 'DOM 上的 z-index 与常量一致').toBe('56');
});
