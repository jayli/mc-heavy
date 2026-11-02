// src/tests/test-zombie-model.js — 丧尸模型版式（原版人形）的纯数据契约
//
// 这里的断言全部**从 zombie-model.js 自身的导出派生**能被派生的部分（尺寸关系、UV 合法性），
// 只有「原版口径的绝对数值」写成字面量（2.0 / 0.5 / 0.75 / 0.25 / 64）—— 那是设计锁定的
// 外部事实（Minecraft 人形模型），不是被测代码的内部常量，写成字面量才有判别力。
import { test } from './runner.js';
import { assertEqual, assertTrue, assertFalse, assertDeepEqual } from './assert.js';
import {
  ZOMBIE_MODEL_PARTS, PIXEL, ZOMBIE_MODEL_DEFS, ZOMBIE_SKIN_UV, SKIN_SIZE,
  zombieModelHeight, zombieModelWidth,
} from '../render/zombie-model.js';

test('zombie-model: 1 源像素 = 1/16 格，部件集合与顺序对齐 ZOMBIE_PARTS', () => {
  assertEqual(PIXEL, 1 / 16);
  assertEqual(PIXEL, 0.0625);
  assertDeepEqual([...ZOMBIE_MODEL_PARTS],
    ['head', 'body', 'leftArm', 'rightArm', 'leftLeg', 'rightLeg']);
});

test('zombie-model: 六部件尺寸 = 原版人形口径（8³ / 8×12×4 / 4×12×4）', () => {
  // 源像素 → 格：8px = 0.5、12px = 0.75、4px = 0.25
  assertDeepEqual(ZOMBIE_MODEL_DEFS.head.size, [0.5, 0.5, 0.5]);
  assertDeepEqual(ZOMBIE_MODEL_DEFS.body.size, [0.5, 0.75, 0.25]);
  for (const arm of ['leftArm', 'rightArm']) {
    assertDeepEqual(ZOMBIE_MODEL_DEFS[arm].size, [0.25, 0.75, 0.25], arm);
  }
  for (const leg of ['leftLeg', 'rightLeg']) {
    assertDeepEqual(ZOMBIE_MODEL_DEFS[leg].size, [0.25, 0.75, 0.25], leg);
  }
});

test('zombie-model: 轴心位置 —— 头/躯干在盒中心，臂在肩、腿在髋（顶端轴心）', () => {
  const D = ZOMBIE_MODEL_DEFS;
  // 头：盒中心 y = 1.75 → 盒体 [1.5, 2.0]
  assertDeepEqual(D.head.pivot, [0, 1.75, 0]);
  assertFalse(D.head.pivotAtTop);
  // 躯干：盒中心 y = 1.125 → 盒体 [0.75, 1.5]
  assertDeepEqual(D.body.pivot, [0, 1.125, 0]);
  assertFalse(D.body.pivotAtTop);
  // 臂：肩部轴心 y = 1.5、x = ±(0.25 + 0.125) = ±0.375 → 盒体向下延伸到 0.75
  assertDeepEqual(D.leftArm.pivot, [-0.375, 1.5, 0]);
  assertDeepEqual(D.rightArm.pivot, [0.375, 1.5, 0]);
  assertTrue(D.leftArm.pivotAtTop);
  assertTrue(D.rightArm.pivotAtTop);
  // 腿：髋部轴心 y = 0.75、x = ±0.125 → 盒体向下延伸到 0
  assertDeepEqual(D.leftLeg.pivot, [-0.125, 0.75, 0]);
  assertDeepEqual(D.rightLeg.pivot, [0.125, 0.75, 0]);
  assertTrue(D.leftLeg.pivotAtTop);
  assertTrue(D.rightLeg.pivotAtTop);
});

test('zombie-model: 总高恰 2.0、脚底恰 0、水平跨度恰 1.0（原版口径）', () => {
  // **不在这里重算盒体区间**：测试若自带一份 `pivot ± size/2` 的公式，它会与实现同错同对
  // （实测踩到 —— 初版把腿的底面算成 0.375，因为腿的轴心在顶端而不是盒中心）。
  // 区间派生量走模块自己的导出；本用例只钉「原版口径的绝对数值」这几条外部事实。
  assertEqual(zombieModelHeight(), 2.0, '总高须恰 2.0（32px × 1/16）');
  assertEqual(zombieModelWidth(), 1.0, '臂外缘 x = ±0.5 → 总宽 1.0');
  // 脚底不陷地（旧模型是 -0.1，本设计修掉）：腿盒底 = 髋轴心 0.75 − 腿高 0.75 = 0
  const legDefs = ['leftLeg', 'rightLeg'].map((p) => ZOMBIE_MODEL_DEFS[p]);
  for (const d of legDefs) {
    assertTrue(d.pivotAtTop, '腿必须是顶端轴心（否则不会绕髋旋转）');
    assertEqual(d.pivot[1] - d.size[1], 0, '脚底须恰为 0（髋轴心 − 腿高）');
  }
  // 头顶 = 头盒中心 1.75 + 半高 0.25 = 2.0
  const head = ZOMBIE_MODEL_DEFS.head;
  assertFalse(head.pivotAtTop, '头是盒中心轴心');
  assertEqual(head.pivot[1] + head.size[1] / 2, 2.0, '头顶须恰为 2.0');
});

