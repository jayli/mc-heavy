# 末影守卫（Ender Guardian）Boss 导入实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Cataclysm 模组的末影守卫移植进 mc-heavy，作为废弃堡垒（ruined_citadel）的 Boss —— 玩家进堡垒占地后按 B 召到地牢**上层房间**（玩家真能走到的那一层），三招纯近战 + 脱困跳，血量 2000。

**Architecture:** 照搬焰魔（v2.55）的五层结构（config 冻结数值 / system definition+service / boss-agent AI / model+renderer / game.js 装配），全部顺着既有召唤框架（`boss-map.js` 判定器 + `boss-registry.js` 名册各加一行，`Game.summonBoss()` 不动）。两处与焰魔**不同形**：① 烘焙管线 —— 末影守卫没有 Bedrock 素材，只有 Java 的 `ModelEnder_Guardian.java`，故把 `tools/ignis-java-reference.mjs` 里已验证的 Citadel 解析语义抽成共享模块，再写成生产烘焙器；② **骨骼位置公式** —— Java 顶点是骨骼局部坐标（Bedrock 是绝对），渲染器用 `localPosition + delta` 而不是焰魔的 `pivot − R·pivot + delta`（spec §2.2.1 / §10）。

**Tech Stack:** Node 26 + three r185.1（本地 `vendor/three/`，WebGPU 唯一后端）、pngjs、Playwright（`channel:'chromium'`）。无新依赖。

**Spec:** `docs/superpowers/specs/2026-11-11-ender-guardian-boss-design.md`（本计划从它论证，执行时两份都读）

## Global Constraints

- **提交须等用户明确指令**（AGENTS.md）：每个 Task 的 commit 步骤写好命令与 message，但执行前等用户发话；未发话时累积到最后一起问。
- **工作区可能有别的会话未提交的改动**：不碰、不暂存、`git add` 只按文件名加本任务文件。**禁用 `git stash`（含 `git stash list`）**。
- **坐标口径统一取 A（仅翻转 + 局部顶点）**（spec §2.2.1）：顶点 `y → −y`、`localPosition = pos/16`、`feetOffsetY = −1.5`。烘焙器 / 渲染器 / 产物复算用例 **三处必须同口径**，混用的形态是整体陷地/悬空 1.5 格而所有计数全对。
- **单测基线 1882/1882**（审阅时实跑确认）；harness 窗口 150s / 全局 timeout 200s **不需改**。
- **负向验证撤销注入用 `cp` 副本还原，禁止对含未提交改动的文件用 `git checkout`/`restore`**（已发生过真实数据丢失）。
- **同构层（红线 8）**：`src/entities/**` 不得 import three、不得碰 DOM、不得自建 Worker、不得碰音频。音频一律在 `core/game.js`。
- **资源路径只能走 `resourceUrl()`**（`src/core/resource-url.js`），禁止站点根绝对路径。
- **烘焙输入放 `assets/guardian/src/`**，**绝不放 `assets/textures/`**（那里被 `build-atlas` 递归扫描，任何源图进去都会变成一个巨型 tile）。
- **本改动不新增方块** ⇒ 不需 `npm run atlas` / `npm run icons`。
- **时间基准统一 `performance.now()`**，禁止 `Date.now()`（`loadGuardianAsset` 的 cache-busting 参数除外，那不是到期判定）。
- **`src/tests/test-*.js` 必须同时出现在 `src/tests/index.html` 的 import 里** —— 漏注册是测试静默不跑（全绿假象），`check:data` 的 `[测试注册]` 环节双向钉住。
- **冻结数字不符时停下来报告**，不擅自改断言或放宽阈值（AGENTS.md）。
- 门禁：Tier 1/2 → `npm run check` + `npm test`；**不需** `bench --check`（召唤只在按 B 时算一次锚点，带 memo，不在逐帧路径上，与焰魔 v2.88 同口径）。

## Review Focus

spec 隐含但没有任何 Task 的测试天然覆盖的五类失效，按「最可能咬人」排序。每条都已在对应 Task 里补了测试：

1. **玩家落进守卫身体盒内 → 四轴冻结软锁**（焰魔 v2.78 的真缺陷同源：阻挡盒随 yaw 变形，AI 侧自愈覆盖不全）。合理期望：被有界推出，能走能跳。→ Task 9 Step 1 的 `_ejectFromBoss` 泛化用例 + **`EJECT_MAX` 余量断言**（守卫最深陷入实测 1.900，上限 2.0，余量仅 0.100）。
2. **守卫卡在地牢窄道/台阶永久僵住**（意图恒为零的卡死态）。合理期望：卡住 4 秒后脱困跳，连续失败后强化跳。→ Task 5 Step 1 的「意图恒零也累计卡住计时」用例。⚠️ **「真跳出去」的验收必须在开阔地形围栏**（上层房间净空 5 格，守卫只能升 1.2 格，spec §2.3.3）。
3. **玩家在堡垒占地外按 B 却召出守卫**（判定器边界/优先级错，或雪原盒重叠误判）。合理期望：提示「这里没有可召唤的 Boss」。→ Task 7 Step 1 的「外一格返回 null」+「雪原重叠顺序」用例（**seed 必须用 2096/2644/3740/4151/4973**；大竞技场那八个在堡垒上零重叠，照搬会直接红）。
4. **守卫死后重召攒出第二条 / column 卸载不回收**（id 非纯函数派生，或漏 `reindexColumn`）。合理期望：同图同槽恒同 id，死了能重召且只有一条。→ Task 6 Step 1 的 id 幂等 + 重召用例。
5. **烘焙产物过期静默渲染旧内容**（改了 Java 源码/贴图但没重跑 `npm run guardian`）。合理期望：`check:data` 红。→ Task 10 Step 1 的指纹环节 + **眼睛层逐像素全等 2749**（「紫色像素 > 0」无判别力：实测漏合成也有 2885）。

---

### Task 1: 素材入库（模型 + 贴图 + 音效）+ 指纹共享模块

**Files:**
- Create: `assets/guardian/src/ModelEnder_Guardian.java`（从 mod 复制）
- Create: `assets/guardian/src/ender_guardian.png`、`assets/guardian/src/ender_guardian_layer.png`
- Create: `assets/sounds/guardian_attack.ogg`、`guardian_hurt.ogg`、`guardian_die.ogg`
- Create: `tools/guardian-fingerprint.mjs`
- Modify: `package.json`（加 `"guardian": "node tools/bake-guardian.mjs"`）

**Interfaces:**
- Consumes: 无（本任务是起点）
- Produces（`tools/guardian-fingerprint.mjs` 的导出，Task 3 / Task 10 依赖）：
  - `GUARDIAN_SRC_DIR` / `GUARDIAN_MODEL_SRC` / `GUARDIAN_TEX_SRC` / `GUARDIAN_LAYER_TEX_SRC`：绝对路径常量
  - `GUARDIAN_JSON` / `GUARDIAN_PNG` / `GUARDIAN_META`：产物绝对路径常量
  - `GUARDIAN_BAKE_PARAMS`：`Object.freeze({ scale: 1, pxPerBlock: 16, textureSize: 256, animFps: 20, rotationConvention: 'java-zyx-additive', coordinateConvention: 'java-local-flipy' })`
  - `GUARDIAN_ANIM_SOURCES`：`Object.freeze({ strong_right: 'GUARDIAN_RIGHT_STRONG_ATTACK', strong_left: 'GUARDIAN_LEFT_STRONG_ATTACK', uppercut: 'GUARDIAN_UPPERCUT_AND_BULLET', stomp: 'GUARDIAN_STOMP' })`
  - `GUARDIAN_METRICS`：`Object.freeze({ boneCount: 20, cubeCount: 24, bakedCubes: 24, vertexCount: 576, indexCount: 864, layerOpaquePixels: 2749, animTicks: Object.freeze({ strong_right: 60, strong_left: 60, uppercut: 90, stomp: 48 }) })`
  - `guardianInputFingerprint()`：`→ { input: string, sourceSha256: string, paramsSha256: string }`（**与 `ignisInputFingerprint()` 同形状**，`input = sourceSha前16:paramsSha前16`）

- [ ] **Step 1: 复制模型与贴图入库**

```bash
mkdir -p assets/guardian/src
cp ~/jaylli/cataclysm1.19.2modding/src/main/java/com/github/L_Ender/cataclysm/client/model/entity/ModelEnder_Guardian.java assets/guardian/src/
cp ~/jaylli/cataclysm1.19.2modding/src/main/resources/assets/cataclysm/textures/entity/ender_guardian.png assets/guardian/src/
cp ~/jaylli/cataclysm1.19.2modding/src/main/resources/assets/cataclysm/textures/entity/ender_guardian_layer.png assets/guardian/src/
```

⚠️ 素材入库（与 `assets/ignis/src/` 同口径）⇒ 指纹不依赖仓库外文件，任何机器 `npm run check` 结果一致。

- [ ] **Step 2: 复制三个音效并改名为本仓 id**

```bash
S=~/jaylli/cataclysm1.19.2modding/src/main/resources/assets/cataclysm/sounds/entity
cp "$S/ender_guardian_fist_attack.ogg" assets/sounds/guardian_attack.ogg
cp "$S/golemhurt.ogg"                  assets/sounds/guardian_hurt.ogg
cp "$S/golemdeath.ogg"                 assets/sounds/guardian_die.ogg
```

⚠️ **受击/死亡音确实是 golem 那两个**（已查链路，不是按名字猜）：`ModSounds.java` 的
`ENDERGUARDIANHURT` / `ENDERGUARDIANDEATH` 在 `sounds.json` 里分别指向 `entity/golemhurt` 与
`entity/golemdeath`。拳击音则是专属的 `ender_guardian_fist_attack.ogg`。
⚠️ **本步只拷文件，不接线** —— `SOUND_IDS` / `SOUND_EXT_OVERRIDES` / `SOUND_VOLUMES` 在 Task 9 改。
在那之前这三个文件是「 unreferenced 」，`check:data` 的 `[音效]` 环节不会报错（它只查「列到的 id 有没有文件」，不反向查）。

- [ ] **Step 3: 写 `tools/guardian-fingerprint.mjs`**

照 `tools/ignis-fingerprint.mjs` 的结构（路径常量 + 参数 + 度量 + `createHash('sha256')` 逐文件指纹）。文件头注释必须写明：**node 侧模块（依赖 `node:fs`），`src/**` 与浏览器单测绝不能 import 它** —— 浏览器无法解析 `node:` 协议 → 整个模块不加载 → 游戏白屏，而 `check:arch` 抓不到这类运行时解析失败。

两个常量必须进 `GUARDIAN_BAKE_PARAMS`（否则是**指纹盲区**：它们不改任何输入文件，却改变每一个顶点/姿态）：
- `rotationConvention: 'java-zyx-additive'`（照焰魔 v2.58 先例）；
- `coordinateConvention: 'java-local-flipy'`（**本次新增**，spec §2.2.1 的口径 A）。

`GUARDIAN_METRICS.animTicks` 的值来自 spec §2.4 的实测（关键帧合计，**不是** `Animation.create(n)` 的声明值 —— 上勾拳声明 100 但关键帧只有 90）。`vertexCount = 24 × 24 = 576`、`indexCount = 24 × 36 = 864`（每盒 `BoxGeometry` 24 顶点/36 索引，零尺寸盒 0 个）。

- [ ] **Step 4: 加 npm script**

`package.json` 的 `scripts` 里，在 `"ignis"` 那行之后加：

```json
"guardian": "node tools/bake-guardian.mjs",
```

- [ ] **Step 5: 验证素材与度量对得上**

Run: `node -e "import('./tools/guardian-fingerprint.mjs').then(m=>console.log(m.GUARDIAN_METRICS, m.guardianInputFingerprint().input))"`

Expected: 打印 `{ boneCount: 20, cubeCount: 24, bakedCubes: 24, vertexCount: 576, indexCount: 864, layerOpaquePixels: 2749, animTicks: {...} }` + `xxxxxxxxxxxxxxxx:yyyyyyyyyyyyyyyy`。若报 `Cannot find module` ⇒ Step 1 的路径没复制对。

另跑一行确认三个音效到位：`ls -l assets/sounds/guardian_*.ogg`
Expected: 三个文件均非空。

- [ ] **Step 6: Commit**

```bash
git add assets/guardian/src/ModelEnder_Guardian.java assets/guardian/src/ender_guardian.png assets/guardian/src/ender_guardian_layer.png assets/sounds/guardian_attack.ogg assets/sounds/guardian_hurt.ogg assets/sounds/guardian_die.ogg tools/guardian-fingerprint.mjs package.json
git commit -m "feat(guardian): 末影守卫烘焙素材与音效入库 + 指纹共享模块"
```

---

### Task 2: Citadel Java 模型解析抽成共享模块

把 `tools/ignis-java-reference.mjs` 里已验证的解析语义抽出来，参数化「构造函数名 / 动画名」，并**新增 `move`（平移）通道支持**（守卫 4 条动画共 44 个 `move` 关键帧，而焰魔的 Java 参考器只解析 `rotate`）。

**Files:**
- Create: `tools/java-model-parse.mjs`
- Modify: `tools/ignis-java-reference.mjs`（改成 import 共享模块的薄消费者）
- Test: `src/tests/test-ignis-bake.js`（既有 `JAVA_REF` 冻结表 = 本任务的回归守卫，**不新增用例**）

**Interfaces:**
- Consumes: 无
- Produces（`tools/java-model-parse.mjs` 的导出，Task 3 依赖）：
  - `parseBones(text, ctorName)` → `Map<string, {pos:[n,n,n], rot:[n,n,n], parent:string|null, cubes:Array<{origin,size,inflate,mirror}>}>`；`ctorName` 如 `'ModelEnder_Guardian'`
  - `parseAnimation(text, animConstName, { branch } = {})` → `Array<{kind:'startKeyframe'|'setStaticKeyframe'|'resetKeyframe'|'endKeyframe'|'rotate'|'move', n?:number, name?:string, ang?:[n,n,n], off?:[n,n,n]}>`
    ⚠️ **`branch` 是必需的可选项**（见 Step 2 的第 2 条）：焰魔传 `'if (!entity.getIsShieldBreak()) {'`，守卫不传。
  - `evalKeyframes(stmts, tauTicks)` → `Map<string, {rot:[n,n,n], pos:[n,n,n]}>`（每骨的附加欧拉角**弧度** + 附加平移 **px**）
  - `javaWorld(bones, anim)` → `Map<string, number[16]>`（4×4 行主序，Java 模型空间 px，y 向下；`anim` 条目可以是 `{rot,pos}` 或旧的 `[rx,ry,rz]`）
  - `applyMat(m, p)` → `[x,y,z]`
  - `bindPoseBBoxBlocks(bones)` → `{ cubes:number, size:[w,h,d] }`（格；**仅翻转** `y → −y` 后的空间，即口径 A）
    ⚠️ **签名从 `(src路径)` 改成 `(bones Map)`** —— 共享模块不得读文件（`node:fs` 只留在消费侧）。

