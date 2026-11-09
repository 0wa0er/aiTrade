'use strict';
/**
 * 自选股生命周期（观察池的进入 / 退出）
 *
 * 设计前提：自选股不是「候选池」，是「待观察清单」。
 * 一个标的进来自动就会产生注意力成本，所以进场要有闸门、要有理由、要有期限；
 * 到期自动退场，不需要人去记得删。降噪靠四条：
 *   ① 计划来源必须写一句理由（--note），没理由的不进；
 *   ② 计划观察位与总数都有上限，满了就淘汰最老的，不是无限膨胀；
 *   ③ 观察期按交易日计（默认 5 日），到期自动退役；
 *   ④ 重复添加是幂等刷新，不产生第二条、不报错。
 *
 * 关键约束：手动加的（source=manual，含历史遗留无 source 的）永不自动删，
 * 只有 source=plan 的才会被 prune 退役。用户的清单归用户。
 */

const R = require('./rules');

const DEFAULT_TTL = 5; // 观察期（交易日）
const MAX_TOTAL = 12; // 自选股总数上限
const MAX_PLAN = 4; // 计划观察位上限（计划最多 3 只候选，留 1 个缓冲）
const MAX_TTL = 20;
const MAX_TTL_LIMIT = 20;

function clampInt(v, lo, hi, dflt) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
}

function normDateKey(s) {
  const str = String(s || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) return '';
  return str;
}

function dayOf(key) {
  const k = normDateKey(key);
  return k ? new Date(`${k}T00:00:00`) : new Date();
}

/** 从某天起数第 n 个交易日（不含当天），返回 YYYY-MM-DD */
function addTradingDays(fromKey, n, holidays = new Set()) {
  const base = dayOf(fromKey);
  const steps = Math.floor(Number(n));
  if (!(steps > 0)) return R.fmtDate(base);
  return R.nextTradingDateKey(base, holidays, steps);
}

/** 还剩几个交易日（0 = 今天到期，负数 = 已过期）；无到期日的返回 null */
function daysLeft(item, todayKey, holidays = new Set()) {
  const exp = normDateKey(item && item.expireOn);
  if (!exp) return null;
  const today = normDateKey(todayKey) || R.fmtDate(new Date());
  if (exp <= today) return 0;
  return Math.max(0, R.countTradingDays(dayOf(today), dayOf(exp), holidays) - 1);
}

function isExpired(item, todayKey) {
  const exp = normDateKey(item && item.expireOn);
  if (!exp) return false;
  const today = normDateKey(todayKey) || R.fmtDate(new Date());
  return exp < today;
}

/** 补齐生命周期字段；历史条目（无 source）一律视为 manual，不设到期日 */
function normalize(raw = {}, ctx = {}) {
  const today = normDateKey(ctx.today) || R.fmtDate(new Date());
  const holidays = ctx.holidays || new Set();
  const source = raw.source === 'plan' ? 'plan' : 'manual';
  const ttlDays = clampInt(raw.ttlDays, 1, MAX_TTL, DEFAULT_TTL);
  const addedOn = normDateKey(raw.addedOn) || today;
  const expireOn =
    normDateKey(raw.expireOn) || (source === 'plan' ? addTradingDays(addedOn, ttlDays, holidays) : '');
  return {
    secid: String(raw.secid || ''),
    code: String(raw.code || ''),
    name: String(raw.name || ''),
    type: raw.type || 'stock',
    source,
    addedOn,
    ttlDays,
    expireOn,
    note: String(raw.note || ''),
  };
}

/**
 * 进场判定。返回 { action: 'add' | 'refresh' | 'reject', item, reason }
 * limits: { maxTotal, maxPlan, maxSingleValue, oneLotValue }
 */
