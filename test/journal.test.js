/**
 * 日志引擎自测 —— 在临时目录里跑，不碰真实日志。
 * 覆盖：骨架、按时间插入、多行条目、计划/复盘覆盖、旧格式迁移、索引。
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'td-journal-'));
process.env.TD_JOURNAL_DIR = TMP;
const J = require('../core/journal');

let pass = 0;
let fail = 0;
function ok(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    console.log(`  ✗ ${name}\n     ${e.message}`);
  }
}
const read = (k) => fs.readFileSync(J.fileOf(k), 'utf8');
const clean = () => {
  for (const f of fs.readdirSync(TMP)) {
    const p = path.join(TMP, f);
    if (fs.statSync(p).isDirectory()) fs.rmSync(p, { recursive: true, force: true });
    else fs.unlinkSync(p);
  }
};

const D = '2026-11-09';

console.log('日志引擎');

ok('新建日志包含四个区块锚点', () => {
  clean();
  J.ensureJournal(D);
  const t = read(D);
  for (const k of ['tl', 'plan', 'review', 'meta']) {
    assert.ok(t.includes(`<!-- ${k.toUpperCase()}:START -->`), `缺 ${k} 锚点`);
    assert.ok(t.includes(`<!-- ${k.toUpperCase()}:END -->`), `缺 ${k} 结束锚点`);
  }
  assert.ok(t.startsWith(`# ${D} 周一`), '标题应含日期与星期');
});

ok('时间线条目按 HH:MM 插入，乱序写入仍正序', () => {
  clean();
  J.appendTimeline({ key: D, tag: '交易', text: '买入 A', at: '14:45' });
  J.appendTimeline({ key: D, tag: '计划', text: '计划已出', at: '09:05' });
  J.appendTimeline({ key: D, tag: '风控', text: '止损检查', at: '10:12' });
  const tl = J.sectionOf(read(D), 'tl');
  const times = tl.split('\n').filter((l) => l.startsWith('- ')).map((l) => l.match(/`(\d{2}:\d{2})`/)[1]);
  assert.deepStrictEqual(times, ['09:05', '10:12', '14:45']);
  assert.ok(tl.includes('**[计划]**'), '标签应写入');
});

ok('同分钟多条保持写入顺序', () => {
  clean();
  J.appendTimeline({ key: D, text: '第一条', at: '09:30' });
  J.appendTimeline({ key: D, text: '第二条', at: '09:30' });
  const tl = J.sectionOf(read(D), 'tl');
  assert.ok(tl.indexOf('第一条') < tl.indexOf('第二条'));
});

ok('多行内容折叠为一条（续行缩进）', () => {
  clean();
  J.appendTimeline({ key: D, text: '今日未交易，原因有三\n一、情景一触发\n二、跌破 MA20', at: '15:15' });
  const tl = J.sectionOf(read(D), 'tl');
  assert.strictEqual(tl.split('\n').filter((l) => l.startsWith('- ')).length, 1, '应只有一条');
  assert.ok(tl.includes('\n  一、情景一触发'), '续行应缩进两格');
});

ok('未知标签降级为「记录」', () => {
  clean();
  J.appendTimeline({ key: D, text: 'x', tag: '瞎写', at: '09:00' });
  assert.ok(J.sectionOf(read(D), 'tl').includes('**[记录]**'));
});

ok('计划区覆盖写入，保留空行与表格结构', () => {
  clean();
  J.setSection('plan', '结论\n\n| 批次 | 标的 |\n|---|---|\n| 1 | 512890 |', D);
  J.setSection('plan', '新结论\n\n第二段', D);
  const plan = J.sectionOf(read(D), 'plan');
  assert.ok(plan.includes('新结论'), '应被覆盖');
  assert.ok(!plan.includes('512890'), '旧内容不应残留（已归档，不应并置在计划区）');
  assert.ok(plan.includes('\n\n第二段'), '空行必须保留，否则 Markdown 会粘连');
  assert.ok(plan.indexOf('新结论') < plan.indexOf('第二段'), '顺序不能乱');
});

ok('复盘区独立于计划区', () => {
  clean();
  J.setSection('plan', '计划内容', D);
  J.setSection('review', '复盘内容', D);
  const t = read(D);
  assert.ok(J.sectionOf(t, 'plan').includes('计划内容'));
  assert.strictEqual(J.sectionOf(t, 'review'), '复盘内容', '复盘区不应被计划头污染');
});

ok('--append 追加到计划区末尾，不冲掉早盘计划', () => {
  clean();
  J.setSection('plan', '早盘结论：只做 512890 一档', D);
  J.setSection('plan', '尾盘补充：隔夜仓位 30%，明日不追高', D, { append: true });
  const plan = J.sectionOf(read(D), 'plan');
  assert.ok(plan.includes('早盘结论'), '原计划必须保留');
  assert.ok(plan.includes('尾盘补充'), '追加内容要在');
  assert.ok(plan.indexOf('早盘结论') < plan.indexOf('尾盘补充'), '顺序应为先早盘后尾盘');
});

ok('append 到空区时不出现多余分隔线', () => {
  clean();
  J.setSection('plan', '唯一内容', D, { append: true });
  const plan = J.sectionOf(read(D), 'plan');
  assert.ok(plan.includes('唯一内容'));
  assert.ok(!read(D).includes('\n---\n'), '不应插入分隔线');
});

ok('计划区覆盖：旧版归档、时间线留指针、版本递增', () => {
  clean();
  J.setSection('plan', '第一版：买 512890 一档', D);
  assert.strictEqual(J.planVersions(D).length, 0, '首版写入时没有旧版可归档');

  J.setSection('plan', '第二版：改买 600900', D);
  const files = J.planVersions(D);
  assert.strictEqual(files.length, 1, '旧版应归档一份');
  assert.ok(fs.readFileSync(files[0], 'utf8').includes('第一版'), '归档内容应是旧版原文');

  const tl = J.sectionOf(read(D), 'tl');
  assert.ok(/计划区旧版（v1，\d+ 行）被覆盖/.test(tl), '时间线要留归档指针');
  assert.ok(tl.includes('plan-archive'), '指针里要有归档路径');

  J.setSection('plan', '第三版：空仓等待', D);
  assert.strictEqual(J.planVersions(D).length, 2, '第二版也要归档');
  assert.ok(J.sectionOf(read(D), 'plan').includes('第 3 版'), '版本头应递增到 v3');
});

ok('计划区版本头标明交易日与写入时点', () => {
  clean();
  J.setSection('plan', '内容', D);
  const plan = J.sectionOf(read(D), 'plan');
  const head = plan.split('\n')[0];
  assert.ok(head.startsWith('> 计划区 ｜ 交易日 '), `首行应是版本头，实为：${head}`);
  assert.ok(head.includes(D), '要标交易日，避免次日读错');
  assert.ok(/第 1 版/.test(head));
  assert.ok(/写入 \d{2}:\d{2}/.test(head));
});

ok('重复覆盖不会把版本头套娃', () => {
  clean();
  J.setSection('plan', '内容甲', D);
  const once = J.sectionOf(read(D), 'plan');
  J.setSection('plan', once, D); // 把带头的正文再写回去
  const twice = J.sectionOf(read(D), 'plan');
  assert.strictEqual((twice.match(/> 计划区 ｜/g) || []).length, 1, '版本头只能有一行');
});

ok('空内容被拒绝', () => {
  clean();
  assert.throws(() => J.appendTimeline({ key: D, text: '   ' }), /空/);
  assert.throws(() => J.setSection('plan', '', D), /空/);
});

ok('旧格式迁移：时间线抽出并排序，正文原文保留', () => {
  clean();
  fs.mkdirSync(TMP, { recursive: true });
  fs.writeFileSync(
    J.fileOf(D),
    `# ${D} 盯盘日志\n\n- **15:36** 初始化的内容\n- **09:05** 更早的一条\n\n---\n\n## 下周一建仓计划\n\n关键段落不要丢\n\n## 收盘复盘\n\n复盘旧文\n`,
    'utf8'
  );
  const r = J.appendTimeline({ key: D, tag: '运维', text: '迁移后新增', at: '16:00' });
  assert.ok(r.migrated, '应标记为迁移');
  const t = read(D);
  const times = J.sectionOf(t, 'tl').split('\n').filter((l) => l.startsWith('- ')).map((l) => l.match(/`(\d{2}:\d{2})`/)[1]);
  assert.deepStrictEqual(times, ['09:05', '15:36', '16:00'], '迁移后应正序');
  assert.ok(J.sectionOf(t, 'plan').includes('关键段落不要丢'), '标题含"计划"的段落进 PLAN');
  assert.ok(J.sectionOf(t, 'review').includes('复盘旧文'), '标题含"复盘"的段落进 REVIEW');
  assert.ok(t.includes('LEGACY:START'), '应有历史正文区');
});

ok('已规范化的文件不会重复迁移', () => {
  const r = J.appendTimeline({ key: D, text: '再来一条', at: '16:30' });
  assert.ok(!r.migrated);
  assert.strictEqual(read(D).match(/TL:START/g).length, 1, '锚点不应重复');
});

ok('索引统计条目数与计划/复盘状态', () => {
  clean();
  J.appendTimeline({ key: '2026-11-05', text: 'a', at: '09:00' });
  J.appendTimeline({ key: '2026-11-05', text: 'b', at: '10:00' });
  J.setSection('plan', '有计划的摘要', '2026-11-05');
  J.appendTimeline({ key: '2026-11-06', text: 'c', at: '09:00' });
  const r = J.renderIndex();
  assert.strictEqual(r.count, 2);
  const idx = fs.readFileSync(path.join(TMP, 'INDEX.md'), 'utf8');
  assert.ok(idx.includes('| 2026-11-05 | 周四 | 2 | ✓ | — |'), `索引行不符：\n${idx}`);
  assert.ok(idx.includes('有计划的摘要'), '摘要在索引里');
  assert.ok(idx.indexOf('2026-11-06') < idx.indexOf('2026-11-05'), '应按日期倒序');
});

ok('brief 返回最近 N 天的计划与时间线', () => {
  const b = J.brief(1);
  assert.strictEqual(b.length, 1);
  assert.strictEqual(b[0].key, '2026-11-06');
  assert.ok(b[0].timeline.includes('c'));
});

ok('归档把旧日志移入 archive/', () => {
  clean();
  J.appendTimeline({ key: '2020-01-02', text: '很久以前', at: '09:00' });
  J.appendTimeline({ key: J.dateKey(), text: '今天', at: '09:00' });
  const moved = J.archiveOld(90);
  assert.deepStrictEqual(moved, ['2020-01-02']);
  assert.ok(fs.existsSync(path.join(TMP, 'archive', '2020-01-02.md')));
  assert.ok(fs.existsSync(J.fileOf(J.dateKey())), '今天的不能被归档');
});

clean();
fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '通过' : '失败'}：${pass} 项通过，${fail} 项失败`);
process.exitCode = fail ? 1 : 0;
