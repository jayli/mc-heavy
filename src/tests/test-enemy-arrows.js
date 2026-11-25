// src/tests/test-enemy-arrows.js — 屏外敌人方位箭头的几何与配色契约（Tier 1）
//
// 用户 2026-11-26：「在屏幕的四周加上指示箭头……如果敌人不在玩家的视口范围内，就给一个
// 小箭头指示敌人的位置，用不同颜色的小三角形来指示」。
// 三项裁定（`ask_user_question` 2026-11-26）：① 守卫粉红；② 每类最近一只 + 屏外计数；
// ③ 带距离读数 + 远近透明度。
//
// ⚠️ **本文件只测纯函数**（无 DOM）。「真的画出来了 / 层级 / 转视角后消失」是布局事实，
// 只能在真实浏览器里量 ⇒ 归 `tests/enemy-arrows.spec.mjs`（UI 档）。
//
// ⚠️⚠️ **最容易静默失效的两处**（本文件的判据就是为它们写的）：
//   ① **背后（cz>0）的左右方位**：公式用 `|cz|` 而不是 `cz`，前后共用一套符号。
//      写两套（背后再翻一次 sx）的形态是「箭头指向镜像侧」—— 玩家转身反方向永远找不到敌人，
//      而「箭头出现了」「颜色对了」「在屏幕内」这些判据**全绿**。
//   ② **count 口径**：必须是**屏外**总数。算全场总数的形态是「已经看得见的敌人也计进
//      还没找到」，读数偏大而且看不出因果。
import { test } from './runner.js';
import { assertEqual, assertTrue, assertDeepEqual } from './assert.js';
import {
  ARROW_COLORS, ENEMY_ARROW_ROWS, ARROW_GEOM, ARROW_ID, ARROW_BEARING,
  arrowNdc, isOffscreen, arrowDirection, arrowPlacementFromDir,
  arrowOpacity, enemyArrowTargets, spreadArrows,
} from '../ui/enemy-arrows.js';
import { ZOMBIE } from '../entities/zombies/zombie-config.js';
import { SOLDIER, SOLDIER_TYPE } from '../entities/soldiers/soldier-config.js';
import { IGNIS, IGNIS_TYPE } from '../entities/ignis/ignis-config.js';
import { GUARDIAN, GUARDIAN_TYPE } from '../entities/guardian/guardian-config.js';
import { DRAGON_TYPE } from '../entities/dragons/dragon-config.js';

/** 视口夹具：非正方形（16:9），这样 aspect 写错会被斜方向用例抓到 */
const VW = 1280;
const VH = 720;
const ASPECT = VW / VH;
/** three 相机默认 fov=70（`game.js` 的 PerspectiveCamera），半 FOV 正切 */
const TAN = Math.tan((70 * Math.PI) / 360);

/**
 * **独立写的**透视 NDC 对照式（屏幕 y 向下）。
 * ⚠️ 不 import 被测公式、不复用它的中间量 —— 两侧共用同一个错误假设会得出「一致」的假结论。
 * three 相机看 −Z ⇒ 前方 cz<0，深度 = −cz。
 */
function referenceNdc(cx, cy, cz) {
  const depth = -cz;
  return { sx: cx / (depth * TAN * ASPECT), sy: -cy / (depth * TAN) };
}

/** yaw=0（前向 −Z）时相机空间 = 世界差值（x/y/z 同向），故夹具可直接用差值当 camSpace */
const identityCam = (p) => [p[0], p[1], p[2]];

/** 造一只实体（只含本模块消费的字段） */
function ent(type, position, extra = {}) {
  return { type, state: { position, ...extra } };
}

test('敌人箭头: 五类登记与显示顺序固定（尸/兵/龙/守/焰）', () => {
  assertDeepEqual(ENEMY_ARROW_ROWS.map((r) => r.key),
    ['zombie', 'soldier', 'dragon', 'guardian', 'ignis'], '用户点名五类');
  assertEqual(ENEMY_ARROW_ROWS.length, 5);
});

