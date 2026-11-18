// src/render/turret-metal.js — 炮管/副武器的金属材质（深灰炮钢 + 随光照反光）
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
  float, vec3, uniform, mix, dot, max, normalize, pow, clamp,
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
 * 造一个金属材质。
 *
 * @param {{color: number, sunDirection: object, sunStrength?: object,
 *          sunColor?: object}} deps
 *        `sunDirection` **必须**传 `renderWorld.materials.dayNight.uSunDirection`。
 *        `sunStrength` / `sunColor` 可选（传入则跟随日夜强度与色温）。
 * @returns {THREE.MeshBasicNodeMaterial}
 */
export function createTurretMetalMaterial({ color, sunDirection, sunStrength, sunColor }) {
  const base = uniform(new THREE.Color(color));
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
  material.colorNode = clamp(base.mul(shade).add(reflect.mul(strength)), 0, 1);
  return material;
}