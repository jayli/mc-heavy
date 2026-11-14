// src/tests/test-ignis-bake.js — 焰魔烘焙产物契约（Tier 1/2：产物是机制的地基）
//
// 产物在浏览器里 fetch（同构层不 import node 模块；`tools/ignis-fingerprint.mjs` 依赖
// node:fs，浏览器绝不能 import 它 —— AGENTS.md 已记该坑）。
//
// 判据全部是**关系式**或**实测值**（不硬编码「被测代码写入的那个值」）：
//   - 计数类从素材源自推导（骨骼/立方体数），不抄指纹模块的常量；
//   - 几何/姿态类用**实测不变量**（模型高度、命中帧姿态差）。
//
// ## 本文件守的两个「计数全对但模型是坏的」缺陷（spec Review Focus 1 与 2）
//
// 1. **漏 `T(-pivot)`**：Bedrock 的 `pivot` 是绝对模型空间坐标，cube 顶点也是绝对的。
//    骨骼变换写错时模型炸成碎片，而 53 骨骼 / 80 立方体 / 1920 顶点**全部通过**。
//    ⇒ 用 `bindPoseHeightBlocks()` 算 bind pose 下的真实包围盒高度钉住（实测 3.8346 格；v2.58 重标，见下）。
// 2. **UV 布局错**：六面矩形铺错的形态是贴图错位到邻面，而 UV 全在 [0,1]、指纹全对。
//    ⇒ 单测钉不住，靠 Tier 4 像素实测（`tests/ignis.spec.mjs`）；本文件只钉 UV 值域与
//    「每个立方体的六个面各自覆盖一个非零面积矩形」。
import { test } from './runner.js';
import { assertEqual, assertTrue } from './assert.js';
import { sampleIgnisAttack, multiplyQuat } from '../render/ignis-model.js';

let asset = null;
async function loadAsset() {
  if (asset) return asset;
  const r = await fetch(new URL('../../assets/ignis/ignis.json', import.meta.url));
  asset = await r.json();
  return asset;
}

/** 源素材（入库的 Bedrock geo 是 JSON）—— 判据从它自推导，不硬编码常量 */
let source = null;
async function loadSource() {
  if (source) return source;
  const r = await fetch(new URL('../../assets/ignis/src/ignis.geo.json', import.meta.url));
  source = await r.json();
  return source;
}

// ==================== 结构性契约 ====================

test('焰魔烘焙: 产物存在且动画清单是 idle + attack + spin + shieldSmash（第三招持盾冲撞，v3.01）', async () => {
  const d = await loadAsset();
  assertEqual(Object.keys(d.animations).sort().join(','), 'attack,idle,shieldSmash,spin');
});

// ==================== 第三招：持盾冲撞（v3.01）====================
//
// 素材鉴别（2026-11-13 实测扫描全部 82 条 ignis 动画，见 spec §2.2）：
// **`attack1`** 与 Java `SHIELD_SMASH_ATTACK` 的共有骨骼关键帧最大逐轴差 **15.000°**，
// 与已确认的对照组 `attack6a ↔ SWING_ATTACK`（12.462°）同量级；第二名 30° 已是 2 倍。
// ⚠️ **不是 `attack1_2`**（那是 3s / 11 骨骼的另一招，扫描差 72.5°）—— 键名相近，
// 写错一个字符会烘焙出另一招，而部分计数类判据可能仍通过。

/**
 * 两个四元数之间的最小夹角（度）。
 *
 * ⚠️ **本文件自带一份**（`test-ignis-render.js` 里有同名辅助，但两文件不互相 import，
 * 保持各自独立）。取 `|dot|` 是因为 q 与 −q 是同一个旋转，不取绝对值会在符号翻转处
 * 报出 ~360° 的假差。
 */
function quatAngleDeg(a, b) {
  let dot = 0;
  for (let i = 0; i < 4; i++) dot += a[i] * b[i];
  const c = Math.min(1, Math.max(0, Math.abs(dot)));
  return 2 * Math.acos(c) * 180 / Math.PI;
}

test('焰魔烘焙(v3.01): shieldSmash 帧数 = round(3.5 × 30) = 105，fps 30，驱动 9 根骨骼', async () => {
  const d = await loadAsset();
  const a = d.animations.shieldSmash;
  assertEqual(a.fps, 30);
  assertEqual(a.frameCount, 105);
  // ⚠️ 9 根是 attack1 的实测骨骼数；接成 attack1_2（11 根）会在这里红
  assertEqual(a.boneIndices.length, 9);
  assertEqual(a.frameCount / a.fps, 3.5);
});

test('焰魔烘焙(v3.01): shieldSmash 是举盾过顶再压下 —— left_arm_joint 绕 X 行程 ≥ 60°', async () => {
  const d = await loadAsset();
  const a = d.animations.shieldSmash;
  const idx = d.bones.findIndex((b) => b.name === 'left_arm_joint');
  const slot = a.boneIndices.indexOf(idx);
  assertTrue(slot >= 0, 'shieldSmash 没有驱动 left_arm_joint（盾臂）—— 接错动画了');
  // 取 t=1.0（蓄力到位，素材 −30°）与 t=1.75（砸下，素材 +35°）两帧的增量四元数夹角
  const quatAt = (t) => {
    const f = Math.round(t * a.fps);
    const o = (f * a.boneIndices.length + slot) * 7;
    return [a.frames[o], a.frames[o + 1], a.frames[o + 2], a.frames[o + 3]];
  };
  const swingDeg = quatAngleDeg(quatAt(1.0), quatAt(1.75));
  // ⚠️ 判据落在盾臂行程，不是 root.y 幅度：持盾冲撞 root.y 只到 30°，
  // 用「root 转角大」会把它误判成小横扫（spec §6.3）
  assertTrue(swingDeg >= 60,
    `盾臂行程只有 ${swingDeg.toFixed(1)}°（< 60°）—— 接成了别的动画`);
  assertTrue(swingDeg <= 90,
    `盾臂行程 ${swingDeg.toFixed(1)}° 超过 90°（素材实测 65°，接错动画？）`);
});

test('焰魔烘焙(v3.01): shieldSmash 的命中帧（tick 34）落在动画内', async () => {
  const d = await loadAsset();
  const a = d.animations.shieldSmash;
  // Java 在 tick 34 结算 ⇒ 1.70s ⇒ 第 round(1.70 × 30) = 51 帧，必须 < 105
  const hitFrame = Math.round(1.70 * a.fps);
  assertEqual(hitFrame, 51);
  assertTrue(hitFrame < a.frameCount,
    `命中帧 ${hitFrame} 超出动画帧数 ${a.frameCount} —— 结算时动画已播完`);
});

// ==================== 第二招：整圈旋斩（v2.75）====================
//
// 素材鉴别（2026-11-07 实测，不是按名字猜）：38 tick 在 `ignis.animation.json` 里有 4 条候选，
// 只有 **`attack8a3`** 在 t=0.0 与 t=0.5 的九根骨骼上与 Java `SPIN_ATTACK` 非破盾分支**逐位相等**。
// `attack8b3` 是同一招的破盾变体、`attack8a2/b2` 是 `HORIZONTAL_SMALL_SWING_ALT_ATTACK2`。
// 故本文件的判据直接用**素材 `attack8a3` 的关键帧**做独立复算，不引用烘焙器的常量。

