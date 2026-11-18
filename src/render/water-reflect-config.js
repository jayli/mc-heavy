// src/render/water-reflect-config.js — 水面倒影的标定常数与纯函数（**three-free**）
//
// 为什么单独成模块（与 `sun-shade.js` / `ocean-mask.js` / `shadow-manager.js` 同手法）：
//   ① 节流与门控是「改坏了肉眼玩不出来」的机制（倒影冻结在旧画面 / 白跑一次反射 pass），
//      必须落在可确定性单测的纯函数里；
//   ② `ocean.js` 依赖 three，浏览器单测里跑不动它；
//   ③ CPU 侧判据与 GPU 侧消费必须读同一份常量（红线 1）。
//
// ## 本模块只管「什么时候刷、刷多大、晃多少」，不管「怎么反射」
// 反射本身由 three 的 `reflector()` 节点实现（`ocean.js`）。这里提供的是它外围的
// 三个自由度：**刷新节奏**（成本主杠杆）、**分辨率倍率**（观感/显存）、**扰动幅度**（随波荡漾）。
//
// ## 实测依据（2026-11-18 调研，seed 12345 浅水高台西南岸机位）
//
// 提交耗时增量（连续同步 render 压测，绕开 vsync —— rAF 下 120fps 锁帧会把成本掩盖成 0）：
//
// | 配置 | vd8 | vd16 |
// |---|---|---|
// | 每帧刷 · RT 0.5 | +0.21ms | +0.93ms |
// | 每帧刷 · RT 0.25 | — | +0.86ms |
// | 每帧刷 · RT 0.125 | — | +0.83ms |
// | **每 2 帧刷 · RT 0.25** | **+0.12ms** | **+0.36ms** |
// | 每 3 帧刷 · RT 0.25 | — | +0.34ms |
//
// ⚠️ **降分辨率几乎不省钱**（0.125 与 0.5 只差 0.1ms）：成本在反射 pass 的 draw call
// 数量（vd16 实测 1546 次），不在像素数。⇒ **「朦胧」靠 mip 拿观感，「省钱」靠节流**。
// 把倍率往下压是无效优化，只会白白损失倒影形体。
//
// ⚠️ **扰动是免费的**：开/关三轮交替实测 `0 / −0.02 / +0.008 ms`（噪声内）。
// 它只是片元里多几次 sin + 一次 UV 加法，无新 pass / 无新纹理 / 无新采样。

/**
 * 反射 RT 相对 drawing buffer 的边长倍率。**0.70（用户 2026-11-18 指定）**。
 *
 * ⚠️ 它**不是性能旋钮**：实测 0.125 与 0.5 的提交耗时只差 0.1ms（成本在 draw call 数）。
 * 抬到 0.70 换来的是倒影形体更实（配合 mip 2 仍是朦胧的），代价主要是显存。
 * 省钱请用 `REFLECT_REFRESH_EVERY`。
 */
export const REFLECT_RESOLUTION_SCALE = 0.7;

/**
 * 倒影采样的 mip 级别 —— **朦胧感的唯一来源**。
 *
 * 用户口径是「朦胧地映照出地面物品，不用清晰度，要的是一个特效」。
 * 2 级 mip 把倒影糊成柔和色块（高台轮廓可辨、方块细节消失），正是该口径。
 * ⚠️ 不要靠压低 `REFLECT_RESOLUTION_SCALE` 来做朦胧 —— 那只让倒影变**锯齿**而不是变柔，
 * 且如上表所示省不到钱。
 */
export const REFLECT_MIP_LEVEL = 2;

/**
 * 刷新间隔（帧）。**成本主杠杆**。
 *
 * 取 2 = 60Hz 屏幕上 30Hz 刷新。倒影是低频信息（相机与世界都在动，但倒影的**内容**
 * 变化远慢于主画面），30Hz 足够；每 3 帧（20Hz）只再省 0.02ms，不值得多一档延迟。
 */
export const REFLECT_REFRESH_EVERY = 2;