- [ ] **Step 1: 确认既有焰魔冻结表是绿的（回归基线）**

Run: `npx playwright test tests/harness.spec.mjs -g "harness"`

Expected: PASS。记下 `window.__MC_TEST_RESULTS__` 的 total（当前 1882）。**这是本任务的对照基线** —— 抽取后必须逐位不变。

- [ ] **Step 2: 写 `tools/java-model-parse.mjs`**

把 `ignis-java-reference.mjs` 的 `parseBones` / `evalSwing` / `javaWorld` / `mul` / `T` / `RX` / `RY` / `RZ` / `apply` / `bindPoseBBoxBlocks` 逐字搬过来，改四处（前三处都是**影子实测逐个碰出来的**，不是预防性条款）：

1. **`parseBones(text, ctorName)`**：把硬编码的 `text.indexOf('public ModelIgnis()')` 改成 `text.indexOf(\`public ${ctorName}()\`)`。找不到时 `throw new Error(\`[java-model-parse] 找不到构造函数 public ${ctorName}()\`)` —— **不得静默返回空 Map**（那会让烘焙产出 0 骨骼而指纹全对）。另：`addBox` 的第 8 个参数是 `mirror`（`true`/`false`），要一并解出（守卫实测 **7 个镜像件**）。

2. ⚠️⚠️ **`parseAnimation(text, animConstName, { branch } = {})` 必须带可选分支选择器**。原计划写「遇到 `if (` 就 throw」是错的：**焰魔的 `SWING_ATTACK` 段内就有 `if (!entity.getIsShieldBreak()) { … } else { … }`**，原 `parseSwing` 靠它取非破盾分支。影子实测：按「遇 if 就 throw」实现后，`node tools/ignis-java-reference.mjs` 立刻报 `动画 SWING_ATTACK 段内出现 if 分支` ⇒ 焰魔冻结表全红。正确语义：
   - 传了 `branch`：从 `body.indexOf(branch)` 裁到其后的 `'} else {'`（与原 `parseSwing` 逐字一致）；
   - 未传且段内有 `if`：throw（守卫的 4 条目标动画实测无条件分支，出现分支说明解析边界错了）；
   - 未传且无 `if`：整段取用。

3. ⚠️⚠️ **动画名匹配必须容许类名前缀**。焰魔是 `animator.setAnimation(SWING_ATTACK);`，守卫是 `animator.setAnimation(Ender_Guardian_Entity.GUARDIAN_RIGHT_STRONG_ATTACK);`。按字面 `animator.setAnimation(<name>)` 匹配对守卫**一条都找不到**（影子实测报「找不到动画」）。先试字面，不中则用 `new RegExp('animator\\.setAnimation\\([\\w.]*\\.' + animConstName + '\\);')`。段落终点仍是**下一个** `animator.setAnimation(`。

4. **`evalKeyframes`**：在 `rotate` 之外**新增 `move` 分支** —— `move(bone, x, y, z)` 的三个数是 px 平移，与 `rotate` 同样**逐轴累加**进当前关键帧，缓动同 `sin(frac·π/2)`；返回值的每骨条目从 `[rx,ry,rz]` 变成 `{rot:[...], pos:[...]}`。`javaWorld` 同步消费 `pos`（`T(b.pos + a.pos)`），并**兼容旧的裸数组 `anim` 条目**（防漏改调用处时静默拿到 undefined）。

⚠️ **旋转约定不得改**（spec §9）：`M = T(pos)·Rz·Ry·Rx`，关键帧欧拉角与 bind **逐轴相加**。这是焰魔 v2.58 用「蓄力向身后抡」的缺陷换来的实测结论。
⚠️ **`bindPoseBBoxBlocks` 改收 `bones` Map 而不是文件路径**（共享模块不读文件）；它内部的 `q = [p[0], -p[1], p[2]]` 就是口径 A（仅翻转），**不要改成 `24 - p[1]`**（那会把 `feetOffsetY` 从 −1.5 变成 0，spec §2.2.1）。

- [ ] **Step 3: 把 `ignis-java-reference.mjs` 改成薄消费者**

删掉搬走的函数体，改成 `import { parseBones, parseAnimation, evalKeyframes, javaWorld, applyMat, bindPoseBBoxBlocks as bboxOf } from './java-model-parse.mjs';`，`referenceTable` / `bindPoseBBoxBlocks` 的对外行为与输出格式**一字不变**（`PROBES` / `TIMES` 留在本文件 —— 那是焰魔专属的探针表）。四处调用补参数：

```js
const bones = parseBones(text, 'ModelIgnis');
const swing = parseAnimation(text, 'SWING_ATTACK', { branch: 'if (!entity.getIsShieldBreak()) {' });
// … evalKeyframes(swing, t * 20) … applyMat(world.get(bone), local) …
export function bindPoseBBoxBlocks(src = DEFAULT_SRC) {
  return bboxOf(parseBones(fs.readFileSync(src, 'utf8'), 'ModelIgnis'));
}
```

- [ ] **Step 4: 验证焰魔冻结表逐位不变（回归）**

先存一份改前基准（在 Step 2 之前跑，或用 `git show HEAD:tools/ignis-java-reference.mjs` 写到 `/tmp` 后跑）：

```bash
node tools/ignis-java-reference.mjs > /tmp/guardian-ref-before.txt   # 改前
# … 落 Step 2/3 的改动 …
node tools/ignis-java-reference.mjs > /tmp/guardian-ref-after.txt    # 改后
diff /tmp/guardian-ref-before.txt /tmp/guardian-ref-after.txt
npx playwright test tests/harness.spec.mjs -g "harness"
```

Expected: `diff` **无输出**（影子实测：67 行逐位不变）；harness PASS，单测 total 与 Step 1 **逐位相同**。若 `test-ignis-bake.js` 的 `JAVA_REF` 比对红 ⇒ 抽取时改了语义，回去修，**不要改冻结表**（AGENTS.md：冻结数字不符时停下来报告）。
⚠️ **不得用 `git stash`**（Global Constraints）。

- [ ] **Step 5: 验证守卫能被解析（本任务的正向判据）**

Run:
```bash
node -e "
import('./tools/java-model-parse.mjs').then(async m => {
  const fs = await import('node:fs');
  const t = fs.readFileSync('assets/guardian/src/ModelEnder_Guardian.java','utf8');
  const bones = m.parseBones(t, 'ModelEnder_Guardian');
  const bb = m.bindPoseBBoxBlocks(bones);
  console.log('bones', bones.size, 'bbox', bb.size.map(v=>v.toFixed(4)).join(' × '));
  for (const a of ['GUARDIAN_RIGHT_STRONG_ATTACK','GUARDIAN_LEFT_STRONG_ATTACK','GUARDIAN_UPPERCUT_AND_BULLET','GUARDIAN_STOMP']) {
    const s = m.parseAnimation(t, a);
    const moves = s.filter(x=>x.kind==='move').length;
    console.log(a, 'stmts', s.length, 'move', moves);
  }
});"
```

Expected: `bones 20`、`bbox 5.4176 × 4.2844 × 2.9017`（spec §2.2 实测值，**逐位对账**）、四条动画的 `move` 数合计 **44**（16/16/6/6）。任一不符 ⇒ 解析边界或 `move` 分支写错。

另钉关键帧 tick（Task 3 的帧数源于它）：对每条动画把 `startKeyframe/setStaticKeyframe/resetKeyframe` 的 `n` 相加，应得 **60 / 60 / 90 / 48**。

⚠️ 上述数字已在审阅时于影子副本实测通过（包含 `branch` 与类名前缀两处修正后），**不是估值**。

- [ ] **Step 6: Commit**

```bash
git add tools/java-model-parse.mjs tools/ignis-java-reference.mjs
git commit -m "refactor(tools): Citadel Java 模型解析抽成共享模块，支持 move 平移通道"
```

---

### Task 3: 烘焙脚本 + 产物（Tier 2）

**Files:**
- Create: `tools/bake-guardian.mjs`
- Create（产物，不手改）: `assets/guardian/guardian.json`、`assets/guardian/guardian.png`、`assets/guardian/guardian.meta.json`

**Interfaces:**
- Consumes: Task 1 的路径/参数/度量常量；Task 2 的 `parseBones` / `parseAnimation` / `evalKeyframes` / `javaWorld` / `applyMat`
- Produces（`assets/guardian/guardian.json` 的形状，Task 8 依赖 —— **与 `ignis.json` 同格式**）：
  - `scale: number`
  - `bones: Array<{name, parentIndex, localPosition:[3], bindQuaternion:[4], pivot:[3]}>`
  - `geometry: {position, normal, uv, skinIndex, index}`（扁平数组）
  - `animations: Record<'strong_right'|'strong_left'|'uppercut'|'stomp', {fps, frameCount, boneIndices:number[], frames:number[]}>`，`frames` 每骨每帧 **7 值 = 四元数(4) + 平移(3)**
  - `metrics: {boneCount, cubeCount, bakedCubes, vertexCount, indexCount, scale, feetOffsetY}`

- [ ] **Step 1: 写 `tools/bake-guardian.mjs`**

以 `tools/bake-ignis.mjs` 为骨架，**改输入侧**（Bedrock JSON → Task 2 的 Java 解析），**输出侧字段名对齐** `ignis.json` 的格式。关键点：

- ⚠️⚠️ **顶点坐标系：口径 A（仅翻转 + 局部顶点）—— 本任务最易错的一处**。Java 的 `addBox` origin 是**骨骼局部**坐标（Bedrock 是**绝对模型**坐标），两者差一个 `T(绝对pivot)`。实测例：`left_leg` 相对 pos `(11,−22,0)`、绝对 pivot `(11,2,0)`、cube origin `(−4,0,−8)`。故：顶点 = `BoxGeometry(size + 2·inflate)` 平移到 `origin + size/2`，**然后整体 `y → −y`**（x/z 不变）；**不加绝对 pivot**（那会让所有部件挤到模型原点附近）；法线也要 `y → −y`；三角形绕序因 y 翻转而反向，靠 `DoubleSide` 吸收（与焰魔同口径）。
- **骨骼变换**：`localPosition = [pos.x/16, −pos.y/16, pos.z/16]`（Java `setPos` 已是相对父骨骼，**不需** Bedrock 那道 `pivot − R·pivot` 修正）；`pivot` 写 `[0,0,0]`；`bindQuaternion` 由 `setRotationAngle` 的三个**弧度**经 `bedrockRotation` 得到。⚠️ `bake-ignis.mjs` 的 `bedrockRotation(rxDeg,…)` 收**度**，而 Java `setRotationAngle` 给的是**弧度** ⇒ 传参前先 `× 180/π`（或写一个收弧度的薄包装）。旋转序 `Rz(−θz)·Ry(+θy)·Rx(−θx)` 不变 —— 那是焰魔 v2.58 的唯一入口，**不得改成 `Euler(x,y,z,'XYZ')`**。
- **立方体 UV**：Java 的 `setTextureOffset(u,v).addBox(ox,oy,oz, dx,dy,dz, inflate, mirror)` 与 Bedrock 的 box UV 布局**同一套**（Minecraft 标准展开），故 `BEDROCK_FACE_ORDER` 与 `boxUVRects()` 可逐字复用；`inflate` 是「向外均匀外扩」（尺寸 = `size + 2*inflate`，中心不变；守卫实测有 **1 个负 inflate**（`upperhelmet` 的 −0.25）—— 公式同样成立，不要取绝对值），`mirror` 是 u 方向翻转（实测 7 个）。⚠️ **y 翻转不影响 UV**：UV 按源图像素左上原点写，v 换算 `1 − vPx/textureSize` 与焰魔逐字相同。
- **零尺寸立方体跳过**（守卫实测 24 盒全部非零，但保留这道守卫 —— `BoxGeometry` 对 0 尺寸产出退化三角形，法线 NaN）。
- **动画**：对每条动画，`frameCount = animTicks`（Task 1 的 `GUARDIAN_METRICS.animTicks`）、`fps = GUARDIAN_BAKE_PARAMS.animFps`（20，原版 1 tick = 1/20 s）。逐帧 `evalKeyframes(stmts, tau)` → 每骨总旋转 = `bedrockRotation(bind欧拉 + 关键帧欧拉)`，产物存**相对 bind 的增量** `delta = bind⁻¹ · 总旋转`；平移通道存 `关键帧 pos / 16`（px→格，**y 取反**，因为 Java y 向下而产物 y 向上）。
- **`move` 的 y 符号有实测锚点**：踩踏的 `move(left_leg, 0, −9, −9)` 是「抬腿 9px」（Java y 向下，减小 = 抬高）⇒ 产物 `pos.y = **+0.5625**` 格。实测验证：`left_leg` cube 的 `y_java` 从 bind 的 `[2, 24]` 变为 `[−7, 15]`（−9px）。转错的形态是「出招时身体往反方向窜」，而格数/骨骼数/指纹全对。
- ⚠️⚠️ **眼睛层合成：直接覆盖，不得照搬焰魔的「零重叠预检」**。实测：主图不透明 23,752、layer 不透明 2,749、**交集 2,749（100% 重叠）**、layer 落在主图透明区 **0**。因为它是原版 `RenderType.eyes` 的**叠加层**，本就画在身体上；而焰魔盾是「两块不相交的 UV 区」。故：① 写 `compositeLayerTexture(base, layer)`，`layer.alpha > 0` 的像素**直接取 layer 的 RGBA**，否则保留主图（逻辑与 `compositeShieldTexture` 相同）；② **不写 `assertNoBodyPollution`、也不做零重叠断言** —— 那会在正确实现上报错（原计划的「若不为零停下来报告」必然触发）；③ 合成后**实际变色 145 像素**（其余 2,604 与主图同色）—— 这就是眼睛的全部可见差异。
- **`feetOffsetY`**：扫 4 条动画**全部帧**的最低顶点，`feetOffsetY = −lowestY`。实测应为 **−1.5**（四条动画各自最低点也都是 −1.5，均在末帧）。⚠️ 扫描时的骨骼链必须用**口径 A**：`position = localPosition + delta.pos`，**不是** `pivot − R·pivot + delta.pos`。
- **`meta.json`**：度量 + `guardianInputFingerprint()` 的 `{input, sourceSha256, paramsSha256}`（与焰魔 meta 同形状）。
- 未知/解析失败一律 `throw`（防静默产出残缺产物）。

