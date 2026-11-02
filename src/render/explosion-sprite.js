// src/render/explosion-sprite.js — TNT 爆炸序列帧特效（对齐 mc-lite ParticleSystem 爆炸层）
//
// mc-lite 的 TNT 爆炸是**两层叠加**（`World.js:1296 spawnExplosionParticles`）：
//   ① 2D billboard 序列帧爆炸 —— `ParticleSystem.js:177 spawnExplosionEffect`  ← **本文件**
//   ② 球体扩张（注释原文「作为底层增强」）—— `World.js:1301-1311`  ← `explosion-renderer.js`
// M8 当时只移植了 ②（`explosion-renderer.js` 文件头如实记录了这次裁剪），本文件补齐 ①。
// 两层同时触发、同帧生效，与 mc-lite 一致。
//
// **手法照搬 mc-lite 的 Sprite 池**（不是本仓库 tracer/zombie 的 InstancedMesh 池）：
// 10 个预分配 `THREE.Sprite`，每个持一份 `texture.clone()` + 独立 `SpriteMaterial`，
// 逐帧改 `texture.offset` 切图集帧。选它的三条理由（都在 vendor 源码核实过）：
//   ① **Sprite 自动 billboard**（恒面向相机），不必每帧算相机朝向 —— InstancedMesh 池须自己算；
//   ② **逐 sprite `visible=false` 同样还原 draw call 基线** —— `three.webgpu.js:62263`
//      `projectObject` 首行 `if (object.visible === false) return`，与本仓库 InstancedMesh
//      池的 `visible=false` 手法（M6 活跃约束 ①）同等效果，空闲 slot 不提交渲染；
//   ③ 与 mc-lite 逐行一致 → 视觉零偏离。
//
// ⚠️ **`texture.clone()` 不是图像内存副本**：three 的 clone 共享同一个 `Source`（同一份 GPU
// 上传），只复制参数（offset/repeat/wrap/filter）。故 10 份 clone **不构成红线 1 的
// 「第二份权威数据」** —— 那条约束针对逻辑体素数据，不适用于纯视觉纹理参数。
//
// ⚠️ **序列帧切帧靠 `texture.offset` + `TextureNode` 的 matrix uniform**：
// `three.webgpu.js:13247` `TextureNode.update()` 在 `matrixAutoUpdate === true` 时调
// `texture.updateMatrix()`，把 offset/repeat 折进 `texture.matrix` 经 uniform 传 shader。
// **若这条不成立，序列帧会恒显第 0 帧 —— 爆炸照常播、照常淡出，只是图案不动，肉眼几乎
// 看不出差别。** 故 Tier 4 像素实测（`tests/explosion-sprite.spec.mjs`）必须断言
// 「帧 0 vs 帧 9 区域亮度显著不同」，不能只看「爆炸播了」。
//
// **主线程专用**：运行时构造 Sprite/材质必然依赖 three。分层归属 `render/`（不在
// `tools/check-architecture.mjs` 的 `ISOMORPHIC_DIRS` 里 → 天然不受同构检查，无需白名单；
// 同 `zombie-skin-texture.js` 的理由）。
import * as THREE from 'three';
import { resourceUrl } from '../core/resource-url.js';

/**
 * 序列帧冻结参数（mc-lite `ParticleSystem.js:27-37 / 113-119 / 177-188`）。
 * 图集实测 500×200 RGBA8 → 单帧 100×100（方形，`frameAspect = (2.5×2)/5 = 1.0`，无比例失真）。
 */
export const EXPLOSION_SPRITE = Object.freeze({
  tilesX: 5,        // mc-lite `:32` 布局 5×2
  tilesY: 2,
  totalFrames: 10,
  maxLifeMs: 500,   // mc-lite `:34` 持续 0.5s
  maxActive: 10,    // mc-lite `:28` MAX_EXPLOSION_BILLBOARDS
  scaleBase: 3.0,   // mc-lite `:115` `3.0 + progress × 5.0`
  scaleGrowth: 5.0,
  brightRatio: 0.8, // mc-lite `:118` 前 80% 保持亮，最后 20% 淡出
});

/**
 * progress → 图集帧 offset（mc-lite `_updatePool` `:143-149` 同口径）。
 *
 * ⚠️ **offset.y 须翻转**：图集行序自上而下（第 0 行在图像顶部），而 UV 原点在左下 ——
 * 不翻转会让 row 0 采到图集下半行（上下两行颠倒）。mc-lite `:149` 的
 * `1.0 - ((row + 1) / tilesY)` 就是这个翻转。
 *
 * @param {number} progress 寿命比例 ∈ [0, 1+]
 * @returns {{done: boolean, frame: number, x: number, y: number}}
 *   `done=true` 表示已到期（不产出 offset —— 否则 frame 会越界到 10 → row=2 超出图集 2 行）
 */
