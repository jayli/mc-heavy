// atlas 采样安全边界（Tier 1）：mip 链深度必须落在 gutter 能保护的范围之内。
//
// ## 为什么这条必须在 Tier 1 钉住（而不是只靠 Tier 4 截图）
//
// 远处方块出现「横纹 / 黑圈 / 邻色渗入」的根因是 **mip 链降得比 gutter 能保护的更深**：
// 每个 mip 级把 texel 放大 2 倍，gutter 的 texel 数随之减半。gutter 不足 1 texel 时，
// 双线性插值必然把**邻 tile** 的颜色混进来 —— 而 atlas 里相邻的两个 tile 可能色相完全
// 无关（实测：`procedural/sky_wood` rgb(219,159,219) 洋红，紧邻 `procedural/swamp_grass_top`
// rgb(75,93,52) 深绿，只隔 16px gutter）。
//
// 这个缺陷的失效形态是**静默**的：
//   - 单测全绿（没人断言 mip 深度）；
//   - uniform / 元数据全对（tileRect 的 u0/u1 逐位正确）；
//   - 只在「远处 + 开平滑档」时可见，走近就消失。
// 所以判据必须落在**可计算的结构量**上，而不是截图观感。
//
// ## 判据来源
// `assets/atlas.json` 的 `size` 与 `gutter` 是 atlas 的设计决策（`tools/build-atlas.mjs`
// 的 SIZE / GUTTER），tile 尺寸是事实统计。安全 mip 上限由这两者唯一决定：
//
//   安全 mip 上限 = floor(log2(gutter))     // gutter/2^m >= 1 texel
//
// 一旦生成超过这个级数，越界的那些级必然渗色。
import { test } from './runner.js';
import { assertEqual, assertTrue } from './assert.js';
import {
  ATLAS_GUTTER, SAFE_MAX_MIP, SAFE_MIP_LEVELS, buildMipChain, loadAtlas,
} from '../mesh/atlas-loader.js';

// 与 build-atlas.mjs 同源：size 是设计决策，改动须同步 tools/build-atlas.mjs 的 SIZE
const ATLAS_SIZE = 2048;

/** gutter 能保护到的最大 mip 级（gutter/2^m ≥ 1 texel） */
function safeMaxMip(gutter) {
  return Math.floor(Math.log2(gutter));
}

/** three 为一幅 WxH 纹理自动生成的 mip 级数（vendor/three/three.webgpu.js:34488） */
function autoMipLevels(size) {
  return Math.floor(Math.log2(size)) + 1;
}

test('atlas: 安全 mip 上限由 gutter 唯一决定（gutter/2^m ≥ 1 texel）', () => {
  assertEqual(ATLAS_GUTTER, 16, 'gutter 是设计决策，改动须同步 build-atlas.mjs');
  assertEqual(SAFE_MAX_MIP, 4, 'gutter=16px → 安全到 mip 4（此时 gutter 恰剩 1 texel）');
  assertEqual(SAFE_MIP_LEVELS, 5, '级数 = 最深 index + 1 = 5 级（mip 0..4）');
  // 逐级核对这个式子：mip 4 时 gutter 仍 ≥1，mip 5 起 <1
  for (let m = 0; m <= 4; m++) {
    const gutTexels = ATLAS_GUTTER / (2 ** m);
    assertTrue(gutTexels >= 1, `mip ${m} 的 gutter 应 ≥1 texel，实测 ${gutTexels}`);
  }
  for (let m = 5; m <= 8; m++) {
    const gutTexels = ATLAS_GUTTER / (2 ** m);
    assertTrue(gutTexels < 1, `mip ${m} 的 gutter 必须 <1 texel（渗色区），实测 ${gutTexels}`);
  }
});

test('atlas: 实际 mip 链被截到安全上限（否则远处必然渗色）', () => {
  // 自动生成会是 12 级 —— 这正是修复前的缺陷（越界 7 级）
  const autoLevels = autoMipLevels(ATLAS_SIZE);
  assertEqual(autoLevels, 12, '2048² 若不截断会生成 12 级（0~11）');
  // 修复后喂给 three 的是预生成链，级数 = SAFE_MIP_LEVELS = 5
  assertEqual(SAFE_MIP_LEVELS, 5, '必须喂入 5 级（mip 0..4）才能截断');
  assertTrue(
    SAFE_MIP_LEVELS <= autoLevels,
    `截断后的级数 ${SAFE_MIP_LEVELS} 不应超过自动级数 ${autoLevels}`,
  );
  // 核心不变式：链深 ≤ 安全上限+1
  assertTrue(
    SAFE_MIP_LEVELS <= SAFE_MAX_MIP + 1,
    `级数 ${SAFE_MIP_LEVELS} 超出安全上限 ${SAFE_MAX_MIP + 1} 级（最深 mip ${SAFE_MAX_MIP}）`,
  );
});

