// 附录 B：材质映射与分类清单
//
// 来源：RedCity 评审会话的参考实现 `map-final.mjs` + `bake3.mjs` 的 `isSkin` / `isBuildingMat`，
// 已验证可复现烘焙数字（retained 244647 / dy -6..80 / spawn ox=138 oz=141 dy=-3）。
//
// 实施时本文件的内容要落到 `tools/redcity-config.mjs`（唯一权威，烘焙脚本与 `check:data` 共用）。
// 附录保留它是为了：① 计划文档可引用而不必内联 300 行；② 评审者能直接跑它验证映射覆盖率。
//
// ⚠️ 三个清单的语义互斥，勿混为一处（同 `NON_PLACEABLE_ITEMS` / `HIDDEN_FROM_INVENTORY` 的教训）：
//   - SKIN      = 岛体材质（投影时只保留地面往下 K 层，其余丢弃）
//   - BUILDING  = 建筑/装饰材质（地面以上无条件全保留，且参与刚性平移）
//   - 其余      = 既非 skin 也非 building（如 barrier）→ 丢弃
// 一个 (id,meta) 可以同时是 skin 与 building 吗？不可以：`isSkin` 与 `isBuildingMat` 的清单
// 实测无交集（见文件末尾的自检）。若将来加材质，先跑自检。

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
  [168, '*', 'oxidized_cut_copper'],   // 宝塔屋顶（U2：偏亮青绿，待真实 1.12 色值校准）
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

// ==================== 自检（跑本文件即执行）====================

if (process.argv[1] && process.argv[1].endsWith('appendix-b-mapping.mjs')) {
  // ① skin 与 building 清单不得有交集
  const overlap = [];
  for (let id = 0; id < 256; id++) {
    for (let meta = 0; meta < 16; meta++) {
      const key = (id << 4) | meta;
      if (isSkin(key) && isBuildingMat(key)) overlap.push(`${id}:${meta}`);
    }
  }
  console.log(overlap.length ? `✗ skin/building 交集: ${overlap.join(' ')}` : '✓ skin 与 building 清单无交集');

  // ② 映射目标必须都在 registry 内
  const { BLOCKS } = await import('../../../../src/voxel/blocks-data.js');
  const names = new Set(BLOCKS.map((b) => b.name));
  const targets = [...new Set(MAPPING_RULES.map((r) => r[2]).concat([DEFAULT_BLOCK]))];
  const bad = targets.filter((n) => !names.has(n));
  console.log(bad.length ? `✗ 映射目标不在 registry: ${bad.join(' ')}` : `✓ ${targets.length} 个映射目标全部在 registry 内`);

  // ③ 规则顺序：同一 id 的 meta 特例必须排在通配之前
  const orderBad = [];
  const seenWildcard = new Set();
  for (const [id, meta] of MAPPING_RULES) {
    if (meta === '*') seenWildcard.add(id);
    else if (seenWildcard.has(id)) orderBad.push(`${id}:${meta}`);
  }
  console.log(orderBad.length ? `✗ meta 特例排在通配之后（永不命中）: ${orderBad.join(' ')}` : '✓ 规则顺序正确（特例在前）');
}
