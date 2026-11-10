#!/usr/bin/env node
/**
 * 实时盯盘守护（常驻进程）
 *
 * 为什么单独存在：定时任务是「到点唤醒、做完即走」，两次唤醒之间的分钟级穿越没人看。
 * 这个进程在交易时段常驻，负责四件事：
 *   1) 区间穿越：驱动服务端补一次判定，把触发落成告警 + 时间线；
 *   2) 持仓风控：止损 / 止盈 / 弱于大盘，实时算，命中即调用 cli.js sell（--auto 才执行，默认只告警）；
 *   3) 条件单：把 data/cond.json 里到价 / 到点的单子交给 cli.js cond check 执行（风控闸门在 cli 里）；
 *   4) 可互动：本地 HTTP 接口，能查当前快照、能让它记一句话、能暂停/恢复。
 *
 * 不负责「决定买什么」。条件单是事先写好的意图，这里只负责到点执行。
 *
 * 用法：
 *   node tools/live.js                     默认 20s 一轮，交易时段工作，15:05 自停
 *   node tools/live.js --interval 10       10s 一轮
 *   node tools/live.js --until 14:30       到点自停
 *   node tools/live.js --auto              命中止损/止盈时真的下单（默认只写告警）
 *   node tools/live.js --force             忽略时段限制（收盘后调试用）
 *
 * 注意：条件单（data/cond.json）不受 --auto 约束——那是事先写死的明确指令，
 * 触发即执行；要停某张单用 `node cli.js cond off C01`，要全停就在盯盘进程里 halt。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const L = require('../core/live');
const J = require('../core/journal');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const LIVE_DIR = path.join(DATA, 'live');
const BASE = process.env.TD_BASE || `http://127.0.0.1:${process.env.PORT || 5193}`;
const LISTEN = Number(process.env.TD_LIVE_PORT || 5194);

const argv = process.argv.slice(2);
const flag = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = argv[i + 1];
  return !v || v.startsWith('--') ? true : v;
};
const INTERVAL = Math.max(5, Number(flag('interval', 20))) * 1000;
const AUTO = flag('auto', false) === true;
const FORCE = flag('force', false) === true;
// 默认收工时点：正常 15:05；--force 且已过 15:05（盘后调试）则跑到当天结束，否则会一启动就退出
const DEFAULT_UNTIL = (() => {
  const d = new Date();
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return FORCE && hhmm >= '15:05' ? '23:59' : '15:05';
})();
const UNTIL = String(flag('until', DEFAULT_UNTIL));

const CFG = JSON.parse(fs.readFileSync(path.join(DATA, 'autotrade.json'), 'utf8'));
const RISK = CFG.risk || {};

const S = {
  startAt: new Date().toISOString(),
  ticks: 0,
  errors: 0,
  lastTick: null,
  halted: false,
  haltedReason: '',
  snapshot: {},
  events: [],
  dayHigh: {},
  notes: [],
};

const nowHHMM = () => {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

function log(...a) {
  console.log(`[${nowHHMM()}]`, ...a);
}

function event(type, text, extra = {}) {
  const e = { at: new Date().toISOString(), type, text, ...extra };
  S.events.push(e);
  if (S.events.length > 200) S.events.shift();
  fs.mkdirSync(LIVE_DIR, { recursive: true });
  const day = J.dateKey();
  fs.appendFileSync(path.join(LIVE_DIR, `events-${day}.jsonl`), `${JSON.stringify(e)}\n`, 'utf8');
  log(`${type} ${text}`);
  return e;
}

async function getJSON(p) {
  const r = await fetch(BASE + p, { signal: AbortSignal.timeout(8000) });
  const j = await r.json();
  if (!j.ok) throw new Error(j.msg || '接口失败');
  return j.data;
}
async function postJSON(p, body) {
  const r = await fetch(BASE + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(12000),
  });
  return r.json();
}

/** 让 cli.js 去下单（风控闸门在 cli 里，绝不直连 /api/order） */
function cliSell(code, qty) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(ROOT, 'cli.js'), 'sell', code, String(qty)], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (code2) => resolve({ ok: code2 === 0, out: out.trim().slice(-400) }));
  });
}

