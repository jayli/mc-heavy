// tools/medieval-ship-fingerprint.mjs — 中世纪船烘焙的**映射表、产物指标与输入指纹**共享模块
//
// 唯一权威（红线 1）：烘焙脚本 `bake-medieval-ship.mjs` 与数据契约门 `check-data.mjs`
// 都从这里 import，不得各写一份。与 `giant-pyramid-fingerprint.mjs` /
// `arena-fingerprint.mjs` 同一手法。
//
// 素材**入库**（`assets/medieval-ship/src/`，与巨型金字塔同口径：烘焙输入，不是渲染资源）
// → 指纹不依赖仓库外文件，任何机器 `npm run check` 结果一致。
//
// ⚠️ node 侧模块（要读文件），不进 `src/`，浏览器不消费。
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { MEDIEVAL_SHIP_VARIANTS } from '../src/gen/structures/medieval-ship-data.js';

const ROOT = path.resolve(import.meta.dirname, '..');

export { MEDIEVAL_SHIP_VARIANTS };

/** 烘焙输入（**入库**，不是渲染资源）—— Medieval Ship（包内最大的船，1264 格） */
export const LITEMATIC_PATH = path.join(ROOT, 'assets', 'medieval-ship', 'src', 'medieval_ship.litematic');
/** 烘焙产物：结构 JSON 的**命名模板**（实际写 `medieval_ship_o{0..3}.json` 四个） */
export const SHIP_JSON = path.join(ROOT, 'assets', 'structures', 'medieval_ship.json');
/** 烘焙产物：伴随元数据（尺寸 / 计数 / 指纹，不进运行期） */
export const SHIP_META = path.join(ROOT, 'assets', 'structures', 'medieval_ship.meta.json');

/**
 * 用户对船体的**手工修复叠加层**（烘焙输入，入库）。
 *
 * 来源：用户在真实游戏里逐格改好一艘船（seed 14330926，船心 (603,214)，抽到 o0 变体），
 * 导出进度包后要求「完全按照我修复的样子，把船体的结构固化下来」。
 *
 * 坐标空间 = **`medieval_ship_o0` 产物的局部坐标**（y 已归一化，最低层 = 1）。
 * 烘焙时施加在 `baseCells` 上、**旋转之前** ⇒ 4 个变体同时带上修复
 * （旋转是加法群，故 o1/o2/o3 的坐标与 orient 自动跟着转）。
 *
 * ⚠️ **为什么是叠加层而不是改 `BLOCK_MAP`**：修复是**逐格 bespoke** 的 —— 106 处写入里
 * `handrailA` 的 orient 逐格不同（实测 0/1/2/3 = 31/15/33/26），取决于那一格在船上的
 * 具体位置与邻接关系，**无法从素材的 fence Properties 推导**（用户是把「梯子/孤立竖杆」
 * 改成了「有朝向的直段栏杆」，这是美术判断，不是映射规则）。
 * 若试图反推成规则，等于用第二份权威去猜用户的手（红线 1 精神：用户的存档就是权威）。
 */
export const USER_FIX_PATH = path.join(ROOT, 'assets', 'medieval-ship', 'src', 'user-fix-o0.json');

/**
 * 直台阶的 `facing` → 本仓 `meta` 低 2 位的 orient。
 *
 * ⚠️ **与巨型金字塔共用同一张表**（红线 1）：本仓所有「正置台阶」几何（`planks_step` /
 * `cobblestone_step` / `sand_step` / `stone_diorite_step`）与本次新增的**倒置**台阶
 * `planks_step_updown` 的高侧方向**逐 orient 完全一致** —— 已用**真实 mesher** 实测核对
 * （`node tools/bake-medieval-ship.mjs --census-orient`）：
 *
 *   orient=0 → 高侧 -X（西）   orient=1 → 高侧 +Z（南）
 *   orient=2 → 高侧 +X（东）   orient=3 → 高侧 -Z（北）
 *
 * 正因倒置台阶只是把「半幅层」从上半挪到下半、水平朝向不动，`half=bottom` 与
 * `half=top` 两种台阶才能共用这一张 facing→orient 表（用户明确要求「台阶有方向，别错了」）。
 *
 * ⚠️ **`facing` 语义 = 高侧**（Minecraft stairs 定义，巨型金字塔已实测确认：素材里
 * `facing` 反方向同层有实心 100%）。不要从 `src/player/orientation.js` 推这张表。
 */
