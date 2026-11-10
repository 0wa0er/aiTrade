'use strict';
/**
 * 条件单（到价 / 到点 自动委托）
 *
 * 为什么要有：区间触发（core/bands）只负责「叫醒」，止损止盈（core/live）只覆盖已持仓。
 * 中间缺一层「我打算在这个价位 / 这个时点做这笔交易」的挂单式意图——人不可能一直盯着，
 * 而 09:45 / 14:40 两个时点之间的窗口没人看盘。条件单把这层意图固化成数据。
 *
 * 设计边界（重要）：
 * 1) 本模块只做判定与状态机，**不下单**。真正下单由调用方 spawn `cli.js buy/sell`，
 *    风控闸门（板块权限、单票上限、单日买入上限、现金底线）全在 cli 里，绕不过去。
 * 2) 条件只判「当前价」，不回溯历史极值。20s 一轮的轮询会漏掉极短插针——
 *    这是已知近似，比「建单前已经触过的价立即成交」更安全。
 * 3) 一次性：触发即置 fired，不重复执行。执行失败记 attempts，满 3 次转 error 停下等人工，
 *    绝不无限重试把仓位打乱。
 * 4) 理由必填。跟观察池同一套逻辑：没有理由的条件单只是一时冲动的固化。
 *
 * 数据 data/cond.json：
 *   { _说明, items:[...], seq }
 * 没有独立的 state 文件：条件单的 active/fired/error 本身就是业务属性，
 * 跟 bands 那种「运行时武装位」不同，拆开反而要维护两份一致性。
 */

const fs = require('fs');
const path = require('path');
const R = require('./rules');

const ROOT = path.join(__dirname, '..');
// TD_DATA_DIR 仅供测试隔离，生产走 data/
const DATA = process.env.TD_DATA_DIR ? path.resolve(process.env.TD_DATA_DIR) : path.join(ROOT, 'data');
const FILE = path.join(DATA, 'cond.json');

const MAX_ATTEMPTS = 3; // 同一条件单最多尝试执行 3 次
const DEFAULT_TTL_DAYS = 5; // 默认有效期（交易日）
const DEFAULT_WINDOW = { from: '09:30', to: '14:57' };
const STATUSES = ['active', 'fired', 'expired', 'cancelled', 'error'];

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const pad2 = (n) => String(n).padStart(2, '0');
const round = (v, d = 3) => Math.round(num(v) * 10 ** d) / 10 ** d;
const todayKey = () => R.fmtDate(new Date());

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

// ---------------- 字段归一与校验 ----------------

/** 'HH:MM' 规范化；非法返回空串 */
function normHHMM(v) {
  const s = String(v || '').trim();
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return '';
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return '';
  return `${pad2(h)}:${pad2(mi)}`;
}