/**
 * 条件单：交给 cli.js cond check 统一判定 + 执行。
 * 为什么不在这里自己判：判定、执行、状态机、风控只在 cli 那一份，避免两份逻辑漂移。
 * 没条件单时本地先看一眼就跳过，不为空列表白起进程。
 */
function cliCondCheck() {
  const K = require('../core/cond');
  let active = [];
  try {
    active = K.load().items.filter((x) => x.status === 'active');
  } catch (e) {
    return Promise.resolve({ ok: true, out: 'IDLE' });
  }
  if (!active.length) return Promise.resolve({ ok: true, out: 'IDLE', count: 0 });

  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(ROOT, 'cli.js'), 'cond', 'check'], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    // 条件单里可能连着下单，给足时间；卡死不留孤儿进程
    const timer = setTimeout(() => {
      try {
        p.kill();
      } catch (e) {}
    }, 60000);
    p.on('close', (code2) => {
      clearTimeout(timer);
      resolve({ ok: code2 === 0, out: out.trim().slice(-600), count: active.length });
    });
  });
}

async function breadth() {
  // 涨跌分布只有 westock 有；每 5 分钟取一次，避免每轮 spawn
  const cache = S.snapshot.breadth;
  if (cache && Date.now() - (cache.ts || 0) < 5 * 60 * 1000) return cache;
  return new Promise((resolve) => {
    const exe = process.env.WESTOCK || path.join(process.env.USERPROFILE || '', '.local', 'bin', 'westock.exe');
    if (!fs.existsSync(exe)) return resolve(null);
    const p = spawn(exe, ['changedist'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('close', () => {
      const amt = out.match(/两市成交额：([\d.]+)亿/);
      const ratio = out.match(/上涨家数占比全市场(\d+)%/);
      // 按区间分布逐行累加：只取单行会把「涨 2242 家」错算成 2~0% 那一档的 1485
      let up = 0;
      let down = 0;
      let limitUp = null;
      let limitDown = null;
      for (const line of out.split('\n')) {
        const m = line.match(/^\|\s*(\d+)\s*\|\s*(涨|跌|平)\s*\|\s*([^|]+?)\s*\|/);
        if (!m) continue;
        const n = Number(m[1]);
        const dir = m[2];
        const sec = m[3].trim();
        if (dir === '涨') up += n;
        if (dir === '跌') down += n;
        if (sec === '涨停') limitUp = n;
        if (sec === '跌停') limitDown = n;
      }
      if (!ratio) return resolve(null);
      resolve({
        ts: Date.now(),
        upRatio: Number(ratio[1]),
        amountYi: amt ? Number(amt[1]) : null,
        limitUp,
        limitDown,
        up: up || null,
        down: down || null,
      });
    });
    setTimeout(() => p.kill(), 8000);
  });
}

async function tick() {
  if (S.halted) return;
  S.ticks += 1;
  S.lastTick = new Date().toISOString();

  const dash = await getJSON('/api/dashboard');
  const sess = dash.meta?.session || {};
  const tradable = !!sess.accept;

  // 区间：让服务补一次判定（服务自己 20s 一轮，这里只是兜底；重复判定不会重复告警）
  let fired = [];
  try {
    const r = await postJSON('/api/bands', { action: 'check' });
    fired = (r.data && r.data.fired) || [];
  } catch (e) {
    /* 区间判定失败不影响风控 */
  }

  // 指数
  let indices = {};
  try {
    const q = await getJSON('/api/quotes?secids=1.000001,0.399006,1.000688');
    for (const [k, label] of [
      ['000001', '上证'],
      ['399006', '创业板'],
      ['000688', '科创50'],
    ]) {
      const row = (q.quotes || q || []).find?.((x) => String(x.code) === k);
      if (row) indices[label] = { price: row.price, pct: row.pct };
    }
  } catch (e) {
    /* 指数取不到不致命 */
  }

  const benchPct = indices['上证'] ? indices['上证'].pct : null;
  const positions = (dash.positions || []).filter((p) => Number(p.qty) > 0);
  for (const p of positions) {
    const hi = Math.max(Number(p.high) || 0, Number(p.price) || 0);
    S.dayHigh[p.code] = Math.max(S.dayHigh[p.code] || 0, hi);
  }

  const signals = L.riskSignals(positions, { risk: RISK, benchPct, dayHigh: S.dayHigh });
  const b = await breadth();

  // 条件单：到价 / 到点自动委托。判定、执行、状态机全在 cli.js，这里只负责按时叫它。
  const cond = await cliCondCheck();
  if (cond.out && cond.out !== 'IDLE' && !cond.out.startsWith('HOLIDAY')) {
    // 时间线已由 cli.js cond check 写入，这里只留一条事件，不重复记
    event('cond', cond.out.replace(/\n+/g, ' ｜ ').slice(0, 400), { active: cond.count || 0 });
  }

  S.snapshot = {
    ts: new Date().toISOString(),
    session: sess.label || '',
    sessionCode: sess.code || '',
    tradable,
    indices,
    breadth: b,
    positions: positions.length,
    equity: dash.account?.totalAsset ?? null,
    cash: dash.account?.totalCash ?? null,
    signals,
    cond: { active: cond.count || 0, lastOut: cond.out && cond.out !== 'IDLE' ? cond.out.slice(0, 200) : '' },
    fired: fired.map((f) => `${f.name}(${f.code}) ${f.side === 'upper' ? '上破' : '下破'} ${f.price}`),
  };

  fs.mkdirSync(LIVE_DIR, { recursive: true });
  fs.writeFileSync(path.join(LIVE_DIR, 'snapshot.json'), JSON.stringify(S.snapshot, null, 1), 'utf8');

  // 区间触发落痕
  for (const f of L.dedupeAlerts(
    fired.map((x) => ({ ...x, side: x.side })),
    S._alertSeen || (S._alertSeen = {})
  )) {
    event('band', `区间触发 ${f.name}(${f.code}) ${f.side === 'upper' ? '上破' : '下破'} ${f.price}`, { code: f.code });
    J.appendTimeline({
      tag: '风控',
      text: `[盯盘] 区间触发 ${f.name}(${f.code}) ${f.side === 'upper' ? '上破上轨' : '跌破下轨'} ${f.price}，已进入告警队列待二次分析`,
    });
  }

  // 风控信号
  for (const sig of signals) {
    const key = `${sig.code}|${sig.type}`;
    S._sigSeen = S._sigSeen || {};
    if (S._sigSeen[key]) continue; // 同一信号只处理一次，避免每 20s 重复下单
    S._sigSeen[key] = true;
    event(sig.type, sig.text, { code: sig.code, severity: sig.severity });

    // --auto 只执行硬止损（-7% 红线）。另外两类刻意不给自动化：
    //   take（止盈）：收益优化，急涨中自动卖容易卖飞，留给人判断；
    //   structure（弱于大盘 2 倍）：幅度可能只有 -2%，自动清仓过于激进。
    const autoExec = AUTO && tradable && sig.type === 'stop';
    if (autoExec) {
      const r = await cliSell(sig.code, sig.qty);
      event('exec', `已执行卖出 ${sig.code} ${sig.qty}：${r.ok ? '成功' : '失败'}`, { out: r.out });
      J.appendTimeline({
        tag: '风控',
        text: `[盯盘·自动] ${sig.text}；已下单卖出 ${sig.qty}，${r.ok ? '成交' : '失败：' + r.out.slice(0, 80)}`,
      });
    } else {
      const why = !AUTO
        ? '仅告警，未自动下单'
        : !tradable
          ? '不可委托时段，未下单'
          : `仅告警（--auto 只执行止损，${sig.type === 'take' ? '止盈' : '结构'}信号留给人工）`;
      J.appendTimeline({ tag: '风控', text: `[盯盘] ${sig.text}（${why}）` });
    }
  }
}

// ---------------- 互动接口 ----------------
function serve() {
  const server = http.createServer((req, res) => {
    const send = (code, obj) => {
      const buf = Buffer.from(JSON.stringify(obj), 'utf8');
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(buf);
    };
    if (req.method === 'GET' && req.url.startsWith('/state')) {
      return send(200, { ok: true, data: { ...S, pid: process.pid, until: UNTIL, auto: AUTO, interval: INTERVAL / 1000 } });
    }
    if (req.method === 'POST' && req.url.startsWith('/cmd')) {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        let b = {};
        try {
          b = JSON.parse(body || '{}');
        } catch (e) {
          return send(400, { ok: false, msg: 'JSON 解析失败' });
        }
        if (b.action === 'note') {
          const text = String(b.text || '').trim();
          if (!text) return send(400, { ok: false, msg: '内容为空' });
          S.notes.push({ at: nowHHMM(), text });
          J.appendTimeline({ tag: '记录', text: `[盯盘·互动] ${text}` });
          event('note', text);
          return send(200, { ok: true, data: { noted: text } });
        }
        if (b.action === 'halt') {
          S.halted = true;
          S.haltedReason = String(b.text || '手动暂停');
          event('halt', S.haltedReason);
          return send(200, { ok: true, data: { halted: true } });
        }
        if (b.action === 'resume') {
          S.halted = false;
          S.haltedReason = '';
          event('resume', '恢复盯盘');
          return send(200, { ok: true, data: { halted: false } });
        }
        return send(400, { ok: false, msg: `未知动作：${b.action}` });
      });
      return;
    }
    send(404, { ok: false, msg: 'not found' });
  });
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.error(`盯盘端口 ${LISTEN} 已被占用：可能已有一个盯盘进程在跑（node cli.js live status 查看）`);
      process.exit(2);
    }
    throw e;
  });
  server.listen(LISTEN, '127.0.0.1', () => log(`互动接口 http://127.0.0.1:${LISTEN}/state`));
  return server;
}

