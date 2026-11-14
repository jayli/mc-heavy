// server-script/start-server.js — 静态文件服务器（设计文档 DR-7：无构建步骤）
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8081;

function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const devName in interfaces) {
    for (const alias of interfaces[devName]) {
      if (alias.family === 'IPv4' && alias.address !== '127.0.0.1' && !alias.internal) {
        return alias.address;
      }
    }
  }
  return 'localhost';
}

const ROOT = path.join(__dirname, '..');

/**
 * gzip 结果缓存：`<路径>:<mtime>` → 压缩后的 Buffer。
 *
 * ⚠️ **键必须含 mtime**：只按路径缓存会让改了文件后的请求继续拿到旧内容
 * （dev server 的核心价值就是改完立刻生效）。
 * 不设上限是刻意的：本地开发最多几百个模块，且 mtime 变了旧条目自然淘汰。
 */
const gzipCache = new Map();

/** 统一的 gzip 响应写出（压缩路径与缓存命中路径共用，避免两处漂移） */
function sendGzip(res, contentType, zipped) {
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Encoding': 'gzip',
    'Vary': 'Accept-Encoding',
  });
  res.end(zipped);
}

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  // ⚠️ `.mjs` 必须显式登记：浏览器对 module script 做**严格 MIME 检查**，
  // 未登记的扩展名会回落到 `application/octet-stream` → 整个模块脚本拒绝加载
  // （形态：测试页 report 恒空、`window.__MC_TEST_RESULTS__` 为 undefined，
  // 而 node 侧 `node xxx.mjs` 一切正常 —— 2026-11-05 焰魔 Molang 测试踩到）。
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.woff': 'application/font-woff',
  '.ttf': 'application/font-ttf',
  '.eot': 'application/vnd.ms-fontobject',
  '.otf': 'application/font-otf',
  '.wasm': 'application/wasm'
};

const server = http.createServer((req, res) => {
  // 剥离 query string（/?vd=2 等测试参数），否则被当成文件路径 → 404
  const urlPath = new URL(req.url, 'http://localhost').pathname;
  const filePath = path.join(ROOT, urlPath === '/' ? 'index.html' : urlPath);

  // 防止目录遍历攻击
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  const extname = String(path.extname(filePath)).toLowerCase();
  const contentType = MIME_TYPES[extname] || 'application/octet-stream';

  /*
   * 静态文本资源 gzip（v2.99）。只改 dev server，生产部署（js-perf.cn）走自己的配置。
   *
   * **为什么值得做**：本仓无构建步骤，874 个模块源码直传。实测真实部署
   * （js-perf.cn 的 performance trace）**196 个响应全部没有 `content-encoding`**，
   * 而慢网络下这 6.63 MiB 正是启动超时的根因（`worker` 模块图 52 个模块要 90.9 秒）。
   *
   * **只压文本类**：PNG/JPEG/WAV/GLB 已是压缩格式，再压只烧 CPU 且体积可能变大。
   *
   * **不加 `Cache-Control`**：本地 dev 无缓存更能立刻看到改动；且缓存头对
   * 「首次冷启动」这个被测场景没有帮助（spec DR-6 已裁定）。
   */
  const COMPRESSIBLE = new Set(['.js', '.mjs', '.json', '.html', '.css', '.svg']);
  const gzipOk = /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
  const compress = gzipOk && COMPRESSIBLE.has(extname);

  // 先取 mtime（缓存键要用），再读内容。两次 syscall 对 dev server 可忽略。
  fs.stat(filePath, (serr, stat) => {
    const mtimeMs = serr || !stat ? 0 : stat.mtimeMs;
    fs.readFile(filePath, (error, content) => {
      handleFile(error, content, mtimeMs);
    });
  });

  /** 实际响应（`stat` 失败时 mtimeMs=0，等价于不缓存 —— 反正 readFile 也会失败） */
  function handleFile(error, content, mtimeMs) {
    if (error) {
      if (error.code === 'ENOENT') {
        res.writeHead(404);
        res.end('404 Not Found');
      } else {
        res.writeHead(500);
        res.end('500 Internal Server Error: ' + error.code);
      }
    } else if (compress) {
      // ⚠️ **必须用异步 gzip，不能用 `gzipSync`**（v2.99 实测教训）：
      // 同步版本阻塞 Node 单线程事件循环，模块图是**并发**拉的（14 个 Worker 各自拉
      // 52 个模块），40 个并发请求实测从 11~28ms 劣化到 37~43ms（2~3 倍）——
      // 而这笔延迟会直接叠加到 Worker 任务的往返时间上，把 `gen p95 < 8ms` 这类
      // 计时断言顶过线（实测 4.2ms → 11ms，8 轮稳定复现）。
      //
      // 缓存按「路径 + mtime」索引：dev server 的文件会被改，只用路径会把旧内容发出去。
      const key = `${filePath}:${mtimeMs}`;
      const cached = gzipCache.get(key);
      if (cached) {
        sendGzip(res, contentType, cached);
        return;
      }
      zlib.gzip(content, (zerr, zipped) => {
        if (zerr) {
          // 压缩失败不能变成 500：退回明文，内容仍然正确
          res.writeHead(200, { 'Content-Type': contentType });
          res.end(content, 'utf-8');
          return;
        }
        gzipCache.set(key, zipped);
        sendGzip(res, contentType, zipped);
      });
    } else {
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content, 'utf-8');
    }
  }
});

server.listen(PORT, () => {
  const localIP = getLocalIP();
  console.log('Server running at:');
  console.log(`  - Local:   http://localhost:${PORT}/`);
  console.log(`  - Network: http://${localIP}:${PORT}/`);
  console.log('\nPress Ctrl+C to stop');
});
