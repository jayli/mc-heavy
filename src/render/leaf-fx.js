// src/render/leaf-fx.js — 森林落叶池（v3.26）
//
// 设计：docs/superpowers/specs/2026-11-20-forest-leaves-and-fireflies-design.md §4.1/§4.3
//
// 骨架照 `render/rain.js`（围绕玩家的粒子场）：5Hz biome 门控 + 30Hz 距离检查 +
// 分批迁移削峰 + `isSolid` 地面截停 + `frustumCulled=false`。
// 池结构照 `render/spike-fx-material.js`（`THREE.Mesh` + `InstancedBufferGeometry`）。
//
// ## 三条载荷性口径
//
//   ① **非目标 biome 零成本**：`visible=false` 且**直接 return** —— 不查体素、不迁移、
//      不推进粒子。判据必须落在「有没有查体素」上，不是只看 visible。
//   ② **`uTime` 在 return 之前累计**：关闭态也推进 ⇒ 回到森林时 `age` 不跳变
//      （停掉它会让全池叶子在同一相位重生，读作「一起闪一下」）。
//   ③ **关闭时不清空缓冲**：重开立刻有内容，不闪断。
//
// ⚠️ **颜色复用装配层已建的 `blockColorResolver`**（`block-color.js` 的 atlas 取色器）：
// 不在渲染层写死 hex（atlas 是产物，换贴图后颜色必须跟着变，红线 1），也不再调一次
// `createAtlasColorResolver`（那会把 2048² 的 atlas 再读一遍像素 = 第二份缓存）。
//
// **主线程专用**（依赖 three）。归属 `render/`。
import * as THREE from 'three';
import { getBiome } from '../gen/noise.js';
import { WORLD_MIN_Y } from '../voxel/constants.js';
import {
  LEAF_FX, leafSeedAt, pickAutumnLeaf, leafLandSeconds,
} from './ambient-fx-config.js';
import { LEAF_ATTR, createLeafGeometry, createLeafMaterial } from './leaf-fx-material.js';
import { waterSurfaceYAt, isWaterLike } from './water-surface.js';

/** 取顶面色的法线（复用 resolver 的签名 `(name, normal) => linearRGB`） */
const TOP_NORMAL = Object.freeze([0, 1, 0]);

/** resolver 缺失时的中性绿兜底（渲染层不崩；装配层仍会跳过装配，两层职责不同） */
const FALLBACK_COLOR = Object.freeze([0.08, 0.22, 0.03]);

/** 复用的 seed→motion 输出（每帧零分配） */
const _motion = { x: 0, y: 0, z: 0, rotX: 0, rotY: 0, rotZ: 0, landed: false, alpha: 1 };

/** 从属性反解的 seed（每帧零分配；只填 `leafMotionAt` / `leafLandSeconds` 读的那几项） */
const _readSeed = { x: 0, y: 0, z: 0, minY: 0, fallSpeed: 1 };

