// tests/minecart-render.spec.mjs — 矿车渲染 Tier 4 像素实测（设计文档 §7 / §6 偏离 ⑤）
//
// **为什么必须像素实测**：车斗纹理是运行时 canvas 生成（无指纹门禁，偏离 ⑤）+
// 朝向旋转经实例矩阵在 GPU 求值 —— 单测（test-minecarts.js 的几何/矩阵断言）读不到
// 片元输出，证明不了「GPU 真按朝向转了、纹理真采到了」（testing-policy §5.1）。
//
// ⚠️ **阈值对着「屏幕实测值」定，不对图集/canvas 统计值**（M8 活跃约束，勿按纹理数字改阈值）。
// 探针实测（seed=12345 / vd=2 / 640×480 / 斜对角相机，自然光照）：车斗中心 5×5 取样
// 有车=(82.8,85.3,88.7) 偏蓝金属灰 vs 空场景=(69.8,69.7,69.7) 中性灰（铁轨）；
// orient0 vs orient1 逐像素差 = **1304 px，全部落在车轮带**（bbox y 248~297，车斗中心 y=235
// 之下）—— 车斗是 0.9×0.9 正方形 + 四轮对称布局，**四重旋转对称**，朝向差异只由车轮
// 圆柱轴向打破（orient0 轴朝 Z / orient1 轴朝 X，端面 vs 侧面亮度不同）；
// orient0 vs orient2（180°）差 = **0 px**（对称性钉住旋转量子 = orientation×π/2）；
// 车斗面内竖直剖面（过车斗中心 ±14 行，每行 ±2px 宽均值）：**有 map 极差 5.5
// （61.2~66.7，顶部压边 + 三段渐变）/ 无 map 恒为 86.0（极差 0.0）** —— MeshBasicMaterial
// 是 unlit、矿车 mesh 无 AO/顶点色，纹理是面内亮度变化的唯一来源 → 面内梯度是
// 「纹理真被采样」的判据（①~③ 都拓不住「去掉 map」：退回 bodyColor 反而更亮且仍偏蓝、
// 且纯色车斗同样四重对称 → d02 仍为 0）。
// ⚠️ spec 内冻结 `noon` 光照后绝对值整体变暗（spec 首跑实测：有车=(61.5,65.5,71.3) /
// 空场景=(37.7,37.6,37.6)，偏蓝与亮度差判据不变）—— 阈值按 **spec 自身的屏幕实测值**定。
//
// ⚠️ **两个环境隔离手段各有分工，不要删任一个**：
// ① `setVisualStyle('noon')` 冻结日夜循环 —— 判据 ① 要拿车斗与**背景（铁轨/地面）**比亮度差，
//    而地形是受光的 → 不冻结则两次截图的光照不同，背景基准会漂（探针实测未冻结时
//    orient3 的全图 diff bbox 被污染到 y=19）；
// ② 两个 diff 限定在车的包围盒内 —— 判据 ②③ 只关心车，而海面波纹（`ocean.update` 每帧
//    推进 `uTime`）/ 云 / 未收敛的地形 remesh 都会让全图 diff 多出上百像素
//    （探针实测：未等 remesh 收敛时 orient0 vs orient2 全图差 856 px，而车本身完全重合）。
import { test, expect } from 'playwright/test';
import { PNG } from 'pngjs';

/** 以 (cx,cy) 为中心、半径 r 的方形区域平均 RGB（同 turret-render.spec.mjs 手法） */
function regionRGB(png, cx, cy, r) {
  let sr = 0, sg = 0, sb = 0, n = 0;
  for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r; x <= cx + r; x++) {
    if (x < 0 || y < 0 || x >= png.width || y >= png.height) continue;
    const o = (y * png.width + x) * 4;
    sr += png.data[o]; sg += png.data[o + 1]; sb += png.data[o + 2]; n++;
  }
  return { r: sr / n, g: sg / n, b: sb / n, n };
}

/** 两张 PNG 的逐像素差异（容差 tol，可选限定在 box 内）：返回 {count, bbox} */
function diffPng(a, b, tol = 6, box = null) {
  const x0 = box ? box.x0 : 0, x1 = box ? box.x1 : a.width - 1;
  const y0 = box ? box.y0 : 0, y1 = box ? box.y1 : a.height - 1;
  let count = 0, bx0 = 1e9, by0 = 1e9, bx1 = -1, by1 = -1;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const o = (y * a.width + x) * 4;
    const d = Math.abs(a.data[o] - b.data[o]) + Math.abs(a.data[o + 1] - b.data[o + 1]) +
              Math.abs(a.data[o + 2] - b.data[o + 2]);
    if (d > tol) { count++; if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y; }
  }
  return { count, bbox: count ? { x0: bx0, y0: by0, x1: bx1, y1: by1 } : null };
}

