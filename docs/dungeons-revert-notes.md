# 地牢（Dungeons）移植撤销说明

日期：2026-11-17
决定人：用户
执行：完全撤销，回归 `main`
被撤销的分支：`feat/dungeons-port`（15 个提交，从 `main` 的 `9b07351` 切出）

---

## 1. 为什么撤销

**用户实玩后的判断**：「搞了半天，地牢就是一个方盒子？还以为是什么宏伟的迷宫或者建筑呢。」

这个判断**完全准确**。拍照取证 + 离线逐层剖面核对确认：

RS 的 `dungeons` 家族就是一个 **7×7×4（或 9×6×9）的空心方盒** ——
四面墙 + 地板 + 天花板，中心一个刷怪笼，**没有柱子、没有装饰、没有通道、没有迷宫**。
这是原版 Minecraft dungeons 的真实形状，RS 模组只是给它换了建材。

逐层剖面（`dungeon_desert_0`，█=墙 ▄=半砖 ·=空气 M=刷怪笼）：

```
y=1  全 ▄（地板）
y=2  █ 边框 + 内部全 · + 中心 M
y=3  █ 边框 + 内部全 ·
y=4  █ 边框 + 内部全 ·
y=5  █ 边框 + 内部全 ·
y=6  全 █（天花板）
```

**投入产出严重失衡**：15 个提交、4,598 行新增、62 个文件、
18 片素材 + 18 个产物 + 1 个撒布类型 + 1 个瞬移按钮 + 24 条单测 + 2 个 spec，
换来的是「地下多了一个空房间」。而本仓已有废弃堡垒（288,744 格的真地牢）、
大竞技场、巨型金字塔等真正宏伟的结构，地牢在观感上毫无竞争力。

---

## 2. 这次失误在我，不在素材

调研阶段我报了这些**成本优势**：零新增贴图、单片直通无 jigsaw、尺寸小地形容差高、
补的是「地下空白」。**但我没有先告诉用户它长什么样。**

正确的做法应当是：在推荐 dungeons 之前先离线打印剖面图或渲一张图，
让用户看到「这就是个空盒子」再决定要不要做。
「零成本」不等于「值得做」—— 我把前者当成了后者的论据。

⚠️ **教训（值得记住）**：推荐移植素材时，**先给出观感证据（截图/剖面），再谈成本**。
成本分析回答「能不能做」，观感证据回答「值不值得做」，后者应当先问。

---

## 3. 撤销范围与方式

### 3.1 关键事实：main 从未被污染

```
$ git ls-tree -r main --name-only | grep -i dungeon
(空)
```

15 个提交**全部只在 `feat/dungeons-port` 分支上，从未合并进 main**。
⇒ **不需要 `git revert`**，只要不合并且删除分支即可。main 的代码一字未动。

### 3.2 执行动作

| # | 动作 | 说明 |
|---|---|---|
| 1 | 本文档写进主仓 `docs/` | **唯一保留物**：决策记录 + §4 的通用实测教训 |
| 2 | 删除主仓未跟踪的**调研文档** | `docs/repurposed-structures-migration-survey.md`（本会话创建，未跟踪） |
| 3 | 删除主仓未跟踪的**设计文档** | `docs/superpowers/specs/2026-11-17-dungeons-port-design.md`（同上） |
| 4 | `worktree exit` 回到主仓 | 必须先切走 cwd，否则 bash 会在 spawn 阶段失败 |
| 5 | 删除 worktree 目录与 `feat/dungeons-port` 分支 | 15 个提交随之丢弃 |

⚠️ **用户裁定「完全撤销」** ⇒ 调研文档与设计文档**一并删除**，不留半成品。
本文档之外，主仓不残留任何地牢相关文件。

### 3.3 被丢弃的内容清单

**代码**（全部随分支删除，main 无残留）：
- `src/gen/structures/dungeons.js` / `dungeons-data.js` / `dungeons-teleport.js`
- `tools/bake-dungeons.mjs` / `dungeons-fingerprint.mjs`
- `assets/dungeons/src/*.nbt`（18 片）
- `assets/structures/dungeon_*.json`（18 个）+ `dungeons.meta.json`
- `src/tests/test-dungeons.js` / `tests/dungeons.spec.mjs`
- `package.json` 的 `"dungeons"` script

