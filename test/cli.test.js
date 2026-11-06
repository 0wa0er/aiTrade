'use strict';

/**
 * 自动盯盘护栏自测：5 万本金下的仓位上限、最低单笔、单日买入额度、ST 与标的适配性。
 * 运行：node test/cli.test.js
 *
 * 这些断言是定时任务的最后一道闸门 —— 任务里的提示词会忘事，代码不会。
 */

const assert = require('assert');
const path = require('path');
const { guardBuy, riskContext, estimateFee, secidOf, typeOf } = require(path.join(__dirname, '..', 'cli.js'));

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

const CFG = {
  risk: {
    maxPositions: 3,
    maxSinglePct: 0.3,
    minTradeAmount: 10000,
    minCashPct: 0.08,
    maxDailyBuyPct: 0.4,
    stopLossPct: -0.07,
    takeProfitPct: 0.15,
    maxPricePerShare: 130,
    forbidST: true,
    forbidFund: true,
  },
};

/** 构造 5 万本金账户的上下文 */
function ctxOf({ equity = 50000, cash = 50000, positions = [], todayBuy = 0 } = {}) {
  return {
    equity,
    cash,
    positions,
    positionCount: positions.length,
    todayBuy,
    maxPositions: 3,
    maxSinglePct: 0.3,
    minTradeAmount: 10000,
    minCashPct: 0.08,
    maxDailyBuyPct: 0.4,
    stopLossPct: -0.07,
    takeProfitPct: 0.15,
    maxPricePerShare: 130,
    maxSingleValue: equity * 0.3,
    maxDailyBuy: equity * 0.4,
    minCash: equity * 0.08,
  };
}

const q = (price, extra = {}) => ({ price, limitUp: Math.round(price * 1.1 * 100) / 100, limitDown: Math.round(price * 0.9 * 100) / 100, ...extra });

function buy(o) {
  return guardBuy({
    cfg: CFG,
    ctx: o.ctx || ctxOf(),
    dash: { account: {} },
    quote: o.quote || q(o.price || 10),
    code: o.code || '600900',
    name: o.name || '长江电力',
    type: o.type || 'stock',
    qty: o.qty,
    price: o.price,
    market: o.market !== false,
  });
}

function throws(fn, kw) {
  let msg = '';
  try {
    fn();
  } catch (e) {
    msg = e.message;
  }
  assert.ok(msg, `应当拒绝但通过了（期望含「${kw}」）`);
  assert.ok(msg.includes(kw), `拒绝理由应含「${kw}」，实际：「${msg}」`);
}

console.log('\n自动盯盘护栏');

ok('茅台一手 14.5 万，超出单票上限 → 拒绝并说明原因', () => {
  throws(() => buy({ code: '600519', name: '贵州茅台', price: 1453, qty: 100 }), '最小一手');
});

ok('宁德时代一手 2.5 万，同样超出 → 拒绝', () => {
  throws(() => buy({ code: '300750', name: '宁德时代', price: 254.22, qty: 100 }), '最小一手');
});

ok('单价 50 元买 200 股（1 万）→ 通过', () => {
  const amt = buy({ code: '600584', name: '长电科技', price: 50, qty: 200 });
  assert.strictEqual(Math.round(amt), 10000);
});

ok('单笔 844 元低于 1 万下限 → 拒绝（最低佣金会翻倍费率）', () => {
  throws(() => buy({ code: '601398', name: '工商银行', price: 8.44, qty: 100 }), '低于下限');
});

ok('刚好 1 万整 → 通过', () => {
  const amt = buy({ code: '601398', name: '工商银行', price: 10, qty: 1000 });
  assert.strictEqual(Math.round(amt), 10000);
});

ok('买入后该股 1.64 万 > 单票上限 1.5 万 → 拒绝', () => {
  throws(() => buy({ code: '300274', name: '阳光电源', price: 81.97, qty: 200 }), '超过单票上限');
});

ok('已有 3 只持仓时开第 4 只 → 拒绝', () => {
  const positions = ['a', 'b', 'c'].map((c) => ({ code: c, marketValue: 10000 }));
  throws(() => buy({ code: '600900', name: '长江电力', price: 30, qty: 400, ctx: ctxOf({ cash: 20000, positions }) }), '达到上限');
});

