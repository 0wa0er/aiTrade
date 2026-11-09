# AGENTS.md · trade-desk 会话规则

> **任何 agent 会话进入本项目（人工对话或定时任务），第一件事读本文件，第二件事读日志。**
> 定时任务之间彼此独立，不共享上一轮的记忆——今天该做什么，全靠昨天写下的计划。不读日志就动手，等于闭眼开车。

---

## 0. 项目是什么

A 股**模拟**交易台，本地 Node 服务（`http://127.0.0.1:5173`），撮合规则已对齐实盘（对手价成交、价格笼子、涨跌幅、T+1、费用、除权除息）。账户本金 **¥50,000**，由 7 个定时任务在交易日自动盯盘下单；服务常驻时还会按价格区间主动叫醒（见 §9）。

实盘 ≠ 模拟的残余差距记在 [CHANGELOG.md](./CHANGELOG.md) 的「已知近似」里，做收益率结论前必须先看那一段。

## 1. 会话启动：按顺序做，不要跳

```bash
node cli.js journal brief --days 2   # ① 最近两日的计划与复盘摘要
node cli.js alert poll               # ② 有没有待处理的区间触发（IDLE 表示没有）
node cli.js status                   # ③ 账户、时段、持仓、挂单、风控余量（服务没起会自动拉起）
```

然后读 `data/autotrade.json` —— 风控红线，**只读**。

判读要点：

- 上一篇日志的「今日计划」是**上一轮的约定**，不是建议。要偏离必须写明理由。
- `status` 里的时段决定能不能下单（休市/节假日一律不下单，只记录）。
- 有未成交挂单先看 `node cli.js orders`，别在冻结资金上重复下单。
- **风控额度不是固定 1.5 万**：单票/单日上限都是「总权益 × 30%」，用 `node cli.js status` 或 `risk` 输出的 `maxSingleValue` / `maxDailyBuy` 实际值，权益变动后要重算。

## 2. 会话结束：必须留痕

不做这一步，下一次会话就是断片。

| 情形 | 命令 |
|---|---|
| 任何决策、成交、风控动作、观察到的信号 | `node cli.js note --tag 交易/风控/记录 "..."` |
| 制定或修正当日计划 | `node cli.js journal plan "..."`（覆盖，**仅盘前用**） |
| 盘中/尾盘修正计划（保留早盘计划） | `node cli.js journal plan --append "..."` ← 盘中一律用这个 |
| 收盘复盘 | `node cli.js journal review "..."` |
| 刷新账户快照 | `node cli.js journal sync` |
| 处理完一条区间告警 | `node cli.js alert ack A0001 --note "一句话结论"` |
| 改了代码 / 规则 / 配置 | 追加到 [CHANGELOG.md](./CHANGELOG.md) |

> `plan` 是覆盖式：盘前写计划用它；**盘中、尾盘补充必须加 `--append`**，否则早盘计划被冲掉，收盘复盘的「计划 vs 执行」对照链就断了。

**禁止用编辑器或 `echo >>` 直接改 `data/journal/*.md`。** 文件靠 HTML 注释锚点分区，手写必坏；命令行会自己处理锚点、按时间插入、维护索引。详见 [`data/journal/README.md`](./data/journal/README.md)。

`note` 是纯文件操作，**服务挂了也能写**——故障现场必须靠它留证。

## 3. 硬约束（不可绕开）

1. **下单只走 `node cli.js buy/sell`**。不要直接 POST `/api/order`——风控红线全在 cli.js 里，绕过等于没有风控。
2. **不要修改 `data/autotrade.json`**，除非用户明确要求。改了必须在 CHANGELOG 记一条。
3. 买入前必须 `--dry-run` 预检，通过后再真下单。
4. 服务探活失败 → 只记录，**绝不下单**。
5. 红线数值（改前先问用户）：单票 ≤30%（1.5 万）· 单笔 ≥1 万 · 单日买入 ≤30%（1.5 万）· 最多 3 只 · 现金 ≥8% · 止损 -7% · 止盈 +15% · 禁 ST · 禁场外基金 · 单价 ≤130 元。
6. **账户资质不可越过**：模拟账户是「新开户 + 5 万本金 + 无交易经验」，只能交易**沪深主板与场内基金**。科创板、创业板、北交所、可转债、ST 风险警示板、退市整理期、公募 REITs 一律不能买 —— 不是风控偏好，是券商根本不给开权限（创业板要 24 个月交易经验，光有钱也没用）。
   - 判定在 `core/rules.js` 的 `permissionOf()`，配置在 `data/autotrade.json` 的 `account.permissions`。
   - 拦截点有三处：`cli.js guardBuy`、`server.js submitStockOrder`、`cli.js scan`。别绕。
   - **只拦买入**。卖出永远放行 —— 否则权限收紧后持仓退不出来。
   - **例外**：科创 50ETF（588000）、创业板 ETF（159915）这类**场内基金不受板块权限限制**，可以正常买卖。别搞混代码段。

