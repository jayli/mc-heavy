// src/ui/settings.js — 设置合并逻辑（M3-4）：存储值 + URL 覆盖 → 生效设置
// 纯函数（无 DOM 依赖），localStorage 读写与面板 DOM 在 settings-panel.js。
// 设计文档 §9「设置持久化（画质/音量/视距）」的落点；blur 档口径见 §4.4.1。

export const STORAGE_KEY = 'mc_heavy_settings_v1';

/** 视距 UI 预设档位（§1：默认 8，架构支持 16+；面板只留 3 档以省版面，其余档走 URL） */
export const VIEW_DISTANCE_OPTIONS = [8, 12, 16];
/**
 * 视距钳制下限（架构支持的最小值，M1 测试与调试用 vd=2；**UI 预设不含**，URL 可达）。
 * 注意 clampVD 与 VIEW_DISTANCE_OPTIONS 是两套口径：前者是架构钳制范围（2~16，
 * 测试/调试依赖 vd=2、vd=4 可达），后者只是面板按钮档位。故面板须容错
 * 「当前值不在档位内」（URL 或旧存档带来的 4）—— 见 settings-panel.js `_rowViewDistance`。
 */
export const VIEW_DISTANCE_MIN = 2;
export const VIEW_DISTANCE_MAX = 16;
/**
 * 视觉风格选项（M2-6 VISUAL_STYLE_KEYS + null=日夜循环自动）。
 * v1.71：`dusk`（傍晚）插在 `noon` 右边（用户指定）。⚠️ `null` 必须留在首位 ——
 * 它是「自动（日夜循环）」的唯一 UI 入口。
 */
export const VISUAL_STYLE_OPTIONS = [null, 'morning', 'noon', 'dusk', 'night'];

/**
 * 渲染分辨率档位（v2.27，「清晰」/「性能」两按钮）。**唯一权威不在本文件** ——
 * 档位集合、倍率、下限与换算都在 `render/pixel-ratio.js`（渲染口径，面板只是消费者）。
 * 这里只 re-export 默认档，让 `DEFAULT_SETTINGS` 与面板/渲染读同一个值（红线 1）。
 */
import { DEFAULT_PIXEL_RATIO_MODE, normPixelRatioMode } from '../render/pixel-ratio.js';

