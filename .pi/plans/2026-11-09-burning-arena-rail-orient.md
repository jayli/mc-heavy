# 大竞技场栏杆朝向修正 + 整体方块 review

日期：2026-11-09
参考素材：`/Users/bachi/ttt/mc/进度-大竞技场方块-栏杆修正样例.json`（用户手工修正的 200 格样例）

## 要解决什么问题

大竞技场（burning_arena）烘焙产物里 **3311 格 handrail 全部 meta=0**，全部渲染成 +X+Z 转角件。
用户提供了 200 格修正样例，核心诉求是：

- **handrailA**（直段件，180°）：沿一个轴首尾相连铺展
- **handrail**（转角件，90°）：连接两个不同方向的栏杆
- 目标：绝大多数栏杆首尾相连；边缘位置连不上时，抓手尽量靠内（朝竞技场中心）

## 现状与约束

### 缺陷确认（实测）

- 产物 `assets/structures/burning_arena.json`：handrail 3311 格，meta 分布 `0:3311`（全 0）
- 源 nbt 里栏杆来自 5 种源方块：
  `nether_brick_wall`(1489) / `nether_brick_fence`(1362) / `polished_blackstone_wall`(232) /
  `chain`(164) / `polished_blackstone_brick_wall`(64)
- 源 nbt 的 `Properties`（fence 的 east/west/south/north，wall 的同名 + up）携带了 Minecraft 的
  连接信息，但烘焙时**完全丢弃**了（`classify` 直查 `BLOCK_MAP` 返回 meta=0）

### 从用户样例提取的规则（实测验证）

1. **2 臂格**（并集 = props ∪ 实际栏杆邻居）：共线对 → handrailA 直段，垂直对 → handrail 转角。
   用户样例 142/142 吻合。
2. **chain** → handrailA X 轴直段（用户样例 8/8 吻合）。
3. **0/1 臂格**（垂直堆叠的柱子，占 85%）：同一柱段内朝向必须一致
   （用户 61/66 段段内一致）。段级算法（按 (lx,lz) 分柱、连续 y 切段、段内统一朝向）
   在样例上 92.6% 吻合。
4. **兜底**：无连接信号时用实心邻居（支撑）；完全孤立时用靠内轴的直段件。
5. **handrailB 不用**：其臂只伸到 0.25（格中心），接不上邻居（既有测试 `test-arena.js` 明确禁止）。
   用户样例里有 1 格 handrailB:0 是手工特例，不泛化。
6. **用户没有新增/删除方块**：样例里 10 个「ADD」全是 air（挖掉），不改格数，只改朝向/类型。

### 几何事实（用真实 mesher 实测）

- `handrailA` orient 0≡2、1≡3（180° 对称，顶点多重集合逐位相同）→ 语义只有 X 轴 / Z 轴两档
- `handrail` 四向互不等价（转角件，meta 载荷）
- `handrailB` orient 0≡2、1≡3，但臂只到 0.25，不可作栏杆件

### 坐标换算（样例 → 结构局部）

seed 5044198 的锚点：`wx=937, wz=219, floorY=4`；`floorRow=10` ⇒ 落位 base y = 4 − 9 = −5，
`rasterizeStructure` 内部再 −1 ⇒ `world_y = local_y − 6`，即 `local_y = world_y + 6`；
`local_x = world_x − 937`，`local_z = world_z − 219`。

### 其他方块 review 结论

- 台阶（cobblestone_step / _updown）：已有完整朝向逻辑（FACING_TO_ORIENT + meta），
  四向分布均匀（358/356/356/356 与 520/504/518/511），无问题
- 半砖 / lava 分层 / 各石材映射：已有冻结断言，无问题
- chest（1 格）/ vine（168 格）：meta=0，朝向不影响观感，无需改
- **结论：唯一需要修的是栏杆朝向**

## 打算改哪些文件各改什么

### 1. `tools/bake-burning-arena.mjs` — 加栏杆朝向 pass

在 `assemble()` 之后、`bake()` 写 blocks 之前，插入一个**栏杆朝向计算 pass**：

```
computeRailOrientations(cells, minY) → Map<"lx,ly,lz", {block, meta}>
```

算法（段级）：

1. 从 cells 里筛出栏杆格（源名 ∈ fence/wall/chain 五种）
2. 按 (lx, lz) 分柱，柱内按 y 连续切段
3. 每段计算连接信号权重表：props 臂权重 2，实际栏杆邻居权重 1
4. 选择优先级：
   - chain 段 → handrailA X 轴（`railPlacementFor(['+X','-X'])`）
   - 共线对（+X&-X 或 +Z&-Z）→ handrailA 直段
   - 垂直对 → handrail 转角
   - 单臂 → 臂 + 靠内垂直臂 → handrail 转角；无靠内垂直臂 → 直段
   - 无连接信号 → 用实心邻居（支撑）重复上述逻辑
   - 完全孤立 → 靠内轴直段（无靠内 → X 轴）
5. 段内所有格统一用该段的 (block, meta)

`bake()` 里：写 blocks 时，若该格在 railOrientMap 里，用 map 的 block/meta 替代 classify 的结果。
同时统计 `railOrientationCounts`（handrail:0~3 / handrailA:0~3 各多少格）写进 meta.json。

⚠️ 臂方向权威只能用 `src/gen/structures/arena.js` 的 `railPlacementFor` / `railArmSet`
（从 mesher 的 TEMPLATES 派生，红线 1），不得在烘焙脚本里手写朝向表。

### 2. `tools/burning-arena-fingerprint.mjs` — METRICS 加栏杆朝向分布

`BURNING_ARENA_METRICS.burningArena` 加一个 `railOrientationCounts` 字段（烘焙后实测填入）。
`burningArenaInputFingerprint()` 的 params hash 已包含 BLOCK_MAP 等；新算法是代码改动 →
已知盲区（只改算法不改参数指纹不变），靠测试兜住。

### 3. `tools/check-data.mjs` — 加栏杆朝向断言

在灾变竞技场契约里加：

- handrail 的 meta 分布不得全 0（四向都要有）
- handrailA 的 meta 分布不得全 0（X/Z 两轴都要有）
- 若 METRICS 有 railOrientationCounts，逐档比对
- 产物 palette 不得含 handrailB

### 4. `src/tests/test-burning-arena-gen.js` — 加栏杆朝向契约测试

- 从产物里抽几个已知 2 臂格（共线 / 垂直各一），断言 type+orient 正确
- 断言 handrail meta 四向俱全、handrailA 两轴俱全
- 断言产物里无 handrailB（既有约束回归）
- ⚠️ 必须同时在 `src/tests/index.html` 注册（本文件已注册，只加用例）

### 5. 重跑烘焙

`npm run burningarena` → 更新 `assets/structures/burning_arena.json` + `.meta.json`

## 怎么验证

1. `npm run burningarena` 烘焙成功，无 throw
2. 用用户样例 JSON 对比：2 臂格吻合率 ≥ 95%（目标 142/142）
3. `npm run check`（check:arch + check:data + lint）全绿
4. 浏览器内单测 `/src/tests/index.html` 里 test-burning-arena-gen 全绿
5. 全结构「臂指向空气」比例 ≤ 25%（当前算法实测 24.9%，用户样例区 9%）

## 不做的事

- 不新增/删除方块格（用户样例的 10 个 air 是手工微调，不泛化）
- 不用 handrailB（既有约束）
- 不改其他方块的映射（台阶/半砖/lava 已正确）
- 不改 mesher 的 TEMPLATES 几何（形状权威不动）
