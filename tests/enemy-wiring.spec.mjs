import { test, expect } from 'playwright/test';
import { ENEMY_ROSTER } from './enemy-roster.mjs';

/**
 * 敌人/Boss **接线完整性门**（方案 2）。
 *
 * 设计稿：docs/superpowers/specs/2026-11-23-enemy-wiring-completeness-gate-design.md
 *
 * ## 为何需要它（现有 spec 盖不到新类型）
 *
 * 实测：`boss-audio.spec.mjs` 共 10 个 test，**9 个标题写死了具体 Boss 名**
 *（「焰魔：挥刀播…」「末影守卫：枪击中播…」）⇒ 加一个新 Boss，那 9 个用例
 * 一个都不会覆盖它。而每加一个类型要在既有文件里插 15 处，其中 **7 处漏改是静默失效**
 *（死亡无声无爆散 / 数字飘胸口 / 溅射偏半个身高 / Boss 曲不响 / 起手音不响 /
 * 炮塔不打它 / 玩家停在身体盒内）—— git 里有它们真实发生过的记录。
 *
 * 本门遍历名册逐项验真实 `window.__MC_GAME__` 的接线，**不改任何生产代码**。
 *
 * ⚠️ **召唤一律走真实入口**（Boss 按 KeyB、丧尸走 spawnZombieNearPlayer）：
 * 直接调 service.summon 会漏掉「名册没登记 / service 没装配 / 地图判定不对」
 * 这类接线缺陷（guardian.spec.mjs 文件头教训）。
 */

const SEED = 12345;

/** 等世界就绪（照 guardian.spec.mjs:28） */
async function waitWorldReady(page) {
  await page.waitForFunction(() => window.__MC_GAME__?.worldReady === true, null, { timeout: 90_000 });
}

/** 把玩家挪到远离城市的开阔地（照 boss-audio.spec.mjs:51） */
async function gotoOpenField(page, { offsetX = 600, offsetZ = 600 } = {}) {
  await page.evaluate(async ([ox, oz]) => {
    const g = window.__MC_GAME__;
    const p = g.player.physics.pos;
    g._teleportTo(Math.floor(p.x) + ox, 45, Math.floor(p.z) + oz);
    await new Promise((r) => setTimeout(r, 2500));   // 等 column 加载 + 落地
  }, [offsetX, offsetZ]);
}

/** 把玩家放到指定位置并清零速度（照 guardian.spec.mjs:97；y 给脚底） */
async function putPlayer(page, x, y, z) {
  await page.evaluate(([px, py, pz]) => {
    const g = window.__MC_GAME__;
    const p = g.player.physics.pos;
    p.x = px; p.y = py; p.z = pz;
    g.player.physics.vel.x = g.player.physics.vel.y = g.player.physics.vel.z = 0;
  }, [x, y, z]);
}

/** 派真实 KeyB（照 guardian.spec.mjs:77） */
async function pressB(page) {
  await page.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', {
      code: 'KeyB', repeat: false, bubbles: true, cancelable: true,
    }));
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyB', bubbles: true, cancelable: true }));
  });
}

test.describe.configure({ mode: 'serial' });

test('双向钉住：名册 ↔ entities 已注册的可击中类型集合相等', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/?vd=2&seed=12345');
  await waitWorldReady(page);
  const gap = await page.evaluate(async () => {
    const { WEAPON_HITTABLE_TYPES } = await import('/src/entities/entity-types.js');
    const { ENEMY_ROSTER } = await import('/tests/enemy-roster.mjs');
    const registered = WEAPON_HITTABLE_TYPES;
    const inRoster = Object.keys(ENEMY_ROSTER);
    const g = window.__MC_GAME__;
    return {
      missingInRoster: registered.filter((t) => !inRoster.includes(t)),
      danglingInRoster: inRoster.filter((t) => !registered.includes(t)),
      unwired: inRoster.filter((t) => !g[ENEMY_ROSTER[t].service]),
    };
  });
  expect(gap.missingInRoster, '可击中类型漏登记进名册 ⇒ 门会静默跳过它').toEqual([]);
  expect(gap.danglingInRoster, '名册登记了不可击中的类型（死登记）').toEqual([]);
  expect(gap.unwired, 'service 未装配 ⇒ 逐项断言会静默跳过').toEqual([]);
});