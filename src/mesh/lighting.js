// src/mesh/lighting.js — skylight + blocklight flood fill（§4.6/DR-14）
// 第一阶段口径（v1.9 产品决策）：**不做阳光遮挡投影**——skylight 恒 15，
// 悬挑/洞穴下不产生阴影；视觉明暗只来自 AO 墙角阴影 + 日夜全局调制（对齐 mc-lite
// 视觉基线）。实玩验证：Minecraft 式遮挡阴影在大悬空平台/洞穴下产生大片全黑 +
// 扩散截断渐变，与 mc-lite 基线冲突，用户明确不要（后续阶段再启用阴影）。
// 机制保留供后续阶段：skylight 遮挡模型 = ① 垂直落下不衰减 ② 水平 BFS 每格 -1；
// 区域重算（center + 4 正交邻居）走 Worker 异步收敛，写回中心 column 权威。
// 编辑快路径仍用垂直单列（recomputeSkylightAt，O(128)，守 2ms 编辑预算）。
// blocklight：删除光源不做增量降光，全 column 区域重算兜底（§4.6 第一阶段口径）。
// Worker 同构：本文件不得 import three。
import { WORLD_MIN_Y, WORLD_MAX_Y, WORLD_HEIGHT, blockIndex } from '../voxel/constants.js';

/**
 * 区域重算的 column 偏移集合 = **3×3**（中心 + 4 正交 + 4 对角）。
 *
 * 为什么不是「中心 + 4 正交」的 5 列（2026-10-21 修掉的实玩 bug「灯光有边界」）：
 * 光强度 15、每格 -1 → 最远照亮 **14 格**；column 边长 16。于是一个 column 的光能影响到的
 * 邻居只有：
 *   · 正交邻居：最近格距本列边缘 **1 格** → 必须参与；
 *   · **对角邻居：最近格距本列边缘 2 格 → 同样必须参与**（旧实现漏掉了这 4 列）；
 *   · 隔一列（offset ≥2）：最近格距 17 格 > 14 → 永远贡献 0，参与只是白算。
 * 实测（全量 BFS 作真值，200 组随机世界）：plus-5 的最大误差 **10 级 / 982 格错**，3×3 = 0。
 *
 * ⚠️ 这个常量是 blocklight **和** skylight 共用的口径 —— 后者第一阶段恒 15、水平 BFS 是
 * no-op 才没暴露同一个漏洞，后续启用阳光遮挡时会立刻犯同样的错。
 * ⚠️ 与写回协议配对（见 scheduler `_onLightResult`）：3×3 只对**中心列**精确，偏移 ±1 的
 * 邻列拿到的是截断结果，因此只能参与计算、不能写回。
 */
export const LIGHT_REGION_OFFSETS = Object.freeze([
  Object.freeze([-1, -1]), Object.freeze([0, -1]), Object.freeze([1, -1]),
  Object.freeze([-1, 0]), Object.freeze([0, 0]), Object.freeze([1, 0]),
  Object.freeze([-1, 1]), Object.freeze([0, 1]), Object.freeze([1, 1]),
]);

/**
 * skylight：第一阶段不启用阳光遮挡（v1.9），全列恒 15。
 * 只写 column.light 高 4 位（保留低 4 位 blocklight）。
 * 遮挡模型（垂直落下遇 opaque 停）代码保留在 computeSkylightColumnOccluded，
 * 后续阶段启用阴影时切回（设计文档 §4.6/DR-14）。
 */
export function computeSkylightColumn(column, _registry) {
  for (let i = 0; i < column.light.length; i++) {
    column.light[i] = (column.light[i] & 0x0F) | (15 << 4);
  }
}

/** 遮挡模型原实现（后续阶段启用阳光阴影时切回，v1.9 保留不删） */
export function computeSkylightColumnOccluded(column, registry) {
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
 * skylight 单列增量重算（编辑快路径，O(128)，守 2ms 预算）。
 * 第一阶段无阳光遮挡（v1.9）：该列 skylight 直接置 15。
 * 后续阶段启用遮挡模型时切回垂直重算 + 只升不降口径。
 */
export function recomputeSkylightAt(column, lx, lz, _registry) {
  for (let y = WORLD_MAX_Y - 1; y >= WORLD_MIN_Y; y--) {
    const idx = blockIndex(lx, y, lz);
    column.light[idx] = (column.light[idx] & 0x0F) | (15 << 4);
  }
}

/**
 * skylight 区域重算（Minecraft 模型）：
 * ① 垂直 pass：region 每列从顶向下传 15，遇 opaque 停（该格及其下 0）。
 * ② 水平 BFS：所有 skylight>1 的格子向 6 邻居扩散 level-1，opaque 阻挡。
 * region = `LIGHT_REGION_OFFSETS`（3×3，与 blocklight 同一口径，推导见该常量）；邻居缺失 → 截断。
 * 只写高 4 位（保留 blocklight 低 4 位）。
 * 第一阶段（v1.9）skylight 恒 15、无遮挡：垂直 pass 写满 15，BFS 无扩散空间，
 * 本函数等价 no-op——机制保留，后续阶段启用阳光阴影时生效。
 *
 * 区域充分性的论证与 blocklight 同源：光水平最远影响 14 格，对角邻居最近格距本列边缘
 * 2 格（必须在区域内），隔一列已 ≥17 格（贡献为 0）。
 */
export function computeSkylightRegion(world, cx, cz, registry) {
  const offsets = LIGHT_REGION_OFFSETS;
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
 * region = `LIGHT_REGION_OFFSETS`（3×3，见该常量注释里的推导）；邻居缺失则截断。
 * 先清零 region 内低 4 位，再 BFS。
 */
export function computeBlocklightRegion(world, cx, cz, registry) {
  const offsets = LIGHT_REGION_OFFSETS;
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
  for (const [dx, dz] of LIGHT_REGION_OFFSETS) {
    if (dx === 0 && dz === 0) continue;
    if (world.getColumn(cx + dx, cz + dz)) keys.add(`${cx + dx},${cz + dz}`);
  }
  return [...keys];
}
