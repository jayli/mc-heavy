# 祭坛之龙（Altar Dragon）设计文档

- **日期**：2026-11-03
- **版本**：v2.41（待实施）
- **素材**：`/Users/bachi/Downloads/Dragon/amethyst_dragon.bbmodel`（用户指定**不带鞍**的普通版）
- **一句话**：把用户提供的 Blockbench 紫水晶龙模型导入游戏，让它在**全世界唯一带祭坛的高台地带**上空盘旋；龙可被玩家武器与炮塔击中、有血量、红闪反馈、死亡后永久消失。

---

## 1. 需求与裁定记录

用户 2026-11-03：「这里是一条龙的模型，我希望导入龙的模型，让龙在天上盘旋，让龙在带有祭坛的高台地带的上空盘旋」+「导入普通的那个，不带鞍的」。

四轮提问裁定（2026-11-03）：

| # | 问题 | 裁定 |
|---|---|---|
| 1 | 玩法定位 | **可被武器击中、有血量、能死亡、无掉落语义**，进 EntityManager；并要求评估「是否需要重新建模」 |
| 2 | 尺度 | **放大约 3 倍**（体长 6.25 → 约 18.75 格） |
| 3 | 动画 | **fly + glide 交替** |
| 4 | 范围 | **只有祭坛地带一条**（`findAltarTarnRegion` 定位的那个地带） |
| 5 | 盘旋高度 | **约 28 格高**（y ≈ TARN_PLATEAU_Y + 28 = 30） |
| 6 | 死亡后 | **永久死亡**（写存档标记，同 seed 不复活；换 seed / 删存档自然恢复） |
| 7 | 炮塔 | **炮塔也打龙** |
| 8 | 受击反馈 | **红闪**（复用丧尸 `flashedUntil` 机制） |
| 9 | 渲染路线 | **SkinnedMesh 单几何**（已实测 WebGPU 后端可用，见 §2.4） |
| 10 | 命中盒 | **只算身体核心**（不含翅膀尾巴） |

架构分叉裁定（2026-11-03，用户「两个分叉都选 A」）：

- **分叉一（伤害路由）= 方案 A**：Game 装配层加 `damageEntity(id, amount, nowMs)` 按实体类型分发；predicate 读共享的「可被武器击中类型」集合。**不**给 M5 EntityManager 加玩法伤害接口，**不**复用 ZombieService。
- **分叉二（持久化）= 方案 A**：龙是**临时实体**（`persistent: false`），位置每帧由纯函数从 seed + 时间派生；死亡标记写既有 `meta` 行的 `dragonDead` 字段（与 v2.29 `playerPos` 同一手法）。**不**用 `persistent: true`（位置进存档 = 违反红线 2）。

---

## 2. 素材事实（实测，全部回答「是否需要重新建模」）

**结论：不需要重新建模。** 素材可直接烘焙使用。以下每条都是实测（解析
`amethyst_dragon.bbmodel`，Blockbench format 4.10，modded_entity，box_uv）：

### 2.1 几何

- **115 个元素全部是 `cube` + `box_uv: true` + 自身 `rotation` 全为 0**（旋转全部在骨骼上）
  → 直接映射 three `BoxGeometry` 语义，与 `zombie-renderer` 的「每面 UV 矩形」同口径。
- **每个元素刚性归属单个骨骼**（outliner 里 element 是 bone 的 child，0 个孤儿）→
  每顶点 skinWeight = 1，**不需要蒙皮权重**，SkinnedMesh 只是「骨骼驱动刚性块」的载体。
- 无 `inflate`、无 `rescale`、无 `light_emission` → 无特殊渲染语义。
- 元素自带**逐面显式 UV**（`faces.*.uv`，px 坐标），不需要从 box_uv 布局反推。
  ⚠️ **UV 矩形有递减书写**（如 chest 的 up 面 `[22,10,10,0]` u1<u0）—— 与 MC 皮肤版式
  同类陷阱（AGENTS.md「不得加 min/max 规范化」），烘焙必须原样保留。
- 模型空间 bbox：**88 × 33.7 × 100 px**（16px = 1 格）= **5.5 × 2.11 × 6.25 格**（1x）。
  **3 倍后 16.5 × 6.3 × 18.75 格**。
- **模型朝向 = −Z**（头在 z=−39、尾在 z=+61）—— 与 three 的「前向 −Z」惯例一致，
  yaw 换算零额外处理。
- **翼膜是 1px 厚薄片**（`*_wing_membrane*` 共 8 个元素，厚度 1px）→ 材质必须
  `DoubleSide`（否则从下方看穿）。贴图 57% 像素透明（翼膜镂空）→ 走 `alphaTest`
  （cutout 语义，避免透明排序问题）。

### 2.2 骨骼与动画

- **78 根骨骼**层级（root → body → spine_1..5 / neck1..3 / head / 四肢 / tail1..6 /
  双翼各 11 根）。骨骼 `origin` 是**绝对模型空间坐标**（实测 `chest` 元素 z∈[−8,2]
  与 `neck1` origin z=−8 几何邻接）→ 局部偏移 = `origin − parent.origin`。
- 5 个动画：idle(4.0s) / walk(1.0s) / **fly(1.2s)** / **glide(3.0s)** / attack(1.6s)，
  共 1156 个关键帧，catmullrom 插值为主。本期只用 fly / glide。
