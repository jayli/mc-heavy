// src/render/daynight.js — 日夜循环 + 三种视觉风格（M2-6，参数移植 mc-lite Engine.js visualStyles）
// 时间 uniform 驱动（0-24h 周期，关键帧线性插值 → 平滑无跳变）；
// 风格切换 setStyle(key) 固定参数（M3 设置面板接入），setStyle(null) 恢复循环。
// 黑夜：uSkyDim 压暗 skylight + uBlockBoost 相对增强 blocklight（§7 M2-6 口径）。
// 不依赖 three（颜色用整数 hex 手工插值；.set(hex) 由调用方 Color/uniform 接受）。

export const VISUAL_STYLE_KEYS = { MORNING: 'morning', NOON: 'noon', DUSK: 'dusk', NIGHT: 'night' };

/** 中性色温（相对乘数，全 1 = 不改变颜色）；与 `sun-shade.js` 的 `NEUTRAL_LIGHT_COLOR` 同语义。 */
const NEUTRAL_COLOR = Object.freeze([1, 1, 1]);

/**
 * 水面环境亮度乘数的中性值（全 1 = 不压暗）。
 *
 * 语义与 `NEUTRAL_COLOR` 同为「相对乘数」，但它只作用于**海面平面**（`ocean.js` 的
 * `uWaterTint`），不作用于体素世界：
 *
 * **为什么需要它**（v2.1，2026-10-31 用户实玩反馈「傍晚和晚上的水面波纹过于亮，
 * 晚上看上去像水面会发光」）：`ocean.js` 是 unlit 材质，原本**不接任何环境亮度**；
 * 而 dusk/night 的 `toneMappingExposure` 是 1.20 / 1.60（为体素世界暗部补光）
 * → 水面跟着被提亮。实测水面 luma：morning/noon **116** → dusk **131** → night **147**，
 * 也就是「水面亮度几乎正比于曝光」，而且夜里它与被 `skyDim 0.25` 压暗的体素水反向撕裂。
 *
 * ⚠️ **晨/午恒为中性**（用户明确「早晨和正午的水面波纹颜色没问题」）→ 零回归。
 * ⚠️ **只调亮度、不改色相**：三通道给同一个值。用户要的是「调暗一些」，不是变色；
 * 分通道会给出一份没有观感收益的额外自由度（而且很容易漂成夜里水发紫）。
 */
const NEUTRAL_WATER_TINT = Object.freeze([1, 1, 1]);

/**
 * 太阳方向光（`DirectionalLight`）的**基准颜色** —— 唯一权威，`game.js` 建灯与
 * `_apply` 按色温重算都从这里取（两处各写一份字面量会漂移出「白天灯色对、傍晚灯色不跟」）。
 *
 * 来源 = mc-lite `Engine.js:168` 的 `0xfffaf0`（本仓自 M4 用至今）。
 * 色温乘数全 1 时乘出来逐位等于原基准色 → 其余三风格零回归。
 */
export const SUN_LIGHT_BASE_RGB = Object.freeze([0xff / 255, 0xfa / 255, 0xf0 / 255]);

/**
 * 同一基准色的整数 hex 形式 —— `new THREE.DirectionalLight(color, intensity)` **只接受
 * 一个颜色参数**（多传的分量会被当成 intensity），所以建灯时用这个 hex。
 * 与上面的 RGB 数组从**同一个原值**派生（两边一起改时单测钉住逐位相等）。
 */
export const SUN_LIGHT_BASE_HEX = (0xff << 16) | (0xfa << 8) | 0xf0;

/**
 * 四种视觉风格（morning / noon / dusk / night；既有三种移植 mc-lite `Engine.js` 的参数，
 * dusk 是 v1.71 新增、由 mc-lite `skyBox2`（日落）贴图反推标定出来）。
 * sunDirection 为 **mc-lite Engine.js:74/99/122 原值（未归一化）**（dusk 除外 —— 它没有上游值）；
 * 唯一权威是这里；paramsAtHour 与 _apply 在消费前归一化（见 normalizeDirection），
 * 调用方不得用原值做长度换算。
 *
 * ⚠️ **`duskBlend` 是「天空盒要不要用黄昏那套」的开关**：只有 dusk 是 1、其余全是 0。
 * 自动日夜循环的关键帧只引用 morning/noon/night（见 `KEYFRAMES`）→ 循环里 duskBlend 恒为 0
 * （「傍晚」是纯手动风格，不会混进循环）。这是本次改动最重要的不变式，单测钉死。
 *
 * ⚠️ **`sunColor` / `ambientColor` 是色温乘数，不是绝对颜色**：只改色相、不改总曝光。
 * morning / noon 全是 `[1,1,1]`（中性）；dusk / night 有各自标定值
 * （均值分别 1.0333 / 1.0600，见各风格字段注释）。
 *
 * ⚠️ **`moonDirection` 与 `sunDirection` 的关系（v3.00）**
 *
 * 初版裁定「把月亮搬到光照方向那侧」（四风格 moonDirection ≡ sunDirection）。用户 2026-11-14
 * 实玩后：「月亮高度太低，月亮的方位不变，光源也不变，高度调高一些」⇒ 改成：
 *
 *   · **`sunDirection` 一个字节不动**（「光源也不变」）—— 阴影灯定位、枪 PBR 高光、
 *     以及 sun-shadow / hemisphere-ambient / dusk-style 三个 spec 的接线口径全部不受影响；
 *   · 只有 **night 的 `moonDirection`** 抬高：**方位 = `sunDirection` 的方位**（+4.7636°，
 *     「方位不变」），**仰角 = 35.4241°**（mc-lite 原 `night.moonDirection` 的仰角）；
 *   · morning/noon/dusk 的 `moonDirection` 是 mc-lite 原值（它们的 `moonVisible` 本是 false）。
 *
 * 于是夜里月亮站在 35.4°、光从 14.55° 来（同方位、仰角差 20.85°）：月亮看得更高，
 * 而地面明暗与影子方向**完全不变**（影子仍由 `sunDirection` 驱动）。
 *
 * ⚠️ **必须两份字面量都写**（而非在定义后循环派生）：`VISUAL_STYLES` 是纯数据表，
 * 派生赋值会让「表里写的值」与「实际生效的值」不一致。代价是一行改漏就漂移 ——
 * 由 `src/tests/test-moonlight.js` 的仰角/方位断言立即拓住（不是靠注释约定）。
 */