export class LeafFxRenderer {
  /**
   * @param {object} deps
   * @param {THREE.Scene} deps.scene
   * @param {{isSolid:(x:number,y:number,z:number)=>boolean,
   *          getBlockId?:(x:number,y:number,z:number)=>number}} deps.world
   * @param {object} [deps.registry] 方块注册表（v3.30g 水下判据用；缺省 ⇒ 不做水门）   * @param {number} deps.seed 世界 seed（biome 门控唯一权威 `getBiome`）
   * @param {((name:string, normal:number[]) => number[])|null} [deps.colorResolver]
   * @param {{x:number,y:number,z:number}} deps.playerPos 初始中心
   * @param {number} [deps.capacity]
   * @param {() => number} [deps.rand]
   * @param {{value:number}} [deps.skyDim] 体素 `uSkyDim` 实例（日夜联动）
   * @param {{value:number}} [deps.shadowStrength] 体素 `uShadowStrength` 实例
   */
  constructor({
    scene, world, seed, colorResolver = null, playerPos,
    capacity = LEAF_FX.capacity, rand = Math.random, skyDim, shadowStrength, registry = null,
  }) {
    this.scene = scene;
    this.world = world || null;
    this.registry = registry || null;
    this.seed = seed;
    this.capacity = Math.max(1, Math.round(capacity));
    this._rand = rand;
    this._resolver = typeof colorResolver === 'function' ? colorResolver : null;
    this._warnedNoResolver = false;

    this._geometry = createLeafGeometry(this.capacity);
    const made = createLeafMaterial({ skyDim, shadowStrength });
    this._material = made.material;
    this.uniforms = made.uniforms;

    this.mesh = new THREE.Mesh(this._geometry, this._material);
    this.mesh.name = 'ambient:leaf';
    this.mesh.renderOrder = LEAF_FX.renderOrder;
    // 粒子被 shader 摆到几何包围球之外 ⇒ 无条件提交（同 rain / 各特效池）
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    /** 供 `_renderWaterReflection` 的 hidden 展开（倒影 pass 不画粒子：成本主杠杆是 draw call） */
    this.meshes = [this.mesh];
    this.scene.add(this.mesh);

    this._time = 0;
    this._enabled = true;
    this._biome = null;
    /** v3.30g：玩家自己是否在水下（出生带整段在水下 ⇒ 不播不画） */
    this._underwater = false;
    this._refreshAcc = 0;
    this._cursor = 0;
    this._isRefreshing = false;
    /** 已真的播种成功的片数（地面未加载时可能少于容量 ⇒ 按 seedRetryInterval 重试差额） */
    this._seededCount = 0;
    /** 上次播种尝试的时刻（秒）—— 节流用，见 config 的 seedRetryInterval */
    this._seedTryAt = -1e3;
    this._center = { x: playerPos.x, y: playerPos.y, z: playerPos.z };
    this._lastPos = { x: playerPos.x, y: playerPos.y, z: playerPos.z };
    this._target = { x: playerPos.x, y: playerPos.y, z: playerPos.z };

    // 逐实例秋色（构造时抽一次；迁移只改位置不改色）。
    // ⚠️ 这里省下的只是 CPU 侧的 setXYZ 与取色，**不省上传**：aColor 仍每帧全缓冲上传，
    // 原因见 leaf-fx-material.js 的 setUsage 处（WebGPU 后端对 DynamicDrawUsage 无条件上传）。
    this._fillColors();
  }

  /** 逐实例秋色抽签 + 取色（只在构造时跑） */
  _fillColors() {
    const attr = this._geometry.getAttribute(LEAF_ATTR.color);
    if (!this._resolver && !this._warnedNoResolver) {
      this._warnedNoResolver = true;
      console.warn('[leaf-fx] colorResolver 缺失，落叶用中性绿兜底（装配层应跳过装配）');
    }
    for (let i = 0; i < this.capacity; i++) {
      const name = pickAutumnLeaf(this._rand());
      const c = this._resolver ? this._resolver(name, TOP_NORMAL) : FALLBACK_COLOR;
      attr.setXYZ(i, c[0], c[1], c[2]);
    }
    attr.needsUpdate = true;
  }

  /**
   * 开关（面板 + `?ambient=0` 的合成值由装配层算好后喂进来）。
   * ⚠️ 关闭时**不清空缓冲**：重开立刻有内容，不闪断。
   * @param {boolean} on
   * @returns {boolean} 实际生效值
   */
  setEnabled(on) {
    this._enabled = !!on;
    if (!this._enabled) this.mesh.visible = false;
    return this._enabled;
  }

  get visible() { return this.mesh.visible; }

  /**
   * 取色器（只读）—— `_rebuildAmbientFx` 切档重建时要把它原样传回新池。
   * ⚠️ 不得在装配层另存一份（第二份权威）：池自己持有它，重建时从这里取。
   */
  get colorResolver() { return this._resolver; }

