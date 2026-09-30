// src/entities/minecarts/minecart-system.js — 矿车移动/碰撞/连挂同构纯函数 + 玩法入口
// 同构层：**无 DOM、无 three、不新增 Worker**（`npm run check:arch` 静态门守）。
//
// 行为语义逐条移植 mc-lite `MinecartMovementSystem` / `MinecartCollisionSystem` /
// `MinecartLinkDetector`（设计文档 §3）；**架构不搬**（红线 1/6，设计文档 §6 偏离表）。
//
// ⚠️ 与 mc-lite 的结构性差异：mc-lite 是单管理器循环直接改对象；本仓库的
// `EntityManager.update` 逐实体调 `definition.update` 且要求**返回全新 state**
// （M6 活跃约束）。故对他车的写入一律进 `deferred` 队列，由 service 在循环后统一生效。
import {
  MINECART, MOVEMENT, MINECART_AABB, MINECART_TYPE, directionOf, leftOf, rightOf,
  isTrackBlock, hasTrackAt, hasSolidAt,
} from './minecart-config.js';
import { normalizePosition, raycastAabbSlab } from '../entity-types.js';

/** 位置索引键（floor 后拼串，mc-lite `getPositionKey` 同口径）。 */
export function cellKey(x, y, z) {
  return `${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}`;
}

/**
 * 车所在格的四邻可用轨道方向（mc-lite `getAvailableTrackDirections`）。
 * ⚠️ **铁轨在车下方一格**（`trackY = carY - 1`）。
 * @returns {number[]} 可用朝向（0-3），可能为空
 */
export function availableTrackDirections(world, registry, carX, carY, carZ) {
  const trackY = carY - 1;
  const out = [];
  for (let orientation = 0; orientation < 4; orientation++) {
    const d = directionOf(orientation, MOVEMENT.FORWARD);
    if (hasTrackAt(world, registry, carX + d.x, trackY, carZ + d.z)) out.push(orientation);
  }
  return out;
}

/**
 * 按可用轨道调整朝向（mc-lite `alignMinecartToTrack`）。
 * @returns {number|null} 可走 → 朝向；无相邻轨道 → null
 */
export function alignToTrack(world, registry, orientation, carX, carY, carZ) {
  const available = availableTrackDirections(world, registry, carX, carY, carZ);
  if (available.length === 0) return null;
  if (available.includes(orientation)) return orientation;
  // 选与当前朝向差最小的方向（避免 180° 大转弯，mc-lite 同逻辑）
  let best = available[0];
  let minDiff = 4;
  for (const dir of available) {
    const diff = Math.min(Math.abs(dir - orientation), 4 - Math.abs(dir - orientation));
    if (diff < minDiff) { minDiff = diff; best = dir; }
  }
  return best;
}

/**
 * 转弯检测（mc-lite `checkTurn`）。**左优先**：只有左侧不可走才试右侧。
 * ⚠️ 后退时左右互换（mc-lite 同口径）。
 * @param {{x:number,y:number,z:number}} trackPos 车所在格（y 是车的 y，不是轨道 y）
 * @returns {{turn: 'left'|'right'|null, newOrientation: number|null}}
 */
export function checkTurn(world, registry, orientation, movementState, trackPos) {
  const backward = movementState === MOVEMENT.BACKWARD;
  const left = backward ? rightOf(orientation) : leftOf(orientation);
  const right = backward ? leftOf(orientation) : rightOf(orientation);
  const trackY = trackPos.y - 1;
  if (hasTrackAt(world, registry, trackPos.x + left.x, trackY, trackPos.z + left.z)) {
    return { turn: 'left', newOrientation: (orientation + 1) % 4 };
  }
  if (hasTrackAt(world, registry, trackPos.x + right.x, trackY, trackPos.z + right.z)) {
    return { turn: 'right', newOrientation: (orientation + 3) % 4 };
  }
  return { turn: null, newOrientation: null };
}

/**
 * 相向判定（mc-lite `isHeadOn`）：A 的前方格是 B 所在格，且 B 的前方格是 A 所在格。
 * 任一方 idle → false（mc-lite 首行门控）。
 *
 * ⚠️ **相邻判据用 `round` 而非 mc-lite 的 `floor`（有意偏离，fix round 2）**：本仓库找前方车
 * 用 `frontX = round(position) + dir`（轨道中心基准），若相邻判定用 floor 则两个判据基准不一致
 * —— 浮点累积让车停在 4.9999999999999964 时 `round=5 / floor=4`，于是「找到了前方车」却判不出
 * 相向（`floor+1=5 ≠ 6`）→ 落「前车仍在运动 → 等待」分支 → **两车互等永久死锁**
 * （controller 实测，`repro-headon-deadlock.mjs`）。统一到 round 后两个判据同源。
 * mc-lite 不会踩到是因为它的 `getMinecartAt` 索引与前方格查询同为 floor 基（自洽）。
 */
export function isHeadOn(a, b) {
  if (a.movementState === MOVEMENT.IDLE || b.movementState === MOVEMENT.IDLE) return false;
  const da = directionOf(a.orientation, a.movementState);
  const db = directionOf(b.orientation, b.movementState);
  const ax = Math.round(a.position[0]), az = Math.round(a.position[2]);
  const bx = Math.round(b.position[0]), bz = Math.round(b.position[2]);
  return (ax + da.x === bx && az + da.z === bz) && (bx + db.x === ax && bz + db.z === az);
}

/**
 * 静止车能否被激活（mc-lite `canActivateStaticMinecart`）：
 * ① 继承运动车方向后，前方格不得有实心阻挡；② 前方有轨道，**或**左右任一侧可转向。
 */
