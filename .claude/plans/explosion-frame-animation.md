# TNT 爆炸序列帧特效补齐（对齐 mc-lite ParticleSystem 爆炸层）

## 1. 问题诊断（已实测核实，非推断）

mc-lite 的 TNT 爆炸是**两层叠加**，mc-heavy 只移植了第 2 层：

| 层 | mc-lite 出处 | mc-heavy 现状 |
|---|---|---|
| ① 序列帧 billboard | `ParticleSystem.spawnExplosionEffect`（`ParticleSystem.js:177`），由 `World.js:1298` 调用 | **缺失** |
| ② 球体扩张 | `World.js:1301-1311` | 已有 = `src/render/explosion-renderer.js` |

`World.js:1296 spawnExplosionParticles` 的代码事实是「① 先触发 2D billboard 爆炸 → ② 再触发球体扩张（注释原文：作为底层增强）」。本仓库 `explosion-renderer.js` 文件头也如实记了「只移植球体扩张层」—— 所以这不是 bug，是 M8 当时的**有意裁剪**，现在补齐 ①。

mc-lite 序列帧层的冻结参数（`ParticleSystem.js:27-37 / 113-119 / 177-188`）：

- 图集 `big_blow.png`，**实测 500×200 RGBA8**，布局 **5×2 = 10 帧**，单帧 100×100（方形）
- 池容量 **10**，寿命 **0.5s**，**AdditiveBlending**，`depthWrite:false`
- `magFilter/minFilter = NearestFilter`，`repeat = (1/5, 1/2)`
- `frameAspect = (imageAspect × tilesY) / tilesX = (2.5 × 2)/5 = 1.0`（方形帧，无比例失真）
- scale = `baseScaleX × (3.0 + progress × 5.0)` → 3 起、8 终
- opacity = `progress < 0.8 ? 1.0 : 1.0 - (progress-0.8)/0.2`（前 80% 全亮，末 20% 淡出）
- 逐帧：`frame = floor(progress × 10)`，`col = frame % 5`，`row = floor(frame/5)`，
  `offset.x = col/5`，`offset.y = 1 - (row+1)/2`
- spawn 时 `material.rotation = Math.random() × π`（随机旋转，避免多个爆炸观感雷同）

## 2. 关键技术事实（逐条已在 vendor 源码核实，不靠推断）

这些是「照搬 Sprite 池」在 WebGPU 后端能否成立的前提，全部实测过：

1. **`SpriteMaterial` 在 WebGPU 后端可用** —— `three.webgpu.js:86739` `addMaterial(SpriteNodeMaterial, 'SpriteMaterial')` 做了映射；`:62283` `projectObject` 有 `object.isSprite` 分支并推进渲染列表。**不是不支持的类型**。
2. **`texture.offset` 会被 TSL 材质消费** —— `TextureNode.update()`（`:13236-13253`）在 `texture.matrixAutoUpdate === true` 时调 `texture.updateMatrix()`，把 offset/repeat 折进 `texture.matrix` 经 uniform 传 shader。
   ⚠️ **这是本改动最大的静默失效风险**：若后端不消费 offset，序列帧会恒显第 0 帧 —— 爆炸照常播、照常淡出，只是图案不动，肉眼几乎看不出差别。故 Tier 4 像素实测必须落在「不同帧采到不同区」的判据上（见 §5）。
3. **逐 sprite `visible=false` 能还原 draw call 基线** —— `:62263` `projectObject` 首行 `if (object.visible === false) return`。与本仓库 InstancedMesh 池的 `visible=false` 手法（M6 活跃约束 ①）**同等效果**，10 个空闲 sprite 不提交渲染。
4. **`texture.clone()` 不是图像内存副本** —— three 的 clone 共享同一个 `Source`（同一份 GPU 上传），只复制参数（offset/repeat/wrap/filter）。故 10 份 clone **不构成红线 1 的「第二份权威数据」**（那是逻辑体素数据的约束，不适用于纯视觉纹理参数）。这点须在代码注释里写明，否则后续评审会误判。
5. **素材不能放 `assets/textures/`** —— `tools/build-atlas.mjs:17` 递归扫描该目录，新增文件会**重排所有已有 tile 坐标**（shelf 装箱按字母序）→ 世界 atlas 全量失效。须新建 `assets/effects/`（`assets/zombie/`、`assets/turret/` 已有同类先例：非 atlas 的独立资源目录）。

