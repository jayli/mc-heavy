// src/tests/test-wet-surface.js — 按材质分类的湿表面（v3.31，Tier 1）
//
// 设计稿：docs/superpowers/specs/2026-11-22-wet-surface-rebuild-design.md
//
// 本文件守三类失效：
//   ① **分类覆盖**：新增方块漏分类 ⇒ 它在雨里静默保持干燥（玩家看到新建筑是干的）。
//   ② **参数关系**：粗糙度/镜面强度的序关系退化 ⇒ 「只有一种反光材质」（用户明确否决）。
//   ③ **位段隔离**：mesher 的类位挤进 bit0–14 ⇒ 阴影投射语义翻转（云开始投影）。
//
// ⚠️ 判据不读实现常量互推：覆盖性用 BLOCKS 全集对齐，位段用「掩掉类位后仍满足既有语义」。
import { test } from './runner.js';
import { assertEqual, assertTrue, assertDeepEqual } from './assert.js';
import { createRegistry } from '../voxel/block-registry.js';
import { BLOCKS } from '../voxel/blocks-data.js';
import { buildSectionMesh } from '../mesh/mesher.js';
import { WET_CLASS, WET_CLASS_COUNT, WET_CLASS_DATA, wetClassOf } from '../voxel/wet-material-data.js';
import {
  WET_CLASS_PARAMS, WET_WALL_FACTOR, WET_SHININESS,
  WET_FRESNEL_F0_BASE, WET_FRESNEL_F0_RANGE,
  wetnessAt, wetAboveWaterGate, wetRoughnessAt, puddleAllowed,
  wetFresnel, wetShininess, skyEnvMixAt, wetSpecGainAt, wetDarkenAt,
} from '../render/wet-surface-config.js';

function assertClose(a, b, eps = 1e-9, msg = '') {
  if (!(Math.abs(a - b) <= eps)) throw new Error(`${msg ? msg + ': ' : ''}期望 ${b}±${eps}，实际 ${a}`);
}

const REG = createRegistry();
for (const b of BLOCKS) REG.register(b.name, b);
REG.freeze();

// ---------- 分类覆盖（Review Focus #1）----------

test('wet class: 全部 opaque/cutout 方块都已显式分类（150 项）', () => {
  const target = BLOCKS.filter((b) => b.cullMode === 'opaque' || b.cullMode === 'cutout');
  assertEqual(target.length, 150, 'opaque 105 + cutout 45');
  const missing = target.filter((b) => WET_CLASS_DATA[b.name] === undefined).map((b) => b.name);
  assertEqual(missing.join(','), '', '未分类方块');
  const names = new Set(target.map((b) => b.name));
  const extra = Object.keys(WET_CLASS_DATA).filter((n) => !names.has(n));
  assertEqual(extra.join(','), '', '多余条目（拼错的名字）');
});

test('wet class: cloud 必须是 NONE（用户报告的高空云层光晕的直接防线）', () => {
  assertEqual(wetClassOf('cloud'), WET_CLASS.NONE);
  assertEqual(wetClassOf('lava'), WET_CLASS.NONE);
  assertEqual(wetClassOf('glowstone'), WET_CLASS.NONE);
});

test('wet class: 未列出的名字回落 NONE（安全失败，不会湿错）', () => {
  assertEqual(wetClassOf('__no_such_block__'), WET_CLASS.NONE);
});

test('wet class: registry.wetClassTable 与数据表逐项一致', () => {
  for (const b of BLOCKS) {
    assertEqual(REG.wetClassTable[REG.idOf(b.name)], wetClassOf(b.name), b.name);
  }
});

test('wet class: 新增表不改方块清单指纹（旧存档零影响）', () => {
  assertEqual(REG.fingerprint(), REG.fingerprintOfPrefix(REG.count));
  assertTrue(/^[0-9a-f]{8}$/.test(REG.fingerprint()), '32bit 十六进制');
});
// ---------- 类参数表（Review Focus #2：数组长度与类枚举同步）----------

test('wet params: 数组长度 = 类数，且每项四分量都在 [0,1]', () => {
  assertEqual(WET_CLASS_PARAMS.length, WET_CLASS_COUNT);
  for (const [i, p] of WET_CLASS_PARAMS.entries()) {
    assertEqual(p.length, 4, `类 ${i} 四分量`);
    for (const v of p) assertTrue(Number.isFinite(v) && v >= 0 && v <= 1, `类 ${i} 分量 ${v}`);
  }
});