  get activeCount() { return this.mesh.visible ? this.capacity : 0; }

  debugState() {
    return {
      enabled: this._enabled,
      biome: this._biome,
      underwater: this._underwater,
      visible: this.mesh.visible,
      count: this.activeCount,
      seeded: this._seededCount,
      refreshCursor: this._cursor,
      isRefreshing: this._isRefreshing,
      time: this._time,
    };
  }

  /**
   * 该列地面顶面 y（从上往下第一个实心格的顶面，同 `rain._resolveRainMinY`）。
   * 扫不到返回 `null` ⇒ 调用方**跳过该片**（不回落到玩家 y 或世界底）。
   *
   * ⚠️ `cloud` 的 solid 是 true，但出生带上限「地面 +13」的扫描窗口到不了 Y=35/55 的云
   * ⇒ 本轮不受影响。抬高出生带前必须重核（见 `LEAF_FX.birthMax` 注释）。
   *
   * ⚠️⚠️ **v3.30g：水面也当地面**（用户「落叶不要在水下出现」）：
   * 水非实心 ⇒ `isSolid` 穿过水一直找到湖底 ⇒ 叶子全程在水下飘。
   * 现在取 `max(实心地面, 水面)` ⇒ 叶子落在水面上（同雨的 `rainStopY` 口径）。
   * 落点仍在水下（例如玩家自己潜在水里，扫到的水面在头顶）⇒ 返回 null，跳过该片。
   */
  _resolveGroundY(x, z, fromY) {
    if (!this.world || typeof this.world.isSolid !== 'function') return null;
    // ⚠️ x/z 必须取整：`WorldData.getBlockId` 用 `blockIndex(x - cx*16, …)`，
    // 小数坐标会算出小数数组下标 ⇒ undefined ⇒ 全读成 air（玩家坐标恒带 .5）。
    const ix = Math.floor(x); const iz = Math.floor(z);
    const startY = Math.floor(fromY);
    // ⚠️⚠️ **下界必须钳在 WORLD_MIN_Y 之上**（本轮浏览器实测）：`WorldData.getBlockId`
    // 对 `y < WORLD_MIN_Y` 返回 **bedrock**（防穿底）⇒ 未加载 column 全 air 时扫描会
    // 一直命中世界底 ⇒ 地面被解成 −32 ⇒ 叶子全出生在地下（零像素而所有计数全对）。
    const endY = Math.max(WORLD_MIN_Y, startY - LEAF_FX.searchDepth);
    let solid = null;
    for (let y = startY; y >= endY; y--) {
      if (this.world.isSolid(ix, y, iz)) { solid = y + 1; break; }
    }
    // 水面（registry 缺失的 fixture 路径 ⇒ 不做水门，行为逐位回到改动前）
    //
    // ⚠️⚠️ **水面扫描要从 fromY 上方几格起，不能拿全局水面常量做下界**
    // （本轮单测 + 浏览器实测两次拓到）：
    //   · 从 fromY 直接往下扫：玩家潜在水里时 fromY 在水面之下 ⇒ 看不到头顶的水面；
    //   · 用 `max(fromY, WATER_SURFACE_Y+1)`：那个常量（−1.5）只对**天然地形**成立，
    //     玩家造的水/山顶水池可在任何高度（实测 y=56）⇒ 下界把扫描窗口拉到水下。
    // ⇒ 从 `fromY + birthMax` 起扫（盖住整个出生带），与实心扫描的 endY 同深度口径。
    const water = this.registry
      ? waterSurfaceYAt(this.world, this.registry, x, z,
        Math.ceil(fromY) + LEAF_FX.birthMax, LEAF_FX.searchDepth + LEAF_FX.birthMax)
      : null;
    const ground = water === null ? solid : (solid === null ? water : Math.max(solid, water));
    if (ground === null) return null;
    // 落点本身就在水面之下 ⇒ 该片无处可落，跳过（不回落）
    if (water !== null && ground < water) return null;
    return ground;
  }

