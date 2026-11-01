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
 */
export const BLOCK_MAP = Object.freeze({
  air: '',
  // ---- 船体木板 ----
  oak_planks: 'oak_planks',             // 船壳主体（Δ1.4，近乎原色）
  spruce_planks: 'dark_planks',         // 船壳深色带（Δ20.6）
  pale_oak_planks: 'birch_log',         // 桅杆顶部浅色件（Δ16.4）
  dark_oak_planks: 'dark_planks',       // 船尾楼深色板（Δ6.1）
  // ---- 桅杆 / 结构原木（stripped_*）----
  stripped_dark_oak_wood: 'dark_planks', // 甲板横梁（Δ6.1）
  stripped_dark_oak_log: 'dark_planks',  // 主桅杆（Δ6.1）
  stripped_spruce_log: 'dark_planks',    // 副桅杆
  stripped_spruce_wood: 'dark_planks',   // 龙骨
  // ---- 帆 / 旗 ----
  white_wool: 'light_gray_cloth',       // 主帆（浅灰布， cloth 质感）
  red_wool: 'giant_mangrove_log',       // 旗帜（现有最接近正的红色，Δ30.5）
  // ---- 玻璃 ----
  glass: 'glass_block',                 // 船尾窗（Δ3.7）
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
  paletteSize: 13,   // 见 bake 脚本断言（ oak_planks/dark_planks/birch_log/light_gray_cloth/
                     //   giant_mangrove_log/planks_step/planks_step_updown/sand_slab/
                     //   half_block_updown/handrail/handrailA/vertical_pillar/sand ）

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
 * 改 `BLOCK_MAP` / `SHIP_METRICS` / `FACING_TO_ORIENT` / `.litematic` /
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
      BLOCK_MAP, SHIP_METRICS, FACING_TO_ORIENT,
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