export const DEFAULT_SETTINGS = {
  // 设置结构版本（不是存档 DB 版本）。每次「语义变更且旧值不可信」时 +1，并在
  // `migrateStored()` 里写一步迁移。当前：
  //   v2 = 雾色默认关 → 开（v1.78）。旧存档里的 `fogColor: false` 大多是「默认值是关时顺带
  //   落盘的假值」，而不是玩家特意关的 —— 存储层无法区分两者（见 migrateStored 注释）。
  settingsVersion: 2,
  viewDistance: 8,
  blur: false,        // §4.4.1：默认像素风（Nearest）；true = mipmap+aniso 消远处莫尔纹
  volume: 1,          // 第一阶段无音频消费方，面板接线 + 持久化先行（§9 扩展点）
  visualStyle: null,  // null = 日夜循环自动（M2-6）
  budgetProfile: 'auto', // M3-2：'auto'|'high'|'low'
  gunBlockDamage: false, // M4：普通枪是否破坏方块（mc-lite 默认关闭，UIManager.js:160）
  tntDamage: false, // M8：TNT 是否破坏地形（mc-lite `Game.js:92` 同口径默认 false —— 默认只伤害 + 连锁）
  // 雾色融入天空：默认开（用户 2026-10-25 裁定「游戏启动的时候默认就开启『雾色』按钮」）。
  // v1.59 交付时默认关是「默认值 = 旧行为」的口径（与 ?shadows=0 同源），实玩后改为默认开 ——
  // 天空盒一开，固定 0x87ceeb 的远景就与照片天空对不上（实测 R 差 54），融入天空才是正常观感。
  // 关掉的路径仍在：面板「关闭」按钮 + `?fog=0`（关闭逐位回到 v1.58 的固定色）。
  fogColor: true,
  // 环境特效（v3.26）：森林落叶 + 草地萤火虫，默认开（用户 2026-11-20 裁定）。
  // ⚠️ **不需要 settingsVersion 迁移** —— 旧存档根本没有这个字段，缺字段自然回落新默认
  // （与 `pixelRatio` / `chunkPace` 同理）。
  // 性能档自动减量由装配层按 `settings.pixelRatio` 派生粒子容量，不在本字段里表达。
  ambientFx: true,
  /**
   * 雨天光影档（v3.30，用户 2026-11-22）。默认**关**。
   *
   * 开启后：
   *   · 关掉既有的「循环雨滴」（晴雨周期），改成**持续下雨**（上游 Rain 移植）；
   *   · 地面湿滑与反光（复用既有 reflector 管线）；
   *   · 体积雾 / Bloom / 色差 / 暗角（后处理链）；
   *   · 雨声换成上游的四层雨床（+ 随机远雷）。
   *
   * ⚠️ **默认关的理由**：它引入一条后处理链（额外 6~10 个全屏 pass）与
   * 5200 根雨丝 ⇒ 有真实成本，不该默认给所有玩家。且既有 Tier 4 像素基线
   * 全部是在无后处理下标定的 ⇒ 默认开会把它们全部弄红。
   * ⚠️ **不需要 settingsVersion 迁移**：旧存档根本没有这个字段，缺字段自然回落
   * 新默认（与 pixelRatio / chunkPace / ambientFx 同理）。
   */
  stormLighting: false,
  bgm: true, // v1.63：背景音乐（默认开 = mc-lite 进游戏即播；音量固定 BGM_VOLUME 0.15，不接 volume 档）
  // 区块铺开节奏：每帧最多发布几个 section（0 = 不限）。**观感旋钮，不是性能旋钮** ——
  // 2026-10-27 实测两者帧时完全相同（p95 9.1~9.2 / 120fps），因为上传耗时本来就不是
  // 尖峰来源（p95 ≤0.2ms）。0 时一波 5 帧内 816 个 section 一起出现（「一大片同时冒出」）；
  // 2 时每 100ms 只出现约 26 个（地形逐格长出来），代价是飞过之后仍需数秒补齐。
  //
  // **默认 8（用户 2026-10-27 裁定）**：100ms 窗口内出现约 104 个 section —— 比 0 的
  // 272 明显铺开，又不至于像 1 那样追不上加载速度（实测 1 会剩 1219 个永远补不完）。
  chunkPace: 8,
  // 渲染分辨率档位（v2.27）：'sharp' = devicePixelRatio 原值（改动前观感，零回归）、
  // 'performance' = dpr × 0.5（像素量 1/4）。⚠️ **不需要 settingsVersion 迁移** ——
  // 旧存档里根本没有这个字段，缺字段自然回落新默认（与 `chunkPace` 同理）。
  // 这与 `fogColor` 那次的处境不同：那次是「默认值是关时顺带落盘的假值」，必须迁移；
  // 这次没有任何旧存档会写出 `pixelRatio`，所以迁移是多余的。
  pixelRatio: DEFAULT_PIXEL_RATIO_MODE,
};

/** 每帧上传 section 数的合法范围（0 = 不限；上限取 16 —— 再大即等同不限） */
export const CHUNK_PACE_MIN = 0;
export const CHUNK_PACE_MAX = 16;

function clampVD(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return DEFAULT_SETTINGS.viewDistance;
  return Math.max(VIEW_DISTANCE_MIN, Math.min(VIEW_DISTANCE_MAX, Math.round(n)));
}

function clampVolume(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return DEFAULT_SETTINGS.volume;
  return Math.max(0, Math.min(1, n));
}