test('wet params: NONE 是恒等（不湿、不压暗、无镜面）', () => {
  assertDeepEqual([...WET_CLASS_PARAMS[WET_CLASS.NONE]], [0, 1, 1, 0]);
});

test('wet params: 粗糙度按表面致密度单调（抛光 < 石 < 土 < 布）', () => {
  const r = (c) => WET_CLASS_PARAMS[c][2];
  assertTrue(r(WET_CLASS.POLISHED) < r(WET_CLASS.STONE), '抛光 < 石');
  assertTrue(r(WET_CLASS.STONE) < r(WET_CLASS.SOIL), '石 < 土');
  assertTrue(r(WET_CLASS.SOIL) < r(WET_CLASS.FABRIC), '土 < 布');
});

test('wet params: 布与植被几乎无镜面（<0.1），金属与抛光强（>0.8）', () => {
  const s = (c) => WET_CLASS_PARAMS[c][3];
  assertTrue(s(WET_CLASS.FABRIC) < 0.1, '布');
  assertTrue(s(WET_CLASS.PLANT) < 0.1, '植被');
  assertTrue(s(WET_CLASS.METAL) > 0.8, '金属');
  assertTrue(s(WET_CLASS.POLISHED) > 0.8, '抛光');
});

// ---------- 湿强度：四条归零门 + 墙面弱湿 ----------

test('wetnessAt: 总强度 0 / 底面 / NONE / 水下 四条都归零', () => {
  assertEqual(wetnessAt(0, 1, WET_CLASS.STONE, 10, -1.5), 0, '总强度 0');
  assertEqual(wetnessAt(1, -1, WET_CLASS.STONE, 10, -1.5), 0, '底面');
  assertEqual(wetnessAt(1, 1, WET_CLASS.NONE, 10, -1.5), 0, 'NONE 类');
  assertEqual(wetnessAt(1, 1, WET_CLASS.STONE, -5, -1.5), 0, '水下');
});

test('wetnessAt: 侧面 = 顶面 × WET_WALL_FACTOR（墙面只极弱湿）', () => {
  const top = wetnessAt(1, 1, WET_CLASS.STONE, 10, -1.5);
  const side = wetnessAt(1, 0, WET_CLASS.STONE, 10, -1.5);
  assertClose(side, top * WET_WALL_FACTOR, 1e-12);
  assertTrue(side < 0.25, '侧面湿强度必须远小于顶面');
});

test('wetAboveWaterGate: 恰好共面算水上（防边界逐帧翻转）', () => {
  assertEqual(wetAboveWaterGate(-1.5, -1.5), 1);
  assertEqual(wetAboveWaterGate(-1.6, -1.5), 0);
  assertEqual(wetAboveWaterGate(NaN, -1.5), 1);
});

// ---------- 反光三项：菲涅尔 / 高光锐度 / 天空渐变 ----------

test('wetFresnel: 边界与单调（noV=1 ⇒ F0；noV=0 ⇒ 1；noV 递减 ⇒ F 递增）', () => {
  const f0 = WET_FRESNEL_F0_BASE + WET_FRESNEL_F0_RANGE * (1 - 0.3);
  assertClose(wetFresnel(1, 0.3), f0, 1e-12);
  assertClose(wetFresnel(0, 0.3), 1, 1e-12);
  assertTrue(wetFresnel(0.2, 0.3) > wetFresnel(0.6, 0.3));
});

test('wetShininess: 粗糙度越大高光越散（单调递减），两端等于常量', () => {
  assertClose(wetShininess(0), WET_SHININESS.max, 1e-9);
  assertClose(wetShininess(1), WET_SHININESS.min, 1e-9);
  assertTrue(wetShininess(0.2) > wetShininess(0.8));
});

test('skyEnvMixAt: ry 低 ⇒ 0、ry 高 ⇒ 1；粗糙 ⇒ 过渡更缓', () => {
  assertClose(skyEnvMixAt(-1, 0.1), 0, 1e-12);
  assertClose(skyEnvMixAt(1, 0.1), 1, 1e-12);
  const sharp = skyEnvMixAt(0.3, 0.05); const soft = skyEnvMixAt(0.3, 0.9);
  assertTrue(Math.abs(soft - 0.5) < Math.abs(sharp - 0.5), '粗糙时更接近中值');
});

// ---------- 积水斑：只在致密面上，且三项同向 ----------

