// tests/player-flight.spec.mjs — 玩家飞行（spec 2026-10-25-player-flight-design.md §5.2）
//
// 走**真实 keydown 派发 + 真游戏页**，不调测试 API：飞行的落点就是键盘主路径。
// ⚠️ 无头环境无真实键鼠，但 `window.dispatchEvent(new KeyboardEvent(...))` 走的是
// `player.js` 里那条 window 监听器 —— 与真实按键等价（`zombies.spec.mjs` / `m3-1-inventory.spec.mjs`
// 同手法）。不用 `page.keyboard.press`：它需要元素焦点，而本页监听在 window 上且
// pointer lock 在无头环境不成立，`page.keyboard` 会打到一个不确定的焦点元素。
import { test, expect } from 'playwright/test';

const URL = '/?vd=2&seed=12345';

/** 等世界稳定：worldReady + mesh 队列归零 + 玩家已站定。 */
async function boot(page) {
  test.setTimeout(180_000);
  await page.goto(URL);
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 90_000 });
  await page.waitForFunction(() => {
    const s = window.__MC_GAME__.scheduler.stats();
    return s.meshInflight === 0 && s.meshQueued === 0 && s.uploadQueue === 0;
  }, null, { timeout: 60_000, polling: 300 });
  // 等玩家落定：出生点在城市中心，加载期物理尚未收敛，直接按 F 会量到一段自由落体
  // （那段位移会混进「起飞后高度」的差值里，让断言测的不是飞行）。
  await page.waitForFunction(() => window.__MC_GAME__.player.physics.onGround === true,
    null, { timeout: 30_000, polling: 100 });
}

const press = (page, code) => page.evaluate((c) =>
  window.dispatchEvent(new KeyboardEvent('keydown', { code: c, bubbles: true })), code);
const release = (page, code) => page.evaluate((c) =>
  window.dispatchEvent(new KeyboardEvent('keyup', { code: c, bubbles: true })), code);

test('E1：F 起飞 + 按住空格爬升，高度确实上升', async ({ page }) => {
  await boot(page);
  const y0 = await page.evaluate(() => window.__MC_GAME__.player.physics.pos.y);
  await press(page, 'KeyF');
  await release(page, 'KeyF');
  const flying = await page.evaluate(() => window.__MC_GAME__.player.physics.flying);
  expect(flying, '按 F 后必须进入飞行态').toBe(true);

  await press(page, 'Space');
  await page.waitForTimeout(2000);
  await release(page, 'Space');
  const after = await page.evaluate(() => ({
    y: window.__MC_GAME__.player.physics.pos.y,
    flying: window.__MC_GAME__.player.physics.flying,
  }));
  expect(after.flying, '爬升期间仍须是飞行态').toBe(true);
  expect(after.y - y0, `2 秒爬升须明显高于起飞点（实测 Δ=${after.y - y0}）`).toBeGreaterThan(5);
});

test('E2：空中再按 F 落回地面', async ({ page }) => {
  await boot(page);
  await press(page, 'KeyF'); await release(page, 'KeyF');
  await press(page, 'Space');
  await page.waitForTimeout(1500);
  await release(page, 'Space');
  // 先确认确实在高处（否则「落回地面」可能只是因为本来就在地面）
  const high = await page.evaluate(() => window.__MC_GAME__.player.physics.pos.y);
  await press(page, 'KeyF'); await release(page, 'KeyF');
  await page.waitForFunction(() => window.__MC_GAME__.player.physics.onGround === true,
    null, { timeout: 30_000, polling: 100 });
  const st = await page.evaluate(() => ({
    flying: window.__MC_GAME__.player.physics.flying,
    y: window.__MC_GAME__.player.physics.pos.y,
  }));
  expect(st.flying, '再次按 F 退出飞行').toBe(false);
  expect(st.y, `须已落回地面（高空 ${high} → ${st.y}）`).toBeLessThan(high - 3);
});

