// src/gen/structures/giant-trees.js — 巨树景观（设计文档 docs/superpowers/specs/2026-10-23-giant-trees-design.md）
//
// 两段式（与 scatter.js 同构，红线 2）：
//   region layout 层  computeGiantTreeCandidates()：候选点 = 全局对齐网格 + 内缩抖动（无状态、跨 region 无缝、
//                     间距由构造保证），谓词（biome/近水/交界）只对每格 ≤1 个点求值；
//   column 应用层     applyGiantTrees()：合并 3×3 邻域候选 → 按 AABB 取交 → 排除（地标/撒布/城市）→ 逐格光栅化
//                     → 地基填充 → 返回「旧植被抑制」覆盖窗口。
//
// Worker 同构：本文件不得 import three、不得自建 Worker。
//
// ⚠️ 与 mc-lite 无对应物（mc-lite 没有这些树）；树形数据来自 40AssortedTreesPack.schem（离线烘焙，见
//    tools/bake-giant-trees.mjs），**不是**对 mc-lite 的移植，所以不存在「偏离 mc-lite」问题。
import { seededRandom, getBiome } from '../noise.js';
import { generateHeight } from '../terrain.js';
import { makeColumnSetter } from './landmarks.js';
import { REGION_SIZE, SCATTER_FOOTPRINT, CITY_STRUCTURE_FOOTPRINT } from './region-config.js';
import { SCATTER_TYPES, SCATTER_STRIDE } from './scatter.js';
import { SEA_Y } from '../../voxel/constants.js';
import { resourceUrl } from '../../core/resource-url.js';

/** 族序（候选里存下标；绝不依赖对象 key 顺序）。与 tools/giant-trees-fingerprint.mjs 的 TREE_FAMILIES 同名同序。 */
export const GIANT_FAMILY_ORDER = Object.freeze(['tallOak', 'snowSpruce', 'cherry', 'palm', 'banyanLeafy', 'banyanBare']);

/** 候选数组的 stride：[wx, wy, wz, familyIdx, variantHash] */
export const GIANT_STRIDE = 5;

/** 旋转的 salt（单一权威；候选层不存旋转，光栅化与覆盖窗口都用 giantTreeRotation 现算） */
const SALT_ROT = 941;

/**
 * 区域门控（斑块）参数 —— 决定「**哪些段海岸/交界有树林**」，与局部密度完全解耦。
 *
 * 用户要的是「平均 3 个海滩里有 1 个有巨树矩阵」「平均 2 个榕树带里有 1 个」，而不要
 * 「每个海滩旁都有一片」。但**几何上无法按「海滩」切分**：对 beach 候选做切比雪夫连通聚类实测
 * （3×3 region，seed 12345）—— 阈值 32 时有 79 簇（最大跨度 422×638），阈值 64/96/128 时
 * 都只剩 **1 个连通簇（1187×1187）** ⇒ 海岸线本身是连续的，「一个海滩」没有客观边界。
 *
 * 故用**粗格门控**：粗格内全部候选共享同一个随机值 → 要么整段有树、要么整段没有。
 *
 * ⚠️ **为什么是粗格哈希，而不是「噪声 + 标定阈值」**（实测否决）：
 * `noise(x, z, seed + salt, scale)` 把 seed 直接加进坐标（`src/gen/noise.js:18`），
 * 于是 `seed × scale` 的相位随 seed 大幅漂移（seed 12345 → 128.6 rad，seed 424242 → 4419.2 rad）
 * ⇒ **任何固定阈值的通过率都会随 seed 漂**。实测把 seed 12345 标定到 1/2 的 banyan 阈值
 * 套到 seed 424242，通过率从 0.50 滑到 **0.373**（必须为每个 seed 重新标定，不可接受）。
 * 粗格哈希的输入是**整数粗格下标**，没有这个相位耦合 → 通过率恒等于 `patchChance`，与 seed 无关。
 *
 * 实测（20 个 seed，cell=128，R9 口径，salt=956）：beach 粗格覆盖率均值 **0.329**（目标 1/3，
 * sd 0.048 vs 二项理论 0.047）；banyan 均值 **0.504**（目标 1/2，sd 0.086 vs 0.050 —— 粗格只有
 * 26~40 个，抽样噪声本就大）。默认 seed 12345：beach **0.333**（精确命中）、banyan 0.429。
 * `seededRandom` 在整数点的分布质量已验（1681 点：均值 0.494、`P(v＜1/3)=0.336`、χ²(9df)=3.8）。
 * ⚠️ salt 是**实选**的：试过 951~958，只有 956 让默认 seed 的 beach 精确落在 1/3（951 是 0.384、
 * 952 是 0.293）；选 salt 时看的是「默认 seed 的覆盖率」而不是只看 20-seed 均值（玩家看到的是默认值）。
 *
 * ⚠️ **不能改成「按候选点哈希」**：那样每棵独立抽签，结果就是**斑点式零散**而不是成片；
 * 单测的「同粗格同进退」用例钉住这一点。
 */
