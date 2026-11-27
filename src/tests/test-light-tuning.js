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
import { VISUAL_STYLES, paramsAtHour } from '../render/daynight.js';
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
  assertEqual(v.shadowFloor, 0.14, 'normal 影区地板');
  assertEqual(v.hemiGround, 0.12, 'normal 半球');
  assertEqual(v.sunIntensity, 0.956, 'normal 太阳强度');
  assertEqual(v.toneMappingExposure, 2.2, 'normal 曝光');
  assertEqual(v.punchGamma, ASHLAR_PUNCH_GAMMA, 'punch gamma 缺省取常量');
  assertEqual(v.punchSat, ASHLAR_PUNCH_SAT, 'punch sat 缺省取常量');
  assertEqual(v['waterTint'], VISUAL_STYLES.normal.waterTint[0], '水面亮度取 R 通道');
});

// ==================== ③ override 不污染权威 ====================

test('光影微调：applyTuningOverride 不改入参，且数组字段是新副本', () => {
  const src = VISUAL_STYLES.normal;
  const out = applyTuningOverride(src, { shadowFloor: 0.3, 'sunColor[0]': 1.5 });
  assertEqual(out.shadowFloor, 0.3, '返回值须带 override');
  assertEqual(out.sunColor[0], 1.5, '色温分量须带 override');
  // 权威一个字节不动
  assertEqual(src.shadowFloor, 0.14, 'VISUAL_STYLES.normal.shadowFloor 不得被改');
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
  assertTrue(lines.includes('强光，sunIntensity: 0.956'), '须含用户举例的那一行');
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