// tools/burning-arena-fingerprint.mjs — 灾变竞技场（burning arena）烘焙的**映射表、产物指标与输入指纹**共享模块
//
// 唯一权威（红线 1）：烘焙脚本 `bake-burning-arena.mjs` 与数据契约门 `check-data.mjs` 都从这里
// import，不得各写一份。与 `arena-fingerprint.mjs` / `giant-pyramid-fingerprint.mjs` 同一手法。
//
// 素材**入库**（`assets/burning-arena/src/`，与 `assets/arena/src/` 同口径：烘焙输入，
// 不是渲染资源）→ 指纹不依赖仓库外文件，任何机器 `npm run check` 结果一致。
//
// ⚠️ node 侧模块（要读文件），不进 `src/`，浏览器不消费。
// ⚠️ **`src/**` 与浏览器单测绝不能 import 它** —— 它依赖 `node:fs`，浏览器无法解析
// `node:` 协议 → 整个模块不加载 → Worker 起不来 / 游戏白屏，而 `check:arch` 抓不到这类
// 运行时解析失败（B1 教训）。运行期需要的纯数据在 `src/gen/structures/burning-arena-data.js` 侧。
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

// 台阶 facing→orient 的唯一权威在巨型金字塔那侧（同一事实不抄第二份，红线 1）。
// 这里 import 后**再导出**，使烘焙脚本只有一个 import 源，且本模块的参数指纹能覆盖它
// （改朝向表会改变产物 → 指纹必须跟着变，否则门禁拓不到）。
export { FACING_TO_ORIENT } from './giant-pyramid-fingerprint.mjs';
import { FACING_TO_ORIENT } from './giant-pyramid-fingerprint.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

/** 烘焙输入目录（**入库**，不是渲染资源） */
export const BURNING_ARENA_SOURCE_DIR = path.join(ROOT, 'assets', 'burning-arena', 'src');

/** 烘焙产物：结构 JSON（进运行期，经 structure-json.js 加载） */
export const BURNING_ARENA_JSON = path.join(ROOT, 'assets', 'structures', 'burning_arena.json');
/** 烘焙产物：伴随元数据（尺寸 / 计数 / 指纹，不进运行期） */
export const BURNING_ARENA_META = path.join(ROOT, 'assets', 'structures', 'burning_arena.meta.json');

/** `placement` 类型名 → 产物基名（`structure-json.js` 的 `STRUCTURE_FILES` 从这里派生） */
export const BURNING_ARENA_VARIANTS = Object.freeze(['burningArena']);

/**
 * 8 片的拼合偏移（**逐字抄自** `Burning_Arena_Structure.java` 的 `OFFSET` 表 +
 * `start()` 里的 `rotationOffSet`，rotation = NONE）。
 *
 * ⚠️ **y 偏移含 +1**：Java 侧 `OFFSET` 全部是 `(0,1,0)`，而 `start()` 传的基准 y 是
 * `pos.getY()`（= 21，结构生成高度）。本仓不关心绝对 y（产物会归一化 minY→1），
 * 只关心**片间相对偏移**，故直接取 OFFSET 的 y 值（1 / 49）。
 *
 * ⚠️ 上层 4 片（arena5~8）的 y 偏移是 **49** 而不是 48：Java 侧 `rotationOffSet` 给的是
 * `(0,48,0)` 等，再叠加 `OFFSET` 的 `(0,1,0)` ⇒ 48 + 1 = 49。漏掉这 1 格会让上下两层
 * 在 y=48 处**重叠一格**（上层地板插进下层天花板），方块层面看不出是偏移抄错了。
 *
 * 组装后实测（`npm run burningarena -- --census` 可复现）：包围盒 85×80×85，
 * 非空气 115,385 格。
 */
export const BURNING_ARENA_PIECES = Object.freeze([
  Object.freeze({ file: 'burning_arena1.nbt', ox: 0,  oy: 1,  oz: 0  }),
  Object.freeze({ file: 'burning_arena2.nbt', ox: 0,  oy: 1,  oz: 38 }),
  Object.freeze({ file: 'burning_arena3.nbt', ox: 47, oy: 1,  oz: 0  }),
  Object.freeze({ file: 'burning_arena4.nbt', ox: 47, oy: 1,  oz: 38 }),
  Object.freeze({ file: 'burning_arena5.nbt', ox: 0,  oy: 49, oz: 0  }),
  Object.freeze({ file: 'burning_arena6.nbt', ox: 0,  oy: 49, oz: 38 }),
  Object.freeze({ file: 'burning_arena7.nbt', ox: 47, oy: 49, oz: 0  }),
  Object.freeze({ file: 'burning_arena8.nbt', ox: 47, oy: 49, oz: 38 }),
]);

