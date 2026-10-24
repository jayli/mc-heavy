import { test } from './runner.js';
import { assertEqual, assertTrue } from './assert.js';
import {
  paramsAtHour, VISUAL_STYLES, VISUAL_STYLE_KEYS, DayNight,
  SUN_LIGHT_BASE_RGB, SUN_LIGHT_BASE_HEX,
} from '../render/daynight.js';

/** 独立算一份归一化期望值（测试自有算术，不消费实现里的函数） */
function normalize(v) {
  const len = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
  return [v[0] / len, v[1] / len, v[2] / len];
}

function assertVecClose(actual, expected, eps, message) {
  assertTrue(Array.isArray(actual), `${message}: expected array, got ${actual}`);
  assertEqual(actual.length, 3, `${message}: length`);
  for (let i = 0; i < 3; i++) {
    assertTrue(
      Math.abs(actual[i] - expected[i]) < eps,
      `${message}: component ${i} expected ${expected[i]}, got ${actual[i]}`,
    );
  }
}

/** DayNight 的 stub 依赖（无 three）：scene 无 background、fog 三个 uniform 句柄 + 体素 uniform 三项 */
function makeDayNightStub(opts = {}) {
  const voxelUniforms = {
    uSkyDim: { value: 0 },
    uBlockBoost: { value: 0 },
    uShadowStrength: { value: 0 },
  };
  const dayNight = new DayNight({
    scene: {},
    fog: { fogColor: { value: { set() {} } }, fogNear: { value: 0 }, fogFar: { value: 0 } },
    voxelUniforms,
    ...opts,
  });
  return { dayNight, voxelUniforms };
}

test('三种风格参数齐全且照度语义正确', () => {
  const m = VISUAL_STYLES[VISUAL_STYLE_KEYS.MORNING];
  const n = VISUAL_STYLES[VISUAL_STYLE_KEYS.NOON];
  const k = VISUAL_STYLES[VISUAL_STYLE_KEYS.NIGHT];
  assertEqual(n.skyDim, 1, 'noon full skylight');
  assertTrue(k.skyDim < n.skyDim, 'night dims skylight');
  assertTrue(k.blockBoost > n.blockBoost, 'night boosts blocklight relatively');
  assertTrue(m.skyDim < n.skyDim, 'morning slightly dimmer than noon');
});

test('paramsAtHour：正午/子夜取风格原值', () => {
  assertEqual(paramsAtHour(12).skyDim, VISUAL_STYLES.noon.skyDim);
  assertEqual(paramsAtHour(0).skyDim, VISUAL_STYLES.night.skyDim);
  assertEqual(paramsAtHour(24).skyDim, VISUAL_STYLES.night.skyDim, 'wrap 24==0');
});

test('paramsAtHour：昼夜过渡平滑（无跳变）', () => {
  // 分段线性插值天然连续；断言相邻 0.25h 的 skyDim 差不超过最陡坡（黎明 0.275/h→0.069/步）
  // 的余量 0.08，足以捕获任何真实跳变（跳变会 >>0.08）。
  let prev = paramsAtHour(0).skyDim;
  for (let h = 0.25; h <= 24; h += 0.25) {
    const cur = paramsAtHour(h).skyDim;
    assertTrue(Math.abs(cur - prev) < 0.08, `smooth at ${h}: ${prev}->${cur}`);
    prev = cur;
  }
});

test('paramsAtHour：晨昏介于夜与午之间', () => {
  const dawn = paramsAtHour(7);
  assertTrue(dawn.skyDim > VISUAL_STYLES.night.skyDim && dawn.skyDim <= VISUAL_STYLES.morning.skyDim + 1e-9, 'dawn between');
});

// —— 太阳方向（shadow map Epic Task 2）——
// VISUAL_STYLES 存 mc-lite Engine.js:74/99/122 的原值；paramsAtHour 返回**归一化**方向。

test('三风格 sunDirection 是 mc-lite 原值', () => {
  const m = VISUAL_STYLES[VISUAL_STYLE_KEYS.MORNING].sunDirection;
  const n = VISUAL_STYLES[VISUAL_STYLE_KEYS.NOON].sunDirection;
  const k = VISUAL_STYLES[VISUAL_STYLE_KEYS.NIGHT].sunDirection;
  assertEqual(m[0], 0.18, 'morning.x');
  assertEqual(m[1], 0.45, 'morning.y');
  assertEqual(m[2], 0.88, 'morning.z');
  assertEqual(n[0], 0, 'noon.x');
  assertEqual(n[1], 0.8, 'noon.y');
  assertEqual(n[2], 0.6, 'noon.z');
  assertEqual(k[0], 0.08, 'night.x');
  assertEqual(k[1], 0.25, 'night.y');
  assertEqual(k[2], 0.96, 'night.z');
});

