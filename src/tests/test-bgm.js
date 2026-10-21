// src/tests/test-bgm.js — v1.63 背景音乐（Tier 1：起播状态机）
//
// **为什么状态机要单独测**：BGM 起播取决于三个异步条件对齐 ——
//   ① 玩家意图（设置面板开关）；
//   ② buffer 已解码（`preload()` 4MB，几秒）；
//   ③ AudioContext 处于 running（生产里必须在用户手势内 `resume`）。
// 任一条件漏接线的后果是**静默失效**：设置面板显示「开启」、按钮高亮、没有任何报错，
// 只是永远没有声音 —— 与 M6「worker 没接线」同一类盲区，且比它更难发现（声音本来就不在
// 断言里）。故断言必须落在「条件齐了是否真的起播 / 关了是否真的停」上，而不是只断言
// `musicEnabled` 这个布尔字段（那个字段即使全不接线也照样能读写）。
//
// ⚠️ **不能假设「无头环境里 AudioContext 初始是 suspended」**：实测（Playwright 默认带
// `--autoplay-policy=no-user-gesture-required`）新建的 AudioContext 一上来就是 `running`。
// 于是「手势未到」这个状态**必须显式造出来**（`ctx.suspend()`），否则用例描述的是一个
// 根本不存在的前提，而断言会以错误的原因失败。
//
// ⚠️ **每个用例都要 teardown（用 finally）**：既不关共享 context（会砸烂后续用例），
// 也不留一条在播的音乐（会让下个用例的前置断言失真）。
import { test } from './runner.js';
import { assertEqual, assertTrue, assertFalse } from './assert.js';
import * as THREE from 'three';
import { AudioManager } from '../render/audio-manager.js';

/**
 * 造一个只在测试里用的管理器：真 listener、假解码（返回 1 秒静音 buffer）。
 * ⚠️ 采样率必须落在 Web Audio 允许区间 [3000, 768000]：写 1000 会让 `createBuffer` 抛
 * `NotSupportedError`，被 `preload` 的 catch 吞成「解码失败」→ `decoded` 恒 false →
 * 下游每条断言都在描述一个没走到的分支（实测踩过这个坑，4 条用例同时假失败）。
 */
function makeManager(opts = {}) {
  const camera = new THREE.PerspectiveCamera();
  const ctxRef = { ctx: null };
  const mgr = new AudioManager(camera, {
    ...opts,
    loadBuffer: async () => ctxRef.ctx.createBuffer(1, 8000, 8000),
  });
  ctxRef.ctx = mgr.listener.context;
  return mgr;
}

/** 造「浏览器的自动播放拦截」：context 挂起 = 用户手势还没到。 */
async function blockAutoplay(mgr) {
  await mgr.listener.context.suspend();
  assertEqual(mgr.listener.context.state, 'suspended', '前置：context 已挂起');
}

/**
 * 收尾：停掉音乐与在播音效、拆掉 listener，**但不关 context**。
 *
 * ⚠️ **不能用 `mgr.dispose()`**：three 的 `AudioListener` 拿的是 `AudioContext.getContext()`
 * 那个**全局单例**（`three.core.js:50786` / `:49994` 的 `_context` 缓存），而 `dispose()` 会
 * `context.close()` —— 第一个用例收尾就把全页的 context 关死，后续用例全报
 * `Cannot suspend a closed AudioContext`（实测 3 条假失败）。生产里不受影响：`Game.dispose()`
 * 之后页面本就重新加载（单例随之重建）。
 */
function teardown(mgr) {
  for (const v of mgr._voices.values()) if (v.isPlaying) v.stop();
  mgr._voices.clear();
  mgr.setMusicEnabled(false);
  mgr._music = null;
  mgr.camera.remove(mgr.listener);
  mgr._buffers.clear();
  mgr._counts.clear();
}

/** 断言「条件未齐时不播、齐了才播」的公共骨架：始终释放监听器与音乐实例。 */
async function withManager(opts, body) {
  const mgr = makeManager(opts);
  try {
    await body(mgr);
  } finally {
    teardown(mgr);
  }
}

test('bgm: 意图开 + 已解码，但手势未到 → 不起播', async () => {
  await withManager({ bgmEnabled: true }, async (mgr) => {
    await blockAutoplay(mgr);
    await mgr.preload(['bgm']);
    const st = mgr.debugMusicState();
    assertTrue(st.enabled, '默认想听（bgmEnabled 默认开）');
    assertTrue(st.decoded, 'preload 后 buffer 已就绪');
    assertFalse(st.playing, '手势未到 → 不得谎报在播');
  });
});

test('bgm: 手势解锁后自动起播（无需再调 setMusicEnabled）', async () => {
  await withManager({ bgmEnabled: true }, async (mgr) => {
    await blockAutoplay(mgr);
    await mgr.preload(['bgm']);
    assertTrue(await mgr.unlock(), 'unlock() 应把 context 恢复成 running');
    assertTrue(mgr.musicPlaying, '解码 + 手势齐备 → 必须真的起播');
    // 循环标志是 mc-lite `playBGM` 的语义（单曲循环）——这是它与效果音的唯一行为差异。
    assertTrue(mgr._music.loop, 'BGM 必须循环（否则 254 秒后静音）');
  });
});

test('bgm: 关闭立即停播，重开恢复', async () => {
  await withManager({ bgmEnabled: true }, async (mgr) => {
    await mgr.preload(['bgm']);
    await mgr.unlock();
    assertTrue(mgr.musicPlaying, '前置：已在播');

    assertFalse(mgr.setMusicEnabled(false), '关闭后返回值 = 未在播');
    assertFalse(mgr.musicPlaying, '关闭必须真的停（不是只改意图位）');
    assertFalse(mgr.musicEnabled, '意图位同步为 false');

    assertTrue(mgr.setMusicEnabled(true), '重开 → 立即起播（buffer 与手势都还在）');
  });
});

test('bgm: 初始关闭 → 手势与解码都到位也不起播', async () => {
  await withManager({ bgmEnabled: false }, async (mgr) => {
    await mgr.preload(['bgm']);
    await mgr.unlock();
    assertFalse(mgr.musicPlaying, '玩家关掉了音乐，条件齐了也不得偷播');
    assertFalse(mgr.musicEnabled);
  });
});

/**
 * ⚠️ 这个用例钉的是**静默失效的那一半**：真实玩家路径就是「先进游戏点一下（手势到位）、
 * 几秒后 4MB 音乐才下载解码完」。若只在 `unlock()` 里尝试起播，`preload` 完成的那一刻
 * 没人再发起播请求 → 永远没声音（E2E 里同一条路径用 route 延迟实测）。
 */
test('bgm: 先解锁后解码（真实玩家顺序）也能起播', async () => {
  await withManager({ bgmEnabled: true }, async (mgr) => {
    await blockAutoplay(mgr);
    assertTrue(await mgr.unlock(), '前置：手势先到');
    assertFalse(mgr.musicPlaying, 'buffer 还没有 → 不该有声音');
    await mgr.preload(['bgm']);
    assertTrue(mgr.musicPlaying, '解码完成必须补上一次起播尝试');
  });
});

/** 效果音不受 BGM 开关影响（两份清单分开的意义就在这里）。 */
test('bgm: 开关不影响效果音播放请求计数', async () => {
  await withManager({ bgmEnabled: false }, async (mgr) => {
    await mgr.preload();
    mgr.play('gun_fire', 1);
    assertEqual(mgr.playRequests.get('gun_fire'), 1, '效果音请求照常计数');
    assertFalse(mgr.musicPlaying, '关着音乐时效果音不会把 BGM 带起来');
  });
});