function decideAdd({ raw = {}, list = [], today, holidays = new Set(), limits = {} }) {
  const it = normalize(raw, { today, holidays });
  if (!/^\d{6}$/.test(it.code) || !it.secid) {
    return { action: 'reject', reason: '代码无效（需 6 位数字且能推导出 secid）' };
  }

  const exist = list.find((w) => w.secid === it.secid);
  if (exist) {
    const merged = { ...exist };
    if (it.note) merged.note = it.note;
    // 只有计划来源才顺延观察期；手动加的没有期限，别替用户设
    if ((exist.source || 'manual') === 'plan') {
      merged.ttlDays = it.ttlDays;
      merged.addedOn = it.addedOn;
      merged.expireOn = it.expireOn;
    }
    return { action: 'refresh', item: merged, reason: '已在自选，已刷新观察期' };
  }

  if (it.source === 'plan' && !it.note) {
    return { action: 'reject', reason: '计划观察必须写一句理由（--note "为什么盯它"），没理由不入池' };
  }

  const maxTotal = clampInt(limits.maxTotal, 1, 50, MAX_TOTAL);
  if (list.length >= maxTotal) {
    return {
      action: 'reject',
      reason: `自选股已满 ${maxTotal} 只，先 node cli.js watch prune 或 watch rm 腾位`,
    };
  }

  const maxPlan = clampInt(limits.maxPlan, 1, 20, MAX_PLAN);
  const planCount = list.filter((w) => (w.source || 'manual') === 'plan').length;
  if (it.source === 'plan' && planCount >= maxPlan) {
    return { action: 'reject', reason: `计划观察位已满 ${maxPlan} 只，先 prune 或手动退役一只` };
  }

  const oneLot = Number(limits.oneLotValue);
  const cap = Number(limits.maxSingleValue);
  if (Number.isFinite(oneLot) && Number.isFinite(cap) && cap > 0 && oneLot > cap) {
    return {
      action: 'reject',
      reason: `一手约 ${Math.round(oneLot)} 元，超过单票上限 ${Math.round(cap)} 元——买不了的标的别占观察位`,
    };
  }

  return { action: 'add', item: it, reason: '已加入自选' };
}

/**
 * 退场判定。只退役 source=plan 的条目：
 *   ① 已建仓 → 移出（持仓区已经在跟踪，留着是重复占位）
 *   ② 观察期满 → 移出
 *   ③ 超出总数上限 → 淘汰最久未更新的计划条目（手动的不动）
 * 返回 { keep, removed: [{ secid, code, name, reason }] }
 */
function pruneList({ list = [], today, holdings = [], limits = {} }) {
  const todayKey = normDateKey(today) || R.fmtDate(new Date());
  const hold = new Set((holdings || []).map(String));
  const keep = [];
  const removed = [];

  for (const w of list) {
    const src = w.source || 'manual';
    if (src !== 'plan') {
      keep.push(w);
      continue;
    }
    if (hold.has(String(w.code))) {
      removed.push({ secid: w.secid, code: w.code, name: w.name, reason: '已建仓，转由持仓区跟踪' });
      continue;
    }
    if (isExpired(w, todayKey)) {
      removed.push({ secid: w.secid, code: w.code, name: w.name, reason: `观察期满（${w.expireOn}）` });
      continue;
    }
    keep.push(w);
  }

  const maxTotal = clampInt(limits.maxTotal, 1, 50, MAX_TOTAL);
  if (keep.length > maxTotal) {
    const overflow = keep.length - maxTotal;
    const planItems = keep
      .filter((w) => (w.source || 'manual') === 'plan')
      .sort((a, b) => String(a.addedOn || '').localeCompare(String(b.addedOn || '')));
    const kill = new Set(planItems.slice(0, overflow).map((w) => w.secid));
    for (let i = keep.length - 1; i >= 0; i--) {
      if (kill.has(keep[i].secid)) {
        removed.push({ secid: keep[i].secid, code: keep[i].code, name: keep[i].name, reason: '超出上限，淘汰最久未更新' });
        keep.splice(i, 1);
      }
    }
  }

  return { keep, removed };
}

/** 清单统计，供 CLI 表头展示 */
function stats(list = [], today, holidays = new Set()) {
  const todayKey = normDateKey(today) || R.fmtDate(new Date());
  let plan = 0;
  let manual = 0;
  let expiring = 0;
  for (const w of list) {
    if ((w.source || 'manual') === 'plan') {
      plan += 1;
      const left = daysLeft(w, todayKey, holidays);
      if (left != null && left <= 1) expiring += 1;
    } else {
      manual += 1;
    }
  }
  return { total: list.length, plan, manual, expiring, maxTotal: MAX_TOTAL, maxPlan: MAX_PLAN };
}

module.exports = {
  DEFAULT_TTL,
  MAX_TOTAL,
  MAX_PLAN,
  MAX_TTL_LIMIT,
  addTradingDays,
  daysLeft,
  isExpired,
  normalize,
  decideAdd,
  pruneList,
  stats,
};
