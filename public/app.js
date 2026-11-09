'use strict';

/* ============ 基础工具 ============ */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

const fmt = (v, d = 2) =>
  Number(v || 0).toLocaleString('zh-CN', { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtPct = (v) => `${v > 0 ? '+' : ''}${Number(v || 0).toFixed(2)}%`;
const cls = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : 'flat');
const sign = (v) => (v > 0 ? '+' : '');

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const json = await res.json().catch(() => ({ ok: false, msg: '响应解析失败' }));
  if (!json.ok) {
    const err = new Error(json.msg || '请求失败');
    err.code = json.code;
    throw err;
  }
  return json.data;
}

let toastTimer = null;
function toast(msg, type = 'ok') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast show ' + type;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = 'toast ' + type), 2200);
}

/* ============ 全局状态 ============ */
const S = {
  dash: null,
  sel: null,        // {secid, code, name, type}
  side: 'buy',
  orderType: 'limit',
  chartKind: 'trend',
  bottomView: 'positions',
  book: null,
  bookError: null,
  permission: null, // 当前标的的账户交易权限（来自 /api/detail）
  baseHint: '',     // 下单提示的默认文案，权限拦截时会被覆盖
  chart: null,
  bands: null,        // /api/bands 快照（区间面板打开时才拉）
  bandsLoading: false,
  bandsAt: 0,
  bandsTryAt: 0,
  chartSeq: 0,
  loading: false,   // 请求中的互斥标记，防止上游变慢时请求堆叠
};

/* ============ 行情轮询 ============ */
async function loadDashboard() {
  if (S.loading) return;   // 上一次还没回来就跳过，避免请求堆叠
  S.loading = true;
  try {
    const data = await api('/api/dashboard');
    S.dash = data;
    if (!S.sel || !findSymbol(S.sel.secid)) {
      S.sel = data.watch[0] || data.positions[0] || null;
      if (S.sel) S.sel = { secid: S.sel.secid, code: S.sel.code, name: S.sel.name, type: S.sel.type };
    }
    renderAccount();
    renderIndexStrip();
    renderWatch();
    renderQuoteHead();
    renderBottom();
    updateEstimate();
    renderStatus();
    $('#clockText').textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  } catch (e) {
    setLive(false);
    console.warn('dashboard', e.message);
  } finally {
    S.loading = false;
  }
}

/* ============ 数据状态（交易时段 / 行情时点 / 降级告警） ============ */
function renderStatus() {
  const el = $('#sessionTag');
  if (!el) return;
  const m = S.dash?.meta;
  if (!m || !m.session) {
    el.textContent = '--';
    el.className = 'session-tag';
    return;
  }
  const sess = m.session;
  const warnings = m.warnings || [];
  const live = !!sess.phase;
  const lagging = live && m.quoteAge != null && m.quoteAge > 30;
  el.className = 'session-tag ' + (warnings.length || lagging ? 'warn' : live ? 'open' : 'idle');
  el.textContent = sess.label || '--';

  const lines = [`交易日 ${m.tradingDate || '--'}`];
  if (m.quoteTime) {
    const t = new Date(m.quoteTime).toLocaleTimeString('zh-CN', { hour12: false });
    lines.push(`行情时间 ${t}（${m.quoteAge}s 前）`);
  }
  if (lagging) lines.push('⚠ 行情更新滞后');
  if (warnings.length) lines.push('⚠ ' + warnings.join('\n⚠ '));
  if (m.allowOffHours) lines.push('已开启非交易时段下单');
  el.title = lines.join('\n');
}

function findSymbol(secid) {
  if (!S.dash) return null;
  return S.dash.watch.find((w) => w.secid === secid) ||
    S.dash.positions.find((p) => p.secid === secid) || null;
}

function currentQuote() {
  if (!S.sel || !S.dash) return null;
  const w = S.dash.watch.find((x) => x.secid === S.sel.secid);
  if (w) return w;
  const p = S.dash.positions.find((x) => x.secid === S.sel.secid);
  return p ? { ...p, pct: p.pnlPct } : null;
}

function setLive(on) {
  const d = $('#liveDot');
  d.classList.toggle('off', !on);
}

/* ============ 渲染：账户 ============ */
function renderAccount() {
  const a = S.dash.account;
  const map = {
    totalAsset: fmt(a.totalAsset),
    cash: fmt(a.cash),
    frozenCash: fmt(a.frozenCash || 0),
    marketValue: fmt(a.marketValue),
    dayPnl: `${sign(a.dayPnl)}${fmt(a.dayPnl)} (${fmtPct(a.dayPnlPct)})`,
    totalPnl: `${sign(a.totalPnl)}${fmt(a.totalPnl)} (${fmtPct(a.totalPnlPct)})`,
  };
  Object.entries(map).forEach(([k, v]) => {
    const el = $(`#accountBar [data-k="${k}"]`);
    if (!el) return;
    el.textContent = v;
    if (k === 'dayPnl') el.className = cls(a.dayPnl);
    if (k === 'totalPnl') el.className = cls(a.totalPnl);
    if (k === 'frozenCash') el.className = a.frozenCash > 0 ? 'st-partial' : '';
  });
}

function renderIndexStrip() {
  const idx = S.dash.watch.filter((w) => w.type === 'index').slice(0, 4);
  $('#indexStrip').innerHTML = idx
    .map(
      (i) => `<div class="index-item">
        <span>${i.name}</span>
        <b class="${cls(i.pct)}">${fmt(i.price)}</b>
        <em class="${cls(i.pct)}" style="font-style:normal;font-size:11px">${fmtPct(i.pct)}</em>
      </div>`
    )
    .join('');
}

/* ============ 渲染：自选 ============ */
function renderWatch() {
  const list = S.dash.watch;
  const box = $('#watchList');
  if (!list.length) {
    box.innerHTML = '<div class="empty">暂无自选，点击右上角 + 添加</div>';
    return;
  }
  box.innerHTML = list
    .map((w) => {
      const pctCls = cls(w.pct);
      const has = w.dataState !== 'missing' && w.price != null;
      const dp = w.type === 'fund' ? 4 : w.price != null && w.price < 10 ? 3 : 2;
      const flag =
        w.dataState === 'missing'
          ? '<i class="wflag miss" title="上游未返回行情，非真实价格">无数据</i>'
          : w.dataState === 'stale'
            ? '<i class="wflag stale" title="缓存数据，可能已滞后">滞后</i>'
            : '';
      const timeTip = w.marketTs
        ? ` title="行情时间 ${new Date(w.marketTs).toLocaleTimeString('zh-CN', { hour12: false })}"`
        : '';
      return `<div class="watch-row ${S.sel && S.sel.secid === w.secid ? 'active' : ''} ${has ? '' : 'missing'}" data-secid="${w.secid}"${timeTip}>
        <div class="wr-name"><b>${w.name}</b>${flag}<small>${w.code}${w.type === 'fund' ? ' · 基金' : ''}${w.source === 'plan' ? ` · 观察至 ${String(w.expireOn || '').slice(5)}` : ''}</small></div>
        <div class="wr-price ${pctCls}">${has ? fmt(w.price, dp) : '--'}</div>
        <div class="wr-pct ${pctCls}">${has ? fmtPct(w.pct) : '--'}</div>
        <button class="del" data-del="${w.secid}" title="移除">×</button>
      </div>`;
    })
    .join('');
}