export const PATCH_CELL = 128;
export const PATCH_SALT = 956;

/** 地基填充的最大深度：实测 3×3 region 里 gy=0 层方块下方空隙 p99=3、最大 9 */
export const GIANT_SUPPORT_MAX = 10;

// 无需 Y 裁剪判据：地表 h ≤ 16，树高 ≤ 42 → 树顶 ≤ 59 < WORLD_MAX_Y(96)。

// ---------------------------------------------------------------- 判据（候选层与测试共用，红线 1）

/** 地表高度；陆上（> SEA_Y）才可能落树。返回 null = 不满足。 */
function landHeight(wx, wz, seed) {
  const h = generateHeight(wx, wz, seed);
  return h > SEA_Y ? h : null;
}

/** 距水 ≤ band 格：4 轴向、步长 4 采样（r = 4, 8, …, band），任一采样点 h < SEA_Y 即视为近水 */
export function isNearWater(wx, wz, seed, band) {
  for (let r = 4; r <= band; r += 4) {
    if (generateHeight(wx + r, wz, seed) < SEA_Y || generateHeight(wx - r, wz, seed) < SEA_Y ||
        generateHeight(wx, wz + r, seed) < SEA_Y || generateHeight(wx, wz - r, seed) < SEA_Y) return true;
  }
  return false;
}

/** 草地/沙漠交界：本点是 PLAINS 或 DESERT，且 4 轴向 ±band 处的任一端点是「另一种」 */
export function isBiomeEdge(wx, wz, seed, band) {
  const b = getBiome(wx, wz, seed);
  if (b !== 'PLAINS' && b !== 'DESERT') return false;
  const other = b === 'PLAINS' ? 'DESERT' : 'PLAINS';
  return getBiome(wx + band, wz, seed) === other || getBiome(wx - band, wz, seed) === other ||
         getBiome(wx, wz + band, seed) === other || getBiome(wx, wz - band, seed) === other;
}

