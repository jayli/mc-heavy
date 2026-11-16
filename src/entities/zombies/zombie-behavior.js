// src/entities/zombies/zombie-behavior.js — 丧尸行为层（v3.11）
//
// 同构层：**无 DOM、无 three、无网络、不自建 Worker**（`npm run check:arch` 静态门守）。
//
// ## 分层位置：插在「8 向决策」与「局部避让」之间
//
// ```
// ① zombie-pathfinder.js   A* 24 格 → 下一个地标          【共用，不动】
// ② zombie-navigator.js    decideStep：地标 → 8 向可走一步  【共用，不动】
// ③ 本模块                 丧尸专属：这一拍到底怎么走
// ④ zombie-navigation.js   steerIntent：最后 1.2 格精细避让 【共用，不动】
// ⑤ zombie-system.js       60Hz 物理                      【不动】
// ```
//
// **为什么③在②之后④之前**：②回答「哪个方向有路」，③回答「这一拍要不要走、走多快、
// 要不要退」，④回答「这个方向真的走得通吗」。放在④之后会让「后退」也被避障探针改写方向 ——
// 后退本身就是「探针说走不通」的产物，再探一次会把它吞掉（v2.47 排斥力被 steerIntent
// 吞掉是同类陷阱）。
//
// **为什么是丧尸专属而不改共用层**：`decideStep` / `memoryFor` / `steerIntentAabb` 被
// 焰魔（`ignis-system.js`）与末影守卫（`guardian-system.js`）共用，它们身上压着站定环、
// `needsPath` 偏差判据、招式中止门的实测标定。改共用层会让两个 Boss 一起变。
//
// ## ⚠️⚠️ 为什么卡住判据用「时间维度」而不是「几何维度」（实测推翻的直觉）
//
// 直觉方案是「加侧向净空探针，离墙太近就退开」。**实测证明它没有判别力**：
//
// | 场景 | 左净空 | 右净空 | min |
// |---|---|---|---|
// | 开阔地 | 1.60 | 1.60 | 1.60 |
// | 贴墙滑行中段 | 0.60 | 1.60 | **0.60** |
// | L 形墙角（真该退） | 0.60 | 1.60 | **0.60** |
// | 1 格宽走廊（**必须能过**） | 0.10 | 0.10 | 0.10 |
//
// 「正常贴墙滑行」与「墙角卡死」的侧向净空**逐位相同**，而 1 格宽门洞的净空更小 ——
// 任何「净空小于阈值就后退」的判据都会让丧尸**不敢进门**（v2.40 明确保住的语义）。
// ⇒ 「该不该退」只能由**走没走动**判定。附带收益：本模块**不新增任何 isSolid 调用**。
import { ZOMBIE_BEHAVIOR } from './zombie-config.js';
import { DIRECTION_VECTORS } from './zombie-navigator.js';

/**
 * 取（或创建）某只丧尸的行为记忆。
 *
 * ⚠️ **挂在既有 `memoryFor` 返回的对象上，不新建第二个 Map**（红线 1）：
 * `ZombieService._releaseSlot` 已经 `this._navMemory.delete(id)`，三条回收路径
 * （死亡 / column 卸载 / dispose）都经过它 ⇒ 行为记忆自动随之回收，
 * id 随 slot 复用时不会带上上一只的状态。
 *
 * @param {object} memory `memoryFor(map, id)` 的返回值
 * @param {number} nowMs 时间基准（`performance.now()` 口径）
 * @returns {object} behavior（原地持有，跨拍累积）
 */
