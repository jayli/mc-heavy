// src/ui/settings-panel.js — 设置面板（M3-4）
// 视觉风格照搬 mc-lite `src/style/global.css` 的设置弹窗（#settings-modal/#settings-content/
// .setting-item/.btn-group/button）：Minecraft 灰底 GUI（#c6c6c6 + 4px 深灰边 + 5px 硬黑投影）
// + 斜角浮雕按钮（左上白/右下深灰，:hover 提亮，:active 反向斜角，选中态绿色 #559944）。
// hover/active/.active 等伪类与状态类无法用 inline style 表达，故注入一次性样式表
// （组件自带样式，不依赖宿主页面；重复构造只注入一次）。
// **布局**：沿用 mc-lite 的两列盒（`.settings-columns` + `.setting-combined-item`），
// 但行列分配按 mc-heavy 当前档位需要重排（面板是后续功能的配置入口，须留扩展余量）：
// 左列 = 画质+枪械破坏合并盒 / 环境风格 / 雾色+背景音乐合并盒 / 瞬移；
// 右列 = 视距+分辨率合并盒（v2.27）/ 帧预算 / 创造台 / TNT 破坏+进度管理合并盒 / 世界
// （新世界 + 删除缓存）。
// 档位：视距（持久化+重载生效，面板 3 档）/ 画质 blur（重载生效）/ 视觉风格（运行时即时）
// / 帧预算档位（运行时即时，M3-2）/ 枪械破坏（运行时即时）/ 世界操作（新世界 / 删除缓存）。
// 音量不入面板（默认 100% 开启，`settings.js` 仍持久化 + `?volume=` URL 可达，待音频消费方接线）。
// 打开时：退出 pointer lock + 清空按键 + game.pushModal('settings')（模态栈，M3.1 §4.5.4；
// 主循环跳过 player.update、Player keydown 守卫拦截）。关闭时 lock 回 player.canvas。
import {
  VIEW_DISTANCE_OPTIONS, VISUAL_STYLE_OPTIONS, saveStoredSettings,
} from './settings.js';
// 分辨率档位的值集合（'sharp' / 'performance'）— 唯一权威在 render/pixel-ratio.js。
// 面板只引值集合与文案并排显示；换算/钳制一概不在这里做。
import { PIXEL_RATIO_MODE_OPTIONS } from '../render/pixel-ratio.js';
import { Toast } from './toast.js';

const STYLE_ID = 'mc-settings-style';
/**
 * 瞬移/toast 的显示时长（ms）。比默认 2200 长 —— 瞬移后玩家要读坐标或「多少格外」，
 * 2200ms 在视线从场景移回面板的过程中就淡掉了。
 */
const TELEPORT_TOAST_MS = 3200;
/**
 * 瞬移**成功**后延迟多久自动关掉设置面板、把玩家放回游戏（ms）。
 *
 * ⚠️ **数值是用户给的，不要改成别的**（2026-10-30：「点击面板中的瞬移的时候，除了点击标记按钮外，
 * 点击其他的按钮完成跳转后，100ms 后把设置面板关掉，自动进入游戏」）。
 *
 * ⚠️ **为什么不是 0**：`close()` 里会退出模态并 `requestPointerLock`；同一事件循环里立刻隐藏面板
 * 会让这次点击的收尾（toast 布局、按钮 :active 复位）与面板消失挤在一帧里。100ms 足够让点击事件
 * 派发走完、toast 先渲染出来，玩家从面板切回场景时不会看到一帧空白。
 */
export const TELEPORT_AUTO_CLOSE_MS = 100;
/** 「删除缓存」按钮的常态文案。复位与构造必须共用同一份 —— 写两处会漂移（红线 1 精神） */
const CLEAR_SAVE_LABEL = '删除缓存';

/**
 * M9：创造台按钮的**两态文案单一口径**（导出供 `src/tests/test-ui.js` 钉死）。
 * 构造与状态切换都必须用这两个常量 —— v1.35 踩过同一个坑（`_resetDangerArmed()` 写死旧长文案
 * 覆盖了构造时的短文案，构造代码形同虚设）。mc-lite `UIManager.js:354-364` 同手法。
 */
export const PLAYGROUND_OPEN_LABEL = '打开创造台';
export const PLAYGROUND_CLOSE_LABEL = '关闭创造台';
/**
 * M9 创造台行的标题（v1.43 起该行只管创造台本身 —— 进度管理已拆为下方独立一行）。
 * 导出供 `src/tests/test-ui.js` 钉死，构造与断言共用一份口径。
 */
export const PLAYGROUND_ROW_TITLE = '创造台';
/**
 * v1.43：进度管理行的标题。与创造台**分成两行**（用户要求，2026-09-30）—— 两者功能域不同：
 * 创造台管平台与模型，进度管整个世界的存档。导出供单测钉死（单一口径）。
 */
export const PROGRESS_ROW_TITLE = '进度管理';
/**
 * v1.98：进度按钮文案改为「导入」/「导出」（用户 2026-10-31 要求）。
 *
 * 改名的**原因是布局**：进度管理不再独占一行，而是与「TNT 破坏」共用合并盒 →
 * 每组只剩约 171px 列宽、每按钮约 81px，「导入进度 / 导出进度」四个字在 81px 内会贴到
 * 斜角边框；两字文案与同盒的「关闭 / 开启」、「像素风 / 平滑」风格一致。
 * ⚠️ 与创造台行的「导出模型 / 导入模型」**不是同一粒度**（那是平台模型，这是整世界存档）——
 * 两者靠各自的组标题（「进度管理」vs「创造台」）区分，改文案时不要把两者合并成一个常量。
 */
/**
 * v1.92：瞬移行的标题与按钮文案。导出供 `src/tests/test-ui.js` 钉死（单一口径）。
 * 用户 2026-10-29 需求：「在背景音乐下面增加一排按钮……功能就是瞬移」；
 * v1.97 追加「回家」；v2.10 改为五个按钮并**全部缩短到 ≤ 4 字**（用户 2026-10-29：
 * 「按钮调整一下：标记，跳转标记，回家，高台，竞技场。尽量在一行摆下这五个按钮」）；
 * v2.19 追加「湖」（用户 2026-10-30：「增加一个瞬移按钮：湖，点击瞬移到浅水高台地图」）
 * 并因它把「跳转标记」缩成「跳转」—— 六个按钮后**上限降到 3 字**（4 字会折行）。
 * v2.87 追加「围场」（用户 2026-11-09）—— 七个按钮后上限仍是 3 字，但靠**本行专属的
 * `gap:4px`** 才摆得下（见 `_rowTeleport` 注释里的实测宽度账）。
 * v2.89 追加「堡垒」（城西废弃堡垒）—— **八个按钮后上限降到 2 字**：实测每只 43.4px、
 * 文字可用 31.4px < 3 字（36px）⇒ 「竞技场」折成两行（按钮高 33→50px），故缩为「竞技」
 * （用户 2026-11-10 裁定）。⚠️ 即使 `gap` 收到 0px 也只有 34.9px，**3 字无论如何摆不下**。
 *
 * ⚠️ **术语（用户 2026-11-09 裁定）**：「**竞技**」= 城东沙漠的大竞技场
 * （burning arena，85×85×80）；「**围场**」= 原「小竞技场」（城南门外的草地竞技场，
 * `gen/structures/arena.js`，41×79）；「**堡垒**」= 城西干燥沙漠的废弃堡垒
 * （ruined citadel，107×110，v2.89）。用户原话：「原来的小竞技场后面我都叫围场」。
 * 代码层的 `arena` 一族命名（`computeArenaAnchor` / `teleportToArena` / `arena.js`）
 * **不改**——那是结构的技术名，改了会波及烘焙产物、单测与 E2E；只有玩家可见文案用「围场」。
 *
 * ⚠️ **文案长度是布局载荷的**（实测数据，不是估算）：左列 375px + `.mc-btn-group` 的
 * `gap:8px` ⇒ 五个按钮每个 **69px**、六个只剩 **56px**（`clientWidth` 52，扣 `padding:6px 4px`
 * 后内容宽 **44px**）⇒ 12px 字号下 3 字（36px）刚好、**4 字（48px）就折成两行**
 * （实测按钮高 33 → 50px）。与 v1.98 的「导入进度→导入」同一个原因。
 * ⚠️ **八个按钮后上限是 2 字**（v2.89 实测）：每只 43.4px、文字可用 31.4px，3 字（36px）折行。
 * ⚠️ 折行时 `scrollWidth === clientWidth`（浏览器是折行而不是溢出）—— 判断文案排不排得下
 * 必须看**行盒数**，见 `tests/teleport.spec.mjs`。
 */
