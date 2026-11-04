// src/ui/damage-numbers.js — 丧尸/Boss 受击浮动血量数字（生命系统显示层）
//
// 用户裁定（2026-11-05）：丧尸与 Boss 被击中掉血时，在其头顶弹出「**掉血之后还剩的血量**」
// 数字，约 1.2 秒上浮淡出。形式选「浮动数字」而非血条：DOM 覆盖层零 draw call、零 GPU
// 开销；3D 血条要逐实体几何/材质（丧尸上限 20 + 龙 4 实打实加 draw call），与「常驻实例池
// 零实例必须 visible=false」的既有预算口径冲突。
//
// ## three-free（与 `src/ui/` 既有口径一致）
//
// 本模块不 import three：世界坐标 → 屏幕坐标的投影由构造期注入的 `projectFn` 完成
// （生产装配在 `game.js`，用一个 scratch `Vector3`）。这与仓库既有注入惯例一致
// （`zombie-nest-controller` 注入 `damage`、`weapon-controller` 注入 `setEntityQuery`）。
//
// ## 跟随语义
//
// 数字**逐帧跟随实体**（龙飞 9 格/秒，定点生成会立刻甩开）。锚点是一个函数
// `anchorFn() → [x,y,z] | null`：实体活着返回头顶世界坐标，已消失（致命一击同帧 despawn）
// 返回 null → 数字**冻结在最后一次已知位置**继续上浮淡出。故致命一击也有数字可看。
//
// ## 同一实体只显示最新数字（用户 2026-11-05 追加裁定）
//
// 机枪连射时每次命中都弹数字，旧的还没淡出就叠在一起 → 数字堆叠不可读。
// 故 `spawn()` 带 `entityId`：**同一实体的新数字直接顶掉旧的未消失数字**（原地复用槽位、
// 重置计时），任何时刻每个实体头顶至多一个数字。不同实体之间互不影响。
//
// ## 性能
//
// 池上限 16 个 `<div>`（构造期一次建好，复用换文本）。无活跃数字时 `update()` 的循环体
// 不执行 = 每帧零成本。活跃期每个数字的成本 = 一次 anchor 调用 + 一次投影 + 一次
// `style.transform/opacity` 写入 —— 受击是低频事件，远低于 HUD 其它成员的每帧开销。
/** 数字的存活时长（ms）：上浮 + 淡出的总窗口（用户裁定「显示一下」≈ 1.2 秒） */
export const DAMAGE_NUMBER_LIFE_MS = 1200;

/** 存活期内的总上浮量（CSS px）：从头顶向上飘一小段，不飞远 */
const RISE_PX = 28;

/** 淡出起点（占生命周期的比例）：前 70% 全不透明，后 30% 线性淡出 */
const FADE_START = 0.7;

/** 池容量：24 = 丧尸上限 20 + 龙 4（可同时被击中的实体上限）。
 *  同一实体只显示最新数字（见文件头）⇒ 每个实体至多占一个槽，24 恰好全覆盖；
 *  真被耗尽时（未来实体类型扩容）复用**最老**的槽位。 */
const POOL_SIZE = 24;

/**
 * 浮动数字行的 z-index。
 *
 * ⚠️ 改这里必须重核 AGENTS.md「UI 层级」那条不等式：
 * … 坐标/性能面板 50 = 血心 50 < **伤害数字 55** < 设置按钮 60 < …
 * 高于看板（50）：数字可能飘到面板底色上方，不能被压住。
 * 低于设置按钮（60）与一切模态：它是瞬时反馈，不该挡任何交互。
 * **不得取 100+**（会盖掉 WebGPU 启动失败遮罩）。
 */
export const DAMAGE_NUMBER_Z_INDEX = 55;

/**
 * @typedef {{el: HTMLElement, anchor: Function, lastPos: number[]|null,
 *            startMs: number, active: boolean, entityId: string|null}} Slot
 */

export class DamageNumbers {
  /**
   * @param {HTMLElement} root HUD 容器（`#hud-root`）
   * @param {(worldPos: [number,number,number]) => [number,number]|null} projectFn
   *        世界坐标 → CSS 像素（左上原点）。相机背后 / 不可投影时返回 null。
   *        由装配层注入（本模块 three-free）。
   */
  constructor(root, projectFn) {
    if (typeof projectFn !== 'function') {
      throw new Error('DamageNumbers 需要注入 projectFn（世界坐标 → 屏幕坐标）');
    }
    this.projectFn = projectFn;

    this.el = document.createElement('div');
    this.el.id = 'mc-damage-numbers';
    this.el.style.cssText =
      `position:fixed;inset:0;z-index:${DAMAGE_NUMBER_Z_INDEX};` +
      'pointer-events:none;overflow:hidden;';

    /** @type {Slot[]} 常驻池（隐藏复用，不随数字增删 DOM 节点） */
    this._slots = [];
    for (let i = 0; i < POOL_SIZE; i += 1) {
      const el = document.createElement('div');
      el.style.cssText =
        'position:absolute;left:0;top:0;display:none;' +
        'font:bold 16px/1 monospace;color:#fff;' +
        'text-shadow:0 0 3px #000,0 0 3px #000,1px 1px 2px #000;' +
        'white-space:nowrap;will-change:transform,opacity;';
      this.el.appendChild(el);
      this._slots.push({ el, anchor: null, lastPos: null, startMs: 0, active: false, entityId: null });
    }
    root.appendChild(this.el);
  }

