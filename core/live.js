/**
 * 实时盯盘的纯逻辑 —— 只做判定，不碰网络、不碰文件，便于单测。
 *
 * 职责边界（重要）：
 * - 这里只回答「现在有没有该做的动作」，不决定买什么。
 * - 买入需要判断，属于 agent / 人工；盯盘进程最多把「可买条件已满足」写进事件，
 *   真正下单仍走 cli.js（风控闸门在那里）。
 * - 卖出（止损/止盈）是纪律，允许盯盘进程直接触发，但仍调用 cli.js sell。
 */

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const round = (v, d = 2) => Math.round(num(v) * 10 ** d) / 10 ** d;

/** 止盈的「回落幅度」判据：当日最高相对成本曾 ≥+15%，且现价距当日最高回落 ≥3% */
const TAKE_PULLBACK = 0.03;

/**
 * 持仓风控信号。
 * @param {Array} positions 看板里的持仓（含 code/name/qty/cost/price/high/pnlPct）
 * @param {object} o { risk, benchPct, dayHigh, structureRatio }
 *   - risk: data/autotrade.json 的 risk 段（stopLossPct 为负数）
 *   - benchPct: 当日基准指数涨跌幅（%），用于「弱于大盘 2 倍」的结构判据
 *   - dayHigh: { 代码: 盯盘进程观察到的当日最高价 }，比行情快照的 high 更实时
 *   - structureRatio: 结构判据倍数，默认 2
 * @returns {Array} [{ code, name, type, level, price, qty, text, severity }]
 */
function riskSignals(positions = [], o = {}) {
  const risk = o.risk || {};
  const stopLoss = num(risk.stopLossPct ?? -0.07); // -0.07
  const takeProfit = num(risk.takeProfitPct ?? 0.15);
  const ratio = num(o.structureRatio ?? 2) || 2;
  const benchPct = o.benchPct == null ? null : num(o.benchPct);
  const dayHigh = o.dayHigh || {};
  const out = [];

  for (const p of positions) {
    const qty = num(p.qty);
    if (!(qty > 0)) continue;
    const cost = num(p.cost);
    const price = num(p.price);
    if (!(cost > 0) || !(price > 0)) continue;

    const name = p.name || p.code;
    const pnlPct = (price / cost - 1) * 100;
    const high = Math.max(num(p.high), num(dayHigh[p.code]) || 0, price);

    // 1) 止损：跌破成本 -7%，无条件全卖
    if (pnlPct <= stopLoss * 100 + 1e-9) {
      out.push({
        code: p.code,
        name,
        type: 'stop',
        level: round(cost * (1 + stopLoss), 3),
        price,
        qty,
        severity: 'critical',
        text: `止损：${name}(${p.code}) ${price} 较成本 ${round(cost, 3)} 跌 ${round(pnlPct, 2)}%，触 ${round(stopLoss * 100, 1)}% 红线`,
      });
      continue;
    }

    // 2) 止盈：当日最高曾 ≥+15%，现价自高点回落 ≥3% → 卖一半
    const highGain = (high / cost - 1) * 100;
    const pull = high > 0 ? (high - price) / high : 0;
    if (highGain >= takeProfit * 100 - 1e-9 && pull >= TAKE_PULLBACK - 1e-9) {
      out.push({
        code: p.code,
        name,
        type: 'take',
        level: round(high * (1 - TAKE_PULLBACK), 3),
        price,
        qty: Math.max(1, Math.floor(qty / 2)),
        severity: 'warn',
        text: `止盈：${name}(${p.code}) 当日最高 ${round(high, 3)} 曾达 +${round(highGain, 2)}%，现价 ${price} 回落 ${round(pull * 100, 2)}%，减半`,
      });
      continue;
    }

    // 3) 结构：当日跌幅超过基准指数跌幅的 2 倍
    //    只在「大盘也在跌」时比较——大盘上涨而个股下跌属于另一种情形（个股独立走坏），
    //    用 2 倍比值的阈值套上去会误杀正常回调，故此处不判，交给止损与区间处理。
    if (benchPct != null && benchPct < 0) {
      const pct = (price / num(p.preClose || price) - 1) * 100;
      if (pct < 0 && pct <= benchPct * ratio - 1e-9) {
        out.push({
          code: p.code,
          name,
          type: 'structure',
          level: null,
          price,
          qty: Math.max(1, Math.floor(qty / 2)),
          severity: 'warn',
          text: `结构：${name}(${p.code}) 当日 ${round(pct, 2)}%，弱于大盘 ${round(benchPct, 2)}% 的 2 倍，减半`,
        });
      }
    }
  }
  return out;
}

/**
 * 区间告警去重：同一标的同方向在冷却期内只留一条。
 * 服务端 core/bands 已有冷却，这里是盯盘进程侧的二次防抖。
 */
function dedupeAlerts(alerts = [], seen = {}) {
  const out = [];
  const now = Date.now();
  for (const a of alerts) {
    const key = `${a.code}|${a.side}`;
    const last = seen[key] || 0;
    if (now - last < 5 * 60 * 1000) continue;
    seen[key] = now;
    out.push(a);
  }
  return out;
}

/** 把快照压成一行，供终端 / 网页显示 */
function snapshotLine(s = {}) {
  const parts = [];
  if (s.session) parts.push(s.session);
  if (s.indices) {
    const ix = Object.entries(s.indices)
      .map(([k, v]) => `${k} ${num(v.price).toFixed(2)} ${v.pct >= 0 ? '+' : ''}${num(v.pct).toFixed(2)}%`)
      .join(' / ');
    if (ix) parts.push(ix);
  }
  if (s.breadth) {
    const b = s.breadth;
    if (b.up != null) parts.push(`涨 ${b.up} / 跌 ${b.down}（${round(b.upRatio, 0)}%）`);
    if (b.limitUp != null) parts.push(`涨停 ${b.limitUp} / 跌停 ${b.limitDown}`);
    if (b.amountYi != null) parts.push(`成交 ${round(b.amountYi, 0)} 亿`);
  }
  if (s.positions != null) parts.push(`持仓 ${s.positions} 只`);
  return parts.join(' ｜ ');
}

module.exports = { riskSignals, dedupeAlerts, snapshotLine, TAKE_PULLBACK, round };
