import { test, expect } from 'playwright/test';

// 回归：**光照数据对 ≠ 画面对**。light 写回之后，实际上传到 GPU 的网格必须与「用当前世界数据现算的网格」一致。
//
// 用户实玩报告（两次）：
//   ①「放灯后灯光辐射区域有一条笔直边界，边界 = chunk 边界」——第一次修了 light **数据**的区域语义（3×3），
//     数据层 0 个格子不一致了，但用户截图里边界还在；
//   ②「把灯删除后，被照亮的方块面不变暗」。
// 真游戏页对照（整图参考 BFS vs 每列 light = 0 差；上传网格 vs 现算网格 = 6 个 section 过期）实测：
// **数据是对的，网格是旧的**。两个独立机制（本 spec 一条用例钉一个）：
//   A. 脏标记传播漏了 Y 方向 —— 地表在 section 最上层（如 y=-1 沙滩）时，顶面读的是上一 section 最底层
//      那格的 light；那格变了，地面所在 section 没人通知重 mesh（`lightDirtyMasks`）。
//   B. 在途 mesh 回包因同 column `version++` 被丢弃后，没有任何东西再让它重 mesh（脏标记在派发前已被
//      `takeDirty` 消费）→ 数据对、画面旧，偶现（`Scheduler._redispatchDropped`）。
//
// ⚠️ 判据必须落在**最终产物**上：不能只断言 `col.light`（那一层第一次修完就是对的，却没挡住缺陷）。
// 这里用 `renderWorld.uploadSection` 的拦截记录「实际上传了什么」，再与 `buildSectionMesh(当前数据)` 逐顶点比较。

