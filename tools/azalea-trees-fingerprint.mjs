// tools/azalea-trees-fingerprint.mjs — 杜鹃树烘焙的参数与输入指纹
//
// **两个消费者共用同一份逻辑**（红线 1），沿用 `giant-trees-fingerprint.mjs` 的模式：
//   - `tools/bake-azalea-trees.mjs` 烘焙时按本参数生成并写进 `assets/azalea-trees/trees.meta.json`
//   - `tools/check-data.mjs` 用当前参数重算并比对 → 不匹配即报「跑 npm run azaleatrees」
//
// trees.json 是**派生产物**，权威输入 = 入库的 `.schem` + 本文件的全部参数。改了源文件/映射表却忘跑
// 烘焙，产物会静默过期（渲染旧树形，方块层面完全看不出）。
//
// 素材**入库**（`assets/azalea-trees/src/`，与 `assets/giant-trees/src/` 同口径：烘焙输入，不是渲染资源）。
//
// node 侧模块（要读文件），不进 src/，浏览器不消费。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(__dirname, '..');

/** 产物与输入路径（烘焙脚本与门禁共用，避免两处各写一份） */
export const SCHEM_PATH = path.join(ROOT, 'assets', 'azalea-trees', 'src', 'asset_oak.schem');
export const TREES_JSON = path.join(ROOT, 'assets', 'azalea-trees', 'trees.json');
export const TREES_META = path.join(ROOT, 'assets', 'azalea-trees', 'trees.meta.json');

/**
 * 素材地台布局（**实测值，不是推断**）。
 *
 * `asset_oak.schem` 是 141×52×71，y=0 层是 `gray_concrete` 网格线 + `light_gray_concrete` 地台面
 * ⇒ 地台被网格线切成 10 列 × 5 行 = 50 个 13×13 的地台。
 * 切分方式（与巨树用 netherite 圈连通分量同精神）：**y=0 层全为灰线的行/列**即分隔线，
 * 分段之间的连续区间就是地台。烘焙脚本会断言「50 个、每个 13×13」，不对即 throw。
 *
 * **5 行是同一套几何，只有方块类型不同**（实测：同尺寸跨行的「树干+叶」坐标集合 symDiff = 0，
 * 唯第 3 行 moss 主题因装饰覆盖少 19~129 格叶）。行主题：
 *   行 0 (z 1..13)  = oak_leaves + flowering_azalea_leaves（樱花点缀）
 *   行 1 (z 15..27) = jungle_leaves + mangrove_leaves 混交
 *   行 2 (z 29..41) = **oak_leaves + azalea_leaves + flowering_azalea_leaves（杜鹃主题）** ← 本 Epic 取材行
 *   行 3 (z 43..55) = oak_leaves + moss_block 地被
 *   行 4 (z 57..69) = 纯 oak_leaves
 *
 * 所以「从小到大各选一个造型」= 杜鹃行的 10 个 pad（10 档尺寸各一个），不是从 50 个里挑。
 */
export const PAD_COUNT = 50;
export const PAD_SIZE = 13;
export const PAD_COLS = 10;
export const PAD_ROWS = 5;

/** 取材行在 (minZ, minX) 升序排序后的行下标（行 2 = 杜鹃主题） */
export const SOURCE_ROW = 2;

/** 变体数 = 取材行里的地台数 = 10（一档尺寸一个） */
export const VARIANT_COUNT = 10;

/**
 * 调色板（**`palette[0]` 恒为树干**，运行时地基填充按这个约定认树干 —— 与巨树同口径）。
 *
 * 树干 `azalea_log` 是用户裁定的替换目标（实测贴图均值 98/82/56，与素材橡木树皮同一色系，
 * 也是现有杜鹃树自己的树干方块）。
 *
 * ⚠️ **叶子只有一个槽 `palette[1]`** —— 素材里三种叶（oak/azalea/flowering_azalea）全部映射到它，
 * 具体落 `azalea_leaves` 还是 `azalea_flowers` 由运行时按 **30% 概率**逐格掷（用户裁定的
 * 「花叶相间」口径，与旧杜鹃树同一条规则）。**不能在这里区分花叶**：那样花的位置就被素材作死了，
 * 与「沿用 30% 概率」的裁定冲突。
 */
export const PALETTE = Object.freeze(['azalea_log', 'LEAF']);

/** 叶子槽的哨兵名（烘焙产物里它就是 `'LEAF'`，运行时替换成 azalea_leaves / azalea_flowers） */
export const LEAF_SLOT = 'LEAF';