**对既有文件的改动**（随分支丢弃，main 保持原样）：
- `src/gen/structures/scatter.js`（+42 行：`SCATTER_TYPES` 加 dungeon、③轮扫描）
- `src/gen/structures/region-config.js`（+7 行 footprint）
- `src/gen/structures/structure-json.js`（+10 行派生）
- `src/gen/structures/apply.js`（预载 + 光栅化分派）
- `src/core/game.js`（+33 行 `teleportToDungeon`）
- `src/ui/settings-panel.js`（+79 行第二排）
- `tools/check-data.mjs`（`[地牢]` 环节 + `MULTI_VARIANT_TYPES`）
- `src/tests/test-scatter.js`（三分类）/ `test-ui.js` / `index.html`
- `tests/teleport.spec.mjs`（新增用例）
- `CLAUDE.md` / `docs/roadmap.md`（v3.12 / v3.13 行与坑清单）

⚠️ **`docs/m3-baseline.*` 全程未被改动**（bench 用 `--out /tmp` 对照，仓库基线一字未动）。

---

## 4. 值得保留的实测教训（与地牢本身无关，是通用陷阱）

这些是本次实施中**实测发现的通用缺陷模式**，做任何结构移植都会再遇到。
代码虽撤，教训应当留下。

### 4.1 结构产物的 x/z 必须以「占地中心」为原点

`rasterizeStructure` 是 `setBlock(x + b.x, …, z + b.z)` —— **直接把产物坐标加到锚点上**。
既有 27 个产物全部跳负（`arena_grass` x∈[-20,20] / `ruined_citadel` x∈[-53,53] /
`tall_well` x∈[-5,3]）。烘焙外部素材时必须 `x -= floor((width-1)/2)`。

**失效形态是静默的**：结构整体偏 +half 格，而格数 / air 数 / palette / 指纹**全部正确**。
实测曾得「房间内 air 35 而非 99」「刷怪笼位 id 88 而非 52」——
**只有逐格比对真实 GEN 才能发现**。

### 4.2 「候选层产出 + 光栅化剔除」= 静默失效

城内地表被 `generateCity` 整形，而用 `generateHeight` 自然地形口径的结构在那里不成立
⇒ `apply.js` 阶段 2.7 首道 `inCityBounds` 会把它 continue 掉，
**世界看不得到而计数类判据全对**。

⇒ 新撒布类型若用自然地形口径，**必须在候选层就排除城市 bounds**。
本地单测手动传 layouts 且选点在城外时**两条路径都绿**，
只有真实 Worker GEN + 城内选点才暴露 ⇒ **Tier 4 不可省**。

### 4.3 逐点扫描的门控顺序看「过滤率」而非「单次成本」

实测：16 万次 `seededRandom` **1.72ms**、`safeForStructure` **0.65ms**，
但后者只砍 61% ⇒ **先 safe 反而慢**（剩 6.25 万点仍付概率成本）；
先概率（砍 99.992%）只剩 ~13 点算 safe。

layout 中位实测：先 safe **10.6ms** / 先概率 **9.1ms** / HEAD 8.6ms。
另：**行内预计算 + `continue` 跳行反而更慢**（10.6~10.9ms，破坏 JIT 循环优化）。
⇒ 热路径调序一律**交替对照实测**，不凭单次成本推断。

### 4.4 地下撒布结构是「第三类」

它的 y 是 `hMin − 高 − 埋深`（恒负），不是 `h+1`
⇒ 拿「y ≤ SEA_Y+1」判它「在水下」是口径错配。
`test-scatter.js` 的「陆地类型不在水下」断言用 `else` 把非 ship 全归为陆地，
新增地下类型时会误报（实测 got 3）。

### 4.5 切比雪夫环搜索的 dist 必须同口径

搜索用切比雪夫环而 dist 报 `Math.hypot`（欧氏）会出现
「半径 297 却返回 dist=299」（点 (-296,-39) 切比雪夫 296 / 欧氏 299），
「由近及远」的断言因此**假红**。

### 4.6 瞬移按钮的九按钮边界与直觉不同

原以为「8 按钮已到 2 字上限，第 9 个必然挤爆」——**实测推翻**：
因既有文案已全是 2 字，9 个竟然都不折行（每只 38px）。
但 9 按钮时任一文案恢复 3 字就折行（高 33→50px），**10 按钮时每只 34px、3 字折 3 行**。

