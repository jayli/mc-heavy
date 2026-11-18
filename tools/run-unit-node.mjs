#!/usr/bin/env node
// tools/run-unit-node.mjs — 浏览器内单测的 Node 快档入口（v3.15）
//
// 设计：docs/superpowers/specs/2026-11-18-test-tiering-and-runtime-design.md §5.3
//
// **为什么值得做**：实测 117 个单测文件里 **100 个在 Node 下全绿**（只需 fetch 垫片 +
// three 解析映射，**不需要浏览器**）。其中 6 个重 GEN 文件占 217.7s，其余 94 文件
// 1910 例串行只要 36.0s ⇒ 日常回归不必起 Chromium、不必等整页 150s+。
//
// **它不是替代**：白名单文件仍全部留在 `src/tests/index.html` 里（`check:data` 双向钉住），
// 浏览器整页照旧跑全集 ⇒ 零覆盖损失。本入口只是「额外的更快通道」。
//
// 用法：
//   node tools/run-unit-node.mjs            # 轻档（白名单 − 6 个重 GEN），日常门
//   node tools/run-unit-node.mjs --all      # 白名单全量（含重 GEN）
//   node tools/run-unit-node.mjs --only=test-mesher.js,test-physics.js
//
// ⚠️ **三条防空转判据**（policy §2.7「静默不跑」类）：
//   ① import 失败**硬失败**，不 catch 后继续 —— 否则该文件 0 例注册而 failed===0 全绿；
//   ② 每个文件**至少注册 1 例**，否则硬失败（同上形态）；
//   ③ 实际跑到的文件集合 ≡ 请求集合（例数用关系式对账，不写冻结计数）。
import path from 'node:path';
import fs from 'node:fs';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { UNIT_NODE_SAFE, UNIT_HEAVY, UNIT_LIGHT } from './test-tiers.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

// three 解析映射必须在任何 import 之前装好
register('./three-resolver.mjs', pathToFileURL(path.join(ROOT, 'tools') + path.sep));
const { installShim } = await import('./unit-node-shim.mjs');
installShim();

const argv = process.argv.slice(2);
const wantAll = argv.includes('--all');
const onlyArg = argv.find((a) => a.startsWith('--only='));
const tierArg = argv.find((a) => a.startsWith('--tier='));
const tier = tierArg ? tierArg.slice('--tier='.length) : 'all';

let files;
if (onlyArg) {
  files = onlyArg.slice('--only='.length).split(',').map((s) => s.trim()).filter(Boolean);
  const unknown = files.filter((f) => !UNIT_NODE_SAFE.includes(f));
  if (unknown.length) {
    console.error(`[test:unit] ✗ --only 里这些文件不在 Node 白名单内：${unknown.join(', ')}`);
    console.error('            （它们需要浏览器；拼错也会走到这里 —— 刻意硬失败，不静默少跑）');
    process.exit(1);
  }
} else {
  files = wantAll ? UNIT_NODE_SAFE : UNIT_LIGHT;
}
if (!files.length) {
  console.error('[test:unit] ✗ 文件清单为空 —— 空集合不得当成全绿');
  process.exit(1);
}

const { setCurrentFile, getRegisteredSuites, runAllTests } = await import('../src/tests/runner.js');

// ---- 逐文件 import：失败硬失败，且每个文件必须真的注册了用例 ----
const before = new Map(getRegisteredSuites().map((s) => [s.file, s.count]));
const perFile = [];
const tImport0 = performance.now();
for (const f of files) {
  const abs = path.join(ROOT, 'src', 'tests', f);
  if (!fs.existsSync(abs)) {
    console.error(`[test:unit] ✗ 白名单文件不存在：${f}`);
    process.exit(1);
  }
  setCurrentFile(f);
  const regBefore = getRegisteredSuites().reduce((n, s) => n + s.count, 0);
  try {
    await import(pathToFileURL(abs).href);
  } catch (err) {
    // ⚠️ 不得 catch 后继续：那会让该文件 0 例注册而整体 failed===0（假绿）
    console.error(`[test:unit] ✗ import 失败：${f}`);
    console.error(`            ${String(err && err.message || err).split('\n')[0]}`);
    console.error('            （该文件若新增了 DOM/Canvas 依赖，应从 UNIT_NODE_SAFE 移出到浏览器档）');
    process.exit(1);
  }
  const regAfter = getRegisteredSuites().reduce((n, s) => n + s.count, 0);
  const added = regAfter - regBefore;
  if (added <= 0) {
    console.error(`[test:unit] ✗ ${f} 一个用例都没注册（顶层注册被跳过？）—— 硬失败`);
    process.exit(1);
  }
  perFile.push({ file: f, count: added });
}
setCurrentFile(null);
const importMs = Math.round(performance.now() - tImport0);

// ---- 执行 ----
const r = await runAllTests({ only: files, tier, groups: {} });

// ---- 对账：实际跑到的文件集合 ≡ 请求集合 ----
const ranFiles = [...r.files].sort();
const wantFiles = [...files].sort();
const missing = wantFiles.filter((f) => !ranFiles.includes(f));
const extra = ranFiles.filter((f) => !wantFiles.includes(f));
if (missing.length || extra.length) {
  console.error('[test:unit] ✗ 文件集合对账失败');
  if (missing.length) console.error(`            请求了但没跑到：${missing.join(', ')}`);
  if (extra.length) console.error(`            没请求却跑了：${extra.join(', ')}`);
  process.exit(1);
}
const declared = perFile.reduce((n, x) => n + x.count, 0);
if (tier === 'all' && r.total !== declared) {
  console.error(`[test:unit] ✗ 例数对账失败：注册 ${declared} 例，实际跑 ${r.total} 例`);
  process.exit(1);
}

const heavyNote = wantAll ? '（含重 GEN）' : `（轻档，排除 ${UNIT_HEAVY.length} 个重 GEN 文件）`;
console.log(`[test:unit] ${files.length} 文件 / ${r.total} 例 ${heavyNote}`);
console.log(`            import ${importMs}ms + 执行 ${Math.round(r.duration)}ms`);
if (r.failed) {
  console.error(`[test:unit] ✗ ${r.failed} 例失败：`);
  for (const s of r.suites) {
    for (const t of s.tests) {
      if (t.status === 'failed') console.error(`  [${s.file}] ${t.name}\n      ${String(t.error).split('\n')[0]}`);
    }
  }
  process.exit(1);
}
console.log(`[test:unit] ✓ 全部通过（passed=${r.passed}）`);
void before;