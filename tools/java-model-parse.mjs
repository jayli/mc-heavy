// tools/java-model-parse.mjs — Citadel（Java 版 Cataclysm）模型/动画源码的**共享解析与求值**
//
// 唯一权威（红线 1）：`ignis-java-reference.mjs`（焰魔参考真值）与 `bake-guardian.mjs`
// （守卫烘焙）都从这里 import，不得各写一份解析语义。
//
// ⚠️ node 侧模块，**不读文件**（`node:fs` 只留在消费侧）——所有函数收 `text` 字符串或已解析的
// `bones` Map。`src/**` 与浏览器单测绝不能 import 它（同 `*-fingerprint.mjs` 的理由）。
//
// ## Java 一侧的确定语义（Citadel `AdvancedModelBox` + `ModelAnimator`）
//
//   M(bone) = M(parent) · T(pos + moveDelta) · Rz(rz) · Ry(ry) · Rx(rx)   ← translateAndRotate 调用序 Z→Y→X
//   关键帧值 = 与默认姿态**逐轴相加**的欧拉角（不是四元数复合）；`move` 同理逐轴累加（px）
//   缓动：`endKeyframe` 里 `inc = sin(frac·π/2)`，`dec = 1−inc`，值 = dec·prev + inc·cur；静态帧 = prev
//   模型空间 **y 向下、前方 = −z**
//
// ⚠️ **旋转约定不得改**：焰魔 v2.58 用「蓄力向身后抡接近 180°」的缺陷换来这条实测结论。
// 「关键帧数值与原版逐帧一致」**证明不了姿态一致** —— 必须比世界坐标。
//
// ## 与 Bedrock 几何空间的换算（两种口径，别混）
//
//   口径「绝对」（焰魔产物用）：pivot = Java 绝对坐标的 `(x, 24 − y, z)`；
//     同一 Java 旋转在该空间里是 `S_y·R_java·S_y = Rz(−θz)·Ry(+θy)·Rx(−θx)`。
//   口径 A「仅翻转」（守卫产物用，spec §2.2.1）：保留 Java 的**局部**顶点，只做 `y → −y`。
//     `bindPoseBBoxBlocks` 用的是这一口径（内部 `q = [p[0], −p[1], p[2]]`）。
//     ⚠️ **不要把它改成 `24 − p[1]`** —— 那会把守卫的 `feetOffsetY` 从 −1.5 变成 0。

const num = (s) => parseFloat(String(s).replace(/F$/i, ''));
const NUM = '(-?[\\d.]+)F?';

/**
 * 解析构造函数里的骨骼树。
 *
 * @param {string} text Java 源码全文
 * @param {string} ctorName 构造函数名，如 `'ModelIgnis'` / `'ModelEnder_Guardian'`
 * @returns {Map<string, {pos:number[], rot:number[], parent:string|null, cubes:Array}>}
 *   `rot` 是弧度；`cubes[]` 含 `{origin, size, inflate, mirror}`（px）
 */
export function parseBones(text, ctorName) {
  const ctorStart = text.indexOf(`public ${ctorName}()`);
  // ⚠️ 找不到必须 throw，**不得静默返回空 Map** —— 那会让烘焙产出 0 骨骼而结构指纹全对。
  if (ctorStart < 0) {
    throw new Error(`[java-model-parse] 找不到构造函数 public ${ctorName}()`);
  }
  const ctorEnd = text.indexOf('animator = ModelAnimator.create()', ctorStart);
  const ctor = text.slice(ctorStart, ctorEnd < 0 ? undefined : ctorEnd);
  const bones = new Map();
  for (const m of ctor.matchAll(/^\s*(\w+) = new AdvancedModelBox\(this\);/gm)) {
    bones.set(m[1], { pos: [0, 0, 0], rot: [0, 0, 0], parent: null, cubes: [] });
  }
  for (const m of ctor.matchAll(/(\w+)\.setTextureOffset\((\d+),\s*(\d+)\)\.addBox\(([^)]*)\);/g)) {
    const raw = m[4].split(',').map((s) => s.trim());
    const a = raw.map((s) => num(s));
    // 第 8 个参数是 mirror（true/false）。守卫实测 7 个镜像件；缺省 false。
    const mirror = raw.length > 7 ? raw[7] === 'true' : false;
    bones.get(m[1]).cubes.push({
      origin: a.slice(0, 3), size: a.slice(3, 6), inflate: a[6] || 0, mirror,
    });
  }
  for (const m of ctor.matchAll(new RegExp(`(\\w+)\\.setPos\\(\\s*${NUM},\\s*${NUM},\\s*${NUM}\\s*\\);`, 'g'))) {
    bones.get(m[1]).pos = [num(m[2]), num(m[3]), num(m[4])];
  }
  for (const m of ctor.matchAll(/(\w+)\.addChild\((\w+)\);/g)) bones.get(m[2]).parent = m[1];
  for (const m of ctor.matchAll(new RegExp(`setRotationAngle\\((\\w+),\\s*${NUM},\\s*${NUM},\\s*${NUM}\\s*\\);`, 'g'))) {
    bones.get(m[1]).rot = [num(m[2]), num(m[3]), num(m[4])];
  }
  return bones;
}

