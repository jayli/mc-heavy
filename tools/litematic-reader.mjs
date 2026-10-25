// tools/litematic-reader.mjs — Litematica `.litematic` 读取（离线烘焙用）
//
// 与 `nbt-reader.mjs` 的分工：那个只做「tag 1~12 → JS 值」的通用解码；本文件在其上
// 做 litematic 特有的两件事 —— **位数组解包**与**索引序换算**。
//
// ## 为什么不能复用 `.schem` 的代码路径
// Sponge `.schem`（`bake-cloudland-mesa.mjs` / `bake-giant-trees.mjs` 读的格式）的方块索引
// 是 **varint 流**；litematic 是**定宽位数组**（`LongArray`，每格 `bits` 位）。两者唯一的
// 共同点是底层都是 NBT。
//
// ## 三个实测确认的口径（不要按格式定义推断）
// ① **位打包跨 long 连续**：一格的 bits 可以跨越 long 边界。我实测过「每 long 塞
//    floor(64/bits) 个、不跨边界」的读法 —— 解出的格数与 `Metadata.TotalBlocks` 不符
//    （60025 格乱码 vs 17966）。跨边界读法解出 17966，与 TotalBlocks 精确相等。
// ② **索引序 = `(y*sz + z)*sx + x`**：用「y=0 层是满铺 49×49 地板」核实（该层 2401 格
//    全是 smooth_sandstone，任何其它索引序都不会呈现这个形状）。
// ③ **尺寸取 `Metadata.EnclosingSize`**：`Regions.<name>.Size` 是本素材里的**负数**
//    （x=-49, y=-25, z=-49），而 EnclosingSize 是正的 49/25/49。
//
// ## 分工：读者只做忠实翻译
// `blocks` 里**保留 barrier 的下标**，不在本文件过滤 —— 过滤是烘焙脚本的职责
// （`giant-pyramid-fingerprint.mjs` 的 `BLOCK_MAP` 把 barrier 映射到空串）。
// 这样 Step 5 的校验才能用「非 0 格数 == TotalBlocks」核对解码口径；
// 若读者提前过滤，那个校验就永远成立、失去判别力。
//
// ⚠️ 离线工具，**不进运行期**（Worker / 页面都不 import 它），与 `nbt-reader.mjs` 同口径。
import zlib from 'node:zlib';
import { NbtReader } from './nbt-reader.mjs';

/**
 * 从已解压的 NBT 里取第一个 region 的名与数据。
 * litematic 可以有多个 region（多选粘贴），本素材实测只有 `'Small Pyramid Maze'` 一个；
 * 多 region 时取第一个并在返回值里带上名字，让烘焙脚本自己决定要不要报警。
 */
function rootOf(buf) {
  const r = new NbtReader(buf);
  const tag = r.u1();
  if (tag !== 10) throw new Error(`litematic: 根 tag 应为 compound(10)，实际 ${tag}`);
  r.str(); // 根节点的空名字
  return r.payload(tag);
}

/**
 * 读 litematic。
 *
 * @param {Buffer} buf `.litematic` 文件内容（**gzip 压缩**）
 * @returns {{
 *   size: {x:number, y:number, z:number},
 *   palette: string[],
 *   blocks: Uint16Array,
 *   regionName: string,
 *   totalBlocks: number,
 *   regionCount: number,
 * }}
 *   `palette[i]` 已剥掉 `minecraft:` 前缀与 `[属性]` 后缀（属性另存于 `paletteProps`，
 *   见下）；`blocks` 长度 = `size.x * size.y * size.z`，索引序 `(y*sz + z)*sx + x`。
 */
export function readLitematic(buf) {
  const root = rootOf(zlib.gunzipSync(buf));
  const md = root.Metadata;
  // ① 尺寸：取 EnclosingSize（Region.Size 可能是负数，见文件头 ③）
  const size = {
    x: Math.abs(md.EnclosingSize.x),
    y: Math.abs(md.EnclosingSize.y),
    z: Math.abs(md.EnclosingSize.z),
  };
  const regionNames = Object.keys(root.Regions);
  if (regionNames.length === 0) throw new Error('litematic: 没有任何 region');
  const regionName = regionNames[0];
  const zone = root.Regions[regionName];

  const rawPalette = zone.BlockStatePalette;
  if (!Array.isArray(rawPalette)) throw new Error('litematic: region 缺 BlockStatePalette');

  // palette 剥前缀/属性；**属性单独保留**（台阶的 shape/facing、半砖的 type 都在这里，
  // 烘焙脚本要靠它们决定目标方块与 meta）
  const palette = rawPalette.map((p) => String(p.Name).replace(/^minecraft:/, '').split('[')[0]);
  const paletteProps = rawPalette.map((p) => (p.Properties ? { ...p.Properties } : null));

  // ② 位宽：至少 2 位（Minecraft 的 litematic 写出口径），上限由 palette 长度决定
  const bits = Math.max(2, Math.ceil(Math.log2(rawPalette.length)));
  const mask = (1n << BigInt(bits)) - 1n;

  // LongArray：NbtReader 的 tag 12 返回 BigInt 数组
  const longs = zone.BlockStates;
  if (!longs || longs.length === 0) throw new Error('litematic: region 缺 BlockStates');
  const asBig = longs.map((v) => BigInt.asUintN(64, BigInt(v)));

  // ③ 位打包**跨 long 连续**（见文件头 ①）
  const total = size.x * size.y * size.z;
  const blocks = new Uint16Array(total);
  for (let i = 0; i < total; i++) {
    const bitPos = i * bits;
    const li = Math.floor(bitPos / 64);
    const off = bitPos - li * 64;
    let v = asBig[li] >> BigInt(off);
    if (off + bits > 64) v |= asBig[li + 1] << BigInt(64 - off);
    blocks[i] = Number(v & mask);
  }

  return {
    size,
    palette,
    paletteProps,
    blocks,
    regionName,
    totalBlocks: Number(md.TotalBlocks),
    regionCount: regionNames.length,
  };
}

/** 索引序换算：world-ish 局部坐标 → blocks 下标（唯一权威，供烘焙脚本复用） */
export function litematicIndex(size, x, y, z) {
  return (y * size.z + z) * size.x + x;
}