export const FACING_TO_ORIENT = Object.freeze({
  west: 0,   // 高侧 -X
  south: 1,  // 高侧 +Z
  east: 2,   // 高侧 +X
  north: 3,  // 高侧 -Z
});

/**
 * 源方块名 → 目标方块名。**空串 = 丢弃**（当作空气）。
 *
 * key 必须与 litematic palette 剥净后的名字逐字一致（用 `--census` 核对）。
 * **台阶 / 半砖 / 栅栏不走这张表**：它们的形状 / 朝向在 `Properties` 里，由
 * `classify` 的专门分支处理（见 `bake-medieval-ship.mjs`）。
 *
 * ## 平替原则（用户裁定：「尽量用我已有的方块做平替，暂时先不要新创建方块」）
 * 全部映射目标都是 registry **现有**方块，按**实测 atlas 平均色**就近选取
 * （`node tools/bake-medieval-ship.mjs --census` 打印各色距）。唯二新增的
 * `planks_step_updown` / `half_block_updown` 是用户明确批准的「倒置台阶 / 倒置半砖」，
 * 且**零新贴图、零新几何定义**（复用 `planks_birch` 贴图 + 既有盒式几何，见 mesher.js）。
 *
 * ## 2026-11-04 用户改色（原为木/布近色平替，现改为「金属船壳 + 雪桅杆 + 大理石帆」）
 * 「我想对刚给浅水高台地图里增加的海盗船做一些优化，dark_planks 都换成 iron，
 *   birch_log 和 light_gray_cloth 换成 snow 和 marble」⇒ 逐项配对 = birch_log→snow、
 * light_gray_cloth→marble（本轮单独确认过）。**只改目标、不改源 key**，故格数 / bbox /
 * 台阶 148 / 半砖 146 / 栏杆 6-120-68 / palette 种类 13 **全部不变**（3 出 3 进）。
 *
 * ⚠️ **`snow` 的 `FACES_DATA` 是单字符串（六面同为 `Snow_top`）**，故桅杆顶部那 26 格
 * 是**纯白无木纹**的方块 —— 用户已知悉这是「换成雪」的必然结果。
 * ⚠️ 三个新目标全是 `cullMode:"opaque"` + `opaqueTable=1` + 满格 box 几何，与旧目标同档
 * ⇒ 顶点预算零变化（船体最坏仍 0.435% / cutout 0.756%），不需要重标定 `CAPACITY`。
 *
 * ## 2026-11-02 用户再改色（v2.35：「船体中的 iron 方块都替换成 oak_planks_1」）
 * 六个映射到 `iron` 的源方块统一改为 `oak_planks_1`（另一种橡木木板贴图，均值 156,130,112）。
 * **只改目标、不改源 key** ⇒ 格数 / bbox / 台阶 / 半砖 / 栏杆 / palette 种类 13 **全部不变**
 * （`iron` 出、`oak_planks_1` 进）。`snow` / `marble` / `giant_mangrove_log` 用户未要求，不动。
 * ⚠️ 用户原话写的是「oak_plants_1」，registry 里无此名 —— 按读音与上下文取 `oak_planks_1`。
 *
 * ## 2026-11-02 用户再改色（v2.36：「船身的 oak_planks_1 换成 acacia_planks，甲板之上的保留」）
 * 分界 = **产物局部 y ≤ 6**（甲板面在 y=7）⇒ 见下方 `HULL_RECOLOR`。这一步**不在这张表里**，
 * 因为 `spruce_planks` 与 `stripped_dark_oak_wood` 都跨了分界线，按源方块改做不到。
 */
