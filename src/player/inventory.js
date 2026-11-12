// src/player/inventory.js — M3.1 物品模型（设计文档 §4.5.4，v1.16 定稿）
// 照搬 mc-lite `src/actors/player/Slots.js` 的语义（Slot / Inventory），无 three / DOM 依赖，
// 主线程与浏览器内单测同构可用。
//
// 权威数据只有一份：`player.inventory`。**快捷栏不是独立容器**，而是 `slots[0..HOTBAR_SIZE-1]` 的视图
// （mc-lite `HUD.renderHotbar()` 同构）。禁止再引入第二份物品状态或选中态。
//
// 两个数字不要混淆（v1.16 勘误：原 §4.5.4 曾写「mc-lite 默认 1500 格语义」）：
//   INVENTORY_SIZE            = 1000 槽位数（mc-lite Slots.js:57 `constructor(size = 1000)`）
//   DEFAULT_INVENTORY_COUNT   = 1500 创造模式填充时每格的 count（mc-lite GameConfig.js:9）
import { HOTBAR_ITEMS } from './hotbar-items.js';

/** 背包槽位数（mc-lite `Inventory(size = 1000)`） */
export const INVENTORY_SIZE = 1000;

/** 创造模式填充时每格的 count（占位字段，不消耗；mc-lite `DEFAULT_INVENTORY_COUNT`） */
export const DEFAULT_INVENTORY_COUNT = 1500;

/**
 * 非玩家可放置的功能性方块，不进物品集合（mc-lite 背包同样排除这 4 项）。
 * `air` 是 ID 0 的空格；`collider`/`realistic_trunk_collider` 是纯碰撞体；
 * `calcite` 无 faces-data 条目（无法出图标、mesher 也无面数据）。
 */
export const NON_PLACEABLE_ITEMS = ['air', 'collider', 'calcite', 'realistic_trunk_collider'];

/**
 * **可放置但不进背包**的方块（与 `NON_PLACEABLE_ITEMS` 语义互斥，勿混为一处）。
 *
 * 这些方块本质都能放能挖，只是不出现在背包物品集合里 → 玩家选不到 → 实际不会被放置。
 * 世界侧逻辑不受影响（结构生成仍可产生、`placeBlock()`/`digBlock()` 仍可作用于它们）。
 *
 * - `playground_block`/`playground_center_block`（创造台平台，**M9 新增**）：见下方数组内注释。
 *
 * - `chimney`（烟囱）：`solid:true` + 有 faces-data + 能放能挖，是正常可放置方块。
 *   对齐 mc-lite：其背包清单是 `Game.js:206-321` **手工列举**，实测 107 行 `inventory.add(...)`
 *   匹配、其中 2 行被注释掉（`handrailB` / `cloud`）→ **有效 105 项**，`chimney` 不在其中
 *   （实测核对，非推测）。
 * - `bed_head`/`bed_tail`/`bed_alias_block`（床）：**渲染存在未修复的镂空透视问题**
 *   （床侧面有一个面无贴面 → 出现透视穿帮，详见 `src/mesh/mesher.js` 的 TODO）。
 *   此处是**规避**而非修复：靠「不入背包 → 玩家选不到 → 实际不会被放置」避免暴露该问题，
 *   床的渲染本身仍待专门解决（归属床/宝箱/门多方块 Epic）。
 *   注意：mc-lite 背包清单同样不含 `bed_head`/`bed_tail`（手工列举实测核对），
 *   但**含 `bed_alias_block`**——本仓库一并移除是因为它 `cullMode:'none'`（不渲染、
 *   无法出图标），放进背包只会渲染一个空槽。
 *
 * 为什么不能塞进 `NON_PLACEABLE_ITEMS`：那个集合的语义是「非玩家可放置的功能性方块」，
 * 把可放置的方块放进去会让集合语义失真（后续若有人读该集合判断「能否放置」会得出错误结论）。
 */
export const HIDDEN_FROM_INVENTORY = [
  'chimney', 'bed_head', 'bed_tail', 'bed_alias_block',
  // M9：创造台平台方块。**既有偏差修正** —— 本仓物品集合是派生的（registry − 排除集合），
  // 而 mc-lite 是手工列举（`Game.js:206-321` 实测 107 行匹配、其中 2 行被注释掉 → 有效 105 项，
  // **不含**这两项）。派生口径下它们此前就在背包里 → 玩家能选中并放置平台方块。
  // ⚠️ **与 `indestructible` 登记必须成对做**：配上不可破坏门控后，若留在背包会产出撕裂状态 ——
  // 玩家放得出来，但挖不掉、TNT 也炸不掉（只能靠「关闭创造台」批量删）。
  'playground_block', 'playground_center_block',
  // 巨树景观的 8 个 `giant_*` **不在此清单**（2026-10-25 用户裁定进背包）。
  // 历史：它们曾在这里（理由是「生成期地形装饰 → 玩家放出来只会是一块没有下文的树干」），
  // 但那是代玩家做决定 —— 玩家完全可以把巨树方块当“深色大方块”盖东西。
  // 它们本来就 `solid:true` + 有 faces-data，放/挖均正常；移出后已重跑 `npm run icons`。
];

/**
 * 单个物品槽（mc-lite `Slot`）。
 * `isEmpty()` 双重判据：无物品名或 count<=0 都算空 —— `remove()` 扣到 0 后即为空槽。
 */
