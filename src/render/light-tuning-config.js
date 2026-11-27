// src/render/light-tuning-config.js — 「光影微调」Tab 的参数表与纯函数（**three-free**）
//
// 设计文档：docs/superpowers/specs/2026-11-27-light-tuning-tab-design.md
//
// ## 为什么单独成模块（与 shade-params.js / ashlar-tonemap-config.js 同一理由）
//
// ① 面板（`ui/settings-panel.js`）要按这张表建 DOM，而它**不得** import 渲染层的
//    three 依赖链；② Tier 1 单测与 Node 快档要能直接 import 它。
// 本模块只 import 其它 three-free 的常量模块 ⇒ 不可能把 three 传染进 UI 层。
//
// ## 单一权威（红线 1）
//
// **DOM、滑块初值、复位、复制文本全部从这张表派生**（照 `ui/water-reflect-dock.js`
// 的 `REFLECT_SLIDERS` 既有手法）。面板里不写第二份 key/范围/文案字面量。
//
// ## 语义边界
//
// 本模块只做「读当前值 / 施加 override / 钳制 / 格式化」四件纯事，**不碰任何 uniform**。
// 真正的写入收口点是 `DayNight._apply`（日夜循环每帧调它，绕过它写的值下一帧就被覆写
// —— `shadowEnabled` 那段注释记着这个已实测的静默失效）。
import { SHADOW_FLOOR, SUN_INTENSITY, HEMI_GROUND } from './shade-params.js';
import { ASHLAR_PUNCH_GAMMA, ASHLAR_PUNCH_SAT } from './ashlar-tonemap-config.js';

/**
 * 15 项参数定义。**顺序 = 左列 8 项后右列 7 项**（面板按 col 过滤后保持表内相对顺序）。
 *
 * 范围取值理由（都是「覆盖现有全部风格值 + 留调整余量」，不是凭空取整）：
 *   · `shadowFloor` 上界 **0.9 而非 1**：`materials.js` 的 shadowKill 拿
 *     `1 − uShadowFloor` 当归一化分母，取 1 会除零 ⇒ 整屏 NaN。
 *   · `sunIntensity` / 色温三通道上界 2：现有最大值是 normal 的 `sunColor[0] = 1.214`，
 *     留约 1.65 倍余量；下界 0 = 该项关闭（语义合法，sunTerm 退化到纯环境）。
 *   · `skyDim` 上界 1.5：现有最大 1.0（morning 0.8 / night 0.25）。
 *     ⚠️ 它**同时驱动 uShadowStrength**（`_apply` 把阴影浓度写成 skyDim）⇒ 调它会连带
 *     改阴影浓度，这是既有耦合，hint 里写明。
 *   · `waterTint` 三通道必须相等（既有全局断言：只调亮度不改色相）⇒ 一个键写三分量。
 *   · punch 两项只在 AgX 曲线（「普通」档）下有效 ⇒ `agxOnly` 标记，其余四档置灰。
 *
 * @typedef {{key: string, label: string, varName: string, min: number, max: number,
 *   step: number, col: 'left'|'right', hint: string, agxOnly?: boolean}} TuningDef
 */
