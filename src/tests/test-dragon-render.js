// src/tests/test-dragon-render.js — 祭坛飞龙（v2.41）渲染层纯逻辑
//
// 覆盖「单测能测到」的部分：实例池与骨骼层级、visible 门控（draw call 归零）、
// pose 发布（position/yaw/bank）、红闪颜色切换、动画采样（loop 闭合 / blend 生效 / 增量语义）。
//
// ⚠️ **用真实产物**（fetch `dragon.json`）而不是手造 miniAsset：AGENTS.md 已记「fake 必须
// 建模真实对象的副作用，不能只是形状一致」—— 手造 asset 的形状一旦与烘焙产物漂移，
// 这些用例就变成测一个不存在的东西。像素级判据在 `tests/dragon-render.spec.mjs`（Tier 4）。
import * as THREE from 'three';
import { test } from './runner.js';
import { assertEqual, assertFalse, assertTrue, assertNull } from './assert.js';
import { DragonRenderer } from '../render/dragon-renderer.js';
import {
  loadDragonAsset, sampleDragonAnim, sampleDragonPose, slerpQuat, multiplyQuat,
} from '../render/dragon-model.js';
import {
  DRAGON, DRAGON_ANIM, DRAGON_MODEL_CENTER, DRAGON_MAX_ALIVE,
} from '../entities/dragons/dragon-config.js';
import { dragonForward } from '../entities/dragons/dragon-facing.js';

let asset = null;
async function getAsset() {
  if (!asset) asset = await loadDragonAsset();
  return asset;
}

/**
 * 造一个龙实体（v2.43 多实例：id 必须逐条不同，否则渲染池会当成同一条）。
 * @param {object} [over] state 覆盖
 * @param {string} [id]
 */
function makeEntity(over = {}, id = 'dragon:tarn:0:0:0') {
  return {
    id,
    state: {
      position: [10, 30, 20], yaw: 1.2, orbitT: 0, flashedUntil: 0, ...over,
    },
  };
}

// ==================== 四元数工具 ====================

test('龙渲染: slerpQuat 端点还原 + 中点归一化', () => {
  const a = [0, 0, 0, 1];
  const b = [0, Math.SQRT1_2, 0, Math.SQRT1_2];   // 绕 y 转 90°
  for (let i = 0; i < 4; i++) assertTrue(Math.abs(slerpQuat(a, b, 0)[i] - a[i]) < 1e-9, 't=0 应还原 a');
  for (let i = 0; i < 4; i++) assertTrue(Math.abs(slerpQuat(a, b, 1)[i] - b[i]) < 1e-9, 't=1 应还原 b');
  const mid = slerpQuat(a, b, 0.5);
  assertTrue(Math.abs(Math.hypot(...mid) - 1) < 1e-9, '中点须归一化');
  // 中点应是绕 y 转 45°
  assertTrue(Math.abs(mid[1] - Math.sin(Math.PI / 8)) < 1e-6, `mid[1]=${mid[1]}`);
  assertTrue(Math.abs(mid[3] - Math.cos(Math.PI / 8)) < 1e-6, `mid[3]=${mid[3]}`);
});

test('龙渲染: slerpQuat 走短弧（dot<0 时取反一端）', () => {
  const a = [0, 0, 0, 1];
  const b = [0, 0, 0, -1];   // 与 a 表示同一旋转（q ≡ −q）
  const mid = slerpQuat(a, b, 0.5);
  // 走短弧 → 中点仍是单位四元数（恒等旋转），而不是「绕某轴转 180°」
  assertTrue(Math.abs(Math.hypot(...mid) - 1) < 1e-9);
  assertTrue(Math.abs(Math.abs(mid[3]) - 1) < 1e-6, `走长弧会让 mid[3]=${mid[3]}`);
});