export const BLOCK_MAP = Object.freeze({
  air: '',
  // ---- 船体木板 ----
  oak_planks: 'oak_planks',             // 船壳主体（Δ1.4，近乎原色）—— 保留木色
  spruce_planks: 'oak_planks_1',        // 船壳深色带（v2.35 起；原 dark_planks → iron）
  pale_oak_planks: 'snow',              // 桅杆顶部浅色件（原 birch_log 218,217,208 → snow 249,254,254）
  dark_oak_planks: 'oak_planks_1',      // 船尾楼深色板（同上）
  // ---- 桅杆 / 结构原木（stripped_*）----
  stripped_dark_oak_wood: 'oak_planks_1', // 甲板横梁
  stripped_dark_oak_log: 'oak_planks_1',  // 主桅杆
  stripped_spruce_log: 'oak_planks_1',    // 副桅杆
  stripped_spruce_wood: 'oak_planks_1',   // 龙骨
  // ---- 帆 / 旗 ----
  white_wool: 'marble',                 // 主帆（原 light_gray_cloth 163,163,163 → marble 240,238,228）
  red_wool: 'giant_mangrove_log',       // 旗帜（现有最接近正的红色，Δ30.5）—— 用户未要求改
  // ---- 玻璃 ----
  glass: 'glass_block',                 // 船尾窗（Δ3.7）
});

/**
 * **桅杆 / 柱子类源方块**（产物局部 y 再高也不参与船身改色）。
 *
 * 用户 2026-11-02：「船甲板上的柱子原本还是 oak_planks_1 的就还保留」⇒ 主/副桅杆必须豁免。
 * 实测（产物局部 y）：主桅 `stripped_dark_oak_log` 77 格（y 8~30）+ 副桅 `stripped_spruce_log`
 * 27 格（y 8~10）—— 其中 **8 格落在改色层内**（y=8），故豁免必须按**源方块**判，
 * 不能只靠 y 分界（否则 y=8 那 8 格桅杆会被一起染成勾棕）。
 *
 * ⚠️ **这两项同时也是 `BLOCK_MAP` 的 key**：桅杆依旧映到 `oak_planks_1`
 * （即「甲板之上保留浅木色」），本集合只控制**是否允许被 `HULL_RECOLOR` 改色**。
 * 改这张表前先跑 `npm run ship -- --census` 看源方块分布。
 */
export const MAST_SOURCE_BLOCKS = Object.freeze([
  'stripped_dark_oak_log',   // 主桅杆
  'stripped_spruce_log',     // 副桅杆
]);

