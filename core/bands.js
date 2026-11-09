/**
 * 价格区间（上轨 / 下轨）触发器 —— 盯盘台的「主动叫醒」能力
 *
 * 设计要点：
 * 1) 只在**穿越**时触发，不在区间外反复触发：上破要求前值 < 上轨、现价 ≥ 上轨。
 * 2) 触发后disarm，必须回到区间内（带 resetPct 缓冲）才重新武装，避免贴轨抖动刷屏。
 * 3) 冷却时间兜底：即使重新武装，冷却期内也不重复触发。
 * 4) 触发落盘到 data/alerts.json（pending），由盯盘台常驻监控、或定时「区间巡检」任务消费。
 * 5) 本模块只做纯文件操作与判定，不依赖 HTTP 服务，服务挂了也能判定与留痕。
 *
 * 配置 data/bands.json：  { pollSeconds, agent:{...}, bands:[...] }
 * 运行时 data/bands.state.json： { bands:{ id:{prevPrice,armed,side,lastFiredAt,lastPrice} }, seq }
 * 告警 data/alerts.json：  { seq, items:[...] }
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
// TD_DATA_DIR 仅供测试隔离，生产走 data/
const DATA = process.env.TD_DATA_DIR ? path.resolve(process.env.TD_DATA_DIR) : path.join(ROOT, 'data');
const CFG_FILE = path.join(DATA, 'bands.json');
const ST_FILE = path.join(DATA, 'bands.state.json');
const ALERT_FILE = path.join(DATA, 'alerts.json');

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const pad2 = (n) => String(n).padStart(2, '0');
const dayKey = (d = new Date()) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

const DEFAULT_PROMPT = [
  '【区间触发 · 二次分析】{name}（{code}）现价 {price}，{sideText}。告警号 {alertId}。',
  '工作目录 D:/workTest/trade-desk，先读 AGENTS.md，再读今日日志。',
  '只做三件事：',
  '1) node cli.js quote {code} 核对现价与量能，确认不是行情缓存错误；',
  '2) 判断是真突破还是插针噪声：看分时是否回抽、量能是否配合、所属板块是否同步；',
  '3) 给结论：维持原计划 / 修正计划 / 触发风控动作。需要动作时，先在时间线 note 说明依据。',
  '禁止自行开新仓买入；卖出必须符合计划与 data/autotrade.json 风控。',
  '收尾必须执行：node cli.js alert ack {alertId} --note "一句话结论"，把告警标记为已处理。',
  '全程中文，结论不超过 200 字。',
].join('\n');

const DEFAULT_CFG = {
  _说明:
    '价格区间触发器。bands 为区间规则，agent 为区间触发后自动发起的二次分析（需要本机 codebuddy CLI 已登录）。',
  pollSeconds: 20,
  agent: {
    _说明:
      'enabled=false 时只做「提醒 + 落盘告警」，不自动起分析进程；置 true 需先确认 CLI 可用（node cli.js band agent --probe）。',
    enabled: false,
    entry: '',
    model: '',
    timeoutMs: 900000,
    promptTemplate: DEFAULT_PROMPT,
  },
  bands: [],
};

function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJSON(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

// ---------------- 配置 ----------------

function loadConfig() {
  const raw = readJSON(CFG_FILE, null) || {};
  const cfg = {
    ...DEFAULT_CFG,
    ...raw,
    agent: { ...DEFAULT_CFG.agent, ...(raw.agent || {}) },
    bands: Array.isArray(raw.bands) ? raw.bands.map((b) => normalizeBand(b)) : [],
  };
  return cfg;
}

function saveConfig(cfg) {
  const out = {
    _说明: DEFAULT_CFG._说明,
    pollSeconds: Math.max(5, num(cfg.pollSeconds, 20)),
    agent: { ...DEFAULT_CFG.agent, ...(cfg.agent || {}) },
    bands: (cfg.bands || []).map((b) => normalizeBand(b)),
  };
  writeJSON(CFG_FILE, out);
  return out;
}

/** 代码 → 东方财富 secid（0=深，1=沪）。指数按 000xxx=沪 / 399xxx=深 处理。 */
function secidOf(code, type = 'stock') {
  const c = String(code || '').trim();
  if (!/^\d{6}$/.test(c)) throw new Error(`代码须为 6 位数字：${code}`);
  if (type === 'index') return (c.startsWith('399') ? '0.' : '1.') + c;
  if (/^[659]/.test(c)) return '1.' + c;
  return '0.' + c;
}

