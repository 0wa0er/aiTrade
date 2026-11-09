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
    env: { ...process.env, NO_OPEN: '1' },
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
      env: { ...process.env, NO_OPEN: '1' },
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

  const prune = cli(['watch', 'prune']);
  steps.push(`prune: ${prune.out.split('\n')[0]}`);

  const wl = cli(['watch', 'list']);
  const codes = [...wl.out.matchAll(/^(\d{6})\s/gm)].map((m) => m[1]);
  const ind = indicators(codes.length ? codes : []);

  const planBody = [
    `### 盘前参数卡（${stamp()} 自动生成）`,
    '',
    '> 本节由系统任务 `wake.js plan` 生成：只放**实测参数与硬规则**，不含主观判断。',
    '> 逐条判据、情景归属、下单决策仍需在 08:45~09:45 之间由人或 agent 补写。',
    '',
    '**技术指标（本轮现取，禁止沿用旧值）**',
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
  ].join('\n');

  const write = cli(['journal', 'plan', planBody]);
  steps.push(`plan: ${write.out.split('\n')[0]}`);

  cli(['note', '--tag', '计划', `盘前参数卡已生成（观察池 ${codes.length} 只，指标${ind ? '现取成功' : '取数失败'}），待补主观判断`]);
  return steps;
}

function tOpen() {
  const steps = [];
  steps.push(`alert: ${cli(['alert', 'poll', '--check']).out.split('\n')[0]}`);
  const risk = cli(['risk']);
  steps.push(`risk: ${risk.out.split('\n')[0]}`);
  const quotaLine = (dash.out.match(/风控余量.*$/m) || ['(未取到风控余量)'])[0].trim();

  let sold = 0;
  const hits = [...risk.out.matchAll(/止损|止盈/g)].length;
  if (hits && AUTO) {
    const sells = [...risk.out.matchAll(/^.*?(止损|止盈).*?(\d{6})\D+(\d+)/gm)];
    for (const m of sells) {
      const r = cli(['sell', m[2], m[3]]);
      sold += r.ok ? 1 : 0;
      steps.push(`sell ${m[2]} ${m[3]}: ${r.ok ? '成交' : '失败'}`);
    }
  }
  const dash = cli(['status']);
  cli(['note', '--tag', '记录', `[系统任务] 09:45 开盘窗口：${steps.join('；')}${hits ? `；风控信号 ${hits} 条${AUTO ? `，自动卖出 ${sold} 笔` : '（未开 --auto，仅告警）'}` : '；无风控信号'}；${dash.out.split('\n')[0]}`]);
  return steps;
}

function tMidday() {
  const steps = [];
  steps.push(`alert: ${cli(['alert', 'poll', '--check']).out.split('\n')[0]}`);
  const risk = cli(['risk']);
  steps.push(`risk: ${risk.out.split('\n')[0]}`);
  const quotaLine = (dash.out.match(/风控余量.*$/m) || ['(未取到风控余量)'])[0].trim();
  cli(['note', '--tag', '记录', `[系统任务] 11:25 午间检视：${risk.out.split('\n')[0]}（只卖不买，无动作则不写冗余记录）`]);
  return steps;
}

function tTail() {
  const steps = [];
  steps.push(`alert: ${cli(['alert', 'poll', '--check']).out.split('\n')[0]}`);
  steps.push(`risk: ${cli(['risk']).out.split('\n')[0]}`);
  steps.push(`orders: ${cli(['orders']).out.split('\n')[0]}`);
  const dash = cli(['status']);
  cli(['note', '--tag', '记录', `[系统任务] 14:40 尾盘窗口：${dash.out.split('\n')[0]}；持仓与挂单已检视`]);
  return steps;
}

function tClose() {
  const steps = [];
  steps.push(`sync: ${cli(['journal', 'sync']).out.split('\n')[0]}`);
  steps.push(`prune: ${cli(['watch', 'prune']).out.split('\n')[0]}`);
  steps.push(`index: ${cli(['journal', 'index']).out.split('\n')[0]}`);
  steps.push(`alert: ${cli(['alert', 'poll']).out.split('\n')[0]}`);
  cli(['note', '--tag', '运维', '[系统任务] 15:15 收盘归档：账户快照已同步、观察池已清理、索引已重建。复盘内容需另行补写']);
  return steps;
}

function tLiveOn() {
  const status = cli(['live', 'status']);
  if (/运行中|PID/.test(status.out) && !/未启动/.test(status.out)) return [`已在运行：${status.out.split('\n')[0]}`];
  const child = spawn(process.execPath, [path.join(ROOT, 'tools', 'live.js')], {
    cwd: ROOT,
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, NO_OPEN: '1' },
  });
  child.unref();
  logLine(`盯盘进程已拉起（PID ${child.pid}）`);
  return [`live 已拉起 PID ${child.pid}`];
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
  } catch (e) {
    logLine(`${task} 异常：${e.message}`);
    process.exitCode = 1;
  } finally {
    try {
      fs.unlinkSync(lock);
    } catch (e) {}
  }
})();
