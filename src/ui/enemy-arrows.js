// src/ui/enemy-arrows.js — 屏外敌人方位箭头（用户 2026-11-26）
//
// 用户原话：「在屏幕的四周加上指示箭头，来指示丧尸、soldier、飞龙、焰魔、末影守卫等敌人的
// 位置，因为地图很大，很容易找不到敌人的位置，如果敌人不在玩家的视口范围内，就给一个小箭头
// 指示敌人的位置，用不同颜色的小三角形来指示」。
//
// 三项裁定（`ask_user_question` 2026-11-26）：
//   ① 守卫用**粉红**（用户写的「分红」确认是粉红），与飞龙的紫分得开；
//   ② **每类只画最近一只** + 旁边标该类**屏外**总数 —— 20 只丧尸每只一个箭头会把边框挤满；
//   ③ 带**距离读数** + **远近透明度**（远淡近实），地图大时要能判断值不值得跑过去。
//
// 设计稿：docs/superpowers/specs/2026-11-26-enemy-offscreen-arrows-design.md
//
// ## 为什么是 DOM 而不是世界内 billboard / 后处理
//
// 与血心/快捷栏/坐标面板/迷你地图/伤害数字同口径：HUD 是 DOM 覆盖层，零 draw call、
// 零 GPU 资源。世界内标记要逐实体几何与材质（撞既有「零实例必须 visible=false」预算口径），
// 后处理要多一个 render pass 并单独做像素标定。五个三角是五个常驻 `<div>`，空闲时零成本。
//
// ## three-free（`src/ui/` 既有口径）
//
// 本模块**不 import three**：世界坐标 → 相机空间由构造期注入的 `cameraSpaceFn` 完成
// （生产装配在 `game.js`，用一个 scratch `Vector3` 乘 `camera.matrixWorldInverse`）。
//
// ⚠️⚠️ **只注入一个相机空间函数，且它只判可见性**：`cameraSpaceFn` 回答「玩家看得见它吗」
// （这需要真实相机朝向，含 pitch）；方位另走 `arrowDirection`（只吃 yaw）。
// 两者职责不同，**不是两套口径** —— 把含 pitch 的 camSpace 拿去算方位就是 v3.42 的缺陷。
//
// ## ⚠️⚠️ 方位与相机朝向解耦（v3.43 用户实玩报障后的修正）
//
// **箭头表达的是「敌人相对玩家身体的方位」，不是「敌人相对镜头的投影」。**
//
// v3.42 用真实相机空间 + `|cz|` 算方位，而相机空间**含玩家俯仰** ⇒ 同一只身后丧尸：
//   pitch 0° → 下边；pitch +30°（抬头）→ **上边**；+60° → **上边**。
// 用户原话：「如果敌人在身后……不要显示在上方，显示在上方，就给人感觉好像在空中一样」。
// 那不是参数问题，是把镜头朝向当成了方位。
//
// 现在分两个职责，**各走一条路**：
//   · `arrowNdc` + `isOffscreen`（含 pitch 的真实相机空间）—— **只判可见性**；
//   · `arrowDirection`（**只吃 yaw** 的双轴模型）—— 算方位与落点。
//
// 双轴模型（参数在 `ARROW_BEARING`，已实测冻结）：
//   sx = sin(b)·W                                 横向：右正左负
//   sy = back·D − sin(elev)·H − sky·1.2H + deep·1.2H
//        back = max(0,−cos b)^0.7                  身后程度（≤90° 为 0）
// ⇒ **身后归下边、头顶上空归上边**（后者幅度压过前者，所以身后高空的飞龙仍在上边），
// 且全部由 sin/cos/max/pow 组成、**无分支切换** ⇒ 转身连续（实测最大 48px，
// 而分带方案跳 645~735px = 半屏，观感是「箭头闪现」）。
//
// ⚠️ **求交必须用按屏幕比例内缩的矩形**（`arrowPlacementFromDir`），再钳进 margin 安全带。
// 直接与 margin 矩形（578×330）求交时宽高比 ≠ 屏幕（1280×720）⇒ 斜方向被误判到上下边。
//
// ## 计数口径：士兵必须排除留尸
//
// 与 `enemy-counts.js` 同因：士兵死后留尸 1.2s（渲染要画倒地），尸体仍在实体集合里且
// `state.dead === true` ⇒ 不过滤的形态是「打死了箭头还在」。其余四类致死即 despawn。
//
// ## 锚点取身体中心，不是脚底
//
// 丧尸/士兵/焰魔/守卫的 `state.position` 是**脚底**，飞龙是**体心**（实测冻结在
// `tests/enemy-roster.mjs`）。指示的是实体本体 ⇒ 脚底类型取 `y + height/2`，龙取 `y`。
// 身高从各 config 直接派生，**不 import 测试侧名册**（那会给 ui → tests 开一条反向边）。
//
// ⚠️ 本文件的 CSS 是 JS 模板字面量：注释里**禁用反引号**包裹标识符（会提前终止模板串
// → 整个模块解析失败 → 游戏页白屏）。与 toast.js / boss-hint.js 同一陷阱。
import { ZOMBIE } from '../entities/zombies/zombie-config.js';
import { SOLDIER, SOLDIER_TYPE } from '../entities/soldiers/soldier-config.js';
import { IGNIS, IGNIS_TYPE } from '../entities/ignis/ignis-config.js';
import { GUARDIAN, GUARDIAN_TYPE } from '../entities/guardian/guardian-config.js';
import { DRAGON_TYPE } from '../entities/dragons/dragon-config.js';