function normalizeBand(b = {}) {
  const code = String(b.code || '').trim();
  const type = b.type || (/^(5|1[5-9]|16|18)/.test(code) ? 'etf' : 'stock');
  const lower = b.lower == null || b.lower === '' ? null : num(b.lower);
  const upper = b.upper == null || b.upper === '' ? null : num(b.upper);
  const out = {
    id: b.id || '',
    code,
    secid: b.secid || (code ? secidOf(code, type) : ''),
    name: b.name || code,
    type,
    lower,
    upper,
    action: b.action === 'analyze' ? 'analyze' : 'notify',
    cooldownMin: Math.max(1, num(b.cooldownMin, 30)),
    resetPct: Math.max(0, num(b.resetPct, 0.3)),
    enabled: b.enabled !== false,
    note: b.note || '',
    createdAt: b.createdAt || '',
    lastFiredAt: b.lastFiredAt || '',
  };
  if (!out.code) throw new Error('缺少代码');
  if (out.lower == null && out.upper == null) throw new Error('上轨与下轨至少设一个');
  if (out.lower != null && !(out.lower > 0)) throw new Error('下轨须为正数');
  if (out.upper != null && !(out.upper > 0)) throw new Error('上轨须为正数');
  if (out.lower != null && out.upper != null && !(out.upper > out.lower)) {
    throw new Error(`上轨 ${out.upper} 必须高于下轨 ${out.lower}`);
  }
  return out;
}

function nextBandId(cfg) {
  const used = new Set((cfg.bands || []).map((b) => b.id));
  let i = (cfg.bands || []).length + 1;
  while (used.has('B' + pad2(i))) i += 1;
  return 'B' + pad2(i);
}

/** 新增或按 id/code 覆盖同标的区间（一只票一条） */
function upsertBand(input) {
  const cfg = loadConfig();
  const band = normalizeBand({ ...input });
  const idx = input.id
    ? cfg.bands.findIndex((b) => b.id === input.id)
    : cfg.bands.findIndex((b) => b.code === band.code);
  if (idx >= 0) {
    band.id = cfg.bands[idx].id;
    band.createdAt = cfg.bands[idx].createdAt || new Date().toISOString();
    cfg.bands[idx] = band;
  } else {
    band.id = band.id || nextBandId(cfg);
    band.createdAt = band.createdAt || new Date().toISOString();
    cfg.bands.push(band);
  }
  saveConfig(cfg);
  // 规则变了，武装状态一并重置，否则新上下轨沿用旧 armed 会漏触发
  const st = loadState();
  delete st.bands[band.id];
  saveState(st);
  return band;
}

function removeBand(id) {
  const cfg = loadConfig();
  const n = cfg.bands.length;
  cfg.bands = cfg.bands.filter((b) => b.id !== id);
  saveConfig(cfg);
  const st = loadState();
  delete st.bands[id];
  saveState(st);
  return n !== cfg.bands.length;
}

function toggleBand(id, enabled) {
  const cfg = loadConfig();
  const b = cfg.bands.find((x) => x.id === id);
  if (!b) throw new Error(`区间 ${id} 不存在`);
  b.enabled = enabled == null ? !b.enabled : !!enabled;
  saveConfig(cfg);
  return b;
}

// ---------------- 运行时状态 ----------------

function loadState() {
  const raw = readJSON(ST_FILE, null) || {};
  return {
    bands: raw.bands && typeof raw.bands === 'object' ? raw.bands : {},
    seq: num(raw.seq, 0),
    day: raw.day || '',
    firedToday: num(raw.firedToday, 0),
  };
}

function saveState(st) {
  writeJSON(ST_FILE, st);
}

/** 日切：新交易日把当日触发计数清零（不改 armed，避免跨日漏判） */
function rollState(st, now = new Date()) {
  const k = dayKey(now);
  if (st.day !== k) {
    st.day = k;
    st.firedToday = 0;
  }
  return st;
}

// ---------------- 判定 ----------------

