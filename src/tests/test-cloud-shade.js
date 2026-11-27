// src/tests/test-cloud-shade.js — 云专属着色地板（v3.50）的 Tier 1 不变式
//
// 设计稿：docs/superpowers/specs/2026-11-27-cloud-soft-translucency-design.md §5.1 / §6.1
//
// ## 这些用例守什么
//
// 云的「半透光」观感 = 给三个致暗因子（太阳项 / 半球环境 / AO）各加一个**地板**，
// 用 `max(原值, 地板)` 抬暗面。`max` 是载荷性的：原值已高于地板的面恒等返回
// ⇒ **亮面逐位不动**（不过曝、不撞 crosshair 的「最亮方块 < 200」阈值）。
//
// 本文件钉的是「改坏了肉眼玩不出来」的那部分：
//   · 零回归（soften=0 / lift=0 必须**逐位**回到现状，不是「差不多」）；
//   · 亮面不动（整体提亮会冒充柔和，而云底面判据照样绿）；
//   · 任何面都不许变暗（柔和是单向抬升）。
//
// ⚠️ 逐位判据一律用 assertEqual（===），不用容差 —— 容差会把浮点重建缺陷放过去。
// ⚠️ 逐位判据的输入必须含**非整比值**：整数/整比输入下重建缺陷恒等，测不出来。
import { test } from './runner.js';
import { assertEqual, assertTrue } from './assert.js';
import {
  CLOUD_SUN_LIFT, CLOUD_HEMI_LIFT, CLOUD_AO_LIFT, AO_CURVE_K,
  aoFactorFor, cloudSunFloorFor, cloudHemiFloorFor, cloudAoFloorFor, cloudShadeFor,
  CLOUD_SIDE_FACE_GAIN, CLOUD_TOP_FACE_GAIN, CLOUD_BOTTOM_FACE_GAIN, cloudFaceGainFor,
  cloudSunFloorRGBFor,
} from '../render/cloud-shade.js';
import {
  SHADOW_FLOOR, SUN_INTENSITY, NOON_SUN_DIR, FACE_NORMALS, sunTermRGBFor,
  srgbEncode, acesFilmic,
} from '../render/sun-shade.js';
import { HEMI_GROUND, hemiFactorFor } from '../render/hemi-shade.js';

/** 归一化（测试侧独立实现，不复用被测代码的 helper） */
function norm(v) {
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
}

/**
 * 现状 shade 的**独立**参考实现（不 import 被测函数）。
 * 与 materials.js 的 `max(sky×hemi×sunTerm, block)` 在 block=0 时同式。
 * ⚠️ 字面量 0.9 / 3 / 2 是刻意的：这条用例要能抓到「被测模块改了 AO 曲线」，
 * 若从被测模块 import AO_CURVE_K 就变成同源恒真。
 */
function refShade(normalIndex, ao, sunDir, kill, floor, intensity, ground) {
  const n = FACE_NORMALS[normalIndex];
  const dot = Math.max(n[0] * sunDir[0] + n[1] * sunDir[1] + n[2] * sunDir[2], 0);
  return (floor + intensity * dot * kill)
    * (ground + (1 - ground) * (n[1] * 0.5 + 0.5))
    * (1 - (3 - ao) / 3 * 0.9);
}

test('cloud-shade: lift=0 时三个地板逐位等于原值（零回归锚点）', () => {
  for (const floor of [0.38, 0.14, 0.2713]) {
    assertEqual(cloudSunFloorFor(floor, 0), floor, `floor=${floor} 的太阳地板`);
  }
  for (const ground of [0.6, 0.12, 0.4319]) {
    assertEqual(cloudHemiFloorFor(ground, 0), ground, `ground=${ground} 的半球地板`);
  }
  assertEqual(cloudAoFloorFor(0), aoFactorFor(0), 'AO 地板 lift=0');
  // 前提断言：三个 lift 的正式值都不是 0（取 0 等于功能关闭，整项静默失效）
  assertTrue(CLOUD_SUN_LIFT > 0 && CLOUD_SUN_LIFT < 1, `CLOUD_SUN_LIFT=${CLOUD_SUN_LIFT}`);
  assertTrue(CLOUD_HEMI_LIFT > 0 && CLOUD_HEMI_LIFT < 1, `CLOUD_HEMI_LIFT=${CLOUD_HEMI_LIFT}`);
  assertTrue(CLOUD_AO_LIFT > 0 && CLOUD_AO_LIFT < 1, `CLOUD_AO_LIFT=${CLOUD_AO_LIFT}`);
});

