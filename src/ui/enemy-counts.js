// src/ui/enemy-counts.js — 屏幕上方「各敌人存活数」一行读数（用户 2026-11-24）
//
// 用户原话：「在屏幕上方玩家心形血条的旁边（右侧）增加两个参数，一个是丧尸数量，
// 一个是 soldier 数量，如果有存活的丧尸，有几个就显示几个，如果有存活的 soldier 有几个
// 就显示几个，同时显示飞龙、守卫、焰魔的数量，都显示在一行。不要换行，如果空间不够就压缩，
// 缩略为省略号」
//
// 两项裁定（`ask_user_question`，2026-11-24）：
//   ① 计数为 0 的项**也常显** —— 位置稳定不跳动，读数一眼可比；
//   ② 标签取**名字简写**（尸/兵/龙/守/焰），不是全名 —— 12px 字号下省横向空间。
//
// ## 为什么是 DOM 而不是画进 canvas
//
// 与血心/快捷栏/坐标面板/迷你地图同口径：HUD 是 DOM 覆盖层，零 draw call、零 GPU 开销。
// 五个数字是五个 `<span>`，数量没变就直接 `return`（每帧成本 = 一次字符串比较）。
//
// ## 「不换行、空间不够压缩、缩略为省略号」怎么实现
//
// 两层组合，缺一层就会退化成别的形态：
//   ① 容器 `white-space:nowrap` —— 「不得换行」的唯一保证；
//   ② 容器 `overflow:hidden` + `text-overflow:ellipsis` —— 内容超出时在**行尾**出省略号。
//
// ⚠️⚠️ **不能用 flex 逐项压缩**（最初写成那样，实测后推翻）：
// 五项 `flex-shrink` 均摊的形态是「每个项目都压成 `尸…`」—— 700px 视口下五项
// **全部不可读**（实测每项 26px → 23px，`scrollWidth>clientWidth` 全为真）。
// 那不是「缩略」，那是「把读数抹掉」。改回**整行截断**后，降级顺序变成
// 「后面几项被截、前面几项完整可读」，这才是「缩略为省略号」的意思。
// ⇒ 容器必须是 `display:block` + 行内子元素（`text-overflow` 只对块容器的行内内容生效，
// 对 flex 项无效）。
//
// ## 计数口径：士兵必须排除留尸
//
// 丧尸/飞龙/守卫/焰魔致死即 `despawn` ⇒ `entities.count(type)` 就是存活数。
// **士兵例外**：它留尸 1.2s（渲染要画倒地），尸体仍在 `activeEntities()` 里且
// `state.dead === true` ⇒ 不过滤的形态是「打死一只，计数不掉」（肉眼可见的错误读数）。
//
// ⚠️ 数量权威全部来自 `entities`/各 service 的既有查询，本模块**不维护任何计数器**
// （红线 1：第二份计数必然与真实实体集合漂移）。
import { DRAGON_TYPE } from '../entities/dragons/dragon-config.js';
import { GUARDIAN_TYPE } from '../entities/guardian/guardian-config.js';
import { IGNIS_TYPE } from '../entities/ignis/ignis-config.js';
import { SOLDIER_TYPE } from '../entities/soldiers/soldier-config.js';

/** 元素 id（E2E 的 DOM 契约） */
export const ENEMY_COUNTS_ID = 'mc-enemy-counts';

/**
 * 一行的 z-index。
 *
 * ⚠️ 改这里必须重核 AGENTS.md「UI 层级」那条不等式：
 * hotbar 40 < 迷你地图 45 < **坐标/性能面板 50 = 血心 50 = 本读数 50** < 伤害数字 55 < …
 * 与血心同层（50）：它是常驻信息，既不该被面板盖住，也不该盖住任何模态。
 * **不得取 100+**（会盖掉 WebGPU 启动失败遮罩）。
 */
export const ENEMY_COUNTS_Z_INDEX = 50;

/**
 * 左边的起点（CSS px）= 血心右缘 + 8px 间距。
 *
 * 血心：`left` = 8（性能看板 left）+ 330（看板冻结宽）+ 8 = 346，每排 10 颗 × 18px = 180
 * ⇒ 右缘 = 526 ⇒ 本行左缘 = 534。与 `health-hud.js` 的 `LEFT_PX` + 排宽同源推导，
 * 不写一个「看着差不多」的魔数（漂移由 `tests/enemy-counts.spec.mjs` 断言钉住）。
 */
export const ENEMY_COUNTS_LEFT_PX = 346 + 180 + 8;

