// tools/jungle-fortress-fingerprint.mjs — 丛林要塞烘焙的映射表、拼装参数、产物指标与输入指纹
//
// 唯一权威（红线 1）：烘焙脚本 `bake-jungle-fortress.mjs` 与数据契约门 `check-data.mjs`
// 都从这里 import，不得各写一份。与 `ruined-citadel-fingerprint.mjs` 同一手法。
//
// 素材入库（`assets/jungle-fortress/src/`）⇒ 指纹不依赖仓库外文件。
//
// ⚠️ node 侧模块（要读文件），不进 `src/`，浏览器不消费。
// ⚠️ **`src/**` 与浏览器单测绝不能 import 它** —— 依赖 `node:fs`，浏览器无法解析
// `node:` 协议 → 整个模块不加载 → Worker 起不来 / 游戏白屏，`check:arch` 抓不到。
// 运行期需要的纯数据在 `src/gen/structures/jungle-fortress-data.js` 侧。
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

// 台阶 facing→orient 的唯一权威在巨型金字塔那侧（同一事实不抄第二份，红线 1）。
export { FACING_TO_ORIENT } from './giant-pyramid-fingerprint.mjs';
import { FACING_TO_ORIENT } from './giant-pyramid-fingerprint.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

/** 烘焙输入目录（入库，不是渲染资源） */
export const JUNGLE_FORTRESS_SOURCE_DIR = path.join(ROOT, 'assets', 'jungle-fortress', 'src');

/** 烘焙产物 */
export const JUNGLE_FORTRESS_JSON = path.join(ROOT, 'assets', 'structures', 'jungle_fortress.json');
export const JUNGLE_FORTRESS_META = path.join(ROOT, 'assets', 'structures', 'jungle_fortress.meta.json');

/** placement 类型名 → 产物基名（`structure-json.js` 的 STRUCTURE_FILES 从这里派生） */
export const JUNGLE_FORTRESS_VARIANTS = Object.freeze(['jungleFortress']);

/**
 * 地板层在**归一化坐标**里的 y（= 产物 JSON 的 floorRow）。
 * 结构 y=6（center_room 满铺实心层）− minY(−6) + 1 = 13。
 * 与 `src/gen/structures/jungle-fortress-data.js` 的同名常量同源（产物是权威）。
 */
export const FLOOR_ROW = 13;

/**
 * 17 片素材（顺序固定 —— 指纹按此顺序合并，调换顺序会改指纹）。
 * 逐字来自源仓库 `structure/fortresses/jungle/`，字母序。
 */
export const JUNGLE_FORTRESS_PIECES = Object.freeze([
  '4_way_inside.nbt',
  '4_way_outside.nbt',
  '4_way_outside_large.nbt',
  'balcony.nbt',
  'center_room.nbt',
  'spawner.nbt',
  'stairs_inside.nbt',
  'stairs_inside_plants.nbt',
  'stairs_outside.nbt',
  'straight_inside.nbt',
  'straight_outside.nbt',
  'terminator_1.nbt',
  'terminator_2.nbt',
  'terminator_3.nbt',
  'terminator_4.nbt',
  'turn_inside.nbt',
  'turn_inside_chest.nbt',
]);

/**
 * 离线拼装参数（spec §2.2 的七条语义）。
 *
 * `seed` 是**定版布局的 PRNG 种子**，不是世界 seed —— 用户裁定「只做 1 个最大档」，
 * 故全世界共用这一个布局，只有落点随世界 seed 变。
 * 263 是 400 seed 扫描里「件数≥140 且竖直≤36 且水平≤161 且 17 种件全出现」的最大者。
 *
 * `size` / `boxRange` 逐字来自源 `worldgen/structure/fortress_jungle.json`：
 *   size: 10（BFS 最大深度）
 *   max_distance_from_center 未写 ⇒ PieceLimitedJigsawManager 的 orElse(80)
 */
export const JUNGLE_FORTRESS_ASSEMBLE = Object.freeze({
  seed: 263,
  size: 10,
  boxRange: 80,
  startPiece: 'center_room',
});

/**
 * 池权重（逐字抄源 `worldgen/template_pool/fortresses/jungle/*.json`）。
 * `loc: null` = `empty_pool_element`（抽到即该连接口终止）。
 *
 * ⚠️ feature 池（vines / breakage / drowned / vine_breakage）**不参与拼装** ——
 * 它们的元素是 `feature_pool_element`，在 vanilla 里是生成期装饰而非结构件。
 * 它们的 jigsaw 由 Task 3 的藤蔓算法消费。
 */
export const JUNGLE_FORTRESS_POOL_WEIGHTS = Object.freeze({
  start_pool: Object.freeze([{ w: 1, loc: 'center_room' }]),
  outside: Object.freeze([
    { w: 1, loc: null },
    { w: 8, loc: 'straight_outside' },
    { w: 2, loc: '4_way_outside' },
    { w: 4, loc: '4_way_outside_large' },
    { w: 2, loc: 'stairs_outside' },
    { w: 1, loc: 'spawner' },
  ]),
  inside: Object.freeze([
    { w: 1, loc: null },
    { w: 10, loc: 'straight_inside' },
    { w: 4, loc: '4_way_inside' },
    { w: 3, loc: 'turn_inside' },
    { w: 3, loc: 'turn_inside_chest' },
    { w: 2, loc: 'stairs_inside' },
    { w: 2, loc: 'stairs_inside_plants' },
    { w: 2, loc: 'balcony' },
  ]),
  terminator: Object.freeze([
    { w: 1, loc: 'terminator_1' },
    { w: 1, loc: 'terminator_2' },
    { w: 1, loc: 'terminator_3' },
    { w: 1, loc: 'terminator_4' },
  ]),
});

