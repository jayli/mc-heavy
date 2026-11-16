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