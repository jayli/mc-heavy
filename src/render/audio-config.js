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

// v3.30：KV-9 卡宾枪与雨天音效的烘焙配方（three-free / DOM-free，Node 门禁可直接 import）。
// 产物 id 与扩展名都从它派生，不在本文件手写。
import { CARBINE_AUDIO_IDS } from './carbine-audio-recipes.js';
import { CARBINE_AUDIO_EXT } from './carbine-audio-ext.js';
// v3.37：水中脚步声改为烘焙产物（用户素材按陆地步频重排成无缝循环）。
// ⚠️ **id 由 `running_water` 改名 `running_wet`**（用户 2026-11-24 裁定文件名 running_wet.wav）。
// 文件名走 `soundFileName(id)` 派生 ⇒ 改 id 即可，不另立一张「id→文件名」映射表（红线 1）。
// 消费方只有 `player._updateFootsteps` 与 `tests/audio-fx.spec.mjs`，两处已同步改名。
import { FOOTSTEP_WATER_EXT } from './footstep-water-ext.js';

/**
 * 预加载的效果音 id（与 `weapon-catalog` 的 sound 字段一致）。
 * M7 追加 `put` —— 放置成功的音效（mc-lite `src/assets/sound/put.mp3`）。
 * M8 追加 `explosion`（音量 0.4，出处 `PlayerInteraction.js:673`）与
 *   `turret_gun_fire`（`TurretManager.js:148`，音量 0.25）。
 * v2.51 追加环境/动作音（用户 2026-11-04 需求，出处均为 mc-lite
 *   `AudioManager.initializeAudio` 的预载清单）：
 *   `delete` — 挖掉方块的音效（mc-lite 侧文件名为 `delete_get.mp3`，本仓入库去掉 `_get` 后缀）；
 *   `rain` — 雨声（**循环**，仅在 `weather.intensity > 0` 时播）；
 *   `running_land` / `running_wet` — 跑动脚步声（**循环**，陆地/水中两套，
 *      mc-lite `PlayerInteraction.js:891-915` 的 `playSound(..., 0.2|0.25, true)`）；
 *      ⚠️ **v3.37 起水中那路是本仓烘焙产物 `running_wet.wav`**（不再是 mc-lite 带来的
 *      `running_water.mp3`）：用户提供的踩湿泥素材按 `running_land` 实测步频（0.27991s/步）
 *      重排成 8 步 2.239s 的无缝循环，见 `footstep-water-recipe.js`。
 *      id 同时由 `running_water` **改名 `running_wet`**（用户裁定文件名）——
 *      文件名走 `soundFileName(id)` 派生，故不另立映射表；扩展名进 `SOUND_EXT_OVERRIDES`；
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
 * v2.65 追加近战剑音效（用户 2026-11-06，出处均为 `assets/sounds/` 里已入库的 `.ogg`
 *   素材 —— **零新增美术资源**，只是把既有文件接进清单）：
 *   `player_swing` — 玩家挥剑（用户：「挥剑的时候带一个音效：player_swing.ogg」）；
 *   `emp_activated` — 剑砍中敌人（用户：「击中敌人后也带一个音效：emp_activated.ogg」）。
 *
 * v2.79 追加旋斩音（用户 2026-11-07：「给焰魔的旋转攻击加上一个音效，音效文件是
 *   `ignis_attack_circle.ogg`」）：
 *   `ignis_attack_circle` — 焰魔**旋斩**起手（与普攻的 `ignis_attack_swing` 分工，
 *      映射唯一权威在下面的 `IGNIS_ATTACK_SOUNDS`）。
 *      ⚠️ **上游无对应音**：原版 `Ignis_Entity.java` 里普攻与旋斩都播 `ModSounds.STRONGSWING`
 *      （没有独立的「旋斩音」），所以这条是用户新增的音，没有 Java 口径可对照。
 *
 * v3.15 追加 Boss 受击音（用户 2026-11-18）：
 *   `gun_hit` — **焰魔 / 末影守卫被打中（没死）**。用户：「末影守卫被枪击中的时候会有击中
 *      声音，焰魔被击中的时候没有被击中的声音……都用 gun_hit.ogg 这个声音」。
 *      唯一权威 = 下面的 `BOSS_HIT_SOUND`；触发点在 `Game.damageEntity()` 的两个分支。
 *      ⚠️ `guardian_hurt` 仍在清单里但**已无消费方**（保留素材，不是遗漏）——
 *      守卫的死亡音 `guardian_die` 与拳击音 `guardian_attack` 一字未改。
 *
 * ⚠️ **循环类音效（rain / running_*）也在这份清单里**：`play()` 的语义（事件触发、播完即止）
 * 不变，循环走独立的 `playLoop()` / `stopLoop()`。与 BGM 分成两份清单的理由是**生命周期**，
 * 不是「能否循环」（BGM 是单槽 + 开关意图 + 跨手势对齐，循环效果音是事件驱动的短生命）。
 */
