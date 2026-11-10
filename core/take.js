'use strict';
/**
 * 移动止盈（trailing take-profit）的纯逻辑 —— 只算价、只出结论，不碰网络、不碰文件。
 *
 * 为什么要有这一层：
 * core/live.js 的 take 判据是「当日最高曾达成本 +15% 且自当日高点回落 3%」，
 * 它有三个致命问题，实测对 512890 这类宽基/红利 ETF 是**永不触发的死规则**：
 *   1) high 取的是**当日**最高（行情快照 f15），跨日不累积 —— 要求同一天内先涨 15% 再回落 3%；
 *   2) 近 250 个交易日 512890 单日涨幅 ≥5% 出现 0 次（最大 +3.23%），+15% 在数学上不可能；
 *   3) 只告警不执行，人不在屏幕前就等于没有。
 * 所以止盈必须换一套判据：以「持仓期最高价」为锚的移动止盈，且固化成条件单，触发即执行。
 *
 * 设计边界（重要）：
 * 1) 止盈线**只上移，绝不下调**。下调会让止盈线贴着现价走，退化成市价单。
 * 2) 回撤容忍按标的自身的 ATR 自适应，不写死百分比 —— 红利 ETF 日波动 0.8%，
 *    个股 3.5%，用同一个 3% 会一边被噪音洗出、一边形同虚设。
 * 3) 保本线不是「兜底抬高止盈价」，而是**准入条件**：
 *    只有当「回撤后的止盈价」仍高于成本 ×1.02 时才允许挂单。
 *    若把保本线当兜底取 max，会算出高于现价的目标价，把移动止盈变成追涨卖出。
 * 4) 不判「该不该现在卖」，只回答「现在该挂在哪」。卖出的时点由价格决定，不由判断决定。
 */

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const round = (v, d = 3) => Math.round(num(v) * 10 ** d) / 10 ** d;

// ---- 参数（集中在这里，CLI 可覆盖，不要散落到调用处）----
const PULL_ATR_K = 1.8; // 回撤容忍 = 1.8 × ATR
const PULL_MIN = 0.025; // 下限 2.5%：波动再小也不能贴着走
const PULL_MAX = 0.08; // 上限 8%：再大就等于没挂
const SAFETY_PCT = 0.02; // 保本线 = 成本 +2%（覆盖双边最低佣金与微利）
const STEP_PCT = 0.004; // 上移最小步长：止盈价的 0.4%
const STEP_MIN = 0.005; // 且不低于 0.005 元（ETF 最小变动 0.001 的 5 档）
const DEFAULT_ATR_PCT = 2.5; // 取不到 ATR 时的保守默认
const ATR_N = 14;

/**
 * 止盈条件单的比较方向：**`<=`**（价格跌到止盈价才卖）。
 *
 * 这一条极易写反成 `>=`。`>=` 是「涨到目标价卖」（固定目标止盈）的语义；
 * 移动止盈的 target 恒低于持仓期最高价，建单时现价必然 ≥ target，
 * 若写成 `>=`，下一轮 `cond check` 会立刻成交——把止盈变成「持仓即卖」。
 */
const TAKE_OP = '<=';

/**
 * 从日线算 ATR 占现价的百分比。
 * @param {Array<{high,low,close}>} klines 升序或降序均可，内部取最后 N 根
 * @returns {number} 例如 1.39 表示 ATR14 = 现价的 1.39%
 */