export function canActivateStatic(world, registry, moving, staticCar) {
  const d = directionOf(moving.orientation, moving.movementState);
  // mc-lite 用 round 取轨道格（避免 floor 的 0.5 格偏差）
  const trackX = Math.round(staticCar.position[0]);
  const trackY = Math.floor(staticCar.position[1]);
  const trackZ = Math.round(staticCar.position[2]);
  const railY = trackY - 1;
  if (hasSolidAt(world, registry, trackX + d.x, trackY, trackZ + d.z)) return false;
  if (hasTrackAt(world, registry, trackX + d.x, railY, trackZ + d.z)) return true;
  const backward = moving.movementState === MOVEMENT.BACKWARD;
  const left = backward ? rightOf(moving.orientation) : leftOf(moving.orientation);
  const right = backward ? leftOf(moving.orientation) : rightOf(moving.orientation);
  return hasTrackAt(world, registry, trackX + left.x, railY, trackZ + left.z)
    || hasTrackAt(world, registry, trackX + right.x, railY, trackZ + right.z);
}

/**
 * 连挂递归（mc-lite `MinecartLinkDetector.findAllLinked`）：沿朝向找**相邻格、同朝向**的车。
 * 用显式栈而非递归（mc-lite 是递归 + visited，行为等价；栈版无调用深度风险）。
 * @param {Map<string, object>} byId id → state
 * @param {string} startId
 * @returns {string[]} 含自身，长度 ≤ `MINECART.maxLinked`
 */
export function findLinked(byId, startId) {
  const visited = new Set();
  const stack = [startId];
  while (stack.length > 0 && visited.size < MINECART.maxLinked) {
    const id = stack.pop();
    if (visited.has(id)) continue;
    const c = byId.get(id);
    if (!c) continue;
    visited.add(id);
    const d = directionOf(c.orientation, MOVEMENT.FORWARD);
    const cx = Math.floor(c.position[0]);
    const cy = Math.floor(c.position[1]);
    const cz = Math.floor(c.position[2]);
    for (const [dx, dz] of [[d.x, d.z], [-d.x, -d.z]]) {
      const key = cellKey(cx + dx, cy, cz + dz);
      for (const [otherId, other] of byId) {
        if (otherId === id || visited.has(otherId)) continue;
        if (cellKey(other.position[0], other.position[1], other.position[2]) !== key) continue;
        if (other.orientation !== c.orientation) continue;   // 同朝向才连挂
        stack.push(otherId);
      }
    }
  }
  return [...visited];
}

/**
 * 轨道格键（**round 基**）：与 `frontX = round(position) + dir` 同源。
 * ⚠️ 与 `cellKey`（floor 基，位置索引/预占位用）**不是一个口径**，两者不得混用：
 * 车在 5.9667 时 floor 索引为 cell5、round 索引为 cell6 —— 跨车「前方有车吗」必须用
 * round 基，否则与 frontX 的基准对不上（fix round 2 实测：两车互相穿过）。
 */
function roundKey(x, y, z) {
  return `${Math.round(x)},${Math.floor(y)},${Math.round(z)}`;
}

/**
 * 本帧跨车视图。**优先读帧前快照**（`service.carsView()`，Task 3 的 `beginFrame()` 捕获），
 * 回落 `service.cars()`。
 *
 * 为什么快照是**顺序无关**的关键：`EntityManager.update` 里 `entity.state = next` 立即生效，
 * 若跨车读取实时 state，则先跑的车停下后，后跑的车同帧看到它已 idle → `isHeadOn` 因
 * 「任一方 idle」早退 false → 走「运动撞静止 → 激活」把刚停下的车**重新推走**
 * （fix round 2 实测：`round + live` 下 [a,b] ❌ / [b,a] ✅ —— 行为依赖遍历顺序）。
 * 读帧前快照则两车看到彼此「都还在动」→ 各自判出相向 → 各自停 + 各自排队对方停。
 *
 * ⚠️ `reservations` 仍是同帧可变（它是同帧协调，不是状态读取）。
 * @returns {Array<{id: string, state: object}>}
 */
function frameView(service) {
  if (!service) return [];
  if (typeof service.carsView === 'function') return service.carsView() ?? [];
  return typeof service.cars === 'function' ? service.cars() ?? [] : [];
}

/**
 * round 基前方车查询。优先 `service.carAtRound`（Task 3 的索引版），否则在帧视图上线性找
 * —— **不得回落 `service.carAt`**（那是 floor 基索引，与 frontX 的 round 基不同源）。
 * @returns {{id: string, state: object}|null}
 */
function carInFront(service, x, y, z) {
  if (!service) return null;
  if (typeof service.carAtRound === 'function') return service.carAtRound(x, y, z) ?? null;
  const key = roundKey(x, y, z);
  for (const other of frameView(service)) {
    if (!other || !other.state) continue;
    if (roundKey(...other.state.position) === key) return other;
  }
  return null;
}

/** 深拷贝 state（**position/lastTrack 数组必须是新的** —— M6 活跃约束）。 */
function cloneState(s) {
  return {
    position: [s.position[0], s.position[1], s.position[2]],
    orientation: s.orientation,
    movementState: s.movementState,
    lastTrack: s.lastTrack ? [s.lastTrack[0], s.lastTrack[1], s.lastTrack[2]] : null,
    pendingTargetCell: s.pendingTargetCell ? { ...s.pendingTargetCell } : null,
    linked: Array.isArray(s.linked) ? [...s.linked] : [],
  };
}

