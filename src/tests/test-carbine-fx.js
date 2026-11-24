// src/tests/test-carbine-fx.js — KV-9 特效：观感常量关系式 / 命中分类 / 池生命周期（Tier 1）
//
// 上游对照：`bj-shooting-game/night-heron-src/src/fx/particles.js` + `game/weapon.js:fire()`
// 判据是**关系式与上游原值**，不写实测冻结数（本模块是纯逻辑/常量移植）。
import { test } from './runner.js';
import { assertEqual, assertTrue, assertFalse } from './assert.js';
import {
  CARBINE_TRACER_FX as TR, CARBINE_SPARK_FX as SP, CARBINE_PUFF_FX as PU,
  CARBINE_CASING_FX as CA, CARBINE_HOLE_FX as HO, CARBINE_METAL_BLOCKS,
  carbineImpactKind, carbineSparkParams, carbinePuffParams, carbineImpactSound,
  carbineSparkSeeds, carbineTracerLifetime,
} from '../render/carbine-fx-config.js';
import { CARBINE, CARBINE_COOLDOWN } from '../player/weapons/carbine.js';
import { CARBINE_RECIPES, CARBINE_AUDIO_IDS } from '../render/carbine-audio-recipes.js';
import { BLOCKS } from '../voxel/blocks-data.js';
import { WEAPONS, WEAPON_IDS } from '../player/weapons/weapon-catalog.js';
import * as THREE from 'three';
import { CarbineFx } from '../render/carbine-fx.js';
import { SoldierMuzzleFx } from '../render/soldier-muzzle-fx.js';

/** CarbineFx 夹具（真实构造器；groundAt 缺省 null ⇒ 弹壳不落地，仍可计数） */
function makeFx() {
  return new CarbineFx({ scene: new THREE.Scene(), rand: () => 0.5 });
}

function assertClose(a, b, eps = 1e-9, msg = '') {
  if (!(Math.abs(a - b) <= eps)) throw new Error(`${msg ? msg + ': ' : ''}期望 ${b}±${eps}，实际 ${a}`);
}
/** 固定序列 RNG（可复现） */
function lcg(seed = 1) {
  let s = seed;
  return () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
}

// ---------- 常量：与上游对齐 ----------

test('carbine fx: 曳光颜色/速度/宽度派生自玩法侧 CARBINE（红线 1）', () => {
  assertEqual(TR.color, CARBINE.tracerColor);
  assertEqual(TR.speed, CARBINE.tracerSpeed);
  assertEqual(TR.width, CARBINE.tracerWidth);
  assertEqual(TR.maxLength, CARBINE.tracerMaxLength);
  assertEqual(TR.lengthRatio, CARBINE.tracerLengthRatio);
  // 上游原值
  assertEqual(TR.speed, 320);
  assertClose(TR.width, 0.011, 1e-12);
  assertEqual(TR.color[0], 9); assertEqual(TR.color[1], 5.5); assertEqual(TR.color[2], 2.2);
});

test('carbine fx: 曳光 renderOrder = 2（与既有曳光同档，守水面顺序不变式）', () => {
  assertEqual(TR.renderOrder, 2);
  assertTrue(SP.renderOrder > TR.renderOrder, '火花必须排在曳光之后');
  assertTrue(HO.renderOrder < TR.renderOrder, '弹孔贴地，必须排在曳光之前');
});

test('carbine fx: 三种命中的火花参数 = 上游原值', () => {
  assertEqual(SP.entity.count, 7); assertEqual(SP.entity.speed, 5); assertEqual(SP.entity.life, 0.35);
  assertEqual(SP.metal.count, 14); assertEqual(SP.metal.speed, 7); assertEqual(SP.metal.life, 0.5);
  assertEqual(SP.stone.count, 6); assertClose(SP.stone.speed, 4.5, 1e-12); assertEqual(SP.stone.life, 0.3);
  assertEqual(SP.entity.color.join(','), '10,6,2');
  assertEqual(SP.metal.color.join(','), '12,8,3');
  assertEqual(SP.stone.color.join(','), '8,4.5,1.4');
  // 金属分支必须比石头更猛（否则「金属火花更多更亮」这条观感不成立）
  assertTrue(SP.metal.count > SP.stone.count);
  assertTrue(SP.metal.speed > SP.stone.speed);
  assertTrue(SP.metal.life > SP.stone.life);
});

