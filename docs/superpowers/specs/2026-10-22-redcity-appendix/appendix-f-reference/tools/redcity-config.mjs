// tools/redcity-config.mjs — RedCity 烘焙配置（**唯一权威**，烘焙脚本与 `check:data` 共用）：
//   skin / building 清单、(id:meta) → mc-heavy 方块映射、空气判定、烘焙参数、出生点判据参数。
// 〔实测〕按本文件口径烘焙：retained 244647 / dy -6..80 / spawn ox=138 oz=141 dy=-3（`npm run redcity` 复现）。
//
// ⚠️ 三个清单的语义互斥，勿混为一处（同 `NON_PLACEABLE_ITEMS` / `HIDDEN_FROM_INVENTORY` 的教训）：
//   - SKIN      = 岛体材质（投影时只保留地面往下 K 层，其余丢弃）
//   - BUILDING  = 建筑/装饰材质（地面以上无条件全保留，且参与刚性平移）
//   - 其余      = 既非 skin 也非 building（如 barrier）→ 丢弃
// 一个 (id,meta) 可以同时是 skin 与 building 吗？不可以：`isSkin` 与 `isBuildingMat` 的清单实测无交集
// （`tests/redcity-bake.spec.mjs` 的「skin 与 building 无交集」用例守着）。若将来加材质，先跑它。
import { REDCITY_GROUND_FLOOR } from '../src/gen/structures/region-config.js';

// ==================== skin 清单（spec §13.5.4 第 1 条：显式列表，不得隐式「其余」）====================

/** 任意 meta 都算 skin 的 id */
export const SKIN_ANY_META = Object.freeze([1, 2, 3, 4, 7, 12, 13, 16, 24, 48, 82, 88]);

/** 仅指定 meta 算 skin 的 id（其余 meta 走 building 或丢弃） */
export const SKIN_META_ONLY = Object.freeze({ 35: [8], 159: [8], 251: [8], 252: [8] });

/**
 * 是否岛体材质。
 * @param {number} key `(id << 4) | meta`
 */
export function isSkin(key) {
  const id = key >> 4, meta = key & 15;
  if (SKIN_ANY_META.includes(id)) return true;
  const list = SKIN_META_ONLY[id];
  return !!list && list.includes(meta);
}

// ==================== building 清单 ====================

/** 任意 meta 都算 building 的 id */
export const BUILDING_ANY_META = Object.freeze([
  20, 102, 160, 168, 98, 99, 5, 125, 126, 53, 67, 109, 134, 164,
  43, 44, 96, 85, 188, 139, 54, 118, 154, 145, 25, 198, 63, 64,
]);

/**
 * 是否建筑/装饰材质。
 *
 * ⚠️ `95:6`（粉色玻璃）**不算** building —— 它是樱花树冠的一部分（spec §13.5.2），
 * 按 skin 之外的「植被」处理：地面以上照样保留（保留规则不区分 building），
 * 但不参与刚性平移（树冠不该被当建筑整体搬动）。
 *
 * ⚠️ 这条与「映射成什么方块」**无关**（U3 裁定后 `95:6` 也映射为 `glass_block`）：
 * 空间角色（树冠 vs 玻璃墙）决定它是否参与刚性平移，材料映射决定它渲染成什么。
 * 两者是正交的两件事，勿因为「都是 glass_block」就把 `95:6` 归进 building。
 * @param {number} key
 */
export function isBuildingMat(key) {
  const id = key >> 4, meta = key & 15;
  if ([20, 102, 160].includes(id)) return true;
  if (id === 95) return meta !== 6;
  return BUILDING_ANY_META.includes(id);
}

// ==================== 映射表 ====================

/**
 * 规则表：**meta 特例在前、通配在后**（顺序是载荷性的，`mappingOf` 按序首个命中即返回）。
 * 每条 = `[id, meta|'*', mc-heavy 方块名]`。
 *
 * 依据 spec §13.5.2 的必补映射清单。未命中 → `DEFAULT_BLOCK`（`explicit: false`，
 * `check:data` 的覆盖率门禁据此统计）。
 */
