// tools/tectonic-terrain-probe.mjs — Tectonic 2D 子集迁移的离线数值探针（调研报告的可复现依据）
//
// 配套文档：docs/tectonic-terrain-migration-survey.md（§5.C 成本表 / §6 选型表 / §2.5 惰性求值）
// 上游：~/jaylli/tectonic @ 34241bd（3.0.25，MIT）—— 本文件只复刻其 DF 语义，不含上游代码。
//
// ⚠️ **这是调研探针，不是生产实现，也不是冻结基线**：
//   · permutation 表用 LCG 自造（不是 MC 的 seed 派生）；octave 归一化用近似 valueFactor；
//   · shift_x/shift_z（域扭曲）在四族里省略，只在沙丘/山脊里近似；
//   · temperature/vegetation 用自造 Perlin 代替 vanilla 噪声，值域靠 TS 标定。
//   ⇒ 输出的绝对数值是**数量级依据**。落地实现须重测并按 Tier 1 TDD 钉住。
//
// 用法：node tools/tectonic-terrain-probe.mjs [--json]
// 只读：不写任何文件、不改世界、不依赖 three / DOM。

const P = new Uint8Array(512);
{
  const perm = Array.from({ length: 256 }, (_, i) => i);
  let s = 12345;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 255; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [perm[i], perm[j]] = [perm[j], perm[i]]; }
  for (let i = 0; i < 512; i++) P[i] = perm[i & 255];
}
const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (a, b, t) => a + t * (b - a);
function grad(h, x, y, z) {
  switch (h & 15) {
    case 0: return x + y; case 1: return -x + y; case 2: return x - y; case 3: return -x - y;
    case 4: return x + z; case 5: return -x + z; case 6: return x - z; case 7: return -x - z;
    case 8: return y + z; case 9: return -y + z; case 10: return y - z; case 11: return -y - z;
    case 12: return y + x; case 13: return -y + z; case 14: return y - x; default: return -y - z;
  }
}
function perlin3(x, y, z) {
  const X = Math.floor(x) & 255, Y = Math.floor(y) & 255, Z = Math.floor(z) & 255;
  x -= Math.floor(x); y -= Math.floor(y); z -= Math.floor(z);
  const u = fade(x), v = fade(y), w = fade(z);
  const A = P[X] + Y, AA = P[A] + Z, AB = P[A + 1] + Z;
  const B = P[X + 1] + Y, BA = P[B] + Z, BB = P[B + 1] + Z;
  return lerp(
    lerp(lerp(grad(P[AA], x, y, z), grad(P[BA], x - 1, y, z), u), lerp(grad(P[AB], x, y - 1, z), grad(P[BB], x - 1, y - 1, z), u), v),
    lerp(lerp(grad(P[AA + 1], x, y, z - 1), grad(P[BA + 1], x - 1, y, z - 1), u), lerp(grad(P[AB + 1], x, y - 1, z - 1), grad(P[BB + 1], x - 1, y - 1, z - 1), u), v), w);
}
function makeNoise(firstOctave, amplitudes) {
  const act = amplitudes.map((a, i) => [i, a]).filter(([, a]) => a !== 0);
  let sum = 0; for (const [, a] of act) sum += Math.abs(a);
  const norm = act.length / sum * 0.5;
  const oct = act.map(([i, a]) => ({ f: 2 ** (firstOctave + i), w: a * norm }));
  return (x, z) => { let s = 0; for (const o of oct) s += o.w * perlin3(x * o.f, 0, z * o.f); return s; };
}
const N = {
  ridge: makeNoise(-8, [1, 2, 1]),
  selector: makeNoise(-11, [1, 2.1, 1.5, 1.7, 1.4, 2, 2]),
  erosion: makeNoise(-10, [2, 1.75, 1.5, 1.5, 1.3, 1, 1, 1, 1]),
  continents: makeNoise(-10, [1.75, 1, 2, 3, 2, 2, 1, 1, 1]),
  lower: makeNoise(-8, [1.4, 2, 1]),
  upper: makeNoise(-8, [1.4, 2, 1]),
  badlands: makeNoise(-8, [1, 2, 1]),
  rolling: makeNoise(-6, [1, 1.6, 1.2, 1, 2]),
  wetland: makeNoise(-6, [0.6, 1.7, 1.2, 1]),
  hmul: makeNoise(-8, [1, 2, 1]),
  temp: makeNoise(-8, [1, 1, 1]),
  veg: makeNoise(-8, [1, 1, 1]),
  mbase: makeNoise(-8, [1, 0.2]),
  mdetail: makeNoise(-7, [0.2, 1]),
};