/**
 * **船身定向改色**（v2.36 立 / v2.37 扩到 y≤9，用户 2026-11-02）。
 *
 * 两轮需求：
 *   ① v2.36：「我要把船身的 oak_planks_1 都换成 acacia_planks，船甲板之上的已经换好的
 *      oak_planks_1 先保留」+ 裁定「只换 y≤6（甲板围边算甲板）」。
 *   ② v2.37：「船体的 oak_planks_1 也换成 acacia_planks……船甲板上的柱子原本还是
 *      oak_planks_1 的就还保留」+ 裁定「改到 **y≤9**，桅杆/柱子保留」。
 *
 * 语义 = 「产物局部 y ≤ `maxY` 且**不是桅杆类源方块**的 `oak_planks_1` 改烘成 `acacia_planks`」——
 * 按**产物 y 层 + 源方块类别**两个条件分界，**不按源方块单条件分**（两者不重合，实测）：
 *
 * | 局部 y | oak_planks_1 构成 | 改色后 |
 * |---|---|---|
 * | 1~5 | 船壳 132 + 龙骨 24（v2.36 已改） | `acacia_planks` |
 * | 7 | 甲板围边 66 + 船壳顶 1 = 67 | `acacia_planks`（v2.37 新纳入） |
 * | 8 | 甲板横梁/船尾横排 7 + **桅杆 8** | 横排 7 改；**桅杆 8 保留** |
 * | 9 | **桅杆 8** | 全保留 |
 * | ≥10 | 桅杆 69 + 船尾板 9 = 78 | 全保留 |
 *
 * ⇒ 改色 **206 格**，保留 `oak_planks_1` **86 格**（其中桅杆 77 = 含 y=8 那 8 格）。
 *
 * ⚠️ **为什么必须「y 层 + 桅杆豁免」两个条件**：
 *   - 只按源方块改 ⇒ `spruce_planks`（y 1..7）与 `stripped_dark_oak_wood`（y 7..8）都跳了层，
 *     要么漏染船壳顶上那几格、要么把桅杆一起染了；
 *   - 只按 y 改 ⇒ y=8 那 8 格桅杆会被染成勾棕（用户明说「柱子保留」）。
 *
 * ⚠️ **副作用：`oak_planks_1` 在 y 7~9 与 `acacia_planks` 是交错的**（桅杆穿在甲板之间），
 * 这是**用户要的**（柱子保持浅木色），不要误当作「分层没做干净」而去「修复」。
 *
 * ⚠️ `maxY` / `mastSourceBlocks` 改任一项都要重跑 `npm run ship` 
 * 与三条门禁（烘焙自守 / `check:data` / Tier 4）。
 */
export const HULL_RECOLOR = Object.freeze({
  from: 'oak_planks_1',   // 只在**目标**上生效：已经映到别的方块的不受影响
  to: 'acacia_planks',
  maxY: 9,                // 产物局部 y（最低层 = 1）
  mastSourceBlocks: MAST_SOURCE_BLOCKS,   // 这些源方块产出的格永不参与改色
});

/**
 * 产物必须满足的全部指标 —— 烘焙脚本与 `check:data` 共用这一份。
 *
 * 全部实测值（`node tools/bake-medieval-ship.mjs --census` 可复现）：
 *   - 解码非空气格 1264 == `Metadata.TotalBlocks`（精确相等 ⇒ 位打包/索引序正确）
 *   - 素材全 bbox 是 37×37×14，但**丢掉那个孤立 glass 标记物后**深度收到 11
 *     （glass 在 (0,0,16)，距船体 15 格 ⇒ 保留会把船心偏移、AABB 虚胖 3 格）
 *   - 台阶 148（bottom 11 → planks_step / top 137 → planks_step_updown）
 *   - 半砖 146（bottom 52 → sand_slab / top 76 + trapdoor 18 → half_block_updown；
 *     另有 double 7 → 整块，不计入本项）
 *   - 栅栏 163 + 梯子 31（→ handrail / handrailA / vertical_pillar，按臂方向）
 */