**5 万本金带来的结构性约束**：一手即超 1.5 万的标的（茅台 14.5 万、宁德 2.54 万、多数科创高价股）**买不了**，不要在其身上浪费决策。最低佣金 5 元意味着单笔低于 1 万时费率翻倍，所以不做小单。

7. **技术指标必须本轮现取**，计划里写 MA/BOLL/MACD/前高前低时必须标注取数时点。禁止从旧日志复制——2026-11-09 因照抄 11-06 的 MA20，512890 记成 1.232（真值 1.225）、科创50 记成 1407（真值 1292.42），两处判据全部失真。
8. **情景闸门四档，不是三档**：杀跌 / 低开震荡 / 反弹修复 / **强势放量**（上涨家数占比 >65% 且成交额放大 → 买满但只买回踩）。三档全是弱势假设时，普涨日必然落到「均不成立 → 不下单」，那是制度缺陷不是纪律。
9. **止盈口径**：当日最高价相对成本的涨幅曾 ≥ +15%，且现价较当日最高回落 ≥3% → 卖出一半。「现价仍 ≥ +15%」是错的口径，会漏掉盘中冲高回落。

## 4. 目录职责

| 路径 | 职责 | 可改否 |
|---|---|---|
| `server.js` | HTTP 服务 + 撮合核心 + 除权 | 改后必须跑 `npm test` |
| `core/rules.js` | 交易规则纯函数（时段/板块/单位/涨跌幅/笼子/费用） | 同上，需补用例 |
| `core/journal.js` | 日志引擎（锚点、插入、索引） | 同上 |
| `core/bands.js` | 区间判定 + 告警队列 + 二次分析进程拉起 | 改后必须跑 `npm test` |
| `cli.js` | 命令行 + **风控闸门** | 改后必须跑 `npm test` |
| `public/` | 前端（app.js / index.html / style.css） | 截图自检 |
| `data/autotrade.json` | 风控红线 + **账户资质（`account.permissions`）** | 仅在用户明确要求时；改完即时生效 |
| `data/bands.json` | 区间规则 + 自动分析开关 | 可用 `node cli.js band` 维护 |
| `data/bands.state.json` | 区间运行态（武装/上次触发价） | 程序写，别手改 |
| `data/alerts.json` | 区间告警队列（pending / acked） | 只通过 cli 或面板确认 |
| `data/fees.json` | 券商费率（费用改这里） | 重启生效 |
| `data/journal/` | **业务日志**（每日一篇，规范见其 README） | 只通过 cli 写 |
| `data/state.json` | 账户状态（程序写，别手改） | 否 |
| `test/` | `trading.test.js` + `cli.test.js` | 随改动同步 |

## 5. 命令速查

```bash
# 盯盘
node cli.js status | risk | orders
node cli.js quote 600900 512890
node cli.js scan --limit 12            # 5 万本金可买候选池
node cli.js buy 512890 12000 --dry-run # 预检
node cli.js buy 512890 12000           # 市价买入
node cli.js sell 600900 400 --price 29.90
node cli.js cancel O000001

# 日志
node cli.js note --tag 交易 "09:45 买入 ..."
node cli.js journal plan|review|show|sync|brief|index|archive

# 价格区间
node cli.js band list
node cli.js band set 512890 --lower 1.225 --upper 1.245 --action analyze --cool 30 --note "MA20 下破=防御失效"
node cli.js band del 512890 | band off 512890 | band on 512890
node cli.js band agent --on|--off        # 自动二次分析总开关
node cli.js band agent --probe           # 自检 CLI 是否可用（未登录会明确报出来）
node cli.js band status                  # 监控进程状态 / 上次检查 / 最近错误
node cli.js alert poll [--check]         # 待处理告警；--check 先补一次判定
node cli.js alert ack A0001 --note "已核对，假摔"

# 运维
npm test                               # 规则 + 护栏 + 日志 + 区间四套用例
node server.js                         # 前台起服务（NO_OPEN=1 不开浏览器）
TD_FORCE_SESSION=1 node server.js      # 收盘后调试区间监控用（忽略交易时段）
```

