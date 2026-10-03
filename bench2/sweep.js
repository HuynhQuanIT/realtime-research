'use strict';
/**
 * bench2/sweep.js <N> [RUN_ID ...]
 * Gom các RUN_ID đã analyze (có summary.csv) của thí nghiệm quét tốc độ tin thành MỘT bảng
 * và ước lượng điểm giao CPU giữa poll và ws theo mô hình tuyến tính  CPU = a + b * rate.
 *
 *   node bench2/sweep.js 200                    (tự chọn mọi RUN_ID có levels=200)
 *   node bench2/sweep.js 200 20260930T1100 ...  (chỉ những RUN_ID liệt kê)
 * Ghi ra results/sweep-N<N>.md
 */
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, 'results');
const N = process.argv[2];
if (!N) { console.error('Usage: node bench2/sweep.js <N> [RUN_ID ...]'); process.exit(1); }
const only = process.argv.slice(3);

const rows = [];
for (const d of fs.readdirSync(root)) {
  if (only.length && !only.includes(d)) continue;
  const dir = path.join(root, d);
  const pj = path.join(dir, 'plan.json'), sj = path.join(dir, 'summary.csv');
  if (!fs.existsSync(pj) || !fs.existsSync(sj)) continue;
  const plan = JSON.parse(fs.readFileSync(pj, 'utf8'));
  if (String(plan.args.levels) !== String(N)) continue;
  const rate = +(plan.args.rate || 1) * 1;
  const [head, ...lines] = fs.readFileSync(sj, 'utf8').trim().split('\n');
  const cols = head.split(',');
  for (const l of lines) {
    const v = l.split(',');
    const o = Object.fromEntries(cols.map((c, i) => [c, v[i]]));
    if (+o.clients !== +N) continue;
    rows.push({ id: d, rate, burst: +(plan.args.burst || 1), poll: +(plan.args.poll || 2000), mech: o.mech, runs: +o.runs,
      delivery: +o.delivery, cpu: +o.cpuPct, cpuLo: +o.cpuPct_lo, cpuHi: +o.cpuPct_hi, mean: +o.mean, p99: +o.pooled_p99,
      eld: +o.eldP99, elu: +o.eluMean, dup: +o.dup, failed: +o.failed });
  }
}
if (!rows.length) { console.error('Không tìm thấy RUN_ID nào có summary.csv và levels=' + N + '. Đã chạy analyze chưa?'); process.exit(1); }
rows.sort((a, b) => a.mech.localeCompare(b.mech) || a.rate - b.rate);

