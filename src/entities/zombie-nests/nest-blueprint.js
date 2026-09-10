// src/entities/zombie-nests/nest-blueprint.js — M7 巢穴蓝图：只读 JSON → 坐标展开 + 关键格校验
// Worker 同构：本文件不得 import three（同构层，见 tools/check-architecture.mjs）。
// 蓝图是**只读**蓝图（M7 规格 §1）：`zombie_nest.json` 描述结构形状，蓝图本身不写入世界 ——
// 写入由 ZombieNestService 经一次 WorldEditor.setBlocks 事务完成。这里只做坐标/id 展开与校验，
// 不持有体素数据、不复制第二份方块真相（红线 1）。
import { WORLD_MIN_Y, WORLD_MAX_Y } from '../../voxel/constants.js';

const BLUEPRINT_URL = '/assets/structures/zombie_nest.json';
/** 关键方块名：mc-lite 巢穴顶端唯一的 gold_block（被破坏即巢穴失效）。 */
const CRITICAL_BLOCK = 'gold_block';

/**
 * 抛出的蓝图错误带 `code`，供 place() 转成固定 reason（M7 规格 §2 的 'invalid-blueprint'）。
 * @param {string} message
 */
function blueprintError(message) {
  const err = new Error(message);
  err.code = 'invalid-blueprint';
  return err;
}

/**
 * 纯函数：解析已加载的 JSON 数据 → 蓝图访问器（可测，不依赖 fetch）。
 *
 * 校验「恰有一个最高关键方块」（M7 规格 §1/§2）：
 * - 蓝图必须非空；
 * - 最高层（maxY）必须**恰好一个**方块，且它是 `gold_block` —— 否则无法确定唯一锚点，
 *   巢穴的「关键方块被破坏即失效」语义无从谈起（两个最高格 → 不知该订阅哪个）。
 * 任何方块名在 registry 里查不到 id 也视为蓝图损坏。
 *
 * @param {ReturnType<import('../../voxel/block-registry.js').createRegistry>} registry
 * @param {{blocks: Array<{x:number,y:number,z:number,type:string,direction?:number}>}} data
 * @returns {{changesAt: (origin:[number,number,number]) => Array<{x,y,z,id,meta}>,
 *            criticalAt: (origin:[number,number,number]) => {x,y,z,id},
 *            boundsAt: (origin:[number,number,number]) =>
 *              {minX,maxX,minY,maxY,minZ,maxZ}}}
 */
export function parseNestBlueprint(registry, data) {
  const blocks = data?.blocks;
  if (!Array.isArray(blocks) || blocks.length === 0) throw blueprintError('蓝图为空');

  // 展开：相对坐标 + registry id。任一 type 名查不到 id → 蓝图损坏。
  const expanded = [];
  let maxY = -Infinity;
  for (const b of blocks) {
    const id = registry.idOf(b.type);
    if (id === undefined) throw blueprintError(`未知方块名 ${b.type}`);
    expanded.push({ x: b.x, y: b.y, z: b.z, id, meta: b.direction ?? 0 });
    if (b.y > maxY) maxY = b.y;
  }

  // 唯一最高格校验
  const top = expanded.filter((b) => b.y === maxY);
  if (top.length !== 1) throw blueprintError(`最高层有 ${top.length} 个方块，须恰一个`);
  const criticalRel = top[0];
  const criticalId = registry.idOf(CRITICAL_BLOCK);
  if (criticalRel.id !== criticalId) throw blueprintError(`最高格不是 ${CRITICAL_BLOCK}`);

  return {
    /**
     * 绝对坐标的 38 个方块写入项（origin 平移）。
     * 注意：不带 blockEntity —— 锚点富状态由 ZombieNestService 在 critical 那一格附加。
     */
    changesAt(origin) {
      return expanded.map((b) => ({
        x: b.x + origin[0], y: b.y + origin[1], z: b.z + origin[2], id: b.id, meta: b.meta,
      }));
    },
    /** 绝对坐标的关键方块（锚点落点）。 */
    criticalAt(origin) {
      return {
        x: criticalRel.x + origin[0], y: criticalRel.y + origin[1], z: criticalRel.z + origin[2],
        id: criticalId,
      };
    },
    /**
     * 占地 AABB（玩家重叠判定用）。方块占据 [x, x+1)，故 max 边界 +1。
     * 用于 place() 的 'bounds'（世界高度越界）与 'player-overlap' 预检。
     */
    boundsAt(origin) {
      let minX = Infinity, minY = Infinity, minZ = Infinity;
      let maxX = -Infinity, maxY2 = -Infinity, maxZ = -Infinity;
      for (const b of expanded) {
        if (b.x < minX) minX = b.x; if (b.x > maxX) maxX = b.x;
        if (b.y < minY) minY = b.y; if (b.y > maxY2) maxY2 = b.y;
        if (b.z < minZ) minZ = b.z; if (b.z > maxZ) maxZ = b.z;
      }
      return {
        minX: minX + origin[0], maxX: maxX + 1 + origin[0],
        minY: minY + origin[1], maxY: maxY2 + 1 + origin[1],
        minZ: minZ + origin[2], maxZ: maxZ + 1 + origin[2],
      };
    },
    /** 世界高度越界检查（place() 的 'bounds' 预检用）：结构任一格落在 [WORLD_MIN_Y, WORLD_MAX_Y) 之外。 */
    inWorldBounds(origin) {
      const b = this.boundsAt(origin);
      return b.minY >= WORLD_MIN_Y && b.maxY <= WORLD_MAX_Y;
    },
  };
}

/**
 * 加载真实蓝图（fetch + 缓存）。失败 → 抛 invalid-blueprint（调用方转 reason）。
 * 模块级缓存：蓝图只读不变，同进程只 fetch 一次（与 structure-json.js 同手法）。
 * @param {ReturnType<import('../../voxel/block-registry.js').createRegistry>} registry
 * @returns {Promise<ReturnType<typeof parseNestBlueprint>>}
 */
let cache = null;
export async function loadNestBlueprint(registry) {
  if (cache) return cache;
  const res = await fetch(BLUEPRINT_URL);
  if (!res.ok) throw blueprintError(`蓝图加载失败 ${res.status}`);
  const data = await res.json();
  cache = parseNestBlueprint(registry, data);
  return cache;
}
