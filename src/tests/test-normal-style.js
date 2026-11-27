// src/tests/test-normal-style.js — 「普通」环境风格（v3.44，ASHLAR 光影移植）Tier 1
//
// 设计文档：docs/superpowers/specs/2026-11-27-normal-env-style-ashlar-port-design.md
//
// 本文件守的是**静默失效**路径（数值全绿而画面错）：
//   ① `normalBlend` 混进自动日夜循环 ⇒ 玩家会在某个时段突然看到「普通」天空；
//   ② 三个新 uniform 在中性值下不逐位回到现状 ⇒ 其余四档与自动循环被静默改色；
//   ③ `shadowFloor` 与 `shadowKill` 的归一化分母不同步 ⇒ 影区地板与「太阳被拿走的比例」撕裂；
//   ④ `nightBlend` 漏写显式 0 ⇒ 从 skyDim 倒算，天空混入星空（dusk 那轮踩过）；
//   ⑤ `skyDim` 与 `uShadowStrength` 不同源 ⇒ 阴影浓度与 skylight 亮度撕裂（两者共用同一个值）。
//
// ⚠️ 判据选型：④ 不能只钉「混合结果为 0」—— v3.53 起 skyDim=0.95 倒算得 0.0667（非 0），
//    故先钉「倒算值非 0」作前提，再钉「显式字段存在且为 0」。
// ⚠️ v3.53（用户 2026-11-27 实调）重标了三条旧不变式：skyDim 1→0.95、
//    shadowFloor 「低于正午」→ 0.399（高于正午 0.38）、直射/环境比「>正午×1.5」→ >正午。
//    重标理由与新实测值见 `docs/roadmap.md` v3.53 行。
import { test } from './runner.js';
import { assertEqual, assertTrue } from './assert.js';
import {
  paramsAtHour, VISUAL_STYLES, VISUAL_STYLE_KEYS, DayNight, nightBlendOf,
} from '../render/daynight.js';
import {
  SHADOW_FLOOR, SUN_AMBIENT, SUN_INTENSITY, FACE_NORMALS, NOON_SUN_DIR,
  sunTermRGBFor, sunTermFor,
} from '../render/sun-shade.js';
import { HEMI_GROUND, hemiFactorFor } from '../render/hemi-shade.js';

/** 独立算一份归一化期望值（测试自有算术，不消费实现里的函数） */
function normalize(v) {
  const len = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
  return [v[0] / len, v[1] / len, v[2] / len];
}

/** DayNight 的 stub（无 three）：只给本文件要观测的句柄 */
function makeStub(opts = {}) {
  const voxelUniforms = {
    uSkyDim: { value: 0 },
    uBlockBoost: { value: 0 },
    uShadowStrength: { value: 0 },
    uShadowFloor: { value: 0 },
    uHemiGround: { value: 0 },
    uSunIntensity: { value: 0 },
  };
  const dayNight = new DayNight({
    scene: {},
    fog: { fogColor: { value: { set() {} } }, fogNear: { value: 0 }, fogFar: { value: 0 } },
    voxelUniforms,
    ...opts,
  });
  return { dayNight, voxelUniforms };
}

// ==================== ① 风格存在性与档位口径 ====================

test('normal：风格数据齐全（先钉存在性，其余断言才有意义）', () => {
  assertTrue(VISUAL_STYLES.normal !== undefined, 'VISUAL_STYLES.normal 必须存在');
  assertTrue(VISUAL_STYLE_KEYS.NORMAL !== undefined, 'VISUAL_STYLE_KEYS.NORMAL 必须存在');
});

test('normal：风格键存在且风格表恰为五项', () => {
  assertEqual(VISUAL_STYLE_KEYS.NORMAL, 'normal', 'VISUAL_STYLE_KEYS 须有 NORMAL');
  const keys = Object.keys(VISUAL_STYLES).sort();
  // 字典序：noon < normal（第 3 字符 o < r）
  assertEqual(keys.join(','), 'dusk,morning,night,noon,normal', '风格表应为这五项');
});