/**
 * 倒影混合强度（0 = 完全不影响水面颜色，1 = 水面变成纯镜子）。
 *
 * 0.5 是「看得见倒影但水还是水」的交点：水面基色仍占一半，
 * 既有 Blinn-Phong 高光与雾色不受影响（它们在 mix 的左端里已经算完）。
 */
export const REFLECT_STRENGTH = 0.5;

/**
 * 倒影的**反射率乘数**（水面不是完美镜子）。
 *
 * ## 为什么必须有它（实测根因，v3.17）
 * 反射 RT 里占面积最大的是**天空**，而天空比水面亮得多。固定掩膜均值实测
 * （深海机位、五变量冻结、同一批 78794 个水体像素）：
 *   · 无倒影水面 luma **127.4**；
 *   · 纯倒影（strength=1）luma **185.9** —— 那就是天空的亮度。
 * ⇒ `mix(水色, 倒影, 0.5)` 必然把水面拉到 ≈155，**而这是物理上正确的**：
 * 真实水面反射亮天空时确实会变亮。但本仓的水色是用户四轮实玩标定出来的
 * （v1.82~v1.85：「不要泛白」），冻结断言钉在 luma ∈ (108,124)。
 *
 * ## 为什么不是「把强度调小」
 * 强度扇扫实测（同一批像素）：0.5→155.4 / 0.3→146 / 0.15→137.5 / 0.08→133 / 0→127.4。
 * 要回到 ≤124 得把强度压到几乎为 0 ⇒ **倒影也就没了**，与需求相背。
 *
 * ## 正解：水面吸收
 * 真实水面不是理想镜面：反射光要乘一个反射率，并被水色吸掉一部分。
 * 把倒影先乘 `REFLECT_TINT` 再与水色混 ⇒ 倒影仍是清楚的形体（高台/船/树），
 * 但不再把水面抬成白鏡 —— 这正好也是用户要的「朦胧映出地面物品」而不是「镜面」。
 *
 * ⚠️ **不得改冻结断言的阀值来就它**（AGENTS.md：冻结数字不符时停下来报告）。
 * 本常量是**新增的物理自自由度**，冻结断言逐字不动。
 * ⚠️ `REFLECT_TINT = 1` 时乘 1.0 逐位精确 ⇒ 可作单变量 A/B（回到理想镜面）。
 *
 * ## 标定值 0.26（实测扫描，四风格众数峰 luma；含「吸收随环境减弱」修正）
 * | TINT | morning | noon | dusk | night | 倒影判别力 |
 * |---|---|---|---|---|---|
 * | 0.18 | 102 ✗ | 110 | 94 | 73 | 0.485 |
 * | 0.22 | 102 ✗ | 113 | 94 | 73 | 0.450 |
 * | **0.26** | **110** | **113** | **99** | **73** | **0.407** |
 * | 0.30 | 113 | 113 | 101 | 73 | 0.405 |
 * 冻结带：morning/noon ∈ (108,124)、dusk ∈ (80,106)、night ∈ (70,100)。
 * ⇒ **0.26 是四风格全入带且判别力最大的一档**（0.30 也入带但 dusk 101 贴上界 106）。
 *
 * ## 吸收必须随环境亮度减弱（否则夜档永远出带）
 * 实测：固定吸收率时把 TINT 从 0.18 扫到 0.30，**night 恒在 65~69**（下界 70）
 * ⇒ 那不是参数大小问题，而是「反射 RT 已是夜景，再按白昼口径吸收一次」。
 * ⇒ `ocean.js` 里有效反射率 = `TINT + (1 − 均值waterTint) × (1 − TINT)`，上限 1。
 * 晨/午 waterTint 中性 1 ⇒ 回升项 0 ⇒ 本常量在那两档逐位生效。
 * 修正后 night 从 65 → **73**（入带），而晨/午读数不变。
 */
export const REFLECT_TINT = 0.26;