  /**
   * 玩家当前位置是否**在水面以下**（v3.30g，用户「落叶不要在水下出现」）。
   *
   * ⚠️⚠️ **它不是「整池停」的开关，而是「出生带无处可放」的判据**：
   * 落叶的出生带是「**玩家所在那层地面** + [3,13]」（见 `_resetLeaf` 的树冠陷阱注释）。
   * 玩家潜在水里时那层「地面」就是湖底 ⇒ 整个出生带在水下 ⇒ **一片也不该生**。
   * 若改用水面当基准，叶子会出生在潜水玩家头顶 8 格之上（语义错）。
   *
   * ⚠️ 水面之上的叶子**照常画**（用户裁定：只剔除水下个体，不整池停）——
   * 本判据只看玩家位置，不去逐叶判可见性；而出生带钳在水面之上保证了
   * 「y 单调不增 + 落点 ≥ 水面」⇒ **全程不可能入水**（无需逐帧扫描）。
   *
   * @param {{x:number,y:number,z:number}} playerPos
   * @returns {boolean}
   */
  _playerUnderwater(playerPos) {
    if (!this.registry || !this.world || typeof this.world.getBlockId !== 'function') return false;
    /**
     * ⚠️⚠️ **两条缺一不可**（本轮单测 + 浏览器实测各拓到一条）：
     *
     * ① **扫描起点要高于水面**：从 `py+1` 起不够 —— 玩家在水下 4 格时
     *   水面在头顶上方，往下扫永远看不到它（实测 py=−6 / 水面 −1.5 ⇒ null）。
     *   也不能拿全局 `WATER_SURFACE_Y`（−1.5）做下界：它只对**天然地形**成立，
     *   玩家造的水/山顶水池可在任何高度（实测 y=56）。⇒ 从 `py + birthMax` 起。
     *
     * ② **玩家身体那一格必须真的是水**：否则「湖底下的干洞穴」会被误判为水下
     *   （头顶确实有水面，但中间隔着岩层）—— 与 `physics.inWater` 同口径。
     *   取脚底与脚底+1 两格（身体高 1.8，刚贴水面时脚底可能还在地面格里）。
     */
    const ix = Math.floor(playerPos.x); const iz = Math.floor(playerPos.z);
    const fy = Math.floor(playerPos.y);
    const bodyWet = isWaterLike(this.world.getBlockId(ix, fy, iz), this.registry)
      || isWaterLike(this.world.getBlockId(ix, fy + 1, iz), this.registry);
    if (!bodyWet) return false;
    const surf = waterSurfaceYAt(this.world, this.registry, playerPos.x, playerPos.z,
      Math.ceil(playerPos.y) + LEAF_FX.birthMax, LEAF_FX.searchDepth + LEAF_FX.birthMax);
    return surf !== null && playerPos.y < surf;
  }