test('敌人箭头: 配色 = 用户裁定的五色，且互不相同', () => {
  assertEqual(ARROW_COLORS.soldier, '#ffffff', 'soldier 纯白（用户 2026-11-26 追加裁定，原为灰）');
  assertEqual(ARROW_COLORS.zombie, '#4ade80', '丧尸 绿');
  assertEqual(ARROW_COLORS.dragon, '#a855f7', '飞龙 紫');
  assertEqual(ARROW_COLORS.ignis, '#facc15', '焰魔 黄');
  assertEqual(ARROW_COLORS.guardian, '#ff69b4', '末影守卫 粉红（用户确认「分红」= 粉红）');
  assertEqual(new Set(Object.values(ARROW_COLORS)).size, 5, '五色必须互不相同（撞色 = 分不出类型）');
});

test('敌人箭头: type 从各自 config 派生，不写字面量（改名时静默读成 0 的防线）', () => {
  const byKey = Object.fromEntries(ENEMY_ARROW_ROWS.map((r) => [r.key, r.type]));
  assertEqual(byKey.soldier, SOLDIER_TYPE);
  assertEqual(byKey.dragon, DRAGON_TYPE);
  assertEqual(byKey.guardian, GUARDIAN_TYPE);
  assertEqual(byKey.ignis, IGNIS_TYPE);
  // 丧尸类型名历史上是字面量（zombie-system.js 直接写 'zombie'），显式注明不在两处各猜一份
  assertEqual(byKey.zombie, 'zombie');
  // 每行的 color 必须与配色表同源（不是第二份色值）
  for (const r of ENEMY_ARROW_ROWS) assertEqual(r.color, ARROW_COLORS[r.key], `${r.key} 色值须同源`);
});

test('敌人箭头: 层级 52（高于血心/计数行 50，低于伤害数字 55，绝不 100+）', () => {
  assertTrue(ARROW_GEOM.zIndex > 50, '必须高于血心/计数行/看板 50（否则被它们的底色盖住）');
  assertTrue(ARROW_GEOM.zIndex < 55, '必须低于伤害数字 55（瞬时反馈优先）');
  assertTrue(ARROW_GEOM.zIndex < 100, '绝不得取 100+（会盖掉 WebGPU 启动失败遮罩）');
  assertEqual(ARROW_GEOM.zIndex, 52);
  assertTrue(ARROW_GEOM.marginX > ARROW_GEOM.marginY,
    '左右内缩必须更大：水平读数行（×3 137m）要摆在箭头内侧');
});

test('敌人箭头: 前向 NDC 与独立写的透视式逐位一致（防归一化/取反写反）', () => {
  const cases = [[3, 1, -10], [-3, 1, -10], [0.5, 0.5, -10], [-7, -4, -3], [2, 9, -20]];
  for (const [cx, cy, cz] of cases) {
    const got = arrowNdc([cx, cy, cz], TAN, ASPECT);
    const want = referenceNdc(cx, cy, cz);
    assertTrue(Math.abs(got.sx - want.sx) < 1e-12, `sx ${got.sx} ≠ ${want.sx}（cam ${cx},${cy},${cz}）`);
    assertTrue(Math.abs(got.sy - want.sy) < 1e-12, `sy ${got.sy} ≠ ${want.sy}（cam ${cx},${cy},${cz}）`);
    assertEqual(got.behind, false, 'cz<0 是前方，不得判成背后');
  }
});

test('敌人箭头: 屏外判据（NDC 超 ±1 或相机背后）', () => {
  assertEqual(isOffscreen({ sx: 0.5, sy: 0.5, behind: false }), false, '视口内不画箭头');
  assertEqual(isOffscreen({ sx: 0, sy: 0, behind: false }), false, '正前方视口中心');
  assertEqual(isOffscreen({ sx: 1.2, sy: 0, behind: false }), true, '横向出界');
  assertEqual(isOffscreen({ sx: -1.2, sy: 0, behind: false }), true, '横向出界（负侧）');
  assertEqual(isOffscreen({ sx: 0, sy: 1.2, behind: false }), true, '纵向出界');
  assertEqual(isOffscreen({ sx: 0, sy: -1.2, behind: false }), true, '纵向出界（负侧）');
  assertEqual(isOffscreen({ sx: 0, sy: 0, behind: true }), true,
    '相机背后一律屏外 —— 这正是最需要指示的情形');
});

