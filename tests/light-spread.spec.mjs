import { test, expect } from 'playwright/test';

// 回归：blocklight 跨 column（16×16 chunk）边界扩散。
//
// 用户实玩报告「放灯后灯光辐射区域有一条笔直边界」，实测边界就是 column 边界。
// 根因两处（2026-10-21）：
//   ① `computeBlocklightRegion` 区域只取「中心 + 4 正交邻居」共 5 列，漏了 4 个**对角**邻居。
//      blocklight 强度 15、每格 -1、最远照 14 格；column 边长 16 →
//      正交邻居最近格距本列边缘 1 格、对角邻居 2 格（两者都必须参与），
//      隔一列 17 格（贡献恒 0）。正确区域 = **3×3**。
//   ② `enqueueLight` 只入队编辑所在列，而写回只写中心列 → 灯的邻居列从来没有自己的 task，
//      它们的 light 永远停在 GEN 时的单列截断值（0）。
//
// 三条判据各钉一侧（缺一条都会放过「假修」）：
//   A. 灯在某列内部（距边界 ≥8 格）时，四方向跨边界后**不得出现归零跳变**；
//   B. 四个邻居列都必须有亮格（只有中心列亮 = 上面 ② 未修）；
//   C. 隔两列必须仍为 0（防止「把整个加载范围都点亮」这种过度修复）。
test('blocklight 跨 column 边界扩散（灯光无边界）', async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto('/?vd=8&seed=12345&style=noon&weather=clear');
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 90_000 });
  await page.waitForFunction(() => {
    const s = window.__MC_GAME__.scheduler.stats();
    return s.genInflight === 0 && s.meshInflight === 0 && s.meshQueued === 0 &&
      s.pendingMesh === 0 && s.lightInflight === 0 && s.lightQueued === 0 && s.uploadQueue === 0;
  }, null, { timeout: 120_000, polling: 250 });

  const out = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    const { blockIndex } = await import('/src/voxel/constants.js');
    const p = g.player.physics.pos;
    // 灯放在 column **中心**（lx=8, lz=8）—— 距四边各 8 格，光必然要跨边界才衰减到 0
    const cx = Math.floor(p.x / 16), cz = Math.floor(p.z / 16);
    const lx0 = cx * 16 + 8, lz0 = cz * 16 + 8;
    let groundY = -1;
    for (let y = 100; y > -32; y--) { if (g.world.getBlockId(lx0, y, lz0) !== 0) { groundY = y; break; } }
    const lampY = groundY + 8;
    // 清理光源周围的空气（**只在本 column 内 lx/lz ∈ [2,13]**，绝不触边界格 ——
    // 触边界会走 `_affectedFor` 的「邻居也进 affected」副作用，掩盖被测缺陷）
    for (let x = cx * 16 + 2; x <= cx * 16 + 13; x++) {
      for (let z = cz * 16 + 2; z <= cz * 16 + 13; z++) {
        for (let y = lampY - 1; y <= lampY + 1; y++) {
          if (g.world.getBlockId(x, y, z) !== 0) g.editor.setBlock({ x, y, z, id: 0 });
        }
      }
    }
    // 等清理引起的 light/mesh 先收敛，保证下面测的是「放灯」的效果
    for (let i = 0; i < 200; i++) {
      await new Promise((r) => requestAnimationFrame(r));
      const s = g.scheduler.stats();
      if (s.lightInflight === 0 && s.lightQueued === 0 && s.meshInflight === 0) break;
    }
    g.editor.setBlock({ x: lx0, y: lampY, z: lz0, id: g.registry.idOf('glowstone') });
    for (let i = 0; i < 400; i++) {
      await new Promise((r) => requestAnimationFrame(r));
      const s = g.scheduler.stats();
      if (s.lightInflight === 0 && s.lightQueued === 0 && s.meshInflight === 0) break;
    }
    for (let i = 0; i < 30; i++) await new Promise((r) => requestAnimationFrame(r));

    const bl = (x, y, z) => {
      const c = Math.floor(x / 16), d = Math.floor(z / 16);
      const col = g.world.getColumn(c, d);
      if (!col) return null;
      return col.light[blockIndex(x - c * 16, y, z - d * 16)] & 15;
    };
    // 四方向逐格剖面（走满 20 格 = 跨过边界 12 格）
    const scan = (dx, dz) => {
      const v = [];
      for (let k = 0; k <= 20; k++) v.push(bl(lx0 + dx * k, lampY, lz0 + dz * k));
      return v;
    };
    const axes = { plusX: scan(1, 0), minusX: scan(-1, 0), plusZ: scan(0, 1), minusZ: scan(0, -1) };
    // A. 单调不增 + 无「大跳」（从 x 到 x+1 掉超过 1 级即判为边界断裂）
    const jumps = [];
    for (const [name, vs] of Object.entries(axes)) {
      for (let k = 0; k < vs.length - 1; k++) {
        if (vs[k + 1] === null || vs[k] === null) continue;
        if (vs[k + 1] > vs[k]) jumps.push({ axis: name, k, from: vs[k], to: vs[k + 1], kind: 'increase' });
        if (vs[k] - vs[k + 1] > 1) jumps.push({ axis: name, k, from: vs[k], to: vs[k + 1], kind: 'drop' });
      }
    }
    // B. 四邻居列各自的 blocklight 非零格数
    const countNonZero = (col) => {
      if (!col) return null;
      let n = 0;
      for (let i = 0; i < col.light.length; i++) if ((col.light[i] & 15) > 0) n++;
      return n;
    };
    const neighbors = {
      plusX: countNonZero(g.world.getColumn(cx + 1, cz)),
      minusX: countNonZero(g.world.getColumn(cx - 1, cz)),
      plusZ: countNonZero(g.world.getColumn(cx, cz + 1)),
      minusZ: countNonZero(g.world.getColumn(cx, cz - 1)),
    };
    // C. 隔两列：沿灯所在轴上的那几格必须仍为 0（光最远 14 格 < 2×16=32）。
    // ⚠️ 不能用「整列非零格数」作判据 —— 世界里本来就有结构性发光方块（实测 seed=12345
    // 下有隔两列亮着 1~3 格的列，那些光来自距离 50~61 格的其它 glowstone）。
    // 判据必须落在**轴上**、且只扫 14 格射程以内的位置（这是被测缺陷的作用面）。
    const farAxis = {
      plusX2: [], minusX2: [],
    };
    for (const [name, ncx] of [['plusX2', cx + 2], ['minusX2', cx - 2]]) {
      const nx = ncx * 16 + (name === 'plusX2' ? 0 : 15);
      // 该列沿轴向的整条线（沿 z 扫 16 格，y = lampY）
      for (let k = 0; k < 16; k++) farAxis[name].push(bl(nx, lampY, cz * 16 + k));
    }
    return { lamp: { x: lx0, y: lampY, z: lz0, cx, cz }, axes, jumps, neighbors, far: farAxis };
  });

  console.log('LIGHT-SPREAD:', JSON.stringify(out));
  // A. 无断裂跳变
  expect(out.jumps).toEqual([]);
  // A'. 灯自身格满亮，说明灯确实生效（sanity floor，防「全黑也通过」）
  expect(out.axes.plusX[0]).toBe(15);
  // B. 四个邻居列都被点亮（plus-5 时这四个值都是 0）
  for (const [name, n] of Object.entries(out.neighbors)) {
    expect(n, `${name} 邻居列的 blocklight 非零格数`).toBeGreaterThan(0);
  }
  // C. 隔两列沿轴向仍为 0（防过度修复）
  for (const [name, vs] of Object.entries(out.far)) {
    expect(Math.max(...vs), `${name} 轴线上不得有光`).toBe(0);
  }
});