test('焰魔烘焙(v2.75): spin 是整圈旋斩 —— root.y 净转角 > 270°（误接成小横扫会红）', async () => {
  const d = await loadAsset();
  const spin = d.animations.spin;
  const rootIdx = d.bones.findIndex((b) => b.name === 'root');
  const slot = spin.boneIndices.indexOf(rootIdx);
  assertTrue(slot >= 0, 'spin 动画没有驱动 root 骨骼');

  // 把增量四元数读成绕 Y 的有符号角度（值域 (−360°, 360°]）。
  // ⚠️ **不能用 `2·atan2(y,w)` 后逐帧累加短弧**：这一招的轨迹是「−75° → 357.5° →
  // 回落到 −2.5°」，即**转一圈又转回来一半** ⇒ 净转角只有 **74.9°**（实测），
  // 用它做判据会把整圈旋斩误判成小横扫。正确的量是「**扫过的最大跨度**」：
  // unwrap 后 `max − min`（实测 **432.5°**）。
  const yawOf = (f) => {
    const o = (f * spin.boneIndices.length + slot) * 7;
    const [, y, , w] = [spin.frames[o], spin.frames[o + 1], spin.frames[o + 2], spin.frames[o + 3]];
    // 用半角展开（`atan2` 的值域 (−π, π] ⇒ 角度 (−360°, 360°]），这样每帧步进远小于 180°
    // （实测最大 48.9°），不会在 180° 附近被折叠。
    return 2 * Math.atan2(y, w) * 180 / Math.PI;
  };
  const unwrapped = [];
  for (let f = 0; f < spin.frameCount; f++) {
    const cur = yawOf(f);
    if (f === 0) { unwrapped.push(cur); continue; }
    let diff = cur - yawOf(f - 1);
    while (diff > 180) diff -= 360;
    while (diff < -180) diff += 360;
    unwrapped.push(unwrapped[f - 1] + diff);
  }
  const span = Math.max(...unwrapped) - Math.min(...unwrapped);
  assertTrue(span > 270,
    `spin 的 root 扫过总跨度只有 ${span.toFixed(1)}°（< 270°）—— 接错动画了`
    + '（attack8a1 那类小横扫只走 ~72°；整圈旋斩实测 432.5°）');
  // 上界也要钉：> 720° 意味着接了两圈或叠了重复帧
  assertTrue(span < 720, `spin 的扫过总跨度 ${span.toFixed(1)}° 超过两圈（接了别的动画？）`);
  // 形态：必须真的绕过身侧 —— 至少有一帧角度落在背面区间（|角| > 120°），
  // 否则「绕到背后躲」这个玩法变成奢谈（实测峰值 357.5°）。
  const peak = Math.max(...unwrapped.map((v) => Math.abs(((v % 360) + 540) % 360 - 180)));
  assertTrue(peak > 120,
    `spin 的最大偏离角只有 ${peak.toFixed(1)}°（< 120°）—— 剑没绕过身侧，不是整圈旋斩`);
});

test('焰魔烘焙(v2.75): spin 时长 = 38 tick / 20 = 1.9 秒（Java SPIN_ATTACK 的 Animation.create(38)）', async () => {
  const d = await loadAsset();
  const spin = d.animations.spin;
  const duration = spin.frameCount / spin.fps;
  assertTrue(Math.abs(duration - 1.9) < 1e-6, `spin duration ${duration} ≠ 1.9 秒`);
  // 与素材的 animation_length 对账（素材是唯一权威）
  const anims = await (await fetch(new URL('../../assets/ignis/src/ignis.animation.json', import.meta.url))).json();
  const src = anims.animations['animation.null.ignis.attack8a3'];
  assertTrue(Math.abs(Number(src.animation_length) - 1.9) < 1e-9,
    `素材 attack8a3 的 animation_length ${src.animation_length} ≠ 1.9`);
});

test('焰魔烘焙(v2.75): spin 的起手姿态 = 素材 attack8a3 的 t=0（剑横持 sword.x=180°）', async () => {
  const d = await loadAsset();
  const spin = d.animations.spin;
  const swordIdx = d.bones.findIndex((b) => b.name === 'sword');
  assertTrue(swordIdx >= 0, '产物里没有 sword 骨骼');
  const slot = spin.boneIndices.indexOf(swordIdx);
  assertTrue(slot >= 0, 'spin 动画没有驱动 sword 骨骼（素材 attack8a3 驱动它到 180°）');
  const o = (0 * spin.boneIndices.length + slot) * 7;
  const [x, y, z, w] = [spin.frames[o], spin.frames[o + 1], spin.frames[o + 2], spin.frames[o + 3]];
  // 起手关键帧 `sword.rotation = [180, 0, 0]` ⇒ 绕 X 转 180° ⇒ q = (1, 0, 0, ~0)
  assertTrue(Math.abs(Math.abs(x) - 1) < 1e-3,
    `spin 首帧 sword 的增量四元数 x=${x.toFixed(4)}（期望 ±1，即绕 X 180° 的横持姿态）`
    + ` —— 接错动画的形态（attack6a 的 sword 首帧是单位四元数）`);
  assertTrue(Math.abs(y) < 1e-3 && Math.abs(z) < 1e-3, `spin 首帧 sword 的 y/z 分量应为 0，实得 ${y}, ${z}`);
  assertTrue(Math.abs(w) < 1e-3, `spin 首帧 sword 的 w=${w.toFixed(4)}（180° 旋转的 w 应为 0）`);
});

test('焰魔烘焙: 骨骼数 = 素材骨骼数（漏骨骼 ⇒ 静默缺肉）', async () => {
  const d = await loadAsset();
  const s = await loadSource();
  const srcBones = s['geometry.null.ignis'].bones;
  assertEqual(d.bones.length, srcBones.length);
});

test('焰魔烘焙: 骨骼层级完整（parentIndex 恒指向更早的下标，根恒为 0 个）', async () => {
  const d = await loadAsset();
  let roots = 0;
  for (let i = 0; i < d.bones.length; i++) {
    const p = d.bones[i].parentIndex;
    if (p === -1) { roots++; continue; }
    assertTrue(p >= 0 && p < i, `${d.bones[i].name} 的 parentIndex ${p} 不早于自身 ${i}`);
  }
  assertEqual(roots, 1);   // 唯一根 = root
});

test('焰魔烘焙: 顶点/索引数 = 烘焙立方体数 × 24 / 36', async () => {
  const d = await loadAsset();
  const s = await loadSource();
  // 从源素材自推导：含 0 尺寸分量的立方体被跳过
  let baked = 0;
  for (const b of s['geometry.null.ignis'].bones) {
    for (const c of b.cubes || []) {
      if (c.size[0] !== 0 && c.size[1] !== 0 && c.size[2] !== 0) baked++;
    }
  }
  assertEqual(d.geometry.position.length / 3, baked * 24);
  assertEqual(d.geometry.index.length, baked * 36);
  // 与度量字段一致（两处都是「素材事实」）
  assertEqual(d.metrics.bakedCubes, baked);
  assertEqual(d.metrics.cubeCount - d.metrics.skippedCubes, baked);
});

test('焰魔烘焙: 全部 UV 落在 [0,1] 内，且法线是单位向量', async () => {
  const d = await loadAsset();
  for (const v of d.geometry.uv) {
    assertTrue(v >= 0 && v <= 1, `uv 越界 ${v}`);
  }
  const n = d.geometry.normal;
  for (let i = 0; i < n.length; i += 3) {
    const len = Math.hypot(n[i], n[i + 1], n[i + 2]);
    assertTrue(Math.abs(len - 1) < 1e-4, `法线长度 ${len}`);
  }
});

test('焰魔烘焙: 索引全部在顶点范围内', async () => {
  const d = await loadAsset();
  const vcount = d.geometry.position.length / 3;
  for (const i of d.geometry.index) {
    assertTrue(i >= 0 && i < vcount, `索引越界 ${i} / ${vcount}`);
  }
});

test('焰魔烘焙: skinIndex 全部是合法骨骼下标（刚性绑定）', async () => {
  const d = await loadAsset();
  const si = d.geometry.skinIndex;
  for (let i = 0; i < si.length; i += 4) {
    assertTrue(si[i] >= 0 && si[i] < d.bones.length, `skinIndex[${i}] = ${si[i]}`);
    // 余下三个权重槽必须是 0（每顶点只绑一根骨骼）
    assertEqual(si[i + 1], 0); assertEqual(si[i + 2], 0); assertEqual(si[i + 3], 0);
  }
});

test('焰魔烘焙: bindQuaternion 归一化，localPosition 有限', async () => {
  const d = await loadAsset();
  for (const b of d.bones) {
    const [x, y, z, w] = b.bindQuaternion;
    assertTrue(Math.abs(Math.hypot(x, y, z, w) - 1) < 1e-6, `${b.name} 四元数未归一化`);
    for (const v of b.localPosition) assertTrue(Number.isFinite(v), `${b.name} localPosition 非有限`);
  }
});

