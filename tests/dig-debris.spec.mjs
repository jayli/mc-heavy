import { test, expect } from 'playwright/test';
import { PNG } from 'pngjs';

/**
 * 徒手挖块碎片（v3.46）的**真游戏页**验收。
 *
 * 分工（docs/testing-policy.md §2.4）：
 * - 纯逻辑（配置区间 / 池账 / 锚点 / 确定性）走 `src/tests/test-block-hit-fx.js`；
 * - **本 spec** 只测只有真游戏页才成立的部分：走**玩家主路径** `digBlock()` 时碎片真的出、
 *   颜色真的来自被挖那块的材质（GPU 侧 instanceColor）、挖空气不出碎片。
 *
 * ⚠️ 为什么必须走 `digBlock()` 而不是直接调 `blockHitFx.spawnDigBurst()`：
 * M7 验收报告 §3.7 的教训 —— 只调测试 API 的用例全绿却漏了玩家主路径上的缺陷。
 * 本轮的接线点恰好就在 `digBlock()` 的「真删掉了」分支里，漏接是**静默**的
 *（音效照响、方块照没、就是没碎片）。
 *
 * ⚠️ **Tier 4 颜色判据不能只看「有没有亮像素」**：碎片走 `InstancedMesh.instanceColor`，
 * 若 instanceColor 没生效会全部渲染成材质白 —— 特效照常播、碎片照常飞，
 * 只是与方块材质无关。故主判据是**只差方块材质一个变量**的两侧对照。
 */

const BOOT_QUERY = 'seed=12345&vd=4&ambient=0&weather=clear&shadows=0&reflect=0&stats=0';

async function boot(page) {
  await page.setViewportSize({ width: 640, height: 480 });
  await page.goto(`/?${BOOT_QUERY}`);
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 90_000 });
  await page.waitForFunction(() => {
    const s = window.__MC_GAME__.scheduler.stats();
    return s.meshInflight === 0 && s.meshQueued === 0 && s.uploadQueue === 0;
  }, null, { timeout: 60_000, polling: 300 });
  // 等玩家真正落地（下坠会改变整个画面，同 damage-flash.spec 的 bootFrozen）
  await page.waitForFunction(() => {
    const g = window.__MC_GAME__;
    const p = g.player.physics.pos;
    return g.world.isSolid(Math.floor(p.x), Math.floor(p.y - 0.5), Math.floor(p.z));
  }, null, { timeout: 30_000 });
  await page.waitForTimeout(600);
}

/** 亮像素的平均色（黑背景剔除；与 block-hit-fx.spec.mjs 同口径） */
function litMean(png, threshold = 24) {
  let sr = 0, sg = 0, sb = 0, n = 0;
  for (let i = 0; i < png.data.length; i += 4) {
    const r = png.data[i], g = png.data[i + 1], b = png.data[i + 2];
    if ((r + g + b) / 3 <= threshold) continue;
    sr += r; sg += g; sb += b; n++;
  }
  return n ? { r: sr / n, g: sg / n, b: sb / n, n } : { r: 0, g: 0, b: 0, n: 0 };
}

/**
 * **差分像素**的平均色（on 帧相对 off 帧真正变了的那块 = 碎片本身）。
 *
 * ⚠️ **不能用全图亮像素均值**（本轮实测踩到）：真游戏页里背景是整个世界，
 * 640×480 下实测 **305259** 个亮像素，而碎片只占几百 ⇒ 两侧均值差只有 **1.65**
 *（阈 12）—— 判据零判别力，注入「instanceColor 恒白」也不会红。
 * 差分口径把背景约掉，与 `block-hit-fx.spec.mjs` 用黑底 fixture 是同一个目的。
 */
function diffMean(on, off, threshold = 8) {
  let sr = 0, sg = 0, sb = 0, n = 0;
  for (let i = 0; i < on.data.length; i += 4) {
    const d = Math.abs(on.data[i] - off.data[i])
      + Math.abs(on.data[i + 1] - off.data[i + 1])
      + Math.abs(on.data[i + 2] - off.data[i + 2]);
    if (d <= threshold) continue;
    sr += on.data[i]; sg += on.data[i + 1]; sb += on.data[i + 2]; n++;
  }
  return n ? { r: sr / n, g: sg / n, b: sb / n, n } : { r: 0, g: 0, b: 0, n: 0 };
}