  /**
   * 弹出一个数字。
   *
   * ⚠️ **同一实体只显示最新数字**（用户 2026-11-05 追加：机枪连射时旧数字还没淡出
   * 就叠在一起）：`entityId` 非空且已有它的活跃数字时，**原地复用那个槽位**（换文本 +
   * 重置计时 + 更新锚点），旧数字直接消失 —— 任何时刻每个实体头顶至多一个数字。
   *
   * @param {string} text 显示文本（= 掉血后的剩余血量）
   * @param {() => [number,number,number]|null} anchorFn 头顶世界坐标锚点；
   *        实体已消失时返回 null（数字冻结在最后已知位置）
   * @param {[number,number,number]|null} initialPos 发射时刻的头顶世界坐标
   *        （致命一击时实体同帧 despawn，anchorFn 首次调用即为 null —— 用它兜底）
   * @param {number} nowMs `performance.now()` 基准时间戳
   * @param {string|null} [entityId] 实体 id；非空时启用「同实体顶替」语义
   */
  spawn(text, anchorFn, initialPos, nowMs, entityId = null) {
    let slot = null;
    if (entityId !== null) {
      for (const s of this._slots) {
        if (s.active && s.entityId === entityId) { slot = s; break; }
      }
    }
    if (!slot) slot = this._acquire();
    slot.entityId = entityId;
    slot.anchor = anchorFn;
    slot.lastPos = initialPos;
    slot.startMs = nowMs;
    slot.active = true;
    slot.el.textContent = text;
    // 「0」= 击杀：红色强化反馈；其余白色。仅此一个分支，不做更多颜色语义。
    slot.el.style.color = text === '0' ? '#ff5555' : '#fff';
    slot.el.style.display = 'block';
    // 首帧立即定位一次：避免先闪现在 (0,0) 再跳到正确位置
    this._place(slot, nowMs);
  }

  /**
   * 每帧调用：推进全部活跃数字（跟随 + 上浮 + 淡出 + 到期回收）。
   * 无活跃数字时也要遍历 `POOL_SIZE` 项，但每项只是一次布尔读 —— 与 hotbar 每帧 5 次
   * 字符串比较同量级，视为零成本；真正的投影/写 DOM 只发生在活跃槽上。
   * @param {number} nowMs
   */
  update(nowMs) {
    for (const slot of this._slots) {
      if (!slot.active) continue;
      const age = nowMs - slot.startMs;
      if (age >= DAMAGE_NUMBER_LIFE_MS) { this._release(slot); continue; }
      // 跟随：锚点活着就更新位置；消失（despawn）则冻结在 lastPos
      const pos = slot.anchor ? slot.anchor() : null;
      if (pos) slot.lastPos = pos;
      this._place(slot, nowMs);
    }
  }

  /** @returns {number} 当前活跃数字个数（只读测试接口） */
  activeCount() {
    let n = 0;
    for (const slot of this._slots) if (slot.active) n += 1;
    return n;
  }

  /**
   * 把单个数字落到屏幕：投影 + 上浮偏移 + 淡出。
   * @param {Slot} slot @param {number} nowMs
   */
  _place(slot, nowMs) {
    if (!slot.lastPos) { this._release(slot); return; }
    const screen = this.projectFn(slot.lastPos);
    if (!screen) {
      // 相机背后：隐藏但**不回收**（转回来还要继续显示剩余寿命）
      slot.el.style.display = 'none';
      return;
    }
    const t = (nowMs - slot.startMs) / DAMAGE_NUMBER_LIFE_MS;
    const rise = RISE_PX * t;
    const opacity = t < FADE_START ? 1 : 1 - (t - FADE_START) / (1 - FADE_START);
    const el = slot.el;
    if (el.style.display === 'none') el.style.display = 'block';
    // translate(-50%) 让数字以锚点为中心；整数像素取整避免亚像素抖动
    el.style.transform =
      `translate(${Math.round(screen[0])}px,${Math.round(screen[1] - rise)}px) translate(-50%,-100%)`;
    el.style.opacity = opacity.toFixed(2);
  }

  /**
   * 取一个槽位：优先空闲槽；全占用时复用**最老**的（`startMs` 最小）。
   * @returns {Slot}
   */
  _acquire() {
    let oldest = null;
    for (const slot of this._slots) {
      if (!slot.active) return slot;
      if (!oldest || slot.startMs < oldest.startMs) oldest = slot;
    }
    return oldest;
  }

  /** 回收槽位（隐藏 + 复位）。 */
  _release(slot) {
    slot.active = false;
    slot.anchor = null;
    slot.lastPos = null;
    slot.entityId = null;
    slot.el.style.display = 'none';
  }
}
