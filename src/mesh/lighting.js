// src/mesh/lighting.js — skylight（垂直 + 水平扩散）+ blocklight flood fill（§4.6/DR-14）
// skylight 模型（Minecraft 同款）：① 垂直落下不衰减（15 直到遇 opaque）；
// ② 水平扩散 BFS，每格 -1，opaque 阻挡。光绕过悬挑边缘渗入阴影（渐变暗而非全黑）。
// 纯垂直近似（v1）在实玩中不可接受：任何高处实心方块把正下方整列截断为 0 → 全黑面。
// 区域重算（center + 4 正交邻居）走 Worker 异步收敛（scheduler light 任务），
// 编辑快路径仍用垂直单列（recomputeSkylightAt，O(128)，守 2ms 编辑预算）。
// blocklight：删除光源不做增量降光，全 column 区域重算兜底（§4.6 第一阶段口径）。
// Worker 同构：本文件不得 import three。
import { WORLD_MIN_Y, WORLD_MAX_Y, WORLD_HEIGHT, blockIndex } from '../voxel/constants.js';

/**
 * skylight：从顶向下逐列传播，初始 15，遇 opaque 停止（该格及下方为 0）。
 * 只写 column.light 高 4 位（保留低 4 位 blocklight）。
 * 注意：WORLD_MAX_Y 是排他上界，循环从 WORLD_MAX_Y - 1 起（y ∈ [MIN_Y, MAX_Y)）。
 */
export function computeSkylightColumn(column, registry) {
  const opaque = registry.opaqueTable;
  for (let lx = 0; lx < 16; lx++) {
    for (let lz = 0; lz < 16; lz++) {
      let sky = 15;
      for (let y = WORLD_MAX_Y - 1; y >= WORLD_MIN_Y; y--) {
        const idx = blockIndex(lx, y, lz);
        if (opaque[column.blocks[idx]] === 1) sky = 0;
        column.light[idx] = (column.light[idx] & 0x0F) | (sky << 4);
      }
    }
  }
}

/**
 * skylight 单列增量重算：只重算 (lx, lz) 这一根垂直列（O(128)）。
 * 编辑快路径用（守 2ms 预算）：垂直模型即时反馈，水平扩散由 scheduler 的
 * 异步 light 任务收敛（computeSkylightRegion）。
 *
 * 只升不降：垂直模型是真实（扩散后）光照的下界——列空则两者均 15，
 * 列被遮挡则垂直=0 而扩散∈[0,14]。因此：
 * - 挖块（移除遮挡）：垂直值 15 > 现值 → 立即提亮（黑面 bug 修复保留）；
 * - 放块（新增遮挡）：垂直值 0 < 现值 → 不写入，保持原亮度。
 *   同步压暗只能到 0（纯垂直模型），当帧渲染即黑闪（实玩 bug）；
 *   真实暗化（如 15→14）交给异步区域扩散收敛，短暂偏亮 1 档不可见。
 */
export function recomputeSkylightAt(column, lx, lz, registry) {
  const opaque = registry.opaqueTable;
  let sky = 15;
  for (let y = WORLD_MAX_Y - 1; y >= WORLD_MIN_Y; y--) {
    const idx = blockIndex(lx, y, lz);
    if (opaque[column.blocks[idx]] === 1) sky = 0;
    if (sky > (column.light[idx] >> 4)) {
      column.light[idx] = (column.light[idx] & 0x0F) | (sky << 4);
    }
  }
}

/**
 * skylight 区域重算（Minecraft 模型）：
 * ① 垂直 pass：region 每列从顶向下传 15，遇 opaque 停（该格及其下 0）。
 * ② 水平 BFS：所有 skylight>1 的格子向 6 邻居扩散 level-1，opaque 阻挡。
 * region = 中心 column + 4 正交邻居（与 blocklight region 一致）；邻居缺失 → 截断。
 * 只写高 4 位（保留 blocklight 低 4 位）。
 *
 * 边界截断自洽性：skylight=15 的格子水平最远影响 14 格（15-d≥1），2 个 column 以外
 * 的亮格到中心 column 边缘已 ≥32 格，贡献为 0——5-column region 对中心列是充分的。
 */