/** 容器元素 id（E2E 的 DOM 契约） */
export const ARROW_ID = 'mc-enemy-arrows';

/**
 * 五类配色（**唯一权威**，用户 2026-11-26 裁定）。
 *
 * · soldier 取**纯白** `#ffffff`（用户同日追加：「把 soldier 的灰色箭头改为纯白色」；
 *   v3.42 曾用偏冷亮灰 `#9aa3ad`）；
 * · 紫 `#a855f7` 与粉红 `#ff69b4` 色相分得开（用户确认过这一对）；
 * · 每个三角另带 1px 深色 drop-shadow，保证在亮草地与雪地上也读得出
 *   （纯白尤其依赖它 —— 雪地/白墙上无描边就消失）。
 */
export const ARROW_COLORS = Object.freeze({
  zombie: '#4ade80',
  soldier: '#ffffff',
  dragon: '#a855f7',
  guardian: '#ff69b4',
  ignis: '#facc15',
});

/**
 * 五类登记（顺序 = 屏幕上的推开顺序，也是 `enemyArrowTargets` 的输出顺序）。
 *
 * ⚠️ `type` 全部从各自 config import —— 在这里写字面量就是第二份类型名权威
 * （改名时静默读成 0）。丧尸的类型名历史上是字面量 `'zombie'`（`zombie-system.js`
 * 直接用它），故此处显式注明，不在两处各猜一份。
 * ⚠️ `height` 是**脚底语义**类型的 AABB 高；龙是体心语义，`height: null` 表示不偏移。
 */
export const ENEMY_ARROW_ROWS = Object.freeze([
  Object.freeze({ key: 'zombie', type: 'zombie', color: ARROW_COLORS.zombie, height: ZOMBIE.height }),
  Object.freeze({ key: 'soldier', type: SOLDIER_TYPE, color: ARROW_COLORS.soldier, height: SOLDIER.height }),
  Object.freeze({ key: 'dragon', type: DRAGON_TYPE, color: ARROW_COLORS.dragon, height: null }),
  Object.freeze({ key: 'guardian', type: GUARDIAN_TYPE, color: ARROW_COLORS.guardian, height: GUARDIAN.height }),
  Object.freeze({ key: 'ignis', type: IGNIS_TYPE, color: ARROW_COLORS.ignis, height: IGNIS.height }),
]);

/** 类型名 → 登记项（派生，不写第二份 if 链） */
const ROW_BY_TYPE = new Map(ENEMY_ARROW_ROWS.map((r) => [r.type, r]));

/**
 * 观感与几何常量。
 */