export const TELEPORT_ROW_TITLE = '瞬移';
export const TELEPORT_MARK_LABEL = '标记';
export const TELEPORT_GO_LABEL = '跳转';
export const TELEPORT_HOME_LABEL = '回家';
export const TELEPORT_TARN_LABEL = '高台';
/** 「竞技」= **大竞技场**（城东沙漠 burning arena，v2.87 起指向它，见上方术语注释）。
 *  ⚠️ v2.89 由「竞技场」缩为 2 字：加第 8 个按钮后每只只剩 31.4px 文字宽，3 字（36px）会折行
 *  （用户 2026-11-10 裁定）。 */
export const TELEPORT_ARENA_LABEL = '竞技';
/** 「围场」= **原小竞技场**（城南门外草地竞技场，v2.87 由「竞技场」改名而来） */
export const TELEPORT_ENCLOSURE_LABEL = '围场';
export const TELEPORT_LAKE_LABEL = '湖';
/** 「堡垒」= **废弃堡垒**（城西干燥沙漠 ruined citadel，v2.89 新增） */
export const TELEPORT_CITADEL_LABEL = '堡垒';
/** 「要塞」= **丛林要塞**（城西第一个丛林地带 jungle fortress，v3.13 新增；
 *  v3.14 用户 2026-11-18 把文案由「丛林」改为「要塞」）。
 *  ⚠️ **第 9 个按钮**：八按钮时每只文字可用 31.4px（2 字上限），第九个后降到 ≈26px
 *  ⇒ **仍只能 2 字**，gap 保持 4px。若实测行盒数 >1 或按钮换行，**停下报告**，
 *  不擅自缩文案到 1 字或改布局（计划 DR-10）。 */
export const TELEPORT_JUNGLE_LABEL = '要塞';

/**
 * v2.27：「分辨率」行的标题与两个档位文案。导出供 `src/tests/test-ui.js` 钉死（单一口径）。
 *
 * 用户 2026-11-03：「增加一个分辨率的选项，一个是当前默认比较清晰的分辨率，一个是画面
 * 分辨率更低的按钮，分为两个按钮表达，清晰，性能」—— 文案就是用户点名的两个字。
 * 落位 = **与「视距」共用合并盒**（右列第一行左半视距、右半分辨率）。
 * ⚠️ 档位值（`'sharp'`/`'performance'`）不在这里写 —— 唯一权威是 `render/pixel-ratio.js`
 * 的 `PIXEL_RATIO_MODE_OPTIONS`，本处只负责显示文案（按下标对齐）。
 */
export const RESOLUTION_ROW_TITLE = '分辨率';
export const RESOLUTION_LABELS = ['清晰', '性能'];
/** 导出 / 导入模型按钮文案（创造台模型，与下行的**进度包**是两个不同粒度） */
const EXPORT_LABEL = '导出模型';
const IMPORT_LABEL = '导入模型';
/** 导出 / 导入**进度**（整世界存档）按钮文案。导出供单测钉死（单一口径） */
export const PROGRESS_EXPORT_LABEL = '导出';
export const PROGRESS_IMPORT_LABEL = '导入';

/**
 * M9：创造台操作的错误文案映射（单一口径，不散落字面量）。
 * key = `PlaygroundService` 返回的 reason；未命中的 reason 回落「操作失败：{reason}」。
 */
export const PLAYGROUND_ERRORS = {
  exists: '创造台已存在',
  'no-safe-location': '无法找到合适的空间，请移动位置',
  'not-loaded': '附近区块尚未加载，请稍候重试',
  'not-active': '创造台未激活',
  'player-in-playground': '请离开创造台区域后再关闭',
};

/**
 * 进度导入 / 导出的错误文案映射（单一口径）。
 * key = `Game.importProgress` 返回的 reason（来自 `save/progress-codec.js` 的分类，
 * 不在此处重新分类 —— 两处分类会漂移出「同一个坏文件在不同入口报不同原因」）。
 */
export const PROGRESS_ERRORS = {
  'invalid-json': '文件不是合法的 JSON',
  'invalid-format': '这不是 mc-heavy 的进度文件',
  'unsupported-version': '进度文件版本过新，请更新代码后再导入',
  'invalid-seed': '进度文件缺少有效的世界种子',
};

/**
 * mc-lite global.css 设置弹窗相关规则的移植（选择器加 mc- 前缀避免污染宿主页面）。
 * 两列盒（`.mc-columns`/`.mc-column`）与合并盒（`.mc-combined`）取自 mc-lite
 * `.settings-columns` / `.setting-combined-item`（`src/style/global.css:124-176`）——
 * 合并盒正是 mc-lite 用来把两组两按钮档位挤进同一行的手法。
 */
const PANEL_CSS = `
#settings-btn {
  position: fixed; top: 66px; right: 8px; width: 33px; height: 33px;
  background: rgba(0,0,0,0.6); border: 2px solid #555; color: #fff; font-size: 24px;
  display: flex; justify-content: center; align-items: center;
  cursor: pointer; z-index: 60; border-radius: 4px; user-select: none;
  transition: background 0.2s;
}
#settings-btn:hover { background: rgba(255,255,255,0.2); }

#settings-modal {
  position: fixed; inset: 0; z-index: 70;
  background: rgba(0,0,0,0.7);
  justify-content: center; align-items: center;
  font-family: 'Segoe UI', sans-serif;
}
#settings-modal .mc-content {
  background: #c6c6c6; border: 4px solid #555; padding: 20px;
  width: 770px; min-height: 250px; border-radius: 4px;   /* mc-lite #settings-content 同宽 */
  box-shadow: 5px 5px 0 #000;
  display: flex; flex-direction: column; text-align: center;
  max-height: 84vh; overflow: auto;
}
#settings-modal h2 {
  margin: 0 0 12px; text-align: left; font-size: 18px; font-weight: bold; color: #333;
}
/* 两列布局：每列独立纵向堆叠，列间分隔线画在列内各项之间（非列首项）。
   分隔线只作用于 .mc-item（行型）—— 写成通配 :first-child 会连带抹掉 .mc-combined
   合并盒自己的装饰边框（实测踩坑：#settings-modal .mc-column > :first-child 特异性
   (1,2,0) 压过 #settings-modal .mc-combined 的 (1,1,0)，上边框被置 none → 方框缺一边）。
   ⚠ 本文件在 JS 模板字面量内，注释里**不得用反引号**包裹标识符（会提前终止模板字符串）。 */
#settings-modal .mc-columns { display: flex; gap: 20px; flex: 1; }
#settings-modal .mc-column { flex: 1; display: flex; flex-direction: column; gap: 10px; }
#settings-modal .mc-column > .mc-item { border-top: 1px solid #999; padding-top: 10px; }
#settings-modal .mc-column > .mc-item:first-child { border-top: none; padding-top: 0; }
#settings-modal .mc-item {
  margin: 0; display: flex; flex-direction: column; gap: 8px;
  font-weight: bold; color: #333;
}
#settings-modal .mc-title { text-align: left; font-size: 14px; line-height: 1.2; font-weight: bold; }
#settings-modal .mc-btn-group { display: flex; gap: 8px; width: 100%; }
/* 瞬移行专属：八个按钮一行摆不下 8px 间距（实测每只 43.4px、文字可用 31.4px），
   收到 4px 后 2 字文案（24px）单行放得下；3 字（36px）无论如何折行（v2.89 实测）。
   只作用于本行，其余按钮组仍是 8px。 */
#settings-modal .mc-teleport .mc-btn-group { gap: 4px; }
#settings-modal button {
  flex: 1; padding: 6px 4px; font-size: 12px;
  background: #8b8b8b; border: 2px solid #fff;
  border-right-color: #373737; border-bottom-color: #373737;
  color: #fff; cursor: pointer; font-family: inherit; font-weight: bold;
  text-shadow: 1px 1px 0 #000;
}
#settings-modal button:hover { background: #999; }
#settings-modal button:active {
  border: 2px solid #373737; border-right-color: #fff; border-bottom-color: #fff;
}
#settings-modal button.active {
  background: #559944; /* 绿色表示选中（mc-lite 同款） */
  border: 2px solid #373737; border-right-color: #fff; border-bottom-color: #fff;
}
/* 合并盒：两组档位横向共用一行（mc-lite .setting-combined-item 同款） */
#settings-modal .mc-combined {
  border: 1px solid #888; padding: 8px; background: rgba(255,255,255,0.15);
}
#settings-modal .mc-combined-box { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
#settings-modal .mc-combined-col {
  display: flex; flex-direction: column; gap: 6px; padding: 0 8px;
}
#settings-modal .mc-combined-col:first-child { border-right: 1px solid #888; padding-left: 0; }
#settings-modal .mc-combined-col:last-child { padding-right: 0; }
/* 合并盒出现在**列中间**时（v1.98：左列的雾色+背景音乐、右列的 TNT+进度），要跟它上方的
   普通行一样有一条分隔线，否则那一块与上一行之间只剩 10px 空白、视觉节奏断掉。
   ⚠️ **只覆写 border-top-color 与 padding-top，不用 border 简写** —— 简写会连带改掉
   .mc-combined 自身方框的左右下三边（v1.35 踩过同型的特异性陷阱：一条 border-top:none
   把合并盒上边框抹掉，方框缺一边）。首位的合并盒（左列画质+枪械破坏）不加线，与既有观感一致。
   ⚠️ 本文件在 JS 模板字面量内，注释里**不得用反引号**包裹标识符（会提前终止模板字符串）。 */
#settings-modal .mc-column > .mc-combined:not(:first-child) {
  border-top-color: #999; padding-top: 10px;
}
/* 创造台：单行按钮盒（v1.43，用户要求 2026-09-30）。
   未激活 = 「打开创造台」独占整行（flex:1 满行）；激活后同行的「导出模型 / 导入模型」
   转为可见，三个按钮由 flex:1 平分该行（不再为模型另辟一行、也不再把主按钮变窄）。
   进度导入导出**不在此行** —— 它是下方独立的「进度管理」行（功能域不同）。 */
#settings-modal .mc-playground { display: flex; flex-direction: column; gap: 8px; }
/* 世界操作：两个破坏性/不可逆按钮共用一行 + 一行小字说明（省版面） */
#settings-modal .mc-world { display: flex; flex-direction: column; gap: 8px; }
#settings-modal .mc-hint { font-size: 11px; color: #555; font-weight: bold; text-align: left; }
/* 破坏性操作（删除缓存）：暗红底区分于普通灰按钮；armed 态高亮提示「再点一次即执行」 */
#settings-modal button.danger { background: #8b4b4b; }
#settings-modal button.danger:hover { background: #9b5b5b; }
#settings-modal button.danger.armed {
  background: #b33; border: 2px solid #373737; border-right-color: #fff; border-bottom-color: #fff;
}
#settings-modal .mc-footer {
  margin-top: auto; display: flex; justify-content: center; padding-top: 20px;
}
#settings-modal .mc-footer button { flex: none; padding: 8px 24px; font-size: 13px; }
`;

