/**
 * 自选股生命周期用例 —— node test/watch.test.js
 * 纯逻辑，不碰真实 data/
 */
'use strict';
const assert = require('assert');
const W = require('../core/watch');

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
const item = (over = {}) => W.normalize({ secid: '1.600900', code: '600900', name: '长江电力', type: 'stock', ...over }, { today: TODAY, holidays: HS });

console.log('自选股 · 字段归一');

ok('历史条目（无 source）视为手动，且不设到期日', () => {
  const it = item();
  assert.strictEqual(it.source, 'manual');
  assert.strictEqual(it.expireOn, '');
  assert.strictEqual(W.daysLeft(it, TODAY, HS), null);
});

ok('计划来源自动算出 5 个交易日后到期（跨周末）', () => {
  const it = item({ source: 'plan', note: '回踩等买点' });
  assert.strictEqual(it.addedOn, TODAY);
  assert.strictEqual(it.expireOn, '2026-11-16');
  assert.strictEqual(W.daysLeft(it, TODAY, HS), 5); // 09→16 之间还有 5 个交易日
});

ok('节假日会顺延到期日', () => {
  const hs = new Set(['2026-11-10']);
  const it = W.normalize({ code: '600900', secid: '1.600900', source: 'plan', note: 'x' }, { today: TODAY, holidays: hs });
  assert.strictEqual(it.expireOn, '2026-11-17');
});

ok('到期日当天剩余 0，次日起算过期', () => {
  const it = item({ source: 'plan', note: 'x', expireOn: '2026-11-10' });
  assert.strictEqual(W.daysLeft(it, '2026-11-10', HS), 0);
  assert.strictEqual(W.isExpired(it, '2026-11-10'), false);
  assert.strictEqual(W.isExpired(it, '2026-11-11'), true);
});

console.log('自选股 · 进场闸门');

ok('新计划项可入场', () => {
  const r = W.decideAdd({ raw: { secid: '1.600900', code: '600900', name: '长江电力', source: 'plan', note: '等回踩' }, list: [], today: TODAY, holidays: HS });
  assert.strictEqual(r.action, 'add');
  assert.strictEqual(r.item.expireOn, '2026-11-16');
});

ok('计划项没写理由一律拒绝', () => {
  const r = W.decideAdd({ raw: { secid: '1.600900', code: '600900', source: 'plan' }, list: [], today: TODAY, holidays: HS });
  assert.strictEqual(r.action, 'reject');
  assert.match(r.reason, /理由/);
});

ok('手动项不需要理由', () => {
  const r = W.decideAdd({ raw: { secid: '1.600900', code: '600900' }, list: [], today: TODAY, holidays: HS });
  assert.strictEqual(r.action, 'add');
  assert.strictEqual(r.item.expireOn, '');
});

ok('重复添加是幂等刷新，不新增第二条', () => {
  const exist = item({ source: 'plan', note: '旧理由', expireOn: '2026-11-13' });
  const r = W.decideAdd({ raw: { secid: '1.600900', code: '600900', source: 'plan', note: '新理由' }, list: [exist], today: TODAY, holidays: HS });
  assert.strictEqual(r.action, 'refresh');
  assert.strictEqual(r.item.note, '新理由');
  assert.strictEqual(r.item.expireOn, '2026-11-16');
});

ok('手动项被计划重复添加时不被设置期限', () => {
  const manual = item({ note: '我自己加的' });
  const r = W.decideAdd({ raw: { secid: '1.600900', code: '600900', source: 'plan', note: '计划也想盯' }, list: [manual], today: TODAY, holidays: HS });
  assert.strictEqual(r.action, 'refresh');
  assert.strictEqual(r.item.source, 'manual');
  assert.strictEqual(r.item.expireOn, '');
});

ok('总数到上限拒绝', () => {
  const list = Array.from({ length: W.MAX_TOTAL }, (_, i) => ({ secid: `1.60000${i}`, code: `60000${i}` }));
  const r = W.decideAdd({ raw: { secid: '1.600900', code: '600900' }, list, today: TODAY, holidays: HS });
  assert.strictEqual(r.action, 'reject');
  assert.match(r.reason, /已满/);
});

