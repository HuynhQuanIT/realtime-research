'use strict';
/**
 * bench2/llm-analyze.js <RUN_ID>   ->  results/<RUN_ID>/summary.md, summary.csv, ecdf-ttft.csv, ecdf-delay.csv
 *
 * Chỉ tính các phiên MỞ trong cửa sổ đo [tWinStart, tWinEnd). Định nghĩa:
 *  - TTFT          = lúc client nhận token đầu - lúc client gửi yêu cầu mở phiên (gồm prefill giả lập + truyền tải)
 *  - Độ trễ token  = lúc nhận - thời điểm token "đến hạn" theo lịch của mock LLM (ts). Event loop server nghẽn => token
 *                    gửi trễ và VẪN bị tính vào độ trễ (không giấu)
 *  - Khoảng cách token (gap) = chênh lệch thời điểm NHẬN giữa hai token liên tiếp
 *      stall = gap > 300 ms (người dùng thấy khựng); clump = gap < 5 ms (token dồn thành cụm)
 *  - Độ trễ huỷ    = lúc server THỰC SỰ xử lý lệnh huỷ - lúc người dùng bấm huỷ (cùng đồng hồ hrtime)
 *  - Token lãng phí = số token server đã sinh - số token client đã nhận tới lúc huỷ
 */
const fs = require('fs');
const path = require('path');

const id = process.argv[2];
if (!id) { console.error('Usage: node bench2/llm-analyze.js <RUN_ID>'); process.exit(1); }
const root = path.join(__dirname, 'results', id);
const STALL_MS = 300, CLUMP_MS = 5;

function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const R = rng(2468);
const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : NaN);
const mean = (a) => { let s = 0, n = 0; for (const x of a) { s += x; n++; } return n ? s / n : NaN; };
function bootCI(vals, B = 2000) {
  const v = vals.filter((x) => Number.isFinite(x));
  if (v.length < 2) return [NaN, NaN];
  const ms = [];
  for (let b = 0; b < B; b++) { let s = 0; for (let i = 0; i < v.length; i++) s += v[Math.floor(R() * v.length)]; ms.push(s / v.length); }
  ms.sort((x, y) => x - y);
  return [ms[Math.floor(0.025 * B)], ms[Math.floor(0.975 * B)]];
}

