// src/player/hotbar-items.js — 快捷栏方块数据（M3-4 拆分：player 与 ui/hotbar 共同消费的单一来源）
// 纯数据模块：无 three/DOM 依赖（player.js 消费放置语义，ui/hotbar.js 消费图标展示）。

/**
 * 快捷栏格数。**唯一权威**：`ui/hotbar.js` 建 DOM、`update()` 遍历的上界、
 * 以及 `ui/inventory.js` 的背包面板数字键上限都读这个值。
 *
 * 历史：M3-4 建 5 格；v2.96 用户要求「从五个调整成 9 个」（对齐原版 hotbar 的 1~9）。
 * 改这个值必须同时扩 `HOTBAR_ITEMS` 到同长度（`hotbar.js` 的模块级断言会抓长度不一致，
 * 形态是「第 10 格起永远空着」而不是报错）。
 */
export const HOTBAR_SIZE = 9;

/**
 * 快捷栏默认内容（**顺序冻结**，也是 `inventory.js` 的 `buildItemNames` 前置项）。
 *
 * 前 5 项是 M3-4 的既有冻结序（stone/dirt/grass/sand/cobblestone），v2.96 只在其后追加
 * 第 6~9 项：wood / glass_block / tnt / mine_cart —— 都是玩家开局就会用的建材/工具，
 * **不是注册序的自然延伸**。
 *
 * ⚠️ **为什么不能直接取注册序前 9 项**：`blocks-data.js` 的注册序第 6~9 位实测是
 * `water / swamp_water / cloud / glass_block`（三个流体/纯观赏方块），开局快捷栏会变成
 * 「水、沼泽水、云」——`inventory.js` 里 `buildItemNames` 的注释记录了同一断言。
 * 扩展这个清单时按「玩家开局就想拿到手」挑，不要按注册序抄。
 */
export const HOTBAR_ITEMS = [
  'stone', 'dirt', 'grass', 'sand', 'cobblestone',
  'wood', 'glass_block', 'tnt', 'mine_cart',
];