  /**
   * 每帧：推进时间 → biome 门控 → 分批迁移 → 落地回收。
   * @param {{x:number,y:number,z:number}} playerPos
   * @param {number} dt 秒
   */
  update(playerPos, dt) {
    if (!Number.isFinite(dt) || dt < 0) return;
    if (!playerPos || !Number.isFinite(playerPos.x)
      || !Number.isFinite(playerPos.y) || !Number.isFinite(playerPos.z)) return;

    // ⚠️ uTime 必须在门控 return 之前累计（关闭态也推进 ⇒ 回来时 age 不跳变）
    this._time += dt;
    this.uniforms.uTime.value = this._time;

    // ⚠️⚠️ **biome 每帧算，不加节流窗口**（实施期实测裁定，见 ledger Ruling）：
    // `getBiome` 实测 0.028 µs/次（20 万次 5.6ms）⇒ 每帧成本可忽略；而加 5Hz 窗口会让
    // 「跨 biome 边界后最多 200ms 内特效不切换」——「走回森林那一帧就该有叶子」是观感要求。
    // `biomeInterval` 保留给下面那次「要不要启动迁移」的检查（与 refreshInterval 同档）。
    this._biome = getBiome(Math.floor(playerPos.x), Math.floor(playerPos.z), this.seed);
    const want = this._biome === 'FOREST' && this._enabled;
    if (!want) {
      // 零成本：不查体素、不迁移、不推进粒子
      this.mesh.visible = false;
      return;
    }

    /**
     * ⚠️⚠️ **水下门（v3.30g）**：玩家潜在水里 ⇒ 出生带（那层地面 +[3,13]）整段在水下
     * ⇒ 一片也不生、已播的也不画。回到水面之上立即恢复（不清缓冲，同关闭态口径）。
     * ⚠️ 这不是「整池停掉雨」那种语义：它只在**玩家自己在水下**时成立；
     * 站在岸上看湖时叶子照常飘（落点钳在水面，全程不入水）。
     */
    this._underwater = this._playerUnderwater(playerPos);
    if (this._underwater) {
      this.mesh.visible = false;
      return;
    }

    this._center.x = playerPos.x;
    this._center.y = playerPos.y;
    this._center.z = playerPos.z;

    // ⚠️ 播种重试必须节流：地面长期扫不到（世界边缘 / 流式加载滞后）会永久持续，
    // 每帧全池重扫实测 0.359ms/帧。首帧恒试（_seedTryAt 初值远在过去）。
    if (this._seededCount < this.capacity
      && this._time - this._seedTryAt >= LEAF_FX.seedRetryInterval) {
      this._seedTryAt = this._time;
      this._seedAll();
      if (this._seededCount > 0) {
        this._lastPos.x = playerPos.x;
        this._lastPos.y = playerPos.y;
        this._lastPos.z = playerPos.z;
      }
    }

    this._processRefresh();
    this._recycle();
    this.mesh.visible = true;

    this._refreshAcc += dt;
    if (this._refreshAcc < LEAF_FX.refreshInterval) return;
    this._refreshAcc = 0;
    const ref = this._isRefreshing ? this._target : this._lastPos;
    const dx = playerPos.x - ref.x;
    const dy = playerPos.y - ref.y;
    const dz = playerPos.z - ref.z;
    if (dx * dx + dz * dz > LEAF_FX.refreshDistance * LEAF_FX.refreshDistance
      || Math.abs(dy) > LEAF_FX.refreshVertical) {
      this._startRefresh(playerPos);
    }
  }

  /**
   * 重出一片叶（出生或回收）：采新 seed + 查那一列的真实地面。
   *
   * ⚠️⚠️ **基准地面必须从玩家脚下往下扫，不能从出生带顶部扫**（本轮浏览器实测）：
   * 传送落点常在**树冠下**（实测 y=45 而头顶 y=55 是树冠），从头顶扫会把树冠顶
   * 当成地面（解成 56）⇒ 第二次扫描窗口够不到真地面 ⇒ **整池全部跳过**。
   * 从玩家脚下扫 ⇒ 拿到玩家站的那层地面（同 rain 的语义：雨停在玩家那一层的上方）。
   *
   * 第二次扫描（出生 x/z 处）仍从出生高度往下：山坡/屋顶上那一列的真实地表可能更高，
   * 但**不得高于玩家头顶 + birthMax**（否则又回到树冠陷阱）⇒ 取两者的较小值。
   *
   * @returns {boolean} 是否真的写入（地面扫不到 ⇒ 跳过该片，不回落玩家 y）
   */
  _resetLeaf(i, center) {
    const probe = this._resolveGroundY(center.x, center.z, center.y);
    if (probe === null) return false;
    const s = leafSeedAt(center, probe, this._rand);
    const ground = this._resolveGroundY(s.x, s.z, Math.min(s.y, center.y));
    if (ground === null) return false;
    // 地面变了 ⇒ 重算高度带与 minY（x/z 与动力学保留，避免二次抽签消耗 rand）
    const dy = ground - probe;
    const o = this._geometry.getAttribute(LEAF_ATTR.origin);
    const p = this._geometry.getAttribute(LEAF_ATTR.params);
    const sway = this._geometry.getAttribute(LEAF_ATTR.sway);
    const spin = this._geometry.getAttribute(LEAF_ATTR.spin);
    const size = this._geometry.getAttribute(LEAF_ATTR.size);
    const life = this._geometry.getAttribute(LEAF_ATTR.life);
    o.setXYZ(i, s.x, s.y + dy, s.z);
    p.setXY(i, s.minY + dy, s.fallSpeed);
    sway.setXYZ(i, s.swayAmp, s.swayFreq, s.swayPhase);
    spin.setXYZ(i, s.spinX, s.spinY, s.spinZ);
    size.setX(i, s.size);
    life.setXY(i, this._time, 1);
    this._dirtyStatic = true;
    return true;
  }

