// tools/stone-bricks-parse.mjs — 石砖/紫珀贴图烘焙的**纯函数**（无 node: 依赖）
//
// 为什么独立成文件：烘焙器与 `check:data` 要读文件（`node:fs`），而浏览器内单测要跑同一份
// 算法。把纯函数放这里、指纹模块从它 re-export，两侧共用一份逻辑（红线 1）。
// 手法照 `tools/turret-top-parse.mjs` / `tools/molang-eval.mjs`。
//
// ⚠️ **本文件不得 import `node:` 协议模块**：浏览器无法解析 → 整个模块不加载 → 测试页白屏，
// 而 `check:arch` 抓不到这类运行时解析失败。
//
// 素材与出处：`assets/stone-bricks/src/README.md`
// 设计：docs/superpowers/specs/2026-11-19-original-stone-bricks-and-purpur-design.md §5.2

/**
 * Minecraft Wiki 的 300×300 等轴测方块渲染图里**顶面**的三个顶点（实测标定）。
 *
 * 顶面是一个菱形：`tv` 是上顶点，`rv` / `lv` 是右 / 左顶点。
 * texel (u,v) 的中心 = tv + (u+.5)·(rv−tv)/16 + (v+.5)·(lv−tv)/16。
 *
 * ⚠️ **这三个坐标是实测拟合出来的，不是从定义推的**：在 ty∈[0,8] / 侧面高∈[60,80] /
 * dx∈[−4,4] 网格上扫「每个源色是否唯一映到一个渲染色」，只有本组值得到 bad=0
 * （四张图 mossy/cracked/chiseled/stone_bricks 全部 256/256 一致）。
 * 换成 (150,2)/(284,76)/(16,76) 这类「看着对」的坐标会让每个源色映到 9~24 个渲染色。
 */
export const TOP_FACE_GEOM = Object.freeze({
  tv: Object.freeze([148, 0]),
  rv: Object.freeze([282, 66]),
  lv: Object.freeze([14, 66]),
});

/** 像素键（只取 RGB —— alpha 不参与配色映射） */
function keyAt(img, x, y) {
  const i = (y * img.width + x) << 2;
  return `${img.data[i]},${img.data[i + 1]},${img.data[i + 2]}`;
}

/**
 * 从等轴测渲染图的顶面反解「源贴图色 → 渲染图色」的映射。
 *
 * **判据是「每个源色只能映到一个渲染色」**：图案一致时这是充要的；
 * 取样相位错了（或两张贴图图案本就不同）会让同一个源色落到多个渲染色上 ⇒ throw。
 * 这条判据比「均值接近」强得多 —— 均值对图案错位几乎不敏感。
 *
 * @param {{width:number,height:number,data:ArrayLike<number>}} render 300×300 渲染图
 * @param {{width:number,height:number,data:ArrayLike<number>}} tex 16×16 源贴图
 * @param {{tv:number[],rv:number[],lv:number[]}} [geom] 顶面三角（缺省 TOP_FACE_GEOM）
 * @returns {Map<string,string>} 键/值都是 `"r,g,b"`
 */
export function topFaceColorMap(render, tex, geom = TOP_FACE_GEOM) {
  const n = tex.width;
  if (tex.width !== tex.height) throw new Error(`源贴图必须是正方形（${tex.width}×${tex.height}）`);
  const { tv, rv, lv } = geom;
  const hits = new Map();
  for (let v = 0; v < n; v++) {
    for (let u = 0; u < n; u++) {
      const x = Math.round(tv[0] + (u + 0.5) * (rv[0] - tv[0]) / n + (v + 0.5) * (lv[0] - tv[0]) / n);
      const y = Math.round(tv[1] + (u + 0.5) * (rv[1] - tv[1]) / n + (v + 0.5) * (lv[1] - tv[1]) / n);
      if (x < 0 || x >= render.width || y < 0 || y >= render.height) {
        throw new Error(`顶面取样越界：texel(${u},${v}) → (${x},${y})，渲染图 ${render.width}×${render.height}`);
      }
      const src = keyAt(tex, u, v);
      const dst = keyAt(render, x, y);
      if (!hits.has(src)) hits.set(src, new Set());
      hits.get(src).add(dst);
    }
  }
  const map = new Map();
  for (const [src, set] of hits) {
    if (set.size !== 1) {
      throw new Error(`源色 ${src} 映到 ${set.size} 个渲染色（${[...set].join(' / ')}）`
        + ' —— 图案不一致或顶面取样相位错了，不得据此重映射');
    }
    map.set(src, [...set][0]);
  }
  return map;
}

/**
 * 按映射换色（alpha 原样，返回新缓冲，不改入参）。
 *
 * 未在映射里的颜色**一律 throw** —— 静默保留原色会让产物混着两套配色，
 * 而格数/尺寸/色数都可能看着正常。
 *
 * @param {{width:number,height:number,data:ArrayLike<number>}} tex
 * @param {Map<string,string>} map `topFaceColorMap` 的输出
 * @returns {{width:number,height:number,data:Uint8ClampedArray}}
 */