export const SOUND_IDS = Object.freeze(['gun_load', 'gun_fire', 'mag7_fire', 'minigun_fire',
  'put', 'explosion', 'turret_gun_fire', 'delete', 'rain', 'running_land', 'running_wet',
  'z_die',
  // v2.64：Boss 战与击杀音效（.ogg，见 SOUND_EXT_OVERRIDES）
  'ignis_die', 'ignis_attack_swing', 'ignis_burn', 'ignis_hurt', 'ignis_jump',
  'dragon_shout', 'dragon_fire',
  // v2.65：近战剑音效（.ogg，见 SOUND_EXT_OVERRIDES）
  'player_swing', 'emp_activated',
  // v2.79：焰魔旋斩（.ogg，见 SOUND_EXT_OVERRIDES 与 IGNIS_ATTACK_SOUNDS）
  'ignis_attack_circle',
  // v3.01：焰魔**持盾冲撞**起手音。文件来自 mod 的 `sword_stomp.ogg`（强化砸地踏步音），
  // 逐字节拷入、未转码。⚠️ **这是近似替代，不是原版该招的音** —— 原版
  // `SHIELD_SMASH_ATTACK` 分支播的是 Minecraft 原版 `SoundEvents.TOTEM_USE`，本仓没有那个文件。
  // 将来对照原版时不要把本条当作「原音」（用户裁定⑤选它作近似）。
  'ignis_attack_smash',
  // v3.03：焰魔**举盾砸击**起手音。文件来自 mod 的 `ignis_impact.ogg`（焰魔撞击音，
  // `sounds.json:161` 的 `ignis_impact` 事件引用它），逐字节拷入、未转码（9023 字节）。
  // ⚠️ **这是近似替代，不是原版该招的音** —— 原版 `ULTIMATE_ATTACK` 在 tick 74 播
  // `ModSounds.STRONGSWING` + `earthquakesound(10f)`（后者是原版 `SoundEvents.TOTEM_USE`，
  // 本仓与 mod 素材里都没有那个文件）。
  // ⚠️ **不取 `ignis_earthquake.ogg`**：`ModSounds.IGNIS_EARTHQUAKE` 虽已注册，
  // 但全仓**无任何调用点**（程序化扫描确认）⇒ 它是未使用素材，不能声称是这招的原音。
  'ignis_attack_bash',
  // v3.06：焰魔**尖刺攻击**起手音。文件来自 mod 的 `ignis_impact2.ogg`（焰魔撞击音第二帧），
  // 逐字节拷入、未转码（11686 字节）。
  // ⚠️ **这是近似替代，不是原版该招的音** —— 原版 `EARTH_SHUDDERS_ATTACK` 三刀各播
  // Minecraft 原版 `SoundEvents.TOTEM_USE`（本仓与 mod 素材里都没有那个文件）。
  'ignis_attack_spike',
  // 末影守卫（本次新增）：三个文件已在 Task 1 拷入 assets/sounds/。
  // ⚠️ 受击/死亡音源头是原版的 golemhurt / golemdeath（已查 sounds.json 链路，
  //    不是按名字猜）；拳击音是专属的 ender_guardian_fist_attack。
  'guardian_attack', 'guardian_hurt', 'guardian_die',
  // v3.15：**Boss 受击音**（用户 2026-11-18：「末影守卫被枪击中的时候会有击中声音，
  // 焰魔被击中的时候没有被击中的声音……都用 gun_hit.ogg 这个声音」）。
  // 文件早已在 assets/sounds/ 里（未入清单 ⇒ 从来没被预载过），本次只是接进来，
  // **零新增美术资源**。唯一权威见下面的 `BOSS_HIT_SOUND`。
  'gun_hit',
  // v3.36：**玩家被士兵子弹命中**的受击音（用户 2026-11-24 第二轮裁定）。
  // 文件 `assets/sounds/hited.mp3`（0.456s）早已躺在库里但**全仓零引用** ⇒ 从未进过本清单，
  // `preload()` 也就从未加载它。不加这一行 = `play()` 只涨计数、一点声都不出（静默无声）。
  // 唯一权威见下面的 `PLAYER_GUNSHOT_HURT_SOUND`。
  'hited',
  // v3.36b：**士兵开火**的声音（用户 2026-11-24：「soldier 射击的时候，用音效
  // carbine_bullet.mp3」）。文件已在库里（0.6s / 24kHz 立体声），**零新增音频**。
  // ⚠️ 它本来就是 `.mp3`，不进 overrides。唯一权威见下面的 `SOLDIER_FIRE_SOUND`。
  'carbine_bullet',
  // v3.36c：**士兵阵亡**听用户指定的 `carbine_kill.mp3`。
  // ⚠️ 该 id 已由下面 `...CARBINE_AUDIO_IDS`（烘焙产物）带进清单 ⇒ **不重复追加**
  //（重复项没有任何断言能抓到）。选文件靠 `SOUND_EXT_OVERRIDES` 末尾把它覆盖成 `'mp3'`。
  // v3.30 KV-9 卡宾枪与雨天音效（烘焙产物，配方来自 bj-shooting-game 的 Web Audio 合成器）。
  // ⚠️ **清单派生自 `CARBINE_AUDIO_IDS`**（红线 1）—— 手写 12 个 id 会在新增配方时漏改。
  ...CARBINE_AUDIO_IDS]);

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
  // v2.65：近战剑音效
  player_swing: 'ogg',
  emp_activated: 'ogg',
  // v2.79：焰魔旋斩
  ignis_attack_circle: 'ogg',
  // v3.01：焰魔持盾冲撞（mod sword_stomp.ogg 的近似替代）。漏加本表 = 静默无声
  ignis_attack_smash: 'ogg',
  // v3.03：焰魔举盾砸击（mod ignis_impact.ogg 的近似替代）。漏加本表 = 静默无声
  ignis_attack_bash: 'ogg',
  // v3.06：焰魔尖刺攻击（mod ignis_impact2.ogg 的近似替代）。漏加本表 = 静默无声
  ignis_attack_spike: 'ogg',
  // 末影守卫：三个都是 .ogg。⚠️ **漏加本表 = 静默无声**（按 .mp3 去 fetch ⇒ 404 被 catch 吞）
  guardian_attack: 'ogg',
  guardian_hurt: 'ogg',
  guardian_die: 'ogg',
  // v3.15 Boss 受击音：磁盘上是 .ogg。漏加本表 = 静默无声（按 .mp3 fetch ⇒ 404 被 catch 吞）
  gun_hit: 'ogg',
  // v3.30 KV-9 / 雨声：烘焙产物是 **wav**（16-bit PCM，离线合成器写出）。
  // ⚠️ 漏加本表 = 静默无声（同上面每一条的教训）。清单派生自
  // `carbine-audio-recipes.js` 的 CARBINE_AUDIO_IDS，不在这里手写 12 行（红线 1）。
  ...Object.fromEntries(CARBINE_AUDIO_IDS.map((id) => [id, CARBINE_AUDIO_EXT])),
  // v3.36c：**士兵阵亡音听用户指定的 `carbine_kill.mp3`**（用户 2026-11-24：「soldier
  // 被消灭时的音效改为 carbine_kill.mp3」+「carbine_kill.wav 被我删除的，不要了，你直接
  // 替换为我指定的文件即可」）。
  // ⚠️⚠️ **必须盖在上面那行派生之后**：派生把 `carbine_kill` 登记成 `wav`（烘焙产物），
  // 而用户要的是同名的 `.mp3`（0.792s，不是烘焙那段的 0.36s）。不覆盖的形态是
  // 「播的是烘焙合成的旧音，而不是用户指定的文件」，而响了几声的断言全绿。
  carbine_kill: 'mp3',
  // v3.37：水中脚步声换成烘焙产物（wav）。⚠️ **漏这一行 = 水中走路彻底没声**：
  // 磁盘上只有 running_wet.wav，按 .mp3 去 fetch 拿 404，被 preload 的 catch
  // 吞成一句 console.warn ⇒ 页面照常能玩、`playLoop` 照常返回意图、只是永远不出声。
  running_wet: FOOTSTEP_WATER_EXT,
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
 *
 * ⚠️ **武器音不在本表**：枪声（`gun_fire`/`mag7_fire`/`minigun_fire`）与 v2.65 近战剑的
 * 两个音（`player_swing`/`emp_activated`）的音量权威在 `weapon-catalog.js`（`volume` /
 * `hitVolume`），因为它们是「效果事件」的一部分 —— 由 controller 写进 effect、
 * `player._applyWeaponEffect()` 消费。在本表再写一份就是红线 1 的第二份权威，
 * 调音量时会漂移成「catalog 改了、这张表没跟上」（而本表那两个值无人读，静默失效）。
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
  // v2.79：与 `ignis_attack_swing` 同档。实测素材峰值 circle −0.3 dB / swing −0.9 dB
  //（平均能量 circle 高约 9 dB）—— 初值取同档，嫌响/嫌轻只改这一个数，不动触发点。
  ignis_attack_circle: 0.5,
  // v3.01：持盾冲撞与另两招同档（嫌响/嫌轻只改这一个数，不动触发点）
  ignis_attack_smash: 0.5,
  // v3.03：举盾砸击与另三招同档（嫌响/嫌轻只改这一个数，不动触发点）
  ignis_attack_bash: 0.5,
  // v3.06：尖刺攻击与另四招同档（嫌响/嫌轻只改这一个数，不动触发点）
  ignis_attack_spike: 0.5,
  // 末影守卫：照焰魔 0.5 同档（嫌响/嫌轻只改这三个数，不动触发点）
  guardian_attack: 0.5,
  guardian_hurt: 0.5,
  guardian_die: 0.5,
  // v3.15 Boss 受击音：与守卫原受击音同档 0.5（嫌响/嫌轻只改这一个数，不动触发点）。
  // ⚠️ 素材实测 0.750s，比原 `guardian_hurt`（2.579s）短得多 ⇒ 机枪连射时不会叠成长鸣。
  gun_hit: 0.5,
  // 士兵枪击命中玩家的受击音（用户 2026-11-24 第一轮）。
  // ⚠️ v3.36 起这个 id 改为**士兵自己挨打**的音（用户第二轮：「soldier 被击中时的声音为
  // carbine_impact_wet.wav」）—— 玩家那条路径已换成 `hited`，两条**方向相反**，别写反。
  carbine_impact_wet: 0.5,
  // v3.36：玩家被士兵子弹命中（`hited.mp3`，0.456s）。取 0.5 与 `ignis_hurt` 同档。
  hited: 0.5,
  /**
   * v3.36b：士兵开火（`carbine_bullet.mp3`）。
   *
   * ⚠️ **取 0.5 是按实测响度对齐，不是拄脑袋**（ffmpeg ebur128）：
   *   `carbine_bullet.mp3` **−28.0 LUFS** / 玩家那把 `carbine_fire.wav` **−27.9 LUFS**
   *   ⇒ 两者几乎同响，直接用玩家那把的同档音量（`weapon-catalog` 的 0.5）即可。
   * ⚠️ 士兵是**班组连射**（至多 2 只同时点射、每 0.105s 一发）⇒ 不要因为「比玩家枪声小」
   *   的直觉把它压低：压低的形态是「远处士兵打你但听不出方向」。
   */
  carbine_bullet: 0.5,
  /**
   * v3.36c：士兵阵亡（`carbine_kill` 这个 id，听的用户指定的 `carbine_kill.mp3`）。
   *
   * ⚠️ **取值按实测响度算**（ffmpeg ebur128）：
   *   `carbine_kill.mp3` **−16.6 LUFS** vs 丧尸死亡音 `z_die.mp3` **−25.4 LUFS**
   *   ⇒ 比 `z_die`（音量 0.3）响 **8.8 LU**。直接沿用 0.3 会是「一声爆响」。
   *   按响度差衰减：0.3 × 10^(−8.8/20) ≈ **0.109** → 取 0.11。
   * ⚠️ 调音量只改这一个数，不动触发点（红线 1）。
   */
  carbine_kill: 0.11,
});