export const ARROW_GEOM = Object.freeze({
  /**
   * z-index = 52。
   *
   * ⚠️ 改这里必须重核 `CLAUDE.md` 的「UI 层级不等式」：
   * hotbar 40 < 迷你地图 45 < 坐标/性能面板 50 = 血心 50 = 计数行 50 = Boss 提示 50
   * < **本箭头 52** < 伤害数字 55 < 受伤红闪 56 < 设置按钮 60 < 设置面板 70 < 背包 80
   * < 浮层 85 < toast 90 < loading 95 < 启动错误遮罩 100。
   *
   * 为什么不取 50：与看板/血心同层时 DOM 顺序决定谁压谁，箭头贴在屏幕边缘会与该处的
   * 性能看板/坐标面板抢位。取 52 让它稳定压过常驻读数，又低于一切瞬时反馈与模态。
   * **不得取 100+**（会盖掉 WebGPU 启动失败遮罩）。
   */
  zIndex: 52,
  /**
   * 左右边的内缩量（CSS px）。
   *
   * ⚠️ **必须比上下边大**：读数行（`×3 137m`，11px monospace 约 53px 宽）是**水平**的，
   * 摆在箭头朝屏幕内侧那一面 ⇒ 左右两侧要预留它的宽度，否则文字被 `overflow:hidden`
   * 静默裁掉（形态是「箭头在但读不出数量与距离」）。
   */
  marginX: 62,
  /** 上下边的内缩量（CSS px）= 三角 14 + 读数行 16 */
  marginY: 30,
  /** 跨类沿边缘的最小间距（CSS px）：五类都指同一侧时不许叠在一起 */
  minGap: 34,
  /** 三角长度（CSS px，指向方向上的尺寸）；宽 = 它的一半 */
  sizePx: 14,
  /** 远近透明度：≤near 实心 */
  near: 16,
  /** 远近透明度：≥far 恒 minOpacity（仍可辨认，不消失） */
  far: 160,
  /** 最远处的不透明度下限 */
  minOpacity: 0.35,
});

/** 相机背后的判定阈值（与 `DamageNumbers` 的 projectFn 逐字同口径） */
const BEHIND_EPS = 0.05;
/** 退化阈值：小于它的分母/向量长度按 0 处理（防 Infinity / NaN） */
const TINY = 1e-9;

/**
 * 双轴方位模型的参数（v3.43，**实测冻结**）。
 *
 * 设计稿：docs/superpowers/specs/2026-11-26-enemy-arrow-intuitive-bearing-design.md
 *
 * ⚠️⚠️ **五个参数互相制约，改任何一个都要重跑两道判据**：
 *   ① 18 个直觉场景 × 7 个俯仰角（`test-enemy-arrow-bearing.js`）；
 *   ② 身后地面敌人不得漏到上边（3368 样本）。
 * 实测过的反例：单独把 `D` 调到 5 会把「身后高空 +20 格的飞龙」全部推到**下边**，
 * 直接违反用户「头顶上空的飞龙该在上边」那条诉求。
 */
export const ARROW_BEARING = Object.freeze({
  /** 横向增益：sx = sin(bearing) · W */
  W: 2.2,
  /**
   * 身后偏置强度（决定侧/后分界，实测 ≈104°）。
   * 越大越贴近「过了正侧方就算身后」，但转身跳变也越大。
   */
  D: 3,
  /** 高度项增益：头顶上空压向上边、脚下深处压向下边 */
  H: 3.2,
  /** 头顶/脚下的额外加权门槛（度）—— 取垂直半视场角，不是随手定的数 */
  skyDeg: 35,
  /**
   * 身后程度的幂次（**载荷性，不得改成 1**）。
   *
   * ☠️☠️ 实测：pow=1（即直接 `max(0,−cos b)`）时，刚过正侧方 3°（bearing 93°）
   * 的高台敌人 `back` 仅 **0.052**，而高度项 `sin(18.4°)·H` 达 **1.58** ⇒
   * **身后高台敌人被归到上边**（实测 24/3368 样本）。pow=0.7 让 back 在刚过 90°
   * 时就快速抬起，泄漏归零。
   *
   * ⚠️ **不得用「给 back 加下限 floor」代替** —— 实测 floor=0.08 虽也能消泄漏，
   * 但引入不连续点，转身跳变从 48px 恶化到 **108px**（floor=0.25 时 280px）。
   */
  backPow: 0.7,
  /** 比例内缩矩形的边距（CSS px）：求交用它，**不是** marginX/marginY */
  rayInset: 40,
});

