// tools/test-tiers.mjs — 测试分档的**唯一权威**（v3.15）
//
// 设计：docs/superpowers/specs/2026-11-18-test-tiering-and-runtime-design.md
//
// **为什么按文件清单分档，而不是给 423 个 test 逐个打 @tag**：
// `--grep` 对**未打标签**的用例默认全跑 ⇒ 漏标一个文件就静默回到全量。
// 文件清单是**闭合集合**，能做双向门禁（漏归档 / 死引用都当场报错）。
//
// **判据不是文件名，是「它守的失效路径」**（docs/testing-policy.md §1）：
//   core   —— 引擎底座：协议/竞态/物理/编辑/数据契约。改坏了肉眼玩不出来 ⇒ 日常必跑
//   ui     —— 面板/HUD/文案/存档交互。改坏了立刻可见，但接线漏了会静默 ⇒ 改 UI 时跑
//   entity —— 实体玩法与 AI（丧尸/Boss/炮塔/矿车/武器）。改玩法时跑
//   struct —— 地形与结构落地（GEN 正确性）。改 gen/** 时跑
//   pixel  —— Tier 4 GPU 像素实测。改渲染/材质/光影时跑
//   slow   —— 全量 GEN 扫描等重活。**提交前门仍跑**（作为普通 spec 被 playwright 收集）
//
// ⚠️ 一个 spec 只归一档（清单互斥），`npm test` 跑全部 ⇒ 分档只影响「日常跑哪些」，
// 不影响提交前门的覆盖范围。这是「零判别力损失」的实现方式。

/** 引擎底座：协议 / 竞态 / 物理 / 编辑 / 数据契约 / 浏览器内单测入口 */
const CORE = [
  'harness',            // 浏览器内默认档全量单测
  'harness-slow',       // 浏览器内慢档（全量 GEN 扫描）—— 提交前门仍跑
  'unit-fast',          // 浏览器内轻档单测（日常门）
  'worker-gen',         // GEN p95 冻结断言（计时型，必须串行）
  'worker-pool',        // RPC / 取消 / Transferable 协议
  'render-world',       // BatchedMesh 三通道发布 + 三级兜底
  'webgpu-publish',     // 发布层基准
  'structure-gen',      // 结构 GEN 同构性
  'light-init',         // 光照初值
  'light-mesh-sync',    // 源数据 → 派生网格同步（v1.65 的教训）
  'light-spread',       // 水平 BFS 每格 −1
  'light-arch',
  'light-house',
  'light-structures',
  'atlas',              // 图集契约（关系型断言）
  'm1-acceptance',      // 放挖 p95 / frameMs 冻结
  'm3-budget',          // 顶点预算
  'm3-fullscene',       // gpuVertexBytes < 200MiB
  'giant-tree-budget',  // 通道容量 reserved 冻结
  'interaction',        // DDA 射线交互
  'place-fallback',     // 放置回退（最近优先）
  'm3-2-orientation',   // 朝向映射
  'persistence',        // edits round-trip
  'db-version-heal',    // IndexedDB 版本自愈
  'clear-save',         // 清档（_discardEdits 的位置写盘门）
  'weapons-logic',      // ← 本轮删除（断言是 harness 真子集）
  'world-editor',       // ← 本轮删除（同上）
];

/** UI / HUD / 面板 / 文案 / 存档交互 */
const UI = [
  'm3-hud',
  'm3-1-inventory',
  'inventory-tooltip',
  'crosshair',
  'health-hud',
  'minimap',
  'settings-resolution',
  'loading-overlay',
  'progress',
  'teleport',
  'playground',
  'view-bob',
  'player-flight',
  'audio-fx',
  'bgm',
  'boss-hint',
];

/** 实体玩法 / AI / 武器 */
const ENTITY = [
  'entities',
  'zombies',
  'zombie-nests',
  'zombie-model',
  'turrets',
  'turret-render',
  'minecarts',
  'minecart-render',
  'dragon',
  'dragon-ai',
  'dragon-render',
  'dragon-fireball',
  'fireball-render',
  'ignis',
  'ignis-fx',
  'ignis-spike',
  'guardian',
  'boss-audio',
  'projectiles',
  'tnt',
  'explosion-sprite',
  'block-hit-fx',
  'weapons',
  'weapons-world-edit',
  'weapons-performance',
  'weapon-assets',
  'weapon-view',
  'sword',
  'tracer-water-occlusion',
];

/** 地形 / 结构落地（读真实世界方块，零像素） */
const STRUCT = [
  'arena',
  'burning-arena',
  'ruined-citadel',
  'jungle-fortress',
  'giant-pyramid',
  'giant-trees',
  'azalea-trees',
  'medieval-ship',
  'shallow-water-tarns',
  'tarn-zone',
  'tarn-altar',
  'sky-structures',
  'sky-tree-visual',
  'city-visual',
];

/** Tier 4：GPU 像素实测 */
const PIXEL = [
  'ao-visual',
  'ao-corner-visual',
  'daynight-visual',
  'dusk-style',
  'fog-color',
  'hemisphere-ambient',
  'moonlight',
  'night-sky-seam',
  'skybox',
  'sun-directional',
  'sun-shadow',
  'render-terrain',
  'water-visual',
  'water-order',
  'lake-ripple',
  'm3-rain',
];

/**
 * spec 分档。键 = 档位名，值 = spec 基名（不含 `.spec.mjs`）。
 * ⚠️ 已删除的两个转发 spec 不在此列（本轮删文件，见设计 §5.5）。
 */
export const SPEC_TIERS = {
  core: CORE.filter((n) => n !== 'weapons-logic' && n !== 'world-editor'),
  ui: UI,
  entity: ENTITY,
  struct: STRUCT,
  pixel: PIXEL,
};

