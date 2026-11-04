// src/entities/zombies/zombie-jev-planner.js — 在线 AI 编排（选批 / 并发 / 等待期沿用 / 降级）
//
// 同构层：无 DOM、无 three、不自建 Worker。
//
// ## 三条关键口径
//
// ① **决策周期从「回包」算起**，不是从发起算起（spec §3.3）—— 否则慢请求会让同一只被反复
//    排队，实际决策频率随网络抖动崩塌。
// ② **在途期间沿上一次决策方向走**：`onDecision` 只在回包时调用，这期间 `ZombieService` 的
//    `state.velocity` 保持不变（离线路径照跑），于是丧尸平滑跟随 —— 观感是「会思考地绕路」
//    而不是「站着不动等模型」。
// ③ **完全不 await**：`tick()` 只发起与消费，帧循环零阻塞。
import { JEV_AI } from './zombie-config.js';
import {
  DIRECTION_VECTORS, buildJevState, markDeadEnd, memoryFor, noteVisit, parseDirectionChoice,
} from './zombie-ai-view.js';
import { buildQuestions } from './zombie-jev-prompts.js';
import { PathCache, directionNameOf } from './zombie-pathfinder.js';

export class JevPlanner {
  /**
   * @param {{world: object, client: object, breaker: object, speed: number,
   *          log?: object, now?: () => number,
   *          onDecision?: (id: string, d: {vx: number, vz: number, mode: string}) => void,
   *          onFallback?: (id: string, reason: string) => void}} deps
   */
  constructor({ world, client, breaker, speed, log = null, now = null,
    onDecision = () => {}, onFallback = () => {} } = {}) {
    this.world = world;
    this.client = client;
    this.breaker = breaker;
    this.speed = speed;
    // ⚠️ **时间基准必须与调用方同源**：`tick(nowMs)` 的 nowMs 来自帧循环的
    // `performance.now()`，而 `Date.now()` 是 epoch 毫秒（差约 1.7e12）—— 混用会让
    // `nowMs < _nextAt` 恒真，**整个过程只决策一次**（实测 40 秒只 1 次 decided）。
    // 这正是 CLAUDE.md 已记的「时间基准统一用 performance.now()，禁止用 Date.now()」。
    this._now = now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
    this._log = log ?? ((typeof console !== 'undefined') ? console : { warn() {} });
    this._onDecision = onDecision;
    this._onFallback = onFallback;
    // **寻路缓存**（Review Focus 5）：`planStep` 不可达时要探索满 2401 格，
    // 实测真实地形 p90 1.09ms；而丧尸每 0.5 秒只移动约 0.6 格 —— 格级坐标常常不变。
    // 缓存在**格级**命中，把成本降到接近零（命中率见 `debugState().pathCache`）。
    this._pathCache = new PathCache();
    this.enabled = false;
    /** @type {Map<string, object>} id → 旅行记忆（唯一权威在这里，spec §3.4） */
    this._memory = new Map();
    /** @type {Map<string, {startedAt: number}>} 在途请求 */
    this._inflight = new Map();
    /** @type {Map<string, number>} id → 下次可决策的时间戳（从回包算起） */
    this._nextAt = new Map();
    this._stats = { decided: 0, failed: 0, lastReason: '' };
  }

  /**
   * 开关在线 AI。
   * ⚠️ **关闭必须清记忆与在途**：不清的形态是「关掉再开，丧尸带着关闭前的访问历史」，
   * 会以为某些格走过而乱绕。
   * ⚠️ **不销毁 planner**：它只持有常量与自管理状态，重新开启零成本。
   */
  setEnabled(on) {
    this.enabled = on === true;
    if (!this.enabled) {
      this._inflight.clear();
      this._nextAt.clear();
      this._memory.clear();
      this._pathCache.clear();
    }
  }

  /** 回收某只丧尸的记忆（死亡 / column 卸载 / dispose 三条 slot 回收路径共用一个入口） */
  resetMemory(id) {
    this._memory.delete(id);
    this._nextAt.delete(id);
    this._pathCache.forget(id);      // 缓存也要回收（否则 slot 复用会拿到上只的路线）
  }

