'use strict';

/**
 * 本地盯盘 + 模拟交易服务（真实规则版 v2）
 * 纯 Node 原生模块，零依赖。
 *
 * 行情来源：
 *   - 实时行情 / K线 / 分时：东方财富 push2 / push2his 公开接口
 *   - 五档盘口：新浪财经 hq.sinajs.cn（GBK，支持批量）
 *   - 场外基金：东方财富 fundmobapi / api.fund
 *   - 分红送转：东方财富 datacenter RPT_SHAREBONUS_DET
 *
 * 交易规则（对齐实盘）：
 *   - 时段：开盘集合竞价 09:15-09:25 / 连续竞价 09:30-11:30、13:00-14:57 /
 *           收盘集合竞价 14:57-15:00 / 盘后固定价格 15:05-15:30（科创、创业）
 *   - 委托：限价单挂单排队，按五档对手价成交，可部分成交，可撤单；市价单五档即成剩撤
 *   - 冻结：买入冻结资金、卖出冻结股份，撤单/收盘后自动解冻
 *   - 涨跌停：主板 10%、创业板/科创板 20%、北交所 30%、主板 ST 5%；新股前 5 日不限
 *   - 价格笼子：连续竞价限价申报 ±2%（或 ±10 个最小变动单位，取宽者）
 *   - 交易单位：主板/创业板 100 股整数倍、科创板 200 股起 1 股递增、北交所 100 股起 1 股递增
 *   - 费用：佣金万 2.5（最低 5 元）、印花税千 0.5（仅卖出）、过户费万 0.1（双向）
 *   - T+1：当日买入次日可卖，零股须一次性卖出
 *   - 除权除息：现金分红入账、送转加股、成本摊薄；红利税按持有期在卖出时补扣
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const R = require('./core/rules');
const PNL = require('./core/pnl');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const HOLIDAY_FILE = path.join(DATA_DIR, 'holidays.json');
const FEE_FILE = path.join(DATA_DIR, 'fees.json');
const AUTOTRADE_FILE = path.join(DATA_DIR, 'autotrade.json');

/**
 * 读取账户交易权限（data/autotrade.json 的 account.permissions）。
 * 文件缺失或字段缺失时返回 null，由 rules.permissionOf 回落到「新开户」默认值。
 * 每次现读，改配置无需重启 —— 与 cli.js 的行为保持一致。
 */
function loadAccountPermissions() {
  try {
    const cfg = JSON.parse(fs.readFileSync(AUTOTRADE_FILE, 'utf8'));
    const p = cfg && cfg.account && cfg.account.permissions;
    return p && typeof p === 'object' ? p : null;
  } catch {
    return null;
  }
}

const PORT = Number(process.env.PORT || 5193);
const HOST = process.env.HOST || '127.0.0.1';
// 非交易时段是否允许下单（默认拦截；设 SIM_ALLOW_OFFHOURS=1 放开，仅供复盘演练）
const ALLOW_OFF_HOURS = process.env.SIM_ALLOW_OFFHOURS === '1';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// ---------------- 费率（data/fees.json 可覆盖） ----------------
let FEES = { ...R.DEFAULT_FEES };
try {
  FEES = { ...R.DEFAULT_FEES, ...JSON.parse(fs.readFileSync(FEE_FILE, 'utf8')) };
} catch {
  /* 无配置文件时用默认费率 */
}

// ---------------- 交易日历 ----------------
let HOLIDAYS = new Set();
try {
  const raw = JSON.parse(fs.readFileSync(HOLIDAY_FILE, 'utf8'));
  const list = Array.isArray(raw) ? raw : raw?.days || [];
  HOLIDAYS = new Set(list.filter((d) => typeof d === 'string'));
} catch {
  /* 无节假日文件时仅按周末判断 */
}

const TTL = {
  quote: 2000,
  quoteIdle: 20000,
  book: 3000,
  fund: 15000,
  nav: 300000,
  kline: 30000,
  dividend: 43200000,
};

const UPSTREAM = {
  timeout: 6000,
  retries: 1,
  breakerThreshold: 5,
  breakerCooldown: 20000,
};

