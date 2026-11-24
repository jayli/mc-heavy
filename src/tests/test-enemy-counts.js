// src/tests/test-enemy-counts.js — 屏幕上方敌人计数行的读数与格式化（Tier 1）
//
// 用户 2026-11-24：「在屏幕上方玩家心形血条的旁边（右侧）增加……丧尸数量……soldier 数量……
// 同时显示飞龙、守卫、焰魔的数量，都显示在一行。不要换行，如果空间不够就压缩，缩略为省略号」。
//
// 两项裁定（`ask_user_question`，2026-11-24）：① 计数 0 也常显；② 标签取名字简写。
//
// ⚠️ **本文件只测纯函数与读数逻辑**（无 DOM）。「真的画出来了 / 不换行 / 省略号」是
// 布局事实，只能在真实浏览器里量 ⇒ 归 `tests/enemy-counts.spec.mjs`（UI 档）。
//
// ⚠️ **`readEnemyCounts` 的士兵分支是本轮最易静默失效的判据**：士兵留尸 1.2s，
// 尸体仍在 `activeEntities()` 里 ⇒ 不过滤 `state.dead` 的形态是「打死一只计数不掉」。
// 数值判据（数量是正整数）抓不到它，必须构造「有尸体且尸体已死」的夹具。
import { test } from './runner.js';
import { assertEqual, assertTrue, assertDeepEqual } from './assert.js';
import {
  ENEMY_COUNT_ROWS, ENEMY_COUNTS_LEFT_PX, ENEMY_COUNTS_INTERVAL_MS, ENEMY_COUNTS_Z_INDEX,
  formatEnemyCounts, readEnemyCounts,
} from '../ui/enemy-counts.js';
import { DRAGON_TYPE } from '../entities/dragons/dragon-config.js';
import { GUARDIAN_TYPE } from '../entities/guardian/guardian-config.js';
import { IGNIS_TYPE } from '../entities/ignis/ignis-config.js';
import { SOLDIER_TYPE } from '../entities/soldiers/soldier-config.js';

test('计敌行: 五项读数与显示顺序固定（尸体/兵/龙/守/焰）', () => {
  assertEqual(ENEMY_COUNT_ROWS.length, 5, '用户点名五项：丧尸/士兵/飞龙/守卫/焰魔');
  assertDeepEqual(ENEMY_COUNT_ROWS.map((r) => r.label), ['尸', '兵', '龙', '守', '焰'],
    '简写标签（用户 2026-11-24 裁定②）');
  assertDeepEqual(ENEMY_COUNT_ROWS.map((r) => r.key),
    ['zombie', 'soldier', 'dragon', 'guardian', 'ignis'], '显示顺序 = 数组顺序');
});

test('计敌行: type 从各自 config 派生，不写字面量（改名时静默读成 0 的防线）', () => {
  const byKey = Object.fromEntries(ENEMY_COUNT_ROWS.map((r) => [r.key, r.type]));
  assertEqual(byKey.soldier, SOLDIER_TYPE);
  assertEqual(byKey.dragon, DRAGON_TYPE);
  assertEqual(byKey.guardian, GUARDIAN_TYPE);
  assertEqual(byKey.ignis, IGNIS_TYPE);
  // 丧尸的实体类型名历史上是字面量（zombie-system.js 直接写 'zombie'）——
  // 与 ZombieService.activeEntities() 的判据必须一致，否则读成 0。
  assertEqual(byKey.zombie, 'zombie');
});

test('计敌行: 格式化 = 「简写 空格 数字」，与 rows 同序同长', () => {
  const texts = formatEnemyCounts({ zombie: 3, soldier: 1, dragon: 0, guardian: 0, ignis: 0 });
  assertEqual(texts.length, ENEMY_COUNT_ROWS.length);
  assertDeepEqual(texts, ['尸 3', '兵 1', '龙 0', '守 0', '焰 0']);
});

test('计敌行: 0 也常显（用户裁定①，不是「有才显示」）', () => {
  const allZero = formatEnemyCounts({ zombie: 0, soldier: 0, dragon: 0, guardian: 0, ignis: 0 });
  assertDeepEqual(allZero, ['尸 0', '兵 0', '龙 0', '守 0', '焰 0'], '全 0 时五项都要在');
  for (const t of allZero) assertTrue(t.trim().length > 0, '任何一项都不得为空串（空 = 布局塌缩）');
});

