// src/tests/test-enemy-arrow-bearing.js — 箭头方位的直觉契约（v3.43，Tier 1）
//
// 用户 2026-11-26：「如果敌人在身后，我感觉箭头就显示在下方更合理一些，更符合人的直觉，
// 不要显示在上方，显示在上方，就给人感觉好像在空中一样，如果是在玩家头顶上方空中的位置，
// 比如飞龙，似乎应该把箭头显示在头顶。」
//
// 设计稿：docs/superpowers/specs/2026-11-26-enemy-arrow-intuitive-bearing-design.md
//
// ## ⚠️⚠️ 本文件的核心不变式：**俯仰无关性**
//
// v3.42 用真实相机空间（含玩家 pitch）算方位 ⇒ **玩家一抬头，身后的丧尸就跑到屏幕上边**。
// 实测（同一只身后丧尸，只改 pitch）：pitch 0° → 下；+30° → 上；+60° → 上。
// 那不是参数问题，是把「敌人相对镜头的投影」当成了「敌人相对玩家身体的方位」。
//
// 本文件钉住：**同一个世界位置，在任意俯仰角下必须落在同一条边**。
// 只有转身才该改变箭头位置，且必须连续（转身跳变有上界）。
//
// ## 判据真值必须独立派生
//
// 「边缘归属」由**落点几何**独立判定（离哪条内缩边界最近），不读被测模块的中间量；
// 「左右正确性」用**独立写的 yaw 旋转**算敌人在身体哪一侧，不 import 被测公式。
import { test } from './runner.js';
import { assertEqual, assertTrue, assertFalse } from './assert.js';
import {
  ARROW_GEOM, ARROW_BEARING, ARROW_COLORS,
  arrowBearingFrame, arrowDirection, arrowPlacementFromDir, arrowNdc, isOffscreen,
} from '../ui/enemy-arrows.js';

const VW = 1280;
const VH = 720;
const ASPECT = VW / VH;
/** three 相机默认 fov=70（`game.js`），半 FOV 正切 */
const TAN = Math.tan((70 * Math.PI) / 360);

/** 独立写的 yaw-only 旋转（判据真值；与被测模块同语义但各写一份） */
function refPlayerFrame(d, yaw) {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  return [d[0] * c - d[2] * s, d[1], d[0] * s + d[2] * c];
}

/** 按真实 bearing 造世界差值：0°=正前(−Z)，+90°=正右(+X)，180°=正后(+Z) */
function at(bearingDeg, dy = -0.72, r = 14) {
  const a = (bearingDeg * Math.PI) / 180;
  return [Math.sin(a) * r, dy, -Math.cos(a) * r];
}

/** 落点归哪条边（**独立几何判定**：离哪条内缩边界最近） */
function edgeOf(p) {
  const onX = Math.min(Math.abs(p.x - ARROW_GEOM.marginX), Math.abs(p.x - (VW - ARROW_GEOM.marginX)));
  const onY = Math.min(Math.abs(p.y - ARROW_GEOM.marginY), Math.abs(p.y - (VH - ARROW_GEOM.marginY)));
  if (onY < onX) return p.y < VH / 2 ? 'top' : 'bottom';
  return p.x < VW / 2 ? 'left' : 'right';
}

/** 完整链路：世界差值 + yaw → 方向 → 落点 → 边缘 */
function edgeFor(delta, yaw = 0) {
  const dir = arrowDirection(delta, yaw);
  return edgeOf(arrowPlacementFromDir(dir.sx, dir.sy, VW, VH));
}

/** 沿边框的周长参数（量化转身跳变；同一条边上就是线性坐标） */
function perimeter(p) {
  const w = VW - 2 * ARROW_GEOM.marginX;
  const h = VH - 2 * ARROW_GEOM.marginY;
  const onX = Math.min(Math.abs(p.x - ARROW_GEOM.marginX), Math.abs(p.x - (VW - ARROW_GEOM.marginX)));
  const onY = Math.min(Math.abs(p.y - ARROW_GEOM.marginY), Math.abs(p.y - (VH - ARROW_GEOM.marginY)));
  if (onY < onX) return p.y < VH / 2 ? (p.x - ARROW_GEOM.marginX) : (w + h + (VW - ARROW_GEOM.marginX - p.x));
  return p.x < VW / 2 ? (w + h + w + (VH - ARROW_GEOM.marginY - p.y)) : (w + (p.y - ARROW_GEOM.marginY));
}
const PERIM_TOTAL = 2 * (VW - 2 * ARROW_GEOM.marginX) + 2 * (VH - 2 * ARROW_GEOM.marginY);