ok('计划观察位到上限拒绝', () => {
  const list = Array.from({ length: W.MAX_PLAN }, (_, i) => ({ secid: `1.60000${i}`, code: `60000${i}`, source: 'plan', note: 'x' }));
  const r = W.decideAdd({ raw: { secid: '1.600900', code: '600900', source: 'plan', note: 'x' }, list, today: TODAY, holidays: HS });
  assert.strictEqual(r.action, 'reject');
  assert.match(r.reason, /观察位/);
});

ok('一手金额超单票上限拒绝', () => {
  const r = W.decideAdd({
    raw: { secid: '1.600519', code: '600519', name: '贵州茅台' },
    list: [],
    today: TODAY,
    holidays: HS,
    limits: { maxSingleValue: 15000, oneLotValue: 145000 },
  });
  assert.strictEqual(r.action, 'reject');
  assert.match(r.reason, /一手/);
});

ok('代码非法拒绝', () => {
  const r = W.decideAdd({ raw: { secid: '', code: '6009' }, list: [], today: TODAY, holidays: HS });
  assert.strictEqual(r.action, 'reject');
});

console.log('自选股 · 退场判定');

ok('观察期满退役', () => {
  const list = [item({ source: 'plan', note: 'x', expireOn: '2026-11-06' })];
  const r = W.pruneList({ list, today: TODAY });
  assert.strictEqual(r.removed.length, 1);
  assert.match(r.removed[0].reason, /观察期满/);
  assert.strictEqual(r.keep.length, 0);
});

ok('已建仓的退役（转由持仓区跟踪）', () => {
  const list = [item({ source: 'plan', note: 'x', expireOn: '2026-11-30' })];
  const r = W.pruneList({ list, today: TODAY, holdings: ['600900'] });
  assert.strictEqual(r.removed.length, 1);
  assert.match(r.removed[0].reason, /已建仓/);
});

ok('手动项永不自动退役', () => {
  const list = [item(), item({ secid: '1.601398', code: '601398', name: '工商银行' })];
  const r = W.pruneList({ list, today: TODAY, holdings: ['600900', '601398'] });
  assert.strictEqual(r.removed.length, 0);
  assert.strictEqual(r.keep.length, 2);
});

ok('未到期的计划项保留', () => {
  const list = [item({ source: 'plan', note: 'x', expireOn: '2026-11-16' })];
  const r = W.pruneList({ list, today: TODAY });
  assert.strictEqual(r.removed.length, 0);
  assert.strictEqual(r.keep.length, 1);
});

ok('超上限只淘汰最久的计划项，手动项不动', () => {
  const manual = { secid: '1.600028', code: '600028', name: '中国石化' };
  const plans = Array.from({ length: W.MAX_TOTAL }, (_, i) => ({
    secid: `1.60000${i}`, code: `60000${i}`, name: `P${i}`,
    source: 'plan', note: 'x', addedOn: `2026-11-0${(i % 9) + 1}`, expireOn: '2026-11-30',
  }));
  const r = W.pruneList({ list: [manual, ...plans], today: TODAY });
  assert.strictEqual(r.keep.length, W.MAX_TOTAL);
  assert.strictEqual(r.removed.length, 1);
  assert.strictEqual(r.removed[0].code, '600000'); // addedOn 11-01 最老
  assert.ok(r.keep.some((w) => w.code === '600028'));
});

console.log('自选股 · 统计');

ok('统计区分手动与计划，识别临期', () => {
  const list = [
    item(),
    item({ secid: '1.601398', code: '601398', source: 'plan', note: 'x', expireOn: '2026-11-16' }),
    item({ secid: '1.600028', code: '600028', source: 'plan', note: 'x', expireOn: '2026-11-10' }),
  ];
  const s = W.stats(list, TODAY, HS);
  assert.strictEqual(s.total, 3);
  assert.strictEqual(s.manual, 1);
  assert.strictEqual(s.plan, 2);
  assert.strictEqual(s.expiring, 1);
});

console.log(`\n共 ${pass} 项通过`);
