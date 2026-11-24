// src/tests/test-audio-voices.js — 一次性音效的**多声道即时发声**（Tier 1，TDD）
//
// 用户 2026-11-25：「soldier 射击时的声音有时候滞后发出，是有队列吗？我不要队列，
// 不要 soldier 发射的时候射击的声音滞后。如果因为声音声道挤占导致某个 soldier 的射击
// 动作没有发出声音，就丢弃掉，不要延迟或者滞后再补发声音了。」
//
// ## 缺陷（本轮探针在真实 AudioContext 上实测）
//
// 旧 `play()` 是**每个 id 一个 THREE.Audio 单槽**，同名再播先 `stop()` 再 `play()`：
//   3 只士兵 6s 内 **47 次开火请求 → 46 次是「打断上一声再从头重播」**。
// 素材 `carbine_bullet.mp3` 长 **0.519s**，而班组发间隔 0.105s ⇒ 每一声只响 0.1s 就被
// 下一声顶掉，玩家听到的是「枪声一直卡在起始那一小段、真正的响声迟到」。
//
// ## 判据为什么必须落在「真实 AudioBufferSourceNode 的账」上
//
// `playRequests`（请求计数）对这两种实现**读数完全相同**（47 vs 47）⇒ 零判别力。
// 有判别力的是：
//   ① 一次 play 是否**打断**了仍在播的同一素材（`stopWhilePlaying` 必须为 0）；
//   ② 同一素材是否真的**并发**出声（不同 source 同时在播）；
//   ③ 声道满时是否**丢弃**（不起播、不排队、不 stop 别人）。
//
// ⚠️ 采样率必须落在 Web Audio 允许区间 [3000, 768000]（照 test-bgm.js 的既有教训）。
// ⚠️ 每个用例 finally 里 teardown，**不关共享 AudioContext**（three 的 listener 拿全局单例）。
import { test } from './runner.js';
import { assertEqual, assertTrue, assertFalse } from './assert.js';
import * as THREE from 'three';
import { AudioManager } from '../render/audio-manager.js';
import { SOUND_VOICE_LIMITS, DEFAULT_SOUND_VOICES, SOLDIER_FIRE_SOUND } from '../render/audio-config.js';

/** 造管理器：真 listener + 假解码（buffer 时长可控，用来构造「上一声还没播完」） */
function makeManager(seconds = 0.5) {
  const camera = new THREE.PerspectiveCamera();
  const ctxRef = { ctx: null };
  const mgr = new AudioManager(camera, {
    bgmEnabled: false,
    loadBuffer: async () => {
      const rate = 8000;
      return ctxRef.ctx.createBuffer(1, Math.max(1, Math.round(seconds * rate)), rate);
    },
  });
  ctxRef.ctx = mgr.listener.context;
  return mgr;
}

function teardown(mgr) {
  mgr.stopAllVoices?.();
  for (const id of [...mgr._loops.keys()]) mgr.stopLoop(id);
  mgr.setMusicEnabled(false);
  mgr._music = null;
  if (mgr._bossMusic?.isPlaying) mgr._bossMusic.stop();
  mgr._bossMusic = null;
  mgr.camera.remove(mgr.listener);
  mgr._buffers.clear();
  mgr._counts.clear();
}

async function withManager(seconds, body) {
  const mgr = makeManager(seconds);
  try {
    await mgr.preload([SOLDIER_FIRE_SOUND, 'gun_fire', 'z_die']);
    await mgr.unlock();
    await body(mgr);
  } finally {
    teardown(mgr);
  }
}

/**
 * 在**真实 Web Audio 层**记账（不读被测代码自己的计数）：
 * 包一层 `context.createBufferSource`，记录每个 source 的 start/stop 时刻。
 * 这是本轮唯一有判别力的观测点 —— 见文件头。
 */
function instrumentSources(mgr) {
  const ctx = mgr.listener.context;
  const orig = ctx.createBufferSource.bind(ctx);
  const log = [];
  ctx.createBufferSource = () => {
    const src = orig();
    const rec = { src, startedAt: null, stoppedAt: null };
    log.push(rec);
    const os = src.start.bind(src);
    const ost = src.stop.bind(src);
    src.start = (...a) => { rec.startedAt = ctx.currentTime; return os(...a); };
    src.stop = (...a) => { if (rec.stoppedAt === null) rec.stoppedAt = ctx.currentTime; return ost(...a); };
    return src;
  };
  return {
    log,
    restore: () => { ctx.createBufferSource = orig; },
    /** 已起播且未被 stop 的 source 数（= 此刻真的在出声的路数） */
    live: () => log.filter((r) => r.startedAt !== null && r.stoppedAt === null).length,
    started: () => log.filter((r) => r.startedAt !== null).length,
    /** 起播后又被显式 stop 的（= 被打断）*/
    interrupted: () => log.filter((r) => r.startedAt !== null && r.stoppedAt !== null).length,
  };
}

test('一次性音效: 声道上限表存在且士兵开火声 > 1（单槽是缺陷本体）', () => {
  assertTrue(typeof SOUND_VOICE_LIMITS === 'object' && SOUND_VOICE_LIMITS !== null,
    '必须有声道上限表（唯一权威在 audio-config）');
  assertTrue(SOUND_VOICE_LIMITS[SOLDIER_FIRE_SOUND] > 1,
    `士兵开火声必须多声道（实测 ${SOUND_VOICE_LIMITS[SOLDIER_FIRE_SOUND]}）`);
  assertTrue(DEFAULT_SOUND_VOICES >= 1, '缺省声道数必须 ≥1（0 = 全部音效静默）');
});

