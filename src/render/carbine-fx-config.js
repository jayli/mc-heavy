// src/render/carbine-fx-config.js — KV-9 命中/曳光/弹壳/烟尘的观感常量（**three-free**）
//
// 上游：`~/jaylli/bj-shooting-game/night-heron-src/src/fx/particles.js`
// （Sparks / Puffs / Tracers / Holes / Casings 五个池）+ `game/weapon.js` 的 `fire()` 调用参数。
// **数值逐项取自上游**，用户要求「曳光和击中效果也保持一致」。
//
// ## 为什么单独成模块（与 spike-fx-config / cinder-fall-config 同手法）
//   ① Tier 1 单测能直接 import 断言常量关系与纯函数，不必经过 three 的 GPU 初始化；
//   ② 池容量账（并发峰值推导）必须能被关系式钉住，而不是写在渲染器里的魔数。
//
// ## 与上游的两处必要改写
//   ① **不做动态点光源**（上游 `G.lights.flash(...)`）：本仓全场景 unlit，
//      动态灯只影响 PBR 材质（枪），加灯会让枪体随每次命中闪烁而世界不变 —— 观感是错的。
//      枪口/命中的「照亮感」由 additive 粒子本身承担（上游那也是主要来源）。
//   ② **弹孔不做 polygonOffset**：WebGPU 后端不支持该字段（three 的 NodeMaterial 无此项），
//      改用沿法线抬升 0.012 格（上游顶点里本来就有这一项）+ depthWrite:false。
//
// ⚠️ 本文件不 import three（Node 门禁与单测直接读）。
import { CARBINE } from '../player/weapons/carbine.js';

/** 曳光池（上游 `Tracers(scene, max=40)`） */
export const CARBINE_TRACER_FX = Object.freeze({
  /**
   * 池容量。**推导**：690 rpm ⇒ 每 0.087s 一发；单条曳光最长存活
   * = (射程 + 段长) / 速度 = (40 + 9) / 320 ≈ 0.153s ⇒ 理论并发 ≤ 2 条。
   * 取 **40**（上游原值）= 20 倍余量，装得下将来抬射速或加连发武器。
   */
  capacity: 40,
  /** 颜色/速度/宽度/段长的唯一权威在玩法侧 CARBINE（红线 1，不另写一份） */
  color: CARBINE.tracerColor,
  speed: CARBINE.tracerSpeed,
  width: CARBINE.tracerWidth,
  maxLength: CARBINE.tracerMaxLength,
  lengthRatio: CARBINE.tracerLengthRatio,
  /**
   * transparent 队列序号。**与既有曳光同档 2**（体素水 0 < 海面 1 < 曳光 2 < 特效 3）。
   * ⚠️ 改它会破坏 `water-order.spec` / `tracer-water-occlusion.spec` 的绘制顺序不变式。
   */
  renderOrder: 2,
});

/** 火花池（上游 `Sparks(scene, max=360)`） */
export const CARBINE_SPARK_FX = Object.freeze({
  /**
   * 池容量。推导：每发最多 14 颗（金属命中），单颗最长命 0.5×1.5 = 0.75s
   * ⇒ 690rpm 下并发 ≤ 14 × 0.75 / 0.087 ≈ 121 颗。取 **360**（上游原值）= 3 倍余量。
   */
  capacity: 360,
  /** 尾迹长度系数（上游 `tail = p - vel*0.028`） */
  tailSeconds: 0.028,
  /** 最小半宽随距离的增长（上游 `max(w, dist*0.0012)`） */
  widthPerDistance: 0.0012,
  /** 默认重力（上游 `g2 = 9.8`） */
  gravity: 9.8,
  /** 落地反弹（上游 `vy *= -0.42; vx *= 0.6`） */
  bounceY: -0.42,
  bounceXZ: 0.6,
  renderOrder: 3,

  // ---- 三种命中面的爆发参数（上游 fire() 的三个分支）----
  /** 命中实体（丧尸/Boss）：上游 `n:7, speed:5, color:[10,6,2], life:0.35` */
  entity: Object.freeze({ count: 7, speed: 5, color: Object.freeze([10, 6, 2]), life: 0.35 }),
  /** 命中金属方块：上游 `n:14, speed:7, color:[12,8,3], life:0.5` */
  metal: Object.freeze({ count: 14, speed: 7, color: Object.freeze([12, 8, 3]), life: 0.5 }),
  /** 命中石/土等：上游 `n:6, speed:4.5, color:[8,4.5,1.4], life:0.3` */
  stone: Object.freeze({ count: 6, speed: 4.5, color: Object.freeze([8, 4.5, 1.4]), life: 0.3 }),
  /** 方向散布（上游 `spread ?? 0.9`） */
  spread: 0.9,
  /** 默认半宽（上游 `width ?? 0.007`） */
  width: 0.007,
});