test('cloud-shade: ao=3 时 AO 地板不改开阔面', () => {
  assertEqual(aoFactorFor(3), 1, '前提：开阔面 AO 因子本就恒 1');
  assertEqual(Math.max(aoFactorFor(3), cloudAoFloorFor()), aoFactorFor(3), '开阔面不受 AO 地板影响');
  assertEqual(AO_CURVE_K, 0.9, 'AO 曲线系数与 materials.js 现状一致');
});

test('cloud-shade: 正午顶面 sunTerm 恒 1.0 且高于云地板 ⇒ max 恒等（顶面不动）', () => {
  const st = SHADOW_FLOOR + SUN_INTENSITY * NOON_SUN_DIR[1];
  assertTrue(Math.abs(st - 1) < 1e-12, `正午顶面 sunTerm 应为 1.0，实测 ${st}`);
  assertTrue(st >= cloudSunFloorFor(SHADOW_FLOOR), `顶面 ${st} 须 ≥ 云地板 ${cloudSunFloorFor(SHADOW_FLOOR)}`);
  assertEqual(Math.max(st, cloudSunFloorFor(SHADOW_FLOOR)), st, 'max 必须恒等返回顶面原值');
});

test('cloud-shade: soften=0 逐位等于现状公式（非整比输入，7776 组）', () => {
  const dirs = [
    [0.3187, 0.8721, -0.3719], [-0.4412, 0.6633, 0.6047],
    [0.7934, 0.5479, 0.3392], [0, 0.8, 0.6],
  ].map(norm);
  let checked = 0;
  for (const sunDir of dirs) {
    for (const shadowFloor of [0.38, 0.14, 0.2713]) {
      for (const hemiGround of [0.6, 0.12, 0.4319]) {
        for (const sunIntensity of [0.775, 0.956, 0.6173]) {
          for (let normalIndex = 0; normalIndex < 6; normalIndex++) {
            for (const ao of [0, 1, 2, 3]) {
              for (const shadowKill of [1, 0.3719, 0]) {
                const got = cloudShadeFor({
                  normalIndex, ao, sunDir, shadowKill,
                  shadowFloor, sunIntensity, hemiGround, soften: 0,
                });
                const want = refShade(normalIndex, ao, sunDir, shadowKill, shadowFloor, sunIntensity, hemiGround);
                assertEqual(got, want,
                  `soften=0 逐位：face${normalIndex} ao${ao} floor${shadowFloor} ground${hemiGround} I${sunIntensity} kill${shadowKill}`);
                checked++;
              }
            }
          }
        }
      }
    }
  }
  // 防「循环没跑」的恒真：4×3×3×3×6×4×3 = 7776
  assertEqual(checked, 7776, '样本数');
});

test('cloud-shade: soften=1 时暗面变亮、亮面逐位不变、任何面都不变暗', () => {
  const sunDir = NOON_SUN_DIR;
  const base = { sunDir, shadowKill: 1, shadowFloor: SHADOW_FLOOR, sunIntensity: SUN_INTENSITY, hemiGround: HEMI_GROUND };
  let brighten = 0, unchanged = 0, dimmed = 0;
  for (let normalIndex = 0; normalIndex < 6; normalIndex++) {
    for (const ao of [0, 1, 2, 3]) {
      const off = cloudShadeFor({ ...base, normalIndex, ao, soften: 0 });
      const on = cloudShadeFor({ ...base, normalIndex, ao, soften: 1 });
      if (on > off) brighten++;
      else if (on === off) unchanged++;
      else dimmed++;
    }
  }
  assertEqual(brighten, 20, '变亮的 face×AO 组合数');
  assertEqual(unchanged, 4, '逐位不变的组合数（顶面与迎光面的 ao=2/3）');
  assertEqual(dimmed, 0, '**任何面都不得变暗** —— 柔和是单向抬升');
  // 单独钉住两个亮面（整体提亮 / 改系数 / wrap lighting 都会让这两条真红）
  for (const normalIndex of [2, 4]) {
    const off = cloudShadeFor({ ...base, normalIndex, ao: 3, soften: 0 });
    const on = cloudShadeFor({ ...base, normalIndex, ao: 3, soften: 1 });
    assertEqual(on, off, `面 ${normalIndex}（顶面/迎光面）ao=3 必须逐位不变`);
  }
});

