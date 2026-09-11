// src/entities/turrets/turret-config.js — M8：炮塔冻结玩法数据（规格 §4.2）
// 同构层：**无 DOM、无 three**（`npm run check:arch` 静态门守）。
// 本文件是炮塔玩法数值的**唯一权威** —— system / service / controller / renderer / 测试
// 都从这里派生，不得各自写字面量（红线 1）。数值逐项实测自 mc-lite `Turret.js:84-152`
// 的 `TURRET_CONFIG`（读源，非推断）。

/**
 * ⚠️ **单位换算须核对**：mc-lite 的 `ROTATION_SPEED`/`PITCH_SPEED`/`PROJECTILE_SPEED` 都乘
 * `deltaTime`（`Turret.js:637`、`Projectile.js:89`），即**已是格/秒与弧度/秒** ——
 * 与 `ZOMBIE.speed` 那种「格/帧须 ×60」的情况相反（`Zombie.js` 的 `predictNextPosition`
 * 不乘 dt）。故**照搬不做 ×60 换算**；验收须 A/B 对照实测（这类缺陷肉眼难辨）。
 */
export const TURRET = Object.freeze({
  /** 全局最多 20 个（mc-lite `TurretManager.js:43`）。上限判定走 edits store 扫库 */
  maxTurrets: 20,
  /** 检测范围 50 格（`DETECTION_RANGE`） */
  detectionRange: 50,
  /** 旋转速度 π/2 弧度/秒（`ROTATION_SPEED`） */
  rotationSpeed: Math.PI / 2,
  /** 俯仰速度 π/3 弧度/秒（`PITCH_SPEED`） */
  pitchSpeed: Math.PI / 3,
  /** 开火冷却 500ms（`FIRE_COOLDOWN`） */
  fireCooldownMs: 500,
  /** 射击角度阈值 0.26 弧度 ≈ 15°（`FIRE_ANGLE_THRESHOLD`），yaw 与 pitch 各判一次 */
  fireAngleThreshold: 0.26,
  /** 最大俯仰角 ±45°（`MAX_PITCH_ANGLE`） */
  maxPitchAngle: Math.PI / 4,
  /** 瞄准点 Y 偏移 1.2（丧尸胸部，`ENEMY_BODY_OFFSET_Y`） */
  enemyBodyOffsetY: 1.2,
  /** LOS 采样步长 0.5 格（`LOS_SAMPLE_STEP`） */
  losSampleStep: 0.5,
  /** 目标重选间隔 120ms（`TARGET_REACQUIRE_INTERVAL`） */
  targetReacquireMs: 120,
  /** 弹丸速度 40 格/秒（`PROJECTILE_SPEED`） */
  projectileSpeed: 40,
  /** 弹丸最大飞行距离 50 格（`MAX_KILL_DISTANCE`） */
  projectileMaxDistance: 50,
  /**
   * 弹丸伤害 34（**换算值**，mc-lite 无此数字）：mc-lite 是 `hitCount` 计数 + `maxHits=3`
   * （`Zombie.js:163`），mc-heavy 是 `ZOMBIE.health=100` + 数值伤害。34 × 3 = 102 ≥ 100 →
   * 保持「三发杀死」语义。测试须在**临界值附近**断言（两发不死、三发死）——
   * 远离阈值的输入测不出换算错误。
   */
  projectileDamage: 34,
  /** 炮口 Z 偏移 3.5（`MUZZLE_OFFSET_Z`，炮管最前端） */
  muzzleOffsetZ: 3.5,
  /** 旋转中心高度偏移 3.3（`PIVOT_HEIGHT_OFFSET`，相对底座 position.y） */
  pivotHeightOffset: 3.3,
  /** AI 周期 125ms ≈ 8Hz（对齐 `TARGET_REACQUIRE_INTERVAL` 的 120ms）。主线程执行，不走 RPC */
  aiPeriodMs: 125,
  /**
   * 弹丸实例池容量 **64**（派生值，不是魔数）：
   * 20 炮塔 × 弹丸寿命（`projectileMaxDistance / projectileSpeed` = 50/40 = 1.25s）
   * ÷ 开火冷却（500ms）≈ **50** → 取 64（2 的幂便于实例池索引）。
   *
   * ⚠️ 验收须**实测峰值并重标定**（照 CLAUDE.md 的 cutout 容量教训：差一点就会触发扩容
   * 撞破预算）。⚠️ **渲染层的缺省值必须从这里派生**（红线 1）—— 单测不传 maxActive 时
   * 钉的是本值，注入「渲染层写死别的数」会被抓到。
   */
  projectilePoolSize: 64,
});

