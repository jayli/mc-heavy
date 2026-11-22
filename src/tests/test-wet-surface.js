// src/tests/test-wet-surface.js — 按材质分类的湿表面（v3.31，Tier 1）
//
// 设计稿：docs/superpowers/specs/2026-11-22-wet-surface-rebuild-design.md
//
// 本文件守三类失效：
//   ① **分类覆盖**：新增方块漏分类 ⇒ 它在雨里静默保持干燥（玩家看到新建筑是干的）。
//   ② **参数关系**：粗糙度/镜面强度的序关系退化 ⇒ 「只有一种反光材质」（用户明确否决）。
//   ③ **位段隔离**：mesher 的类位挤进 bit0–14 ⇒ 阴影投射语义翻转（云开始投影）。
//
// ⚠️ 判据不读实现常量互推：覆盖性用 BLOCKS 全集对齐，位段用「掩掉类位后仍满足既有语义」。
import { test } from './runner.js';
import { assertEqual, assertTrue } from './assert.js';
import { createRegistry } from '../voxel/block-registry.js';
import { BLOCKS } from '../voxel/blocks-data.js';
import { WET_CLASS, WET_CLASS_DATA, wetClassOf } from '../voxel/wet-material-data.js';

const REG = createRegistry();
for (const b of BLOCKS) REG.register(b.name, b);
REG.freeze();

// ---------- 分类覆盖（Review Focus #1）----------

test('wet class: 全部 opaque/cutout 方块都已显式分类（150 项）', () => {
  const target = BLOCKS.filter((b) => b.cullMode === 'opaque' || b.cullMode === 'cutout');
  assertEqual(target.length, 150, 'opaque 105 + cutout 45');
  const missing = target.filter((b) => WET_CLASS_DATA[b.name] === undefined).map((b) => b.name);
  assertEqual(missing.join(','), '', '未分类方块');
  const names = new Set(target.map((b) => b.name));
  const extra = Object.keys(WET_CLASS_DATA).filter((n) => !names.has(n));
  assertEqual(extra.join(','), '', '多余条目（拼错的名字）');
});

test('wet class: cloud 必须是 NONE（用户报告的高空云层光晕的直接防线）', () => {
  assertEqual(wetClassOf('cloud'), WET_CLASS.NONE);
  assertEqual(wetClassOf('lava'), WET_CLASS.NONE);
  assertEqual(wetClassOf('glowstone'), WET_CLASS.NONE);
});

test('wet class: 未列出的名字回落 NONE（安全失败，不会湿错）', () => {
  assertEqual(wetClassOf('__no_such_block__'), WET_CLASS.NONE);
});

test('wet class: registry.wetClassTable 与数据表逐项一致', () => {
  for (const b of BLOCKS) {
    assertEqual(REG.wetClassTable[REG.idOf(b.name)], wetClassOf(b.name), b.name);
  }
});

test('wet class: 新增表不改方块清单指纹（旧存档零影响）', () => {
  assertEqual(REG.fingerprint(), REG.fingerprintOfPrefix(REG.count));
  assertTrue(/^[0-9a-f]{8}$/.test(REG.fingerprint()), '32bit 十六进制');
});