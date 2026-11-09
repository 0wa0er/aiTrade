/**
 * 实时盯盘纯逻辑用例：风控信号 + 快照摘要。
 * 覆盖三条容易被「口径」坑到的规则：
 *   1) 止盈看「当日最高曾达 +15%」，不是「现价仍 +15%」；
 *   2) 止损与止盈互斥，止损优先（跌到 -7% 时不该同时报止盈）；
 *   3) 弱于大盘 2 倍判结构，但基准上涨时不成立。
 */
const assert = require('assert');
const L = require('../core/live');

const RISK = { stopLossPct: -0.07, takeProfitPct: 0.15 };
let pass = 0;
let fail = 0;
function ok(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail += 1;
    console.log(`  ✗ ${name}\n    ${e.message}`);
  }
}

const pos = (o = {}) => ({ code: '512890', name: '红利低波ETF', qty: 12000, cost: 1.233, price: 1.233, high: 1.233, preClose: 1.233, ...o });

ok('空仓不产生信号', () => {
  assert.deepStrictEqual(L.riskSignals([], { risk: RISK }), []);
  assert.deepStrictEqual(L.riskSignals([pos({ qty: 0 })], { risk: RISK }), []);
});

ok('跌破 -7% 出止损，且数量为全部', () => {
  const s = L.riskSignals([pos({ price: 1.13 })], { risk: RISK });
  assert.strictEqual(s.length, 1);
  assert.strictEqual(s[0].type, 'stop');
  assert.strictEqual(s[0].qty, 12000, '止损必须全卖，不是减半');
  assert.strictEqual(s[0].severity, 'critical');
  assert.ok(s[0].text.includes('止损'));
});

ok('跌 -6.9% 不触发止损', () => {
  const s = L.riskSignals([pos({ price: 1.233 * 0.931 })], { risk: RISK });
  assert.strictEqual(s.filter((x) => x.type === 'stop').length, 0);
});

ok('止盈：当日最高曾 +15% 且回落 3% → 减半', () => {
  const high = 1.233 * 1.16; // 曾 +16%
  const price = high * 0.96; // 回落 4%
  const s = L.riskSignals([pos({ high, price })], { risk: RISK });
  assert.strictEqual(s.length, 1);
  assert.strictEqual(s[0].type, 'take');
  assert.strictEqual(s[0].qty, 6000, '止盈只卖一半');
});

ok('止盈：冲高但只回落 2% 不触发', () => {
  const high = 1.233 * 1.16;
  const price = high * 0.985;
  const s = L.riskSignals([pos({ high, price })], { risk: RISK });
  assert.strictEqual(s.filter((x) => x.type === 'take').length, 0);
});

ok('止盈：现价 +20% 但没回落 → 不触发（不是「现价仍 +15% 就卖」）', () => {
  const price = 1.233 * 1.2;
  const s = L.riskSignals([pos({ high: price, price })], { risk: RISK });
  assert.strictEqual(s.length, 0);
});

ok('止损优先：跌 8% 同时曾经 +16%，只报止损', () => {
  const s = L.riskSignals([pos({ high: 1.233 * 1.16, price: 1.233 * 0.92 })], { risk: RISK });
  assert.strictEqual(s.length, 1);
  assert.strictEqual(s[0].type, 'stop');
});

ok('dayHigh 参数比行情快照更实时', () => {
  // 快照 high 还是开盘价，但盯盘进程观察到过 1.43
  const s = L.riskSignals([pos({ high: 1.233, price: 1.36 })], { risk: RISK, dayHigh: { 512890: 1.44 } });
  assert.strictEqual(s[0].type, 'take');
});

ok('结构：跌 3% 而大盘跌 1%（2 倍）→ 减半', () => {
  const s = L.riskSignals([pos({ price: 1.196, preClose: 1.233 })], { risk: RISK, benchPct: -1 });
  assert.strictEqual(s.length, 1);
  assert.strictEqual(s[0].type, 'structure');
  assert.strictEqual(s[0].qty, 6000);
});

ok('结构：大盘上涨时不报结构信号', () => {
  const s = L.riskSignals([pos({ price: 1.196, preClose: 1.233 })], { risk: RISK, benchPct: 0.5 });
  assert.strictEqual(s.length, 0);
});

ok('无 cost 的脏数据跳过，不抛错', () => {
  assert.doesNotThrow(() => L.riskSignals([pos({ cost: 0 })], { risk: RISK }));
  assert.strictEqual(L.riskSignals([pos({ cost: 0 })], { risk: RISK }).length, 0);
});

ok('区间告警去抖：5 分钟内同标同方向只留一条', () => {
  const seen = {};
  const a = [{ code: '601398', side: 'upper' }];
  assert.strictEqual(L.dedupeAlerts(a, seen).length, 1);
  assert.strictEqual(L.dedupeAlerts(a, seen).length, 0, '冷却期内应被吞掉');
});

ok('快照摘要含指数、广度、持仓', () => {
  const line = L.snapshotLine({
    session: '交易中',
    indices: { 上证: { price: 3660.79, pct: 0.32 } },
    breadth: { up: 2242, down: 3148, upRatio: 40, limitUp: 58, limitDown: 2, amountYi: 14826 },
    positions: 2,
  });
  assert.ok(line.includes('上证 3660.79 +0.32%'));
  assert.ok(line.includes('涨 2242 / 跌 3148'));
  assert.ok(line.includes('涨停 58'));
  assert.ok(line.includes('持仓 2 只'));
});

console.log(`\n通过：${pass} 项通过，${fail} 项失败`);
if (fail) process.exit(1);
