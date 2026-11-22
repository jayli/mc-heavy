// tools/bake-rain-sheet-params.mjs — 雨幕条纹图的参数（**唯一权威**）
//
// 烘焙脚本与 check:data 共用（后者不能 import 会执行 main() 的烘焙脚本）。
// 改这里必须重跑 `npm run rainsheet`，指纹门禁会抓。

/** 参数（上游 makeRainSheet 逐字；改这里必须重烘，指纹会抓） */
export const RAIN_SHEET = Object.freeze({
  size: 512,
  strokes: 900,
  lenMin: 18,
  lenMax: 64,
  alphaMin: 0.08,
  alphaMax: 0.75,
  widthMin: 0.6,
  widthMax: 1.5,
  /** 渐变最亮处的位置（上游 addColorStop(0.8, …)） */
  peakStop: 0.8,
  seed: 1212,
  version: 1,
});