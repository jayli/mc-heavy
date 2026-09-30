// src/entities/minecarts/minecart-config.js — 矿车冻结玩法数据（设计文档 §2/§3/§5）
// 同构层：**无 DOM、无 three**（`npm run check:arch` 静态门守）。
// 本文件是矿车玩法数值与几何尺寸的**唯一权威** —— system / service / renderer / 测试
// 都从这里派生，不得各自写字面量（红线 1）。数值逐项实测自 mc-lite
// `constants/GameConfig.js` + `actors/minecart/Minecart.js` + `MinecartInstancedRenderer.js`
// （读源，非推断）。

/**
 * ⚠️ **单位换算已核对：不做 ×60**。mc-lite `MinecartMovementSystem.update` 的位移是
 * `direction * MINECART_SPEED * deltaTime` → 已是**格/秒**。与 `ZOMBIE.speed` 那种
 * 「格/帧须 ×60」的情况相反（`Zombie.js` 的 `predictNextPosition` 不乘 dt）。
 * 「照搬前逐项核对是否乘 dt」是 CLAUDE.md 的活跃约束（M8 已沉淀）。
 */
export const MINECART = Object.freeze({
  /** 移动速度 2.0 格/秒（mc-lite `GameConfig.MINECART_SPEED`） */
  speed: 2.0,
  /** 全局上限 50 辆（mc-lite `MAX_MINECARTS`）。判定来源 = entities store，见 service */
  maxMinecarts: 50,
  /** 连挂列车上限 10 辆（mc-lite `MAX_LINKED_MINECARTS`） */
  maxLinked: 10,
  /** 碰撞盒 1.0×0.9×1.0（mc-lite `MINECART_CONFIG.BOUNDING_BOX`） */
  width: 1.0,
  height: 0.9,
  /** 车顶高度 = 玩家乘坐时脚底 y（mc-lite `minecartTopY = position.y + 0.9`） */
  rideHeight: 0.9,
  /**
   * 玩家 AABB 半宽 0.3（= `player/physics.js` 的 `PLAYER_WIDTH / 2` = 0.6/2，该常量模块私有）。
   * 同构层（src/entities/**）不得 import `player/`，故在此登记为矿车侧消费的唯一权威
   * （红线 1：消费方不得写字面量）。`player/physics.js` 改 PLAYER_WIDTH 时须同步本值。
   */
  playerHalfWidth: 0.3,
  /** 下车后禁止自动重绑的冷却秒数（mc-lite `minecartRemountCooldown = 0.25`） */
  remountCooldown: 0.25,
  /** 水平偏离超过此值自动下车（mc-lite `deviationX > 0.6`） */
  dismountDeviation: 0.6,
  /** 绑定判据：|playerY − 车顶| < 此值（mc-lite `isOnMinecart` 的 0.3） */
  rideBindTolerance: 0.3,
  /**
   * 交互射程 15 格（mc-lite `PlayerInteraction.interact` 的 `hits[0].distance < 15`）。
   * ⚠️ 与体素 DDA 的 `REACH = 40` **不是一个口径** —— 实体交互更近，超出 15 格点不到车。
   * 拾取与激活共用本常量，不得各写字面量（红线 1）。
   */
  interactRange: 15,
  /** 车斗尺寸 0.9×0.8×0.9（mc-lite `MINECART_SIZES.body`） */
  bodyWidth: 0.9,
  bodyHeight: 0.8,
  bodyDepth: 0.9,
  /** 车斗底部内缩比例（mc-lite `shrinkRatio = 0.8` → 倒梯形） */
  bodyShrinkRatio: 0.8,
  /** 车轮半径 / 高度（mc-lite `wheelRadius` / `wheelHeight`） */
  wheelRadius: 0.2,
  wheelHeight: 0.1,
  /** 轴距（前后轮间距）/ 轮距（左右轮间距），均 0.6 */
  wheelbase: 0.6,
  trackWidth: 0.6,
  /** 车斗 / 车轮颜色（mc-lite `MINECART_COLORS`） */
  bodyColor: 0xb8bec6,
  wheelColor: 0x2f3238,
  /** 车斗材质金属度 / 粗糙度（mc-lite `metalness: 0.22, roughness: 0.72`） */
  bodyMetalness: 0.22,
  bodyRoughness: 0.72,
  /** 车斗纹理边长（mc-lite `createMinecartBodyTexture` 的 size = 128） */
  textureSize: 128,
  /**
   * 爆炸摧毁的度量偏移与半径（mc-lite `PlayerInteraction.js` 的爆炸段）：
   * 爆炸中心 = 方块格 + 0.5（块中心），车中心 = 车 position + (0.5, 0.3, 0.5)，半径 4。
   */
  explosionOffsetY: 0.3,
  explosionRadius: 4,
});

/**
 * 铁轨方块类型（mc-lite `GameConfig.TRACK_BLOCK_TYPES`）。
 * **单一权威**：移动系统的 `hasTrackAt` 与放置预检都读它，不得各写字面量（红线 1）。
 */
export const TRACK_BLOCK_TYPES = Object.freeze(['sand_train_track', 'sand_train_track_corner']);

/** 背包物品名（mc-lite 同名；已在 `buildItemNames()` 集合内，走平面图标路径） */
export const MINECART_ITEM = 'mine_cart';

/** EntityManager 的实体 type 名（snapshot / raycast predicate / 渲染过滤都用它） */
export const MINECART_TYPE = 'minecart';

/**
 * 移动状态枚举。⚠️ 用小写串（mc-lite 用 `'MOVING_FORWARD'` 大写，本仓库对齐 M6 的
 * `'idle'`/`'chasing'` 风格）—— 值会进 snapshot，改口径须同时考虑旧存档。
 */
