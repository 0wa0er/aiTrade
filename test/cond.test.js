/**
 * 条件单用例 —— node test/cond.test.js
 * 判定是纯函数；存储用例用 TD_DATA_DIR 隔离到临时目录，不碰真实 data/
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'td-cond-'));
process.env.TD_DATA_DIR = TMP;

const K = require('../core/cond');

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

const TODAY = '2026-11-09'; // 周一
const HS = new Set();
const mk = (over = {}) =>
  K.normalize(
    {
      code: '512890',
      name: '红利低波ETF',
      side: 'buy',
      qty: 8000,
      price: 1.205,
      op: '>=',
      note: '回踩下轨',
      ...over,
    },
    { today: TODAY, holidays: HS }
  );

const ctx = (over = {}) => ({ hhmm: '10:00', price: 1.2, today: TODAY, ...over });

console.log('条件单 · 字段归一');

ok('缺理由直接拒绝', () => {
  assert.throws(() => mk({ note: '' }), /必须写理由/);
});

ok('买入缺数量拒绝；卖出留空表示全部可卖', () => {
  assert.throws(() => mk({ qty: null }), /必须写数量/);
  const sell = mk({ side: 'sell', qty: null, price: null, op: null, at: '14:50' });
  assert.strictEqual(sell.qty, null);
});

ok('没有任何触发条件拒绝', () => {
  assert.throws(() => mk({ price: null, op: null }), /至少要有一个触发条件/);
});

ok('比较方向只认 >= / <=', () => {
  assert.throws(() => mk({ op: '>' }), /比较方向/);
});

ok('默认有效期 5 个交易日（跨周末算到 11-16）', () => {
  assert.strictEqual(mk().expireOn, '2026-11-16');
});

ok('默认执行窗口 09:30~14:57，可覆盖', () => {
  assert.deepStrictEqual(mk().window, { from: '09:30', to: '14:57' });
  assert.deepStrictEqual(mk({ window: { from: '13:00', to: '14:30' } }).window, { from: '13:00', to: '14:30' });
});

ok('窗口起点晚于终点拒绝', () => {
  assert.throws(() => mk({ window: { from: '14:00', to: '13:00' } }), /窗口/);
});

ok('限价委托必须有委托价', () => {
  assert.throws(() => mk({ orderType: 'limit' }), /委托价/);
  assert.strictEqual(mk({ orderType: 'limit', limitPrice: 1.21 }).limitPrice, 1.21);
});

ok('有效期早于今天拒绝', () => {
  assert.throws(() => mk({ expireOn: '2026-11-01' }), /早于今天/);
});

console.log('条件单 · 判定');

ok('价格 >= 未到不触发，到触发', () => {
  const it = mk();
  assert.strictEqual(K.evaluate(it, ctx({ price: 1.2 })).fire, false);
  assert.strictEqual(K.evaluate(it, ctx({ price: 1.205 })).fire, true);
  assert.strictEqual(K.evaluate(it, ctx({ price: 1.3 })).fire, true);
});

ok('价格 <= 方向正确', () => {
  const it = mk({ op: '<=', price: 1.19 });
  assert.strictEqual(K.evaluate(it, ctx({ price: 1.2 })).fire, false);
  assert.strictEqual(K.evaluate(it, ctx({ price: 1.15 })).fire, true);
});

ok('纯到点单：未到点等，到点即触发', () => {
  const it = mk({ price: null, op: null, at: '14:50' });
  assert.strictEqual(K.evaluate(it, ctx({ hhmm: '14:49' })).fire, false);
  assert.strictEqual(K.evaluate(it, ctx({ hhmm: '14:50' })).fire, true);
  assert.strictEqual(K.evaluate(it, ctx({ hhmm: '14:55' })).fire, true);
});

ok('mode=all：时间到了但价未到，仍等', () => {
  const it = mk({ at: '09:45', mode: 'all' });
  assert.strictEqual(K.evaluate(it, ctx({ hhmm: '09:50', price: 1.2 })).fire, false);
  assert.strictEqual(K.evaluate(it, ctx({ hhmm: '09:50', price: 1.21 })).fire, true);
  assert.strictEqual(K.evaluate(it, ctx({ hhmm: '09:40', price: 1.21 })).fire, false);
});

ok('mode=any：任一满足即触发', () => {
  const it = mk({ at: '09:45', mode: 'any' });
  assert.strictEqual(K.evaluate(it, ctx({ hhmm: '09:50', price: 1.2 })).fire, true); // 时间到了
  assert.strictEqual(K.evaluate(it, ctx({ hhmm: '09:40', price: 1.21 })).fire, true); // 价到了
  assert.strictEqual(K.evaluate(it, ctx({ hhmm: '09:40', price: 1.2 })).fire, false);
});

ok('窗口外不触发', () => {
  const it = mk({ window: { from: '13:00', to: '14:30' } });
  assert.strictEqual(K.evaluate(it, ctx({ hhmm: '10:00', price: 1.3 })).fire, false);
  assert.strictEqual(K.evaluate(it, ctx({ hhmm: '13:30', price: 1.3 })).fire, true);
  assert.strictEqual(K.evaluate(it, ctx({ hhmm: '14:40', price: 1.3 })).fire, false);
});

ok('过期返回 expired 标记，且不再触发', () => {
  const it = { ...mk(), expireOn: '2026-11-10' };
  const r = K.evaluate(it, ctx({ today: '2026-11-11', price: 1.3 }));
  assert.strictEqual(r.fire, false);
  assert.strictEqual(r.mark, 'expired');
});

ok('已终结的单子不再判定', () => {
  for (const st of ['fired', 'cancelled', 'expired', 'error']) {
    assert.strictEqual(K.evaluate({ ...mk(), status: st }, ctx({ price: 1.3 })).fire, false);
  }
});

ok('取不到现价时不触发（避免用 0 价误判）', () => {
  const r = K.evaluate(mk({ op: '<=' , price: 1.19 }), ctx({ price: 0 }));
  assert.strictEqual(r.fire, false);
  assert.match(r.why, /取不到现价/);
});

ok('未满足时 why 说清差在哪', () => {
  const r = K.evaluate(mk({ at: '09:45' }), ctx({ hhmm: '09:40', price: 1.2 }));
  assert.strictEqual(r.hits.time, false);
  assert.strictEqual(r.hits.price, false);
  assert.match(r.why, /到点|现价/);
});

console.log('条件单 · 批量扫描与失败重试');

ok('scan 把 due / changed / waiting 分开', () => {
  const a = { ...mk(), id: 'C01' }; // 现价 1.21 → 触发
  const b = { ...mk({ code: '600900', price: 30 }), id: 'C02' }; // 未到
  const c = { ...mk({ code: '601398' }), id: 'C03', expireOn: '2026-11-10' };
  const r = K.scan([a, b, c], ctx({ today: '2026-11-11', price: 1.21 }));
  assert.deepStrictEqual(r.due.map((x) => x.item.id), ['C01']);
  assert.deepStrictEqual(r.changed.map((x) => x.id), ['C03']);
  assert.deepStrictEqual(r.waiting.map((x) => x.id), ['C02']);
});

ok('失败 1、2 次保持 active，第 3 次转 error', () => {
  let it = { ...mk(), attempts: 0 };
  it = { ...it, ...K.recordFailure(it, '风控拒绝') };
  assert.strictEqual(it.status, 'active');
  assert.strictEqual(it.attempts, 1);
  it = { ...it, ...K.recordFailure(it, '风控拒绝') };
  assert.strictEqual(it.status, 'active');
  it = { ...it, ...K.recordFailure(it, '风控拒绝') };
  assert.strictEqual(it.status, 'error');
  assert.strictEqual(it.attempts, 3);
  assert.match(it.lastError, /风控拒绝/);
});

console.log('条件单 · 存储');

ok('新增分配递增 ID，可查询可删除', () => {
  fs.rmSync(K.FILE, { force: true });
  const a = K.add({ code: '512890', name: 'A', side: 'buy', qty: 100, price: 1.2, note: 'x' }, { today: TODAY });
  const b = K.add({ code: '600900', name: 'B', side: 'sell', at: '14:50', note: 'y' }, { today: TODAY });
  assert.strictEqual(a.id, 'C01');
  assert.strictEqual(b.id, 'C02');
  assert.strictEqual(K.load().items.length, 2);
  assert.strictEqual(K.find(K.load(), 'C02').code, '600900');
  assert.strictEqual(K.find(K.load(), '512890').id, 'C01');
  K.remove('C01');
  assert.strictEqual(K.load().items.length, 1);
});

ok('prune 清掉终结项，保留 error 与 active', () => {
  fs.rmSync(K.FILE, { force: true });
  const a = K.add({ code: '512890', side: 'buy', qty: 100, price: 1.2, note: 'x' }, { today: TODAY });
  const b = K.add({ code: '600900', side: 'buy', qty: 100, price: 30, note: 'y' }, { today: TODAY });
  const c = K.add({ code: '601398', side: 'buy', qty: 100, price: 8, note: 'z' }, { today: TODAY });
  K.setStatus(a.id, 'fired');
  K.setStatus(b.id, 'error');
  const n = K.prune();
  assert.strictEqual(n, 1);
  const left = K.load().items.map((x) => x.id);
  assert.deepStrictEqual(left.sort(), [b.id, c.id].sort());
});

ok('损坏的条目不让整个文件读不出来', () => {
  fs.rmSync(K.FILE, { force: true });
  fs.mkdirSync(TMP, { recursive: true });
  fs.writeFileSync(
    K.FILE,
    JSON.stringify({
      seq: 2,
      items: [
        { id: 'C01', code: '512890', side: 'buy', qty: 100, note: 'ok', price: 1.2, op: '>=', status: 'active' },
        { id: 'C02', code: 'oops', side: 'buy', note: '' },
      ],
    }),
    'utf8'
  );
  const db = K.load();
  assert.strictEqual(db.items.length, 2);
  assert.strictEqual(db.items[1].status, 'error');
  assert.match(db.items[1].lastError, /字段非法/);
});

// 收尾
try {
  fs.rmSync(TMP, { recursive: true, force: true });
} catch (e) {}

console.log(`\n通过：${pass} 项通过，${process.exitCode ? 1 : 0} 项失败`);