- 关键帧是**相对 bind pose 的增量**（实测 body 的 position y 在 ±2px 浮动）→
  运行时 = bind 变换 + 采样增量。
- fly / glide 合计只驱动 **33 根骨骼**，其余 45 根（角、牙、爪、脊刺、尾刃等）恒跟随
  父骨骼 → 运行时每帧只需更新 33 根。

### 2.3 贴图

- 单张 **128×128 RGBA PNG 内嵌**（base64），UV 全在图内（u≤124、v≤97）。
  紫水晶色系（主色 ~(112,80,176)~(176,144,240)，与祭坛主题呼应）。
  → 直接解码落盘 `assets/dragon/dragon.png`，与丧尸皮肤（`npm run zombieskin`）同一手法。

### 2.4 SkinnedMesh 可用性（架构分叉实验，已实测）

AGENTS.md 记录过 WebGPU 后端「刻意不实现」的先例（材质数组、depth-compare 阴影），
故实施前做了最小探针（2 骨骼 + skinWeight 立方体 + bone1 旋转 45°，读渲染像素）：

```
PROBE RESULT: {"totalRed":11170,"leftRed":6025,"rightRed":5145,"asymmetric":true,"skinnedMeshRendered":true}
PAGE ERRORS: []
```

**蒙皮生效、零页面错误** → 选 SkinnedMesh 单几何路线：115 盒合并成**一个
BufferGeometry**（115 × 24 = 2760 顶点 / 4140 索引），skinIndex 指向 78 根骨骼，
整条龙 **1 个 draw call**；无龙时 `visible = false` → 0（同 M6「常驻 mesh 空载必须
隐藏」口径）。

---

## 3. 架构总览

```
assets/dragon/src/amethyst_dragon.bbmodel     烘焙输入（入库，非渲染资源）
        │  npm run dragon（tools/bake-dragon.mjs）
        ▼
assets/dragon/dragon.json      骨骼层级 + 合并几何(position/normal/uv/skinIndex/index)
assets/dragon/dragon.png       + 重采样动画帧（30fps）+ 度量
assets/dragon/dragon.meta.json 输入指纹（check:data [龙] 守过期）
        │  运行时加载（主线程，resourceUrl）
        ▼
src/render/dragon-model.js     纯数据装载 + 几何/骨骼/动画采样 helper（three-free 部分）
src/render/dragon-renderer.js  SkinnedMesh 构建 + 每帧 pose 发布（受控发布层）
src/entities/dragons/dragon-config.js   冻结玩法数值（唯一权威，同构无 three）
src/entities/dragons/dragon-system.js   dragonDefinition + DragonService（同构无 three）
        │
src/core/game.js               装配：spawn 编排 / damageEntity 分发 / 炮塔目标集合 /
                               武器 predicate 注入 / meta 死亡标记
```

依赖方向：`entities/dragons` 是同构层（无 three 无 DOM，`check:arch` 守）；
`render/dragon-*` 主线程；`player/weapons` 的 predicate/damage 全部经**注入**
（weapon-controller 自声明「不 import entities」的约束保持不动）。

---

## 4. 资产管线（烘焙）

### 4.1 `tools/bake-dragon.mjs`（`npm run dragon`）

输入 `.bbmodel`，输出三件套。**烘焙期做完所有重活，运行时零解析负担**：

1. **骨骼表**：78 项 `{name, parent, origin(px), bindRotation(deg)}`，outliner 序。
2. **合并几何**（模型空间，**已乘 3 倍并换算 px→格**（÷16×3））：
   - 每元素 24 顶点（three BoxGeometry 面序 `[+x,−x,+y,−y,+z,−z]`），
     位置 = 元素 `from/to`，法线按面；
   - **UV = 元素逐面显式 uv ÷ 128**，保留递减书写；v 轴按「图片左上角原点 →
     three `flipY=true`」换算 `v = 1 − v_px/128`（与丧尸皮肤 flipY 教训同源；
     纹理用 `TextureLoader` 真实路径加载验证，不用 DataTexture 探针 —— AGENTS.md 已记该坑）；
   - 面名映射：`east=+x, west=−x, up=+y, down=−y, south=+z, north=−z`
     （Blockbench/MC 惯例，Tier 4 像素实测校正 —— 头部眼睛位置是天然标记）；
   - `skinIndex` = 该元素所属骨骼下标（weight 恒 1）。
3. **动画重采样**：fly / glide 各自在烘焙期按 catmullrom 采样成 **30fps 帧序列**
   （fly 36 帧 / glide 90 帧），每帧每骨骼存 `{rot: 四元数增量, pos: [x,y,z] 增量(px→格)}`，
   只存被驱动的 33 根。运行时只做帧间线性插值（旋转 slerp）—— catmullrom 的复杂度
   留在 Node 侧，运行时确定且简单。
4. **度量与指纹** → `dragon.meta.json`：元素数 115 / 骨骼数 78 / 顶点数 2760 /
   动画帧数 / `scale: 3` / 输入指纹（bbmodel sha256 + 烘焙参数 sha256，与巨树/船同手法）。

未知面名 / 非 cube 元素 / 无骨骼归属的元素 → **throw**（同竞技场烘焙口径：
静默丢弃会让产物看起来正常、实际缺肉）。

### 4.2 门禁

- `check:data` 新增 `[龙]` 环节：指纹比对（不跑 `npm run dragon` 即报过期）+
  产物契约（骨骼数 / 元素数 / 动画清单 / scale=3）+ 「`assets/dragon/src/` 不得被
  世界 atlas 扫描」（它不在 `assets/textures/` 下，天然安全，断言钉住）。