/* ============ 渲染：行情头 ============ */
function renderQuoteHead() {
  const q = currentQuote();
  if (!q) {
    $('#qName').textContent = '--';
    $('#qCode').textContent = '';
    $('#qPrice').textContent = '--';
    return;
  }
  const dp = q.type === 'fund' ? 4 : 2;
  $('#qName').textContent = q.name || S.sel.name;
  $('#qCode').textContent = q.code || S.sel.code;
  $('#qTag').textContent = { stock: 'A股', index: '指数', etf: 'ETF', fund: '场外基金' }[q.type || S.sel.type] || '';

  const noData = q.dataState === 'missing' || q.price == null;
  const price = q.price || 0;
  const pct = q.pct || 0;
  const chg = q.change != null ? q.change : price * pct / 100;
  $('#qPrice').textContent = noData ? '--' : fmt(price, dp);
  $('#qPrice').className = noData ? 'flat' : cls(pct);
  $('#qChange').textContent = noData
    ? '暂无行情'
    : `${sign(chg)}${fmt(chg, dp)}  ${fmtPct(pct)}${q.dataState === 'stale' ? '  (滞后)' : ''}`;
  $('#qChange').className = noData ? 'flat' : cls(pct);

  if (q.type === 'fund' || S.sel.type === 'fund') {
    $('#qStats').innerHTML = `
      <div><label>净值日期</label><span>${q.navDate || '--'}</span></div>
      <div><label>盘中估值</label><span>${q.estPct == null ? '暂无' : fmtPct(q.estPct)}</span></div>
      <div><label>涨跌口径</label><span>${q.pctBasis || '--'}</span></div>
      <div><label>持仓</label><span>${fmt(positionOf(S.sel.secid)?.qty || 0, 2)} 份</span></div>
      <div><label>成本</label><span>${fmt(positionOf(S.sel.secid)?.cost || 0, 4)}</span></div>`;
    return;
  }
  const qt = q.marketTs ? new Date(q.marketTs).toLocaleTimeString('zh-CN', { hour12: false }) : '--';
  $('#qStats').innerHTML = `
    <div><label>今开</label><span class="${cls((q.open || price) - (q.preClose || price))}">${fmt(q.open || 0, dp)}</span></div>
    <div><label>昨收</label><span>${fmt(q.preClose || 0, dp)}</span></div>
    <div><label>最高</label><span class="up">${fmt(q.high || 0, dp)}</span></div>
    <div><label>最低</label><span class="down">${fmt(q.low || 0, dp)}</span></div>
    <div><label>成交量</label><span>${fmtVol(q.volume)}</span></div>
    <div><label>换手率</label><span>${q.turnover ? fmt(q.turnover) + '%' : '--'}</span></div>
    <div><label>总市值</label><span>${fmtCap(q.mktCap)}</span></div>
    <div><label>行情时间</label><span>${qt}</span></div>
    <div><label>持仓</label><span>${positionOf(S.sel.secid) ? fmt(positionOf(S.sel.secid).qty, 0) + ' 股' : '--'}</span></div>`;
}

function positionOf(secid) {
  return (S.dash?.positions || []).find((p) => p.secid === secid);
}
const fmtVol = (v) => {
  const n = Number(v || 0);
  if (n >= 1e8) return (n / 1e8).toFixed(2) + ' 亿手';
  if (n >= 1e4) return (n / 1e4).toFixed(2) + ' 万手';
  return n.toFixed(0) + ' 手';
};
const fmtCap = (v) => {
  const n = Number(v || 0);
  if (!n) return '--';
  if (n >= 1e12) return (n / 1e12).toFixed(2) + ' 万亿';
  if (n >= 1e8) return (n / 1e8).toFixed(2) + ' 亿';
  return (n / 1e4).toFixed(2) + ' 万';
};

/* ============ 盘口 ============ */
function renderBook() {
  const box = $('#bookBody');
  if (S.sel?.type === 'fund') {
    box.innerHTML = '<div class="empty" style="padding:14px">场外基金无盘口，按净值成交</div>';
    return;
  }
  if (S.sel?.type === 'index') {
    box.innerHTML = '<div class="empty" style="padding:14px">指数无盘口，不可直接交易</div>';
    return;
  }
  const b = S.book;
  if (!b || !b.bids?.length || !b.bids[0].price) {
    const msg = S.bookError
      ? `盘口不可用：${S.bookError}`
      : S.dash?.meta?.session?.phase
        ? '盘口数据加载中…'
        : '非交易时段无盘口';
    box.innerHTML = `<div class="empty" style="padding:14px">${msg}</div>`;
    return;
  }
  const maxVol = Math.max(...b.asks.concat(b.bids).map((x) => x.volume), 1);
  const askRows = [...b.asks].reverse().map((a, i) =>
    `<div class="book-line ask">
       <span style="color:#78808f">卖${5 - i}</span>
       <span class="bar" style="width:${(a.volume / maxVol) * 100}%"></span>
       <span class="bk-px up">${fmt(a.price, 2)}</span>
       <span class="bk-vol">${(a.volume / 100).toFixed(0)}</span>
     </div>`).join('');
  const bidRows = b.bids.map((x, i) =>
    `<div class="book-line bid">
       <span style="color:#78808f">买${i + 1}</span>
       <span class="bar" style="width:${(x.volume / maxVol) * 100}%"></span>
       <span class="bk-px down">${fmt(x.price, 2)}</span>
       <span class="bk-vol">${(x.volume / 100).toFixed(0)}</span>
     </div>`).join('');
  box.innerHTML = askRows + '<div class="book-sep"></div>' + bidRows;
}

/* ============ 图表 ============ */
function initChart() {
  S.chart = echarts.init($('#chart'), null, { renderer: 'canvas' });
  window.addEventListener('resize', () => S.chart && S.chart.resize());
}

const AXIS = {
  axisLine: { lineStyle: { color: '#242b39' } },
  axisLabel: { color: '#6b7383', fontSize: 10 },
  axisTick: { show: false },
  splitLine: { lineStyle: { color: 'rgba(36,43,57,.55)' } },
};

function baseTooltip() {
  return {
    trigger: 'axis',
    backgroundColor: 'rgba(23,28,39,.96)',
    borderColor: '#333c4d',
    borderWidth: 1,
    padding: [6, 10],
    textStyle: { color: '#dfe4ee', fontSize: 11 },
    axisPointer: { type: 'cross', lineStyle: { color: '#4a5568', type: 'dashed' }, crossStyle: { color: '#4a5568' } },
  };
}

async function loadChart() {
  if (!S.sel) return;
  const seq = ++S.chartSeq;
  const kind = S.chartKind;
  const isFund = S.sel.type === 'fund';

  try {
    if (isFund) {
      const d = await api(`/api/detail?secid=${encodeURIComponent(S.sel.secid)}&code=${S.sel.code}&type=fund`);
      if (seq !== S.chartSeq) return;
      drawFundNav(d.nav || []);
      return;
    }
    if (kind === 'trend' || kind === 'trend5') {
      const d = await api(`/api/kline?secid=${S.sel.secid}&kind=trend&ndays=${kind === 'trend5' ? 5 : 1}`);
      if (seq !== S.chartSeq) return;
      drawTrend(d);
    } else {
      const d = await api(`/api/kline?secid=${S.sel.secid}&kind=${kind}&lmt=200`);
      if (seq !== S.chartSeq) return;
      drawCandle(d);
    }
  } catch (e) {
    console.warn('chart', e.message);
  }
}