/**
 * 玩家阻挡判定（mc-lite `checkPlayerCollision` 逐行语义）。
 * @returns {'none'|'stop'|number} `number` = 应把玩家脚底抬到的 y
 */
function resolvePlayerBlocking(world, registry, state, player, frontX, frontZ) {
  const minecartTopY = state.position[1] + MINECART.rideHeight;
  const [px, py, pz] = player.position;
  const halfW = MINECART.playerHalfWidth;   // 玩家 AABB 半宽（单一权威在 config，红线 1）
  const overlapsX = px - halfW < frontX + 1 && px + halfW > frontX;
  const overlapsZ = pz - halfW < frontZ + 1 && pz + halfW > frontZ;
  if (!overlapsX || !overlapsZ) return 'none';
  if (py >= minecartTopY - 0.1) return 'none';   // 玩家已在车顶之上
  const playerFloorX = Math.floor(px);
  const playerFloorZ = Math.floor(pz);
  for (let dy = 0; dy <= 2; dy++) {              // mc-lite 检查 dy 0..2
    if (hasSolidAt(world, registry, playerFloorX, Math.floor(minecartTopY + dy), playerFloorZ)) {
      return 'stop';
    }
  }
  return minecartTopY;
}

/**
 * 单车一帧的推进计划（mc-lite `MinecartMovementSystem.update` 的纯函数化）。
 *
 * **为什么返回计划而不是直接改 state**：`EntityManager.update` 逐实体调
 * `definition.update`，跨车写入必须排队（见文件头 ⚠️）。本函数只读 world / service，
 * 输出 `{state, deferred, liftPlayer}`。
 *
 * 判定顺序照 mc-lite 逐条搬（**顺序不得调整**）：
 * ① idle 早退 → ② 跨中心时检查前方轨道 → ③ 转弯 → ④ 声明冲突 → ⑤ 前方车
 * → ⑥ 前方玩家 → ⑦ 前方实心 → ⑧ 声明目标格 → ⑨ 帧预占位 → ⑩ 位移。
 */