/**
 * 等世界真正稳定（整段照 `tests/minecarts.spec.mjs` 复制，含判据与 90s timeout）。
 * 判据 = sections 连续两次采样不变 + 队列归零；不能只判队列归零（瞬时状态）。
 */
async function waitWorldSettled(page) {
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 90_000 });
  await page.waitForFunction(() => {
    const g = window.__MC_GAME__;
    const s = g.scheduler.stats();
    const sections = g.renderStats().sections;
    const prev = window.__MC_STABLE_PREV__;
    window.__MC_STABLE_PREV__ = sections;
    return prev === sections &&
      s.genInflight === 0 && s.meshInflight === 0 && s.meshQueued === 0 &&
      s.pendingMesh === 0 && s.lightInflight === 0 && s.lightQueued === 0 && s.uploadQueue === 0;
  }, null, { timeout: 90_000, polling: 500 });
}

test('矿车 Tier 4：车斗金属灰 + 朝向 0/1 投影不同（车轮带）+ 0/2 全等 + 面内梯度证纹理被采样', async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 640, height: 480 });
  await page.goto('/?vd=2&seed=12345&weather=clear');
  // ⚠️ 必须钉 seed（地形可复现 → 取样点稳定）；⚠️ **必须钉天气 = clear**（`?weather=` 是
  // main.js 的启动强制入口）：天气状态机会随机转雨，雨丝落在车盒内会扰动判据 ② 的
  // d01.count/bbox。日夜用 `setVisualStyle('noon')` 冻结，天气走 URL 而不是运行时
  // `g.weather.force('clear')` —— 后者从当前 intensity **平滑过渡**（weather.js:26），
  // 需额外等过渡收敛；URL 从启动就钉住，无过渡窗口。
  await waitWorldSettled(page);

  // ---- 搭隔离场景：清空 7×7×7 → 铺十字轨（alignToTrack 允许任意朝向）→ 冻结玩家/光照 ----
  const setup = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    const px = Math.floor(g.player.physics.pos.x), pz = Math.floor(g.player.physics.pos.z);
    const trackId = g.registry.idOf('sand_train_track');
    let spot = null;
    for (let ox = px + 2; ox <= px + 20 && !spot; ox++) {
      for (let oz = pz - 12; oz <= pz + 12 && !spot; oz++) {
        let gy = null;
        for (let y = 90; y > -32; y--) { if (g.world.getBlockId(ox, y, oz) !== 0) { gy = y; break; } }
        if (gy === null || !g.world.isSolid(ox, gy, oz)) continue;
        let okAll = true;
        for (let dx = -3; dx <= 3 && okAll; dx++) for (let dz = -3; dz <= 3 && okAll; dz++) {
          if (!g.world.hasColumn(Math.floor((ox + dx) / 16), Math.floor((oz + dz) / 16))) okAll = false;
        }
        if (okAll) spot = { ox, oz, gy };
      }
    }
    if (!spot) return { failed: true };
    const { ox, oz, gy } = spot;
    // 清空 gy+1..gy+7（车与相机的空间）—— 背景只剩天空与地面，取样不被杂物污染
    for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) {
      for (let dy = 1; dy <= 7; dy++) g.editor.setBlock({ x: ox + dx, y: gy + dy, z: oz + dz, id: 0 });
    }
    const trackY = gy + 1;
    for (const [dx, dz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
      g.editor.setBlock({ x: ox + dx, y: trackY, z: oz + dz, id: trackId, meta: 0 });
    }
    // 冻结玩家（pushModal → game.js 帧循环跳过 player.update → 相机不再被物理挪走）
    g.pushModal('tier4-probe');
    // 冻结日夜循环 —— 否则相邻截图之间天空色漂移污染全图 diff（探针实测）
    g.setVisualStyle('noon');
    // 隐藏准心（DOM difference 混合，会反色污染屏幕中心取样区）
    const ch = document.getElementById('crosshair');
    if (ch) ch.style.display = 'none';
    // 斜对角相机（+X+Z 方向）：车轮圆柱「端面 vs 侧面」的亮度差异最大
    g.camera.position.set(ox + 0.5 + 2.4, trackY + 2.0, oz + 0.5 + 2.4);
    g.camera.lookAt(ox + 0.5, trackY + 1.45, oz + 0.5);
    g.camera.updateMatrixWorld();
    return { failed: false, cx: ox, cz: oz, trackY, carY: trackY + 1 };
  });
  expect(setup.failed, '须找到可隔离的地面').toBe(false);

  await waitWorldSettled(page);   // 等清场 + 铺轨的 remesh 收敛
  await page.waitForTimeout(1200);

  /** 世界点 → 屏幕像素（renderer.render 每帧更新 matrixWorldInverse） */
  const project = (wp) => page.evaluate((p) => {
    const g = window.__MC_GAME__;
    const v = new g.camera.position.constructor(p[0], p[1], p[2]);
    v.project(g.camera);
    return { x: Math.round((v.x * 0.5 + 0.5) * window.innerWidth),
             y: Math.round((-v.y * 0.5 + 0.5) * window.innerHeight) };
  }, wp);
  const bodyPx = await project([setup.cx + 0.5, setup.carY + 0.5, setup.cz + 0.5]);

  /** 放一辆指定朝向的车（不激活 → 静止便于截图）→ 等 2 帧 renderer.sync → 截图 */
  async function shootWith(orientation) {
    const placed = await page.evaluate((o) => {
      const g = window.__MC_GAME__;
      for (const c of g.minecarts.cars()) g.minecarts.destroy(c.id);
      return g.minecarts.place({ cell: [window.__S.cx, window.__S.carY, window.__S.cz], orientation: o });
    }, orientation);
    expect(placed.ok, `朝向 ${orientation} 放置须成功`).toBe(true);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    return PNG.sync.read(await page.screenshot());
  }
  await page.evaluate((s) => { window.__S = s; }, setup);
  await page.evaluate(() => {   // 空场景对照（无车）
    const g = window.__MC_GAME__;
    for (const c of g.minecarts.cars()) g.minecarts.destroy(c.id);
  });
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const pngEmpty = PNG.sync.read(await page.screenshot());
  const png0 = await shootWith(0);
  const png1 = await shootWith(1);
  const png2 = await shootWith(2);

  // 前提：渲染器真的接线了（slot 分配 + visible=true）—— 否则下面测的是空气
  const renderState = await page.evaluate(() => ({
    slotCount: window.__MC_GAME__.minecartRenderer.slotCount(),
    visible: window.__MC_GAME__.minecartRenderer.meshes.body.visible,
  }));
  expect(renderState.slotCount, '放置后 renderer.sync 须分配 slot').toBe(1);
  expect(renderState.visible, '有活跃矿车时 body mesh 须可见').toBe(true);

  // ---- ① 车斗区采到金属灰（非黑、非背景）----
  // spec 首跑实测（noon 冻结光照）：有车 (61.5,65.5,71.3) 偏蓝金属灰 vs
  // 空场景 (37.7,37.6,37.6) 中性灰（铁轨）。
  // 注入「材质退回纯黑（color=0）」→ 三通道骤降 → 下面颜色断言 FAIL；
  // 注入「车没渲染」→ 取样值回到空场景值 → 与 empty 的亮度差断言 FAIL。
  // ⚠️ 注入「只去掉 map（退回 bodyColor 0xb8bec6 亮灰）」**不由本组颜色断言抓**
  // （实测 (83,86,89) 仍过 r>55 且 b−r=+6）—— 它由下面 ④ 的面内梯度断言抓。
  const R = 2;   // 5×5px（车斗在屏幕上约 130px 宽，中心区足够大且不跨边缘）
  const body = regionRGB(png0, bodyPx.x, bodyPx.y, R);
  const bodyEmpty = regionRGB(pngEmpty, bodyPx.x, bodyPx.y, R);
  console.log('BODY:', JSON.stringify({ body, bodyEmpty, bodyPx }));
  expect(body.r, `车斗须为金属灰（非黑）：${JSON.stringify(body)}`).toBeGreaterThan(55);
  expect(body.g, '车斗须为金属灰（非黑）').toBeGreaterThan(58);
  expect(body.b, '车斗须为金属灰（非黑）').toBeGreaterThan(62);
  // 金属灰偏蓝（canvas 纹理渐变 #a7afb8→#c0c6ce→#8f98a2 都是 b>r，实测 b−r=+5.8）——
  // 空场景铁轨是中性的（b−r≈0）。拓住「退回中性灰/纯黑」；⚠️ 拓不住「退回 bodyColor」
  // （实测 (83,86,89)，b−r=+6 仍偏蓝且更亮）—— 那由 ④ 的面内梯度断言抓（见下）。
  expect(body.b - body.r, '车斗须偏蓝金属灰（不是中性灰背景）').toBeGreaterThan(2);
  // 非背景：与空场景同点亮度差显著（spec 实测 Δ≈85/三通道和）
  const lumaDelta = Math.abs(body.r - bodyEmpty.r) + Math.abs(body.g - bodyEmpty.g) +
                    Math.abs(body.b - bodyEmpty.b);
  expect(lumaDelta, '车斗像素须显著不同于背景（车真渲染了）').toBeGreaterThan(15);

  // ---- 车的屏幕包围盒（由 AABB 投影算出，确定性、不含天空）----
  // ⚠️ **后续两个 diff 都限定在本盒内**：全图 diff 会被环境漂移污染 —— 探针实测
  // （未等 remesh 完全收敛时）orient0 vs orient2 在画面上部多出 856 px 差异，而车本身
  // 完全重合。海面波纹（`ocean.update` 每帧推进 `uTime`）与云也会动。
  // ⚠️ **不用「有车 vs 无车」的 diff 盒**：实测那种盒会被同一批天空漂移**撑大**
  // （得到 x62~384 / y19~297，而车本体只占 x255~384 / y184~297）→ 只是部分防护。
  // 改用**几何投影**：把 `MINECART_AABB`（从 config 读，红线 1 不写字面量）的 8 个角
  // 投影到屏幕取包围盒 → 确定性、与截图时机无关、天然排除天空。
  const cartBox = await page.evaluate(() => {
    const g = window.__MC_GAME__;
    const car = g.minecarts.cars()[0];
    const [px, py, pz] = car.state.position;
    // 动态 import 读单一权威（页面是 ES module + import map，可直接引项目模块）
    return import('/src/entities/minecarts/minecart-config.js').then(({ MINECART_AABB }) => {
      const V = g.camera.position.constructor;
      let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
      for (const dx of [MINECART_AABB.min[0], MINECART_AABB.max[0]]) {
        for (const dy of [MINECART_AABB.min[1], MINECART_AABB.max[1]]) {
          for (const dz of [MINECART_AABB.min[2], MINECART_AABB.max[2]]) {
            const v = new V(px + dx, py + dy, pz + dz);
            v.project(g.camera);
            const sx = (v.x * 0.5 + 0.5) * window.innerWidth;
            const sy = (-v.y * 0.5 + 0.5) * window.innerHeight;
            if (sx < x0) x0 = sx; if (sx > x1) x1 = sx;
            if (sy < y0) y0 = sy; if (sy > y1) y1 = sy;
          }
        }
      }
      const PAD = 4;   // 抗锯齿边缘余量
      return { x0: Math.max(0, Math.floor(x0) - PAD), y0: Math.max(0, Math.floor(y0) - PAD),
               x1: Math.min(window.innerWidth - 1, Math.ceil(x1) + PAD),
               y1: Math.min(window.innerHeight - 1, Math.ceil(y1) + PAD) };
    });
  });
  expect(cartBox.x1, '车须投影到屏幕内（否则后面两条判据测的是空气）')
    .toBeGreaterThan(cartBox.x0);
  console.log('CART_BOX:', JSON.stringify(cartBox), 'bodyPx:', JSON.stringify(bodyPx));
  // 前提：车斗中心须落在本盒内（投影与取样点同源，否则盒算错了）
  expect(bodyPx.x >= cartBox.x0 && bodyPx.x <= cartBox.x1 &&
         bodyPx.y >= cartBox.y0 && bodyPx.y <= cartBox.y1,
  `车斗中心 ${JSON.stringify(bodyPx)} 须在投影盒 ${JSON.stringify(cartBox)} 内`).toBe(true);

  // ---- ② 朝向生效：orient0 vs orient1 投影不同，且差异只在车轮带 ----
  // 车斗 0.9×0.9 正方形 + 四轮对称布局 = 四重旋转对称 → 朝向差异只能由车轮圆柱轴向打破
  // （orient0 轴朝 Z / orient1 轴朝 X，端面 vs 侧面亮度不同）。实测差 1304 px，
  // bbox y 248~297 全在车斗中心（y=235）之下的车轮带。
  // 注入「rotationAngleOf 恒 0（朝向不生效）」→ 两图全等 → FAIL（负向验证实测）；
  // 注入「旋转角 = orientation×π/4」→ 45° 使车斗轮廓变菱形 → 差异漫进车斗区 → y0 断言 FAIL。
  const d01 = diffPng(png0, png1, 6, cartBox);
  console.log('DIFF_0_vs_1:', JSON.stringify(d01));
  expect(d01.count, '朝向 0 与 1 的投影须有可测差异（车轮轴向不同）').toBeGreaterThan(500);
  expect(d01.bbox.y0, '差异须落在车斗中心之下（车轮带，不是车斗）').toBeGreaterThan(bodyPx.y);

  // ---- ③ 旋转量子钉住：orient0 vs orient2（180°）须全等 ----
  // 实测差 0 px。与 ② 组合证明旋转真是 orientation×π/2 的整数倍（不是「随便转了个角度」）。
  // ⚠️ 本条**拓不住「去掉 map」**（实测纯色车斗同样四重对称 → d02 仍为 0）——
  // 纹理丢失由下面 ④ 的面内梯度断言专门负责。
  const d02 = diffPng(png0, png2, 6, cartBox);
  console.log('DIFF_0_vs_2:', JSON.stringify(d02));
  expect(d02.count, '朝向 0 与 2（180°）投影须全等（对称几何）').toBeLessThan(50);

  // ---- ④ 车斗纹理真的被采样（面内竖直亮度梯度）----
  // **为什么需要这一条**：①~③ 都拓不住「材质去掉 map」—— 退回 `bodyColor 0xb8bec6`
  // 后车斗**反而更亮且仍偏蓝**（实测 (83,86,89) vs 有纹理 (61.5,65.5,71.3)），颜色断言全过；
  // 而③ 的对称性断言也过（纯色车斗同样四重对称，实测 d02=0）—— 即**纹理丢失是静默盲区**。
  // 而这正是 roadmap 遗留 TODO 里「车斗纹理无指纹门禁 → 靠 Tier 4 兜底」声称要兜住的东西。
  //
  // 判据机制：canvas 纹理有**顶部深色压边**（rgba(58,63,70,0.8) 覆盖上 14%）+ 三段渐变
  // （#a7afb8→#c0c6ce→#8f98a2）+ 底部阴影，而车斗每个面的 UV 是统一四边形 (0,0)-(1,1)
  // → **同一个平面内应有竖直亮度变化**。而 `MeshBasicMaterial` 是 unlit、矿车 mesh 无 AO/
  // 顶点色 → 去掉 map 后面内**完全均匀**。
  // 实测（探针 `.tmp-nomap-probe.mjs`，过 bodyPx 的 29 行竖直剖面，每行 ±2px 宽均值）：
  //   有 map：61.2 ~ 66.7（极差 **5.5**）；无 map：**29 行恒为 86.0（极差 0.0）**。
  // 注入「去掉 map」→ 极差归零 → FAIL（负向验证实测）。
  const SPAN = 14;   // ±14 行 = y 221~249；车的包围盒实测 y 184~297 → 上下各余 37/48px，不跨边缘
  const prof = [];
  for (let dy = -SPAN; dy <= SPAN; dy++) {
    let s = 0, n = 0;
    for (let dx = -2; dx <= 2; dx++) {
      const o = ((bodyPx.y + dy) * png0.width + (bodyPx.x + dx)) * 4;
      s += (png0.data[o] + png0.data[o + 1] + png0.data[o + 2]) / 3; n++;
    }
    prof.push(s / n);
  }
  const profRange = Math.max(...prof) - Math.min(...prof);
  console.log('BODY_PROFILE:', JSON.stringify({ range: +profRange.toFixed(2),
    max: +Math.max(...prof).toFixed(1), min: +Math.min(...prof).toFixed(1) }));
  expect(profRange, '车斗面内须有竖直亮度梯度（纹理真被采样；实测有 map 5.5 / 无 map 0.0）')
    .toBeGreaterThan(2);
});