export const VISUAL_STYLES = {
  morning: {
    sky: 0xb7c6f7, fogColor: 0xb7c6f7, fogScale: 1.0, skyDim: 0.8, blockBoost: 1.0,
    sunDirection: [0.18, 0.45, 0.88],
    // ACES 曝光（v1.70）：**1.00，与 noon 同档**。
    // ⚠️ mc-lite 的 morning 是 1.35，但**照搬它会抹掉晨昏感**：morning 的 `skyDim = 0.8`
    // 本来就要比 noon 暗一档（同曝光下实测 |morning−noon| = **0.0609**），而 1.35 的曝光
    // 恰好把它提亮回 noon 水平（实测差值塌到 **0.0036**，低于「晨与午必须可见不同」的
    // 0.01 门槛）。mc-lite 用 1.35 是因为它还有 `colorBrightness 1.06` 与暖色相补偿，
    // 本仓不移植那层 CSS 分级（用户要「真实感」而非「鲜艳」）。
    // 晨昏感由**既有数据**提供：skyDim 0.8 + 晨光天空色 0xb7c6f7 —— 不靠曝光重复表达。
    toneMappingExposure: 1.0,
    // 月亮方向 / 可见性 / 尺寸：mc-lite Engine.js:75,109,111 原值（未归一化，消费前统一归一化）
    // 月亮方向（v3.00）：**方位 = 本风格 sunDirection 的方位，仰角统一 35.4241°**
    // （mc-lite 原 night 月亮的仰角）。moonVisible=false ⇒ 不可见，但仍要与 night 同方位 ——
    // 否则 19→21 / 5→7 的插值段会抳出天顶弧（实测仰角 73.12°、方位单步跳 65°）。
    moonDirection: [0.1633, 0.579624, 0.798354], moonVisible: false, moonSize: 20,
    // 色温中性 + 不用黄昏天空盒（零回归锚点：着色器逐位回到 v1.70）
    sunColor: NEUTRAL_COLOR, ambientColor: NEUTRAL_COLOR, duskBlend: 0,
    // 水面亮度：早晨用户明确说「没问题」→ 中性（零回归）
    waterTint: NEUTRAL_WATER_TINT,
  },
  noon: {
    sky: 0x87ceeb, fogColor: 0x87ceeb, fogScale: 1.0, skyDim: 1.0, blockBoost: 1.0,
    sunDirection: [0, 0.8, 0.6],
    // ACES 曝光（v1.70）：**本仓实测最优 1.0，不是 mc-lite 的 1.25**。
    // 实测（同一机位、同一几何，只改 exposure）：0.9 → 暗部 p5=40 / 1.0 → p5=44、天空细节完整 /
    // 1.25 → p5=53 但**天空被冲到接近纯白、云层细节丢失**。
    // mc-lite 用 1.25 是因为它的体素材质是受光的 `MeshStandardNodeMaterial`（光照强度基准
    // 与本仓 unlit 管线不同）—— 照搬上游参数前须检查它是否在补偿另一个差异（v1.45 的
    // `shadow.radius` 同教训）。
    toneMappingExposure: 1.0,
    // 月亮方向（v3.00）：方位 0°（本风格太阳在 +Z 正南）、仰角 35.4241°，不可见
    moonDirection: [0, 0.579624, 0.814884], moonVisible: false, moonSize: 18,
    sunColor: NEUTRAL_COLOR, ambientColor: NEUTRAL_COLOR, duskBlend: 0,
    // 水面亮度：正午是用户裁定的基准态（「正午的水面波纹颜色没问题」）→ 必须中性
    waterTint: NEUTRAL_WATER_TINT,
  },
  /**
   * 傍晚（v1.71）—— 天空盒 = mc-lite `skyBox2`（日落）。
   *
   * 参数不是拍脑袋，而是**从那张贴图反推**（Tier 4 探针实测；探针先拿 day 贴图自校准：
   * 已知正午 N·L 方向是 azim 0°/elev 47°，探针也能测出来 → 口径成立）：
   *   · 贴图里的太阳在 **azim ≈ +44°、elev ≈ 5.5°**
   *     （three 的背景采样对 x 轴镜像：落盘在 negx 右边缘 + posz 左边缘 → 渲染到 +X/+Z 象限）
   *   · 地平线带暖灰 `0x94857b`、天顶灰蓝紫 `0x676b7f`、暖云峰 `(249,224,136)`
   *   · 整立方图亮度只有白天天空盒的 **0.643**
   *   · 12 条共享边接缝 RMS 0.59 / 面内噪声底 0.33 → 比值 1.80（白天基准 1.765）⇒ 本身无缝
   *
   * 两个标定取舍（用户 2026-10-24 拍板）：
   * ① **太阳仰角抬到 12°**（贴图是 5.5°）。5.5° 时地面只剩一半亮度、8 格树投影 83 格，赶路时
   *    地面偏暗；12° 是「可辨认的傍晚」：影子仍很长（8 格树 ≈ 37 格），而方位角**不动**
   *    （地平线那轮暖日仍在贴图里的位置）。
   * ② **色温分开给**（新增两个 uniform）：直射暖橙、环境冷蓝紫（对应灰蓝天顶）。两者都是
   *    均值 ≈1 的**相对乘数** → 只换色相，不改总曝光。
   *
   * `skyDim 0.78` / `toneMappingExposure 1.20`：实测口径（sRGB + ACES，基色 0.5 中间灰，同机位）：
   *   迎光面 `209,198,188`（lum 199.6 / R−B **+21**）、顶面 `169,163,167`（lum 164.6）
   *   影面 `129,135,153`（lum 135.0 / R−B **−24**）
   *   → 相对正午：顶面亮度 **0.80**、影面 **0.93**（傍晚该暗一档但地面仍可辨认）
   * 标定口径：`skyDim` 控「地面亮度」、`toneMappingExposure` 控「ACES 暗部不要死黑」，
   * 两者都调会双重生效 —— 先定 skyDim（亮度档位）再补曝光（暗部可读性）。
   */
  dusk: {
    // sky/fogColor：天空盒**加载失败**时的降级纯色。sky = 贴图天顶与地平线的中间调；
    // fogColor 取偏暖的地平线色（远处方块该淡入那轮落日附近的天色）。
    sky: 0x8890a6, fogColor: 0xa8897a, fogScale: 1.0, skyDim: 0.78, blockBoost: 1.15,
    // 显式指定夜空混合 = 0：傍晚的天空由 dusk 立方图接管，不该再叠星空
    // （不写的话 nightBlendOf 会从 skyDim 0.78 倒算出 0.293 → 天空混入 30% 星空，实测拉冷）。
    nightBlend: 0,
    // elev 12° / azim +44°（见上）；写法与既有风格一致（未归一化，消费前统一归一化）
    sunDirection: [0.665, 0.208, 0.688],
    // ACES 曝光 1.20：v1.70 给 night 1.6 是因为 ACES 在低亮度区压缩最陡；傍晚远比夜亮，
    // 只需补到「暗部不死黑」（实测影面 lum 135 vs 正午 145）。
    toneMappingExposure: 1.20,
    // 贴图里没有月亮（落日前后天边不该有月亮）→ 与 morning/noon 同口径不画
    // 贴图里没有月亮（落日前后天边不该有月亮）→ moonVisible=false。
    // 方位 44.03°（= 本风格太阳方位）、仰角 35.4241°（v3.00 统一口径）。
    moonDirection: [0.566333, 0.579624, 0.585921], moonVisible: false, moonSize: 22,
    // 色温：直射暖橙（R 1.50 / G 1.02 / B 0.58，均值 1.033）、环境冷蓝紫（均值 0.997）
    sunColor: Object.freeze([1.50, 1.02, 0.58]),
    ambientColor: Object.freeze([0.86, 0.93, 1.20]),
    duskBlend: 1,
    // 水面亮度 **0.60**（v2.2）。标定口径（海岸机位 / 五变量冻结 / 水面众数峰 luma）。
    //
    // ⚠️ **v2.1 的 0.84 已作废**：那时 tint 乘在**雾混合之前**，而 `WATER_FOG_COLOR` 是固定常量、
    // `fogNear/far = 20/70` → 中远景海面根本不吃这个乘数，只压住了近处。用户 2026-10-28
    // 第二轮反馈「依然过于明亮」。v2.2 把 tint 移到雾混合之后重标，实测：
    // | tint | 远 0.55-0.65 | 0.65-0.75 | 0.75-0.85 | 近 0.85-0.96 |
    // |---|---|---|---|---|
    // | 0.70 | 147 | 115 | 107 | 104 |
    // | **0.60** | **132** | **107** | **101** | **96** ← 现用（用户裁定「中等」） |
    // | 0.55 | 130 | 100 | 94 | 92 |
    // 目标 = 近处 luma 95（正午基准 116，降 ≈18%），0.60 实测 96。
    // ⚠️ 这是**实测标定值**，不是从 exposure 反推的公式 —— ACES 在亮端压缩，
    // 线性乘数 → 屏幕亮度的映射不是线性的（同 `sun-shade.js` 的 sRGB 口径教训）。
    waterTint: Object.freeze([0.60, 0.60, 0.60]),
  },
  night: {
    // ⚠️ **`fogScale` 已从 mc-lite 的 4.0 改为 1.0**（v1.61，用户拍板）：4.0 会把雾距
    // 拉到 `(vd+2)*16*0.95*4`（vd=8 时 **608 格**），而世界径向只加载约 160 格 →
    // **视野内没有任何方块到达雾区** → 雾完全不可见，「雾色融入天空」在夜里无物可染
    // （实测开关切换的像素变化 **0.0%**，而把雾距改回正午口径后是 4.0% / 最大 184）。
    // mc-lite 用 4.0 是因为它的夜景需要把雾推到看不见来模拟“远处漆黑”，本仓有夜空
    // 贴图与星点，不需要这个代偿。雾色与天色一致时，远景观感反而更自然。
    sky: 0x050b1e, fogColor: 0x050b1e, fogScale: 1.0, skyDim: 0.25, blockBoost: 1.2,
    sunDirection: [0.08, 0.25, 0.96],
    // ACES 曝光（v1.70）：**1.6，比正午高（而 mc-lite 的 night 是 0.95）**。
    // ACES 的暗部压缩在低亮度区最陡，不补曝光就会把夜空与地面一起吃掉。实测（night 机位）：
    //   NoToneMapping → mean 48.1 / p5 16 / p95 78
    //   ACES 1.0     → mean 33.0 / p5  3 / p95 70  ← **过暗（p5=3 近乎死黑）**
    //   ACES 1.25    → mean 39.1 / p5  5 / p95 83  ← 仍偏暗
    //   ACES 1.6     → mean 47.0 / p5  7 / p95 99  ← **平均回到基线，动态范围 62→92**
    //   ACES 2.0     → mean 55.1 / p5 10 / p95 115 ← 偏亮发灰
    // 1.6 让夜间「平均亮度回到现状」却把动态范围拉开 —— 这正是「夜该暗，但不是糊成一片」。
    // mc-lite 用 0.95 是为了压暗，本仓用更高曝光达到「压暗暗部、保住亮部」的同一个**意图**。
    toneMappingExposure: 1.6,
    // 月亮方向（v3.00，用户 2026-11-14 二次裁定）：「方位不变、光源不变、高度调高」——
    // **方位 = sunDirection 的方位（+4.7636°）**，**仰角 35.4241°**（mc-lite 原 night 月亮值）。
    // ❗ `sunDirection` 一个字节未动 —— 影子方向与地面明暗完全不变，只有月轮 sprite 被抬高。
    // 改前两者同向（仰角 14.55°，月亮贴着地平线）；现在月亮高 20.85°、方位不变。
    moonDirection: [0.067672, 0.579624, 0.812069], moonVisible: true, moonSize: 34,
    // 月光色温（v3.00）：冷蓝直射 + 更冷的环境。**均值 1.0600，不是 1.0** ——
    // 均值恰为 1.000 的同色相候选实测六面平均 luma 97.14（−3.3%），因为 ACES 在迎光面
    // 已进肩部、B 通道压缩率高于 R/G。1.06 是「把肩部吃掉的亮度补回来」的标定值。
    // 屏幕口径实测（基色 0.5 × shade × skyDim 0.25 × 曝光 1.6 → ACES → sRGB）：
    // 六面平均 luma 100.50 → 100.84（+0.3%）、迎光面 R−B 0 → −32、背光面 0 → −15、
    // 迎光/背光比 1.91 → 1.87（朝向对比不得被抹平，守 ≥1.8）。
    sunColor: Object.freeze([0.795, 0.954, 1.431]),
    ambientColor: Object.freeze([0.954, 1.018, 1.208]),
    duskBlend: 0,
    // 水面亮度 **0.39**（v2.2）—— 四风格里最暗的一档。
    //
    // ⚠️ **v2.1 的 0.62 已作废**（那时 tint 乘在雾混合之前，远景海面恒定不吃乘数）。
    // v2.2 把 tint 移到雾混合之后重标，实测：
    // | tint | 远 0.55-0.65 | 0.65-0.75 | 0.75-0.85 | 近 0.85-0.96 |
    // |---|---|---|---|---|
    // | 0.46 | 132 | 101 | 95 | 94 |
    // | 0.42 | 124 | 95 | 93 | 87 |
    // | **0.39** | — | — | — | **≈82** ← 现用（用户裁定「中等」） |
    // | 0.38 | 116 | 92 | 85 | 79 |
    // 目标 = 近处 luma 82（正午基准 116，降 ≈29%）。
    // ⚠️ 下界留着：再往下压会把波纹明暗差抹平（水面变一潭墨），Tier 4 会钉像素下界。
    // 关键对照：修前远景带 **182**（比正午 156 还亮）才是「像发光」的主因；现在远景 116 已低于正午。
    waterTint: Object.freeze([0.39, 0.39, 0.39]),
  },
};