// ---------------- 主循环 ----------------
async function loop() {
  if (nowHHMM() >= UNTIL) {
    log(`到点 ${UNTIL}，盯盘收工`);
    J.appendTimeline({ tag: '运维', text: `[盯盘] 收工：共 ${S.ticks} 轮，事件 ${S.events.length} 条` });
    try {
      fs.unlinkSync(path.join(LIVE_DIR, 'live.pid'));
    } catch (e) {}
    process.exit(0);
  }
  try {
    await tick();
  } catch (e) {
    S.errors += 1;
    if (S.errors % 10 === 1) log(`取数失败（累计 ${S.errors} 次）：${e.message}`);
  }
  setTimeout(loop, INTERVAL);
}

(async () => {
  fs.mkdirSync(LIVE_DIR, { recursive: true });
  const lockFile = path.join(LIVE_DIR, 'live.pid');
  if (fs.existsSync(lockFile)) {
    const old = Number(fs.readFileSync(lockFile, 'utf8'));
    if (old && old !== process.pid) {
      try {
        process.kill(old, 0);
        console.error(`已有盯盘进程在跑（PID ${old}）。先 node cli.js live off 再启动。`);
        process.exit(2);
      } catch (e) {
        /* 进程已死，占用锁无效，继续 */
      }
    }
  }
  fs.writeFileSync(lockFile, String(process.pid), 'utf8');

  // 时段闸门：非交易时段不空转（除非 --force）
  if (!FORCE) {
    try {
      const d = await getJSON('/api/dashboard');
      const sess = d.meta?.session || {};
      if (!sess.accept) {
        console.error(`当前时段「${sess.label}」不可委托，盯盘不启动（调试加 --force）`);
        fs.unlinkSync(lockFile);
        process.exit(0);
      }
    } catch (e) {
      console.error(`服务不可用（${BASE}）：${e.message}。先 node cli.js status 拉起服务`);
      fs.unlinkSync(lockFile);
      process.exit(2);
    }
  }

  serve();
  let activeCond = 0;
  try {
    activeCond = require('../core/cond').load().items.filter((x) => x.status === 'active').length;
  } catch (e) {
    /* 条件单文件损坏不影响盯盘主流程 */
  }
  event(
    'start',
    `盯盘上线：${INTERVAL / 1000}s 一轮，${UNTIL} 收工，${AUTO ? '自动执行卖出' : '仅告警'}` +
      (activeCond ? `，${activeCond} 张条件单待触发` : '')
  );
  J.appendTimeline({ tag: '运维', text: `[盯盘] 实时盯盘上线（PID ${process.pid}，${INTERVAL / 1000}s 一轮，${UNTIL} 收工，${AUTO ? '止盈止损自动执行' : '仅告警'}）` });

  const bye = () => {
    try {
      fs.unlinkSync(lockFile);
    } catch (e) {}
    process.exit(0);
  };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
  loop();
})();
