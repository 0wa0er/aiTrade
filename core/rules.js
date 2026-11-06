'use strict';

/**
 * A 股真实交易规则层（纯函数，无副作用、无 IO、无内部状态）
 *
 * 口径来源：沪深交易所交易规则（2023 全面注册制后）、北交所交易规则、
 * 证券交易印花税（2023-08-28 起单边千 0.5）、登记结算收费（过户费万 0.1 双向）。
 *
 * 本模块只回答"规则是什么"，不负责撮合与记账。
 */

const pad = (n) => String(n).padStart(2, '0');
const fmtDate = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// ---------------- 交易日历 ----------------

function isTradingDay(d, holidays = new Set()) {
  const w = d.getDay();
  if (w === 0 || w === 6) return false;
  return !holidays.has(fmtDate(d));
}

/** 当前所属交易日：开盘前（09:15 之前）归上一交易日 */
function tradingDateKey(now = new Date(), holidays = new Set()) {
  const seconds = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
  if (isTradingDay(now, holidays) && seconds >= 9 * 3600 + 15 * 60) return fmtDate(now);
  for (let i = 1; i <= 20; i++) {
    const p = new Date(now.getTime() - i * 86400000);
    if (isTradingDay(p, holidays)) return fmtDate(p);
  }
  return fmtDate(now);
}

function nextTradingDateKey(now = new Date(), holidays = new Set(), skip = 1) {
  let found = 0;
  for (let i = 1; i <= 40; i++) {
    const p = new Date(now.getTime() + i * 86400000);
    if (isTradingDay(p, holidays)) {
      found += 1;
      if (found >= skip) return fmtDate(p);
    }
  }
  return fmtDate(now);
}

/** 计算 from 到 to（含两端）之间的交易日数量，用于"上市第 N 个交易日"判定 */
function countTradingDays(from, to, holidays = new Set()) {
  if (!from) return Infinity;
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const end = new Date(to.getFullYear(), to.getMonth(), to.getDate());
  let n = 0;
  let guard = 0;
  while (d <= end && guard++ < 400) {
    if (isTradingDay(d, holidays)) n += 1;
    d.setDate(d.getDate() + 1);
  }
  return n;
}

// ---------------- 交易时段 ----------------

const H = (h, m) => h * 3600 + m * 60;

/**
 * 沪深 A 股真实时段划分。
 * - 09:15-09:20 开盘集合竞价（可申报、可撤单）
 * - 09:20-09:25 开盘集合竞价（可申报、不可撤单）
 * - 09:25-09:30 竞价结束、连续竞价尚未开始（交易所不接受申报）
 * - 09:30-11:30 连续竞价
 * - 11:30-13:00 午间休市（交易所不接受申报）
 * - 13:00-14:57 连续竞价
 * - 14:57-15:00 收盘集合竞价（可申报、不可撤单）
 * - 15:00-15:05 收盘后（不接受申报）
 * - 15:05-15:30 盘后固定价格交易（仅科创板 / 创业板）
 *
 * @returns {{code:string,label:string,accept:boolean,cancelable:boolean,
 *            phase:'auction_open'|'continuous'|'auction_close'|null,
 *            matching:boolean, afterHours:boolean}}
 */
function sessionState(now = new Date(), holidays = new Set()) {
  if (!isTradingDay(now, holidays)) {
    return {
      code: 'holiday',
      label: '休市',
      accept: false,
      cancelable: false,
      phase: null,
      matching: false,
      afterHours: false,
    };
  }
  const s = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();

  if (s < H(9, 15)) return mk('pre', '盘前', false, false, null, false);
  if (s < H(9, 20)) return mk('auction', '开盘集合竞价', true, true, 'auction_open', true);
  if (s < H(9, 25)) return mk('auction_lock', '开盘集合竞价(不可撤)', true, false, 'auction_open', true);
  // 09:25-09:30 交易所不接受申报，但券商可接收客户委托暂存，09:30 起进入连续竞价
  if (s < H(9, 30)) return mk('pre_open', '待开盘', true, true, 'continuous', false);
  if (s < H(11, 30)) return mk('open', '交易中', true, true, 'continuous', true);
  if (s < H(13, 0)) return mk('lunch', '午间休市', false, false, null, false);
  if (s < H(14, 57)) return mk('open', '交易中', true, true, 'continuous', true);
  if (s < H(15, 0)) return mk('close_auction', '收盘集合竞价(不可撤)', true, false, 'auction_close', true);
  if (s < H(15, 5)) return mk('closed', '已收盘', false, false, null, false);
  if (s < H(15, 30)) {
    const st = mk('after_hours', '盘后固定价格', true, false, null, false);
    st.afterHours = true;
    return st;
  }
  return mk('closed', '已收盘', false, false, null, false);
}

