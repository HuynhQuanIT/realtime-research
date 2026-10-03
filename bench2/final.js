'use strict';
/**
 * bench2/final.js - chạy TOÀN BỘ thí nghiệm cho bài báo bằng MỘT lệnh, chạy tiếp được nếu bị ngắt.
 *
 *   node bench2/final.js --pilot            chạy thử rút gọn (~30-40 phút) để kiểm tra mọi thứ TRƯỚC khi chạy thật
 *   node bench2/final.js                    chạy thật, cấu hình đầy đủ (preset full)
 *   node bench2/final.js --preset quick     chạy thật nhưng ít lần lặp hơn (khoảng một nửa thời gian)
 *   node bench2/final.js --stages main,ab   chỉ chạy một số giai đoạn (chia nhiều đêm)
 *   node bench2/final.js --dry              chỉ in kế hoạch và ước tính thời gian
 *   node bench2/final.js --analyze-only     chỉ phân tích + tạo báo cáo từ dữ liệu đã có
 *   node bench2/final.js --pilot --fresh    xoá dữ liệu pilot cũ rồi chạy thử lại
 *
 * Giai đoạn:  main  = ma trận chính (poll, sse, ws, push, ws gom tin) theo số client
 *             sweep = quét tốc độ tin: điểm giao poll/push, ngưỡng bão hoà, ảnh hưởng của gom tin
 *             ab    = A/B bản poll cũ (bài đã nộp) với bản sửa: tách nguyên nhân từng lỗi
 *             llm   = workload stream token LLM: TTFT, nhịp token, huỷ giữa chừng
 * Kết quả: bench2/results/<tiền tố>-... ; báo cáo tổng hợp: bench2/results/<tiền tố>-REPORT.md
 * Chạy tiếp: cứ chạy lại ĐÚNG lệnh cũ; run đã xong (có meta.json) được bỏ qua.
 */
const { spawnSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const flag = (n) => argv.includes('--' + n);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const PILOT = flag('pilot');
const PRESET = opt('preset', 'full');
const STAGES = opt('stages', 'main,sweep,ab,llm').split(',');
const PRE = PILOT ? 'pilot-' : PRESET === 'quick' ? 'finalq-' : 'final-';
const RESULTS = path.join(__dirname, 'results');

// ---------------- kế hoạch ----------------
const quick = PRESET === 'quick';
const common = { duration: PILOT ? 8 : 60, warmup: PILOT ? 2 : 10, cooldown: PILOT ? 2 : 4, seed: 1 };
const jobs = [];
jobs.push({ stage: 'main', id: `${PRE}main`, kind: 'broadcast', args: { ...common, mechs: 'poll,sse,ws,push,wsb25',
  levels: PILOT ? '10,100' : '10,100,500,1000', reps: PILOT ? 2 : quick ? 5 : 10, rate: 10, poll: 2000 } });
const SWEEP_N = PILOT ? 100 : 200;
for (const rate of PILOT ? [5, 50] : [1, 2, 5, 10, 20, 50, 100]) {
  const wide = rate >= 20 && !PILOT; // ở tốc độ cao thêm các cửa sổ gom tin khác nhau để xem độ nhạy
  jobs.push({ stage: 'sweep', id: `${PRE}sweep-r${rate}`, kind: 'broadcast', sweepN: SWEEP_N, args: { ...common,
    mechs: wide ? 'poll,ws,wsb10,wsb25,wsb50' : 'poll,ws,wsb25', levels: SWEEP_N, reps: PILOT ? 2 : quick ? 3 : 5, rate, poll: 2000 } });
}
jobs.push({ stage: 'ab', id: `${PRE}ab`, kind: 'broadcast', args: { ...common, mechs: 'poll,poll-herd,poll-legacy',
  levels: PILOT ? '10,100' : '10,100,500,1000', reps: PILOT ? 2 : quick ? 4 : 8, rate: 1, poll: 2000 } });
jobs.push({ stage: 'llm', id: `${PRE}llm`, kind: 'llm', args: { workload: 'llm', ...common, warmup: PILOT ? 3 : 15, duration: PILOT ? 10 : 60,
  mechs: 'llm-sse,llm-ws,llm-poll', levels: PILOT ? '20,50' : '50,100,250,500', reps: PILOT ? 2 : quick ? 3 : 6,
  tokens: PILOT ? 40 : 200, tokrate: 20, cancelp: 0.3, ttft: PILOT ? 200 : 300, poll: 250 } });
const active = jobs.filter((j) => STAGES.includes(j.stage));

function jobRuns(j) {
  const a = j.args;
  return a.mechs.split(',').length * String(a.levels).split(',').length * a.reps;
}
function secPerRun(j) {
  const a = j.args;
  const drain = j.kind === 'llm' ? (a.tokens / a.tokrate) * 1000 * 1.3 + a.ttft * 3 + 3000 : Math.max(3000, 2 * a.poll + 1000);
  return a.warmup + a.duration + drain / 1000 + 14 + a.cooldown;
}
const runArgs = (j) => { const r = []; for (const [k, v] of Object.entries(j.args)) r.push('--' + k, String(v)); return r.concat(['--runid', j.id, '--resume', '1']); };
const dirOf = (j) => path.join(RESULTS, j.id);
const metaCount = (j) => (fs.existsSync(dirOf(j)) ? fs.readdirSync(dirOf(j)).filter((d) => fs.existsSync(path.join(dirOf(j), d, 'meta.json'))).length : 0);
const isDone = (j) => metaCount(j) >= jobRuns(j);

function printPlan() {
  let totalH = 0, totalRuns = 0;
  console.log(`\nKế hoạch (${PILOT ? 'PILOT rút gọn' : 'preset ' + PRESET}):`);
  for (const j of active) {
    const remaining = Math.max(0, jobRuns(j) - metaCount(j));
    const h = (remaining * secPerRun(j)) / 3600;
    totalH += h; totalRuns += remaining;
    console.log(`  ${isDone(j) ? '[xong]' : '[chạy]'} ${j.id.padEnd(22)} ${String(jobRuns(j)).padStart(4)} run, còn ${String(remaining).padStart(4)} run ~ ${h.toFixed(1)} giờ`);
  }
  console.log(`  Tổng cần chạy: ${totalRuns} run, ước tính ~${totalH.toFixed(1)} giờ (chưa tính các lần chạy lại do lỗi)\n`);
  return totalH;
}

async function runJob(j) {
  console.log(`\n=== ${j.id} (${j.stage}) ===`);
  const code = await new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(__dirname, 'run.js'), ...runArgs(j)], { stdio: 'inherit' });
    p.on('exit', (c) => { if (c !== 0) console.error(`run.js thoát với mã ${c} cho ${j.id}`); resolve(c); });
  });
  const have = metaCount(j), need = jobRuns(j);
  if (have < need) console.error(`!! ${j.id}: mới có ${have}/${need} run. Chạy lại đúng lệnh này để chạy tiếp phần còn thiếu.`);
  return code;
}