ok('已持有的票加仓不受持仓只数限制（仍受单票上限与最低单笔约束）', () => {
  const positions = ['600900', 'b', 'c'].map((c) => ({ code: c, marketValue: 2000 }));
  const amt = buy({ code: '600900', name: '长江电力', price: 30, qty: 400, ctx: ctxOf({ cash: 35000, positions }) });
  assert.strictEqual(Math.round(amt), 12000, '2000 + 12000 = 14000，未超 15000');
});

ok('买入后现金跌破 8% 保留线 → 拒绝', () => {
  // 权益 5 万，最低留 4000；买 1.5 万但只有 1.2 万可用
  throws(() => buy({ price: 30, qty: 500, ctx: ctxOf({ cash: 12000 }) }), '可用资金不足');
});

ok('单日买入已达 2 万上限 → 拒绝下一笔', () => {
  throws(() => buy({ price: 30, qty: 400, ctx: ctxOf({ todayBuy: 19000 }) }), '单日买入上限');
});

ok('ST 股 → 拒绝', () => {
  throws(() => buy({ code: '600340', name: '*ST华幸', price: 1.13, qty: 10000 }), 'ST');
});

ok('股价超过单价上限 130 → 拒绝', () => {
  throws(() => buy({ code: '600900', name: '长江电力', price: 140, qty: 100 }), '单价上限');
});

ok('场外基金 → 拒绝自动交易', () => {
  throws(() => buy({ code: '000001', name: '华夏成长混合', type: 'fund', price: 1, qty: 10000 }), '场外基金');
});

ok('ETF 3000 份 1.2 万 → 通过', () => {
  const amt = buy({ code: '510300', name: '沪深300ETF', type: 'etf', price: 4.124, qty: 3000 });
  assert.ok(Math.abs(amt - 12372) < 1, `实际 ${amt}`);
});

console.log('\n费用估算与代码映射');

ok('5 万本金买 1 万：佣金按下限 5 元，费率 0.05%', () => {
  const f = estimateFee(10000, 'buy', 'stock');
  assert.strictEqual(f.comm, 5, '佣金应为最低 5 元');
  assert.strictEqual(Math.round(f.transfer * 100) / 100, 0.1, '过户费 万0.1');
  assert.strictEqual(f.stamp, 0, '买入不收印花税');
});

ok('卖出 1 万：印花税千 0.5 = 5 元', () => {
  const f = estimateFee(10000, 'sell', 'stock');
  assert.strictEqual(Math.round(f.stamp * 100) / 100, 5);
  assert.ok(Math.abs(f.total - 10.1) < 0.05, `卖出 1 万总费用应为 5(佣金)+0.1(过户)+5(印花)=10.1，实际 ${f.total}`);
});

ok('一买一卖 1 万的往返成本约 0.15%，与理论一致', () => {
  const b = estimateFee(10000, 'buy', 'stock').total;
  const s = estimateFee(10000, 'sell', 'stock').total;
  const rate = (b + s) / 10000;
  assert.ok(rate > 0.0014 && rate < 0.0017, `往返费率 ${(rate * 100).toFixed(3)}% 应在 0.14%~0.17%`);
});

ok('ETF 免印花税与过户费', () => {
  const f = estimateFee(10000, 'sell', 'etf');
  assert.strictEqual(f.stamp, 0);
  assert.strictEqual(f.transfer, 0);
});

ok('secid 与类型映射', () => {
  assert.strictEqual(secidOf('600519'), '1.600519');
  assert.strictEqual(secidOf('000001'), '0.000001');
  assert.strictEqual(secidOf('300750'), '0.300750');
  assert.strictEqual(secidOf('510300'), '1.510300');
  assert.strictEqual(typeOf('510300'), 'etf');
  assert.strictEqual(typeOf('159915'), 'etf');
  assert.strictEqual(typeOf('600519'), 'stock');
});

console.log(`\n通过 ${pass} 项\n`);
