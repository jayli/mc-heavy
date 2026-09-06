import { test, expect } from 'playwright/test';

// M4：曳光起点世界空间冻结（修镜头移动时弹道歪斜，设计文档 §3 有意偏离）。
// mc-lite 每帧以当前相机基底重算曳光起点（相机空间起点 + 世界空间终点的混合坐标系），
// 快速转镜头时起点被拖着走、终点钉死 → 弹道看上去歪。M4 把起点也冻结在世界空间。
// 断言：spawn 后用两个不同相机基底调用 update()，曳光实例矩阵的位置分量不变。
test('M4：曳光起点世界空间冻结，镜头移动不歪斜', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => window.__MC_BOOT__?.rendererReady === true, null, { timeout: 30_000 });
  const result = await page.evaluate(async () => {
    const THREE = await import('three');
    const { TracerRenderer } = await import('/src/render/tracer-renderer.js');
    const scene = new THREE.Scene();
    const tracers = new TracerRenderer({ scene });
    // 一条曳光：世界起点 (10,10,10)，终点 (10,10,-10)
    tracers.spawn({
      start: [10, 10, 10], localStart: [0, 0, -1], end: [10, 10, -10],
      tracer: { color: 0xffff00, thickness: 1, lifetime: 5 },
    });
    const readPos = () => {
      const m = new THREE.Matrix4();
      tracers.mesh.getMatrixAt(tracers._activeOrder[0], m);
      const e = m.elements; // 列主序：平移在第 13/14/15 列
      return [e[12], e[13], e[14]];
    };
    // 相机基底 A（origin 在原点附近）
    const basisA = { origin: [0, 0, 0], forward: [0, 0, -1], right: [1, 0, 0], up: [0, 1, 0] };
    tracers.update(0.016, basisA);
    const posA = readPos();
    // 相机基底 B（origin 大幅移动 + 转向，模拟快速甩镜头）
    const basisB = { origin: [50, 30, 20], forward: [0, 0, 1], right: [-1, 0, 0], up: [0, 1, 0] };
    tracers.update(0.016, basisB);
    const posB = readPos();
    const moved = Math.abs(posA[0] - posB[0]) + Math.abs(posA[1] - posB[1]) + Math.abs(posA[2] - posB[2]);
    tracers.dispose();
    return { posA, posB, moved };
  });
  // 起点冻结 → 两个相机基底下位置完全一致（世界坐标，与相机无关）
  expect(result.moved).toBeLessThan(1e-6);
  // 中点 = (start+end)/2 = (10,10,0)
  expect(result.posA[0]).toBeCloseTo(10, 3);
  expect(result.posA[1]).toBeCloseTo(10, 3);
  expect(result.posA[2]).toBeCloseTo(0, 3);
});

// M4：相机视图模型（ViewWeapon）与上限曳光池（TracerRenderer）。
// 断言：minigun 挂到 camera 且 rotation.order='YXZ'；select arm 后移除；
// 连续 spawn 33 条曳光后 active 恒为 32（最旧者被回收）；scene 始终只有一个 InstancedMesh；
// dispose 后 camera/scene 不留节点。
test('M4：视图模型挂相机、曳光池上限 32、dispose 无残留', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => window.__MC_BOOT__?.rendererReady === true, null, { timeout: 30_000 });
  const result = await page.evaluate(async () => {
    const THREE = await import('three');
    const { ViewWeapon } = await import('/src/render/view-weapon.js');
    const { TracerRenderer } = await import('/src/render/tracer-renderer.js');
    const camera = new THREE.PerspectiveCamera();
    const scene = new THREE.Scene();
    const view = new ViewWeapon({ camera, modelLoader: { load: async () => new THREE.Group() } });
    await view.select('minigun');
    const beforeArm = { children: camera.children.length, order: view.state.rotationOrder };
    await view.select('arm');
    const tracers = new TracerRenderer({ scene });
    for (let i = 0; i < 33; i++) {
      tracers.spawn({
        start: [0, 0, 0], localStart: [0, 0, -1], end: [0, 0, -4 - i],
        tracer: { color: i % 2 ? 0xffff00 : 0xff6600, thickness: 1, lifetime: 1 },
      });
    }
    const active = tracers.activeCount;
    const tracerNodes = scene.children.length;
    tracers.dispose();
    view.dispose();
    return {
      beforeArm,
      afterArm: camera.children.length,
      active,
      tracerNodes,
      disposedTracerNodes: scene.children.length,
    };
  });
  expect(result.beforeArm).toEqual({ children: 1, order: 'YXZ' });
  expect(result.afterArm).toBe(0);
  expect(result.active).toBe(32);
  expect(result.tracerNodes).toBe(1);
  expect(result.disposedTracerNodes).toBe(0);
});