export function explosionFrameOffset(progress) {
  if (progress >= 1) return { done: true, frame: EXPLOSION_SPRITE.totalFrames, x: 0, y: 0 };
  const frame = Math.floor(progress * EXPLOSION_SPRITE.totalFrames);
  const col = frame % EXPLOSION_SPRITE.tilesX;
  const row = Math.floor(frame / EXPLOSION_SPRITE.tilesX);
  return {
    done: false,
    frame,
    x: col / EXPLOSION_SPRITE.tilesX,
    y: 1 - (row + 1) / EXPLOSION_SPRITE.tilesY,
  };
}

/** 缩放曲线（mc-lite `:115`）：`baseScaleX × (3.0 + progress × 5.0)` → 3 起 8 终 */
export function explosionFrameScale(progress) {
  return EXPLOSION_SPRITE.scaleBase + progress * EXPLOSION_SPRITE.scaleGrowth;
}

/**
 * 透明度曲线（mc-lite `:118`）：前 80% 全亮，末 20% 线性淡出。
 * ⚠️ 边界是**严格小于** —— `progress === 0.8` 仍全亮（照抄 `<` 而非 `<=`）。
 */
export function explosionFrameOpacity(progress) {
  return progress < EXPLOSION_SPRITE.brightRatio
    ? 1
    : 1 - (progress - EXPLOSION_SPRITE.brightRatio) / (1 - EXPLOSION_SPRITE.brightRatio);
}

/**
 * 加载爆炸序列帧图集。
 * @returns {Promise<THREE.Texture>} 500×200 图集（5×2 = 10 帧）
 */
export async function loadExplosionSpriteTexture() {
  // 部署路径无关（v1.87）：旧写法是根绝对路径 `/assets/effects/big_blow.png`
  // （与 atlas-loader.js / zombie-skin-texture.js 同一踩坑记录：根路径能躲开
  // 「相对文档基址」的坑，但仓库挂子路径部署时会 404）。
  const texture = await new THREE.TextureLoader().loadAsync(resourceUrl('assets/effects/big_blow.png'));
  texture.colorSpace = THREE.SRGBColorSpace;
  // 像素风图集：nearest 采样保持硬边（mc-lite `:67-68` 同口径）；不开 mipmap（同 zombie 头）
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  // ⚠️ **repeat 必须在 `clone()` 之前设置**：clone 复制参数快照，顺序反了则每个 clone 的
  // repeat 丢失 → 采样整幅图集（10 帧叠在一起），观感是「一团糊」而非分帧。
  // 这是照搬 mc-lite 的顺序依赖（`:69` repeat 在 `:72` clone 之前）。
  texture.repeat.set(1 / EXPLOSION_SPRITE.tilesX, 1 / EXPLOSION_SPRITE.tilesY);
  return texture;
}

/**
 * 爆炸序列帧 billboard 池。
 */
export class ExplosionSpriteRenderer {
  /**
   * @param {{scene: THREE.Scene, texture: THREE.Texture|null}} deps
   *   `texture` 为 null（加载失败）时整个特效静默禁用 —— 不阻断启动，同丧尸头部纹理的
   *   退回路径（`game.js:121`）。
   */
  constructor({ scene, texture = null }) {
    this.scene = scene;
    this.texture = texture;
    /**
     * @type {Array<{sprite: THREE.Sprite, active: boolean, startedAt: number}>}
     *   `startedAt` 是 `performance.now()` 基准（禁止 `Date.now()`，见 `update` 注释）。
     *   mc-lite 用 `timer += dt` 累积（`_updatePool:135`），本仓库改存起始时间戳直接算差 ——
     *   与 `explosion-renderer.js` / `tracer-renderer.js` 同口径，避免逐帧累积的浮点漂移。
     */
    this._slots = [];
    // 纹理未就绪 → 不建任何 sprite（spawn 时早退）。
    // ⚠️ **这是对 mc-lite 的唯一一处有意改进**：mc-lite 的 `frameAspect` 在异步加载回调里算
    // （`:56-66`），加载完成前 sprite 尺寸是占位值 1 → 早期爆炸尺寸错。本仓库用「纹理未就绪
    // 就不 spawn」消除该竞态。
    if (!texture) return;
    for (let i = 0; i < EXPLOSION_SPRITE.maxActive; i++) {
      const tex = texture.clone();
      tex.needsUpdate = true;
      const material = new THREE.SpriteMaterial({
        map: tex,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        // AdditiveBlending 增强发光感（mc-lite `:36` 传 true）
        blending: THREE.AdditiveBlending,
      });
      const sprite = new THREE.Sprite(material);
      sprite.name = 'explosion-sprite';  // 受控标识：测试与调试据此定位节点
      sprite.visible = false;            // 空闲 → 不提交渲染（draw call 回基线）
      sprite.frustumCulled = false;      // 特效须无条件提交（同 tracer/zombie 池）
      this.scene.add(sprite);
      this._slots.push({ sprite, active: false, startedAt: 0 });
    }
  }

