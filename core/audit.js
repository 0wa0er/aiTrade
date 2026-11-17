'use strict';

/**
 * 计划 ↔ 条件单 的缺口审计 —— 纯函数
 *
 * 起因（2026-11-11）：观察池里 600900 长江电力的备注写着「≤29.90 且 512890 失效时启用 400 股」，
 * 当天收 29.48，价格已经跌穿买点，当日买入额度 15,009.30 一分未用、现金 35,187 够、持仓 1/3 只，
 * 所有闸门全开 —— 但计划当天改成了「只挂一张 601318」，长江电力**根本没有对应条件单**。
 * 结果价格到了没人接，此后一路涨到 30.51。
 *
 * 所以规则改成：**计划里写了价位，就必须有对应的活跃条件单；没有等于计划未生效。**
 * 本模块负责把这种缺口机械地找出来，不依赖人的记性。
 *
 * 口径：
 *   - 只看 watchlist 里 source='plan' 且未过期的条目（expireOn >= today；手动项不审，那是收藏夹不是计划）
 *   - 备注里取「≤ x」优先（多个取最后一个，通常括号里那个才是最终判据）；
 *     没有 ≤ 时退化为「x 附近」，置信度标 low
 *   - 条件单要求：status='active' 且 side='buy' 且代码匹配，触发价不高于备注价位 × (1 + tol)
 *   - tol 默认 1.5%：允许「备注 ≤52.80、挂单 52.90」这种同档微调，但不接受差 3% 以上的摆设单
 */

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

const RE_LE = /(?:≤|<=)\s*(\d+(?:\.\d+)?)/g;
const RE_NEAR = /(\d+(?:\.\d+)?)\s*附近/g;

/**
 * 从自由文本里提取「买点价位」。
 * @returns {{price:number|null, confidence:'high'|'low', raw:string}}
 */
function extractPlanPrice(note) {
  const text = String(note || '');
  const le = [];
  let m;
  RE_LE.lastIndex = 0;
  while ((m = RE_LE.exec(text))) le.push({ price: num(m[1]), raw: m[0] });
  if (le.length) {
    const pick = le[le.length - 1];
    return { price: pick.price > 0 ? pick.price : null, confidence: 'high', raw: pick.raw };
  }
  const near = [];
  RE_NEAR.lastIndex = 0;
  while ((m = RE_NEAR.exec(text))) near.push({ price: num(m[1]), raw: m[0] });
  if (near.length) {
    const pick = near[0];
    return { price: pick.price > 0 ? pick.price : null, confidence: 'low', raw: pick.raw };
  }
  return { price: null, confidence: 'low', raw: '' };
}

function activeBuyConds(conds) {
  const items = (conds && conds.items) || [];
  return items.filter((c) => c && c.status === 'active' && c.side === 'buy');
}

function triggerPriceOf(cond) {
  const p = cond && cond.triggers && cond.triggers.price;
  return p ? num(p.value) : null;
}

/**
 * @param {object} input
 * @param {Array}  input.watchlist  观察池（含 code/name/note/source/expireOn）
 * @param {object} input.conds      data/cond.json 的完整对象
 * @param {string} input.today      YYYY-MM-DD
 * @param {Array}  [input.positions] 持仓（用于判断孤儿单）
 * @param {number} [input.tol]      价位容差，默认 0.015
 * @returns {{ok:boolean, gaps:Array, orphans:Array, covered:Array, checked:number}}
 */
function auditPlanGaps({ watchlist, conds, today, positions = [], tol = 0.015 } = {}) {
  const list = Array.isArray(watchlist) ? watchlist : [];
  const buys = activeBuyConds(conds);
  const held = new Set((positions || []).map((p) => String(p.code)));
  const pool = new Set(list.map((w) => String(w.code)));

  const gaps = [];
  const covered = [];
  let checked = 0;

  for (const w of list) {
    if (w.source !== 'plan') continue;
    const exp = String(w.expireOn || '');
    if (exp && exp < String(today)) continue;
    checked += 1;

    const { price, confidence, raw } = extractPlanPrice(w.note);
    if (!price) {
      gaps.push({
        code: w.code,
        name: w.name,
        kind: 'no-price',
        planPrice: null,
        reason: '计划项没写买点价位，无法挂条件单（计划不完整）',
        note: w.note || '',
      });
      continue;
    }

    const hit = buys
      .filter((c) => String(c.code) === String(w.code))
      .map((c) => ({ cond: c, trig: triggerPriceOf(c) }))
      .filter((x) => x.trig != null && x.trig <= price * (1 + tol))
      .sort((a, b) => Math.abs(a.trig - price) - Math.abs(b.trig - price))[0];

    if (hit) {
      covered.push({
        code: w.code,
        name: w.name,
        planPrice: price,
        condId: hit.cond.id,
        trigPrice: hit.trig,
        confidence,
        note: `备注「${raw}」→ ${hit.cond.id} 触发价 ${hit.trig}`,
      });
    } else {
      gaps.push({
        code: w.code,
        name: w.name,
        kind: 'no-cond',
        planPrice: price,
        planRaw: raw,
        confidence,
        reason: `计划买点 ${price} 已写明，但没有 ≤ ${round2(price * (1 + tol))} 的活跃买单 —— 到价也接不到`,
        note: w.note || '',
      });
    }
  }

  // 孤儿单：有活跃买单，但标的既不在观察池、也不在持仓（多半是计划改向后的遗留）
  for (const c of buys) {
    const code = String(c.code);
    if (pool.has(code) || held.has(code)) continue;
    const exp = String(c.expireOn || '');
    if (exp && exp < String(today)) continue;
    gaps.push({
      code,
      name: c.name || code,
      kind: 'orphan-cond',
      planPrice: triggerPriceOf(c),
      reason: `活跃买单 ${c.id} 的标的已不在观察池/持仓，计划改向后未撤单`,
      note: c.note || '',
    });
  }

  return { ok: gaps.length === 0, gaps, orphans: gaps.filter((g) => g.kind === 'orphan-cond'), covered, checked };
}

function round2(v) {
  return Math.round(num(v) * 100) / 100;
}

module.exports = { auditPlanGaps, extractPlanPrice };
