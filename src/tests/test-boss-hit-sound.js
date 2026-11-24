// src/tests/test-boss-hit-sound.js — 焰魔 / 末影守卫「被打中」的受击音（用户 2026-11-18）
//
// 用户原话：「末影守卫被枪击中的时候会有击中声音，焰魔被击中的时候没有被击中的声音，
// 那我就让焰魔和末影守卫被击中的时候用的声音统一掉，都用 gun_hit.ogg 这个声音。」
//
// ## 为什么必须单测这一段
//
// 缺陷全在装配层 `Game.damageEntity()`：守卫分支自己 `play('guardian_hurt')`，
// 焰魔分支**一行都没有** ⇒ 焰魔挨枪只有枪声、没有受击反馈。这类漏接线是**静默的**
//（扣血/红闪/伤害数字/击退全部正常，只是没声音），既有的焰魔 E2E 只钉起手音与死亡音。
//
// ⚠️ **判据落在「播了哪个 id」而不是「播了几个音」**：只数总量的话，把守卫改成播
// 别的音、或给焰魔接一个错 id，都会照样通过。
//
// ⚠️ 用 `Object.create(Game.prototype)` 造壳（同 `test-tnt-chain.js` / `test-flame-sigil.js`
// 的既有手法）：`damageEntity` 只碰 entities / 四个 service / audioManager，
// `_damageNumbers` 与 `blockHitFx` 缺省即走纵深防御分支 ⇒ 不需要 DOM/WebGPU。
// service 用**真实的**（fake 形状不对会让测试绿而生产红）。
import { test } from './runner.js';
import { assertEqual, assertTrue } from './assert.js';
import { Game } from '../core/game.js';
import { EntityManager } from '../entities/entity-manager.js';
import { ZombieService, zombieDefinition } from '../entities/zombies/zombie-system.js';
import { ZOMBIE } from '../entities/zombies/zombie-config.js';
import { DragonService, dragonDefinition } from '../entities/dragons/dragon-system.js';
import { DRAGON_TYPE } from '../entities/dragons/dragon-config.js';
import { IgnisService, ignisDefinition } from '../entities/ignis/ignis-system.js';
import { IGNIS_TYPE } from '../entities/ignis/ignis-config.js';
import { GuardianService, guardianDefinition } from '../entities/guardian/guardian-system.js';
import { GUARDIAN_TYPE } from '../entities/guardian/guardian-config.js';
import { SoldierService, soldierDefinition } from '../entities/soldiers/soldier-system.js';
import { SOLDIER_TYPE } from '../entities/soldiers/soldier-config.js';
import {
  BOSS_HIT_SOUND, SOLDIER_HIT_SOUND, SOLDIER_FIRE_SOUND, SOLDIER_DEATH_SOUND,
  PLAYER_GUNSHOT_HURT_SOUND,
  SOUND_IDS, SOUND_EXT_OVERRIDES, SOUND_VOLUMES, soundFileName,
} from '../render/audio-config.js';

/** 平地世界：y <= 10 实心（地面 Boss 的落点扫描用它；`hasColumn` 是丧尸 spawn 的门） */
function flatWorld() {
  return {
    isSolid: (_x, y, _z) => y <= 10,
    getBlockId: (_x, y, _z) => (y <= 10 ? 1 : 0),
    hasColumn: () => true,
  };
}

/**
 * 造一个装好四类实体 service 的 Game 壳，并各召一只。
 * @returns {{game: object, plays: Array<{id: string, volume: number}>, ids: object}}
 */
function hitFixture() {
  const world = flatWorld();
  const em = new EntityManager();
  em.registerType('zombie', zombieDefinition);
  em.registerType(DRAGON_TYPE, dragonDefinition);
  em.registerType(IGNIS_TYPE, ignisDefinition);
  em.registerType(GUARDIAN_TYPE, guardianDefinition);
  em.registerType(SOLDIER_TYPE, soldierDefinition);
  const game = Object.create(Game.prototype);
  game.entities = em;
  game.zombies = new ZombieService({ entities: em, world });
  game.dragons = new DragonService({ entities: em, seed: 12345 });
  game.ignises = new IgnisService({ entities: em, world, seed: 12345 });
  game.guardians = new GuardianService({ entities: em, world, seed: 12345 });
  game.soldiers = new SoldierService({ entities: em, world });
  const plays = [];
  game.audioManager = { play: (id, volume) => { plays.push({ id, volume }); return true; } };
  const ids = {
    zombie: game.zombies.spawn([0.5, 11, 0.5], { source: 'test' }),
    dragon: game.dragons.summon('tarn:0:0', 0, 0, 0).id,
    ignis: game.ignises.summon('tarn:0:0', 4, 4, 1, 11).id,
    guardian: game.guardians.summon('rc:0:0', 8, 8, 0, 11).id,
    soldier: game.soldiers.spawn([12.5, 11, 12.5], { source: 'test' }),
  };
  return { game, plays, ids };
}

