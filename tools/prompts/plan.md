# 盘前计划（08:45，不交易）

工作目录 `D:/workTest/trade-desk`，服务 `127.0.0.1:5193`。

## 第一步 · 快路径
1. `node cli.js status` 确认时段。若为「休市」→ 终端说明一行，**不写日志**，结束。
2. `node cli.js alert poll --check`。输出 `PENDING` 时逐条处理：`node cli.js quote <code>` 核对现价 → 判真突破还是插针 → 需要时改计划 → `node cli.js alert ack <id> --note "结论"`。

## 第二步 · 读上下文
- `node cli.js journal brief --days 2`：昨日「收盘复盘」里的明日初稿 + 今日「今日计划」区。冲突以较新为准，偏离必须写明理由。
- `node cli.js watch list`：观察池剩什么、哪只今天到期。逻辑仍成立的可以续期，已破的 `watch rm --reason`。

## 第三步 · 写计划
`node cli.js journal plan "..."`（覆盖式）。

注意：`wake.js` 若已生成「盘前参数卡」，它就在计划区里。**在它基础上补写，不要删掉参数卡**——那张卡是本轮现取的实测指标，删了就得重新取。

必须含五项：
1. 持仓处置：每只票的止损价、止盈价、减仓条件；
2. 候选与触发：价位 + 信号 + 数量，最多 3 只；
3. 今日最多几笔；
4. 情景闸门四档（含「情景零 强势放量」）；
5. 证伪信号 A/B/C 分级。

只写「接下来做什么」，当日执行过程留给时间线——计划区写胖了次日没人看。

## 第四步 · 同步观察池
1. `node cli.js watch prune`。
2. 把候选（≤3 只，与上面第 2 项一一对应）入池：
   `node cli.js watch add <代码> --note "价位 + 信号" --source plan --ttl 5`
3. 被闸门拒就跳过，不要为凑数硬塞，更不许改风控迁就。

## 硬规矩
- 判据时点一律用「本次运行时刻之后」，**不得写运行之前的时点**。
- 技术指标必须本轮现取（`westock technical <代码> --date <今天>`），禁止从旧日志复制，写进计划要标取数时点。
- 风控数字不要写死 1.5 万：先 `node cli.js risk`，按 `maxSingleValue / maxDailyBuy / minTradeAmount` 实测值写。

风控红线与账户资质见 `AGENTS.md` §3 与 `data/autotrade.json`，不得修改、不得绕开。全程中文。