/**
 * 源方块名 → 本仓方块名。**空串 = 丢弃**（当作空气）。
 *
 * 用户要求方案 A：「方块全都来自现成方块，不要自创方块」⇒ 本表**只能**映射到
 * `src/voxel/blocks-data.js` 已注册的名字，**不新增任何方块声明、不新增贴图**。
 *
 * ⚠️ **未知源方块名必须 throw**（烘焙脚本侧）：`makeColumnSetter` 对未注册名字是
 * **静默 return**，那格会变成 air —— 方块层面完全看不出是映射错了（v1.80 高台烘焙教训）。
 *
 * ⚠️ **三类方块刻意不在本表**，由烘焙脚本的 classify 分支处理（同巨型金字塔口径）：
 *   · `lava` —— 要按**层**分流（见下方 `FLOOR_ROW` 注释），直查表会丢掉分层语义；
 *   · `*_stairs` —— 朝向在 `Properties.facing` 里，要转成 meta；
 *   · `*_slab` —— 半/整/倒置在 `Properties.type` 里，要分流。
 * 把它们塞进本表会让 classify 的分支永远走不到（直查先命中）—— 静默丢朝向/丢分层。
 *
 * 映射理由（逐个说明，便于将来体检）：
 *  - 同名直通 8 种：nether_bricks / netherrack / obsidian / chest / gold_block /
 *    polished_blackstone_bricks / polished_deepslate（本仓已有同名方块）。
 *  - `red_nether_bricks` → `nether_bricks_1`：本仓的第二种下界砖贴图（偏暗红），
 *    正是红色下界砖的最近似。
 *  - `chiseled_nether_bricks` / `cracked_nether_bricks` → `nether_bricks`：本仓无雕纹/裂纹
 *    变体，基础砖是同一色系（差异只在表面细节，方案 A 接受）。
 *  - `cracked_polished_blackstone_bricks` → `polished_blackstone_bricks`：同上。
 *  - `blackstone` → `deepslate`、`polished_blackstone` → `polished_deepslate`：
 *    本仓的深板岩族就是黑石的最近似（同为深灰石质）。
 *  - `crying_obsidian` → `obsidian`：本仓无哭泣黑曜石；obsidian 同色（紫斑丢失可接受）。
 *  - `polished_basalt` / `smooth_basalt` → `polished_diorite`：本仓无玄武岩族；
 *    磨制闪长石是现有的浅灰抛光石（玄武岩偏深灰，方案 A 的色差代价）。
 *  - `ancient_debris` → `debris`：本仓名字不带 ancient_ 前缀（同一语义）。
 *  - `raw_gold_block` → `gold_block`：本仓无粗金块。
 *  - `soul_soil` → `netherrack`：本仓无灵魂土；下界岩同为暗红地面材质。
 *  - `soul_fire` / `shroomlight` / `candle` → `glowstone`：本仓的发光方块只有 4 个
 *    （`emissive: 15`），glowstone 是「放在地上的光源」的最近似（灵魂火的青色丢失）。
 *  - `lantern` / `soul_lantern` → `hanging_lamp`：本仓唯一的吊灯几何（悬挂光源）。
 *  - `nether_brick_fence` / `*_wall` / `chain` → `handrail`：本仓唯一的细件栏杆几何。
 *    ⚠️ 这是 cutout 通道的最大来源（3,311 格），预算保险丝见 spec DR-5。
 *  - `twisting_vines(_plant)` / `weeping_vines(_plant)` → `vine`：本仓只有一种藤蔓。
 *  - `structure_block`（3 格，原模组的 Boss 刷怪标记）与 `cataclysm:altar_of_fire`
 *    （1 格，原 Boss 功能块）→ **丢弃**：两者都是功能标记不是美术内容，本仓不移植
 *    Boss 生成逻辑（spec §1）。
 */
