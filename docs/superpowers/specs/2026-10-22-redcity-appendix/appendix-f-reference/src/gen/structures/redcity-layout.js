// src/gen/structures/redcity-layout.js — RedCity 布局层：落点 / baseY / 影响域 / 点位分区 / 出生点
// 纯函数，Worker 同构（不得 import three）。常量唯一权威 = region-config.js。
import { generateHeight } from '../terrain.js';
import { SEA_Y } from '../../voxel/constants.js';
import {
  REDCITY_SIZE, REDCITY_TRANSITION, REDCITY_GAP, REDCITY_GROUND_FLOOR, REDCITY_BASE_Y_MAX,
} from './region-config.js';

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };

/**
 * 基准高度（spec §13.4.1）：沿 core 外圈一格、步长 4 采样有效自然高度 e=max(h, SEA_Y+1)，取中位；
 * 下限 SEA_Y+1-GROUND_FLOOR（=4，保证岛最低处是干地）；上限 REDCITY_BASE_Y_MAX（**钳制不抛错**——
 * 抛错会让极端 seed 的 GEN 整体失败；与烘焙期 dyMax 预算配对才保证装得进世界，见 REDCITY_DY_MAX_BUDGET）。
 * 〔实测〕seed 1–1500：1498 个为 4，2 个为 5（599、1491）。
 */
export function estimateBaseY(core, seed) {
  const e = (x, z) => Math.max(generateHeight(x, z, seed), SEA_Y + 1);
  const ring = [];
  for (let x = core.minX - 1; x <= core.maxX + 1; x += 4) { ring.push(e(x, core.minZ - 1)); ring.push(e(x, core.maxZ + 1)); }
  for (let z = core.minZ - 1; z <= core.maxZ + 1; z += 4) { ring.push(e(core.minX - 1, z)); ring.push(e(core.maxX + 1, z)); }
  const lower = SEA_Y + 1 - REDCITY_GROUND_FLOOR;
  return Math.min(Math.max(median(ring), lower), REDCITY_BASE_Y_MAX);
}

/**
 * 落点（spec §13.3.1）：固定 City 东侧，永远生成，无回退分支。City bounds 是闭区间，
 * 故 core.minX = city.maxX + 1 + GAP；influence = core ⊕ TRANSITION（地形整形 / 吞并 / 避让 / 水面门控的统一范围）。
 * @param {number} seed
 * @param {{maxX:number, centerZ:number}} city buildCityLayout 的结果
 */
export function buildRedCityLayout(seed, city) {
  const minZ = Math.round(city.centerZ - REDCITY_SIZE.Z / 2);
  const core = {
    minX: city.maxX + 1 + REDCITY_GAP, maxX: city.maxX + REDCITY_GAP + REDCITY_SIZE.X,
    minZ, maxZ: minZ + REDCITY_SIZE.Z - 1,
  };
  const influence = {
    minX: core.minX - REDCITY_TRANSITION, maxX: core.maxX + REDCITY_TRANSITION,
    minZ: core.minZ - REDCITY_TRANSITION, maxZ: core.maxZ + REDCITY_TRANSITION,
  };
  return { core, influence, baseY: estimateBaseY(core, seed), size: { ...REDCITY_SIZE } };
}

/**
 * 点位分区。core 内 `{zone:'core', edgeDistance:0, ox, oz}`（ox/oz = 相对 core 左上角的列偏移，直接索引产物）；
 * influence 内但 core 外 `{zone:'ring', edgeDistance:1..REDCITY_TRANSITION}`（到 core 的切比雪夫距离）；其余 null。
 * 不在这里算地表高度（那是 redcity-surface.js 的 getRedCitySurfaceY）。
 */
export function getRedCityInfo(wx, wz, redCity) {
  const c = redCity.core;
  const dx = wx < c.minX ? c.minX - wx : wx > c.maxX ? wx - c.maxX : 0;
  const dz = wz < c.minZ ? c.minZ - wz : wz > c.maxZ ? wz - c.maxZ : 0;
  const d = dx > dz ? dx : dz;
  if (d === 0) return { zone: 'core', edgeDistance: 0, ox: wx - c.minX, oz: wz - c.minZ };
  if (d <= REDCITY_TRANSITION) return { zone: 'ring', edgeDistance: d };
  return null;
}

/**
 * 出生点（x/z = 烘焙选定列的**方块中心**；y = 扫描起点的下界提示，不是最终站立位）。
 * ⚠️ `spawn.dy` 是相对 baseY 的行号（地面方块恰在 dy === ground[col]），站立位 = 地面方块顶面 = baseY + dy + 1。
 * 不是 baseY + ground + dy（那会多叠一个 ground）。
 */
export function getRedCitySpawnPoint(redCity, model) {
  const s = model.spawn;
  return { x: redCity.core.minX + s.ox + 0.5, y: redCity.baseY + s.dy + 1, z: redCity.core.minZ + s.oz + 0.5 };
}

/**
 * 从 yTop 向下扫首个「脚下 solid 且其上两格空气」的站立位（返回脚所在的 y）。
 * 容忍玩家日后在出生点上方建造；**不用 findSpawnY**（它从世界顶向下找，会落在塔顶/树冠）。
 * @param {(x:number,y:number,z:number)=>number} getId 方块 id 读出口（0 = 空气）
 */
export function scanDownForSpawn(getId, x, yTop, z, yMin = -31) {
  const bx = Math.floor(x), bz = Math.floor(z);
  for (let y = yTop; y > yMin; y--) {
    if (getId(bx, y - 1, bz) !== 0 && getId(bx, y, bz) === 0 && getId(bx, y + 1, bz) === 0) return y;
  }
  return null;
}