- 已知盲区（同所有烘焙产物）：只改烘焙算法不动参数时指纹不变 → 靠产物契约单测 +
  Tier 4 兜住。

---

## 5. 实体层（`src/entities/dragons/`，同构）

### 5.1 `dragon-config.js`（冻结数值唯一权威）

```js
export const DRAGON = Object.freeze({
  scale: 3,                      // 与烘焙产物同源（check:data 双向钉）
  health: 3000,                  // 手枪 25 → 120 发；加特林 35 → 86 发；炮塔 34 → 89 发；MAG7 999 → 4 发
  orbitRadius: 24,               // 见 §6.2 净空推导
  orbitY: TARN_PLATEAU_Y + 28,   // = 30，用户裁定「约 28 格高」
  orbitSpeed: 6,                 // 格/秒 → 周期 ≈ 2π×24/6 ≈ 25 秒/圈
  bobAmplitude: 1.5,             // 竖直缓浮 ±1.5 格（纯观感，周期 ~7 秒）
  bobPeriod: 7,
  bankRoll: 12 * Math.PI / 180,  // 盘旋内倾（渲染层消费）
  flashMs: 200,                  // 红闪时长，与 ZOMBIE_FLASH_MS 同口径（各自常量，不互引）
});
export const DRAGON_TYPE = 'dragon';
// 身体核心 OBB（模型空间，已含 3 倍，格）：body+spine+neck+head+jaw 的 bbox
// 实测 1x = x[−6,6] y[12,32] z[−39,12] px → 3x 后：
export const DRAGON_CORE_OBB = Object.freeze({
  halfExtents: Object.freeze([1.125, 1.875, 4.78125]),   // 全尺寸 宽 2.25 / 高 3.75 / 长 9.5625
  center: Object.freeze([0, 0, 0]),   // ⚠️ 实施修正：见下方「修订说明」第 2 条
});
// 模型空间体心偏移（渲染层摆放 mesh 用，**不是**命中盒的 center）
export const DRAGON_MODEL_CENTER = Object.freeze([0, 4.125, -2.53125]);
```

血量 **3000**（用户 2026-11-03 二次裁定，初稿是 300）：龙是**唯一**的景观 Boss 级目标，
定位是「打不死的风景」而不是「一场能赢的战斗」。3000 = 手枪 120 发 / 加特林 86 发 /
炮塔弹丸 89 发 / **MAG7 4 发**（999 伤害，唯一现实的击杀手段）。
⚠️ **这推翻了初稿「一两个弹匣内能打死」的取舍** —— 用户要的是「几乎打不死」。
高度 30 格 → 斜距 33.9~36.0 格仍在步枪射程 40 内，所以「可被击中 + 红闪反馈」照常生效，
只是常规武器需要极多发。⚠️ **改这个值不需要改任何测试**：临界伤害序列的发数已从
`DRAGON.health` 派生（testing-policy §2.5），E2E 的血量断言从运行时 config 读。

### 5.2 `dragon-system.js`

**`dragonDefinition`**（注册进 `EntityManager.registerType(DRAGON_TYPE, …)`）：

- `create(state)`：校验 position/orbit 参数有限。
- `update(entity, dt)`：`orbitT += dt` → 纯函数 `dragonPoseAt(orbit, orbitT)` 算
  `{position, yaw}`（§6.1 公式），返回**全新 state**（M5 不变式：不可原地改写）。
  不需要 context（轨道参数全在 state 里，不读世界 —— 龙不与方块交互）。
- `raycastAabb(state, origin, dir, maxDist)`：**身体核心 OBB 绕 yaw 旋转后的轴对齐
  包围盒**，slab 法（复用 `entity-types.js` 的 `raycastAabbSlab`，AABB 由 yaw 现算）。
  ⚠️ 龙转向时 AABB 随之转 —— 用固定盒会在龙横过来时漏判/误判。
- `serialize/deserialize`：临时实体不走存档，最小实现（position + orbitT）。

**`DragonService`**（玩法入口，形状对齐 `ZombieService`）：

```js
class DragonService {
  constructor({ entities, persistence, seed })   // persistence 用于 meta 死亡标记
  ensure()        // 每帧由 game 调：未死 && 无实体 && 祭坛地带中心 column 已加载 → spawn
  damage(id, amount, nowMs)   // 与 zombies.damage 同形状；health≤0 → despawn + 写死亡标记
  active()        // 当前龙实体或 null（渲染器与炮塔目标集合消费）
  isDead()        // meta.dragonDead
}
```

- spawn 是 `entities.spawn({id, type: DRAGON_TYPE, state, persistent: false})`。
  **临时实体**是刻意选择（分叉二方案 A）：位置是 seed 的纯函数，进存档就是第二份
  权威（红线 2）。
- **column 卸载回收 → 自动重生**：`despawnColumn` 会回收临时实体（玩家走远时）。
  `ensure()` 在玩家回来后重新 spawn（位置由纯函数重算，零成本）。
  **已知取舍（用户裁定「永久死亡」不受影响）**：走远再回来**血量重置为满** ——
  玩家必须身处该地带附近才打得到龙，此为边缘情况，接受。