/** 注入面板样式表（幂等） */
function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = PANEL_CSS;
  document.head.appendChild(style);
}

export class SettingsPanel {
  /**
   * @param {HTMLElement} root hud 根节点
   * @param {import('../core/game.js').Game} game
   * @param {typeof import('./settings.js').DEFAULT_SETTINGS} settings 生效中的设置（resolveSettings 结果）
   */
  constructor(root, game, settings) {
    this.game = game;
    this.settings = settings;
    this.root = root;
    ensureStyle();

    // M9：创造台面板状态 + toast 实例。⚠️ 字段名是 **this.game**（既有构造存的），不是
    // this._game —— 所有调用一律用 this.game。
    // 初值取服务真实状态（reload 后创造台可能已从锚点恢复 → 按钮须显示「关闭创造台」）。
    this._playgroundActive = game.playground?.isActive() ?? false;
    /** 防重复点击锁（mc-lite isPlaygroundOperationInProgress 同手法）：2916 格写入是秒级操作，
     *  重复点击会产出两个平台或半删状态 */
    this._playgroundBusy = false;
    /** 进度导入/导出的防重复锁。**故意与 _playgroundBusy 分开**：导入进度要读文件 + 写整库，
     *  共用一把锁会让模型导入/导出被进度操作吞掉（反之亦然） */
    this._progressBusy = false;
    /** toast 实例（⚠️ 必须真的赋值，否则 this._toast?.show(...) 静默不显示 → 规格 §3 验收项落空） */
    this._toast = new Toast({});

    // ⚙ 按钮（mc-lite #settings-btn：常驻右上、hover 提亮；坐标 HUD 下方避让）
    this.btn = document.createElement('div');
    this.btn.id = 'settings-btn';
    this.btn.textContent = '⚙';
    this.btn.addEventListener('click', () => this.toggle());
    root.appendChild(this.btn);

    // 模态框（display none/flex 切换，isOpen 依赖该口径）
    this.el = document.createElement('div');
    this.el.id = 'settings-modal';
    this.el.style.display = 'none';
    const box = document.createElement('div');
    box.className = 'mc-content';
    const h2 = document.createElement('h2');
    h2.textContent = '游戏设置';
    box.appendChild(h2);
    this.el.appendChild(box);
    root.appendChild(this.el);
    // 点击遮罩关闭（mc-lite settingsModal.onclick 语义）
    this.el.addEventListener('click', (e) => { if (e.target === this.el) this.close(); });

    // 两列盒（mc-lite `.settings-columns`）。分配按「档位数 + 文案长度」排：
    // 左列吃两组两按钮档位（合并盒）+ 四档风格；右列吃三档视距/帧预算 + 世界操作。
    // 后续新配置优先往右列填（右列纵向余量更大），避免继续增高左列。
    const columns = document.createElement('div');
    columns.className = 'mc-columns';
    const left = document.createElement('div');
    const right = document.createElement('div');
    left.className = right.className = 'mc-column';
    columns.appendChild(left);
    columns.appendChild(right);
    box.appendChild(columns);

    left.appendChild(this._combinedBlurGunDamage()); // 画质 + 枪械破坏共用一行
    left.appendChild(this._rowVisualStyle());
    // v1.98：雾色 + 背景音乐合并为一行（用户 2026-10-31：「做成跟画质+枪械破坏这部分一样
    // 的按钮排布，放到一行里，分左右两部分，一块两个按钮」）—— 两组都是两按钮开关、同属
    // 「氛围」，合并后左列少一行。
    left.appendChild(this._combinedFogMusic());
    left.appendChild(this._rowTeleport());           // v1.92：瞬移（用户要求在背景音乐下面）
    right.appendChild(this._combinedViewDistanceResolution()); // 视距 + 分辨率共用一行（v2.27）
    right.appendChild(this._rowBudget());
    right.appendChild(this._rowPlayground());        // M9：创造台（右列，纵向余量更大）
    // v1.98：TNT 破坏 + 进度管理合并为一行（用户同日要求，同样是为了「节省控制面板的空间」）。
    // 落位 = 原「进度管理」的位置（**创造台之后**）—— 「进度管理在创造台下方」是用户 2026-09-30
    // 明确裁定过的排布，而 TNT 破坏此前没有指定位置，故由它跟随进度这一行走。
    right.appendChild(this._combinedTntProgress());
    right.appendChild(this._rowWorld());             // 新世界 + 删除缓存共用一行

    const footer = document.createElement('div');
    footer.className = 'mc-footer';
    const closeBtn = document.createElement('button');
    closeBtn.id = 'settings-close';
    closeBtn.textContent = '确定';
    closeBtn.addEventListener('click', () => this.close());
    footer.appendChild(closeBtn);
    box.appendChild(footer);
  }

  // ---- 行构造（mc-lite .setting-item + .btn-group：标题左对齐、按钮等宽一行、选中态绿色） ----