// ==================== 盾牌可见性（v2.83，用户 2026-11-08 缺陷）====================
//
// 用户报告：「游戏里没见到焰魔携带盾牌」。根因：盾的几何/骨骼/UV 全在产物里，但**主贴图里
// 没有盾的像素** —— 盾的 UV 落在 `ignis_idle_0.png` 的一块全透明区域，而盾自己的像素在
// `ignis_shield.png`（原 Mod 的盾是独立 render controller，用第二张贴图）。
// 缺了它：材质 `alphaTest: 0.5` 把每个盾面判为透明丢弃 ⇒ 盾画了却一个像素也看不见，
// 而**所有结构判据（骨骼数/顶点数/UV 值域）全部通过** —— 这正是需要内容级断言的原因。
//
// 判据口径：在产物 PNG 上按三角面采样 alpha，钉**上下界**（AGENTS.md：只钉「有内容」抓不到
// 「涂成一片」）。实测：盾骨骼 74.8%，身体 73.3%。

/** 产物的贴图像素（RGBA）—— 浏览器里用 createImageBitmap + canvas 读（同 test-iso-icon） */
let texPixels = null;
async function loadTexturePixels() {
  if (texPixels) return texPixels;
  const blob = await (await fetch(new URL('../../assets/ignis/ignis.png', import.meta.url))).blob();
  const bmp = await createImageBitmap(blob);
  const cv = document.createElement('canvas');
  cv.width = bmp.width; cv.height = bmp.height;
  const ctx = cv.getContext('2d');
  ctx.drawImage(bmp, 0, 0);
  texPixels = { d: ctx.getImageData(0, 0, bmp.width, bmp.height).data, w: bmp.width, h: bmp.height };
  return texPixels;
}

/**
 * 在 `[0,1]` UV 处采样产物的 alpha。
 *
 * ⚠️ **行号是 `(1 − v) × H`**：产物 UV 的 v 是 three 口径（`v_three = 1 − v_px/textureSize`），
 * 运行时 `TextureLoader.flipY = true` 再翻一次 ⇒ 文件里落回 `v_px`。烘焙器与门禁用同一换算。
 */
function texAlpha(tex, u, v) {
  const x = Math.min(tex.w - 1, Math.max(0, Math.floor(u * tex.w)));
  const y = Math.min(tex.h - 1, Math.max(0, Math.floor((1 - v) * tex.h)));
  return tex.d[(y * tex.w + x) * 4 + 3];
}

/** 对某类骨骼的所有三角面在其 UV 三角形内采样，返回不透明比例 */
function sampleTriangles(d, tex, boneFilter) {
  const { uv, skinIndex, index } = d.geometry;
  const names = d.bones.map((b) => b.name);
  const S = 4;   // 每边采样数（三角形内 15 个点）
  let opaque = 0, total = 0;
  for (let t = 0; t < index.length; t += 3) {
    const vs = [index[t], index[t + 1], index[t + 2]];
    if (!boneFilter(names[skinIndex[vs[0] * 4]])) continue;
    const tri = vs.map((v) => [uv[v * 2], uv[v * 2 + 1]]);
    for (let i = 0; i <= S; i++) {
      for (let k = 0; k <= S - i; k++) {
        const s = i / S, q = k / S, r = 1 - s - q;
        total++;
        if (texAlpha(tex, tri[0][0] * r + tri[1][0] * s + tri[2][0] * q,
          tri[0][1] * r + tri[1][1] * s + tri[2][1] * q) > 128) opaque++;
      }
    }
  }
  return { ratio: total > 0 ? opaque / total : 0, opaque, total };
}

test('焰魔烘焙(v2.83 盾牌): 盾骨骼的 UV 在成片贴图上有不透明覆盖（缺盾贴图 ⇒ 0%）', async () => {
  const d = await loadAsset();
  const tex = await loadTexturePixels();
  // 前提：盾的骨骼与顶点确实在产物里（不是「盾被删了所以测不到」）
  const shieldBones = d.bones.filter((b) => /^shield/.test(b.name)).map((b) => b.name);
  assertTrue(shieldBones.length >= 4,
    `产物里盾骨骼只有 ${shieldBones.length} 根（期望 ≥4：shield_root/shield/shield_right/shield_left）`);
  const r = sampleTriangles(d, tex, (n) => /^shield/.test(n));
  assertTrue(r.total > 0, '盾没有贡献任何三角面 —— 几何丢了，不是贴图问题');
  // 下界：盾必须真的有像素（缺盾贴图时实测 0%）
  assertTrue(r.ratio > 0.40,
    `盾的 UV 不透明率 ${(100 * r.ratio).toFixed(1)}% ≤ 40% —— `
    + '盾贴图没合成进产物（形态：结构全对、游戏里看不见盾）');
  // 上界：钉住「整体被涂满」（真实盾有镂空/边缘，不该是纯实心）
  assertTrue(r.ratio < 0.95,
    `盾的 UV 不透明率 ${(100 * r.ratio).toFixed(1)}% ≥ 95% —— 盾被涂成一片实心，合成口径错了`);
});

test('焰魔烘焙(v2.83 盾牌): 合成没污染身体 —— 非盾骨骼的 UV 区域不含盾贴图像素', async () => {
  const d = await loadAsset();
  const tex = await loadTexturePixels();
  // 身体整体：必须大部分有内容（否则说明主贴图被盾图洗掉了）
  const body = sampleTriangles(d, tex, (n) => !/^shield/.test(n));
  assertTrue(body.total > 0, '非盾骨骼没有三角面');
  assertTrue(body.ratio > 0.55,
    `身体 UV 不透明率 ${(100 * body.ratio).toFixed(1)}% ≤ 55% —— 主贴图内容丢了`);

  // 逐个「盾以外」的骨骼：不透明率不得比主贴图基线高一截
  // （合成把盾图涂到身体上时，那一块的不透明率会显著上升）
  const names = d.bones.map((b) => b.name);
  const seen = new Set();
  for (let t = 0; t < d.geometry.index.length && d.geometry.index.length > 0; t += 3) {
    const bi = d.geometry.skinIndex[d.geometry.index[t] * 4];
    seen.add(bi);
  }
  // ⚠️ 上界只管「明显异常」：真实身体骨骼的不透明率在 44%~87%（实测），全部 < 95%
  for (const bi of seen) {
    const name = names[bi];
    if (/^shield/.test(name)) continue;
    const r = sampleTriangles(d, tex, (n) => n === name);
    assertTrue(r.ratio < 0.95,
      `${name} 的 UV 不透明率 ${(100 * r.ratio).toFixed(1)}% ≥ 95%`
      + ' —— 疑似被盾贴图涂满（合成口径写成了「整张覆盖」而不是「逐像素 alpha>0」）');
  }
});

// ==================== Review Focus 1：模型没炸开 ====================

/**
 * bind pose 下模型的实际包围盒高度（格）。
 *
 * 把每根骨骼的 `localPosition` + `bindQuaternion` 按层级累乘成世界矩阵，
 * 再把每根骨骼名下的几何顶点变换过去取 y 跨度。
 *
 * ⚠️ **这是本文件最重要的断言**：`geometry.position` 存的是**绝对模型空间**坐标
 * （烘焙期不乘骨骼矩阵），所以只有经过骨骼层级变换后才能真正验证「烘焙的 localPosition
 * 是对的」。漏掉 `T(-pivot)` 的烘焙会在这里算出数倍于 4 格的高度。
 *
 * @returns {number} 高度（格）
 */
