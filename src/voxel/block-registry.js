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
  const geometryNames = []; // index → geometryType 字符串
  let count = 0;
  let frozen = false;

  return {
    get count() { return count; },
    solidTable, opaqueTable, cullTable, emissiveTable, geometryTable, orientationModesTable,

    /**
     * @param {string} name
     * @param {{solid?: boolean, opaque?: boolean, cullMode?: string,
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
      cullTable[id] = CULL_MODES[def.cullMode ?? 'opaque'];
      emissiveTable[id] = def.emissive ?? 0;
      let gi = geometryNames.indexOf(def.geometry ?? 'cube');
      if (gi === -1) { gi = geometryNames.length; geometryNames.push(def.geometry ?? 'cube'); }
      geometryTable[id] = gi;
      orientationModesTable[id] = def.orientationModes ?? 0;
      return id;
    },

    freeze() { frozen = true; },
    idOf(name) { return nameToId.get(name); },
    nameOf(id) { return idToName[id]; },
    geometryNameOf(id) { return geometryNames[geometryTable[id]]; },
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