  /**
   * 构造「标题 + 按钮组」一组档位控件。
   * `wrap` 决定宿主容器类名：`mc-item` = 独占一行；`mc-combined-col` = 塞进合并盒与另一组共用一行。
   * @param {string} title 组标题
   * @param {Array<*>} values 档位值
   * @param {Array<string>} labels 档位文案
   * @param {*} current 当前值（渲染选中态）
   * @param {(v: *) => void} onPick 选档回调
   * @param {string} [wrap='mc-item'] 宿主容器类名
   */
  _makeGroup(title, values, labels, current, onPick, wrap = 'mc-item') {
    const row = document.createElement('div');
    row.className = wrap;
    const t = document.createElement('span');
    t.className = 'mc-title';
    t.textContent = title;
    row.appendChild(t);

    const group = document.createElement('div');
    group.className = 'mc-btn-group';
    const btns = [];
    values.forEach((v, i) => {
      const b = document.createElement('button');
      b.textContent = labels[i];
      if (v === current) b.classList.add('active');
      b.addEventListener('click', () => {
        onPick(v);
        for (const bb of btns) bb.classList.remove('active');
        b.classList.add('active');
      });
      group.appendChild(b);
      btns.push(b);
    });
    row.appendChild(group);
    return row;
  }

  /** 独占一行的档位组（便捷入口） */
  _makeRow(title, values, labels, current, onPick) {
    return this._makeGroup(title, values, labels, current, onPick, 'mc-item');
  }

  /** 合并盒：把两组档位塞进同一行（mc-lite `.setting-combined-item` 同款） */
  _makeCombined(groups) {
    const box = document.createElement('div');
    box.className = 'mc-combined';
    const grid = document.createElement('div');
    grid.className = 'mc-combined-box';
    box.appendChild(grid);
    for (const g of groups) grid.appendChild(g);
    return box;
  }

  _rowViewDistance(wrap = 'mc-item') {
    // 视距改动 → 持久化 + 带参重载（BatchedMesh maxInstances 构造期固定，不支持运行时扩容）。
    // 面板只留 3 档（省版面），其余档仍可达：`?vd=` URL 与旧存档 → clampVD(2~16)。
    // 当前值不在档位内（如 URL 带 vd=4）时无按钮高亮 —— 档位是「快捷选择」而非全集，
    // 刻意不做「就近高亮」（那会让按钮宣称了一个非生效值）。
    // v2.27：与「分辨率」共用合并盒（`mc-combined-col`）— 两栏各自最多 3 个按钮，
    // 列宽 375px 下每个约 55px，三字文案「视距」同字宽的数字都没问题。
    return this._makeGroup('视距', VIEW_DISTANCE_OPTIONS,
      VIEW_DISTANCE_OPTIONS.map(String), this.settings.viewDistance,
      (v) => {
        this.settings.viewDistance = v;
        this._save();
        this.game.applyViewDistance(v); // 重载生效
      }, wrap);
  }

  /**
   * v2.27：「分辨率」两档（清晰 / 性能）。
   *
   * **清晰 = `devicePixelRatio` 原值**（= 本次改动前的观感，零回归）；
   * **性能 = dpr × 0.5**（像素量 1/4）。换算口径在 `render/pixel-ratio.js`（红线 1）。
   *
   * ⚠️ **不重载页面**：像素比只是 drawing buffer 的物理尺寸，`renderer.setPixelRatio()`
   * 会自己重建后备缓冲（`applyViewDistance`/`setBlurQuality` 必须重载是另一回事 ——
   * 它们要重建 BatchedMesh 容量与 mip 链）。故这里直接调 `game.setPixelRatioMode()`
   * 并**把档位写回 `this.settings`**（两者缺一都是静默失效：只写设置不调 game → 画面不变；
   * 只调 game 不写设置 → 面板下次打开/重载后又是一个值）。
   */
  _groupResolution() {
    return this._makeGroup(RESOLUTION_ROW_TITLE, PIXEL_RATIO_MODE_OPTIONS, RESOLUTION_LABELS,
      this.settings.pixelRatio,
      (v) => {
        this.settings.pixelRatio = this.game.setPixelRatioMode(v);
        this._save();
      }, 'mc-combined-col');
  }

  /** v2.27：视距 + 分辨率共用一个合并盒（用户 2026-11-03 指定「视距这一排改为两列」） */
  _combinedViewDistanceResolution() {
    return this._makeCombined([
      this._rowViewDistance('mc-combined-col'),
      this._groupResolution(),
    ]);
  }

  _groupBlur() {
    return this._makeGroup('画质（远处纹理）', [false, true], ['像素风', '平滑'],
      this.settings.blur,
      (v) => {
        this.settings.blur = v;
        this._save();
        this.game.setBlurQuality(v); // 重载生效（纹理 mip level 创建期固定）
      }, 'mc-combined-col');
  }

  // 枪械破坏开关：对齐 mc-lite `UIManager.js:160` 的「枪械破坏」开/关两按钮
  // （`game.canGunsDestroyBlocks` + HUD 提示）。mc-heavy 走既有 API
  // `game.setGunBlockDamage(enabled)`（M4 规格 §4.4：面板直接绑定该 API），默认 false。
  // MAG7 不受此开关限制（weapon-controller 语义），无需在此区分。
  _groupGunDamage() {
    return this._makeGroup('枪械破坏', [false, true], ['关闭', '开启'],
      this.settings.gunBlockDamage,
      (v) => {
        this.settings.gunBlockDamage = v;
        this._save();
        this.game.setGunBlockDamage(v); // 委派 player→weaponController.setBlockDamage
      }, 'mc-combined-col');
  }

  // 画质与枪械破坏都是两按钮档位，各占一行浪费版面 → 合并盒共用一行（mc-lite 同手法）。
  _combinedBlurGunDamage() {
    return this._makeCombined([this._groupBlur(), this._groupGunDamage()]);
  }

  /**
   * 环境风格：自动 / 早晨 / 正午 / 傍晚 / 黑夜（v1.71 新增傍晚，用户指定放在正午右边）。
   *
   * ⚠️ 文案顺序必须与 `VISUAL_STYLE_OPTIONS` **逐项对齐**（`_makeGroup` 按下标取值）；
   * 单测钉的是「傍晚下标 = 正午下标 + 1」这条关系，加档位时不必改断言。
   * ⚠️ **不改「自动」按钮**：它同时是 `daynight.setStyle(null)`（恢复日夜循环）的唯一 UI 入口。
   */
  _rowVisualStyle() {
    return this._makeRow('环境风格', VISUAL_STYLE_OPTIONS, ['自动', '早晨', '正午', '傍晚', '黑夜'],
      this.settings.visualStyle,
      (v) => {
        this.settings.visualStyle = v;
        this._save();
        this.game.setVisualStyle(v); // null = 恢复日夜循环（M2-6）
      });
  }

  /**
   * v1.59：「雾色」开关 —— 雾色不再是固定 0x87ceeb，而是沿视线方向采样天空盒。
   *
   * 默认**开**（用户 2026-10-25 裁定：「游戏启动的时候默认就开启『雾色』按钮」）。
   * v1.59 交付时默认关是「默认值 = 旧行为」的口径；实玩后改为默认开 —— 天空盒一开，固定
   * 0x87ceeb 的远景就与照片天空对不上（实测 R 差 54）。**关**的路径完整保留（本行「关闭」按钮
   * 与 `?fog=0`），关闭时走 `mix()` 插值逐位回到 v1.58 的固定色。
   * 落位 = **左列，紧跟「环境风格」**（用户 2026-10-21 指定，同属「画面观感」）；
   * v1.98 起与「背景音乐」共用**合并盒**（左半），次序仍是「环境风格 → 雾色+背景音乐」。
   * ⚠️ **不改「自动」按钮**：它同时是 `daynight.setStyle(null)`（恢复日夜
   * 循环）的唯一 UI 入口，且被 `sun-shadow.spec` / `daynight-visual.spec` 的
   * `setVisualStyle(null)` 用例依赖 —— 替掉它会让日夜循环失去入口。
   *
   * ⚠️ **不制造「无效开关」**：`?skybox=0` 或天空盒加载失败时没有立方图可采样，
   * `setFogColorEnabled()` 会返回 false。那种情况下整组按钮**置灰禁用**并给 title 说明，
   * 否则玩家按下去看不到任何变化，会误以为功能坏了。
   * ⚠️ 判据用 `game.sky`（运行时真实状态）而不是 `?skybox` URL 参数 —— 加载失败也走降级路径。
   */
  _rowFogColor(wrap = 'mc-item') {
    const row = this._makeGroup('雾色', [false, true], ['关闭', '开启'],
      this.settings.fogColor,
      (v) => {
        this.settings.fogColor = v;
        this._save();
        this.game.setFogColorEnabled(v); // 开启需天空盒；无天空盒时静默保持关
      }, wrap);
    if (!this.game.sky) {
      for (const b of row.querySelectorAll('button')) {
        b.disabled = true;
        b.title = '需要开启天空盒';
      }
    }
    return row;
  }