## 6. 已知坑（都踩过，别重踩）

- **探活别用 curl**：本机配了系统代理，`curl 127.0.0.1:5173` 会走代理返回 "upstream connect failed"，误判服务已死。用 `node cli.js status` 或 `node -e "fetch(...)"`。
- **工具 shell 里 spawn 的服务会随调用结束被回收**（不是崩溃，日志干净）。因此定时任务不依赖常驻服务：`cli.js` 每条命令自带 `ensureServer()`，冷启动约 1.6 秒、跑完即退，状态全部落盘。浏览器界面需用户自己双击 `start.bat`。
- **`data/holidays.json` 已补到 2027 年底**（2027 年按国务院 2026-11-05 通知录入）。**2028 年起会退化为只认周末**，春节照常开市。每年年初补一次，别等出事。
- **撮合基于当前五档快照**，模拟不了排队时间优先、逐笔成交、盘中临停。打板类策略在此无效。
- **时间线写入用当前时刻**；补写历史条目要用 `--at 09:45` 或让内容以 `09:45 ` 开头。
- **计划的判据时点不能早于任务启动时点**。曾出现计划写「09:35 站稳 1.232 才买」，而任务 09:45 才启动、09:53 才拿到数据，判据窗口永远过期，只能判 0 笔。判据一律写「本次运行时点」或晚于任务启动的明确时刻。
- **区间监控跑在 `server.js` 里**：关掉服务 = 关掉监控。要长时间盯盘就让服务常驻（双击 `start.bat`），别用「跑一次就退」的方式。
- **休市日不要写业务日志**。任务第一步判时段，休市只打印一行就结束；否则一年会往时间线灌 40 多条「休市」噪声。

## 7. 文档维护

改规则、改目录、改流程时，**同步更新本文件与 `data/journal/README.md`**，并在 `CHANGELOG.md` 记一条。文档过期比没有文档更危险。

## 8. 版本控制

仓库 `main` 单分支，远端 `origin` 为 `github.com/0wa0er/aiTrade`（私有/公开状态以仓库设置为准）。提交按**功能单元**切，不按文件切。

| 场景 | 做法 |
|---|---|
| 改代码 / 规则 / 配置 | 先跑 `npm test`，**通过才提交**；message 写清改了什么、为什么 |
| 只改业务日志 | 可单独提交，如 `log: 2026-11-09 收盘复盘与次日预案` |
| 交易引起的账户变化 | **不提交**，`data/state.json` 已在 `.gitignore` |

- `state.json` 不入库：它每个交易日都在变，纳管后提交历史会被账户流水淹没。恢复初始账户：停服务 → `cp data/state.seed.json data/state.json`。
- 提交前看 `git status`，别把 `state.json`、`.workbuddy/`、临时截图带进去。`public/vendor/` 是第三方文件，除非升级否则不该出现在 diff 里。

---

## 9. 价格区间与触发链路

**两条触发路径，别搞混：**

```
盯盘台常驻（server.js，每 pollSeconds 取价）
   └─ 穿越上/下轨 → data/alerts.json(PENDING) + 时间线[风控] + 前端告警条
        ├─ band.action=analyze 且 agent.enabled 且有已登录 CLI → 立刻拉起二次分析
        └─ 否则留在队列 → 由「区间巡检」定时任务（10:15 / 13:15）消费
定时任务 09:45 / 11:25 / 14:40 开头也会 `alert poll --check`，顺手补一次判定
```

**判定规则（`core/bands.js`）**

- 只在**穿越**时触发：上破要求前值在上轨下方、现值到上轨上方。区间内震荡不触发。
- 触发后 disarm，必须回到区间内（`resetPct` 缓冲，默认 0.3%）才重新武装；`cooldownMin` 内不重复触发。
- 首次观测就在区间外（例如刚启动服务）会报一次 —— 这是「当前已异位」的提醒，不是穿越。
- 一只票一条区间，`band set` 同一代码是**覆盖**，不会叠加。

**告警的生命周期**：`pending` → `acked`。处理完必须 `alert ack`，否则下一轮巡检会重复处理同一条。分析进程需要 CLI 已登录，未登录时告警状态记为 `auth`，仍然留在队列里由巡检兜底。

**注意**：区间只覆盖价格，不覆盖量能与涨速。触发不等于动作，二次分析环节才是决策点；巡检任务**禁止借告警开新仓**，开仓只在 09:45 / 14:40。

---

**免责声明**：本项目为模拟盘演练与策略验证工具，输出不构成投资建议。