function normDateKey(s) {
  const str = String(s || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(str) ? str : '';
}

/**
 * 归一化一条条件单。缺字段补默认值，非法字段直接抛错——条件单写错了会真下单，宁可建单失败。
 */
function normalize(raw = {}, opts = {}) {
  const holidays = opts.holidays || new Set();
  const today = opts.today || todayKey();

  const code = String(raw.code || '').trim();
  if (!/^\d{6}$/.test(code)) throw new Error('条件单需要 6 位代码（例：512890）');

  const side = raw.side === 'sell' ? 'sell' : raw.side === 'buy' ? 'buy' : '';
  if (!side) throw new Error('条件单方向须为 buy 或 sell');

  const triggers = {};
  const t = normHHMM(raw.at || (raw.triggers && raw.triggers.time));
  if (t) triggers.time = t;

  const pRaw = raw.price != null ? { op: raw.op, value: raw.price } : raw.triggers && raw.triggers.price;
  if (pRaw && pRaw.value != null) {
    // 缺省按 >= 处理（跟 cli 的 --op 默认值一致）；显式写错方向则拒绝，不猜
    const rawOp = pRaw.op == null || pRaw.op === '' ? '>=' : pRaw.op;
    const op = rawOp === '<=' ? '<=' : rawOp === '>=' ? '>=' : null;
    if (!op) throw new Error('价格条件的比较方向须为 >= 或 <=');
    const value = num(pRaw.value);
    if (!(value > 0)) throw new Error('价格条件的阈值必须为正数');
    triggers.price = { op, value: round(value) };
  }
  if (!triggers.time && !triggers.price) throw new Error('条件单至少要有一个触发条件（--at 到点 或 --price 到价）');

  // 价格下限（保护垫）：只配「≤ 上限」使用，是回踩买入的防接刀条款。
  // 没有它，跳空暴跌击穿上限时会在深跌处照单成交，把「等回踩」变成「接下落中的刀」。
  const floorRaw = raw.floor == null || raw.floor === '' ? null : num(raw.floor);
  let floor = null;
  if (floorRaw != null) {
    if (!(floorRaw > 0)) throw new Error('价格下限（--floor）必须为正数');
    if (!triggers.price || triggers.price.op !== '<=')
      throw new Error('价格下限只用于「≤ 上限」的回踩买入，方向不匹配');
    if (floorRaw >= triggers.price.value)
      throw new Error(`价格下限 ${floorRaw} 必须低于上限 ${triggers.price.value}，否则区间为空`);
    floor = round(floorRaw);
  }

  // 只有价格条件时，time 缺省意味着「只要在窗口内到价就执行」；
  // 只有时间条件时，price 缺省意味着「到点就以市价执行」。
  const mode = raw.mode === 'any' ? 'any' : 'all';

  const qty = raw.qty == null || raw.qty === '' ? null : Math.floor(num(raw.qty));
  if (side === 'buy') {
    if (!(qty > 0)) throw new Error('买入条件单必须写数量（--qty）');
  } else if (qty != null && !(qty > 0)) {
    throw new Error('卖出数量必须为正整数；留空表示「全部可卖」');
  }

  const orderType = raw.orderType === 'limit' ? 'limit' : 'market';
  const limitPrice = raw.limitPrice == null || raw.limitPrice === '' ? null : num(raw.limitPrice);
  if (orderType === 'limit' && !(limitPrice > 0)) throw new Error('限价委托必须写委托价（--limit）');

  const wFrom = normHHMM(raw.window && raw.window.from) || DEFAULT_WINDOW.from;
  const wTo = normHHMM(raw.window && raw.window.to) || DEFAULT_WINDOW.to;
  if (wFrom >= wTo) throw new Error(`执行窗口 ${wFrom}~${wTo} 为空，起始须早于结束`);

  const note = String(raw.note || '').trim();
  if (!note) throw new Error('条件单必须写理由（--note）：没有理由的挂单只是一时冲动的固化');

  let expireOn = normDateKey(raw.expireOn);
  if (!expireOn) {
    // 默认 5 个交易日后失效，避免忘记撤单在两周后突然成交
    expireOn = R.nextTradingDateKey(new Date(`${today}T00:00:00`), holidays, DEFAULT_TTL_DAYS);
  }

  const status = STATUSES.includes(raw.status) ? raw.status : 'active';
  if (status === 'active' && expireOn < today) {
    throw new Error(`有效期 ${expireOn} 早于今天，条件单建立即失效`);
  }

  return {
    id: String(raw.id || '').trim(),
    code,
    name: String(raw.name || code).trim(),
    type: raw.type === 'etf' || /^[15]/.test(code) ? 'etf' : 'stock',
    side,
    qty,
    orderType,
    limitPrice,
    triggers,
    mode,
    floor,
    window: { from: wFrom, to: wTo },
    expireOn,
    note,
    // take = 移动止盈脚本自动维护的单（每天修正，只上移）；agent = 判断回路下的单；manual = 人工
    source: ['agent', 'take'].includes(raw.source) ? raw.source : 'manual',
    status,
    createdAt: raw.createdAt || new Date().toISOString(),
    firedAt: raw.firedAt || '',
    firePrice: raw.firePrice == null ? null : num(raw.firePrice),
    attempts: Math.max(0, Math.floor(num(raw.attempts))),
    lastError: String(raw.lastError || ''),
    result: raw.result || null,
    // 修正留痕：止盈线上移的历史（谁、何时、从什么价到什么价、为什么）
    revisions: Array.isArray(raw.revisions) ? raw.revisions : [],
  };
}

// ---------------- 存储 ----------------

function load() {
  const raw = readJSON(FILE, null) || {};
  const items = Array.isArray(raw.items) ? raw.items.map((x) => {
    try {
      return normalize(x, { today: normDateKey(x.createdAt && x.createdAt.slice(0, 10)) || todayKey() });
    } catch (e) {
      // 手工改坏了不让整个文件读不出来：降级为 error 条目，界面上能看见
      return { ...x, status: 'error', lastError: `字段非法：${e.message}` };
    }
  }) : [];
  return { items, seq: Math.max(0, Math.floor(num(raw.seq, items.length))) };
}

function save(db) {
  writeJSON(FILE, {
    _说明:
      '条件单：到价 / 到点自动委托。status=active 待触发，fired 已执行，expired 过期，cancelled 已撤，error 执行失败待人工。',
    seq: Math.max(0, Math.floor(num(db.seq))),
    items: db.items,
  });
}

function nextId(db) {
  const n = Math.max(0, Math.floor(num(db.seq))) + 1;
  db.seq = n;
  return `C${pad2(n)}`;
}

/** 新增条件单（不做幂等：同一标的同方向允许存在多张不同价位的单） */
function add(raw, opts = {}) {
  const db = load();
  const item = normalize({ ...raw, status: 'active', attempts: 0, firedAt: '', lastError: '' }, opts);
  item.id = nextId(db);
  db.items.push(item);
  save(db);
  return item;
}

function find(db, idOrCode) {
  const key = String(idOrCode || '').trim();
  return db.items.find((x) => x.id === key) || db.items.find((x) => x.code === key && x.status === 'active') || null;
}

function setStatus(idOrCode, status, extra = {}) {
  const db = load();
  const hit = find(db, idOrCode);
  if (!hit) throw new Error(`找不到条件单 ${idOrCode}`);
  if (!STATUSES.includes(status)) throw new Error(`未知状态 ${status}`);
  Object.assign(hit, { status }, extra);
  save(db);
  return hit;
}

function remove(idOrCode) {
  const db = load();
  const hit = find(db, idOrCode);
  if (!hit) throw new Error(`找不到条件单 ${idOrCode}`);
  db.items = db.items.filter((x) => x.id !== hit.id);
  save(db);
  return hit;
}

/** 按条件筛选（移动止盈要按 source=take 找自己的单） */
function list(filter = {}) {
  const db = load();
  return db.items.filter(
    (x) =>
      (!filter.status || x.status === filter.status) &&
      (!filter.source || x.source === filter.source) &&
      (!filter.code || x.code === filter.code) &&
      (!filter.side || x.side === filter.side)
  );
}

/**
 * 修正一张 active 条件单 —— 供移动止盈每天上移止盈线、续期用。
 *
 * 只允许改价格阈值 / 有效期 / 数量 / 理由；标的与方向不在白名单里，
 * 因为改方向等于换了一张单，应该撤了重下，否则修正留痕会张冠李戴。
 * 每次修正把「从什么描述到什么描述」压进 revisions，时间线上能看出是哪天抬的线。
 */
function revise(idOrCode, patch = {}, opts = {}) {
  const db = load();
  const key = String(idOrCode || '').trim();
  const idx = db.items.findIndex((x) => x.id === key);
  if (idx < 0) throw new Error(`找不到条件单 ${key}`);
  const cur = db.items[idx];
  if (cur.status !== 'active') throw new Error(`条件单 ${cur.id} 状态为 ${cur.status}，只有 active 可修正`);

  const merged = {
    ...cur,
    ...patch,
    // 标的、方向、来源锁定：改它们等于换了一张单，应该撤了重下，
    // 否则 revisions 里的「从 1.29 改到 1.33」会挂到另一只票名下。
    code: cur.code,
    name: cur.name,
    type: cur.type,
    side: cur.side,
    source: cur.source,
    triggers: { ...cur.triggers, ...(patch.triggers || {}) },
    window: { ...cur.window, ...(patch.window || {}) },
  };
  const next = normalize(merged, { today: opts.today || todayKey() });
  next.id = cur.id;
  next.createdAt = cur.createdAt;
  next.revisions = (cur.revisions || []).concat([
    {
      at: new Date().toISOString(),
      from: describe(cur),
      to: describe(next),
      why: String(patch.why || '').trim(),
    },
  ]);

  db.items[idx] = next;
  save(db);
  return next;
}

/** 清掉所有已终结的条目（fired/expired/cancelled），error 保留——那是需要人看的 */
function prune() {
  const db = load();
  const before = db.items.length;
  db.items = db.items.filter((x) => !['fired', 'expired', 'cancelled'].includes(x.status));
  save(db);
  return before - db.items.length;
}

// ---------------- 判定 ----------------

const cmp = (a, op, b) => (op === '>=' ? a >= b - 1e-9 : a <= b + 1e-9);

/**
 * 判定一条条件单当前是否该执行。
 * 纯函数，不读文件、不看时段。
 *
 * @param {object} item 归一化后的条件单
 * @param {object} ctx  { hhmm:'10:23', price:1.234, today:'2026-11-09' }
 * @returns {{fire:boolean, why:string, mark:string|null, hits:object}}
 *   mark 非空表示需要改状态（expired）——由调用方执行，本函数无副作用
 */
function evaluate(item, ctx = {}) {
  const hhmm = normHHMM(ctx.hhmm) || '00:00';
  const today = normDateKey(ctx.today) || todayKey();
  const price = num(ctx.price);

  if (item.status !== 'active') return { fire: false, why: `状态 ${item.status}`, mark: null, hits: {} };
  if (item.expireOn && today > item.expireOn) return { fire: false, why: `已过期（${item.expireOn}）`, mark: 'expired', hits: {} };

  if (hhmm < item.window.from) return { fire: false, why: `未到执行窗口（${item.window.from} 起）`, mark: null, hits: {} };
  if (hhmm > item.window.to) return { fire: false, why: `已过执行窗口（${item.window.to} 止）`, mark: null, hits: {} };

  const hits = {};
  const checks = [];

  // 保护下限先判：跌破就不是「回踩」，是破位，任何模式下都不接
  if (item.floor != null && price > 0 && price < item.floor - 1e-9) {
    return {
      fire: false,
      why: `现价 ${round(price)} 已跌破保护下限 ${round(item.floor)}（破位不接）`,
      mark: null,
      hits,
    };
  }

  if (item.triggers.time) {
    const hit = hhmm >= item.triggers.time;
    hits.time = hit;
    checks.push({ key: 'time', hit, text: `${item.triggers.time} 到点${hit ? '已到' : '未到'}` });
  }
  if (item.triggers.price) {
    const { op, value } = item.triggers.price;
    if (!(price > 0)) return { fire: false, why: '取不到现价', mark: null, hits: {} };
    const hit = cmp(price, op, value);
    hits.price = hit;
    checks.push({ key: 'price', hit, text: `现价 ${round(price)} ${op === '>=' ? '未到' : '未破'} ${round(value)}` });
  }
  if (!checks.length) return { fire: false, why: '无条件', mark: null, hits };

  const fire = item.mode === 'any' ? checks.some((c) => c.hit) : checks.every((c) => c.hit);
  const why = fire ? '条件满足' : checks.filter((c) => !c.hit).map((c) => c.text).join('；');
  return { fire, why, mark: null, hits };
}

/**
 * 批量扫描：把「该执行的」挑出来，同时把过期的置 expired。
 * @returns {{due:Array, changed:Array, waiting:Array}}
 */
function scan(items, ctx = {}) {
  const due = [];
  const changed = [];
  const waiting = [];
  for (const item of items) {
    const r = evaluate(item, ctx);
    if (r.mark) {
      changed.push({ id: item.id, status: r.mark, why: r.why });
      continue;
    }
    if (r.fire) due.push({ item, price: num(ctx.price) });
    else if (item.status === 'active') waiting.push({ id: item.id, why: r.why });
  }
  return { due, changed, waiting };
}

/** 一次执行失败后推进尝试次数；满上限转 error 停下等人工 */
function recordFailure(item, msg) {
  const attempts = Math.max(0, num(item.attempts)) + 1;
  const status = attempts >= MAX_ATTEMPTS ? 'error' : 'active';
  return { attempts, status, lastError: String(msg || '').slice(0, 300) };
}

/** 一句话描述，用于 list 与时间线 */
function describe(item) {
  const bits = [];
  if (item.triggers.time) bits.push(`${item.triggers.time} 到点`);
  if (item.triggers.price) bits.push(`${item.triggers.price.op === '>=' ? '≥' : '≤'} ${round(item.triggers.price.value)}`);
  if (item.floor != null) bits.push(`下限 ≥ ${round(item.floor)}`);
  const cond = bits.join(item.mode === 'any' ? ' 或 ' : ' 且 ') || '无条件';
  const qty = item.qty == null ? '全部可卖' : `${item.qty}股`;
  const ord = item.orderType === 'limit' ? `限价 ${round(item.limitPrice)}` : '市价';
  return `${item.side === 'buy' ? '买' : '卖'} ${qty} · ${ord} · ${cond} · 窗口 ${item.window.from}~${item.window.to} · 有效至 ${item.expireOn}`;
}

module.exports = {
  FILE,
  STATUSES,
  MAX_ATTEMPTS,
  DEFAULT_TTL_DAYS,
  normalize,
  load,
  save,
  add,
  find,
  setStatus,
  remove,
  list,
  revise,
  prune,
  evaluate,
  scan,
  recordFailure,
  describe,
  normHHMM,
  round,
};
