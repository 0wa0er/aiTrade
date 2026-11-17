/**
 * 当日盈亏基准用例 —— node test/pnl.test.js
 * 纯函数，不碰 data/，不依赖真实行情。
 * 背景：2026-11-17 基准被写成「现金 + 成本市值」，当日盈亏退化成累计浮盈（+355.20 实为 +12）。
 */
'use strict';
const assert = require('assert');

const P = require('../core/pnl');

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

// 11-16 收盘：现金 35187 + 12000 × 1.263 = 50343
const pos = (over = {}) => ({
  code: '512890',
  qty: 12000,
  todayBuy: 0,
  cost: 1.2344,
  price: 1.263,
  preClose: 1.263,
  dataState: 'ok',
  ...over,
});

console.log('当日基准 · 基准还原');

ok('盘前快照：现价 == 昨收，基准就是总资产', () => {
  const r = P.dayStartBaseline({ totalAsset: 50343, positions: [pos()] });
  assert.strictEqual(r.ready, true);
  assert.strictEqual(r.intradayMove, 0);
  assert.strictEqual(r.baseline, 50343);
});

ok('盘中才补到行情：按昨收还原，不把已走出的涨跌算进基准', () => {
  // 现价 1.264（+0.001）→ 49343? 不，总资产 50355，今涨 12 元
  const r = P.dayStartBaseline({ totalAsset: 50355, positions: [pos({ price: 1.264 })] });
  assert.strictEqual(r.ready, true);
  assert.strictEqual(r.intradayMove, 12);
  assert.strictEqual(r.baseline, 50343);
});

ok('今日买入的股数不计入当日涨跌', () => {
  // 昨持 8000，今日买 4000，现价高于昨收：只有 8000 股的部分算当日
  const r = P.dayStartBaseline({
    totalAsset: 50355,
    positions: [pos({ qty: 12000, todayBuy: 4000, price: 1.264 })],
  });
  assert.strictEqual(r.intradayMove, 8);
  assert.strictEqual(r.baseline, 50347);
});

ok('下跌同样按昨收还原（负向）', () => {
  const r = P.dayStartBaseline({ totalAsset: 50331, positions: [pos({ price: 1.262 })] });
  assert.strictEqual(r.intradayMove, -12);
  assert.strictEqual(r.baseline, 50343);
});

ok('空仓：基准 = 现金，永远可信', () => {
  const r = P.dayStartBaseline({ totalAsset: 35187, positions: [] });
  assert.strictEqual(r.ready, true);
  assert.strictEqual(r.baseline, 35187);
});

ok('多只持仓各自还原后加总', () => {
  const r = P.dayStartBaseline({
    totalAsset: 50000,
    positions: [
      { code: '512890', qty: 10000, todayBuy: 0, price: 1.30, preClose: 1.20, dataState: 'ok' },
      { code: '600900', qty: 1000, todayBuy: 0, price: 27.0, preClose: 28.0, dataState: 'ok' },
    ],
  });
  // 涨 1000，跌 1000 → 净 0
  assert.strictEqual(r.intradayMove, 0);
  assert.strictEqual(r.baseline, 50000);
});

console.log('当日基准 · 取价不完整时拒绝给数');

ok('行情缺失（成本兜底的元凶）→ 不给基准', () => {
  // 这正是 11-17 早上的形态：price 回退成 cost，dataState=missing
  const r = P.dayStartBaseline({
    totalAsset: 49999.8,
    positions: [pos({ price: 1.2344, preClose: 1.2344, dataState: 'missing' })],
  });
  assert.strictEqual(r.ready, false);
  assert.strictEqual(r.baseline, null);
  assert.match(r.reason, /取价不完整/);
});

ok('行情陈旧（stale）同样不给基准', () => {
  const r = P.dayStartBaseline({ totalAsset: 50355, positions: [pos({ price: 1.264, dataState: 'stale' })] });
  assert.strictEqual(r.ready, false);
  assert.strictEqual(r.baseline, null);
});

ok('昨收缺失 → 不给基准（没法定锚）', () => {
  const r = P.dayStartBaseline({ totalAsset: 50355, positions: [pos({ preClose: 0 })] });
  assert.strictEqual(r.ready, false);
  assert.strictEqual(r.baseline, null);
});

ok('一只好一只坏 → 整体不给基准，且点名是哪只', () => {
  const r = P.dayStartBaseline({
    totalAsset: 50000,
    positions: [
      { code: '512890', qty: 1000, price: 1.2, preClose: 1.2, dataState: 'ok' },
      { code: '600900', qty: 100, price: 28, preClose: 0, dataState: 'ok' },
    ],
  });
  assert.strictEqual(r.ready, false);
  assert.match(r.reason, /600900/);
});

console.log(`\n通过：${pass} 项通过${process.exitCode ? '，有失败' : ''}\n`);