export function planMinecartStep({ state, dt, world, registry, service, selfId, player = null }) {
  const deferred = [];
  // ① idle 不动。仍返回全新对象（M6 约束）
  if (state.movementState === MOVEMENT.IDLE) {
    return {
      state: cloneState({ ...state, pendingTargetCell: null }),
      deferred, liftPlayer: null,
    };
  }

  const dir = directionOf(state.orientation, state.movementState);
  // 轨道判定用「最近轨道中心」（round）；位置索引用 floor（mc-lite 同口径）
  const currentTrackX = Math.round(state.position[0]);
  const currentTrackZ = Math.round(state.position[2]);
  const currentX = Math.floor(state.position[0]);
  const currentY = Math.floor(state.position[1]);
  const currentZ = Math.floor(state.position[2]);
  const trackY = currentY - 1;

  // 到达已声明目标格 → 清声明（避免长期占位）
  let pendingTargetCell = state.pendingTargetCell;
  if (pendingTargetCell && pendingTargetCell.x === currentX
      && pendingTargetCell.y === currentY && pendingTargetCell.z === currentZ) {
    pendingTargetCell = null;
  }

  const localX = state.position[0] - currentTrackX;
  const localZ = state.position[2] - currentTrackZ;
  const stepLen = MINECART.speed * dt;
  const newX = state.position[0] + dir.x * stepLen;
  const newZ = state.position[2] + dir.z * stepLen;
  const nextCellX = Math.floor(newX);
  const nextCellZ = Math.floor(newZ);
  const newLocalX = newX - currentTrackX;
  const newLocalZ = newZ - currentTrackZ;

  // 是否跨越轨道中心（只在移动方向上跨才算）
  const crossedCenterX = (dir.x > 0 && localX <= 0 && newLocalX > 0)
    || (dir.x < 0 && localX >= 0 && newLocalX < 0);
  const crossedCenterZ = (dir.z > 0 && localZ <= 0 && newLocalZ > 0)
    || (dir.z < 0 && localZ >= 0 && newLocalZ < 0);
  const shouldCheck = (dir.x !== 0 && crossedCenterX) || (dir.z !== 0 && crossedCenterZ);

  /** 停车并吸附到指定轨道格（mc-lite `stopMinecartAtCell`） */
  const stopped = (x, z) => cloneState({
    ...state,
    position: [x, state.position[1], z],
    movementState: MOVEMENT.IDLE,
    lastTrack: [x, currentY, z],
    pendingTargetCell: null,
  });
  /** 本帧不推进（等待/转弯/激活）：位置不变，只更新声明 */
  const held = (patch = {}) => cloneState({ ...state, ...patch, pendingTargetCell });

  if (shouldCheck) {
    const frontX = currentTrackX + dir.x;
    const frontZ = currentTrackZ + dir.z;

    // ②③ 前方无轨道 → 转弯或停
    if (!hasTrackAt(world, registry, frontX, trackY, frontZ)) {
      const turn = checkTurn(world, registry, state.orientation, state.movementState,
        { x: currentTrackX, y: currentY, z: currentTrackZ });
      if (turn.turn) {
        // 可转弯：更新朝向，**本帧不推进**（mc-lite 同口径）
        return {
          state: cloneState({ ...state, orientation: turn.newOrientation, pendingTargetCell: null }),
          deferred, liftPlayer: null,
        };
      }
      return {
        state: stopped(currentTrackX, currentTrackZ), deferred, liftPlayer: null,
      };
    }

    // ④ 跨帧目标格声明冲突（读帧前快照 → 顺序无关）
    if (service) {
      for (const other of frameView(service)) {
        if (!other || other.id === selfId) continue;
        if (other.state.movementState === MOVEMENT.IDLE) continue;
        const claim = other.state.pendingTargetCell;
        if (!claim) continue;
        if (claim.x === frontX && claim.y === currentY && claim.z === frontZ) {
          return { state: held(), deferred, liftPlayer: null };
        }
      }
    }

    // ⑤ 前方有车（**round 基**查询，与 frontX 同源）
    let otherCar = carInFront(service, frontX, currentY, frontZ);
    let sameCellHeadOn = false;
    if (!otherCar) {
      // ⚠️ **偶数间距对称接近的缝**（fix round 2 实测，controller 裁定选项 A）：
      // 两车从 cell4/cell6 对称接近时 round 格距从 2 **直接跳到 0**（round(a)=4 要求 x<0.5
      // 而 round(b)=5 要求 x>0.5，互斥）→ frontX 永远查不到对方 → 互相穿过。
      // 回查本车当前 round 格：**反向**运动车视同相向（都停 + 回弹 lastTrack，回弹把两车
      // 分开，重叠自解）；**同向**车忽略（那是跟车不是撞车，正常间距逻辑处理 ——
      // 若让它等待会造出新死锁）。同格 idle 车不触发（只处理反向运动车）。
      const sameCell = carInFront(service, currentTrackX, currentY, currentTrackZ);
      if (sameCell && sameCell.id !== selfId
          && sameCell.state.movementState !== MOVEMENT.IDLE) {
        const dOther = directionOf(sameCell.state.orientation, sameCell.state.movementState);
        if (dir.x === -dOther.x && dir.z === -dOther.z) {
          otherCar = sameCell;
          sameCellHeadOn = true;   // 同格不能用相邻判据的 isHeadOn，直接走相向分支
        }
      }
    }
    if (otherCar) {
      const otherState = otherCar.state;
      // 相向 → 两车都停 + 各自回弹 lastTrack（设计文档 §3.1 第 7 条 / §3.2）
      if (sameCellHeadOn || isHeadOn(state, otherState)) {
        // ⚠️ 回弹到各自的 lastTrack 而非 round(position)：两车相遇时 round 可能同为 cell5
        // → 都吸附到 5 → **重叠同格**（fix round 2 实测）。lastTrack 是各自最后经过的轨道格
        // （a=cell4 / b=cell6）→ 天然分开。mc-lite `bounceToLastTrack` 同语义。
        const oBounce = otherState.lastTrack
          ?? [Math.round(otherState.position[0]), Math.floor(otherState.position[1]),
            Math.round(otherState.position[2])];
        deferred.push({
          id: otherCar.id,
          patch: {
            movementState: MOVEMENT.IDLE,
            position: [oBounce[0], otherState.position[1], oBounce[2]],
            lastTrack: oBounce,
            pendingTargetCell: null,
          },
        });
        const selfBounce = state.lastTrack ?? [currentTrackX, currentY, currentTrackZ];
        return { state: stopped(selfBounce[0], selfBounce[2]), deferred, liftPlayer: null };
      }
      // 运动撞静止 → 尝试激活
      if (otherState.movementState === MOVEMENT.IDLE
          && canActivateStatic(world, registry, state, otherState)) {
        deferred.push({
          id: otherCar.id,
          patch: {
            orientation: state.orientation,
            movementState: state.movementState,
            lastTrack: otherState.lastTrack ?? [Math.floor(otherState.position[0]),
              Math.floor(otherState.position[1]), Math.floor(otherState.position[2])],
          },
        });
        // 本帧不推进自己（避免与刚激活的车重叠入格）
        return { state: held(), deferred, liftPlayer: null };
      }
      // 前车仍在运动（非相向）→ 等待
      if (otherState.movementState !== MOVEMENT.IDLE) {
        return { state: held(), deferred, liftPlayer: null };
      }
      // 其余（激活失败）→ 自己停
      return { state: stopped(currentTrackX, currentTrackZ), deferred, liftPlayer: null };
    }

    // ⑥ 前方玩家
    let liftPlayer = null;
    if (player) {
      const playerResult = resolvePlayerBlocking(world, registry, state, player, frontX, frontZ);
      if (playerResult === 'stop') {
        return { state: stopped(currentTrackX, currentTrackZ), deferred, liftPlayer: null };
      }
      if (typeof playerResult === 'number') liftPlayer = playerResult;
    }

    // ⑦ 前方实心（即使有轨道也不能穿）
    if (hasSolidAt(world, registry, frontX, currentY, frontZ)) {
      return { state: stopped(currentTrackX, currentTrackZ), deferred, liftPlayer };
    }

    // ⑧ 声明下一目标格
    pendingTargetCell = { x: frontX, y: currentY, z: frontZ };

    // ⑨ 同帧预占位
    if (service && (nextCellX !== currentX || nextCellZ !== currentZ)) {
      const reservationKey = cellKey(nextCellX, currentY, nextCellZ);
      const holder = service.reservations.get(reservationKey);
      if (holder && holder !== selfId) {
        return { state: held(), deferred, liftPlayer };
      }
      service.reservations.set(reservationKey, selfId);
    }

    // ⑩ 位移（进新格时更新 lastTrack）
    const enteredNewCell = Math.floor(newX) !== currentX || Math.floor(newZ) !== currentZ;
    return {
      state: cloneState({
        ...state,
        position: [newX, state.position[1], newZ],
        lastTrack: enteredNewCell ? [currentX, currentY, currentZ] : state.lastTrack,
        pendingTargetCell,
      }),
      deferred,
      liftPlayer,
    };
  }

  // 未跨中心：直接位移（⑨ 预占位同样适用）
  let liftPlayer = null;
  if (service && (nextCellX !== currentX || nextCellZ !== currentZ)) {
    const reservationKey = cellKey(nextCellX, currentY, nextCellZ);
    const holder = service.reservations.get(reservationKey);
    if (holder && holder !== selfId) {
      return { state: held(), deferred, liftPlayer: null };
    }
    service.reservations.set(reservationKey, selfId);
  }
  const enteredNewCell = Math.floor(newX) !== currentX || Math.floor(newZ) !== currentZ;
  return {
    state: cloneState({
      ...state,
      position: [newX, state.position[1], newZ],
      lastTrack: enteredNewCell ? [currentX, currentY, currentZ] : state.lastTrack,
      pendingTargetCell,
    }),
    deferred,
    liftPlayer,
  };
}