  /**
   * 迁移一片：**只改 origin/params（地面），不改 sway/spin/size/color**。
   * 相位与速度保留 ⇒ 迁移中的叶子不会「集体重置成同一相位」（这是本写法的主要理由）。
   * ⚠️ 不改那几项**不减少上传字节**（它们照样每帧全刷，见 material 的 setUsage 处）。
   */
  _moveLeaf(i, center) {
    const o = this._geometry.getAttribute(LEAF_ATTR.origin);
    const p = this._geometry.getAttribute(LEAF_ATTR.params);
    const life = this._geometry.getAttribute(LEAF_ATTR.life);
    // 保留原出生带内的相对高度（叶片当前所处的高度差不因迁移而突变）
    const above = Math.min(LEAF_FX.birthMax,
      Math.max(LEAF_FX.birthMin, o.getY(i) - (p.getX(i) - LEAF_FX.floorOffset)));
    const probe = this._resolveGroundY(center.x, center.z, center.y);
    if (probe === null) return false;
    const ang = this._rand() * Math.PI * 2;
    const r = LEAF_FX.radius * Math.sqrt(this._rand());
    const x = center.x + Math.cos(ang) * r;
    const z = center.z + Math.sin(ang) * r;
    const ground = this._resolveGroundY(x, z, Math.min(probe + above, center.y));
    if (ground === null) return false;
    o.setXYZ(i, x, ground + above, z);
    p.setXY(i, ground + LEAF_FX.floorOffset, p.getY(i));
    life.setXY(i, this._time, 1);
    this._dirtyStatic = true;
    return true;
  }

  /**
   * 首次进入目标 biome：整池播种。
   *
   * ⚠️⚠️ **必须逐片记住成败，不能一个布尔了事**（本轮浏览器实测）：
   * `_teleportTo` 后目标 column 尚未加载 ⇒ `isSolid` 全 false ⇒ 首次播种全部跳过，
   * 而旧写法的 `_seeded=true` 已置位 ⇒ **220 片属性永远全 0**（原点一堆零尺寸 quad，
   * 玩家看到「森林里没有落叶」）。现在每帧重试差额直到全部播种成功。
   */
  _seedAll() {
    this._dirtyStatic = false;
    const life = this._geometry.getAttribute(LEAF_ATTR.life);
    for (let i = 0; i < this.capacity; i++) {
      if (life.getX(i) > -100) continue;   // 已播种过
      if (this._resetLeaf(i, this._center)) this._seededCount++;
    }
    this._flushStatic();
  }

  /** 启动分批迁移（照 rain：目标变化大时从头刷，避免旧目标尾部残留） */
  _startRefresh(playerPos) {
    if (!this._isRefreshing) {
      this._isRefreshing = true;
      this._cursor = 0;
    }
    this._target.x = playerPos.x;
    this._target.y = playerPos.y;
    this._target.z = playerPos.z;
  }

