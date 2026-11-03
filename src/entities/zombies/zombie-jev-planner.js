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
  buildCandidateSteps, buildJevState, markDeadEnd, memoryFor, noteVisit, parseDirectionChoice,
} from './zombie-ai-view.js';
import { buildQuestions } from './zombie-jev-prompts.js';

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
    }
  }

  /** 回收某只丧尸的记忆（死亡 / column 卸载 / dispose 三条 slot 回收路径共用一个入口） */
  resetMemory(id) {
    this._memory.delete(id);
    this._nextAt.delete(id);
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

  /** 发起一次决策（异步，不阻塞 tick） */
  async _dispatch(z, nowMs) {
    const mem = memoryFor(this._memory, z.id);
    const playerPosition = z.playerPosition ?? z.position;
    noteVisit(mem, z.position[0], z.position[2]);

    const state = buildJevState(this.world, z.position, playerPosition, mem);
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
    };
  }
}
