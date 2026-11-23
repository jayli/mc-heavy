// src/player/weapons/carbine.js — KV-9 卡宾枪的**弹匣状态机与换弹时间线**（three-free）
//
// 上游：`~/jaylli/bj-shooting-game/night-heron-src/src/game/weapon.js`
//   · `WEAPON = { mag: 30, rpm: 690, reloadTime: 2.15 }`
//   · `update()` 里的 reload 时间线（rl / magOut / rack 三条曲线 + 三段音）
//   · `fire()` 里的散布与后坐累积
//
// ## 与上游的三处**有意偏离**（用户裁定）
//
// ① **无限子弹**：上游有 `reserve = 150`，打光后要捡弹药。本仓 `reserve` 概念整体删除
//    —— 弹匣永远能补满。上游 `startReload` 的 `this.reserve <= 0` 门与 `dry()` 空仓音
//    因此都不存在（30 发打光**必然**进换弹，不会卡在空仓）。
// ② **不做按键换弹**：上游 `input.reloadPressed`（R 键）那条路径删除 —— 本仓 R 键是
//    循环切枪（`WeaponController.cycle`），不能占用。只有「打光自动换」一条入口。
// ③ **ADS（右键机瞄）不移植**：本仓右键是放方块。上游所有 `lerp(a, b, ads)` 一律取
//    **ads = 0** 那一端（腰射值），故本文件的散布/后坐常量就是上游的腰射值。
//
// ## 为什么单独成模块
// 与 `storm-lance.js` / `cinder-fall.js` / `view-bob.js` 同手法：换弹时间线是**有对错可言
// 的逻辑**（时刻、曲线、段音去重），必须能被 Tier 1 单测钉住；而 `view-weapon.js` 依赖
// three + DOM，单测里驱动不了。渲染层只消费本模块算出的三条曲线，不重算时刻。
//
// ⚠️ **时间基准由调用方给 dt（秒）**，本模块不读 `performance.now()` / `Date.now()`
// —— 纯累加，掉帧与变帧率下语义不变（与 controller 的冷却同一口径）。

/**
 * KV-9 的玩法与手感常量（冻结）。**唯一权威**：catalog / controller / 视图模型 / 单测
 * 全部从这里读，不在各处写字面量（红线 1）。
 *
 * 数值逐项取自上游 `WEAPON` 与 `fire()` / `update()`，未做主观调整 ——
 * 用户要求「动效与那个游戏保持一样」。
 */