test('normal：UI 档位在末位（既有「傍晚紧挨正午」关系式不受影响）', async () => {
  const { VISUAL_STYLE_OPTIONS } = await import('../ui/settings.js');
  assertEqual(VISUAL_STYLE_OPTIONS[0], null, '「自动」仍在首位');
  assertEqual(VISUAL_STYLE_OPTIONS.at(-1), 'normal', '「普通」在末位（用户裁定）');
  const idxNoon = VISUAL_STYLE_OPTIONS.indexOf('noon');
  assertEqual(VISUAL_STYLE_OPTIONS[idxNoon + 1], 'dusk', '「傍晚」仍紧挨「正午」右边');
});

// ==================== ② 不参与日夜轮转（本档最重要的不变式） ====================

test('normal：自动日夜循环全程 normalBlend=0（普通只能手动选）', () => {
  for (let h = 0; h <= 24; h += 0.25) {
    const p = paramsAtHour(h);
    assertEqual(p.normalBlend, 0, `h=${h} 的 normalBlend 必须为 0`);
  }
});

test('normal：KEYFRAMES 仍只引用 morning/noon/night（不引入新关键帧）', () => {
  // 判据落在「插值端点必是这三档之一」上：取整点小时的参数与三档原值比对，
  // 平台段（noon 9~17）必须逐位等于 noon 原值。
  const n = VISUAL_STYLES.noon;
  const p = paramsAtHour(12);
  assertEqual(p.skyDim, n.skyDim, '正午平台段 skyDim 取 noon 原值');
  assertEqual(p.toneMappingExposure, n.toneMappingExposure, '正午曝光取 noon 原值');
  assertEqual(p.normalBlend, 0, '正午 normalBlend 为 0');
  assertEqual(p.duskBlend, 0, '正午 duskBlend 为 0');
});

test('normal：只有 normal 档的 normalBlend 为 1，其余四档为 0', () => {
  assertEqual(VISUAL_STYLES.normal.normalBlend, 1, 'normal 档自己必须是 1');
  for (const key of ['morning', 'noon', 'dusk', 'night']) {
    assertEqual(VISUAL_STYLES[key].normalBlend || 0, 0, `${key}.normalBlend 须为 0/缺省`);
  }
});

// ==================== ③ skyDim 与阴影浓度的耦合（builder check 发现） ====================
//
// ⚠️ v3.53 重标：用户 2026-11-27 实调取 skyDim **0.95**（v3.44 的「必须为 1」作废）。
// 判据语义不变 —— 仍钉「两个 uniform 同源」，只是期望值从 1 改成 0.95。

test('normal：skyDim 取用户实调值 0.95，且 blockBoost 仍为户外基准 1', () => {
  const s = VISUAL_STYLES.normal;
  assertEqual(s.skyDim, 0.95, 'normal.skyDim 须为 0.95（v3.53 用户实调）');
  assertEqual(s.blockBoost, 1, 'normal.blockBoost 须为 1（户外基准）');
});

test('normal：apply 后 uShadowStrength 与 uSkyDim 同源（都读回 0.95）', () => {
  const { dayNight, voxelUniforms } = makeStub();
  dayNight.setStyle('normal');
  // 耦合本身是判据：两个 uniform 必须等于同一个 skyDim，不得只改其一。
  assertEqual(voxelUniforms.uShadowStrength.value, VISUAL_STYLES.normal.skyDim,
    '开阴影时浓度须等于本档 skyDim');
  assertEqual(voxelUniforms.uSkyDim.value, VISUAL_STYLES.normal.skyDim, 'skylight 吃同一个值');
  assertEqual(voxelUniforms.uShadowStrength.value, voxelUniforms.uSkyDim.value,
    '两个 uniform 必须逐位相等（耦合不得被拆）');
});

// ==================== ④ nightBlend 必须显式给 0 ====================

test('normal：nightBlend 显式为 0（不能靠 skyDim 倒算）', () => {
  const s = VISUAL_STYLES.normal;
  // ☠️ v3.53 起这条**不再是恒真判据**：skyDim=0.95 时倒算得 0.0667（非 0），
  // 所以显式字段现在真的在拦住「天空混入 6.7% 星空」。下面先钉住这个前提。
  const derived = nightBlendOf({ skyDim: s.skyDim });
  assertTrue(derived > 0.05,
    `前提：本档 skyDim 倒算必须非 0（否则本用例恒真）：实测 ${derived}`);
  assertTrue(Object.prototype.hasOwnProperty.call(s, 'nightBlend'),
    'normal 必须显式写 nightBlend 字段（缺省会从 skyDim 倒算）');
  assertEqual(typeof s.nightBlend, 'number', 'nightBlend 须是数值（0 是合法显式值）');
  assertEqual(s.nightBlend, 0, 'normal 不叠星空');
  assertEqual(nightBlendOf(s), 0, '混合结果为 0（显式值赢过倒算）');
});

