// tools/arena-fingerprint.mjs — 城门竞技场烘焙的**映射表、产物指标与输入指纹**共享模块
//
// 唯一权威（红线 1）：烘焙脚本 `bake-arena.mjs` 与数据契约门 `check-data.mjs` 都从这里
// import，不得各写一份。与 `giant-pyramid-fingerprint.mjs` / `azalea-trees-fingerprint.mjs` /
// `cloudland-kit-fingerprint.mjs` 同一手法。
//
// 素材**入库**（`assets/arena/src/`，与 `assets/giant-pyramid/src/` 同口径：烘焙输入，
// 不是渲染资源）→ 指纹不依赖仓库外文件，任何机器 `npm run check` 结果一致。
//
// ⚠️ node 侧模块（要读文件），不进 `src/`，浏览器不消费。
// ⚠️ **`src/**` 与浏览器单测绝不能 import 它** —— 它依赖 `node:fs`，浏览器无法解析
// `node:` 协议 → 整个模块不加载 → Worker 起不来 / 游戏白屏，而 `check:arch` 抓不到这类
// 运行时解析失败（B1 教训）。纯数据（尺寸常量等）在 `src/gen/structures/arena.js` 侧。
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const ROOT = path.resolve(import.meta.dirname, '..');

/** 烘焙输入（**入库**，不是渲染资源） */
export const ARENA_SOURCE_PATH = path.join(ROOT, 'assets', 'arena', 'src', 'arena1.schematic');
/** 烘焙产物：结构 JSON（进运行期，经 structure-json.js 加载） */
export const ARENA_JSON = path.join(ROOT, 'assets', 'structures', 'arena_grass.json');
/** 烘焙产物：伴随元数据（尺寸 / 计数 / 指纹，不进运行期） */
export const ARENA_META = path.join(ROOT, 'assets', 'structures', 'arena.meta.json');

/** `placement` 类型名 → 产物基名（`structure-json.js` 的 `STRUCTURE_FILES` 从这里派生） */
export const ARENA_VARIANTS = Object.freeze(['arenaGrass']);

/**
 * 素材自身的**容器方块**（不是美术内容）。烘焙时一律丢弃。
 *
 * 实测（`node tools/bake-arena.mjs --census` 可复现）：每个 `.schematic` 都自带
 *  - `barrier`：把整个选区包围盒掏空的**空心盒**（Arena1 在 y=5..37 共 236 格/层 × 33 层
 *    + 屋顶整层 3239 格）。本仓**没有**对应方块；它是选区内壁标记，不是内容。
 *  - `bedrock`：选区底部 4 层整铺（Arena1 y=0..3 共 9633 格）。它只是「垫底板」。
 *  - `air`：当然要丢。
 *
 * ⚠️ 这三项**不并入 `BLOCK_MAP`**：那张表的语义是「源美术方块 → 本仓方块」，
 * 把容器方块塞进去会让「未知源方块必须 throw」这条护栏失去意义（容器方块本来就该
 * 无条件丢弃，且 `check:data` 要分别断言两件事）。
 */
export const CONTAINER_BLOCKS = Object.freeze(['air', 'barrier', 'bedrock']);

/**
 * 被**替换**的源方块（不是容器方块，而是本设计主动丢弃、由栏杆环取代的原图栏杆）。
 *
 * 实测 Arena1 有 40 个 `fence` + 2 个 `fence_gate`，位置 x=2..40 / z=35..45，形态是
 * **两段 V 形斜向折线 + 中间两个门**。本仓三个栏杆件（`handrail` / `handrailA` /
 * `handrailB`）的臂**只沿 ±X / ±Z**，几何上不存在对角臂 ⇒ 逐格替换会在每个斜向交界处
 * 出现断口。用户裁定改为**外圈轴对齐闭合环**（spec DR-5），故整组丢弃。
 *
 * ⚠️ **与 `CONTAINER_BLOCKS` 分开的原因**：那个集合的语义是「素材自身的选区容器」
 * （任何素材都会有）；这个不是 —— 它是「本设计有意替换掉的美术内容」。混在一起会让
 * `check:data` 无法分别断言「容器方块已丢弃」与「原图栏杆已被环取代」。
 */