/**
 * 三条落位路径（单一权威；改数值须同步设计文档 §3.5 表）。
 *   cell 边长 C = spacing + jitter；每格至多 1 个点，落在格内 [0, jitter) × [0, jitter) 的内缩方块里
 *   ⇒ 相邻格的点切比雪夫距离 ≥ spacing + 1（构造性保证，不需要贪心/排序/跨 region 协调）。
 *   chance = 每格出点概率（密度旋钮；原设计的 forestChance 在贪心下几乎无效，这里真正线性控制密度）；
 *   families = 该路径可选的两个族（GIANT_FAMILY_ORDER 下标，各 50%）。
 *   **spacing 是最小树距，不是树宽**：A 森林树 AABB ≤ 12，spacing 32 → 互不相交；B/C 的樱花/榕树 AABB 达 17，
 *   B 的 spacing 12（C=20）/ C 的 spacing 17（C=28）→ 冠幅仍会互相重叠成片（设计意图「成片樱花+椰林」），树干不重叠。
 *   实测密度（7 个 region、三路径同口径，eligible 格：A 185,790 / B 178,292 / C 59,530）：
 *   A 1/1523、B 1/397、C 1/783。
 *   ⚠️ 2026-10-23 按实玩反馈四轮调稀（都选「拉大间距」而非降 chance —— 间距保持「每棵树都在均匀格子里」，
 *   不会出现成片空缺）：
 *     · A 森林 14 → 20 → **32**（两次「再稀疏」；相对 20 实测 0.502 = 精确减半）
 *     · B 海边 8/6 → **12/8**（「水边的巨树树林密度降一半」；实测 0.499）
 *     · C 榕树带 8/6 → **12/8** → **17/11**（两次「密度降低一倍」；实测 0.515 / 0.497）
 *   **每一次把密度减半 = cell 边长 ×√2**（A 14→20→32、B 14→20、C 14→20→28）。
 *   patchChance = **区域门控**（与上面的密度旋钮解耦）：粗格 `PATCH_CELL` 内整段一起抽签，
 *   决定「哪些段海岸/交界有树林」。forest=1（森林里处处都长，行为不变）、beach=1/3、banyan=1/2。
 *   ⇒ 调「多少个海滩有树」改 patchChance；调「有树的地方多密」改 spacing/jitter。两者互不干扰。
 *   salt 占 9xx 空闲带（程序化扫描确认 src 下无 900~999 的 salt）：
 *   +0 出点 / +1 x 抖动 / +2 z 抖动 / +3 族 / +4 变体；区域门控用独立的 `PATCH_SALT = 951`。
 *   eligible(wx, wz, seed) → 地表高度 h（满足）| null（不满足）。
 */
export const GIANT_TREE_PATHS = Object.freeze([
  Object.freeze({
    key: 'forest', salt: 911, spacing: 32, jitter: 8, chance: 1, patchChance: 1, families: Object.freeze([0, 1]),
    // A 森林：FOREST biome + 陆上。森林不设区域门控（用户只要求海滩/榕树带）。
    eligible: (wx, wz, seed) => (getBiome(wx, wz, seed) === 'FOREST' ? landHeight(wx, wz, seed) : null),
  }),
  Object.freeze({
    key: 'beach', salt: 921, spacing: 12, jitter: 8, chance: 1, patchChance: 1 / 3, families: Object.freeze([2, 3]), band: 24,
    // B 海边：陆上 + 距水 ≤ band。区域门控 1/3 ⇒ 平均 3 段海岸 1 段有椰林。
    eligible(wx, wz, seed) { const h = landHeight(wx, wz, seed); return h !== null && isNearWater(wx, wz, seed, this.band) ? h : null; },
  }),
  Object.freeze({
    key: 'banyan', salt: 931, spacing: 17, jitter: 11, chance: 1, patchChance: 1 / 2, families: Object.freeze([4, 5]), band: 32,
    // C 榕树带：PLAINS/DESERT 交界（±band 内跨 biome）+ 陆上。区域门控 1/2。
    eligible(wx, wz, seed) { const h = landHeight(wx, wz, seed); return h !== null && isBiomeEdge(wx, wz, seed, this.band) ? h : null; },
  }),
]);

/** 树的朝向 0~3（90° 步进）。**必须 floor(r*4)**：seededRandom 返回 [0,1) 浮点，`& 3` 恒为 0。 */
export function giantTreeRotation(wx, wz, seed) {
  return Math.floor(seededRandom(wx, wz, seed + SALT_ROT) * 4);
}

// ---------------------------------------------------------------- 候选发现（region 层）

/**
 * 单条路径在 region 内的候选。cell 按全局网格对齐（cell 下标 = floor(世界坐标 / C)），
 * 一个点属于它所在的 region ⇒ 跨 region 的 cell 由两侧各算一次、各自只保留落在本 region 内的点，
 * 不重复、不遗漏。
 * @returns {Int32Array} stride = GIANT_STRIDE
 */