test('cloud-shade: 地板随 floor/ground 单调，且 normal 档派生值正确', () => {
  assertTrue(cloudSunFloorFor(0.14) < cloudSunFloorFor(0.38), '同 lift 下 floor 越大地板越大');
  assertTrue(cloudHemiFloorFor(0.12) < cloudHemiFloorFor(0.6), '同 lift 下 ground 越大地板越大');
  // 派生实测值（spec §5.1）
  assertTrue(Math.abs(cloudSunFloorFor(0.14) - 0.441) < 1e-12, `normal 档太阳地板 ${cloudSunFloorFor(0.14)}`);
  assertTrue(Math.abs(cloudHemiFloorFor(0.12) - 0.56) < 1e-12, `normal 档半球地板 ${cloudHemiFloorFor(0.12)}`);
  assertTrue(Math.abs(cloudAoFloorFor() - 0.7) < 1e-12, `AO 地板 ${cloudAoFloorFor()}`);
  assertTrue(Math.abs(cloudSunFloorFor(SHADOW_FLOOR) - 0.597) < 1e-12, '全局档太阳地板 0.597');
  assertTrue(Math.abs(cloudHemiFloorFor(HEMI_GROUND) - 0.8) < 1e-12, '全局档半球地板 0.8');
  // normal 档顶面也不动（per-style 跟随的关键：地板由当前 floor 派生，不是字面量）
  const nd = norm([0.7934, 0.5479, 0.3392]);
  const stNormal = 0.14 + 0.956 * nd[1];
  assertEqual(Math.max(stNormal, cloudSunFloorFor(0.14)), stNormal, 'normal 档顶面 max 恒等');
});

test('cloud-shade: soften=0 与 sun-shade/hemi-shade 的既有公式交叉一致（不留第二份公式）', () => {
  for (let normalIndex = 0; normalIndex < 6; normalIndex++) {
    for (const ao of [0, 1, 2, 3]) {
      const ref = sunTermRGBFor(normalIndex, NOON_SUN_DIR, 1, 1)[0]
        * hemiFactorFor(normalIndex, HEMI_GROUND)
        * aoFactorFor(ao);
      const got = cloudShadeFor({
        normalIndex, ao, sunDir: NOON_SUN_DIR, shadowKill: 1,
        shadowFloor: SHADOW_FLOOR, sunIntensity: SUN_INTENSITY, hemiGround: HEMI_GROUND, soften: 0,
      });
      // 容差而非严格相等：两个模块的乘法顺序不同（逐位那条在上一个用例）
      assertTrue(Math.abs(got - ref) < 1e-12, `face${normalIndex} ao${ao}: ${got} vs ${ref}`);
    }
  }
});
// ==================== 接线断言（Task 3）====================
//
// 手法与 test-wet-surface.js 的「GPU 侧索引必须钳到表长 − 1」完全一致：
// Node 侧**读源码**而不是 import TSL（TSL 节点在 GPU 求值，Node 侧读不到片元行为）。
// ⚠️ **必须滤掉注释行**：jsdoc 里有同串公式说明，全文件 includes 会恒真。

