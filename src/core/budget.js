// src/core/budget.js — 帧预算参数双档标定（M3-2，设计文档 §4.9「高刷适配」）
// 120Hz（8.3ms 帧间隔）：上传预算 3ms、每帧 mesh 下发 64；
// 60Hz（16.7ms 帧间隔）：上传预算 6ms、每帧 mesh 下发 128（帧间隔翻倍，预算等比放宽，
// 让 60Hz 设备的世界填充速度与 120Hz 一致）。
// 本文件无 DOM/three 强依赖（window 经参数注入），浏览器内单测可直接构造。

/** 双档冻结数值（roadmap Task M3-2；勿擅改，实测不符先停下报告） */
export const BUDGET_PROFILES = {
  high: { meshUploadBudgetMs: 3, meshDispatchPerFrame: 64 },
  low: { meshUploadBudgetMs: 6, meshDispatchPerFrame: 128 },
};

/** 判档帧数窗口（vsync 量化下 120 帧足够；快帧比例判据不受负载 burst 影响） */
const DETECT_FRAMES = 120;
/** 快帧分界（ms）：帧间隔 < 11ms 只可能来自 ≥120Hz 的 vsync（60Hz 最小间隔 16.7ms） */
const FAST_FRAME_MS = 11;
/** 窗口内快帧 ≥ 5% → high；快帧 = 0 → low；(0, 5%) 模糊 → 重测（有界） */
const HIGH_FAST_RATIO = 0.05;

/**
 * 静态检测刷新率提示（roadmap 口径：matchMedia('(min-refresh-rate: 120hz)')）。
 * 注意：Chromium 未实现该 media feature（恒 false，false 不可信），Firefox 支持；
 * 返回 null 表示「无法静态判定」，由 BudgetConfig 的运行时帧间隔测量兜底。
 * @param {Pick<Window, 'matchMedia'>} [win]
 * @returns {'high'|null}
 */
export function detectRefreshHint(win = globalThis) {
  if (!win.matchMedia) return null;
  try {
    return win.matchMedia('(min-refresh-rate: 120hz)').matches ? 'high' : null;
  } catch {
    return null;
  }
}

/**
 * 帧预算配置：auto 档先信静态检测，否则运行时测量 rAF 帧间隔中位数，
 * 判档一次后锁定（防震荡）。设置面板/URL 可显式覆盖（'high'/'low'）。
 */
export class BudgetConfig {
  /**
   * @param {Object} [opts]
   * @param {'auto'|'high'|'low'} [opts.profile] 显式档位；'auto' 走检测+测量
   * @param {'high'|null} [opts.hint] 静态检测提示（缺省调 detectRefreshHint）
   */
  constructor({ profile = 'auto', hint = detectRefreshHint() } = {}) {
    this.profile = profile;
    this.hint = hint;
    /** 判定结果：'high'/'low'；auto 未定档时为 'pending'（预算按 high 口径先行） */
    this.resolved = profile !== 'auto' ? profile : (hint || 'pending');
    /** @type {number[]|null} 帧间隔样本（判档后释放） */
    this._samples = this.resolved === 'pending' ? { n: 0, fast: 0 } : null;
    /** 每帧最多**上传**（发布到 BatchedMesh）的 section 数；0 = 不限。
     *  与 `meshDispatchPerFrame`（每帧下发 mesh 任务给 Worker）是两件事，别混。
     *
     *  ⚠️ 这是**观感旋钮，不是性能旋钮**（2026-10-27 实测）：默认 0 时一波 5 帧就把
     *  816 个 section 全部发布 → 玩家看到「一大片同时冒出来」；限到 2 时每 100ms 只出现
     *  约 26 个 section，地形像「一格一格长出来」。**两者帧时完全一样**
     *  （p95 9.1~9.2 / 稳定 120fps），因为上传耗时本来就不是尖峰来源（实测 p95 ≤0.2ms）。
     *  代价（实测 600 帧飞行后停下）：0 → 队列清空；2 → 剩 698 个 section 未发布。
     *  故默认 0（不牺牲加载时长），需要「错开出现」观感时用 `?chunkpace=N` 调低。 */
    this.meshUploadPerFrameLimit = 0;
    this._apply();
  }

  _apply() {
    const p = BUDGET_PROFILES[this.resolved === 'pending' ? 'high' : this.resolved];
    this.meshUploadBudgetMs = p.meshUploadBudgetMs;
    this.meshDispatchPerFrame = p.meshDispatchPerFrame;
    // ⚠️ `meshUploadPerFrameLimit` **刻意不在这里赋值** —— 它不是刷新率档位标定值，
    // 而是玩家可调的观感旋钮（`settings.chunkPace` → Game 构造时写入）。写成 profile
    // 字段会被 `_apply()` 在首次判档时覆写回默认值（实测：?chunkpace=4 完全不生效）。
  }

  /** 设置面板/URL 手动覆盖（M3-4 接线）；'auto' 恢复自动判定（重新测量） */
  setProfile(profile) {
    this.profile = profile;
    if (profile === 'auto') {
      this.resolved = this.hint || 'pending';
      this._samples = this.resolved === 'pending' ? { n: 0, fast: 0 } : null;
    } else {
      this.resolved = profile;
      this._samples = null;
    }
    this._apply();
  }

  /**
   * 每帧喂入原始 rAF 帧间隔（未钳制 dt，vsync 量化值正是测量对象）。
   * 显式档位或已判档 → no-op。判据 = 快帧（<11ms）比例而非中位数：
   * 60Hz 设备物理上产生不了 <11ms 的间隔，而 120Hz 设备在重负载下帧间隔也只是
   * 量化到 16.7/25ms（8.33 的倍数），偶发快帧仍会出现——中位数会被启动 burst
   * 整窗污染误判 low（实测教训），快帧比例不会。
   * 窗口满 DETECT_FRAMES 后：快帧 ≥5% → high；快帧 = 0 → low；模糊清空重测（有界）。
   * @param {number} frameMs
   */
  observeFrame(frameMs) {
    if (!this._samples) return;
    if (!(frameMs > 0) || frameMs > 200) return; // 首帧/后台切回等异常样本丢弃
    if (frameMs < FAST_FRAME_MS) this._samples.fast++;
    this._samples.n++;
    if (this._samples.n < DETECT_FRAMES) return;
    const ratio = this._samples.fast / this._samples.n;
    if (ratio >= HIGH_FAST_RATIO) { this.resolved = 'high'; this._samples = null; this._apply(); }
    else if (this._samples.fast === 0) { this.resolved = 'low'; this._samples = null; this._apply(); }
    else this._samples = { n: 0, fast: 0 }; // 模糊区：重新累积（有界）
  }

  snapshot() {
    return {
      profile: this.profile,
      resolved: this.resolved,
      meshUploadBudgetMs: this.meshUploadBudgetMs,
      meshDispatchPerFrame: this.meshDispatchPerFrame,
    };
  }
}