export const SUPERSEDED_BLOCKS = Object.freeze(['fence', 'fence_gate']);

/**
 * 源方块名 → 本仓方块名。**空串 = 丢弃**。
 *
 * 用户要求「方块全都来自现成方块，不要自创方块」⇒ 本表**只能**映射到
 * `src/voxel/blocks-data.js` 已注册的名字，**不新增任何方块声明、不新增贴图**。
 *
 * ⚠️ **未知源方块名必须 throw**（烘焙脚本侧）：`makeColumnSetter` 对未注册名字是
 * **静默 return**（`landmarks.js:281`），那格会变成 air —— 方块层面完全看不出是映射错了
 * （v1.80 高台烘焙的既有教训）。
 *
 * 映射理由（逐个说明，便于将来体检）：
 *  - `stained_glass` / `stained_glass_pane` / `glass` → `glass_block`：本仓只有一个玻璃块。
 *  - `stained_hardened_clay` → `clay`：本仓无彩色陶瓦，黏土是最接近的中性色。
 *  - `tall_grass` → `short_grass`：本仓的高草方块名就是 `short_grass`（`double_plant_grass_carried` 贴图）。
 *  - `double_plant` / `poppy` / `dandelion` → `flower` 族：本仓没有大花与具体花种，
 *    `double_plant`（高花）映射到 `allium`（观感最高的一朵），其余映射到 `flower`。
 *  - `log` → `wood`（深色橡木原木，本仓 `wood` 用的就是 `log_big_oak` 贴图）；
 *    `leaves` → `leaves`。
 *  - `hay_block` → `hay_bale`：本仓名字带下划线。
 *  - 其余同名直通。
 *
 * 只覆盖 Arena1 实际出现的源方块（`--census` 会打印未覆盖项并 throw）；将来启用
 * Arena2~6 时按各自普查结果补表。
 */
export const BLOCK_MAP = Object.freeze({
  grass: 'grass',
  dirt: 'dirt',
  sand: 'sand',
  sandstone: 'sandstone',
  stone: 'stone',
  cobblestone: 'cobblestone',
  gravel: 'gravel',
  clay: 'clay',
  stained_hardened_clay: 'clay',
  stained_glass: 'glass_block',
  stained_glass_pane: 'glass_block',
  glass: 'glass_block',
  water: 'water',
  flowing_water: 'water',
  hay_block: 'hay_bale',
  chest: 'chest',
  log: 'wood',
  leaves: 'leaves',
  tall_grass: 'short_grass',
  double_plant: 'allium',
  poppy: 'flower',
  dandelion: 'flower',
  deadbush: 'dead_bush',
  gold_block: 'gold_block',
});

/**
 * 栏杆环相对内容包围盒的**外扩量**（格）。
 *
 * = 1：环落在内容包围盒外侧那一圈 —— 实测这正是素材 `barrier` 环的位置
 * （Arena1：内容包围盒 x[2,40] z[2,78]，`barrier` 环在 x=1/41、z=1/79），
 * 也就是「素材作者画的选区边界」，语义上正是外圈栏杆该在的地方。
 *
 * ⚠️ 环的位置决定**占地尺寸**：内容 39×77 + 两侧各 1 格 = 41×79，与
 * `src/gen/structures/arena.js` 的 `ARENA_WIDTH` / `ARENA_DEPTH` 是同一个事实 ——
 * 后者由 `check:data` 与本常量双向断言（改一处必须改另一处）。
 */
export const RAIL_RING_INSET = 1;

