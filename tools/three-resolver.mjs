// tools/three-resolver.mjs — Node 侧把裸 specifier `three` 映射到本仓 vendor/（v3.15）
//
// **为什么需要它**：`src/**` 用 import map 在浏览器里解析 `three`，而 **Node 不认 import map**。
// 单测文件（test-zombies / test-ignis-render / test-guardian-* 等）import three 是为了在
// 受控场景下断言 InstancedMesh 容量 / 骨骼矩阵，**不需要 GPU** ⇒ Node 里能跑。
//
// **为什么不改 package.json 的 imports 字段**：那会改动生产解析口径（红线：测试设施不得
// 影响运行时语义）。用 `module.register` 只在**测试进程**里生效。
//
// ⚠️ 路径与 index.html 的 import map **必须一致**（同一份 vendor 产物），否则两侧测的是
// 不同 three 版本 —— 那是「两套语义」，比跑不了更危险。
const MAP = {
  three: './three.webgpu.js',
  'three/tsl': './three.tsl.js',
  'three/webgpu': './three.webgpu.js',
};

export async function resolve(specifier, context, nextResolve) {
  if (MAP[specifier]) {
    return nextResolve(new URL(`../vendor/three/${MAP[specifier].slice(2)}`, import.meta.url).href, context);
  }
  if (specifier.startsWith('three/addons/')) {
    const rest = specifier.slice('three/addons/'.length);
    return nextResolve(new URL(`../vendor/three/addons/${rest}`, import.meta.url).href, context);
  }
  return nextResolve(specifier, context);
}