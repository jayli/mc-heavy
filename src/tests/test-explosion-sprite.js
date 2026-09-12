// src/tests/test-explosion-sprite.js — TNT 爆炸序列帧特效（Tier 1：帧映射纯函数）
//
// 覆盖「改坏了肉眼玩不出来」的部分：progress → 图集帧 offset 的映射，以及缩放/透明度曲线。
// mc-lite 手法是逐帧改 `texture.offset`（`ParticleSystem.js:143-149`），offset 算错会让
// 序列帧顺序错乱或恒显同一帧 —— 爆炸照常播、照常淡出，只是图案不对/不动，观感上几乎无差别。
//
// ⚠️ **GPU 是否真按这个 offset 采样，单测证明不了**（TSL 在 GPU 求值）→ 由
// `tests/explosion-sprite.spec.mjs` 的 Tier 4 像素实测兜住（帧 0 vs 帧 9 亮度须不同）。
// 本文件的职责是钉住**算术**，负向验证锚点见「offset 随 progress 变化」那条。
import { test } from './runner.js';
import { assertEqual, assertTrue } from './assert.js';
import {
  EXPLOSION_SPRITE, explosionFrameOffset, explosionFrameScale, explosionFrameOpacity,
} from '../render/explosion-sprite.js';

/** 曲线断言用 epsilon 容差：`1-((0.9-0.8)/0.2)` 实得 0.5000000000000001，严格相等会假失败 */
function assertClose(actual, expected, message = '') {
  assertTrue(Math.abs(actual - expected) < 1e-9,
    `${message}${message ? ': ' : ''}期望 ${expected}，实得 ${actual}`);
}

test('序列帧配置对齐 mc-lite ParticleSystem 爆炸层', () => {
  // mc-lite `ParticleSystem.js:27-37`：5×2 布局、寿命 0.5s、池 10
  assertEqual(EXPLOSION_SPRITE.tilesX, 5);
  assertEqual(EXPLOSION_SPRITE.tilesY, 2);
  assertEqual(EXPLOSION_SPRITE.totalFrames, 10);
  assertEqual(EXPLOSION_SPRITE.maxLifeMs, 500);
  assertEqual(EXPLOSION_SPRITE.maxActive, 10);
});

test('帧映射：progress=0 → 首帧（图集左上角）', () => {
  const o = explosionFrameOffset(0);
  assertEqual(o.done, false);
  assertEqual(o.frame, 0);
  assertEqual(o.x, 0);
  assertEqual(o.y, 0.5);   // row 0 → 1-(0+1)/2 = 0.5（图集上半行）
});

test('帧映射：progress 中点 → 第二行首帧', () => {
  // progress=0.5 → frame=floor(0.5×10)=5 → col=5%5=0、row=floor(5/5)=1
  const o = explosionFrameOffset(0.5);
  assertEqual(o.frame, 5);
  assertEqual(o.x, 0);      // col 0 → 0/5
  assertEqual(o.y, 0);      // row 1 → 1-(1+1)/2 = 0（图集下半行）
});

test('帧映射：progress=0.9 → 末帧（图集右下角）', () => {
  // frame=floor(0.9×10)=9 → col=9%5=4、row=floor(9/5)=1
  const o = explosionFrameOffset(0.9);
  assertEqual(o.frame, 9);
  assertEqual(o.x, 0.8);    // col 4 → 4/5
  assertEqual(o.y, 0);
});

test('帧映射：offset 随 progress 变化（负向锚点 —— 注入「offset 恒 0」须真 FAIL）', () => {
  // ⚠️ 只钉单点会让「offset 恒返回首帧」全绿（testing-policy §2.7 恒真陷阱）。
  // 这条断言落在**多个 progress 产出互不相同的 offset** 上。
  const seen = new Set();
  for (const p of [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]) {
    const o = explosionFrameOffset(p);
    seen.add(`${o.x},${o.y}`);
  }
  assertEqual(seen.size, 10, `10 个 progress 应产出 10 个不同 offset，实得 ${seen.size}`);
});

test('帧映射：offset.y 翻转判据（图集行序自上而下，UV 原点左下）', () => {
  // 不翻转会让上下两行颠倒（row 0 采到图集下半行）。判据 = row 0 的 y > row 1 的 y。
  const row0 = explosionFrameOffset(0.1);   // frame 1 → row 0
  const row1 = explosionFrameOffset(0.6);   // frame 6 → row 1
  assertEqual(row0.frame, 1);
  assertEqual(row1.frame, 6);
  assertTrue(row0.y > row1.y, `row0.y=${row0.y} 须大于 row1.y=${row1.y}`);
});

test('帧映射：progress≥1 视为结束（不产出越界 offset）', () => {
  // mc-lite `_updatePool`：progress≥1 → 停用，不再算 offset。
  // 若不 early-out，frame 会越界到 10 → col=0/row=2（图集只有 2 行）→ 采样到图集外。
  assertEqual(explosionFrameOffset(1).done, true);
  assertEqual(explosionFrameOffset(1.5).done, true);
});

test('帧映射：progress<1 时 frame 不越界（负向锚点 —— 注入「不 clamp」须真 FAIL）', () => {
  for (const p of [0, 0.05, 0.25, 0.45, 0.65, 0.85, 0.99]) {
    const o = explosionFrameOffset(p);
    assertEqual(o.done, false);
    assertTrue(o.frame >= 0 && o.frame < EXPLOSION_SPRITE.totalFrames,
      `progress=${p} 的 frame=${o.frame} 须落在 [0,${EXPLOSION_SPRITE.totalFrames})`);
  }
});

test('缩放曲线：3 起 8 终（mc-lite `:115` `3.0 + progress×5.0`）', () => {
  assertEqual(explosionFrameScale(0), 3);
  assertEqual(explosionFrameScale(0.5), 5.5);
  assertEqual(explosionFrameScale(1), 8);
});

test('透明度曲线：前 80% 全亮，末 20% 线性淡出（mc-lite `:118` 口径）', () => {
  assertEqual(explosionFrameOpacity(0), 1);
  assertEqual(explosionFrameOpacity(0.5), 1);
  assertEqual(explosionFrameOpacity(0.8), 1);   // 边界：仍全亮（`progress < 0.8` 是严格小于）
  assertClose(explosionFrameOpacity(0.9), 0.5, 'progress=0.9');
  assertClose(explosionFrameOpacity(0.95), 0.25, 'progress=0.95');
});

test('透明度曲线：末段确实在衰减（负向锚点 —— 注入「opacity 恒 1」须真 FAIL）', () => {
  // ⚠️ 只钉单点会让「opacity 恒 1」在前 80% 区间全绿。这条断言落在末段**单调递减**上。
  const values = [0.85, 0.9, 0.95, 0.99].map(explosionFrameOpacity);
  for (let i = 1; i < values.length; i++) {
    assertTrue(values[i] < values[i - 1],
      `opacity 须单调递减：${values[i - 1]} → ${values[i]}`);
  }
  assertTrue(values[values.length - 1] < 1, '末段 opacity 须已离开全亮');
});
