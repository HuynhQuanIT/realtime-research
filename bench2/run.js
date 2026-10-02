'use strict';
/**
 * bench2/run.js - chạy cả ma trận thí nghiệm một cách có kiểm soát.
 *
 * Mỗi run:  server MỚI (fresh process) -> TRUNCATE -> workers kết nối -> warm-up
 *           -> đo -> DRAIN (chờ message còn trễ) -> lưu log -> kill server.
 * Thứ tự các run được SHUFFLE theo --seed (lưu lại trong meta để tái lập).
 *
 * Ví dụ:
 *   node bench2/run.js --mechs poll,sse,ws,push --levels 10,100,1000 --reps 10 \
 *        --duration 120 --warmup 10 --rate 10 --seed 1
 *   Nhanh để thử: --levels 10,50 --reps 2 --duration 8 --warmup 2
 *
 * Linux: đặt TASKSET_SERVER=0-3 TASKSET_LOAD=4-11 để ghim CPU server / loadgen tách nhau.
 * Postgres nên chạy ngoài (docker compose up -d) và cũng nên được ghim riêng.
 */
const { spawn, spawnSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { performance } = require('perf_hooks');

// ---- tham số ----
const args = Object.fromEntries(process.argv.slice(2).reduce((a, x, i, arr) => {
  if (x.startsWith('--')) a.push([x.slice(2), arr[i + 1]]); return a;
}, []));
const MECHS = (args.mechs || 'poll,sse,ws,push').split(',');
const LEVELS = (args.levels || '10,100,1000').split(',').map(Number);
const REPS = +(args.reps || 5);
const DURATION = +(args.duration || 60);
const WARMUP = +(args.warmup || 10);
const RATE = +(args.rate || 1);            // msg/giây
const BURST = +(args.burst || 1);          // số message mỗi tick (burst); tick/giây = RATE/BURST
const PAYLOAD = +(args.payload || 0);      // byte đệm thêm vào content (< ~7000 do giới hạn NOTIFY 8KB)
const POLL_MS = +(args.poll || 2000);
const PER_PROC = +(args.perproc || 250);   // client / worker process
const SEED = +(args.seed || 1);
const PORT = +(args.port || 3100);
const DB = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5433/notifybench';
const RETRIES = +(args.retries === undefined ? 2 : args.retries); // chạy lại run bị lỗi hạ tầng (mỗi lần đều ghi errors.log)
const READY_TIMEOUT_MS = +(args.readytimeout || 90) * 1000;
const COOLDOWN_MS = +(args.cooldown || 4) * 1000; // nghỉ giữa các run để hệ điều hành nhả socket/cổng
const DRAIN_MS = Math.max(3000, 2 * POLL_MS + 1000);
const RUN_ID = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
const OUT = path.join(__dirname, 'results', RUN_ID);
const now = () => Number(process.hrtime.bigint()) / 1e6; // ms; hrtime cùng gốc cho MỌI tiến trình trên cùng máy (không lệch như timeOrigin)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function rng(seed) { // mulberry32
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function shuffle(arr, r) { for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; }

function launch(cmd, argv, opts, cpus) {
  if (cpus && process.platform === 'linux') { argv = ['-c', cpus, cmd, ...argv]; cmd = 'taskset'; }
  return spawn(cmd, argv, opts);
}
let httpAgent = new http.Agent({ keepAlive: true, maxSockets: 64 });
// Có timeout: tránh treo vĩnh viễn khi socket keep-alive cũ trỏ tới server đã chết (hay gặp trên Windows)
function req(method, p, body, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method, agent: httpAgent,
      headers: { 'Content-Type': 'application/json' } }, (res) => {
      let s = ''; res.on('data', (c) => (s += c)); res.on('end', () => { try { resolve(JSON.parse(s)); } catch { resolve(null); } });
    });
    r.setTimeout(timeoutMs, () => r.destroy(new Error(`timeout ${method} ${p}`)));
    r.on('error', reject);
    r.end(body ? JSON.stringify(body) : undefined);
  });
}

