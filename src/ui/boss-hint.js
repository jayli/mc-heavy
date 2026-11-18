// src/ui/boss-hint.js — 「这里可以召唤 Boss」常驻提示（v3.16，用户 2026-11-18）
//
// 用户原话：「在可以召唤 Boss 的位置，显示一个提示，可以召唤 Boss。离开这个区域后就让
// 这个提示消失，如果已经召唤 boss 出来后，已经没有更多的 boss 可以召唤了，这个提示也消失。」
//
// ## 判据只有一条路（红线 1）
//
// `bossMapAt(玩家 x, z, seed)` → `nextSummonableBoss(map, entities)`。两者都是按 B 走的
// 同一份权威 ⇒ 提示与 `summonBoss()` 的结果**结构上不可能分裂**。本文件不写任何
// 「哪张地图有 Boss」「哪些槽位占着」的判据，只负责画。
//
// ## 为什么是 DOM 而不是世界里的 billboard
//
// 与快捷栏/血心/迷你地图同口径：HUD 是 DOM 覆盖层，零 draw call、零 GPU 资源。
// 世界内提示要逐帧投影 + 一个常驻 mesh（违反「零实例必须 visible=false」的预算口径），
// 而且玩家背对地标时它会消失 —— 那恰恰是最需要提示的时候（刚走进区域、还没转头）。
//
// ## 为什么不是 toast
//
// toast 是**一次性事件反馈**（2.2s 自动淡出，且与设置面板共享同一个 `#mc-toast` 元素）。
// 本提示是**状态**：站在区域里就该一直在，走出去才消失。用 toast 会有两个缺陷：
// ① 2.2s 后自己没了，玩家还在区域里却看不到提示；② 任何一次别的 toast（放炮塔/瞬移）
// 都会把它的文案顶掉。故独立元素、独立生命周期。
//
// ## 视觉：原版箱子骨架 + Boss 语义色
//
// 外框沿用快捷栏那套原版 GUI 语言（2px 纯黑外描边 + 左上亮/右下暗的 inset 浮雕），
// 但底色取**冷紫黑**而不是箱子的 `#8b8b8b` —— 灰底会与快捷栏撞成「又一个物品栏」，
// 而这是召唤祭坛的语义。配色取自本仓已有的 Boss 视觉：末影守卫的紫、焰魔的橙金。
//   · 底 `#120d1c` → `#1b1230`（冷紫黑，两档渐变给出纵深）
//   · 主强调 `#ffd75e`（琥珀金：按键徽标与主标题；对底色对比度 13.9:1）
//   · 次强调 `#b98cff`（守卫紫：左侧脉动指示条与副行 Boss 名）
//   · 正文 `#f2f4f8` / 弱化 `#9aa6ba`（对底色 17.5:1 / 7.9:1，全部 ≥ 4.5）
// 呼吸动画只落在**指示条与外发光**上（1.8s 周期），文字恒定不闪 —— 常驻 HUD 上的
// 文字动画会持续夺取注意力，而这条提示玩家可能盯着看几分钟。
//
// ⚠️ 本文件的 CSS 是 JS 模板字面量：注释里**禁用反引号**包裹标识符（会提前终止模板串
// → 整个模块解析失败 → 游戏页白屏）。与 toast.js / settings-panel.js 同一陷阱。
import { bossMapAt } from '../entities/bosses/boss-map.js';
import { nextSummonableBoss } from '../entities/bosses/boss-registry.js';

/** 元素 id（E2E 与单测的 DOM 契约） */
export const BOSS_HINT_ID = 'mc-boss-hint';

/** 主标题（导出为单一口径：单测与 E2E 都读它，不在两处写字面量） */
export const BOSS_HINT_TITLE = '可召唤 Boss';

/** 按键名（与 `player.js` 的 KeyB 绑定同源语义；改绑定要同步这里） */
export const BOSS_HINT_KEY = 'B';