test('计敌行: 非法/缺失计数当 0，不产出 NaN 或负数', () => {
  // 计数读错的形态是显示 `NaN`（比不显示更糟，且没有任何诊断价值）
  assertDeepEqual(formatEnemyCounts({}), ['尸 0', '兵 0', '龙 0', '守 0', '焰 0']);
  assertDeepEqual(
    formatEnemyCounts({ zombie: NaN, soldier: -5, dragon: undefined, guardian: null, ignis: '3' }),
    ['尸 0', '兵 0', '龙 0', '守 0', '焰 0'],
    '非有限数/负数/字符串一律当 0（不猜）');
  assertDeepEqual(formatEnemyCounts(undefined), ['尸 0', '兵 0', '龙 0', '守 0', '焰 0']);
});

test('计敌行: 小数向上取整到整数格（不显示 1.5 只丧尸）', () => {
  assertDeepEqual(formatEnemyCounts({ zombie: 2.9, soldier: 1.0000001 }),
    ['尸 2', '兵 1', '龙 0', '守 0', '焰 0']);
});

test('计敌行: readEnemyCounts 从真实集合读五项（丧尸/龙/守/焰走 entities.count）', () => {
  const game = {
    entities: { count: (t) => ({ zombie: 7, [DRAGON_TYPE]: 2, [GUARDIAN_TYPE]: 1, [IGNIS_TYPE]: 3 }[t] ?? 0) },
    soldiers: null,
  };
  assertDeepEqual(readEnemyCounts(game),
    { zombie: 7, soldier: 0, dragon: 2, guardian: 1, ignis: 3 });
});

test('计敌行: 士兵必须排除留尸（尸体仍在 activeEntities 里，不过滤则计数不掉）', () => {
  // 构造「2 只活的 + 3 具尸体」——这正是留尸 1.2s 窗口里的真实形态
  const soldiers = {
    activeEntities: () => [
      { id: 's0', state: { dead: false } },
      { id: 's1', state: { dead: true } },
      { id: 's2', state: { dead: false } },
      { id: 's3', state: { dead: true } },
      { id: 's4', state: { dead: true } },
    ],
  };
  const game = { entities: { count: () => 0 }, soldiers };
  assertEqual(readEnemyCounts(game).soldier, 2,
    '活着 2 只 ⇒ 显示 2（不过滤会显示 5，形态是「打死一只计数不掉」）');
});

test('计敌行: 装配顺序错/服务缺失时读 0 而不是抛错', () => {
  // 构造期可能先建 HUD 后建 service；抛错会让整个启动链断掉
  assertDeepEqual(readEnemyCounts({}),
    { zombie: 0, soldier: 0, dragon: 0, guardian: 0, ignis: 0 });
  assertDeepEqual(readEnemyCounts(undefined),
    { zombie: 0, soldier: 0, dragon: 0, guardian: 0, ignis: 0 });
});

test('计敌行: 左缘 = 血心右缘 + 8px（不写「看着差不多」的魔数）', () => {
  // 血心 left = 8（看板 left）+ 330（看板冻结宽）+ 8 = 346；每排 10 颗 × 18px = 180
  const HEALTH_LEFT = 8 + 330 + 8;
  const HEALTH_ROW_WIDTH = 10 * 18;
  assertEqual(ENEMY_COUNTS_LEFT_PX, HEALTH_LEFT + HEALTH_ROW_WIDTH + 8,
    '必须紧接血心右侧，且不与它重叠');
});

test('计敌行: UI 层级与血心同层 50（不得 100+）', () => {
  // AGENTS.md「UI 层级不等式」：hotbar 40 < 迷你地图 45 < 坐标/性能面板 50 = 血心 50
  //   = 本读数 50 < 伤害数字 55 < … < 启动错误遮罩 100
  assertEqual(ENEMY_COUNTS_Z_INDEX, 50);
});

test('计敌行: 刷新节流 250ms（与坐标/性能面板同节奏）', () => {
  assertEqual(ENEMY_COUNTS_INTERVAL_MS, 250);
});