test('龙渲染: multiplyQuat 与 three 的 Quaternion.multiply 逐位一致', () => {
  const cases = [
    [[0, 0, 0, 1], [0, Math.SQRT1_2, 0, Math.SQRT1_2]],
    [[Math.SQRT1_2, 0, 0, Math.SQRT1_2], [0, 0, Math.SQRT1_2, Math.SQRT1_2]],
    [[0.1, 0.2, 0.3, 0.9], [-0.4, 0.5, -0.6, 0.7]],
  ];
  const qa = new THREE.Quaternion(), qb = new THREE.Quaternion();
  for (const [a, b] of cases) {
    const mine = multiplyQuat(a, b);
    qa.set(...a).multiply(qb.set(...b));
    const theirs = [qa.x, qa.y, qa.z, qa.w];
    for (let i = 0; i < 4; i++) {
      assertTrue(Math.abs(mine[i] - theirs[i]) < 1e-12,
        `multiplyQuat 与 three 不一致 [${i}]: ${mine[i]} vs ${theirs[i]}`);
    }
  }
});

// ==================== 动画采样 ====================

test('龙渲染: sampleDragonAnim 时刻 0 与一个周期后逐位相同（loop）', async () => {
  const a = (await getAsset()).animations;
  for (const name of ['fly', 'glide']) {
    const dur = a[name].frameCount / a[name].fps;
    const s0 = sampleDragonAnim(a[name], 0);
    const s1 = sampleDragonAnim(a[name], dur);
    assertEqual(s0.size, s1.size);
    for (const [bi, v] of s0) {
      const w = s1.get(bi);
      assertTrue(w !== undefined, `${name} 骨骼 ${bi} 在周期后丢失`);
      for (let i = 0; i < 4; i++) assertTrue(Math.abs(v.rot[i] - w.rot[i]) < 1e-9, `${name} rot[${i}]`);
      for (let i = 0; i < 3; i++) assertTrue(Math.abs(v.pos[i] - w.pos[i]) < 1e-9, `${name} pos[${i}]`);
    }
  }
});

test('龙渲染: sampleDragonAnim 负时刻与正时刻等价（非负取模）', async () => {
  const a = (await getAsset()).animations;
  const dur = a.fly.frameCount / a.fly.fps;
  const sPos = sampleDragonAnim(a.fly, dur - 0.3);
  const sNeg = sampleDragonAnim(a.fly, -0.3);
  assertEqual(sPos.size, sNeg.size);
  for (const [bi, v] of sPos) {
    const w = sNeg.get(bi);
    for (let i = 0; i < 4; i++) assertTrue(Math.abs(v.rot[i] - w.rot[i]) < 1e-9, `负时刻 rot[${i}]`);
    for (let i = 0; i < 3; i++) assertTrue(Math.abs(v.pos[i] - w.pos[i]) < 1e-9, `负时刻 pos[${i}]`);
  }
});

test('龙渲染: sampleDragonAnim 只返回该动画驱动的骨骼', async () => {
  const d = await getAsset();
  const s = sampleDragonAnim(d.animations.fly, 0.5);
  assertEqual(s.size, d.animations.fly.boneIndices.length);
  for (const bi of s.keys()) assertTrue(d.animations.fly.boneIndices.includes(bi));
});

test('龙渲染: sampleDragonAnim 在帧时刻精确等于产物帧（插值端点）', async () => {
  const d = await getAsset();
  const a = d.animations.fly;
  // t = 帧号/fps → frac = 0 → 应精确等于该帧
  for (const f of [0, 5, 17, 35]) {
    const s = sampleDragonAnim(a, f / a.fps);
    for (let slot = 0; slot < a.boneIndices.length; slot++) {
      const bi = a.boneIndices[slot];
      const o = (f * a.boneIndices.length + slot) * 7;
      const got = s.get(bi);
      for (let i = 0; i < 4; i++) {
        assertTrue(Math.abs(got.rot[i] - a.frames[o + i]) < 1e-9,
          `帧${f} 槽${slot} rot[${i}]: ${got.rot[i]} vs ${a.frames[o + i]}`);
      }
      for (let i = 0; i < 3; i++) {
        assertTrue(Math.abs(got.pos[i] - a.frames[o + 4 + i]) < 1e-9, `帧${f} 槽${slot} pos[${i}]`);
      }
    }
  }
});

