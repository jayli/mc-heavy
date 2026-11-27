// src/tests/test-light-tuning.js — 「光影微调」Tab（v3.51）Tier 1
//
// 设计文档：docs/superpowers/specs/2026-11-27-light-tuning-tab-design.md
//
// 本文件守的是**静默失效**路径（数值全绿而画面/交互错）：
//   ① 参数表与 DOM/复制文本漂移 ⇒ 滑块显示一个值而生效另一个；
//   ② `readTuningValues` 缺字段不回落全局常量 ⇒ 其余四档打开面板即被改色；
//   ③ `applyTuningOverride` 原地改 params ⇒ 污染 VISUAL_STYLES 权威（红线 1）；
//   ④ `shadowFloor` 上界取到 1 ⇒ `materials.js` 的 shadowKill 分母 (1−floor) 除零；
//   ⑤ `waterTint` 只写一个分量 ⇒ 违反「三通道必须相等」的既有全局断言（水面变色相）；
//   ⑥ 非法输入写进 uniform ⇒ 整屏 NaN（黑屏），且数值判据可能仍绿。
//
// ⚠️ 判据选型：③ 不能只断言「返回值对」—— 必须同时断言**入参未被改**且数组是新副本。
//    ⑥ 不能只测越界钳制 —— NaN/Infinity/字符串/未知 key 四类都要真返回 null。
import { test } from './runner.js';
import { assertEqual, assertTrue, assertNull } from './assert.js';
import {
  LIGHT_TUNING_PARAMS, LIGHT_TUNING_KEYS,
  readTuningValues, applyTuningOverride, clampTuningValue, formatTuningText,
} from '../render/light-tuning-config.js';
import { VISUAL_STYLES, paramsAtHour, DayNight } from '../render/daynight.js';
import { SHADOW_FLOOR, SUN_INTENSITY } from '../render/sun-shade.js';
import { HEMI_GROUND } from '../render/hemi-shade.js';
import { ASHLAR_PUNCH_GAMMA, ASHLAR_PUNCH_SAT } from '../render/ashlar-tonemap-config.js';

/** 表里按 key 取一项（断言用，找不到即硬失败 —— 不静默跳过） */
function defOf(key) {
  const d = LIGHT_TUNING_PARAMS.find((x) => x.key === key);
  assertTrue(d !== undefined, `参数表缺 key=${key}`);
  return d;
}

// ==================== ① 参数表契约 ====================

test('光影微调：参数表恰 15 项、key 唯一、左右列 8/7', () => {
  assertEqual(LIGHT_TUNING_PARAMS.length, 15, '参数表须 15 项');
  assertEqual(new Set(LIGHT_TUNING_KEYS).size, 15, 'key 不得重复');
  assertEqual(LIGHT_TUNING_KEYS.length, 15, 'KEYS 由表派生，长度一致');
  assertEqual(LIGHT_TUNING_PARAMS.filter((d) => d.col === 'left').length, 8, '左列 8 行');
  assertEqual(LIGHT_TUNING_PARAMS.filter((d) => d.col === 'right').length, 7, '右列 7 行');
});

test('光影微调：每项区间合法，且全部五档 + 自动循环的缺省值都落在区间内', () => {
  for (const d of LIGHT_TUNING_PARAMS) {
    assertTrue(d.min < d.max, `${d.key}: min(${d.min}) 须小于 max(${d.max})`);
    assertTrue(d.step > 0, `${d.key}: step 须为正`);
    assertTrue(typeof d.label === 'string' && d.label.length > 0, `${d.key}: 须有中文标题`);
    assertTrue(typeof d.varName === 'string' && d.varName.length > 0, `${d.key}: 须有变量名`);
  }
  const sources = [...Object.values(VISUAL_STYLES), paramsAtHour(12), paramsAtHour(0), paramsAtHour(19)];
  for (const p of sources) {
    const vals = readTuningValues(p);
    for (const d of LIGHT_TUNING_PARAMS) {
      const v = vals[d.key];
      assertTrue(Number.isFinite(v), `${d.key}: 读出非有限值 ${v}`);
      assertTrue(v >= d.min && v <= d.max,
        `${d.key}: 缺省值 ${v} 落在区间 [${d.min}, ${d.max}] 外`);
    }
  }
});