test('normal：duskBlend 为 0（不叠黄昏天空盒）', () => {
  assertEqual(VISUAL_STYLES.normal.duskBlend, 0, 'normal 不叠 dusk');
});

// ==================== ⑤ 三个新 uniform：中性值逐位零回归 ====================

test('normal：风格数据带 shadowFloor / hemiGround / sunIntensity 三个新字段', () => {
  const s = VISUAL_STYLES.normal;
  for (const f of ['shadowFloor', 'hemiGround', 'sunIntensity']) {
    assertEqual(typeof s[f], 'number', `normal.${f} 须是数值`);
    assertTrue(s[f] > 0, `normal.${f} 须为正：${s[f]}`);
  }
});

test('normal：直射/环境比高于正午（本档立体感的来源之一）', () => {
  const s = VISUAL_STYLES.normal;
  const sunDir = normalize(s.sunDirection);
  // 顶面 N·L（本档太阳方向的 y 分量）
  const normalRatio = (s.sunIntensity * sunDir[1]) / s.shadowFloor;
  const noonRatio = (SUN_INTENSITY * NOON_SUN_DIR[1]) / SHADOW_FLOOR;
  // ⚠️ v3.53 重标：旧断言「> 正午 ×1.5」作废 —— 用户实调取更柔的对比，
  // 实测 1.7223 vs 正午 1.6316。下界 1.65 防滑回正午水平（那时 per-style 等于白写）。
  assertTrue(normalRatio > noonRatio,
    `普通档直射/环境比须高于正午：normal=${normalRatio.toFixed(4)} noon=${noonRatio.toFixed(4)}`);
  assertTrue(normalRatio > 1.65,
    `普通档比值须 >1.65（防滑回正午水平）：实测 ${normalRatio.toFixed(4)}`);
});

test('normal：影区地板取实调值 0.399，立体感靠半球方向性而不是压黑影区', () => {
  const s = VISUAL_STYLES.normal;
  // ⚠️ v3.53：旧断言「地板须低于正午 0.38」作废（新值 0.399 高于它）。
  // 改成钉住实调值 + 保留「半球方向性仍远强于正午」这条真正承载立体感的判据。
  assertEqual(s.shadowFloor, 0.399, 'normal 影区地板须为 0.399（v3.53 用户实调）');
  assertTrue(s.hemiGround < HEMI_GROUND,
    `普通档半球地面因子须低于正午 ${HEMI_GROUND}：实测 ${s.hemiGround}`);
  assertTrue(s.hemiGround < HEMI_GROUND * 0.5,
    `普通档半球方向性须显著强于正午（至少两倍）：实测 ${s.hemiGround} vs ${HEMI_GROUND}`);
});

test('新 uniform：缺省（不传）时 sunTermRGBFor 逐位等于现有常量口径', () => {
  // 零回归锚点：其余四档与自动循环不写这三个字段 ⇒ CPU 参考实现必须回落现有常量。
  // 期望值由**测试自有的算术**算出（不消费实现里的函数），否则两侧共用同一错误假设会恒真。
  for (let i = 0; i < 6; i++) {
    const n = FACE_NORMALS[i];
    const dot = Math.max(n[0] * NOON_SUN_DIR[0] + n[1] * NOON_SUN_DIR[1] + n[2] * NOON_SUN_DIR[2], 0);
    const want = SUN_AMBIENT + SUN_INTENSITY * dot; // strength=1 / shadowKill=1 / 中性色
    const got = sunTermRGBFor(i, NOON_SUN_DIR, 1, 1);
    for (let c = 0; c < 3; c++) {
      assertTrue(Math.abs(got[c] - want) < 1e-12,
        `面 ${i} 通道 ${c} 缺省须等于常量口径 ${want}：实测 ${got[c]}`);
    }
  }
});

