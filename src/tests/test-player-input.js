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
import { Player } from '../player/player.js';
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
