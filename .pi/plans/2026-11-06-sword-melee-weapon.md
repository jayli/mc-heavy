# 紫色剑近战武器

## 目标

给玩家加一把近战剑（素材 `/Users/bachi/ttt/a/武器/altarbygwambassn2` 里的 `dragonrend`，紫色剑体）：
- R 键循环切到剑（在加特林之后）
- 左键点击挥砍（单发，非连砍）
- 近距离（≈3 格）伤害丧尸 / 焰魔 / 飞龙
- 命中后：红闪（沿用既有 `flashedUntil`）+ 击退一小步 + 播 `emp_activated.ogg`
- 挥砍时播 `player_swing.ogg`
- **剑不破坏方块**（与枪不同）

用户已确认：贴图 `dragon.png` 是 8 帧序列（frametime 3），**只用静态单帧**（不做序列帧发光动画）。

## 素材分析

- 紫色剑体 = `models/custom/dragonrend.json` + `textures/item/dragon.png`（64×512，8 帧）
- 紫色像素占 21.5%（其余四把剑 ancientblade/withersym/tide/omen 都是 0% 紫色）
- `dragonrend.json` 是 Blockbench 导出的 Java item model（16 个 element，texture_size [64,64]）
- UV 单位需实测标定（初步分析：UV × 4 ≈ 贴图像素，maxU=6→24px、maxV=16→64px，正好覆盖不透明区 x[0,23] y[0,55]）
- 静态帧取 frame 1（frame 0 明显更暗，frame 1~7 亮度相近）

## 现状与约束

**既有武器系统**（M4）：
- `weapon-catalog.js`：三把枪（pistol/mag7/minigun），每把配 transform/cooldown/sound/entityDamage/entityRange
- `weapon-controller.js`：`_fireHitscan`（枪）/ `_fireMag7`（散弹），都写方块（如果 `blockDamageEnabled`）+ 发 tracer + 查实体
- `view-weapon.js`：挂 camera 的视图模型，有 recoil/draw/spin 动画，**无 swing**
- `weapon-model-loader.js`：GLTFLoader 加载三把枪的 .glb，`WEAPON_ASSET_URLS` 硬编码
- R 键循环：`CYCLE_ORDER = [arm, pistol, mag7, minigun]`

**既有伤害系统**：
- `Game.damageEntity(id, amount, nowMs)`：按类型分发到 ZombieService/DragonService/IgnisService 的 `damage()`
- 各 service 的 `damage()`：扣血 + 置 `flashedUntil`（红闪 200ms）+ 死亡即 despawn
- **无击退**：丧尸 AI 每 tick 覆盖 velocity，焰魔/飞龙 agent 每帧推进 position

**既有音效系统**：
- `audio-config.js`：`SOUND_IDS` + `SOUND_EXT_OVERRIDES`（ogg）+ `SOUND_VOLUMES`
- `player_swing.ogg` / `emp_activated.ogg` 已在 `assets/sounds/`，但**不在 SOUND_IDS 里**（未接入）

**约束**（AGENTS.md 红线）：
- 红线 1：数据只有一份权威（击退不能新增第二份 position 缓存）
- 红线 6：实体命中只走 `EntityManager.raycast()`（AABB slab），禁止 THREE.Raycaster
- 依赖方向：`weapon-controller` 是纯逻辑层，不 import three/entities/render（击退函数由 Game 注入）
- 时间基准：`performance.now()`，禁止 `Date.now()`

## 方案

### Task 1: 素材入库 + 运行时加载器

**素材入库**：
- `assets/models/weapons/sword/dragonrend.json`（原样复制）
- `assets/models/weapons/sword/dragon.png`（原样复制，8 帧，运行时取 frame 1）

**运行时加载器**（新文件 `src/render/blockbench-model-loader.js`）：
- 解析 Blockbench Java item model JSON（elements + faces + UV）
- 按 UV 语义构建 three.BufferGeometry（每个 element 是一个 box，6 面，UV 映射到贴图）
- 加载 PNG 贴图（TextureLoader），取 frame 1（y 偏移 64px）
- 返回 three.Group（与 WeaponModelLoader 同接口）
- **UV 归一化实测标定**：打印实际采样区域 vs 贴图不透明区，确认 UV × 4 = 像素（或别的系数）

