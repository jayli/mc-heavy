// src/tests/test-shallow-water-bridge.js — 浅水高台跨湖拱桥：纯函数层 + 栅格化层
//
// 权威：docs/superpowers/specs/2026-11-01-shallow-water-tarns-design.md §15
import { test } from './runner.js';
import {
  assertEqual, assertTrue, assertNotNull, assertNotEqual, assertFalse,
} from './assert.js';
import { SEA_Y, blockIndex, WORLD_MIN_Y, WORLD_MAX_Y } from '../voxel/constants.js';
import { ChunkColumn } from '../voxel/chunk-column.js';
import { fillColumn } from '../gen/terrain.js';
import { carveCaves } from '../gen/caves.js';
import { BLOCKS } from '../voxel/blocks-data.js';
import { createRegistry } from '../voxel/block-registry.js';
import {
  computeShallowTarnAnchor, clearShallowTarnCache,
} from '../gen/structures/shallow-water-tarns.js';
import { shallowTarnSurfaceYAt, clearShallowTarnTerrainCache } from '../gen/structures/shallow-water-terrain.js';
import {
  computeShallowTarnBridge, shallowTarnBridgeDeckY,
  clearShallowTarnBridgeCache, BRIDGE_APEX_Y, BRIDGE_MIN_CLEARANCE, BRIDGE_SALT,
  BRIDGE_MATERIALS, BRIDGE_SEG_MIN_LEN, BRIDGE_SEG_SCALE, BRIDGE_WIDTH, shallowTarnBridgeBlockAt,
  bridgeSegments, bridgeRawSegmentLengths, rasterizeShallowTarnBridge,
} from '../gen/structures/shallow-water-bridge.js';

const BRIDGE_HALF = (BRIDGE_WIDTH - 1) / 2;   // 宽度从模块派生（红线 1）

const SEEDS = [12345, 1, 2, 88, 20240101, 424242, 5150, 7, 999, 2026];

/** 供多组用例复用的 registry（模块级单例，136+ 方块；Task 3 起用到） */
let registryCache = null;
function registry() {
  if (registryCache) return registryCache;
  const reg = createRegistry();
  for (const def of BLOCKS) reg.register(def.name, def);
  reg.freeze();
  registryCache = reg;
  return reg;
}

// ==================== 桥轴（§15.2） ====================

test('桥：每个 seed 都有合法桥轴', () => {
  for (const seed of SEEDS) {
    const bridge = computeShallowTarnBridge(seed, new Map());
    assertNotNull(bridge, `seed ${seed} 没有合法桥轴`);
  }
});

test('桥：轴恰好是 +X 或 +Z 之一（吸附正轴）', () => {
  for (const seed of SEEDS) {
    const b = computeShallowTarnBridge(seed, new Map());
    const isUnitX = Math.abs(b.ux) === 1 && b.uz === 0;
    const isUnitZ = b.ux === 0 && Math.abs(b.uz) === 1;
    assertTrue(isUnitX || isUnitZ, `seed ${seed}: (ux, uz) = (${b.ux}, ${b.uz}) 不是正轴`);
    assertEqual(b.axis, isUnitX ? 'X' : 'Z', `seed ${seed}: axis 字段与 (ux,uz) 不一致`);
  }
});

test('桥：两端落点是干燥地面（地表 ≥ SEA_Y）', () => {
  for (const seed of SEEDS) {
    const b = computeShallowTarnBridge(seed, new Map());
    assertTrue(b.endYP >= SEA_Y, `seed ${seed}: +侧落点 y=${b.endYP} < SEA_Y`);
    assertTrue(b.endYN >= SEA_Y, `seed ${seed}: -侧落点 y=${b.endYN} < SEA_Y`);
  }
});

test('桥：跨度落在实测区间（160~205 格）', () => {
  for (const seed of SEEDS) {
    const b = computeShallowTarnBridge(seed, new Map());
    assertTrue(b.span >= 160 && b.span <= 205, `seed ${seed}: span=${b.span} 超出 160~205`);
    assertEqual(b.span, b.halfP + b.halfN, `seed ${seed}: span 应等于 halfP + halfN`);
  }
});