// 日夜关键帧（小时 → 风格参数线性插值）：夜→晨→午→晨(暖)→夜
const KEYFRAMES = [
  [0, 'night'], [5, 'night'], [7, 'morning'], [9, 'noon'],
  [17, 'noon'], [19, 'morning'], [21, 'night'], [24, 'night'],
];

function lerpHex(a, b, t) {
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return (r << 16) | (g << 8) | bl;
}

/**
 * 方向归一化（手工 Math.sqrt —— 本文件不依赖 three，故不用 Vector3.normalize）。
 * 不判零长度：三组原值的 y 分量均 > 0，而插值是三个向量的凸组合 → 结果 y 必 > 0，
 * 长度恒非零（新增风格数据若破坏该前提，须在 VISUAL_STYLES 处一并评估）。
 * 始终返回新数组，绝不原地改写入参（入参可能是 VISUAL_STYLES 的权威数组）。
 */
function normalizeDirection(v) {
  const len = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
  return [v[0] / len, v[1] / len, v[2] / len];
}

function lerpParams(a, b, t) {
  const ad = a.sunDirection, bd = b.sunDirection;
  const am = a.moonDirection, bm = b.moonDirection;
  // 色温与黄昏混合因子是 RGB/标量，同样线性插值。既有风格双方都是中性值 → 插值结果逐位不变。
  const ac = a.sunColor, bc = b.sunColor, aa = a.ambientColor, ba = b.ambientColor;
  // 水面亮度乘数（v2.1）同理走线性插值 —— 不插的话风格切换到「傍晚→夜」会跳变。
  const aw = a.waterTint, bw = b.waterTint;
  return {
    sky: lerpHex(a.sky, b.sky, t),
    fogColor: lerpHex(a.fogColor, b.fogColor, t),
    fogScale: a.fogScale + (b.fogScale - a.fogScale) * t,
    skyDim: a.skyDim + (b.skyDim - a.skyDim) * t,
    blockBoost: a.blockBoost + (b.blockBoost - a.blockBoost) * t,
    // ACES 曝光与其它标量同等对待（线性插值）—— 缺了这一行会让风格切换时曝光二态跳变。
    toneMappingExposure: a.toneMappingExposure + (b.toneMappingExposure - a.toneMappingExposure) * t,
    // 色温（v1.71）：**始终返回新数组**，绝不把 VISUAL_STYLES 的权威数组暴露给调用方。
    sunColor: [
      ac[0] + (bc[0] - ac[0]) * t,
      ac[1] + (bc[1] - ac[1]) * t,
      ac[2] + (bc[2] - ac[2]) * t,
    ],
    ambientColor: [
      aa[0] + (ba[0] - aa[0]) * t,
      aa[1] + (ba[1] - aa[1]) * t,
      aa[2] + (ba[2] - aa[2]) * t,
    ],
    // 水面亮度乘数（v2.1）：同样返回**新数组**（不得把权威原值暴露给调用方）。
    // 两端都为中性时插值结果逐位 = 1 → 其余四风格的水面零回归。
    waterTint: [
      aw[0] + (bw[0] - aw[0]) * t,
      aw[1] + (bw[1] - aw[1]) * t,
      aw[2] + (bw[2] - aw[2]) * t,
    ],
    // 黄昏天空盒混合因子（v1.71）：两风格都是 0（自动循环从不引用 dusk）→ 结果恒 0。
    duskBlend: (a.duskBlend || 0) + ((b.duskBlend || 0) - (a.duskBlend || 0)) * t,
    // 显式夜空混合（可选）：只在**两端都显式给了值**时才插值；否则交给 nightBlendOf 派生。
    // 用 undefined 作为「未指定」信号，不写 0（0 是合法显式值，两者语义不同）。
    nightBlend: (typeof a.nightBlend === 'number' && typeof b.nightBlend === 'number')
      ? a.nightBlend + (b.nightBlend - a.nightBlend) * t
      : undefined,
    sunDirection: [
      ad[0] + (bd[0] - ad[0]) * t,
      ad[1] + (bd[1] - ad[1]) * t,
      ad[2] + (bd[2] - ad[2]) * t,
    ],
    moonDirection: [
      am[0] + (bm[0] - am[0]) * t,
      am[1] + (bm[1] - am[1]) * t,
      am[2] + (bm[2] - am[2]) * t,
    ],
    // 月亮可见性/尺寸不插值：它们是“这一风格要不要画月亮”的开关语义，取插值段右端的值。
    // （t<1 时取左端会让天亮前一刻仍在画月亮，而天空已亮——观感就是“白天有月亮”。
    //  取右端则与“黎明已亮”同步：早晨段直接关掉。）
    moonVisible: t > 0 ? b.moonVisible : a.moonVisible,
    moonSize: a.moonSize + (b.moonSize - a.moonSize) * t,
  };
}

