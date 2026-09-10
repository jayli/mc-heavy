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
 */
const SOUND_IDS = ['gun_load', 'gun_fire', 'mag7_fire', 'minigun_fire', 'put'];

export class AudioManager {
  /**
   * @param {THREE.Camera} camera 安装唯一 AudioListener 的相机
   * @param {{loadBuffer?: (id: string) => Promise<AudioBuffer>}} [opts] 测试可注入替换解码
   */
  constructor(camera, { loadBuffer } = {}) {
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
  }

  /** 从 /assets/sounds/<id>.mp3 加载并解码；只接受 catalog（SOUND_IDS）里的 id。 */
  async preload(ids = SOUND_IDS) {
    await Promise.all(ids.map(async (id) => {
      if (!SOUND_IDS.includes(id)) return;
      try {
        const buffer = this._loadBuffer
          ? await this._loadBuffer(id)
          : await this._decodeFromUrl(`/assets/sounds/${id}.mp3`);
        this._buffers.set(id, buffer);
      } catch (err) {
        console.warn(`[audio] preload ${id} failed:`, err);
      }
    }));
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
    return this._unlocked;
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
    this.camera.remove(this.listener);
    this.listener.context.close?.();
    this._buffers.clear();
    this._counts.clear();
  }
}
