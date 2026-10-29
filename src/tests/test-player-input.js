// src/tests/test-player-input.js — 方向键移动（v1.80）
//
// 用户要求：「asdw 可以控制方向之外，让键盘的方向键也可以控制方向」。
//
// 钉三件事：① 四个方向键与 WASD 产生**逐位相同的位移方向**（同 yaw 同速度）；
// ② 两套键同时按下**不叠加速度**（取 1 不取 2 —— 天真的 `+` 写法会得到 2 倍速）；
// ③ 方向键的 keydown 被 preventDefault 吞掉（否则箭头键会触发浏览器默认滚动/聚焦行为），
// 且**只吞箭头键**（F5/F12 等不能被顺手拦掉）。
//
// ⚠️ 这里走**真实 window 上的真实 keydown 事件**而非直接 `keys.add()`：本改动的落点之一就是
// `onKeyDown` 里的 preventDefault，只塞 keys 的用例测不到它（M7「只测 API 漏玩家主路径」同类）。
// 也不用 replace globalThis.window —— 浏览器里那是个只读 getter（实测 TypeError）。

import { test } from './runner.js';
import { assertTrue, assertEqual } from './assert.js';
import { Player, SPAWN_YAW } from '../player/player.js';
import { FLY_VERTICAL_SPEED } from '../player/physics.js';
import { WorldData } from '../voxel/world-data.js';
import { ChunkColumn } from '../voxel/chunk-column.js';
import { createRegistry } from '../voxel/block-registry.js';

/** 派发真实可取消的 keydown 到 window，返回是否被 preventDefault。 */
function pressKey(code) {
  const ev = new KeyboardEvent('keydown', { code, cancelable: true, bubbles: true });
  window.dispatchEvent(ev);
  return ev.defaultPrevented;
}

function releaseKey(code) {
  window.dispatchEvent(new KeyboardEvent('keyup', { code, cancelable: true, bubbles: true }));
}

function makeFixture() {
  const registry = createRegistry();
  const world = new WorldData(registry);
  world.add(new ChunkColumn(0, 0));
  const player = new Player({
    world, registry,
    canvas: { addEventListener: () => {}, removeEventListener: () => {}, requestPointerLock: () => {} },
    editor: { setBlock: () => ({ affected: [] }), subscribe: () => () => {} },
    camera: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } },
    scheduler: null,
  });
  return { player };
}

/** 走真实物理一步，返回本步水平位移（dx, dz）。yaw = -π/2 → 前进沿 +X。 */
function stepDelta(player) {
  player.yaw = -Math.PI / 2;
  const bx = player.physics.pos.x;
  const bz = player.physics.pos.z;
  player._applyInput();
  player.physics.step(1 / 60);
  return { dx: player.physics.pos.x - bx, dz: player.physics.pos.z - bz };
}

const round3 = (v) => Math.round(v * 1000) / 1000;

/**
 * **出生朝向 = 南**（用户 2026-10-29：「让玩家出生的时候，面朝南方」）。
 *
 * 坐标语义（已实测，勿凭印象）：`player.js` 用 `camera.rotateY(yaw)`，
 * 故相机前向 = `(sin(-yaw), 0, -cos(yaw))`。
 *   · `yaw = 0`        → `(0,0,-1)` = **北**（−Z）
 *   · `yaw = π`        → `(0,0,+1)` = **南**（+Z）
 *   · `yaw = -π/2`     → `(+1,0,0)` = **东**（+X）
 * ⇒ 南 = `SPAWN_YAW = Math.PI`。
 *
 * ⚠️ **不能只断言 `player.yaw === Math.PI`**：那只验了一个数字，验不了「π 到底朝哪」。
 * 必须同时钉「按 W 前进的实际位移是 +Z」，两者合起来才能证明「面朝南」。
 */
test('出生朝向：面朝南（yaw = π，且按 W 的实际位移沿 +Z）', () => {
  const { player } = makeFixture();
  assertEqual(player.yaw, SPAWN_YAW, '出生 yaw 须为 SPAWN_YAW');

  // 用**真实的输入路径**（按 W → _applyInput → physics.step）验证朝向语义，
  // 而不是再算一遍三角函数（那样两边同源，改错了也测不出）。
  player.physics.pos = { x: 0, y: 10, z: 0 };
  player.keys.clear();
  player.keys.add('KeyW');
  player._applyInput();
  player.physics.step(1 / 60);
  const dz = player.physics.pos.z - 0;
  const dx = player.physics.pos.x - 0;
  assertTrue(dz > 0.01, `前进必须沿 +Z（南），实测 dz=${dz}`);
  assertTrue(Math.abs(dx) < 1e-6, `前进不得有东西向分量，实测 dx=${dx}`);

  // 侧向也一并钉：面朝南时右手边是西（−X）—— 单比前进只能证明「前后没反」，
  // 无法拓到「yaw 差了 180° 但前后恰好对调」这类错误（两者在前述断言下会同时成立）。
  player.physics.pos = { x: 0, y: 10, z: 0 };
  player.keys.clear();
  player.keys.add('KeyD');
  player._applyInput();
  player.physics.step(1 / 60);
  const dStrafe = player.physics.pos.x - 0;
  assertTrue(dStrafe < -0.01, `面南时右移必须沿 −X（西），实测 dx=${dStrafe}`);
  player.dispose();
});

