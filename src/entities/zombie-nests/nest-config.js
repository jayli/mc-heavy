// src/entities/zombie-nests/nest-config.js — M7：巢穴冻结玩法数据（M7 规格 §2）
//
// 同构层：**无 DOM、无 three、不新增 Worker**（`npm run check:arch` 静态门守）。
// 本文件是巢穴玩法数值的**唯一权威** —— service / controller / 测试都从这里派生，
// 不得各自写字面量（红线 1：同一事实的多个副本会漂移）。数值逐项对齐 mc-lite
// （`ZombieNest.js` 实测读源，非推断）。

/** 巢穴玩法数据 */
export const NEST = Object.freeze({
  /** 全局最多 8 个巢穴（mc-lite 同口径）。跨 column 卸载与重启仍有效 —— 靠 edits store 枚举锚点 */
  maxNests: 8,
  /** 刷怪尝试间隔 8 秒（mc-lite `spawnInterval`）。满额或无合法位置仍写回 lastSpawnAt，避免每帧重试 */
  spawnIntervalMs: 8000,
  /**
   * 刷怪扫描偏移（mc-lite `spawnOffsets` 顺序照搬）：先四个距离 3 的正交偏移，
   * 再四个距离 2√2 的对角偏移。**顺序固定** —— 首个合法位置即选中，改顺序会改变刷怪点分布。
   */
  spawnOffsets: Object.freeze([
    { x: 0, z: 3 }, { x: 3, z: 0 }, { x: 0, z: -3 }, { x: -3, z: 0 },
    { x: 2, z: 2 }, { x: 2, z: -2 }, { x: -2, z: 2 }, { x: -2, z: -2 },
  ]),
  /** 每个偏移按 dy = 3..-2 降序尝试，合计**六层**（mc-lite 同口径）。不是笼统的「半径 3 / 五层」 */
  spawnDyTop: 3,
  spawnDyBottom: -2,
});

/** 受控创造模式选择入口的物品名（M7 规格 §2：不扩展 Hotbar/Inventory Epic） */
export const NEST_ALIAS_BLOCK = 'zombie_nest_alias_block';