export const CARBINE = Object.freeze({
  /** 弹匣容量（上游 `WEAPON.mag`） */
  mag: 30,
  /** 射速（发/分，上游 `WEAPON.rpm`）→ 冷却 `60/rpm` 秒 */
  rpm: 690,
  /**
   * 单发伤害 = **加特林**。用户裁定：「击中时的丧尸或者 boss 掉血和原有的机枪击中时的
   * 掉血完全一样」。⚠️ 这里不写 35 —— 唯一权威是 catalog 的 `MINIGUN.entityDamage`，
   * 由 `weapon-catalog.js` 在构造 KV-9 条目时派生（写第二份 35 就是红线 1）。
   */
  /** 换弹总时长（秒，上游 `WEAPON.reloadTime`） */
  reloadSeconds: 2.15,
  /**
   * 打光后**自动**进换弹的延迟（秒）。上游判据是 `this.cool < -0.25`
   * （冷却已过期 0.25s）—— 保留这个停顿，读作「最后一发的余韵 + 手离开扳机」。
   */
  autoReloadDelaySeconds: 0.25,

  // ---- 换弹时间线的三段音（上游 `reloadStage` 的三个跨越点）----
  /** 卸弹匣音（t > 0.32） */
  reloadSound0At: 0.32,
  /** 插新弹匣音（t > 1.2） */
  reloadSound1At: 1.2,
  /** 拉机柄音（t > 1.72） */
  reloadSound2At: 1.72,

  // ---- 三条姿态曲线的时间参数（上游逐字）----
  /** 整枪下沉/侧倾的抬起段时长（`rl = min(1, t/0.28)`） */
  rigLiftSeconds: 0.28,
  /** 整枪回位的起点与时长（`1 - clamp((t-1.82)/0.3)`） */
  rigReturnAt: 1.82,
  rigReturnSeconds: 0.3,
  /** 弹匣脱出的起点与时长（`clamp((t-0.3)/0.25)`） */
  magOutAt: 0.3,
  magOutSeconds: 0.25,
  /** 弹匣消失（新匣插回）的起点与时长（`1 - clamp((t-0.95)/0.25)`） */
  magBackAt: 0.95,
  magBackSeconds: 0.25,
  /** 拉机柄脉冲中心与半宽（`max(0, 1 - |t-1.76|/0.1)`） */
  rackAt: 1.76,
  rackHalfWidth: 0.1,

  // ---- 散布（上游 ads=0 端）----
  /** 基础散布（弧度）。上游 `lerp(0.0075, 0.0012, ads)` 的 ads=0 端 */
  spreadBase: 0.0075,
  /** 每发累积散布。上游 `lerp(0.0042, 0.0016, ads)` 的 ads=0 端 */
  spreadPerShot: 0.0042,
  /** 累积散布上限（上游 `min(spread + …, 0.03)`） */
  spreadMax: 0.03,
  /** 散布每秒回落（上游 `spread - dt*0.055`） */
  spreadDecayPerSecond: 0.055,
  /** 腾空时的散布倍率（上游 `grounded ? 1 : 2.2`） */
  spreadAirMultiplier: 2.2,
  /** 移动速度 → 散布的系数。上游 `min(speed,8) * lerp(0.0018,0.0006,ads)` 的 ads=0 端 */
  spreadSpeedFactor: 0.0018,
  /** 移动速度的钳制上限（上游 `Math.min(player.speed, 8)`；本仓 SPEED=8 恰好同值） */
  spreadSpeedCap: 8,

  // ---- 后坐（上游 ads=0 端）----
  /** 视图模型后退量上限（上游 `kick = min(kick+1, 1.6)`） */
  kickMax: 1.6,
  /** 相机俯仰冲量（上游 `player.recoil(lerp(0.0125,0.0075,ads), …)` 的第一参） */
  recoilPitch: 0.0125,
  /** 相机偏航冲量幅度（第二参 `±lerp(0.011,0.005,ads)`） */
  recoilYaw: 0.011,
  /** 每发的镜头震动增量（上游 `G.shake(0.085)`） */
  shotTrauma: 0.085,

  // ---- 命中反馈（上游 `fire()` 的 hitstop / shake）----
  /** 击杀 hit stop（秒，上游 `G.hitstop(0.075)`） */
  hitstopKill: 0.075,
  /** 命中未死 hit stop（上游 `G.hitstop(0.022)`） */
  hitstopHit: 0.022,
  /** hit stop 期间的时间缩放（上游 `dt = realDt * 0.06`） */
  hitstopTimeScale: 0.06,
  /** 击杀震动（上游 `G.shake(0.2)`） */
  traumaKill: 0.2,
  /** 命中未死震动（上游 `G.shake(0.06)`） */
  traumaHit: 0.06,
  /** trauma 每秒衰减（上游 `trauma - dt*1.7`） */
  traumaDecayPerSecond: 1.7,

  // ---- 枪口火光 ----
  /** 火光持续（秒，上游 `flashT = 0.045`） */
  flashSeconds: 0.045,

  // ---- 曳光（上游 `G.fx.tracers.fire(..., [9,5.5,2.2], 320, 0.011)`）----
  /** 曳光颜色（**线性 HDR**，上游同值；不是 sRGB hex） */
  tracerColor: Object.freeze([9, 5.5, 2.2]),
  /** 曳光头推进速度（格/秒，上游 320） */
  tracerSpeed: 320,
  /** 曳光半宽（格，上游 0.011） */
  tracerWidth: 0.011,
  /** 曳光段长上限（格，上游 `min(L*0.5, 9.0)` 的 9.0） */
  tracerMaxLength: 9,
  /** 段长相对全长的比例上限（上游 `L*0.5`） */
  tracerLengthRatio: 0.5,
});