  /**
   * 每帧推进（**不 await**）。
   * @param {number} nowMs
   * @param {Array<{id: string, position: number[], mobile: boolean, playerPosition?: number[]}>} zombies
   *   `mobile === false` 的丧尸（如 blocked）不参与决策 —— 它们已经走不动，问模型只是烧额度。
   */
  tick(nowMs, zombies) {
    if (!this.enabled) return;
    if (!this.breaker.available(nowMs)) return;
    for (const z of zombies ?? []) {
      if (!z.mobile) continue;
      if (this._inflight.has(z.id)) continue;              // 在途：不重复入队
      const next = this._nextAt.get(z.id) ?? 0;
      if (nowMs < next) continue;                          // 周期未到
      if (this._inflight.size >= JEV_AI.maxConcurrent) break; // 并发已满（后面的等下一帧）
      this._dispatch(z, nowMs);
    }
  }

  /**
   * 刷新某只丧尸的「当前计划」（v2 计划固化）。
   *
   * 单独一个方法而不是内联，是因为**判据必须与 `buildJevState` 里的 `walked` 计算同源**：
   * 它读 `mem.plan.direction`，这里写 `mem.plan`。两处各自算一遍会漂移。
   *
   * @param {object} mem 旅行记忆 @param {number[]} position @param {number[]} playerPosition
   */
  _refreshPlan(mem, position, playerPosition) {
    // ⚠️ 这里要**在 buildJevState 之前**算出方向，故直接调 planStep —— 与 buildJevState 里的
    // 那次调用是同一份纯函数、同一份输入，重复一次的成本是 24 格 BFS（实测 < 0.3ms）。
    // 不做「传进去复用」是因为那会让 buildJevState 变成有状态的两步调用（更易错）。
    const plan = this._pathCache.plan(this.world, position, playerPosition, {
      agentId: mem.__id ?? '__default__',
      nowMs: this._now(),
    });
    const dir = plan.reachable && plan.nextStep
      ? directionNameOf(plan.nextStep[0], plan.nextStep[1])
      : null;
    if (dir === null) {
      mem.plan = null;                       // 不可达：不固化成任何方向（回落 v1）
      return plan;                            // 调用方复用同一次 BFS 结果
    }
    if (mem.plan && mem.plan.direction === dir) {
      mem.plan.walked = (mem.plan.walked ?? 0) + 1;
    } else {
      mem.plan = { direction: dir, walked: 0 };
    }
    return plan;
  }

