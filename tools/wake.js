#!/usr/bin/env node
/**
 * 系统任务唤醒入口 —— 由 Windows 任务计划程序调用，不经 WorkBuddy 的调度器。
 *
 * 设计原则：
 * 1) **不依赖 LLM 也要把事做完**。agent 未登录时降级为确定性路径（取数、写参数、告警、风控判定），
 *    绝不因为「模型没响应」就不干活。
 * 2) 一次唤醒只做一件事，做完即退。时段不对就一行日志退出，不写业务日志（避免节假日污染）。
 * 3) 所有下单仍走 cli.js（风控闸门在那里），本文件不直连 /api/order。
 *
 * 用法：
 *   node tools/wake.js plan        08:45 盘前计划（写参数卡 + 观察池同步）
 *   node tools/wake.js open        09:45 开盘执行
 *   node tools/wake.js midday      11:25 午间检视（只卖不买）
 *   node tools/wake.js tail        14:40 尾盘调仓
 *   node tools/wake.js close       15:15 收盘归档
 *   node tools/wake.js live-on     09:20 启动常驻盯盘
 *   node tools/wake.js live-off    15:05 停掉常驻盯盘
 *
 * 附加参数：
 *   --agent      尝试用 CLI 跑提示词（需要先 codebuddy /login）；失败自动降级
 *   --auto       允许自动卖出（止损/止盈），默认只告警
 *   --force      忽略时段限制（调试）
 */
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const LIVE_DIR = path.join(DATA, 'live');
const PORT = Number(process.env.PORT || 5193);
const BASE = `http://127.0.0.1:${PORT}`;
const CLI_BIN =
  process.env.CODEBUDDY_BIN ||
  'D:/program/workBuddy/resources/app.asar.unpacked/cli/dist/codebuddy-lite-wb.mjs';

const argv = process.argv.slice(2);
const task = argv[0] || '';
const has = (f) => argv.includes(`--${f}`);
const AGENT = has('agent');
const AUTO = has('auto');
const FORCE = has('force');

// 需要「判断」而不只是「执行」的任务段。这三段跑完只是把事实摆齐，
// 真正的判断由客户端 agent 做（无头 CLI 不参与日常调度）。
const JUDGE_TASKS = ['plan', 'open', 'tail'];

const TASKS = {
  plan: { needTradable: false, label: '盘前计划', at: '08:45' },
  open: { needTradable: true, label: '开盘执行', at: '09:45' },
  midday: { needTradable: true, label: '午间检视', at: '11:25' },
  tail: { needTradable: true, label: '尾盘调仓', at: '14:40' },
  close: { needTradable: false, label: '收盘归档', at: '15:15' },
  'live-on': { needTradable: false, label: '启动盯盘', at: '09:20' },
  'live-off': { needTradable: false, label: '停止盯盘', at: '15:05' },
};

const stamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};
const dayKey = () => stamp().slice(0, 10);

function logLine(text) {
  fs.mkdirSync(LIVE_DIR, { recursive: true });
  fs.appendFileSync(path.join(LIVE_DIR, `wake-${dayKey()}.log`), `[${stamp()}] ${text}\n`, 'utf8');
  console.log(`[${stamp()}] ${text}`);
}

function cli(args, opts = {}) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'cli.js'), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: opts.timeout || 60000,
    env: { ...process.env, NO_OPEN: '1', NO_COLOR: '1' },
  });
  return { ok: r.status === 0, out: `${r.stdout || ''}${r.stderr || ''}`.trim() };
}

async function api(p) {
  const r = await fetch(BASE + p, { signal: AbortSignal.timeout(10000) });
  const j = await r.json();
  if (!j.ok) throw new Error(j.msg || '接口失败');
  return j.data;
}

async function ensureServer() {
  try {
    await api('/api/health');
    return true;
  } catch (e) {
    logLine('服务未响应，拉起 server.js');
    const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      cwd: ROOT,
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, NO_OPEN: '1', NO_COLOR: '1' },
    });
    child.unref();
    for (let i = 0; i < 30; i += 1) {
      await new Promise((r) => setTimeout(r, 400));
      try {
        await api('/api/health');
        return true;
      } catch (e2) {
        /* 继续等 */
      }
    }
    return false;
  }
}

