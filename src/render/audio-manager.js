// src/render/audio-manager.js — 用户手势安全的音频（M4 规格 §4.4）
// 只在主线程运行（依赖 three Audio/AudioListener）。首次 canvas pointerdown 或键盘动作
// 调用 unlock()，在用户手势内恢复 AudioContext。
// play() 无论 context 是否可播都先递增只读的播放请求计数（供测试验证效果事件），
// 只有 buffer 已加载且 context 已 running 才创建/复用 THREE.Audio；不用定时器清理，
// 使用 source.onended 归还实例。不订阅 Worker 消息，不把解码后的音频放进存档。
import * as THREE from 'three';
import { resourceUrl } from '../core/resource-url.js';
// 清单/常量/纯函数的**唯一权威**在 `audio-config.js`（three-free）：
// `check:data` 在 Node 里 import 它（node 解析不了 `three` 裸包名，放本文件会让门禁根本不跑）。
import {
  SOUND_IDS, BGM_TRACKS, BGM_VOLUME, pickBgmTrack,
  soundFileName, BOSS_BGM_TRACK, BOSS_BGM_FADE_MS,
  SOUND_VOICE_LIMITS, DEFAULT_SOUND_VOICES,
} from './audio-config.js';

// 再导出供既有 import 路径（`test-bgm.js` 等）继续工作 —— 只是一层转发，不是第二份定义。
export {
  SOUND_IDS, BGM_TRACKS, BGM_VOLUME, pickBgmTrack,
  soundFileName, BOSS_BGM_TRACK, BOSS_BGM_FADE_MS,
  SOUND_VOICE_LIMITS, DEFAULT_SOUND_VOICES,
};

/**
 * 音频目录（仓库相对路径 → 绝对 URL）。
 *
 * v1.87：旧写法是站点根绝对路径 `/assets/sounds/${id}.mp3` —— 仓库挂子路径部署时全部 404
 * （音效与背景音乐都静默无声，控制台只有 warn）。转换放在唯一消费点 `preload()` 内，
 * 不改 `_decodeFromUrl` 的无状态语义。
 */
const SOUND_DIR = resourceUrl('assets/sounds');

