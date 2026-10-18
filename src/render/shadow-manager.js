// src/render/shadow-manager.js — 太阳阴影刷新节流 + 光源定位纯函数（无 DOM/three 依赖）
// mc-lite `World.requestShadowMapUpdate`（World.js:227-250）的 200ms 最小间隔 + `pendingShadowUpdate`
// 补刷同构：请求只挂起，由帧循环调 tick() 决定「本帧是否真的刷新」。
// ⚠️ 刷新口径是 **per-light**（WebGPU 后端经 `light.shadow.needsUpdate` 生效，spec DR-5）——
// 不是 mc-lite WebGL 的 `renderer.shadowMap.autoUpdate`，后者在本后端不生效。
//
// v1.47 新增两个纯函数（`sunDirectionChanged` / `texelSnapOffset`）：前者门控日夜循环下
// 每帧无谓的光源重定位，后者消除「阴影随玩家移动微微晃动」。两者都是纯数学、无 three 依赖
// → 确定性单测（`src/tests/test-shadow-manager.js`）。放本模块而非 game.js 的理由：
// game.js 是装配层（不可单测），而这两条是「改坏了肉眼玩不出来」的机制（方向漂移会让枪的
// PBR 高光错位、纹素错位会让影子抖动），必须落在可单测的纯函数里。

/**
 * 阴影刷新节流器：调用方在触发点调 `request()`，每帧调 `tick(nowMs)` 取刷新许可。
 *
 * 时钟由调用方传入（`performance.now()` 基准），故本类是确定性纯逻辑，可直接单测。
 */
export class ShadowScheduler {
  /**
   * @param {Object} [opts]
   * @param {number} [opts.minIntervalMs=200] 两次刷新最小间隔（mc-lite 原值 200ms）
   */
  constructor({ minIntervalMs = 200 } = {}) {
    this.minIntervalMs = minIntervalMs;
    this._lastFlushAt = -Infinity;
    this._pending = false;
  }

  /** 挂起一次刷新请求（节流期内不会丢，等窗口过后补刷一次） */
  request() {
    this._pending = true;
  }

  /**
   * 本帧是否应真正刷新阴影贴图。
   * @param {number} nowMs performance.now() 基准时刻
   * @returns {boolean} true = 应刷新（已消费 pending 并记录时刻）
   */
  tick(nowMs) {
    if (!this._pending) return false;
    if (nowMs - this._lastFlushAt < this.minIntervalMs) return false;
    this._pending = false;
    this._lastFlushAt = nowMs;
    return true;
  }
}

/**
 * 太阳方向变化的门控阈值（度）。**单一权威**（红线 1）：消费点不得写字面量。
 *
 * 取值依据：日夜循环 1200s/天 → 太阳 0.3°/秒。阈值 0.5° ≈ **1.67 秒一次 = 0.6Hz**
 * （相对门控前的每帧触发是 8× 降幅；相对 200ms 节流是 3.3× 降幅）。
 * 误差量级：3 格石柱的影子尖端偏 `3×tan(0.5°) ≈ 0.026` 格（不可见）；视锥边缘 30 格处
 * 偏 `30×tan(0.5°) ≈ 0.26` 格 ≈ 1.1 纹素，但那是**静态偏移**而非抖动，且位于阴影覆盖最边缘。
 * 附带收益：`KEYFRAMES` 的 noon 平台段（hour 9~17，占一天 1/3）方向恒定 → 该时段零方向驱动刷新。
 */
export const SUN_DIR_GATE_DEG = 0.5;

/**
 * 太阳方向是否变化到需要重定位光源 + 请求阴影刷新。
 *
 * 背景：日夜循环下 `DayNight.update()` 每帧 `_apply` → `onSunDirection` 每帧触发，而太阳每帧
 * 只转 0.0025°（在 256² 贴图上完全不可见）→ 绝大部分重定位是白做的。
 *
 * ⚠️ 本函数消除的是「重定位路径上的额外 `params` 读取」：门控前每帧 2 次（门控自己 +
 * `_updateSunPosition()` 各读一次 `dayNight.params`，而 `get params()` 每次调用新分配 2 个
 * 小对象）→ 门控后约 0.6Hz 各 1 次。`DayNight._apply` 自身的每帧分配不在本门控范围内。
 * ⚠️ **消费方必须传回调入参 `dir`（DayNight 已算好的同值），不得读 `dayNight.params`** ——
 * 否则被门控掉的帧仍每帧分配，白做一半（初版实测踩坑）。
 *
 * 判据用**点积 vs cos(阈值)**（不用角度反三角）：省一次 `acos`，且单调等价。
 * @param {[number,number,number]|null} lastDir 上次放行的方向（null/undefined = 首次，恒通过）
 * @param {[number,number,number]} dir 当前方向（须已归一化；调用方 `DayNight` 传的就是
 *   `normalizeDirection(p.sunDirection)`）
 * @param {number} thresholdDeg 阈值（度）
 * @returns {boolean} true = 应重定位并请求刷新
 */