/** 冷却（秒）= 60 / rpm。派生，不写字面量。 */
export const CARBINE_COOLDOWN = 60 / CARBINE.rpm;

/**
 * 冷却推进口径（v3.30）—— **允许变负**，与上游 `this.cool -= dt` 同口径。
 *
 * ⚠️⚠️ **为何不能沿用本仓的 `Math.max(0, cooldown - dt)`**：自动换弹的判据是
 * 「冷却已过期 0.25 秒」（上游 `cool < -0.25`）。钳到 0 后该判据**永不成立**
 * ⇒ 30 发打光后永不换弹，而弹药计数/冷却/特效全部看上去正常（静默失效）。
 *
 * ⚠️ **只对卡宾枪变负**：既有四把枪 + 剑的 `cooldown` 语义逐位不变（钳 0），
 * 它们的 spec 与单测里有直读 `debugState().cooldown` 的断言。
 * 负值不影响任何开火判据（全部是 `cooldown > 0` 早退）。
 *
 * @param {number} cooldown 当前冷却（秒）
 * @param {number} dt 秒
 * @param {boolean} allowNegative 是否允许变负（卡宾枪 true）
 * @returns {number}
 */
export function carbineCooldownNext(cooldown, dt, allowNegative) {
  const next = cooldown - dt;
  return allowNegative ? next : Math.max(0, next);
}

/**
 * 换弹三段音的素材 id（上游 `G.audio.reload(0|1|2)`）。
 *
 * ⚠️ 三个音必须两两不同（单测钉住）—— 共用同一个就是「三段动作只听到一声」，
 * 而时间线与计数全绿。素材由 `tools/bake-carbine-audio.mjs` 从上游合成器离线渲染。
 */
export const CARBINE_RELOAD_SOUNDS = Object.freeze([
  'carbine_reload_out', 'carbine_reload_in', 'carbine_reload_rack',
]);
/** 换弹音量（三段共用；嫌响/嫌轻只改这一个数） */
export const CARBINE_RELOAD_VOLUME = 0.5;

/** [0,1] 钳制（上游 `clamp` 的本模块用法只有 0..1 这一种） */
function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

/**
 * 换弹时间线的三条姿态曲线（**纯函数**，上游 `update()` 逐字）。
 *
 * @param {number} t 自换弹开始的秒数（<0 视为未换弹）
 * @param {object} [cfg]
 * @returns {{rig:number, magOut:number, rack:number, magVisible:boolean}}
 *   · `rig`     整枪下沉/侧倾的包络：0→1（前 0.28s）→ 保持 → 1→0（1.82~2.12s）
 *   · `magOut`  弹匣脱出量：0.3s 起 0→1，0.95s 起 1→0（新匣插回）
 *   · `rack`    拉机柄脉冲：以 1.76s 为中心、半宽 0.1s 的三角脉冲
 *   · `magVisible` 弹匣是否可见 —— 脱到底（magOut ≥ 0.98）那一小段藏起来
 *
 * ⚠️ `t < 0`（未在换弹）时三条曲线全 0 且弹匣可见 —— 与上游 `reloadT = -1` 分支同结果。
 */
export function carbineReloadPose(t, cfg = CARBINE) {
  if (!(t >= 0)) return { rig: 0, magOut: 0, rack: 0, magVisible: true };
  const rig = Math.min(1, t / cfg.rigLiftSeconds)
    * (1 - clamp01((t - cfg.rigReturnAt) / cfg.rigReturnSeconds));
  const magOut = clamp01((t - cfg.magOutAt) / cfg.magOutSeconds)
    * (1 - clamp01((t - cfg.magBackAt) / cfg.magBackSeconds));
  const rack = Math.max(0, 1 - Math.abs(t - cfg.rackAt) / cfg.rackHalfWidth);
  return { rig, magOut, rack, magVisible: magOut < 0.98 };
}

