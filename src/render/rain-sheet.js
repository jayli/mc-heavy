// src/render/rain-sheet.js — 远景雨幕条纹图的加载（主线程，依赖 three）
//
// 产物由 `tools/bake-rain-sheet.mjs` 烘焙（上游 `makeRainSheet()` 逐字移植）。
// **为什么必须是纹理而不是 shader 里的 hash 格子**：见烘焙脚本文件头的实测根因
// （硬格子 ⇒ 相邻像素 82% 完全相同 ⇒ 光栅扫描观感）。
//
// ⚠️ 加载失败**不阻断启动**（同其余观感素材口径）：缺图时远景雨幕层整体不画，
// 近景雨丝/水花/雾/湿地面照常 —— 玩家仍看得到下雨，只是远处少了那层雨雾。
import * as THREE from 'three';
import { resourceUrl } from '../core/resource-url.js';

export const RAIN_SHEET_URL = 'assets/effects/rain-sheet.png';

/**
 * 加载条纹图。
 *
 * ⚠️ **三个采样参数是载荷性的**：
 *   · `wrapS/T = RepeatWrapping`：三层柱面投影的 uv 会远超 [0,1]（上游 wrap:true）；
 *   · `LinearFilter` + **mipmaps**：远处雨丝要柔（上游 aniso:1 + canvasTexture 默认 mip）；
 *     用 Nearest 会把细丝采成硬点 ⇒ 又回到光栅感。
 *   · `colorSpace = NoColorSpace`：它是**遮罩**（灰度覆盖率），不是颜色 ⇒ 不做 sRGB 解码。
 */
export async function loadRainSheet() {
  const loader = new THREE.TextureLoader();
  const tex = await loader.loadAsync(resourceUrl(RAIN_SHEET_URL));
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 1;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}