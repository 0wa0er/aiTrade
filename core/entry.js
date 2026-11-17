'use strict';

/**
 * 双档入场方案计算 —— 纯函数
 *
 * 起因：2026-11-09 ~ 11-17 八个交易日，候选池五只标的（工行 +4.99%、红利低波50 +2.81%、
 * 长电 +2.28%、512890 +1.77%、平安 -0.09%）**方向全对，但只成交 1 笔**。
 * 原因不是看错，是入场只留了「回踩均线」一条路：抗跌品种之所以抗跌，正是因为资金在持续流入，
 * 它们根本不会回踩 —— 要求「必须回踩 MA20 才买」等于要求「资金先流出才买」，
 * 与「资金持续流入」这个前提自相矛盾。单边结构市里，这套判据的触发率是 1/5。
 *
 * 所以入场必须留第二条路：**确认突破档**。
 *   - 回踩档：价格回到 MA20 附近接，仓位用满档（≤ 单票上限）
 *   - 突破档：价格创 20 日新高后接，仓位**只用半档**（≤ 单票上限 × halfRatio，默认 0.5）
 *     —— 追高必须用更小的仓位换更高的确定性，否则「不追高」这条纪律就白写了
 *
 * 两条路互斥：同一标的同时挂两张单会撞单日买入上限（AGENTS §3）。挂哪一张由人/agent 判。
 */

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

const DEFAULTS = {
  pullbackBuf: 0.005,
  pullbackFloor: 0.025,
  breakoutBuf: 0.001,
  breakoutFloor: 0.015,
  halfRatio: 0.5,
};

function lotQty(budget, price, lotStep) {
  const step = Math.max(1, num(lotStep, 100));
  if (!(price > 0) || !(budget > 0)) return 0;
  return Math.floor(budget / price / step) * step;
}

function leg({ trigger, floor, target, hardCap, minTradeAmount, lotStep, label, half }) {
  const step = Math.max(1, num(lotStep, 100));
  const min = num(minTradeAmount);
  let qty = lotQty(target, trigger, step);
  // 取整到整手后可能刚好掉到单笔下限下面（例如 1.267 的 ETF 买 7,800 股 = 9,884 < 1 万），
  // 这时往前补一手，只要不越单票上限就是合规的：宁可多买 100 股，也不要挂一张必被拒的单。
  if (qty > 0 && qty * trigger < min && (qty + step) * trigger <= num(hardCap) * 1.0001) {
    qty += step;
  }
  const amount = round2(qty * trigger);
  const ok = qty > 0 && amount >= min && amount <= num(hardCap) * 1.0001;
  let why = '';
  if (!(qty > 0)) why = `预算 ¥${round2(target)} 买不起一手（触发价 ${trigger}，每手 ${step} 股）`;
  else if (amount < min) {
    const needQty = Math.ceil(min / trigger / step) * step;
    why = `成交额 ¥${amount} 低于单笔下限 ¥${min}（补到 ${needQty} 股需 ¥${round2(needQty * trigger)}，超单票上限）`;
  }
  return { label, half: !!half, trigger: round3(trigger), floor: round3(floor), qty, amount, ok, why };
}

/**
 * @param {object} o
 * @param {number} o.price            现价
 * @param {number} o.ma20             MA20（回踩档锚点）
 * @param {number} o.high20           近 20 日最高价（突破档锚点）
 * @param {number} o.maxSingleValue   单票上限（权益 × 30%，或分级后的 20%）
 * @param {number} o.minTradeAmount   单笔下限（默认 10000）
 * @param {number} [o.lotStep]        每手股数（默认 100）
 * @param {object} [o.cfg]            覆盖 DEFAULTS
 */
function entryPlan({ price, ma20, high20, maxSingleValue, minTradeAmount = 10000, lotStep = 100, cfg } = {}) {
  const c = { ...DEFAULTS, ...(cfg || {}) };
  const px = num(price);
  const cap = num(maxSingleValue);
  const ma = num(ma20);
  const hi = num(high20);

  const pullTrigger = ma > 0 ? ma : px; // 没有均线时退化为现价
  const pullFloor = pullTrigger * (1 - c.pullbackFloor);
  const pull = leg({
    trigger: pullTrigger,
    floor: pullFloor,
    target: cap,
    hardCap: cap,
    minTradeAmount,
    lotStep,
    label: '回踩档（满档）',
    half: false,
  });

  const breakTrigger = (hi > 0 ? hi : px) * (1 + c.breakoutBuf);
  const breakFloor = breakTrigger * (1 - c.breakoutFloor);
  // 半档不能低于单笔下限：5 万本金下 cap 约 1.5 万，×50% = 7,500 < 1 万下限，
  // 直接照 50% 算会让突破档永远「不可行」——那就等于没留第二条路。
  // 所以按「满足下限的最小整额」取；硬上限仍然是单票上限。
  const halfTarget = Math.min(cap, Math.max(cap * c.halfRatio, num(minTradeAmount)));
  const brk = leg({
    trigger: breakTrigger,
    floor: breakFloor,
    target: halfTarget,
    hardCap: cap,
    minTradeAmount,
    lotStep,
    label: `突破档（半档${halfTarget < cap ? ` ¥${round2(halfTarget)}` : ''}）`,
    half: true,
  });

  const distPull = ma > 0 && px > 0 ? (px / ma - 1) * 100 : null;
  const needBreak = hi > 0 && px > 0 ? (hi / px - 1) * 100 : null;

  const notes = [];
  if (distPull != null) {
    notes.push(distPull >= 0
      ? `现价高于 MA20 ${distPull.toFixed(2)}%，回踩档需回落 ${distPull.toFixed(2)}% 才触发`
      : `现价已低于 MA20 ${Math.abs(distPull).toFixed(2)}%，回踩档就在眼前（注意 floor ${pull.floor} 破了不接）`);
  }
  if (needBreak != null) {
    notes.push(needBreak <= 0
      ? `现价已在 20 日高之上，突破档即时可挂（触发价 ${brk.trigger}）`
      : `距 20 日新高还有 ${needBreak.toFixed(2)}%`);
  }
  notes.push('两档互斥：同标的只挂一张，否则会撞单日买入上限');

  return { pullback: pull, breakout: brk, notes, meta: { price: px, ma20: ma, high20: hi, cap } };
}

function round2(v) {
  return Math.round(num(v) * 100) / 100;
}
function round3(v) {
  return Math.round(num(v) * 1000) / 1000;
}

module.exports = { entryPlan, lotQty, DEFAULTS };