/**
 * 随波扰动幅度（UV 空间）。
 *
 * 实测（水区两帧变化占比，同一机位连拍三帧）：
 * | 幅度 | 变化占比 | 观感 |
 * |---|---|---|
 * | 0 | 0.54% | 倒影静止（只有节流跳变）|
 * | 0.01 | 3.82% | 轻微荡漾 |
 * | 0.02 | 9.25% | 明显随波晃动，形体仍可辨 |
 * | **0.024** | — | **现用（用户 2026-11-18 指定）**：比 0.02 再荡漾一档 |
 * | 0.04 | 19.85% | 晃得散开，倒影揉成色块 |
 *
 * 判别力锚点：冻结相位后 0 vs 0.02 的静帧水区像素差 **4.67%**（接线真生效）。
 */
export const REFLECT_DISTORT = 0.024;

/**
 * 扰动的远景衰减带（格）。`smoothstep(FAR, NEAR, dist)` —— 近处全额、远处归零。
 *
 * 远景倒影本来就被雾吃掉（`ocean.js` 的 fogNear=20 / fogFar=70），
 * 那里再晃只会变成一层无意义的高频噪声。
 */
export const REFLECT_DISTORT_NEAR = 20;
export const REFLECT_DISTORT_FAR = 70;

// ==================== 高度衰减（v3.17b） ====================
//
// 用户口径：「当玩家距离水面一定高度后，倒影应该越来越弱甚至消失……这样的效果
// 我感觉可能会更加拟真」。
//
// 这在物理上就是 **Fresnel 反射率**：水面对「掠射」（贴着水面看）几乎全反射，
// 对「垂直俯视」只反射 ~2%。相机升高 ⇒ 看同一片水的入射角变陡 ⇒ 倒影变弱。
// 故本项分两层实现，**两层职责不同、不得合并**：
//   ① **相机高度门**（本节）—— 全局标量，随飞行高度整体淡出；
//      它同时是 **性能门**：淡到 0 时整个反射 pass 直接不跑（成本归零）。
//   ② **逐片元掠射项**（`REFLECT_GRAZE`）—— 同一帧内近处弱、远处强，
//      给出水面自带的渐变（它不能当性能门：远处仍可能有强倒影）。

/**
 * 倒影满强度的高度上限（格，相对水面）。
 *
 * 取 16：岸上站着眼高 ≈ 4 格、调研机位（y=12）≈ 13.5 格 —— 那些已验收的观感
 * 必须落在满强度区内（否则等于偷偷削弱了用户认可的效果）。
 */
export const REFLECT_HEIGHT_FULL = 16;

/**
 * 倒影归零的高度（格，相对水面）。**超过它整个反射 pass 不跑**。
 *
 * 取 48：创造模式飞到这个高度时水面已是远处一块蓝，倒影本来就分辨不出；
 * 而飞行探图是常态操作 ⇒ 这道门把「飞在空中」这个常见场景的倒影成本直接归零。
 */
export const REFLECT_HEIGHT_ZERO = 48;

/**
 * 掠射（视角）项的影响权重 0~1。
 *
 * `grazeTerm = mix(1 − REFLECT_GRAZE, 1, fresnel)`，其中 fresnel 是水面**已在算**的
 * 那一项（`pow(1 − dot(up, viewDir), 3)`）—— 复用而不是新写一份（红线 1）。
 *
 * ⚠️ **必须留地板，不能直乘 fresnel**：垂直俯视时 fresnel → 0，直乘会让脚下水面的
 * 倒影**完全消失** —— 而用户要的是「朦胧映出地面物品」，不是「低头就没了」。
 * 0.45 ⇒ 地板 0.55：俯视仍有一半倒影，掠射时满强度。
 * ⚠️ `REFLECT_GRAZE = 0` 时 grazeTerm ≡ 1（逐位零回归，可作单变量 A/B）。
 */
export const REFLECT_GRAZE = 0.45;