/** westock 技术指标 → 参数卡文本。取不到就返回 null，绝不编数字。 */
function indicators(codes) {
  const exe = process.env.WESTOCK || path.join(process.env.USERPROFILE || '', '.local', 'bin', 'westock.exe');
  if (!fs.existsSync(exe) || !codes.length) return null;
  const args = codes.map((c) => (/^[569]/.test(c) ? `sh${c}` : `sz${c}`)).join(',');
  const r = spawnSync(exe, ['technical', args, '--date', dayKey()], { encoding: 'utf8', timeout: 30000 });
  const rows = String(r.stdout || '')
    .split('\n')
    .filter((l) => /^\|\s*\d{4}-\d{2}-\d{2}\s*\|/.test(l));
  if (!rows.length) return null;
  const head = String(r.stdout)
    .split('\n')
    .find((l) => l.startsWith('| date |'));
  const cols = head ? head.split('|').map((s) => s.trim()).filter(Boolean) : [];
  const out = [];
  for (const row of rows) {
    const cells = row.split('|').map((s) => s.trim());
    cells.shift();
    const o = {};
    cols.forEach((c, i) => (o[c] = cells[i]));
    out.push(o);
  }
  const pick = (o, k) => (o[k] && o[k] !== '-' ? o[k] : '—');
  return out
    .map(
      (o) =>
        `| ${String(o.code).replace(/^(sh|sz)/, '')} ${o.name} | ${pick(o, 'closePrice')} | ${pick(o, 'MA_5')} | ${pick(o, 'MA_10')} | ${pick(o, 'MA_20')} | ` +
        `${pick(o, 'BOLL_LOWER')} / ${pick(o, 'BOLL_MID')} / ${pick(o, 'BOLL_UPPER')} | ${pick(o, 'MACD')} | ${pick(o, 'RSI_6')} |`
    )
    .join('\n');
}

function runAgent(promptFile, timeoutMs = 240000) {
  if (!fs.existsSync(promptFile)) return { ok: false, out: `提示词文件不存在：${promptFile}` };
  if (!fs.existsSync(CLI_BIN)) return { ok: false, out: `CLI 入口不存在：${CLI_BIN}` };
  const port = 58000 + Math.floor(Math.random() * 900);
  const r = spawnSync(
    process.execPath,
    [CLI_BIN, '-p', fs.readFileSync(promptFile, 'utf8'), '-y', '--port', String(port), '--output-format', 'text'],
    { cwd: ROOT, encoding: 'utf8', timeout: timeoutMs, env: { ...process.env, NO_OPEN: '1' } }
  );
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
  if (/Authentication required/i.test(out)) return { ok: false, out: 'CLI 未登录（需先 codebuddy → /login）', noAuth: true };
  return { ok: r.status === 0, out: out.slice(-1500) };
}

// ---------------- 各任务 ----------------

