import { test, expect } from 'playwright/test';

test('准心：屏幕正中 20×20 十字，不拦截输入', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => window.__MC_BOOT__?.rendererReady === true, null, { timeout: 30_000 });
  // 准心由 `src/ui/crosshair.js` 在 Game 启动时创建 → 等它出现
  await page.waitForSelector('#crosshair', { timeout: 10_000 });
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

/**
 * Tier 4：准心自适应配色（v1.64）—— 像素级验收。
 *
 * 问题：准心原来固定纯白，对准白墙 / 雪地 / 天空时直接消失。
 *
 * **为什么不是 `difference` 反色**：GPU 反色在背景色与笔画色相同时输出完全相同 ——
 * 背景亮度≈128 处反色结果≈127，与背景同色。**中灰盲区是数学必然**，不是参数没调好
 * （实测纯反色在 127/128 处 Δ=1）。加黑衬能补，但用户明确要求不要衬层（显得十字太粗）。
 *
 * 现行方案（`src/ui/crosshair.js`）：**默认白色，只在背景亮到白芯几乎看不见时才切黑**
 * （阈值 220，即白芯对比度 < 35）。实测依据：
 *   · 白色准心的对比度 = 255 − 背景亮度；
 *   · 游戏内**全部 126 种方块**铺地实测：最亮 181（cloud / snow / snow_leaves）→ 对比度 74，
 *     **没有任何方块**会把背景推过 220 → 对着地面时准心恒为白；
 *   · 天空实测最高 251，28 个天空采样点里只有 4 个（最亮的天区 225~251）会转黑。
 * 所以日常游玩几乎全是白芯，只有直视极亮天空才转黑，且靠 20 档迟滞避免来回跳。
 *
 * 判据（缺一条都有一类缺陷溜过）：
 *   ① **默认白 / 绝大多数场景白**：对任意方块地面都必须是白 —— 这是本版的核心口径。
 *   ② **只在极亮时转黑**：极亮天空必须转黑，否则白芯会消失（这是功能存在的理由）。
 *      亮度处于中间地带（如雪地 181）时**不许**转黑，否则就是退回「按中点选色」的旧行为。
 *   ③ **迟滞方向正确**：转黑后要明显变暗才回白 —— 防止黑白反复横跳。
 *   ④ **采样值来自 `render()` 之后**（0 说明取在渲染前，会让准心永远判暗而恒白）。
 *   ⑤ **笔画几何恒为两笔 2px**（用户明确要求不显粗、不加衬层）。
 *
 * ⚠️ 四个测量陷阱（都实际踩过，会得到「机制上不可能」的数值）：
 *   a. **不能用 `pushModal` 冻结视角**：它阻断 `player.update` → 相机不跟随 pitch →
 *      不管怎么改视角采样值都一样（实测恒 0，一度误判为「采样坏了」）。正确做法是只停
 *      `physics.step`，相机仍由 `player.update()` 跟随新位置（`fog-color.spec` 的既有教训）。
 *   b. **参考板不影响采样**：准心采样的是 **canvas**（真实场景），DOM 参考板只盖住屏幕像素、
 *      不改变画面内容。所以场景必须靠**转视角或铺方块**构造，铺 DOM 板无效。
 *   c. **`drawImage(canvas)` 必须在 `renderer.render()` 之后**：WebGPU swapchain 在渲染前
 *      读到恒 0（实测 `beforeRender`=0 / `afterRender`=209）→ 准心会永远判为暗背景而恒白。
 *   d. **不能靠「低头看地」假定暗、靠「看天」假定亮**：准心只采样中央 28px，出生点地面可能
 *      是亮沙地 / 水面（实测低头采样 181，与看天 180 几乎相同）→ 按视角假定明暗会偶发 FAIL
 *      （实测 1/6）。亮暗场景一律用**铺固定方块** + **扫多个天区角度**确定性构造。
 */

/** 在帧循环内插桩，收集真实采样到的亮度序列 */
async function traceLuminance(page) {
  await page.evaluate(() => {
    const ch = window.__MC_GAME__.crosshair;
    const orig = ch._sampleLuminance.bind(ch);
    window.__lumLog = [];
    ch._sampleLuminance = (canvas) => {
      const v = orig(canvas);
      window.__lumLog.push(v);
      return v;
    };
  });
}