/**
 * 世界差值 → **yaw-only 玩家帧**（不含 pitch）。
 *
 * ⚠️⚠️ **这是 v3.43 的核心：方位与相机朝向解耦**。
 * v3.42 用真实相机空间（含玩家 pitch）算方位，于是「敌人在身后」这件事的屏幕表达
 * 随玩家抬头低头而变 —— 实测同一只身后丧尸：pitch 0° → 下边；+30° → **上边**；
 * +60° → **上边**。用户读作「好像在空中」。
 *
 * 箭头表达的是「敌人相对玩家**身体**的方位」，不是「相对镜头的投影」：
 * 抬头低头不该改变任何箭头的边，只有转身才该改变。
 *
 * 旋转约定与 `player.js` 一致（`camera.rotateY(yaw)` 的逆）：
 *   right = (cos yaw, 0, −sin yaw) · d
 *   ahead = (−sin yaw, 0, −cos yaw) · d
 *
 * @param {[number,number,number]} delta 世界差值（目标 − 玩家）
 * @param {number} yaw 玩家偏航（弧度；yaw=0 朝北 = −Z）
 * @returns {[number,number,number]} [right, up, z]；**ahead = −z**
 */
export function arrowBearingFrame(delta, yaw) {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  return [delta[0] * c - delta[2] * s, delta[1], delta[0] * s + delta[2] * c];
}

/**
 * 双轴加性方位模型：世界差值 + yaw → 屏幕方向（y 向下）。
 *
 *   sx = sin(b) · W                       横向：右正左负，正前/正后 = 0
 *   sy = back·D − sin(elev)·H − sky·1.2H + deep·1.2H
 *        back = max(0, −cos b) ^ backPow   身后程度：≤90° 为 0，正后方为 1
 *        sky  = max(0, (elev−35°)/(90°−35°))   头顶上空额外加权
 *        deep = max(0, (−elev−35°)/(90°−35°))  脚下深处额外加权
 *
 * · **身后 ⇒ 下边**：`back` 只在 |b|>90° 才为正；
 * · **头顶 ⇒ 上边**：`sky` 幅度足以压过 `back` ⇒ 身后高空的飞龙仍在上边；
 * · **连续**：全由 sin/cos/max/pow 组成，无分支切换 ⇒ 转身实测最大跳变 48px
 *   （分带方案实测跳 645~735px，观感是「箭头闪现」）。
 *
 * ⚠️ **签名里没有 pitch，这是刻意的**：俯仰无关性是本轮的核心不变式。
 *
 * @param {[number,number,number]} delta 世界差值
 * @param {number} yaw
 * @returns {{sx:number, sy:number}}
 */
export function arrowDirection(delta, yaw) {
  const [dx, dy, dz] = delta;
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || !Number.isFinite(dz)) {
    return { sx: 0, sy: 1 };   // 非法输入：稳定指向下边，不产 NaN
  }
  const [rx, up, z] = arrowBearingFrame(delta, yaw);
  const ahead = -z;
  const hd = Math.hypot(rx, z);
  const b = Math.atan2(rx, ahead);
  const elev = Math.atan2(up, Math.max(hd, TINY));
  const back = Math.pow(Math.max(0, -Math.cos(b)), ARROW_BEARING.backPow);
  const lim = (ARROW_BEARING.skyDeg * Math.PI) / 180;
  const span = Math.PI / 2 - lim;
  const sky = Math.max(0, (elev - lim) / span);
  const deep = Math.max(0, (-elev - lim) / span);
  const { W, D, H } = ARROW_BEARING;
  return {
    sx: Math.sin(b) * W,
    sy: back * D - Math.sin(elev) * H - sky * H * 1.2 + deep * H * 1.2,
  };
}

/**
 * 屏幕方向 → 边框落点。
 *
 * ⚠️⚠️ **必须与「按屏幕比例内缩」的矩形求交，再钳进 margin 安全带**。
 * v3.42 直接与 margin 矩形（578×330）求交，而屏幕是 1280×720 —— 两者宽高比不同
 * ⇒ 斜 45° 的方向被判到上下边（几何伪象，不是方位语义）。
 * 正解：求交矩形的 hw/hh **等于屏幕 aspect**，落点再钳到 margin 内。
 *
 * @param {number} sx @param {number} sy 方向（y 向下，长度任意）
 * @param {number} vw @param {number} vh 视口 CSS 尺寸
 * @returns {{x:number, y:number}}
 */
