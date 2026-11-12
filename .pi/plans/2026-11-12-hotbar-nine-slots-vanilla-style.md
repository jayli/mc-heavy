# 快捷栏 9 格 + 原版箱子样式

日期：2026-11-12　状态：已批准，执行中

## 目标

快捷栏（HUD 底部常驻栏）从 5 格改为 9 格，1~9 数字键全部可用，外观改成原版（vanilla）箱子风格。

## 现状（已读代码确认）

- `src/ui/hotbar.js`：DOM 由 `for (let i = 0; i < 5; i++)` 硬编码 5 格；`update()` 里两处 `i < 5`、
  `lastItems` 初值是写死的 5 项；容器样式 `rgba(0,0,0,.45) + border-radius:6px + gap:4px/padding:4px`，
  格子 `44px + 2px 半透明白边 + 圆角`。**字面量 5 在这个文件里出现 6 次。**
- `src/player/hotbar-items.js`：`HOTBAR_ITEMS = ['stone','dirt','grass','sand','cobblestone']`，
  被 `inventory.js`（`buildItemNames` 的前置项）、`player.js`（数字键上限）、`ui/hotbar.js`
  （无 inventory 时的退回数据源）三处消费。
- `src/player/player.js:242`：`n < HOTBAR.length` —— **派生自 HOTBAR_ITEMS，扩到 9 项后自动生效，无需改**。
- `src/ui/inventory.js:242`：`if (n >= 0 && n < 5)` —— **唯一硬编码 5 的数字键上限**，须改。
- 实测物品集合（`buildItemNames` 真实输出）：
  `0 stone / 1 dirt / 2 grass / 3 sand / 4 cobblestone / 5 water / 6 swamp_water / 7 cloud / 8 glass_block`。
  注册序前四项是流体与云，不适合当快捷栏（`inventory.js:165` 的注释正是为此冻结了前 5 项）。

## 用户已裁定

1. 纯 CSS 仿原版（不新增贴图素材、不跑烘焙、不产生新构建产物）；
2. 数字键一起扩到 1-9；
3. 前 5 项顺序不变，后 4 项补常用物品：**wood / glass_block / tnt / mine_cart**
   （新 `HOTBAR_ITEMS` 共 9 项，顺序冻结）。

## 改动清单

### 1. `src/player/hotbar-items.js`（数据权威）

导出 `HOTBAR_SIZE = 9` 与 9 项 `HOTBAR_ITEMS`：
`stone, dirt, grass, sand, cobblestone, wood, glass_block, tnt, mine_cart`。
注释写明：这 9 项是 `buildItemNames` 的**前置冻结序**，第 10 项起仍是注册序。

### 2. `src/ui/hotbar.js`（渲染 + 样式）

- 格数改读 `HOTBAR_SIZE`（不再有字面量 5）；`lastItems` 初值用循环生成；两个 `update()` 循环上界改
  `cells.length`。
- **样式按原版箱子重画**（容器 + 每格两层，纯 CSS）：
  - 容器：`background:#8b8b8b`、`border:2px solid #000`、`border-radius:0`、`padding:2px; gap:2px`，
    保留 `bottom:12px / z-index:40 / pointer-events:none`。
  - 每格：`44px` 总盒、`background:#8b8b8b`、`border:2px solid #373737`、
    `box-shadow: inset 2px 2px 0 rgba(255,255,255,.45), inset -2px -2px 0 rgba(0,0,0,.45)`
    （左上亮/右下暗的浮雕斜面），去掉圆角。
  - 选中：**仍写 `borderColor`**（保持 `m3-hud` / `m3-1-inventory` 现有 DOM 契约不变）
    + 内嵌白色圆环 `box-shadow: inset 0 0 0 3px #fff`（原版那个白色选中框）。
  - 40px 图标与数字角标位置不变（图标沿用 `icons.js` 的 40px 档，零缩放、像素锐利）。
  - 9 格总宽 416px，底部居中，不与迷你地图/坐标面板重叠（层级不变）。

### 3. `src/ui/inventory.js`

第 242 行 `n < 5` → `n < HOTBAR_SIZE`（import 常量），注释同步。

### 4. 测试

- `src/tests/test-inventory.js`：`slice(0,5)` → `slice(0, HOTBAR_SIZE)`；`rest.length 139 → 135`（144−9）；
  `slots.slice(0,5)` → 9。
- `src/tests/test-inventory-ui.js`：「键盘数字 1-5」用例扩成 1-9（加 `Digit9` → `selectedSlot 8` 断言）。
- `tests/m3-1-inventory.spec.mjs`：`hotbarCells` 5 → 9；「selectedSlot 越出快捷栏无高亮」那段把点击目标
  从第 8 个渲染槽（index 7，现在**已经在栏内**）改成栏外槽（index 12）。
- `tests/m3-hud.spec.mjs`：`hotbar.count` 5 → 9。
- `tests/tnt.spec.mjs:211`：`expect(placed.slotIndex).toBeGreaterThan(4)` 的意图是「经背包选中而非快捷栏
  捷径」，tnt 现在落在 index 7 ⇒ 改成断言该槽索引 = tnt 在 `slots` 里的实际索引、且
  `player.hotbarIndex === 该索引`（保留判别力，不是放宽成恒真）。
- `tests/turrets.spec.mjs` / `m3-2-orientation.spec.mjs` 的 `> 4` 针对 turret(77)/chest(43)，不受影响。

### 5. 文档

`docs/roadmap.md` 新增一行 **v2.96**（改了什么 / 为什么不是纯注册序 / 验证数据）；
`docs/phase-1-engine-design.md` §4.5.4 的「快捷栏 = `slots[0..4]`，数字键 1-5」改成 9 格口径。
代码注释里的「前 5 格」一并改。

## 验证

1. `npm run check`（check:arch + check:data + lint）。`[物品集合]` 仍是 144 项（只改前置冻结序，集合不变）。
2. `npx playwright test tests/harness.spec.mjs`（覆盖 `test-inventory` / `test-inventory-ui` / `test-ui`）。
3. 受影响 E2E：`tests/m3-hud.spec.mjs`、`tests/m3-1-inventory.spec.mjs`、`tests/tnt.spec.mjs`。
4. **视觉证据**：一次性探针截图 `#mc-hotbar` 区域，人工核对是否确实像原版。
5. 不跑 `npm run bench`（HUD DOM 不在热路径，未触碰 mesher/materials/scheduler/physics）。

## 风险与边界

- 唯一的行为面扩散：`HOTBAR_ITEMS` 从 5 项变 9 项后物品集合前 9 项被重排 ⇒ `tnt`(7) 与 `mine_cart`
  进入快捷栏。已排查全部消费方（`player.js` 派生、`inventory.js` 硬编码 5、三处测试断言）。
- 不新增美术资源、不跑烘焙：`assets/icons.json` 已含全部 144 项的两套尺寸档，
  `check:data` 的双向一致性会兜住。
- 不改 z-index（40）—— 改任一层必须重核 AGENTS.md 的层级不等式，本次不动层级。