/**
 * 本帧**新跨越**的换弹音段号（0/1/2），没跨越返回 -1。
 *
 * ⚠️ **用跨越比较而不是 `t >= 阈值`**：后者会在阈值之后的每一帧都返回同一段
 * ⇒ 音每帧重播（叠成一片噪）。与 controller 的 `_novaStartFired` 同手法。
 * ⚠️ 一帧内跨越多段时返回**最早的那一段**（大 dt 掉帧场景）；调用方按返回值逐段推进，
 * 下一帧继续 —— 三段音都不会丢，只是次序被压到相邻帧。
 *
 * @param {number} prevT 上一帧的换弹秒数
 * @param {number} t 本帧的换弹秒数
 * @param {number} stage 已播到第几段（0 = 还没播过任何段）
 * @param {object} [cfg]
 * @returns {number} 段号 0/1/2，或 -1
 */
export function carbineReloadSoundDue(prevT, t, stage, cfg = CARBINE) {
  const marks = [cfg.reloadSound0At, cfg.reloadSound1At, cfg.reloadSound2At];
  if (stage >= marks.length) return -1;
  const at = marks[stage];
  // 跨越：上一帧还没到、本帧到了（`prevT < at <= t`）。stage=0 且 prevT<0 也算跨越。
  return (prevT < at && t >= at) ? stage : -1;
}

/**
 * 本发的散布半径（弧度）。上游 `fire()` 的 `spr` 逐项，ads=0。
 *
 * @param {{spread:number, grounded?:boolean, speed?:number}} state
 * @param {object} [cfg]
 * @returns {number}
 */
export function carbineSpread(state, cfg = CARBINE) {
  const grounded = state.grounded !== false;
  const speed = Math.min(Number.isFinite(state.speed) ? state.speed : 0, cfg.spreadSpeedCap);
  return (cfg.spreadBase + Math.max(0, state.spread)) * (grounded ? 1 : cfg.spreadAirMultiplier)
    + speed * cfg.spreadSpeedFactor;
}

/**
 * 一发子弹的方向抖动（**纯函数，rand 注入 ⇒ 可复现**）。
 *
 * 上游：在相机 right/up 基底上取**圆内均匀**一点（`sqrt(random)` 校正半径），
 * 加到 forward 上再归一化。⚠️ 不开平方会让弹着点挤在准心（读作「激光枪」）。
 *
 * @param {number[]} forward 单位前向
 * @param {number[]} right 单位右向
 * @param {number[]} up 单位上向
 * @param {number} spread 散布半径（弧度，`carbineSpread` 的输出）
 * @param {() => number} rand [0,1) 均匀随机
 * @returns {number[]} 抖动后的单位方向
 */
export function carbineJitteredDir(forward, right, up, spread, rand) {
  const a = rand() * Math.PI * 2;
  const r = Math.sqrt(rand()) * spread;
  const cx = Math.cos(a) * r;
  const cy = Math.sin(a) * r;
  const d = [
    forward[0] + right[0] * cx + up[0] * cy,
    forward[1] + right[1] * cx + up[1] * cy,
    forward[2] + right[2] * cx + up[2] * cy,
  ];
  const len = Math.hypot(d[0], d[1], d[2]) || 1;
  return [d[0] / len, d[1] / len, d[2] / len];
}

/**
 * 弹匣状态机。**只管弹药与换弹计时**，不碰命中/伤害/渲染。
 *
 * 状态：
 *   · `ammo`     当前弹匣余弹（0..mag）
 *   · `reloadT`  换弹已过秒数；**−1 = 未在换弹**（与上游同一哨兵值）
 *   · `stage`    已播过的换弹音段数（0..3）
 *   · `spread`   累积散布（每发 +，随时间 −）
 *
 * ⚠️ **`advance()` 必须在开火判定之前调**：它负责扣散布与推进换弹；反过来会让
 * 「换弹刚结束那一帧」的 ammo 还是 0 而白白空放一帧。
 */
