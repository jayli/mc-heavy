// src/entities/turrets/turret-controller.js — M8 炮塔控制器：增量失效 + 运行态时钟 + 朝向插值
// 同构层：不得 import three（`tools/check-architecture.mjs` 静态门守）。
//
// 职责边界（规格 §3.2）：
// - **只在 anchor column 已加载时存在** —— 派生对象，不是持久状态。column 卸载即销毁，
//   再次加载后从 blockEntity 恢复（`lastFireAt` 不重置）。
// - 失效订阅 `block-changed` **增量事件**，不轮询 mesh（mc-lite 是每 30 帧轮询
//   `checkIntegrity()`，`Turret.js:398-430`，本仓库改走事件 —— 有意偏离，规格 §3.2）。
// - 朝向插值与开火节流在主线程（Task 4/6），索敌由 `turret-system.js` 的同构纯函数算。
import { TURRET } from './turret-config.js';
import { BASE_DY } from './turret-blueprint.js';
import { shortestAngleDiff, normalizeAngle } from './turret-system.js';

export class TurretController {
  /**
   * @param {{world: import('../../voxel/world-data.js').WorldData,
   *          zombies: {activeEntities: () => Array<Object>, damage: Function}|null,
   *          editor: import('../../core/world-editor.js').WorldEditor,
   *          anchor: {kind: string, id: string, origin: number[],
   *                   critical: {x: number, y: number, z: number, id: number},
   *                   rotation: number, lastFireAt: number},
   *          onInvalidated?: (id: string) => void}} deps
   *        `onInvalidated` 由 Game 注入 `(id) => turrets.destroy(id)`。注入而非直接持有
   *        service 引用 —— 与本仓库既有惯例一致（`isModal` / `onSpawnZombie` / `damage`
   *        都是注入），且让 controller 可独立单测（不必造完整 service fixture）。
   */
  constructor({ world, zombies, editor, anchor, onInvalidated = null, onFire = null }) {
    this.world = world;
    this.zombies = zombies;
    this.editor = editor;
    this.anchor = anchor;
    this._onInvalidated = onInvalidated;
    /**
     * M8 Task 6 发射回调（Game 注入）。controller 不反向依赖 entities/render（依赖方向 §3，
     * 与 `onInvalidated` / `isModal` 同一惯例）；缺省 null → 只写回时钟、不创建弹丸
     * （fixture 单独构造时）。
     * @type {((position:number[], direction:number[], turretId:string)=>void)|null}
     */
    this._onFire = onFire;
    this.id = anchor?.id ?? null;
    /** 最近一次开火时刻（ms，performance 基准）。与 anchor.lastFireAt 同源同步 */
    this.lastFireAt = anchor?.lastFireAt ?? 0;
    /**
     * 当前朝向（弧度）。初值 = 放置时的默认朝向（无目标时回归它）；
     * Task 4 的插值在此累积。**渲染层只读这两个字段**，不得回写（红线 1：朝向是逻辑状态）。
     */
    this.currentRotation = anchor?.rotation ?? 0;
    this.currentPitch = 0;
    /** Task 4 填充：索敌算出的目标朝向 */
    this.targetRotation = this.currentRotation;
    this.targetPitch = 0;
    /** 最近一次索敌时刻（8Hz 节流；Task 4 消费） */
    this.lastTargetSearchAt = 0;
    /** 当前目标实体 id（null = 无目标 → 回归默认朝向） */
    this.targetId = null;
    this._invalidated = false;
  }

  /** 只读诊断接口（单测断言失效状态用，照 ZombieNestController 同手法）。@returns {boolean} */
  isInvalidated() { return this._invalidated; }