/** 小时 → 插值参数（纯函数，测试可用）；返回的 sunDirection **已归一化** */
export function paramsAtHour(hour) {
  const h = ((hour % 24) + 24) % 24;
  let p = null;
  for (let i = 0; i < KEYFRAMES.length - 1; i++) {
    const [t0, k0] = KEYFRAMES[i];
    const [t1, k1] = KEYFRAMES[i + 1];
    if (h >= t0 && h <= t1) {
      const t = t1 === t0 ? 0 : (h - t0) / (t1 - t0);
      p = lerpParams(VISUAL_STYLES[k0], VISUAL_STYLES[k1], t);
      break;
    }
  }
  if (!p) p = lerpParams(VISUAL_STYLES.noon, VISUAL_STYLES.noon, 0);
  p.sunDirection = normalizeDirection(p.sunDirection);
  p.moonDirection = normalizeDirection(p.moonDirection);
  return p;
}

/**
 * 夜间程度 0..1 —— 天空盒双图交叉淡入因子（v1.58）。
 *
 * **从既有 `skyDim` 派生，不新增权威**（红线 1）：正午 skyDim=1 → 0（全白天云图）；
 * skyDim 降到 night 的 0.25 → 1（全星空）。于是「天空变暗」与「星空浮现」天然同步，
 * 随关键帧插值**连续变化**，没有硬切换跳帧。
 *
 * 端点与中间值：noon 0 / morning 0.267 / night 1。
 *
 * ⚠️ **手动风格必须显式指定夜空混合，不能靠 skyDim 倒算**（v1.71 实测踩坑）：
 * dusk 的 skyDim 是 0.78（为了地面可辨认），按公式会倒算出 **0.293** → 傍晚的天空被
 * 混进 30% 星空贴图，实测天空暖度从应当的暖灰被拉到 **R−B = −14**（仍偏冷）。
 * 语义上也不对：傍晚既不是白天也不是夜，它的天空由 **dusk 立方图**接管，不该再叠星空。
 * 所以风格数据可显式给 `nightBlend`；缺省（undefined）才回落到 skyDim 派生。
 *
 * @param {{skyDim: number, nightBlend?: number}} params paramsAtHour 或 VISUAL_STYLES 的结果
 */
