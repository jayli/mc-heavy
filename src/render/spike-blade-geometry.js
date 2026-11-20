// src/render/spike-blade-geometry.js — 焰魔尖刺的**剑体几何**（v3.26，纯数组进出）
//
// 用户 2026-11-21：「尖刺形态从锥体改为剑体……剑体贴图就跟焰魔手里拿着的剑一模一样，
// 但是突出地面的剑的部分不要把剑柄露出来，露出高度跟现在的锥体露出地面的高度差不多。」
//
// ## 做什么
//
// 从既有烘焙产物 `assets/ignis/ignis.json` 里抽**剑身 + 剑尖两个盒**（48 顶点 / 24 三角），
// 做一次轴置换把躺着的剑立起来插进地里：剑尖在 `y = exposeHeight`，其余埋在 `y < 0`。
// **零重烘、零新增资源** —— 剑的顶点已经在产物里，再烘一份就有两份剑几何（红线 1）。
//
// ## ⚠️⚠️ bind 姿态下 skinning 是恒等变换 —— 绝不能再乘骨骼链
//
// 2026-11-21 实测：全部 1920 顶点经 `SkinnedMesh.applyBoneTransform` 后与 raw 最大差
// **8.882e-16** ⇒ 产物顶点**已是绝对模型坐标**（`bake-ignis.mjs` 的
// 「cube 顶点是绝对模型空间坐标，直接写入，不乘骨骼矩阵」）。
//
// 反向验证过：手写骨骼链（`localPosition` + `bindQuaternion` 层级累乘）再乘一次，
// `sword_blade` 的顶点偏 **0.466 格**。这是守卫那条「顶点必须预乘 bind 世界矩阵」的
// **镜像坑** —— 守卫是 Java 局部顶点所以必须乘，焰魔是 Bedrock 绝对顶点所以绝不能乘。
//
// ## 「护手不露」是天然成立的，不靠深度遮挡
//
// 护手最近端距剑尖 **2.749 格**、根部装饰最远端距剑尖 **2.480 格**，两者都 > 1.6
// ⇒ 只取剑身两盒时，护手/剑柄/柄球**根本不进几何**。靠遮挡藏的话，玩家蹲下/挖开地面/
// 侧面低角度看就会露出柄；压根不取则在任何视角都成立。
//
// ## 归属与依赖
//
// 纯数组进出的几何预处理，无 GPU 依赖 ⇒ Tier 1 单测可直接驱动（不必初始化 three）。
// 归属 `render/`（主线程装配层消费），但本文件自身不 import three。
// 依赖方向：`spike-blade-geometry` ← `spike-fx`。

/**
 * 剑身与剑尖所在的骨骼名。**选盒的唯一权威**（不硬编码顶点下标 —— 素材换版下标会漂）。
 *
 * 实测（`assets/ignis/ignis.json`）：
 *   · `sword` 名下 3 个盒，z 跨度分别 2.5000 / 0.7500 / 0.1250 ⇒ 最大者唯一（差 3.3 倍）；
 *   · `sword_blade` 名下只有 1 个盒（剑尖，宽 0.3113 收细）。
 */
export const SPIKE_BLADE_BONES = Object.freeze({ body: 'sword', tip: 'sword_blade' });

/** `BoxGeometry` 每盒 24 顶点（three 的 buildPlane 六面各 4 顶点） */
const VERTS_PER_BOX = 24;

/**
 * 找出剑身盒与剑尖盒的起始顶点下标。
 *
 * ⚠️ **找不到 / 不唯一时抛错，不静默返回 0**：返回 0 会让剑体变成「产物开头那 48 个顶点」
 * （那是躯干），而顶点数/三角数/索引值域**全部仍然正确** —— 只有画面能看出。
 *
 * @param {{bones:Array<{name:string}>, geometry:{position:number[], skinIndex:number[]}}} asset
 * @returns {{bodyStart:number, tipStart:number}}
 */
export function selectBladeBoxes(asset) {
  const names = asset.bones.map((b) => b.name);
  const pos = asset.geometry.position;
  const si = asset.geometry.skinIndex;
  const groups = new Map([[SPIKE_BLADE_BONES.body, []], [SPIKE_BLADE_BONES.tip, []]]);
  for (let s = 0; s < pos.length / 3; s += VERTS_PER_BOX) {
    const list = groups.get(names[si[s * 4]]);
    if (!list) continue;
    let zMin = Infinity;
    let zMax = -Infinity;
    for (let i = s; i < s + VERTS_PER_BOX; i++) {
      const z = pos[i * 3 + 2];
      if (z < zMin) zMin = z;
      if (z > zMax) zMax = z;
    }
    list.push({ start: s, zSpan: zMax - zMin });
  }
  const pick = (boneName, label) => {
    const list = groups.get(boneName);
    if (list.length === 0) {
      throw new Error(`[剑体] 产物里找不到骨骼 "${boneName}" 的任何盒（${label}）`);
    }
    const best = list.reduce((p, q) => (q.zSpan > p.zSpan ? q : p));
    const ties = list.filter((b) => Math.abs(b.zSpan - best.zSpan) < 1e-9);
    if (ties.length !== 1) {
      throw new Error(`[剑体] 骨骼 "${boneName}" 的 z 跨度最大盒不唯一（${ties.length} 个）`);
    }
    return best.start;
  };
  return {
    bodyStart: pick(SPIKE_BLADE_BONES.body, '剑身'),
    tipStart: pick(SPIKE_BLADE_BONES.tip, '剑尖'),
  };
}