- [ ] **Step 2: 跑烘焙**

Run: `npm run guardian`

Expected: 打印骨骼 20 / 盒 24 / 顶点 576 / 索引 864 / 各动画帧数，退出码 0，`assets/guardian/` 下三个产物生成。

- [ ] **Step 3: 验证产物形状与 spec 实测值对账**

Run:
```bash
node -e "
const d=require('./assets/guardian/guardian.json');
console.log('bones',d.bones.length,'anims',Object.keys(d.animations));
for(const [k,v] of Object.entries(d.animations))
  console.log(' ',k,'fps',v.fps,'frames',v.frameCount,'bones',v.boneIndices.length,'vals/bone/frame',v.frames.length/(v.frameCount*v.boneIndices.length));
console.log('metrics',JSON.stringify(d.metrics));
console.log('pivot 全零?', d.bones.every(b=>b.pivot.every(v=>v===0)));
console.log('root localPosition', JSON.stringify(d.bones[0].localPosition));"
```

Expected: `bones 20`；4 条动画名恰为 `strong_right/strong_left/uppercut/stomp`；`fps 20`；`frameCount` 依次 **60/60/90/48**；`vals/bone/frame` 恒为 **7**（四元数4+平移3）；`metrics.boneCount 20`、`cubeCount 24`、`vertexCount 576`、`indexCount 864`、`feetOffsetY` ≈ **−1.5**；`pivot 全零? true`；`root localPosition` = **`[0,−1.5,0]`**（Java `root.setPos(0,24,0)` ⇒ y 取反除 16）。

⚠️ **最后那一条是口径 A 的哨兵**：若得到 `[0,0,0]` 或 `[0,1.5,0]`，说明把 Java 的 24px 地面基准当成了 Bedrock pivot、或忘了 y 取反 ⇒ 整体陷地/悬空 1.5 格，而骨骼数/盒数/顶点数全对。

- [ ] **Step 4: 验证眼睛层合成（内容级，带判别力）**

Run:
```bash
node -e "
const{PNG}=require('pngjs');const fs=require('fs');
const src=PNG.sync.read(fs.readFileSync('assets/guardian/src/ender_guardian.png'));
const lay=PNG.sync.read(fs.readFileSync('assets/guardian/src/ender_guardian_layer.png'));
const out=PNG.sync.read(fs.readFileSync('assets/guardian/guardian.png'));
let changed=0,match=0,layOpaque=0;
for(let i=0;i<out.data.length;i+=4){
  if(lay.data[i+3]===0)continue;
  layOpaque++;
  if(out.data[i]!==src.data[i]||out.data[i+1]!==src.data[i+1]||out.data[i+2]!==src.data[i+2])changed++;
  if(out.data[i]===lay.data[i]&&out.data[i+1]===lay.data[i+1]&&out.data[i+2]===lay.data[i+2]&&out.data[i+3]===lay.data[i+3])match++;
}
console.log('layer 不透明',layOpaque,'实际变色',changed,'与 layer 逐像素全等',match);"
```

Expected: `layer 不透明 2749`、`实际变色 **145**`、`与 layer 逐像素全等 **2749**`。

⚠️ **判据是「全等 2749」而不是「变色 > 0」**：漏合成时全等数仍有 **2604**（主图与 layer 本就大面积同色），故阈值必须取满值 2749。实测对照：漏合成 2604 / 正确 2749。
⚠️ **不得用「产物紫色像素 > 0」作判据**：主贴图自身就有 2,885 个紫像素，漏合成也恒真（实测 2885 vs 2880）。
⚠️ **也不要断言「layer 落在主图透明区的像素数 > 0」**：那个数实测是 **0**（eyes 是叠加层，100% 重叠）。

- [ ] **Step 5: Commit**

```bash
git add tools/bake-guardian.mjs assets/guardian/guardian.json assets/guardian/guardian.png assets/guardian/guardian.meta.json
git commit -m "feat(guardian): Java 模型烘焙脚本与产物（20 骨骼 / 24 盒 / 4 条攻击动画）"
```

---

### Task 4: 玩法数值冻结表（Tier 1，TDD）

**Files:**
- Create: `src/entities/guardian/guardian-config.js`
- Create: `src/tests/test-guardian-config.js`
- Modify: `src/tests/index.html`（加 import）

**Interfaces:**
- Consumes: 无（纯常量表，**不 import 任何模块**，与 `ignis-config.js` 同口径）
- Produces（Task 5/6/7/8/9 依赖）：
  - `GUARDIAN_TYPE = 'guardian'`
  - `guardianEntityIdFor(mapKey, slot)` → `string`
  - `GUARDIAN`：`{health:2000, halfWidth:1.25, height:3.8, attackDamage:16, flashMs:200, maxAlive:1}`
  - `GUARDIAN_ATTACKS`：`{strong_right, strong_left, uppercut, stomp}`，每项 `{hitRange, hitConeDeg, hitFrameSeconds, animSeconds, weight, cooldownSeconds}`
    **四档具体值**（spec §4 / §5）：
    | 档 | hitRange | hitConeDeg | hitFrameSeconds | animSeconds | weight | cooldownSeconds |
    |---|---|---|---|---|---|---|
    | `strong_right` | 5.15 | 35 | 29/20 = 1.45 | 3.0 | 0.30 | 0 |
    | `strong_left` | 5.15 | 35 | 34/20 = 1.70 | 3.0 | 0.30 | 0 |
    | `uppercut` | 6.25 | 30 | 27/20 = 1.35 | 4.5 | 0.25 | 9.0 |
    | `stomp` | 4.5 | **180** | 32/20 = 1.60 | 2.4 | 0.15 | 12.0 |
    ⚠️ `cooldownSeconds = 0` 表示「无额外独立冷却，只受全局 `attackCooldownMin/Max` 约束」（两档普攻）。
    ⚠️ 非零项必须 **> 本招 `animSeconds`** 且 **≥ `attackCooldownMin`**（照焰魔 `spinCooldownSeconds` 的三条约束）。
  - `GUARDIAN_ATTACK_IDS`：`readonly string[]`（= `Object.keys(GUARDIAN_ATTACKS)`，顺序即抽签顺序）
  - `GUARDIAN_AI`：`{sightRange, chaseSpeed, hitRange, hitConeDeg, hitFrameSeconds, attackAnimSeconds, attackRange, standoffRange, standoffDeadband, disengageRange, turnRate, attackCooldownMin, attackCooldownMax, losInterval, gravity, maxStep, navPeriod, turnDelay, stuckLeapSeconds, stuckNetDist, stuckResolveMaxRaise, leapJumpForce, leapSpeed, leapMaxSeconds, escapeLeapEscalateAfter, escapeLeapApexMin, escapeLeapApexMax, escapeLeapApexMargin, escapeLevelTolerance, overlapEscapeDist, senseIntervalMin, senseIntervalMax}`
  - `GUARDIAN_STEERING`：`{probeDistance:1.2, anglesDeg:[22.5,45,67.5,90]}`（**必须与 `ZOMBIE_STEERING` 同值**）
  - `GUARDIAN_STEP_LIFT`：`{epsilon: 1e-4}`（与 `IGNIS_STEP_LIFT` / `ZOMBIE_STEP_LIFT` 同值同依据；衰减参数仍在 `player/step-lift.js`，不写第二份）
  - `GUARDIAN_POSE_BLEND`：`{seconds: 0.2}`（四招入场均用默认值，**不引入焰魔旋斩那个 0.6s 特例**）
  - `GUARDIAN_CORE_OBB`：`Object.freeze({ halfExtents: Object.freeze([1.2500, 1.2188, 1.0313]), center: Object.freeze([0.0000, 2.5938, -0.4063]) })`
    （**已用 Java 解析实测**，spec §8；Task 6 的「产物独立复算」用例从烘焙产物重算对账，Task 8 Step 6 跑）
  - `guardianBlendSeconds(sourceKey)` → `number`（读 `GUARDIAN_POSE_BLEND.seconds`；渲染器与测试共用的单一权威）

- [ ] **Step 1: 写失败测试 `src/tests/test-guardian-config.js`**

照 `src/tests/test-ignis-system.js` 的不变式用例风格（`test(name, fn)` + `assertEqual`/`assertTrue`）。必须包含：

```js
// 数值来自 spec §5 冻结表（原版实测），逐条钉住
assertEqual(GUARDIAN.health, 2000, '血量 = 用户裁定 2000');
assertEqual(GUARDIAN.attackDamage, 16, '伤害 = 原版 ATTACK_DAMAGE');
assertEqual(GUARDIAN.halfWidth, 1.25, '半宽 = 原版 sized(2.5)/2');
assertEqual(GUARDIAN.height, 3.8, '高 = 原版 sized(3.8)');
assertEqual(GUARDIAN.maxAlive, 1, '废弃堡垒只有一个');

// 三招锥角逐招钉住（spec §4.3 的⚠️：不得照搬焰魔「半角<180」的守卫）
assertEqual(GUARDIAN_ATTACKS.strong_right.hitConeDeg, 35, '右重击半角 35 = 原版 arc 70 的一半');
assertEqual(GUARDIAN_ATTACKS.strong_left.hitConeDeg, 35, '左重击半角 35');
assertEqual(GUARDIAN_ATTACKS.uppercut.hitConeDeg, 30, '上勾拳半角 30 = 原版 arc 60 的一半');
assertEqual(GUARDIAN_ATTACKS.stomp.hitConeDeg, 180, '踩踏刻意全向 180（原版是尖牙，改环形近战）');
assertEqual(GUARDIAN_ATTACKS.strong_right.hitRange, 5.15, '右重击射程 = 原版 AreaAttack range');
assertEqual(GUARDIAN_ATTACKS.uppercut.hitRange, 6.25, '上勾拳射程');
assertEqual(GUARDIAN_ATTACKS.stomp.hitRange, 4.5, '踩踏射程 = 原版尖牙最外圈半径');
assertEqual(GUARDIAN_ATTACKS.strong_right.hitFrameSeconds, 29 / 20, '右重击命中帧 tick29');
assertEqual(GUARDIAN_ATTACKS.strong_left.hitFrameSeconds, 34 / 20, '左重击命中帧 tick34');
assertEqual(GUARDIAN_ATTACKS.uppercut.hitFrameSeconds, 27 / 20, '上勾拳命中帧 tick27');
assertEqual(GUARDIAN_ATTACKS.stomp.hitFrameSeconds, 32 / 20, '踩踏命中帧 tick32');
assertEqual(GUARDIAN_ATTACKS.uppercut.animSeconds, 4.5, '上勾拳 90 tick（不是声明的 100）');
assertEqual(GUARDIAN_ATTACKS.stomp.animSeconds, 2.4, '踩踏 48 tick');

// 权重之和 = 1（抽签口径），且逐档钉住具体值
const wSum = GUARDIAN_ATTACK_IDS.reduce((s, id) => s + GUARDIAN_ATTACKS[id].weight, 0);
assertTrue(Math.abs(wSum - 1) < 1e-9, `四档权重之和 = 1，实际 ${wSum}`);
assertEqual(GUARDIAN_ATTACKS.strong_right.weight, 0.30, '右重击权重');
assertEqual(GUARDIAN_ATTACKS.strong_left.weight, 0.30, '左重击权重');
assertEqual(GUARDIAN_ATTACKS.uppercut.weight, 0.25, '上勾拳权重');
assertEqual(GUARDIAN_ATTACKS.stomp.weight, 0.15, '踩踏权重（全向惩罚招，取最低）');

// 每招独立冷却（spec §5）：非零项必须 > 本招动画时长 且 ≥ 全局冷却下限
for (const id of GUARDIAN_ATTACK_IDS) {
  const a = GUARDIAN_ATTACKS[id];
  if (a.cooldownSeconds === 0) continue;   // 0 = 无额外冷却（两档普攻）
  assertTrue(a.cooldownSeconds > a.animSeconds,
    `${id} 的独立冷却必须 > 本招动画时长，否则被动画吃掉（数值上不起作用）`);
  assertTrue(a.cooldownSeconds >= GUARDIAN_AI.attackCooldownMin,
    `${id} 的独立冷却必须 ≥ attackCooldownMin，否则比普攻还频繁`);
}
assertEqual(GUARDIAN_ATTACKS.uppercut.cooldownSeconds, 9.0, '上勾拳独立冷却');
assertEqual(GUARDIAN_ATTACKS.stomp.cooldownSeconds, 12.0, '踩踏独立冷却');

// 派生最大值 = 各招最大者
assertEqual(GUARDIAN_AI.attackAnimSeconds, 4.5, 'attackAnimSeconds = 最长的上勾拳');
assertEqual(GUARDIAN_AI.hitRange, 6.25, 'hitRange = 最远的上勾拳');
assertEqual(GUARDIAN_AI.hitConeDeg, 180, 'hitConeDeg = 最宽的踩踏');

// 载荷性不变式（焰魔踩过的坑，逐条搬）
assertTrue(GUARDIAN_AI.attackCooldownMin > GUARDIAN_AI.attackAnimSeconds,
  '冷却下限必须 > 最长动画，否则冷却被动画吃掉（无间隔连招）');
assertTrue(GUARDIAN_AI.attackRange >= GUARDIAN_AI.standoffRange,
  'attackRange ≥ standoffRange，否则追到环上既不走也不起手（僵住）');
assertTrue(GUARDIAN_AI.standoffRange <= GUARDIAN_AI.hitRange,
  '站定环必须落在能够到的范围内');
// ⚠️️ 上面那条读的是派生**最大值**（6.25），抓不到「停在 5.0 格出踩踏(4.5) 打不中」。
// 必须额外钉**最小** hitRange（spec §5 实测发现的真缺陷）：
const minHit = Math.min(...GUARDIAN_ATTACK_IDS.map((id) => GUARDIAN_ATTACKS[id].hitRange));
assertEqual(minHit, 4.5, '最短的一招是踩踏 4.5');
assertTrue(GUARDIAN_AI.attackRange < minHit,
  `attackRange 必须 < 最小 hitRange（滞回），否则站定环上出踩踏永远打不中；实际 ${GUARDIAN_AI.attackRange} vs ${minHit}`);
assertTrue(GUARDIAN_AI.standoffRange + GUARDIAN_AI.chaseSpeed / 60 <= GUARDIAN_AI.attackRange,
  '追到环上的落点（最多多一步）必须仍在起手距离内，否则僵住');
assertTrue(GUARDIAN_AI.standoffRange - GUARDIAN_AI.standoffDeadband > GUARDIAN.halfWidth + 0.3,
  '死区下界必须 > 身体盒半宽 + 玩家半宽，否则玩家永远碰不到它这条不成立');
assertTrue(GUARDIAN_AI.standoffDeadband > GUARDIAN_AI.chaseSpeed / 60,
  '死区 > 单帧位移，否则环边界振荡');
assertTrue(GUARDIAN_AI.disengageRange > GUARDIAN_AI.sightRange, '脱离距离 > 发现距离（滞回）');
assertTrue(GUARDIAN_AI.escapeLeapApexMin > GUARDIAN_AI.leapJumpForce ** 2 / (2 * 24),
  '强化跳顶点必须严格 > 普通跳顶点，否则「跳更高」静默失效');
assertTrue(2 * Math.sqrt(2 * GUARDIAN_AI.escapeLeapApexMax / 24) < GUARDIAN_AI.leapMaxSeconds,
  '强化跳滞空必须显著 < 安全阀，否则那一跳白跳');
assertTrue(GUARDIAN_AI.overlapEscapeDist >= 1.6131 + 0.3,
  '重叠阈 ≥ 旋转后身体盒最大水平半宽(45°) + 玩家半宽');

// maxStep 必须是 1.0（spec §5 实测：zombieStepUpY 恒抬 1 格，1.75 与 1.0 逐位等价）
assertEqual(GUARDIAN_AI.maxStep, 1.0,
  'maxStep 取 1.0：现有 zombieStepUpY 只能抬 1 格，写 1.75 是看着生效实际无效的死值');

// 姿态衔接：淡入必须在**最短**命中帧之前走完（否则命中那一刻画面里是未混完的站姿）
const minHitFrame = Math.min(...GUARDIAN_ATTACK_IDS.map((id) => GUARDIAN_ATTACKS[id].hitFrameSeconds));
assertEqual(minHitFrame, 1.35, '最短命中帧 = 上勾拳 27 tick');
for (const key of ['idle', ...GUARDIAN_ATTACK_IDS]) {
  assertTrue(guardianBlendSeconds(key) < minHitFrame,
    `${key} 的淡入时长必须 < 最短命中帧 ${minHitFrame}s`);
}
assertEqual(GUARDIAN_STEP_LIFT.epsilon, 1e-4, '台阶缓动噪声门（与丧尸/焰魔同值）');

// id 幂等（Review Focus #4）
assertEqual(guardianEntityIdFor('ruinedcitadel:0', 0), guardianEntityIdFor('ruinedcitadel:0', 0),
  '同图同槽恒同 id（走远卸载→回来重召不攒第二条）');
assertTrue(guardianEntityIdFor('ruinedcitadel:0', 0) !== guardianEntityIdFor('ruinedcitadel:1', 0),
  '不同图 id 不同');

// 偏角档位必须与丧尸同值（两套会让两个地面实体绕同一堵墙走出不同路径）
assertEqual(JSON.stringify(GUARDIAN_STEERING.anglesDeg), JSON.stringify([22.5, 45, 67.5, 90]), '偏角档位');
```