function drawTrend(d) {
  const items = d.items || [];
  if (!items.length) {
    S.chart.clear();
    return;
  }
  const pre = d.preClose || items[0].close;
  const xs = items.map((i) => i.time);
  const prices = items.map((i) => i.close);
  const avgs = items.map((i) => i.avg);
  const hasVol = items.some((i) => i.volume > 0);
  const vols = items.map((i, idx) => ({
    value: i.volume,
    itemStyle: { color: i.close >= (items[idx - 1]?.close ?? pre) ? 'rgba(242,80,75,.55)' : 'rgba(34,176,122,.55)' },
  }));
  const maxDev = Math.max(...prices.map((p) => Math.abs(p - pre)), pre * 0.002);
  const upColor = '#f2504b';
  const yMin = +(pre - maxDev * 1.03).toFixed(2);
  const yMax = +(pre + maxDev * 1.03).toFixed(2);
  const xLabel = { color: '#6b7383', fontSize: 10, interval: Math.floor(xs.length / 5) };

  const catAxis = (gridIndex, showLabel) => ({
    type: 'category', data: xs, gridIndex, ...AXIS,
    axisLabel: showLabel ? xLabel : { show: false },
    splitLine: { show: false },
  });

  S.chart.setOption({
    animation: false,
    backgroundColor: 'transparent',
    tooltip: {
      ...baseTooltip(),
      formatter: (ps) => {
        const i = ps[0].dataIndex;
        const it = items[i];
        const pct = ((it.close / pre - 1) * 100).toFixed(2);
        return `<div style="font-size:11px;line-height:1.7">
          <div style="color:#78808f">${it.full || it.time}</div>
          <div>价格 <b style="color:${it.close >= pre ? upColor : '#22b07a'}">${fmt(it.close, 2)}</b> (${pct}%)</div>
          <div>均价 ${fmt(it.avg, 2)}${hasVol ? `　成交量 ${it.volume.toFixed(0)} 手` : ''}</div>
        </div>`;
      },
    },
    grid: hasVol
      ? [{ left: 54, right: 58, top: 14, height: '62%' }, { left: 54, right: 58, top: '74%', height: '16%' }]
      : [{ left: 54, right: 58, top: 14, bottom: 28 }],
    xAxis: hasVol ? [catAxis(0, false), catAxis(1, true)] : [catAxis(0, true)],
    yAxis: hasVol
      ? [
          { scale: true, gridIndex: 0, min: yMin, max: yMax, ...AXIS, axisLabel: { color: '#6b7383', fontSize: 10, formatter: (v) => v.toFixed(2) } },
          { scale: true, gridIndex: 1, ...AXIS, axisLabel: { show: false }, splitLine: { show: false } },
        ]
      : [
          { scale: true, gridIndex: 0, min: yMin, max: yMax, ...AXIS, axisLabel: { color: '#6b7383', fontSize: 10, formatter: (v) => v.toFixed(2) } },
        ],
    series: [
      {
        name: '价格', type: 'line', data: prices, showSymbol: false, smooth: false,
        lineStyle: { width: 1.2, color: '#4a8cf7' },
        areaStyle: {
          color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: 'rgba(74,140,247,.28)' },
            { offset: 1, color: 'rgba(74,140,247,.02)' },
          ]),
        },
      },
      {
        name: '均价', type: 'line', data: avgs, showSymbol: false,
        lineStyle: { width: 1, color: '#d9a441', type: 'solid' },
      },
      ...(hasVol
        ? [{ name: '成交量', type: 'bar', data: vols, xAxisIndex: 1, yAxisIndex: 1, barWidth: '60%' }]
        : []),
    ],
  }, true);

  $('#chartTip').textContent = `昨收 ${fmt(pre, 2)}`;
}

function drawCandle(d) {
  const items = d.items || [];
  if (!items.length) {
    S.chart.clear();
    return;
  }
  const xs = items.map((i) => i.date);
  const ohlc = items.map((i) => [i.open, i.close, i.low, i.high]);
  const vols = items.map((i) => ({
    value: i.volume,
    itemStyle: { color: i.close >= i.open ? 'rgba(242,80,75,.6)' : 'rgba(34,176,122,.6)' },
  }));

  const ma = (n) =>
    items.map((_, i) => {
      if (i < n - 1) return '-';
      let s = 0;
      for (let k = 0; k < n; k++) s += items[i - k].close;
      return +(s / n).toFixed(2);
    });

  S.chart.setOption({
    animation: false,
    backgroundColor: 'transparent',
    tooltip: {
      ...baseTooltip(),
      formatter: (ps) => {
        const i = ps[0].dataIndex;
        const it = items[i];
        const pct = ((it.close / it.open - 1) * 100).toFixed(2);
        return `<div style="font-size:11px;line-height:1.7">
          <div style="color:#78808f">${it.date}</div>
          <div>开 ${fmt(it.open)}　收 <b style="color:${it.close >= it.open ? '#f2504b' : '#22b07a'}">${fmt(it.close)}</b></div>
          <div>高 ${fmt(it.high)}　低 ${fmt(it.low)}</div>
          <div>振幅 ${pct}%　量 ${(it.volume / 1e4).toFixed(2)} 万手</div>
        </div>`;
      },
    },
    legend: { data: ['MA5', 'MA10', 'MA20'], right: 12, top: 0, textStyle: { color: '#78808f', fontSize: 10 }, itemWidth: 14, itemHeight: 2 },
    grid: [
      { left: 54, right: 20, top: 20, height: '62%' },
      { left: 54, right: 20, top: '74%', height: '16%' },
    ],
    xAxis: [
      { type: 'category', data: xs, gridIndex: 0, ...AXIS, axisLabel: { show: false }, splitLine: { show: false } },
      { type: 'category', data: xs, gridIndex: 1, ...AXIS, axisLabel: { interval: Math.floor(xs.length / 6) }, splitLine: { show: false } },
    ],
    yAxis: [
      { scale: true, gridIndex: 0, ...AXIS },
      { scale: true, gridIndex: 1, ...AXIS, axisLabel: { show: false }, splitLine: { show: false } },
    ],
    dataZoom: [{ type: 'inside', xAxisIndex: [0, 1], start: 55, end: 100 }],
    series: [
      {
        name: 'K', type: 'candlestick', data: ohlc,
        itemStyle: { color: '#f2504b', color0: '#22b07a', borderColor: '#f2504b', borderColor0: '#22b07a' },
        barMaxWidth: 12,
      },
      { name: 'MA5', type: 'line', data: ma(5), showSymbol: false, lineStyle: { width: 1, color: '#e6b450' } },
      { name: 'MA10', type: 'line', data: ma(10), showSymbol: false, lineStyle: { width: 1, color: '#4a8cf7' } },
      { name: 'MA20', type: 'line', data: ma(20), showSymbol: false, lineStyle: { width: 1, color: '#b06ee0' } },
      { name: '成交量', type: 'bar', data: vols, xAxisIndex: 1, yAxisIndex: 1, barWidth: '60%' },
    ],
  }, true);
}

function drawFundNav(items) {
  if (!items.length) {
    S.chart.clear();
    return;
  }
  const xs = items.map((i) => i.date);
  const vs = items.map((i) => i.close);
  const last = vs[vs.length - 1];
  S.chart.setOption({
    animation: false,
    backgroundColor: 'transparent',
    tooltip: {
      ...baseTooltip(),
      formatter: (ps) => {
        const i = ps[0].dataIndex;
        const it = items[i];
        return `<div style="font-size:11px;line-height:1.7">
          <div style="color:#78808f">${it.date}</div>
          <div>单位净值 <b>${fmt(it.close, 4)}</b></div>
          <div>日涨跌 ${fmtPct(it.pct || 0)}</div>
        </div>`;
      },
    },
    grid: [{ left: 58, right: 74, top: 20, bottom: 30 }],
    xAxis: [{ type: 'category', data: xs, ...AXIS, splitLine: { show: false }, axisLabel: { color: '#6b7383', fontSize: 10, interval: Math.floor(xs.length / 6) } }],
    yAxis: [{ scale: true, ...AXIS, axisLabel: { color: '#6b7383', fontSize: 10, formatter: (v) => v.toFixed(3) } }],
    series: [
      {
        name: '单位净值', type: 'line', data: vs, showSymbol: false,
        lineStyle: { width: 1.4, color: '#4a8cf7' },
        areaStyle: {
          color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
            { offset: 0, color: 'rgba(74,140,247,.3)' },
            { offset: 1, color: 'rgba(74,140,247,.02)' },
          ]),
        },
        markLine: {
          silent: true, symbol: 'none',
          lineStyle: { color: '#5b6479', type: 'dashed', width: 1 },
          label: { color: '#78808f', fontSize: 10, formatter: '最新 ' + fmt(last, 4) },
          data: [{ yAxis: last }],
        },
      },
    ],
  }, true);
  $('#chartTip').textContent = `近 ${items.length} 个交易日净值`;
}

/* ============ 详情轮询 ============ */
async function loadDetail() {
  if (!S.sel) return;
  if (S.sel.type === 'fund') {
    S.book = null;
    S.bookError = null;
    S.permission = null; // 场外基金不受板块适当性限制，交由风控 forbidFund 决定
    renderBook();
    return;
  }
  try {
    const d = await api(
      `/api/detail?secid=${encodeURIComponent(S.sel.secid)}&code=${encodeURIComponent(S.sel.code)}&type=${S.sel.type}`
    );
    S.book = d.book;
    S.bookError = d.bookError || null;
    S.permission = d.permission || null;
    renderBook();
    applyPermissionHint();
  } catch (e) {
    S.book = null;
    S.bookError = e.message;
    S.permission = null;
    renderBook();
  }
}