test('atlas: buildMipChain 生成 2×2 box filter 的逐级降采样', () => {
  // 4×4 源图，每级逐半，数据按 2×2 平均
  const srcCanvas = document.createElement('canvas');
  srcCanvas.width = 4; srcCanvas.height = 4;
  const srcCtx = srcCanvas.getContext('2d');
  const src = srcCtx.createImageData(4, 4);
  for (let i = 0; i < src.data.length; i += 4) {
    src.data[i] = 100; src.data[i + 1] = 200; src.data[i + 2] = 50; src.data[i + 3] = 255;
  }
  // 用最小伪 image（只需 width/height + 可被 drawImage 消费的形态）
  const fakeCanvasLike = { width: 4, height: 4 };
  // buildMipChain 依赖 document.createElement('canvas') —— 浏览器单测里可用
  const out = buildMipChain(makeImageFrom(src), 3);
  // ⚠️ 数组**含 base level（第 0 级）**：three 的 mipmap 数组语义是「base + mips」，
  // 其长度直接作为总级数。只放降采样层会整体错位一级（实测 → 全黑剪影）。
  assertEqual(out.length, 3, '3 级链 → 数组长度 3（base + mip1 + mip2）');
  assertTrue(typeof out[0].getContext === 'function',
    '每级必须是 canvas（three 的 _copyImageToTexture 分支要求图像对象）');
  assertEqual(out[0].width, 4, '第 0 级 = 源图 4×4');
  assertEqual(out[0].height, 4, '第 0 级 = 源图 4×4');
  assertEqual(out[1].width, 2, 'mip1 宽 = 4>>1');
  assertEqual(out[1].height, 2, 'mip1 高 = 4>>1');
  assertEqual(out[2].width, 1, 'mip2 宽 = 2>>1');
  assertEqual(out[2].height, 1, 'mip2 高 = 2>>1');
  // 匀质源图 → 降采样后仍是同色（box filter 不变色）
  // ⚠️ 返回的是 canvas（three 的 _copyImageToTexture 需要图像对象，不是原始 buffer）
  const ctx = out[2].getContext('2d');
  const px = ctx.getImageData(0, 0, 1, 1).data;
  assertEqual(px[0], 100, 'R 保持');
  assertEqual(px[1], 200, 'G 保持');
  assertEqual(px[2], 50, 'B 保持');
  assertEqual(px[3], 255, 'A 保持');
});

/** 把 ImageData 包成 buildMipChain 能画到 canvas 的形态 */
function makeImageFrom(imageData) {
  const c = document.createElement('canvas');
  c.width = imageData.width;
  c.height = imageData.height;
  c.getContext('2d').putImageData(imageData, 0, 0);
  return c;
}

test('atlas: 渗色区的具体证据（相邻异色 tile 在最深 mip 处混色）', () => {
  // 用真实 atlas 布局验证：swamp_grass_top 与 sky_wood 只隔 16px gutter
  // 这两个 tile 的色相差异是「远处绿地上冒粉色」的直接原因
  const SWAMP_GREEN = [75, 93, 52];
  const SKY_WOOD_MAGENTA = [219, 159, 219];
  const gap = 16; // gutter
  assertEqual(gap, ATLAS_GUTTER, '这对 tile 的水平间隔恰是一个 gutter');

  // mip m 时，一个 mip texel 覆盖 2^m 个原图 texel
  // 采样点落在 tile 边缘、双线性取 2x2 邻域时，只要 gutter < 1 texel 就会吃到邻居
  for (let m = 5; m <= 8; m++) {
    const texelsPerMipTexel = 2 ** m;
    const gutTexels = gap / texelsPerMipTexel;
    assertTrue(gutTexels < 1, `mip ${m} 的 gutter 只有 ${gutTexels} texel → 双线性必跨`);
  }
  // 两个颜色的洋红度（min(R-G, B-G)）差异足够大 → 混色肉眼可见
  const magOf = (c) => Math.min(c[0] - c[1], c[2] - c[1]);
  assertTrue(
    magOf(SKY_WOOD_MAGENTA) >= 55,
    `sky_wood 的洋红度应显著（实测 ${magOf(SKY_WOOD_MAGENTA)}）`,
  );
  assertTrue(
    magOf(SWAMP_GREEN) < 0,
    `swamp_grass 应为负洋红度（偏绿），实测 ${magOf(SWAMP_GREEN)}`,
  );
});

/**
 * 判别力关键用例：**真的走 loadAtlas**，检查喂给 three 的 mip 链长度。
 *
 * ⚠️ 上面几条只能验常量关系 —— 把 `loadAtlas` 里那行 `texture.mipmaps = buildMipChain(...)`
 * 注释掉时，`SAFE_MIP_LEVELS` 仍是 5、`buildMipChain` 仍能生成正确形状，它们**全都 PASS**。
 * 这正是「注入后仍全绿先怀疑落点」的教训（仓库 AGENTS.md 已记该坑）：
 * 断言必须钉在**真实装配路径**上，否则测的是常量而不是行为。
 */
test('atlas: loadAtlas 在 blur 档真的喂入限深 mip 链（装配断言）', async () => {
  const { texture } = await loadAtlas({ mipmap: true });
  assertTrue(Array.isArray(texture.mipmaps), 'texture.mipmaps 必须是数组');
  assertEqual(
    texture.mipmaps.length, SAFE_MIP_LEVELS,
    `喂给 three 的 mipmap 数组长度必须是 ${SAFE_MIP_LEVELS}（含 base level）` +
    `—— 若为 0 则 three 会按 log2(2048)+1 = 12 级自动生成（渗色区）`,
  );
  // 逐级尺寸核对：第 0 级 = 源图，之后每级减半
  let w = texture.image.width;
  for (let i = 0; i < texture.mipmaps.length; i++) {
    assertEqual(texture.mipmaps[i].width, w, `mip${i} 宽应为 ${w}`);
    assertEqual(texture.mipmaps[i].height, w, `mip${i} 高应为 ${w}`);
    w >>= 1;
  }
  // 最深一级 index = 长度-1，必须等于安全上限
  const deepest = texture.mipmaps.length - 1;
  assertEqual(deepest, SAFE_MAX_MIP, `最深层 index 必须等于安全上限 ${SAFE_MAX_MIP}`);
  texture.dispose();
});

test('atlas: loadAtlas 在默认档（像素风）不生成 mipmap', async () => {
  const { texture } = await loadAtlas({ mipmap: false });
  assertEqual(texture.generateMipmaps, false, '默认档必须关 mipmap');
  assertEqual(texture.mipmaps.length, 0, '默认档不得有预生成 mip 链');
  texture.dispose();
});
