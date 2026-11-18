#!/usr/bin/env node
// tools/run-spec-tier.mjs — 按档位跑 Playwright spec（v3.15）
//
// 清单唯一权威在 `tools/test-tiers.mjs`；本脚本只做「读清单 → 拼文件列表 → 转发」。
//
// ⚠️ **空集合硬失败**：档位名拼错时若静默转发 0 个文件，playwright 会报
// "no tests found" 但退出码可能是 0 ⇒ 看起来像通过。故这里先校验档位名与文件存在性。
//
// 用法：node tools/run-spec-tier.mjs core [额外的 playwright 参数…]
import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { SPEC_TIERS } from './test-tiers.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const [tier, ...rest] = process.argv.slice(2);
const names = Object.keys(SPEC_TIERS);
if (!tier || !names.includes(tier)) {
  console.error(`[test:${tier || '?'}] ✗ 未知档位名。可用：${names.join(' / ')}`);
  process.exit(1);
}
const files = SPEC_TIERS[tier].map((n) => `tests/${n}.spec.mjs`);
const missing = files.filter((f) => !fs.existsSync(path.join(ROOT, f)));
if (missing.length) {
  console.error(`[test:${tier}] ✗ 清单里的 spec 不存在：${missing.join(', ')}`);
  console.error('            （check:data 的 [测试分档] 门也会抓到，这里提前失败便于定位）');
  process.exit(1);
}
if (!files.length) {
  console.error(`[test:${tier}] ✗ 档位为空 —— 空集合不得当成全绿`);
  process.exit(1);
}
console.log(`[test:${tier}] ${files.length} 个 spec`);
const r = spawnSync('npx', ['playwright', 'test', ...files, ...rest], { cwd: ROOT, stdio: 'inherit' });
process.exit(r.status === null ? 1 : r.status);