function bindPoseHeightBlocks(d) {
  // 骨骼下标 → 世界矩阵（4x4 行主序）
  const mats = d.bones.map(() => null);
  const mul = (a, b) => {
    const o = new Array(16);
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 4; c++) {
        let s = 0;
        for (let k = 0; k < 4; k++) s += a[r * 4 + k] * b[k * 4 + c];
        o[r * 4 + c] = s;
      }
    }
    return o;
  };
  const quatToMat = (q, t) => {
    const [x, y, z, w] = q;
    const xx = x * x, yy = y * y, zz = z * z;
    const xy = x * y, xz = x * z, yz = y * z;
    const wx = w * x, wy = w * y, wz = w * z;
    return [
      1 - 2 * (yy + zz), 2 * (xy - wz), 2 * (xz + wy), t[0],
      2 * (xy + wz), 1 - 2 * (xx + zz), 2 * (yz - wx), t[1],
      2 * (xz - wy), 2 * (yz + wx), 1 - 2 * (xx + yy), t[2],
      0, 0, 0, 1,
    ];
  };
  const apply = (m, p) => [
    m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3],
    m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7],
    m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11],
  ];

  for (let i = 0; i < d.bones.length; i++) {
    const b = d.bones[i];
    const local = quatToMat(b.bindQuaternion, b.localPosition);
    mats[i] = b.parentIndex === -1 ? local : mul(mats[b.parentIndex], local);
  }

  // 每个顶点属于哪根骨骼：从 skinIndex 反查
  const vcount = d.geometry.position.length / 3;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let v = 0; v < vcount; v++) {
    const bone = d.geometry.skinIndex[v * 4];
    const p = [d.geometry.position[v * 3], d.geometry.position[v * 3 + 1], d.geometry.position[v * 3 + 2]];
    const w = apply(mats[bone], p);
    if (w[1] < minY) minY = w[1];
    if (w[1] > maxY) maxY = w[1];
  }
  return maxY - minY;
}

// ⚠️ **v2.58 重标（不是放宽）**：本组 bind pose 尺寸曾冻结为 4.0668 × 3.7329 × 5.1576，那是在**错误旋转约定**
// （`Euler('XYZ')`，见下方「v2.58 旋转约定」一节）下的实测值。
// 重标依据是**独立来源**：`node tools/ignis-java-reference.mjs` 直接解析 Java 源码的 80 个非零立方体、按 Java 语义
// 求 bind pose 包围盒 = **4.8796 × 3.8346 × 5.1576 格**（宽×高×深），与修正后的产物逐位一致
// （手臂外撇使宽 +1.17、角向后掠使高 −0.23；深度由剑长决定，未变）。容差保持原值。
test('焰魔烘焙: bind pose 的真实高度 ≈ 3.83 格（漏 T(-pivot) 会炸开数倍）', async () => {
  const d = await loadAsset();
  const h = bindPoseHeightBlocks(d);
  // 实测 3.8346 格（全模型含角与肩甲；与 Java 源码独立复算一致）。容差 0.05 格够容纳浮点与「某个膨胀件差一点点」。
  assertTrue(Math.abs(h - 3.8346) < 0.05, `bind pose 高度 ${h.toFixed(4)}，期望 ≈3.8346`);
});

test('焰魔烘焙: bind pose 的水平跨度合理（宽 ≈4.88 / 深 ≈5.16 格）', async () => {
  const d = await loadAsset();
  const mats = [];
  const mul = (a, b) => {
    const o = new Array(16);
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 4; c++) {
        let s = 0;
        for (let k = 0; k < 4; k++) s += a[r * 4 + k] * b[k * 4 + c];
        o[r * 4 + c] = s;
      }
    }
    return o;
  };
  const quatToMat = (q, t) => {
    const [x, y, z, w] = q;
    const xx = x * x, yy = y * y, zz = z * z;
    const xy = x * y, xz = x * z, yz = y * z;
    const wx = w * x, wy = w * y, wz = w * z;
    return [
      1 - 2 * (yy + zz), 2 * (xy - wz), 2 * (xz + wy), t[0],
      2 * (xy + wz), 1 - 2 * (xx + zz), 2 * (yz - wx), t[1],
      2 * (xz - wy), 2 * (yz + wx), 1 - 2 * (xx + yy), t[2],
      0, 0, 0, 1,
    ];
  };
  for (let i = 0; i < d.bones.length; i++) {
    const b = d.bones[i];
    const local = quatToMat(b.bindQuaternion, b.localPosition);
    mats[i] = b.parentIndex === -1 ? local : mul(mats[b.parentIndex], local);
  }
  const vcount = d.geometry.position.length / 3;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let v = 0; v < vcount; v++) {
    const m = mats[d.geometry.skinIndex[v * 4]];
    const p = [d.geometry.position[v * 3], d.geometry.position[v * 3 + 1], d.geometry.position[v * 3 + 2]];
    const x = m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3];
    const z = m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  const w = maxX - minX;
  const dep = maxZ - minZ;
  assertTrue(Math.abs(w - 4.8796) < 0.1, `宽度 ${w.toFixed(4)}，期望 ≈4.8796`);
  assertTrue(Math.abs(dep - 5.1576) < 0.1, `深度 ${dep.toFixed(4)}，期望 ≈5.1576`);
});

// ==================== 动画契约 ====================

test('焰魔烘焙: idle 帧数 60，且 duration 逐位等于表达式周期（接缝恒 0）', async () => {
  const d = await loadAsset();
  const a = d.animations.idle;
  // v2.56：度制修正后周期从 0.049s 变成 2.8125s（57 倍长）⇒ 帧数 12 → 60（每帧 2.13°）
  assertEqual(a.frameCount, 60);
  // ⚠️ fps 必须是非整数（12 / 2π/128 ≈ 244.46）。取整会破坏「duration ≡ 周期」
  assertTrue(a.fps !== Math.round(a.fps), `fps ${a.fps} 被取整了`);
  const duration = a.frameCount / a.fps;
  // 度制周期 = 360/128（不是 2π/128 —— 那是弧度的算法，v2.56 修正）
  assertTrue(Math.abs(duration - 360 / 128) < 1e-12,
    `duration ${duration} ≠ 360/128`);
});

test('焰魔烘焙: attack 帧数 = round(2.75 × 30)，fps 30', async () => {
  const d = await loadAsset();
  const a = d.animations.attack;
  assertEqual(a.fps, 30);
  assertEqual(a.frameCount, Math.round(2.75 * 30));
});

test('焰魔烘焙: 两条动画的 frames 扁平数组长度自洽', async () => {
  const d = await loadAsset();
  for (const [name, a] of Object.entries(d.animations)) {
    assertEqual(a.frames.length, a.frameCount * a.boneIndices.length * 7, `${name} frames 长度`);
    // 每帧 7 个数 = 四元数 xyz w + 位移 xyz
    assertTrue(a.boneIndices.every((i) => i >= 0 && i < d.bones.length), `${name} boneIndices 越界`);
    for (let i = 1; i < a.boneIndices.length; i++) {
      assertTrue(a.boneIndices[i] > a.boneIndices[i - 1], `${name} boneIndices 非严格升序`);
    }
  }
});

test('焰魔烘焙: 动画四元数全部归一化', async () => {
  const d = await loadAsset();
  for (const [name, a] of Object.entries(d.animations)) {
    for (let o = 0; o < a.frames.length; o += 7) {
      const len = Math.hypot(a.frames[o], a.frames[o + 1], a.frames[o + 2], a.frames[o + 3]);
      assertTrue(Math.abs(len - 1) < 1e-5, `${name} 帧 ${o / 7} 四元数长度 ${len}`);
    }
  }
});

test('焰魔烘焙: idle 覆盖 generala + generalb 的全部骨骼（手臂 + root + head）', async () => {
  const d = await loadAsset();
  const names = d.animations.idle.boneIndices.map((i) => d.bones[i].name).sort();
  // 素材 generala 驱动 left_arm/left_hand/right_arm/right_hand，
  //      generalb 驱动 root/head —— 合并后必须都在
  for (const need of ['left_arm', 'left_hand', 'right_arm', 'right_hand', 'root', 'head']) {
    assertTrue(names.includes(need), `idle 缺骨骼 ${need}（现有 ${names.join(',')}）`);
  }
});

