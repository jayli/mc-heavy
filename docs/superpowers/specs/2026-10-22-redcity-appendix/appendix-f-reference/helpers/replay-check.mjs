// 可选辅助：在临时目录里按 manifest 顺序把参考实现（cp 新文件 + git apply 补丁）套到当前 HEAD 上，验证「补丁还能按序落地」。
// 用法（在仓库根目录）：node docs/superpowers/specs/2026-10-22-redcity-appendix/appendix-f-reference/helpers/replay-check.mjs [--keep]
// 不改你的工作区：用 `git archive HEAD` 解到 /tmp 下的临时目录。HEAD 前进导致某个补丁失配时报告是哪个阶段哪个文件，退出码 1。
import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ref = path.resolve(here, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ref, 'manifest.json'), 'utf8'));
const repoRoot = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'redcity-replay-'));
execSync(`git -C "${repoRoot}" archive HEAD | tar -x -C "${tmp}"`, { shell: '/bin/bash' });
console.log(`临时目录 ${tmp}（基线 HEAD ${execSync(`git -C "${repoRoot}" rev-parse --short HEAD`, { encoding: 'utf8' }).trim()}；快照生成于 ${manifest.base}）`);

let failed = false;
for (const ph of manifest.phases) {
  for (const rel of ph.new) {
    const dst = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(path.join(ref, rel), dst);
  }
  if (ph.patch) {
    try {
      execFileSync('git', ['apply', '--check', path.join(ref, ph.patch)], { cwd: tmp, stdio: 'pipe' });
      execFileSync('git', ['apply', path.join(ref, ph.patch)], { cwd: tmp, stdio: 'pipe' });
    } catch (e) {
      console.log(`✗ ${ph.id}：补丁失配\n${String(e.stderr || e.message).slice(0, 600)}`);
      failed = true;
      break;
    }
  }
  console.log(`✓ ${ph.id}（新文件 ${ph.new.length}${ph.patch ? '，补丁已套' : ''}）`);
}
if (!process.argv.includes('--keep')) fs.rmSync(tmp, { recursive: true, force: true });
else console.log(`（--keep）保留 ${tmp}`);
console.log(failed ? '补丁未能按序落地' : `全部 ${manifest.phases.length} 个阶段按序落地`);
process.exit(failed ? 1 : 0);
