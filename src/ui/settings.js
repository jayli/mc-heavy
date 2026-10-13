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
/** 视觉风格选项（M2-6 VISUAL_STYLE_KEYS + null=日夜循环自动） */
export const VISUAL_STYLE_OPTIONS = [null, 'morning', 'noon', 'night'];

export const DEFAULT_SETTINGS = {
  viewDistance: 8,
  blur: false,        // §4.4.1：默认像素风（Nearest）；true = mipmap+aniso 消远处莫尔纹
  volume: 1,          // 第一阶段无音频消费方，面板接线 + 持久化先行（§9 扩展点）
  visualStyle: null,  // null = 日夜循环自动（M2-6）
  budgetProfile: 'auto', // M3-2：'auto'|'high'|'low'
  gunBlockDamage: false, // M4：普通枪是否破坏方块（mc-lite 默认关闭，UIManager.js:160）
  tntDamage: false, // M8：TNT 是否破坏地形（mc-lite `Game.js:92` 同口径默认 false —— 默认只伤害 + 连锁）
};

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

/**
 * 合并生效设置：URL 参数 > 存储值 > 默认值。
 * URL 支持的键：vd / blur(0|1) / volume / style / budget / guns(0|1) / tntDamage(0|1)（main.js 既有的
 * ?vd、?blur 语义保持不变，这里统一收口）。
 * 另有**不在此处收口**的 URL 开关（不走持久化，main.js 直传构造选项，见其解析处）：
 *   ?stats / ?log（DEBUG_FLAGS）、?weather（启动天气）、?seed（复现）、
 *   ?shadows=0（太阳阴影代码级开关，DR-7）。
 * @param {Object|null} stored 存储反序列化对象（可能含缺字段/脏值）
 * @param {URLSearchParams} params
 * @returns {typeof DEFAULT_SETTINGS}
 */
export function resolveSettings(stored, params) {
  const s = { ...DEFAULT_SETTINGS };
  if (stored && typeof stored === 'object') {
    if (stored.viewDistance !== undefined) s.viewDistance = clampVD(stored.viewDistance);
    if (typeof stored.blur === 'boolean') s.blur = stored.blur;
    if (stored.volume !== undefined) s.volume = clampVolume(stored.volume);
    if ('visualStyle' in stored) s.visualStyle = normStyle(stored.visualStyle);
    if (stored.budgetProfile !== undefined) s.budgetProfile = normBudget(stored.budgetProfile);
    if (typeof stored.gunBlockDamage === 'boolean') s.gunBlockDamage = stored.gunBlockDamage;
    if (typeof stored.tntDamage === 'boolean') s.tntDamage = stored.tntDamage;
  }
  if (params) {
    if (params.has('vd')) s.viewDistance = clampVD(params.get('vd'));
    if (params.has('blur')) s.blur = params.get('blur') === '1';
    if (params.has('volume')) s.volume = clampVolume(params.get('volume'));
    if (params.has('style')) s.visualStyle = normStyle(params.get('style'));
    if (params.has('budget')) s.budgetProfile = normBudget(params.get('budget'));
    if (params.has('guns')) s.gunBlockDamage = params.get('guns') === '1';
    if (params.has('tntDamage')) s.tntDamage = params.get('tntDamage') === '1';
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