export class AudioManager {
  /**
   * @param {THREE.Camera} camera 安装唯一 AudioListener 的相机
   * @param {{loadBuffer?: (id: string) => Promise<AudioBuffer>, bgmEnabled?: boolean,
   *          rng?: () => number, bgmTrack?: string}} [opts]
   *   `loadBuffer` 测试可注入替换解码；`bgmEnabled` 初始开关（对齐 `settings.bgm`，默认开）；
   *   `rng` 音乐随机源的注入点（测试给确定性值）；`bgmTrack` 直接指定曲目（优先级最高，
   *   E2E/单测需要确定性时用）。
   */
  constructor(camera, { loadBuffer, bgmEnabled = true, rng = Math.random, bgmTrack } = {}) {
    this.camera = camera;
    this.listener = new THREE.AudioListener();
    camera.add(this.listener);
    /** @type {Map<string, THREE.AudioBuffer>} */
    this._buffers = new Map();
    /** @type {Map<string, number>} 只读播放请求计数 */
    this._counts = new Map();
    /**
     * @type {Map<string, THREE.Audio[]>} 一次性音效的声道池（每 id 一组）。
     *
     * ⚠️⚠️ **旧实现是 `Map<string, THREE.Audio>` 单槽 + 同名再播先 stop**
     *（用户 2026-11-25：「soldier 射击的声音有时候滞后发出…我不要队列」）：
     * 实测 3 只士兵 6s 内 47 次开火，**46 次把上一声打断重播** ⇒ 素材 0.519s
     * 而发间隔 0.105s，每一声只响 0.1s。现在是多声道：未满就新开一路，
     * **满了就丢弃**（不排队、不打断、不补发）。声道上限权威在 `SOUND_VOICE_LIMITS`。
     * ⚠️ 缺省 1 声道的 id 行为逐位回到旧实现（stop + 重播），既有听感零回归。
     */
    this._voices = new Map();
    /** @type {Map<string, THREE.Audio>} 循环音效实例（rain / running_*），与 `_voices` 分开 */
    this._loops = new Map();
    this._loadBuffer = loadBuffer; // 测试注入的解码函数
    this._unlocked = false;
    /**
     * 本次会话的背景音乐曲目（构造期抽一次，刷新页面才变）。
     * `bgmTrack` 显式传入时优先，否则按 `rng` 抽。
     * @type {string}
     */
    this._bgmTrack = BGM_TRACKS.includes(bgmTrack) ? bgmTrack : pickBgmTrack(rng);
    /** @type {THREE.Audio|null} BGM 循环实例（单槽，与 `_voices` 分开：不参与效果音回收） */
    this._music = null;
    /**
     * 玩家意图（设置项）。**与 `musicPlaying` 是两件事**：这里只是「想不想听」，
     * 真正出声还要 buffer 解码完（`preload` 异步）且 AudioContext 已 running（用户手势）。
     * @type {boolean}
     */
    this._musicWanted = bgmEnabled;

    // ---- v2.64：Boss 战 BGM 交叉淡化（用户 2026-11-07）----
    /**
     * Boss 战音乐槽（与普通曲 `_music` 分开的第二个单槽）。
     * 交叉淡化期间两槽同时在播、音量互补；淡完一侧停。
     * @type {THREE.Audio|null}
     */
    this._bossMusic = null;
    /** 「有 Boss 在场」的意图位（`setBossMusicActive` 写，帧循环的 `update` 消费） */
    this._bossWanted = false;
    /**
     * 当前混合度：0 = 全普通曲，1 = 全 boss 曲。淡变逐帧推进（`update`）。
     * 两槽音量 = `BGM_VOLUME × (1 − mix)` / `BGM_VOLUME × mix`（互补交叉）。
     * @type {number}
     */
    this._bossMix = 0;
    /** 淡变起点时刻（ms）与起点混合度；`null` = 下次 `update` 重新锚定 */
    this._fadeStartMs = null;
    this._fadeFromMix = 0;
    /** 淡变目标（0/1）；与 `_bossWanted` 分开 —— 后者是意图，前者是「已解码才算数」的目标 */
    this._fadeTarget = 0;
    /** 正在淡变（`_bossMix !== _fadeTarget`）—— 期间两槽同时在播，见 `_syncMusicSlots` 的 ⚠️ */
    this._fading = false;
    /** 上次写入各槽的音量（`null` = 需强制重写；避免稳态下每帧白调 setVolume） */
    this._normalVol = null;
    this._bossVol = null;
    /** boss 曲懒加载去重标志（4.7MB，重复 fetch 是流量事故） */
    this._bossLoading = false;
    /** boss 曲加载失败标志（失败不重试，否则断网时每帧重发请求） */
    this._bossLoadFailed = false;
  }

  /**
   * 从 `assets/sounds/<id>.mp3` 加载并解码；只接受 catalog（SOUND_IDS + BGM_TRACKS）里的 id。
   * BGM 一并预载（**只预载本次抽中的那一首**，见 `BGM_TRACKS` 注释）；解码完会尝试起播一次
   * —— 若此时玩家手势（`unlock`）还没到，由 `unlock()` 补上另一半条件。
   */
  async preload(ids = [...SOUND_IDS, this._bgmTrack]) {
    await Promise.all(ids.map(async (id) => {
      if (!BGM_TRACKS.includes(id) && !SOUND_IDS.includes(id)) return;
      try {
        const buffer = this._loadBuffer
          ? await this._loadBuffer(id)
          // v2.64：扩展名走 `soundFileName()`（新增音效与 boss 曲是 .ogg，写死 .mp3 会 404
          // → 被下面的 catch 吞成一句 warn → **静默无声**）。
          : await this._decodeFromUrl(`${SOUND_DIR}/${soundFileName(id)}`);
        this._buffers.set(id, buffer);
      } catch (err) {
        console.warn(`[audio] preload ${id} failed:`, err);
      }
    }));
    this._syncMusic();
    this._syncLoops(); // 循环音效可能已在本函数之前就被请求（如启动即下雨）
  }

