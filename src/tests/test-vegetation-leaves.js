// src/tests/test-vegetation-leaves.js — 树叶混表（2026-11-14，用户要求「矮树/高树的树叶丰富一下」）
//
// 判据一律落在**真实生成路径**上（`rollVegetation` → `generateTree`），不测私有实现：
//   · 混表按「整棵树一种叶」掷签 ⇒ 同一棵树的所有叶格必须是同一种叶（用户的粒度裁定）
//   · `leaves` / `yellow_leaves` 仍占主导，四种 giant 叶作稀有变体
//   · 混表里的每个名字都必须是注册方块（拼错时 `makeColumnSetter` **静默跳过** ⇒ 那格变 air）
//   · 掷签只用世界坐标 ⇒ 确定性 + 跨 column 一致（红线 2）
//
// ⚠️ 断言的分布区间下限取「实测值的一半」量级，不是为了宽松，而是要点名一条真实约束：
// seed 12345 在扫描域内实际抽到的棵数不多（草地矮树 0.5% × 域内草地格），把区间写成
// 理论值 ±0.1% 会变成 flaky；写成「必须出现」才是本改动真正的判别力所在。
import { test } from './runner.js';
import { assertEqual, assertTrue } from './assert.js';
import { createRegistry } from '../voxel/block-registry.js';
import { BLOCKS } from '../voxel/blocks-data.js';
import { getBiome, seededRandom } from '../gen/noise.js';
import { rollVegetation, generateTree } from '../gen/structures/vegetation.js';

const SEED = 12345;

function makeRegistry() {
  const reg = createRegistry();
  for (const def of BLOCKS) reg.register(def.name, def);
  reg.freeze();
  return reg;
}
const REG = makeRegistry();

/** 用户的裁定量：草地矮树 leaves 最高，其余四种等概率 */
const SAPLING_SPECIES = ['giant_oak_leaves', 'giant_spruce_leaves', 'giant_palm_leaves', 'giant_banyan_leaves'];
/** 森林高树：leaves 与 yellow_leaves 占大头，四种 giant 叶等概率兜底 */
const TALL_SPECIES = ['giant_oak_leaves', 'giant_spruce_leaves', 'giant_palm_leaves', 'giant_banyan_leaves'];
const ALL_MIX = new Set(['leaves', 'yellow_leaves', ...SAPLING_SPECIES, ...TALL_SPECIES]);

/** 用 setBlock 桩光栅化一棵树，返回 { 叶格坐标 → 方块名 } */
function rasterize(tree, wx, y, wz) {
  const out = new Map();
  // ⚠️ `leafMix` 必须与生产路径（apply.js 阶段 3）一样透传：漏传会让本文件的所有分布断言
  // 退化成「只测旧默认 leaves」—— 那也是第一次跑时的 RED 形态（实测：全 leaves）。
  generateTree(wx, y, wz, (x, by, z, name) => { out.set(`${x},${by},${z}`, name); }, SEED, tree.type,
    tree.customLog || null, tree.customLeaf || null, tree.leafMix || null);
  return out;
}

/** 树里出现的全部叶方块名（去重） */
function leafNamesOf(cells) {
  const s = new Set();
  for (const n of cells.values()) if (n.endsWith('_leaves') || n === 'leaves') s.add(n);
  return s;
}

// ---------------------------------------------------------------- 混表内容

test('树叶混表：五种 / 六种名字都是注册方块（拼错会被 makeColumnSetter 静默跳过 ⇒ 那格变 air）', () => {
  for (const n of ALL_MIX) {
    assertTrue(REG.idOf(n) > 0, `${n} 必须已注册`);
  }
});

test('树叶混表：giant 族的四种叶是 cutout（走 cutout 通道 = 与 leaves 同材质口径）', () => {
  const leavesChannel = REG.cullTable[REG.idOf('leaves')];
  for (const n of [...SAPLING_SPECIES, ...TALL_SPECIES]) {
    assertEqual(REG.cullTable[REG.idOf(n)], leavesChannel, `${n} 必须与 leaves 同通道`);
  }
});

