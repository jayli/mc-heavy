// tools/nbt-reader.mjs — 最小 NBT 读取器（只实现 tag 1~12），供烘焙脚本共用
//
// 抽自 tools/bake-giant-trees.mjs（巨树烘焙），现被两个烘焙脚本共用：
//   · tools/bake-giant-trees.mjs（Sponge Schematic v3 的 .schem）
//   · tools/bake-cloudland-mesa.mjs（同一格式的云岛素材）
//
// ⚠️ 这是离线烘焙工具，**不进运行期**（Worker / 页面都不 import 它）。
// 红线 1：两个烘焙脚本共用这一份实现，不得各抄一份（会漂移出「同一个 .schem 两个脚本读出不同数据」）。

export class NbtReader {
  constructor(buf) { this.b = buf; this.o = 0; }
  u1() { return this.b[this.o++]; }
  i1() { const v = this.b.readInt8(this.o); this.o += 1; return v; }
  i2() { const v = this.b.readInt16BE(this.o); this.o += 2; return v; }
  i4() { const v = this.b.readInt32BE(this.o); this.o += 4; return v; }
  i8() { const v = this.b.readBigInt64BE(this.o); this.o += 8; return v; }
  f4() { const v = this.b.readFloatBE(this.o); this.o += 4; return v; }
  f8() { const v = this.b.readDoubleBE(this.o); this.o += 8; return v; }
  str() { const n = this.b.readUInt16BE(this.o); this.o += 2; const s = this.b.toString('utf8', this.o, this.o + n); this.o += n; return s; }
  payload(t) {
    switch (t) {
      case 1: return this.i1();
      case 2: return this.i2();
      case 3: return this.i4();
      case 4: return this.i8();
      case 5: return this.f4();
      case 6: return this.f8();
      case 7: { const n = this.i4(); const v = this.b.subarray(this.o, this.o + n); this.o += n; return v; }
      case 8: return this.str();
      case 9: { const it = this.u1(); const n = this.i4(); const a = []; for (let i = 0; i < n; i++) a.push(this.payload(it)); return a; }
      case 10: { const o = {}; for (;;) { const tt = this.u1(); if (tt === 0) break; const k = this.str(); o[k] = this.payload(tt); } return o; }
      case 11: { const n = this.i4(); const a = new Int32Array(n); for (let i = 0; i < n; i++) a[i] = this.i4(); return a; }
      case 12: { const n = this.i4(); const a = []; for (let i = 0; i < n; i++) a.push(this.i8()); return a; }
      default: throw new Error(`NBT: 未知 tag ${t}`);
    }
  }
}