  /**
   * 增量失效判定（M7 同口径）。判据 = **坐标覆盖关键格且 `newId !== critical.id`**。
   *
   * ⚠️ **同格写回同 id 不得失效**：炮塔每次开火都用 `editor.setBlockEntity` 写回
   * `lastFireAt`。若判定只看「坐标覆盖关键格」，自己的时钟写回就会把炮塔杀掉
   * （M7 实测踩坑，规格 §3.2）。
   *
   * 徒手挖掉、M4 武器破坏、M8 TNT 批量编辑走的是同一条 setBlock/setBlocks，三者产生的
   * change 都带同样的坐标与 newId → 必然同义（规格 §3.2 要求的「同一失效语义」）。
   *
   * @param {{type:'block-changed', changes: Array<{x,y,z,newId:number}>}} event
   */
  onWorldChange(event) {
    if (this._invalidated) return;
    const critical = this.anchor?.critical;
    if (!critical) return;
    for (const change of event?.changes || []) {
      if (change.x !== critical.x || change.y !== critical.y || change.z !== critical.z) continue;
      if (change.newId === critical.id) continue;   // 同格同 id（时钟写回）→ 不失效
      this._invalidated = true;
      if (this._onInvalidated) this._onInvalidated(this.id);
      return;
    }
  }

  /**
   * 旋转中心（炮塔「肩膀」位置）。= 底座 origin.y + `TURRET.pivotHeightOffset`（3.3）。
   * mc-lite `Turret.js:214` 同口径：pivot 是两级 Object3D 的第一级（`pivotObject.position`）。
   * ⚠️ **实例原点换算基准**（CLAUDE.md 活跃约束）：mc-lite 几何以**块中心**为原点
   * （`position.set(x+0.5, y+0.5, z+0.5)`），本仓库须 +0.5 换算 —— 故 x/z 各 +0.5。
   * ⚠️ y 还要加 `BASE_DY`：mc-lite 的 pivot y = **空气格** y + 3.3，而本仓库的 origin 是
   * 地面格（solid），底座落在 `origin.y + BASE_DY`（见 turret-blueprint 的 `BASE_DY` 注释）。
   * 两者逐位等价 —— 不得只写 `origin.y + 3.3`（那会让 pivot 比 mc-lite 低一格）。
   * @returns {[number, number, number]}
   */
  pivot() {
    const origin = this.anchor?.origin ?? [0, 0, 0];
    return [origin[0] + 0.5, origin[1] + BASE_DY + TURRET.pivotHeightOffset, origin[2] + 0.5];
  }

  /**
   * 炮口位置与方向（Task 6 发射用）。mc-lite `fire()` 语义照搬：炮口在
   * `MUZZLE_OFFSET_Z`，方向 = 炮口位置相对 pivot 的归一化向量（与视觉旋转一致）。
   *
   * 合成顺序照 mc-lite 的两级 Object3D：先按 pitch 绕 X 轴（`pitchObject.rotation.x =
   * -pitch`，`Turret.js:656`），再按 yaw 绕 Y 轴（`pivotObject.rotation.y`）。
   * ⚠️ 方向与渲染层的炮管朝向**同源** —— 两处各算一套会漂移出「弹丸从炮管侧面飞出」。
   *
   * @returns {{position:[number,number,number], direction:[number,number,number]}}
   */
  muzzle() {
    const pivot = this.pivot();
    const mz = TURRET.muzzleOffsetZ;
    // ① 绕 X 轴旋转 (0, 0, mz)。⚠️ **符号必须与渲染层完全一致**（红线 1）：渲染层的 pivot
    // 旋转是 `Rx(-pitch)`（`Turret.js:656`），three 的 `Rx(θ)` 对 (0,0,mz) 给出
    // `y' = -mz·sinθ` → 代入 θ = -pitch 得 **`y' = +mz·sin(pitch)`**。
    // 即负 pitch（俯视）→ 炮口向下。**上一版写成 `mz·sin(-pitch)`（符号反）→ 炮塔朝下瞄准
    // 时弹丸往天上飞**（E2E 实测抓到：丧尸恒 100 血、弹丸从未命中）。
    // ⚠️ 单测必须**交叉比对渲染矩阵**才能钉住这条 —— 只读渲染矩阵的单测测不到本方法的符号。
    const afterPitch = [0, mz * Math.sin(this.currentPitch), mz * Math.cos(this.currentPitch)];
    // ② 绕 Y 轴旋转（x=0）：x' = x·cos + z·sin，z' = −x·sin + z·cos
    const cy = Math.cos(this.currentRotation), sy = Math.sin(this.currentRotation);
    const dir = [afterPitch[2] * sy, afterPitch[1], afterPitch[2] * cy];
    const len = Math.hypot(dir[0], dir[1], dir[2]) || 1;
    return {
      position: [pivot[0] + dir[0], pivot[1] + dir[1], pivot[2] + dir[2]],
      direction: [dir[0] / len, dir[1] / len, dir[2] / len],
    };
  }

