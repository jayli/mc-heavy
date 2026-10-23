// ⚠️ v1.2：本附录是**算法的独立可复现参考**；落地形态见 `appendix-f-reference/tools/redcity-schematic.mjs`（计划以后者为准）。
// 附录 A：schematic 读取（最小 NBT 读取器）
//
// 来源：RedCity 评审会话的参考实现（评审会话临时目录，不入库），已验证可复现烘焙数字。
// 只依赖 node 内置模块（fs / zlib），不引入 NBT 三方库 —— 与仓库「无新增依赖」口径一致。
//
// 输入：WorldEdit schematic（Minecraft 1.12.2，`DataVersion 1343`，gzip 压缩 NBT）。
// 输出：`{ W, H, L, grid, idx }`，grid 是 Uint16Array，每格 = `(id << 4) | meta`。
//
// ⚠️ `AddBlocks` 是 1.12 schematic 的**高位扩展**：id > 255 时低 8 位在 `Blocks`、
// 高 4 位在 `AddBlocks`（每字节装两格，偶数下标取低半字节、奇数取高半字节）。
// 本模型 id 最大 252 → 实际没有 AddBlocks，但读取器必须支持，否则换一个模型就静默错位。
import fs from 'node:fs';
import zlib from 'node:zlib';

/** 仓库内的 schematic 副本（烘焙输入，与 `assets/sky/night-src/` 同口径入库） */
export const SCHEM_PATH = new URL('../../../../assets/redcity/src/SakuraSpawn.schematic', import.meta.url).pathname;

/**
 * 读取 schematic。
 * @param {string} [path] 覆盖默认路径（单测用合成数据时传）
 * @returns {{W: number, H: number, L: number, grid: Uint16Array, idx: (x:number,y:number,z:number)=>number}}
 */
export function loadSchematic(path = SCHEM_PATH) {
  const raw = zlib.gunzipSync(fs.readFileSync(path));
  let p = 0;

  const readTag = (type) => {
    switch (type) {
      case 1: return raw.readInt8(p++);
      case 2: { const v = raw.readInt16BE(p); p += 2; return v; }
      case 3: { const v = raw.readInt32BE(p); p += 4; return v; }
      case 4: { const v = raw.readBigInt64BE(p); p += 8; return v; }
      case 5: { const v = raw.readFloatBE(p); p += 4; return v; }
      case 6: { const v = raw.readDoubleBE(p); p += 8; return v; }
      case 7: { const n = raw.readInt32BE(p); p += 4; const b = raw.subarray(p, p + n); p += n; return b; }
      case 8: { const n = raw.readUInt16BE(p); p += 2; const s = raw.toString('utf8', p, p + n); p += n; return s; }
      case 9: { const t = raw.readInt8(p++); const n = raw.readInt32BE(p); p += 4; const a = []; for (let i = 0; i < n; i++) a.push(readTag(t)); return a; }
      case 10: {
        const o = {};
        for (;;) {
          const t = raw.readInt8(p++);
          if (t === 0) break;
          const nl = raw.readUInt16BE(p); p += 2;
          const name = raw.toString('utf8', p, p + nl); p += nl;
          o[name] = readTag(t);
        }
        return o;
      }
      case 11: { const n = raw.readInt32BE(p); p += 4; const a = []; for (let i = 0; i < n; i++) { a.push(raw.readInt32BE(p)); p += 4; } return a; }
      case 12: { const n = raw.readInt32BE(p); p += 4; const a = []; for (let i = 0; i < n; i++) { a.push(raw.readBigInt64BE(p)); p += 8; } return a; }
      default: throw new Error(`redcity: 未知 NBT tag 类型 ${type} @${p}`);
    }
  };

  const rootType = raw.readInt8(p++);
  const nameLen = raw.readUInt16BE(p); p += 2 + nameLen;   // 根 compound 的名字（'Schematic'），跳过
  const root = readTag(rootType);

  const W = root.Width, H = root.Height, L = root.Length;
  if (!W || !H || !L) throw new Error('redcity: schematic 缺 Width/Height/Length');
  const blocks = root.Blocks, data = root.Data, add = root.AddBlocks;
  if (!blocks || !data) throw new Error('redcity: schematic 缺 Blocks/Data');

  const N = W * H * L;
  if (blocks.length !== N || data.length !== N) {
    throw new Error(`redcity: Blocks/Data 长度 ${blocks.length}/${data.length} 与 W*H*L=${N} 不符`);
  }

  const grid = new Uint16Array(N);
  for (let i = 0; i < N; i++) {
    let id = blocks[i] & 0xff;
    if (add) id |= ((i & 1) ? (add[i >> 1] >> 4) : (add[i >> 1] & 0xf)) << 8;
    grid[i] = (id << 4) | (data[i] & 0xf);
  }
  return { W, H, L, grid, idx: (x, y, z) => (y * L + z) * W + x };
}

