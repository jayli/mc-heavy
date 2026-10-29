// src/gen/structures/shallow-water-tarn-data.js — 浅水高台变体的**纯数据**（零 node 依赖）
//
// ⚠️ **为什么单独一个文件、而不是塞进 `src/gen/structures/shallow-water-tarns.js`**：
// 运行期模块会被 Worker import，而 Worker 不能碰 `node:fs`；反过来 `tools/` 侧的烘焙脚本与
// `check-data` 需要同一份「有哪些变体、各自多大」的事实。把纯数据抽出来两边共用，
// 是 `cloudland-kit-data.js` / `arena-variants.js` 已经验证过的手法（红线 1）。
//
// ⚠️ **`src/**` 与浏览器单测绝不能 import `tools/shallow-tarns-fingerprint.mjs`**
// （它依赖 `node:fs` → 解析失败 → 模块不加载 → Worker 起不来 → 游戏白屏，
// 而 `check:arch` 抓不到这类运行时解析失败）。方向是单向的：
// `tools/*.mjs` → `src/gen/structures/shallow-water-tarn-data.js`，反向禁止。

/**
 * 五座高台的**角色**（语义固定，不随分量序变化）。
 *
 * | 角色 | 语义 | 来源分量 |
 * |---|---|---|
 * | tallest | 最高 | comp#1（65×56×71，59,760 格） |
 * | flatTop | 「平顶」（548 格同高台面，占足迹 37%） | comp#9（31×12×48） |
 * | midA / midB | 两个中型 | comp#10（28×23×37）/ comp#12（25×15×37） |
 * | small | 小型 | comp#20（15×24×12） |
 *
 * ⚠️ **按角色命名而不是按分量序**（`shallow_tarn_01..05` 恰好与角色同序是巧合）：
 * 重新选型时只需改这里的 `componentIndex`，产物名与消费方全都不动。
 */
export const SHALLOW_TARN_ROLES = Object.freeze(['tallest', 'flatTop', 'midA', 'midB', 'small']);

/**
 * 运行期实际使用的 5 个变体（产物基名）。
 *
 * ⚠️ **消费方一律从这里派生**（`structure-json.js` 的 `STRUCTURE_FILES`、
 * `apply.js` 的惰性预载、`check:data` 的产物清单）—— 写成字面量清单会让「加第 6 座」
 * 时漏改一处，形态是**静默不出现**（`rasterizeStructure` 拿到空 blocks 直接 return，
 * 方块层面完全看不出是漏了映射）。
 */
export const SHALLOW_TARN_VARIANTS = Object.freeze([
  'shallow_tarn_01', 'shallow_tarn_02', 'shallow_tarn_03', 'shallow_tarn_04', 'shallow_tarn_05',
]);

/**
 * 五座高台的尺寸与格数（烘焙实测，**由烘焙脚本写回、`check:data` 双向断言**）。
 *
 * ⚠️ 这里登记的是**产物契约**，不是「猜的值」：烘焙脚本算出的 bbox 与本表不符会 throw。
 * 改选型时必须同时改本表（烘焙脚本会把正确的数字打印出来供粘贴，同 `cloudland-kit-data.js`）。
 *
 * `width`/`depth` 是**产物坐标系的水平跨度**（含原点偏置，见烘焙脚本 §原点），
 * 消费方用它算 AABB 裁剪与环上占角。
 */
export const SHALLOW_TARN_METRICS = Object.freeze({
  shallow_tarn_01: { role: 'tallest', componentIndex: 1, width: 65, height: 56, depth: 71, blocks: 59760 },
  shallow_tarn_02: { role: 'flatTop', componentIndex: 9, width: 31, height: 12, depth: 48, blocks: 12461 },
  shallow_tarn_03: { role: 'midA', componentIndex: 10, width: 28, height: 23, depth: 37, blocks: 11485 },
  shallow_tarn_04: { role: 'midB', componentIndex: 12, width: 25, height: 15, depth: 37, blocks: 8051 },
  shallow_tarn_05: { role: 'small', componentIndex: 20, width: 15, height: 24, depth: 12, blocks: 2892 },
});

/**
 * 烘培时代表草的方块名（两种草的**基准色**）。
 *
 * 烘焙产物把素材的 `grass_block` 烘成它；光栅化后 `paintShallowTarnGrass`
 * 按**世界坐标噪声**把其中一半刷成 `light_grass`（用户 2026-11-01 选定「成片分块」）。
 *
 * ⚠️ **不用哨兵名**（如 `GRASS_PLACEHOLDER`）：`makeColumnSetter` 对未注册名字是
 * **静默 return**（那格变 air）—— 哨兵写不进世界。用真实方块名作为基准色，
 * 降级路径就是安全的（替换没跑到 → 世界里是深草，不是空洞）。
 */
export const GRASS_BASE_BLOCK = 'dark_grass';
