// src/render/audio-manager.js — 用户手势安全的音频（M4 规格 §4.4）
// 只在主线程运行（依赖 three Audio/AudioListener）。首次 canvas pointerdown 或键盘动作
// 调用 unlock()，在用户手势内恢复 AudioContext。
// play() 无论 context 是否可播都先递增只读的播放请求计数（供测试验证效果事件），
// 只有 buffer 已加载且 context 已 running 才创建/复用 THREE.Audio；不用定时器清理，
// 使用 source.onended 归还实例。不订阅 Worker 消息，不把解码后的音频放进存档。
import * as THREE from 'three';

/**
 * 预加载的音效 id（与 weapon-catalog 的 sound 字段一致）。
 * M7 追加 `put` —— 玩家放置巢穴成功的音效（mc-lite `src/assets/sound/put.mp3`）。
 * M8 追加 `explosion` —— TNT 爆炸音效（mc-lite 同名文件，音量 0.4，
 * 出处 `PlayerInteraction.js:673`）。
 * M8 追加 `turret_gun_fire` —— 炮塔开火音效（mc-lite `TurretManager.js:148`，音量 0.25）。
 */
const SOUND_IDS = ['gun_load', 'gun_fire', 'mag7_fire', 'minigun_fire', 'put', 'explosion',
  'turret_gun_fire'];

/**
 * 背景音乐（v1.63）。**与 SOUND_IDS 分开两份清单**：语义不同 —— 效果音是「事件触发、播完即止」，
 * 音乐是「循环、可开关、需跨手势与解码两个异步条件对齐」。混进 SOUND_IDS 会让 `play(id)`
 * 也能播它（一次射击音效换成 254 秒循环音乐），且 `preload()` 的语义不再单一。
 *
 * 出处均为 mc-lite：`Player.js:296` `audioManager.playBGM('bgm', 0.15)`（音量为上游原值，
 * 不改成本仓 `settings.volume` —— 那是全局音效档，本改动不接）。
 */
const BGM_ID = 'bgm';
const BGM_VOLUME = 0.15;

export class AudioManager {
  /**
   * @param {THREE.Camera} camera 安装唯一 AudioListener 的相机
   * @param {{loadBuffer?: (id: string) => Promise<AudioBuffer>, bgmEnabled?: boolean}} [opts]
   *   `loadBuffer` 测试可注入替换解码；`bgmEnabled` 初始开关（对齐 `settings.bgm`，默认开）
   */
  constructor(camera, { loadBuffer, bgmEnabled = true } = {}) {
    this.camera = camera;
    this.listener = new THREE.AudioListener();
    camera.add(this.listener);
    /** @type {Map<string, THREE.AudioBuffer>} */
    this._buffers = new Map();
    /** @type {Map<string, number>} 只读播放请求计数 */
    this._counts = new Map();
    /** @type {Map<string, THREE.Audio>} 复用的 Audio 实例 */
    this._voices = new Map();
    this._loadBuffer = loadBuffer; // 测试注入的解码函数
    this._unlocked = false;
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
   * 从 /assets/sounds/<id>.mp3 加载并解码；只接受 catalog（SOUND_IDS + BGM_ID）里的 id。
   * BGM 一并预载（4MB / 254 秒，与效果音同一解码路径）；解码完会尝试起播一次 ——
   * 若此时玩家手势（`unlock`）还没到，由 `unlock()` 补上另一半条件。
   */
  async preload(ids = [...SOUND_IDS, BGM_ID]) {
    await Promise.all(ids.map(async (id) => {
      if (id !== BGM_ID && !SOUND_IDS.includes(id)) return;
      try {
        const buffer = this._loadBuffer
          ? await this._loadBuffer(id)
          : await this._decodeFromUrl(`/assets/sounds/${id}.mp3`);
        this._buffers.set(id, buffer);
      } catch (err) {
        console.warn(`[audio] preload ${id} failed:`, err);
      }
    }));
    this._syncMusic();
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
    if (this._unlocked) this._syncMusic(); // 手势到位 → 若 buffer 已就绪则起播
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

  /**
   * 只读音乐诊断状态。**存在理由与 `playRequests` 相同**：无头环境没有音频输出，
   * 「是否真的出声」不可断言；断言必须落在可观测的状态机上（意图 / 缓冲 / 手势）。
   */
  debugMusicState() {
    return {
      enabled: this._musicWanted,
      playing: this.musicPlaying,
      decoded: this._buffers.has(BGM_ID),
      unlocked: this._unlocked,
      volume: BGM_VOLUME,
    };
  }

  /** 条件对齐：想听 ∧ 已解码 ∧ context running ∧ 未在播 → 起播；否则该停的停。 */
  _syncMusic() {
    const ready = this._musicWanted && this._buffers.has(BGM_ID)
      && this.listener.context.state === 'running';
    if (!ready) {
      if (this._music?.isPlaying) this._music.stop();
      return;
    }
    if (this._music?.isPlaying) return;
    if (!this._music) this._music = new THREE.Audio(this.listener);
    this._music.setBuffer(this._buffers.get(BGM_ID));
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
    if (this._music?.isPlaying) this._music.stop();
    this._music = null;
    this.camera.remove(this.listener);
    this.listener.context.close?.();
    this._buffers.clear();
    this._counts.clear();
  }
}