test('新 uniform：显式传入 floor/intensity 时公式真的改变（判据非恒真）', () => {
  const s = VISUAL_STYLES.normal;
  const sunDir = normalize(s.sunDirection);
  const base = sunTermRGBFor(2, sunDir, 1, 1)[0];
  const styled = sunTermRGBFor(2, sunDir, 1, 1, undefined, undefined, {
    shadowFloor: s.shadowFloor, sunIntensity: s.sunIntensity,
  })[0];
  assertTrue(Math.abs(styled - base) > 1e-6,
    `传入普通档参数后顶面 sunTerm 必须变化：base=${base} styled=${styled}`);
});

test('新 uniform：shadowKill=0（影区）时顶面回到本档地板，不是全局常量', () => {
  const s = VISUAL_STYLES.normal;
  const sunDir = normalize(s.sunDirection);
  const shadowed = sunTermRGBFor(2, sunDir, 1, 0, undefined, undefined, {
    shadowFloor: s.shadowFloor, sunIntensity: s.sunIntensity,
  })[0];
  assertTrue(Math.abs(shadowed - s.shadowFloor) < 1e-12,
    `影区顶面须等于本档地板 ${s.shadowFloor}：实测 ${shadowed}`);
  // 关键：它**不等于**全局 SHADOW_FLOOR（证明 per-style 真的生效）
  assertTrue(Math.abs(shadowed - SHADOW_FLOOR) > 1e-6,
    '影区地板不得仍是全局常量（那说明 per-style 没生效）');
});

test('新 uniform：strength=0 时仍逐位回到 1（关方向光的零回归锚点）', () => {
  const s = VISUAL_STYLES.normal;
  const sunDir = normalize(s.sunDirection);
  for (let i = 0; i < 6; i++) {
    const v = sunTermRGBFor(i, sunDir, 0, 1, undefined, undefined, {
      shadowFloor: s.shadowFloor, sunIntensity: s.sunIntensity,
    });
    for (let c = 0; c < 3; c++) assertEqual(v[c], 1, `面 ${i} 通道 ${c} 关掉方向光须为 1`);
  }
});

test('新 uniform：标量版 sunTermFor 仍是 RGB 版在中性色下的 R 通道（不留第二份公式）', () => {
  // 判据：两个函数对同一输入必须给出同一个数（独立调用，不是自比）。
  // 参数取会产生非整比值的太阳方向，避开恒等输入。
  const dir = normalize([0.31, 0.72, 0.62]);
  for (let i = 0; i < 6; i++) {
    const scalar = sunTermFor(i, dir, 1, 1);
    const rgbR = sunTermRGBFor(i, dir, 1, 1)[0];
    assertTrue(Math.abs(scalar - rgbR) < 1e-12,
      `面 ${i} 标量版 ${scalar} 须等于 RGB 版 R 通道 ${rgbR}`);
  }
});

// ==================== ⑥ 既有遍历断言对新档的硬要求 ====================

test('normal：月亮方位 = 本档太阳方位，仰角 35.4241°（既有全局不变式）', () => {
  const s = VISUAL_STYLES.normal;
  const m = normalize(s.moonDirection), sd = normalize(s.sunDirection);
  const mAz = Math.atan2(m[0], m[2]) * 180 / Math.PI;
  const sAz = Math.atan2(sd[0], sd[2]) * 180 / Math.PI;
  const mElev = Math.asin(m[1]) * 180 / Math.PI;
  assertTrue(Math.abs(mElev - 35.4241) < 0.01, `月亮仰角须 35.4241°：实测 ${mElev.toFixed(4)}`);
  assertTrue(Math.abs(mAz - sAz) < 0.01, `月亮方位须等于太阳方位：moon=${mAz.toFixed(4)} sun=${sAz.toFixed(4)}`);
  assertEqual(s.moonVisible, false, '普通档（白昼）不画月亮');
});

test('normal：色温三分量齐全，且暖直射 + 冷环境（上游 SH 的色相方向）', () => {
  const s = VISUAL_STYLES.normal;
  for (const f of ['sunColor', 'ambientColor']) {
    assertTrue(Array.isArray(s[f]) && s[f].length === 3, `normal.${f} 须是三分量数组`);
  }
  assertTrue(s.sunColor[0] > s.sunColor[2],
    `直射须偏暖（R>B）：${s.sunColor.join(',')}`);
  assertTrue(s.ambientColor[2] > s.ambientColor[0],
    `环境须偏冷（B>R）：${s.ambientColor.join(',')}`);
});

