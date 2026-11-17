/**
 * 双档入场方案用例 —— node test/entry.test.js
 * 纯函数，不碰 data/。
 *
 * 背景：2026-11-09~17 八个交易日，候选池五只方向全对，但只成交 1 笔 ——
 * 因为入场只留了「回踩均线」一条路，而抗跌品种正因资金持续流入才不会回踩。
 * 补上「突破确认档」之后，必须验三件事：金额不越单票上限、股数是整手、
 * 以及半档在 5 万本金下真的挂得出来（不能因为取整掉到 1 万下限下面就作废）。
 */
'use strict';
const assert = require('assert');

const E = require('../core/entry');

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

const near = (a, b, tol = 0.02) => Math.abs(a - b) <= tol;

// 512890 实测：现价 1.264，MA20 1.231，20 日高 1.266，单票上限 15,102.90
const etf = {
  price: 1.264,
  ma20: 1.231,
  high20: 1.266,
  maxSingleValue: 15102.9,
  minTradeAmount: 10000,
  lotStep: 100,
};

console.log('双档入场 · 512890 实测参数');

ok('回踩档：触发价 = MA20，股数为整手，金额不越单票上限', () => {
  const p = E.entryPlan(etf).pullback;
  assert.strictEqual(p.trigger, 1.231);
  assert.strictEqual(p.qty % 100, 0);
  assert.ok(p.amount <= 15102.9 * 1.0001, `金额 ${p.amount} 越上限`);
  assert.ok(p.amount >= 10000);
  assert.strictEqual(p.ok, true);
  assert.strictEqual(p.qty, 12200); // 15000/1.231 ≈ 122.6 → 12200
});

ok('突破档：触发价 = 20 日高 ×1.001，金额低于回踩档（这是「追高用小仓位」）', () => {
  const r = E.entryPlan(etf);
  const brk = r.breakout;
  assert.ok(near(brk.trigger, 1.2673, 0.001), `触发价 ${brk.trigger}`);
  assert.ok(brk.amount < r.pullback.amount, '半档金额必须小于满档');
  assert.ok(brk.amount >= 10000, '半档不得掉到单笔下限下面');
  assert.ok(brk.amount <= 15102.9 * 1.0001);
  assert.strictEqual(brk.ok, true);
});

ok('半档取整后不足 1 万时补一手，而不是直接判不可行', () => {
  const brk = E.entryPlan(etf).breakout;
  // 7800 × 1.267266 = 9,884.67 < 10,000 → 补到 7900 → 10,011.40
  assert.strictEqual(brk.qty, 7900);
  assert.ok(near(brk.amount, 10011.4, 1), `金额 ${brk.amount}`);
});

ok('保护下限：回踩档在 MA20 下方 2.5%，突破档在新高下方 1.5%', () => {
  const r = E.entryPlan(etf);
  assert.ok(near(r.pullback.floor, 1.231 * 0.975, 0.001), `回踩 floor ${r.pullback.floor}`);
  assert.ok(near(r.breakout.floor, r.breakout.trigger * 0.985, 0.001), `突破 floor ${r.breakout.floor}`);
});

console.log('双档入场 · 结构性不可行的场景');

ok('84 元的票：100 股 8,400 不足 1 万、200 股 16,800 超上限 → 两档都不可行', () => {
  const r = E.entryPlan({ price: 84, ma20: 83, high20: 85, maxSingleValue: 15000, minTradeAmount: 10000, lotStep: 100 });
  assert.strictEqual(r.pullback.ok, false);
  assert.strictEqual(r.breakout.ok, false);
  assert.match(r.pullback.why, /低于单笔下限|超单票上限/);
});

ok('单票上限收紧到 20%（A 级）时，满档跟着降 → 1.5 万变 1 万档', () => {
  const loose = E.entryPlan({ ...etf, maxSingleValue: 15102.9 }).pullback;
  const tight = E.entryPlan({ ...etf, maxSingleValue: 10068.6 }).pullback;
  assert.ok(tight.qty < loose.qty, '收紧后股数应减少');
  assert.ok(tight.amount <= 10068.6 * 1.0001);
});

ok('没有 MA20 时不炸，退化为按现价算', () => {
  const r = E.entryPlan({ price: 10, ma20: 0, high20: 0, maxSingleValue: 15000, minTradeAmount: 10000 });
  assert.strictEqual(r.pullback.trigger, 10);
  assert.strictEqual(r.pullback.qty, 1500);
  assert.strictEqual(r.pullback.ok, true);
});

ok('股价高于 MA20 → 提示还需回落多少', () => {
  const r = E.entryPlan(etf);
  assert.ok(r.notes.some((n) => /回踩档需回落/.test(n)), r.notes.join(' | '));
});

console.log('双档入场 · 提醒文案');

ok('两档互斥的提醒必须在', () => {
  const r = E.entryPlan(etf);
  assert.ok(r.notes.some((n) => /两档互斥|只挂一张/.test(n)), r.notes.join(' | '));
});

ok('现价已在 20 日高之上 → 突破档即时可挂', () => {
  const r = E.entryPlan({ ...etf, price: 1.27 });
  assert.ok(r.notes.some((n) => /即时可挂/.test(n)), r.notes.join(' | '));
});

console.log(`\n通过：${pass} 项通过${process.exitCode ? '，有失败' : ''}\n`);