function tPlan() {
  const steps = [];
  const r1 = cli(['alert', 'poll', '--check']);
  steps.push(`alert poll: ${r1.out.split('\n')[0]}`);

  const dash = cli(['status']);
  steps.push(`status: ${dash.out.split('\n')[0]}`);

  const risk = cli(['risk']);
  steps.push(`risk: ${risk.out.split('\n')[0]}`);
  const quotaLine = (dash.out.match(/风控余量.*$/m) || ['(未取到风控余量)'])[0].trim();

  // 移动止盈每天修正一次：T+1 昨天买的那批今天解禁，这里才建得出单。
  // 收盘后 15:15 已按昨日收盘价算过一轮，这里是「补建 + 复核」，幂等，不会重复建单。
  const take = cli(['take', 'sync'], { timeout: 90000 });
  const takeTail = take.out.trim().split('\n').filter(Boolean).pop() || '(无输出)';
  steps.push(`take: ${takeTail}`);
  // sync 之后再取一次 plan：此时条件单价已是最新，参数卡里贴的就是今天实际生效的线
  const takePlan = cli(['take', 'plan'], { timeout: 90000 });

  const prune = cli(['watch', 'prune']);
  steps.push(`prune: ${prune.out.split('\n')[0]}`);

  const wl = cli(['watch', 'list']);
  const wlCodes = [...wl.out.matchAll(/^(\d{6})\s/gm)].map((m) => m[1]);
  // 持仓标的必须有指标：它们是唯一会产生实际盈亏的东西。
  // 已建仓的票会被 prune 移出观察池，只按池子取数会把唯一持仓漏掉。
  const holdSeg = (dash.out.split(/持仓\s+\d+\/\d+/)[1] || '').split(/挂单/)[0];
  const posCodes = [...holdSeg.matchAll(/^\s*(\d{6})\s/mg)].map((m) => m[1]);
  const codes = [...new Set([...posCodes, ...wlCodes])];
  const ind = indicators(codes.length ? codes : []);

  // 池外候选：机械扫描，只过硬闸门，不做推荐。
  // 三个视角并列摆出来，入池与否归客户端（08:50 那条自动化）判断。
  const SO = { timeout: 90000 };
  const scanAmt = cli(['scan', '--limit', '10', '--fresh'], SO);
  const scanVal = cli(['scan', '--view', 'value', '--limit', '8', '--fresh'], SO);
  const scanEtf = cli(['scan', '--view', 'etf', '--kw', '红利|低波|股息', '--limit', '8', '--fresh'], SO);
  steps.push(`scan: 成交额/估值/红利ETF 三视角`);

  const planBody = [
    `### 盘前参数卡（${stamp()} 自动生成）`,
    '',
    '> 本节由系统任务 `wake.js plan` 生成：只放**实测参数与硬规则**，不含主观判断。',
    '> 逐条判据、情景归属、下单决策仍需在 08:45~09:45 之间由人或 agent 补写。',
    '',
    '**技术指标（本轮现取，禁止沿用旧值；含持仓与观察池）**',
    '',
    '| 标的 | 收盘 | MA5 | MA10 | MA20 | BOLL 下/中/上 | MACD | RSI6 |',
    '|---|---|---|---|---|---|---|---|',
    ind || '（指标取数失败：westock 不可用或观察池为空，切勿手填数字）',
    '',
    '**风控额度（cli status 实测，随权益浮动，禁止写死）**',
    '',
    '```',
    quotaLine,
    risk.out.trim(),
    '```',
    '',
    '**移动止盈（条件单自动维护，只上移不下调）**',
    '',
    '> 判据：持仓期最高价 ×(1-回撤容忍)，回撤容忍 = 1.8×ATR 夹在 2.5%~8%。',
    '> 准入：回撤后的止盈价必须仍在「成本+2%」之上才挂。**这是执行线**，',
    '> 上面风控里的「止盈 +15%」只是参考目标，不是挂单价格。',
    '',
    '```',
    takePlan.out.trim(),
    '```',
    '',
    '**情景闸门（四档，09:45 用实时数据重判）**',
    '',
    '| 情景 | 判据 | 动作 |',
    '|---|---|---|',
    '| 零 强势放量 | 上涨占比 >65% 且 成交额较上日放大 | 买满一档，只买回踩位，不追涨幅 >5% |',
    '| 一 继续杀跌 | 创业板跌 >2% 或 上证破 3600 | 只买最小一档 |',
    '| 二 低开震荡 | 指数跌幅 <1% | 按计划档买满 |',
    '| 三 反弹修复 | 科创50 站回 MA20 且 涨停 >45 | 只建一档，可用替代 |',
    '| 均不成立 | — | 不下单，记录实测值 |',
    '',
    '**判据时点**：一律用「本次任务运行时刻」，禁止写运行之前的时点。',
    '',
    `### 池外候选（${stamp()} 机械扫描，未入池）`,
    '',
    '> 只过硬闸门（板块权限 / 价格 / 涨跌幅 / 成交额 / 能否凑出合规整手），**不含任何推荐**。',
    '> 三张表是三种看法：成交额榜看资金在哪、估值榜看便宜的、ETF 看同类可替代的。',
    '> 评估后值得跟踪的再入池：`node cli.js watch add <代码> --note "价位 + 信号" --source plan --ttl 5`。',
    '> 「可买 ✗」= 凑不出「≥ 单笔下限 且 ≤ 单票上限」的整手，结构性建不了仓，跳过。',
    '',
    '**① 成交额榜**（市场在炒什么）',
    '',
    '```',
    scanAmt.out.trim(),
    '```',
    '',
    '**② 低估值榜**（活跃股里 PE 最便宜的一批，防守型策略的主要来源）',
    '',
    '```',
    scanVal.out.trim(),
    '```',
    '',
    '**③ 红利 / 低波 ETF**（与现有持仓同风格的可替代标的）',
    '',
    '```',
    scanEtf.out.trim(),
    '```',
  ].join('\n');

  const write = cli(['journal', 'plan', planBody]);
  steps.push(`plan: ${write.out.split('\n')[0]}`);

  cli(['note', '--tag', '计划', `盘前参数卡已生成（持仓+观察池 ${codes.length} 只，指标${ind ? '现取成功' : '取数失败'}），主观判断待客户端 agent 补写`]);
  return steps;
}