export function arrowPlacementFromDir(sx, sy, vw, vh) {
  const len = Math.hypot(sx, sy);
  // 零方向（正前/正后方的退化）：稳定取「指向下边」，不得产 NaN
  const ux = len > TINY ? sx / len : 0;
  const uy = len > TINY ? sy / len : 1;
  const aspect = vw / vh;
  // 比例内缩矩形：hw/hh 恒等于屏幕 aspect（窄屏下钳到 1px 防负值）
  const hw = Math.max(1, vw / 2 - ARROW_BEARING.rayInset);
  const hh = Math.max(1, hw / (Number.isFinite(aspect) && aspect > TINY ? aspect : 1));
  const tx = Math.abs(ux) > TINY ? hw / Math.abs(ux) : Infinity;
  const ty = Math.abs(uy) > TINY ? hh / Math.abs(uy) : Infinity;
  const t = Math.min(tx, ty);
  const rawX = vw / 2 + ux * t;
  const rawY = vh / 2 + uy * t;
  // 钳进 margin 安全带（窄屏下 margin 可能超过半屏 ⇒ 退化为屏幕中线）
  const mx = Math.min(ARROW_GEOM.marginX, vw / 2);
  const my = Math.min(ARROW_GEOM.marginY, vh / 2);
  return {
    x: Math.max(mx, Math.min(vw - mx, rawX)),
    y: Math.max(my, Math.min(vh - my, rawY)),
  };
}

/**
 * 世界点的相机空间坐标 → 真实透视 NDC（y 向下）。
 *
 * ⚠️⚠️ **v3.43 起本函数只用于判可见性（`isOffscreen`），不再用于算方位**。
 * 它含玩家 pitch，而方位必须与相机朝向解耦（见 `arrowDirection`）。
 * v3.42 用它算方位的形态是「玩家一抬头，身后丧尸跑到屏幕上边」（用户实玩报障）。
 *
 * @param {[number,number,number]} camSpace 相机空间坐标（three 相机看 −Z）
 * @param {number} tanHalfFov `tan(camera.fov·π/360)`
 * @param {number} aspect 视口宽高比
 * @returns {{sx:number, sy:number, behind:boolean}}
 */
export function arrowNdc(camSpace, tanHalfFov, aspect) {
  const [cx, cy, cz] = camSpace;
  const behind = !(cz < -BEHIND_EPS);
  const depth = Math.abs(cz) * tanHalfFov;
  // 退化（cz≈0 / fov 非法）：返回零向量而不是 Infinity —— 调用方会把它当「正前/正后方」
  if (!(depth > TINY) || !(aspect > TINY)) return { sx: 0, sy: 0, behind };
  return { sx: cx / (depth * aspect), sy: -cy / depth, behind };
}

/**
 * 是否在视口之外（含相机背后）。
 * @param {{sx:number, sy:number, behind:boolean}} ndc
 * @returns {boolean}
 */
export function isOffscreen(ndc) {
  return ndc.behind || Math.abs(ndc.sx) > 1 || Math.abs(ndc.sy) > 1;
}

/**
 * 远近透明度包络：≤16 格实心 → ≥160 格恒 0.35，线性。
 *
 * ⚠️ **非法值按最近算（返 1），绝不产 NaN**：NaN 写进 `style.opacity` 会被浏览器
 * 静默忽略 ⇒ 箭头卡在上一次的亮度上（与红闪那条坑同形）。
 *
 * @param {number} distance 玩家到目标的三维欧氏距离（格 = 米）
 * @returns {number} [minOpacity, 1]
 */
export function arrowOpacity(distance) {
  const { near, far, minOpacity } = ARROW_GEOM;
  if (!Number.isFinite(distance) || distance <= near) return 1;
  const t = (distance - near) / (far - near);
  return Math.max(minOpacity, Math.min(1, 1 - t));
}

/**
 * 从实体集合选出每类的箭头目标（纯函数，无 DOM，Node 单测直接驱动）。
 *
 * 规则：
 *   · 只收五个登记类型（炮塔/矿车/火球/弹丸/岩石一律不指示）；
 *   · **士兵排除 `state.dead === true`**（留尸不算敌人）；
 *   · 锚点 = 身体中心（脚底语义 +height/2，龙体心不偏移）；
 *   · 只统计**屏外**的个体，`count` 是屏外总数（已经看得见的不算「还没找到」）；
 *   · 每类取欧氏距离**最近**的那只作为指向目标。
 *
 * @param {Iterable<{type:string, state:{position:number[], dead?:boolean}}>} entities
 * @param {{x:number,y:number,z:number}} playerPos
 * @param {(worldPos:[number,number,number]) => [number,number,number]} cameraSpaceFn
 *        **只用于判可见性**（含 pitch 的真实相机空间）。方位由 `arrowDirection` 算，
 *        它只吃 yaw —— 两者职责不同，不是两套口径（v3.43）。
 * @param {number} tanHalfFov @param {number} aspect
 * @returns {Array<{key:string,type:string,color:string,count:number,distance:number,
 *                  delta:[number,number,number]}>} 按 `ENEMY_ARROW_ROWS` 顺序，只含有目标的类
 */
