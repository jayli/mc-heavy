// src/gen/structures/medieval-ship-data.js — 中世纪船（Medieval Ship Epic）的**纯数据**（零 node 依赖）
//
// ⚠️ **为什么单独一个文件**：运行期模块会被 Worker import，而 Worker 不能碰 `node:fs`；
// 反过来 `tools/` 侧的烘焙脚本与 `check-data` 需要同一份「有哪些变体、各自多大」的事实。
// 把纯数据抽出来两边共用，是 `shallow-water-tarn-data.js` / `arena-variants.js` 已经
// 验证过的手法（红线 1）。
//
// ⚠️ **`src/**` 与浏览器单测绝不能 import `tools/medieval-ship-fingerprint.mjs`**
// （它依赖 `node:fs` → 解析失败 → 模块不加载 → Worker 起不来 → 游戏白屏，
// 而 `check:arch` 抓不到这类运行时解析失败）。方向是单向的：
// `tools/*.mjs` → 本文件，反向禁止。

/**
 * 4 个旋转变体的产物基名（o = 绕 Y 轴 90° 步长，与 mesher 的 `orient` 同一口径）。
 *
 * ⚠️ **为什么是 4 个文件而不是运行期旋转**：旋转在烘焙期用 mesher 导出的
 * `rotateOffset`（「朝向 → 几何」的唯一权威，红线 1）做一次，运行期零旋转逻辑。
 * 若运行期再写一份坐标旋转公式，两份漂移会让「船身朝向与台阶朝向不一致」
 * （静默缺陷，方块层面看不出）。
 *
 * ⚠️ **消费方一律从本表派生**（`structure-json.js` 的 `STRUCTURE_FILES`、`apply.js` 的
 * 惰性预载、`check:data` 的产物清单）—— 写成字面量清单会漏，而漏一个变体是
 * **静默不出现**（`rasterizeStructure` 拿到空 blocks 直接 return）。
 */
export const MEDIEVAL_SHIP_VARIANTS = Object.freeze([
  'medieval_ship_o0', 'medieval_ship_o1', 'medieval_ship_o2', 'medieval_ship_o3',
]);

/**
 * 各变体的尺寸（烘焙实测，**由烘焙脚本写回、`check:data` 双向断言**）。
 *
 * ⚠️ 登记的是**产物契约**：烘焙脚本算出的 bbox 与本表不符会 throw。
 * o=0/o=2 是 37×11（长轴沿 X），o=1/o=3 是 11×37（长轴沿 Z）—— 旋转 90° 宽深对调。
 * 高度恒 37（旋转不改 y）。
 */
export const MEDIEVAL_SHIP_METRICS = Object.freeze({
  medieval_ship_o0: { width: 37, height: 37, depth: 11, blocks: 1263 },
  medieval_ship_o1: { width: 11, height: 37, depth: 37, blocks: 1263 },
  medieval_ship_o2: { width: 37, height: 37, depth: 11, blocks: 1263 },
  medieval_ship_o3: { width: 11, height: 37, depth: 37, blocks: 1263 },
});

/**
 * 船体在产物坐标系里的**水平半宽**（非对称 AABB 判据用）。
 *
 * ⚠️ **不能用 `width/2` 对称假设**（与 `shallowTarnHalfWidth` 同一条教训）：
 * 烘焙原点是 `floor((min+max)/2)`，奇数跨度时左右不等（37 宽 → lo=18, hi=18；
 * 11 宽 → lo=5, hi=5 —— 恰好都是奇数故对称，但判据仍按真实 lo/hi 写，
 * 防将来素材换成偶数跨度时静默错位）。
 */
export function medievalShipHalfWidth(variant) {
  const m = MEDIEVAL_SHIP_METRICS[variant];
  if (!m) throw new Error(`未知的中世纪船变体：${variant}`);
  const loX = Math.floor((m.width - 1) / 2);
  const loZ = Math.floor((m.depth - 1) / 2);
  return { loX, hiX: m.width - 1 - loX, loZ, hiZ: m.depth - 1 - loZ };
}
