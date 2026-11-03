// src/entities/bosses/boss-agent.js — Boss 智能体抽象基类（v2.44）
//
// 同构层：**无 DOM、无 three、不新增 Worker**（`check:arch` 的 `ISOMORPHIC_DIRS` 静态门守）。
//
// ## 为什么要有这一层（用户 2026-11-03 的架构指令）
//
// 「后面我会增加很多 Boss，每个 Boss 都有自己的智能体类，所以请你将这个实现抽离成一个独立的类，
// 跟原有的逻辑尽量解耦开。」
//
// 于是「Boss 的行为决策」从「Boss 的数据/渲染」里分离出来：
// - 本文件 = 抽象基类 + **所有 Boss 共用的工具**（视线 / 角度 / 水平距离）；
// - `dragon-boss-agent.js` = 飞龙专属的四态机；
// - `dragons/dragon-system.js` 保留轨道/动画/AABB 纯函数 + `DragonService`（召唤/伤害/查询），
//   **不写 AI** —— `dragonDefinition.update` 只委托给 Agent。
//
// 换一个 Boss = 换一个 Agent 子类；服务形状（`DragonService`）可被未来的 Boss 服务复用。
//
// ## 两条载荷性契约（子类必须遵守）
//
// 1. **只读 state 与 ctx，返回全新 state 各字段**（plain 对象）。不得原地改写 state ——
//    M5 不变式：`EntityManager.update` 的跨 column 索引迁移判据是「赋值前 position vs 赋值后
//    position」，原地改写会让 before/after 从同一份算出 → 恒相等 → 索引永不迁移 →
//    column 卸载漏回收实体。
// 2. **不生成实体、不改世界**。要开火就把意图写进返回值的 `fireRequest` 字段，由 `game.js`
//    在 `entities.update` 之后统一消费（与矿车 `pendingPlayerLift` 同一先例）。理由：生成实体 /
//    改世界是主线程装配层职责（要读 `canTntDestroyBlocks`、调爆炸链路），entities/ 同构层不得碰。
//
// 设计文档 `docs/superpowers/specs/2026-11-03-dragon-boss-ai-design.md` §2。

// ⚠️ **视线与角度差的唯一权威在炮塔侧**（红线 1）：`hasLineOfSight` 的遮挡判据
// `isProjectileOccluding`（solid && opaque）正是用户说的「实心不透明方块」；
// `shortestAngleDiff` 归一化到 [-π, π]。各写一份会漂移出「炮塔看得见、Boss 看不见」的撕裂。
import { hasLineOfSight, shortestAngleDiff } from '../turrets/turret-system.js';

/**
 * Boss 智能体抽象基类。
 *
 * ⚠️ **无跨帧可变成员**：所有跨帧状态（冷却、视线缓存、子态）都在 state 里，Agent 实例本身
 * 无状态（除注入的 `rng`）。这样「同一个 Agent 实例服务多条龙」是安全的 —— 多条龙共存时
 * （v2.43 起支持）不会互相污染。
 */
export class BossAgent {
  /**
   * 推进一帧。**抽象方法** —— 子类必须实现。
   *
   * ⚠️ 参数名带 `_` 前缀是 eslint `no-unused-vars` 的仓库约定（`/^_/u`）—— 基类本体不消费
   * 它们，但它们**就是子类必须遵守的签名**。子类覆写时用不带下划线的名字（那里真的消费）。
   *
   * @param {object} _state 实体 state
   * @param {number} _dt 秒
   * @param {object} _ctx 帧上下文（`{world, registry, player, ...}`，形状由装配层决定）
   * @returns {object} 全新 state 各字段
   */
  update(_state, _dt, _ctx) {
    throw new Error('BossAgent.update 是抽象方法，子类必须实现');
  }

  /**
   * 视线判定：from → to 之间是否**没有**「实心不透明方块」遮挡。
   *
   * 转调炮塔的 `hasLineOfSight`（唯一权威）。⚠️ 该判据**能透过玻璃与水**
   * （`glass_block` 是 `cullMode:'transparent'` → `opaqueTable=0`），而**树叶会挡住**
   * （`leaves` 显式 `opaque:true`，v1.42 方案 C 的既有后果，炮塔 LOS 同口径）。
   *
   * @param {{world: object, registry: object}} ctx
   * @param {[number,number,number]} from
   * @param {[number,number,number]} to
   * @returns {boolean}
   */
  _hasLos(ctx, from, to) {
    return hasLineOfSight({ world: ctx.world, registry: ctx.registry, from, to });
  }

  /**
   * 水平指向角（from → to），返回值落在本仓的 yaw 口径里。
   *
   * ⚠️ **公式 `atan2(−dx, −dz)` 由本仓 yaw→前向口径反解而来，不是随手写的**：
   * 前向 = `(−sin yaw, −cos yaw)`（AGENTS.md「出生朝向与相机旋转的测量口径」实测表，
   * 源自 `camera.rotateY(yaw)`）。令前向 = 单位 (dx, dz) ⇒ `sin yaw = −dx`、`cos yaw = −dz`
   * ⇒ `yaw = atan2(−dx, −dz)`。实测四基本方向：北(−Z)→0、南(+Z)→π、东(+X)→−π/2、西(−X)→π/2。
   *
   * **忽略 y**：龙恒在半高，竖直差不该影响「朝哪边转」。
   *
   * @param {[number,number,number]} from @param {[number,number,number]} to
   * @returns {number} 弧度
   */
  _angleTo(from, to) {
    return Math.atan2(-(to[0] - from[0]), -(to[2] - from[2]));
  }

  /**
   * 最短角差（归一化到 [-π, π]）。转调炮塔的唯一权威。
   * @param {number} from @param {number} to @returns {number}
   */
  _angleDiff(from, to) {
    return shortestAngleDiff(from, to);
  }

  /**
   * 水平距离（**忽略 y**）。
   *
   * ⚠️ 刻意不用 3D 距离：龙在 y=30、玩家在地面，竖直差恒 ~28 格 —— 用 3D 距离会让
   * 「60 格发现距离」实际只剩 ~53 格水平距离，且玩家爬到高处时判定会漂移。
   * 「远不远」在玩法上是水平概念（用户说的也是「距离近到一定程度」+「半高高空盘旋」）。
   *
   * @param {[number,number,number]} a @param {[number,number,number]} b
   * @returns {number}
   */
  _hDist(a, b) {
    return Math.hypot(a[0] - b[0], a[2] - b[2]);
  }
}