/**
 * 解析一条动画的关键帧语句序列。
 *
 * @param {string} text Java 源码全文
 * @param {string} animConstName 动画常量名，如 `'SWING_ATTACK'` / `'GUARDIAN_STOMP'`
 * @param {{branch?: string|null}} [opts]
 *   `branch`：段内有 `if/else` 时，指定要取的那个分支的起始字面量。
 *   ⚠️ **这是必需的可选项**：焰魔 `SWING_ATTACK` 段内就有
 *   `if (!entity.getIsShieldBreak()) { … } else { … }`，要传该字面量取非破盾分支。
 *   未传且段内有 `if` ⇒ throw（守卫四条目标动画实测无条件分支，出现分支说明解析边界错了）。
 * @returns {Array<{kind:string, n?:number, name?:string, ang?:number[], off?:number[]}>}
 */
export function parseAnimation(text, animConstName, { branch = null } = {}) {
  // ⚠️ 动画名必须容许**类名前缀**：焰魔是 `setAnimation(SWING_ATTACK)`，
  // 守卫是 `setAnimation(Ender_Guardian_Entity.GUARDIAN_RIGHT_STRONG_ATTACK)`。
  // 只按字面匹配对守卫一条都找不到。
  const literal = `animator.setAnimation(${animConstName});`;
  let start = text.indexOf(literal);
  if (start < 0) {
    const re = new RegExp(`animator\\.setAnimation\\([\\w.]*\\.${animConstName}\\);`);
    const m = re.exec(text);
    if (!m) throw new Error(`[java-model-parse] 找不到动画 ${animConstName}`);
    start = m.index;
  }
  // 段落终点 = **下一个** setAnimation（不含自己）
  const nextIdx = text.indexOf('animator.setAnimation(', start + 1);
  const seg = text.slice(start, nextIdx < 0 ? undefined : nextIdx);

  let body = seg;
  if (branch) {
    const bStart = seg.indexOf(branch);
    if (bStart < 0) throw new Error(`[java-model-parse] 动画 ${animConstName} 段内找不到分支 ${branch}`);
    const bEnd = seg.indexOf('} else {', bStart);
    body = seg.slice(bStart, bEnd < 0 ? undefined : bEnd);
  } else if (/\bif\s*\(/.test(seg)) {
    throw new Error(`[java-model-parse] 动画 ${animConstName} 段内出现 if 分支，需显式传 branch`);
  }

  const stmts = [];
  for (const m of body.matchAll(/animator\.(\w+)\(([^;]*)\);/g)) {
    if (m[1] === 'rotate' || m[1] === 'move') {
      const parts = m[2].split(/,(?![^(]*\))/).map((s) => s.trim());
      const vals = parts.slice(1).map((p) => {
        const r = p.match(/Math\.toRadians\((-?[\d.]+)F?\)/);
        return r ? num(r[1]) * Math.PI / 180 : num(p);
      });
      // rotate → 弧度；move → px 平移（不做角度换算）
      if (m[1] === 'rotate') stmts.push({ kind: 'rotate', name: parts[0], ang: vals });
      else stmts.push({ kind: 'move', name: parts[0], off: vals });
    } else if (m[1] !== 'setAnimation') {
      stmts.push({ kind: m[1], n: Number(m[2]) || 0 });
    }
  }
  return stmts;
}

/**
 * `ModelAnimator` 语义：tick `tau` 处每骨的**附加欧拉角（弧度）+ 附加平移（px）**。
 *
 * @returns {Map<string, {rot:number[], pos:number[]}>}
 */
export function evalKeyframes(stmts, tau) {
  const acc = new Map();
  const add = (name, field, v, w) => {
    const e = acc.get(name) || { rot: [0, 0, 0], pos: [0, 0, 0] };
    const a = e[field];
    e[field] = [a[0] + v[0] * w, a[1] + v[1] * w, a[2] + v[2] * w];
    acc.set(name, e);
  };
  let temp = 0, prevTemp = 0, cur = new Map(), prev = new Map();
  const bump = (map, name, field, v) => {
    const e = map.get(name) || { rot: [0, 0, 0], pos: [0, 0, 0] };
    const a = e[field];
    e[field] = [a[0] + v[0], a[1] + v[1], a[2] + v[2]];
    map.set(name, e);
  };
  const end = (stationary) => {
    if (tau >= prevTemp && tau < temp) {
      if (stationary) {
        for (const [n, v] of prev) { add(n, 'rot', v.rot, 1); add(n, 'pos', v.pos, 1); }
      } else {
        const inc = Math.sin(((tau - prevTemp) / (temp - prevTemp)) * Math.PI / 2);
        for (const [n, v] of prev) { add(n, 'rot', v.rot, 1 - inc); add(n, 'pos', v.pos, 1 - inc); }
        for (const [n, v] of cur) { add(n, 'rot', v.rot, inc); add(n, 'pos', v.pos, inc); }
      }
    }
    if (!stationary) prev = new Map(cur);
    cur = new Map();
  };
  const start = (d) => { prevTemp = temp; temp += d; cur = new Map(); };
  for (const s of stmts) {
    if (s.kind === 'startKeyframe') start(s.n);
    else if (s.kind === 'rotate') bump(cur, s.name, 'rot', s.ang);
    else if (s.kind === 'move') bump(cur, s.name, 'pos', s.off);
    else if (s.kind === 'endKeyframe') end(false);
    else if (s.kind === 'setStaticKeyframe') { start(s.n); end(true); }
    else if (s.kind === 'resetKeyframe') { start(s.n); end(false); }
  }
  return acc;
}

// ---- 4×4 行主序矩阵 ----
const mul = (a, b) => {
  const o = new Array(16);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[r * 4 + k] * b[k * 4 + c];
    o[r * 4 + c] = s;
  }
  return o;
};
const T = (x, y, z) => [1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z, 0, 0, 0, 1];
const RX = (a) => { const c = Math.cos(a), s = Math.sin(a); return [1, 0, 0, 0, 0, c, -s, 0, 0, s, c, 0, 0, 0, 0, 1]; };
const RY = (a) => { const c = Math.cos(a), s = Math.sin(a); return [c, 0, s, 0, 0, 1, 0, 0, -s, 0, c, 0, 0, 0, 0, 1]; };
const RZ = (a) => { const c = Math.cos(a), s = Math.sin(a); return [c, -s, 0, 0, s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; };

/** 把 4×4 行主序矩阵作用到一点 */
export const applyMat = (m, p) => [
  m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3],
  m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7],
  m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11],
];