test('一次性音效: 同名连播不打断上一声（缺陷形态：47 次请求 46 次打断）', async () => {
  await withManager(0.5, async (mgr) => {
    const probe = instrumentSources(mgr);
    try {
      // 班组节点：0.105s 一发，素材 0.5s ⇒ 旧实现每发都打断上一声
      for (let i = 0; i < 6; i++) mgr.play(SOLDIER_FIRE_SOUND, 0.5);
      assertEqual(mgr.playRequests.get(SOLDIER_FIRE_SOUND), 6, '前置：6 次请求都记了');
      assertEqual(probe.interrupted(), 0,
        `同名连播不得打断在播的上一声（实测打断 ${probe.interrupted()} 次）`);
      assertTrue(probe.started() >= 2,
        `必须真的并发出声（实测只起播 ${probe.started()} 路）`);
    } finally {
      probe.restore();
    }
  });
});

test('一次性音效: 声道占满时丢弃新请求 —— 不起播、不排队、不打断别人', async () => {
  await withManager(0.5, async (mgr) => {
    const cap = SOUND_VOICE_LIMITS[SOLDIER_FIRE_SOUND];
    const probe = instrumentSources(mgr);
    try {
      for (let i = 0; i < cap; i++) {
        assertTrue(mgr.play(SOLDIER_FIRE_SOUND, 0.5), `第 ${i + 1} 发（声道未满）必须出声`);
      }
      const startedAtCap = probe.started();
      const liveAtCap = probe.live();
      // 满了之后再请求 5 次：**全部丢弃**
      for (let i = 0; i < 5; i++) {
        assertFalse(mgr.play(SOLDIER_FIRE_SOUND, 0.5), '声道满 ⇒ play 必须返回 false（丢弃）');
      }
      assertEqual(probe.started(), startedAtCap, '丢弃不得新建 source（那就是排队/补发的载体）');
      assertEqual(probe.live(), liveAtCap, '丢弃不得打断在播的声道');
      assertEqual(probe.interrupted(), 0, '任何一次都不得 stop 在播的声道');
      // 请求计数仍照记（那是「事件发生了几次」的口径，与出声无关）
      assertEqual(mgr.playRequests.get(SOLDIER_FIRE_SOUND), cap + 5,
        '请求计数记的是事件数，丢弃也要记（既有判据口径不变）');
    } finally {
      probe.restore();
    }
  });
});

test('一次性音效: 声道自然播完后归还，下一次请求能再出声（不是永久占死）', async () => {
  // buffer 取 0.05s：等音频时钟走过它即自然结束（不靠 setTimeout，见 test-bgm 的教训）
  await withManager(0.05, async (mgr) => {
    const cap = SOUND_VOICE_LIMITS[SOLDIER_FIRE_SOUND];
    for (let i = 0; i < cap; i++) mgr.play(SOLDIER_FIRE_SOUND, 0.5);
    assertFalse(mgr.play(SOLDIER_FIRE_SOUND, 0.5), '前置：此刻声道已满');
    const ctx = mgr.listener.context;
    const t0 = ctx.currentTime;
    const w0 = performance.now();
    while (ctx.currentTime - t0 < 0.2) {
      if (performance.now() - w0 > 5000) throw new Error('音频时钟未推进（context 被挂起？）');
      await new Promise((r) => setTimeout(r, 8));
    }
    assertTrue(mgr.play(SOLDIER_FIRE_SOUND, 0.5), '播完后声道必须归还（否则一轮点射后永久静默）');
  });
});

test('一次性音效: 不同 id 互不挤占（士兵开火不得顶掉玩家枪声）', async () => {
  await withManager(0.5, async (mgr) => {
    const probe = instrumentSources(mgr);
    try {
      assertTrue(mgr.play('gun_fire', 0.09), '前置：玩家枪声起播');
      for (let i = 0; i < SOUND_VOICE_LIMITS[SOLDIER_FIRE_SOUND] + 3; i++) {
        mgr.play(SOLDIER_FIRE_SOUND, 0.5);
      }
      assertEqual(probe.interrupted(), 0, '士兵开火不得打断玩家枪声（跨 id 也不许）');
    } finally {
      probe.restore();
    }
  });
});

test('一次性音效: 缺省单声道的 id 行为逐位不变（同名再播仍重启，既有判据零回归）', async () => {
  await withManager(0.5, async (mgr) => {
    assertEqual(SOUND_VOICE_LIMITS.z_die ?? DEFAULT_SOUND_VOICES, DEFAULT_SOUND_VOICES,
      '前置：z_die 走缺省单声道（本轮不改它的听感）');
    assertTrue(mgr.play('z_die', 0.3), '首次出声');
    assertTrue(mgr.play('z_die', 0.3), '单声道 id 同名再播仍重启（返回 true，与旧实现一致）');
  });
});

test('一次性音效: dispose / stopAllVoices 收掉全部在播声道（不留残响）', async () => {
  await withManager(0.5, async (mgr) => {
    const probe = instrumentSources(mgr);
    try {
      for (let i = 0; i < SOUND_VOICE_LIMITS[SOLDIER_FIRE_SOUND]; i++) mgr.play(SOLDIER_FIRE_SOUND, 0.5);
      assertTrue(probe.live() > 0, '前置：有声道在播');
      mgr.stopAllVoices();
      assertEqual(probe.live(), 0, 'stopAllVoices 必须停掉全部在播声道');
    } finally {
      probe.restore();
    }
  });
});