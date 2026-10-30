// tools/shallow-tarns-fingerprint.mjs — 浅水高台的烘焙参数与指纹共享模块
//
// 烘焙脚本（`bake-shallow-tarns.mjs`）与数据契约门（`check-data.mjs` 的 `[浅水高台]` 环节）
// **共同 import 这一份**（红线 1：两处各写一份参数会漂移出门禁检查错文件的假绿）。
//
// ⚠️ 本文件依赖 `node:fs` / `node:crypto` → **只在 node 侧使用**。
// `src/**` 与浏览器单测**绝不能** import 它。纯数据（变体名 / 尺寸）在
// `src/gen/structures/shallow-water-tarn-data.js`，本文件 re-export 它。
//
// ## 素材
// `valturyterrainasset.schem`（Sponge Schematic v3，DataVersion 4440，211×102×361）。
// 用户给定素材，入库 `assets/shallow-tarns/src/`（**烘焙输入，不是渲染资源** ——
// 与 `assets/arena/src/`、`assets/giant-trees/src/`、`assets/sky/night-src/` 同口径）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { SHALLOW_TARN_ROLES, SHALLOW_TARN_VARIANTS, SHALLOW_TARN_METRICS, GRASS_MARKER_BLOCK } from '../src/gen/structures/shallow-water-tarn-data.js';

export { SHALLOW_TARN_ROLES, SHALLOW_TARN_VARIANTS, SHALLOW_TARN_METRICS, GRASS_MARKER_BLOCK };

const __dirname = path.dirname(import.meta.url.replace('file://', ''));
export const ROOT = path.join(__dirname, '..');

/** 素材（烘焙输入，入库） */
export const SCHEM_PATH = path.join(ROOT, 'assets', 'shallow-tarns', 'src', 'valturyterrainasset.schem');
/** 结构产物的输出目录（与其它结构 JSON 同目录） */
export const STRUCTURE_DIR = path.join(ROOT, 'assets', 'structures');
/** 伴生 meta（尺寸 + 源方块普查 + 指纹） */
export const SHALLOW_TARN_META = path.join(STRUCTURE_DIR, 'shallow_tarns.meta.json');

/**
 * 展台基座所在的 y 层（**整层丢弃**）。
 *
 * 实测：y=0 有 76,170 格，构成是 `white_concrete` 71,591 + `yellow_concrete` 3,108 +
 * `andesite` 661 + `stone` 588 + `light_gray_concrete_powder` 222 + 1 格 air ——
 * 是作者摆作品用的**白/黄混凝土展台**，不属于任何一座高台。
 *
 * ⚠️ **不剔除会让 72 个分量连成一片**（Cloudland 素材同一条教训）：展台把 28 个独立结构
 * 在水平面上全部连通。剔除后按 26 连通分量才得到 28 个 ≥400 格的结构。
 */
export const CONTAINER_LAYER_Y = 0;

/**
 * 源方块 → 目标方块名（`null` = 丢弃）。
 *
 * 素材实测只有 9 种源方块（剥前缀/去属性后）。映射原则：
 * **全部用游戏里已有的方块**（用户 2026-11-01：「都是采用我在游戏里已有的方块，不要自创方块」），
 * 且贴图明度层级要对上 —— 选目标前逐个量过 16×16 顶面贴图的平均 sRGB
 * （`light_gray_cloth` 163 / `clay` 165 / `marble` 240 / `polished_blackstone_bricks` 47）。
 *
 * | 源方块 | 格数 | 目标 | 依据 |
 * |---|---|---|---|
 * | `light_gray_concrete_powder` | 201,973 | `light_gray_cloth` | 贴图均值 **163**，源方块观感完全对得上（也是高台地带浅色石的口径） |
 * | `stone` | 79,744 | `clay` | 贴图均值 **161,166,179**（2026-10-30 用户指定「stone 方块改成 clay」；改前是 `stone` 126,126,126）。⚠️ 观感上黏土（165）与主材 `light_gray_cloth`（163）几乎同亮，且 B 高 18 → 原先「石头比主体暗一档」的层次会变弱（用户已知悉）；不要再自己把它改成其它色阶 |
 * | `andesite` | 70,770 | `marble` | 贴图均值 **240**（2026-10-30 用户指定「stone_diorite 改成 marble」；改前是 `stone_diorite` 189）。⚠️ **不能用 `stone_andesite`** —— 那个名字只出现在 `FACES_DATA.stone` 的顶底面里，**不是独立方块** |
 * | `green_wool` | 21,535 | **`dark_grass`** | 用户 2026-11-02：「所有 moss 方块都替换为 grass-dark-green」—— 直接烘成深草（**终态**，不参与深浅分块） |
 * | `grass_block` | 12,420 | **`light_grass`**（临时标记）| 用户 2026-11-01 要求用深/浅两种草 → 烘成标记，光栅化后按世界坐标噪声刷成 `dark_grass` / `light_grass`（见 `bake-shallow-tarns.mjs` 与 `paintShallowTarnGrass`）。⚠️ **不能用香草 `grass` 当标记**：`paintShallowTarnGrass` 扫整列，会把普通地形的草方块一起刷（用户 2026-11-02 报的真实缺陷）|
 * | `black_terracotta` | 1,444 | `polished_blackstone_bricks` | 贴图均值 **42**，最暗一档 |
 * | `black_concrete` | 703 | `polished_blackstone_bricks` | 同上 |
 * | `white_concrete` | 71,591 | `null` | **只在 y=0 展台**（见 `CONTAINER_LAYER_Y`） |
 * | `yellow_concrete` | 3,108 | `null` | 同上 |
 *
 * ⚠️ **草用「已注册的真方块」作标记**（初稿的哨兵 `GRASS_PLACEHOLDER` 已废除）：
 * `makeColumnSetter` 对未注册名字是**静默 return**（那格变 air）—— 哨兵根本写不进世界。
 * v2.15 起 `green_wool` 也烘成 `dark_grass`（终态），两者同名就**无法区分**，所以必须有一个
 * 独立标记：`grass_block → grass`，光栅化后 `paintShallowTarnGrass` 把每格标记刷成深/浅草。
 * 降级安全：刷色没跑到时世界里是香草草方块（能被真实页面断言拓到），不是空洞。
 *
 * ⚠️ **未知源方块必须 throw**（同一条静默 return 的理由）。
 *
 * ⚠️ **`polished_blackstone_bricks` 会被 `/brick/` 名字模式命中** ——
 * 所以门禁的「不引入砖木」判据必须用**白名单**而不是名字模式（见 `SHALLOW_TARN_PALETTE`）。
 */