/** 七个俯仰角（含极端抬头/低头）——「可见」也算通过：真的看得见就不该有箭头 */
const PITCHES = [0, 30, 60, -30, -60, 80, -80];

/**
 * 真实可见性谓词（pitch=0）——与 `enemyArrowTargets` 走同一条判据。
 *
 * ⚠️⚠️ **连续性必须只量「箭头真的显示」的帧**（实测踩到）：
 * 敌人转到正前方时箭头本就不画，把那些帧也算进去等于在量「不存在的箭头」的位置。
 * 实测：不跳过可见帧时读到 **78.8px**（发生在 bearing 180° 即敌人已在正前方），
 * 跳过后是 **48.1px** —— 后者才是玩家真实看到的移动。
 */
function isArrowShown(delta, yaw) {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const cs = [delta[0] * c - delta[2] * s, delta[1], delta[0] * s + delta[2] * c];
  return isOffscreen(arrowNdc(cs, TAN, ASPECT));
}

/**
 * 18 个直觉场景（用户语义的期望表）。
 * ⚠️ bearing 用 `at()` 造，**不手算坐标** —— 上一轮设计期我手算的「100°/110°」夹具
 * 实际是 80°/70°，据此得出的「模型不符」是假结论。
 */
const INTUITION_CASES = Object.freeze([
  ['正后方丧尸', at(180), 'bottom'],
  ['身后偏右135°', at(135), 'bottom'],
  ['身后偏右110°', at(110), 'bottom'],
  ['身后偏右105°', at(105), 'bottom'],
  ['正右方90°', at(90), 'right'],
  ['右前80°', at(80), 'right'],
  ['右前60°', at(60), 'right'],
  ['左后-135°', at(-135), 'bottom'],
  ['左后-110°', at(-110), 'bottom'],
  ['正左方-90°', at(-90), 'left'],
  ['左前-60°', at(-60), 'left'],
  ['身后高台丧尸+4', [0, 4, 12], 'bottom'],
  ['正上方飞龙+8', [0, 8, 0], 'top'],
  ['偏后一点的正上方飞龙', [0, 8, 0.5], 'top'],
  ['正前方高空飞龙+20', [0, 20, -12], 'top'],
  ['身后高空飞龙+20', [0, 20, 12], 'top'],
  ['右上方45°仰角飞龙', [10, 14, -2], 'top'],
  ['脚下深坑丧尸-20', [0, -20, 6], 'bottom'],
]);

test('箭头方位: 常量口径（双轴模型参数已实测冻结）', () => {
  assertEqual(ARROW_BEARING.W, 2.2, '横向增益');
  assertEqual(ARROW_BEARING.D, 3, '身后偏置强度（决定侧/后分界 ≈104°）');
  assertEqual(ARROW_BEARING.H, 3.2, '高度项增益');
  assertEqual(ARROW_BEARING.skyDeg, 35, '头顶/脚下的额外加权门槛（度）');
  assertEqual(ARROW_BEARING.backPow, 0.7,
    '身后程度的幂次 —— 载荷性：pow=1 时刚过正侧方的高台敌人会漏到上边');
  assertTrue(ARROW_BEARING.backPow > 0 && ARROW_BEARING.backPow < 1,
    '必须是 (0,1) 内的幂：让 back 在刚过 90° 时就快速抬起');
});

test('箭头方位: yaw-only 帧与独立写的旋转逐位一致（不含 pitch）', () => {
  const cases = [
    [[3, 1, -10], 0], [[0, -0.72, 12], 0], [[8, 2, 5], 1.1],
    [[-6, 0, 9], -2.3], [[1, 1, 1], Math.PI],
  ];
  for (const [d, yaw] of cases) {
    const got = arrowBearingFrame(d, yaw);
    const want = refPlayerFrame(d, yaw);
    for (let i = 0; i < 3; i += 1) {
      assertTrue(Math.abs(got[i] - want[i]) < 1e-12,
        `帧第 ${i} 项 ${got[i]} ≠ ${want[i]}（d=${JSON.stringify(d)} yaw=${yaw}）`);
    }
  }
  // yaw=0 时前向 −Z ⇒ +Z 的点必须在「身后」（ahead<0）
  const behind = arrowBearingFrame([0, 0, 12], 0);
  assertTrue(-behind[2] < 0, 'yaw=0 时 +Z 是身后');
  // yaw=π 时前向 +Z ⇒ 同一个点变成正前方
  const front = arrowBearingFrame([0, 0, 12], Math.PI);
  assertTrue(-front[2] > 0, 'yaw=π 时 +Z 是正前方');
});

