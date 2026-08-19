// src/core/perf.js — 帧时采样 + 子系统打点（设计文档 §4.9）

/** 固定容量环形缓冲，避免 GC 压力 */
class RingBuffer {
  constructor(capacity) {
    this.data = new Float32Array(capacity);
    this.capacity = capacity;
    this.head = 0;
    this.count = 0;
  }
  push(v) {
    this.data[this.head] = v;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }
  /** 返回升序拷贝的前 count 个样本 */
  sorted() {
    const arr = Array.from(this.data.subarray(0, this.count));
    arr.sort((a, b) => a - b);
    return arr;
  }
}

function percentile(sortedArr, p) {
  if (sortedArr.length === 0) return 0;
  const idx = Math.min(sortedArr.length - 1, Math.floor((p / 100) * sortedArr.length));
  return sortedArr[idx];
}

export class PerfMonitor {
  /** @param {number} windowSize 采样窗口（帧数） */
  constructor(windowSize = 600) {
    this.windowSize = windowSize;
    this._frameSamples = new RingBuffer(windowSize);
    this._lastTick = -1;
    this._marks = new Map(); // name -> RingBuffer
  }

  /** 每帧调用一次，nowMs = performance.now() */
  tick(nowMs) {
    if (this._lastTick >= 0) {
      this._frameSamples.push(nowMs - this._lastTick);
    }
    this._lastTick = nowMs;
  }

  /** 子系统耗时打点（GEN/MESH/上传等） */
  mark(name, durationMs) {
    let buf = this._marks.get(name);
    if (!buf) {
      buf = new RingBuffer(this.windowSize);
      this._marks.set(name, buf);
    }
    buf.push(durationMs);
  }

  snapshot() {
    const frames = this._frameSamples.sorted();
    const avg = frames.length
      ? frames.reduce((a, b) => a + b, 0) / frames.length : 0;
    const marks = {};
    for (const [name, buf] of this._marks) {
      const arr = buf.sorted();
      if (arr.length === 0) continue;
      marks[name] = {
        count: arr.length,
        avgMs: arr.reduce((a, b) => a + b, 0) / arr.length,
        p95Ms: percentile(arr, 95),
      };
    }
    return {
      fps: avg > 0 ? 1000 / avg : 0,
      frameMs: {
        p50: percentile(frames, 50),
        p95: percentile(frames, 95),
        p99: percentile(frames, 99),
      },
      marks,
    };
  }
}