// ---- MC cubic spline 语义：端点外按 derivative 线性外插；段内 Hermite ----
function spline(points, c) {
  const n = points.length;
  if (c < points[0].location) return points[0].value + points[0].derivative * (c - points[0].location);
  if (c > points[n - 1].location) return points[n - 1].value + points[n - 1].derivative * (c - points[n - 1].location);
  let i = 0; while (i < n - 1 && points[i + 1].location <= c) i++;
  const a = points[i], b = points[Math.min(n - 1, i + 1)];
  if (a === b) return a.value;
  const d = b.location - a.location, t = (c - a.location) / d;
  const ad = a.derivative * d, bd = b.derivative * d, t2 = t * t, t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * a.value + (t3 - 2 * t2 + t) * ad + (-2 * t3 + 3 * t2) * b.value + (t3 - t2) * bd;
}
const pt = (location, value, derivative = 0) => ({ location, value, derivative });
const idxPts = [pt(-0.48, 1), pt(-0.42, 2), pt(-0.18, 2), pt(-0.12, 3), pt(0.17, 3), pt(0.23, 4), pt(0.52, 4), pt(0.58, 5)];
const TS = 2.2;


function lazySpline(points, c){
  const n=points.length;
  const val=(p)=>typeof p.value==='function'?p.value():p.value;
  if(c<points[0].location) return val(points[0])+points[0].derivative*(c-points[0].location);
  if(c>points[n-1].location) return val(points[n-1])+points[n-1].derivative*(c-points[n-1].location);
  let i=0; while(i<n-1 && points[i+1].location<=c) i++;
  const a=points[i], b=points[Math.min(n-1,i+1)];
  if(a===b) return val(a);
  const av=val(a), bv=val(b);
  const d=b.location-a.location, t=(c-a.location)/d;
  const ad=a.derivative*d, bd=b.derivative*d, t2=t*t, t3=t2*t;
  return (2*t3-3*t2+1)*av+(t3-2*t2+t)*ad+(-2*t3+3*t2)*bv+(t3-t2)*bd;
}
const lp=(location,value,derivative=0)=>({location,value,derivative});
function plateauL(x,z){
  const r=N.ridge(x*0.25,z*0.25);
  const lt=(base,top)=>()=>lazySpline([lp(0,base),lp(0.15,top)],Math.abs(N.lower(x*0.35,z*0.35)));
  return lazySpline([lp(-0.5,0.25,-0.1),lp(-0.4,lt(0.1,0.22)),lp(-0.3,0.05,-0.8),lp(-0.1,0.01),
    lp(-0.03,-0.06,-0.5),lp(0.03,-0.06,0.5),lp(0.1,0.01),lp(0.3,0.05,0.8),lp(0.4,lt(0.135,0.28)),lp(0.5,0.35,0.1)],r);
}
function valleyL(x,z,dbl){
  const r=N.ridge(x*0.25,z*0.25);
  const lt=(base,top)=>()=>lazySpline([lp(0,base),lp(0.15,top)],Math.abs(N.lower(x*0.35,z*0.35)));
  const pts = dbl
    ? [lp(-0.5,0.25,-0.1),lp(-0.4,lt(0.1,0.22)),lp(-0.3,0.25),lp(-0.2,lt(0.1,0.22)),lp(-0.125,0.05,-0.8),lp(-0.03,-0.06,-0.5),lp(0.03,-0.06,0.5),lp(0.125,0.05,0.8),lp(0.2,lt(0.135,0.28)),lp(0.3,0.35),lp(0.45,0.03)]
    : [lp(-0.5,0.25,-0.1),lp(-0.4,lt(0.1,0.22)),lp(-0.3,0.05,-0.8),lp(-0.1,0.01),lp(-0.03,-0.06,-0.5),lp(0.03,-0.06,0.5),lp(0.075,0.01),lp(0.14,0.05,0.8),lp(0.2,lt(0.135,0.28)),lp(0.3,0.35),lp(0.45,0.03)];
  return lazySpline(pts,r);
}
function clubL(x,z,ti,vi){
  const rf=Math.abs(N.ridge(x*0.25,z*0.25));
  const bad=(b,c)=>()=>lazySpline([lp(0.45,0.05),lp(0.6,b,1.5),lp(0.63,c,0.2)],Math.abs(N.badlands(x*0.35,z*0.35)));
  return lazySpline([
    lp(1,()=>plateauL(x,z)),
    lp(2,()=>lazySpline([lp(1,()=>valleyL(x,z,false)),lp(2,()=>plateauL(x,z))],vi)),
    lp(3,()=>lazySpline([lp(2,()=>valleyL(x,z,false)),lp(3,()=>plateauL(x,z)),lp(4,()=>plateauL(x,z)),lp(5,()=>valleyL(x,z,true))],vi)),
    lp(4,()=>plateauL(x,z)),
    lp(5,()=>lazySpline([lp(0,-0.15,2.5),lp(0.1,0.04),lp(0.2,bad(0.15,0.185)),lp(0.3,bad(0.185,0.5))],rf)),
  ],ti);
}
function spadeL(x,z,ti){
  const rf=Math.abs(N.ridge(x*0.25,z*0.25));
  const t4=()=>{const lo=Math.abs(N.lower(x*0.35,z*0.35)),up=Math.abs(N.upper(x*0.35,z*0.35));
    return lazySpline([lp(0.03,-0.06,0.5),lp(0.1,0.01),lp(0.3,0.05,0.8),lp(0.4,lazySpline([lp(0,0.1),lp(0.15,0.22)],lo)),lp(0.55,0.25,1),lp(0.6,lazySpline([lp(0,0.25),lp(0.15,0.45)],up)),lp(0.64,0.5)],rf);};
  const t5=()=>lazySpline([lp(0.025,-0.075,0.03),lp(0.1,0.05),lp(0.175,0.1,1.5),lp(0.2,0.225,0.2),lp(0.4,0.6,7),lp(0.4,0.6,0.1),lp(0.8,0.7),lp(0.85,0.4),lp(1,0.4),lp(1.05,0.04)],rf);
  return lazySpline([lp(4,t4),lp(5,t5)],ti);
}
function heartL(x,z,ti,vi){
  const r=N.ridge(x*0.25,z*0.25),rf=Math.abs(r);
  const flat=()=>lazySpline([lp(0.03,-0.06,0.5),lp(0.1,0.01,0.1)],rf);
  const hills=()=>lazySpline([lp(0.03,-0.06,0.5),lp(0.1,0.01,0.1),lp(0.2,lazySpline([lp(0,0.01,0.225)],Math.abs(N.rolling(x*0.2,z*0.2))))],rf);
  const valley=()=>lazySpline([lp(-0.75,0.05),lp(-0.175,0.015),lp(-0.125,0.01),lp(-0.04,-0.06,-0.7),lp(0.04,-0.06,0.7),lp(0.125,0.01)],r);
  const high=()=>lazySpline([lp(0.04,-0.06,0.7),lp(0.125,0.01),lp(0.175,0.015),lp(0.75,0.05),lp(0.8,0.6)],rf);
  return lazySpline([
    lp(3,()=>lazySpline([lp(2,hills),lp(3,flat)],vi)),
    lp(4,()=>lazySpline([lp(3,flat),lp(4,valley),lp(5,high)],vi)),
    lp(5,flat)],ti);
}
function diamondL(x,z,ti,vi){
  const rf=Math.abs(N.ridge(x*0.25,z*0.25));
  const flat=()=>lazySpline([lp(0.03,-0.06,0.5),lp(0.1,0.01,0.15)],rf);
  const flat2=()=>lazySpline([lp(0.03,-0.06,0.5),lp(0.1,0.01,0.1)],rf);
  const wet=()=>lazySpline([lp(0.03,-0.06,0.5),lp(0.1,0.01),lp(0.15,lazySpline([lp(-0.45,-0.03,0.03),lp(-0.3,0.005),lp(0.3,0.005),lp(0.45,-0.03,-0.03)],N.wetland(x*0.8,z*0.8)))],rf);
  return lazySpline([lp(4,()=>lazySpline([lp(2,flat2),lp(3,wet)],vi)),lp(5,flat)],ti);
}

