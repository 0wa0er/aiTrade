#!/usr/bin/env node
/**
 * 交易终端命令行 —— 供定时任务 / 手动复盘调用
 *
 * 用法：
 *   node cli.js status                    账户、时段、持仓、挂单、风控余量
 *   node cli.js risk                      持仓止损/止盈信号与超限告警
 *   node cli.js scan [--limit 12]         按规则筛出 5 万本金可买的候选池
 *   node cli.js quote 600519 300750       查行情
 *   node cli.js buy  600519 200 --price 12.5    限价买入
 *   node cli.js buy  600519 200                 市价买入
 *   node cli.js sell 600519 200 --price 12.5    限价卖出（不传 --price 为市价）
 *   node cli.js orders                    当前挂单
 *   node cli.js cancel O000001            撤单
 *   node cli.js reset 50000               重置账户
 *
 * 价格区间（触发即落盘告警，盯盘台常驻时自动发起二次分析）：
 *   node cli.js band list                                 区间清单 + 现价位置 + 武装状态
 *   node cli.js band set 512890 --lower 1.225 --upper 1.245 [--action analyze] [--cool 30] [--note "..."]
 *   node cli.js band del 512890 | band off 512890         删除 / 停用
 *   node cli.js band agent [--on|--off] [--probe]         自动二次分析开关 / 自检 CLI 可用性
 *   node cli.js band status                               监控进程状态
 *   node cli.js alert poll [--check]                     待处理告警；--check 先补一次区间判定（无则输出 IDLE）
 *   node cli.js alert ack A0001 --note "结论"             标记已处理
 *
 * 日志（规范见 data/journal/README.md，务必走这里，不要手写文件）：
 *   node cli.js note [--tag 交易] "内容"   追加一条时间线记录（标签：计划/交易/风控/复盘/运维/自检/记录）
 *   node cli.js journal plan  "..."        覆盖写入「今日计划」区（加 --append 追加；可 --file 或用管道）
 *   node cli.js journal review "..."       覆盖写入「收盘复盘」区
 *   node cli.js journal show [YYYY-MM-DD]  查看某日日志全文（默认今天）
 *   node cli.js journal sync               把账户快照写进日志头部
 *   node cli.js journal brief [--days 3]   最近 N 天摘要（新会话开场用）
 *   node cli.js journal index              重建 INDEX.md
 *   node cli.js journal archive [--days 90] 归档旧日志
 *
 * 所有下单都会先过 data/autotrade.json 里的风控红线，越线直接拒绝（不会下到服务端）。
 */
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const R = require('./core/rules');
const J = require('./core/journal');
const B = require('./core/bands');

const ROOT = __dirname;
const DATA = path.join(ROOT, 'data');
const BASE = process.env.TD_BASE || 'http://127.0.0.1:5173';

const C = {
  r: '\x1b[31m', g: '\x1b[32m', y: '\x1b[33m', c: '\x1b[36m',
  b: '\x1b[1m', d: '\x1b[2m', x: '\x1b[0m',
};

// ---------------- 基础 ----------------
function loadCfg() {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA, 'autotrade.json'), 'utf8'));
  } catch (e) {
    throw new Error('读取 data/autotrade.json 失败：' + e.message);
  }
}

function loadState() {
  return JSON.parse(fs.readFileSync(path.join(DATA, 'state.json'), 'utf8'));
}

function holidays() {
  try {
    return new Set(JSON.parse(fs.readFileSync(path.join(DATA, 'holidays.json'), 'utf8')));
  } catch {
    return new Set();
  }
}

function fees() {
  return JSON.parse(fs.readFileSync(path.join(DATA, 'fees.json'), 'utf8'));
}

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const money = (n) => num(n).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (n) => `${num(n) >= 0 ? '+' : ''}${num(n).toFixed(2)}%`;
const signColor = (n) => (num(n) > 0 ? C.r : num(n) < 0 ? C.g : ''); // A股：红涨绿跌

function todayKey(d = new Date()) {
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function api(p, opt = {}) {
  let r;
  try {
    r = await fetch(BASE + p, {
      method: opt.method || 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: opt.body ? JSON.stringify(opt.body) : undefined,
    });
  } catch (e) {
    const err = new Error(`连不上交易服务 ${BASE}（是否已启动？双击 start.bat）`);
    err.code = 'DOWN';
    throw err;
  }
  const j = await r.json().catch(() => ({ ok: false, msg: '返回非 JSON' }));
  if (!j.ok) {
    const err = new Error(j.msg || '接口错误');
    err.code = j.code || 'ERROR';
    throw err;
  }
  return j.data;
}

async function ping() {
  try {
    const r = await fetch(BASE + '/api/health', { signal: AbortSignal.timeout(4000) });
    return r.ok;
  } catch {
    return false;
  }
}

/**
 * 服务没启动就自己拉起来。
 * detached + unref：脱离当前进程，父进程（定时任务）结束后服务继续运行。
 */
async function ensureServer() {
  if (await ping()) return false;
  // 首次失败先等一拍：可能是另一个命令正在启动服务，避免两个实例抢同一端口
  await new Promise((r) => setTimeout(r, 800));
  if (await ping()) return false;
  console.log(`${C.y}服务未响应，自动启动…${C.x}`);
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, NO_OPEN: '1' },
  });
  child.unref();
  for (let i = 0; i < 25; i++) {
    await new Promise((r) => setTimeout(r, 400));
    if (await ping()) {
      console.log(`${C.g}服务已启动${C.x}`);
      return true;
    }
  }
  const err = new Error('交易服务启动失败（端口 5173 可能被占用，或 node 不可用）');
  err.code = 'DOWN';
  throw err;
}

