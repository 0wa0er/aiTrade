/**
 * 区间触发器用例 —— node test/bands.test.js
 * 只测纯逻辑与文件读写，不碰真实 data/（用 TD_DATA_DIR 隔离到临时目录）
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'td-bands-'));
process.env.TD_DATA_DIR = TMP;

const B = require('../core/bands');

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

const band = (over = {}) => B.normalizeBand({ code: '512890', lower: 1.225, upper: 1.245, ...over });
const at = (h, m) => new Date(2026, 10, 9, h, m, 0);

console.log('区间判定');

ok('上破穿越才触发', () => {
  const b = band();
  const r1 = B.evaluate(b, { prevPrice: 1.24, armed: true }, 1.24);
  assert.strictEqual(r1.fire, null);
  const r2 = B.evaluate(b, { prevPrice: 1.24, armed: true }, 1.246);
  assert.strictEqual(r2.fire, 'upper');
  assert.strictEqual(r2.suppressed, false);
  assert.strictEqual(r2.state.armed, false);
});

ok('区间内震荡不触发', () => {
  const b = band();
  for (const px of [1.226, 1.23, 1.24, 1.2449]) {
    assert.strictEqual(B.evaluate(b, { prevPrice: 1.23, armed: true }, px).fire, null, String(px));
  }
});

ok('下破穿越才触发', () => {
  const b = band();
  assert.strictEqual(B.evaluate(b, { prevPrice: 1.23, armed: true }, 1.23).fire, null);
  const r = B.evaluate(b, { prevPrice: 1.23, armed: true }, 1.224);
  assert.strictEqual(r.fire, 'lower');
});

ok('首次观测已在区间外也报（启动即异位）', () => {
  const b = band();
  const r = B.evaluate(b, { armed: true }, 1.30);
  assert.strictEqual(r.fire, 'upper');
});

ok('触发后不重复报，需回位才重新武装', () => {
  const b = band();
  let st = { prevPrice: 1.24, armed: true };
  let r = B.evaluate(b, st, 1.25, at(10, 0));
  assert.strictEqual(r.fire, 'upper');
  st = r.state;
  // 继续在上轨上方晃动：不再触发
  r = B.evaluate(b, st, 1.26, at(10, 1));
  assert.strictEqual(r.fire, null);
  assert.strictEqual(r.armed, false);
  // 回落到缓冲带内（1.245*(1-0.3%)=1.2413 以下）才重新武装
  r = B.evaluate(b, st, 1.24, at(10, 2));
  assert.strictEqual(r.fire, null);
  assert.strictEqual(r.armed, true);
  // 再上破，冷却期内被抑制
  r = B.evaluate(b, r.state, 1.25, at(10, 3));
  assert.strictEqual(r.fire, 'upper');
  assert.strictEqual(r.suppressed, true);
});

ok('冷却期外可再次触发', () => {
  const b = band({ cooldownMin: 5 });
  let r = B.evaluate(b, { prevPrice: 1.24, armed: true }, 1.25, at(10, 0));
  assert.strictEqual(r.suppressed, false);
  let st = B.evaluate(b, r.state, 1.23, at(10, 2)).state; // 回位重新武装
  st = { ...st, prevPrice: 1.24, armed: true };
  r = B.evaluate(b, st, 1.25, at(10, 10));
  assert.strictEqual(r.fire, 'upper');
  assert.strictEqual(r.suppressed, false);
});

ok('停用的区间一律不触发', () => {
  const b = band({ enabled: false });
  assert.strictEqual(B.evaluate(b, { prevPrice: 1.2, armed: true }, 1.3).fire, null);
});

ok('只设单边也能工作', () => {
  const onlyUp = band({ lower: null });
  assert.strictEqual(B.evaluate(onlyUp, { prevPrice: 1.24, armed: true }, 1.25).fire, 'upper');
  const onlyDown = band({ upper: null });
  assert.strictEqual(B.evaluate(onlyDown, { prevPrice: 1.23, armed: true }, 1.22).fire, 'lower');
});

console.log('批量判定');

ok('evaluateAll 跳过无行情的标的并累加当日计数', () => {
  const cfg = { bands: [band(), band({ code: '600900', lower: 29, upper: 29.9 })] };
  const st = B.loadState();
  const priceMap = new Map([
    ['512890', { code: '512890', price: 1.25 }],
    ['1.600900', { code: '600900', price: 29.95 }],
    ['000001', { code: '000001', price: 1 }],
  ]);
  const fired = B.evaluateAll(cfg, st, priceMap, at(10, 0));
  assert.strictEqual(fired.length, 2);
  assert.strictEqual(st.firedToday, 2);
  const fired2 = B.evaluateAll(cfg, st, priceMap, at(10, 1));
  assert.strictEqual(fired2.length, 0, '已 disarm，不应重复触发');
});

ok('evaluateAll 缺价标的不影响其他标的', () => {
  const cfg = { bands: [band(), band({ code: '600900', lower: 29, upper: 29.9 })] };
  const st = { bands: {}, seq: 0, day: '', firedToday: 0 };
  const fired = B.evaluateAll(cfg, st, new Map([['512890', { price: 1.25 }]]), at(10, 0));
  assert.strictEqual(fired.length, 1);
  assert.strictEqual(fired[0].band.code, '512890');
});

console.log('配置与告警');

ok('secid 推导', () => {
  assert.strictEqual(B.secidOf('600900'), '1.600900');
  assert.strictEqual(B.secidOf('000001'), '0.000001');
  assert.strictEqual(B.secidOf('512890'), '1.512890');
  assert.strictEqual(B.secidOf('159915'), '0.159915');
  assert.strictEqual(B.secidOf('000001', 'index'), '1.000001');
  assert.strictEqual(B.secidOf('399001', 'index'), '0.399001');
  assert.throws(() => B.secidOf('abc'));
});

ok('参数校验：上下轨至少一个、上轨必须高于下轨', () => {
  assert.throws(() => B.normalizeBand({ code: '512890' }), /至少设一个/);
  assert.throws(() => B.normalizeBand({ code: '512890', lower: 10, upper: 5 }), /必须高于/);
  assert.throws(() => B.normalizeBand({ code: '51289' }));
});

ok('新增 / 覆盖 / 删除', () => {
  const a = B.upsertBand({ code: '512890', name: '红利低波ETF', type: 'etf', lower: 1.225, upper: 1.245, action: 'analyze' });
  assert.ok(a.id);
  assert.strictEqual(B.loadConfig().bands.length, 1);
  const b = B.upsertBand({ code: '512890', lower: 1.22, upper: 1.25 });
  assert.strictEqual(b.id, a.id, '同标的不应新增第二条');
  assert.strictEqual(B.loadConfig().bands.length, 1);
  assert.strictEqual(B.loadConfig().bands[0].lower, 1.22);
  assert.strictEqual(B.removeBand(a.id), true);
  assert.strictEqual(B.loadConfig().bands.length, 0);
});

ok('改区间会重置武装状态', () => {
  const a = B.upsertBand({ code: '512890', lower: 1.2, upper: 1.3 });
  const st = B.loadState();
  st.bands[a.id] = { armed: false, side: 'upper', prevPrice: 1.31 };
  B.saveState(st);
  B.upsertBand({ code: '512890', lower: 1.25, upper: 1.35 });
  assert.strictEqual(B.loadState().bands[a.id], undefined);
});

ok('告警入队 / 待处理过滤 / 确认', () => {
  const b = band({ id: 'B01' });
  const it = B.pushAlert({ band: b, side: 'lower', price: 1.224, at: at(10, 30) });
  assert.strictEqual(it.id, 'A0001');
  assert.strictEqual(it.status, 'pending');
  assert.strictEqual(B.pendingAlerts().length, 1);
  assert.strictEqual(B.pendingAlerts('2026-11-09').length, 1);
  assert.strictEqual(B.pendingAlerts('2026-11-10').length, 0);
  B.ackAlert(it.id, { by: '测试', note: '已核对' });
  assert.strictEqual(B.pendingAlerts().length, 0);
  assert.strictEqual(B.loadAlerts().items[0].result, '已核对');
});

ok('告警文案包含方向与价位', () => {
  const it = B.pushAlert({ band: band({ id: 'B02' }), side: 'upper', price: 1.25, at: at(11, 0) });
  const t = B.alertText(it);
  assert.ok(t.includes('上破'), t);
  assert.ok(t.includes('1.245'), t);
});

ok('提示词占位符替换', () => {
  const b = band({ id: 'B01', name: '红利低波ETF' });
  const p = B.buildPrompt('{name} {code} {price} {upper} {lower} {sideText} {alertId}', b, {
    side: 'lower',
    price: 1.22,
    id: 'A0009',
  });
  assert.ok(p.includes('红利低波ETF') && p.includes('512890') && p.includes('1.22'), p);
  assert.ok(p.includes('已跌破区间下轨 1.225'), p);
  assert.ok(p.includes('A0009'), p);
});

console.log(`\n带宽 ${pass} 项通过`);
if (process.exitCode) console.log('有失败用例');
fs.rmSync(TMP, { recursive: true, force: true });