// ================= 补齐 weak 两族（此前用满强度版顶替，占样本 11.5%）=================
// club_weak.json：只有 ti=4 / ti=5 两档；coordinate 是 ridges（带符号），不是 ridges_folded
function clubWeakL(x, z, ti) {
  const r = N.ridge(x * 0.25, z * 0.25);
  const rf = Math.abs(r);
  const lt = (base, top) => () => lazySpline([lp(0, base), lp(0.15, top)], Math.abs(N.lower(x * 0.35, z * 0.35)));
  const t4 = () => lazySpline([
    lp(-0.5, 0.13, -0.1), lp(-0.4, lt(0.05, 0.11)), lp(-0.3, 0.05, -0.8), lp(-0.1, 0.01),
    lp(-0.03, -0.06, -0.5), lp(0.03, -0.06, 0.5), lp(0.1, 0.01), lp(0.3, 0.05, 0.8),
    lp(0.4, lt(0.07, 0.14)), lp(0.5, 0.17, 0.1),
  ], r);
  const bad = (b, c) => () => lazySpline([lp(0.45, 0.05), lp(0.6, b, 1.5), lp(0.63, c, 0.2)], Math.abs(N.badlands(x * 0.35, z * 0.35)));
  const t5 = () => lazySpline([lp(0, -0.15, 2.5), lp(0.1, 0.04), lp(0.2, bad(0.15, 0.185)), lp(0.3, bad(0.185, 0.5))], rf);
  return lazySpline([lp(4, t4), lp(5, t5)], ti);
}
// spade_weak.json：ti=4 / ti=5，coordinate=ridges_folded，无 tier 子样条（台阶被压平）
function spadeWeakL(x, z, ti) {
  const rf = Math.abs(N.ridge(x * 0.25, z * 0.25));
  const t4 = () => lazySpline([lp(0.03, -0.06, 0.5), lp(0.1, 0.01), lp(0.3, 0.05, 0.8), lp(0.4, 0.22), lp(0.55, 0.25, 0.1)], rf);
  const t5 = () => lazySpline([lp(0.025, -0.075, 0.03), lp(0.1, 0.05), lp(0.175, 0.1, 1.5), lp(0.2, 0.18, 0.2),
    lp(0.4, 0.3, 2.5), lp(0.4, 0.3, 0.15), lp(0.8, 0.3), lp(0.85, 0.23), lp(1, 0.23), lp(1.05, 0.04)], rf);
  return lazySpline([lp(4, t4), lp(5, t5)], ti);
}
// offset/regions.json 的忠实分派：外层 erosion ∈ {-0.02, 0.04}，内层 selector ∈ {-0.1, 0, 0.1}
// 每档三选一：club / club_weak / heart（低侵蚀）与 spade / spade_weak / diamond（高侵蚀）
function regionsFull(x, z) {
  const e = N.erosion(x * 0.25, z * 0.25);
  const sel = N.selector(x * 1.1, z * 1.1) + 0.1;
  const ti = spline(idxPts, N.temp(x * 0.25, z * 0.25) * TS);
  const vi = spline(idxPts, N.veg(x * 0.25 + 1000, z * 0.25 + 1000) * TS);
  const hm = Math.min(1.6, Math.max(0.8, 1.2 + 0.4 * N.hmul(x * 0.25, z * 0.25)));
  const low = () => lazySpline([
    lp(-0.1, () => clubL(x, z, ti, vi)),
    lp(0, () => clubWeakL(x, z, ti)),
    lp(0.1, () => heartL(x, z, ti, vi)),
  ], sel);
  const high = () => lazySpline([
    lp(-0.1, () => spadeL(x, z, ti)),
    lp(0, () => spadeWeakL(x, z, ti)),
    lp(0.1, () => diamondL(x, z, ti, vi)),
  ], sel);
  return hm * lazySpline([lp(-0.02, low), lp(0.04, high)], e);
}
// 族标签（与 regionsFull 同一套阈值，供占比统计）
function famOf(x, z) {
  const e = N.erosion(x * 0.25, z * 0.25);
  const sel = N.selector(x * 1.1, z * 1.1) + 0.1;
  const mid = (a, b) => (a + b) / 2;
  if (e < mid(-0.02, 0.04)) return sel < mid(-0.1, 0) ? 'club' : sel < mid(0, 0.1) ? 'club_weak' : 'heart';
  return sel < mid(-0.1, 0) ? 'spade' : sel < mid(0, 0.1) ? 'spade_weak' : 'diamond';
}
// 单变量对照：同一份忠实四族代码，只差「样条 value 是 thunk（惰性）还是数值（eager）」
// eager 版：把 regionsFull 的所有 () => 立即求值
function clubE(x,z,ti,vi){
  const rf=Math.abs(N.ridge(x*0.25,z*0.25));
  const bad=(b,c)=>lazySpline([lp(0.45,0.05),lp(0.6,b,1.5),lp(0.63,c,0.2)],Math.abs(N.badlands(x*0.35,z*0.35)));
  const p=plateauL(x,z), sv=valleyL(x,z,false), dv=valleyL(x,z,true);
  const veg2=lazySpline([lp(1,sv),lp(2,p)],vi);
  const veg3=lazySpline([lp(2,sv),lp(3,p),lp(4,p),lp(5,dv)],vi);
  const t5=lazySpline([lp(0,-0.15,2.5),lp(0.1,0.04),lp(0.2,bad(0.15,0.185)),lp(0.3,bad(0.185,0.5))],rf);
  return lazySpline([lp(1,p),lp(2,veg2),lp(3,veg3),lp(4,p),lp(5,t5)],ti);
}
function spadeE(x,z,ti){
  const rf=Math.abs(N.ridge(x*0.25,z*0.25));
  const lo=Math.abs(N.lower(x*0.35,z*0.35)),up=Math.abs(N.upper(x*0.35,z*0.35));
  const t4=lazySpline([lp(0.03,-0.06,0.5),lp(0.1,0.01),lp(0.3,0.05,0.8),lp(0.4,lazySpline([lp(0,0.1),lp(0.15,0.22)],lo)),lp(0.55,0.25,1),lp(0.6,lazySpline([lp(0,0.25),lp(0.15,0.45)],up)),lp(0.64,0.5)],rf);
  const t5=lazySpline([lp(0.025,-0.075,0.03),lp(0.1,0.05),lp(0.175,0.1,1.5),lp(0.2,0.225,0.2),lp(0.4,0.6,7),lp(0.4,0.6,0.1),lp(0.8,0.7),lp(0.85,0.4),lp(1,0.4),lp(1.05,0.04)],rf);
  return lazySpline([lp(4,t4),lp(5,t5)],ti);
}
function heartE(x,z,ti,vi){
  const r=N.ridge(x*0.25,z*0.25),rf=Math.abs(r);
  const flat=lazySpline([lp(0.03,-0.06,0.5),lp(0.1,0.01,0.1)],rf);
  const hills=lazySpline([lp(0.03,-0.06,0.5),lp(0.1,0.01,0.1),lp(0.2,lazySpline([lp(0,0.01,0.225)],Math.abs(N.rolling(x*0.2,z*0.2))))],rf);
  const valley=lazySpline([lp(-0.75,0.05),lp(-0.175,0.015),lp(-0.125,0.01),lp(-0.04,-0.06,-0.7),lp(0.04,-0.06,0.7),lp(0.125,0.01)],r);
  const high=lazySpline([lp(0.04,-0.06,0.7),lp(0.125,0.01),lp(0.175,0.015),lp(0.75,0.05),lp(0.8,0.6)],rf);
  return lazySpline([lp(3,lazySpline([lp(2,hills),lp(3,flat)],vi)),lp(4,lazySpline([lp(3,flat),lp(4,valley),lp(5,high)],vi)),lp(5,flat)],ti);
}
function diamondE(x,z,ti,vi){
  const rf=Math.abs(N.ridge(x*0.25,z*0.25));
  const flat=lazySpline([lp(0.03,-0.06,0.5),lp(0.1,0.01,0.15)],rf);
  const flat2=lazySpline([lp(0.03,-0.06,0.5),lp(0.1,0.01,0.1)],rf);
  const wet=lazySpline([lp(0.03,-0.06,0.5),lp(0.1,0.01),lp(0.15,lazySpline([lp(-0.45,-0.03,0.03),lp(-0.3,0.005),lp(0.3,0.005),lp(0.45,-0.03,-0.03)],N.wetland(x*0.8,z*0.8)))],rf);
  return lazySpline([lp(4,lazySpline([lp(2,flat2),lp(3,wet)],vi)),lp(5,flat)],ti);
}
function clubWeakE(x,z,ti){
  const r=N.ridge(x*0.25,z*0.25),rf=Math.abs(r);
  const lt=(b,t)=>lazySpline([lp(0,b),lp(0.15,t)],Math.abs(N.lower(x*0.35,z*0.35)));
  const t4=lazySpline([lp(-0.5,0.13,-0.1),lp(-0.4,lt(0.05,0.11)),lp(-0.3,0.05,-0.8),lp(-0.1,0.01),lp(-0.03,-0.06,-0.5),lp(0.03,-0.06,0.5),lp(0.1,0.01),lp(0.3,0.05,0.8),lp(0.4,lt(0.07,0.14)),lp(0.5,0.17,0.1)],r);
  const bad=(b,c)=>lazySpline([lp(0.45,0.05),lp(0.6,b,1.5),lp(0.63,c,0.2)],Math.abs(N.badlands(x*0.35,z*0.35)));
  const t5=lazySpline([lp(0,-0.15,2.5),lp(0.1,0.04),lp(0.2,bad(0.15,0.185)),lp(0.3,bad(0.185,0.5))],rf);
  return lazySpline([lp(4,t4),lp(5,t5)],ti);
}
function spadeWeakE(x,z,ti){
  const rf=Math.abs(N.ridge(x*0.25,z*0.25));
  const t4=lazySpline([lp(0.03,-0.06,0.5),lp(0.1,0.01),lp(0.3,0.05,0.8),lp(0.4,0.22),lp(0.55,0.25,0.1)],rf);
  const t5=lazySpline([lp(0.025,-0.075,0.03),lp(0.1,0.05),lp(0.175,0.1,1.5),lp(0.2,0.18,0.2),lp(0.4,0.3,2.5),lp(0.4,0.3,0.15),lp(0.8,0.3),lp(0.85,0.23),lp(1,0.23),lp(1.05,0.04)],rf);
  return lazySpline([lp(4,t4),lp(5,t5)],ti);
}
function regionsEager(x,z){
  const e=N.erosion(x*0.25,z*0.25), sel=N.selector(x*1.1,z*1.1)+0.1;
  const ti=spline(idxPts,N.temp(x*0.25,z*0.25)*TS), vi=spline(idxPts,N.veg(x*0.25+1000,z*0.25+1000)*TS);
  const hm=Math.min(1.6,Math.max(0.8,1.2+0.4*N.hmul(x*0.25,z*0.25)));
  const low=lazySpline([lp(-0.1,clubE(x,z,ti,vi)),lp(0,clubWeakE(x,z,ti)),lp(0.1,heartE(x,z,ti,vi))],sel);
  const high=lazySpline([lp(-0.1,spadeE(x,z,ti)),lp(0,spadeWeakE(x,z,ti)),lp(0.1,diamondE(x,z,ti,vi))],sel);
  return hm*lazySpline([lp(-0.02,low),lp(0.04,high)],e);
}