test('carbine fx: 烟尘三档参数 = 上游原值，且墙面比地面活得久', () => {
  assertClose(PU.entity.size, 0.12, 1e-12);
  assertClose(PU.entity.alpha, 0.25, 1e-12);
  assertEqual(PU.entity.life, 0.5);
  assertEqual(PU.floor.life, 0.5);
  assertEqual(PU.wall.life, 0.8);
  assertTrue(PU.wall.life > PU.floor.life, '墙面烟尘应比地面久（上游口径）');
  // 烟尘是遮光的 ⇒ 颜色必须暗（additive 亮色会在亮背景上消失）
  for (const p of [PU.entity, PU.floor, PU.wall]) {
    for (const c of p.color) assertTrue(c < 0.4, `烟尘颜色分量 ${c} 过亮`);
  }
});

// ---------- 池账（关系式，不是冻结数）----------

test('carbine fx: 曳光池容量 ≥ 理论并发（射程 40 + 段长 9 / 速度 320 与射速）', () => {
  const life = carbineTracerLifetime(40);
  const concurrent = Math.ceil(life / CARBINE_COOLDOWN);
  assertTrue(TR.capacity >= concurrent,
    `容量 ${TR.capacity} < 理论并发 ${concurrent}`);
  // 上游原值 40，且留足余量
  assertEqual(TR.capacity, 40);
  assertTrue(TR.capacity >= concurrent * 4, '应留 ≥4 倍余量');
});

test('carbine fx: 火花池容量 ≥ 理论并发（每发 14 颗 × 最长命 / 射速）', () => {
  const maxLife = SP.metal.life * 1.5;   // 上游 life*(0.5+random) 的上界
  const concurrent = Math.ceil(SP.metal.count * maxLife / CARBINE_COOLDOWN);
  assertTrue(SP.capacity >= concurrent, `容量 ${SP.capacity} < 理论并发 ${concurrent}`);
  assertEqual(SP.capacity, 360);
});

test('carbine fx: 弹壳池容量 ≥ 寿命/射速（上游 26 不够，本仓有意抬到 48）', () => {
  const concurrent = Math.ceil(CA.life / CARBINE_COOLDOWN);
  assertTrue(CA.capacity >= concurrent,
    `容量 ${CA.capacity} < 理论并发 ${concurrent} —— 会 FIFO 绕回（弹壳半空消失）`);
  assertTrue(CA.capacity > 26, '必须大于上游 26（本仓无限子弹会一直连射）');
  assertEqual(CA.capacity, 48);
});

test('carbine fx: 弹壳几何/物理参数 = 上游原值', () => {
  assertClose(CA.radius, 0.0062, 1e-12);
  assertClose(CA.length, 0.03, 1e-12);
  assertEqual(CA.segments, 7);
  assertEqual(CA.color, 0xc9a24a);
  assertClose(CA.roughness, 0.28, 1e-12);
  assertEqual(CA.metalness, 1.0);
  assertEqual(CA.life, 3.5);
  assertClose(CA.gravity, 9.8, 1e-12);
  assertClose(CA.bounceY, -0.42, 1e-12);
  assertClose(CA.bounceThreshold, 0.6, 1e-12);
  assertEqual(CA.maxBounceSounds, 3);
});

test('carbine fx: 曳光存活时长 = (L + min(L/2, 9)) / speed', () => {
  // 短距离：段长 = L/2
  assertClose(carbineTracerLifetime(4), (4 + 2) / 320, 1e-12);
  // 长距离：段长钳到 9
  assertClose(carbineTracerLifetime(40), (40 + 9) / 320, 1e-12);
  // 边界 L=18 时两种算法相等
  assertClose(carbineTracerLifetime(18), (18 + 9) / 320, 1e-12);
  assertEqual(carbineTracerLifetime(0), 0);
});

// ---------- 命中分类 ----------