function fit(pts) { // hồi quy tuyến tính y = a + b x, kèm R^2
  const n = pts.length;
  const mx = pts.reduce((s, p) => s + p.x, 0) / n, my = pts.reduce((s, p) => s + p.y, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (const p of pts) { sxy += (p.x - mx) * (p.y - my); sxx += (p.x - mx) ** 2; syy += (p.y - my) ** 2; }
  const b = sxy / sxx, a = my - b * mx;
  return { a, b, r2: syy ? (sxy * sxy) / (sxx * syy) : 1 };
}

const f = (x, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : '-');
let md = `# Quét tốc độ tin, N = ${N} client\n\n`;
md += '| rate (msg/s) | mech | runs | delivery | CPU % core [CI] | mean ms | P99 ms | ELD p99 | ELU | dup | failed |\n|---|---|---|---|---|---|---|---|---|---|---|\n';
for (const r of [...rows].sort((a, b) => a.rate - b.rate || a.mech.localeCompare(b.mech)))
  md += `| ${r.rate} | ${r.mech} | ${r.runs} | ${(r.delivery * 100).toFixed(2)}% | ${f(r.cpu)} [${f(r.cpuLo)}, ${f(r.cpuHi)}] | ${f(r.mean)} | ${f(r.p99)} | ${f(r.eld)} | ${f(r.elu, 2)} | ${r.dup} | ${r.failed} |\n`;

const ok = rows.filter((r) => Number.isFinite(r.cpu));
const rates = [...new Set(ok.map((r) => r.rate))].sort((a, b) => a - b);
const get = (m, r) => ok.find((x) => x.mech === m && x.rate === r);
const POLLISH = new Set(['poll', 'poll-herd', 'poll-legacy']);
const pushMechs = [...new Set(ok.map((r) => r.mech))].filter((m) => !POLLISH.has(m)).sort();

// ---- so sánh từng biến thể push với poll, tìm điểm giao ----
const fits = {};
for (const m of ['poll', ...pushMechs]) {
  const pts = ok.filter((r) => r.mech === m && r.elu < 0.5).map((r) => ({ x: r.rate, y: r.cpu }));
  if (pts.length >= 3) fits[m] = { ...fit(pts), n: pts.length };
}
for (const m of pushMechs) {
  md += `\n## CPU ${m} − poll theo rate (CI 95% giữa các run)\n\n| rate | poll % | ${m} % | ${m} − poll | kết luận |\n|---|---|---|---|---|\n`;
  const diffs = [];
  for (const r of rates) {
    const p = get('poll', r), w = get(m, r);
    if (!p || !w) continue;
    const d = w.cpu - p.cpu;
    const c = w.cpuLo > p.cpuHi ? `${m} tốn hơn poll (CI không giao nhau)` : p.cpuLo > w.cpuHi ? `poll tốn hơn ${m} (CI không giao nhau)` : 'chưa phân biệt được';
    md += `| ${r} | ${f(p.cpu)} | ${f(w.cpu)} | ${f(d)} | ${c}${w.elu > 0.5 ? ` [${m} gần bão hoà, ELU=${f(w.elu, 2)}]` : ''} |\n`;
    diffs.push({ r, d });
  }
  let crossed = false;
  for (let i = 0; i + 1 < diffs.length; i++) {
    if (diffs[i].d <= 0 && diffs[i + 1].d > 0) {
      const x = diffs[i].r + ((0 - diffs[i].d) * (diffs[i + 1].r - diffs[i].r)) / (diffs[i + 1].d - diffs[i].d);
      md += `\nĐiểm giao poll–${m}: giữa **${diffs[i].r}** và **${diffs[i + 1].r} msg/s**, nội suy tuyến tính ≈ **${f(x, 1)} msg/s** (ước lượng thô giữa hai mức đo).\n`;
      crossed = true;
    }
  }
  if (!crossed) {
    const lastD = diffs.length ? diffs[diffs.length - 1].d : NaN;
    md += `\nKhông thấy đổi dấu ${m} − poll trong dải rate đã đo` + (Number.isFinite(lastD) ? (lastD < 0 ? `: ${m} rẻ hơn poll ở mọi mức.\n` : `: ${m} tốn hơn poll ở mọi mức.\n`) : '.\n');
  }
}

// ---- ngưỡng bão hoà: rate đầu tiên mà ELU >= 0.8 ----
md += '\n## Ngưỡng bão hoà (ELU của server)\n\n| mech | rate cao nhất có ELU < 0.5 | rate đầu tiên có ELU ≥ 0.8 | rate lớn nhất đã đo |\n|---|---|---|---|\n';
for (const m of [...new Set(ok.map((r) => r.mech))].sort()) {
  const rs = ok.filter((r) => r.mech === m).sort((a, b) => a.rate - b.rate);
  const lowOk = rs.filter((r) => r.elu < 0.5).map((r) => r.rate);
  const sat = rs.find((r) => r.elu >= 0.8);
  md += `| ${m} | ${lowOk.length ? Math.max(...lowOk) : '-'} | ${sat ? sat.rate : 'chưa bão hoà'} | ${rs[rs.length - 1].rate} (ELU ${f(rs[rs.length - 1].elu, 2)}) |\n`;
}

if (Object.keys(fits).length >= 2) {
  md += '\n## Mô hình tuyến tính CPU% = a + b·rate (chỉ các điểm có ELU < 0.5)\n\n| mech | số điểm | a | b (CPU% mỗi msg/s) | R² |\n|---|---|---|---|---|\n';
  for (const [m, k] of Object.entries(fits)) md += `| ${m} | ${k.n} | ${f(k.a, 2)} | ${f(k.b, 3)} | ${f(k.r2, 3)} |\n`;
  md += '\nĐiểm bão hoà (ELU cao) làm chi phí mỗi lần giao tăng phi tuyến nên bị loại khỏi phép fit.\n';
}
fs.writeFileSync(path.join(root, `sweep-N${N}.md`), md);
console.log(md);
console.log(`\nĐã ghi ${path.join(root, `sweep-N${N}.md`)}`);