export function nightBlendOf(params) {
  // 显式值优先（手动风格用）：0 也是合法显式值，故判 typeof 而非真值
  if (typeof params.nightBlend === 'number') {
    return Math.min(1, Math.max(0, params.nightBlend));
  }
  const nightDim = VISUAL_STYLES.night.skyDim;
  const raw = (1 - params.skyDim) / (1 - nightDim);
  // 钳制：skyDim 越界（未来新增风格 >1 或 <night）不得让混合因子溢出成负或 >1
  return Math.min(1, Math.max(0, raw));
}

export class DayNight {
  /**
   * @param {Object} opts
   * @param {Object} opts.scene three Scene（background 为 Color 实例）
   * @param {{fogNear: Object, fogFar: Object, fogColor: Object}} opts.fog setupFog 返回的 uniform 句柄
   * @param {{uSkyDim: Object, uBlockBoost: Object, uShadowStrength?: Object, uSunDirection?: Object}} opts.voxelUniforms 体素材质日夜 uniform
   *   （uShadowStrength / uSunDirection 句柄由 createVoxelMaterials 提供、本类消费；句柄缺失时跳过写入）
   * @param {{uNightBlend?: {value: number}} | null} [opts.skyUniforms] 天空盒 uniform 句柄
   *   （`setupSky` 提供；`?skybox=0` 或加载失败时为 null —— 本类必须容错）
   * @param {number} [opts.baseFogNear] @param {number} [opts.baseFogFar] 视距基准雾距（fogScale 乘算）
   * @param {number} [opts.cycleSeconds] 一天时长（秒），默认 1200
   * @param {number} [opts.startHour] 初始小时，默认 12（正午，与 M1 视觉口径一致）
   * @param {{toneMappingExposure: number}|null} [opts.renderer] 渲染器（只消费 `toneMappingExposure`
   *   属性）。**仅消费这一个字段**，所以 stub 传 `{ set toneMappingExposure(v){} }` 即可测；
   *   缺省 null（未装配 / 单测）→ 跳过写入。
   * @param {{color: {setRGB: Function}}|null} [opts.sunLight] 太阳方向光（只消费 `color.setRGB`）。
   *   色温（v1.71）必须同时写到灯上：它是枪 PBR 高光的源，否则傍晚里枪身高光仍是中性白。
   *   缺省 null（单测 / fixture）→ 跳过。
   * @param {(dir: [number, number, number]) => void} [opts.onSunDirection] 太阳方向变化回调（已归一化）
   * @param {string|null} [opts.visualStyle] 启动时的视觉风格（`VISUAL_STYLE_KEYS` 的值，或 null
   *   = 自动日夜循环）。**构造即生效**：首帧就 apply 这个风格，而不是先 apply 正午再等外部补
   *   `setStyle()`。见构造器末尾的注释（用户 2026-10-31 反馈）。
   */
  constructor({ scene, fog, voxelUniforms, skyUniforms = null, baseFogNear, baseFogFar, cycleSeconds = 1200, startHour = 12, renderer = null, sunLight = null, onSunDirection = null, visualStyle = null }) {
    this.scene = scene;
    this.fog = fog;
    this.voxelUniforms = voxelUniforms;
    this.skyUniforms = skyUniforms;
    this.renderer = renderer;
    this.sunLight = sunLight;
    this.baseFogNear = baseFogNear;
    this.baseFogFar = baseFogFar;
    this.cycleSeconds = cycleSeconds;
    this.hour = startHour;
    this.onSunDirection = onSunDirection;
    this._styleOverride = null;
    // 阴影总开关标志（Game.setShadowsEnabled 写入）：_apply 每次日夜推进都写
    // uShadowStrength，必须遵守该标志 —— 否则「关阴影」会在正常日夜循环的下一帧
    // 被覆写回 skyDim（静默失效；override 风格下 update() early-return 测不出来）。
    this.shadowEnabled = true;
    /**
     * 首帧就按**目标风格**定下来（不得先 apply 正午再等外部 `setStyle`）。
     *
     * 用户 2026-10-31：「刚开始进入游戏的时候，如果是晚上或者傍晚，默认就要渲染正确的
     * 水面颜色，而不是只在切换环境的时候才正确」。
     *
     * 根因是**构造时序**，不是某一个 uniform：旧实现构造末尾硬性
     * `_apply(paramsAtHour(12))`（正午，M1 口径），而持久化的 `settings.visualStyle` 要到
     * `game.start()` 尾部才由 `setVisualStyle()` 补上。两者之间，**全部**风格相关状态
     * （水面 tint、曝光、天空、色温、sunDirection）都是正午值 —— 「首帧对不对」于是依赖
     * 一个后置副作用。对本轮的水面改动尤其致命：tint 初值是 1（中性），
     * 所以启动即夜晚时会先拿晨午的水色。
     *
     * 现在由构造参数决定：`visualStyle` 非空 → 直接进 override 并 apply 一次；
     * 空 → 走既有的 `paramsAtHour(startHour)`（**逐位零回归**，缺省仍是正午）。
     */
    if (visualStyle) {
      // 与 setStyle() 同一收口（经 _apply），且只 apply 一次 —— 不先写正午再写目标风格。
      this._styleOverride = visualStyle;
      this._apply({ ...VISUAL_STYLES[visualStyle] });
    } else {
      this._apply(paramsAtHour(this.hour));
    }
  }

