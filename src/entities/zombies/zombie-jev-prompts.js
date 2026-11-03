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
export const SITUATION = 'A zombie chases the player through terrain with walls. Walls can only be walked around, never broken. The ground grid shows the terrain around the zombie.';

/**
 * 地面格子图的图例。
 *
 * ⚠️ **必须说明「未加载的地形也画成 `#`」**（spec §3.5）：格子图在加载边缘会把空气画成墙，
 * 模型若以为那是真墙，会在边界处莫名改道。这条也是 `test-zombie-jev-ai.js` 的断言之一。
 */
export const WINDOW_LEGEND = "Every character is one square meter of ground. '.' is flat ground the zombie can walk on. '#' is a solid wall, or ground more than one meter higher, or terrain that has not loaded yet: the zombie cannot enter it. 'Z' is the zombie, in the middle of the grid. 'P' is the player.";

/** 题名（请求 `questions` 的键，也是回包 `answers` 的键） */
export const QUESTION_ID = 'step';

/**
 * 题干。
 *
 * 句式约束（TypeSafe 官方 skill）：
 * - **一个判断**，不合并「且/或」；
 * - **不在题干里描述选项**（描述归 criteria）；
 * - **不用双重否定**；
 * - **明说该避免什么**（重复访问 / 死胡同）—— 实测这两句是长迷宫能通过的关键（spec §2.4）。
 */
export const STEP_INSTRUCTIONS = 'Which candidate step is most likely to lead `Z` to `P` without getting stuck? Use both the ground grid and the candidate facts. Do not step onto a square the zombie has already visited when another step keeps the route open. It is better to walk farther in a straight line while keeping a way forward than to walk into a dead end or back the way it came.';

/**
 * 单个方向选项的描述。
 *
 * ⚠️ **选项名是方向名**（`north`…），不是 `A` / `option_1` —— 官方 skill 明说位置名给不了
 * 模型任何信息，还会引入位置偏置。
 */
export function criterionFor(name, f) {
  return `Step ${name.replace('_', ' ')}. After the step the player lies ${f.player_lies_toward} and is `
    + `${f.straight_line_distance_after_step} away, so this step is ${f.closer_or_farther}. `
    + `Open ground continuing that way: ${f.open_ground_ahead}. `
    + `Other ways out after the step: ${f.other_ways_out_after_the_step}. `
    + `The zombie has stood on that square ${f.times_already_visited} times before. `
    + (f.marked_dead_end
      ? 'The zombie already found out that this square leads to a dead end.'
      : 'This square is not known to be a dead end.');
}

/**
 * 构造完整 `questions`。
 * **无候选时返回空对象** —— 调用方据此跳过请求（四面围墙时一分额度都不该烧）。
 */
export function buildQuestions(candidateSteps) {
  const names = Object.keys(candidateSteps ?? {});
  if (names.length === 0) return {};
  const criteria = {};
  for (const name of names) criteria[name] = criterionFor(name, candidateSteps[name]);
  return { [QUESTION_ID]: { type: 'choice', instructions: STEP_INSTRUCTIONS, criteria } };
}