test('桥：弧顶高度 = BRIDGE_APEX_Y', () => {
  assertEqual(BRIDGE_APEX_Y, 47);
  for (const seed of SEEDS) {
    const b = computeShallowTarnBridge(seed, new Map());
    assertEqual(b.apex, BRIDGE_APEX_Y, `seed ${seed}: apex 应为 ${BRIDGE_APEX_Y}`);
  }
});

test('桥：同一 seed 两次调用逐字段相同（确定性 + 缓存不破坏纯函数性）', () => {
  for (const seed of SEEDS) {
    const a = computeShallowTarnBridge(seed, new Map());
    const c = computeShallowTarnBridge(seed, new Map());
    assertEqual(JSON.stringify(a), JSON.stringify(c), `seed ${seed}: 两次调用结果不同`);
  }
});

test('桥：净空不足时该轴被判非法（注入高墙的负向对照）', () => {
  const seed = 12345;
  const b = computeShallowTarnBridge(seed, new Map());
  const anchor = computeShallowTarnAnchor(seed);
  // 沿**两条轴都**堆一道比桥面还高的墙 → 应返回 null
  const blocked = new Map();
  for (const [ux, uz] of [[1, 0], [0, 1]]) {
    for (let s = -110; s <= 110; s++) {
      for (let off = -BRIDGE_HALF; off <= BRIDGE_HALF; off++) {
        const x = anchor.wx + ux * s + (-uz) * off;
        const z = anchor.wz + uz * s + ux * off;
        blocked.set(`${x},${z}`, BRIDGE_APEX_Y + 10);
      }
    }
  }
  assertEqual(computeShallowTarnBridge(seed, blocked), null,
    '两条轴都被超高墙挡住时应返回 null（否则桥会钻进墙体）');
  assertNotNull(b, '未注入障碍时该 seed 应有合法轴');
});

test('桥：一条轴被高墙挡住时是**回退到另一条**，不是整体 null', () => {
  // ⚠️ 这条是「逐轴尝试 vs 一条失败即整体 null」的唯一判别用例。
  // 未注入障碍时每个 seed 恰好只有**一条**轴可用（实测 10 seed 全部如此），
  // 所以把 `continue` 改成 `return null` 在无干扰输入下**行为相同** ——
  // 必须主动遮住「胜出的那条轴」，才能区分两种实现。
  const seed = 5150;                       // 该 seed 的两条轴都合法，适合做回退对照
  const anchor = computeShallowTarnAnchor(seed);
  const free = computeShallowTarnBridge(seed, new Map());
  assertNotNull(free, 'seed 5150 未注入障碍时应有桥');
  // ⚠️ **遮住的那一段必须避开湖心（s=0）**：两条正轴在湖心交叉，
  // 任何包含 s=0 的遮挡盒都会把另一条轴的中心线也盖上（实测恒为 3 格）→
  // 两条轴同时死，区分不了「回退」与「整体 null」。
  const blocked = new Map();
  const nx = -free.uz;
  const nz = free.ux;
  for (let s = 40; s <= 70; s++) {
    for (let off = -BRIDGE_HALF; off <= BRIDGE_HALF; off++) {
      const x = anchor.wx + free.ux * s + nx * off;
      const z = anchor.wz + free.uz * s + nz * off;
      blocked.set(`${x},${z}`, BRIDGE_APEX_Y + 10);
    }
  }
  const fallback = computeShallowTarnBridge(seed, blocked);
  assertNotNull(fallback, '一条轴被挡时应回退到另一条轴，而不是返回 null');
  assertNotEqual(fallback.axis, free.axis, '应回退到与被挡那条不同的轴');
});

test('桥：净空判据的阈值是 BRIDGE_MIN_CLEARANCE', () => {
  assertEqual(BRIDGE_MIN_CLEARANCE, 3);
  assertTrue(BRIDGE_MIN_CLEARANCE > 0 && BRIDGE_MIN_CLEARANCE < 10);
});