- **死亡标记写 `meta.dragonDead = true`**：与 v2.29 `playerPos` 完全同一手法 ——
  merge 进 `_metaCache` 再整行 put（`saveMeta` 是整行覆盖，直接写会抹掉 seed/spawn）。
  `newWorld` / `clearSave` 的 `saveMeta` 不含该字段 → 换 seed / 删存档自然复活
  （与 playerPos 同语义，无需 settingsVersion 式迁移）。`importProgress` 带来的
  meta 若含 dragonDead 则沿用（那个世界的龙确实死了）。

### 5.3 伤害路由泛化（分叉一方案 A 的落点）

现状三处硬编码 `zombie`，逐一改：

1. **共享集合**（`entity-types.js`，同构层）：
   ```js
   export const WEAPON_HITTABLE_TYPES = Object.freeze(['zombie', 'dragon']);
   ```
2. **`weapon-controller.js`**：predicate 改为消费注入的 `isHittable`：
   ```js
   const hittable = this.entityQuery.isHittable ?? ((e) => e.type === 'zombie');
   const hit = this.entityQuery.raycast(origin, forward, weapon.entityRange, hittable);
   ```
   缺省回落 `zombie` 保持 M4 既有测试与行为逐位不变。controller 仍不 import
   entities（自声明约束不动）—— `isHittable` 由 Game 注入。
3. **`game.js`** 新增分发器 + 注入改线：
   ```js
   damageEntity(id, amount, nowMs) {
     const entity = this.entities.get(id);
     if (!entity) return null;
     if (entity.type === 'zombie') return this.zombies.damage(id, amount, nowMs);
     if (entity.type === DRAGON_TYPE) return this.dragons.damage(id, amount, nowMs);
     return null;
   }
   // setEntityQuery: damage → this.damageEntity；isHittable → 读 WEAPON_HITTABLE_TYPES
   // _updateProjectiles 的 onDamage → this.damageEntity（原 this.zombies.damage）
   ```
4. **`projectile-system.js`**（弹丸命中 predicate）：
   `(entity) => entity.type === 'zombie'` → `WEAPON_HITTABLE_TYPES.includes(entity.type)`
   （同层 import，合法）。
5. **`turret-system.js`**（索敌目标集合）：参数 `zombies` 改名 **`targets`**，
   每项 `{id, position, bodyOffsetY?}`（缺省 `TURRET.enemyBodyOffsetY`；龙传 0 ——
   龙的 position 就是身体中心，不需要 +1.2 的「丧尸胸部」偏移）。
   `game.js:2302` 构造 targets = 丧尸 + 活着的龙。
   ⚠️ 既有 `test-turrets.js` 全部用 `zombies:` 参数名 → 同步改名（本改动无行为变化，
   丧尸用例须逐位零回归）。

---

## 6. 盘旋行为

### 6.1 轨道公式（纯函数 `dragonPoseAt(orbit, t)`）

```
θ(t)  = orbit.phase + orbit.omega × t          // omega = orbitSpeed / orbitRadius
x(t)  = orbit.cx + R × cos θ
z(t)  = orbit.cz + R × sin θ
y(t)  = orbit.y + bobAmplitude × sin(2π t / bobPeriod)
yaw   = π − θ（⚠️ 实施修正：原文的 θ + π/2 是错的，见下方「修订说明」第 1 条）
```

- `orbit = {cx, cz, y, radius, omega, phase}` 在 spawn 时由 `findAltarTarnRegion(seed)`
  + salt 派生，**写进 state**（definition.update 不 import gen 层 —— entities 与 gen
  同属同构层但互不依赖，派生在 Game/DragonService 装配时做一次）。
- **phase 用新 salt `DRAGON_ORBIT_SALT = 1040`**：已程序化扫描全仓 salt 占用
  （含 AGENTS.md 提醒的「带 `+ step`/`+ y` 偏移的区间式占用」）—— 实测已占
  1020~1027、1029~1039，**1028 空闲但属被跳过的洞**（可能有历史原因），保守取
  **1040**（紧跟 1039）。单测钉住「1040 不在既有占用集合里」。
- 全世界无祭坛地带时（`findAltarTarnRegion` 返回 null）→ 不 spawn，`ensure()` 恒 no-op。

### 6.2 高度与净空（实测推导，不是拍脑袋）

用户裁定「约 28 格高」⇒ y = 30。但**高台地带的 8 座高台最高 46 格**（顶面 y=48，
`TARN_CLOUD_MIN_Y=54` 的标定依据）—— 龙若在高台环（半径 58）附近飞会撞山。
实测净空（AGENTS.md v2.31 段）：**8 座高台最近格距圆心 34.5**。故：

- **轨道半径 R = 24**（广场半径 28 之内）：翼展 16.5 格 → 翼尖最远 24 + 8.25 =
  **32.25 < 34.5**（余量 2.25 格），全程不碰高台；神龛是广场中心 7×7、最高只到
  **y = plateauY + 2 = 4**（v2.30：dy+1 铁柱环 + dy+2 四角绿宝），龙在其上方
  **26 格净空**。
- 拱洞在环 96、紫晶柱已删（v2.31）→ 广场上空无任何障碍。
- **武器可达性**（用户选 28 格高的理由，含 bob 的 y ∈ [28.5, 31.5] 全区间实测）：
  玩家站广场中心（脚 y=3，`EYE_HEIGHT = 1.62` → 眼高 y=4.62）→ 龙水平距离恒 24
  （轨道半径），垂直差 23.9~26.9 → 斜距 **33.9~36.0 格 < 步枪射程 40** ✓
  （bob 最高点仍有余量 4 格）。
  玩家走到广场边缘朝龙方向 → 龙经过近侧弧段时更近。MAG7（10 格）打不到（预期内，
  仅垂直差就 24 格）。