// ---------------- phân tích + báo cáo ----------------
function analyzeAll() {
  const lines = [];
  const host = (() => { try { const p = JSON.parse(fs.readFileSync(path.join(dirOf(active[0]), 'plan.json'), 'utf8')); return p.host; } catch { return null; } })();
  lines.push(`# Báo cáo tổng hợp ${PRE.replace(/-$/, '')}\n`);
  if (host) lines.push(`Máy: ${host.cpu}, ${host.cores} luồng, Node ${host.node}, ${host.platform}. Loadgen chạy CÙNG máy với server.\n`);
  const sweepIds = [];
  for (const j of active) {
    if (!fs.existsSync(dirOf(j))) { lines.push(`## ${j.id}\n\n(chưa có dữ liệu)\n`); continue; }
    const script = j.kind === 'llm' ? 'llm-analyze.js' : 'analyze.js';
    spawnSync(process.execPath, [path.join(__dirname, script), j.id], { stdio: 'ignore' });
    if (j.stage === 'sweep') sweepIds.push(j.id);
    const sm = path.join(dirOf(j), 'summary.md');
    lines.push(`## ${j.id} (${j.stage}): ${metaCount(j)}/${jobRuns(j)} run\n`);
    lines.push(`Chi tiết: \`${path.relative(__dirname, sm)}\`\n`);
    if (fs.existsSync(sm)) {
      const t = fs.readFileSync(sm, 'utf8');
      const w = t.split('## Cảnh báo tự động')[1];
      const warns = w ? w.split('\n').filter((l) => l.startsWith('- ')) : [];
      lines.push(warns.length ? 'Cảnh báo:\n\n' + warns.join('\n') + '\n' : 'Không có cảnh báo.\n');
    } else lines.push('(không tạo được summary)\n');
  }
  // gom các RUN_ID quét rate thành 1 bảng
  if (sweepIds.length) {
    const r = spawnSync(process.execPath, [path.join(__dirname, 'sweep.js'), String(SWEEP_N), ...sweepIds], { encoding: 'utf8' });
    const out = path.join(RESULTS, `sweep-N${SWEEP_N}.md`);
    if (fs.existsSync(out)) {
      const dst = path.join(RESULTS, `${PRE}sweep-N${SWEEP_N}.md`);
      fs.copyFileSync(out, dst);
      lines.push(`## Quét tốc độ tin gộp\n\nBảng gộp, điểm giao và ngưỡng bão hoà: \`${path.relative(__dirname, dst)}\`\n`);
    } else lines.push(`## Quét tốc độ tin gộp\n\nKhông tạo được bảng gộp: ${(r.stderr || '').trim()}\n`);
  }
  // bảng A/B
  const ab = active.find((j) => j.stage === 'ab');
  if (ab && fs.existsSync(path.join(dirOf(ab), 'summary.csv'))) {
    const [head, ...rows] = fs.readFileSync(path.join(dirOf(ab), 'summary.csv'), 'utf8').trim().split('\n');
    const c = head.split(',');
    lines.push('## A/B: poll bản sửa, poll "bầy đàn" (client cũ + server mới), poll cũ (nguyên bản)\n');
    lines.push('| cơ chế | số client | delivery | số lần nhận trùng | mean ms | P99 ms | CPU % core |\n|---|---|---|---|---|---|---|');
    for (const row of rows) {
      const v = Object.fromEntries(row.split(',').map((x, i) => [c[i], x]));
      lines.push(`| ${v.mech} | ${v.clients} | ${(100 * +v.delivery).toFixed(3)}% | ${v.dup} | ${(+v.mean).toFixed(1)} | ${(+v.pooled_p99).toFixed(1)} | ${(+v.cpuPct).toFixed(1)} |`);
    }
    lines.push('');
  }
  const report = path.join(RESULTS, `${PRE}REPORT.md`);
  fs.writeFileSync(report, lines.join('\n'));
  console.log(`\nBáo cáo tổng hợp: ${report}`);
  return report;
}