export function behaviorFor(memory, nowMs) {
  if (!memory.behavior) {
    memory.behavior = {
      /** 滚动位置窗口 `[[nowMs, x, z], …]`（信号 A 的唯一输入） */
      hist: [],
      /** 信号 B 的持续计时起点（ms）；背离角回落时清 null */
      awaySince: null,
      /** 状态机相位（Task 3 起消费） */
      phase: 'chase',
      /** 上一拍採到的时刻（未採过时 null） */
      lastSampleMs: null,
      /** 起始时刻（诊断用） */
      bornMs: Number.isFinite(nowMs) ? nowMs : 0,
      // ---- 状态机（Task 3）----
      /** 当前相位的结束时亥（ms）；hesitate 用它计时 */
      phaseUntil: 0,
      /** backoff 起点 `[x,z]`（算累计退了多远） */
      backoffStart: null,
      /** backoff 目标距离（格，进入时由 rng 定） */
      backoffTarget: 0,
      /** backoff 方向单位向量 `[x,z]` */
      backoffDir: null,
      /** backoff 开始时亥（撞墙判据的宽限期基准） */
      backoffSince: 0,
      /** replan 开始时亥 */
      replanSince: 0,
      /** 连续失败次数（只在「重算后仍无路」时 +1） */
      failCount: 0,
      /** replan 阶段剩下的踱步步数 */
      paceLeft: 0,
      /** 当前踱步方向 `[x,z]` */
      paceDir: null,
      /** 踱步起点 `[x,z]` */
      paceStart: null,
      /** wander 锢点 `[x,z]` */
      wanderAnchor: null,
      /** wander 下一次重试寻路的时亥（ms） */
      wanderNextRetry: 0,
      /** wander 当前踱步目标 `[x,z]` */
      wanderTarget: null,
      /** 上一拍的位置 `[x,z]`（判「本拍真的动了没」） */
      lastPos: null,
      /** 上一拍的方向单位向量（转向减速用，Task 4） */
      lastDir: null,
      /** 开始移动的时亥（起步加速用，Task 4） */
      movingSince: null,
    };
  }
  return memory.behavior;
}

/**
 * 记录一拍位置采样（滚动窗口）。**原地改 `behavior.hist`**。
 *
 * 只保留最近 `stuckWindowSeconds` 秒 —— 窗口外的采样对「首尾直线距离」无意义，
 * 留着会让判据变成「整段旅程的平均速度」。
 *
 * @param {object} behavior @param {number[]} position 脚底 `[x,y,z]` @param {number} nowMs
 */
export function recordSample(behavior, position, nowMs) {
  const t = Number.isFinite(nowMs) ? nowMs : 0;
  behavior.hist.push([t, position[0], position[2]]);
  const cutoff = t - ZOMBIE_BEHAVIOR.stuckWindowSeconds * 1000;
  // 用 while + shift：窗口内最多 ~30 项（20Hz × 1.5s），成本可忽略
  while (behavior.hist.length > 1 && behavior.hist[0][0] < cutoff) behavior.hist.shift();
  behavior.lastSampleMs = t;
}

/**
 * 判定这一拍是否「走不动」。**纯函数**（只读 behavior 与入参，唯一副作用是
 * 维护 `awaySince` 计时 —— 那是信号 B 的持续判据所必需）。
 *
 * 三个信号（按优先级）：
 * - **C `blocked`**：`decideStep` 说八个方向全不可走 ⇒ 围死（既有语义，不进犹豫循环）。
 * - **A `no-progress`**：窗口首尾直线距离 < `stuckDistance` ⇒ 原地打转。
 * - **B `no-way`**：靠近玩家但规划方向持续背离玩家 ⇒ 「到跟前了却没路」。
 *
 * ⚠️⚠️ **到达门在三个信号之前，是统一落点**：丧尸成功追到玩家身边后**本来就零位移**
 * （贴身时 `steerIntent` 判 blocked）。没有这道门，卡住判据会把「追到了」误判成
 * 「卡住了」⇒ **每只追上玩家的丧尸都开始后退**（实测开阔地 191 帧误触发）。
 * 写在入口而不是只写在信号 A 里，否则 B/C 仍会在贴身时误触发。
 *
 * @param {{behavior: object, position: number[], playerPosition: number[],
 *          plannedDirection: string|null, blocked: boolean, nowMs: number}} p
 * @returns {{stuck: boolean, reason: 'none'|'no-progress'|'no-way'|'blocked'}}
 */