test('挖块碎片：走 digBlock 主路径真的出碎片，挖空气不出', async ({ page }) => {
  test.setTimeout(150_000);
  await boot(page);
  const r = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    const pl = g.player;
    const p0 = pl.physics.pos;
    const bx = Math.floor(p0.x);
    const by = Math.floor(p0.y) + 1;
    const bz = Math.floor(p0.z) - 3;
    g.editor.setBlock({ x: bx, y: by, z: bz, id: g.registry.idOf('stone') });
    await new Promise((res) => setTimeout(res, 600));
    pl.setTestAim([0, 0, -1]);

    g.blockHitFx.reset();
    const base = g.blockHitFx.activeDebrisCount;
    const hadTarget = !!pl.target;
    pl.digBlock({});
    const gone = g.world.getBlockId(bx, by, bz) === 0;
    const afterDig = g.blockHitFx.activeDebrisCount;
    const visible = g.blockHitFx.debrisMesh.visible;

    // 再挖一次同一格（现在已是空气）→ 不得再出碎片
    g.blockHitFx.reset();
    pl.digBlock({});
    const afterAir = g.blockHitFx.activeDebrisCount;

    // 推进到寿命末尾 → 全部回收、池回到不可见（draw call 回基线）
    g.blockHitFx.reset();
    g.editor.setBlock({ x: bx, y: by, z: bz, id: g.registry.idOf('stone') });
    await new Promise((res) => setTimeout(res, 400));
    pl.digBlock({});
    g.blockHitFx.update(performance.now() + 5000);
    const afterExpire = g.blockHitFx.activeDebrisCount;
    const visibleAfterExpire = g.blockHitFx.debrisMesh.visible;

    return { hadTarget, gone, base, afterDig, visible, afterAir, afterExpire, visibleAfterExpire };
  });

  expect(r.hadTarget, '前提：须先命中方块').toBe(true);
  expect(r.gone, '前提：方块须真的被挖掉').toBe(true);
  expect(r.base, '前提：reset 后池空').toBe(0);
  // 主判据：挖掉方块必须出一簇碎片（注入「digBlock 不调 spawnDigBurst」→ 这条真红）
  expect(r.afterDig, `挖掉方块须出碎片，实测 ${r.afterDig}`).toBeGreaterThanOrEqual(10);
  expect(r.visible, '有碎片时池必须可见').toBe(true);
  // 挖空气不得出碎片（判据 = editor 返回零 changes，与 delete 音效同一条）
  expect(r.afterAir, `挖空气不得出碎片，实测 ${r.afterAir}`).toBe(0);
  expect(r.afterExpire, '寿命末尾必须全部回收').toBe(0);
  expect(r.visibleAfterExpire, '回收后池必须回到不可见').toBe(false);
});

