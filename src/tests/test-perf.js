import { test } from './runner.js';
import { assertEqual, assertTrue } from './assert.js';
import { PerfMonitor } from '../core/perf.js';
import { PerfHUD } from '../core/perf-hud.js';
import { setDebugFlags } from '../core/debug-config.js';

test('PerfMonitor: 100 帧 16.67ms 间隔 → fps ≈ 60', () => {
  const m = new PerfMonitor();
  let t = 0;
  for (let i = 0; i < 100; i++) { t += 16.67; m.tick(t); }
  const s = m.snapshot();
  assertTrue(Math.abs(s.fps - 60) < 2, `fps=${s.fps}`);
});

test('PerfMonitor: 帧时分位数正确', () => {
  const m = new PerfMonitor();
  let t = 0;
  // 90 帧 10ms + 10 帧 30ms
  for (let i = 0; i < 90; i++) { t += 10; m.tick(t); }
  for (let i = 0; i < 10; i++) { t += 30; m.tick(t); }
  const s = m.snapshot();
  assertTrue(s.frameMs.p50 <= 11, `p50=${s.frameMs.p50}`);
  assertTrue(s.frameMs.p95 >= 25, `p95=${s.frameMs.p95}`);
});

test('PerfMonitor: mark 聚合 count/avg', () => {
  const m = new PerfMonitor();
  m.mark('mesh-upload', 2);
  m.mark('mesh-upload', 4);
  const s = m.snapshot();
  assertEqual(s.marks['mesh-upload'].count, 2);
  assertEqual(s.marks['mesh-upload'].avgMs, 3);
});

test('PerfMonitor: 窗口滚动，内存有界', () => {
  const m = new PerfMonitor();
  let t = 0;
  for (let i = 0; i < 5000; i++) { t += 16; m.tick(t); }
  // 内部采样窗口不应无限增长
  assertTrue(m._frameSamples.count <= m.windowSize, 'sample window bounded');
});

function makeFakeStats() {
  return {
    blocks: 100, candidateFaces: 600, faces: 100, culledFaces: 500,
    cullRatio: 500 / 600, vertices: 400,
    channels: { opaque: { slots: 1, vertices: 400, triangles: 200 } },
    sections: 1, sectionCount: 1, columns: 1, drawCalls: 3, triangles: 200,
  };
}

test('PerfHUD: statsLog 开 → 2s 节奏 console.log 世界数据', () => {
  setDebugFlags({ worldStats: true, statsLog: true });
  const container = document.createElement('div');
  const hud = new PerfHUD(new PerfMonitor(), container, () => makeFakeStats());
  const logs = [];
  const origLog = console.log;
  console.log = (...args) => logs.push(args);
  try {
    hud.update(250);  // 首次世界刷新（_lastWorldUpdate=-2000）→ log 1 次
    hud.update(500);  // 距上次世界刷新仅 250ms → 不 log
    hud.update(2300); // 距上次世界刷新 2050ms → log 第 2 次
  } finally {
    console.log = origLog;
  }
  assertEqual(logs.length, 2, 'log on 2s cadence');
  assertTrue(String(logs[0][0]).includes('blocks=100'), 'log line has exact numbers');
});

/**
 * 折叠/展开（用户要求：右上角 `[-]` 收起、`[+]` 展开，收起后只留 fps 那一行）。
 *
 * 钉的不变式：① 首行 fps 与按钮在折叠后仍在（它不能被一起收掉 —— 收起的意义是留视野，
 * 不是隐藏 fps）；② 折叠区的行确实让出去了（max-height 归 0，而不是仅视觉透明）；
 * ③ **启动态恒为收起**（用户 2026-11-21 裁定，推翻 v1.79 的「启动态恒展开」）且
 * 按钮文案/`aria-expanded` 与状态一致（读屏与自测都靠它）。
 * 不断言动画时长/缓动 —— 那是观感，肉眼可判。
 */