export const BLOCK_MAP = Object.freeze({
  light_gray_concrete_powder: 'light_gray_cloth',
  stone: 'clay',
  andesite: 'marble',
  green_wool: 'dark_grass',
  grass_block: GRASS_MARKER_BLOCK,
  black_terracotta: 'polished_blackstone_bricks',
  black_concrete: 'polished_blackstone_bricks',
  white_concrete: null,
  yellow_concrete: null,
});

/**
 * 烘焙时代表草的方块名（v2.15-1：仅重命名，值仍为 `dark_grass`；Step 4 改真方块标记）。
 *
 * 烘焙产物把素材的 `grass_block` 烘成它；光栅化后 `paintShallowTarnGrass`
 * 按**世界坐标噪声**把每一格刷成 `light_grass`（用户 2026-11-01 选定「成片分块」）。
 */

/**
 * 允许出现在产物 palette 里的方块名（**白名单**）。
 *
 * ⚠️ **为什么不用名字模式**：`polished_blackstone_bricks` 会命中 `/brick/`，
 * 而它是本次特意选用的最暗一档贴图（替代素材的黑陶瓦/黑混凝土）。
 * 用名字模式会把合法映射误判成「引入了砖块族」。
 * 白名单是显式的：加新源方块时必须同步改 `BLOCK_MAP` 与这里两处 —— 那是一次性的、
 * 看得见的改动，比静默误判好。
 */
export const SHALLOW_TARN_PALETTE = Object.freeze([
  'light_gray_cloth', 'clay', 'marble', 'polished_blackstone_bricks',
  'dark_grass', GRASS_MARKER_BLOCK,   // 标记本身 = light_grass（见 shallow-water-tarn-data.js 的注释）
]);

/** 产物格式版本（改产物形状时 bump，`loadStructure` 侧不用它、只作审计线索） */
export const SHALLOW_TARN_FORMAT_VERSION = 1;

/** 一个变体的产物文件路径 */
export function variantPath(base) {
  return path.join(STRUCTURE_DIR, `${base}.json`);
}

/** 文件 sha256 */
export function fileSha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * 输入指纹：覆盖「素材字节内容」+「映射表」+「基座层」+「五个分量的分量序」。
 *
 * ⚠️ 已知盲区（与所有烘焙产物同）：只改**烘焙算法**而不动参数/素材时指纹不变 ——
 * 那类回归靠单测的产物契约与 Tier 4 兜住。
 *
 * @returns {{input: string, schemSha256: string, blockMap: string, components: string}}
 */
export function shallowTarnInputFingerprint() {
  const schemSha256 = fs.existsSync(SCHEM_PATH) ? fileSha256(SCHEM_PATH) : 'missing';
  const blockMap = crypto.createHash('sha256')
    .update(Object.entries(BLOCK_MAP).sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `${k}=${v ?? 'DROP'}`).join('|'))
    .digest('hex');
  const components = SHALLOW_TARN_VARIANTS
    .map((base) => {
      const m = SHALLOW_TARN_METRICS[base];
      return `${base}:${m?.componentIndex}:${m?.width}x${m?.height}x${m?.depth}:${m?.blocks}`;
    }).join('|');
  const input = crypto.createHash('sha256')
    .update(`${schemSha256}|${blockMap}|${CONTAINER_LAYER_Y}|${components}|${SHALLOW_TARN_FORMAT_VERSION}`)
    .digest('hex');
  return { input, schemSha256, blockMap, components };
}