export function enemyArrowTargets(entities, playerPos, cameraSpaceFn, tanHalfFov, aspect) {
  const acc = new Map();
  for (const e of entities) {
    const row = ROW_BY_TYPE.get(e?.type);
    if (!row) continue;
    const st = e.state;
    const pos = st?.position;
    if (!Array.isArray(pos)) continue;
    // 士兵留尸：尸体仍在集合里（渲染要画倒地），但它不是敌人
    if (row.type === SOLDIER_TYPE && st.dead === true) continue;
    const [x, y, z] = pos;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    const ay = row.height === null ? y : y + row.height / 2;
    const camSpace = cameraSpaceFn([x, ay, z]);
    if (!isOffscreen(arrowNdc(camSpace, tanHalfFov, aspect))) continue;
    const d = Math.hypot(x - playerPos.x, ay - playerPos.y, z - playerPos.z);
    let slot = acc.get(row.key);
    if (!slot) { slot = { count: 0, distance: Infinity, delta: null }; acc.set(row.key, slot); }
    slot.count += 1;
    if (d < slot.distance) {
      slot.distance = d;
      // ⚠️ 存**世界差值**而不是 camSpace（v3.43）：方位要用 yaw-only 帧重算，
      // 拿含 pitch 的 camSpace 去算就又把相机朝向抄回来了。
      slot.delta = [x - playerPos.x, ay - playerPos.y, z - playerPos.z];
    }
  }
  const out = [];
  for (const row of ENEMY_ARROW_ROWS) {
    const slot = acc.get(row.key);
    if (!slot || slot.count === 0) continue;
    out.push({
      key: row.key, type: row.type, color: row.color,
      count: slot.count, distance: slot.distance, delta: slot.delta,
    });
  }
  return out;
}

/**
 * 跨类沿边缘推开：五类都指同一侧时不许叠在一起。
 *
 * 只沿**所在那条边的切向**平移，**不改指向角度**（改了就是在指别的地方）。
 * 按 `ENEMY_ARROW_ROWS` 顺序处理，后来者让位；推完钳在内缩矩形内。
 *
 * ⚠️ 判「同一条边」用**落点是否贴在该边的内缩界上**（容差 0.5px），而不是按角度分象限：
 * 斜方向的箭头恰好落在角上时两条边都贴，按角度分会把它归错边、推的方向也就错了。
 *
 * @param {Array<{key:string,x:number,y:number,deg:number}>} places 已算好的落点（原地改 x/y）
 * @param {number} vw @param {number} vh
 */
export function spreadArrows(places, vw, vh) {
  const { marginX, marginY, minGap } = ARROW_GEOM;
  const left = marginX, right = vw - marginX, top = marginY, bottom = vh - marginY;
  const EPS = 0.5;
  /** 落在哪条边（可能两条，角上）；返回 'v'（左右竖边，沿 y 推）/'h'（上下横边，沿 x 推） */
  const sideOf = (p) => {
    const onVertical = Math.abs(p.x - left) < EPS || Math.abs(p.x - right) < EPS;
    return onVertical ? 'v' : 'h';
  };
  for (let i = 0; i < places.length; i += 1) {
    const cur = places[i];
    const side = sideOf(cur);
    for (let j = 0; j < i; j += 1) {
      const prev = places[j];
      if (sideOf(prev) !== side) continue;
      // 同一条边还要求真的在同一条（左边 vs 右边、上边 vs 下边）
      if (side === 'v') {
        if (Math.abs(prev.x - cur.x) > EPS) continue;
        if (Math.abs(prev.y - cur.y) >= minGap) continue;
        // 往下推；越过下界则改往上推（保证仍有一个可行位置）
        let ny = prev.y + minGap;
        if (ny > bottom) ny = prev.y - minGap;
        cur.y = Math.max(top, Math.min(bottom, ny));
      } else {
        if (Math.abs(prev.y - cur.y) > EPS) continue;
        if (Math.abs(prev.x - cur.x) >= minGap) continue;
        let nx = prev.x + minGap;
        if (nx > right) nx = prev.x - minGap;
        cur.x = Math.max(left, Math.min(right, nx));
      }
    }
  }
  return places;
}

