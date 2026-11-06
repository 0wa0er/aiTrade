'use strict';

/**
 * 交易核心自测：撮合、费用、冻结、T+1、部分成交。
 * 运行：node test/trading.test.js
 */

const assert = require('assert');
const path = require('path');
const S = require(path.join(__dirname, '..', 'server.js'));
const { applyFills, finishOrder, takeFromLevels, availableOf } = S.__test;

let pass = 0;
function ok(name, fn) {
  try {
    fn();
    pass++;
    console.log('  ✓ ' + name);
  } catch (e) {
    console.log('  ✗ ' + name + '\n    ' + e.message);
    process.exitCode = 1;
  }
}

function freshState(cash = 1000000) {
  return { cash, frozenCash: 0, positions: {}, orders: [], trades: [], actions: [], seq: 1, orderSeq: 1 };
}

function mkOrder(o) {
  return {
    id: 'O000001',
    ts: new Date().toISOString(),
    time: '2026-11-06 10:00:00',
    tradeDate: '2026-11-06',
    secid: '1.600519',
    code: '600519',
    name: '贵州茅台',
    type: 'stock',
    side: 'buy',
    orderType: 'limit',
    price: 1452,
    qty: 100,
    filledQty: 0,
    filledAmount: 0,
    feeTotal: 0,
    frozen: 0,
    frozenQty: 0,
    status: 'pending',
    phase: 'continuous',
    fills: [],
    ...o,
  };
}

const now = new Date(2026, 10, 6, 10, 0, 0);

console.log('\n撮合与结算');

ok('限价买单只吃价格不高于委托价的卖档', () => {
  const o = mkOrder({ price: 1452, qty: 300 });
  const asks = [
    { price: 1451, volume: 100 },
    { price: 1452, volume: 100 },
    { price: 1453, volume: 500 },
  ];
  const fills = takeFromLevels(o, asks);
  assert.strictEqual(fills.length, 2, '应只成交前两档');
  assert.strictEqual(fills.reduce((s, f) => s + f.qty, 0), 200, '应成交 200 股');
  assert.deepStrictEqual(asks.map((a) => a.volume), [0, 0, 500], '深度应被消耗');
});

ok('市价单吃满五档后剩余留待撤销', () => {
  const o = mkOrder({ orderType: 'market', price: null, qty: 1000 });
  const asks = [
    { price: 1451, volume: 300 },
    { price: 1452, volume: 300 },
  ];
  const fills = takeFromLevels(o, asks);
  assert.strictEqual(fills.reduce((s, f) => s + f.qty, 0), 600, '只能吃到 600 股');
});

ok('涨停无卖盘时无法成交', () => {
  const o = mkOrder({ price: 1597.2, qty: 100 });
  assert.strictEqual(takeFromLevels(o, []).length, 0);
});

ok('手续费按成交额计算（佣金万2.5最低5元 + 过户费万0.1）', () => {
  const st = freshState();
  const o = mkOrder({ frozen: 145237.75 });
  st.frozenCash = 145237.75;
  applyFills(st, o, [{ price: 1452, qty: 100 }], now);
  const t = st.trades[0];
  assert.strictEqual(t.amount, 145200);
  assert.strictEqual(t.feeDetail.commission, 36.3, '佣金应为 36.3');
  assert.strictEqual(t.feeDetail.transfer, 1.45, '过户费应为 1.45');
  assert.strictEqual(t.feeDetail.stamp, 0, '买入不收印花税');
  assert.strictEqual(st.cash, 1000000, '可用资金在下单时已扣，此处不变');
  assert.strictEqual(st.frozenCash, 0, '冻结全部用于成交');
  assert.strictEqual(st.positions['1.600519'].qty, 100);
  assert.strictEqual(availableOf(st.positions['1.600519']), 0, '当日买入不可卖');
});