test('焰魔烘焙: idle 的手臂摆动幅度符合表达式（±2.5° ⇒ 峰峰 5°）', async () => {
  const d = await loadAsset();
  const a = d.animations.idle;
  const idx = a.boneIndices.indexOf(d.bones.findIndex((b) => b.name === 'left_arm'));
  assertTrue(idx >= 0, 'idle 未驱动 left_arm');
  // ⚠️ **必须取带符号角（`2·atan2(z, w)`），不能用 `2·atan2(|xyz|, w)`**：
  // 后者是「旋转量」恒非负，会把 −2.5° 和 +2.5° 算成同一个值 → 峰峰只剩 2.5°
  // （实测踩到：烘焙是对的，断言把自己算错了）。left_arm 的表达式在 z 轴。
  let minDeg = Infinity;
  let maxDeg = -Infinity;
  for (let f = 0; f < a.frameCount; f++) {
    const o = (f * a.boneIndices.length + idx) * 7;
    const deg = 2 * Math.atan2(a.frames[o + 2], a.frames[o + 3]) * 180 / Math.PI;
    if (deg < minDeg) minDeg = deg;
    if (deg > maxDeg) maxDeg = deg;
  }
  // 表达式振幅 2.5° ⇒ 峰峰 5.0°。
  assertTrue(Math.abs((maxDeg - minDeg) - 5.0) < 0.05,
    `left_arm 峰峰摆幅 ${(maxDeg - minDeg).toFixed(4)}°（期望 5.0）`);
  // 首帧必须在 0（表达式 sin(0)=0），否则意味着相位错位
  const firstDeg = 2 * Math.atan2(a.frames[idx * 7 + 2], a.frames[idx * 7 + 3]) * 180 / Math.PI;
  assertTrue(Math.abs(firstDeg) < 1e-6, `首帧角度 ${firstDeg}，应为 0`);
});

test('焰魔烘焙: attack 在命中帧（t=1.20s）姿态与首帧显著不同', async () => {
  const d = await loadAsset();
  const a = d.animations.attack;
  const hitFrame = Math.round(1.20 * a.fps);
  assertTrue(hitFrame < a.frameCount, `命中帧 ${hitFrame} 超出 ${a.frameCount}`);
  // 取所有骨骼的最大四元数分量差
  let maxDelta = 0;
  for (let b = 0; b < a.boneIndices.length; b++) {
    const o0 = (0 * a.boneIndices.length + b) * 7;
    const o1 = (hitFrame * a.boneIndices.length + b) * 7;
    for (let k = 0; k < 4; k++) {
      const delta = Math.abs(a.frames[o1 + k] - a.frames[o0 + k]);
      if (delta > maxDelta) maxDelta = delta;
    }
  }
  assertTrue(maxDelta > 0.15, `命中帧与首帧的最大分量差 ${maxDelta.toFixed(3)}（应显著不同）`);
});

test('焰魔烘焙: attack 的 root 转身幅度 ≈65°（横扫，不是小幅转身）', async () => {
  const d = await loadAsset();
  const a = d.animations.attack;
  const rootIdx = a.boneIndices.indexOf(d.bones.findIndex((b) => b.name === 'root'));
  assertTrue(rootIdx >= 0, 'attack 未驱动 root');
  // ⚠️ 取**带符号**的绕 Y 角（root 的转身在 y 轴），并记下绝对值最大的那一帧
  let extreme = 0;
  for (let f = 0; f < a.frameCount; f++) {
    const o = (f * a.boneIndices.length + rootIdx) * 7;
    const deg = 2 * Math.atan2(a.frames[o + 1], a.frames[o + 3]) * 180 / Math.PI;
    if (Math.abs(deg) > Math.abs(extreme)) extreme = deg;
  }
  // 素材 attack6a 的 root.rotation.y 峰值 −65°（配得上 arc 70° 的横扫）。
  // ⚠️ 断言**符号**：正向 65°（往反方向扫）与素材不符，说明取了错的分量或错的关键帧。
  assertTrue(extreme < 0, `root 最大转角应在负方向，实测 ${extreme.toFixed(2)}°`);
  assertTrue(Math.abs(extreme) > 55 && Math.abs(extreme) < 75,
    `root 最大转角 ${extreme.toFixed(2)}°（期望 ≈−65°）`);
});

test('焰魔烘焙: 产物的 scale 与度量一致（1 倍，产物已含、运行时不再乘）', async () => {
  const d = await loadAsset();
  assertEqual(d.scale, 1);
  assertEqual(d.metrics.scale, 1);
});

// ==================== v2.56 修正：三个实玩缺陷的根因守卫 ====================
//
// 用户 2026-11-05 实玩报告三处缺陷，根因全在**烘焙/渲染的坐标系与单位**上，
// 而当时的产物契约测试（骨骼数/顶点数/UV 值域/帧数）**全部通过**。以下三条把根因钉住。

/**
 * bind pose + 动画增量下的**世界空间顶点 bbox**。
 *
 * 与 `bindPoseHeightBlocks` 的区别：那个只算 bind pose（无动画），这个把动画增量也算进去，
 * 并且**按产物的骨骼层级**（`bones[].localPosition` / `bindQuaternion`）累乘 ——
 * 也就是说它验证的是**渲染器实际会看到的东西**。
 *
 * @param {object} asset 产物
 * @param {{fps:number, frameCount:number, boneIndices:number[], frames:number[]}|null} anim
 * @param {number} frame 动画帧号
 * @returns {{min:number[], max:number[]}} 世界空间 bbox（单位格，模型空间原点为脚底附近）
 */
function worldBBoxOfFrame(asset, anim, frame, onlyBoneIdx = null) {
  const qmul = (a, b) => [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
  const TR = (q, t) => {
    const [x, y, z, w] = q;
    const xx = x * x, yy = y * y, zz = z * z;
    const xy = x * y, xz = x * z, yz = y * z;
    const wx = w * x, wy = w * y, wz = w * z;
    return [
      1 - 2 * (yy + zz), 2 * (xy - wz), 2 * (xz + wy), t[0],
      2 * (xy + wz), 1 - 2 * (xx + zz), 2 * (yz - wx), t[1],
      2 * (xz - wy), 2 * (yz + wx), 1 - 2 * (xx + yy), t[2],
      0, 0, 0, 1,
    ];
  };
  const mul = (a, b) => {
    const o = new Array(16);
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 4; c++) {
        let s = 0;
        for (let k = 0; k < 4; k++) s += a[r * 4 + k] * b[k * 4 + c];
        o[r * 4 + c] = s;
      }
    }
    return o;
  };
  const apply = (m, p) => [
    m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3],
    m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7],
    m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11],
  ];

  // 动画增量（boneIndex → {rot, pos}）
  const deltas = new Map();
  if (anim && anim.frameCount > 0) {
    const n = anim.boneIndices.length;
    for (let s = 0; s < n; s++) {
      const o = (frame * n + s) * 7;
      deltas.set(anim.boneIndices[s], {
        rot: [anim.frames[o], anim.frames[o + 1], anim.frames[o + 2], anim.frames[o + 3]],
        pos: [anim.frames[o + 4], anim.frames[o + 5], anim.frames[o + 6]],
      });
    }
  }

  const qrot = (q, v) => {
    const [x, y, z, w] = q;
    const xx = x * x, yy = y * y, zz = z * z;
    const xy = x * y, xz = x * z, yz = y * z;
    const wx = w * x, wy = w * y, wz = w * z;
    return [
      (1 - 2 * (yy + zz)) * v[0] + 2 * (xy - wz) * v[1] + 2 * (xz + wy) * v[2],
      2 * (xy + wz) * v[0] + (1 - 2 * (xx + zz)) * v[1] + 2 * (yz - wx) * v[2],
      2 * (xz - wy) * v[0] + 2 * (yz + wx) * v[1] + (1 - 2 * (xx + yy)) * v[2],
    ];
  };
  const mats = asset.bones.map(() => null);
  for (let i = 0; i < asset.bones.length; i++) {
    const b = asset.bones[i];
    const d = deltas.get(i);
    const q = d ? qmul(b.bindQuaternion, d.rot) : b.bindQuaternion;
    const dp = d ? d.pos : [0, 0, 0];
    // ⚠️ **与渲染器（ignis-renderer._syncOne）同一公式**：
    //   position = pivot − R_current · pivot + animDeltaPos
    // 用 bind 的 `localPosition` 只对 bind 姿态成立，动画帧必须重算（缺陷 C 的根因）。
    const pv = b.pivot || [0, 0, 0];
    const rp = qrot(q, pv);
    const pos = [
      pv[0] - rp[0] + dp[0],
      pv[1] - rp[1] + dp[1],
      pv[2] - rp[2] + dp[2],
    ];
    const local = TR(q, pos);
    mats[i] = b.parentIndex === -1 ? local : mul(mats[b.parentIndex], local);
  }

  const pos = asset.geometry.position;
  const si = asset.geometry.skinIndex;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let v = 0; v < pos.length / 3; v++) {
    if (onlyBoneIdx && !onlyBoneIdx.has(si[v * 4])) continue;   // 只统计指定骨骼
    const w = apply(mats[si[v * 4]], [pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]]);
    for (let k = 0; k < 3; k++) {
      if (w[k] < min[k]) min[k] = w[k];
      if (w[k] > max[k]) max[k] = w[k];
    }
  }
  return { min, max };
}