function mk(code, label, accept, cancelable, phase, matching) {
  return { code, label, accept, cancelable, phase, matching, afterHours: false };
}

/** 是否处于可以立即撮合的连续竞价窗口 */
function isContinuous(now, holidays) {
  return sessionState(now, holidays).phase === 'continuous';
}

// ---------------- 板块与交易单位 ----------------

/**
 * 判断标的所属板块。
 * @param {string} code 6 位代码
 * @param {string} [type] 前端识别的类型 stock/etf/fund/index
 */
function boardOf(code, type) {
  const c = String(code || '');
  if (type === 'etf') return 'etf';
  if (type === 'fund') return 'fund';
  if (/^(688|689)/.test(c)) return 'star';      // 科创板
  if (/^(300|301)/.test(c)) return 'gem';       // 创业板
  if (/^(4|8|92)/.test(c)) return 'bse';        // 北交所
  if (/^(5|1[5-9]|16|18)/.test(c)) return 'etf'; // 场内基金（未显式声明 type 时兜底）
  return 'main';
}

/**
 * 交易单位。
 * - 沪深主板 / 创业板 / 场内基金：买入 100 股（份）整数倍
 * - 科创板：买入 200 股起，1 股递增
 * - 北交所：买入 100 股起，1 股递增
 * 卖出时余额不足最小单位的零股必须一次性申报卖出（由调用方判定）。
 */
function lotOf(code, type) {
  const b = boardOf(code, type);
  if (b === 'star') return { board: b, buyMin: 200, step: 1, unit: 100 };
  if (b === 'bse') return { board: b, buyMin: 100, step: 1, unit: 100 };
  if (b === 'fund') return { board: b, buyMin: 1, step: 0.01, unit: 1 };
  return { board: b, buyMin: 100, step: 100, unit: 100 };
}

/** 最小价格变动单位 */
function tickOf(code, type) {
  const b = boardOf(code, type);
  if (b === 'fund') return 0.0001;
  if (b === 'etf') return 0.001;
  return 0.01;
}

// ---------------- 涨跌幅限制 ----------------

/**
 * 涨跌幅限制。
 * - 主板 10%，创业板 / 科创板 20%，北交所 30%
 * - 主板 ST / *ST 5%（创业板、科创板 ST 仍为 20%）
 * - 场内基金 10%
 * - 新股上市后前 5 个交易日不设涨跌幅限制
 */
function priceLimit({ code, name, type, preClose, listDate, now = new Date(), holidays = new Set() }) {
  const board = boardOf(code, type);
  if (!(preClose > 0)) return { rate: null, up: null, down: null, unlimited: false, board, reason: '缺少昨收价' };

  if (board !== 'fund' && listDate) {
    const dayNo = countTradingDays(listDate, now, holidays);
    if (dayNo > 0 && dayNo <= 5) {
      return {
        rate: null,
        up: null,
        down: null,
        unlimited: true,
        board,
        listDay: dayNo,
        reason: `新股上市第 ${dayNo} 个交易日，不设涨跌幅限制`,
      };
    }
  }

  let rate;
  if (board === 'bse') rate = 0.3;
  else if (board === 'star' || board === 'gem') rate = 0.2;
  else if (board === 'etf' || board === 'fund') rate = 0.1;
  else rate = /(^|\*)ST/i.test(String(name || '')) ? 0.05 : 0.1;

  const tick = tickOf(code, type);
  // 交易所口径：涨跌停价 = 前收盘 ×(1±比例)，四舍五入至最小价格变动单位
  return {
    rate,
    up: roundTick(preClose * (1 + rate), tick, 'half'),
    down: roundTick(preClose * (1 - rate), tick, 'half'),
    unlimited: false,
    board,
    reason: `${(rate * 100).toFixed(0)}% 涨跌幅限制`,
  };
}

function roundTick(v, tick, mode = 'half') {
  const digits = tick === 0.01 ? 2 : tick === 0.001 ? 3 : 4;
  const scaled = v / tick;
  const n = mode === 'down' ? Math.floor(scaled + 1e-9) : mode === 'up' ? Math.ceil(scaled - 1e-9) : Math.round(scaled);
  return Number((n * tick).toFixed(digits));
}

// ---------------- 价格笼子（连续竞价限价申报有效价格范围） ----------------

/**
 * 全面注册制后，沪深主板 / 创业板 / 科创板连续竞价阶段限价申报需满足：
 * - 买入申报价 ≤ 买入基准价 × 102% 与 买入基准价 + 0.1 元 的孰高值
 * - 卖出申报价 ≥ 卖出基准价 × 98% 与 卖出基准价 − 0.1 元 的孰低值
 * 基准价取即时揭示的最优对手价，无对手价时取最新成交价。
 *
 * 超出范围 -> 交易所废单。
 */