// ---------------- 基础工具 ----------------
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const numOr = (v) => {
  if (v === '-' || v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const round = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (n) => String(n).padStart(2, '0');
const fmtDate = (d = new Date()) => R.fmtDate(d);
const fmtTime = (d = new Date()) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

const tradingDateKey = (now = new Date()) => R.tradingDateKey(now, HOLIDAYS);
const nextTradingDateKey = (now = new Date(), skip = 1) => R.nextTradingDateKey(now, HOLIDAYS, skip);
const sessionState = (now = new Date()) => R.sessionState(now, HOLIDAYS);
const isTradingNow = () => sessionState().phase === 'continuous';

// ---------------- 上游请求层 ----------------
const inflightReq = new Map();
const breakerState = new Map();

class UpstreamError extends Error {}

async function requestOnce(url, opts = {}) {
  const headers = { Accept: '*/*' };
  if (!opts.noUA) headers['User-Agent'] = UA;
  if (opts.referer) headers.Referer = opts.referer;
  Object.assign(headers, opts.headers || {});
  const res = await fetch(url, {
    signal: AbortSignal.timeout(opts.timeout || UPSTREAM.timeout),
    headers,
  });
  if (!res.ok) throw new UpstreamError('HTTP ' + res.status);
  return opts.binary ? res.arrayBuffer() : res.text();
}

function fetchUpstream(url, opts = {}) {
  const key = url + '|' + (opts.noUA ? 'n' : 'u');
  const running = inflightReq.get(key);
  if (running) return running;

  const task = (async () => {
    let host = '';
    try {
      host = new URL(url).host;
    } catch {
      /* ignore */
    }
    const b = host ? breakerState.get(host) : null;
    if (b && b.openUntil > Date.now()) throw new UpstreamError(`${host} 暂时不可用（熔断中）`);

    let lastErr = null;
    for (let attempt = 0; attempt <= UPSTREAM.retries; attempt++) {
      try {
        const out = await requestOnce(url, opts);
        if (b) {
          b.fails = 0;
          b.openUntil = 0;
        }
        return out;
      } catch (e) {
        lastErr = e;
        const status = Number((/HTTP (\d+)/.exec(e.message) || [])[1] || 0);
        if (status >= 400 && status < 500) break;
        if (attempt < UPSTREAM.retries) await sleep(250 * (attempt + 1));
      }
    }

    if (host) {
      const cur = breakerState.get(host) || { fails: 0, openUntil: 0 };
      cur.fails += 1;
      if (cur.fails >= UPSTREAM.breakerThreshold) {
        cur.openUntil = Date.now() + UPSTREAM.breakerCooldown;
        cur.fails = 0;
        console.warn(`[upstream] ${host} 触发熔断，${UPSTREAM.breakerCooldown / 1000}s 内不再请求`);
      }
      breakerState.set(host, cur);
    }
    throw lastErr || new UpstreamError('上游请求失败');
  })();

  inflightReq.set(key, task);
  const cleanup = () => inflightReq.delete(key);
  task.then(cleanup, cleanup);
  return task;
}

async function fetchJSON(url, opts) {
  const txt = await fetchUpstream(url, opts);
  return JSON.parse(String(txt).replace(/^[^(]*\(/, '').replace(/\);?\s*$/, ''));
}

// ---------------- 行情 ----------------
const quoteCache = new Map();
const fundCache = new Map();

// f124 = 行情更新时间戳；f26 = 上市日期（新股前 5 日无涨跌幅用）
const QUOTE_FIELDS = 'f1,f2,f3,f4,f5,f6,f8,f10,f12,f13,f14,f15,f16,f17,f18,f20,f21,f26,f124';

function parseListDate(v) {
  const s = String(v || '');
  if (s.length !== 8) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(4, 6));
  const d = Number(s.slice(6, 8));
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}

function mapQuote(d) {
  const price = numOr(d.f2);
  const suspended = price === null;
  const marketTs = numOr(d.f124);
  return {
    secid: `${d.f13}.${d.f12}`,
    code: String(d.f12),
    name: d.f14 || '',
    price: suspended ? num(d.f18) : price,
    preClose: num(d.f18),
    open: num(d.f17),
    high: num(d.f15),
    low: num(d.f16),
    change: num(d.f4),
    pct: num(d.f3),
    volume: num(d.f5),
    amount: num(d.f6),
    turnover: num(d.f8),
    volRatio: num(d.f10),
    mktCap: num(d.f20),
    floatCap: num(d.f21),
    listDate: parseListDate(d.f26),
    suspended,
    marketTs: marketTs ? marketTs * 1000 : null,
    ts: Date.now(),
  };
}

async function fetchQuotesRaw(secids) {
  if (!secids.length) return [];
  const url =
    'https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2&secids=' +
    encodeURIComponent(secids.join(',')) +
    '&fields=' + QUOTE_FIELDS;
  const json = await fetchJSON(url, { referer: 'https://quote.eastmoney.com/' });
  const diff = json?.data?.diff || [];
  return diff.map(mapQuote);
}

async function getQuotes(secids) {
  const uniq = [...new Set(secids.filter(Boolean))];
  const now = Date.now();
  const ttl = isTradingNow() ? TTL.quote : TTL.quoteIdle;
  const map = new Map();
  const missing = [];
  const warnings = [];

  for (const s of uniq) {
    const c = quoteCache.get(s);
    if (c && now - c.at < ttl) map.set(s, c.data);
    else missing.push(s);
  }

  if (missing.length) {
    try {
      const list = await fetchQuotesRaw(missing);
      const got = new Set();
      for (const q of list) {
        quoteCache.set(q.secid, { at: now, data: q });
        map.set(q.secid, q);
        got.add(q.secid);
      }
      const noData = missing.filter((s) => !got.has(s));
      if (noData.length) {
        warnings.push(`${noData.length} 只标的无行情返回`);
        for (const s of noData) {
          const c = quoteCache.get(s);
          if (c) map.set(s, { ...c.data, stale: true });
        }
      }
    } catch (e) {
      warnings.push('行情接口异常' + (missing.some((s) => quoteCache.has(s)) ? '，已使用缓存' : ''));
      for (const s of missing) {
        const c = quoteCache.get(s);
        if (c) map.set(s, { ...c.data, stale: true });
      }
      console.warn('[quote]', e.message);
    }
  }

  return { map, warnings };
}

async function getQuote(secid) {
  const { map } = await getQuotes([secid]);
  return map.get(secid) || null;
}

// ---------------- 场外基金 ----------------
async function fetchFundsRaw(codes) {
  const url =
    'https://fundmobapi.eastmoney.com/FundMNewApi/FundMNFInfo?pageIndex=1&pageSize=50' +
    '&plat=Android&appType=ttjj&product=EFund&Version=1&deviceid=tradedesk&Fcodes=' +
    encodeURIComponent(codes.join(','));
  const json = await fetchJSON(url, { noUA: true });
  return json?.Datas || [];
}

async function getFunds(codes) {
  const uniq = [...new Set(codes.filter(Boolean))];
  const map = new Map();
  const warnings = [];
  if (!uniq.length) return { map, warnings };

  const now = Date.now();
  const missing = [];
  for (const c of uniq) {
    const hit = fundCache.get(c);
    if (hit && now - hit.at < TTL.fund) map.set(c, hit.data);
    else missing.push(c);
  }

  if (missing.length) {
    try {
      const rows = await fetchFundsRaw(missing);
      for (const d of rows) {
        const nav = num(d.NAV);
        const gsz = num(d.GSZ);
        const price = gsz > 0 ? gsz : nav;
        const data = {
          secid: 'fund.' + d.FCODE,
          code: d.FCODE,
          name: d.SHORTNAME,
          price,
          nav,
          navDate: d.PDATE,
          navPct: num(d.NAVCHGRT),
          estPct: d.GSZZL == null ? null : num(d.GSZZL),
          estTime: d.GZTIME || null,
          pct: d.GSZZL == null ? num(d.NAVCHGRT) : num(d.GSZZL),
          pctBasis: d.GSZZL == null ? 'T-1净值' : '实时估值',
          pricingBasis: gsz > 0 ? 'estimate' : 'lastNav',
          change: gsz > 0 ? round(gsz - nav, 4) : round((nav * num(d.NAVCHGRT)) / 100, 4),
          preClose: nav,
          isFund: true,
          marketTs: null,
          ts: Date.now(),
        };
        fundCache.set(d.FCODE, { at: now, data });
        map.set(d.FCODE, data);
      }
      const noData = missing.filter((c) => !map.has(c));
      if (noData.length) warnings.push(`${noData.length} 只基金无净值返回`);
    } catch (e) {
      warnings.push('基金接口异常' + (missing.some((c) => fundCache.has(c)) ? '，已使用缓存' : ''));
      for (const c of missing) {
        const hit = fundCache.get(c);
        if (hit) map.set(c, { ...hit.data, stale: true });
      }
      console.warn('[fund]', e.message);
    }
  }

  return { map, warnings };
}

// ---------------- 盘口（新浪五档，支持批量） ----------------
const gbk = new TextDecoder('gbk');
const bookCache = new Map();

function sinaSymbol(secid, code) {
  const [market, rawCode] = String(secid).split('.');
  const c = code || rawCode;
  if (market === '1') return 'sh' + c;
  if (/^(4|8|92)/.test(c)) return 'bj' + c;
  return 'sz' + c;
}

function parseBookLine(text) {
  const m = text.match(/="([^"]*)"/);
  if (!m || !m[1]) return null;
  const f = m[1].split(',');
  if (f.length < 32) return null;
  const bids = [];
  const asks = [];
  // 新浪字段：10~19 买五档(量,价)，20~29 卖五档(量,价)，量的单位是股
  for (let i = 0; i < 5; i++) {
    bids.push({ price: num(f[11 + i * 2]), volume: num(f[10 + i * 2]) });
    asks.push({ price: num(f[21 + i * 2]), volume: num(f[20 + i * 2]) });
  }
  return {
    name: f[0],
    open: num(f[1]),
    preClose: num(f[2]),
    price: num(f[3]),
    high: num(f[4]),
    low: num(f[5]),
    volume: num(f[8]),
    amount: num(f[9]),
    bids: bids.filter((b) => b.price > 0 && b.volume > 0),
    asks: asks.filter((a) => a.price > 0 && a.volume > 0),
    marketDate: f[30],
    marketTime: f[31],
    marketTs: f[30] && f[31] ? new Date(`${f[30]}T${f[31]}+08:00`).getTime() : null,
    ts: Date.now(),
  };
}

/** 批量取五档：一次请求多个代码，撮合轮询用 */
async function getBooksBatch(targets) {
  const now = Date.now();
  const out = new Map();
  const todo = [];
  for (const t of targets) {
    const hit = bookCache.get(t.secid);
    if (hit && now - hit.at < TTL.book) out.set(t.secid, hit.data);
    else todo.push(t);
  }
  if (!todo.length) return out;

  const symToSecid = new Map();
  for (const t of todo) symToSecid.set(sinaSymbol(t.secid, t.code), t.secid);
  const syms = [...symToSecid.keys()];

  for (let i = 0; i < syms.length; i += 40) {
    const chunk = syms.slice(i, i + 40);
    try {
      const buf = await fetchUpstream(`https://hq.sinajs.cn/list=${chunk.join(',')}`, {
        binary: true,
        referer: 'https://finance.sina.com.cn',
      });
      const raw = gbk.decode(buf);
      for (const line of raw.split('\n')) {
        const key = (line.match(/hq_str_(\w+)=/) || [])[1];
        if (!key) continue;
        const secid = symToSecid.get(key);
        if (!secid) continue;
        const data = parseBookLine(line);
        if (!data) continue;
        bookCache.set(secid, { at: now, data });
        out.set(secid, data);
      }
    } catch (e) {
      console.warn('[book]', e.message);
    }
  }
  return out;
}

async function getOrderBook(secid, code) {
  const m = await getBooksBatch([{ secid, code }]);
  const b = m.get(secid);
  if (!b) throw new Error('无盘口数据（可能非交易时段或标的无报价）');
  return b;
}

// ---------------- K 线 / 分时 / 净值 ----------------
const remoteCache = new Map();
async function cachedJSON(key, ttl, fn) {
  const now = Date.now();
  const hit = remoteCache.get(key);
  if (hit && now - hit.at < ttl) return hit.data;
  const data = await fn();
  remoteCache.set(key, { at: now, data });
  if (remoteCache.size > 500) {
    for (const [k, v] of remoteCache) if (now - v.at > 600000) remoteCache.delete(k);
  }
  return data;
}

async function getKline(secid, klt, lmt) {
  const key = `kline:${secid}:${klt}:${lmt}`;
  return cachedJSON(key, TTL.kline, async () => {
    const url =
      `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}` +
      '&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57&fqt=1' +
      `&klt=${klt}&end=20500101&lmt=${lmt}`;
    const json = await fetchJSON(url);
    const d = json?.data;
    if (!d) return { name: '', items: [], empty: true };
    const items = (d.klines || []).map((line) => {
      const [date, open, close, high, low, volume, amount] = line.split(',');
      return {
        date,
        open: num(open),
        close: num(close),
        high: num(high),
        low: num(low),
        volume: num(volume),
        amount: num(amount),
      };
    });
    return { name: d.name, items };
  });
}

async function getTrend(secid, ndays = 1) {
  const key = `trend:${secid}:${ndays}`;
  return cachedJSON(key, 15000, async () => {
    const url =
      `https://push2.eastmoney.com/api/qt/stock/trends2/get?secid=${secid}` +
      '&fields1=f1,f2,f3,f4,f5,f6,f7,f8&fields2=f51,f52,f53,f54,f55,f56,f57,f58' +
      `&iscr=0&ndays=${ndays}`;
    const json = await fetchJSON(url);
    const d = json?.data;
    if (!d) return { name: '', preClose: 0, items: [] };
    const items = (d.trends || []).map((line) => {
      const [time, open, close, high, low, volume, amount, avg] = line.split(',');
      return {
        time: time.slice(11, 16),
        full: time,
        open: num(open),
        close: num(close),
        high: num(high),
        low: num(low),
        volume: num(volume),
        amount: num(amount),
        avg: num(avg),
      };
    });
    return { name: d.name, preClose: num(d.preClose), items };
  });
}

async function getFundNav(code, size = 180) {
  const key = `nav:${code}:${size}`;
  return cachedJSON(key, TTL.nav, async () => {
    const url =
      'https://api.fund.eastmoney.com/f10/lsjz?callback=cb&fundCode=' + code +
      `&pageIndex=1&pageSize=${size}`;
    const json = await fetchJSON(url, { referer: 'https://fundf10.eastmoney.com/' });
    const list = json?.Data?.LSJZList || [];
    const items = list
      .map((d) => ({ date: d.FSRQ, close: num(d.DWJZ), pct: num(d.JZZZL) }))
      .reverse();
    return { items };
  });
}

// ---------------- 分红送转 ----------------
async function getDividendEvents(code) {
  return cachedJSON('div:' + code, TTL.dividend, async () => {
    const url =
      'https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_SHAREBONUS_DET' +
      '&columns=ALL&filter=' + encodeURIComponent(`(SECURITY_CODE="${code}")`) +
      '&pageSize=30&sortColumns=EX_DIVIDEND_DATE&sortTypes=-1';
    const json = await fetchJSON(url, { referer: 'https://data.eastmoney.com/' });
    const rows = (json && json.result && json.result.data) || [];
    return rows
      .filter((r) => r.EX_DIVIDEND_DATE && r.ASSIGN_PROGRESS === '实施分配')
      .map((r) => ({
        exDate: String(r.EX_DIVIDEND_DATE).slice(0, 10),
        recordDate: r.EQUITY_RECORD_DATE ? String(r.EQUITY_RECORD_DATE).slice(0, 10) : null,
        cashPer10: num(r.PRETAX_BONUS_RMB),
        bonusPer10: num(r.BONUS_IT_RATIO),
        plan: r.IMPL_PLAN_PROFILE || '',
      }));
  });
}

// ---------------- 搜索 ----------------
async function searchSymbol(keyword) {
  return cachedJSON('search:' + keyword.toLowerCase(), 60000, async () => {
    const url =
      'https://searchapi.eastmoney.com/api/suggest/get?input=' +
      encodeURIComponent(keyword) +
      '&type=14&token=D43BF722C8E33BDC906FB84D85E326E8&count=12';
    const json = await fetchJSON(url, { referer: 'https://www.eastmoney.com/' });
    const rows = json?.QuotationCodeTable?.Data || [];
    return rows
      .map((r) => {
        const classify = r.Classify || '';
        const code = r.Code || '';
        const isFund = classify === 'OTCFUND';
        const secid = r.QuoteID || '';
        const type = isFund
          ? 'fund'
          : classify === 'Index'
            ? 'index'
            : /ETF|LOF|基金/.test(r.SecurityTypeName || '') || /^(5|1[5-9])/.test(code)
              ? 'etf'
              : 'stock';
        return {
          code,
          name: r.Name,
          secid: isFund ? 'fund.' + code : secid,
          type,
          market: r.MarketType,
          label: r.SecurityTypeName || classify,
        };
      })
      .filter((r) => r.secid && r.code);
  });
}

// ---------------- 状态持久化 ----------------
function defaultWatchlist() {
  return [
    { secid: '1.000001', code: '000001', name: '上证指数', type: 'index' },
    { secid: '0.399001', code: '399001', name: '深证成指', type: 'index' },
    { secid: '1.600519', code: '600519', name: '贵州茅台', type: 'stock' },
    { secid: '0.300750', code: '300750', name: '宁德时代', type: 'stock' },
    { secid: '1.510300', code: '510300', name: '沪深300ETF', type: 'etf' },
    { secid: 'fund.000001', code: '000001', name: '华夏成长混合', type: 'fund' },
  ];
}

function defaultState() {
  return {
    initialCapital: 1000000,
    cash: 1000000,
    frozenCash: 0,
    watchlist: defaultWatchlist(),
    positions: {},
    orders: [],
    trades: [],
    actions: [],
    dayStart: { date: tradingDateKey(), equity: 1000000 },
    seq: 1,
    orderSeq: 1,
  };
}

function normalizePosition(p) {
  if (!Number.isFinite(p.frozen)) p.frozen = 0;
  if (!Number.isFinite(p.todayBuy)) p.todayBuy = 0;
  if (!Array.isArray(p.lots)) p.lots = p.qty > 0 ? [{ date: p.openDate || fmtDate(), qty: p.qty }] : [];
  if (!Number.isFinite(p.divReceived)) p.divReceived = 0;
  if (!Array.isArray(p.divApplied)) p.divApplied = [];
  return p;
}

function loadState() {
  try {
    const st = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (!Array.isArray(st.watchlist)) st.watchlist = defaultWatchlist();
    if (!st.positions) st.positions = {};
    if (!Array.isArray(st.orders)) st.orders = [];
    if (!Array.isArray(st.trades)) st.trades = [];
    if (!Array.isArray(st.actions)) st.actions = [];
    if (!Number.isFinite(st.frozenCash)) st.frozenCash = 0;
    // 遗留 state 没有 dayStart：留 null 交给 buildDashboard 用昨收价还原基准，
    // 不要拿现金凑数（会把持仓市值漏掉）
    if (!st.dayStart) st.dayStart = { date: tradingDateKey(), equity: null };
    if (!Number.isFinite(st.seq)) st.seq = st.trades.length + 1;
    if (!Number.isFinite(st.orderSeq)) st.orderSeq = st.orders.length + 1;
    for (const p of Object.values(st.positions)) normalizePosition(p);
    return st;
  } catch {
    const st = defaultState();
    saveState(st);
    return st;
  }
}

function saveState(st) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(st, null, 2), 'utf8');
  fs.renameSync(tmp, STATE_FILE);
}