## 3. 实现方案

### 3.1 素材落地

```
assets/effects/big_blow.png    # 从 mc-lite src/assets/gif/big_blow.png 原样复制（500×200 RGBA）
```

不烘焙、不改内容 —— 直接复用上游素材（CLAUDE.md「直接复用」清单同口径）。无需 `npm run atlas`。

### 3.2 新增 `src/render/explosion-sprite.js`

分层归属 `render/`（主线程专用，不在 `ISOMORPHIC_DIRS` 内 → 天然不受同构检查，无需白名单；同 `zombie-head-texture.js` 的理由）。

内含两块：

**(a) `loadExplosionSpriteTexture()`** —— 纹理加载（同 `zombie-head-texture.js` 手法）：
- 绝对路径 `/assets/effects/big_blow.png`（fixture 页在 `/src/tests/` 下，相对路径会 404 —— 同 `atlas-loader.js` 踩坑记录）
- `colorSpace = SRGBColorSpace`、`NearestFilter`、`generateMipmaps = false`、`repeat.set(0.2, 0.5)`
- ⚠️ **repeat 必须在 clone 之前设置** —— clone 复制参数，顺序反了则每个 clone 的 repeat 丢失 → 采样整幅图集（10 帧叠在一起），观感是「一团糊」而非分帧。这是照搬 mc-lite 时的顺序依赖，注释须点明。

**(b) `ExplosionSpriteRenderer` 类** —— 10 slot Sprite 池，逐行对齐 mc-lite `_updatePool`：
- 每 slot：`texture.clone()` + 独立 `SpriteMaterial`（`AdditiveBlending`、`transparent`、`depthWrite:false`、初始 `opacity:0`）+ `THREE.Sprite`，`visible=false` 入 scene
- `spawn(position, nowMs)`：找空闲 slot（池满时**丢弃**，纯视觉无副作用 —— 与 `explosion-renderer.js` 的「池满覆盖最旧」同为纯视觉丢弃口径）；写位置、`rotation = Math.random()×π`、`timer=0`、`visible=true`
- `update(nowMs, dt)`：`progress = timer/0.5` → 逐帧 offset + scale `(3+p×5)` + opacity 曲线 → `progress≥1` 时 `visible=false`
- ⚠️ **时间基准 `performance.now()`，禁止 `Date.now()`**（M6 活跃约束，两者相差约 17 亿毫秒 → 判定恒真、特效永不消退）
- ⚠️ **纹理未加载完成时不 spawn**（消除 mc-lite 的竞态：其 `frameAspect` 在异步回调里算，加载完成前 sprite 尺寸是占位值 1 → 早期爆炸尺寸错）。本仓库用 `_textureReady` 门控 `spawn()` 早退。这是**唯一一处有意改进 mc-lite**，须在注释里注明理由。
- `dispose()`：逐个 `scene.remove` + `material.dispose()` + 纹理释放（Sprite 不自动释放材质）

### 3.3 `src/core/game.js` 接线（三处）

1. **装配**：`await loadExplosionSpriteTexture().catch(...)`（同 `game.js:121` 丧尸头部纹理先例：失败退回 null，不阻断启动）→ `new ExplosionSpriteRenderer({scene, texture})`，放在 `this.explosionRenderer` 旁边
2. **触发**：`explodeTnt()` 的 ⑦ 段（`game.js:828-831`）—— 在现有 `explosionRenderer.burst(...)` **同帧**加 `explosionSprite.spawn(...)`（同一坐标 `center + 0.5`，同一 `now`）。mc-lite 就是这个顺序（billboard 先、球体后）。
3. **帧循环**：`game.js:550` 现有 `explosionRenderer.update(nowMs)` 旁边加 `explosionSprite.update(nowMs)`；`dispose()`（`:1253`）同步加释放。