function tOpen() {
  const steps = [];
  const liveFix = ensureLive('09:45');
  if (liveFix) steps.push(liveFix);
  steps.push(`alert: ${cli(['alert', 'poll', '--check']).out.split('\n')[0]}`);
  steps.push(`risk: ${cli(['risk']).out.split('\n')[0]}`);

  // 只认 -7% 硬止损；止盈（减半）留给人工——急涨中自动卖容易卖飞。
  const sweep = stopSweep('09:45');
  if (sweep) steps.push(sweep);

  const dash = cli(['status']);
  cli([
    'note',
    '--tag',
    '记录',
    `[系统任务] 09:45 开盘窗口：${steps.join('；')}${sweep ? '' : '；无止损信号'}；${dash.out.split('\n')[0]}`,
  ]);
  return steps;
}

function tMidday() {
  const steps = [];
  const liveFix = ensureLive('11:25');
  if (liveFix) steps.push(liveFix);
  steps.push(`alert: ${cli(['alert', 'poll', '--check']).out.split('\n')[0]}`);
  const risk = cli(['risk']);
  steps.push(`risk: ${risk.out.split('\n')[0]}`);
  const sweep = stopSweep('11:25');
  if (sweep) steps.push(sweep);
  cli(['note', '--tag', '记录', `[系统任务] 11:25 午间检视：${risk.out.split('\n')[0]}${sweep ? `；${sweep}` : '；无止损信号'}（只卖不买）`]);
  return steps;
}

function tTail() {
  const steps = [];
  const liveFix = ensureLive('14:40');
  if (liveFix) steps.push(liveFix);
  steps.push(`alert: ${cli(['alert', 'poll', '--check']).out.split('\n')[0]}`);
  steps.push(`risk: ${cli(['risk']).out.split('\n')[0]}`);
  steps.push(`orders: ${cli(['orders']).out.split('\n')[0]}`);
  const sweep = stopSweep('14:40');
  if (sweep) steps.push(sweep);
  const dash = cli(['status']);
  cli([
    'note',
    '--tag',
    '记录',
    `[系统任务] 14:40 尾盘窗口：${dash.out.split('\n')[0]}；持仓与挂单已检视${sweep ? `；${sweep}` : ''}`,
  ]);
  return steps;
}

function tClose() {
  const steps = [];
  steps.push(`sync: ${cli(['journal', 'sync']).out.split('\n')[0]}`);
  steps.push(`prune: ${cli(['watch', 'prune']).out.split('\n')[0]}`);
  // 收盘价已定，按今日口径重算移动止盈线：明早开盘前那张单就已经是新的。
  // 15:15 跑完若持仓为当日买入（T+1），脚本会留成「等解禁」，次日 08:45 首轮补建。
  const take = cli(['take', 'sync'], { timeout: 90000 });
  const takeTail = take.out.trim().split('\n').filter(Boolean).pop() || '(无输出)';
  steps.push(`take: ${takeTail}`);
  steps.push(`index: ${cli(['journal', 'index']).out.split('\n')[0]}`);
  steps.push(`alert: ${cli(['alert', 'poll']).out.split('\n')[0]}`);
  cli(['note', '--tag', '运维', `[系统任务] 15:15 收盘归档：账户快照已同步、观察池已清理、索引已重建；移动止盈 ${takeTail}`]);
  return steps;
}

/**
 * 盯盘进程存活自检：不在就拉起来。
 * 盯盘进程是止损止盈的唯一执行者——条件单还有 cond check 兜底，风控信号没有。
 * 它中途崩了（被系统回收 / 休眠唤醒失败 / 自己异常退出），09:45 之后的三个窗口
 * 原本都发现不了，一直到收盘才从「今天怎么没信号」里看出来。
 *
 * @returns {string|null} 需要说明时返回一行文字，正常存活返回 null（不占日志）
 */