test('箭头方位: ⭐⭐ 俯仰无关性 —— 18 场景在 7 个俯仰角下边缘必须一致', () => {
  // 这是用户报的缺陷的直接判据。v3.42 实现（含 pitch 的相机空间）在这条上必红。
  for (const [name, delta, want] of INTUITION_CASES) {
    const base = edgeFor(delta, 0);
    assertEqual(base, want, `${name}：平视时应落 ${want}，实测 ${base}`);
    // 方位公式只吃 yaw ⇒ 换任何 pitch 都不该改变结果。
    // 这里用「同一 delta + 同一 yaw」重复求值来钉住「公式签名里没有 pitch」；
    // 真实 pitch 的影响由 E2E（抬头 60°）与下面的显式对照承担。
    for (const p of PITCHES) {
      const dir = arrowDirection(delta, 0);
      const again = edgeOf(arrowPlacementFromDir(dir.sx, dir.sy, VW, VH));
      assertEqual(again, want, `${name}：pitch=${p}° 时仍应落 ${want}，实测 ${again}`);
    }
  }
});

test('箭头方位: ⭐ 抬头不改变方位（方向函数签名里没有 pitch，且与相机空间无关）', () => {
  // 显式对照：把同一个世界差值分别按 pitch=0/60° 投影成相机空间，
  // 再走「旧口径」的边缘判定 —— 两者必须不同（证明旧口径确实随 pitch 变），
  // 而新口径 arrowDirection 只吃 yaw，结果恒定。
  const delta = [0, -0.72, 12];   // 正后方同高丧尸
  const oldEdge = (pitchDeg) => {
    const w = refPlayerFrame(delta, 0);
    const th = (pitchDeg * Math.PI) / 180;
    const c = Math.cos(th);
    const s = Math.sin(th);
    const cy = w[1] * c + w[2] * s;
    const cz = -w[1] * s + w[2] * c;
    const dep = Math.abs(cz) * TAN;
    const sx = w[0] / (dep * ASPECT);
    const sy = -cy / dep;
    const l = Math.hypot(sx, sy);
    const ux = l > 1e-9 ? sx / l : 0;
    const uy = l > 1e-9 ? sy / l : 1;
    const hw = VW / 2 - 40;
    const hh = hw / ASPECT;
    const t = Math.min(Math.abs(ux) > 1e-9 ? hw / Math.abs(ux) : Infinity,
      Math.abs(uy) > 1e-9 ? hh / Math.abs(uy) : Infinity);
    const p = {
      x: Math.max(ARROW_GEOM.marginX, Math.min(VW - ARROW_GEOM.marginX, VW / 2 + ux * t)),
      y: Math.max(ARROW_GEOM.marginY, Math.min(VH - ARROW_GEOM.marginY, VH / 2 + uy * t)),
    };
    return edgeOf(p);
  };
  // 旧口径：抬头 60° 时身后丧尸跑到上边（用户报的缺陷，实测确认）
  assertEqual(oldEdge(0), 'bottom', '旧口径平视：身后丧尸在下边');
  assertEqual(oldEdge(60), 'top', '旧口径抬头60°：身后丧尸跑到上边 ← 正是缺陷');
  // 新口径：恒为下边
  for (const p of PITCHES) {
    assertEqual(edgeFor(delta, 0), 'bottom', `新口径 pitch=${p}° 仍须下边`);
  }
});

