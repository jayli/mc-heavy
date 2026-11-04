// src/render/audio-config.js — 音频素材清单（three-free，可被 node 侧门禁 import）
//
// **为什么单独一个模块**：`audio-manager.js` 依赖 three（`THREE.Audio`/`AudioListener`），
// 而 `tools/check-data.mjs` 要在 Node 里断言「清单里每个 id 都有对应 mp3」。node 解析不了
// 浏览器的 import map（`three` 裸包名），整条门禁会因 import 失败而根本不跑。
// 与 `sky-config.js`（立方图清单）/ `pixel-ratio.js`（分辨率档位）同一手法：
// **清单放 three-free 模块，消费端 import 它**（红线 1：只有一份清单词）。
//
// ⚠️ 加新音效时**只改这里**：`SOUND_IDS` 是唯一权威，`audio-manager.js` 与 `check:data`
// 都从它派生（在门禁里另写一份 id 列表就是第二份权威，改了代码而忘改门禁时它仍然全绿）。

/**
 * 预加载的效果音 id（与 `weapon-catalog` 的 sound 字段一致）。
 * M7 追加 `put` —— 放置成功的音效（mc-lite `src/assets/sound/put.mp3`）。
 * M8 追加 `explosion`（音量 0.4，出处 `PlayerInteraction.js:673`）与
 *   `turret_gun_fire`（`TurretManager.js:148`，音量 0.25）。
 * v2.51 追加环境/动作音（用户 2026-11-04 需求，出处均为 mc-lite
 *   `AudioManager.initializeAudio` 的预载清单）：
 *   `delete` — 挖掉方块的音效（mc-lite 侧文件名为 `delete_get.mp3`，本仓入库去掉 `_get` 后缀）；
 *   `rain` — 雨声（**循环**，仅在 `weather.intensity > 0` 时播）；
 *   `running_land` / `running_water` — 跑动脚步声（**循环**，陆地/水中两套，
 *      mc-lite `PlayerInteraction.js:891-915` 的 `playSound(..., 0.2|0.25, true)`）；
 *   `z_die` — 丧尸/火龙被消灭（mc-lite `TurretManager.js:286` 的 `playSound('z_die', 0.3)`）。
 *
 * ⚠️ **循环类音效（rain / running_*）也在这份清单里**：`play()` 的语义（事件触发、播完即止）
 * 不变，循环走独立的 `playLoop()` / `stopLoop()`。与 BGM 分成两份清单的理由是**生命周期**，
 * 不是「能否循环」（BGM 是单槽 + 开关意图 + 跨手势对齐，循环效果音是事件驱动的短生命）。
 */
export const SOUND_IDS = Object.freeze(['gun_load', 'gun_fire', 'mag7_fire', 'minigun_fire',
  'put', 'explosion', 'turret_gun_fire', 'delete', 'rain', 'running_land', 'running_water',
  'z_die']);

/**
 * 背景音乐池（v2.51，用户 2026-11-04：「bgm 在刷新出来的时候随机选择，
 * bgm.mp3 bgm2.mp3 和 bgm3.mp3」）。
 *
 * ⚠️ **只预载抽中的那一首**，不是全部：三首合计约 16MB（4.0 + 5.4 + 6.8 MB），
 * 全量预载会把首屏流量翻 4 倍，而一次游戏只会播其中一首。
 * ⚠️ 抽签在**构造期**做一次（不是每次起播），否则「关了再开」会换歌 ——
 * 用户要的是「这次刷新听哪首」，不是「每首歌轮播」。
 */
export const BGM_TRACKS = Object.freeze(['bgm', 'bgm2', 'bgm3']);

/**
 * 背景音乐音量（mc-lite `Player.js:296` 的 `playBGM('bgm', 0.15)` 原值）。
 * 不接 `settings.volume` —— 那是全局音效档，本仓既有口径就是音乐固定 0.15。
 */
export const BGM_VOLUME = 0.15;

/**
 * 从音乐池里抽一首（纯函数，供单测直接验证边界）。
 *
 * 用 `Math.floor(r * n)` 而**不是**位运算：`rng` 返回的是 [0,1) 浮点，`r & 3` 恒为 0
 * （CLAUDE.md「seededRandom 返回浮点：取整用 Math.floor」的同一个坑）。
 * 同时把 r 钳在 [0,1)：注入值恰为 1.0 时 `Math.floor(1.0 * 3) === 3` 会越界取到 `undefined`，
 * 而 `undefined` 在消费端会被静默当成「没指定」→ 回落成随机（缺陷形态是「测试按 1.0 注入
 * 仍拿到合法曲目」，看着对但走的不是被测分支）。
 *
 * @param {() => number} [rng] [0,1) 随机源，默认 Math.random
 * @returns {string} BGM id
 */
export function pickBgmTrack(rng = Math.random) {
  const r = Math.min(Math.max(rng(), 0), 0.999999);
  return BGM_TRACKS[Math.floor(r * BGM_TRACKS.length)];
}