test('puddleAllowed: 布/植被不积水，抛光/石材积水', () => {
  assertClose(puddleAllowed(WET_CLASS_PARAMS[WET_CLASS.FABRIC][2]), 0, 1e-12, '布');
  assertClose(puddleAllowed(WET_CLASS_PARAMS[WET_CLASS.PLANT][2]), 0, 1e-12, '植被');
  assertClose(puddleAllowed(WET_CLASS_PARAMS[WET_CLASS.POLISHED][2]), 1, 1e-12, '抛光');
  assertClose(puddleAllowed(WET_CLASS_PARAMS[WET_CLASS.STONE][2]), 1, 1e-12, '石');
});

test('wetRoughnessAt / wetSpecGainAt / wetDarkenAt: 积水处更滑更亮更暗，且都钳在合法域', () => {
  const c = WET_CLASS.STONE;
  assertTrue(wetRoughnessAt(c, 1, 1) < wetRoughnessAt(c, 1, 0), '积水更滑');
  assertTrue(wetSpecGainAt(c, 1) > wetSpecGainAt(c, 0), '积水反光更强');
  assertTrue(wetDarkenAt(c, 1) < wetDarkenAt(c, 0), '积水更暗');
  assertTrue(wetSpecGainAt(WET_CLASS.POLISHED, 1) <= 1, 'specGain 钳 ≤1');
  assertTrue(wetRoughnessAt(WET_CLASS.FABRIC, 0, 0) <= 1, 'rough 钳 ≤1');
});

// ---------- mesher 类位（Review Focus #5：高位不得污染 bit0-14）----------

/**
 * 单方块 section 构建（18³ halo，中心放方块，light 全 0xF0）——
 * 与 test-mesher.js 的 meshSingle 同口径（全亮、无邻居 ⇒ 六面全出）。
 * ⚠️ atlasMeta 传空对象：mesher 对缺失 tile 回落 DEFAULT_TILE，本组只关心 packed 位。
 */
function meshOne(reg, name) {
  const data = new Uint16Array(18 * 18 * 18);
  const light = new Uint8Array(18 * 18 * 18);
  const vIdx = (dx, dy, dz) => dx + dz * 18 + dy * 324;
  data[vIdx(9, 9, 9)] = reg.idOf(name);
  for (let i = 0; i < light.length; i++) light[i] = 0xF0;
  return buildSectionMesh({ data, light, missing: false }, reg, {}, 0, 0, 0);
}

test('mesher: 每个渲染通道方块的 bit15-18 === registry.wetClassTable', () => {
  for (const def of BLOCKS) {
    if (def.cullMode !== 'opaque' && def.cullMode !== 'cutout') continue;
    const r = meshOne(REG, def.name);
    const ch = r[def.cullMode];
    assertTrue(ch.vertexCount > 0, `${def.name} 有顶点`);
    const want = REG.wetClassTable[REG.idOf(def.name)];
    for (let i = 0; i < ch.vertexCount; i++) {
      assertEqual((ch.packed[i] >>> 15) & 0xF, want, `${def.name} vert${i} 类位`);
    }
  }
});

test('mesher: 类位不污染 bit0-14（掩掉类位后既有位段语义仍成立）', () => {
  for (const name of ['cloud', 'stone', 'grass', 'hanging_lamp', 'smooth_stone']) {
    const r = meshOne(REG, name);
    const ch = r[name === 'hanging_lamp' ? 'cutout' : 'opaque'];
    assertTrue(ch.vertexCount > 0, `${name} 有顶点`);
    for (let i = 0; i < ch.vertexCount; i++) {
      const low = ch.packed[i] & 0x7FFF;
      assertEqual(low & 0xFF, 0xF0, `${name} vert${i} light 位未变`);
      assertTrue(((low >>> 10) & 0x7) <= 5, `${name} vert${i} face 位仍在 0-5`);
      assertTrue(((low >>> 8) & 0x3) <= 3, `${name} vert${i} AO 位合法`);
    }
  }
});

test('mesher: cloud 的类位是 0 且 bit14 仍置位（两条语义独立）', () => {
  const r = meshOne(REG, 'cloud');
  assertTrue(r.opaque.vertexCount > 0, 'cloud 在 opaque 通道');
  for (let i = 0; i < r.opaque.vertexCount; i++) {
    assertEqual((r.opaque.packed[i] >>> 15) & 0xF, 0, `cloud vert${i} 类位 = NONE`);
    assertEqual((r.opaque.packed[i] >>> 14) & 1, 1, `cloud vert${i} bit14 不投影`);
  }
});