  /** 固定风格（M3 设置面板用）；null 恢复日夜循环 */
  setStyle(key) {
    this._styleOverride = key;
    if (key) this._apply({ ...VISUAL_STYLES[key] });
  }

  /** 直接设置时间（测试/调试） */
  setTime(hour) {
    this.hour = hour;
    if (!this._styleOverride) this._apply(paramsAtHour(hour));
  }

  /** 当前生效参数（测试断言用）；sunDirection / moonDirection 与 paramsAtHour 同口径（已归一化） */
  get params() {
    if (!this._styleOverride) return paramsAtHour(this.hour);
    const p = { ...VISUAL_STYLES[this._styleOverride] };
    p.sunDirection = normalizeDirection(p.sunDirection);
    p.moonDirection = normalizeDirection(p.moonDirection);
    // 色温必须是**新数组**：`{ ...VISUAL_STYLES[key] }` 是浅拷贝，数组字段仍指向权威原值。
    // 不拷贝的话任何调用方 `params.sunColor[0] = x` 会直接改掉风格数据（红线 1）。
    p.sunColor = [...p.sunColor];
    p.ambientColor = [...p.ambientColor];
    p.waterTint = [...p.waterTint];
    return p;
  }

  update(dt) {
    if (this._styleOverride) return;
    this.hour = (this.hour + dt * 24 / this.cycleSeconds) % 24;
    this._apply(paramsAtHour(this.hour));
  }