// ============================ 测量 ============================
const OCT = { ridge:3, selector:7, erosion:9, continents:9, lower:3, upper:3, badlands:3,
  rolling:5, wetland:4, hmul:3, temp:3, veg:3, mbase:2, mdetail:2, duneBase:1, duneOffset:1, pillar:2 };

/** 数「单次高度求值跑了多少噪声调用 / octave」（惰性分支下随位置变化，取多点平均） */
function measure(fn, pts = 2000) {
  const bk = { ...N }; let c = 0, o = 0;
  for (const k of Object.keys(N)) { const f = bk[k]; N[k] = (x, z) => { c++; o += (OCT[k] || 0); return f(x, z); }; }
  for (let i = 0; i < pts; i++) fn((i * 37) % 6400 - 3200, (i * 91) % 6400 - 3200);
  Object.assign(N, bk);
  return { calls: c / pts, octaves: o / pts };
}
/** 列内 4×4 子采样 + 双线性（§5.C 的推荐采样口径） */
function sub4(fn) {
  return (cx, cz) => {
    const x0 = cx * 16, z0 = cz * 16, g = [];
    for (let i = 0; i <= 4; i++) { g[i] = []; for (let j = 0; j <= 4; j++) g[i][j] = fn(x0 + i * 4, z0 + j * 4); }
    let s = 0;
    for (let lx = 0; lx < 16; lx++) for (let lz = 0; lz < 16; lz++) {
      const i = lx >> 2, j = lz >> 2, u = (lx % 4) / 4, v = (lz % 4) / 4;
      s += (g[i][j] * (1 - u) + g[i + 1][j] * u) * (1 - v) + (g[i][j + 1] * (1 - u) + g[i + 1][j + 1] * u) * v;
    }
    return s;
  };
}
function msPerColumn(g, cols = 1500) {
  g(0, 0); let sink = 0; const t = performance.now();
  for (let i = 0; i < cols; i++) sink += g((i * 7) % 400 - 200, (i * 13) % 400 - 200);
  return { ms: (performance.now() - t) / cols, sink };
}
const quant = (a, p) => a[Math.floor(a.length * p)];

