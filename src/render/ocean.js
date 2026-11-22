// src/render/ocean.js — 动画海面（M2-5，移植 mc-lite Engine.js 海面 TSL 材质）
// 800×800 平面跟随相机（无限水面）；波浪动画 + Blinn-Phong 高光 + Fresnel + 距离淡出 + 水域遮罩。
// 水面高度 = SEA_Y + 0.5（mc-lite WATER_LEVEL_OFFSET 语义）。
import * as THREE from 'three';
import {
  uniform, Fn, float, vec2, vec3, sin, cos, max, pow, dot, normalize, length, floor,
  smoothstep, mix, positionWorld, cameraPosition, Discard, and, select,
  reflector, screenUV,
} from 'three/tsl';
import {
  OCEAN_MASK_THRESHOLD, OCEAN_MASK_OFFSET, OCEAN_MASK_NO_CITY, OCEAN_MASK_NO_LAKE,
} from './ocean-mask.js';
import {
  REFLECT_RESOLUTION_SCALE, REFLECT_MIP_LEVEL, REFLECT_STRENGTH, REFLECT_DISTORT,
  REFLECT_DISTORT_NEAR, REFLECT_DISTORT_FAR, REFLECT_GRAZE, REFLECT_TINT,
} from './water-reflect-config.js';
import { TERRAIN_HEIGHT_PARAMS } from '../gen/terrain.js';
import { BIOME_PARAMS } from '../gen/noise.js';

export const WATER_LEVEL_OFFSET = -1.5; // SEA_Y + 0.5
/**
 * 水面基色。**有意偏离 mc-lite 的 `0x588be4`**（2026-10-26 用户实玩反馈：
 * 「海水的波纹的颜色有点泛白，改成大海应有的深色……稍微颜色深一些，灰一些」）。
 *
 * 泛白的根因是**基色 + 纯白高光加法叠加**：基色 0x588be4 在线性空间已是
 * [0.098, 0.258, 0.776]，高光按 `white × k` 加在它之上，ACES 在亮端压缩 → 平坦水面
 * （也就是画面里占面积最大的那层）实测众数峰 **170/189/220（luma 187）**，看上去就是一块粉白。
 * 两处一起改：基色往**灰蓝**压深、高光改**乘法混色**（只占基色→白之间的剩余量，天然有界）。
 *
 * 实测（noon / ACES exp=1.0 / 海岸机位，水区众数峰）：
 * | | 基色屏幕值 | 水面屏幕色 | luma |
 * |---|---|---|---|
 * | mc-lite `0x588be4` + 白高光 | 98/167/224 | `170/189/220` | 187 |
 * | v1.82 `0x707f89`（灰蓝） | 133/153/165 | `132/149/178` | 148 |
 * | v1.83 `0x0c342f`（深青绿，过暗发脏） | 8/61/50 | `69/98/107` | 92 |
 * | v1.84 `0x2a5f85`（海蓝，B−G 33） | `42/95/133` | `92/133/164` | 127 |
 * | **v1.85 `0x22598a`（更深一档的海蓝）** | **`32/85/129`** | **`76/122/166`** | **115** |
 *
 * v1.85（用户第四轮）「水波纹的颜色也稍微变蓝一些」：v1.84 的 B−G 是 33，仍偏青；
 * 基色调向蓝（R 降、B 升）→ B−G 升到 **44**，与体素水（`100/137/168`）的色相一致。
 *
 * ⚠️ **基色屏幕值 ≠ 水区实测值**：后者还含高光、雾与下层体素水的叠加。选色不能只看 hex，
 * 换算口径是 sRGB → 线性 → ACES → sRGB（同 `sun-shade.js` 的 `srgbEncode` / `acesFilmic`）。
 *
 * **色相演进（三轮实玩反馈定下来）**：
 * - v1.82：用户「泛白，要深一些、灰一些」→ 压亮度的方向对，但只做了「去饱和」，偏灰。
 * - v1.83：用户给了参照图 `/Users/bachi/ttt/bug/海.png`（实测海区 `67/107/124`，G−R **+40**）
 *   → 认定「真实海面是青绿」→ 改深青绿 `0x0c342f`，实测 G−R 31、B−G 11。
 * - v1.84：用户「又太暗了，显得水很脏，稍微再蓝一些亮一些，显得干净」。像素数据支持这个判断：
 *   v1.83 的 `69/98/107` **luma 只有 92**、**R 只有 69**（色度已足但亮度不够）
 *   → 观感是「发脏的浊水」。改成 **`0x2a5f85`（luma 127，偏蓝）**。
 *   ⚠️ **三条反馈不矛盾**：v1.82/83 要的是「不要白」，v1.84 要的是「不要脏」——
 *   **亮度与饱和度是两个自由度**，泛白的反义词不是发暗。参照图本身是一张**阴天**照片
 *   （海区 luma 仅 100），而游戏里是正午晴天，直接取其亮度就会脏。
 *   **可信的锚点只有色相（B ≥ G > R、G−R 为正），亮度得按本仓光照单独标定。**
 */
const WATER_COLOR = 0x22598a;
/**
 * 高光颜色（v1.84：偏青绿 → **偏海蓝**）。
 * 纯白/偏红的高光会把水面压成灰白（v1.82 的泛白就是这么来的）；B 最高、R 最低，
 * 叠上去仍是「深蓝海面被太阳照亮」，而不是「什么颜色的水面上盖一层白」。
 */
const WATER_HIGHLIGHT_COLOR = [0.70, 0.86, 1.00];
/**
 * 高光总权重上限：`(diffuse + scatter + spec + fresnel×0.1)` 的整体缩放。
 * mc-lite 原值口径下该和约 0.20（平静水面）~1.3（太阳高光斑），×0.55 后约
 * 0.11 / 0.72。前者给「波纹可见但不发白」的基底，后者仍保留成片的高光斑。
 */
const WATER_HIGHLIGHT_GAIN = 0.42;
/**
 * 水面不透明度（v1.83：0.7 → 0.92，v1.84 维持）。
 * 这是「改基色仍泛白」的**第二个根因**：海面平面是半透明的，底下还有一层
 * **体素水方块**（v1.84 之前实测 `59/100/190`，高饱和紫蓝）。
 * 0.7 时 30% 的体素水直接透上来，把颜色往紫蓝拉并抬亮一档。
 * 实测（同一基色/高光，只改这个数）：0.70 → 近处 `86/111/146`；0.82 → `76/103/130`；
 * **0.92 → `67/95/112`**。
 * ⚠️ 不能再往上推太多：海面本来是半透明水面，接近 1.0 会变成一层塑料板。
 * v1.84 起体素水贴图已重烘（`npm run water`，均值 47/102/211 → 95/140/168）→ 两侧观感已接近，
 * 0.92 是「压住渗色」与「保留半透明水面」的交点。
 */
