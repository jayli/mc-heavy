import { test } from './runner.js';
import { assertEqual, assertTrue } from './assert.js';
import { paramsAtHour, VISUAL_STYLES, VISUAL_STYLE_KEYS, DayNight } from '../render/daynight.js';

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