test('桥：缓存隔离 —— clearShallowTarnCache 之后结果不变（纯函数）', () => {
  const seed = 12345;
  const before = JSON.stringify(computeShallowTarnBridge(seed, new Map()));
  clearShallowTarnCache();
  clearShallowTarnTerrainCache();
  clearShallowTarnBridgeCache();
  const after = JSON.stringify(computeShallowTarnBridge(seed, new Map()));
  assertEqual(after, before, '清缓存后桥轴变了 → 说明有非纯函数状态泄漏');
});

test('桥：salt 是 1038（程序化扫描确认空闲）', () => {
  assertEqual(BRIDGE_SALT, 1038);
});

// ==================== 剖面可步行性（§15.3） ====================

test('桥：剖面相邻两列高差 ≤ 1（玩家能走上去，MAX_STEP = 1.0）', () => {
  for (const seed of SEEDS) {
    const b = computeShallowTarnBridge(seed, new Map());
    let prev = null;
    for (let s = -b.halfN; s <= b.halfP; s++) {
      const y = shallowTarnBridgeDeckY(s, b);
      if (prev !== null) {
        assertTrue(Math.abs(y - prev) <= 1,
          `seed ${seed}: s=${s} 处高差 ${Math.abs(y - prev)} > 1（玩家走不上去）`);
      }
      prev = y;
    }
  }
});

test('桥：湖心是弧顶、两端是落点地表（剖面端点值）', () => {
  for (const seed of SEEDS) {
    const b = computeShallowTarnBridge(seed, new Map());
    assertEqual(shallowTarnBridgeDeckY(0, b), BRIDGE_APEX_Y, `seed ${seed}: s=0 不是弧顶`);
    assertEqual(shallowTarnBridgeDeckY(b.halfP, b), b.endYP, `seed ${seed}: +端不是落点地表`);
    assertEqual(shallowTarnBridgeDeckY(-b.halfN, b), b.endYN, `seed ${seed}: -端不是落点地表`);
  }
});

test('桥：剖面单调 —— 从任一端走向湖心不出现下降', () => {
  for (const seed of SEEDS) {
    const b = computeShallowTarnBridge(seed, new Map());
    let prev = shallowTarnBridgeDeckY(-b.halfN, b);
    for (let s = -b.halfN + 1; s <= 0; s++) {
      const y = shallowTarnBridgeDeckY(s, b);
      assertTrue(y >= prev, `seed ${seed}: 从 -端 走向湖心在 s=${s} 处下降了`);
      prev = y;
    }
  }
});

test('桥：整座桥全程都在地表之上（不埋进地形）', () => {
  for (const seed of SEEDS) {
    const b = computeShallowTarnBridge(seed, new Map());
    const anchor = computeShallowTarnAnchor(seed);
    for (let s = -b.halfN; s <= b.halfP; s++) {
      const y = shallowTarnBridgeDeckY(s, b);
      for (let off = -1; off <= 1; off++) {
        const x = anchor.wx + b.ux * s + (-b.uz) * off;
        const z = anchor.wz + b.uz * s + b.ux * off;
        const ground = shallowTarnSurfaceYAt(x, z, seed, anchor);
        assertTrue(y >= ground, `seed ${seed}: s=${s} off=${off} 桥面 y=${y} 低于地表 ${ground}`);
      }
    }
  }
});

// ==================== 材质分片（§15.6） ====================

test('桥：材质只取六种已声明的方块', () => {
  assertEqual(BRIDGE_MATERIALS.length, 6);
  const legal = new Set(BRIDGE_MATERIALS);
  for (const seed of SEEDS) {
    const b = computeShallowTarnBridge(seed, new Map());
    for (let s = -b.halfN; s <= b.halfP; s++) {
      const name = shallowTarnBridgeBlockAt(s, b, seed);
      assertTrue(legal.has(name), `seed ${seed} s=${s}: 材质 "${name}" 不在六种之内`);
    }
  }
});

test('桥：材质必须是既有方块且全部走 opaque 通道（静态内存零增量）', () => {
  for (const name of BRIDGE_MATERIALS) {
    const def = BLOCKS.find((x) => x.name === name);
    assertNotNull(def, `材质 ${name} 未在 blocks-data.js 注册（makeColumnSetter 会静默 return）`);
    assertEqual(def.cullMode, 'opaque', `${name} 的 cullMode 应为 opaque（否则撞容量预算）`);
  }
});