/**
 * 可在 Node 里跑的单测文件白名单（**实测得出，不靠猜**）。
 *
 * 准入条件（2026-11-18 逐文件实测）：
 *   ① 在「fetch 垫片 + three 解析映射、**无 DOM 垫片**」下 `failed === 0`；
 *   ② 不断言 URL 形状 / origin / 同源语义（Node 下 `resourceUrl()` 必为 `file://`，
 *      那类断言通过与失败的原因会与浏览器不同 = 第二套语义）。
 *      已逐文件核实：白名单里出现的 `.origin` 全是 Blockbench `rotation.origin` /
 *      实体锚点 / 射线 `aim.origin`，与 URL 无关。
 *
 * ⚠️ **不加假 DOM 垫片**（实测它只造假绿/假红）：`test-player-place` 23 例仍全红
 * （`window.addEventListener`）、`test-bgm` 17 红（AudioContext）、`test-iso-icon` 4 红
 * （`createImageBitmap`）⇒ 这些文件留浏览器，见 UNIT_BROWSER_ONLY 的派生。
 *
 * 实测规模：100 文件 / 2065 例全绿；其中 6 个重 GEN 文件占 217.7s（执行期），
 * 其余 94 文件 1910 例串行 36.0s。**import 期六个重文件合计仅 209ms**。
 */
export const UNIT_NODE_SAFE = [
  'test-arena-gen.js', 'test-arena.js', 'test-azalea-trees-gen.js', 'test-azalea-trees.js',
  'test-block-color.js', 'test-block-hit-fx.js', 'test-boss-agent.js', 'test-boss-hit-sound.js',
  'test-boss-map.js', 'test-budget.js', 'test-burning-arena-gen.js', 'test-bush-grass-gen.js',
  'test-bush-grass.js', 'test-caves.js', 'test-chunk-column.js', 'test-daynight.js',
  'test-dragon-bake.js', 'test-dragon-boss-agent.js', 'test-dragon-facing.js', 'test-dragon-render.js',
  'test-dragon-system.js', 'test-entity-manager.js', 'test-explosion-sprite.js', 'test-explosion.js',
  'test-fireball-render.js', 'test-fireball.js', 'test-flame-sigil.js', 'test-fog-sky-direction.js',
  'test-giant-pyramid-gen.js', 'test-giant-pyramid.js', 'test-giant-trees-column.js',
  'test-giant-trees-gen.js', 'test-giant-trees.js', 'test-grass-tint.js',
  'test-guardian-boss-agent.js', 'test-guardian-collision.js', 'test-guardian-config.js',
  'test-guardian-render.js', 'test-guardian-skinning.js', 'test-guardian-system.js',
  'test-guardian-uv.js', 'test-health.js', 'test-hemi.js', 'test-ignis-boss-agent.js',
  'test-ignis-collision.js', 'test-ignis-render.js', 'test-ignis-system.js', 'test-inventory.js',
  'test-jungle-fortress-gen.js', 'test-knockback-ease.js', 'test-landmarks.js', 'test-light-writeback.js',
  'test-lighting.js', 'test-load-progress.js', 'test-load-watchdog.js', 'test-medieval-ship.js',
  'test-mesher.js', 'test-minimap.js', 'test-molang.js', 'test-moonlight.js', 'test-ocean-mask.js',
  'test-orientation.js', 'test-physics.js', 'test-pixel-ratio.js', 'test-place-ray.js',
  'test-playground.js', 'test-progress.js', 'test-projectiles.js', 'test-rain.js', 'test-raycast.js',
  'test-ruined-citadel-gen.js', 'test-runner-tiers.js', 'test-scatter.js', 'test-shadow-manager.js',
  'test-shallow-tarn-gen.js', 'test-shallow-water-bridge.js', 'test-shallow-water-tarns.js',
  'test-sky-structures.js', 'test-smoke.js', 'test-spike-fx.js', 'test-step-lift.js',
  'test-structure-json.js', 'test-structure-layout.js', 'test-sun-shade.js', 'test-tarn-altar.js',
  'test-tarn-terrain.js', 'test-tarn-zone-gen.js', 'test-tarn-zone.js', 'test-terrain.js',
  'test-tnt-chain.js', 'test-turret-top-bake.js', 'test-vegetation-leaves.js', 'test-vegetation.js',
  'test-view-bob.js', 'test-weapons.js', 'test-world-editor.js', 'test-zombie-behavior.js',
  'test-zombie-model.js', 'test-zombie-pathfinder.js', 'test-zombies.js',
];

/**
 * 单测里的**重 GEN 文件**（执行期成本大头，Node 快档默认排除，`--all` 才跑）。
 * 实测：这 6 个文件 155 例占 217.7s，而其余 94 文件 1910 例只要 36.0s。
 */
export const UNIT_HEAVY = [
  'test-giant-trees-gen.js',
  'test-jungle-fortress-gen.js',
  'test-ruined-citadel-gen.js',
  'test-shallow-tarn-gen.js',
  'test-burning-arena-gen.js',
  'test-scatter.js',
];

/** 浏览器内单测的轻档 = 白名单 − 重 GEN（派生，不写第二份清单） */
export const UNIT_LIGHT = UNIT_NODE_SAFE.filter((f) => !UNIT_HEAVY.includes(f));

/**
 * 档位名 → 单测文件清单（供 `?only=<档位名>` 展开）。
 * 浏览器侧由 spec 注入 `window.__MC_TEST_GROUPS__`，Node 侧直接传参 —— 两边共用这一份。
 */
export const UNIT_GROUPS = {
  light: UNIT_LIGHT,
  heavy: UNIT_HEAVY,
  nodesafe: UNIT_NODE_SAFE,
};