// server-script/start-server.js — 静态文件服务器（设计文档 DR-7：无构建步骤）
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
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

  fs.readFile(filePath, (error, content) => {
    if (error) {
      if (error.code === 'ENOENT') {
        res.writeHead(404);
        res.end('404 Not Found');
      } else {
        res.writeHead(500);
        res.end('500 Internal Server Error: ' + error.code);
      }
    } else {
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content, 'utf-8');
    }
  });
});

server.listen(PORT, () => {
  const localIP = getLocalIP();
  console.log('Server running at:');
  console.log(`  - Local:   http://localhost:${PORT}/`);
  console.log(`  - Network: http://${localIP}:${PORT}/`);
  console.log('\nPress Ctrl+C to stop');
});
