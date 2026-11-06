/**
 * 日志引擎 —— 让每篇日志都有稳定结构，供人和后续 agent 会话解析。
 *
 * 设计要点：
 * 1) 用 HTML 注释做锚点（<!-- TL:START --> 等），正文怎么改都不会破坏定位。
 * 2) 四个区块职责分离：META（账户快照）/ 时间线（append-only）/ 计划 / 复盘。
 * 3) 时间线条目永远进「时间线」区，不会被追加到文件末尾 —— 这是旧实现的病根。
 * 4) 旧格式文件首次写入时自动迁移，原文不丢（进「历史正文」区）。
 *
 * 所有函数是纯文件操作，不依赖服务，服务挂掉时也能写日志。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
// TD_JOURNAL_DIR 仅供测试隔离，生产走 data/journal
const DIR = process.env.TD_JOURNAL_DIR
  ? path.resolve(process.env.TD_JOURNAL_DIR)
  : path.join(ROOT, 'data', 'journal');
const ARCHIVE = path.join(DIR, 'archive');

const TAGS = ['计划', '交易', '风控', '复盘', '运维', '自检', '记录'];
const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const RESERVED = ['README', '_TEMPLATE', 'INDEX'];

const A = {
  tl: ['<!-- TL:START -->', '<!-- TL:END -->'],
  plan: ['<!-- PLAN:START -->', '<!-- PLAN:END -->'],
  review: ['<!-- REVIEW:START -->', '<!-- REVIEW:END -->'],
  meta: ['<!-- META:START -->', '<!-- META:END -->'],
  legacy: ['<!-- LEGACY:START -->', '<!-- LEGACY:END -->'],
};

const pad2 = (n) => String(n).padStart(2, '0');

function dateKey(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function clock(d = new Date()) {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function parseKey(key) {
  const m = String(key).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw new Error(`日期格式须为 YYYY-MM-DD：${key}`);
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function weekday(key) {
  return WEEK[parseKey(key).getDay()];
}

function fileOf(key) {
  return path.join(DIR, `${key}.md`);
}

// ---------------- 骨架与区块 ----------------

function skeleton(key) {
  const wd = weekday(key);
  return `# ${key} ${wd} · 盯盘日志

<!-- META:START -->
| 项目 | 值 |
|---|---|
| 交易日 | ${key} ${wd} |
| 账户 | 待同步（\`node cli.js journal sync\`） |
| 时段 | -- |
| 累计盈亏 | -- |
| 最后更新 | -- |
<!-- META:END -->

## 时间线

> 由 \`node cli.js note\` 追加，按发生顺序排列，**只增不改**。每条带时间与标签。

<!-- TL:START -->
<!-- TL:END -->

## 今日计划

> 由 \`node cli.js journal plan\` 覆盖写入。盘前 09:05 一次，盘中允许修正后重写。

<!-- PLAN:START -->
（待写入）
<!-- PLAN:END -->

## 收盘复盘

> 由 \`node cli.js journal review\` 覆盖写入，15:15 一次。

<!-- REVIEW:START -->
（待写入）
<!-- REVIEW:END -->
`;
}

/** 取某个锚点区间内的内容（不含锚点行） */
function sectionOf(text, kind) {
  const [s, e] = A[kind];
  const i = text.indexOf(s);
  const j = text.indexOf(e);
  if (i < 0 || j < 0 || j < i) return null;
  return text.slice(i + s.length, j).replace(/^\n+/, '').replace(/\n+$/, '');
}

/** 替换某个锚点区间的内容 */
function replaceSection(text, kind, body) {
  const [s, e] = A[kind];
  const i = text.indexOf(s);
  const j = text.indexOf(e);
  const inner = `\n${String(body).replace(/\n+$/, '')}\n`;
  if (i < 0 || j < 0 || j < i) return `${text.replace(/\n+$/, '')}\n\n${s}${inner}${e}\n`;
  return text.slice(0, i + s.length) + inner + text.slice(j);
}

// ---------------- 旧格式迁移 ----------------

/**
 * 旧格式（无锚点）→ 新结构。
 * 规则：`- **HH:MM** 内容` 行进时间线；按 `## ` 切块，标题含「计划」进 PLAN、
 * 含「复盘」进 REVIEW、其余进 LEGACY（原文完整保留，不做删改）。
 */
