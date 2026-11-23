// src/render/carbine-audio-ext.js — KV-9 / 雨声烘焙产物的扩展名（**单一常量**）
//
// 为什么单独一个文件而不是放 `carbine-audio-recipes.js` 或 `tools/*-fingerprint.mjs`：
//   · `audio-config.js`（src/，浏览器与 Node 都 import）需要它；
//   · `tools/carbine-audio-fingerprint.mjs`（Node 专用，import 了 node:path/fs）也需要它，
//     但 **src/ 不得 import tools/**（依赖方向）。
// 故把这个「产物格式」事实放在 src/ 的一个零依赖小模块里，tools 侧 re-export。
// 与 `pixel-ratio.js` / `sky-config.js` 同一手法（清单/常量放 three-free 模块，消费端 import）。

/** 产物容器：16-bit PCM wav（无损、浏览器原生解码、零编码器依赖） */
export const CARBINE_AUDIO_EXT = 'wav';