第二排零 CSS 改动（`.mc-item` 本就是 `flex-direction:column`）；
预留空位要用 `visibility:hidden` 而非 `display:none`（后者不占 flex 份额）。

### 4.7 探针字段名要从源码核实

`runner.js` 的用例状态字段是 **`status: 'passed'|'failed'`**，不是 `passed: true`。
用 `!t.passed` 判失败会对**全部**用例成立 ⇒ 误报「10 个 health 用例失败」。

### 4.8 双线性同余取样会退化成极少数点

`((i*37)%1600)-800, ((i*91)%1600)-800` 中 37/91 都与 1600 互质
⇒ 两序列同步循环，**20 万次迭代只覆盖 1600 个不同点**。
按低概率判据算期望命中 0.32 个 ⇒ 实测 0 命中，一度误判成实现 bug。
⇒ 取样一律用行主序二维遍历。

### 4.9 kill dev server 要验端口，不能只验父进程

`kill <父pid>` + `kill -0` 只回答那一个 pid，**不覆盖它 spawn 的 listener 子进程**。
判「服务真停了」要用 `curl` 端口探测返回 **000**，
或 `lsof -nP -iTCP:<port> -sTCP:LISTEN` 找出真正的 listener。

---

## 5. RS 仓库的关键事实（调研文档已删，结论摘要留在这里）

调研文档 `docs/repurposed-structures-migration-survey.md` 已按「完全撤销」删除。
下面几条是**与地牢无关的通用事实**，将来若再看 RS 可直接用，不必重新普查：

- RS（`~/jaylli/RepurposedStructures`，v7.8.4，LGPL-3.0）**不注册任何 biome、
  无地形算法、无实体、无地图**，只是 3,521 片 `.nbt` 方块蓝图（gzip 7.7MB）
- **只有约 151 片是真·固定单体**，其余 96% 带 jigsaw 连接点，需拼接引擎
- **biome 变体是换皮不是不同建筑**（8 个 dungeons 变体几何签名全等 `-771717471`）
  ⇒ biome 不构成放置限制，只决定材质
- 台阶/半砖/墙**零新贴图**（`faces-data.js` 里是指向整块的指针，209 个变体不增美术成本）
- 三段可借鉴的纯算法：`AdvancedRandomSpread`（网格放置 + 互斥区）/
  `BoxOctree`（AABB 八叉树）/ `rs_pieces_spawn_counts`（零件数量上限）
- ⚠️ **它的「dungeons 最小起步」推荐已被本次证伪** —— 那是成本最低而非观感最好。
  **下次先看观感，再看成本**（见 §2）。

### 若将来还想从 RS 移植

按观感而非成本排序，真正「宏伟」的候选是：

| 家族 | 单片最大占地 | 单片格数 | 为什么值得看 |
|---|---|---|---|
| `bastions/underground` | 46×48×48 | **31,325** | 多层立体堡垒，本仓最接近的是废弃堡垒 |
| `ancient_cities` | 35×32×41 | 9,211 | 远古城市，有街道与建筑群 |
| `mansions` | 21×22×16 | 5,461 | 林地府邸，74 片拼成的大宅 |
| `monuments` | 29×22×29 | 6,982 | 海底神殿（但本仓无水下管线） |
| `villages` | 36×32×36 | 1,215/片 | 村庄，1523 片 jigsaw 拼成上百格聚落 |

它们都需要 jigsaw 引擎或离线固定拼装（成本远高于 dungeons），
但**观感上是真建筑**。要不要做，应当先看渲染图再决定。

---

## 6. 验证撤销彻底

| 判据 | 结果 |
|---|---|
| `git ls-tree -r main --name-only \| grep -i dungeon` | 空（main 从未有地牢代码） |
| `git branch --list "feat/dungeons-port"` | 空（分支已删） |
| `ls .worktrees/feat/` | 无 dungeons-port |
| 主仓 `npm run check` | 退出码 0 |
| 主仓 `git status` | 只剩别的会话的未提交文件（`.tmp-*` / bush-grass 文档），未被本次触碰 |

⚠️ **主仓有并发会话的工作**（HEAD 已前进到 `c56c0e4`，且有 bush-grass 相关未跟踪文档）。
本次撤销**只删自己创建的东西**，那些文件一律不动。