let writeLock = Promise.resolve();
function exclusive(fn) {
  const run = writeLock.then(() => fn());
  writeLock = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

// ---------------- 账务辅助 ----------------
const isFundType = (t) => t === 'fund';
const isEtfType = (t) => t === 'etf';

function availableOf(p) {
  if (!p) return 0;
  if (isFundType(p.type)) return round(p.qty - (p.frozen || 0), 2);
  return Math.max(0, round(p.qty - (p.todayBuy || 0) - (p.frozen || 0), 4));
}

function holdDaysOf(dateStr, now = new Date()) {
  if (!dateStr) return 0;
  const d = new Date(dateStr + 'T00:00:00');
  if (Number.isNaN(d.getTime())) return 0;
  return Math.max(0, Math.floor((now - d) / 86400000));
}

/** FIFO 消耗持仓批次，返回 [{qty, days}] */
function consumeLots(pos, qty, now = new Date()) {
  const out = [];
  let remain = qty;
  const lots = pos.lots || (pos.lots = []);
  while (remain > 1e-6 && lots.length) {
    const lot = lots[0];
    const take = Math.min(remain, lot.qty);
    out.push({ qty: take, days: holdDaysOf(lot.date, now) });
    lot.qty = round(lot.qty - take, 4);
    remain = round(remain - take, 4);
    if (lot.qty <= 1e-6) lots.shift();
  }
  if (remain > 1e-6) out.push({ qty: remain, days: holdDaysOf(pos.openDate, now) });
  return out;
}

function freezeBuyCash(price, qty, type) {
  const amount = price * qty;
  const fee = isFundType(type)
    ? { total: round(amount * FEES.fundBuyFee, 2) }
    : R.stockFee(amount, 'buy', isEtfType(type), FEES);
  return round(amount + fee.total, 2);
}

function statusLabel(s) {
  return (
    {
      pending: '待成交',
      partial: '部分成交',
      filled: '已成交',
      cancelled: '已撤单',
      expired: '已失效',
      rejected: '已废单',
    }[s] || s
  );
}

// ---------------- 除权除息 ----------------
/**
 * 除权除息日按持仓处理三件事：现金分红入账、送转股增加股数、成本价摊薄。
 * 红利个税按差别化政策在卖出时补扣（见 settleFill）。
 */
async function applyCorporateActions(st, now) {
  const today = fmtDate(now);
  const changes = [];
  for (const p of Object.values(st.positions)) {
    if (isFundType(p.type) || !(p.qty > 0)) continue;
    if (p.divApplied.includes(today)) continue;
    let events = [];
    try {
      events = await getDividendEvents(p.code);
    } catch (e) {
      console.warn('[dividend]', p.code, e.message);
      continue;
    }
    const ev = events.find((x) => x.exDate === today);
    if (!ev) {
      p.divApplied.push(today);
      if (p.divApplied.length > 60) p.divApplied = p.divApplied.slice(-60);
      continue;
    }
    const cashPerShare = ev.cashPer10 / 10;
    const bonusPerShare = ev.bonusPer10 / 10;
    const oldQty = p.qty;
    const oldCost = p.cost;

    const cash = round(cashPerShare * oldQty, 2);
    const addQty = Math.floor(bonusPerShare * oldQty + 1e-9);
    const newQty = oldQty + addQty;

    if (cash > 0) {
      st.cash = round(st.cash + cash, 2);
      p.divReceived = round((p.divReceived || 0) + cash, 2);
    }
    if (addQty > 0) {
      p.qty = newQty;
      const lots = p.lots || (p.lots = []);
      if (lots.length) lots[0].qty = round(lots[0].qty + addQty, 4);
      else lots.push({ date: p.openDate || today, qty: addQty });
    }
    if (newQty > 0) p.cost = round(Math.max(0, (oldCost * oldQty - cash) / newQty), 4);

    p.divApplied.push(today);
    if (p.divApplied.length > 60) p.divApplied = p.divApplied.slice(-60);

    const rec = {
      date: today,
      code: p.code,
      name: p.name,
      plan: ev.plan,
      cash,
      addQty,
      qtyBefore: oldQty,
      qtyAfter: newQty,
      costBefore: oldCost,
      costAfter: p.cost,
    };
    st.actions.unshift(rec);
    changes.push(rec);
  }
  if (st.actions.length > 100) st.actions.length = 100;
  return changes;
}

// ---------------- 委托与撮合 ----------------
const LIVE_STATUS = new Set(['pending', 'partial']);

function liveOrders(st) {
  return st.orders.filter((o) => LIVE_STATUS.has(o.status));
}

function newOrderId(st) {
  return 'O' + String(st.orderSeq++).padStart(6, '0');
}

function alignTick(price, tick) {
  return R.roundTick(price, tick, 'half');
}

/**
 * 从盘口吃单。levels 是可变对象，同一标的多笔委托共享，模拟逐档被消耗。
 * 限价单只在价格满足时成交；市价单吃满五档后剩余撤销。
 */
function takeFromLevels(order, levels) {
  const fills = [];
  let remain = order.qty - order.filledQty;
  for (const lv of levels) {
    if (remain <= 1e-9) break;
    if (!(lv.volume > 0) || !(lv.price > 0)) continue;
    if (order.orderType === 'limit') {
      if (order.side === 'buy' && lv.price > order.price + 1e-9) break;
      if (order.side === 'sell' && lv.price < order.price - 1e-9) break;
    }
    const take = Math.min(remain, lv.volume);
    lv.volume -= take;
    remain -= take;
    fills.push({ price: lv.price, qty: take });
  }
  return fills;
}

/** 结算一笔成交：改账、改持仓、算费用 */
function settleFill(st, order, fill, now) {
  const isFund = isFundType(order.type);
  const isEtf = isEtfType(order.type);
  const amount = round(fill.price * fill.qty, 2);
  const fee = isFund
    ? { total: 0, commission: 0, transfer: 0, stamp: 0 }
    : R.stockFee(amount, order.side, isEtf, FEES);

  if (order.side === 'buy') {
    const cost = round(amount + fee.total, 2);
    st.frozenCash = round(Math.max(0, st.frozenCash - cost), 2);
    order.frozen = round(Math.max(0, order.frozen - cost), 2);

    const key = order.secid;
    let p = st.positions[key];
    if (!p) {
      p = st.positions[key] = {
        secid: order.secid,
        code: order.code,
        name: order.name,
        type: order.type,
        qty: 0,
        frozen: 0,
        todayBuy: 0,
        cost: 0,
        openDate: fmtDate(now),
        lots: [],
        divReceived: 0,
        divApplied: [],
      };
    }
    const totalCost = p.cost * p.qty + cost;
    p.qty = round(p.qty + fill.qty, 4);
    p.cost = round(totalCost / p.qty, 4);
    if (!isFund) p.todayBuy = round((p.todayBuy || 0) + fill.qty, 4);

    const lots = p.lots || (p.lots = []);
    const today = fmtDate(now);
    const same = lots.find((l) => l.date === today);
    if (same) same.qty = round(same.qty + fill.qty, 4);
    else lots.push({ date: today, qty: fill.qty });

    return { amount, fee: fee.total, feeDetail: fee, realizedPnl: null, holdDays: null, divTax: 0 };
  }

  const p = st.positions[order.secid];
  if (!p) throw new Error('持仓已不存在');
  const consumed = consumeLots(p, fill.qty, now);
  const totalLotQty = consumed.reduce((s, l) => s + l.qty, 0) || 1e-9;
  const weightedDays = Math.round(consumed.reduce((s, l) => s + l.qty * l.days, 0) / totalLotQty);

  let divTax = 0;
  if (!isFund && p.divReceived > 0) {
    const portion = Math.min(1, fill.qty / Math.max(1e-9, p.qty));
    const divPortion = round(p.divReceived * portion, 2);
    divTax = round(divPortion * R.dividendTaxRate(weightedDays, FEES), 2);
    p.divReceived = round(Math.max(0, p.divReceived - divPortion), 2);
  }

  const realized = round((fill.price - p.cost) * fill.qty - fee.total - divTax, 2);
  st.cash = round(st.cash + amount - fee.total - divTax, 2);
  p.qty = round(p.qty - fill.qty, 4);
  if (p.frozen > 0) p.frozen = round(Math.max(0, p.frozen - fill.qty), 2);
  if (p.qty <= 1e-6) delete st.positions[order.secid];

  return { amount, fee: fee.total, feeDetail: fee, realizedPnl: realized, holdDays: weightedDays, divTax };
}

function recordTrade(st, order, fill, settle, now) {
  const t = {
    id: st.seq++,
    orderId: order.id,
    ts: now.toISOString(),
    time: `${fmtDate(now)} ${fmtTime(now)}`,
    secid: order.secid,
    code: order.code,
    name: order.name,
    type: order.type,
    side: order.side,
    price: round(fill.price, order.type === 'etf' ? 3 : 4),
    qty: fill.qty,
    amount: settle.amount,
    fee: settle.fee,
    feeDetail: settle.feeDetail,
    orderType: order.orderType,
  };
  if (settle.realizedPnl != null) t.realizedPnl = settle.realizedPnl;
  if (settle.holdDays != null) t.holdDays = settle.holdDays;
  t.divTax = settle.divTax || 0;

  st.trades.unshift(t);
  if (st.trades.length > 500) st.trades.length = 500;
  return t;
}

function applyFills(st, order, fills, now) {
  const out = [];
  for (const f of fills) {
    const q = Math.round(f.qty * 100) / 100;
    if (!(q > 0)) continue;
    order.filledQty = round(order.filledQty + q, 4);
    if (order.side === 'sell') order.frozenQty = round(Math.max(0, (order.frozenQty || 0) - q), 4);
    const settle = settleFill(st, order, { price: f.price, qty: q }, now);
    order.filledAmount = round(order.filledAmount + settle.amount, 2);
    order.feeTotal = round(order.feeTotal + settle.fee, 2);
    order.fills.push({
      ts: now.toISOString(),
      time: fmtTime(now),
      price: round(f.price, 3),
      qty: q,
      amount: settle.amount,
      fee: settle.fee,
    });
    if (order.fills.length > 50) order.fills.length = 50;
    out.push(recordTrade(st, order, { price: f.price, qty: q }, settle, now));
  }
  return out;
}

/** 结束委托：解冻剩余资金/股份并按成交量定性状态 */
function finishOrder(st, order, status, reason) {
  if (!LIVE_STATUS.has(order.status)) return;
  const partial = order.filledQty > 0;
  if (status === 'filled') order.status = 'filled';
  else if (status === 'cancelled') order.status = 'cancelled';
  else if (status === 'expired') order.status = 'expired';
  else order.status = status;
  if (partial && status !== 'filled') order.status = 'cancelled';
  order.updatedAt = Date.now();
  if (reason) order.reason = reason;

  if (order.side === 'buy' && order.frozen > 0) {
    st.cash = round(st.cash + order.frozen, 2);
    st.frozenCash = round(Math.max(0, st.frozenCash - order.frozen), 2);
    order.frozen = 0;
  }
  if (order.side === 'sell' && order.frozenQty > 0) {
    const p = st.positions[order.secid];
    if (p) p.frozen = round(Math.max(0, (p.frozen || 0) - order.frozenQty), 2);
    order.frozenQty = 0;
  }
}

/** 撮合一轮 */
let matchBusy = false;
async function matchTick() {
  if (matchBusy) return;
  matchBusy = true;
  try {
    const snapshot = loadState();
    const live = liveOrders(snapshot);
    if (!live.length) return;

    const now = new Date();
    const today = tradingDateKey(now);
    const sess = sessionState(now);
    const secs = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
    const isToday = (o) => o.tradeDate === today || o.phase === 'immediate';

    const needBook = live.filter((o) => isToday(o) && o.phase === 'continuous' && sess.phase === 'continuous');
    const needQuote = live.filter(
      (o) =>
        isToday(o) &&
        ((o.phase === 'immediate') ||
          (o.phase === 'auction_open' && secs >= 9 * 3600 + 25 * 60) ||
          ((o.phase === 'auction_close' || o.phase === 'after_hours') && secs >= 15 * 3600))
    );
    const hasStale = live.some((o) => !isToday(o));
    if (!needBook.length && !needQuote.length && !hasStale) return;

    const books = needBook.length
      ? await getBooksBatch([...new Map(needBook.map((o) => [o.secid, { secid: o.secid, code: o.code }])).values()])
      : new Map();

    let quotes = new Map();
    if (needQuote.length) {
      quotes = (await getQuotes([...new Set(needQuote.map((o) => o.secid))])).map;
    }

    // 深度副本：同标的委托共享，逐档被吃
    const depth = new Map();
    for (const [secid, b] of books) {
      depth.set(secid, {
        asks: b.asks.map((x) => ({ price: x.price, volume: x.volume })),
        bids: b.bids.map((x) => ({ price: x.price, volume: x.volume })),
      });
    }

    await exclusive(async () => {
      const st = loadState();
      const byId = new Map(st.orders.map((o) => [o.id, o]));
      let touched = false;

      // 价格优先、时间优先
      const sorted = [...live].sort((a, b) => {
        if (a.side !== b.side) return a.side === 'buy' ? -1 : 1;
        const pa = a.price == null ? a.refPrice : a.price;
        const pb = b.price == null ? b.refPrice : b.price;
        if (pa !== pb) return a.side === 'buy' ? pb - pa : pa - pb;
        return new Date(a.ts) - new Date(b.ts);
      });

      for (const snap of sorted) {
        const o = byId.get(snap.id);
        if (!o || !LIVE_STATUS.has(o.status)) continue;

        // A 股委托当日有效
        if (!isToday(o)) {
          finishOrder(st, o, 'expired', '委托当日有效，收盘后自动失效');
          touched = true;
          continue;
        }

        let fills = [];
        if (o.phase === 'continuous' && sess.phase === 'continuous') {
          const d = depth.get(o.secid);
          if (!d) continue;
          const levels = o.side === 'buy' ? d.asks : d.bids;
          if (!levels.length) continue; // 涨停无卖盘 / 跌停无买盘
          fills = takeFromLevels(o, levels);
        } else if (o.phase === 'auction_open' && secs >= 9 * 3600 + 25 * 60) {
          const q = quotes.get(o.secid);
          const open = q && q.open > 0 ? q.open : 0;
          if (!open) continue;
          const ok = o.orderType === 'market' ? true : o.side === 'buy' ? o.price >= open : o.price <= open;
          if (ok) fills = [{ price: open, qty: o.qty - o.filledQty }];
        } else if ((o.phase === 'auction_close' || o.phase === 'after_hours') && secs >= 15 * 3600) {
          const q = quotes.get(o.secid);
          const close = q ? q.price : 0;
          if (!close) continue;
          const ok = o.orderType === 'market' ? true : o.side === 'buy' ? o.price >= close : o.price <= close;
          if (ok) fills = [{ price: close, qty: o.qty - o.filledQty }];
        } else if (o.phase === 'immediate') {
          const q = quotes.get(o.secid);
          if (!q || !(q.price > 0)) continue;
          fills = [{ price: q.price, qty: o.qty - o.filledQty }];
        }

        if (fills.length) {
          applyFills(st, o, fills, new Date());
          touched = true;
        }

        if (o.filledQty >= o.qty - 1e-9) {
          finishOrder(st, o, 'filled');
          touched = true;
        } else if (o.orderType === 'market') {
          finishOrder(
            st,
            o,
            'cancelled',
            o.filledQty > 0 ? '市价委托部分成交，剩余自动撤销' : '五档无对手盘，委托撤销'
          );
          touched = true;
        } else if (o.filledQty > 0) {
          o.status = 'partial';
          o.updatedAt = Date.now();
          touched = true;
        }
      }

      if (touched) saveState(st);
    });
  } catch (e) {
    console.warn('[match]', e.message);
  } finally {
    matchBusy = false;
  }
}

// ---------------- 下单 ----------------
async function submitOrder(body, now = new Date()) {
  const { secid, code, type = 'stock', side } = body;
  if (!secid || !code) throw new Error('参数不完整');
  if (!['buy', 'sell'].includes(side)) throw new Error('方向不合法');
  if (type === 'index') throw new Error('指数不可直接交易');

  const sess = sessionState(now);
  if (!sess.accept && !body.force && !ALLOW_OFF_HOURS) {
    const e = new Error(`当前${sess.label}，交易所不接受申报`);
    e.code = 'OFF_HOURS';
    throw e;
  }
  if (isFundType(type)) return submitFundOrder(body, now);
  return submitStockOrder(body, sess, now);
}

async function submitStockOrder(body, sess, now) {
  const { secid, code, name, type = 'stock', side } = body;
  const isEtf = isEtfType(type);
  const orderType = body.orderType === 'market' ? 'market' : 'limit';

  const q = await getQuote(secid);
  if (!q) throw new Error('未获取到行情，已拒绝下单（避免按错误价格成交）');
  if (q.suspended) throw new Error(`${q.name} 当前停牌，无法交易`);
  if (q.stale) throw new Error('行情数据已过期，已拒绝下单，请稍后重试');
  if (!(q.price > 0)) throw new Error('行情价格无效');

  // ---- 账户资质：未开通的板块禁止买入 ----
  // 只拦买入。卖出永远放行 —— 否则权限收紧后存量持仓无法退出。
  if (side === 'buy') {
    const perm = R.permissionOf({ code, name: q.name || name, type, permissions: loadAccountPermissions() });
    if (!perm.allowed) {
      const e = new Error(
        `账户未开通${perm.label}：需 ${perm.need}。当前为模拟「新开户」账户（5 万本金 / 无交易经验），` +
          `只能交易沪深主板与场内基金；科创板 ETF、创业板 ETF 不受此限。` +
          `如确需放开，改 data/autotrade.json 的 account.permissions`
      );
      e.code = 'NO_PERMISSION';
      throw e;
    }
  }

  const tick = R.tickOf(code, type);
  const lot = R.lotOf(code, type);
  const lim = R.priceLimit({
    code,
    name: q.name || name,
    type,
    preClose: q.preClose,
    listDate: q.listDate,
    now,
    holidays: HOLIDAYS,
  });

  // 盘后固定价格交易仅科创板 / 创业板
  if (sess.afterHours && !['star', 'gem'].includes(lot.board)) {
    throw new Error('盘后固定价格交易仅支持科创板、创业板标的');
  }

  // ---- 价格 ----
  let price = 0;
  if (sess.afterHours) {
    // 盘后固定价格交易只有一个成交价：当日收盘价
    if (orderType === 'market') throw new Error('盘后固定价格交易仅接受限价申报');
    price = q.price;
  } else if (orderType === 'limit') {
    price = alignTick(num(body.price), tick);
    if (!(price > 0)) throw new Error('请输入有效委托价');
    if (!lim.unlimited) {
      if (price > lim.up + 1e-9) throw new Error(`委托价 ${price} 高于涨停价 ${lim.up}（${lim.reason}）`);
      if (price < lim.down - 1e-9) throw new Error(`委托价 ${price} 低于跌停价 ${lim.down}（${lim.reason}）`);
    }
  } else {
    if (sess.phase !== 'continuous') throw new Error('市价委托仅支持连续竞价时段（09:30-11:30 / 13:00-14:57）');
    price = q.price;
  }

  // ---- 数量 ----
  const qty = Math.floor(Number(body.qty));
  if (side === 'buy') {
    if (!(qty > 0)) throw new Error('买入数量必须大于 0');
    if (qty < lot.buyMin) throw new Error(`买入数量不得低于 ${lot.buyMin} 股（${lot.board}）`);
    if ((qty - lot.buyMin) % lot.step !== 0) throw new Error(`买入数量须 ${lot.buyMin} 股起、${lot.step} 股递增`);
  } else if (!(qty > 0)) {
    throw new Error('卖出数量必须大于 0');
  }

  // ---- 验资 / 验券（券商端先行拦截）----
  const st0 = loadState();
  const refPrice = orderType === 'market' ? (lim.unlimited ? q.price * 1.1 : lim.up) : price;
  if (side === 'buy') {
    const need = freezeBuyCash(refPrice, qty, type);
    if (need > st0.cash + 0.001) {
      throw new Error(`可用资金不足，需冻结 ¥${need.toLocaleString()}，当前可用 ¥${st0.cash.toLocaleString()}`);
    }
  } else {
    const pos = st0.positions[secid];
    if (!pos || pos.qty <= 0) throw new Error('当前无持仓');
    const avail = availableOf(pos);
    if (avail <= 0) {
      throw new Error(
        pos.todayBuy > 0
          ? `T+1 限制：今日买入 ${pos.todayBuy} 股，下一交易日才可卖`
          : '可用股份已被其他委托冻结'
      );
    }
    if (qty > avail) {
      throw new Error(`可卖 ${avail} 股（今日买入 ${pos.todayBuy || 0} 股，挂单冻结 ${pos.frozen || 0} 股）`);
    }
    if (lot.step > 1 && qty % lot.step !== 0 && qty !== avail) {
      throw new Error(`卖出须 ${lot.step} 股整数倍，或把零股 ${avail} 股一次性卖出`);
    }
  }

  // ---- 价格笼子（连续竞价限价申报，交易所端校验）----
  if (orderType === 'limit' && sess.phase === 'continuous') {
    let bid1 = null;
    let ask1 = null;
    try {
      const b = await getOrderBook(secid, code);
      bid1 = b.bids[0] ? b.bids[0].price : null;
      ask1 = b.asks[0] ? b.asks[0].price : null;
    } catch {
      /* 无盘口时退化为按最新价 */
    }
    const cage = R.priceCage({ side, last: q.price, bid1, ask1, tick });
    if (cage) {
      if (side === 'buy' && price > cage.max + 1e-9) {
        throw new Error(`委托价高于价格笼子上限 ${cage.max}（基准价 ${cage.base}×102%），交易所将废单`);
      }
      if (side === 'sell' && price < cage.min - 1e-9) {
        throw new Error(`委托价低于价格笼子下限 ${cage.min}（基准价 ${cage.base}×98%），交易所将废单`);
      }
    }
  }

  // ---- 建单 ----
  const order = await exclusive(async () => {
    const st = loadState();
    const phase = body.force && !sess.accept ? 'immediate' : sess.phase || (sess.afterHours ? 'after_hours' : null);
    if (!phase) {
      const e = new Error(`当前${sess.label}，交易所不接受申报`);
      e.code = 'OFF_HOURS';
      throw e;
    }

    const need = side === 'buy' ? freezeBuyCash(refPrice, qty, type) : 0;
    const o = {
      id: newOrderId(st),
      ts: now.toISOString(),
      time: `${fmtDate(now)} ${fmtTime(now)}`,
      tradeDate: tradingDateKey(now),
      secid,
      code,
      name: q.name || name || code,
      type,
      side,
      orderType,
      price: orderType === 'market' ? null : price,
      refPrice: orderType === 'market' ? refPrice : price,
      qty,
      filledQty: 0,
      filledAmount: 0,
      feeTotal: 0,
      frozen: need,
      frozenQty: side === 'sell' ? qty : 0,
      status: 'pending',
      phase,
      offHours: !sess.accept,
      fills: [],
    };

    if (side === 'buy') {
      if (need > st.cash + 0.001) throw new Error('可用资金不足');
      st.cash = round(st.cash - need, 2);
      st.frozenCash = round(st.frozenCash + need, 2);
    } else {
      const p = st.positions[secid];
      if (!p) throw new Error('当前无持仓');
      p.frozen = round((p.frozen || 0) + qty, 2);
    }

    st.orders.unshift(o);
    if (st.orders.length > 300) st.orders.length = 300;
    saveState(st);
    return o;
  });

  await matchTick();

  const after = loadState();
  return {
    order: after.orders.find((x) => x.id === order.id) || order,
    trades: after.trades.filter((t) => t.orderId === order.id),
    cash: after.cash,
    frozenCash: after.frozenCash,
  };
}

async function submitFundOrder(body, now) {
  const { code, name, side } = body;
  const { map } = await getFunds([code]);
  const f = map.get(code);
  if (!f) throw new Error('未获取到基金净值，暂无法申赎');
  if (!(f.price > 0)) throw new Error('基金净值无效');

  const price = f.price;
  const { applyDate, effectiveToday } = R.fundApplyDate(now, HOLIDAYS);
  const confirmDate = nextTradingDateKey(new Date(applyDate + 'T12:00:00'), 1);
  const basis = f.pctBasis === '实时估值' ? '盘中估值' : 'T-1净值';

  return exclusive(async () => {
    const st = loadState();
    const key = 'fund.' + code;
    const p = st.positions[key];
    const orderId = newOrderId(st);
    const base = {
      orderId,
      ts: now.toISOString(),
      time: `${fmtDate(now)} ${fmtTime(now)}`,
      secid: key,
      code,
      name: f.name || name || code,
      type: 'fund',
      side,
      orderType: 'limit',
      pricingBasis: basis,
      navDate: f.navDate || null,
      applyDate,
      effectiveToday,
      confirmDate,
    };

    let trade;
    if (side === 'buy') {
      let amount = round(num(body.amount), 2);
      if (!(amount > 0)) amount = round(price * num(body.qty), 2);
      if (amount < 100) throw new Error('申购金额不能低于 ¥100');
      if (amount > st.cash + 0.001) throw new Error('可用资金不足');
      const fee = round(amount * FEES.fundBuyFee, 2);
      const shares = round((amount - fee) / price, 2);
      st.cash = round(st.cash - amount, 2);
      if (p) {
        const totalCost = p.cost * p.qty + amount;
        p.qty = round(p.qty + shares, 4);
        p.cost = round(totalCost / p.qty, 4);
        p.lots = p.lots || [];
        const today = fmtDate(now);
        const same = p.lots.find((l) => l.date === today);
        if (same) same.qty = round(same.qty + shares, 4);
        else p.lots.push({ date: today, qty: shares });
      } else {
        st.positions[key] = {
          secid: key,
          code,
          name: base.name,
          type: 'fund',
          qty: shares,
          frozen: 0,
          todayBuy: 0,
          cost: round(amount / shares, 4),
          openDate: fmtDate(now),
          lots: [{ date: fmtDate(now), qty: shares }],
          divReceived: 0,
          divApplied: [],
        };
      }
      trade = { ...base, price, qty: shares, amount, fee, feeDetail: { total: fee }, id: st.seq++ };
    } else {
      if (!p || p.qty <= 0) throw new Error('当前无基金持仓');
      let shares = round(num(body.qty), 2);
      if (!(shares > 0) || shares > p.qty) shares = p.qty;
      const gross = round(shares * price, 2);
      const consumed = consumeLots(p, shares, now);
      let fee = 0;
      let feeW = 0;
      for (const c of consumed) {
        fee = round(fee + round(c.qty * price * R.fundRedeemRate(c.days, FEES), 2), 2);
        feeW += c.qty * c.days;
      }
      const holdDays = shares > 0 ? Math.round(feeW / shares) : 0;
      const realized = round(gross - fee - p.cost * shares, 2);
      st.cash = round(st.cash + gross - fee, 2);
      p.qty = round(p.qty - shares, 4);
      if (p.qty <= 0.005) delete st.positions[key];
      trade = {
        ...base,
        price,
        qty: shares,
        amount: gross,
        fee,
        feeDetail: { total: fee },
        realizedPnl: realized,
        holdDays,
        redeemRate: gross > 0 ? round(fee / gross, 6) : 0,
        id: st.seq++,
      };
    }

    st.trades.unshift(trade);
    if (st.trades.length > 500) st.trades.length = 500;
    saveState(st);
    return { order: null, trade, trades: [trade], cash: st.cash, frozenCash: st.frozenCash };
  });
}

// ---------------- 撤单 ----------------
async function cancelOrder(id) {
  const sess = sessionState();
  return exclusive(async () => {
    const st = loadState();
    const o = st.orders.find((x) => x.id === id);
    if (!o) throw new Error('委托不存在');
    if (!LIVE_STATUS.has(o.status)) throw new Error(`该委托${statusLabel(o.status)}，无法撤单`);
    if (!sess.cancelable) {
      const e = new Error(`当前${sess.label}，交易所不接受撤单`);
      e.code = 'NO_CANCEL';
      throw e;
    }
    finishOrder(st, o, 'cancelled', '客户撤单');
    saveState(st);
    return { id: o.id, status: o.status };
  });
}

// ---------------- 账户重置 ----------------
function resetAccount(body) {
  return exclusive(async () => {
    const capital = num(body.capital) > 0 ? num(body.capital) : 1000000;
    const st = loadState();
    const keepWatch = body.keepWatch !== false;
    const fresh = defaultState();
    fresh.cash = capital;
    fresh.initialCapital = capital;
    fresh.watchlist = keepWatch ? st.watchlist : defaultWatchlist();
    fresh.dayStart = { date: tradingDateKey(), equity: capital };
    saveState(fresh);
    return { capital };
  });
}

// ---------------- 看板 ----------------
async function buildDashboard() {
  let st = loadState();

  // 日切：先处理除权除息，再重置 T+1 可卖数量
  const todayKey = tradingDateKey();
  if (st.dayStart?.date !== todayKey) {
    await exclusive(async () => {
      const fresh = loadState();
      if (fresh.dayStart?.date === todayKey) return;
      try {
        await applyCorporateActions(fresh, new Date());
      } catch (e) {
        console.warn('[dividend]', e.message);
      }
      fresh.dayStart = { date: todayKey, equity: null };
      for (const p of Object.values(fresh.positions)) {
        p.todayBuy = 0;
        if (p.frozen > p.qty) p.frozen = p.qty;
      }
      saveState(fresh);
    });
    st = loadState();
  }

  const posList = Object.values(st.positions);
  const secids = [
    ...st.watchlist.filter((w) => w.type !== 'fund').map((w) => w.secid),
    ...posList.filter((p) => p.type !== 'fund').map((p) => p.secid),
  ];
  const fundCodes = [
    ...st.watchlist.filter((w) => w.type === 'fund').map((w) => w.code),
    ...posList.filter((p) => p.type === 'fund').map((p) => p.code),
  ];

  const [qres, fres] = await Promise.all([getQuotes(secids), getFunds(fundCodes)]);
  const quoteMap = qres.map;
  const fundMap = fres.map;
  const warnings = [...qres.warnings, ...fres.warnings];

  let quoteTime = 0;
  for (const q of quoteMap.values()) if (q.marketTs && q.marketTs > quoteTime) quoteTime = q.marketTs;

  const watch = st.watchlist.map((w) => {
    const isFund = w.type === 'fund';
    const q = isFund ? fundMap.get(w.code) : quoteMap.get(w.secid);
    const lim =
      isFund || w.type === 'index'
        ? null
        : R.priceLimit({
            code: w.code,
            name: q?.name || w.name,
            type: w.type,
            preClose: q?.preClose,
            listDate: q?.listDate,
            holidays: HOLIDAYS,
          });
    return {
      ...w,
      ...(q || {}),
      type: w.type,
      secid: w.secid,
      code: w.code,
      name: q?.name || w.name,
      price: q ? q.price : null,
      pct: q ? q.pct : null,
      change: q?.change ?? null,
      preClose: q?.preClose ?? null,
      dataState: !q ? 'missing' : q.stale ? 'stale' : 'ok',
      marketTs: q?.marketTs ?? null,
      pctBasis: q?.pctBasis || null,
      limitUp: lim?.up ?? null,
      limitDown: lim?.down ?? null,
    };
  });

  let marketValue = 0;
  const positions = posList.map((p) => {
    const q = p.type === 'fund' ? fundMap.get(p.code) : quoteMap.get(p.secid);
    const price = q?.price ?? p.cost;
    const mv = price * p.qty;
    const pnl = (price - p.cost) * p.qty;
    marketValue += mv;
    const lim =
      p.type === 'fund' || p.type === 'index'
        ? null
        : R.priceLimit({
            code: p.code,
            name: q?.name || p.name,
            type: p.type,
            preClose: q?.preClose,
            listDate: q?.listDate,
            holidays: HOLIDAYS,
          });
    return {
      ...p,
      name: q?.name || p.name,
      price,
      preClose: q?.preClose || price,
      open: q?.open ?? 0,
      high: q?.high ?? 0,
      low: q?.low ?? 0,
      change: q?.change ?? null,
      volume: q?.volume ?? 0,
      turnover: q?.turnover ?? 0,
      mktCap: q?.mktCap ?? 0,
      marketTs: q?.marketTs ?? null,
      pct: q?.preClose ? round((price / q.preClose - 1) * 100, 2) : 0,
      marketValue: round(mv, 2),
      pnl: round(pnl, 2),
      pnlPct: p.cost ? round((price / p.cost - 1) * 100, 2) : 0,
      dayPnl: round((price - (q?.preClose || price)) * p.qty, 2),
      available: availableOf(p),
      frozen: p.frozen || 0,
      limitUp: lim?.up ?? null,
      limitDown: lim?.down ?? null,
      dataState: !q ? 'missing' : q.stale ? 'stale' : 'ok',
    };
  });

  const totalAsset = round(st.cash + st.frozenCash + marketValue, 2);
  const sess = sessionState();

  // 日初权益基准（dayStart.equity）—— 当日盈亏的分母
  // 算法与两条硬约束见 core/pnl.js 顶部注释（11-17 基准被写成成本市值，当日盈亏退化成累计浮盈）
  const valComplete = positions.every((p) => p.dataState === 'ok' && p.preClose > 0);
  const baseCalc = PNL.dayStartBaseline({ totalAsset, positions });
  let dayStartEq = st.dayStart?.equity ?? null;
  if (dayStartEq == null && baseCalc.ready) {
    const base = baseCalc.baseline;
    await exclusive(async () => {
      const fresh = loadState();
      if (fresh.dayStart?.date === todayKey && fresh.dayStart.equity == null) {
        fresh.dayStart.equity = base;
        saveState(fresh);
      }
    });
    // 并发下别人可能已经写入，以落盘值为准
    dayStartEq = loadState().dayStart?.equity ?? base;
    st.dayStart = { ...(st.dayStart || {}), date: todayKey, equity: dayStartEq };
  }

  // 基准缺失（行情整天不通）或本轮取价不完整（成本兜底）时，当日盈亏不可信，输出 null 让上层显示「—」
  const dayPnlReady = valComplete && dayStartEq != null;

  if (warnings.length) console.warn('[dashboard]', warnings.join(' / '));

  return {
    account: {
      cash: round(st.cash, 2),
      frozenCash: round(st.frozenCash, 2),
      totalCash: round(st.cash + st.frozenCash, 2),
      marketValue: round(marketValue, 2),
      totalAsset,
      initialCapital: st.initialCapital,
      totalPnl: round(totalAsset - st.initialCapital, 2),
      totalPnlPct: round((totalAsset / st.initialCapital - 1) * 100, 2),
      dayPnl: dayPnlReady ? round(totalAsset - dayStartEq, 2) : null,
      dayPnlPct: dayPnlReady && dayStartEq ? round((totalAsset / dayStartEq - 1) * 100, 2) : null,
      dayPnlReady,
      dayStartEquity: dayStartEq,
      positionCount: positions.length,
      openOrders: liveOrders(st).length,
    },
    watch,
    positions,
    orders: st.orders.slice(0, 60).map((o) => ({
      ...o,
      statusLabel: statusLabel(o.status),
      displayPrice: o.price == null ? o.refPrice : o.price,
    })),
    trades: st.trades.slice(0, 80),
    actions: st.actions.slice(0, 20),
    rule: FEES,
    meta: {
      serverTime: Date.now(),
      serverClock: fmtTime(),
      // serverDate 是真实日历日；tradingDate 是「归属交易日」（09:15 前算上一交易日）。
      // 两者在盘前会差一天，别把 tradingDate 当时钟用——显示层要分开写。
      serverDate: fmtDate(),
      tradingDate: todayKey,
      session: sess,
      quoteTime: quoteTime || null,
      quoteAge: quoteTime ? Math.max(0, Math.round((Date.now() - quoteTime) / 1000)) : null,
      warnings,
      allowOffHours: ALLOW_OFF_HOURS,
    },
  };
}

// ---------------- HTTP ----------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

// ---------------- 价格区间监控（盯盘台主动叫醒） ----------------
const B = require('./core/bands');
const J = require('./core/journal');
const { spawn } = require('child_process');

const BAND_SESSIONS = new Set(['auction', 'auction_lock', 'pre_open', 'open', 'close_auction']);
const BAND_LIVE = {
  startAt: 0,
  checks: 0,
  lastCheck: null,
  lastError: null,
  lastFire: null,
  agentRunning: false,
  fired: [],
};
let bandTimer = null;

function bandSnapshots() {
  const cfg = B.loadConfig();
  const st = B.loadState();
  return cfg.bands.map((b) => {
    const s = st.bands[b.id || b.code] || {};
    return {
      ...b,
      armed: s.armed !== false,
      side: s.side || null,
      prevPrice: Number.isFinite(Number(s.prevPrice)) ? Number(s.prevPrice) : null,
      lastFiredAt: s.lastFiredAt || b.lastFiredAt || '',
    };
  });
}

function startBandMonitor() {
  if (bandTimer) return;
  BAND_LIVE.startAt = Date.now();
  scheduleBandTick(1200);
}

function scheduleBandTick(ms) {
  if (bandTimer) clearTimeout(bandTimer);
  bandTimer = setTimeout(bandTick, ms);
  if (bandTimer.unref) bandTimer.unref();
}

/** 单次判定：取价 → 判穿越 → 落状态。force=true 时忽略交易时段（手动/巡检调用） */
async function bandCheck({ force = false } = {}) {
  const cfg = B.loadConfig();
  const active = cfg.bands.filter((b) => b.enabled && b.secid);
  if (!active.length) return { cfg, fired: [], skipped: 'no-bands' };
  if (!BAND_SESSIONS.has(sessionState().code) && !force) return { cfg, fired: [], skipped: 'closed' };
  const { map } = await getQuotes(active.map((b) => b.secid));
  const priceMap = new Map();
  for (const [secid, q] of map) {
    priceMap.set(secid, q);
    if (q && q.code) priceMap.set(q.code, q);
  }
  const st = B.rollState(B.loadState());
  const fired = B.evaluateAll(cfg, st, priceMap, new Date());
  B.saveState(st);
  BAND_LIVE.checks += 1;
  BAND_LIVE.lastCheck = new Date().toISOString();
  for (const f of fired) await onBandFire(cfg, f);
  return { cfg, fired, skipped: null };
}

async function bandTick() {
  let delay = 20000;
  try {
    const cfg = B.loadConfig();
    delay = Math.max(5, num(cfg.pollSeconds || 20)) * 1000;
    const r = await bandCheck({ force: process.env.TD_FORCE_SESSION === '1' });
    if (r.skipped === 'no-bands' || r.skipped === 'closed') delay = 15000;
  } catch (e) {
    BAND_LIVE.lastError = e.message;
  } finally {
    scheduleBandTick(delay);
  }
}

/** 触发后：落盘告警 + 写时间线 + 视配置自动发起二次分析 */
async function onBandFire(cfg, f) {
  const { band, side, price } = f;
  let alert;
  try {
    alert = B.pushAlert({ band, side, price, quote: f.quote });
  } catch (e) {
    BAND_LIVE.lastError = `告警落盘失败：${e.message}`;
    return;
  }
  BAND_LIVE.lastFire = alert;
  BAND_LIVE.fired.unshift(alert);
  BAND_LIVE.fired = BAND_LIVE.fired.slice(0, 20);
  const act = band.action === 'analyze' ? '自动二次分析' : '仅提醒';
  try {
    J.appendTimeline({
      text: `区间触发「${B.alertText(alert)}」· 动作：${act}${band.note ? ` · ${band.note}` : ''} · 告警号 ${alert.id}`,
      tag: '风控',
    });
  } catch (e) {
    BAND_LIVE.lastError = `写日志失败：${e.message}`;
  }
  console.log(`[band] ${B.alertText(alert)} → ${act}`);
  if (band.action !== 'analyze' || !cfg.agent || !cfg.agent.enabled) return;
  runBandAgent(cfg, band, alert);
}

function patchAlert(id, patch) {
  const a = B.loadAlerts();
  const it = a.items.find((x) => x.id === id);
  if (!it) return null;
  Object.assign(it, patch);
  B.saveAlerts(a);
  return it;
}

function runBandAgent(cfg, band, alert) {
  if (BAND_LIVE.agentRunning) {
    patchAlert(alert.id, { agent: { state: 'queued', note: '已有分析进程在跑，本条留给定时巡检处理' } });
    return;
  }
  const plan = B.spawnAgent(B.buildPrompt(cfg.agent.promptTemplate, band, alert), cfg);
  if (!plan.ok) {
    patchAlert(alert.id, { agent: { state: 'skipped', note: plan.note } });
    return;
  }
  const dir = path.join(DATA_DIR, 'agent-runs');
  fs.mkdirSync(dir, { recursive: true });
  const logFile = path.join(dir, `${alert.id}-${Date.now()}.log`);
  let out;
  try {
    out = fs.openSync(logFile, 'a');
  } catch (e) {
    patchAlert(alert.id, { agent: { state: 'failed', note: `日志打不开：${e.message}` } });
    return;
  }
  const startedAt = new Date().toISOString();
  BAND_LIVE.agentRunning = true;
  let child;
  try {
    child = spawn(plan.entry.cmd, plan.args, {
      cwd: ROOT,
      stdio: ['ignore', out, out],
      windowsHide: true,
      env: { ...process.env, NO_OPEN: '1' },
    });
  } catch (e) {
    BAND_LIVE.agentRunning = false;
    fs.closeSync(out);
    patchAlert(alert.id, { agent: { state: 'failed', note: `进程启动失败：${e.message}` } });
    return;
  }
  patchAlert(alert.id, {
    agent: { state: 'running', pid: child.pid, log: path.relative(ROOT, logFile), startedAt },
  });
  const timeoutMs = Math.max(60000, num(cfg.agent.timeoutMs, 900000));
  const killer = setTimeout(() => {
    try {
      child.kill();
    } catch {
      /* 已退出 */
    }
  }, timeoutMs);
  if (killer.unref) killer.unref();
  child.on('exit', (code) => {
    clearTimeout(killer);
    BAND_LIVE.agentRunning = false;
    try {
      fs.closeSync(out);
    } catch {
      /* ignore */
    }
    let text = '';
    try {
      text = fs.readFileSync(logFile, 'utf8').slice(-4000);
    } catch {
      /* ignore */
    }
    const authFail = /Authentication required|请先登录|not logged in/i.test(text);
    patchAlert(alert.id, {
      agent: {
        state: authFail ? 'auth' : code === 0 ? 'done' : 'failed',
        code,
        log: path.relative(ROOT, logFile),
        startedAt,
        endedAt: new Date().toISOString(),
        note: authFail ? 'CLI 未登录：需先在终端完成一次登录，或改用定时巡检兜底' : '',
      },
    });
  });
}


function sendJSON(res, code, payload) {
  const buf = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': buf.length,
  });
  res.end(buf);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) reject(new Error('请求体过大'));
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error('JSON 解析失败'));
      }
    });
    req.on('error', reject);
  });
}