- **炮塔可达性**（⚠️ 初稿把不等式方向写反，已实测重算）：炮塔 pivot y = 6.3
  （地表 2 + 底座 1 + `pivotHeightOffset` 3.3），垂直差 **23.7 格**。`maxPitchAngle ±45°`
  要求 `|dy| ≤ 水平距离` ⇒ **水平距离 ≥ 23.7 格**（不是 ≤）；`detectionRange 50` ⇒
  水平 ≤ 44.0 格。可行水平带 **[23.7, 44.0]**。龙到炮塔的水平距离随龙在轨道上的位置
  扫过 `[|r−24|, r+24]`（r = 炮塔距圆心）：
  | 炮塔位置 r | 水平距离扫过 | 与可行带交集 |
  |---|---|---|
  | 0.5（圆心） | [23.5, 24.5] | [23.7, 24.5]（很窄） |
  | 5 | [19.0, 29.0] | [23.7, 29.0] |
  | 20 | [4.0, 44.0] | [23.7, 44.0]（大半圈） |
  | 28（广场边缘） | [4.0, 52.0] | [23.7, 44.0]（大半圈） |
  ⇒ **炮塔离圆心越远越容易打到龙**（水平距离变化范围越大）。放在广场边缘的炮塔
  能覆盖大半圈轨道；放在圆心的炮塔只在龙正对侧的窄弧段开火。

### 6.3 动画状态机（fly + glide 交替）

纯函数 `dragonAnimPoseAt(t)`（烘焙帧数据 + 帧间插值）：

- 周期 12 秒：**fly 4.0s → 交叉淡入 0.4s → glide 7.2s → 交叉淡出 0.4s → 循环**。
  淡入淡出期 = 两个动画各采样一帧按权重混合（旋转 slerp / 位移 lerp）。
- 相位从 `orbitT` 派生 → 无状态机对象、无随机，跨重启行为一致。
- 渲染层每帧更新被驱动的 33 根骨骼（其余 45 根自动跟随父级）。

---

## 7. 渲染层（`src/render/dragon-*`）

### 7.1 `dragon-model.js`（纯数据 + 采样 helper）

- `loadDragonAsset()`：fetch `dragon.json`（经 `resourceUrl()` —— v1.87 约束，
  不得写站点根绝对路径），返回 `{bones, geometry, animations, metrics}`。
- `sampleDragonPose(animations, t)` → `Map<boneName, {rot, pos}>`：§6.3 的帧插值。
  three-free（供浏览器单测直接驱动，同 `zombie-model.js` 口径）。

### 7.2 `dragon-renderer.js`（受控发布层）

- 构造期：从烘焙数据建 78 根 `THREE.Bone` 层级（局部偏移 = origin − parent.origin，
  bind 旋转 = bindRotation）、合并几何（position/normal/uv/skinIndex/skinWeight）、
  `THREE.SkinnedMesh` + `Skeleton` + `bind()`。
- 材质：`MeshBasicMaterial`（**unlit**，与丧尸/矿车/海面同口径 —— 本仓灯光只为
  PBR 武器而设，受光材质会吃 2.3 环境光漂移）+ `map: dragon.png`（TextureLoader
  真实路径）+ `alphaTest: 0.5`（翼膜镂空，cutout 语义免排序）+ `side: DoubleSide`
  （1px 翼膜）。
- 每帧 `sync(dragonEntity, nowMs)`（game 帧循环在 `entities.update` 之后调）：
  - 无实体 → `mesh.visible = false`（**draw call 归零**，M6 口径）；
  - 有实体 → `visible = true`，`mesh.position = state.position`，
    `mesh.rotation.y = yaw`，`mesh.rotation.x/z` 叠加**内倾 bank**（绕前进轴 roll
    `DRAGON.bankRoll`，盘旋恒内倾）；
  - 采样动画 → 写 33 根骨骼的 `quaternion/position`（bind + 增量）；
  - **红闪**：`nowMs < state.flashedUntil` 时 `material.color.setHex(0xff6666)`，
    否则白（颜色乘贴图 = 整体染红，与丧尸红闪同观感语义）。
- ⚠️ **不回写 state、不参与命中**（命中唯一真相 = `dragonDefinition.raycastAabb`，
  红线 6）。渲染只是 pose 的投影（同 `entity-render-layer.js` 序言约束）。

### 7.3 性能账

- 几何 2760 顶点 / 4140 索引，1 个 draw call（有龙时）—— 相对场景 ~530 draw 可忽略。
- 动画采样：33 骨骼 × 帧间 lerp/slerp ≈ 每帧 <0.05ms。
- 不进体素三通道（不是方块）→ **不触碰 `CAPACITY` 预算**，`giant-tree-budget.spec`
  冻结常量零改动。
- 不进 GEN/MESH/LIGHT → 红线 3 无涉（龙的所有计算是每帧 O(1) 主线程轻算，
  与矿车同档）。

---

## 8. Game 装配（`game.js`）

接线顺序（对照 M7「controller 接线必须在 `_waitForColumn` 之前」的教训）：

