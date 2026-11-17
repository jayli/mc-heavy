// src/entities/turrets/turret-blueprint.js — M8：炮塔结构展开（代码生成）
// 同构层：无 DOM、无 three。结构照搬 mc-lite `TurretPlacementHandler.place()`
// （`:97-106` 实测读源）：3×3 `iron_ore` 底座（y=origin.y）+ 中心两格 `obsidian` 柱
// （y+1、y+2），合计 **11 格**。⚠️ **本仓库的 dy 整体上移一格**（底座 dy=1、柱 dy=2/3），
// 理由见 `BASE_DY` 的注释 —— 这是实施期实测发现的计划缺陷，已记进 M8 验收报告偏离表。
//
// **不 fetch JSON** —— mc-lite 也是硬编码结构（没有 turret.json），与巢穴的
// `zombie_nest.json` 蓝图不同。故本模块无「蓝图加载失败 → invalid-blueprint」这条路径。
//
// 蓝图是**只读**的：只做坐标/id 展开，不持有体素数据、不复制第二份方块真相（红线 1）。
import { WORLD_MIN_Y, WORLD_MAX_Y } from '../../voxel/constants.js';

/** 底座材质与柱子材质（mc-lite `place()` 的 `iron_ore` / `obsidian`） */
const BASE_BLOCK = 'iron_ore';
const PILLAR_BLOCK = 'obsidian';
/**
 * 底座层相对 origin 的高度 = **1**（不是 0）。
 *
 * ⚠️ **实测修正了规格 §3.1 的「底座 y=origin.y」**（实施期发现的阻断级矛盾）：
 * `origin` 是玩家右键命中的**地面方块格**（CLAUDE.md 活跃约束：多格结构的 origin =
 * `blockPos` 而非 `prevPos`，与 M7 巢穴同一调用点），它是 **solid** 的；而 `place()` 的
 * `occupied` 预检要求 11 格全为空气。底座若落在 `origin.y` 就与地面格自身冲突 →
 * **任何位置都放不下去**（实测 `reason:'occupied'` 恒成立，炮塔功能完全不可用）。
 *
 * mc-lite 的口径正好相反：`_getBlockPositionFromHit()`（`PlayerInteraction.js:216-253`）
 * 返回的是命中方块 **+ 法线**（相邻的空气格），且 `canPlace()`（`:50-63`）要求该格为空气
 * —— 即底座**坐在地面方块之上**，从不替换地形。巢穴之所以没这个问题，是因为它的 JSON
 * 蓝图相对 y 从 **1** 起（实测 `zombie_nest.json` 的 min y = 1）。
 *
 * 故取「底座 dy=1」：既保住 CLAUDE.md 的 origin 口径（`placeBlock()` 与巢穴共用同一
 * `target.blockPos` 入参），又与 mc-lite 的几何**完全等价** —— mc-lite 的 pivot =
 * 空气格 y + `PIVOT_HEIGHT_OFFSET` = `origin.y + 1 + 3.3`，与本仓库
 * `origin.y + BASE_DY + 3.3` 逐位相同。
 *
 * ⚠️ **本注释里的「origin 是 solid 地面格」有一个前提**（v3.13）：`TurretService.place()`
 * 入口会先把 origin 归一到地面格（`_groundOrigin`）—— 主射线对「非空气且非水」一律命中，
 * 地面上长草时传进来的是**草格**，不下沉就会把底座放到「草格+1」而悬空
 * （用户 2026-11-18 报告）。蓝图本身不变，归一只在服务层。
 */
export const BASE_DY = 1;
/** 柱子高度 2 格 → 锚点在 origin.y + BASE_DY + 2 */
const PILLAR_HEIGHT = 2;
/** 底座半边长 1 → 3×3 */
const BASE_HALF = 1;

/**
 * @param {ReturnType<import('../../voxel/block-registry.js').createRegistry>} registry
 * @returns {{changesAt: Function, criticalAt: Function, boundsAt: Function, inWorldBounds: Function}}
 */
export function createTurretBlueprint(registry) {
  const baseId = registry.idOf(BASE_BLOCK);
  const pillarId = registry.idOf(PILLAR_BLOCK);
  // 展开相对坐标：3×3 底座（dy=0）+ 中心柱（dy=1..2）
  const expanded = [];
  for (let dx = -BASE_HALF; dx <= BASE_HALF; dx++) {
    for (let dz = -BASE_HALF; dz <= BASE_HALF; dz++) {
      expanded.push({ x: dx, y: BASE_DY, z: dz, id: baseId });
    }
  }
  for (let dy = BASE_DY + 1; dy <= BASE_DY + PILLAR_HEIGHT; dy++) {
    expanded.push({ x: 0, y: dy, z: 0, id: pillarId });
  }
  const criticalRel = { x: 0, y: BASE_DY + PILLAR_HEIGHT, z: 0 };

  return {
    /** 11 个写入项（origin 平移）。不带 blockEntity —— 锚点富状态由 service 附加。 */
    changesAt(origin) {
      return expanded.map((b) => ({
        x: b.x + origin[0], y: b.y + origin[1], z: b.z + origin[2], id: b.id, meta: 0,
      }));
    },
    /** 锚点 = 最高 obsidian 上格（origin.y + 2） */
    criticalAt(origin) {
      return {
        x: criticalRel.x + origin[0], y: criticalRel.y + origin[1], z: criticalRel.z + origin[2],
        id: pillarId,
      };
    },
    /**
     * 占地 AABB（玩家重叠判定）。方块占据 [x, x+1)，故 max 边界 +1（与 M7 nest-blueprint
     * 同口径 —— 两处各写一套换算会漂移出「巢穴放得进去炮塔放不进去」的撕裂）。
     */
    boundsAt(origin) {
      return {
        minX: -BASE_HALF + origin[0], maxX: BASE_HALF + 1 + origin[0],
        minY: BASE_DY + origin[1], maxY: BASE_DY + PILLAR_HEIGHT + 1 + origin[1],
        minZ: -BASE_HALF + origin[2], maxZ: BASE_HALF + 1 + origin[2],
      };
    },
    /** 世界高度越界检查（place() 的 'bounds' 预检用）：结构任一格落在 [WORLD_MIN_Y, WORLD_MAX_Y) 之外。 */
    inWorldBounds(origin) {
      const b = this.boundsAt(origin);
      return b.minY >= WORLD_MIN_Y && b.maxY <= WORLD_MAX_Y;
    },
  };
}
