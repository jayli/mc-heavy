// src/player/hotbar-items.js — 快捷栏方块数据（M3-4 拆分：player 与 ui/hotbar 共同消费的单一来源）
// 纯数据模块：无 three/DOM 依赖（player.js 消费放置语义，ui/hotbar.js 消费图标展示）。
export const HOTBAR_ITEMS = ['stone', 'dirt', 'grass', 'sand', 'cobblestone'];