function discoverPath(path, regionX, regionZ, seed) {
  const C = path.spacing + path.jitter;
  const x0 = regionX * REGION_SIZE, z0 = regionZ * REGION_SIZE;
  const i0 = Math.floor(x0 / C), i1 = Math.floor((x0 + REGION_SIZE - 1) / C);
  const j0 = Math.floor(z0 / C), j1 = Math.floor((z0 + REGION_SIZE - 1) / C);
  const out = [];
  for (let i = i0; i <= i1; i++) {
    for (let j = j0; j <= j1; j++) {
      if (seededRandom(i, j, seed + path.salt) >= path.chance) continue;
      const wx = i * C + Math.floor(seededRandom(i, j, seed + path.salt + 1) * path.jitter);
      const wz = j * C + Math.floor(seededRandom(i, j, seed + path.salt + 2) * path.jitter);
      if (wx < x0 || wx >= x0 + REGION_SIZE || wz < z0 || wz >= z0 + REGION_SIZE) continue;
      // 区域门控：粗格内全部候选共享同一个随机值 → 整段有树 / 整段没有（见 PATCH_CELL 说明）。
      // 放在 eligible 之前：先廉价哈希、后昂贵谓词（保住既有「每格至多求值一次谓词」口径）。
      if (path.patchChance < 1 &&
          seededRandom(Math.floor(wx / PATCH_CELL), Math.floor(wz / PATCH_CELL), seed + PATCH_SALT) >= path.patchChance) continue;
      const h = path.eligible(wx, wz, seed);
      if (h === null) continue;
      const fam = path.families[seededRandom(i, j, seed + path.salt + 3) < 0.5 ? 0 : 1];
      // 变体下标存「原始 hash 整数」：候选层拿不到变体数（loadGiantTrees 异步），光栅化层再 % 该族变体数
      const variantHash = Math.floor(seededRandom(i, j, seed + path.salt + 4) * 65536);
      out.push(wx, h + 1, wz, fam, variantHash);
    }
  }
  return Int32Array.from(out);
}

/**
 * region 层候选（纯函数、确定性、与 region 邻居无关）。
 * @returns {{forest: Int32Array, beach: Int32Array, banyan: Int32Array}}
 */
export function computeGiantTreeCandidates(regionX, regionZ, seed, paths = GIANT_TREE_PATHS) {
  const out = {};
  for (const p of paths) out[p.key] = discoverPath(p, regionX, regionZ, seed);
  return out;
}

// ---------------------------------------------------------------- 变体加载与几何

let cache = null;
let loading = null;

/**
 * 加载烘焙产物（每个 Worker / 页面线程各一份，模块级缓存）。
 * `cells` 是扁平 Uint8Array 四元组 [gx, gy, gz, palIdx, …]（取值 ≤ 42，装得下 Uint8）。
 * 失败不抛、不缓存：返回空 families（本次 GEN 无巨树），下一次调用会重试 —— 与 structure-json.js 的
 * 「失败即空」同口径，但不把失败永久缓存，避免某个 Worker 永远无树。
 */
export function loadGiantTrees() {
  if (cache) return Promise.resolve(cache);
  if (!loading) {
    // 部署路径无关（v1.87）：旧写法是根绝对路径，仓库挂子路径部署时
    // Worker 内 fetch 404 → 所有巨树静默消失（方块层面看不出差别）。
    loading = fetch(resourceUrl('assets/giant-trees/trees.json')).then((r) => r.json()).then((data) => {
      const families = {};
      for (const [fam, list] of Object.entries(data.trees)) {
        families[fam] = list.map((v) => ({
          pad: v.pad, w: v.w, d: v.d, h: v.h, anchor: v.anchor, palette: v.palette, cells: Uint8Array.from(v.blocks),
        }));
      }
      cache = { families };
      return cache;
    }).catch(() => { loading = null; return { families: {} }; });
  }
  return loading;
}

/** 同步读模块缓存；未加载完成返回 null（GEN 入口会先 await loadGiantTrees()） */
export function getGiantTreesSync() { return cache; }

/**
 * 绕 AABB 顺时针旋转 90° × rot 后的局部坐标：rot=1 时 (x,z) → (d-1-z, x)。
 * 非正方形 AABB 旋转后宽深互换，调用方必须用 rotatedFootprint 取旋转后的 w/d。
 */