// ---- 缺陷 A：模型最低点必须能被渲染器补偿到「脚底 = position」 ----

test('焰魔烘焙(v2.56 缺陷A): feetOffsetY 让「身体」（不含武器）的脚底贴 position.y', async () => {
  const d = await loadAsset();
  assertTrue(Number.isFinite(d.metrics.feetOffsetY),
    '产物缺 metrics.feetOffsetY —— 渲染器无法把模型脚底对齐到 position');

  // ⚠️⚠️ **只算「身体」骨骼，排除剑/盾**（用户 2026-11-05 追加报告：「身体完全漂浮在
  // 地表之上一个方格……下降一个方格刚好合适」）。
  // 用**全局**最低（含剑）时取到的是「剑劈到最低」的 -1.65 ⇒ 把脚抬到离地 1.97 格。
  // 正确语义是「脚底贴 position.y」—— 剑劈进地下是美术上可接受的。
  const WEAPON = /^(sword|shield)/;
  const bodyIdx = new Set(
    d.bones.map((b, i) => (WEAPON.test(b.name) ? -1 : i)).filter((i) => i >= 0),
  );
  let bodyLowest = Infinity;
  for (const anim of Object.values(d.animations)) {
    for (let f = 0; f < anim.frameCount; f++) {
      const box = worldBBoxOfFrame(d, anim, f, bodyIdx);
      if (box.min[1] < bodyLowest) bodyLowest = box.min[1];
    }
  }
  assertTrue(Math.abs(d.metrics.feetOffsetY - (-bodyLowest)) < 1e-3,
    `feetOffsetY=${d.metrics.feetOffsetY.toFixed(4)} 应等于 -bodyMinY=${(-bodyLowest).toFixed(4)}`
    + `（身体最低点，不含武器）`);

  // 量级守卫：身体最低点在原点**上方** 0~0.5 格 ⇒ feetOffsetY 是 [-0.5, 0] 的小负数
  assertTrue(bodyLowest > -0.1 && bodyLowest < 0.6,
    `身体最低点 ${bodyLowest.toFixed(3)} 量级异常（应在 0~0.5）`);
  assertTrue(d.metrics.feetOffsetY > -0.6 && d.metrics.feetOffsetY < 0.1,
    `feetOffsetY ${d.metrics.feetOffsetY.toFixed(3)} 量级异常（应是小负数 ~-0.2）`);
});

// ---- 缺陷 B 的守卫在 test-molang.js（单位是求值器的语义，产物层看不出来） ----
//
// 为什么不在本文件测：产物的 idle 帧数是按「1 个表达式周期」定的，而周期的**数值**
// 取决于单位。弧度解（20.4 Hz）与度解（0.356 Hz）会得到**帧数不同的两份产物**，
// 但「帧数 = 12 且 duration = 2π/128」这个契约在两种解释下都自洽 —— 单看产物无法区分。
// 可区分的地方是求值器本身（`test-molang.js` 的「Math.sin 用度不是弧度」用例），
// 以及烘焙器的 `IGNIS_ANIM_PERIODS.idle`（由它派生出正确的周期与帧数）。

// ---- 缺陷 C：挥砍时肢体不能散开（骨骼原点必须随旋转移动） ----

test('焰魔烘焙(v2.56 缺陷C): 攻击全程手臂贴着肩膀（不甩出去）', async () => {
  const d = await loadAsset();
  const attack = d.animations.attack;
  // ⚠️ **不能用「整体最低 y」作判据**：素材的剑本来就探到原点下方（bind 姿态 -0.27、
  // 挥砍时更低），那是**正确**的几何，不是散架。
  //
  // 缺陷 C 的实测形态是**手臂相对肩膀的偏移**：用 bind 的 localPosition 而不重算
  // ⇒ 挥到一半（frame 30）right_arm 的顶点 bbox 跑到 y ∈ [-3.2, -1.79]，
  // 而躯干在 y ∈ [1.75, 3.14] ⇒ 整条胳膊被甩到躯干下方 5 格。
  //
  // 正确判据：**手臂顶点的重心必须落在肩膀附近**（手臂长度约 1.4 格，允许 2 格内）。
  // 直接逐帧检查「手臂与躯干的重叠」：两者 bbox 的 y 区间必须相交
  const bonesOf = (names) => new Set(names.map((n) => d.bones.findIndex((b) => b.name === n)));
  const torso = bonesOf(['upperbody', 'bodycore']);
  const arms = bonesOf(['right_arm', 'left_arm']);

  const boxOfSet = (anim, frame, set) => {
    const qmul = (a, b) => [
      a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
      a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
      a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
      a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
    ];
    const qrot = (q, v) => {
      const [x, y, z, w] = q;
      const xx = x * x, yy = y * y, zz = z * z;
      const xy = x * y, xz = x * z, yz = y * z;
      const wx = w * x, wy = w * y, wz = w * z;
      return [
        (1 - 2 * (yy + zz)) * v[0] + 2 * (xy - wz) * v[1] + 2 * (xz + wy) * v[2],
        2 * (xy + wz) * v[0] + (1 - 2 * (xx + zz)) * v[1] + 2 * (yz - wx) * v[2],
        2 * (xz - wy) * v[0] + 2 * (yz + wx) * v[1] + (1 - 2 * (xx + yy)) * v[2],
      ];
    };
    const TR = (q, t) => {
      const [x, y, z, w] = q;
      const xx = x * x, yy = y * y, zz = z * z;
      const xy = x * y, xz = x * z, yz = y * z;
      const wx = w * x, wy = w * y, wz = w * z;
      return [
        1 - 2 * (yy + zz), 2 * (xy - wz), 2 * (xz + wy), t[0],
        2 * (xy + wz), 1 - 2 * (xx + zz), 2 * (yz - wx), t[1],
        2 * (xz - wy), 2 * (yz + wx), 1 - 2 * (xx + yy), t[2],
        0, 0, 0, 1,
      ];
    };
    const mul = (a, b) => {
      const o = new Array(16);
      for (let r = 0; r < 4; r++) {
        for (let c = 0; c < 4; c++) {
          let acc = 0;
          for (let k = 0; k < 4; k++) acc += a[r * 4 + k] * b[k * 4 + c];
          o[r * 4 + c] = acc;
        }
      }
      return o;
    };
    const apply = (m, p) => [
      m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3],
      m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7],
      m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11],
    ];
    const deltas = new Map();
    const n = anim.boneIndices.length;
    for (let s = 0; s < n; s++) {
      const o = (frame * n + s) * 7;
      deltas.set(anim.boneIndices[s], {
        rot: [anim.frames[o], anim.frames[o + 1], anim.frames[o + 2], anim.frames[o + 3]],
        pos: [anim.frames[o + 4], anim.frames[o + 5], anim.frames[o + 6]],
      });
    }
    const mats = d.bones.map(() => null);
    for (let i = 0; i < d.bones.length; i++) {
      const b = d.bones[i];
      const dd = deltas.get(i);
      const q = dd ? qmul(b.bindQuaternion, dd.rot) : b.bindQuaternion;
      const dp = dd ? dd.pos : [0, 0, 0];
      const pv = b.pivot || [0, 0, 0];
      const rp = qrot(q, pv);
      const local = TR(q, [pv[0] - rp[0] + dp[0], pv[1] - rp[1] + dp[1], pv[2] - rp[2] + dp[2]]);
      mats[i] = b.parentIndex === -1 ? local : mul(mats[b.parentIndex], local);
    }
    const pos = d.geometry.position;
    const si = d.geometry.skinIndex;
    let mn = Infinity, mx = -Infinity;
    for (let v = 0; v < pos.length / 3; v++) {
      if (!set.has(si[v * 4])) continue;
      const w = apply(mats[si[v * 4]], [pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]]);
      if (w[1] < mn) mn = w[1];
      if (w[1] > mx) mx = w[1];
    }
    return { mn, mx };
  };

  for (const f of [0, Math.round(1.0 * attack.fps), Math.round(1.2 * attack.fps), attack.frameCount - 1]) {
    const t = boxOfSet(attack, f, torso);
    const a = boxOfSet(attack, f, arms);
    // 手臂的 y 区间必须与躯干区间**有交叠**（肩膀连着身体）
    const overlap = Math.min(t.mx, a.mx) - Math.max(t.mn, a.mn);
    assertTrue(overlap > 0.2,
      `攻击第 ${f} 帧手臂 y[${a.mn.toFixed(2)},${a.mx.toFixed(2)}] 与躯干 y[${t.mn.toFixed(2)},${t.mx.toFixed(2)}] `
      + `交叠只有 ${overlap.toFixed(2)} 格（应 >0.2）—— 手臂被甩离肩膀`);
  }
});

