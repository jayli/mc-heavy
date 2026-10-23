// src/voxel/block-registry.js — 方块注册表 + typed 属性表（设计文档 §4.1）
// 不依赖 three；主线程/Worker 同构可用。

const CULL_MODES = { opaque: 0, cutout: 1, transparent: 2, none: 3 };
const MAX_BLOCKS = 512; // Uint16 ID 空间内预留

export function createRegistry() {
  const nameToId = new Map();
  const idToName = new Array(MAX_BLOCKS).fill(null);
  const solidTable = new Uint8Array(MAX_BLOCKS);
  const opaqueTable = new Uint8Array(MAX_BLOCKS);
  const cullTable = new Uint8Array(MAX_BLOCKS);
  const emissiveTable = new Uint8Array(MAX_BLOCKS);
  const geometryTable = new Uint8Array(MAX_BLOCKS);
  const orientationModesTable = new Uint8Array(MAX_BLOCKS);
  /** 向下 Y 碰撞支撑表（M2-7）：默认 0，仅 cloud=1（可站立、非实心） */
  const supportsPlayerTable = new Uint8Array(MAX_BLOCKS);
  /** 不可破坏表（M8）：徒手挖块 / 枪械破坏 / 爆炸过滤三个消费者共用单一权威 */
  const indestructibleTable = new Uint8Array(MAX_BLOCKS);
  /**
   * 太阳阴影投射表（§4.4.4）：默认 1（投影），仅声明 `shadowCast:false` 的方块为 0。
   * 唯一消费方是 mesher（写 packed bit14）→ materials.js 的 `maskShadowNode` 在阴影 pass
   * 逐片元 discard。对齐 mc-lite `BlockData.isShadowEnabled:false` 的 20 项白名单口径
   * （其中 air/collider/water/swamp_water/realistic_trunk_collider/bed_alias_block/mine_cart
   * 在 mc-heavy 走 cullMode 'none'/'transparent' 或不是方块 → 通道级已排除，无需声明）。
   */
  const shadowCastTable = new Uint8Array(MAX_BLOCKS);
  /**
   * 镂空遮挡体表（v1.70）：cutout 通道 + opaqueTable=1 的方块 = 贴图有孔洞却参与邻居面剔除。
   * 当前 13 个树叶族。**不是新声明字段**：完全由 `cullMode` 与 `opaque` 派生（红线 1：
   * 声明侧仍是唯一权威，不新增一份“哪些是树叶”名单）。
   * 消费方只有 mesher 的面剔除：邻居是镂空体时**不剔**本方块朝向它的那一面。
   * 理由：镂空体贴图有孔洞（alphaTest 逐片元 discard），拿它当实心遮挡体会让玩家透过孔洞
   * 看到背后的空气（用户报告）；代价 = 每条「实心↔镂空体」接触面 +1 面。
   */
  const hollowOccluderTable = new Uint8Array(MAX_BLOCKS);
  const geometryNames = []; // index → geometryType 字符串
  let count = 0;
  let frozen = false;

  return {
    get count() { return count; },
    solidTable, opaqueTable, cullTable, emissiveTable, geometryTable, orientationModesTable,
    supportsPlayerTable, indestructibleTable, shadowCastTable, hollowOccluderTable,

    /**
     * @param {string} name
     * @param {{solid?: boolean, opaque?: boolean, supportsPlayer?: boolean, cullMode?: string,
     *          emissive?: number, geometry?: string, orientationModes?: number,
     *          indestructible?: boolean, shadowCast?: boolean}} def
     */
    register(name, def) {
      if (frozen) throw new Error('registry is frozen');
      if (nameToId.has(name)) throw new Error(`duplicate block name: ${name}`);
      if (count >= MAX_BLOCKS) throw new Error('block id space exhausted');
      const id = count++;
      nameToId.set(name, id);
      idToName[id] = name;
      solidTable[id] = def.solid ? 1 : 0;
      opaqueTable[id] = (def.opaque ?? (def.cullMode === 'opaque')) ? 1 : 0;
      // 镂空遮挡体：cutout 通道（拿到 alphaTest，贴图孔洞生效）+ 参与邻居面剔除。
      // 派生而非声明：任何“镂空但对 opaqueTable 贡献了 1”的方块自动落入本表，
      // 不会出现「新加一个镂空方块却忘了登记 → 又看穿背后」的静默回归。
      hollowOccluderTable[id] = (def.cullMode === 'cutout' && opaqueTable[id] === 1) ? 1 : 0;
      supportsPlayerTable[id] = def.supportsPlayer ? 1 : 0;
      cullTable[id] = CULL_MODES[def.cullMode ?? 'opaque'];
      emissiveTable[id] = def.emissive ?? 0;
      let gi = geometryNames.indexOf(def.geometry ?? 'cube');
      if (gi === -1) { gi = geometryNames.length; geometryNames.push(def.geometry ?? 'cube'); }
      geometryTable[id] = gi;
      orientationModesTable[id] = def.orientationModes ?? 0;
      indestructibleTable[id] = def.indestructible ? 1 : 0;
      shadowCastTable[id] = (def.shadowCast ?? true) ? 1 : 0;
      return id;
    },

    freeze() { frozen = true; },
    /**
     * 按注册顺序返回 `{id, name}[]` 只读快照（§4.1 v1.16 补记）。
     * 唯一消费方是 §4.5.4 背包物品集合构建（冷路径、一次性），
     * **禁止**进入 meshing/物理热路径（热路径仍走 typed 表 + 数字 ID）。
     * 冻结后结果不变，调用方可安全缓存。
     */
    all() {
      const out = new Array(count);
      for (let id = 0; id < count; id++) out[id] = { id, name: idToName[id] };
      return out;
    },
    idOf(name) { return nameToId.get(name); },
    nameOf(id) { return idToName[id]; },
    geometryNameOf(id) { return geometryNames[geometryTable[id]]; },
    /** 向下 Y 碰撞支撑（M2-7）：仅 cloud 为 true */
    supportsPlayer(id) { return supportsPlayerTable[id] === 1; },
    /**
     * 该方块是否不可被破坏（M8）。未知 id 返回 false（防御：不存在的方块不该被当成不可破坏）。
     * 三个消费者共用：`Player.digBlock()` 徒手挖块 / `weapon-target-policy.js` 枪械破坏 /
     * `computeExplosion()` 爆炸过滤。各写一份字面量会漂移出「TNT 炸得掉但玩家挖不掉」的撕裂语义。
     * @param {number} id @returns {boolean}
     */
    isIndestructible(id) {
      return Number.isInteger(id) && id >= 0 && id < MAX_BLOCKS ? indestructibleTable[id] === 1 : false;
    },
    /**
     * 该方块是否向太阳阴影贴图投射（§4.4.4）。未知 id 返回 false（防御：不认识的方块
     * 不该投影）。消费方只有 mesher 一处，但走表而非在 mesher 里写字面量名单 ——
     * 与 `indestructibleTable` 同一手法（红线 1：声明侧单一权威）。
     * @param {number} id @returns {boolean}
     */
    castsShadow(id) {
      return Number.isInteger(id) && id >= 0 && id < MAX_BLOCKS ? shadowCastTable[id] === 1 : false;
    },
  };
}

/** 预填充全部方块的生产单例（main.js / worker 各自构建，数据同源） */
export function buildDefaultRegistry() {
  // 延迟 import 避免循环依赖；blocks-data.js 只含数据
  return import('./blocks-data.js').then(({ BLOCKS }) => {
    const reg = createRegistry();
    for (const def of BLOCKS) reg.register(def.name, def);
    reg.freeze();
    return reg;
  });
}