// ---------------------------------------------------------------- definition + 玩法入口（Task 3）

/**
 * 新建一份合法 state。**每次都返回全新对象 + 全新数组**（M6 活跃约束）。
 * 瞬态字段（pendingTargetCell / linked）保留 —— `activate`/`applyDeferred` 都经本函数重建，
 * 不保留会让每次重建都清掉目标格声明（同丧尸 `_physAccum` 的理由）。
 */
function createState({ position, orientation, movementState, lastTrack, pendingTargetCell, linked }) {
  const pos = normalizePosition(position);
  if (!pos) return null;
  const orient = Number.isInteger(orientation) && orientation >= 0 && orientation <= 3
    ? orientation : 0;
  const movement = movementState === MOVEMENT.FORWARD || movementState === MOVEMENT.BACKWARD
    ? movementState : MOVEMENT.IDLE;
  const track = Array.isArray(lastTrack) && lastTrack.length === 3 && lastTrack.every(Number.isFinite)
    ? [lastTrack[0], lastTrack[1], lastTrack[2]] : null;
  return {
    position: pos,
    orientation: orient,
    movementState: movement,
    lastTrack: track,
    pendingTargetCell: pendingTargetCell && Number.isFinite(pendingTargetCell.x)
      ? { x: pendingTargetCell.x, y: pendingTargetCell.y, z: pendingTargetCell.z } : null,
    linked: Array.isArray(linked) ? [...linked] : [],
  };
}

/**
 * 每帧推进（由 `EntityManager.update` 驱动）。
 * ⚠️ **跨车写入不在此生效** —— 进 service 的待生效队列，由 game.js 在
 * `entities.update(...)` 之后紧邻一行调 `applyDeferred()`。放进本函数会在遍历中改动
 * 被遍历的集合（设计文档 §3.4）。
 */
function update(entity, dt, context) {
  const service = context?.minecarts;
  if (!service || !context?.world) return entity.state;
  const { state, deferred, liftPlayer } = planMinecartStep({
    state: entity.state, dt, world: context.world,
    registry: context.registry ?? context.world.registry,
    service, selfId: entity.id, player: context.player ?? null,
  });
  if (deferred.length > 0) service.queueDeferred(deferred);
  if (liftPlayer !== null) service.liftPlayer(liftPlayer);
  return state;
}

export const minecartDefinition = Object.freeze({
  create: createState,
  update,
  raycastAabb: (state, origin, dir, maxDist) =>
    raycastAabbSlab(state, origin, dir, maxDist, MINECART_AABB),
  /** 持久 snapshot：只含 4 个字段（瞬态的 pendingTargetCell/linked 不入档） */
  serialize(state) {
    const s = createState(state);
    if (!s) return null;
    return {
      position: s.position,
      orientation: s.orientation,
      movementState: s.movementState,
      lastTrack: s.lastTrack,
    };
  },
  deserialize(raw) {
    if (!raw || typeof raw !== 'object') return null;
    return createState({
      position: raw.position,
      orientation: raw.orientation,
      movementState: raw.movementState,
      lastTrack: raw.lastTrack,
    });
  },
});

/**
 * 矿车玩法入口（设计文档 §1.2）。
 *
 * **不持有第二份实体集合**（红线 1）：state 权威在 `EntityManager`，本类只持有
 * ① 派生位置索引 `Map<"x,y,z", id>`（可 `syncIndex()` 全量重建）；
 * ② 每帧瞬态（reservations / deferred 队列 / 抬玩家意图）。
 */
