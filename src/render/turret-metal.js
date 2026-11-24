// src/render/turret-metal.js — 炮塔金属材质（深灰炮钢 + 随光照反光）
//
// 两类消费方（v3.14）：
//   · **炮管 / 副武器**：单一基色（`TURRET_GUN_COLOR`）；
//   · **装甲 6 部件**：三档基色（`TURRET_TONE_COLOR`），由逐顶点 `tone` 属性选。
// 两者共用同一套四项叠加，只差「基色怎么选」—— 故 draw call 与材质数不变。
//
// **为什么不用 MeshStandardMaterial**：本仓全场景是 unlit 设计，场景灯光只为 PBR 武器
// 模型标定（`game.js` 的 sunLight 那套）。实体若吃那套灯光会偏亮且随日夜漂移
// —— minecart/zombie/dragon/ignis/guardian 全部刻意用 MeshBasicMaterial。
// 故本模块自建 TSL 材质：**自己读太阳方向 uniform**，不接场景灯光。
//
// ⚠️⚠️ **太阳方向必须复用 `renderWorld.materials.dayNight.uSunDirection`**（红线 1）：
// 那是体素材质在用的同一个 uniform，由 DayNight 每帧写入。自己 new 一个会导致
// 「日夜变了、体素明暗跟着变，而炮管高光钉在正午方向」。
//
// ## 金属感的物理要点（实测标定，两条都踩过反例）
//
// **① 金属的反射被自身基色染色，不是白色。** 这是金属与塑料的分界：塑料的高光是
// 光源色（白），金属的高光是「基色 × 光源色」。初版把高光/环境项做成**白色加项**，
// 结果整根炮管被均匀抬到均值 130 的银灰色 —— 用户要的是**深灰**，那是塑料感。
// 正解：环境项与菲涅尔项都**乘基色**（保持深灰身份），只有镜面高光带允许提亮。
//
// **② 漫反射只能乘一次。** 初版 `base×diffuse` 之后又乘 `mix(1,diffuse,strength)`
// ⇒ diffuse 平方，深灰被压成近黑、高光带看不见。
//
// 四项叠加：漫反射 N·L（形体明暗）+ Blinn-Phong 高光（随视角滑动的光泽带）
// + 环境反射（反射向量 y 在天空/地面色间插值，**乘基色**）+ 菲涅尔掠射提亮（**乘基色**）。
//
// ⚠️ **法线用几何 normal 属性**（产物已带），不是体素的 packed 面索引 —— 炮管是曲面，
// 逐顶点法线才能出连续高光带；用面索引会退化成 6 个色块。
import * as THREE from 'three';
import {
  float, vec3, uniform, mix, dot, max, normalize, pow, clamp, select, attribute,
  cameraPosition, positionWorld, normalWorld,
} from 'three/tsl';

/**
 * 金属参数（唯一权威，渲染层与单测共用）。全部**实测标定**，见文件头两条反例。
 *
 * ⚠️ `ambient = 0.34`：深灰基色下背光面要压得住才是「深灰」；取 0.5 以上整根发银。
 * ⚠️ `shininess = 40`：太小（<16）高光糊成一片像塑料，太大（>128）缩成一个点、
 * 绕行走动时几乎看不见变化。40 在「有明确高光带」与「随视角滑动可见」之间。
 * ⚠️ `specular = 2.6` 看似很大，但它**乘了基色**（深灰 ≈ 0.07 线性）且被
 * `(N·H)^40` 与 `N·L` 双重收窄 ⇒ 只在窄高光带上冲到亮灰，其余仍是深灰。
 */
export const TURRET_METAL = Object.freeze({
  /** 高光锐度（Blinn-Phong 指数） */
  shininess: 40,
  /** 高光强度（乘基色后只在窄带上提亮） */
  specular: 2.6,
  /** 环境反射强度（乘基色，给冷/暖倾向而不抬亮度） */
  envStrength: 0.85,
  /** 环境反射的天空色（冷亮，映天光） */
  envSky: Object.freeze([0.72, 0.84, 1.05]),
  /** 环境反射的地面色（暖暗，映地表） */
  envGround: Object.freeze([0.42, 0.36, 0.28]),
  /** 菲涅尔边缘提亮强度（乘基色） */
  fresnel: 0.9,
  /** 菲涅尔幂次（越大越集中在掠射边缘） */
  fresnelPower: 4.0,
  /** 漫反射地板（深灰要压得住背光面） */
  ambient: 0.34,
});

/**
 * 自发光增益（士兵 Epic）—— 护目镜/胸灯的 aGlow 乘它叠到四项叠加之后。
 * 取 3.0：aGlow 已按上游 e/8 归一（护目镜 4.5/8≈0.56），×3 后约 1.7 ⇒ 经 ACES 滚落成亮红而不钳白。
 * ⚠️ 只在传了 glowAttribute 时生效，炮塔路径不读它。
 */
const SOLDIER_GLOW_GAIN = 3.0;

/**
 * 造一个金属材质。
 *
 * @param {{color: number, sunDirection: object, sunStrength?: object,
 *          sunColor?: object, tones?: readonly number[],
 *          vertexColor?: boolean, glowAttribute?: string}} deps
 *        `sunDirection` **必须**传 `renderWorld.materials.dayNight.uSunDirection`。
 *        `sunStrength` / `sunColor` 可选（传入则跟随日夜强度与色温）。
 *        `tones` 可选：三档基色 `[顶, 侧, 底]`（v3.14 装甲部件）。
 *        传了则基色由逐顶点 `tone` 属性（0/1/2）选；不传则用单一 `color`
 *        （炮管/副武器走这条，**逐位回到现状**）。
 *
 *        **士兵 Epic 新增两个可选项（缺省 undefined ⇒ 一行不走新分支，炮塔逐位不变）**：
 *        · `vertexColor: true` —— 基色改读逐顶点 `color` 属性（士兵每个盒颜色不同，
 *          三档 tone 不够表达）。⚠️ **不能用 `vertexColors:true` + colorNode 代替**：
 *          three 把顶点色乘在 colorNode **之后**，高光/环境/菲涅尔项会用**材质基色**
 *          而不是顶点色去染色（炮塔侧已记该实测）。故基色必须在进入四项叠加**之前**选好。
 *        · `glowAttribute: 'aGlow'` —— 自发光项（士兵护目镜 e=4.5 / 胸灯 e=2.5）。
 * @returns {THREE.MeshBasicNodeMaterial}
 */