// ---------------------------------------------------------------- 草地矮树

/** 扫一片草地：收集 `rollVegetation(PLAINS)` 真掷出 default 矮树的锚点 */
function collectTrees(biome, radius, step) {
  const out = [];
  for (let wx = -radius; wx <= radius; wx += step) {
    for (let wz = -radius; wz <= radius; wz += step) {
      if (getBiome(wx, wz, SEED) !== biome) continue;
      const roll = rollVegetation(wx, wz, biome, SEED);
      if (roll.tree) out.push({ wx, wz, tree: roll.tree });
    }
  }
  return out;
}

test('草地矮树：树叶混表真的生效 —— 四种 giant 叶都出现过，且 leaves 仍是多数', () => {
  const trees = collectTrees('PLAINS', 300, 2);
  assertTrue(trees.length >= 80, `扫描域内 PLAINS 矮树样本太少（${trees.length}）—— 本用例无判别力`);
  const seen = new Map();
  for (const t of trees) {
    const names = leafNamesOf(rasterize(t.tree, t.wx, 40, t.wz));
    assertEqual(names.size, 1, `(${t.wx},${t.wz}) 整棵树必须只有一种叶（实得 ${[...names].join('/')}）：粒度 = 每棵树一种`);
    const leaf = [...names][0];
    seen.set(leaf, (seen.get(leaf) || 0) + 1);
  }
  for (const n of ['leaves', ...SAPLING_SPECIES]) {
    assertTrue((seen.get(n) || 0) > 0, `${n} 必须出现（实测分布 ${JSON.stringify(Object.fromEntries(seen))}）`);
  }
  const leavesCount = seen.get('leaves') || 0;
  // 用户裁定 leaves「随机性最高」 ⇒ 它的出现数必须是任何一种 giant 叶的 3 倍以上（权重 80 vs 5）
  for (const n of SAPLING_SPECIES) {
    assertTrue(leavesCount >= (seen.get(n) || 0) * 3,
      `leaves 必须明显多于 ${n}（实测 leaves ${leavesCount} / ${n} ${seen.get(n) || 0}）`);
  }
  // 反向：黄叶不进草地（森林高树的混表才含它）
  assertEqual(seen.get('yellow_leaves') || 0, 0, '草地矮树不应出现 yellow_leaves');
});

// ---------------------------------------------------------------- 森林高树

test('森林高树：树叶混表真的生效 —— 四种 giant 叶 + yellow_leaves 都出现，leaves/yellow 占多数', () => {
  const trees = collectTrees('FOREST', 300, 2).filter((t) => t.tree.type === 'big');
  assertTrue(trees.length >= 200, `扫描域内 FOREST 高树样本太少（${trees.length}）—— 本用例无判别力`);
  const seen = new Map();
  for (const t of trees) {
    const names = leafNamesOf(rasterize(t.tree, t.wx, 40, t.wz));
    assertEqual(names.size, 1, `(${t.wx},${t.wz}) 整棵树必须只有一种叶（实得 ${[...names].join('/')}）`);
    seen.set([...names][0], (seen.get([...names][0]) || 0) + 1);
  }
  for (const n of ['leaves', 'yellow_leaves', ...TALL_SPECIES]) {
    assertTrue((seen.get(n) || 0) > 0, `${n} 必须出现（实测分布 ${JSON.stringify(Object.fromEntries(seen))}）`);
  }
  const dominant = (seen.get('leaves') || 0) + (seen.get('yellow_leaves') || 0);
  const giant = TALL_SPECIES.reduce((s, n) => s + (seen.get(n) || 0), 0);
  assertTrue(dominant > giant * 3,
    `leaves+yellow_leaves 必须明显主导（实测 dominant ${dominant} vs giant ${giant}）`);
  // 用户 2026-11-14 二次裁定：「yellow_leaves 在森林中的比例降低为 25%」。
  // 区间取 ±5%（样本 ~860 棵，实测抽样偏差 <2%），既钉住 25% 又不因抽样抖动 flaky。
  const total = [...seen.values()].reduce((a, b) => a + b, 0);
  const yellowShare = (seen.get('yellow_leaves') || 0) / total;
  assertTrue(yellowShare > 0.20 && yellowShare < 0.30,
    `yellow_leaves 在森林高树里应占 25% 左右（实测 ${(yellowShare * 100).toFixed(1)}%，样本 ${total}）`);
  // 权重降下来的那 10% 由 leaves 吸收（巨树叶份额不动 —— 那是用户上一轮「更保守」档的裁定）：
  // leaves 应约 60%，且仍明显多于任何一种巨树叶。
  const leavesShare = (seen.get('leaves') || 0) / total;
  assertTrue(leavesShare > 0.53 && leavesShare < 0.67,
    `leaves 应吸收黄叶释放的份额、约 60%（实测 ${(leavesShare * 100).toFixed(1)}%）`);
});

