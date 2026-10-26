// src/gen/structures/cloudland-kit-data.js — Cloudland 套件的**纯数据**（零 node 依赖）
//
// ⚠️ **不要在这个文件里 import 任何 node 内建模块**：它要被浏览器单测
// （test-tarn-zone.js / test-tarn-zone-gen.js）与 Worker 侧的 structure-json.js import。
// `node:` 协议在浏览器里无法解析 → 整个模块不加载 → 测试全不跑 / Worker 起不来 / 白屏。
// 映射表与指纹计算留在 tools/cloudland-kit-fingerprint.mjs（那里可以依赖 node:fs）。
//
// 内容由 `npm run tarn`（tools/bake-cloudland-kit.mjs）实测后**手工固化** ——
// 烘焙脚本从本文件 import 这两个常量做断言，但**不往 src/ 写文件**（生成路径不得改源码）。
// 固化值漂移时烘焙脚本会打印待粘贴的整段源码，而不是自己去改它。

/**
 * 每个变体的尺寸与格数。**顺序 = 族内格数降序**，与产物编号绑定
 * （`cloudland_tarn_01` 是最大的那座 83,145 格）。
 * 消费方：烘焙脚本的断言、`check:data` 的 `[高台地带]` 环节（逐项比对产物 bbox 与格数）。
 */
export const KIT_METRICS = Object.freeze({
  cloudland_tarn_01: { width: 68, height: 35, depth: 60, blocks: 83145 },
  cloudland_tarn_02: { width: 58, height: 31, depth: 46, blocks: 50327 },
  cloudland_tarn_03: { width: 44, height: 27, depth: 48, blocks: 33215 },
  cloudland_tarn_04: { width: 40, height: 45, depth: 36, blocks: 32100 },
  cloudland_tarn_05: { width: 36, height: 46, depth: 32, blocks: 24087 },
  cloudland_tarn_06: { width: 36, height: 39, depth: 32, blocks: 22910 },
  cloudland_tarn_07: { width: 25, height: 37, depth: 29, blocks: 12624 },
  cloudland_tarn_08: { width: 20, height: 43, depth: 21, blocks: 10712 },
  cloudland_tarn_09: { width: 21, height: 37, depth: 25, blocks: 8952 },
  cloudland_tarn_10: { width: 17, height: 36, depth: 18, blocks: 5013 },
  cloudland_tarn_11: { width: 13, height: 31, depth: 12, blocks: 2025 },
  cloudland_arch_01: { width: 19, height: 32, depth: 36, blocks: 1480 },
  cloudland_arch_02: { width: 13, height: 24, depth: 20, blocks: 1185 },
  cloudland_arch_03: { width: 12, height: 36, depth: 30, blocks: 1142 },
  cloudland_arch_04: { width: 10, height: 21, depth: 24, blocks: 1113 },
  cloudland_arch_05: { width: 9, height: 11, depth: 16, blocks: 640 },
  cloudland_spire_01: { width: 12, height: 15, depth: 11, blocks: 436 },
  cloudland_spire_02: { width: 11, height: 17, depth: 10, blocks: 381 },
  cloudland_spire_03: { width: 10, height: 15, depth: 13, blocks: 345 },
  cloudland_spire_04: { width: 10, height: 14, depth: 11, blocks: 298 },
  cloudland_spire_05: { width: 7, height: 11, depth: 6, blocks: 134 },
  cloudland_spire_06: { width: 6, height: 11, depth: 5, blocks: 79 },
  cloudland_spire_07: { width: 3, height: 8, depth: 2, blocks: 21 },
  cloudland_giant_cloud_01: { width: 73, height: 38, depth: 38, blocks: 29836 },
  cloudland_giant_cloud_02: { width: 42, height: 26, depth: 44, blocks: 15283 },
  cloudland_giant_cloud_03: { width: 46, height: 28, depth: 35, blocks: 14177 },
  cloudland_giant_cloud_04: { width: 43, height: 31, depth: 30, blocks: 12358 },
  cloudland_giant_cloud_05: { width: 52, height: 26, depth: 29, blocks: 12235 },
  cloudland_giant_cloud_06: { width: 41, height: 17, depth: 35, blocks: 9494 },
  cloudland_giant_cloud_07: { width: 35, height: 32, depth: 26, blocks: 7945 },
  cloudland_giant_cloud_08: { width: 31, height: 13, depth: 37, blocks: 6883 },
  cloudland_giant_cloud_09: { width: 20, height: 12, depth: 18, blocks: 1432 },
  cloudland_giant_cloud_10: { width: 20, height: 9, depth: 7, blocks: 436 },
  cloudland_giant_cloud_11: { width: 7, height: 6, depth: 5, blocks: 121 },
  cloudland_giant_cloud_12: { width: 3, height: 6, depth: 5, blocks: 60 },
});

/**
 * 四族的产物基名。烘 11 座高台、运行时用其中 8 座（`TARN_KEPT_TARN_IDS`）—— **两个口径不要混**：
 * 这里列的是「烘出了什么」，保留哪 8 座由 `tarn-zone.js` 决定。
 * 巨型云 12 个全烘（云的选择与 seed 相关，烘焙期不知道 seed）。
 */
export const KIT_VARIANTS = Object.freeze({
  tarn: [
    'cloudland_tarn_01',
    'cloudland_tarn_02',
    'cloudland_tarn_03',
    'cloudland_tarn_04',
    'cloudland_tarn_05',
    'cloudland_tarn_06',
    'cloudland_tarn_07',
    'cloudland_tarn_08',
    'cloudland_tarn_09',
    'cloudland_tarn_10',
    'cloudland_tarn_11',
  ],
  arch: [
    'cloudland_arch_01',
    'cloudland_arch_02',
    'cloudland_arch_03',
    'cloudland_arch_04',
    'cloudland_arch_05',
  ],
  spire: [
    'cloudland_spire_01',
    'cloudland_spire_02',
    'cloudland_spire_03',
    'cloudland_spire_04',
    'cloudland_spire_05',
    'cloudland_spire_06',
    'cloudland_spire_07',
  ],
  giantCloud: [
    'cloudland_giant_cloud_01',
    'cloudland_giant_cloud_02',
    'cloudland_giant_cloud_03',
    'cloudland_giant_cloud_04',
    'cloudland_giant_cloud_05',
    'cloudland_giant_cloud_06',
    'cloudland_giant_cloud_07',
    'cloudland_giant_cloud_08',
    'cloudland_giant_cloud_09',
    'cloudland_giant_cloud_10',
    'cloudland_giant_cloud_11',
    'cloudland_giant_cloud_12',
  ],
});