export function rotateCell(v, rot, x, z) {
  switch (rot & 3) {
    case 0: return [x, z];
    case 1: return [v.d - 1 - z, x];
    case 2: return [v.w - 1 - x, v.d - 1 - z];
    default: return [z, v.w - 1 - x];
  }
}

/** 旋转后的 AABB 宽深（rot 为奇数时互换） */
export function rotatedFootprint(v, rot) {
  return (rot & 1) === 1 ? { w: v.d, d: v.w } : { w: v.w, d: v.d };
}

/** 树的世界 AABB（闭区间）与原点：锚点对齐候选点 (wx, wz) */
export function treeBox(v, rot, wx, wz) {
  const fp = rotatedFootprint(v, rot);
  const a = rotateCell(v, rot, v.anchor[0], v.anchor[1]);
  const x0 = wx - a[0], z0 = wz - a[1];
  return { x0, z0, x1: x0 + fp.w - 1, z1: z0 + fp.d - 1 };
}

// ---------------------------------------------------------------- column 层

/** 候选 → 树对象（含变体、朝向、世界 AABB）。族缺失（加载失败/族名未知）则跳过。 */
function resolveTree(path, arr, i, seed, families) {
  const list = families[GIANT_FAMILY_ORDER[arr[i + 3]]];
  if (!list || list.length === 0) return null;
  const variant = list[arr[i + 4] % list.length];
  const wx = arr[i], wy = arr[i + 1], wz = arr[i + 2];
  const rot = giantTreeRotation(wx, wz, seed);
  return { path, wx, wy, wz, variant, rot, ...treeBox(variant, rot, wx, wz) };
}

/**
 * 收集与窗口 [wx0-ext, wx1+ext]×[wz0-ext, wz1+ext] 相交的树（AABB 外扩 ext 后相交即收），
 * 合并**全部**邻域 layouts（拼接而非覆盖），并按 (路径序, wx, wz) 排成**规范顺序** ——
 * 逐格「后写胜」的结果因此与 layouts 的下发顺序无关。
 * @param {Array<Object>} layouts 查询域内 region 布局（每项可带 giantTrees）
 * @param {{minX:number,maxX:number,minZ:number,maxZ:number}} win
 */
export function collectGiantTrees(layouts, seed, families, win, ext, paths = GIANT_TREE_PATHS) {
  const trees = [];
  paths.forEach((p, pathIdx) => {
    for (const layout of layouts) {
      const arr = layout.giantTrees && layout.giantTrees[p.key];
      if (!arr || arr.length === 0) continue;
      for (let i = 0; i < arr.length; i += GIANT_STRIDE) {
        // 廉价预筛：最大树宽 17、锚点偏移 ≤ 2 → 候选点离窗口超过 24 格的不可能相交
        if (arr[i] < win.minX - 24 || arr[i] > win.maxX + 24 || arr[i + 2] < win.minZ - 24 || arr[i + 2] > win.maxZ + 24) continue;
        const t = resolveTree(p.key, arr, i, seed, families);
        if (!t) continue;
        if (t.x1 + ext < win.minX || t.x0 - ext > win.maxX || t.z1 + ext < win.minZ || t.z0 - ext > win.maxZ) continue;
        t.pathIdx = pathIdx;
        trees.push(t);
      }
    }
  });
  trees.sort((a, b) => a.pathIdx - b.pathIdx || a.wx - b.wx || a.wz - b.wz);
  return trees;
}