/**
 * 单条区间的判定（纯函数，便于测试）
 * @param {object} band  区间规则
 * @param {object} st    该区间的运行时状态 {prevPrice, armed, side, lastFiredAt}
 * @param {number} price 最新价
 * @param {Date}   now
 * @returns {{fire:null|'upper'|'lower', side:string|null, suppressed:boolean,
 *            armed:boolean, state:object, reason:string}}
 */
function evaluate(band, st = {}, price, now = new Date()) {
  const px = num(price, 0);
  const prev = Number.isFinite(Number(st.prevPrice)) ? Number(st.prevPrice) : null;
  const next = {
    prevPrice: px || prev,
    armed: st.armed !== false,
    side: st.side || null,
    lastFiredAt: st.lastFiredAt || '',
  };
  const out = { fire: null, side: null, suppressed: false, armed: next.armed, state: next, reason: '' };

  if (!band || band.enabled === false || !(px > 0)) return out;

  const upper = band.upper == null ? null : num(band.upper);
  const lower = band.lower == null ? null : num(band.lower);
  const reset = Math.max(0, num(band.resetPct, 0.3)) / 100;

  // 未武装：只有回到区间内（带缓冲）才重新武装
  if (!next.armed) {
    const backUpper = next.side === 'upper' && upper != null && px <= upper * (1 - reset);
    const backLower = next.side === 'lower' && lower != null && px >= lower * (1 + reset);
    if (backUpper || backLower) {
      next.armed = true;
      next.side = null;
      out.armed = true;
      out.reason = '重新武装';
    }
    out.state = next;
    return out;
  }

  let side = null;
  if (upper != null && px >= upper && (prev == null || prev < upper)) side = 'upper';
  else if (lower != null && px <= lower && (prev == null || prev > lower)) side = 'lower';

  if (!side) {
    out.state = next;
    return out;
  }

  const cooldownMs = Math.max(1, num(band.cooldownMin, 30)) * 60000;
  const last = Date.parse(next.lastFiredAt || '') || 0;
  const cooling = last > 0 && now.getTime() - last < cooldownMs;

  out.fire = side;
  out.side = side;
  out.suppressed = cooling;
  next.armed = false;
  next.side = side;
  next.lastFiredAt = cooling ? next.lastFiredAt : now.toISOString();
  out.armed = false;
  out.state = next;
  out.reason = cooling ? '冷却中，抑制重复触发' : side === 'upper' ? '上破' : '下破';
  return out;
}

/** 批量判定，返回触发列表，并原地更新 state */
function evaluateAll(cfg, st, priceMap, now = new Date()) {
  const fired = [];
  for (const band of cfg.bands || []) {
    const q = priceMap.get(band.code) || priceMap.get(band.secid);
    const px = q && Number.isFinite(Number(q.price)) ? Number(q.price) : null;
    if (px == null) continue;
    const key = band.id || band.code;
    const prevState = st.bands[key] || {};
    const r = evaluate(band, prevState, px, now);
    st.bands[key] = r.state;
    if (r.fire && !r.suppressed) {
      fired.push({ band, side: r.fire, price: px, at: now, quote: q });
      st.firedToday = num(st.firedToday, 0) + 1;
    }
  }
  return fired;
}

// ---------------- 告警队列 ----------------

function loadAlerts() {
  const raw = readJSON(ALERT_FILE, null) || {};
  return { seq: num(raw.seq, 0), items: Array.isArray(raw.items) ? raw.items : [] };
}

function saveAlerts(a) {
  a.items = a.items.slice(0, 300);
  writeJSON(ALERT_FILE, a);
}

function pushAlert({ band, side, price, at = new Date(), quote = null, result = '' }) {
  const a = loadAlerts();
  a.seq = num(a.seq, 0) + 1;
  const item = {
    id: 'A' + String(a.seq).padStart(4, '0'),
    at: at.toISOString(),
    tradeDate: dayKey(at),
    time: `${pad2(at.getHours())}:${pad2(at.getMinutes())}`,
    bandId: band.id,
    code: band.code,
    secid: band.secid,
    name: band.name,
    type: band.type,
    side,
    price,
    lower: band.lower,
    upper: band.upper,
    action: band.action,
    bandNote: band.note || '',
    status: 'pending',
    result,
    ackAt: '',
    ackBy: '',
    agent: null,
  };
  a.items.unshift(item);
  saveAlerts(a);
  return item;
}