export function detectStuck({ behavior, position, playerPosition, plannedDirection, blocked, nowMs }) {
  const B = ZOMBIE_BEHAVIOR;
  const dx = playerPosition[0] - position[0];
  const dz = playerPosition[2] - position[2];
  const dist = Math.hypot(dx, dz);
  // ---- 到达门（统一落点，见上方警告）----
  if (dist <= B.arriveDistance) {
    behavior.awaySince = null;
    return { stuck: false, reason: 'none' };
  }
  // ---- 信号 C：围死（优先级最高，既有 blocked 语义不变）----
  if (blocked === true) return { stuck: true, reason: 'blocked' };
  // ---- 信号 A：窗口净位移 ----
  const hist = behavior.hist;
  const winMs = B.stuckWindowSeconds * 1000;
  // 窗口必须已铺满，否则开局头几拍会被误判（那时还没走够一个窗口）
  if (hist.length >= 2 && nowMs - hist[0][0] >= winMs - 1e-6) {
    const a = hist[0];
    const b = hist[hist.length - 1];
    // ⚠️ 首尾**直线距离**，不是路径长：卡死场景每帧都在动（路径长非零），
    // 只有净位移能识别「原地打转」。
    if (Math.hypot(b[1] - a[1], b[2] - a[2]) < B.stuckDistance) {
      return { stuck: true, reason: 'no-progress' };
    }
  }
  // ---- 信号 B：近距 + 规划方向持续背离玩家 ----
  const vec = plannedDirection ? DIRECTION_VECTORS[plannedDirection] : null;
  let away = false;
  if (vec && dist > 1e-6 && dist <= B.nearPlayerDistance) {
    const vl = Math.hypot(vec[0], vec[1]);
    // 夹角：规划方向 · 朝玩家单位向量
    const dot = (vec[0] / vl) * (dx / dist) + (vec[1] / vl) * (dz / dist);
    const angDeg = Math.acos(Math.max(-1, Math.min(1, dot))) * 180 / Math.PI;
    away = angDeg > B.awayAngleDeg;
  }
  if (!away) {
    behavior.awaySince = null;   // 回落即清零（不能攒够时长）
    return { stuck: false, reason: 'none' };
  }
  if (behavior.awaySince === null) behavior.awaySince = nowMs;
  if (nowMs - behavior.awaySince >= B.awayHoldSeconds * 1000) {
    return { stuck: true, reason: 'no-way' };
  }
  return { stuck: false, reason: 'none' };
}
/** 相位 → state.mode 的映射（`normalizeMode` 的白名单须与它一致） */
const PHASE_MODE = Object.freeze({
  chase: 'chasing',
  hesitate: 'hesitating',
  backoff: 'backing',
  replan: 'chasing',
  wander: 'wandering',
});

/** 单位化一个二维向量；零长度返回 null */
function unit2(x, z) {
  const len = Math.hypot(x, z);
  return len > 1e-9 ? [x / len, z / len] : null;
}

/**
 * 进入 replan 相位：**清缓存 + 安排侧向踱步**。
 *
 * ⚠️ `paceLeft` 必须在这里赋值（spec §4.3 细节⑤）—— 漏了它的形态是
 * 「replan 相位从不对外返回」：下面的 replan 分支看到 `paceLeft<=0` 就直接结算，
 * 于是状态机看上去「 hesitate → backoff → 又 hesitate」而从未踱步（实测踩到）。
 */
function enterReplan(b, nowMs, rng) {
  const B = ZOMBIE_BEHAVIOR;
  b.phase = 'replan';
  b.paceLeft = B.paceStepsMin + Math.floor(rng() * (B.paceStepsMax - B.paceStepsMin + 1));
  b.paceDir = null;
  b.paceStart = null;
  b.backoffStart = null;
  b.backoffDir = null;
  b.replanSince = nowMs;
}

