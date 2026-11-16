// src/entities/bosses/boss-registry.js — Boss 名册：「哪张地图有哪些 Boss」的唯一权威
//
// 同构层：**无 DOM、无 three、无 Worker**（`check:arch` 的 `ISOMORPHIC_DIRS` 静态门守）。
//
// ## 名册是数据，不是代码分支
//
// 用户 2026-11-03 的要求是「增加一个**召唤每个地图 Boss** 的动作」——一个能力，不是只为龙
// 写死的逻辑。故「哪张地图有哪些 Boss」落在这一张表里：加 Boss2 或给别的地图加 Boss =
// 在这里加一行 + 让对应的 service 实现 `summon`/`slotOccupied` 契约，**不改召唤流程**。
//
// ## 召唤流程（`Game.summonBoss()`，本文件只提供数据）
//
// 1. `bossMapAt(玩家坐标, seed)` → 玩家所在地图（不在任何地标级地图 → 提示「这里没有 Boss」）；
// 2. 查本表拿该地图的名册（空名册 → 同上）；
// 3. **按 slot 升序**找第一个空槽（`slotOccupied` 为假）→ 在该地图中心召唤；
// 4. 全部槽位都占着 → 提示「Boss 都在了」，什么都不召唤。
//
// ⚠️ **地图若带 `summonY`（强制召唤高度），落点用它而不是玩家 y**：大竞技场要求
// 「任意层按 B 都召到最高层中心」；其余地图（高台地带）刻意用玩家 y 就近取地面
//（那里有多层可站结构，不传会落到与玩家相距 30+ 格的高度）。
//
// ⚠️ **「Boss 死掉后再按 B 才会召唤」是这套流程的自然结果，不需要额外状态**：
// 死亡即 despawn ⇒ `slotOccupied` 变假 ⇒ 该槽位重新可召。故 v2.41 的永久死亡标记
// （`meta.dragonDead`）已随本次改动移除。
import { DRAGON_TYPE } from '../dragons/dragon-config.js';
import { IGNIS_TYPE } from '../ignis/ignis-config.js';
import { GUARDIAN_TYPE } from '../guardian/guardian-config.js';

/**
 * Boss 槽位描述。
 * @typedef {{
 *   slot: number,     槽位下标（0 = Boss1，1 = Boss2；召唤按此升序）
 *   type: string,     实体类型名（诊断/toast 文案用）
 *   service: string,  持有它的 service 在 `Game` 上的字段名（如 'dragons'）
 * }} BossSlot
 */

/**
 * 地图种类 → Boss 名册（**最多两个**，用户裁定）。
 *
 * ⚠️ **只列有 Boss 的地图**：`bossSlotsFor()` 对未登记的种类返回空数组，
 * 语义是「这张地图目前没有 Boss」——按 B 会提示「这里没有可召唤的 Boss」。
 * 刻意**不**为 CITY / SNOW / SHALLOW_TARN 写空数组条目：那会让「还没做」与
 * 「做了但故意没有」在表里长得一样。
 *
 * ⚠️ **名册长度不得超过 2**（单测钉住）：用户明确「一个或者两个 Boss（最多两个）」。
 */
export const BOSS_ROSTER = Object.freeze({
  // 高台地带：Boss1 = 祭坛飞龙，Boss2 = 焰魔（v2.55）
  // ⚠️ **顺序即召唤顺序**（按 slot 升序找第一个空槽）：用户 2026-11-05 裁定
  // 「飞龙先，焰魔后」，故飞龙恒为 slot 0。
  TARN: Object.freeze([
    Object.freeze({ slot: 0, type: DRAGON_TYPE, service: 'dragons' }),
    Object.freeze({ slot: 1, type: IGNIS_TYPE, service: 'ignises' }),
  ]),
  // 大竞技场（城东沙漠，v2.85 移植）：唯一 Boss = 焰魔（与高台地带的 Boss2 同一实体）。
  // ⚠️ **slot 0**（不是 1）：本图没有飞龙，焰魔就是这里的 Boss1（toast 文案「已召唤 Boss1」）。
  // ⚠️ **召唤点恒在顶层平台**：`bossMapAt` 给本图返回 `summonY`，`Game.summonBoss()` 据此
  //    无视玩家所在高度（用户裁定：任意层按 B 都召到最高层中心）。
  BURNING_ARENA: Object.freeze([
    Object.freeze({ slot: 0, type: IGNIS_TYPE, service: 'ignises' }),
  ]),
  // 废弃堡垒（城西沙漠）：唯一 Boss = 末影守卫。
  // ⚠️ **slot 0**：本图只有守卫，它就是这里的 Boss1（toast「已召唤 Boss1」）。
  // ⚠️ **召唤点恒在地牢上层房间**：`bossMapAt` 给本图返回 `summonY`（= floorY − 6），
  //    `Game.summonBoss()` 据此无视玩家所在高度（同大竞技场口径）。
  //    理由：三层地牢在引擎口径下互不连通，玩家从甲板竖井只能走到上层（spec §2.3.1）。
  RUINED_CITADEL: Object.freeze([
    Object.freeze({ slot: 0, type: GUARDIAN_TYPE, service: 'guardians' }),
  ]),
  // 围场（城南门外草地竞技场，v3.09）：唯一 Boss = 末影守卫（与废弃堡垒同一实体）。
  // 用户 2026-11-16：「在围栏内增加一个 boss 就是末影守卫，在围栏处按 B 召唤」。
  // ⚠️ slot 0：本图只有守卫（toast「已召唤 Boss1」）。
  // ⚠️ 召唤点恒在场地中心地板上方一格（`bossMapAt` 给本图返回 summonY）。
  // ⚠️ **两张图各一只 ⇒ `GUARDIAN.maxAlive` 必须 ≥ 2**，否则先在堡垒召了守卫
  //    再来围场按 B 会得「Boss 数量已达上限」（功能直接不可用）。
  ARENA: Object.freeze([
    Object.freeze({ slot: 0, type: GUARDIAN_TYPE, service: 'guardians' }),
  ]),
});

/** 每张地图的 Boss 槽位上限（用户裁定「最多两个」） */
export const BOSS_SLOTS_PER_MAP = 2;

/**
 * 某张地图的 Boss 名册（未登记 → 空数组）。
 *
 * @param {string} kind `BOSS_MAP_KINDS` 之一
 * @returns {readonly BossSlot[]}
 */
export function bossSlotsFor(kind) {
  return BOSS_ROSTER[kind] || Object.freeze([]);
}
