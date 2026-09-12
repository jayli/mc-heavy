// src/entities/playground/playground-config.js — M9：创造台冻结数据（规格 §2）
// 同构层：**无 DOM、无 three**（tools/check-architecture.mjs 静态门守，红线 8/10）。
// 数值逐项实测自 mc-lite `PlaygroundService.js`（语义移植，不是实现照搬 —— CLAUDE.md）。
import { WORLD_MIN_Y, WORLD_MAX_Y } from '../../voxel/constants.js';

/**
 * 创造台冻结数值。两个消费者（`playground-service.js` 与 `tools/check-data.mjs` 的
 * `[创造台]` 门禁）共用本常量 —— 各写一份字面量会漂移出「门禁放行但实现尺寸不对」。
 */
export const PLAYGROUND = Object.freeze({
  /** 平台边长 54 格（mc-lite `playgroundSize = 54`，共 54×54 = 2916 格） */
  size: 54,
  /** 平台上方净空 10 格（mc-lite `requiredClearance = 10`） */
  clearance: 10,
  /** 距玩家 10 格（mc-lite `distance = 10`，东侧优先、失败改西侧） */
  distance: 10,
  /**
   * 玩家在平台内的 Y 跨度 20 格（mc-lite `isPlayerInPlayground` 的 `maxY = origin.y + 20`）。
   * ⚠️ 它比 `clearance` 大 —— 玩家可以在净空区内往上叠模型，判据须用这个更宽的跨度，
   * 否则玩家站在自己雕的高处就能把脚下平台关掉。
   */
  heightSpan: 20,
  /**
   * ⚠️ **安全高度搜索上界 = 本仓库的 `WORLD_MAX_Y`（96），不是 mc-lite 的 200**。
   * mc-lite 世界高度 0~255；本仓库 `-32~96`（`voxel/constants.js`）。照搬 200 会让搜索
   * 恒超出世界顶 → `WorldData.getBlockId` 对上界返回 0（air）→ 判「无重叠」→ 平台写在
   * 越界高度上（`setBlocks` 全部 skipped），表现为「创造台永远创建不出来」。
   */
  maxSearchY: WORLD_MAX_Y,
  /** 导入模型的 Y 越界下界（mc-lite 是 `y < 0`，本仓库是 `WORLD_MIN_Y`） */
  minSearchY: WORLD_MIN_Y,
});

/** blockEntity 的 kind（与 `zombie-nest` / `turret` 并列，共用 edits 通道 —— DR-17） */
export const PLAYGROUND_KIND = 'playground';
/** 平台方块名（其余平台格） */
export const PLAYGROUND_BLOCK = 'playground_block';
/** 中心标记块名（携带 `{kind,id,origin,size}` 锚点） */
export const PLAYGROUND_CENTER_BLOCK = 'playground_center_block';