test('光影微调：shadowFloor 上界 ≤0.9（shadowKill 分母 1−floor 不得为 0）', () => {
  const d = defOf('shadowFloor');
  assertTrue(d.max <= 0.9, `shadowFloor 上界须 ≤0.9，实测 ${d.max}`);
  assertTrue(1 - d.max > 0, `分母 1−max 须为正，实测 ${1 - d.max}`);
});

test('光影微调：agxOnly 标记只落在 punch 两项', () => {
  const keys = LIGHT_TUNING_PARAMS.filter((d) => d.agxOnly).map((d) => d.key);
  assertEqual(keys.join(','), 'punchGamma,punchSat', '只有对比度/饱和度是 AgX 专属');
});

// ==================== ② 读值与回落 ====================

test('光影微调：readTuningValues 缺 per-style 字段时回落全局常量', () => {
  // noon 不写 shadowFloor / hemiGround / sunIntensity 三个字段
  assertEqual(VISUAL_STYLES.noon.shadowFloor, undefined, '前提：noon 确实不写该字段');
  const v = readTuningValues(VISUAL_STYLES.noon);
  assertEqual(v.shadowFloor, SHADOW_FLOOR, 'shadowFloor 回落全局');
  assertEqual(v.sunIntensity, SUN_INTENSITY, 'sunIntensity 回落全局');
  assertEqual(v.hemiGround, HEMI_GROUND, 'hemiGround 回落全局');
});

test('光影微调：readTuningValues 读 normal 档的实测标定值', () => {
  const v = readTuningValues(VISUAL_STYLES.normal);
  // v3.53 用户实调值（v3.44 的 0.14 / 0.956 / 2.2 已作废）
  assertEqual(v.shadowFloor, 0.399, 'normal 影区地板');
  assertEqual(v.hemiGround, 0.12, 'normal 半球');
  assertEqual(v.sunIntensity, 1.282, 'normal 太阳强度');
  assertEqual(v.toneMappingExposure, 1.63, 'normal 曝光');
  assertEqual(v.skyDim, 0.95, 'normal 天空亮度');
  // v3.53：punch 两项现在是**本档显式值**，不再等于全局常量
  assertEqual(v.punchGamma, 1.34, 'punch gamma 取本档实调值');
  assertEqual(v.punchSat, 0.94, 'punch sat 取本档实调值');
  assertTrue(v.punchGamma !== ASHLAR_PUNCH_GAMMA && v.punchSat !== ASHLAR_PUNCH_SAT,
    '本档 punch 必须偏离全局常量（否则上两条拓不到 per-style 没生效）');
  assertEqual(v['waterTint'], VISUAL_STYLES.normal.waterTint[0], '水面亮度取 R 通道');
});

test('光影微调：其余四档的 punch 仍回落全局常量（per-style 零回归）', () => {
  for (const key of ['morning', 'noon', 'dusk', 'night']) {
    const v = readTuningValues(VISUAL_STYLES[key]);
    assertEqual(v.punchGamma, ASHLAR_PUNCH_GAMMA, `${key} gamma 回落常量`);
    assertEqual(v.punchSat, ASHLAR_PUNCH_SAT, `${key} sat 回落常量`);
  }
  // 自动循环同样回落（KEYFRAMES 不引用 normal）
  const auto = readTuningValues(paramsAtHour(12));
  assertEqual(auto.punchGamma, ASHLAR_PUNCH_GAMMA, '自动循环 gamma 回落常量');
  assertEqual(auto.punchSat, ASHLAR_PUNCH_SAT, '自动循环 sat 回落常量');
});

// ==================== ③ override 不污染权威 ====================

test('光影微调：applyTuningOverride 不改入参，且数组字段是新副本', () => {
  const src = VISUAL_STYLES.normal;
  const out = applyTuningOverride(src, { shadowFloor: 0.3, 'sunColor[0]': 1.5 });
  assertEqual(out.shadowFloor, 0.3, '返回值须带 override');
  assertEqual(out.sunColor[0], 1.5, '色温分量须带 override');
  // 权威一个字节不动
  assertEqual(src.shadowFloor, 0.399, 'VISUAL_STYLES.normal.shadowFloor 不得被改');
  assertEqual(src.sunColor[0], 1.214, 'VISUAL_STYLES.normal.sunColor[0] 不得被改');
  assertTrue(out.sunColor !== src.sunColor, 'sunColor 必须是新数组');
  assertTrue(out.ambientColor !== src.ambientColor, 'ambientColor 必须是新数组');
  assertTrue(out.waterTint !== src.waterTint, 'waterTint 必须是新数组');
});