export const BLOCK_MAP = Object.freeze({
  nether_bricks: 'nether_bricks',
  netherrack: 'netherrack',
  obsidian: 'obsidian',
  chest: 'chest',
  gold_block: 'gold_block',
  polished_blackstone_bricks: 'polished_blackstone_bricks',
  polished_deepslate: 'polished_deepslate',

  red_nether_bricks: 'nether_bricks_1',
  chiseled_nether_bricks: 'nether_bricks',
  cracked_nether_bricks: 'nether_bricks',
  cracked_polished_blackstone_bricks: 'polished_blackstone_bricks',

  blackstone: 'deepslate',
  polished_blackstone: 'polished_deepslate',
  crying_obsidian: 'obsidian',
  polished_basalt: 'polished_diorite',
  smooth_basalt: 'polished_diorite',

  ancient_debris: 'debris',
  raw_gold_block: 'gold_block',
  soul_soil: 'netherrack',

  soul_fire: 'glowstone',
  shroomlight: 'glowstone',
  candle: 'glowstone',
  lantern: 'hanging_lamp',
  soul_lantern: 'hanging_lamp',

  nether_brick_fence: 'handrail',
  nether_brick_wall: 'handrail',
  polished_blackstone_wall: 'handrail',
  polished_blackstone_brick_wall: 'handrail',
  chain: 'handrail',

  twisting_vines: 'vine',
  twisting_vines_plant: 'vine',
  weeping_vines: 'vine',
  weeping_vines_plant: 'vine',

  structure_block: '',
  'cataclysm:altar_of_fire': '',
});

/**
 * 半砖（`*_slab`）的**基础整块**显式表 —— `type` 为 `top` / `double` 时映射到这里。
 *
 * ⚠️ **不得用「剥掉 `_slab` 后缀再查 BLOCK_MAP」的写法**：`nether_brick_slab` 剥出
 * `nether_brick`（**单数**），而表里是 `nether_bricks`（复数）→ 查不到会静默落到兜底值。
 * 探针实测过这个坑：兜底成 `stone` 时 36 格 double 半砖全部变成浅灰石（在暗红场景里
 * 极其显眼），而且**格数完全对得上**，只有看画面才发现。
 *
 * ⚠️ `type=top` 刻意**不用** `half_block_updown`（本仓唯一的倒置半砖几何）：那个方块的
 * 贴图是 `planks_birch`（木色），在暗红下界砖场景里比「高 0.5 格的整块」显眼得多；
 * 而整块映射拿到的是 `deepslate` / `nether_bricks`（暗色，与主体一致），只损失 0.5 格轮廓。
 * 实测 `type=top` 有 231 格（不是罕见情况，pyramid 的「top 不应存在」假设在本素材不成立）。
 */
export const SLAB_BASE = Object.freeze({
  nether_brick_slab: 'nether_bricks',
  blackstone_slab: 'deepslate',
  polished_blackstone_slab: 'polished_deepslate',
});

/**
 * 碗内地板层在**归一化坐标**里的 y（= 产物 JSON 的 `floorRow`）。
 *
 * 实测（`--census` 可复现）：中心 40×40 区域 y=1..9 全实心（10 层基座），y=10 起
 * 空气占比 98.7% ⇒ 地板顶面 = 归一化 y=10。
 *
 * ⚠️ **两个消费方，语义不同但共用这一个数**（红线 1）：
 *   ① `apply.js` 阶段 2.93 用它算落位高度（`plateauY - (floorRow - 1)`），使地板顶面
 *      正好落在高台地带的 plateauY 上（与广场地面齐平，玩家无缝走入）；
 *   ② 烘焙脚本用它判**熔岩分层**（见下）。
 */
export const FLOOR_ROW = 10;

/**
 * 熔岩分层规则（用户 2026-11-09 裁定，spec DR-2.1.5）。
 *
 * 本仓 `lava` 是 `solid: true`（**不可穿越**的实心发光块）—— 与 Minecraft 的流体语义不同。
 * 素材地板层（归一化 y = `FLOOR_ROW`）实测有 **937 格 lava**，散布在整个 85×85 碗内
 * （占地板面积 13%，是「燃烧竞技场」主题的地面熔岩渠）。若直映 lava，碗内 13% 的地面
 * 走不过去 —— 那是**玩法缺陷**，不是观感问题。
 *
 * 裁定：**地板层 lava → `netherrack`**（暗红、可走、与主体同色系，保住燃烧主题）；
 * 其余层的 lava（墙内装饰流 y=11..40、悬空池 y=41..42，共 1,179 格）保持 `lava`
 * （solid 发光，作为墙面光源与视觉焦点）。
 */
export const FLOOR_LAVA_TARGET = 'netherrack';