  async _decodeFromUrl(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url}: ${response.status}`);
    const arrayBuffer = await response.arrayBuffer();
    return await this.listener.context.decodeAudioData(arrayBuffer);
  }

  /**
   * 在用户手势内恢复 AudioContext。@returns {Promise<boolean>} 是否进入 running。
   */
  async unlock() {
    const ctx = this.listener.context;
    if (ctx.state === 'running') { this._unlocked = true; return true; }
    try {
      await ctx.resume();
    } catch (err) {
      console.warn('[audio] unlock failed:', err);
    }
    this._unlocked = ctx.state === 'running';
    // 手势到位 → 若 buffer 已就绪则起播。**两条都要补**：音乐与循环音效的条件相互独立
    // （前者还看设置开关，后者还看天气/跑动），不能合在一处。
    if (this._unlocked) { this._syncMusic(); this._syncLoops(); }
    return this._unlocked;
  }

  // ---- 背景音乐（v1.63）：mc-lite `AudioManager.playBGM` 的循环语义 ----

  /**
   * 开关背景音乐。关闭立即停播；开启只在**玩家手势已到 + buffer 已解码**时真的出声，
   * 否则只记意图，等 `unlock()` / `preload()` 补齐另一半条件（否则会出现
   * 「首次点击时音乐还没解码完 → 永久没声音」的静默失效）。
   * @param {boolean} enabled @returns {boolean} 当前是否真的在播
   */
  setMusicEnabled(enabled) {
    this._musicWanted = enabled === true;
    this._syncMusic();
    return this.musicPlaying;
  }

  /** 玩家的开关意图（设置项口径） */
  get musicEnabled() { return this._musicWanted; }

  /** 是否真的在出声（意图 ∧ 已解码 ∧ 已解锁） */
  get musicPlaying() { return (this._music?.isPlaying ?? false) === true; }

  /** 本次会话的背景音乐曲目 id（`bgm` / `bgm2` / `bgm3`） */
  get bgmTrack() { return this._bgmTrack; }

  /**
   * 只读音乐诊断状态。**存在理由与 `playRequests` 相同**：无头环境没有音频输出，
   * 「是否真的出声」不可断言；断言必须落在可观测的状态机上（意图 / 缓冲 / 手势）。
   *
   * v2.64 增 `boss` 子对象（Boss 战曲的意图 / 是否在播 / 是否已解码 / 当前混合度）：
   * 交叉淡化是逐帧推进的，无头环境听不见 —— 只能靠这四个字段断言「真的在淡」。
   */
  debugMusicState() {
    return {
      enabled: this._musicWanted,
      playing: this.musicPlaying,
      decoded: this._buffers.has(this._bgmTrack),
      unlocked: this._unlocked,
      volume: BGM_VOLUME,
      track: this._bgmTrack,
      boss: {
        wanted: this._bossWanted,
        playing: (this._bossMusic?.isPlaying ?? false) === true,
        decoded: this._buffers.has(BOSS_BGM_TRACK),
        mix: this._bossMix,
      },
    };
  }

  /**
   * 条件对齐（无帧时间戳的入口）：`preload()` / `unlock()` / `setMusicEnabled()` 调它。
   *
   * ⚠️ **不推进淡变**（没有 `nowMs` 可算差）—— 只按当前 `_bossMix` 对齐两个槽的起停与音量。
   * 逐帧推进走 `update(nowMs)`（帧循环调，同 `_syncRainSound` 手法）。
   */
  _syncMusic() { this._syncMusicSlots(); }

  // ---- v2.64：Boss 战 BGM 交叉淡化 ----

  /**
   * 置「有 Boss 在场」意图（`Game._syncBossMusic()` 每帧调，幂等）。
   *
   * 激活时**顺带发起 boss 曲的懒加载**（4.7MB，不进首屏 `preload()`）：
   * 绝大多数会话根本不召唤 Boss，预载它就是白付 4.7MB 流量。
   *
   * ⚠️ **去重两道**（`_buffers.has` + `_bossLoading`）：帧循环每帧都调本方法，
   * 少了任一道就会重复 fetch（测试钉住「只下载一次」）。
   * ⚠️ **加载失败不重试**（`_bossLoadFailed`）：否则断网/404 时每帧重发请求。
   * 失败后的行为是「普通曲继续播」—— 战斗音乐静默，但游戏照玩（与 `preload` 同口径）。
   *
   * @param {boolean} active
   */
  setBossMusicActive(active) {
    this._bossWanted = active === true;
    if (this._bossWanted) this._ensureBossBuffer();
  }

  /** Boss 战意图位（诊断用） */
  get bossMusicActive() { return this._bossWanted; }

  /** 懒加载 boss 曲（只发一次；条件未齐时由 `update()` 在 buffer 到达后自然接上淡变）。 */
  _ensureBossBuffer() {
    if (this._buffers.has(BOSS_BGM_TRACK)) return;
    if (this._bossLoading || this._bossLoadFailed) return;
    this._bossLoading = true;
    const done = (buffer) => {
      this._bossLoading = false;
      this._buffers.set(BOSS_BGM_TRACK, buffer);
      // 解码到达即对齐一次（不等下一帧）：否则「召唤后头一帧」会多播一拍普通曲。
      this._syncMusicSlots();
    };
    const fail = (err) => {
      this._bossLoading = false;
      this._bossLoadFailed = true;
      console.warn(`[audio] boss bgm 加载失败（战斗音乐将静默）:`, err);
    };
    if (this._loadBuffer) {
      // 测试注入路径：与 `preload()` 同一个钩子（否则单测会真去 fetch 4.7MB）。
      Promise.resolve(this._loadBuffer(BOSS_BGM_TRACK)).then(done, fail);
      return;
    }
    this._decodeFromUrl(`${SOUND_DIR}/${soundFileName(BOSS_BGM_TRACK)}`).then(done, fail);
  }

  /**
   * 逐帧推进交叉淡化（帧循环调，同 `_syncRainSound`）。
   *
   * **锚点式而不是逐帧累加**（与 `explosion-sprite` / `tracer` 同一理由：累加会随帧率漂移）：
   * 记住淡变起点时刻与起点混合度，每帧用 `(nowMs − start) / FADE_MS` 直接算当前值。
   * 中途反向（淡入淡到一半又全灭）时**从当前混合度重新锚定** —— 否则会跳变。
   *
   * ⚠️ **常态成本**：没召唤过 Boss 时 `target === 0 === _bossMix === _fadeTarget`，
   * 跳过全部淡变算术，只剩 `_syncMusicSlots()` 里的几个布尔判断与 Map 查询。
   *
   * @param {number} nowMs `performance.now()` 基准（**禁止 `Date.now()`**：两者相差约 17 亿
   *   毫秒，混用会让淡变进度恒为 1 → 硬切而不是渐隐）
   */
  update(nowMs) {
    // 目标混合度：boss 曲**已解码**才算数 —— 未解码时保持 0（普通曲继续播，不留静音缝）。
    const target = (this._bossWanted && this._buffers.has(BOSS_BGM_TRACK)) ? 1 : 0;
    if (this._fadeTarget !== target) {
      this._fadeTarget = target;
      this._fadeFromMix = this._bossMix;
      this._fadeStartMs = Number.isFinite(nowMs) ? nowMs : null;
    }
    if (this._bossMix !== target && this._fadeStartMs !== null && Number.isFinite(nowMs)) {
      const span = BOSS_BGM_FADE_MS > 0 ? BOSS_BGM_FADE_MS : 1;
      const p = Math.min(1, Math.max(0, (nowMs - this._fadeStartMs) / span));
      this._bossMix = p >= 1 ? target : this._fadeFromMix + (target - this._fadeFromMix) * p;
    }
    this._fading = this._bossMix !== this._fadeTarget;
    this._syncMusicSlots();
  }

  /**
   * 两个音乐槽的起停与音量对齐（唯一写 `THREE.Audio` 的地方，同 `_syncLoop` 的地位）。
   *
   * 不变式：
   *   · 玩家关音乐 / context 未 running → **两槽都停**（boss 意图在场也不得偷播）；
   *   · `mix < 1` **或正在淡变** → 普通曲在播，音量 `BGM_VOLUME × (1 − mix)`；
   *   · boss 曲已解码 ∧（意图在场 ∨ `mix > 0` ∨ 正在淡变）→ boss 槽在播，音量 `BGM_VOLUME × mix`。
   *
   * ⚠️ **「正在淡变」那一项是必需的，不是冗余**（实测踩到）：淡出的**起始帧** `mix` 恰好还是 1
   * （p=0），若只看 `mix < 1` 则普通曲那一帧仍被判停 → 淡回晚一帧才开始（单帧听不出，
   * 但「全灭后普通曲必须重新起播」的断言会红）。淡变中两槽**同时**在播、音量互补 ——
   * 这正是交叉淡化的定义；`mix` 到达端点后 `_fading` 转假，多余的那一槽才真的停。
   *
   * ⚠️ **音量只在变化时写**：`setVolume()` 内部是 `setTargetAtTime`（每次调用都重新调度一条
   * 斜坡），稳态下每帧白调一次是无谓开销 —— 与雨声循环不同（那个音量真的每帧在变）。
   */
  _syncMusicSlots() {
    const allowed = this._musicWanted && this.listener.context.state === 'running';
    const mix = this._bossMix;
    const bossReady = this._buffers.has(BOSS_BGM_TRACK);
    const fading = this._fading === true;

    // ---- 普通曲槽 ----
    const normalOn = allowed && this._buffers.has(this._bgmTrack) && (mix < 1 || fading);
    if (!normalOn) {
      if (this._music?.isPlaying) this._music.stop();
      this._normalVol = null;   // 下次起播必须重写音量（stop 不保留 gain 的意图值）
    } else {
      if (!this._music) this._music = new THREE.Audio(this.listener);
      if (!this._music.isPlaying) {
        this._music.setBuffer(this._buffers.get(this._bgmTrack));
        this._music.setLoop(true); // 循环播放（mc-lite playBGM 同语义）
        this._normalVol = null;    // 新起播：强制写一次音量
        this._music.play();
      }
      this._writeVolume(this._music, BGM_VOLUME * (1 - mix), '_normalVol');
    }

    // ---- Boss 战曲槽 ----
    const bossOn = allowed && bossReady && (this._bossWanted || mix > 0 || fading);
    if (!bossOn) {
      if (this._bossMusic?.isPlaying) this._bossMusic.stop();
      this._bossVol = null;
    } else {
      if (!this._bossMusic) this._bossMusic = new THREE.Audio(this.listener);
      if (!this._bossMusic.isPlaying) {
        this._bossMusic.setBuffer(this._buffers.get(BOSS_BGM_TRACK));
        this._bossMusic.setLoop(true);   // 战斗时长不定，必须循环
        this._bossVol = null;
        this._bossMusic.play();
      }
      this._writeVolume(this._bossMusic, BGM_VOLUME * mix, '_bossVol');
    }
  }

  /**
   * 只在目标音量与上次写入值有可闻差异时才调 `setVolume`（见 `_syncMusicSlots` 的 ⚠️）。
   * @param {THREE.Audio} audio @param {number} volume @param {string} key 记录上次值的字段名
   */
  _writeVolume(audio, volume, key) {
    const v = Math.max(0, Math.min(1, volume));
    if (this[key] !== null && Math.abs(this[key] - v) < 1e-4) return;
    this[key] = v;
    audio.setVolume(v);
  }

  /**
   * 播放一次性音效。无论能否出声都递增播放请求计数（测试以此断言效果事件，
   * 不以操作系统是否允许出声作为断言）。
   *
   * ## 声道语义（用户 2026-11-25）
   *
   * 每个 id 的并发上限 = `SOUND_VOICE_LIMITS[id] ?? DEFAULT_SOUND_VOICES`：
   *   · 未满 ⇒ **新开一路立即发声**，不碰已在播的任何一路；
   *   · 已满 ∧ 上限 > 1 ⇒ **丢弃本次**（返回 false）—— 不排队、不延迟补发、
   *     也不打断最旧那一路（用户明确要的语义）；
   *   · 已满 ∧ 上限 == 1 ⇒ **逐位回到旧实现**（stop 后重播），既有音效听感不变。
   *
   * ⚠️⚠️ **不得把丢弃改成“记下来下一帧补发”**：那就是用户说的「滞后再补发」。
   * ⚠️ **判据不能落在 `playRequests`**：它对单槽/多声道两种实现读数完全相同
   *（实测 47 vs 47）⇒ 零判别力。有判别力的是真实 `AudioBufferSourceNode` 的
   * start/stop 账（见 `test-audio-voices.js`）。
   * ⚠️ **声道归还靠 `onEnded`**（three 内部复位 `isPlaying`），不用定时器：
   * 定时器与帧不同源且页面隐藏时被节流（本仓已记的坑）。
   *
   * @param {string} id @param {number} volume @returns {boolean} 是否实际出声
   */
  play(id, volume = 1) {
    this._counts.set(id, (this._counts.get(id) ?? 0) + 1);
    const buffer = this._buffers.get(id);
    if (!buffer || this.listener.context.state !== 'running') return false;
    const cap = Math.max(1, SOUND_VOICE_LIMITS[id] ?? DEFAULT_SOUND_VOICES);
    let pool = this._voices.get(id);
    if (!pool) { pool = []; this._voices.set(id, pool); }
    // 空闲声道 = 未在播的（onEnded 已把 isPlaying 置 false）
    let voice = pool.find((v) => !v.isPlaying);
    if (!voice) {
      if (pool.length >= cap) {
        // 单声道：旧语义（同名再播重启）—— 既有音效逐位不变
        if (cap === 1) {
          voice = pool[0];
          voice.stop();
        } else {
          // 多声道已满：**丢弃**。不新建 source、不 stop 别人、不留待发队列。
          return false;
        }
      } else {
        voice = new THREE.Audio(this.listener);
        voice.setBuffer(buffer);
        pool.push(voice);
      }
    }
    voice.setVolume(volume);
    voice.play();
    return true;
  }

  /**
   * 停掉全部一次性声道（幂等）。`dispose()` 与单测 teardown 共用。
   * ⚠️ 单测不得用 `dispose()` 收尾：three 的 listener 拿全局 AudioContext 单例，
   * `context.close()` 会把全页后续用例砸掉（`test-bgm.js` 已记该实测）。
   */
  stopAllVoices() {
    for (const pool of this._voices.values()) {
      for (const voice of pool) if (voice.isPlaying) voice.stop();
    }
    this._voices.clear();
  }

  /**
   * 只读声道诊断（供 E2E / 探针）。无头环境听不到声音，断言只能落在可观测状态上。
   * @returns {Record<string, {cap:number, live:number, pooled:number}>}
   */
  debugVoices() {
    const out = {};
    for (const [id, pool] of this._voices) {
      out[id] = {
        cap: Math.max(1, SOUND_VOICE_LIMITS[id] ?? DEFAULT_SOUND_VOICES),
        live: pool.filter((v) => v.isPlaying).length,
        pooled: pool.length,
      };
    }
    return out;
  }

  // ---- 循环效果音（v2.51）：雨声 / 跑动脚步声 ----

  /**
   * 开启（或续续）一个循环音效。
   *
   * 与 `play()` 的三个关键区别（这三个都是实测过的“循环音效特有的坑”）：
   *   · **同名已在播只改音量、不重建**：脚步声每帧都会被调用（几百次/秒），
   *     每次重启会听到“哒哒哒”的断续；而雨强度淡入淡出需要连续改音量。
   *   · **不递增 `playRequests`**：那个计数是“事件发生了几次”的口径（枪击/挖块），
   *     循环音效的调用频次与游戏事件无关（每帧一次），混进去会把计数变成帧数。
   *     循环另走 `debugLoops()`（意图 / 实际在播 / 当前音量）。
   *   · **不参与 `_voices` 单槽复用**：那个槽是“同一音效内重启”，
   *     循环音效需要常驻实例，否则停一次就要重建。
   *
   * 条件未齐（buffer 未解码 / context 未 running）时**只记意图，不起播**，
   * 由 `_syncLoops()` 在 `preload()` / `unlock()` 末尾补 —— 与 BGM 同一手法，
   * 否则“进游戏第一时间就下雨”会静默无声。
   *
   * @param {string} id @param {number} volume 0..1 @returns {boolean} 是否真的在出声
   */
  playLoop(id, volume = 1) {
    const want = { volume: Math.max(0, Math.min(1, volume)) };
    const prev = this._loops.get(id);
    if (prev) {
      prev.wanted = want;
      // ⚠️ **必须重新走一遍 `_syncLoop`**：它才是把 wanted 音量写到真实 `THREE.Audio` 的
      // 唯一地方。初版这里直接 `return prev.playing` —— 雨声强度淡入淡出与脚步声换档**完全失效**
      // （循环实例一直停在第一次的音量）。
      // ⚠️ 这个缺陷当时**单测与 E2E 全绿**：断言读的是 `debugLoops().volume`（= 意图值）
      // 而不是实际音频音量 —— 典型的「断言读自己的输入」。故 `debugLoops()` 现在报实际音量。
      this._syncLoop(id);
      return prev.playing;
    }
    this._loops.set(id, { wanted: want, playing: false });
    this._syncLoop(id);
    return this._loops.get(id).playing;
  }

  /** 停止一个循环音效（幂等）。@param {string} id */
  stopLoop(id) {
    const entry = this._loops.get(id);
    if (!entry) return;
    this._loops.delete(id);
    if (entry.audio?.isPlaying) entry.audio.stop();
  }

  /**
   * 单个循环音效的条件对齐：已在播 → 只调音量；未在播 → 条件齐则起播。
   * @param {string} id
   */
  _syncLoop(id) {
    const entry = this._loops.get(id);
    if (!entry) return;
    const buffer = this._buffers.get(id);
    const running = this.listener.context.state === 'running';
    if (!buffer || !running) {
      if (entry.audio?.isPlaying) entry.audio.stop();
      entry.playing = false;
      return;
    }
    if (!entry.audio) entry.audio = new THREE.Audio(this.listener);
    // buffer / loop 只在未起播时设（已在播时再 setBuffer 无意义，且会白走一遍分支）
    if (!entry.audio.isPlaying) {
      entry.audio.setBuffer(buffer);
      entry.audio.setLoop(true);
    }
    // **音量每次都写**：雨声强度淡入淡出、陆/水脚步换档都靠这一行
    entry.audio.setVolume(entry.wanted.volume);
    if (!entry.audio.isPlaying) entry.audio.play();
    entry.playing = true;
  }

  /** 在 preload / unlock 后补齐所有循环音效（条件可能刚刚才齐）。 */
  _syncLoops() {
    for (const id of [...this._loops.keys()]) this._syncLoop(id);
  }

  /**
   * 只读循环音效诊断状态（供 E2E 断言）。
   * 口径同 `debugMusicState()`：无头环境没有音频输出，“是否真的在出声”不可断言，
   * 断言必须落在可观测的状态机上。
   *
   * ⚠️ **`volume` 必须报实际 `THREE.Audio` 的音量，不能报意图值**：v2.51 初版报
   * `entry.wanted.volume`（= 本方法自己的输入），于是“`playLoop` 重复调用没把音量写下去”
   * 这个缺陷在单测与 E2E 里**全部绿灯**。与 `block-color` /「白闪落在块心而非命中面」同类：
   * 判据必须落在最终产物上。
   *
   * 两个字段各有用途：`volume` = 真实音频音量（抓“没写下去”），`target` = 意图值
   * （抓“参数算错了”）。⚠️ 两者不能互相替代 —— 实测 `setVolume()` 走的是 Web Audio 的
   * `linearRampToValueAtTime`，`getVolume()` 读到的是**斜坡当前值**，与目标差 0.0005 量级。
   * @returns {Record<string, {playing: boolean, volume: number, target: number}>}
   */
  debugLoops() {
    const out = {};
    for (const [id, entry] of this._loops) {
      const actual = typeof entry.audio?.getVolume === 'function'
        ? entry.audio.getVolume() : entry.wanted.volume;
      out[id] = { playing: entry.playing, volume: actual, target: entry.wanted.volume };
    }
    return out;
  }

  /** @returns {ReadonlyMap<string, number>} 只读播放请求计数 */
  get playRequests() {
    return this._counts;
  }

  /** 停止 active sound、从 camera 移除 listener、清空 buffer/计数。 */
  dispose() {
    this.stopAllVoices();
    for (const entry of this._loops.values()) {
      if (entry.audio?.isPlaying) entry.audio.stop();
    }
    this._loops.clear();
    if (this._music?.isPlaying) this._music.stop();
    this._music = null;
    // v2.64：boss 战曲槽也要收（否则 dispose 后战斗曲继续响）
    if (this._bossMusic?.isPlaying) this._bossMusic.stop();
    this._bossMusic = null;
    this.camera.remove(this.listener);
    this.listener.context.close?.();
    this._buffers.clear();
    this._counts.clear();
  }
}