/** 1.12 方块名（仅本模型涉及的 id；诊断/日志用，不参与烘焙判定） */
export const MC_NAMES = Object.freeze({
  0: 'air', 1: 'stone', 2: 'grass', 3: 'dirt', 4: 'cobblestone', 5: 'planks', 7: 'bedrock', 9: 'water',
  12: 'sand', 13: 'gravel', 16: 'coal_ore', 17: 'log', 18: 'leaves', 20: 'glass', 24: 'sandstone',
  25: 'noteblock', 35: 'wool', 37: 'dandelion', 43: 'double_stone_slab', 44: 'stone_slab',
  48: 'mossy_cobblestone', 50: 'torch', 53: 'oak_stairs', 54: 'chest', 59: 'wheat', 60: 'farmland',
  63: 'standing_sign', 64: 'wooden_door', 67: 'stone_stairs', 80: 'snow', 82: 'clay', 85: 'fence',
  88: 'soul_sand', 95: 'stained_glass', 96: 'trapdoor', 98: 'stonebrick', 99: 'brown_mushroom_block',
  102: 'glass_pane', 109: 'stonebrick_stairs', 118: 'cauldron', 125: 'double_wooden_slab',
  126: 'wooden_slab', 134: 'spruce_stairs', 139: 'cobblestone_wall', 141: 'carrots', 142: 'potatoes',
  145: 'anvil', 154: 'hopper', 159: 'stained_hardened_clay', 160: 'stained_glass_pane', 162: 'log2',
  164: 'dark_oak_stairs', 166: 'barrier', 168: 'prismarine', 175: 'double_plant', 188: 'spruce_fence',
  198: 'end_rod', 208: 'grass_path', 251: 'concrete', 252: 'concrete_powder',
});

/** `(id<<4)|meta` → 可读名（诊断用） */
export function describeKey(key) {
  const id = key >> 4, meta = key & 15;
  return `${id}:${meta}(${MC_NAMES[id] ?? '?'})`;
}

// ==================== 自检（跑本文件即执行）====================

if (process.argv[1] && process.argv[1].endsWith('appendix-a-schematic.mjs')) {
  const t0 = Date.now();
  const sch = loadSchematic();
  const ms = Date.now() - t0;
  console.log(`读取 ${ms} ms：W=${sch.W} H=${sch.H} L=${sch.L}，grid=${sch.grid.length}`);

  // 期望值（评审会话实测；schematic 换文件后会变）
  const expect = { W: 347, H: 256, L: 431 };
  let ok = true;
  for (const [k, v] of Object.entries(expect)) {
    if (sch[k] !== v) { console.log(`✗ ${k}: 实测 ${sch[k]} ≠ 期望 ${v}`); ok = false; }
  }
  if (sch.grid.length !== sch.W * sch.H * sch.L) { console.log('✗ grid 长度与 W*H*L 不符'); ok = false; }

  // 关键格抽查：这些是后续烘焙判据的输入，读错会静默污染全链。
  // 期望值由**独立解析器**（不复用本文件的读取器）交叉验证得出，不是拍脑袋。
  const probe = [
    [175, 210, 109, 126, 5],   // 中心圆亭顶：木半砖
    [188, 211, 74, 252, 8],    // 岛体主材：灰色混凝土粉末
    [213, 104, 87, 35, 13],    // 岛面草坪：绿羊毛
  ];
  for (const [x, z, wantY, wantId, wantMeta] of probe) {
    // 该列自上而下第一个非空非 barrier 格
    let got = null;
    for (let y = sch.H - 1; y >= 0; y--) {
      const key = sch.grid[sch.idx(x, y, z)];
      const id = key >> 4;
      if (id !== 0 && id !== 166) { got = { y, id, meta: key & 15 }; break; }
    }
    if (!got) { console.log(`✗ (${x},${z}) 列为空`); ok = false; continue; }
    if (got.y !== wantY || got.id !== wantId || got.meta !== wantMeta) {
      console.log(`✗ (${x},${z}) 顶格 y=${got.y} ${got.id}:${got.meta} ≠ 期望 y=${wantY} ${wantId}:${wantMeta}`);
      ok = false;
    }
  }

  // barrier 必须被读到（烘焙靠 isEmpty 丢弃它，读不到就会当成方块保留）
  let barriers = 0;
  for (let i = 0; i < sch.grid.length; i++) if ((sch.grid[i] >> 4) === 166) barriers++;
  console.log(`barrier(166) 块数 ${barriers}（期望 17804）`);
  if (barriers !== 17804) { console.log('✗ barrier 计数不符'); ok = false; }

  console.log(ok ? '✓ schematic 读取正确' : '✗ 有偏差（见上）');
}