/** 读源码并只保留代码行（滤掉 `*` / `//` / `/*` 开头的行） */
async function codeOf(relPath) {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL(relPath, import.meta.url), 'utf8');
  return src.split('\n')
    .filter((l) => { const t = l.trim(); return t && !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*'); })
    .join('\n');
}

test('materials: AO 地板同时作用于 vSkyShade 与 vBlockShade（漏一个会让火把照亮的云凹角不一致）', async () => {
  const code = await codeOf('../render/materials.js');
  assertTrue(/vertexStage\(mul\(sky,\s*aoSoft\)\)/.test(code),
    'vSkyShade 必须吃 aoSoft');
  assertTrue(/vertexStage\(mul\(block,\s*aoSoft\)\)/.test(code),
    'vBlockShade 必须吃 aoSoft（只改 sky 会让火把照亮的云凹角与太阳照亮的不一致）');
  assertTrue(!/vertexStage\(mul\(sky,\s*aoFactor\)\)/.test(code),
    '不得留旧的 vertexStage(mul(sky, aoFactor))');
  assertTrue(!/vertexStage\(mul\(block,\s*aoFactor\)\)/.test(code),
    '不得留旧的 vertexStage(mul(block, aoFactor))');
});

test('materials: 三个地板都走 mix 且 t 是 cloudT（无 if 分支）', async () => {
  const code = await codeOf('../render/materials.js');
  // cloudT 必须 = cloudBit × uCloudSoften（非云方块 cloudBit=0 ⇒ t 恒 0 ⇒ 结构性零回归）
  assertTrue(/const cloudT = mul\(cloudBit,\s*uCloudSoften\)/.test(code),
    'cloudT 必须是 mul(cloudBit, uCloudSoften)');
  assertTrue(/const cloudBit = float\(packed\.shiftRight\(19\)\.bitAnd\(1\)\)/.test(code),
    'cloudBit 必须解 packed bit19');
  for (const [name, orig, floor] of [
    ['aoSoft', 'aoFactor', 'uCloudAoFloor'],
    ['hemiSoft', 'hemiFactor', 'uCloudHemiFloor'],
    // ⚠️ 太阳项用**逐通道**地板（自审修复）：sunTerm 是 vec3，
    // 标量 max 会抹掉傍晚/黑夜/普通档的色相。详见下面两条专项用例。
    ['sunTermSoft', 'sunTerm', 'uCloudSunFloorRGB'],
  ]) {
    const re = new RegExp(`const ${name} = mix\\(${orig},\\s*max\\(${orig},\\s*${floor}\\),\\s*cloudT\\)`);
    assertTrue(re.test(code), `${name} 必须是 mix(${orig}, max(${orig}, ${floor}), cloudT)`);
  }
  // 无 if 分支（写 if 会出两条代码路径，未测的那条静默劣化）
  assertTrue(!/if\s*\(\s*cloudBit/.test(code), '不得用 if (cloudBit ...) 分支');
  assertTrue(!/if\s*\(\s*cloudT/.test(code), '不得用 if (cloudT ...) 分支');
});

test('materials: 云地板加在 sunTerm 之后（不是 vSunDot 上 —— 否则改阴影语义）', async () => {
  const code = await codeOf('../render/materials.js');
  const sunTermAt = code.indexOf('const sunTerm = ');
  const cloudSunAt = code.indexOf('const sunTermSoft = ');
  assertTrue(sunTermAt >= 0, '必须有 const sunTerm = ');
  assertTrue(cloudSunAt > sunTermAt,
    'sunTermSoft 必须在 sunTerm 之后（sunTerm 已含色温与 shadowKill；在 dot 上抬会绕过阴影因子）');
  // vSunDot 的定义式里不得含云地板
  const dotStart = code.indexOf('const vSunDot = ');
  const dotEnd = code.indexOf(';', dotStart);
  assertTrue(dotStart >= 0 && dotEnd > dotStart, 'vSunDot 定义式可定位');
  assertTrue(!code.slice(dotStart, dotEnd).includes('uCloudSunFloor'),
    'vSunDot 定义式里不得含 uCloudSunFloor');
});

test('daynight: 云地板复用 floor/ground 局部量（不重新读 p，防 per-style 撕裂）', async () => {
  const code = await codeOf('../render/daynight.js');
  assertTrue(/cloudSunFloorFor\(floor\)/.test(code),
    '云太阳地板必须吃局部量 floor（与刚写给 uShadowFloor 的是同一个值）');
  assertTrue(/cloudHemiFloorFor\(ground\)/.test(code),
    '云半球地板必须吃局部量 ground');
  assertTrue(!/cloudSunFloorFor\(\s*typeof p\./.test(code), '不得重新读一遍 p.shadowFloor');
  assertTrue(!/cloudSunFloorFor\(\s*p\.shadowFloor/.test(code), '不得直接吃 p.shadowFloor');
  assertTrue(!/cloudHemiFloorFor\(\s*typeof p\./.test(code), '不得重新读一遍 p.hemiGround');
  assertTrue(!/cloudHemiFloorFor\(\s*p\.hemiGround/.test(code), '不得直接吃 p.hemiGround');
  // AO 地板与 style 无关 ⇒ _apply 不写它
  assertTrue(!/uCloudAoFloor/.test(code), 'uCloudAoFloor 与 style 无关，_apply 不得写它');
});

test('cloud uniforms: 句柄形状与初值（uCloudSoften=1 满档；三个地板等于派生值）', async () => {
  const { CLOUD_SURFACE_UNIFORMS: U } = await import('../render/materials.js');
  assertEqual(U.uCloudSoften.value, 1, 'uCloudSoften 初值 1（满档柔和）');
  assertEqual(U.uCloudSunFloor.value, cloudSunFloorFor(SHADOW_FLOOR), '太阳地板初值 = 全局档派生值');
  assertEqual(U.uCloudHemiFloor.value, cloudHemiFloorFor(HEMI_GROUND), '半球地板初值 = 全局档派生值');
  assertEqual(U.uCloudAoFloor.value, cloudAoFloorFor(), 'AO 地板初值 = 派生值');
});

// ==================== Final review 修复：地板必须保色相 ====================
//
// ☠️ 自审发现的真缺陷：`sunTerm` 是 **vec3**（含 uSunColor/uAmbientColor 色温），
// 而 `uCloudSunFloor` 是标量 ⇒ `max(vec3, float)` 逐分量取大 ⇒ 背光面三通道
// 被抬到同一个值 ⇒ **傍晚/黑夜/普通三档的冷色环境光被抹成中性灰**。
// 实测背光面 R−B：dusk −0.129 → 0、night −0.097 → 0、normal −0.044 → 0。
// 全部既有判据都在 noon（中性色温）下 ⇒ 结构上抓不到。

test('cloud-shade: 逐通道地板保色相 —— 非中性色温下 R−B 不得被抹平', async () => {
  const { cloudSunFloorRGBFor } = await import('../render/cloud-shade.js');
  const { VISUAL_STYLES } = await import('../render/daynight.js');
  for (const key of ['dusk', 'night', 'normal']) {
    const p = VISUAL_STYLES[key];
    const floor = typeof p.shadowFloor === 'number' ? p.shadowFloor : SHADOW_FLOOR;
    const ac = p.ambientColor;
    const rgb = cloudSunFloorRGBFor(floor, ac);
    const cloudFloor = cloudSunFloorFor(floor);
    // 背光面（dot=0）的 sunTerm_c = ambientColor_c × floor
    const st = [0, 1, 2].map((c) => ac[c] * floor);
    const lifted = st.map((v, c) => Math.max(v, rgb[c]));
    const rbBefore = st[0] - st[2];
    const rbAfter = lifted[0] - lifted[2];
    // ① 色相方向必须保持（冷环境仍偏蓝 ⇒ R−B 仍为负）
    assertTrue(rbBefore < 0, `${key} 档本身必须是冷环境（前提断言）`);
    assertTrue(rbAfter < 0,
      `${key} 档云背光面须仍偏冷（R−B ${rbAfter.toFixed(4)}），标量地板会抹成 0`);
    // ② 三通道的**均值**必须等于标量地板（亮度语义不变，只换色相分配）
    const mean = (rgb[0] + rgb[1] + rgb[2]) / 3;
    assertTrue(Math.abs(mean - cloudFloor) < 1e-12,
      `${key} 档逐通道地板均值须等于标量地板 ${cloudFloor}，实测 ${mean}`);
    // ③ 中性色温（全 1）时逐通道地板退化成标量（零回归）
    const neutral = cloudSunFloorRGBFor(floor, [1, 1, 1]);
    for (let c = 0; c < 3; c++) {
      assertTrue(Math.abs(neutral[c] - cloudFloor) < 1e-12,
        `中性色温下通道 ${c} 须等于标量地板`);
    }
  }
});

test('materials: 云太阳地板必须逐通道（防标量 max 抹掉色相）', async () => {
  const code = await codeOf('../render/materials.js');
  // 必须存在一个 vec3 的地板节点，且 sunTermSoft 吃它而不是标量 uniform
  assertTrue(/uCloudSunFloorRGB/.test(code),
    '必须有逐通道地板 uCloudSunFloorRGB（标量 max 会把傍晚/黑夜/普通档的云抹成灰）');
  assertTrue(/const sunTermSoft = mix\(sunTerm,\s*max\(sunTerm,\s*uCloudSunFloorRGB\),\s*cloudT\)/.test(code),
    'sunTermSoft 必须吃逐通道地板');
});

test('daynight: 逐通道云地板由同一个 floor 与当前 ambientColor 派生', async () => {
  const code = await codeOf('../render/daynight.js');
  assertTrue(/cloudSunFloorRGBFor\(floor,\s*p\.ambientColor\)/.test(code),
    '逐通道地板须吃局部量 floor 与当前风格的 ambientColor');
});

// ==================== v3.51：面间明暗分离（侧面提亮 / 顶底压暗）====================
//
// 设计稿：docs/superpowers/specs/2026-11-27-cloud-side-face-contrast-design.md
//
// ## 根因（一个恒等式，不是参数没调够）
//
// `CLOUD_HEMI_LIFT = 0.50` ⇒ `cloudHemiFloorFor(g, 0.5) = (1+g)/2`
// **恰好等于四个侧面的 hemi 因子**；同时侧面与底面的 N·L 都 ≤0 ⇒ 太阳项落到同一地板
// ⇒ **底面与四侧面逐位同色**（五档侧/底屏幕比实测全是 1.000）。
// 用户实玩：「小云朵与背后大云岛的底色完全一样，肉眼分辨不出来」。
//
// 修法 = 在最终 shade 上乘一个**逐面类别的灰阶 gain**（侧 1.38 / 顶 0.95 / 底 0.72）。
// ⚠️ 灰阶是载荷性的：gain 是标量、等比缩放整个 vec3 ⇒ 保色相（用户要「更白」不是「换色」）。
// ⚠️ 1.38 是**实测安全上界**：1.42 时 dusk +Z 面线性 1.0133 > 1 ⇒ ACES 钳平三通道、色相消失。

/** 五档光影参数（缺省回落全局常量，与 DayNight._apply 同口径） */
async function styleParams() {
  const { VISUAL_STYLES } = await import('../render/daynight.js');
  const out = {};
  for (const [key, p] of Object.entries(VISUAL_STYLES)) {
    const raw = p.sunDirection;
    const len = Math.hypot(raw[0], raw[1], raw[2]);
    out[key] = {
      sunDir: [raw[0] / len, raw[1] / len, raw[2] / len],
      shadowFloor: typeof p.shadowFloor === 'number' ? p.shadowFloor : SHADOW_FLOOR,
      sunIntensity: typeof p.sunIntensity === 'number' ? p.sunIntensity : SUN_INTENSITY,
      hemiGround: typeof p.hemiGround === 'number' ? p.hemiGround : HEMI_GROUND,
      ambientColor: p.ambientColor,
      sunColor: p.sunColor,
      skyDim: p.skyDim,
    };
  }
  return out;
}

/** 线性 → 屏幕灰阶（ACES + sRGB，与 Tier 4 同口径；normal 档走 AgX 故本表只作标定起点） */
const screenOf = (lin) => srgbEncode(acesFilmic(Math.max(0, lin))) * 255;

/**
 * 逐通道 shade（含色温 + skyDim + 面类别 gain）—— **独立参考实现**，
 * 不 import cloudShadeFor（那条交叉一致性另有专项用例）。
 * ⚠️ 地板走 cloudSunFloorRGBFor（保色相），与 materials.js 的 uCloudSunFloorRGB 同源。
 */
function faceRgb(st, normalIndex, ao, { contrast = 1, sideGain = CLOUD_SIDE_FACE_GAIN } = {}) {
  const n = FACE_NORMALS[normalIndex];
  const dot = Math.max(n[0] * st.sunDir[0] + n[1] * st.sunDir[1] + n[2] * st.sunDir[2], 0);
  const hemiRaw = st.hemiGround + (1 - st.hemiGround) * (n[1] * 0.5 + 0.5);
  const aoRaw = 1 - (3 - ao) / 3 * 0.9;
  const hemiFloor = cloudHemiFloorFor(st.hemiGround);
  const aoFloor = cloudAoFloorFor();
  const floorRGB = cloudSunFloorRGBFor(st.shadowFloor, st.ambientColor);
  const faceK = n[1] > 0.5 ? CLOUD_TOP_FACE_GAIN
    : n[1] < -0.5 ? CLOUD_BOTTOM_FACE_GAIN : sideGain;
  const gain = 1 + (faceK - 1) * contrast;
  const out = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const raw = st.shadowFloor * st.ambientColor[c] + st.sunIntensity * dot * st.sunColor[c];
    out[c] = Math.max(raw, floorRGB[c])
      * Math.max(hemiRaw, hemiFloor)
      * Math.max(aoRaw, aoFloor)
      * gain * st.skyDim;
  }
  return out;
}

/** 屏幕三通道均值（与 Tier 4 的 regionLuma 同口径） */
const lumaOf = (rgb) => (screenOf(rgb[0]) + screenOf(rgb[1]) + screenOf(rgb[2])) / 3;

test('cloud-face-gain: contrast=0 时六面 gain 逐位 1（零回归锚点）', async () => {
  for (let n = 0; n < 6; n++) assertEqual(cloudFaceGainFor(n, 0), 1, `面 ${n}`);
  // cloudShadeFor 缺省与显式 0 都必须逐位等于现有公式（非整比输入，防重建缺陷恒等）
  const base = {
    sunDir: norm([0.31, 0.71, 0.63]), shadowKill: 0.3719,
    shadowFloor: 0.2713, sunIntensity: 0.6173, hemiGround: 0.4319, soften: 1,
  };
  for (let n = 0; n < 6; n++) {
    for (const ao of [0, 1, 2, 3]) {
      assertEqual(cloudShadeFor({ ...base, normalIndex: n, ao }),
        cloudShadeFor({ ...base, normalIndex: n, ao, faceContrast: 0 }),
        `面${n} ao${ao}：缺省须等于显式 faceContrast=0`);
    }
  }
});

test('cloud-face-gain: contrast=1 时四侧面 1.38 / 顶 0.95 / 底 0.72（批准幅度）', () => {
  assertEqual(CLOUD_SIDE_FACE_GAIN, 1.38, '侧面 gain（批准幅度，不得擅改）');
  assertEqual(CLOUD_TOP_FACE_GAIN, 0.95, '顶面 gain');
  assertEqual(CLOUD_BOTTOM_FACE_GAIN, 0.72, '底面 gain');
  for (const n of [0, 1, 4, 5]) {
    assertEqual(cloudFaceGainFor(n, 1), CLOUD_SIDE_FACE_GAIN, `侧面 ${n}`);
  }
  assertEqual(cloudFaceGainFor(2, 1), CLOUD_TOP_FACE_GAIN, '顶面');
  assertEqual(cloudFaceGainFor(3, 1), CLOUD_BOTTOM_FACE_GAIN, '底面');
  // 中间档线性插值（与 TSL 的 mix(1, k, t) 同形）
  assertTrue(Math.abs(cloudFaceGainFor(0, 0.5) - (1 + (1.38 - 1) * 0.5)) < 1e-12, '半档插值');
});

test('cloud-face-gain: 五档侧/底屏幕比 ≥1.15，且侧亮/顶暗/底暗同时成立', async () => {
  const styles = await styleParams();
  for (const [key, st] of Object.entries(styles)) {
    for (const ao of [1, 3]) {
      const sideOn = lumaOf(faceRgb(st, 1, ao, { contrast: 1 }));
      const sideOff = lumaOf(faceRgb(st, 1, ao, { contrast: 0 }));
      const topOn = lumaOf(faceRgb(st, 2, ao, { contrast: 1 }));
      const topOff = lumaOf(faceRgb(st, 2, ao, { contrast: 0 }));
      const botOn = lumaOf(faceRgb(st, 3, ao, { contrast: 1 }));
      const botOff = lumaOf(faceRgb(st, 3, ao, { contrast: 0 }));
      const ratio = sideOn / botOn;
      assertTrue(ratio >= 1.15,
        `${key} ao${ao} 侧/底屏幕比须 ≥1.15（原版参考 218/182=1.198），实测 ${ratio.toFixed(4)}`);
      // 三条方向判据：只判比值会被「整体压暗」蒙过
      assertTrue(sideOn > sideOff, `${key} ao${ao} 侧面须变亮：${sideOff.toFixed(1)} → ${sideOn.toFixed(1)}`);
      assertTrue(topOn < topOff, `${key} ao${ao} 顶面须变暗：${topOff.toFixed(1)} → ${topOn.toFixed(1)}`);
      assertTrue(botOn < botOff, `${key} ao${ao} 底面须变暗：${botOff.toFixed(1)} → ${botOn.toFixed(1)}`);
    }
  }
});

test('cloud-face-gain: 全档全面最大线性 <1.0（不削顶），且侧 gain 1.42 时该扫描 >1', async () => {
  const styles = await styleParams();
  const scan = (sideGain) => {
    let max = 0, where = '';
    for (const [key, st] of Object.entries(styles)) {
      for (let n = 0; n < 6; n++) {
        for (const ao of [0, 1, 2, 3]) {
          const rgb = faceRgb(st, n, ao, { contrast: 1, sideGain });
          for (let c = 0; c < 3; c++) {
            if (rgb[c] > max) { max = rgb[c]; where = `${key} 面${n} ao${ao} ch${c}`; }
          }
        }
      }
    }
    return { max, where };
  };
  const ok = scan(CLOUD_SIDE_FACE_GAIN);
  assertTrue(ok.max < 1.0,
    `批准幅度下全档全面最大线性须 <1.0（削顶会钳平三通道抹掉色相），实测 ${ok.max.toFixed(4)} @ ${ok.where}`);
  // 判别力：这条判据不是恒真 —— 把侧 gain 抬到 1.42 就必须越线
  const bad = scan(1.42);
  assertTrue(bad.max > 1.0,
    `侧 gain 1.42 时该扫描须 >1.0（证明削顶判据有判别力），实测 ${bad.max.toFixed(4)} @ ${bad.where}`);
});

test('cloud-face-gain: 非中性色温档底面 R−B 符号不变且偏移 <8 灰阶（灰阶保色相）', async () => {
  const styles = await styleParams();
  for (const key of ['dusk', 'night', 'normal']) {
    const st = styles[key];
    for (const n of [1, 3, 5]) {
      const on = faceRgb(st, n, 3, { contrast: 1 }).map(screenOf);
      const off = faceRgb(st, n, 3, { contrast: 0 }).map(screenOf);
      const rbOn = on[0] - on[2], rbOff = off[0] - off[2];
      assertTrue(rbOff < 0, `${key} 面${n} 前提：本身偏冷（R−B ${rbOff.toFixed(1)}）`);
      assertTrue(rbOn < 0,
        `${key} 面${n} 改后须仍偏冷（R−B ${rbOn.toFixed(1)}）—— 带色偏的重映射会把它抹成 0`);
      assertTrue(Math.abs(rbOn - rbOff) < 8,
        `${key} 面${n} 色相偏移须 <8 灰阶，实测 ${(rbOn - rbOff).toFixed(1)}`);
    }
  }
});

test('cloud-face-gain: cloudShadeFor 的 gain 与独立参考实现交叉一致（不留第二份公式）', async () => {
  const styles = await styleParams();
  for (const [key, st] of Object.entries(styles)) {
    // 中性色温档才能与标量 cloudShadeFor 比（它不含色温）
    if (st.ambientColor.some((v) => v !== 1) || st.sunColor.some((v) => v !== 1)) continue;
    for (let n = 0; n < 6; n++) {
      for (const ao of [0, 1, 2, 3]) {
        const got = cloudShadeFor({
          normalIndex: n, ao, sunDir: st.sunDir, shadowKill: 1,
          shadowFloor: st.shadowFloor, sunIntensity: st.sunIntensity,
          hemiGround: st.hemiGround, soften: 1, faceContrast: 1,
        });
        const ref = cloudShadeFor({
          normalIndex: n, ao, sunDir: st.sunDir, shadowKill: 1,
          shadowFloor: st.shadowFloor, sunIntensity: st.sunIntensity,
          hemiGround: st.hemiGround, soften: 1, faceContrast: 0,
        }) * cloudFaceGainFor(n, 1);
        assertTrue(Math.abs(got - ref) < 1e-12, `${key} 面${n} ao${ao}: ${got} vs ${ref}`);
      }
    }
  }
});

// ==================== v3.51 接线断言（materials / daynight）====================

test('materials: 面类别 gain 由 cloudBit × uCloudFaceContrast 门控，且乘在 shadeLit/shadeUnlit 两处', async () => {
  const code = await codeOf('../render/materials.js');
  assertTrue(/uCloudFaceContrast:\s*uniform\(1\.0\)/.test(code),
    '必须有初值 1.0 的**独立** uniform（复用 uCloudSoften 会同时关掉 v3.50 地板 ⇒ 不是单变量）');
  assertTrue(/const cloudFaceGain = mix\(float\(1\),\s*cloudFaceK,\s*mul\(cloudBit,\s*uCloudFaceContrast\)\)/.test(code),
    'gain 必须是 mix(float(1), cloudFaceK, mul(cloudBit, uCloudFaceContrast))');
  assertTrue(/const shadeLit = mul\(max\([\s\S]*?\),\s*cloudFaceGain\)/.test(code),
    'shadeLit 必须整体乘 gain（只乘 sky 项会漏掉火把照亮的云面）');
  assertTrue(/const shadeUnlit = mul\(max\([\s\S]*?\),\s*cloudFaceGain\)/.test(code),
    'shadeUnlit 必须整体乘 gain（两通道口径一致）');
  assertTrue(!/if\s*\(\s*cloudFaceContrast/.test(code), '不得用 if 分支（未测的那条会静默劣化）');
  assertTrue(!/if\s*\(\s*cloudFaceGain/.test(code), '不得用 if 分支');
});

test('materials: 面类别由 faceNormalNode.y 判（不新增顶点属性），三个 gain 常量从 cloud-shade import', async () => {
  const code = await codeOf('../render/materials.js');
  assertTrue(/const cloudFaceK = select\(faceNormalNode\.y\.greaterThan\(0\.5\)/.test(code),
    '面类别必须复用已有的 faceNormalNode.y（新增 float 属性会撞 200MiB gpuVertexBytes 门）');
  assertTrue(/CLOUD_SIDE_FACE_GAIN/.test(code) && /CLOUD_TOP_FACE_GAIN/.test(code)
    && /CLOUD_BOTTOM_FACE_GAIN/.test(code), '三个 gain 常量必须 import，不得写字面量（红线 1）');
  assertTrue(!/vec3\(\s*CLOUD_SIDE_FACE_GAIN/.test(code),
    'gain 不得是逐通道 vec3（等比缩放才保色相）');
  // gain 必须在 faceNormalNode 之后定义（否则 TDZ）
  const fnAt = code.indexOf('const faceNormalNode = ');
  const gainAt = code.indexOf('const cloudFaceK = ');
  assertTrue(fnAt >= 0 && gainAt > fnAt, 'cloudFaceK 必须在 faceNormalNode 之后（防 TDZ）');
});

test('daynight: _apply 不写 uCloudFaceContrast（三个 gain 与 style 无关）', async () => {
  const code = await codeOf('../render/daynight.js');
  assertTrue(!/uCloudFaceContrast/.test(code),
    'gain 是灰阶比例、与 style 无关 ⇒ 只由模块初值提供（同 uCloudAoFloor 口径）');
});

test('cloud uniforms: uCloudFaceContrast 初值 1 且与 v3.50 三个地板并列', async () => {
  const { CLOUD_SURFACE_UNIFORMS: U } = await import('../render/materials.js');
  assertEqual(U.uCloudFaceContrast.value, 1, '初值 1（满档面间对比）');
  assertEqual(U.uCloudSoften.value, 1, 'v3.50 柔和仍满档（两个旋钮独立）');
});