/**
 * 屏外敌人方位箭头的 DOM 覆盖层。
 *
 * 五个常驻槽（构造期一次建好，隐藏复用，不随敌人增删 DOM 节点）。
 * 每槽 = 外层定位容器（**不旋转**）→ 三角 `<i>`（旋转）+ 读数 `<span>`（**始终水平**，
 * 转过的数字读不出来）。
 *
 * ⚠️ **刷新必须在 `renderer.render()` 之后**（装配层的帧循环位置）：本类读相机空间，
 * 而 `camera.matrixWorldInverse` 由 render 每帧重算 —— 在 render 之前读的是上一帧的矩阵，
 * 箭头会滞后一帧（龙飞 9 格/秒时肉眼可见地甩在身后）。与 `_damageNumbers` 同一理由。
 */
export class EnemyArrows {
  /**
   * @param {HTMLElement} root HUD 容器（`#hud-root`）
   * @param {object} game `Game` 实例（只读 `entities` / `player.physics.pos` / `camera.fov`）
   * @param {(worldPos:[number,number,number]) => [number,number,number]} cameraSpaceFn
   *        世界坐标 → 相机空间（**每次返回新数组**：目标选择要同时持有五类的 camSpace）
   */
  constructor(root, game, cameraSpaceFn) {
    if (typeof cameraSpaceFn !== 'function') {
      throw new Error('EnemyArrows 需要注入 cameraSpaceFn（世界坐标 → 相机空间）');
    }
    this.game = game;
    this.cameraSpaceFn = cameraSpaceFn;

    this.el = document.createElement('div');
    this.el.id = ARROW_ID;
    this.el.style.cssText =
      `position:fixed;inset:0;z-index:${ARROW_GEOM.zIndex};` +
      'pointer-events:none;overflow:hidden;';

    const half = ARROW_GEOM.sizePx / 2;
    /** @type {Map<string, {box:HTMLElement, tri:HTMLElement, label:HTMLElement, last:object}>} */
    this._slots = new Map();
    for (const row of ENEMY_ARROW_ROWS) {
      const box = document.createElement('div');
      box.id = `${ARROW_ID}-${row.key}`;
      box.dataset.enemy = row.key;
      box.style.cssText = 'position:absolute;left:0;top:0;display:none;will-change:transform,opacity;';

      // 三角：CSS border 技巧，默认**朝右**（0°），故 rotate(deg) 与 atan2 同口径。
      // 定位在容器原点居中（margin 负 half）⇒ 容器坐标就是箭头中心。
      const tri = document.createElement('i');
      tri.style.cssText =
        `position:absolute;left:${-ARROW_GEOM.sizePx / 2}px;top:${-half}px;` +
        `width:0;height:0;border-top:${half}px solid transparent;` +
        `border-bottom:${half}px solid transparent;` +
        `border-left:${ARROW_GEOM.sizePx}px solid ${row.color};` +
        'filter:drop-shadow(0 0 1px #000);';

      // 读数行：水平、不旋转，摆在箭头**朝屏幕内侧**那一面（由 _place 逐帧决定）
      const label = document.createElement('span');
      label.style.cssText =
        `position:absolute;left:0;top:0;color:${row.color};` +
        'font:11px/1 monospace;white-space:nowrap;' +
        'text-shadow:0 0 2px #000,0 0 2px #000,1px 1px 1px #000;';

      box.append(tri, label);
      this.el.appendChild(box);
      this._slots.set(row.key, { box, tri, label, last: {} });
    }
    root.appendChild(this.el);
  }

