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
  const geometryNames = []; // index → geometryType 字符串
  let count = 0;
  let frozen = false;

  return {
    get count() { return count; },
    solidTable, opaqueTable, cullTable, emissiveTable, geometryTable, orientationModesTable,
    supportsPlayerTable,

    /**
     * @param {string} name
     * @param {{solid?: boolean, opaque?: boolean, supportsPlayer?: boolean, cullMode?: string,
     *          emissive?: number, geometry?: string, orientationModes?: number}} def
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
      supportsPlayerTable[id] = def.supportsPlayer ? 1 : 0;
      cullTable[id] = CULL_MODES[def.cullMode ?? 'opaque'];
      emissiveTable[id] = def.emissive ?? 0;
      let gi = geometryNames.indexOf(def.geometry ?? 'cube');
      if (gi === -1) { gi = geometryNames.length; geometryNames.push(def.geometry ?? 'cube'); }
      geometryTable[id] = gi;
      orientationModesTable[id] = def.orientationModes ?? 0;
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
