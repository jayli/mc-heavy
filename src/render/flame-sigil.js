// src/render/flame-sigil.js — 焰魔举盾砸击的地面火焰法阵（原版 Flame_Strike_Entity 的视觉层）
//
// 原版是**单个贴地 quad + additive 发光**（`RendererFlame_Strike.java`），不是粒子系统：
//   · 基准顶点 `(±1, 0, ±1)` ⇒ **基准 2×2**，再 `scale(radius)`；`radius=2.0` ⇒ 实际 **4×4 格**
//   · 绕 Y 每 tick 转 1° ⇒ **20°/秒**
//   · `isSee()` 为假（仍在 warmup 延迟期）时**整个 quad 不画** —— 这是「一串递延点亮」的来源
//   · 贴图 `flame_strike_sigil.png`（128×128，金黄符文，alpha 全 255）
//
// ⚠️ **基准几何必须是 `PlaneGeometry(2, 2)`**：写成 `(1,1)` 会让实际尺寸只有一半（2×2），
// 而**所有计数类断言仍全绿**（段数、延迟、寿命都对）—— 只有像素占比能看出。
// `test-flame-sigil.js` 直接钉 `geometry.parameters.width/height`。
//
// ⚠️ **本仓只移植视觉，不移植伤害**：原版 `Flame_Strike_Entity.damage()` 每 5 tick 对范围内
// 生物扣血并叠 `EFFECTBLAZING_BRAND` 燃烧 debuff，本轮按用户裁定③「只扣血」**全部不取** ——
// 四招伤害仍走 `IGNIS.attackDamage`，法阵纯观感。
//
// ⚠️ **段数 4 而非原版 8**（用户 2026-11-15 批准）：原版最远 `4.25×9 = 38.25` 格，远超本仓
// `shieldBash.hitRange = 6.5`；取 4 段到 12.75 格，保住「一路砸过去」的递延推进观感。
// 改 `FLAME_SIGIL.segments` 即可回到原版全距，其余逻辑按它派生。
//
// ⚠️⚠️ **首段距离 = 0（就在焰魔脚底），不是原版的 8.5 格**（用户 2026-11-15 实玩后裁定）：
// 用户原话「起始距离焰魔的身体有点远，如果玩家在跟焰魔对打的时候，这个特效的圆圈就
// 生成在了玩家的身后的地面，看不到了，我希望让第一个圆圈就在焰魔的脚底下的位置」。
// 量化：焰魔站定环是 **4.25~5.0 格**（`IGNIS_AI.standoffRange`，用户裁定「不动如山」），
// 而原版首段 8.5 格 ⇒ 四段全落在玩家**身后**（8.5/12.75/17/21.25）⇒ 对打时一个也看不到。
// 改成 `0 / 4.25 / 8.5 / 12.75` ⇒ 首段在焰魔脚下（玩家正对着它），后退时也依次进入视野。
// ⚠️ 首段与焰魔脚下重叠是**意图**：焰魔自己不吃法阵伤害（本轮纯视觉），
// 且 additive 叠在它脚下的地面上读作「砸出的火焰从它脚下铺开」。
//
// ⚠️ 三条池化硬约束（与 explosion-renderer / tracer-renderer 同口径，M6 实测教训）：
//   · 空闲 slot 必须零 scale，且**零活跃时 `visible=false`** —— 否则恒增 draw call，
//     且常驻透明 mesh 会进透明排序列表，其锚点与体素水/海面的排序锚点交叉，
//     干扰水面绘制顺序不变式（`tests/water-order.spec.mjs` 守）。
//   · 每帧零分配：临时矩阵/向量都是模块级常量。
//   · 时间基准 `performance.now()`，禁止 `Date.now()`（相差约 17 亿毫秒 → 首帧即消失）。
//
// **主线程专用**：构造 InstancedMesh/材质必然依赖 three。归属 `render/`（不在
// `tools/check-architecture.mjs` 的 `ISOMORPHIC_DIRS` 里 → 天然不受同构检查）。
import * as THREE from 'three';
import { resourceUrl } from '../core/resource-url.js';

/**
 * 法阵节奏与容量（全部冻结，渲染层不得改写）。
 *
 * 数值来源见 `docs/superpowers/specs/2026-11-15-ignis-attack-fx-design.md` §3.3：
 * `Ignis_Entity.java:1313-1320` 的 `spawnFlameStrike(..., 60, j2, j2, 2.0f, false)`。
 */
