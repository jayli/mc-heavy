// src/tests/test-ground-reflect.js — 湿地面独立反射的纯函数（Tier 1，v3.30d）
//
// 用户 2026-11-22 报告「有的方块不呈现反射，好像地下一层模糊透射」。
// 根因是**复用海平面 reflector 在几何上不可能正确**（地面 y≈22 vs 镜面 −1.5）。
// 本模块钉住新方案的四个纯函数：镜面探针 / 平滑跟随 / 节流 / 可见性门。
import { test } from './runner.js';
import { assertEqual, assertTrue, assertFalse } from './assert.js';
import { createRegistry } from '../voxel/block-registry.js';
import { BLOCKS } from '../voxel/blocks-data.js';
import { blocksRain } from '../render/rain-shelter.js';
import {
  GROUND_REFLECT_SCALE, GROUND_REFLECT_EVERY, GROUND_MIRROR_LIFT,
  GROUND_REFLECT_STRENGTH, GROUND_MIRROR_DAMP, GROUND_MIRROR_SNAP_DIST,
  groundMirrorCandidate, groundMirrorAdvance, groundReflectDue, groundReflectVisible,
} from '../render/ground-reflect-config.js';

const REG = createRegistry();
for (const b of BLOCKS) REG.register(b.name, b);
REG.freeze();
const id = (n) => REG.idOf(n);

function fakeWorld(cells) {
  return { getBlockId: (x, y, z) => cells.get(`${x},${y},${z}`) ?? 0 };
}
function put(cells, x, y, z, name) { cells.set(`${x},${y},${z}`, id(name)); }
function assertClose(a, b, eps = 1e-9, msg = '') {
  if (!(Math.abs(a - b) <= eps)) throw new Error(`${msg ? msg + ': ' : ''}期望 ${b}±${eps}，实际 ${a}`);
}

// ---------- 常量关系 ----------

test('ground reflect: 常量在合理区间（分辨率/节流/抬升/强度）', () => {
  assertTrue(GROUND_REFLECT_SCALE > 0 && GROUND_REFLECT_SCALE <= 1);
  assertTrue(GROUND_REFLECT_EVERY >= 1);
  // 抬升必须 >0（防共面 z-fighting）但远小于 1 格（不影响倒影几何）
  assertTrue(GROUND_MIRROR_LIFT > 0 && GROUND_MIRROR_LIFT < 0.1);
  assertTrue(GROUND_REFLECT_STRENGTH > 0 && GROUND_REFLECT_STRENGTH <= 1);
  assertTrue(GROUND_MIRROR_DAMP > 0);
  assertTrue(GROUND_MIRROR_SNAP_DIST > 1);
});

// ---------- 镜面探针 ----------

test('ground reflect: 探针取玩家脚下第一个实心格的顶面', () => {
  const cells = new Map();
  put(cells, 4, 21, 4, 'grass');       // 地面在 y=21 ⇒ 顶面 22
  const w = fakeWorld(cells);
  assertEqual(groundMirrorCandidate(w, REG, 4.5, 22, 4.5, blocksRain), 22);
});

test('ground reflect: 探针跳过树叶与云（它们不是地面）', () => {
  const cells = new Map();
  for (let y = 20; y <= 24; y++) put(cells, 4, y, 4, 'leaves');
  put(cells, 4, 10, 4, 'stone');
  const w = fakeWorld(cells);
  // 从 y=25 往下扫：树叶全跳过 ⇒ 停在 stone 顶面 11
  assertEqual(groundMirrorCandidate(w, REG, 4.5, 25, 4.5, blocksRain), 11);
});

test('ground reflect: 扫不到地面返回 null（高空飞行 ⇒ 不画反射）', () => {
  const w = fakeWorld(new Map());
  assertEqual(groundMirrorCandidate(w, REG, 4.5, 80, 4.5, blocksRain), null);
});

test('ground reflect: 探针 x/z 取整（小数坐标不得读成 air）', () => {
  const cells = new Map();
  put(cells, 4, 21, 4, 'stone');
  const w = fakeWorld(cells);
  assertEqual(groundMirrorCandidate(w, REG, 4.9, 22, 4.1, blocksRain), 22);
});

// ---------- 平滑跟随 ----------

test('ground reflect: 首帧直接吸附到目标（不平滑）', () => {
  assertEqual(groundMirrorAdvance(null, 22, 0.016), 22);
});

