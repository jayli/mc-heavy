import { test, expect } from 'playwright/test';

// v2.65：近战剑（紫色剑体 dragonrend）的集成验收。
// 经 `window.__MC_GAME__` 公开 API 驱动，无头环境无真实键鼠。
//
// 分工（docs/testing-policy.md §2.4）：
// - 纯逻辑断言（catalog 冻结数值 / controller 状态机 / 几何解析）走浏览器内单测
//   （`/src/tests/index.html` 的 test-weapons.js + test-blockbench-geometry.js）；
// - 本 spec 只验「接线正确」：剑模型能加载、挥砍动画触发、命中丧尸扣血+击退+红闪、
//   剑不破坏方块、音效请求计数增长。

/** 世界就绪判定：worldReady + 队列收敛（同 zombies.spec.mjs） */
async function waitWorldReady(page) {
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 90_000 });
  await page.waitForFunction(() => {
    const s = window.__MC_GAME__.scheduler.stats();
    return s.genInflight === 0 && s.meshInflight === 0 && s.meshQueued === 0
      && s.pendingMesh === 0 && s.lightInflight === 0 && s.lightQueued === 0 && s.uploadQueue === 0;
  }, null, { timeout: 90_000 });
}

/** 在玩家附近找一个合法丧尸落点（同 zombies.spec.mjs 的 legalSpawnNear） */
async function installHelpers(page) {
  await page.evaluate(() => {
    window.__ST__ = {
      legalSpawnNear(distance) {
        const g = window.__MC_GAME__;
        const p = g.player.physics.pos;
        for (let r = distance; r <= distance + 12; r++) {
          for (const [dx, dz] of [[r, 0], [-r, 0], [0, r], [0, -r]]) {
            const x = Math.floor(p.x) + dx, z = Math.floor(p.z) + dz;
            for (let y = Math.floor(p.y); y >= Math.floor(p.y) - 64; y--) {
              if (g.world.getBlockId(x, y, z) === 0
                && g.world.getBlockId(x, y + 1, z) === 0
                && g.world.isSolid(x, y - 1, z)) return [x + .5, y, z + .5];
            }
          }
        }
        throw new Error('no legal sword fixture position');
      },
      aimAt(pos) {
        const g = window.__MC_GAME__;
        const cam = g.camera.position.toArray();
        return g.player.setTestAim([pos[0] - cam[0], pos[1] + 0.9 - cam[1], pos[2] - cam[2]]);
      },
    };
  });
}