1. `start()` 早期（Player 构造前）：`this.dragons = new DragonService({entities,
   persistence, seed})` + `entities.registerType(DRAGON_TYPE, dragonDefinition)`。
2. `DragonRenderer` 在渲染装配段创建（atlas/武器之后均可，无依赖）。
3. `setEntityQuery` 注入改线（§5.3）：`damage → damageEntity`、新增 `isHittable`。
4. 帧循环（M5 帧序内，`entities.update` 前后各一件事）：
   - `entities.update` **之前**：`this.dragons.ensure()`（spawn 判定；同 zombies.update
     的「先编排后推进」位置）；
   - `entities.update` **之后**：`this.dragonRenderer.sync(this.dragons.active(), nowMs)`；
   - 炮塔索敌段（`_updateTurrets`）：targets 列表并入活着的龙（§5.3-5）。
5. 死亡标记：`DragonService.damage` 内部完成（merge 写 meta + `flushNow` 语义同
   playerPos 的写盘节流 —— 死亡是低频单次事件，直接写，不挂帧循环节流）。

---

## 9. 测试策略（testing-policy 分级）

### Tier 1（纯函数/机制，TDD）

- `src/tests/test-dragon-system.js`：
  - 轨道纯函数：确定性（同参同果）、yaw 切线方向、bob 有界、phase salt 唯一性
    （程序化扫描既有占用表）；
  - AABB：yaw=0/π/2 三向下旋转盒的尺寸与命中/脱靶临界（**在临界距离附近断言**，
    远离阈值的输入测不出旋转错误 —— 同炮塔伤害换算教训）；
  - `damage`：两发不死三发死的临界序列、health≤0 → despawn + 死亡标记被请求、
    红闪 `flashedUntil` 时间基准（performance.now 口径断言）；
  - `ensure`：无地带不 spawn / 已死不 spawn / column 未就绪不 spawn / 回收后重 spawn。
- `src/tests/test-dragon-bake.js`（或并入 check:data）：产物契约 —— 骨骼 78 /
  元素 115 / 顶点 2760 / fly 36 帧 / glide 90 帧 / UV ∈ [0,1] / scale=3。
- 伤害路由：`damageEntity` 分发（zombie/dragon/未知类型三分支）；
  `computeTurretUpdates` 的 `targets` 改名后**丧尸用例逐位零回归** + 龙目标用例
  （含 bodyOffsetY=0）。
- weapon-controller：`isHittable` 注入/缺省两条路径（缺省回落 zombie 保 M4 零回归）。

### Tier 2（数据契约）

- `check:data [龙]`：指纹 + 产物契约 + `DRAGON.scale` 与产物 scale 双向一致。

### Tier 4（像素实测）

- `src/tests/test-dragon-render.html` + `tests/dragon-render.spec.mjs`：
  黑背景隔离 fixture（同 zombie-model fixture 手法），断言：
  ① 龙渲染出非背景像素（翼展宽度量级）；② 相邻两帧像素变化 > 阈值（动画在动）；
  ③ fly 段与 glide 段采样像素差异（状态机真的切了）；④ 红闪帧整体偏红；
  ⑤ 无实体时画布零变化（visible=false 生效）。
- `tests/dragon.spec.mjs`（真游戏页 E2E）：
  ① 传送到祭坛地带（走**真实按钮** `teleportToTarnZone`，M7 教训）→ 天上存在龙实体
  （`entities` 里 type=dragon，位置在轨道上）；② `setTestAim` 瞄准龙 → 开枪 →
  health 下降 + 红闪；③ 打到死 → 实体消失 + meta.dragonDead 落库 + 刷新页面不复活；
  ④ 换 seed → 龙恢复。
  ⚠️ E2E 必须从玩家真实入口（武器射击路径），不得只调 `dragons.damage()` API
  （M7「只测 API 漏玩家主路径」教训）。

### 负向验证（每条 Tier 1 断言）

- 注入「predicate 仍只认 zombie」→ E2E 射击 health 不动，真 FAIL；
- 注入「damage 仍路由 zombies」→ 龙打不死，真 FAIL；
- 注入「visible 不随实体消失」→ draw call / 像素断言真 FAIL。

---

## 10. 有意偏离与已知取舍

| # | 偏离/取舍 | 理由 |
|---|---|---|
| 1 | 不带鞍版素材 | 用户指定 |
| 2 | 龙不进方块世界（无碰撞、不挡路、不投影） | 景观实体；阴影系统当前不覆盖动态实体（太阳阴影 spec 已注明「实体不投射不接收，本期范围外」） |
| 3 | 走远再回来血量重置 | 临时实体 + 纯函数位置的代价；用户裁定的「永久死亡」不受影响（§5.2） |
| 4 | MAG7 打不到龙（射程 10 格） | 高度 28 格的几何必然；用户选高度时已知射程约束 |
| 5 | 炮塔打龙的有效弧段取决于炮塔位置 | ±45° 俯仰的固有限制：可行水平带 [23.7, 44.0]，广场边缘的炮塔能覆盖大半圈轨道，圆心附近的只能覆盖窄弧段（§6.2 实测表） |
| 6 | 无音效、无死亡特效、无迷你地图标记 | YAGNI；用户未提，后续可加 |
| 7 | attack/idle/walk/crouch 动画不导入 | 本期只用 fly/glide；烘焙只重采样这两个，产物最小 |

## 11. 风险与未决

