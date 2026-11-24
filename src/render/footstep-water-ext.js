// src/render/footstep-water-ext.js — 水中脚步声烘焙产物的扩展名（**单一常量**）
//
// 为什么单独一个零依赖小文件（同 `carbine-audio-ext.js`）：
//   · `audio-config.js`（src/，浏览器与 Node 都 import）需要它；
//   · `tools/footstep-water-fingerprint.mjs`（Node 专用）也需要它，
//     但 **src/ 不得 import tools/**。
//
// ⚠️ **必须是 wav，不能是 mp3**：mp3 编码器会在首尾各补一段静音（encoder delay/padding），
// 循环接缝会多出几十毫秒的空档 —— 那正是「循环播放节奏保持不住」的形态。
// 实测本产物经 libmp3lame 往返后样本数恰好不变（98752），但那是**这一个长度**的巧合，
// 不是格式保证；wav 无损、浏览器原生解码、零编码器依赖，是唯一稳的选择。
export const FOOTSTEP_WATER_EXT = 'wav';