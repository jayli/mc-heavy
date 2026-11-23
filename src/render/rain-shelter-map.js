// src/render/rain-shelter-map.js — 逐列遮挡高度图：扫描 / 失效 / 纹理字节（three-free）
//
// 一张 512×512 RGBA8 环形窗口，每格列存：
//   R = 从雨幕上界往下第一个截停面的高度（编码见 voxel/rain-occlusion-data.js）
//   G = 该列有无**暴露水面**（255/0）
//   B/A = 0（预留）
//
// 三个消费方共用这一份（红线 1，不得有第二份逻辑副本）：
//   雨丝 / 水花 —— CPU 查表（零体素扫描）；湿表面 —— 片元 textureLoad 采表。
//
// ⚠️ **扫描必须缓存 column 引用后直读 `col.blocks`**：实测比逐格 `world.getBlockId`
// 快 23.6 倍（后者每格要重算 cx/cz + 拼字符串 columnKey + Map.get）。
// 单位口径：**column = 16×16×128 区块 = 256 个「格列」**。预算 8 column/帧 = 0.098 ms。
//
// ⚠️ 本文件不 import three ⇒ Node 单测可直接跑扫描与失效逻辑。
import { WORLD_MIN_Y, WATER_SURFACE_SINK, blockIndex, columnKey } from '../voxel/constants.js';
import {
  SHELTER_MAP_SIZE, SHELTER_WINDOW_COLS, encodeStopY, decodeStopY, shelterTexelIndex,
} from '../voxel/rain-occlusion-data.js';
import { blocksRain, RAIN_CEILING_Y } from './rain-shelter.js';
import { isWaterLike } from './water-surface.js';

const MASK = SHELTER_MAP_SIZE - 1;
/** 每帧默认预算（column 数）。8 × 0.0122 ms ≈ 0.098 ms */
const DEFAULT_BUDGET = 8;
/** 预热半径（column）：1 ⇒ 3×3 = 9 column，覆盖玩家 ±24 格 */
const WARMUP_RADIUS = 1;

export class RainShelterMap {
  /**
   * @param {{world: import('../voxel/world-data.js').WorldData, registry: object}} opts
   */
  constructor({ world, registry }) {
    this.world = world;
    this.registry = registry;
    /** 纹理字节，唯一权威（1 MiB）。初值全 0 = 全窗未知 = 不遮挡 */
    this.data = new Uint8Array(SHELTER_MAP_SIZE * SHELTER_MAP_SIZE * 4);
    /** 窗口原点（格，16 对齐）。**只用于 CPU 判「哪些 column 在窗内」** */
    this.originX = 0;
    this.originZ = 0;
    this.lastTickColumns = 0;

    // 热循环只读字节表（按 registry 建一次）
    this._rainTab = new Uint8Array(registry.count);
    this._waterTab = new Uint8Array(registry.count);
    for (let i = 0; i < registry.count; i++) {
      this._rainTab[i] = blocksRain(i, registry) ? 1 : 0;
      this._waterTab[i] = isWaterLike(i, registry) ? 1 : 0;
    }
    this._opaque = registry.opaqueTable;

    /** columnKey → 已扫时的 version（失效判据） */
    this._scanned = new Map();
    /** 待扫队列（columnKey），近处优先；invalidateColumn 插队首 */
    this._queue = [];
    this._queued = new Set();
    this._centerX = 0;
    this._centerZ = 0;
    this._enqueueWindow();
  }

  /** 该坐标是否在窗口内（窗外一律未知 —— 绝对索引会 wrap 到别列） */
  _inWindow(x, z) {
    const dx = x - this.originX; const dz = z - this.originZ;
    return dx >= 0 && dx < SHELTER_MAP_SIZE && dz >= 0 && dz < SHELTER_MAP_SIZE;
  }

