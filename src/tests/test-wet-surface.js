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
  WET_CLASS_PARAMS, WET_WALL_FACTOR, WET_SHININESS, WET_REFL_MAX, WET_REFL_FLOOR,
  WET_FRESNEL_F0_BASE, WET_FRESNEL_F0_RANGE,
  WET_SUN_SPEC, WET_PUDDLE_FROM, WET_PUDDLE_TO, WET_PUDDLE_SCALE,
  WET_PUDDLE_MIRROR, WET_PUDDLE_CLOUD, WET_PUDDLE_CLOUD_SCALE,
  wetnessAt, wetAboveWaterGate, wetRoughnessAt, puddleAllowed,
  wetFresnel, wetShininess, skyEnvMixAt, wetSpecGainAt, wetDarkenAt,
  wetReflFloor, wetReflK,
  wetPuddleMirrorK, wetPuddleReflK, wetPuddleSkyMul,
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
  assertEqual(U.uWetShelter.value, 1, 'uWetShelter 初值 1（第四级零回归锚点，写 0 回到 v3.33）');
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

// ---------- 反光量级地板（v3.31，用户 2026-11-22 裁定「加非物理地板，反光明显」）----------

/**
 * 为什么需要地板：Schlick 菲涅尔在半俯视（noV≈0.53）时 F≈0.068 ——
 * 物理上湿石头在该角度只反射约 7% 的光，屏幕上 Δluma 仅 1.5（8bit 量化后分不开）。
 * 三个旋钮（WET_REFL_MAX / 菲涅尔幂 / F0 基数）全扇描完最强也只 3.81，
 * 低于设计稿目标带下界 6 ⇒ 用户裁定加一个**非物理地板**。
 *
 * ⚠️ 地板必须**随粗糙度衰减**（`FLOOR × (1−rough)`）：
 * 否则布/植被也会反光，材质分层就没了（用户明确否决「只有一种反光材质」）。
 */
test('wet refl: 地板随粗糙度衰减 —— 抛光拿满、布几乎拿不到', () => {
  const rPol = WET_CLASS_PARAMS[WET_CLASS.POLISHED][2];
  const rFab = WET_CLASS_PARAMS[WET_CLASS.FABRIC][2];
  const kPol = wetReflFloor(rPol);
  const kFab = wetReflFloor(rFab);
  assertTrue(kPol > kFab * 8, `抛光地板 ${kPol} 须远大于布 ${kFab}`);
  assertClose(wetReflFloor(1), 0, 1e-12, '完全粗糙 ⇒ 无地板');
  assertClose(wetReflFloor(0), WET_REFL_FLOOR, 1e-12, '完全光滑 ⇒ 满地板');
});