export const FLAME_SIGIL = Object.freeze({
  /** 实例 scale；乘基准边长 2 ⇒ 实际 4×4 格（原版 `radius=2.0f`） */
  radius: 2.0,
  /** 单段存活（原版 duration 60 tick ÷ 20 = 3.0s） */
  lifeMs: 3000,
  /** 段数（原版 8，本仓取 4 —— 见文件头） */
  segments: 4,
  /** 段间距（原版 `4.25D * (l + 2)` 的系数） */
  spacing: 4.25,
  /**
   * 首段距离倍数。**用户 v3.04b 裁定 = 0**（首段就在焰魔脚底），原版是 `l + 2` 的那个 2
   * ⇒ 首段 8.5 格。见文件头「起始距离」段。
   */
  firstOffset: 0,
  /** 每 tick 转 1° × 20 tick/s */
  spinDegPerSec: 20,
  /** 池容量（4 段 × 并发余量） */
  maxActive: 16,
  /**
   * 抬离地面的高度。原版取 0.001，本仓取 0.02 ——
   * 本仓相机 near=0.1 / far≈200，深度精度下 0.001 会与地面共面闪烁（z-fighting）。
   */
  yLift: 0.02,
  /** 末段淡出占寿命的比例（前 75% 满亮） */
  fadeFrom: 0.75,
});

/** 原版一 tick 的毫秒数（20 tick/s）。延迟序列按它换算。 */
const TICK_MS = 50;

const _matrix = new THREE.Matrix4();
const _rot = new THREE.Matrix4();
const _zero = new THREE.Matrix4().makeScale(0, 0, 0);
const _color = new THREE.Color();
/** `sigilOpacityAt` 的复用输出（每帧每 slot 一次，不得每帧新建对象） */
const _env = { opacity: 0, visible: false, done: false };

/**
 * 四段法阵的落点（**不含 y** —— 渲染层不查体素，地面高度由调用方算，
 * 与 `block-hit-fx.js` 同口径）。
 *
 * ⚠️ **yaw 用本仓口径**：正前方 = `(−sin yaw, −cos yaw)`
 * （与 `entities/bosses/dragon-boss-agent.js:127-128` 的移动方向同一份语义）。
 * **不得照抄原版 `cos(yaw+90°)/sin(yaw+90°)`** —— 原版 yaw 定义不同，照抄会整串偏 90°，
 * 而段数/间距/延迟全部仍然正确（静默失效）。
 *
 * @param {number[]} at 焰魔身体位置 `[x,y,z]`（脚底）
 * @param {number} yaw 本仓 yaw（弧度）
 * @param {object} [cfg] 缺省 `FLAME_SIGIL`
 * @returns {Array<{x:number, z:number, delayMs:number}>}
 */
export function sigilSpawnPoints(at, yaw, cfg = FLAME_SIGIL) {
  const fx = -Math.sin(yaw);
  const fz = -Math.cos(yaw);
  const points = [];
  for (let l = 0; l < cfg.segments; l++) {
    const d = cfg.spacing * (l + cfg.firstOffset);
    points.push({ x: at[0] + fx * d, z: at[2] + fz * d, delayMs: sigilDelayMs(l) });
  }
  return points;
}

/**
 * 第 l 段的点亮延迟（ms）。
 *
 * ⚠️ **必须取原版 `(int)` 截断**：原版 `int j2 = (int)(1.5F * l)` ⇒ tick `0,1,3,4`
 * ⇒ ms `0,50,150,200`。写成线性 `l × 75` 会得 `0,75,150,225` —— 差 25~50ms，
 * 观感几乎看不出，但那是**丢了原版语义**（`test-flame-sigil.js` 逐档钉住）。
 *
 * @param {number} segmentIndex 段序号（0 起）
 * @returns {number}
 */
export function sigilDelayMs(segmentIndex) {
  return Math.floor(1.5 * segmentIndex) * TICK_MS;
}

/**
 * 法阵自转角（弧度）。原版每 tick 转 1°，与段延迟无关（从生成那刻就开始转）。
 * @param {number} ageMs 自 spawn 起的毫秒数
 * @param {object} [cfg]
 * @returns {number}
 */
export function sigilRotationRad(ageMs, cfg = FLAME_SIGIL) {
  return (ageMs / 1000) * cfg.spinDegPerSec * Math.PI / 180;
}

