// src/player/weapons/mag7-pattern.js — MAG7 确定性 3×3 扫描（M4 规格 §4.2）
// 无 three 的纯函数：从相机原点沿视线前向取 d=1..10、步长 0.5；每个距离在相机
// right/up 基底上取 i,j∈{-1,0,1} 的 3×3 截面采样；坐标向下取整；先按世界坐标去重，
// 再以 floor((d-1)/2) 作为距离组排序键。候选先经过 weapon-target-policy，之后才计入
// 40 上限（有意修正 mc-lite「基岩可占 40 名额、延迟删除时才过滤」的怪癖），
// 最后按距离组升序（稳定排序）展平，供一次 WorldEditor.setBlocks() 原子提交。
import { WEAPONS, WEAPON_IDS } from './weapon-catalog.js';
import { isMag7Candidate } from './weapon-target-policy.js';

/**
 * @param {{origin: number[], forward: number[], right: number[], up: number[],
 *          target?: ({hit: boolean, blockPos?: number[]}|null)}} aim plain arrays
 *        `target.blockPos` 只用作白闪波浪的次序基准（见文件尾的 sort 注释），命中判定不用它。
 * @param {{getBlockId: (x: number, y: number, z: number) => number}} blockQuery 只读体素查询
 * @param {ReturnType<import('../../voxel/block-registry.js').createRegistry>} registry
 * @returns {Array<{x: number, y: number, z: number, id: number, meta: number, group: number,
 *                  sourceId: number, centerDist: number}>}
 *          id 恒为 0（删除），`sourceId` 是删除前的方块 id；按到命中点的真实距离升序
 */
export function collectMag7Changes(aim, blockQuery, registry) {
  const scan = WEAPONS[WEAPON_IDS.MAG7].scan;
  const [ox, oy, oz] = aim.origin;
  const [fx, fy, fz] = aim.forward;
  const [rx, ry, rz] = aim.right;
  const [ux, uy, uz] = aim.up;
  // 波浪次序的基准点 = 准心命中的那一格（没有命中时退回相机原点）
  const centerPoint = aim.target?.hit ? aim.target.blockPos : null;

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
        // v1.64：`sourceId` 记下**删除前**的方块 id（命中特效按材质取色需要一个未变的 id ——
        // 提交 setBlocks 之后再查这一格恒为 air）。`id` 仍恒为 0（删除意图），两者不可混用。
        // v1.67：`centerDist` = 到命中点的真实几何距离，是白闪波浪的第二排序键。
        candidates.push({
          x, y, z, id: 0, meta: 0, group, sourceId: id,
          centerDist: centerPoint
            ? Math.hypot(x - centerPoint[0], y - centerPoint[1], z - centerPoint[2])
            : Math.hypot(x - ox, y - oy, z - oz),
        });
      }
    }
  }
  // 排序：按**到命中点的真实几何距离**升序（v1.67）。
  //
  // ⚠️ 为什么不用距离组 `group`（v1.66 及之前的口径，v1.67 实测推翻）：`group =
  // floor((d-1)/2)` 是沿**视线**的采样距离分组，同组内 3×3 截面的九格彼此距离差很大 ——
  // 实测相邻两项 1.732 → 1.414（反而变近了）。v1.67 的白闪波浪直接沿用这个次序时，
  // 观感是「先往外扩散一小圈又收回来」。
  // 破坏行为本身不受影响：它只依赖「哪些格被删」，不依赖次序。
  // `group` 字段保留（仍是距离组的定义，将来若要分批删除有用），只是不再当主排序键。
  candidates.sort((a, b) => a.centerDist - b.centerDist);
  return candidates;
}
