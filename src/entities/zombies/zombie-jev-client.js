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
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
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
