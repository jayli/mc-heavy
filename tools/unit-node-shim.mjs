// tools/unit-node-shim.mjs — Node 快档的最小环境垫片（v3.15）
//
// **只补一件 Node 天生没有的事：读本地文件**。
//
// `resourceUrl()`（src/core/resource-url.js）用 `import.meta.url` 解析资源路径，
// 在 Node 下产出 `file:///…/assets/…`（浏览器下是 `http://host/assets/…`）。
// Node 的 fetch 不支持 file:// ⇒ 结构 JSON / atlas.json 全部加载失败，
// 而 `loadStructure` 的 catch 会把失败**吞成空结构**（静默）⇒ 用例以错误的原因失败。
//
// ⚠️ **刻意不加 DOM / Canvas / AudioContext / Image 垫片**（实测决定）：
// 假 DOM 只能造出假绿或假红 —— 实测加了最小 DOM 后 `test-player-place` 23 例仍全红
// （`window.addEventListener` 不是函数）、`test-bgm` 17 红（AudioContext）、
// `test-iso-icon` 4 红（createImageBitmap）。那些文件因此留在浏览器档，不搬进 Node。
//
// ⚠️ **`http(s)://` 原样透传**：垫片只在 `file://` 分支起作用，不改任何网络语义。
// 这条有单测钉住（tools/test-unit-node-runner.mjs）。
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const realFetch = globalThis.fetch;

/** 把 file:// URL 读成 Response；其余原样交给真 fetch */
export async function shimmedFetch(input, init) {
  const url = String(typeof input === 'string' ? input : (input && input.url) || input);
  if (url.startsWith('file://')) {
    const p = fileURLToPath(url);
    if (!fs.existsSync(p)) return new Response('not found', { status: 404 });
    const body = fs.readFileSync(p);
    const type = p.endsWith('.json') ? 'application/json' : 'application/octet-stream';
    return new Response(body, { status: 200, headers: { 'content-type': type } });
  }
  return realFetch(input, init);
}

/** 装上垫片（幂等） */
export function installShim() {
  if (globalThis.fetch !== shimmedFetch) globalThis.fetch = shimmedFetch;
}