test('normal：ambientColor 冷色幅度取 0.35（用户裁定，避免石头变蓝砖）', () => {
  const s = VISUAL_STYLES.normal;
  const a = s.ambientColor;
  // 幅度 0.35 的标定：原色相 [0.584,0.929,1.487] → 1+(v-1)*0.35
  const want = [0.584, 0.929, 1.487].map((v) => 1 + (v - 1) * 0.35);
  for (let c = 0; c < 3; c++) {
    assertTrue(Math.abs(a[c] - want[c]) < 0.02,
      `ambientColor[${c}] 须落在幅度 0.35 的标定值 ${want[c].toFixed(3)} 附近：实测 ${a[c]}`);
  }
  const mean = (a[0] + a[1] + a[2]) / 3;
  assertTrue(Math.abs(mean - 1) < 0.02, `环境色温均值须 ≈1（只改色相不改曝光）：${mean.toFixed(4)}`);
});

test('normal：waterTint 三分量相等且落在 (0.15,1]（既有全局不变式）', () => {
  const t = VISUAL_STYLES.normal.waterTint;
  assertTrue(Array.isArray(t) && t.length === 3, 'waterTint 须是三分量数组');
  for (const v of t) assertTrue(v > 0.15 && v <= 1.0, `waterTint 分量须在 (0.15,1]：${v}`);
  assertTrue(Math.abs(t[0] - t[1]) < 1e-9 && Math.abs(t[1] - t[2]) < 1e-9,
    `waterTint 三通道须相等（只调亮度不改色相）：${t.join(',')}`);
});

test('normal：曝光高于正午（暗部不死黑），且取实调值 1.63', () => {
  const s = VISUAL_STYLES.normal;
  assertEqual(s.toneMappingExposure, 1.63, 'normal 曝光须为 1.63（v3.53 用户实调）');
  assertTrue(s.toneMappingExposure > VISUAL_STYLES.noon.toneMappingExposure,
    `普通档曝光须高于正午：normal=${s.toneMappingExposure} noon=${VISUAL_STYLES.noon.toneMappingExposure}`);
});

// ==================== ⑥b v3.53：punch 两参数 per-style 化 ====================
//
// ☠️ **为什么不改全局常量**：`ASHLAR_PUNCH_GAMMA/SAT` 同时被离线天空烘焙
// （`tools/normal-sky-tonemap.mjs`）消费 ⇒ 改它们会让 `check:data` 判贴图过期、要重烘六面。
// 写成 per-style 字段后产物与指纹逐位不动，其余四档仍回落常量。

test('normal：punch 两参数显式写本档值，其余四档不写（零回归）', async () => {
  const { ASHLAR_PUNCH_GAMMA, ASHLAR_PUNCH_SAT } = await import('../render/ashlar-tonemap-config.js');
  const s = VISUAL_STYLES.normal;
  assertEqual(s.punchGamma, 1.34, 'normal.punchGamma 须为 1.34（用户实调）');
  assertEqual(s.punchSat, 0.94, 'normal.punchSat 须为 0.94（用户实调）');
  // 全局常量一个字节不动（烘焙输入不变 ⇒ 不重烘）
  assertEqual(ASHLAR_PUNCH_GAMMA, 1.28, '全局 gamma 常量仍 1.28（烘焙契约）');
  assertEqual(ASHLAR_PUNCH_SAT, 1.17, '全局 sat 常量仍 1.17（烘焙契约）');
  // 本档值必须真的偏离常量（否则上面两条是恒真判据）
  assertTrue(s.punchGamma !== ASHLAR_PUNCH_GAMMA && s.punchSat !== ASHLAR_PUNCH_SAT,
    '本档 punch 必须偏离全局常量（否则 per-style 化无意义）');
  for (const key of ['morning', 'noon', 'dusk', 'night']) {
    assertTrue(VISUAL_STYLES[key].punchGamma === undefined,
      `${key} 不得写 punchGamma（缺省回落常量，零回归）`);
    assertTrue(VISUAL_STYLES[key].punchSat === undefined,
      `${key} 不得写 punchSat`);
  }
});