test('龙渲染: sampleDragonPose 在纯段内等于该动画的采样（blend=0 不多算）', async () => {
  const d = await getAsset();
  const t = 1.0;   // fly 段内（< 4.0）
  const mixed = sampleDragonPose(d.animations, t);
  const pure = sampleDragonAnim(d.animations.fly, t);
  assertEqual(mixed.size, pure.size);
  for (const [bi, v] of mixed) {
    const w = pure.get(bi);
    for (let i = 0; i < 4; i++) assertTrue(Math.abs(v.rot[i] - w.rot[i]) < 1e-12, `纯 fly 段 rot[${i}]`);
  }
});

test('龙渲染: sampleDragonPose 在淡入期混合两个动画（blend 真的生效）', async () => {
  const d = await getAsset();
  const tMid = DRAGON_ANIM.flySeconds + DRAGON_ANIM.blendSeconds / 2;
  const mixed = sampleDragonPose(d.animations, tMid);
  const pureFly = sampleDragonAnim(d.animations.fly, tMid);
  const pureGlide = sampleDragonAnim(d.animations.glide, tMid);
  // 混合结果必须与两个纯值都不同（否则 blend 没生效）
  let diffFromFly = 0, diffFromGlide = 0;
  for (const [bi, v] of mixed) {
    const f = pureFly.get(bi), g = pureGlide.get(bi);
    if (f && Math.abs(v.rot[3] - f.rot[3]) > 1e-9) diffFromFly++;
    if (g && Math.abs(v.rot[3] - g.rot[3]) > 1e-9) diffFromGlide++;
  }
  assertTrue(diffFromFly > 0, `淡入期混合值等于纯 fly（blend 未生效）diffFromFly=${diffFromFly}`);
  assertTrue(diffFromGlide > 0, `淡入期混合值等于纯 glide（blend 未生效）diffFromGlide=${diffFromGlide}`);
  // ⚠️ **区间判据只能用 pos（线性插值），不能用 rot 的分量**：四元数 slerp 是**球面**插值，
  // 单个分量可以越出两端点的分量区间（实测骨骼 62 的 rot[3]：混合 0.99822 而两端是
  // 0.98259 / 0.99770）。对 rot 只判「与两端都不同」（上面已做）。
  let posChecked = 0;
  for (const [bi, v] of mixed) {
    const f = pureFly.get(bi), g = pureGlide.get(bi);
    if (!f || !g) continue;
    for (let i = 0; i < 3; i++) {
      const lo = Math.min(f.pos[i], g.pos[i]) - 1e-12;
      const hi = Math.max(f.pos[i], g.pos[i]) + 1e-12;
      assertTrue(v.pos[i] >= lo && v.pos[i] <= hi,
        `骨骼 ${bi} pos[${i}] 混合值 ${v.pos[i]} 越出 [${lo},${hi}]`);
      if (hi - lo > 1e-9) posChecked++;
    }
  }
  assertTrue(posChecked > 0, 'pos 区间判据未生效（两端值全相同 → 无判别力）');
});

test('龙渲染: sampleDragonPose 覆盖两个动画的骨骼并集', async () => {
  const d = await getAsset();
  const tMid = DRAGON_ANIM.flySeconds + DRAGON_ANIM.blendSeconds / 2;
  const mixed = sampleDragonPose(d.animations, tMid);
  const union = new Set([...d.animations.fly.boneIndices, ...d.animations.glide.boneIndices]);
  assertEqual(mixed.size, union.size);
});

// ==================== 渲染器（v2.43 多实例池）====================

test('龙渲染: 实例池容量 = DRAGON_MAX_ALIVE，几何共享而骨骼/材质逐龙独立', async () => {
  const d = await getAsset();
  const scene = new THREE.Scene();
  const r = new DragonRenderer(scene, d);
  assertEqual(r.capacity, DRAGON_MAX_ALIVE);
  assertEqual(r.instances.length, DRAGON_MAX_ALIVE);
  const geos = new Set(r.instances.map((i) => i.mesh.geometry));
  assertEqual(geos.size, 1, '几何必须共享一份（N 份会白占显存）');
  const mats = new Set(r.instances.map((i) => i.material));
  assertEqual(mats.size, DRAGON_MAX_ALIVE, '材质必须逐龙独立（红闪是材质级 color）');
  const skeletons = new Set(r.instances.map((i) => i.mesh.skeleton));
  assertEqual(skeletons.size, DRAGON_MAX_ALIVE, '骨骼必须逐龙独立（共享会让所有龙摆同一姿势）');
  r.dispose();
});