/**
 * 焰魔 / 末影守卫「被打中（没死）」的受击音 id（v3.15，用户 2026-11-18）。
 *
 * 用户原话：「末影守卫被枪击中的时候会有击中声音，焰魔被击中的时候没有被击中的声音，
 * 那我就让焰魔和末影守卫被击中的时候用的声音统一掉，都用 gun_hit.ogg 这个声音。」
 *
 * ⚠️ **为什么抽成常量而不是在两个分支各写一次字面量**：这次需求的本体就是「两者用同一个音」。
 * 写两份字面量的形态是将来改一侧忘另一侧 ⇒ 又退回「两个 Boss 声音不一致」，而所有
 * 计数类指标都正常（红线 1：同一事实只有一份权威）。
 *
 * ⚠️ **只覆盖焰魔与守卫**：丧尸与飞龙刻意保持无受击音（用户只点名这两个 Boss；
 * 给丧尸加音会把机枪连射的听感整段改掉）。玩家自己被打仍走 `_damagePlayer` → `ignis_hurt`，
 * 三条路径互不相干。
 *
 * ⚠️ **致死一击不播它**：那一下由 `_onEntityDeath` 播各自的死亡音
 *（`ignis_die` / `guardian_die`），叠加会变成两声。
 */
export const BOSS_HIT_SOUND = 'gun_hit';