/**
 * 「树要让路」的既有结构外包盒（排除用）：
 *   ① 城外撒布结构（house / flowerBed / tallWell / 沙漠结构 / 沉船…）：SCATTER_FOOTPRINT 的 halfX/halfZ，外扩 1；
 *      城内撒布不用算（城市 bounds 已由 allowedAt 的 pointContext 挡掉）。
 *   ② 平地金字塔岛（layout.plainLand）与海岛塔（layout.island）的 **JSON 结构占地**，外扩 2（= apply.js 的 INTERSECT_MARGIN）。
 *      ⚠️ 不能只靠 pointContext：平地沙台的 getPlainLandInfo 只有 ±15，而 pyramid_island.json 占地 34×39
 *      （halfX 17 / halfZ 20）比沙台大 2~5 格 —— 只用 pointContext 时，既有的 pyramidIsland 用例会被树干覆盖（实测）。
 * 只留与窗口内的树可能相交的（树最大外延 24 + ext）。
 */
export function collectExclusionBoxes(layouts, win, ext) {
  const boxes = [];
  const push = (cx, cz, halfX, halfZ, margin) => {
    const b = { x0: cx - halfX - margin, x1: cx + halfX + margin, z0: cz - halfZ - margin, z1: cz + halfZ + margin };
    if (b.x1 < win.minX - 24 - ext || b.x0 > win.maxX + 24 + ext || b.z1 < win.minZ - 24 - ext || b.z0 > win.maxZ + 24 + ext) return;
    boxes.push(b);
  };
  for (const layout of layouts) {
    const arr = layout.scatter && layout.scatter.outsideScatter;
    if (arr) {
      for (let i = 0; i < arr.length; i += SCATTER_STRIDE) {
        const fp = SCATTER_FOOTPRINT[SCATTER_TYPES[arr[i + 3]]];
        if (fp) push(arr[i], arr[i + 2], fp.halfX, fp.halfZ, 1);
      }
    }
    if (layout.plainLand) push(layout.plainLand.cx, layout.plainLand.cz, CITY_STRUCTURE_FOOTPRINT.pyramidIsland.halfX, CITY_STRUCTURE_FOOTPRINT.pyramidIsland.halfZ, 2);
    if (layout.island) push(layout.island.cx, layout.island.cz, CITY_STRUCTURE_FOOTPRINT.tower.halfX, CITY_STRUCTURE_FOOTPRINT.tower.halfZ, 2);
  }
  return boxes;
}

/**
 * 排除判定（纯函数，对「覆盖这棵树的任一 column」结论恒一致 —— 它只依赖树本身与邻域 layouts，
 * 而任何与树 AABB 相交的 column 的 3×3 查询域都含该树所在 region 及其朝向该 column 一侧的邻居）：
 *   ① AABB 九点（四角 + 四边中点 + 中心）与锚点：allowedAt 必须全真
 *      （allowedAt 由 apply.js 用 pointContext 构造：只允许 'normal' / 'water'，
 *       即排除城市、金字塔、平地岛、海岛、雪原、冰封山）；
 *   ② 不与任何既有结构外包盒相交（撒布结构 / 平地金字塔岛 / 海岛塔：是既有内容，树让路；见 collectExclusionBoxes）。
 */
export function isGiantTreeAllowed(t, allowedAt, exclusionBoxes) {
  const mx = (t.x0 + t.x1) >> 1, mz = (t.z0 + t.z1) >> 1;
  const xs = [t.x0, mx, t.x1], zs = [t.z0, mz, t.z1];
  for (const x of xs) for (const z of zs) if (!allowedAt(x, z)) return false;
  if (!allowedAt(t.wx, t.wz)) return false;
  for (const b of exclusionBoxes) {
    if (!(t.x1 < b.x0 || t.x0 > b.x1 || t.z1 < b.z0 || t.z0 > b.z1)) return false;
  }
  return true;
}

/**
 * 把一棵树写进 column（setBlock 自带 column 裁剪）+ 地基填充。
 * 地基：gy=0 层的树干格（palette[0]）下方若悬空（地表 h < wy-1），用同种树干向下补到 h+1（≤ GIANT_SUPPORT_MAX 格）。
 * 对应既有 GROUND_SUPPORT_TYPES 机制（structure-json.js）的同一语义；这里直接用 generateHeight
 * （纯函数、跨 column 一致），不探 column 内容 —— 探测在 column 边缘取不到邻列数据。
 */