/**
 * 判据重算间隔（ms）。
 *
 * ⚠️ **必须节流**：`bossMapAt` 要扫 3×3 邻域 region 找雪原 + 四个结构的占地判据。
 * 预热后实测中位 0.004ms / 最坏 0.13ms（Node，300 点），每帧跑虽也扛得住，但那是
 * 白花在主线程上的预算（红线 3 精神）。250ms 与坐标/性能面板同节奏 —— 玩家跑 8 格/秒
 * ⇒ 边界处最多滞后 2 格，观感上就是「踏进区域的瞬间出现」。
 */
export const BOSS_HINT_INTERVAL_MS = 250;

/**
 * 提示的 z-index。
 *
 * ⚠️ 改这里必须重核 AGENTS.md「UI 层级」那条不等式：
 * hotbar 40 < 迷你地图 45 < 坐标/性能面板 50 = 血心 50 = **Boss 提示 50**
 * < 伤害数字 55 < 设置按钮 60 < 设置面板 70 < 背包 80 < 浮层 85 < toast 90 < …
 *
 * 取 50（与看板/血心同层）：它是**常驻状态信息**，不是瞬时反馈 ——
 * 低于面板会被面板底色盖住；高于设置按钮就会在面板打开时压在模态之上。
 * **不得取 100+**（会盖掉 WebGPU 启动失败遮罩）。
 */
export const BOSS_HINT_Z_INDEX = 50;

/**
 * 提示样式（幂等注入，按 id 检查）。
 *
 * 位置 = **屏幕正下方、快捷栏之上**。
 *
 * ⚠️ **bottom 必须高快捷栏顶边 12px，且窄屏也要重算**（实测踩到）：
 * 快捷栏总盒高 **52px**（图标 40 + 格边框 2×2 + 容器 padding 2×2 + 容器边框 2×2）
 * 且 `bottom:12px` ⇒ 它的顶边距屏底 **64px**。初版写 bottom:68px 只剩 **4px** 间距，
 * 而窄屏档当时写 64px ⇒ 实测 gap **0**（提示底边与快捷栏顶边紧贴，两块黑边糊成一条）。
 * 现取 **76px = 64 + 12**，且窄屏只改字号/内距、**不改 bottom**（快捷栏尺寸不随视口变）。
 */