/** 池的 fallback（源 JSON 的 `fallback` 字段） */
export const JUNGLE_FORTRESS_POOL_FALLBACK = Object.freeze({
  outside: 'terminator',
  inside: 'terminator',
  start_pool: null,
  terminator: null,
});

/**
 * 产物指标 —— 烘焙脚本与 `check:data` 共用这一份。
 * Task 1 只冻结件数直方图（拼装器的产物）；其余由 Task 2/3 按 --census 实测填入。
 */
export const JUNGLE_FORTRESS_METRICS = Object.freeze({
  jungleFortress: Object.freeze({
    /** 拼装件数（193 = 400 seed 扫描的最大档） */
    pieceCount: 193,
    /** 件种数（全族 17 种件都出现） */
    pieceKinds: 17,
    /** 逐件直方图（冻结实测值，spec §2.4） */
    pieceHist: Object.freeze({
      '4_way_inside': 7,
      '4_way_outside': 26,
      '4_way_outside_large': 14,
      'balcony': 5,
      'center_room': 1,
      'spawner': 15,
      'stairs_inside': 3,
      'stairs_inside_plants': 3,
      'stairs_outside': 28,
      'straight_inside': 22,
      'straight_outside': 44,
      'terminator_1': 5,
      'terminator_2': 7,
      'terminator_3': 1,
      'terminator_4': 2,
      'turn_inside': 8,
      'turn_inside_chest': 2,
    }),

    // ---- 产物指标（Task 2 实测冻结，无藤蔓基线；Task 3 重标）----
    width: 159,
    height: 33,
    depth: 155,
    floorRow: FLOOR_ROW,
    contentCells: 80031,
    airCells: 16358,
    paletteSize: 11,
    skyAirDropped: 13445,
    pillarRoots: 6498,
    pillarCells: 6446,
    pillarMaxLen: 10,

    /** 逐目标方块格数 */
    targetCounts: Object.freeze({
      mossy_stone: 30503,
      air: 16358,
      cobblestone: 15085,
      stone_bricks: 12092,
      tuff_bricks: 3012,
      vertical_pillar: 2682,
      cobblestone_step: 156,
      dirt: 60,
      red_mushroom: 60,
      chest: 18,
      water: 5,
    }),

    /**
     * 台阶朝向分布（**产物口径**，只算最终存活的 156 格）。
     *
     * ⚠️ spec §2.4 写的 24/54/69/12 合计 **159**，那是探针的「逐件累加」口径：
     * 源里 159 个台阶格次有 **3 个被后写件覆盖**（makeColumnSetter 后写胜），
     * 产物只剩 156 格。故以产物为准：:1 是 **51** 不是 54。
     * （AGENTS.md：写结构类断言不得假设「每个结构都完整」。）
     */
    stepOrientationCounts: Object.freeze({
      'cobblestone_step:0': 24,
      'cobblestone_step:1': 51,
      'cobblestone_step:2': 69,
      'cobblestone_step:3': 12,
    }),
  }),
});

/**
 * 烘焙输入指纹：`<17 片内容合并 sha 前 16>:<参数 sha 前 16>`。
 *
 * 改池权重 / 拼装参数 / 映射表 / METRICS / 任一片 nbt 都会改指纹 → 门禁报「产物过期」。
 *
 * 已知盲区（与既有 8 个烘焙产物同口径）：只改**烘焙算法**而不动参数时指纹不变 ——
 * 那类改动靠 `pieceHist` / `stepOrientationCounts` 等「算法产物」与产物契约测试兜住。
 */
export function jungleFortressInputFingerprint() {
  const missing = JUNGLE_FORTRESS_PIECES
    .map((f) => path.join(JUNGLE_FORTRESS_SOURCE_DIR, f))
    .filter((f) => !fs.existsSync(f));
  if (missing.length > 0) {
    throw new Error(
      `[丛林要塞] 烘焙输入缺失 ${missing.length}/17 片：${missing.map((f) => path.relative(ROOT, f)).join(', ')}`
      + '（.nbt 入库，缺失 = 仓库损坏）',
    );
  }
  const merged = createHash('sha256');
  for (const f of JUNGLE_FORTRESS_PIECES) {
    merged.update(fs.readFileSync(path.join(JUNGLE_FORTRESS_SOURCE_DIR, f)));
  }
  const sourceSha256 = merged.digest('hex');
  const paramsSha256 = createHash('sha256')
    .update(JSON.stringify({
      JUNGLE_FORTRESS_PIECES,
      JUNGLE_FORTRESS_ASSEMBLE,
      JUNGLE_FORTRESS_POOL_WEIGHTS,
      JUNGLE_FORTRESS_POOL_FALLBACK,
      JUNGLE_FORTRESS_METRICS,
      FACING_TO_ORIENT,
    }))
    .digest('hex');
  return {
    input: `${sourceSha256.slice(0, 16)}:${paramsSha256.slice(0, 16)}`,
    sourceSha256,
    paramsSha256,
  };
}