test('准心配色：默认白，仅极亮背景转黑，且不显粗', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/?vd=4&weather=clear');
  await page.waitForFunction(() => window.__MC_BOOT__?.rendererReady === true, null, { timeout: 60_000 });
  await page.waitForSelector('#crosshair', { timeout: 10_000 });
  await page.waitForTimeout(1500);

  const setup = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    // ⚠️ 只停物理，不用 pushModal —— pushModal 会阻断 player.update，相机就不跟随 pitch 了
    g.player.physics.step = () => {};
    g.setVisualStyle('noon');
    g.setShadowsEnabled(false);
    for (const el of document.querySelectorAll('#hud-root > *')) el.style.display = 'none';
    const ch = document.getElementById('crosshair');
    // ⑤ 笔画几何：必须恰好两笔（横 20×2 + 竖 2×20），没有第三层衬底
    const strokes = [...ch.children].map((el) => {
      const r = el.getBoundingClientRect();
      return `${Math.round(r.width)}x${Math.round(r.height)}`;
    }).sort();
    return {
      strokes,
      hasOutline: document.getElementById('crosshair-outline') !== null,
      initialColor: getComputedStyle(ch).color,
    };
  });

  // ⑤ 几何判据：不加衬层，笔画恒 2px
  expect(setup.strokes, '准心只允许两笔 2px 十字（用户要求不显粗、不加衬层）').toEqual(['20x2', '2x20']);
  expect(setup.hasOutline, '不得存在衬层元素').toBe(false);
  // ① 初始状态就是白 —— 默认口径
  expect(setup.initialColor, '准心默认必须是白色').toBe('rgb(255, 255, 255)');

  await traceLuminance(page);

  // ---- ① 任意方块地面：必须是白（覆盖「绝大多数情况」）----
  const groundOut = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    const p = g.player.physics.pos;
    const px = Math.floor(p.x), pz = Math.floor(p.z), py = Math.floor(p.y);
    const out = [];
    // 覆盖光谱两端：最亮（snow/cloud）、中等（stone）、最暗（obsidian）
    for (const name of ['snow', 'cloud', 'snow_block', 'end_stone', 'stone', 'dirt', 'obsidian']) {
      let id;
      try { id = g.registry.idOf(name); } catch { continue; }
      // 11×11 地板铺在脚下 2 格，上方清空
      for (let dx = -5; dx <= 5; dx++) {
        for (let dz = -5; dz <= 5; dz++) {
          for (let dy = -1; dy <= 3; dy++) {
            g.editor.setBlock({ x: px + dx, y: py + dy, z: pz + dz, id: 0, meta: 0 });
          }
          g.editor.setBlock({ x: px + dx, y: py - 2, z: pz + dz, id, meta: 0 });
        }
      }
      g.player.pitch = -1.5;
      await new Promise((r) => setTimeout(r, 1500)); // 等 remesh + 采样节流
      window.__lumLog = [];
      await new Promise((r) => setTimeout(r, 400));
      out.push({
        name,
        lum: window.__lumLog.at(-1) ?? null,
        color: getComputedStyle(document.getElementById('crosshair')).color,
      });
    }
    return out;
  });

  for (const r of groundOut) {
    expect(
      r.color,
      `方块 ${r.name}（背景亮度 ${r.lum === null ? '?' : Math.round(r.lum)}）上准心必须保持白色 —— ` +
        '默认白是这一版的设计口径'
    ).toBe('rgb(255, 255, 255)');
  }
  // 最亮的方块也必须离阈值有余量（否则说明阈值定得太低，雪地就会转黑）
  const brightest = groundOut.reduce((a, b) => ((a.lum ?? 0) >= (b.lum ?? 0) ? a : b));
  expect(
    brightest.lum,
    `最亮的方块是 ${brightest.name}（亮度 ${Math.round(brightest.lum)}）—— 必须远低于阈值 220，` +
      '否则雪地会转黑、违背「绝大多数情况白」'
  ).toBeLessThan(200);

  // ---- ② 极亮天空：必须转黑（功能存在的理由）----
  // ⚠️ **不能假设某个固定角度是「极亮」**：实测极亮区（>220）只占 208 个方向的 8 个，
  // 且集中在太阳附近、随日内时间漂移 —— 固定 pitch/yaw 会偶发只采到 191（实测 2/4 轮 FAIL）。
  // 正确做法：**扫描球面找实际最亮处**，再按实测值断言。
  const skyOut = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    const ch = g.crosshair;
    const pause = (ms) => new Promise((r) => setTimeout(r, ms));
    const out = [];
    // 粗扫整个球面（步长 0.4 rad，约 208 个方向）—— 只为找最亮方向，故取快档
    for (let pitch = -1.5; pitch <= 1.55; pitch += 0.25) {
      for (let yaw = 0; yaw < 6.28; yaw += 0.4) {
        g.player.pitch = pitch;
        g.player.yaw = yaw;
        await pause(140);
        const lum = ch._sampleLuminance(ch._resolveCanvas());
        if (lum !== null) out.push({ pitch, yaw, lum });
      }
    }
    return out;
  });

  // 记下最亮方向，供后面的迟滞用例复用（避免写死角度）
  await page.evaluate(({ pitch, yaw }) => { window.__brightestSky = { pitch, yaw }; },
    skyOut.reduce((a, b) => (a.lum >= b.lum ? a : b)));

  // ④ 采样必须拿到真实非零亮度（0 说明取在 render 之前）
  for (const r of skyOut) {
    expect(r.lum, `天区采样亮度必须是真实画面（0 = 取在 render() 之前）`).toBeGreaterThan(5);
  }

  const brightestSky = skyOut.reduce((a, b) => (a.lum >= b.lum ? a : b));
  expect(
    brightestSky.lum,
    `必须能扫描到极亮天区（实测最亮 253）—— 只扫到 ${Math.round(brightestSky.lum)} 说明场景不对`
  ).toBeGreaterThan(220);

  // 把视角**停在最亮处**，等采样节流 + 迟滞跑完再读颜色
  const skyColor = await page.evaluate(async ({ pitch, yaw }) => {
    const g = window.__MC_GAME__;
    g.player.pitch = pitch;
    g.player.yaw = yaw;
    await new Promise((r) => setTimeout(r, 800));
    window.__lumLog = [];
    await new Promise((r) => setTimeout(r, 320));
    return {
      lum: window.__lumLog.at(-1) ?? null,
      color: getComputedStyle(document.getElementById('crosshair')).color,
    };
  }, brightestSky);
  expect(
    skyColor.color,
    `最亮天区（亮度 ${Math.round(skyColor.lum)} > 阈值 220）必须转黑，否则白芯会在天空上消失`
  ).toBe('rgb(0, 0, 0)');

  // 中间地带必须保持白（不许退回「按中点选色」的旧行为）
  const midway = skyOut.filter((r) => r.lum > 120 && r.lum <= 190);
  expect(midway.length, '扫描结果里必须有中间亮度的天区样本').toBeGreaterThan(0);
  const midwayColor = await page.evaluate(async ({ pitch, yaw }) => {
    const g = window.__MC_GAME__;
    g.player.pitch = pitch;
    g.player.yaw = yaw;
    await new Promise((r) => setTimeout(r, 800));
    window.__lumLog = [];
    await new Promise((r) => setTimeout(r, 320));
    return {
      lum: window.__lumLog.at(-1) ?? null,
      color: getComputedStyle(document.getElementById('crosshair')).color,
    };
  }, midway[0]);
  expect(
    midwayColor.color,
    `天区亮度 ${Math.round(midwayColor.lum)}（中间地带，≤190）必须保持白色 —— ` +
      '阈值是 220，转黑就是退回「按中点选色」的旧行为'
  ).toBe('rgb(255, 255, 255)');

  // ---- ③ 迟滞：转黑后要明显变暗才回白 ----
  const hysteresis = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    const ch = g.crosshair;
    const pause = (ms) => new Promise((r) => setTimeout(r, ms));
    // 先转到扫描到的**最亮**天区让它变黑（不写死角度 —— 极亮区随日内时间漂移）
    g.player.pitch = window.__brightestSky.pitch;
    g.player.yaw = window.__brightestSky.yaw;
    await pause(800);
    const blackState = { color: getComputedStyle(ch.el).color, lum: ch.lastLuminance };
    // 再看中等亮度的雪地（亮度约 181 —— 低于 SWITCH_LOW=200，应当回白）
    const p = g.player.physics.pos;
    const px = Math.floor(p.x), pz = Math.floor(p.z), py = Math.floor(p.y);
    const id = g.registry.idOf('snow');
    for (let dx = -5; dx <= 5; dx++) {
      for (let dz = -5; dz <= 5; dz++) {
        for (let dy = -1; dy <= 3; dy++) {
          g.editor.setBlock({ x: px + dx, y: py + dy, z: pz + dz, id: 0, meta: 0 });
        }
        g.editor.setBlock({ x: px + dx, y: py - 2, z: pz + dz, id, meta: 0 });
      }
    }
    // ⚠️ **yaw 也必须设回 0**：之前停在最亮天区的 yaw=3.2，低头后视线仍朝向那片天空的
    // 方向（实测 yaw=3.2 时低头仍采到 255，yaw=0 时才是地面 181）。朝向与俯角是两个变量。
    g.player.yaw = 0;
    g.player.pitch = -1.5;
    await pause(2200);
    // ⚠️ 必须读**帧循环写入的** `lastLuminance`，不要手动调 `_sampleLuminance` ——
    // 手动调发生在 evaluate 内、渲染循环之外，读到的可能是上一帧的天空（实测读到 255）
    return {
      blackState,
      whiteState: { color: getComputedStyle(ch.el).color, lum: ch.lastLuminance },
    };
  });
  expect(hysteresis.blackState.color, '极亮天空上应是黑').toBe('rgb(0, 0, 0)');
  expect(
    hysteresis.whiteState.color,
    `转黑后看到雪地（亮度 ${Math.round(hysteresis.whiteState.lum)}，低于回白阈值 200）必须回白`
  ).toBe('rgb(255, 255, 255)');
});
