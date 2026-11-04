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
import { SOUND_IDS, BGM_TRACKS, BGM_VOLUME, pickBgmTrack } from './audio-config.js';

// 再导出供既有 import 路径（`test-bgm.js` 等）继续工作 —— 只是一层转发，不是第二份定义。
export { SOUND_IDS, BGM_TRACKS, BGM_VOLUME, pickBgmTrack };

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
    /** @type {Map<string, THREE.Audio>} 复用的 Audio 实例 */
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
          : await this._decodeFromUrl(`${SOUND_DIR}/${id}.mp3`);
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
   */
  debugMusicState() {
    return {
      enabled: this._musicWanted,
      playing: this.musicPlaying,
      decoded: this._buffers.has(this._bgmTrack),
      unlocked: this._unlocked,
      volume: BGM_VOLUME,
      track: this._bgmTrack,
    };
  }

  /** 条件对齐：想听 ∧ 已解码 ∧ context running ∧ 未在播 → 起播；否则该停的停。 */
  _syncMusic() {
    const ready = this._musicWanted && this._buffers.has(this._bgmTrack)
      && this.listener.context.state === 'running';
    if (!ready) {
      if (this._music?.isPlaying) this._music.stop();
      return;
    }
    if (this._music?.isPlaying) return;
    if (!this._music) this._music = new THREE.Audio(this.listener);
    this._music.setBuffer(this._buffers.get(this._bgmTrack));
    this._music.setLoop(true); // 循环播放（mc-lite playBGM 同语义）
    this._music.setVolume(BGM_VOLUME);
    this._music.play();
  }

  /**
   * 播放音效。无论能否出声都递增播放请求计数（测试以此断言效果事件，
   * 不以操作系统是否允许出声作为断言）。
   * @param {string} id @param {number} volume @returns {boolean} 是否实际出声
   */
  play(id, volume = 1) {
    this._counts.set(id, (this._counts.get(id) ?? 0) + 1);
    const buffer = this._buffers.get(id);
    if (!buffer || this.listener.context.state !== 'running') return false;
    let voice = this._voices.get(id);
    if (!voice) {
      voice = new THREE.Audio(this.listener);
      voice.setBuffer(buffer);
      voice.onEnded = () => { /* THREE.Audio 内部处理 isPlaying 复位 */ };
      this._voices.set(id, voice);
    }
    if (voice.isPlaying) voice.stop();
    voice.setVolume(volume);
    voice.play();
    return true;
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
    for (const voice of this._voices.values()) {
      if (voice.isPlaying) voice.stop();
    }
    this._voices.clear();
    for (const entry of this._loops.values()) {
      if (entry.audio?.isPlaying) entry.audio.stop();
    }
    this._loops.clear();
    if (this._music?.isPlaying) this._music.stop();
    this._music = null;
    this.camera.remove(this.listener);
    this.listener.context.close?.();
    this._buffers.clear();
    this._counts.clear();
  }
}