function migrateLegacy(raw, key) {
  const lines = raw.split(/\r?\n/);
  const tl = [];
  const rest = [];
  let fence = false;

  for (const ln of lines) {
    if (/^\s*```/.test(ln)) fence = !fence;
    const m = !fence && ln.match(/^\s*[-*]\s+\*\*(\d{2}:\d{2})\*\*\s*(.+)$/);
    if (m) {
      tl.push({ at: m[1], line: `- \`${m[1]}\` **[记录]** ${m[2].trim()}` });
    } else if (/^#\s/.test(ln) && tl.length === 0 && rest.every((x) => !x.trim())) {
      continue; // 丢掉旧标题
    } else {
      rest.push(ln);
    }
  }

  // 按二级标题切块
  const blocks = [];
  let cur = { title: '', body: [] };
  for (const ln of rest) {
    if (/^##\s/.test(ln)) {
      if (cur.title || cur.body.some((x) => x.trim())) blocks.push(cur);
      cur = { title: ln.replace(/^##\s*/, '').trim(), body: [] };
    } else cur.body.push(ln);
  }
  if (cur.title || cur.body.some((x) => x.trim())) blocks.push(cur);

  const plan = [];
  const review = [];
  const legacy = [];
  for (const b of blocks) {
    const body = b.body.join('\n').replace(/^\n+/, '').replace(/\n+$/, '');
    if (!b.title && !body.trim()) continue;
    const head = b.title ? `### ${b.title}\n\n` : '';
    if (/计划/.test(b.title)) plan.push(head + body);
    else if (/复盘/.test(b.title)) review.push(head + body);
    else legacy.push(head + body);
  }

  const text = skeleton(key);
  return finalize(key, text, {
    tl: tl.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)).map((x) => x.line).join('\n'),
    plan: plan.length ? plan.join('\n\n') : null,
    review: review.length ? review.join('\n\n') : null,
    legacy: legacy.length ? legacy.join('\n\n') : null,
  });
}

function finalize(key, text, parts = {}) {
  let out = text;
  if (parts.tl != null) out = replaceSection(out, 'tl', parts.tl || '（暂无）');
  if (parts.plan != null) out = replaceSection(out, 'plan', parts.plan || '（待写入）');
  if (parts.review != null) out = replaceSection(out, 'review', parts.review || '（待写入）');
  if (parts.legacy) {
    out = out.replace(/\n+$/, '') + `\n\n## 历史正文（迁移自旧格式）\n\n${A.legacy[0]}\n${parts.legacy}\n${A.legacy[1]}\n`;
  }
  return out;
}

// ---------------- 读写 ----------------

/** 确保当日文件存在且为规范结构；返回 { key, file, text, migrated } */
function ensureJournal(key = dateKey()) {
  fs.mkdirSync(DIR, { recursive: true });
  const file = fileOf(key);
  if (!fs.existsSync(file)) {
    const text = skeleton(key);
    fs.writeFileSync(file, text, 'utf8');
    return { key, file, text, migrated: false, created: true };
  }
  const raw = fs.readFileSync(file, 'utf8');
  if (raw.includes(A.tl[0])) return { key, file, text: raw, migrated: false, created: false };
  const text = migrateLegacy(raw, key);
  fs.writeFileSync(file, text, 'utf8');
  return { key, file, text, migrated: true, created: false };
}

function readJournal(key = dateKey()) {
  const file = fileOf(key);
  if (!fs.existsSync(file)) return null;
  return { key, file, text: fs.readFileSync(file, 'utf8') };
}

/**
 * 规整长文本：只去首尾空行与行尾空白，保留内部空行和缩进。
 * 计划/复盘里有表格和分段，删空行会让结构塌掉。
 */