function analyzeRun(dir) {
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  const srv = new Map(JSON.parse(fs.readFileSync(path.join(dir, 'llm-sessions.json'), 'utf8')).map((r) => [r.sid, r]));
  const sess = new Map();
  for (const f of fs.readdirSync(dir).filter((x) => x.startsWith('events-'))) {
    const b = fs.readFileSync(path.join(dir, f));
    const a = new Float64Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));
    for (let i = 0; i + 4 < a.length; i += 5) {
      const sid = a[i + 1], idx = a[i + 2];
      let s = sess.get(sid);
      if (!s) { s = { req: NaN, cancel: NaN, done: NaN, idx: [], ts: [], tr: [] }; sess.set(sid, s); }
      if (idx >= 0) { s.idx.push(idx); s.ts.push(a[i + 3]); s.tr.push(a[i + 4]); }
      else if (idx === -1) s.req = a[i + 4];
      else if (idx === -2) s.cancel = a[i + 4];
      else if (idx === -3) s.done = a[i + 4];
    }
  }
  const ttft = [], delay = [], gaps = [], cancelLat = [], wasted = [];
  let nSess = 0, nDone = 0, nCancelled = 0, nIncomplete = 0, tokenLoss = 0, neg = 0, cancelUnprocessed = 0, tokensInWin = 0;
  for (const s of sess.values()) {
    if (!(s.req >= meta.tWinStart && s.req < meta.tWinEnd)) continue;
    nSess++;
    if (s.idx.length && s.idx[0] === 0) ttft.push(s.tr[0] - s.req);
    for (let k = 0; k < s.tr.length; k++) {
      const d = s.tr[k] - s.ts[k];
      if (d < 0) neg++;
      delay.push(d);
      if (k > 0) gaps.push(s.tr[k] - s.tr[k - 1]);
    }
    tokensInWin += s.tr.length;
    if (Number.isFinite(s.cancel)) {
      nCancelled++;
    } else if (Number.isFinite(s.done)) {
      nDone++;
      tokenLoss += meta.tokens - new Set(s.idx).size;
    } else nIncomplete++;
  }
  // huỷ: cần sid -> duyệt lại có sid
  for (const [sid, s] of sess) {
    if (!(s.req >= meta.tWinStart && s.req < meta.tWinEnd) || !Number.isFinite(s.cancel)) continue;
    const sv = srv.get(sid);
    if (!sv || sv.cancelProcessedAt == null) { cancelUnprocessed++; continue; }
    cancelLat.push(sv.cancelProcessedAt - s.cancel);
    wasted.push(Math.max(0, sv.sent - s.idx.length));
  }

  const st = fs.readFileSync(path.join(dir, 'stats.ndjson'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const inWin = st.filter((s) => s.t >= meta.tWinStart && s.t <= meta.tWinEnd);
  const s0 = inWin[0], s1 = inWin[inWin.length - 1];
  const dt = s0 && s1 ? s1.t - s0.t : NaN;
  const why = [];
  if (nSess < meta.n) why.push(`chỉ ${nSess} phiên trong cửa sổ đo (< ${meta.n} client)`);
  if (inWin.length < 3) why.push(`chỉ ${inWin.length} mẫu /stats trong cửa sổ đo`);

  const sd = (arr) => Float64Array.from(arr).sort();
  const tt = sd(ttft), dl = sd(delay), gp = sd(gaps), cl = sd(cancelLat);
  const mx = (f) => (inWin.length ? Math.max(...inWin.map(f)) : NaN);
  return {
    meta, valid: why.length === 0, why: why.join('; '), attempt: meta.attempt || 1,
    pooled: { tt, dl },
    run: {
      sessions: nSess, completionRate: nSess ? (nDone + nCancelled) / nSess : NaN, incomplete: nIncomplete, tokenLoss, neg,
      tokPerSec: tokensInWin / ((meta.tWinEnd - meta.tWinStart) / 1000),
      ttftMean: mean(tt), ttftP95: pct(tt, 95), ttftP99: pct(tt, 99),
      delayMean: mean(dl), delayP50: pct(dl, 50), delayP95: pct(dl, 95), delayP99: pct(dl, 99),
      gapP99: pct(gp, 99), stallRate: gp.length ? gp.filter((x) => x > STALL_MS).length / gp.length : NaN,
      clumpRate: gp.length ? gp.filter((x) => x < CLUMP_MS).length / gp.length : NaN,
      cancels: cancelLat.length, cancelUnprocessed, cancelMean: mean(cl), cancelP95: pct(cl, 95), wastedMean: mean(wasted),
      cpuPct: s1 ? (((s1.cpuUserUs - s0.cpuUserUs) + (s1.cpuSysUs - s0.cpuSysUs)) / 1000 / dt) * 100 : NaN,
      eluMean: mean(inWin.map((s) => s.elu)), eldP99: mx((s) => s.eldP99), rssMax: mx((s) => s.rssMB),
      failed: meta.failed || 0, sessionTimeouts: (meta.workers || []).reduce((a, w) => a + (w.sessionTimeouts || 0), 0),
    },
  };
}

const dirs = fs.readdirSync(root).filter((d) => fs.existsSync(path.join(root, d, 'meta.json'))).sort();
const groups = new Map();
for (const d of dirs) { const m = JSON.parse(fs.readFileSync(path.join(root, d, 'meta.json'), 'utf8')); const k = `${m.mech}|${m.n}`; (groups.get(k) || groups.set(k, []).get(k)).push(d); }

const cols = ['sessions', 'completionRate', 'tokPerSec', 'ttftMean', 'ttftP95', 'delayMean', 'delayP95', 'delayP99', 'gapP99', 'stallRate', 'clumpRate',
  'cancelMean', 'cancelP95', 'wastedMean', 'cpuPct', 'eluMean', 'eldP99', 'rssMax'];
const rows = [], invalids = [], retried = [], notes = [];
const ecdfT = ['mech,sessions,quantile,ttft_ms'], ecdfD = ['mech,sessions,quantile,delay_ms'];
const keys = [...groups.keys()].sort((a, b) => { const [ma, na] = a.split('|'); const [mb, nb] = b.split('|'); return ma === mb ? +na - +nb : ma.localeCompare(mb); });
for (const k of keys) {
  const [mech, n] = k.split('|');
  const all = groups.get(k).map((d) => ({ ...analyzeRun(path.join(root, d)), dir: d }));
  for (const r of all) {
    if (!r.valid) invalids.push(`${r.dir}: ${r.why}`);
    if (r.attempt > 1) retried.push(`${r.dir}: thành công ở lần chạy thứ ${r.attempt} (xem errors.log)`);
    if (r.run.incomplete / Math.max(1, r.run.sessions) > 0.01) notes.push(`${r.dir}: ${r.run.incomplete}/${r.run.sessions} phiên không kết thúc (quá tải hoặc lỗi)`);
    if (r.run.tokenLoss > 0) notes.push(`${r.dir}: mất ${r.run.tokenLoss} token trong các phiên hoàn tất`);
    if (r.run.neg > 0) notes.push(`${r.dir}: ${r.run.neg} độ trễ âm (kiểm tra đồng hồ)`);
    if (r.run.cancelUnprocessed > 0) notes.push(`${r.dir}: ${r.run.cancelUnprocessed} lệnh huỷ server không ghi nhận`);
    if (r.run.failed > 0) notes.push(`${r.dir}: ${r.run.failed} kết nối lỗi`);
  }
  const res = all.filter((r) => r.valid);
  if (!res.length) { console.log(`${mech} n=${n}: KHÔNG có run hợp lệ`); continue; }
  const row = { mech, n: +n, runs: res.length };
  for (const c of cols) {
    const v = res.map((r) => r.run[c]);
    const [lo, hi] = bootCI(v);
    row[c] = mean(v.filter(Number.isFinite)); row[c + '_lo'] = lo; row[c + '_hi'] = hi;
  }
  const tt = Float64Array.from(res.flatMap((r) => Array.from(r.pooled.tt))).sort();
  const dl = Float64Array.from(res.flatMap((r) => Array.from(r.pooled.dl))).sort();
  row.pooled_ttft_p50 = pct(tt, 50); row.pooled_ttft_p99 = pct(tt, 99); row.pooled_delay_p50 = pct(dl, 50); row.pooled_delay_p99 = pct(dl, 99);
  rows.push(row);
  for (let q = 1; q <= 199; q++) {
    ecdfT.push(`${mech},${n},${(q / 200).toFixed(3)},${pct(tt, q / 2).toFixed(3)}`);
    ecdfD.push(`${mech},${n},${(q / 200).toFixed(3)},${pct(dl, q / 2).toFixed(3)}`);
  }
  console.log(`${mech} n=${n}: ${res.length} runs, ${res.reduce((a, r) => a + r.run.sessions, 0)} phiên`);
}

const head = ['mech', 'n', 'runs', 'pooled_ttft_p50', 'pooled_ttft_p99', 'pooled_delay_p50', 'pooled_delay_p99'];
for (const c of cols) head.push(c, c + '_lo', c + '_hi');
const fmt = (x) => (typeof x === 'number' && !Number.isInteger(x) ? x.toFixed(3) : x);
fs.writeFileSync(path.join(root, 'summary.csv'), [head.join(','), ...rows.map((r) => head.map((h) => fmt(r[h])).join(','))].join('\n'));
fs.writeFileSync(path.join(root, 'ecdf-ttft.csv'), ecdfT.join('\n'));
fs.writeFileSync(path.join(root, 'ecdf-delay.csv'), ecdfD.join('\n'));

const f1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : '-');
const ci = (r, c, d = 1) => `${r[c].toFixed(d)} [${r[c + '_lo'].toFixed(d)}, ${r[c + '_hi'].toFixed(d)}]`;
let md = `# Kết quả LLM streaming ${id}\n\nMock LLM (không phải mô hình thật): kết quả đặc trưng cho tầng truyền tải. CI = bootstrap 95% giữa các run.\n\n`;
md += '## Trải nghiệm token\n\n| transport | N | runs | phiên | hoàn tất | TTFT mean ms [CI] | TTFT P95 | độ trễ token mean | P95 | P99 | gap P99 | stall % | cụm % |\n|' + '---|'.repeat(13) + '\n';
for (const r of rows) md += `| ${r.mech} | ${r.n} | ${r.runs} | ${Math.round(r.sessions)} | ${(r.completionRate * 100).toFixed(1)}% | ${ci(r, 'ttftMean')} | ${f1(r.ttftP95)} | ${f1(r.delayMean)} | ${f1(r.delayP95)} | ${f1(r.delayP99)} | ${f1(r.gapP99)} | ${(r.stallRate * 100).toFixed(1)} | ${(r.clumpRate * 100).toFixed(1)} |\n`;
md += '\n## Huỷ giữa chừng và tài nguyên server\n\n| transport | N | token/s | huỷ mean ms [CI] | huỷ P95 | token lãng phí | CPU % core [CI] | ELU | ELD p99 ms | RSS MB |\n|' + '---|'.repeat(10) + '\n';
for (const r of rows) md += `| ${r.mech} | ${r.n} | ${f1(r.tokPerSec)} | ${ci(r, 'cancelMean')} | ${f1(r.cancelP95)} | ${f1(r.wastedMean)} | ${ci(r, 'cpuPct')} | ${r.eluMean.toFixed(2)} | ${f1(r.eldP99)} | ${f1(r.rssMax)} |\n`;
md += '\n## Cảnh báo tự động\n';
try {
  const plan = JSON.parse(fs.readFileSync(path.join(root, 'plan.json'), 'utf8'));
  const planned = new Map();
  for (const [m, n, rep] of plan.runs) { const k = `${m}|${n}`; (planned.get(k) || planned.set(k, []).get(k)).push(rep); }
  for (const [k, reps] of planned) {
    const have = (groups.get(k) || []).map((d) => +d.match(/-r(\d+)$/)[1]);
    const miss = reps.filter((r) => !have.includes(r));
    if (miss.length) md += `- THIẾU RUN ${k.replace('|', ' N=')}: có ${have.length}/${reps.length}, thiếu rep ${miss.join(',')}\n`;
  }
} catch {}
for (const x of retried) md += `- CHẠY LẠI: ${x}\n`;
for (const x of invalids) md += `- RUN KHÔNG HỢP LỆ (đã loại): ${x}\n`;
for (const x of notes) md += `- ${x}\n`;
fs.writeFileSync(path.join(root, 'summary.md'), md);
console.log(`\nĐã ghi ${path.join(root, 'summary.md')}`);