export class MinecartService {
  /**
   * @param {{entities: import('../entity-manager.js').EntityManager, world: object,
   *          registry: object,
   *          persistence?: {entitiesCache: Map, flushEntities: Function}|null}} deps
   */
  constructor({ entities, world, registry, persistence = null }) {
    this.entities = entities;
    this.world = world;
    this.registry = registry;
    this.persistence = persistence;
    /** 派生位置索引：`"x,y,z"` → id（floor 基，拾取/乘坐/放置占用判定用） */
    this._index = new Map();
    /**
     * 派生 round 基索引：`"round(x),floor(y),round(z)"` → id。
     * ⚠️ **`planMinecartStep` 的前方车查询走 round 基**（`carInFront` 优先调 `carAtRound`），
     * 因为 `frontX = round(position)+dir` 是 round 基 —— 用 floor 基索引查会漏（fix round 2
     * 实测：两车互相穿过）。两份索引都从 EntityManager 派生，`syncIndex()` 一起重建。
     */
    this._roundIndex = new Map();
    /**
     * 帧前快照（`beginFrame()` 捕获）：`Array<{id, state}>`。
     * ⚠️ **这是「顺序无关」的关键**（fix round 2 实测）：`EntityManager.update` 里
     * `entity.state = next` 立即生效，若跨车读取实时 state，先跑的车停下后，后跑的车同帧
     * 看到它已 idle → `isHeadOn` 早退 false → 走「激活静止车」把刚停的车重新推走
     * （[a,b] ❌ / [b,a] ✅ —— 行为依赖遍历顺序）。`planMinecartStep` 的 `frameView()`
     * **优先读 `carsView()`**；若本方法缺失会回落到 `cars()`（实时 state）→ 顺序依赖悄悄复活。
     * 故 **`carsView()` 必须实现，不得省略**。
     */
    this._frameView = [];
    /** 每帧目标格预占位：`"x,y,z"` → id（mc-lite frameReservations 同物） */
    this.reservations = new Map();
    /** 跨车写入待生效队列 */
    this._deferred = [];
    /** 本帧「把玩家脚底抬到 y」的意图（game.js 消费后清空） */
    this.pendingPlayerLift = null;
  }

  /**
   * 每帧开始：清瞬态 + **捕获帧前快照**。
   * ⚠️ 快照必须在 `entities.update(...)` **之前**捕获（game.js 的帧序保证），
   * 否则 `carsView()` 读到的是半更新状态 → 顺序无关性失效。
   */
  beginFrame() {
    this.reservations.clear();
    this._deferred.length = 0;
    this.pendingPlayerLift = null;
    // 帧前快照：只存 id + state 引用（state 在本帧内会被替换成新对象，引用本身不被改写）
    this._frameView = [];
    for (const entity of this.entities.entities()) {
      if (entity.type === MINECART_TYPE) this._frameView.push({ id: entity.id, state: entity.state });
    }
  }

  /**
   * 帧前快照视图（`planMinecartStep` 的 `frameView()` 优先消费）。
   * ⚠️ **不得省略本方法** —— 缺失会让 `frameView()` 回落到 `cars()`（实时 state），
   * 顺序依赖悄悄复活（见 `_frameView` 字段注释）。
   * @returns {Array<{id: string, state: object}>}
   */
  carsView() { return this._frameView; }

  /**
   * round 基前方车查询（`planMinecartStep` 的 `carInFront()` 优先消费）。
   * ⚠️ **不得回落到 floor 基的 `carAt`** —— 两者不同源，混用会让偶数间距的相向车互相穿过
   * （fix round 2 实测的第四机制）。
   * ⚠️ `_frameView` 只在 `beginFrame()` 重建，故若 `place()`/`destroy()` 发生在上次
   * `beginFrame()` 之后，`carAtRound` 可能返回 null 而 `_roundIndex` 仍持有该 id ——
   * 规定的帧序（beginFrame → update → applyDeferred → syncIndex）下无害，
   * 但调用方不得把 null 当作「这里没车」。
   * @returns {{id: string, state: object}|null}
   */
  carAtRound(x, y, z) {
    const id = this._roundIndex.get(roundKey(x, y, z));   // roundKey 是同文件模块私有函数
    if (!id) return null;
    // ⚠️ **必须从帧前快照 `_frameView` 返回，不得返回实时 state**（controller 实测裁定）：
    // 若返回 `entities.get(id).state`（实时），先跑的车停下后，后跑的车同帧查到它已 idle
    // → isHeadOn 早退 → 走「激活静止车」把刚停的车重新推走（[a,b] ❌ / [b,a] ✅ ——
    // 顺序依赖复活）。返回快照则两车看到彼此「都还在动」→ 各自判出相向 → 都停。
    // 与 `carsView()` 同源（都是 `_frameView`），保证跨车读取口径一致。
    return this._frameView.find((e) => e.id === id) ?? null;
  }

  /** definition.update 调用：登记跨车写入意图 */
  queueDeferred(list) {
    for (const item of list) this._deferred.push(item);
  }

  /** definition.update 调用：登记抬玩家意图（多车同帧取最高值） */
  liftPlayer(y) {
    if (this.pendingPlayerLift === null || y > this.pendingPlayerLift) this.pendingPlayerLift = y;
  }

  /**
   * 统一生效跨车写入。**必须在 `entities.update(...)` 之后调**（设计文档 §3.4）。
   * 每条 patch 都经 `createState` 重建全新 state（M6 约束）。
   * @returns {number} 生效条数
   */
  applyDeferred() {
    let n = 0;
    const queue = this._deferred;
    this._deferred = [];
    for (const { id, patch } of queue) {
      const entity = this.entities.get(id);
      if (!entity || entity.type !== MINECART_TYPE) continue;
      const next = createState({ ...entity.state, ...patch });
      if (!next) continue;
      entity.state = next;
      // ⚠️ 回弹 lastTrack 可能跨 column，而本方法在 EntityManager.update 之外 →
      // 必须显式校准派生索引，否则旧 column 卸载会误回收这辆车（见 reindexColumn 注释）
      this.entities.reindexColumn(id);
      n++;
    }
    return n;
  }