test('normal：_apply 把本档 punch 写给句柄，切回正午回落全局常量', async () => {
  const { ASHLAR_PUNCH_GAMMA, ASHLAR_PUNCH_SAT } = await import('../render/ashlar-tonemap-config.js');
  const punchUniforms = { uPunchGamma: { value: 0 }, uPunchSat: { value: 0 } };
  const { dayNight } = makeStub({ visualStyle: 'normal', punchUniforms });
  assertEqual(punchUniforms.uPunchGamma.value, 1.34, '构造首帧就写本档 gamma');
  assertEqual(punchUniforms.uPunchSat.value, 0.94, '构造首帧就写本档 sat');
  dayNight.setStyle('noon');
  assertEqual(punchUniforms.uPunchGamma.value, ASHLAR_PUNCH_GAMMA, '正午回落全局 gamma（不残留）');
  assertEqual(punchUniforms.uPunchSat.value, ASHLAR_PUNCH_SAT, '正午回落全局 sat');
  dayNight.setStyle('normal');
  assertEqual(punchUniforms.uPunchGamma.value, 1.34, '切回普通仍是本档值');
});

test('normal：自动日夜循环全程 punch 两字段恒 undefined（不混进插值）', () => {
  for (let h = 0; h <= 24; h += 0.5) {
    const p = paramsAtHour(h);
    assertTrue(p.punchGamma === undefined, `h=${h} 的 punchGamma 须缺省`);
    assertTrue(p.punchSat === undefined, `h=${h} 的 punchSat 须缺省`);
  }
});

// ==================== ⑦ 色调映射：per-style 且不残留 ====================

test('normal：风格数据指定 toneMapping，其余四档缺省（回落 ACES）', () => {
  const s = VISUAL_STYLES.normal;
  assertEqual(typeof s.toneMapping, 'number', 'normal.toneMapping 须是数值常量 id');
  for (const key of ['morning', 'noon', 'dusk', 'night']) {
    assertTrue(VISUAL_STYLES[key].toneMapping === undefined,
      `${key} 不得写 toneMapping（缺省回落 ACES，零回归）`);
  }
});

test('normal：_apply 把 toneMapping 写给 renderer，切回其余档恢复 ACES', async () => {
  // ⚠️ 从 **three-free 的 config** 取常量，不 import `ashlar-tonemap.js`（它 import three，
  // 会把本文件踢出 Node 白名单）。
  const { ACES_FILMIC_TONE_MAPPING } = await import('../render/ashlar-tonemap-config.js');
  const writes = [];
  const renderer = {
    set toneMapping(v) { writes.push(['tm', v]); },
    get toneMapping() { return writes.filter((w) => w[0] === 'tm').at(-1)?.[1]; },
    set toneMappingExposure(v) { writes.push(['exp', v]); },
  };
  const { dayNight } = makeStub({ renderer });
  dayNight.setStyle('normal');
  const normalTm = VISUAL_STYLES.normal.toneMapping;
  assertEqual(renderer.toneMapping, normalTm, 'normal 档须写入自定义 toneMapping');
  dayNight.setStyle('noon');
  assertEqual(renderer.toneMapping, ACES_FILMIC_TONE_MAPPING,
    '切回正午须恢复 ACES（per-style 不残留）');
});

// ==================== ⑧ 天空盒清单与混合层 ====================

test('normal：天空盒清单登记第 5 套 normal', async () => {
  const { SKY_SETS } = await import('../render/sky-config.js');
  assertEqual(typeof SKY_SETS.normal, 'string', 'SKY_SETS 须有 normal');
  assertTrue(SKY_SETS.normal.endsWith('/normal'), `路径须指向 normal 目录：${SKY_SETS.normal}`);
  assertEqual(Object.keys(SKY_SETS).length, 5, '共五套立方图');
});

test('normal：params 的 normalBlend 经 get params 返回（不改权威原值）', () => {
  const { dayNight } = makeStub();
  dayNight.setStyle('normal');
  const p = dayNight.params;
  assertEqual(p.normalBlend, 1, 'override 模式下 normalBlend 为 1');
  // 数组字段必须是新数组（既有红线：不得把权威原值暴露给调用方）
  p.sunColor[0] = 999;
  assertEqual(VISUAL_STYLES.normal.sunColor[0] !== 999, true, 'sunColor 须是拷贝');
});