export function remapPalette(tex, map) {
  const out = new Uint8ClampedArray(tex.data.length);
  for (let i = 0; i < tex.data.length; i += 4) {
    const src = `${tex.data[i]},${tex.data[i + 1]},${tex.data[i + 2]}`;
    const dst = map.get(src);
    if (dst === undefined) throw new Error(`贴图含映射表外的颜色 ${src}（映射表与贴图不是同一张？）`);
    const [r, g, b] = dst.split(',').map(Number);
    out[i] = r; out[i + 1] = g; out[i + 2] = b; out[i + 3] = tex.data[i + 3];
  }
  return { width: tex.width, height: tex.height, data: out };
}

/**
 * 把「N×N texel 的放大图」按 texel 中心取样降回 N×N。
 *
 * ⚠️ **必须带众数一致性自检**：origin/span 取错一格时产物仍是「N×N 的紫色图」，
 * 尺寸/色数/均值都可能看着合理，而**图案整体错位**。故逐 texel 比对
 * 「中心取样值」与「该 texel 区域内不透明像素的众数」，不符即 throw。
 *
 * @param {{width:number,height:number,data:ArrayLike<number>}} src
 * @param {{origin:number, span:number, size:number}} opts
 *   origin = 不透明 bbox 左上角；span = bbox 边长；size = 目标边长（texel 数）
 * @returns {{width:number,height:number,data:Uint8ClampedArray}}
 */
export function downsampleByTexelCenter(src, opts) {
  const { origin, span, size } = opts;
  if (!(span > 0) || !(size > 0)) throw new Error(`span/size 必须为正（${span}/${size}）`);
  const step = span / size;
  const bound = [];
  for (let i = 0; i <= size; i++) bound.push(Math.round(origin + i * step));
  const out = new Uint8ClampedArray(size * size * 4);
  for (let ty = 0; ty < size; ty++) {
    for (let tx = 0; tx < size; tx++) {
      const cx = Math.round(origin + (tx + 0.5) * step);
      const cy = Math.round(origin + (ty + 0.5) * step);
      if (cx >= src.width || cy >= src.height) {
        throw new Error(`texel(${tx},${ty}) 中心 (${cx},${cy}) 越界（源图 ${src.width}×${src.height}）`);
      }
      const ci = (cy * src.width + cx) << 2;
      if (src.data[ci + 3] !== 255) {
        throw new Error(`texel(${tx},${ty}) 中心像素不是全不透明（alpha=${src.data[ci + 3]}）`
          + ' —— origin/span 标定错了');
      }
      const center = `${src.data[ci]},${src.data[ci + 1]},${src.data[ci + 2]}`;
      // 该 texel 区域内不透明像素的众数
      const hist = new Map();
      for (let y = bound[ty]; y < bound[ty + 1]; y++) {
        for (let x = bound[tx]; x < bound[tx + 1]; x++) {
          const i = (y * src.width + x) << 2;
          if (src.data[i + 3] !== 255) continue;
          const k = `${src.data[i]},${src.data[i + 1]},${src.data[i + 2]}`;
          hist.set(k, (hist.get(k) || 0) + 1);
        }
      }
      let mode = null, best = -1;
      for (const [k, c] of hist) { if (c > best) { best = c; mode = k; } }
      if (mode !== center) {
        throw new Error(`texel(${tx},${ty}) 中心色 ${center} ≠ 区域众数 ${mode}`
          + ' —— 取样相位错了（origin/span 与源图不匹配）');
      }
      const di = (ty * size + tx) << 2;
      out[di] = src.data[ci]; out[di + 1] = src.data[ci + 1];
      out[di + 2] = src.data[ci + 2]; out[di + 3] = 255;
    }
  }
  return { width: size, height: size, data: out };
}

/**
 * 「图案分区」签名：把每个 texel 的颜色替换成它所属的等价类编号（按首次出现序）。
 *
 * 用途 = 钉「重映射只改色值、不改图案」。**不能只比色数** —— 换色后色数可能不变
 * 而图案被打乱（本仓既有教训：计数类判据对分类退化零判别力）。
 *
 * @param {{width:number,height:number,data:ArrayLike<number>}} img
 * @returns {number[]} 长度 = width×height
 */
export function patternSignature(img) {
  const ids = new Map();
  const out = [];
  for (let i = 0; i < img.data.length; i += 4) {
    const k = `${img.data[i]},${img.data[i + 1]},${img.data[i + 2]}`;
    if (!ids.has(k)) ids.set(k, ids.size);
    out.push(ids.get(k));
  }
  return out;
}

/** 不透明像素（alpha≥8）的逐通道均值 —— 与既有草贴图门禁同口径 */
export function meanRgb(img) {
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < img.data.length; i += 4) {
    if (img.data[i + 3] < 8) continue;
    r += img.data[i]; g += img.data[i + 1]; b += img.data[i + 2]; n++;
  }
  return n ? [r / n, g / n, b / n] : [0, 0, 0];
}