/**
 * 玩家被**士兵子弹**命中时的受击音（用户 2026-11-24 第二轮裁定）。
 *
 * 用户原话：「玩家被 soldier 击中的声音改为 hited.mp3，soldier 被击中时的声音为
 * carbine_impact_wet.wav」。
 *
 * ⚠️ **两条方向相反，别调头**：本条 = 玩家挨打；`SOLDIER_HIT_SOUND` = 士兵挨打。
 * 第一轮曾把本条设成 `carbine_impact_wet`（当时士兵还没有任何受击音），本轮按用户
 * 新裁定对调 —— 写反的形态是「打人和挨打的声音换了」，而「响了几个音」类判据照样全绿。
 *
 * ⚠️ **只覆盖枪击这一条路径**：Boss 近战 / 尖刺 / 法阵仍走 `ignis_hurt`
 *（`tests/boss-audio.spec.mjs` 钉着那条）。两条路径互不相干。
 * ⚠️ **素材早已在库**：`assets/sounds/hited.mp3`（0.456s）零新增文件、零烘焙；
 * 但它在 v3.36 之前**从未进过 `SOUND_IDS`** ⇒ 本轮必须同时加进清单与音量表，漏一处静默无声。
 * ⚠️ **音量归本表**（红线 1）：触发点只写 `play(id, SOUND_VOLUMES[id])`，
 * 不在 game.js 写字面量。
 */