/* ============ 下单面板 ============ */
function isFundSel() {
  return S.sel?.type === 'fund';
}

/**
 * 账户权限对下单面板的限制。
 * 只拦买入：卖出永远放行，否则权限收紧后存量持仓无法退出。
 * @param {string} [baseHint] 默认提示文案，无权限时会被覆盖
 */
function applyPermissionHint(baseHint) {
  if (baseHint !== undefined) S.baseHint = baseHint;
  const hint = $('#orderHint');
  const btn = $('#btnSubmit');
  if (!hint || !btn) return false;
  const perm = S.permission;
  const blocked = !!(perm && !perm.allowed) && S.side === 'buy';
  hint.classList.toggle('warn', blocked);
  hint.textContent = blocked
    ? `未开通${perm.label}：需 ${perm.need}。当前账户只能交易沪深主板与场内基金（科创/创业 ETF 除外）`
    : S.baseHint || '';
  btn.disabled = S.sel?.type === 'index' || blocked;
  btn.title = blocked ? `无${perm.label}交易权限` : '';
  return blocked;
}

function setSide(side) {
  S.side = side;
  $('#tabBuy').classList.toggle('active', side === 'buy');
  $('#tabSell').classList.toggle('active', side === 'sell');
  const btn = $('#btnSubmit');
  btn.className = 'submit ' + side;
  btn.textContent = side === 'buy' ? (isFundSel() ? '申购' : '买入') : (isFundSel() ? '赎回' : '卖出');
  $('#priceLabel').textContent = side === 'buy' ? '委托价（买入）' : '委托价（卖出）';
  const fundBuy = isFundSel() && side === 'buy';
  $('#qtyField').classList.toggle('hidden', fundBuy);
  $('#amountField').classList.toggle('hidden', !fundBuy);
  $('#inQty').placeholder = isFundSel() ? '赎回份额（可含小数）' : '100 的整数倍';
  $('#inQty').step = isFundSel() ? '0.01' : '100';
  updateEstimate();
  applyPermissionHint();
}

function syncOrderMode() {
  const fund = isFundSel();
  const index = S.sel?.type === 'index';
  const q = currentQuote();
  const tick = fund ? 0.0001 : S.sel?.type === 'etf' ? 0.001 : 0.01;
  const dp = tick === 0.01 ? 2 : tick === 0.001 ? 3 : 4;
  $('#inPrice').step = tick;
  $('#inPrice').value = q && q.price ? Number(q.price).toFixed(dp) : '';
  $('#inQty').value = '';
  $('#inAmount').value = '';

  const sess = S.dash?.meta?.session;
  const isMarket = !fund && S.orderType === 'market';
  const afterHours = !!(sess && sess.afterHours);
  $('#priceField').classList.toggle('hidden', isMarket || afterHours);
  $('#orderType').classList.toggle('hidden', fund || index);
  const code = S.sel?.code || '';
  const isStar = /^(688|689)/.test(code);
  const isBse = /^(4|8|92)/.test(code);
  $('#inQty').placeholder = fund
    ? '赎回份额（可含小数）'
    : isStar
      ? '200 股起，1 股递增'
      : isBse
        ? '100 股起，1 股递增'
        : '100 的整数倍';
  $('#inQty').step = fund ? '0.01' : '1';
  const baseHint = index
    ? '指数不可直接交易，请选择个股 / ETF / 基金'
    : fund
      ? '场外基金未知价交易：T 日 15:00 前按当日净值，之后顺延至下一交易日'
      : afterHours
        ? '盘后固定价格交易：统一按当日收盘价成交，仅限科创板 / 创业板'
        : S.orderType === 'market'
          ? '市价委托：五档即时成交，剩余部分自动撤销'
          : '限价委托：按对手价成交，未成交部分挂单排队，当日有效';
  applyPermissionHint(baseHint);
  setSide(S.side);
  renderPriceRange();
}

function renderPriceRange() {
  const box = $('#priceRange');
  const q = currentQuote();
  if (!box) return;
  if (!q || S.sel?.type === 'fund' || S.sel?.type === 'index') {
    box.innerHTML = '';
    return;
  }
  const dp = S.sel?.type === 'etf' ? 3 : 2;
  const up = q.limitUp != null ? fmt(q.limitUp, dp) : '不限';
  const down = q.limitDown != null ? fmt(q.limitDown, dp) : '不限';
  box.innerHTML = `<span class="down">跌停 ${down}</span><span class="up">涨停 ${up}</span>`;
}

function feeOf(amount, side, isEtf) {
  const r = S.dash?.rule || {};
  const rate = isEtf ? r.etfCommissionRate ?? 0.00025 : r.commissionRate ?? 0.00025;
  const minFee = isEtf ? r.etfCommissionMin ?? 5 : r.commissionMin ?? 5;
  const amt = amount > 0 ? amount : 0;
  const commission = amt > 0 ? Math.max(amt * rate, minFee) : 0;
  const transfer = isEtf || amt <= 0 ? 0 : amt * (r.transferRate ?? 0.00001);
  const stamp = !isEtf && side === 'sell' && amt > 0 ? amt * (r.stampRate ?? 0.0005) : 0;
  return { commission, transfer, stamp, total: commission + transfer + stamp, rate, minFee };
}

const wan = (r) => `${(r * 10000).toFixed(r * 10000 % 1 === 0 ? 0 : 1)}‱`;
const qian = (r) => `${(r * 1000).toFixed(r * 1000 % 1 === 0 ? 0 : 1)}‰`;

function updateEstimate() {
  const q = currentQuote();
  if (!q) {
    $('#estimate').innerHTML = '';
    return;
  }
  const fund = isFundSel();
  const price = Number($('#inPrice').value) || q.price || 0;
  const cash = S.dash.account.cash;
  const dp = fund ? 4 : S.sel?.type === 'etf' ? 3 : 2;
  let html = '';

  if (fund && S.side === 'buy') {
    const amount = Number($('#inAmount').value) || 0;
    const feeRate = S.dash?.rule?.fundBuyFee ?? 0.0015;
    const fee = amount * feeRate;
    const shares = price > 0 ? (amount - fee) / price : 0;
    html = `<div><span>申购金额</span><b>¥${fmt(amount)}</b></div>
      <div><span>申购费(${(feeRate * 100).toFixed(2)}%)</span><b>¥${fmt(fee)}</b></div>
      <div><span>预计份额</span><b>${fmt(shares, 2)} 份</b></div>
      <div><span>可用资金</span><b>¥${fmt(cash)}</b></div>`;
  } else if (fund) {
    const pos = positionOf(S.sel.secid);
    const shares = Number($('#inQty').value) || pos?.qty || 0;
    const gross = shares * price;
    html = `<div><span>赎回份额</span><b>${fmt(shares, 2)}</b></div>
      <div><span>成交金额（估）</span><b>¥${fmt(gross)}</b></div>
      <div><span>赎回费</span><b>按持有期阶梯</b></div>
      <div><span>可赎份额</span><b>${fmt(pos?.qty || 0, 2)}</b></div>`;
  } else if (S.side === 'buy') {
    const isEtf = S.sel?.type === 'etf';
    const qty = Math.floor(Number($('#inQty').value) || 0);
    const amount = price * qty;
    const f = feeOf(amount, 'buy', isEtf);
    html = `<div><span>${S.orderType === 'market' ? '成交金额（按现价估）' : '成交金额'}</span><b>¥${fmt(amount)}</b></div>
      <div><span>佣金(${wan(f.rate)}${f.minFee ? `，最低${f.minFee}` : ''})</span><b>¥${fmt(f.commission)}</b></div>
      <div><span>${isEtf ? '过户费（ETF 免收）' : '过户费(万0.1)'}</span><b>¥${fmt(f.transfer)}</b></div>
      <div><span>冻结金额</span><b>¥${fmt(amount + f.total)}</b></div>
      <div><span>可用资金</span><b class="${amount + f.total > cash ? 'up' : ''}">¥${fmt(cash)}</b></div>`;
  } else {
    const isEtf = S.sel?.type === 'etf';
    const pos = positionOf(S.sel.secid);
    const qty = Math.floor(Number($('#inQty').value) || 0);
    const amount = price * qty;
    const f = feeOf(amount, 'sell', isEtf);
    html = `<div><span>${S.orderType === 'market' ? '成交金额（按现价估）' : '成交金额'}</span><b>¥${fmt(amount)}</b></div>
      <div><span>佣金(${wan(f.rate)})</span><b>¥${fmt(f.commission)}</b></div>
      <div><span>${isEtf ? '印花税（ETF 免征）' : `印花税(${qian(S.dash?.rule?.stampRate ?? 0.0005)})`}</span><b>¥${fmt(f.stamp)}</b></div>
      <div><span>${isEtf ? '过户费（ETF 免收）' : '过户费(万0.1)'}</span><b>¥${fmt(f.transfer)}</b></div>
      <div><span>预计到账</span><b>¥${fmt(amount - f.total)}</b></div>
      <div><span>可卖</span><b>${fmt(pos?.available || 0, 0)} 股${pos?.frozen ? `（冻结 ${fmt(pos.frozen, 0)}）` : ''}</b></div>`;
  }
  $('#estimate').innerHTML = html;
}