/**
 * 产物必须满足的指标 —— 烘焙脚本与 `check:data` 共用这一份。
 *
 * 全部实测值（`npm run burningarena -- --census` 可复现；2026-11-09 探针用本仓
 * `tools/nbt-reader.mjs` 在 8 片真实素材上跑完整映射规则得到）：
 *  - 组装包围盒 **85×80×85**（x/z ∈ [0,84]，归一化 y ∈ [1,80]）
 *  - ⚠️ **三个格数要分开看**：
 *    · `sourceCells` 115,385 = 8 片里全部非空气格（含功能标记方块）；
 *    · `droppedCells` 4 = 其中丢弃的（`structure_block` 3 + `cataclysm:altar_of_fire` 1）；
 *    · `contentCells` 115,381 = 产物内容格数 = sourceCells − droppedCells。
 *    混用会让改映射时看不出少了多少。
 *  - ⚠️ **地板层不是满铺**：`floorCells` 4,825 / 7,225（碗内有空气格与熔岩渠）。
 *    这与城门竞技场（`ARENA_METRICS.floorCells` 满铺 3003）不同 —— 别照抄「满铺」断言。
 *  - ⚠️ **碗内中心不是可站地板**：中心列 (42,42) 归一化 y=10..40 是熔岩柱（地板层那格
 *    映射后为 netherrack，y=11..40 仍是 solid lava），顶上 y=41..45 是
 *    nether_bricks/chest/obsidian/gold_block/glowstone 小塔。
 *    ⇒ 任何「中心上方是空气」的断言都会恒红，取样点必须用偏移点（如 (cx+5, cz)）。
 *  - 通道分布：opaque 107,793（93.4%）/ cutout 7,588（6.6%）/ transparent 0。
 *    cutout 是预算关注点（spec DR-5 的保险丝针对它）。
 */
export const BURNING_ARENA_METRICS = Object.freeze({
  burningArena: Object.freeze({
    width: 85,          // 组装包围盒 X 跨度
    depth: 85,          // 组装包围盒 Z 跨度
    height: 80,         // 组装包围盒 Y 跨度（归一化 y ∈ [1,80]）
    floorRow: FLOOR_ROW,
    sourceCells: 115385,   // 8 片全部非空气格（含功能标记）
    droppedCells: 4,       // 丢弃的功能标记格（structure_block 3 + altar_of_fire 1）
    contentCells: 115381,  // 产物内容格数 = sourceCells − droppedCells
    floorCells: 4825,      // 地板层（归一化 y=10）的格数（**非满铺**）
    paletteSize: 19,       // 重映射后的目标方块种数
    opaqueCells: 107793,
    cutoutCells: 7588,
    lavaCells: 1179,       // 保留为 lava 的格数（非地板层）
    floorLavaCells: 937,   // 地板层被映射成 netherrack 的熔岩格数
  }),
});

/**
 * 烘焙输入指纹：`<8 片内容合并 sha 前 16>:<参数 sha 前 16>`。
 *
 * 两个消费方（烘焙脚本写进 meta、`check:data` 重算比对）必须拿到同一格式。
 * 改 `BLOCK_MAP` / `SLAB_BASE` / `BURNING_ARENA_PIECES` / `FLOOR_ROW` /
 * `FLOOR_LAVA_TARGET` / `BURNING_ARENA_METRICS` / `FACING_TO_ORIENT` / 任一片 `.nbt`
 * 都会改变指纹 → 门禁报「产物已过期，跑 npm run burningarena」，防静默过期。
 *
 * ⚠️ **8 片按 `BURNING_ARENA_PIECES` 顺序合并后整体求 sha**，不是逐片各算一个：
 * 逐片算会让「片顺序被调换」这种改动拓不到（而顺序错了 = 上下层错位，产物完全不对）。
 *
 * 已知盲区（与图标/夜空/巨树/高台/金字塔/竞技场同口径）：只改**烘焙算法**而不动参数时
 * 指纹不变 —— 那类改动须靠 `src/tests/test-burning-arena-gen.js` 的产物契约与 Tier 4 兜住。
 */
export function burningArenaInputFingerprint() {
  const missing = BURNING_ARENA_PIECES
    .map((p) => path.join(BURNING_ARENA_SOURCE_DIR, p.file))
    .filter((f) => !fs.existsSync(f));
  if (missing.length > 0) {
    throw new Error(
      `[灾变竞技场] 烘焙输入缺失 ${missing.length}/8 片：${missing.map((f) => path.relative(ROOT, f)).join(', ')}`
      + '（.nbt 入库，缺失 = 仓库损坏）',
    );
  }
  const merged = createHash('sha256');
  for (const p of BURNING_ARENA_PIECES) {
    merged.update(fs.readFileSync(path.join(BURNING_ARENA_SOURCE_DIR, p.file)));
  }
  const sourceSha256 = merged.digest('hex');
  const paramsSha256 = createHash('sha256')
    .update(JSON.stringify({
      BLOCK_MAP, SLAB_BASE, BURNING_ARENA_PIECES, FLOOR_ROW, FLOOR_LAVA_TARGET,
      BURNING_ARENA_METRICS, FACING_TO_ORIENT,
    }))
    .digest('hex');
  return {
    input: `${sourceSha256.slice(0, 16)}:${paramsSha256.slice(0, 16)}`,
    sourceSha256,
    paramsSha256,
  };
}