  /**
   * 每帧调用（**几何每帧算**：转视角时箭头必须跟手，节流会看出滞后）。
   *
   * DOM 只在值真的变了才写（位置取整到 1px、角度取整到 1°、opacity 两位小数、文本比较）
   * ⇒ 静止不动时零写入。无敌人时只做一次空遍历 + 五次 display 比较。
   *
   * ⚠️ **不收 `nowMs`**（与其余 HUD 成员不同）：本层无寿命/节流/动画，纯几何跟随，
   * 没有用到时间基准的地方。收一个用不到的参数只会招来 unused 警告。
   */
  update() {
    const game = this.game;
    const pos = game?.player?.physics?.pos;
    const entities = game?.entities;
    if (!pos || !entities) { this._hideAll(); return; }
    const vw = window.innerWidth, vh = window.innerHeight;
    const fov = game.camera?.fov;
    if (!Number.isFinite(fov) || fov <= 0 || !(vw > 0) || !(vh > 0)) { this._hideAll(); return; }
    const tan = Math.tan((fov * Math.PI) / 360);
    const aspect = vw / vh;
    const targets = enemyArrowTargets(entities.entities(), pos, this.cameraSpaceFn, tan, aspect);

    // ⚠️⚠️ **方位只吃 yaw，不吃 pitch**（v3.43 核心）：玩家抬头低头不得改变任何箭头的边。
    // 上面的 cameraSpaceFn（含 pitch）**只用于判可见性**，不参与方位计算。
    const yaw = game.player?.yaw ?? 0;
    const places = targets.map((t) => {
      const dir = arrowDirection(t.delta, yaw);
      const p = arrowPlacementFromDir(dir.sx, dir.sy, vw, vh);
      // 三角指向：沿**屏幕方向**（与落点同一向量），而不是回读相机空间
      const deg = (Math.atan2(dir.sy, dir.sx) * 180) / Math.PI;
      return { key: t.key, x: p.x, y: p.y, deg };
    });
    spreadArrows(places, vw, vh);

    const live = new Set();
    for (let i = 0; i < targets.length; i += 1) {
      const t = targets[i];
      live.add(t.key);
      this._place(t, places[i], vw, vh);
    }
    for (const [key, slot] of this._slots) {
      if (live.has(key)) continue;
      if (slot.last.display !== 'none') {
        slot.box.style.display = 'none';
        slot.last.display = 'none';
      }
    }
  }

  /** 当前可见的类（只读测试接口，按登记顺序） */
  activeKeys() {
    const out = [];
    for (const row of ENEMY_ARROW_ROWS) {
      const slot = this._slots.get(row.key);
      if (slot && slot.last.display !== 'none') out.push(row.key);
    }
    return out;
  }

  /**
   * 把单类落到屏幕：定位 + 三角旋转 + 读数文本与朝向内侧的摆位 + 远近透明度。
   * @param {object} t 目标（`enemyArrowTargets` 的一项）
   * @param {{x:number,y:number,deg:number}} p 推开后的落点
   */
  _place(t, p, vw, vh) {
    const slot = this._slots.get(t.key);
    const last = slot.last;
    const x = Math.round(p.x), y = Math.round(p.y);
    const deg = Math.round(p.deg);
    const opacity = arrowOpacity(t.distance).toFixed(2);
    const text = `×${t.count} ${Math.max(0, Math.floor(t.distance))}m`;

    if (last.display !== 'block') { slot.box.style.display = 'block'; last.display = 'block'; }
    const transform = `translate(${x}px,${y}px)`;
    if (last.transform !== transform) { slot.box.style.transform = transform; last.transform = transform; }
    if (last.opacity !== opacity) { slot.box.style.opacity = opacity; last.opacity = opacity; }
    const rot = `rotate(${deg}deg)`;
    if (last.rot !== rot) { slot.tri.style.transform = rot; last.rot = rot; }
    if (last.text !== text) { slot.label.textContent = text; last.text = text; }

    // 读数行朝屏幕内侧摆：左半屏往右、右半屏往左；纵向同理。
    // ⚠️ 用**推开后的落点**判半屏（不是原始角度）—— 推开可能把它挪过中线。
    const gap = ARROW_GEOM.sizePx / 2 + 3;
    const lx = x <= vw / 2 ? gap : -gap;
    const ly = y <= vh / 2 ? gap : -gap;
    // translate 的百分比是相对自身尺寸 ⇒ 右/下侧用 -100% 把文字拉回内侧
    const labelTransform = `translate(${lx}px,${ly}px)`
      + ` translate(${x <= vw / 2 ? '0%' : '-100%'},${y <= vh / 2 ? '0%' : '-100%'})`;
    if (last.labelTransform !== labelTransform) {
      slot.label.style.transform = labelTransform;
      last.labelTransform = labelTransform;
    }
  }

  /** 全部隐藏（装配未就绪 / 视口非法时） */
  _hideAll() {
    for (const [, slot] of this._slots) {
      if (slot.last.display !== 'none') {
        slot.box.style.display = 'none';
        slot.last.display = 'none';
      }
    }
  }

  /** 纯 DOM：摘节点即可（无 GPU 资源、无事件监听） */
  dispose() {
    this.el.remove();
    this._slots.clear();
  }
}