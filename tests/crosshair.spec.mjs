import { test, expect } from 'playwright/test';

test('准心：屏幕正中 20×20 十字，不拦截输入', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => window.__MC_BOOT__?.rendererReady === true, null, { timeout: 30_000 });
  const box = await page.evaluate(() => {
    const el = document.getElementById('crosshair');
    if (!el) return null;
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return {
      visible: cs.display !== 'none' && cs.visibility !== 'hidden',
      pointerEvents: cs.pointerEvents,
      x: r.x, y: r.y, w: r.width, h: r.height,
      vw: window.innerWidth, vh: window.innerHeight,
    };
  });
  expect(box).not.toBeNull();
  expect(box.visible).toBe(true);
  expect(box.pointerEvents).toBe('none');
  expect(box.w).toBe(20);
  expect(box.h).toBe(20);
  // 居中（±1px 容差）
  expect(Math.abs(box.x + box.w / 2 - box.vw / 2)).toBeLessThan(1);
  expect(Math.abs(box.y + box.h / 2 - box.vh / 2)).toBeLessThan(1);
});