/** 注入页内工具（每条用例独立 page，互不残留） */
async function boot(page) {
  await page.goto('/?vd=4&seed=12345&style=noon&weather=clear');
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 90_000 });
  await page.evaluate(async () => {
    const g = window.__MC_GAME__;
    const { buildSectionMesh } = await import('/src/mesh/mesher.js');
    const raf = () => new Promise((r) => requestAnimationFrame(r));
    const LM = {};
    /** 严格 idle：所有队列清空且连续 40 帧不再变化（只看瞬时归零会误判，见 world-stable 记忆） */
    LM.idle = async (maxFrames = 2400) => {
      let stable = 0;
      for (let i = 0; i < maxFrames; i++) {
        await raf();
        const s = g.scheduler.stats();
        const busy = s.genInflight || s.meshInflight || s.meshQueued || s.pendingMesh ||
          s.lightInflight || s.lightQueued || s.uploadQueue;
        stable = busy ? 0 : stable + 1;
        if (stable >= 40) return true;
      }
      return false;
    };
    // 记录每次真实上传（含快速路径与 Worker 回包两条路径，它们都经 renderWorld.uploadSection）
    const rec = new Map();
    const rw = g.renderWorld;
    const orig = rw.uploadSection.bind(rw);
    rw.uploadSection = (cx, sy, cz, channel, geom, version) => {
      const k = `${cx},${sy},${cz}`;
      let e = rec.get(k); if (!e) { e = {}; rec.set(k, e); }
      e[channel] = geom.packed.slice();
      return orig(cx, sy, cz, channel, geom, version);
    };
    const build = (cx, sy, cz) => buildSectionMesh(g.world.getSectionView(cx, sy, cz), g.registry, g.scheduler._atlasMeta || {}, cx, sy, cz);
    /** 把 (cx0,cz0) 周围 R 列的所有 section 按**当前数据**重建并上传，建立「已记录」基线 */
    LM.forceRebuild = (cx0, cz0, R) => {
      for (let dx = -R; dx <= R; dx++) for (let dz = -R; dz <= R; dz++) {
        const col = g.world.getColumn(cx0 + dx, cz0 + dz);
        if (!col || col.state !== 'ready') continue;
        for (let sy = 0; sy < 8; sy++) {
          const d = build(col.cx, sy, col.cz);
          for (const ch of ['opaque', 'cutout', 'transparent']) rw.uploadSection(col.cx, sy, col.cz, ch, d[ch], col.version);
        }
      }
    };
    /** 实际上传的网格 vs 现算网格：返回过期 section 列表 */
    LM.stale = (cx0, cz0, R) => {
      const out = [];
      for (let dx = -R; dx <= R; dx++) for (let dz = -R; dz <= R; dz++) {
        const col = g.world.getColumn(cx0 + dx, cz0 + dz);
        if (!col || col.state !== 'ready') continue;
        for (let sy = 0; sy < 8; sy++) {
          const want = build(col.cx, sy, col.cz), got = rec.get(`${col.cx},${sy},${col.cz}`);
          const bad = [];
          for (const ch of ['opaque', 'cutout', 'transparent']) {
            const w = want[ch].packed, a = got?.[ch];
            if (!a) { if (w.length) bad.push(`${ch}:未记录`); continue; }
            if (a.length !== w.length) { bad.push(`${ch}:长度 ${a.length}≠${w.length}`); continue; }
            let n = 0; for (let i = 0; i < w.length; i++) if (a[i] !== w[i]) n++;
            if (n) bad.push(`${ch}:${n}/${w.length} 顶点光照不一致`);
          }
          if (bad.length) out.push({ sec: `${col.cx},${sy},${col.cz}`, bad });
        }
      }
      return out;
    };
    /** 某 section 已上传的 opaque 网格里，顶点 blocklight（packed 低 4 位）的最大值 */
    LM.maxBlockLight = (cx, sy, cz) => {
      const a = rec.get(`${cx},${sy},${cz}`)?.opaque;
      if (!a) return -1;
      let m = 0; for (let i = 0; i < a.length; i++) m = Math.max(m, a[i] & 15);
      return m;
    };
    /**
     * 夹具：在玩家所在 column 上空造一块 32×32 的石头地面，**顶面 y=79 = section sy=6 的最上层**
     * （(79+32)%16===15），顶面读 y=80（sy=7 最底层）的 light —— 这正是「沙滩 y=-1」那个几何，
     * 但与具体地形/seed 无关。地面上方 y=80..86 清空。范围跨本列并各伸进四邻列 8 格。
     */
    LM.buildSlab = () => {
      const p = g.player.physics.pos;
      const cx = Math.floor(p.x / 16), cz = Math.floor(p.z / 16);
      const stone = g.registry.idOf('stone');
      const changes = [];
      for (let x = cx * 16 - 8; x < cx * 16 + 24; x++) for (let z = cz * 16 - 8; z < cz * 16 + 24; z++) {
        changes.push({ x, y: 79, z, id: stone });
        for (let y = 80; y <= 86; y++) changes.push({ x, y, z, id: 0 });
      }
      g.editor.setBlocks(changes);
      return { cx, cz, lamp: { x: cx * 16 + 8, y: 81, z: cz * 16 + 8 } };
    };
    window.__LM = LM;
  });
}

test('地表在 section 最上层：放灯后地面网格必须变亮，删灯后必须变暗（Y 方向脏标记）', async ({ page }) => {
  test.setTimeout(240_000);
  await boot(page);
  const out = await page.evaluate(async () => {
    const g = window.__MC_GAME__, LM = window.__LM;
    const { cx, cz, lamp } = LM.buildSlab();
    const idle0 = await LM.idle();
    LM.forceRebuild(cx, cz, 1);
    const darkMax = LM.maxBlockLight(cx, 6, cz); // 放灯前：地面所在 sy=6 的顶点 blocklight（基线）

    // —— 放灯（与玩家右键同一入口：editor.setBlock）
    g.editor.setBlock({ ...lamp, id: g.registry.idOf('hanging_lamp'), meta: 0 });
    const idle1 = await LM.idle();
    const stalePlaced = LM.stale(cx, cz, 1);
    const litMax = LM.maxBlockLight(cx, 6, cz);
    // 数据层 sanity：灯正下方的空气格（y=80）应有 14
    const col = g.world.getColumn(cx, cz);
    const dataBelowLamp = col.light[(lamp.x - cx * 16) + (lamp.z - cz * 16) * 16 + (80 + 32) * 256] & 15;

    // —— 把网格强制重建成「亮」的状态再删灯：这样「删灯后不变暗」这一条与上面「放灯后不亮」互相独立
    //    （修复后上面两行是 no-op；缺陷还在时即使放灯那步侥幸亮了，删灯也会暴露）
    LM.forceRebuild(cx, cz, 1);
    g.editor.setBlock({ ...lamp, id: 0 });
    const idle2 = await LM.idle();
    const staleRemoved = LM.stale(cx, cz, 1);
    const darkAgain = LM.maxBlockLight(cx, 6, cz);
    return { idle: [idle0, idle1, idle2], darkMax, litMax, dataBelowLamp, stalePlaced, staleRemoved, darkAgain };
  });
  console.log('LIGHT-MESH-Y:', JSON.stringify(out));
  expect(out.idle, 'world 必须收敛（否则下面的比较没有意义）').toEqual([true, true, true]);
  // sanity floors：灯确实生效、网格里确实读到了亮度（防「全 0 也相等」的空转）
  expect(out.dataBelowLamp, '灯正下方空气格的 light 数据').toBe(14);
  expect(out.litMax, '放灯后地面 section 的顶点 blocklight 必须被点亮').toBeGreaterThanOrEqual(12);
  // 判据本体：画面 == 数据
  expect(out.stalePlaced, '放灯后：上传网格与现算网格逐顶点一致').toEqual([]);
  expect(out.staleRemoved, '删灯后：上传网格与现算网格逐顶点一致').toEqual([]);
  expect(out.darkAgain, '删灯后地面顶点的 blocklight 必须回到放灯前').toBe(out.darkMax);
});