function normStyle(v) {
  return VISUAL_STYLE_OPTIONS.includes(v) ? v : DEFAULT_SETTINGS.visualStyle;
}

function normBudget(v) {
  return (v === 'high' || v === 'low') ? v : 'auto';
}

function clampChunkPace(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return DEFAULT_SETTINGS.chunkPace;
  return Math.max(CHUNK_PACE_MIN, Math.min(CHUNK_PACE_MAX, Math.round(n)));
}

/** 分辨率档位归一化（换算口径在 render/pixel-ratio.js，这里只是再导出入口） */
function normPixelRatio(v) {
  return normPixelRatioMode(v);
}

/**
 * 旧存档迁移（就地修改 stored，返回同一对象）。
 *
 * 目前只有一步：**`fogColor` 默认关 → 开（v1.78）**。
 * ⚠️ **旧存档里的 `fogColor: false` 不能当作「玩家特意关的」**：面板每次点任一开关都会把
 * **整个设置对象** `JSON.stringify` 落盘（`saveStoredSettings(this.settings)`），所以哪怕玩家
 * 从没碰过「雾色」这一行，只要点过一次别的开关，旧存档里就带着 `false`。若尊重它，默认值翻转
 * 对**老玩家完全无效**（而这正是本次需求的对象）。故对**没有 `settingsVersion` 标记**的旧存档
 * 直接丢弃 `fogColor` 字段（随后回落新默认值开）。
 * 代价：曾**特意**关掉雾色的玩家也会被翻回开 —— 存储层分不出这两类，用户已裁定接受
 * （2026-10-25），他们只需再点一次「关闭」（下一次保存会写上新版本号，不再迁移）。
 *
 * ⚠️ 迁移写在**反序列化之后、merge 之前**，而不是在读取处加 `??`：保证 `resolveSettings` 的
 * 优先级不变（URL > 存储 > 默认），任何存档里真实存在的新版字段含义也不变。
 * @param {Object|null} stored
 * @returns {Object|null} 迁移后的对象（原地修改，也可能返回 null）
 */
export function migrateStored(stored) {
  if (!stored || typeof stored !== 'object') return stored;
  const v = Number(stored.settingsVersion);
  if (!Number.isFinite(v) || v < 2) {
    // v1 及更早（含完全没有版本号的老存档）：fogColor 的 false 不可信，丢弃以待回落新默认
    if (stored.fogColor === false) delete stored.fogColor;
    stored.settingsVersion = DEFAULT_SETTINGS.settingsVersion;
  }
  return stored;
}

/**
 * 合并生效设置：URL 参数 > 存储值 > 默认值。
 * URL 支持的键：vd / blur(0|1) / volume / style / budget / guns(0|1) / tntDamage(0|1) / fog(0|1) / bgm(0|1) /
 * chunkpace(0~16) / res(sharp|perf)（main.js 既有的 ?vd、?blur 语义保持不变，这里统一收口）。
 * 另有**不在此处收口**的 URL 开关（不走持久化，main.js 直传构造选项，见其解析处）：
 *   ?stats / ?log（DEBUG_FLAGS）、?weather（启动天气）、?seed（复现）、
 *   ?shadows=0（太阳阴影代码级开关，DR-7）。
 * @param {Object|null} stored 存储反序列化对象（可能含缺字段/脏值）
 * @param {URLSearchParams} params
 * @returns {typeof DEFAULT_SETTINGS}
 */