/** 受控创造模式选择入口的物品名（照 nest-config.js 的 NEST_ALIAS_BLOCK 同手法） */
export const TURRET_ALIAS_BLOCK = 'turret_alias_block';

/**
 * 放置时的默认朝向：玩家相对炮塔中心的方向，取最近的四方向之一（mc-lite
 * `TurretPlacementHandler.place()` 的 `DIRECTIONS` 语义照搬）。
 * ⚠️ 这**不是**「方块放置朝向不看玩家 yaw」那条约束的反例 —— 那条说的是单格方块的
 * meta 朝向（M3.2 三分支），炮塔默认朝向是装置运行态、存在 blockEntity 里。
 *
 * 导出在此（单一权威）—— 两条放置路径（背包分流 / `selectPlaceable` 测试 API）共用，
 * 各写一份会漂移出「测试放的炮塔朝向与玩家放的炮塔朝向不同」。
 *
 * @param {{x:number,z:number}} playerPos @param {[number,number,number]} blockPos
 * @returns {number} 弧度（0=+Z / π/2=+X / π=-Z / -π/2=-X）
 */
export function defaultTurretRotation(playerPos, blockPos) {
  const dx = playerPos.x - (blockPos[0] + 0.5);
  const dz = playerPos.z - (blockPos[2] + 0.5);
  if (Math.abs(dx) > Math.abs(dz)) return dx > 0 ? Math.PI / 2 : -Math.PI / 2;
  return dz > 0 ? 0 : Math.PI;
}

// --------------------------------------------------------------------------
// M8 Task 5：炮塔部件定义（渲染层 / 烘焙脚本 / check:data 三方共用的唯一权威）
// --------------------------------------------------------------------------

/**
 * 装甲纹理的**区序**（UV 分区的唯一权威）。
 *
 * ⚠️ **必须横向三区并排**（CLAUDE.md 活跃约束：上下分区会把图案压成 N×(N/3) → 比例失真）。
 * ⚠️ **不在渲染层写字面量副本** —— 上一版审查发现 `turret-renderer.js` 里写
 * `const ZONES = ['front','side','top']` 是第二份副本（注释写「同源」但没有任何机制保证），
 * 改了烘焙侧区序而忘改渲染层 → UV 整体错位（渲染出错图案，肉眼只觉得「贴图怪怪的」）。
 * 提到本文件后，渲染层 / 烘焙脚本 / `check:data` 三方都从同一处派生，门禁可断言
 * `TURRET_PART_DEFS[].zone ⊆ ARMOR_ZONES`。
 */
export const ARMOR_ZONES = Object.freeze(['front', 'side', 'top']);

/**
 * 纯色部件的颜色（mc-lite `TURRET_TOWER_COLOR`，`Turret.js:98-101`）。
 * ⚠️ 收进 config 而非在渲染层写死字面量 —— 上一版审查发现渲染层注释写「退回纯色
 * `TURRET_TOWER_COLOR.MAIN/DARK`」但代码写死 `0xcccccc`/`0xbbbbbb`（红线 1：两个副本）。
 */
export const TURRET_TOWER_COLOR = Object.freeze({
  MAIN: 0xcccccc,   // 浅灰色主体
  DARK: 0xbbbbbb,   // 中灰色后板
});

