// src/entities/zombies/zombie-jev-prompts.js — 在线 AI 的文案唯一权威
//
// **为什么单独一个文件**：题面 / 选项描述 / 阈值是集成里被审计和修改最多的部分（TypeSafe
// 官方 skill 的「Keep all question wording in one place」）。散在 view/client 里会就地漂移。
//
// 同构层：无 DOM、无 three。

/**
 * 情景描述（state.situation）。
 * 只陈述规则，不暗示答案 —— 实测把「往哪走」直接写进 situation 会让模型照抄措辞。
 */
export const SITUATION = 'A zombie chases the player through terrain with walls. Walls can only be walked around, never broken. The ground window shows the terrain around the zombie.';

/**
 * 地面窗口的图例。
 *
 * ⚠️ **必须说明「未加载的地形也画成 `#`」**（spec §3.5）：窗口在加载边缘会把空气画成墙，
 * 模型若以为那是真墙，会在边界处莫名改道。这条也是 `test-zombie-jev-ai.js` 的断言之一。
 */
export const WINDOW_LEGEND = "Every character is one square meter of ground. '.' is flat ground the zombie can walk on. '#' is a solid wall, or ground more than one meter higher, or terrain that has not loaded yet: the zombie cannot enter it. 'Z' is the zombie, in the middle of the window. 'P' is the player.";