⚠️ `overlapEscapeDist` 的下界用**旋转后的核心盒最大水平半宽**（1.6131，spec §8 实测）而不是
`GUARDIAN.halfWidth`（1.25，碰撞盒）—— 阻挡盒是核心 OBB 绕 yaw 旋转后的轴对齐包围盒，
45° 时比碰撞盒宽 29%。用 1.25 算会低估阈值，重现焰魔 v2.78 的软锁。
故断言写：`overlapEscapeDist >= 1.6131 + 0.3`。

- [ ] **Step 2: 注册进 `src/tests/index.html`**

在 `import './test-ignis-system.js';` 那行之后加 `import './test-guardian-config.js';`。

⚠️ 漏注册 = 测试静默不跑（全绿假象）。`check:data` 的 `[测试注册]` 环节会抓，但先自己加对。

- [ ] **Step 3: 跑测试确认 RED**

Run: `npx playwright test tests/harness.spec.mjs -g "harness"`

Expected: FAIL，报 `test-guardian-config.js` 加载失败（`guardian-config.js` 不存在）。

- [ ] **Step 4: 写 `src/entities/guardian/guardian-config.js`**

以 `src/entities/ignis/ignis-config.js` 为模板（**连注释结构一起搬**：文件头写「数值来源表」，每个常量写出处与标定理由）。数值全部取 Step 1 的断言值。行为常量（站定环/脱困/感知间隔）照搬 `IGNIS_AI` 的同名值，只改与体形相关的：

- `chaseSpeed: 5.4`（原版 `MOVEMENT_SPEED 0.27×20`）。⚠️ 文件里必须写明 spec §5 的风险提示：这是玩家跑速的 67%，焰魔曾因过快被两次降速；实玩后若快，改这一个常量。
- `maxStep: 1.0`（**不取原版 1.75**）。⚠️ 已实测定案，不是待验证项：`zombieStepUpY(y) = Math.floor(y + 0.01) + 1` 恒抬 **1 格**，`maxStep` 只做「抬升量 ≤ maxStep」的门控 ⇒ **1.75 与 1.0 逐位等价**（实测：2 格高台阶下 `_tryStepUp` 与 `isWalkable` 两侧均 false）。写 1.75 只会得到一个看着生效实际无效的死值。注释里要写明「真要支持 >1 格台阶得改 `zombieStepUpY` 本身，那是影响丧尸/焰魔/玩家三方的独立改动」。
- `standoffRange: 3.5` / `standoffDeadband: 0.75` / `attackRange: 4.25`。
  ⚠️️ **这三个值不得照抄焰魔（5.0 / 0.75 / 5.5）**：守卫最短的一招是踩踏（`hitRange 4.5`），
  照抄会让守卫停在 5.0 格处出踩踏而**永远打不中**，且「`standoffRange ≤ hitRange`」那条断言
  仍全绿（它读的是派生**最大值** 6.25）。推导见 spec §5，不变式按**最小** `hitRange` 写。
- `overlapEscapeDist: 1.95`（旋转后身体盒最大水平半宽 1.6131 + 玩家半宽 0.3，spec §8）。
- `attackCooldownMin: 5.0` / `attackCooldownMax: 7.5`（下限必须 > 最长动画 4.5s）。
- `GUARDIAN_ATTACKS` 四档的 `weight` 与 `cooldownSeconds` 按 Interfaces 表填（普攻各 0.30/冷却 0，上勾拳 0.25/9.0，踩踏 0.15/12.0）。
- `GUARDIAN_STEP_LIFT.epsilon: 1e-4` / `GUARDIAN_POSE_BLEND.seconds: 0.2` / `guardianBlendSeconds()`（读前者，四招均返回 0.2）。

文件头必须写明本文件**不 import 任何模块**（纯常量表），且 `GUARDIAN_CORE_OBB` 是烘焙产物 bind pose 的实测值（语义 ≠ `GUARDIAN_METRICS` 的顶点计数，故不互相 import）。

- [ ] **Step 5: 跑测试确认 GREEN**

Run: `npx playwright test tests/harness.spec.mjs -g "harness"`

Expected: PASS，单测 total = 1882 + 本任务新增用例数。

- [ ] **Step 6: 跑三门**

Run: `npm run check`

Expected: exit 0，0 error，既存 warning 无新增（当前 58~60 条）。`check:arch` 会验 `src/entities/guardian/` 属同构层（无 three / 无 DOM）。

⚠️ 若 `check:arch` 报本文件「自声明同构模块」误报 ⇒ 文件头注释里出现了 `ISOMORPHIC_DECLARED` 正则命中的字样（AGENTS.md 已记这个坑）。改措辞为「属 Worker 同构层（红线 8）」，不要照抄正则命中的原字样。

- [ ] **Step 7: Commit**

```bash
git add src/entities/guardian/guardian-config.js src/tests/test-guardian-config.js src/tests/index.html
git commit -m "feat(guardian): 末影守卫玩法数值冻结表 + 不变式单测"
```

---

### Task 5: AI 状态机 + 三招 + 脱困跳（Tier 1，TDD）

⚠️ **本任务必须先于 Task 6**：`guardian-system.js` **import** `GuardianBossAgent`（实测
`ignis-system.js:21` 就是 `import { IgnisBossAgent } from '../bosses/ignis-boss-agent.js'`），
而 Agent **不** import system（无循环依赖）。反序会让 Task 6 的 RED 阶段因为模块缺失而
分不清是「测试写对了」还是「依赖没就位」。

**Files:**
- Create: `src/entities/bosses/guardian-boss-agent.js`
- Create: `src/tests/test-guardian-boss-agent.js`
- Modify: `src/tests/index.html`

**Interfaces:**
- Consumes: `bosses/boss-agent.js` 的 `BossAgent` 基类（`_hasLos` / `_angleTo` / `_angleDiff` / `_hDist`）；Task 4 的全部常量；`zombies/zombie-navigation.js` 的 `aabbCollidesAt` / `steerIntentAabb`（**与焰魔同一份实现**，红线 1）
  ⚠️ **不消费 `guardianAabbFor`**（实测 `ignis-boss-agent.js` 也不消费它）—— 那是命中盒，
  由 Task 6 的 system 与 Task 9 的结算侧用；Agent 只用碰撞盒做避让。
- Produces（Task 6 的 `guardianDefinition.update` 依赖）：
  - `class GuardianBossAgent extends BossAgent`，`update(state, dt, ctx)` → 全新 state 各字段（plain 对象）
  - `ctx` 形状：`{world, registry, player:{position:[3], velocity?:[3]}|null, nowMs}`
    ⚠️ **`player` 是对象而不是裸数组**（实测 `ignis-boss-agent.js:103` 读 `ctx.player.position`，
    `game.js` 传的也是 `{position, velocity}`）—— 原计划写裸数组会让 Agent 每帧读到 undefined。

- [ ] **Step 1: 写失败测试 `src/tests/test-guardian-boss-agent.js`**

照 `src/tests/test-ignis-boss-agent.js`。必须包含（Review Focus #2 在这里）：

```js
// 三态机迁移
//   idle → chase：玩家进 sightRange 且 turnDelay 到（未到不得转 —— 焰魔 v2.62 用户裁定）
//   chase → attack：水平距 ≤ attackRange
//   attack → chase：attackAnimT ≥ 本招 animSeconds（按 attackKind 取，不得用派生最大值）
//   → idle：距 > disengageRange 或视线断

// 攻击抽签：四档权重（rng 注入固定序列，断言抽到的 kind 分布）
//   每招独立冷却：起手当帧就置位（不是命中帧 —— 玩家跑掉不命中时按命中帧计会反复抽中）
//   ⚠️ 冷却未好时**降级而不是白放**：只在「cooldownSeconds 已走完」的档里按权重归一化抽
//   （两档普攻 cooldownSeconds=0 ⇒ 永远在候选集里，不会全部档被排除而空抽）
//   断言：把 uppercut/stomp 的冷却置为正值后，连续 200 次起手只出现 strong_right/strong_left

// 命中帧写 attackRequest（瞬态）：只在 hitFrameSeconds 那一帧出现，下一帧自动 null
//   ⚠️ 断言 req.kind 是本招（结算侧按 kind 取射程/锥角，写错 kind 会用错判据）

// 站定环：追到「玩家外侧 standoffRange(3.5) 格」即停
//   断言最近间距**同时钉上下界**（下界 = 身体盒半宽 1.25 + 玩家半宽 0.3，只钉「变远」
//   抓不到穿模；上界防「根本没靠近」假绿）—— AGENTS.md 已记这个坑
//   死区内不移动（不做比例微调 —— 只朝环上最近点走会让环内实体侧向画圈）
//   ⚠️ 额外钉一条：站在 standoffRange 上出**踩踏**（最短的招，hitRange 4.5）仍能命中
//      —— 这是 spec §5 那个真缺陷的回归守卫（照抄焰魔 5.0 就红）

// 脱困（Review Focus #2）：棘轮式锚点判据，**意图恒为零也必须累计卡住计时**
//   造「死区内 + 看不见玩家 + A* 无解」的三重零意图态，推进 stuckLeapSeconds 秒
//   断言 mode 迁入 'leap' 且 leapKind === 'escape'
//   ⚠️ 这条是焰魔 v2.63 的真缺陷（旧判据要求「有意图但没走成」⇒ 意图恒零时永不累计 ⇒ 永久僵住）
//   ⚠️ **本用例只钉「进入 leap 态」，不钉「真跳出去」** —— 后者在开阔地形围栏里验（Task 11）；
//      上层房间净空 5 格、守卫高 3.8 ⇒ 脚底只能升 1.2 格，任何跳都撞天花板（spec §2.3.3）。
//      在低净空 fixture 里断言「y 升高 ≥ 2.52」会恒红，那是 fixture 错而不是实现错。

// 强化跳：连续 escapeLeapEscalateAfter 次普通跳失败后，顶点 = clamp(max(Δy+margin, apexMin), apexMin, apexMax)
//   escapeFailCount 的清零要**叠加竖直判据**（玩家还在上方 escapeLevelTolerance 以上时，
//   走得再远也不算脱困成功 —— 深坑底部往往很宽，水平乱走 1.5 格就能满足棘轮）

// 感知间隔：chase 的移动与转向读 sensedPlayer 快照，**攻击读真实位置**
//   断言首次感知立即执行（sensedPlayer === null 时不等间隔，否则召唤后头 1~2 秒完全不动）
//   断言玩家离开 sightRange 时清空快照

// 不做跳跃劈砍：leapKind 恒 'escape'，永不出现 'attack'（spec §12：原版守卫没这一招）
```

- [ ] **Step 2: 注册进 `src/tests/index.html`**（`test-guardian-config.js` 之后）

- [ ] **Step 3: 跑测试确认 RED**

Run: `npx playwright test tests/harness.spec.mjs -g "harness"`
Expected: FAIL（`guardian-boss-agent.js` 不存在）

- [ ] **Step 4: 写 `src/entities/bosses/guardian-boss-agent.js`**