test('受击音契约: BOSS_HIT_SOUND = gun_hit，清单/扩展名/音量三处齐全', () => {
  assertEqual(BOSS_HIT_SOUND, 'gun_hit', '用户指定的文件就是 gun_hit.ogg');
  // 不在 SOUND_IDS ⇒ preload 不加载 ⇒ play() 只涨计数不出声（静默无声）
  assertTrue(SOUND_IDS.includes(BOSS_HIT_SOUND), 'gun_hit 必须进预载清单');
  // 回落 .mp3 ⇒ fetch 404 被 preload 的 catch 吞成一句 warn（同样静默）
  assertEqual(SOUND_EXT_OVERRIDES[BOSS_HIT_SOUND], 'ogg', 'gun_hit 必须登记为 ogg');
  assertEqual(soundFileName(BOSS_HIT_SOUND), 'gun_hit.ogg');
  assertTrue(SOUND_VOLUMES[BOSS_HIT_SOUND] > 0, '必须有正音量（0/缺失 = 听不见）');
});

test('受击音: 焰魔挨一下（没死）必须播 gun_hit —— 缺陷形态是一声都没有', () => {
  const { game, plays, ids } = hitFixture();
  const r = game.damageEntity(ids.ignis, 25, 1000);
  assertEqual(r.dead, false, '前置：25 伤害打不死焰魔');
  assertEqual(plays.length, 1, `焰魔受击必须播一个音，实际 ${JSON.stringify(plays)}`);
  assertEqual(plays[0].id, BOSS_HIT_SOUND, '焰魔受击音必须是 gun_hit');
  assertEqual(plays[0].volume, SOUND_VOLUMES[BOSS_HIT_SOUND], '音量取自音量表（不在装配层写字面量）');
});

test('受击音: 守卫挨一下（没死）也播 gun_hit，不再播 guardian_hurt', () => {
  const { game, plays, ids } = hitFixture();
  const r = game.damageEntity(ids.guardian, 25, 1000);
  assertEqual(r.dead, false, '前置：25 伤害打不死守卫');
  assertEqual(plays.length, 1, `守卫受击只播一个音，实际 ${JSON.stringify(plays)}`);
  assertEqual(plays[0].id, BOSS_HIT_SOUND, '守卫受击音必须与焰魔统一为 gun_hit');
  assertEqual(plays[0].volume, SOUND_VOLUMES[BOSS_HIT_SOUND]);
});

test('受击音: 致死一击不播受击音（死亡音由 _onEntityDeath 负责，不叠两声）', () => {
  const { game, plays, ids } = hitFixture();
  // 死亡分支会碰 blockHitFx（本壳没装）⇒ 只挡这一个缺口，其余走真代码
  game.blockHitFx = { spawnDeathBurst: () => {} };
  for (const key of ['ignis', 'guardian']) {
    plays.length = 0;
    const r = game.damageEntity(ids[key], 100000, 2000);
    assertEqual(r.dead, true, `前置：${key} 必须被打死`);
    assertEqual(plays.filter((p) => p.id === BOSS_HIT_SOUND).length, 0,
      `${key} 致死一击不得播受击音`);
    assertEqual(plays.length, 1, `${key} 致死一击只播死亡音，实际 ${JSON.stringify(plays)}`);
  }
});

