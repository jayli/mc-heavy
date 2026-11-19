// src/player/weapons/weapon-catalog.js — 武器静态目录（M4 规格 §3/§4.2）
// 只含数字和数组的静态配置：无 three、无 DOM。渲染层只读消费，不得改写（递归冻结）。
// 模型 transform 沿用 mc-lite 归一化模型后的值；所有坐标均为相机局部坐标，cooldown 单位为秒。
//
// 「曳光停留时间」= 各武器 `tracer.lifetime`，**有意偏离 mc-lite 的四分之一**（v1.62）：
// mc-lite 原值 0.10 / 0.15 / 0.08（`Gun.js` 的 tracerLifetime）。曳光起点/终点都冻结在
// 开火瞬间的世界空间（v1.33），玩家奔跑时残影钉在原地不动 → 全长（接近原值）会在身后
// 连成一排射向远方残余的火线。缩短到 1/4 后残影只闪一下即消隐；其余参数（颜色/粗细）不变。

// v3.20 Nova Beam：伤害**派生**自爆炸常量（红线 1）—— 用户裁定「掉血幅度等同被炸弹炸到」。
// 在本文件再写一份 50 就是第二份权威，将来调炸弹伤害时光柱会静默不跟。
import { EXPLOSION_DAMAGE } from '../../voxel/explosion.js';

export const WEAPON_IDS = Object.freeze({
  ARM: 'arm', PISTOL: 'pistol', MAG7: 'mag7', MINIGUN: 'minigun', SWORD: 'sword',
});

/**
 * 剑体基础朝向（弧度，XYZ 序）。
 *
 * 来源：先定「相机空间目标基」再反解欧拉角（推导见 `WEAPONS[SWORD].transform` 注释），
 * 度数结果是 **-60° / -90°**。这里用表达式而不是 `-1.047` 这类硬编码小数，是为了让
 * 后面的人一眼看出它是角度换算 —— v2.65 的缺陷就是「度/弧度」混用。
 */
const SWORD_LENGTH_SCALE = 1.2534;
const SWORD_ROTATION_X = (163.639 * Math.PI) / 180;
const SWORD_ROTATION_Y = (20.654 * Math.PI) / 180;
const SWORD_ROTATION_Z = (-168.683 * Math.PI) / 180;