test('PerfHUD: 折叠只留首行、展开恢复全部行，启动态恒收起', () => {
  setDebugFlags({ worldStats: true, statsLog: false });
  const container = document.createElement('div');
  const hud = new PerfHUD(new PerfMonitor(), container, () => makeFakeStats());
  hud.update(250); // 首帧刷一次，body 才有多行内容

  assertEqual(hud._collapsed, true, '启动态必须收起（用户 2026-11-21 裁定；收起状态仍不持久化）');
  assertEqual(hud.btn.textContent, '[+]', '启动态按钮显示 [+]');
  assertEqual(hud.btn.getAttribute('aria-expanded'), 'false');
  assertTrue(hud.bodyEl.textContent.includes('frame p50'), '帧时分位行仍要在折叠区内（只是被收起来）');
  // 启动态必须**真的**让出高度：构造期不播动画（animate=false）⇒ 直接落 0px
  assertEqual(hud.bodyEl.style.maxHeight, '0px', '启动收起时折叠区必须真正让出高度（不是仅透明）');
  assertEqual(hud.helpEl.style.maxHeight, '0px', '启动收起时操作说明同步折叠');
  assertTrue(hud.fpsEl.textContent.startsWith('fps '), `启动态首行就显示 fps=${hud.fpsEl.textContent}`);

  // 展开 → 全部行回来
  hud.setCollapsed(false);
  assertEqual(hud.btn.textContent, '[-]', '展开态按钮显示 [-]');
  assertEqual(hud.btn.getAttribute('aria-expanded'), 'true');
  assertTrue(hud.bodyEl.style.maxHeight.endsWith('px'), '展开从实测像素起步（不能从 none 起过渡）');
  assertTrue(hud.helpEl.style.maxHeight.endsWith('px'), '操作说明展开同样从实测像素起步');

  hud.setCollapsed(true);
  assertEqual(hud._collapsed, true);
  assertEqual(hud.btn.textContent, '[+]', '收起态按钮显示 [+]');
  assertEqual(hud.btn.getAttribute('aria-expanded'), 'false');
  assertEqual(hud.bodyEl.style.maxHeight, '0px', '折叠区必须真正让出高度（不是仅透明）');
  // 操作说明也是折叠区的一部分（用户裁定「随面板一起折叠」）——
  // 只折 bodyEl 会让它收起后仍占一大块高度，与「只留 fps 行」的需求相反。
  assertEqual(hud.helpEl.style.maxHeight, '0px', '操作说明同步折叠');
  // 首行内容与折叠区分属两个节点 —— 收起后 fps 仍在
  assertTrue(hud.fpsEl.textContent.startsWith('fps '), `收起后首行仍显示 fps=${hud.fpsEl.textContent}`);
  assertTrue(!hud.headEl.textContent.includes('frame p50'), '首行不得混入折叠区内容');
  assertTrue(!hud.headEl.textContent.includes('操作：'), '首行不得混入操作说明');

  hud.setCollapsed(false);
  assertEqual(hud.btn.textContent, '[-]', '再次展开按钮回到 [-]');
  assertTrue(hud.bodyEl.style.maxHeight.endsWith('px'), '展开从实测像素起步（不能从 none 起过渡）');
  assertTrue(hud.helpEl.style.maxHeight.endsWith('px'), '操作说明展开同样从实测像素起步');
  // ⚠️ 两个节点都必须有 `transitionend` 收尾（实测漏过 helpEl 一次）：
  // 只给 bodyEl 写收尾时 helpEl 会永久停在像素值 → 将来文案变长就被裁掉，
  // 而且那个缺陷**在 jsdom 式单测里看不见**（没有真实过渡事件），只能靠真实浏览器。
  // 这里直接派发 transitionend 事件，把「两个节点都挂了收尾」变成一条可断言的契约。
  for (const el of [hud.bodyEl, hud.helpEl]) {
    el.dispatchEvent(new Event('transitionend', { bubbles: false }));
    void el; // propertyName 不是 max-height → 不该被误触发
  }
  assertTrue(hud.bodyEl.style.maxHeight.endsWith('px'), '非 max-height 的 transitionend 不得改状态');
  // 真实过渡结束时 DOM 事件带 propertyName；这里模拟一次
  for (const el of [hud.bodyEl, hud.helpEl]) {
    const ev = new Event('transitionend', { bubbles: false });
    ev.propertyName = 'max-height';
    el.dispatchEvent(ev);
  }
  assertEqual(hud.bodyEl.style.maxHeight, 'none', '展开收尾：bodyEl 置回 none');
  assertEqual(hud.helpEl.style.maxHeight, 'none', '展开收尾：helpEl 也必须置回 none（漏过就是缺陷）');

  setDebugFlags({ statsLog: true }); // 还原默认（开发调试期全开）
});

/**
 * 固定宽度 + 操作说明（用户 v1.80 两项要求；v1.81 新增飞行键位行）。
 *
 * 钉四件事：① 面板宽度是显式固定值（不靠内容自然宽度）—— 用户报告「宽度随内容长短一直变」；
 * ② `n=` 字段右对齐到 3 位 —— 这是行宽**结构上**不再随计数位数跳变的前提（否则
 * 计数从 9 涨到 10 就换一档）；③ 操作说明四行原文在面板内且不在 body 的 250ms 重写路径里
 * （静态文案不该被每帧重写）；④ 飞行键位存在。
 * 不在这里断言具体像素宽 —— 那是观感值，定宽常量的注释里有实测依据；真页面的溢出判定
 * 在 `tests/player-flight.spec.mjs` 的 E5（
 * `scrollWidth ≤ clientWidth`）。
 */