// ---------------------------------------------------------------- 覆盖规则

test('显式 customLeaf 优先于混表（黄叶树 / 定制树不被混表改写）', () => {
  // 找一个真会掷出树的 PLAINS 点作锚点，然后显式指定 customLeaf
  const t = collectTrees('PLAINS', 300, 2)[0];
  const cells = rasterize({ type: 'default', customLeaf: 'swamp_leaves' }, t.wx, 40, t.wz);
  const names = leafNamesOf(cells);
  assertEqual(names.size, 1, `整棵树一种叶（实得 ${[...names].join('/')}）`);
  assertEqual([...names][0], 'swamp_leaves', '传入 customLeaf 时必须原样使用，不被混表覆盖');
});

test('城市树 / 海岛树不混表：rollCityTree 的 default 树仍是纯 leaves', () => {
  // `rollCityTree` 的混表刻意不动（用户裁定：只草地 PLAINS）。这里钉住「凡未显式下混表签的
  // `default` 树都是 leaves」—— 城市树的调用点（apply.js `kind:'city'` 分支）不传 leafMix。
  const cells = rasterize({ type: 'default' }, 7, 40, 7);
  const names = leafNamesOf(cells);
  assertEqual(names.size, 1, `整棵树一种叶（实得 ${[...names].join('/')}）`);
  assertEqual([...names][0], 'leaves', '未下混表签的 default 树（城市/海岛/天空）必须仍是 leaves');
});

// ---------------------------------------------------------------- 确定性

test('确定性：同一棵树两次光栅化逐格一致，且掷签与世界坐标绑定（跨 column 一致）', () => {
  const t = collectTrees('PLAINS', 300, 2)[0];
  const a = rasterize(t.tree, t.wx, 40, t.wz);
  const b = rasterize(t.tree, t.wx, 40, t.wz);
  assertEqual(a.size, b.size, '两次光栅化格数一致');
  for (const [k, v] of a) assertEqual(b.get(k), v, `格 ${k} 两次一致`);

  // 跨 column 一致：把同一棵树的树冠裁成「只写某一列」的两半，各自拼回来后叶种仍相同
  const cx = Math.floor(t.wx / 16);
  const left = new Map(), right = new Map();
  generateTree(t.wx, 40, t.wz, (x, y, z, name) => {
    if (!(name.endsWith('_leaves') || name === 'leaves')) return;
    (Math.floor(x / 16) === cx ? left : right).set(`${x},${y},${z}`, name);
  }, SEED, t.tree.type, t.tree.customLog || null, t.tree.customLeaf || null, t.tree.leafMix || null);
  const leftKinds = new Set(left.values()), rightKinds = new Set(right.values());
  for (const s of [leftKinds, rightKinds]) if (s.size > 0) assertEqual(s.size, 1, '每半边也必须只有一种叶（树冠跨列不换叶种）');
  const merged = new Set([...leftKinds, ...rightKinds]);
  assertEqual(merged.size, 1, `跨 column 的两半必须同叶种（实得 ${[...merged].join('/')}）`);
});

// ---------------------------------------------------------------- 不回归既有语义