export const PLAYER_GUNSHOT_HURT_SOUND = 'hited';

/**
 * 士兵（soldier）**自己挨打（没死）**的受击音（用户 2026-11-24 第二轮裁定）。
 *
 * 用户原话：「soldier 被击中时的声音为 carbine_impact_wet.wav」。
 *
 * ⚠️ **v3.36 之前士兵挨打一声都没有**（`Game.damageEntity` 的 soldier 分支只做班组报警
 * `alertNearby`）—— 形态是「扣血/红闪/伤害数字/击退/同伴报警全部正常，只是没声音」。
 * ⚠️ **致死一击不播它**：那一下由 `_onEntityDeath` 播 `SOLDIER_DEATH_SOUND`，叠加会变成两声
 *（与 `BOSS_HIT_SOUND` 同一口径）。
 * ⚠️ **素材已在库**：`carbine_impact_wet` 是 KV-9 烘焙产物，早已在 `SOUND_IDS` 里（零新增）。
 */
export const SOLDIER_HIT_SOUND = 'carbine_impact_wet';

/**
 * 士兵**开火**的声音（用户 2026-11-24 第三轮裁定）。
 *
 * 用户原话：「soldier 射击的时候，用音效 carbine_bullet.mp3」。
 *
 * ⚠️ **v3.36b 之前士兵开火一声都没有**：`_consumeSoldierShots()` 只做曳光 + 枪口火光 + 火花，
 * 静默下的形态是「子弹曳光飞过、玩家掉血，但听不出是谁开的枪」。
 * ⚠️ **每发都播，与是否命中无关**：开火声是对「开枪」这个动作的反馈，而受击声
 *（`hited`）对「被打中」—— 两者不能合并。只给命中分支接音的缺陷形态是
 *「连射时听起来像命中才响」，而「响了几个音」的判据拓不到。
 * ⚠️ **素材已在库**：`assets/sounds/carbine_bullet.mp3`（0.6s），零新增音频、零烘焙。
 */