async function submitOrder() {
  if (!S.sel) return toast('请先选择标的', 'err');
  if (S.sel.type === 'index') return toast('指数不可直接交易', 'err');
  const fund = isFundSel();
  const isMarket = !fund && S.orderType === 'market';
  const q = currentQuote();
  const price = isMarket ? q?.price : Number($('#inPrice').value);
  const sess = S.dash?.meta?.session;
  const afterHours = !!(sess && sess.afterHours);

  if (!afterHours && !(price > 0)) return toast('请输入有效价格', 'err');

  const body = {
    secid: S.sel.secid,
    code: S.sel.code,
    name: q?.name || S.sel.name,
    type: S.sel.type,
    side: S.side,
    orderType: isMarket ? 'market' : 'limit',
    price: afterHours ? q?.price : price,
  };

  if (fund && S.side === 'buy') {
    body.amount = Number($('#inAmount').value);
    if (!(body.amount > 0)) return toast('请输入申购金额', 'err');
  } else {
    body.qty = fund ? Number($('#inQty').value) : Math.floor(Number($('#inQty').value) || 0);
    if (!(body.qty > 0)) return toast('请输入数量', 'err');
  }

  const btn = $('#btnSubmit');
  btn.disabled = true;
  try {
    let d;
    try {
      d = await api('/api/order', { method: 'POST', body });
    } catch (e) {
      // 非交易时段：二次确认后可强制按现价成交（仅用于复盘演练）
      if (e.code === 'OFF_HOURS' && window.confirm(`${e.message}\n\n是否按当前行情价强制成交？（仅复盘演练用）`)) {
        d = await api('/api/order', { method: 'POST', body: { ...body, force: true } });
      } else {
        throw e;
      }
    }

    if (d.trade && !d.order) {
      const t = d.trade;
      const note = t.pricingBasis ? `（按${t.pricingBasis}，${t.confirmDate} 确认）` : '';
      toast(
        `${t.side === 'buy' ? '申购' : '赎回'} ${t.name} ${fmt(t.qty, 2)}份 @ ${fmt(t.price, 4)}${note}`,
        'ok'
      );
    } else if (d.order) {
      const o = d.order;
      if (o.status === 'filled') {
        const avg = o.filledAmount && o.filledQty ? o.filledAmount / o.filledQty : o.displayPrice;
        toast(
          `${o.side === 'buy' ? '买入' : '卖出'} ${o.name} ${fmt(o.filledQty, 0)}股 @ ${fmt(avg, 3)} 全部成交`,
          'ok'
        );
      } else if (o.filledQty > 0) {
        toast(`部分成交 ${fmt(o.filledQty, 0)}/${fmt(o.qty, 0)} 股，剩余挂单排队中`, 'ok');
      } else if (o.status === 'cancelled') {
        toast(`委托已撤销：${o.reason || '未成交'}`, 'err');
      } else {
        toast(`委托已挂单 ${fmt(o.qty, 0)} 股 @ ${fmt(o.displayPrice, 3)}，等待对手盘`, 'ok');
      }
    }
    $('#inQty').value = '';
    $('#inAmount').value = '';
    await loadDashboard();
    await loadDetail();
  } catch (e) {
    toast(e.message, 'err');
  } finally {
    applyPermissionHint(); // 恢复按钮状态时一并考虑权限（无权限则保持禁用）
  }
}

/* ============ 底部面板 ============ */
/* ============ 价格区间 ============ */
async function loadBands() {
  if (S.bandsLoading) return;
  if (Date.now() - (S.bandsTryAt || 0) < 3000) return; // 防抖，同时防止请求失败后无限重试
  S.bandsTryAt = Date.now();
  S.bandsLoading = true;
  try {
    S.bands = await api('/api/bands');
    S.bandsAt = Date.now();
    const n = (S.bands.alerts || []).length;
    const tab = $('#bottomTabs .tab[data-view="bands"]');
    if (tab) tab.textContent = n ? `区间 ${n}` : '区间';
  } catch (e) {
    S.bands = null;
    toast(e.message, 'err');
  } finally {
    S.bandsLoading = false;
    if (S.bottomView === 'bands') renderBottom();
  }
}

function bindBands() {
  const body = $('#bottomBody');
  if (!body || body.dataset.bandsBound === '1') return;
  body.dataset.bandsBound = '1';

  body.addEventListener('click', async (e) => {
    if (e.target.closest('#bSave')) {
      const sel = S.sel;
      if (!sel) return toast('先在左侧选一个标的', 'err');
      const lower = $('#bLower').value.trim();
      const upper = $('#bUpper').value.trim();
      if (!lower && !upper) return toast('上轨、下轨至少填一个', 'err');
      try {
        await api('/api/bands', {
          method: 'POST',
          body: {
            action: 'set',
            band: {
              code: sel.code,
              secid: sel.secid,
              name: sel.name,
              type: sel.type,
              lower: lower || null,
              upper: upper || null,
              action: $('#bAction').value,
              cooldownMin: Number($('#bCool').value) || 30,
              note: $('#bNote').value.trim(),
            },
          },
        });
        toast('区间已保存', 'ok');
        S.bands = null;
        loadBands();
      } catch (err) {
        toast(err.message, 'err');
      }
      return;
    }

    const btn = e.target.closest('[data-bact]');
    if (!btn) return;
    const { bact, id } = btn.dataset;
    try {
      if (bact === 'del') {
        if (!confirm('删除该区间？')) return;
        await api('/api/bands', { method: 'POST', body: { action: 'del', id } });
        toast('已删除', 'ok');
      } else if (bact === 'toggle') {
        await api('/api/bands', { method: 'POST', body: { action: 'toggle', id, enabled: btn.dataset.en === '1' } });
      } else if (bact === 'fire') {
        await api('/api/bands', { method: 'POST', body: { action: 'fire', id } });
        toast('已手动触发，时间线已留痕', 'ok');
      } else if (bact === 'ack') {
        await api('/api/bands', { method: 'POST', body: { action: 'ack', id, note: '面板确认' } });
        toast('已标记处理', 'ok');
      }
      S.bands = null;
      loadBands();
    } catch (err) {
      toast(err.message, 'err');
    }
  });
}