function killTree(p) {
  if (!p || !p.pid) return;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(p.pid), '/T', '/F'], { stdio: 'ignore' });
    else p.kill('SIGKILL');
  } catch {}
}
const live = { server: null, workers: [], sampler: null, dir: null, stage: '', fds: [] };
function logFailure(order, mech, n, rep, attempt, err) {
  const line = `[${new Date().toISOString()}] run ${order} ${mech} n=${n} r${rep} lần ${attempt} | bước cuối: ${live.stage} | ${err && err.stack ? err.stack : err}\n`;
  try { fs.appendFileSync(path.join(OUT, 'errors.log'), line); } catch {}
  try { if (live.dir) fs.writeFileSync(path.join(live.dir, 'error.txt'), line); } catch {}
}
function cleanupLive() {
  clearInterval(live.sampler);
  for (const p of live.workers) killTree(p);
  killTree(live.server);
  live.server = null; live.workers = []; live.sampler = null;
  for (const fd of live.fds) try { fs.closeSync(fd); } catch {}
  live.fds = [];
}

async function waitHealth(server) {
  for (let i = 0; i < 150; i++) {
    if (server.exitCode !== null) throw new Error(`server thoát sớm (code ${server.exitCode}); thường do cổng ${PORT} đang bị chiếm hoặc DB lỗi`);
    let h = null;
    try { h = await req('GET', '/health', null, 1500); } catch {}
    if (h && h.ok) {
      if (h.pid && server.pid && h.pid !== server.pid) throw new Error(`cổng ${PORT} đang bị tiến trình cũ pid=${h.pid} chiếm (server mới pid=${server.pid}) -> tắt hết node rồi chạy lại`);
      return;
    }
    await sleep(100);
  }
  throw new Error('server không lên sau 15s');
}