export const SHIP_METRICS = Object.freeze({
  // 基准变体（o=0）的包围盒。o=1/o=3 的宽深对调（37×11 → 11×37）。
  width: 37,
  height: 37,
  depth: 11,
  blocks: 1263,      // 实心格（1264 源格 − 1 个孤立 glass 标记物，见偏离 ②）
                     // ⚠️ 用户修复**不改这个数**：106 写入（其中 6 格是新增）+ 6 删除 ⇒ 净 0
  droppedCells: 1,   // 被丢弃的孤立格数（26 邻域内无任何其它非空气格）
  stepCells: 148,    // planks_step + planks_step_updown 合计（用户修复未触碰台阶）
  slabCells: 146,    // sand_slab 52（bottom）+ half_block_updown 94（top slab 76 + trapdoor 18）
                     // ⚠️ 不含 double→整块的 7 格（它们已计入 oak_planks / sand）
  fenceCells: 163,   // **源**栅栏格数（分类阶段的计数，不受用户修复影响）
  ladderCells: 31,   // **源**梯子格数（同上）
  paletteSize: 14,   // 见 bake 脚本断言（ oak_planks/acacia_planks/oak_planks_1/snow/marble/
                     //   giant_mangrove_log/planks_step/planks_step_updown/sand_slab/
                     //   half_block_updown/handrail/handrailA/vertical_pillar/sand ）
                     // ⚠️ 2026-11-04 改色后为 13（dark_planks/birch_log/light_gray_cloth
                     //   三种出、iron/snow/marble 三种进）；2026-11-02 的 v2.35 把 iron
                     //   换成 oak_planks_1，仍 13（一出一进）；v2.36 的船身改色只换 **y ≤ 6**
                     //   那部分 ⇒ `oak_planks_1` 仍存活，`acacia_planks` 是**新进**的 ⇒ 13 → **14**
                     //   （这里的「增」是真增，不是替换）；v2.37 把改色层扩到 y≤9（桅杆豁免），
                     //   两者仍共存 ⇒ 仍是 **14**。

  /**
   * 用户修复叠加层的规模（`set` = 写入/替换，`remove` = 删除）。
   *
   * ⚠️ 进度包里共 118 条编辑，其中 **6 条是 no-op**（5 条「删空气」+ 1 条落在船 AABB 外的
   * `planks`）⇒ 有效 112 = 106 set + 6 remove。no-op 刻意不进叠加层：
   * 「删一格本来就是空气的格」写进产物会让叠加层含无意义项，且掩盖「坐标空间算错了」
   * 这类真实缺陷（坐标错时 remove 会找不到目标格 → 烘焙 throw，正是想要的防线）。
   */
  userFixSetCells: 106,
  userFixRemoveCells: 6,

  /**
   * **船身改色**（v2.36 立 / v2.37 扩到 y≤9）的产物契约：`HULL_RECOLOR` 实际改陈多少格。
   *
   * 实测拆解（产物局部 y，最低层 = 1）：
   *   - 改色 206 = y 1~5 的 132（船壳 108 + 龙骨 24，v2.36）
   *     + y=7 的 67（甲板围边 66 + 船壳顶 1）+ y=8 的 7（船尾横排）= **206**
   *     （y=8 该层 oak_planks_1 共 15 格 = 7 改 + 8 桅杆保留；y=9 的 8 格全是桅杆）
   *   - 保留 86 = 桅杆 77（主桅 `stripped_dark_oak_log` 56 + 副桅 `stripped_spruce_log` 21）
   *     + 船尾板 `dark_oak_planks` 9 = **86**（其中桅杆有 16 格落在改色层 y≤9 内）
   *   - 292 = 206 + 86（与 `v2.35` 的 `oak_planks_1` 总数逐位对上）
   *
   * ⚠️ **桅杆豁免是必需的**：主/副桅杆共 **16 格落在 y=8 与 y=9 两层**（各 8 格，都在改色层内），
   * 靠 y 分界沾不住它们 ⇒ 必须按源方块豁免（`MAST_SOURCE_BLOCKS`）。
   * **`mastCellsInRange` = 16** 是「改色层内仍为 `oak_planks_1` 的格数」——它的合法来源
   * **只有桅杆**（其余在层内都该被染）⇒ 多了 = 漏染、少了 = 桅杆被染色，两侧都卡死。
   * ⚠️ **三个数都要钉**：只钉「acacia 206」时，若桅杆豁免失效，acacia 会变 214 而
   * oak_planks_1 变 78 —— 两侧都钉能直接看出是哪边错了。
   */
  hullRecolor: Object.freeze({ acacia: 206, keptOakPlanks1: 86, mastCellsInRange: 16 }),

  /**
   * **施加叠加层之后**的栏杆类目标方块计数。
   *
   * ⚠️️ **这一项是「叠加层有没有被施加」的唯一判据**，不可删：
   * 用户修复的净效果是「格数不变、bbox 不变、源方块计数不变、palette 种类不变」——
   * 上面**每一个既有指标都逐位相同**（实测：1263 格 / 37×37×11 / 台阶 148 / 半砖 146 /
   * 源栅栏 163 / 源梯子 31 / palette 13 种）。所以只钉那些数字的门禁在「叠加层被漏掉」时
   * **全绿**（典型的无效盲区）。变化的只有栏杆三兄弟的**目标分布**：
   *
   * | 目标方块 | 修复前 | 修复后 |
   * |---|---|---|
   * | `handrail`（转角件） | 21 | **6** |
   * | `handrailA`（直段件） | 15 | **120** |
   * | `vertical_pillar`（竖柱） | 158 | **68** |
   *
   * 即用户把大量「孤立竖柱 / 转角件」换成了**有朝向的直段栏杆**（船帆之间的连接件）。
   */
  railCells: Object.freeze({ handrail: 6, handrailA: 120, vertical_pillar: 68 }),
});