function renderBottom() {
  const body = $('#bottomBody');
  const sum = $('#bottomSum');
  const keepTop = body.scrollTop;
  try {
  $$('#bottomTabs .tab').forEach((t) => t.classList.toggle('active', t.dataset.view === S.bottomView));

  if (S.bottomView === 'positions') {
    const ps = S.dash.positions;
    const totalPnl = ps.reduce((s, p) => s + p.pnl, 0);
    const dayPnl = ps.reduce((s, p) => s + p.dayPnl, 0);
    sum.innerHTML = `<span>持仓 <b>${ps.length}</b></span>
      <span>浮动盈亏 <b class="${cls(totalPnl)}">${sign(totalPnl)}${fmt(totalPnl)}</b></span>
      <span>持仓当日 <b class="${cls(dayPnl)}">${sign(dayPnl)}${fmt(dayPnl)}</b></span>`;
    if (!ps.length) {
      body.innerHTML = '<div class="empty">暂无持仓，在右侧下单面板买入建仓</div>';
      return;
    }
    body.innerHTML = `<table class="grid">
      <thead><tr>
        <th>名称 / 代码</th><th>持仓</th><th>可用</th><th>冻结</th><th>成本</th><th>现价</th>
        <th>市值</th><th>浮动盈亏</th><th>盈亏率</th><th>当日</th><th>操作</th>
      </tr></thead>
      <tbody>${ps.map((p) => {
        const fund = p.type === 'fund';
        const dp = fund ? 4 : p.type === 'etf' ? 3 : 2;
        return `<tr data-secid="${p.secid}">
          <td><div class="nm"><b>${p.name}</b><small>${p.code}${fund ? ' · 基金' : ''}</small></div></td>
          <td>${fmt(p.qty, fund ? 2 : 0)}</td>
          <td>${fmt(p.available, fund ? 2 : 0)}</td>
          <td class="${p.frozen > 0 ? 'st-partial' : 'flat'}">${p.frozen ? fmt(p.frozen, fund ? 2 : 0) : '—'}</td>
          <td>${fmt(p.cost, fund ? 4 : 2)}</td>
          <td class="${cls(p.pct)}">${fmt(p.price, dp)}${p.limitUp != null && Math.abs(p.price - p.limitUp) < 1e-6 ? ' <i class="wflag" style="color:#f2504b;background:rgba(242,80,75,.16)">涨停</i>' : ''}</td>
          <td>${fmt(p.marketValue)}</td>
          <td class="${cls(p.pnl)}">${sign(p.pnl)}${fmt(p.pnl)}</td>
          <td class="${cls(p.pnl)}">${fmtPct(p.pnlPct)}</td>
          <td class="${cls(p.dayPnl)}">${sign(p.dayPnl)}${fmt(p.dayPnl)}</td>
          <td><div class="ops">
            <button class="buy" data-act="buy" data-secid="${p.secid}">买</button>
            <button class="sell" data-act="sell" data-secid="${p.secid}">卖</button>
          </div></td>
        </tr>`;
      }).join('')}</tbody></table>`;
    return;
  }

  if (S.bottomView === 'orders') {
    const os = S.dash.orders || [];
    const live = os.filter((o) => o.status === 'pending' || o.status === 'partial');
    sum.innerHTML = `<span>活动委托 <b>${live.length}</b></span>
      <span>冻结资金 <b class="${S.dash.account.frozenCash > 0 ? 'st-partial' : ''}">¥${fmt(S.dash.account.frozenCash)}</b></span>`;
    if (!os.length) {
      body.innerHTML = '<div class="empty">暂无委托记录</div>';
      return;
    }
    const canCancel = S.dash.meta.session.cancelable;
    body.innerHTML = `<table class="grid">
      <thead><tr>
        <th>时间</th><th>名称 / 代码</th><th>方向</th><th>类型</th><th>委托价</th>
        <th>数量</th><th>已成交</th><th>成交均价</th><th>状态</th><th>操作</th>
      </tr></thead>
      <tbody>${os.map((o) => {
        const isLive = o.status === 'pending' || o.status === 'partial';
        const avg = o.filledQty > 0 ? o.filledAmount / o.filledQty : null;
        const st = { pending: 'st-pending', partial: 'st-partial', filled: 'st-filled', cancelled: 'st-cancelled', expired: 'st-cancelled' }[o.status] || 'flat';
        return `<tr>
          <td>${o.time}</td>
          <td><div class="nm"><b>${o.name}</b><small>${o.code}</small></div></td>
          <td class="${o.side === 'buy' ? 'up' : 'down'}">${o.side === 'buy' ? '买入' : '卖出'}</td>
          <td class="flat">${o.orderType === 'market' ? '市价' : '限价'}</td>
          <td>${o.orderType === 'market' ? '市价' : fmt(o.price, 3)}</td>
          <td>${fmt(o.qty, 0)}</td>
          <td>${fmt(o.filledQty, 0)}</td>
          <td>${avg ? fmt(avg, 3) : '—'}</td>
          <td class="${st}">${o.statusLabel}${o.reason ? `<small style="color:#5b6373"> · ${o.reason}</small>` : ''}</td>
          <td><div class="ops">${
            isLive
              ? `<button class="cancel" data-cancel="${o.id}" ${canCancel ? '' : 'disabled title="当前时段不可撤单"'}>撤单</button>`
              : '—'
          }</div></td>
        </tr>`;
      }).join('')}</tbody></table>`;
    return;
  }

  if (S.bottomView === 'trades') {
    const ts = S.dash.trades;
    const realized = ts.reduce((s, t) => s + (t.realizedPnl || 0), 0);
    sum.innerHTML = `<span>成交 <b>${ts.length}</b> 笔</span>
      <span>已实现盈亏 <b class="${cls(realized)}">${sign(realized)}${fmt(realized)}</b></span>`;
    if (!ts.length) {
      body.innerHTML = '<div class="empty">暂无成交记录</div>';
      return;
    }
    body.innerHTML = `<table class="grid">
      <thead><tr>
        <th>时间</th><th>名称 / 代码</th><th>方向</th><th>成交价</th><th>数量</th>
        <th>金额</th><th>费用</th><th>持有</th><th>已实现盈亏</th>
      </tr></thead>
      <tbody>${ts.map((t) => {
        const fund = t.type === 'fund';
        const feeTip = `佣金 ${fmt(t.feeDetail?.commission || 0)} · 印花税 ${fmt(t.feeDetail?.stamp || 0)} · 过户 ${fmt(t.feeDetail?.transfer || 0)}${t.divTax ? ` · 红利税 ${fmt(t.divTax)}` : ''}`;
        return `<tr>
          <td>${t.time}</td>
          <td><div class="nm"><b>${t.name}</b><small>${t.code}${t.orderType === 'market' ? ' · 市价' : ''}</small></div></td>
          <td class="${t.side === 'buy' ? 'up' : 'down'}">${t.side === 'buy' ? (fund ? '申购' : '买入') : (fund ? '赎回' : '卖出')}</td>
          <td>${fmt(t.price, fund ? 4 : 3)}</td>
          <td>${fmt(t.qty, fund ? 2 : 0)}</td>
          <td>${fmt(t.amount)}</td>
          <td title="${feeTip}">${fmt(t.fee)}</td>
          <td class="flat">${t.holdDays != null ? t.holdDays + ' 天' : '—'}</td>
          <td class="${cls(t.realizedPnl || 0)}">${t.realizedPnl != null ? sign(t.realizedPnl) + fmt(t.realizedPnl) : '--'}</td>
        </tr>`;
      }).join('')}</tbody></table>`;
    return;
  }

  if (S.bottomView === 'bands') {
    if (S.bands && Date.now() - (S.bandsAt || 0) > 15000) loadBands(); // 面板打开时静默刷新
    if (!S.bands) {
      body.innerHTML = '<div class="empty">加载区间配置…</div>';
      loadBands();
      return;
    }
    const d = S.bands;
    const list = d.bands || [];
    const armed = list.filter((b) => b.enabled && b.armed).length;
    sum.innerHTML = `<span>区间 <b>${list.length}</b></span>
      <span>已武装 <b>${armed}</b></span>
      <span>待处理告警 <b class="${d.alerts.length ? 'st-partial' : ''}">${d.alerts.length}</b></span>
      <span>监控 <b>${d.live.startAt ? '运行中' : '未启动'}</b> · 自动分析 <b class="${d.agent.enabled ? 'up' : 'flat'}">${d.agent.enabled ? '开' : '关'}</b></span>`;

    const sel = S.sel || {};
    const cur = list.find((b) => b.code === sel.code);
    const esc = (s) => String(s == null ? '' : s).replace(/"/g, '&quot;').replace(/</g, '&lt;');
    const dp = (code) => (/^\d{6}$/.test(code || '') && /^[15]/.test(code) ? 3 : 2);

    const rows = list.map((b) => {
      const px = b.prevPrice;
      let pos = '<span class="flat">—</span>';
      if (px != null) {
        const d3 = dp(b.code);
        if (b.upper != null && px >= b.upper) pos = `<span class="up">已破上轨 +${(((px - b.upper) / b.upper) * 100).toFixed(2)}%</span>`;
        else if (b.lower != null && px <= b.lower) pos = `<span class="down">已破下轨 ${(((px - b.lower) / b.lower) * 100).toFixed(2)}%</span>`;
        else {
          const bits = [];
          if (b.upper != null) bits.push(`距上 ${(((px - b.upper) / b.upper) * 100).toFixed(2)}%`);
          if (b.lower != null) bits.push(`距下 ${(((px - b.lower) / b.lower) * 100).toFixed(2)}%`);
          pos = `<span class="flat">${bits.join(' / ')}</span>`;
        }
      }
      return `<tr>
        <td class="flat">${b.id}</td>
        <td><div class="nm"><b>${b.name}</b><small>${b.code}</small></div></td>
        <td>${b.lower != null ? fmt(b.lower, dp(b.code)) : '—'} ~ ${b.upper != null ? fmt(b.upper, dp(b.code)) : '—'}</td>
        <td>${px != null ? fmt(px, dp(b.code)) : '—'}</td>
        <td>${pos}</td>
        <td class="${b.enabled ? (b.armed ? 'st-filled' : 'st-partial') : 'st-cancelled'}">${b.enabled ? (b.armed ? '已武装' : '待回位') : '停用'}</td>
        <td class="flat">${b.action === 'analyze' ? '自动分析' : '仅提醒'} · ${b.cooldownMin}m</td>
        <td><div class="ops">
          <button data-bact="fire" data-id="${b.id}">试触发</button>
          <button data-bact="toggle" data-id="${b.id}" data-en="${b.enabled ? 0 : 1}">${b.enabled ? '停用' : '启用'}</button>
          <button class="cancel" data-bact="del" data-id="${b.id}">删除</button>
        </div></td>
      </tr>`;
    }).join('');

    const alerts = (d.alerts || []).map((a) => `<div class="alert-item">
        <b>${a.id}</b> ${a.time} ${a.name}(${a.code})
        <span class="${a.side === 'upper' ? 'up' : 'down'}">${a.side === 'upper' ? '上破' : '下破'} ${a.side === 'upper' ? a.upper : a.lower}</span>
        · 现价 ${a.price} · ${a.action === 'analyze' ? '自动分析' : '仅提醒'}
        ${a.agent ? ` · 分析：${{ running: '进行中', done: '已完成', queued: '排队', skipped: '跳过', auth: 'CLI 未登录', failed: '失败' }[a.agent.state] || a.agent.state}` : ''}
        <button class="mini" data-bact="ack" data-id="${a.id}">标记已处理</button>
      </div>`).join('');

    body.innerHTML = `
      <div class="band-form">
        <div class="bf-line">
          <span class="bf-title">为 <b>${sel.name || '—'}</b> <small>${sel.code || '先在左侧选标的'}</small> 设区间</span>
          <input id="bLower" type="number" step="0.001" placeholder="下轨" value="${cur && cur.lower != null ? cur.lower : ''}" />
          <input id="bUpper" type="number" step="0.001" placeholder="上轨" value="${cur && cur.upper != null ? cur.upper : ''}" />
          <select id="bAction">
            <option value="analyze"${!cur || cur.action === 'analyze' ? ' selected' : ''}>触发 → 自动二次分析</option>
            <option value="notify"${cur && cur.action === 'notify' ? ' selected' : ''}>触发 → 仅提醒</option>
          </select>
          <input id="bCool" type="number" step="5" min="1" title="冷却（分钟），冷却期内不重复触发" value="${cur ? cur.cooldownMin : 30}" />
          <input id="bNote" type="text" placeholder="备注（可选）" value="${esc(cur && cur.note)}" />
          <button id="bSave" class="minip">保存</button>
        </div>
        <div class="bf-tip">穿越才触发：上破需前值在上轨下、现价到上轨上方；触发后要回到区间内（缓冲 ${cur ? cur.resetPct : 0.3}%）才重新武装。监控需服务常驻（双击 start.bat）。</div>
      </div>
      ${alerts ? `<div class="alert-strip"><div class="alert-head">待处理告警 ${d.alerts.length} 条</div>${alerts}</div>` : ''}
      ${list.length
        ? `<table class="grid">
            <thead><tr><th>ID</th><th>名称 / 代码</th><th>区间</th><th>最新价</th><th>位置</th><th>状态</th><th>动作</th><th>操作</th></tr></thead>
            <tbody>${rows}</tbody></table>`
        : '<div class="empty">还没有区间。先在左侧选一个标的，填上轨 / 下轨后保存。</div>'}
    `;
    return;
  }

  sum.innerHTML = '';
  body.innerHTML = `<div class="rules">
    <div><b>交易时段</b>　开盘集合竞价 <code>09:15-09:25</code>（09:20 后不可撤单）· 连续竞价 <code>09:30-11:30 / 13:00-14:57</code> · 收盘集合竞价 <code>14:57-15:00</code>（不可撤单）· 盘后固定价格 <code>15:05-15:30</code>（仅科创板/创业板，按收盘价成交）</div>
    <div><b>委托与撮合</b>　限价单挂单排队，按五档<code>对手价</code>成交，支持部分成交，可撤单，<code>当日有效</code>；市价单五档即时成交、剩余自动撤销；涨停无卖盘、跌停无买盘时无法成交</div>
    <div><b>涨跌幅</b>　主板 <code>10%</code> · 创业板/科创板 <code>20%</code> · 北交所 <code>30%</code> · 主板 ST <code>5%</code> · 新股上市前 5 个交易日<code>不设限制</code></div>
    <div><b>价格笼子</b>　连续竞价限价申报：买入不高于基准价 <code>102%</code>、卖出不低于 <code>98%</code>（或 ±10 个最小变动单位，取宽者），超出即废单</div>
    <div><b>交易单位</b>　主板/创业板/ETF <code>100 股整数倍</code> · 科创板 <code>200 股起、1 股递增</code> · 北交所 <code>100 股起、1 股递增</code> · 零股须一次性卖出</div>
    <div><b>费用</b>　佣金 <code>万2.5</code>（最低 5 元）· 印花税 <code>千0.5</code>（仅股票卖出）· 过户费 <code>万0.1</code>（双向，ETF 免）· 场外基金申购费 <code>0.15%</code>、赎回费按持有期阶梯（&lt;7 天 1.5% / &lt;1 年 0.5% / &lt;2 年 0.25% / 更长 0）</div>
    <div><b>结算</b>　<code>T+1</code>：当日买入次日可卖，卖出资金当日可用 · 买入冻结资金、卖出冻结股份，撤单或收盘后自动解冻</div>
    <div><b>除权除息</b>　除权日自动处理现金分红入账、送转加股与成本摊薄；红利个税按持有期差别化（&lt;1 月 20% / &lt;1 年 10% / 超 1 年免征），于卖出时补扣</div>
    <div><b>行情</b>　东方财富（行情/K线/分红）+ 新浪（五档盘口，批量）；盘中缓存 2 秒；每笔行情带真实时间戳</div>
    <div><b>费率可改</b>　<code>data/fees.json</code> 按你的实际券商费率调整，改完重启服务生效</div>
  </div>`;
  } finally {
    body.scrollTop = keepTop;
  }
}

/* ============ 搜索添加 ============ */
let searchTimer = null;
function bindSearch() {
  const input = $('#searchInput');
  const box = $('#searchResult');

  input.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const kw = input.value.trim();
    if (!kw) {
      box.classList.add('hidden');
      return;
    }
    searchTimer = setTimeout(async () => {
      try {
        const rows = await api('/api/search?q=' + encodeURIComponent(kw));
        if (!rows.length) {
          box.innerHTML = '<div class="sr-empty">未找到匹配标的</div>';
        } else {
          box.innerHTML = rows
            .map((r) => `<div class="sr-item" data-secid="${r.secid}" data-code="${r.code}" data-name="${r.name}" data-type="${r.type}">
              <span>${r.name}</span>
              <span class="sr-sub">${r.code} · ${r.label}</span>
            </div>`).join('');
        }
        box.classList.remove('hidden');
      } catch (e) {
        box.innerHTML = `<div class="sr-empty">${e.message}</div>`;
        box.classList.remove('hidden');
      }
    }, 260);
  });

  box.addEventListener('click', async (e) => {
    const row = e.target.closest('.sr-item');
    if (!row) return;
    const { secid, code, name, type } = row.dataset;
    try {
      await api('/api/watch', { method: 'POST', body: { action: 'add', secid, code, name, type } });
      box.classList.add('hidden');
      input.value = '';
      await loadDashboard();
      selectSymbol({ secid, code, name, type });
      toast(`已添加 ${name}`, 'ok');
    } catch (err) {
      toast(err.message, 'err');
    }
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.watch-filter')) box.classList.add('hidden');
  });
}