export function computeSkylightRegion(world, cx, cz, registry) {
  const offsets = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]];
  const cols = [];
  for (const [dx, dz] of offsets) {
    const col = world.getColumn(cx + dx, cz + dz);
    if (col) cols.push(col);
  }
  if (cols.length === 0) return;
  const opaque = registry.opaqueTable;
  // ① 垂直 pass
  for (const col of cols) computeSkylightColumn(col, registry);
  // ② 水平 BFS
  const queue = [];
  for (const col of cols) {
    const light = col.light;
    for (let i = 0; i < light.length; i++) {
      if ((light[i] >> 4) > 1) queue.push(col, i);
    }
  }
  const trySpread = (ncol, nidx, next) => {
    if (opaque[ncol.blocks[nidx]] === 1) return;
    if ((ncol.light[nidx] >> 4) >= next) return;
    ncol.light[nidx] = (ncol.light[nidx] & 0x0F) | (next << 4);
    queue.push(ncol, nidx);
  };
  let head = 0;
  while (head < queue.length) {
    const col = queue[head++];
    const i = queue[head++];
    const level = col.light[i] >> 4;
    if (level <= 1) continue;
    const next = level - 1;
    const lx = i & 15, lz = (i >> 4) & 15, yi = i >> 8; // yi = y - WORLD_MIN_Y
    if (yi < WORLD_HEIGHT - 1) trySpread(col, i + 256, next);
    if (yi > 0) trySpread(col, i - 256, next);
    if (lx > 0) trySpread(col, i - 1, next);
    else { const n = world.getColumn(col.cx - 1, col.cz); if (n) trySpread(n, i + 15, next); }
    if (lx < 15) trySpread(col, i + 1, next);
    else { const n = world.getColumn(col.cx + 1, col.cz); if (n) trySpread(n, i - 15, next); }
    if (lz > 0) trySpread(col, i - 16, next);
    else { const n = world.getColumn(col.cx, col.cz - 1); if (n) trySpread(n, i + 240, next); }
    if (lz < 15) trySpread(col, i + 16, next);
    else { const n = world.getColumn(col.cx, col.cz + 1); if (n) trySpread(n, i - 240, next); }
  }
}

/**
 * blocklight：region 内所有 emissive 源 flood fill（强度 -1/格，opaque 阻挡）。
 * region = 中心 column + 4 正交邻居（光泄漏过界，§4.6）；邻居缺失则截断。
 * 先清零 region 内低 4 位，再 BFS。
 */
export function computeBlocklightRegion(world, cx, cz, registry) {
  const offsets = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]];
  const cols = [];
  for (const [dx, dz] of offsets) {
    const col = world.getColumn(cx + dx, cz + dz);
    if (col) cols.push(col);
  }
  if (cols.length === 0) return;
  // 清零低 4 位
  for (const col of cols) {
    for (let i = 0; i < col.light.length; i++) col.light[i] &= 0xF0;
  }
  const emissive = registry.emissiveTable;
  const opaque = registry.opaqueTable;
  const setLight = (x, y, z, level) => {
    const cx2 = Math.floor(x / 16), cz2 = Math.floor(z / 16);
    const col = world.getColumn(cx2, cz2);
    if (!col) return false;
    const idx = blockIndex(x - cx2 * 16, y, z - cz2 * 16);
    if ((col.light[idx] & 0x0F) >= level) return false;
    col.light[idx] = (col.light[idx] & 0xF0) | level;
    return true;
  };
  /** BFS 队列元素：[worldX, y, worldZ, level] */
  const queue = [];
  for (const col of cols) {
    for (let i = 0; i < col.blocks.length; i++) {
      const e = emissive[col.blocks[i]];
      if (e > 0) {
        const lx = i & 15, lz = (i >> 4) & 15, y = WORLD_MIN_Y + (i >> 8);
        const wx = col.cx * 16 + lx, wz = col.cz * 16 + lz;
        setLight(wx, y, wz, e); // 光源自身格子写入强度
        queue.push([wx, y, wz, e]);
      }
    }
  }
  let head = 0;
  while (head < queue.length) {
    const [x, y, z, level] = queue[head++];
    if (level <= 1) continue;
    const next = level - 1;
    const neighbors = [
      [x + 1, y, z], [x - 1, y, z], [x, y + 1, z], [x, y - 1, z], [x, y, z + 1], [x, y, z - 1],
    ];
    for (const [nx, ny, nz] of neighbors) {
      if (ny < WORLD_MIN_Y || ny >= WORLD_MAX_Y) continue; // MAX_Y 排他上界
      const ncx = Math.floor(nx / 16), ncz = Math.floor(nz / 16);
      const ncol = world.getColumn(ncx, ncz);
      if (!ncol) continue;
      const nidx = blockIndex(nx - ncx * 16, ny, nz - ncz * 16);
      if (opaque[ncol.blocks[nidx]] === 1) continue; // opaque 阻挡
      if (setLight(nx, ny, nz, next)) queue.push([nx, ny, nz, next]);
    }
  }
}

/**
 * 全量重算（GEN 完成 / 光源增删时调用）。
 * skylight 用区域模型（垂直 + 水平扩散），blocklight 用区域 flood fill。
 * @returns {string[]} 受影响的 columnKey 列表（供调度器置脏重 mesh）
 */
export function recomputeLight(world, cx, cz, registry) {
  const col = world.getColumn(cx, cz);
  if (!col) return [];
  computeSkylightRegion(world, cx, cz, registry);
  computeBlocklightRegion(world, cx, cz, registry);
  const keys = new Set([`${cx},${cz}`]);
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    if (world.getColumn(cx + dx, cz + dz)) keys.add(`${cx + dx},${cz + dz}`);
  }
  return [...keys];
}