  /**
   * v1.63：「背景音乐」开关（mc-lite `Player.js:296` 的 `playBGM('bgm', 0.15)`，循环单曲）。
   *
   * ⚠️ **落位 = 左列（雾色右侧的合并盒右半）**，不是右列 —— 与 CLAUDE.md「新配置往右列填」
   * 的表面口径相反，因为那条约束的**适用前提已经变了**：它当初的理由是「左列被两组合并盒 + 四档
   * 风格撑高，右列余量更大」。v1.63 实测把本行单独加在右列：面板 653px、内容 706px > 可视
   * 645px → 出现纵向滚动，「世界」行被裁到折线以下。判断依据是该约束的**意图**（不抬高面板），
   * 不是它的字面。
   *
   * ⚠️ **不置灰**（与雾色相反）：本开关即使 preload 失败 / 无音频设备也能点 —— 它只记意图，
   * 解码完成与用户手势到位后自动起播。按「异步条件未就绪就置灰」得等到 4MB 解码完才能
   * 解除，反而是永久错的初始态。
   * 默认开（面板首次打开即高亮「开启」）；关闭立即停播，重开继续。
   */
  _rowMusic(wrap = 'mc-item') {
    return this._makeGroup('背景音乐', [false, true], ['关闭', '开启'],
      this.settings.bgm,
      (v) => {
        this.settings.bgm = v;
        this._save();
        this.game.setMusicEnabled(v); // 开启后靠 preload/unlock 两个条件自动起播
      }, wrap);
  }

  /**
   * v1.98：「雾色 + 背景音乐」合并盒（用户 2026-10-31：「做成跟画质+枪械破坏这部分一样的
   * 按钮排布，放到一行里，分左右两部分，一块两个按钮」）。
   *
   * 两组都是「两个按钮 + 持久化 + 运行时即时生效」的开关，且同属「氛围」，合在一行与
   * 画质+枪械破坏那一盒同构（`_makeCombined` 同一份实现 → `.mc-combined-box` 两列 grid）。
   * ⚠️ **雾色那一组的置灰逻辑必须跟着搬进合并盒**：`_rowFogColor` 的 wrap 参数就是为了这个
   * —— 没有天空盒时它得把**自己那两按钮**禁用，不能因为换了容器就丢掉（丢掉的形态是
   * 「?skybox=0 下按了没反应」，静默失效）。
   */
  _combinedFogMusic() {
    return this._makeCombined([
      this._rowFogColor('mc-combined-col'),
      this._rowMusic('mc-combined-col'),
    ]);
  }

  /**
   * v1.92：「瞬移」行（用户 2026-10-29 需求：「在背景音乐下面增加一排按钮，这个区域的功能
   * 就是瞬移」）。
   *
   * 四个按钮都是**动作型**（点一下执行一次），不是档位开关 —— 所以不用 `_makeRow`
   * （它按 `values` 渲染 `.active` 选中态），而是照 `_rowWorld` 的手法自己拼按钮组：
   * 动作按钮没有「当前值」，渲染选中态会让玩家以为有持久状态。
   *
   * ⚠️ **落位 = 左列（背景音乐右侧的合并盒右半）**，用户说的是「在背景音乐下面」：
   * v1.98 把雾色+背景音乐合并成一行后，本行落在那个合并盒**下方**，仍在左列。
   *
   * ⚠️ **业务逻辑一律在 Game**（`teleportToTarnZone` / `markPosition` / `teleportToMark` /
   * `teleportToSpawn` / `teleportToArena`（围场）/ `teleportToBurningArena`（大竞技场）/
   * `teleportToShallowTarn`）：面板只做 DOM 与文案。
   * 散落进来的话要 import voxel/gen 层，违反依赖方向（§3）。
   *
   * ⚠️ **七个按钮共享 `.mc-btn-group` 的 `flex:1`** → 同一行、等宽。行数上限取决于左列宽度
   * （实测 375px）：**五个按钮时每只 69px，六个时只剩 56px**（`clientWidth` 52、
   * 扣掉 `padding:6px 4px` 后内容宽 **44px**）⇒ 12px 字号下**最多 3 个字**（36px）。
   * 第四个按钮的「跳转标记」就是被这一条逼成「跳转」的（v2.19 用户裁定），
   * 四字在 56px 按钮里会折行（实测按钮高 33→50px）。
   *
   * ⚠️ **v2.87 加到七个按钮后，本行的 `gap` 从 8px 收到 4px**（`.mc-teleport .mc-btn-group`）：
   * 7 个按钮 + 6×8px 间距 ⇒ 每只 46.7px、内容宽 34.7px < 3 字（36px）⇒ **三字也会折行**；
   * 收到 4px 后每只 50.1px、内容宽 38.1px ⇒ 三字单行放得下。
   *
   * ⚠️ **v2.89 加到八个按钮后，文案上限降到 2 字**（实测）：每只 43.4px、文字可用 31.4px，
   * 3 字（36px）仍折行（按钮高 33→50px），即使 `gap` 收到 0px 也只有 34.9px ⇒ 无解。
   * 故「竞技场」缩为「竞技」（用户 2026-11-10 裁定），其余按钮本就 ≤ 2 字。
   * `teleport.spec` 用 `offsetTop` 钉「不得换行」、用**行盒数**钉「文案不得折行」
   * （`scrollWidth <= clientWidth` 对折行无判别力——折行时两者依然相等，v2.19 实测）。
   *
   * **按钮顺序 = 用户指定**：v2.10（2026-10-29）「标记，跳转标记，回家，高台，竞技场」，
   * v2.19（2026-10-30）在本行末尾追加「湖」（浅水高台），
   * v2.87（2026-11-09）把原「竞技场」改名为「围场」、并在其后新增指向**大竞技场**的「竞技」，
   * v2.89（2026-11-10）在末尾追加「堡垒」（城西废弃堡垒）。
   * 前三个是「标记相关的三连」（记录 → 跳回 → 回家），后五个是「去某个地标」
   * （高台 / 围场 / 竞技 / 湖 / 堡垒），不要按「先地标后标记」的习惯改回去 ——
   * 那是上一版（v1.92）的顺序，用户明确重排了。
   *
   * ⚠️ **六个「跳转」按钮成功后自动关面板**（v2.28，用户 2026-10-30：「点击其他的按钮完成跳转后，
   * 100ms 后把设置面板关掉，自动进入游戏」）：面板一关就解除模态，`player.update` 恢复 → 相机
   * 跟上新位置。**「标记」是唯一的例外** —— 它不跳转（只记录当前位置），关面板会让玩家莫名
   * 回到游戏而坐标提示一闪而过。收尾统一走 `_teleportThenAutoClose()`，不要在按钮里各写一份
   * `setTimeout`。
   */
  _rowTeleport() {
    const row = document.createElement('div');
    row.className = 'mc-item mc-teleport';
    const t = document.createElement('span');
    t.className = 'mc-title';
    t.textContent = TELEPORT_ROW_TITLE;
    row.appendChild(t);

    const group = document.createElement('div');
    group.className = 'mc-btn-group';
    row.appendChild(group);

    const mk = (label, id, run) => {
      const b = document.createElement('button');
      b.id = id;
      b.textContent = label;
      b.addEventListener('click', run);
      group.appendChild(b);
      return b;
    };

    // ① 标记（记下当前位置）
    mk(TELEPORT_MARK_LABEL, 'btn-mark-position', () => {
      const r = this.game.markPosition();
      this._toast?.show(this._teleportMessage(r), TELEPORT_TOAST_MS);
    });

    // ② 跳转（瞬移到标记点）
    mk(TELEPORT_GO_LABEL, 'btn-teleport-mark', () => {
      this._teleportThenAutoClose(this.game.teleportToMark());
    });

    // ③ 回家（回到 City 出生点）
    mk(TELEPORT_HOME_LABEL, 'btn-teleport-home', () => {
      this._teleportThenAutoClose(this.game.teleportToSpawn());
    });

    // ④ 高台（最近的高台地带边缘）
    mk(TELEPORT_TARN_LABEL, 'btn-teleport-tarn', () => {
      this._teleportThenAutoClose(this.game.teleportToTarnZone());
    });

    // ⑤ 围场（城南门外的草地竞技场 = 原「小竞技场」，v2.10 新增、v2.87 由「竞技场」改名）
    //    ⚠️ id 仍是 `btn-teleport-arena`：与 `Game.teleportToArena` / `computeArenaAnchor` 同一族
    //    技术命名，改 id 会连带改 E2E 选择器而玩家看不到任何差别。
    mk(TELEPORT_ENCLOSURE_LABEL, 'btn-teleport-arena', () => {
      this._teleportThenAutoClose(this.game.teleportToArena());
    });

    // ⑥ 竞技场（**大竞技场** = 城东沙漠的 burning arena，v2.87 新增）
    //    落点 = 占地西缘外的沙漠平地（唯一权威 `burningArenaTeleportPoint`，在 Game 侧消费）
    mk(TELEPORT_ARENA_LABEL, 'btn-teleport-burning-arena', () => {
      this._teleportThenAutoClose(this.game.teleportToBurningArena());
    });

    // ⑦ 湖（浅水高台，v2.19 新增）
    mk(TELEPORT_LAKE_LABEL, 'btn-teleport-lake', () => {
      this._teleportThenAutoClose(this.game.teleportToShallowTarn());
    });

    // ⑧ 堡垒（**废弃堡垒** = 城西干燥沙漠的 ruined citadel，v2.89 新增）
    //    落点 = 占地东缘外的沙漠平地（唯一权威 `ruinedCitadelTeleportPoint`，在 Game 侧消费）
    mk(TELEPORT_CITADEL_LABEL, 'btn-teleport-ruined-citadel', () => {
      this._teleportThenAutoClose(this.game.teleportToRuinedCitadel());
    });

    // ⑨ 要塞（**丛林要塞** = 城西第一个丛林地带的 jungle fortress，v3.13 新增）
    //    落点 = 占地东缘外的**整形后**平地（唯一权威 `jungleFortressTeleportPoint`）
    mk(TELEPORT_JUNGLE_LABEL, 'btn-teleport-jungle-fortress', () => {
      this._teleportThenAutoClose(this.game.teleportToJungleFortress());
    });

    return row;
  }