test('光影微调：空 overrides 时读值逐位不变（零回归锚点）', () => {
  for (const [name, p] of Object.entries(VISUAL_STYLES)) {
    const a = readTuningValues(p);
    const b = readTuningValues(applyTuningOverride(p, {}));
    for (const k of LIGHT_TUNING_KEYS) {
      assertEqual(b[k], a[k], `${name}.${k}: 空 override 不得改值`);
    }
  }
});

test('光影微调：waterTint 一个键写三个分量且三通道相等', () => {
  const out = applyTuningOverride(VISUAL_STYLES.normal, { waterTint: 0.42 });
  assertEqual(out.waterTint.length, 3, '仍是三分量');
  assertEqual(out.waterTint[0], 0.42, 'R');
  assertEqual(out.waterTint[1], 0.42, 'G');
  assertEqual(out.waterTint[2], 0.42, 'B');
  assertEqual(VISUAL_STYLES.normal.waterTint[0], 0.55, '权威 waterTint 未被改');
});

test('光影微调：applyTuningOverride 忽略未知 key', () => {
  const out = applyTuningOverride(VISUAL_STYLES.normal, { nope: 123, shadowFloor: 0.2 });
  assertEqual(out.nope, undefined, '未知 key 不得写进 params');
  assertEqual(out.shadowFloor, 0.2, '已知 key 正常写入');
});

// ==================== ④ 非法输入 ====================

test('光影微调：clampTuningValue 拒绝 NaN/Infinity/字符串/undefined/未知 key', () => {
  assertNull(clampTuningValue('shadowFloor', NaN), 'NaN');
  assertNull(clampTuningValue('shadowFloor', Infinity), 'Infinity');
  assertNull(clampTuningValue('shadowFloor', -Infinity), '-Infinity');
  assertNull(clampTuningValue('shadowFloor', '0.5'), '字符串');
  assertNull(clampTuningValue('shadowFloor', undefined), 'undefined');
  assertNull(clampTuningValue('shadowFloor', null), 'null');
  assertNull(clampTuningValue('nope', 1), '未知 key');
});

test('光影微调：clampTuningValue 越界钳到区间端点', () => {
  assertEqual(clampTuningValue('shadowFloor', 5), 0.9, '超上界钳到 max');
  assertEqual(clampTuningValue('shadowFloor', -1), 0, '低于下界钳到 min');
  assertEqual(clampTuningValue('shadowFloor', 0.3), 0.3, '区间内原值返回');
});

// ==================== ⑤ 复制文本格式 ====================

test('光影微调：formatTuningText 行数与逐行格式（用户指定的格式）', () => {
  const vals = readTuningValues(VISUAL_STYLES.normal);
  const text = formatTuningText(vals, 'normal');
  const lines = text.split('\n');
  assertEqual(lines.length, 16, '首行风格 + 15 项参数');
  assertEqual(lines[0], '风格，visualStyle: normal', '首行是风格键');
  assertTrue(lines.includes('强光，sunIntensity: 1.282'), '须含用户举例的那一行');
  for (const line of lines.slice(1)) {
    assertTrue(/^.+，[A-Za-z][\w[\]]*: -?\d+\.\d{3}$/.test(line),
      `行格式不符「参数名，变量名:值」：${line}`);
  }
  assertEqual(text.endsWith('\n'), false, '末尾不带换行');
});

test('光影微调：formatTuningText 自动循环时首行写 auto', () => {
  const text = formatTuningText(readTuningValues(paramsAtHour(12)), null);
  assertEqual(text.split('\n')[0], '风格，visualStyle: auto', 'null 风格键写 auto');
});

test('光影微调：formatTuningText 覆盖全部 15 个变量名（漏项 = 复制不全）', () => {
  const text = formatTuningText(readTuningValues(VISUAL_STYLES.normal), 'normal');
  for (const d of LIGHT_TUNING_PARAMS) {
    assertTrue(text.includes(`，${d.varName}: `), `复制文本漏了 ${d.varName}`);
  }
});

// ==================== ⑥ DayNight 集成：per-style override ====================

/**
 * DayNight 的 stub（无 three）。句柄形状必须与真实 uniform 一致：
 * 标量是 `{value}`，vec3 是 `{value:{set(x,y,z)}}` —— `_apply` 对 vec3 句柄调 `.value.set`。
 * ⚠️ 写成 `.setRGB` 会在真实页面白屏（既有教训），stub 里也只给 `set`。
 */
