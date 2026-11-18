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
 *
 * ⚠️ **`DARK` 自塔顶模型替换后无消费点**：旧实现靠 `back` 部件的 `color: DARK`
 * 区分后板，而新 8 部件里**没有「后板」这个语义**（装甲部件全部走贴图）。
 * 保留常量仅作 mc-lite 出处记录（与「床材质的 offset/rotation 是死字段」同类）。
 * **不得为了“用上 DARK”而给某个新部件硬塞 color** —— 那会让它在有纹理时也不走贴图。
 */
export const TURRET_TOWER_COLOR = Object.freeze({
  MAIN: 0xcccccc,   // 浅灰色主体（无纹理时的退回色）
  DARK: 0xbbbbbb,   // 中灰色后板（**无消费点**，见上方注释）
});

/**
 * 炮管系统颜色。
 *
 * 塔顶模型替换后只有两类纯色部件：主炮管与两组副武器。
 * 用户 2026-11-18 裁定：浅灰不好看，改**深灰 + 金属光泽（随光照反光）**。
 * 故基色取冷调深灰（带一点蓝，像炮钢），高光由 `turret-metal.js` 的 TSL 材质
 * 按太阳方向实时算 —— 基色暗、高光亮的反差正是金属感来源。
 * ⚠️ **基色不是最终观感**：漫反射地板 + Blinn-Phong 高光 + 菲涅尔边缘会把它提亮，
 * 迎光面高光处接近 0xb0。判「颜色对不对」必须看像素，不能只看这个字面量。
 * （旧 ROOT/SIGHT 两个色值随旧部件一同删除 —— 新模型没有根部/瞄准器这两个部件。）
 */
export const TURRET_GUN_COLOR = Object.freeze({
  BARREL: 0x434952,   // 深灰炮钢（冷调带蓝；高光/环境反射把它提到 ~0xb0）
  POD: 0x353b43,      // 更深一档的副武器（左右两组共用）
});

/**
 * 塔顶模型的定标与 pivot（**溯源用**，运行期不消费 —— 两者已烘进产物顶点）。
 *
 * ⚠️ `scale` 的判据是**炮口对齐 `TURRET.muzzleOffsetZ`**：模型炮口 z=113.3627
 * （实测精确值，用四舍五入的 113.36 会让炮口落在 3.5000834）。
 * 这样 `controller.muzzle()` 与弹道**零改动**。
 * ⚠️ `pivotY` 取**炮管轴心**，不是模型原点也不是塔身底面 —— 炮管绕自身轴俯仰
 * 才符合「炮管与炮头刚性一体」的观感。
 */
export const TURRET_TOP_SCALE = 3.5 / 113.3627;
export const TURRET_TOP_PIVOT_Y = 14.667;

/**
 * 部件顺序（9 个 = 旧 8 个语义映射 + skirt 过渡段）。
 *
 * 旧→新映射按**语义职责**而非几何相似：
 * front→mantlet（中央炮座）/ left→cheek（左右颊舱合并为一个）/ right→nose（车体鼻段）
 * / top→ring（转台环）/ back→deckMid（平台中段）/ barrel→barrel / root→podR / sight→podL。
 *
 * ⚠️ 旧 `left`/`right` 是两块对称侧板，新 `cheek` 是**一个**包含左右两侧的部件
 * ⇒ 「左右对称」那类旧断言失去意义，必须删除而不是改名保留。
 */
export const TURRET_PARTS = Object.freeze([
  'mantlet', 'cheek', 'nose', 'ring', 'deckMid', 'barrel', 'podR', 'podL', 'skirt',
]);

/**
 * 8 个部件的渲染定义。
 *
 * ⚠️⚠️ **几何全在烘焙产物里**（`assets/turret/turret-top.json`），本表**不再有**
 * `geo`/`size`/`pos`/`rotX` —— 部件局部变换是**恒等**，8 个部件乘同一个 pivot 矩阵
 * `T(pivot) × R_y(yaw) × R_x(-pitch)`。这是用户裁定的**刚性一体**：炮管与炮头一起转，
 * 不得给任何部件加独立旋转轴或俯仰轴（实测分层会让炮管在 ±45° 时飞出塔身）。
 *
 * ⚠️⚠️ **`textured` 是贴图/纯色分支的唯一依据**，不是 `zone`：
 * 新几何是**逐面分区**（同一部件内不同面属不同区），部件级 `zone` 恒为 null。
 * 旧判据 `!!def.zone` 在新表下**恒假** ⇒ 不改会让装甲全部退化成纯色，
 * 而顶点数/三角数/指纹全对（静默失效）。
 *
 * ⚠️ **UV 权威在烘焙侧**：产物 uv 已按面压进 1/3 区，渲染层**不得再调 applyZoneUV**
 * （再压一次 = z/3 + (z/3+u/3)/3 ⇒ 全部采到 front 区左侧）。
 */
export const TURRET_PART_DEFS = Object.freeze({
  mantlet: Object.freeze({ zone: null, textured: true }),
  cheek: Object.freeze({ zone: null, textured: true }),
  nose: Object.freeze({ zone: null, textured: true }),
  ring: Object.freeze({ zone: null, textured: true }),
  deckMid: Object.freeze({ zone: null, textured: true }),
  barrel: Object.freeze({ zone: null, textured: false, color: TURRET_GUN_COLOR.BARREL }),
  podR: Object.freeze({ zone: null, textured: false, color: TURRET_GUN_COLOR.POD }),
  podL: Object.freeze({ zone: null, textured: false, color: TURRET_GUN_COLOR.POD }),
  // ⚠️ **skirt（车体上层裙板）不可省**：塔身最低点 y=0.341 而 obsidian 柱顶 y=−0.3，
  // 中间 0.64 格若空缺，斜下仰视会看穿到天空（用户实玩缺陷 2）。skirt 的 y 范围
  // [−0.453, 0.416] 正好补上这段过渡。它同样乘 pivot 矩阵（刚性一体）。
  skirt: Object.freeze({ zone: null, textured: true }),
});