**扩展 WeaponModelLoader**（`src/render/weapon-model-loader.js`）：
- `WEAPON_ASSET_URLS` 加 `sword: { json: resourceUrl('assets/models/weapons/sword/dragonrend.json'), png: resourceUrl('assets/models/weapons/sword/dragon.png') }`
- `load(id)` 对 sword 走 BlockbenchModelLoader，其余走 GLTFLoader
- 或者 Game 装配时注入 composite loader（ViewWeapon 不感知具体 loader）

### Task 2: weapon-catalog + weapon-controller（近战分支）

**weapon-catalog.js**：
- `WEAPON_IDS` 加 `SWORD: 'sword'`
- `WEAPONS` 加 sword 条目：
  ```js
  sword: {
    id: 'sword', model: 'sword', cooldown: 0.5, recoil: 0, sound: 'player_swing', volume: 0.5,
    transform: { scale: [0.8, 0.8, 0.8], position: [0.35, -0.6, -0.5], rotation: [0, 0, -0.3] },
    // 近战：无 muzzleOffset/localStart/tracer/automatic/scan
    entityDamage: 40, entityRange: 3, melee: true,
  }
  ```
- `CYCLE_ORDER` 改为 `[arm, pistol, mag7, minigun, sword]`

**weapon-controller.js**：
- `_tryFire` 加近战分支：`if (weapon.melee) return this._fireMelee(aim, weapon)`
- `_fireMelee(aim, weapon)`：
  - 查实体命中（`_queryEntityHit`，maxDist = `weapon.entityRange` = 3 格）
  - **不写方块**（不调 `editor.setBlock`）
  - **不发 tracer**（effect 无 start/end/tracer 字段，或 tracer: null）
  - 命中时：调 `entityQuery.damage` + `entityQuery.knockback`（新注入）+ 播 `emp_activated`
  - 返回 effect：`{ type: 'melee', weaponId: 'sword', sound: 'player_swing', volume: 0.5, recoil: 0, hits: [...] }`
- `setEntityQuery` 扩展：加可选 `knockback: (id, dir, dist) => void`（Game 注入）

### Task 3: view-weapon 挥砍动画

**view-weapon.js**：
- 加 `_swingProgress`（0..1，1 = 未在挥砍）+ `_swingElapsed`
- `onShot(effect)` 对 melee 武器触发 swing：`if (effect.type === 'melee') this._swingElapsed = 0`
- `update(dt)` 推进 swing：`_swingElapsed += dt; _swingProgress = min(1, _swingElapsed / 0.3)`
- `_apply` 里对 swing 做弧线运动（类似 view-arm 的 attack/whip 曲线）：
  - `rotation.x = baseRotX - sin(sqrt(p) * π) * 1.2`（下劈）
  - `rotation.z = baseRotZ + sin(p² * π) * 0.3`（甩腕）
  - `position.z = basePosZ - sin(sqrt(p) * π) * 0.15`（前探）
- 挥砍时长 0.3 秒（实测标定）

### Task 4: 音效（audio-config）

**audio-config.js**：
- `SOUND_IDS` 加 `'player_swing', 'emp_activated'`
- `SOUND_EXT_OVERRIDES` 加 `player_swing: 'ogg', emp_activated: 'ogg'`
- `SOUND_VOLUMES` 加 `player_swing: 0.5, emp_activated: 0.6`（实测标定）

**weapon-controller.js**：
- `_fireMelee` 命中时：effect 加 `hitSound: 'emp_activated', hitVolume: 0.6`
- `player.js` 的 `_applyWeaponEffect` 消费 `hitSound`：`if (effect.hitSound) audioManager.play(effect.hitSound, effect.hitVolume)`

### Task 5: 击退（Game.knockbackEntity + entityQuery 注入）

**Game**（`src/core/game.js`）：
- 新方法 `knockbackEntity(id, dir, dist)`：
  - 读 `entity = this.entities.get(id)`
  - 位移 `entity.state.position` 沿 `dir` 方向 `dist` 格（经各 service 的 `createState` 重建，不原地改）
  - `this.entities.reindexColumn(id)`（派生索引迁移）
- `setEntityQuery` 注入 `knockback: (id, dir, dist) => this.knockbackEntity(id, dir, dist)`

