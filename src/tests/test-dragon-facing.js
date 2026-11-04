// src/tests/test-dragon-facing.js — 飞龙机头朝向的唯一权威（v2.48）
//
// 本文件的判据都是**判别性**的（testing-policy §2.7）：只测「yaw 对」拓不到俯仰相关的缺陷，
// 所以每条都同时钉「与旧行为逐位一致」与「俯仰真的生效」两侧。
import { test } from './runner.js';
import { assertEqual, assertTrue } from './assert.js';
import {
  dragonForward, dragonRotateLocal, dragonMuzzleOffsetWorld, ZERO_PITCH,
} from '../entities/dragons/dragon-facing.js';
import { DRAGON } from '../entities/dragons/dragon-config.js';

const EPS = 1e-12;
const close = (a, b, eps = 1e-12) => Math.abs(a - b) <= eps;

/** 与 three 的 `Euler(pitch, yaw, 0, 'YXZ')` 等价的 3x3 矩阵（行主序）作用在单位前向上 */
function threeForward(yaw, pitch) {
  // three: R = Ry(yaw) · Rx(pitch) （YXZ 序 = 先绕 X 再绕 Y，作用到向量时 Ry 在最左）
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const Ry = [[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]];
  const Rx = [[1, 0, 0], [0, cp, -sp], [0, sp, cp]];
  const v = [0, 0, -1];
  const t = [Rx[0][0] * v[0] + Rx[0][1] * v[1] + Rx[0][2] * v[2],
    Rx[1][0] * v[0] + Rx[1][1] * v[1] + Rx[1][2] * v[2],
    Rx[2][0] * v[0] + Rx[2][1] * v[1] + Rx[2][2] * v[2]];
  return [Ry[0][0] * t[0] + Ry[0][2] * t[2], t[1], Ry[2][0] * t[0] + Ry[2][2] * t[2]];
}

test('机头: pitch=0 时前向与旧口径逐位一致（零回归）', () => {
  // 旧口径散落在四处注释/实现里：前向 = (−sin yaw, 0, −cos yaw)。
  // ⚠️ 必须是**逐位**（不是容差）：sin(π) 这类值用另一种等价写法会差 1 ULP，
  // 而 `Math.sin(x)*1` 与 `Math.sin(x)` 才逐位相同（cos(0)=1 的乘法恒等）。
  for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2, 1.2345, -3.0]) {
    const f = dragonForward(yaw);
    assertEqual(f[0], -Math.sin(yaw), `yaw=${yaw} 的 x 分量必须逐位等于 −sin yaw`);
    assertEqual(f[1], 0, `yaw=${yaw} 平飞时竖直分量为 0`);
    assertEqual(f[2], -Math.cos(yaw) * Math.cos(0), `yaw=${yaw} 的 z 分量必须逐位等于 −cos yaw`);
    // ZERO_PITCH 是显式导出的常量，不是魔法 0
    assertEqual(dragonForward(yaw, ZERO_PITCH)[2], f[2]);
  }
});

test('机头: 负 pitch = 低头（pitch=−π/2 + yaw=0 → 正下方）', () => {
  const down = dragonForward(0, -Math.PI / 2);
  assertTrue(close(down[1], -1), `低头 90° 应朝正下方，实际 y=${down[1]}`);
  assertTrue(close(down[0], 0) && close(down[2], 0), '朝正下方时无水平分量');
  // 正 pitch = 抬头
  const up = dragonForward(0, Math.PI / 2);
  assertTrue(close(up[1], 1), `抬头 90° 应朝正上方，实际 y=${up[1]}`);
  // 符号约定写进注释的那条：渲染层 rotation.x 同向 ⇒ 若把符号写反，这条会红
  assertTrue(dragonForward(0, -0.5)[1] < 0, '负 pitch 必须让前向朝下（与 three 的 rotation.x 同向）');
});

test('机头: 半径恒 1（任意 yaw/pitch 组合）', () => {
  for (const yaw of [0, 0.3, 1.7, 2.9, -1.1]) {
    for (const pitch of [-1.0, -0.2, 0, 0.15, 0.9]) {
      const f = dragonForward(yaw, pitch);
      const len = Math.hypot(f[0], f[1], f[2]);
      assertTrue(Math.abs(len - 1) < 1e-12, `yaw=${yaw} pitch=${pitch} 前向长度 ${len} ≠ 1`);
    }
  }
});