const secidOf = (code) => (/^[569]/.test(code) ? '1.' : '0.') + code;
const typeOf = (code) => (/^(5|15|16)/.test(code) ? 'etf' : 'stock');

// ---------------- 费用估算 ----------------
function estimateFee(amount, side, type) {
  const f = fees();
  const isEtf = type === 'etf';
  const rate = isEtf ? num(f.etfCommissionRate, 0.00025) : num(f.commissionRate, 0.00025);
  const min = isEtf ? num(f.etfCommissionMin, 0) : num(f.commissionMin, 5);
  const comm = Math.max(amount * rate, amount > 0 ? min : 0);
  const transfer = isEtf ? 0 : amount * num(f.transferRate, 0.00001);
  const stamp = side === 'sell' && !isEtf ? amount * num(f.stampRate, 0.0005) : 0;
  return { comm, transfer, stamp, total: comm + transfer + stamp };
}

// ---------------- 风控 ----------------
function riskContext(cfg, dash) {
  const a = dash.account;
  const risk = cfg.risk || {};
  const equity = num(a.totalAsset);
  const st = loadState();
  const tk = todayKey();
  const todayBuy = st.trades
    .filter((t) => t.side === 'buy' && String(t.time).startsWith(tk))
    .reduce((s, t) => s + num(t.amount), 0);
  const positions = dash.positions.filter((p) => num(p.qty) > 0);
  return {
    equity,
    cash: num(a.totalCash ?? a.cash),
    maxPositions: num(risk.maxPositions, 3),
    maxSinglePct: num(risk.maxSinglePct, 0.3),
    minTradeAmount: num(risk.minTradeAmount, 10000),
    minCashPct: num(risk.minCashPct, 0.08),
    maxDailyBuyPct: num(risk.maxDailyBuyPct, 0.4),
    stopLossPct: num(risk.stopLossPct, -0.07),
    takeProfitPct: num(risk.takeProfitPct, 0.15),
    maxPricePerShare: num(risk.maxPricePerShare, 130),
    positions,
    positionCount: positions.length,
    todayBuy,
    maxSingleValue: equity * num(risk.maxSinglePct, 0.3),
    maxDailyBuy: equity * num(risk.maxDailyBuyPct, 0.4),
    minCash: equity * num(risk.minCashPct, 0.08),
  };
}

/** 越线即抛错，错误里写清红线与实际值 */
function guardBuy({ cfg, ctx, dash, quote, code, name, type, qty, price, market }) {
  const lot = R.lotOf(code, type);
  const risk = cfg.risk || {};
  const isNew = !ctx.positions.some((p) => p.code === code);
  const px = market ? num(quote?.price) : num(price);

  // 账户资质优先：板块都没开通，后面的仓位/价格/数量规则全是空谈
  const perm = R.permissionOf({ code, name, type, permissions: cfg.account?.permissions });
  if (!perm.allowed) {
    throw new Error(
      `账户无${perm.label}交易权限：需 ${perm.need}。` +
        `当前模拟账户为「新开户 + 5 万本金 + 无交易经验」，只能交易沪深主板与场内基金` +
        `（科创板 ETF、创业板 ETF 不受此限）。如确需放开，改 data/autotrade.json 的 account.permissions`
    );
  }

  // 标的资格检查放在最前：否则基金/ST 会先撞上下面的整手校验，报出误导性的原因
  if (num(risk.forbidST) !== 0 && /ST|退/.test(name || '')) {
    throw new Error(`风控禁止买入 ST / 退市风险股：${name}`);
  }
  if (num(risk.forbidFund) !== 0 && type === 'fund') {
    throw new Error('风控禁止自动交易场外基金（T+1 确认 + 赎回费阶梯，不适合日内规则）');
  }

  if (qty % lot.step !== 0 && market) {
    throw new Error(`数量须为 ${lot.step} 股整数倍（${lot.board === 'star' ? '科创板' : lot.board === 'bse' ? '北交所' : '主板/创业板/ETF'}最少 ${lot.buyMin} 股）`);
  }
  if (!market && num(quote?.limitUp) > 0 && px > num(quote.limitUp) + 1e-9) {
    throw new Error(`委托价 ${px} 高于涨停价 ${quote.limitUp}`);
  }

  const effPx = px > 0 ? px : num(quote?.limitUp) || num(quote?.price);
  if (effPx * lot.step > ctx.maxSingleValue + 1e-6) {
    throw new Error(
      `最小一手（${lot.step} 股）需 ¥${money(effPx * lot.step)}，超过单票上限 ¥${money(ctx.maxSingleValue)}（权益的 ${(ctx.maxSinglePct * 100).toFixed(0)}%）。` +
        `该标的不适合当前本金，换价格更低的标的。`
    );
  }
  if (num(risk.maxPricePerShare, 130) > 0 && px > num(risk.maxPricePerShare) && type === 'stock') {
    throw new Error(`股价 ${px} 超过单价上限 ${risk.maxPricePerShare}`);
  }

  const amount = effPx * qty;
  if (amount < ctx.minTradeAmount) {
    throw new Error(
      `单笔成交额 ¥${money(amount)} 低于下限 ¥${money(ctx.minTradeAmount)}：最低佣金 5 元会让费率翻倍，` +
        `请加大数量或换标的（不足此额度的买入一律拒绝）`
    );
  }

  if (isNew && ctx.positionCount >= ctx.maxPositions) {
    throw new Error(`已有 ${ctx.positionCount} 只持仓，达到上限 ${ctx.maxPositions} 只，先减仓再开新仓`);
  }

  const existing = ctx.positions.find((p) => p.code === code);
  const afterValue = num(existing?.marketValue) + amount;
  if (afterValue > ctx.maxSingleValue * 1.001) {
    throw new Error(
      `买入后该股 ¥${money(afterValue)}，超过单票上限 ¥${money(ctx.maxSingleValue)}`
    );
  }

  const cost = amount + estimateFee(amount, 'buy', type).total;
  if (ctx.cash - cost < ctx.minCash - 1e-6) {
    throw new Error(
      `可用资金不足：需 ¥${money(cost)}，可用 ¥${money(ctx.cash)}，` +
        `且须保留现金 ¥${money(ctx.minCash)}`
    );
  }

  if (ctx.todayBuy + amount > ctx.maxDailyBuy * 1.001) {
    throw new Error(
      `今日已买入 ¥${money(ctx.todayBuy)}，本单 ¥${money(amount)} 将超过单日买入上限 ¥${money(ctx.maxDailyBuy)}`
    );
  }

  return amount;
}