export function rasterizeGiantTree(setBlock, t, seed) {
  const v = t.variant, cells = v.cells, pal = v.palette;
  for (let k = 0; k < cells.length; k += 4) {
    const [rx, rz] = rotateCell(v, t.rot, cells[k], cells[k + 2]);
    const name = pal[cells[k + 3]];
    setBlock(t.x0 + rx, t.wy + cells[k + 1], t.z0 + rz, name);
    if (cells[k + 1] === 0 && cells[k + 3] === 0) {
      const wx = t.x0 + rx, wz = t.z0 + rz;
      const depth = (t.wy - 1) - generateHeight(wx, wz, seed);
      if (depth >= 1 && depth <= GIANT_SUPPORT_MAX) {
        for (let y = t.wy - 1; y > t.wy - 1 - depth; y--) setBlock(wx, y, wz, name);
      }
    }
  }
}

/**
 * 覆盖窗口：column 外扩 ext 的 (16+2ext)² 位图。树的**覆盖区 = AABB 外扩 ext**（旧植被树冠半径 ≤ ext，
 * 树干落在覆盖区内的旧树，其树冠才可能碰到巨树 AABB）。`covers(wx,wz)` 对窗口外恒 false。
 * ⚠️ 只在本 column 内标记不够：阶段 3 的植被扫描会外扩 ext 格，column 外 3 格带里的旧树树干
 * 会把树冠写进本 column（实测每 256 个 column 游离出 5,332 格没有树干的旧树冠）。
 */
export function buildCoveredWindow(column, trees, ext) {
  const W = 16 + 2 * ext;
  const minX = column.cx * 16 - ext, minZ = column.cz * 16 - ext;
  const cov = new Uint8Array(W * W);
  for (const t of trees) {
    const xa = Math.max(t.x0 - ext, minX), xb = Math.min(t.x1 + ext, minX + W - 1);
    const za = Math.max(t.z0 - ext, minZ), zb = Math.min(t.z1 + ext, minZ + W - 1);
    for (let x = xa; x <= xb; x++) for (let z = za; z <= zb; z++) cov[(x - minX) + (z - minZ) * W] = 1;
  }
  return { covers: (wx, wz) => { const lx = wx - minX, lz = wz - minZ; return lx >= 0 && lz >= 0 && lx < W && lz < W && cov[lx + lz * W] === 1; } };
}

const NO_COVER = Object.freeze({ covers: () => false });

/**
 * column 层入口。
 * @param {import('../../voxel/chunk-column.js').ChunkColumn} column
 * @param {Array<Object>} layouts 查询域内 region 布局
 * @param {number} seed
 * @param {*} registry
 * @param {{allowedAt: (wx:number, wz:number) => boolean, ext: number}} ctx
 *   allowedAt：由 apply.js 用 pointContext 构造；ext：植被扫描外扩（apply.js 的 VEGETATION_EXT）
 * @returns {{covers: (wx:number, wz:number) => boolean}} 旧植被抑制覆盖窗口
 */
export function applyGiantTrees(column, layouts, seed, registry, ctx) {
  const data = getGiantTreesSync();
  if (!data) return NO_COVER;
  const win = { minX: column.cx * 16, maxX: column.cx * 16 + 15, minZ: column.cz * 16, maxZ: column.cz * 16 + 15 };
  const candidates = collectGiantTrees(layouts, seed, data.families, win, ctx.ext);
  if (candidates.length === 0) return NO_COVER;
  const exclusionBoxes = collectExclusionBoxes(layouts, win, ctx.ext);
  const accepted = candidates.filter((t) => isGiantTreeAllowed(t, ctx.allowedAt, exclusionBoxes));
  if (accepted.length === 0) return NO_COVER;
  const setBlock = makeColumnSetter(column, registry);
  for (const t of accepted) {
    if (t.x1 < win.minX || t.x0 > win.maxX || t.z1 < win.minZ || t.z0 > win.maxZ) continue; // 只覆盖区相交、本列无方块
    rasterizeGiantTree(setBlock, t, seed);
  }
  return buildCoveredWindow(column, accepted, ctx.ext);
}