// ---- 三个候选（A 只 club / B 四族 / C 四族+大陆度基座）----
const contPts = [pt(0, 0), pt(0.4, 0.575, 1), pt(0.48, 0.68, 1)];
const rawCont = (x, z) => Math.max(-1, Math.min(2, -0.8 + spline(contPts, Math.abs(N.continents(x * 0.13, z * 0.13)))));
const baseOf = (rc) => rc < -0.45 ? -0.45 : rc < -0.35 ? -0.22 : rc < -0.195 ? -0.14 : rc < 0 ? 0 : rc < 0.1 ? 0.33 : 0.65;
const clubOnly = (x, z) => {
  const ti = spline(idxPts, N.temp(x * 0.25, z * 0.25) * TS);
  const vi = spline(idxPts, N.veg(x * 0.25 + 1000, z * 0.25 + 1000) * TS);
  return clubL(x, z, ti, vi);
};
const CAND = {
  'A club 台地族': clubOnly,
  'B 四族 region': regionsFull,
  'C 四族+大陆度': (x, z) => baseOf(rawCont(x, z)) + regionsFull(x, z),
};

const out = { selfCheck: {}, perEval: {}, perColumn: {}, shape: [], families: {} };

// ---- 自校验：eager vs lazy 必须逐位相同（否则成本对照不成立）----
{
  let maxd = 0, n = 0;
  for (let x = -800; x <= 800; x += 7) for (let z = -800; z <= 800; z += 7) {
    const d = Math.abs(regionsEager(x, z) - regionsFull(x, z)); if (d > maxd) maxd = d; n++;
  }
  out.selfCheck.eagerVsLazy = { maxDiff: maxd, samples: n };
  // spline 端点语义（写成 clamp 会得 -25）
  out.selfCheck.splineEndpoints = { at0: spline(idxPts, 0), atMinus1: spline(idxPts, -1), at1: spline(idxPts, 1) };
  let bad = 0;
  for (let x = -2400; x <= 2400; x += 17) for (let z = -2400; z <= 2400; z += 17) if (!Number.isFinite(regionsFull(x, z))) bad++;
  out.selfCheck.nonFinite = bad;
}

