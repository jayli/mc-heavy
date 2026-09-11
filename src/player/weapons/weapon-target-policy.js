// src/player/weapons/weapon-target-policy.js — 武器专属可破坏判定（M4 规格 §4.2）
// 无 three 的纯谓词模块；武器规则不塞入通用 BlockRegistry，用名字集合表达。
// bedrock（全局「不可破坏」）与 end_stone（**武器专属**收紧）对所有枪械不可破坏；
// end_stone_bricks 可破坏。
//
// M8：不可破坏判定改读 registry 单一权威（`indestructibleTable`）。此前 `IMMUNE_NAMES`
// 字面量与 `blocks-data.js` 的 `indestructible` 字段是同一事实的两个副本 → 漂移风险。
// ⚠️ 既有 `IMMUNE_NAMES` 含 `playground_block` / `playground_center_block`，收敛后这两项改由
// `indestructibleTable` 提供，而它们在 **M9** 才登记进表（登记 indestructible 与「移出背包」
// 必须成对做）。故 **M8 期间枪械仍可破坏创造台两项** —— 这是 M8 的一处行为变更，
// 已记进 M8 验收报告偏离表，M9 登记后自动恢复不可破坏。

/** 武器专属不可破坏名单（不属于全局「不可破坏」语义，故不进 indestructibleTable） */
const WEAPON_ONLY_IMMUNE = new Set(['end_stone']);

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