export const SOLDIER_FIRE_SOUND = 'carbine_bullet';

/**
 * 士兵**阵亡**的声音（用户 2026-11-24 第四轮裁定）。
 *
 * 用户原话：「soldier 被消灭时的音效改为 carbine_kill.mp3」。
 *
 * ⚠️ **v3.36c 之前士兵阵亡复用丧尸的 `z_die`**（v3.35 的裁定「本轮不做士兵专属音效」）。
 * ⚠️ **用户指定的文件是 `carbine_kill.mp3`（0.792s）**：该 id 原本是 KV-9 的烘焙产物
 *（`.wav` 0.36s），v3.36c 在 `SOUND_EXT_OVERRIDES` 末尾把它覆盖成 `'mp3'` ⇒ 听的是用户放的那个。
 * ⚠️ **音量不是 0.3**：实测 `carbine_kill.mp3` −16.6 LUFS 比 `z_die` −25.4 响 8.8 LU，
 * 沿用 0.3 会是「一声爆响」⇒ 按响度差取 **0.11**（推导见 `SOUND_VOLUMES` 里那条注释）。
 */
export const SOLDIER_DEATH_SOUND = 'carbine_kill';

/**
 * 一次性音效的**并发声道上限**（用户 2026-11-25）。
 *
 * 用户原话：「soldier 射击时的声音有时候滞后发出，是有队列吗？我不要队列……
 * 如果因为声音声道挤占导致某个 soldier 的射击动作没有发出声音，就丢弃掉，
 * 不要延迟或者滞后再补发声音了。」
 *
 * ## 缺陷本体（本轮探针在真实 AudioContext 上实测）
 *
 * 旧 `play()` 是**每个 id 一个 `THREE.Audio` 单槽**，同名再播先 `stop()` 再 `play()`：
 *   3 只士兵 6s 内 **47 次开火请求 → 46 次是「打断上一声再从头重播」**。
 * `carbine_bullet.mp3` 长 **0.519s**（ffprobe 实测）而班组发间隔 0.105s
 *（`SOLDIER_SHOT.shotInterval`）⇒ 每一声只响 0.1s 就被下一声顶掉，听起来就是
 *「枪声卡在起始那一小段、真正的响声迟到」。
 *
 * ## 为何取 6（推导，不是拍的）
 *
 * 并发上限 = `SOLDIER_SHOT.maxConcurrentBursts`(2) × 素材时长 0.519s
 * ÷ 发间隔 0.105s ≈ **9.9**，但两名士兵的相位不重合且一轮只 3~6 发；
 * 取 **6** = “两名 × 一轮最少 3 发”，足以让一轮点射的每一发都完整发声，
 * 又不会在极端叠射时无上限地堆 source。
 *
 * ⚠️ **不在表里的 id 一律走 `DEFAULT_SOUND_VOICES`（= 1，旧行为）**：
 * 本轮只改士兵开火这一条路径，其余音效（包括玩家枪声/Boss 起手音/死亡音）
 * 的听感逐位不变 —— 改它们会连带改既有 spec 的听感基线，不属本请求范围。
 * ⚠️ **声道满 = 丢弃**（不起播、不排队、不打断在播的）—— 用户明确要的语义。
 * 不得改成“覆盖最旧”（那仍是打断）或“记下来下一帧补发”（那仍是滞后）。
 */