/** 烟尘池（上游 `Puffs(scene, lights, max=140)`，本仓不接动态灯） */
export const CARBINE_PUFF_FX = Object.freeze({
  /**
   * 池容量。推导：每发 1 团，最长命 0.8s ⇒ 并发 ≤ 0.8/0.087 ≈ 10 团。
   * 取 **140**（上游原值）—— 它同时服务蒸汽发射器，本仓只用命中那一支，余量充足。
   */
  capacity: 140,
  /** 旋转速度（上游 `a = seed*5 + uTime*0.12`） */
  spin: 0.12,
  /** 噪声采样尺度（上游 `vC.xy*0.23` 与 `*0.6`） */
  noiseScaleA: 0.23,
  noiseScaleB: 0.6,
  /** 近处淡出（上游 `smoothstep(0.7, 2.8, -mv.z)`：贴脸时不糊屏） */
  nearFadeFrom: 0.7,
  nearFadeTo: 2.8,
  renderOrder: 3,

  /** 命中实体：上游 `size:0.12, grow:0.9, life:0.5, alpha:0.25, color:[0.12,0.12,0.14]` */
  entity: Object.freeze({
    size: 0.12, grow: 0.9, life: 0.5, alpha: 0.25,
    color: Object.freeze([0.12, 0.12, 0.14]),
  }),
  /** 命中地面（法线朝上）：上游 `life:0.5, color:[0.2,0.24,0.3]` */
  floor: Object.freeze({
    size: 0.1, grow: 0.9, life: 0.5, alpha: 0.2,
    color: Object.freeze([0.2, 0.24, 0.3]),
  }),
  /** 命中墙面：上游 `life:0.8, color:[0.16,0.16,0.17]` */
  wall: Object.freeze({
    size: 0.1, grow: 0.9, life: 0.8, alpha: 0.2,
    color: Object.freeze([0.16, 0.16, 0.17]),
  }),
  /** 阻力（上游 `drag ?? 0.8`） */
  drag: 0.8,
});

/** 弹壳池（上游 `Casings(scene, col, lights, max=26)`） */
export const CARBINE_CASING_FX = Object.freeze({
  /**
   * 池容量。推导：寿命 3.5s、690rpm ⇒ 并发 ≈ 3.5/0.087 ≈ 40 发 > 26。
   * ⚠️ **上游原值 26 在满速连射下会 FIFO 绕回**（最早的弹壳半空消失）。
   * 本仓取 **48**（> 40，留 20% 余量）—— 这是**有意偏离**，理由是可推导的池账，
   * 不是观感调整。上游 26 够用是因为它 reserve=150 且玩家不会一直按住。
   */
  capacity: 48,
  /** 寿命（秒，上游 `p.life = 3.5`） */
  life: 3.5,
  /** 重力（上游 `vel.y -= 9.8*dt`） */
  gravity: 9.8,
  /** 半径 / 长度（上游 `CylinderGeometry(0.0062, 0.0062, 0.03, 7)`） */
  radius: 0.0062,
  length: 0.03,
  segments: 7,
  /** 黄铜色 + 粗糙度 + 金属度（上游 `{c:0xc9a24a, r:0.28, m:1.0}`） */
  color: 0xc9a24a,
  roughness: 0.28,
  metalness: 1.0,
  /** 落地判定抬升（上游 `groundAt(...) + 0.007`） */
  floorOffset: 0.007,
  /** 反弹阈值（上游 `|vy| > 0.6` 才弹，否则躺平） */
  bounceThreshold: 0.6,
  bounceY: -0.42,
  bounceXZ: 0.6,
  spinDamp: 0.6,
  /** 自旋角速度幅度（上游 `(random-0.5)*40`） */
  spinRange: 40,
  /** 最多响几声落地音（上游 `bounces <= 3`） */
  maxBounceSounds: 3,
  /** 抛壳初速（上游 `right*(2.2+r*0.8) + up*(1.6+r*0.8) + forward*(-0.6) + playerVel`） */
  ejectRight: 2.2,
  ejectRightRange: 0.8,
  ejectUp: 1.6,
  ejectUpRange: 0.8,
  ejectBack: -0.6,
});

/** 弹孔池（上游 `Holes(scene, max=56)`） */
export const CARBINE_HOLE_FX = Object.freeze({
  /** 池容量（上游 56；FIFO 绕回 = 最旧的弹孔消失，观感自然） */
  capacity: 56,
  /** 尺寸区间（上游 `0.035 + random*0.02`） */
  sizeMin: 0.035,
  sizeRange: 0.02,
  /** 沿法线抬升（上游顶点 `aP.xyz + n*0.012`；本仓靠它替代 polygonOffset） */
  normalOffset: 0.012,
  /** 颜色与不透明度（上游片元：`vec3(0.035,0.035,0.04)*rim*2`，alpha 0.85×羽化） */
  color: Object.freeze([0.035, 0.035, 0.04]),
  alpha: 0.85,
  renderOrder: 1,
});

/**
 * 「哪些方块算金属」—— 命中金属时火花更多更亮 + 金属音（上游 `wh.c.surf === 'metal'`）。
 *
 * ⚠️ **判据是方块名集合，不是 registry 的某个表**：本仓没有「表面材质」这一维数据
 * （上游有 surf 字段）。新增金属方块时往这里加名字即可。
 * ⚠️ 名字必须真实存在于 `blocks-data.js`（单测逐个核对，防拼错导致静默走 stone 分支）。
 */
