// src/entities/zombies/zombie-jev-client.js — 在线 AI 的 HTTP 客户端（**唯一联网点**）
//
// 同构层：无 DOM、无 three、不自建 Worker。世界数据的唯一权威在主线程（红线 1），
// 而 HTTP 本身就是异步 IO —— 不需要 Worker，也不该为它新开一个。
//
// ## 三条载荷性约定
//
// ① **永不 reject**：调用方只处理返回值。抛异常会穿到帧循环（`setAnimationLoop` 回调）
//    → 整个游戏停摆。故所有路径都收敛成 `{ok:false, reason}`。
// ② **`not-json` 与「没有答案」是两件事**：js-perf.cn 前面的安全网关会**间歇性**返回一段
//    HTML（实测同一分钟内可能 5 次 403 后连续 200）。把它读成「模型没给方向」会让丧尸
//    静默停住 —— 这是 spec §3.8 明确点名的失败形态。
// ③ **每个失败都打 log**（用户 2026-11-03 明确要求便于排查），格式固定
//    `[zombie-ai] <reason>` 便于 grep。
import { JEV_AI } from './zombie-config.js';
import { QUESTION_ID } from './zombie-jev-prompts.js';

export class JevClient {
  /**
   * @param {{endpoint?: string, timeoutMs?: number, model?: string,
   *          fetchImpl?: Function, log?: {warn: Function, info?: Function}}} [opts]
   *   `fetchImpl` / `log` 可注入 —— 单测不联网、不污染真实 console。
   */
  constructor({ endpoint = JEV_AI.endpoint, timeoutMs = JEV_AI.timeoutMs,
    model = 'jev-latest', fetchImpl = null, log = null } = {}) {
    this.endpoint = endpoint;
    this.timeoutMs = timeoutMs;
    this.model = model;
    this._fetch = fetchImpl ?? ((...a) => globalThis.fetch(...a));
    this._log = log ?? ((typeof console !== 'undefined') ? console : { warn() {} });
  }

  /**
   * 发一次请求。**永不 reject。**
   * @param {{state: object, questions: object}} req
   * @returns {Promise<{ok: true, answer: object, model: string}|{ok: false, reason: string}>}
   */
  async request({ state, questions }) {
    // 无题目就不发（四面围墙时 buildQuestions 返回 {}）—— 一分额度都不该烧
    if (!questions || Object.keys(questions).length === 0) return this._fail('no-answer');
    // ⚠️ 通过 globalThis 取（不是裸 `AbortController`）：本仓 ESLint 的 globals 未声明浏览器
    // 全局，裸引用会报 `no-undef`；而 `entities/` 是同构层，本就不能假定 DOM 存在。
    const Abort = globalThis.AbortController;
    const ctl = typeof Abort === 'function' ? new Abort() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), this.timeoutMs) : null;
    let res;
    let text;
    try {
      res = await this._fetch(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.model, state, questions }),
        ...(ctl ? { signal: ctl.signal } : {}),
      });
      text = await res.text();
    } catch (e) {
      const aborted = e && (e.name === 'AbortError' || /abort/i.test(String(e.message ?? '')));
      return this._fail(aborted ? 'timeout' : 'network-error');
    } finally {
      if (timer) clearTimeout(timer);
    }
    let json = null;
    try { json = JSON.parse(text); } catch { json = null; }
    // ⚠️ 解析失败优先判 not-json（哪怕状态码是 200/403）—— 网关拦截页正是这个形状
    if (json === null) return this._fail('not-json');
    if (!res.ok) return this._fail(`http-${res.status}`);
    const answer = json?.answers?.[QUESTION_ID];
    if (!answer) return this._fail('no-answer');
    return { ok: true, answer, model: typeof json.model === 'string' ? json.model : '' };
  }

  _fail(reason) {
    try { this._log.warn(`[zombie-ai] ${reason}`); } catch { /* 日志失败不得影响主流程 */ }
    return { ok: false, reason };
  }
}

/** 便捷工厂（Game 装配用） */
export function createJevClient(opts) {
  return new JevClient(opts);
}

/**
 * 失败熔断（spec §3.8：连续 `maxFailures` 次失败 → 整体暂停 `cooldownMs`）。
 *
 * **为什么需要**：单次超时 4s。若网关持续拦截，20 只丧尸 × 4 并发会一直堆着 4s 的挂起请求，
 * 帧循环里的 `tick` 也会一直空转。熔断把它们整体切回离线 AI，30 秒后再试。
 *
 * ⚠️ **`recordSuccess()` 清零**是载荷性的：网关是**间歇性**拦截的（实测同一分钟内 5 次 403
 * 之后连续 200）。改成「滑窗计数」会让长期跑图的人被零星失败拖进冷却。
 * ⚠️ **冷却期内的失败不再累计、也不延长冷却**：否则每个在途请求回来都会顺延 30 秒，
 * 熔断永远不解除。
 */
export class FailureBreaker {
  constructor({ maxFailures = JEV_AI.maxFailures, cooldownMs = JEV_AI.cooldownMs,
    now = () => Date.now(), log = null } = {}) {
    this.maxFailures = maxFailures;
    this.cooldownMs = cooldownMs;
    this._now = now;
    this._log = log ?? ((typeof console !== 'undefined') ? console : { warn() {}, info() {} });
    this.fails = 0;
    this.openUntil = 0;
  }

  available(nowMs = this._now()) {
    return nowMs >= this.openUntil;
  }

  recordFailure(reason, nowMs = this._now()) {
    if (!this.available(nowMs)) return;
    this.fails++;
    if (this.fails >= this.maxFailures) {
      this.openUntil = nowMs + this.cooldownMs;
      this.fails = 0;
      try {
        this._log.warn(`[zombie-ai] suspended for ${this.cooldownMs}ms after ${this.maxFailures} failures (last: ${reason})`);
      } catch { /* ignore */ }
    }
  }

  recordSuccess() {
    if (this.fails !== 0) {
      this.fails = 0;
      try { (this._log.info ?? this._log.warn)('[zombie-ai] resumed'); } catch { /* ignore */ }
    }
  }

  /** @returns {{fails: number, openUntil: number, suspended: boolean}} 只读测试钩子 */
  state() {
    return { fails: this.fails, openUntil: this.openUntil, suspended: !this.available() };
  }
}