/**
 * 单段的可见性与亮度包络。
 *
 * 三段语义（对齐原版 `Flame_Strike_Entity`）：
 *   · `age < delay`：warmup 期，`isSee()` 为假 ⇒ **不画**（但 slot 仍占用，不得回收）
 *   · `delay ≤ age < delay + lifeMs`：可见；前 75% 满亮，末 25% 线性淡出
 *   · `age ≥ delay + lifeMs`：`done` ⇒ 回收 slot
 *
 * ⚠️ **返回值默认是复用对象**（每帧每个 slot 调一次，同 `whiteFlashOpacityAt` 口径）：
 * 渲染器传模块级 `_env`，调用后须立即消费、不得保留引用。
 * 单测不传 `out` 时每次新建（方便逐次比较）。
 *
 * @param {number} ageMs 自 spawn 起的毫秒数
 * @param {number} delayMs 本段延迟
 * @param {object} [cfg]
 * @param {{opacity:number, visible:boolean, done:boolean}} [out] 复用输出对象
 * @returns {{opacity:number, visible:boolean, done:boolean}}
 */
export function sigilOpacityAt(ageMs, delayMs, cfg = FLAME_SIGIL, out = { opacity: 0, visible: false, done: false }) {
  if (ageMs < delayMs) {
    out.opacity = 0; out.visible = false; out.done = false;
    return out;
  }
  const lived = ageMs - delayMs;
  if (lived >= cfg.lifeMs) {
    out.opacity = 0; out.visible = false; out.done = true;
    return out;
  }
  const t = lived / cfg.lifeMs;
  out.opacity = t < cfg.fadeFrom ? 1 : (1 - t) / (1 - cfg.fadeFrom);
  out.visible = true;
  out.done = false;
  return out;
}

/**
 * 加载法阵贴图（mod 既有素材逐字节拷入，非新画美术资源）。
 *
 * ⚠️ 路径必须走 `resourceUrl()` —— 站点根绝对路径在子路径部署时会 404，
 * 而本机 dev server 恒为根路径所以测不出来（`check:arch` 守）。
 *
 * @returns {Promise<THREE.Texture>}
 */
export async function loadFlameSigilTexture() {
  const tex = await new THREE.TextureLoader().loadAsync(
    resourceUrl('assets/ignis/flame_sigil.png'),
  );
  tex.colorSpace = THREE.SRGBColorSpace;
  // 像素风：符文边缘不做插值（与体素 atlas 同口径）
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  return tex;
}

