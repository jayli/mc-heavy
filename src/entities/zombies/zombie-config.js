// src/entities/zombies/zombie-config.js — M6：丧尸冻结玩法数据（M6 规格 §1）
//
// 同构层：**无 DOM、无 three、不新增 Worker**（`npm run check:arch` 静态门守）。
// 本文件是丧尸玩法数值的**唯一权威** —— 系统、渲染器、武器目录与测试都从这里派生，
// 不得各自写字面量（红线 1：同一事实的多个副本会漂移）。数值逐项对齐 mc-lite
// （`Zombie.js` / `ZombieInstancedRenderer.js` 实测读源，非推断）。

/** 丧尸玩法数据（M6 规格 §1 表格） */
export const ZOMBIE = Object.freeze({
  /** 默认活动上限（mc-lite 默认值）。未来 30/50 档须重新验收容量与性能，不得静默复用本容量 */
  maxActive: 20,
  /** 生命（临时 state，不存档） */
  health: 100,
  /** AABB 0.6×1.8×0.6，position 为脚底 */
  width: 0.6,
  height: 1.8,
  /** 追逐速度 1.2 格/秒（mc-lite `0.02 格/帧` × 60Hz） */
  speed: 1.2,
  /** 感知范围 80 格（保留为 type 数据；超过则 AI 输出 idle/零速度） */
  perceptionRange: 80,
  /** AI 预算门：距玩家超过 60 格不进 AI 批次（**只冻结意图，不是销毁半径**） */
  aiSleepDistance: 60,
  /** AI 周期 0.05 秒 = 20Hz（等价 mc-lite 60fps 下每 3 帧一次） */
  aiPeriod: 0.05,
});

/** 受伤红闪时长（ms）：M6 规格 §3 保留 mc-lite 的受伤反馈 */
export const ZOMBIE_FLASH_MS = 200;

/**
 * 步态常量（mc-lite `WALK_ANIMATION`：`speed: 10` / `legSwingAngle: Math.PI / 8`）。
 *
 * 驱动口径 = **按时间累积**（mc-lite `calculateWalkAnimation`：移动中 `_walkTime += deltaTime`，
 * 摆幅 `sin(_walkTime × speed) × legSwingAngle`，静止时 `_walkTime = 0` 归零而非冻结）。
 * 勿改成「按移动距离累积」—— 那是另一种手感，与 mc-lite 不一致。
 */
export const ZOMBIE_WALK_SPEED = 10;
export const ZOMBIE_SWING = Math.PI / 8;

/**
 * 「是否在移动」的判定阈值（mc-lite `calculateWalkAnimation` 与 `setDesiredVelocity` 同用 0.001）。
 *
 * **放在 config 而不是各层各写一份**（红线 1：同一事实的多个副本会漂移）。两个消费方都在用它，
 * 且必须同值 —— 若步态判定与朝向派生用不同阈值，会出现「腿在摆但朝向没跟上」或反之：
 * ① `zombie-renderer.js`（render 层）：步态相位累积的 moving 判定；
 * ② `zombie-system.js`（entities 同构层）：朝向派生的 moving 判定。
 * entities 层不得反向依赖 render，故常量必须落在两层都能 import 的 config 里。
 */
export const ZOMBIE_MOVING_EPSILON = 0.001;
