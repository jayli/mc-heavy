# 焰魔盾牌可见化（烘焙期贴图合成）

日期：2026-11-08
状态：已批准，待实施

## 要解决的问题

焰魔的盾在游戏里完全看不见。用户实测截图 `~/ttt/bug/焰魔.png` 显示焰魔只有剑、没有盾。

**根因已实测定位**：盾的几何（240 顶点 / 4 根骨骼 `shield_root` / `shield` / `shield_right` / `shield_left`）、骨骼链、UV 坐标全都在烘焙产物里，但盾的 UV 落在主贴图 `ignis_idle_0.png` 的一块**全透明区域**；盾真正的贴图是同一 mcaddon 里的 `ignis_shield.png`，本仓从未把它接进管线。材质 `alphaTest: 0.5` 把盾的所有面判为透明丢弃 ⇒ 盾画了，但一个像素都看不见。

实测证据（本机 `pnpm`/`pngjs` 采样，2026-11-08）：

| 检查 | 结果 |
|---|---|
| 盾 UV 覆盖的 771 像素，在主贴图里不透明 | **23** |
| 同一区域在 `ignis_shield.png` 里不透明 | **346** |
| 两张贴图非透明像素重叠（8 帧 idle 全测） | **0** |
| **非盾骨骼的三角采样到盾贴图不透明像素** | **0**（合成不会污染任何其它部位） |
| 原 Mod `ignis.render_controllers.json` | 盾是独立 controller：`Texture.shield` + `part_visibility: {"*": false, "shield*": true}` |
| `bake-ignis.mjs:676` 的 `WEAPON_BONE = /^(sword|shield)/` | 只把盾排除在 `feetOffsetY` 之外，**不是不渲染** |

## 结论：这不是「缺美术资源」

`ignis_shield.png`（4853 字节，256²，8.9% 不透明）**已经在 mcaddon 里**（`焰魔RP/textures/null/entity/ignis_shield.png`）。本改动属于素材入库 + 烘焙合成，不新增任何美术资源。盾的造型、配色全部来自原作者。

## 用户裁定

1. **贴图方案**：烘焙期合成一张贴图（不引入双材质 / 第二个 SkinnedMesh）。
2. **玩法范围**：只做视觉 —— 盾出现，并跟着 `left_arm` 动画摆动。不做 `canBlockDamageSource` 的正面免疫，不做破盾阶段。

## 改动清单

### 1. 素材入库（新增 1 个文件）

`assets/ignis/src/ignis_shield.png` ← 从 mcaddon 的 `焰魔RP/textures/null/entity/ignis_shield.png` 提取，逐字节原样。

只取基础盾贴图。`ignis_shield_crack1~3` / `ignis_soul_shield` 本轮**不取**（本轮只做视觉）。

### 2. `tools/ignis-fingerprint.mjs`

- 新增导出 `IGNIS_SHIELD_TEX_SRC = path.join(IGNIS_SRC_DIR, 'ignis_shield.png')`，带注释说明「盾用独立贴图，原版是独立 render controller」。
- `ignisInputFingerprint()` 的输入串联列表从 `[geo, anim, tex]` 改成 `[geo, anim, tex, shieldTex]` —— **指纹会变**，`check:data` 会报「产物已过期，跑 npm run ignis」，这正是需要的静默过期防护。
- `IGNIS_METRICS` 新增 `shieldOpaquePixels`（盾贴图的不透明像素数，实测 5816），供门禁交叉核对。

### 3. `tools/bake-ignis.mjs`

替换现在第 597 行的「直接拷字节」（`const pngBuf = fs.readFileSync(IGNIS_TEX_SRC);`）：

```
解码两张 → 逐像素 overlay → 编码
```

合成算法：**盾图 alpha > 0 的像素覆盖主贴图，其余保留主贴图**。这样：
- 盾不透明的 346 个 UV 采样点 → 盾贴图内容
- 盾透明处 → 主贴图原内容（那 23 个渗色像素只在盾本身透明的地方可见，等于看不见）

加一条 **fail-fast 预检**（合成前）：对每个**非盾**三角面在其 UV 三角形内采样盾贴图，若命中不透明像素则 `fail()`。这条把「将来素材换版本导致 UV 布局冲突」变成烘焙期的硬错误，而不是画面上的花斑。

保留 `WEAPON_BONE = /^(sword|shield)/` 的 `feetOffsetY` 排除逻辑不变 —— 盾不参与脚底补偿，合成后仍不变。

### 4. `src/tests/test-ignis-bake.js`（Tier 1，先 RED 后 GREEN）

新增 2 条用例：

1. **「盾骨骼的 UV 在成片贴图上有不透明覆盖」** —— 遍历 skinIndex 属于 `shield*` 的三角面，在产物 PNG 上采样，断言不透明比例 > 40%（当前实测 **0%** ⇒ 先红）。这条是本次缺陷的直接回归守卫。
2. **「成片贴图 = 主贴图 ∪ 盾贴图（非盾部位零污染）」** —— 对每个**非盾**三角面采样产物 PNG，断言与源主贴图逐点一致。防止将来的合成算法改坏别的部位。

浏览器单测里读 PNG：用 `fetch` + `createImageBitmap` + `OffscreenCanvas` 取像素（`test-ignis-bake.js` 已经在用 `fetch(new URL(...))` 的模式读 JSON）。

### 5. `tests/ignis.spec.mjs`（Tier 4，像素实测）

新增 1 条：召出焰魔 → 从 `ignisRenderer.instances()` 的 skeleton 里找 `shield` 骨骼 → 取世界坐标 → 投影到屏幕 → 采样该点周围 40×40 像素，断言存在与天空/地面明显不同的像素块。

对照用现有 `pixelDiff` 手法：**同一只焰魔，盾骨骼 scale 置 0 vs 正常** 两帧对比。`instances()` 已经暴露 `skeleton`，不需要改产品代码。

同时钉**上下界**（AGENTS.md：只钉「变暗」抓不到「纯黑」）。

### 6. `tools/check-data.mjs`

`checkIgnisAsset()` 里新增两条：
- `IGNIS_SHIELD_TEX_SRC` 存在
- 产物 PNG 里盾 UV 区域的不透明像素数 > 0（内容级判据，与 `checkIgnisAsset` 现有的结构级判据互补）

## 不改的东西

- **不动渲染器**：单材质 + 单 SkinnedMesh 架构保持不变，零新增 draw call。
- **不动任何玩法数值**：`IGNIS.attackDamage` / 冷却 / 判定一概不碰。
- **不动 `feetOffsetY` / `IGNIS_CORE_OBB`**：盾本来就不参与脚底补偿与命中盒。
- **不动 `IGNIS_ATTACKS`**：盾不改变攻击档案。

## 验证

1. `npm run ignis` 重烘 → 指纹更新、`ignis.png` 变成合成结果
2. 浏览器单测 `/src/tests/index.html` → 新增 2 条先红后绿
3. 负向验证：把合成算法改成「不叠盾贴图」→ 两条单测 + check:data 同时真 FAIL（用 `cp` 副本还原，不用 `git checkout`）
4. `npx playwright test tests/ignis.spec.mjs` → 新增像素用例
5. `npm run check`（arch + data + lint）
6. 实玩截图对照：`~/ttt/bug/焰魔.png` 同机位，确认左臂上出现盾

## 一个已知的取舍

原 Mod 的盾有 4 套贴图（基础 + 3 级裂纹 + 魂态）。本轮只合成基础版，所以**不会**出现「盾越打越裂」的观感。这是「只做视觉」范围的必然结果，将来做破盾玩法时再把裂纹贴图接进来。