⚠️ **装配顺序须在任何 `onColumnReady` 回调之前**（M7 活跃约束：服务创建晚于回调触发 → 第一行 return → 装置静默不工作）。这里装配在渲染层段（`_waitForColumn` 之前），与 `explosionRenderer` 同位置，天然满足。

## 4. 测试分级判定（testing-policy 判据）

| 改动 | 改坏了会怎样 | 级别 |
|---|---|---|
| offset 帧映射纯算术 | 序列帧顺序错乱/恒显一帧 | **Tier 1**（纯函数单测 + 负向锚点） |
| GPU 实际采样到的图案 | 单测读不到片元输出 | **Tier 4**（像素实测） |
| 素材路径 / 文案 | 立刻可见 | Tier 3（只需 lint） |

## 5. 测试计划

**(a) 浏览器内单测**（`src/tests/test-explosion-sprite.js` + 注册进 `index.html`）：
- `progress → (col,row,offset)` 映射：0.05→帧0、0.5→帧5、0.95→帧9、≥1→结束
- **负向验证锚点**：断言「offset 随 progress 变化」而非只钉单点 —— 注入「offset 恒 0」须真 FAIL（这是 §2 风险 2 的对应盲区，testing-policy §2.7）
- offset.y 的 `1-(row+1)/tilesY` 翻转判据（图集行序自上而下，UV 原点左下 → 不翻转会上下颠倒）
- 池满丢弃、寿命结束 `visible=false`

**(b) Tier 4 像素实测**（新增 `src/tests/test-explosion-sprite.html` fixture + `tests/explosion-sprite.spec.mjs`）：
- 判据 = **帧 0 vs 帧 9 的区域亮度/色值须显著不同**（`regionRGB` 手法照搬 `turret-render.spec.mjs`）
  → 注入「offset 不更新」会让两帧相同 → 真 FAIL。这是本改动**唯一能证明 GPU 真在切帧**的断言。
- fixture 用 `NoToneMapping` + `SRGBColorSpace`（真实游戏口径，同 `test-turret-render.html:41-44`）；纯黑背景 + 单 sprite，避免 additive 叠加干扰判据
- 附加断言：纹理尺寸 `[500,200]`、10 个 slot 全部 `visible=false`（draw call 回基线，同 `turret-render.spec.mjs` 第二条 test 手法）
- ⚠️ **不宣称目视验证**（截图 `Read` 只返回 URL，须像素实测 —— CLAUDE.md 实测环境事实）

## 6. 门禁与文档同步

- `npm run check`（Tier 2/3）+ `npm test`（新增 spec）+ `npm run lint`
- **不跑 bench** —— 无活跃爆炸时 10 个 sprite 全 `visible=false`，不提交渲染 → draw call 基线不变（§2 风险 3 已核实）。若实测发现基线变化，则按 M6 手法排查并补 bench。
- 文档三类同步（CLAUDE.md 明确要求）：
  - **目录结构清单**：加 `assets/effects/` + `src/render/explosion-sprite.js`
  - **现状声明**：`explosion-renderer.js` 文件头的「只移植球体扩张层」改为「两层齐全」
  - **roadmap**：M8 遗留 TODO 段记一笔「爆炸序列帧层已补齐」
- **不 bump 设计文档版本号** —— 这是补全 mc-lite 视觉完整性，非架构口径变更（CLAUDE.md 口径：版本号 bump 是架构口径变更专用）
- CLAUDE.md「M8 沉淀的活跃约束」加一条：**WebGPU 后端序列帧切帧走 `texture.offset` + `TextureNode` 的 matrix uniform，且 repeat 须在 clone 之前设置** —— 后续 pick/block_crash 两个特效、以及任何序列帧装置同理。

## 7. 不做的事（明确边界）

- **不补** `pick.png`（枪击击中）与 `block_crash.png`（徒手破坏）两个序列帧特效 —— 按你的选择只做 TNT。序列帧基础设施（图集加载 + Sprite 池 + 逐帧 offset）建成后，那两个是同套东西换参数，后续补的成本很低。
- **不改** 球体扩张层（`explosion-renderer.js`）—— 保留不动，两层叠加与 mc-lite 一致。
- **不改** 爆炸的玩法语义（破坏范围 / 连锁 / 伤害 / 音效）—— 只补视觉层。