  /**
   * 瞬移按钮的统一收尾：先给 toast，**成功**则 `TELEPORT_AUTO_CLOSE_MS` 后自动关面板回游戏。
   *
   * ⚠️ **只有 `ok === true` 才关面板**：失败（`no-mark` / `no-arena` / `no-burning-arena` /
   * `no-lake` / `not-found`）
   * 都要求玩家换个按钮或走远点再试，自动关掉只会逼他再按一次 ⚙ 把面板打开。
   *
   * ⚠️ **业务逻辑仍在 `Game`**（这里只消费它的返回值），与 `_teleportMessage` 同一口径 ——
   * 面板不 import voxel/gen 层（依赖方向 §3）。
   *
   * ⚠️ **延迟关闭前重判 `isOpen`**：玩家完全可能在 100ms 内自己点了「关闭」或按了 Esc ——
   * 那时不必再 `requestPointerLock` 一次（`close()` 虽然幂等，但会重复申请指针锁）。
   *
   * @param {{ok: boolean, reason?: string, kind?: string, x?: number, y?: number, z?: number, dist?: number}} r
   *   `Game` 的瞬移返回值（七个入口同一形状）
   */
  _teleportThenAutoClose(r) {
    this._toast?.show(this._teleportMessage(r), TELEPORT_TOAST_MS);
    if (!r?.ok) return;
    setTimeout(() => {
      // 面板可能已经被玩家自己关掉，或者本项目被销毁（页面卸载）——两种情况都不该再动指针锁
      if (this.isOpen) this.close();
    }, TELEPORT_AUTO_CLOSE_MS);
  }

  /**
   * 把 `Game` 的瞬移返回值翻成玩家可读文案（单一口径：八个按钮共用一份映射）。
   *
   * ⚠️ **成功分支按 `kind` 区分，不得靠嗅探字段**：v1.92 原实现是「有 dist 就是高台、
   * 有 y 就是记录」，加入「回家」后它同样带 x/y/z 但**没有** dist → 会被写成「已记录位置」
   * （玩家以为按错了按钮）。故 Game 侧给四个入口都打上 `kind`，这里按它 switch。
   *
   * ⚠️ **失败分支必须各有独立文案**：`no-mark`（还没标记）与 `not-found`（范围内没有
   * 高台地带）是两种完全不同的处境，合成一句「操作失败」玩家无从判断下一步做什么。
   * 围场的 `no-arena` 与大竞技场的 `no-burning-arena` 同理分开（v2.87），
   * 废弃堡垒的 `no-ruined-citadel` 又是一种（v2.89）。
   *
   * ⚠️ **toast 文案用全名「竞技场」而按钮用「竞技」**：按钮受布局约束（8 个按钮后
   * 3 字会折行，用户 2026-11-10 裁定缩为 2 字），而 toast 不受宽度约束 ⇒ 用全名更清楚。
   * `tests/teleport.spec.mjs` 钉的是 toast 文案（`/已瞬移到竞技场/`），改按钮文案不会弄红它。
   * @param {{ok: boolean, kind?: string, reason?: string, x?: number, y?: number, z?: number, dist?: number}} r
   * @returns {string}
   */
  _teleportMessage(r) {
    if (r.ok) {
      switch (r.kind) {
        case 'tarn': return `已瞬移到高台地带（${r.dist} 格外）`;
        case 'mark': return `已记录位置：${r.x}, ${r.y}, ${r.z}`;
        case 'mark-go': return `已跳转到标记位置：${r.x}, ${r.y}, ${r.z}`;
        case 'spawn': return `已回到出生点：${r.x}, ${r.y}, ${r.z}`;
        case 'arena': return `已瞬移到围场：${r.x}, ${r.y}, ${r.z}`;
        case 'burning-arena': return `已瞬移到竞技场：${r.x}, ${r.y}, ${r.z}`;
        case 'ruined-citadel': return `已瞬移到堡垒：${r.x}, ${r.y}, ${r.z}`;
        case 'jungle-fortress': return `已瞬移到丛林要塞：${r.x}, ${r.y}, ${r.z}`;
        case 'lake': return `已瞬移到浅水高台：${r.x}, ${r.y}, ${r.z}`;
        // 未打 kind 的返回值（将来新增入口忘了打）也不得静默变成空提示
        default: return `已完成：${r.x}, ${r.y}, ${r.z}`;
      }
    }
    switch (r.reason) {
      case 'no-player': return '玩家尚未就绪';
      case 'not-found': return '附近范围内没有找到高台地带';
      case 'no-mark': return '尚未标记位置';
      case 'no-arena': return '这个世界里没有生成围场';
      case 'no-burning-arena': return '这个世界里没有生成竞技场';
      case 'no-ruined-citadel': return '这个世界里没有生成堡垒';
      case 'no-jungle-fortress': return '这个世界里没有生成丛林要塞';
      case 'no-lake': return '这个世界里没有生成浅水高台';
      default: return '操作失败';
    }
  }

  _rowBudget() {
    return this._makeRow('帧预算', ['auto', 'high', 'low'], ['自动', '120Hz 档', '60Hz 档'],
      this.settings.budgetProfile,
      (v) => {
        this.settings.budgetProfile = v;
        this._save();
        this.game.budget.setProfile(v); // M3-2 手动覆盖
      });
  }

