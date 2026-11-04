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
import { AudioManager, BGM_TRACKS, pickBgmTrack } from '../render/audio-manager.js';

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
  for (const id of [...mgr._loops.keys()]) mgr.stopLoop(id);
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
  // ⚠️ v2.51 起曲目是随机的 ⇒ 这几条需要**确定性曲目**：`bgmTrack` 钉死，
  // 否则 `preload(['bgm'])` 解的是 bgm，而 `_syncMusic` 等的是抽中的那首（如 bgm2）→ 假失败。
  await withManager({ bgmEnabled: true, bgmTrack: 'bgm' }, async (mgr) => {
    await blockAutoplay(mgr);
    await mgr.preload(['bgm']);
    const st = mgr.debugMusicState();
    assertTrue(st.enabled, '默认想听（bgmEnabled 默认开）');
    assertTrue(st.decoded, 'preload 后 buffer 已就绪');
    assertFalse(st.playing, '手势未到 → 不得谎报在播');
  });
});

test('bgm: 手势解锁后自动起播（无需再调 setMusicEnabled）', async () => {
  await withManager({ bgmEnabled: true, bgmTrack: 'bgm' }, async (mgr) => {
    await blockAutoplay(mgr);
    await mgr.preload(['bgm']);
    assertTrue(await mgr.unlock(), 'unlock() 应把 context 恢复成 running');
    assertTrue(mgr.musicPlaying, '解码 + 手势齐备 → 必须真的起播');
    // 循环标志是 mc-lite `playBGM` 的语义（单曲循环）——这是它与效果音的唯一行为差异。
    assertTrue(mgr._music.loop, 'BGM 必须循环（否则 254 秒后静音）');
  });
});