// ---------------- 命令 ----------------
async function cmdStatus() {
  const cfg = loadCfg();
  const dash = await api('/api/dashboard');
  const s = dash.meta.session;
  const a = dash.account;
  const ctx = riskContext(cfg, dash);

  console.log(`${C.b}时间${C.x} ${dash.meta.tradingDate} ${dash.meta.serverClock}　${C.b}时段${C.x} ${s.label}（${s.code}）　可委托=${s.accept ? C.g + '是' : C.y + '否'}${C.x}　可撤单=${s.cancelable ? '是' : '否'}`);
  console.log(
    `${C.b}资产${C.x} 总 ${money(a.totalAsset)}　可用 ${money(a.cash)}　冻结 ${money(a.frozenCash)}　` +
      `市值 ${money(a.marketValue)}　当日 ${signColor(a.dayPnl)}${money(a.dayPnl)} (${pct(a.dayPnlPct)})${C.x}　` +
      `累计 ${signColor(a.totalPnl)}${money(a.totalPnl)} (${pct(a.totalPnlPct)})${C.x}`
  );

  const denied = R.deniedBoards(cfg.account?.permissions);
  console.log(
    `${C.b}账户资质${C.x} 可交易 ${R.allowedBoards(cfg.account?.permissions).join('、')}　` +
      `${C.d}未开通 ${denied.length} 项：${denied.slice(0, 6).map((d) => d.label).join('、')}${denied.length > 6 ? ' 等' : ''}${C.x}`
  );

  if (!ctx.positions.length) {
    console.log(`${C.b}持仓${C.x} 空仓`);
  } else {
    console.log(`${C.b}持仓 ${ctx.positions.length}/${ctx.maxPositions}${C.x}`);
    for (const p of ctx.positions) {
      const dp = p.type === 'etf' ? 3 : 2;
      console.log(
        `  ${p.code} ${p.name}　${num(p.qty)}股（可用 ${num(p.available)} 冻结 ${num(p.frozen || 0)}）　` +
          `成本 ${num(p.cost).toFixed(dp)} 现价 ${num(p.price).toFixed(dp)}　` +
          `市值 ${money(p.marketValue)}　${signColor(p.pnl)}${money(p.pnl)} ${pct(p.pnlPct)}${C.x}`
      );
    }
  }

  const open = (dash.orders || []).filter((o) => ['pending', 'partial'].includes(o.status));
  console.log(
    `${C.b}挂单${C.x} ${open.length ? open.map((o) => `${o.id} ${o.name} ${o.side === 'buy' ? '买' : '卖'} ${num(o.qty)}@${o.price} 已成交${num(o.filledQty)}`).join('；') : '无'}`
  );

  console.log(
    `${C.b}风控余量${C.x} 单票上限 ${money(ctx.maxSingleValue)}　今日已买 ${money(ctx.todayBuy)}/${money(ctx.maxDailyBuy)}　` +
      `最低保留现金 ${money(ctx.minCash)}　止损 ${pct(ctx.stopLossPct * 100)}　止盈 ${pct(ctx.takeProfitPct * 100)}`
  );
  if ((dash.meta.warnings || []).length) console.log(`${C.y}提示${C.x} ${dash.meta.warnings.join('；')}`);
}

async function cmdRisk() {
  const cfg = loadCfg();
  const dash = await api('/api/dashboard');
  const ctx = riskContext(cfg, dash);
  let hit = 0;

  for (const p of ctx.positions) {
    const cost = num(p.cost);
    const px = num(p.price);
    const stop = cost * (1 + ctx.stopLossPct);
    const take = cost * (1 + ctx.takeProfitPct);
    const tags = [];
    if (px <= stop) tags.push(`${C.r}触发止损${C.x}（≤${stop.toFixed(2)}）`);
    else if (px >= take) tags.push(`${C.g}触发止盈${C.x}（≥${take.toFixed(2)}）`);
    if (num(p.marketValue) > ctx.maxSingleValue * 1.05) tags.push(`${C.y}超单票上限${C.x}`);
    const avail = num(p.available);
    if (avail < num(p.qty)) tags.push(`${C.d}可卖${avail}股（T+1）${C.x}`);
    if (tags.length) hit++;
    console.log(
      `${p.code} ${p.name}　成本 ${cost.toFixed(2)} 现价 ${px.toFixed(2)} ${signColor(p.pnlPct)}${pct(p.pnlPct)}${C.x}　` +
        `止损线 ${stop.toFixed(2)} 止盈线 ${take.toFixed(2)}　${tags.join(' ')}`
    );
  }

  if (!ctx.positions.length) console.log('空仓，无持仓风险信号');
  const cashPctNow = ctx.equity > 0 ? ctx.cash / ctx.equity : 1;
  if (ctx.positionCount >= ctx.maxPositions) console.log(`${C.y}持仓数已达上限 ${ctx.maxPositions}，只可减仓不可开新仓${C.x}`);
  if (cashPctNow < ctx.minCashPct) console.log(`${C.y}现金占比 ${(cashPctNow * 100).toFixed(1)}% 低于下限 ${(ctx.minCashPct * 100).toFixed(0)}%${C.x}`);
  if (ctx.todayBuy >= ctx.maxDailyBuy * 0.95) console.log(`${C.y}今日买入额度已用尽（${money(ctx.todayBuy)}）${C.x}`);
  console.log(hit ? `\n${hit} 只持仓存在需要处理的信号` : '\n无买卖信号');
}

