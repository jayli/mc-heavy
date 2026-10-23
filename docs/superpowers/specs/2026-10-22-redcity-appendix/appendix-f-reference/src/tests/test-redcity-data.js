// RedCity 产物加载器（Tier 1，纯逻辑）：形状往返 / 坏产物必须抛错 / dy 语义 / 未注入读出 / 真实产物交叉校验
import { test } from './runner.js';
import { assertEqual, assertTrue, assertThrows, assertNull, assertNotNull } from './assert.js';
import {
  REDCITY_JSON_FORMAT, encodeRedCityJson, prepareRedCityModel, isIslandColumn, groundAt,
  forEachRedCityBlock, setRedCityData, getRedCityData,
} from '../gen/structures/redcity-data.js';
import { REDCITY_SIZE, REDCITY_GROUND_FLOOR, REDCITY_DY_MAX_BUDGET } from '../gen/structures/region-config.js';

/** 合成 5×4 小模型：列 c = oz*5+ox；地面块恰在 dy === ground；第 7 列另有 2 个地面之上的块（一个贴地、一个隔空） */
function synthBake() {
  const width = 5, length = 4, N = width * length;
  const ground = new Int16Array(N);
  for (let c = 0; c < N; c++) ground[c] = (c % 3) - 1;                  // -1 / 0 / 1
  const island = new Uint8Array(N).fill(1); island[0] = 0;
  const ents = [];
  for (let c = 0; c < N; c++) ents.push({ c, y: ground[c], name: c === 7 ? 'planks' : 'stone' });
  ents.push({ c: 7, y: ground[7] + 1, name: 'glass_block' }, { c: 7, y: ground[7] + 4, name: 'pink_wool' });
  ents.sort((a, b) => a.c - b.c || a.y - b.y);
  return { width, length, ground, island, ents, dyMin: -1, dyMax: 5, stats: { retained: ents.length } };
}
const SPAWN = { ox: 2, oz: 1, dy: 0 };
const roundTrip = (bake) => prepareRedCityModel(JSON.parse(JSON.stringify(encodeRedCityJson(bake, SPAWN))));

test('RedCity 产物：encode → JSON → prepare → 逐列展开 与原始条目逐一相同', () => {
  const bake = synthBake(); const model = roundTrip(bake);
  const got = [];
  for (let oz = 0; oz < bake.length; oz++) for (let ox = 0; ox < bake.width; ox++) {
    forEachRedCityBlock(model, ox, oz, (dy, name) => got.push(`${oz * bake.width + ox}|${dy}|${name}`));
  }
  assertEqual(got.join(','), bake.ents.map((e) => `${e.c}|${e.y}|${e.name}`).join(','), '展开顺序与内容');
});

test('RedCity 产物：dy 是相对 baseY 的行号——地面方块恰在 dy === ground[col]（放置公式 baseY+dy 的前提）', () => {
  const bake = synthBake(); const model = roundTrip(bake);
  for (let oz = 0; oz < bake.length; oz++) for (let ox = 0; ox < bake.width; ox++) {
    let hasGroundBlock = false;
    forEachRedCityBlock(model, ox, oz, (dy) => { if (dy === groundAt(model, ox, oz)) hasGroundBlock = true; });
    assertTrue(hasGroundBlock, `列 (${ox},${oz}) 缺少 dy===ground 的地面方块`);
  }
  assertTrue(!isIslandColumn(model, 0, 0) && isIslandColumn(model, 1, 0), 'island 位串读出');
});

test('RedCity 产物：坏产物必须抛错（format / version / ground 长度 / island 长度 / 非三元组 / 乱序）', () => {
  const doc = encodeRedCityJson(synthBake(), SPAWN);
  assertThrows(() => prepareRedCityModel({ ...doc, format: 'nope' }), '不是 redcity-json 产物');
  assertThrows(() => prepareRedCityModel({ ...doc, version: REDCITY_JSON_FORMAT + 1 }), '不支持的产物版本');
  assertThrows(() => prepareRedCityModel({ ...doc, ground: [1, 2, 3] }), 'ground 长度');
  assertThrows(() => prepareRedCityModel({ ...doc, island: '01' }), 'island 长度');
  assertThrows(() => prepareRedCityModel({ ...doc, blocks: [1, 2] }), '三元组');
  assertThrows(() => prepareRedCityModel({ ...doc, blocks: [5, 0, 0, 1, 0, 0] }), '未按 (col, dy) 严格升序');
  assertThrows(() => prepareRedCityModel({ ...doc, blocks: [3, 1, 0, 3, 0, 0] }), '未按 (col, dy) 严格升序');   // 同列 dy 降序
  assertThrows(() => prepareRedCityModel({ ...doc, blocks: [3, 0, 0, 3, 0, 0] }), '未按 (col, dy) 严格升序');   // 同格重复
  assertThrows(() => prepareRedCityModel({ ...doc, blocks: [3, 0, doc.palette.length] }), 'palette 下标');
  assertThrows(() => prepareRedCityModel({ ...doc, blocks: [3, 0, -1] }), 'palette 下标');
  assertThrows(() => prepareRedCityModel({ ...doc, blocks: [doc.width * doc.length, 0, 0] }), 'col');          // 越界 col 写 Uint32Array 会被静默丢弃
  assertThrows(() => prepareRedCityModel({ ...doc, blocks: [-1, 0, 0] }), 'col');
  assertThrows(() => prepareRedCityModel({ ...doc, blocks: [3, doc.dyMax + 1, 0] }), 'dy');
  assertThrows(() => prepareRedCityModel({ ...doc, blocks: [3, 0.5, 0] }), 'dy');
});

test('RedCity 产物：未注入时 getRedCityData() 为 null；注入/清空往返（GEN 降级路径的前提）', () => {
  const before = getRedCityData();
  try {
    setRedCityData(null);
    assertNull(getRedCityData());
    const model = roundTrip(synthBake());
    setRedCityData(model);
    assertTrue(getRedCityData() === model, '注入的就是同一个对象');
  } finally { setRedCityData(before); }
});

test('RedCity 真实产物：全量展开块数 === stats.retained；尺寸 === REDCITY_SIZE；ground≥下限；dyMax≤预算；出生列地面方块存在', async () => {
  const doc = await (await fetch('/assets/redcity/redcity.json')).json();
  const model = prepareRedCityModel(doc);
  assertEqual(model.width, REDCITY_SIZE.X, '产物宽 === region-config 的 REDCITY_SIZE.X');
  assertEqual(model.length, REDCITY_SIZE.Z, '产物长 === REDCITY_SIZE.Z');
  let n = 0;
  for (let oz = 0; oz < model.length; oz++) for (let ox = 0; ox < model.width; ox++) forEachRedCityBlock(model, ox, oz, () => { n++; });
  assertEqual(n, doc.stats.retained, '展开块数与烘焙期统计一致（烘焙/加载两端交叉校验）');
  let minG = 0; for (const g of model.ground) if (g < minG) minG = g;
  assertTrue(minG >= REDCITY_GROUND_FLOOR, `ground 最小值 ${minG} >= GROUND_FLOOR`);
  assertTrue(model.dyMax <= REDCITY_DY_MAX_BUDGET, `dyMax ${model.dyMax} <= 预算`);
  const { ox, oz, dy } = model.spawn;
  assertTrue(isIslandColumn(model, ox, oz), '出生列必须是岛内列');
  assertEqual(groundAt(model, ox, oz), dy, '出生点 dy === 该列 ground');
  assertNotNull(model.palette.find((n2) => n2 === 'glass_block'), '玻璃按 D6/U3 映射为现成 glass_block');
});