const WATER_OPACITY = 0.92;
const WATER_VISIBLE_DISTANCE = 80;
const WATER_EDGE_FADE_BAND = 15;
/**
 * 远距离雾色（v1.84 再调）。
 * `fogNear=20 / fogFar=70` → 远处海面几乎全是这个颜色，所以它就是「远处那片海」的观感。
 * 五个版本的屏幕值：mc-lite `0xa7d1e2` → `192/217/223`（白）；v1.82 `0x8aacbe` → `166/196/207`（仍偏亮）；
 * v1.83 `0x556e7e` → `93/131/152`（对得上参照图，但那图是阴天）；v1.84 `0x7aa4c4`；
 * 现行 `0x6b9cc0` → 与 v1.85 的深蓝水面同色系 —— 远景不再比近景暗一档（那正是「脏」的来源之一）。
 */
const WATER_FOG_COLOR = 0x6b9cc0;

/**
 * 波纹场的**唯一公式**（红线 1）—— 水面高光与倒影扰动共用它。
 *
 * ⚠️ **为什么必须共享而不是各写一份**：倒影的 UV 偏移若用另一套 sin 参数或另一个时间
 * uniform，倒影会与水纹**错相位** —— 水纹往左涌时倒影往右晃。那类缺陷所有数值判据
 * （uniform 值、draw call、帧时、像素亮度带）全对，只有盯着画面看才发现。
 *
 * 返回 `{ waves, detailMask }`：`waves` 是标量波高（既有高光用它算法线），
 * `detailMask` 是远景 LOD 衰减（两处都要，避免远景各算一遍 smoothstep）。
 *
 * @param {*} pos `positionWorld.xz`
 * @param {*} dist 片元到相机的水平距离
 * @param {*} uTime 时间 uniform（**同一个实例**）
 */
function waveField(pos, dist, uTime) {
  const detailMask = smoothstep(float(50.0), float(25.0), dist);
  let waves = sin(pos.x.mul(1.5).add(uTime.mul(5.5))).mul(0.1)
    .add(sin(pos.y.mul(1.3).sub(uTime.mul(3.2))).mul(0.1));
  waves = waves.add(
    sin(pos.x.mul(2.8).add(pos.y.mul(2.2)).add(uTime.mul(3.5))).mul(0.08).mul(detailMask)
      .add(sin(pos.x.mul(-2.1).add(pos.y.mul(3.7)).add(uTime.mul(2.8))).mul(0.06).mul(detailMask)),
  );
  /**
   * 正交相位的第二分量 —— **只给倒影扰动的 z 方向用**。
   *
   * ⚠️ 两个方向必须用**不同相位**：共用同一个 `waves` 时 UV 偏移是 `(w, w)`，
   * 整幅倒影沿 45° 对角线**同向平移** —— 观感是「一张画在滑动」而不是水波。
   * 实测：取不同频率/相位后倒影才是「揉动」而非「平移」。
   */
  const wavesCross = sin(pos.x.mul(1.7).sub(uTime.mul(4.1))).mul(0.1)
    .add(sin(pos.y.mul(2.3).add(uTime.mul(3.7))).mul(0.08).mul(detailMask));
  return { waves, wavesCross, detailMask };
}

/**
 * 创建海面并挂到场景。
 * @param {THREE.Scene} scene
 * @returns {{update: (camera: THREE.Camera, dt: number) => void, plane: THREE.Mesh}}
 */
/**
 * v3.30d：NDC → uv 的 bias 矩阵（上游 `this._bias` 同口径，y 行取负）。
 *
 * 上游（WebGL）：`[0.5,0,0,0.5; 0,0.5,0,0.5; 0,0,0.5,0.5; 0,0,0,1]`。
 * 本仓采样的是 **RenderTarget 纹理**，其 v 方向与屏幕相反（同 ocean 自己的
 * `screenUV.flipX()` 所处理的那个 flip 语义）⇒ y 行取 **−0.5 / +0.5**。
 * ⚠️ 弄反的形态是「倒影上下颠倒」—— 而那看起来也有点像倒影，极易误判为正确
 *（ocean.js 已记过同一条）⇒ 由像素判据钉（镜面物体的上下关系）。
 */
const REFLECT_BIAS = new THREE.Matrix4().set(
  0.5, 0, 0, 0.5,
  0, -0.5, 0, 0.5,
  0, 0, 0.5, 0.5,
  0, 0, 0, 1,
);

/**
 * v3.30：反射 pass 期间给湿地面用的**1×1 占位纹理**（懒建、全局共享）。
 *
 * ⚠️ 必须是**真实 Texture**（不是 null）：节点采样 null 会报绑定错误。
 * 颜色取黑（反射项在 pass 期间本来就不应贡献）。
 * ⚠️ `colorSpace = NoColorSpace`：它不参与颜色计算，避免 sRGB 转换开销。
 */
let _wetPlaceholder = null;
function placeholderTexture() {
  if (!_wetPlaceholder) {
    const data = new Uint8Array([0, 0, 0, 255]);
    _wetPlaceholder = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat);
    _wetPlaceholder.needsUpdate = true;
    _wetPlaceholder.colorSpace = THREE.NoColorSpace;
  }
  return _wetPlaceholder;
}