test('叶团剔除语义不变：被六面完全包围的叶格仍不写（`_addOptimized` 语义保留）', () => {
  // default 树冠是 5×5×3 实心团，内部格被包围 ⇒ 光栅化后必少于理论格数 75。
  const cells = rasterize({ type: 'default' }, 7, 40, 7);
  let leafCells = 0;
  for (const n of cells.values()) if (n.endsWith('_leaves') || n === 'leaves') leafCells++;
  assertTrue(leafCells < 75 && leafCells > 0, `default 树冠叶格应被内部剔除到 1~74（实得 ${leafCells}）`);
});

test('高树木材/几何不变：树干仍是 wood，树高与既有 6~13 一致', () => {
  const trees = collectTrees('FOREST', 200, 2).filter((t) => t.tree.type === 'big' && !t.tree.customLog);
  assertTrue(trees.length > 0, '找到无 customLog 的高树样本');
  const t = trees[0];
  const cells = rasterize(t.tree, t.wx, 40, t.wz);
  const logs = [...cells.entries()].filter(([, n]) => n === 'wood');
  assertTrue(logs.length >= 6 && logs.length <= 13, `树干高度必须在 6~13（实得 ${logs.length}）`);
});

// ---------------------------------------------------------------- 与既有抽签的关系

test('rollVegetation 的 PLAINS 树密度不变：仍是 0.5% 那一个抽签点', () => {
  // 混表只改「用哪种叶」，不改「有没有树」。密度回归会让森林/草地观感整体变化。
  let hits = 0, total = 0;
  for (let wx = -300; wx <= 300; wx += 3) {
    for (let wz = -300; wz <= 300; wz += 3) {
      if (getBiome(wx, wz, SEED) !== 'PLAINS') continue;
      total++;
      if (rollVegetation(wx, wz, 'PLAINS', SEED).tree) hits++;
    }
  }
  assertTrue(total > 5000, `PLAINS 样本量 ${total}`);
  const rate = hits / total;
  assertTrue(rate > 0.003 && rate < 0.008, `PLAINS 树密度应仍在 0.5% 附近（实测 ${(rate * 100).toFixed(2)}%）`);
});

test('salt 独立性：混表掷签不复用既有树内随机（每棵树一种叶，不随叶格变化）', () => {
  // 反证：若混表按「叶格坐标」掷签，同一棵树的叶种会出现多种。上一条已钉死单叶种；
  // 这里再钉一条更细的：**锚点相同、y 不同**（同坐标不同高度的两棵树）必须是同一种叶
  // —— 掷签只吃 (wx,wz,seed)，不吃 y。
  const t = collectTrees('PLAINS', 300, 2)[0];
  const low = rasterize(t.tree, t.wx, 20, t.wz);
  const high = rasterize(t.tree, t.wx, 60, t.wz);
  const kindOf = (m) => [...leafNamesOf(m)][0];
  assertEqual(kindOf(low), kindOf(high), '同锚点不同高度的两棵树必须同叶种（掷签只吃世界 x/z）');

  // 反向对照：换坐标必须能换叶种（否则上面那条会恒真）
  let diff = 0;
  for (const o of collectTrees('PLAINS', 300, 2)) {
    const k = kindOf(rasterize(o.tree, o.wx + 1000, 40, o.wz + 1000));
    if (k !== kindOf(low)) { diff++; break; }
  }
  assertTrue(diff > 0, '换锚点后必须能掷到不同叶种（否则「同锚点同叶种」无判别力）');
});

test('seededRandom 的分布无偏：混表抽签用的两次样本不相关（同一 (wx,wz) 两条 salt 不同结果）', () => {
  // 防「两条抽签共用一个 salt ⇒ 抽签恒同号 ⇒ 混表退化成单一叶种」。
  // 判据：对 200 个点，两 salt 的样本值不应逐点相等。
  let same = 0;
  for (let i = 0; i < 200; i++) {
    const a = seededRandom(i, -i, SEED + 1041);
    const b = seededRandom(i, -i, SEED + 1042);
    if (a === b) same++;
  }
  assertTrue(same === 0, `两条 salt 的样本不得逐点相同（实得 ${same}/200 相同）`);
});