export function createTurretMetalMaterial({
  color, sunDirection, sunStrength, sunColor, tones, vertexColor, glowAttribute,
}) {
  // 基色：单一色 or 三档选色。
  //
  // ⚠️⚠️ **不能用 `vertexColors: true` + `color` 属性代替**（设计文档 §6.1 否决项 B）：
  // three 把顶点色乘在 `colorNode` **之后**（`three.webgpu.js` 的 setupDiffuseColor）
  // ⇒ 本函数的高光/环境/菲涅尔项会用**材质基色**而不是顶点色去染色，
  // 三档的反射色调全错（而亮度层次看上去「像是生效了」）。
  // 故基色必须在**进入四项叠加之前**就选好。
  //
  // ⚠️⚠️ **不得写 `vec3(new THREE.Color(hex))`**（v3.14 实测缺陷）：
  // 那种单参数形式在 WebGPU 后端**输出纯黑且零报错** —— 装甲 6 部件整片消失，
  // 而 tone 属性/值域/冻结表/材质类型判据全绿。根因：`vec3` 单参数走「转成 vec3」
  // 路径，而 `getValueType(Color)` 返回 `'color'` 不是 `'vec3'` ⇒ 转换拿不到分量。
  // 逐写法实测（同一几何同一相机，非黑像素数）：
  //   vec3(Color) **0** / vec3(c.r,c.g,c.b) 10455 / color(hex) 10455 / uniform(Color) 10455
  // 正解：**显式拆分量** `vec3(c.r, c.g, c.b)`。
  //
  // ⚠️ **用 `select` 链而不是查表数组**：照 `materials.js` 的面法线解码同手法
  // （GLSL 无动态索引常量数组的便携写法）。tone 是逐顶点常量 ⇒ 编译期可折叠。
  let base;
  if (vertexColor) {
    // 士兵：逐顶点任意色（已在几何侧转成线性 RGB）
    base = attribute('color', 'vec3');
  } else if (tones) {
    const t = attribute('tone');
    const nodes = tones.map((hex) => {
      const c = new THREE.Color(hex);
      return vec3(c.r, c.g, c.b);
    });
    base = nodes.slice(1).reduce((acc, n, i) => select(t.equal(i + 1), n, acc), nodes[0]);
  } else {
    base = uniform(new THREE.Color(color));
  }
  const shine = float(TURRET_METAL.shininess);
  const specK = float(TURRET_METAL.specular);
  const envK = float(TURRET_METAL.envStrength);
  const fresK = float(TURRET_METAL.fresnel);
  const fresP = float(TURRET_METAL.fresnelPower);
  const ambient = float(TURRET_METAL.ambient);
  const envSky = vec3(...TURRET_METAL.envSky);
  const envGround = vec3(...TURRET_METAL.envGround);

  const N = normalize(normalWorld);
  const L = normalize(sunDirection);
  const V = normalize(cameraPosition.sub(positionWorld));
  const H = normalize(L.add(V));

  // ① 漫反射：N·L 映射到 [ambient, 1]，**只乘一次**
  const ndl = max(dot(N, L), float(0));
  const diffuse = mix(ambient, float(1), ndl);

  // ② 镜面：Blinn-Phong，双重收窄（(N·H)^shine 与 N·L 门）⇒ 窄而亮的高光带
  const ndh = max(dot(N, H), float(0));
  const specBand = pow(ndh, shine).mul(ndl);

  // ③ 环境反射：R = 2(N·V)N − V，按 R.y 在天空色/地面色间插值
  const R = N.mul(dot(N, V).mul(2)).sub(V);
  const envTint = mix(envGround, envSky, R.y.mul(0.5).add(0.5).clamp(0, 1));

  // ④ 菲涅尔：掠射角提亮
  const ndv = max(dot(N, V), float(0));
  const fresBand = pow(float(1).sub(ndv), fresP);

  const strength = sunStrength ?? float(1);
  const shade = mix(float(1), diffuse, strength);
  // ⚠️ **金属的反射被基色染色**：环境/菲涅尔/高光全部乘 base（见文件头要点 ①）。
  // 高光额外乘 sunColor（光源色温），环境/菲涅尔吃环境倾向不额外染色。
  const specTint = sunColor ? base.mul(sunColor) : base;
  const reflect = specTint.mul(specBand).mul(specK)
    .add(base.mul(envTint).mul(envK))
    .add(base.mul(fresBand).mul(fresK));

  const material = new THREE.MeshBasicNodeMaterial({ side: THREE.DoubleSide });
  let out = clamp(base.mul(shade).add(reflect.mul(strength)), 0, 1);
  // 自发光（士兵护目镜/胸灯）：叠在四项叠加之后，不被 shade 压暗。
  // ⚠️ 缺省无 glowAttribute 时**一行不走**，炮塔输出逐位不变。
  if (glowAttribute) {
    const glow = attribute(glowAttribute, 'float');
    out = clamp(out.add(base.mul(glow).mul(SOLDIER_GLOW_GAIN)), 0, 1);
  }
  material.colorNode = out;
  return material;
}