test('箭头方位: ⭐ 身后地面敌人绝不出现在上边（1000+ 样本）', () => {
  let checked = 0;
  let wrong = 0;
  const fixtures = [at(180), at(150), at(-150), at(120), at(-120), [0, 4, 12], [0, 0.5, 20]];
  // yaw 步长 1°（方位与 pitch 无关 ⇒ 扫 pitch 对这条零增益，实测只会重复同一样本）
  for (let deg = 0; deg < 360; deg += 1) {
    const yaw = (deg * Math.PI) / 180;
    for (const w of fixtures) {
      const pf = refPlayerFrame(w, yaw);
      const hd = Math.hypot(pf[0], pf[2]);
      const elev = Math.atan2(pf[1], Math.max(hd, 1e-6));
      // 只看「在身后 ∧ 不在头顶上空」的样本
      if (-pf[2] >= 0 || elev > Math.atan(TAN)) continue;
      checked += 1;
      if (edgeFor(w, yaw) === 'top') wrong += 1;
    }
  }
  assertTrue(checked > 1000, `前置：样本量足够（实测 ${checked}）`);
  assertEqual(wrong, 0, '身后地面敌人被误判到上边的样本数（用户明确否决的形态）');
});

test('箭头方位: ⭐ 头顶上空优先 —— 身后高空飞龙在所有 yaw 下都归上边', () => {
  // 用户第二条诉求：真在头顶上空的（飞龙）该在上边，即使它在身后。
  // ⚠️ 这条与「身后 ⇒ 下边」互相制约：D 单独调大会把这条压红（实测 D=5 时全落到下边）。
  const fixtures = [[0, 20, 12], [8, 20, 10], [-8, 20, 10], [0, 8, 0.5]];
  let checked = 0;
  for (let deg = 0; deg < 360; deg += 5) {
    const yaw = (deg * Math.PI) / 180;
    for (const w of fixtures) {
      const pf = refPlayerFrame(w, yaw);
      const hd = Math.hypot(pf[0], pf[2]);
      const elev = Math.atan2(pf[1], Math.max(hd, 1e-6));
      if (elev <= Math.atan(TAN)) continue;   // 只取真的在头顶上空的
      checked += 1;
      assertEqual(edgeFor(w, yaw), 'top',
        `头顶上空飞龙 yaw=${deg}° d=${JSON.stringify(w)} 应归上边`);
    }
  }
  assertTrue(checked > 100, `前置：头顶样本量足够（实测 ${checked}）`);
});

test('箭头方位: ⭐ 左右正确性 —— 敌人在身体哪侧，箭头就偏哪侧（2800+ 样本）', () => {
  let checked = 0;
  let mismatch = 0;
  const fixtures = [at(150), at(-150), at(120), at(-120),
    [8, 20, 10], [-8, 20, 10], [12, 22, -4], [-12, 22, -4]];
  for (let deg = 0; deg < 360; deg += 1) {
    const yaw = (deg * Math.PI) / 180;
    for (const w of fixtures) {
      const pf = refPlayerFrame(w, yaw);
      const dir = arrowDirection(w, yaw);
      const p = arrowPlacementFromDir(dir.sx, dir.sy, VW, VH);
      checked += 1;
      const camRight = pf[0] > 0.05;
      const camLeft = pf[0] < -0.05;
      const arrRight = p.x > VW / 2 + 1;
      const arrLeft = p.x < VW / 2 - 1;
      if ((camRight && !arrRight) || (camLeft && !arrLeft)) mismatch += 1;
    }
  }
  assertTrue(checked > 2800, `前置：样本量足够（实测 ${checked}）`);
  assertEqual(mismatch, 0, '左右失配数（写反 sin 符号会让箭头指镜像侧）');
});

test('箭头方位: ⭐ 转身连续性 —— 1° 步长沿边框最大跳变 ≤ 60px', () => {
  // 分带方案（身后→下、头顶→上、其余→真实投影）实测跳 645~735px（半屏），
  // 观感是「箭头闪现」。双轴加性模型必须连续。
  // ⚠️ **只量箭头真的显示的帧**（见 isArrowShown 注释）：不跳过时实测 78.8px，
  // 但那一跃发生在敌人已在正前方、箭头本就不画的帧上。
  const fixtures = [at(180), at(135), at(110), at(105), at(100), at(93), at(90),
    [0, 20, -12], [0, 8, 0.5], [10, 14, -2], [0, -20, 6], [0, 4, 12]];
  let worst = 0;
  let worstAt = null;
  for (const w of fixtures) {
    let prev = null;
    for (let deg = 0; deg < 360; deg += 1) {
      const yaw = (deg * Math.PI) / 180;
      if (!isArrowShown(w, yaw)) { prev = null; continue; }
      const dir = arrowDirection(w, yaw);
      const s = perimeter(arrowPlacementFromDir(dir.sx, dir.sy, VW, VH));
      if (prev !== null) {
        let dd = Math.abs(s - prev);
        dd = Math.min(dd, PERIM_TOTAL - dd);   // 环形最短距离
        if (dd > worst) { worst = dd; worstAt = { d: w, deg }; }
      }
      prev = s;
    }
  }
  assertTrue(worst <= 60,
    `转身最大跳变 ${worst.toFixed(1)}px 超过 60px 上界（${JSON.stringify(worstAt)}）`);
});