// ---- 单次求值成本 + GPU 五点取样 ----
for (const [name, fn] of Object.entries(CAND)) {
  const m = measure(fn);
  out.perEval[name] = { calls: +m.calls.toFixed(1), octaves: +m.octaves.toFixed(1), gpuFiveTap: Math.round(m.octaves * 5) };
}
out.perEval['eager 四族（对照）'] = (() => { const m = measure(regionsEager); return { calls: +m.calls.toFixed(1), octaves: +m.octaves.toFixed(1), gpuFiveTap: Math.round(m.octaves * 5) }; })();

// ---- 每列成本：列中心 / 4×4 / 逐格 ----
for (const [name, fn] of Object.entries(CAND)) {
  out.perColumn[name] = {
    columnCenter: +msPerColumn((cx, cz) => fn(cx * 16 + 8, cz * 16 + 8) * 256).ms.toFixed(4),
    sub4: +msPerColumn(sub4(fn)).ms.toFixed(4),
    perCell: +msPerColumn((cx, cz) => { let s = 0; for (let lx = 0; lx < 16; lx++) for (let lz = 0; lz < 16; lz++) s += fn(cx * 16 + lx, cz * 16 + lz); return s; }).ms.toFixed(4),
  };
}

// ---- 形态表（k 水平缩放 × K 高度系数）----
for (const [name, fn0] of Object.entries(CAND)) {
  for (const [k, K] of [[1, 100], [2, 80], [4, 60], [8, 40]]) {
    const fn = (x, z) => fn0(x * k, z * k);
    const a = [];
    for (let x = -2400; x <= 2400; x += 13) for (let z = -2400; z <= 2400; z += 13) a.push(fn(x, z) * K);
    a.sort((p, q) => p - q);
    let sum = 0, max = 0, cnt = 0;
    for (let cx = -25; cx < 25; cx += 3) for (let cz = -25; cz < 25; cz += 3) {
      let lo = Infinity, hi = -Infinity;
      for (let lx = 0; lx < 16; lx++) for (let lz = 0; lz < 16; lz++) { const h = fn(cx * 16 + lx, cz * 16 + lz) * K; if (h < lo) lo = h; if (h > hi) hi = h; }
      sum += hi - lo; if (hi - lo > max) max = hi - lo; cnt++;
    }
    out.shape.push({
      candidate: name, k, K,
      relief: +(quant(a, 0.99) - quant(a, 0.01)).toFixed(1),
      inColumnMean: +(sum / cnt).toFixed(1), inColumnMax: +max.toFixed(1),
      sub4Ms: +msPerColumn(sub4(fn)).ms.toFixed(4),
      outOfBoundsPct: +(100 * a.filter(v => v < -32 || v > 96).length / a.length).toFixed(1),
      underwaterPct: +(100 * a.filter(v => v < -2).length / a.length).toFixed(1),
    });
  }
}

