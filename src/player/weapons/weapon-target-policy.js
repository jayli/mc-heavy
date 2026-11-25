// src/player/weapons/weapon-target-policy.js — 武器专属可破坏判定（M4 规格 §4.2）
// 无 three 的纯谓词模块；武器规则不塞入通用 BlockRegistry，用名字集合表达。
// bedrock（全局「不可破坏」，走 `indestructibleTable`）对所有枪械不可破坏。
//
// M8：不可破坏判定改读 registry 单一权威（`indestructibleTable`）。此前 `IMMUNE_NAMES`
// 字面量与 `blocks-data.js` 的 `indestructible` 字段是同一事实的两个副本 → 漂移风险。
// ⚠️ 既有 `IMMUNE_NAMES` 含 `playground_block` / `playground_center_block`，收敛后这两项改由
// `indestructibleTable` 提供，而它们在 **M9** 才登记进表（登记 indestructible 与「移出背包」
// 必须成对做）。故 **M8 期间枪械仍可破坏创造台两项** —— 这是 M8 的一处行为变更，
// 已记进 M8 验收报告偏离表，M9 登记后自动恢复不可破坏。
//
// ⚠️ **v2.90：`end_stone` 的武器专属免疫已按用户要求关闭**（「end_stone 原来的设定是不可被
// 枪械消灭，把这个设定去掉」）。该名单因此**清空但机制保留** —— 它是「武器专属收紧」的
// 唯一扩展点（不属于全局不可破坏语义、故不进 `indestructibleTable`），将来要再收紧某个方块
// 时往这里加名字即可，不必重建判据。
//
// ⚠️ **关闭的副作用面比堡垒大**（实测，勿凭直觉以为只影响废弃堡垒）：`end_stone` 同时是
// `fillColumn` 的**水底层**（`terrain.js`：h<SEA_Y 的列在 h-1 铺 end_stone）与 `landmarks.js`
// 各地标的**岩石基础层底**（rockBaseY-11 / rockBaseY-12）。故现在枪械/MAG7 能打穿湖海底与
// 地标基座 —— 这是用户要的「也可以被消除」的直接后果，不是缺陷。

/**
 * 武器专属不可破坏名单（不属于全局「不可破坏」语义，故不进 indestructibleTable）。
 *
 * ⚠️ **当前为空**（v2.90 用户裁定关闭 end_stone 免疫）。保留本集合而不是删掉判据：
 * 它是这一类收紧的唯一扩展点，删了将来要加回来就得重建 `isWeaponDestructible` 的第三条分支。
 */
const WEAPON_ONLY_IMMUNE = new Set([]);

/**
 * 枪械（手枪/加特林）可否破坏该方块。
 * DDA 已跳过水，故手枪/加特林实际不会命中水；此处仅按名字语义判定。
 * @param {number} id @param {ReturnType<import('../../voxel/block-registry.js').createRegistry>} registry
 */
export function isWeaponDestructible(id, registry) {
  if (registry.idOf('air') === id) return false;
  if (registry.isIndestructible(id)) return false;   // bedrock（M9 追加 playground 两项）
  return !WEAPON_ONLY_IMMUNE.has(registry.nameOf(id));
}

/**
 * MAG7 体积扫描候选判定。水可通过（mc-lite 语义：MAG7 可把水作为候选并删除）。
 * @param {number} id @param {ReturnType<import('../../voxel/block-registry.js').createRegistry>} registry
 */
export function isMag7Candidate(id, registry) {
  return isWeaponDestructible(id, registry);
}

/**
 * 枪械（pistol / minigun / carbine）可否**射穿**该方块 —— 即「子弹不被它挡住」。
 *
 * 用户 2026-11-25：「射击到藤蔓、地面上的蘑菇、枯草方块的时候，要求可以射穿……
 * 这些装饰性非实心（即玩家无法踩上去的方块，玩家无法跟他发生碰撞）的方块」。
 *
 * 判据 = **转调 `registry.isPlant`**（`solidTable=0 && cullTable=cutout`，v3.13 为炮塔落地新增）：
 * 它正好是「无碰撞的装饰件」这一类（9 个花草族 + bush_grass + hanging_lamp），
 * 且**派生而非名字白名单** ⇒ 新植物按既有口径声明即自动纳入（红线 1）。
 *
 * ⚠️ **不得在这里重写 `solidTable=0 && cutout`**：那是第二份判据，将来改 isPlant 时本处静默不跟。
 * ⚠️ **玻璃/树叶/云/台阶/栏杆/仙人掌不在此列**（它们 `solid:true`，玩家撞得上）——
 * 判据不是「透明就放行」也不是「cutout 就放行」，test-weapons.js 用玻璃与树叶两条钉住。
 * ⚠️ 水与两个 alias（`mine_cart`/`bed_alias_block`）刻意不算：水本就被主 DDA 跳过，
 * 而矿车在世界里是**实体**（不写方块）、床已从背包移除。
 *
 * 本函数存在的意义是给「枪械可射穿」一个命名入口（与 `isWeaponDestructible` 并列）：
 * 将来若要与 isPlant 分道（例如保住吊灯），改这一处即可。
 *
 * @param {number} id @param {ReturnType<import('../../voxel/block-registry.js').createRegistry>} registry
 * @returns {boolean}
 */
export function isGunPassThrough(id, registry) {
  return registry.isPlant(id);
}
