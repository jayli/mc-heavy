// src/voxel/explosion.js — M8：爆炸计算（同构纯函数，规格 §2.1）
// **无 DOM、无 three、不走 Worker** —— 计算量 152 次 getBlockId（3×3×3 破坏 + 5×5×5 连锁），
// 且爆炸须与音效/特效同帧（理由记在设计文档 §4.5.5）。归属 voxel 层：纯体素查询，不是生成。
// 数值逐项对齐 mc-lite `ExplosionWorker.js`（3×3×3 破坏 / 5×5×5 连锁 / 500~1100ms 延迟）。
// ⚠️ mc-lite 的 TNT 运行时目前是坏的（`worldAccess` 未声明 → ReferenceError），故本文件的
// 对齐口径是「读源码 + 推断意图」，不是实测对齐 —— 验收报告的偏离表须如实记录。

/** 破坏范围半径（mc-lite dx/dy/dz ∈ [-1,1] → 3×3×3 = 27 格） */
const DESTROY_RADIUS = 1;
/** 连锁搜索半径（mc-lite [-2,2] → 5×5×5 = 125 格） */
const CHAIN_RADIUS = 2;
/** 连锁延迟区间（mc-lite `500 + Math.random() * 600`） */
const CHAIN_DELAY_MIN = 500;
const CHAIN_DELAY_RANGE = 600;

/**
 * 爆炸对实体的伤害半径与数值（mc-lite `PlayerInteraction.js:629-630`）。
 * 导出为单一权威 —— game.js 与测试共用，不得各写字面量（红线 1）。
 */
export const EXPLOSION_DAMAGE_RADIUS = 4;
export const EXPLOSION_DAMAGE = 50;

/**
 * 中心坐标 → 确定性散列（替代 mc-lite 的 `Math.random()`）。
 * **红线 2**：同 seed 两次生成须一致；随机延迟会让同一存档两次引爆的连锁时序不同。
 * 手法照 M6 排斥力 tie-break（质数加权散列）。
 * @param {[number,number,number]} center @returns {number} [0, 1)
 */
function centerHash(center) {
  const [x, y, z] = center;
  const code = Math.abs(
    (Math.trunc(x) * 73856093) ^ (Math.trunc(y) * 19349663) ^ (Math.trunc(z) * 83492791),
  );
  return (code % 100000) / 100000;
}

/**
 * 计算一次爆炸的破坏范围与连锁 TNT。
 * @param {{world: import('./world-data.js').WorldData,
 *          registry: ReturnType<import('./block-registry.js').createRegistry>,
 *          center: [number, number, number]}} p
 * @returns {{center: [number,number,number],
 *            destroy: Array<{x:number,y:number,z:number}>,
 *            chain: Array<{x:number,y:number,z:number,delayMs:number}>}}
 */
export function computeExplosion({ world, registry, center }) {
  const bx = Math.floor(center[0]), by = Math.floor(center[1]), bz = Math.floor(center[2]);
  const outCenter = [bx, by, bz];
  const destroy = [];
  for (let dx = -DESTROY_RADIUS; dx <= DESTROY_RADIUS; dx++) {
    for (let dy = -DESTROY_RADIUS; dy <= DESTROY_RADIUS; dy++) {
      for (let dz = -DESTROY_RADIUS; dz <= DESTROY_RADIUS; dz++) {
        const x = bx + dx, y = by + dy, z = bz + dz;
        const id = world.getBlockId(x, y, z);
        // 空气格也进列表：WorldData.setBlocks 会判 no-change 跳过，不需要在此过滤
        // （让「破坏 27 格」的口径与 mc-lite 的 blocksToDestroy 一致）
        if (id !== 0 && registry.isIndestructible(id)) continue;  // M8 单一权威门控
        destroy.push({ x, y, z });
      }
    }
  }
  const chain = [];
  const tntId = registry.idOf('tnt');
  const hash = centerHash(outCenter);
  for (let dx = -CHAIN_RADIUS; dx <= CHAIN_RADIUS; dx++) {
    for (let dy = -CHAIN_RADIUS; dy <= CHAIN_RADIUS; dy++) {
      for (let dz = -CHAIN_RADIUS; dz <= CHAIN_RADIUS; dz++) {
        if (dx === 0 && dy === 0 && dz === 0) continue;  // 中心格由引爆路径自身移除
        const x = bx + dx, y = by + dy, z = bz + dz;
        if (world.getBlockId(x, y, z) !== tntId) continue;
        // 确定性抖动：同中心两次计算结果一致；同一批连锁里多个 TNT 的延迟各不相同
        // （偏移量参与散列 → 依次炸而非同时炸，手感对齐 mc-lite）
        const jitter = (hash + Math.abs(dx * 3 + dy * 5 + dz * 7) / 125) % 1;
        const delayMs = CHAIN_DELAY_MIN + Math.round(jitter * CHAIN_DELAY_RANGE);
        chain.push({ x, y, z, delayMs });
      }
    }
  }
  return { center: outCenter, destroy, chain };
}