(async () => {
  if (PILOT && flag('fresh')) {
    for (const d of fs.existsSync(RESULTS) ? fs.readdirSync(RESULTS) : []) if (d.startsWith('pilot-')) fs.rmSync(path.join(RESULTS, d), { recursive: true, force: true });
    console.log('Đã xoá dữ liệu pilot cũ.');
  }
  fs.mkdirSync(RESULTS, { recursive: true });
  printPlan();
  if (flag('dry')) return;
  if (!flag('analyze-only')) {
    const t0 = Date.now();
    for (const j of active) {
      if (isDone(j)) { console.log(`bỏ qua ${j.id} (đã xong)`); continue; }
      const code = await runJob(j);
      if (code === 3) { // lỗi môi trường (DB chưa bật, lỗi lặp lại...): dừng cả kế hoạch, không đốt thêm giờ
        console.error('\nĐã dừng toàn bộ kế hoạch vì lỗi môi trường (xem thông báo phía trên). Sửa xong chạy lại đúng lệnh này.');
        process.exit(3);
      }
    }
    console.log(`\nChạy xong sau ${((Date.now() - t0) / 3600000).toFixed(2)} giờ.`);
  }
  analyzeAll();
  if (PILOT) {
    const bad = [];
    for (const j of active) {
      const sm = path.join(dirOf(j), 'summary.md');
      const t = fs.existsSync(sm) ? fs.readFileSync(sm, 'utf8').split('## Cảnh báo tự động')[1] || '' : '';
      for (const l of t.split('\n').filter((x) => x.startsWith('- '))) {
        if (/poll-legacy.*delivery/.test(l)) continue;   // mong đợi: bản poll cũ mất tin
        if (/^- CHẠY LẠI/.test(l)) continue;             // chấp nhận được, đã ghi errors.log
        bad.push(`${j.id}: ${l.slice(2)}`);
      }
      if (!isDone(j)) bad.push(`${j.id}: mới ${metaCount(j)}/${jobRuns(j)} run`);
    }
    console.log(bad.length ? `\nPILOT CHƯA ĐẠT, ${bad.length} vấn đề:\n  - ${bad.join('\n  - ')}` : '\nPILOT ĐẠT: không có vấn đề nào ngoài các cảnh báo dự kiến. Có thể chạy thật.');
  }
  const incomplete = active.filter((j) => !isDone(j));
  if (incomplete.length) {
    console.log(`\nCòn ${incomplete.length} giai đoạn chưa đủ run: ${incomplete.map((j) => j.id).join(', ')}. Chạy lại đúng lệnh này để chạy tiếp.`);
    process.exitCode = 2;
  }
})().catch((e) => { console.error(e); process.exit(1); });