/**
 * 行为层主入口：决定这一拍**到底怎么走**。
 *
 * 状态机（spec §4.3）：
 * ```
 * chase ──(卡住)──> hesitate ──> backoff ──> replan ──┬─(有路)─> chase
 *                                                     └─(连续失败≥3)─> wander ─(有路)─> chase
 * ```
 *
 * **七条载荷性细节**（每条都是已知陷阱的防线，改任一条前先读 spec §4.3）：
 * ① 入口前置门：已抵达玩家（≤ `arriveDistance`）⇒ 原样透传，不动状态机。
 * ② `step.blocked`（八向全不可走）⇒ `mode:'blocked'` 零速度，**不进犹豫** —— 既有 E2E
 *    「四面围死 → blocked」的语义必须保住。「四面全是墙」是站住，「有路但走不到玩家」才犹豫。
 * ③ hesitate 零速度 ⇒ `setIntent` 的「静止保持朝向」契约让朝向也不变，这就是「愣一下」。
 * ④ backoff 撞墙（本拍位置相对上拍没动）⇒ **立即结束**，不硬顶（否则复现贴墙蹭的镜像形态）。
 * ⑤ replan 返回 `replan:true`，调用方须清 `PathCache` —— 不清则命中 4 秒前的旧路径，
 *    后退完又走回墙边（v2.49「绕过障碍后回头」的同类根因）。
 * ⑥ 失败计数**只在「重算后仍无路」时 +1**；chase 且本拍有位移则归零 ——
 *    否则玩家绕柱子跑动会让计数虚高、丧尸莫名进入徘徊。
 * ⑦ wander 是**小幅踱步**（有位移、有步态），且必然周期重试 ⇒ 拆墙后最迟
 *    `wanderRetrySeconds` 恢复，不是「站死」。
 *
 * @param {{behavior: object, position: number[], playerPosition: number[],
 *          step: {vx:number, vz:number, mode:string, plannedDirection:string|null, blocked:boolean},
 *          nowMs: number, rng?: () => number}} p
 * @returns {{vx:number, vz:number, mode:string, phase:string, replan:boolean}}
 *   `vx/vz` 是**单位向量 ×（Task 4 起的速度倍率）**，调用方再乘 `ZOMBIE.speed`。
 */