test('paramsAtHour：方向为单位向量', () => {
  for (const h of [0, 3, 7, 12, 18, 23]) {
    const d = paramsAtHour(h).sunDirection;
    const len = Math.sqrt(d[0] * d[0] + d[1] * d[1] + d[2] * d[2]);
    assertTrue(Math.abs(len - 1) < 1e-6, `h=${h}: |len-1| = ${Math.abs(len - 1)}`);
  }
});

test('paramsAtHour：方向在风格边界连续（无跳变）', () => {
  // 实测（原值口径确定性数学，2026-10-13 由本任务脚本打印）：
  //   0.25h 网格归一化最大分量差 = 0.05018（h=7.25 的 y，最陡段 morning→noon）
  //     → 阈值 0.05 在「归一化后」口径下不成立（brief 的 0.05 是按归一化前的 0.04375 定的）；
  //   0.125h 网格归一化最大分量差 = 0.02513（2× 余量）；
  //     snap 类真跳变（不插值、按风格直切）= 0.3521 ≈ 阈值的 7 倍，
  //     且 7/9/17/19 等边界均为 0.125 的整数倍 → 跳变必落在采样点上被全额抓住。
  // 故保留阈值 0.05、采样网格取 0.125h（controller ruling (c)）。
  let prev = paramsAtHour(0).sunDirection;
  for (let h = 0.125; h <= 24 + 1e-9; h += 0.125) {
    const cur = paramsAtHour(h).sunDirection;
    for (let i = 0; i < 3; i++) {
      assertTrue(
        Math.abs(cur[i] - prev[i]) < 0.05,
        `smooth at ${h} component ${i}: ${prev[i]} -> ${cur[i]}`,
      );
    }
    prev = cur;
  }
});

test('paramsAtHour：正午方向 = noon 原值归一化', () => {
  assertVecClose(paramsAtHour(12).sunDirection, normalize([0, 0.8, 0.6]), 1e-9, 'noon');
});

test('DayNight：uShadowStrength 随 skyDim 联动', () => {
  const { dayNight, voxelUniforms } = makeDayNightStub();
  dayNight.setTime(12);
  assertEqual(voxelUniforms.uShadowStrength.value, 1, 'noon 阴影强度 = skyDim');
  dayNight.setTime(0);
  assertEqual(voxelUniforms.uShadowStrength.value, 0.25, 'night 阴影强度 = skyDim');
});

test('DayNight：onSunDirection 回调收到归一化方向', () => {
  const seen = [];
  const { dayNight } = makeDayNightStub({ onSunDirection: (dir) => seen.push(dir) });
  dayNight.setTime(12);
  assertTrue(seen.length > 0, '回调被调用');
  assertVecClose(seen[seen.length - 1], normalize([0, 0.8, 0.6]), 1e-9, 'setTime(12) 最后一次入参');
  // setStyle 路径同样归一到单位长度（night 原值长度 0.995239）；走真实路径而非只测 paramsAtHour
  dayNight.setStyle(VISUAL_STYLE_KEYS.NIGHT);
  assertVecClose(seen[seen.length - 1], normalize([0.08, 0.25, 0.96]), 1e-9, 'setStyle(night) 最后一次入参');
  // 归一化必须是纯函数：VISUAL_STYLES 是权威原值，不得被 _apply 原地改写
  const n = VISUAL_STYLES[VISUAL_STYLE_KEYS.NIGHT].sunDirection;
  assertEqual(n[0], 0.08, 'night 原值 x 未被改写');
  assertEqual(n[1], 0.25, 'night 原值 y 未被改写');
  assertEqual(n[2], 0.96, 'night 原值 z 未被改写');
});

// —— 夜间混合与月亮方向（v1.58 天空盒）——