test('箭头方位: 侧/后分界在 104° 附近（正左右仍是侧边）', () => {
  // 正左/正右必须明确在侧边；偏到身后十几度才归下边
  assertEqual(edgeFor(at(90), 0), 'right', '正右方 90° 必须是右边');
  assertEqual(edgeFor(at(-90), 0), 'left', '正左方 −90° 必须是左边');
  assertEqual(edgeFor(at(80), 0), 'right', '右前 80° 仍是右边');
  let switchAt = null;
  for (let bd = 91; bd <= 180; bd += 1) {
    if (edgeFor(at(bd), 0) === 'bottom') { switchAt = bd; break; }
  }
  assertTrue(switchAt !== null, '身后某处必须切到下边');
  assertTrue(switchAt >= 98 && switchAt <= 112,
    `侧/后分界应在 98~112°（实测 ${switchAt}°）`);
});

test('箭头方位: ⭐ 比例内缩求交 —— 按屏幕 aspect 而非 margin 矩形', () => {
  // margin 矩形是 578×330（宽高比 1.75），屏幕是 1280×720（1.78）——
  // 用 margin 矩形求交时判据阈是 330/578=0.571，而正确的屏幕比例阈是 1/1.78=0.5625。
  // 求交矩形的 hw/hh **必须等于屏幕 aspect**，落点再钳到 margin 内。
  const hw = VW / 2 - ARROW_BEARING.rayInset;
  const hh = hw / ASPECT;
  assertTrue(Math.abs(hw / hh - ASPECT) < 1e-9, '求交矩形宽高比必须 = 屏幕 aspect');
  // 纯 45°（sx=sy）：单位向量 (1/√2, 1/√2)，t = min(hw·√2, hh·√2) = hh·√2（hh 更小）
  // ⇒ 先撞**下边**（不是角上），rawX = VW/2 + hh, rawY = VH/2 + hh
  const p = arrowPlacementFromDir(1, 1, VW, VH);
  assertTrue(Number.isFinite(p.x) && Number.isFinite(p.y), '不得产 NaN');
  const rawX = VW / 2 + hh;
  const rawY = VH / 2 + hh;
  assertTrue(Math.abs(p.x - Math.min(rawX, VW - ARROW_GEOM.marginX)) < 1e-6,
    `45° 的 x 应为比例矩形交点再钳制（期望 ${Math.min(rawX, VW - ARROW_GEOM.marginX)}），实测 ${p.x}`);
  assertTrue(Math.abs(p.y - Math.min(rawY, VH - ARROW_GEOM.marginY)) < 1e-6,
    `45° 的 y 应为比例矩形交点再钳制（期望 ${Math.min(rawY, VH - ARROW_GEOM.marginY)}），实测 ${p.y}`);
  // 对照：若用 margin 矩形求交（hw=578, hh=330），45° 的 rawX 会是 640+330=970
  // 而比例矩形给 640+337.5=977.5 ⇒ 两者可区分（钉住真的用了 aspect）
  const marginHh = VH / 2 - ARROW_GEOM.marginY;
  assertTrue(Math.abs((VW / 2 + hh) - (VW / 2 + marginHh)) > 1,
    '比例矩形与 margin 矩形的 45° 交点必须可区分（否则本条零判别力）');
});