async function handleApi(req, res, url) {
  const p = url.pathname;
  const q = url.searchParams;

  if (p === '/api/health') {
    return sendJSON(res, 200, {
      ok: true,
      data: { session: sessionState(), tradingDate: tradingDateKey(), uptime: process.uptime(), fees: FEES },
    });
  }

  if (p === '/api/dashboard') {
    return sendJSON(res, 200, { ok: true, data: await buildDashboard() });
  }

  // 指定标的的最新价（区间监控 / 脚本用，不走自选列表）
  if (p === '/api/quotes') {
    const secids = (q.get('secids') || q.get('codes') || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 40);
    if (!secids.length) return sendJSON(res, 200, { ok: true, data: [] });
    const { map, warnings } = await getQuotes(secids);
    return sendJSON(res, 200, { ok: true, data: [...map.values()], warnings });
  }

  // 价格区间：查询 / 增删改 / 手动试触发 / 告警确认
  if (p === '/api/bands') {
    if (req.method === 'POST') {
      const body = await readBody(req);
      const action = body.action || 'set';
      if (action === 'set') {
        const band = B.upsertBand(body.band || body);
        return sendJSON(res, 200, { ok: true, data: { band, bands: bandSnapshots() } });
      }
      if (action === 'del') {
        B.removeBand(body.id);
        return sendJSON(res, 200, { ok: true, data: { bands: bandSnapshots() } });
      }
      if (action === 'toggle') {
        B.toggleBand(body.id, body.enabled);
        return sendJSON(res, 200, { ok: true, data: { bands: bandSnapshots() } });
      }
      if (action === 'ack') {
        const it = B.ackAlert(body.id, { by: body.by || '手动', note: body.note || '' });
        return sendJSON(res, 200, { ok: true, data: { alert: it, alerts: B.pendingAlerts() } });
      }
      if (action === 'agent') {
        const cfg = B.loadConfig();
        cfg.agent = { ...cfg.agent, enabled: !!body.enabled };
        B.saveConfig(cfg);
        return sendJSON(res, 200, { ok: true, data: { agent: cfg.agent } });
      }
      if (action === 'check') {
        // 供定时巡检任务调用：确保即使盯盘台没常驻，也能补一次区间判定
        const r = await bandCheck({ force: body.force !== false });
        return sendJSON(res, 200, {
          ok: true,
          data: {
            skipped: r.skipped,
            fired: r.fired.map((f) => ({ code: f.band.code, name: f.band.name, side: f.side, price: f.price })),
            alerts: B.pendingAlerts(),
          },
        });
      }
      if (action === 'fire') {
        const cfg = B.loadConfig();
        const band = cfg.bands.find((x) => x.id === body.id);
        if (!band) throw new Error(`区间 ${body.id} 不存在`);
        const price = num(body.price) || num(band.upper == null ? band.lower : band.upper);
        await onBandFire(cfg, { band, side: body.side === 'lower' ? 'lower' : 'upper', price, quote: null });
        return sendJSON(res, 200, { ok: true, data: { alerts: B.pendingAlerts() } });
      }
      throw new Error(`未知操作：${action}`);
    }
    const cfg = B.loadConfig();
    return sendJSON(res, 200, {
      ok: true,
      data: {
        pollSeconds: cfg.pollSeconds,
        agent: { enabled: !!(cfg.agent && cfg.agent.enabled), entry: (B.agentEntry(cfg) || {}).entry || '' },
        bands: bandSnapshots(),
        alerts: B.pendingAlerts(),
        recent: B.loadAlerts().items.slice(0, 30),
        live: { ...BAND_LIVE, fired: BAND_LIVE.fired.slice(0, 10) },
      },
    });
  }

  if (p === '/api/orders') {
    const st = loadState();
    return sendJSON(res, 200, {
      ok: true,
      data: st.orders.slice(0, 100).map((o) => ({ ...o, statusLabel: statusLabel(o.status) })),
    });
  }

  if (p === '/api/detail') {
    const secid = q.get('secid') || '';
    // code 可省略，但板块判定（权限/交易单位/涨跌幅）依赖它，缺省时从 secid 反解，
    // 否则会被当成主板，导致科创板/创业板标的被误判为可买。
    const code = q.get('code') || String(secid).split('.')[1] || '';
    const type = q.get('type') || 'stock';
    if (type === 'fund') {
      const [{ map }, nav] = await Promise.all([getFunds([code]), getFundNav(code, 180)]);
      return sendJSON(res, 200, { ok: true, data: { quote: map.get(code) || null, nav: nav.items } });
    }
    const quote = await getQuote(secid);
    let book = null;
    let bookError = null;
    try {
      book = await getOrderBook(secid, code);
    } catch (e) {
      bookError = e.message;
    }
    return sendJSON(res, 200, {
      ok: true,
      data: {
        quote: quote || null,
        book,
        bookError,
        session: sessionState(),
        // 当前账户能否买入该标的（前端据此在下单面板提示，避免填完才发现没权限）
        permission: R.permissionOf({
          code,
          name: quote?.name || '',
          type,
          permissions: loadAccountPermissions(),
        }),
      },
    });
  }

  if (p === '/api/kline') {
    const secid = q.get('secid');
    if (!secid) throw new Error('缺少 secid');
    const kind = q.get('kind') || 'day';
    if (kind === 'trend') {
      return sendJSON(res, 200, { ok: true, data: await getTrend(secid, Number(q.get('ndays') || 1)) });
    }
    const klt = kind === 'week' ? 102 : kind === 'month' ? 103 : kind === '60m' ? 60 : 101;
    return sendJSON(res, 200, { ok: true, data: await getKline(secid, klt, Number(q.get('lmt') || 160)) });
  }

  if (p === '/api/search') {
    const kw = (q.get('q') || '').trim();
    if (!kw) return sendJSON(res, 200, { ok: true, data: [] });
    return sendJSON(res, 200, { ok: true, data: await searchSymbol(kw) });
  }

  if (p === '/api/watch' && req.method === 'POST') {
    const body = await readBody(req);
    await exclusive(async () => {
      const st = loadState();
      if (body.action === 'add') {
        const item = { secid: body.secid, code: body.code, name: body.name, type: body.type || 'stock' };
        if (!item.secid || !item.code) throw new Error('缺少代码');
        // 生命周期字段（source/note/到期日）由 core/watch.js 在 CLI 侧算好，这里只做白名单透传
        for (const k of ['source', 'note', 'addedOn', 'expireOn', 'ttlDays']) {
          if (body[k] != null && body[k] !== '') item[k] = body[k];
        }
        const exist = st.watchlist.find((w) => w.secid === item.secid);
        if (exist) {
          // 幂等：重复添加按「刷新观察期」处理，任务侧不该因为计划重复列同一只而失败
          if (item.note) exist.note = item.note;
          if ((exist.source || 'manual') === 'plan') {
            for (const k of ['ttlDays', 'addedOn', 'expireOn']) if (item[k] != null) exist[k] = item[k];
          }
        } else {
          st.watchlist.push(item);
        }
      } else if (body.action === 'remove') {
        st.watchlist = st.watchlist.filter((w) => w.secid !== body.secid);
      } else if (body.action === 'move') {
        const idx = st.watchlist.findIndex((w) => w.secid === body.secid);
        const to = idx + Number(body.delta || 0);
        if (idx >= 0 && to >= 0 && to < st.watchlist.length) {
          const [it] = st.watchlist.splice(idx, 1);
          st.watchlist.splice(to, 0, it);
        }
      }
      saveState(st);
    });
    return sendJSON(res, 200, { ok: true });
  }

  if (p === '/api/order' && req.method === 'POST') {
    const body = await readBody(req);
    return sendJSON(res, 200, { ok: true, data: await submitOrder(body) });
  }

  if (p === '/api/cancel' && req.method === 'POST') {
    const body = await readBody(req);
    return sendJSON(res, 200, { ok: true, data: await cancelOrder(body.id) });
  }

  if (p === '/api/reset' && req.method === 'POST') {
    const body = await readBody(req);
    return sendJSON(res, 200, { ok: true, data: await resetAccount(body) });
  }

  throw new Error('接口不存在: ' + p);
}

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^([/\\])+/, ''));
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'Content-Length': buf.length,
    });
    res.end(buf);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url).catch((e) => {
      const code = e.code === 'OFF_HOURS' || e.code === 'NO_CANCEL' ? 409 : 400;
      sendJSON(res, code, { ok: false, code: e.code || 'ERROR', msg: e.message || '服务异常' });
    });
    return;
  }
  serveStatic(req, res, url);
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已被占用，请设置 PORT 环境变量后重试`);
    process.exit(1);
  }
  console.error('[server]', e.message);
});

// 撮合轮询：无活动委托时零网络开销
const matchTimer = setInterval(() => {
  matchTick().catch((e) => console.warn('[match]', e.message));
}, 3000);
if (matchTimer.unref) matchTimer.unref();

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    const url = `http://${HOST}:${PORT}`;
    console.log(`\n  盯盘交易台（真实规则版）已启动  →  ${url}`);
    console.log(`  监听 ${HOST}:${PORT} · ${sessionState().label} · 交易日 ${tradingDateKey()}`);
    console.log(
      `  费率：佣金 ${FEES.commissionRate * 10000}‱（最低 ${FEES.commissionMin} 元）· 印花税 ${
        FEES.stampRate * 1000
      }‰（仅卖出）· 过户费 ${FEES.transferRate * 10000}‱\n`
    );
    if (process.env.NO_OPEN !== '1') {
      const cmd =
        process.platform === 'win32'
          ? `cmd /c start "" "${url}"`
          : process.platform === 'darwin'
            ? `open "${url}"`
            : `xdg-open "${url}"`;
      require('child_process').exec(cmd, () => {});
    }
    // 区间监控：只在服务常驻时生效（浏览器界面开着 = 监控开着）
    startBandMonitor();
  });
}

process.on('unhandledRejection', (e) => {
  console.warn('[unhandledRejection]', e && e.message ? e.message : e);
});

module.exports = {
  server,
  matchTick,
  submitOrder,
  cancelOrder,
  buildDashboard,
  sessionState,
  loadState,
  FEES,
  // 供测试使用
  __test: { applyFills, finishOrder, takeFromLevels, settleFill, availableOf, freezeBuyCash },
};