以 `src/entities/bosses/ignis-boss-agent.js`（1010 行）为模板。骸架逐段对应，**改四处**：

1. **抽签表**：四档（`GUARDIAN_ATTACK_IDS`），每档独立冷却读 `GUARDIAN_ATTACKS[kind].cooldownSeconds`（普攻为 0 = 无额外冷却）。state 新增 `attackCooldowns`（按 kind 的剩余秒数映射）—— ⚠️ **必须在 `createState` 里保留并逐帧递减**，丢掉它 ⇒ 每帧重置 ⇒ 独立冷却永不生效（同 `_physAccum` / `senseTimer` 的教训，Task 6 同步）。
2. **命中帧/动画时长按 `state.attackKind` 取**（`GUARDIAN_ATTACKS[kind]`）。⚠️ **不得读 `GUARDIAN_AI.hitRange/hitConeDeg`** —— 那是派生最大值（6.25 / 180°），用它判定重击会把锥从 35° 扩到 180°（玩家绕到背后也被打中），而数据层完全正常。这是焰魔 v2.75 的原话坑。
3. **不做跳跃劈砍**（`leapAttack*`）：守卫的 `leap` 态只服务脱困（`leapKind` 恒 `'escape'`）。spec §12 未列跳劈，且原版守卫没有这一招 ⇒ 删掉那段，别留死字段（`leapAttackMin/Max`、`leapAttackAirtime`、`leapAttackCooldown`、`leapSlashLead`、`leapTargetY` 均不引入）。
4. **体形参数**：站定环 3.5 / 重叠阈 1.95（Task 4 已定值，**不是焰魔的 5.0 / 1.15**）。

⚠️ **两条载荷性契约**（`boss-agent.js` 文件头）：① 只读 state 与 ctx，返回**全新** state 各字段，不得原地改写；② 不生成实体、不改世界 —— 命中意图写进返回值的 `attackRequest`，由 `game.js` 消费。

- [ ] **Step 5: 跑测试确认 GREEN + 三门**

Run: `npx playwright test tests/harness.spec.mjs -g "harness" && npm run check`
Expected: 全绿

- [ ] **Step 6: Commit**

```bash
git add src/entities/bosses/guardian-boss-agent.js src/tests/test-guardian-boss-agent.js src/tests/index.html
git commit -m "feat(guardian): 末影守卫 AI 三态机（三招抽签 / 站定环 / 脱困跳）"
```

---

### Task 6: definition + service（Tier 1，TDD）

**Files:**
- Create: `src/entities/guardian/guardian-system.js`
- Create: `src/tests/test-guardian-system.js`
- Modify: `src/tests/index.html`

**Interfaces:**
- Consumes: Task 4 的全部常量；`entity-types.js` 的 `raycastAabbSlab` / `normalizePosition`；**Task 5 的 `GuardianBossAgent`**；`zombies/zombie-pathfinder.js` 的 `PathCache`、`zombies/zombie-navigator.js` 的 `decideStep` / `memoryFor`、`zombies/zombie-navigation.js` 的 `aabbCollidesAt` / `zombieStepUpY` / `displaceGroundEntity`（**与焰魔同一份实现**，红线 1）
- Produces（Task 7/9 依赖）：
  - `guardianAabbFor(state)` → `{min:[3], max:[3]}`（**相对 `state.position` 的局部盒**，调用方加 position 得世界盒）
  - `guardianDefinition`：`{create(state), update(entity,dt,context), raycastAabb(state,origin,dir,maxDist), serialize(state), deserialize(raw)}`
  - `class GuardianService`：
    - `constructor({entities, world, seed, onKnockback})`
    - `summon(mapKey, cx, cz, slot, refY)` → `{ok:true, id} | {ok:false, reason:'limit'|'exists'}`
    - `damage(id, amount, nowMs)` → `{dead:boolean, health:number}|null`
    - `knockback(id, dx, dz)` → `boolean`
    - `overlapsAabb(box)` → `boolean`（**玩家物理每帧调几十次，必须走 id Set 短路 + 零分配**）
    - `activeEntities()` → `Array`（快照，不是迭代器）
    - `update(dt, {playerPosition, nowMs})`、`navDebugState()`、`cachedPathOf(id)`、`dispose()`

- [ ] **Step 1: 写失败测试 `src/tests/test-guardian-system.js`**

照 `src/tests/test-ignis-system.js` 的结构。必须包含（Review Focus #4 的两条在这里）：

```js
// guardianAabbFor 返回**局部盒**（不是世界盒）—— 焰魔踩过：返回世界盒会让 position 被加两次，
// 形态是「水平射线永远打不中，而盒尺寸类断言全绿」
const st = { position: [100, 10, 200], yaw: 0 };
const box = guardianAabbFor(st);
assertTrue(Math.abs(box.min[0]) < 5 && Math.abs(box.max[0]) < 5,
  `必须是相对 position 的局部盒，实际 min[0]=${box.min[0]}`);

// 命中盒相对**脚底**（不是身体中心）—— 焰魔 v2.59 的缺陷：盒以脚底为中心 ⇒ 胸口以上全打空
//   ⚠️ 守卫的核心盒 center.y = 2.5938、halfExtents[1] = 1.2188 ⇒ min[1] ≈ 1.375（**不是 0**）：
//      它的躯干（含头盔）从脚底往上 1.375 格才开始。故断言写「min[1] > 1.0 且 max[1] ≈ 3.81」，
//      而不是照抄焰魔的「min[1] ≈ 0」（焰魔核心盒从脚底就开始）。
assertTrue(box.min[1] > 1.0, `守卫核心盒下沿应 ≈ 1.375（躯干从脚底往上），实际 ${box.min[1]}`);
assertTrue(box.max[1] > 3.5, `盒必须覆盖到头顶（≈ 3.81），实际 max[1]=${box.max[1]}`);

// 产物独立复算（素材/烘焙器变了会红 —— 这是 GUARDIAN_CORE_OBB 的唯一独立守卫）
//   从 assets/guardian/guardian.json 的 bind pose 重算核心四骨骼
//   （lowerbody / upperbody / helmet / head，共 6 个盒）包围盒，与常量逐值对账：
//   halfExtents [1.2500, 1.2188, 1.0313]、center [0, 2.5938, −0.4063]（spec §8 实测）
//   ⚠️ **复算必须用口径 A**（spec §2.2.1）：骨骼链 `position = localPosition`（pivot 恒零），
//      顶点已是骨骼局部坐标；脚底基准用 `metrics.feetOffsetY = −1.5`。
//      照搬焰魔那套 `pivot − R·pivot` 会让两侧差 1.5 格而对账恒红。

// yaw 旋转现算：yaw=0 与 yaw=π/4 的 AABB 必须不同（固定盒会在它横过来时漏判/误判）
//   ⚠️ 并钉住 45° 时的最大水平半宽 = 1.6131（overlapEscapeDist 1.95 的依据）
assertTrue(JSON.stringify(guardianAabbFor({...st, yaw: 0})) !==
           JSON.stringify(guardianAabbFor({...st, yaw: Math.PI / 4})), 'AABB 必须按 yaw 现算');

// summon 幂等 + 上限（Review Focus #4）
const svc = new GuardianService({ entities: mkEntities(), world: fakeWorld, seed: 12345 });
const r1 = svc.summon('ruinedcitadel:0', 10, 20, 0, -6);
assertTrue(r1.ok, '首次召唤成功');
assertEqual(svc.summon('ruinedcitadel:0', 10, 20, 0, -6).reason, 'exists', '同槽重召 → exists');
// 死后重召：damage 到 0 → despawn → 同 id 可再召，且场上只有一条
svc.damage(r1.id, 99999, 1000);
const r2 = svc.summon('ruinedcitadel:0', 10, 20, 0, -6);
assertTrue(r2.ok && r2.id === r1.id, `死后重召复用同 id，实际 ${r2.id} vs ${r1.id}`);
assertEqual(svc.activeEntities().length, 1, '不得攒出第二条');

// summon 用 refY（summonY）而不是自己扫地面：守卫恒召到**上层房间**那一层
//   fakeWorld 造三层可站地面（间隔 8 格，模拟 ny23/31/39），断言落在 refY 那层
//   ⚠️ **fixture 的净空必须照真实房间造：只有 5 格**（上层房间 ny39..43）。
//      造无限净空的 fakeWorld 会让 HEADROOM=5 的缺陷测不出来（spec §2.3.3 实测：
//      HEADROOM=5 时 ny39 被判死，落点静默变成 ny31，差 8 格）。
//   断言：净空 5 格的层上，HEADROOM 必须能选中它（即 HEADROOM ≤ 4）

// overlapsAabb 零分配 + 只认守卫（不抢焰魔/丧尸的实体）
```

⚠️ **fake `entities` 与 fake `world` 的形状必须与真实一致**：`WorkerPool.call()` 返回 `{id, promise}` 那个坑的同源教训 —— fake 形状不对会让测试绿而生产红。照 `test-ignis-system.js` 的 fake 抄。

- [ ] **Step 2: 注册进 `src/tests/index.html`**（`test-guardian-boss-agent.js` 之后）

- [ ] **Step 3: 跑测试确认 RED**

Run: `npx playwright test tests/harness.spec.mjs -g "harness"`
Expected: FAIL（`guardian-system.js` 不存在）

- [ ] **Step 4: 写 `src/entities/guardian/guardian-system.js`**

以 `src/entities/ignis/ignis-system.js` 为模板逐段对应（`createState` 的字段校验 / `guardianDefinition` 委托 Agent / `GuardianService` 的寻路三层）。四处必须改：

1. **`createState` 的 `attackKind` 取值域** = `GUARDIAN_ATTACK_IDS`（四档，不是焰魔的两档）；另新增 **`attackCooldowns`**（按 kind 的剩余秒数）—— ⚠️ **必须跨帧保留并校验**，丢掉它 ⇒ 每帧重置 ⇒ 每招独立冷却永不生效（同 `_physAccum` / `senseTimer` 的教训）。不引入焰魔的 `spinCooldown` / `leapAttackCooldown` / `leapTargetY`（守卫无跳劈）。
2. ⚠️⚠️ **`summon` 的落点与 `HEADROOM`**：守卫有 `summonY`（Task 7 的 `bossMapAt` 给，= `floorY − 6`），故 `_findGroundY(cx, cz, refY)` 的 `nearY` 恒为**上层房间**那一层。
   **`HEADROOM = Math.ceil(GUARDIAN.height) = 4`（不 +1！）** —— 上层房间净空只有 **5 格**（ny39..43，天花板 ny44）。实测同一列的候选：
   | HEADROOM | 单列候选 ny | refY=floorY−6 选中 |
   |---|---|---|
   | 3 | 23 / 31 / **39** | 39 ✓ |
   | **4** | 23 / 31 / **39** | **39 ✓** |
   | 5 | 23 / 31（**39 被判死**） | **31 ✗ 召到中层，差 8 格** |
   原计划的 `Math.ceil(height) + 1 = 5` 会让落点**静默落到中层**（所有计数全对，只有位置错）。守卫高 3.8 ⇒ 占 ny39..42 四层，ny43 是余量。
3. **`overlapsAabb` 的 id Set 短路**：照搬焰魔（`_guardianIds`），因为它被玩家物理每帧调几十次。
4. **`guardianAabbFor` 用 `GUARDIAN_CORE_OBB`**（Task 4 已冻结实测值），center 与半长**一起**绕 `state.yaw` 旋转（与 `ignisAabbFor` 同手法）。

⚠️ **`createState` 必须重建而非原地改写**（M5 不变式：`EntityManager.update` 的跳 column 索引迁移判据是「赋值前 position vs 赋值后 position」，原地改写会让索引永不迁移 → column 卸载漏回收实体）。

⚠️ **`attackRequest` 不进 `serialize`**（瞬态，写进快照的形态是「陈旧请求复活」）。

- [ ] **Step 5: 钉住「一层台阶能上、两层不能」（取代原「验证 maxStep 1.75」探针）**

原计划的「造 2 格墙断言能上 1.75 以内台阶」**无判别力**：实测 `zombieStepUpY` 恒抬 1 格，1 格台阶恒 PASS、2 格恒 FAIL，与 `maxStep` 取值无关。改成两条有判别力的断言：

```js
// ① 1 格台阶：守卫（半宽 1.25 / 高 3.8）能走上去
//    fixture：地面 y=9 实心，x≥5 的列在 y=10 实心（1 格台阶），上方净空 ≥ 5 格
//    断言：推进若干帧后 position.y 从 10 变为 11
// ② 2 格台阶：走不上去（当前实现的真实上限）
//    fixture：x≥5 的列在 y=10,11 都实心
//    断言：position.y 恒为 10（不因 maxStep 写成 1.75 而变成 12）
//    ⚠️ 这条是「maxStep 是死值」的回归守卫：将来真改了 zombieStepUpY 它会红，提醒回来重标
```

Expected: 两条均 PASS。若 ② 红（真的上了 2 格）⇒ 说明 `zombieStepUpY` 被改过，**停下来报告**（那会影响丧尸/焰魔/玩家三方，不在本次范围）。

- [ ] **Step 6: 跑测试确认 GREEN + 三门**

Run: `npx playwright test tests/harness.spec.mjs -g "harness" && npm run check`
Expected: 两者全绿。

- [ ] **Step 7: Commit**

```bash
git add src/entities/guardian/guardian-system.js src/tests/test-guardian-system.js src/tests/index.html
git commit -m "feat(guardian): 末影守卫 definition + service（脚底语义 / 召唤幂等 / 玩家物理阻挡盒）"
```

---

### Task 7: boss-map 判定器 + 名册接线（Tier 1，TDD）

**Files:**
- Modify: `src/gen/structures/ruined-citadel.js`（加三个落点常量）
- Modify: `src/entities/bosses/boss-map.js`（加 `RUINED_CITADEL` 判定器 + `BOSS_MAP_KINDS`）
- Modify: `src/entities/bosses/boss-registry.js`（加名册）
- Modify: `src/tests/test-boss-map.js`、`src/tests/test-ruined-citadel-gen.js`
- Modify: `src/tests/test-ui.js`（若名册长度断言在那里）