1. **面名→three 面序映射**（§4.1-2）若推断错，贴图会错位到邻面 —— 烘焙后第一件事
   是 Tier 4 像素校正（头部眼睛是天然标记），错了改映射表重烘，成本一次循环。
2. **catmullrom 烘焙采样**需在 Node 侧实现（欧拉角分量插值，与 Blockbench 一致）；
   若观感有偏差，退路是加密采样（60fps）。
3. 龙的 `state.position` 语义 = 身体中心（轨道点）—— 与丧尸「脚底」、矿车「块底角」
   都不同，文档与 JSDoc 必须写明（炮塔 bodyOffsetY=0 依赖此语义）。

---

## 修订说明（实施期修正，2026-11-03）

实施（`docs/superpowers/plans/2026-11-03-altar-dragon.md`）期间实测发现本文档两处错误，已按实测收敛。**代码是最终权威**，本节记录「为什么与本文件正文不同」，避免后人照正文改回去。

1. **§6.1 的 yaw 公式 `θ + π/2` 是错的，正确值是 `π − θ`**。
   推导：轨道切线 = `(−sin θ, cos θ)`（对 `x = cx + R cos θ`、`z = cz + R sin θ` 求导），
   而本仓的 yaw→前向口径是 `(−sin yaw, −cos yaw)`（AGENTS.md「出生朝向与相机旋转的测量口径」表，
   源自 `camera.rotateY(yaw)`）。令两者相等：`sin yaw = sin θ` 且 `cos yaw = −cos θ` ⇒ `yaw = π − θ`。
   原文那式子算出的前向与轨道切线**垂直**（龙会侧着身子飞）。判据落在
   `test-dragon-system.js` 的「yaw 是切线方向」（点积 > 0.99），注入原文公式真 FAIL。

2. **§5.1 的 `DRAGON_CORE_OBB.center` 应为 `[0,0,0]`，不是模型空间体心 `[0, 4.125, −2.53125]`**。
   原文与它自己 §11 风险 3「`state.position` 语义 = 身体中心」的裁定**自相矛盾**：既然 position
   就是身体中心，命中盒相对 position 的偏移自然恒 0。模型空间体心（模型原点≈脚底 → 体心）是
   **另一个语义**，另存为 `DRAGON_MODEL_CENTER` 供渲染层摆放 mesh 用（mesh 局部偏移
   `−DRAGON_MODEL_CENTER`，体心正好落在 `state.position`）。两者混用的形态是「命中盒整体抬高
   4.125 格」→ 打龙的脚底位置才掉血。

3. **§4.1 的动画重采样补充实测事实**：素材的 rotation channel 也是**增量**语义（不只是 position）——
   实测 `neck1` 的 bind rotation 是 40° 而 fly 关键帧是 ±10°、`head` 的 bind 是 −30° 而关键帧是
   +1.3~+7（若按绝对替换语义，头会在每次拍翅时翻转 37°，不合理），且素材 `override: false`
   = additive。故 frames 里存的就是增量，运行时 `bindQuat * deltaQuat`。

5. **§8 装配补充：`DragonService.warm()` 必须在 `start()` 加载阶段调**（实施期新增）。
   `findAltarTarnRegion` 冷调用实测 **12.6ms**（热调用 8.4µs）—— 若不预热，这 12.6ms 会落在
   第一个玩法帧的 `ensure()` 里（120Hz 帧预算 8.3ms → 开局掉一帧，且玩家可能根本不去祭坛地带）。
   修法 = `warm()` 在渲染器加载之后、`_waitForColumn` 之前调一次（幂等，memo 复用），
   与 `computeArenaAnchor` 在 Worker layout 入口预热同一口径。

4. **§9 的 Tier 4 判据落点修正**：面序映射（§11 风险 1）的判据**落在产物契约**
   （`test-dragon-bake.js` 逐元素逐面比对 UV 矩形），**不是像素** —— 实测这张贴图近乎均匀紫色
   （skull 的 north/south/east/west 四区均值 120/117/115/…，两两差 < 6）且素材左右对称 ⇒
   面序映射错在像素上几乎不可检测（注入 north↔up 互换后头部 luma 204.3 → 203.7）。
   flipY（§11 风险 2）的像素判据阈值须落在两侧实测值之间：正确版 luma **204.3** / 翻转版 **126**
   → 阈值 160（初版写 `> 40` 是无效判据，负向验证实测 8 passed）。

---

## v2.43 取代说明（Boss 召唤框架，2026-11-03）

本文档描述的是 v2.41 的祭坛飞龙。**用户 2026-11-03 提出「按 C 召唤每个地图的 Boss」后，
本文档的下列裁定已被取代**（代码是最终权威；权威副本见 `CLAUDE.md` 的
「祭坛之龙沉淀的活跃约束」段与 `docs/roadmap.md` 的 v2.43 行）：