test('桥：材质里没有叶子方块（用户明确要求「用非叶子方块」）', () => {
  for (const name of BRIDGE_MATERIALS) {
    assertFalse(/leaves|flower|azalea/.test(name), `材质 ${name} 是叶子族，违反用户要求`);
  }
});

test('桥：相邻两片材质必不同色', () => {
  for (const seed of SEEDS) {
    const b = computeShallowTarnBridge(seed, new Map());
    const segs = bridgeSegments(b, seed);
    for (let i = 1; i < segs.length; i++) {
      assertNotEqual(segs[i].material, segs[i - 1].material,
        `seed ${seed}: 第 ${i - 1}/${i} 片同为 ${segs[i].material}`);
    }
  }
});

test('桥：片长 ≥ BRIDGE_SEG_MIN_LEN（首尾被截断的除外）', () => {
  for (const seed of SEEDS) {
    const b = computeShallowTarnBridge(seed, new Map());
    const segs = bridgeSegments(b, seed);
    for (let i = 1; i < segs.length - 1; i++) {
      assertTrue(segs[i].len >= BRIDGE_SEG_MIN_LEN,
        `seed ${seed}: 第 ${i} 片长 ${segs[i].len} < ${BRIDGE_SEG_MIN_LEN}`);
    }
  }
});

test('桥：六种材质都出现过（不是退化成两三种）', () => {
  const seen = new Set();
  for (const seed of SEEDS) {
    const b = computeShallowTarnBridge(seed, new Map());
    for (let s = -b.halfN; s <= b.halfP; s++) seen.add(shallowTarnBridgeBlockAt(s, b, seed));
  }
  for (const name of BRIDGE_MATERIALS) {
    assertTrue(seen.has(name), `材质 ${name} 在 10 个 seed 里一次都没出现`);
  }
});

test('桥：游程合并真的生效 —— 合并前存在 <8 片段，合并后一个不剩', () => {
  // ⚠️ 这条是 `BRIDGE_SEG_MIN_LEN` 的**唯一判别用例**。
  // 只断言「最终片长 ≥ 8」时，把 MIN_LEN 改成 1 也全绿（实测）：原始场本身只有
  // 9.3% 的片段 <8，且它们大多与相邻短片段合并后自然超过 8 → 断言对阈值不敏感。
  // 这里用「绕开合并重算一遍」的方式直接证明合并确实在起作用。
  let rawShort = 0;
  for (const seed of SEEDS) {
    const b = computeShallowTarnBridge(seed, new Map());
    const raw = bridgeRawSegmentLengths(b, seed);
    for (let i = 1; i < raw.length - 1; i++) if (raw[i] < BRIDGE_SEG_MIN_LEN) rawShort++;
  }
  assertTrue(rawShort > 0, '原始分片里一个 <8 的片段都没有 → 本用例失去判别力，需换 seed 组');
  const segs = bridgeSegments(computeShallowTarnBridge(SEEDS[0], new Map()), SEEDS[0]);
  for (let i = 1; i < segs.length - 1; i++) {
    assertTrue(segs[i].len >= BRIDGE_SEG_MIN_LEN, '合并后仍有 <8 的片段');
  }
});

test('桥：分片不是逐格棋盘（同色游程的中位长度 > 4）', () => {
  const lens = [];
  for (const seed of SEEDS) {
    const b = computeShallowTarnBridge(seed, new Map());
    const segs = bridgeSegments(b, seed);
    for (let i = 1; i < segs.length - 1; i++) lens.push(segs[i].len);
  }
  lens.sort((a, b) => a - b);
  const median = lens[Math.floor(lens.length / 2)];
  assertTrue(median > 4, `同色游程中位长度 ${median} ≤ 4 → 退化成棋盘噪点`);
});

// ==================== 栅格化（§15.4） ====================

