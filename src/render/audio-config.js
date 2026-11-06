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
 *   `z_die` — 丧尸被消灭（mc-lite `TurretManager.js:286` 的 `playSound('z_die', 0.3)`）。
 *      ⚠️ v2.64 起**只用于丧尸**：飞龙/焰魔的死亡音改走 `ignis_die`（用户裁定，见下）。
 *
 * v2.64 追加 Boss 战与击杀音效（用户 2026-11-07 需求，出处均为 `assets/sounds/` 里已入库的
 *   `.ogg` 素材 —— **零新增美术资源**，只是把既有文件接进清单）：
 *   `ignis_die` — 焰魔 / 飞龙被消灭（用户：「焰魔死亡的音效 ignis_die.ogg，飞龙的死亡音效也是 ignis_die.ogg」）；
 *   `ignis_attack_swing` — 焰魔挥刀起手；
 *   `ignis_burn` — 焰魔 / 飞龙被召唤出来（用户：「焰魔和飞龙被创建的时候的音效」）；
 *   `ignis_hurt` — 玩家被击中（用户：「不管被谁击中，只要被击中就有这个音效」）；
 *   `ignis_jump` — 焰魔跳跃（飞跃 escape / attack 两种起跳都算）；
 *   `dragon_shout` — 飞龙空中随机叫声；
 *   `dragon_fire` — 飞龙喷火球。
 *
 * ⚠️ **循环类音效（rain / running_*）也在这份清单里**：`play()` 的语义（事件触发、播完即止）
 * 不变，循环走独立的 `playLoop()` / `stopLoop()`。与 BGM 分成两份清单的理由是**生命周期**，
 * 不是「能否循环」（BGM 是单槽 + 开关意图 + 跨手势对齐，循环效果音是事件驱动的短生命）。
 */
export const SOUND_IDS = Object.freeze(['gun_load', 'gun_fire', 'mag7_fire', 'minigun_fire',
  'put', 'explosion', 'turret_gun_fire', 'delete', 'rain', 'running_land', 'running_water',
  'z_die',
  // v2.64：Boss 战与击杀音效（.ogg，见 SOUND_EXT_OVERRIDES）
  'ignis_die', 'ignis_attack_swing', 'ignis_burn', 'ignis_hurt', 'ignis_jump',
  'dragon_shout', 'dragon_fire']);

/**
 * 音效文件的扩展名覆盖表（v2.64）。
 *
 * **为什么需要**：`preload()` 历史上写死 `assets/sounds/<id>.mp3`，而 v2.64 新增的 7 个音效
 * 与 boss 背景音乐都是 `.ogg`。缺一张扩展名表的形态是**静默无声** —— `_decodeFromUrl` 的
 * fetch 拿到 404，被 `preload()` 的 catch 吞成一句 `console.warn`，页面照常能玩。
 *
 * ⚠️ **不在表里的 id 一律按 `.mp3`**（既有 12 个音效全是 mp3，零回归）。`soundFileName()`
 * 是唯一消费点，`audio-manager.preload()` 与 `check:data` 都从它派生（红线 1：扩展名只有一份权威）。
 */
export const SOUND_EXT_OVERRIDES = Object.freeze({
  ignis_die: 'ogg',
  ignis_attack_swing: 'ogg',
  ignis_burn: 'ogg',
  ignis_hurt: 'ogg',
  ignis_jump: 'ogg',
  dragon_shout: 'ogg',
  dragon_fire: 'ogg',
  bgm_boss: 'ogg',
});

/**
 * 音效 id → 磁盘文件名（含扩展名）。`preload()` 与 `check:data` 的唯一权威。
 *
 * @param {string} id 音效 / 背景音乐 id
 * @returns {string} 如 `z_die.mp3` / `ignis_die.ogg`
 */
export function soundFileName(id) {
  const ext = SOUND_EXT_OVERRIDES[id] || 'mp3';
  return `${id}.${ext}`;
}

/**
 * 各音效的播放音量（v2.64）。集中在这一张表，触发点只写 `play(id, SOUND_VOLUMES[id])`，
 * 不在 game.js 里散落字面量（红线 1：同一事实只有一份权威）。
 *
 * ⚠️ 初值是按素材响度与既有口径（`z_die` 0.3 / `explosion` 0.4）估的，**均可再调** ——
 * 调音量只改这里，不动触发点。未列出的 id 由调用方给默认值（`play()` 的第二参缺省 1）。
 */
export const SOUND_VOLUMES = Object.freeze({
  z_die: 0.3,
  ignis_die: 0.5,
  ignis_attack_swing: 0.5,
  ignis_burn: 0.6,
  ignis_hurt: 0.5,
  ignis_jump: 0.5,
  dragon_shout: 0.4,
  dragon_fire: 0.5,
});

/**
 * 飞龙空中随机吼叫的间隔区间（秒，v2.64）。
 *
 * 用户 2026-11-07：「飞龙在空中会随机的发出声音叫声 dragon_shout.ogg」—— 「随机」故用区间
 * 而不是固定周期（固定周期听得出节拍，像定时器而不像生物）。
 *
 * ⚠️ **区间下限必须 > 0**：0 会让每帧都到期 → 每帧响一声（叠成持续器噪）。
 * 随机源用 `Math.random()`（不是 seededRandom）：吼叫是**表现层**事件，不影响世界生成，
 * 与 X 键调试生成丧尸同一口径（红线 2 只管「seed 确定性世界生成」）。
 */
export const DRAGON_SHOUT = Object.freeze({
  minSeconds: 6,
  maxSeconds: 14,
});

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
 * Boss 战背景音乐（v2.64，用户 2026-11-07：「当召唤出 boss 的时候，背景音乐就换成 bgm_boss.ogg」）。
 *
 * ⚠️ **刻意不进 `BGM_TRACKS` 随机池**：那三首是「开局随机抽一首」的普通 BGM，boss 曲是
 * 「有 Boss 在场时覆盖播放」的战斗曲，两者生命周期不同（普通曲随会话、boss 曲随 Boss 存活）。
 * 混进随机池会让「开局就抽中 boss 曲」这种荒诞情形出现。
 *
 * ⚠️ **懒加载**：`bgm_boss.ogg` 约 4.7MB，绝大多数会话根本不会召唤 Boss → 不进 `preload()`
 * 的首屏清单，首次 `setBossMusicActive(true)` 时才 fetch+decode（条件未齐走「记意图、齐了补播」
 * 的既有手法，与 BGM/循环音效同口径）。
 */
export const BOSS_BGM_TRACK = 'bgm_boss';

/**
 * Boss 战 BGM 的交叉淡化时长（ms，v2.64）。
 *
 * 用户要求「和原有的背景音乐之间加一个渐隐的过渡」。1.5 秒是听感上「淡出淡入不突兀、
 * 又不至于拖沓」的量级；改这个值只影响过渡快慢，不影响状态机正确性。
 */
export const BOSS_BGM_FADE_MS = 1500;

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