test('敌人箭头: 背后阈值与 DamageNumbers 同口径（cz >= -0.05 即背后）', () => {
  assertEqual(arrowNdc([1, 0, -0.04], TAN, ASPECT).behind, true, '近平面内侧算背后');
  assertEqual(arrowNdc([1, 0, -0.06], TAN, ASPECT).behind, false, '略远于阈值算前方');
  assertEqual(arrowNdc([1, 0, 10], TAN, ASPECT).behind, true, '正后方');
});

test('敌人箭头: ⭐ 背后左右不镜像（v3.43 改用 yaw-only 方位）', () => {
  // ☠️ v3.42 的本用例用含 pitch 的相机空间（arrowPlacement），而那个口径已被用户证伪：
  // 玩家一抬头，身后丧尸就跑到上边。现在方位走 arrowDirection（只吃 yaw）。
  // 本用例保留「左右不镜像」这条语义，改用**世界差值**驱动。
  const place = (delta, yaw = 0) => {
    const d = arrowDirection(delta, yaw);
    return arrowPlacementFromDir(d.sx, d.sy, VW, VH);
  };
  // yaw=0 时前向 −Z ⇒ +Z 是身后；+X 是身体右侧
  const right = place([3, -0.72, 10]);
  assertTrue(right.x > VW / 2, `右后方箭头应在右半屏，实测 x=${right.x}`);
  const left = place([-3, -0.72, 10]);
  assertTrue(left.x < VW / 2, `左后方箭头应在左半屏，实测 x=${left.x}`);
  // 身后地面敌人一律在下半屏（用户 2026-11-26 裁定）
  assertTrue(right.y > VH / 2, `右后方地面敌人应在下半屏，实测 y=${right.y}`);
  assertTrue(left.y > VH / 2, `左后方地面敌人应在下半屏，实测 y=${left.y}`);
  // 头顶上空（+20 格）即使在身后也归上边
  const sky = place([0, 20, 12]);
  assertTrue(sky.y < VH / 2, `身后高空飞龙应在上半屏，实测 y=${sky.y}`);
});

