# AGENTS.md · trade-desk 会话规则

> **任何 agent 会话进入本项目（人工对话或定时任务），第一件事读本文件，第二件事读日志。**
> 定时任务之间彼此独立，不共享上一轮的记忆——今天该做什么，全靠昨天写下的计划。不读日志就动手，等于闭眼开车。

---

## 0. 项目是什么

A 股**模拟**交易台，本地 Node 服务（`http://127.0.0.1:5173`），撮合规则已对齐实盘（对手价成交、价格笼子、涨跌幅、T+1、费用、除权除息）。账户本金 **¥50,000**，由 4 个定时任务在交易日自动盯盘下单。

实盘 ≠ 模拟的残余差距记在 [CHANGELOG.md](./CHANGELOG.md) 的「已知近似」里，做收益率结论前必须先看那一段。

## 1. 会话启动：按顺序做，不要跳

```bash
node cli.js journal brief --days 2   # ① 最近两日的计划与复盘摘要
node cli.js status                   # ② 账户、时段、持仓、挂单、风控余量（服务没起会自动拉起）
```

然后读 `data/autotrade.json` —— 风控红线，**只读**。

判读要点：

- 上一篇日志的「今日计划」是**上一轮的约定**，不是建议。要偏离必须写明理由。
- `status` 里的时段决定能不能下单（休市/节假日一律不下单，只记录）。
- 有未成交挂单先看 `node cli.js orders`，别在冻结资金上重复下单。

## 2. 会话结束：必须留痕

不做这一步，下一次会话就是断片。

| 情形 | 命令 |
|---|---|
| 任何决策、成交、风控动作、观察到的信号 | `node cli.js note --tag 交易/风控/记录 "..."` |
| 制定或修正当日计划 | `node cli.js journal plan "..."`（覆盖） |
| 尾盘补明日预案（保留早盘计划） | `node cli.js journal plan --append "..."` |
| 收盘复盘 | `node cli.js journal review "..."` |
| 刷新账户快照 | `node cli.js journal sync` |
| 改了代码 / 规则 / 配置 | 追加到 [CHANGELOG.md](./CHANGELOG.md) |

> `plan` 是覆盖式：盘前写计划用它；盘中/尾盘补充必须加 `--append`，否则早盘计划被冲掉。

**禁止用编辑器或 `echo >>` 直接改 `data/journal/*.md`。** 文件靠 HTML 注释锚点分区，手写必坏；命令行会自己处理锚点、按时间插入、维护索引。详见 [`data/journal/README.md`](./data/journal/README.md)。

`note` 是纯文件操作，**服务挂了也能写**——故障现场必须靠它留证。

## 3. 硬约束（不可绕开）

1. **下单只走 `node cli.js buy/sell`**。不要直接 POST `/api/order`——风控红线全在 cli.js 里，绕过等于没有风控。
2. **不要修改 `data/autotrade.json`**，除非用户明确要求。改了必须在 CHANGELOG 记一条。
3. 买入前必须 `--dry-run` 预检，通过后再真下单。
4. 服务探活失败 → 只记录，**绝不下单**。
5. 红线数值（改前先问用户）：单票 ≤30%（1.5 万）· 单笔 ≥1 万 · 单日买入 ≤30%（1.5 万）· 最多 3 只 · 现金 ≥8% · 止损 -7% · 止盈 +15% · 禁 ST · 禁场外基金 · 单价 ≤130 元。

**5 万本金带来的结构性约束**：一手即超 1.5 万的标的（茅台 14.5 万、宁德 2.54 万、多数科创高价股）**买不了**，不要在其身上浪费决策。最低佣金 5 元意味着单笔低于 1 万时费率翻倍，所以不做小单。

## 4. 目录职责

| 路径 | 职责 | 可改否 |
|---|---|---|
| `server.js` | HTTP 服务 + 撮合核心 + 除权 | 改后必须跑 `npm test` |
| `core/rules.js` | 交易规则纯函数（时段/板块/单位/涨跌幅/笼子/费用） | 同上，需补用例 |
| `core/journal.js` | 日志引擎（锚点、插入、索引） | 同上 |
| `cli.js` | 命令行 + **风控闸门** | 改后必须跑 `npm test` |
| `public/` | 前端（app.js / index.html / style.css） | 截图自检 |
| `data/autotrade.json` | 风控红线 | 仅在用户明确要求时 |
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

# 运维
npm test                               # 规则 + 护栏两套用例
node server.js                         # 前台起服务（NO_OPEN=1 不开浏览器）
```

## 6. 已知坑（都踩过，别重踩）

- **探活别用 curl**：本机配了系统代理，`curl 127.0.0.1:5173` 会走代理返回 "upstream connect failed"，误判服务已死。用 `node cli.js status` 或 `node -e "fetch(...)"`。
- **工具 shell 里 spawn 的服务会随调用结束被回收**（不是崩溃，日志干净）。因此定时任务不依赖常驻服务：`cli.js` 每条命令自带 `ensureServer()`，冷启动约 1.6 秒、跑完即退，状态全部落盘。浏览器界面需用户自己双击 `start.bat`。
- **`data/holidays.json` 只到 2026 年底**，2027 年起退化为只认周末，春节会照常开市。每年年初补一次。
- **撮合基于当前五档快照**，模拟不了排队时间优先、逐笔成交、盘中临停。打板类策略在此无效。
- **时间线写入用当前时刻**；补写历史条目要用 `--at 09:45` 或让内容以 `09:45 ` 开头。

## 7. 文档维护

改规则、改目录、改流程时，**同步更新本文件与 `data/journal/README.md`**，并在 `CHANGELOG.md` 记一条。文档过期比没有文档更危险。

---

**免责声明**：本项目为模拟盘演练与策略验证工具，输出不构成投资建议。