/**
 * 造剑体几何：抽两盒 → 轴置换立起 → 露出段落在 `[0, exposeHeight]`。
 *
 * 变换（spec §3.3，唯一入口）：
 * ```
 *   local.x = raw.y − centerY                     // 剑面宽 → 世界 X
 *   local.y = (maxZ − raw.z) − (L − exposeHeight) // 剑轴 → 世界 Y，剑尖在上
 *   local.z = raw.x − centerX                     // 剑厚 → 世界 Z
 *   normal:  (nx, ny, nz) → (ny, −nz, nx)         // 同一轴置换，不平移
 *   uv:      原样搬（产物 UV 已正确，剑身六面实测 100% 不透明）
 * ```
 *
 * 法线置换的逐面验证：`+X`（厚面）→ `(0,0,1)` 世界 Z；`+Y`（宽面）→ `(1,0,0)` 世界 X；
 * `−Z`（剑尖端）→ `(0,1,0)` 世界 +Y。
 *
 * ⚠️ **三轴同比例 scale 仍然正确**：缩放后 y 范围 `[−buried×s, expose×s]`，地面 y=0 不动
 * ⇒ 露出高度恰好 `expose×s`，读作「整根从地里长出来」（与锥体 translate 同一分工）。
 *
 * @param {object} asset `loadIgnisAsset()` 的结果
 * @param {number} exposeHeight 露出地面的高度（格）
 * @returns {{position:number[], normal:number[], uv:number[], index:number[], metrics:object}}
 */
export function buildSpikeBladeGeometry(asset, exposeHeight) {
  const { bodyStart, tipStart } = selectBladeBoxes(asset);
  const starts = [bodyStart, tipStart];
  const src = asset.geometry;

  // ① 收 raw 顶点 + 建「产物下标 → 输出下标」映射（两盒下标不连续时也对）
  const remap = new Map();
  const raw = [];
  for (const s of starts) {
    for (let i = s; i < s + VERTS_PER_BOX; i++) {
      remap.set(i, raw.length);
      raw.push([src.position[i * 3], src.position[i * 3 + 1], src.position[i * 3 + 2]]);
    }
  }

  // ② raw bbox（剑在模型里沿 −Z 躺着：z 越小越靠剑尖）
  let xMin = Infinity; let xMax = -Infinity;
  let yMin = Infinity; let yMax = -Infinity;
  let zMin = Infinity; let zMax = -Infinity;
  for (const p of raw) {
    if (p[0] < xMin) xMin = p[0];
    if (p[0] > xMax) xMax = p[0];
    if (p[1] < yMin) yMin = p[1];
    if (p[1] > yMax) yMax = p[1];
    if (p[2] < zMin) zMin = p[2];
    if (p[2] > zMax) zMax = p[2];
  }
  const length = zMax - zMin;
  const centerX = (xMin + xMax) / 2;
  const centerY = (yMin + yMax) / 2;
  const buried = length - exposeHeight;

  // ③ 轴置换
  const position = [];
  const normal = [];
  const uv = [];
  let outXMin = Infinity; let outXMax = -Infinity;
  let outYMin = Infinity; let outYMax = -Infinity;
  let outZMin = Infinity; let outZMax = -Infinity;
  for (const [srcIndex, outIndex] of remap) {
    const p = raw[outIndex];
    const x = p[1] - centerY;
    const y = (zMax - p[2]) - buried;
    const z = p[0] - centerX;
    position.push(x, y, z);
    normal.push(
      src.normal[srcIndex * 3 + 1],
      -src.normal[srcIndex * 3 + 2],
      src.normal[srcIndex * 3],
    );
    uv.push(src.uv[srcIndex * 2], src.uv[srcIndex * 2 + 1]);
    if (x < outXMin) outXMin = x;
    if (x > outXMax) outXMax = x;
    if (y < outYMin) outYMin = y;
    if (y > outYMax) outYMax = y;
    if (z < outZMin) outZMin = z;
    if (z > outZMax) outZMax = z;
  }

  // ④ 索引：只收「三个顶点都在选中两盒里」的三角，逐个映射到 [0, 48)
  const index = [];
  for (let t = 0; t < src.index.length; t += 3) {
    const a = remap.get(src.index[t]);
    const b = remap.get(src.index[t + 1]);
    const c = remap.get(src.index[t + 2]);
    if (a === undefined || b === undefined || c === undefined) continue;
    index.push(a, b, c);
  }

  const width = outXMax - outXMin;
  return {
    position,
    normal,
    uv,
    index,
    metrics: {
      vertexCount: position.length / 3,
      triangleCount: index.length / 3,
      length,
      width,
      thickness: outZMax - outZMin,
      exposeHeight,
      buriedDepth: buried,
      minY: outYMin,
      maxY: outYMax,
      halfWidth: width / 2,
    },
  };
}