// ---------- uniform 句柄形状（Node 侧有 three/tsl 解析映射，见 tools/three-resolver.mjs）----------

test('wet uniforms: 句柄形状与初值（uWet=0 是零回归锚点）', async () => {
  const { WET_SURFACE_UNIFORMS: U } = await import('../render/wet-surface.js');
  assertEqual(U.uWet.value, 0, 'uWet 初值 0 ⇒ 未接线逐位等于原材质');
  assertTrue(Number.isFinite(U.uWetWaterY.value), '水下门基准是有限数');
  assertEqual(U.uWetParams.array.length, WET_CLASS_COUNT);
  for (let i = 0; i < WET_CLASS_COUNT; i++) {
    const v = U.uWetParams.array[i];
    assertClose(v.x, WET_CLASS_PARAMS[i][0], 1e-6, `类 ${i} wetGain`);
    assertClose(v.y, WET_CLASS_PARAMS[i][1], 1e-6, `类 ${i} darken`);
    assertClose(v.z, WET_CLASS_PARAMS[i][2], 1e-6, `类 ${i} rough`);
    assertClose(v.w, WET_CLASS_PARAMS[i][3], 1e-6, `类 ${i} specGain`);
  }
});

test('wet uniforms: 天空色句柄是 Color（片元要显式拆分量，vec3(Color) 在 WebGPU 输出黑）', async () => {
  const { WET_SURFACE_UNIFORMS: U } = await import('../render/wet-surface.js');
  for (const u of [U.uWetHorizon, U.uWetZenith]) {
    assertTrue(typeof u.value.r === 'number', '有 r 分量');
    assertTrue(typeof u.value.set === 'function', '有 set 方法（DayNight 写 hex）');
  }
});

// ---------- DayNight 接线（Review Focus #3：句柄未接线时反光颜色静默错）----------

test('DayNight: _apply 把风格天空色写给湿表面（与 fogColor/sky 的入参逐位相同）', async () => {
  const { DayNight, VISUAL_STYLES } = await import('../render/daynight.js');
  // 独立真值：捕获既有两处写入的入参（不重算 Color 的 sRGB→线性转换）
  const seen = { fog: null, sky: null };
  const mkColor = () => ({ value: { r: -1, g: -1, b: -1, set(v) { this.hex = v; } } });
  const h = mkColor(); const z = mkColor();
  const dn = new DayNight({
    scene: { background: { set(v) { seen.sky = v; } } },
    fog: { fogColor: { value: { set(v) { seen.fog = v; } } }, fogNear: { value: 0 }, fogFar: { value: 0 } },
    voxelUniforms: {
      uSkyDim: { value: 0 }, uBlockBoost: { value: 0 }, uShadowStrength: { value: 0 },
      uWetHorizon: h, uWetZenith: z,
    },
    visualStyle: 'dusk',
  });
  const d = VISUAL_STYLES.dusk;
  assertEqual(seen.fog, d.fogColor, '既有 fogColor 写入（独立真值）');
  assertEqual(seen.sky, d.sky, '既有 background 写入（独立真值）');
  assertEqual(h.value.hex, seen.fog, 'uWetHorizon 必须等于 fogColor');
  assertEqual(z.value.hex, seen.sky, 'uWetZenith 必须等于 sky');
  assertTrue(d.fogColor !== d.sky, 'dusk 两色不同 ⇒ 能区分句柄没接反');
  // 切风格后必须跟着变（不是只在构造时写一次）
  dn.setStyle('night');
  assertEqual(h.value.hex, VISUAL_STYLES.night.fogColor, '切夜后 horizon 跟随');
  assertEqual(z.value.hex, VISUAL_STYLES.night.sky, '切夜后 zenith 跟随');
});

test('DayNight: 湿表面句柄缺失时不抛错（既有调用方 / fixture 零回归）', async () => {
  const { DayNight } = await import('../render/daynight.js');
  const dn = new DayNight({
    scene: {},
    fog: { fogColor: { value: { set() {} } }, fogNear: { value: 0 }, fogFar: { value: 0 } },
    voxelUniforms: { uSkyDim: { value: 0 }, uBlockBoost: { value: 0 }, uShadowStrength: { value: 0 } },
  });
  dn.setStyle('noon');
  assertTrue(true, '未抛错');
});