test('PerfHUD: 面板宽度固定 + 操作说明四行入面板', () => {
  setDebugFlags({ worldStats: true, statsLog: false });
  const container = document.createElement('div');
  const hud = new PerfHUD(new PerfMonitor(), container, () => makeFakeStats());
  hud.update(250);

  assertTrue(hud.el.style.width.endsWith('px'), `面板宽度必须显式固定，实际=${hud.el.style.width}`);
  assertEqual(hud.el.style.boxSizing, 'border-box', 'border-box：宽度含 padding，否则内容区被 padding 挤窄');

  // 操作说明：三行原文、在 el 内、不在 bodyEl 内
  assertTrue(hud.helpEl.textContent.includes('操作：a←s↓d→w↑ | Space：跳'));
  assertTrue(hud.helpEl.textContent.includes('Z：背包 | X：丧尸 | C：士兵 | R：换枪'));
  assertTrue(hud.helpEl.textContent.includes('Ctrl+鼠标左键：点燃TNT，矿车启动'));
  assertTrue(hud.helpEl.textContent.includes('F：飞行开关'), '飞行开关的键位须出现在操作说明里');
  assertTrue(hud.helpEl.textContent.includes('Space：升') && hud.helpEl.textContent.includes('Shift：降'),
    '飞行中的升降键位须出现在操作说明里');
  // v2.43：召唤 Boss 键（2026-11-07 用户裁定从 C 改为 B）。⚠️ **必须钉「在 Space：跳 之后」**（用户明确要求的位置），
  // 只钉 includes 拓不到「放错行/放错位置」。
  assertTrue(hud.helpEl.textContent.includes('B：召唤Boss'), 'B 键召唤 Boss 须出现在操作说明里');
  const helpText = hud.helpEl.textContent;
  assertTrue(helpText.indexOf('Space：跳') < helpText.indexOf('B：召唤Boss'),
    'B：召唤Boss 必须排在 Space：跳 之后（用户指定的位置）');
  assertTrue(helpText.indexOf('B：召唤Boss') < helpText.indexOf('\nF：飞行开关'),
    'B：召唤Boss 必须与 Space：跳 同一行（不得另起一行）');
  assertEqual(hud.helpEl.parentElement, hud.el, '操作说明在面板内');
  assertTrue(!hud.bodyEl.textContent.includes('操作：'), '操作说明不得搭进 250ms 重写的 bodyEl');

  // 操作说明上方的横线：长度必须与统计区上方那条**逐字相同**（用户 v1.80 明确要求）。
  // 两处各写一份字面量会漂移出长短不一 —— 故两处共用同一个 SEP 常量，这条断言钉住它。
  const helpLines = hud.helpEl.textContent.split('\n');
  const statLines = hud.bodyEl.textContent.split('\n');
  const helpSep = helpLines[0];
  const statSep = statLines.find((l) => l.startsWith('─'));
  assertTrue(/^─+$/.test(helpSep), `操作说明首行必须是横线，实际=${JSON.stringify(helpSep)}`);
  assertEqual(helpSep, statSep, '两条横线必须等长（逐字相同）');

  // n= 右对齐：1 位数与 3 位数的**行宽必须相同**（只差前导空格）——
  // 不右对齐时计数从 9 涨到 10 整行宽就跳一档，那是「宽度一直变」的直接来源之一。
  const mon = hud.monitor;
  mon.mark('alpha', 1);
  hud._lastUpdate = 0;
  hud.update(1000);
  const line1 = hud.bodyEl.textContent.split('\n').find((l) => l.startsWith('alpha n='));
  assertTrue(/^alpha n=  1 avg /.test(line1), `n 一位数须补到 3 位（两个前导空格）：${line1}`);
  const width1 = line1.length;
  for (let i = 0; i < 100; i++) mon.mark('alpha', 1); // 计数到 101 → 三位数
  hud._lastUpdate = 0;
  hud.update(2000);
  const line3 = hud.bodyEl.textContent.split('\n').find((l) => l.startsWith('alpha n='));
  assertTrue(/^alpha n=101 avg /.test(line3), `n 三位数：${line3}`);
  assertEqual(line3.length, width1, '1 位数与 3 位数的行宽必须相等（定宽右对齐）');

  setDebugFlags({ statsLog: true });
});

test('PerfHUD: statsLog 关 → 不输出控制台日志（HUD 仍渲染）', () => {
  setDebugFlags({ worldStats: true, statsLog: false });
  const container = document.createElement('div');
  const hud = new PerfHUD(new PerfMonitor(), container, () => makeFakeStats());
  const logs = [];
  const origLog = console.log;
  console.log = (...args) => logs.push(args);
  try {
    hud.update(250);
  } finally {
    console.log = origLog;
    setDebugFlags({ statsLog: true }); // 还原默认（开发调试期全开）
  }
  assertEqual(logs.length, 0, 'no console log when statsLog off');
  assertTrue(container.textContent.includes('剔除'), 'HUD world section still rendered');
});
