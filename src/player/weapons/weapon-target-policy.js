// src/player/weapons/weapon-target-policy.js — 武器专属可破坏判定（M4 规格 §4.2）
// 无 three 的纯谓词模块；武器规则不塞入通用 BlockRegistry，用名字集合表达。
// bedrock / end_stone / 创造台两类方块对所有枪械不可破坏；end_stone_bricks 可破坏。
// 将创造台两类方块也排除在 MAG7 外是 M4 有意收紧的偏离（mc-lite 的 MAG7 只排
// end_stone/bedrock）——不允许武器破坏创造台基础方块。

const IMMUNE_NAMES = new Set(['bedrock', 'end_stone', 'playground_block', 'playground_center_block']);

/**
 * 枪械（手枪/加特林）可否破坏该方块。
 * DDA 已跳过水，故手枪/加特林实际不会命中水；此处仅按名字语义判定。
 * @param {number} id @param {ReturnType<import('../../voxel/block-registry.js').createRegistry>} registry
 */
export function isWeaponDestructible(id, registry) {
  const name = registry.nameOf(id);
  return name !== 'air' && !IMMUNE_NAMES.has(name);
}

/**
 * MAG7 体积扫描候选判定。水可通过（mc-lite 语义：MAG7 可把水作为候选并删除）。
 * @param {number} id @param {ReturnType<import('../../voxel/block-registry.js').createRegistry>} registry
 */
export function isMag7Candidate(id, registry) {
  return isWeaponDestructible(id, registry);
}