/**
 * 刷新节流（ms）。
 *
 * 与坐标面板/性能看板的 250ms 同节奏：数量是低频状态，逐帧读 5 次计数的开销虽是
 * 白花的主线程预算（红线 3 精神），而且一个数字变化也只需人眼跟上。
 */
export const ENEMY_COUNTS_INTERVAL_MS = 250;

/**
 * 五项读数的**唯一权威**（顺序 = 屏幕上的显示顺序）。
 *
 * ⚠️ 标签用简写（用户 2026-11-24 裁定）。`type` 全部从各自 config import ——
 * 在这里写字面量 `'zombie'` 就是第二份类型名权威（改名时静默读成 0）。
 * ⚠️ `zombie` 的类型名是 `'zombie'` 而**不是** `ZOMBIE_TYPE` 那样的导出常量
 * （`zombie-system.js` 历史上直接用字面量）⇒ 这里显式注明，不在两处各猜一份。
 */
export const ENEMY_COUNT_ROWS = Object.freeze([
  Object.freeze({ key: 'zombie', label: '尸', type: 'zombie' }),
  Object.freeze({ key: 'soldier', label: '兵', type: SOLDIER_TYPE }),
  Object.freeze({ key: 'dragon', label: '龙', type: DRAGON_TYPE }),
  Object.freeze({ key: 'guardian', label: '守', type: GUARDIAN_TYPE }),
  Object.freeze({ key: 'ignis', label: '焰', type: IGNIS_TYPE }),
]);

/**
 * 把一份计数快照格式化成逐项文本。纯函数（无 DOM，可在 Node 单测里跑）。
 *
 * @param {Record<string, number>} counts 键 = `ENEMY_COUNT_ROWS[].key`
 * @returns {string[]} 与 `ENEMY_COUNT_ROWS` 同序、同长度的文本数组
 */
export function formatEnemyCounts(counts) {
  return ENEMY_COUNT_ROWS.map(({ key, label }) => {
    const n = counts?.[key];
    // 非法值当 0：计数读错的形态是显示 `NaN`（比不显示更糟），而它没有任何诊断价值
    return `${label} ${Number.isFinite(n) && n > 0 ? Math.floor(n) : 0}`;
  });
}

/**
 * 从 game 装配对象读五项存活数。
 *
 * ⚠️ 每项都有 `?? 0` 兜底：装配顺序错/服务未建时（构造期）不得到 `NaN` 或抛错。
 * ⚠️ **士兵必须过滤 `state.dead`** —— 见文件头「计数口径」。
 *
 * @param {object} game `Game` 实例（只读 `entities` / `soldiers`）
 * @returns {Record<string, number>}
 */
export function readEnemyCounts(game) {
  const count = (type) => game?.entities?.count(type) ?? 0;
  // 士兵：尸体仍占在集合里（留尸 1.2s），必须显式排除，否则「打死一只计数不掉」
  const soldiers = game?.soldiers?.activeEntities?.() ?? [];
  return {
    zombie: count('zombie'),
    soldier: soldiers.filter((e) => e.state?.dead !== true).length,
    dragon: count(DRAGON_TYPE),
    guardian: count(GUARDIAN_TYPE),
    ignis: count(IGNIS_TYPE),
  };
}