test('spawn() 不改朝向（传送保留玩家当前视线）', () => {
  const { player } = makeFixture();
  player.yaw = -Math.PI / 2; // 玩家自己转到了东
  player.spawn(10, 20, 30);
  assertEqual(player.yaw, -Math.PI / 2, '传送不得重置朝向（只有初始值才是南）');
  player.dispose();
});

test('方向键与 WASD 产生相同的位移向量', () => {
  const { player } = makeFixture();
  const pairs = [['KeyW', 'ArrowUp'], ['KeyS', 'ArrowDown'], ['KeyA', 'ArrowLeft'], ['KeyD', 'ArrowRight']];
  for (const [wasd, arrow] of pairs) {
    player.keys.clear();
    player.keys.add(wasd);
    const a = stepDelta(player);
    player.keys.clear();
    player.keys.add(arrow);
    const b = stepDelta(player);
    assertEqual(round3(b.dx), round3(a.dx), `${arrow} 的 dx 须等于 ${wasd}`);
    assertEqual(round3(b.dz), round3(a.dz), `${arrow} 的 dz 须等于 ${wasd}`);
  }
  // 对照：四个方向互不相同（否则上面的「相等」可能是全零恒真）
  player.keys.clear(); player.keys.add('KeyW');
  const fwd = stepDelta(player);
  player.keys.clear(); player.keys.add('KeyA');
  const left = stepDelta(player);
  assertTrue(Math.abs(fwd.dx) > 0.01 && Math.abs(fwd.dx - left.dx) > 0.01,
    `前进与左移必须不同且非零（fwd.dx=${fwd.dx} left.dx=${left.dx}）`);
  player.dispose();
});

test('WASD 与方向键同时按下不叠加速度（取 1 而非 2）', () => {
  const { player } = makeFixture();
  player.keys.clear();
  player.keys.add('KeyW');
  const single = stepDelta(player);
  player.keys.clear();
  player.keys.add('KeyW');
  player.keys.add('ArrowUp');
  const both = stepDelta(player);
  assertEqual(round3(both.dx), round3(single.dx), '同向两键同时按下不得变成两倍速');
  // 反向组合（W + ArrowDown）互相抵消 → 位移为 0（这是「取差」的必然结果）
  player.keys.clear();
  player.keys.add('KeyW');
  player.keys.add('ArrowDown');
  const oppose = stepDelta(player);
  assertEqual(round3(oppose.dx), 0, '前进 + 方向键下 相抵');
  player.dispose();
});

test('方向键 keydown 被 preventDefault，且不影响其它按键', () => {
  const { player } = makeFixture();
  for (const code of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']) {
    assertTrue(pressKey(code), `${code} 必须 preventDefault（否则触发浏览器默认行为）`);
    releaseKey(code);
  }
  // 非方向键不得被拦（否则 F5/F12/开发者快捷键会被游戏吞掉）
  assertEqual(pressKey('KeyW'), false, 'KeyW 不 preventDefault');
  releaseKey('KeyW');
  assertEqual(pressKey('F5'), false, 'F5 不 preventDefault');
  assertEqual(pressKey('F12'), false, 'F12 不 preventDefault');
  player.dispose();
});

test('模态期间方向键不写进 keys（与 WASD 同一守卫）', () => {
  const { player } = makeFixture();
  let modal = true;
  player._isModal = () => modal;
  pressKey('ArrowUp');
  assertEqual(player.keys.size, 0, '模态期间方向键被守卫拦下');
  modal = false;
  pressKey('ArrowUp');
  assertTrue(player.keys.has('ArrowUp'), '关闭模态后方向键正常写入');
  releaseKey('ArrowUp');
  assertEqual(player.keys.has('ArrowUp'), false, 'keyup 清除');
  player.dispose();
});

// ---- 飞行键位（spec 2026-10-25-player-flight-design.md §4.4）----

