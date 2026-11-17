'use strict';

/**
 * 市场风险分级（A / B / 无）—— 纯函数 + **动作绑定**
 *
 * 为什么单独抽出来：2026-11-13 ~ 11-17 连续三个交易日在日志里贴了「A 级」，
 * 但三天动作全是「持仓在受益侧，不减不加」。分级只贴标签不给动作，等于没分。
 * 本模块强制：判出级别就必须返回动作，而 A 级的 openNew=false 会被 cli.js 的
 * guardBuy 读取并**真拦截**（状态落盘 data/regime.state.json，按交易日过期失效）。
 *
 * 判据三条，`quorum` 条成立即定级（默认 2/3）：
 *   r1 跌停压力　跌停数 ≥ 涨停数 × limitDownRatio（默认 1.5）
 *   r2 广度枯竭　上涨家数占比 ≤ breadthBelow（默认 0.25）
 *   r3 指数杀跌　创业板跌幅 ≤ gemDropPct（默认 -2%）
 *
 * r1 同时是**闸门**：跌停绝对数 < minLimitDown（默认 20）时最多判 B。
 * 否则「跌停 4 家 + 广度 17%」的日子也会够 2 条判成 A，与「非全面崩塌」的实感冲突。
 *
 * 标定（用 2026-11 的真实盘面反推，改阈值前先跑这四条）：
 *   11-12 跌停4/涨停34 · 广度17% · 创业板-2.19% → 闸门否，2 条 → **B**（当时判「非全面崩塌」✓）
 *   11-13 跌停42/涨停38 · 广度13% · 创业板-3.40% → 闸门过，2 条 → **A**（当日判 A ✓）
 *   11-16 跌停69/涨停33 · 广度19% · 创业板-4.34% → 3 条 → **A**（当日判 A ✓）
 *   11-17 跌停74/涨停37 · 广度20% · 创业板-1.73% → 2 条 → **A**（当日判 A ✓）
 *
 * C 级（个股自身风控：放量滞涨、上影过长、弱于大盘 2 倍）不进本模块 ——
 * 那是 core/live.js 的事，与大盘级别无关。
 */

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

const DEFAULT_CFG = {
  quorum: 2,
  limitDownRatio: 1.5,
  minLimitDown: 20,
  breadthBelow: 0.25,
  gemDropPct: -2,
};

const ACTIONS = {
  A: {
    openNew: false,
    addAllowed: false,
    maxSinglePct: 0.2,
    label: '停止开新仓',
    hint: 'A 级：不开新仓；单票上限按权益 20% 计（原 30%）；已有持仓只做止损处置，不做加仓',
  },
  B: {
    openNew: true,
    addAllowed: true,
    maxSinglePct: 0.2,
    label: '只建一档',
    hint: 'B 级：允许开新仓但当日只建一档，单票上限按权益 20% 计（原 30%）',
  },
  none: {
    openNew: true,
    addAllowed: true,
    maxSinglePct: null,
    label: '常规',
    hint: '常规：按默认风控执行（单票 ≤ 权益 30%）',
  },
};

function normCfg(cfg) {
  const c = { ...DEFAULT_CFG, ...(cfg || {}) };
  return {
    quorum: Math.max(1, num(c.quorum, 2)),
    limitDownRatio: num(c.limitDownRatio, 1.5),
    minLimitDown: num(c.minLimitDown, 20),
    breadthBelow: num(c.breadthBelow, 0.25),
    gemDropPct: num(c.gemDropPct, -2),
  };
}

/**
 * @param {object} input
 * @param {number} input.up            上涨家数
 * @param {number} input.down          下跌家数
 * @param {number} input.limitUp       涨停家数
 * @param {number} input.limitDown     跌停家数
 * @param {number} input.gemChangePct  创业板涨跌幅（%，如 -1.73）
 * @param {object} [cfg]               覆盖 DEFAULT_CFG
 * @returns {{level:'A'|'B'|'none', actions:object, hits:object, checks:Array, breadth:number|null, reasons:Array}}
 */
function judge(input = {}, cfg) {
  const c = normCfg(cfg);
  const up = Math.max(0, num(input.up));
  const down = Math.max(0, num(input.down));
  const limitUp = Math.max(0, num(input.limitUp));
  const limitDown = Math.max(0, num(input.limitDown));
  const gem = num(input.gemChangePct, NaN);

  const total = up + down;
  const breadth = total > 0 ? up / total : null;

  const r1 = limitDown >= limitUp * c.limitDownRatio && limitDown >= c.minLimitDown;
  const r2 = breadth != null && breadth <= c.breadthBelow;
  const r3 = Number.isFinite(gem) && gem <= c.gemDropPct;
  const gate = limitDown >= c.minLimitDown;

  const hitCount = [r1, r2, r3].filter(Boolean).length;
  let level = 'none';
  if (hitCount >= c.quorum && gate) level = 'A';
  else if (hitCount >= 1) level = 'B';

  const checks = [
    {
      key: 'r1',
      hit: r1,
      text: `跌停 ${limitDown} vs 涨停 ${limitUp}×${c.limitDownRatio}=${round1(limitUp * c.limitDownRatio)}，且跌停需 ≥ ${c.minLimitDown}`,
    },
    { key: 'r2', hit: r2, text: `上涨占比 ${breadth == null ? '缺失' : (breadth * 100).toFixed(0) + '%'}，阈值 ≤ ${(c.breadthBelow * 100).toFixed(0)}%` },
    { key: 'r3', hit: r3, text: `创业板 ${Number.isFinite(gem) ? gem.toFixed(2) + '%' : '缺失'}，阈值 ≤ ${c.gemDropPct}%` },
  ];

  const reasons = checks.filter((x) => x.hit).map((x) => x.text);
  if (hitCount >= c.quorum && !gate) {
    reasons.push(`降级：跌停绝对数 ${limitDown} < ${c.minLimitDown}，不足以称崩塌 → 最多 B`);
  }
  if (!reasons.length) reasons.push('三条均未触发');

  return { level, actions: { ...ACTIONS[level] }, hits: { r1, r2, r3, gate, hitCount }, checks, breadth, reasons };
}

function round1(v) {
  return Math.round(num(v) * 10) / 10;
}

function actionsFor(level) {
  return { ...(ACTIONS[level] || ACTIONS.none) };
}

/** 落盘状态：带交易日，跨日自动失效，避免昨天的 A 级今天误拦 */
function makeState({ verdict, inputs, today, at }) {
  return {
    date: today,
    level: verdict.level,
    actions: verdict.actions,
    inputs: { ...inputs },
    reasons: verdict.reasons,
    checks: verdict.checks,
    at: at || '',
    note: '由 cli.js regime judge 写入；cli.js guardBuy 在买入前读取。跨交易日自动失效。',
  };
}

function isFresh(state, today) {
  return !!state && typeof state === 'object' && state.date === today;
}

/** 从状态拿生效动作；过期/缺失一律按常规（不因陈旧状态误伤，也不假装有保护） */
function effectiveActions(state, today) {
  if (!isFresh(state, today)) return { ...ACTIONS.none, level: 'none', stale: true };
  return { ...(state.actions || ACTIONS.none), level: state.level || 'none', stale: false };
}

module.exports = { judge, actionsFor, makeState, isFresh, effectiveActions, DEFAULT_CFG, ACTIONS };