export const MAPPING_RULES = Object.freeze([
  // 羊毛 / 混凝土：粉色系是樱花树冠，灰色系是岛体
  [35, 6, 'pink_wool'], [35, 13, 'grass'], [35, '*', 'light_gray_cloth'],
  [251, 6, 'pink_wool'], [251, 15, 'polished_blackstone_bricks'], [251, '*', 'light_gray_cloth'],
  [252, 6, 'pink_wool'], [252, 13, 'moss'], [252, 15, 'polished_blackstone_bricks'], [252, '*', 'light_gray_cloth'],
  [159, 5, 'moss'], [159, '*', 'light_gray_cloth'],
  // 玻璃（D6：全部用现成 glass_block）。
  // ⚠️ U3 裁定（2026-10-22）：粉色玻璃 `95:6` **也**用 `glass_block`，不换成 `pink_wool`。
  // 故这里不需要 `95:6` 的 meta 特例 —— 通配 `[95,'*']` 已覆盖。
  // 树冠的粉色仍由 `35:6`（粉羊毛 13,573 块）与 `251:6`/`252:6`（粉混凝土 16,370 块）承担，
  // 合计 29,943 块 —— 粉色辨识特征不丢（spec §13.7.4）。
  [95, '*', 'glass_block'],
  [20, '*', 'glass_block'], [102, '*', 'glass_block'], [160, '*', 'glass_block'],
  // 岛体岩层
  [82, '*', 'clay'], [1, '*', 'stone'], [13, '*', 'stone'], [16, '*', 'stone'], [7, '*', 'stone'],
  [2, '*', 'grass'], [3, '*', 'dirt'], [60, '*', 'dirt'], [208, '*', 'dirt'],
  [12, '*', 'sand'], [24, '*', 'sand'],
  [4, '*', 'cobblestone'], [48, '*', 'mossy_stone'], [88, '*', 'netherrack'], [80, '*', 'snow_block'],
  [9, '*', 'water'], [8, '*', 'water'],
  // 建筑主体
  [168, '*', 'oxidized_cut_copper'],   // 宝塔屋顶（U2 已裁定：接受偏亮青绿；不新增贴图、不做真实 1.12 色值校准）
  [98, '*', 'stone_bricks'], [99, '*', 'bricks'],
  [17, '*', 'wood'], [162, '*', 'dark_oak'], [18, '*', 'leaves'],
  ...[5, 125, 126, 53, 134, 164, 63, 64].map((i) => [i, '*', 'planks']),
  ...[43, 44, 67, 109, 139].map((i) => [i, '*', 'smooth_stone']),
  [96, '*', 'planks_step'], [85, '*', 'handrail'], [188, '*', 'handrailA'],
  // 植被 / 农作物 / 火把 → 统一 short_grass（cutout 通道，形状近似）
  ...[59, 141, 142, 175, 37, 38, 50].map((i) => [i, '*', 'short_grass']),
  // 家具 / 金属件
  [54, '*', 'chest'], ...[118, 154, 145, 25, 198].map((i) => [i, '*', 'iron']),
]);

/** 未命中规则的兜底（`explicit: false` → 计入覆盖率门禁的「未覆盖」） */
export const DEFAULT_BLOCK = 'stone';

/**
 * 映射 (id, meta) → mc-heavy 方块名。
 * @param {number} key `(id << 4) | meta`
 * @returns {{name: string, explicit: boolean}}
 */
export function mappingOf(key) {
  const id = key >> 4, meta = key & 15;
  for (const [ruleId, ruleMeta, name] of MAPPING_RULES) {
    if (ruleId === id && (ruleMeta === '*' || ruleMeta === meta)) return { name, explicit: true };
  }
  return { name: DEFAULT_BLOCK, explicit: false };
}

// ==================== 空气判定 ====================

/** 空气（含 barrier=166：不可见，烘焙丢弃；外部空气洪泛时当作可穿） */
export const isEmpty = (key) => (key >> 4) === 0 || (key >> 4) === 166;

// ==================== 烘焙参数 / 出生点判据参数 ====================

/**
 * 烘焙参数（唯一权威）。
 *
 * ⚠️ 这七个值是**实测/实玩标定值**，不是推导值（同 `SKY_TREE_CHANCE`、`BOB.amplitude` 的性质）：
 *   - `relief` 0.34：竖直压缩系数。实测它对预算几乎无影响（0.2/0.25/0.34/0.5 下 opaque 占比
 *     108/108/108/109%），**纯观感参数** —— 调它只为「宝塔不被压扁」与「台阶不太陡」的平衡。
 *   - `K` 2：地面往下保留层数。K=1 会让挑檐底部露空；K=3 多留 58,554 块但几何成本涨 5%。
 *   - `groundFloor` -5：= `REDCITY_GROUND_FLOOR`（`region-config.js`）。实测下限必须是 -5：
 *     取 -12 时边界台阶>2 的占比中位约 54%（撞破 R4），取 -5 时中位 0% / 最差 4.0%。
 *   - `decay` 2：岛外地面外推「每 2 格降 1」。
 *   - `pad` 1：建筑 footprint 外扩（刚性平移分量继承脚下平移场 S 的涂色范围 = footprint ⊕ pad；**不压平地面**，spec §14.2）。
 *   - `minComp` 30：小于 30 块的建筑连通体不做刚性平移（碎片不值得）。
 *   - `borderKeep` 8：距矩形边缘 8 格内的连通体不刚性（边缘地面必须收敛到 0，见 I2）。
 *
 * **改任何一个都必须重跑 `npm run redcity`**，否则产物静默过期（`check:data` 的指纹环节会抓）。
 *
 * `groundFloor` 不在这里另写字面量：唯一权威是 `region-config.js` 的 `REDCITY_GROUND_FLOOR`（两份字面量会漂移出
 * 「布局层按 -5 算下限、烘焙按别的值烘」的撕裂，红线 1）；`tools/` 可以 import `src/`，反向禁止。
 */
export const REDCITY_BAKE_PARAMS = Object.freeze({
  relief: 0.34,
  K: 2,
  groundFloor: REDCITY_GROUND_FLOOR,   // 唯一权威在 region-config.js（src），这里只引用
  decay: 2,
  pad: 1,
  minComp: 30,
  borderKeep: 8,
});

/** 出生点判据参数（spec §13.6.1） */
export const REDCITY_SPAWN_PARAMS = Object.freeze({
  headroom: 24,     // 本列头顶净空
  wallClear: 3,     // 5×5 邻域每列头顶净空（防贴墙/树冠）
  flatRange: 1,     // 5×5 内 ground 极差上限
  halfWin: 2,       // 5×5 窗口半宽
});