/**
 * 源方块 → 调色板下标（-1 = 丢弃）。**唯一**的分类表：素材里出现、但表里没有的名字会让烘焙 throw
 * （不允许「悄悄丢掉」或「悄悄归到某类」—— `makeColumnSetter` 对未注册方块名是**静默 return**，
 * 那格变 air，方块层面完全看不出是映射错了）。
 *
 * 实测杜鹃行的源方块集合（z 29..41 全行统计）：
 *   air 85813 / oak_leaves 5197 / light_gray_concrete 1690 / azalea_leaves 1407 / oak_log 440 /
 *   flowering_azalea_leaves 427 / gray_concrete 143 / pink_petals 106 / short_grass 93
 *
 * 丢弃项与理由：
 *   - `pink_petals` / `short_grass`：**本仓没有这两个方块**。保留就要新增方块 + 贴图 + 图标 + 背包项，
 *     属另一个 Epic。丢弃后由运行时在树冠边缘铺 `moss` 替代（见 azalea-trees.js 的说明）。
 *   - 地台材质（`gray_concrete` / `light_gray_concrete`）：不是树。
 */
export const SOURCE_MAP = Object.freeze({
  air: -1,
  oak_log: 0,
  oak_leaves: 1,
  azalea_leaves: 1,
  flowering_azalea_leaves: 1,
  pink_petals: -1,
  short_grass: -1,
  gray_concrete: -1,
  light_gray_concrete: -1,
});

/**
 * 每档尺寸的验收值（实测，落区间外 = 切分/映射被改动，须人工复核）。
 * 顺序 = 由小到大（取材行内 pad 的 (minZ, minX) 序即 x 升序）。`{w, d, h, cells}`。
 *
 * 实测（**按 pad 裁剪后**、剥掉 y=0 地板）：
 *   #0 8×9×12  223    #1 9×10×13  312    #2 10×11×17 541   #3 12×12×22 640   #4 12×12×21 697
 *   #5 13×12×25 1034  #6 11×12×26 806    #7 12×11×27 836   #8 13×11×28 1027  #9 13×13×29 1352
 *
 * ⚠️ **尺寸必须按 pad 裁剪后测**：不裁剪时 #8/#9 会量到 27/41 宽 —— 那是把**相邻地台**的树叶
 * 算进了 bbox（叶会溢出 13×13 地台边缘），不是造型本身。实测差异 +14/+28 格，足以让验收区间
 * 失去意义（也是「写断言前先跑真实数据」的又一实例）。
 */
export const SIZE_EXPECTATIONS = Object.freeze([
  Object.freeze({ w: 8, d: 9, h: 12, cells: 223 }),
  Object.freeze({ w: 9, d: 10, h: 13, cells: 312 }),
  Object.freeze({ w: 10, d: 11, h: 17, cells: 541 }),
  Object.freeze({ w: 12, d: 12, h: 22, cells: 640 }),
  Object.freeze({ w: 12, d: 12, h: 21, cells: 697 }),
  Object.freeze({ w: 13, d: 12, h: 25, cells: 1034 }),
  Object.freeze({ w: 11, d: 12, h: 26, cells: 806 }),
  Object.freeze({ w: 12, d: 11, h: 27, cells: 836 }),
  Object.freeze({ w: 13, d: 11, h: 28, cells: 1027 }),
  Object.freeze({ w: 13, d: 13, h: 29, cells: 1352 }),
]);

/** 全部 10 档变体的总格数（实测 7468）—— 验收区间 ±2% */
export const TOTAL_BLOCKS_RANGE = Object.freeze([7300, 7650]);

/** 输入指纹：入库 .schem 的内容哈希 + 全部烘焙参数。.schem 缺失即 throw（它是入库文件，缺了是仓库损坏）。 */
export function azaleaTreesInputFingerprint() {
  if (!fs.existsSync(SCHEM_PATH)) throw new Error(`[杜鹃树] 烘焙输入缺失：${SCHEM_PATH}`);
  const schemSha = crypto.createHash('sha256').update(fs.readFileSync(SCHEM_PATH)).digest('hex');
  const params = JSON.stringify({
    padCount: PAD_COUNT, padSize: PAD_SIZE, padCols: PAD_COLS, padRows: PAD_ROWS,
    sourceRow: SOURCE_ROW, variantCount: VARIANT_COUNT, palette: PALETTE, map: SOURCE_MAP,
  });
  const paramsSha = crypto.createHash('sha256').update(params).digest('hex');
  return { schemSha256: schemSha, paramsSha256: paramsSha, input: `${schemSha.slice(0, 16)}:${paramsSha.slice(0, 16)}` };
}