test('敌人箭头: 八方向落点都贴边且在屏幕内（比例内缩求交）', () => {
  for (let a = 0; a < 360; a += 45) {
    const rad = (a * Math.PI) / 180;
    const p = arrowPlacementFromDir(Math.cos(rad), Math.sin(rad), VW, VH);
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

test('敌人箭头: 退化情形不产 NaN（可见性判据侧）', () => {
  // arrowNdc 仍用于**判可见性**（含 pitch 的真实相机空间），它的退化行为仍须守住。
  for (const cam of [[0, 0, 10], [0, 0, -10], [1, 0, 0], [0, 0, 0]]) {
    const n = arrowNdc(cam, TAN, ASPECT);
    assertTrue(Number.isFinite(n.sx) && Number.isFinite(n.sy),
      `cam ${JSON.stringify(cam)} 的 NDC 不得是 NaN/Infinity`);
  }
});

test('敌人箭头: 非正方形视口下求交矩形按屏幕比例（不是 margin 矩形）', () => {
  // ☠️ v3.42 直接与 margin 矩形（578×330）求交，宽高比 ≠ 屏幕（1280×720）
  // ⇒ 斜方向被误判。v3.43 改为比例内缩矩形 + margin 钳制。
  // 具体几何判据在 test-enemy-arrow-bearing.js（同文件不重写一份）；
  // 这里只钉「参数存在且与 margin 不同」，防有人把 rayInset 改回 marginX。
  assertTrue(ARROW_BEARING.rayInset !== ARROW_GEOM.marginX,
    '求交内缩量与读数行安全边距是两个不同职责，不得合并');
  const hw = VW / 2 - ARROW_BEARING.rayInset;
  const hh = hw / ASPECT;
  assertTrue(Math.abs(hh - (VH / 2 - ARROW_GEOM.marginY)) > 1,
    '比例矩形的半高必须与 margin 半高可区分（否则判据零判别力）');
});

test('敌人箭头: 远近透明度包络（近端实心、远端 0.35、单调不增）', () => {
  assertEqual(arrowOpacity(0), 1);
  assertEqual(arrowOpacity(ARROW_GEOM.near), 1, '16 格内实心');
  assertEqual(arrowOpacity(ARROW_GEOM.far), ARROW_GEOM.minOpacity, '160 格外恒 0.35（不消失）');
  assertEqual(arrowOpacity(1000), ARROW_GEOM.minOpacity);
  let prev = 1;
  for (let d = 0; d <= 200; d += 5) {
    const o = arrowOpacity(d);
    assertTrue(o <= prev + 1e-9, `d=${d} 时 ${o} > 前值 ${prev}`);
    assertTrue(o >= ARROW_GEOM.minOpacity && o <= 1, `d=${d} 时越界 ${o}`);
    prev = o;
  }
});

test('敌人箭头: 非法距离按最近算，不产 NaN（NaN 写进 style.opacity 会被静默忽略）', () => {
  for (const bad of [NaN, undefined, null, -5, Infinity, '37']) {
    const o = arrowOpacity(bad);
    assertTrue(Number.isFinite(o) && o >= ARROW_GEOM.minOpacity && o <= 1,
      `非法距离 ${String(bad)} 产出 ${o}`);
  }
});

test('敌人箭头: ⭐ 每类取最近一只，count = 屏外总数（不含已看得见的）', () => {
  // yaw=0（前向 −Z）：−Z 侧是前方，+Z 侧是背后
  //   屏内近处：z=−8（正前方，NDC 中心）
  //   屏外两只：z=+6（近）、z=+30（远）
  const list = [
    ent('zombie', [0, 0, -8]),
    ent('zombie', [0, 0, 6]),
    ent('zombie', [0, 0, 30]),
  ];
  const out = enemyArrowTargets(list, { x: 0, y: 0, z: 0 }, identityCam, TAN, ASPECT);
  const z = out.find((r) => r.key === 'zombie');
  assertTrue(!!z, '丧尸项必须存在');
  assertEqual(z.count, 2, 'count 必须是屏外数 2，不是全场 3');
  // 锚点是身体中心 ⇒ 距离含 height/2 的竖直分量
  const wantNear = Math.hypot(0, ZOMBIE.height / 2, 6);
  assertTrue(Math.abs(z.distance - wantNear) < 1e-9,
    `应指向较近那只（${wantNear}），实测 ${z.distance}`);
  assertTrue(z.delta[2] > 0, '指向的必须是背后那只（世界差值 +Z）');
});

test('敌人箭头: 全部在视口内时不产任何项', () => {
  const list = [ent('zombie', [0, 0, -8]), ent(SOLDIER_TYPE, [1, 0, -9])];
  const out = enemyArrowTargets(list, { x: 0, y: 0, z: 0 }, identityCam, TAN, ASPECT);
  assertEqual(out.length, 0, '视口内的敌人不该有箭头');
});

test('敌人箭头: ⭐ 士兵留尸排除（尸体仍在集合里，不过滤则「打死了箭头还在」）', () => {
  const list = [
    ent(SOLDIER_TYPE, [0, 0, 5], { dead: true }),   // 更近的尸体
    ent(SOLDIER_TYPE, [0, 0, 20]),                  // 活着的远处那只
  ];
  const out = enemyArrowTargets(list, { x: 0, y: 0, z: 0 }, identityCam, TAN, ASPECT);
  const s = out.find((r) => r.key === 'soldier');
  assertTrue(!!s, '活士兵必须有箭头');
  assertEqual(s.count, 1, '尸体不得计数');
  const want = Math.hypot(0, SOLDIER.height / 2, 20);
  assertTrue(Math.abs(s.distance - want) < 1e-9, `必须指向活的那只（${want}），实测 ${s.distance}`);
});

test('敌人箭头: 只有尸体时该项整个消失', () => {
  const out = enemyArrowTargets([ent(SOLDIER_TYPE, [0, 0, 5], { dead: true })],
    { x: 0, y: 0, z: 0 }, identityCam, TAN, ASPECT);
  assertEqual(out.length, 0);
});

test('敌人箭头: 龙是体心语义，其它四类是脚底（漏改三元链会静默偏半个身高）', () => {
  const y = 10;
  // ⚠️ v3.43 起输出携带**世界差值**（delta）而不是 camSpace：
  // 方位要用 yaw-only 帧重算，存含 pitch 的 camSpace 就又把相机朝向抄回来了。
  // 本夹具玩家在原点 ⇒ delta 的 y 就是锚点 y，判据语义不变。
  const dragon = enemyArrowTargets([ent(DRAGON_TYPE, [0, y, 20])],
    { x: 0, y: 0, z: 0 }, identityCam, TAN, ASPECT)[0];
  const zombie = enemyArrowTargets([ent('zombie', [0, y, 20])],
    { x: 0, y: 0, z: 0 }, identityCam, TAN, ASPECT)[0];
  assertTrue(Math.abs(dragon.delta[1] - y) < 1e-9, `龙锚点 y 应为 ${y}，实测 ${dragon.delta[1]}`);
  assertTrue(Math.abs(zombie.delta[1] - (y + ZOMBIE.height / 2)) < 1e-9,
    `丧尸锚点 y 应为 ${y + ZOMBIE.height / 2}，实测 ${zombie.delta[1]}`);
  assertTrue(Math.abs(dragon.delta[1] - zombie.delta[1]) > 0.5, '两种语义必须真的不同');
  // 焰魔/守卫个高，锚点偏移必须各按自己的 height（不能共用丧尸的 1.8）
  const ignis = enemyArrowTargets([ent(IGNIS_TYPE, [0, y, 20])],
    { x: 0, y: 0, z: 0 }, identityCam, TAN, ASPECT)[0];
  const guard = enemyArrowTargets([ent(GUARDIAN_TYPE, [0, y, 20])],
    { x: 0, y: 0, z: 0 }, identityCam, TAN, ASPECT)[0];
  assertTrue(Math.abs(ignis.delta[1] - (y + IGNIS.height / 2)) < 1e-9, '焰魔按自己的身高');
  assertTrue(Math.abs(guard.delta[1] - (y + GUARDIAN.height / 2)) < 1e-9, '守卫按自己的身高');
  assertTrue(Math.abs(ignis.delta[1] - guard.delta[1]) > 0.1, '焰魔与守卫身高不同');
});

test('敌人箭头: 非敌人类型不进候选（炮塔/矿车/火球/弹丸）', () => {
  const list = [
    ent('turret', [0, 0, 20]), ent('minecart', [0, 0, 20]),
    ent('fireball', [0, 0, 20]), ent('projectile', [0, 0, 20]),
    ent('cinder', [0, 0, 20]),
  ];
  assertEqual(enemyArrowTargets(list, { x: 0, y: 0, z: 0 }, identityCam, TAN, ASPECT).length, 0);
});

test('敌人箭头: 输出按登记顺序，五类同时在屏外时各占一项', () => {
  const list = [
    ent(IGNIS_TYPE, [0, 0, 20]), ent('zombie', [0, 0, 20]),
    ent(GUARDIAN_TYPE, [0, 0, 20]), ent(SOLDIER_TYPE, [0, 0, 20]),
    ent(DRAGON_TYPE, [0, 0, 20]),
  ];
  const out = enemyArrowTargets(list, { x: 0, y: 0, z: 0 }, identityCam, TAN, ASPECT);
  assertDeepEqual(out.map((r) => r.key), ['zombie', 'soldier', 'dragon', 'guardian', 'ignis'],
    '顺序 = ENEMY_ARROW_ROWS 顺序（跨类推开依赖它稳定）');
  for (const r of out) assertEqual(r.color, ARROW_COLORS[r.key]);
});

test('敌人箭头: 空集合/缺字段不抛错（装配顺序错时的纵深防御）', () => {
  assertEqual(enemyArrowTargets([], { x: 0, y: 0, z: 0 }, identityCam, TAN, ASPECT).length, 0);
  assertEqual(enemyArrowTargets([ent('zombie', null)], { x: 0, y: 0, z: 0 }, identityCam, TAN, ASPECT).length, 0);
  assertEqual(enemyArrowTargets([{ type: 'zombie' }], { x: 0, y: 0, z: 0 }, identityCam, TAN, ASPECT).length, 0);
});

test('敌人箭头: DOM id 契约（E2E 与源码同源，不写字面量）', () => {
  assertEqual(ARROW_ID, 'mc-enemy-arrows');
});

test('敌人箭头: 跨类推开 —— 同一边上不得叠在一起，且不改指向角度', () => {
  const { marginX, marginY, minGap } = ARROW_GEOM;
  // 五个都落在左竖边同一高度（模拟五类都在正左方）
  const places = ENEMY_ARROW_ROWS.map((r) => ({
    key: r.key, x: marginX, y: VH / 2, deg: 180,
  }));
  spreadArrows(places, VW, VH);
  for (let i = 1; i < places.length; i += 1) {
    assertTrue(Math.abs(places[i].y - places[i - 1].y) >= minGap - 1e-9,
      `第 ${i} 项与前一项间距 ${Math.abs(places[i].y - places[i - 1].y)} < ${minGap}`);
  }
  for (const p of places) {
    assertEqual(p.deg, 180, '推开只平移，不得改指向角度');
    assertEqual(p.x, marginX, '竖边上推开只改 y');
    assertTrue(p.y >= marginY - 1e-9 && p.y <= VH - marginY + 1e-9,
      `推完必须仍钳在内缩矩形内，实测 y=${p.y}`);
  }
});

test('敌人箭头: 跨类推开 —— 不同边/已分开的不该被动', () => {
  const { marginX, marginY } = ARROW_GEOM;
  const places = [
    { key: 'zombie', x: marginX, y: VH / 2, deg: 180 },        // 左边
    { key: 'soldier', x: VW - marginX, y: VH / 2, deg: 0 },    // 右边
    { key: 'dragon', x: VW / 2, y: marginY, deg: 270 },        // 上边
    { key: 'guardian', x: VW / 2, y: VH - marginY, deg: 90 },  // 下边
  ];
  const before = places.map((p) => ({ ...p }));
  spreadArrows(places, VW, VH);
  assertDeepEqual(places, before, '四边各一个时逐位不动');
  // 同一边但已隔得很远 ⇒ 也不动
  const far = [
    { key: 'zombie', x: marginX, y: marginY + 10, deg: 180 },
    { key: 'soldier', x: marginX, y: VH - marginY - 10, deg: 180 },
  ];
  const farBefore = far.map((p) => ({ ...p }));
  spreadArrows(far, VW, VH);
  assertDeepEqual(far, farBefore);
});

// ---------------------------------------------------------------- 装配接线结构门
//
// ⚠️ 为什么要有它：`EnemyArrows.update()` 读 `camera.matrixWorldInverse`，而该矩阵由
// `renderer.render()` 每帧重算。**接线放在 render 之前**的形态是「箭头滞后一帧」——
// 龙飞 9 格/秒时肉眼可见地甩在身后，而所有数值判据（元素存在/颜色/计数）全绿。
// 这是静态事实，Node 侧就能钉住（照 test-carbine-fx.js 的两侧读源码手法）。

/** 读源码文本（Node 走 fs，浏览器走 fetch —— 两侧都能跑，不用 node:fs 硬依赖） */
async function readSource(relFromThisDir) {
  const url = new URL(relFromThisDir, import.meta.url);
  if (typeof window === 'undefined') {
    const fs = await import('node:fs');
    return fs.readFileSync(url, 'utf8');
  }
  return (await fetch(url)).text();
}

test('敌人箭头: 装配层注入 cameraSpaceFn 并在 render 之后刷新', async () => {
  const src = await readSource('../core/game.js');
  const ctor = src.indexOf('new EnemyArrows(');
  assertTrue(ctor >= 0, 'game.js 必须构造 EnemyArrows');
  assertTrue(src.includes('matrixWorldInverse', ctor),
    '注入的相机空间函数必须走 camera.matrixWorldInverse');
  const render = src.indexOf('this.renderer.render(this.scene, this.camera)');
  const upd = src.indexOf('this._enemyArrows.update()');
  assertTrue(render >= 0, '前置：能找到主 render 调用');
  assertTrue(upd >= 0, '帧循环必须调 _enemyArrows.update()');
  assertTrue(upd > render,
    `刷新必须在 render 之后（render@${render} vs update@${upd}）—— 否则读到上一帧的相机矩阵`);
  assertTrue(src.includes('this._enemyArrows?.dispose()'), 'dispose 必须摘除箭头层');
});