test('nightBlendOf：正午 0 / 深夜 1 / 晨居中且单调', async () => {
  const { nightBlendOf } = await import('../render/daynight.js');
  const noon = nightBlendOf(paramsAtHour(12));
  const night = nightBlendOf(paramsAtHour(0));
  const morning = nightBlendOf(paramsAtHour(7));
  assertEqual(noon, 0, '正午 = 0（全白天云图）');
  assertTrue(Math.abs(night - 1) < 1e-12, `深夜 = 1（全星空），实测 ${night}`);
  assertTrue(morning > 0 && morning < 1, `晨须居中，实测 ${morning}`);
  // 单调：6→12 应单调不增
  let prev = nightBlendOf(paramsAtHour(6));
  for (let h = 6.25; h <= 12; h += 0.25) {
    const cur = nightBlendOf(paramsAtHour(h));
    assertTrue(cur <= prev + 1e-12, `6→12 须单调不增：h=${h} ${prev}->${cur}`);
    prev = cur;
  }
});

test('nightBlendOf：钳制在 [0,1]（skyDim 越界不得溢出）', async () => {
  const { nightBlendOf } = await import('../render/daynight.js');
  assertEqual(nightBlendOf({ skyDim: 2 }), 0, 'skyDim > 1 夹到 0');
  assertEqual(nightBlendOf({ skyDim: -1 }), 1, 'skyDim < night 夹到 1');
});

test('三风格 moonDirection 是 mc-lite 原值，且插值后仍是单位向量', () => {
  const m = VISUAL_STYLES[VISUAL_STYLE_KEYS.MORNING].moonDirection;
  const n = VISUAL_STYLES[VISUAL_STYLE_KEYS.NOON].moonDirection;
  const k = VISUAL_STYLES[VISUAL_STYLE_KEYS.NIGHT].moonDirection;
  assertEqual(m.join(','), '-0.38,0.45,-0.81');
  assertEqual(n.join(','), '-0.25,0.5,-0.82');
  assertEqual(k.join(','), '-0.32,0.58,-0.75');
  for (const h of [0, 4, 7.5, 12, 18.5, 23]) {
    const d = paramsAtHour(h).moonDirection;
    const len = Math.sqrt(d[0] ** 2 + d[1] ** 2 + d[2] ** 2);
    assertTrue(Math.abs(len - 1) < 1e-6, `h=${h}: |len-1| = ${Math.abs(len - 1)}`);
  }
});

test('DayNight：写 uSunDirection 与 uNightBlend（句柄缺失时不抛错）', () => {
  const seen = { sun: null };
  const voxelUniforms = {
    uSkyDim: { value: 0 }, uBlockBoost: { value: 0 }, uShadowStrength: { value: 0 },
    uSunDirection: { value: { set(x, y, z) { seen.sun = [x, y, z]; } } },
  };
  const skyUniforms = { uNightBlend: { value: -1 } };
  const dayNight = new DayNight({
    scene: {},
    fog: { fogColor: { value: { set() {} } }, fogNear: { value: 0 }, fogFar: { value: 0 } },
    voxelUniforms, skyUniforms,
  });
  dayNight.setTime(12);
  assertVecClose(seen.sun, normalize([0, 0.8, 0.6]), 1e-9, 'setTime(12) 写入的太阳方向');
  assertEqual(skyUniforms.uNightBlend.value, 0, '正午 nightBlend = 0');
  dayNight.setTime(0);
  assertTrue(Math.abs(skyUniforms.uNightBlend.value - 1) < 1e-12, '深夜 nightBlend = 1');
  // 不带 skyUniforms 构造不得抛错（既有调用方）
  makeDayNightStub();
});

test('toneMappingExposure：三风格都有且夜必须比正午补更多曝光', () => {
  const m = VISUAL_STYLES[VISUAL_STYLE_KEYS.MORNING].toneMappingExposure;
  const n = VISUAL_STYLES[VISUAL_STYLE_KEYS.NOON].toneMappingExposure;
  const k = VISUAL_STYLES[VISUAL_STYLE_KEYS.NIGHT].toneMappingExposure;
  for (const [name, v] of [['morning', m], ['noon', n], ['night', k]]) {
    assertTrue(typeof v === 'number' && v > 0.5 && v < 2.5, `${name} exposure 须在 (0.5,2.5)：${v}`);
  }
  assertEqual(n, 1.0, 'noon 用 1.0（实测 1.25 会把天空冲到近纯白、云层细节丢失）');
  assertEqual(m, 1.0, 'morning 也用 1.0 —— 1.35 会把 skyDim 0.8 的晨昏变暗抵消（|m-n| 0.061→0.004）');
  assertTrue(k > n, `夜必须比正午补更多曝光（ACES 暗部压缩陡）：night=${k} noon=${n}`);
});

