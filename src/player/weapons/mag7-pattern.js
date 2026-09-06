// src/player/weapons/mag7-pattern.js — MAG7 确定性 3×3 扫描（M4 规格 §4.2）
// 无 three 的纯函数：从相机原点沿视线前向取 d=1..10、步长 0.5；每个距离在相机
// right/up 基底上取 i,j∈{-1,0,1} 的 3×3 截面采样；坐标向下取整；先按世界坐标去重，
// 再以 floor((d-1)/2) 作为距离组排序键。候选先经过 weapon-target-policy，之后才计入
// 40 上限（有意修正 mc-lite「基岩可占 40 名额、延迟删除时才过滤」的怪癖），
// 最后按距离组升序（稳定排序）展平，供一次 WorldEditor.setBlocks() 原子提交。
import { WEAPONS, WEAPON_IDS } from './weapon-catalog.js';
import { isMag7Candidate } from './weapon-target-policy.js';

/**
 * @param {{origin: number[], forward: number[], right: number[], up: number[]}} aim plain arrays
 * @param {{getBlockId: (x: number, y: number, z: number) => number}} blockQuery 只读体素查询
 * @param {ReturnType<import('../../voxel/block-registry.js').createRegistry>} registry
 * @returns {Array<{x: number, y: number, z: number, id: number, meta: number, group: number}>}
 *          id 恒为 0（删除），按距离组升序
 */
export function collectMag7Changes(aim, blockQuery, registry) {
  const scan = WEAPONS[WEAPON_IDS.MAG7].scan;
  const [ox, oy, oz] = aim.origin;
  const [fx, fy, fz] = aim.forward;
  const [rx, ry, rz] = aim.right;
  const [ux, uy, uz] = aim.up;

  const seen = new Set();
  const candidates = [];
  for (let d = scan.min; d <= scan.max; d += scan.step) {
    const group = Math.floor((d - 1) / 2);
    for (let i = -scan.halfWidth; i <= scan.halfWidth; i++) {
      for (let j = -scan.halfWidth; j <= scan.halfWidth; j++) {
        const x = Math.floor(ox + fx * d + rx * i + ux * j);
        const y = Math.floor(oy + fy * d + ry * i + uy * j);
        const z = Math.floor(oz + fz * d + rz * i + uz * j);
        const key = `${x},${y},${z}`;
        if (seen.has(key)) continue; // 世界坐标去重（0.5 步长相邻采样可能落同格）
        seen.add(key);
        const id = blockQuery.getBlockId(x, y, z);
        if (!isMag7Candidate(id, registry)) continue; // 先过滤
        if (candidates.length >= scan.maxBlocks) continue; // 再计 40 上限
        candidates.push({ x, y, z, id: 0, meta: 0, group });
      }
    }
  }
  // Array.prototype.sort 是稳定排序：同组内保持采样顺序（由近及远的破坏次序）
  candidates.sort((a, b) => a.group - b.group);
  return candidates;
}
