// src/tests/test-view-bob-wiring.js — 步态 bob 的**三视图模型接线**（v3.46，Tier 1）
//
// 用户 2026-11-27：「让玩家在 mc-heavy 里奔跑过程中的手臂晃动、剑的晃动也实现掉，
// 除了卡宾枪以外的枪就先保奔跑时不晃动。」
//
// ## 本文件守的失效路径（都是「计数判据全绿而观感错」那一类）
//
//   ① **枪也跟着晃**：`view-weapon.js` 的 bob 漏 `weapon.melee` 门控 ⇒ pistol/mag7/minigun
//      在跑动时一起晃。所有「模型加载成功 / 有像素 / 位置在视口内」判据全绿。
//   ② **静止不归零**：bob 在 amp=0 时仍写位移 ⇒ 站着不动剑也在抖。
//   ③ **第二份权威**：任一处把 0.012/0.014/0.018 或 intensity 写成字面量 ⇒ 调参时漂移成
//      「相机晃得大、手臂晃得小」。
//   ④ **挥砍几何被 bob 破坏**：bob 叠进挥砍矩阵内层 ⇒ 剑柄不再钉在屏下。
//
// ⚠️ 手臂自身的 bob 判据在 `test-view-bob.js`；本文件只管**剑与枪的分流**与**同源**。
import * as THREE from 'three';
import { test } from './runner.js';
import { assertEqual, assertTrue, assertNotNull } from './assert.js';
import { ViewWeapon } from '../render/view-weapon.js';
import { VIEW_BOB } from '../render/view-bob-config.js';
import { VIEW_ARM } from '../render/view-arm.js';
import { CARBINE_VIEW } from '../render/carbine-view.js';
import { WEAPONS, WEAPON_IDS } from '../player/weapons/weapon-catalog.js';

/** 造一个已挂载指定武器的 ViewWeapon（模型用空 Group，测的是姿态不是外观） */
async function makeView(id) {
  const camera = new THREE.PerspectiveCamera();
  const view = new ViewWeapon({ camera, modelLoader: { load: async () => new THREE.Group() } });
  await view.select(id);
  // 举枪动画走完（drawProgress → 1），排除「还在渐入」这个变量
  for (let i = 0; i < 60; i++) view.update(1 / 60);
  return { camera, view };
}

/**
 * 两个节点的**实际渲染姿态**差（位置 + 旋转矩阵）。
 *
 * ⚠️ **不能用 `quaternion.angleTo`**（本轮实测踩到）：minigun 的 catalog 姿态是
 * `rotation.order='YXZ'` 且 y=−π/2 —— **正好在万向锁上**。three 的
 * `Euler ↔ Quaternion` 往返在锁点附近会在**两个等价表示**之间跳（实测恒差
 * **4.2147e-8 rad**，**喂不喂 bob 都一样**，甚至同一实例 `update(0)` 也跳）。
 * 拿它当「逐位不变」的判据是假红。矩阵是 GPU 真正消费的量，比它才稳。
 */
function poseGap(a, b) {
  a.updateMatrix();
  b.updateMatrix();
  let m = 0;
  for (let i = 0; i < 16; i++) m = Math.max(m, Math.abs(a.matrix.elements[i] - b.matrix.elements[i]));
  return m;
}

test('bob 接线: 三把枪（pistol/mag7/minigun）跑动时姿态逐位不变', async () => {
  /**
   * ⚠️ **判据是单变量 A/B，不是「绝对零漂移」**（本轮实测踩到）：
   * minigun 的 `rotation.order = 'YXZ'`，而 `rotation.set()` → quaternion 的换算
   * 每帧重复一次会累积 **4.2e-8 rad** 的浮点误差 —— **不喂 bob 也一样**（实测）。
   * 拿 1e-12 当阈是假红。正解：同一武器跑两组（喂 bob / 不喂），比两者的差。
   */
  for (const id of [WEAPON_IDS.PISTOL, WEAPON_IDS.MAG7, WEAPON_IDS.MINIGUN]) {
    const withBob = await makeView(id);
    const noBob = await makeView(id);
    for (let i = 0; i < 60; i++) {
      withBob.view.update(1 / 60, { bobPhase: i * 0.2, bobAmp: 1 });
      noBob.view.update(1 / 60);
    }
    const gap = poseGap(withBob.view.node, noBob.view.node);
    assertTrue(gap < 1e-9,
      `${id}：喂 bob 与不喂的渲染矩阵须逐位相同（用户要求枪不晃），实测最大元差 ${gap}`);
    withBob.view.dispose();
    noBob.view.dispose();
  }
});