function normalizeBody(text) {
  return String(text)
    .replace(/\r/g, '')
    .split('\n')
    .map((s) => s.replace(/\s+$/, ''))
    .join('\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '');
}

/** 把时间线拆成条目块：一行 `- \`HH:MM\`` 开头，缩进行归入上一条 */
function splitBlocks(tl) {
  const blocks = [];
  for (const ln of tl.split('\n')) {
    if (/^-\s+`\d{2}:\d{2}`/.test(ln)) blocks.push(ln);
    else if (blocks.length) blocks[blocks.length - 1] += `\n${ln}`;
    else if (ln.trim() && ln.trim() !== '（暂无）') blocks.push(ln);
  }
  return blocks;
}

/** 按时间顺序插入：即使任务乱序执行，时间线也不会颠倒 */
function insertByTime(current, entry, at) {
  const blocks = splitBlocks(current || '');
  if (!blocks.length) return entry;
  const idx = blocks.findIndex((b) => {
    const m = b.match(/^-\s+`(\d{2}:\d{2})`/);
    return m && m[1] > at;
  });
  if (idx < 0) return `${blocks.join('\n')}\n${entry}`;
  blocks.splice(idx, 0, entry);
  return blocks.join('\n');
}

/**
 * 追加一条时间线条目（按时间插入，非盲追加）。
 * @param {object} o { text, tag, at, key }
 */
function appendTimeline({ text, tag = '记录', at, key = dateKey() } = {}) {
  if (!text || !String(text).trim()) throw new Error('日志内容为空');
  const t = TAGS.includes(tag) ? tag : '记录';
  const hhmm = at || clock();
  const j = ensureJournal(key);
  const body = normalizeBody(text);
  const lines = body
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!lines.length) throw new Error('日志内容为空');
  const entry = [`- \`${hhmm}\` **[${t}]** ${lines[0]}`]
    .concat(lines.slice(1).map((s) => `  ${s}`))
    .join('\n');

  const cur = sectionOf(j.text, 'tl');
  const empty = !cur || !cur.trim() || cur.trim() === '（暂无）';
  const next = empty ? entry : insertByTime(cur, entry, hhmm);
  let out = replaceSection(j.text, 'tl', next);
  out = touchMeta(out, clock());
  fs.writeFileSync(j.file, out, 'utf8');
  return { file: j.file, migrated: j.migrated, created: j.created };
}

/**
 * 覆盖或追加写入 PLAN / REVIEW 区。section ∈ 'plan' | 'review'
 * opts.append=true 时接到现有内容后面（盘中修正、尾盘补明日预案用）。
 */
function setSection(section, content, key = dateKey(), opts = {}) {
  if (!['plan', 'review'].includes(section)) {
    throw new Error(`未知区块：${section}（只支持 plan / review）`);
  }
  const body = normalizeBody(content);
  if (!body) throw new Error('内容为空');
  const j = ensureJournal(key);
  let next = body;
  if (opts.append) {
    const cur = sectionOf(j.text, section);
    const blank = !cur || !cur.trim() || cur.trim() === '（待写入）';
    if (!blank) next = `${cur.trim()}\n\n---\n\n${body}`;
  }
  const out = touchMeta(replaceSection(j.text, section, next), clock());
  fs.writeFileSync(j.file, out, 'utf8');
  return { file: j.file, migrated: j.migrated };
}

function touchMeta(text, hhmm) {
  const cur = sectionOf(text, 'meta');
  if (!cur) return text;
  if (!/\|\s*最后更新\s*\|/.test(cur)) return text;
  const next = cur.replace(/\|\s*最后更新\s*\|\s*[^|]*\|/, `| 最后更新 | ${hhmm} |`);
  return replaceSection(text, 'meta', next);
}

/**
 * 写入账户快照。stats 里为 null 的字段保持原值。
 * stats: { capital, cash, marketValue, positions, pnlPct, session }
 */
function syncMeta(stats = {}, key = dateKey()) {
  const j = ensureJournal(key);
  const cur = sectionOf(j.text, 'meta') || '';
  const rows = cur.split('\n').filter((l) => /^\|/.test(l));
  const get = (k, d = '--') => {
    const row = rows.find((r) => new RegExp(`\\|\\s*${k}\\s*\\|`).test(r));
    if (!row) return d;
    const v = row.split('|')[2];
    return v == null ? d : v.trim();
  };
  const money = (n) => Number(n).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const capital = stats.capital != null ? `¥${money(stats.capital)}` : get('本金');
  const cash = stats.cash != null ? `¥${money(stats.cash)}` : get('现金');
  const pos = stats.positions != null ? `${stats.positions} 只` : get('持仓');
  const pnl =
    stats.pnlPct != null
      ? `${stats.pnlPct > 0 ? '+' : ''}${Number(stats.pnlPct).toFixed(2)}%`
      : get('累计盈亏');
  const session = stats.session || get('时段');

  const table = [
    '| 项目 | 值 |',
    '|---|---|',
    `| 交易日 | ${get('交易日', `${key} ${weekday(key)}`)} |`,
    `| 本金 | ${capital} |`,
    `| 现金 | ${cash} |`,
    `| 持仓 | ${pos} |`,
    `| 时段 | ${session} |`,
    `| 累计盈亏 | ${pnl} |`,
    `| 最后更新 | ${clock()} |`,
  ].join('\n');

  fs.writeFileSync(j.file, replaceSection(j.text, 'meta', table), 'utf8');
  return { file: j.file, migrated: j.migrated };
}