// ==================== v2.58：旋转约定（「蓄力向后抡接近 180°」的真根因）====================
//
// 用户 2026-11-05：「挥刀之前的蓄力，向后抡胳膊的幅度接近 180°，这显然是不对的」，并且说
// 在本仓里手调 `WINDUP_KEEP` 怎么都调不好。
//
// ## v2.57 为什么误诊
//
// v2.57 比对两侧素材（Java `ModelIgnis.java` 的 `SWING_ATTACK` 与 Bedrock `attack6a`）发现**数值逐帧一致**，
// 于是断定「不是转换缺陷，是作者设计幅度大」，对蓄力段做衰减（右臂 X 保留 0.62）。
// 数值一致是对的，**结论是错的：数值相同 ≠ 姿态相同。**
//
// ## 真根因
//
// Java（Citadel `AdvancedModelBox`）的骨骼矩阵是 `T · Rz · Ry · Rx`，关键帧与默认姿态**逐轴相加**；
// Bedrock 几何的 y 轴与 Java 相反（pivot 恒为 `24 − y_java`），同样的数值落到 Bedrock 几何空间里等价于
// `Rz(−θz) · Ry(+θy) · Rx(−θx)`（X、Z 取反）。烘焙脚本原先用 `Euler(θx, θy, θz, 'XYZ')` 再 `bind × delta`
// —— 顺序反了、X/Z 符号反了：蓄力「向前上方举臂」被翻成「向身后抡」，劈砍「横扫」被翻成「向前尖刺」，
// 连 bind pose 都是躯干**后仰**而不是前倾。衰减补丁只是在错误的姿态上缩小幅度，所以永远调不对。
//
// 下面的判据**不比数值，比世界坐标**：`JAVA_REF` 由 `tools/ignis-java-reference.mjs` 按 Java 语义
// 解析 `ModelIgnis.java` 求出（px，Bedrock 几何空间）。重生成：`node tools/ignis-java-reference.mjs`，
// 整表替换，不要手改单个数。
//
// ⚠️ 旧用例「蓄力帧上臂仰角 ≤ 55°」已删除：它度量的只是 y 分量（抓不到前/后），且把「衰减后的幅度」
// 当作目标 —— 那个目标本身就是错误的（原版上臂在蓄力峰值就是近乎竖直举起，约 74°，只是朝**身前**抬）。

const JAVA_REF = {
  // 探针：[骨骼名, 该骨骼的 **Java 局部坐标** 偏移（y 向下）]
  probes: {
    'right_arm_joint': ['right_arm_joint', [0, 0, 0]],
    'right_hand': ['right_hand', [0, 0, 0]],
    'right_fist': ['right_fist', [0, 0, 0]],
    'sword_grip': ['sword', [0, 0, 0]],
    'sword_tip': ['sword', [0, 0, -49]],
    'head_top': ['head', [0, -8, 0]],
    'chest_top': ['upperbody', [0, -13, 0]],
    'left_arm_joint': ['left_arm_joint', [0, 0, 0]],
    'left_hand': ['left_hand', [0, 0, 0]],
    'left_fist': ['left_fist', [0, 0, 0]],
  },
  poses: {
    'bind': {
      'right_arm_joint': [-15.8, 43.68, -0.97],
      'right_hand': [-28.48, 28.03, -0.97],
      'right_fist': [-26.98, 20.03, -0.97],
      'sword_grip': [-25.48, 15.53, -0.97],
      'sword_tip': [-25.48, 15.53, -49.97],
      'head_top': [0, 51.34, -1.91],
      'chest_top': [0, 41.72, -3.45],
      'left_arm_joint': [15.8, 43.68, -0.97],
      'left_hand': [28.48, 28.03, -0.97],
      'left_fist': [26.98, 20.03, -0.97],
    },
    't0.6': {
      'right_arm_joint': [-10.61, 45.46, 10.19],
      'right_hand': [-15.25, 63.26, 1.99],
      'right_fist': [-10.35, 69.58, 0.51],
      'sword_grip': [-7.51, 72.5, 2.95],
      'sword_tip': [-22.07, 51.69, 44.85],
      'head_top': [3.47, 51.34, 1.72],
      'chest_top': [0.89, 42.37, -0.66],
      'left_arm_joint': [15.79, 41.72, -6.76],
      'left_hand': [28.8, 26.43, -5.09],
      'left_fist': [28.45, 21.62, -11.65],
    },
    't1': {
      'right_arm_joint': [-10.61, 45.46, 10.19],
      'right_hand': [-15.25, 63.26, 1.99],
      'right_fist': [-10.35, 69.58, 0.51],
      'sword_grip': [-7.51, 72.5, 2.95],
      'sword_tip': [-22.07, 51.69, 44.85],
      'head_top': [3.47, 51.34, 1.72],
      'chest_top': [0.89, 42.37, -0.66],
      'left_arm_joint': [15.79, 41.72, -6.76],
      'left_hand': [28.8, 26.43, -5.09],
      'left_fist': [28.45, 21.62, -11.65],
    },
    't1.5': {
      'right_arm_joint': [0.12, 35.29, -20.07],
      'right_hand': [16, 25.37, -27.51],
      'right_fist': [21.67, 21.8, -22.89],
      'sword_grip': [24.92, 20.36, -19.75],
      'sword_tip': [58.02, 16.48, -55.67],
      'head_top': [0.11, 49.99, -7.48],
      'chest_top': [1.4, 41.05, -5.08],
      'left_arm_joint': [-2.85, 49.3, 8.09],
      'left_hand': [-13.7, 51.38, 24.94],
      'left_fist': [-17.39, 47.14, 30.82],
    },
  },
};

/** 允许的偏差（px）。HEAD 的偏差在 5~140px 量级，1px 足以区分且容得下 Bedrock 样条在保持段的 <1px 余波 */
const POSE_TOL_PX = 1.0;