  /** 特效是否可用（纹理加载成功）—— 测试钩子 */
  get ready() { return this.texture !== null; }

  /**
   * 全部 slot 的 Sprite（只读测试钩子；`turret-renderer.js` 暴露 `meshes` 同手法）。
   * 供 Tier 4 fixture 断言「材质/纹理副本各自独立」「空闲时全部 visible=false」——
   * **不让测试穿透 `_slots` 私有字段**。
   * @returns {THREE.Sprite[]}
   */
  sprites() { return this._slots.map((s) => s.sprite); }

  /** 当前活跃 slot 数（只读测试钩子） */
  activeCount() { return this._slots.filter((s) => s.active).length; }

  /**
   * 清空全部活跃特效（全部 slot 回到 `visible=false`）。
   * 语义是「立即结束场上所有爆炸特效」，不是测试专用 —— Tier 4 fixture 用它保证
   * **每次对照只有一个 sprite**（多个 additive sprite 叠加会让亮度判据失真）。
   */
  reset() {
    for (const slot of this._slots) {
      slot.active = false;
      slot.sprite.visible = false;
    }
  }

  /**
   * 起一次爆炸序列帧特效。池满时**丢弃**（纯视觉，无副作用）。
   * @param {[number,number,number]} position 世界坐标。**调用方须传块中心**（块坐标 + 0.5）——
   *   mc-heavy 模板坐标以块底角为原点，而 mc-lite 的爆炸特效位置是 `x+0.5,y+0.5,z+0.5`
   *   （`PlayerInteraction.js:672`）。`game.js` 的调用点已做换算，此处不重复。
   * @param {number} nowMs `performance.now()` 基准
   * @param {{rotation?: number}} [opts] `rotation` 缺省随机（`Math.random() × π`，mc-lite
   *   `:186` 同口径）；显式传值可让截图可复现（Tier 4 fixture 用）
   */
  spawn(position, nowMs, { rotation = Math.random() * Math.PI } = {}) {
    if (!this.texture) return;
    const slot = this._slots.find((s) => !s.active);
    if (!slot) return;   // 池满：丢弃（mc-lite `:179` 同口径）
    slot.active = true;
    slot.startedAt = nowMs;
    const sprite = slot.sprite;
    sprite.position.set(position[0], position[1], position[2]);
    // 旋转避免多个爆炸观感雷同（mc-lite `:186` 的 `Math.random() × π`）。缺省随机，
    // 调用方可显式指定 —— Tier 4 fixture 传 0 使截图可复现（旋转是关于 sprite 中心的，
    // 中心取样点不受影响 → 固定它不影响判据，只消除不确定性）。
    sprite.material.rotation = rotation;
    sprite.material.opacity = 1;
    const s = explosionFrameScale(0);
    sprite.scale.set(s, s, 1);
    sprite.visible = true;
  }

  /**
   * 每帧推进：逐帧切图集帧 + 扩张 + 淡出。到期 slot 置 `visible=false`（draw call 回基线）。
   * ⚠️ **时间基准 `performance.now()`，禁止 `Date.now()`**（M6 活跃约束：两者相差约 17 亿
   * 毫秒，混用会让 progress 恒 ≥1 → 特效首帧即消失）。
   * @param {number} nowMs `performance.now()` 基准
   */
  update(nowMs) {
    for (const slot of this._slots) {
      if (!slot.active) continue;
      const progress = (nowMs - slot.startedAt) / EXPLOSION_SPRITE.maxLifeMs;
      const frame = explosionFrameOffset(progress);
      if (frame.done) {
        slot.active = false;
        slot.sprite.visible = false;
        continue;
      }
      // 切帧：写 offset 即切图集帧（`TextureNode.update()` 折进 matrix uniform）
      const tex = slot.sprite.material.map;
      tex.offset.x = frame.x;
      tex.offset.y = frame.y;
      // 扩张与淡出（mc-lite `:113-119`）
      const scale = explosionFrameScale(progress);
      slot.sprite.scale.set(scale, scale, 1);
      slot.sprite.material.opacity = explosionFrameOpacity(progress);
    }
  }

  dispose() {
    for (const slot of this._slots) {
      this.scene.remove(slot.sprite);
      slot.sprite.material.dispose();   // Sprite 不自动释放材质
      slot.sprite.material.map?.dispose();
    }
    this._slots.length = 0;
    this.texture?.dispose();
    this.texture = null;
  }
}