| 本文档的裁定 | v2.43 的实际口径 | 取代理由 |
|---|---|---|
| §1 第 4 行「全世界恰好一条」 | **按地图分别记槽位，可多条共存**（`DRAGON_MAX_ALIVE = 4`） | 用户裁定「Boss 只能从玩家所在的地图中心位置召唤出来」+「按地图分别记槽位」⇒ 玩家可以在多个高台地带各召一条 |
| §5.2「永久死亡」（`meta.dragonDead`） | **死亡标记整体移除**，死后可被 C 重新召唤 | 用户裁定「只有 Boss 死掉后，再按 C 才会召唤出 Boss」⇒ 标记失去作用（按 YAGNI 移除，而非改造成「按地带分别记」） |
| §6.1 轨道中心 = `findAltarTarnRegion`（祭坛地带） | 轨道中心 = **召唤时玩家所在的那个高台地带圆心**（`summon` 的参数） | 用户裁定「玩家所在的那个高台地带中心」⇒ 龙不再绑定祭坛地带；连带 `warm()` 与 12.6ms 冷调用问题一起消失 |
| §8「`ensure()` 每帧跑、三个门控」 | **`ensure()` 已删**，改为按 C 显式 `summon(mapKey, cx, cz, slot)` | 保留自动生成会让「Boss1 已在 → 召唤 Boss2」永远命中「已在」，而高台地带没有 Boss2 ⇒ C 键对高台地带毫无作用 |
| 固定实体 id `'dragon-altar'` | **派生 id** `dragon:<mapKey>:<slot>`（`dragonEntityIdFor`） | 固定 id 会让「A 地带召了龙 → B 地带按 C」被 `EntityManager.spawn` 的撞 id 判据静默吃掉 |
| §7「一条龙 = 一个 SkinnedMesh」 | **实例池**：几何共享一份，骨骼与材质逐龙独立 | 多实例的必要条件；材质共享会让红闪传染（同 AGENTS.md 白闪池教训），骨骼共享会让所有龙同姿势 |

**未被取代的部分**（v2.43 明确保留，用户原话「祭坛飞龙目前的行为动作先不要做任何的变更」）：
素材与烘焙管线（§2~§4）、轨道几何与 `yaw = π − θ`（§6.1 的公式本身）、动画状态机（§6.3）、
命中盒 `DRAGON_CORE_OBB`（§5.1）、伤害路由 `Game.damageEntity` 与 `WEAPON_HITTABLE_TYPES`（§8）、
炮塔索敌 `bodyOffsetY: 0`、渲染材质口径（unlit / DoubleSide / alphaTest 0.5 / flipY）、
血量 3000（v2.42）。

**v2.43 新增的模块**（本文档未涉及）：`src/entities/bosses/boss-map.js`
（`bossMapAt(wx, wz, seed)` = 「玩家站在哪张地标级地图里」的唯一权威）与
`boss-registry.js`（`BOSS_ROSTER` 名册 = 地图 → Boss 槽位的数据表）。
召唤流程 `Game.summonBoss()` 只读这两个模块、对具体 Boss 类型一无所知 ⇒
加 Boss2 或给别的地图加 Boss 只改名册与对应 service，不动流程。

---

## v2.44 取代说明（飞龙 AI 与火球攻击，2026-11-03）

本文档描述的是 v2.41 的祭坛飞龙（纯景观实体）。**用户 2026-11-03 提出「给飞龙加智能」后，
本文档的下列裁定已被取代**（代码是最终权威；权威副本见 `CLAUDE.md` 的
「飞龙 AI 与火球沉淀的活跃约束」段与 `docs/roadmap.md` 的 v2.44 行；
设计文档 = `docs/superpowers/specs/2026-11-03-dragon-boss-ai-design.md`）：

| 本文档的裁定 | v2.44 的实际口径 | 取代理由 |
|---|---|---|
| §1「纯景观实体」「不与方块交互、不碰撞、不寻路」 | **四态机 AI**：发现玩家（视线通 + 距 ≤60）→ 追击 → 飞跃 → 喷火球 → 脱离返回 | 用户要求「让火龙和玩家的互动更有意思」 |
| §6.1 轨道 = 固定圆（`yaw = π − θ`） | orbit 模式**半径按 θ 正弦调制 ±5 格**（左右拐弯）；`wobbleAmp=0` 时逐位退回旧公式 | 用户「不一定就完全按照一个圆圈绕圈，可以左右拐弯，免得绕圈太固定显得单调」 |
| §8「`dragonDefinition.update` 不读 context」 | **update 委托给 `DragonBossAgent`**，读 `ctx.world/registry/player` 做视线与距离判定 | 行为决策抽成独立智能体类（用户架构指令：后续每个 Boss 都有自己的智能体） |
| §5.1「龙只有被击中/红闪/死亡」 | 龙**主动开火**：`fireRequest` 瞬态字段 → game.js 消费生成火球实体 | 用户「递近玩家后就可以发射火球」 |

**未被取代的部分**（v2.44 明确保留）：素材与烘焙管线（§2~§4）、`yaw = π − θ` 公式本身
（`wobbleAmp=0` 时逐位成立）、动画状态机（§6.3）、命中盒 `DRAGON_CORE_OBB`（§5.1）、
伤害路由 `Game.damageEntity` 与 `WEAPON_HITTABLE_TYPES`（§8）、炮塔索敌 `bodyOffsetY: 0`、
渲染材质口径、血量 3000（v2.42）、Boss 召唤框架（v2.43）。

**v2.44 新增的模块**（本文档未涉及）：`src/entities/bosses/boss-agent.js`（BossAgent 抽象基类）+
`dragon-boss-agent.js`（飞龙四态机）、`src/entities/dragons/fireball-system.js`（火球临时实体）、
`src/render/fireball-renderer.js`（火球渲染池）。爆炸从 `Game.explodeTnt` 抽出 `_applyExplosion`
供火球复用（TNT 口径：破坏范围 / 开关门控 / 连锁 / 丧尸伤害 / 特效全同）。