async function cmdScan(argv) {
  const cfg = loadCfg();
  const sc = cfg.scan || {};
  const limit = num(argv.limit, 12);
  const pz = 200;
  const fields = 'f2,f3,f5,f6,f8,f9,f12,f14,f20';
  const url =
    `https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=${pz}&po=1&np=1&fltt=2&invt=2&fid=f6` +
    `&fs=m:0+t:6,m:0+t:80,m:1+t:2&fields=${fields}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://quote.eastmoney.com/' } });
  const j = await r.json();
  const list = (j?.data?.diff || []).filter((d) => {
    const code = String(d.f12);
    const name = String(d.f14 || '');
    const price = num(d.f2);
    const p = num(d.f3);
    const amount = num(d.f6);
    if (!/^\d{6}$/.test(code)) return false;
    // 账户资质：未开通的板块直接出局（科创板/创业板/北交所/ST/退市整理）
    if (!R.permissionOf({ code, name, type: 'stock', permissions: cfg.account?.permissions }).allowed) return false;
    if ((sc.excludeBoards || []).some((b) => code.startsWith(b))) return false;
    if (/N$|C$/.test(name)) return false; // 新股/次新：上市初期无涨跌幅限制，不在候选池
    if (price < num(sc.minPrice, 3) || price > num(sc.maxPrice, 130)) return false;
    const [lo, hi] = sc.pctRange || [-4, 6];
    if (p < lo || p > hi) return false;
    if (amount < num(sc.minAmountYi, 2) * 1e8) return false;
    return true;
  });

  const boards = R.allowedBoards(cfg.account?.permissions).join('、');
  console.log(`${C.b}候选池${C.x}（成交额前列，价 ${sc.minPrice}–${sc.maxPrice}，涨幅 ${(sc.pctRange || []).join('%~')}%，成交额 ≥${sc.minAmountYi} 亿）`);
  console.log(`${C.d}可交易范围：${boards}　｜　价格区间保证一手 ≤ ${money(num(sc.maxPrice) * 100)}${C.x}`);
  list.slice(0, limit).forEach((d, i) => {
    console.log(
      `${String(i + 1).padStart(2)}. ${d.f12} ${String(d.f14).padEnd(6)}　价 ${String(num(d.f2).toFixed(2)).padStart(7)}　` +
        `涨 ${signColor(d.f3)}${pct(d.f3)}${C.x}　成交 ${(num(d.f6) / 1e8).toFixed(1)}亿　换手 ${num(d.f8).toFixed(1)}%　PE ${num(d.f9) ? num(d.f9).toFixed(1) : '--'}`
    );
  });
  if (!list.length) console.log('无符合条件标的（可能是极端行情），本时段不动');
}

async function cmdQuote(codes) {
  for (const code of codes) {
    const secid = secidOf(code);
    const type = typeOf(code);
    const d = await api(`/api/detail?secid=${secid}&code=${code}&type=${type}`);
    const q = d.quote;
    if (!q) {
      console.log(`${code} 无行情`);
      continue;
    }
    console.log(
      `${code} ${q.name}　现价 ${num(q.price).toFixed(3)}　${signColor(q.pct)}${pct(q.pct)}${C.x}　` +
        `昨收 ${num(q.preClose).toFixed(2)}　涨跌停 ${num(q.limitDown).toFixed(2)}~${num(q.limitUp).toFixed(2)}　` +
        `成交额 ${(num(q.amount) / 1e8).toFixed(2)}亿`
    );
  }
}

async function placeOrder(side, code, qty, argv) {
  const cfg = loadCfg();
  if (cfg.enabled === false) throw new Error('autotrade.json 中 enabled=false，自动交易已停用');
  const secid = secidOf(code);
  const type = typeOf(code);
  const dash = await api('/api/dashboard');
  const det = await api(`/api/detail?secid=${secid}&code=${code}&type=${type}`);
  const quote = det.quote;
  const market = argv.price == null;
  const price = market ? 0 : num(argv.price);
  const name = quote?.name || code;

  const dryRun = argv['dry-run'] != null;
  if (!dash.meta.session.accept && !dryRun) {
    throw new Error(`当前时段不可委托：${dash.meta.session.label}（${dash.meta.session.code}）`);
  }

  const ctx = riskContext(cfg, dash);
  if (side === 'buy') {
    guardBuy({ cfg, ctx, dash, quote, code, name, type, qty, price, market });
  } else {
    const pos = ctx.positions.find((p) => p.code === code);
    if (!pos) throw new Error(`无 ${code} 持仓`);
    if (qty > num(pos.available) + 1e-6) {
      throw new Error(`可卖 ${num(pos.available)} 股（持仓 ${num(pos.qty)}，今日买入不可卖）`);
    }
  }

  const body = { secid, code, name, type, side, qty, orderType: market ? 'market' : 'limit' };
  if (!market) body.price = price;

  if (dryRun) {
    console.log(`风控预检通过　${name} ${side === 'buy' ? '买' : '卖'} ${qty}股　${market ? '市价' : '限价 ' + price}　（未下单）`);
    return { status: 'dry-run' };
  }

  const res = await api('/api/order', { method: 'POST', body });
  const o = res.order;
  const label = { pending: '已挂单', partial: '部分成交', filled: '已成交', canceled: '已撤销', expired: '已失效', rejected: '已拒绝' }[o.status] || o.status;
  console.log(`${label}　${o.id}　${name} ${side === 'buy' ? '买' : '卖'} ${qty}股　${market ? '市价' : '限价 ' + price}`);

  const filled = num(o.filledQty);
  if (filled > 0) {
    const avg = num(o.filledAmount) / filled;
    console.log(
      `  成交 ${filled}股 @ ${avg.toFixed(type === 'etf' ? 3 : 2)}　金额 ${money(o.filledAmount)}　` +
        `费用 ${money(o.feeTotal)}　状态 ${label}`
    );
  }
  if (o.status === 'pending' || o.status === 'partial') {
    console.log(`  剩余未成交，已冻结资金 ${money(o.frozen)}；可 node cli.js cancel ${o.id} 撤单`);
  }
  if (filled === 0 && o.status !== 'pending') {
    console.log(`  未成交：盘口无对手价或报价不足（${o.status}）`);
  }
  return o;
}

async function cmdOrders() {
  const list = await api('/api/orders');
  const open = list.filter((o) => ['pending', 'partial'].includes(o.status));
  if (!open.length) return console.log('无挂单');
  open.forEach((o) =>
    console.log(
      `${o.id}　${o.code} ${o.name}　${o.side === 'buy' ? '买' : '卖'}　${o.orderType}　` +
        `委托 ${num(o.qty)}@${o.price}　已成交 ${num(o.filledQty)}　${o.statusLabel || o.status}`
    )
  );
}

async function cmdNote(text, argv = {}) {
  if (!text || !String(text).trim()) {
    throw new Error('用法：node cli.js note [--tag 交易] [--at 09:45] "内容"（标签：计划/交易/风控/复盘/运维/自检/记录）');
  }
  // 内容以 HH:MM 开头时视为真实发生时间（补写历史条目时常用），也可用 --at 显式指定
  let body = String(text).trim();
  let at = argv.at && argv.at !== 'true' ? argv.at : null;
  if (!at) {
    const m = body.match(/^(\d{1,2}):(\d{2})\s+(.+)$/);
    if (m) {
      at = `${String(m[1]).padStart(2, '0')}:${m[2]}`;
      body = m[3];
    }
  }
  if (at && !/^\d{2}:\d{2}$/.test(at)) throw new Error('--at 须为 HH:MM，如 --at 09:45');

  const r = J.appendTimeline({
    text: body,
    at: at || undefined,
    tag: argv.tag && argv.tag !== 'true' ? argv.tag : '记录',
    key: argv.date || J.dateKey(),
  });
  console.log(`${C.g}✓${C.x} 已记入 ${path.relative(ROOT, r.file)}${at ? ` @${at}` : ''}`);
  if (r.created) console.log(`${C.d}  新建日志，已套用规范骨架${C.x}`);
  if (r.migrated) console.log(`${C.d}  旧格式已迁移为规范结构，原文保留在「历史正文」区${C.x}`);
}

/** 读入长文本：位置参数 > --file > 管道 stdin */
function readContent(rest, argv = {}) {
  if (argv.file && argv.file !== 'true') {
    const p = path.resolve(ROOT, argv.file);
    if (!fs.existsSync(p)) throw new Error(`文件不存在：${p}`);
    return fs.readFileSync(p, 'utf8');
  }
  const inline = rest.filter((x) => !/^\d{4}-\d{2}-\d{2}$/.test(x)).join(' ').trim();
  if (inline) return inline;
  if (!process.stdin.isTTY) {
    try {
      const s = fs.readFileSync(0, 'utf8');
      if (s.trim()) return s;
    } catch {
      /* 无管道输入 */
    }
  }
  throw new Error('缺少内容：直接跟在命令后，或用 --file <路径>，或通过管道传入');
}

const JOURNAL_SUBS = ['show', 'plan', 'review', 'init', 'index', 'archive', 'sync', 'brief'];

async function cmdJournal(rest, argv = {}) {
  const sub = rest[0] && JOURNAL_SUBS.includes(rest[0]) ? rest[0] : 'show';
  const restArgs = sub === 'show' ? rest : rest.slice(1);
  const key = argv.date || (restArgs[0] && /^\d{4}-\d{2}-\d{2}$/.test(restArgs[0]) ? restArgs[0] : J.dateKey());

  switch (sub) {
    case 'init': {
      const r = J.ensureJournal(key);
      console.log(`${C.g}✓${C.x} ${path.relative(ROOT, r.file)} ${r.created ? '已创建' : r.migrated ? '已迁移为规范结构' : '已存在，结构完好'}`);
      return;
    }
    case 'show': {
      const r = J.readJournal(key);
      if (!r) throw new Error(`${key} 没有日志（可用 node cli.js journal init --date ${key} 创建）`);
      process.stdout.write(r.text.endsWith('\n') ? r.text : r.text + '\n');
      return;
    }
    case 'plan':
    case 'review': {
      const body = readContent(restArgs, argv);
      const append = argv.append === 'true' || argv.append === true;
      const r = J.setSection(sub, body, key, { append });
      console.log(
        `${C.g}✓${C.x} ${sub === 'plan' ? '今日计划' : '收盘复盘'}已${append ? '追加' : '写入'} ${path.relative(ROOT, r.file)}`
      );
      if (r.migrated) console.log(`${C.d}  旧格式已迁移${C.x}`);
      return;
    }
    case 'sync': {
      const dash = await api('/api/dashboard');
      const a = dash.account || {};
      const r = J.syncMeta(
        {
          capital: a.initialCapital ?? a.capital ?? null,
          cash: a.totalCash ?? a.cash ?? null,
          positions: (dash.positions || []).filter((p) => num(p.qty) > 0).length,
          pnlPct: a.totalPnlPct ?? null,
          session: dash.meta?.session?.label || null,
        },
        key
      );
      console.log(`${C.g}✓${C.x} 账户快照已同步到 ${path.relative(ROOT, r.file)}`);
      return;
    }
    case 'index': {
      const r = J.renderIndex();
      console.log(`${C.g}✓${C.x} 索引已重建，共 ${r.count} 篇 → ${path.relative(ROOT, r.file)}`);
      return;
    }
    case 'archive': {
      const days = num(argv.days, 90);
      const moved = J.archiveOld(days);
      console.log(moved.length ? `${C.g}✓${C.x} 已归档 ${moved.length} 篇：${moved.join('、')}` : '没有需要归档的日志');
      J.renderIndex();
      return;
    }
    case 'brief': {
      const n = num(argv.days, 3);
      for (const d of J.brief(n)) {
        console.log(`${C.b}══ ${d.key} ${d.weekday} · ${d.entries} 条${C.x}`);
        if (d.plan && d.plan.trim() !== '（待写入）') console.log(`${C.c}【计划】${C.x}\n${d.plan}`);
        if (d.review && d.review.trim() !== '（待写入）') console.log(`${C.c}【复盘】${C.x}\n${d.review}`);
      }
      return;
    }
  }
}

// ---------------- 区间触发器 ----------------
function fmtNum(v) {
  return v == null ? '—' : String(Math.round(num(v) * 1000) / 1000);
}

/** 显示宽度（中文按 2 格算），用于终端表格对齐 */
function wOf(s) {
  return [...String(s)].reduce((n, ch) => n + (/[\u3000-\u9fff\uff00-\uffef]/.test(ch) ? 2 : 1), 0);
}
function padW(s, w) {
  const str = String(s);
  return str + ' '.repeat(Math.max(0, w - wOf(str)));
}

async function cmdBand(rest, argv) {
  const sub = rest[0] || 'list';
  if (sub === 'list') {
    const cfg = B.loadConfig();
    if (!cfg.bands.length) {
      console.log('还没有设置区间。示例：node cli.js band set 512890 --lower 1.225 --upper 1.245');
      return;
    }
    const st = B.loadState();
    let live = new Map();
    try {
      const d = await api('/api/quotes?secids=' + cfg.bands.map((b) => b.secid).join(','));
      for (const q of d) {
        live.set(q.code, q);
        live.set(q.secid, q);
      }
    } catch {
      /* 服务没起就只显示规则 */
    }
    console.log(`${padW('ID', 4)} ${padW('标的', 20)} ${padW('下轨', 8)} ${padW('上轨', 8)} ${padW('现价', 9)} 位置 · 状态`);
    for (const b of cfg.bands) {
      const s = st.bands[b.id] || {};
      const q = live.get(b.code) || live.get(b.secid);
      const px = q ? num(q.price) : null;
      let pos = '—';
      if (px) {
        if (b.upper != null && px >= b.upper) pos = `${C.r}已破上轨${C.x}`;
        else if (b.lower != null && px <= b.lower) pos = `${C.g}已破下轨${C.x}`;
        else {
          const near = [
            b.upper != null ? `距上 ${(((px - b.upper) / b.upper) * 100).toFixed(2)}%` : '',
            b.lower != null ? `距下 ${(((px - b.lower) / b.lower) * 100).toFixed(2)}%` : '',
          ].filter(Boolean);
          pos = near.join(' ');
        }
      }
      const armed = s.armed === false ? `${C.y}待回位${C.x}` : `${C.g}已武装${C.x}`;
      const act = b.action === 'analyze' ? '自动二次分析' : '仅提醒';
      const head = `${padW(b.id, 4)} ${padW(`${b.name}(${b.code})`, 20)} ${padW(fmtNum(b.lower), 8)} ${padW(fmtNum(b.upper), 8)} ${padW(px == null ? '—' : px.toFixed(3), 9)}`;
      console.log(`${head} ${pos}  ${b.enabled ? armed : '停用'} · ${act} · 冷却 ${b.cooldownMin}m`);
      if (b.note) console.log(`${' '.repeat(5)}${C.d}备注：${b.note}${C.x}`);
    }
    const pend = B.pendingAlerts();
    if (pend.length) {
      console.log(`\n${C.y}有 ${pend.length} 条待处理告警${C.x}（node cli.js alert poll 查看）`);
    }
    return;
  }

  if (sub === 'set') {
    const code = rest[1];
    if (!/^\d{6}$/.test(code || '')) throw new Error('用法：node cli.js band set 512890 --lower 1.225 --upper 1.245 [--action analyze] [--cool 30] [--note "..."]');
    let name = argv.name && argv.name !== 'true' ? argv.name : '';
    let type = argv.type && argv.type !== 'true' ? argv.type : '';
    try {
      const target = B.secidOf(code, type || 'stock');
      const d = await api('/api/quotes?secids=' + target);
      if (d && d[0]) {
        name = name || d[0].name || '';
        // 从返回值回填类型：ETF 与股票的下单/止损口径不同，别猜
        if (!type) type = /^[15]/.test(code) ? 'etf' : 'stock';
      }
    } catch {
      /* 服务没起也能设，只是名称留空 */
    }
    const b = B.upsertBand({
      code,
      name: name || code,
      type: type || (/^[15]/.test(code) ? 'etf' : 'stock'),
      lower: argv.lower != null && argv.lower !== 'true' ? num(argv.lower) : null,
      upper: argv.upper != null && argv.upper !== 'true' ? num(argv.upper) : null,
      action: argv.action === 'analyze' ? 'analyze' : 'notify',
      cooldownMin: argv.cool != null && argv.cool !== 'true' ? num(argv.cool, 30) : 30,
      resetPct: argv.reset != null && argv.reset !== 'true' ? num(argv.reset, 0.3) : 0.3,
      note: argv.note && argv.note !== 'true' ? argv.note : '',
      enabled: argv.off ? false : true,
    });
    console.log(`${C.g}✓${C.x} 区间已保存 ${b.id} ${b.name}(${b.code}) ${b.lower ?? '—'} ~ ${b.upper ?? '—'} · ${b.action === 'analyze' ? '自动二次分析' : '仅提醒'}`);
    if (b.action === 'analyze' && !B.loadConfig().agent.enabled) {
      console.log(`${C.y}  提示：自动二次分析总开关未打开（node cli.js band agent --on），当前只落盘告警 + 由定时巡检兜底${C.x}`);
    }
    return;
  }

  if (sub === 'del') {
    const key = rest[1];
    if (!key) throw new Error('用法：node cli.js band del B01|512890');
    const cfg = B.loadConfig();
    const hit = cfg.bands.find((b) => b.id === key || b.code === key);
    if (!hit) throw new Error(`找不到区间 ${key}`);
    B.removeBand(hit.id);
    console.log(`${C.g}✓${C.x} 已删除 ${hit.id} ${hit.name}(${hit.code})`);
    return;
  }

  if (sub === 'on' || sub === 'off') {
    const key = rest[1];
    if (!key) throw new Error(`用法：node cli.js band ${sub} B01|512890`);
    const cfg = B.loadConfig();
    const hit = cfg.bands.find((b) => b.id === key || b.code === key);
    if (!hit) throw new Error(`找不到区间 ${key}`);
    const b = B.toggleBand(hit.id, sub === 'on');
    console.log(`${C.g}✓${C.x} ${b.id} ${b.name} 已${b.enabled ? '启用' : '停用'}`);
    return;
  }

  if (sub === 'agent') {
    const cfg = B.loadConfig();
    if (argv.on) {
      cfg.agent.enabled = true;
      B.saveConfig(cfg);
      console.log(`${C.g}✓${C.x} 自动二次分析已开启（触发即起分析进程）`);
    } else if (argv.off) {
      cfg.agent.enabled = false;
      B.saveConfig(cfg);
      console.log(`${C.g}✓${C.x} 自动二次分析已关闭（只落盘告警，由定时巡检兜底）`);
    }
    const entry = B.agentEntry(cfg);
    console.log(`  总开关：${cfg.agent.enabled ? C.g + '开' + C.x : C.y + '关' + C.x}`);
    console.log(`  CLI 入口：${entry ? entry.entry : C.r + '未找到（可在 data/bands.json 的 agent.entry 指定）' + C.x}`);
    if (argv.probe) {
      if (!entry) throw new Error('没有可用 CLI 入口，无法自检');
      console.log('  自检中（会真实调用一次，约 30-90 秒）…');
      const r = await probeAgent(entry, cfg);
      console.log(`  退出码 ${r.code}${r.authFail ? ` ${C.r}· 未登录${C.x}` : r.code === 0 ? ` ${C.g}· 可用${C.x}` : ''}`);
      const out = (r.text || '').trim().split('\n').slice(-4).join('\n');
      if (out) console.log(`${C.d}${out}${C.x}`);
      if (r.authFail) {
        console.log(`\n${C.y}CLI 需要登录后才能自动发起二次分析。两条路：${C.x}`);
        console.log('  1) 在终端执行一次 CLI 登录，之后本功能即可用；');
        console.log('  2) 不登录也行——告警会留在队列里，由「区间巡检」定时任务消费（最迟 20 分钟）。');
      }
    }
    return;
  }

  if (sub === 'status') {
    const d = await api('/api/bands');
    console.log(`监控：${d.live.startAt ? '运行中' : '未启动（服务常驻后自动开启）'} · 轮询 ${d.pollSeconds}s · 已检查 ${d.live.checks} 次`);
    const lt = d.live.lastCheck ? new Date(d.live.lastCheck) : null;
    const lts = lt ? `${String(lt.getHours()).padStart(2, '0')}:${String(lt.getMinutes()).padStart(2, '0')}:${String(lt.getSeconds()).padStart(2, '0')}` : '—（非交易时段不取价）';
    console.log(`上次检查：${lts} · 上次触发：${d.live.lastFire ? B.alertText(d.live.lastFire) : '—'}`);
    console.log(`分析进程：${d.live.agentRunning ? '跑着' : '空闲'} · 待处理告警 ${d.alerts.length} 条`);
    if (d.live.lastError) console.log(`${C.r}最近错误：${d.live.lastError}${C.x}`);
    return;
  }

  throw new Error('用法：node cli.js band list|set|del|on|off|agent|status');
}

function probeAgent(entry, cfg) {
  return new Promise((resolve) => {
    const port = 51000 + Math.floor(Math.random() * 900);
    const child = spawn(process.execPath, [entry.entry, '-p', '只输出两个字：收到', '-y', '--no-session-persistence', '--port', String(port)], {
      cwd: ROOT,
      env: { ...process.env, NO_OPEN: '1' },
    });
    let text = '';
    const timer = setTimeout(() => { try { child.kill(); } catch { /* 已退出 */ } }, 120000);
    child.stdout.on('data', (d) => (text += d.toString()));
    child.stderr.on('data', (d) => (text += d.toString()));
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, text, authFail: /Authentication required|请先登录|not logged in/i.test(text) });
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, text: e.message, authFail: false });
    });
  });
}

// ---------------- 告警队列 ----------------
async function cmdAlert(rest, argv) {
  const sub = rest[0] || 'poll';
  if (sub === 'poll') {
    // --check：先补一次区间判定（盯盘台没常驻时也能抓到现在的位置）
    if (argv.check) {
      try {
        await ensureServer();
        const r = await api('/api/bands', { method: 'POST', body: { action: 'check' } });
        if (r.fired && r.fired.length) {
          console.log(
            `新触发 ${r.fired.length} 条：` +
              r.fired
                .map((f) => `${f.name}(${f.code}) ${f.side === 'upper' ? '上破' : '下破'} ${f.price}`)
                .join('；')
          );
        }
      } catch (e) {
        console.log(`（区间检查跳过：${e.message}）`);
      }
    }
    const pend = B.pendingAlerts(argv.date && argv.date !== 'true' ? argv.date : undefined);
    if (!pend.length) {
      // 快路径：无事可做时只输出一行，供定时任务尽早收工
      console.log('IDLE');
      return;
    }
    console.log(`PENDING ${pend.length}`);
    for (const it of pend) {
      console.log(
        `${it.id} ${it.tradeDate} ${it.time} ${it.name}(${it.code}) ${it.side === 'upper' ? '上破' : '下破'} ` +
          `${it.side === 'upper' ? it.upper : it.lower} · 现价 ${it.price} · 动作 ${it.action}${it.bandNote ? ' · 备注 ' + it.bandNote : ''}`
      );
    }
    return;
  }
  if (sub === 'list') {
    const a = B.loadAlerts();
    if (!a.items.length) {
      console.log('还没有触发记录');
      return;
    }
    for (const it of a.items.slice(0, num(argv.limit, 20))) {
      const tag = it.status === 'pending' ? `${C.y}待处理${C.x}` : `${C.d}${it.status}${C.x}`;
      console.log(`${it.id} ${it.tradeDate} ${it.time} ${tag} ${B.alertText(it)}${it.result ? ` · ${it.result}` : ''}`);
    }
    return;
  }
  if (sub === 'ack') {
    const id = rest[1];
    if (!id) throw new Error('用法：node cli.js alert ack A0001 --note "结论"');
    const note = argv.note && argv.note !== 'true' ? argv.note : rest.slice(2).join(' ');
    const it = B.ackAlert(id, { by: argv.by && argv.by !== 'true' ? argv.by : '手动', note });
    console.log(`${C.g}✓${C.x} ${it.id} 已标记处理${it.result ? `：${it.result}` : ''}`);
    return;
  }
  throw new Error('用法：node cli.js alert poll|list|ack');
}

// ---------------- 入口 ----------------
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
      out[k] = v;
    } else out._.push(a);
  }
  return out;
}

async function main() {
  const argv = parseArgs(process.argv.slice(2));
  const [cmd, ...rest] = argv._;
  try {
    // note / journal 是纯文件操作，不能因服务没起就写不进日志；只有 journal sync 需要服务
    // note / alert / band（除 status 外）都是纯文件操作，不能因服务没起就写不进去
    const fileOnly =
      cmd === 'note' || cmd === 'alert' || (cmd === 'band' && rest[0] !== 'status');
    const needServer = cmd && !fileOnly && !(cmd === 'journal' && rest[0] !== 'sync');
    if (needServer) await ensureServer();
    switch (cmd) {
      case 'status': await cmdStatus(); break;
      case 'risk': await cmdRisk(); break;
      case 'band': await cmdBand(rest, argv); break;
      case 'alert': await cmdAlert(rest, argv); break;
      case 'scan': await cmdScan(argv); break;
      case 'quote':
        if (!rest.length) throw new Error('用法：node cli.js quote 600519 300750');
        await cmdQuote(rest);
        break;
      case 'buy':
      case 'sell': {
        const [code, qtyRaw] = rest;
        if (!/^\d{6}$/.test(code || '')) throw new Error('代码须为 6 位数字，如 600519');
        const qty = num(qtyRaw);
        if (!(qty > 0)) throw new Error('数量须为正数');
        await placeOrder(cmd, code, qty, argv);
        break;
      }
      case 'orders': await cmdOrders(); break;
      case 'cancel': {
        if (!rest[0]) throw new Error('用法：node cli.js cancel O000001');
        await api('/api/cancel', { method: 'POST', body: { id: rest[0] } });
        console.log(`已撤单 ${rest[0]}`);
        break;
      }
      case 'note': await cmdNote(rest.join(' '), argv); break;
      case 'journal': await cmdJournal(rest, argv); break;
      case 'reset': {
        const cap = num(rest[0], 0);
        if (!(cap > 0)) throw new Error('用法：node cli.js reset 50000');
        const r = await api('/api/reset', { method: 'POST', body: { capital: cap, keepWatch: true } });
        console.log(`账户已重置，初始资金 ${money(r.capital)}`);
        break;
      }
      default:
        console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].split('/**')[1].trim());
    }
  } catch (e) {
    console.error(`${C.r}✗${C.x} ${e.message}`);
    process.exitCode = e.code === 'DOWN' ? 3 : 2;
  }
}

if (require.main === module) main();

module.exports = { guardBuy, riskContext, estimateFee, secidOf, typeOf, loadCfg };