test('ground reflect: 台阶 1 格平滑收敛（不跳变）', () => {
  let y = 22;
  const seen = [];
  for (let i = 0; i < 30; i++) {
    y = groundMirrorAdvance(y, 23, 1 / 60);
    seen.push(y);
  }
  // 单调递增、首帧不跳满、末帧接近目标
  assertTrue(seen[0] > 22 && seen[0] < 23, `首帧应部分收敛，实际 ${seen[0]}`);
  for (let i = 1; i < seen.length; i++) assertTrue(seen[i] >= seen[i - 1] - 1e-9, '必须单调');
  assertTrue(Math.abs(seen[seen.length - 1] - 23) < 0.01, '30 帧后应基本到位');
});

test('ground reflect: 大幅瞬移直接吸附（不平滑好几秒）', () => {
  const y = groundMirrorAdvance(22, 22 + GROUND_MIRROR_SNAP_DIST + 1, 0.016);
  assertEqual(y, 22 + GROUND_MIRROR_SNAP_DIST + 1);
});

test('ground reflect: 目标 null ⇒ 返回 null（扫不到地面就停画）', () => {
  assertEqual(groundMirrorAdvance(22, null, 0.016), null);
  assertEqual(groundMirrorAdvance(22, NaN, 0.016), null);
});

test('ground reflect: dt=0 时不动（帧率无关）', () => {
  assertClose(groundMirrorAdvance(22, 23, 0), 22, 1e-12);
});

test('ground reflect: 平滑是帧率无关的（两种 dt 走同一总时长后接近）', () => {
  let a = 22; let b = 22;
  for (let i = 0; i < 60; i++) a = groundMirrorAdvance(a, 23, 1 / 60);
  for (let i = 0; i < 120; i++) b = groundMirrorAdvance(b, 23, 1 / 120);
  assertClose(a, b, 1e-6, '1 秒后两种帧率应到同一位置');
});

// ---------- 节流 ----------

test('ground reflect: 首帧恒放行（否则第一帧采到空 RT）', () => {
  assertTrue(groundReflectDue(1, -1, true));
});

test('ground reflect: 按帧节流（every=2 ⇒ 隔帧放行）', () => {
  assertFalse(groundReflectDue(2, 1, true, 2));
  assertTrue(groundReflectDue(3, 1, true, 2));
  assertFalse(groundReflectDue(4, 3, true, 2));
  assertTrue(groundReflectDue(5, 3, true, 2));
});

test('ground reflect: 不可见时恒不放行（零成本）', () => {
  assertFalse(groundReflectDue(1, -1, false));
  assertFalse(groundReflectDue(99, 1, false));
});

// ---------- 可见性门 ----------

test('ground reflect: 相机在镜面之上且朝下 ⇒ 可见', () => {
  assertTrue(groundReflectVisible(23.6, 22, -0.5));
  assertTrue(groundReflectVisible(23.6, 22, 0));      // 平视也算（地面铺满下半屏）
});

test('ground reflect: 相机在镜面之下 ⇒ 不可见', () => {
  assertFalse(groundReflectVisible(21, 22, -0.5));
  assertFalse(groundReflectVisible(22, 22, -0.5));    // 共面也不算
});

test('ground reflect: 抬头超半视场角 ⇒ 不可见', () => {
  assertFalse(groundReflectVisible(23.6, 22, 0.9));   // sin(0.61)≈0.573
  assertTrue(groundReflectVisible(23.6, 22, 0.5));
});

test('ground reflect: 镜面 null / NaN ⇒ 不可见（防未初始化时白跑 pass）', () => {
  assertFalse(groundReflectVisible(23.6, null, -0.5));
  assertFalse(groundReflectVisible(23.6, NaN, -0.5));
  assertFalse(groundReflectVisible(NaN, 22, -0.5));
});

// ---------- 与旧方案的对照（根因回归门） ----------

test('ground reflect: 镜面必须贴地面而不是海平面（根因回归）', () => {
  const cells = new Map();
  put(cells, 4, 21, 4, 'grass');
  const w = fakeWorld(cells);
  const mirror = groundMirrorCandidate(w, REG, 4.5, 22, 4.5, blocksRain);
  const SEA_MIRROR = -1.5;   // WATER_LEVEL_OFFSET
  // 旧方案把地面点压到 −1.5 ⇒ 位移 23.5 格；新方案位移 ≈0
  assertClose(Math.abs(mirror - 22), 0, 1e-12, '新镜面必须与地面同高');
  assertTrue(Math.abs(SEA_MIRROR - 22) > 20, '旧镜面与地面差 20+ 格 ⇒ 几何上不可能正确');
});