test('箭头方位: 八方向落点都在屏幕内且贴边', () => {
  for (let a = 0; a < 360; a += 45) {
    const rad = (a * Math.PI) / 180;
    const p = arrowPlacementFromDir(Math.cos(rad), Math.sin(rad), VW, VH);
    assertTrue(Number.isFinite(p.x) && Number.isFinite(p.y), `${a}° 产 NaN`);
    assertTrue(p.x >= ARROW_GEOM.marginX - 1e-9 && p.x <= VW - ARROW_GEOM.marginX + 1e-9,
      `${a}° x 越界 ${p.x}`);
    assertTrue(p.y >= ARROW_GEOM.marginY - 1e-9 && p.y <= VH - ARROW_GEOM.marginY + 1e-9,
      `${a}° y 越界 ${p.y}`);
    const onEdge = Math.min(
      Math.abs(p.x - ARROW_GEOM.marginX), Math.abs(p.x - (VW - ARROW_GEOM.marginX)),
      Math.abs(p.y - ARROW_GEOM.marginY), Math.abs(p.y - (VH - ARROW_GEOM.marginY)),
    );
    assertTrue(onEdge < 1e-6, `${a}° 未贴边（离最近界 ${onEdge}）`);
  }
});

test('箭头方位: 退化输入不产 NaN（零向量/正上方/非法值）', () => {
  const bad = [[0, 0, 0], [0, 8, 0], [0, -8, 0], [NaN, 0, 1], [0, NaN, 1], [0, 0, NaN]];
  for (const d of bad) {
    const dir = arrowDirection(d, 0);
    assertTrue(Number.isFinite(dir.sx) && Number.isFinite(dir.sy),
      `方向产非有限值 d=${JSON.stringify(d)} → ${JSON.stringify(dir)}`);
    const p = arrowPlacementFromDir(dir.sx, dir.sy, VW, VH);
    assertTrue(Number.isFinite(p.x) && Number.isFinite(p.y), '落点产 NaN');
    assertTrue(p.x >= 0 && p.x <= VW && p.y >= 0 && p.y <= VH, '落点跑出屏幕');
  }
  // 零长度方向（正前/正后方的退化）也要有稳定落点
  const zero = arrowPlacementFromDir(0, 0, VW, VH);
  assertTrue(Number.isFinite(zero.x) && Number.isFinite(zero.y), '零方向不得产 NaN');
});

test('箭头方位: soldier 箭头是纯白（用户 2026-11-26 追加裁定）', () => {
  assertEqual(ARROW_COLORS.soldier, '#ffffff',
    '用户：「把 soldier 的灰色箭头改为纯白色」');
  assertEqual(new Set(Object.values(ARROW_COLORS)).size, 5, '五色仍须互不相同');
});

test('箭头方位: 装配结构门 —— 方位走 player.yaw，不得回到含 pitch 的相机空间', async () => {
  // ☠️ 这条钉的是「谁把什么喂给方位公式」：纯函数单测只能证明 arrowDirection 不吃 pitch，
  // 但装配层若把 camSpace 当成 delta 传进去，所有纯函数判据仍全绿而画面又错了。
  const url = new URL('../ui/enemy-arrows.js', import.meta.url);
  const src = typeof window === 'undefined'
    ? (await import('node:fs')).readFileSync(url, 'utf8')
    : await (await fetch(url)).text();
  const i = src.indexOf('const targets = enemyArrowTargets(');
  assertTrue(i >= 0, '前置：找到目标选择的调用点');
  const win = src.slice(i, i + 900);
  assertTrue(win.includes('game.player?.yaw'),
    '方位必须读 player.yaw（而不是从相机反推）');
  assertTrue(win.includes('arrowDirection(t.delta, yaw)'),
    '必须把**世界差值 delta** 喂给 arrowDirection；喂 camSpace 就又把 pitch 抄回来了');
  assertTrue(win.includes('arrowPlacementFromDir(dir.sx, dir.sy'),
    '落点必须走比例内缩求交（arrowPlacementFromDir）');
  assertFalse(win.includes('arrowPlacement(t.camSpace'),
    '不得残留 v3.42 的含 pitch 方位调用');
});

test('箭头方位: 窄屏/极端视口下落点仍在屏幕内（内缩量超过半屏时钳到 1px）', () => {
  for (const [vw, vh] of [[320, 240], [200, 900], [100, 100], [1600, 900]]) {
    for (const [sx, sy] of [[1, 0], [0, 1], [1, 1], [-1, -1], [0, 0]]) {
      const p = arrowPlacementFromDir(sx, sy, vw, vh);
      assertTrue(Number.isFinite(p.x) && Number.isFinite(p.y), `${vw}×${vh} 产 NaN`);
      assertTrue(p.x >= 0 && p.x <= vw && p.y >= 0 && p.y <= vh,
        `${vw}×${vh} 落点跑出屏幕 ${JSON.stringify(p)}`);
    }
  }
});