test('龙渲染: 骨骼层级与几何属性齐全', async () => {
  const d = await getAsset();
  const scene = new THREE.Scene();
  const r = new DragonRenderer(scene, d);
  const inst = r.instances[0];
  assertEqual(inst.mesh.skeleton.bones.length, d.bones.length);
  for (const attr of ['position', 'normal', 'uv', 'skinIndex', 'skinWeight']) {
    assertTrue(inst.mesh.geometry.getAttribute(attr) !== undefined, `缺 ${attr}`);
  }
  assertEqual(inst.mesh.geometry.getAttribute('position').count, d.metrics.vertexCount);
  assertEqual(inst.mesh.geometry.getIndex().count, d.metrics.indexCount);
  // skinWeight 每顶点第一个恒 1、其余 0（刚性绑定）
  const w = inst.mesh.geometry.getAttribute('skinWeight');
  for (let i = 0; i < w.count; i++) {
    assertEqual(w.getX(i), 1);
    assertEqual(w.getY(i), 0);
    assertEqual(w.getZ(i), 0);
    assertEqual(w.getW(i), 0);
  }
  // 骨骼父子关系与产物一致
  for (let i = 0; i < d.bones.length; i++) {
    const p = d.bones[i].parentIndex;
    const actualParent = inst.mesh.skeleton.bones[i].parent;
    if (p === -1) assertTrue(actualParent === inst.mesh || actualParent === null,
      `根骨骼 ${d.bones[i].name} 的 parent 应是 mesh`);
    else assertTrue(actualParent === inst.mesh.skeleton.bones[p],
      `骨骼 ${d.bones[i].name} 的 parent 应是 ${d.bones[p].name}`);
  }
  r.dispose();
});

test('龙渲染: 材质口径（unlit / DoubleSide / alphaTest / 白基色）', async () => {
  const d = await getAsset();
  const scene = new THREE.Scene();
  const r = new DragonRenderer(scene, d);
  for (const inst of r.instances) {
    assertTrue(inst.material.isMeshBasicMaterial, '必须 unlit（MeshBasicMaterial）');
    assertEqual(inst.material.side, THREE.DoubleSide, '翼膜 1px 薄片必须双面');
    assertEqual(inst.material.alphaTest, 0.5, '翼膜镂空走 cutout 语义');
    assertEqual(inst.material.color.getHex(), 0xffffff, '有贴图时基色必须白');
  }
  r.dispose();
});

test('龙渲染: mesh 局部偏移 = −DRAGON_MODEL_CENTER（体心对准 state.position）', async () => {
  const d = await getAsset();
  const scene = new THREE.Scene();
  const r = new DragonRenderer(scene, d);
  for (const inst of r.instances) {
    assertEqual(inst.mesh.position.x, -DRAGON_MODEL_CENTER[0]);
    assertEqual(inst.mesh.position.y, -DRAGON_MODEL_CENTER[1]);
    assertEqual(inst.mesh.position.z, -DRAGON_MODEL_CENTER[2]);
  }
  r.dispose();
});

test('龙渲染: 无实体时全部实例 visible = false（draw call 归零）', async () => {
  const d = await getAsset();
  const scene = new THREE.Scene();
  const r = new DragonRenderer(scene, d);
  for (const inst of r.instances) assertFalse(inst.pivot.visible, '构造后应隐藏（初始无龙）');
  r.sync([makeEntity()], 0);
  assertTrue(r.instances[0].pivot.visible, '有实体应显示');
  for (let i = 1; i < r.instances.length; i++) {
    assertFalse(r.instances[i].pivot.visible, `未用到的实例 ${i} 必须隐藏`);
  }
  r.sync([], 0);
  for (const inst of r.instances) assertFalse(inst.pivot.visible, '实体消失后必须隐藏（M6 口径）');
  r.dispose();
});

