/**
 * 计划 ↔ 条件单缺口审计用例 —— node test/audit.test.js
 * 纯函数，不碰 data/。
 *
 * 背景（2026-11-11）：观察池里 600900 写着「≤29.90 且 512890 失效时启用 400 股」，
 * 当天收 29.48 已跌穿买点、额度 15,009.30 全额空闲，但计划改挂 601318，长电根本没有条件单，
 * 到价接不到，此后涨到 30.51。这条规则就是为了让这种缺口机械地暴露出来。
 */
'use strict';
const assert = require('assert');

const A = require('../core/audit');

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

const cond = (over = {}) => ({
  id: 'C02',
  code: '601318',
  name: '中国平安',
  side: 'buy',
  status: 'active',
  expireOn: '2026-11-18',
  triggers: { price: { op: '<=', value: 52.8 } },
  note: '回踩中轨接首档',
  ...over,
});

console.log('计划价位提取');

ok('「≤29.90」直接取（高置信）', () => {
  const r = A.extractPlanPrice('备选：≤29.90 且 512890 失效时启用 400 股');
  assert.strictEqual(r.price, 29.9);
  assert.strictEqual(r.confidence, 'high');
});

ok('同时有「52.74 附近」和「（≤52.80）」→ 取 ≤ 那个', () => {
  const r = A.extractPlanPrice('回踩 MA20 52.74 附近（≤52.80）建首档，跌破 BOLL 下轨 50.23 证伪出池');
  assert.strictEqual(r.price, 52.8);
  assert.strictEqual(r.confidence, 'high');
});

ok('多个 ≤ 取最后一个（通常是括号里的最终判据）', () => {
  const r = A.extractPlanPrice('现价 54.1，先看 ≤53.5 试仓，主买点 ≤52.80');
  assert.strictEqual(r.price, 52.8);
});

ok('没有 ≤ 时退化为「x 附近」（低置信）', () => {
  const r = A.extractPlanPrice('周三：回踩 8.50 附近且 MACD 转正买 1,300 股');
  assert.strictEqual(r.price, 8.5);
  assert.strictEqual(r.confidence, 'low');
});

ok('只有「PE=7.6」这种等号不会被当成买点', () => {
  const r = A.extractPlanPrice('保险龙头 PE=7.6，逻辑看保费增速');
  assert.strictEqual(r.price, null);
});

ok('完全没有价位 → null', () => {
  assert.strictEqual(A.extractPlanPrice('512890 同类后备，止损出局时替补').price, null);
});

console.log('缺口审计 · 复现 11-11');

ok('600900 有买点却只有 601318 的条件单 → 报缺口', () => {
  const r = A.auditPlanGaps({
    watchlist: [
      { code: '600900', name: '长江电力', source: 'plan', note: '备选：≤29.90 且 512890 失效时启用 400 股', expireOn: '2026-11-16' },
      { code: '601318', name: '中国平安', source: 'plan', note: '回踩 MA20 附近（≤52.80）建首档', expireOn: '2026-11-18' },
    ],
    conds: { items: [cond()] },
    today: '2026-11-11',
    positions: [{ code: '512890', qty: 12000 }],
  });
  assert.strictEqual(r.ok, false);
  const g = r.gaps.find((x) => x.code === '600900');
  assert.ok(g, '长电必须被报出来');
  assert.strictEqual(g.kind, 'no-cond');
  assert.strictEqual(g.planPrice, 29.9);
  assert.strictEqual(r.covered.length, 1);
  assert.strictEqual(r.covered[0].code, '601318');
});