ok('卖出收印花税千0.5', () => {
  const st = freshState(0);
  st.positions['1.600519'] = {
    secid: '1.600519', code: '600519', name: '贵州茅台', type: 'stock',
    qty: 100, frozen: 0, todayBuy: 0, cost: 1400, openDate: '2026-06-01',
    lots: [{ date: '2026-06-01', qty: 100 }], divReceived: 0, divApplied: [],
  };
  const o = mkOrder({ side: 'sell', price: 1500, qty: 100, frozenQty: 100 });
  applyFills(st, o, [{ price: 1500, qty: 100 }], now);
  const t = st.trades[0];
  assert.strictEqual(t.amount, 150000);
  assert.strictEqual(t.feeDetail.stamp, 75, '印花税应为 150000×0.0005=75');
  assert.strictEqual(t.feeDetail.commission, 37.5);
  assert.strictEqual(st.cash, 150000 - 75 - 37.5 - 1.5);
  assert.strictEqual(st.positions['1.600519'], undefined, '清仓后持仓应删除');
});

ok('卖出后持仓冻结同步释放，剩余股份仍可卖', () => {
  const st = freshState(0);
  st.positions['1.600519'] = {
    secid: '1.600519', code: '600519', name: '贵州茅台', type: 'stock',
    qty: 500, frozen: 300, todayBuy: 0, cost: 1400, openDate: '2026-06-01',
    lots: [{ date: '2026-06-01', qty: 500 }], divReceived: 0, divApplied: [],
  };
  const o = mkOrder({ side: 'sell', price: 1500, qty: 300, frozenQty: 300 });
  applyFills(st, o, [{ price: 1500, qty: 100 }], now);
  const p = st.positions['1.600519'];
  assert.strictEqual(p.qty, 400);
  assert.strictEqual(p.frozen, 200, '剩余冻结 200 股');
  assert.strictEqual(order0Frozen(o), 200);
  assert.strictEqual(availableOf(p), 200, '可用 = 400-0-200');
});

function order0Frozen(o) {
  return o.frozenQty;
}

ok('撤单释放剩余冻结资金', () => {
  const st = freshState(0);
  st.frozenCash = 145200;
  const o = mkOrder({ frozen: 145200, qty: 100 });
  finishOrder(st, o, 'cancelled', '客户撤单');
  assert.strictEqual(st.cash, 145200, '冻结资金应退回可用');
  assert.strictEqual(st.frozenCash, 0);
  assert.strictEqual(o.status, 'cancelled');
});

ok('部分成交后撤单，只退未成交部分', () => {
  const st = freshState(0);
  st.frozenCash = 300000;
  const o = mkOrder({ frozen: 300000, qty: 200 });
  applyFills(st, o, [{ price: 1452, qty: 100 }], now);
  finishOrder(st, o, 'cancelled', '客户撤单');
  assert.strictEqual(st.frozenCash, 0, '冻结应清零');
  assert.strictEqual(st.cash, 300000 - 145200 - 37.75, '只扣已成交部分，其余退回');
  assert.strictEqual(st.positions['1.600519'].qty, 100);
});

ok('T+1：次日日切后可卖', () => {
  const p = { type: 'stock', qty: 100, todayBuy: 100, frozen: 0 };
  assert.strictEqual(availableOf(p), 0);
  p.todayBuy = 0;
  assert.strictEqual(availableOf(p), 100);
});

ok('红利税按持有期差别化（<1月 20%，1月-1年 10%，>1年 0）', () => {
  const mk = (openDate) => {
    const st = freshState(0);
    st.positions['1.600519'] = {
      secid: '1.600519', code: '600519', name: '贵州茅台', type: 'stock',
      qty: 100, frozen: 0, todayBuy: 0, cost: 1400, openDate,
      lots: [{ date: openDate, qty: 100 }], divReceived: 1000, divApplied: [],
    };
    const o = mkOrder({ side: 'sell', price: 1500, qty: 100, frozenQty: 100 });
    applyFills(st, o, [{ price: 1500, qty: 100 }], now);
    return st.trades[0].divTax;
  };
  assert.strictEqual(mk('2026-10-20'), 200, '持有 17 天，税率 20%');
  assert.strictEqual(mk('2026-06-01'), 100, '持有 158 天，税率 10%');
  assert.strictEqual(mk('2024-01-01'), 0, '持有超 1 年，免征');
});

console.log(`\n通过 ${pass} 项\n`);