// ---- 4×4 行主序矩阵（模块级，供本节用例共用）----
function m4mul(a, b) {
  const o = new Array(16);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      let acc = 0;
      for (let k = 0; k < 4; k++) acc += a[r * 4 + k] * b[k * 4 + c];
      o[r * 4 + c] = acc;
    }
  }
  return o;
}
function m4FromQuat(q, t) {
  const [x, y, z, w] = q;
  const xx = x * x, yy = y * y, zz = z * z, xy = x * y, xz = x * z, yz = y * z, wx = w * x, wy = w * y, wz = w * z;
  return [
    1 - 2 * (yy + zz), 2 * (xy - wz), 2 * (xz + wy), t[0],
    2 * (xy + wz), 1 - 2 * (xx + zz), 2 * (yz - wx), t[1],
    2 * (xz - wy), 2 * (yz + wx), 1 - 2 * (xx + yy), t[2],
    0, 0, 0, 1,
  ];
}
function quatRot(q, v) {
  const m = m4FromQuat(q, [0, 0, 0]);
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[4] * v[0] + m[5] * v[1] + m[6] * v[2],
    m[8] * v[0] + m[9] * v[1] + m[10] * v[2],
  ];
}
function m4Apply(m, p) {
  return [
    m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3],
    m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7],
    m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11],
  ];
}

/**
 * 产物在 attack 动画时刻 `t`（秒；`null` = bind pose）下各探针点的世界坐标（px，Bedrock 几何空间）。
 *
 * 与渲染器逐式同口径：`R = bind · delta`，`position = pivot − R·pivot + deltaPos`，
 * `M = M(parent) · T(position) · R`。采样走**运行时同一个** `sampleIgnisAttack`。
 */
function probePoints(d, t) {
  const deltas = t === null ? new Map() : sampleIgnisAttack(d.animations.attack, t);
  const mats = [];
  d.bones.forEach((b, i) => {
    const dd = deltas.get(i);
    const q = dd ? multiplyQuat(b.bindQuaternion, dd.rot) : b.bindQuaternion;
    const dp = dd ? dd.pos : [0, 0, 0];
    const rp = quatRot(q, b.pivot);
    const local = m4FromQuat(q, [b.pivot[0] - rp[0] + dp[0], b.pivot[1] - rp[1] + dp[1], b.pivot[2] - rp[2] + dp[2]]);
    mats[i] = b.parentIndex === -1 ? local : m4mul(mats[b.parentIndex], local);
  });
  const byName = Object.fromEntries(d.bones.map((b, i) => [b.name, i]));
  const out = {};
  for (const [name, [boneName, jl]] of Object.entries(JAVA_REF.probes)) {
    const bi = byName[boneName];
    const piv = d.bones[bi].pivot;   // 格
    // Java 局部坐标 y 向下，Bedrock 几何 y 向上 ⇒ y 取反
    const p = [piv[0] + jl[0] / 16, piv[1] - jl[1] / 16, piv[2] + jl[2] / 16];
    out[name] = m4Apply(mats[bi], p).map((v) => v * 16);
  }
  return out;
}

/** 与参考表逐点比对，返回偏差最大的探针 */
function worstDeviation(actual, ref) {
  let worst = { name: '', px: 0 };
  for (const [name, r] of Object.entries(ref)) {
    const a = actual[name];
    const px = Math.hypot(a[0] - r[0], a[1] - r[1], a[2] - r[2]);
    if (px > worst.px) worst = { name, px, actual: a, ref: r };
  }
  return worst;
}

const fmt3 = (p) => `(${p.map((v) => v.toFixed(1)).join(', ')})`;

function assertMatchesJava(d, t, key) {
  const w = worstDeviation(probePoints(d, t), JAVA_REF.poses[key]);
  assertTrue(w.px <= POSE_TOL_PX,
    `${key}：探针 ${w.name} 偏离原版 Java ${w.px.toFixed(1)}px（允许 ${POSE_TOL_PX}px）`
    + ` 实测 ${fmt3(w.actual)} 期望 ${fmt3(w.ref)}`);
}

test('焰魔烘焙(v2.58 约定): bind pose 与原版 Java 逐点一致（躯干前倾、手臂外撇）', async () => {
  const d = await loadAsset();
  assertMatchesJava(d, null, 'bind');
});

test('焰魔烘焙(v2.58 约定): 蓄力 0.60s 与原版 Java 逐点一致', async () => {
  const d = await loadAsset();
  assertMatchesJava(d, 0.6, 't0.6');
});

test('焰魔烘焙(v2.58 约定): 蓄力保持段末 1.00s 与原版 Java 逐点一致', async () => {
  const d = await loadAsset();
  assertMatchesJava(d, 1.0, 't1');
});

test('焰魔烘焙(v2.58 约定): 劈砍保持段 1.50s 与原版 Java 逐点一致', async () => {
  const d = await loadAsset();
  assertMatchesJava(d, 1.5, 't1.5');
});

// ---- 下面几条是同一件事的「人话」不变量：即使有人整表更新了 JAVA_REF，也拦得住方向性错误 ----

test('焰魔烘焙(v2.58 约定): bind pose 躯干前倾、手臂向外撇（不是后仰、内收）', async () => {
  const d = await loadAsset();
  const p = probePoints(d, null);
  const bodyPivotZ = d.bones.find((b) => b.name === 'upperbody').pivot[2] * 16;
  assertTrue(p.chest_top[2] < bodyPivotZ,
    `胸甲顶 z=${p.chest_top[2].toFixed(1)} 应在躯干枢轴 z=${bodyPivotZ.toFixed(1)} 之前（前方 = −z）—— 躯干后仰了`);
  // 右臂在 −x 侧：手应比肩更靠 −x（外撇 ≥ 8px；原版 12.7px，反了是内收 +3.2px）
  assertTrue(p.right_hand[0] < p.right_arm_joint[0] - 8,
    `右手 x=${p.right_hand[0].toFixed(1)} 应比右肩 x=${p.right_arm_joint[0].toFixed(1)} 至少再靠外 8px —— 手臂内收了`);
});

test('焰魔烘焙(v2.58 约定): 蓄力 0.60s 持剑臂沿「身前」举起，剑搭在肩后下垂（不是向身后抡、剑尖冲天）', async () => {
  const d = await loadAsset();
  const p = probePoints(d, 0.6);
  // 前方 = −z：肘、拳都应在肩的**前方**（原版 −8.2px / −9.7px；约定反了会跑到肩后）
  assertTrue(p.right_hand[2] < p.right_arm_joint[2],
    `肘 z=${p.right_hand[2].toFixed(1)} 应在肩 z=${p.right_arm_joint[2].toFixed(1)} 之前 —— 上臂是向身后抡的`);
  assertTrue(p.right_fist[2] < p.right_arm_joint[2],
    `拳 z=${p.right_fist[2].toFixed(1)} 应在肩 z=${p.right_arm_joint[2].toFixed(1)} 之前 —— 前臂是向身后抡的`);
  // 上臂仍明显抬起（原版近乎竖直举起 ≈74°）：肘高于肩 ≥ 10px
  assertTrue(p.right_hand[1] > p.right_arm_joint[1] + 10,
    `肘 y=${p.right_hand[1].toFixed(1)} 应明显高于肩 y=${p.right_arm_joint[1].toFixed(1)} —— 蓄力没有抬臂`);
  // 剑尖低于剑柄（原版低 20.8px；约定反了是剑尖比剑柄高 37px，剑指向天）
  assertTrue(p.sword_tip[1] < p.sword_grip[1] - 10,
    `剑尖 y=${p.sword_tip[1].toFixed(1)} 应低于剑柄 y=${p.sword_grip[1].toFixed(1)} —— 剑尖冲天了`);
});

test('焰魔烘焙(v2.58 约定): 劈砍 1.50s 剑横扫到身体对侧（不是向前尖刺）', async () => {
  const d = await loadAsset();
  const p = probePoints(d, 1.5);
  // 剑从右手（−x 侧）出发，横扫后剑尖应越过身体中线到 +x 侧（原版 +58px；约定反了停在 −25px 向前平指）
  assertTrue(p.sword_tip[0] > 30,
    `剑尖 x=${p.sword_tip[0].toFixed(1)} 应越过中线到 +x 侧（>30）—— 劈砍变成了向前尖刺`);
  assertTrue(p.sword_tip[1] < 30, `剑尖 y=${p.sword_tip[1].toFixed(1)} 应已劈到低处（<30px）`);
});
