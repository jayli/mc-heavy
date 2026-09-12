// src/ui/settings-panel.js — 设置面板（M3-4）
// 视觉风格照搬 mc-lite `src/style/global.css` 的设置弹窗（#settings-modal/#settings-content/
// .setting-item/.btn-group/button）：Minecraft 灰底 GUI（#c6c6c6 + 4px 深灰边 + 5px 硬黑投影）
// + 斜角浮雕按钮（左上白/右下深灰，:hover 提亮，:active 反向斜角，选中态绿色 #559944）。
// hover/active/.active 等伪类与状态类无法用 inline style 表达，故注入一次性样式表
// （组件自带样式，不依赖宿主页面；重复构造只注入一次）。
// **布局**：沿用 mc-lite 的两列盒（`.settings-columns` + `.setting-combined-item`），
// 但行列分配按 mc-heavy 当前档位需要重排（面板是后续功能的配置入口，须留扩展余量）：
// 左列 = 画质+枪械破坏合并盒 / 环境风格；右列 = 视距 / 帧预算 / 世界（新世界 + 删除缓存）。
// 档位：视距（持久化+重载生效，面板 3 档）/ 画质 blur（重载生效）/ 视觉风格（运行时即时）
// / 帧预算档位（运行时即时，M3-2）/ 枪械破坏（运行时即时）/ 世界操作（新世界 / 删除缓存）。
// 音量不入面板（默认 100% 开启，`settings.js` 仍持久化 + `?volume=` URL 可达，待音频消费方接线）。
// 打开时：退出 pointer lock + 清空按键 + game.pushModal('settings')（模态栈，M3.1 §4.5.4；
// 主循环跳过 player.update、Player keydown 守卫拦截）。关闭时 lock 回 player.canvas。
import {
  VIEW_DISTANCE_OPTIONS, VISUAL_STYLE_OPTIONS, saveStoredSettings,
} from './settings.js';

const STYLE_ID = 'mc-settings-style';
/** 「删除缓存」按钮的常态文案。复位与构造必须共用同一份 —— 写两处会漂移（红线 1 精神） */
const CLEAR_SAVE_LABEL = '删除缓存';

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
    right.appendChild(this._rowViewDistance());
    right.appendChild(this._rowBudget());
    right.appendChild(this._rowTntDamage());        // M8：TNT 破坏开关（右列独立一行）
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

  _rowViewDistance() {
    // 视距改动 → 持久化 + 带参重载（BatchedMesh maxInstances 构造期固定，不支持运行时扩容）。
    // 面板只留 3 档（省版面），其余档仍可达：`?vd=` URL 与旧存档 → clampVD(2~16)。
    // 当前值不在档位内（如 URL 带 vd=4）时无按钮高亮 —— 档位是「快捷选择」而非全集，
    // 刻意不做「就近高亮」（那会让按钮宣称了一个非生效值）。
    return this._makeRow('视距', VIEW_DISTANCE_OPTIONS,
      VIEW_DISTANCE_OPTIONS.map(String), this.settings.viewDistance,
      (v) => {
        this.settings.viewDistance = v;
        this._save();
        this.game.applyViewDistance(v); // 重载生效
      });
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

  _rowVisualStyle() {
    return this._makeRow('环境风格', VISUAL_STYLE_OPTIONS, ['自动', '早晨', '正午', '黑夜'],
      this.settings.visualStyle,
      (v) => {
        this.settings.visualStyle = v;
        this._save();
        this.game.setVisualStyle(v); // null = 恢复日夜循环（M2-6）
      });
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
   * ⚠️ **落位 = 右列独立一行（`.mc-item`），不进左列合并盒** —— 三条理由：
   * ① 左列合并盒已容纳两组（画质 + 枪械破坏 = 4 按钮），面板总宽 770px、两列各约 375px
   *    （v1.35 实测）→ 再塞第三组会让 6 按钮挤在 375px 内，文案被压缩或换行；
   * ② 「两组两按钮档位优先用合并盒」的适用前提是**有两组要合并**，TNT 破坏是单组，不适用；
   * ③ 右列纵向余量更大（CLAUDE.md「新配置往右列填」），且 TNT 破坏与「帧预算」同属运行时
   *    即时开关，语义连贯；不触碰左列合并盒 → 避开 v1.35 的 CSS 特异性陷阱
   *    （`.mc-column > :first-child` 会抹掉 `.mc-combined` 的装饰边框）。
   */
  _rowTntDamage() {
    return this._makeRow('TNT 破坏', [false, true], ['关闭', '开启'],
      this.settings.tntDamage,
      (v) => {
        this.settings.tntDamage = v;
        this._save();
        this.game.setTntBlockDamage(v); // 委派 game.canTntDestroyBlocks（爆炸破坏事务的门控）
      });
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