/* ============ 交互绑定 ============ */
function selectSymbol(sym) {
  S.sel = { secid: sym.secid, code: sym.code, name: sym.name, type: sym.type };
  S.book = null;
  S.permission = null; // 切换标的后旧权限状态立即失效，等 loadDetail 返回再判定
  // 场外基金只提供净值曲线，隐藏 K 线切换
  $('#chartTabs').classList.toggle('hidden', sym.type === 'fund');
  renderWatch();
  renderQuoteHead();
  renderBook();
  syncOrderMode();
  loadDetail();
  loadChart();
}

function bindEvents() {
  // 自选点击 / 删除
  $('#watchList').addEventListener('click', async (e) => {
    const del = e.target.closest('[data-del]');
    if (del) {
      e.stopPropagation();
      try {
        await api('/api/watch', { method: 'POST', body: { action: 'remove', secid: del.dataset.del } });
        if (S.sel && S.sel.secid === del.dataset.del) S.sel = null;
        await loadDashboard();
        if (S.sel) selectSymbol(S.sel);
        toast('已移除', 'ok');
      } catch (err) {
        toast(err.message, 'err');
      }
      return;
    }
    const row = e.target.closest('.watch-row');
    if (!row) return;
    const w = S.dash.watch.find((x) => x.secid === row.dataset.secid);
    if (w) selectSymbol(w);
  });

  // 图表切换
  $('#chartTabs').addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    if (!tab) return;
    S.chartKind = tab.dataset.kind;
    $$('#chartTabs .tab').forEach((t) => t.classList.toggle('active', t === tab));
    loadChart();
  });

  // 底部切换
  $('#bottomTabs').addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    if (!tab) return;
    S.bottomView = tab.dataset.view;
    $('#bottomBody').scrollTop = 0;
    renderBottom();
  });

  // 持仓表操作
  $('#bottomBody').addEventListener('click', async (e) => {
    const cbtn = e.target.closest('[data-cancel]');
    if (cbtn) {
      if (cbtn.disabled) return;
      try {
        await api('/api/cancel', { method: 'POST', body: { id: cbtn.dataset.cancel } });
        toast('已撤单', 'ok');
        await loadDashboard();
      } catch (err) {
        toast(err.message, 'err');
      }
      return;
    }
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const p = S.dash.positions.find((x) => x.secid === btn.dataset.secid);
    if (!p) return;
    selectSymbol(p);
    setSide(btn.dataset.act);
    if (btn.dataset.act === 'sell' && p.type !== 'fund') {
      $('#inQty').value = p.available > 0 ? p.available : '';
    }
    updateEstimate();
  });

  // 委托类型：限价 / 市价
  $$('#orderType .otype').forEach((b) => {
    b.onclick = () => {
      S.orderType = b.dataset.ot;
      $$('#orderType .otype').forEach((x) => x.classList.toggle('active', x === b));
      syncOrderMode();
    };
  });

  // 买卖切换
  $('#tabBuy').onclick = () => setSide('buy');
  $('#tabSell').onclick = () => setSide('sell');

  // 现价
  $('#btnLivePrice').onclick = () => {
    const q = currentQuote();
    if (q) $('#inPrice').value = q.price.toFixed(isFundSel() ? 4 : 2);
    updateEstimate();
  };

  // 快捷比例
  $$('.quick-row [data-pct]').forEach((b) => {
    b.onclick = () => {
      const q = currentQuote();
      const price = Number($('#inPrice').value) || q?.price || 0;
      if (!price) return;
      const pct = Number(b.dataset.pct);
      if (S.side === 'buy') {
        const usable = S.dash.account.cash * pct;
        const lots = Math.floor(usable / (price * 100));
        $('#inQty').value = Math.max(lots * 100, 0);
      } else {
        const pos = positionOf(S.sel.secid);
        if (!pos) return;
        const qty = Math.floor((pos.available * pct) / 100) * 100;
        $('#inQty').value = qty > 0 ? qty : (pct >= 1 ? pos.available : 0);
      }
      updateEstimate();
    };
  });

  // 基金金额快捷
  $$('.quick-row [data-amt]').forEach((b) => {
    b.onclick = () => {
      const v = b.dataset.amt;
      $('#inAmount').value = v === 'all' ? Math.floor(S.dash.account.cash) : v;
      updateEstimate();
    };
  });

  $('#btnAllIn').onclick = () => {
    const q = currentQuote();
    const price = Number($('#inPrice').value) || q?.price || 0;
    if (!price) return;
    const lots = Math.floor((S.dash.account.cash * 0.999) / (price * 100));
    $('#inQty').value = Math.max(lots * 100, 0);
    updateEstimate();
  };

  $('#inQty').addEventListener('input', updateEstimate);
  $('#inAmount').addEventListener('input', updateEstimate);
  $('#inPrice').addEventListener('input', updateEstimate);
  $('#btnSubmit').onclick = submitOrder;

  // 重置账户
  $('#btnReset').onclick = async () => {
    if (!confirm('确定重置模拟账户？将清空持仓与成交记录，资金恢复为初始值。')) return;
    try {
      await api('/api/reset', { method: 'POST', body: { capital: 1000000 } });
      S.sel = null;
      await loadDashboard();
      if (S.sel) selectSymbol(S.sel);
      toast('模拟账户已重置', 'ok');
    } catch (e) {
      toast(e.message, 'err');
    }
  };

  $('#btnAdd').onclick = () => $('#searchInput').focus();
}