ok('补上 600900 的条件单后缺口消失', () => {
  const r = A.auditPlanGaps({
    watchlist: [
      { code: '600900', name: '长江电力', source: 'plan', note: '备选：≤29.90 且 512890 失效时启用 400 股', expireOn: '2026-11-16' },
      { code: '601318', name: '中国平安', source: 'plan', note: '回踩 MA20 附近（≤52.80）建首档', expireOn: '2026-11-18' },
    ],
    conds: {
      items: [
        cond(),
        cond({ id: 'C09', code: '600900', name: '长江电力', triggers: { price: { op: '<=', value: 29.9 } } }),
      ],
    },
    today: '2026-11-11',
    positions: [{ code: '512890', qty: 12000 }],
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.gaps.length, 0);
  assert.strictEqual(r.covered.length, 2);
});

console.log('缺口审计 · 容差与边界');

ok('挂单 52.90 对备注 52.80 算覆盖（1.5% 容差内的同档微调）', () => {
  const r = A.auditPlanGaps({
    watchlist: [{ code: '601318', name: '中国平安', source: 'plan', note: '≤52.80', expireOn: '2026-11-18' }],
    conds: { items: [cond({ triggers: { price: { op: '<=', value: 52.9 } } })] },
    today: '2026-11-17',
  });
  assert.strictEqual(r.ok, true);
});

ok('挂单 55.00 对备注 52.80 不算覆盖（那是摆设单，到价也接不到）', () => {
  const r = A.auditPlanGaps({
    watchlist: [{ code: '601318', name: '中国平安', source: 'plan', note: '≤52.80', expireOn: '2026-11-18' }],
    conds: { items: [cond({ triggers: { price: { op: '<=', value: 55 } } })] },
    today: '2026-11-17',
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.gaps[0].kind, 'no-cond');
});

ok('已过期（expireOn 早于今天）的计划项不审 —— 退役了就不该再要求有单', () => {
  const r = A.auditPlanGaps({
    watchlist: [{ code: '600900', name: '长江电力', source: 'plan', note: '≤29.90', expireOn: '2026-11-10' }],
    conds: { items: [] },
    today: '2026-11-17',
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.checked, 0);
});

ok('手动项（无 source=plan）不审 —— 那是收藏夹，不是计划', () => {
  const r = A.auditPlanGaps({
    watchlist: [{ code: '600519', name: '贵州茅台', note: '看着玩，≤1400 再说' }],
    conds: { items: [] },
    today: '2026-11-17',
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.checked, 0);
});

ok('计划项没写价位 → 单独报「计划不完整」', () => {
  const r = A.auditPlanGaps({
    watchlist: [{ code: '600900', name: '长江电力', source: 'plan', note: '观察一下电力板块', expireOn: '2026-11-20' }],
    conds: { items: [] },
    today: '2026-11-17',
  });
  assert.strictEqual(r.gaps[0].kind, 'no-price');
});

console.log('缺口审计 · 孤儿单');

ok('活跃买单的标的已不在观察池/持仓 → 孤儿单', () => {
  const r = A.auditPlanGaps({
    watchlist: [],
    conds: { items: [cond({ id: 'C07', code: '601398', name: '工商银行', triggers: { price: { op: '<=', value: 8.4 } } })] },
    today: '2026-11-17',
    positions: [{ code: '512890', qty: 12000 }],
  });
  assert.strictEqual(r.ok, false);
  const g = r.gaps.find((x) => x.kind === 'orphan-cond');
  assert.ok(g && g.code === '601398');
  assert.strictEqual(r.orphans.length, 1);
});

ok('活跃买单的标的已持仓 → 不是孤儿（加仓单是合法的）', () => {
  const r = A.auditPlanGaps({
    watchlist: [],
    conds: { items: [cond({ id: 'C07', code: '512890', triggers: { price: { op: '<=', value: 1.2 } } })] },
    today: '2026-11-17',
    positions: [{ code: '512890', qty: 12000 }],
  });
  assert.strictEqual(r.ok, true);
});

ok('已终结（fired/expired/cancelled）的条件单不参与匹配', () => {
  const r = A.auditPlanGaps({
    watchlist: [{ code: '601318', name: '中国平安', source: 'plan', note: '≤52.80', expireOn: '2026-11-18' }],
    conds: { items: [cond({ status: 'expired' })] },
    today: '2026-11-17',
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.gaps[0].kind, 'no-cond');
});

console.log(`\n通过：${pass} 项通过${process.exitCode ? '，有失败' : ''}\n`);