const HINT_STYLE_ID = 'mc-boss-hint-style';
const HINT_CSS = `
#${BOSS_HINT_ID} {
  position: fixed; left: 50%; bottom: 76px; z-index: ${BOSS_HINT_Z_INDEX};
  transform: translate(-50%, 8px);
  display: flex; align-items: center; gap: 10px;
  padding: 7px 14px 7px 10px;
  background: linear-gradient(160deg, #1b1230 0%, #120d1c 62%, #0d0a14 100%);
  border: 2px solid #000;
  box-shadow:
    inset 1px 1px 0 rgba(185, 140, 255, 0.34),
    inset -1px -1px 0 rgba(0, 0, 0, 0.72),
    0 0 0 1px rgba(185, 140, 255, 0.22),
    0 6px 18px rgba(0, 0, 0, 0.55);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  white-space: nowrap; pointer-events: none; user-select: none;
  opacity: 0; visibility: hidden;
  transition: opacity 0.18s ease-out, transform 0.18s ease-out, visibility 0.18s;
}
#${BOSS_HINT_ID}.mc-boss-hint-on {
  opacity: 1; visibility: visible; transform: translate(-50%, 0);
}
/* 左侧脉动指示条：守卫紫 → 琥珀金的竖向渐变，1.8s 呼吸（唯一动的位置） */
#${BOSS_HINT_ID} .mc-bh-pulse {
  width: 3px; align-self: stretch; min-height: 26px; border-radius: 1px;
  background: linear-gradient(180deg, #ffd75e 0%, #b98cff 55%, #6d3fd4 100%);
  animation: mc-bh-breathe 1.8s ease-in-out infinite;
}
@keyframes mc-bh-breathe {
  0%, 100% { opacity: 0.55; box-shadow: 0 0 4px rgba(185, 140, 255, 0.35); }
  50%      { opacity: 1;    box-shadow: 0 0 10px rgba(255, 215, 94, 0.65); }
}
/* 按键徽标：原版槽位那套凹陷浮雕，底取琥珀金 —— 一眼看出「按这个键」 */
#${BOSS_HINT_ID} .mc-bh-key {
  display: flex; align-items: center; justify-content: center;
  width: 22px; height: 22px; flex: 0 0 22px;
  background: linear-gradient(180deg, #ffe08a 0%, #f0b429 100%);
  color: #1a1206; font-size: 13px; font-weight: 700; line-height: 1;
  border: 2px solid #000;
  box-shadow: inset 1px 1px 0 rgba(255, 255, 255, 0.75), inset -1px -1px 0 rgba(120, 72, 0, 0.6);
}
#${BOSS_HINT_ID} .mc-bh-text { display: flex; flex-direction: column; gap: 2px; }
#${BOSS_HINT_ID} .mc-bh-title {
  color: #ffd75e; font-size: 13px; font-weight: 700; line-height: 1.15;
  letter-spacing: 0.6px; text-shadow: 0 1px 0 rgba(0, 0, 0, 0.85);
}
#${BOSS_HINT_ID} .mc-bh-sub {
  color: #cbb8ee; font-size: 11px; line-height: 1.15; letter-spacing: 0.3px;
}
#${BOSS_HINT_ID} .mc-bh-sub b { color: #f2f4f8; font-weight: 700; }
#${BOSS_HINT_ID} .mc-bh-sub i { color: #9aa6ba; font-style: normal; }
/* 窄屏（手机竖屏）：缩一档字号与内距，仍不换行 —— 提示是单行状态条。
   ⚠️ **不改 bottom**：快捷栏的高度与底边距不随视口变，改了就贴上去（实测 gap 0）。 */
@media (max-width: 520px) {
  #${BOSS_HINT_ID} { gap: 8px; padding: 6px 10px 6px 8px; }
  #${BOSS_HINT_ID} .mc-bh-title { font-size: 12px; }
  #${BOSS_HINT_ID} .mc-bh-sub { font-size: 10px; }
}
/* 尊重系统「减少动态效果」：关掉呼吸动画，提示本身照常显示 */
@media (prefers-reduced-motion: reduce) {
  #${BOSS_HINT_ID} { transition: none; }
  #${BOSS_HINT_ID} .mc-bh-pulse { animation: none; opacity: 1; }
}
`;

/**
 * Boss 召唤提示（常驻状态条）。
 *
 * 生命周期与其它 HUD 一致：构造期建 DOM（默认隐藏）→ 帧循环 `update(nowMs)` →
 * `dispose()` 摘节点。挂在 `#hud-root` 下 ⇒ Tier 4 像素用例隐藏 HUD 时一并被隐藏。
 */
export class BossHintHUD {
  /**
   * @param {HTMLElement} root HUD 容器（`#hud-root`）
   * @param {import('../core/game.js').Game} game 读 `player.physics.pos` / `seed` / `entities`
   */
  constructor(root, game) {
    this.game = game;
    this._lastMs = -Infinity;
    /** 判据实际重算次数（单测钉「节流真生效」；不是 DOM 写入次数） */
    this._evaluations = 0;
    /** 上一次画出的槽位签名（`type|slot`）—— 相同则不碰 DOM */
    this._lastSig = null;

    this._ensureStyle(root);
    this.el = document.createElement('div');
    this.el.id = BOSS_HINT_ID;
    // 读屏软件：状态变化时才播报（常驻信息不刷屏）
    this.el.setAttribute('role', 'status');
    this.el.setAttribute('aria-live', 'polite');

    const pulse = document.createElement('div');
    pulse.className = 'mc-bh-pulse';
    const key = document.createElement('div');
    key.className = 'mc-bh-key';
    key.textContent = BOSS_HINT_KEY;
    const text = document.createElement('div');
    text.className = 'mc-bh-text';
    this._title = document.createElement('div');
    this._title.className = 'mc-bh-title';
    this._title.textContent = BOSS_HINT_TITLE;
    this._sub = document.createElement('div');
    this._sub.className = 'mc-bh-sub';
    text.append(this._title, this._sub);
    this.el.append(pulse, key, text);
    root.appendChild(this.el);
  }