export class CarbineMagazine {
  /** @param {object} [cfg] */
  constructor(cfg = CARBINE) {
    this.cfg = cfg;
    this.ammo = cfg.mag;
    this.reloadT = -1;
    this.stage = 0;
    this.spread = 0;
    /** 本帧是否刚开始换弹（供视图模型/音；`advance` 每次重置） */
    this.startedThisFrame = false;
  }

  /** 切枪/重生：满弹匣、不在换弹、散布归零（上游 `reset()`） */
  reset() {
    this.ammo = this.cfg.mag;
    this.reloadT = -1;
    this.stage = 0;
    this.spread = 0;
    this.startedThisFrame = false;
  }

  /** 是否正在换弹 */
  get reloading() { return this.reloadT >= 0; }

  /** 换弹进度 0..1（未换弹时 1 —— 与 `ViewWeapon.swingProgress` 的「1 = 空闲」同口径） */
  get reloadProgress() {
    return this.reloading ? Math.min(1, this.reloadT / this.cfg.reloadSeconds) : 1;
  }

  /** 本帧的三条姿态曲线（渲染层直接消费，不重算时刻） */
  get pose() { return carbineReloadPose(this.reloadT, this.cfg); }

  /**
   * 开始换弹。**幂等**：已在换弹 / 弹匣已满时不改变状态。
   * ⚠️ 无 reserve 门（无限子弹，见文件头偏离 ①）。
   * @returns {boolean} 本次调用是否真的开始了换弹
   */
  startReload() {
    if (this.reloading || this.ammo >= this.cfg.mag) return false;
    this.reloadT = 0;
    this.stage = 0;
    this.startedThisFrame = true;
    return true;
  }

  /**
   * 推进一帧：散布回落 + 换弹计时 + 到点补满弹匣。
   *
   * @param {number} dt 秒
   * @param {number} cooldown 当前射击冷却（秒）。⚠️ **必须是未钳 0 的真实值**
   *   （`carbineCooldownNext(..., true)`）—— 钳 0 后自动换弹永不触发。
   * @returns {number} 本帧新跨越的换弹音段号（0/1/2），无则 −1
   */
  advance(dt, cooldown = 0) {
    this.startedThisFrame = false;
    this.spread = Math.max(0, this.spread - dt * this.cfg.spreadDecayPerSecond);
    let sound = -1;
    if (this.reloading) {
      const prev = this.reloadT;
      this.reloadT = prev + dt;
      sound = carbineReloadSoundDue(prev, this.reloadT, this.stage, this.cfg);
      if (sound >= 0) this.stage = sound + 1;
      if (this.reloadT >= this.cfg.reloadSeconds) {
        this.ammo = this.cfg.mag;   // 无限子弹：直接补满
        this.reloadT = -1;
        this.stage = 0;
      }
    } else if (this.ammo === 0 && cooldown < -this.cfg.autoReloadDelaySeconds) {
      // 打光 → 自动换弹（唯一入口，无按键路径）
      this.startReload();
    }
    return sound;
  }

  /**
   * 尝试消耗一发。**只在 controller 决定真要开火时调**。
   * @returns {boolean} 是否成功（换弹中 / 空匣 → false）
   */
  consume() {
    if (this.reloading || this.ammo <= 0) return false;
    this.ammo--;
    this.spread = Math.min(this.spread + this.cfg.spreadPerShot, this.cfg.spreadMax);
    return true;
  }

  /** 只读快照（HUD / 测试） */
  get state() {
    return {
      ammo: this.ammo, mag: this.cfg.mag, reloading: this.reloading,
      reloadProgress: this.reloadProgress, stage: this.stage, spread: this.spread,
    };
  }
}