test('wet refl: 半俯视（noV=0.53）抛光石的 Δluma 落在目标带 [6,40]', () => {
  // 口径与设计稿 §6.1b 一致：真实 atlas 基色 + 正午天空色，sRGB 0~255
  const BASE = 0.3816;   // Smooth_Stone 的线性 luma（真实 atlas 像素实测）
  const SKY = 0.5529;    // 0x87ceeb 的线性 luma
  const noV = 5 / Math.hypot(5, 8);   // 用例②机位：俯视 32°
  const srgb = (v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
  const dLuma = (cls) => {
    const rough = wetRoughnessAt(cls, 1, 0);
    const k = wetReflK(noV, rough, wetSpecGainAt(cls, 0), wetnessAt(1, 1, cls, 10, -1.5));
    return (srgb(BASE + (SKY - BASE) * k) - srgb(BASE)) * 255;
  };
  const pol = dLuma(WET_CLASS.POLISHED);
  assertTrue(pol >= 6 && pol <= 40, `抛光石 Δluma=${pol.toFixed(2)} 须 ∈[6,40]`);
  // 材质分层在真实像素上也成立：布的变化必须远小于抛光
  assertTrue(dLuma(WET_CLASS.FABRIC) < pol / 10, '布的 Δluma 须 < 抛光的 1/10');
  // 序关系（反光项，不含压暗）
  assertTrue(dLuma(WET_CLASS.STONE) > dLuma(WET_CLASS.WOOD), '石 > 木');
  assertTrue(dLuma(WET_CLASS.WOOD) > dLuma(WET_CLASS.SOIL), '木 > 土');
  assertTrue(dLuma(WET_CLASS.SOIL) > dLuma(WET_CLASS.FABRIC), '土 > 布');
});

test('wet refl: reflK 恒有界（含积水与金属/冰的极端组合）—— mix 不会钳白', () => {
  for (let cls = 0; cls < WET_CLASS_COUNT; cls++) {
    for (const up of [1, 0, -1]) {
      for (const puddle of [0, 1]) {
        for (const noV of [0, 0.2, 0.53, 0.9, 1]) {
          const rough = wetRoughnessAt(cls, up, puddle);
          const k = wetReflK(noV, rough, wetSpecGainAt(cls, puddle), wetnessAt(1, up, cls, 10, -1.5));
          assertTrue(k >= 0 && k <= WET_REFL_MAX,
            `cls${cls} up${up} puddle${puddle} noV${noV}: reflK=${k} 须 ∈[0,${WET_REFL_MAX}]`);
        }
      }
    }
  }
});

// ---------- 类位越界防御（Final review 自审发现的 Important）----------

/**
 * `packed` 类位是 **4 bit**（能表达 0..15），而参数表只有 **9** 项。
 * CPU 侧纯函数有 `if (!p) return` 回落，但 GPU 侧 `.element(cls)` 会**越界读
 * uniform buffer**（WGSL undefined behavior：可能读 0、读邻项、或触发验证错误
 * ⇒ 整片材质不上屏）。
 *
 * 真实可达路径：将来扩类到 >9 却忘了扩数组、或旧 section 缓存里的高位残留。
 * ⇒ 两侧必须同构：GPU 侧也要把索引钳到 `WET_CLASS_COUNT − 1`。
 *
 * ⚠️ 钳到最后一项（PLANT，极弱湿）而不是 NONE：钳到 0 需要额外一次 select，
 * 而 PLANT 的 wetGain 0.35 / specGain 0.05 已经是「几乎不湿」的安全侧。
 */
test('wet class: 类位越界（9..15）时 CPU 侧安全回落，且与 GPU 钳制口径一致', () => {
  for (let cls = WET_CLASS_COUNT; cls <= 15; cls++) {
    // CPU 侧：表外的类一律不湿（params[cls] undefined ⇒ 早退）
    assertEqual(wetnessAt(1, 1, cls, 10, -1.5), 0, `cls ${cls} 不湿`);
    assertEqual(wetSpecGainAt(cls, 0), 0, `cls ${cls} 无镜面`);
    assertEqual(wetDarkenAt(cls, 0), 1, `cls ${cls} 不压暗`);
    assertEqual(wetRoughnessAt(cls, 1, 0), 1, `cls ${cls} 全粗糙`);
  }
});

test('wet class: GPU 侧索引必须钳到表长 − 1（防越界读 uniform buffer）', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../render/wet-surface.js', import.meta.url), 'utf8');
  const code = src.split('\n')
    .filter((l) => { const t = l.trim(); return t && !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*'); })
    .join('\n');
  // 必须存在 min(cls, WET_CLASS_COUNT-1) 这类钳制，且 element() 吃的是钳制后的值
  assertTrue(/const clsSafe = min\(cls, (?:float|int|uint)\(WET_CLASS_COUNT - 1\)\)/.test(code)
    || /const clsSafe = min\(cls, WET_CLASS_COUNT - 1\)/.test(code),
  '必须有 clsSafe = min(cls, WET_CLASS_COUNT − 1)');
  assertTrue(/uWetParams\.element\(clsSafe\)/.test(code), 'element() 必须吃钳制后的索引');
  assertTrue(!/uWetParams\.element\(cls\)/.test(code), '不得直接用未钳制的 cls');
});

// ==================== v3.32 积水斑的镜面反光 ====================
//
// 设计稿：docs/superpowers/specs/2026-11-23-puddle-mirror-reflection-design.md
//
// ## 本轮根因（用户 2026-11-23「水汪没有反光」）
//
// v3.31 的积水修正只有 rough×0.25 / specGain×1.60 / albedo×0.88 三项，反光仍走
// 同一条 reflK。而 **specGain 被 min(…,1) 钳死**、抛光类本来就是 1.0
// ⇒ ×1.60 后仍是 1.0，**一点没涨**。实测（noV 0.53）抛光 reflK 0.1883 → 0.1962（+4%），
// 却额外压暗 12% ⇒ 屏幕上水汪比周边**暗 5.9 luma**。
// ⇒ 必须给积水一条**独立于菲涅尔的绝对镜面目标**，而不是再乘一个系数。
//
// ⚠️ 标定代入的是**真实掩码峰值 0.7682**（GPU 探针实测，绕开 ACES），不是 1.0 ——
// smoothstep(0.52,0.76,n) 而噪声 n 的 p95 才 0.753 ⇒ 按 p=1 算会高估效果 26%。

/** 真实标定口径（与 Tier 4 机位一致）：atlas 基色 / 正午天空 / 俯视 32° / 掩码峰值 */
const PUDDLE_PROBE = Object.freeze({
  BASE: 0.3816,                      // Smooth_Stone 线性 luma（真实 atlas 像素）
  SKY: 0.5529,                       // 0x87ceeb 线性 luma
  noV: 5 / Math.hypot(5, 8),         // 0.5299
  p: 0.7682,                         // GPU 实测掩码峰值
});
const srgb255 = (v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055) * 255;

/** 屏幕 luma：albedo 压暗后与天空环境按 reflK 混合（与 TSL 合成同构） */
function puddleLuma(cls, up, puddle, reflStrength, skyMul = 1) {
  const { BASE, SKY, noV } = PUDDLE_PROBE;
  const wet = wetnessAt(1, up, cls, 10, -1.5);
  const k = wetPuddleReflK(noV, cls, up, puddle, wet, reflStrength);
  const d = wetDarkenAt(cls, puddle);
  return srgb255(BASE * d + (SKY * skyMul - BASE * d) * k);
}

test('puddle mirror: 三条归零门 —— 非朝上面 / 强度 0 / 无积水', () => {
  const c = WET_CLASS.POLISHED;
  const w = wetnessAt(1, 1, c, 10, -1.5);
  assertEqual(wetPuddleMirrorK(c, 1, w, 0, 1), 0, '侧面恒 0（防岩壁光晕复活）');
  assertEqual(wetPuddleMirrorK(c, 1, w, -1, 1), 0, '底面恒 0');
  assertEqual(wetPuddleMirrorK(c, 1, w, 1, 0), 0, 'reflStrength=0');
  assertEqual(wetPuddleMirrorK(c, 0, w, 1, 1), 0, 'puddle=0');
  // ⚠️ 不写死绝对值（原为 >0.5，那是 MIRROR=0.70 时代的数）：
  // 目标值随常量标定变，关系式才是判据 —— 满积水顶面应拿到 specGain 加权后的满 MIRROR。
  assertClose(wetPuddleMirrorK(c, 1, w, 1, 1), WET_PUDDLE_MIRROR * wetSpecGainAt(c, 1) * w,
    1e-12, '顶面满积水 = MIRROR × specGain × wet');
  assertTrue(wetPuddleMirrorK(c, 1, w, 1, 1) > 0.3, '顶面满积水仍须有实质镜面目标');
});

test('puddle refl: reflStrength=0 与 puddle=0 都逐位等于 v3.31 的 wetReflK（第二级零回归锚点）', () => {
  for (let cls = 0; cls < WET_CLASS_COUNT; cls++) {
    for (const up of [1, 0, -1]) {
      for (const p of [0, 0.3, 0.7682, 1]) {
        for (const noV of [0, 0.2, 0.53, 0.9, 1]) {
          const wet = wetnessAt(1, up, cls, 10, -1.5);
          const old = wetReflK(noV, wetRoughnessAt(cls, up, p), wetSpecGainAt(cls, p), wet);
          assertEqual(wetPuddleReflK(noV, cls, up, p, wet, 0), old,
            `cls${cls} up${up} p${p} noV${noV}: strength=0 须逐位回到旧式`);
        }
      }
      const wet = wetnessAt(1, up, cls, 10, -1.5);
      const old0 = wetReflK(0.53, wetRoughnessAt(cls, up, 0), wetSpecGainAt(cls, 0), wet);
      assertEqual(wetPuddleReflK(0.53, cls, up, 0, wet, 1), old0, `cls${cls} up${up}: puddle=0 须等于旧式`);
    }
  }
});

test('puddle refl: 墙面（up=0）任意积水程度都与 v3.31 逐位相同', () => {
  for (let cls = 0; cls < WET_CLASS_COUNT; cls++) {
    for (const p of [0, 0.5, 0.7682, 1]) {
      for (const noV of [0.15, 0.53, 0.86]) {
        const wet = wetnessAt(1, 0, cls, 10, -1.5);
        const old = wetReflK(noV, wetRoughnessAt(cls, 0, p), wetSpecGainAt(cls, p), wet);
        assertEqual(wetPuddleReflK(noV, cls, 0, p, wet, 1), old, `cls${cls} p${p} noV${noV} 墙面零回归`);
      }
    }
  }
});

test('puddle refl: 全组合有界（675 组）且顶面积水显著强于水膜', () => {
  let maxK = 0;
  for (let cls = 0; cls < WET_CLASS_COUNT; cls++) {
    for (const up of [1, 0, -1]) {
      for (const p of [0, 0.25, 0.5, 0.7682, 1]) {
        for (const noV of [0, 0.2, 0.53, 0.9, 1]) {
          const wet = wetnessAt(1, up, cls, 10, -1.5);
          const k = wetPuddleReflK(noV, cls, up, p, wet, 1);
          assertTrue(k >= 0 && k <= 1, `cls${cls} up${up} p${p} noV${noV}: reflK=${k} 须 ∈[0,1]`);
          maxK = Math.max(maxK, k);
        }
      }
    }
  }
  // ⚠️ 上界是 **max(WET_REFL_MAX, MIRROR)** 而不是单 MIRROR：
  // 水膜项在掠射（noV→0）时可达 MAX=0.55，减半后 MIRROR=0.44 < 0.55
  // ⇒ 全组合上界由**水膜项**决定（这是正确行为，不是缺陷）。
  const bound = Math.max(WET_REFL_MAX, WET_PUDDLE_MIRROR);
  assertTrue(maxK <= bound + 1e-9, `全组合上界 ${maxK} 不得超过 max(MAX,MIRROR)=${bound}`);
  // 四类致密材质：顶面积水仍须强于同条件水膜（减半后不得退化成「没效果」）
  // ⚠️ 倍数从 1.5 降到 1.25：减半后抛光实测 1.34×（原 1.62×），
  // 仍留判别力（若 MIRROR 退化到 ≤0.30 则比值 <1.1，本条会红）。
  for (const cls of [WET_CLASS.POLISHED, WET_CLASS.STONE, WET_CLASS.WOOD, WET_CLASS.SOIL]) {
    const wet = wetnessAt(1, 1, cls, 10, -1.5);
    const film = wetReflK(0.53, wetRoughnessAt(cls, 1, 0), wetSpecGainAt(cls, 0), wet);
    const pud = wetPuddleReflK(0.53, cls, 1, PUDDLE_PROBE.p, wet, 1);
    assertTrue(pud > film * 1.25, `cls${cls}: 积水 reflK ${pud} 须 > 水膜 ${film} 的 1.25 倍`);
  }
});

test('puddle sky: 云影调制在非顶面 / 无积水 / 强度 0 时恒 1，值域 ⊂ [1−CLOUD, 1+CLOUD]', () => {
  for (const cloud of [-1, -0.4, 0, 0.4, 1]) {
    assertEqual(wetPuddleSkyMul(cloud, 1, 0, 1), 1, '侧面恒 1');
    assertEqual(wetPuddleSkyMul(cloud, 1, -1, 1), 1, '底面恒 1');
    assertEqual(wetPuddleSkyMul(cloud, 0, 1, 1), 1, '无积水恒 1');
    assertEqual(wetPuddleSkyMul(cloud, 1, 1, 0), 1, '强度 0 恒 1');
    const m = wetPuddleSkyMul(cloud, 1, 1, 1);
    assertTrue(m >= 1 - WET_PUDDLE_CLOUD - 1e-9 && m <= 1 + WET_PUDDLE_CLOUD + 1e-9,
      `cloud${cloud}: skyMul=${m} 越界`);
  }
  assertTrue(wetPuddleSkyMul(1, 1, 1, 1) > wetPuddleSkyMul(-1, 1, 1, 1), 'cloud 单调递增');
  assertClose(wetPuddleSkyMul(0, 1, 1, 1), 1, 1e-12, 'cloud=0 ⇒ 中性');
});

test('puddle 量级带: 抛光相对水膜的总差 ∈[4,12]、布几乎不变、且抛光>石>木>土', () => {
  const { p } = PUDDLE_PROBE;
  /**
   * ⚠️⚠️ **必须乘上真实积水门 `puddleAllowed(rough0)`**（本轮自审发现的恒真判据）：
   * 布/植被的 rough0 ≥ gate.to(0.80) ⇒ `puddleAllowed` 实测 **0**
   * ⇒ 真实渲染里它们的 puddle **恒 0**，根本不会出现「布上的水汪」。
   * 旧写法直接传 p=0.7682 给所有类，测的是**不可达状态**：
   * M 降低后 mix 目标变小、压暗项相对更突出 ⇒ 布的假 Δ 从 −2.22 变 −3.43，
   * 而那在屏幕上永远不会发生。⇒ 改成逐类乘真实门后再比。
   */
  const effP = (cls) => p * puddleAllowed(wetRoughnessAt(cls, 1, 0));
  const d = (cls) => puddleLuma(cls, 1, effP(cls), 1) - puddleLuma(cls, 1, 0, 1);
  const pol = d(WET_CLASS.POLISHED);
  assertTrue(pol >= 4 && pol <= 12, `抛光总差 Δluma=${pol.toFixed(2)} 须 ∈[4,12]`);
  // 布/植被：真实门为 0 ⇒ 水汪与水膜逐位相同（这才是「材质分层」的真判据）
  assertClose(d(WET_CLASS.FABRIC), 0, 1e-9, '布不积水 ⇒ 零差');
  assertClose(d(WET_CLASS.PLANT), 0, 1e-9, '植被不积水 ⇒ 零差');
  assertTrue(pol > d(WET_CLASS.STONE), '抛光 > 石');
  assertTrue(d(WET_CLASS.STONE) > d(WET_CLASS.WOOD), '石 > 木');
  assertTrue(d(WET_CLASS.WOOD) > d(WET_CLASS.SOIL), '木 > 土');
});

/**
 * v3.32b（用户 2026-11-23：「上一版本的积水增量的幅度减半」）。
 *
 * ⚠️ **基准是 v3.31（`uWetPuddleRefl = 0`）的水汪亮度，不是水膜亮度**：
 * 用户说的是「上一版本的**增量**」—— 即本轮引入的那部分，
 * 而不是「水汪相对周边水膜的总差」。两者相差很大：
 * 抛光总差 15.85 而本轮增量 **20.37**（v3.31 的水汪比水膜还暗）。
 * 取错基准会把强度调成 0.50 而不是 0.44。
 *
 * 实测（noV 0.53、真实掩码峰值 0.7682）：
 *   类        v3.31    M=0.70   增量    目标(半)
 *   POLISHED  156.82   177.20   20.37   10.19
 *   STONE     143.96   159.15   15.19    7.59
 *   WOOD      143.41   154.67   11.26    5.63
 *   SOIL      131.37   140.85    9.48    4.74
 *   FABRIC    121.62   124.29    2.67    1.33
 * MIRROR 扇描 0.40 / 0.42 / 0.44 / 0.46 / 0.48 的 RMS 误差
 *   0.821 / 0.334 / 0.263 / 0.735 / 1.231 ⇒ 取 0.44。
 */
test('puddle 减半: 各类相对 v3.31 的增量落在原增量的一半 ±1.5 luma', () => {
  const { p, BASE, SKY, noV } = PUDDLE_PROBE;
  // v3.31 的水汪亮度 = reflStrength 0（第二级零回归锚点）
  const v331 = (cls) => puddleLuma(cls, 1, p, 0);
  // 原 M=0.70 的读数（写入字面量作为独立真值，不读实现常量互推）
  const OLD = { [WET_CLASS.POLISHED]: 20.37, [WET_CLASS.STONE]: 15.19,
    [WET_CLASS.WOOD]: 11.26, [WET_CLASS.SOIL]: 9.48, [WET_CLASS.FABRIC]: 2.67 };
  void [BASE, SKY, noV];
  for (const [cls, oldDelta] of Object.entries(OLD)) {
    const c = Number(cls);
    const nowDelta = puddleLuma(c, 1, p, 1) - v331(c);
    const want = oldDelta / 2;
    assertTrue(Math.abs(nowDelta - want) <= 1.5,
      `cls${c}: 增量 ${nowDelta.toFixed(2)} 须 ≈ 原 ${oldDelta} 的一半 ${want.toFixed(2)}（±1.5）`);
  }
});

test('puddle 云影: 水汪内的 luma 跨度落在 [6,18]（不是纯色塑料板）', () => {
  const { p } = PUDDLE_PROBE;
  const amp = WET_PUDDLE_CLOUD * p;      // 云影幅度已 × puddle（与 TSL 同构）
  const hi = puddleLuma(WET_CLASS.POLISHED, 1, p, 1, 1 + amp);
  const lo = puddleLuma(WET_CLASS.POLISHED, 1, p, 1, 1 - amp);
  const span = hi - lo;
  assertTrue(span >= 6 && span <= 18, `抛光水汪云影跨度 ${span.toFixed(2)} 须 ∈[6,18]`);
  // 云影不得让水汪过曝：最亮组合仍远低于 250
  assertTrue(hi < 240, `水汪最亮 ${hi.toFixed(1)} 不得逼近过曝`);
});

test('puddle 减半: 云影幅度常量减半，且跨度落在双重衰减后的预期值', () => {
  const { p } = PUDDLE_PROBE;
  // 常量层面：0.25 的一半（独立真值，不读实现互推）
  assertClose(WET_PUDDLE_CLOUD, 0.25 / 2, 1e-12, 'CLOUD 必须是原 0.25 的一半');
  const amp = WET_PUDDLE_CLOUD * p;
  const span = puddleLuma(WET_CLASS.POLISHED, 1, p, 1, 1 + amp)
    - puddleLuma(WET_CLASS.POLISHED, 1, p, 1, 1 - amp);
  /**
   * ⚠️⚠️ **不能用「原 span 22.44 的一半」当判据**（本轮自审发现的口径错）：
   * span 同时正比于 **reflK（受 MIRROR 控制）** 与 **CLOUD**，
   * 两个旋钮都减半 ⇒ span 是**双重衰减**，不是减半。
   * 实测：M 0.70→0.44 且 CLOUD 0.25→0.125 ⇒ span 22.44 → **7.94**。
   * 正确判据：固定 M=0.44 下单独扇描 CLOUD 得到的预期值（已写入 config 注释）。
   */
  assertTrue(Math.abs(span - 7.94) <= 1.0,
    `云影跨度 ${span.toFixed(2)} 须 ≈ 7.94（M 与 CLOUD 双双减半后的实测值，±1）`);
});

test('puddle 常量: 既有四个常量未被偷偷放宽（本轮只加不改）', () => {
  assertEqual(WET_REFL_MAX, 0.55, 'WET_REFL_MAX 不动');
  assertEqual(WET_REFL_FLOOR, 0.28, 'WET_REFL_FLOOR 不动');
  assertEqual(WET_SUN_SPEC, 0.22, 'WET_SUN_SPEC 不动（水汪处 pow 下溢，抬它零作用）');
  assertEqual(WET_PUDDLE_FROM, 0.52, '积水阈值带不动');
  assertEqual(WET_PUDDLE_TO, 0.76, '积水阈值带不动');
  assertEqual(WET_PUDDLE_SCALE, 0.32, '积水噪声尺度不动');
  assertTrue(WET_PUDDLE_CLOUD_SCALE < WET_PUDDLE_SCALE,
    '云影斑块必须比积水斑大（否则每摊水自带一个亮斑）');
});

test('puddle uniforms: uWetPuddleRefl 初值 1，uWet 初值仍 0（两级零回归锚点）', async () => {
  const { WET_SURFACE_UNIFORMS: U } = await import('../render/wet-surface.js');
  assertEqual(U.uWetPuddleRefl.value, 1, '积水反光默认开');
  assertEqual(U.uWet.value, 0, '总强度默认关');
});

// ------------------------------------------------ v3.34 逐点遮挡门（CPU 同构）
//
// 设计稿：docs/superpowers/specs/2026-11-23-rain-per-point-shelter-design.md §4.6
// TSL 侧在 wet-surface.js，两侧**判据与常量必须逐位同构**（红线 1）。

test('wet shelter gate: 未知/关档恒 1，棚下 0，棚外 1（CPU 与 GPU 同构）', async () => {
  const { wetShelterGate } = await import('../render/wet-surface-config.js');
  const { encodeStopY } = await import('../voxel/rain-occlusion-data.js');
  const roof = encodeStopY(10);        // 屋顶顶面 y=10
  assertEqual(wetShelterGate(10.5, 0, 1), 1, 'R=0 未知 ⇒ 不遮挡');
  assertEqual(wetShelterGate(5.5, roof, 0), 1, 'strength=0 ⇒ 逐位回到 v3.33');
  assertEqual(wetShelterGate(5.5, roof, 1), 0, '探针在屋顶之下 ⇒ 干');
  assertEqual(wetShelterGate(10.5, roof, 1), 1, '屋顶自身顶面之上 ⇒ 湿');
});

// ★ P0-2 的判别力锚点：非整格顶面方块的露头顶面必须湿
// 实测几何顶面（真实 TEMPLATES）：half_block=0.5、horizontal_pillar=0.65、cactus=1.05
test('wet shelter gate: 半砖/横柱/仙人掌的露头顶面必须湿（探针共面陷阱）', async () => {
  const { wetShelterGate } = await import('../render/wet-surface-config.js');
  const { encodeStopY } = await import('../voxel/rain-occlusion-data.js');
  const ground = encodeStopY(1);       // 方块在 y=0，格顶 stop=1
  assertEqual(wetShelterGate(1.0, ground, 1), 1, 'sand_slab 露头顶面不得被判干');
  assertEqual(wetShelterGate(1.15, ground, 1), 1, 'horizontal_pillar 露头顶面必须湿');
  assertEqual(wetShelterGate(1.55, ground, 1), 1, 'cactus 露头顶面必须湿');
  assertEqual(wetShelterGate(5.0, encodeStopY(5), 1), 1, '半砖棚顶自身必须湿');
});

test('wet shelter gate: 穷举全部挡雨方块 × cellY 0..3 × 有无屋顶（几何顶面从真实 TEMPLATES 算）', async () => {
  const { wetShelterGate } = await import('../render/wet-surface-config.js');
  const { encodeStopY } = await import('../voxel/rain-occlusion-data.js');
  const { TEMPLATES } = await import('../mesh/mesher.js');
  const { blocksRain } = await import('../render/rain-shelter.js');

  /** 该方块几何的真实顶面（逐顶点取 max y，不写死数字） */
  const topOf = (def) => {
    const tpl = TEMPLATES[def.geometry || 'cube'];
    if (!Array.isArray(tpl)) return 1;
    let top = -Infinity;
    for (const q of tpl) for (const v of q.v) if (v[1] > top) top = v[1];
    return Number.isFinite(top) ? top : 1;
  };

  let n = 0;
  for (const def of BLOCKS) {
    const bid = REG.idOf(def.name);
    if (!blocksRain(bid, REG)) continue;
    const top = topOf(def);
    for (let cellY = 0; cellY <= 3; cellY++) {
      const probeY = cellY + top + 0.5;      // 探针 = 几何顶面 + 法线偏移 0.5
      // ① 无上方屋顶：stop = 自己这一格的格顶 ⇒ 必须湿
      assertEqual(wetShelterGate(probeY, encodeStopY(cellY + 1), 1), 1,
        `${def.name}@y=${cellY} 露天顶面必须湿（几何顶面 ${top}）`);
      // ② 上方 y=6 有屋顶：stop=7 ⇒ 必须干
      assertEqual(wetShelterGate(probeY, encodeStopY(7), 1), 0,
        `${def.name}@y=${cellY} 屋顶下必须干`);
      n += 2;
    }
  }
  assertTrue(n >= 1000, `穷举应 >= 1000 例，实际 ${n}`);
});