export const CARBINE_METAL_BLOCKS = Object.freeze([
  'iron', 'gold_block', 'iron_ore', 'gold_ore', 'nether_gold_ore',
  'oxidized_cut_copper', 'weathered_cut_copper', 'hanging_lamp',
]);

/**
 * 命中面分类（纯函数）：决定火花参数、烟尘参数与音效。
 *
 * @param {{blockName?:string|null, normal?:number[]|null, isEntity?:boolean}} hit
 * @returns {'entity'|'metal'|'floor'|'wall'}
 */
export function carbineImpactKind(hit) {
  if (hit.isEntity) return 'entity';
  if (hit.blockName && CARBINE_METAL_BLOCKS.includes(hit.blockName)) return 'metal';
  // 上游 `floor = wh.ny > 0.5`（法线朝上 = 打在水平面上）
  if (hit.normal && hit.normal[1] > 0.5) return 'floor';
  return 'wall';
}

/**
 * 火花爆发参数（按命中类型）。
 * @param {'entity'|'metal'|'floor'|'wall'} kind
 * @returns {{count:number, speed:number, color:readonly number[], life:number}}
 */
export function carbineSparkParams(kind) {
  if (kind === 'entity') return CARBINE_SPARK_FX.entity;
  if (kind === 'metal') return CARBINE_SPARK_FX.metal;
  return CARBINE_SPARK_FX.stone;
}

/**
 * 烟尘参数（按命中类型）。实体/地面/墙面三档（上游三分支）。
 * @param {'entity'|'metal'|'floor'|'wall'} kind
 */
export function carbinePuffParams(kind) {
  if (kind === 'entity') return CARBINE_PUFF_FX.entity;
  if (kind === 'floor') return CARBINE_PUFF_FX.floor;
  return CARBINE_PUFF_FX.wall;
}

/**
 * 命中音效 id（按命中类型）。
 * ⚠️ 三个 id 必须在 `CARBINE_RECIPES` 里（单测钉住）—— 拼错 = 静默无声。
 * @param {'entity'|'metal'|'floor'|'wall'} kind
 * @returns {string|null} null = 不播（实体命中走 hit/kill 音，不播 impact）
 */
export function carbineImpactSound(kind) {
  if (kind === 'entity') return null;
  if (kind === 'metal') return 'carbine_impact_metal';
  if (kind === 'floor') return 'carbine_impact_wet';
  return 'carbine_impact_stone';
}

/**
 * 一簇火花的出生种子（**纯函数，rand 注入 ⇒ 可复现**）。
 *
 * 上游 `Sparks.burst`：以法线为轴、在 `spread` 半径内随机偏转方向，
 * 速度 `sp*(0.35+random*0.9)`，寿命 `life*(0.5+random)`，颜色 ×`(0.6+random*0.8)`。
 *
 * @param {number[]} pos 命中点世界坐标
 * @param {number[]} normal 外法线（实体命中时取 `-dir` 并抬 y+0.3，上游同口径）
 * @param {{count:number,speed:number,color:readonly number[],life:number}} params
 * @param {() => number} rand
 * @param {object} [cfg]
 * @returns {Array<{pos:number[], vel:number[], life:number, color:number[], width:number}>}
 */
export function carbineSparkSeeds(pos, normal, params, rand, cfg = CARBINE_SPARK_FX) {
  const out = [];
  const n = Math.max(0, Math.floor(params.count));
  for (let i = 0; i < n; i++) {
    const dx = normal[0] + (rand() * 2 - 1) * cfg.spread;
    const dy = normal[1] + (rand() * 2 - 1) * cfg.spread;
    const dz = normal[2] + (rand() * 2 - 1) * cfg.spread;
    const il = 1 / (Math.hypot(dx, dy, dz) || 1);
    const s = params.speed * (0.35 + rand() * 0.9);
    const k = 0.6 + rand() * 0.8;
    out.push({
      pos: [pos[0], pos[1], pos[2]],
      vel: [dx * il * s, dy * il * s, dz * il * s],
      life: params.life * (0.5 + rand()),
      color: [params.color[0] * k, params.color[1] * k, params.color[2] * k],
      width: cfg.width,
    });
  }
  return out;
}

/**
 * 曳光的存活时长（秒）—— 池账与单测共用。
 *
 * 上游顶点：`head = (uTime - birth) * speed`，`alive = head >= 0 && head - len <= L`
 * ⇒ 从出生到尾部越过终点的时长 = `(L + len) / speed`，其中 `len = min(L*0.5, 9)`。
 *
 * @param {number} distance 起点到终点距离（格）
 * @param {object} [cfg]
 * @returns {number}
 */
export function carbineTracerLifetime(distance, cfg = CARBINE_TRACER_FX) {
  const L = Math.max(0, distance);
  const len = Math.min(L * cfg.lengthRatio, cfg.maxLength);
  return (L + len) / cfg.speed;
}