  /**
   * M8：「TNT 破坏」开关（mc-lite `UIManager.js` 的「TNT 破坏」两按钮档位，
   * `game.canTntDestroyBlocks`）。mc-heavy 走 `game.setTntBlockDamage(enabled)`，默认 false
   * （mc-lite `Game.js:92` 同口径：默认只伤害 + 连锁、不动地形）。
   *
   * ⚠️ **落位 = 右列（v1.98 起与「进度管理」共用合并盒的左半）**。v1.98 之前的落位理由「单组
   * 不进合并盒」已**因用户新要求失效**（2026-10-31：「同样的处理方式，也处理一下 TNT 破坏和
   * 进度管理」）—— 那两条（合并盒已满 / 单组不适用）都是**当时**的档位状态，现在要合的是
   * 两组、各两个按钮，与画质+枪械破坏那一盒完全同构。
   * ⚠️ 「TNT 破坏」是面板里最长的组标题（6 字符 + 空格）—— 合并盒列宽约 171px 刚好容下；
   * 往后改这个标题文案先量 `scrollWidth ≤ clientWidth`（超出会顶开列宽、面板跟着变宽）。
   */
  _rowTntDamage(wrap = 'mc-item') {
    return this._makeGroup('TNT 破坏', [false, true], ['关闭', '开启'],
      this.settings.tntDamage,
      (v) => {
        this.settings.tntDamage = v;
        this._save();
        this.game.setTntBlockDamage(v); // 委派 game.canTntDestroyBlocks（爆炸破坏事务的门控）
      }, wrap);
  }

  /**
   * v1.98：「TNT 破坏 + 进度管理」合并盒（用户 2026-10-31：「同样的处理方式，也处理一下
   * 【TNT破坏】和【进度管理】，其中进度管理里的两个按钮分别改名为【导入】和【导出】」）。
   *
   * 改名不是审美选择，是**布局的必然**：合并后每组只剩约 171px 列宽（`_combinedBlurGunDamage`
   * 实测同构盒的每组宽度）， 两按钮各约 81px 且还要摊 4px 间隙与斜角边框 ——
   * 「导入进度」「导出进度」四个字正好贴边；「导入 / 导出」与同盒的「关闭 / 开启」节奏一致。
   * 代价：文案不再自带「进度」二字 → 归属靠**组标题「进度管理」**表达（与「导出模型 / 导入模型」
   * 靠「创造台」标题区分是同一手法）。
   */
  _combinedTntProgress() {
    return this._makeCombined([
      this._rowTntDamage('mc-combined-col'),
      this._rowProgress('mc-combined-col'),
    ]);
  }

  /**
   * 「世界」组：新世界 + 删除缓存**两个破坏性/不可逆操作共用一行**（省版面），
   * 二者语义区别落在下方一行小字说明里。
   *
   * - 新世界（`Game.newWorld`）：**换 seed**（离开旧世界）+ 清 edits + 写回 meta + 重载；
   * - 删除缓存（`Game.clearSave`）：**保留 seed** + 清 edits + 重载 → 回到同一世界的
   *   未修改原始版本（红线 2：地形只由 seed 决定，edits 是叠加层）。
   * 两者都不动 localStorage 设置。
   *
   * 二次确认（armed 态）：破坏性操作单击即执行会让误触毁掉存档。第一次点击只把
   * 按钮切到「确认删除」，第二次才执行；打开面板时复位，避免确认态跨会话残留。
   */
  _rowWorld() {
    const row = document.createElement('div');
    row.className = 'mc-item mc-world';
    const t = document.createElement('span');
    t.className = 'mc-title';
    t.textContent = '世界';
    row.appendChild(t);

    const group = document.createElement('div');
    group.className = 'mc-btn-group';
    row.appendChild(group);

    const newWorld = document.createElement('button');
    newWorld.id = 'btn-new-world';
    newWorld.textContent = '新世界';
    newWorld.addEventListener('click', () => this.game.newWorld(null)); // null = 随机 seed
    group.appendChild(newWorld);

    const clear = document.createElement('button');
    clear.id = 'btn-clear-save';
    clear.className = 'danger';
    clear.textContent = CLEAR_SAVE_LABEL;
    this._clearBtn = clear;
    clear.addEventListener('click', () => {
      if (!clear.classList.contains('armed')) {
        clear.classList.add('armed');
        clear.textContent = '确认删除？再点一次';
        return;
      }
      this.game.clearSave(); // 重载：edits 清空 + seed/设置保留
    });
    group.appendChild(clear);

    const hint = document.createElement('span');
    hint.className = 'mc-hint';
    hint.textContent = `新世界：换随机种子｜删除缓存：清除方块改动、保留当前种子（seed ${this.game.seed}）`;
    row.appendChild(hint);
    return row;
  }

  /**
   * v1.43：创造台行 —— **单行**按钮盒（用户要求 2026-09-30）。
   *
   * 未激活：只有「打开创造台」，凭基线 `#settings-modal button { flex: 1 }` **独占整行**。
   * 已激活：「导出模型 / 导入模型」转为可见 → 三个按钮 flex:1 平分该行。
   *
   * ⚠️ 模型两个按钮**必须与主按钮同处一个 `.mc-btn-group`**，不得另起一行也不得给主按钮
   * 变窄 —— 这正是用户明确要求的形态（「挤占原来打开创造台按钮的长度」）。
   *
   * ⚠️ **三处必须一起做**（缺一处即构造期 TypeError 或功能落空）：
   * ① 主按钮 onclick → _onPlaygroundToggle；② 导出/导入 onclick → _onExport/_onImport
   * （都必须定义，被调用但从未定义会 TypeError）；③ 末尾调 _syncPlaygroundVisibility
   * 设初始可见性（构造时 _playgroundActive 可能已是 true —— reload 恢复的场景）。
   */
  _rowPlayground() {
    const row = document.createElement('div');
    row.className = 'mc-item mc-playground';
    const t = document.createElement('span');
    t.className = 'mc-title';
    t.textContent = PLAYGROUND_ROW_TITLE;
    row.appendChild(t);

    const group = document.createElement('div');
    group.className = 'mc-btn-group mc-playground-buttons';
    row.appendChild(group);

    // 主按钮（两态）：文案取导出常量（单一口径）
    this._playgroundBtn = document.createElement('button');
    this._playgroundBtn.id = 'btn-playground';
    this._playgroundBtn.addEventListener('click', () => this._onPlaygroundToggle());
    group.appendChild(this._playgroundBtn);

    // 导出 / 导入模型：仅创造台激活时可见（mc-lite style.display 同手法），与主按钮同一行
    this._exportBtn = document.createElement('button');
    this._exportBtn.id = 'btn-playground-export';
    this._exportBtn.textContent = EXPORT_LABEL;
    this._exportBtn.addEventListener('click', () => this._onExport());
    group.appendChild(this._exportBtn);

    this._importBtn = document.createElement('button');
    this._importBtn.id = 'btn-playground-import';
    this._importBtn.textContent = IMPORT_LABEL;
    this._importBtn.addEventListener('click', () => this._onImport());
    group.appendChild(this._importBtn);

    this._syncPlaygroundVisibility();   // 初始可见性（构造时可能已激活）
    return row;
  }

  /**
   * v1.43：进度管理行 —— 导入 / 导出进度（整世界存档）。
   *
   * **功能域与创造台分开**（用户要求，2026-09-30）：创造台管平台与模型，进度管整个世界的
   * 存档，两者靠各自的组标题区分。v1.98 起与「TNT 破坏」共用合并盒（右半），但仍不并入
   * 创造台那一行。两个按钮**常驻可见**（与创造台是否激活无关）。
   *
   * ⚠️ 两个按钮必须都在 `_onImportProgress`/`_onExportProgress` 上绑定（未定义即 TypeError）。
   * ⚠️ **动作型按钮不进 `_makeGroup`/`_makeRow`**：它们按 `values` 渲染 `.active` 选中态，
   * 而导入/导出没有「当前值」—— 渲染选中态会让玩家以为有持久状态（同 `_rowTeleport` 的判据）。
   * 故标题与按钮组都自己拼，只保留调用方给的 `wrap` 容器类。
   */
  _rowProgress(wrap = 'mc-item') {
    const row = document.createElement('div');
    row.className = wrap;
    const t = document.createElement('span');
    t.className = 'mc-title';
    t.textContent = PROGRESS_ROW_TITLE;
    row.appendChild(t);

    const group = document.createElement('div');
    group.className = 'mc-btn-group mc-progress-buttons';
    row.appendChild(group);

    this._progressImportBtn = document.createElement('button');
    this._progressImportBtn.id = 'btn-progress-import';
    this._progressImportBtn.textContent = PROGRESS_IMPORT_LABEL;
    this._progressImportBtn.addEventListener('click', () => this._onImportProgress());
    group.appendChild(this._progressImportBtn);

    this._progressExportBtn = document.createElement('button');
    this._progressExportBtn.id = 'btn-progress-export';
    this._progressExportBtn.textContent = PROGRESS_EXPORT_LABEL;
    this._progressExportBtn.addEventListener('click', () => this._onExportProgress());
    group.appendChild(this._progressExportBtn);

    return row;
  }