test('bob 接线: 剑跑动时有位移与滚转，且幅度受配置约束', async () => {
  const { view } = await makeView(WEAPON_IDS.SWORD);
  const rest = view.node.position.clone();
  const restQ = view.node.quaternion.clone();
  let maxD = 0; let maxAngle = 0;
  for (let i = 0; i < 120; i++) {
    view.update(1 / 120, { bobPhase: i * 0.1, bobAmp: 1 });
    maxD = Math.max(maxD, view.node.position.distanceTo(rest));
    maxAngle = Math.max(maxAngle, view.node.quaternion.angleTo(restQ));
  }
  // 平移分量须达配置量级（下界取 hypot 的一半，两侧都不贴线）
  const flat = Math.hypot(VIEW_BOB.x, VIEW_BOB.y);
  assertTrue(maxD > flat * 0.5, `剑跑动位移须达配置量级（>${flat * 0.5}），实测 ${maxD}`);
  // 上界 = 平移 + 滚转绕相机原点的杆臂效应（剑柄离原点约 1.2 格）
  const bound = flat + rest.length() * VIEW_BOB.roll;
  assertTrue(maxD <= bound + 1e-9, `剑跑动位移不得超上界 ${bound}，实测 ${maxD}`);
  assertTrue(maxAngle > VIEW_BOB.roll * 0.5,
    `剑跑动须有滚转（>${VIEW_BOB.roll * 0.5} rad），实测 ${maxAngle}`);
  view.dispose();
});

test('bob 接线: 剑静止（amp=0）时姿态逐位回到无 bob', async () => {
  // 同样用**单变量 A/B**（剑的 rotationOrder 是 XYZ，但 `rotation.set` 的浮点累积同理）。
  const withBob = await makeView(WEAPON_IDS.SWORD);
  const noBob = await makeView(WEAPON_IDS.SWORD);
  for (let i = 0; i < 30; i++) {
    withBob.view.update(1 / 60, { bobPhase: i * 0.2, bobAmp: 1 });
    noBob.view.update(1 / 60);
  }
  // 停下：喂 amp=0 ⇒ 必须立刻逐位回到无 bob 那一组（不是慢慢收敛）
  withBob.view.update(1 / 60, { bobPhase: 3.7, bobAmp: 0 });
  noBob.view.update(1 / 60);
  const gap = poseGap(withBob.view.node, noBob.view.node);
  assertTrue(gap < 1e-9, `amp=0 须逐位回到无 bob，实测矩阵最大元差 ${gap}`);
  withBob.view.dispose();
  noBob.view.dispose();
});

test('bob 接线: 挥砍中叠 bob 不破坏支点几何（剑柄仍在原处附近）', async () => {
  // ⚠️ 这条守的是「bob 叠进挥砍矩阵内层」：那会让支点补偿 c 失效，
  // 剑柄跟着 bob 大幅漂移（既有 8 条挥砍轨迹判据的几何前提被破坏）。
  const { view } = await makeView(WEAPON_IDS.SWORD);
  const weapon = WEAPONS[WEAPON_IDS.SWORD];
  assertNotNull(weapon.swingPivot, '前置：剑须有挥砍支点');
  const pivotLocal = new THREE.Vector3(...weapon.swingPivot);

  const pivotAt = (bobAmp) => {
    view.onShot({ type: 'melee' });
    // 推进到挥砍中段（strikeEnd 之后，收回段）
    for (let i = 0; i < 8; i++) view.update(weapon.swingSeconds / 16, { bobPhase: 1.0, bobAmp });
    view.node.updateMatrix();
    return pivotLocal.clone().applyMatrix4(view.node.matrix);
  };
  const noBob = pivotAt(0);
  const withBob = pivotAt(1);
  const drift = withBob.distanceTo(noBob);
  // bob 对支点的最大影响 = 平移 + 滚转杆臂（支点离原点约 1.2 格）
  const bound = Math.hypot(VIEW_BOB.x, VIEW_BOB.y) + noBob.length() * VIEW_BOB.roll + 1e-6;
  assertTrue(drift <= bound,
    `bob 对剑柄的影响须限于步态量级（≤${bound}），实测 ${drift} —— 超出说明 bob 叠进了挥砍内层`);
  assertTrue(drift > 0, '前提：bob 确实动了剑柄（否则本用例零判别力）');
  view.dispose();
});

test('bob 接线: 三个视图模型的步态幅度同源（红线 1，无第二份字面量）', () => {
  // 手臂
  assertEqual(VIEW_ARM.bobX, VIEW_BOB.x, '手臂 bobX 须来自 VIEW_BOB');
  assertEqual(VIEW_ARM.bobY, VIEW_BOB.y, '手臂 bobY 须来自 VIEW_BOB');
  assertEqual(VIEW_ARM.bobRoll, VIEW_BOB.roll, '手臂 bobRoll 须来自 VIEW_BOB');
  // KV-9 卡宾枪（v3.30 起就有 bob；v3.46 改为从共享配置派生，数值逐位不变）
  assertEqual(CARBINE_VIEW.bobX, VIEW_BOB.x, 'KV-9 bobX 须来自 VIEW_BOB');
  assertEqual(CARBINE_VIEW.bobY, VIEW_BOB.y, 'KV-9 bobY 须来自 VIEW_BOB');
  assertEqual(CARBINE_VIEW.bobRoll, VIEW_BOB.roll, 'KV-9 bobRoll 须来自 VIEW_BOB');
  // 上游原值（字面量写死，不从被测常量派生 —— policy §2.7 第 7 类）
  assertEqual(VIEW_BOB.x, 0.012, '上游 cos(ph)*0.012*amp');
  assertEqual(VIEW_BOB.y, 0.014, '上游 -|sin(ph)|*0.014*amp');
  assertEqual(VIEW_BOB.roll, 0.018, '上游 sin(ph)*0.018*amp');
});