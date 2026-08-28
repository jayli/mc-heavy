import { test } from './runner.js';
import { assertEqual, assertThrows, assertTrue } from './assert.js';
import { createRegistry } from '../voxel/block-registry.js';
import { BLOCKS } from '../voxel/blocks-data.js';

test('BlockRegistry: air 恒为 ID 0', () => {
  const reg = createRegistry();
  for (const def of BLOCKS) reg.register(def.name, def);
  assertEqual(reg.idOf('air'), 0);
});

test('BlockRegistry: 126 方块全部注册且 ID 唯一', () => {
  const reg = createRegistry();
  for (const def of BLOCKS) reg.register(def.name, def);
  assertEqual(reg.count, 126);
  const ids = new Set();
  for (const def of BLOCKS) ids.add(reg.idOf(def.name));
  assertEqual(ids.size, 126);
});

test('BlockRegistry: sky_stone/sky_grass 注册且 solid+opaque（M2-7 空岛）', () => {
  const reg = createRegistry();
  for (const def of BLOCKS) reg.register(def.name, def);
  reg.freeze();
  for (const name of ['sky_stone', 'sky_grass']) {
    const id = reg.idOf(name);
    assertTrue(id > 0, `${name} registered`);
    assertEqual(reg.solidTable[id], 1, `${name} solid`);
    assertEqual(reg.opaqueTable[id], 1, `${name} opaque`);
  }
});

test('BlockRegistry: supportsPlayer 表仅 cloud=1（M2-7 云可站立）', () => {
  const reg = createRegistry();
  for (const def of BLOCKS) reg.register(def.name, def);
  reg.freeze();
  assertEqual(reg.supportsPlayerTable[reg.idOf('cloud')], 1, 'cloud supports player');
  assertTrue(reg.supportsPlayer(reg.idOf('cloud')), 'supportsPlayer() helper');
  for (const name of ['air', 'stone', 'water', 'glass_block', 'sky_stone']) {
    assertEqual(reg.supportsPlayerTable[reg.idOf(name)], 0, `${name} not supports`);
  }
});

test('BlockRegistry: typed 表与声明一致', () => {
  const reg = createRegistry();
  for (const def of BLOCKS) reg.register(def.name, def);
  reg.freeze();
  const stone = reg.idOf('stone');
  assertEqual(reg.solidTable[stone], 1);
  assertEqual(reg.opaqueTable[stone], 1);
  const glass = reg.idOf('glass_block');
  assertEqual(reg.opaqueTable[glass], 0);       // 透明不遮光
  assertEqual(reg.cullTable[glass], 2);          // transparent 通道
  const leaves = reg.idOf('leaves');
  assertEqual(reg.cullTable[leaves], 1);         // cutout
  const lamp = reg.idOf('glowstone');
  assertEqual(reg.emissiveTable[lamp], 15);
  const air = reg.idOf('air');
  assertEqual(reg.solidTable[air], 0);
});

test('BlockRegistry: freeze 后 register 抛错', () => {
  const reg = createRegistry();
  for (const def of BLOCKS) reg.register(def.name, def);
  reg.freeze();
  assertThrows(() => reg.register('late_block', { solid: true }), 'frozen');
});

test('BlockRegistry: nameOf 反查', () => {
  const reg = createRegistry();
  for (const def of BLOCKS) reg.register(def.name, def);
  assertEqual(reg.nameOf(reg.idOf('dirt')), 'dirt');
});