test('bgm: 关闭立即停播，重开恢复', async () => {
  await withManager({ bgmEnabled: true, bgmTrack: 'bgm' }, async (mgr) => {
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
  await withManager({ bgmEnabled: false, bgmTrack: 'bgm' }, async (mgr) => {
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
  await withManager({ bgmEnabled: true, bgmTrack: 'bgm' }, async (mgr) => {
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

// ==================== v2.51：BGM 三选一 + 循环效果音 ====================

/**
 * `pickBgmTrack` 是纯函数 —— 三段区间、两个端点与越界钳制都直接钉死。
 *
 * ⚠️ **必须测 1.0 与越界值**：`Math.floor(1.0 * 3) === 3` 会取到 `undefined`，而 `undefined`
 * 在 `BGM_TRACKS.includes()` 处会被静默当成「没指定」→ 回落成随机。缺陷形态是
 * 「注入 rng 恒返回 1 时，测试断言 track ∈ 列表仍然通过」，但真实入口拿到的是随机曲目。
 */
test('bgm: pickBgmTrack 按三段均分选曲，且钳住越界输入', () => {
  assertEqual(pickBgmTrack(() => 0), 'bgm', 'r=0 → 第一首');
  assertEqual(pickBgmTrack(() => 0.3332), 'bgm', 'r 略小于 1/3 → 仍第一首');
  assertEqual(pickBgmTrack(() => 1 / 3), 'bgm2', 'r=1/3 是第二首的下界');
  assertEqual(pickBgmTrack(() => 0.6666), 'bgm2', 'r 略小于 2/3 → 第二首');
  assertEqual(pickBgmTrack(() => 2 / 3), 'bgm3', 'r=2/3 是第三首的下界');
  assertEqual(pickBgmTrack(() => 0.9999), 'bgm3', 'r 接近 1 → 第三首');
  assertEqual(pickBgmTrack(() => 1), 'bgm3', 'r=1 越界必须钳到最后一首（不是 undefined）');
  assertEqual(pickBgmTrack(() => 5), 'bgm3', 'r>1 同样钳住');
  assertEqual(pickBgmTrack(() => -1), 'bgm', 'r<0 钳到第一首');
  assertEqual(BGM_TRACKS.length, 3, '曲目池 = bgm / bgm2 / bgm3 三首');
});

test('bgm: 本次会话的曲目在构造期抽定，关开不换歌', async () => {
  let picks = 0;
  await withManager({ bgmEnabled: true, rng: () => { picks += 1; return 0.5; } }, async (mgr) => {
    assertEqual(mgr.bgmTrack, 'bgm2', 'r=0.5 → 第二首');
    assertEqual(picks, 1, '构造期只抽一次');
    await mgr.preload();
    await mgr.unlock();
    assertTrue(mgr.musicPlaying, '前置：已在播');
    assertEqual(mgr.debugMusicState().track, 'bgm2', 'debugMusicState 必须报出真实曲目');
    // 关了再开：曲目不得变化（用户要的是「这次刷新听哪首」，不是每首歌轮播）
    mgr.setMusicEnabled(false);
    assertTrue(mgr.setMusicEnabled(true), '重开恢复');
    assertEqual(mgr.bgmTrack, 'bgm2', '开关不得重新抽签');
    assertEqual(picks, 1, '整个会话只抽一次');
  });
});

/** 显式指定曲目时优先（E2E 需要确定性）。 */
test('bgm: 显式 bgmTrack 优先于 rng', async () => {
  await withManager({ bgmEnabled: false, rng: () => 0, bgmTrack: 'bgm3' }, async (mgr) => {
    assertEqual(mgr.bgmTrack, 'bgm3', '显式指定胜出');
  });
  await withManager({ bgmEnabled: false, rng: () => 0, bgmTrack: 'nope' }, async (mgr) => {
    assertEqual(mgr.bgmTrack, 'bgm', '非法曲目名 → 回落到抽签，不得塞进这个不存在的 id');
  });
});

/** 只预载抽中的那一首（三首共 16MB，全量预载会把首屏流量翻 4 倍）。 */
test('bgm: preload 只解码抽中的那一首，不是三首全下', async () => {
  const requested = [];
  const camera = new THREE.PerspectiveCamera();
  const ctxRef = { ctx: null };
  const mgr = new AudioManager(camera, {
    bgmTrack: 'bgm2',
    loadBuffer: async (id) => { requested.push(id); return ctxRef.ctx.createBuffer(1, 8000, 8000); },
  });
  ctxRef.ctx = mgr.listener.context;
  try {
    await mgr.preload();
    assertTrue(requested.includes('bgm2'), '抽中的曲目必须预载');
    assertFalse(requested.includes('bgm'), '未抽中的 bgm 不得预载');
    assertFalse(requested.includes('bgm3'), '未抽中的 bgm3 不得预载');
    assertTrue(mgr.debugMusicState().decoded, '抽中的曲目解码完成');
  } finally {
    teardown(mgr);
  }
});

/**
 * 循环效果音：条件未齐时只记意图，条件齐了由 preload / unlock 补齐。
 *
 * 与 BGM 同一类盲区 —— 「进游戏第一时间就下雨」是最常见的启动顺序，
 * 若只在 `playLoop()` 里尝试起播，那一刻 buffer 还没解码完就永远没声音。
 */
test('bgm: 循环音效条件未齐时记意图，preload 后补起播', async () => {
  await withManager({ bgmEnabled: false }, async (mgr) => {
    await blockAutoplay(mgr);
    assertFalse(mgr.playLoop('rain', 0.2), 'buffer 还没有 → 不得谎报在播');
    assertTrue(mgr.debugLoops().rain.target > 0, '意图已记录');
    await mgr.unlock();
    await mgr.preload();
    const loops = mgr.debugLoops();
    assertTrue(loops.rain.playing, '解码 + 手势齐备 → 必须真的起播');
    assertEqual(loops.rain.target, 0.2, '意图音量透传');
  });
});

/**
 * 已在播时再次 `playLoop` 只改音量、不重建 —— 脚步声每帧都会调它。
 *
 * 两条判据缺一不可：
 *   ① 实例引用不变（重建会听到断续的「哒哒哒」）；
 *   ② **实际音频音量真的变了** —— 这个缺陷的形态是“意图值改了但没写下去”，
 *      只断言 `debugLoops().volume`（若它报意图值）就永远全绿。故 `debugLoops()` 现在
 *      报的是 `THREE.Audio.getVolume()` 的真实值，本条外加一条直接读实例的断言。
 */
test('bgm: playLoop 重复调用不重建实例，但真的改了音频音量', async () => {
  await withManager({ bgmEnabled: false }, async (mgr) => {
    await mgr.preload(['running_land', 'rain']);
    await mgr.unlock();
    assertTrue(mgr.playLoop('running_land', 0.2), '前置：已起播');
    const inst = mgr._loops.get('running_land').audio;
    assertTrue(mgr.playLoop('running_land', 0.15), '再次调用仍返回在播');
    assertTrue(mgr._loops.get('running_land').audio === inst, '实例必须复用（不得重建）');
    assertEqual(mgr.debugLoops().running_land.target, 0.15, '意图音量已更新');
    // ⚠️ **不能同步读 `getVolume()`**：three 的 `setVolume()` 走 `setTargetAtTime`（0.01s 时间常数），
    // 刚调完那一瞬读到的还是斜坡起点（实测：刚 `play()` 的 gain 默认 1，同步读回 **1**）。
    // 等斜坡收敛后再判（200ms 已远超 5 个时间常数）。
    await new Promise((r) => setTimeout(r, 200));
    const actual = inst.getVolume();
    assertTrue(Math.abs(actual - 0.15) < 0.02,
      `**真实 THREE.Audio 音量必须跟着改**（缺陷 ①：只改意图）—— 实测 ${actual}`);

    // 雨声场景：强度逐帧变化 → 音量逐帧跟随（淡入淡出的唯一实现）
    // ⚠️ `playLoop` 内部同步调 `setVolume`，而 `getVolume()` 读的是 AudioParam 当前值 ——
    // 连续不等待的多次 `setVolume` 会让斜坡从同一旧值重新出发，所以断言落在 `target` 上；
    // 真实值那一层由上一条（单次改档 0.2 → 0.15）覆盖。
    mgr.playLoop('rain', 0.2);
    mgr.playLoop('rain', 0.1);
    mgr.playLoop('rain', 0.05);
    assertEqual(mgr._loops.get('rain').wanted.volume, 0.05, '音量意图逐次下降');
    // 越界输入被钳制（不能把 >1 / <0 传给 Web Audio）
    mgr.playLoop('rain', 5);
    assertEqual(mgr.debugLoops().rain.target, 1, '音量上限钳到 1');
    mgr.playLoop('rain', -1);
    assertEqual(mgr.debugLoops().rain.target, 0, '音量下限钳到 0');
  });
});

test('bgm: stopLoop 幂等，且不计入效果音播放请求', async () => {
  await withManager({ bgmEnabled: false }, async (mgr) => {
    await mgr.preload(['rain']);
    await mgr.unlock();
    mgr.playLoop('rain', 0.2);
    assertTrue(mgr.debugLoops().rain.playing);
    mgr.stopLoop('rain');
    mgr.stopLoop('rain');   // 幂等
    assertFalse(mgr.debugLoops().rain?.playing ?? false, '停后不再在播');
    assertFalse(mgr.playRequests.has('rain'), '循环音效不写 playRequests（那是「事件发生几次」的口径）');
  });
});
