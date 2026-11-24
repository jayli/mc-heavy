// src/tests/test-footstep-surface.js — 跑动脚步声「按地表选哪一路」的契约（Tier 1，v3.38）
//
// 用户 2026-11-24：「开启雨天光影的时候，当玩家进入被雨淋的湿地的时候，跑动时的脚步声用
// running_wet.wav……当回到非被淋雨的区域时，才用回 running_land.mp3；当未开启雨天光影的
// 时候，玩家跑动时的音效始终都是 running_land.mp3」。
//
// 本文件钉两层：
//   ① `player/footstep-surface.js` 的**纯函数契约**（三档优先级、音量表、互斥 id）；
//   ② `render/rain-shelter.js` 的 `rainWetGround`（判据本体：头顶无屋顶 ∧ 材质会湿）——
//      它是脚步声与湿地面着色器**共用的同一份权威**，故放在同一份 spec 里一起钉住，
//      避免「函数改了判据而只有渲染那条路径红」。
//
// ⚠️ 判据一律跑**真实 registry**（`blocks-data.js` 的声明），不写名字白名单：
//   与 `test-rain-shelter.js` 同一口径（红线 1）。
import { test } from './runner.js';
import { assertEqual, assertTrue, assertFalse } from './assert.js';
import { createRegistry } from '../voxel/block-registry.js';
import { BLOCKS } from '../voxel/blocks-data.js';
import { WET_CLASS, WET_CLASS_DATA } from '../voxel/wet-material-data.js';
import { WORLD_MIN_Y } from '../voxel/constants.js';
import {
  FOOTSTEP_SURFACE, FOOTSTEP_LOOPS, footstepSurfaceOf, otherFootstepId,
} from '../player/footstep-surface.js';
import { rainWetGround, blocksRain } from '../render/rain-shelter.js';
import { SOUND_IDS } from '../render/audio-config.js';

const REG = createRegistry();
for (const def of BLOCKS) REG.register(def.name, def);
REG.freeze();
const id = (n) => REG.idOf(n);

/** 假 world：按 Map<'x,y,z', blockId> 回答，其余 air（与 test-rain-shelter.js 同口径） */
function fakeWorld(cells) {
  return {
    getBlockId(x, y, z) {
      if (y < WORLD_MIN_Y) return id('bedrock');
      return cells.get(`${x},${y},${z}`) ?? 0;
    },
  };
}
function put(cells, x, y, z, name) { cells.set(`${x},${y},${z}`, id(name)); }

// ---------- ① 三档优先级 ----------

test('footstep-surface: 三档优先级 —— 入水 > 雨天湿地 > 陆地', () => {
  assertEqual(footstepSurfaceOf({ inWater: true, onRainWetGround: true }),
    FOOTSTEP_SURFACE.WATER, '在水里且脚下会湿：水优先（人已经在水里）');
  assertEqual(footstepSurfaceOf({ inWater: true, onRainWetGround: false }),
    FOOTSTEP_SURFACE.WATER, '在水里：恒水档');
  assertEqual(footstepSurfaceOf({ inWater: false, onRainWetGround: true }),
    FOOTSTEP_SURFACE.WET, '不在水里且踩在被雨淋的湿地：湿档');
  assertEqual(footstepSurfaceOf({ inWater: false, onRainWetGround: false }),
    FOOTSTEP_SURFACE.LAND, '其余：陆地档');
});

test('footstep-surface: 缺省实参 / 非布尔真值一律回落陆地档（安全失败）', () => {
  assertEqual(footstepSurfaceOf(), FOOTSTEP_SURFACE.LAND, '不传参数 ⇒ 陆地');
  assertEqual(footstepSurfaceOf({}), FOOTSTEP_SURFACE.LAND, '空对象 ⇒ 陆地');
  // ⚠️ 必须要求**严格 true**：装配层谓词返回 undefined/1 时不得静默切水声
  assertEqual(footstepSurfaceOf({ onRainWetGround: 1 }), FOOTSTEP_SURFACE.LAND,
    '非布尔真值不得当成「在湿地上」');
  assertEqual(footstepSurfaceOf({ inWater: 'yes' }), FOOTSTEP_SURFACE.LAND,
    '非布尔真值不得当成「在水里」');
});