async function oneRun(order, mech, n, rep, attempt = 1) {
  const dir = path.join(OUT, `${String(order).padStart(3, '0')}-${mech}-${n}-r${rep}`);
  fs.rmSync(dir, { recursive: true, force: true }); // lần chạy lại bắt đầu từ thư mục sạch
  fs.mkdirSync(dir, { recursive: true });
  live.dir = dir; live.stage = 'khởi động server'; live.fds = [];
  const openLog = (name) => { const fd = fs.openSync(path.join(dir, name), 'w'); live.fds.push(fd); return fd; };
  const meta = { order, mech, n, rep, rate: RATE, burst: BURST, payload: PAYLOAD, duration: DURATION, warmup: WARMUP,
    drainMs: DRAIN_MS, pollMs: POLL_MS, seed: SEED, attempt };

  const sfd = openLog('server.log'); // stdout+stderr của server để điều tra khi có sự cố
  const server = launch(process.execPath, [path.join(__dirname, 'server.js')],
    { env: { ...process.env, PORT: String(PORT), DATABASE_URL: DB }, stdio: ['ignore', sfd, sfd] },
    process.env.TASKSET_SERVER);
  const workers = [];
  let stopping = false, fatal = null; // fatal: tiến trình chết/sập GIỮA run
  const setFatal = (e) => { if (!fatal) fatal = e; };
  server.on('exit', (code) => { if (!stopping) setFatal(new Error(`server thoát giữa run (code ${code})`)); });
  let sampler;
  httpAgent.destroy(); httpAgent = new http.Agent({ keepAlive: true, maxSockets: 64 }); // socket mới cho server mới
  live.server = server; live.workers = workers;
  console.log(`[${order}] bắt đầu ${mech} n=${n} r${rep}`);
  try {
    await waitHealth(server);
    live.stage = 'reset DB';
    console.log(`[${order}]  server sẵn sàng`);
    await req('POST', '/reset');
    live.stage = 'kết nối client (chờ worker ready)';
    console.log(`[${order}]  đã reset DB, đang kết nối ${n} client...`);

    // workers
    const K = Math.ceil(n / PER_PROC);
    const doneMsgs = [];
    await Promise.all(Array.from({ length: K }, (_, w) => new Promise((resolve, reject) => {
      const cnt = Math.min(PER_PROC, n - w * PER_PROC);
      const cfg = { mech, base: `http://127.0.0.1:${PORT}`, n: cnt, id0: w * PER_PROC, pollMs: POLL_MS,
        out: path.join(dir, `events-${w}.bin`) };
      const wfd = openLog(`worker-${w}.log`);
      const p = launch(process.execPath, [path.join(__dirname, 'client.js')],
        { env: { ...process.env, CFG: JSON.stringify(cfg) }, stdio: ['ignore', wfd, wfd, 'ipc'] },
        process.env.TASKSET_LOAD);
      let ready = false;
      const t = setTimeout(() => reject(new Error(`worker ${w} chưa sẵn sàng sau ${READY_TIMEOUT_MS / 1000}s`)), READY_TIMEOUT_MS);
      p.on('message', (m) => {
        if (m.type === 'ready') {
          ready = true; clearTimeout(t); resolve();
          if (m.failed) console.log(`[${order}]  worker ${w}: connected=${m.connected} failed=${m.failed} (timeout=${m.timedOut}) ${m.firstErrors.join(' | ')}`);
        }
        if (m.type === 'crash') { clearTimeout(t); const e = new Error(`worker ${w} sập: ${m.message}`); if (!ready) reject(e); setFatal(e); }
        if (m.type === 'done') doneMsgs.push(m);
      });
      p.on('exit', (code) => {
        if (!ready) { clearTimeout(t); reject(new Error(`worker ${w} thoát sớm (code ${code}) trước khi sẵn sàng`)); }
        else if (!stopping) setFatal(new Error(`worker ${w} thoát giữa run (code ${code})`));
      });
      p.on('error', (e) => { clearTimeout(t); reject(e); });
      workers.push(p);
    })));

    live.stage = 'đang phát tin';
    console.log(`[${order}]  client sẵn sàng, bắt đầu phát tin`);
    // sampler /stats mỗi 1s
    const statsFd = fs.openSync(path.join(dir, 'stats.ndjson'), 'w');
    sampler = setInterval(async () => {
      try { const s = await req('GET', '/stats', null, 3000); fs.writeSync(statsFd, JSON.stringify(s) + '\n'); } catch {}
    }, 1000);
    live.sampler = sampler;

    // generator OPEN-LOOP: lịch tuyệt đối, không đợi response (tránh coordinated omission)
    const genFd = fs.openSync(path.join(dir, 'gen.ndjson'), 'w');
    const t0 = now();
    meta.tStart = t0; meta.tWinStart = t0 + WARMUP * 1000; meta.tWinEnd = t0 + (WARMUP + DURATION) * 1000;
    const tickMs = 1000 / (RATE / BURST);
    const content = 'm'.repeat(Math.max(1, PAYLOAD));
    let sent = 0, errs = 0;
    const inflight = new Set();
    for (let k = 0; now() < meta.tWinEnd; k++) {
      if (fatal) throw fatal;
      const target = t0 + k * tickMs;
      const wait = target - now();
      if (wait > 0) await sleep(wait);
      for (let b = 0; b < BURST; b++) {
        sent++;
        const pr = req('POST', '/messages', { content }).then((r) => {
          if (r && r.id) fs.writeSync(genFd, JSON.stringify({ id: r.id, tc: r.tc }) + '\n'); else errs++;
        }).catch(() => errs++).finally(() => inflight.delete(pr));
        inflight.add(pr);
      }
    }
    await Promise.all(inflight);
    if (fatal) throw fatal;
    meta.sent = sent; meta.genErrors = errs;

    console.log(`[${order}]  phát xong, chờ drain ${DRAIN_MS}ms`);
    live.stage = 'drain';
    await sleep(DRAIN_MS); // DRAIN: cho poll/push nhận nốt message
    if (fatal) throw fatal;
    meta.tEnd = now();
    clearInterval(sampler);
    live.stage = 'lấy stats cuối / dừng worker';
    try { fs.writeSync(statsFd, JSON.stringify(await req('GET', '/stats', null, 15000)) + '\n'); }
    catch (e) { meta.finalStatsError = e.message; } // không làm hỏng cả run

    stopping = true;
    for (const p of workers) p.send('stop');
    for (let i = 0; i < 100 && doneMsgs.length < K; i++) await sleep(100);
    meta.workers = doneMsgs;
    meta.connected = doneMsgs.reduce((a, m) => a + m.connected, 0);
    meta.failed = doneMsgs.reduce((a, m) => a + m.failed, 0);
    // Kiểm tra hợp lệ (lỗi HẠ TẦNG => ném lỗi để chạy lại). POST lỗi do quá tải thì KHÔNG ném: giữ run làm dữ liệu.
    if (doneMsgs.length < K) throw new Error(`chỉ ${doneMsgs.length}/${K} worker trả báo cáo cuối (worker chết hoặc treo)`);
    const planned = Math.round(RATE * (WARMUP + DURATION));
    if (sent < 0.95 * planned) throw new Error(`generator chỉ gửi ${sent}/${planned} tin (tiến trình bị đứng? terminal bị tạm dừng? máy ngủ?)`);
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
    console.log(`[${order}] ${mech} n=${n} r${rep}: sent=${sent} connected=${meta.connected} failed=${meta.failed} genErr=${errs}`);
  } finally {
    stopping = true;
    cleanupLive();
    await sleep(COOLDOWN_MS);
  }
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const runs = [];
  for (const m of MECHS) for (const n of LEVELS) for (let r = 1; r <= REPS; r++) runs.push([m, n, r]);
  shuffle(runs, rng(SEED));
  fs.writeFileSync(path.join(OUT, 'plan.json'), JSON.stringify({
    seed: SEED, runs, args, host: { cpu: os.cpus()[0].model, cores: os.cpus().length, mem: os.totalmem(), node: process.version,
      platform: process.platform, taskset: { server: process.env.TASKSET_SERVER, load: process.env.TASKSET_LOAD } } }, null, 2));
  const est = runs.length * (WARMUP + DURATION + DRAIN_MS / 1000 + 6) / 60;
  console.log(`Kết quả -> ${OUT}\n${runs.length} runs, ước tính ~${est.toFixed(0)} phút`);
  const limit = (WARMUP + DURATION) * 1000 + DRAIN_MS + 90000; // watchdog mỗi lần chạy
  for (let i = 0; i < runs.length; i++) {
    for (let attempt = 1; attempt <= RETRIES + 1; attempt++) {
      let timer, ok = false;
      const guard = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('quá thời gian (watchdog)')), limit); });
      await Promise.race([oneRun(i + 1, ...runs[i], attempt), guard])
        .then(() => { ok = true; })
        .catch((e) => {
          console.error(`[${i + 1}] LỖI lần ${attempt}/${RETRIES + 1} (${live.stage}): ${e.message}`);
          logFailure(i + 1, ...runs[i], attempt, e);
          cleanupLive();
        })
        .finally(() => clearTimeout(timer));
      if (ok) break;
      if (attempt === RETRIES + 1) console.error(`[${i + 1}] bỏ run này sau ${attempt} lần thất bại, chạy tiếp`);
      else { console.error(`[${i + 1}] chạy lại...`); await sleep(COOLDOWN_MS); }
    }
  }
  console.log(`Xong. Phân tích: node bench2/analyze.js ${RUN_ID}`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