test('在途 mesh 因同 column 版本变更被丢弃 → 必须重发，旧网格不得残留', async ({ page }) => {
  test.setTimeout(240_000);
  await boot(page);
  const out = await page.evaluate(async () => {
    const g = window.__MC_GAME__, LM = window.__LM, sch = g.scheduler;
    const { cx, cz, lamp } = LM.buildSlab();
    await LM.idle();
    LM.forceRebuild(cx, cz, 1);

    // 确定性构造竞态（不靠时间碰运气）：
    //   某次 light 写回把 section 置脏 → 紧随其后的 update() 把它们派发成 mesh 任务（在途）→
    //   **同一个同步片段内**在这些 section 所在 column 各做一次与光无关的编辑（空中放石头）→ version++ →
    //   在途结果回来时必然版本不符。
    const race = { pendingFire: false, fired: false, inflight: [], edited: [] };
    const origLight = sch._onLightResult.bind(sch);
    sch._onLightResult = (key, r) => {
      origLight(key, r);
      if (race.fired) return;
      for (const c of g.world.columns.values()) if (c.dirtySections.some(Boolean)) { race.pendingFire = true; break; }
    };
    const origUpdate = sch.update.bind(sch);
    sch.update = (x, z) => {
      origUpdate(x, z);
      if (!race.pendingFire || race.fired || sch._inflightMesh.size === 0) return;
      race.fired = true;
      race.inflight = [...sch._inflightMesh.keys()];
      const cols = new Set(race.inflight.map((k) => { const [a, , b] = k.split(',').map(Number); return `${a},${b}`; }));
      for (const c of cols) {
        const [a, b] = c.split(',').map(Number);
        g.editor.setBlock({ x: a * 16 + 3, y: 90, z: b * 16 + 3, id: g.registry.idOf('stone'), meta: 0 });
        race.edited.push(c);
      }
    };

    g.editor.setBlock({ ...lamp, id: g.registry.idOf('hanging_lamp'), meta: 0 });
    const idle = await LM.idle();
    return { idle, fired: race.fired, inflight: race.inflight, edited: race.edited, stale: LM.stale(cx, cz, 1), lit: LM.maxBlockLight(cx, 6, cz) };
  });
  console.log('LIGHT-MESH-RACE:', JSON.stringify(out));
  expect(out.idle, 'world 必须收敛').toBe(true);
  // sanity floor：竞态确实被构造出来了（否则下面的「无过期」是空转）
  expect(out.fired, '必须真的在 mesh 在途时让同 column 版本变更').toBe(true);
  expect(out.inflight.length, '在途 mesh 任务数').toBeGreaterThan(0);
  expect(out.lit, '灯确实把地面顶点点亮了').toBeGreaterThanOrEqual(12);
  expect(out.stale, '被丢弃的在途结果必须重发：上传网格与现算网格逐顶点一致').toEqual([]);
});
