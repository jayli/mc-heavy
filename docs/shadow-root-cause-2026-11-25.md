# 阴影跳变根因定位报告（2026-11-25 第二轮调研）

> 报障素材：`~/ttt/bug/影子刷新的问题.mov`（8.46s，120fps，seed 732494，DESERT）
> 前置：`docs/retro-2026-11-25-shadow-refresh-failed-attempts.md`（五轮失败复盘）
> 本轮结论：**两个报障同源，根因已定位并用单变量 A/B 实测验证**。源码未改（探针全部在 `tests/tmp-*`，已 gitignore）。

---

## 1. 根因（一句话）

**水面倒影的「反射替身材质」引入了第二个 `ShadowNode`，它与主材质的 `ShadowNode`
争抢同一个 `sunLight.shadow.needsUpdate` 标志，却共享同一个 `shadow.matrix`。
反射 pass 在主 pass 之前跑 ⇒ 替身先消费刷新权：它渲自己的贴图、并把共享矩阵更新到当前相机；
主 pass 的贴图因此不刷新（陈旧），却用着被替身更新过的新矩阵采样 ⇒ 「矩阵新 + 贴图旧」错配。**

错配的表现就是用户看到的两件事：

| 报障 | 机制 |
|---|---|
| A 走动时身边影子跳变 | 主贴图陈旧 ⇒ 影子钉在旧相机位置；主 node 偶尔抢到刷新权时影子突然跳到新位置 |
| B 整片沙漠突然全暗/全亮 | 错配期间当前视域的世界点被新矩阵映射到旧贴图的错误纹素 ⇒ 整片 shadow 值错乱 |

「时有时无、找不到规律」的来源：反射每 2 帧跑一次（`REFLECT_REFRESH_EVERY=2`）+ 200ms 节流，
主 node 只在「反射不跑 ∩ 节流放行」的帧才刷新 ⇒ 刷新权在两个 node 之间**随机交替**。

---

## 2. 机制链（逐环有实测出处）

### 2.1 两个 ShadowNode 的来源

- `src/render/materials.js:153`：`shadow(sunLight)` 每次调 `createVoxelMaterials` 都 `new ShadowNode`。
- `src/render/render-world.js:69`：主材质建一次。
- `src/render/render-world.js:203`：**反射替身** `createVoxelMaterials(this.atlasTexture, this._sunLight || null, null)` 又建一次。
  替身存在的理由（v3.33 方案 A）：反射 pass 正在写反射 RT，体素材质若采样它会触发
  WebGPU `writable usage … same synchronization scope` ⇒ 整帧作废。替身只是「不引用该 RT」。
  **但它顺带把 `sunLight` 也传进去了 ⇒ 多出一个 ShadowNode。**

实测（探针 P12/P14）：`renderer._nodes.nodeBuilderCache` 里共 **3 个** ShadowNode 实例
（主 opaque/cutout 共享 1 个 + 替身 1 个 + 第三个来自另一处材质编译），各自有**独立的**
`vsmShadowMapHorizontal` RT（texId 52 / 59 / 69）。

### 2.2 共享与独立的部分（three r185.1）

| 对象 | 归属 | 后果 |
|---|---|---|
| `shadow.needsUpdate` | **单一标志**（`LightShadow`） | 两个 node 争抢；先跑者消费后置 false |
| `shadow.matrix` | **单一 Matrix4** | 任一 node 的 `updateMatrices` 都写它 ⇒ 主 pass 采样矩阵被替身更新 |
| `shadow.camera` | 单一正交相机 | 同上 |
| `shadowMap` / `vsmShadowMapHorizontal` | **每 node 独立**（`setupShadow` 里 `builder.createRenderTarget`） | 替身刷新不写主贴图 |

关键源码：
- `vendor/three/three.webgpu.js:45484`：`needsUpdate = shadow.needsUpdate || shadow.autoUpdate`；
  渲完 `shadow.needsUpdate = false`（:45504）。
- `vendor/three/three.webgpu.js:45331`：`renderShadow` 内 `shadow.updateMatrices(light)` ⇒ 写共享矩阵。
- `src/core/game.js:1894`：`_renderWaterReflection()` 在 `renderer.render(scene, camera)` **之前**。

### 2.3 帧序与争抢