test('受击音契约: 玩家被士兵打中 = hited，士兵自己挨打 = carbine_impact_wet（用户 2026-11-24 第二轮）', () => {
  // 用户原话：「玩家被 soldier 击中的声音改为 hited.mp3，soldier 被击中时的声音为
  // carbine_impact_wet.wav」—— 两条方向相反，写反的形态是「打人和挨打的声音调头」，
  // 而计数类判据（"响了几个音"）照样全绿 ⇒ 必须逐条钉 id。
  assertEqual(PLAYER_GUNSHOT_HURT_SOUND, 'hited', '玩家被士兵打中必须是 hited.mp3');
  assertEqual(SOLDIER_HIT_SOUND, 'carbine_impact_wet', '士兵挨打必须是 carbine_impact_wet.wav');
  // ⚠️ `hited.mp3` 在 assets/sounds/ 里躺了很久但**从未进过清单** ⇒ preload 不加载它，
  // play() 只涨计数不出声（静默无声）。三条缺一不可。
  assertTrue(SOUND_IDS.includes('hited'), 'hited 必须进预载清单');
  assertEqual(soundFileName('hited'), 'hited.mp3', '默认扩展名是 mp3，不进 overrides 也必须正确');
  assertTrue(SOUND_VOLUMES.hited > 0, 'hited 必须有正音量（0/缺失 = 听不见）');
  assertTrue(SOUND_VOLUMES[SOLDIER_HIT_SOUND] > 0, '士兵受击音必须有正音量');
});

test('开火音契约: 士兵开火 = carbine_bullet.mp3（用户 2026-11-24 第三轮）', () => {
  // 用户原话：「soldier 射击的时候，用音效 carbine_bullet.mp3」。
  // ⚠️ 文件是 `.mp3` ⇒ 不得进扩展名覆盖表（登成别的 = 404 被 preload 吞成 warn = 静默无声）
  assertEqual(SOLDIER_FIRE_SOUND, 'carbine_bullet');
  assertTrue(SOUND_IDS.includes(SOLDIER_FIRE_SOUND), 'carbine_bullet 必须进预载清单');
  assertTrue(SOUND_EXT_OVERRIDES[SOLDIER_FIRE_SOUND] === undefined,
    'carbine_bullet 是 mp3，不得登记进扩展名覆盖表');
  assertEqual(soundFileName(SOLDIER_FIRE_SOUND), 'carbine_bullet.mp3');
  assertTrue(SOUND_VOLUMES[SOLDIER_FIRE_SOUND] > 0, '必须有正音量（0/缺失 = 听不见）');
  // ⚠️ 玩家与士兵开火同响（ebur128 实测 −28.0 vs −27.9 LUFS）⇒ 误压低士兵会变「听不出方向」
  assertEqual(SOUND_VOLUMES[SOLDIER_FIRE_SOUND], 0.5,
    '与玩家那把 carbine_fire 同档（响度实测几乎相同）');
});

test('受击音: 士兵挨一下（没死）必须播 carbine_impact_wet —— 缺陷形态是一声都没有', () => {
  const { game, plays, ids } = hitFixture();
  assertTrue(!!ids.soldier, '前置：士兵 spawn 成功');
  const r = game.damageEntity(ids.soldier, 25, 1000);
  assertEqual(r.dead, false, '前置：25 伤害打不死士兵（血量 100）');
  const hitPlays = plays.filter((p) => p.id !== 'z_die');
  assertEqual(hitPlays.length, 1, `士兵受击必须播一个受击音，实际 ${JSON.stringify(plays)}`);
  assertEqual(hitPlays[0].id, SOLDIER_HIT_SOUND, '士兵受击音必须是 carbine_impact_wet');
  assertEqual(hitPlays[0].volume, SOUND_VOLUMES[SOLDIER_HIT_SOUND],
    '音量取自音量表（不在装配层写字面量）');
});

test('受击音: 士兵致死一击不播受击音（只播死亡音 z_die）', () => {
  const { game, plays, ids } = hitFixture();
  game.blockHitFx = { spawnDeathBurst: () => {} };
  assertTrue(!!ids.soldier, '前置：士兵 spawn 成功');
  const r = game.damageEntity(ids.soldier, 100000, 2000);
  assertEqual(r.dead, true, '前置：士兵必须被打死');
  assertEqual(plays.filter((p) => p.id === SOLDIER_HIT_SOUND).length, 0,
    '致死一击不得播受击音（否则与死亡音叠成两声）');
});