/**
 * 产物必须满足的指标 —— 烘焙脚本与 `check:data` 共用这一份。
 *
 * 全部实测值（`node tools/bake-arena.mjs --census` 可复现）：
 *  - 内容包围盒 39×10×77（x[2,40] × y[2,11] × z[2,78]）
 *  - ⚠️ **两个格数要分开看**：`sourceCells` 3991 = 素材里非容器格（含原图栅栏）；
 *    `contentCells` 3949 = 3991 − 42（`fence` 40 + `fence_gate` 2，被外圈栏杆环
 *    取代，见 `SUPERSEDED_BLOCKS`）。混用会让改映射时看不出少了多少。
 *  - ⚠️ **内容最低层（y=2）不是地板层**：那是水池沙底。地板层在 y=4（草/沙/玻璃），
 *    归一化（minY → 1）后 `floorRow = 3`。这正是 `floorRow` 必须显式写入、不能靠
 *    「最低层就是地板」推导的原因（spec DR-1）。
 *  - 地板层满铺 39×77 = **3003 格，一格不缺**（水池只把 y=2..3 改成了沙/水、
 *    y=4 换成 `glass_block` 做透明水面盖）
 *  - 栏杆环 41×79 周长 = 2×(41+79) - 4 = **236 格**
 */
export const ARENA_METRICS = Object.freeze({
  arenaGrass: Object.freeze({
    width: 39,        // 内容包围盒 X 跨度
    depth: 77,        // 内容包围盒 Z 跨度
    height: 10,       // 内容包围盒 Y 跨度（源 y=2..11，含水池下挖 2 层）
    floorRow: 3,      // 地板层在归一化坐标里的 y（= 源 y=4 - minY 2 + 1）
    sourceCells: 3991,      // 素材里非容器格的格数（含被取代的原图栅栏）
    supersededCells: 42,    // 其中被外圈栏杆环取代的格数（fence 40 + fence_gate 2）
    contentCells: 3949,     // 产物内容格数 = sourceCells − supersededCells
    floorCells: 3003, // 地板层满铺 39×77
    railCells: 236,   // 栏杆环周长（41×79 矩形）
    footprintWidth: 41,   // 含栏杆环的占地（= ARENA_WIDTH）
    footprintDepth: 79,   // 含栏杆环的占地（= ARENA_DEPTH）
  }),
});

/**
 * 烘焙输入指纹：`<schematic 内容 sha 前 16>:<参数 sha 前 16>`。
 *
 * 两个消费方（烘焙脚本写进 meta、`check:data` 重算比对）必须拿到同一格式。
 * 改 `BLOCK_MAP` / `CONTAINER_BLOCKS` / `RAIL_RING_INSET` / `ARENA_METRICS` /
 * `.schematic` 任一都会改变指纹 → 门禁报「产物已过期，跑 npm run arena」，防静默过期。
 *
 * 已知盲区（与图标/夜空/巨树/高台/金字塔同口径）：只改**烘焙算法**而不动参数时指纹不变
 * —— 那类改动须靠 `src/tests/test-arena.js` 的产物契约与 Tier 4 兜住。
 */
export function arenaInputFingerprint() {
  if (!fs.existsSync(ARENA_SOURCE_PATH)) {
    throw new Error(`[竞技场] 烘焙输入缺失：${ARENA_SOURCE_PATH}（.schematic 入库，缺失 = 仓库损坏）`);
  }
  const sourceSha256 = createHash('sha256').update(fs.readFileSync(ARENA_SOURCE_PATH)).digest('hex');
  const paramsSha256 = createHash('sha256')
    .update(JSON.stringify({ BLOCK_MAP, CONTAINER_BLOCKS, SUPERSEDED_BLOCKS, RAIL_RING_INSET, ARENA_METRICS }))
    .digest('hex');
  return {
    input: `${sourceSha256.slice(0, 16)}:${paramsSha256.slice(0, 16)}`,
    sourceSha256,
    paramsSha256,
  };
}