export const MOVEMENT = Object.freeze({
  IDLE: 'idle',
  FORWARD: 'forward',
  BACKWARD: 'backward',
});

/**
 * 矿车 AABB（相对 state.position 的局部偏移）。
 * ⚠️ **position 是占据格坐标（块底角原点），不是块中心** —— 故盒是 [0, width]
 * 而不是 [±width/2]（后者是「脚底中心」语义的盒，如 PROBE_AABB —— 两种 position
 * 语义不得混用）。mc-lite `Minecart.js:70-80` 的 `getBoundingBox()` 在同样的格角
 * position 上给出 `min = pos + (1-width)/2 = pos`、`max = pos + 1`（width=1）→
 * 盒 `[pos, pos+1]`，与本常量逐位等价（渲染层另有 +0.5 的块中心换算，不影响命中盒）。
 */
export const MINECART_AABB = Object.freeze({
  min: Object.freeze([0, 0, 0]),
  max: Object.freeze([MINECART.width, MINECART.height, MINECART.width]),
});

/**
 * 朝向 → 水平方向向量（mc-lite `DIRECTION_VECTORS`：0=EAST, 1=SOUTH, 2=WEST, 3=NORTH）。
 * 与 `src/player/orientation.js` 的 `BlockOrientation` 同枚举（铁轨 meta 朝向直接可用）。
 */
const DIRECTION_VECTORS = Object.freeze([
  Object.freeze({ x: 1, z: 0 }),    // EAST
  Object.freeze({ x: 0, z: 1 }),    // SOUTH
  Object.freeze({ x: -1, z: 0 }),   // WEST
  Object.freeze({ x: 0, z: -1 }),   // NORTH
]);

/**
 * 取运动方向（后退时反向）。mc-lite `getDirectionVector` 同语义：只判 BACKWARD，
 * 其余（含 IDLE）返回基础方向 —— IDLE 的车根本走不到位移分支。
 * 越界朝向回落 EAST（mc-lite `|| DIRECTION_VECTORS[0]`）。
 * @param {number} orientation 0-3
 * @param {string} movementState MOVEMENT.*
 * @returns {{x: number, z: number}}
 */
export function directionOf(orientation, movementState) {
  const base = DIRECTION_VECTORS[orientation] ?? DIRECTION_VECTORS[0];
  if (movementState === MOVEMENT.BACKWARD) return { x: -base.x, z: -base.z };
  return { x: base.x, z: base.z };
}

/**
 * 左向（mc-lite `getLeftDirection` 的公式：`(x,z) → (-z, x)`）。
 * ⚠️ mc-lite 的注释写「顺时针旋转90度」但公式给出的是另一侧 —— **照公式搬，不照注释搬**
 * （「对齐上游须实测其运行时行为，不能读定义推断」，CLAUDE.md 活跃约束）。
 * @param {number} orientation 0-3 @returns {{x: number, z: number}}
 */
export function leftOf(orientation) {
  const f = DIRECTION_VECTORS[orientation] ?? DIRECTION_VECTORS[0];
  return { x: -f.z, z: f.x };
}

/** 右向（mc-lite `getRightDirection` 的公式：`(x,z) → (z, -x)`）。 */
export function rightOf(orientation) {
  const f = DIRECTION_VECTORS[orientation] ?? DIRECTION_VECTORS[0];
  return { x: f.z, z: -f.x };
}

/**
 * 朝向 → Y 轴旋转弧度（mc-lite `OrientationUtils.getRotationAngle`：`orientation * π/2`）。
 * **渲染层与逻辑层共用本函数** —— 各写一份会漂移出「车朝东走但模型朝南」（红线 1）。
 * @param {number} orientation 0-3 @returns {number}
 */
export function rotationAngleOf(orientation) {
  return (orientation || 0) * (Math.PI / 2);
}

/** registry → 铁轨 id 集合的缓存（移动热路径每帧多次查询，不得每次 map 一遍） */
const _trackIdCache = new WeakMap();

/**
 * 方块 id 是否铁轨。
 * @param {number} id
 * @param {ReturnType<import('../../voxel/block-registry.js').createRegistry>} registry
 * @returns {boolean}
 */
export function isTrackBlock(id, registry) {
  if (!registry) return false;
  let set = _trackIdCache.get(registry);
  if (!set) {
    set = new Set();
    for (const name of TRACK_BLOCK_TYPES) {
      const trackId = registry.idOf(name);
      if (trackId !== undefined) set.add(trackId);
    }
    _trackIdCache.set(registry, set);
  }
  return set.has(id);
}

/**
 * 指定格是否铁轨。⚠️ **「铁轨在车下方一格」（`trackY = carY - 1`）是调用方的责任**，
 * 本函数只判「这一格是不是铁轨」—— mc-lite `hasTrackAt` 同口径。
 * `registry` 缺省时从 `world.registry` 取（`WorldData` 构造期持有）。
 */
export function hasTrackAt(world, registry, x, y, z) {
  if (!world) return false;
  return isTrackBlock(world.getBlockId(x, y, z), registry ?? world.registry);
}

/**
 * 指定格是否实心（`registry.solidTable`，对应 mc-lite `getBlockProperties().isSolid`）。
 * 与 `WorldData.isSolid`（`world-data.js:90`）同判据，唯 registry 可覆盖（同构层调用可显式传
 * registry）—— 未来实心语义变更须两处同改。
 */
export function hasSolidAt(world, registry, x, y, z) {
  if (!world) return false;
  const id = world.getBlockId(x, y, z);
  if (id === 0) return false;
  const reg = registry ?? world.registry;
  return reg ? reg.solidTable[id] === 1 : false;
}
