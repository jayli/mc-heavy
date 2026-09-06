// tools/validate-weapon-assets.mjs — M4 受控 GLB 资产静态安全与大小验证
//
// 在复制资产、Playwright 和提交前运行（`npm run validate:weapon-assets`）。
// 只允许 glTF 2.0 二进制容器：验证 magic/version、解析 JSON chunk，
// 校验 manifest 三条目、精确文件大小上限、无外链 buffer/image、无 extensionsRequired，
// 并输出每个文件的 bytes / mesh / primitive / image / animation / skin 数。
// 失败 → process.exitCode = 1 并打印 id/path/reason。
//
// M4 规格 §4.3：当前三件模型不使用 Draco、KTX2、动画或皮肤；
// 因此 M4 不引入对应 decoder。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

// manifest：id → 相对路径 + 精确文件大小上限（字节）。
// 上限来自实测文件大小（pistol 1,620,828 / mag7 94,248 / minigun 32,884）向上取整，
// 防止资产被意外替换/膨胀后静默进入仓库。
const MANIFEST = {
  pistol: { path: 'assets/models/weapons/pistol.glb', maxBytes: 2 * 1024 * 1024 },
  mag7: { path: 'assets/models/weapons/mag7.glb', maxBytes: 256 * 1024 },
  minigun: { path: 'assets/models/weapons/minigun.glb', maxBytes: 128 * 1024 },
};

const GLB_MAGIC = 0x46546c67; // 'glTF' little-endian
const CHUNK_TYPE_JSON = 0x4e4f534a; // 'JSON'

const failures = [];
const fail = (id, filePath, reason) => failures.push({ id, path: filePath, reason });

function parseGlb(buffer, id, filePath) {
  if (buffer.byteLength < 12) {
    fail(id, filePath, '文件小于 GLB 头部（12 字节）');
    return null;
  }
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const magic = view.getUint32(0, true);
  const version = view.getUint32(4, true);
  const totalLength = view.getUint32(8, true);
  if (magic !== GLB_MAGIC) {
    fail(id, filePath, `magic 不是 glTF 二进制容器（0x${magic.toString(16)}）`);
    return null;
  }
  if (version !== 2) {
    fail(id, filePath, `glTF 版本 ${version}，只接受 2.0`);
    return null;
  }
  if (totalLength !== buffer.byteLength) {
    fail(id, filePath, `头部声明长度 ${totalLength} ≠ 实际文件长度 ${buffer.byteLength}`);
    return null;
  }
  // 找 JSON chunk（第一个 chunk 必须是 JSON）
  if (buffer.byteLength < 20) {
    fail(id, filePath, '缺少 chunk 头部');
    return null;
  }
  const chunkLength = view.getUint32(12, true);
  const chunkType = view.getUint32(16, true);
  if (chunkType !== CHUNK_TYPE_JSON) {
    fail(id, filePath, `首个 chunk 不是 JSON（0x${chunkType.toString(16)}）`);
    return null;
  }
  const jsonText = new TextDecoder('utf-8').decode(
    buffer.subarray(20, 20 + chunkLength),
  );
  try {
    return JSON.parse(jsonText);
  } catch (err) {
    fail(id, filePath, `JSON chunk 解析失败：${err.message}`);
    return null;
  }
}

function validateOne(id, entry) {
  const filePath = path.join(ROOT, entry.path);
  if (!fs.existsSync(filePath)) {
    fail(id, entry.path, '文件不存在');
    return;
  }
  const buffer = fs.readFileSync(filePath);
  const bytes = buffer.byteLength;
  if (bytes > entry.maxBytes) {
    fail(id, entry.path, `文件大小 ${bytes} 超过上限 ${entry.maxBytes}`);
  }
  const json = parseGlb(buffer, id, entry.path);
  if (!json) return;

  // 外链检查：buffers[].uri / images[].uri 都不允许（GLB 内嵌 BIN 无 uri 属合法）
  for (const [i, b] of (json.buffers ?? []).entries()) {
    if (b.uri !== undefined) fail(id, entry.path, `buffers[${i}].uri 外链：${b.uri}`);
  }
  for (const [i, img] of (json.images ?? []).entries()) {
    if (img.uri !== undefined) fail(id, entry.path, `images[${i}].uri 外链：${img.uri}`);
  }
  // extensionsRequired 白名单：当前三件模型不要求任何扩展
  const required = json.extensionsRequired ?? [];
  if (required.length > 0) {
    fail(id, entry.path, `extensionsRequired 非空：${required.join(', ')}`);
  }

  const meshes = json.meshes ?? [];
  const primitives = meshes.reduce((n, m) => n + (m.primitives?.length ?? 0), 0);
  const stats = {
    id,
    path: entry.path,
    bytes,
    meshes: meshes.length,
    primitives,
    images: (json.images ?? []).length,
    animations: (json.animations ?? []).length,
    skins: (json.skins ?? []).length,
  };
  console.log(
    `✓ ${id}: ${stats.bytes} bytes, mesh=${stats.meshes}, primitive=${stats.primitives}, ` +
    `image=${stats.images}, animation=${stats.animations}, skin=${stats.skins}`,
  );
}

for (const [id, entry] of Object.entries(MANIFEST)) validateOne(id, entry);

if (failures.length > 0) {
  for (const f of failures) {
    console.error(`✗ ${f.id} (${f.path}): ${f.reason}`);
  }
  console.error(`\n武器资产验证失败：${failures.length} 项`);
  process.exitCode = 1;
} else {
  console.log('\n武器资产验证通过：3 件受控 GLB');
}
