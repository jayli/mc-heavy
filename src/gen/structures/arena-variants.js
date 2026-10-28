// src/gen/structures/arena-variants.js — 城门竞技场的产物基名（纯数据，零 node 依赖）
//
// ⚠️ **必须与 `tools/arena-fingerprint.mjs` 的 `ARENA_VARIANTS` 保持一致**：
// 那份是 node 侧（依赖 `node:fs`，浏览器无法解析），这份是浏览器/Worker 侧。
// `check:data` 的 `[竞技场]` 环节双向钉住两者相等 —— 只加一边会让新变体
// **静默不出现**（`rasterizeStructure` 拿到空 blocks 直接 return，方块层面看不出）。
//
// 为什么不像 `cloudland-kit-data.js` 那样让 node 侧 re-export 本文件：
// 那边是「纯数据放 src 侧、`tools/*-fingerprint.mjs` re-export」；这里两边都只有
// 一个字符串数组，再加一层 re-export 只是多一跳。改为**双份 + 门禁断言**更直白。
//
// Worker 同构：本文件不得 import three、不得 fetch。

/** 竞技场 `placement` 类型名（= palette 无关的产物基名，camelCase） */
export const ARENA_VARIANTS = Object.freeze(['arenaGrass']);