test('paramsAtHour：toneMappingExposure 随关键帧插值，且落在两端之间', () => {
  const n = VISUAL_STYLES[VISUAL_STYLE_KEYS.NOON].toneMappingExposure;
  const k = VISUAL_STYLES[VISUAL_STYLE_KEYS.NIGHT].toneMappingExposure;
  assertEqual(paramsAtHour(12).toneMappingExposure, n, '正午取 noon 原值');
  assertEqual(paramsAtHour(0).toneMappingExposure, k, '子夜取 night 原值');
  // 中间时刻（6 点在 night→morning 插值段）必须严格落在两端之间 —— 证明走插值而非二态
  const mid = paramsAtHour(6).toneMappingExposure;
  assertTrue(mid > Math.min(k, n) - 1e-9 && mid < Math.max(k, n) + 1e-9,
    `6 点的 exposure 须在两端之间：mid=${mid} night=${k} noon=${n}`);
});

test('DayNight：exposure 经 _apply 写出（setTime 与 setStyle 同一收口）', () => {
  const seen = [];
  const renderer = { set toneMappingExposure(v) { seen.push(+v.toFixed(4)); } };
  const { dayNight } = makeDayNightStub({ renderer });
  dayNight.setTime(12);
  dayNight.setTime(0);
  const n = VISUAL_STYLES[VISUAL_STYLE_KEYS.NOON].toneMappingExposure;
  const k = VISUAL_STYLES[VISUAL_STYLE_KEYS.NIGHT].toneMappingExposure;
  assertTrue(seen.includes(n), `正午须写出 ${n}，实测序列 ${JSON.stringify(seen)}`);
  assertTrue(seen.includes(k), `夜里须写出 ${k}，实测序列 ${JSON.stringify(seen)}`);
  // setStyle 也是同一收口（override 路径）
  dayNight.setStyle(VISUAL_STYLE_KEYS.NIGHT);
  assertEqual(seen[seen.length - 1], k, 'setStyle(night) 须经 _apply 写出 night 的曝光');
});

test('DayNight：renderer 缺省 null 时不抛错（stub / 尚未装配）', () => {
  const { dayNight } = makeDayNightStub();
  dayNight.setTime(0);
  dayNight.setStyle(VISUAL_STYLE_KEYS.MORNING);
  dayNight.setStyle(null);
  dayNight.update(1);
});

// —— 傍晚风格（dusk，v1.71）——
// 新增第四种视觉风格，挂 mc-lite `skyBox2`（日落）。**自动日夜循环不参与它** ——
// 它是纯手动风格，`paramsAtHour()` 与 `KEYFRAMES` 一行不动（不变式见下）。

test('dusk：风格存在且为第四种（自动循环的四组关键帧仍是 morning/noon/night）', () => {
  assertEqual(VISUAL_STYLE_KEYS.DUSK, 'dusk');
  const keys = Object.keys(VISUAL_STYLES).sort();
  assertEqual(keys.join(','), 'dusk,morning,night,noon', '风格表只应有这四项');
});

test('dusk：色温字段齐全，且暖直射 + 冷环境（截图里地平线是暖的、天顶是灰蓝紫）', () => {
  const d = VISUAL_STYLES[VISUAL_STYLE_KEYS.DUSK];
  for (const f of ['sunColor', 'ambientColor']) {
    assertTrue(Array.isArray(d[f]) && d[f].length === 3, `dusk.${f} 须是三分量数组`);
    // ⚠️ 这是**相对乘数**，允许 >1（1.32 = 让暖通道超基准，才能在 ACES 后仍看出偏暖）；
    // 只要在合理量级（≤1.5）且均值 ≈1，不会偷偷改曝光。
    for (const v of d[f]) assertTrue(v > 0.5 && v <= 1.5, `dusk.${f} 分量须在 (0.5,1.5]：${v}`);
  }
  const [sr, , sb] = d.sunColor;
  assertTrue(sr > sb + 0.1, `直射光须偏暖（R 明显大于 B）：R=${sr} B=${sb}`);
  const [ar, , ab] = d.ambientColor;
  assertTrue(ab > ar + 0.05, `环境光须偏冷（B 大于 R，对应灰蓝天顶）：R=${ar} B=${ab}`);
});