function pendingAlerts(tradeDate) {
  const a = loadAlerts();
  return a.items.filter(
    (it) => it.status === 'pending' && (!tradeDate || it.tradeDate === tradeDate)
  );
}

function ackAlert(id, { by = '巡检', note = '', status = 'acked' } = {}) {
  const a = loadAlerts();
  const it = a.items.find((x) => x.id === id);
  if (!it) throw new Error(`告警 ${id} 不存在`);
  it.status = status;
  it.ackBy = by;
  it.ackAt = new Date().toISOString();
  if (note) it.result = note;
  saveAlerts(a);
  return it;
}

/** 把一条告警渲染成一句话（时间线 / 终端 / 提示词共用） */
function alertText(it) {
  const dir = it.side === 'upper' ? '上破' : '下破';
  const line = it.side === 'upper' ? `上轨 ${it.upper}` : `下轨 ${it.lower}`;
  return `${it.name}(${it.code}) ${it.price} ${dir}${line}`;
}

// ---------------- 二次分析（自动发起） ----------------

function agentEntry(cfg = loadConfig()) {
  const custom = String(cfg.agent?.entry || '').trim();
  if (custom) return { cmd: process.execPath, pre: [], entry: custom };
  // 自动探测 WorkBuddy 内置 CLI
  const guesses = [
    'D:/program/workBuddy/resources/app.asar.unpacked/cli/dist/codebuddy-lite-wb.mjs',
    'C:/Program Files/WorkBuddy/resources/app.asar.unpacked/cli/dist/codebuddy-lite-wb.mjs',
  ].map((p) => p.replace(/\\/g, '/'));
  const env = process.env.WORKBUDDY_RESOURCES_PATH;
  if (env) guesses.unshift(path.join(env, 'app.asar.unpacked', 'cli', 'dist', 'codebuddy-lite-wb.mjs').replace(/\\/g, '/'));
  for (const g of guesses) if (fs.existsSync(g)) return { cmd: process.execPath, pre: [], entry: g };
  return null;
}

function buildPrompt(template, band, alert) {
  const sideText =
    alert.side === 'upper'
      ? `已上破区间上轨 ${band.upper}`
      : `已跌破区间下轨 ${band.lower}`;
  return String(template || DEFAULT_PROMPT)
    .replace(/\{name\}/g, band.name)
    .replace(/\{code\}/g, band.code)
    .replace(/\{secid\}/g, band.secid)
    .replace(/\{price\}/g, String(alert.price))
    .replace(/\{upper\}/g, band.upper == null ? '未设' : String(band.upper))
    .replace(/\{lower\}/g, band.lower == null ? '未设' : String(band.lower))
    .replace(/\{sideText\}/g, sideText)
    .replace(/\{alertId\}/g, alert.id || '')
    .replace(/\{note\}/g, band.note || '');
}

/**
 * 发起一次二次分析进程。返回 {ok, log, note}。
 * 注意：CLI 需要已登录，未登录会立刻返回 Authentication required，此时告警仍留在
 * pending 队列，由定时「区间巡检」任务兜底消费。
 */
function spawnAgent(prompt, cfg = loadConfig()) {
  const entry = agentEntry(cfg);
  if (!entry) return { ok: false, log: '', note: '未找到 WorkBuddy CLI 入口，跳过自动分析' };
  const agent = cfg.agent || {};
  const port = 51000 + Math.floor(Math.random() * 900);
  const args = [entry.entry, '-p', prompt, '-y', '--no-session-persistence', '--port', String(port)];
  if (agent.model) args.push('--model', String(agent.model));
  return { ok: true, entry, args };
}

module.exports = {
  CFG_FILE,
  ST_FILE,
  ALERT_FILE,
  DEFAULT_PROMPT,
  DEFAULT_CFG,
  secidOf,
  normalizeBand,
  loadConfig,
  saveConfig,
  upsertBand,
  removeBand,
  toggleBand,
  loadState,
  saveState,
  rollState,
  evaluate,
  evaluateAll,
  loadAlerts,
  saveAlerts,
  pushAlert,
  pendingAlerts,
  ackAlert,
  alertText,
  agentEntry,
  buildPrompt,
  spawnAgent,
};