  /**
   * **每帧全量重建位置索引**（game.js 在 `applyDeferred()` 之后调）。
   * 为什么全量而非增量：50 辆车 × 每帧一次可忽略，且不会漏 —— 增量要在 definition
   * 里回调 service，把同构层与玩法入口耦合成环。不同步会让 `carAt` 读到过期格
   * （前方车判定失效 → 车互相穿过）。
   * @returns {number} 索引条目数
   */
  syncIndex() {
    this._index.clear();
    this._roundIndex.clear();
    for (const entity of this.entities.entities()) {
      if (entity.type !== MINECART_TYPE) continue;
      const [x, y, z] = entity.state.position;
      this._index.set(cellKey(x, y, z), entity.id);
      // round 基索引（前方车查询用）—— 与 floor 基索引同时重建，不得只建一份
      this._roundIndex.set(roundKey(x, y, z), entity.id);
    }
    return this._index.size;
  }

  /** 全局矿车数（**含未加载 column 的**）—— 上限判定唯一来源（M7 活跃约束）。 */
  count() {
    const loaded = new Set();
    for (const entity of this.entities.entities()) {
      if (entity.type === MINECART_TYPE) loaded.add(entity.id);
    }
    let unloaded = 0;
    if (this.persistence?.entitiesCache) {
      for (const [id, snapshot] of this.persistence.entitiesCache) {
        if (snapshot?.type === MINECART_TYPE && !loaded.has(id)) unloaded++;
      }
    }
    return loaded.size + unloaded;
  }

  /** 只读枚举（`planMinecartStep` 的声明冲突分支与渲染层共用）。 */
  cars() {
    const out = [];
    for (const entity of this.entities.entities()) {
      if (entity.type === MINECART_TYPE) out.push({ id: entity.id, state: entity.state });
    }
    return out;
  }

  /** 位置索引查询。@returns {{id:string, state:object}|null} */
  carAt(x, y, z) {
    const id = this._index.get(cellKey(x, y, z));
    if (!id) return null;
    const entity = this.entities.get(id);
    return entity ? { id: entity.id, state: entity.state } : null;
  }

  /**
   * 放置矿车（设计文档 §4.1）。预检顺序：no-column → not-air → no-track → occupied → limit。
   * ⚠️ 任何失败都在 `spawn` 之前返回 —— 失败路径零副作用。
   * @param {{cell: [number,number,number], orientation?: number|null}} req
   *        `orientation` 缺省时取下方铁轨的 meta 朝向（mc-lite `getTrackOrientation`）
   */
  place({ cell, orientation = null }) {
    const [x, y, z] = cell;
    if (!this.world.hasColumn(Math.floor(x / 16), Math.floor(z / 16))) {
      return { ok: false, reason: 'no-column' };
    }
    if (this.world.getBlockId(x, y, z) !== 0) return { ok: false, reason: 'not-air' };
    if (!isTrackBlock(this.world.getBlockId(x, y - 1, z), this.registry)) {
      return { ok: false, reason: 'no-track' };
    }
    if (this._index.has(cellKey(x, y, z))) return { ok: false, reason: 'occupied' };
    if (this.count() >= MINECART.maxMinecarts) return { ok: false, reason: 'limit' };

    // 朝向：缺省取铁轨 meta，再按可用轨道方向修正（mc-lite `createMinecart` 的 bestDir）
    let orient = orientation ?? this.world.getBlockMeta(x, y - 1, z);
    const aligned = alignToTrack(this.world, this.registry, orient, x, y, z);
    if (aligned !== null) orient = aligned;

    const id = this._nextId();
    const entity = this.entities.spawn({
      id,
      type: MINECART_TYPE,
      state: createState({
        position: [x, y, z], orientation: orient, movementState: MOVEMENT.IDLE,
        lastTrack: [x, y, z],
      }),
      persistent: true,   // 持久实体：白拿 M5 的写盘/卸载/清档生命周期
    });
    if (!entity) return { ok: false, reason: 'occupied' };   // id 撞车（理论不可达）
    this._index.set(cellKey(x, y, z), id);
    this._roundIndex.set(roundKey(x, y, z), id);   // 两份索引必须同时维护（否则前方车查询漏车）
    // 显式状态变化 → 立即 flush（M5 规格 §3 的 flush 时机；不 await，失败只记诊断）
    if (this.persistence?.flushEntities) {
      Promise.resolve(this.persistence.flushEntities()).catch((err) => {
        console.warn('[minecart] flushEntities failed:', err);
      });
    }
    return { ok: true, id };
  }

  /** 拾取：断连挂 + despawn + 清索引。**不加回背包**（创造模式口径，设计文档 §6 偏离 3）。 */
  pickUp(id) {
    const entity = this.entities.get(id);
    if (!entity || entity.type !== MINECART_TYPE) return false;
    this.breakLinks(id);
    return this.destroy(id);
  }

