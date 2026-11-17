/**
 * 市场风险分级用例 —— node test/regime.test.js
 * 纯函数，不碰 data/，不依赖真实行情。
 *
 * 标定数据全部取自 2026-11 的真实盘面，改阈值必须让这四条仍然通过：
 *   11-12 跌停4 /涨停34 · 广度17% · 创业板-2.19% → B（当日判「非全面崩塌」）
 *   11-13 跌停42/涨停38 · 广度13% · 创业板-3.40% → A
 *   11-16 跌停69/涨停33 · 广度19% · 创业板-4.34% → A
 *   11-17 跌停74/涨停37 · 广度20% · 创业板-1.73% → A
 */
'use strict';
const assert = require('assert');

const REG = require('../core/regime');

let pass = 0;
const ok = (name, fn) => {
  try {
    fn();
    pass += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.error(`  ✗ ${name}\n    ${e.message}`);
    process.exitCode = 1;
  }
};

const d1112 = { up: 964, down: 4523, limitUp: 34, limitDown: 4, gemChangePct: -2.19 };  // 尾盘 14:41
const d1113 = { up: 690, down: 4610, limitUp: 38, limitDown: 42, gemChangePct: -3.4 };  // 尾盘 14:49（广度 13%）
const d1116 = { up: 1106, down: 4381, limitUp: 33, limitDown: 69, gemChangePct: -4.34 }; // 尾盘 14:54
const d1117 = { up: 1132, down: 4331, limitUp: 37, limitDown: 74, gemChangePct: -1.73 }; // 尾盘 14:45

console.log('市场分级 · 用真实盘面标定');

ok('11-12：跌停仅 4 家 → 闸门降级，最多 B', () => {
  const r = REG.judge(d1112);
  assert.strictEqual(r.level, 'B');
  assert.strictEqual(r.hits.gate, false);
  assert.ok(r.reasons.some((x) => /降级/.test(x)));
});

ok('11-13：跌停 42、广度 13%、创业板 -3.40% → A', () => {
  const r = REG.judge(d1113);
  assert.strictEqual(r.level, 'A');
  assert.strictEqual(r.hits.hitCount, 2); // r1 未命中（42 < 38×1.5=57），r2/r3 命中
  assert.strictEqual(r.hits.r1, false);
  assert.strictEqual(r.hits.r2, true);
  assert.strictEqual(r.hits.r3, true);
});

ok('11-16：三条全中 → A', () => {
  const r = REG.judge(d1116);
  assert.strictEqual(r.level, 'A');
  assert.strictEqual(r.hits.hitCount, 3);
});

ok('11-17：跌停 74 vs 涨停 37 + 广度 20% → A（创业板仅 -1.73% 也够）', () => {
  const r = REG.judge(d1117);
  assert.strictEqual(r.level, 'A');
  assert.strictEqual(r.hits.r3, false);
  assert.strictEqual(r.hits.hitCount, 2);
});

console.log('市场分级 · 边界与降级');

ok('普涨日 → 常规', () => {
  const r = REG.judge({ up: 4200, down: 900, limitUp: 60, limitDown: 2, gemChangePct: 1.2 });
  assert.strictEqual(r.level, 'none');
  assert.strictEqual(r.actions.openNew, true);
  assert.strictEqual(r.actions.maxSinglePct, null);
});

ok('只有广度差、跌停很少 → B，不到 A', () => {
  const r = REG.judge({ up: 800, down: 4200, limitUp: 20, limitDown: 8, gemChangePct: -0.5 });
  assert.strictEqual(r.level, 'B');
});

ok('创业板杀 -3% 但跌停个位数 → B（单一指数不足以称崩塌）', () => {
  const r = REG.judge({ up: 1500, down: 3000, limitUp: 25, limitDown: 6, gemChangePct: -3.1 });
  assert.strictEqual(r.level, 'B');
});

ok('quorum 调成 3 → 11-17 那种 2/3 只判 B', () => {
  const r = REG.judge(d1117, { quorum: 3 });
  assert.strictEqual(r.level, 'B');
});

ok('数据缺失（无涨跌家数、无创业板）不炸，退化为常规', () => {
  const r = REG.judge({ limitUp: 10, limitDown: 2 });
  assert.strictEqual(r.level, 'none');
  assert.strictEqual(r.breadth, null);
});

ok('广度恰好等于阈值算命中（≤ 而非 <）', () => {
  const r = REG.judge({ up: 250, down: 750, limitUp: 10, limitDown: 1, gemChangePct: 0 });
  assert.strictEqual(r.hits.r2, true); // 25% == 0.25
});

console.log('市场分级 · 动作绑定');

ok('A 级必须给动作：openNew=false 且单票上限降到 20%', () => {
  const a = REG.actionsFor('A');
  assert.strictEqual(a.openNew, false);
  assert.strictEqual(a.addAllowed, false);
  assert.strictEqual(a.maxSinglePct, 0.2);
});

ok('B 级放开开新仓但同样收紧到 20%', () => {
  const b = REG.actionsFor('B');
  assert.strictEqual(b.openNew, true);
  assert.strictEqual(b.maxSinglePct, 0.2);
});

ok('未知级别回落常规，不抛错', () => {
  assert.strictEqual(REG.actionsFor('X').openNew, true);
});

console.log('市场分级 · 状态跨日失效');

ok('当日状态生效', () => {
  const v = REG.judge(d1117);
  const st = REG.makeState({ verdict: v, inputs: d1117, today: '2026-11-17', at: '14:52' });
  assert.strictEqual(REG.isFresh(st, '2026-11-17'), true);
  assert.strictEqual(REG.effectiveActions(st, '2026-11-17').openNew, false);
});

ok('生效动作必须带 level（否则 status 会把 A 级显示成「常规」）', () => {
  const v = REG.judge(d1117);
  const st = REG.makeState({ verdict: v, inputs: d1117, today: '2026-11-17' });
  assert.strictEqual(REG.effectiveActions(st, '2026-11-17').level, 'A');
  assert.strictEqual(REG.effectiveActions(st, '2026-11-18').level, 'none');
});

ok('昨天的 A 级今天不能继续拦人（必须重判）', () => {
  const v = REG.judge(d1117);
  const st = REG.makeState({ verdict: v, inputs: d1117, today: '2026-11-17' });
  assert.strictEqual(REG.isFresh(st, '2026-11-18'), false);
  const eff = REG.effectiveActions(st, '2026-11-18');
  assert.strictEqual(eff.openNew, true);
  assert.strictEqual(eff.stale, true);
  assert.strictEqual(eff.maxSinglePct, null);
});

ok('没有状态文件 = 常规放行（不假装有保护）', () => {
  const eff = REG.effectiveActions(null, '2026-11-17');
  assert.strictEqual(eff.openNew, true);
  assert.strictEqual(eff.stale, true);
});

console.log(`\n通过：${pass} 项通过${process.exitCode ? '，有失败' : ''}\n`);