// ---------- ② 音量/id 表 ----------

test('footstep-surface: 三个 id 都在预载清单里（漏了 = 静默无声）', () => {
  for (const key of Object.keys(FOOTSTEP_LOOPS)) {
    const loop = FOOTSTEP_LOOPS[key];
    assertTrue(SOUND_IDS.includes(loop.id), `${key} 的 id ${loop.id} 必须在 SOUND_IDS 里`);
    assertTrue(loop.volume > 0 && loop.volume <= 1, `${key} 的音量必须在 (0,1]`);
  }
});

test('footstep-surface: 湿地与陆地同档 0.2，入水 0.25（用户 2026-11-24 裁定）', () => {
  assertEqual(FOOTSTEP_LOOPS.land.id, 'running_land');
  assertEqual(FOOTSTEP_LOOPS.wet.id, 'running_wet');
  assertEqual(FOOTSTEP_LOOPS.water.id, 'running_wet');
  // ⚠️ 湿地取 0.2 的理由：running_wet.wav 的 RMS 已对齐 running_land
  // ⇒ 同档时过屋檐只换音色、不跳音量（0.25 会多约 2dB 的台阶）。
  assertEqual(FOOTSTEP_LOOPS.wet.volume, 0.2, '湿地音量与陆地同档');
  assertEqual(FOOTSTEP_LOOPS.land.volume, 0.2);
  assertEqual(FOOTSTEP_LOOPS.water.volume, 0.25, '入水仍 0.25（v3.37 口径不变）');
});

test('footstep-surface: 互斥 id —— 湿/水共用 running_wet，故停的永远是 running_land', () => {
  assertEqual(otherFootstepId(FOOTSTEP_SURFACE.WET), 'running_land');
  assertEqual(otherFootstepId(FOOTSTEP_SURFACE.WATER), 'running_land');
  assertEqual(otherFootstepId(FOOTSTEP_SURFACE.LAND), 'running_wet');
  assertEqual(otherFootstepId('bogus'), null, '非法档位返回 null（调用方不得只凭它停播）');
});

// ---------- ③ 判据本体：rainWetGround ----------

test('rain-wet-ground: 露天草地是湿地', () => {
  const cells = new Map();
  put(cells, 4, 20, 4, 'grass');
  assertTrue(rainWetGround(fakeWorld(cells), REG, 4.5, 21, 4.5), '露天草地必须算湿地');
});

test('rain-wet-ground: 头顶盖石砖屋顶 ⇒ 不是湿地（进屋即回陆地音）', () => {
  const cells = new Map();
  put(cells, 4, 20, 4, 'grass');
  put(cells, 4, 24, 4, 'stone_bricks');
  assertTrue(blocksRain(id('stone_bricks'), REG), '前置：石砖确实挡雨');
  assertFalse(rainWetGround(fakeWorld(cells), REG, 4.5, 21, 4.5), '屋顶下必须算干地');
});

test('rain-wet-ground: 头顶盖玻璃屋顶也算干地（与雨效「玻璃算屋顶」一致）', () => {
  const cells = new Map();
  put(cells, 4, 20, 4, 'grass');
  put(cells, 4, 24, 4, 'glass_block');
  assertFalse(rainWetGround(fakeWorld(cells), REG, 4.5, 21, 4.5), '玻璃屋顶下算干地');
});

test('rain-wet-ground: 头顶是树叶 ⇒ 仍是湿地（树叶不挡雨，与雨效一致）', () => {
  const cells = new Map();
  put(cells, 4, 20, 4, 'grass');
  // 用真实的镂空遮挡体（树叶族）里任意一个，避免写死某个名字的假设
  const leaf = BLOCKS.find((b) => REG.hollowOccluderTable[id(b.name)] === 1);
  assertTrue(!!leaf, '前置：至少有一个镂空遮挡体（树叶族）');
  put(cells, 4, 24, 4, leaf.name);
  assertTrue(rainWetGround(fakeWorld(cells), REG, 4.5, 21, 4.5),
    `${leaf.name} 不挡雨 ⇒ 树下仍是湿地`);
});