  /**
   * 该格列的截停面高度。
   * @returns {number|null} null = 未知 / 无截停面 / 窗外（调用方按**不遮挡**处理）
   */
  stopAt(x, z) {
    if (!this._inWindow(Math.floor(x), Math.floor(z))) return null;
    return decodeStopY(this.data[shelterTexelIndex(x, z) * 4]);
  }

  /** 该格列有无暴露水面（雨丝水下门的列级因子） */
  waterAt(x, z) {
    if (!this._inWindow(Math.floor(x), Math.floor(z))) return false;
    return this.data[shelterTexelIndex(x, z) * 4 + 1] === 255;
  }

  /**
   * 窗口原点跟随玩家（16 格步进）。
   *
   * ⚠️ 平移时清零**离开窗口的那批 texel**并入队 —— 绝对索引下，新进入的列与
   * 离开的旧列占用同一批 texel（模 512）。清零条带 = `(originOLD & 511) .. +15`。
   * ⚠️ 两个错写法：固定 `[0,15]`（只在 origin ≡ 0 mod 512 时对）、
   * `((origin+16) & 511)..+15`（偏了 16）。
   * ⚠️ 清零**必须伴入队**，否则那批 texel 永远停在未知。
   */
  setCenter(x, z) {
    this._centerX = x; this._centerZ = z;
    const nx = Math.floor(x / 16) * 16 - (SHELTER_MAP_SIZE / 2);
    const nz = Math.floor(z / 16) * 16 - (SHELTER_MAP_SIZE / 2);
    if (nx === this.originX && nz === this.originZ) return;
    const ox = this.originX; const oz = this.originZ;
    this.originX = nx; this.originZ = nz;
    // 离开窗口的 column：旧窗内、新窗外
    const ocx0 = Math.floor(ox / 16); const ocz0 = Math.floor(oz / 16);
    for (let a = 0; a < SHELTER_WINDOW_COLS; a++) {
      for (let b = 0; b < SHELTER_WINDOW_COLS; b++) {
        const cx = ocx0 + a; const cz = ocz0 + b;
        const gx = cx * 16; const gz = cz * 16;
        if (this._inWindow(gx, gz)) continue;
        // 清掉这个 column 的 16×16 个 texel（绝对索引 ⇒ 位置由绝对坐标决定）
        for (let lz = 0; lz < 16; lz++) {
          for (let lx = 0; lx < 16; lx++) {
            const i = shelterTexelIndex(gx + lx, gz + lz) * 4;
            this.data[i] = 0; this.data[i + 1] = 0;
          }
        }
        this._scanned.delete(columnKey(cx, cz));
      }
    }
    this._enqueueWindow();
  }

  /** 把窗内所有「未扫 / version 变了」的 column 入队，按到中心的切比雪夫距离排序 */
  _enqueueWindow() {
    const cx0 = Math.floor(this.originX / 16); const cz0 = Math.floor(this.originZ / 16);
    const ccx = Math.floor(this._centerX / 16); const ccz = Math.floor(this._centerZ / 16);
    const add = [];
    for (let a = 0; a < SHELTER_WINDOW_COLS; a++) {
      for (let b = 0; b < SHELTER_WINDOW_COLS; b++) {
        const cx = cx0 + a; const cz = cz0 + b;
        const k = columnKey(cx, cz);
        if (this._queued.has(k)) continue;
        const col = this.world.getColumn(cx, cz);
        if (!col) continue;                       // 未加载 ⇒ 不入队（保持未知）
        if (this._scanned.get(k) === col.version) continue;
        this._queued.add(k);
        add.push({ k, d: Math.max(Math.abs(cx - ccx), Math.abs(cz - ccz)) });
      }
    }
    add.sort((p, q) => p.d - q.d);
    for (const it of add) this._queue.push(it.k);
  }

  /**
   * 编辑事件：把该 column 插到**队首**（玩家挖放当帧就重扫，不等轮到）。
   * @param {number} cx @param {number} cz column 坐标
   */
  invalidateColumn(cx, cz) {
    const k = columnKey(cx, cz);
    this._scanned.delete(k);
    if (this._queued.has(k)) {
      const at = this._queue.indexOf(k);
      if (at > 0) { this._queue.splice(at, 1); this._queue.unshift(k); }
      return;
    }
    this._queued.add(k);
    this._queue.unshift(k);
  }