test('机头: 与 three 的 Euler(pitch, yaw, 0, "YXZ") 逐位一致（渲染层交叉比对）', () => {
  // ⚠️ **这条是防「两套旋转公式漂移」的唯一防线**（M8 炮塔「弹丸往天上飞」同类缺陷）：
  // 逻辑层用 dragonForward、渲染层用 pivot.rotation.set(pitch, yaw, 0, 'YXZ')。
  // 任一处的旋转顺序或轴符号写错，这里就会红。
  for (const yaw of [0, Math.PI / 2, Math.PI, -2.4]) {
    for (const pitch of [0, -0.3, -0.96, 0.2]) {
      const mine = dragonForward(yaw, pitch);
      const ref = threeForward(yaw, pitch);
      for (let i = 0; i < 3; i++) {
        assertTrue(Math.abs(mine[i] - ref[i]) < 1e-12,
          `yaw=${yaw} pitch=${pitch} 分量 ${i}: ${mine[i]} ≠ three 的 ${ref[i]}`);
      }
    }
  }
});

test('机头: 嘴部偏移的旋转与 dragonForward 同源（同一条公式）', () => {
  // 局部「向前 1 格」经同一个旋转后必须等于前向向量 —— 这是契约，不是巧合
  for (const yaw of [0, 1.1, -2.2]) {
    for (const pitch of [0, -0.6, 0.25]) {
      const r = dragonRotateLocal(yaw, pitch, [0, 0, -1]);
      const f = dragonForward(yaw, pitch);
      for (let i = 0; i < 3; i++) {
        assertTrue(Math.abs(r[i] - f[i]) < 1e-12, `local(0,0,−1) 旋转后应与前向一致（分量 ${i}）`);
      }
    }
  }
});

test('机头: 嘴部偏移 —— pitch=0 时逐位等于旧公式（零回归）', () => {
  // 旧实现（v2.45）：x' = ox·cos+z·sin、y' = oy、z' = −ox·sin+z·cos
  const [ox, oy, oz] = DRAGON.muzzleOffset;
  for (const yaw of [0, 0.7, Math.PI, -1.4]) {
    const s = Math.sin(yaw), c = Math.cos(yaw);
    const oldWay = [ox * c + oz * s, oy, -ox * s + oz * c];
    const mine = dragonMuzzleOffsetWorld(yaw, ZERO_PITCH, DRAGON.muzzleOffset);
    for (let i = 0; i < 3; i++) {
      assertTrue(Math.abs(mine[i] - oldWay[i]) < 1e-12,
        `yaw=${yaw} 分量 ${i}: ${mine[i]} ≠ 旧公式 ${oldWay[i]}`);
    }
  }
});

test('机头: 低头时嘴部位置按 pitch 下落（不是只转方向、位置不动）', () => {
  // ⚠️ 判别性用例：只把 direction 改成机头而嘴部仍按 yaw 旋转的注入，这条会红。
  const yaw = 0;
  const flat = dragonMuzzleOffsetWorld(yaw, 0, DRAGON.muzzleOffset);
  const down = dragonMuzzleOffsetWorld(yaw, -Math.PI / 3, DRAGON.muzzleOffset);
  assertTrue(down[1] < flat[1] - 0.5,
    `低头 60° 时嘴部必须明显落低（flat y=${flat[1]}，down y=${down[1]}）`);
  // z 也应变浅：低头后「向前 5.8 格」变成「向前 2.9 + 向下 5.0」
  assertTrue(Math.abs(down[2]) < Math.abs(flat[2]),
    `低头后前向投影应变短（flat z=${flat[2]}，down z=${down[2]}）`);
});

test('机头: 局部偏移的 x/y/z 语义（右/上/前）没写反', () => {
  // 纯竖直偏移（oy）在 pitch=0 时不受 yaw 影响
  for (const yaw of [0, 1.2, -2.0]) {
    const up = dragonRotateLocal(yaw, 0, [0, 3, 0]);
    assertTrue(Math.abs(up[0]) < 1e-12 && Math.abs(up[2]) < 1e-12, '竖直偏移不得被 yaw 带到水平面');
    assertEqual(up[1], 3);
  }
  // 纯前向偏移在 yaw=−π/2 时指向 +X（本仓东）
  const fwd = dragonRotateLocal(-Math.PI / 2, 0, [0, 0, -1]);
  assertTrue(fwd[0] > 0.999, `yaw=−π/2 的前方应是 +X，实际 ${JSON.stringify(fwd)}`);
});
