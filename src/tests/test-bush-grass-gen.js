// src/tests/test-bush-grass-gen.js — 矮草丛生成密度（v3.12）
//
// 用户 2026-11-17：「以 short_grass 同等出现的概率生成在草地的地形之上」
// ⇒ 裁定「各 5%，草总量翻倍」（花/蘑菇/枯灌木档位一律不动）。
//
// ⚠️ **空档宽度不是名义上的 0.87**：`randPlant >= 0.13` 名义占 87%，但树抽签
// （`seed+1 < 0.005`）是**独立盐**、会与之重叠。**实测 40 万格空档 = 86.611%**。
// 故阈值取 `0.05 / 0.86611`，才能让逐格概率**恰 5%**。
// 若直接写 0.05 → 实际 4.33%（偏 −13%）；若用名义 0.87 → 4.978%（偏 −0.4%）。
//
// ⚠️ **既有 8 个档位的比例必须逐位不变** —— 新分支只能追加在所有既有 return 之后。
// 插进 0.05~0.10 之间会静默吃掉花的份额（那是用户没要求的玩法变更）。
import { test } from './runner.js';
import { assertTrue, assertEqual } from './assert.js';
import { rollVegetation } from '../gen/structures/vegetation.js';

const SEED = 12345;
const N = 400000;

/** 与 spec §2.3 实测同口径的坐标遍历（保证冻结值可复现） */
function samplePlains() {
  const cnt = new Map();
  for (let i = 0; i < N; i++) {
    const wx = (i % 2000) - 1000, wz = Math.floor(i / 2000) - 100;
    const r = rollVegetation(wx, wz, 'PLAINS', SEED);
    const k = r.plant ?? (r.tree ? `tree:${r.tree.type}` : '(空)');
    cnt.set(k, (cnt.get(k) || 0) + 1);
  }
  return cnt;
}

/** 既有档位的冻结比例（百分点，N=400000 实测；改档位就会红）。
 *  方块名含下划线 ⇒ 键必须加引号（否则 camelcase 规则报 warning）。 */
const FROZEN_PCT = {
  'short_grass': 5.000,
  'azure_bluet': 1.668,
  'allium': 1.629,
  'flower': 1.610,
  'dead_bush': 1.476,
  'oxeye_daisy': 0.991,
  'tree:default': 0.515,
  'red_mushroom': 0.500,
};

test('PLAINS：bush_grass 逐格概率 ≈5%（双侧钉界 4.5%~5.5%）', () => {
  const cnt = samplePlains();
  const n = cnt.get('bush_grass') || 0;
  const pct = n / N * 100;
  assertTrue(pct > 4.5 && pct < 5.5,
    `bush_grass ${n}/${N} = ${pct.toFixed(3)}%，应落 4.5%~5.5%（与 short_grass 同概率）`);
});

test('PLAINS：bush_grass 与 short_grass 的密度差 <0.2 个百分点', () => {
  const cnt = samplePlains();
  const bush = (cnt.get('bush_grass') || 0) / N * 100;
  const short = (cnt.get('short_grass') || 0) / N * 100;
  assertTrue(Math.abs(bush - short) < 0.2,
    `bush ${bush.toFixed(3)}% vs short ${short.toFixed(3)}%，差应 <0.2 点（同等概率）`);
});

test('PLAINS：既有 8 个档位的比例逐位不变（新分支不得吃掉谁的份额）', () => {
  const cnt = samplePlains();
  for (const [name, frozen] of Object.entries(FROZEN_PCT)) {
    const pct = (cnt.get(name) || 0) / N * 100;
    assertTrue(Math.abs(pct - frozen) < 0.05,
      `${name} 比例 ${pct.toFixed(3)}% 偏离冻结值 ${frozen}% 超过 0.05 点 —— 新分支吃掉了它的份额`);
  }
});

test('PLAINS：全部档位 + 空档 = 100%（无落空、无重复计数）', () => {
  const cnt = samplePlains();
  let sum = 0;
  for (const v of cnt.values()) sum += v;
  assertEqual(sum, N, '每格恰好一个归类');
});

test('PLAINS：草总量确实翻倍（short_grass + bush_grass ≈ 10%）', () => {
  const cnt = samplePlains();
  const total = ((cnt.get('short_grass') || 0) + (cnt.get('bush_grass') || 0)) / N * 100;
  assertTrue(total > 9.5 && total < 10.5,
    `两种草合计 ${total.toFixed(3)}%，应 ≈10%（用户裁定「各 5%，草总量翻倍」）`);
});

test('DESERT / SWAMP / FOREST / AZALEA 不长 bush_grass（只长在草地）', () => {
  for (const biome of ['DESERT', 'SWAMP', 'FOREST', 'AZALEA']) {
    let n = 0;
    for (let i = 0; i < 20000; i++) {
      const wx = (i % 200) - 100, wz = Math.floor(i / 200) - 50;
      const r = rollVegetation(wx, wz, biome, SEED);
      if (r.plant === 'bush_grass') n++;
    }
    assertEqual(n, 0, `${biome} 不该长 bush_grass`);
  }
});