  /**
   * 同步预热玩家周围 3×3 = 9 column（**不走每帧预算**）。
   *
   * ⚠️ 不得写成「首帧满预算 tick」：满预算 = 8 column，不足以覆盖 3×3；
   * 而整窗 1024 column 全扫要 12.5 ms ⇒ 爆帧。
   * @returns {number} 实扫 column 数
   */
  warmup(x, z) {
    const ccx = Math.floor(x / 16); const ccz = Math.floor(z / 16);
    let n = 0;
    for (let a = -WARMUP_RADIUS; a <= WARMUP_RADIUS; a++) {
      for (let b = -WARMUP_RADIUS; b <= WARMUP_RADIUS; b++) {
        if (this._scanColumn(ccx + a, ccz + b)) n++;
      }
    }
    return n;
  }

  /**
   * 推进扫描队列。
   * @param {number} [budget=8] 本帧最多扫几个 **column**
   * @returns {number} 实扫数；>0 表示纹理需重传
   */
  tick(budget = DEFAULT_BUDGET) {
    this._enqueueWindow();
    let n = 0;
    while (n < budget && this._queue.length > 0) {
      const k = this._queue.shift();
      this._queued.delete(k);
      const sep = k.indexOf(',');
      const cx = Number(k.slice(0, sep)); const cz = Number(k.slice(sep + 1));
      if (this._scanColumn(cx, cz)) n++;
    }
    this.lastTickColumns = n;
    return n;
  }

  /**
   * 扫一个 column（256 个格列），写 256 个 texel。
   * @returns {boolean} 是否真的扫了（列不存在 / 已扫同版本 ⇒ false）
   */
  _scanColumn(cx, cz) {
    const col = this.world.getColumn(cx, cz);
    if (!col) return false;
    const k = columnKey(cx, cz);
    if (this._scanned.get(k) === col.version) return false;
    const blocks = col.blocks;               // 直读 typed array（比 getBlockId 快 23.6×）
    const rainTab = this._rainTab; const waterTab = this._waterTab;
    const opaque = this._opaque;
    const gx0 = cx * 16; const gz0 = cz * 16;
    for (let lz = 0; lz < 16; lz++) {
      const zBase = lz * 16;
      for (let lx = 0; lx < 16; lx++) {
        // 单遍自上而下：首个挡雨块顶面 ∨ 首个暴露水面，取**先遇到的**
        // （已证与既有 max(rainShelterY, waterSurfaceYAt) 等价，4000 点 0 不符）
        let stop = null; let hasWater = 0;
        let prev = 0;
        let idx = lx + zBase + (RAIN_CEILING_Y - WORLD_MIN_Y) * 256;
        for (let y = RAIN_CEILING_Y; y >= WORLD_MIN_Y; y--, idx -= 256) {
          const cid = blocks[idx];
          if (rainTab[cid] === 1) { stop = y + 1; break; }
          if (waterTab[cid] === 1 && opaque[prev] !== 1 && prev !== cid) {
            stop = y + 1 - WATER_SURFACE_SINK; hasWater = 255; break;
          }
          prev = cid;
        }
        const i = shelterTexelIndex(gx0 + lx, gz0 + lz) * 4;
        this.data[i] = encodeStopY(stop);
        this.data[i + 1] = hasWater;
        this.data[i + 2] = 0;
        this.data[i + 3] = 0;
      }
    }
    this._scanned.set(k, col.version);
    return true;
  }

  /** 诊断（测试与调试面板消费） */
  debugState() {
    return {
      queued: this._queue.length,
      scanned: new Set(this._scanned.keys()),
      originX: this.originX,
      originZ: this.originZ,
      lastTickColumns: this.lastTickColumns,
    };
  }
}