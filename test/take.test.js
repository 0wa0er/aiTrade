/**
 * 移动止盈用例 —— node test/take.test.js
 *
 * 这一层全是纯函数（算价 + 出结论），没有网络也没有文件，
 * 所以用例重点放在「边界」上：保本线准入、只上移、T+1 不建单。
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'td-take-'));
process.env.TD_DATA_DIR = TMP;

const T = require('../core/take');
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

/** 造 K 线：给一串 [high, low, close]，日期自动递增 */
const bars = (rows, start = '2026-10-01') => {
  const d0 = new Date(`${start}T00:00:00Z`);
  return rows.map(([high, low, close], i) => {
    const d = new Date(d0.getTime() + i * 86400000);
    return { date: d.toISOString().slice(0, 10), open: close, high, low, close, volume: 1, amount: 1 };
  });
};

// 512890 真实量级：1.20~1.24，日振幅 0.015 左右
const flat20 = Array.from({ length: 21 }, () => [1.24, 1.22, 1.23]);

console.log('移动止盈 · ATR 与回撤容忍');

ok('ATR% 按真实波幅算，平静 ETF 落在 1% 量级', () => {
  const pct = T.atrPctOf(bars(flat20));
  assert.ok(pct > 0.5 && pct < 2.5, `实得 ${pct}`);
});

ok('样本不足直接返回 0（不猜）', () => {
  assert.strictEqual(T.atrPctOf(bars(flat20.slice(0, 5))), 0);
  assert.strictEqual(T.atrPctOf([]), 0);
});

ok('回撤容忍 = 1.8×ATR，并夹在 2.5%~8%', () => {
  assert.ok(Math.abs(T.pullOf(1.63) - 0.02934) < 1e-9);
  assert.strictEqual(T.pullOf(0.5), T.PULL_MIN); // 极平静的品种不低于 2.5%
  assert.strictEqual(T.pullOf(9), T.PULL_MAX); // 极暴躁的品种不超过 8%
  // 取不到 ATR 时用保守默认 2.5%（×1.8 = 4.5%）
  assert.ok(Math.abs(T.pullOf(0) - 0.045) < 1e-9);
});

console.log('移动止盈 · 持仓期最高价');

ok('highSince 只取建仓日之后的 K 线', () => {
  const kl = bars([
    [9.9, 9.0, 9.5],
    [1.30, 1.20, 1.25],
    [1.40, 1.20, 1.35],
  ]);
  const all = T.highSince(kl);
  assert.strictEqual(all, 9.9);
  const since = T.highSince(kl, kl[1].date);
  assert.strictEqual(since, 1.4, '建仓日之后不应再看到 9.9 这个坑');
});

ok('建仓日早于全部 K 线时退回全部样本', () => {
  const kl = bars([[1.30, 1.20, 1.25]]);
  assert.strictEqual(T.highSince(kl, '2020-01-01'), 1.3);
});

console.log('移动止盈 · 目标价与保本线准入');

ok('浮盈不足不挂：回撤后跌破保本线', () => {
  // 成本 1.2344，最高 1.24，回撤 2.93% → 1.204 < 保本线 1.259
  const t = T.takeTarget({ cost: 1.2344, high: 1.24, atrPct: 1.63 });
  assert.strictEqual(t.ok, false);
  assert.match(t.reason, /浮盈不足/);
  assert.match(t.reason, /需最高价达/);
});

ok('浮盈够了：目标价 = 最高价 ×(1-回撤)，且高于保本线', () => {
  const t = T.takeTarget({ cost: 1.2344, high: 1.35, atrPct: 1.63 });
  assert.strictEqual(t.ok, true);
  assert.strictEqual(t.pull, 0.0293);
  assert.strictEqual(t.target, 1.31); // 1.35 × 0.97066 = 1.3104 → 1.31
  assert.ok(t.target > t.safety);
  assert.ok(t.lockPct > 6, `锁定 ${t.lockPct}%`);
});

ok('保本线是准入条件而不是兜底：不会算出高于现价的目标价', () => {
  // 若把 max(保本线, target) 当兜底，这里会得出 1.259 > 最高价 1.24 的荒谬结果
  const t = T.takeTarget({ cost: 1.2344, high: 1.24, atrPct: 1.63 });
  assert.strictEqual(t.ok, false);
  assert.ok(t.target === undefined, '不挂时不应返回目标价');
});

ok('个股（高 ATR）回撤自动放宽，不会被日内噪音洗出', () => {
  const etf = T.pullOf(1.63);
  const stock = T.pullOf(3.5);
  assert.ok(stock > etf, `${stock} 应大于 ${etf}`);
  assert.ok(Math.abs(stock - 0.063) < 1e-9, `实得 ${stock}`);
});

ok('缺成本或缺最高价 → 直接拒绝', () => {
  assert.strictEqual(T.takeTarget({ cost: 0, high: 1.3 }).ok, false);
  assert.strictEqual(T.takeTarget({ cost: 1.2, high: 0 }).ok, false);
});