export const LIGHT_TUNING_PARAMS = Object.freeze([
  // ---- 左列（8 行）：直射与影区 ----
  Object.freeze({
    key: 'sunIntensity', label: '强光', varName: 'sunIntensity',
    min: 0, max: 2, step: 0.001, col: 'left',
    hint: '直射光强度。越大迎光面越亮、明暗对比越强',
  }),
  Object.freeze({
    key: 'shadowFloor', label: '弱光（影区地板）', varName: 'shadowFloor',
    min: 0, max: 0.9, step: 0.001, col: 'left',
    hint: '影子里与背光面剩多少光。越小影子越黑（上界 0.9：再高会让阴影计算除零）',
  }),
  Object.freeze({
    key: 'sunColor[0]', label: '直射色 红', varName: 'sunColor[0]',
    min: 0, max: 2, step: 0.001, col: 'left',
    hint: '直射光色温的红分量。1 = 不改色相',
  }),
  Object.freeze({
    key: 'sunColor[1]', label: '直射色 绿', varName: 'sunColor[1]',
    min: 0, max: 2, step: 0.001, col: 'left',
    hint: '直射光色温的绿分量。1 = 不改色相',
  }),
  Object.freeze({
    key: 'sunColor[2]', label: '直射色 蓝', varName: 'sunColor[2]',
    min: 0, max: 2, step: 0.001, col: 'left',
    hint: '直射光色温的蓝分量。调低变暖（夕阳感）',
  }),
  Object.freeze({
    key: 'hemiGround', label: '环境光方向性', varName: 'hemiGround',
    min: 0, max: 1, step: 0.001, col: 'left',
    hint: '朝下面收到的环境光相对朝上面的比例。0 = 底面全黑，1 = 关闭半球差异',
  }),
  Object.freeze({
    key: 'ambientColor[0]', label: '环境色 红', varName: 'ambientColor[0]',
    min: 0, max: 2, step: 0.001, col: 'left',
    hint: '环境光色温的红分量。1 = 不改色相',
  }),
  Object.freeze({
    key: 'ambientColor[1]', label: '环境色 绿', varName: 'ambientColor[1]',
    min: 0, max: 2, step: 0.001, col: 'left',
    hint: '环境光色温的绿分量。1 = 不改色相',
  }),
  // ---- 右列（7 行）：环境与色调 ----
  Object.freeze({
    key: 'ambientColor[2]', label: '环境色 蓝', varName: 'ambientColor[2]',
    min: 0, max: 2, step: 0.001, col: 'right',
    hint: '环境光色温的蓝分量。调高让影子偏冷（灰蓝天光）',
  }),
  Object.freeze({
    key: 'toneMappingExposure', label: '整体曝光', varName: 'toneMappingExposure',
    min: 0.2, max: 4, step: 0.01, col: 'right',
    hint: '色调映射前的整体亮度。调高会把暗部提起来',
  }),
  Object.freeze({
    key: 'skyDim', label: '天空亮度', varName: 'skyDim',
    min: 0, max: 1.5, step: 0.01, col: 'right',
    hint: '天光亮度。⚠️ 它同时控制阴影浓度：调低会让影子一起变浅',
  }),
  Object.freeze({
    key: 'blockBoost', label: '火把增强', varName: 'blockBoost',
    min: 0.5, max: 2, step: 0.01, col: 'right',
    hint: '火把等方块光源的相对强度。夜里调高让室内更亮',
  }),
  Object.freeze({
    key: 'waterTint', label: '水面亮度', varName: 'waterTint',
    min: 0, max: 1.5, step: 0.01, col: 'right',
    hint: '海面/湖面的亮度乘数（三通道同步，只改亮度不改水色）',
  }),
  Object.freeze({
    key: 'punchGamma', label: '对比度', varName: 'punchGamma',
    min: 0.5, max: 2.5, step: 0.01, col: 'right', agxOnly: true,
    hint: 'AgX 曲线的对比强度。越大中间调被拉开越多（仅「普通」档生效）',
  }),
  Object.freeze({
    key: 'punchSat', label: '饱和度', varName: 'punchSat',
    min: 0, max: 2.5, step: 0.01, col: 'right', agxOnly: true,
    hint: '按亮度轴放大色度。0 = 灰度，1 = 不变（仅「普通」档生效）',
  }),
]);

/** 全部 key（由表派生，不写第二份清单） */
export const LIGHT_TUNING_KEYS = Object.freeze(LIGHT_TUNING_PARAMS.map((d) => d.key));

/** key → 定义（内部索引用；表是数组以保持顺序，Map 只为 O(1) 查） */
const BY_KEY = new Map(LIGHT_TUNING_PARAMS.map((d) => [d.key, d]));

/**
 * 从 `DayNight.get params` 形状读 15 个当前值。
 *
 * ⚠️ **缺字段必须回落 import 来的全局常量，不写字面量**（红线 1）：
 * 其余四档不写 `shadowFloor` / `hemiGround` / `sunIntensity` 三个 per-style 字段，
 * 它们的生效值由 `_apply` 回落常量决定 —— 这里必须用同一份常量，否则滑块显示的值
 * 与实际生效值不一致（「显示 0.38 而实际 0.14」这类静默漂移）。
 *
 * ⚠️ punch 两项**不在 params 里**（它们是色调映射的 uniform，不是风格字段）：
 * 本函数只给缺省 = 烘焙常量；有 override 时 `applyTuningOverride` 会把它们写进 params。
 *
 * @param {object} params VISUAL_STYLES[key] 或 paramsAtHour(h) 的结果
 * @returns {Record<string, number>}
 */