function makeDayNight(opts = {}) {
  const vec3 = () => ({ value: { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; } } });
  const voxelUniforms = {
    uSkyDim: { value: 0 },
    uBlockBoost: { value: 0 },
    uShadowStrength: { value: 0 },
    uShadowFloor: { value: 0 },
    uHemiGround: { value: 0 },
    uSunIntensity: { value: 0 },
    uSunDirection: vec3(),
    uSunColor: vec3(),
    uAmbientColor: vec3(),
  };
  const dayNight = new DayNight({
    scene: {},
    fog: { fogColor: { value: { set() {} } }, fogNear: { value: 0 }, fogFar: { value: 0 } },
    voxelUniforms,
    skyUniforms: { uWaterTint: vec3() },
    ...opts,
  });
  return { dayNight, voxelUniforms };
}

test('光影微调：setTuning 写 override 并立即生效', () => {
  const { dayNight, voxelUniforms } = makeDayNight({ visualStyle: 'normal' });
  assertEqual(voxelUniforms.uShadowFloor.value, 0.399, '前提：构造首帧就是 normal 值');
  assertEqual(dayNight.setTuning('shadowFloor', 0.3), 0.3, '返回生效值');
  assertEqual(voxelUniforms.uShadowFloor.value, 0.3, 'uniform 立即被写');
  assertEqual(dayNight.tuningValues.shadowFloor, 0.3, 'tuningValues 读回新值');
  assertEqual(dayNight.tuningStyleKey, 'normal', '当前风格键');
});

test('光影微调：setTuning 非法值不写（NaN 不得进 uniform）', () => {
  const { dayNight, voxelUniforms } = makeDayNight({ visualStyle: 'normal' });
  dayNight.setTuning('shadowFloor', 0.3);
  assertNull(dayNight.setTuning('shadowFloor', NaN), 'NaN 拒绝');
  assertEqual(voxelUniforms.uShadowFloor.value, 0.3, 'uniform 保持上一次的值');
  assertNull(dayNight.setTuning('nope', 1), '未知 key 拒绝');
  assertNull(dayNight.setTuning('shadowFloor', '0.5'), '字符串拒绝');
  assertEqual(voxelUniforms.uShadowFloor.value, 0.3, '仍不变');
});

test('光影微调：切风格互不污染，切回来还记得调过的值', () => {
  const { dayNight, voxelUniforms } = makeDayNight({ visualStyle: 'normal' });
  dayNight.setTuning('shadowFloor', 0.3);
  dayNight.setStyle('noon');
  assertEqual(voxelUniforms.uShadowFloor.value, SHADOW_FLOOR, '正午回落全局常量（不被 normal 的 override 污染）');
  dayNight.setStyle('normal');
  assertEqual(voxelUniforms.uShadowFloor.value, 0.3, '切回 normal 仍是调过的值');
});

test('光影微调：resetTuning 回到风格表缺省', () => {
  const { dayNight, voxelUniforms } = makeDayNight({ visualStyle: 'normal' });
  dayNight.setTuning('shadowFloor', 0.3);
  dayNight.setTuning('sunIntensity', 1.5);
  dayNight.resetTuning();
  assertEqual(voxelUniforms.uShadowFloor.value, 0.399, '地板回 normal 缺省');
  assertEqual(voxelUniforms.uSunIntensity.value, 1.282, '强度回 normal 缺省');
});

test('光影微调：override 全程不改 VISUAL_STYLES 权威', () => {
  const { dayNight } = makeDayNight({ visualStyle: 'normal' });
  dayNight.setTuning('shadowFloor', 0.3);
  dayNight.setTuning('sunColor[0]', 1.5);
  dayNight.setTuning('waterTint', 0.2);
  dayNight.setTuning('ambientColor[2]', 1.9);
  assertEqual(VISUAL_STYLES.normal.shadowFloor, 0.399, '风格表地板未被改');
  assertEqual(VISUAL_STYLES.normal.sunColor[0], 1.214, '风格表直射色未被改');
  assertEqual(VISUAL_STYLES.normal.waterTint[0], 0.55, '风格表水面亮度未被改');
  assertEqual(VISUAL_STYLES.normal.ambientColor[2], 1.170, '风格表环境色未被改');
});