export class Slot {
  /**
   * @param {number} id 槽位索引（与 `Inventory.slots` 下标一致）
   * @param {string|null} [item] 方块名
   * @param {number} [count] 数量（创造模式下仅占位）
   * @param {Object} [meta] 额外元数据（后续富物品用；第一阶段恒为 {}）
   */
  constructor(id, item = null, count = 0, meta = {}) {
    this.id = id;
    this.item = item;
    this.count = count;
    this.meta = meta;
  }

  /** 写入槽位内容 */
  set(item, count, meta = {}) {
    this.item = item;
    this.count = count;
    this.meta = meta;
  }

  /** 清空槽位 */
  clear() {
    this.item = null;
    this.count = 0;
    this.meta = {};
  }

  /** 是否为空槽 */
  isEmpty() {
    return this.item === null || this.count <= 0;
  }
}

/**
 * 背包容器（mc-lite `Inventory`）。
 * 创造模式语义：`count` 是占位字段，放块/挖掘**不递减**；`remove()` 保留供后续生存 Epic
 * （掉落/拾取/消耗规则，v1.16 明确推迟到 PlayerVitals Epic）。
 */
export class Inventory {
  /** @param {number} [size] 槽位数，默认 INVENTORY_SIZE（1000） */
  constructor(size = INVENTORY_SIZE) {
    this.slots = [];
    for (let i = 0; i < size; i++) this.slots.push(new Slot(i));
    /** 当前选中槽索引。**可越出快捷栏 5 格**（背包面板点击任意非空槽即选中） */
    this.selectedSlot = 0;
  }

  /**
   * 添加物品：先堆叠到已有同类槽，再找首个空槽（mc-lite 同序）。
   * @returns {boolean} 是否成功（无空槽可放时 false）
   */
  add(item, count = 1) {
    for (const slot of this.slots) {
      if (slot.item === item) { slot.count += count; return true; }
    }
    for (const slot of this.slots) {
      if (slot.isEmpty()) { slot.set(item, count); return true; }
    }
    return false;
  }

  /**
   * 移除物品：扣减首个同类槽，扣到 0 即清空该槽。
   * @returns {boolean} 是否成功（无该物品或数量不足时 false）
   */
  remove(item, count = 1) {
    for (const slot of this.slots) {
      if (slot.item === item && slot.count >= count) {
        slot.count -= count;
        if (slot.count <= 0) slot.clear();
        return true;
      }
    }
    return false;
  }

  /** 是否持有足量物品（跨槽累加） */
  has(item, count = 1) {
    let total = 0;
    for (const slot of this.slots) {
      if (slot.item === item) total += slot.count;
    }
    return total >= count;
  }

  /** 当前选中槽对象（放块取此处的 `item`） */
  getSelected() {
    return this.slots[this.selectedSlot];
  }

  /** 选中指定槽 */
  selectSlot(index) {
    this.selectedSlot = index;
  }
}

/**
 * 构建物品名集合（§4.5.4 冻结顺序）：
 *   ① 前 `HOTBAR_SIZE` 项 = `HOTBAR_ITEMS`（v2.96：stone/dirt/grass/sand/cobblestone/
 *      wood/glass_block/tnt/mine_cart）—— 快捷栏默认观感固定；
 *   ② 其余按 `registry.all()` 注册顺序补全。
 *
 * **为什么不能纯注册序**：`blocks-data.js` 注册序前几位是 water/swamp_water/cloud/
 * glass_block/glass_blink（非常用建材），会让快捷栏前几格变成这些。mc-lite 用
 * `Game.js:206+` 手工列举 107 条、`stone` 居首达到同样效果。
 *
 * 确定性：只依赖 `registry.all()`（注册顺序），无随机、无 Map 迭代顺序以外的因素
 * —— 同 seed / 不同 seed 下物品集合恒定（红线 2 不受影响：物品集合与世界生成无关）。
 *
 * @param {*} registry BlockRegistry（须已 freeze）
 * @returns {string[]} 物品集合方块名 = registry − 两个排除集合（计数以
*          `npm run check:data` 的 `[物品集合]` 输出为准，勿在此硬编码）
 */
export function buildItemNames(registry) {
  const front = HOTBAR_ITEMS.slice(); // 前置项（快捷栏，v2.96 起 9 项）
  const frontSet = new Set(front);
  const rest = registry.all()
    .map((e) => e.name)
    .filter((n) => !NON_PLACEABLE_ITEMS.includes(n)
      && !HIDDEN_FROM_INVENTORY.includes(n) && !frontSet.has(n));
  return front.concat(rest);
}

/**
 * 创造模式无限背包：物品集合全量入包，每格 `count = DEFAULT_INVENTORY_COUNT`。
 * 填充槽数 = 物品集合大小（计数以 `npm run check:data` 为准），其余槽留空供后续生存 Epic
* 的掉落/拾取使用。
 * @param {*} registry BlockRegistry（须已 freeze）
 * @returns {Inventory}
 */
export function createCreativeInventory(registry) {
  const inv = new Inventory();
  for (const name of buildItemNames(registry)) {
    inv.add(name, DEFAULT_INVENTORY_COUNT);
  }
  return inv;
}