export function readTuningValues(params) {
  const p = params || {};
  const num = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
  const sun = p.sunColor || [1, 1, 1];
  const amb = p.ambientColor || [1, 1, 1];
  const water = p.waterTint || [1, 1, 1];
  return {
    sunIntensity: num(p.sunIntensity, SUN_INTENSITY),
    shadowFloor: num(p.shadowFloor, SHADOW_FLOOR),
    'sunColor[0]': num(sun[0], 1),
    'sunColor[1]': num(sun[1], 1),
    'sunColor[2]': num(sun[2], 1),
    hemiGround: num(p.hemiGround, HEMI_GROUND),
    'ambientColor[0]': num(amb[0], 1),
    'ambientColor[1]': num(amb[1], 1),
    'ambientColor[2]': num(amb[2], 1),
    toneMappingExposure: num(p.toneMappingExposure, 1),
    skyDim: num(p.skyDim, 1),
    blockBoost: num(p.blockBoost, 1),
    waterTint: num(water[0], 1),
    punchGamma: num(p.punchGamma, ASHLAR_PUNCH_GAMMA),
    punchSat: num(p.punchSat, ASHLAR_PUNCH_SAT),
  };
}

/**
 * 施加 override，返回**新对象**（三个数组字段也拷贝）。
 *
 * ⚠️ **绝不原地改入参**：入参可能是 `VISUAL_STYLES` 的权威对象，改它会污染风格表
 * （`test-daynight.js` 冻结了四档 sunDirection 的字面值，且 `get params` 已刻意拷贝数组）。
 * ⚠️ **只认表里的 key**：未知键忽略，不让脏输入流进 params。
 * ⚠️ `waterTint` 一个键写三个分量 —— 三通道相等是既有全局断言（只调亮度不改色相）。
 *
 * @param {object} params 风格参数（不会被修改）
 * @param {Record<string, number>} overrides key → 值（已钳制；未钳制的调用方须先过 clampTuningValue）
 * @returns {object} 新 params
 */
export function applyTuningOverride(params, overrides) {
  const p = { ...params };
  // 数组字段一律拷贝：浅拷贝会让 out.sunColor 仍指向权威原值
  p.sunColor = [...(params.sunColor || [1, 1, 1])];
  p.ambientColor = [...(params.ambientColor || [1, 1, 1])];
  p.waterTint = [...(params.waterTint || [1, 1, 1])];
  if (!overrides) return p;
  for (const [key, v] of Object.entries(overrides)) {
    if (!BY_KEY.has(key) || typeof v !== 'number' || !Number.isFinite(v)) continue;
    switch (key) {
      case 'sunColor[0]': p.sunColor[0] = v; break;
      case 'sunColor[1]': p.sunColor[1] = v; break;
      case 'sunColor[2]': p.sunColor[2] = v; break;
      case 'ambientColor[0]': p.ambientColor[0] = v; break;
      case 'ambientColor[1]': p.ambientColor[1] = v; break;
      case 'ambientColor[2]': p.ambientColor[2] = v; break;
      case 'waterTint': p.waterTint = [v, v, v]; break;
      default: p[key] = v; break;   // 标量字段：sunIntensity / shadowFloor / hemiGround / …/ punch*
    }
  }
  return p;
}

/**
 * 钳制一个滑块值。非法输入返回 **null**（调用方据此拒绝写入，而不是写 NaN 进 uniform）。
 *
 * ⚠️ 必须判 `typeof v === 'number'`：`Number.isFinite('0.5')` 是 false，但
 * `Number('0.5')` 会得到 0.5 —— 若这里先做 Number() 转换，字符串就被静默接受了。
 * 面板传来的是 `Number(input.value)`，而程序化调用（URL / 测试 API）可能传任何东西。
 *
 * @param {string} key
 * @param {unknown} v
 * @returns {number|null} 钳制后的值；未知 key 或非有限数值 → null
 */
export function clampTuningValue(key, v) {
  const d = BY_KEY.get(key);
  if (!d) return null;
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return Math.min(d.max, Math.max(d.min, v));
}

/**
 * 组「复制参数」文本（用户 2026-11-27 指定格式：每行 `参数名，变量名:参数值`）。
 *
 * 首行附风格键 —— 否则贴回来的 15 个数字不知道属于哪一档。
 * 数值统一 `toFixed(3)`（最小 step 是 0.001）：格式一致才好逐行比对。
 *
 * @param {Record<string, number>} values readTuningValues 的结果
 * @param {string|null} styleKey 当前风格键；null = 自动日夜循环 → 写 'auto'
 * @returns {string} 16 行，\n 连接，末尾不带换行
 */
export function formatTuningText(values, styleKey) {
  const lines = [`风格，visualStyle: ${styleKey || 'auto'}`];
  for (const d of LIGHT_TUNING_PARAMS) {
    const v = values?.[d.key];
    const n = typeof v === 'number' && Number.isFinite(v) ? v : 0;
    lines.push(`${d.label}，${d.varName}: ${n.toFixed(3)}`);
  }
  return lines.join('\n');
}