**Interfaces:**
- Consumes: `ruined-citadel.js` 既有的 `computeRuinedCitadelAnchor(seed)` → `{wx,wz,floorY,span}|null`、`inRuinedCitadelFootprint(wx,wz,anchors)` → `boolean`
- Produces（三个常量均在 `ruined-citadel.js` 导出，**唯一权威**；`boss-map.js` 只消费不复算）：
  - `RUINED_CITADEL_SUMMON_FEET_DY = -6`（上层房间脚底：ny39 − 45）
  - `RUINED_CITADEL_SUMMON_DX = 1`
  - `RUINED_CITADEL_SUMMON_DZ = -2`
  - `bossMapAt(wx,wz,seed)` 新增返回 `{kind:'RUINED_CITADEL', cx, cz, key:'ruinedcitadel:0', summonY}`

- [ ] **Step 1: 写失败测试（`test-boss-map.js` 追加）**

```js
// 锚点内 → RUINED_CITADEL，summonY = floorY - 6，cx/cz = a.wx+1 / a.wz-2
// 占地边缘（±HALF_X / ±HALF_Z）→ 仍命中
// 占地外一格 → null（或落到别的地图，但**不得**是 RUINED_CITADEL）
// ⚠️ 坐标类判据一律非负取模（wx % 16 在负坐标返回负值 → 判据恒真）

// 雪原重叠顺序（Review Focus #3）：必须**扫多 seed**，但**seed 清单不得照搬大竞技场的**
//   雪原盒是 region 级包围盒（±28）可伸进堡垒占地（±53/54），且那座雪原已被堡垒压制
//   （ruinedCitadelSuppressedLandmarks ⇒ 世界里根本不存在），而 snowMapAt 只跳 tarn 压制的雪原
//   ⇒ 顺序反了会把堡垒内的点误判成 SNOW，按 B 召到几十格外的虚空
//   ⚠️⚠️ **实测：大竞技场那八个 seed 在堡垒上零重叠**（12345/99999/1249026/20260101/
//      777/4242/31337/8888 逐个查：最近雪原中心到占地净距 64~98 格，远超盒半宽 28）
//      ⇒ 照搬会让 `checked > 0` 直接 FAIL（不是假绿，是真红）。
//   **用这五个 seed（已实测有重叠，且当前 bossMapAt 均误返回 SNOW）**：
//     2096 重叠点(-327,124)  锚点(-278,113)  雪原被堡垒压制 true
//     4151 重叠点(-469,-101) 锚点(-443,-47)  雪原被堡垒压制 true
//     2644 重叠点(-247,107)  锚点(-194,161)
//     3740 重叠点(-268,259)  锚点(-215,313)
//     4973 重叠点(-241,353)  锚点(-188,343)
//   其中 2096/4151 那座雪原**世界里根本不存在**，正是本用例要钉的那一类（不得过滤掉）。
//   扫描耗时实测：40 个 seed 3.6s ⇒ 5 个 seed 在单测里可接受。

// 名册：bossSlotsFor('RUINED_CITADEL') 长度 1、slot 0、type GUARDIAN_TYPE、service 'guardians'
// 优先级：CITY > TARN > BURNING_ARENA > RUINED_CITADEL > SNOW > SHALLOW_TARN
```

`test-ruined-citadel-gen.js` 追加一条 **Tier 2 守卫**（三个落点常量的唯一独立守卫）：

```js
// 从产物 assets/structures/ruined_citadel.json 重算「上层房间落点」，与三个常量对账。
// 判据（spec §2.3.2 实测，按**引擎真实口径**）：
//   · ny38 是地板（end_stone_bricks / void_stone 等实心）、ny39..43 连续 5 格空气、ny44 是天花板；
//   · 落点 (1,-2) 处守卫的 3×3 footprint × ny39..42 全空气，且 3×3 的 ny38 全实心；
//   · **几何中心 (2,-2) 站不住**（(3,39,-2) 是非空气）⇒ 钉住「不得图方便用几何中心」；
//   · 从甲板竖井底 (14,39,18) 洪泛可达落点（玩家口径：半宽 0.3 / 高 1.8）。
//
// ⚠️⚠️ **洪泛判据必须用引擎口径，不得把台阶当可通行**（spec §2.3.1 的真缺陷）：
//   本仓 blocks-data.js:265 起台阶族一律 solid:true ⇒ isSolid 恒真 ⇒ 身体不能进入。
//   把台阶当 air 会算出「27,992 格连通」的假结论（实测：真实口径下三层房间**互不连通**，
//   ny30/37 全层零 air）。本用例只需验「上层房间内部可达」，不要声称整座地牢连通。
//   另：竖直移动必须**逐格检查通道**（不得穿实心）—— 允许「dy=-8 直接落地」的探针
//   会算出穿墙的假路径（审阅时真踩过：从 (0,39,0) “落”到 (1,31,0) 途经实心 ny37/38）。
//
// ⚠️ 这条必须独立于 boss-map 的用例 —— test-boss-map.js 两侧都读同一常量（只钉接线），
//    实测把常量改成 -5 时它仍全绿，只有本条会红（焰魔 BURNING_ARENA_SUMMON_FEET_DY 的同源坑）。
// ⚠️ 不能用 floorRowOf()：它读主线程模块缓存而产物只在 GEN Worker 加载过 ⇒ 恒返回兜底值 1。
```

- [ ] **Step 2: 跑测试确认 RED**

Run: `npx playwright test tests/harness.spec.mjs -g "harness"`
Expected: FAIL（`RUINED_CITADEL` 不在 `BOSS_MAP_KINDS`）

- [ ] **Step 3: 加三个落点常量到 `ruined-citadel.js`**

导出 `RUINED_CITADEL_SUMMON_FEET_DY = -6` / `RUINED_CITADEL_SUMMON_DX = 1` / `RUINED_CITADEL_SUMMON_DZ = -2`。注释写明 spec §2.3 的完整推导：
- `ny` → 世界 `y = floorY + ny − 45`（校验 ny=45→`floorY`、ny=63→`floorY+18`）；`ny=38` 地板顶面 = 脚底 `ny39` = **`floorY − 6`**；
- 产物实测依据：上层房间 air bbox 49×49、几何中心 `(2,−2)`、净空 5 格（ny39..43）；
- **为何落点是 `(1,−2)` 而不是几何中心**：`(2,−2)` 的 3×3 footprint 撞到 `(3,39,−2)` 非空气格；`(1,−2)` 是「守卫可达范围最大（290 格）+ 全部落在玩家可达集内 + 最靠房间中心（1.00 格）」的点（穷举 1114 个可站点的 14 个连通分量后取最优）；
- **为何不是最深房间**：三层地牢在引擎口径下互不连通（台阶 solid、ny30/37 全层零 air、ny37 唯一开口是遭丢弃的 `iron_trapdoor`），玩家只能走到上层。

⚠️ **`cx/cz` 必须返回落点而不是锚点中心**：`bossMapAt` 返回的 `cx/cz` 会被 `summon` 当成落点列 ⇒ `a.wx + 1` / `a.wz - 2`。三个偏移均做成导出常量，并在 Step 1 的 Tier 2 守卫里从产物重算对账。

- [ ] **Step 4: 加判定器到 `boss-map.js`**

```js
function ruinedCitadelMapAt(wx, wz, seed) {
  const a = computeRuinedCitadelAnchor(seed);
  if (!a || !inRuinedCitadelFootprint(wx, wz, [a])) return null;
  return {
    kind: 'RUINED_CITADEL',
    cx: a.wx + RUINED_CITADEL_SUMMON_DX,
    cz: a.wz + RUINED_CITADEL_SUMMON_DZ,
    key: 'ruinedcitadel:0',
    summonY: a.floorY + RUINED_CITADEL_SUMMON_FEET_DY,
  };
}
```

`BOSS_MAP_KINDS` 加 `'RUINED_CITADEL'`；`DETECTORS` 数组把它插在 `burningArenaMapAt` **之后**、`snowMapAt` **之前**（理由见 Step 1 的雪原重叠注释）。文件头的判据表与优先级注释同步更新。

- [ ] **Step 5: 加名册到 `boss-registry.js`**

```js
RUINED_CITADEL: Object.freeze([
  Object.freeze({ slot: 0, type: GUARDIAN_TYPE, service: 'guardians' }),
]),
```

注释写明：本图唯一 Boss ⇒ slot 0（toast「已召唤 Boss1」）；`summonY` 恒为**上层房间**，与玩家所在高度无关（用户裁定，同大竞技场口径）。

- [ ] **Step 6: 跑测试确认 GREEN + 三门**

Run: `npx playwright test tests/harness.spec.mjs -g "harness" && npm run check`
Expected: 全绿

- [ ] **Step 7: Commit**

```bash
git add src/gen/structures/ruined-citadel.js src/entities/bosses/boss-map.js src/entities/bosses/boss-registry.js src/tests/test-boss-map.js src/tests/test-ruined-citadel-gen.js
git commit -m "feat(guardian): 废弃堡垒进 Boss 召唤框架，按 B 召到地牢上层房间"
```

---

### Task 8: 模型装载 + SkinnedMesh 渲染器

**Files:**
- Create: `src/render/guardian-model.js`
- Create: `src/render/guardian-renderer.js`
- Create: `src/tests/test-guardian-render.js`
- Modify: `src/tests/index.html`

**Interfaces:**
- Consumes: Task 3 的产物；`core/resource-url.js` 的 `resourceUrl`；`player/step-lift.js` 的 `StepLift`；`render/knockback-ease.js` 的 `KnockbackEase`；Task 4 常量
- Produces（Task 9 依赖）：
  - `loadGuardianAsset()` → `Promise<{scale, bones, geometry, animations, metrics}>`
  - `GUARDIAN_DEATH_COLOR`：`Object.freeze([0.63, 0.33, 1.0])`（守卫主题紫 = 眼睛层主色 `(161,83,254)` 归一化，spec §10；与焰魔的 `IGNIS_DEATH_COLOR` 同位点、同形状）
  - `slerpQuat(a,b,t)` / `multiplyQuat(a,b)` / `sampleGuardianAnim(anim, timeSeconds)` / `sampleGuardianAttack(anim, timeSeconds)` / `class GuardianPoseTransition`（与 `ignis-model.js` 同形，**刻意复制不抽公共层** —— 理由照抄 `ignis-model.js` 文件头：飞龙那份已在生产运行且被 28 个用例覆盖，动它是无收益的风险）
  - `class GuardianRenderer`：`constructor(scene, asset)`、`loadTexture()`、`sync(entities, nowMs)`、`noteKnockback(id,dx,dz)`、`dispose()`

- [ ] **Step 1: 写失败测试 `src/tests/test-guardian-render.js`**

```js
// sampleGuardianAttack 播完**停在末帧**（不循环）—— 焰魔踩过：靠「传 duration−ε」实现钳制会
//   因内部再取模而拿到首帧姿态。必须直接钳帧索引。
// sampleGuardianAnim 循环：t = duration 与 t = 0 姿态相同
// 平移通道生效：有 move 关键帧的骨骼（如 lowerbody）在不同帧的 pos 必须不同
//   ⚠️ 这条钉住 Task 3 的 move 转换 —— 转错 y 符号的形态是「出招时身体往反方向窜」，
//      而骨骼数/帧数/指纹全对
// GuardianPoseTransition：淡入必须在命中帧之前走完（否则命中那一刻画面里是还没混完的站姿）
// 采样结果是「相对 bind 的增量」：必须与 bindQuaternion **相乘**而不是替换
// ⚠️ **骨骼位置公式（口径 A，与焰魔不同）**：`bone.position = localPosition + delta.pos`
//   断言：把某骨的 delta.pos 置零时，`bone.position` 逐位等于产物的 `localPosition`；
//   若实现照搬焰魔的 `pivot − R·pivot + delta`，在非零 bind 旋转的骨骼上两者不同 ⇒ 真红。
//   （守卫有 3 根非零 bind 旋转骨骼：rightarmorspike / leftarmorspike / voidstone）
// 脚底对齐：mesh.position.y === metrics.feetOffsetY（−1.5），**不得**用核心盒中心
```

- [ ] **Step 2: 注册进 `src/tests/index.html`**

- [ ] **Step 3: 跑测试确认 RED**

Run: `npx playwright test tests/harness.spec.mjs -g "harness"`
Expected: FAIL

- [ ] **Step 4: 写 `src/render/guardian-model.js`**

以 `src/render/ignis-model.js` 为模板。`loadGuardianAsset` 走 `resourceUrl('assets/guardian/guardian.json')` + cache-busting。采样函数逐字同形（`{rot, pos}` 双通道，`ignis-model.js` 已有）。

⚠️ **采样函数必须 three-free**（手写四元数 slerp），这样浏览器单测能直接驱动。

- [ ] **Step 5: 写 `src/render/guardian-renderer.js`**

以 `src/render/ignis-renderer.js` 为模板。改四处：

1. 池容量 = `GUARDIAN.maxAlive`（1）；
2. 脚底补偿用产物 `metrics.feetOffsetY`（−1.5 格）；
3. 动画来源选择按 `state.attackKind` 在 4 条片段间选（焰魔是 2 条）；
4. ⚠️⚠️ **骨骼位置公式改成 `bone.position = localPosition + delta.pos`**。
   焰魔那行是 `pivot − R_current·pivot + delta.pos`（Bedrock 绝对顶点才需要它）；
   守卫产物是 **Java 局部顶点 + pivot 恒零**（口径 A，spec §2.2.1），旋转天然绕骨骼局部原点。
   **照搬那行会把每个部件多平移一个 `pivot − R·pivot`，形态是模型炸成碎片**，
   而骨骼数/盒数/顶点数/指纹全对。`this._pivot` 根本不需要缓存。

⚠️ **骨骼增量必须从 bind 快照起算**（每帧 `bone.quaternion = bindQuat * deltaRot`）。直接 `*= delta` 会逐帧累积 ⇒ 守卫越挥越散架。
⚠️ **材质 unlit（`MeshBasicMaterial`）+ `DoubleSide`**；有贴图时基色必须白（否则「深色 × 纹理」变暗）。
⚠️ **零实例时 `visible = false`**（否则恒增 1 个 draw call）。
⚠️ **实例复用给新实体时重置 `prevY` / `lift.offset` / `knock`**（焰魔 v2.62 final review P1-2 的同源坑：不重置会把「死了又召」的高度差当成一次上台阶，出生头 ~190ms 陷地）。
⚠️ **程序化 idle**：守卫的 idle/行走是原版程序化 `walk()`/`flap()`，产物里没有 idle 片段 ⇒ 渲染器按移动相位做 `Math.sin(phase)` 摆臂（照 `zombie-renderer.js:327-329` 的手法），攻击片段期间**不叠加**（否则两套打架）。
⚠️ **姿态衔接**：`GuardianPoseTransition` 逐实例一份，`step(key, target, dt, guardianBlendSeconds(key))`；实例复用时 `reset()`。

