'use strict';
/**
 * bench2/analyze.js <RUN_ID>
 * Đọc log từng sự kiện -> summary.csv, summary.md, ecdf.csv trong results/<RUN_ID>/
 *
 * Định nghĩa (khớp với cách nói trong bài):
 *  - Message "trong cửa sổ đo": tc thuộc [tWinStart, tWinEnd) theo gen.ndjson
 *  - Kỳ vọng: mỗi message trong cửa sổ được MỖI client nhận đúng 1 lần
 *  - delivery_ratio = số cặp (message, client) nhận được (kể cả trong pha drain) / kỳ vọng
 *  - dup = số lần nhận lặp cặp (message, client)
 *  - Latency: total = tr-tc | pipeline (DB+bus) = tb-tc | delivery (kênh) = tr-tb
 *    Chỉ tính lần nhận ĐẦU TIÊN của mỗi cặp.
 */
const fs = require('fs');
const path = require('path');

const id = process.argv[2];
if (!id) { console.error('Usage: node bench2/analyze.js <RUN_ID>'); process.exit(1); }
const root = path.join(__dirname, 'results', id);

function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const R = rng(12345);
const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : NaN);
const mean = (a) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
function bootCI(vals, B = 2000) { // CI 95% của trung bình qua các run
  const v = vals.filter((x) => Number.isFinite(x));
  if (v.length < 2) return [NaN, NaN];
  const ms = [];
  for (let b = 0; b < B; b++) { let s = 0; for (let i = 0; i < v.length; i++) s += v[Math.floor(R() * v.length)]; ms.push(s / v.length); }
  ms.sort((x, y) => x - y);
  return [ms[Math.floor(0.025 * B)], ms[Math.floor(0.975 * B)]];
}
function bootDiffCI(a, b, B = 2000) {
  if (a.length < 2 || b.length < 2) return [NaN, NaN];
  const d = [];
  for (let k = 0; k < B; k++) {
    let sa = 0, sb = 0;
    for (let i = 0; i < a.length; i++) sa += a[Math.floor(R() * a.length)];
    for (let i = 0; i < b.length; i++) sb += b[Math.floor(R() * b.length)];
    d.push(sa / a.length - sb / b.length);
  }
  d.sort((x, y) => x - y);
  return [d[Math.floor(0.025 * B)], d[Math.floor(0.975 * B)]];
}