// ---------------- 索引与归档 ----------------

function listKeys({ includeArchived = false } = {}) {
  fs.mkdirSync(DIR, { recursive: true });
  const out = [];
  const scan = (dir, tag) => {
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.md')) continue;
      const name = f.replace(/\.md$/, '');
      if (RESERVED.includes(name)) continue;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(name)) continue;
      out.push({ key: name, archived: tag });
    }
  };
  scan(DIR, false);
  if (includeArchived) scan(ARCHIVE, true);
  return out.sort((a, b) => (a.key < b.key ? 1 : -1));
}

function summarize(text, max = 56) {
  const pick = (s) => {
    if (!s) return '';
    const line = s
      .split('\n')
      .map((x) => x.trim())
      // 跳过标题、引用块、括号说明、模板占位 —— 这些不含实质结论
      .filter((x) => x && !/^[#>]/.test(x) && !x.startsWith('（') && !x.startsWith('由 '))
      .map((x) => x.replace(/^[-*]\s+/, '').trim())
      .find(Boolean);
    return line || '';
  };
  const s = pick(sectionOf(text, 'plan')) || pick(sectionOf(text, 'review'));
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function countEntries(text) {
  const tl = sectionOf(text, 'tl');
  if (!tl) return 0;
  return tl.split('\n').filter((l) => /^-\s+`\d{2}:\d{2}`/.test(l)).length;
}

/** 重建 INDEX.md */
function renderIndex() {
  const items = listKeys({ includeArchived: true });
  const rows = items.map((it) => {
    const file = it.archived ? path.join(ARCHIVE, `${it.key}.md`) : fileOf(it.key);
    const text = fs.readFileSync(file, 'utf8');
    const n = countEntries(text);
    const plan = /（待写入）/.test(sectionOf(text, 'plan') || '（待写入）') ? '—' : '✓';
    const review = /（待写入）/.test(sectionOf(text, 'review') || '（待写入）') ? '—' : '✓';
    const sum = summarize(text).replace(/\|/g, '\\|');
    return `| ${it.archived ? '📦 ' : ''}${it.key} | ${weekday(it.key)} | ${n} | ${plan} | ${review} | ${sum || '—'} |`;
  });

  const body = `# 盯盘日志索引

> 本文件由 \`node cli.js journal index\` 自动生成，**不要手工编辑**。
> 按日期倒序。新会话先读本表定位，再打开对应日期的日志。

| 日期 | 星期 | 条目 | 计划 | 复盘 | 摘要 |
|---|---|---|---|---|---|
${rows.join('\n') || '| — | — | 0 | — | — | 暂无日志 |'}

- 总篇数：${items.length}
- 生成时间：${new Date().toLocaleString('zh-CN', { hour12: false })}
`;
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(path.join(DIR, 'INDEX.md'), body, 'utf8');
  return { count: items.length, file: path.join(DIR, 'INDEX.md') };
}

/** 把早于 keepDays 天的日志移入 archive/ */
function archiveOld(keepDays = 90, now = new Date()) {
  fs.mkdirSync(ARCHIVE, { recursive: true });
  const cutoff = new Date(now.getTime() - keepDays * 86400000);
  const moved = [];
  for (const it of listKeys()) {
    if (it.archived) continue;
    if (parseKey(it.key) < cutoff) {
      fs.renameSync(fileOf(it.key), path.join(ARCHIVE, `${it.key}.md`));
      moved.push(it.key);
    }
  }
  return moved;
}

/** 供 agent 快速获取最近 N 天的上下文（返回结构化摘要） */
function brief(days = 3) {
  const items = listKeys().slice(0, days);
  return items.map((it) => {
    const text = fs.readFileSync(fileOf(it.key), 'utf8');
    return {
      key: it.key,
      weekday: weekday(it.key),
      entries: countEntries(text),
      plan: sectionOf(text, 'plan') || '',
      review: sectionOf(text, 'review') || '',
      timeline: sectionOf(text, 'tl') || '',
      raw: text,
    };
  });
}

module.exports = {
  DIR,
  ARCHIVE,
  TAGS,
  dateKey,
  clock,
  weekday,
  fileOf,
  sectionOf,
  ensureJournal,
  readJournal,
  appendTimeline,
  setSection,
  syncMeta,
  listKeys,
  renderIndex,
  archiveOld,
  brief,
  skeleton,
  migrateLegacy,
};