function ensureLive(tag) {
  const status = cli(['live', 'status']);
  const alive = /运行中|PID/.test(status.out) && !/未启动/.test(status.out);
  if (alive) return null;
  const child = spawn(process.execPath, [path.join(ROOT, 'tools', 'live.js'), ...(AUTO ? ['--auto'] : [])], {
    cwd: ROOT,
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, NO_OPEN: '1', NO_COLOR: '1' },
  });
  child.unref();
  logLine(`[${tag}] 盯盘未在运行，已重新拉起 PID ${child.pid}${AUTO ? '（止损自动）' : '（仅告警）'}`);
  return `live 重启 PID ${child.pid}`;
}

/**
 * 止损兜底扫描。
 *
 * 盯盘进程是止损的唯一实时执行者（20s 一轮）。它若静默崩掉，止损这条线就断了——
 * 三个可委托窗口各扫一次补位。只认 -7% 硬止损，止盈与结构信号一律留给人工。
 *
 * 为什么改用 risk --json 而不是解析文本：risk 每行都固定含「止损线」三个字，
 * 早先按 /止损/ 计数，只要有持仓就 >=1，把「有持仓」误报成「有信号」；
 * 而提取数量的正则要求「止损」之后紧跟 6 位数字，实际永远匹配不到。
 * 结果是既写假警、又从不真的下单——兜底是假的。
 */
function stopSweep(tag) {
  const raw = cli(['risk', '--json']);
  let d;
  try {
    // 冷启动时 cli.js 会先打「服务未响应，自动启动…」，不能直接 JSON.parse 整段
    const s = raw.out.indexOf('{');
    const e = raw.out.lastIndexOf('}');
    if (s < 0 || e <= s) throw new Error('无 JSON 段');
    d = JSON.parse(raw.out.slice(s, e + 1));
  } catch (err) {
    return `止损兜底(${tag})：risk 输出无法解析（${err.message}），跳过`;
  }
  const hits = d.stopSells || [];
  if (!hits.length) return null;

  const acts = [];
  for (const s of hits) {
    if (!(s.sellable > 0)) {
      acts.push(`${s.code} 触发止损(${s.pnlPct}%)但可卖 0 股（T+1），未下单`);
      continue;
    }
    if (!AUTO) {
      acts.push(`${s.code} 触发止损 ${s.sellable} 股，未开 --auto 仅记日志`);
      cli(['note', '--tag', '风控', `[系统任务·${tag}] ${s.code} 触发止损（${s.pnlPct}%），未开 --auto，需人工处置`]);
      continue;
    }
    const r = cli(['sell', s.code, String(s.sellable)]);
    acts.push(`${s.code} 止损卖出 ${s.sellable} 股：${r.ok ? '成交' : '失败'}`);
    cli([
      'note',
      '--tag',
      '风控',
      `[系统任务·${tag}] 止损兜底：${s.code} 触发 -7% 红线（${s.pnlPct}%），` +
        (r.ok ? `已卖出 ${s.sellable} 股（成交价约 ${s.price}）` : `下单失败：${r.out.replace(/\n+/g, ' ').slice(0, 80)}`),
    ]);
  }
  return `止损兜底(${tag})：${acts.join('；')}`;
}

function tLiveOn() {
  const status = cli(['live', 'status']);
  if (/运行中|PID/.test(status.out) && !/未启动/.test(status.out)) return [`已在运行：${status.out.split('\n')[0]}`];
  const child = spawn(process.execPath, [path.join(ROOT, 'tools', 'live.js'), ...(AUTO ? ['--auto'] : [])], {
    cwd: ROOT,
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, NO_OPEN: '1', NO_COLOR: '1' },
  });
  child.unref();
  logLine(`盯盘进程已拉起（PID ${child.pid}${AUTO ? '，止损自动执行' : '，仅告警'}）`);
  return [`live 已拉起 PID ${child.pid}${AUTO ? ' --auto' : ''}`];
}

function tLiveOff() {
  const pidFile = path.join(LIVE_DIR, 'live.pid');
  if (!fs.existsSync(pidFile)) return ['没有在跑的盯盘进程'];
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  try {
    process.kill(pid, 'SIGTERM');
    logLine(`已停止盯盘进程 PID ${pid}`);
    return [`已停止 PID ${pid}`];
  } catch (e) {
    return [`停止失败（可能已退出）：${e.message}`];
  }
}