// M4：武器灯光 —— 枪体不得渲染为纯黑（设计文档 §4.2「武器模型灯光」段）。
// 根因：GLTFLoader 生成 MeshPhysicalMaterial（PBR 吃灯光），而 mc-heavy 全场景 unlit
// （体素亮度烘焙在顶点 shade）且场景原本零灯光 → 枪体渲染为纯黑。建模颜色没丢在资源里，
// 丢在渲染端没有光源（mc-lite 的枪正常是因为其场景有灯 Engine.js:168,194）。
// 修法：场景补 mc-lite 同款双灯（AmbientLight + DirectionalLight）。
// Tier 4 像素级实测（差分口径，不宣称目视）：徒手 vs 持枪两张截图的差分像素 = 枪体本身，
// 断言差分像素平均亮度显著高于纯黑（修复前枪体 lum≈0）。
test('M4：武器灯光 —— 场景双灯 + 枪体差分像素非黑', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => window.__MC_BOOT__?.rendererReady === true, null, { timeout: 30_000 });
  // 截图 A：徒手基线（无枪体）
  await page.evaluate(async () => {
    await window.__MC_GAME__.selectWeapon('arm');
    await new Promise((r) => setTimeout(r, 800));
  });
  const shotA = await page.screenshot();
  // 截图 B：持枪（举枪动画完成 + 渲染稳定）
  await page.evaluate(async () => {
    await window.__MC_GAME__.selectWeapon('pistol');
    await new Promise((r) => setTimeout(r, 1200));
  });
  const shotB = await page.screenshot();
  // ① 结构断言：场景必须有双灯（金属件 metallicFactor=1，只有环境光仍黑，方向光高光不可省）
  const lights = await page.evaluate(() => {
    const found = [];
    window.__MC_GAME__.scene.traverse((o) => { if (o.isLight) found.push(o.type); });
    return found;
  });
  expect(lights).toContain('AmbientLight');
  expect(lights).toContain('DirectionalLight');
  // ② 像素断言：差分像素（= 枪体覆盖处）平均亮度必须显著高于纯黑
  const { PNG } = await import('pngjs');
  const pngA = PNG.sync.read(shotA);
  const pngB = PNG.sync.read(shotB);
  expect(pngA.width).toBe(pngB.width);
  let lumSum = 0, diffCount = 0;
  for (let y = 0; y < pngA.height; y++) {
    for (let x = 0; x < pngA.width; x++) {
      const i = (pngA.width * y + x) << 2;
      // 任一通道差 > 8 视为枪体像素（同视角静态世界，其余像素应完全一致）
      const d = Math.abs(pngA.data[i] - pngB.data[i])
        + Math.abs(pngA.data[i + 1] - pngB.data[i + 1])
        + Math.abs(pngA.data[i + 2] - pngB.data[i + 2]);
      if (d > 8) {
        diffCount++;
        lumSum += (pngB.data[i] + pngB.data[i + 1] + pngB.data[i + 2]) / 3;
      }
    }
  }
  expect(diffCount).toBeGreaterThan(100); // 枪体确实占了一块屏幕区域
  const avgLum = lumSum / diffCount;
  // 修复前：枪体全黑 → 差分像素 lum≈0~5；修复后：材质色 + 高光 → 显著更亮。
  expect(avgLum).toBeGreaterThan(15);
});