test('dusk：光照基调 = 可辨认的傍晚（比早晨暗、明显比正午暗，但远亮于夜）', () => {
  const m = VISUAL_STYLES[VISUAL_STYLE_KEYS.MORNING];
  const n = VISUAL_STYLES[VISUAL_STYLE_KEYS.NOON];
  const k = VISUAL_STYLES[VISUAL_STYLE_KEYS.NIGHT];
  const d = VISUAL_STYLES[VISUAL_STYLE_KEYS.DUSK];
  assertTrue(d.skyDim < m.skyDim, `傍晚须比早晨暗：dusk=${d.skyDim} morning=${m.skyDim}`);
  assertTrue(d.skyDim > k.skyDim, `傍晚须明显亮于深夜：dusk=${d.skyDim} night=${k.skyDim}`);
  // 「可辨认」的下界：不能糊成黑夜（用户选定的口径，见 §4.4.3）
  assertTrue(d.skyDim >= 0.6, `傍晚地面须可辨认（skyDim ≥ 0.6）：实测 ${d.skyDim}`);
  assertTrue(d.toneMappingExposure >= 1.0, `傍晚须补一点曝光（ACES 会压暗部）：实测 ${d.toneMappingExposure}`);
  assertTrue(d.toneMappingExposure <= 1.6, `但不得亮到像白天：实测 ${d.toneMappingExposure}`);
  // 与冬夜一致的相对关系：blockboost 抬高，让火把/发光方块在暖色环境里仍突出
  assertTrue(d.blockBoost >= n.blockBoost, `傍晚的 blocklight 不得相对减弱：${d.blockBoost}`);
});

test('dusk：太阳仰角与 mc-lite skyBox2 贴图里的方位一致（贴图为 5.5°，抬到 12° 以保地面可辨认）', () => {
  const d = VISUAL_STYLES[VISUAL_STYLE_KEYS.DUSK].sunDirection;
  const len = Math.sqrt(d[0] * d[0] + d[1] * d[1] + d[2] * d[2]);
  const elevDeg = Math.asin(d[1] / len) * 180 / Math.PI;
  const azimDeg = Math.atan2(d[0], d[2]) * 180 / Math.PI;
  // 实测（Tier 4 探针，自校准 day 图后 sun 落在 azim≈0 / elev≈47°）：skyBox2 的太阳渲染在
  // **azim +44°、elev 5.5°**（three 背景采样 x 轴镜像 → 落盘 -X/+Z 象限渲染成 +X/+Z）。
  assertTrue(Math.abs(elevDeg - 12) < 1.5, `太阳仰角须 ≈12°（可辨认傍晚口径）：实测 ${elevDeg.toFixed(2)}°`);
  assertTrue(Math.abs(azimDeg - 44) < 3, `太阳方位须 ≈+44°（对齐贴图里那轮太阳）：实测 ${azimDeg.toFixed(2)}°`);
  assertTrue(elevDeg < 26.6, `必须比早晨更低（morning 26.6°）：实测 ${elevDeg.toFixed(2)}°`);
});

test('dusk：三种既有风格的色温字段保持中性（默认白 ⇒ 其余风格逐位不变）', () => {
  for (const key of ['morning', 'noon', 'night']) {
    const s = VISUAL_STYLES[key];
    assertEqual(s.sunColor.join(','), '1,1,1', `${key}.sunColor 须为中性白`);
    assertEqual(s.ambientColor.join(','), '1,1,1', `${key}.ambientColor 须为中性白`);
  }
});

test('dusk：所有风格都有 sunColor/ambientColor（插值路径不得读 undefined）', () => {
  for (const key of Object.keys(VISUAL_STYLES)) {
    const s = VISUAL_STYLES[key];
    assertTrue(Array.isArray(s.sunColor) && s.sunColor.length === 3, `${key} 缺 sunColor`);
    assertTrue(Array.isArray(s.ambientColor) && s.ambientColor.length === 3, `${key} 缺 ambientColor`);
  }
});

test('不变式：自动日夜循环全程 duskBlend=0（傍晚只能手动选，不会混进循环）', () => {
  for (let h = 0; h <= 24; h += 0.25) {
    const p = paramsAtHour(h);
    assertEqual(p.duskBlend, 0, `h=${h} 的 duskBlend 必须为 0`);
    assertEqual(p.sunColor.join(','), '1,1,1', `h=${h} 的 sunColor 必须中性（自动循环逐位不变）`);
    assertEqual(p.ambientColor.join(','), '1,1,1', `h=${h} 的 ambientColor 必须中性`);
  }
});