/** 曳光池上限：池满时丢弃最旧的纯视觉曳光，绝不丢弃命中或世界编辑（M4 规格 §4.2） */
export const MAX_ACTIVE_TRACERS = 32;

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export const WEAPONS = freeze({
  [WEAPON_IDS.PISTOL]: {
    id: 'pistol', model: 'pistol', cooldown: 0.09, recoil: 0.05, sound: 'gun_fire', volume: 0.09,
    transform: { scale: [0.09, 0.09, 0.09], position: [0.3, -0.85, -0.4], rotation: [0, 0, 0] },
    muzzleOffset: [0.3, -0.82, -0.44], localStart: [0.3, -0.33, -0.98],
    tracer: { color: 0xffff00, thickness: 1, lifetime: 0.025 }, automatic: true,
    // M6 增补（M6 规格 §2）：实体伤害与射程。手枪 25 → 四发致死（生命 100）
    entityDamage: 25, entityRange: 40,
  },
  [WEAPON_IDS.MAG7]: {
    id: 'mag7', model: 'mag7', cooldown: 1.5, recoil: 0.15, sound: 'mag7_fire', volume: 0.2,
    transform: { scale: [1.3, 1.3, 1.3], position: [0.44, -0.5, -0.8], rotation: [0, -Math.PI / 2, 0] },
    muzzleOffset: [0.3, -0.82, -0.44], localStart: [0.55, -0.4, -1.8],
    tracer: { color: 0xff6600, thickness: 6, lifetime: 0.0375 }, automatic: false,
    scan: { min: 1, max: 10, step: 0.5, halfWidth: 1, maxBlocks: 40 },
    // M6 增补：实体射程**必须等于** `scan.max`（同一把枪的实体/方块两个射程口径不得漂移）。
    // 999 → 一击致死；MAG7 不是 projectile，实体命中与方块扫描是同一发的两个独立步骤。
    entityDamage: 999, entityRange: 10,
  },
  [WEAPON_IDS.MINIGUN]: {
    id: 'minigun', model: 'minigun', cooldown: 0.07, recoil: 0, sound: 'minigun_fire', volume: 0.15,
    // 加特林视图节点在应用绕局部 x 轴的枪管旋转前必须设 rotation.order='YXZ'，
    // 避免 mc-lite 已修复的欧拉万向锁。
    transform: { scale: [0.5, 0.5, 0.5], position: [0.48, -0.56, 0.6], rotation: [-Math.PI / 2, -Math.PI / 2, -Math.PI], rotationOrder: 'YXZ' },
    muzzleOffset: [0.3, -0.82, -0.44], localStart: [0.5, -0.5, -1.8],
    tracer: { color: 0xffff00, thickness: 0.5, lifetime: 0.02 }, automatic: true,
    spin: { targetRadiansPerSecond: 25, shootingRetentionAt60Hz: 0.9, idleRetentionAt60Hz: 0.85 },
    // M6 增补：35 → 三发致死
    entityDamage: 35, entityRange: 40,
  },

  /**
   * 紫色剑（v2.65，用户 2026-11-06）—— 本仓**第一件近战武器**，故有一组枪没有的字段：
   *
   * - `melee: true` —— controller 据此走 `_fireMelee`（**不写方块、不发曳光**）。
   *   用户明确：「剑不能像枪一样可以破坏方块，但可以伤害敌人」。
   * - `hitSound` / `hitVolume` —— 砍中敌人的音效（`emp_activated.ogg`）。与 `sound`
   *   （挥砍音 `player_swing.ogg`）分开：挥空也响 `sound`，只有命中才响 `hitSound`。
   * - `swingSeconds` —— 视图模型挥砍动画时长（`view-weapon.js` 消费）。
   *
   * ## 数值设计（用户授权「掉血幅度你来设计决定」）
   *
   * `entityDamage = 50` / `cooldown = 0.5` ⇒ 100 DPS，各实体的刀数：
   *   · 丧尸（health 100）→ **2 刀**（手枪 25 要 4 发，剑更快 —— 近战的回报）；
   *   · 焰魔（health 3500）→ 70 刀；
   *   · 飞龙（health 3000）→ 60 刀（飞龙是飞行 Boss，近战本就难贴身，这是设计意图）。
   * DPS 刻意低于枪（手枪 278 / 加特林 500）：枪是安全距离输出，剑要贴脸挨打。
   *
   * ## `entityRange = 3` 的可达性（实测定，不是拍脑袋）
   *
   * 三类敌人都够得着：
   *   · 丧尸贴身追击，玩家能到 ≈0.6 格（半宽 0.3 + 0.3）；
   *   · 焰魔**站定环 4.25~5.0 格**（`IGNIS_AI.standoffRange`，用户裁定「不动如山」），
   *     但玩家可主动贴近到 ≈1.36 格（被身体盒挡住，E2E 实测值）⇒ 3 格内能砍到。
   *     代价是先挨几下（焰魔 `hitRange` 6.5）—— 近战 vs 远程 Boss 的风险回报；
   *   · 飞龙俯冲（`diveOffset`）与飞跃（`flyoverDistance` 6）时会进到 3 格内。
   * ⚠️ **改这个值前先核对焰魔的 `standoffRange`**：若剑射程 < 焰魔站定环下界，
   * 形态是「焰魔站在环上砍你、你永远砍不到它」，而数据层看不出因果。
   */
  [WEAPON_IDS.SWORD]: {
    id: 'sword', model: 'sword', cooldown: 0.5, recoil: 0, sound: 'player_swing', volume: 0.5,
    /**
     * 第一人称摆放（v2.66 重构，实测定标 —— 勿凭手感改）。
     *
     * **欧拉角不是拍脑袋的**：先定「相机空间目标基」，再反解欧拉角。模型空间轴 ↔ 相机空间：
     *   · 模型 +X（薄轴 = 剑面法线）→ (0, √3/2, 0.5)  朝相机且略朝上 ⇒ 看到剑面而不是刀背
     *   · 模型 +Y（柄→尖）          → (0, 0.5, -√3/2) 向前且朝上 ⇒ **刀刃向前**（用户裁定）
     *   · 模型 +Z（剑身宽度）        → (-1, 0, 0)      屏幕内朝左
     * 三个基向量正交（c3 由前两者叉乘得到）、det = +1、欧拉往返误差 1.5e-8。
     * 反解结果是 **90° / -70.08° / 144.96°（XYZ 序）**，见文件头 `SWORD_ROTATION_*` 常量注释。
     *
     * ⚠️ **catalog 的 `rotation` 单位是弧度**（与枪同一口径：MAG7 写的是 `-Math.PI / 2`）。
     * 曾经把度数（-60）直接填进来，实测被当成 **-60 弧度 = -3437°** ⇒ 剑体变成无从预期的朝向。
     * 这种错在任何「模型加载成功 / 非黑像素」类判据下都不会报，只有量相机空间坐标才现形。
     *
     * ⚠️ **v2.65 的 `[0.25, -0.35, -0.5]` 是错的**（实测：剑尖 z=-0.362 比剑柄 z=-0.738
     * 更靠近相机 ⇒ 剑体前后颠倒，柄朝前、尖朝脸），且屏幕包围盒 x[575..2162] y[-277..1357]
     * 对 1280×720 视口只有 **19.6%** 落在窗内。两个缺陷同源。
     * 自我约束：改这三个数后必须重跑 `tests/sword.spec.mjs` 的「剑体朝向」与
     * 「剑体大部分在视窗内」两条 —— 它们判的是**相机空间坐标与屏幕包围盒**，不是目视。
     */
    transform: {
      scale: [SWORD_LENGTH_SCALE, SWORD_LENGTH_SCALE, SWORD_LENGTH_SCALE],
      position: [0.99287, -0.206, -1.20283],
      rotation: [SWORD_ROTATION_X, SWORD_ROTATION_Y, SWORD_ROTATION_Z],
      rotationOrder: 'XYZ',
    },
    /**
     * 挥砍支点（**节点局部坐标**，未乘 scale）= 剑柄末端在节点里的位置。
     *
     * 实测值 = 柄末端**节点局部**坐标 `(0, -0.9375, 0.0996)`，**不乘 scale**：
     * 挥砍矩阵 `M = ΔR · baseM · T(c)` 作用在节点局部点上，而 baseM 已含节点 scale，
     * 再乘一次 scale 等于把支点推远一倍（v2.69 实测握点漂移 166px 的根因）。
     * 不乘 scale 还有个好处：改 `SWORD_LENGTH_SCALE` 时支点不用跟着重标。
     * 挥砍时绕它转，则**握点（手）在相机空间里不动**、剑身在支点外侧扫弧 —— 这才是挥砍。
     * 绕模型中心转的形态是「螺旋桨」，用户 2026-11-06 已明确否掉。
     */
    swingPivot: [0, -0.9375, 0.29958],
    // 近战：无 muzzleOffset / localStart / tracer / automatic / scan（枪专属字段）
    entityDamage: 50, entityRange: 3, melee: true,
    hitSound: 'emp_activated', hitVolume: 0.6,
    /**
     * 视图模型挥砍动画时长（秒）。**唯一权威**：`view-weapon.js` 的 `_swingDuration`
     * 由 `onShot()` 从这里读（写字面量的形态是「动画与判据不同长」）。
     *
     * 用户 2026-11-08：「挥刀的时间减少为原来的四分之三」⇒ 0.3 × 3/4 = **0.225**。
     * 只改时长，`strikeEnd`（两段时间分配比例）与 `SWORD_SWING_CURVES`（缓动形状）不变 ——
     * 与 v2.74 定的口径一致：「调手感只动幅度/时间，不顺手改缓动」。
     */
    swingSeconds: 0.225,
    /**
     * 挥砍：**向前劈劈砍**（用户 2026-11-06：「你要向前挥刀，不是向左摆刀」）。
     *
     * 轴 = **相机 X（屏幕水平轴）**，支点 = `swingPivot`（剑柄）：
     *   · 负向旋转 = 剑尖**向前下方**砍出（实测剑尖相机 z 从 −1.87 推到 −2.99，即远离相机）
     *   · 剑柄在相机空间钉死不动（始终在屏幕下方外）
     *   · **不绕剑身长轴自转**（没有 wrist 项）——用户澄清「剑体不绕着剑柄的方向的轴旋转」
     *
     * ⚠️ 方向不能弄反：正向旋转会把剑尖朝**镜头**翻过来（tipZ 从 −0.77 到 +0.72，穿过相机平面），
     * 屏幕坐标会炸到 (3127, −220) 这种离谱值。只有负向是「向前砍」。
     *
     * **只有两段**：前 `strikeEnd` 劈出，之后沿原路收回。
     * `arc` 标定：`-0.9` 时剑尖 (864,434) 距准心 236px 且整把剑在屏内；更深会让剑尖甩出屏底。
     */
    swing: {
      /** 挥砍段占比：前 65% 劈下去，后 35% 沿原路收回 */
      strikeEnd: 0.25,
      /**
       * 向前劈砍幅度（弧度，绕相机 X 轴，负 = 剑尖向前下方砍出）。
       *
       * 用户 2026-11-06：「批砍的幅度想加大一些……我想做到更使劲砍一些」，随即明确裁定：
       * **「你只改幅度……时间、缓动、其他啥都别改」** —— 所以只动这个数，
       * `strikeEnd` / `swingSeconds` / 曲线形状（`view-weapon.js` 的 SWORD_SWING_CURVES）全部保持不变。
       *
       * 标定：−1.15（劈到约 60°）→ **−1.55**（劈到约 90°），等比放大 1.35×。
       * 实测最远点剑尖 y 从 478 压到 **~630**、tipZ −2.687 → −2.78，即「劈得更深」；
       * 再深（1.75× ≈ −2.01）剑尖会甩到 y=783 并逼近屏底，且距准心恶化到 445px。
       */
      arc: -2.95,
      /**
       * 挥扫幅度（弧度，绕**相机 Y 轴** = 垂直轴，正 = 剑尖向左扫）。
       *
       * 用户 2026-11-06：「挥剑的时候，剑头有一个向左挥的效果，而不是纯纯向前劈，
       * 挥刀过程中有一个向左挥扫的动作，然后挥刀到最远处再返回」。
       *
       * ⚠️ 这是**旋转**而不是平移（上一版 `shift` 是纯平移，剑身姿态不变，
       * 看起来就是「整把剑横着挪过去」）。绕垂直轴偏航才是真正的挥扫：
       * 剑尖划弧、剑柄几乎不动，且剑身在空间里真的掉转了方向。
       *
       * 与 `arc` 共用同一条 `amount` 曲线，合成 `dR = R_y(amount·yaw) · R_x(amount·arc)`：
       * 先按 amount 向前劈，同时按 amount 向左扫 —— 即「边向前边向左划弧」。
       * 实测（`arc=-1.35`、`yaw=0.8`）剑尖：(1058,174) → 距准心最近 **81px** → (580,574)，
       * 横向左移 478px、向前推进 1.47 格（tipZ −1.331 → −2.799），剑柄只漂 66px。
       */
      yaw: 0.4,
      /**
       * 劈砍过程中的**左移量**（格，相机空间 x，负 = 屏幕左）。
       *
       * 用户 2026-11-06 第二轮问「为什么把 shift 去掉了」，并指出这就是左移参数：
       * 它和 `yaw` 并不互斥 —— `yaw` 负责让剑尖**划弧扫过去**（旋转，剑身真掉方向），
       * `shift` 负责把整个挥扫区域**递向左**（平移），包括剑柄一起左移。
       * 两者叠加才是「先左移到位、再向左挥扫」。
       *
       * 与 `arc`/`yaw` 共用同一条 `amount` 曲线：静止 0 → 劈到最深处最大 → 收回归 0。
       * 装配顺序（view-weapon.js）：`M = T(shift·amount) · R_y(·) · R_x(·) · baseM · T(c)`
       * —— 平移在**最外层**，所以是在相机空间直接左移，不改变旋转支点的行为。
       */
      shift: -1.5,
    },
    /**
     * 击退距离（格）。用户：「挨了一剑后，如果没死的话，就往后退一小步」。
     *
     * 0.4 格的标定依据：丧尸追击速度 1.2 格/秒 ⇒ 0.4 格 = 它 0.33 秒的行程，
     * 看得见「被推开」又不会像瞬移；且小于丧尸排斥半径 `ZOMBIE_SEPARATION.minDistance`(1.2)，
     * 不会把两只丧尸一次击退到互相排斥的阈值外造成连锁推挤。
     */
    knockbackDistance: 0.9,
    /**
     * 蓄力大招 Storm Lance（v3.20，用户 2026-11-19）。
     *
     * 用户原话：「长按鼠标后松开时触发这个特效，短按鼠标就是普通的挥剑攻击……掉血的幅度
     * 等同于被炸弹炸到的效果。」实玩 Nova Beam 后改口径：「干脆改成 storm lance 算了，
     * 这个是最简单的特效……我们从最简单的开始实现。」
     * 视觉来自上游 `ThunderAbility.js` + `LightningMaterial.js`（**2 个 pass**，零贴图）。
     *
     * ## 五条用户裁定
     * ① 伤害 = **每个实体扣一次 50** ⇒ `damage` 派生自 `EXPLOSION_DAMAGE`（红线 1）；
     * ② **不破坏方块**（与剑一致，遇墙按 DDA 截断）；
     * ③ 不做调参坞，只加准心蓄力环；
     * ④ **按下 1 秒后才开始蓄力，蓄力 1 秒**（总 2s）—— 静默期零蓄力视觉，
     *    否则「我只需要挥刀的时候也会触发蓄力的动画，画面就太乱了」；
     * ⑤ **碰到实体立即在该处爆炸**，不穿身炸到后面的方块上。
     *
     * ## `cooldown = 2.0` 是推导出来的，不是拍的
     * 释放后总视觉时长 = travel(`range/speed`) + hold + fade
     *   = 24/105 + 0.45 + 0.5 = **1.179s**
     * 两次施法最少间隔 = `chargeDelaySeconds + chargeSeconds` = **2.0s**。
     * `2.0 > 1.179` ⇒ **两道闪电在时间上不可能重叠** ⇒ 渲染器只需 **1 个槽位**。
     * ⚠️ 这条推导是**载荷性的**：抬 `range` 或 `holdSeconds` 会让总时长超过 2.0s，
     * 必须同时抬冷却或改多槽位。`test-storm-lance.js` 用关系式钉住它。
     *
     * ## 单发伤害与剑相同，价值在射程与范围
     * 50 伤害 / 24 格 / 一次打多个；蓄力 2s + 冷却 2s ⇒ 4 秒一发 = 12.5 DPS，
     * 远低于剑的 100 DPS。它是「安全距离的范围清场」，不是「更强的单体输出」。
     */
    stormLance: {
      /**
       * 按下后的**静默期**（秒）。这段时间只挥刀，**零蓄力视觉**。
       * 用户：「按下一秒后开始启动蓄力……不然我只需要挥刀的时候也会触发蓄力的动画」。
       */
      chargeDelaySeconds: 1.0,
      /** 蓄力时长（秒）—— 静默期之后再蓄 1 秒，总计按下 2 秒 */
      chargeSeconds: 1.0,
      /** 最远射程（格）—— 上游 `settings.thunder.range` */
      range: 24,
      /**  strike 前沿推进速度（格/秒）—— 上游 `speed` */
      speed: 105,
      /** 命中后保持（秒）—— 上游 `lifetime` */
      holdSeconds: 0.45,
      /** 熄灭（秒）—— 上游 `fadeTime` */
      fadeSeconds: 0.5,
      /** 施法冷却（秒）—— 推导见上 */
      cooldown: 2.0,
      /** 每个实体的伤害 = 一颗炸弹（红线 1：派生不复制） */
      damage: EXPLOSION_DAMAGE,
      /** 远端束半宽（格）—— 上游 `spread`；同时是十字射线的偏移量 */
      radius: 0.75,
      /**
       * 出射点相对相机的偏移 `[right, up, forward]`（格）。
       * ⚠️ 不用上游的 `handHeight/endHeight`（那是离地板的绝对米数，本仓地形起伏）。
       */
      handOffset: [0.28, -0.22, 0.55],
      /** 蓄力起手音（既有素材，零新增） */
      chargeSound: 'emp_activated', chargeVolume: 0.3,
      /** 蓄满提示音（既有素材）—— 玩家不看环也能知道 2 秒到了 */
      readySound: 'gun_load', readyVolume: 0.4,
      /** 释放音（既有素材） */
      fireSound: 'dragon_fire', fireVolume: 0.5,
      /** 落点音（既有素材，与 TNT 爆炸同一条） */
      impactSound: 'explosion', impactVolume: 0.4,
    },
  },
});