test('carbine fx: 命中分类 —— 实体优先，其次金属，再按法线分地面/墙面', () => {
  assertEqual(carbineImpactKind({ isEntity: true, blockName: 'iron', normal: [0, 1, 0] }), 'entity');
  assertEqual(carbineImpactKind({ blockName: 'iron', normal: [0, 1, 0] }), 'metal');
  assertEqual(carbineImpactKind({ blockName: 'stone', normal: [0, 1, 0] }), 'floor');
  assertEqual(carbineImpactKind({ blockName: 'stone', normal: [-1, 0, 0] }), 'wall');
  assertEqual(carbineImpactKind({ blockName: 'stone', normal: [0, -1, 0] }), 'wall');
  // 法线 y 恰好 0.5 不算地面（上游判据是 > 0.5）
  assertEqual(carbineImpactKind({ blockName: 'stone', normal: [0, 0.5, 0] }), 'wall');
  assertEqual(carbineImpactKind({}), 'wall');
});

test('carbine fx: 金属方块名单里的每个名字都真实存在（防拼错静默走 stone）', () => {
  const names = new Set(BLOCKS.map((b) => b.name));
  for (const n of CARBINE_METAL_BLOCKS) {
    assertTrue(names.has(n), `金属名单里的 ${n} 不在 blocks-data.js —— 会静默走 stone 分支`);
  }
  assertTrue(CARBINE_METAL_BLOCKS.length >= 5, '金属名单不应为空或过短');
});

test('carbine fx: 命中音效 id 都在烘焙配方里（拼错 = 静默无声）', () => {
  for (const kind of ['metal', 'floor', 'wall']) {
    const id = carbineImpactSound(kind);
    assertTrue(typeof id === 'string', `${kind} 应有音效`);
    assertTrue(id in CARBINE_RECIPES, `${id} 不在配方里`);
    assertTrue(CARBINE_AUDIO_IDS.includes(id), `${id} 不在产物清单里`);
  }
  // 实体命中不播 impact（走 hit/kill 音）
  assertEqual(carbineImpactSound('entity'), null);
  // 三种音两两不同
  const ids = ['metal', 'floor', 'wall'].map(carbineImpactSound);
  assertEqual(new Set(ids).size, 3);
});

test('carbine fx: 参数选择器与分类一致', () => {
  assertEqual(carbineSparkParams('entity'), SP.entity);
  assertEqual(carbineSparkParams('metal'), SP.metal);
  assertEqual(carbineSparkParams('floor'), SP.stone);
  assertEqual(carbineSparkParams('wall'), SP.stone);
  assertEqual(carbinePuffParams('entity'), PU.entity);
  assertEqual(carbinePuffParams('floor'), PU.floor);
  assertEqual(carbinePuffParams('wall'), PU.wall);
  assertEqual(carbinePuffParams('metal'), PU.wall);
});

// ---------- 火花种子（纯函数）----------

test('carbine fx: 火花种子数量正确、位置恒等于命中点、寿命在 [0.5,1.5]×life', () => {
  const rand = lcg(7);
  const pos = [3, 4, 5];
  const seeds = carbineSparkSeeds(pos, [0, 1, 0], SP.metal, rand);
  assertEqual(seeds.length, SP.metal.count);
  for (const s of seeds) {
    assertEqual(s.pos.join(','), '3,4,5');
    assertTrue(s.life >= SP.metal.life * 0.5 - 1e-9, `寿命 ${s.life} 低于下界`);
    assertTrue(s.life <= SP.metal.life * 1.5 + 1e-9, `寿命 ${s.life} 高于上界`);
    assertClose(Math.hypot(...s.vel) / SP.metal.speed, Math.hypot(...s.vel) / SP.metal.speed, 1e-9);
    const ratio = Math.hypot(...s.vel) / SP.metal.speed;
    assertTrue(ratio >= 0.35 - 1e-9 && ratio <= 1.25 + 1e-9, `速度比 ${ratio} 越界`);
    assertClose(s.width, SP.width, 1e-12);
  }
});

test('carbine fx: 火花方向以法线为轴（半球，不穿进方块内部）', () => {
  const rand = lcg(11);
  const n = [0, 1, 0];
  const seeds = carbineSparkSeeds([0, 0, 0], n, SP.stone, rand);
  let positive = 0;
  for (const s of seeds) {
    const d = s.vel[0] * n[0] + s.vel[1] * n[1] + s.vel[2] * n[2];
    if (d > 0) positive++;
  }
  // spread 0.9 下允许少量偏到背面，但绝大多数必须朝外
  assertTrue(positive >= seeds.length * 0.6,
    `朝外比例 ${positive}/${seeds.length} 过低 —— 方向分布可能反了`);
});