// ---- 族占比 ----
{
  const f = {}; let tot = 0;
  for (let x = -2400; x <= 2400; x += 13) for (let z = -2400; z <= 2400; z += 13) { const k = famOf(x, z); f[k] = (f[k] || 0) + 1; tot++; }
  for (const [k, c] of Object.entries(f)) out.families[k] = +(100 * c / tot).toFixed(1);
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(out, null, 2));
} else {
  console.log('=== 自校验');
  console.log('  eager vs lazy 最大差 =', out.selfCheck.eagerVsLazy.maxDiff.toExponential(3), '(n=' + out.selfCheck.eagerVsLazy.samples + ')');
  console.log('  spline(idxPts, 0) =', out.selfCheck.splineEndpoints.at0, '（clamp 版会得 -25）');
  console.log('  非有限值样本 =', out.selfCheck.nonFinite);
  console.log('\n=== 单次高度求值（GPU 侧 ×5 点/片元）');
  for (const [n, v] of Object.entries(out.perEval)) console.log('  ' + n.padEnd(22) + ' 调用=' + String(v.calls).padStart(5) + '  octave=' + String(v.octaves).padStart(5) + '  五点=' + String(v.gpuFiveTap).padStart(4));
  console.log('\n=== 每列(256格)成本 ms/列');
  for (const [n, v] of Object.entries(out.perColumn)) console.log('  ' + n.padEnd(22) + ' 列中心=' + String(v.columnCenter).padStart(7) + '  4×4=' + String(v.sub4).padStart(7) + '  逐格=' + String(v.perCell).padStart(7));
  console.log('\n=== 形态（现状基线：落差 30 / 列内极差 3.4 均 12 最大 / 水下 31.8%）');
  console.log('  候选'.padEnd(20) + 'k    K   落差  列内均/最大   4×4ms  越界%  水下%');
  for (const r of out.shape) console.log('  ' + (r.candidate + ' ').padEnd(20) + String(r.k).padStart(2) + String(r.K).padStart(5) + String(r.relief).padStart(7) + String(r.inColumnMean).padStart(8) + '/' + String(r.inColumnMax).padStart(6) + String(r.sub4Ms).padStart(8) + String(r.outOfBoundsPct).padStart(7) + String(r.underwaterPct).padStart(7));
  console.log('\n=== 族占比:', Object.entries(out.families).sort((a, b) => b[1] - a[1]).map(([k, v]) => k + ' ' + v + '%').join(' | '));
  console.log('\n门禁参考：纯地形 GEN p95 < 8 ms/列（src/tests/test-worker-gen.html）；含结构 < 10 ms/列（test-structure-gen.html）');
}