/* ============ 启动 ============ */
async function boot() {
  initChart();
  bindEvents();
  bindSearch();
  bindBands();

  // 支持 ?kind=day|week|month|trend5 直接打开指定图表
  const params = new URLSearchParams(location.search);
  const kindParam = params.get('kind');
  if (kindParam) {
    S.chartKind = kindParam;
    $$('#chartTabs .tab').forEach((t) => t.classList.toggle('active', t.dataset.kind === kindParam));
  }
  const viewParam = params.get('view');
  if (['positions', 'orders', 'trades', 'bands', 'rules'].includes(viewParam)) S.bottomView = viewParam;

  await loadDashboard();

  const symParam = new URLSearchParams(location.search).get('symbol');
  if (symParam) {
    const w = findSymbol(symParam);
    if (w) S.sel = { secid: w.secid, code: w.code, name: w.name, type: w.type };
  }

  if (S.sel) {
    selectSymbol(S.sel);
  } else {
    $('#chart').innerHTML = '<div class="empty" style="padding-top:80px">请先在左侧添加自选标的</div>';
  }

  // 轮询按交易时段自适应：盘中 3s / 非交易时段 20s；上一次未返回则跳过，避免请求堆叠
  const dashTick = async () => {
    if (!document.hidden) await loadDashboard();
    setTimeout(dashTick, S.dash?.meta?.session?.phase ? 3000 : 20000);
  };
  dashTick();

  const detailTick = async () => {
    if (!document.hidden && S.sel) {
      await loadDetail();
      if (S.chartKind === 'trend' || S.chartKind === 'trend5' || S.sel.type === 'fund') await loadChart();
    }
    setTimeout(detailTick, S.dash?.meta?.session?.phase ? 15000 : 60000);
  };
  detailTick();

  setLive(true);
}

boot().catch((e) => {
  console.error(e);
  toast('初始化失败：' + e.message, 'err');
});