test('carbine fx: count=0 时返回空数组（不产生 NaN）', () => {
  const seeds = carbineSparkSeeds([0, 0, 0], [0, 1, 0], { ...SP.stone, count: 0 }, lcg());
  assertEqual(seeds.length, 0);
});

test('carbine fx: rand 注入 ⇒ 逐位可复现', () => {
  const a = carbineSparkSeeds([1, 2, 3], [0, 1, 0], SP.metal, lcg(42));
  const b = carbineSparkSeeds([1, 2, 3], [0, 1, 0], SP.metal, lcg(42));
  assertEqual(JSON.stringify(a), JSON.stringify(b));
});

// ---------- 与玩法侧的一致性 ----------

test('carbine fx: 卡宾枪 catalog 无 tracer 字段（不进旧池），有 carbine 标记', () => {
  const w = WEAPONS[WEAPON_IDS.CARBINE];
  assertTrue(w.carbine === true);
  assertFalse('tracer' in w, '不得有 tracer —— 否则同一发画两条曳光');
  assertTrue(w.automatic === true);
});

test('carbine fx: hitstop/trauma 常量 = 上游原值，且击杀 > 未死', () => {
  assertClose(CARBINE.hitstopKill, 0.075, 1e-12);
  assertClose(CARBINE.hitstopHit, 0.022, 1e-12);
  assertClose(CARBINE.hitstopTimeScale, 0.06, 1e-12);
  assertClose(CARBINE.traumaKill, 0.2, 1e-12);
  assertClose(CARBINE.traumaHit, 0.06, 1e-12);
  assertTrue(CARBINE.hitstopKill > CARBINE.hitstopHit);
  assertTrue(CARBINE.traumaKill > CARBINE.traumaHit);
  assertTrue(CARBINE.hitstopTimeScale > 0 && CARBINE.hitstopTimeScale < 1,
    'hitstop 缩放必须在 (0,1) —— 0 会完全冻帧、1 等于没效果');
});
// ==================== 士兵 Epic Task 7：公开薄方法 + clear 可选参数 ====================
//
// ⚠️ **clear() 缺省行为必须逐位不变**：`tests/carbine.spec.mjs:319` 实测钉着
// 「切枪后 sparks===0」。士兵借用本池，故新增 keepWorldFx 分支而不是改缺省。

test('CarbineFx: spawnTracer 公开薄方法真的写进曳光池（读 GPU 属性）', () => {
  const fx = makeFx();
  // ⚠️ **counts.tracers 是 0/1 的可见性标志，不是条数** ⇒ 用它做「增长」断言会恒真。
  // 判据落在真实 GPU 属性：起点/终点/出生秒必须逐位等于传入值。
  fx.spawnTracer([0, 1, 0], [0, 1, 10], { color: [12, 3.5, 1.5], speed: 170, width: 0.013 }, 1000);
  const a = fx.tracerGeo.getAttribute('aA');
  const b = fx.tracerGeo.getAttribute('aB');
  assertEqual(a.getX(0), 0); assertEqual(a.getY(0), 1); assertEqual(a.getZ(0), 0);
  assertEqual(a.getW(0), 1, '出生秒 = nowMs/1000');
  assertEqual(b.getZ(0), 10, '终点须写进 aB');
  assertEqual(b.getW(0), 170, '速度须写进 aB.w');
  assertTrue(fx.tracerMesh.visible, '有曳光时须提交渲染');
});

test('CarbineFx: spawnSparksAt / spawnPuffAt 公开薄方法真的入池', () => {
  const fx = makeFx();
  const seeds = carbineSparkSeeds([0, 1, 0], [0, 1, 0], carbineSparkParams('entity'), () => 0.5);
  fx.spawnSparksAt(seeds, -1e9);
  assertTrue(fx.counts.sparks > 0, '火花须入池');
  fx.spawnPuffAt({ x: 0, y: 1, z: 0, vx: 0, vy: 0.4, vz: 0, size: 0.12, grow: 0.9, life: 0.5, alpha: 0.25, color: [0.12, 0.12, 0.14] });
  assertTrue(fx.counts.puffs > 0, '烟尘须入池');
});