export function decideBehavior({ behavior, position, playerPosition, step, nowMs, rng = Math.random }) {
  const B = ZOMBIE_BEHAVIOR;
  const b = behavior;
  const dx = playerPosition[0] - position[0];
  const dz = playerPosition[2] - position[2];
  const dist = Math.hypot(dx, dz);
  const out = (vx, vz, phase, replan = false) => ({ vx, vz, mode: PHASE_MODE[phase], phase, replan });

  // 本拍相对上拍是否真的动了（backoff 撞墙判据 / 失败计数归零判据）
  const movedThisTick = b.lastPos === null
    ? 0
    : Math.hypot(position[0] - b.lastPos[0], position[2] - b.lastPos[1]);
  b.lastPos = [position[0], position[2]];

  // ---- ① 前置门：已抵达玩家 ----
  if (dist <= B.arriveDistance) {
    b.phase = 'chase';
    b.failCount = 0;
    b.awaySince = null;
    return out(step.vx, step.vz, 'chase');
  }
  // ---- ② 围死：保持既有 blocked 语义 ----
  if (step.blocked === true) {
    b.phase = 'chase';
    return { vx: 0, vz: 0, mode: 'blocked', phase: 'chase', replan: false };
  }

  const stuck = detectStuck({
    behavior: b, position, playerPosition,
    plannedDirection: step.plannedDirection, blocked: step.blocked, nowMs,
  });

  switch (b.phase) {
    case 'hesitate': {
      if (nowMs < b.phaseUntil) return out(0, 0, 'hesitate');
      // 愣完 → 后退。方向 = 背离玩家；退不动（玩家正好同点）时直接进 replan
      const dir = unit2(-dx, -dz);
      if (!dir) { enterReplan(b, nowMs, rng); break; }
      b.phase = 'backoff';
      b.backoffDir = dir;
      b.backoffStart = [position[0], position[2]];
      b.backoffSince = nowMs;
      b.backoffTarget = B.backoffDistanceMin + rng() * (B.backoffDistanceMax - B.backoffDistanceMin);
      return out(dir[0], dir[1], 'backoff');
    }
    case 'backoff': {
      const walked = b.backoffStart
        ? Math.hypot(position[0] - b.backoffStart[0], position[2] - b.backoffStart[1])
        : 0;
      // ④ 退够目标 **或** 撞墙（本拍没动）⇒ 立即结束
      // ⚠️ **撞墙判据必须先给一个宽限期**（`backoffGraceSeconds`）：进入 backoff 的
      // 那一拍才刚把速度发出去，物理还没积分 ⇒ 下一拍位置必然没动。
      // 不给宽限期的形态是「backoff 永远只持续 1 拍」（实测踩到）。
      const backing = nowMs - (b.backoffSince ?? nowMs);
      const hitWall = b.backoffStart !== null
        && backing >= B.backoffGraceSeconds * 1000
        && movedThisTick <= 1e-6;
      if (walked >= b.backoffTarget || hitWall) {
        enterReplan(b, nowMs, rng);
        break;
      }
      const dir = b.backoffDir ?? unit2(-dx, -dz) ?? [0, 0];
      return out(dir[0], dir[1], 'backoff');
    }
    case 'wander': {
      // ⑦ 有路了（不再卡住）⇒ 回 chase
      if (!stuck.stuck) {
        b.phase = 'chase';
        b.failCount = 0;
        b.wanderAnchor = null;
        b.wanderTarget = null;
        return out(step.vx, step.vz, 'chase');
      }
      // 周期重试寻路（拆墙后最迟这么久恢复）
      let replan = false;
      if (nowMs >= b.wanderNextRetry) {
        b.wanderNextRetry = nowMs + B.wanderRetrySeconds * 1000;
        replan = true;
      }
      // 踱步：走到目标就换下一个（锚点半径内，由 rng 定方位）
      const anchor = b.wanderAnchor ?? [position[0], position[2]];
      if (!b.wanderTarget
        || Math.hypot(position[0] - b.wanderTarget[0], position[2] - b.wanderTarget[1]) < 0.25) {
        const th = rng() * Math.PI * 2;
        b.wanderTarget = [
          anchor[0] + Math.cos(th) * B.wanderRadius,
          anchor[1] + Math.sin(th) * B.wanderRadius,
        ];
      }
      const dir = unit2(b.wanderTarget[0] - position[0], b.wanderTarget[1] - position[2]) ?? [0, 0];
      return out(dir[0], dir[1], 'wander', replan);
    }
    default: break;   // chase / replan 落到下面统一处理
  }

  // ---- replan：清缓存 + 侧向踱几步，然后按新规划决定去向 ----
  if (b.phase === 'replan') {
    if (b.paceLeft <= 0) {
      // 踱步走完 ⇒ 结算这一轮：仍有路就追，没路就计一次失败
      if (!stuck.stuck) {
        b.phase = 'chase';
        b.failCount = 0;
        return out(step.vx, step.vz, 'chase');
      }
      b.failCount += 1;
      if (b.failCount >= B.wanderAfterAttempts) {
        b.phase = 'wander';
        b.wanderAnchor = [position[0], position[2]];
        b.wanderTarget = null;
        b.wanderNextRetry = nowMs + B.wanderRetrySeconds * 1000;
        return out(0, 0, 'wander', true);
      }
      // 还没到徘徊阈值 ⇒ 再愣一下（下一轮 hesitate）
      b.phase = 'hesitate';
      b.phaseUntil = nowMs + (B.hesitateSecondsMin
        + rng() * (B.hesitateSecondsMax - B.hesitateSecondsMin)) * 1000;
      return out(0, 0, 'hesitate', true);
    }
    // 侧向踱步：垂直于「朝玩家」方向，左右由 rng 定
    const toPlayer = unit2(dx, dz) ?? [0, -1];
    if (!b.paceDir || !b.paceStart
      || Math.hypot(position[0] - b.paceStart[0], position[2] - b.paceStart[1]) >= B.paceStepDistance) {
      const sign = rng() < 0.5 ? 1 : -1;
      b.paceDir = [-toPlayer[1] * sign, toPlayer[0] * sign];
      b.paceStart = [position[0], position[2]];
      b.paceLeft -= 1;
    }
    return out(b.paceDir[0], b.paceDir[1], 'replan', true);
  }

  // ---- chase ----
  if (stuck.stuck) {
    b.phase = 'hesitate';
    b.phaseUntil = nowMs + (B.hesitateSecondsMin
      + rng() * (B.hesitateSecondsMax - B.hesitateSecondsMin)) * 1000;
    return out(0, 0, 'hesitate');
  }
  // ⑥ 真的在前进 ⇒ 失败计数归零
  if (movedThisTick > 1e-6) b.failCount = 0;
  return out(step.vx, step.vz, 'chase');
}