test('龙渲染: 两条龙同时可见且各自独立摆放', async () => {
  const d = await getAsset();
  const scene = new THREE.Scene();
  const r = new DragonRenderer(scene, d);
  r.sync([
    makeEntity({ position: [10, 30, 20], yaw: 1.2 }, 'dragon:tarn:0:0:0'),
    makeEntity({ position: [900, 30, 700], yaw: -0.4 }, 'dragon:tarn:2:1:0'),
  ], 0);
  assertTrue(r.instances[0].pivot.visible && r.instances[1].pivot.visible, '两条龙都须可见');
  assertEqual(r.instances[0].pivot.position.x, 10);
  assertEqual(r.instances[1].pivot.position.x, 900);
  assertTrue(Math.abs(r.instances[0].pivot.rotation.y - 1.2) < 1e-9);
  assertTrue(Math.abs(r.instances[1].pivot.rotation.y + 0.4) < 1e-9, '两条龙的 yaw 必须各自独立');
  r.dispose();
});

test('龙渲染: 红闪只作用于被打中的那条龙（材质逐龙独立的判据）', async () => {
  const d = await getAsset();
  const scene = new THREE.Scene();
  const r = new DragonRenderer(scene, d);
  // ⚠️ 这条是「共享材质」缺陷的判据：共享时打中一条会让**所有**龙变红
  r.sync([
    makeEntity({ flashedUntil: 1000 }, 'a'),
    makeEntity({ flashedUntil: 0 }, 'b'),
  ], 500);
  assertEqual(r.instances[0].material.color.getHex(), 0xff0000, '被打中的龙须变红');
  assertEqual(r.instances[1].material.color.getHex(), 0xffffff, '未被打中的龙必须保持白色');
  r.dispose();
});

test('龙渲染: pose 发布（position 来自 state，yaw 在 pivot 上）', async () => {
  const d = await getAsset();
  const scene = new THREE.Scene();
  const r = new DragonRenderer(scene, d);
  r.sync([makeEntity({ position: [10, 30, 20], yaw: 1.2 })], 0);
  const pivot = r.instances[0].pivot;
  assertEqual(pivot.position.x, 10);
  assertEqual(pivot.position.y, 30);
  assertEqual(pivot.position.z, 20);
  // ⚠️ **必须用容差**：`rotateZ` 之后 three 从 quaternion 反解欧拉 XYZ，
  // `rotation.y` 会有 1e-16 级漂移（实测 1.1999999999999997）。用 assertEqual 是贴线断言。
  assertTrue(Math.abs(pivot.rotation.y - 1.2) < 1e-9, `yaw=${pivot.rotation.y}`);
  r.dispose();
});

test('龙渲染: bank roll 叠加在 yaw 之后（不得混进 yaw）', async () => {
  const d = await getAsset();
  const scene = new THREE.Scene();
  const r = new DragonRenderer(scene, d);
  r.sync([makeEntity({ yaw: 1.2 })], 0);
  const pivot = r.instances[0].pivot;
  // ⚠️ yaw 必须保持（roll 混进 yaw 会让龙飞歪）。用容差 —— 同上条的欧拉反解漂移。
  assertTrue(Math.abs(pivot.rotation.y - 1.2) < 1e-9, `yaw=${pivot.rotation.y}`);
  // roll 体现在 rotation.z（欧拉 XYZ 序下 rotateZ 叠加到 z 分量）
  assertTrue(Math.abs(pivot.rotation.z) > 1e-6, `roll 未生效（z=${pivot.rotation.z}）`);
  assertTrue(Math.abs(Math.abs(pivot.rotation.z) - DRAGON.bankRoll) < 1e-6,
    `roll=${pivot.rotation.z} 期望 ±${DRAGON.bankRoll}`);
  // 前向仍与 yaw 一致（roll 不改水平朝向）：用基向量判，不读欧拉分量
  // （AGENTS.md：Euler 分解在特定角度有多解/折叠，判朝向要用基向量）
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(pivot.quaternion);
  const expectFwd = new THREE.Vector3(Math.sin(-1.2), 0, -Math.cos(1.2));
  // roll 会让 fwd 有微小 y 分量，但水平投影方向必须一致
  const horiz = new THREE.Vector3(fwd.x, 0, fwd.z).normalize();
  const dot = horiz.dot(expectFwd.normalize());
  assertTrue(dot > 0.999, `roll 改变了水平朝向（dot=${dot}）`);
  r.dispose();
});