export function resolveSettings(stored, params) {
  const s = { ...DEFAULT_SETTINGS };
  // 旧存档迁移（在合并之前；不改优先级语义）。就地改传入对象 → 下次 `saveStoredSettings` 会把
  // 新版本号写回，迁移只跑一次。
  migrateStored(stored);
  if (stored && typeof stored === 'object') {
    if (stored.viewDistance !== undefined) s.viewDistance = clampVD(stored.viewDistance);
    if (typeof stored.blur === 'boolean') s.blur = stored.blur;
    if (stored.volume !== undefined) s.volume = clampVolume(stored.volume);
    if ('visualStyle' in stored) s.visualStyle = normStyle(stored.visualStyle);
    if (stored.budgetProfile !== undefined) s.budgetProfile = normBudget(stored.budgetProfile);
    if (typeof stored.gunBlockDamage === 'boolean') s.gunBlockDamage = stored.gunBlockDamage;
    if (typeof stored.tntDamage === 'boolean') s.tntDamage = stored.tntDamage;
    // ⚠️ **雾色恒开（v3.26）**：面板那一组已换成「萤火虫和落叶」，玩家侧再无雾色入口
    // ⇒ 存储里的 `fogColor` 不可信（旧值大多是「默认值是关时顺带落盘的假值」），不再采信。
    // `?fog=0` 的 URL 分支与 `migrateStored` 一字未动 —— Tier 4 隔离入口仍在。
    if (typeof stored.ambientFx === 'boolean') s.ambientFx = stored.ambientFx;
    if (typeof stored.stormLighting === 'boolean') s.stormLighting = stored.stormLighting;
    if (typeof stored.bgm === 'boolean') s.bgm = stored.bgm;
    if (stored.chunkPace !== undefined) s.chunkPace = clampChunkPace(stored.chunkPace);
    if (stored.pixelRatio !== undefined) s.pixelRatio = normPixelRatio(stored.pixelRatio);
  }
  if (params) {
    if (params.has('vd')) s.viewDistance = clampVD(params.get('vd'));
    if (params.has('blur')) s.blur = params.get('blur') === '1';
    if (params.has('volume')) s.volume = clampVolume(params.get('volume'));
    if (params.has('style')) s.visualStyle = normStyle(params.get('style'));
    if (params.has('budget')) s.budgetProfile = normBudget(params.get('budget'));
    if (params.has('guns')) s.gunBlockDamage = params.get('guns') === '1';
    if (params.has('tntDamage')) s.tntDamage = params.get('tntDamage') === '1';
    if (params.has('fog')) s.fogColor = params.get('fog') === '1';
    if (params.has('bgm')) s.bgm = params.get('bgm') === '1';
    // ?ambient=0|1（v3.26）：环境特效的玩家意图（**持久化**，面板同一个字段）。
    // ⚠️ 与 main.js 的构造选项 `ambient` **两条都要**：设置项是玩家意图（要落盘），
    // 构造选项是代码级隔离（不持久化，供 spec 不改存档就能关掉持续动画）；生效值取 AND。
    if (params.has('ambient')) s.ambientFx = params.get('ambient') === '1';
    // ?storm=0|1（v3.30）：雨天光影档的玩家意图（**持久化**，面板同一个字段）。
    // ⚠️ 与 main.js 的构造选项 `storm` **两条都要**（同 ?ambient 的口径）：
    // 设置项是玩家意图（要落盘），构造选项是代码级隔离（不持久化，供 spec
    // 不改存档就能关掉后处理链）；生效值取 AND。
    if (params.has('storm')) s.stormLighting = params.get('storm') === '1';
    if (params.has('chunkpace')) s.chunkPace = clampChunkPace(params.get('chunkpace'));
    // ?res=sharp|perf 分辨率档位（v2.27）。⚠️ 接受 `perf` 简写：URL 是手敲的，
    // 而存储值与档位常量一律用全名 `performance`（归一化后统一）。
    if (params.has('res')) {
      s.pixelRatio = normPixelRatio(params.get('res') === 'perf' ? 'performance' : params.get('res'));
    }
  }
  return s;
}

/** 读 localStorage（损坏/缺失 → null；不抛异常） */
export function loadStoredSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/** 写 localStorage（私密模式配额失败静默忽略，不影响游戏） */
export function saveStoredSettings(settings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch { /* 忽略 */ }
}