// ---------------- 主流程 ----------------
(async () => {
  const def = TASKS[task];
  if (!def) {
    console.error(`未知任务：${task || '(空)'}\n可用：${Object.keys(TASKS).join(' / ')}`);
    process.exit(2);
  }

  fs.mkdirSync(LIVE_DIR, { recursive: true });
  const lock = path.join(LIVE_DIR, `wake-${task}.lock`);
  if (fs.existsSync(lock)) {
    const age = Date.now() - fs.statSync(lock).mtimeMs;
    if (age < 5 * 60 * 1000) {
      logLine(`${task} 上一轮还在跑（${Math.round(age / 1000)}s），跳过`);
      process.exit(0);
    }
  }
  fs.writeFileSync(lock, String(process.pid), 'utf8');

  try {
    const up = await ensureServer();
    if (!up) {
      logLine(`${task} 服务起不来，放弃本轮`);
      process.exit(1);
    }
    const h = await api('/api/health');
    const sess = h.session || {};
    logLine(`${task}（${def.label}）启动：时段 ${sess.label}（${sess.code}）`);

    if (sess.code === 'holiday') {
      logLine(`休市日，${task} 直接结束（不写业务日志）`);
      return;
    }
    if (def.needTradable && !sess.accept && !FORCE) {
      logLine(`当前不可委托（${sess.label}），${task} 结束，不写业务日志`);
      return;
    }

    // agent 优先，失败降级为确定性路径
    let agentNote = '';
    if (AGENT) {
      const pf = path.join(ROOT, 'tools', 'prompts', `${task}.md`);
      const r = runAgent(pf);
      agentNote = r.ok ? `agent 完成（${r.out.slice(0, 120)}）` : `agent 跳过：${r.out.slice(0, 120)}`;
      logLine(agentNote);
      if (r.ok) return;
    }

    const steps = (() => {
      // 条件单兜底：可委托时段的唤醒先补一次判定，盯盘进程没起来也不至于漏单。
      // 判定、执行、状态机都在 cli.js cond check，这里只负责叫它并留痕。
      if (def.needTradable) {
        const c = cli(['cond', 'check']);
        if (c.out && c.out !== 'IDLE' && !c.out.startsWith('HOLIDAY')) {
          logLine(`条件单：${c.out.replace(/\n+/g, ' ｜ ')}`);
        }
      }
      // 计划审计：计划里写了买点、却没有对应条件单 = 到价也接不到。
      // 2026-11-11 长电收 29.48 已跌破计划买点 29.90，当日额度全额空闲，却因为没有对应条件单而漏单。
      // 只在 open / tail 跑：08:45 时 agent 还没挂单，那个时点审必然报缺口，纯噪声。
      if (task === 'open' || task === 'tail') {
        const a = cli(['plan', 'audit']);
        const gapLine = (a.out || '')
          .split('\n')
          .filter((l) => /✗|⚠/.test(l))
          .map((l) => l.trim().replace(/\s+/g, ' '))
          .join(' ｜ ');
        if (gapLine) {
          logLine(`计划审计：${gapLine}`);
          if (task === 'open') {
            cli(['note', '--tag', '风控', `[计划审计] 计划有买点但无活跃条件单：${gapLine}。到价也接不到，补单或改计划，二选一`]);
          }
        }
      }
      switch (task) {
        case 'plan':
          return tPlan();
        case 'open':
          return tOpen();
        case 'midday':
          return tMidday();
        case 'tail':
          return tTail();
        case 'close':
          return tClose();
        case 'live-on':
          return tLiveOn();
        case 'live-off':
          return tLiveOff();
        default:
          return [];
      }
    })();
    logLine(`${task} 完成：${steps.join(' ｜ ')}${agentNote ? `（${agentNote}）` : ''}`);
    // 机械部分做完不等于任务做完：这三段要判断。无头 CLI 不参与，判断一律回客户端做。
    if (JUDGE_TASKS.includes(task)) {
      logLine(`→ 该判断了：打开 WorkBuddy 说「看下今天的盘」，agent 会读 data/journal/${dayKey()}.md 接上现场；判级别忘 cli.js regime judge`);
    }
  } catch (e) {
    logLine(`${task} 异常：${e.message}`);
    process.exitCode = 1;
  } finally {
    try {
      fs.unlinkSync(lock);
    } catch (e) {}
  }
})();