  _apply(p) {
    if (this.scene.background && this.scene.background.set) this.scene.background.set(p.sky);
    this.fog.fogColor.value.set(p.fogColor);
    if (this.baseFogNear !== undefined) {
      this.fog.fogNear.value = this.baseFogNear * p.fogScale;
      this.fog.fogFar.value = this.baseFogFar * p.fogScale;
    }
    this.voxelUniforms.uSkyDim.value = p.skyDim;
    this.voxelUniforms.uBlockBoost.value = p.blockBoost;
    // 阴影强度随天空亮度联动（天黑阴影自然消失）。句柄由 createVoxelMaterials 提供，
    // 未提供时跳过 —— 避免真实材质尚未接线时构造抛错（消费点：materials.js 的 colorNode）。
    // ⚠️ 遵守 shadowEnabled 标志：关闭时写 0 而非 skyDim（见构造器注释的静默失效）。
    const uShadowStrength = this.voxelUniforms.uShadowStrength;
    if (uShadowStrength) uShadowStrength.value = this.shadowEnabled ? p.skyDim : 0;
    // setStyle 传的是风格原值、paramsAtHour 已归一化 → 此处统一归一化，两条路径口径一致。
    // ⚠️ 归一化只算一次并**复用**同一个值：本函数在日夜循环下每帧跑，再来一遍就白付两次分配
    // 并且两处公式会各自漂移（红线 1 精神）。`_apply` 是所有写入路径的唯一收口点。
    const sunDir = normalizeDirection(p.sunDirection);
    // 太阳方向写给体素材质的 N·L 方向光（v1.58）。句柄由 createVoxelMaterials 提供；
    // fixture / 尚未接线时缺失 → 跳过（与 uShadowStrength 同一容错口径）。
    const uSunDirection = this.voxelUniforms.uSunDirection;
    if (uSunDirection && uSunDirection.value && typeof uSunDirection.value.set === 'function') {
      uSunDirection.value.set(sunDir[0], sunDir[1], sunDir[2]);
    }
    // ACES 色调映射的曝光随风格/日夜插值（v1.70）。**单一收口点**：setStyle 与日夜循环
    // 两条路径都经 _apply → 口径一致，不会出现「点风格按钮后曝光不跟」的撕裂。
    // renderer 缺省 null（单测 stub / 尚未装配）→ 跳过（与 uShadowStrength 同一容错口径）。
    if (this.renderer && typeof p.toneMappingExposure === 'number') {
      this.renderer.toneMappingExposure = p.toneMappingExposure;
    }
    // 天空盒双图交叉淡入因子（v1.58）：由既有 skyDim 派生，句柄由 setupSky 提供。
    const uNightBlend = this.skyUniforms && this.skyUniforms.uNightBlend;
    if (uNightBlend) uNightBlend.value = nightBlendOf(p);
    // 黄昏天空盒混合因子（v1.71）：第三层天空（dusk 立方图）。只有 `setStyle('dusk')` 时是 1，
    // 自动循环与其余三风格恒 0 → 天空**逐位**回到 v1.70 的双图交叉淡入。
    const uDuskBlend = this.skyUniforms && this.skyUniforms.uDuskBlend;
    if (uDuskBlend) uDuskBlend.value = p.duskBlend || 0;
    // 色温（v1.71）：直射光 / 环境光两路乘数写给体素材质。
    // 句柄缺失（fixture / 尚未接线）时跳过 —— 与 uShadowStrength / uSunDirection 同一容错口径。
    // ⚠️ **用 `.value.set(x,y,z)` 而不是 `.setRGB()`**：这两个句柄都是 `uniform(new THREE.Vector3())`
    // → `.value` 是 **Vector3**（有 `set`，**没有** `setRGB` —— 那是 Color 的方法）。
    // 实测踩坑：写 `.setRGB()` 在真实页面 start() 里抛「uSunColor.value.setRGB is not a function」
    // → **整个游戏页白屏**（不是局部样式错）；而纯逻辑单测用的是 stub，写成什么方法都能过 ⇒
    // 这类接线错误只能靠「真游戏页能启动」的 E2E 拓。
    // ⚠️ 中性色（全 1）时写入后公式**逐位等于** v1.70（见 sun-shade.js 的不变式单测）。
    const uSunColor = this.voxelUniforms.uSunColor;
    if (uSunColor && uSunColor.value && typeof uSunColor.value.set === 'function') {
      uSunColor.value.set(p.sunColor[0], p.sunColor[1], p.sunColor[2]);
    }
    const uAmbientColor = this.voxelUniforms.uAmbientColor;
    if (uAmbientColor && uAmbientColor.value && typeof uAmbientColor.value.set === 'function') {
      uAmbientColor.value.set(p.ambientColor[0], p.ambientColor[1], p.ambientColor[2]);
    }
    // 水面环境亮度（v2.1）：写给**海面平面**的 `uWaterTint`（句柄由 `setupOcean` 提供）。
    // ⚠️ 它与体素世界的 skyDim/曝光是**两个独立自由度**：体素世界需要 dusk/night 把曝光踢到
    // 1.20/1.60 才能让暗部不死黑，而水面（unlit）乘的只是它自己的基色 → 不压就会「像发光」。
    // 句柄缺失（fixture / `?ocean=0` / 尚未接线）时跳过 —— 与 uSunColor 同一容错口径。
    // ⚠️ 用 `.value.set(x,y,z)`：`ocean.js` 建的是 `uniform(new THREE.Vector3())`，**没有** setRGB。
    const uWaterTint = this.skyUniforms && this.skyUniforms.uWaterTint;
    if (uWaterTint && uWaterTint.value && typeof uWaterTint.value.set === 'function') {
      uWaterTint.value.set(p.waterTint[0], p.waterTint[1], p.waterTint[2]);
    }
    // 太阳灯（枪的 PBR 高光 + 阴影投射灯）的颜色也要跟随色温，否则傍晚里枪身的高光仍是
    // 中性白，与暖橙直射光打架。**基准色是既有常量**（不在这里写第二份字面量）。
    // 中性色温（全 1）时乘出来逐位等于原基准色 → 其余三风格零回归。
    const sunLight = this.sunLight;
    if (sunLight && sunLight.color && typeof sunLight.color.setRGB === 'function') {
      sunLight.color.setRGB(
        SUN_LIGHT_BASE_RGB[0] * p.sunColor[0],
        SUN_LIGHT_BASE_RGB[1] * p.sunColor[1],
        SUN_LIGHT_BASE_RGB[2] * p.sunColor[2],
      );
    }
    if (this.onSunDirection) this.onSunDirection(sunDir);
    /**
     * 湿表面反光的天空色（v3.31）—— **复用既有风格数据，不新增权威**（红线 1）。
     *
     * 反光反的是「按反射方向在地平线色↔天顶色之间插值」的程序化天空：
     *   · 地平线色 = `p.fogColor`（远处方块该淡入的那个天色，与场景雾同一份）；
     *   · 天顶色   = `p.sky`（天空盒未启用时的纯色天空，与 background 同一份）。
     * ⇒ 反光颜色自动跟着日夜循环/风格切换走，无需 CPU 每帧额外算什么。
     *
     * ⚠️ 句柄是 `uniform(new THREE.Color(...))` ⇒ 用 `.value.set(hex)`
     * （与上面 `this.fog.fogColor.value.set(p.fogColor)` 逐字同手法）。
     * ⚠️ 句柄缺失（fixture / 旧调用方 / 尚未接线）时跳过 —— 与 uWaterTint 同一容错口径。
     * ⚠️ 正午两色相同（都是 0x87ceeb）⇒ 天空环境近似单色；傍晚/夜里有层次。
     * 这是复用既有数据的必然结果，不为了反光去改风格表。
     */
    const uWetHorizon = this.voxelUniforms.uWetHorizon;
    if (uWetHorizon && uWetHorizon.value && typeof uWetHorizon.value.set === 'function') {
      uWetHorizon.value.set(p.fogColor);
    }
    const uWetZenith = this.voxelUniforms.uWetZenith;
    if (uWetZenith && uWetZenith.value && typeof uWetZenith.value.set === 'function') {
      uWetZenith.value.set(p.sky);
    }
  }
}