export class FlameSigilRenderer {
  /**
   * @param {{scene: THREE.Scene, texture: THREE.Texture, maxActive?: number}} deps
   *   `texture` 由 Game 加载后注入（加载失败时 Game 侧跳过装配，不阻断启动）。
   */
  constructor({ scene, texture, maxActive = FLAME_SIGIL.maxActive }) {
    this.scene = scene;
    this.maxActive = maxActive;

    // ⚠️ 基准边长 2（原版 quad 顶点 ±1）—— 见文件头，写 1 会让尺寸差一倍
    const geometry = new THREE.PlaneGeometry(2, 2);
    geometry.rotateX(-Math.PI / 2);   // XY 平面 → XZ 平面（贴地，法线朝 +Y）
    const material = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      blending: THREE.AdditiveBlending,   // 原版 getGlowingEffect：发光叠加
      depthWrite: false,                  // 不写深度：不挡地面、段间不互相挡
      side: THREE.DoubleSide,             // 从下方看也不消失
      toneMapped: false,
    });
    this.mesh = new THREE.InstancedMesh(geometry, material, maxActive);
    this.mesh.name = 'ignis:flame-sigil';
    // 实例包围球按零 scale 算会被误剔除；特效须无条件提交（同 tracer / explosion 池）
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;            // ⚠️ 零活跃时不提交渲染
    for (let i = 0; i < maxActive; i++) this.mesh.setMatrixAt(i, _zero);
    this.mesh.instanceMatrix.needsUpdate = true;
    // 逐实例色初始化（建出 instanceColor 属性）—— **逐段亮度**靠它，见 update 的 ⚠️
    this.mesh.setColorAt(0, _color.setRGB(1, 1, 1));
    this.mesh.instanceColor.needsUpdate = true;
    this.scene.add(this.mesh);

    /** @type {Array<{slot:number, x:number, y:number, z:number, delayMs:number, bornAt:number}>} */
    this._active = [];
    this._nextSlot = 0;
    this._geometry = geometry;
    this._material = material;
  }

  /** 活跃段数（测试钩子） */
  get activeCount() { return this._active.length; }

  /**
   * 起一串法阵。池满时覆盖最旧 slot（纯视觉，丢弃无副作用）。
   * @param {Array<{x:number, y:number, z:number, delayMs:number}>} points
   *   **y 已由调用方算好**（地面顶面）；调用方负责跳过找不到地面的段。
   * @param {number} nowMs `performance.now()` 基准
   */
  spawn(points, nowMs) {
    if (!Array.isArray(points) || points.length === 0) return;
    // ⚠️ `nowMs` 非法（undefined/NaN）会让 `age = NaN` ⇒ opacity NaN ⇒ NaN scale 写进
    // `setMatrixAt` 污染**整个池**（同碎块路径的 NaN 守卫口径）。
    if (!Number.isFinite(nowMs)) return;
    for (const p of points) {
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) continue;
      const slot = this._nextSlot;
      this._nextSlot = (this._nextSlot + 1) % this.maxActive;
      const existing = this._active.findIndex((s) => s.slot === slot);
      if (existing !== -1) this._active.splice(existing, 1);
      this._active.push({
        slot, x: p.x, y: p.y, z: p.z,
        delayMs: Number.isFinite(p.delayMs) ? p.delayMs : 0,
        bornAt: nowMs,
      });
      // 延迟期内先摆成零 scale（不可见），update 到点后再摆出来
      this.mesh.setMatrixAt(slot, _zero);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.visible = true;
  }

  /**
   * 每帧推进：延迟到点的段摆出来并自转、末段淡出、寿命结束的回收。
   * @param {number} nowMs `performance.now()` 基准
   */
  update(nowMs) {
    if (this._active.length === 0) {
      if (this.mesh.visible) this.mesh.visible = false;
      return;
    }
    let anyVisible = false;
    let colorDirty = false;
    for (let i = this._active.length - 1; i >= 0; i--) {
      const s = this._active[i];
      const age = nowMs - s.bornAt;
      const env = sigilOpacityAt(age, s.delayMs, FLAME_SIGIL, _env);
      if (env.done) {
        this.mesh.setMatrixAt(s.slot, _zero);
        this._active.splice(i, 1);
        continue;
      }
      if (!env.visible) {
        // warmup 期：占着 slot 但不画（原版 isSee 为假）
        this.mesh.setMatrixAt(s.slot, _zero);
        continue;
      }
      anyVisible = true;
      const scale = FLAME_SIGIL.radius;
      _matrix.makeScale(scale, scale, scale);
      _rot.makeRotationY(sigilRotationRad(age));
      _matrix.multiply(_rot);
      // ⚠️ makeScale/multiply 会清掉位移 ⇒ 必须最后 setPosition
      //（`explosion-renderer.js` 记过这个坑：照抄 makeTranslation 会丢位置）
      _matrix.setPosition(s.x, s.y + FLAME_SIGIL.yLift, s.z);
      this.mesh.setMatrixAt(s.slot, _matrix);
      // ⚠️⚠️ **逐段亮度必须走 instanceColor，不能写共享的 material.opacity**：
      // 4 段延迟只差 0~200ms，材质取「活跃段 opacity 最大值」会让**先淡出的段被后段
      // 拖着一起满亮**，直到最后一段淡完才整体消失 ⇒ `sigilOpacityAt` 的淡出曲线
      // 在画面上基本不生效（纯函数单测全绿，只有逐实例判据能抓）。
      // additive 混合下「颜色 × alpha」等价于调亮度 ⇒ 用它做逐段淡出。
      _color.setRGB(env.opacity, env.opacity, env.opacity);
      this.mesh.setColorAt(s.slot, _color);
      colorDirty = true;
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    if (colorDirty && this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    // 全部仍在 warmup 或已全部结束 ⇒ 不提交渲染（draw call 回到基线）
    this.mesh.visible = anyVisible;
  }

  dispose() {
    this.scene.remove(this.mesh);
    this.mesh.dispose();        // 释放 instanceMatrix / instanceColor 缓冲
    this._geometry.dispose();
    this._material.dispose();   // InstancedMesh.dispose 不释放材质
    this._active.length = 0;
  }
}