// 第二条判据：**对角方向**的光（region 缺陷唯一的作用面）。
//
// 上一条判据只走轴向 —— 轴上光只经过正交邻居，所以把 region 回退成 plus-5 时它**仍然通过**
// （负向验证实测）。对角才是 plus-5 漏掉的那 4 列的唯一作用面：
//   灯放在本 column 靠近角落处 (lx=1,lz=1)，对角邻居列的角落格 (lx=15,lz=15) 距灯
//   曼哈顿 4 格 → 期望亮度 11。plus-5 的 region 不含对角列 → 该格恒 0。
test('blocklight 对角方向跨 column 扩散（region 必须含 4 个对角邻居）', async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto('/?vd=8&seed=12345&style=noon&weather=clear');
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 90_000 });
  await page.waitForFunction(() => {
    const s = window.__MC_GAME__.scheduler.stats();
    return s.genInflight === 0 && s.meshInflight === 0 && s.meshQueued === 0 &&
      s.pendingMesh === 0 && s.lightInflight === 0 && s.lightQueued === 0 && s.uploadQueue === 0;
  }, null, { timeout: 120_000, polling: 250 });

  const out = await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    const { blockIndex } = await import('/src/voxel/constants.js');
    const p = g.player.physics.pos;
    const cx = Math.floor(p.x / 16), cz = Math.floor(p.z / 16);
    // 灯贴本 column 的 (−X,−Z) 角内侧：lx=1, lz=1
    const lx0 = cx * 16 + 1, lz0 = cz * 16 + 1;
    let groundY = -1;
    for (let y = 100; y > -32; y--) { if (g.world.getBlockId(lx0, y, lz0) !== 0) { groundY = y; break; } }
    const lampY = groundY + 8;
    // 清理单格空气（灯自身 + 到对角的两格路径，y 同层）
    for (const [x, z] of [[lx0, lz0], [lx0 - 1, lz0], [lx0, lz0 - 1], [lx0 - 1, lz0 - 1]]) {
      if (g.world.getBlockId(x, lampY, z) !== 0) g.editor.setBlock({ x, y: lampY, z, id: 0 });
    }
    for (let i = 0; i < 300; i++) {
      await new Promise((r) => requestAnimationFrame(r));
      const s = g.scheduler.stats();
      if (s.lightInflight === 0 && s.lightQueued === 0 && s.meshInflight === 0) break;
    }
    g.editor.setBlock({ x: lx0, y: lampY, z: lz0, id: g.registry.idOf('glowstone') });
    for (let i = 0; i < 400; i++) {
      await new Promise((r) => requestAnimationFrame(r));
      const s = g.scheduler.stats();
      if (s.lightInflight === 0 && s.lightQueued === 0 && s.meshInflight === 0) break;
    }
    for (let i = 0; i < 30; i++) await new Promise((r) => requestAnimationFrame(r));
    const bl = (x, y, z) => {
      const c = Math.floor(x / 16), d = Math.floor(z / 16);
      const col = g.world.getColumn(c, d);
      if (!col) return null;
      return col.light[blockIndex(x - c * 16, y, z - d * 16)] & 15;
    };
    // 对角邻居列 (cx-1, cz-1) 的角落格：世界 (cx*16-1, cz*16-1)，距灯曼哈顿 4 → 期望 ≥11
    return {
      lamp: { x: lx0, y: lampY, z: lz0, cx, cz },
      diagCorner: bl(cx * 16 - 1, lampY, cz * 16 - 1),
      // 沿途两格（也是对角列之外/之内的过渡）作为诊断
      via1: bl(lx0 - 1, lampY, lz0),
      via2: bl(lx0, lampY, lz0 - 1),
    };
  });

  console.log('LIGHT-SPREAD-DIAG:', JSON.stringify(out));
  expect(out.diagCorner).toBeGreaterThanOrEqual(11);
});