test('挖块碎片 Tier 4：颜色来自被挖那块的材质（挖石头 vs 挖草，差分像素平均色显著不同）', async ({ page }) => {
  test.setTimeout(180_000);
  await boot(page);

  /**
   * 在**同一机位、同一格**挖不同材质的方块，取「有碎片 / 无碎片」两帧的差分。
   *
   * ⚠️ 三个必须冻结的变量（否则差分里混进非碎片像素）：
   *   ① `setVisualStyle('noon')` 冻日夜；② 藏 HUD 与手臂；③ `?ambient=0&weather=clear`
   *     关落叶/萤火虫/雨（boot query 已带）。
   * ⚠️ **off 帧必须在同一格重新放回同一方块后取**：挖掉后那一格变成洞，
   * 不回填的话差分里会多出「洞口露出的背景」一大片。
   * ⚠️ 取样时刻落在「碎片已散开、尚未缩零」的窗口：`lifeMs=620` × `shrinkFrom=0.78`
   * ⇒ 前 484ms 保持原尺寸，取 200ms。
   */
  const shoot = async (blockName) => {
    const info = await page.evaluate(async (name) => {
      const g = window.__MC_GAME__;
      const pl = g.player;
      g.setVisualStyle('noon');
      for (const el of document.querySelectorAll('#hud-root > *, #crosshair, #settings-btn')) el.style.display = 'none';
      if (g.viewArm?.mesh) g.viewArm.mesh.visible = false;
      // ⚠️ **冻海面波纹**（照 water-visual.spec 的五变量冻结）：不冻的话 uTime 每帧推进，
      // 水区两帧必然不同 ⇒ 差分里混进几万个非碎片像素（本轮实测：差分 58000 像素
      // 而碎片只占 ~16000，两侧均值差被稀释到 6.8）。
      g.ocean.update = () => {};
      const p0 = pl.physics.pos;
      const bx = Math.floor(p0.x);
      const by = Math.floor(p0.y) + 1;
      const bz = Math.floor(p0.z) - 3;
      g.editor.setBlock({ x: bx, y: by, z: bz, id: g.registry.idOf(name) });
      await new Promise((res) => setTimeout(res, 800));
      pl.setTestAim([0, 0, -1]);
      g.blockHitFx.reset();
      await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
      window.__DIG_CELL__ = [bx, by, bz, g.registry.idOf(name)];
      pl.digBlock({});
      const count = g.blockHitFx.activeDebrisCount;
      // ⚠️ **不手工调 update**：帧循环每帧都在调它，手工写的 age 下一帧就被真实 nowMs 覆盖
      //（本轮实测踩到）。改成**等真实时间走到 200ms**，与 ignis-fx 的「按半径等」同手法。
      await new Promise((res) => setTimeout(res, 200));
      await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
      return { count, name, live: g.blockHitFx.activeDebrisCount };
    }, blockName);
    const on = PNG.sync.read(await page.screenshot());
    // off 帧：清碎片 + 把同一格回填同一方块 ⇒ 两帧只差「有没有碎片」
    await page.evaluate(async () => {
      const g = window.__MC_GAME__;
      const [bx, by, bz, id] = window.__DIG_CELL__;
      g.blockHitFx.reset();
      g.editor.setBlock({ x: bx, y: by, z: bz, id });
      await new Promise((res) => setTimeout(res, 800));
      await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
    });
    const off = PNG.sync.read(await page.screenshot());
    return { info, mean: diffMean(on, off) };
  };

  const stone = await shoot('stone');
  const grass = await shoot('grass');

  // 前提：两侧都真的出了碎片，且差分真的捕到了像素（否则颜色比较是空对空）
  expect(stone.info.count, '挖石头须出碎片').toBeGreaterThanOrEqual(10);
  expect(grass.info.count, '挖草须出碎片').toBeGreaterThanOrEqual(10);
  expect(stone.info.live, '截图时碎片必须仍在飞（寿命 620ms，取样 200ms）').toBeGreaterThanOrEqual(10);
  expect(grass.info.live, '截图时碎片必须仍在飞').toBeGreaterThanOrEqual(10);
  expect(stone.mean.n, `石头侧差分须捕到碎片像素：${JSON.stringify(stone.mean)}`).toBeGreaterThan(60);
  expect(grass.mean.n, `草侧差分须捕到碎片像素：${JSON.stringify(grass.mean)}`).toBeGreaterThan(60);

  // 主判据：两侧差分平均色须显著不同（注入「instanceColor 恒白」→ 两侧相同 → 真红）
  const gap = Math.abs(stone.mean.r - grass.mean.r)
    + Math.abs(stone.mean.g - grass.mean.g)
    + Math.abs(stone.mean.b - grass.mean.b);
  expect(gap, `两种材质的碎片平均色须显著不同：stone=${JSON.stringify(stone.mean)} grass=${JSON.stringify(grass.mean)}`)
    .toBeGreaterThan(12);
  // 方向判据：草的碎片须偏绿（G 高于 R/B 均值）—— 光「不同」不够，还要「对」
  const grassGreen = grass.mean.g - (grass.mean.r + grass.mean.b) / 2;
  expect(grassGreen, `草的碎片须偏绿：${JSON.stringify(grass.mean)}`).toBeGreaterThan(2);
});