/**
 * 相机高度 → 倒影强度衰减因子（1 = 满强度，0 = 完全消失）。
 *
 * 与 GPU 侧 `1 − smoothstep(full, zero, h)` 同构（红线 1：两边读同一对常量）。
 * 它是 **反射 pass 的性能门**：返回 0 时调用方必须整个跳过 pass。
 *
 * ⚠️ **入参是「相机高度」而不是脚底高度**：与水下判据同一口径
 * （`player.js` 的 `camY = p.y + EYE_HEIGHT`）。用脚底会差 1.62 格，在阈值附近判反。
 * ⚠️ **相机在水面之下时返回 0**（水下看不到倒影）—— 与 `reflectVisible` 同口径，
 * 但两处都要判：那是几何门，这是强度门，缺一不可（只改一处会留下「水下白跑 pass」）。
 *
 * @param {number} cameraY 相机世界高度
 * @param {number} waterY 水面世界高度
 * @param {number} [full=REFLECT_HEIGHT_FULL] 满强度高度上限
 * @param {number} [zero=REFLECT_HEIGHT_ZERO] 归零高度
 * @returns {number} 0~1
 */
export function reflectHeightFade(cameraY, waterY, full = REFLECT_HEIGHT_FULL, zero = REFLECT_HEIGHT_ZERO) {
  if (!Number.isFinite(cameraY) || !Number.isFinite(waterY)) return 0;
  const h = cameraY - waterY;
  if (!(h > 0)) return 0;                 // 水下 / 共面：无倒影
  if (!(zero > full)) return h <= full ? 1 : 0;   // 非法区间退化为阶跃（不产 NaN）
  if (h <= full) return 1;
  if (h >= zero) return 0;
  const t = (h - full) / (zero - full);
  return 1 - t * t * (3 - 2 * t);         // 1 − smoothstep
}

/**
 * 反射相机的最远可见距离相对主相机的收缩系数。
 *
 * ⚠️ **这是「省 draw call」的正确旋钮**（不是分辨率）：反射 pass 的成本正比于
 * 它视锥内的 section 数。倒影只在水面近处可见（水面自身 80 格外就淡出了，
 * 见 `ocean.js` 的 `WATER_VISIBLE_DISTANCE`），所以反射相机不需要看到主相机那么远。
 *
 * 取 1.0 = 不收缩（零行为改变的安全默认）。真要压成本时下调它，
 * 但必须同步重测倒影边缘有没有「远处的山在水里缺一截」。
 */
export const REFLECT_FAR_SCALE = 1.0;

/**
 * 节流器：决定「本帧是否真的重渲倒影」。
 *
 * 与 `ShadowScheduler` 刻意不同 —— 那个按 **毫秒** 节流（阴影刷新由事件驱动，
 * 请求可能不来），这个按 **帧** 节流（倒影每帧都想刷，只是我们不让）。
 * 按帧而不是按毫秒的理由：倒影的延迟观感单位是「帧」，而 60Hz / 120Hz 屏幕上
 * 同一个毫秒间隔对应的帧数不同（120Hz 下 33ms = 4 帧，延迟翻倍且白省不到 GPU）。
 */
export class ReflectScheduler {
  /**
   * @param {Object} [opts]
   * @param {number} [opts.every=REFLECT_REFRESH_EVERY] 每 N 帧刷一次（≥1）
   */
  constructor({ every = REFLECT_REFRESH_EVERY } = {}) {
    this.every = normalizeEvery(every);
    /** 已计数的帧数（只增；取模判刷新，不存余数避免漂移） */
    this._frame = 0;
    /** 实际刷新次数（测试与诊断用） */
    this.refreshes = 0;
    /** 上一次真正刷新时的帧号（-1 = 从未刷过） */
    this._lastRefreshFrame = -1;
  }

  /**
   * 推进一帧并回答「本帧是否应刷新倒影」。
   *
   * ⚠️ **首帧恒放行**：否则启动后第一帧水面采到的是空 RT（纯黑倒影），
   * 而计数类判据全对 —— 典型的静默失效。
   *
   * ⚠️ `visible=false` 时**不推进计数**：水面不在视野里的那段时间不该消耗节流配额，
   * 否则玩家一低头看到的可能是「上一次抬头时的旧倒影」再等一帧才更新。
   *
   * @param {boolean} visible 水面本帧是否可能被看到（调用方用 `reflectVisible()` 判）
   * @returns {boolean}
   */
  tick(visible) {
    if (!visible) return false;
    this._frame++;
    if (this._lastRefreshFrame < 0) {
      this._lastRefreshFrame = this._frame;
      this.refreshes++;
      return true;
    }
    if (this._frame - this._lastRefreshFrame < this.every) return false;
    this._lastRefreshFrame = this._frame;
    this.refreshes++;
    return true;
  }