export function setupOcean(scene) {
  const waterGeo = new THREE.PlaneGeometry(800, 800);

  const uTime = uniform(0.0);
  const uColor = uniform(new THREE.Color(WATER_COLOR));
  const uSunDirection = uniform(new THREE.Vector3(0, 0.8, 0.6).normalize());
  const uOpacity = uniform(WATER_OPACITY);
  const uSeed = uniform(0.0);
  const uFogColor = uniform(new THREE.Color(WATER_FOG_COLOR));
  const uFogNear = uniform(20.0);
  const uFogFar = uniform(70.0);
  /**
   * 水面环境亮度乘数（v2.1）—— 由 `DayNight._apply` 按视觉风格写入（`skyUniforms.uWaterTint`）。
   *
   * **根因**：本材质是 unlit，此前只读 `uColor`/`uSunDirection`，**完全不跟着色环境的亮度**。
   * 而 dusk/night 的 `toneMappingExposure` 是 1.20 / 1.60（为体素世界的暗部补光，见
   * `daynight.js` 的 VISUAL_STYLES）→ 水面连带被提亮。实测（海岸机位，五变量冻结，水面众数峰）：
   * | 风格 | exposure | 水面 rgb | luma |
   * |---|---|---|---|
   * | morning | 1.00 | `77/122/165` | 116 |
   * | noon | 1.00 | `77/123/166` | 116 |
   * | dusk | 1.20 | `92/137/179` | **131** |
   * | night | 1.60 | `109/154/193` | **147** |
   * 用户 2026-10-31：「傍晚和晚上水面波纹过于亮，晚上像水面会发光」—— 数据完全对得上。
   * 夜里还有**反向撕裂**：体素水方块被 `skyDim 0.25` 压暗，水面平面反而变亮一档。
   *
   * ⚠️ **初值恒 1**：`1` 时下面的公式**逐位等于** v1.85 的原式（零回归）——
   * 即使无人接线（fixture / 单测 / 未装配），水面也回到改动前的表现。
   */
  const uWaterTint = uniform(new THREE.Vector3(1, 1, 1));
  /**
   * 城市门控 bounds（xyzw = minX/maxX/minZ/maxZ）。
   * 默认取 `OCEAN_MASK_NO_CITY` 哨兵（minX > maxX → 判定恒假 → 门控关闭），
   * 未接线时不误伤任何点；`setCityBounds()` 接真实城市 bounds 后生效。
   */
  const uCityBounds = uniform(new THREE.Vector4(
    OCEAN_MASK_NO_CITY.minX, OCEAN_MASK_NO_CITY.maxX,
    OCEAN_MASK_NO_CITY.minZ, OCEAN_MASK_NO_CITY.maxZ,
  ));
  /**
   * 浅水高台的湖盆圆（xyz = cx/cz/radius，w 不用）。
   *
   * ⚠️ **v2.14 新增（用户报告「水面的波纹并没有覆盖全部」）**：下面的水域遮罩读的是
   * `getTerrainHeight`（**自然**地形），而浅水高台的整形把湖底压到了 `SEA_Y-1`
   * —— `generateHeight` 看不到这件事。于是自然高度 ≥ `SEA_Y` 的那些湖盆格子会被
   * 遮罩关掉平面，只剩体素水的**静态顶面**（无波纹、无高光）。
   * ⇒ 湖区内必须**强制渲染**水面平面，与地形高度无关。
   *
   * 默认取 `OCEAN_MASK_NO_LAKE`（`radius = 0` → 判定恒假）—— 未接线时不影响任何点，
   * 与 `uCityBounds` 同一手法。CPU 侧同一判据见 `ocean-mask.js` 的 `inLakeCircle`。
   */
  const uLakeCircle = uniform(new THREE.Vector4(
    OCEAN_MASK_NO_LAKE.cx, OCEAN_MASK_NO_LAKE.cz, OCEAN_MASK_NO_LAKE.radius, 0,
  ));

  const fadeStart = WATER_VISIBLE_DISTANCE - WATER_EDGE_FADE_BAND;
  const fadeEnd = WATER_VISIBLE_DISTANCE;

  // ==================== 水面倒影（v3.17） ====================
  //
  // 用户口径：「朦胧地映照出地面的物品倒影，不用清晰度，要的是一个特效」，
  // 且「尽可能小、甚至几乎不影响性能」。三条落地决策均有实测依据（见
  // `water-reflect-config.js` 文件头的成本表）：
  //   ① **朦胧靠 mip、省钱靠节流**（降 RT 分辨率几乎不省钱，成本在 draw call 数）；
  //   ② **随波扰动免费**（只是片元多几次 sin + 一次 UV 加法，实测增量在噪声内）；
  //   ③ **水面不可见时整个 pass 跳过**（成本归零）。
  //
  // ⚠️⚠️ **反射 pass 必须在主 render 之前跑 —— 这是载荷性约束，不是优化**。
  // 实测（调研探针 v3~v8）：把 reflector 挂在水面材质上让它自动触发时，反射 pass 会在
  // **transparent 队列末尾**跑，而 BatchedMesh 的 instance 索引走 `_indirectTexture`（GPU 纹理），
  // 一帧内**最后一次写入胜出** ⇒ 主 pass 的 drawIndexed 执行时读到反射相机的索引表
  // ⇒ **地平线以上整片天空被撕成黑多边形**（近黑像素占比 1.26% → 11.66%）。
  // 失效形态是**静默的**：draw call / 三角数 / 帧时 / uniform 值全对，只有画面能看出。
  // 已排除的假修法（均实测无效，勿重试）：
  //   · 快照/恢复 multi-draw 列表（v1.46 阴影那套）—— 主 pass 已先 draw 完，快照时机不对；
  //   · 改 `renderOrder`（1 → 99）—— blackTop 逐位不变；
  //   · 改 `bounces` true/false —— 同样撕。
  // 唯一有效修法：`updateBeforeType = NONE` + 由 `Game` 在主 render 前手动调一次（见
  // `game.js` 的 `_renderWaterReflection()`）。本函数只负责把节点造好并交出句柄。
  const reflectNode = reflector({
    resolutionScale: REFLECT_RESOLUTION_SCALE,
    // bounces=false：只有一面镜子，不需要反射中的反射（也避开递归渲染）
    bounces: false,
    // mip 链是朦胧感的唯一来源（REFLECT_MIP_LEVEL 采样它）
    generateMipmaps: true,
  });
  // 反射目标必须入场景图，否则 matrixWorld 不更新 → 镜面位置/法线错。
  // 它是空 Object3D，自身不产生 draw call；挂在水面平面下 ⇒ 自动跟随相机平移。
  const reflectTarget = reflectNode.target;

  const uReflectStrength = uniform(REFLECT_STRENGTH);
  const uReflectDistort = uniform(REFLECT_DISTORT);
  // 倒影采样的 mip 级别（朦胧度）。独立 uniform 而不是写死 levelNode：
  // 改它不需要重建材质节点树（重建 = 重编译着色器 = 卡帧）。
  const uReflectMip = uniform(REFLECT_MIP_LEVEL);
  /**
   * 相机高度衰减因子（v3.17b）—— 由 `Game._renderWaterReflection()` 每帧写入。
   *
   * ⚠️ **初值 1（满强度）而不是 0**：未接线时（fixture / 单测 / 尚未装配）倒影仍按
   * 基准强度表现 —— 与 `uWaterTint` 同一容错口径。取 0 会让「忘接线」退化成
   * 「倒影永远不出现」，而所有计数类判据全对（静默失效）。
   *
   * ⚠️ **与逐片元掠射项是两个独立自由度，不得合并**：
   *   · 本项是**全局标量**（相机高度），兼任反射 pass 的性能门；
   *   · 掠射项是**逐片元**的（同一帧内近弱远强），不能当性能门。
   */
  const uReflectHeightFade = uniform(1.0);
  /**
   * 掠射项权重（v3.17b）。0 = 关掉该项（逐位回到无掠射衰减）。
   * 走 uniform 而不是编译期常量：面板要能实时拖它（常量变了要重编译着色器 = 卡帧）。
   */
  const uReflectGraze = uniform(REFLECT_GRAZE);
  /**
   * 倒影反射率乘数（v3.17）—— 水面不是完美镜子，反射光被水色吸掉一部分。
   *
   * ⚠️ **它与强度是两个不同的物理量，不得合并**：
   *   · `uReflectStrength` = 倒影占多少（混合比）；
   *   · `uReflectTint` = 倒影本身多亮（反射率）。
   * 只降强度会把倒影一起抹掉（实测要回到冻结色阶得压到几乎 0）；
   * 降反射率则保留形体、只压亮度 —— 这才是「朦胧倒影」应有的做法。
   */
  const uReflectTint = uniform(REFLECT_TINT);

  /**
   * 水面遮罩用的地形高度 —— **与生成侧 `generateHeight` 同构**。
   *
   * ⚠️ TSL 无法调 JS 函数，只能同构实现。数值常量一律读
   * `TERRAIN_HEIGHT_PARAMS` / `BIOME_PARAMS`（单一权威，红线 1）——
   * 各写一份字面量会漂移出「生成侧的地形与遮罩判的不是同一套高度」的撕裂，
   * 后果是陆地上出现假水面或真实湖泊失去水面，肉眼只觉得「水怪怪的」。
   *
   * 与 mc-lite 的差异：mc-lite 只用基础噪声近似（不含 biome 调整），
   * 判据与真实地形偏差 +1.39~+6.71（DESERT/SWAMP 的调整没算进去）。
   */
  const P = TERRAIN_HEIGHT_PARAMS;
  const B = BIOME_PARAMS;
  const biomeNoise = (x, z, scale) => {
    const nx = x.add(uSeed);
    const nz = z.add(uSeed);
    return sin(nx.mul(scale)).mul(2.0).add(cos(nz.mul(scale)).mul(2.0));
  };
  const getTerrainHeight = (x, z) => {
    // 基础噪声（与 gen/noise.js 的 noise 同构）
    const base = floor(biomeNoise(x, z, P.COARSE_SCALE)
      .add(biomeNoise(x, z, P.FINE_SCALE).mul(P.FINE_WEIGHT)));
    // biome 判定（与 gen/noise.js 的 getBiome 同构；CITY 不在这里 —— 由 bounds 门控关掉）
    const temp = biomeNoise(x, z, B.TEMP_SCALE);
    const humidity = biomeNoise(x.add(B.HUMIDITY_OFFSET), z.add(B.HUMIDITY_OFFSET), B.HUMIDITY_SCALE);
    const desert = temp.lessThan(float(B.DESERT_TEMP_MAX));
    const swamp = and(
      and(temp.greaterThan(float(B.DESERT_TEMP_MAX)), temp.lessThan(float(B.SWAMP_TEMP_MAX))),
      humidity.greaterThan(float(B.SWAMP_HUMIDITY_MIN)),
    );
    const desertH = floor(base.mul(P.DESERT_FACTOR).add(P.DESERT_OFFSET));
    const swampH = floor(base.mul(P.SWAMP_FACTOR).add(P.SWAMP_OFFSET));
    return select(desert, desertH, select(swamp, swampH, base));
  };

  const colorNode = Fn(() => {
    const pos = positionWorld.xz;
    const dist = length(pos.sub(cameraPosition.xz));
    const waterFade = float(1.0).sub(smoothstep(float(fadeStart), float(fadeEnd), dist));

    // 远距离淡出裁剪
    Discard(waterFade.lessThanEqual(0.001));

    // 城市门控：城市 bounds 内一律不渲染（**不看距离**，与下面的近处遮罩独立）。
    // 理由：城市把地面压平到接近海平面（CITY_MIN_SURFACE_Y = SEA_Y+1），而水面平面在
    // SEA_Y+0.5 → 挖 2 格洞底顶面降到 -2 就低于水面平面，玩家在陆地上挖出一汪假水。
    // 遮罩算不出 CITY 调整（getBiome 不含 CITY，它由结构系统叠加）→ 只能靠 bounds 关掉。
    // CPU 侧同一判据见 ocean-mask.js 的 inCityBounds。
    const inCity = and(
      and(pos.x.greaterThanEqual(uCityBounds.x), pos.x.lessThanEqual(uCityBounds.y)),
      and(pos.y.greaterThanEqual(uCityBounds.z), pos.y.lessThanEqual(uCityBounds.w)),
    );
    Discard(inCity);

    // 湖区门控（v2.14）：湖底被整形压到 SEA_Y-1，而 `getTerrainHeight` 读的是自然高度
    // → 必须**无条件渲染**水面平面，否则只剩体素水的静态顶面（用户看到的「波纹没盖全」）。
    // 按 `radius + OCEAN_MASK_OFFSET` 外延，让平面与沙滩带重叠，避免岸边一圈硬边界
    // （与 CPU 侧 `inLakeCircle(x, z, lake, OCEAN_MASK_OFFSET)` 逐字同口径）。
    const lakeR = uLakeCircle.z.add(float(OCEAN_MASK_OFFSET));
    const lakeDx = pos.x.sub(uLakeCircle.x);
    const lakeDz = pos.y.sub(uLakeCircle.y);
    const inLake = and(
      uLakeCircle.z.greaterThan(float(0.0)),
      lakeDx.mul(lakeDx).add(lakeDz.mul(lakeDz)).lessThanEqual(lakeR.mul(lakeR)),
    );

    // 水域遮罩：近处仅在地形低于海平面附近显示，远处全显示
    // 阈值 = OCEAN_MASK_THRESHOLD（SEA_Y）；高度是整数 → `h < SEA_Y` ⟺ `h <= SEA_Y-1`，
    // 正是 fillColumn 的水体方块判据（判据同源，无需 mc-lite 的 floor 余量补偿）。
    // 五点取样（±OCEAN_MASK_OFFSET）= 水面沿海岸向内侵的纵深，让水陆边界不锯齿化。
    const threshold = float(OCEAN_MASK_THRESHOLD);
    const offsetVal = float(OCEAN_MASK_OFFSET);
    const h0 = getTerrainHeight(pos.x, pos.y);
    const h1 = getTerrainHeight(pos.x.add(offsetVal), pos.y);
    const h2 = getTerrainHeight(pos.x.sub(offsetVal), pos.y);
    const h3 = getTerrainHeight(pos.x, pos.y.add(offsetVal));
    const h4 = getTerrainHeight(pos.x, pos.y.sub(offsetVal));
    // 整数高度下 smoothstep(threshold-0.01, threshold, h) 恒等于阶跃 → 直接 select，
    // 省 5 次 GPU 调用且与 CPU 版判据一一对应
    const step = (h) => select(h.lessThan(threshold), float(1.0), float(0.0));
    const nearOceanMask = max(max(max(max(step(h0), step(h1)), step(h2)), step(h3)), step(h4));
    const inRangeMask = smoothstep(float(100.0), float(99.0), dist);
    // 湖区强制渲（v2.14）：在 mix **之后**合并，确保不论远近都生效。
    // ⚠️ 必须用 `max` 而不是把 `inLake` 掺进 `nearOceanMask`：后者会被 `inRangeMask`
    // 在 99~100 格外淡到 1，而湖区需要「全屏强制」。
    const oceanMask = max(
      mix(float(1.0), nearOceanMask, inRangeMask),
      select(inLake, float(1.0), float(0.0)),
    );
    Discard(oceanMask.lessThanEqual(0.001));

    // 波纹场（LOD detailMask + 波高 + 正交分量）—— **与倒影扰动共用同一份公式与同一 uTime**
    const { waves, wavesCross, detailMask } = waveField(pos, dist, uTime);

    const normal = normalize(vec3(waves.mul(2.0), 1.0, waves.mul(2.0)));
    const viewDir = normalize(cameraPosition.sub(positionWorld));

    // Blinn-Phong 太阳高光 + 漫反射/散射 + Fresnel
    const halfDir = normalize(uSunDirection.add(viewDir));
    const spec = pow(max(dot(normal, halfDir), 0.0), 100.0).mul(8.0).mul(detailMask);
    const diffuse = max(dot(normal, uSunDirection), 0.0).mul(0.15).mul(detailMask);
    const scatter = max(float(0.0), normal.y).mul(0.08).mul(detailMask);
    const fresnel = pow(float(1.0).sub(max(dot(vec3(0, 1, 0), viewDir), 0.0)), 3.0);

    // 高光合成：**乘进「基色 → 白」的剩余量，而不是加到基色之上**。
    // 加法在亮端会越界（基色 B 已 0.776，加 0.2 就到 0.98），ACES 压缩后几乎全白；
    // 乘法混色 `base + (1−base)×t` 天然有界（t=1 才到纯白），t 小时只提亮一点点，
    // 波纹因此「显出形状」而不「发白」。实测平坦水面的众数峰由此从 170/189/220 落到
    // 132/149/178（见 WATER_COLOR 的表）。
    //
    // ---- 环境亮度（v2.1）----
    // `uWaterTint` 是风格化的环境亮度乘数（晨/午 = 1），**乘在整个水面颜色上**（基色 + 高光）。
    // ⚠️ **必须乘高光，不能只乘基色**（实测踩坑）：高光走乘法混色 `base + highlight×glow×(1−base)`，
    // 它的可提升上限 `(1−base)` 会随基色变暗而变大 → 只压基色时高光反向补偿，
    // 实测 dusk 的 tint 从 1.0 压到 0.80 时水面 luma 只从 131 降到 125（目标 118）。
    // 整体相乘才能在「基色与高光都暗下去」上得到可标定的单调响应。
    // ⚠️ 先算完整颜色再乘 tint（不是改写 base，也不是乘在输出最后）：
    // `tint = 1` 时 `×1.0` 在 IEEE754 下逐位精确 → v1.85 原式零回归。
    const baseColor = uColor;
    const highlight = vec3(WATER_HIGHLIGHT_COLOR[0], WATER_HIGHLIGHT_COLOR[1], WATER_HIGHLIGHT_COLOR[2]);
    const glow = diffuse.add(scatter).add(spec).add(fresnel.mul(0.1))
      .mul(WATER_HIGHLIGHT_GAIN)
      .min(1.0);
    const litColor = baseColor.add(highlight.mul(glow).mul(vec3(1.0, 1.0, 1.0).sub(baseColor)));

    // ---- 倒影（v3.17）----
    //
    // 采样坐标 = 屏幕 UV（reflector 的默认口径是 `screenUV.flipX()`）+ 波纹偏移。
    // ⚠️ **必须保留 `.flipX()`**：RT 是渲染目标纹理（flipY 语义与普通贴图相反），
    // 去掉它倒影会上下颠倒 —— 而那看起来「也有点像倒影」，极易误判为正确。
    //
    // 扰动按距离衰减：远景倒影已被雾吃掉，那里再晃只会变成高频噪声。
    // 边界常量与 CPU 参考实现 `reflectDistortAt()` 共享（红线 1）。
    const reflNear = smoothstep(float(REFLECT_DISTORT_FAR), float(REFLECT_DISTORT_NEAR), dist);
    const reflAmt = uReflectDistort.mul(reflNear);
    reflectNode.uvNode = screenUV.flipX().add(vec2(
      waves.add(wavesCross).mul(reflAmt),
      wavesCross.sub(waves.mul(0.5)).mul(reflAmt),
    ));
    reflectNode.levelNode = uReflectMip;
    // ⚠️ **显式拆分量**：`vec3(node)` 在 WebGPU 后端会静默输出黑（同炮塔三档色调 v3.14 的教训：
    // 单参 `vec3()` 走「转成 vec3」路径，而节点类型不是 'vec3' 时拿不到分量）。
    const reflColor = vec3(reflectNode.r, reflectNode.g, reflectNode.b);
    // 水面吸收（反射率）—— 水面不是理想镜面。实测纯倒影 luma 185.9 = 天空亮度，
    // 而无倒影水面 127.4 ⇒ 不吸收就会把水抬成白镜（撞用户四轮标定的冻结色阶）。
    //
    // ⚠️⚠️ **吸收强度必须随环境亮度减弱 —— 否则夜里双重压暗**（实测）。
    // 根因：反射 RT 里的世界**已经是夜景**（体素材质吃 uSkyDim 0.25、背景是 night 立方图），
    // 再乘一个为白昼标定的 0.30 吸收率 ⇒ 暗上加暗。实测：固定 0.30 时 night luma **65~69**
    //（冻结下界 70），而把 TINT 从 0.18 扫到 0.30 夜档几乎不动 ⇒ 不是参数大小问题。
    // 物理上：吸收是「光穿过水体被吃掉一部分」，环境光本就很弱时可吸收的绝对量也小，
    // 故有效反射率向 1 靠。回升量取 `1 − 均值(uWaterTint)`（环境变暗的程度）。
    // ⚠️ **晨/午 uWaterTint 恒中性 1** ⇒ 回升项 ≡ 0 ⇒ 有效反射率逐位等于 uReflectTint
    //（故本项不会动摇已验收的 morning/noon = 113）。
    // ⚠️ 上限 min(1.0)：超了就是「夜里水面比天空还亮」= 发光（用户 v2.1 报过的缺陷）。
    const albedo = uReflectTint;
    const reflLit = reflColor.mul(albedo);
    // ---- 高度 + 掠射衰减（v3.17b，用户：「距离水面一定高度后倒影越来越弱甚至消失」）----
    //
    // 物理依据 = Fresnel：掠射（贴水面看）几乎全反射，垂直俯视只反射 ~2%。
    // 相机升高 ⇒ 看同一片水的入射角变陡 ⇒ 倒影变弱。两层相乘：
    //   · `uReflectHeightFade`：全局（飞行高度），兼任 pass 的性能门；
    //   · `grazeTerm`：逐片元，复用上面**已在算**的 `fresnel`（不新写一份公式）。
    // ⚠️ grazeTerm **必须留地板**（mix(1−GRAZE, 1, fresnel)）：直乘 fresnel 时
    // 垂直俯视 fresnel→0 ⇒ 脚下水面倒影完全消失，与用户要的「朦胧映出地面物品」相背。
    // ⚠️ GRAZE=0 时 grazeTerm≡1、fade=1 时 ×1.0 在 IEEE754 下逐位精确 ⇒ 可单变量 A/B。
    const grazeTerm = mix(float(1.0).sub(uReflectGraze), float(1.0), fresnel);
    const reflStrength = uReflectStrength.mul(uReflectHeightFade).mul(grazeTerm);

    const depth = length(cameraPosition.sub(positionWorld));
    const fogFactor = smoothstep(uFogNear, uFogFar, depth);

    // ⚠️⚠️ **水色与倒影各自上雾、各自吃 tint，最后才混 —— 顺序是载荷性的**。
    //
    // 水色支：`mix(litColor, fogColor, fogFactor) × uWaterTint` —— **逐字即 v3.16 原式**。
    // ⚠️ tint 必须在雾混合**之后**（v2.2 修的根因，用户 2026-10-28：「傍晚和夜晚依然过于明亮」）：
    // `WATER_FOG_COLOR` 是正午口径常量、fogNear=20/fogFar=70，中远景海面几乎全由雾色决定。
    // 乘在 mix 之前时雾色不吃乘数 —— 实测夜晚远处 **182 比正午 156 还亮**（「像发光」的大头）；
    // 判别性证据：tint 0.62→0.34 时近处 114→76，而远处那一带恒定 182 一点没变。
    // 倒影支：`mix(reflLit, fogColor × uWaterTint, fogFactor)` —— **不乘 uWaterTint**。
    //
    // 为什么倒影不能再乘一次 tint（实测根因）：
    // `uWaterTint` 存在的理由是「水面基色是写死的常量、不跟环境亮度」（见上方 v2.1 注释），
    // 所以靠它手动压暗。而**反射 RT 里的世界本就已经是夜景**：体素材质吃了 `uSkyDim 0.25`、
    // 背景是 night 立方图 ⇒ 再乘 0.39 就是**双重压暗**。实测：固定反射率 0.30 时
    // noon 113 ✓ / dusk 84 ✓ / **night 65 ✗**（冻结下界 70）；改为本口径后四风格全入带。
    //
    // 远景倒影仍要淡入**水面的**雾色（同样吃 tint），否则远处会出现一块
    // 比周围亮的「镜面斑」—— RT 自带的场景雾与水面雾是两套参数，不能直接沿用。
    //
    // `reflStrength = 0` 时外层 mix 取左端 ⇒ **逐位回到 v3.16**（零回归锚点）。
    const waterLit = mix(litColor, uFogColor, fogFactor).mul(uWaterTint);
    const reflFogged = mix(reflLit, uFogColor.mul(uWaterTint), fogFactor);
    return mix(waterLit, reflFogged, reflStrength);
  })();

  const opacityNode = Fn(() => {
    const pos = positionWorld.xz;
    const dist = length(pos.sub(cameraPosition.xz));
    const waterFade = float(1.0).sub(smoothstep(float(fadeStart), float(fadeEnd), dist));
    return uOpacity.mul(waterFade);
  })();

  const waterMaterial = new THREE.NodeMaterial();
  waterMaterial.colorNode = colorNode;
  waterMaterial.opacityNode = opacityNode;

  waterMaterial.transparent = true;
  /**
   * **水面必须写深度**（v2.2）。
   *
   * 根因（用户 2026-10-28：「曳光线被波纹水面所遮挡……只有当曳光线入水后，才被水面所遮挡」）：
   * 水面与曳光都在 transparent 队列、原先**都不写深度**，而海面 `renderOrder = 1` 排在曳光
   * （默认 0）之后绘制 → 曳光先画却不留深度，海面后画时深度测试无条件通过 → **连同水面上方的
   * 曳光也被整片盖住**。
   *
   * 实测（同机位，曳光固定在水面上方 3 格 / 下方 3.5 格，两配置交替各 3 轮，可见像素）：
   * | 配置 | 水面上方 | 水面下方 |
   * |---|---|---|
   * | 修前（不写深度、曳光先画） | 1544 / 1544 / 1544 | 3134 / 3134 / 3135 |
   * | 修后（写深度、曳光后画 + 深度测试） | 3528 / 3528 / 3528 | **0 / 0 / 0** |
   *
   * ⚠️ **与 `tracer-renderer.js` 的 `renderOrder = 2` 是一组耦合约定**，改任一处都要一起看：
   * 只写深度而不把曳光排到海面之后 → 曳光先画仍会被海面混合覆盖；只排后画而不写深度 →
   * 海面不留深度，曳光在水下也照样透出来。
   * `Discard` 已处理遮罩/淡出区，不会把深度写进本该透明的像素。
   */
  waterMaterial.depthWrite = true;
  waterMaterial.side = THREE.DoubleSide;

  const plane = new THREE.Mesh(waterGeo, waterMaterial);
  plane.rotation.x = -Math.PI / 2;
  plane.position.y = WATER_LEVEL_OFFSET;
  // issue #2：透明排序按锚点 NDC 深度（海面锚点=相机正下方、体素通道锚点=合并几何
  // 包围球中心），镜头转动时两者交叉 → 绘制顺序翻转 → 水色离散跳变。
  // 固定 renderOrder 让海面恒在体素水（默认 0）之后绘制，退出深度排序。
  plane.renderOrder = 1;
  scene.add(plane);
  // 反射目标随水面平面（它每帧跟随相机）—— 镜面高度恒等 WATER_LEVEL_OFFSET。
  plane.add(reflectTarget);
  // 关掉自动触发：改由 Game 在主 render **之前**手动跑（原因见上方反射段的载荷性约束）。
  const reflectBase = reflectNode.reflector;
  const reflectUpdate = reflectBase.updateBefore.bind(reflectBase);
  reflectBase.updateBeforeType = THREE.NodeUpdateType.NONE;
  reflectBase.updateBefore = () => {};

  return {
    plane,
    /** 环境亮度乘数句柄（`DayNight` 经 `skyUniforms.uWaterTint` 写入；也供测试直接读） */
    uWaterTint,
    /** 湖区门控句柄（v2.14，供测试直接读；`setLakeCircle` 写入） */
    uLakeCircle,
    /**
     * 跑一次反射 pass。**只能由 `Game` 在主 `renderer.render()` 之前调**
     * （原因见上方反射段：后置会把主画面的天空撕碎）。
     *
     * ⚠️ 反射期间临时藏掉**第一人称手臂/武器**：它们挂在 camera 下，而反射用的是
     * 镜像虚拟相机 ⇒ 不藏的话水里会出现一条巨大的手臂倒影（调研截图里实测到）。
     * `hidden` 由调用方传入（装配层才知道 viewArm/viewWeapon），本模块不依赖 player/。
     *
     * @param {THREE.Camera} camera
     * @param {THREE.Material} material 水面材质（reflector 内部要临时置 visible=false）
     * @param {THREE.Object3D[]} [hidden] 反射期间需隐身的节点
     */
    renderReflection(camera, material, hidden) {
      let restored = null;
      if (hidden && hidden.length) {
        restored = [];
        for (const o of hidden) {
          if (!o) continue;
          restored.push([o, o.visible]);
          o.visible = false;
        }
      }
      /**
       * v3.30：反射期间也要藏掉**采样同一张 RT 的其他对象**（湿地面的体素通道）。
       *
       * ⚠️⚠️ **不藏会报 WebGPU 验证错误**（本轮实测）：
       * `Texture … usage (TextureBinding|RenderAttachment) includes writable usage
       *  and another usage in the same synchronization scope` —— 反射 pass 把 RT 当
       * 渲染目标（写），而体素 opaque 材质在同一 pass 里采样它（读）。
       * three 的 reflector 只藏掉**自己的** material（水面），不知道还有别的消费者。
       * ⇒ 由调用方把「其他采样者」一并传进 `hidden`（装配层才知道哪些通道挂了湿分支）。
       * ⚠️ 藏掉它们不影响主画面：反射 pass 结束后 finally 里恢复 visible，
       * 主 pass 照常画它们（只是反射里看不到地面 —— 而那正是上游的做法：
       * 它反射时也藏掉全部 groundMeshes）。
       */
      try {
        /**
         * v3.30：反射 pass 期间把**湿地面的反射采样**临时换成占位纹理。
         *
         * ⚠️⚠️ **为何必须这么做**（本轮单变量 A/B 实测）：
         * 反射 pass 把 RT 当渲染目标（写），而体素 opaque 的湿分支在同一 pass 里
         * 采样它（读）⇒ WebGPU 报 `writable usage and another usage in the same
         * synchronization scope`。
         * **藏掉 opaque 通道能消错，但会让水面倒影映不到地面**⇒ 水色真的变了
         * （morning 130→127 / noon 99→146 / share 4600→12000，撞冻结色阶）。
         * ⇒ 唯一两全的解法：**只把湿分支的采样源换成 1×1 占位图**，
         * 地面仍在反射里可见（水面倒影不变），而读写冲突消失。
         * ⚠️ `reflectNode.value` 每帧被 reflector 内部写成真 RT（见 three 源码），
         * 故只需在 pass **前**换成占位图、pass **后**不需手动恢复
         * （下一次 reflectUpdate 会自己写回）—— 但为了当帧主 pass 能立即用到真 RT，
         * 这里仍在 finally 里显式写回。
         */
        const wetNode = this._wetReflectNode;
        let savedTex = null;
        if (wetNode) {
          savedTex = wetNode.value;
          wetNode.value = placeholderTexture();
        }
        try {
          reflectUpdate({ scene, camera, renderer: this._renderer, material });
        } finally {
          /**
           * ⚠️⚠️ **pass 后必须把 clone.value 同步为 base 的真 RT**（本轮实测的根因）：
           * reflector 内部只写 `base.textureNode.value`，clone 的 value 是独立的
           * ⇒ 不同步的话 clone 永远停在默认占位 RT（从未被渲染）⇒ 湿地面反射恒黑。
           * 实测：同步前 A/B diff = 0；同步后 diff = 860002（93% 像素）。
           * ⚠️ 不能写成 `savedTex`（那是 clone 自己的旧值 = 占位图）。
           */
          if (wetNode) {
            const real = reflectBase.textureNode?.value;
            wetNode.value = real || savedTex;
          }
          /**
           * v3.30d：写**镜面投影矩阵**（湿地面采样坐标的唯一权威）。
           *
           * 上游 `uReflMatrix = bias · reflProj · reflView`，bias 把 NDC 的 [-1,1]
           * 映到 uv 的 [0,1]。本仓 WebGPU 的 NDC y 与 WebGL **同向**（three 内部
           * 已处理 coordinateSystem），但 RT 采样需 **flipY**（与 ocean 自己的
           * `screenUV.flipX()` 同一回事：RT 的 flipY 语义）⇒ bias 的 y 行取负。
           * ⚠️ 必须用**镜像相机**（reflectBase.virtualCameras 里的那一个），
           * 而不是主相机 —— 用主相机就回到了「片元自己的 screenUV」那个缺陷。
           */
          const vc = reflectBase.virtualCameras?.get?.(camera);
          if (vc && this._wetReflectMatrix) {
            this._wetReflectMatrix.value
              .copy(REFLECT_BIAS)
              .multiply(vc.projectionMatrix)
              .multiply(vc.matrixWorldInverse);
          }
        }
      } finally {
        // ⚠️ **必须在 finally 里恢复**：反射 pass 抛异常时若手臂永久隐身，
        // 玩家看到的是「手没了」—— 比倒影出错严重得多。
        if (restored) for (const [o, v] of restored) o.visible = v;
      }
    },
    /** 反射句柄（供测试与面板读 RT 尺寸/倍率） */
    reflect: reflectBase,
    /**
     * v3.30：**反射纹理节点**句柄（雨天湿地面用）。
     *
     * ⚠️ 与 `reflect`（base 节点，管 pass 调度）是两回事：湿地面要的是可采样、
     * 可改 uvNode/levelNode 的**TextureNode**。交出去让体素材质复用**同一条 pass**
     * （不新建第二个 reflector —— 两条 pass 会互相覆写 BatchedMesh 的 indirect
     * 索引表 ⇒ 天空撕成黑多边形，v3.17 实测）。
     *
     * ⚠️⚠️ **交的是 clone，但它的 value 必须每帧跟住 base 的真 RT**（本轮实测）：
     * `ReflectorNode.clone()` 只共享 base，**value 是独立的**，而 reflector 内部
     * 只把真 RT 写进 `base.textureNode.value` ⇒ clone 永远停在构造时的默认占位 RT
     * （实测：clone.uuid ≠ base.textureNode.uuid，且 clone 不在 base.renderTargets 里）
     * ⇒ 湿地面采到的是**从未被渲染过的空 RT** ⇒ 反射项恒黑（A/B diff = 0）。
     * ⇒ 由 `renderReflection` 在 pass 后把 clone.value 同步为 base 的真 RT（见下）。
     * 仍用 clone 的理由：反射 pass 期间要把**湿分支的**采样源换成占位图（避免同 pass
     * 读写同一张 RT），而水面自己的采样不受影响。
     */
    reflectTexture: reflectNode.clone(),
    /**
     * v3.30d：**镜面投影矩阵** uniform（湿地面用）。
     *
     * ⚠️⚠️ **为何必需它**（本轮用户报告「像在地下又有一层模糊的透射」的根因）：
     * 湿地面原本用**片元自己的 screenUV** 采样反射 RT。但反射 RT 是从**镜像相机**
     * 渲的 ⇒ 同一屏幕坐标在两张图里对应**不同的世界点**。
     * 地面高于镜面（本仓地形 y≈22、镜面 −1.5，差 **23.5 格**）时偏差极大
     * ⇒ 采到的是「该屏幕位置下方的另一个物体」⇒ 读作地下一层模糊透射。
     * 上游 `GROUND_VERT` 用的是 `vReflPos = uReflMatrix * vec4(wp.x, 0.0, wp.z, 1.0)`
     * —— 把世界点**压到镜面高度**后过反射相机的 bias·proj·view。
     * 本 uniform 就是那个 `uReflMatrix`，由 `renderReflection` 每帧写入。
     */
    reflectMatrix: { value: new THREE.Matrix4() },
    /** 倒影强度 uniform（0 = 逐位回到无倒影的原式） */
    uReflectStrength,
    /** 随波扰动幅度 uniform */
    uReflectDistort,
    /** 倒影朦胧度（mip 级别）uniform */
    uReflectMip,
    /** 相机高度衰减因子 uniform（由 Game 每帧写；1 = 满强度） */
    uReflectHeightFade,
    /** 掠射（视角）项权重 uniform（0 = 关掉该项） */
    uReflectGraze,
    /** 倒影反射率乘数 uniform（水面吸收；1 = 理想镜面） */
    uReflectTint,
    /** 注入 renderer（反射 pass 需要它；Game 在 renderer.init() 后调一次） */
    setRenderer(renderer) { this._renderer = renderer; },
    /**
     * v3.30：登记「湿地面的反射采样节点」（反射 pass 期间要临时换成占位图）。
     * 由装配层在创建 RenderWorld 后调一次（它才知道把哪个节点交给了体素材质）。
     */
    setWetReflectNode(node) { this._wetReflectNode = node || null; },
    /**
     * v3.30d：登记镜面投影矩阵 uniform（由装配层从本模块的 `reflectMatrix` 交过来，
     * 再传给体素材质）。pass 后写入它，湿地面靠它把世界点压到镜面高度再投影。
     */
    setWetReflectMatrix(u) { this._wetReflectMatrix = u || null; },
    /**
     * 改反射 RT 的分辨率倍率（0.1~1）。
     * ⚠️ **它不是性能旋钮**：实测 0.125 与 0.5 的提交耗时只差 0.1ms（成本在 draw call 数）。
     * 它的真实作用是显存与倒影锐度；省钱请用刷新间隔。
     */
    setReflectScale(v) {
      const n = Number(v);
      const s = Number.isFinite(n) ? Math.max(0.1, Math.min(1, n)) : REFLECT_RESOLUTION_SCALE;
      reflectBase.resolutionScale = s;
      return s;
    },
    /** 城市门控句柄（供测试直接读） */
    uCityBounds,
    /** 每帧：时间推进 + 跟随相机（无限水面） */
    update(camera, dt) {
      uTime.value += 0.015 * dt * 60;
      plane.position.x = camera.position.x;
      plane.position.z = camera.position.z;
    },
    setSeed(seed) { uSeed.value = seed; },
    /**
     * 接城市门控 bounds（全世界唯一，`CITY_REGION = [0,0]`）。
     * @param {{minX:number,maxX:number,minZ:number,maxZ:number}|null} city
     *   `buildCityLayout` 结果；null 或缺字段 → 恢复哨兵（门控关闭）。
     */
    setCityBounds(city) {
      const b = city && Number.isFinite(city.minX) ? city : OCEAN_MASK_NO_CITY;
      uCityBounds.value.set(b.minX, b.maxX, b.minZ, b.maxZ);
    },
    /**
     * 接浅水高台的湖盆圆（v2.14）。
     *
     * ⚠️ **不接的话湖面上只有体素水的静态顶面（无波纹）** —— 因为水域遮罩读的是
     * `generateHeight`（自然地形），而湖底是被整形压到 `SEA_Y-1` 的，自然高度没变。
     * 用户报告「水面的波纹并没有覆盖全部」就是这个。
     *
     * @param {{cx:number, cz:number, radius:number}|null} lake
     *   `null` 或缺字段 → 恢复哨兵（门控关闭，不影响任何点）。
     */
    setLakeCircle(lake) {
      const l = lake && Number.isFinite(lake.cx) && lake.radius > 0 ? lake : OCEAN_MASK_NO_LAKE;
      uLakeCircle.value.set(l.cx, l.cz, l.radius, 0);
    },
  };
}