console.log('移动止盈 · 单子该怎么处置');

const tgt = (over = {}) => ({ ok: true, target: 1.33, pull: 0.0293, safety: 1.259, high: 1.37, cost: 1.2344, gainPct: 11, lockPct: 7.7, ...over });

ok('算不出目标价 → skip', () => {
  const d = T.decide({ t: { ok: false, reason: '浮盈不足' }, existing: null, available: 1000 });
  assert.strictEqual(d.action, 'skip');
  assert.match(d.reason, /浮盈不足/);
});

ok('T+1 可卖 0 股 → wait，不建单', () => {
  const d = T.decide({ t: tgt(), existing: null, available: 0 });
  assert.strictEqual(d.action, 'wait');
  assert.match(d.reason, /T\+1/);
});

ok('没有单 + 可卖 → create', () => {
  const d = T.decide({ t: tgt(), existing: null, available: 12000 });
  assert.strictEqual(d.action, 'create');
  assert.strictEqual(d.price, 1.33);
});

ok('已有单且新价更高 → raise', () => {
  const existing = { triggers: { price: { op: '>=', value: 1.29 } } };
  const d = T.decide({ t: tgt(), existing, available: 12000 });
  assert.strictEqual(d.action, 'raise');
  assert.strictEqual(d.price, 1.33);
});

ok('新价没超过上移步长 → hold，避免为 1 分钱反复撤建', () => {
  const existing = { triggers: { price: { op: '>=', value: 1.326 } } };
  const d = T.decide({ t: tgt(), existing, available: 12000 });
  assert.strictEqual(d.action, 'hold');
  assert.strictEqual(d.price, 1.326);
});

ok('价格回落导致新目标价更低 → hold，止盈线绝不下调', () => {
  const existing = { triggers: { price: { op: '>=', value: 1.40 } } };
  const d = T.decide({ t: tgt({ target: 1.33 }), existing, available: 12000 });
  assert.strictEqual(d.action, 'hold');
  assert.strictEqual(d.price, 1.40);
  assert.match(d.reason, /不下调/);
});

ok('上移步长：0.4% 与 0.005 元取大', () => {
  assert.ok(Math.abs(T.stepOf(1.33) - 0.00532) < 1e-9); // 1.33×0.4% = 5.3 个最小变动档
  assert.ok(Math.abs(T.stepOf(10) - 0.04) < 1e-9); // 10×0.004=0.04 > 0.005
});

console.log('移动止盈 · 条件单上移留痕');

const mkCond = (over = {}) => ({
  code: '512890',
  name: '红利低波ETF',
  side: 'buy',
  qty: 8000,
  price: 1.205,
  op: '>=',
  note: '回踩',
  ...over,
});

ok('revise 保留 id/createdAt，并追加一条修正留痕', () => {
  const it = K.add(mkCond({ side: 'sell', qty: null, price: 1.29, note: '移动止盈', source: 'take' }), {
    today: '2026-11-09',
  });
  const next = K.revise(
    it.id,
    { triggers: { price: { op: '>=', value: 1.33 } }, why: '最高价抬升' },
    { today: '2026-11-09' }
  );
  assert.strictEqual(next.id, it.id);
  assert.strictEqual(next.createdAt, it.createdAt);
  assert.strictEqual(next.triggers.price.value, 1.33);
  assert.strictEqual(next.revisions.length, 1);
  assert.match(next.revisions[0].why, /最高价抬升/);
  assert.match(next.revisions[0].from, /1\.29/);
  assert.match(next.revisions[0].to, /1\.33/);
});

ok('source=take 能被 list 筛出来，普通单不会被当成止盈单', () => {
  K.add(mkCond({ code: '600000', price: 1.1 }), { today: '2026-11-09' });
  const list = K.list({ source: 'take', status: 'active' });
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].code, '512890');
});

ok('非 active 的单不允许修正（已触发/已撤的不能改）', () => {
  const it = K.add(mkCond({ code: '600001', side: 'sell', qty: null, price: 1.2, source: 'take' }), {
    today: '2026-11-09',
  });
  K.setStatus(it.id, 'cancelled');
  assert.throws(() => K.revise(it.id, { triggers: { price: { op: '>=', value: 1.3 } } }), /只有 active 可修正/);
});

ok('revise 不接受改标的（改方向等于换单，应撤了重下）', () => {
  const it = K.add(mkCond({ code: '600002', side: 'sell', qty: null, price: 1.2, source: 'take' }), {
    today: '2026-11-09',
  });
  const next = K.revise(it.id, { code: '600003', triggers: { price: { op: '>=', value: 1.3 } } }, {
    today: '2026-11-09',
  });
  assert.strictEqual(next.code, '600002');
});

console.log(`\n移动止盈：${pass} 项通过${process.exitCode ? '，有失败' : ''}`);