test('桥：真实 column GEN —— 桥面在三个 column 里都写出来了', () => {
  const seed = 12345;
  const anchor = computeShallowTarnAnchor(seed);
  const b = computeShallowTarnBridge(seed, new Map());
  const reg = registry();
  const cols = [-40, 0, 40].map((ds) => {
    const x = anchor.wx + b.ux * ds;
    const z = anchor.wz + b.uz * ds;
    return [Math.floor(x / 16), Math.floor(z / 16)];
  });
  let written = 0;
  for (const [cx, cz] of cols) {
    const col = new ChunkColumn(cx, cz);
    const seen = [];
    const setBlock = (wx, y, wz, name) => {
      seen.push({ wx, y, wz, name });
      col.blocks[blockIndex(wx - cx * 16, y, wz - cz * 16)] = reg.idOf(name);
    };
    rasterizeShallowTarnBridge(col, anchor, seed, reg, setBlock, new Map());
    written += seen.length;
    for (const cell of seen) {
      assertTrue(BRIDGE_MATERIALS.includes(cell.name), `写入了非桥材质 ${cell.name}`);
      assertEqual(col.blocks[blockIndex(cell.wx - cx * 16, cell.y, cell.wz - cz * 16)],
        reg.idOf(cell.name), 'setBlock 与 column 实际内容不一致');
    }
  }
  assertTrue(written > 0, '三个 column 里一个桥面格都没写出来（栅格化没接线）');
});

test('桥：单层 —— 桥面格的上方与下方都不是桥材质', () => {
  const seed = 12345;
  const anchor = computeShallowTarnAnchor(seed);
  const reg = registry();
  const cx = Math.floor(anchor.wx / 16);
  const cz = Math.floor(anchor.wz / 16);
  const col = new ChunkColumn(cx, cz);
  const setBlock = (wx, y, wz, name) => {
    col.blocks[blockIndex(wx - cx * 16, y, wz - cz * 16)] = reg.idOf(name);
  };
  rasterizeShallowTarnBridge(col, anchor, seed, reg, setBlock, new Map());
  const matIds = new Set(BRIDGE_MATERIALS.map((n) => reg.idOf(n)));
  let deckCells = 0;
  for (let lx = 0; lx < 16; lx++) {
    for (let lz = 0; lz < 16; lz++) {
      for (let y = WORLD_MIN_Y + 1; y < WORLD_MAX_Y - 1; y++) {
        const id = col.blocks[blockIndex(lx, y, lz)];
        if (!matIds.has(id)) continue;
        deckCells++;
        assertFalse(matIds.has(col.blocks[blockIndex(lx, y + 1, lz)]),
          `桥面 y=${y} 上方也写了桥材质（双层）`);
        assertFalse(matIds.has(col.blocks[blockIndex(lx, y - 1, lz)]),
          `桥面 y=${y} 下方也写了桥材质（双层）`);
      }
    }
  }
  assertTrue(deckCells > 0, '本 column 没有任何桥面格');
});