export const DEFAULT_SOUND_VOICES = 1;

export const SOUND_VOICE_LIMITS = Object.freeze({
  // 士兵班组连射：同一素材必须能并发，否则后一发顶掉前一发（听感 = 滞后）
  carbine_bullet: 6,
});

/**
 * 焰魔「哪一招 → 哪个起手音」的唯一权威（v2.79）。
 *
 * **为什么需要这张表**：v2.75 起焰魔有多招（v3.01 起三招：`'swing' | 'spin' | 'shieldSmash'`），
 * 起手音的选择必须与招式一一对应 —— 在触发点写 `if (kind === 'spin') am.play('ignis_attack_circle')
 * else am.play('ignis_attack_swing')` 就是红线 1 禁止的第二份分支：将来加第四招时漏改一处
 * 的形态是**该招静默沿用普攻音**（而所有数据层指标都正常）。
 *
 * 覆盖度由 `check:data` 的 `[音效]` 环节之外的单测钉住（`test-bgm.js`：三键齐全、
 * 每个 id 都在 `SOUND_IDS` 里且走 ogg、`attackKind` 的取值域与键集合一致、三音两两不同）。
 *
 * ⚠️ **缺省回落 `swing`**：`attackKind` 为 `null`/缺失时（旧 state、非攻击态）与渲染器
 * 选片段的口径一致 —— 两处都是「缺了就当作普攻」，不各自造一套默认。
 */
export const IGNIS_ATTACK_SOUNDS = Object.freeze({
  swing: 'ignis_attack_swing',
  spin: 'ignis_attack_circle',
  /** v3.01：持盾冲撞（mod `sword_stomp.ogg` 的近似替代，非原版 TOTEM_USE） */
  shieldSmash: 'ignis_attack_smash',
  /**
   * v3.03：举盾砸击（mod `ignis_impact.ogg` 的近似替代）。
   * 原版是 `STRONGSWING` + `TOTEM_USE`，后者无文件 ⇒ 取语义最近的「焰魔撞击」音。
   * ⚠️ 必须与另三招不同音（`test-bgm.js` 按 `IGNIS_ATTACK_IDS` 全量钉住）——
   * 共用同一个音就是「加了招式却没接音」，而数据层全绿。
   */
  shieldBash: 'ignis_attack_bash',
  /**
   * v3.06：尖刺攻击（mod `ignis_impact2.ogg` 逐字节拷入，11686 字节）。
   * 原版 `EARTH_SHUDDERS_ATTACK` 在三刀各播 `SoundEvents.TOTEM_USE`（本仓无该文件）
   * ⇒ 取语义最近的「焰魔撞击」音的第二帧（`ignis_impact.ogg` 已被举盾砸击占用）。
   * ⚠️ **不取 `ignis_earthquake.ogg`**：`ModSounds.IGNIS_EARTHQUAKE` 虽已注册，
   * 但全仓**无任何调用点**（程序化扫描确认）⇒ 它是未使用素材，不能声称是这招的原音。
   * ⚠️ 必须与另四招不同音（`test-bgm.js` 按 `IGNIS_ATTACK_IDS` 全量钉住）。
   */
  spikeSlash: 'ignis_attack_spike',
});

/**
 * `attackKind` → 起手音效 id（缺省/非法值回落 `swing`，`IGNIS_ATTACK_SOUNDS` 的唯一读取口）。
 * @param {string|null|undefined} kind 焰魔本招档案键（`'swing'` / `'spin'` / `'shieldSmash'`）
 * @returns {string} 音效 id
 */
export function ignisAttackSound(kind) {
  return IGNIS_ATTACK_SOUNDS[kind] || IGNIS_ATTACK_SOUNDS.swing;
}

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