function analyzeRun(dir) {
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  const n = meta.n;
  // message trong cửa sổ
  const idx = new Map(); let M = 0;
  for (const line of fs.readFileSync(path.join(dir, 'gen.ndjson'), 'utf8').split('\n')) {
    if (!line) continue;
    const g = JSON.parse(line);
    if (g.tc >= meta.tWinStart && g.tc < meta.tWinEnd) idx.set(g.id, M++);
  }
  const seen = new Uint8Array(M * n);
  const total = new Float64Array(M * n), pipe = new Float64Array(M * n), deliv = new Float64Array(M * n);
  let got = 0, dup = 0, outWin = 0, neg = 0;
  for (const f of fs.readdirSync(dir).filter((x) => x.startsWith('events-'))) {
    const b = fs.readFileSync(path.join(dir, f));
    const a = new Float64Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));
    for (let i = 0; i + 4 < a.length; i += 5) {
      const mi = idx.get(a[i + 1]);
      if (mi === undefined) { outWin++; continue; }
      const k = mi * n + a[i];
      if (seen[k]) { dup++; continue; }
      seen[k] = 1;
      const tc = a[i + 2], tb = a[i + 3], tr = a[i + 4];
      total[got] = tr - tc; pipe[got] = tb - tc; deliv[got] = tr - tb;
      if (tr - tc < 0) neg++;
      got++;
    }
  }
  const tot = total.subarray(0, got).slice().sort();
  const expected = M * n;

  // resource từ /stats trong cửa sổ đo
  const st = fs.readFileSync(path.join(dir, 'stats.ndjson'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const inWin = st.filter((s) => s.t >= meta.tWinStart && s.t <= meta.tWinEnd);
  const s0 = inWin[0], s1 = inWin[inWin.length - 1];
  const dt = s1 && s0 ? (s1.t - s0.t) : NaN;
  const cpuUsr = s1 ? ((s1.cpuUserUs - s0.cpuUserUs) / 1000 / dt) * 100 : NaN;
  const cpuSys = s1 ? ((s1.cpuSysUs - s0.cpuSysUs) / 1000 / dt) * 100 : NaN;
  const planned = meta.rate * meta.duration;
  const why = [];
  const postErrExplains = (meta.genErrors || 0) > 0.01 * (meta.sent || 1); // thiếu tin do POST lỗi = quá tải thật, giữ làm dữ liệu
  // thiếu quá 10% VÀ quá 2 tin (cửa sổ rất ngắn có thể lệch 1-2 tin ở biên do thời điểm tick)
  if (M < Math.min(0.9 * planned, planned - 2) && !postErrExplains) why.push(`chỉ ${M}/${Math.round(planned)} message trong cửa sổ đo`);
  if (inWin.length < 3) why.push(`chỉ ${inWin.length} mẫu /stats trong cửa sổ đo`);
  return {
    meta, expected, got, valid: why.length === 0, why: why.join('; '), M, attempt: meta.attempt || 1, postErrRate: (meta.genErrors || 0) / (meta.sent || 1),
    run: {
      delivery: expected ? got / expected : NaN, dup, outWin, neg,
      mean: mean(Array.from(tot)), p50: pct(tot, 50), p95: pct(tot, 95), p99: pct(tot, 99), p999: pct(tot, 99.9), max: tot[tot.length - 1],
      pipeMean: mean(Array.from(pipe.subarray(0, got))),
      delivMean: mean(Array.from(deliv.subarray(0, got))),
      cpuPct: cpuUsr + cpuSys, cpuUsr, cpuSys,
      rssMax: Math.max(...inWin.map((s) => s.rssMB)), heapMax: Math.max(...inWin.map((s) => s.heapMB)),
      eldP99: Math.max(...inWin.map((s) => s.eldP99)), eluMean: mean(inWin.map((s) => s.elu)),
      gcMs: s1 ? s1.gcMs - s0.gcMs : NaN, backlog: Math.max(...inWin.map((s) => s.backlogBytes)),
      pollRps: s1 ? (s1.pollReq - s0.pollReq) / (dt / 1000) : NaN,
      loadEldP99: Math.max(...(meta.workers || []).map((w) => w.eldP99)),
      failed: meta.failed, connected: meta.connected, genErr: meta.genErrors,
    },
    pooled: tot,
  };
}

// ---- gom theo (mech, n) ----
const dirs = fs.readdirSync(root).filter((d) => fs.existsSync(path.join(root, d, 'meta.json'))).sort();
const groups = new Map();
for (const d of dirs) { const m = JSON.parse(fs.readFileSync(path.join(root, d, 'meta.json'), 'utf8')); const k = `${m.mech}|${m.n}`; (groups.get(k) || groups.set(k, []).get(k)).push(d); }

const cols = ['delivery', 'dup', 'mean', 'p50', 'p95', 'p99', 'p999', 'pipeMean', 'delivMean', 'cpuPct', 'rssMax', 'eldP99', 'eluMean', 'gcMs', 'backlog', 'pollRps', 'loadEldP99'];
const invalids = [], retried = [], loadWarn = [];
const rows = []; const ecdf = ['mech,clients,quantile,latency_ms'];
const runVals = new Map(); // để tính diff SSE-WS
for (const [k, list] of [...groups.entries()].sort((a, b) => { const [ma, na] = a[0].split('|'); const [mb, nb] = b[0].split('|'); return ma === mb ? +na - +nb : ma.localeCompare(mb); })) {
  const [mech, n] = k.split('|');
  const all = list.map((d) => ({ ...analyzeRun(path.join(root, d)), dir: d }));
  for (const r of all) {
    if (!r.valid) invalids.push(`${r.dir}: ${r.why}`);
    if (r.attempt > 1) retried.push(`${r.dir}: thành công ở lần chạy thứ ${r.attempt} (xem errors.log)`);
    if (r.postErrRate > 0.01) loadWarn.push(`${r.dir}: ${(r.postErrRate * 100).toFixed(1)}% POST lỗi (server quá tải, run vẫn được giữ)`);
  }
  const res = all.filter((r) => r.valid);
  if (!res.length) { console.log(`${mech} n=${n}: KHÔNG có run hợp lệ`); continue; }
  const pooled = Float64Array.from(res.flatMap((r) => Array.from(r.pooled))).sort();
  const row = { mech, clients: +n, runs: res.length, obs: pooled.length,
    pooled_p50: pct(pooled, 50), pooled_p95: pct(pooled, 95), pooled_p99: pct(pooled, 99), pooled_p999: pct(pooled, 99.9) };
  for (const c of cols) {
    const v = res.map((r) => r.run[c]);
    const [lo, hi] = bootCI(v);
    row[c] = mean(v); row[c + '_lo'] = lo; row[c + '_hi'] = hi;
  }
  row.failed = res.reduce((a, r) => a + (r.run.failed || 0), 0);
  row.neg = res.reduce((a, r) => a + r.run.neg, 0);
  rows.push(row);
  runVals.set(k, res.map((r) => r.run));
  for (let q = 1; q <= 199; q++) ecdf.push(`${mech},${n},${(q / 200).toFixed(3)},${pct(pooled, (q / 200) * 100).toFixed(3)}`);
  console.log(`${mech} n=${n}: ${res.length} runs, obs=${pooled.length}`);
}

// ---- CSV ----
const head = ['mech', 'clients', 'runs', 'obs', 'pooled_p50', 'pooled_p95', 'pooled_p99', 'pooled_p999', 'failed', 'neg'];
for (const c of cols) head.push(c, c + '_lo', c + '_hi');
const fmt = (x) => (typeof x === 'number' && !Number.isInteger(x) ? x.toFixed(3) : x);
fs.writeFileSync(path.join(root, 'summary.csv'), [head.join(','), ...rows.map((r) => head.map((h) => fmt(r[h])).join(','))].join('\n'));
fs.writeFileSync(path.join(root, 'ecdf.csv'), ecdf.join('\n'));

// ---- Markdown ----
const f1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : '-');
const ci = (r, c, d = 1) => `${r[c].toFixed(d)} [${r[c + '_lo'].toFixed(d)}, ${r[c + '_hi'].toFixed(d)}]`;
let md = `# Kết quả ${id}\n\nCI = bootstrap 95% trên các run. Percentile "pooled" gộp mọi quan sát của mọi run.\n\n`;
md += '| mech | N | runs | delivery | dup | mean ms [CI] | P50 | P95 | P99 | P99.9 | CPU % core [CI] | RSSmax MB | ELD p99 ms | ELU | backlog B | loadgen ELD p99 |\n|' + '---|'.repeat(16) + '\n';
for (const r of rows) md += `| ${r.mech} | ${r.clients} | ${r.runs} | ${(r.delivery * 100).toFixed(2)}% | ${r.dup} | ${ci(r, 'mean')} | ${f1(r.pooled_p50)} | ${f1(r.pooled_p95)} | ${f1(r.pooled_p99)} | ${f1(r.pooled_p999)} | ${ci(r, 'cpuPct')} | ${f1(r.rssMax)} | ${f1(r.eldP99)} | ${r.eluMean.toFixed(2)} | ${Math.round(r.backlog)} | ${f1(r.loadEldP99)} |\n`;
md += '\n## Phân rã latency (ms, trung bình)\npipeline = DB+bus (tb−tc), delivery = kênh (tr−tb)\n\n| mech | N | pipeline | delivery |\n|---|---|---|---|\n';
for (const r of rows) md += `| ${r.mech} | ${r.clients} | ${f1(r.pipeMean)} | ${f1(r.delivMean)} |\n`;
md += '\n## SSE − WebSocket (chênh mean latency, CI 95%)\n\n| N | diff ms | CI | kết luận |\n|---|---|---|---|\n';
for (const [k, a] of runVals) {
  const [m, n] = k.split('|'); if (m !== 'sse') continue;
  const b = runVals.get(`ws|${n}`); if (!b) continue;
  const [lo, hi] = bootDiffCI(a.map((x) => x.mean), b.map((x) => x.mean));
  md += `| ${n} | ${f1(mean(a.map((x) => x.mean)) - mean(b.map((x) => x.mean)))} | [${f1(lo)}, ${f1(hi)}] | ${!Number.isFinite(lo) ? 'cần >= 2 run' : lo <= 0 && hi >= 0 ? 'không khác biệt rõ' : 'khác biệt có ý nghĩa'} |\n`;
}
md += '\n## Cảnh báo tự động\n';
for (const x of retried) md += `- CHẠY LẠI: ${x}\n`;
for (const x of loadWarn) md += `- QUÁ TẢI: ${x}\n`;
for (const x of invalids) md += `- RUN KHÔNG HỢP LỆ (đã loại khỏi thống kê): ${x}\n`;
// run bị thiếu so với kế hoạch (dễ gây survivorship bias nếu run lỗi do quá tải)
try {
  const plan = JSON.parse(fs.readFileSync(path.join(root, 'plan.json'), 'utf8'));
  const planned = new Map();
  for (const [m, n, rep] of plan.runs) { const k = `${m}|${n}`; (planned.get(k) || planned.set(k, []).get(k)).push(rep); }
  for (const [k, reps] of planned) {
    const have = (groups.get(k) || []).map((d) => +d.match(/-r(\d+)$/)[1]);
    const miss = reps.filter((r) => !have.includes(r));
    if (miss.length) md += `- THIẾU RUN ${k.replace('|', ' N=')}: có ${have.length}/${reps.length}, thiếu rep ${miss.join(',')} -> xem log terminal ("LỖI"); nếu lỗi do quá tải thì kết quả cấu hình này bị lệch (survivorship bias)\n`;
  }
} catch {}
for (const r of rows) {
  if (r.delivery < 0.999) md += `- ${r.mech} N=${r.clients}: delivery ${(r.delivery * 100).toFixed(2)}% < 99.9%\n`;
  if (r.dup > 0) md += `- ${r.mech} N=${r.clients}: ${r.dup} lần nhận trùng\n`;
  if (r.neg > 0) md += `- ${r.mech} N=${r.clients}: ${r.neg} latency âm (kiểm tra đồng hồ)\n`;
  if (r.loadEldP99 > 40) md += `- ${r.mech} N=${r.clients}: event-loop của loadgen p99=${f1(r.loadEldP99)}ms -> số đo phía client có thể bị méo, chia thêm worker/máy\n`;
  if (r.failed > 0) md += `- ${r.mech} N=${r.clients}: ${r.failed} kết nối lỗi\n`;
}
fs.writeFileSync(path.join(root, 'summary.md'), md);
console.log(`\nĐã ghi ${path.join(root, 'summary.md')}`);