```
shadowScheduler.tick 放行 → shadow.needsUpdate = true
_renderWaterReflection()          ← 反射 pass（每 2 帧）
   └ 替身材质 renderObject → 替身 ShadowNode.updateBefore
       ├ 消费 needsUpdate → 置 false
       ├ 渲替身 RT（主 RT 不动）
       └ updateMatrices → 共享 shadow.matrix 更新到当前相机
renderer.render(scene, camera)    ← 主 pass
   └ 主 ShadowNode.updateBefore：needsUpdate 已 false ⇒ 不渲
       └ 主 pass 用「新矩阵」采样「旧主贴图」 ⇒ 错配
```

---

## 3. 实测证据（探针口径与读数）

所有探针在 `tests/tmp-shadow-root*.spec.mjs`（gitignore），原始读数在 `/tmp/shadow-root/p*.json`。
判据遵循复盘 §8.2：**量固定世界点的 `shadowCoord.z` 与 VSM 水平 pass 的 `mean`，不量屏幕亮度**；
并换算成世界深度差 `gap = (z − mean) × (far − near)`（去掉相机平移的编码影响，守恒量）。

### P14 —— 主 pass 采样哪个 RT、谁在刷新（决定性）

在 `_bindings.updateForRender` 之后读主地形 renderObject 的 sampled-texture binding，
与三个 node 的 `vsmShadowMapHorizontal.texture.id` 比对：

```
主 pass（opaque + cutout）采样 RT idx = 0（texId 52）
40 帧（每帧 request）刷新归属：i=0 → idx=2；i=25 → idx=0
```

⇒ **主 pass 采样的贴图在 40 帧里只刷新 1 次**，其余刷新发生在别的 RT。

### P15 —— 单变量 A/B：反射期冻结 needsUpdate（修法验证，交替 3 轮）

唯一变量：`beginReflectMaterialSwap` 期间把 `shadow.needsUpdate` 暂存置 false、结束后恢复
（替身不消费刷新权）。其余全同（seed 732494、vd=6、noon、reflect 开、玩家沿 −Z 走 24 格）。

| round | fix | 主RT刷新次数 | 替身刷新次数 | gapSpread | flips |
|---|---|---|---|---|---|
| 0 | false | 4 | 1 | 0.0283 | 0 |
| 0 | true  | 4 | 1 | 0.0165 | 0 |
| 1 | false | 3 | 2 | **8.1574** | 0 |
| 1 | true  | 4 | 1 | 0.0302 | 0 |
| 2 | false | **0** | 5 | **21.7165** | **1** |
| 2 | true  | 4 | 1 | **0.0302** | **0** |

⇒ 缺陷臂主刷新次数 0~4 不稳定、gap 最大漂 21.7 格并翻转；
修法臂主刷新恒 4、gap 守恒到 0.03 格、零翻转。**修法有效。**

缺陷臂（round 2）的 gap 漂移形态（采样点固定、树固定）：

```
i=0  gap 20.70   i=12 gap 18.62   i=36 gap 1.51   i=48 gap −1.02（翻转）
```

z 在变（矩阵被替身更新）而 mean 不跟（主贴图陈旧）⇒ 正是错配。

### P16 —— 矩阵更新归属 vs 主 RT 刷新归属（最后一环）

包每个 node 的 `renderShadow`，比对前后 `shadow.matrix.elements`：

```
i=24  idx=0(主)  矩阵变   ← 主刷新，一致
i=49  idx=2(替身) 矩阵变   ← 替身刷新：共享矩阵变、主 RT 未刷 ⇒ 错配
最后主刷新帧 24，最后替身刷新帧 49 ⇒ 错配持续 11 帧（~0.18s）
```

⇒ 直接证明「替身更新共享矩阵但不刷主贴图」。错配会**持续**到下次主刷新，
玩家持续移动时错配量随距离累积 ⇒ 整片错乱（报障 B）。

### 视频侧佐证

逐帧亮度（沙漠区域 YAVG）跳变点：n=219（182→145）、n=256（162→133）、n=340（135→176）。
n=218 与 n=222 的 HUD **完全相同**（530.9 21.1 −68）⇒ 玩家没动而画面变暗
⇒ 排除「移动触发」，指向「刷新权交替」本身。暗帧有**直线边界**的半片暗区
（错配把当前视域映射到旧贴图的错误区域），不是几何遮挡的形状。

---

## 4. 为什么前五轮都没抓到

