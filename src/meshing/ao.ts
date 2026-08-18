/**
 * 标准 voxel AO：两个侧边都被完整方块遮挡时完全遮蔽，否则从满亮度 3
 * 减去每一侧与角点的遮挡。
 */
export const computeCornerAo = (side1: boolean, side2: boolean, corner: boolean): number => {
  if (side1 && side2) return 0;
  return 3 - Number(side1) - Number(side2) - Number(corner);
};
