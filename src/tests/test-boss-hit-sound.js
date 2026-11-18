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
import { BOSS_HIT_SOUND, SOUND_IDS, SOUND_EXT_OVERRIDES, SOUND_VOLUMES, soundFileName }
  from '../render/audio-config.js';

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
  const game = Object.create(Game.prototype);
  game.entities = em;
  game.zombies = new ZombieService({ entities: em, world });
  game.dragons = new DragonService({ entities: em, seed: 12345 });
  game.ignises = new IgnisService({ entities: em, world, seed: 12345 });
  game.guardians = new GuardianService({ entities: em, world, seed: 12345 });
  const plays = [];
  game.audioManager = { play: (id, volume) => { plays.push({ id, volume }); return true; } };
  const ids = {
    zombie: game.zombies.spawn([0.5, 11, 0.5], { source: 'test' }),
    dragon: game.dragons.summon('tarn:0:0', 0, 0, 0).id,
    ignis: game.ignises.summon('tarn:0:0', 4, 4, 1, 11).id,
    guardian: game.guardians.summon('rc:0:0', 8, 8, 0, 11).id,
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

test('受击音: 丧尸与飞龙零回归（丧尸无受击音、飞龙仍无受击音）', () => {
  const { game, plays, ids } = hitFixture();
  // ⚠️ 用户只点名焰魔与守卫 ⇒ 另两类不得顺手加音（那会改变机枪连射的听感）
  game.damageEntity(ids.zombie, 25, 1000);
  assertEqual(plays.length, 0, `丧尸受击不配音，实际 ${JSON.stringify(plays)}`);
  game.damageEntity(ids.dragon, 25, 1000);
  assertEqual(plays.length, 0, `飞龙受击不配音，实际 ${JSON.stringify(plays)}`);
  assertTrue(game.zombies.get(ids.zombie).health === ZOMBIE.health - 25, '前置：丧尸真的扣血了');
});