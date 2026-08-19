// src/core/worker-pool.js — Worker 池 + RPC（设计文档 §3/§4.9）
// 主线程与 worker 侧共用本文件：WorkerPool 在主线程用，installRpcHandler 在 worker 用。
// 注意：本文件不得 import three（worker 侧无 import map，设计文档 §3 约束）。

let _nextCallId = 1;

export class WorkerPool {
  /**
   * @param {Object} opts
   * @param {string} opts.workerUrl worker 入口 URL
   * @param {number} [opts.size] 池大小，默认 max(3, hardwareConcurrency - 1)
   */
  constructor({ workerUrl, size }) {
    const n = size ?? Math.max(3, (navigator.hardwareConcurrency || 4) - 1);
    this._workers = [];
    this._pending = new Map(); // callId -> { resolve, reject, workerIdx }
    this._inflight = new Array(n).fill(0); // 每 worker 在途任务数
    for (let i = 0; i < n; i++) {
      const w = new Worker(workerUrl, { type: 'module' });
      w.addEventListener('message', (ev) => this._onMessage(i, ev.data));
      w.addEventListener('error', (err) => this._onWorkerError(i, err));
      this._workers.push(w);
    }
    this.ready = Promise.resolve(); // 预留：未来如需 worker 握手可改异步
  }

  _onMessage(workerIdx, msg) {
    if (!msg || msg.__rpc !== true) return;
    const pending = this._pending.get(msg.id);
    if (!pending) return; // 已 cancel
    this._pending.delete(msg.id);
    this._inflight[workerIdx]--;
    if (msg.ok) pending.resolve(msg.result);
    else pending.reject(new Error(msg.error || 'worker task failed'));
  }

  _onWorkerError(workerIdx, err) {
    // worker 崩溃：reject 该 worker 所有在途任务
    for (const [id, p] of this._pending) {
      if (p.workerIdx === workerIdx) {
        this._pending.delete(id);
        p.reject(new Error(`worker crashed: ${err.message || err}`));
      }
    }
  }

  _pickWorker() {
    let best = 0;
    for (let i = 1; i < this._inflight.length; i++) {
      if (this._inflight[i] < this._inflight[best]) best = i;
    }
    return best;
  }

  /**
   * @param {string} method
   * @param {*} payload
   * @param {Object} [opts]
   * @param {Transferable[]} [opts.transfer]
   * @returns {{id: number, promise: Promise<*>}} callId + 结果 promise
   */
  call(method, payload, { transfer } = {}) {
    const id = _nextCallId++;
    const workerIdx = this._pickWorker();
    this._inflight[workerIdx]++;
    const promise = new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject, workerIdx });
      this._workers[workerIdx].postMessage(
        { __rpc: true, id, method, payload }, transfer || []);
    });
    return { id, promise };
  }

  /** 取消在途任务：删除 pending 并回退该 worker 的在途计数（结果回传时无处投递即丢弃，
   *  设计文档 §4.2「任务可取消」；不回退计数会让该 worker 永久显得忙，污染最闲调度） */
  cancel(callId) {
    const pending = this._pending.get(callId);
    if (pending) {
      this._pending.delete(callId);
      this._inflight[pending.workerIdx] = Math.max(0, this._inflight[pending.workerIdx] - 1);
    }
  }

  /** 广播到所有 worker（结构布局广播用，§4.2 DR-13） */
  broadcast(method, payload) {
    for (const w of this._workers) {
      w.postMessage({ __rpc: true, id: 0, method, payload, broadcast: true });
    }
  }

  dispose() {
    for (const w of this._workers) w.terminate();
    this._workers = [];
    this._pending.clear();
  }
}

/**
 * worker 侧：注册 RPC handler。
 * @param {Record<string, (payload: *) => * | Promise<*>>} handlers
 */
export function installRpcHandler(handlers) {
  self.onmessage = async (ev) => {
    const msg = ev.data;
    if (!msg || msg.__rpc !== true) return;
    const handler = handlers[msg.method];
    if (!handler) {
      self.postMessage({ __rpc: true, id: msg.id, ok: false, error: `unknown method: ${msg.method}` });
      return;
    }
    try {
      const result = await handler(msg.payload);
      self.postMessage({ __rpc: true, id: msg.id, ok: true, result });
    } catch (err) {
      self.postMessage({ __rpc: true, id: msg.id, ok: false, error: String(err && err.message || err) });
    }
  };
}