- [ ] **Step 6: 交叉校验烘焙产物的核心 OBB 与 Task 4 的冻结值**

`GUARDIAN_CORE_OBB` 已在 Task 4 用 **Java 源码解析**实测冻结（halfExtents `[1.2500, 1.2188, 1.0313]`、center `[0, 2.5938, −0.4063]`）。本步验的是**另一条独立路径**：从烘焙产物 `assets/guardian/guardian.json` 的 bind pose 重算同一组值，两者必须逐值对账。

Run: 在 `test-guardian-system.js` 的「产物独立复算」用例里实现（Task 6 Step 1 已列），此时产物已存在 ⇒ 跑它。

Expected: PASS。若红 ⇒ **两条路径有一条错了**（烘焙器的骨骼变换/px→格换算，或 Java 解析，或**两侧坐标口径不一致**），停下来定位，**不要改冻结值迁就产物**。

⚠️ **最常见的红因是口径不一致**（spec §2.2.1）：复算侧用了焰魔的 `pivot − R·pivot` 而产物是口径 A（或反之），两侧会差整整 **1.5 格**。先核对 `root.localPosition` 是不是 `[0,−1.5,0]`、`pivot` 是不是全零，再查其他。

⚠️ 这道交叉校验是载荷性的：它是「烘焙器把骨骼变换写错」的唯一独立守卫 —— 写错时骨骼数/盒数/顶点数/指纹全对，只有姿态是坏的（焰魔 v2.58「蓄力向身后抡」的同源缺陷）。

- [ ] **Step 7: 跑测试确认 GREEN + 三门**

Run: `npx playwright test tests/harness.spec.mjs -g "harness" && npm run check`
Expected: 全绿

- [ ] **Step 8: Commit**

```bash
git add src/render/guardian-model.js src/render/guardian-renderer.js src/tests/test-guardian-render.js src/tests/index.html src/tests/test-guardian-system.js
git commit -m "feat(guardian): 末影守卫 SkinnedMesh 渲染（4 条攻击片段 + 程序化 idle + 姿态淡入）"
```

---

### Task 9: game.js 装配 + 玩家物理泛化

**Files:**
- Modify: `src/core/game.js`（装配段 + `_consumeGuardianAttackRequests` + 伤害/击退/死亡路由 + `_syncBossAudio`）
- Modify: `src/entities/entity-types.js`（`WEAPON_HITTABLE_TYPES` 加 `'guardian'`）
- Modify: `src/player/physics.js`（`_ejectFromIgnis` → `_ejectFromBoss` 泛化 + `_collides()` 并入守卫盒）
- Modify: `src/render/audio-config.js`（`SOUND_IDS` + `SOUND_EXT_OVERRIDES` + `SOUND_VOLUMES` 各加三条）
- Create: `src/tests/test-guardian-collision.js`（照 `test-ignis-collision.js`）
- Modify: `src/tests/index.html`

**Interfaces:**
- Consumes: Task 6 的 `guardianDefinition` / `GuardianService`；Task 8 的 `loadGuardianAsset` / `GuardianRenderer` / `GUARDIAN_DEATH_COLOR`；Task 4 的 `GUARDIAN_TYPE` / `GUARDIAN_ATTACKS`
- Produces: `Game.guardians`（`GuardianService` 实例）、`Game.guardianRenderer`

- [ ] **Step 1: 写失败测试 `src/tests/test-guardian-collision.js`（Review Focus #1）**

照 `src/tests/test-ignis-collision.js`。必须包含：

```js
// 玩家朝守卫身体盒走 → 被挡住（_collides() 顶部的判据，_moveAxis 与 _tryStepUp 两处都自动生效）
//   ⚠️ 判据必须放在 _collides() **顶部**，这样两处调用都生效 ⇒ 玩家爬不上 Boss
//   ⚠️ 用**身体盒**（可见躯干）而不是粗碰撞盒，否则玩家隔空被挡
// 玩家已在盒内（传送/矿车下车落进盒里）→ _ejectFromBoss 有界推出
//   断言：推出后 overlapsAabb 为假、位移 ≤ EJECT_SPEED·dt（是被顶开不是瞬移）、
//         出口位置不嵌进方块（collidesAt 校验）
//   ⚠️ 必须测**盒斜角外**的站位（yaw=45° 时阻挡盒变形）——
//      焰魔 v2.78 的真软锁就出在这里：固定圆盘阈值只盖住重叠区的 54%
//   ⚠️⚠️ **守卫的盒不对称**（center.z = −0.4063）：yaw45° 时 x ∈ [−1.900, **+1.326**]，
//      不是 ±1.6131。扫全 yaw × 盒内玩家位置实测「沿 ±X/±Z 推出所需最大距离」= **1.900 格**
//      （焰魔对照 1.376）。故额外钉一条余量断言：
assertEqual(EJECT_MAX > 1.900, true,
  'EJECT_MAX(2.0) 必须 > 守卫最深陷入 1.900；余量仅 0.100 ⇒ 不得再调大核心盒尺寸');
//      （从 physics.js 导出 EJECT_MAX 供测试读同一份权威，红线 1；现为模块内部常量）
// 焰魔与守卫**同时在场**时两套盒都生效（泛化不得弄坏焰魔那条路径）
// 不动如山：玩家贴近时守卫站定不退让（只有真重叠才例外后退）
//   ⚠️ 守卫死区下界 = 3.5 − 0.75 = 2.75 > 1.9131（最大重叠半径）⇒ 玩家正常走位永远碰不到它
```

- [ ] **Step 2: 注册进 `src/tests/index.html`，跑测试确认 RED**

Run: `npx playwright test tests/harness.spec.mjs -g "harness"`
Expected: FAIL

- [ ] **Step 3: 泛化 `src/player/physics.js`**

- 字段 `this.ignises` 旁加 `this.guardians = null`（同注释口径：注入而非 import，依赖方向 §3）。
- `_collides()` 顶部：`if ((this.ignises && this.ignises.overlapsAabb(this.aabb())) || (this.guardians && this.guardians.overlapsAabb(this.aabb()))) return true;`
- `_ejectFromIgnis(dt)` → `_ejectFromBoss(dt)`：对两套 service 各探一次最近出口，取**更短**的那个。⚠️ 保持「有界速度 / 不推进方块里 / 只推水平 / 不改不动如山」四条约束不变。
- 调用处（`step()` 开头）同步改名。
- **导出 `EJECT_MAX`**（现为模块内部常量）供 Step 1 的余量断言读同一份权威（红线 1，同 `IGNIS_EJECT_SPEED` 已导出的先例）。⚠️ **值不变（2.0）** —— 实测守卫最深陷入 1.900 < 2.0，够用；不得因为「余量小」就调大它（调大会让玩家被顶得更远）。

⚠️ **不要调大 `overlapEscapeDist` 去补覆盖不全的洞**（AGENTS.md 明令：会让 Boss 在正常贴近时也后退，反转「不动如山」裁定）。真正的防线是玩家物理的推出。

- [ ] **Step 4: 装配 `src/core/game.js`**

在焰魔装配段之后加守卫段（**位置约束**：必须在 `_waitForColumn` 之前，与焰魔同段）：

```js
this.entities.registerType(GUARDIAN_TYPE, guardianDefinition);
this.guardians = new GuardianService({
  entities: this.entities, world: this.world, seed: this.seed,
  onKnockback: (id, dx, dz) => this.guardianRenderer?.noteKnockback(id, dx, dz),
});
try {
  const guardianAsset = await loadGuardianAsset();
  this.guardianRenderer = new GuardianRenderer(this.scene, guardianAsset);
  await this.guardianRenderer.loadTexture();
} catch (err) {
  console.warn('[guardian] 渲染器加载失败，末影守卫不显示（不影响游戏）:', err);
  this.guardianRenderer = null;
}
```

⚠️ **渲染器加载失败不得让整个游戏起不来**（与龙/焰魔/武器模型同一容错口径）。

其余接线（逐处对应焰魔）：
- `this.player.physics.guardians = this.guardians;`（在 `physics.ignises` 那行旁）
- 帧循环：`this.guardians?.update(dt, {playerPosition:[pp.x,pp.y,pp.z], nowMs})`（在 `ignises.update` 旁）
- `this._consumeGuardianAttackRequests()`（在 `_consumeIgnisAttackRequests()` 旁）
- `if (this.guardianRenderer) this.guardianRenderer.sync(this.guardians.activeEntities(), nowMs);`
- `damageEntity` 路由加 `GUARDIAN_TYPE` 分支；`knockbackEntity` 同（⚠️ 守卫 `KNOCKBACK_RESISTANCE = 1.0` 完全免疫击退 ⇒ **`knockbackEntity` 对守卫直接返回 false**，并在注释里写明原版依据）
- `_onEntityDeath` 的死亡音/爆散色按类型分型：守卫用 `GUARDIAN_DEATH_COLOR` + `guardian_die`（爆散锚点 = 脚底 + `GUARDIAN.height / 2`，与焰魔同口径）
- `damageEntity` 的守卫分支里播 `guardian_hurt`（守卫自己挨打；玩家被打仍走 `_damagePlayer` → `ignis_hurt`）
- `_syncBossAudio` 的 `bossAlive` 加 `+ this.entities.count(GUARDIAN_TYPE)`；同方法内加守卫的「起手音 `guardian_attack` / 跳跃音」迁移差分（照焰魔那段的 `generation` 守卫 —— 漏了会让「死了又召」的旧 mode 与新 idle 构成假迁移）
- **`_runTurretAi` 的目标列表加守卫**：`for (const g of this.guardians?.activeEntities() ?? []) targets.push({ id: g.id, position: [...g.state.position] });`（脚底语义 ⇒ 用缺省 `bodyOffsetY` 抬到胸部，同丧尸/焰魔；飞龙的 position 是身体中心故显式传 0）。⚠️ **光加 `WEAPON_HITTABLE_TYPES` 不够** —— 那张表只管「能不能被打中」，炮塔索敌是另一份清单。
- **`_emitDamageNumber` 的 `headY` 加守卫分支**：`t === GUARDIAN_TYPE ? baseY + GUARDIAN.height : …`。⚠️ 漏了会落到飞龙口径（身体中心 +1.875），数字飘在胸口而不是头顶，且首帧与逐帧锚点不一致（焰魔 v2.59 踩过，`health-hud.spec.mjs` 有同类用例）。
- `dispose()` 加 `this.guardians?.dispose(); this.guardianRenderer?.dispose();`

- [ ] **Step 5: 写 `_consumeGuardianAttackRequests()`**

照 `_consumeIgnisAttackRequests()`（`game.js:3150`）逐条对应，**改两处**：① 读 `GUARDIAN_ATTACKS[req.kind]`（四档）；② 视线起点用 `GUARDIAN.height * 0.5`。

⚠️ **常态零分配门控**：`if (this.entities.count(GUARDIAN_TYPE) === 0) return;`（`activeEntities()` 会新建数组，而本方法每帧都跑）。
⚠️ **只在该帧判定一次**（`attackRequest` 是瞬态，Agent 下一帧自动置 null），否则玩家站旁边会被连续扣血。
⚠️ 伤害走 `this._damagePlayer(GUARDIAN.attackDamage)`（扣血 + `ignis_hurt` 受击音的唯一入口）。

- [ ] **Step 6: `WEAPON_HITTABLE_TYPES` 加 `'guardian'` + 音效清单接线**

① `src/entities/entity-types.js:31`：`['zombie', 'dragon', 'ignis']` → `['zombie', 'dragon', 'ignis', 'guardian']`。

② `src/render/audio-config.js` 三处各加三条（文件已在 Task 1 Step 2 拷好）：
```js
// SOUND_IDS 末尾追加
'guardian_attack', 'guardian_hurt', 'guardian_die',
// SOUND_EXT_OVERRIDES 追加（不在表里一律按 .mp3 ⇒ fetch 404 被 preload 的 catch 吞掉 ⇒ 静默无声）
guardian_attack: 'ogg', guardian_hurt: 'ogg', guardian_die: 'ogg',
// SOUND_VOLUMES 追加（照焰魔 0.5 同档）
guardian_attack: 0.5, guardian_hurt: 0.5, guardian_die: 0.5,
```

⚠️ **三处缺一不可**：`check:data` 的 `[音效]` 环节从 `SOUND_IDS` + `soundFileName(id)` 派生（红线 1），只加 `SOUND_IDS` 不加扩展名会让它去查不存在的 `.mp3` 而报缺失。
⚠️ **召唤音沿用 `ignis_burn`**（`summonBoss` 成功分支已统一播，不为守卫开第二条分支）。

- [ ] **Step 7: 跑测试确认 GREEN + 三门**

Run: `npx playwright test tests/harness.spec.mjs -g "harness" && npm run check`
Expected: 全绿。⚠️ `test-projectiles.js` 有一条「弹丸打龙：predicate 走 `WEAPON_HITTABLE_TYPES`」的用例，加类型后确认它仍绿。
⚠️ `check:data` 的 `[音效]` 环节应报「**25 个效果音**」（现有 **22** + 新 3，实测 `SOUND_IDS.length === 22`）—— 数目不对就是三处清单漏了一处。

- [ ] **Step 8: Commit**

```bash
git add src/core/game.js src/entities/entity-types.js src/player/physics.js src/render/audio-config.js src/tests/test-guardian-collision.js src/tests/index.html
git commit -m "feat(guardian): 装配末影守卫 + 玩家物理身体盒阻挡泛化到双 Boss"
```

---

### Task 10: check:data 契约环节（Tier 2）

**Files:**
- Modify: `tools/check-data.mjs`（加 `[末影守卫]` 环节）

**Interfaces:**
- Consumes: Task 1 的 `guardian-fingerprint.mjs`；Task 3 的产物
- Produces: `npm run check:data` 的 `[末影守卫]` 断言集

- [ ] **Step 1: 加 `[末影守卫]` 环节**

照 `check-data.mjs` 的 `[焰魔]` 环节（:607 起）。断言：