test('normal：构造即生效（首帧就是普通档，不等外部补 setStyle）', () => {
  const { dayNight, voxelUniforms } = makeStub({ visualStyle: 'normal' });
  assertEqual(voxelUniforms.uShadowFloor.value, VISUAL_STYLES.normal.shadowFloor,
    '构造首帧就要写入本档地板');
  assertEqual(voxelUniforms.uHemiGround.value, VISUAL_STYLES.normal.hemiGround,
    '构造首帧就要写入本档半球因子');
  assertEqual(voxelUniforms.uSunIntensity.value, VISUAL_STYLES.normal.sunIntensity,
    '构造首帧就要写入本档太阳强度');
  assertEqual(dayNight._styleOverride, 'normal', 'override 已就位');
});

test('新 uniform：其余四档 apply 后三个 uniform 回落现有常量（零回归）', () => {
  for (const key of ['morning', 'noon', 'dusk', 'night']) {
    const { dayNight, voxelUniforms } = makeStub();
    dayNight.setStyle(key);
    assertEqual(voxelUniforms.uShadowFloor.value, SHADOW_FLOOR, `${key} 地板须回落 ${SHADOW_FLOOR}`);
    assertEqual(voxelUniforms.uHemiGround.value, HEMI_GROUND, `${key} 半球须回落 ${HEMI_GROUND}`);
    assertEqual(voxelUniforms.uSunIntensity.value, SUN_INTENSITY, `${key} 强度须回落 ${SUN_INTENSITY}`);
  }
});

test('新 uniform：日夜循环 apply 后三个 uniform 恒为现有常量', () => {
  const { dayNight, voxelUniforms } = makeStub();
  for (const h of [0, 6, 7, 12, 19, 21]) {
    dayNight.setTime(h);
    assertEqual(voxelUniforms.uShadowFloor.value, SHADOW_FLOOR, `h=${h} 地板须为常量`);
    assertEqual(voxelUniforms.uHemiGround.value, HEMI_GROUND, `h=${h} 半球须为常量`);
    assertEqual(voxelUniforms.uSunIntensity.value, SUN_INTENSITY, `h=${h} 强度须为常量`);
  }
});

// ==================== ⑩ shadowKill 分母同步（本轮最易静默失效的一条） ====================

test('shadowKill：分母用本档地板时，影区恰好拿走全部太阳', async () => {
  const { shadowKillFor } = await import('../render/sun-shade.js');
  const s = VISUAL_STYLES.normal;
  // 影区：shadowFactor = 本档地板 ⇒ shadowKill 必须为 0
  assertTrue(Math.abs(shadowKillFor(s.shadowFloor, s.shadowFloor)) < 1e-12,
    `影区 shadowKill 须为 0：实测 ${shadowKillFor(s.shadowFloor, s.shadowFloor)}`);
  // 受光：shadowFactor = 1 ⇒ shadowKill 必须为 1
  assertTrue(Math.abs(shadowKillFor(1, s.shadowFloor) - 1) < 1e-12, '受光区 shadowKill 须为 1');
});