export function sunDirectionChanged(lastDir, dir, thresholdDeg) {
  // 首次恒通过：否则启动时阴影相机不定位（`_lastShadowPos` 初值 (0,0,0) 的移动阈值路径
  // 虽也会触发一次，但 override 风格下日夜回调是唯一的定位源 → 不能依赖那条）。
  if (!lastDir) return true;
  const cosThreshold = Math.cos((thresholdDeg * Math.PI) / 180);
  const d = lastDir[0] * dir[0] + lastDir[1] * dir[1] + lastDir[2] * dir[2];
  // 点积 < cos(阈值) ⟺ 夹角 > 阈值（两向量均单位长，点积 = cos 夹角，在 [0,π] 单调递减）
  return d < cosThreshold;
}

/**
 * 把阴影相机中心吸附到贴图像素（纹素）边界所需的世界空间偏移。
 *
 * **治的是「阴影随玩家移动微微晃动」**：阴影相机正交 ±30 覆盖 60 格、贴图 256² → 每纹素
 * ≈ 0.234 格。光源跟随玩家连续移动时，世界相对纹素网格每次重渲错位一个**分数**纹素
 * → 所有影子边缘跳动最多半纹素 ≈ 0.1 格（用户实玩可察觉）。吸附后网格只按整纹素步进
 * → 影子边缘稳定不动。这是业界标准解法（texel snapping / stable shadow mapping）。
 *
 * ⚠️ **两条载荷性不变式**（单测钉住）：
 * ① `center + 偏移` 在相机 X/Y 轴上的投影都是 `texelSize` 的整数倍（偏移本身是「到最近
 *    网格线的余量」，一般不是整数倍 —— 断言落在吸附结果上，不是偏移上）；
 * ② 偏移**垂直于 sunDir** —— 因为 `DirectionalLight` 对着色只生效「方向 = position − target」，
 *    而枪的 PBR 高光依赖它跟随日夜。消费方必须把同一偏移**同时**加到 position 与 target
 *    （两者之差平行于相机 Z 轴 → 加同一向量方向严格不变）；只加一个会改方向 → 高光漂移。
 *
 * 相机基与 three `lookAt` 同口径：相机 -Z 朝向 target，而光源在 target + sunDir×60
 * → 相机 Z 轴 = sunDir；X 轴 = normalize(cross(worldUp, Z))；Y 轴 = cross(Z, X)。
 *
 * @param {[number,number,number]} center 阴影相机要对准的世界点（= 玩家位置）
 * @param {[number,number,number]} sunDir 太阳方向（须已归一化）
 * @param {number} texelSize 一个纹素的世界尺寸 = (camera.right − camera.left) / mapSize.width
 * @returns {[number,number,number]} 世界空间偏移（加到 position 与 target 两侧）
 */
export function texelSnapOffset(center, sunDir, texelSize) {
  // 防御：texelSize 非正会让 round 除零/反向 → 退化为不对齐（不崩、不产 NaN）
  if (!(texelSize > 0)) return [0, 0, 0];
  const zl = Math.sqrt(sunDir[0] * sunDir[0] + sunDir[1] * sunDir[1] + sunDir[2] * sunDir[2]);
  if (!(zl > 0)) return [0, 0, 0];
  const zx = sunDir[0] / zl, zy = sunDir[1] / zl, zz = sunDir[2] / zl;
  // X 轴 = normalize(cross(worldUp=[0,1,0], Z))；worldUp 的 x/z 分量为 0 → 展开后只剩两项
  let xx = zz;
  let xy = 0;
  let xz = -zx;
  const xl = Math.sqrt(xx * xx + xz * xz);
  // 退化：sunDir 平行 worldUp（正午头顶直射）→ cross 为零向量，无稳定 X 轴 → 不对齐。
  // 本仓三组 VISUAL_STYLES.sunDirection 的 y 分量均 < 1，不会走到这里，但纯函数须自守。
  if (!(xl > 1e-9)) return [0, 0, 0];
  xx /= xl; xz /= xl;
  // Y 轴 = cross(Z, X)（Z、X 已单位正交 → 结果自动单位长）
  const yx = zy * xz - zz * xy;
  const yy = zz * xx - zx * xz;
  const yz = zx * xy - zy * xx;
  // center 在相机 X/Y 轴上的投影 → 各自 round 到纹素整数倍 → 偏移 = 基向量的加权和
  const u = center[0] * xx + center[2] * xz;   // xy 恒 0，省一次乘加
  const v = center[0] * yx + center[1] * yy + center[2] * yz;
  const du = Math.round(u / texelSize) * texelSize - u;
  const dv = Math.round(v / texelSize) * texelSize - v;
  return [
    xx * du + yx * dv,
    xy * du + yy * dv,
    xz * du + yz * dv,
  ];
}