1. 三个产物存在（缺失 → 提示「跑 `npm run guardian`」）。
2. `guardian.png` 尺寸 = `GUARDIAN_BAKE_PARAMS.textureSize`（256²）。
3. `guardian.json` 的 `metrics.boneCount` / `cubeCount` / `bakedCubes` / `vertexCount` / `indexCount` = `GUARDIAN_METRICS` 对应值（20/24/24/576/864）。
4. 4 条动画名恰为 `GUARDIAN_ANIM_SOURCES` 的键，且各 `frameCount` = `GUARDIAN_METRICS.animTicks`（60/60/90/48）；`frames.length === frameCount × boneIndices.length × 7`。
5. **输入指纹匹配**：`guardianInputFingerprint().input` 与 `guardian.meta.json` 的 `fingerprints.input` 逐位相同（Review Focus #5 —— 改了 Java 源码/贴图/坐标口径参数但没重烘 ⇒ 红）。
6. **坐标口径哨兵**：`bones[0].localPosition` 逐位等于 `[0, −1.5, 0]` 且所有 `bones[].pivot` 全零。
   ⚠️ 这条钉住口径 A（spec §2.2.1）—— 换口径会改变每个顶点与 `feetOffsetY`，而骨骼数/盒数/顶点数全对。
7. **内容级断言（指纹拓不到的那类）**：`guardian.png` 在 layer 不透明处与 `ender_guardian_layer.png` **逐像素全等的像素数 === `GUARDIAN_METRICS.layerOpaquePixels`（2749）**。
   ⚠️⚠️ **不得写成「紫色像素 > 0」**（原计划的写法，**无判别力**）：实测主贴图自身就有 2,885 个紫像素，漏合成时也有 2885（正确合成 2880）⇒ 两侧都 >0。
   ⚠️ **阈值必须取满值 2749而不是「>0」或「接近 2749」**：漏合成时全等数仍有 **2604**（主图与 layer 本就大面积同色，只差 145 像素）。实测对照：漏合成 **2604** / 正确 **2749**。
   ⚠️ **为何必须有这条**：与焰魔「盾画了却一个像素也看不见」同源 —— 漏合成眼睛层时，几何/骨骼/UV/指纹全对，只有数贴图才发现。

- [ ] **Step 2: 验证环节真的会红（负向验证）**

```bash
cp assets/guardian/guardian.png /tmp/guardian-png-backup.png
cp assets/guardian/src/ender_guardian.png assets/guardian/guardian.png   # 退回未合成眼睛层
npm run check:data; echo "exit=$?"
cp /tmp/guardian-png-backup.png assets/guardian/guardian.png             # 用 cp 副本还原
npm run check:data; echo "exit=$?"
```

Expected: 第一次 `exit=1` 且错误信息精确指向眼睛层（实测会报「全等 2604 ≠ 期望 2749」）；第二次 `exit=0`。

⚠️ **这个负向验证同时也是判别力检验**：若第一次竟然 `exit=0`，说明你把内容级判据写成了「紫色像素 > 0」那类恒真式（实测漏合成也有 2885 个紫像素）。

⚠️ **还原必须用 `cp` 副本，禁止 `git checkout`/`restore`**（产物可能含别的会话未提交的改动，已发生过真实数据丢失）。
⚠️ 临时文件放 `/tmp`，**不要用 `.tmp-*` 通配符批量删**（会误删别人的文件）。

- [ ] **Step 3: 跑三门**

Run: `npm run check`
Expected: exit 0

- [ ] **Step 4: Commit**

```bash
git add tools/check-data.mjs
git commit -m "test(guardian): check:data 末影守卫产物契约环节（指纹/度量/眼睛层内容级）"
```

---

### Task 11: Tier 4 E2E 验收

**Files:**
- Create: `tests/guardian.spec.mjs`

**Interfaces:**
- Consumes: `window.__MC_GAME__` / `window.__MC_BOOT__`（Playwright 经此编程驱动，无头无键鼠）
- Produces: 真实游戏页的召唤/命中/可达性/脱困/BGM 验收

⚠️ **两个场景必须分开**（spec §2.3.3）：召唤/命中/像素在**堡垒上层房间**；脱困跳在**开阔地形围栏**。
上层房间净空只有 5 格（ny39..43）、守卫高 3.8 ⇒ 脚底只能升 **1.20 格**，普通跳（2.52）/ 强化跳（4~8）
**全部撞天花板** —— 在那里断言「跳出去了」会恒红，而那是房间几何而不是实现缺陷。

- [ ] **Step 1: 写 `tests/guardian.spec.mjs`**

照 `tests/ignis.spec.mjs`（焰魔 v2.88 的那条 Tier 4 是最直接的模板）。用例：

1. **召唤落点**：把玩家放进堡垒占地内（用 `computeRuinedCitadelAnchor(seed)` 求坐标，`?seed=` 固定）→ 派真实 `KeyB` → 断言守卫 `state.position` 的 y = `floorY + RUINED_CITADEL_SUMMON_FEET_DY`（= `floorY − 6`）、x/z = 落点（`a.wx+1` / `a.wz−2`，**加 0.5 后的格中心**）、`onGround` 为真、**脚下实心 / 自身空气**、id 带 `ruinedcitadel:0`。
   ⚠️ 断言 y 时**同时钉「不等于其它两层的 y」**（中层 `floorY−14` / 最深 `floorY−22`）—— 只钉「在上层」抓不到「召到了中层」。
   ⚠️⚠️ **这条就是 `HEADROOM` 的回归守卫**：实测 `HEADROOM=5` 时 ny39 被净空判据排除，落点静默变成 ny31（= `floorY−14`）。取 4 才对。
2. **玩家自己走得进去（可达性，新增）**：把玩家放到**甲板竖井底** `(a.wx+14, floorY−6, a.wz+18)` → 驱动它朝落点走 → 断言最终水平距 < 4.5（最短的一招射程）。
   实测最短路 **65 步 ≈ 8.1 秒**（跑速 8 格/秒）⇒ 等待窗口取 **≥ 20s**。
   ⚠️ **不得只用传送把玩家放进房间就声称可达** —— 那只测了传送。本条是 B1 改落点的根本理由（玩家真能走到 Boss 面前）。
3. **占地外按 B**：玩家在堡垒外 → 断言 toast「这里没有可召唤的 Boss」且 `entities.count(GUARDIAN_TYPE) === 0`（Review Focus #3）。
4. **三招命中扣血**：把玩家放到守卫前方 `hitRange` 内 → 推进到各招命中帧 → 断言 `player.health` 减少恰 `GUARDIAN.attackDamage`（16），且**背后站位不被重击/上勾拳命中、但被踩踏命中**（钉住逐招锥角：35°/30°/180°）。
   ⚠️ 玩家血量 20、伤害 16 ⇒ 两下即停在 0（用户裁定「只扣血不死亡」）。断言要按 `applyDamage` 的钳制口径写，多次命中用例要每轮回满血（照 `ignis.spec.mjs`）。
5. **脱困跳（单独场景，开阔地形）**：在**堡垒外的平地**上召一只守卫（直接走 `GuardianService.summon` 并给开阔地坐标）→ 围 4 格高围栏 → 断言 `stuckLeapSeconds` 内 `mode` 迁入 `leap`、且最终脱困（Review Focus #2）。
   ⚠️ **围栏取 4 格而不是 3 格**：普通跳顶点 2.52，3 格墙的墙顶在起点+3 ⇒ 首次普通跳就借 step-up 爬上去了（焰魔 `escapeLeapApexMin` 注释里的实测）。
   ⚠️ **另钉一条「低净空不卡死」**：在堡垒上层房间里造卡住态 → 断言它仍能回到 `chase`（`leapMaxSeconds` 安全阀生效），而不是永久停在 `leap`。
6. **BGM 切换**：召出守卫 → 断言 boss 曲 `wanted → mix ≥ 1 → playing` 且普通曲停；守卫死后淡回。
7. **像素验收**：守卫在场 vs 不在场的同机位截图差分（`nsMeanLum` 或紫色像素占比），**同时钉上下界**，并先测同状态重复截图的噪声底。
   ⚠️ WebGPU canvas 的像素回读必须在 `renderer.render()` **之后**；逐帧读像素要在 rAF 回调内。
   ⚠️ **紫色像素判据要带对照组**：地牢里本来就有 `void_stone`（rgb 120,31,225）等紫色方块（AGENTS.md 已记它是水体判据的误报源）⇒ 必须先测「无守卫时的紫像素底」再定阈值。

⚠️ **世界稳定判据**：等 sections 停止增长，不能只看队列瞬时归零。
⚠️ `playwright.config.mjs` 全局 timeout 200s 必须 ≥ 本 spec 自己的等待窗口。

- [ ] **Step 2: 跑 E2E**

Run: `npx playwright test tests/guardian.spec.mjs`
Expected: 全绿。**先单独跑通，再进 Task 12 的全量回归。**

- [ ] **Step 3: Commit**

```bash
git add tests/guardian.spec.mjs
git commit -m "test(guardian): Tier 4 E2E（上层房间召唤落点 / 玩家可达 / 三招逐招锥角 / 围栏脱困 / BGM）"
```

---

### Task 12: 全量回归 + 交付

**Files:**
- Modify: `docs/roadmap.md`（加版本行）
- Modify: `CLAUDE.md`（若产生新的高频坑）

- [ ] **Step 1: 全量回归**

Run（后台跑，别阻塞）: `npm test`

Expected: 全绿。**红的 spec 先判是否本改动引起** —— 用「逐文件回退本任务改动」方式二分（**禁用 `git stash`**：工作区可能有别的会话未提交改动），或直接读失败信息定位。

⚠️ 已知 flaky（AGENTS.md）：`dragon-ai` / `zombie-model` / `lake-ripple` / `m1-acceptance` / `m3-rain` / `weapons-world-edit`。计时型断言的差异判定必须用**交替对照**（两侧交错各 2~3 轮、只差被测代码），不看单次红绿、不改阈值。

- [ ] **Step 2: 预算门**

Run: `npx playwright test tests/m3-fullscene.spec.mjs tests/giant-tree-budget.spec.mjs`

Expected: `gpuVertexBytes < 200 MiB`（当前 193.8 MiB，余量 6.2 MiB）。⚠️ 守卫是 1 个 SkinnedMesh（24 盒 = 576 顶点），对地形预算无影响，但**必须实测确认**而不是推断。

- [ ] **Step 3: 真实游戏页手验（用户验收用）**

`npm start` → 浏览器开 `http://localhost:8081/?seed=12345` → 设置面板「堡垒」瞬移 → 从甲板竖井（相对锚点 `(+14,+18)`）下到**上层房间** → 按 B。

记录：召唤落点坐标、守卫外观（眼睛是否紫、贴图是否花脸、**模型是否炸成碎片**）、三招观感、BGM 是否切换。

⚠️ **地牢三层互不连通**（spec §2.3.1）：从甲板只能走进上层房间；中层/最深需要挖穿 `ny37/38` 与 `ny30`。这是已知现状，不是本次缺陷（补连通性是独立 spec）。
⚠️ **脱困跳在本房间跳不起来**（净空 5 格 − 身高 3.8 = 1.2 格），要看脱困效果请到开阔地围 4 格围栏（Task 11 用例 5）。

⚠️ **不得宣称「目视通过」代替像素实测**（Tier 4 红线）；这一步是给用户验收用的，测试判据以 Task 11 为准。

- [ ] **Step 4: 写 roadmap 版本行**

在 `docs/roadmap.md` 的独立改动表末尾加一行（版本号接 v2.90 之后），照既有行的格式：用户原话 + 逐项裁定 + 实现要点 + **实测数字** + 踩坑 + 验证结果（命令输出/单测计数/E2E 数）。

⚠️ 实测数字必须是真的（跑出来的），不得凭印象写。

- [ ] **Step 5: 把新踩的坑写进 `CLAUDE.md`**

只写**非显然、会静默失效**的（AGENTS.md 的收录标准）。候选（全部已实测）：
- **Java 与 Bedrock 的顶点坐标系不同**：Java `addBox` origin 是骨骼局部、Bedrock 是绝对模型坐标。混用的形态是模型整体陷地/悬空 1.5 格或炸成碎片，而骨骼数/盒数/顶点数/指纹全对。渲染器公式也不同（`localPosition + delta` vs `pivot − R·pivot + delta`）。
- **Java 模型 `move` 关键帧的 y 符号**（转错则「出招时身体往反方向窜」，而骨骼数/帧数/指纹全对）。
- **`GUARDIAN_UPPERCUT_AND_BULLET` 声明 100 tick 但关键帧只有 90**（照声明值烘焙会多出 0.5s 的静止尾巴）。
- ⚠️ **地牢可达性不得把台阶当可通行**（与原文相反，已实测推翻）：本仓台阶族 `solid:true` ⇒ `isSolid` 恒真 ⇒ 身体不能进入。把台阶当 air 会算出「27,992 格连通」的假结论；真实口径下三层房间**互不连通**（ny30/37 全层零 air，ny37 唯一开口是遭丢弃的 `iron_trapdoor`）。另：洪泛探针的竖直移动必须逐格检查通道，否则会算出穿墙的假路径。
- **`HEADROOM` 与房间净空的耦合**：上层房间净空 5 格，`Math.ceil(height)+1 = 5` 会把落点判死而静默召到下一层（差 8 格）。取 `Math.ceil(height)`。
- **`maxStep` 在现有实现下是死值**：`zombieStepUpY` 恒抬 1 格，1.75 与 1.0 逐位等价；「验证 >1 格台阶」的探针两侧都无判别力。
- **eyes 叠加层与主贴图 100% 重叠**（与焰魔盾的「零重叠」相反）；内容级判据要用「逐像素全等 2749」而不是「紫色像素>0」（后者漏合成也有 2885，前者漏合成 2604 ≠ 2749）。
- **判定器顺序用例的 seed 清单不能跨结构照搬**：大竞技场那八个 seed 在堡垒上零重叠（净距 64~98 格 > 盒半宽 28），`checked > 0` 直接红。
- **踩踏是 180° 全向** ⇒ 不得照搬焰魔「半角 < 180」的锥角守卫。

- [ ] **Step 6: Commit（等用户指令）**

```bash
git add docs/roadmap.md CLAUDE.md
git commit -m "docs: 末影守卫 Boss 交付记录"
```

⚠️ **提交必须等用户明确指令**（AGENTS.md）。交付报告里附：验证证据（命令输出、单测计数、E2E 结果、draw call）、**已知偏离**（踩踏改环形近战；召唤点从最深房间改为上层房间；`maxStep` 取 1.0 而不是原版 1.75）、**已知边界**（上层房间净空 5 格 ⇒ 脱困跳只能升 1.2 格；地牢三层互不连通）、待用户实玩标定的项（`chaseSpeed 5.4`、四档权重与独立冷却）。