test('shadowKill：分母不同步会压掉半影中间调（实测缺陷形态）', async () => {
  const { shadowKillFor } = await import('../render/sun-shade.js');
  const s = VISUAL_STYLES.normal;
  // ⚠️ **两个端点完全一致**（影区 0 / 受光 1）⇒ 只钉端点是**恒真判据**。
  //
  // ☠️ v3.53 重标：本档地板从 0.14 抬到 **0.399**，与全局 0.38 只差 **0.019**
  // ⇒ 旧判据「中间调绝对差 > 0.1」在结构上不可能成立（实测最大绝对差仅 0.0306），
  // 且旧取样点 0.3 已**低于新地板** ⇒ 两侧都被 clamp 成 0，判据彻底失效。
  // 换成**相对口径** + **紧贴地板上方取样**（判别力最大处，实测相对差 94.8%）：
  //   shadowFactor 0.400：同步 0.001664 / 不同步 0.032258
  //   shadowFactor 0.500：同步 0.168053 / 不同步 0.193548
  const mid = s.shadowFloor + 0.001;
  const synced = shadowKillFor(mid, s.shadowFloor);
  const desync = shadowKillFor(mid, SHADOW_FLOOR);
  assertTrue(desync > 0.01,
    `前提：错用全局分母时该取样点须真的拿到太阳（否则本用例恒真）：实测 ${desync.toFixed(6)}`);
  assertTrue(synced < desync * 0.2,
    `同步时紧贴地板处该几乎拿不到太阳（分母撕裂会多拿 5 倍以上）：同步 ${synced.toFixed(6)} vs 不同步 ${desync.toFixed(6)}`);
  // 中段也钉一条（证明差异不只在地板附近）
  const mid2 = 0.5;
  const s2 = shadowKillFor(mid2, s.shadowFloor), d2 = shadowKillFor(mid2, SHADOW_FLOOR);
  assertTrue(s2 > 0.1 && s2 < d2,
    `中段同步值须保留部分太阳且小于错分母值：同步 ${s2.toFixed(6)} vs 不同步 ${d2.toFixed(6)}`);
  // 端点一致性：受光端恒为 1（clamp 上界不得因 per-style 而跑飞）
  assertTrue(Math.abs(shadowKillFor(1, SHADOW_FLOOR) - 1) < 1e-12,
    '受光端点仍为 1（所以端点判据拓不到本缺陷）');
  // ☠️ 影区端点在**错分母**下不再是 0（旧档差 0.6129，新档仅 0.0306）——
  // 这正是「绝对差判据失效」的量化证据，钉住它防将来又把判据改回绝对口径。
  const endpointLeak = shadowKillFor(s.shadowFloor, SHADOW_FLOOR);
  assertTrue(endpointLeak > 0 && endpointLeak < 0.1,
    `错分母时影区端点泄漏须落在 (0, 0.1)（新地板靠近全局值）：实测 ${endpointLeak.toFixed(6)}`);
});

test('shadowKill：缺省地板时逐位回到全局常量口径（零回归）', async () => {
  const { shadowKillFor } = await import('../render/sun-shade.js');
  for (const f of [SHADOW_FLOOR, 0.5, 0.7, 1.0]) {
    const want = Math.min(1, Math.max(0, 1 - (1 - f) / (1 - SHADOW_FLOOR)));
    assertTrue(Math.abs(shadowKillFor(f) - want) < 1e-12,
      `shadowFactor=${f} 缺省口径须为 ${want}：实测 ${shadowKillFor(f)}`);
  }
});

test('shadowKill：floor→1（关阴影档）不产 NaN/Inf', async () => {
  const { shadowKillFor } = await import('../render/sun-shade.js');
  const v = shadowKillFor(1, 1);
  assertTrue(Number.isFinite(v), `floor=1 时须退化为有限值：实测 ${v}`);
  assertEqual(v, 1, 'floor=1 等于关阴影 ⇒ 太阳全保留');
});

// ==================== ⑪ 半球因子与面法线序（既有不变式不得被破坏） ====================

test('normal：hemiFactorFor 用本档 ground 时朝上仍为 1（零回归锚点）', () => {
  const s = VISUAL_STYLES.normal;
  assertEqual(hemiFactorFor(2, s.hemiGround), 1, '朝上面因子恒 1');
  assertEqual(hemiFactorFor(3, s.hemiGround), s.hemiGround, '朝下面因子 = 本档 ground');
  const side = hemiFactorFor(0, s.hemiGround);
  assertTrue(Math.abs(side - (s.hemiGround + 1) / 2) < 1e-12, '四侧面取中值');
});

test('normal：SUN_AMBIENT 与 SHADOW_FLOOR 仍恒等（全局常量语义未被破坏）', () => {
  assertEqual(SUN_AMBIENT, SHADOW_FLOOR, '两个全局常量必须仍相等');
  assertEqual(SHADOW_FLOOR, 0.38, '全局地板仍是 0.38（per-style 化不改它）');
  assertTrue(Math.abs(SUN_INTENSITY - 0.775) < 1e-12, '全局强度仍是 0.775');
  assertEqual(HEMI_GROUND, 0.6, '全局半球仍是 0.6');
  assertEqual(FACE_NORMALS[2].join(','), '0,1,0', '面法线序未变');
});