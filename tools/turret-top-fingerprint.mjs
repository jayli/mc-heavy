// tools/turret-top-fingerprint.mjs — 炮塔塔顶几何烘焙的参数、指标与输入指纹
//
// 唯一权威（红线 1）：烘焙脚本 `bake-turret-top.mjs` 与数据契约门 `check-data.mjs` 都从
// 这里 import，不得各写一份。手法照 `turret-armor-fingerprint.mjs` / `guardian-fingerprint.mjs`。
//
// 素材**入库**（`assets/turret/src/TankCannon.obj`）⇒ 指纹不依赖仓库外文件，
// 任何机器 `npm run check` 结果一致。
// ⚠️ **不放 `assets/textures/`** —— 那里被 `build-atlas` 递归扫描，源模型会变成巨型 tile。
//
// ⚠️ node 侧模块（要读文件），不进 `src/`，浏览器不消费。纯函数在
// `turret-top-parse.mjs`（无 node: 依赖），本模块从它 re-export 供 node 侧一站式 import。
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  TURRET_TOP_PARAMS, TURRET_TOP_ARMOR, TURRET_TOP_SOLID,
  parseObj, splitParts, buildPartGeometry, zoneOf, geomNormal, partOf,
} from './turret-top-parse.mjs';

export {
  TURRET_TOP_PARAMS, TURRET_TOP_ARMOR, TURRET_TOP_SOLID,
  parseObj, splitParts, buildPartGeometry, zoneOf, geomNormal, partOf,
};

const ROOT = path.resolve(import.meta.dirname, '..');

/** 烘焙输入（入库的源模型） */
export const TURRET_TOP_SRC = path.join(ROOT, 'assets', 'turret', 'src', 'TankCannon.obj');
/** 产物：几何 JSON（运行期消费） */
export const TURRET_TOP_JSON = path.join(ROOT, 'assets', 'turret', 'turret-top.json');
/** 产物：指纹与指标 */
export const TURRET_TOP_META = path.join(ROOT, 'assets', 'turret', 'turret-top.meta.json');

/**
 * 冻结指标（spec §7.1 实测表）。
 *
 * ⚠️ **顶点数依赖焊接口径**：纯色部件按「模型坐标+法线 toFixed(4)」焊接。
 * 实测 toFixed(3)/(4)/(6) 三档同结果 ⇒ 无容差歧义。
 * ⚠️ **不得改用 OBJ 索引对 `(vi,vni)`**：导出器有 8 组「同坐标同法线但不同 vn 索引」
 * 的冗余，那样 barrel 会得 1340 而非 1332。
 */
export const TURRET_TOP_METRICS = Object.freeze({
  /** 源模型总量 */
  sourceFaces: 2128,
  sourcePositions: 2192,
  sourceNormals: 1131,
  sourceUvs: 1194,
  /** 被排除的车体裙板面数 */
  hullFaces: 519,
  /** 产物八部件合计 */
  productFaces: 1609,
  triangleCount: 3434,
  vertexCount: 5527,
  /**
   * 逐部件三角数（**含切口封口面**）。
   * ⚠️ 装甲部件比「原面数×2」多出来的三角就是封口：源 TankBase 闭合，按 bbox 切开后
   * 切口必须补面，否则成开放壳、渲染时从切口看穿（用户实玩缺陷，2026-11-18）。
   */
  triangles: Object.freeze({
    cheek: 308, mantlet: 134, deckMid: 52, ring: 364, nose: 656,
    podR: 576, podL: 632, barrel: 712,
  }),
  /** 逐部件顶点数 */
  vertices: Object.freeze({
    cheek: 590, mantlet: 249, deckMid: 82, ring: 612, nose: 1222,
    podR: 960, podL: 480, barrel: 1332,
  }),
  /** 逐部件各区面数（内容级判据，不经过 zoneOf 自身 ⇒ 分类退化直接红） */
  zoneFaces: Object.freeze({
    cheek: Object.freeze({ front: 8, side: 68, top: 64 }),
    mantlet: Object.freeze({ front: 16, side: 12, top: 29 }),
    deckMid: Object.freeze({ front: 0, side: 0, top: 14 }),
    ring: Object.freeze({ front: 75, side: 38, top: 10 }),
    nose: Object.freeze({ front: 215, side: 62, top: 4 }),
  }),
  /** 炮口世界 z（= TURRET.muzzleOffsetZ，弹道零改动的判据） */
  muzzleZ: 3.5,
  /**
   * 炮管尾端埋入鼻段的最小量（格）。实测 0.3106；阈值取 0.2（低于实测、远高于 0）。
   * ⚠️ 这条是「炮管尾部前移造成真实缝隙」的唯一防线 —— 那种改动下
   * 顶点数 / zmax / UV 全不变，只有埋入量会掉。
   */
  minBarrelEmbed: 0.2,
});

/**
 * 输入指纹：源 OBJ 内容 sha256 + 烘焙参数 sha256。
 *
 * ⚠️ **已知盲区**：只改烘焙**算法**而不动源文件/参数时指纹不变 ⇒ 必须靠
 * `TURRET_TOP_METRICS` 的内容级判据（炮口 z / 零退化 / 逐面拆顶点 / 各区面数）兜住。
 * @returns {string}
 */
export function turretTopInputFingerprint() {
  if (!fs.existsSync(TURRET_TOP_SRC)) throw new Error(`[炮塔塔顶] 源模型缺失：${TURRET_TOP_SRC}`);
  const sourceSha256 = createHash('sha256').update(fs.readFileSync(TURRET_TOP_SRC)).digest('hex');
  const paramsSha256 = createHash('sha256')
    .update(JSON.stringify({
      scale: TURRET_TOP_PARAMS.scale,
      pivotY: TURRET_TOP_PARAMS.pivotY,
      zoneNyThreshold: TURRET_TOP_PARAMS.zoneNyThreshold,
      zones: TURRET_TOP_PARAMS.zones,
      armor: TURRET_TOP_ARMOR,
      solid: TURRET_TOP_SOLID,
    }))
    .digest('hex');
  return `${sourceSha256.slice(0, 16)}:${paramsSha256.slice(0, 16)}`;
}

/** 读产物 JSON（门禁比对用）；不存在返回 null */
export function readTurretTopJson() {
  if (!fs.existsSync(TURRET_TOP_JSON)) return null;
  return JSON.parse(fs.readFileSync(TURRET_TOP_JSON, 'utf8'));
}