test('zombie-model: 三段竖直堆叠无缝隙（脚0~腿顶=躯干底、躯干顶=头底）', () => {
  // ⚠️ **实测踩到的无效盲区**：只断言「总高 2.0 + 脚底 0」时，把躯干高度从 0.75 改成 0.375
  // 仍然全绿 —— 头顶仍由头决定（2.0）、脚底仍由腿决定（0），中间那段缩水 0.375 无人发现，
  // 观感是「躯干和腿之间裂开一道缝」。故必须显式钉住**相邻两段的接触面**。
  const D = ZOMBIE_MODEL_DEFS;
  const legTop = D.leftLeg.pivot[1];            // 髋部轴心 = 腿盒顶
  const bodyBottom = D.body.pivot[1] - D.body.size[1] / 2;
  assertEqual(bodyBottom, legTop, '躯干底面须与腿顶面重合（不留缝、不重叠）');
  const bodyTop = D.body.pivot[1] + D.body.size[1] / 2;
  const headBottom = D.head.pivot[1] - D.head.size[1] / 2;
  assertEqual(headBottom, bodyTop, '头底面须与躯干顶面重合');
  // 臂的肩部轴心也在躯干顶面（肩在躯干最上一格）
  assertEqual(D.leftArm.pivot[1], bodyTop, '左臂肩部须在躯干顶面');
  assertEqual(D.rightArm.pivot[1], bodyTop, '右臂肩部须在躯干顶面');
});

test('zombie-model: 皮肤版式 = 标准 64×64，六部件 × 六面矩形齐全且落在图内', () => {
  assertEqual(SKIN_SIZE, 64);
  const FACES = ['px', 'nx', 'py', 'ny', 'pz', 'nz'];
  for (const part of ZOMBIE_MODEL_PARTS) {
    const uv = ZOMBIE_SKIN_UV[part];
    assertTrue(!!uv, `${part} 须有 UV 表`);
    for (const f of FACES) {
      const r = uv[f];
      assertTrue(Array.isArray(r) && r.length === 4, `${part}.${f} 须是 [u1,v1,u2,v2]`);
      for (const v of r) {
        assertTrue(Number.isFinite(v), `${part}.${f} 分量须是有限数`);
        assertTrue(v >= 0 && v <= SKIN_SIZE, `${part}.${f} 分量 ${v} 须落在 [0,${SKIN_SIZE}]`);
      }
      // 矩形必须有面积（宽高都 > 0）—— 反向书写是允许的，但不能是零面积
      assertTrue(Math.abs(r[2] - r[0]) > 0, `${part}.${f} 的 u 跨度不得为 0`);
      assertTrue(Math.abs(r[3] - r[1]) > 0, `${part}.${f} 的 v 跨度不得为 0`);
    }
  }
});

test('zombie-model: 同一部件的六面矩形互不重叠（防「六面指同一个区」这类静默错）', () => {
  // 六面共用一块矩形时，头/身/腿的所有面都是同一张图案 —— 观感是「纯色块」，
  // 但 UV 合法性断言全绿。故用重叠判据兜住。
  const FACES = ['px', 'nx', 'py', 'ny', 'pz', 'nz'];
  const norm = (r) => [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])];
  for (const part of ZOMBIE_MODEL_PARTS) {
    const rects = FACES.map((f) => ({ f, r: norm(ZOMBIE_SKIN_UV[part][f]) }));
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i].r, b = rects[j].r;
        const overlap = a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
        assertFalse(overlap, `${part}: ${rects[i].f} 与 ${rects[j].f} 的 UV 矩形不得重叠`);
      }
    }
  }
});

test('zombie-model: 反向书写的矩形被保留（不规范化成 min/max）', () => {
  // Minecraft 皮肤格式里 up/down 习惯逆序书写（如 body.up = [28,16,20,20]）。
  // 若实现把矩形规范化，这些面会被水平镜像 → 「衣服纹理左右反了」，格数与指纹全对。
  // 故显式钉住至少一处 u1 > u0、且那一处的原值逐位保留。
  const reversals = [];
  for (const part of ZOMBIE_MODEL_PARTS) {
    for (const [face, r] of Object.entries(ZOMBIE_SKIN_UV[part])) {
      if (r[2] < r[0] || r[3] < r[1]) reversals.push(`${part}.${face}`);
    }
  }
  assertTrue(reversals.length > 0, '标准皮肤版式必然含反向矩形（up/down），本表不得把它们规范化掉');
  // 逐位钉住 body 的 up（规格 §3.2 的实测值）
  assertDeepEqual(ZOMBIE_SKIN_UV.body.py, [28, 16, 20, 20]);
});