  /**
   * 幂等注入样式表（同 toast / settings-panel 手法）。
   * ⚠️ 必须经 `root.ownerDocument ?? root` 取 Document —— `document.body` 上没有
   * `getElementById`（toast.js 记过这个坑：判据恒真 ⇒ 每次都 append 一份新样式）。
   */
  _ensureStyle(root) {
    const doc = root.ownerDocument ?? root;
    if (typeof doc.getElementById !== 'function') {
      const style = document.createElement('style');
      style.textContent = HINT_CSS;
      root.appendChild(style);
      return;
    }
    if (doc.getElementById(HINT_STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = HINT_STYLE_ID;
    style.textContent = HINT_CSS;
    (doc.head ?? doc.body ?? root).appendChild(style);
  }

  /**
   * 每帧调用（内部 `BOSS_HINT_INTERVAL_MS` 节流；未到期直接 return = 一次时间比较）。
   *
   * ⚠️ **不判 `game.uiModal`**：提示是常驻状态，面板开着时它在模态之下（z 50 < 70），
   * 本来就被盖住；额外加门控只会让「关面板后提示要等下一拍才回来」这种无谓的闪烁。
   *
   * @param {number} nowMs `performance.now()` 基准（禁止 Date.now()，AGENTS.md 已记）
   */
  update(nowMs) {
    if (nowMs - this._lastMs < BOSS_HINT_INTERVAL_MS) return;
    this._lastMs = nowMs;
    this._evaluations++;
    const p = this.game?.player?.physics?.pos;
    const entities = this.game?.entities;
    const slot = (p && entities)
      ? nextSummonableBoss(bossMapAt(p.x, p.z, this.game.seed), entities)
      : null;
    this._paint(slot);
  }

  /**
   * 落到 DOM。**签名没变就一个字节都不写**（常驻 HUD 的常态是「同一状态持续几分钟」）。
   * @param {import('../entities/bosses/boss-registry.js').BossSlot|null} slot
   */
  _paint(slot) {
    const sig = slot ? `${slot.type}|${slot.slot}` : null;
    if (sig === this._lastSig) return;
    this._lastSig = sig;
    if (!slot) {
      this.el.classList.remove('mc-boss-hint-on');
      return;
    }
    // 副行说清「按 B 会召出谁」——高台地带召完飞龙后这里会自动换成焰魔，
    // 玩家据此知道还有第二个（而不是以为按 B 已经没用了）。
    this._sub.replaceChildren();
    const name = document.createElement('b');
    name.textContent = slot.label;
    const tail = document.createElement('i');
    tail.textContent = `  ·  Boss${slot.slot + 1}`;
    this._sub.append(name, tail);
    this.el.classList.add('mc-boss-hint-on');
  }

  /** 只读诊断（单测 / E2E）：当前是否可见 */
  isVisible() { return this.el.classList.contains('mc-boss-hint-on'); }

  /** 只读诊断：当前完整文案（隐藏时仍保留上次文案，故判「消失」要用 isVisible） */
  text() { return this.el.textContent ?? ''; }

  /** 只读诊断：判据实际重算次数（钉节流） */
  evaluations() { return this._evaluations; }

  /**
   * **恒 false** —— 提示不是模态（契约声明，同 `Toast.isModal`）：
   * 它必须在玩家能自由操作世界时显示。若有人改成 pushModal，须同时改本方法，届时单测会红。
   */
  isModal() { return false; }

  /**
   * 释放：只摘自己的节点。
   * ⚠️ **样式表刻意不摘**（与 toast 相反）：它按 id 幂等注入且只服务本组件，
   * 换世界重建 Game 时下一个实例会复用；摘掉它会让「重建瞬间」的提示掉样式。
   * 单个 style 节点常驻的成本是零（无重绘、无监听）。
   */
  dispose() {
    this.el.remove();
    this._lastSig = null;
  }
}