/**
 * Java 骨骼世界矩阵（px；Java 模型空间，y 向下）。
 *
 * @param {Map} bones `parseBones` 的结果
 * @param {Map|null} anim 每骨附加量表。条目可以是 `{rot,pos}`（`evalKeyframes` 的形状），
 *   也**兼容旧的裸数组** `[rx,ry,rz]` —— 防漏改调用处时静默拿到 undefined。
 */
export function javaWorld(bones, anim) {
  const world = new Map();
  const get = (name) => {
    if (world.has(name)) return world.get(name);
    const b = bones.get(name);
    const e = anim?.get(name);
    const rot = Array.isArray(e) ? e : (e?.rot || [0, 0, 0]);
    const off = Array.isArray(e) ? [0, 0, 0] : (e?.pos || [0, 0, 0]);
    const local = mul(
      T(b.pos[0] + off[0], b.pos[1] + off[1], b.pos[2] + off[2]),
      mul(RZ(b.rot[2] + rot[2]), mul(RY(b.rot[1] + rot[1]), RX(b.rot[0] + rot[0]))),
    );
    const m = b.parent ? mul(get(b.parent), local) : local;
    world.set(name, m);
    return m;
  };
  for (const n of bones.keys()) get(n);
  return world;
}

/**
 * bind pose 的整体包围盒（格）：全部**非零尺寸**立方体（与烘焙一致），含 inflate。
 *
 * ⚠️ 空间是**口径 A（仅翻转 `y → −y`）**，不是 `24 − y`。守卫的 `feetOffsetY = −1.5` 由此口径而来。
 *
 * @param {Map} bones `parseBones` 的结果（**不收文件路径** —— 共享模块不读文件）
 * @returns {{cubes:number, size:number[]}}
 */
export function bindPoseBBoxBlocks(bones) {
  const world = javaWorld(bones, null);
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  let cubes = 0;
  for (const [name, b] of bones) {
    for (const c of b.cubes) {
      if (c.size.some((v) => v === 0)) continue;
      cubes++;
      for (const x of [c.origin[0] - c.inflate, c.origin[0] + c.size[0] + c.inflate]) {
        for (const y of [c.origin[1] - c.inflate, c.origin[1] + c.size[1] + c.inflate]) {
          for (const z of [c.origin[2] - c.inflate, c.origin[2] + c.size[2] + c.inflate]) {
            const p = applyMat(world.get(name), [x, y, z]);
            const q = [p[0], -p[1], p[2]];
            for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], q[k]); hi[k] = Math.max(hi[k], q[k]); }
          }
        }
      }
    }
  }
  return { cubes, size: [0, 1, 2].map((k) => (hi[k] - lo[k]) / 16) };
}