test('rain-wet-ground: 云上 / 不可湿材质上不是湿地', () => {
  const cloudCells = new Map();
  put(cloudCells, 4, 20, 4, 'cloud');
  assertEqual(REG.wetClassTable[id('cloud')], WET_CLASS.NONE, '前置：云是 NONE 类');
  assertFalse(rainWetGround(fakeWorld(cloudCells), REG, 4.5, 21, 4.5), '站在云上不会踩出水声');

  for (const n of ['glowstone', 'lava', 'turret_alias_block', 'playground_block']) {
    const cells = new Map();
    put(cells, 4, 20, 4, n);
    assertEqual(REG.wetClassTable[id(n)], WET_CLASS.NONE, `前置：${n} 是 NONE 类`);
    assertFalse(rainWetGround(fakeWorld(cells), REG, 4.5, 21, 4.5), `${n} 上不该响踩水声`);
  }
});

test('rain-wet-ground: 判据 = 「材质会湿」∧「头顶无挡雨面」，不是名字白名单', () => {
  // 逐个方块过一遍：站在该方块顶上、头顶露天 ⇒ 结果必须等于 wetClassTable ≠ NONE
  for (const b of BLOCKS) {
    const bid = id(b.name);
    const cells = new Map();
    put(cells, 4, 20, 4, b.name);
    const expect = REG.wetClassTable[bid] !== WET_CLASS.NONE;
    assertEqual(rainWetGround(fakeWorld(cells), REG, 4.5, 21, 4.5), expect,
      `${b.name} 的湿地判定与材质分类表不一致`);
  }
});

test('rain-wet-ground: 空气 / 悬空 / 世界底以下不是湿地', () => {
  assertFalse(rainWetGround(fakeWorld(new Map()), REG, 4.5, 21, 4.5), '空中没有支撑块');
  const cells = new Map();
  put(cells, 4, WORLD_MIN_Y - 2, 4, 'stone');
  assertFalse(rainWetGround(fakeWorld(cells), REG, 4.5, WORLD_MIN_Y + 5, 4.5),
    '下方 7 格内无支撑块 ⇒ 非湿地');
});

test('rain-wet-ground: 脚底恰在方块顶面（y=21.0）时取的是下面那一格', () => {
  const cells = new Map();
  put(cells, 4, 20, 4, 'stone');
  // y 正好等于支撑块顶面（= 21）—— 站立时的常态。不得因为 floor(21)=21 而取到空气格。
  assertTrue(rainWetGround(fakeWorld(cells), REG, 4.5, 21, 4.5), '顶面站立必须命中支撑块');
  // 同一格内抬脚一点点也仍命中
  assertTrue(rainWetGround(fakeWorld(cells), REG, 4.5, 21.42, 4.5), '抬脚 0.42 格仍算站在该块上');
});

test('rain-wet-ground: 会湿的材质覆盖了湿地面着色器的全部非 NONE 类（口径同源）', () => {
  // 两条判据必须读同一张表：湿地面着色器用 wetClassTable，脚步声也用 wetClassTable。
  // 这里钉住「非 NONE 的方块数 = 分类表里声明的方块数」，防止将来新增一个类时只改一边。
  const declared = Object.values(WET_CLASS_DATA).filter((c) => c !== WET_CLASS.NONE).length;
  const inRegistry = BLOCKS.filter((b) => REG.wetClassTable[id(b.name)] !== WET_CLASS.NONE).length;
  assertEqual(inRegistry, declared, 'registry 的 wetClassTable 必须与 wet-material-data 一一对应');
  assertTrue(declared > 100, `非 NONE 类应覆盖绝大多数建材，实际 ${declared}`);
});