test.describe('近战剑（v2.65）', () => {
  test('剑模型加载 + 挥砍动画触发', async ({ page }) => {
    await page.goto('/?vd=4');
    await waitWorldReady(page);
    const result = await page.evaluate(async () => {
      const g = window.__MC_GAME__;
      await g.selectWeapon('sword');
      // 等模型异步加载
      await new Promise((r) => setTimeout(r, 800));
      const loaded = g.player.viewWeapon.state.loaded;
      const selectedId = g.player.viewWeapon.state.selectedId;
      // 挥砍前 swingProgress = 1（未在挥砍）
      const beforeSwing = g.player.viewWeapon.state.swingProgress;
      // 触发一次挥砍（无实体 → melee 事件，仍触发动画）
      g.player.weaponController.pointerDown({
        origin: [0, 0, 0], forward: [0, 0, -1], right: [1, 0, 0], up: [0, 1, 0],
        target: { hit: false },
      });
      const afterSwing = g.player.viewWeapon.state.swingProgress;
      // 等动画播完
      await new Promise((r) => setTimeout(r, 400));
      const afterAnim = g.player.viewWeapon.state.swingProgress;
      return { loaded, selectedId, beforeSwing, afterSwing, afterAnim };
    });
    expect(result.loaded, '剑模型必须加载成功').toBe(true);
    expect(result.selectedId).toBe('sword');
    expect(result.beforeSwing, '挥砍前 swingProgress 应为 1').toBe(1);
    expect(result.afterSwing, '挥砍触发后 swingProgress 应 < 1').toBeLessThan(1);
    expect(result.afterAnim, '动画播完后 swingProgress 应回到 1').toBe(1);
  });

  /**
   * Tier 4：剑体真的画在屏幕上，而且是**紫色**（不是黑块/缺失）。
   *
   * ⚠️ **为什么必须像素实测**（AGENTS.md Tier 4）：「模型加载成功」只证明 JSON/PNG 解析
   * 与 BufferGeometry 装配没抛错，**证明不了画面上有东西**。UV 映射整体错位、材质纯黑、
   * 节点没挂到 camera、alphaTest 把整个剑剔掉 —— 这四种缺陷下 `state.loaded` 全是 true。
   *
   * 判据（差分口径，同 `weapon-view.spec.mjs` 的枪体用例）：
   *   ① 徒手 vs 持剑两张截图的差分像素数 > 阈值（剑确实占了一块屏幕）；
   *   ② 差分像素的平均色**偏紫**（R>B>G 且 B-G 差显著）—— 素材剑刃实测 rgb(146,67,166)；
   *   ③ 差分像素平均亮度 > 15（不是纯黑，防「unlit 场景无灯 → 全黑」这类历史缺陷）。
   */
  test('Tier 4：剑体画在屏幕上且是紫色（差分像素，非目视）', async ({ page }) => {
    await page.goto('/?vd=4');
    await waitWorldReady(page);
    // 截图 A：徒手基线（无剑体）
    await page.evaluate(async () => {
      await window.__MC_GAME__.selectWeapon('arm');
      await new Promise((r) => setTimeout(r, 800));
    });
    const shotA = await page.screenshot();
    // 截图 B：持剑（举剑动画完成 + 渲染稳定）
    await page.evaluate(async () => {
      await window.__MC_GAME__.selectWeapon('sword');
      await new Promise((r) => setTimeout(r, 1200));
    });
    const shotB = await page.screenshot();

    const { PNG } = await import('pngjs');
    const pngA = PNG.sync.read(shotA);
    const pngB = PNG.sync.read(shotB);
    expect(pngA.width).toBe(pngB.width);
    expect(pngA.height).toBe(pngB.height);
    let diffCount = 0;
    let lumSum = 0;
    let rSum = 0; let gSum = 0; let bSum = 0;
    /** 紫色像素数：b-g>40 且 r-g>20（素材剑刃 rgb(146,67,166) ⇒ b-g=99、r-g=79） */
    let purpleCount = 0;
    for (let y = 0; y < pngA.height; y++) {
      for (let x = 0; x < pngA.width; x++) {
        const i = (pngA.width * y + x) << 2;
        const d = Math.abs(pngA.data[i] - pngB.data[i])
          + Math.abs(pngA.data[i + 1] - pngB.data[i + 1])
          + Math.abs(pngA.data[i + 2] - pngB.data[i + 2]);
        if (d > 8) {
          diffCount++;
          const r = pngB.data[i]; const g = pngB.data[i + 1]; const b = pngB.data[i + 2];
          rSum += r; gSum += g; bSum += b;
          lumSum += (r + g + b) / 3;
          if (b - g > 40 && r - g > 20) purpleCount++;
        }
      }
    }
    expect(diffCount, '剑体必须占一块屏幕区域（差分为空 = 根本没画出来）').toBeGreaterThan(100);
    const avgR = rSum / diffCount;
    const avgG = gSum / diffCount;
    const avgB = bSum / diffCount;
    const avgLum = lumSum / diffCount;
    // ② 偏紫：用**紫色像素计数**判，不用全 diff 区域的平均色差。
    //
    // ⚠️ v2.66 重新标定。旧断言是 `avgB - avgG > 15`，它在 v2.65 的旧摆放（剑占屏 10.1%）下
    // 成立，换了正确姿态后降到 12.5 而失败 —— 但那是**判据随剑体在屏上大小漂移**，不是剑变不紫了：
    // 剑体变小/变远后 diff 区域混进了更多背景（灰石头，r≈g≈b），把平均值拉平。
    // 实测对照（同一帧背景、只差 transform）：旧姿态紫色像素占比 50.3%、新姿态 16% —— **两者都紫**。
    // 噪声底实测：同状态重复截图 purpleCount = **0** ⇒ 这个判据没有假阳性。
    expect(purpleCount, `剑体必须真有紫色像素（实测 purple=${purpleCount} / diff=${diffCount}，avgRGB=${avgR.toFixed(0)},${avgG.toFixed(0)},${avgB.toFixed(0)}）`)
      .toBeGreaterThan(300);
    expect(purpleCount / diffCount, '紫色应占 diff 区的有意义份额（实测 16%）').toBeGreaterThan(0.05);
    // ③ 非纯黑（unlit 场景缺灯会让模型全黑，历史缺陷）
    expect(avgLum, '剑体不得渲染为纯黑').toBeGreaterThan(15);
  });

  test('剑体朝向与视窗内占比（v2.66：相机空间 + 屏幕包围盒实测，非目视）', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/?vd=4');
    await waitWorldReady(page);
    await page.evaluate(() => window.__MC_GAME__.selectWeapon('sword'));
    await page.waitForFunction(() => window.__MC_GAME__.player.viewWeapon.node !== null, null, { timeout: 20_000 });
    await page.waitForTimeout(900); // 等举剑动画走完

    // ⚠️ 这三条判的都是**相机空间坐标与屏幕包围盒**，不是「模型加载成功 / 有紫色像素」——
    // v2.65 的两个真缺陷（刃朝后、柄跑到相机背后只剩 19.6% 在窗内）在前一类判据下全绿。
    const m = await page.evaluate(async () => {
      const g = window.__MC_GAME__;
      const THREE = await import('three');
      const node = g.player.viewWeapon.node;
      let mesh = null; node.traverse((o) => { if (o.isMesh) mesh = o; });
      const cam = g.camera;
      g.scene.updateMatrixWorld(true);
      cam.updateMatrixWorld(true);
      const camInv = new THREE.Matrix4().copy(cam.matrixWorld).invert();
      const pos = mesh.geometry.attributes.position;
      const N = pos.count / 24;
      const W = innerWidth, H = innerHeight;
      const tan = Math.tan((cam.fov / 2) * Math.PI / 180);
      const pts = [];
      const centers = [];
      for (let e = 0; e < N; e++) {
        const c = new THREE.Vector3();
        for (let k = 0; k < 24; k++) {
          const v = new THREE.Vector3(pos.getX(e * 24 + k), pos.getY(e * 24 + k), pos.getZ(e * 24 + k));
          v.applyMatrix4(mesh.matrixWorld).applyMatrix4(camInv);
          pts.push(v); c.add(v);
        }
        centers.push(c.multiplyScalar(1 / 24));
      }
      const zs = pts.map((p) => p.z);
      const front = pts.filter((p) => p.z < -cam.near);
      const sxs = [], sys = [];
      for (const v of front) {
        sxs.push(((v.x / (-v.z * tan * cam.aspect)) + 1) / 2 * W);
        sys.push((1 - v.y / (-v.z * tan)) / 2 * H);
      }
      const clip = (a, b, lo, hi) => Math.max(0, Math.min(b, hi) - Math.max(a, lo));
      const bx = [Math.min(...sxs), Math.min(...sys), Math.max(...sxs), Math.max(...sys)];
      const el0 = centers[0]; // 柄尾
      const el5 = centers[5]; // 剑尖
      return {
        vertsBehindCamera: pts.length - front.length,
        zMax: Math.max(...zs),
        bbox: bx,
        inViewPct: 100 * clip(bx[0], bx[2], 0, W) * clip(bx[1], bx[3], 0, H)
          / (((bx[2] - bx[0]) * (bx[3] - bx[1])) || 1),
        zHilt: el0.z, zTip: el5.z,
        screenHilt: [((el0.x / (-el0.z * tan * cam.aspect)) + 1) / 2 * W, (1 - el0.y / (-el0.z * tan)) / 2 * H],
        screenTip: [((el5.x / (-el5.z * tan * cam.aspect)) + 1) / 2 * W, (1 - el5.y / (-el5.z * tan)) / 2 * H],
      };
    });

    // ① 没有任何顶点在相机背后（否则近平面裁剪炸掉，投影出离谱坐标）
    expect(m.vertsBehindCamera, '剑不得有任何顶点跑到相机背后').toBe(0);
    expect(m.zMax, '全部顶点必须在相机前方（相机朝 -Z）').toBeLessThan(0);
    // ② 刀刃朝前：剑尖（el5）比剑柄（el0）离相机更远
    expect(m.zTip, `剑尖 z=${m.zTip.toFixed(3)} 必须比剑柄 z=${m.zHilt.toFixed(3)} 更远（= 刃朝前）`)
      .toBeLessThan(m.zHilt);
    // ③ 剑体大部分在视窗内。
    //
    // ⚠️ **阈值 v2.67 从 85% 降到 55%，是口径变更而不是放宽容差**：用户 2026-11-06
    // 要求「要呈现出一种合理的执剑状态」（参考原版第一人称：剑柄从**屏幕外**右下伸进来）。
    // 柄端落到屏幕外正是握持感的来源 —— 要求 100% 入窗与「剑不能被悬空握着」相互矛盾。
    // 现在的口径是「主体（刃身）必须在窗内」：55% 对应「柄端出窗、刃身完整可见」，
    // 实测 73.4%（旧实现是 19.6%，那才是真缺陷）。
    expect(m.inViewPct, `剑体在视窗内占比 ${m.inViewPct.toFixed(1)}%（bbox=${m.bbox.map(Math.round)}）`)
      .toBeGreaterThan(55);
    // ④ 姿态方向（v2.69 对齐参考图 `~/ttt/bug/images.jpeg`）：刃身沿屏幕右缘，
    //    柄在右下（藏屏下）、尖在右上。旧版「尖在左上」与参考图相反，用户已否。
    expect(m.screenHilt[0], '剑柄必须在屏幕右半边').toBeGreaterThan(1280 * 0.6);
    expect(m.screenTip[0], '剑尖必须在屏幕右半边（刃沿右缘，同参考图）').toBeGreaterThan(1280 * 0.6);
    expect(m.screenHilt[1], '剑柄必须低于剑尖（柄在下）').toBeGreaterThan(m.screenTip[1]);
    expect(m.screenTip[1], '剑尖必须在屏幕上半（朝前上方）').toBeLessThan(720 * 0.5);
  });

  test('剑体尺寸与握持感（v2.68：剑要够大 + 剑柄藏到屏幕下方，不画手臂）', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/?vd=4');
    await waitWorldReady(page);
    await page.evaluate(() => window.__MC_GAME__.selectWeapon('sword'));
    await page.waitForFunction(() => window.__MC_GAME__.player.viewWeapon.node !== null, null, { timeout: 20_000 });
    await page.waitForTimeout(1000);

    // 用户 2026-11-06 三轮反馈的最终裁定：
    //   ①「怎么这么小呢……要把剑放大到合适的尺寸」
    //   ②「哪有这样悬空的」（剑要像被握着）
    //   ③「只需要有剑的动作就可以了，不需要手臂，剑柄藏在屏幕的下方即可」
    // 这三条在「模型加载成功 / 有紫色像素」类判据下全绿 —— 必须量尺寸与柄端出屏。
    const m = await page.evaluate(async () => {
      const g = window.__MC_GAME__;
      const THREE = await import('three');
      const vw = g.player.viewWeapon;
      const node = vw.node;
      const group = node.children[0];
      let mesh = null; node.traverse((o) => { if (o.isMesh) mesh = o; });
      const cam = g.camera;
      g.scene.updateMatrixWorld(true);
      cam.updateMatrixWorld(true);
      const camInv = new THREE.Matrix4().copy(cam.matrixWorld).invert();
      const pos = mesh.geometry.attributes.position;
      const W = innerWidth, H = innerHeight;
      const tan = Math.tan((cam.fov / 2) * Math.PI / 180);
      const scr = (v) => [((v.x / (-v.z * tan * cam.aspect)) + 1) / 2 * W, (1 - v.y / (-v.z * tan)) / 2 * H];
      // group 局部坐标（归一化偏移在 group.position 上）
      const gp = group.position, gs = group.scale.x;
      const inGroup = (v) => v.clone().add(gp).multiplyScalar(gs);
      const camPt = (q) => q.clone().applyMatrix4(node.matrixWorld).applyMatrix4(camInv);
      const elCenter = (e) => {
        const c = new THREE.Vector3();
        for (let k = 0; k < 24; k++) {
          c.add(new THREE.Vector3(pos.getX(e * 24 + k), pos.getY(e * 24 + k), pos.getZ(e * 24 + k)));
        }
        return inGroup(c.multiplyScalar(1 / 24));
      };
      const hilt = camPt(elCenter(0));   // el0 在柄端
      const tip = camPt(elCenter(5));    // el5 在剑尖
      const hs = scr(hilt), ts = scr(tip);
      // 全顶点包围盒
      const all = [];
      for (let i = 0; i < pos.count; i++) {
        all.push(scr(camPt(inGroup(new THREE.Vector3(pos.getX(i), pos.getY(i), pos.getZ(i))))));
      }
      const xs = all.map((q) => q[0]), ys = all.map((q) => q[1]);
      return {
        bladePx: Math.hypot(ts[0] - hs[0], ts[1] - hs[1]),
        hiltScreenY: hs[1], tipScreenY: ts[1],
        hiltScreen: hs.map(Math.round), tipScreen: ts.map(Math.round),
        bbox: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].map(Math.round),
        armVisible: g.viewArm.mesh.visible,
      };
    });

    // ① 尺寸：剑刃屏幕跨度 ≥ 屏幕对角线的 35%（旧实现约 20%，用户说「怎么这么小」）
    const pct = 100 * m.bladePx / Math.hypot(1280, 720);
    expect(pct, `剑刃屏幕跨度 ${pct.toFixed(1)}%（柄 ${m.hiltScreen} → 尖 ${m.tipScreen}）`)
      .toBeGreaterThan(35);
    // ② 握持感（替代手臂）：剑柄端必须落在**屏幕下方之外**
    //    —— 用户：「剑柄藏在屏幕的下方即可，不用把手臂绘制出来」。
    //    柄端不出屏 = 剑整把悬在画面里（v2.66 那版的观感缺陷）。
    expect(m.hiltScreenY, `剑柄端 y=${m.hiltScreen[1]} 必须大于视口高 720（藏在屏幕下方外）`)
      .toBeGreaterThan(720);
    // ③ 剑尖必须在屏幕内（否则整把剑看不见）
    expect(m.tipScreenY, '剑尖必须在视口内').toBeLessThan(720);
    expect(m.tipScreenY).toBeGreaterThan(0);
    // ④ 不画手臂（用户明确要求）
    expect(m.armVisible, '持剑时不得显示手臂').toBe(false);
  });

  test('挥砍轨迹（v2.70：向前劈砍 —— 剑尖朝纵深挥出、剑柄钉在屏下、不绕剑身自转）', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/?vd=4');
    await waitWorldReady(page);
    await page.evaluate(() => window.__MC_GAME__.selectWeapon('sword'));
    await page.waitForFunction(() => window.__MC_GAME__.player.viewWeapon.node !== null, null, { timeout: 20_000 });
    await page.waitForTimeout(1000);

    // 用户 2026-11-06 第五轮：「你要向前挥刀，不是向左摆刀」。
    // 上一版绕相机 Z 轴在屏幕平面内扇形摆动（像雨刷），被明确否掉。
    // 现在的实现绕**相机 X（屏幕水平轴）**以剑柄为支点旋转 ⇒ 剑尖朝屏幕纵深砍出。
    //
    // 判据全部实测（相机空间坐标 + 主轴夹角），不是目视：
    //   ① 剑尖必须**朝远离相机的方向**挥出（相机 z 更负），这是「向前」的硬定义
    //   ② 前段单调劈出、后段单调收回、末帧归位；全程只有 1 个位移峰（两段）
    //   ③ 剑柄全程钉在屏幕下方外且几乎不动（支点 = 手）
    //   ④ 不绕剑身长轴自转：剑面法线与剑身长轴的夹角必须恒定
    const m = await page.evaluate(async () => {
      const g = window.__MC_GAME__;
      const THREE = await import('three');
      const vw = g.player.viewWeapon;
      const node = vw.node;
      const group = node.children[0];
      let mesh = null; node.traverse((o) => { if (o.isMesh) mesh = o; });
      const pos = mesh.geometry.attributes.position;
      const cam = g.camera;
      const tan = Math.tan((cam.fov / 2) * Math.PI / 180);
      const W = innerWidth, H = innerHeight;
      const scr = (v) => [((v.x / (-v.z * tan * cam.aspect)) + 1) / 2 * W, (1 - v.y / (-v.z * tan)) / 2 * H];
      const elCenter = (e) => {
        const c = new THREE.Vector3();
        for (let k = 0; k < 24; k++) {
          c.add(new THREE.Vector3(pos.getX(e * 24 + k), pos.getY(e * 24 + k), pos.getZ(e * 24 + k)));
        }
        return c.multiplyScalar(1 / 24).multiplyScalar(group.scale.x).add(group.position);
      };
      const tipL = elCenter(5), hiltL = elCenter(0);
      const measure = () => {
        g.scene.updateMatrixWorld(true); cam.updateMatrixWorld(true);
        const camInv = new THREE.Matrix4().copy(cam.matrixWorld).invert();
        const f = (q) => scr(q.clone().applyMatrix4(node.matrixWorld).applyMatrix4(camInv));
        const tipCam = tipL.clone().applyMatrix4(node.matrixWorld).applyMatrix4(camInv);
        const long = new THREE.Vector3(0, 1, 0).applyQuaternion(node.quaternion).normalize();
        const face = new THREE.Vector3(1, 0, 0).applyQuaternion(node.quaternion).normalize();
        return { tip: f(tipL), hilt: f(hiltL), tipZ: tipCam.z, long: long.toArray(), face: face.toArray() };
      };
      const rest = measure();
      const frames = [];
      for (let i = 0; i <= 20; i++) {
        const p = i / 20;
        vw._swingElapsed = p * 0.3000001; vw._swingDuration = 0.3; vw.update(0, {});
        frames.push({ p: +p.toFixed(2), ...measure() });
      }
      vw._swingElapsed = Infinity; vw.update(0, {});
      return { rest, frames };
    });

    const dist = (f) => Math.hypot(f.tip[0] - m.rest.tip[0], f.tip[1] - m.rest.tip[1]);
    const out = m.frames.filter((f) => f.p > 0 && f.p <= 0.55);
    const back = m.frames.filter((f) => f.p > 0.55);

    // ① 向前：剑尖相机 z 必须比静止时更负（远离相机 = 朝屏幕纵深砍出）
    const deepest = m.frames.reduce((a, f) => (f.tipZ < a.tipZ ? f : a), m.rest);
    const forwardBy = m.rest.tipZ - deepest.tipZ;
    expect(forwardBy, `剑尖最远 tipZ=${deepest.tipZ.toFixed(2)} 相对静止 ${m.rest.tipZ.toFixed(2)} `
      + `只前进了 ${forwardBy.toFixed(2)} 格，必须 > 0.8（向前挥刀，不是屏幕内摆动）`)
      .toBeGreaterThan(0.8);
    // ② 两段：前段单调劈出、后段单调收回、末帧归位、只有 1 个位移峰
    for (let i = 1; i < out.length; i++) {
      expect(dist(out[i]), `前段 p=${out[i].p} 位移必须大于前一帧（单调劈出）`)
        .toBeGreaterThan(dist(out[i - 1]) - 1);
    }
    // 屏幕位移天然比「横向摆动」小：剑尖朝纵深挥出会被透视压缩（这正是「向前」的特征）。
    // 所以屏幕位移只要 >300px（有可见幅度），「向前」的硬证据由下面的 tipZ 前进量承担。
    expect(Math.max(...out.map(dist)), '前段必须有可见挥砍幅度（> 300px）').toBeGreaterThan(300);
    for (let i = 1; i < back.length; i++) {
      expect(dist(back[i]), `后段 p=${back[i].p} 位移必须小于前一帧（单调收回）`)
        .toBeLessThan(dist(back[i - 1]) + 1);
    }
    expect(dist(m.frames[m.frames.length - 1]), '收回结束必须精确回到静止姿态').toBeLessThan(1);
    const ds = m.frames.map(dist);
    const localMaxima = ds.slice(1, -1).filter((v, i) => v > ds[i] + 1 && v > ds[i + 2] + 1).length;
    expect(localMaxima, `位移曲线出现 ${localMaxima} 个局部峰，必须恰好 1 个（两段动作）`).toBeLessThanOrEqual(1);
    // ③ 剑柄钉在屏幕下方外，且几乎不动
    const minHiltY = Math.min(...m.frames.map((f) => f.hilt[1]));
    expect(minHiltY, `剑柄最浅 y=${minHiltY.toFixed(0)} 必须 > 视口高 720（全程藏在屏幕下方外）`)
      .toBeGreaterThan(720);
    const hiltDrift = Math.max(...m.frames.map((f) => Math.hypot(f.hilt[0] - m.rest.hilt[0], f.hilt[1] - m.rest.hilt[1])));
    expect(hiltDrift, `剑柄漂移 ${hiltDrift.toFixed(1)}px 必须 < 5（支点是剑柄，手不动）`).toBeLessThan(5);
    // ④ 不绕剑身长轴自转
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const angles = m.frames.map((f) => {
      const d = Math.max(-1, Math.min(1, dot(f.long, f.face)));
      return (Math.acos(d) * 180) / Math.PI;
    });
    const spread = Math.max(...angles) - Math.min(...angles);
    expect(spread, `长轴/法线夹角跨度 ${spread.toFixed(2)}° 必须 < 0.5°（不绕剑身长轴自转）`)
      .toBeLessThan(0.5);
  });

  test('剑命中丧尸：扣血 + 红闪 + 击退 + 音效', async ({ page }) => {
    await page.goto('/?vd=4');
    await waitWorldReady(page);
    await installHelpers(page);
    const result = await page.evaluate(async () => {
      const g = window.__MC_GAME__;
      const pos = window.__ST__.legalSpawnNear(2); // 2 格内（剑射程 3）
      const id = g.zombies.spawn(pos, { source: 'test' });
      const before = g.zombies.get(id);
      const beforeHealth = before.health;
      const beforeFlash = before.flashedUntil;
      // 瞄准丧尸躯干
      window.__ST__.aimAt(pos);
      await g.selectWeapon('sword');
      await new Promise((r) => setTimeout(r, 600)); // 等模型加载
      // ⚠️ **基线必须在挥砍前一刻读**，不能用 spawn 时的位置：上面等了 600ms，
      // 期间丧尸 AI（1.2 格/秒追击）已经走了 ≈0.72 格 —— **比 0.4 格的击退还大**。
      // 拿 spawn 位置当基线的形态是「断言为错误的原因通过」（位移几乎全是 AI 追击）。
      const justBefore = g.zombies.get(id);
      const firePos = [...justBefore.position];
      const playerPos = [g.player.physics.pos.x, g.player.physics.pos.z];
      // 音效计数基线
      const swingBefore = g.audioDebugState().playRequests.player_swing ?? 0;
      const hitBefore = g.audioDebugState().playRequests.emp_activated ?? 0;
      // 挥砍
      const effects = g.fireWeaponOnce();
      const after = g.zombies.get(id);
      return {
        id,
        beforeHealth,
        afterHealth: after?.health ?? -1,
        beforeFlash,
        afterFlash: after?.flashedUntil ?? -1,
        firePos,
        playerPos,
        afterPos: after ? [...after.position] : null,
        effectType: effects[0]?.type ?? null,
        swingDelta: (g.audioDebugState().playRequests.player_swing ?? 0) - swingBefore,
        hitDelta: (g.audioDebugState().playRequests.emp_activated ?? 0) - hitBefore,
      };
    });
    // 扣血：50 伤害
    expect(result.afterHealth, '剑命中必须扣血').toBe(result.beforeHealth - 50);
    // 红闪：flashedUntil 必须增大（performance.now() 口径）
    expect(result.afterFlash, '命中必须置红闪').toBeGreaterThan(result.beforeFlash);
    // 击退：位移必须**背离玩家**。
    // ⚠️ 只钉「位置变了」是假阳性：丧尸 AI 本身就在朝玩家追击，两者都让位置变化。
    // **方向才是判据**：AI 追击是靠近，击退是远离。
    const [px, pz] = result.playerPos;
    const distBefore = Math.hypot(result.firePos[0] - px, result.firePos[2] - pz);
    const distAfter = Math.hypot(result.afterPos[0] - px, result.afterPos[2] - pz);
    const moved = Math.hypot(result.afterPos[0] - result.firePos[0], result.afterPos[2] - result.firePos[2]);
    expect(moved, '命中必须产生水平位移').toBeGreaterThan(0.01);
    expect(distAfter, '击退必须使丧尸**远离**玩家（AI 追击是靠近）').toBeGreaterThan(distBefore);
    expect(moved, '击退距离应 ≈ 0.4 格（不超 0.5）').toBeLessThan(0.5);
    // 音效：挥砍音 + 砍中音各响一次
    expect(result.swingDelta, '挥砍必须响 player_swing').toBe(1);
    expect(result.hitDelta, '命中必须响 emp_activated').toBe(1);
    // 效果事件类型
    expect(result.effectType).toBe('melee-hit');
  });

  /**
   * 负向对照：把 `knockback` 注入拆掉（模拟「忘记接线」），击退必须消失。
   *
   * ⚠️ **这条是上一条的真负向锚点**：若「位移 > 0」其实来自丧尸 AI 追击而不是击退，
   * 拆掉 knockback 后上一条仍会全绿 —— 只有这条能把它拆穿。
   */
  test('负向对照：拆掉 knockback 注入 → 击退消失（证明上一条不是 AI 位移的假阳性）', async ({ page }) => {
    await page.goto('/?vd=4');
    await waitWorldReady(page);
    await installHelpers(page);
    const result = await page.evaluate(async () => {
      const g = window.__MC_GAME__;
      const pos = window.__ST__.legalSpawnNear(2);
      const id = g.zombies.spawn(pos, { source: 'test' });
      window.__ST__.aimAt(pos);
      await g.selectWeapon('sword');
      await new Promise((r) => setTimeout(r, 600));
      // 拆掉击退接线（保留 raycast/damage/isHittable）
      const q = g.player.weaponController.entityQuery;
      g.player.weaponController.setEntityQuery({
        raycast: q.raycast, damage: q.damage, isHittable: q.isHittable,
      });
      const firePos = [...g.zombies.get(id).position];
      const healthBefore = g.zombies.get(id).health;
      const effects = g.fireWeaponOnce();
      const after = g.zombies.get(id);
      return {
        moved: Math.hypot(after.position[0] - firePos[0], after.position[2] - firePos[2]),
        healthDelta: healthBefore - after.health,
        effectType: effects[0]?.type ?? null,
        knockbackWired: typeof g.player.weaponController.entityQuery.knockback === 'function',
      };
    });
    expect(result.knockbackWired, '拆掉后 knockback 应不存在').toBe(false);
    expect(result.moved, '无击退接线时不得有位移').toBe(0);
    expect(result.healthDelta, '伤害仍须生效（只拆击退）').toBe(50);
    expect(result.effectType).toBe('melee-hit');
  });

  test('剑不破坏方块（即使 blockDamage 开启）', async ({ page }) => {
    await page.goto('/?vd=4');
    await waitWorldReady(page);
    const result = await page.evaluate(async () => {
      const g = window.__MC_GAME__;
      // 在相机前方 2 格放石头
      const x = Math.floor(g.camera.position.x);
      const y = Math.floor(g.camera.position.y);
      const z = Math.floor(g.camera.position.z) - 2;
      const stone = g.registry.idOf('stone');
      g.editor.setBlock({ x, y, z, id: stone });
      g.player.target = { hit: true, blockPos: [x, y, z], dist: 2 };
      await g.selectWeapon('sword');
      await new Promise((r) => setTimeout(r, 600));
      g.setGunBlockDamage(true); // 开关开启也不得写方块
      const effects = g.fireWeaponOnce();
      const blockAfter = g.world.getBlockId(x, y, z);
      return { blockAfter, stone, effectType: effects[0]?.type ?? null };
    });
    expect(result.blockAfter, '剑绝不破坏方块').toBe(result.stone);
    expect(result.effectType).toBe('melee'); // 无实体 → melee（挥空）
  });

  test('剑挥空：不扣血不击退，仍响挥砍音', async ({ page }) => {
    await page.goto('/?vd=4');
    await waitWorldReady(page);
    const result = await page.evaluate(async () => {
      const g = window.__MC_GAME__;
      await g.selectWeapon('sword');
      await new Promise((r) => setTimeout(r, 600));
      const swingBefore = g.audioDebugState().playRequests.player_swing ?? 0;
      const hitBefore = g.audioDebugState().playRequests.emp_activated ?? 0;
      // 朝空地挥（无实体）
      g.player.setTestAim([0, 0, -1]);
      const effects = g.fireWeaponOnce();
      return {
        effectType: effects[0]?.type ?? null,
        swingDelta: (g.audioDebugState().playRequests.player_swing ?? 0) - swingBefore,
        hitDelta: (g.audioDebugState().playRequests.emp_activated ?? 0) - hitBefore,
      };
    });
    expect(result.effectType).toBe('melee');
    expect(result.swingDelta, '挥空也响挥砍音').toBe(1);
    expect(result.hitDelta, '挥空不响砍中音').toBe(0);
  });

  test('剑超射程（>3 格）不命中', async ({ page }) => {
    await page.goto('/?vd=4');
    await waitWorldReady(page);
    await installHelpers(page);
    const result = await page.evaluate(async () => {
      const g = window.__MC_GAME__;
      const pos = window.__ST__.legalSpawnNear(6); // 6 格 > 剑射程 3
      const id = g.zombies.spawn(pos, { source: 'test' });
      const beforeHealth = g.zombies.get(id).health;
      window.__ST__.aimAt(pos);
      await g.selectWeapon('sword');
      await new Promise((r) => setTimeout(r, 600));
      const effects = g.fireWeaponOnce();
      const afterHealth = g.zombies.get(id)?.health ?? -1;
      return { beforeHealth, afterHealth, effectType: effects[0]?.type ?? null };
    });
    expect(result.afterHealth, '超射程不得扣血').toBe(result.beforeHealth);
    expect(result.effectType).toBe('melee'); // 挥空
  });

  /**
   * 用户原话：「挨了一剑后，如果没死的话，就往后退一小步」—— 故**致命一击不击退**
   *（实体直接 despawn，没有「往后退」这个动作）。本用例钉住这条语义：
   * 第二刀（50+50=100）致死 → 丧尸消失、不崩、死亡音 z_die 响一次。
   */
  test('致命一击：第二刀致死 → 丧尸消失、不击退、不崩溃', async ({ page }) => {
    await page.goto('/?vd=4');
    await waitWorldReady(page);
    await installHelpers(page);
    const result = await page.evaluate(async () => {
      const g = window.__MC_GAME__;
      const pos = window.__ST__.legalSpawnNear(2);
      const id = g.zombies.spawn(pos, { source: 'test' });
      await g.selectWeapon('sword');
      await new Promise((r) => setTimeout(r, 600));
      const cam = g.camera.position.toArray();
      const aim = () => g.player.setTestAim([pos[0] - cam[0], pos[1] + 0.9 - cam[1], pos[2] - cam[2]]);
      const zDieBefore = g.audioDebugState().playRequests.z_die ?? 0;
      // 第一刀：50 血（不死）
      aim();
      const e1 = g.fireWeaponOnce();
      const h1 = g.zombies.get(id)?.health ?? null;
      const alive1 = g.zombies.get(id) !== null;
      // 等冷却（0.5s）
      await new Promise((r) => setTimeout(r, 600));
      // 第二刀：致命（50+50=100）
      aim();
      const e2 = g.fireWeaponOnce();
      const alive2 = g.zombies.get(id) !== null;
      const zDieDelta = (g.audioDebugState().playRequests.z_die ?? 0) - zDieBefore;
      return {
        h1, alive1, type1: e1[0]?.type,
        alive2, type2: e2[0]?.type, entityId2: e2[0]?.entityId ?? null,
        zDieDelta, zombieCount: g.zombies.count(),
      };
    });
    expect(result.h1, '第一刀后剩 50 血').toBe(50);
    expect(result.alive1, '第一刀后仍存活').toBe(true);
    expect(result.type1).toBe('melee-hit');
    expect(result.alive2, '第二刀致死后丧尸必须消失').toBe(false);
    expect(result.type2, '致命一击仍是 melee-hit 事件').toBe('melee-hit');
    expect(result.entityId2, '致命一击仍报告命中实体').not.toBeNull();
    expect(result.zDieDelta, '致死必须响一次 z_die').toBe(1);
    expect(result.zombieCount, '丧尸计数归零').toBe(0);
  });

  /**
   * Boss（焰魔）：从玩家真实入口砍到它 —— 扣血 + 击退 + 红闪。
   *
   * 走 `g.summonBoss()`（与 C 键同路径）召出焰魔，再把玩家传送到它身旁（剑射程 3 内），
   * 瞼准后挥砍。焰魔站定环 5 格 > 剑射程 3，故必须把玩家主动送进环内才砍得到
   *（这正是近战 vs 远程 Boss 的风险回报设计）。
   */
  test('Boss（焰魔）：剑砍中 → 扣血 + 击退 + 红闪', async ({ page }) => {
    test.setTimeout(180_000);
    await page.goto('/?seed=12345&vd=6');
    await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 90_000 });
    // 传送到祭坛高台地带圆心（保证有 TARN 地图判定）
    const center = await page.evaluate(async () => {
      const { findAltarTarnRegion } = await import('/src/gen/structures/tarn-zone.js');
      const g = window.__MC_GAME__;
      const a = findAltarTarnRegion(g.seed);
      if (!a) return null;
      g.player.spawn(a.cx, 40, a.cz);
      return { cx: a.cx, cz: a.cz };
    });
    expect(center, 'seed=12345 必须有祭坛高台地带').not.toBeNull();
    await page.waitForTimeout(2500); // 等传送后的 column 加载
    // 等玩家落地（传送后 y 会继续下坠，立即读会拿到半空坐标）
    await page.waitForFunction(() => {
      const g = window.__MC_GAME__;
      const p = g.player.physics.pos;
      return g.world.isSolid(Math.floor(p.x), Math.floor(p.y - 0.5), Math.floor(p.z));
    }, null, { timeout: 30_000 });
    await page.waitForTimeout(400);

    const result = await page.evaluate(async () => {
      const g = window.__MC_GAME__;
      // 第一次 summonBoss → 飞龙（slot 0）；第二次 → 焰魔（slot 1）
      g.summonBoss();
      await new Promise((r) => setTimeout(r, 300));
      g.summonBoss();
      await new Promise((r) => setTimeout(r, 800));
      const ignises = g.ignises.activeEntities();
      if (ignises.length === 0) return { summoned: false };
      const e = ignises[0];
      const id = e.id;
      // 把玩家传送到焰魔身旁（剑射程 3 内）：水平 2 格、同高
      const [bx, by, bz] = e.state.position;
      g.player.spawn(bx + 2, by + 1, bz);
      await new Promise((r) => setTimeout(r, 500)); // 等落地稳定
      // ⚠️ **先选剑、等模型，再读基线并挥砍**：焰魔在玩家贴近（d < 环内界 4.25）时
      // 是「站定不动如山」（v2.62 用户裁定），故 600ms 等待期间它不会走开；
      // 但基线仍必须在挥砍前一刻读，不能拿传送前的位置当基线。
      await g.selectWeapon('sword');
      await new Promise((r) => setTimeout(r, 600));
      // ⚠️ **瞼准用「当下」的位置**，不能用传送前读的 bx/by/bz：中间过了 1100ms，
      // 焰魔可能已从 chase 态走进死区（虽然贴近时它站定，但进环前的那几步会动）。
      const now = g.entities.get(id).state;
      const [nx, ny, nz] = now.position;
      // 瞼准焰魔身体中心（脚底 + height/2）
      const cam = g.camera.position.toArray();
      g.player.setTestAim([nx - cam[0], ny + 1.6 - cam[1], nz - cam[2]]);
      const before = g.entities.get(id).state;
      const beforeHealth = before.health;
      const beforeFlash = before.flashedUntil;
      const firePos = [...before.position];
      const playerPos = [g.player.physics.pos.x, g.player.physics.pos.z];
      const effects = g.fireWeaponOnce();
      // ⚠️ **必须同步读**：`fireWeaponOnce()` 里的击退是同步写入的，而焰魔 Agent 每帧
      // 从 `state.position` 起步推进 —— 中间插一个 await（让出一帧）就会把击退位移混进
      // Agent 自己的移动里，判据变成「两者之和」而不是击退本身。
      const after = g.entities.get(id).state;
      return {
        summoned: true,
        beforeHealth,
        afterHealth: after?.health ?? -1,
        beforeFlash,
        afterFlash: after?.flashedUntil ?? -1,
        firePos,
        playerPos,
        afterPos: after ? [...after.position] : null,
        effectType: effects[0]?.type ?? null,
      };
    });
    expect(result.summoned, '焰魔必须被召出').toBe(true);
    expect(result.afterHealth, '剑砍中焰魔必须扣血').toBe(result.beforeHealth - 50);
    expect(result.afterFlash, '命中必须置红闪').toBeGreaterThan(result.beforeFlash);
    // 击退方向：背离玩家（焰魔 AI 也会动，故用方向判据而非纯位移）
    const [px, pz] = result.playerPos;
    const distBefore = Math.hypot(result.firePos[0] - px, result.firePos[2] - pz);
    const distAfter = Math.hypot(result.afterPos[0] - px, result.afterPos[2] - pz);
    expect(distAfter, '击退必须使焰魔远离玩家').toBeGreaterThan(distBefore);
    expect(result.effectType).toBe('melee-hit');
  });

  /**
   * Boss（飞龙）：剑砍中 → 扣血 + 击退。
   *
   * ⚠️ 飞龙盘旋在 y≈30、俯冲最低 ≈12，正常玩法里很少进剑的 3 格射程 —— 故本用例
   * 直接把飞龙 position 摆到玩家面前（服务层摆位，不走玩法 AI），验证「剑确实能伤到
   * 飞龙」这条接线路径（`Game.knockbackEntity` → `DragonService.knockback`）。
   */
  test('Boss（飞龙）：剑砍中 → 扣血 + 击退', async ({ page }) => {
    await page.goto('/?vd=4');
    await waitWorldReady(page);
    const result = await page.evaluate(async () => {
      const g = window.__MC_GAME__;
      // ⚠️ **先选剑、等模型，再摆龙**：飞龙 chase 态以 9 格/秒飞行，若先摆龙再等
      // 600ms，它会飞过玩家身边（位移 ≈5 格）—— 那时瞼准方向与距离都已失效。
      // 选剑与摆龙无依赖关系，故把等待放在摆龙之前。
      await g.selectWeapon('sword');
      await new Promise((r) => setTimeout(r, 600));
      const p = g.player.physics.pos;
      // 直接在玩家面前 2 格、同高摆一条龙（服务层摆位，验证接线路径）。
      // ⚠️ `mode` 必须给 `'chase'` 而不是 `'orbit'`：orbit 态的 position 每帧被轨道 pose
      // 覆写（`dragon-boss-agent.js` ② `px = mode==='orbit' ? orbitPose.position[0] : state.position[0]`），
      // 击退位移下一帧就被轨道抹掉。
      const orbit = Object.freeze({
        cx: p.x, cz: p.z, y: p.y + 30, radius: 10, omega: 0.3, phase: 0,
      });
      const id = 'dragon:test:0:0';
      const spawned = g.entities.spawn({
        id,
        type: 'dragon',
        state: {
          position: [p.x, p.y + 1, p.z - 2], yaw: 0, orbit, orbitT: 0,
          health: 3000, flashedUntil: 0, mode: 'chase',
        },
      });
      if (!spawned) return { spawned: false };
      // 瞼准飞龙身体中心，然后**同一同步块内**立即挥砍（不让出帧）
      const cam = g.camera.position.toArray();
      g.player.setTestAim([p.x - cam[0], p.y + 1 - cam[1], (p.z - 2) - cam[2]]);
      const before = g.entities.get(id).state;
      const beforeHealth = before.health;
      const beforeFlash = before.flashedUntil;
      const firePos = [...before.position];
      const effects = g.fireWeaponOnce();
      // ⚠️ 同步读（同焰魔用例的理由）：飞龙 chaseSpeed 9 格/秒，让出一帧就会把
      // 0.4 格的击退淹没在它自己的飞行位移里。
      const after = g.entities.get(id).state;
      return {
        spawned: true,
        beforeHealth,
        afterHealth: after?.health ?? -1,
        beforeFlash,
        afterFlash: after?.flashedUntil ?? -1,
        moved: after ? Math.hypot(after.position[0] - firePos[0], after.position[2] - firePos[2]) : -1,
        effectType: effects[0]?.type ?? null,
      };
    });
    expect(result.spawned, '飞龙必须摆位成功').toBe(true);
    expect(result.afterHealth, '剑砍中飞龙必须扣血').toBe(result.beforeHealth - 50);
    expect(result.afterFlash, '命中必须置红闪').toBeGreaterThan(result.beforeFlash);
    expect(result.moved, '命中必须击退飞龙').toBeGreaterThan(0.01);
    expect(result.effectType).toBe('melee-hit');
  });
});