  /** 每帧处理一批（削峰）。批大小恒 >0 且 < 容量（常量表单测钉） */
  _processRefresh() {
    if (!this._isRefreshing) return;
    this._dirtyStatic = false;
    const end = Math.min(this._cursor + LEAF_FX.refreshBatchSize, this.capacity);
    for (let i = this._cursor; i < end; i++) this._moveLeaf(i, this._target);
    this._cursor = end;
    this._flushStatic();
    if (this._cursor >= this.capacity) {
      this._isRefreshing = false;
      this._lastPos.x = this._target.x;
      this._lastPos.y = this._target.y;
      this._lastPos.z = this._target.z;
    }
  }

  /**
   * 逐片推进淡出与回收。
   *
   * ⚠️ **落地后 `aAlpha` 递减**（GPU 侧的 y 已被钳在 minY、摆荡与自转已冻结）；
   * 淡完即重新出生 ⇒ 稳态是「容量片都在飘」，不堆积、不穿地。
   */
  _recycle() {
    const o = this._geometry.getAttribute(LEAF_ATTR.origin);
    const p = this._geometry.getAttribute(LEAF_ATTR.params);
    const life = this._geometry.getAttribute(LEAF_ATTR.life);
    this._dirtyStatic = false;
    let lifeDirty = false;
    for (let i = 0; i < this.capacity; i++) {
      const born = life.getX(i);
      if (born < -100) continue;   // 尚未播种（地面未加载）—— 由 _seedAll 重试
      _readSeed.y = o.getY(i);
      _readSeed.minY = p.getX(i);
      _readSeed.fallSpeed = p.getY(i);
      const tLand = leafLandSeconds(_readSeed);
      const t = this._time - born;
      if (t >= tLand + LEAF_FX.landFadeSeconds) {
        this._resetLeaf(i, this._center);
        lifeDirty = true;
        continue;
      }
      const a = t >= tLand ? Math.max(0, 1 - (t - tLand) / LEAF_FX.landFadeSeconds) : 1;
      if (life.getY(i) !== a) { life.setY(i, a); lifeDirty = true; }
    }
    if (lifeDirty) life.needsUpdate = true;
    this._flushStatic();
  }

  /**
   * 只把真的改过的属性置 needsUpdate（每帧零分配）。
   *
   * ⚠️⚠️ **`needsUpdate` 在 WebGPU 后端不决定「要不要上传」**（实测 v3.26 诊断）：
   * `three.webgpu.js:31003` 的门是 `data.version < version || usage === DynamicDrawUsage`
   * ⇒ 本池所有属性都是 `DynamicDrawUsage`（见 material），于是**每帧无条件全缓冲上传**，
   * 与本函数的 dirty 判据无关。实测每帧 7 次 `writeBuffer` / **14960 B**（清晰档 220 片），
   * 其中连构造后永不变的 `aColor` 也占 2640 B；整帧其他地方的 buffer 上传是 **0 B**。
   *
   * 因此本函数的真实作用是「零分配 + 语义上标明哪些属性被改过」，**不是省上传**。
   * 改成 `StaticDrawUsage` 可让上传降到 2.2 次 / 4320 B（−71%，画面像素并集不退化），
   * 但**实测净收益仅 0.001 ms/帧**（批量微基准 400 次重复；帧时 p50 逐位相同 8.3ms、
   * fps 均 120）⇒ 刻意不改，收益在噪声以下。容量放大到万级时才值得重新评估。
   */
  _flushStatic() {
    if (!this._dirtyStatic) return;
    this._dirtyStatic = false;
    for (const key of ['origin', 'params', 'sway', 'spin', 'size', 'life']) {
      this._geometry.getAttribute(LEAF_ATTR[key]).needsUpdate = true;
    }
  }

  dispose() {
    this.scene.remove(this.mesh);
    this._geometry.dispose();
    this._material.dispose();
    this.meshes.length = 0;
  }
}