test('不变式：dusk 风格下 duskBlend=1 且色温取 dusk 原值（三条路径同一收口）', () => {
  const d = VISUAL_STYLES[VISUAL_STYLE_KEYS.DUSK];
  const { dayNight } = makeDayNightStub();
  dayNight.setStyle(VISUAL_STYLE_KEYS.DUSK);
  const p = dayNight.params;
  assertEqual(p.duskBlend, 1, 'setStyle(dusk) 的 duskBlend 须为 1');
  assertVecClose(p.sunColor, d.sunColor, 1e-12, 'setStyle(dusk) 的 sunColor');
  assertVecClose(p.ambientColor, d.ambientColor, 1e-12, 'setStyle(dusk) 的 ambientColor');
  // 既有三风格的 duskBlend 必须是 0（否则天空会是黄昏贴图）
  for (const key of ['morning', 'noon', 'night']) {
    dayNight.setStyle(key);
    assertEqual(dayNight.params.duskBlend, 0, `setStyle(${key}) 的 duskBlend 须为 0`);
  }
  // 色温是数组：get params 必须返回**新数组**（不得把 VISUAL_STYLES 的权威原值暴露出去）
  dayNight.setStyle(VISUAL_STYLE_KEYS.DUSK);
  const a = dayNight.params.sunColor;
  const b = dayNight.params.sunColor;
  assertTrue(a !== b, 'get params 每次须返回新数组（防止调用方原地改写权威数据）');
  a[0] = 0.5;
  assertEqual(VISUAL_STYLES[VISUAL_STYLE_KEYS.DUSK].sunColor[0] !== 0.5, true, '权威原值不得被污染');
});

test('dusk：uDuskBlend / uSunColor / uAmbientColor 经 _apply 写出（句柄缺失不抛错）', () => {
  const written = { dusk: null, sun: null, amb: null };
  const voxelUniforms = {
    uSkyDim: { value: 0 }, uBlockBoost: { value: 0 }, uShadowStrength: { value: 0 },
    // ⚠️ stub 必须建模**真实形状**：材质里这两个句柄是 `uniform(new THREE.Vector3())`，
    // `.value` 是 Vector3 → 有 `set`、**没有** `setRGB`（Color 才有）。
    // 早先这个 stub 写的是 `setRGB`，于是实现里写成 `.setRGB()` 时单测全绿、真页面白屏
    // （CLAUDE.md 已记同类的 fake 盲区：形状对了、方法错了照样是盲区）。
    uSunColor: { value: { set(r, g, b) { written.sun = [r, g, b]; } } },
    uAmbientColor: { value: { set(r, g, b) { written.amb = [r, g, b]; } } },
  };
  const skyUniforms = { uNightBlend: { value: -1 }, uDuskBlend: { value: -1 } };
  const dayNight = new DayNight({
    scene: {}, fog: { fogColor: { value: { set() {} } }, fogNear: { value: 0 }, fogFar: { value: 0 } },
    voxelUniforms, skyUniforms,
  });
  dayNight.setStyle(VISUAL_STYLE_KEYS.DUSK);
  const d = VISUAL_STYLES[VISUAL_STYLE_KEYS.DUSK];
  assertEqual(skyUniforms.uDuskBlend.value, 1, 'dusk 的 uDuskBlend 须为 1');
  assertVecClose(written.sun, d.sunColor, 1e-12, 'uSunColor 写入值');
  assertVecClose(written.amb, d.ambientColor, 1e-12, 'uAmbientColor 写入值');
  dayNight.setStyle(VISUAL_STYLE_KEYS.NOON);
  assertEqual(skyUniforms.uDuskBlend.value, 0, 'noon 的 uDuskBlend 须回到 0');
  assertVecClose(written.sun, [1, 1, 1], 1e-12, 'noon 的 uSunColor 须为中性白');
  // 句柄缺失（既有调用方 / fixture）不得抛错
  makeDayNightStub().dayNight.setStyle(VISUAL_STYLE_KEYS.DUSK);
});

