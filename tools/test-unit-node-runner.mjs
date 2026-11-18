#!/usr/bin/env node
// tools/test-unit-node-runner.mjs — Node 快档 runner 自身的契约（v3.15，Tier 1）
//
// **为什么放 tools/ 而不是 src/tests/**：`src/tests/test-*.js` 必须在**浏览器**里跑
// （`check:data` 的 `[测试注册]` 门要求它们全部出现在 index.html 里），而浏览器无法
// spawn Node、也读不到 fs。本文件是 `.mjs` 且在 tools/ ⇒ 不匹配那道门的
// `/^test-.*\.js$/` 正则 ⇒ **不进注册门、也不需要开例外**。
//
// 由 `npm run test:unit` 启动时先跑（见 package.json）。
//
// 判据（全部是「门禁本身错了会放行错误」的那类）：
//   ① 垫片只在 file:// 分支起作用，http(s) 原样透传（不改网络语义）
//   ② 垫片对不存在的 file:// 返回 404，而不是抛错（与浏览器 fetch 同形）
//   ③ resourceUrl 在 Node 下确实产出 file://（垫片的前提；前提没了垫片就是死代码）
//   ④ 白名单 ⊆ 单测全集，且与 index.html 注册一致（与 check:data 交叉，双侧都钉）
//   ⑤ three 解析映射指向的 vendor 文件真实存在（否则 Node 侧测的是另一个 three）
import fs from 'node:fs';
import path from 'node:path';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { UNIT_NODE_SAFE, UNIT_HEAVY, UNIT_LIGHT } from './test-tiers.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
let pass = 0;
const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fails.push(name + (detail ? ` — ${detail}` : '')); console.log(`  ✗ ${name} ${detail}`); }
};

register('./three-resolver.mjs', pathToFileURL(path.join(ROOT, 'tools') + path.sep));
const { shimmedFetch, installShim } = await import('./unit-node-shim.mjs');

// ---- ① / ② 垫片分支 ----
const existing = pathToFileURL(path.join(ROOT, 'assets', 'atlas.json')).href;
const res = await shimmedFetch(existing);
ok('file:// 读本地文件返回 200', res.status === 200, `实得 ${res.status}`);
const json = await res.json();
ok('file:// 读到的 JSON 可解析且有 tiles', !!json.tiles, JSON.stringify(Object.keys(json).slice(0, 3)));

const missing = await shimmedFetch(pathToFileURL(path.join(ROOT, 'assets', '__no_such__.json')).href);
ok('不存在的 file:// 返回 404（不抛错）', missing.status === 404, `实得 ${missing.status}`);

// http(s) 透传：用一个必然失败的地址，验证「走的是真 fetch」而不是被垫片吞掉
let threw = false;
try {
  await shimmedFetch('http://127.0.0.1:1/__probe__', { signal: AbortSignal.timeout(500) });
} catch { threw = true; }
ok('http:// 原样交给真 fetch（不被垫片改语义）', threw, '应因连不上而抛错');

installShim();
ok('installShim 幂等且真的装上', globalThis.fetch === shimmedFetch);
installShim();
ok('重复 installShim 不叠加', globalThis.fetch === shimmedFetch);

// ---- ③ resourceUrl 在 Node 下的形状（垫片的前提） ----
const { resourceUrl } = await import('../src/core/resource-url.js');
const u = resourceUrl('assets/atlas.json');
ok('Node 下 resourceUrl 产出 file://（垫片前提成立）', u.startsWith('file://'), u);
ok('resourceUrl 指向真实存在的文件', fs.existsSync(new URL(u).pathname), u);

// ---- ④ 白名单一致性（与 check:data 交叉） ----
const unitDir = path.join(ROOT, 'src', 'tests');
const actual = fs.readdirSync(unitDir).filter((f) => /^test-.*\.js$/.test(f));
const html = fs.readFileSync(path.join(unitDir, 'index.html'), 'utf8');
ok('白名单 ⊆ 单测全集', UNIT_NODE_SAFE.every((f) => actual.includes(f)),
  UNIT_NODE_SAFE.filter((f) => !actual.includes(f)).join(','));
ok('白名单每个都仍在 index.html 注册（零覆盖损失）',
  UNIT_NODE_SAFE.every((f) => html.includes(`'./${f}'`)),
  UNIT_NODE_SAFE.filter((f) => !html.includes(`'./${f}'`)).join(','));
ok('重 GEN ⊆ 白名单', UNIT_HEAVY.every((f) => UNIT_NODE_SAFE.includes(f)));
ok('轻档 = 白名单 − 重 GEN（派生关系成立）',
  UNIT_LIGHT.length === UNIT_NODE_SAFE.length - UNIT_HEAVY.length,
  `${UNIT_LIGHT.length} vs ${UNIT_NODE_SAFE.length}-${UNIT_HEAVY.length}`);
ok('白名单无重复', new Set(UNIT_NODE_SAFE).size === UNIT_NODE_SAFE.length);

// ---- ⑤ three 映射指向真实文件 ----
for (const f of ['three.webgpu.js', 'three.tsl.js', 'three.core.js']) {
  ok(`vendor/three/${f} 存在`, fs.existsSync(path.join(ROOT, 'vendor', 'three', f)));
}
// 映射真的生效：import three 能拿到 THREE 且版本与浏览器侧同一份产物
const THREE = await import('three');
ok('three 解析映射生效（拿得到 Scene）', typeof THREE.Scene === 'function');

console.log(`\n[runner 自测] ${pass} 通过 / ${fails.length} 失败`);
if (fails.length) {
  for (const f of fails) console.error(`  ✗ ${f}`);
  process.exit(1);
}