test('龙渲染: 俯仰发布在 pivot 上（v2.48 俯冲喷火）', async () => {
  const d = await getAsset();
  const scene = new THREE.Scene();
  const r = new DragonRenderer(scene, d);
  const PITCH = -0.6;   // 低头 34°
  r.sync([makeEntity({ yaw: 0, pitch: PITCH })], 0);
  const pivot = r.instances[0].pivot;
  // ⚠️ **本条用基向量判，不读 rotation.x**：`rotateZ(bankRoll)` 之后 three 从 quaternion 反解
  // 'YXZ' 欧拉，分量会有 1e-16 级漂移。
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(pivot.quaternion);
  // yaw=0 时平飞前向 = (0,0,−1)；低头 pitch 后竖直分量应为 sin(pitch)
  assertTrue(Math.abs(fwd.y - Math.sin(PITCH)) < 1e-6,
    `低头 ${PITCH} rad 时前向 y=${fwd.y}，期望 ${Math.sin(PITCH)}（俯仰未生效或符号反了）`);
  assertTrue(fwd.z < -0.5, `仍应主要朝向 −Z，实际 z=${fwd.z}`);
  // 与 dragon-facing 的唯一权威交叉比对（防两套旋转公式漂移）
  const want = dragonForward(0, PITCH);
  const flat = new THREE.Vector3(want[0], want[1], want[2]);
  assertTrue(fwd.dot(flat.normalize()) > 0.9999,
    `渲染前向与 dragonForward 不一致（dot=${fwd.dot(flat.normalize())}）—— 两套旋转公式漂移了`);
  r.dispose();
});

test('龙渲染: 缺省 pitch（state 里没有该字段）时与旧行为逐位一致', async () => {
  const d = await getAsset();
  const scene = new THREE.Scene();
  const r = new DragonRenderer(scene, d);
  // ⚠️ 零回归门：v2.46 的 state 没有 pitch 字段，verify 它仍按平飞渲染
  r.sync([makeEntity({ yaw: 1.2 })], 0);   // makeEntity 不写 pitch
  const pivot = r.instances[0].pivot;
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(pivot.quaternion);
  assertTrue(Math.abs(fwd.y) < 1e-6, `缺 pitch 时必须平飞（fwd.y=${fwd.y}）`);
  r.dispose();
});

test('龙渲染: 红闪期内材质偏红，到期复位白', async () => {
  const d = await getAsset();
  const scene = new THREE.Scene();
  const r = new DragonRenderer(scene, d);
  const e = makeEntity({ flashedUntil: 1000 });
  r.sync([e], 500);   // nowMs < flashedUntil → 红
  assertEqual(r.instances[0].material.color.getHex(), 0xff0000);
  assertTrue(r.instances[0].material.color.r > r.instances[0].material.color.g, '红闪期应偏红');
  r.sync([e], 1000);  // 恰好到期（严格小于才闪）→ 白
  assertEqual(r.instances[0].material.color.getHex(), 0xffffff);
  r.sync([e], 1500);
  assertEqual(r.instances[0].material.color.getHex(), 0xffffff);
  // 再次进入红闪（连续受伤）
  r.sync([makeEntity({ flashedUntil: 3000 })], 2500);
  assertEqual(r.instances[0].material.color.getHex(), 0xff0000);
  r.dispose();
});

test('龙渲染: 骨骼变换从 bind 快照起算（不逐帧累积）', async () => {
  const d = await getAsset();
  const scene = new THREE.Scene();
  const r = new DragonRenderer(scene, d);
  // 同一 orbitT 连续 sync 多次，骨骼变换必须逐位相同（累积的形态是每次都不一样）
  const e = makeEntity({ orbitT: 2.5 });
  r.sync([e], 0);
  const bones = r.instances[0].mesh.skeleton.bones;
  const first = bones.map((b) => [
    b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w,
    b.position.x, b.position.y, b.position.z,
  ]);
  for (let i = 0; i < 5; i++) r.sync([e], i * 16);
  const later = bones.map((b) => [
    b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w,
    b.position.x, b.position.y, b.position.z,
  ]);
  for (let i = 0; i < first.length; i++) {
    for (let c = 0; c < 7; c++) {
      assertTrue(Math.abs(first[i][c] - later[i][c]) < 1e-12,
        `骨骼 ${d.bones[i].name} 分量${c} 累积漂移：${first[i][c]} → ${later[i][c]}`);
    }
  }
  r.dispose();
});