test('光影微调：自动循环下 setTuning 冻结日夜推进，resetTuning 解冻', () => {
  const { dayNight, voxelUniforms } = makeDayNight();   // 无 visualStyle = 自动循环
  dayNight.setTuning('skyDim', 0.5);
  const h0 = dayNight.hour;
  dayNight.update(10); dayNight.update(10); dayNight.update(10);
  assertEqual(dayNight.hour, h0, '冻结后 hour 逐位不变');
  assertEqual(voxelUniforms.uSkyDim.value, 0.5, 'override 值稳得住（不被每帧插值抹掉）');
  dayNight.resetTuning();
  dayNight.update(10);
  assertTrue(dayNight.hour > h0, `解冻后 hour 须前进：${h0} → ${dayNight.hour}`);
});

test('光影微调：get params 带 override 且数组是新副本', () => {
  const { dayNight } = makeDayNight({ visualStyle: 'normal' });
  dayNight.setTuning('sunColor[0]', 1.5);
  const p = dayNight.params;
  assertEqual(p.sunColor[0], 1.5, 'params 带 override');
  assertTrue(p.sunColor !== VISUAL_STYLES.normal.sunColor, '必须是新数组');
  // 方向仍归一化（_apply 与消费方都依赖这个口径）
  const len = Math.sqrt(p.sunDirection[0] ** 2 + p.sunDirection[1] ** 2 + p.sunDirection[2] ** 2);
  assertTrue(Math.abs(len - 1) < 1e-9, `太阳方向须归一化，实测长度 ${len}`);
});

test('光影微调：不动任何滑块时 params 与风格表逐位一致（零回归锚点）', () => {
  const { dayNight } = makeDayNight({ visualStyle: 'normal' });
  const a = readTuningValues(dayNight.params);
  const b = readTuningValues(VISUAL_STYLES.normal);
  for (const k of LIGHT_TUNING_KEYS) {
    assertEqual(a[k], b[k], `${k}: 未调整时不得偏离风格表`);
  }
});

// ==================== ⑦ punch 两参数的运行时 uniform ====================
//
// ⚠️ **不 import `ashlar-tonemap.js`**（它 import three，Node 白名单跑不了）。
// 这里只测 DayNight 侧的**写入接线**，用 stub 句柄；TSL 曲线真的读 uniform
// 由 Tier 4（tests/light-tuning.spec.mjs 的像素对照）拓。

/** punch 句柄 stub（标量 uniform，与真实 `uniform(number)` 同形） */
function punchStub() {
  return { uPunchGamma: { value: 0 }, uPunchSat: { value: 0 } };
}

test('光影微调：_apply 把 punch 两值写给句柄', () => {
  const punchUniforms = punchStub();
  makeDayNight({ visualStyle: 'normal', punchUniforms });
  // v3.53：normal 档显式写 1.34 / 0.94（不再是全局常量）
  assertEqual(punchUniforms.uPunchGamma.value, VISUAL_STYLES.normal.punchGamma, 'gamma 首帧写入本档值');
  assertEqual(punchUniforms.uPunchSat.value, VISUAL_STYLES.normal.punchSat, 'sat 首帧写入本档值');
});

test('光影微调：setTuning(punchGamma) 真的改句柄', () => {
  const punchUniforms = punchStub();
  const { dayNight } = makeDayNight({ visualStyle: 'normal', punchUniforms });
  assertEqual(dayNight.setTuning('punchGamma', 1.6), 1.6, '返回生效值');
  assertEqual(punchUniforms.uPunchGamma.value, 1.6, 'uniform 被写');
  dayNight.setTuning('punchSat', 0.4);
  assertEqual(punchUniforms.uPunchSat.value, 0.4, 'sat 同理');
});

test('光影微调：punch 句柄缺失时不抛错（fixture / 尚未装配）', () => {
  const { dayNight } = makeDayNight({ visualStyle: 'normal' });   // 不传 punchUniforms
  assertEqual(dayNight.setTuning('punchSat', 1.3), 1.3, '仍返回生效值');
  assertEqual(dayNight.tuningValues.punchSat, 1.3, 'params 里有值（只是没句柄可写）');
});

test('光影微调：切回其余四档 punch 回落常量', () => {
  const punchUniforms = punchStub();
  const { dayNight } = makeDayNight({ visualStyle: 'normal', punchUniforms });
  dayNight.setTuning('punchGamma', 1.6);
  dayNight.setStyle('noon');
  assertEqual(punchUniforms.uPunchGamma.value, ASHLAR_PUNCH_GAMMA, '正午回落常量（零回归）');
  dayNight.setStyle('normal');
  assertEqual(punchUniforms.uPunchGamma.value, 1.6, '切回普通仍是调过的值');
});