test('桥：3 格宽 —— 每一行（沿轴）恰好三格，不多不少', () => {
  // ⚠️⚠️ **本用例必须钉绝对宽度 3，不能从 `BRIDGE_WIDTH` 派生**。
  // 派生过一次，实测把 `BRIDGE_WIDTH` 改成 5 时它仍然全绿：实现写了 5 格，
  // 测试也去数 5 格 —— 两边共用同一个变量，等于根本没测宽度。
  // 用户的原始要求是「三个方块宽」（2026-11-03 原话），这是一个**外部契约**，
  // 不是实现的内部常量：实现改了就该红，而不是跟着改期望。
  const WANT_WIDTH = 3;
  const seed = 12345;
  const anchor = computeShallowTarnAnchor(seed);
  const b = computeShallowTarnBridge(seed, new Map());
  const reg = registry();
  const cx = Math.floor(anchor.wx / 16);
  const cz = Math.floor(anchor.wz / 16);
  const col = new ChunkColumn(cx, cz);
  // ⚠️ **必须逐行收集，不能用累加集合**：相邻 s 的 off=+1 格可能正好是下一个 s 的 off=-1 格，
  // 累加后「只写中线」的注入也会全绿（实测踩到过）。
  const byRow = new Map();
  const setBlock = (wx, y, wz, name) => {
    col.blocks[blockIndex(wx - cx * 16, y, wz - cz * 16)] = reg.idOf(name);
    if (!byRow.has(y)) byRow.set(y, new Set());
    byRow.get(y).add(`${wx},${wz}`);
  };
  rasterizeShallowTarnBridge(col, anchor, seed, reg, setBlock, new Map());
  let checked = 0;
  // 逐行：该行在**本 column 内**的桥面格数必须恰好等于「落在本列的期望宽度段」
  for (let s = -b.halfN; s <= b.halfP; s++) {
    const y = shallowTarnBridgeDeckY(s, b);
    const row = byRow.get(y);
    if (!row) continue;
    const cells = [];
    for (let off = -(WANT_WIDTH - 1) / 2; off <= (WANT_WIDTH - 1) / 2; off++) {
      const x = anchor.wx + b.ux * s + (-b.uz) * off;
      const z = anchor.wz + b.uz * s + b.ux * off;
      if (x < cx * 16 || x > cx * 16 + 15 || z < cz * 16 || z > cz * 16 + 15) continue;
      cells.push(`${x},${z}`);
    }
    if (cells.length < WANT_WIDTH) continue;   // 跨 column 边界的行不参与
    checked++;
    for (const key of cells) {
      assertTrue(row.has(key), `s=${s} 缺法向格 ${key}`);
    }
  }
  assertTrue(checked > 0, '本 column 内没有一行三格完整的桥面（取样落空）');

  // ② **反向**：`BRIDGE_WIDTH` 必须就是 3，且法向再往外一格**不能**是桥面。
  //    这一半才是「不多不少」的量纲所在 —— 只数「该有的都在」拓不到「多写了」。
  assertEqual(BRIDGE_WIDTH, WANT_WIDTH, 'BRIDGE_WIDTH 偏离了用户要求的「三个方块宽」');
  const matIds = new Set(BRIDGE_MATERIALS.map((n) => reg.idOf(n)));
  let overflow = 0;
  for (let s = -b.halfN; s <= b.halfP; s++) {
    const y = shallowTarnBridgeDeckY(s, b);
    for (const off of [(WANT_WIDTH + 1) / 2, -(WANT_WIDTH + 1) / 2]) {
      const x = anchor.wx + b.ux * s + (-b.uz) * off;
      const z = anchor.wz + b.uz * s + b.ux * off;
      if (x < cx * 16 || x > cx * 16 + 15 || z < cz * 16 || z > cz * 16 + 15) continue;
      if (matIds.has(col.blocks[blockIndex(x - cx * 16, y, z - cz * 16)])) overflow++;
    }
  }
  assertEqual(overflow, 0, `桥面比 ${WANT_WIDTH} 格宽（法向再外一格也有 ${overflow} 个桥材质）`);
});


// ==================== 接线（apply 阶段 2.45 第 ⑤ 步） ====================

test('桥：真实 applyStructuresToColumn 把桥写进世界（接线门）', async () => {
  const { computeRegionLayout, neighborRegionKeys } = await import('../gen/structures/structure-layout.js');
  const { applyStructuresToColumn } = await import('../gen/structures/apply.js');
  const seed = 12345;
  const anchor = computeShallowTarnAnchor(seed);
  const reg = registry();
  const cx = Math.floor(anchor.wx / 16);
  const cz = Math.floor(anchor.wz / 16);
  const col = new ChunkColumn(cx, cz);
  fillColumn(col, seed, reg);
  carveCaves(col, seed);
  const layouts = neighborRegionKeys(cx, cz).map((key) => {
    const [rx, rz] = key.split(',').map(Number);
    return computeRegionLayout(rx, rz, seed);
  });
  await applyStructuresToColumn(col, seed, reg, layouts);
  const matIds = new Set(BRIDGE_MATERIALS.map((n) => reg.idOf(n)));
  let hits = 0;
  for (let lx = 0; lx < 16; lx++) {
    for (let lz = 0; lz < 16; lz++) {
      for (let y = BRIDGE_APEX_Y - 5; y <= BRIDGE_APEX_Y + 5; y++) {
        if (matIds.has(col.blocks[blockIndex(lx, y, lz)])) hits++;
      }
    }
  }
  assertTrue(hits >= 3, `湖心 column 在弧顶高度附近只命中 ${hits} 格桥材质（apply 阶段没接线）`);
});