test('龙渲染: 不同 orbitT 给出不同骨骼姿态（动画真的在驱动）', async () => {
  const d = await getAsset();
  const scene = new THREE.Scene();
  const r = new DragonRenderer(scene, d);
  r.sync([makeEntity({ orbitT: 0 })], 0);
  const a = r.instances[0].mesh.skeleton.bones.map((b) => b.quaternion.w);
  r.sync([makeEntity({ orbitT: 0.6 })], 0);
  const b = r.instances[0].mesh.skeleton.bones.map((x) => x.quaternion.w);
  let changed = 0;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 1e-9) changed++;
  assertTrue(changed > 10, `只有 ${changed} 根骨骼的姿态变了（动画未驱动）`);
  r.dispose();
});

test('龙渲染: 两条龙的动画姿态各自独立（不共享骨骼的判据）', async () => {
  const d = await getAsset();
  const scene = new THREE.Scene();
  const r = new DragonRenderer(scene, d);
  // ⚠️ 这条是「共享骨骼」缺陷的判据：共享时第二条龙会摆出第一条的姿势
  r.sync([
    makeEntity({ orbitT: 0 }, 'a'),
    makeEntity({ orbitT: 0.6 }, 'b'),
  ], 0);
  const qa = r.instances[0].mesh.skeleton.bones.map((b) => b.quaternion.w);
  const qb = r.instances[1].mesh.skeleton.bones.map((b) => b.quaternion.w);
  let diff = 0;
  for (let i = 0; i < qa.length; i++) if (Math.abs(qa[i] - qb[i]) > 1e-9) diff++;
  assertTrue(diff > 10, `只有 ${diff} 根骨骼不同（疑似共享骨骼 → 两条龙同步扇翅）`);
  r.dispose();
});

test('龙渲染: 骨骼四元数模长恒 1（bind 快照起算的不变式）', async () => {
  const d = await getAsset();
  const scene = new THREE.Scene();
  const r = new DragonRenderer(scene, d);
  r.sync([makeEntity({ orbitT: 3.3 })], 0);
  for (let i = 0; i < d.bones.length; i++) {
    const q = r.instances[0].mesh.skeleton.bones[i].quaternion;
    const n = Math.hypot(q.x, q.y, q.z, q.w);
    assertTrue(Math.abs(n - 1) < 1e-6, `骨骼 ${d.bones[i].name} 四元数模长 ${n}`);
  }
  r.dispose();
});

test('龙渲染: dispose 后全部实例从 scene 摘除且几何/材质已释放', async () => {
  const d = await getAsset();
  const scene = new THREE.Scene();
  const r = new DragonRenderer(scene, d);
  const pivots = r.instances.map((i) => i.pivot);
  for (const p of pivots) assertTrue(scene.children.includes(p), '构造后应挂进 scene');
  let geoDisposed = false;
  let matDisposed = 0;
  const geo = r.instances[0].mesh.geometry;
  const origGeo = geo.dispose.bind(geo);
  geo.dispose = () => { geoDisposed = true; origGeo(); };
  for (const inst of r.instances) {
    const orig = inst.material.dispose.bind(inst.material);
    inst.material.dispose = () => { matDisposed++; orig(); };
  }
  r.dispose();
  for (const p of pivots) assertFalse(scene.children.includes(p), 'dispose 后应从 scene 摘除');
  assertTrue(geoDisposed, 'geometry 未 dispose');
  assertEqual(matDisposed, DRAGON_MAX_ALIVE, '每个实例的材质都必须 dispose');
});