| 轮 | 它的判据 | 漏在哪 |
|---|---|---|
| 1 纹素对齐 | 影区亮度 spread | 对齐确实是好的；缺陷不在对齐 |
| 2 矩阵上传时序 | GPU 字节 vs JS `shadow.matrix` | 两者**一致**（都新）；没量「贴图内容 vs 矩阵」的同帧性 ⇒ 漏掉贴图旧这一半 |
| 3 太阳方向门控 | 屏幕跳变 | 参数快 10× + 隔离无效；且屏幕判据混噪声 |
| 4 沿 dir 深度污染 | 固定点 z 随移动漂 | **z 漂是正确行为**（相机跟随）；缺陷是「mean 不跟」。修法钉死 z ⇒ 破坏覆盖不变式 ⇒ 回归 |
| 5 streaming 补刷新 | request 次数 | 把刷新率当根因；且逐帧挂请求造成风暴 |

共性：**判据落在「矩阵一致性」或「现象统计量」上，没有落在「主贴图与主矩阵是否同帧」这个不变式上。**
本轮的 `gap` 守恒判据 + 「主 RT 刷新归属」直接量到该不变式，一次定位。

另：本轮也排除了两个中途假设（留档避免重踩）：
- 「贴图与矩阵差一帧」的**普通**错配：P7 帧内原子取样证明主 node 自己刷新时两者同帧；
  P5/P8 里看到的「异常帧」是探针在 GPU 回读 `await` 期间跨帧的**测量伪象**（P11 停帧循环后消失）。
- 「near 平面切掉玩家后方高处物体」：真实存在（`near=0.1`、相机在玩家 +dir×60），
  但它只影响玩家后方 ~65 格外的高物，且是连续切割；不是视频里「玩家不动也跳」的主因。

---

## 5. 修法方向（用户 2026-11-25 裁定方案 A，已落地 —— 见 §7）

约束：既有测试 `src/tests/test-puddle-reflect.js` 钉住「替身必须用同一个
`createVoxelMaterials` 且传 `this._sunLight`」（保证除 RT 外着色一致）。

| 方案 | 做法 | 代价 |
|---|---|---|
| **A 反射期冻结刷新权**（已实测有效） | `beginReflectMaterialSwap` 暂存 `shadow.needsUpdate` 置 false，恢复时写回 | 替身 RT 陈旧 ⇒ 倒影里地形阴影略旧（观感可接受）；改动最小 |
| B 共享 RT | 替身 node 复用主 node 的 `shadowMap`/vsm RT | 谁渲都写同一张贴图 ⇒ 争抢无害；但需覆写 `setupRenderTarget`，且两 node 的 `shadow.map` 互相覆写需一并处理 |
| C 替身不接阴影 | 替身 `createVoxelMaterials(atlas, null, null)` | 只有一个 ShadowNode；但倒影里地形无阴影（偏亮），且要改既有测试 |

推荐 **A**：单变量、已验证、不碰既有测试钉住的同构约束。
落地时需补的判据（复盘 §6.6 教训：必须设上界）：
- 主 RT 刷新次数 ≥ 节流放行次数（不能只设 >0）；
- 固定世界点 `gap` 守恒（spread < 0.1 格）且 `isLit` 零翻转；
- 负向：去掉冻结 ⇒ 主刷新次数下降 / gap 漂移真红。

---

## 6. 复现与探针清单

```bash
MC_ALLOW_TMP=1 npx playwright test tests/tmp-shadow-root10.spec.mjs -g P12   # 数 ShadowNode
MC_ALLOW_TMP=1 npx playwright test tests/tmp-shadow-root11.spec.mjs          # 主 RT 归属
MC_ALLOW_TMP=1 npx playwright test tests/tmp-shadow-root12.spec.mjs          # A/B 修法验证
MC_ALLOW_TMP=1 npx playwright test tests/tmp-shadow-root13.spec.mjs          # 矩阵归属
```

| 探针 | 用途 | 关键读数 |
|---|---|---|
| P1/P2 | GPU 侧矩阵一致性、固定点 z/mean | desync 0；z 与 mean 同步漂（排除普通错配） |
| P3/P4 | 树影内点 flips、全图 mean 分布 | 翻转 1 次；darkFrac 跳增 |
| P5/P7 | 柱顶纹素比对、帧内原子取样 | 主 node 自刷新时同帧；异常帧=探针跨帧伪象 |
| P8/P9/P11 | 世界深度 gap 守恒（含停帧循环） | gap 在相机跳变帧突变 ⇒ 指向刷新归属 |
| P10 | 树 section 在阴影 pass 的可见性 | 树 instance 一直在（排除剔除） |
| **P12/P14** | **ShadowNode 实例数、主 RT 刷新归属** | **3 实例；主 RT 40 帧只刷 1 次** |
| **P15** | **A/B 冻结刷新权** | **gap 21.7 → 0.03，flips 1 → 0** |
| **P16** | **矩阵更新归属** | **替身刷新时矩阵变、主 RT 未刷** |
---