  /** 改档（面板/URL）。立即生效，下一帧按新节奏判。 */
  setEvery(every) { this.every = normalizeEvery(every); }

  /** 强制下一帧刷新（瞬移 / 切风格 / 改分辨率后用，避免留一帧旧倒影） */
  invalidate() { this._lastRefreshFrame = -1; }
}

/** 帧间隔归一化：非法/小于 1 一律回落 1（每帧刷），不抛异常。 */
export function normalizeEvery(v) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

/**
 * 水面本帧是否可能被看到 —— **反射 pass 的唯一门控判据**。
 *
 * 两条独立条件，任一不满足就跳过整个反射 pass（成本归零，实测只剩 1 次清屏 draw）：
 *   ① 相机在水面**之上**：水下时水面是头顶的一层膜，倒影朝下看不见；
 *   ② 相机**朝下看**（视线与水平面夹角向下）：抬头看天时水面不在视锥内。
 *
 * ⚠️ **不能用「水面 mesh 的包围球是否在视锥内」判**：水面是 800×800 的巨平面且
 * 每帧跟随相机，它的包围球**永远**与视锥相交 ⇒ 判据恒真、门控形同虚设
 * （实测 gateSkip 恒 0）。必须用「相机高度 + 俯仰」这两个真实自由度。
 *
 * ⚠️ **俯仰阈值取 0 而不是留余量**：水平视线时水面恰好铺满下半屏（透视投影下
 * 无限平面延伸到地平线），此时倒影仍然可见。留正余量会让「平视海面」这个
 * 最常见的机位丢掉倒影。
 *
 * @param {number} cameraY 相机世界高度
 * @param {number} waterY 水面世界高度（`WATER_LEVEL_OFFSET`）
 * @param {number} forwardY 相机前向向量的 y 分量（已归一化；>0 = 抬头）
 * @param {number} [halfFovRad] 垂直半视场角（弧度）—— 抬头时视野下缘仍可能扫到水面
 * @returns {boolean}
 */
export function reflectVisible(cameraY, waterY, forwardY, halfFovRad = 0.61) {
  if (!Number.isFinite(cameraY) || !Number.isFinite(forwardY)) return false;
  // 相机在水面之下：倒影不可见（水面从下方看是膜，reflect 方向朝地下）
  if (cameraY <= waterY) return false;
  // 视线仰角超过「半视场角」时，整个视锥都在水平面之上 → 水面一格也扫不到。
  // forwardY = sin(仰角)，故判据是 forwardY > sin(halfFov)。
  return forwardY <= Math.sin(halfFovRad);
}

/**
 * 扰动幅度按距离衰减（GPU 侧 `smoothstep(FAR, NEAR, dist)` 的 CPU 同构参考实现）。
 * 单测用它钉「近处全额 / 远处归零 / 中间单调」，避免 TSL 那边写反 smoothstep 的两个边界。
 *
 * @param {number} dist 片元到相机的水平距离（格）
 * @param {number} [amount=REFLECT_DISTORT] 基准幅度
 * @returns {number}
 */
export function reflectDistortAt(dist, amount = REFLECT_DISTORT) {
  const near = REFLECT_DISTORT_NEAR, far = REFLECT_DISTORT_FAR;
  if (!(dist > near)) return amount;
  if (dist >= far) return 0;
  const t = (dist - near) / (far - near);
  // smoothstep 的标准式（与 GLSL/WGSL 同定义）：3t²−2t³，方向由上面的早退决定
  const s = t * t * (3 - 2 * t);
  return amount * (1 - s);
}