function atrPctOf(klines = [], n = ATR_N) {
  const rows = Array.isArray(klines) ? klines.filter((k) => num(k.high) > 0 && num(k.close) > 0) : [];
  if (rows.length < n + 1) return 0;
  // 统一成升序（K 线接口按日期倒序返回）
  const asc = rows.slice().sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const tail = asc.slice(-(n + 1));
  let sum = 0;
  for (let i = 1; i < tail.length; i += 1) {
    const h = num(tail[i].high);
    const l = num(tail[i].low);
    const pc = num(tail[i - 1].close);
    sum += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  const atr = sum / n;
  const last = num(asc[asc.length - 1].close);
  return last > 0 ? (atr / last) * 100 : 0;
}

/** 回撤容忍（小数）：由 ATR% 推出，限制在 [PULL_MIN, PULL_MAX] */
function pullOf(atrPct) {
  const a = num(atrPct) > 0 ? num(atrPct) / 100 : DEFAULT_ATR_PCT / 100;
  return Math.min(PULL_MAX, Math.max(PULL_MIN, a * PULL_ATR_K));
}

/**
 * 持仓期最高价：从建仓日（含）至今的最高 high。
 * 中途若有减仓再加仓，这里会偏保守（把老仓位时期的高点也算进来），
 * 结果只是止盈线更松，不会误卖 —— 属可接受的近似。
 * @param {Array} klines 日线
 * @param {string} sinceDate 'YYYY-MM-DD' 建仓日；空则取全部
 */
function highSince(klines = [], sinceDate = '') {
  const rows = (Array.isArray(klines) ? klines : []).filter((k) => num(k.high) > 0);
  if (!rows.length) return 0;
  const since = /^\d{4}-\d{2}-\d{2}$/.test(String(sinceDate)) ? String(sinceDate) : '';
  const hit = since ? rows.filter((k) => String(k.date) >= since) : rows;
  const use = hit.length ? hit : rows;
  return use.reduce((m, k) => Math.max(m, num(k.high)), 0);
}

/**
 * 算止盈目标价。
 *
 * @param {object} o
 *   - cost   持仓成本（元/股）
 *   - high   持仓期最高价（元/股）
 *   - atrPct ATR14 占现价百分比（可空，空则用保守默认）
 *   - safetyPct 覆盖保本线（默认 0.02）
 *   - pullPct   覆盖回撤容忍（默认按 ATR 推）
 * @returns {{ok:boolean, reason?:string, target?:number, pull?:number,
 *            safety?:number, high?:number, cost?:number, gainPct?:number, lockPct?:number, atrPct?:number}}
 */
function takeTarget(o = {}) {
  const cost = num(o.cost);
  const high = num(o.high);
  const safetyPct = o.safetyPct == null ? SAFETY_PCT : num(o.safetyPct);
  const pull = o.pullPct == null ? pullOf(o.atrPct) : Math.min(PULL_MAX, Math.max(PULL_MIN, num(o.pullPct)));
  const atrPct = num(o.atrPct) || num(o.atrPct, 0) || (pull / PULL_ATR_K) * 100;

  if (!(cost > 0)) return { ok: false, reason: '没有成本价' };
  if (!(high > 0)) return { ok: false, reason: '取不到持仓期最高价' };

  const safety = cost * (1 + safetyPct);
  const target = high * (1 - pull);
  const gainPct = (high / cost - 1) * 100;

  // 准入：回撤后的止盈价必须仍在保本线之上。
  // 这一条同时替代了「浮盈门槛」—— 浮盈不够时 target 会低于保本线，自然挂不出来。
  if (target < safety - 1e-9) {
    // 向上取整到价格最小变动档（0.001）：算出 1.29709 就说 1.298，
    // 说 1.297 会让人照着挂，而 1.297 其实还差一分钱。
    const needHigh = Math.ceil((safety / (1 - pull)) * 1000) / 1000;
    return {
      ok: false,
      reason:
        `浮盈不足：持仓期最高 ${round(high)} 仅 +${gainPct.toFixed(2)}%，` +
        `回撤 ${(pull * 100).toFixed(1)}% 后落到 ${round(target)}，低于保本线 ${round(safety)}；` +
        `需最高价达 ${round(needHigh)}（+${((needHigh / cost - 1) * 100).toFixed(2)}%）才挂`,
      pull,
      safety: round(safety),
      high: round(high),
      cost: round(cost),
      gainPct: round(gainPct, 2),
      atrPct: round(atrPct, 2),
    };
  }

  return {
    ok: true,
    target: round(target),
    pull: round(pull, 4),
    safety: round(safety),
    high: round(high),
    cost: round(cost),
    gainPct: round(gainPct, 2),
    lockPct: round((target / cost - 1) * 100, 2),
    atrPct: round(atrPct, 2),
  };
}

/**
 * 上移的最小步长：止盈价的 0.4%，但不低于 0.005 元。
 * 防止每天为 1 分钱反复撤单建单把时间线刷满。
 */
function stepOf(price) {
  return Math.max(num(price) * STEP_PCT, STEP_MIN);
}

/**
 * 决定这张止盈单该怎么办。
 *
 * @param {object} o
 *   - t          takeTarget() 的返回
 *   - existing   已存在的止盈条件单（cond item）或 null
 *   - available  当前可卖数量（T+1 未解禁时为 0）
 * @returns {{action:'create'|'raise'|'hold'|'wait'|'skip', price?:number, reason:string}}
 *   create 新建 / raise 上移 / hold 保持 / wait 等可卖 / skip 不挂
 */
function decide(o = {}) {
  const t = o.t || {};
  const existing = o.existing || null;
  const available = num(o.available);

  if (!t.ok) return { action: 'skip', reason: t.reason || '无有效止盈目标' };

  // T+1：今日买入当日不可卖，此时建单会在触发后被风控拒绝（可卖 0 股），
  // 记 3 次失败就转 error，白白把一张好单废掉 —— 不如等一天。
  if (existing == null && available <= 0) {
    return {
      action: 'wait',
      price: t.target,
      reason: `可卖 0 股（T+1 未解禁），止盈价 ${t.target} 暂不下单，待解禁后建单`,
    };
  }

  if (!existing) {
    return {
      action: 'create',
      price: t.target,
      reason: `建止盈单：持仓期最高 ${t.high}（+${t.gainPct}%），回撤 ${(t.pull * 100).toFixed(1)}% 后 ${t.target}，锁定 +${t.lockPct}%`,
    };
  }

  const cur = num(existing.triggers && existing.triggers.price && existing.triggers.price.value);
  const step = stepOf(t.target);

  // 只上移。target 低于现价说明价格回落了 —— 此时下调止盈线等于把止盈变成随时可成交的市价单。
  if (cur > 0 && t.target <= cur + step - 1e-9) {
    return {
      action: 'hold',
      price: cur,
      reason: `保持 ${cur}（新算 ${t.target}，未超过上移步长 ${round(step)}，止盈线不下调）`,
    };
  }

  return {
    action: 'raise',
    price: t.target,
    reason: `上移 ${cur} → ${t.target}（持仓期最高 ${t.high} 抬升，锁定 +${t.lockPct}%）`,
  };
}

/** 一句话描述，供列表与时间线 */
function describe(t) {
  if (!t || !t.ok) return t && t.reason ? t.reason : '无有效止盈目标';
  return (
    `成本 ${t.cost} 最高 ${t.high}（+${t.gainPct}%）` +
    ` → 止盈 ${t.target}（锁 +${t.lockPct}%），回撤容忍 ${(t.pull * 100).toFixed(1)}%、保本线 ${t.safety}`
  );
}

module.exports = {
  ATR_N,
  TAKE_OP,
  PULL_ATR_K,
  PULL_MIN,
  PULL_MAX,
  SAFETY_PCT,
  STEP_PCT,
  STEP_MIN,
  DEFAULT_ATR_PCT,
  atrPctOf,
  pullOf,
  highSince,
  takeTarget,
  stepOf,
  decide,
  describe,
};
