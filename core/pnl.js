'use strict';
/**
 * 当日盈亏的基准（dayStart.equity）计算 —— 纯函数，便于单测
 *
 * 为什么单独抽出来：2026-11-17 出过一次口径事故。当日盈亏 = 总资产 − 日初权益，
 * 而日初权益是「当天第一次成功快照」的总资产。那天早上东财 push2 接口挂了
 * （UND_ERR_SOCKET），server.js 里取不到行情时 `price` 会回退成 `p.cost`，
 * 于是基准被写成「现金 + 成本市值」= 49,999.80，当日盈亏退化成持仓累计浮盈
 * （显示 +355.20，真实只有 +12）。这种错误不会报错，只会悄悄把收益率做假。
 *
 * 两条硬约束：
 * 1) 取价不完整（任一持仓 dataState 非 ok 或 preClose 缺失）→ 不给基准，宁缺毋滥，
 *    上层显示「—」。用成本兜底出来的数字比没有数字更危险。
 * 2) 基准按昨收价还原：基准 = 总资产 − Σ(现价 − 昨收) × 今开前已持股数。
 *    盘前快照现价即昨收（adjust = 0），等价于总资产；
 *    盘中才补到第一份有效行情时，也不会把当日已经走出来的涨跌算进基准。
 *    今日买入的部分（p.todayBuy）现价与昨收的差不算当日盈亏，故从股数里扣掉。
 *
 * 已知近似：忽略今日交易费用；今日卖出部分的已实现盈亏仍计入当日（这是对的），
 * 但卖出的股数已不在 positions 里，其价差由现金侧体现，故不受本式影响。
 */

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const round = (v, d = 2) => Math.round(num(v) * 10 ** d) / 10 ** d;

/**
 * @param {object} input
 * @param {number} input.totalAsset  当前总资产（现金 + 冻结 + 市值）
 * @param {Array}  input.positions   持仓快照，需含 price / preClose / qty / todayBuy / dataState
 * @returns {{ready:boolean, baseline:number|null, intradayMove:number, reason:string}}
 */
function dayStartBaseline({ totalAsset, positions } = {}) {
  const list = Array.isArray(positions) ? positions : [];

  const bad = list.filter((p) => p.dataState !== 'ok' || !(num(p.preClose) > 0));
  if (bad.length) {
    return {
      ready: false,
      baseline: null,
      intradayMove: 0,
      reason: `取价不完整：${bad.map((p) => p.code || p.name || '?').join('、')}`,
    };
  }

  const intradayMove = list.reduce((s, p) => {
    const held = Math.max(0, num(p.qty) - num(p.todayBuy));
    return s + (num(p.price) - num(p.preClose)) * held;
  }, 0);

  return {
    ready: true,
    baseline: round(num(totalAsset) - intradayMove),
    intradayMove: round(intradayMove),
    reason: '',
  };
}

module.exports = { dayStartBaseline };