  /**
   * 激活（ctrl+左键）。**可走才激活**（`alignToTrack` 返回 null 即无邻轨 → 拒绝），
   * 并按 `findLinked` 带出整列车（mc-lite `activateLinkedMinecarts` 语义）。
   * @param {string} id @param {boolean} backward shift 键 → 后退
   * @returns {boolean}
   */
  activate(id, backward = false) {
    const entity = this.entities.get(id);
    if (!entity || entity.type !== MINECART_TYPE) return false;
    const [x, y, z] = entity.state.position;
    const movement = backward ? MOVEMENT.BACKWARD : MOVEMENT.FORWARD;
    const aligned = alignToTrack(this.world, this.registry, entity.state.orientation,
      Math.floor(x), Math.floor(y), Math.floor(z));
    if (aligned === null) return false;   // 无可用轨道 → 不激活

    const byId = new Map();
    for (const c of this.cars()) byId.set(c.id, c.state);
    const linkedIds = findLinked(byId, id);
    for (const linkedId of linkedIds) {
      const linked = this.entities.get(linkedId);
      if (!linked) continue;
      // 领头车用 align 结果；连挂车按「领头朝向优先，其次反向，其次任一可用」
      let orient = aligned;
      if (linkedId !== id) {
        const [lx, ly, lz] = linked.state.position;
        const dirs = availableTrackDirections(this.world, this.registry,
          Math.floor(lx), Math.floor(ly), Math.floor(lz));
        if (dirs.includes(aligned)) orient = aligned;
        else if (dirs.includes((aligned + 2) % 4)) orient = (aligned + 2) % 4;
        else if (dirs.length > 0) orient = dirs[0];
        else continue;   // 该车无可用轨道 → 不激活它
      }
      const next = createState({
        ...linked.state, orientation: orient, movementState: movement,
        linked: linkedIds.filter((other) => other !== linkedId),
        lastTrack: linked.state.lastTrack ?? [Math.floor(linked.state.position[0]),
          Math.floor(linked.state.position[1]), Math.floor(linked.state.position[2])],
      });
      if (!next) continue;   // createState 校验失败 → 跳过该车（与 applyDeferred 的守卫同口径）
      linked.state = next;
    }
    return true;
  }

  /** 断开连挂：连挂车全部停 + 清 linked（mc-lite `breakLinks`）。 */
  breakLinks(id) {
    const entity = this.entities.get(id);
    if (!entity || entity.type !== MINECART_TYPE) return;
    for (const linkedId of entity.state.linked ?? []) {
      const linked = this.entities.get(linkedId);
      if (!linked) continue;
      const next = createState({
        ...linked.state, movementState: MOVEMENT.IDLE,
        linked: (linked.state.linked ?? []).filter((other) => other !== id),
      });
      if (!next) continue;   // createState 校验失败 → 跳过该车（与 applyDeferred 的守卫同口径）
      linked.state = next;
    }
  }

  /** 移除矿车（拾取 / 爆炸共用）。@returns {boolean} */
  destroy(id) {
    const entity = this.entities.get(id);
    if (!entity || entity.type !== MINECART_TYPE) return false;
    const key = cellKey(...entity.state.position);
    if (this.entities.despawn(id, 'minecart-destroyed')) {
      if (this._index.get(key) === id) this._index.delete(key);
      const rKey = roundKey(...entity.state.position);
      if (this._roundIndex.get(rKey) === id) this._roundIndex.delete(rKey);
      // ⚠️ 持久实体销毁必须同步删 store 行（否则 count() 泄漏上限槽位 + reload 复活，
      // 见 Persistence.deleteEntity 注释）。不 await —— 与 place() 的 flush 同口径，
      // 失败只记诊断（内存已一致，store 删除失败最坏是 reload 复活一辆，可接受）。
      if (this.persistence?.deleteEntity) {
        Promise.resolve(this.persistence.deleteEntity(id)).catch((err) => {
          console.warn('[minecart] deleteEntity failed:', err);
        });
      }
      return true;
    }
    return false;
  }

  /**
   * 爆炸半径内摧毁（mc-lite 爆炸段语义）。
   * @param {[number,number,number]} center **方块格坐标**（内部 +0.5 换算块中心）
   * @param {number} [radius] @returns {number} 摧毁数
   */
  destroyInRadius(center, radius = MINECART.explosionRadius) {
    const cx = center[0] + 0.5, cy = center[1] + 0.5, cz = center[2] + 0.5;
    const victims = [];
    for (const c of this.cars()) {
      const [px, py, pz] = c.state.position;
      const dx = px + 0.5 - cx;
      const dy = py + MINECART.explosionOffsetY - cy;
      const dz = pz + 0.5 - cz;
      if (Math.hypot(dx, dy, dz) <= radius) victims.push(c.id);
    }
    for (const victimId of victims) this.destroy(victimId);
    return victims.length;
  }

  /**
   * 乘坐候选：玩家脚下格是否有车，且玩家脚底在车顶 ±容差内（mc-lite `updateMinecartRiding`）。
   * @param {[number,number,number]} playerPos 玩家脚底
   * @returns {{id:string, state:object}|null}
   */
  ridingCarFor(playerPos) {
    const [px, py, pz] = playerPos;
    // mc-lite：`feetY = floor(position.y - 0.1)`
    const c = this.carAt(Math.floor(px), Math.floor(py - 0.1), Math.floor(pz));
    if (!c) return null;
    const topY = c.state.position[1] + MINECART.rideHeight;
    if (Math.abs(py - topY) >= MINECART.rideBindTolerance) return null;
    return c;
  }

  /** 确定性 id（红线 2：不用 Math.random）。取已加载 + cache 的最大后缀 +1。 */
  _nextId() {
    let max = 0;
    const scan = (id) => {
      const n = Number.parseInt(String(id).replace(/^minecart-/, ''), 10);
      if (Number.isFinite(n) && n > max) max = n;
    };
    for (const entity of this.entities.entities()) {
      if (entity.type === MINECART_TYPE) scan(entity.id);
    }
    if (this.persistence?.entitiesCache) {
      for (const [id, snapshot] of this.persistence.entitiesCache) {
        if (snapshot?.type === MINECART_TYPE) scan(id);
      }
    }
    return `minecart-${max + 1}`;
  }

  /** 反向释放（Game.dispose）。 */
  dispose() {
    for (const c of this.cars()) this.entities.despawn(c.id, 'dispose');
    this._index.clear();
    this._roundIndex.clear();   // 两份索引同时清（与 place/destroy/syncIndex 同一口径）
    this.reservations.clear();
    this._deferred.length = 0;
  }
}