**weapon-controller.js**：
- `_fireMelee` 命中时：算背离玩家的方向 `dir = normalize(entity.pos - player.pos)`，调 `entityQuery.knockback(id, dir, 0.4)`
- 击退距离 0.4 格（实测标定）

**各 service 的 damage**：
- 丧尸/焰魔/飞龙的 `damage()` 不变（击退在 Game.knockbackEntity 里做，不在 service 里）
- 焰魔/飞龙可能需要短暂硬直（0.2 秒内不追击），否则击退被 agent 立即覆盖 → 实现时实测决定

### Task 6: 测试

**test-weapons.js**（浏览器内单测）：
- cycle 顺序断言更新：`arm → pistol → mag7 → minigun → sword → arm`
- 加近战用例：`_fireMelee` 不写方块、命中实体、播音效

**weapons.spec.mjs 或新增 sword.spec.mjs**（Playwright）：
- R 键切到剑，`weaponDebugState().selectedId === 'sword'`
- 左键挥砍，`viewWeapon.state.swingProgress < 1`（动画触发）
- 近距离丧尸，挥砍后丧尸 `health` 减少 + `flashedUntil` 置位 + position 位移（击退）
- 音效播放请求增长（`audioPlayRequests`）
- **剑不破坏方块**：挥砍后方块不变（与枪对照）

## 验证

1. `npm run check`（arch + data + lint）：
   - `check:data` 的音效环节断言 `player_swing.ogg` / `emp_activated.ogg` 存在
   - `check:arch` 断言 weapon-controller 不 import three/entities/render
2. `npm test`（Playwright 全量）：
   - test-weapons.js 的 cycle 顺序 + 近战用例
   - sword.spec.mjs 的挥砍 + 命中 + 击退 + 音效
3. 实测（浏览器）：
   - R 键切到剑，能看到紫色剑体
   - 左键挥砍，剑做弧线运动 + 播 player_swing
   - 近距离丧尸，挥砍命中 → 丧尸红闪 + 后退一小步 + 播 emp_activated
   - 焰魔/飞龙同理
   - 挥砍不破坏方块（与枪对照）

## 文件清单

**新增**：
- `assets/models/weapons/sword/dragonrend.json`（素材）
- `assets/models/weapons/sword/dragon.png`（素材）
- `src/render/blockbench-model-loader.js`（运行时加载器）
- `tests/sword.spec.mjs`（Playwright 测试，或合并进 weapons.spec.mjs）

**修改**：
- `src/render/weapon-model-loader.js`（扩展，对 sword 走 blockbench loader）
- `src/player/weapons/weapon-catalog.js`（加 SWORD + CYCLE_ORDER）
- `src/player/weapons/weapon-controller.js`（加 _fireMelee + knockback 注入）
- `src/render/view-weapon.js`（加 swing 动画）
- `src/render/audio-config.js`（加 player_swing + emp_activated）
- `src/player/player.js`（_applyWeaponEffect 消费 hitSound）
- `src/core/game.js`（加 knockbackEntity + setEntityQuery 注入 knockback）
- `src/tests/test-weapons.js`（cycle 顺序 + 近战用例）

## 风险与实测标定点

1. **UV 归一化**：Blockbench JSON model 的 UV 单位需实测标定（初步分析 UV × 4 = 像素，但要在真实数据上打印确认）
2. **剑的 transform**：position/rotation/scale 需实测标定（类似枪的 transform，但剑是长条形）
3. **挥砍动画曲线**：rotation/position 的弧线运动需实测标定（类似 view-arm 的 attack/whip）
4. **击退距离**：0.4 格需实测标定（太小看不见，太大像瞬移）
5. **焰魔/飞龙硬直**：击退后 agent 立即走回来 → 可能需要短暂硬直（0.2 秒内不追击），实现时实测决定
6. **音效音量**：player_swing 0.5 / emp_activated 0.6 需实测标定

## 不做的事

- 序列帧发光动画（用户确认只用静态单帧）
- 连砍（用户确认单发点击）
- 剑破坏方块（用户明确「剑不能像枪一样破坏方块」）
- 剑的 tracer（近战无曳光）
- 剑的 recoil（近战无后坐）