test('CarbineFx: clear() 缺省仍全清（既有用例零回归）', () => {
  const fx = makeFx();
  fx.spawnTracer([0, 1, 0], [0, 1, 10], { color: [12, 3.5, 1.5], speed: 170, width: 0.013 }, 1000);
  fx.spawnSparksAt(carbineSparkSeeds([0, 1, 0], [0, 1, 0], carbineSparkParams('entity'), () => 0.5), -1e9);
  fx.clear();
  assertEqual(fx.counts.sparks, 0, '缺省须清火花（carbine.spec 钉这条）');
  assertEqual(fx.counts.tracers, 0, '缺省须清曳光（可见性归 0）');
  assertEqual(fx.counts.puffs, 0, '缺省须清烟尘');
});

test('CarbineFx: clear({keepWorldFx:true}) 只清弹壳/弹孔，世界特效保留', () => {
  const fx = makeFx();
  fx.spawnTracer([0, 1, 0], [0, 1, 10], { color: [12, 3.5, 1.5], speed: 170, width: 0.013 }, 1000);
  fx.spawnSparksAt(carbineSparkSeeds([0, 1, 0], [0, 1, 0], carbineSparkParams('entity'), () => 0.5), -1e9);
  fx.update(1000, 0.016);
  const tracersBefore = fx.counts.tracers;
  const sparksBefore = fx.counts.sparks;
  fx.clear({ keepWorldFx: true });
  assertEqual(fx.counts.tracers, tracersBefore, '士兵曳光不得被玩家切枪清掉');
  assertEqual(fx.counts.sparks, sparksBefore, '士兵火花同理');
  assertEqual(fx.counts.casings, 0, '弹壳是玩家专属，仍须清');
  assertTrue(fx.tracerMesh.visible, '保留时不得把曳光 mesh 隐藏');
});

test('士兵火光池: fire 后可见，寿命结束后归 0 且隐藏', () => {
  const scene = new THREE.Scene();
  const fx = new SoldierMuzzleFx({ scene });
  assertEqual(fx.activeCount(), 0);
  for (const m of fx.meshes) assertEqual(m.visible, false, '空载须隐藏');
  fx.fire([0, 1.4, 0], 1000);
  assertEqual(fx.activeCount(), 1, 'fire 后须活跃');
  assertTrue(fx.meshes.some((m) => m.visible), '活跃时须提交渲染');
  // 超过寿命（0.045s = 45ms）
  fx.update(1000 + 60);
  assertEqual(fx.activeCount(), 0, '到期须回收');
  for (const m of fx.meshes) assertEqual(m.visible, false, '到期须隐藏');
});

test('士兵火光池: 每个 slot 独立 uniform（多只士兵不同步亮灭）', () => {
  const fx = new SoldierMuzzleFx({ scene: new THREE.Scene() });
  fx.fire([0, 1, 0], 1000);
  fx.fire([2, 1, 0], 1030);
  fx.update(1030);
  assertEqual(fx.activeCount(), 2);
  const powers = fx.meshes.map((_, i) => fx._slots[i].uniforms.uPower.value);
  assertTrue(powers[0] !== powers[1], `两发的亮度须不同（各自时钟），实测 ${powers}`);
});

test('士兵火光池: dispose 摘除全部并释放', () => {
  const scene = new THREE.Scene();
  const fx = new SoldierMuzzleFx({ scene });
  assertTrue(scene.children.length > 0);
  fx.dispose();
  assertEqual(scene.children.length, 0);
});

test('火光材质: 提取后 carbine-view 不再自己定义（只有一份实现）', async () => {
  // ⚠️ 判据落在**源码文本**：读 TSL 内部结构无稳定口径。
  // Node 侧可直接读文件；浏览器侧走 fetch（两侧都能跑）。
  let text;
  if (typeof window === 'undefined') {
    const fs = await import('node:fs');
    text = fs.readFileSync(new URL('../render/carbine-view.js', import.meta.url), 'utf8');
  } else {
    text = await (await fetch(new URL('../render/carbine-view.js', import.meta.url))).text();
  }
  assertTrue(text.includes('createMuzzleFlashMaterial'), 'carbine-view 须 import 共用工厂');
  assertFalse(text.includes('function makeFlashMaterial'), 'carbine-view 不得再自己定义火光材质');
});
