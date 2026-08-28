// src/core/debug-config.js — 调试/性能统计开关（设计文档 §4.9）
// worldStats 默认开（HUD 看板）、statsLog 默认关（控制台日志）；
// URL 参数可覆盖（main.js 解析，如 ?stats=0 / ?log=1），
// Game 启动时 broadcast 给 Worker 池（mesher 与主线程快速路径同构生效）。

export const DEBUG_FLAGS = {
  /** 世界数据看板：mesher 面剔除计数 + section 统计聚合 + 通道级顶点统计 + HUD 2s 刷新。
   *  关闭后 mesher 热循环跳过计数、scheduler/renderWorld 不存统计、HUD 不显示世界数据区。 */
  worldStats: true,
  /** 世界数据看板控制台日志：随 HUD 同节奏（2s）console.log 精确数值行 + 原始统计对象。
   *  依赖 worldStats（采集关闭时无数据可 log）。默认关，调试用 ?log=1 打开。 */
  statsLog: false,
};

/** 合并覆盖开关（main.js URL 参数 / Worker 'debug-flags' broadcast 共用） */
export function setDebugFlags(patch) {
  Object.assign(DEBUG_FLAGS, patch);
}
