// src/ui/icons.js — 背包图标 manifest 加载（§4.5.4 v1.26）
//
// 图标是**离线预生成**的（`npm run icons` → `tools/bake-icon-atlas.mjs`）：
// 等轴测投影 + 逐面采样贴图 + 装箱进 `assets/icons-atlas.png`，**裁剪数学也一并预生成**
// 成完整 CSS background 串写进 `assets/icons.json`。
//
// 运行时因此只需一行 `icon.style.background = ICON_CSS[name]` —— 取代 v1.24 之前的
// 「两级查表（tileOfName）+ 裁剪数学（tileStyle）+ 写 4 个样式属性（paintIcon）」。
// 实测该串与旧路径的 computed style 逐项相等（backgroundPosition / backgroundSize /
// backgroundImage 全同），等价性已验证。
//
// 两套尺寸对应两个消费方（**按显示尺寸烘焙** → 运行时零缩放，像素风锐利）：
//   `hotbar`    = 40px（快捷栏格）
//   `inventory` = 32px（背包面板格）
//
// 形状与配色的权威仍在 `src/mesh/mesher.js`（烘焙脚本 import 其几何，红线 1）；
// 本文件只是读取产物，不含任何几何/贴图逻辑。

import { resourceUrl } from '../core/resource-url.js';

/** manifest 的 URL（部署路径无关，v1.87：旧写法是根绝对路径 `/assets/icons.json`，
 *  在仓库挂子路径部署时 404） */
const MANIFEST_URL = resourceUrl('assets/icons.json');
/**
 * 图标 atlas 的 URL（同上）。
 *
 * **烘焙产物写相对名 + 运行时替换**：`background` 的 `url()` 按**文档/样式表基址**解析，
 * 所以产物里的相对名（`REL_TOKEN`）必须替换掉。替换目标由 `resourceUrl()` 派生 →
 * 仓库挂子路径部署时也落在正确位置（v1.87：此前写死 `/assets/icons-atlas.png`）。
 */
const ATLAS_URL = resourceUrl('assets/icons-atlas.png');

/** manifest 里的相对名占位符（烘焙产物写相对名，不绑死部署路径） */
const REL_TOKEN = "url('icons-atlas.png')";

/** 缓存：一次加载，两个面板共用（同一份 manifest 不重复 fetch） */
let _cache = null;

/**
 * 加载图标 manifest。
 *
 * **必须把相对名换成绝对路径**：`background` 的 url() 相对于**文档基址**解析 ——
 * fixture 页在 `/src/tests/index.html` 时 `url('icons-atlas.png')` 会去找
 * `/src/tests/icons-atlas.png`（404），实际文件在仓库根的 `assets/` 下。
 * 离线产物保持相对名是为了「产物不绑死部署路径」，路径修正在运行时做一次。
 *
 * @returns {Promise<{size:number, hotbar:Object<string,string>, inventory:Object<string,string>}>}
 */
export async function loadIconManifest() {
  if (_cache) return _cache;
  const meta = await (await fetch(MANIFEST_URL)).json();
  const abs = `url('${ATLAS_URL}')`;
  const fix = (map) => {
    const out = {};
    for (const [name, css] of Object.entries(map)) out[name] = css.replace(REL_TOKEN, abs);
    return out;
  };
  _cache = { size: meta.size, hotbar: fix(meta.hotbar), inventory: fix(meta.inventory) };
  return _cache;
}

/**
 * 取某方块的图标 CSS 串（缺失返回 undefined → 调用方降级为无图标空格）。
 *
 * 缺失只发生在「新增了方块但忘跑 `npm run icons`」——`npm run check:data` 会当场抓到
 * （背包集合每项都必须有图标条目），故运行时这条降级分支是兜底而非常态。
 *
 * @param {Object} manifest loadIconManifest() 的返回值
 * @param {'hotbar'|'inventory'} sizeKey 尺寸档
 * @param {string} name 方块名
 * @returns {string|undefined} 完整 CSS background 串
 */
export function iconCss(manifest, sizeKey, name) {
  return manifest?.[sizeKey]?.[name];
}