test('dusk：阳光灯的色温跟随时段（枪的 PBR 高光也要是暖的）', async () => {
  const seen = [];
  const sunLight = {
    color: { setRGB(r, g, b) { seen.push([+r.toFixed(4), +g.toFixed(4), +b.toFixed(4)]); } },
  };
  const { dayNight } = makeDayNightStub({ sunLight });
  const d = VISUAL_STYLES[VISUAL_STYLE_KEYS.DUSK];
  dayNight.setStyle(VISUAL_STYLE_KEYS.DUSK);
  const last = seen[seen.length - 1];
  // 灯光色 = 中性 0xfffaf0 × 风格色温（风格色温是相对乘数，白 = 原样）
  assertTrue(last[0] > last[2], `傍晚太阳灯须偏暖：R=${last[0]} B=${last[2]}`);
  assertTrue(Math.abs(last[0] - d.sunColor[0]) < 0.02, `R 须跟随风格色温：${last[0]} vs ${d.sunColor[0]}`);
  // 中性风格 → 回到原色（逐位不变：不许因乘了 1 而改变数值）。
  // 基准色是 `SUN_LIGHT_BASE_RGB` = 0xfffaf0 → G 是 0xfa/255 = 0.9804（不是 1）。
  dayNight.setStyle(VISUAL_STYLE_KEYS.NOON);
  const noon = seen[seen.length - 1];
  for (let c = 0; c < 3; c++) {
    assertTrue(Math.abs(noon[c] - SUN_LIGHT_BASE_RGB[c]) < 1e-4,
      `noon 太阳灯通道 ${c} 须逐位等于基准色 ${SUN_LIGHT_BASE_RGB[c]}：实测 ${noon[c]}`);
  }
});

test('dusk：太阳灯基准色只有一个权威（RGB 数组与 hex 从同一值派生）', () => {
  const fromHex = [(SUN_LIGHT_BASE_HEX >> 16) & 255, (SUN_LIGHT_BASE_HEX >> 8) & 255, SUN_LIGHT_BASE_HEX & 255];
  for (let c = 0; c < 3; c++) {
    assertTrue(Math.abs(SUN_LIGHT_BASE_RGB[c] * 255 - fromHex[c]) < 1e-9,
      `通道 ${c}：hex 与 RGB 数组必须同源（${fromHex[c]} vs ${SUN_LIGHT_BASE_RGB[c] * 255}）`);
  }
  assertEqual(SUN_LIGHT_BASE_HEX, 0xfffaf0, '基准色须仍是 mc-lite Engine.js:168 的原值');
});

test('dusk：夜空混合显式指定为 0（不得从 skyDim 倒算出星空混入）', async () => {
  // 实测踩坑：dusk 的 skyDim 是 0.78（为地面可辨认），按 nightBlendOf 的旧公式会倒算出
  // **0.293** → 傍晚天空混进 30% 星空贴图 → 实测天空暖度被拉成 R−B = −14（仍偏冷）。
  // 语义上也不对：傍晚的天空由 dusk 立方图接管，不该再叠星空。
  const { nightBlendOf } = await import('../render/daynight.js');
  const d = VISUAL_STYLES[VISUAL_STYLE_KEYS.DUSK];
  assertEqual(d.nightBlend, 0, 'dusk 须显式声明 nightBlend = 0');
  assertEqual(nightBlendOf(d), 0, 'dusk 的夜空混合须为 0（不叠星空）');
  // 反证：若删掉显式值，旧公式会给出一个明显 > 0 的值（说明这条断言真的在测东西）
  const derived = (1 - d.skyDim) / (1 - VISUAL_STYLES.night.skyDim);
  assertTrue(derived > 0.2, `旧公式会倒算出 ${derived.toFixed(3)}（>0.2）→ 这条断言有判别力`);
  // 其余风格不受影响：显式值只写在自己身上（缺省仍走 skyDim 派生）
  assertEqual(VISUAL_STYLES[VISUAL_STYLE_KEYS.NOON].nightBlend, undefined, 'noon 不写显式值');
  assertEqual(nightBlendOf(paramsAtHour(12)), 0, '正午仍派生为 0');
  assertTrue(Math.abs(nightBlendOf(paramsAtHour(0)) - 1) < 1e-12, '深夜仍派生为 1');
  assertTrue(Math.abs(nightBlendOf(paramsAtHour(7)) - 0.26666666666666666) < 1e-9, '早晨派生值不变');
});