test('E3：按住 Shift 降到地面后自动退出飞行（Java 口径）', async ({ page }) => {
  await boot(page);
  await press(page, 'KeyF'); await release(page, 'KeyF');
  await press(page, 'Space');
  await page.waitForTimeout(1500);
  await release(page, 'Space');
  const y0 = await page.evaluate(() => window.__MC_GAME__.player.physics.pos.y);
  await press(page, 'ShiftLeft');
  await page.waitForFunction(() => window.__MC_GAME__.player.physics.onGround === true,
    null, { timeout: 30_000, polling: 100 });
  const st = await page.evaluate(() => ({
    flying: window.__MC_GAME__.player.physics.flying,
    onGround: window.__MC_GAME__.player.physics.onGround,
    y: window.__MC_GAME__.player.physics.pos.y,
  }));
  await release(page, 'ShiftLeft');
  expect(st.flying, '下降触地必须自动退出飞行').toBe(false);
  expect(st.onGround).toBe(true);
  expect(st.y, `须降到地面以下（起飞高度 ${y0}）`).toBeLessThan(y0 - 3);
});

test('E4：飞行水平速度约为走路的 2 倍', async ({ page }) => {
  await boot(page);
  // 固定 yaw：前进沿 +X（与 `test-player-input.js` 的 stepDelta 同口径）
  const walk = await page.evaluate(async () => {
    const g = window.__MC_GAME__; const pl = g.player;
    pl.yaw = -Math.PI / 2;
    const x0 = pl.physics.pos.x;
    pl.keys.add('KeyW');
    await new Promise((r) => setTimeout(r, 600));
    pl.keys.delete('KeyW');
    return pl.physics.pos.x - x0;
  });
  // 起飞并**用空格真爬升**到高处再量（不假 teleport —— 直接改 pos.y 可能把玩家塞进建筑/巨树里，
  // 那会让这一条因错误原因失败）。云不是水平阻碍（M2-7），高空直飞是安全路径。
  const fly = await page.evaluate(async () => {
    const g = window.__MC_GAME__; const pl = g.player;
    pl.physics.toggleFlight();
    pl.keys.add('Space');
    await new Promise((r) => setTimeout(r, 2500));
    pl.keys.delete('Space');
    pl.yaw = -Math.PI / 2;
    const x0 = pl.physics.pos.x;
    pl.keys.add('KeyW');
    await new Promise((r) => setTimeout(r, 600));
    pl.keys.delete('KeyW');
    const dx = pl.physics.pos.x - x0;
    pl.physics.toggleFlight();
    return dx;
  });
  expect(walk, `前提：走路须真的前进，实测 ${walk}`).toBeGreaterThan(1);
  // 前提：飞行那一段没有被地形挡住（被挡就是误测，不是速度错 —— 先查这个再查公式）
  expect(fly, `前提：飞行须真的前进（未被建筑阻挡），实测 ${fly}`).toBeGreaterThan(walk * 1.4);
  const ratio = fly / walk;
  expect(ratio, `飞行/走路速度比须 ≈2（实测 ${ratio}，walk=${walk} fly=${fly}）`)
    .toBeGreaterThan(1.7);
  expect(ratio, `飞行/走路速度比须 ≈2（实测 ${ratio}）`).toBeLessThan(2.3);
});

test('E5：操作说明加飞行键位后不撑宽面板（Review Focus 5）', async ({ page }) => {
  await boot(page);
  const m = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    const help = g._hud.helpEl;
    const el = g._hud.el;
    return {
      panelWidth: el.getBoundingClientRect().width,
      clientWidth: help.clientWidth,
      scrollWidth: help.scrollWidth,
      hasFlight: help.textContent.includes('F：飞行开关'),
    };
  });
  expect(m.hasFlight, '操作说明须含飞行键位').toBe(true);
  expect(m.panelWidth, '面板宽度必须仍是 330（v1.80 用户裁定）').toBeCloseTo(330, 0);
  expect(m.scrollWidth, `操作说明不得横向溢出（scrollWidth ${m.scrollWidth} > clientWidth ${m.clientWidth} 即裁切）`)
    .toBeLessThanOrEqual(m.clientWidth);
});