function priceCage({ side, last, bid1, ask1, tick = 0.01 }) {
  const base = side === 'buy' ? ask1 || last : bid1 || last;
  if (!(base > 0)) return null;
  const pct = 0.02;
  if (side === 'buy') {
    const hi1 = base * (1 + pct);
    const hi2 = base + 10 * tick;
    return { min: 0, max: roundTick(Math.max(hi1, hi2), tick, 'down'), base };
  }
  const lo1 = base * (1 - pct);
  const lo2 = base - 10 * tick;
  return { min: roundTick(Math.min(lo1, lo2), tick, 'up'), max: Infinity, base };
}

// ---------------- 费用 ----------------

const DEFAULT_FEES = {
  // 佣金：默认万 2.5，单笔最低 5 元。按你的实际券商费率改这里即可。
  commissionRate: 0.00025,
  commissionMin: 5,
  etfCommissionRate: 0.00025,
  etfCommissionMin: 5,
  // 印花税：2023-08-28 起 0.05%，仅股票卖出单边征收，场内基金免征
  stampRate: 0.0005,
  // 过户费：成交金额的 0.001%，沪深 A 股双向收取，场内基金不收
  transferRate: 0.00001,
  // 场外基金申购费（打折后）
  fundBuyFee: 0.0015,
  // 场外基金赎回费：按持有期阶梯（真实按基金合同，此处给通用默认）
  fundRedeemTiers: [
    { maxDays: 7, rate: 0.015 },
    { maxDays: 365, rate: 0.005 },
    { maxDays: 730, rate: 0.0025 },
    { maxDays: Infinity, rate: 0 },
  ],
  // 股息红利差别化个税：持股 1 个月内 20%，1 个月至 1 年 10%，超 1 年免征
  dividendTaxTiers: [
    { maxDays: 30, rate: 0.2 },
    { maxDays: 365, rate: 0.1 },
    { maxDays: Infinity, rate: 0 },
  ],
};

const round2 = (v) => Math.round(v * 100) / 100;

/** 股票 / 场内基金费用。amount 为成交金额，side 为 buy/sell */
function stockFee(amount, side, isEtf, cfg = DEFAULT_FEES) {
  if (!(amount > 0)) return { commission: 0, transfer: 0, stamp: 0, total: 0 };
  const rate = isEtf ? cfg.etfCommissionRate : cfg.commissionRate;
  const minFee = isEtf ? cfg.etfCommissionMin : cfg.commissionMin;
  const commission = round2(Math.max(amount * rate, minFee));
  const transfer = isEtf ? 0 : round2(amount * cfg.transferRate);
  const stamp = !isEtf && side === 'sell' ? round2(amount * cfg.stampRate) : 0;
  return { commission, transfer, stamp, total: round2(commission + transfer + stamp) };
}

/** 场外基金赎回费率（按持有天数） */
function fundRedeemRate(holdDays, cfg = DEFAULT_FEES) {
  const tiers = cfg.fundRedeemTiers || DEFAULT_FEES.fundRedeemTiers;
  for (const t of tiers) if (holdDays <= t.maxDays) return t.rate;
  return 0;
}

/** 股息红利个税税率（按持有天数） */
function dividendTaxRate(holdDays, cfg = DEFAULT_FEES) {
  const tiers = cfg.dividendTaxTiers || DEFAULT_FEES.dividendTaxTiers;
  for (const t of tiers) if (holdDays <= t.maxDays) return t.rate;
  return 0;
}

// ---------------- 基金确认日 ----------------

/**
 * 场外基金申赎：T 日 15:00 前视为当日申请，之后顺延至下一交易日。
 * 货币基金 T+1 确认，股票型 / 混合型一般 T+1 确认、T+2 至 T+7 到账。
 */
function fundApplyDate(now = new Date(), holidays = new Set()) {
  const s = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
  const todayIsTrading = isTradingDay(now, holidays);
  if (todayIsTrading && s < H(15, 0)) return { applyDate: fmtDate(now), effectiveToday: true };
  return { applyDate: nextTradingDateKey(now, holidays, 1), effectiveToday: false };
}

module.exports = {
  fmtDate,
  isTradingDay,
  tradingDateKey,
  nextTradingDateKey,
  countTradingDays,
  sessionState,
  isContinuous,
  boardOf,
  lotOf,
  tickOf,
  priceLimit,
  priceCage,
  roundTick,
  DEFAULT_FEES,
  stockFee,
  fundRedeemRate,
  dividendTaxRate,
  fundApplyDate,
};