/**
 * 读用户修复叠加层（烘焙脚本与 `check:data` 共用这一份解析，红线 1）。
 *
 * @returns {{set: Array<[number,number,number,string,number]>, remove: Array<[number,number,number]>}}
 */
export function readUserFixOverlay() {
  if (!fs.existsSync(USER_FIX_PATH)) {
    throw new Error(`[中世纪船] 用户修复叠加层缺失：${USER_FIX_PATH}（入库，缺失 = 仓库损坏）`);
  }
  const data = JSON.parse(fs.readFileSync(USER_FIX_PATH, 'utf8'));
  if (!Array.isArray(data.set) || !Array.isArray(data.remove)) {
    throw new Error('[中世纪船] 叠加层形状错（需 set / remove 两个数组）');
  }
  return { set: data.set, remove: data.remove };
}

/**
 * 烘焙输入指纹：`<litematic 内容 sha 前 16>:<参数 sha 前 16>`。
 *
 * 两个消费方（烘焙脚本写进 meta、`check:data` 重算比对）必须拿到同一格式。
 * 改 `BLOCK_MAP` / `SHIP_METRICS` / `FACING_TO_ORIENT` / **`HULL_RECOLOR`** / `.litematic` /
 * **`user-fix-o0.json`** 任一都会改变指纹 → 门禁报「产物已过期，跑 npm run ship」，防静默过期。
 *
 * ⚠️ **叠加层必须进指纹**：它是烘焙输入的一部分（与 `.litematic` 同地位）。
 * 漏了的话，用户再改一次船、只换叠加层文件 → 指纹不变 → 门禁全绿而产物是旧船形。
 *
 * 已知盲区（与金字塔/竞技场同口径）：只改**烘焙算法**而不动参数时指纹不变 ——
 * 那类改动须靠 `test-medieval-ship.js` 的产物契约与 Tier 4 兜住。
 */
export function medievalShipInputFingerprint() {
  if (!fs.existsSync(LITEMATIC_PATH)) {
    throw new Error(`[中世纪船] 烘焙输入缺失：${LITEMATIC_PATH}（.litematic 入库，缺失 = 仓库损坏）`);
  }
  const litematicSha256 = createHash('sha256').update(fs.readFileSync(LITEMATIC_PATH)).digest('hex');
  // 叠加层的**内容**进指纹（不只是路径）：读出来序列化，改一格就变指纹
  const overlay = readUserFixOverlay();
  const paramsSha256 = createHash('sha256')
    .update(JSON.stringify({
      BLOCK_MAP, SHIP_METRICS, FACING_TO_ORIENT, HULL_RECOLOR,
      variants: MEDIEVAL_SHIP_VARIANTS,
      userFix: overlay,
    }))
    .digest('hex');
  return {
    input: `${litematicSha256.slice(0, 16)}:${paramsSha256.slice(0, 16)}`,
    litematicSha256,
    paramsSha256,
  };
}
