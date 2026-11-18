// src/render/turret-top-geometry.js — 加载烘焙的炮塔塔顶几何产物
//
// 照 `turret-armor-texture.js` 的容错口径：加载失败返回 null，不阻断启动。
// ⚠️ **本模块只做数据加载，不建 BufferGeometry** —— 那样它就能被无 three 的单测消费，
// three 依赖留给渲染层（`turret-renderer.js`）。
//
// 产物由 `npm run turretop` 生成，UV 已在烘焙侧按面压进三区 ⇒ 渲染层不得再改写 UV。
import { resourceUrl } from '../core/resource-url.js';
import { TURRET_PARTS } from '../entities/turrets/turret-config.js';

/**
 * 校验产物形状。
 *
 * ⚠️ **必须校验，不能只判 `res.ok`**（final review Important 4）：
 * 合法 JSON 但无 `parts`（旧格式 / 代理错误页 / 半截响应）会让渲染层
 * `topGeometry.parts[part]` 抛 TypeError ⇒ game.js 构造期崩启动，
 * 违背「加载失败不阻断启动」的容错口径。
 * @returns {boolean}
 */
function isValidShape(json) {
  if (!json || typeof json !== 'object') return false;
  const parts = json.parts;
  if (!parts || typeof parts !== 'object' || Array.isArray(parts)) return false;
  // 每个部件都要齐，且四个属性数组长度非零
  for (const key of TURRET_PARTS) {
    const g = parts[key];
    if (!g || !Array.isArray(g.position) || g.position.length === 0) return false;
    if (!Array.isArray(g.normal) || !Array.isArray(g.uv) || !Array.isArray(g.index)) return false;
    if (g.index.length === 0) return false;
  }
  return true;
}

/**
 * @returns {Promise<{scale:number, pivotY:number,
 *   parts: Record<string, {position:number[], normal:number[], uv:number[],
 *     index:number[], zone:null, textured:boolean, color?:number}>}|null>}
 */
export async function loadTurretTopGeometry() {
  try {
    // 部署路径无关：禁止根绝对路径 `/assets/...`（子路径部署会全 404）
    const res = await fetch(resourceUrl('assets/turret/turret-top.json'));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (!isValidShape(json)) throw new Error('产物形状不合契约（缺 parts 或部件不齐）');
    return json;
  } catch (err) {
    console.warn('[turret-top] geometry load failed:', err);
    return null;
  }
}