  /** 发起一次决策（异步，不阻塞 tick） */
  async _dispatch(z, nowMs) {
    const mem = memoryFor(this._memory, z.id);
    const playerPosition = z.playerPosition ?? z.position;
    noteVisit(mem, z.position[0], z.position[2]);

    // **计划固化**（v2，Review Focus 4）：每 0.5 秒重算 BFS 时，「往东绕」与「往西绕」
    // 往往等长 —— 不记住上一次的选择，丧尸会在两条等长路线之间来回横跳。
    // 做法 = 先把上次的计划方向记进 `mem.plan`，`buildJevState` 依据它算出 `walked`；
    // 计划方向一变就重置计数（换了路线，之前走的步数不再算「沿此计划」）。
    const plan = this._refreshPlan(mem, z.position, playerPosition);
    const plannedDir = (plan.reachable && plan.nextStep)
      ? directionNameOf(plan.nextStep[0], plan.nextStep[1])
      : null;

    // ══════════════════════════════════════════════════════════════════════════════
    // **代码优先**（用户 2026-11-04 裁定：「完全由代码决定，模型只处理不可达」）
    //
    // 为什么不再让模型裁决：实测 31 格长墙场景下，代码给出了完全正确的
    // `next_step=north_east` / `path_length=31`，而模型连续 14 次否决它、改选 west/east，
    // 把丧尸按在原地 20 秒横跳（净位移 1.4 格）。题面里「除非有更好理由」那句话
    // 对模型来说是**开门**：它认为「离玩家更近半步」就是更好的理由，而它看不到
    // 「这是唯一出路」——那正是本层要用代码补的信息。
    // ⇒ 规划可达时**不发请求**：方向由代码决定，省钱、零延迟、且不受模型否决。
    // ══════════════════════════════════════════════════════════════════════════════
    if (plannedDir !== null) {
      const vec = DIRECTION_VECTORS[plannedDir];
      if (vec) {
        const len = Math.hypot(vec[0], vec[1]);
        // dr = z 增量，dc = x 增量（与 DIRECTION_VECTORS 同序）
        this._stats.decided++;
        this._nextAt.set(z.id, nowMs);
        this._onDecision(z.id, {
          vx: (vec[1] / len) * this.speed,
          vz: (vec[0] / len) * this.speed,
          mode: 'chasing',
        });
        return;
      }
    }

    // ---- 寻路不可达（truncated / 半径外）：回落到 v1 的模型决策 ----
    const state = buildJevState(this.world, z.position, playerPosition, mem, plan);
    const candidateSteps = state.candidate_steps;
    // 死胡同判定（代码侧，spec §3.4）：本格除来路外无出口 → 标记。
    // ⚠️ **不要求模型自己发现死胡同** —— 代码能算的不要问模型（spec §2.2 的结论）。
    if (Object.keys(candidateSteps).length === 0) {
      markDeadEnd(mem, z.position[0], z.position[2]);
      // 四面皆墙：不发请求（一分额度都不该烧），交给离线路径输出 blocked
      this._nextAt.set(z.id, nowMs + JEV_AI.decisionPeriodMs);
      this._onFallback(z.id, 'no-candidates');
      return;
    }
    const questions = buildQuestions(candidateSteps);
    if (Object.keys(questions).length === 0) {
      this._nextAt.set(z.id, nowMs + JEV_AI.decisionPeriodMs);
      this._onFallback(z.id, 'no-candidates');
      return;
    }

    this._inflight.set(z.id, { startedAt: nowMs });
    const res = await this.client.request({ state, questions });
    this._inflight.delete(z.id);
    // ⚠️ **等待期间的关闭必须作废这次回包**：`setEnabled(false)` 会清 `_inflight`，但已经
    // 发出的请求仍会 return —— 不拦的话关掉开关后还会被在线方向驱动约 400ms（直到下一次
    // 离线回包）。判据用 `enabled` 而不是 `_inflight.has(id)`（后者已被 setEnabled 清空）。
    if (!this.enabled) return;
    // 周期从**回包**算起（见文件头口径 ①）
    this._nextAt.set(z.id, this._now() + JEV_AI.decisionPeriodMs);
    if (!res.ok) {
      this._stats.failed++;
      this._stats.lastReason = res.reason;
      this.breaker.recordFailure(res.reason, this._now());
      this._onFallback(z.id, res.reason);
      return;
    }
    this.breaker.recordSuccess();
    const parsed = parseDirectionChoice(res.answer, candidateSteps);
    if (!parsed.ok) {
      this._stats.failed++;
      this._stats.lastReason = parsed.reason;
      try { this._log.warn(`[zombie-ai] ${parsed.reason} id=${z.id}`); } catch { /* ignore */ }
      this._onFallback(z.id, parsed.reason);
      return;
    }
    this._stats.decided++;
    mem.lastDecision = { vx: parsed.vx, vz: parsed.vz, at: nowMs };
    this._onDecision(z.id, {
      vx: parsed.vx * this.speed, vz: parsed.vz * this.speed, mode: 'chasing',
    });
  }

  /** @returns {{inflight: number, decided: number, failed: number, lastReason: string, memorySize: number}} 只读测试钩子 */
  debugState() {
    return {
      inflight: this._inflight.size,
      decided: this._stats.decided,
      failed: this._stats.failed,
      lastReason: this._stats.lastReason,
      memorySize: this._memory.size,
      pathCache: this._pathCache.debugState(),
    };
  }
}