/** 炮管系统颜色（mc-lite `GUN_COLOR`，`Turret.js:139-143`） */
export const TURRET_GUN_COLOR = Object.freeze({
  BARREL: 0x222222,   // 黑色炮管
  ROOT: 0xeeeeee,     // 白色根部
  SIGHT: 0x3366cc,    // 蓝色瞄准器
});

/** 部件顺序（8 个 = 5 装甲板 + 炮管 + 根部 + 瞄准器；mc-lite `createTurretTopBlocks` 同序） */
export const TURRET_PARTS = Object.freeze([
  'front', 'left', 'right', 'top', 'back', 'barrel', 'root', 'sight',
]);

/**
 * 8 个部件的几何与变换定义。数值**逐项实测自 mc-lite** `Turret.js`：
 * - 尺寸 = `TURRET_TOWER_SIZE`（`:94-99`）/ `GUN_BARREL_SIZE`（`:127-130`）/
 *   `GUN_ROOT_SIZE`（`:131`）/ `GUN_SIGHT_SIZE`（`:132`）；
 * - 位置 = `TURRET_TOWER_POS`（`:105-111`）/ `GUN_POS`（`:133-138`）；
 * - 前装甲板的倾斜 `rotX: -π/8` = `createTurretTopBlocks()` 的 `rotX`（`:275`）；
 * - 区归属 = `ARMOR_TEXTURES`（`:114-119`）：front→pic1、left/right→pic2、top→pic3、
 *   **back→pic3**（TOP 与 BACK 都指向 pic3，故 `back` 的 zone 也是 `'top'`）。
 *
 * ⚠️ 这是**纯数据**（无 three 依赖）→ 放在本同构模块，渲染层只做「几何构造 + UV 改写 +
 * 矩阵合成」。`zone: null` = 纯色部件（不改写 UV）。
 */
export const TURRET_PART_DEFS = Object.freeze({
  front: Object.freeze({
    geo: 'box', size: Object.freeze([1.6, 1.2, 0.4]),
    pos: Object.freeze([0, -0.05, 0.75]), rotX: -Math.PI / 8, zone: 'front',
  }),
  left: Object.freeze({
    geo: 'box', size: Object.freeze([1, 1.0, 1.7]),
    pos: Object.freeze([-0.8, -0.1, -0.1]), zone: 'side',
  }),
  right: Object.freeze({
    geo: 'box', size: Object.freeze([1, 1.0, 1.7]),
    pos: Object.freeze([0.8, -0.1, -0.1]), zone: 'side',
  }),
  top: Object.freeze({
    geo: 'box', size: Object.freeze([1.6, 0.3, 1.5]),
    pos: Object.freeze([0, 0.6, -0.2]), zone: 'top',
  }),
  back: Object.freeze({
    geo: 'box', size: Object.freeze([1.6, 1.2, 0.3]),
    pos: Object.freeze([0, -0.2, -0.95]), zone: 'top',   // mc-lite BACK 也用 pic3
    color: TURRET_TOWER_COLOR.DARK,                      // 无纹理时的退回色（中灰）
  }),
  barrel: Object.freeze({
    geo: 'cylinder', diameter: 0.3, length: 3.0,
    pos: Object.freeze([0, 0, 2.0]), zone: null, color: TURRET_GUN_COLOR.BARREL,
  }),
  root: Object.freeze({
    geo: 'box', size: Object.freeze([0.6, 0.6, 0.4]),
    pos: Object.freeze([0, 0, 0.85]), zone: null, color: TURRET_GUN_COLOR.ROOT,
  }),
  sight: Object.freeze({
    geo: 'box', size: Object.freeze([0.3, 0.3, 0.4]),
    pos: Object.freeze([0, 0.5, 0.65]), zone: null, color: TURRET_GUN_COLOR.SIGHT,
  }),
});