  /** 主按钮文案随状态切换 + 导出/导入可见性同步（两态文案都用导出常量，不写字面量） */
  _syncPlaygroundVisibility() {
    this._playgroundBtn.textContent =
      this._playgroundActive ? PLAYGROUND_CLOSE_LABEL : PLAYGROUND_OPEN_LABEL;
    const vis = this._playgroundActive ? '' : 'none';
    this._exportBtn.style.display = vis;
    this._importBtn.style.display = vis;
  }

  /**
   * 「创造台」主按钮：未激活 → 生成；已激活 → 关闭。
   * ⚠️ **防重复点击锁**（mc-lite isPlaygroundOperationInProgress 同手法）：2916 格写入是
   * 秒级操作，重复点击会产出两个平台或半删状态。busy 期间 disabled 且直接 return。
   */
  _onPlaygroundToggle() {
    if (this._playgroundBusy) return;
    this._playgroundBusy = true;
    this._playgroundBtn.disabled = true;
    try {
      const result = this._playgroundActive ? this.game.closePlayground() : this.game.createPlayground();
      if (result.ok) {
        this._playgroundActive = !this._playgroundActive;
        this._toast?.show(this._playgroundActive ? '创造台已创建' : '创造台已关闭');
      } else {
        this._toast?.show(PLAYGROUND_ERRORS[result.reason] ?? `操作失败：${result.reason}`);
      }
    } finally {
      this._playgroundBusy = false;
      this._playgroundBtn.disabled = false;
      this._syncPlaygroundVisibility();
    }
  }

  /** 导出模型 JSON 并触发浏览器下载（mc-lite exportModel + Blob/createObjectURL 同手法） */
  _onExport() {
    const result = this.game.playground.exportModel();   // **同步**返回（规格 §2.4）
    if (!result.ok) { this._toast?.show(PLAYGROUND_ERRORS[result.reason] ?? '导出失败'); return; }
    const blob = new Blob([result.json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'model.json';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);   // 释放（mc-lite 同手法）
    this._toast?.show(`模型导出成功（${result.blocks} 方块）`);
  }

  /** 导入模型 JSON（文件上传）。⚠️ 文件读取是异步的，须在 finally 释放 busy 锁 */
  _onImport() {
    if (this._playgroundBusy) return;
    this._playgroundBusy = true;
    const input = document.createElement('input');
    input.type = 'file'; input.accept = '.json,application/json';   // mc-lite 同手法
    input.onchange = async () => {
      try {
        const file = input.files?.[0];
        if (!file) return;
        const jsonText = await file.text();
        const result = this.game.playground.importModel(jsonText);   // **同步**返回（规格 §2.4）
        this._toast?.show(result.ok
          ? `导入完成：放置 ${result.placed}，跳过 ${result.skipped}，无效 ${result.invalid}`
          : (PLAYGROUND_ERRORS[result.reason] ?? '导入失败'));
      } finally {
        this._playgroundBusy = false;   // ⚠️ 异步读取完成才释放锁
      }
    };
    input.click();
  }

  /**
   * 导出进度：把当前世界存档（seed + 全部改动 + 持久实体）写成一个 JSON 文件下载。
   *
   * 与「导出模型」（只导创造台平台上的模型）**不是一个粒度**：本方法导的是**整世界进度**，
   * 与创造台是否存在无关，故按钮常驻可见。
   * busy 期间禁用 —— 导出要先 `flushNow` 落库，重复点击会并发写盘与造多个下载。
   * ⚠️ **不得与「×模型」共用 busy 锁**（同一个 _playgroundBusy），否则模型导入/导出的
   * 文件读取会与进度导出互相吞掉对方的操作。两种操作各用自己的锁，代价极小。
   */
  async _onExportProgress() {
    if (this._progressBusy) return;
    this._progressBusy = true;
    this._progressExportBtn.disabled = true;

    try {
      const result = await this.game.exportProgress();
      if (!result.ok) {
        this._toast?.show(`导出失败：${result.reason ?? '未知错误'}`);
        return;
      }
      const blob = new Blob([result.json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = result.filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      this._toast?.show(`进度已导出（${result.cells} 方块，${result.columns} 区块）`);
    } catch (err) {
      console.error('[progress] 导出失败', err);
      this._toast?.show(`导出失败：${err.message}`);
    } finally {
      this._progressBusy = false;
      this._progressExportBtn.disabled = false;
    }
  }

  /**
   * 导入进度：选一个 JSON 文件 → 覆盖当前世界（清空当前改动 + 写入包内容 + 重载）。
   *
   * ⚠️ 文件读取是异步的，busy 锁必须在 finally 释放（与 _onImport 同一坑）。
   * ⚠️ 成功后 `importProgress` 内部会 `location.reload()`，此处不应当依赖 reload 之后的任何状态。
   */
  _onImportProgress() {
    if (this._progressBusy) return;
    this._progressBusy = true;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = async () => {
      try {
        const file = input.files?.[0];
        if (!file) return;
        const jsonText = await file.text();
        const result = await this.game.importProgress(jsonText);
        if (result.ok) {
          this._toast?.show(`进度已导入（seed ${result.seed}，${result.cells} 方块）—— 正在重载`);
        } else {
          this._toast?.show(PROGRESS_ERRORS[result.reason] ?? `导入失败：${result.reason}`);
        }
      } catch (err) {
        console.error('[progress] 导入失败', err);
        this._toast?.show(`导入失败：${err.message}`);
      } finally {
        this._progressBusy = false;   // 异步读取完成才释放锁
      }
    };
    input.click();
  }

  /**
   * 打开面板时把创造台按钮状态同步到服务的真实状态。
   * ⚠️ **不得依赖构造期的初值** —— 面板可能在创造台创建之后才第一次打开（构造时还没创建），
   * 也可能在别处（测试 API / reload）被改动过。文案仍取导出常量（单一口径，不写字面量）。
   */
  _syncPlaygroundState() {
    this._playgroundActive = this.game.playground?.isActive() ?? false;
    this._syncPlaygroundVisibility();
  }

  /** 复位破坏性按钮的确认态（打开面板时调用，避免上次未完成的 armed 态残留） */
  _resetDangerArmed() {
    const b = this._clearBtn;
    if (!b) return;
    b.classList.remove('armed');
    b.textContent = CLEAR_SAVE_LABEL; // 与构造共用同一份文案（写两处会漂移）
  }

  _save() { saveStoredSettings(this.settings); }

  open() {
    this.el.style.display = 'flex';
    this._resetDangerArmed(); // 破坏性按钮复位，避免上次残留的 armed 态被误触
    this._syncPlaygroundState(); // M9：创造台按钮状态同步到服务真实状态
    this.game.pushModal('settings'); // M3.1 模态栈（§4.5.4）：原 uiModal=true 会与背包互踩
    this.game.player?.keys.clear(); // 打开瞬间清空按键，防 WASD 粘滞
    if (document.pointerLockElement) document.exitPointerLock();
  }

  close() {
    this.el.style.display = 'none';
    this.game.popModal('settings'); // 只移除自己的 owner，不误清背包的门控
    // pointer lock 恢复到 canvas（M3.1 与背包统一口径，§4.5.4）。
    // 注意：mc-lite 锁 document.body，本仓库必须锁 canvas——否则 Player 的
    // `document.pointerLockElement !== this.canvas` 守卫会令视角与放挖全失效。
    // 程序化 requestPointerLock 需用户手势，可能抛 SecurityError（无头环境尤甚），
    // 故 try/catch 吞掉；失败时回落到既有「点击画面重新锁定」（canvas click 入口）。
    const canvas = this.game.player?.canvas;
    if (canvas && !this.game.uiModal) {
      try { canvas.requestPointerLock(); } catch { /* 忽略：等待用户点击 */ }
    }
  }

  toggle() {
    if (this.el.style.display === 'flex') this.close();
    else this.open();
  }

  get isOpen() { return this.el.style.display === 'flex'; }
}