export class EnemyCountsHUD {
  /**
   * @param {HTMLElement} root HUD 容器（`#hud-root`）
   * @param {object} game `Game` 实例（计数的唯一来源）
   */
  constructor(root, game) {
    this.game = game;
    this.el = document.createElement('div');
    this.el.id = ENEMY_COUNTS_ID;
    // `max-width` 由 `_layout()` 按视口算（改窗口尺寸要重算，故不进 cssText 固定值）。
    // ⚠️⚠️ **`box-sizing:border-box` 不可省**（实测踩到）：`maxWidth` 默认只约束**内容盒**，
    // 而下面有 `padding:2px 6px` ⇒ 窄屏下实占宽 = maxWidth + 12，右缘溢出屏幕 4px
    //（实测 700 宽视口下 right=704）。溢出部分被浏览器裁掉，而「五项都在 DOM 里」的断言照样绿。
    this.el.style.cssText =
      `position:fixed;top:8px;left:${ENEMY_COUNTS_LEFT_PX}px;z-index:${ENEMY_COUNTS_Z_INDEX};` +
      'box-sizing:border-box;' +
      // ⚠️ `display:block` + 行内子元素：`text-overflow` 只对块容器的行内内容生效
      // （见文件头：flex 逐项压缩的形态是五项全不可读）
      'display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;' +
      'padding:2px 6px;background:rgba(0,0,0,.55);border-radius:4px;' +
      'color:#f2f4f8;font:12px/1.6 monospace;pointer-events:none;';
    /**
     * 五个行内 `<span>`（构造期一次建好，之后只改 `textContent`）。
     *
     * ⚠️ **不每帧重建 DOM**：数量是低频状态，但重建 5 个 span 每帧都是白付的布局开销。
     * ⚠️ `this._spans` 的顺序就是 `ENEMY_COUNT_ROWS` 的顺序（`_paint()` 与测试依赖这一点）。
     * ⚠️ **项间用真实空格分隔**（不靠 margin）：整行截断的判据是「行内内容溢出」，
     * 而 margin 不参与 `text-overflow` 的溢出测量 —— 用 margin 间隔的形态是
     * 「文字被切了但没出省略号」。
     */
    this._spans = ENEMY_COUNT_ROWS.map(({ label, key }, i) => {
      const span = document.createElement('span');
      span.id = `${ENEMY_COUNTS_ID}-${key}`;
      span.textContent = i === 0 ? `${label} 0` : ` ${label} 0`;
      return span;
    });
    for (const span of this._spans) this.el.appendChild(span);
    root.appendChild(this.el);

    /** 上次刷新时刻（250ms 节流基准；初值 `-Infinity` ⇒ 首帧立即刷一次） */
    this._lastUpdate = -Infinity;
    /** 上次布局用的视口宽（变化时才重算 `max-width`，避免每帧读 `innerWidth` 触发布局） */
    this._lastViewport = -1;
    this._layout();
    this._paint(formatEnemyCounts(readEnemyCounts(game)));
  }

  /**
   * 每帧调用。**未到节流点就直接 return**（常态成本 = 一次时间比较）。
   *
   * @param {number} nowMs 帧循环的 `performance.now()` 基准（与 `_coordsHud` 同口径）
   */
  update(nowMs) {
    this._layout();
    if (nowMs - this._lastUpdate < ENEMY_COUNTS_INTERVAL_MS) return;
    this._lastUpdate = nowMs;
    this._paint(formatEnemyCounts(readEnemyCounts(this.game)));
  }

  /**
   * 按视口宽度重算 `max-width`（**只在视口变化时才写**）。
   *
   * ⚠️ 不写死一个「够用」的固定宽：那会在窄屏上溢出到屏幕外，玩家看不到后面的项，
   * 而 `overflow:hidden` 把它**静默裁掉**（不是省略号）—— 形态是「焰魔那项凭空消失」。
   */
  _layout() {
    const vw = window.innerWidth;
    if (vw === this._lastViewport) return;
    this._lastViewport = vw;
    // 右边留 8px 安全边距（与坐标面板 right:8px 同口径）
    this.el.style.maxWidth = `${Math.max(0, vw - ENEMY_COUNTS_LEFT_PX - 8)}px`;
  }

  /**
   * 把五项文本落到五个 `<span>`。
   *
   * ⚠️ **只在文本真的变了才写** `textContent`（写同一个值也会触发一次重排）。
   * ⚠️ **项间空格在写入时补**（`i > 0` 首部加一个空格）：纯函数 `formatEnemyCounts`
   * 返回的是不含分隔的干净文本（单测断言它），分隔属于**显示细节**，不进纯函数。
   * 用真实空格而不是 margin —— 见构造器里那条注（margin 不参与 `text-overflow` 测量）。
   * @param {string[]} texts
   */
  _paint(texts) {
    for (let i = 0; i < this._spans.length; i += 1) {
      const raw = texts[i] ?? '';
      const next = i === 0 ? raw : ` ${raw}`;
      if (this._spans[i].textContent !== next) this._spans[i].textContent = next;
    }
  }

  /** 相邻项之间的分隔（显示细节，不属纯函数职责） */
  static get SEPARATOR() { return ' '; }

  /**
   * 当前五项文本（只读测试接口，**不含项间分隔空格**）。
   *
   * 与 `formatEnemyCounts()` 的输出同形，便于 E2E 直接与纯函数结果比对 ——
   * 带分隔的形式会让「`尸 3` vs ` 尸 3`」这种字符串差导致假红。
   * @returns {string[]}
   */
  _texts() { return this._spans.map((s) => s.textContent.trim()); }

  /**
   * 当前显示的文本数组（只读测试接口）。
   *
   * 供 E2E 断言钉「读数与真实实体数一致」而不只是「DOM 存在」——
   * 「装了 HUD 但从不刷新」的形态是被动断言抓不到的。
   * @returns {string[]}
   */
  labels() { return this._texts(); }
}