  /**
   * 每帧推进（Task 4 填朝向插值、Task 6 填发射）。本任务只交付骨架与失效早退。
   * **时间基准必须是 `performance.now()`** —— 不得用 `Date.now()`（两者相差约 17 亿毫秒，
   * 混用会让冷却判定恒真 → 每帧开火）。
   * @param {number} nowMs @param {number} dt 秒
   * @returns {boolean} 本帧是否开火（Task 6 消费）
   */
  update(nowMs, dt) {
    if (this._invalidated) return false;
    // ---- 朝向插值（限角速度，mc-lite `updateRotation` 语义）----
    // ⚠️ 必须用 `shortestAngleDiff`：直接 `target − current` 在跨 ±π 边界时会绕远路
    // （例如从 3.0 转到 −3.0 走 6 弧度而不是 0.28）→ 炮塔原地打转。
    const yawDiff = shortestAngleDiff(this.currentRotation, this.targetRotation);
    const maxYaw = TURRET.rotationSpeed * dt;
    this.currentRotation = normalizeAngle(
      this.currentRotation + Math.max(-maxYaw, Math.min(maxYaw, yawDiff)),
    );
    const pitchDiff = this.targetPitch - this.currentPitch;
    const maxPitch = TURRET.pitchSpeed * dt;
    this.currentPitch = Math.max(-TURRET.maxPitchAngle, Math.min(TURRET.maxPitchAngle,
      this.currentPitch + Math.max(-maxPitch, Math.min(maxPitch, pitchDiff))));
    // ---- 开火门控 ----
    // ① **无目标不开火**（实玩反馈修正的阻断级缺陷）：mc-lite `tryFire()` 的第一道门就是
    //    `if (!this.targetEnemy) return;`（`Turret.js:665`）。缺这道门会让炮塔**对着空气
    //    无限开火** —— 无丧尸时 `targetRotation` 回归默认朝向、`targetPitch=0`，而
    //    `currentRotation`/`currentPitch` 的初值恰好就是这两个值 → 角度差为 0、冷却早已
    //    到期 → 刚放置就立刻开火且永不停止（丧尸被消灭后也继续打空气）。
    if (!this.targetId) return false;
    // ② 对准（yaw 与 pitch 各 < 阈值）
    if (Math.abs(shortestAngleDiff(this.currentRotation, this.targetRotation))
        > TURRET.fireAngleThreshold) return false;
    if (Math.abs(this.currentPitch - this.targetPitch) > TURRET.fireAngleThreshold) return false;
    // **performance 基准 —— 禁止 Date.now()**（冷却判定混用会恒真 → 每帧开火）
    if (nowMs - this.lastFireAt < TURRET.fireCooldownMs) return false;
    // 发射弹丸（Task 6）：炮口位置与方向来自 `muzzle()`（与渲染层炮管朝向同源，红线 1）
    if (this._onFire) {
      const m = this.muzzle();
      this._onFire(m.position, m.direction, this.id);
    }
    this.writeBackFireClock(nowMs);   // 写回 lastFireAt（纯 entity 写）
    return true;   // Task 6 消费：true → 发射弹丸
  }

  /**
   * 写回 `lastFireAt`（纯 entity 写：不 bump version、不 remesh/light）。
   * **构造新对象而非原地改 `this.anchor`** —— 原地改会让 `column.blockEntities` 与
   * `column.edits` 持有的同一引用被悄悄改写（红线 1 精神，M7 已实测踩坑）。
   * 新对象必须保留 kind/id/origin/critical/rotation —— 漏字段会让锚点失真
   * （reload 后 `hydrate` 读不到 critical → 索引为空 → 炮塔「消失」）。
   * @param {number} nowMs
   */
  writeBackFireClock(nowMs) {
    this.lastFireAt = nowMs;
    const value = { ...this.anchor, lastFireAt: nowMs };
    this.anchor = value;
    const { x, y, z } = value.critical;
    this.editor.setBlockEntity({ x, y, z, value });
  }

  dispose() {
    this._invalidated = true;
    this.world = null; this.zombies = null; this.editor = null;
  }
}