test('flight: F 真实 keydown 切换飞行、再按一次切回，且不 preventDefault', () => {
  const { player } = makeFixture();
  assertEqual(pressKey('KeyF'), false, 'KeyF 不得 preventDefault（F 不是浏览器功能键）');
  releaseKey('KeyF');
  assertEqual(player.physics.flying, true, '第一次按 F 起飞');
  pressKey('KeyF');
  releaseKey('KeyF');
  assertEqual(player.physics.flying, false, '第二次按 F 退出飞行');
  player.dispose();
});

test('flight: 按住 F 不连发（repeat 事件被忽略）', () => {
  const { player } = makeFixture();
  const ev = new KeyboardEvent('keydown', { code: 'KeyF', repeat: true, cancelable: true, bubbles: true });
  window.dispatchEvent(ev);
  assertEqual(player.physics.flying, false, 'repeat 事件不得触发切换（否则按住 F 会疯狂抖动）');
  player.dispose();
});

test('flight: 模态期间 F 不切换', () => {
  const { player } = makeFixture();
  player._isModal = () => true;
  pressKey('KeyF');
  releaseKey('KeyF');
  assertEqual(player.physics.flying, false, '模态守卫须覆盖 F');
  player.dispose();
});

test('flight: 飞行时空格走垂直上升而不是跳跃', () => {
  const { player } = makeFixture();
  player.physics.toggleFlight();
  player.keys.clear();
  player.keys.add('Space');
  player._applyInput();
  assertEqual(player.physics.vel.y, FLY_VERTICAL_SPEED, '飞行中空格 → 恒定上升速度');
  assertTrue(player.physics.vel.y !== 10, '不得复用 JUMP_FORCE');
  player.dispose();
});

test('flight: Shift 下降、左右 Shift 等价、升降同按=悬停', () => {
  const { player } = makeFixture();
  player.physics.toggleFlight();
  player.keys.clear();
  player.keys.add('ShiftLeft');
  player._applyInput();
  assertEqual(player.physics.vel.y, -FLY_VERTICAL_SPEED, 'ShiftLeft 下降');
  player.keys.clear();
  player.keys.add('ShiftRight');
  player._applyInput();
  assertEqual(player.physics.vel.y, -FLY_VERTICAL_SPEED, 'ShiftRight 与左 Shift 等价');
  player.keys.clear();
  player.keys.add('Space');
  player.keys.add('ShiftLeft');
  player._applyInput();
  assertEqual(player.physics.vel.y, 0, '升降同按 = 悬停（不是互相取消成两个动作）');
  player.dispose();
});

test('flight: 不飞行时 Shift 不产生任何竖直速度（飞行分支不漏到地面态）', () => {
  const { player } = makeFixture();
  player.keys.clear();
  player.keys.add('ShiftLeft');
  player._applyInput();
  assertEqual(player.physics.vel.y, 0, '地面态按 Shift 不得产生上升/下降速度');
  player.dispose();
});

test('flight: 坐在矿车里按 F 不切换（物理步在乘坐期被跳过）', () => {
  const { player } = makeFixture();
  // 用假的乘坐 id 即可：本用例只验证 player.js 的门控，不驱动矿车物理。
  player.ridingMinecartId = 'car-1';
  pressKey('KeyF');
  releaseKey('KeyF');
  assertEqual(player.physics.flying, false, '乘坐期 F 必须无效');
  player.ridingMinecartId = null;
  pressKey('KeyF');
  releaseKey('KeyF');
  assertEqual(player.physics.flying, true, '下车后 F 恢复');
  player.dispose();
});

test('flight: 飞行态按住 Shift 时，左键矿车交互的 shift 修饰键不污染垂直输入', () => {
  // 这条钉的是「两条通道互不干扰」的结构不变量（Review Focus 3）：
  //   - 飞行高度走 `keys` 集合（ShiftLeft → moveVertical(-1)）
  //   - 矿车「后退激活」走鼠标事件的 `e.shiftKey` → digBlock({ shift: true })
  // 两者无交集。若将来有人为了「消除冲突」在 digBlock 里加飞行门控，
  // 或把 Shift 的读取从 keys 改成鼠标修饰键，这条会红。
  const { player } = makeFixture();
  player.physics.toggleFlight();
  player.keys.clear();
  player.keys.add('ShiftLeft');
  player._applyInput();
  assertEqual(player.physics.vel.y, -FLY_VERTICAL_SPEED, '前提：飞行 + Shift 时为下降速度');
  // fixture 的 target 为 null → digBlock 挥动后早退，不会写世界；这里只要求「不抛异常且不改变垂直输入」
  player.digBlock({ shift: true });
  assertEqual(player.physics.vel.y, -FLY_VERTICAL_SPEED, '矿车交互通道的 shiftKey 不得改写飞行垂直速度');
  assertEqual(player.physics.flying, true, '挖块/交互不得意外退出飞行');
  player.dispose();
});