## 7. 落地记录（v3.41，用户裁定方案 A）

### 7.1 改动

| 文件 | 改动 |
|---|---|
| `src/core/game.js` | 反射装配段：`beginReflectMaterialSwap()` 后暂存 `shadow.needsUpdate` 并置 false，`finally` 里原样写回（+15 行，含注释） |
| `tests/sun-shadow.spec.mjs` | 新增用例 11（Tier 4 回归门，+211 行） |
| `src/tests/test-puddle-reflect.js` | 装配段窗口改为「到 `endReflectGuard()` 为止」+ 新增冻结/写回结构断言 |

**零新增 pass / 零新素材 / 零参数改动**。既有冻结常量（`mapSize` / 覆盖 ±96 / `radius` /
`SHADOW_FLOOR` / `minIntervalMs` / `SUN_DIR_GATE_DEG`）一律未动。

### 7.2 交替对照（3 轮，每轮换源码 + 新页面）

⚠️ 不能用「进程内包一层函数切 arm」：hook 的 `__hooked` 标记跨 arm 残留 ⇒ 只有第一轮计到数
（实测后 7 轮 mainRefresh 全 0，是**探针伪象**不是行为）。改为每轮 `cp` 换源码后重跑。

| round | arm | mainRefresh | otherRefresh | gapSpread | gapMin | flips |
|---|---|---|---|---|---|---|
| 1 | fix | 62 | **0** | **0** | 2.6838 | 0 |
| 1 | defect | 13 | 49 | 245.32 | −236.116 | 2 |
| 2 | fix | 64 | **0** | **0** | 2.6838 | 0 |
| 2 | defect | 11 | 51 | 11.53 | −2.3316 | 2 |
| 3 | fix | 61 | **0** | **0** | 2.6838 | 0 |
| 3 | defect | 7 | 54 | 245.32 | −236.116 | 2 |

修复态三轮 `otherRefresh` / `gapSpread` / `flips` **逐位相同**；缺陷态每轮都失败。
缺陷是间歇的（otherRefresh 49/51/54），故按仓库规矩看分布不看单次。

### 7.3 负向验证

`edit` 注入（去掉冻结与写回）→ **读回源码确认注入落地** → 跑 → `cp` 副本还原（不用 `git checkout`）。

- Tier 4 用例真红在**主判据**：`mainRefresh=49 < forced=60`。
- 新增 Node 结构断言真红：`反射期须冻结 shadow.needsUpdate 并在 finally 写回`。

⚠️ **首版负向落在 sanity 上（判别力不足）**：`gapMin>0` 当前提时，缺陷态先撞
`gapMin=−236.116` 的 sanity ⇒ 证明不了主判据有判别力。把影区归属移到主判据 ④ 后才成立。

### 7.4 验证证据

```
check:arch  ✓ 架构红线全部守住
lint        0 errors / 186 warnings（非探针文件）      ← 186 = 既有基线
            （另 2 个 warning 在 gitignore 的 tests/tmp-shadow-root10.spec.mjs 里）
Node 单测   test-shadow-manager + test-light-writeback + test-puddle-reflect
            3 文件 / 39 例 ✓ 全部通过
Playwright  sun-shadow + puddle-reflect + water-reflect
            20 passed (2.4m)
```

⚠️ **既有失败（与本轮无关）**：`check:data` 的 `[水中脚步声]` 产物指纹 —— 干净 HEAD 上同样读数。
**未跑** `npm test` / `bench --check`：改动只在反射装配段加两行标志暂存，不碰热路径。

### 7.5 三个夹具坑（已写入 pitfalls）

1. **`reflectHeightFade` 读相机 y 不是玩家 y**：首版照抄既有平台夹具（y=80、相机 102）
   ⇒ 超过 `REFLECT_HEIGHT_ZERO=48` ⇒ fade=0 ⇒ 反射 pass 整个不跑 ⇒ 判据全绿毫无意义
   （实测 `reflectDelta=0`）。处置：平台压到 y=6、相机 y≈9。
2. **手动摆光源会与帧循环打架**：`_updateSunPosition()` 每 5 格把光源拉回玩家 ⇒
   实测 z 在两个值间跳。处置：交给游戏自己的移动阈值路径。
3. **源码结构断言不要用固定字符窗口**：`test-puddle-reflect.js` 的 `slice(i, i+900)`
   在本轮插入注释后把 `endReflectGuard()` 挤出窗口（实测跨度 1388）⇒ 对正确代码真红。