test('龙渲染: 未传贴图时 loadTexture 走 resourceUrl（不写站点根绝对路径）', async () => {
  const d = await getAsset();
  const scene = new THREE.Scene();
  const r = new DragonRenderer(scene, d);
  for (const inst of r.instances) assertNull(inst.material.map, '构造时未传贴图 → map 应为空');
  // ⚠️ 不真的加载（会发网络请求）；只验证方法存在且构造不抛。
  // 真实加载与像素判据在 tests/dragon-render.spec.mjs（Tier 4）。
  assertTrue(typeof r.loadTexture === 'function');
  r.dispose();
});

// ==================== 击退视觉补间（v2.81，用户缺陷：后退是瞬移）====================
//
// 权威 `state.position` 瞬时（`DragonService.knockback`），只滞后**渲染位置** ~0.2s ease-out。
// 触发是显式事件（`noteKnockback` ← 服务层注入钩子上报的实际位移），不是「比位移猜」——
// 飞龙 chaseSpeed 9 格/秒（60fps 下 0.15 格/帧）与 0.9 格击退同一量级，阈值必然误伤。

const KB_FRAME_MS = 1000 / 60;

test('龙渲染: 击退 → 渲染位置从旧位置缓动追平（不是瞬移）', async () => {
  const d = await getAsset();
  const r = new DragonRenderer(new THREE.Scene(), d);
  const e = makeEntity({ position: [10, 30, 20] });
  let ms = 0;
  for (let i = 0; i < 3; i++) { ms += KB_FRAME_MS; r.sync([e], ms); }
  // 权威位置瞬时后移 0.9 格，随后通知渲染层
  const moved = makeEntity({ position: [10.9, 30, 20] });
  r.noteKnockback(e.id, 0.9, 0);
  ms += KB_FRAME_MS;
  r.sync([moved], ms);
  const first = r.instances[0].pivot.position.x;
  assertTrue(first > 10 && first < 10.35,
    `击退首帧渲染 x=${first.toFixed(4)}，应只走了不到 35% 的距离（瞬移 = 10.9）`);
  // 逐帧单调追平且不越过权威位置
  let prev = r.knockOffsetXOf(0);
  for (let i = 0; i < 60; i++) {
    ms += KB_FRAME_MS;
    r.sync([moved], ms);
    const cur = r.knockOffsetXOf(0);
    assertTrue(cur <= prev + 1e-12, `偏移应单调减小（ease-out），${prev} → ${cur}`);
    assertTrue(r.instances[0].pivot.position.x <= 10.9 + 1e-9, '渲染位置不得越过权威位置');
    prev = cur;
  }
  assertEqual(r.knockOffsetXOf(0), 0, '约 1 秒后偏移应归零');
  assertTrue(Math.abs(r.instances[0].pivot.position.x - 10.9) < 1e-9,
    '收敛后渲染 x 应逐位等于物理 x');
  assertTrue(moved.state.position[0] === 10.9, '权威位置不得被渲染层回写');
  r.dispose();
});

test('龙渲染: 实例复用给新龙时重置击退补间', async () => {
  const d = await getAsset();
  const r = new DragonRenderer(new THREE.Scene(), d);
  const a = makeEntity({ position: [10, 30, 20] }, 'dragon:tarn:0:0:0');
  let ms = 0;
  for (let i = 0; i < 3; i++) { ms += KB_FRAME_MS; r.sync([a], ms); }
  r.noteKnockback(a.id, 0.9, 0);
  ms += KB_FRAME_MS; r.sync([a], ms);
  assertTrue(r.knockOffsetXOf(0) > 0, '前置：应还有未补完的偏移');
  ms += KB_FRAME_MS; r.sync([], ms);                       // 龙消失 → 实例隐藏但状态残留
  const b = makeEntity({ position: [40, 30, 20] }, 'dragon:tarn:1:0:0');
  ms += KB_FRAME_MS; r.sync([b], ms);
  assertEqual(r.knockOffsetXOf(0), 0, '新龙不得继承上一条的击退偏移');
  assertTrue(Math.abs(r.instances[0].pivot.position.x - 40) < 1e-9, '新龙出生当帧渲染位置应等于物理位置');
  r.dispose();
});
