import { test, expect } from 'playwright/test';

// M4：受控 GLB 资产加载链（本地 r185.1 GLTFLoader，无外链依赖）。
// 加载失败必须报出可识别的武器 id 与资源 URL，且不破坏游戏可玩性（worldReady 保持 true）。
test('M4 GLB 资源经本地 r185 loader 加载且无外链依赖', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => window.__MC_BOOT__?.rendererReady === true, null, { timeout: 30_000 });
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 90_000 });
  const result = await page.evaluate(async () => {
    const { WeaponModelLoader } = await import('/src/render/weapon-model-loader.js');
    const loader = new WeaponModelLoader();
    const pistol = await loader.load('pistol');
    const mag7 = await loader.load('mag7');
    const minigun = await loader.load('minigun');
    let pistolMeshes = 0;
    pistol.traverse((node) => { if (node.isMesh) pistolMeshes++; });
    let unknownError = '';
    try { await loader.load('unknown'); } catch (error) { unknownError = error.message; }
    const broken = new WeaponModelLoader({ urls: { pistol: '/assets/models/weapons/missing.glb' } });
    let missingError = '';
    try { await broken.load('pistol'); } catch (error) { missingError = error.message; }
    broken.dispose();
    loader.dispose();
    return {
      pistolMeshes,
      mag7Children: mag7.children.length,
      minigunChildren: minigun.children.length,
      unknownError,
      missingError,
      worldReady: window.__MC_GAME__?.worldReady,
    };
  });
  expect(result.pistolMeshes).toBe(3);
  expect(result.mag7Children).toBeGreaterThan(0);
  expect(result.minigunChildren).toBeGreaterThan(0);
  expect(result.unknownError).toContain('unknown');
  expect(result.missingError).toContain('pistol');
  expect(result.worldReady).toBe(true);
});