test('死亡音契约: 士兵阵亡 = carbine_kill.mp3（用户 2026-11-24 第四轮）', () => {
  // 用户原话：「soldier 被消灭时的音效改为 carbine_kill.mp3」。
  //
  // ⚠️⚠️ **这个 id 原本是 KV-9 烘焙产物的（`wav`）**，而用户指定的是同名 `.mp3`
  // （0.792s，不是烘焙那段的 0.36s）。`SOUND_EXT_OVERRIDES` 末尾必须把它覆盖成
  // `'mp3'`，且**必须排在 `CARBINE_AUDIO_IDS` 那行派生之后** ——
  // 派生的顺序在前的形态是「运行时播烘焙合成的旧音」，而响了几声的断言全绿。
  assertEqual(SOLDIER_DEATH_SOUND, 'carbine_kill', '用户指定的就是这个名字');
  assertTrue(SOUND_IDS.includes(SOLDIER_DEATH_SOUND), '必须进预载清单');
  assertEqual(SOUND_EXT_OVERRIDES[SOLDIER_DEATH_SOUND], 'mp3',
    '必须覆盖烘焙派生的 wav ⇒ 否则播的是旧合成音而不是用户指定的文件');
  assertEqual(soundFileName(SOLDIER_DEATH_SOUND), 'carbine_kill.mp3');
  assertTrue(SOUND_VOLUMES[SOLDIER_DEATH_SOUND] > 0, '必须有正音量');
  // ⚠️ 响度实测 carbine_kill −16.6 LUFS vs z_die −25.4（响 8.8 LU）⇒ 不能沿用 0.3
  assertTrue(SOUND_VOLUMES[SOLDIER_DEATH_SOUND] < SOUND_VOLUMES.z_die,
    '素材比 z_die 响 8.8 LU ⇒ 音量必须比 0.3 小，否则是「一声爆响」');
});

test('死亡音: 士兵被打死播 carbine_kill，不再播 z_die', () => {
  const { game, plays, ids } = hitFixture();
  game.blockHitFx = { spawnDeathBurst: () => {} };
  assertTrue(!!ids.soldier, '前置：士兵 spawn 成功');
  const r = game.damageEntity(ids.soldier, 100000, 2000);
  assertEqual(r.dead, true, '前置：士兵必须被打死');
  assertEqual(plays.filter((p) => p.id === 'z_die').length, 0,
    '士兵阵亡不得再播 z_die（那是丧尸的死亡音）');
  const death = plays.filter((p) => p.id === SOLDIER_DEATH_SOUND);
  assertEqual(death.length, 1, `士兵阵亡必须播一次 ${SOLDIER_DEATH_SOUND}，实际 ${JSON.stringify(plays)}`);
  assertEqual(death[0].volume, SOUND_VOLUMES[SOLDIER_DEATH_SOUND],
    '音量取自音量表（不在装配层写字面量）');
});

test('死亡音: 丧尸阵亡仍播 z_die（零回归）', () => {
  const { game, plays, ids } = hitFixture();
  game.blockHitFx = { spawnDeathBurst: () => {} };
  game.damageEntity(ids.zombie, 100000, 3000);
  assertEqual(plays.filter((p) => p.id === 'z_die').length, 1, '丧尸阵亡仍是 z_die');
  assertEqual(plays.filter((p) => p.id === SOLDIER_DEATH_SOUND).length, 0,
    '丧尸阵亡不得播士兵的死亡音');
});

test('受击音: 丧尸与飞龙零回归（丧尸无受击音、飞龙仍无受击音）', () => {
  const { game, plays, ids } = hitFixture();
  // ⚠️ 用户只点名焰魔与守卫 ⇒ 另两类不得顺手加音（那会改变机枪连射的听感）
  game.damageEntity(ids.zombie, 25, 1000);
  assertEqual(plays.length, 0, `丧尸受击不配音，实际 ${JSON.stringify(plays)}`);
  game.damageEntity(ids.dragon, 25, 1000);
  assertEqual(plays.length, 0, `飞龙受击不配音，实际 ${JSON.stringify(plays)}`);
  assertTrue(game.zombies.get(ids.zombie).health === ZOMBIE.health - 25, '前置：丧尸真的扣血了');
});