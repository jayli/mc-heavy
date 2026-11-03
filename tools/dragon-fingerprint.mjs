// tools/dragon-fingerprint.mjs — 祭坛飞龙烘焙的**参数、产物指标与输入指纹**共享模块
//
// 唯一权威（红线 1）：烘焙脚本 `bake-dragon.mjs` 与数据契约门 `check-data.mjs` 都从这里
// import，不得各写一份。与 `arena-fingerprint.mjs` / `giant-pyramid-fingerprint.mjs` /
// `zombie-skin-fingerprint.mjs` 同一手法。
//
// 素材**入库**（`assets/dragon/src/`，与 `assets/arena/src/` 同口径：烘焙输入，不是渲染资源）
// → 指纹不依赖仓库外文件，任何机器 `npm run check` 结果一致。
//
// ⚠️ node 侧模块（要读文件），不进 `src/`，浏览器不消费。
// ⚠️ **`src/**` 与浏览器单测绝不能 import 它** —— 它依赖 `node:fs`，浏览器无法解析 `node:`
// 协议 → 整个模块不加载 → Worker 起不来 / 游戏白屏，而 `check:arch` 抓不到这类运行时解析
// 失败（AGENTS.md 的 `cloudland-kit-data.js` 同一条教训）。运行时消费的纯数据在
// `assets/dragon/dragon.json`（产物）与 `src/entities/dragons/dragon-config.js`（玩法数值）。
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const ROOT = path.resolve(import.meta.dirname, '..');

/** 烘焙输入（**入库**，不是渲染资源） */
export const DRAGON_SOURCE_PATH = path.join(ROOT, 'assets', 'dragon', 'src', 'amethyst_dragon.bbmodel');
/** 烘焙产物：模型 JSON（进运行期，`src/render/dragon-model.js` 加载） */
export const DRAGON_JSON = path.join(ROOT, 'assets', 'dragon', 'dragon.json');
/** 烘焙产物：贴图（进运行期，`TextureLoader` 加载） */
export const DRAGON_PNG = path.join(ROOT, 'assets', 'dragon', 'dragon.png');
/** 烘焙产物：伴随元数据（度量 / 指纹，不进运行期） */
export const DRAGON_META = path.join(ROOT, 'assets', 'dragon', 'dragon.meta.json');

/**
 * 烘焙参数。
 *
 * ⚠️ **`scale: 3` 是用户裁定**（spec §1 第 2 行「放大约 3 倍」）：素材原生体长 6.25 格，
 * 3 倍后 18.75 格。**产物已含这一倍**（px→格换算时一并乘），运行时**不再乘** ——
 * 两处都乘会得到 9 倍。`check:data` 用「产物 metrics.scale ≡ 本常量」双向钉住。
 *
 * ⚠️ **`faceMap` 是「Blockbench 面名 → three BoxGeometry 面序」的唯一权威**：
 * three 的面序固定为 `[+x, −x, +y, −y, +z, −z]`（`BoxGeometry` 的 `buildPlane` 调用序），
 * Blockbench/MC 的面名是 `east/west/up/down/south/north`。映射错会让贴图错位到邻面
 * （龙头的眼睛跑到侧面），而格数/指纹/单测全绿 —— 只有 Tier 4 像素能抓（spec §11 风险 1）。
 */
export const DRAGON_BAKE_PARAMS = Object.freeze({
  scale: 3,
  textureSize: 128,
  pxPerBlock: 16,
  faceMap: Object.freeze({
    east: '+x', west: '-x', up: '+y', down: '-y', south: '+z', north: '-z',
  }),
});

/**
 * 产物必须满足的指标 —— 烘焙脚本与 `check:data` 共用这一份。
 *
 * 全部实测值（解析 `amethyst_dragon.bbmodel` 可复现，spec §2）：
 *  - **115 个元素**全是 `cube` + `box_uv: true` + 自身 `rotation` 全为 0（旋转都在骨骼上）
 *  - **78 根骨骼**（outliner 层级），其中 **76 根带元素**（`root` 与 `tail_blade` 等不带）
 *  - 每元素 24 顶点 / 36 索引 → 2760 顶点 / 4140 索引
 *  - 模型空间 bbox 88 × 33.7 × 100 px = 5.5 × 2.11 × 6.25 格（1x）→ 3 倍后 16.5 × 6.3 × 18.75 格
 *
 * ⚠️ **`elementCount` 与 `boneCount` 是「素材事实」而不是「可调参数」**：素材换了它们才会变。
 * 把它们钉在这里的意义是「烘焙漏了元素/骨骼」会立刻被抓到（静默缺肉的形态是龙身上有洞）。
 */
export const DRAGON_METRICS = Object.freeze({
  elementCount: 115,
  boneCount: 78,
  bonesWithElements: 76,
  vertexCount: 2760,
  indexCount: 4140,
  scale: 3,
});

/**
 * 烘焙输入指纹：`<bbmodel 内容 sha 前 16>:<参数 sha 前 16>`。
 *
 * 两个消费方（烘焙脚本写进 meta、`check:data` 重算比对）必须拿到同一格式。
 * 改 `DRAGON_BAKE_PARAMS` / `DRAGON_METRICS` / `.bbmodel` 任一都会改变指纹 →
 * 门禁报「产物已过期，跑 npm run dragon」，防静默过期。
 *
 * 已知盲区（与图标/夜空/巨树/高台/竞技场/中世纪船同口径）：只改**烘焙算法**而不动参数时
 * 指纹不变 —— 那类改动须靠 `src/tests/test-dragon-bake.js` 的产物契约与 Tier 4 兜住。
 *
 * @returns {{input: string, sourceSha256: string, paramsSha256: string}}
 */
export function dragonInputFingerprint() {
  if (!fs.existsSync(DRAGON_SOURCE_PATH)) {
    throw new Error(`[龙] 烘焙输入缺失：${DRAGON_SOURCE_PATH}（.bbmodel 入库，缺失 = 仓库损坏）`);
  }
  const sourceSha256 = createHash('sha256').update(fs.readFileSync(DRAGON_SOURCE_PATH)).digest('hex');
  const paramsSha256 = createHash('sha256')
    .update(JSON.stringify({ DRAGON_BAKE_PARAMS, DRAGON_METRICS }))
    .digest('hex');
  return {
    input: `${sourceSha256.slice(0, 16)}:${paramsSha256.slice(0, 16)}`,
    sourceSha256,
    paramsSha256,
  };
}
